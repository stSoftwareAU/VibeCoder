/**
 * In-process retry helper for transient infrastructure failures (Issue #1550).
 *
 * Infrastructure-category failures (zero_output, rate_limit, internal_error,
 * push_failure, missing_tools) are typically caused by environment or tooling
 * problems, not by the issue itself. Before falling through to the
 * `handleIssueFailure` path — which applies the `failed-once` label — we give
 * the failing phase one bounded retry with backoff. A success on the retry
 * means we do not surface the transient blip to the issue, keeping
 * `failed-once` reserved for genuine work problems.
 *
 * The retry count is tracked per phase on `PhaseState.infraRetryCounts`, so a
 * single workOnIssue invocation retries each phase at most once.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import type { PhaseState } from "./issue_worker_types.ts";
import {
  detectFailureCategory,
  isInfrastructureFailure,
} from "./failure_diagnosis.ts";
import { primaryQuotaLatchedUntil } from "./primary_quota_latch.ts";

/** Default backoff before an in-process infra retry. */
export const DEFAULT_INFRA_RETRY_BACKOFF_MS = 15_000;

/** Maximum in-process retries per phase per issue. */
export const MAX_INFRA_RETRIES_PER_PHASE = 1;

/**
 * Least cycle runway (seconds) an in-process retry needs to be worth a
 * billed start (VibeCoder#174). Observed live: a 795 s deadline-bound
 * execute timed out, was retried with the 60 s execute floor, and the doomed
 * retry's "no changes" verdict replaced the real outcome (WIP preserved).
 */
export const MIN_INFRA_RETRY_RUNWAY_SECONDS = 300;

/**
 * True when the cycle deadline (if any) leaves at least
 * {@link MIN_INFRA_RETRY_RUNWAY_SECONDS} for a retry. No deadline (CLI
 * single-issue runs, tests) means unbounded runway.
 */
export function hasRunwayForInfraRetry(
  cycleDeadlineEpochMs: number | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (cycleDeadlineEpochMs === undefined) return true;
  return cycleDeadlineEpochMs - nowMs >= MIN_INFRA_RETRY_RUNWAY_SECONDS * 1000;
}

/**
 * Margin added to a quota-reset wait so the retry lands after the reset,
 * not on it (Issue #2150).
 */
export const RATE_LIMIT_RESET_MARGIN_MS = 5_000;

/** Options for `shouldRetryInfrastructureFailure`. */
export interface InfraRetryOptions {
  /** Backoff in milliseconds before the retry. Defaults to 15s. */
  backoffMs?: number;
  /**
   * The cycle deadline, when the run has one. A `rate_limit` retry that
   * must wait for the quota reset only happens when the wait plus
   * {@link MIN_INFRA_RETRY_RUNWAY_SECONDS} fits before it (Issue #2150).
   */
  cycleDeadlineEpochMs?: number;
  /** Time source (Unix milliseconds) — injectable for tests. */
  nowMs?: () => number;
  /**
   * When the primary GraphQL quota latch holds until (Unix seconds), or
   * null — injectable for tests; defaults to the live latch.
   */
  quotaResetEpochSeconds?: () => number | null;
  /** Sleep implementation — injectable for tests. Defaults to setTimeout. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Optional abort signal to cancel the backoff sleep early. */
  abortSignal?: AbortSignal;
}

/** Default sleep — wraps setTimeout in a promise, honours AbortSignal. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const handle = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Decide whether a phase failure should trigger an in-process retry.
 *
 * Returns `true` if:
 *   - `failureReason` classifies as an infrastructure category
 *     (`isInfrastructureFailure(detectFailureCategory(reason))`), AND
 *   - that category is not `token_scope` — a missing OAuth scope is the
 *     host's credential, not a transient blip, so no backoff can fix it
 *     (Issue #1952), AND
 *   - the phase has not already been retried in this workOnIssue invocation
 *     (tracked via `state.infraRetryCounts[phase]`).
 *
 * When returning `true`, this function:
 *   1. Increments the per-phase retry counter on `state`.
 *   2. Logs the retry via `logger.warn` with category and attempt number.
 *   3. Awaits a bounded backoff (`backoffMs`, default 15s) before returning.
 *
 * The caller is expected to re-run the failing phase body on `true`.
 *
 * Otherwise returns `false` and the caller must fall through to the normal
 * failure path (typically `handleIssueFailure`).
 */
export async function shouldRetryInfrastructureFailure(
  phase: string,
  failureReason: string,
  state: PhaseState,
  logger: Logger,
  options: InfraRetryOptions = {},
): Promise<boolean> {
  const category = detectFailureCategory(failureReason);
  if (!isInfrastructureFailure(category)) {
    return false;
  }

  // Issue #1952: a token without the `workflow` scope is infrastructure — the
  // issue is released for a host whose token can push it — but it is not
  // transient. Re-running the phase re-pushes the same branch with the same
  // credential and meets the same refusal, so the failure stands after one
  // attempt, with the operator fix already in its message.
  if (category === "token_scope") {
    logger.warn("Not retrying: a missing OAuth scope is not transient", {
      phase,
      category,
    });
    return false;
  }

  if (!state.infraRetryCounts) {
    state.infraRetryCounts = {};
  }
  const prior = state.infraRetryCounts[phase] ?? 0;
  if (prior >= MAX_INFRA_RETRIES_PER_PHASE) {
    return false;
  }

  let backoffMs = options.backoffMs ?? DEFAULT_INFRA_RETRY_BACKOFF_MS;

  // Issue #2150: a rate-limited phase retried 15 s later meets the same
  // latch — on NEAT-AI-core#673 the reset was 17 minutes away and the run
  // was failed with its PR already merged. When the latch names the reset,
  // the retry waits for it; when that wait does not fit the cycle's runway,
  // there is no retry to have, and the release reason already names the
  // reset for the next cycle.
  if (category === "rate_limit") {
    const resetEpoch = (options.quotaResetEpochSeconds ??
      primaryQuotaLatchedUntil)();
    const now = options.nowMs?.() ?? Date.now();
    if (resetEpoch !== null) {
      const waitMs = resetEpoch * 1000 - now + RATE_LIMIT_RESET_MARGIN_MS;
      if (waitMs > backoffMs) {
        const deadline = options.cycleDeadlineEpochMs;
        if (
          deadline !== undefined &&
          now + waitMs + MIN_INFRA_RETRY_RUNWAY_SECONDS * 1000 > deadline
        ) {
          logger.warn(
            "Not retrying: the GraphQL quota resets after this cycle's runway",
            {
              phase,
              category,
              resetInSeconds: Math.round((resetEpoch * 1000 - now) / 1000),
              runwaySeconds: Math.round((deadline - now) / 1000),
            },
          );
          return false;
        }
        backoffMs = waitMs;
        logger.warn(
          "Waiting for the GraphQL quota reset before the retry (Issue #2150)",
          { phase, category, waitSeconds: Math.round(waitMs / 1000) },
        );
      }
    }
  }

  const attempt = prior + 1;
  state.infraRetryCounts[phase] = attempt;
  logger.warn("Retrying infrastructure failure in-process", {
    phase,
    category,
    attempt,
  });

  const sleepFn = options.sleepFn ??
    ((ms: number) => defaultSleep(ms, options.abortSignal));
  await sleepFn(backoffMs);
  return true;
}

/**
 * Reset the infra retry counter for a specific phase.
 *
 * Exposed for tests and for edge cases where the caller wants to manually
 * reset the counter (e.g., after a higher-level recovery step).
 */
export function resetInfraRetryCount(state: PhaseState, phase: string): void {
  if (state.infraRetryCounts) {
    delete state.infraRetryCounts[phase];
  }
}
