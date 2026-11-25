import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DestinationSettings,
  DoorwaySettings,
  RemoteHostSettings,
} from "../src/settings.ts";
import {
  assertRemoteCommands,
  expectedPsCommand,
  expectedStartCommand,
  pinnedId,
  readCalls,
  replacedId,
  runJson,
} from "./support/start-fixture.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const sampleHost: RemoteHostSettings = {
  name: "lab",
  label: "Lab machine",
  sshAlias: "lab-ssh",
  dockerEndpoint: "unix:///run/docker.sock",
  dockerPath: "/bin/docker",
};

const secondaryHost: RemoteHostSettings = {
  name: "studio",
  label: "Studio machine",
  sshAlias: "studio-ssh",
  dockerEndpoint: "unix:///var/run/docker.sock",
  dockerPath: "/bin/docker",
};

const secondHostId = "8".repeat(64);
const runningId = "1".repeat(64);
const paddingLine = `${"c".repeat(64)} ${"p".repeat(120)} running\n`;

function makeScript(pathValue: string, lines: readonly string[]): string {
  writeFileSync(pathValue, [`#!${process.execPath}`, ...lines, ""].join("\n"));
  chmodSync(pathValue, 0o755);
  return pathValue;
}

function createTruncatedInventoryFixture(options: {
  readonly firstLine: string;
  readonly allowStart?: boolean;
  readonly truncateOnSecondPs?: boolean;
}) {
  const root = testFolder("doorway-truncated-inventory-");
  const sshLog = join(root, "ssh-calls.jsonl");
  const editorLog = join(root, "editor-calls.jsonl");
  const psCounter = join(root, "ps-count.txt");
  const userDataFolder = join(root, "editor-user-data");
  const extensionsFolder = join(root, "editor-extensions");
  mkdirSync(userDataFolder, { recursive: true });
  mkdirSync(extensionsFolder, { recursive: true });

  const fakeSsh = makeScript(join(root, "fake-ssh"), [
    'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
    "const argv = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({`,
    "  argv,",
    "  hasVscodeIpc: Object.hasOwn(process.env, 'VSCODE_IPC_HOOK_CLI'),",
    "  sshAuthSockLength: Object.hasOwn(process.env, 'SSH_AUTH_SOCK') ? (process.env.SSH_AUTH_SOCK ?? '').length : -1,",
    "}) + '\\n');",
    "const remote = argv.at(-1) ?? '';",
    "if (remote.includes(\"'start'\")) process.exit(0);",
    ...(options.truncateOnSecondPs === true
      ? [
          `const idx = existsSync(${JSON.stringify(psCounter)}) ? Number(readFileSync(${JSON.stringify(psCounter)}, "utf8")) : 0;`,
          `writeFileSync(${JSON.stringify(psCounter)}, String(idx + 1));`,
          "if (idx === 0) {",
          `  await Bun.write(Bun.stdout, ${JSON.stringify(options.firstLine)});`,
          "  process.exit(0);",
          "}",
          `await Bun.write(Bun.stdout, ${JSON.stringify(`${pinnedId} pilot-box running\n`)} + ${JSON.stringify(paddingLine)}.repeat(5500));`,
        ]
      : [
          `await Bun.write(Bun.stdout, ${JSON.stringify(options.firstLine)} + ${JSON.stringify(paddingLine)}.repeat(5500));`,
        ]),
    "process.exit(0);",
  ]);

  const fakeEditor = makeScript(join(root, "fake-editor"), [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(editorLog)}, JSON.stringify({`,
    "  argv: process.argv.slice(2),",
    "  hasVscodeIpc: Object.hasOwn(process.env, 'VSCODE_IPC_HOOK_CLI'),",
    "  sshAuthSockLength: Object.hasOwn(process.env, 'SSH_AUTH_SOCK') ? (process.env.SSH_AUTH_SOCK ?? '').length : -1,",
    "}) + '\\n');",
    "process.exit(0);",
  ]);

  const settings: DoorwaySettings = {
    version: 1,
    editor: { userDataFolder, extensionsFolder },
    remoteHosts: [sampleHost],
    destinations: [
      {
        name: "pilot",
        label: "Pilot container",
        remoteHost: "lab",
        container: "pilot-box",
        containerId: pinnedId,
        folder: "/workspace",
        ...(options.allowStart === undefined
          ? {}
          : { allowStart: options.allowStart }),
      },
    ],
    tools: {
      ssh: fakeSsh,
      editor: fakeEditor,
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
    sshLog,
    editorLog,
    environment,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createListInventoryFixture(options: {
  readonly remoteHosts: readonly RemoteHostSettings[];
  readonly destinations: readonly DestinationSettings[];
  readonly sshLines: readonly string[];
}) {
  const root = testFolder("doorway-list-hardening-");
  const fakeSsh = makeScript(join(root, "fake-ssh"), options.sshLines);
  const settingsFile = join(root, "settings.json");
  const settings: DoorwaySettings = {
    version: 1,
    editor: {
      userDataFolder: join(root, "missing-editor-data"),
      extensionsFolder: join(root, "missing-editor-extensions"),
    },
    remoteHosts: options.remoteHosts,
    destinations: options.destinations,
    tools: {
      editor: join(root, "missing-editor-binary"),
      ssh: fakeSsh,
    },
  };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  const environment: Record<string, string> = {
    HOME: root,
    PATH: process.env.PATH ?? "",
    DOORWAY_SETTINGS: settingsFile,
    DOORWAY_STATE: join(root, "state-never-created"),
    VSCODE_IPC_HOOK_CLI: "dummy-ipc-hook",
    SSH_AUTH_SOCK: "dummy-auth-sock",
  };
  return {
    environment,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const truncatedMessage =
  "Docker inventory output from remote host lab was truncated at the output limit.";

describe("truncated remote inventory", () => {
  test("doorway list marks a truncated host failed and still lists another host", () => {
    const fixture = createListInventoryFixture({
      remoteHosts: [sampleHost, secondaryHost],
      destinations: [
        {
          name: "alpha",
          label: "Alpha",
          remoteHost: "lab",
          container: "alpha-box",
          containerId: runningId,
          folder: "/workspace",
        },
        {
          name: "studio-app",
          label: "Studio app",
          remoteHost: "studio",
          container: "studio-box",
          containerId: secondHostId,
          folder: "/workspace",
        },
      ],
      sshLines: [
        "const alias = process.argv.slice(2).at(-2);",
        'if (alias === "lab-ssh") {',
        `  await Bun.write(Bun.stdout, ${JSON.stringify(`${runningId} alpha-box running\n`)} + ${JSON.stringify(paddingLine)}.repeat(5500));`,
        "  process.exit(0);",
        "}",
        `process.stdout.write(${JSON.stringify(`${secondHostId} studio-box running\n`)});`,
      ],
    });
    try {
      expect(runJson(fixture.environment, 0, "list")).toMatchObject({
        result: {
          commandIdentity: "doorway.list",
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            view: "configured",
            hosts: [
              {
                name: "lab",
                status: "command-failed",
                rejectedRows: 0,
                error: truncatedMessage,
              },
              {
                name: "studio",
                status: "ok",
                rejectedRows: 0,
                error: null,
              },
            ],
            rows: [
              {
                kind: "destination",
                destination: "alpha",
                remoteHost: "lab",
                state: "command-failed",
                containerId: null,
                reason: truncatedMessage,
              },
              {
                kind: "destination",
                destination: "studio-app",
                remoteHost: "studio",
                state: "running",
                containerId: secondHostId,
              },
            ],
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("doorway list --all shows a pinned container as inspect-only when its configured name resolves elsewhere", () => {
    const fixture = createListInventoryFixture({
      remoteHosts: [sampleHost],
      destinations: [
        {
          name: "alpha",
          label: "Alpha",
          remoteHost: "lab",
          container: "alpha-box",
          containerId: runningId,
          folder: "/workspace",
        },
        {
          name: "gamma",
          label: "Gamma",
          remoteHost: "lab",
          container: "gamma-box",
          containerId: pinnedId,
          folder: "/workspace",
        },
      ],
      sshLines: [
        `process.stdout.write(${JSON.stringify(
          [
            `${runningId} alpha-box running`,
            `${replacedId} gamma-box running`,
            `${pinnedId} gamma-box-pinned exited`,
            "",
          ].join("\n"),
        )});`,
      ],
    });
    try {
      expect(runJson(fixture.environment, 0, "list", "--all")).toMatchObject({
        result: {
          commandIdentity: "doorway.list",
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            view: "all",
            rows: [
              {
                kind: "destination",
                destination: "alpha",
                container: "alpha-box",
                containerId: runningId,
                state: "running",
                inspectOnly: false,
              },
              {
                kind: "destination",
                destination: "gamma",
                container: "gamma-box",
                containerId: replacedId,
                state: "replaced",
                inspectOnly: false,
              },
              {
                kind: "unconfigured",
                destination: null,
                label: null,
                remoteHost: "lab",
                container: "gamma-box-pinned",
                containerId: pinnedId,
                state: "stopped",
                inspectOnly: true,
                allowStart: false,
              },
            ],
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });
  test("doorway open refuses DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED naming truncation and starts no editor", () => {
    const fixture = createTruncatedInventoryFixture({
      firstLine: `${pinnedId} pilot-box running\n`,
    });
    try {
      expect(runJson(fixture.environment, 3, "open", "pilot")).toMatchObject({
        message: truncatedMessage,
        result: {
          commandIdentity: "doorway.open",
          causeCode: "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED",
          outcome: "refused",
          transactionState: "unchanged",
          data: null,
        },
      });
      assertRemoteCommands(readCalls(fixture.sshLog), [expectedPsCommand]);
      expect(readCalls(fixture.editorLog)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("doorway start refuses DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED naming truncation without running docker start or editor", () => {
    const fixture = createTruncatedInventoryFixture({
      firstLine: `${pinnedId} pilot-box exited\n`,
      allowStart: true,
    });
    try {
      expect(runJson(fixture.environment, 3, "start", "pilot")).toMatchObject({
        message: truncatedMessage,
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED",
          outcome: "refused",
          transactionState: "unchanged",
          data: null,
        },
      });
      assertRemoteCommands(readCalls(fixture.sshLog), [expectedPsCommand]);
      expect(readCalls(fixture.editorLog)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("doorway start treats truncated post-start read-back as unconfirmed and does not open the editor", () => {
    const fixture = createTruncatedInventoryFixture({
      firstLine: `${pinnedId} pilot-box exited\n`,
      allowStart: true,
      truncateOnSecondPs: true,
    });
    try {
      const envelope = runJson(fixture.environment, 3, "start", "pilot");
      expect(envelope).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_START_UNCONFIRMED",
          outcome: "failed",
          transactionState: "unknown",
          effects: {
            completed: [],
            remaining: ["editor.open"],
            uncertain: ["container.start"],
          },
          data: null,
        },
      });
      const message: unknown =
        typeof envelope === "object" && envelope !== null
          ? Reflect.get(envelope, "message")
          : undefined;
      expect(typeof message === "string" ? message : "").toContain("truncated");
      assertRemoteCommands(readCalls(fixture.sshLog), [
        expectedPsCommand,
        expectedStartCommand,
        expectedPsCommand,
      ]);
      expect(readCalls(fixture.editorLog)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
