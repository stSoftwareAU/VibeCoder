/**
 * Process-wide primary-GraphQL-quota latch (Issue #42).
 *
 * When GitHub's *primary* GraphQL quota is exhausted, every further
 * GraphQL-backed `gh` call in the window is guaranteed to fail with
 * `API rate limit already exceeded` — yet the PR-maintenance scans catch
 * that per-repo/per-author and log-and-continue (correct for an ordinary
 * failure), so the worker kept spawning hundreds of doomed `gh` processes
 * for minutes until Stale-Workflow Detection finally threw. Each doomed
 * call still costs a spawn, a retry decision, a log line, and counts toward
 * GitHub's secondary/abuse limits.
 *
 * This module is the fix: the first time any `gh` invocation reports the
 * primary-quota message, {@link latchPrimaryQuota} records the reset time,
 * and {@link isPrimaryQuotaLatched} lets the shared chokepoint
 * (`github.ts` `runGhCommandRaw`) short-circuit every subsequent
 * GraphQL-backed call — no spawn, no retry, no secondary-limit cost — until
 * the quota resets. The chokepoint also writes the shared rate-limit signal
 * so the existing Issue #1780 mid-cycle pause engages at the next pass.
 *
 * The latch is a module-global: it lives for the life of the worker process
 * and auto-expires the instant the recorded reset passes, so a stale latch
 * can never outlast the quota window.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/** The epoch (Unix seconds) the primary quota is latched until, or null. */
let latchedUntilEpoch: number | null = null;

/** Current wall-clock in Unix seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Detect the primary GitHub rate-limit message variants we treat as
 * self-healing (Issue #1523, #1780, #42). Secondary rate limits and 5xx
 * errors continue down the fatal path.
 *
 * Single source of truth for the signal — `run_core.ts` re-exports this so
 * the cycle loop pauses on exactly what the chokepoint latches on.
 */
export function isPrimaryRateLimitMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("api rate limit already exceeded") ||
    lower.includes("api rate limit exceeded") ||
    lower.includes("rate limit has been exceeded")
  );
}

/**
 * Whether a `gh` invocation is exempt from the primary-GraphQL-quota latch.
 *
 * The exhausted budget is the *GraphQL* primary quota; the REST (core) quota
 * is a separate bucket that is typically still healthy. So the only calls
 * the latch must short-circuit are GraphQL-backed ones — every `gh`
 * subcommand (`gh pr list`, `gh issue list`, …, which is what drove the
 * doomed-call storm) and the explicit `gh api graphql` endpoint. A plain
 * `gh api <rest-path>` call rides the core quota and stays callable, so:
 *   - `gh api rate_limit` can still read the reset (the latch learns when to
 *     lift), and
 *   - a finished run can still release its claim via the REST assignees
 *     endpoint even while GraphQL is exhausted (Issue #42 Defect 3).
 */
export function isQuotaExemptGhCall(args: readonly string[]): boolean {
  if (args[0] !== "api") return false;
  // `gh api graphql …` is a GraphQL call — never exempt. Any other
  // `gh api <rest-path>` hits the separate core REST quota.
  return !args.includes("graphql");
}

/**
 * Whether the primary GraphQL quota is currently latched as exhausted.
 *
 * Auto-expires: once the recorded reset is reached the latch clears itself,
 * so a call the instant after reset is allowed straight through.
 *
 * @param now - Injectable time source (Unix seconds) for testing.
 */
export function isPrimaryQuotaLatched(now: number = nowSeconds()): boolean {
  if (latchedUntilEpoch === null) return false;
  if (now >= latchedUntilEpoch) {
    latchedUntilEpoch = null;
    return false;
  }
  return true;
}

/** The epoch the latch holds until, or null when not latched. */
export function primaryQuotaLatchedUntil(): number | null {
  return latchedUntilEpoch;
}

/**
 * Latch the primary GraphQL quota as exhausted until `resetEpoch`.
 *
 * Never shortens an existing latch — a later reset always wins, so a second
 * exhaustion partway through the window cannot lift the latch early.
 * A reset at or before now is ignored (nothing to latch).
 *
 * @param resetEpoch - When the quota resets (Unix seconds).
 * @param now - Injectable time source (Unix seconds) for testing.
 */
export function latchPrimaryQuota(
  resetEpoch: number,
  now: number = nowSeconds(),
): void {
  if (!Number.isFinite(resetEpoch) || resetEpoch <= now) return;
  latchedUntilEpoch = latchedUntilEpoch === null
    ? resetEpoch
    : Math.max(latchedUntilEpoch, resetEpoch);
}

/** Clear the latch (on a confirmed reset, or between tests). */
export function clearPrimaryQuotaLatch(): void {
  latchedUntilEpoch = null;
}
