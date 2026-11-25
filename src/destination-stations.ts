import { station } from "agent-cli-kernel";
import { causes, completedSuccess, stationWords } from "./causes.ts";
import { inspectPending, pendingCommandStep } from "./destination-launch.ts";

export function commonDestinationStations<Identity extends string>(
  identity: Identity,
  commandLabel: string,
) {
  return [
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
          text: `Create the settings file, set DOORWAY_SETTINGS, or run the move command in the message, then run ${commandLabel} again.`,
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
      repairAction: `Fix the settings file reported in the message, then run ${commandLabel} again.`,
      guidance: {
        next: {
          kind: "instruction",
          text: `Repair the settings file and run ${commandLabel} again.`,
        },
      },
      independentObservable: `${identity}:settings-invalid`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_DESTINATION_UNKNOWN",
      trigger: "No destination with that name is declared in settings.",
      repairAction:
        "Use a destination name declared in the doorway settings file.",
      guidance: {
        next: {
          kind: "instruction",
          text: `Check the destination names in settings and run ${commandLabel} again.`,
        },
      },
      independentObservable: `${identity}:destination-unknown`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_PLACE_INVALID",
      trigger: "The requested place is not a safe absolute remote path.",
      repairAction:
        "Provide an absolute remote path with safe characters and no parent segments.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Pass a safe absolute remote path as the place argument.",
        },
      },
      independentObservable: `${identity}:place-invalid`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_EDITOR_FOLDERS_MISSING",
      trigger:
        "The isolated editor user-data or extensions folder does not exist.",
      repairAction: `Create the isolated editor folders declared in settings before running ${commandLabel}.`,
      guidance: {
        next: {
          kind: "instruction",
          text: "Create the declared isolated editor folders and try again.",
        },
      },
      independentObservable: `${identity}:editor-folders-missing`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_TOOL_UNAVAILABLE",
      trigger:
        "A required local program for SSH, env, or the isolated editor is missing or not executable.",
      repairAction:
        "Install the missing program or update the tools path in doorway settings.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Ensure ssh, env, and the isolated editor program are executable, then try again.",
        },
      },
      independentObservable: `${identity}:tool-unavailable`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_REMOTE_HOST_UNREACHABLE",
      trigger: "The remote host could not be reached over SSH.",
      repairAction:
        "Check network reachability and SSH access to the remote host, then try again.",
      guidance: {
        next: {
          kind: "instruction",
          text: `Verify SSH reachability to the remote host and retry ${commandLabel}.`,
        },
      },
      independentObservable: `${identity}:remote-host-unreachable`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED",
      trigger:
        "The read-only Docker inventory command failed on the remote host.",
      repairAction:
        "Verify Docker is running at the remote host dockerEndpoint and dockerPath.",
      guidance: {
        next: {
          kind: "instruction",
          text: `Check Docker availability on the remote host and retry ${commandLabel}.`,
        },
      },
      independentObservable: `${identity}:remote-command-failed`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_DESTINATION_MISSING",
      trigger: "The destination container was not found on its remote host.",
      repairAction: `Check the container name on the remote host; ${commandLabel} never creates containers.`,
      guidance: {
        next: {
          kind: "instruction",
          text: "Verify the destination container exists on its remote host.",
        },
      },
      independentObservable: `${identity}:destination-missing`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_DESTINATION_REPLACED",
      trigger:
        "The container on the remote host does not match the destination pinned container identity.",
      repairAction:
        "Review the container on the remote host and update the pinned containerId in settings if intended.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Inspect the remote container identity before updating settings.",
        },
      },
      independentObservable: `${identity}:destination-replaced`,
    }),
  ] as const;
}

const startIdentity = "doorway.start";

export const startStations = [
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: completedSuccess,
    trigger:
      "The destination container is running with its pinned identity (started if exited or created) and the isolated editor stopped cleanly with exit 0.",
    repairAction: null,
    guidance: { next: { kind: "done" } },
    independentObservable: `${startIdentity}:started`,
  }),
  ...commonDestinationStations(startIdentity, "doorway start"),
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: "DOMAIN_DOORWAY_START_NOT_ALLOWED",
    trigger: "The destination settings do not set allowStart to true.",
    repairAction:
      "Set allowStart to true for this destination in settings before running doorway start.",
    guidance: {
      next: {
        kind: "instruction",
        text: "Opt this destination into starting in settings (allowStart: true), then run doorway start again.",
      },
    },
    independentObservable: `${startIdentity}:start-not-allowed`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: "DOMAIN_DOORWAY_START_STATE_UNSUPPORTED",
    trigger:
      "The destination container is in a Docker state that doorway start cannot start (neither running, exited, nor created).",
    repairAction:
      "Inspect the container state on the remote host before attempting to start it.",
    guidance: {
      next: {
        kind: "instruction",
        text: "Inspect the container on its remote host; doorway start only starts exited or created containers.",
      },
    },
    independentObservable: `${startIdentity}:start-state-unsupported`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: "DOMAIN_DOORWAY_DESTINATION_HELD",
    trigger:
      "Another doorway process still holds the lock for this destination.",
    repairAction:
      "Wait for the running doorway operation to finish or stop, then run doorway start again.",
    guidance: {
      handoff: {
        owner: "operator",
        reason:
          "Another doorway process still holds the lock for this destination. Wait for it to finish or stop, then run doorway start again.",
        inspect: [pendingCommandStep],
      },
    },
    independentObservable: `${startIdentity}:destination-held`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
    trigger:
      "An earlier unfinished operation for this destination could not be cleared automatically.",
    repairAction:
      "Run doorway pending to inspect the unfinished operation before deciding how to proceed.",
    guidance: {
      handoff: {
        owner: "operator",
        reason:
          "An earlier unfinished operation for this destination could not be cleared automatically (for example, a torn journal record, a damaged closure, a different command, or an uncovered scope). Inspect doorway pending before deciding how to proceed.",
        inspect: [pendingCommandStep],
      },
    },
    independentObservable: `${startIdentity}:destination-unresolved`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
    trigger:
      "The doorway state folder is unavailable, refused coordination, or could not record the operation before mutating.",
    repairAction:
      "Inspect the doorway state folder before running doorway start again.",
    guidance: { handoff: inspectPending },
    independentObservable: `${startIdentity}:state-unavailable`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: "DOMAIN_DOORWAY_START_EDITOR_FAILED",
    trigger:
      "The container started and is running, but the operation stopped before launching the isolated editor.",
    repairAction:
      "Run doorway pending and then doorway open or doorway start again; the container stays running.",
    guidance: {
      handoff: {
        owner: "operator",
        reason:
          "The destination container started and stays running, but the isolated editor did not start. Inspect doorway pending, then run doorway open or doorway start again.",
        inspect: [pendingCommandStep],
      },
    },
    independentObservable: `${startIdentity}:start-editor-failed`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: "DOMAIN_DOORWAY_START_UNCONFIRMED",
    trigger:
      "The container start failed, timed out, was not confirmed running by post-start inventory, or its state journal record was not confirmed.",
    repairAction:
      "Run doorway pending and inspect the container on the remote host, then run doorway start again once the earlier run has stopped.",
    guidance: {
      handoff: {
        owner: "operator",
        reason:
          "Doorway could not confirm that the destination container started and is running. Check doorway pending and the container state; once the earlier run has stopped, running doorway start again clears an unfinished start.",
        inspect: [pendingCommandStep],
      },
    },
    independentObservable: `${startIdentity}:start-unconfirmed`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: "DOMAIN_DOORWAY_OPEN_FAILED",
    trigger:
      "The container is running and the isolated editor exited non-zero cleanly; no unfinished case remains.",
    repairAction:
      "Inspect why the isolated editor exited non-zero, then run doorway open or doorway start again.",
    guidance: {
      handoff: {
        owner: "operator",
        reason:
          "The isolated editor exited non-zero after stopping cleanly; the container stays running and no unfinished case remains.",
        inspect: [
          {
            kind: "instruction",
            text: "Check the isolated editor output and run doorway open or doorway start again.",
          },
          pendingCommandStep,
        ],
      },
    },
    independentObservable: `${startIdentity}:open-failed`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: startIdentity,
    causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
    trigger:
      "The container is running, but doorway could not confirm how the isolated editor launch ended.",
    repairAction:
      "Run doorway pending and check any leftover editor launcher; the container stays running.",
    guidance: {
      handoff: {
        owner: "operator",
        reason:
          "Doorway could not confirm how the isolated editor open ended. The container remains running. Check doorway pending; once the earlier run has stopped, running doorway start again clears an unfinished start.",
        inspect: [pendingCommandStep],
      },
    },
    independentObservable: `${startIdentity}:open-unconfirmed`,
  }),
] as const;
