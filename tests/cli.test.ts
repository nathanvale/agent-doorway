import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("doorway open and pending ignore relative XDG_CONFIG_HOME and XDG_STATE_HOME and never load a cwd decoy", () => {
  const scratch = testFolder("cli-xdg-relative-");
  try {
    const home = join(scratch, "home");
    const workdir = join(scratch, "cwd");
    const decoySettingsDir = join(
      workdir,
      "relative",
      "bad",
      "my-agent-dojo",
      "doorway",
    );
    const decoyOldDir = join(workdir, "relative", "bad", "doorway");
    mkdirSync(home, { recursive: true });
    mkdirSync(decoySettingsDir, { recursive: true });
    mkdirSync(decoyOldDir, { recursive: true });
    writeFileSync(join(decoySettingsDir, "settings.json"), "{not-json");
    writeFileSync(join(decoyOldDir, "settings.json"), "{not-json");

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: "relative/bad",
      XDG_STATE_HOME: "relative/bad",
    };

    const opened = Bun.spawnSync(
      [process.execPath, "run", cli, "open", "example", "--json"],
      { cwd: workdir, env, stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: opened.exitCode,
      stderr: opened.stderr.toString(),
    }).toEqual({ exitCode: 3, stderr: "" });
    const openedPayload: unknown = JSON.parse(opened.stdout.toString());
    expect(openedPayload).toMatchObject({
      result: {
        commandIdentity: "doorway.open",
        causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING",
        transactionState: "unchanged",
        data: null,
      },
    });
    const rawMessage: unknown =
      typeof openedPayload === "object" &&
      openedPayload !== null &&
      Object.hasOwn(openedPayload, "message")
        ? Reflect.get(openedPayload, "message")
        : undefined;
    const openedMessage = typeof rawMessage === "string" ? rawMessage : "";
    expect(openedMessage).toContain(
      join(home, ".config", "my-agent-dojo", "doorway", "settings.json"),
    );
    expect(openedMessage).not.toContain("relative/bad");

    const pending = Bun.spawnSync(
      [process.execPath, "run", cli, "pending", "--json"],
      { cwd: workdir, env, stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: pending.exitCode,
      stderr: pending.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(pending.stdout.toString())).toMatchObject({
      result: {
        commandIdentity: "doorway.pending",
        causeCode: "SUCCESS_UNCHANGED",
        data: {
          stateFolder: join(
            home,
            ".local",
            "state",
            "my-agent-dojo",
            "doorway",
          ),
          unfinished: [],
        },
      },
    });
    expect(
      existsSync(
        join(workdir, "relative", "bad", "my-agent-dojo", "doorway", "journal"),
      ),
    ).toBe(false);
    expect(
      existsSync(join(home, ".local", "state", "my-agent-dojo", "doorway")),
    ).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
