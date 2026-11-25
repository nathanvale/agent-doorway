import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  asObject,
  expandHome,
  hasOnlyKeys,
  homeOf,
  ownField,
  parseSettings,
  settingsPath,
} from "../src/settings.ts";
import type { DoorwaySettings, Environment } from "../src/settings.ts";

type TranslationResult =
  | { readonly ok: true; readonly settings: DoorwaySettings }
  | { readonly ok: false; readonly reason: string };

const topLevelKeys = [
  "version",
  "editor",
  "hosts",
  "targets",
  "tools",
] as const;
const editorKeys = ["userDataDir", "extensionsDir"] as const;
const hostKeys = [
  "id",
  "label",
  "sshAlias",
  "dockerHost",
  "dockerPath",
] as const;
const targetKeys = [
  "id",
  "label",
  "role",
  "host",
  "container",
  "containerId",
  "workspaceFolder",
  "guide",
  "board",
  "serviceLog",
  "restore",
  "allowStart",
] as const;
const toolKeys = [
  "code",
  "fzf",
  "opener",
  "pilotRuntime",
  "ps",
  "route",
  "ssh",
] as const;

function translateEditor(value: unknown): object | undefined {
  const record = asObject(value);
  if (record === undefined || !hasOnlyKeys(record, editorKeys))
    return undefined;
  return {
    userDataFolder: ownField(record, "userDataDir"),
    extensionsFolder: ownField(record, "extensionsDir"),
  };
}

function translateHost(value: unknown): object | undefined {
  const record = asObject(value);
  if (record === undefined || !hasOnlyKeys(record, hostKeys)) return undefined;
  return {
    name: ownField(record, "id"),
    label: ownField(record, "label"),
    sshAlias: ownField(record, "sshAlias"),
    dockerEndpoint: ownField(record, "dockerHost"),
    dockerPath: ownField(record, "dockerPath"),
  };
}

function translateTarget(value: unknown): object | undefined {
  const record = asObject(value);
  if (record === undefined || !hasOnlyKeys(record, targetKeys))
    return undefined;
  const guide = ownField(record, "guide");
  const allowStart = ownField(record, "allowStart");
  return {
    name: ownField(record, "id"),
    label: ownField(record, "label"),
    remoteHost: ownField(record, "host"),
    container: ownField(record, "container"),
    containerId: ownField(record, "containerId"),
    folder: ownField(record, "workspaceFolder"),
    ...(guide === undefined ? {} : { guide }),
    ...(allowStart === undefined ? {} : { allowStart }),
  };
}

function translateTools(value: unknown): object | null | undefined {
  if (value === undefined) return null;
  const record = asObject(value);
  if (record === undefined || !hasOnlyKeys(record, toolKeys)) return undefined;
  const editor = ownField(record, "code");
  const ssh = ownField(record, "ssh");
  if (editor === undefined && ssh === undefined) return null;
  return {
    ...(editor === undefined ? {} : { editor }),
    ...(ssh === undefined ? {} : { ssh }),
  };
}

function mapList(
  value: unknown,
  mapper: (item: unknown) => object | undefined,
): readonly object[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: object[] = [];
  for (const item of value) {
    const mapped = mapper(item);
    if (mapped === undefined) return undefined;
    result.push(mapped);
  }
  return result;
}

function translateRemoteDevTargets(raw: unknown): TranslationResult {
  const record = asObject(raw);
  if (record === undefined || !hasOnlyKeys(record, topLevelKeys))
    return { ok: false, reason: "Source targets file has unexpected keys." };
  const editor = translateEditor(ownField(record, "editor"));
  const remoteHosts = mapList(ownField(record, "hosts"), translateHost);
  const destinations = mapList(ownField(record, "targets"), translateTarget);
  const tools = translateTools(ownField(record, "tools"));
  if (
    editor === undefined ||
    remoteHosts === undefined ||
    destinations === undefined ||
    tools === undefined
  )
    return {
      ok: false,
      reason: "Source targets file has invalid structure or unknown fields.",
    };
  const candidate = {
    version: ownField(record, "version"),
    editor,
    remoteHosts,
    destinations,
    ...(tools === null ? {} : { tools }),
  };
  const checked = parseSettings(candidate);
  if (checked.kind !== "ok")
    return {
      ok: false,
      reason:
        checked.kind === "invalid"
          ? checked.reason
          : "Translated settings could not be validated.",
    };
  return { ok: true, settings: checked.settings };
}

function remoteDevConfigPath(environment: Environment): string | undefined {
  const explicit = environment.REMOTE_DEV_CONFIG;
  if (explicit !== undefined && explicit !== "") {
    const expanded = expandHome(explicit, homeOf(environment));
    return expanded !== undefined && isAbsolute(expanded)
      ? expanded
      : undefined;
  }
  const xdg = environment.XDG_CONFIG_HOME;
  if (xdg !== undefined && isAbsolute(xdg))
    return join(xdg, "remote-dev", "targets.json");
  const home = homeOf(environment);
  return home === undefined
    ? undefined
    : join(home, ".config", "remote-dev", "targets.json");
}

function readSourceJson(
  sourceFile: string,
):
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly reason: string } {
  let text: string;
  try {
    text = readFileSync(sourceFile, "utf8");
  } catch {
    return {
      ok: false,
      reason: `Source targets file is unreadable: ${sourceFile}.`,
    };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      reason: `Source targets file is invalid JSON: ${sourceFile}.`,
    };
  }
}

function runBootstrap(
  environment: Environment,
  argv: readonly string[],
): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return {
      exitCode: 0,
      stdout:
        "Usage: bun scripts/bootstrap-settings.ts  (translates $REMOTE_DEV_CONFIG or XDG remote-dev/targets.json once into doorway settings.json)\n",
      stderr: "",
    };
  }
  if (argv.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "Unexpected arguments. Run: bun scripts/bootstrap-settings.ts --help\n",
    };
  }
  const destinationFile = settingsPath(environment);
  if (destinationFile === undefined || !isAbsolute(destinationFile)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "Cannot determine an absolute doorway settings path from DOORWAY_SETTINGS, XDG_CONFIG_HOME, or HOME.\n",
    };
  }
  if (existsSync(destinationFile)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Refusing to overwrite doorway settings: ${destinationFile} already exists.\n`,
    };
  }
  const sourceFile = remoteDevConfigPath(environment);
  if (sourceFile === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "Cannot determine an absolute remote-dev targets path from REMOTE_DEV_CONFIG, XDG_CONFIG_HOME, or HOME.\n",
    };
  }
  if (!existsSync(sourceFile)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Remote-dev targets file not found at ${sourceFile}.\n`,
    };
  }
  const parsed = readSourceJson(sourceFile);
  if (!parsed.ok) {
    return { exitCode: 1, stdout: "", stderr: `${parsed.reason}\n` };
  }
  const translated = translateRemoteDevTargets(parsed.data);
  if (!translated.ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Remote-dev targets file at ${sourceFile} is invalid: ${translated.reason}\n`,
    };
  }
  mkdirSync(dirname(destinationFile), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      destinationFile,
      `${JSON.stringify(translated.settings, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Refusing to overwrite doorway settings: ${destinationFile} already exists or cannot be written.\n`,
    };
  }
  return {
    exitCode: 0,
    stdout: `Wrote doorway settings to ${destinationFile} from ${sourceFile}.\n`,
    stderr: "",
  };
}

if (import.meta.main) {
  const outcome = runBootstrap(process.env, process.argv.slice(2));
  if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
  if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
  process.exitCode = outcome.exitCode;
}
