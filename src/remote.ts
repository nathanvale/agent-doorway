import type { DestinationSettings, RemoteHostSettings } from "./settings.ts";

export type ObservedContainer = {
  readonly id: string;
  readonly names: readonly string[];
  readonly state: string;
  readonly running: boolean;
};

export type InventoryParse = {
  readonly containers: readonly ObservedContainer[];
  readonly rejected: number;
};

export type DestinationState = "running" | "stopped" | "replaced" | "missing";

const idPattern = /^[0-9a-f]{64}$/;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const statePattern = /^[a-z]{1,16}$/;

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function inventoryCommand(remoteHost: RemoteHostSettings): string {
  return [
    remoteHost.dockerPath,
    "--host",
    remoteHost.dockerEndpoint,
    "ps",
    "--all",
    "--no-trunc",
    "--format",
    "{{.ID}} {{.Names}} {{.State}}",
  ]
    .map(quoteShell)
    .join(" ");
}

export function sshArguments(
  remoteHost: RemoteHostSettings,
  remoteCommand: string,
): readonly string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "--",
    remoteHost.sshAlias,
    remoteCommand,
  ];
}

export function parseInventory(stdout: string): InventoryParse {
  const containers: ObservedContainer[] = [];
  let rejected = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split(" ");
    const [id, names, state] = fields;
    if (
      fields.length !== 3 ||
      id === undefined ||
      names === undefined ||
      state === undefined
    ) {
      rejected += 1;
      continue;
    }
    const nameList = names.split(",");
    if (
      !idPattern.test(id) ||
      !statePattern.test(state) ||
      !nameList.every((name) => namePattern.test(name))
    ) {
      rejected += 1;
      continue;
    }
    containers.push({
      id,
      names: nameList,
      state,
      running: state === "running",
    });
  }
  return { containers, rejected };
}

export function destinationState(
  destination: DestinationSettings,
  containers: readonly ObservedContainer[],
): DestinationState {
  const byName = containers.find((container) =>
    container.names.includes(destination.container),
  );
  if (byName !== undefined) {
    if (byName.id !== destination.containerId) return "replaced";
    return byName.running ? "running" : "stopped";
  }
  const byId = containers.find(
    (container) => container.id === destination.containerId,
  );
  if (byId !== undefined) return "replaced";
  return "missing";
}
