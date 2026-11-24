import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  findDestination,
  homeOf,
  isSafeRemotePath,
  loadSettings,
  oldSettingsMessage,
  oldStateMessage,
  settingsPath,
  statePath,
  toolPath,
} from "../src/settings.ts";
import { testFolder } from "./support/test-folder.ts";

const sampleContainerId =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function validSettings(folder: string) {
  return {
    version: 1,
    editor: {
      userDataFolder: join(folder, "editor-data"),
      extensionsFolder: join(folder, "editor-extensions"),
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
        guide: "/workspace/GUIDE.md",
        wholeWorkspaceFile: "/workspace/example.code-workspace",
        placeFolders: ["/workspace", "/repos"],
      },
    ],
  };
}

describe("settings and state paths", () => {
  test("DOORWAY_SETTINGS overrides the default settings path inside my-agent-dojo", () => {
    const folder = testFolder("settings-path-");
    try {
      const override = join(folder, "custom.json");
      expect(
        settingsPath({
          DOORWAY_SETTINGS: override,
          XDG_CONFIG_HOME: join(folder, "xdg"),
          HOME: folder,
        }),
      ).toBe(override);
      expect(
        settingsPath({
          XDG_CONFIG_HOME: join(folder, "xdg"),
          HOME: folder,
        }),
      ).toBe(join(folder, "xdg", "my-agent-dojo", "doorway", "settings.json"));
      expect(settingsPath({ HOME: folder, XDG_CONFIG_HOME: "" })).toBe(
        join(folder, ".config", "my-agent-dojo", "doorway", "settings.json"),
      );
      expect(settingsPath({ HOME: folder })).toBe(
        join(folder, ".config", "my-agent-dojo", "doorway", "settings.json"),
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("DOORWAY_STATE overrides the default state folder inside my-agent-dojo", () => {
    const folder = testFolder("state-path-");
    try {
      const override = join(folder, "custom-state");
      expect(
        statePath({
          DOORWAY_STATE: override,
          XDG_STATE_HOME: join(folder, "xdg-state"),
          HOME: folder,
        }),
      ).toBe(override);
      expect(
        statePath({
          XDG_STATE_HOME: join(folder, "xdg-state"),
          HOME: folder,
        }),
      ).toBe(join(folder, "xdg-state", "my-agent-dojo", "doorway"));
      expect(statePath({ HOME: folder, XDG_STATE_HOME: "" })).toBe(
        join(folder, ".local", "state", "my-agent-dojo", "doorway"),
      );
      expect(statePath({ HOME: folder })).toBe(
        join(folder, ".local", "state", "my-agent-dojo", "doorway"),
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("relative XDG_CONFIG_HOME and XDG_STATE_HOME values are ignored and fall back to HOME defaults", () => {
    const folder = testFolder("xdg-relative-");
    try {
      const expectedSettings = join(
        folder,
        ".config",
        "my-agent-dojo",
        "doorway",
        "settings.json",
      );
      const expectedState = join(
        folder,
        ".local",
        "state",
        "my-agent-dojo",
        "doorway",
      );
      const relativeValues = ["relative/bad", "./rel", "../rel", "~/rel"];

      for (const relativeValue of relativeValues) {
        expect(
          settingsPath({ HOME: folder, XDG_CONFIG_HOME: relativeValue }),
        ).toBe(expectedSettings);
        expect(statePath({ HOME: folder, XDG_STATE_HOME: relativeValue })).toBe(
          expectedState,
        );
      }

      const customSettings = join(folder, "explicit-settings.json");
      const customState = join(folder, "explicit-state");
      expect(
        settingsPath({
          HOME: folder,
          XDG_CONFIG_HOME: "relative/bad",
          DOORWAY_SETTINGS: customSettings,
        }),
      ).toBe(customSettings);
      expect(
        statePath({
          HOME: folder,
          XDG_STATE_HOME: "relative/bad",
          DOORWAY_STATE: customState,
        }),
      ).toBe(customState);

      const legacySettings = join(
        folder,
        ".config",
        "doorway",
        "settings.json",
      );
      const legacyState = join(folder, ".local", "state", "doorway");
      mkdirSync(join(folder, ".config", "doorway"), { recursive: true });
      mkdirSync(legacyState, { recursive: true });
      writeFileSync(legacySettings, "{}");

      expect(
        oldSettingsMessage({ HOME: folder, XDG_CONFIG_HOME: "relative/bad" }),
      ).toContain(legacySettings);
      expect(
        oldStateMessage({ HOME: folder, XDG_STATE_HOME: "relative/bad" }),
      ).toContain(legacyState);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("homeOf falls back to os.homedir when HOME is unset, empty, or relative", () => {
    const folder = testFolder("home-fallback-");
    try {
      const osHome = homedir();
      expect(homeOf({ HOME: folder })).toBe(folder);
      expect(homeOf({})).toBe(osHome);
      expect(homeOf({ HOME: "" })).toBe(osHome);
      expect(homeOf({ HOME: "relative/home" })).toBe(osHome);
      expect(homeOf({ HOME: "./home" })).toBe(osHome);
      expect(homeOf({ HOME: "../home" })).toBe(osHome);
      expect(
        settingsPath({
          HOME: "relative/home",
          XDG_CONFIG_HOME: "relative/bad",
        }),
      ).toBe(
        join(osHome, ".config", "my-agent-dojo", "doorway", "settings.json"),
      );
      expect(
        statePath({ HOME: "relative/home", XDG_STATE_HOME: "relative/bad" }),
      ).toBe(join(osHome, ".local", "state", "my-agent-dojo", "doorway"));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("loading settings and finding destinations", () => {
  test("returns missing when the settings file does not exist", async () => {
    const folder = testFolder("settings-missing-");
    try {
      expect(await loadSettings(join(folder, "absent.json"))).toEqual({
        kind: "missing",
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("loads valid settings and finds a destination by name", async () => {
    const folder = testFolder("settings-valid-");
    try {
      const file = join(folder, "settings.json");
      writeFileSync(file, JSON.stringify(validSettings(folder)));
      const loaded = await loadSettings(file);
      expect(loaded.kind).toBe("ok");
      if (loaded.kind !== "ok") return;
      const found = findDestination(loaded.settings, "example");
      expect(found).toMatchObject({
        destination: {
          name: "example",
          container: "example-box",
          containerId: sampleContainerId,
          folder: "/workspace",
        },
        remoteHost: {
          name: "lab",
          sshAlias: "lab-ssh",
          dockerEndpoint: "unix:///run/docker.sock",
        },
      });
      expect(findDestination(loaded.settings, "devbox")).toBeUndefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("resolves declared tool overrides and expands home paths", async () => {
    const folder = testFolder("settings-tools-");
    try {
      const file = join(folder, "settings.json");
      const raw = {
        ...validSettings(folder),
        tools: {
          editor: "~/bin/fake-editor",
          ssh: join(folder, "fake-ssh"),
        },
      };
      writeFileSync(file, JSON.stringify(raw));
      const loaded = await loadSettings(file);
      expect(loaded.kind).toBe("ok");
      if (loaded.kind !== "ok") return;
      expect(toolPath(loaded.settings, "editor", folder)).toBe(
        join(folder, "bin/fake-editor"),
      );
      expect(toolPath(loaded.settings, "ssh", folder)).toBe(
        join(folder, "fake-ssh"),
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("rejects invalid JSON and broken settings rules", async () => {
    const folder = testFolder("settings-invalid-");
    try {
      const file = join(folder, "settings.json");
      writeFileSync(file, "{not-json");
      expect((await loadSettings(file)).kind).toBe("invalid");

      const base = validSettings(folder);
      const brokenCases: readonly unknown[] = [
        { ...base, version: 2 },
        { ...base, extra: true },
        { ...base, remoteHosts: [] },
        {
          ...base,
          destinations: [
            { ...base.destinations[0], remoteHost: "missing-host" },
          ],
        },
        {
          ...base,
          destinations: [base.destinations[0], base.destinations[0]],
        },
        {
          ...base,
          destinations: [{ ...base.destinations[0], containerId: "short" }],
        },
        {
          ...base,
          destinations: [
            { ...base.destinations[0], folder: "/workspace/../secret" },
          ],
        },
        {
          ...base,
          destinations: [
            {
              ...base.destinations[0],
              wholeWorkspaceFile: "/workspace/not-workspace.json",
            },
          ],
        },
        {
          ...base,
          remoteHosts: [
            { ...base.remoteHosts[0], dockerEndpoint: "tcp://127.0.0.1:2375" },
          ],
        },
        {
          ...base,
          editor: {
            ...base.editor,
            userDataFolder: "relative/folder",
          },
        },
      ];
      for (const candidate of brokenCases) {
        writeFileSync(file, JSON.stringify(candidate));
        expect((await loadSettings(file)).kind).toBe("invalid");
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("isSafeRemotePath rejects climbing paths, relative paths and control characters", () => {
    expect(isSafeRemotePath("/workspace")).toBe(true);
    expect(isSafeRemotePath("/workspace/repos/app.code-workspace")).toBe(true);
    expect(isSafeRemotePath("workspace")).toBe(false);
    expect(isSafeRemotePath("/workspace/../other")).toBe(false);
    expect(isSafeRemotePath("/workspace/./other")).toBe(false);
    expect(isSafeRemotePath("/workspace//other")).toBe(false);
    expect(isSafeRemotePath("/workspace/bad\nname")).toBe(false);
    expect(isSafeRemotePath("/workspace/bad'name")).toBe(false);
  });
});
