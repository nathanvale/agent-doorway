import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { settingsLimitBytes } from "../src/settings-file.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const cliEntry = join(import.meta.dir, "../src/cli.ts");
const sampleContainerId =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

function parseEnvelope(stdout: string): {
  readonly causeCode: string;
  readonly commandIdentity: string;
  readonly message: string;
} {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Expected JSON object envelope.");
  const result: unknown = Object.hasOwn(parsed, "result")
    ? Reflect.get(parsed, "result")
    : undefined;
  const message: unknown = Object.hasOwn(parsed, "message")
    ? Reflect.get(parsed, "message")
    : undefined;
  if (typeof result !== "object" || result === null)
    throw new Error("Expected result object in envelope.");
  const causeCode: unknown = Object.hasOwn(result, "causeCode")
    ? Reflect.get(result, "causeCode")
    : undefined;
  const commandIdentity: unknown = Object.hasOwn(result, "commandIdentity")
    ? Reflect.get(result, "commandIdentity")
    : undefined;
  return {
    causeCode: typeof causeCode === "string" ? causeCode : "",
    commandIdentity: typeof commandIdentity === "string" ? commandIdentity : "",
    message: typeof message === "string" ? message : "",
  };
}

function createValidSettingsText(root: string): string {
  const editorData = join(root, "editor-data");
  const editorExt = join(root, "editor-ext");
  mkdirSync(editorData, { recursive: true });
  mkdirSync(editorExt, { recursive: true });
  const fakeSsh = makeScript(join(root, "fake-ssh"), [
    `process.stdout.write(${JSON.stringify(`${sampleContainerId} example-box running\n`)});`,
  ]);
  const fakeEditor = makeScript(join(root, "fake-editor"), [
    "process.exit(0);",
  ]);
  return JSON.stringify({
    version: 1,
    editor: {
      userDataFolder: editorData,
      extensionsFolder: editorExt,
    },
    remoteHosts: [
      {
        name: "lab",
        label: "Lab machine",
        sshAlias: "lab-ssh",
        dockerEndpoint: "unix:///run/docker.sock",
        dockerPath: "/bin/docker",
      },
    ],
    destinations: [
      {
        name: "example",
        label: "Example container",
        remoteHost: "lab",
        container: "example-box",
        containerId: sampleContainerId,
        folder: "/workspace",
      },
    ],
    tools: {
      editor: fakeEditor,
      ssh: fakeSsh,
    },
  });
}

describe("rooted settings reads through doorway CLI", () => {
  test("doorway list and open accept an ordinary settings file", () => {
    const root = testFolder("cli-rooted-ok-");
    try {
      const settingsFile = join(root, "settings.json");
      writeFileSync(settingsFile, createValidSettingsText(root));
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: root,
        DOORWAY_SETTINGS: settingsFile,
        DOORWAY_STATE: join(root, "state"),
      };

      const listed = invokeCli(env, "list", "--json");
      expect({ exitCode: listed.exitCode, stderr: listed.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(parseEnvelope(listed.stdout)).toMatchObject({
        commandIdentity: "doorway.list",
        causeCode: "SUCCESS_UNCHANGED",
      });

      const opened = invokeCli(env, "open", "example", "--json");
      expect({ exitCode: opened.exitCode, stderr: opened.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(parseEnvelope(opened.stdout)).toMatchObject({
        commandIdentity: "doorway.open",
        causeCode: "SUCCESS_COMPLETED",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("doorway list and open refuse a settings file that is a symbolic link", () => {
    const root = testFolder("cli-rooted-symlink-file-");
    try {
      const realDir = join(root, "real");
      mkdirSync(realDir, { recursive: true });
      const realSettings = join(realDir, "settings.json");
      writeFileSync(realSettings, createValidSettingsText(root));

      const xdg = join(root, "xdg");
      const doorwayDir = join(xdg, "my-agent-dojo", "doorway");
      mkdirSync(doorwayDir, { recursive: true });
      symlinkSync(realSettings, join(doorwayDir, "settings.json"));

      const overrideLink = join(root, "override-link.json");
      symlinkSync(realSettings, overrideLink);

      for (const env of [
        {
          PATH: process.env.PATH ?? "",
          HOME: root,
          XDG_CONFIG_HOME: xdg,
          DOORWAY_STATE: join(root, "state"),
        },
        {
          PATH: process.env.PATH ?? "",
          HOME: root,
          DOORWAY_SETTINGS: overrideLink,
          DOORWAY_STATE: join(root, "state"),
        },
      ]) {
        for (const argv of [
          ["list", "--json"],
          ["open", "example", "--json"],
        ]) {
          const ran = invokeCli(env, ...argv);
          expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
            exitCode: 3,
            stderr: "",
          });
          const envelope = parseEnvelope(ran.stdout);
          expect(envelope.causeCode).toBe("DOMAIN_DOORWAY_SETTINGS_INVALID");
          expect(envelope.message).toContain("symbolic link");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("doorway list and open refuse a settings folder that is a symbolic link", () => {
    const root = testFolder("cli-rooted-symlink-dir-");
    try {
      const realDir = join(root, "real");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(
        join(realDir, "settings.json"),
        createValidSettingsText(root),
      );

      const xdg = join(root, "xdg");
      mkdirSync(join(xdg, "my-agent-dojo"), { recursive: true });
      symlinkSync(realDir, join(xdg, "my-agent-dojo", "doorway"));

      const overrideLinkedDir = join(root, "override-linked-dir");
      symlinkSync(realDir, overrideLinkedDir);

      for (const env of [
        {
          PATH: process.env.PATH ?? "",
          HOME: root,
          XDG_CONFIG_HOME: xdg,
          DOORWAY_STATE: join(root, "state"),
        },
        {
          PATH: process.env.PATH ?? "",
          HOME: root,
          DOORWAY_SETTINGS: join(overrideLinkedDir, "settings.json"),
          DOORWAY_STATE: join(root, "state"),
        },
      ]) {
        for (const argv of [
          ["list", "--json"],
          ["open", "example", "--json"],
        ]) {
          const ran = invokeCli(env, ...argv);
          expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
            exitCode: 3,
            stderr: "",
          });
          const envelope = parseEnvelope(ran.stdout);
          expect(envelope.causeCode).toBe("DOMAIN_DOORWAY_SETTINGS_INVALID");
          expect(envelope.message).toContain("linked folder");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("doorway list and open refuse an over-limit settings file and a folder in place of the file", () => {
    const root = testFolder("cli-rooted-limit-dir-");
    try {
      const validText = createValidSettingsText(root);
      const hugeFile = join(root, "huge-settings.json");
      writeFileSync(
        hugeFile,
        `${" ".repeat(settingsLimitBytes + 1 - validText.length)}${validText}`,
      );
      const folderAsFile = join(root, "folder-settings.json");
      mkdirSync(folderAsFile, { recursive: true });

      const cases = [
        { file: hugeFile, expectedFragment: "byte limit" },
        { file: folderAsFile, expectedFragment: "not a regular file" },
      ] as const;

      for (const entry of cases) {
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          HOME: root,
          DOORWAY_SETTINGS: entry.file,
          DOORWAY_STATE: join(root, "state"),
        };
        for (const argv of [
          ["list", "--json"],
          ["open", "example", "--json"],
        ]) {
          const ran = invokeCli(env, ...argv);
          expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
            exitCode: 3,
            stderr: "",
          });
          const envelope = parseEnvelope(ran.stdout);
          expect(envelope.causeCode).toBe("DOMAIN_DOORWAY_SETTINGS_INVALID");
          expect(envelope.message).toContain(entry.expectedFragment);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("doorway list and open preserve DOMAIN_DOORWAY_SETTINGS_MISSING and the old-place move message", () => {
    const root = testFolder("cli-rooted-missing-");
    try {
      const xdg = join(root, "xdg");
      const oldDir = join(xdg, "doorway");
      mkdirSync(oldDir, { recursive: true });
      const oldSettings = join(oldDir, "settings.json");
      writeFileSync(oldSettings, "{}");

      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: root,
        XDG_CONFIG_HOME: xdg,
        DOORWAY_STATE: join(root, "state"),
      };

      for (const argv of [
        ["list", "--json"],
        ["open", "example", "--json"],
      ]) {
        const ran = invokeCli(env, ...argv);
        expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
          exitCode: 3,
          stderr: "",
        });
        const envelope = parseEnvelope(ran.stdout);
        expect(envelope.causeCode).toBe("DOMAIN_DOORWAY_SETTINGS_MISSING");
        expect(envelope.message).toContain(oldSettings);
        expect(envelope.message).toContain("mv ");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
