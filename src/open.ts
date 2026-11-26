import { changing, station } from "agent-cli-kernel";
import type { ParsedPath, ProgramResult } from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import type { Refusal } from "agent-cli-kernel/addons/state";
import {
  causes,
  completedSuccess,
  nothingChanged,
  stationWords,
} from "./causes.ts";
import {
  buildEditorCall,
  defaultEditorTimeoutMilliseconds,
  destinationInput,
  errorMessage,
  inspectPending,
  pendingCommandStep,
  prepareDestination,
  probeHostInventory,
  programStoppedCleanly,
  refusalDetail,
  refusedTransactionResult,
  runEditorProgram,
  supersededNote,
} from "./destination-launch.ts";
import { commonDestinationStations } from "./destination-stations.ts";
import type { DoorwayState } from "./pending.ts";
import { destinationState } from "./remote.ts";
import type { Environment } from "./settings.ts";

const identity = "doorway.open";

const destinationHeldHandoff = {
  owner: "operator",
  reason:
    "Another doorway process still holds the lock for this destination. Wait for it to finish or stop, then run doorway open again.",
  inspect: [pendingCommandStep],
} as const;

const destinationUnresolvedHandoff = {
  owner: "operator",
  reason:
    "An earlier unfinished operation for this destination could not be cleared automatically (for example, a torn journal record, a damaged closure, a different command, or an uncovered scope). Inspect doorway pending before deciding how to proceed.",
  inspect: [pendingCommandStep],
} as const;

const openUnconfirmedHandoff = {
  owner: "operator",
  reason:
    "Doorway could not confirm how the open ended. Check doorway pending and any leftover editor launcher; once the earlier run has stopped and the state folder accepts writes, running doorway open again clears an unfinished open.",
  inspect: [pendingCommandStep],
} as const;

type UnknownOpen = {
  readonly name: string;
  readonly effects: {
    readonly completed: readonly string[];
    readonly uncertain: readonly string[];
    readonly inventoryComplete: boolean;
  };
  readonly refusal: Refusal | undefined;
  readonly failureDetail: string;
  readonly editorResult: ProgramResult | undefined;
};

function unknownDetail(open: UnknownOpen): string {
  if (open.refusal !== undefined) return refusalDetail(open.refusal, "open");
  if (open.failureDetail !== "") return open.failureDetail;
  return open.editorResult !== undefined &&
    programDetails(open.editorResult)?.timedOut === true
    ? "the editor launcher timed out"
    : "";
}

function editorSentence(open: UnknownOpen): string {
  const detail = unknownDetail(open);
  const because = detail === "" ? "" : `: ${detail}`;
  if (open.effects.completed.includes("editor.open"))
    return `The isolated editor started and stopped for ${open.name} with exit code ${String(open.editorResult?.exitCode)}.`;
  if (open.effects.uncertain.includes("editor.open"))
    return `Could not confirm that the isolated editor stopped cleanly for ${open.name}${because}.`;
  return `The isolated editor did not start for ${open.name}${because}.`;
}

function unconfirmedMessage(open: UnknownOpen): string {
  const journal = open.effects.inventoryComplete
    ? ""
    : " Doorway state could not confirm its final journal record for this open, so the open may still be unfinished. Run doorway pending to check; once the state folder accepts writes, doorway open clears an unfinished open of this destination.";
  return `${editorSentence(open)}${journal}`;
}

export function openCommand(
  state: DoorwayState,
  environment: Environment,
  parsePath: (value: string) => ParsedPath,
  editorTimeoutMilliseconds = defaultEditorTimeoutMilliseconds,
) {
  return changing({
    identity,
    route: ["open"],
    summary: "Recheck a destination, then open a place in the isolated editor.",
    input: destinationInput,
    capabilities: { programs: true },
    effectClass: "external",
    effects: ["editor.open"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_DOORWAY_DESTINATION_HELD",
    unresolvedCaseCause: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: completedSuccess,
        trigger:
          "The destination is running with its pinned container identity and the isolated editor stopped cleanly with exit 0.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${identity}:opened`,
      }),
      ...commonDestinationStations(identity, "doorway open"),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_DESTINATION_STOPPED",
        trigger: "The destination container is stopped.",
        repairAction:
          "Start the destination explicitly before opening it; doorway open never starts a stopped container.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Start the stopped container first, then run doorway open again.",
          },
        },
        independentObservable: `${identity}:destination-stopped`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_DESTINATION_HELD",
        trigger:
          "Another doorway process still holds the lock for this destination.",
        repairAction:
          "Wait for the running doorway operation to finish or stop; once the earlier run is gone, running doorway open again clears any unfinished open.",
        guidance: { handoff: destinationHeldHandoff },
        independentObservable: `${identity}:destination-held`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
        trigger:
          "An earlier unfinished operation for this destination could not be cleared automatically (for example, a torn journal record, a damaged closure, a different command, or an uncovered scope).",
        repairAction:
          "Run doorway pending to inspect the unfinished operation. An ordinary killed doorway open clears automatically on the next open once the earlier run is gone; this refusal means the case has a torn journal record, a damaged closure, a different command, or an uncovered scope.",
        guidance: { handoff: destinationUnresolvedHandoff },
        independentObservable: `${identity}:destination-unresolved`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        trigger:
          "The doorway state folder is unavailable, refused coordination, sits on a filesystem that cannot clear unfinished cases, or could not record the operation before starting the isolated editor.",
        repairAction:
          "Inspect the state folder (DOORWAY_STATE, or the default place inside my-agent-dojo), including filesystem support and owner lease readability, before running doorway open again.",
        guidance: { handoff: inspectPending },
        independentObservable: `${identity}:state-unavailable`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_OPEN_FAILED",
        trigger:
          "The isolated editor exited non-zero and stopped cleanly; no unfinished case remains.",
        repairAction:
          "Inspect why the isolated editor exited non-zero, then run doorway open again.",
        guidance: {
          handoff: {
            owner: "operator",
            reason:
              "The isolated editor exited non-zero after stopping cleanly; no unfinished case remains.",
            inspect: [
              {
                kind: "instruction",
                text: "Check the isolated editor output and run doorway open again.",
              },
              pendingCommandStep,
            ],
          },
        },
        independentObservable: `${identity}:open-failed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
        trigger:
          "Doorway could not confirm how the open ended: the isolated editor stop was not confirmed, or doorway state could not confirm a journal record for the open before or after the editor ran.",
        repairAction:
          "Run doorway pending to see whether this open is still unfinished, and check whether an isolated editor launcher is still running. Once no earlier run is running and the state folder accepts writes, run doorway open again; it clears an unfinished open of this destination and launches the editor again.",
        guidance: { handoff: openUnconfirmedHandoff },
        independentObservable: `${identity}:open-unconfirmed`,
      }),
    ],
    run: async (input, context) => {
      const prep = await prepareDestination(environment, input);
      if (!prep.ok && prep.causeCode !== "DOMAIN_DOORWAY_START_NOT_ALLOWED")
        return context.result(
          { commandIdentity: identity, causeCode: prep.causeCode },
          { message: prep.message, data: null, effects: nothingChanged },
        );
      if (!prep.ok)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          },
          { message: prep.message, data: null, effects: nothingChanged },
        );

      const { destination, remoteHost, sshExecutable } = prep.prepared;
      const inventory = await probeHostInventory(
        context.programs,
        sshExecutable,
        parsePath,
        remoteHost,
      );
      if (!inventory.ok)
        return context.result(
          { commandIdentity: identity, causeCode: inventory.causeCode },
          { message: inventory.message, data: null, effects: nothingChanged },
        );

      const currentState = destinationState(destination, inventory.containers);
      if (currentState === "missing")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_DESTINATION_MISSING",
          },
          {
            message: `Destination ${destination.name} container ${destination.container} was not found on ${remoteHost.name}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (currentState === "replaced")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_DESTINATION_REPLACED",
          },
          {
            message: `Destination ${destination.name} container identity on ${remoteHost.name} no longer matches settings.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (currentState === "stopped")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_DESTINATION_STOPPED",
          },
          {
            message: `Destination ${destination.name} is stopped; doorway open never starts a stopped container.`,
            data: null,
            effects: nothingChanged,
          },
        );

      const editor = buildEditorCall(prep.prepared, parsePath, input.place);
      let editorResult: ProgramResult | undefined;
      let failureDetail = "";
      const outcome = await state.transaction(
        context.state,
        {
          command: identity,
          scope: {
            resources: [{ resource: "destination", key: destination.name }],
          },
          facts: {
            destination: destination.name,
            containerId: destination.containerId,
            place: editor.place,
          },
          supersedeUnresolved: true,
        },
        async (transaction) => {
          try {
            await transaction.record(
              "editor.open",
              async (effect) => {
                try {
                  const ran = await runEditorProgram(
                    context.programs,
                    effect,
                    editor.call,
                    editorTimeoutMilliseconds,
                  );
                  editorResult = ran;
                  return ran;
                } catch (error) {
                  failureDetail = errorMessage(error);
                  throw error;
                }
              },
              (ran) => Promise.resolve(programStoppedCleanly(ran)),
            );
          } catch (error) {
            if (failureDetail === "") failureDetail = errorMessage(error);
            throw error;
          }
        },
      );

      const cleared = supersededNote(outcome.superseded);
      const unconfirmed = () =>
        context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
          },
          {
            message: `${unconfirmedMessage({
              name: destination.name,
              effects: outcome.proof.effects,
              refusal: outcome.kind === "ran" ? undefined : outcome,
              failureDetail,
              editorResult,
            })}${cleared}`,
            data: null,
            transaction: outcome.proof,
            attemptedEffect: "editor.open",
          },
        );
      if (outcome.proof.transactionState === "unknown") return unconfirmed();

      const refused = refusedTransactionResult(
        outcome,
        destination.name,
        "doorway open",
        "starting the isolated editor",
        failureDetail,
      );
      if (refused !== undefined)
        return context.result(
          { commandIdentity: identity, causeCode: refused.causeCode },
          {
            message: refused.message,
            data: null,
            effects: refused.effects,
          },
        );

      if (
        outcome.proof.transactionState !== "completed" ||
        editorResult === undefined
      )
        return unconfirmed();

      if (editorResult.exitCode !== 0)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_OPEN_FAILED",
          },
          {
            message: `The isolated editor exited with code ${String(editorResult.exitCode)} for ${destination.name}. No unfinished case remains; you can run doorway open again.${cleared}`,
            data: null,
            transaction: outcome.proof,
            attemptedEffect: "editor.open",
          },
        );

      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: `Opened ${destination.name} at ${editor.place} in the isolated editor. Attachment was not verified; closing the editor leaves the container running.${cleared}`,
          data: {
            destination: destination.name,
            remoteHost: remoteHost.name,
            container: destination.container,
            containerId: destination.containerId,
            place: editor.place,
            editor: "isolated-vscode",
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}
