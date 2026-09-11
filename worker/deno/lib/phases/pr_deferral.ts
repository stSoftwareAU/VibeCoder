/**
 * Parking the pull request GitHub's secondary rate limit refused (Issue #1951).
 *
 * The completion phase's side of the deferral: how long the run may wait, how
 * the shared `pr_creation` circuit breaker is kept informed so concurrent slots
 * do not pile onto one account's throttle, and what happens when the limit
 * outlasts the run — the record, the `PR pending` note, and the `pr_deferred`
 * outcome that replaces a failure over finished, pushed work.
 *
 * Kept out of `completion_phase.ts`, which is long enough already.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../../types.ts";
import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import {
  calculateOperationSleepInterval,
  CIRCUIT_BREAKER_DEFAULTS,
  type CircuitBreakerConfig,
  recordOperationFailure,
  resetOperation,
} from "../circuit_breaker.ts";
import { resolveRunHardCap } from "../run_hard_cap.ts";
import {
  type DeferredPrRecord,
  formatPrPendingComment,
  recordDeferredPr,
} from "../deferred_pr_store.ts";
import { prDeferredOutcome } from "../run_outcome.ts";

/** The circuit-breaker operation name shared by every PR-creating slot. */
const PR_CREATION_OP = "pr_creation";

/** One line of a refusal — enough to diagnose, short enough to render. */
export function boundRefusalReason(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= 300 ? flat : `${flat.substring(0, 299)}…`;
}

/**
 * The epoch-ms past which this run must not still be waiting on GitHub.
 *
 * The nearest of the supervisor's hard cap, the dispatch watchdog's handler
 * deadline and the cycle deadline — each of them a real kill, and a wait that
 * runs into one loses the very work it was protecting. Undefined when the run
 * is bounded by none of them (CLI single-issue runs, tests), where the backoff
 * schedule itself is the bound.
 */
export function prCreationDeadlineMs(ctx: IssueContext): number | undefined {
  const cap = resolveRunHardCap({
    killAfterSeconds: ctx.config.claudeKillAfter,
  });
  const bounds = [
    cap.capped ? cap.cap.ceilingMs : undefined,
    ctx.handlerDeadlineEpochMs,
    ctx.cycleDeadlineEpochMs,
  ].filter((value): value is number => typeof value === "number");
  return bounds.length === 0 ? undefined : Math.min(...bounds);
}

/** The shared circuit-breaker config for the `pr_creation` operation. */
function breakerConfig(workDir: string): CircuitBreakerConfig {
  return { ...CIRCUIT_BREAKER_DEFAULTS, workDir };
}

/**
 * Tell the shared `pr_creation` circuit breaker about a secondary-limit
 * refusal, and read back the interval it wants.
 *
 * The limit is per *account*, so every slot on this host meets it at once. The
 * breaker's state file is shared between them, which is what stops two slots
 * from each retrying on their own private schedule and keeping the throttle
 * alive. A breaker that cannot be read or written is reported and ignored — it
 * coordinates the wait, it does not authorise it.
 */
export async function recordPrCreationRefusal(
  workDir: string,
  attempt: number,
  message: string,
  logger: Logger,
): Promise<number | undefined> {
  if (!workDir) return undefined;
  try {
    const config = breakerConfig(workDir);
    const recorded = await recordOperationFailure(config, PR_CREATION_OP);
    if (!recorded.ok) {
      logger.warn("Could not record the PR-creation refusal on the breaker", {
        attempt,
        error: recorded.error.message,
      });
      return undefined;
    }
    return calculateOperationSleepInterval(
      recorded.value,
      config.operationBackoffThreshold,
      config.sleepInterval,
      config.creditWaitInterval,
    ) * 1000;
  } catch (err) {
    logger.warn("Could not consult the PR-creation circuit breaker", {
      attempt,
      message,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Clear the `pr_creation` breaker once a create succeeds.
 *
 * Non-fatal — the create has already happened — but never silent: a breaker
 * left counting makes every later slot wait longer than the account's throttle
 * actually needs, and an unreported reset failure is how that becomes a
 * mystery.
 */
export async function resetPrCreationBreaker(
  workDir: string,
  logger: Logger,
): Promise<void> {
  if (!workDir) return;
  try {
    const reset = await resetOperation(breakerConfig(workDir), PR_CREATION_OP);
    if (!reset.ok) {
      logger.warn("Could not reset the PR-creation circuit breaker", {
        error: reset.error.message,
      });
    }
  } catch (err) {
    logger.warn("Could not reset the PR-creation circuit breaker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What the phase knows about the refusal it is parking. */
export interface PrDeferralRequest {
  /** Creation attempts made before giving up. */
  attempts: number;
  /** Milliseconds already spent waiting out the limit. */
  waitedMs: number;
  /** The refusal, as GitHub (or the worker's latch) worded it. */
  message: string;
  /** Why no further wait was taken. */
  why: string;
}

/** The PR the run would have opened. */
export interface PendingPr {
  title: string;
  body: string;
  base: string;
  reviewers: readonly string[];
}

/**
 * Park the PR because GitHub's secondary rate limit outlasted the run.
 *
 * Everything this run was asked to do is done: the change is committed,
 * quality-gated and pushed. The only thing missing is a `gh pr create` that a
 * self-clearing content-creation throttle refused. Recording that as a failure
 * orphaned the branch, returned the issue to the pool for another host to redo,
 * and — because every `rate_limit` mapped to `usage-limit` — filed a GitHub
 * throttle under "the model subscription is spent".
 *
 * So the run parks the PR instead: the record carries the branch, base, title
 * and the body already composed, the issue thread says the PR is pending, and
 * the next cycle's drain raises it with no agent run.
 *
 * A record that cannot be written IS a failure — the next cycle would know
 * nothing about the parked PR, and silently reporting a deferral nobody can act
 * on is exactly the fail-silent shape this codebase refuses.
 */
export async function deferPrCreation(
  request: PrDeferralRequest,
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  pr: PendingPr,
): Promise<PhaseResult> {
  const { repo, issueNumber, config } = ctx;
  const logger = deps.logger;
  const record: DeferredPrRecord = {
    repo,
    issueNumber,
    branch: state.branchName,
    base: pr.base,
    title: pr.title,
    body: pr.body,
    ...(pr.reviewers.length > 0 ? { reviewers: [...pr.reviewers] } : {}),
    deferredAtEpoch: Math.floor(Date.now() / 1000),
    attempts: request.attempts,
    lastError: boundRefusalReason(request.message),
  };

  const stored = config.workDir
    ? await recordDeferredPr(config.workDir, record)
    : {
      ok: false as const,
      error: new Error(
        "no work directory configured — a deferred PR cannot be parked",
      ),
    };
  if (!stored.ok) {
    logger.error(
      "Could not park the deferred PR — reporting the secondary-limit " +
        "refusal as a failure rather than promising a PR nothing will raise",
      { repo, issueNumber, error: stored.error.message },
    );
    return {
      status: "failure",
      reason: `PR creation failed: ${request.message}`,
    };
  }

  logger.warn(
    "PR creation deferred — GitHub's secondary (content-creation) rate " +
      "limit outlasted this run (Issue #1951)",
    {
      repo,
      issueNumber,
      branch: state.branchName,
      base: pr.base,
      attempts: request.attempts,
      waitedSeconds: Math.round(request.waitedMs / 1000),
      why: request.why,
      record: stored.value,
    },
  );

  try {
    const client = deps.github.createClient(logger);
    await client.postComment(repo, issueNumber, formatPrPendingComment(record));
  } catch (err) {
    logger.warn(
      `Could not comment the pending-PR note on ${repo}#${issueNumber} — the ` +
        `work is still on '${state.branchName}' and the PR is still parked: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }

  return {
    status: "early_exit",
    reason:
      `PR deferred by GitHub's secondary rate limit (${request.why}); the ` +
      `work is on ${state.branchName} and the PR is queued`,
    outcome: prDeferredOutcome({
      phase: "completion",
      branch: state.branchName,
      base: pr.base,
      reason: boundRefusalReason(request.message),
    }),
  };
}
