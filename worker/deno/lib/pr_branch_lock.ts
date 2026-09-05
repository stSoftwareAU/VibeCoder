/**
 * Distributed lock for PR branch updates (Issue #1281).
 *
 * Prevents multiple workers from simultaneously updating the same PR
 * branch by using hidden GitHub comments as a lock mechanism. This is
 * consistent with the CLAIM_LOCK pattern in claim_issue.ts.
 *
 * Lock protocol:
 *   1. Clean up any stale lock comments (expired TTL)
 *   2. Post a hidden lock comment with the worker's unique ID and timestamp
 *   3. Brief pause for GitHub's eventual consistency
 *   4. Re-read the PR's comments to check for competing locks
 *   5. Earliest lock (by created_at) wins; losers clean up and back off
 *
 * Comment format: `<!-- BRANCH_UPDATE_LOCK:worker-id:unix-timestamp -->`
 *
 * **A competing lock only counts when the fleet posted it (Issue #1124).**
 * A PR comment thread on a public repository is open to anyone, so a
 * `BRANCH_UPDATE_LOCK` marker is a claim from a stranger unless the comment
 * **author** says otherwise — and the worker-id and timestamp inside the
 * marker are chosen by whoever typed it. A planted lock with a fresh
 * timestamp never expires, sorts earliest, and stalls every host's branch
 * updates on that PR indefinitely. The re-read therefore carries
 * `.user.login` and competing locks are filtered against the fleet identity
 * (`alert_dedup_authors.ts`).
 *
 * **The fail direction leaves the work claimable.** An unresolvable fleet
 * identity means no competing lock can be attributed, so none is counted
 * and this host takes the lock. Two hosts updating the same branch is a
 * conflict git resolves; a branch no host may ever update is a PR that
 * never merges.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import {
  type AlertDedupAuthorOptions,
  type AlertDedupCommentRow,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The lock marker prefix used in PR comments for branch update locking. */
export const BRANCH_UPDATE_LOCK_PREFIX = "<!-- BRANCH_UPDATE_LOCK:";

/** Default lock TTL in seconds (5 minutes). */
const DEFAULT_LOCK_TTL_SECONDS = 300;

/** Default consistency delay in milliseconds. */
const DEFAULT_CONSISTENCY_DELAY_MS = 3000;

/**
 * Default renewal interval (Issue #3754) — one third of the TTL.
 *
 * A holder whose work outlives the TTL (a 30-minute CI fix against a
 * 5-minute TTL) must refresh its lock rather than raise the TTL: renewal
 * keeps the crash-recovery window at one TTL, so a host that dies mid-run
 * frees the PR within five minutes instead of hours. Renewing at TTL/3
 * means two consecutive renewal failures still leave the lock live.
 */
export const DEFAULT_LOCK_RENEWAL_INTERVAL_MS = 100_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a lock acquisition attempt. */
export interface BranchUpdateLockResult {
  /** Whether the lock was successfully acquired. */
  acquired: boolean;
  /** The comment ID of the lock (for release). Only set when acquired. */
  lockCommentId?: number;
  /** Worker ID of the lock winner (when contention occurred). */
  winnerId?: string;
}

/** Options for acquiring a branch update lock. */
export interface BranchUpdateLockOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number to lock. */
  prNumber: number;
  /** Unique identifier for this worker. */
  workerId: string;
  /** Lock TTL in seconds (default: 300). */
  lockTtlSeconds?: number;
  /** Injected sleep function (for testing). Defaults to real sleep. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injected gh command function (for testing). Defaults to runGhCommand. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Injected time function (for testing). Returns current Unix timestamp in seconds. */
  nowFn?: () => number;
  /**
   * Human-readable line appended under the hidden marker (Issue #3754).
   * An HTML-comment-only body renders as a blank PR comment, so callers
   * pass a sentence saying who holds the lock and why.
   */
  note?: string;
  /**
   * Fleet identity inputs for the competing-lock author check
   * (Issue #1124). Omitted reads the configured fleet, which is what every
   * production caller does.
   */
  authorOptions?: AlertDedupAuthorOptions;
  /** Sink for the author-verification diagnostics. */
  log?: (message: string) => void;
}

/** Options for renewing a held branch update lock (Issue #3754). */
export interface BranchUpdateRenewOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Comment ID of the held lock. */
  lockCommentId: number;
  /** Unique identifier for this worker (must match the held lock). */
  workerId: string;
  /** Human-readable line appended under the hidden marker. */
  note?: string;
  /** Injected gh command function (for testing). Defaults to runGhCommand. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Injected time function (for testing). Returns current Unix timestamp in seconds. */
  nowFn?: () => number;
}

/** Options for scheduling periodic lock renewal (Issue #3754). */
export interface BranchLockRenewalOptions extends BranchUpdateRenewOptions {
  /** Interval between renewals (default: {@link DEFAULT_LOCK_RENEWAL_INTERVAL_MS}). */
  intervalMs?: number;
  /** Called with a message when a renewal fails, so it is never silent. */
  onError?: (message: string) => void;
}

/** Handle for stopping a renewal schedule. */
export interface BranchLockRenewalHandle {
  /** Stop renewing. Safe to call more than once. */
  stop(): void;
}

/** Options for releasing a branch update lock. */
export interface BranchUpdateReleaseOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Comment ID of the lock to release. */
  lockCommentId: number;
  /** Injected gh command function (for testing). Defaults to runGhCommand. */
  ghCommandFn?: (args: string[]) => Promise<string>;
}

/** Options for cleaning stale branch update locks. */
export interface CleanStaleLockOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Lock TTL in seconds (default: 300). */
  lockTtlSeconds?: number;
  /** Injected gh command function (for testing). Defaults to runGhCommand. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Injected time function (for testing). Returns current Unix timestamp in seconds. */
  nowFn?: () => number;
}

/** Parsed lock comment from the GitHub API. */
interface LockComment extends AlertDedupCommentRow {
  id: number;
  body: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Build a lock comment body.
 *
 * Uses hidden HTML comments to avoid noise in the PR timeline.
 */
export function buildLockComment(
  workerId: string,
  timestampSeconds: number,
): string {
  return `${BRANCH_UPDATE_LOCK_PREFIX}${workerId}:${timestampSeconds} -->`;
}

/**
 * Build the full comment body: hidden marker plus an optional visible line.
 *
 * A marker-only body renders as an empty comment on GitHub (Issue #1659),
 * so callers that post locks on a PR timeline supply a `note`.
 */
export function buildLockBody(
  workerId: string,
  timestampSeconds: number,
  note?: string,
): string {
  const marker = buildLockComment(workerId, timestampSeconds);
  return note && note.length > 0 ? `${marker}\n${note}` : marker;
}

/**
 * Parse a lock comment to extract worker ID and timestamp.
 *
 * @returns Parsed data, or null if the comment is not a valid lock marker.
 */
export function parseLockComment(
  body: string,
): { workerId: string; timestamp: number } | null {
  const match = body.match(
    /<!-- BRANCH_UPDATE_LOCK:([^:]+):(\d+) -->/,
  );
  if (!match) return null;

  const workerId = match[1]!;
  const timestamp = parseInt(match[2]!, 10);
  if (isNaN(timestamp)) return null;

  return { workerId, timestamp };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default sleep function — waits the given number of milliseconds.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default now function — returns current Unix timestamp in seconds.
 */
function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Fetch all lock comments on a PR.
 *
 * Uses the GitHub API to retrieve comments matching the lock prefix.
 */
async function fetchLockComments(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<LockComment[]> {
  const commentsJson = await ghCommandFn([
    "api",
    `repos/${repo}/issues/${prNumber}/comments`,
    "--jq",
    `[.[] | select(.body | test("${BRANCH_UPDATE_LOCK_PREFIX}")) | ` +
    `{id: .id, body: .body, created_at: .created_at, author: .user.login}]`,
  ]);

  const parsed: unknown = JSON.parse(commentsJson);
  if (!Array.isArray(parsed)) return [];

  return (parsed as Array<Record<string, unknown>>)
    .filter((c) =>
      typeof c.body === "string" &&
      (c.body as string).includes(BRANCH_UPDATE_LOCK_PREFIX)
    )
    .map((c) => ({
      id: Number(c.id),
      body: String(c.body),
      createdAt: String(c.created_at ?? ""),
      author: typeof c.author === "string" ? c.author : null,
    }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clean up stale branch update lock comments.
 *
 * Removes lock comments whose timestamp is older than the configured TTL.
 * This is best-effort — failures are silently handled to avoid blocking
 * the worker.
 *
 * @param options - Cleanup options
 */
export async function cleanStaleBranchUpdateLocks(
  options: CleanStaleLockOptions,
): Promise<void> {
  const {
    repo,
    prNumber,
    lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS,
    ghCommandFn = runGhCommand,
    nowFn = defaultNow,
  } = options;

  let lockComments: LockComment[];
  try {
    lockComments = await fetchLockComments(repo, prNumber, ghCommandFn);
  } catch {
    return; // Best-effort
  }

  const now = nowFn();

  for (const comment of lockComments) {
    const lockData = parseLockComment(comment.body);
    if (!lockData) continue;

    const age = now - lockData.timestamp;
    if (age >= lockTtlSeconds) {
      try {
        await ghCommandFn([
          "api",
          "-X",
          "DELETE",
          `repos/${repo}/issues/comments/${comment.id}`,
        ]);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

/**
 * Acquire a distributed lock for updating a PR branch.
 *
 * Posts a hidden lock comment on the PR, waits briefly for GitHub's
 * eventual consistency, then verifies no competing locks exist.
 * If multiple workers posted simultaneously, the earliest lock
 * (by created_at timestamp) wins.
 *
 * @param options - Lock acquisition options
 * @returns Result with lock outcome
 */
export async function acquireBranchUpdateLock(
  options: BranchUpdateLockOptions,
): Promise<Result<BranchUpdateLockResult>> {
  const {
    repo,
    prNumber,
    workerId,
    lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS,
    sleepFn = defaultSleep,
    ghCommandFn = runGhCommand,
    nowFn = defaultNow,
    authorOptions = {},
    log = (message: string) => console.warn(message),
  } = options;

  // Step 1: Clean up stale locks from previous runs / crashed workers
  await cleanStaleBranchUpdateLocks({
    repo,
    prNumber,
    lockTtlSeconds,
    ghCommandFn,
    nowFn,
  });

  // Step 2: Post our lock comment
  const now = nowFn();
  const lockCommentBody = buildLockBody(workerId, now, options.note);

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      lockCommentBody,
    ]);
  } catch {
    return { ok: true, value: { acquired: false } };
  }

  // Step 3: Brief pause for GitHub's eventual consistency
  await sleepFn(DEFAULT_CONSISTENCY_DELAY_MS);

  // Step 4: Re-read comments to check for competing locks
  let readLockComments: LockComment[];
  try {
    readLockComments = await fetchLockComments(repo, prNumber, ghCommandFn);
  } catch {
    // Cannot verify — back off to avoid conflicts
    return { ok: true, value: { acquired: false } };
  }

  // Step 4a: A lock the fleet did not post is not a lock (Issue #1124).
  // Our own comment is ours by construction — we posted it moments ago and
  // it carries our worker-id — so it is kept without an author lookup;
  // everything else has to prove who wrote it. Verifying only the
  // competitors means the log names the comments that would otherwise have
  // stalled this branch.
  const ourLocks = readLockComments.filter(
    (c) => parseLockComment(c.body)?.workerId === workerId,
  );
  const competingLocks = await selectFleetAuthoredComments(
    readLockComments.filter(
      (c) => parseLockComment(c.body)?.workerId !== workerId,
    ),
    `branch update lock ${repo}#${prNumber}`,
    authorOptions,
    log,
    "no competing lock is counted and the branch stays updatable — a lock " +
      "marker anyone can post must not stall a PR indefinitely",
  );
  const allLockComments = [...ourLocks, ...competingLocks];

  // Step 5: Determine the winner
  if (allLockComments.length === 0) {
    // Our comment vanished — something unexpected happened
    return { ok: true, value: { acquired: false } };
  }

  if (allLockComments.length === 1) {
    // No contention — we are the sole lock holder
    const soleComment = allLockComments[0]!;
    const lockData = parseLockComment(soleComment.body);
    if (lockData?.workerId === workerId) {
      return {
        ok: true,
        value: { acquired: true, lockCommentId: soleComment.id },
      };
    }
    // The sole lock is not ours — another worker snuck in
    return {
      ok: true,
      value: { acquired: false, winnerId: lockData?.workerId },
    };
  }

  // Multiple locks — earliest created_at wins (consistent with CLAIM_LOCK)
  const sorted = [...allLockComments].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  const winnerComment = sorted[0]!;
  const winnerData = parseLockComment(winnerComment.body);
  const winnerId = winnerData?.workerId ?? "";

  if (winnerId === workerId) {
    // We won the race
    return {
      ok: true,
      value: {
        acquired: true,
        lockCommentId: winnerComment.id,
      },
    };
  }

  // We lost — clean up our lock comment
  const ourComment = allLockComments.find((c) => {
    const data = parseLockComment(c.body);
    return data?.workerId === workerId;
  });

  if (ourComment) {
    try {
      await ghCommandFn([
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/issues/comments/${ourComment.id}`,
      ]);
    } catch {
      // Best-effort cleanup
    }
  }

  return { ok: true, value: { acquired: false, winnerId } };
}

/**
 * Renew a held lock by rewriting its comment with a fresh timestamp
 * (Issue #3754).
 *
 * Work that outlives the TTL — a 30-minute CI fix against a 5-minute TTL —
 * would otherwise be treated as stale and cleaned by a second host, which
 * is exactly the concurrent-fix race this guards against.
 *
 * Fails loud: a renewal failure comes back as `{ ok: false }` so the caller
 * can log it rather than silently continuing on an expiring lock.
 *
 * @param options - Renewal options
 * @returns The new lock timestamp on success
 */
export async function renewBranchUpdateLock(
  options: BranchUpdateRenewOptions,
): Promise<Result<number>> {
  const {
    repo,
    lockCommentId,
    workerId,
    note,
    ghCommandFn = runGhCommand,
    nowFn = defaultNow,
  } = options;

  const timestamp = nowFn();
  try {
    await ghCommandFn([
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/issues/comments/${lockCommentId}`,
      "-f",
      `body=${buildLockBody(workerId, timestamp, note)}`,
    ]);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  return { ok: true, value: timestamp };
}

/**
 * Start renewing a held lock periodically until stopped (Issue #3754).
 *
 * The caller must `stop()` the returned handle on every exit path —
 * alongside releasing the lock — so no timer outlives the work it covers.
 *
 * @param options - Renewal options, including the interval
 * @returns Handle used to stop renewing
 */
export function startBranchUpdateLockRenewal(
  options: BranchLockRenewalOptions,
): BranchLockRenewalHandle {
  const {
    intervalMs = DEFAULT_LOCK_RENEWAL_INTERVAL_MS,
    onError,
    ...renewOptions
  } = options;

  let stopped = false;

  const timer = setInterval(() => {
    renewBranchUpdateLock(renewOptions).then((result) => {
      if (!result.ok && !stopped) {
        onError?.(
          `Failed to renew PR lock comment ${renewOptions.lockCommentId} on ` +
            `${renewOptions.repo}: ${result.error.message}`,
        );
      }
    });
  }, intervalMs);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Release a branch update lock by deleting the lock comment.
 *
 * This should be called after the branch update completes (success or
 * failure) to allow other workers to proceed.
 *
 * Best-effort: if the delete fails, the lock will expire via TTL cleanup.
 *
 * @param options - Release options
 * @returns Result indicating success (always ok — best-effort release)
 */
export async function releaseBranchUpdateLock(
  options: BranchUpdateReleaseOptions,
): Promise<Result<void>> {
  const {
    repo,
    lockCommentId,
    ghCommandFn = runGhCommand,
  } = options;

  try {
    await ghCommandFn([
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/issues/comments/${lockCommentId}`,
    ]);
  } catch {
    // Best-effort — lock will expire via TTL cleanup
  }

  return { ok: true, value: undefined };
}
