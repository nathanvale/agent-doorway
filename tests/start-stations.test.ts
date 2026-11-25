import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertRemoteCommands,
  createStartFixture,
  expectedPsCommand,
  expectedStartCommand,
  invokeCliWithJournalFaults,
  pinnedId,
  readCalls,
  runJson,
  spawnCliAsync,
  waitForExitOrKill,
  waitForFile,
} from "./support/start-fixture.ts";

setDefaultTimeout(30_000);

describe("doorway start required stations", () => {
  test("reaches pre-flight and remote refusal stations through the real CLI", () => {
    const missingSettings = createStartFixture({
      allowStart: true,
      psOutputs: [`${pinnedId} pilot-box exited\n`],
    });
    try {
      expect(
        runJson(
          {
            ...missingSettings.environment,
            DOORWAY_SETTINGS: join(missingSettings.root, "missing.json"),
          },
          3,
          "start",
          "pilot",
        ),
      ).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_SETTINGS_MISSING",
          outcome: "refused",
          transactionState: "unchanged",
        },
      });
      writeFileSync(missingSettings.settingsFile, "{invalid json");
      expect(
        runJson(missingSettings.environment, 3, "start", "pilot"),
      ).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_SETTINGS_INVALID",
          outcome: "refused",
          transactionState: "unchanged",
        },
      });
      expect(readCalls(missingSettings.sshLog)).toEqual([]);
      expect(readCalls(missingSettings.editorLog)).toEqual([]);
    } finally {
      missingSettings.cleanup();
    }

    const fixture = createStartFixture({
      allowStart: true,
      psOutputs: [`${pinnedId} pilot-box exited\n`],
      createEditorFolders: false,
    });
    try {
      expect(runJson(fixture.environment, 3, "start", "unknown")).toMatchObject(
        {
          result: {
            commandIdentity: "doorway.start",
            causeCode: "DOMAIN_DOORWAY_DESTINATION_UNKNOWN",
            outcome: "refused",
            transactionState: "unchanged",
          },
        },
      );
      expect(
        runJson(fixture.environment, 3, "start", "pilot", "../escape"),
      ).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_PLACE_INVALID",
          outcome: "refused",
          transactionState: "unchanged",
        },
      });
      expect(runJson(fixture.environment, 3, "start", "pilot")).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_EDITOR_FOLDERS_MISSING",
          outcome: "refused",
          transactionState: "unchanged",
        },
      });
      expect(readCalls(fixture.sshLog)).toEqual([]);
      expect(readCalls(fixture.editorLog)).toEqual([]);
    } finally {
      fixture.cleanup();
    }

    const missingTool = createStartFixture({
      allowStart: true,
      psOutputs: [`${pinnedId} pilot-box exited\n`],
      editorToolPath: "/nonexistent/doorway-missing-editor",
    });
    try {
      expect(
        runJson(missingTool.environment, 3, "start", "pilot"),
      ).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_TOOL_UNAVAILABLE",
          outcome: "refused",
          transactionState: "unchanged",
        },
      });
      expect(readCalls(missingTool.sshLog)).toEqual([]);
      expect(readCalls(missingTool.editorLog)).toEqual([]);
    } finally {
      missingTool.cleanup();
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
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_REMOTE_HOST_UNREACHABLE",
          outcome: "refused",
          transactionState: "unchanged",
        },
      });
      assertRemoteCommands(readCalls(unreachable.sshLog), [expectedPsCommand]);
    } finally {
      unreachable.cleanup();
    }

    const remoteFailed = createStartFixture({
      allowStart: true,
      psOutputs: [""],
      psExits: [7],
    });
    try {
      expect(
        runJson(remoteFailed.environment, 3, "start", "pilot"),
      ).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED",
          outcome: "refused",
          transactionState: "unchanged",
        },
      });
      assertRemoteCommands(readCalls(remoteFailed.sshLog), [expectedPsCommand]);
      expect(readCalls(remoteFailed.editorLog)).toEqual([]);
    } finally {
      remoteFailed.cleanup();
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
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_DESTINATION_UNRESOLVED",
          outcome: "refused",
          transactionState: "unchanged",
        },
      });
      assertRemoteCommands(readCalls(unresolvedOpen.sshLog), [
        expectedPsCommand,
        expectedPsCommand,
      ]);
    } finally {
      unresolvedOpen.cleanup();
    }
  });

  test("reaches destination-held and state-unavailable stations through the real CLI", async () => {
    const held = createStartFixture({
      allowStart: true,
      psOutputs: [
        `${pinnedId} pilot-box exited\n`,
        `${pinnedId} pilot-box running\n`,
      ],
      startWaitForRelease: true,
    });
    try {
      const first = spawnCliAsync(held.environment, "start", "pilot", "--json");
      try {
        await waitForFile(held.startReadyFile);
        expect(runJson(held.environment, 3, "start", "pilot")).toMatchObject({
          result: {
            commandIdentity: "doorway.start",
            causeCode: "DOMAIN_DOORWAY_DESTINATION_HELD",
            outcome: "refused",
            transactionState: "unchanged",
          },
        });
      } finally {
        writeFileSync(held.startReleaseFile, "go");
        await waitForExitOrKill(first);
      }
      assertRemoteCommands(readCalls(held.sshLog), [
        expectedPsCommand,
        expectedStartCommand,
        expectedPsCommand,
        expectedPsCommand,
      ]);
    } finally {
      held.cleanup();
    }

    const unavailable = createStartFixture({
      allowStart: true,
      psOutputs: [`${pinnedId} pilot-box running\n`],
    });
    try {
      const blocker = join(unavailable.root, "state-as-file");
      writeFileSync(blocker, "not-a-directory");
      expect(
        runJson(
          { ...unavailable.environment, DOORWAY_STATE: blocker },
          3,
          "start",
          "pilot",
        ),
      ).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_STATE_UNAVAILABLE",
          outcome: "refused",
          transactionState: "unchanged",
        },
      });
      assertRemoteCommands(readCalls(unavailable.sshLog), [expectedPsCommand]);
      expect(readCalls(unavailable.editorLog)).toEqual([]);
    } finally {
      unavailable.cleanup();
    }
  });

  test("reaches DOMAIN_DOORWAY_START_EDITOR_FAILED when the editor effect cannot be recorded after start confirms", () => {
    const fixture = createStartFixture({
      allowStart: true,
      psOutputs: [
        `${pinnedId} pilot-box exited\n`,
        `${pinnedId} pilot-box running\n`,
      ],
    });
    try {
      const ran = invokeCliWithJournalFaults(
        fixture.root,
        fixture.environment,
        "effect-started:editor.open:write",
        "start",
        "pilot",
        "--json",
      );
      expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
        exitCode: 3,
        stderr: "",
      });
      const envelope: unknown = JSON.parse(ran.stdout);
      expect(envelope).toMatchObject({
        result: {
          commandIdentity: "doorway.start",
          causeCode: "DOMAIN_DOORWAY_START_EDITOR_FAILED",
          outcome: "failed",
          transactionState: "partially-completed",
          effects: {
            completed: ["container.start"],
            remaining: ["editor.open"],
            uncertain: [],
            inventoryComplete: true,
          },
        },
      });
      assertRemoteCommands(readCalls(fixture.sshLog), [
        expectedPsCommand,
        expectedStartCommand,
        expectedPsCommand,
      ]);
      expect(readCalls(fixture.editorLog)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    { fault: "completion:write", unfinishedAfter: 1 },
    { fault: "completion:flush", unfinishedAfter: 0 },
  ] as const)(
    "reports completed start and editor stop honestly when final journal $fault fails",
    ({ fault, unfinishedAfter }) => {
      const fixture = createStartFixture({
        allowStart: true,
        psOutputs: [
          `${pinnedId} pilot-box exited\n`,
          `${pinnedId} pilot-box running\n`,
        ],
      });
      try {
        const ran = invokeCliWithJournalFaults(
          fixture.root,
          fixture.environment,
          fault,
          "start",
          "pilot",
          "--json",
        );
        expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
          exitCode: 3,
          stderr: "",
        });
        const envelope: unknown = JSON.parse(ran.stdout);
        expect(envelope).toMatchObject({
          result: {
            commandIdentity: "doorway.start",
            causeCode: "DOMAIN_DOORWAY_OPEN_UNCONFIRMED",
            outcome: "failed",
            transactionState: "unknown",
            attemptedEffect: "editor.open",
            effects: {
              completed: ["container.start", "editor.open"],
              remaining: [],
              uncertain: [],
              inventoryComplete: false,
            },
          },
        });
        const message =
          typeof envelope === "object" && envelope !== null
            ? String(Reflect.get(envelope, "message"))
            : "";
        expect(message).toContain(
          "Started pilot, which stays running, and the isolated editor started and stopped with exit code 0.",
        );
        expect(message).toContain(
          "Doorway state could not confirm its final journal record for this start. Run doorway pending to check.",
        );
        expect(message).not.toContain("may still be unfinished");
        expect(message).not.toContain("pending lists it");
        expect(message).not.toContain("did not confirm the container running");
        expect(message).not.toContain("isolated editor did not start");
        assertRemoteCommands(readCalls(fixture.sshLog), [
          expectedPsCommand,
          expectedStartCommand,
          expectedPsCommand,
        ]);
        expect(readCalls(fixture.editorLog)).toHaveLength(1);
        const pending: unknown = runJson(fixture.environment, 0, "pending");
        const pendingResult: unknown =
          typeof pending === "object" && pending !== null
            ? Reflect.get(pending, "result")
            : undefined;
        const pendingData: unknown =
          typeof pendingResult === "object" && pendingResult !== null
            ? Reflect.get(pendingResult, "data")
            : undefined;
        const unfinished: unknown =
          typeof pendingData === "object" && pendingData !== null
            ? Reflect.get(pendingData, "unfinished")
            : undefined;
        expect(Array.isArray(unfinished) ? unfinished : []).toHaveLength(
          unfinishedAfter,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );
});
