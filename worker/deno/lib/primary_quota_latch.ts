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
 * (`gh_spawn.ts` `spawnGh`, since Issue #1485 — every `gh` process in the
 * worker passes it) short-circuit every subsequent GraphQL-backed call — no
 * spawn, no retry, no secondary-limit cost — until the quota resets. Since
 * Issue #1540 the same chokepoint is where the refusal is *recognised*: it
 * hands the first one to the hook `github.ts` registers, which probes the
 * reset, latches, and writes the shared rate-limit signal so the existing
 * Issue #1780 mid-cycle pause engages at the next pass. Before that only
 * `runGhCommandRaw`'s own catch could latch, and a refusal seen by one of
 * the thirty-odd modules that spawn `gh` directly latched nothing.
 *
 * The latch is a module-global: it lives for the life of the worker process
 * and auto-expires the instant the recorded reset passes, so a stale latch
 * can never outlast the quota window.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { formatRateLimitReset } from "./rate_limit_signal.ts";

/** The epoch (Unix seconds) the primary quota is latched until, or null. */
let latchedUntilEpoch: number | null = null;

/**
 * Why the latch is held: the hourly primary quota being spent, or a
 * secondary (burst) limit's short cool-down (Issue #1456). The skip message
 * names which, so an operator reading the log knows whether to expect a
 * minute's pause or an hour's.
 */
export type PrimaryQuotaLatchKind = "primary" | "secondary";

/** The kind of the current latch; meaningless while not latched. */
let latchKind: PrimaryQuotaLatchKind = "primary";

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
 * @param kind - Whether this is the hourly quota or a burst cool-down.
 */
export function latchPrimaryQuota(
  resetEpoch: number,
  now: number = nowSeconds(),
  kind: PrimaryQuotaLatchKind = "primary",
): void {
  if (!Number.isFinite(resetEpoch) || resetEpoch <= now) return;
  latchedUntilEpoch = latchedUntilEpoch === null
    ? resetEpoch
    : Math.max(latchedUntilEpoch, resetEpoch);
  latchKind = kind;
}

/** Clear the latch (on a confirmed reset, or between tests). */
export function clearPrimaryQuotaLatch(): void {
  latchedUntilEpoch = null;
  latchKind = "primary";
}

/**
 * The one-line reason a latched `gh` call is skipped, naming the reset.
 *
 * Carries the primary-quota phrase so callers that classify by message
 * (the scans' log lines, the Issue #1780 pause) still recognise it. Lives
 * here, beside the latch, so the spawn chokepoint can produce it without
 * importing `github.ts` (which imports the chokepoint).
 *
 * @param now - Injectable time source (Unix seconds) for testing.
 */
export function primaryQuotaSkipMessage(now: number = nowSeconds()): string {
  const until = primaryQuotaLatchedUntil();
  const eta = until === null
    ? "reset time unknown"
    : formatRateLimitReset(until, now);
  return latchKind === "secondary"
    ? `gh command skipped: GitHub secondary rate limit cool-down (API rate ` +
      `limit already exceeded on a burst, hourly quota still available) — ${eta}`
    : `gh command skipped: GraphQL primary quota exhausted (API rate ` +
      `limit already exceeded) — ${eta}`;
}
