import { dirname, isAbsolute } from "node:path";
import { readRootedFile } from "agent-cli-kernel/rooted-file";
import type { RootedFileResult } from "agent-cli-kernel/rooted-file";

export const settingsLimitBytes = 1_048_576;

export type SettingsJsonRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "json"; readonly value: unknown };

function defaultSettingsRoot(target: string): string {
  const folder = dirname(target);
  const parent = dirname(folder);
  return parent === folder ? folder : parent;
}

export function readSettingsJson(
  pathValue: string,
  root?: string,
): SettingsJsonRead {
  if (!isAbsolute(pathValue)) {
    return {
      kind: "invalid",
      reason: "Settings path override must be an absolute path.",
    };
  }
  const effectiveRoot = root ?? defaultSettingsRoot(pathValue);
  let result: RootedFileResult;
  try {
    result = readRootedFile(effectiveRoot, pathValue, settingsLimitBytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "invalid",
      reason: `Could not read settings file: ${detail}`,
    };
  }
  if (result.kind === "missing") return { kind: "missing" };
  if (result.kind === "refused")
    return { kind: "invalid", reason: result.message };
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
    );
  } catch {
    return { kind: "invalid", reason: "Settings file is not valid JSON." };
  }
  return { kind: "json", value };
}
