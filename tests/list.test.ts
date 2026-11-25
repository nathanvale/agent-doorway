import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  DestinationSettings,
  DoorwaySettings,
  RemoteHostSettings,
} from "../src/settings.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const cliEntry = join(import.meta.dir, "../src/cli.ts");
const hexId = (digit: string) => digit.repeat(64);
const runningId = hexId("1");
const stoppedId = hexId("2");
const replacedOldId = hexId("3");
const replacedNewId = hexId("4");
const missingId = hexId("5");
const extraRunningId = hexId("6");
const extraStoppedId = hexId("7");
const secondHostId = hexId("8");

const primaryHost: RemoteHostSettings = {
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

function makeScript(pathValue: string, lines: readonly string[]): string {
  writeFileSync(pathValue, [`#!${process.execPath}`, ...lines, ""].join("\n"));
  chmodSync(pathValue, 0o755);
  return pathValue;
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

function createListFixture(options: {
  readonly remoteHosts?: readonly RemoteHostSettings[];
  readonly destinations?: readonly DestinationSettings[];
  readonly sshLines: readonly string[];
  readonly sshToolOverride?: string;
}) {
  const root = testFolder("doorway-list-");
  const sshLog = join(root, "ssh-calls.jsonl");
  const fakeSsh = makeScript(join(root, "fake-ssh"), [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({`,
    "  argv: process.argv.slice(2),",
    "  hasVscodeIpc: Object.hasOwn(process.env, 'VSCODE_IPC_HOOK_CLI'),",
    "  sshAuthSockLength: Object.hasOwn(process.env, 'SSH_AUTH_SOCK') ? (process.env.SSH_AUTH_SOCK ?? '').length : -1,",
    "}) + '\\n');",
    ...options.sshLines,
  ]);
  const settingsFile = join(root, "settings.json");
  const stateFolder = join(root, "state-never-created");
  const settings: DoorwaySettings = {
    version: 1,
    editor: {
      userDataFolder: join(root, "missing-editor-data"),
      extensionsFolder: join(root, "missing-editor-extensions"),
    },
    remoteHosts: options.remoteHosts ?? [primaryHost],
    destinations: options.destinations ?? [
      {
        name: "alpha",
        label: "Alpha",
        remoteHost: "lab",
        container: "alpha-box",
        containerId: runningId,
        folder: "/workspace",
        allowStart: false,
      },
      {
        name: "beta",
        label: "Beta",
        remoteHost: "lab",
        container: "beta-box",
        containerId: stoppedId,
        folder: "/workspace",
        allowStart: true,
      },
      {
        name: "gamma",
        label: "Gamma",
        remoteHost: "lab",
        container: "gamma-box",
        containerId: replacedOldId,
        folder: "/workspace",
      },
      {
        name: "delta",
        label: "Delta",
        remoteHost: "lab",
        container: "delta-box",
        containerId: missingId,
        folder: "/workspace",
      },
    ],
    tools: {
      editor: join(root, "missing-editor-binary"),
      ssh: options.sshToolOverride ?? fakeSsh,
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
    sshLog,
    settingsFile,
    stateFolder,
    environment,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("doorway list", () => {
  test("reports running, stopped, replaced and missing destinations in settings order without touching state", () => {
    const fixture = createListFixture({
      sshLines: [
        `process.stdout.write(${JSON.stringify(
          [
            `${runningId} alpha-box running`,
            `${stoppedId} beta-box exited`,
            `${replacedNewId} gamma-box running`,
            `${extraRunningId} zebra-infra running`,
            "",
          ].join("\n"),
        )});`,
      ],
    });
    try {
      const jsonRun = invokeCli(fixture.environment, "list", "--json");
      expect({ exitCode: jsonRun.exitCode, stderr: jsonRun.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const parsed: unknown = JSON.parse(jsonRun.stdout);
      expect(parsed).toMatchObject({
        result: {
          commandIdentity: "doorway.list",
          causeCode: "SUCCESS_UNCHANGED",
          outcome: "success",
          transactionState: "unchanged",
          data: {
            view: "configured",
            rejectedRows: 0,
            hosts: [
              {
                name: "lab",
                label: "Lab machine",
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
                container: "alpha-box",
                containerId: runningId,
                state: "running",
                inspectOnly: false,
                allowStart: false,
                reason: null,
              },
              {
                kind: "destination",
                destination: "beta",
                remoteHost: "lab",
                container: "beta-box",
                containerId: stoppedId,
                state: "stopped",
                inspectOnly: false,
                allowStart: true,
              },
              {
                kind: "destination",
                destination: "gamma",
                remoteHost: "lab",
                container: "gamma-box",
                containerId: replacedNewId,
                state: "replaced",
                inspectOnly: false,
              },
              {
                kind: "destination",
                destination: "delta",
                remoteHost: "lab",
                container: "delta-box",
                containerId: null,
                state: "missing",
                inspectOnly: false,
              },
            ],
          },
        },
      });

      const sshCalls: unknown[] = readFileSync(fixture.sshLog, "utf8")
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      const expectedArgv = [
        "-T",
        ...["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"],
        ...["-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no"],
        ...["-o", "ControlMaster=no", "-o", "ControlPath=none"],
        ...["-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes"],
        "--",
        "lab-ssh",
        "'/bin/docker' '--host' 'unix:///run/docker.sock' 'ps' '--all' '--no-trunc' '--format' '{{.ID}} {{.Names}} {{.State}}'",
      ];
      expect(sshCalls).toEqual([
        {
          argv: expectedArgv,
          hasVscodeIpc: false,
          sshAuthSockLength: 0,
        },
      ]);
      expect(existsSync(fixture.stateFolder)).toBe(false);

      const humanRun = invokeCli(fixture.environment, "list");
      expect({ exitCode: humanRun.exitCode, stderr: humanRun.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(humanRun.stdout).toContain("alpha");
      expect(humanRun.stdout).toContain("running");
      expect(humanRun.stdout).toContain("stopped");
      expect(humanRun.stdout).toContain("replaced");
      expect(humanRun.stdout).toContain("missing");
      expect(humanRun.stdout).not.toContain("zebra-infra");
    } finally {
      fixture.cleanup();
    }
  });

  test("list --all appends unconfigured containers marked inspect-only and counts rejected unsafe rows", () => {
    const fixture = createListFixture({
      sshLines: [
        `process.stdout.write(${JSON.stringify(
          [
            `${runningId} alpha-box running`,
            `${stoppedId} beta-box exited`,
            `${replacedNewId} gamma-box running`,
            `${extraRunningId} zeta-box running`,
            `${extraStoppedId} aardvark-box exited`,
            `${extraRunningId} $(touch${" "}pwned) running`,
            `${extraStoppedId} evil\u001b]0;title\u0007 running`,
            "",
          ].join("\n"),
        )});`,
      ],
    });
    try {
      const ran = invokeCli(fixture.environment, "list", "--all", "--json");
      expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(ran.stdout).not.toContain("\u001b");
      expect(ran.stdout).not.toContain("touch");
      const parsed: unknown = JSON.parse(ran.stdout);
      expect(parsed).toMatchObject({
        result: {
          commandIdentity: "doorway.list",
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            view: "all",
            rejectedRows: 2,
            hosts: [
              {
                name: "lab",
                status: "ok",
                rejectedRows: 2,
                error: null,
              },
            ],
            rows: [
              { kind: "destination", destination: "alpha", state: "running" },
              { kind: "destination", destination: "beta", state: "stopped" },
              { kind: "destination", destination: "gamma", state: "replaced" },
              { kind: "destination", destination: "delta", state: "missing" },
              {
                kind: "unconfigured",
                destination: null,
                label: null,
                remoteHost: "lab",
                container: "aardvark-box",
                containerId: extraStoppedId,
                state: "stopped",
                inspectOnly: true,
                allowStart: false,
              },
              {
                kind: "unconfigured",
                destination: null,
                label: null,
                remoteHost: "lab",
                container: "zeta-box",
                containerId: extraRunningId,
                state: "running",
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

  test("an unreachable host is reported per host and does not hide a reachable host", () => {
    const fixture = createListFixture({
      remoteHosts: [primaryHost, secondaryHost],
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
        'if (alias === "lab-ssh") process.exit(255);',
        `process.stdout.write(${JSON.stringify(`${secondHostId} studio-box running\n`)});`,
      ],
    });
    try {
      const ran = invokeCli(fixture.environment, "list", "--json");
      expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const parsed: unknown = JSON.parse(ran.stdout);
      expect(parsed).toMatchObject({
        result: {
          commandIdentity: "doorway.list",
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            view: "configured",
            hosts: [
              {
                name: "lab",
                status: "unreachable",
                rejectedRows: 0,
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
                state: "unreachable",
                containerId: null,
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

  test("refuses missing settings, invalid settings, and unavailable ssh tool before any remote call", () => {
    const root = testFolder("doorway-list-refusals-");
    try {
      const missingEnv: Record<string, string> = {
        HOME: root,
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        DOORWAY_STATE: join(root, "state"),
      };
      const missing = invokeCli(missingEnv, "list", "--json");
      expect({ exitCode: missing.exitCode, stderr: missing.stderr }).toEqual({
        exitCode: 3,
        stderr: "",
      });
      expect(JSON.parse(missing.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.list",
          causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING",
          data: null,
        },
      });

      const invalidFile = join(root, "broken.json");
      writeFileSync(invalidFile, "{not-json");
      const invalid = invokeCli(
        { ...missingEnv, DOORWAY_SETTINGS: invalidFile },
        "list",
        "--json",
      );
      expect({ exitCode: invalid.exitCode, stderr: invalid.stderr }).toEqual({
        exitCode: 3,
        stderr: "",
      });
      expect(JSON.parse(invalid.stdout)).toMatchObject({
        result: {
          commandIdentity: "doorway.list",
          causeCode: "DOMAIN_DOORWAY_SETTINGS_INVALID",
          data: null,
        },
      });

      const fixture = createListFixture({
        sshLines: ["process.exit(0);"],
        sshToolOverride: join(root, "missing-ssh"),
      });
      try {
        const missingTool = invokeCli(fixture.environment, "list", "--json");
        expect({
          exitCode: missingTool.exitCode,
          stderr: missingTool.stderr,
        }).toEqual({ exitCode: 3, stderr: "" });
        expect(JSON.parse(missingTool.stdout)).toMatchObject({
          result: {
            commandIdentity: "doorway.list",
            causeCode: "DOMAIN_DOORWAY_TOOL_UNAVAILABLE",
            data: null,
          },
        });
      } finally {
        fixture.cleanup();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
