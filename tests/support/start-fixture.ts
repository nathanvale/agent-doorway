import { expect } from "bun:test";
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
  ProgramResult,
  ProgramsCapability,
  RunAddon,
} from "agent-cli-kernel";
import type {
  DestinationSettings,
  DoorwaySettings,
  RemoteHostSettings,
} from "../../src/settings.ts";
import { journalFaultPreload } from "./journal-faults.ts";
import { testFolder } from "./test-folder.ts";

const cliEntry = join(import.meta.dir, "../../src/cli.ts");
export const pinnedId =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const replacedId =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const sampleHost: RemoteHostSettings = {
  name: "lab",
  label: "Lab machine",
  sshAlias: "lab-ssh",
  dockerEndpoint: "unix:///run/docker.sock",
  dockerPath: "/bin/docker",
};

export const expectedStartCommand = `'/bin/docker' '--host' 'unix:///run/docker.sock' 'start' '${pinnedId}'`;
export const expectedPsCommand =
  "'/bin/docker' '--host' 'unix:///run/docker.sock' 'ps' '--all' '--no-trunc' '--format' '{{.ID}} {{.Names}} {{.State}}'";

const forbiddenDockerVerbs = new Set([
  "create",
  "pull",
  "rebuild",
  "build",
  "restart",
  "stop",
  "rm",
  "remove",
]);

export type RecordedCall = {
  readonly argv: readonly string[];
  readonly hasVscodeIpc: boolean;
  readonly sshAuthSockLength: number;
};

function makeScript(pathValue: string, lines: readonly string[]): string {
  writeFileSync(pathValue, [`#!${process.execPath}`, ...lines, ""].join("\n"));
  chmodSync(pathValue, 0o755);
  return pathValue;
}

function parseRecordedCall(line: string): RecordedCall {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Expected recorded call object.");
  const rawArgv: unknown = Reflect.get(parsed, "argv");
  const rawIpc: unknown = Reflect.get(parsed, "hasVscodeIpc");
  const rawSock: unknown = Reflect.get(parsed, "sshAuthSockLength");
  if (
    !Array.isArray(rawArgv) ||
    !rawArgv.every((item) => typeof item === "string") ||
    typeof rawIpc !== "boolean" ||
    typeof rawSock !== "number"
  )
    throw new Error("Invalid recorded call shape.");
  return {
    argv: rawArgv,
    hasVscodeIpc: rawIpc,
    sshAuthSockLength: rawSock,
  };
}

export function readCalls(logPath: string): readonly RecordedCall[] {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf8").trim();
  if (raw === "") return [];
  return raw.split("\n").map(parseRecordedCall);
}

export function assertRemoteCommands(
  calls: readonly RecordedCall[],
  expectedCommands: readonly string[],
) {
  expect(calls.map((call) => call.argv.at(-1))).toEqual([...expectedCommands]);
  for (const call of calls) {
    const remoteCommand = call.argv.at(-1) ?? "";
    const parts = remoteCommand.split(" ");
    const verb = (parts[3] ?? "").replaceAll("'", "");
    expect(forbiddenDockerVerbs.has(verb)).toBe(false);
    expect(["ps", "start"]).toContain(verb);
  }
}

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
      timeout: 20_000,
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

export function runJson(
  environment: Record<string, string>,
  expectedExit: number,
  ...argv: readonly string[]
): unknown {
  const ran = invokeCli(environment, ...argv, "--json");
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
    exitCode: expectedExit,
    stderr: "",
  });
  return JSON.parse(ran.stdout);
}

export function spawnCliAsync(
  environment: Record<string, string>,
  ...argv: readonly string[]
) {
  return Bun.spawn([process.execPath, "run", cliEntry, ...argv], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function waitForExitOrKill(
  child: ReturnType<typeof spawnCliAsync>,
  timeoutMs = 15_000,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<number>((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(`Timed out waiting for child PID ${String(child.pid)}.`),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function invokeCliWithJournalFaults(
  root: string,
  environment: Record<string, string>,
  faults: string,
  ...argv: readonly string[]
) {
  const preload = join(root, "journal-faults.ts");
  writeFileSync(preload, [...journalFaultPreload, ""].join("\n"));
  return spawnCli(
    ["run", "--preload", preload],
    { ...environment, DOORWAY_TEST_JOURNAL_FAULTS: faults },
    argv,
  );
}

export function waitForFile(
  filePath: string,
  timeoutMs = 10_000,
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
    }, timeoutMs);
  });
}

function captureDomainTimeout(
  start: () => Promise<ProgramResult>,
  expectedDelay: number,
) {
  const realSetTimeout = globalThis.setTimeout;
  let fireTimeout: (() => void) | undefined;
  const intercepted = (
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ): ReturnType<typeof realSetTimeout> => {
    if (
      fireTimeout === undefined &&
      typeof callback === "function" &&
      delay === expectedDelay
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
  Reflect.set(intercepted, "__promisify__", realSetTimeout.__promisify__);
  Reflect.set(globalThis, "setTimeout", intercepted);
  try {
    return { pending: start(), fireTimeout };
  } finally {
    Reflect.set(globalThis, "setTimeout", realSetTimeout);
  }
}

export function gateDomainTimeoutOnReadyFile(
  base: RunAddon<ProgramsCapability>,
  readyFile: string,
): RunAddon<ProgramsCapability> {
  return {
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
                if (fireTimeout === undefined)
                  throw new Error("Expected domain timeout to arm.");
                return waitForFile(readyFile).then(() => {
                  fireTimeout();
                  return pending;
                });
              },
            };
          },
        },
      };
    },
  };
}

export type StartFixtureOptions = {
  readonly allowStart?: boolean;
  readonly psOutputs: readonly string[];
  readonly psExits?: readonly number[];
  readonly startExit?: number;
  readonly startHang?: boolean;
  readonly startWaitForRelease?: boolean;
  readonly editorExit?: number;
  readonly editorSignal?: NodeJS.Signals;
  readonly createEditorFolders?: boolean;
  readonly editorToolPath?: string;
};

export function createStartFixture(options: StartFixtureOptions) {
  const root = testFolder("doorway-start-");
  const sshLog = join(root, "ssh-calls.jsonl");
  const editorLog = join(root, "editor-calls.jsonl");
  const startReadyFile = join(root, "start-ready");
  const startReleaseFile = join(root, "start-release");
  const psCounter = join(root, "ps-count.txt");
  const userDataFolder = join(root, "editor-user-data");
  const extensionsFolder = join(root, "editor-extensions");
  if (options.createEditorFolders !== false) {
    mkdirSync(userDataFolder, { recursive: true });
    mkdirSync(extensionsFolder, { recursive: true });
  }
  const fakeSsh = makeScript(join(root, "fake-ssh"), [
    'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
    "const argv = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({`,
    "  argv,",
    "  hasVscodeIpc: Object.hasOwn(process.env, 'VSCODE_IPC_HOOK_CLI'),",
    "  sshAuthSockLength: Object.hasOwn(process.env, 'SSH_AUTH_SOCK') ? (process.env.SSH_AUTH_SOCK ?? '').length : -1,",
    "}) + '\\n');",
    "const remote = argv.at(-1) ?? '';",
    "if (remote.includes(\"'start'\")) {",
    ...(options.startHang === true
      ? [
          `  writeFileSync(${JSON.stringify(startReadyFile)}, "ready");`,
          "  setInterval(() => {}, 60_000);",
          "  await new Promise(() => {});",
        ]
      : options.startWaitForRelease === true
        ? [
            `  writeFileSync(${JSON.stringify(startReadyFile)}, String(process.pid));`,
            `  if (!existsSync(${JSON.stringify(startReleaseFile)})) {`,
            "    await new Promise((resolve, reject) => {",
            "      const interval = setInterval(() => {",
            `        if (existsSync(${JSON.stringify(startReleaseFile)})) {`,
            "          clearInterval(interval);",
            "          clearTimeout(timer);",
            "          resolve(undefined);",
            "        }",
            "      }, 20);",
            "      const timer = setTimeout(() => {",
            "        clearInterval(interval);",
            '        reject(new Error("Timed out waiting for start release file."));',
            "      }, 15_000);",
            "    });",
            "  }",
            `  process.exit(${String(options.startExit ?? 0)});`,
          ]
        : [`  process.exit(${String(options.startExit ?? 0)});`]),
    "}",
    `const psOutputs = ${JSON.stringify(options.psOutputs)};`,
    `const psExits = ${JSON.stringify(options.psExits ?? [])};`,
    `const idx = existsSync(${JSON.stringify(psCounter)}) ? Number(readFileSync(${JSON.stringify(psCounter)}, "utf8")) : 0;`,
    `writeFileSync(${JSON.stringify(psCounter)}, String(idx + 1));`,
    "const exitCode = psExits[idx] ?? 0;",
    "if (exitCode !== 0) process.exit(exitCode);",
    "const out = psOutputs[Math.min(idx, psOutputs.length - 1)] ?? '';",
    "process.stdout.write(out);",
    "process.exit(0);",
  ]);
  const fakeEditor = makeScript(join(root, "fake-editor"), [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(editorLog)}, JSON.stringify({`,
    "  argv: process.argv.slice(2),",
    "  hasVscodeIpc: Object.hasOwn(process.env, 'VSCODE_IPC_HOOK_CLI'),",
    "  sshAuthSockLength: Object.hasOwn(process.env, 'SSH_AUTH_SOCK') ? (process.env.SSH_AUTH_SOCK ?? '').length : -1,",
    "}) + '\\n');",
    ...(options.editorSignal !== undefined
      ? [`process.kill(process.pid, ${JSON.stringify(options.editorSignal)});`]
      : [`process.exit(${String(options.editorExit ?? 0)});`]),
  ]);
  const destination: DestinationSettings = {
    name: "pilot",
    label: "Pilot container",
    remoteHost: "lab",
    container: "pilot-box",
    containerId: pinnedId,
    folder: "/workspace",
    guide: "/workspace/GUIDE.md",
    ...(options.allowStart === undefined
      ? {}
      : { allowStart: options.allowStart }),
  };
  const settings: DoorwaySettings = {
    version: 1,
    editor: { userDataFolder, extensionsFolder },
    remoteHosts: [sampleHost],
    destinations: [destination],
    tools: {
      ssh: fakeSsh,
      editor: options.editorToolPath ?? fakeEditor,
    },
  };
  const settingsFile = join(root, "settings.json");
  const stateFolder = join(root, "state");
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
    sshLog,
    editorLog,
    startReadyFile,
    startReleaseFile,
    settingsFile,
    stateFolder,
    environment,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
