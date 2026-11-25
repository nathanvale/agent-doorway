import { command, station } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import {
  causes,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
} from "./causes.ts";
import { unavailableStateMessage } from "./settings.ts";
import type { Environment } from "./settings.ts";

export type DoorwayState = ReturnType<typeof stateAddon>;

const identity = "doorway.pending";

export function pendingCommand(
  state: DoorwayState,
  stateFolder: string | undefined,
  environment: Environment,
) {
  return command({
    identity,
    route: ["pending"],
    summary: "List unfinished doorway operations recorded in the state folder.",
    input: noInput,
    capabilities: {},
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: unchangedSuccess,
        trigger: "The doorway state folder was read or does not exist yet.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "An unfinished doorway open or start clears on the next open or start for that destination once the earlier run has stopped. A live run still refuses as held; a torn journal record, damaged closure, different command, or uncovered scope still refuses as unresolved.",
          },
        },
        independentObservable: `${identity}:listed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        trigger:
          "The doorway state folder is unreadable or corrupt, or is left at the old default place outside my-agent-dojo.",
        repairAction:
          "When the message names an old state folder, run the move command it gives; doorway never reads or moves the old folder itself. Otherwise inspect the state folder named in the message and repair or move it aside before running doorway again.",
        guidance: {
          handoff: {
            owner: "operator",
            reason:
              "The doorway state folder cannot be read, or is left at its old default place.",
            inspect: [
              {
                kind: "instruction",
                text: "Inspect the doorway state folder named in the message, or run the move command the message gives.",
              },
            ],
          },
        },
        independentObservable: `${identity}:state-unavailable`,
      }),
    ],
    run: (_input, context) => {
      const stateProblem = unavailableStateMessage(environment, stateFolder);
      if (stateProblem !== undefined || stateFolder === undefined)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          },
          {
            message: stateProblem ?? "",
            data: null,
            effects: nothingChanged,
          },
        );
      const report = state.report();
      if (!report.ok && report.reason === "missing") {
        return context.result(
          { commandIdentity: identity, causeCode: unchangedSuccess },
          {
            message: "0 unfinished operations.",
            data: {
              stateFolder,
              unfinished: [],
            },
            effects: nothingChanged,
          },
        );
      }
      if (!report.ok) {
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          },
          {
            message: `The doorway state folder at ${stateFolder} is ${report.reason}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      }
      const count = report.unfinished.length;
      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message:
            count === 0
              ? "0 unfinished operations."
              : `${String(count)} unfinished ${count === 1 ? "operation" : "operations"}. An unfinished doorway open or start clears on the next open or start for that destination once the earlier run has stopped; a live run still refuses as held, and a torn journal record, damaged closure, different command, or uncovered scope still refuses as unresolved.`,
          data: {
            stateFolder,
            unfinished: report.unfinished.map((entry) => ({
              operationId: entry.operationId,
              commandIdentity: entry.commandIdentity,
              runId: entry.runId,
              effects: [...entry.effects],
            })),
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
