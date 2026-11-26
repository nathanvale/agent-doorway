import { command, contractFor } from "agent-cli-kernel";
import type { ParsedPath } from "agent-cli-kernel";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
import {
  causes,
  cli,
  noInput,
  nothingChanged,
  unchangedSuccess,
} from "./causes.ts";
import { listCommand } from "./list.ts";
import { openCommand } from "./open.ts";
import { pendingCommand } from "./pending.ts";
import type { DoorwayState } from "./pending.ts";
import { statePath } from "./settings.ts";
import type { Environment } from "./settings.ts";
import { startCommand } from "./start.ts";

const status = command({
  identity: "doorway.status",
  route: ["status"],
  summary: "Report that doorway runs.",
  input: noInput,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      {
        commandIdentity: "doorway.status",
        causeCode: unchangedSuccess,
      },
      {
        message: "Doorway runs.",
        data: { ready: true },
        effects: nothingChanged,
      },
    ),
});

function buildCommands(
  state: DoorwayState,
  stateFolder: string | undefined,
  environment: Environment,
  parsePath: (value: string) => ParsedPath,
  editorTimeoutMilliseconds?: number,
) {
  return [
    status,
    listCommand(environment, parsePath),
    openCommand(state, environment, parsePath, editorTimeoutMilliseconds),
    startCommand(state, environment, parsePath, editorTimeoutMilliseconds),
    pendingCommand(state, stateFolder),
  ] as const;
}

export function createDoorway(
  environment: Environment,
  installedAddons: readonly ("state" | "programs")[] = ["state", "programs"],
  editorTimeoutMilliseconds?: number,
) {
  const stateFolder = statePath(environment);
  const state = stateAddon({
    root: stateFolder ?? "",
    report: "doorway.pending",
  });
  const parsePath = (value: string): ParsedPath =>
    contract.boundary.path(value);
  const contract = contractFor({
    cli,
    commands: buildCommands(
      state,
      stateFolder,
      environment,
      parsePath,
      editorTimeoutMilliseconds,
    ),
    causes,
    state: state.descriptor,
    installedAddons,
  });
  const setup = {
    emergencyRecord: state.emergencyRecord,
    addons: {
      programs: programsAddon(),
    },
  };
  return { contract, state, setup };
}

export const commands = [status] as const;
