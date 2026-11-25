import { dirname, isAbsolute, resolve } from "node:path";
import { readRootedFile } from "agent-cli-kernel/rooted-file";

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
  const target = isAbsolute(pathValue) ? pathValue : resolve(pathValue);
  const effectiveRoot = root ?? defaultSettingsRoot(target);
  const result = readRootedFile(effectiveRoot, target, settingsLimitBytes);
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
