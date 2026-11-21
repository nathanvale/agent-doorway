import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { changing, station } from "agent-cli-kernel";
import type { ParsedPath, ProgramResult } from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import type { Refusal } from "agent-cli-kernel/addons/state";
import {
  causes,
  completedSuccess,
  noInput,
  nothingChanged,
  stationWords,
} from "./causes.ts";
import { editorArguments, requiredEditorFolders } from "./editor.ts";
import { envExecutablePath, isolatedProgram } from "./env-program.ts";
import type { DoorwayState } from "./pending.ts";
import {
  destinationState,
  inventoryCommand,
  parseInventory,
  sshArguments,
} from "./remote.ts";
import {
  findDestination,
  homeOf,
  isSafeRemotePath,
  loadSettings,
  settingsPath,
  toolPath,
} from "./settings.ts";
import type { Environment } from "./settings.ts";

const identity = "doorway.open";
const remoteTimeoutMilliseconds = 30_000;
const defaultEditorTimeoutMilliseconds = 60_000;
const programOutputLimitBytes = 1_048_576;
const programShutdownMilliseconds = 1_000;

const inspectPending = {
  owner: "operator",
  reason:
    "Inspect doorway pending before deciding how to proceed with this destination.",
  inspect: [{ kind: "command", command: "doorway.pending", args: [] }],
} as const;

async function foldersExist(paths: readonly string[]): Promise<boolean> {
  for (const folder of paths) {
    const info = await stat(folder).catch(() => null);
    if (info === null || !info.isDirectory()) return false;
  }
  return true;
}

async function executableExists(filePath: string): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  if (info === null || !info.isFile()) return false;
  return access(filePath, constants.X_OK).then(
    () => true,
    () => false,
  );
}

type StateRefusal = {
  readonly causeCode:
    | "DOMAIN_DOORWAY_DESTINATION_HELD"
    | "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED"
    | "DOMAIN_DOORWAY_STATE_UNAVAILABLE";
  readonly message: string;
};

function stateRefusal(
  outcome: Refusal | { readonly kind: "ran" },
  destinationName: string,
): StateRefusal | undefined {
  switch (outcome.kind) {
    case "ran":
      return undefined;
    case "held-lock":
      return {
        causeCode: "DOMAIN_DOORWAY_DESTINATION_HELD",
        message: `Destination ${destinationName} is being changed by operation ${outcome.operationId}.`,
      };
    case "unresolved-case":
      return {
        causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
        message: `Destination ${destinationName} has an unfinished operation ${outcome.operationId}.`,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function editorStoppedCleanly(result: ProgramResult): boolean {
  const details = programDetails(result);
  return (
    result.terminationConfirmed &&
    details !== undefined &&
    !details.timedOut &&
    result.exitCode !== null
  );
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
    input: {
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
    },
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
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING",
        trigger: "The doorway settings file does not exist.",
        repairAction:
          "Create the doorway settings file or set DOORWAY_SETTINGS to an existing settings file.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Create the settings file or set DOORWAY_SETTINGS, then run doorway open again.",
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
          "Fix the settings file reported in the message, then run doorway open again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair the settings file and run doorway open again.",
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
            text: "Check the destination names in settings and run doorway open again.",
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
        repairAction:
          "Create the isolated editor folders declared in settings before running doorway open.",
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
            text: "Verify SSH reachability to the remote host and retry doorway open.",
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
            text: "Check Docker availability on the remote host and retry doorway open.",
          },
        },
        independentObservable: `${identity}:remote-command-failed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_DESTINATION_MISSING",
        trigger: "The destination container was not found on its remote host.",
        repairAction:
          "Check the container name on the remote host; doorway open never creates containers.",
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
          "Another doorway process is currently changing this destination.",
        repairAction:
          "Wait for the active doorway operation to finish, then try again.",
        guidance: { handoff: inspectPending },
        independentObservable: `${identity}:destination-held`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
        trigger:
          "An earlier change to this destination did not finish cleanly.",
        repairAction:
          "Inspect unfinished operations with doorway pending before deciding how to proceed.",
        guidance: { handoff: inspectPending },
        independentObservable: `${identity}:destination-unresolved`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
        trigger:
          "The doorway state folder is unavailable, refused coordination, or could not record the operation before starting the isolated editor.",
        repairAction:
          "Inspect the state folder named by DOORWAY_STATE and repair it before running doorway open again.",
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
              { kind: "command", command: "doorway.pending", args: [] },
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
          "The isolated editor started, and doorway could not confirm that it stopped cleanly.",
        repairAction:
          "Run doorway pending and check whether the isolated editor process is still running.",
        guidance: { handoff: inspectPending },
        independentObservable: `${identity}:open-unconfirmed`,
      }),
    ],
    run: async (input, context) => {
      const settingsFile = settingsPath(environment);
      const loaded = await loadSettings(settingsFile);
      if (loaded.kind === "missing")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING",
          },
          {
            message: `Settings file not found at ${settingsFile}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (loaded.kind === "invalid")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_SETTINGS_INVALID",
          },
          {
            message: `Settings file at ${settingsFile} is invalid: ${loaded.reason}`,
            data: null,
            effects: nothingChanged,
          },
        );
      const found = findDestination(loaded.settings, input.destination);
      if (found === undefined)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_DESTINATION_UNKNOWN",
          },
          {
            message: `No destination named ${input.destination} is declared in settings.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (input.place !== undefined && !isSafeRemotePath(input.place))
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_PLACE_INVALID",
          },
          {
            message: `The place ${input.place} is not a safe absolute remote path.`,
            data: null,
            effects: nothingChanged,
          },
        );

      const { destination, remoteHost } = found;
      const home = homeOf(environment);
      if (!(await foldersExist(requiredEditorFolders(loaded.settings, home))))
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_EDITOR_FOLDERS_MISSING",
          },
          {
            message:
              "One or more isolated editor folders do not exist on this machine.",
            data: null,
            effects: nothingChanged,
          },
        );

      const sshExecutable = toolPath(loaded.settings, "ssh", home);
      const editorExecutable = toolPath(loaded.settings, "editor", home);
      if (
        !(await executableExists(envExecutablePath)) ||
        !(await executableExists(sshExecutable)) ||
        !(await executableExists(editorExecutable))
      )
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_TOOL_UNAVAILABLE",
          },
          {
            message:
              "A required local program (env, ssh, or the isolated editor) is missing or not executable.",
            data: null,
            effects: nothingChanged,
          },
        );

      const sshCall = isolatedProgram(
        parsePath(sshExecutable),
        sshArguments(remoteHost, inventoryCommand(remoteHost)),
        parsePath,
      );
      const sshRan = await context.programs.inspect({
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
      )
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_REMOTE_HOST_UNREACHABLE",
          },
          {
            message: `Remote host ${remoteHost.name} could not be reached over SSH.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (sshRan.exitCode !== 0)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED",
          },
          {
            message: `Docker inventory failed on remote host ${remoteHost.name} with exit code ${String(sshRan.exitCode)}.`,
            data: null,
            effects: nothingChanged,
          },
        );

      const observed = parseInventory(sshRan.stdout);
      const currentState = destinationState(destination, observed.containers);
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

      const plan = editorArguments(
        loaded.settings,
        remoteHost,
        destination,
        home,
        input.place,
      );
      const editorCall = isolatedProgram(
        parsePath(editorExecutable),
        plan.args,
        parsePath,
      );
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
            place: plan.place,
          },
        },
        async (transaction) => {
          try {
            await transaction.record(
              "editor.open",
              async (effect) => {
                try {
                  const ran = await context.programs.domain(effect).start({
                    executable: editorCall.executable,
                    args: editorCall.args,
                    timeoutMilliseconds: editorTimeoutMilliseconds,
                    outputLimitBytes: programOutputLimitBytes,
                    shutdownMilliseconds: programShutdownMilliseconds,
                  });
                  editorResult = ran;
                  return ran;
                } catch (error) {
                  failureDetail = errorMessage(error);
                  throw error;
                }
              },
              (ran) => Promise.resolve(editorStoppedCleanly(ran)),
            );
          } catch (error) {
            if (failureDetail === "") failureDetail = errorMessage(error);
            throw error;
          }
        },
      );

      const refused = stateRefusal(outcome, destination.name);
      if (refused !== undefined)
        return context.result(
          { commandIdentity: identity, causeCode: refused.causeCode },
          { message: refused.message, data: null, effects: nothingChanged },
        );

      if (outcome.proof.transactionState === "unchanged")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          },
          {
            message: `Doorway state could not record ${destination.name} before starting the isolated editor${failureDetail === "" ? "" : `: ${failureDetail}`}.`,
            data: null,
            effects: outcome.proof.effects,
          },
        );

      if (
        outcome.proof.transactionState !== "completed" ||
        editorResult === undefined ||
        !editorStoppedCleanly(editorResult)
      ) {
        const unconfirmedDetail =
          failureDetail !== ""
            ? failureDetail
            : editorResult !== undefined &&
                programDetails(editorResult)?.timedOut === true
              ? "the editor launcher timed out"
              : "";
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
          },
          {
            message: `Could not confirm that the isolated editor stopped cleanly for ${destination.name}${unconfirmedDetail === "" ? "" : `: ${unconfirmedDetail}`}.`,
            data: null,
            transaction: outcome.proof,
            attemptedEffect: "editor.open",
          },
        );
      }

      if (editorResult.exitCode !== 0)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_DOORWAY_OPEN_FAILED",
          },
          {
            message: `The isolated editor exited with code ${String(editorResult.exitCode)} for ${destination.name}. No unfinished case remains; you can run doorway open again.`,
            data: null,
            transaction: outcome.proof,
            attemptedEffect: "editor.open",
          },
        );

      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: `Opened ${destination.name} at ${plan.place} in the isolated editor. Attachment was not verified; closing the editor leaves the container running.`,
          data: {
            destination: destination.name,
            remoteHost: remoteHost.name,
            container: destination.container,
            containerId: destination.containerId,
            place: plan.place,
            editor: "isolated-vscode",
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}
