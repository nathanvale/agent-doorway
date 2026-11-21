import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { testFolder } from "./support/test-folder.ts";

const repoRoot = join(import.meta.dir, "..");
const cli = join(repoRoot, "src/cli.ts");

test("status reports that doorway runs, from any folder", () => {
  const elsewhere = testFolder("cli-");
  try {
    const child = Bun.spawnSync(
      [process.execPath, "run", cli, "status", "--json"],
      { cwd: elsewhere, stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: child.exitCode,
      stderr: child.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      result: {
        commandIdentity: "doorway.status",
        causeCode: "SUCCESS_UNCHANGED",
        data: { ready: true },
      },
    });
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("help identifies the CLI as doorway and lists its doorway commands", () => {
  const elsewhere = testFolder("cli-help-");
  try {
    const child = Bun.spawnSync([process.execPath, "run", cli, "--help"], {
      cwd: elsewhere,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({
      exitCode: child.exitCode,
      stderr: child.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    const stdout = child.stdout.toString();
    expect(stdout).toContain("Usage: doorway <command> [options]");
    expect(stdout).toContain("Commands for doorway.");
    expect(stdout).toContain("open (doorway.open)");
    expect(stdout).toContain("pending (doorway.pending)");
    expect(stdout).toContain("status (doorway.status)");
    expect(stdout).not.toContain("agent-doorway");
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("linked doorway runs --help and status from outside the repository", () => {
  const scratch = testFolder("cli-link-");
  try {
    const bunInstall = join(scratch, "bun-install");
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(bunInstall, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });

    const bunBin = dirname(process.execPath);
    const linkEnv: Record<string, string> = {
      ...process.env,
      BUN_INSTALL: bunInstall,
      PATH: [bunBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    };
    const linked = Bun.spawnSync([process.execPath, "link"], {
      cwd: repoRoot,
      env: linkEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({
      exitCode: linked.exitCode,
      stderr: linked.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });

    const runEnv: Record<string, string> = {
      ...linkEnv,
      PATH: [join(bunInstall, "bin"), bunBin, process.env.PATH ?? ""]
        .filter(Boolean)
        .join(delimiter),
    };

    const help = Bun.spawnSync(["doorway", "--help"], {
      cwd: elsewhere,
      env: runEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({
      exitCode: help.exitCode,
      stderr: help.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    expect(help.stdout.toString()).toContain(
      "Usage: doorway <command> [options]",
    );
    expect(help.stdout.toString()).not.toContain("agent-doorway");

    const status = Bun.spawnSync(["doorway", "status"], {
      cwd: elsewhere,
      env: runEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({
      exitCode: status.exitCode,
      stderr: status.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    expect(status.stdout.toString()).toContain("Doorway runs.");
    expect(status.stdout.toString()).toContain('"ready": true');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
