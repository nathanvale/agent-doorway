import { commonCauses } from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";

export const cli = "doorway";

export const unchangedSuccess =
  "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;
export const completedSuccess =
  "SUCCESS_COMPLETED" satisfies keyof typeof commonCauses;

const refusedNext = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "next",
} as const;

const refusedHandoff = { ...refusedNext, guidance: "handoff" } as const;

export const causes = {
  ...commonCauses,
  DOMAIN_DOORWAY_SETTINGS_MISSING: refusedNext,
  DOMAIN_DOORWAY_SETTINGS_INVALID: refusedNext,
  DOMAIN_DOORWAY_DESTINATION_UNKNOWN: refusedNext,
  DOMAIN_DOORWAY_PLACE_INVALID: refusedNext,
  DOMAIN_DOORWAY_EDITOR_FOLDERS_MISSING: refusedNext,
  DOMAIN_DOORWAY_TOOL_UNAVAILABLE: refusedNext,
  DOMAIN_DOORWAY_REMOTE_HOST_UNREACHABLE: refusedNext,
  DOMAIN_DOORWAY_REMOTE_COMMAND_FAILED: refusedNext,
  DOMAIN_DOORWAY_DESTINATION_MISSING: refusedNext,
  DOMAIN_DOORWAY_DESTINATION_REPLACED: refusedNext,
  DOMAIN_DOORWAY_DESTINATION_STOPPED: refusedNext,
  DOMAIN_DOORWAY_START_NOT_ALLOWED: refusedNext,
  DOMAIN_DOORWAY_START_STATE_UNSUPPORTED: refusedNext,
  DOMAIN_DOORWAY_DESTINATION_HELD: refusedHandoff,
  DOMAIN_DOORWAY_DESTINATION_UNRESOLVED: refusedHandoff,
  DOMAIN_DOORWAY_STATE_UNAVAILABLE: refusedHandoff,
  DOMAIN_DOORWAY_START_EDITOR_FAILED: {
    outcome: "failed",
    transactionState: "partially-completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_DOORWAY_START_UNCONFIRMED: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_DOORWAY_OPEN_FAILED: {
    outcome: "failed",
    transactionState: "completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_DOORWAY_OPEN_UNCONFIRMED: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
} as const satisfies CauseTable;

export const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

export const nothingChanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

export const stationWords = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;
