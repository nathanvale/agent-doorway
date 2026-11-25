import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ParsedPath } from "agent-cli-kernel";

export const envExecutablePath = join("/", "usr", "bin", "env");

export async function executableExists(filePath: string): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  if (info === null || !info.isFile()) return false;
  return access(filePath, constants.X_OK).then(
    () => true,
    () => false,
  );
}

export type EnvProgramInvocation = {
  readonly executable: ParsedPath;
  readonly args: readonly string[];
};

export function isolatedProgram(
  program: ParsedPath,
  args: readonly string[],
  parsePath: (value: string) => ParsedPath,
): EnvProgramInvocation {
  if (!isAbsolute(program)) {
    throw new Error("An isolated program path must be absolute.");
  }
  if (program.includes("=")) {
    throw new Error("An isolated program path cannot contain '='.");
  }
  return {
    executable: parsePath(envExecutablePath),
    args: ["-u", "VSCODE_IPC_HOOK_CLI", "SSH_AUTH_SOCK=", program, ...args],
  };
}
