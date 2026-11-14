/**
 * The setup phase's potentially blocking steps and the one fixed line each
 * logs as it starts (Issue #5128).
 *
 * A container hard-kill in setup used to report "Last step logged: unknown",
 * because the phase logged only a 60s ticker the report skips as noise. The
 * hard-kill report maps these lines to fixed labels, so a wedge names the step.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { resolveRunHardCap } from "./run_hard_cap.ts";

/**
 * The setup steps, in run order. The names are fixed words, never log or issue
 * text, because the hard-kill report publishes the label on a public issue.
 */
export const SETUP_STEPS = [
  "issue claim",
  "claim churn check",
  "repository setup",
  "heartbeat start",
  "default branch sync",
  "feature branch",
  "pre-setup command",
] as const;

/** One of {@link SETUP_STEPS}. */
export type SetupStep = typeof SETUP_STEPS[number];

/** The line a setup step logs as it starts: `[setup-step] <step>: started`. */
export function setupStepStartLine(step: SetupStep): string {
  return `[setup-step] ${step}: started`;
}

/** Seconds setup may spend on work outside the agent runs (Issue #5128). */
export const SETUP_FIXED_ALLOWANCE_SECONDS = 1800;

/**
 * The shortest deadline the run's hard cap may leave setup (Issue #5128).
 *
 * A setup that starts with almost no runway left is still given this long, so
 * a healthy step is not abandoned the instant it begins; the hard cap's own
 * reserve for the kill grace and the WIP push sits past it.
 */
export const SETUP_MIN_DEADLINE_SECONDS = 60;

/** What {@link setupDeadlineMs} reads besides the config (injected for tests). */
export interface SetupDeadlineInput {
  /** Environment reader for the supervisor's published cap. */
  env?: (name: string) => string | undefined;
  /** Current epoch-ms; defaults to the wall clock. */
  nowMs?: number;
}

/**
 * How long the setup phase may run before the run abandons it (Issue #5128).
 *
 * Setup is not just bounded subprocesses: for a milestone issue the pre-sync
 * runs the conflict-resolution agent for up to `claudeTimeout`
 * (`milestone_presync.ts`, `agentTimeoutMs`), then verifies the gates and may
 * run a repair agent, and the clone alone may take 600s
 * (`DEFAULT_GH_CLONE_TIMEOUT`). The budget is therefore two agent budgets
 * plus a fixed allowance for the clone, git, gates and the pre-setup command,
 * so a slow-but-progressing setup is never abandoned and only a step that has
 * wedged reaches it. On `GRQ-25` one sat in setup for over two hours, holding
 * its claim, until the launcher's watchdog reaped the container.
 *
 * That budget is no use if it outlasts the container, so it is capped by the
 * runway left to the run's hard cap (`run_hard_cap.ts`): the supervisor's
 * deadline less the kill grace and the WIP reserve, which falls before the
 * launcher's watchdog (supervisor cap plus `WATCHDOG_MARGIN_SECONDS`). A
 * setup that starts late, or a large `claude_timeout`, therefore still ends
 * with time to release the claim. With no supervisor cap published
 * (`VIBE_RUN_MAX_SECONDS`/`VIBE_RUN_STARTED_EPOCH` unset or disabled) there
 * is nothing to cap it by and the budget stands.
 */
export function setupDeadlineMs(
  config: { claudeTimeout: number; claudeKillAfter: number },
  input: SetupDeadlineInput = {},
): number {
  const budgetMs = (2 * config.claudeTimeout + SETUP_FIXED_ALLOWANCE_SECONDS) *
    1000;
  const resolution = resolveRunHardCap({
    ...(input.env ? { env: input.env } : {}),
    killAfterSeconds: config.claudeKillAfter,
  });
  if (!resolution.capped) return budgetMs;
  const runwayMs = resolution.cap.ceilingMs - (input.nowMs ?? Date.now());
  return Math.min(
    budgetMs,
    Math.max(SETUP_MIN_DEADLINE_SECONDS * 1000, runwayMs),
  );
}

/**
 * The line an abandoned setup logs as it stops at a step boundary (Issue
 * #5128). It deliberately lacks the `[setup-step]` prefix, so the hard-kill
 * report never reads it as a step that started.
 */
export const SETUP_ABANDONED_LOG_LINE =
  "Setup stopped at a step boundary after its deadline (Issue #5128)";

/** The setup-phase result a run ends with when setup misses its deadline. */
export interface SetupDeadlineFailure {
  status: "failure";
  category: "timeout";
  reason: string;
}

/** What `runSetupWithDeadline` is told about the deadline. */
export interface SetupDeadlineOptions {
  deadlineMs: number;
  /** Called once, synchronously, when the deadline fires and setup is abandoned. */
  onAbandon: () => void;
  /** Arms the deadline; defaults to the real clock. A test drives its own. */
  clock?: Clock;
}

/**
 * Run the setup phase under a deadline (Issue #5128).
 *
 * Returns the phase's own result when it settles first. Otherwise calls
 * `onAbandon` and returns a `timeout` failure: the abandoned setup keeps
 * running until its next step boundary, where it checks the flag `onAbandon`
 * set and returns (see `workOnIssueSetupBranch`). A rejection after the
 * deadline is not awaited by anything, so it is swallowed here.
 */
export async function runSetupWithDeadline<T>(
  setup: () => Promise<T>,
  options: SetupDeadlineOptions,
): Promise<T | SetupDeadlineFailure> {
  const { deadlineMs, onAbandon, clock = systemClock } = options;
  let timer: number | undefined;
  const pending = setup();
  const expired = new Promise<SetupDeadlineFailure>((resolve) => {
    timer = clock.setTimeout(() => {
      onAbandon();
      resolve({
        status: "failure",
        category: "timeout",
        reason: `Setup did not finish within ${
          Math.round(deadlineMs / 60000)
        } minutes, so the run abandoned it (Issue #5128).`,
      });
    }, deadlineMs);
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clock.clearTimeout(timer);
  }
}

/** Matches the ids a claim worker id can contain; it is built from a login and a timestamp. */
const SAFE_WORKER_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Whether this run's own claim comment is on the issue (Issue #5128).
 *
 * A setup abandoned while `claimIssue` is still pending does not know whether
 * the claim was taken. Every fleet host shares one login, so the run may
 * release the claim only when its own `CLAIM_LOCK:<workerId>` comment is
 * there; otherwise an unassign would strip another host's live claim. Any
 * failure to read the comments answers `false`, never "held".
 */
export async function ownClaimCommentPresent(
  ghCommand: (args: string[]) => Promise<string>,
  repo: string,
  issueNumber: number,
  workerId: string,
): Promise<boolean> {
  if (!SAFE_WORKER_ID.test(workerId)) return false;
  try {
    const found = await ghCommand([
      "api",
      "--paginate",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `.[] | select(.body | contains("CLAIM_LOCK:${workerId} -->")) | .id`,
    ]);
    return found.trim() !== "";
  } catch {
    return false;
  }
}
