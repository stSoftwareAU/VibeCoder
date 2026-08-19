/**
 * Idle-task activity collector (Issue #2477).
 *
 * Standalone, injectable module that reports — for a single repo — the
 * most-recent idle-task **raised** epoch and **claimed** epoch. It is the
 * "idle-task" half of the combined 8-hour liveness guard tracked by #2472:
 * a wrapper that is raised but never claimed must NOT count as the fleet
 * doing idle work, so the guard's alive-signal is the *claimed* epoch.
 *
 * This module deliberately has **no import dependency on the liveness
 * guard** so it is buildable and testable before #2472's guard lands. It
 * reuses the canonical constants instead of re-declaring strings:
 *   - `IDLE_TASK_LABEL` from `idle_task_issue.ts` — the label every filed
 *     idle-task wrapper carries.
 *   - `CLAIM_MARKER_PREFIX` from `claim_issue.ts` — the `<!-- CLAIM_LOCK:`
 *     marker posted as a comment when a worker claims an issue.
 *
 * ## Chosen signals (documented precisely per the issue)
 *
 * **Raised** — the most-recent `createdAt` among issues carrying
 * `IDLE_TASK_LABEL`. The query asks for `--state all` (open AND closed)
 * so a wrapper that was claimed and quickly closed still counts as a
 * raise (a fast claim-and-close must not erase the evidence that an idle
 * task was raised at all).
 *
 * **Claimed** — a wrapper counts as claimed when EITHER:
 *   1. it carries a `CLAIM_MARKER_PREFIX` (`<!-- CLAIM_LOCK:`) comment —
 *      the precise claim signal posted by `claimIssue()` at claim time
 *      (`claim_issue.ts` lines 477-484 build the body, 543-552 post it);
 *      the claimed epoch is that comment's `created_at`; OR
 *   2. it is CLOSED — the wrapper-handled close performed by the
 *      in-process idle-task route after the template runs
 *      (`idle_task_process_issue_route.ts` lines 85-94 close the wrapper
 *      with the template summary) is used as a claim **proxy**, and the
 *      claimed epoch is the issue's `closedAt`.
 *
 * For efficiency we resolve the claim epoch without an extra API call when
 * a wrapper is already CLOSED (the close proxy gives us `closedAt` for
 * free). Only OPEN wrappers need a comments lookup to detect an in-flight
 * `CLAIM_LOCK`. Idle-task wrappers are deduped to at most one open per
 * repo (`idle_task_issue.ts`), so this is typically a single extra call.
 *
 * `lastClaimedEpoch` is the maximum claim epoch across all considered
 * wrappers, or `null` when none was claimed.
 *
 * A `gh` failure on the primary issue listing returns
 * `{ lastRaisedEpoch: null, lastClaimedEpoch: null }` — no signal — to
 * match the fail-open convention of the existing gates (e.g.
 * `findExistingIdleTaskIssue`). Per-wrapper comment-lookup failures are
 * best-effort: they leave that wrapper's claim epoch unresolved without
 * discarding signal already gathered from the others.
 *
 * Epochs are **Unix seconds**, matching `claimIssue()`'s
 * `Math.floor(Date.now() / 1000)` convention, so `nowFn` is expected to
 * return seconds.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { CLAIM_MARKER_PREFIX } from "./claim_issue.ts";
import { runGhCommand } from "./github.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default lookback window (seconds) for "recently raised / recently
 * closed". The combined liveness guard reasons over an 8-hour window;
 * this default is a generous superset (30 days) so nothing the guard
 * could care about is dropped, while ancient closed wrappers are excluded
 * so they cannot masquerade as recent activity. Override via
 * `options.windowSeconds`.
 */
export const IDLE_TASK_ACTIVITY_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** Cap on idle-task issues fetched per repo (open + recently closed). */
const ISSUE_FETCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for {@link latestIdleTaskActivity}. */
export interface IdleTaskActivityOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** Injectable `gh` runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Injectable clock returning Unix **seconds**. Defaults to wall clock. */
  nowFn?: () => number;
  /**
   * Lookback window in seconds. Wrappers whose raise/close falls outside
   * `[now - windowSeconds, now]` are ignored. Defaults to
   * {@link IDLE_TASK_ACTIVITY_WINDOW_SECONDS}.
   */
  windowSeconds?: number;
}

/** Result of {@link latestIdleTaskActivity}. */
export interface IdleTaskActivity {
  /** Most-recent idle-task raise (Unix seconds), or null when none. */
  lastRaisedEpoch: number | null;
  /** Most-recent idle-task claim (Unix seconds), or null when none. */
  lastClaimedEpoch: number | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Minimal shape of an idle-task issue from `gh issue list --json`. */
interface IdleTaskIssueRow {
  number: number;
  state: string;
  createdAt: string;
  closedAt: string;
}

/**
 * Parse an ISO-8601 timestamp into Unix **seconds**, or null when the
 * value is missing or unparseable.
 */
function isoToEpochSeconds(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/** Parse the idle-task issue list, dropping malformed rows defensively. */
function parseIdleTaskIssues(raw: string): IdleTaskIssueRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rows: IdleTaskIssueRow[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const number = typeof r.number === "number" ? r.number : null;
    if (number === null) continue;
    rows.push({
      number,
      state: typeof r.state === "string" ? r.state : "",
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
      closedAt: typeof r.closedAt === "string" ? r.closedAt : "",
    });
  }
  return rows;
}

/**
 * Find the most-recent `CLAIM_LOCK` comment epoch on an open wrapper.
 *
 * Best-effort: a `gh` failure or unparseable payload yields null so the
 * caller falls back to "no claim detected" for this wrapper without
 * discarding signal from the others.
 */
async function latestClaimCommentEpoch(
  repo: string,
  issueNumber: number,
  gh: (args: string[]) => Promise<string>,
): Promise<number | null> {
  let raw: string;
  try {
    raw = await gh([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${CLAIM_MARKER_PREFIX}")) | .created_at]`,
    ]);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  let latest: number | null = null;
  for (const value of parsed) {
    if (typeof value !== "string") continue;
    const epoch = isoToEpochSeconds(value);
    if (epoch !== null && (latest === null || epoch > latest)) {
      latest = epoch;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Report the most-recent idle-task raised and claimed epochs for a repo.
 *
 * See the module header for the precise signal definitions and line
 * references. Returns `{ null, null }` when there is no idle-task activity
 * in the window, or when the primary `gh` listing fails.
 */
export async function latestIdleTaskActivity(
  options: IdleTaskActivityOptions,
): Promise<IdleTaskActivity> {
  const {
    repo,
    ghCommandFn = runGhCommand,
    nowFn = () => Math.floor(Date.now() / 1000),
    windowSeconds = IDLE_TASK_ACTIVITY_WINDOW_SECONDS,
  } = options;

  const now = nowFn();
  const cutoff = now - windowSeconds;

  // Primary listing: open AND closed idle-task wrappers. A failure here is
  // "no signal" (fail-open), matching the existing gate conventions.
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      IDLE_TASK_LABEL,
      "--state",
      "all",
      "--json",
      "number,state,createdAt,closedAt",
      "--limit",
      String(ISSUE_FETCH_LIMIT),
    ]);
  } catch {
    return { lastRaisedEpoch: null, lastClaimedEpoch: null };
  }

  const issues = parseIdleTaskIssues(raw);

  let lastRaisedEpoch: number | null = null;
  let lastClaimedEpoch: number | null = null;

  for (const issue of issues) {
    const raisedEpoch = isoToEpochSeconds(issue.createdAt);
    // Ignore wrappers raised outside the window (too old, or future-skewed).
    if (raisedEpoch === null || raisedEpoch < cutoff || raisedEpoch > now) {
      continue;
    }
    if (lastRaisedEpoch === null || raisedEpoch > lastRaisedEpoch) {
      lastRaisedEpoch = raisedEpoch;
    }

    // Claimed signal. A CLOSED wrapper uses the wrapper-handled close as a
    // claim proxy (closedAt); an OPEN wrapper needs a CLAIM_LOCK comment.
    let claimedEpoch: number | null = null;
    if (issue.state.toUpperCase() === "CLOSED") {
      claimedEpoch = isoToEpochSeconds(issue.closedAt);
    } else {
      claimedEpoch = await latestClaimCommentEpoch(
        repo,
        issue.number,
        ghCommandFn,
      );
    }

    if (
      claimedEpoch !== null && claimedEpoch >= cutoff && claimedEpoch <= now
    ) {
      if (lastClaimedEpoch === null || claimedEpoch > lastClaimedEpoch) {
        lastClaimedEpoch = claimedEpoch;
      }
    }
  }

  return { lastRaisedEpoch, lastClaimedEpoch };
}
