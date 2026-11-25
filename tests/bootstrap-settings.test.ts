import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadSettings } from "../src/settings.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const scriptPath = join(import.meta.dir, "../scripts/bootstrap-settings.ts");
const pilotContainerId =
  "568ba4e66e3b13c188cb206f480b2b81310b8275ae7a355280ce250cf3b69e0e";
const devboxContainerId =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function runBootstrap(
  environment: Record<string, string>,
  ...argv: readonly string[]
) {
  const ran = Bun.spawnSync([process.execPath, "run", scriptPath, ...argv], {
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

function sampleTargetsPayload(root: string) {
  return {
    version: 1,
    editor: {
      userDataDir:
        "~/.local/state/remote-devcontainer-isolation/trial-01/user-data",
      extensionsDir:
        "~/.local/state/remote-devcontainer-isolation/trial-01/extensions",
    },
    hosts: [
      {
        id: "mini",
        label: "Mac mini (OrbStack)",
        sshAlias: "mac-mini",
        dockerPath: "/bin/docker",
        dockerHost: "unix:///run/orbstack/docker.sock",
      },
    ],
    targets: [
      {
        id: "pilot",
        label: "Agents pilot",
        role: "ui-pilot",
        host: "mini",
        container: "agents-pilot",
        containerId: pilotContainerId,
        workspaceFolder: "/workspace",
        guide: "/workspace/START-HERE.md",
        board: "https://board.example.test/private-board",
        serviceLog: "/workspace/state/pilot-runtime/service.log",
        restore: {
          kind: "shepherdr-pilot",
          claudeOAuthRef: "op://Private/Pilot/token",
          shepherdrVersion: "1.2.3",
          coreVersion: "2.3.4",
        },
        allowStart: false,
      },
      {
        id: "devbox",
        label: "Dev box",
        role: "development",
        host: "mini",
        container: "devbox-1",
        containerId: devboxContainerId,
        workspaceFolder: "/work",
        allowStart: true,
      },
    ],
    tools: {
      code: join(root, "bin", "code"),
      ssh: join(root, "bin", "ssh"),
      fzf: join(root, "bin", "fzf"),
    },
  };
}

describe("bootstrap-settings script", () => {
  test("translates remote-dev targets into doorway settings under my-agent-dojo and strips private fields", async () => {
    const root = testFolder("bootstrap-ok-");
    try {
      const xdgConfig = join(root, "xdg-config");
      const sourceDir = join(xdgConfig, "remote-dev");
      const sourceFile = join(sourceDir, "targets.json");
      const expectedDestination = join(
        xdgConfig,
        "my-agent-dojo",
        "doorway",
        "settings.json",
      );
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(
        sourceFile,
        JSON.stringify(sampleTargetsPayload(root), null, 2),
      );

      const ran = runBootstrap({
        HOME: root,
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: xdgConfig,
      });

      expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(ran.stdout).toContain(expectedDestination);
      expect(existsSync(expectedDestination)).toBe(true);

      const rawWritten = readFileSync(expectedDestination, "utf8");
      expect(rawWritten).not.toContain("board");
      expect(rawWritten).not.toContain("private-board");
      expect(rawWritten).not.toContain("role");
      expect(rawWritten).not.toContain("ui-pilot");
      expect(rawWritten).not.toContain("serviceLog");
      expect(rawWritten).not.toContain("restore");
      expect(rawWritten).not.toContain("op://");
      expect(rawWritten).not.toContain("fzf");

      const loaded = await loadSettings(expectedDestination);
      expect(loaded).toEqual({
        kind: "ok",
        settings: {
          version: 1,
          editor: {
            userDataFolder:
              "~/.local/state/remote-devcontainer-isolation/trial-01/user-data",
            extensionsFolder:
              "~/.local/state/remote-devcontainer-isolation/trial-01/extensions",
          },
          remoteHosts: [
            {
              name: "mini",
              label: "Mac mini (OrbStack)",
              sshAlias: "mac-mini",
              dockerPath: "/bin/docker",
              dockerEndpoint: "unix:///run/orbstack/docker.sock",
            },
          ],
          destinations: [
            {
              name: "pilot",
              label: "Agents pilot",
              remoteHost: "mini",
              container: "agents-pilot",
              containerId: pilotContainerId,
              folder: "/workspace",
              guide: "/workspace/START-HERE.md",
              allowStart: false,
            },
            {
              name: "devbox",
              label: "Dev box",
              remoteHost: "mini",
              container: "devbox-1",
              containerId: devboxContainerId,
              folder: "/work",
              allowStart: true,
            },
          ],
          tools: {
            editor: join(root, "bin", "code"),
            ssh: join(root, "bin", "ssh"),
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors REMOTE_DEV_CONFIG and DOORWAY_SETTINGS overrides", async () => {
    const root = testFolder("bootstrap-env-");
    try {
      const sourceFile = join(root, "custom-targets.json");
      const destFile = join(root, "custom-doorway", "settings.json");
      const payload = sampleTargetsPayload(root);
      writeFileSync(
        sourceFile,
        JSON.stringify({
          version: payload.version,
          editor: payload.editor,
          hosts: payload.hosts,
          targets: [payload.targets[0]],
        }),
      );

      const ran = runBootstrap({
        HOME: root,
        PATH: process.env.PATH ?? "",
        REMOTE_DEV_CONFIG: sourceFile,
        DOORWAY_SETTINGS: destFile,
      });

      expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const loaded = await loadSettings(destFile);
      expect(loaded.kind).toBe("ok");
      if (loaded.kind !== "ok") return;
      expect(loaded.settings.tools).toBeUndefined();
      expect(loaded.settings.destinations).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses and writes nothing when destination settings file already exists", () => {
    const root = testFolder("bootstrap-exists-");
    try {
      const xdgConfig = join(root, "xdg-config");
      const sourceDir = join(xdgConfig, "remote-dev");
      const destDir = join(xdgConfig, "my-agent-dojo", "doorway");
      const destFile = join(destDir, "settings.json");
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(destDir, { recursive: true });
      writeFileSync(
        join(sourceDir, "targets.json"),
        JSON.stringify(sampleTargetsPayload(root)),
      );
      const sentinel = '{"keep":"me"}\n';
      writeFileSync(destFile, sentinel);

      const ran = runBootstrap({
        HOME: root,
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: xdgConfig,
      });

      expect(ran.exitCode).toBe(1);
      expect(ran.stdout).toBe("");
      expect(ran.stderr).toContain("already exists");
      expect(readFileSync(destFile, "utf8")).toBe(sentinel);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses and writes nothing when source is missing or invalid without leaking private values", () => {
    const root = testFolder("bootstrap-invalid-");
    try {
      const xdgConfig = join(root, "xdg-config");
      const destDir = join(xdgConfig, "my-agent-dojo", "doorway");
      const destFile = join(destDir, "settings.json");

      const missing = runBootstrap({
        HOME: root,
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: xdgConfig,
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toContain("not found");
      expect(existsSync(destDir)).toBe(false);

      const sourceDir = join(xdgConfig, "remote-dev");
      const sourceFile = join(sourceDir, "targets.json");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(sourceFile, "{not-json");

      const badJson = runBootstrap({
        HOME: root,
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: xdgConfig,
      });
      expect(badJson.exitCode).toBe(1);
      expect(badJson.stdout).toBe("");
      expect(badJson.stderr).toContain("invalid");
      expect(existsSync(destFile)).toBe(false);

      const broken = sampleTargetsPayload(root);
      writeFileSync(
        sourceFile,
        JSON.stringify({
          ...broken,
          hosts: [
            {
              ...broken.hosts[0],
              dockerHost: "tcp://127.0.0.1:2375",
            },
          ],
        }),
      );
      const badSchema = runBootstrap({
        HOME: root,
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: xdgConfig,
      });
      expect(badSchema.exitCode).toBe(1);
      expect(badSchema.stdout).toBe("");
      expect(badSchema.stderr).not.toContain("op://");
      expect(badSchema.stderr).not.toContain("private-board");
      expect(existsSync(destFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prints usage on --help without writing anything", () => {
    const root = testFolder("bootstrap-help-");
    try {
      const ran = runBootstrap(
        {
          HOME: root,
          PATH: process.env.PATH ?? "",
          XDG_CONFIG_HOME: join(root, "xdg-config"),
        },
        "--help",
      );
      expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(ran.stdout).toContain("bootstrap-settings.ts");
      expect(existsSync(join(root, "xdg-config"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
