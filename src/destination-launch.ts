import { stat } from "node:fs/promises";
import type {
  ParsedPath,
  ProgramResult,
  ProgramsCapability,
  RecordedEffect,
} from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import type { Refusal, TransactionResult } from "agent-cli-kernel/addons/state";
import { noInput, nothingChanged } from "./causes.ts";
import { editorArguments, requiredEditorFolders } from "./editor.ts";
import {
  envExecutablePath,
  executableExists,
  isolatedProgram,
} from "./env-program.ts";
import {
  inventoryCommand,
  readInventoryResult,
  sshArguments,
} from "./remote.ts";
import type { ObservedContainer } from "./remote.ts";
import { loadDoorwaySettings } from "./settings-load.ts";
import {
  findDestination,
  homeOf,
  isSafeRemotePath,
  toolPath,
  unavailableStateMessage,
} from "./settings.ts";
import type {
  DestinationSettings,
  DoorwaySettings,
  Environment,
  RemoteHostSettings,
} from "./settings.ts";

export const remoteTimeoutMilliseconds = 30_000;
export const defaultEditorTimeoutMilliseconds = 60_000;
export const programOutputLimitBytes = 1_048_576;
export const programShutdownMilliseconds = 1_000;

export const pendingCommandStep = {
  kind: "command",
  command: "doorway.pending",
  args: [],
} as const;

export const inspectPending = {
  owner: "operator",
  reason:
    "Inspect doorway pending before deciding how to proceed with this destination.",
  inspect: [pendingCommandStep],
} as const;

export const destinationInput = {
  ...noInput,
  arguments: [
    {
      name: "destination",
      summary: "Name of the destination in settings.",
      required: true,
      value: {
        kind: "string",
        minLength: 1,
        maxLength: 128,
        choices: null,
        pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$",
      },
    },
    {
      name: "place",
      summary:
        "Optional absolute remote path inside the destination; defaults to the destination folder.",
      required: false,
      value: {
        kind: "string",
        minLength: 1,
        maxLength: 512,
        choices: null,
        pattern: null,
      },
    },
  ],
} as const;

export type PreparedDestination = {
  readonly settings: DoorwaySettings;
  readonly destination: DestinationSettings;
  readonly remoteHost: RemoteHostSettings;
  readonly home: string | undefined;
  readonly sshExecutable: string;
  readonly editorExecutable: string;
};

export type PrepareFailureCause =
  | "DOMAIN_DOORWAY_STATE_UNAVAILABLE"
  | "DOMAIN_DOORWAY_SETTINGS_MISSING"
  | "DOMAIN_DOORWAY_SETTINGS_INVALID"
  | "DOMAIN_DOORWAY_DESTINATION_UNKNOWN"
  | "DOMAIN_DOORWAY_PLACE_INVALID"
  | "DOMAIN_DOORWAY_START_NOT_ALLOWED"
  | "DOMAIN_DOORWAY_EDITOR_FOLDERS_MISSING"
  | "DOMAIN_DOORWAY_TOOL_UNAVAILABLE";

export type PrepareDestinationResult =
  | { readonly ok: true; readonly prepared: PreparedDestination }
  | {
      readonly ok: false;
      readonly causeCode: PrepareFailureCause;
      readonly message: string;
    };

export type InventoryProbeResult =
  | { readonly ok: true; readonly containers: readonly ObservedContainer[] }
  | {
      readonly ok: false;
      readonly causeCode:
        | "DOMAIN_DOORWAY_REMOTE_HOST_UNREACHABLE"
        | "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED";
      readonly message: string;
    };

type StateRefusal = {
  readonly causeCode:
    | "DOMAIN_DOORWAY_DESTINATION_HELD"
    | "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED"
    | "DOMAIN_DOORWAY_STATE_UNAVAILABLE";
  readonly message: string;
};

async function foldersExist(paths: readonly string[]): Promise<boolean> {
  for (const folder of paths) {
    const info = await stat(folder).catch(() => null);
    if (info === null || !info.isDirectory()) return false;
  }
  return true;
}

export async function prepareDestination(
  environment: Environment,
  input: { readonly destination: string; readonly place?: string | undefined },
  options: { readonly requireAllowStart?: boolean } = {},
): Promise<PrepareDestinationResult> {
  const stateProblem = unavailableStateMessage(environment);
  if (stateProblem !== undefined)
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
      message: stateProblem,
    };
  const loaded = await loadDoorwaySettings(environment);
  if (!loaded.ok)
    return { ok: false, causeCode: loaded.causeCode, message: loaded.message };
  const found = findDestination(loaded.settings, input.destination);
  if (found === undefined)
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_DESTINATION_UNKNOWN",
      message: `No destination named ${input.destination} is declared in settings.`,
    };
  if (input.place !== undefined && !isSafeRemotePath(input.place))
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_PLACE_INVALID",
      message: `The place ${input.place} is not a safe absolute remote path.`,
    };
  const { destination, remoteHost } = found;
  if (options.requireAllowStart === true && destination.allowStart !== true)
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_START_NOT_ALLOWED",
      message: `Destination ${destination.name} does not allow starting; set allowStart to true in settings to opt in.`,
    };
  const home = homeOf(environment);
  const editorFolders = requiredEditorFolders(loaded.settings, home);
  if (editorFolders === undefined || !(await foldersExist(editorFolders)))
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_EDITOR_FOLDERS_MISSING",
      message:
        "One or more isolated editor folders do not exist on this machine.",
    };
  const sshExecutable = toolPath(loaded.settings, "ssh", home);
  const editorExecutable = toolPath(loaded.settings, "editor", home);
  if (
    sshExecutable === undefined ||
    editorExecutable === undefined ||
    !(await executableExists(envExecutablePath)) ||
    !(await executableExists(sshExecutable)) ||
    !(await executableExists(editorExecutable))
  )
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_TOOL_UNAVAILABLE",
      message:
        "A required local program (env, ssh, or the isolated editor) is missing or not executable.",
    };
  return {
    ok: true,
    prepared: {
      settings: loaded.settings,
      destination,
      remoteHost,
      home,
      sshExecutable,
      editorExecutable,
    },
  };
}

export async function probeHostInventory(
  programs: ProgramsCapability,
  sshExecutable: string,
  parsePath: (value: string) => ParsedPath,
  remoteHost: RemoteHostSettings,
  timeoutMilliseconds = remoteTimeoutMilliseconds,
): Promise<InventoryProbeResult> {
  const sshCall = isolatedProgram(
    parsePath(sshExecutable),
    sshArguments(remoteHost, inventoryCommand(remoteHost)),
    parsePath,
  );
  const sshRan = await programs.inspect({
    executable: sshCall.executable,
    args: sshCall.args,
    timeoutMilliseconds,
    outputLimitBytes: programOutputLimitBytes,
    shutdownMilliseconds: programShutdownMilliseconds,
  });
  const outcome = readInventoryResult(sshRan);
  switch (outcome.status) {
    case "ok":
      return { ok: true, containers: outcome.containers };
    case "timed-out":
    case "unreachable":
      return {
        ok: false,
        causeCode: "DOMAIN_DOORWAY_REMOTE_HOST_UNREACHABLE",
        message: `Remote host ${remoteHost.name} could not be reached over SSH.`,
      };
    case "command-failed":
      return {
        ok: false,
        causeCode: "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED",
        message: `Docker inventory failed on remote host ${remoteHost.name} with exit code ${String(outcome.exitCode)}.`,
      };
    case "truncated":
      return {
        ok: false,
        causeCode: "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED",
        message: `Docker inventory output from remote host ${remoteHost.name} was truncated at the output limit.`,
      };
  }
}

export function buildEditorCall(
  prepared: PreparedDestination,
  parsePath: (value: string) => ParsedPath,
  place?: string,
) {
  const plan = editorArguments(
    prepared.settings,
    prepared.remoteHost,
    prepared.destination,
    prepared.home,
    place,
  );
  const call = isolatedProgram(
    parsePath(prepared.editorExecutable),
    plan.args,
    parsePath,
  );
  return { place: plan.place, call };
}

export function runEditorProgram<Effect extends string>(
  programs: ProgramsCapability,
  effect: RecordedEffect<Effect>,
  call: { readonly executable: ParsedPath; readonly args: readonly string[] },
  timeoutMilliseconds: number,
): Promise<ProgramResult> {
  return programs.domain(effect).start({
    executable: call.executable,
    args: call.args,
    timeoutMilliseconds,
    outputLimitBytes: programOutputLimitBytes,
    shutdownMilliseconds: programShutdownMilliseconds,
  });
}

function stateRefusal(
  outcome: Refusal,
  destinationName: string,
  commandLabel: string,
): StateRefusal {
  switch (outcome.kind) {
    case "held-lock":
      return {
        causeCode: "DOMAIN_DOORWAY_DESTINATION_HELD",
        message: `Destination ${destinationName} is still held by running operation ${outcome.operationId}. Wait for it to finish or stop, then run ${commandLabel} again.`,
      };
    case "unresolved-case":
      return {
        causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
        message: `Destination ${destinationName} has an unfinished operation ${outcome.operationId} that ${commandLabel} cannot clear automatically (for example, a torn journal record, a damaged closure, a different command, or an uncovered scope).`,
      };
    case "unavailable":
      return {
        causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        message: `Doorway state is unavailable: ${outcome.reason}${outcome.detail === undefined ? "" : ` (${outcome.detail})`}.`,
      };
    case "busy":
    case "denied":
    case "approval-lost":
    case "approval-unavailable":
      return {
        causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        message: `Doorway state refused coordination: ${outcome.kind}.`,
      };
  }
}

export function supersededNote(
  superseded: readonly string[] | undefined,
): string {
  if (superseded === undefined || superseded.length === 0) return "";
  const label =
    superseded.length === 1
      ? "earlier unfinished operation"
      : "earlier unfinished operations";
  return ` Cleared ${label}: ${superseded.join(", ")}.`;
}

function refusedSupersededNote(
  superseded: readonly string[] | undefined,
): string {
  const cleared = supersededNote(superseded);
  if (cleared === "") return "";
  return `${cleared} Run doorway pending to inspect.`;
}

export function refusedTransactionResult<Effect extends string>(
  outcome: TransactionResult<Effect>,
  destinationName: string,
  commandLabel: string,
  actionPhrase: string,
  failureDetail: string,
) {
  const clearedOnRefusal = refusedSupersededNote(outcome.superseded);
  if (outcome.kind !== "ran") {
    const refused = stateRefusal(outcome, destinationName, commandLabel);
    return {
      causeCode: refused.causeCode,
      message: `${refused.message}${clearedOnRefusal}`,
      effects:
        outcome.proof.transactionState === "unchanged"
          ? outcome.proof.effects
          : nothingChanged,
    };
  }
  if (outcome.proof.transactionState === "unchanged")
    return {
      causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE" as const,
      message: `Doorway state could not record ${destinationName} before ${actionPhrase}${failureDetail === "" ? "" : `: ${failureDetail}`}.${clearedOnRefusal}`,
      effects: outcome.proof.effects,
    };
  return undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function refusalDetail(refusal: Refusal, noun: string): string {
  const about =
    refusal.kind === "unavailable"
      ? `, ${refusal.reason}`
      : refusal.kind === "held-lock" || refusal.kind === "unresolved-case"
        ? `, ${refusal.operationId}`
        : "";
  return `doorway state refused the ${noun} (${refusal.kind}${about})`;
}

export function programStoppedCleanly(result: ProgramResult): boolean {
  const details = programDetails(result);
  return (
    result.terminationConfirmed &&
    details !== undefined &&
    !details.timedOut &&
    result.exitCode !== null
  );
}
