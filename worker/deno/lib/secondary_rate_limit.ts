/**
 * GitHub's **secondary** (content-creation / abuse-detection) rate limit,
 * recognised distinctly from the primary hourly quota (Issue #1951).
 *
 * The two limits look alike in a `gh` error and behave nothing alike. The
 * primary quota is an hourly budget with a published reset, handled by
 * `primary_quota_latch.ts` and — for PR creation — worked around over REST.
 * The secondary limit is a short, self-clearing burst throttle on *content
 * creation*: GitHub refuses the write and asks for "a few minutes" before
 * more content is created, and the REST endpoint is refused just as the
 * GraphQL one is.
 *
 * `retry.ts` already treats the wording as retryable, but its 2s/4s/8s
 * budget (~14 s in total) expires long before the limit clears, so a
 * finished, quality-gated, already-pushed run was recorded as a failure with
 * its branch orphaned. This module supplies the two pure decisions the
 * minute-scale wait needs: *is this the secondary limit*, and *how long to
 * wait next* — honouring `Retry-After` where GitHub sends one and otherwise
 * stepping 60 s / 120 s / 240 s, always bounded by the run's own deadline.
 *
 * Pure: no `Deno.*`, no network, no clock of its own.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** The minute-scale steps taken when GitHub sends no `Retry-After`. */
export const SECONDARY_RATE_LIMIT_DELAYS_MS: readonly number[] = [
  60_000,
  120_000,
  240_000,
];

/**
 * Longest `Retry-After` honoured, in seconds.
 *
 * A header asking for longer than half an hour is not a wait a run can serve
 * — the deferral path is the right answer there, and clamping keeps a
 * malformed or hostile header from parking the run for its whole budget.
 */
export const MAX_RETRY_AFTER_SECONDS = 1800;

/**
 * The wording GitHub uses when the secondary limit refuses a write, plus the
 * worker's own cool-down skip message (`primary_quota_latch.ts`), which
 * names the same limit.
 *
 * Deliberately narrow: the primary quota's "API rate limit exceeded" must
 * NOT match, because that refusal has a REST way round it and this one does
 * not.
 */
const SECONDARY_RATE_LIMIT_RE =
  /secondary rate limit|abuse detection|temporarily blocked from content creation|was submitted too quickly/i;

/** Whether an error message reports GitHub's secondary (burst) rate limit. */
export function isSecondaryRateLimitMessage(message: string): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  return SECONDARY_RATE_LIMIT_RE.test(message);
}

/**
 * Whether a message is the secondary limit **and nothing else** — in
 * particular, not the worker's own latched cool-down.
 *
 * `primaryQuotaSkipMessage()` names the secondary limit *and* carries the
 * primary quota's phrase, because the latch is shared. That message has a
 * working answer already: `gh api` is exempt from the latch, so the Issue #42
 * REST fallback opens the PR immediately. Waiting minutes for it — and then
 * deferring — would be strictly worse than the behaviour it replaced, so the
 * minute-scale loop stands aside for anything the primary path recognises.
 *
 * @param isPrimary - The primary-quota predicate, injected to keep this module
 *   free of the latch (which imports the `gh` chokepoint).
 */
export function isSecondaryOnlyRateLimitMessage(
  message: string,
  isPrimary: (message: string) => boolean,
): boolean {
  return isSecondaryRateLimitMessage(message) && !isPrimary(message);
}

/**
 * The `Retry-After` GitHub asked for, in seconds, or `null` when it sent
 * none (or sent something that is not a plain number of seconds).
 *
 * Clamped to {@link MAX_RETRY_AFTER_SECONDS}; a zero or negative value is
 * read as "no usable header" so the caller falls back to its own schedule
 * rather than retrying instantly into the same refusal.
 */
export function parseRetryAfterSeconds(message: string): number | null {
  if (typeof message !== "string") return null;
  const match = message.match(/retry[-\s]?after\s*[:=]?\s*(\d{1,7})\b/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/** Inputs to {@link planSecondaryLimitWait}. */
export interface SecondaryLimitWaitInput {
  /** 1-based number of the attempt that was just refused. */
  attempt: number;
  /** The refusal text — read for a `Retry-After`. */
  message: string;
  /** Now, epoch-ms. */
  nowMs: number;
  /**
   * Epoch-ms past which the run must not still be waiting (the run hard cap,
   * the handler deadline — whichever is nearest). Omitted → unbounded.
   */
  deadlineMs?: number;
  /**
   * A floor supplied by the shared `pr_creation` circuit breaker, in
   * milliseconds, so concurrent slots on one host do not pile back onto a
   * limit one of them has already met.
   */
  coordinatedFloorMs?: number;
  /** Backoff steps; defaults to {@link SECONDARY_RATE_LIMIT_DELAYS_MS}. */
  delaysMs?: readonly number[];
  /**
   * Work the run still has to do after the create succeeds (linking the PR,
   * labels, the release comment). Held back inside the deadline so a wait
   * never consumes the window that publishes the result.
   */
  reserveMs?: number;
}

/** Seconds held back for the post-create finalisation. */
export const POST_CREATE_RESERVE_MS = 30_000;

/** Whether to wait again, and for how long. */
export type SecondaryLimitWaitPlan =
  | { wait: true; delayMs: number; source: "retry-after" | "backoff" }
  | { wait: false; why: string };

/**
 * Decide the wait after a secondary-limit refusal.
 *
 * `Retry-After` wins when GitHub sends one — it is the limit telling us when
 * it clears — but never shortens the coordinated floor. A wait that would
 * run past the deadline is refused rather than truncated: the caller defers
 * the PR, which preserves the work, where a truncated wait would simply meet
 * the same refusal with less budget left.
 */
export function planSecondaryLimitWait(
  input: SecondaryLimitWaitInput,
): SecondaryLimitWaitPlan {
  const delays = input.delaysMs ?? SECONDARY_RATE_LIMIT_DELAYS_MS;
  if (input.attempt < 1 || input.attempt > delays.length) {
    return {
      wait: false,
      why: `the ${delays.length}-step secondary-limit backoff is exhausted`,
    };
  }

  const retryAfter = parseRetryAfterSeconds(input.message);
  const base = retryAfter !== null
    ? retryAfter * 1000
    : delays[input.attempt - 1]!;
  const delayMs = Math.max(base, input.coordinatedFloorMs ?? 0);

  const reserveMs = input.reserveMs ?? POST_CREATE_RESERVE_MS;
  if (
    input.deadlineMs !== undefined &&
    input.nowMs + delayMs + reserveMs > input.deadlineMs
  ) {
    const leftMs = Math.max(0, input.deadlineMs - input.nowMs);
    return {
      wait: false,
      why: `a ${Math.round(delayMs / 1000)}s wait does not fit the ` +
        `${Math.round(leftMs / 1000)}s left in this run`,
    };
  }

  return {
    wait: true,
    delayMs,
    source: retryAfter !== null ? "retry-after" : "backoff",
  };
}
