import { dirname } from "node:path";
import { loadSettings, oldSettingsMessage, settingsPath } from "./settings.ts";
import type { DoorwaySettings, Environment } from "./settings.ts";

export type DoorwaySettingsOutcome =
  | { readonly ok: true; readonly settings: DoorwaySettings }
  | {
      readonly ok: false;
      readonly causeCode:
        | "DOMAIN_DOORWAY_SETTINGS_MISSING"
        | "DOMAIN_DOORWAY_SETTINGS_INVALID";
      readonly message: string;
    };

export async function loadDoorwaySettings(
  environment: Environment,
): Promise<DoorwaySettingsOutcome> {
  const settingsFile = settingsPath(environment);
  if (settingsFile === undefined) {
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING",
      message:
        "Doorway cannot determine an absolute settings path because neither XDG_CONFIG_HOME nor HOME is an absolute path.",
    };
  }
  const hasOverride =
    environment.DOORWAY_SETTINGS !== undefined &&
    environment.DOORWAY_SETTINGS !== "";
  const root = hasOverride
    ? undefined
    : dirname(dirname(dirname(settingsFile)));
  const loaded = await loadSettings(settingsFile, root);
  if (loaded.kind === "missing") {
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING",
      message:
        oldSettingsMessage(environment) ??
        `Settings file not found at ${settingsFile}.`,
    };
  }
  if (loaded.kind === "invalid") {
    return {
      ok: false,
      causeCode: "DOMAIN_DOORWAY_SETTINGS_INVALID",
      message: `Settings file at ${settingsFile} is invalid: ${loaded.reason}`,
    };
  }
  return { ok: true, settings: loaded.settings };
}
