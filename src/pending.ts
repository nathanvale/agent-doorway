import { command, station } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import {
  causes,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
} from "./causes.ts";

export type DoorwayState = ReturnType<typeof stateAddon>;

const identity = "doorway.pending";

export function pendingCommand(state: DoorwayState, stateFolder: string) {
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
            text: "Review any unfinished doorway operations before retrying a blocked destination.",
          },
        },
        independentObservable: `${identity}:listed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        trigger: "The doorway state folder is unreadable or corrupt.",
        repairAction:
          "Inspect the state folder named in the message and repair or move it aside before running doorway again.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The doorway state folder cannot be read.",
            inspect: [
              {
                kind: "instruction",
                text: "Inspect the doorway state folder named in the message.",
              },
            ],
          },
        },
        independentObservable: `${identity}:state-unavailable`,
      }),
    ],
    run: (_input, context) => {
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
      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message: `${String(report.unfinished.length)} unfinished operations.`,
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
