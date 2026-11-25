import { changing } from "agent-cli-kernel";
import type {
  ParsedPath,
  ProgramResult,
  ProgramsCapability,
  StateCapability,
} from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import type { Refusal, TransactionResult } from "agent-cli-kernel/addons/state";
import { completedSuccess, nothingChanged } from "./causes.ts";
import {
  buildEditorCall,
  defaultEditorTimeoutMilliseconds,
  destinationInput,
  errorMessage,
  prepareDestination,
  probeHostInventory,
  programOutputLimitBytes,
  programShutdownMilliseconds,
  programStoppedCleanly,
  refusalDetail,
  refusedTransactionResult,
  remoteTimeoutMilliseconds,
  runEditorProgram,
  supersededNote,
} from "./destination-launch.ts";
import type { PreparedDestination } from "./destination-launch.ts";
import { startStations } from "./destination-stations.ts";
import { isolatedProgram } from "./env-program.ts";
import type { DoorwayState } from "./pending.ts";
import {
  isStartableState,
  observeDestination,
  sshArguments,
  startContainerCommand,
} from "./remote.ts";
import type { Environment } from "./settings.ts";

const identity = "doorway.start";

type StartFailureContext = {
  readonly name: string;
  readonly started: boolean;
  readonly effects: {
    readonly completed: readonly string[];
    readonly uncertain: readonly string[];
    readonly inventoryComplete: boolean;
  };
  readonly refusal: Refusal | undefined;
  readonly failureDetail: string;
  readonly startResult: ProgramResult | undefined;
  readonly editorResult: ProgramResult | undefined;
};

type StartPrecheck =
  | {
      readonly ok: true;
      readonly prepared: PreparedDestination;
      readonly needsStart: boolean;
    }
  | {
      readonly ok: false;
      readonly causeCode:
        | "DOMAIN_DOORWAY_STATE_UNAVAILABLE"
        | "DOMAIN_DOORWAY_SETTINGS_MISSING"
        | "DOMAIN_DOORWAY_SETTINGS_INVALID"
        | "DOMAIN_DOORWAY_DESTINATION_UNKNOWN"
        | "DOMAIN_DOORWAY_PLACE_INVALID"
        | "DOMAIN_DOORWAY_START_NOT_ALLOWED"
        | "DOMAIN_DOORWAY_EDITOR_FOLDERS_MISSING"
        | "DOMAIN_DOORWAY_TOOL_UNAVAILABLE"
        | "DOMAIN_DOORWAY_REMOTE_HOST_UNREACHABLE"
        | "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED"
        | "DOMAIN_DOORWAY_DESTINATION_MISSING"
        | "DOMAIN_DOORWAY_DESTINATION_REPLACED"
        | "DOMAIN_DOORWAY_START_STATE_UNSUPPORTED";
      readonly message: string;
    };

function startUnknownDetail(info: StartFailureContext): string {
  if (info.refusal !== undefined) return refusalDetail(info.refusal, "start");
  if (info.failureDetail !== "") return info.failureDetail;
  if (
    info.startResult !== undefined &&
    programDetails(info.startResult)?.timedOut === true
  )
    return "the docker start command timed out";
  if (info.startResult !== undefined && info.startResult.exitCode !== 0)
    return `docker start exited with code ${String(info.startResult.exitCode)}`;
  return "post-start inventory did not confirm the container running";
}

function unconfirmedStartMessage(info: StartFailureContext): string {
  const detail = startUnknownDetail(info);
  const journal = info.effects.inventoryComplete
    ? ""
    : " Doorway state could not confirm its final journal record for this start, so the start may still be unfinished. Run doorway pending to check.";
  return `Could not confirm that destination ${info.name} started (${detail}); the isolated editor did not start.${journal}`;
}

function unconfirmedOpenMessage(info: StartFailureContext): string {
  const detail =
    info.failureDetail !== ""
      ? info.failureDetail
      : info.editorResult !== undefined &&
          programDetails(info.editorResult)?.timedOut === true
        ? "the editor launcher timed out"
        : "";
  const because = detail === "" ? "" : `: ${detail}`;
  const prefix = info.started
    ? `Started ${info.name}, which stays running, but could not confirm that the isolated editor stopped cleanly${because}.`
    : `${info.name} was already running, and doorway could not confirm that the isolated editor stopped cleanly${because}.`;
  const journal = info.effects.inventoryComplete
    ? ""
    : " Doorway state could not confirm its final journal record for this start. Run doorway pending to check.";
  return `${prefix}${journal}`;
}

async function resolveStartTarget(
  environment: Environment,
  input: { readonly destination: string; readonly place?: string | undefined },
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
): Promise<StartPrecheck> {
  const prep = await prepareDestination(environment, input, {
    requireAllowStart: true,
  });
  if (!prep.ok) return prep;
  const { destination, remoteHost, sshExecutable } = prep.prepared;
  const inventory = await probeHostInventory(
    programs,
    sshExecutable,
    parsePath,
    remoteHost,
  );
  if (!inventory.ok) return inventory;
  const observed = observeDestination(destination, inventory.containers);
  if (observed.state === "missing")
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_DESTINATION_MISSING",
      message: `Destination ${destination.name} container ${destination.container} was not found on ${remoteHost.name}.`,
    };
  if (observed.state === "replaced")
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_DESTINATION_REPLACED",
      message: `Destination ${destination.name} container identity on ${remoteHost.name} no longer matches settings.`,
    };
  const needsStart = observed.state === "stopped";
  if (needsStart && !isStartableState(observed.container.state))
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_START_STATE_UNSUPPORTED",
      message: `Destination ${destination.name} is in state ${observed.container.state}; doorway start only starts exited or created containers.`,
    };
  return { ok: true, prepared: prep.prepared, needsStart };
}

type StartExecution = {
  readonly outcome: TransactionResult<"container.start" | "editor.open">;
  readonly startResult: ProgramResult | undefined;
  readonly editorResult: ProgramResult | undefined;
  readonly failureDetail: string;
  readonly place: string;
};

async function executeStartTransaction(options: {
  readonly state: DoorwayState;
  readonly stateCapability: StateCapability<"container.start" | "editor.open">;
  readonly programs: ProgramsCapability;
  readonly signal: AbortSignal;
  readonly prepared: PreparedDestination;
  readonly needsStart: boolean;
  readonly place?: string | undefined;
  readonly parsePath: (value: string) => ParsedPath;
  readonly editorTimeoutMilliseconds: number;
  readonly remoteTimeoutOverride: number;
}): Promise<StartExecution> {
  const { prepared, needsStart, parsePath } = options;
  const { destination, remoteHost, sshExecutable } = prepared;
  const editor = buildEditorCall(prepared, parsePath, options.place);
  const startCall = isolatedProgram(
    parsePath(sshExecutable),
    sshArguments(
      remoteHost,
      startContainerCommand(remoteHost, destination.containerId),
    ),
    parsePath,
  );
  let startConfirmed = false;
  let startResult: ProgramResult | undefined;
  let editorResult: ProgramResult | undefined;
  let failureDetail = "";

  const outcome = await options.state.transaction(
    options.stateCapability,
    {
      command: identity,
      scope: {
        resources: [{ resource: "destination", key: destination.name }],
      },
      facts: {
        destination: destination.name,
        containerId: destination.containerId,
        place: editor.place,
        needsStart,
      },
      supersedeUnresolved: true,
    },
    async (transaction) => {
      await transaction.record(
        "container.start",
        async (effect) => {
          if (!needsStart) return undefined;
          try {
            const ran = await options.programs.domain(effect).start({
              executable: startCall.executable,
              args: startCall.args,
              timeoutMilliseconds: options.remoteTimeoutOverride,
              outputLimitBytes: programOutputLimitBytes,
              shutdownMilliseconds: programShutdownMilliseconds,
            });
            startResult = ran;
            return ran;
          } catch (error) {
            failureDetail = errorMessage(error);
            throw error;
          }
        },
        async (ran) => {
          if (!needsStart) {
            startConfirmed = true;
            return true;
          }
          if (
            options.signal.aborted ||
            ran === undefined ||
            !programStoppedCleanly(ran) ||
            ran.exitCode !== 0
          )
            return false;
          const post = await probeHostInventory(
            options.programs,
            sshExecutable,
            parsePath,
            remoteHost,
            options.remoteTimeoutOverride,
          );
          if (!post.ok) {
            failureDetail = post.message;
            return false;
          }
          startConfirmed =
            observeDestination(destination, post.containers).state ===
            "running";
          return startConfirmed;
        },
      );
      if (!startConfirmed) return;
      await transaction.record(
        "editor.open",
        async (effect) => {
          try {
            const ran = await runEditorProgram(
              options.programs,
              effect,
              editor.call,
              options.editorTimeoutMilliseconds,
            );
            editorResult = ran;
            return ran;
          } catch (error) {
            failureDetail = errorMessage(error);
            throw error;
          }
        },
        (ran) =>
          Promise.resolve(
            !options.signal.aborted && programStoppedCleanly(ran),
          ),
      );
    },
  );

  return {
    outcome,
    startResult,
    editorResult,
    failureDetail,
    place: editor.place,
  };
}

function unknownStartClassification(
  failureInfo: StartFailureContext,
  cleared: string,
) {
  const isEditorUncertain =
    failureInfo.effects.uncertain.includes("editor.open");
  return {
    causeCode: isEditorUncertain
      ? ("DOMAIN_DOORWAY_OPEN_UNCONFIRMED" as const)
      : ("DOMAIN_DOORWAY_START_UNCONFIRMED" as const),
    message: `${isEditorUncertain ? unconfirmedOpenMessage(failureInfo) : unconfirmedStartMessage(failureInfo)}${cleared}`,
    attemptedEffect: isEditorUncertain
      ? ("editor.open" as const)
      : ("container.start" as const),
  };
}

function completedStartSummary(
  destinationName: string,
  place: string,
  needsStart: boolean,
  cleared: string,
): string {
  return needsStart
    ? `Started ${destinationName} and opened ${place} in the isolated editor. Attachment was not verified; closing the editor leaves the container running.${cleared}`
    : `${destinationName} was already running; opened ${place} in the isolated editor. Attachment was not verified; closing the editor leaves the container running.${cleared}`;
}

function openFailedMessage(
  destinationName: string,
  exitCode: number | null,
  needsStart: boolean,
  cleared: string,
): string {
  const prefix = needsStart
    ? `Started ${destinationName}, which stays running, but the isolated editor exited with code ${String(exitCode)}.`
    : `${destinationName} was already running, and the isolated editor exited with code ${String(exitCode)}.`;
  return `${prefix} No unfinished case remains; you can run doorway open or doorway start again.${cleared}`;
}

export function startCommand(
  state: DoorwayState,
  environment: Environment,
  parsePath: (value: string) => ParsedPath,
  editorTimeoutMilliseconds = defaultEditorTimeoutMilliseconds,
  remoteTimeoutOverride = remoteTimeoutMilliseconds,
) {
  return changing({
    identity,
    route: ["start"],
    summary:
      "Start an opted-in stopped destination container by full ID, then open it in the isolated editor.",
    input: destinationInput,
    capabilities: { programs: true },
    effectClass: "external",
    effects: ["container.start", "editor.open"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_DOORWAY_DESTINATION_HELD",
    unresolvedCaseCause: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
    stations: startStations,
    run: async (input, context) => {
      const target = await resolveStartTarget(
        environment,
        input,
        context.programs,
        parsePath,
      );
      if (!target.ok)
        return context.result(
          { commandIdentity: identity, causeCode: target.causeCode },
          { message: target.message, data: null, effects: nothingChanged },
        );

      const { prepared, needsStart } = target;
      const { destination, remoteHost } = prepared;
      const ran = await executeStartTransaction({
        state,
        stateCapability: context.state,
        programs: context.programs,
        signal: context.signal,
        prepared,
        needsStart,
        place: input.place,
        parsePath,
        editorTimeoutMilliseconds,
        remoteTimeoutOverride,
      });

      const { outcome } = ran;
      const cleared = supersededNote(outcome.superseded);
      const failureInfo: StartFailureContext = {
        name: destination.name,
        started: needsStart,
        effects: outcome.proof.effects,
        refusal: outcome.kind === "ran" ? undefined : outcome,
        failureDetail: ran.failureDetail,
        startResult: ran.startResult,
        editorResult: ran.editorResult,
      };

      if (outcome.proof.transactionState === "unknown") {
        const unknown = unknownStartClassification(failureInfo, cleared);
        return context.result(
          { commandIdentity: identity, causeCode: unknown.causeCode },
          {
            message: unknown.message,
            data: null,
            transaction: outcome.proof,
            attemptedEffect: unknown.attemptedEffect,
          },
        );
      }

      const refused = refusedTransactionResult(
        outcome,
        destination.name,
        "doorway start",
        "starting",
        ran.failureDetail,
      );
      if (refused !== undefined)
        return context.result(
          { commandIdentity: identity, causeCode: refused.causeCode },
          { message: refused.message, data: null, effects: refused.effects },
        );

      if (outcome.proof.transactionState === "partially-completed") {
        const prefix = needsStart
          ? `Started ${destination.name}, which stays running, but stopped before launching the isolated editor.`
          : `${destination.name} was already running, but stopped before launching the isolated editor.`;
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_START_PARTIAL",
          },
          {
            message: `${prefix} Run doorway pending to inspect, then run doorway open or doorway start again.${cleared}`,
            data: null,
            transaction: outcome.proof,
          },
        );
      }

      if (
        outcome.proof.transactionState !== "completed" ||
        ran.editorResult === undefined
      )
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_START_UNCONFIRMED",
          },
          {
            message: `${unconfirmedStartMessage(failureInfo)}${cleared}`,
            data: null,
            transaction: outcome.proof,
            attemptedEffect: "container.start",
          },
        );

      if (ran.editorResult.exitCode !== 0)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_OPEN_FAILED",
          },
          {
            message: openFailedMessage(
              destination.name,
              ran.editorResult.exitCode,
              needsStart,
              cleared,
            ),
            data: null,
            transaction: outcome.proof,
            attemptedEffect: "editor.open",
          },
        );

      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: completedStartSummary(
            destination.name,
            ran.place,
            needsStart,
            cleared,
          ),
          data: {
            destination: destination.name,
            remoteHost: remoteHost.name,
            container: destination.container,
            containerId: destination.containerId,
            place: ran.place,
            editor: "isolated-vscode",
            started: needsStart,
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}
