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

/** Default backoff before an in-process infra retry. */
export const DEFAULT_INFRA_RETRY_BACKOFF_MS = 15_000;

/** Maximum in-process retries per phase per issue. */
export const MAX_INFRA_RETRIES_PER_PHASE = 1;

/** Options for `shouldRetryInfrastructureFailure`. */
export interface InfraRetryOptions {
  /** Backoff in milliseconds before the retry. Defaults to 15s. */
  backoffMs?: number;
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

  if (!state.infraRetryCounts) {
    state.infraRetryCounts = {};
  }
  const prior = state.infraRetryCounts[phase] ?? 0;
  if (prior >= MAX_INFRA_RETRIES_PER_PHASE) {
    return false;
  }

  const attempt = prior + 1;
  state.infraRetryCounts[phase] = attempt;
  logger.warn("Retrying infrastructure failure in-process", {
    phase,
    category,
    attempt,
  });

  const backoffMs = options.backoffMs ?? DEFAULT_INFRA_RETRY_BACKOFF_MS;
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
