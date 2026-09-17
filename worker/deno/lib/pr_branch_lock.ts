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
 * **A busy thread must not blind the lock (Issue #2265).** The comment read
 * is paginated: the unpaginated call returned only the 30 oldest comments,
 * so once a PR thread outgrew one page the sweep saw no locks to expire and
 * the verification read could not see the comment this host had just posted.
 * Every cycle then posted one more lock, acquired nothing, and left the
 * comment behind — 765 of them on NEAT-AI-Lamarck#239, a branch no host
 * could update, and a human asked to sort it out. Three rules keep that from
 * recurring: the read is paginated, the posted comment is deleted on every
 * not-acquired path, and an expired marker is ignored when the winner is
 * chosen so a delete that never succeeded cannot wedge the PR.
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

/**
 * Stale lock comments deleted in one sweep (Issue #2265).
 *
 * A thread that accumulated a backlog while the read was blind holds
 * hundreds of expired markers, and deleting them all would turn one cycle
 * into hundreds of serial API calls before any branch update started. The
 * backlog drains a pass at a time; nothing waits on it, because an expired
 * marker is already ignored when the winner is chosen.
 */
export const DEFAULT_MAX_STALE_LOCK_DELETIONS = 100;

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
  /**
   * Deletions attempted in this pass (default:
   * {@link DEFAULT_MAX_STALE_LOCK_DELETIONS}).
   */
  maxDeletions?: number;
  /**
   * Sink for sweep diagnostics (Issue #2265). The sweep stays best-effort,
   * but a read it could not make and a delete it could not make are said out
   * loud — silence is how 765 lock comments accumulated unnoticed.
   */
  log?: (message: string) => void;
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
 * The comment id in the URL `gh issue comment` prints, or null (Issue #1249).
 *
 * `gh` writes the new comment's URL to stdout —
 * `https://github.com/o/r/issues/5#issuecomment-2412345678` — and that
 * fragment is the only *authenticated* statement about which comment in the
 * thread this worker just wrote. Exported for the regression test; a payload
 * with no fragment yields null, and the caller then declines the lock rather
 * than guessing.
 *
 * @param ghOutput - Raw stdout from `gh issue comment`
 * @returns The comment id, or null when the output carries no fragment
 */
export function parsePostedCommentId(ghOutput: string): number | null {
  const match = /#issuecomment-(\d+)/.exec(ghOutput ?? "");
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Flatten what `gh api --paginate --jq '[…]'` prints (Issue #2265).
 *
 * `--paginate` applies the filter to each page in turn, so the payload is
 * one JSON array per line rather than a single array — and `--slurp`, which
 * would merge them, is refused alongside `--jq`. A malformed line throws:
 * an unreadable page is a failure the caller must handle, never an empty
 * result standing in for "no locks".
 *
 * Exported for the regression test.
 *
 * @param payload - Raw stdout from the paginated comment read
 * @returns Every lock comment across every page, in page order
 */
export function parseLockCommentPages(payload: string): LockComment[] {
  const rows: LockComment[] = [];

  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) continue;

    for (const entry of parsed as Array<Record<string, unknown>>) {
      if (
        typeof entry.body !== "string" ||
        !entry.body.includes(BRANCH_UPDATE_LOCK_PREFIX)
      ) {
        continue;
      }
      rows.push({
        id: Number(entry.id),
        body: entry.body,
        createdAt: String(entry.created_at ?? ""),
        author: typeof entry.author === "string" ? entry.author : null,
      });
    }
  }

  return rows;
}

/**
 * Fetch all lock comments on a PR, across every page (Issue #2265).
 *
 * The read is paginated because a PR thread is unbounded: the default page
 * of 30 comments hid every lock on a busy PR, which left the sweep with
 * nothing to expire and stopped a host recognising its own lock comment.
 */
async function fetchLockComments(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<LockComment[]> {
  const payload = await ghCommandFn([
    "api",
    "--paginate",
    `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    "--jq",
    `[.[] | select(.body | test("${BRANCH_UPDATE_LOCK_PREFIX}")) | ` +
    `{id: .id, body: .body, created_at: .created_at, author: .user.login}]`,
  ]);

  return parseLockCommentPages(payload);
}

/**
 * Delete one lock comment, reporting the failure rather than hiding it.
 *
 * @returns The error when the delete failed, or null when it succeeded
 */
async function deleteLockComment(
  repo: string,
  commentId: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Error | null> {
  try {
    await ghCommandFn([
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/issues/comments/${commentId}`,
    ]);
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clean up stale branch update lock comments.
 *
 * Removes lock comments whose timestamp is older than the configured TTL,
 * up to `maxDeletions` in one pass. Best-effort — the sweep never throws —
 * but never silent: a read or a delete it could not make is logged, because
 * a sweep that quietly did nothing is how a PR collects 765 lock comments
 * (Issue #2265).
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
    maxDeletions = DEFAULT_MAX_STALE_LOCK_DELETIONS,
    log = (message: string) => console.warn(message),
  } = options;

  const where = `[pr-branch-lock] ${repo}#${prNumber}:`;

  let lockComments: LockComment[];
  try {
    lockComments = await fetchLockComments(repo, prNumber, ghCommandFn);
  } catch (err) {
    log(
      `${where} could not read the lock comments, so no stale lock was ` +
        `expired this pass — ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return; // Best-effort
  }

  const now = nowFn();
  const stale = lockComments.filter((comment) => {
    const lockData = parseLockComment(comment.body);
    return lockData !== null && now - lockData.timestamp >= lockTtlSeconds;
  });

  for (const comment of stale.slice(0, maxDeletions)) {
    const error = await deleteLockComment(repo, comment.id, ghCommandFn);
    if (error) {
      log(
        `${where} could not delete stale lock comment ${comment.id} — ` +
          `${error.message}`,
      );
    }
  }

  if (stale.length > maxDeletions) {
    log(
      `${where} ${stale.length - maxDeletions} stale lock comment(s) remain ` +
        `after this pass's ${maxDeletions}; the next pass clears more ` +
        `(Issue #2265)`,
    );
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

  const where = `[pr-branch-lock] ${repo}#${prNumber}:`;

  // Step 1: Clean up stale locks from previous runs / crashed workers
  await cleanStaleBranchUpdateLocks({
    repo,
    prNumber,
    lockTtlSeconds,
    ghCommandFn,
    nowFn,
    log,
  });

  // Step 2: Post our lock comment
  const now = nowFn();
  const lockCommentBody = buildLockBody(workerId, now, options.note);

  // `gh issue comment` prints the new comment's URL, whose
  // `#issuecomment-<id>` fragment identifies the comment we just posted.
  // That id — not the worker id inside the body — is what makes a lock
  // ours (Issue #1249, finding 6).
  let ownLockCommentId: number | null = null;
  try {
    const posted = await ghCommandFn([
      "issue",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      lockCommentBody,
    ]);
    ownLockCommentId = parsePostedCommentId(posted);
  } catch {
    return { ok: true, value: { acquired: false } };
  }

  /**
   * Take back the comment posted moments ago (Issue #2265).
   *
   * Every not-acquired return after the post used to leave it on the PR,
   * so a host that could never acquire added one comment per cycle for
   * ever. Nothing but the winner's own lock belongs on the thread.
   */
  const dropOwnLockComment = async (): Promise<void> => {
    if (ownLockCommentId === null) return;
    const error = await deleteLockComment(
      repo,
      ownLockCommentId,
      ghCommandFn,
    );
    if (error) {
      log(
        `${where} could not delete this host's own lock comment ` +
          `${ownLockCommentId} — the stale sweep clears it once the TTL ` +
          `passes: ${error.message}`,
      );
    }
  };

  // Step 3: Brief pause for GitHub's eventual consistency
  await sleepFn(DEFAULT_CONSISTENCY_DELAY_MS);

  // Step 4: Re-read comments to check for competing locks
  let readLockComments: LockComment[];
  try {
    readLockComments = await fetchLockComments(repo, prNumber, ghCommandFn);
  } catch {
    // Cannot verify — back off to avoid conflicts, taking our comment with us
    await dropOwnLockComment();
    return { ok: true, value: { acquired: false } };
  }

  // Step 4a: A lock the fleet did not post is not a lock (Issue #1124).
  //
  // Ours is the comment whose **id** GitHub returned when we posted it
  // moments ago (Issue #1249, finding 6). Matching on the worker id inside
  // the body was never evidence we wrote it: the id is `name@hostname` and is
  // printed verbatim into every public lock comment, so replaying it with an
  // earlier timestamp made a stranger's comment read as ours — and two
  // workers both reported `acquired: true`, defeating the mutual exclusion
  // this module exists for. Everything that is not that comment has to prove
  // who wrote it, so the log still names the comments that would otherwise
  // have stalled this branch.
  //
  // No id back from `gh` means nothing in the thread can be established as
  // ours, so the lock is not taken this cycle: a mutual-exclusion primitive
  // that cannot identify its own holder must fail closed, and the branch
  // update is simply retried on the next scan.
  if (ownLockCommentId === null) {
    log(
      `${where} gh returned no comment URL for ` +
        `the lock comment, so this worker cannot identify its own lock — ` +
        `not acquiring; the stale sweep clears the comment once the TTL ` +
        `passes and the branch update retries next cycle (Issue #1249).`,
    );
    return { ok: true, value: { acquired: false } };
  }

  const isOurs = (c: LockComment) => c.id === ownLockCommentId;
  const ourLocks = readLockComments.filter(isOurs);
  const fleetLocks = await selectFleetAuthoredComments(
    readLockComments.filter((c) => !isOurs(c)),
    `branch update lock ${repo}#${prNumber}`,
    authorOptions,
    log,
    "no competing lock is counted and the branch stays updatable — a lock " +
      "marker anyone can post must not stall a PR indefinitely",
  );

  // An expired marker is not a competing lock, however long it lingers
  // (Issue #2265). The sweep above is best-effort, so a delete that never
  // succeeded would otherwise win every race for ever — it always sorts
  // earliest — and no host could update the branch again.
  const competingLocks = fleetLocks.filter((c) => {
    const lockData = parseLockComment(c.body);
    return lockData !== null && now - lockData.timestamp < lockTtlSeconds;
  });
  const allLockComments = [...ourLocks, ...competingLocks];

  // Step 5: Determine the winner
  if (allLockComments.length === 0) {
    // Our comment vanished — something unexpected happened
    await dropOwnLockComment();
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
    await dropOwnLockComment();
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

  // We lost — clean up our lock comment. It is identified by the id GitHub
  // returned when we posted it, not by the worker id inside a body anyone
  // may copy (Issue #1249).
  await dropOwnLockComment();

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
