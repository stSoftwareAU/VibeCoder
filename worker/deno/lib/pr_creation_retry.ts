/**
 * Minute-scale retry around `gh pr create` for GitHub's secondary
 * (content-creation) rate limit (Issue #1951).
 *
 * `runGhCommand`'s generic retry gives a refused create 2 s / 4 s / 8 s and
 * then gives up — roughly fourteen seconds against a limit GitHub asks you to
 * wait "a few minutes" for. The run then recorded a failure over finished,
 * pushed work. This loop waits in minutes instead, honours `Retry-After` where
 * GitHub sends one, keeps the shared `pr_creation` circuit breaker informed so
 * concurrent slots on one host do not pile back onto the same limit, and stops
 * cleanly — `deferred` — when the next wait would not fit inside the run.
 *
 * Everything that is not the secondary limit is returned as `failed`
 * untouched, so the primary-quota REST fallback and every ordinary create
 * failure behave exactly as they did.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  isSecondaryOnlyRateLimitMessage,
  planSecondaryLimitWait,
  SECONDARY_RATE_LIMIT_DELAYS_MS,
} from "./secondary_rate_limit.ts";
import { isPrimaryRateLimitMessage } from "./primary_quota_latch.ts";

/** What one bounded creation attempt sequence produced. */
export type PrCreationAttempt =
  | { kind: "created"; prUrl: string; attempts: number }
  /** The secondary limit held for the whole affordable wait. */
  | {
    kind: "deferred";
    attempts: number;
    waitedMs: number;
    message: string;
    why: string;
  }
  /** Anything else — handled by the caller exactly as before. */
  | { kind: "failed"; error: Error; attempts: number };

/** Injection seams for {@link createPrWithSecondaryLimitBackoff}. */
export interface PrCreationBackoffDeps {
  /** Creates the PR; throws on refusal. Returns the created PR URL. */
  createPr: () => Promise<string>;
  /** Sleep; injected so tests never wait a real minute. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Clock; epoch-ms. */
  nowMs?: () => number;
  /** Epoch-ms past which the run must not still be waiting. */
  deadlineMs?: number;
  /** Backoff steps; defaults to 60 s / 120 s / 240 s. */
  delaysMs?: readonly number[];
  /**
   * Called after each secondary-limit refusal. Returns a coordinated floor
   * in milliseconds (the shared `pr_creation` circuit breaker's interval),
   * or `undefined` when there is none.
   */
  onRefusal?: (attempt: number, message: string) => Promise<number | undefined>;
  /** Called once the create succeeds, so the breaker can reset. */
  onSuccess?: () => Promise<void>;
  /** Log sink for the waits — an unexplained minute of silence is worse. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** Default sleep. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a PR, waiting out GitHub's secondary rate limit in minutes.
 *
 * @returns `created` with the PR URL, `deferred` when the limit outlasted the
 *   run's budget, or `failed` for any other error.
 */
export async function createPrWithSecondaryLimitBackoff(
  deps: PrCreationBackoffDeps,
): Promise<PrCreationAttempt> {
  const sleepFn = deps.sleepFn ?? defaultSleep;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const delays = deps.delaysMs ?? SECONDARY_RATE_LIMIT_DELAYS_MS;
  let waitedMs = 0;

  for (let attempt = 1;; attempt++) {
    try {
      const prUrl = (await deps.createPr()).trim();
      if (deps.onSuccess) await deps.onSuccess();
      return { kind: "created", prUrl, attempts: attempt };
    } catch (thrown) {
      const error = thrown instanceof Error
        ? thrown
        : new Error(String(thrown));
      // A message the primary path recognises — the latch's own cool-down
      // skip names both limits — is handed back untouched, so the Issue #42
      // REST fallback still opens the PR at once instead of waiting minutes
      // for a limit it has a way round.
      if (
        !isSecondaryOnlyRateLimitMessage(
          error.message,
          isPrimaryRateLimitMessage,
        )
      ) {
        return { kind: "failed", error, attempts: attempt };
      }

      const coordinatedFloorMs = deps.onRefusal
        ? await deps.onRefusal(attempt, error.message)
        : undefined;
      const plan = planSecondaryLimitWait({
        attempt,
        message: error.message,
        nowMs: nowMs(),
        ...(deps.deadlineMs !== undefined
          ? { deadlineMs: deps.deadlineMs }
          : {}),
        ...(coordinatedFloorMs !== undefined ? { coordinatedFloorMs } : {}),
        delaysMs: delays,
      });
      if (!plan.wait) {
        return {
          kind: "deferred",
          attempts: attempt,
          waitedMs,
          message: error.message,
          why: plan.why,
        };
      }

      deps.log?.(
        "PR creation refused by GitHub's secondary (content-creation) rate " +
          "limit — waiting before the next attempt (Issue #1951)",
        {
          attempt,
          delaySeconds: Math.round(plan.delayMs / 1000),
          source: plan.source,
        },
      );
      await sleepFn(plan.delayMs);
      waitedMs += plan.delayMs;
    }
  }
}
