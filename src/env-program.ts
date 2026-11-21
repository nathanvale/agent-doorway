import { isAbsolute, join } from "node:path";
import type { ParsedPath } from "agent-cli-kernel";

export const envExecutablePath = join("/", "usr", "bin", "env");

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
