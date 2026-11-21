import { describe, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  command,
  commonCauses,
  contractFor,
  runInProcess,
} from "agent-cli-kernel";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { envExecutablePath, isolatedProgram } from "../src/env-program.ts";
import { testFolder } from "./support/test-folder.ts";

const succeeded = "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;
const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const noEffects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

describe("isolatedProgram env helper", () => {
  test("wraps an absolute program path with env removing VSCODE_IPC_HOOK_CLI and clearing SSH_AUTH_SOCK", () => {
    const folder = testFolder("env-helper-");
    try {
      const dummyCommand = command({
        identity: "probe.noop",
        route: ["noop"],
        summary: "No-op command for path parsing.",
        input: noInput,
        capabilities: {},
        run: (_input, context) =>
          context.result(
            { commandIdentity: "probe.noop", causeCode: succeeded },
            { message: "ok", data: null, effects: noEffects },
          ),
      });
      const contract = contractFor({
        cli: "probe",
        commands: [dummyCommand],
        installedAddons: [],
      });
      const programPath = join(folder, "fake-editor");
      const wrapped = isolatedProgram(
        contract.boundary.path(programPath),
        ["--new-window"],
        contract.boundary.path,
      );
      expect(wrapped.executable).toBe(
        contract.boundary.path(envExecutablePath),
      );
      expect(wrapped.args).toEqual([
        "-u",
        "VSCODE_IPC_HOOK_CLI",
        "SSH_AUTH_SOCK=",
        programPath,
        "--new-window",
      ]);
      expect(wrapped.executable.startsWith("/")).toBe(true);
      expect(wrapped.args[3]?.startsWith("/")).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("rejects a program path containing an equals sign", () => {
    const folder = testFolder("env-equals-");
    try {
      const dummyCommand = command({
        identity: "probe.noop",
        route: ["noop"],
        summary: "No-op command for path parsing.",
        input: noInput,
        capabilities: {},
        run: (_input, context) =>
          context.result(
            { commandIdentity: "probe.noop", causeCode: succeeded },
            { message: "ok", data: null, effects: noEffects },
          ),
      });
      const contract = contractFor({
        cli: "probe",
        commands: [dummyCommand],
        installedAddons: [],
      });
      expect(() =>
        isolatedProgram(
          contract.boundary.path(join(folder, "BAD=VALUE")),
          [],
          contract.boundary.path,
        ),
      ).toThrow("An isolated program path cannot contain '='.");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("through the real programs add-on, removes VSCODE_IPC_HOOK_CLI and empties SSH_AUTH_SOCK while printing names only", async () => {
    const folder = testFolder("env-programs-");
    const previousIpc = process.env.VSCODE_IPC_HOOK_CLI;
    const previousAuth = process.env.SSH_AUTH_SOCK;
    try {
      const probeScript = join(folder, "print-env-names.ts");
      writeFileSync(
        probeScript,
        [
          `#!${process.execPath}`,
          "const names = Object.keys(process.env).sort();",
          "const sshAuthSockLength = Object.hasOwn(process.env, 'SSH_AUTH_SOCK') ? (process.env.SSH_AUTH_SOCK ?? '').length : -1;",
          "process.stdout.write(JSON.stringify({ names, sshAuthSockLength }));",
          "",
        ].join("\n"),
      );
      chmodSync(probeScript, 0o755);

      const inspectEnv = command({
        identity: "probe.env",
        route: ["env"],
        summary: "Inspect variable names passed to an isolated program.",
        input: noInput,
        capabilities: { programs: true },
        run: async (_input, context) => {
          const invocation = isolatedProgram(
            contract.boundary.path(probeScript),
            [],
            contract.boundary.path,
          );
          const ran = await context.programs.inspect({
            executable: invocation.executable,
            args: invocation.args,
            timeoutMilliseconds: 10_000,
            outputLimitBytes: 65_536,
            shutdownMilliseconds: 1_000,
          });
          return context.result(
            { commandIdentity: "probe.env", causeCode: succeeded },
            {
              message: "Inspected isolated program environment.",
              data: {
                exitCode: ran.exitCode,
                terminationConfirmed: ran.terminationConfirmed,
                stdout: ran.stdout,
                stderr: ran.stderr,
              },
              effects: noEffects,
            },
          );
        },
      });

      const contract = contractFor({
        cli: "probe",
        commands: [inspectEnv],
        installedAddons: ["programs"],
      });

      process.env.VSCODE_IPC_HOOK_CLI = "dummy-ipc-hook-value";
      process.env.SSH_AUTH_SOCK = "dummy-auth-sock-value";

      const ran = await runInProcess(contract, {
        addons: { programs: programsAddon() },
      })(["env", "--json"]);
      expect(ran.kind).toBe("envelope");
      if (ran.kind !== "envelope") return;
      expect(ran.exitCode).toBe(0);
      const data = ran.envelope.result.data;
      expect(typeof data).toBe("object");
      if (typeof data !== "object" || data === null || Array.isArray(data))
        return;
      const stdout: unknown = Object.hasOwn(data, "stdout")
        ? Reflect.get(data, "stdout")
        : undefined;
      expect(typeof stdout).toBe("string");
      if (typeof stdout !== "string") return;
      expect(stdout).not.toContain("dummy-ipc-hook-value");
      expect(stdout).not.toContain("dummy-auth-sock-value");
      const parsed: unknown = JSON.parse(stdout);
      expect(parsed).toMatchObject({ sshAuthSockLength: 0 });
      const names: unknown =
        typeof parsed === "object" &&
        parsed !== null &&
        Object.hasOwn(parsed, "names")
          ? Reflect.get(parsed, "names")
          : undefined;
      expect(Array.isArray(names)).toBe(true);
      if (!Array.isArray(names)) return;
      expect(names.includes("VSCODE_IPC_HOOK_CLI")).toBe(false);
      expect(names.includes("SSH_AUTH_SOCK")).toBe(true);
    } finally {
      if (previousIpc === undefined) delete process.env.VSCODE_IPC_HOOK_CLI;
      else process.env.VSCODE_IPC_HOOK_CLI = previousIpc;
      if (previousAuth === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previousAuth;
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
