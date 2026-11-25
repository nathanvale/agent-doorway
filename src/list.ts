import { command, station } from "agent-cli-kernel";
import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import {
  causes,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
} from "./causes.ts";
import {
  envExecutablePath,
  executableExists,
  isolatedProgram,
} from "./env-program.ts";
import {
  destinationState,
  inventoryCommand,
  parseInventory,
  sshArguments,
} from "./remote.ts";
import type { DestinationState, ObservedContainer } from "./remote.ts";
import { loadDoorwaySettings } from "./settings-load.ts";
import { homeOf, toolPath } from "./settings.ts";
import type {
  DestinationSettings,
  DoorwaySettings,
  Environment,
  RemoteHostSettings,
} from "./settings.ts";

const identity = "doorway.list";
const remoteTimeoutMilliseconds = 30_000;
const programOutputLimitBytes = 1_048_576;
const programShutdownMilliseconds = 1_000;

type HostInventory =
  | {
      readonly status: "ok";
      readonly name: string;
      readonly label: string;
      readonly containers: readonly ObservedContainer[];
      readonly rejectedRows: number;
      readonly error: null;
    }
  | {
      readonly status: "unreachable" | "command-failed";
      readonly name: string;
      readonly label: string;
      readonly containers: readonly ObservedContainer[];
      readonly rejectedRows: 0;
      readonly error: string;
    };

type ListRowState = DestinationState | "unreachable" | "command-failed";

type ListRow = {
  readonly kind: "destination" | "unconfigured";
  readonly destination: string | null;
  readonly label: string | null;
  readonly remoteHost: string;
  readonly container: string;
  readonly containerId: string | null;
  readonly state: ListRowState;
  readonly inspectOnly: boolean;
  readonly allowStart: boolean;
  readonly reason: string | null;
};

const destinationReason: Readonly<
  Record<Exclude<DestinationState, "running">, string>
> = {
  stopped:
    "Container is stopped and stays stopped; doorway list never starts containers.",
  replaced: "Container identity changed; review before connecting.",
  missing: "Container not found on the remote host; nothing was started.",
};

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function observedContainerFor(
  destination: DestinationSettings,
  containers: readonly ObservedContainer[],
): ObservedContainer | undefined {
  return (
    containers.find((container) =>
      container.names.includes(destination.container),
    ) ??
    containers.find((container) => container.id === destination.containerId)
  );
}

function destinationRow(
  destination: DestinationSettings,
  hostInventory: HostInventory | undefined,
): ListRow {
  if (hostInventory === undefined || hostInventory.status !== "ok") {
    const status = hostInventory?.status ?? "unreachable";
    return {
      kind: "destination",
      destination: destination.name,
      label: destination.label,
      remoteHost: destination.remoteHost,
      container: destination.container,
      containerId: null,
      state: status,
      inspectOnly: false,
      allowStart: destination.allowStart === true,
      reason:
        hostInventory?.error ??
        `Remote host ${destination.remoteHost} could not be reached over SSH.`,
    };
  }
  const state = destinationState(destination, hostInventory.containers);
  const observed = observedContainerFor(destination, hostInventory.containers);
  return {
    kind: "destination",
    destination: destination.name,
    label: destination.label,
    remoteHost: destination.remoteHost,
    container: destination.container,
    containerId: observed?.id ?? null,
    state,
    inspectOnly: false,
    allowStart: destination.allowStart === true,
    reason: state === "running" ? null : destinationReason[state],
  };
}

function unconfiguredRows(
  settings: DoorwaySettings,
  inventories: ReadonlyMap<string, HostInventory>,
): readonly ListRow[] {
  const extra: ListRow[] = [];
  for (const host of settings.remoteHosts) {
    const hostInventory = inventories.get(host.name);
    if (hostInventory === undefined || hostInventory.status !== "ok") continue;
    const configured = settings.destinations.filter(
      (destination) => destination.remoteHost === host.name,
    );
    const knownNames = new Set(configured.map((item) => item.container));
    const knownIds = new Set(configured.map((item) => item.containerId));
    for (const container of hostInventory.containers) {
      if (
        knownIds.has(container.id) ||
        container.names.some((name) => knownNames.has(name))
      )
        continue;
      extra.push({
        kind: "unconfigured",
        destination: null,
        label: null,
        remoteHost: host.name,
        container: container.names[0] ?? container.id.slice(0, 12),
        containerId: container.id,
        state: container.running ? "running" : "stopped",
        inspectOnly: true,
        allowStart: false,
        reason: "Unconfigured container: inspect only.",
      });
    }
  }
  extra.sort(
    (left, right) =>
      compareStrings(left.container, right.container) ||
      compareStrings(left.remoteHost, right.remoteHost) ||
      compareStrings(left.containerId ?? "", right.containerId ?? ""),
  );
  return extra;
}

async function inspectHost(
  programs: ProgramsCapability,
  sshExecutable: ParsedPath,
  parsePath: (value: string) => ParsedPath,
  remoteHost: RemoteHostSettings,
): Promise<HostInventory> {
  const sshCall = isolatedProgram(
    sshExecutable,
    sshArguments(remoteHost, inventoryCommand(remoteHost)),
    parsePath,
  );
  const sshRan = await programs.inspect({
    executable: sshCall.executable,
    args: sshCall.args,
    timeoutMilliseconds: remoteTimeoutMilliseconds,
    outputLimitBytes: programOutputLimitBytes,
    shutdownMilliseconds: programShutdownMilliseconds,
  });
  if (
    programDetails(sshRan)?.timedOut === true ||
    sshRan.exitCode === 255 ||
    sshRan.exitCode === null
  ) {
    return {
      status: "unreachable",
      name: remoteHost.name,
      label: remoteHost.label,
      containers: [],
      rejectedRows: 0,
      error: `Remote host ${remoteHost.name} could not be reached over SSH.`,
    };
  }
  if (sshRan.exitCode !== 0) {
    return {
      status: "command-failed",
      name: remoteHost.name,
      label: remoteHost.label,
      containers: [],
      rejectedRows: 0,
      error: `Docker inventory failed on remote host ${remoteHost.name} with exit code ${String(sshRan.exitCode)}.`,
    };
  }
  const observed = parseInventory(sshRan.stdout);
  return {
    status: "ok",
    name: remoteHost.name,
    label: remoteHost.label,
    containers: observed.containers,
    rejectedRows: observed.rejected,
    error: null,
  };
}

function summaryMessage(
  rows: readonly ListRow[],
  hosts: readonly HostInventory[],
  all: boolean,
): string {
  const failedHosts = hosts.filter((host) => host.status !== "ok").length;
  const hostNote =
    failedHosts === 0
      ? ""
      : ` (${String(failedHosts)} ${failedHosts === 1 ? "host" : "hosts"} failed)`;
  const subject = all
    ? rows.length === 1
      ? "container"
      : "containers"
    : rows.length === 1
      ? "destination"
      : "destinations";
  return `${String(rows.length)} ${subject}${hostNote}; nothing was started.`;
}

export function listCommand(
  environment: Environment,
  parsePath: (value: string) => ParsedPath,
) {
  return command({
    identity,
    route: ["list"],
    summary:
      "List configured destinations and their live state (or every container with --all).",
    input: {
      ...noInput,
      options: [
        {
          name: "--all",
          aliases: [],
          summary:
            "Include unconfigured containers on configured remote hosts (inspect only).",
          required: false,
          repeatable: false,
          value: null,
        },
      ],
    },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: unchangedSuccess,
        trigger:
          "Settings loaded and every configured remote host was probed with the read-only inventory command.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${identity}:listed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING",
        trigger:
          "The doorway settings file does not exist, or a settings file is left only at the old default place outside my-agent-dojo.",
        repairAction:
          "Create the doorway settings file or set DOORWAY_SETTINGS to an existing settings file. When the message names an old settings file, run the move command it gives; doorway never reads or moves the old file itself.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Create the settings file, set DOORWAY_SETTINGS, or run the move command in the message, then run doorway list again.",
          },
        },
        independentObservable: `${identity}:settings-missing`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_SETTINGS_INVALID",
        trigger:
          "The doorway settings file is invalid JSON or fails schema validation.",
        repairAction:
          "Fix the settings file reported in the message, then run doorway list again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair the settings file and run doorway list again.",
          },
        },
        independentObservable: `${identity}:settings-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_TOOL_UNAVAILABLE",
        trigger:
          "A required local program for SSH or env is missing or not executable.",
        repairAction:
          "Install the missing program or update the ssh tools path in doorway settings.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Ensure env and ssh are executable, then run doorway list again.",
          },
        },
        independentObservable: `${identity}:tool-unavailable`,
      }),
    ],
    run: async (input, context) => {
      const loaded = await loadDoorwaySettings(environment);
      if (!loaded.ok)
        return context.result(
          { commandIdentity: identity, causeCode: loaded.causeCode },
          {
            message: loaded.message,
            data: null,
            effects: nothingChanged,
          },
        );

      const sshExecutable = toolPath(
        loaded.settings,
        "ssh",
        homeOf(environment),
      );
      if (
        sshExecutable === undefined ||
        !(await executableExists(envExecutablePath)) ||
        !(await executableExists(sshExecutable))
      )
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_TOOL_UNAVAILABLE",
          },
          {
            message:
              "A required local program (env or ssh) is missing or not executable.",
            data: null,
            effects: nothingChanged,
          },
        );

      const parsedSsh = parsePath(sshExecutable);
      const inventories = new Map<string, HostInventory>();
      const hostList: HostInventory[] = [];
      let rejectedRows = 0;
      for (const remoteHost of loaded.settings.remoteHosts) {
        const observed = await inspectHost(
          context.programs,
          parsedSsh,
          parsePath,
          remoteHost,
        );
        inventories.set(remoteHost.name, observed);
        hostList.push(observed);
        rejectedRows += observed.rejectedRows;
      }

      const all = input["--all"] === true;
      const configuredRows = loaded.settings.destinations.map((destination) =>
        destinationRow(destination, inventories.get(destination.remoteHost)),
      );
      const rows = all
        ? [...configuredRows, ...unconfiguredRows(loaded.settings, inventories)]
        : configuredRows;

      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message: summaryMessage(rows, hostList, all),
          data: {
            view: all ? "all" : "configured",
            hosts: hostList.map((host) => ({
              name: host.name,
              label: host.label,
              status: host.status,
              rejectedRows: host.rejectedRows,
              error: host.error,
            })),
            rejectedRows,
            rows,
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
