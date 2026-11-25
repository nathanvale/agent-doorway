import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { runInProcess } from "agent-cli-kernel";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { createDoorway } from "../src/commands.ts";
import {
  assertRemoteCommands,
  createStartFixture,
  expectedPsCommand,
  expectedStartCommand,
  gateDomainTimeoutOnReadyFile,
  invokeCli,
  pinnedId,
  readCalls,
  replacedId,
} from "./support/start-fixture.ts";

setDefaultTimeout(30_000);

function runJson(
  env: Record<string, string>,
  expectedExit: number,
  ...argv: readonly string[]
): unknown {
  const ran = invokeCli(env, ...argv, "--json");
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
    exitCode: expectedExit,
    stderr: "",
  });
  return JSON.parse(ran.stdout);
}

describe("doorway start", () => {
  test("refuses when allowStart is absent or false without running any remote command", () => {
    for (const allowStart of [undefined, false] as const) {
      const fixture = createStartFixture({
        ...(allowStart === undefined ? {} : { allowStart }),
        psOutputs: [`${pinnedId} pilot-box exited\n`],
      });
      try {
        expect(runJson(fixture.environment, 3, "start", "pilot")).toMatchObject(
          {
            result: {
              commandIdentity: "doorway.start",
              causeCode: "DOMAIN_DOORWAY_START_NOT_ALLOWED",
              outcome: "refused",
              transactionState: "unchanged",
              data: null,
            },
          },
        );
        expect(readCalls(fixture.sshLog)).toEqual([]);
        expect(readCalls(fixture.editorLog)).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test.each(["exited", "created"] as const)(
    "starts an opted-in %s container once by full pinned ID and opens the isolated editor",
    (initialState) => {
      const fixture = createStartFixture({
        allowStart: true,
        psOutputs: [
          `${pinnedId} pilot-box ${initialState}\n`,
          `${pinnedId} pilot-box running\n`,
        ],
      });
      try {
        expect(runJson(fixture.environment, 0, "start", "pilot")).toMatchObject(
          {
            result: {
              commandIdentity: "doorway.start",
              causeCode: "SUCCESS_COMPLETED",
              outcome: "success",
              transactionState: "completed",
              effects: {
                completed: ["container.start", "editor.open"],
                remaining: [],
                uncertain: [],
                inventoryComplete: true,
              },
              data: {
                destination: "pilot",
                remoteHost: "lab",
                container: "pilot-box",
                containerId: pinnedId,
                place: "/workspace",
                editor: "isolated-vscode",
                started: true,
              },
            },
          },
        );
        const sshCalls = readCalls(fixture.sshLog);
        assertRemoteCommands(sshCalls, [
          expectedPsCommand,
          expectedStartCommand,
          expectedPsCommand,
        ]);
        for (const call of sshCalls) {
          expect(call.hasVscodeIpc).toBe(false);
          expect(call.sshAuthSockLength).toBe(0);
        }
        const editorCalls = readCalls(fixture.editorLog);
        expect(editorCalls).toHaveLength(1);
        expect(editorCalls[0]?.hasVscodeIpc).toBe(false);
        expect(editorCalls[0]?.sshAuthSockLength).toBe(0);
      } finally {
        fixture.cleanup();
      }
    },
  );

  test("opens an already-running opted-in destination without running docker start", () => {
    const fixture = createStartFixture({
      allowStart: true,
      psOutputs: [`${pinnedId} pilot-box running\n`],
    });
    try {
      expect(
        runJson(fixture.environment, 0, "start", "pilot", "/repos"),
      ).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "SUCCESS_COMPLETED",
          outcome: "success",
          transactionState: "completed",
          data: { destination: "pilot", place: "/repos", started: false },
        },
      });
      assertRemoteCommands(readCalls(fixture.sshLog), [expectedPsCommand]);
      expect(readCalls(fixture.editorLog)).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  test.each(["paused", "restarting", "dead", "removing"] as const)(
    "refuses unsupported Docker %s state without running docker start",
    (dockerState) => {
      const fixture = createStartFixture({
        allowStart: true,
        psOutputs: [`${pinnedId} pilot-box ${dockerState}\n`],
      });
      try {
        expect(runJson(fixture.environment, 3, "start", "pilot")).toMatchObject(
          {
            result: {
              commandIdentity: "doorway.start",
              causeCode: "DOMAIN_DOORWAY_START_STATE_UNSUPPORTED",
              outcome: "refused",
              transactionState: "unchanged",
              data: null,
            },
          },
        );
        assertRemoteCommands(readCalls(fixture.sshLog), [expectedPsCommand]);
        expect(readCalls(fixture.editorLog)).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  test("refuses missing or replaced container identity without running docker start", () => {
    const cases = [
      ["", "DOMAIN_DOORWAY_DESTINATION_MISSING"],
      [
        `${replacedId} pilot-box exited\n`,
        "DOMAIN_DOORWAY_DESTINATION_REPLACED",
      ],
      [`${pinnedId} other-box exited\n`, "DOMAIN_DOORWAY_DESTINATION_REPLACED"],
    ] as const;
    for (const [psOutput, expectedCause] of cases) {
      const fixture = createStartFixture({
        allowStart: true,
        psOutputs: [psOutput],
      });
      try {
        expect(runJson(fixture.environment, 3, "start", "pilot")).toMatchObject(
          {
            result: {
              commandIdentity: "doorway.start",
              causeCode: expectedCause,
              outcome: "refused",
              transactionState: "unchanged",
            },
          },
        );
        assertRemoteCommands(readCalls(fixture.sshLog), [expectedPsCommand]);
        expect(readCalls(fixture.editorLog)).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("reports unknown start and lists it in doorway pending when docker start fails, then clears on next start", () => {
    const fixture = createStartFixture({
      allowStart: true,
      psOutputs: [`${pinnedId} pilot-box exited\n`],
      startExit: 1,
    });
    try {
      expect(runJson(fixture.environment, 3, "start", "pilot")).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_START_UNCONFIRMED",
          outcome: "failed",
          transactionState: "unknown",
          effects: {
            completed: [],
            remaining: ["editor.open"],
            uncertain: ["container.start"],
            inventoryComplete: true,
          },
          data: null,
        },
      });
      assertRemoteCommands(readCalls(fixture.sshLog), [
        expectedPsCommand,
        expectedStartCommand,
      ]);
      expect(readCalls(fixture.editorLog)).toEqual([]);

      expect(runJson(fixture.environment, 0, "pending")).toMatchObject({
        result: {
          commandIdentity: "doorway.pending",
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            unfinished: [
              {
                commandIdentity: "doorway.start",
                effects: ["container.start", "editor.open"],
              },
            ],
          },
        },
      });

      const healedFixture = createStartFixture({
        allowStart: true,
        psOutputs: [`${pinnedId} pilot-box running\n`],
      });
      try {
        const healedEnv = {
          ...healedFixture.environment,
          DOORWAY_STATE: fixture.stateFolder,
        };
        expect(runJson(healedEnv, 0, "start", "pilot")).toMatchObject({
          result: {
            commandIdentity: "doorway.start",
            causeCode: "SUCCESS_COMPLETED",
            data: { started: false },
          },
        });
        assertRemoteCommands(readCalls(healedFixture.sshLog), [
          expectedPsCommand,
        ]);
        expect(runJson(healedEnv, 0, "pending")).toMatchObject({
          result: { data: { unfinished: [] } },
        });
      } finally {
        healedFixture.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test("reports unknown start on ready-gated timeout or unconfirmed post-start inventory", async () => {
    const timedOut = createStartFixture({
      allowStart: true,
      psOutputs: [`${pinnedId} pilot-box exited\n`],
      startHang: true,
    });
    try {
      const doorway = createDoorway(timedOut.environment);
      const run = runInProcess(doorway.contract, {
        ...doorway.setup,
        addons: {
          programs: gateDomainTimeoutOnReadyFile(
            programsAddon(),
            timedOut.startReadyFile,
          ),
        },
      });
      expect(await run(["start", "pilot"])).toMatchObject({
        envelope: {
          result: {
            commandIdentity: "doorway.start",
            causeCode: "DOMAIN_DOORWAY_START_UNCONFIRMED",
            outcome: "failed",
            transactionState: "unknown",
            effects: {
              completed: [],
              remaining: ["editor.open"],
              uncertain: ["container.start"],
            },
          },
        },
      });
      assertRemoteCommands(readCalls(timedOut.sshLog), [
        expectedPsCommand,
        expectedStartCommand,
      ]);
      expect(readCalls(timedOut.editorLog)).toEqual([]);
      expect(runJson(timedOut.environment, 0, "pending")).toMatchObject({
        result: {
          data: { unfinished: [{ commandIdentity: "doorway.start" }] },
        },
      });
    } finally {
      timedOut.cleanup();
    }

    const stillStopped = createStartFixture({
      allowStart: true,
      psOutputs: [
        `${pinnedId} pilot-box exited\n`,
        `${pinnedId} pilot-box exited\n`,
      ],
    });
    try {
      expect(
        runJson(stillStopped.environment, 3, "start", "pilot"),
      ).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_START_UNCONFIRMED",
          outcome: "failed",
          transactionState: "unknown",
          effects: {
            completed: [],
            remaining: ["editor.open"],
            uncertain: ["container.start"],
          },
        },
      });
      assertRemoteCommands(readCalls(stillStopped.sshLog), [
        expectedPsCommand,
        expectedStartCommand,
        expectedPsCommand,
      ]);
      expect(readCalls(stillStopped.editorLog)).toEqual([]);
    } finally {
      stillStopped.cleanup();
    }
  });

  test("preserves completed start and never stops the container when editor fails cleanly or unconfirmed", () => {
    const cleanFail = createStartFixture({
      allowStart: true,
      psOutputs: [
        `${pinnedId} pilot-box exited\n`,
        `${pinnedId} pilot-box running\n`,
      ],
      editorExit: 2,
    });
    try {
      expect(runJson(cleanFail.environment, 3, "start", "pilot")).toMatchObject(
        {
          result: {
            commandIdentity: "doorway.start",
            causeCode: "DOMAIN_DOORWAY_OPEN_FAILED",
            outcome: "failed",
            transactionState: "completed",
            effects: {
              completed: ["container.start", "editor.open"],
              remaining: [],
              uncertain: [],
              inventoryComplete: true,
            },
          },
        },
      );
      assertRemoteCommands(readCalls(cleanFail.sshLog), [
        expectedPsCommand,
        expectedStartCommand,
        expectedPsCommand,
      ]);
      expect(readCalls(cleanFail.editorLog)).toHaveLength(1);
    } finally {
      cleanFail.cleanup();
    }

    const unconfirmedFail = createStartFixture({
      allowStart: true,
      psOutputs: [
        `${pinnedId} pilot-box exited\n`,
        `${pinnedId} pilot-box running\n`,
      ],
      editorSignal: "SIGTERM",
    });
    try {
      expect(
        runJson(unconfirmedFail.environment, 3, "start", "pilot"),
      ).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
          outcome: "failed",
          transactionState: "unknown",
          effects: {
            completed: ["container.start"],
            remaining: [],
            uncertain: ["editor.open"],
            inventoryComplete: true,
          },
        },
      });
      assertRemoteCommands(readCalls(unconfirmedFail.sshLog), [
        expectedPsCommand,
        expectedStartCommand,
        expectedPsCommand,
      ]);
      expect(runJson(unconfirmedFail.environment, 0, "pending")).toMatchObject({
        result: {
          data: { unfinished: [{ commandIdentity: "doorway.start" }] },
        },
      });
    } finally {
      unconfirmedFail.cleanup();
    }
  });

  test("refuses pre-flight missing folders, invalid place, unknown destination, unreachable host and unresolved open", async () => {
    const fixture = createStartFixture({
      allowStart: true,
      psOutputs: [`${pinnedId} pilot-box exited\n`],
      createEditorFolders: false,
    });
    try {
      const doorway = createDoorway(fixture.environment);
      const run = runInProcess(doorway.contract, doorway.setup);
      expect(await run(["start", "unknown"])).toMatchObject({
        envelope: {
          result: { causeCode: "DOMAIN_DOORWAY_DESTINATION_UNKNOWN" },
        },
      });
      expect(await run(["start", "pilot", "../escape"])).toMatchObject({
        envelope: {
          result: { causeCode: "DOMAIN_DOORWAY_PLACE_INVALID" },
        },
      });
      expect(await run(["start", "pilot"])).toMatchObject({
        envelope: {
          result: { causeCode: "DOMAIN_DOORWAY_EDITOR_FOLDERS_MISSING" },
        },
      });
      expect(readCalls(fixture.sshLog)).toEqual([]);
      expect(readCalls(fixture.editorLog)).toEqual([]);
    } finally {
      fixture.cleanup();
    }

    const unreachable = createStartFixture({
      allowStart: true,
      psOutputs: [""],
      psExits: [255],
    });
    try {
      expect(
        runJson(unreachable.environment, 3, "start", "pilot"),
      ).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_REMOTE_HOST_UNREACHABLE" },
      });
      assertRemoteCommands(readCalls(unreachable.sshLog), [expectedPsCommand]);
    } finally {
      unreachable.cleanup();
    }

    const unresolvedOpen = createStartFixture({
      allowStart: true,
      psOutputs: [`${pinnedId} pilot-box running\n`],
      editorSignal: "SIGTERM",
    });
    try {
      expect(
        runJson(unresolvedOpen.environment, 3, "open", "pilot"),
      ).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED" },
      });
      expect(
        runJson(unresolvedOpen.environment, 3, "start", "pilot"),
      ).toMatchObject({
        result: { causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED" },
      });
      assertRemoteCommands(readCalls(unresolvedOpen.sshLog), [
        expectedPsCommand,
        expectedPsCommand,
      ]);
    } finally {
      unresolvedOpen.cleanup();
    }
  });
});
