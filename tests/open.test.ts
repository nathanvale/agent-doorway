import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  ParsedPath,
  ProgramResult,
  ProgramsCapability,
  RunAddon,
} from "agent-cli-kernel";
import { contractFor, runInProcess } from "agent-cli-kernel";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
import { causes, cli } from "../src/causes.ts";
import { createDoorway } from "../src/commands.ts";
import { editorArguments, remoteAuthority } from "../src/editor.ts";
import { openCommand } from "../src/open.ts";
import { pendingCommand } from "../src/pending.ts";
import type { DoorwayState } from "../src/pending.ts";
import {
  destinationState,
  inventoryCommand,
  parseInventory,
  sshArguments,
} from "../src/remote.ts";
import type {
  DestinationSettings,
  DoorwaySettings,
  RemoteHostSettings,
} from "../src/settings.ts";
import { journalFaultPreload } from "./support/journal-faults.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const cliEntry = join(import.meta.dir, "../src/cli.ts");
const sampleContainerId =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const otherContainerId =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const sampleHost: RemoteHostSettings = {
  name: "lab",
  label: "Lab machine",
  sshAlias: "lab-ssh",
  dockerEndpoint: "unix:///run/docker.sock",
  dockerPath: "/bin/docker",
};

const sampleDestination: DestinationSettings = {
  name: "example",
  label: "Example container",
  remoteHost: "lab",
  container: "example-box",
  containerId: sampleContainerId,
  folder: "/workspace",
  guide: "/workspace/GUIDE.md",
  wholeWorkspaceFile: "/workspace/example.code-workspace",
  placeFolders: ["/workspace", "/repos"],
};

function makeScript(pathValue: string, lines: readonly string[]): string {
  writeFileSync(pathValue, [`#!${process.execPath}`, ...lines, ""].join("\n"));
  chmodSync(pathValue, 0o755);
  return pathValue;
}

function waitForFile(
  filePath: string,
  timeoutMilliseconds = 10_000,
  signal?: AbortSignal,
): Promise<boolean> {
  if (existsSync(filePath)) return Promise.resolve(true);
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearInterval(interval);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      resolve(false);
    };
    const interval = setInterval(() => {
      if (existsSync(filePath)) {
        finish();
        resolve(true);
      }
    }, 20);
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`Timed out waiting for ${filePath}.`));
    }, timeoutMilliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitWithinBound(
  pending: Promise<unknown>,
  boundMilliseconds: number,
  timeoutError: Error,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timeoutError);
    }, boundMilliseconds);
    void pending.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function captureDomainTimeout(
  start: () => Promise<ProgramResult>,
  expectedDelayMilliseconds: number,
): {
  readonly pending: Promise<ProgramResult>;
  readonly fireTimeout: (() => void) | undefined;
} {
  const realSetTimeout = globalThis.setTimeout;
  let fireTimeout: (() => void) | undefined;
  const interceptedSetTimeout = (
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ): ReturnType<typeof realSetTimeout> => {
    if (
      fireTimeout === undefined &&
      typeof callback === "function" &&
      delay === expectedDelayMilliseconds
    ) {
      fireTimeout = () => {
        Reflect.apply(callback, undefined, rest);
      };
      const placeholder = realSetTimeout(() => undefined, 0);
      clearTimeout(placeholder);
      return placeholder;
    }
    return realSetTimeout(callback, delay, ...rest);
  };
  Reflect.set(
    interceptedSetTimeout,
    "__promisify__",
    realSetTimeout.__promisify__,
  );
  Reflect.set(globalThis, "setTimeout", interceptedSetTimeout);
  try {
    return { pending: start(), fireTimeout };
  } finally {
    Reflect.set(globalThis, "setTimeout", realSetTimeout);
  }
}

type ReadyGatedProgramOptions = {
  readonly pending: Promise<ProgramResult>;
  readonly fireTimeout: () => void;
  readonly killOwned: () => void;
  readonly readyFile: string;
  readonly readyTimeoutMilliseconds: number;
  readonly readinessCleanupMilliseconds: number;
  readonly onReadinessFailure: (error: Error) => void;
};

function runReadyGatedProgram(
  options: ReadyGatedProgramOptions,
): Promise<ProgramResult> {
  let settled = false;
  const abortReadyWait = new AbortController();
  const trackedPending = options.pending.finally(() => {
    settled = true;
    abortReadyWait.abort();
  });
  void trackedPending.catch(() => undefined);

  return waitForFile(
    options.readyFile,
    options.readyTimeoutMilliseconds,
    abortReadyWait.signal,
  ).then(
    (becameReady) => {
      if (becameReady && !settled) options.fireTimeout();
      return trackedPending;
    },
    async (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      const failure = new Error(
        `Editor never became ready before ${String(options.readyTimeoutMilliseconds)} ms; stopped child process group without firing the domain timeout (${detail})`,
      );
      options.onReadinessFailure(failure);
      if (!settled) options.killOwned();
      await waitWithinBound(
        trackedPending,
        options.readinessCleanupMilliseconds,
        failure,
      );
      throw failure;
    },
  );
}

type ReadyTimeoutGate = {
  readonly addon: RunAddon<ProgramsCapability>;
  readonly domainTimeoutFired: () => boolean;
  readonly throwIfNotReady: () => void;
};

function gateDomainTimeoutOnReadyFile(
  base: RunAddon<ProgramsCapability>,
  readyFile: string,
  readyTimeoutMilliseconds: number,
  readinessCleanupMilliseconds: number,
): ReadyTimeoutGate {
  let domainTimeoutFired = false;
  let readinessError: Error | undefined;

  const addon: RunAddon<ProgramsCapability> = {
    attach(run) {
      const attached = base.attach(run);
      return {
        ...attached,
        capability: {
          ...attached.capability,
          domain(effect) {
            const real = attached.capability.domain(effect);
            return {
              effect: real.effect,
              start(request) {
                const { pending, fireTimeout } = captureDomainTimeout(
                  () => real.start(request),
                  request.timeoutMilliseconds,
                );
                if (fireTimeout === undefined) {
                  return pending.then(() => {
                    throw new Error(
                      "Expected programs addon to arm the domain timeout synchronously.",
                    );
                  });
                }
                return runReadyGatedProgram({
                  pending,
                  fireTimeout: () => {
                    domainTimeoutFired = true;
                    fireTimeout();
                  },
                  killOwned: () => {
                    attached.killNow();
                  },
                  readyFile,
                  readyTimeoutMilliseconds,
                  readinessCleanupMilliseconds,
                  onReadinessFailure: (error) => {
                    readinessError = error;
                  },
                });
              },
            };
          },
        },
      };
    },
  };

  return {
    addon,
    domainTimeoutFired: () => domainTimeoutFired,
    throwIfNotReady: () => {
      if (readinessError !== undefined) throw readinessError;
    },
  };
}

type FixtureOptions = {
  readonly sshLines?: readonly string[];
  readonly editorLines?: readonly string[];
  readonly createEditorFolders?: boolean;
  readonly destination?: Partial<DestinationSettings>;
  readonly destinations?: readonly DestinationSettings[];
  readonly tools?: { readonly editor?: string; readonly ssh?: string };
};

function createFixture(options: FixtureOptions = {}) {
  const root = testFolder("doorway-open-");
  const userDataFolder = join(root, "editor-data");
  const extensionsFolder = join(root, "editor-extensions");
  if (options.createEditorFolders !== false) {
    mkdirSync(userDataFolder, { recursive: true });
    mkdirSync(extensionsFolder, { recursive: true });
  }
  const sshLog = join(root, "ssh.json");
  const editorLog = join(root, "editor.json");
  const fakeSsh = makeScript(
    join(root, "fake-ssh"),
    options.sshLines ?? [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(sshLog)}, JSON.stringify({`,
      "  argv: process.argv.slice(2),",
      "  hasVscodeIpc: Object.hasOwn(process.env, 'VSCODE_IPC_HOOK_CLI'),",
      "  sshAuthSockLength: Object.hasOwn(process.env, 'SSH_AUTH_SOCK') ? (process.env.SSH_AUTH_SOCK ?? '').length : -1,",
      "}));",
      `process.stdout.write(${JSON.stringify(`${sampleContainerId} example-box running\n`)});`,
    ],
  );
  const fakeEditor = makeScript(
    join(root, "fake-editor"),
    options.editorLines ?? [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(editorLog)}, JSON.stringify({`,
      "  argv: process.argv.slice(2),",
      "  hasVscodeIpc: Object.hasOwn(process.env, 'VSCODE_IPC_HOOK_CLI'),",
      "  sshAuthSockLength: Object.hasOwn(process.env, 'SSH_AUTH_SOCK') ? (process.env.SSH_AUTH_SOCK ?? '').length : -1,",
      "}));",
    ],
  );
  const settingsFile = join(root, "settings.json");
  const stateFolder = join(root, "state");
  const settings: DoorwaySettings = {
    version: 1,
    editor: { userDataFolder, extensionsFolder },
    remoteHosts: [sampleHost],
    destinations: options.destinations ?? [
      { ...sampleDestination, ...options.destination },
    ],
    tools: {
      editor: options.tools?.editor ?? fakeEditor,
      ssh: options.tools?.ssh ?? fakeSsh,
    },
  };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  const environment: Record<string, string> = {
    HOME: root,
    PATH: process.env.PATH ?? "",
    DOORWAY_SETTINGS: settingsFile,
    DOORWAY_STATE: stateFolder,
    VSCODE_IPC_HOOK_CLI: "dummy-ipc-hook",
    SSH_AUTH_SOCK: "dummy-auth-sock",
  };
  return {
    root,
    userDataFolder,
    extensionsFolder,
    sshLog,
    editorLog,
    fakeSsh,
    fakeEditor,
    settingsFile,
    stateFolder,
    environment,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const cliSpawnTimeoutMilliseconds = 20_000;

function spawnCli(
  runtimeArgs: readonly string[],
  environment: Record<string, string>,
  argv: readonly string[],
) {
  const ran = Bun.spawnSync(
    [process.execPath, ...runtimeArgs, cliEntry, ...argv],
    {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
      timeout: cliSpawnTimeoutMilliseconds,
    },
  );
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
}

function invokeCli(
  environment: Record<string, string>,
  ...argv: readonly string[]
) {
  return spawnCli(["run"], environment, argv);
}

function invokeCliWithJournalFaults(
  fixture: ReturnType<typeof createFixture>,
  faults: string,
  ...argv: readonly string[]
) {
  const preload = join(fixture.root, "journal-faults.ts");
  writeFileSync(preload, [...journalFaultPreload, ""].join("\n"));
  return spawnCli(
    ["run", "--preload", preload],
    { ...fixture.environment, DOORWAY_TEST_JOURNAL_FAULTS: faults },
    argv,
  );
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function ownProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function readUnfinishedOperationIds(
  environment: Record<string, string>,
): readonly string[] {
  const pending = invokeCli(environment, "pending", "--json");
  expect(pending.exitCode).toBe(0);
  expect(pending.stderr).toBe("");
  const parsed = parseJson(pending.stdout);
  const result = ownProperty(parsed, "result");
  const data = ownProperty(result, "data");
  const unfinished = ownProperty(data, "unfinished");
  if (!Array.isArray(unfinished))
    throw new Error("Expected pending unfinished array.");
  return unfinished.map((entry: unknown) => {
    const operationId = ownProperty(entry, "operationId");
    if (typeof operationId !== "string")
      throw new Error("Expected unfinished operationId string.");
    return operationId;
  });
}

function installWaitingEditor(
  editorPath: string,
  readyFile: string,
  releaseFile: string,
): void {
  rmSync(readyFile, { force: true });
  rmSync(releaseFile, { force: true });
  makeScript(editorPath, [
    'import { existsSync, writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
    `if (!existsSync(${JSON.stringify(releaseFile)})) {`,
    "  await new Promise((resolve, reject) => {",
    "    const interval = setInterval(() => {",
    `      if (existsSync(${JSON.stringify(releaseFile)})) {`,
    "        clearInterval(interval);",
    "        clearTimeout(timer);",
    "        resolve(undefined);",
    "      }",
    "    }, 20);",
    "    const timer = setTimeout(() => {",
    "      clearInterval(interval);",
    '      reject(new Error("Timed out waiting for release file."));',
    "    }, 15_000);",
    "  });",
    "}",
  ]);
}

function installLoggingEditor(editorPath: string, editorLog: string): void {
  rmSync(editorLog, { force: true });
  makeScript(editorPath, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(editorLog)}, JSON.stringify({ argv: process.argv.slice(2) }));`,
  ]);
}

async function runKilledOpen(
  fixture: ReturnType<typeof createFixture>,
  destinationName = "example",
): Promise<string> {
  const readyFile = join(fixture.root, "editor-ready");
  const releaseFile = join(fixture.root, "editor-release");
  installWaitingEditor(fixture.fakeEditor, readyFile, releaseFile);
  const beforeIds = new Set(readUnfinishedOperationIds(fixture.environment));
  const killed = Bun.spawn(
    [process.execPath, "run", cliEntry, "open", destinationName, "--json"],
    {
      env: fixture.environment,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    },
  );
  await waitForFile(readyFile);
  const editorPid = Number(readFileSync(readyFile, "utf8").trim());
  killed.kill("SIGKILL");
  await killed.exited;
  if (Number.isInteger(editorPid) && editorPid > 0) {
    try {
      process.kill(editorPid, "SIGKILL");
    } catch {
      void 0;
    }
  }
  const afterIds = readUnfinishedOperationIds(fixture.environment);
  const added = afterIds.filter((id) => !beforeIds.has(id));
  expect(added).toHaveLength(1);
  const createdId = added[0];
  if (createdId === undefined)
    throw new Error("Expected a killed open operationId.");
  return createdId;
}

function firstFramedRecord(eventsBytes: Buffer): Buffer {
  const headerEnd = eventsBytes.indexOf(10);
  if (headerEnd === -1)
    throw new Error("Expected a framed record header in events.");
  const bodyEnd = eventsBytes.indexOf(10, headerEnd + 1);
  if (bodyEnd === -1)
    throw new Error("Expected a framed record body in events.");
  return eventsBytes.subarray(0, bodyEnd + 1);
}

describe("editor arguments", () => {
  test("uses isolated folders, a new window, the destination folder and optional guide when no place is given", () => {
    const settings: DoorwaySettings = {
      version: 1,
      editor: {
        userDataFolder: "~/editor/data",
        extensionsFolder: "~/editor/extensions",
      },
      remoteHosts: [sampleHost],
      destinations: [sampleDestination],
    };
    const plan = editorArguments(
      settings,
      sampleHost,
      sampleDestination,
      "/work-home",
    );
    const authority = remoteAuthority(sampleHost, sampleDestination);
    expect(plan).toEqual({
      place: "/workspace",
      requiredFolders: [
        "/work-home/editor/data",
        "/work-home/editor/extensions",
      ],
      args: [
        "--user-data-dir",
        "/work-home/editor/data",
        "--extensions-dir",
        "/work-home/editor/extensions",
        "--new-window",
        "--folder-uri",
        `vscode-remote://${authority}/workspace`,
        "--file-uri",
        `vscode-remote://${authority}/workspace/GUIDE.md`,
      ],
    });
  });

  test("opens an explicit folder place without the guide and opens a .code-workspace place with --file-uri", () => {
    const settings: DoorwaySettings = {
      version: 1,
      editor: {
        userDataFolder: "/data",
        extensionsFolder: "/extensions",
      },
      remoteHosts: [sampleHost],
      destinations: [sampleDestination],
    };
    const authority = remoteAuthority(sampleHost, sampleDestination);
    expect(
      editorArguments(
        settings,
        sampleHost,
        sampleDestination,
        "/work-home",
        "/repos/app",
      ).args,
    ).toEqual([
      "--user-data-dir",
      "/data",
      "--extensions-dir",
      "/extensions",
      "--new-window",
      "--folder-uri",
      `vscode-remote://${authority}/repos/app`,
    ]);
    expect(
      editorArguments(
        settings,
        sampleHost,
        sampleDestination,
        "/work-home",
        "/workspace/example.code-workspace",
      ).args,
    ).toEqual([
      "--user-data-dir",
      "/data",
      "--extensions-dir",
      "/extensions",
      "--new-window",
      "--file-uri",
      `vscode-remote://${authority}/workspace/example.code-workspace`,
    ]);
  });

  test("addresses the pinned 64-character container ID rather than the container name and separates different pinned IDs", () => {
    const settings: DoorwaySettings = {
      version: 1,
      editor: {
        userDataFolder: "/data",
        extensionsFolder: "/extensions",
      },
      remoteHosts: [sampleHost],
      destinations: [sampleDestination],
    };
    const authority = remoteAuthority(sampleHost, sampleDestination);
    const prefix = "attached-container%2B";
    const suffix = `@ssh-remote%2B${sampleHost.sshAlias}`;
    expect(authority.startsWith(prefix)).toBe(true);
    expect(authority.endsWith(suffix)).toBe(true);
    const encodedPayload = authority.slice(prefix.length, -suffix.length);
    const decodedPayload: unknown = JSON.parse(
      Buffer.from(encodedPayload, "hex").toString("utf8"),
    );
    expect(decodedPayload).toEqual({
      containerName: sampleContainerId,
      settings: { host: sampleHost.dockerEndpoint },
    });

    const otherDestination: DestinationSettings = {
      ...sampleDestination,
      containerId: otherContainerId,
    };
    const otherAuthority = remoteAuthority(sampleHost, otherDestination);
    expect(otherAuthority).not.toBe(authority);
    expect(
      editorArguments(settings, sampleHost, otherDestination, "/work-home")
        .args,
    ).not.toEqual(
      editorArguments(settings, sampleHost, sampleDestination, "/work-home")
        .args,
    );
  });
});

describe("remote inventory and ssh arguments", () => {
  test("builds read-only ssh arguments that disable host-key updates and shared links", () => {
    const commandText = inventoryCommand(sampleHost);
    expect(commandText).toBe(
      "'/bin/docker' '--host' 'unix:///run/docker.sock' 'ps' '--all' '--no-trunc' '--format' '{{.ID}} {{.Names}} {{.State}}'",
    );
    expect(sshArguments(sampleHost, commandText)).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      "--",
      "lab-ssh",
      commandText,
    ]);
  });

  test("parses valid container rows, drops unsafe rows and reports destination states", () => {
    const parsed = parseInventory(
      [
        `${sampleContainerId} example-box running`,
        "bad-id unsafe running",
        `${otherContainerId} devbox exited`,
        `${otherContainerId} bad;name running`,
      ].join("\n"),
    );
    expect(parsed.rejected).toBe(2);
    expect(parsed.containers).toHaveLength(2);
    expect(destinationState(sampleDestination, parsed.containers)).toBe(
      "running",
    );
    expect(
      destinationState(
        { ...sampleDestination, containerId: otherContainerId },
        parsed.containers,
      ),
    ).toBe("replaced");
    expect(
      destinationState(
        {
          ...sampleDestination,
          container: "devbox",
          containerId: otherContainerId,
        },
        parsed.containers,
      ),
    ).toBe("stopped");
    expect(
      destinationState(
        {
          ...sampleDestination,
          container: "renamed-box",
          containerId: sampleContainerId,
        },
        parsed.containers,
      ),
    ).toBe("replaced");
    expect(
      destinationState(
        {
          ...sampleDestination,
          container: "absent",
          containerId:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        parsed.containers,
      ),
    ).toBe("missing");
  });
});

describe("doorway open and doorway pending through the real CLI", () => {
  test("opens a running destination with no place, isolates env for ssh and editor, and leaves nothing pending", () => {
    const fixture = createFixture();
    try {
      const opened = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(opened.exitCode).toBe(0);
      expect(opened.stderr).toBe("");
      expect(parseJson(opened.stdout)).toMatchObject({
        contractVersion: "3.0.0",
        result: {
          commandIdentity: "doorway.open",
          outcome: "success",
          transactionState: "completed",
          causeCode: "SUCCESS_COMPLETED",
          effects: {
            completed: ["editor.open"],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
          data: {
            destination: "example",
            remoteHost: "lab",
            container: "example-box",
            containerId: sampleContainerId,
            place: "/workspace",
            editor: "isolated-vscode",
          },
        },
      });

      const sshRecorded: unknown = JSON.parse(
        readFileSync(fixture.sshLog, "utf8"),
      );
      expect(sshRecorded).toMatchObject({
        hasVscodeIpc: false,
        sshAuthSockLength: 0,
      });

      const authority = remoteAuthority(sampleHost, sampleDestination);
      const editorRecorded: unknown = JSON.parse(
        readFileSync(fixture.editorLog, "utf8"),
      );
      expect(editorRecorded).toEqual({
        argv: [
          "--user-data-dir",
          fixture.userDataFolder,
          "--extensions-dir",
          fixture.extensionsFolder,
          "--new-window",
          "--folder-uri",
          `vscode-remote://${authority}/workspace`,
          "--file-uri",
          `vscode-remote://${authority}/workspace/GUIDE.md`,
        ],
        hasVscodeIpc: false,
        sshAuthSockLength: 0,
      });

      const pending = invokeCli(fixture.environment, "pending", "--json");
      expect(pending.exitCode).toBe(0);
      expect(parseJson(pending.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.pending",
          causeCode: "SUCCESS_UNCHANGED",
          data: { unfinished: [] },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("opens an explicit place and a .code-workspace file", () => {
    const fixture = createFixture();
    try {
      const folderOpen = invokeCli(
        fixture.environment,
        "open",
        "example",
        "/repos/app",
        "--json",
      );
      expect(folderOpen.exitCode).toBe(0);
      expect(parseJson(folderOpen.stdout)).toMatchObject({
        result: {
          causeCode: "SUCCESS_COMPLETED",
          data: { place: "/repos/app" },
        },
      });
      const authority = remoteAuthority(sampleHost, sampleDestination);
      expect(JSON.parse(readFileSync(fixture.editorLog, "utf8"))).toMatchObject(
        {
          argv: [
            "--user-data-dir",
            fixture.userDataFolder,
            "--extensions-dir",
            fixture.extensionsFolder,
            "--new-window",
            "--folder-uri",
            `vscode-remote://${authority}/repos/app`,
          ],
        },
      );

      const workspaceOpen = invokeCli(
        fixture.environment,
        "open",
        "example",
        "/workspace/example.code-workspace",
        "--json",
      );
      expect(workspaceOpen.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(fixture.editorLog, "utf8"))).toMatchObject(
        {
          argv: [
            "--user-data-dir",
            fixture.userDataFolder,
            "--extensions-dir",
            fixture.extensionsFolder,
            "--new-window",
            "--file-uri",
            `vscode-remote://${authority}/workspace/example.code-workspace`,
          ],
        },
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("retry-safe open: a non-zero editor exit ends failed and completed with a handoff, leaves no unresolved case, and the next open runs", () => {
    const fixture = createFixture({
      editorLines: ["process.exit(1);"],
    });
    try {
      const failed = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(failed.exitCode).toBe(3);
      expect(failed.stderr).toBe("");
      expect(parseJson(failed.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          outcome: "failed",
          transactionState: "completed",
          causeCode: "DOMAIN_DOORWAY_OPEN_FAILED",
          data: null,
          effects: {
            completed: ["editor.open"],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
          handoff: {
            owner: "operator",
          },
        },
      });

      const pending = invokeCli(fixture.environment, "pending", "--json");
      expect(pending.exitCode).toBe(0);
      expect(parseJson(pending.stdout)).toMatchObject({
        result: {
          causeCode: "SUCCESS_UNCHANGED",
          data: { unfinished: [] },
        },
      });

      makeScript(fixture.fakeEditor, ["process.exit(0);"]);
      const retried = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(retried.exitCode).toBe(0);
      expect(parseJson(retried.stdout)).toMatchObject({
        result: {
          causeCode: "SUCCESS_COMPLETED",
          transactionState: "completed",
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses every pre-open domain condition cleanly without changing state", () => {
    const fixture = createFixture();
    try {
      const missingSettings = invokeCli(
        {
          ...fixture.environment,
          DOORWAY_SETTINGS: join(fixture.root, "missing.json"),
        },
        "open",
        "example",
        "--json",
      );
      expect(missingSettings.exitCode).toBe(3);
      expect(parseJson(missingSettings.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING" },
      });

      const invalidFile = join(fixture.root, "bad.json");
      writeFileSync(invalidFile, "{broken");
      const invalidSettings = invokeCli(
        { ...fixture.environment, DOORWAY_SETTINGS: invalidFile },
        "open",
        "example",
        "--json",
      );
      expect(invalidSettings.exitCode).toBe(3);
      expect(parseJson(invalidSettings.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_SETTINGS_INVALID" },
      });

      const unknownDest = invokeCli(
        fixture.environment,
        "open",
        "devbox",
        "--json",
      );
      expect(unknownDest.exitCode).toBe(3);
      expect(parseJson(unknownDest.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_DESTINATION_UNKNOWN" },
      });

      const badPlace = invokeCli(
        fixture.environment,
        "open",
        "example",
        "/workspace/../escape",
        "--json",
      );
      expect(badPlace.exitCode).toBe(3);
      expect(parseJson(badPlace.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_PLACE_INVALID" },
      });
    } finally {
      fixture.cleanup();
    }

    const noFolders = createFixture({ createEditorFolders: false });
    try {
      const ran = invokeCli(noFolders.environment, "open", "example", "--json");
      expect(ran.exitCode).toBe(3);
      expect(parseJson(ran.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_EDITOR_FOLDERS_MISSING" },
      });
    } finally {
      noFolders.cleanup();
    }

    const missingTool = createFixture();
    try {
      rmSync(missingTool.fakeEditor);
      const ran = invokeCli(
        missingTool.environment,
        "open",
        "example",
        "--json",
      );
      expect(ran.exitCode).toBe(3);
      expect(parseJson(ran.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_TOOL_UNAVAILABLE" },
      });
    } finally {
      missingTool.cleanup();
    }

    const unreachable = createFixture({ sshLines: ["process.exit(255);"] });
    try {
      const ran = invokeCli(
        unreachable.environment,
        "open",
        "example",
        "--json",
      );
      expect(ran.exitCode).toBe(3);
      expect(parseJson(ran.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_REMOTE_HOST_UNREACHABLE" },
      });
    } finally {
      unreachable.cleanup();
    }

    const remoteFailed = createFixture({ sshLines: ["process.exit(1);"] });
    try {
      const ran = invokeCli(
        remoteFailed.environment,
        "open",
        "example",
        "--json",
      );
      expect(ran.exitCode).toBe(3);
      expect(parseJson(ran.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED" },
      });
    } finally {
      remoteFailed.cleanup();
    }

    const missingContainer = createFixture({ sshLines: ["process.exit(0);"] });
    try {
      const ran = invokeCli(
        missingContainer.environment,
        "open",
        "example",
        "--json",
      );
      expect(ran.exitCode).toBe(3);
      expect(parseJson(ran.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_DESTINATION_MISSING" },
      });
    } finally {
      missingContainer.cleanup();
    }

    const replaced = createFixture({
      sshLines: [
        `process.stdout.write(${JSON.stringify(`${otherContainerId} example-box running\n`)});`,
      ],
    });
    try {
      const ran = invokeCli(replaced.environment, "open", "example", "--json");
      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(parseJson(ran.stdout)).toMatchObject({
        result: {
          causeCode: "DOMAIN_DOORWAY_DESTINATION_REPLACED",
          data: null,
        },
      });
      expect(existsSync(replaced.editorLog)).toBe(false);
    } finally {
      replaced.cleanup();
    }

    const renamed = createFixture({
      sshLines: [
        `process.stdout.write(${JSON.stringify(`${sampleContainerId} renamed-box running\n`)});`,
      ],
    });
    try {
      const ran = invokeCli(renamed.environment, "open", "example", "--json");
      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(parseJson(ran.stdout)).toMatchObject({
        result: {
          causeCode: "DOMAIN_DOORWAY_DESTINATION_REPLACED",
          data: null,
        },
      });
      expect(existsSync(renamed.editorLog)).toBe(false);
    } finally {
      renamed.cleanup();
    }

    const stoppedFixture = createFixture({
      sshLines: [
        `process.stdout.write(${JSON.stringify(`${sampleContainerId} example-box exited\n`)});`,
      ],
    });
    try {
      const ran = invokeCli(
        stoppedFixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(ran.exitCode).toBe(3);
      expect(parseJson(ran.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_DESTINATION_STOPPED" },
      });
      expect(existsSync(stoppedFixture.editorLog)).toBe(false);
    } finally {
      stoppedFixture.cleanup();
    }
  });

  test("addresses distinct pinned container IDs separately through the real CLI and refuses a replacement taking the container name", () => {
    const firstFixture = createFixture();
    const secondFixture = createFixture({
      destination: { containerId: otherContainerId },
      sshLines: [
        `process.stdout.write(${JSON.stringify(`${otherContainerId} example-box running\n`)});`,
      ],
    });
    try {
      const firstRun = invokeCli(
        firstFixture.environment,
        "open",
        "example",
        "--json",
      );
      const secondRun = invokeCli(
        secondFixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(firstRun.exitCode).toBe(0);
      expect(secondRun.exitCode).toBe(0);
      expect(firstRun.stderr).toBe("");
      expect(secondRun.stderr).toBe("");

      const firstRecorded: unknown = JSON.parse(
        readFileSync(firstFixture.editorLog, "utf8"),
      );
      const secondRecorded: unknown = JSON.parse(
        readFileSync(secondFixture.editorLog, "utf8"),
      );
      const firstAuthority = remoteAuthority(sampleHost, sampleDestination);
      const secondAuthority = remoteAuthority(sampleHost, {
        ...sampleDestination,
        containerId: otherContainerId,
      });
      expect(firstAuthority).not.toBe(secondAuthority);
      expect(firstRecorded).toMatchObject({
        argv: [
          "--user-data-dir",
          firstFixture.userDataFolder,
          "--extensions-dir",
          firstFixture.extensionsFolder,
          "--new-window",
          "--folder-uri",
          `vscode-remote://${firstAuthority}/workspace`,
          "--file-uri",
          `vscode-remote://${firstAuthority}/workspace/GUIDE.md`,
        ],
      });
      expect(secondRecorded).toMatchObject({
        argv: [
          "--user-data-dir",
          secondFixture.userDataFolder,
          "--extensions-dir",
          secondFixture.extensionsFolder,
          "--new-window",
          "--folder-uri",
          `vscode-remote://${secondAuthority}/workspace`,
          "--file-uri",
          `vscode-remote://${secondAuthority}/workspace/GUIDE.md`,
        ],
      });

      rmSync(firstFixture.editorLog, { force: true });
      makeScript(firstFixture.fakeSsh, [
        `process.stdout.write(${JSON.stringify(`${otherContainerId} example-box running\n`)});`,
      ]);
      const replacedAfterInventory = invokeCli(
        firstFixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(replacedAfterInventory.exitCode).toBe(3);
      expect(replacedAfterInventory.stderr).toBe("");
      expect(parseJson(replacedAfterInventory.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          outcome: "refused",
          transactionState: "unchanged",
          causeCode: "DOMAIN_DOORWAY_DESTINATION_REPLACED",
          data: null,
        },
      });
      expect(existsSync(firstFixture.editorLog)).toBe(false);
    } finally {
      firstFixture.cleanup();
      secondFixture.cleanup();
    }
  });

  test("pending succeeds with empty unfinished list before any open and reports state unavailable when state is corrupt", () => {
    const fixture = createFixture();
    try {
      const before = invokeCli(fixture.environment, "pending", "--json");
      expect(before.exitCode).toBe(0);
      expect(parseJson(before.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.pending",
          causeCode: "SUCCESS_UNCHANGED",
          data: { unfinished: [] },
        },
      });

      const blockedState = join(fixture.root, "not-a-folder");
      writeFileSync(blockedState, "corrupt");
      const corruptEnv = {
        ...fixture.environment,
        DOORWAY_STATE: blockedState,
      };

      const pendingFailed = invokeCli(corruptEnv, "pending", "--json");
      expect(pendingFailed.exitCode).toBe(3);
      expect(parseJson(pendingFailed.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.pending",
          causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        },
      });

      const openFailed = invokeCli(corruptEnv, "open", "example", "--json");
      expect(openFailed.exitCode).toBe(3);
      expect(parseJson(openFailed.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("heals a killed earlier open on the next open, launches the editor again, reports superseded, and clears pending", async () => {
    const fixture = createFixture();
    try {
      const killedOperationId = await runKilledOpen(fixture);

      const pendingBefore = invokeCli(fixture.environment, "pending", "--json");
      expect(pendingBefore.exitCode).toBe(0);
      expect(pendingBefore.stderr).toBe("");
      const pendingBeforeEnvelope = parseJson(pendingBefore.stdout);
      expect(pendingBeforeEnvelope).toMatchObject({
        result: {
          commandIdentity: "doorway.pending",
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            unfinished: [
              {
                operationId: killedOperationId,
                commandIdentity: "doorway.open",
              },
            ],
          },
        },
      });
      const pendingMessage = ownProperty(pendingBeforeEnvelope, "message");
      expect(typeof pendingMessage).toBe("string");
      expect(String(pendingMessage)).toContain("clears on the next open");

      installLoggingEditor(fixture.fakeEditor, fixture.editorLog);
      const healed = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(healed.exitCode).toBe(0);
      expect(healed.stderr).toBe("");
      const healedEnvelope = parseJson(healed.stdout);
      expect(healedEnvelope).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          outcome: "success",
          transactionState: "completed",
          causeCode: "SUCCESS_COMPLETED",
          superseded: [killedOperationId],
          data: { destination: "example" },
        },
      });
      expect(String(ownProperty(healedEnvelope, "message"))).toContain(
        `Cleared earlier unfinished operation: ${killedOperationId}.`,
      );
      expect(existsSync(fixture.editorLog)).toBe(true);

      const pendingAfter = invokeCli(fixture.environment, "pending", "--json");
      expect(pendingAfter.exitCode).toBe(0);
      expect(parseJson(pendingAfter.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.pending",
          causeCode: "SUCCESS_UNCHANGED",
          data: { unfinished: [] },
        },
      });

      const cleanOpen = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(cleanOpen.exitCode).toBe(0);
      const cleanEnvelope = parseJson(cleanOpen.stdout);
      const cleanResult = ownProperty(cleanEnvelope, "result");
      expect(
        typeof cleanResult === "object" &&
          cleanResult !== null &&
          Object.hasOwn(cleanResult, "superseded"),
      ).toBe(false);
      expect(String(ownProperty(cleanEnvelope, "message"))).not.toContain(
        "Cleared earlier unfinished",
      );

      const secondKilledId = await runKilledOpen(fixture);
      installLoggingEditor(fixture.fakeEditor, fixture.editorLog);
      const healedHuman = invokeCli(fixture.environment, "open", "example");
      expect(healedHuman.exitCode).toBe(0);
      expect(healedHuman.stderr).toBe("");
      expect(healedHuman.stdout).toContain(
        `Cleared earlier unfinished operation: ${secondKilledId}.`,
      );
      expect(readUnfinishedOperationIds(fixture.environment)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses a concurrent open with DOMAIN_DOORWAY_DESTINATION_HELD while the earlier open still holds its owner lease and clears nothing", async () => {
    const fixture = createFixture();
    try {
      const readyFile = join(fixture.root, "editor-ready");
      const releaseFile = join(fixture.root, "editor-release");
      installWaitingEditor(fixture.fakeEditor, readyFile, releaseFile);

      const first = Bun.spawn(
        [process.execPath, "run", cliEntry, "open", "example", "--json"],
        {
          env: fixture.environment,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        },
      );
      try {
        await waitForFile(readyFile);
        const liveIds = readUnfinishedOperationIds(fixture.environment);
        expect(liveIds).toHaveLength(1);
        const liveOperationId = liveIds[0];
        if (liveOperationId === undefined)
          throw new Error("Expected live operationId.");

        const held = invokeCli(
          fixture.environment,
          "open",
          "example",
          "--json",
        );
        expect(held.exitCode).toBe(3);
        expect(held.stderr).toBe("");
        const heldEnvelope = parseJson(held.stdout);
        expect(heldEnvelope).toMatchObject({
          result: {
            commandIdentity: "doorway.open",
            outcome: "refused",
            transactionState: "unchanged",
            causeCode: "DOMAIN_DOORWAY_DESTINATION_HELD",
            handoff: {
              owner: "operator",
              inspect: [
                { kind: "command", command: "doorway.pending", args: [] },
              ],
            },
          },
        });
        const heldResult = ownProperty(heldEnvelope, "result");
        expect(
          typeof heldResult === "object" &&
            heldResult !== null &&
            Object.hasOwn(heldResult, "superseded"),
        ).toBe(false);
        expect(
          existsSync(
            join(fixture.stateFolder, "operations", liveOperationId, "closure"),
          ),
        ).toBe(false);
        expect(
          existsSync(join(fixture.stateFolder, "settled", liveOperationId)),
        ).toBe(false);
      } finally {
        writeFileSync(releaseFile, "go");
        await first.exited;
      }
      expect(first.exitCode).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses DOMAIN_DOORWAY_DESTINATION_UNRESOLVED with truthful wording when the earlier open has a torn last journal record", async () => {
    const fixture = createFixture();
    try {
      const killedOperationId = await runKilledOpen(fixture);
      const eventsPath = join(
        fixture.stateFolder,
        "operations",
        killedOperationId,
        "events",
      );
      const recordBytes = firstFramedRecord(readFileSync(eventsPath));
      appendFileSync(
        eventsPath,
        Buffer.concat([Buffer.from("C3S1 effect-started "), recordBytes]),
      );

      installLoggingEditor(fixture.fakeEditor, fixture.editorLog);
      const refused = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr).toBe("");
      const refusedEnvelope = parseJson(refused.stdout);
      expect(refusedEnvelope).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          outcome: "refused",
          transactionState: "unchanged",
          causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
          handoff: {
            owner: "operator",
            inspect: [
              { kind: "command", command: "doorway.pending", args: [] },
            ],
          },
        },
      });
      const refusedMessage = String(ownProperty(refusedEnvelope, "message"));
      expect(refusedMessage).toContain(killedOperationId);
      expect(refusedMessage).toContain("cannot clear automatically");
      expect(refusedMessage).toContain("torn journal record");
      const refusedResult = ownProperty(refusedEnvelope, "result");
      const repairAction = String(ownProperty(refusedResult, "repairAction"));
      expect(repairAction).toContain("clears automatically");
      expect(repairAction).toContain("torn journal record");
      expect(existsSync(fixture.editorLog)).toBe(false);
      expect(
        existsSync(
          join(fixture.stateFolder, "operations", killedOperationId, "closure"),
        ),
      ).toBe(false);
      expect(readUnfinishedOperationIds(fixture.environment)).toEqual([
        killedOperationId,
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test("leaves an unresolved open for another destination untouched when opening this destination", async () => {
    const secondDestination: DestinationSettings = {
      ...sampleDestination,
      name: "second",
      label: "Second container",
      container: "second-box",
      containerId: otherContainerId,
    };
    const fixture = createFixture({
      destinations: [sampleDestination, secondDestination],
      sshLines: [
        `process.stdout.write(${JSON.stringify(
          `${sampleContainerId} example-box running\n${otherContainerId} second-box running\n`,
        )});`,
      ],
    });
    try {
      const exampleOperationId = await runKilledOpen(fixture, "example");

      installLoggingEditor(fixture.fakeEditor, fixture.editorLog);
      const openedOther = invokeCli(
        fixture.environment,
        "open",
        "second",
        "--json",
      );
      expect(openedOther.exitCode).toBe(0);
      expect(openedOther.stderr).toBe("");
      const otherEnvelope = parseJson(openedOther.stdout);
      expect(otherEnvelope).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          outcome: "success",
          transactionState: "completed",
          causeCode: "SUCCESS_COMPLETED",
          data: {
            destination: "second",
            container: "second-box",
            containerId: otherContainerId,
          },
        },
      });
      const otherResult = ownProperty(otherEnvelope, "result");
      expect(
        typeof otherResult === "object" &&
          otherResult !== null &&
          Object.hasOwn(otherResult, "superseded"),
      ).toBe(false);
      expect(existsSync(fixture.editorLog)).toBe(true);

      expect(readUnfinishedOperationIds(fixture.environment)).toEqual([
        exampleOperationId,
      ]);
      expect(
        existsSync(
          join(
            fixture.stateFolder,
            "operations",
            exampleOperationId,
            "closure",
          ),
        ),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("ends failed and unknown when the editor stop is not confirmed, leaving an unresolved case", async () => {
    const fixture = createFixture();
    try {
      const doorway = createDoorway(fixture.environment);
      const fakePrograms: RunAddon<ProgramsCapability> = {
        attach: () => ({
          capability: {
            inspect: (): Promise<ProgramResult> =>
              Promise.resolve({
                stdout: `${sampleContainerId} example-box running\n`,
                stderr: "",
                exitCode: 0,
                terminationConfirmed: true,
                outputTruncated: false,
              }),
            supplied: (): Promise<ProgramResult> =>
              Promise.reject(new Error("unused")),
            domain: (effect) => ({
              effect: effect.effect,
              start: (): Promise<ProgramResult> =>
                effect.admitStart(effect.runId, effect.effect, () =>
                  Promise.resolve({
                    stdout: "",
                    stderr: "",
                    exitCode: 0,
                    terminationConfirmed: false,
                    outputTruncated: false,
                  }),
                ),
            }),
          },
          settle: () => Promise.resolve(true),
          killNow: () => undefined,
        }),
      };

      const ran = await runInProcess(doorway.contract, {
        emergencyRecord: doorway.state.emergencyRecord,
        addons: { programs: fakePrograms },
      })(["open", "example", "--json"]);
      expect(ran.kind).toBe("envelope");
      if (ran.kind !== "envelope") return;
      expect(ran.exitCode).toBe(3);
      expect(ran.envelope.result).toMatchObject({
        commandIdentity: "doorway.open",
        outcome: "failed",
        transactionState: "unknown",
        causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
        effects: {
          completed: [],
          remaining: [],
          uncertain: ["editor.open"],
          inventoryComplete: true,
        },
      });

      const pending = await runInProcess(doorway.contract, {
        emergencyRecord: doorway.state.emergencyRecord,
        addons: { programs: fakePrograms },
      })(["pending", "--json"]);
      expect(pending.kind).toBe("envelope");
      if (pending.kind !== "envelope") return;
      expect(pending.envelope.result).toMatchObject({
        causeCode: "SUCCESS_UNCHANGED",
        data: {
          unfinished: [{ commandIdentity: "doorway.open" }],
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  const sigtermTrapTestBudget = {
    sshInspectMilliseconds: 30_000,
    sshShutdownGraceMilliseconds: 1_000,
    readyWaitMilliseconds: 10_000,
    editorTimeoutMilliseconds: 2_000,
    editorShutdownGraceMilliseconds: 1_000,
    readinessCleanupMilliseconds: 2_000,
    pendingBeforeHealMilliseconds: cliSpawnTimeoutMilliseconds,
    secondOpenMilliseconds: cliSpawnTimeoutMilliseconds,
    pendingAfterHealMilliseconds: cliSpawnTimeoutMilliseconds,
    headroomMilliseconds: 10_000,
  } as const;
  const sigtermTrapTestTimeoutMilliseconds =
    sigtermTrapTestBudget.sshInspectMilliseconds +
    sigtermTrapTestBudget.sshShutdownGraceMilliseconds +
    sigtermTrapTestBudget.readyWaitMilliseconds +
    sigtermTrapTestBudget.editorTimeoutMilliseconds +
    sigtermTrapTestBudget.editorShutdownGraceMilliseconds +
    sigtermTrapTestBudget.readinessCleanupMilliseconds +
    sigtermTrapTestBudget.pendingBeforeHealMilliseconds +
    sigtermTrapTestBudget.secondOpenMilliseconds +
    sigtermTrapTestBudget.pendingAfterHealMilliseconds +
    sigtermTrapTestBudget.headroomMilliseconds;
  const sigtermTrapEditorFallbackMilliseconds = 15_000;

  test(
    "ends failed and unknown when a hanging editor launcher traps SIGTERM and exits 0 after timeout, leaving an unresolved case that the next open clears",
    async () => {
      const fixture = createFixture();
      try {
        const readyFile = join(fixture.root, "editor-ready");
        const sigtermFile = join(fixture.root, "editor-sigterm");
        makeScript(fixture.fakeEditor, [
          'import { writeFileSync } from "node:fs";',
          'process.on("SIGTERM", () => {',
          `  writeFileSync(${JSON.stringify(sigtermFile)}, "trapped");`,
          "  process.exit(0);",
          "});",
          `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
          "setTimeout(() => {",
          "  process.exit(1);",
          `}, ${String(sigtermTrapEditorFallbackMilliseconds)});`,
        ]);

        const doorway = createDoorway(
          fixture.environment,
          ["state", "programs"],
          sigtermTrapTestBudget.editorTimeoutMilliseconds,
        );
        const readyGate = gateDomainTimeoutOnReadyFile(
          doorway.setup.addons.programs,
          readyFile,
          sigtermTrapTestBudget.readyWaitMilliseconds,
          sigtermTrapTestBudget.readinessCleanupMilliseconds,
        );
        const ran = await runInProcess(doorway.contract, {
          emergencyRecord: doorway.state.emergencyRecord,
          addons: { programs: readyGate.addon },
        })(["open", "example", "--json"]);
        readyGate.throwIfNotReady();
        expect(readyGate.domainTimeoutFired()).toBe(true);
        expect(existsSync(readyFile)).toBe(true);
        expect(existsSync(sigtermFile)).toBe(true);
        expect(ran.kind).toBe("envelope");
        if (ran.kind !== "envelope") return;
        expect(ran.exitCode).toBe(3);
        expect(ran.envelope.result).toMatchObject({
          commandIdentity: "doorway.open",
          outcome: "failed",
          transactionState: "unknown",
          causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
          data: null,
          effects: {
            completed: [],
            remaining: [],
            uncertain: ["editor.open"],
            inventoryComplete: true,
          },
          handoff: {
            owner: "operator",
            inspect: [
              { kind: "command", command: "doorway.pending", args: [] },
            ],
          },
        });

        const timedOutIds = readUnfinishedOperationIds(fixture.environment);
        expect(timedOutIds).toHaveLength(1);
        const timedOutId = timedOutIds[0];
        if (timedOutId === undefined)
          throw new Error("Expected timed out operationId.");

        installLoggingEditor(fixture.fakeEditor, fixture.editorLog);
        const healed = invokeCli(
          fixture.environment,
          "open",
          "example",
          "--json",
        );
        expect(healed.exitCode).toBe(0);
        expect(healed.stderr).toBe("");
        expect(parseJson(healed.stdout)).toMatchObject({
          result: {
            commandIdentity: "doorway.open",
            outcome: "success",
            transactionState: "completed",
            causeCode: "SUCCESS_COMPLETED",
            superseded: [timedOutId],
          },
        });
        expect(existsSync(fixture.editorLog)).toBe(true);
        expect(readUnfinishedOperationIds(fixture.environment)).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    },
    sigtermTrapTestTimeoutMilliseconds,
  );

  test("treats a launcher result with missing programDetails as not confirmed even with exit 0 and terminationConfirmed", async () => {
    const fixture = createFixture();
    try {
      const doorway = createDoorway(fixture.environment);
      const fakePrograms: RunAddon<ProgramsCapability> = {
        attach: () => ({
          capability: {
            inspect: (): Promise<ProgramResult> =>
              Promise.resolve({
                stdout: `${sampleContainerId} example-box running\n`,
                stderr: "",
                exitCode: 0,
                terminationConfirmed: true,
                outputTruncated: false,
              }),
            supplied: (): Promise<ProgramResult> =>
              Promise.reject(new Error("unused")),
            domain: (effect) => ({
              effect: effect.effect,
              start: (): Promise<ProgramResult> =>
                effect.admitStart(effect.runId, effect.effect, () =>
                  Promise.resolve({
                    stdout: "",
                    stderr: "",
                    exitCode: 0,
                    terminationConfirmed: true,
                    outputTruncated: false,
                  }),
                ),
            }),
          },
          settle: () => Promise.resolve(true),
          killNow: () => undefined,
        }),
      };

      const ran = await runInProcess(doorway.contract, {
        emergencyRecord: doorway.state.emergencyRecord,
        addons: { programs: fakePrograms },
      })(["open", "example", "--json"]);
      expect(ran.kind).toBe("envelope");
      if (ran.kind !== "envelope") return;
      expect(ran.exitCode).toBe(3);
      expect(ran.envelope.result).toMatchObject({
        commandIdentity: "doorway.open",
        outcome: "failed",
        transactionState: "unknown",
        causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
        effects: {
          completed: [],
          remaining: [],
          uncertain: ["editor.open"],
          inventoryComplete: true,
        },
      });

      const pending = invokeCli(fixture.environment, "pending", "--json");
      expect(pending.exitCode).toBe(0);
      expect(parseJson(pending.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.pending",
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            unfinished: [{ commandIdentity: "doorway.open" }],
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("reports an unconfirmed open that doorway pending lists, without starting the editor, when the state journal cannot append effect-started or the completion", async () => {
    const fixture = createFixture();
    let eventsFile: string | undefined;
    try {
      const realState = stateAddon({
        root: fixture.stateFolder,
        report: "doorway.pending",
      });
      const failingJournalState: DoorwayState = {
        ...realState,
        transaction: (capability, declaration, work) =>
          realState.transaction(
            capability,
            declaration,
            (transaction, published) => {
              eventsFile = join(
                fixture.stateFolder,
                "operations",
                published.operationId,
                "events",
              );
              chmodSync(eventsFile, 0o400);
              return work(transaction, published);
            },
          ),
      };
      const parsePath = (value: string): ParsedPath =>
        contract.boundary.path(value);
      const contract = contractFor({
        cli,
        commands: [
          openCommand(failingJournalState, fixture.environment, parsePath),
          pendingCommand(realState, fixture.stateFolder, fixture.environment),
        ],
        causes,
        state: realState.descriptor,
        installedAddons: ["state", "programs"],
      });

      const ran = await runInProcess(contract, {
        emergencyRecord: realState.emergencyRecord,
        addons: { programs: programsAddon() },
      })(["open", "example", "--json"]);
      expect(ran.kind).toBe("envelope");
      if (ran.kind !== "envelope") return;
      expect(ran.exitCode).toBe(3);
      expect(ran.envelope.result).toMatchObject({
        commandIdentity: "doorway.open",
        outcome: "failed",
        transactionState: "unknown",
        causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
        attemptedEffect: "editor.open",
        data: null,
        effects: {
          completed: [],
          remaining: ["editor.open"],
          uncertain: [],
          inventoryComplete: false,
        },
        handoff: {
          owner: "operator",
          inspect: [{ kind: "command", command: "doorway.pending", args: [] }],
        },
      });
      expect(ran.envelope.message).toContain(
        "The isolated editor did not start for example",
      );
      expect(existsSync(fixture.editorLog)).toBe(false);

      const pending = await runInProcess(contract, {
        emergencyRecord: realState.emergencyRecord,
        addons: { programs: programsAddon() },
      })(["pending", "--json"]);
      expect(pending.kind).toBe("envelope");
      if (pending.kind !== "envelope") return;
      expect(pending.envelope.result).toMatchObject({
        commandIdentity: "doorway.pending",
        data: { unfinished: [{ commandIdentity: "doorway.open" }] },
      });
    } finally {
      if (eventsFile !== undefined && existsSync(eventsFile)) {
        chmodSync(eventsFile, 0o600);
      }
      fixture.cleanup();
    }
  });

  test("reports the cleared earlier open and points to doorway pending when a flagged open clears one unfinished case and is then refused", async () => {
    const fixture = createFixture();
    let blockedOperationFolder: string | undefined;
    try {
      const firstCreatedId = await runKilledOpen(fixture);
      const savedOperationFolder = join(fixture.root, "saved-operation");
      renameSync(
        join(fixture.stateFolder, "operations", firstCreatedId),
        savedOperationFolder,
      );
      const secondCreatedId = await runKilledOpen(fixture);
      renameSync(
        savedOperationFolder,
        join(fixture.stateFolder, "operations", firstCreatedId),
      );

      const orderedIds = [firstCreatedId, secondCreatedId].sort();
      const clearedId = orderedIds[0];
      const blockedId = orderedIds[1];
      if (clearedId === undefined || blockedId === undefined)
        throw new Error("Expected two distinct killed operation ids.");

      blockedOperationFolder = join(
        fixture.stateFolder,
        "operations",
        blockedId,
      );
      chmodSync(blockedOperationFolder, 0o500);
      installLoggingEditor(fixture.fakeEditor, fixture.editorLog);

      const refused = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr).toBe("");
      const refusedEnvelope = parseJson(refused.stdout);
      expect(refusedEnvelope).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          outcome: "refused",
          transactionState: "unchanged",
          causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          superseded: [clearedId],
          data: null,
          handoff: {
            owner: "operator",
            inspect: [
              { kind: "command", command: "doorway.pending", args: [] },
            ],
          },
        },
      });
      const refusedMessage = String(ownProperty(refusedEnvelope, "message"));
      expect(refusedMessage).toContain(
        `Cleared earlier unfinished operation: ${clearedId}.`,
      );
      expect(refusedMessage).toContain("doorway pending");
      expect(existsSync(fixture.editorLog)).toBe(false);
      expect(readUnfinishedOperationIds(fixture.environment)).toEqual([
        blockedId,
      ]);

      chmodSync(blockedOperationFolder, 0o700);
      renameSync(blockedOperationFolder, savedOperationFolder);
      const thirdCreatedId = await runKilledOpen(fixture);
      renameSync(savedOperationFolder, blockedOperationFolder);

      const humanOrderedIds = [thirdCreatedId, blockedId].sort();
      const humanClearedId = humanOrderedIds[0];
      const humanBlockedId = humanOrderedIds[1];
      if (humanClearedId === undefined || humanBlockedId === undefined)
        throw new Error("Expected two distinct operation ids for human check.");
      blockedOperationFolder = join(
        fixture.stateFolder,
        "operations",
        humanBlockedId,
      );
      chmodSync(blockedOperationFolder, 0o500);
      installLoggingEditor(fixture.fakeEditor, fixture.editorLog);
      const humanRefused = invokeCli(fixture.environment, "open", "example");
      expect(humanRefused.exitCode).toBe(3);
      expect(humanRefused.stdout).toBe("");
      expect(humanRefused.stderr).toContain(
        `Cleared earlier unfinished operation: ${humanClearedId}.`,
      );
      expect(humanRefused.stderr).toContain("doorway pending");
      expect(humanRefused.stderr).toContain(
        "[DOMAIN_DOORWAY_STATE_UNAVAILABLE]",
      );
    } finally {
      if (
        blockedOperationFolder !== undefined &&
        existsSync(blockedOperationFolder)
      ) {
        chmodSync(blockedOperationFolder, 0o700);
      }
      fixture.cleanup();
    }
  });

  test("reports multiple cleared cases and points to doorway pending on unresolved-case refusal after closure, and omits that note when nothing was cleared", async () => {
    const fixture = createFixture();
    try {
      const realState = stateAddon({
        root: fixture.stateFolder,
        report: "doorway.pending",
      });
      const firstClearedId = "op-0000000000000001";
      const secondClearedId = "op-0000000000000002";
      const remainingId = "op-0000000000000003";

      const runWithRefusal = async (
        superseded: readonly string[] | undefined,
      ) => {
        const stubState: DoorwayState = {
          ...realState,
          transaction: async (capability, declaration) => {
            const base = await realState.transaction(
              capability,
              { ...declaration, supersedeUnresolved: false },
              () => Promise.resolve(),
            );
            return {
              kind: "unresolved-case",
              operationId: remainingId,
              proof: base.proof,
              ...(superseded === undefined ? {} : { superseded }),
            };
          },
        };
        const parsePath = (value: string): ParsedPath =>
          contract.boundary.path(value);
        const contract = contractFor({
          cli,
          commands: [
            openCommand(stubState, fixture.environment, parsePath),
            pendingCommand(realState, fixture.stateFolder, fixture.environment),
          ],
          causes,
          state: realState.descriptor,
          installedAddons: ["state", "programs"],
        });
        return runInProcess(contract, {
          emergencyRecord: realState.emergencyRecord,
          addons: { programs: programsAddon() },
        })(["open", "example", "--json"]);
      };

      const withSuperseded = await runWithRefusal([
        firstClearedId,
        secondClearedId,
      ]);
      expect(withSuperseded.kind).toBe("envelope");
      if (withSuperseded.kind !== "envelope") return;
      expect(withSuperseded.exitCode).toBe(3);
      expect(withSuperseded.envelope.result).toMatchObject({
        commandIdentity: "doorway.open",
        outcome: "refused",
        transactionState: "unchanged",
        causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
        data: null,
        handoff: {
          owner: "operator",
          inspect: [{ kind: "command", command: "doorway.pending", args: [] }],
        },
      });
      expect(withSuperseded.envelope.message).toContain(
        `Cleared earlier unfinished operations: ${firstClearedId}, ${secondClearedId}.`,
      );
      expect(withSuperseded.envelope.message).toContain("doorway pending");
      expect(withSuperseded.envelope.message).toContain(remainingId);

      const withoutSuperseded = await runWithRefusal(undefined);
      expect(withoutSuperseded.kind).toBe("envelope");
      if (withoutSuperseded.kind !== "envelope") return;
      expect(withoutSuperseded.exitCode).toBe(3);
      expect(withoutSuperseded.envelope.message).toContain(remainingId);
      expect(withoutSuperseded.envelope.message).not.toContain(
        "Cleared earlier unfinished",
      );
      expect(withoutSuperseded.envelope.message).not.toContain(
        "Run doorway pending",
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("reports the cleared earlier open and points to doorway pending when the journal cannot append effect-started after clearing an earlier killed open", async () => {
    const fixture = createFixture();
    let eventsFile: string | undefined;
    try {
      const killedOperationId = await runKilledOpen(fixture);
      const realState = stateAddon({
        root: fixture.stateFolder,
        report: "doorway.pending",
      });
      const failingJournalState: DoorwayState = {
        ...realState,
        transaction: (capability, declaration, work) =>
          realState.transaction(
            capability,
            declaration,
            (transaction, published) => {
              eventsFile = join(
                fixture.stateFolder,
                "operations",
                published.operationId,
                "events",
              );
              chmodSync(eventsFile, 0o400);
              return work(transaction, published);
            },
          ),
      };
      const parsePath = (value: string): ParsedPath =>
        contract.boundary.path(value);
      const contract = contractFor({
        cli,
        commands: [
          openCommand(failingJournalState, fixture.environment, parsePath),
          pendingCommand(realState, fixture.stateFolder, fixture.environment),
        ],
        causes,
        state: realState.descriptor,
        installedAddons: ["state", "programs"],
      });

      const ran = await runInProcess(contract, {
        emergencyRecord: realState.emergencyRecord,
        addons: { programs: programsAddon() },
      })(["open", "example", "--json"]);
      expect(ran.kind).toBe("envelope");
      if (ran.kind !== "envelope") return;
      expect(ran.exitCode).toBe(3);
      expect(ran.envelope.result).toMatchObject({
        commandIdentity: "doorway.open",
        outcome: "failed",
        transactionState: "unknown",
        causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
        superseded: [killedOperationId],
        data: null,
        handoff: {
          owner: "operator",
          inspect: [{ kind: "command", command: "doorway.pending", args: [] }],
        },
      });
      expect(ran.envelope.message).toContain(
        `Cleared earlier unfinished operation: ${killedOperationId}.`,
      );
      expect(ran.envelope.message).toContain("doorway pending");
      expect(existsSync(fixture.editorLog)).toBe(false);
    } finally {
      if (eventsFile !== undefined && existsSync(eventsFile)) {
        chmodSync(eventsFile, 0o600);
      }
      fixture.cleanup();
    }
  });

  const editorKillsItself = ['process.kill(process.pid, "SIGKILL");'];
  const notStarted = "The isolated editor did not start for example";
  const stopUnconfirmed =
    "Could not confirm that the isolated editor stopped cleanly for example";
  const startedAndStopped =
    "The isolated editor started and stopped for example with exit code 0.";
  const unknownProofCases = [
    {
      name: "ran, effect-started and not-applied writes fail",
      faults: "effect-started:write,not-applied:write",
      placement: "remaining",
      message: notStarted,
      inventoryComplete: false,
      editorRan: false,
      unfinishedAfter: 1,
    },
    {
      name: "ran, effect-started write fails and the not-applied flush fails",
      faults: "effect-started:write,not-applied:flush",
      placement: "remaining",
      message: notStarted,
      inventoryComplete: false,
      editorRan: false,
      unfinishedAfter: 0,
    },
    {
      name: "ran, the editor stop is not confirmed",
      faults: "",
      editorLines: editorKillsItself,
      placement: "uncertain",
      message: stopUnconfirmed,
      inventoryComplete: true,
      editorRan: false,
      unfinishedAfter: 1,
    },
    {
      name: "ran, the editor stopped and the completion write fails",
      faults: "completion:write",
      placement: "completed",
      message: startedAndStopped,
      inventoryComplete: false,
      editorRan: true,
      unfinishedAfter: 1,
    },
    {
      name: "ran, the editor stopped and the completion flush fails",
      faults: "completion:flush",
      placement: "completed",
      message: startedAndStopped,
      inventoryComplete: false,
      editorRan: true,
      unfinishedAfter: 0,
    },
    {
      name: "refused, the closure link and the not-applied write fail after a killed open",
      faults: "closure:link,not-applied:write",
      seedKilledOpen: true,
      placement: "remaining",
      message: notStarted,
      inventoryComplete: false,
      editorRan: false,
      unfinishedAfter: 2,
    },
  ] as const;

  test.each(unknownProofCases)(
    "answers every unknown proof with DOMAIN_DOORWAY_OPEN_UNCONFIRMED, its proof and a message that matches where editor.open sits: $name",
    async (row) => {
      const fixture = createFixture(
        "editorLines" in row ? { editorLines: row.editorLines } : {},
      );
      try {
        if ("seedKilledOpen" in row) {
          await runKilledOpen(fixture);
          installLoggingEditor(fixture.fakeEditor, fixture.editorLog);
        }
        const ran = invokeCliWithJournalFaults(
          fixture,
          row.faults,
          "open",
          "example",
          "--json",
        );
        const envelope = parseJson(ran.stdout);
        expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
          exitCode: 3,
          stderr: "",
        });
        expect(ownProperty(envelope, "result")).toMatchObject({
          commandIdentity: "doorway.open",
          outcome: "failed",
          transactionState: "unknown",
          causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
          attemptedEffect: "editor.open",
          effects: {
            completed: row.placement === "completed" ? ["editor.open"] : [],
            remaining: row.placement === "remaining" ? ["editor.open"] : [],
            uncertain: row.placement === "uncertain" ? ["editor.open"] : [],
            inventoryComplete: row.inventoryComplete,
          },
          handoff: {
            inspect: [
              { kind: "command", command: "doorway.pending", args: [] },
            ],
          },
        });
        const message = String(ownProperty(envelope, "message"));
        expect(message).toContain(row.message);
        expect(message).not.toContain("lists it");
        expect(message.includes("Run doorway pending to check")).toBe(
          !row.inventoryComplete,
        );
        expect(existsSync(fixture.editorLog)).toBe(row.editorRan);
        const unfinished = readUnfinishedOperationIds(fixture.environment);
        expect(unfinished).toHaveLength(row.unfinishedAfter);

        installLoggingEditor(fixture.fakeEditor, fixture.editorLog);
        const reopened = invokeCli(fixture.environment, "open", "example");
        expect(reopened.exitCode).toBe(0);
        expect(reopened.stdout).toContain(
          unfinished.length === 0 ? "Opened example" : "Cleared earlier",
        );
        expect(readUnfinishedOperationIds(fixture.environment)).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  test("keeps the refused and unchanged state station when only the effect-started write fails and the not-applied record lands", () => {
    const fixture = createFixture();
    try {
      const ran = invokeCliWithJournalFaults(
        fixture,
        "effect-started:write",
        "open",
        "example",
        "--json",
      );
      expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
        exitCode: 3,
        stderr: "",
      });
      const envelope = parseJson(ran.stdout);
      expect(ownProperty(envelope, "result")).toMatchObject({
        commandIdentity: "doorway.open",
        outcome: "refused",
        transactionState: "unchanged",
        causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        effects: {
          completed: [],
          remaining: ["editor.open"],
          uncertain: [],
          inventoryComplete: true,
        },
      });
      expect(String(ownProperty(envelope, "message"))).toContain(
        "Doorway state could not record example before starting the isolated editor: EIO: planted journal fault, effect-started write.",
      );
      expect(existsSync(fixture.editorLog)).toBe(false);
      expect(readUnfinishedOperationIds(fixture.environment)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});

function withoutVariables(
  environment: Record<string, string>,
  ...names: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !names.includes(name)),
  );
}

function singleQuoted(pathValue: string): string {
  return `'${pathValue.replaceAll("'", "'\\''")}'`;
}

function expectedMoveCommand(
  oldPath: string,
  newParent: string,
  newPath: string,
): string {
  return `mkdir -p ${singleQuoted(newParent)} && mv ${singleQuoted(oldPath)} ${singleQuoted(newPath)}`;
}

function runShell(commandLine: string): number {
  return Bun.spawnSync(["/bin/sh", "-c", commandLine], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  }).exitCode;
}

function messageOf(stdout: string): string {
  return String(ownProperty(parseJson(stdout), "message"));
}

describe("default doorway folders inside my-agent-dojo", () => {
  test("open refuses a settings file left at the old place, names the move command, writes nothing, and opens once the move has run", () => {
    const fixture = createFixture();
    try {
      const configBase = join(fixture.root, "nathan's config");
      const oldSettings = join(configBase, "doorway", "settings.json");
      const newParent = join(configBase, "my-agent-dojo", "doorway");
      const newSettings = join(newParent, "settings.json");
      mkdirSync(join(configBase, "doorway"), { recursive: true });
      const settingsText = readFileSync(fixture.settingsFile, "utf8");
      writeFileSync(oldSettings, settingsText);
      const environment = {
        ...withoutVariables(fixture.environment, "DOORWAY_SETTINGS"),
        XDG_CONFIG_HOME: configBase,
      };

      const refused = invokeCli(environment, "open", "example", "--json");
      expect(refused.exitCode).toBe(3);
      expect(parseJson(refused.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING",
          transactionState: "unchanged",
          data: null,
        },
      });
      const moveCommand = expectedMoveCommand(
        oldSettings,
        newParent,
        newSettings,
      );
      const message = messageOf(refused.stdout);
      expect(message).toContain(oldSettings);
      expect(message).toContain(newSettings);
      expect(message).toContain(moveCommand);
      expect(existsSync(join(configBase, "my-agent-dojo"))).toBe(false);
      expect(readFileSync(oldSettings, "utf8")).toBe(settingsText);
      expect(existsSync(fixture.stateFolder)).toBe(false);
      expect(existsSync(fixture.sshLog)).toBe(false);
      expect(existsSync(fixture.editorLog)).toBe(false);

      expect(runShell(moveCommand)).toBe(0);
      expect(existsSync(oldSettings)).toBe(false);
      const opened = invokeCli(environment, "open", "example", "--json");
      expect(opened.exitCode).toBe(0);
      expect(parseJson(opened.stdout)).toMatchObject({
        result: { causeCode: "SUCCESS_COMPLETED" },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("open and pending refuse a state folder left at the old place, name the move command, and do not create the new folder", () => {
    const fixture = createFixture();
    try {
      const stateBase = join(fixture.root, ".local", "state");
      const oldState = join(stateBase, "doorway");
      const newParent = join(stateBase, "my-agent-dojo");
      const newState = join(newParent, "doorway");
      const seeded = invokeCli(
        { ...fixture.environment, DOORWAY_STATE: oldState },
        "open",
        "example",
        "--json",
      );
      expect(seeded.exitCode).toBe(0);
      expect(existsSync(oldState)).toBe(true);
      rmSync(fixture.sshLog, { force: true });
      rmSync(fixture.editorLog, { force: true });
      const environment = withoutVariables(
        fixture.environment,
        "DOORWAY_STATE",
      );
      const moveCommand = expectedMoveCommand(oldState, newParent, newState);

      const pendingRefused = invokeCli(environment, "pending", "--json");
      expect(pendingRefused.exitCode).toBe(3);
      expect(parseJson(pendingRefused.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.pending",
          causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          data: null,
        },
      });
      const pendingMessage = messageOf(pendingRefused.stdout);
      expect(pendingMessage).toContain(oldState);
      expect(pendingMessage).toContain(newState);
      expect(pendingMessage).toContain(moveCommand);

      const openRefused = invokeCli(environment, "open", "example", "--json");
      expect(openRefused.exitCode).toBe(3);
      expect(parseJson(openRefused.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          transactionState: "unchanged",
          data: null,
        },
      });
      const openMessage = messageOf(openRefused.stdout);
      expect(openMessage).toContain(oldState);
      expect(openMessage).toContain(newState);
      expect(openMessage).toContain(moveCommand);
      expect(existsSync(newParent)).toBe(false);
      expect(existsSync(fixture.sshLog)).toBe(false);
      expect(existsSync(fixture.editorLog)).toBe(false);

      expect(runShell(moveCommand)).toBe(0);
      expect(existsSync(oldState)).toBe(false);
      const pendingAfterMove = invokeCli(environment, "pending", "--json");
      expect(pendingAfterMove.exitCode).toBe(0);
      expect(parseJson(pendingAfterMove.stdout)).toMatchObject({
        result: {
          causeCode: "SUCCESS_UNCHANGED",
          data: { stateFolder: newState, unfinished: [] },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("DOORWAY_SETTINGS and DOORWAY_STATE win and skip the old-place check, which runs once they are unset", () => {
    const fixture = createFixture();
    try {
      const oldSettings = join(
        fixture.root,
        ".config",
        "doorway",
        "settings.json",
      );
      const oldState = join(fixture.root, ".local", "state", "doorway");
      mkdirSync(join(fixture.root, ".config", "doorway"), { recursive: true });
      writeFileSync(oldSettings, "{broken");
      mkdirSync(oldState, { recursive: true, mode: 0o700 });

      const opened = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(opened.exitCode).toBe(0);
      expect(parseJson(opened.stdout)).toMatchObject({
        result: { causeCode: "SUCCESS_COMPLETED" },
      });
      const pending = invokeCli(fixture.environment, "pending", "--json");
      expect(pending.exitCode).toBe(0);
      expect(parseJson(pending.stdout)).toMatchObject({
        result: {
          causeCode: "SUCCESS_UNCHANGED",
          data: { stateFolder: fixture.stateFolder },
        },
      });

      const noSettingsOverride = invokeCli(
        withoutVariables(fixture.environment, "DOORWAY_SETTINGS"),
        "open",
        "example",
        "--json",
      );
      expect(noSettingsOverride.exitCode).toBe(3);
      expect(parseJson(noSettingsOverride.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING" },
      });
      expect(messageOf(noSettingsOverride.stdout)).toContain(oldSettings);

      const noStateOverride = invokeCli(
        withoutVariables(fixture.environment, "DOORWAY_STATE"),
        "pending",
        "--json",
      );
      expect(noStateOverride.exitCode).toBe(3);
      expect(parseJson(noStateOverride.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE" },
      });
      expect(messageOf(noStateOverride.stdout)).toContain(oldState);
    } finally {
      fixture.cleanup();
    }
  });

  test("uses the new places when old and new both exist, and keeps the missing-settings and empty-pending results when neither exists", () => {
    const both = createFixture();
    const neither = createFixture();
    try {
      const newSettingsFolder = join(
        both.root,
        ".config",
        "my-agent-dojo",
        "doorway",
      );
      const newState = join(
        both.root,
        ".local",
        "state",
        "my-agent-dojo",
        "doorway",
      );
      mkdirSync(newSettingsFolder, { recursive: true });
      writeFileSync(
        join(newSettingsFolder, "settings.json"),
        readFileSync(both.settingsFile, "utf8"),
      );
      mkdirSync(join(both.root, ".config", "doorway"), { recursive: true });
      writeFileSync(
        join(both.root, ".config", "doorway", "settings.json"),
        "{broken",
      );
      mkdirSync(newState, { recursive: true, mode: 0o700 });
      mkdirSync(join(both.root, ".local", "state", "doorway"), {
        recursive: true,
        mode: 0o700,
      });
      const bothEnvironment = withoutVariables(
        both.environment,
        "DOORWAY_SETTINGS",
        "DOORWAY_STATE",
      );

      const opened = invokeCli(bothEnvironment, "open", "example", "--json");
      expect(opened.exitCode).toBe(0);
      expect(parseJson(opened.stdout)).toMatchObject({
        result: { causeCode: "SUCCESS_COMPLETED" },
      });
      const pendingBoth = invokeCli(bothEnvironment, "pending", "--json");
      expect(pendingBoth.exitCode).toBe(0);
      expect(parseJson(pendingBoth.stdout)).toMatchObject({
        result: {
          causeCode: "SUCCESS_UNCHANGED",
          data: { stateFolder: newState, unfinished: [] },
        },
      });

      const neitherEnvironment = withoutVariables(
        neither.environment,
        "DOORWAY_SETTINGS",
        "DOORWAY_STATE",
      );
      const neitherSettings = join(
        neither.root,
        ".config",
        "my-agent-dojo",
        "doorway",
        "settings.json",
      );
      const neitherState = join(
        neither.root,
        ".local",
        "state",
        "my-agent-dojo",
        "doorway",
      );
      const missing = invokeCli(
        neitherEnvironment,
        "open",
        "example",
        "--json",
      );
      expect(missing.exitCode).toBe(3);
      expect(parseJson(missing.stdout)).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING" },
      });
      expect(messageOf(missing.stdout)).toBe(
        `Settings file not found at ${neitherSettings}.`,
      );
      const pendingNeither = invokeCli(neitherEnvironment, "pending", "--json");
      expect(pendingNeither.exitCode).toBe(0);
      expect(parseJson(pendingNeither.stdout)).toMatchObject({
        result: {
          causeCode: "SUCCESS_UNCHANGED",
          data: { stateFolder: neitherState, unfinished: [] },
        },
      });
      expect(existsSync(neitherState)).toBe(false);
    } finally {
      both.cleanup();
      neither.cleanup();
    }
  });

  test("open refuses a state folder left at the old place before it checks settings, whether settings are missing or invalid, and creates nothing", () => {
    const fixture = createFixture();
    try {
      const stateBase = join(fixture.root, ".local", "state");
      const oldState = join(stateBase, "doorway");
      const newParent = join(stateBase, "my-agent-dojo");
      const newState = join(newParent, "doorway");
      const newSettingsFolder = join(
        fixture.root,
        ".config",
        "my-agent-dojo",
        "doorway",
      );
      mkdirSync(oldState, { recursive: true, mode: 0o700 });
      const environment = withoutVariables(
        fixture.environment,
        "DOORWAY_SETTINGS",
        "DOORWAY_STATE",
      );
      const moveCommand = expectedMoveCommand(oldState, newParent, newState);

      const noSettings = invokeCli(environment, "open", "example", "--json");
      expect(noSettings.exitCode).toBe(3);
      expect(parseJson(noSettings.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          transactionState: "unchanged",
          data: null,
        },
      });
      expect(messageOf(noSettings.stdout)).toContain(moveCommand);
      expect(existsSync(newParent)).toBe(false);
      expect(existsSync(newSettingsFolder)).toBe(false);

      mkdirSync(newSettingsFolder, { recursive: true });
      writeFileSync(join(newSettingsFolder, "settings.json"), "{broken");
      const invalidSettings = invokeCli(
        environment,
        "open",
        "example",
        "--json",
      );
      expect(invalidSettings.exitCode).toBe(3);
      expect(parseJson(invalidSettings.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          transactionState: "unchanged",
          data: null,
        },
      });
      expect(messageOf(invalidSettings.stdout)).toContain(moveCommand);
      expect(existsSync(newParent)).toBe(false);
      expect(existsSync(fixture.sshLog)).toBe(false);
      expect(existsSync(fixture.editorLog)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
