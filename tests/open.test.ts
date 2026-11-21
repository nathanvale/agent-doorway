import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
): Promise<void> {
  if (existsSync(filePath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (existsSync(filePath)) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      }
    }, 20);
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for ${filePath}.`));
    }, timeoutMilliseconds);
  });
}

type FixtureOptions = {
  readonly sshLines?: readonly string[];
  readonly editorLines?: readonly string[];
  readonly createEditorFolders?: boolean;
  readonly destination?: Partial<DestinationSettings>;
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
    destinations: [{ ...sampleDestination, ...options.destination }],
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

function invokeCli(
  environment: Record<string, string>,
  ...argv: readonly string[]
) {
  const ran = Bun.spawnSync([process.execPath, "run", cliEntry, ...argv], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
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

  test("refuses a concurrent open with held-lock and blocks after a killed open until inspected with pending", async () => {
    const fixture = createFixture();
    try {
      const readyFile = join(fixture.root, "editor-ready");
      const releaseFile = join(fixture.root, "editor-release");
      makeScript(fixture.fakeEditor, [
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
        const held = invokeCli(
          fixture.environment,
          "open",
          "example",
          "--json",
        );
        expect(held.exitCode).toBe(3);
        expect(parseJson(held.stdout)).toMatchObject({
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
      } finally {
        writeFileSync(releaseFile, "go");
        await first.exited;
      }
      expect(first.exitCode).toBe(0);

      rmSync(readyFile, { force: true });
      rmSync(releaseFile, { force: true });

      const killed = Bun.spawn(
        [process.execPath, "run", cliEntry, "open", "example", "--json"],
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

      const blocked = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(blocked.exitCode).toBe(3);
      expect(parseJson(blocked.stdout)).toMatchObject({
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

  test("ends failed and unknown when a hanging editor launcher traps SIGTERM and exits 0 after timeout, leaving an unresolved case for pending", async () => {
    const fixture = createFixture();
    try {
      const sigtermFile = join(fixture.root, "editor-sigterm");
      makeScript(fixture.fakeEditor, [
        'import { writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => {',
        `  writeFileSync(${JSON.stringify(sigtermFile)}, "trapped");`,
        "  process.exit(0);",
        "});",
        "setTimeout(() => {",
        "  process.exit(1);",
        "}, 10_000);",
      ]);

      const doorway = createDoorway(
        fixture.environment,
        ["state", "programs"],
        2_000,
      );
      const ran = await runInProcess(
        doorway.contract,
        doorway.setup,
      )(["open", "example", "--json"]);
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
          inspect: [{ kind: "command", command: "doorway.pending", args: [] }],
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

      const blocked = invokeCli(
        fixture.environment,
        "open",
        "example",
        "--json",
      );
      expect(blocked.exitCode).toBe(3);
      expect(parseJson(blocked.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.open",
          outcome: "refused",
          transactionState: "unchanged",
          causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

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

  test("refuses with a declared state station when the state journal cannot append effect-started before starting the editor", async () => {
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
          pendingCommand(realState, fixture.stateFolder),
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
        outcome: "refused",
        transactionState: "unchanged",
        causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        data: null,
        effects: {
          completed: [],
          remaining: ["editor.open"],
          uncertain: [],
          inventoryComplete: true,
        },
        handoff: {
          owner: "operator",
          inspect: [{ kind: "command", command: "doorway.pending", args: [] }],
        },
      });
      expect(existsSync(fixture.editorLog)).toBe(false);
    } finally {
      if (eventsFile !== undefined && existsSync(eventsFile)) {
        chmodSync(eventsFile, 0o600);
      }
      fixture.cleanup();
    }
  });
});
