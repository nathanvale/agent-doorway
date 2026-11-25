import type { ProgramResult } from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import type { Refusal } from "agent-cli-kernel/addons/state";
import { refusalDetail } from "./destination-launch.ts";

export type StartFailureContext = {
  readonly name: string;
  readonly started: boolean;
  readonly effects: {
    readonly completed: readonly string[];
    readonly remaining: readonly string[];
    readonly uncertain: readonly string[];
    readonly inventoryComplete: boolean;
  };
  readonly refusal: Refusal | undefined;
  readonly failureDetail: string;
  readonly startResult: ProgramResult | undefined;
  readonly editorResult: ProgramResult | undefined;
};

function startUnknownDetail(info: StartFailureContext): string {
  if (info.refusal !== undefined) return refusalDetail(info.refusal, "start");
  if (info.failureDetail !== "") return info.failureDetail;
  if (
    info.startResult !== undefined &&
    programDetails(info.startResult)?.timedOut === true
  )
    return "the docker start command timed out";
  if (info.startResult !== undefined && info.startResult.exitCode !== 0)
    return `docker start exited with code ${String(info.startResult.exitCode)}`;
  return "post-start inventory did not confirm the container running";
}

function journalUnconfirmedNote(inventoryComplete: boolean): string {
  return inventoryComplete
    ? ""
    : " Doorway state could not confirm its final journal record for this start. Run doorway pending to check.";
}

export function unconfirmedStartMessage(info: StartFailureContext): string {
  const journal = journalUnconfirmedNote(info.effects.inventoryComplete);
  if (info.effects.uncertain.includes("container.start")) {
    const detail = startUnknownDetail(info);
    return `Could not confirm that destination ${info.name} started (${detail}); the isolated editor did not start.${journal}`;
  }
  const detail =
    info.refusal !== undefined
      ? refusalDetail(info.refusal, "start")
      : info.failureDetail;
  const because = detail === "" ? "" : ` (${detail})`;
  if (!info.started)
    return `${info.name} was already running, and the isolated editor did not start${because}.${journal}`;
  return `Destination ${info.name} did not start${because}; the isolated editor did not start.${journal}`;
}

function editorUnknownDetail(info: StartFailureContext): string {
  if (info.failureDetail !== "") return info.failureDetail;
  return info.editorResult !== undefined &&
    programDetails(info.editorResult)?.timedOut === true
    ? "the editor launcher timed out"
    : "";
}

function unconfirmedOpenMessage(info: StartFailureContext): string {
  const journal = journalUnconfirmedNote(info.effects.inventoryComplete);
  if (info.effects.completed.includes("editor.open")) {
    const prefix = info.started
      ? `Started ${info.name}, which stays running, and the isolated editor started and stopped with exit code ${String(info.editorResult?.exitCode)}.`
      : `${info.name} was already running, and the isolated editor started and stopped with exit code ${String(info.editorResult?.exitCode)}.`;
    return `${prefix}${journal}`;
  }
  const detail = editorUnknownDetail(info);
  const because = detail === "" ? "" : `: ${detail}`;
  if (info.effects.uncertain.includes("editor.open")) {
    const prefix = info.started
      ? `Started ${info.name}, which stays running, but could not confirm that the isolated editor stopped cleanly${because}.`
      : `${info.name} was already running, and doorway could not confirm that the isolated editor stopped cleanly${because}.`;
    return `${prefix}${journal}`;
  }
  const prefix = info.started
    ? `Started ${info.name}, which stays running, but the isolated editor did not start${because}.`
    : `${info.name} was already running, but the isolated editor did not start${because}.`;
  return `${prefix}${journal}`;
}

export function unknownStartClassification(
  failureInfo: StartFailureContext,
  cleared: string,
) {
  const { completed, uncertain } = failureInfo.effects;
  const isEditorStage =
    completed.includes("editor.open") ||
    uncertain.includes("editor.open") ||
    completed.includes("container.start");
  return {
    causeCode: isEditorStage
      ? ("DOMAIN_DOORWAY_OPEN_UNCONFIRMED" as const)
      : ("DOMAIN_DOORWAY_START_UNCONFIRMED" as const),
    message: `${isEditorStage ? unconfirmedOpenMessage(failureInfo) : unconfirmedStartMessage(failureInfo)}${cleared}`,
    attemptedEffect: isEditorStage
      ? ("editor.open" as const)
      : ("container.start" as const),
  };
}

export function completedStartSummary(
  destinationName: string,
  place: string,
  needsStart: boolean,
  cleared: string,
): string {
  return needsStart
    ? `Started ${destinationName} and opened ${place} in the isolated editor. Attachment was not verified; closing the editor leaves the container running.${cleared}`
    : `${destinationName} was already running; opened ${place} in the isolated editor. Attachment was not verified; closing the editor leaves the container running.${cleared}`;
}

export function openFailedMessage(
  destinationName: string,
  exitCode: number | null,
  needsStart: boolean,
  cleared: string,
): string {
  const prefix = needsStart
    ? `Started ${destinationName}, which stays running, but the isolated editor exited with code ${String(exitCode)}.`
    : `${destinationName} was already running, and the isolated editor exited with code ${String(exitCode)}.`;
  return `${prefix} No unfinished case remains; you can run doorway open or doorway start again.${cleared}`;
}
