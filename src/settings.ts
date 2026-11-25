import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { readSettingsJson } from "./settings-file.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

export type EditorSettings = {
  readonly userDataFolder: string;
  readonly extensionsFolder: string;
};

export type RemoteHostSettings = {
  readonly name: string;
  readonly label: string;
  readonly sshAlias: string;
  readonly dockerEndpoint: string;
  readonly dockerPath: string;
};

export type DestinationSettings = {
  readonly name: string;
  readonly label: string;
  readonly remoteHost: string;
  readonly container: string;
  readonly containerId: string;
  readonly folder: string;
  readonly guide?: string;
  readonly wholeWorkspaceFile?: string;
  readonly placeFolders?: readonly string[];
  readonly allowStart?: boolean;
};

export type ToolsSettings = {
  readonly editor?: string;
  readonly ssh?: string;
};

export type DoorwaySettings = {
  readonly version: 1;
  readonly editor: EditorSettings;
  readonly remoteHosts: readonly RemoteHostSettings[];
  readonly destinations: readonly DestinationSettings[];
  readonly tools?: ToolsSettings;
};

export type SettingsLoad =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "ok"; readonly settings: DoorwaySettings };

export type ResolvedDestination = {
  readonly destination: DestinationSettings;
  readonly remoteHost: RemoteHostSettings;
};

export type DoorwayTool = "editor" | "ssh";

const safeNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const safeRemotePathPattern = /^\/[A-Za-z0-9_./-]{0,511}$/;
const safeLocalPathPattern = /^(?:~\/|\/)[A-Za-z0-9 _./()-]{1,511}$/;
const safeDockerEndpointPattern = /^unix:\/\/\/[A-Za-z0-9_./-]{1,255}$/;
const containerIdPattern = /^[0-9a-f]{64}$/;
const noControlPattern = /^[^\p{Cc}]+$/u;

const defaultTools: Readonly<Record<DoorwayTool, string>> = {
  editor:
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  ssh: join("/", "usr", "bin", "ssh"),
};

function hasSafeSegments(pathValue: string): boolean {
  if (pathValue.includes("//")) return false;
  const segments = pathValue.split("/");
  return !segments.includes("..") && !segments.includes(".");
}

export function isSafeRemotePath(value: string): boolean {
  return safeRemotePathPattern.test(value) && hasSafeSegments(value);
}

function isSafeLocalPath(value: string): boolean {
  if (!safeLocalPathPattern.test(value)) return false;
  const body = value.startsWith("~/") ? value.slice(1) : value;
  return hasSafeSegments(body);
}

function isSafeDockerEndpoint(value: string): boolean {
  if (!safeDockerEndpointPattern.test(value)) return false;
  return isSafeRemotePath(value.slice("unix://".length));
}

function absolutePath(value: string | undefined): string | undefined {
  return value !== undefined && isAbsolute(value) ? value : undefined;
}

export function homeOf(environment: Environment): string | undefined {
  return absolutePath(environment.HOME) ?? absolutePath(homedir());
}

export function expandHome(
  pathValue: string,
  home: string | undefined,
): string | undefined {
  if (!pathValue.startsWith("~/")) return pathValue;
  return home === undefined ? undefined : join(home, pathValue.slice(2));
}

const dojoDoorway = ["my-agent-dojo", "doorway"] as const;

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function xdgBase(
  environment: Environment,
  kind: "config" | "state",
): string | undefined {
  const value =
    kind === "config"
      ? environment.XDG_CONFIG_HOME
      : environment.XDG_STATE_HOME;
  const xdg = absolutePath(value);
  if (xdg !== undefined) return xdg;
  const home = homeOf(environment);
  if (home === undefined) return undefined;
  return kind === "config"
    ? join(home, ".config")
    : join(home, ".local", "state");
}

export function settingsPath(environment: Environment): string | undefined {
  const override = nonEmpty(environment.DOORWAY_SETTINGS);
  if (override !== undefined) return expandHome(override, homeOf(environment));
  const base = xdgBase(environment, "config");
  return base === undefined
    ? undefined
    : join(base, ...dojoDoorway, "settings.json");
}

export function statePath(environment: Environment): string | undefined {
  const override = nonEmpty(environment.DOORWAY_STATE);
  if (override !== undefined) return expandHome(override, homeOf(environment));
  const base = xdgBase(environment, "state");
  return base === undefined ? undefined : join(base, ...dojoDoorway);
}

function singleQuoted(pathValue: string): string {
  return `'${pathValue.replaceAll("'", "'\\''")}'`;
}

function oldPlaceMessage(
  subject: "settings file" | "state folder",
  oldPath: string,
  newPath: string,
): string | undefined {
  if (existsSync(newPath) || !existsSync(oldPath)) return undefined;
  const move = `mkdir -p ${singleQuoted(dirname(newPath))} && mv ${singleQuoted(oldPath)} ${singleQuoted(newPath)}`;
  return `The doorway ${subject} is at its old place ${oldPath}. Doorway now uses ${newPath} and does not read or move the old one. Move it, then run doorway again: ${move}`;
}

export function oldSettingsMessage(env: Environment): string | undefined {
  if (nonEmpty(env.DOORWAY_SETTINGS) !== undefined) return undefined;
  const base = xdgBase(env, "config");
  if (base === undefined) return undefined;
  return oldPlaceMessage(
    "settings file",
    join(base, "doorway", "settings.json"),
    join(base, ...dojoDoorway, "settings.json"),
  );
}

export function oldStateMessage(env: Environment): string | undefined {
  if (nonEmpty(env.DOORWAY_STATE) !== undefined) return undefined;
  const base = xdgBase(env, "state");
  if (base === undefined) return undefined;
  return oldPlaceMessage(
    "state folder",
    join(base, "doorway"),
    join(base, ...dojoDoorway),
  );
}

export function unavailableStateMessage(
  environment: Environment,
  resolvedStateFolder: string | undefined = statePath(environment),
): string | undefined {
  if (resolvedStateFolder === undefined)
    return "Doorway cannot determine an absolute state folder because neither XDG_STATE_HOME nor HOME is an absolute path.";
  return oldStateMessage(environment);
}

export function toolPath(
  settings: DoorwaySettings,
  tool: DoorwayTool,
  home: string | undefined,
): string | undefined {
  const override = settings.tools?.[tool];
  if (override === undefined) return defaultTools[tool];
  return expandHome(override, home);
}

export function findDestination(
  settings: DoorwaySettings,
  name: string,
): ResolvedDestination | undefined {
  const destination = settings.destinations.find(
    (candidate) => candidate.name === name,
  );
  if (destination === undefined) return undefined;
  const remoteHost = settings.remoteHosts.find(
    (candidate) => candidate.name === destination.remoteHost,
  );
  if (remoteHost === undefined) return undefined;
  return { destination, remoteHost };
}

export function asObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

export function ownField(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? Reflect.get(record, key) : undefined;
}

export function hasOnlyKeys(
  record: object,
  allowed: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function safeName(value: unknown): string | undefined {
  return typeof value === "string" && safeNamePattern.test(value)
    ? value
    : undefined;
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 80 &&
    noControlPattern.test(value)
    ? value
    : undefined;
}

function safeLocal(value: unknown): string | undefined {
  return typeof value === "string" && isSafeLocalPath(value)
    ? value
    : undefined;
}

function safeRemote(value: unknown): string | undefined {
  return typeof value === "string" && isSafeRemotePath(value)
    ? value
    : undefined;
}

function parseEditor(value: unknown): EditorSettings | undefined {
  const record = asObject(value);
  if (
    record === undefined ||
    !hasOnlyKeys(record, ["userDataFolder", "extensionsFolder"])
  )
    return undefined;
  const userDataFolder = safeLocal(ownField(record, "userDataFolder"));
  const extensionsFolder = safeLocal(ownField(record, "extensionsFolder"));
  if (userDataFolder === undefined || extensionsFolder === undefined)
    return undefined;
  return { userDataFolder, extensionsFolder };
}

function parseTools(value: unknown): ToolsSettings | undefined {
  const record = asObject(value);
  if (record === undefined || !hasOnlyKeys(record, ["editor", "ssh"]))
    return undefined;
  const rawEditor = ownField(record, "editor");
  const rawSsh = ownField(record, "ssh");
  const editor = rawEditor === undefined ? undefined : safeLocal(rawEditor);
  const ssh = rawSsh === undefined ? undefined : safeLocal(rawSsh);
  if (
    (rawEditor !== undefined && editor === undefined) ||
    (rawSsh !== undefined && ssh === undefined)
  )
    return undefined;
  return {
    ...(editor === undefined ? {} : { editor }),
    ...(ssh === undefined ? {} : { ssh }),
  };
}

function parseRemoteHost(value: unknown): RemoteHostSettings | undefined {
  const record = asObject(value);
  if (
    record === undefined ||
    !hasOnlyKeys(record, [
      "name",
      "label",
      "sshAlias",
      "dockerEndpoint",
      "dockerPath",
    ])
  )
    return undefined;
  const name = safeName(ownField(record, "name"));
  const label = safeLabel(ownField(record, "label"));
  const sshAlias = safeName(ownField(record, "sshAlias"));
  const rawEndpoint = ownField(record, "dockerEndpoint");
  const dockerEndpoint =
    typeof rawEndpoint === "string" && isSafeDockerEndpoint(rawEndpoint)
      ? rawEndpoint
      : undefined;
  const dockerPath = safeRemote(ownField(record, "dockerPath"));
  if (
    name === undefined ||
    label === undefined ||
    sshAlias === undefined ||
    dockerEndpoint === undefined ||
    dockerPath === undefined
  )
    return undefined;
  return { name, label, sshAlias, dockerEndpoint, dockerPath };
}

function parsePlaceFolders(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const folders: string[] = [];
  for (const item of value) {
    const parsed = safeRemote(item);
    if (parsed === undefined) return undefined;
    folders.push(parsed);
  }
  return folders;
}

function parseDestination(value: unknown): DestinationSettings | undefined {
  const record = asObject(value);
  if (
    record === undefined ||
    !hasOnlyKeys(record, [
      "name",
      "label",
      "remoteHost",
      "container",
      "containerId",
      "folder",
      "guide",
      "wholeWorkspaceFile",
      "placeFolders",
      "allowStart",
    ])
  )
    return undefined;
  const name = safeName(ownField(record, "name"));
  const label = safeLabel(ownField(record, "label"));
  const remoteHost = safeName(ownField(record, "remoteHost"));
  const container = safeName(ownField(record, "container"));
  const rawContainerId = ownField(record, "containerId");
  const containerId =
    typeof rawContainerId === "string" &&
    containerIdPattern.test(rawContainerId)
      ? rawContainerId
      : undefined;
  const folder = safeRemote(ownField(record, "folder"));
  const rawGuide = ownField(record, "guide");
  const guide = rawGuide === undefined ? undefined : safeRemote(rawGuide);
  const rawWholeWorkspace = ownField(record, "wholeWorkspaceFile");
  const wholeWorkspaceFile =
    rawWholeWorkspace === undefined ? undefined : safeRemote(rawWholeWorkspace);
  const rawPlaceFolders = ownField(record, "placeFolders");
  const placeFolders =
    rawPlaceFolders === undefined
      ? undefined
      : parsePlaceFolders(rawPlaceFolders);
  const rawAllowStart = ownField(record, "allowStart");
  const allowStart =
    typeof rawAllowStart === "boolean" ? rawAllowStart : undefined;
  if (
    name === undefined ||
    label === undefined ||
    remoteHost === undefined ||
    container === undefined ||
    containerId === undefined ||
    folder === undefined ||
    (rawGuide !== undefined && guide === undefined) ||
    (rawWholeWorkspace !== undefined &&
      (wholeWorkspaceFile === undefined ||
        !wholeWorkspaceFile.endsWith(".code-workspace"))) ||
    (rawPlaceFolders !== undefined && placeFolders === undefined) ||
    (rawAllowStart !== undefined && allowStart === undefined)
  )
    return undefined;
  return {
    name,
    label,
    remoteHost,
    container,
    containerId,
    folder,
    ...(guide === undefined ? {} : { guide }),
    ...(wholeWorkspaceFile === undefined ? {} : { wholeWorkspaceFile }),
    ...(placeFolders === undefined ? {} : { placeFolders }),
    ...(allowStart === undefined ? {} : { allowStart }),
  };
}

export function parseSettings(value: unknown): SettingsLoad {
  const record = asObject(value);
  if (
    record === undefined ||
    !hasOnlyKeys(record, [
      "version",
      "editor",
      "remoteHosts",
      "destinations",
      "tools",
    ])
  )
    return {
      kind: "invalid",
      reason: "Settings must be an object with known keys only.",
    };
  if (ownField(record, "version") !== 1)
    return { kind: "invalid", reason: "Settings version must be 1." };
  const editor = parseEditor(ownField(record, "editor"));
  if (editor === undefined)
    return { kind: "invalid", reason: "Editor folder settings are invalid." };
  const rawTools = ownField(record, "tools");
  const tools = rawTools === undefined ? undefined : parseTools(rawTools);
  if (rawTools !== undefined && tools === undefined)
    return { kind: "invalid", reason: "Tool path settings are invalid." };
  const rawHosts = ownField(record, "remoteHosts");
  if (!Array.isArray(rawHosts) || rawHosts.length < 1 || rawHosts.length > 8)
    return {
      kind: "invalid",
      reason: "Settings must declare between 1 and 8 remote hosts.",
    };
  const remoteHosts: RemoteHostSettings[] = [];
  const hostNames = new Set<string>();
  for (const item of rawHosts) {
    const parsed = parseRemoteHost(item);
    if (parsed === undefined || hostNames.has(parsed.name))
      return {
        kind: "invalid",
        reason: "Remote host entries must be valid and uniquely named.",
      };
    hostNames.add(parsed.name);
    remoteHosts.push(parsed);
  }
  const rawDestinations = ownField(record, "destinations");
  if (!Array.isArray(rawDestinations) || rawDestinations.length > 64)
    return {
      kind: "invalid",
      reason: "Settings must declare at most 64 destinations.",
    };
  const destinations: DestinationSettings[] = [];
  const destinationNames = new Set<string>();
  for (const item of rawDestinations) {
    const parsed = parseDestination(item);
    if (
      parsed === undefined ||
      destinationNames.has(parsed.name) ||
      !hostNames.has(parsed.remoteHost)
    )
      return {
        kind: "invalid",
        reason:
          "Destination entries must be valid, uniquely named, and reference a declared remote host.",
      };
    destinationNames.add(parsed.name);
    destinations.push(parsed);
  }
  return {
    kind: "ok",
    settings: {
      version: 1,
      editor,
      remoteHosts,
      destinations,
      ...(tools === undefined ? {} : { tools }),
    },
  };
}

export function loadSettings(
  pathValue: string,
  root?: string,
): Promise<SettingsLoad> {
  const read = readSettingsJson(pathValue, root);
  if (read.kind !== "json") return Promise.resolve(read);
  return Promise.resolve(parseSettings(read.value));
}
