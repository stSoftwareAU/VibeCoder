/**
 * Live PR state re-read at the claim point (Issue #1774).
 *
 * The four PR passes — CI fix, review feedback, merge conflict and auto-merge
 * — all select their work from the 10-minute listing cache in
 * `issue_cache.ts`. That cache is what makes a 2.5-minute cycle affordable,
 * but it means a PR closed *after* the listing was taken still looks open to
 * every pass that reads it, and the only freshness check any of them made was
 * "does the head branch still exist on origin".
 *
 * VibeCoder#1732 is the case this module exists for: it was closed as
 * superseded, and eight minutes later the CI-fix pass claimed it out of a
 * cached listing, took the cross-host lock, posted the lock comment and ran an
 * agent against work nobody wanted. Every write that pass makes — the push,
 * the claim comment, the `needs-human` label — lands on a dead PR.
 *
 * The fix is one `gh pr view --json state` per claim, taken *before* the first
 * write. The listing cache is untouched; the cost is one round trip on the
 * path that was about to spend an agent run.
 *
 * **An unreadable state is never "open".** `gh` failing, a network blip or a
 * state string nobody recognises all return `{ unknown: true }`, and every
 * caller skips the PR for this cycle — without spending a retry, an attempt or
 * a deferral, so nothing is lost by waiting for the next scan. That is the
 * fail-loud choice in both directions: the skip is logged with the error, and
 * the pass never guesses that a PR it could not read is safe to write to.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  classifyPrLiveState,
  makeGhPrStateFetcher,
} from "./pr_branch_update.ts";
import type { LogContext, Logger } from "../types.ts";

/** The two live states that mean "do not write to this PR". */
export type ClosedPrState = "CLOSED" | "MERGED";

/**
 * A reading that means "do not write to this PR": it is closed or merged, or
 * its state could not be read at all.
 */
export type PrNotOpenReading =
  | { open: false; state: ClosedPrState; unknown?: undefined }
  | { open?: undefined; unknown: true; error: string };

/**
 * What one `gh pr view --json state` said about a PR.
 *
 * The optional `undefined` members are what let a caller narrow with a plain
 * `if (state.unknown)` / `if (state.open)` — the reading is checked at four
 * claim points, and a union that needs an `in` test at each of them is a union
 * someone eventually gets wrong.
 */
export type PrLiveStateReading =
  | { open: true; unknown?: undefined }
  | PrNotOpenReading;

/** Run a `gh` command and return its stdout. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/**
 * True when these `gh` args are this module's own live-state read.
 *
 * Lives beside the call it recognises so a mock fleet and the real argv
 * cannot drift: `createMockDeps` answers exactly this shape with `OPEN`, and
 * the test fixtures use it through `tests/support/pr_live_state_stub.ts`.
 */
export function isPrLiveStateRead(args: readonly string[]): boolean {
  return args[0] === "pr" && args[1] === "view" && args.includes("state");
}

/**
 * Read a PR's live state, bypassing every cache.
 *
 * @param repo - Repository in `owner/repo` format.
 * @param prNumber - PR number.
 * @param gh - `gh` runner (injectable so tests need no network).
 * @returns Open, closed/merged, or unknown — never a guess.
 */
export async function readPrLiveState(
  repo: string,
  prNumber: number,
  gh: GhCommandFn,
): Promise<PrLiveStateReading> {
  let raw: string;
  try {
    // The same argv the branch-update pass asks with (Issue #386), so the two
    // readers of a PR's state cannot drift apart.
    raw = await makeGhPrStateFetcher(gh)(repo, prNumber);
  } catch (error) {
    return {
      unknown: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const state = classifyPrLiveState(raw);
  if (state === "OPEN") return { open: true };
  if (state === "CLOSED" || state === "MERGED") return { open: false, state };
  return {
    unknown: true,
    error: `gh pr view returned an unrecognised state: ${
      JSON.stringify(raw.trim())
    }`,
  };
}

/**
 * The one-line reason a pass stood down, as the log records it.
 *
 * `skipped: PR closed` and `skipped: PR merged` are the two lines a stall
 * investigation greps for; the unknown line is deliberately worded differently
 * so "we know it is dead" and "we could not tell" never read the same.
 */
export function prLiveSkipReason(reading: PrNotOpenReading): string {
  if (reading.unknown) return "skipped: PR state unknown";
  return reading.state === "MERGED"
    ? "skipped: PR merged"
    : "skipped: PR closed";
}

/**
 * Log one pass's stand-down, the same way for all four of them.
 *
 * A closed or merged PR is ordinary and goes out at INFO; a state that could
 * not be read is loud, because a pass that silently stops claiming every cycle
 * is exactly the failure this module was written to prevent.
 *
 * @param logger - The pass's logger.
 * @param pass - Which pass stood down (e.g. `"CI fix"`).
 * @param repo - Repository in `owner/repo` format.
 * @param prNumber - PR number.
 * @param reading - The not-open reading that caused the skip.
 */
export function logPrLiveSkip(
  logger: Pick<Logger, "info" | "warn">,
  pass: string,
  repo: string,
  prNumber: number,
  reading: PrNotOpenReading,
): void {
  const message = `${pass}: ${prLiveSkipReason(reading)}`;
  const context: LogContext = { repo, prNumber, pass };
  if (reading.unknown) {
    logger.warn(message, { ...context, error: reading.error });
  } else {
    logger.info(message, { ...context, state: reading.state });
  }
}

/** Inputs for {@link guardPrStillOpen}. */
export interface PrLiveGuardOptions {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Which pass is claiming, for the log record (e.g. `"CI fix"`). */
  pass: string;
  /** `gh` runner. */
  gh: GhCommandFn;
  /** Logger — the skip is never silent. */
  logger: Pick<Logger, "info" | "warn">;
}

/**
 * Re-read a PR's state at the claim point and log the skip when it is not open.
 *
 * The caller proceeds only on `reading.open === true`; both other readings are
 * a skip, already logged by the time this returns.
 *
 * @returns The reading, so the caller can word its own summary.
 */
export async function guardPrStillOpen(
  options: PrLiveGuardOptions,
): Promise<PrLiveStateReading> {
  const { repo, prNumber, pass, gh, logger } = options;
  const reading = await readPrLiveState(repo, prNumber, gh);
  if (!reading.open) logPrLiveSkip(logger, pass, repo, prNumber, reading);
  return reading;
}
