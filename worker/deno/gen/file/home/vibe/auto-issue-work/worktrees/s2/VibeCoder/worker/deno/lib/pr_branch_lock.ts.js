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
 */ import { runGhCommand } from "./github.ts";
import { selectFleetAuthoredComments } from "./alert_dedup_authors.ts";
import { deleteIssueComment, fetchMarkerComments, parseMarkerCommentPages } from "./marker_comment_pages.ts";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
function lockPrefix(kind) {
  if (kind === "completion") return "<!-- COMPLETION_ADMISSION_LOCK:";
  return kind === "branch" ? BRANCH_UPDATE_LOCK_PREFIX : "<!-- BASE_REFRESH_LOCK_4613:";
}
/** The lock marker prefix used in PR comments for branch update locking. */ export const BRANCH_UPDATE_LOCK_PREFIX = "<!-- BRANCH_UPDATE_LOCK:";
/** Default lock TTL in seconds (5 minutes). */ export const DEFAULT_LOCK_TTL_SECONDS = 300;
/** Default consistency delay in milliseconds. */ const DEFAULT_CONSISTENCY_DELAY_MS = 3000;
/**
 * Default renewal interval (Issue #3754) — one third of the TTL.
 *
 * A holder whose work outlives the TTL (a 30-minute CI fix against a
 * 5-minute TTL) must refresh its lock rather than raise the TTL: renewal
 * keeps the crash-recovery window at one TTL, so a host that dies mid-run
 * frees the PR within five minutes instead of hours. Renewing at TTL/3
 * means two consecutive renewal failures still leave the lock live.
 */ export const DEFAULT_LOCK_RENEWAL_INTERVAL_MS = 100_000;
/**
 * Stale lock comments deleted in one sweep (Issue #2265).
 *
 * A thread that accumulated a backlog while the read was blind holds
 * hundreds of expired markers, and deleting them all would turn one cycle
 * into hundreds of serial API calls before any branch update started. The
 * backlog drains a pass at a time; nothing waits on it, because an expired
 * marker is already ignored when the winner is chosen.
 */ export const DEFAULT_MAX_STALE_LOCK_DELETIONS = 100;
// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------
/**
 * Build a lock comment body.
 *
 * Uses hidden HTML comments to avoid noise in the PR timeline.
 */ export function buildLockComment(workerId, timestampSeconds, lockKind = "branch") {
  return `${lockPrefix(lockKind)}${workerId}:${timestampSeconds} -->`;
}
/**
 * Build the full comment body: hidden marker plus an optional visible line.
 *
 * A marker-only body renders as an empty comment on GitHub (Issue #1659),
 * so callers that post locks on a PR timeline supply a `note`.
 */ export function buildLockBody(workerId, timestampSeconds, note, lockKind = "branch") {
  const marker = buildLockComment(workerId, timestampSeconds, lockKind);
  return note && note.length > 0 ? `${marker}\n${note}` : marker;
}
/**
 * Parse a lock comment to extract worker ID and timestamp.
 *
 * @returns Parsed data, or null if the comment is not a valid lock marker.
 */ export function parseLockComment(body, lockKind = "branch") {
  const marker = body.indexOf(lockPrefix(lockKind));
  if (marker < 0) return null;
  const match = /^([^:]+):(\d+) -->/.exec(body.slice(marker + lockPrefix(lockKind).length));
  if (!match) return null;
  const workerId = match[1];
  const timestamp = parseInt(match[2], 10);
  if (isNaN(timestamp)) return null;
  return {
    workerId,
    timestamp
  };
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Default sleep function — waits the given number of milliseconds.
 */ function defaultSleep(ms) {
  return new Promise((resolve)=>setTimeout(resolve, ms));
}
/**
 * Default now function — returns current Unix timestamp in seconds.
 */ function defaultNow() {
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
 */ export function parsePostedCommentId(ghOutput) {
  const match = /#issuecomment-(\d+)/.exec(ghOutput ?? "");
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
/**
 * Flatten what `gh api --paginate --jq '[…]'` prints (Issue #2265).
 *
 * The lock's view of {@link parseMarkerCommentPages}, which the PR-comment
 * claim reads the same way (Issue #2266). Exported for the regression test.
 *
 * @param payload - Raw stdout from the paginated comment read
 * @returns Every lock comment across every page, in page order
 */ export function parseLockCommentPages(payload) {
  return parseMarkerCommentPages(payload, BRANCH_UPDATE_LOCK_PREFIX);
}
/**
 * Fetch all lock comments on a PR, across every page (Issue #2265).
 *
 * The read is paginated because a PR thread is unbounded: the default page
 * of 30 comments hid every lock on a busy PR, which left the sweep with
 * nothing to expire and stopped a host recognising its own lock comment.
 */ function fetchLockComments(repo, prNumber, ghCommandFn, lockKind = "branch") {
  return fetchMarkerComments(repo, prNumber, lockPrefix(lockKind), ghCommandFn);
}
/**
 * Delete one lock comment, reporting the failure rather than hiding it.
 *
 * @returns The error when the delete failed, or null when it succeeded
 */ function deleteLockComment(repo, commentId, ghCommandFn) {
  return deleteIssueComment(repo, commentId, ghCommandFn);
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
 */ export async function cleanStaleBranchUpdateLocks(options) {
  const { repo, prNumber, lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS, lockKind = "branch", ghCommandFn = runGhCommand, nowFn = defaultNow, maxDeletions = DEFAULT_MAX_STALE_LOCK_DELETIONS, log = (message)=>console.warn(message) } = options;
  const where = `[pr-branch-lock] ${repo}#${prNumber}:`;
  let lockComments;
  try {
    lockComments = await fetchLockComments(repo, prNumber, ghCommandFn, lockKind);
  } catch (err) {
    log(`${where} could not read the lock comments, so no stale lock was ` + `expired this pass — ${err instanceof Error ? err.message : String(err)}`);
    return; // Best-effort
  }
  const now = nowFn();
  const stale = lockComments.filter((comment)=>{
    const lockData = parseLockComment(comment.body, lockKind);
    return lockData !== null && now - lockData.timestamp >= lockTtlSeconds;
  });
  for (const comment of stale.slice(0, maxDeletions)){
    const error = await deleteLockComment(repo, comment.id, ghCommandFn);
    if (error) {
      log(`${where} could not delete stale lock comment ${comment.id} — ` + `${error.message}`);
    }
  }
  if (stale.length > maxDeletions) {
    log(`${where} ${stale.length - maxDeletions} stale lock comment(s) remain ` + `after this pass's ${maxDeletions}; the next pass clears more ` + `(Issue #2265)`);
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
 */ /**
 * The worker id of a lock that is still inside its TTL, or null when none is.
 *
 * A lock the fleet did not post is not a lock (Issue #1124): the worker id
 * and timestamp inside the marker are whatever the commenter typed, and a
 * future timestamp never expires. An untrusted marker is ignored, the same
 * way {@link acquireBranchUpdateLock} ignores one. A read that fails returns
 * null and is logged: the caller then proceeds as if the lock were free,
 * which is the same answer a missing thread gives.
 */ export async function activeBranchUpdateLockHolder(options) {
  const { repo, prNumber, ghCommandFn = runGhCommand, nowFn = defaultNow, lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS, log = (message)=>console.warn(message), authorOptions = {} } = options;
  let lockComments;
  try {
    lockComments = await fetchLockComments(repo, prNumber, ghCommandFn);
  } catch (err) {
    log(`[pr-branch-lock] ${repo}#${prNumber}: could not read the lock ` + `comments — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const fleetLocks = await selectFleetAuthoredComments(lockComments, `branch update lock ${repo}#${prNumber}`, authorOptions, log, "no lock is counted and the milestone sync proceeds — a lock marker " + "anyone can post must not stall a PR indefinitely");
  const now = nowFn();
  for (const comment of fleetLocks){
    const lockData = parseLockComment(comment.body);
    if (lockData !== null && now - lockData.timestamp < lockTtlSeconds) {
      return lockData.workerId;
    }
  }
  return null;
}
/**
 * Whether a fleet-authored PR lock is still inside its TTL (Issue #2965).
 *
 * The milestone sync's production `prUpdateLockHeldFn`. True only for a
 * fresh lock a fleet account wrote; an untrusted marker, an expired marker
 * and a read that fails are all "not held".
 */ export async function prUpdateLockIsHeld(repo, prNumber, options = {}) {
  const holder = await activeBranchUpdateLockHolder({
    repo,
    prNumber,
    ...options
  });
  return holder !== null;
}
export async function acquireBranchUpdateLock(options) {
  const { repo, prNumber, workerId, lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS, lockKind = "branch", sleepFn = defaultSleep, ghCommandFn = runGhCommand, nowFn = defaultNow, authorOptions = {}, log = (message)=>console.warn(message) } = options;
  const where = `[pr-branch-lock] ${repo}#${prNumber}:`;
  // Step 1: Clean up stale locks from previous runs / crashed workers
  await cleanStaleBranchUpdateLocks({
    repo,
    prNumber,
    lockTtlSeconds,
    lockKind,
    ghCommandFn,
    nowFn,
    log
  });
  // Step 2: Post our lock comment
  const now = nowFn();
  const lockCommentBody = buildLockBody(workerId, now, options.note, lockKind);
  // `gh issue comment` prints the new comment's URL, whose
  // `#issuecomment-<id>` fragment identifies the comment we just posted.
  // That id — not the worker id inside the body — is what makes a lock
  // ours (Issue #1249, finding 6).
  let ownLockCommentId = null;
  try {
    const posted = await ghCommandFn([
      "issue",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      lockCommentBody
    ]);
    ownLockCommentId = parsePostedCommentId(posted);
  } catch  {
    return {
      ok: true,
      value: {
        acquired: false
      }
    };
  }
  /**
   * Take back the comment posted moments ago (Issue #2265).
   *
   * Every not-acquired return after the post used to leave it on the PR,
   * so a host that could never acquire added one comment per cycle for
   * ever. Nothing but the winner's own lock belongs on the thread.
   */ const dropOwnLockComment = async ()=>{
    if (ownLockCommentId === null) return;
    const error = await deleteLockComment(repo, ownLockCommentId, ghCommandFn);
    if (error) {
      log(`${where} could not delete this host's own lock comment ` + `${ownLockCommentId} — the stale sweep clears it once the TTL ` + `passes: ${error.message}`);
    }
  };
  // Step 3: Brief pause for GitHub's eventual consistency
  await sleepFn(DEFAULT_CONSISTENCY_DELAY_MS);
  // Step 4: Re-read comments to check for competing locks
  let readLockComments;
  try {
    readLockComments = await fetchLockComments(repo, prNumber, ghCommandFn, lockKind);
  } catch  {
    // Cannot verify — back off to avoid conflicts, taking our comment with us
    await dropOwnLockComment();
    return {
      ok: true,
      value: {
        acquired: false
      }
    };
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
    log(`${where} gh returned no comment URL for ` + `the lock comment, so this worker cannot identify its own lock — ` + `not acquiring; the stale sweep clears the comment once the TTL ` + `passes and the branch update retries next cycle (Issue #1249).`);
    return {
      ok: true,
      value: {
        acquired: false
      }
    };
  }
  const isOurs = (c)=>c.id === ownLockCommentId;
  const ourLocks = readLockComments.filter(isOurs);
  const fleetLocks = await selectFleetAuthoredComments(readLockComments.filter((c)=>!isOurs(c)), `branch update lock ${repo}#${prNumber}`, authorOptions, log, "no competing lock is counted and the branch stays updatable — a lock " + "marker anyone can post must not stall a PR indefinitely");
  // An expired marker is not a competing lock, however long it lingers
  // (Issue #2265). The sweep above is best-effort, so a delete that never
  // succeeded would otherwise win every race for ever — it always sorts
  // earliest — and no host could update the branch again.
  const competingLocks = fleetLocks.filter((c)=>{
    const lockData = parseLockComment(c.body, lockKind);
    return lockData !== null && now - lockData.timestamp < lockTtlSeconds;
  });
  const allLockComments = [
    ...ourLocks,
    ...competingLocks
  ];
  // Step 5: Determine the winner
  if (allLockComments.length === 0) {
    // Our comment vanished — something unexpected happened
    await dropOwnLockComment();
    return {
      ok: true,
      value: {
        acquired: false
      }
    };
  }
  if (allLockComments.length === 1) {
    // No contention — we are the sole lock holder
    const soleComment = allLockComments[0];
    const lockData = parseLockComment(soleComment.body, lockKind);
    if (lockData?.workerId === workerId) {
      return {
        ok: true,
        value: {
          acquired: true,
          lockCommentId: soleComment.id
        }
      };
    }
    // The sole lock is not ours — another worker snuck in
    await dropOwnLockComment();
    return {
      ok: true,
      value: {
        acquired: false,
        winnerId: lockData?.workerId,
        ...lockData ? {
          winnerLockedAt: lockData.timestamp
        } : {}
      }
    };
  }
  // Multiple locks — earliest created_at wins (consistent with CLAIM_LOCK)
  const sorted = [
    ...allLockComments
  ].sort((a, b)=>a.createdAt.localeCompare(b.createdAt));
  const winnerComment = sorted[0];
  const winnerData = parseLockComment(winnerComment.body, lockKind);
  const winnerId = winnerData?.workerId ?? "";
  if (winnerId === workerId) {
    // We won the race
    return {
      ok: true,
      value: {
        acquired: true,
        lockCommentId: winnerComment.id
      }
    };
  }
  // We lost — clean up our lock comment. It is identified by the id GitHub
  // returned when we posted it, not by the worker id inside a body anyone
  // may copy (Issue #1249).
  await dropOwnLockComment();
  return {
    ok: true,
    value: {
      acquired: false,
      winnerId,
      ...winnerData ? {
        winnerLockedAt: winnerData.timestamp
      } : {}
    }
  };
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
 */ export async function renewBranchUpdateLock(options) {
  const { repo, lockCommentId, workerId, note, ghCommandFn = runGhCommand, nowFn = defaultNow } = options;
  const timestamp = nowFn();
  try {
    await ghCommandFn([
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/issues/comments/${lockCommentId}`,
      "-f",
      `body=${buildLockBody(workerId, timestamp, note)}`
    ]);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
  return {
    ok: true,
    value: timestamp
  };
}
/**
 * Start renewing a held lock periodically until stopped (Issue #3754).
 *
 * The caller must `stop()` the returned handle on every exit path —
 * alongside releasing the lock — so no timer outlives the work it covers.
 *
 * @param options - Renewal options, including the interval
 * @returns Handle used to stop renewing
 */ export function startBranchUpdateLockRenewal(options) {
  const { intervalMs = DEFAULT_LOCK_RENEWAL_INTERVAL_MS, onError, ...renewOptions } = options;
  let stopped = false;
  const timer = setInterval(()=>{
    renewBranchUpdateLock(renewOptions).then((result)=>{
      if (!result.ok && !stopped) {
        onError?.(`Failed to renew PR lock comment ${renewOptions.lockCommentId} on ` + `${renewOptions.repo}: ${result.error.message}`);
      }
    });
  }, intervalMs);
  return {
    stop () {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    }
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
 */ export async function releaseBranchUpdateLock(options) {
  const { repo, lockCommentId, ghCommandFn = runGhCommand } = options;
  try {
    await ghCommandFn([
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/issues/comments/${lockCommentId}`
    ]);
  } catch  {
  // Best-effort — lock will expire via TTL cleanup
  }
  return {
    ok: true,
    value: undefined
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcl9icmFuY2hfbG9jay50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERpc3RyaWJ1dGVkIGxvY2sgZm9yIFBSIGJyYW5jaCB1cGRhdGVzIChJc3N1ZSAjMTI4MSkuXG4gKlxuICogUHJldmVudHMgbXVsdGlwbGUgd29ya2VycyBmcm9tIHNpbXVsdGFuZW91c2x5IHVwZGF0aW5nIHRoZSBzYW1lIFBSXG4gKiBicmFuY2ggYnkgdXNpbmcgaGlkZGVuIEdpdEh1YiBjb21tZW50cyBhcyBhIGxvY2sgbWVjaGFuaXNtLiBUaGlzIGlzXG4gKiBjb25zaXN0ZW50IHdpdGggdGhlIENMQUlNX0xPQ0sgcGF0dGVybiBpbiBjbGFpbV9pc3N1ZS50cy5cbiAqXG4gKiBMb2NrIHByb3RvY29sOlxuICogICAxLiBDbGVhbiB1cCBhbnkgc3RhbGUgbG9jayBjb21tZW50cyAoZXhwaXJlZCBUVEwpXG4gKiAgIDIuIFBvc3QgYSBoaWRkZW4gbG9jayBjb21tZW50IHdpdGggdGhlIHdvcmtlcidzIHVuaXF1ZSBJRCBhbmQgdGltZXN0YW1wXG4gKiAgIDMuIEJyaWVmIHBhdXNlIGZvciBHaXRIdWIncyBldmVudHVhbCBjb25zaXN0ZW5jeVxuICogICA0LiBSZS1yZWFkIHRoZSBQUidzIGNvbW1lbnRzIHRvIGNoZWNrIGZvciBjb21wZXRpbmcgbG9ja3NcbiAqICAgNS4gRWFybGllc3QgbG9jayAoYnkgY3JlYXRlZF9hdCkgd2luczsgbG9zZXJzIGNsZWFuIHVwIGFuZCBiYWNrIG9mZlxuICpcbiAqIENvbW1lbnQgZm9ybWF0OiBgPCEtLSBCUkFOQ0hfVVBEQVRFX0xPQ0s6d29ya2VyLWlkOnVuaXgtdGltZXN0YW1wIC0tPmBcbiAqXG4gKiAqKkEgY29tcGV0aW5nIGxvY2sgb25seSBjb3VudHMgd2hlbiB0aGUgZmxlZXQgcG9zdGVkIGl0IChJc3N1ZSAjMTEyNCkuKipcbiAqIEEgUFIgY29tbWVudCB0aHJlYWQgb24gYSBwdWJsaWMgcmVwb3NpdG9yeSBpcyBvcGVuIHRvIGFueW9uZSwgc28gYVxuICogYEJSQU5DSF9VUERBVEVfTE9DS2AgbWFya2VyIGlzIGEgY2xhaW0gZnJvbSBhIHN0cmFuZ2VyIHVubGVzcyB0aGUgY29tbWVudFxuICogKiphdXRob3IqKiBzYXlzIG90aGVyd2lzZSDigJQgYW5kIHRoZSB3b3JrZXItaWQgYW5kIHRpbWVzdGFtcCBpbnNpZGUgdGhlXG4gKiBtYXJrZXIgYXJlIGNob3NlbiBieSB3aG9ldmVyIHR5cGVkIGl0LiBBIHBsYW50ZWQgbG9jayB3aXRoIGEgZnJlc2hcbiAqIHRpbWVzdGFtcCBuZXZlciBleHBpcmVzLCBzb3J0cyBlYXJsaWVzdCwgYW5kIHN0YWxscyBldmVyeSBob3N0J3MgYnJhbmNoXG4gKiB1cGRhdGVzIG9uIHRoYXQgUFIgaW5kZWZpbml0ZWx5LiBUaGUgcmUtcmVhZCB0aGVyZWZvcmUgY2Fycmllc1xuICogYC51c2VyLmxvZ2luYCBhbmQgY29tcGV0aW5nIGxvY2tzIGFyZSBmaWx0ZXJlZCBhZ2FpbnN0IHRoZSBmbGVldCBpZGVudGl0eVxuICogKGBhbGVydF9kZWR1cF9hdXRob3JzLnRzYCkuXG4gKlxuICogKipUaGUgZmFpbCBkaXJlY3Rpb24gbGVhdmVzIHRoZSB3b3JrIGNsYWltYWJsZS4qKiBBbiB1bnJlc29sdmFibGUgZmxlZXRcbiAqIGlkZW50aXR5IG1lYW5zIG5vIGNvbXBldGluZyBsb2NrIGNhbiBiZSBhdHRyaWJ1dGVkLCBzbyBub25lIGlzIGNvdW50ZWRcbiAqIGFuZCB0aGlzIGhvc3QgdGFrZXMgdGhlIGxvY2suIFR3byBob3N0cyB1cGRhdGluZyB0aGUgc2FtZSBicmFuY2ggaXMgYVxuICogY29uZmxpY3QgZ2l0IHJlc29sdmVzOyBhIGJyYW5jaCBubyBob3N0IG1heSBldmVyIHVwZGF0ZSBpcyBhIFBSIHRoYXRcbiAqIG5ldmVyIG1lcmdlcy5cbiAqXG4gKiAqKkEgYnVzeSB0aHJlYWQgbXVzdCBub3QgYmxpbmQgdGhlIGxvY2sgKElzc3VlICMyMjY1KS4qKiBUaGUgY29tbWVudCByZWFkXG4gKiBpcyBwYWdpbmF0ZWQ6IHRoZSB1bnBhZ2luYXRlZCBjYWxsIHJldHVybmVkIG9ubHkgdGhlIDMwIG9sZGVzdCBjb21tZW50cyxcbiAqIHNvIG9uY2UgYSBQUiB0aHJlYWQgb3V0Z3JldyBvbmUgcGFnZSB0aGUgc3dlZXAgc2F3IG5vIGxvY2tzIHRvIGV4cGlyZSBhbmRcbiAqIHRoZSB2ZXJpZmljYXRpb24gcmVhZCBjb3VsZCBub3Qgc2VlIHRoZSBjb21tZW50IHRoaXMgaG9zdCBoYWQganVzdCBwb3N0ZWQuXG4gKiBFdmVyeSBjeWNsZSB0aGVuIHBvc3RlZCBvbmUgbW9yZSBsb2NrLCBhY3F1aXJlZCBub3RoaW5nLCBhbmQgbGVmdCB0aGVcbiAqIGNvbW1lbnQgYmVoaW5kIOKAlCA3NjUgb2YgdGhlbSBvbiBORUFULUFJLUxhbWFyY2sjMjM5LCBhIGJyYW5jaCBubyBob3N0XG4gKiBjb3VsZCB1cGRhdGUsIGFuZCBhIGh1bWFuIGFza2VkIHRvIHNvcnQgaXQgb3V0LiBUaHJlZSBydWxlcyBrZWVwIHRoYXQgZnJvbVxuICogcmVjdXJyaW5nOiB0aGUgcmVhZCBpcyBwYWdpbmF0ZWQsIHRoZSBwb3N0ZWQgY29tbWVudCBpcyBkZWxldGVkIG9uIGV2ZXJ5XG4gKiBub3QtYWNxdWlyZWQgcGF0aCwgYW5kIGFuIGV4cGlyZWQgbWFya2VyIGlzIGlnbm9yZWQgd2hlbiB0aGUgd2lubmVyIGlzXG4gKiBjaG9zZW4gc28gYSBkZWxldGUgdGhhdCBuZXZlciBzdWNjZWVkZWQgY2Fubm90IHdlZGdlIHRoZSBQUi5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgcnVuR2hDb21tYW5kIH0gZnJvbSBcIi4vZ2l0aHViLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEFsZXJ0RGVkdXBBdXRob3JPcHRpb25zLFxuICB0eXBlIEFsZXJ0RGVkdXBDb21tZW50Um93LFxuICBzZWxlY3RGbGVldEF1dGhvcmVkQ29tbWVudHMsXG59IGZyb20gXCIuL2FsZXJ0X2RlZHVwX2F1dGhvcnMudHNcIjtcbmltcG9ydCB7XG4gIGRlbGV0ZUlzc3VlQ29tbWVudCxcbiAgZmV0Y2hNYXJrZXJDb21tZW50cyxcbiAgcGFyc2VNYXJrZXJDb21tZW50UGFnZXMsXG59IGZyb20gXCIuL21hcmtlcl9jb21tZW50X3BhZ2VzLnRzXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ29uc3RhbnRzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gbG9ja1ByZWZpeChraW5kOiBcImJyYW5jaFwiIHwgXCJiYXNlLXJlZnJlc2hcIiB8IFwiY29tcGxldGlvblwiKTogc3RyaW5nIHtcbiAgaWYgKGtpbmQgPT09IFwiY29tcGxldGlvblwiKSByZXR1cm4gXCI8IS0tIENPTVBMRVRJT05fQURNSVNTSU9OX0xPQ0s6XCI7XG4gIHJldHVybiBraW5kID09PSBcImJyYW5jaFwiXG4gICAgPyBCUkFOQ0hfVVBEQVRFX0xPQ0tfUFJFRklYXG4gICAgOiBcIjwhLS0gQkFTRV9SRUZSRVNIX0xPQ0tfNDYxMzpcIjtcbn1cblxuLyoqIFRoZSBsb2NrIG1hcmtlciBwcmVmaXggdXNlZCBpbiBQUiBjb21tZW50cyBmb3IgYnJhbmNoIHVwZGF0ZSBsb2NraW5nLiAqL1xuZXhwb3J0IGNvbnN0IEJSQU5DSF9VUERBVEVfTE9DS19QUkVGSVggPSBcIjwhLS0gQlJBTkNIX1VQREFURV9MT0NLOlwiO1xuXG4vKiogRGVmYXVsdCBsb2NrIFRUTCBpbiBzZWNvbmRzICg1IG1pbnV0ZXMpLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTE9DS19UVExfU0VDT05EUyA9IDMwMDtcblxuLyoqIERlZmF1bHQgY29uc2lzdGVuY3kgZGVsYXkgaW4gbWlsbGlzZWNvbmRzLiAqL1xuY29uc3QgREVGQVVMVF9DT05TSVNURU5DWV9ERUxBWV9NUyA9IDMwMDA7XG5cbi8qKlxuICogRGVmYXVsdCByZW5ld2FsIGludGVydmFsIChJc3N1ZSAjMzc1NCkg4oCUIG9uZSB0aGlyZCBvZiB0aGUgVFRMLlxuICpcbiAqIEEgaG9sZGVyIHdob3NlIHdvcmsgb3V0bGl2ZXMgdGhlIFRUTCAoYSAzMC1taW51dGUgQ0kgZml4IGFnYWluc3QgYVxuICogNS1taW51dGUgVFRMKSBtdXN0IHJlZnJlc2ggaXRzIGxvY2sgcmF0aGVyIHRoYW4gcmFpc2UgdGhlIFRUTDogcmVuZXdhbFxuICoga2VlcHMgdGhlIGNyYXNoLXJlY292ZXJ5IHdpbmRvdyBhdCBvbmUgVFRMLCBzbyBhIGhvc3QgdGhhdCBkaWVzIG1pZC1ydW5cbiAqIGZyZWVzIHRoZSBQUiB3aXRoaW4gZml2ZSBtaW51dGVzIGluc3RlYWQgb2YgaG91cnMuIFJlbmV3aW5nIGF0IFRUTC8zXG4gKiBtZWFucyB0d28gY29uc2VjdXRpdmUgcmVuZXdhbCBmYWlsdXJlcyBzdGlsbCBsZWF2ZSB0aGUgbG9jayBsaXZlLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9MT0NLX1JFTkVXQUxfSU5URVJWQUxfTVMgPSAxMDBfMDAwO1xuXG4vKipcbiAqIFN0YWxlIGxvY2sgY29tbWVudHMgZGVsZXRlZCBpbiBvbmUgc3dlZXAgKElzc3VlICMyMjY1KS5cbiAqXG4gKiBBIHRocmVhZCB0aGF0IGFjY3VtdWxhdGVkIGEgYmFja2xvZyB3aGlsZSB0aGUgcmVhZCB3YXMgYmxpbmQgaG9sZHNcbiAqIGh1bmRyZWRzIG9mIGV4cGlyZWQgbWFya2VycywgYW5kIGRlbGV0aW5nIHRoZW0gYWxsIHdvdWxkIHR1cm4gb25lIGN5Y2xlXG4gKiBpbnRvIGh1bmRyZWRzIG9mIHNlcmlhbCBBUEkgY2FsbHMgYmVmb3JlIGFueSBicmFuY2ggdXBkYXRlIHN0YXJ0ZWQuIFRoZVxuICogYmFja2xvZyBkcmFpbnMgYSBwYXNzIGF0IGEgdGltZTsgbm90aGluZyB3YWl0cyBvbiBpdCwgYmVjYXVzZSBhbiBleHBpcmVkXG4gKiBtYXJrZXIgaXMgYWxyZWFkeSBpZ25vcmVkIHdoZW4gdGhlIHdpbm5lciBpcyBjaG9zZW4uXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX01BWF9TVEFMRV9MT0NLX0RFTEVUSU9OUyA9IDEwMDtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUeXBlc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBSZXN1bHQgb2YgYSBsb2NrIGFjcXVpc2l0aW9uIGF0dGVtcHQuICovXG5leHBvcnQgaW50ZXJmYWNlIEJyYW5jaFVwZGF0ZUxvY2tSZXN1bHQge1xuICAvKiogV2hldGhlciB0aGUgbG9jayB3YXMgc3VjY2Vzc2Z1bGx5IGFjcXVpcmVkLiAqL1xuICBhY3F1aXJlZDogYm9vbGVhbjtcbiAgLyoqIFRoZSBjb21tZW50IElEIG9mIHRoZSBsb2NrIChmb3IgcmVsZWFzZSkuIE9ubHkgc2V0IHdoZW4gYWNxdWlyZWQuICovXG4gIGxvY2tDb21tZW50SWQ/OiBudW1iZXI7XG4gIC8qKiBXb3JrZXIgSUQgb2YgdGhlIGxvY2sgd2lubmVyICh3aGVuIGNvbnRlbnRpb24gb2NjdXJyZWQpLiAqL1xuICB3aW5uZXJJZD86IHN0cmluZztcbiAgLyoqXG4gICAqIFVuaXggc2Vjb25kcyB0aGUgd2lubmVyJ3MgbG9jayBtYXJrZXIgY2Fycmllcywgc28gYSBjYWxsZXIgdGhhdCBzdGFuZHNcbiAgICogZG93biBjYW4gc2F5IGhvdyBvbGQgdGhlIGhvbGRpbmcgbG9jayBpcyAoSXNzdWUgIzMwMzEpLlxuICAgKi9cbiAgd2lubmVyTG9ja2VkQXQ/OiBudW1iZXI7XG59XG5cbi8qKiBPcHRpb25zIGZvciBhY3F1aXJpbmcgYSBicmFuY2ggdXBkYXRlIGxvY2suICovXG5leHBvcnQgaW50ZXJmYWNlIEJyYW5jaFVwZGF0ZUxvY2tPcHRpb25zIHtcbiAgLyoqIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0LiAqL1xuICByZXBvOiBzdHJpbmc7XG4gIC8qKiBQUiBudW1iZXIgdG8gbG9jay4gKi9cbiAgcHJOdW1iZXI6IG51bWJlcjtcbiAgLyoqIFVuaXF1ZSBpZGVudGlmaWVyIGZvciB0aGlzIHdvcmtlci4gKi9cbiAgd29ya2VySWQ6IHN0cmluZztcbiAgLyoqIExvY2sgVFRMIGluIHNlY29uZHMgKGRlZmF1bHQ6IDMwMCkuICovXG4gIGxvY2tUdGxTZWNvbmRzPzogbnVtYmVyO1xuICAvKiogU2VwYXJhdGUgY29tbWVudCBuYW1lc3BhY2UgZm9yIHNob3J0IGJhc2Utb3duZXJzaGlwIHRyYW5zYWN0aW9ucy4gKi9cbiAgbG9ja0tpbmQ/OiBcImJyYW5jaFwiIHwgXCJiYXNlLXJlZnJlc2hcIiB8IFwiY29tcGxldGlvblwiO1xuICAvKiogSW5qZWN0ZWQgc2xlZXAgZnVuY3Rpb24gKGZvciB0ZXN0aW5nKS4gRGVmYXVsdHMgdG8gcmVhbCBzbGVlcC4gKi9cbiAgc2xlZXBGbj86IChtczogbnVtYmVyKSA9PiBQcm9taXNlPHZvaWQ+O1xuICAvKiogSW5qZWN0ZWQgZ2ggY29tbWFuZCBmdW5jdGlvbiAoZm9yIHRlc3RpbmcpLiBEZWZhdWx0cyB0byBydW5HaENvbW1hbmQuICovXG4gIGdoQ29tbWFuZEZuPzogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIC8qKiBJbmplY3RlZCB0aW1lIGZ1bmN0aW9uIChmb3IgdGVzdGluZykuIFJldHVybnMgY3VycmVudCBVbml4IHRpbWVzdGFtcCBpbiBzZWNvbmRzLiAqL1xuICBub3dGbj86ICgpID0+IG51bWJlcjtcbiAgLyoqXG4gICAqIEh1bWFuLXJlYWRhYmxlIGxpbmUgYXBwZW5kZWQgdW5kZXIgdGhlIGhpZGRlbiBtYXJrZXIgKElzc3VlICMzNzU0KS5cbiAgICogQW4gSFRNTC1jb21tZW50LW9ubHkgYm9keSByZW5kZXJzIGFzIGEgYmxhbmsgUFIgY29tbWVudCwgc28gY2FsbGVyc1xuICAgKiBwYXNzIGEgc2VudGVuY2Ugc2F5aW5nIHdobyBob2xkcyB0aGUgbG9jayBhbmQgd2h5LlxuICAgKi9cbiAgbm90ZT86IHN0cmluZztcbiAgLyoqXG4gICAqIEZsZWV0IGlkZW50aXR5IGlucHV0cyBmb3IgdGhlIGNvbXBldGluZy1sb2NrIGF1dGhvciBjaGVja1xuICAgKiAoSXNzdWUgIzExMjQpLiBPbWl0dGVkIHJlYWRzIHRoZSBjb25maWd1cmVkIGZsZWV0LCB3aGljaCBpcyB3aGF0IGV2ZXJ5XG4gICAqIHByb2R1Y3Rpb24gY2FsbGVyIGRvZXMuXG4gICAqL1xuICBhdXRob3JPcHRpb25zPzogQWxlcnREZWR1cEF1dGhvck9wdGlvbnM7XG4gIC8qKiBTaW5rIGZvciB0aGUgYXV0aG9yLXZlcmlmaWNhdGlvbiBkaWFnbm9zdGljcy4gKi9cbiAgbG9nPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuLyoqIE9wdGlvbnMgZm9yIHJlbmV3aW5nIGEgaGVsZCBicmFuY2ggdXBkYXRlIGxvY2sgKElzc3VlICMzNzU0KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQnJhbmNoVXBkYXRlUmVuZXdPcHRpb25zIHtcbiAgLyoqIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0LiAqL1xuICByZXBvOiBzdHJpbmc7XG4gIC8qKiBDb21tZW50IElEIG9mIHRoZSBoZWxkIGxvY2suICovXG4gIGxvY2tDb21tZW50SWQ6IG51bWJlcjtcbiAgLyoqIFVuaXF1ZSBpZGVudGlmaWVyIGZvciB0aGlzIHdvcmtlciAobXVzdCBtYXRjaCB0aGUgaGVsZCBsb2NrKS4gKi9cbiAgd29ya2VySWQ6IHN0cmluZztcbiAgLyoqIEh1bWFuLXJlYWRhYmxlIGxpbmUgYXBwZW5kZWQgdW5kZXIgdGhlIGhpZGRlbiBtYXJrZXIuICovXG4gIG5vdGU/OiBzdHJpbmc7XG4gIC8qKiBJbmplY3RlZCBnaCBjb21tYW5kIGZ1bmN0aW9uIChmb3IgdGVzdGluZykuIERlZmF1bHRzIHRvIHJ1bkdoQ29tbWFuZC4gKi9cbiAgZ2hDb21tYW5kRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbiAgLyoqIEluamVjdGVkIHRpbWUgZnVuY3Rpb24gKGZvciB0ZXN0aW5nKS4gUmV0dXJucyBjdXJyZW50IFVuaXggdGltZXN0YW1wIGluIHNlY29uZHMuICovXG4gIG5vd0ZuPzogKCkgPT4gbnVtYmVyO1xufVxuXG4vKiogT3B0aW9ucyBmb3Igc2NoZWR1bGluZyBwZXJpb2RpYyBsb2NrIHJlbmV3YWwgKElzc3VlICMzNzU0KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQnJhbmNoTG9ja1JlbmV3YWxPcHRpb25zIGV4dGVuZHMgQnJhbmNoVXBkYXRlUmVuZXdPcHRpb25zIHtcbiAgLyoqIEludGVydmFsIGJldHdlZW4gcmVuZXdhbHMgKGRlZmF1bHQ6IHtAbGluayBERUZBVUxUX0xPQ0tfUkVORVdBTF9JTlRFUlZBTF9NU30pLiAqL1xuICBpbnRlcnZhbE1zPzogbnVtYmVyO1xuICAvKiogQ2FsbGVkIHdpdGggYSBtZXNzYWdlIHdoZW4gYSByZW5ld2FsIGZhaWxzLCBzbyBpdCBpcyBuZXZlciBzaWxlbnQuICovXG4gIG9uRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG4vKiogSGFuZGxlIGZvciBzdG9wcGluZyBhIHJlbmV3YWwgc2NoZWR1bGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEJyYW5jaExvY2tSZW5ld2FsSGFuZGxlIHtcbiAgLyoqIFN0b3AgcmVuZXdpbmcuIFNhZmUgdG8gY2FsbCBtb3JlIHRoYW4gb25jZS4gKi9cbiAgc3RvcCgpOiB2b2lkO1xufVxuXG4vKiogT3B0aW9ucyBmb3IgcmVsZWFzaW5nIGEgYnJhbmNoIHVwZGF0ZSBsb2NrLiAqL1xuZXhwb3J0IGludGVyZmFjZSBCcmFuY2hVcGRhdGVSZWxlYXNlT3B0aW9ucyB7XG4gIC8qKiBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdC4gKi9cbiAgcmVwbzogc3RyaW5nO1xuICAvKiogUFIgbnVtYmVyLiAqL1xuICBwck51bWJlcjogbnVtYmVyO1xuICAvKiogQ29tbWVudCBJRCBvZiB0aGUgbG9jayB0byByZWxlYXNlLiAqL1xuICBsb2NrQ29tbWVudElkOiBudW1iZXI7XG4gIC8qKiBJbmplY3RlZCBnaCBjb21tYW5kIGZ1bmN0aW9uIChmb3IgdGVzdGluZykuIERlZmF1bHRzIHRvIHJ1bkdoQ29tbWFuZC4gKi9cbiAgZ2hDb21tYW5kRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbn1cblxuLyoqIE9wdGlvbnMgZm9yIGNsZWFuaW5nIHN0YWxlIGJyYW5jaCB1cGRhdGUgbG9ja3MuICovXG5leHBvcnQgaW50ZXJmYWNlIENsZWFuU3RhbGVMb2NrT3B0aW9ucyB7XG4gIC8qKiBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdC4gKi9cbiAgcmVwbzogc3RyaW5nO1xuICAvKiogUFIgbnVtYmVyLiAqL1xuICBwck51bWJlcjogbnVtYmVyO1xuICAvKiogTG9jayBUVEwgaW4gc2Vjb25kcyAoZGVmYXVsdDogMzAwKS4gKi9cbiAgbG9ja1R0bFNlY29uZHM/OiBudW1iZXI7XG4gIC8qKiBTZXBhcmF0ZSBjb21tZW50IG5hbWVzcGFjZSBmb3Igc2hvcnQgYmFzZS1vd25lcnNoaXAgdHJhbnNhY3Rpb25zLiAqL1xuICBsb2NrS2luZD86IFwiYnJhbmNoXCIgfCBcImJhc2UtcmVmcmVzaFwiIHwgXCJjb21wbGV0aW9uXCI7XG4gIC8qKiBJbmplY3RlZCBnaCBjb21tYW5kIGZ1bmN0aW9uIChmb3IgdGVzdGluZykuIERlZmF1bHRzIHRvIHJ1bkdoQ29tbWFuZC4gKi9cbiAgZ2hDb21tYW5kRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbiAgLyoqIEluamVjdGVkIHRpbWUgZnVuY3Rpb24gKGZvciB0ZXN0aW5nKS4gUmV0dXJucyBjdXJyZW50IFVuaXggdGltZXN0YW1wIGluIHNlY29uZHMuICovXG4gIG5vd0ZuPzogKCkgPT4gbnVtYmVyO1xuICAvKipcbiAgICogRGVsZXRpb25zIGF0dGVtcHRlZCBpbiB0aGlzIHBhc3MgKGRlZmF1bHQ6XG4gICAqIHtAbGluayBERUZBVUxUX01BWF9TVEFMRV9MT0NLX0RFTEVUSU9OU30pLlxuICAgKi9cbiAgbWF4RGVsZXRpb25zPzogbnVtYmVyO1xuICAvKipcbiAgICogU2luayBmb3Igc3dlZXAgZGlhZ25vc3RpY3MgKElzc3VlICMyMjY1KS4gVGhlIHN3ZWVwIHN0YXlzIGJlc3QtZWZmb3J0LFxuICAgKiBidXQgYSByZWFkIGl0IGNvdWxkIG5vdCBtYWtlIGFuZCBhIGRlbGV0ZSBpdCBjb3VsZCBub3QgbWFrZSBhcmUgc2FpZCBvdXRcbiAgICogbG91ZCDigJQgc2lsZW5jZSBpcyBob3cgNzY1IGxvY2sgY29tbWVudHMgYWNjdW11bGF0ZWQgdW5ub3RpY2VkLlxuICAgKi9cbiAgbG9nPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuLyoqIFBhcnNlZCBsb2NrIGNvbW1lbnQgZnJvbSB0aGUgR2l0SHViIEFQSS4gKi9cbmludGVyZmFjZSBMb2NrQ29tbWVudCBleHRlbmRzIEFsZXJ0RGVkdXBDb21tZW50Um93IHtcbiAgaWQ6IG51bWJlcjtcbiAgYm9keTogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQdWJsaWMgaGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogQnVpbGQgYSBsb2NrIGNvbW1lbnQgYm9keS5cbiAqXG4gKiBVc2VzIGhpZGRlbiBIVE1MIGNvbW1lbnRzIHRvIGF2b2lkIG5vaXNlIGluIHRoZSBQUiB0aW1lbGluZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTG9ja0NvbW1lbnQoXG4gIHdvcmtlcklkOiBzdHJpbmcsXG4gIHRpbWVzdGFtcFNlY29uZHM6IG51bWJlcixcbiAgbG9ja0tpbmQ6IFwiYnJhbmNoXCIgfCBcImJhc2UtcmVmcmVzaFwiIHwgXCJjb21wbGV0aW9uXCIgPSBcImJyYW5jaFwiLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke2xvY2tQcmVmaXgobG9ja0tpbmQpfSR7d29ya2VySWR9OiR7dGltZXN0YW1wU2Vjb25kc30gLS0+YDtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgZnVsbCBjb21tZW50IGJvZHk6IGhpZGRlbiBtYXJrZXIgcGx1cyBhbiBvcHRpb25hbCB2aXNpYmxlIGxpbmUuXG4gKlxuICogQSBtYXJrZXItb25seSBib2R5IHJlbmRlcnMgYXMgYW4gZW1wdHkgY29tbWVudCBvbiBHaXRIdWIgKElzc3VlICMxNjU5KSxcbiAqIHNvIGNhbGxlcnMgdGhhdCBwb3N0IGxvY2tzIG9uIGEgUFIgdGltZWxpbmUgc3VwcGx5IGEgYG5vdGVgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRMb2NrQm9keShcbiAgd29ya2VySWQ6IHN0cmluZyxcbiAgdGltZXN0YW1wU2Vjb25kczogbnVtYmVyLFxuICBub3RlPzogc3RyaW5nLFxuICBsb2NrS2luZDogXCJicmFuY2hcIiB8IFwiYmFzZS1yZWZyZXNoXCIgfCBcImNvbXBsZXRpb25cIiA9IFwiYnJhbmNoXCIsXG4pOiBzdHJpbmcge1xuICBjb25zdCBtYXJrZXIgPSBidWlsZExvY2tDb21tZW50KHdvcmtlcklkLCB0aW1lc3RhbXBTZWNvbmRzLCBsb2NrS2luZCk7XG4gIHJldHVybiBub3RlICYmIG5vdGUubGVuZ3RoID4gMCA/IGAke21hcmtlcn1cXG4ke25vdGV9YCA6IG1hcmtlcjtcbn1cblxuLyoqXG4gKiBQYXJzZSBhIGxvY2sgY29tbWVudCB0byBleHRyYWN0IHdvcmtlciBJRCBhbmQgdGltZXN0YW1wLlxuICpcbiAqIEByZXR1cm5zIFBhcnNlZCBkYXRhLCBvciBudWxsIGlmIHRoZSBjb21tZW50IGlzIG5vdCBhIHZhbGlkIGxvY2sgbWFya2VyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VMb2NrQ29tbWVudChcbiAgYm9keTogc3RyaW5nLFxuICBsb2NrS2luZDogXCJicmFuY2hcIiB8IFwiYmFzZS1yZWZyZXNoXCIgfCBcImNvbXBsZXRpb25cIiA9IFwiYnJhbmNoXCIsXG4pOiB7IHdvcmtlcklkOiBzdHJpbmc7IHRpbWVzdGFtcDogbnVtYmVyIH0gfCBudWxsIHtcbiAgY29uc3QgbWFya2VyID0gYm9keS5pbmRleE9mKGxvY2tQcmVmaXgobG9ja0tpbmQpKTtcbiAgaWYgKG1hcmtlciA8IDApIHJldHVybiBudWxsO1xuICBjb25zdCBtYXRjaCA9IC9eKFteOl0rKTooXFxkKykgLS0+Ly5leGVjKFxuICAgIGJvZHkuc2xpY2UobWFya2VyICsgbG9ja1ByZWZpeChsb2NrS2luZCkubGVuZ3RoKSxcbiAgKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3Qgd29ya2VySWQgPSBtYXRjaFsxXSE7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IHBhcnNlSW50KG1hdGNoWzJdISwgMTApO1xuICBpZiAoaXNOYU4odGltZXN0YW1wKSkgcmV0dXJuIG51bGw7XG5cbiAgcmV0dXJuIHsgd29ya2VySWQsIHRpbWVzdGFtcCB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEludGVybmFsIGhlbHBlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIERlZmF1bHQgc2xlZXAgZnVuY3Rpb24g4oCUIHdhaXRzIHRoZSBnaXZlbiBudW1iZXIgb2YgbWlsbGlzZWNvbmRzLlxuICovXG5mdW5jdGlvbiBkZWZhdWx0U2xlZXAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcbn1cblxuLyoqXG4gKiBEZWZhdWx0IG5vdyBmdW5jdGlvbiDigJQgcmV0dXJucyBjdXJyZW50IFVuaXggdGltZXN0YW1wIGluIHNlY29uZHMuXG4gKi9cbmZ1bmN0aW9uIGRlZmF1bHROb3coKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApO1xufVxuXG4vKipcbiAqIFRoZSBjb21tZW50IGlkIGluIHRoZSBVUkwgYGdoIGlzc3VlIGNvbW1lbnRgIHByaW50cywgb3IgbnVsbCAoSXNzdWUgIzEyNDkpLlxuICpcbiAqIGBnaGAgd3JpdGVzIHRoZSBuZXcgY29tbWVudCdzIFVSTCB0byBzdGRvdXQg4oCUXG4gKiBgaHR0cHM6Ly9naXRodWIuY29tL28vci9pc3N1ZXMvNSNpc3N1ZWNvbW1lbnQtMjQxMjM0NTY3OGAg4oCUIGFuZCB0aGF0XG4gKiBmcmFnbWVudCBpcyB0aGUgb25seSAqYXV0aGVudGljYXRlZCogc3RhdGVtZW50IGFib3V0IHdoaWNoIGNvbW1lbnQgaW4gdGhlXG4gKiB0aHJlYWQgdGhpcyB3b3JrZXIganVzdCB3cm90ZS4gRXhwb3J0ZWQgZm9yIHRoZSByZWdyZXNzaW9uIHRlc3Q7IGEgcGF5bG9hZFxuICogd2l0aCBubyBmcmFnbWVudCB5aWVsZHMgbnVsbCwgYW5kIHRoZSBjYWxsZXIgdGhlbiBkZWNsaW5lcyB0aGUgbG9jayByYXRoZXJcbiAqIHRoYW4gZ3Vlc3NpbmcuXG4gKlxuICogQHBhcmFtIGdoT3V0cHV0IC0gUmF3IHN0ZG91dCBmcm9tIGBnaCBpc3N1ZSBjb21tZW50YFxuICogQHJldHVybnMgVGhlIGNvbW1lbnQgaWQsIG9yIG51bGwgd2hlbiB0aGUgb3V0cHV0IGNhcnJpZXMgbm8gZnJhZ21lbnRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUG9zdGVkQ29tbWVudElkKGdoT3V0cHV0OiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgbWF0Y2ggPSAvI2lzc3VlY29tbWVudC0oXFxkKykvLmV4ZWMoZ2hPdXRwdXQgPz8gXCJcIik7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICBjb25zdCBpZCA9IE51bWJlcihtYXRjaFsxXSk7XG4gIHJldHVybiBOdW1iZXIuaXNTYWZlSW50ZWdlcihpZCkgPyBpZCA6IG51bGw7XG59XG5cbi8qKlxuICogRmxhdHRlbiB3aGF0IGBnaCBhcGkgLS1wYWdpbmF0ZSAtLWpxICdb4oCmXSdgIHByaW50cyAoSXNzdWUgIzIyNjUpLlxuICpcbiAqIFRoZSBsb2NrJ3MgdmlldyBvZiB7QGxpbmsgcGFyc2VNYXJrZXJDb21tZW50UGFnZXN9LCB3aGljaCB0aGUgUFItY29tbWVudFxuICogY2xhaW0gcmVhZHMgdGhlIHNhbWUgd2F5IChJc3N1ZSAjMjI2NikuIEV4cG9ydGVkIGZvciB0aGUgcmVncmVzc2lvbiB0ZXN0LlxuICpcbiAqIEBwYXJhbSBwYXlsb2FkIC0gUmF3IHN0ZG91dCBmcm9tIHRoZSBwYWdpbmF0ZWQgY29tbWVudCByZWFkXG4gKiBAcmV0dXJucyBFdmVyeSBsb2NrIGNvbW1lbnQgYWNyb3NzIGV2ZXJ5IHBhZ2UsIGluIHBhZ2Ugb3JkZXJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlTG9ja0NvbW1lbnRQYWdlcyhwYXlsb2FkOiBzdHJpbmcpOiBMb2NrQ29tbWVudFtdIHtcbiAgcmV0dXJuIHBhcnNlTWFya2VyQ29tbWVudFBhZ2VzKHBheWxvYWQsIEJSQU5DSF9VUERBVEVfTE9DS19QUkVGSVgpO1xufVxuXG4vKipcbiAqIEZldGNoIGFsbCBsb2NrIGNvbW1lbnRzIG9uIGEgUFIsIGFjcm9zcyBldmVyeSBwYWdlIChJc3N1ZSAjMjI2NSkuXG4gKlxuICogVGhlIHJlYWQgaXMgcGFnaW5hdGVkIGJlY2F1c2UgYSBQUiB0aHJlYWQgaXMgdW5ib3VuZGVkOiB0aGUgZGVmYXVsdCBwYWdlXG4gKiBvZiAzMCBjb21tZW50cyBoaWQgZXZlcnkgbG9jayBvbiBhIGJ1c3kgUFIsIHdoaWNoIGxlZnQgdGhlIHN3ZWVwIHdpdGhcbiAqIG5vdGhpbmcgdG8gZXhwaXJlIGFuZCBzdG9wcGVkIGEgaG9zdCByZWNvZ25pc2luZyBpdHMgb3duIGxvY2sgY29tbWVudC5cbiAqL1xuZnVuY3Rpb24gZmV0Y2hMb2NrQ29tbWVudHMoXG4gIHJlcG86IHN0cmluZyxcbiAgcHJOdW1iZXI6IG51bWJlcixcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICBsb2NrS2luZDogXCJicmFuY2hcIiB8IFwiYmFzZS1yZWZyZXNoXCIgfCBcImNvbXBsZXRpb25cIiA9IFwiYnJhbmNoXCIsXG4pOiBQcm9taXNlPExvY2tDb21tZW50W10+IHtcbiAgcmV0dXJuIGZldGNoTWFya2VyQ29tbWVudHMoXG4gICAgcmVwbyxcbiAgICBwck51bWJlcixcbiAgICBsb2NrUHJlZml4KGxvY2tLaW5kKSxcbiAgICBnaENvbW1hbmRGbixcbiAgKTtcbn1cblxuLyoqXG4gKiBEZWxldGUgb25lIGxvY2sgY29tbWVudCwgcmVwb3J0aW5nIHRoZSBmYWlsdXJlIHJhdGhlciB0aGFuIGhpZGluZyBpdC5cbiAqXG4gKiBAcmV0dXJucyBUaGUgZXJyb3Igd2hlbiB0aGUgZGVsZXRlIGZhaWxlZCwgb3IgbnVsbCB3aGVuIGl0IHN1Y2NlZWRlZFxuICovXG5mdW5jdGlvbiBkZWxldGVMb2NrQ29tbWVudChcbiAgcmVwbzogc3RyaW5nLFxuICBjb21tZW50SWQ6IG51bWJlcixcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuKTogUHJvbWlzZTxFcnJvciB8IG51bGw+IHtcbiAgcmV0dXJuIGRlbGV0ZUlzc3VlQ29tbWVudChyZXBvLCBjb21tZW50SWQsIGdoQ29tbWFuZEZuKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQdWJsaWMgQVBJXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBDbGVhbiB1cCBzdGFsZSBicmFuY2ggdXBkYXRlIGxvY2sgY29tbWVudHMuXG4gKlxuICogUmVtb3ZlcyBsb2NrIGNvbW1lbnRzIHdob3NlIHRpbWVzdGFtcCBpcyBvbGRlciB0aGFuIHRoZSBjb25maWd1cmVkIFRUTCxcbiAqIHVwIHRvIGBtYXhEZWxldGlvbnNgIGluIG9uZSBwYXNzLiBCZXN0LWVmZm9ydCDigJQgdGhlIHN3ZWVwIG5ldmVyIHRocm93cyDigJRcbiAqIGJ1dCBuZXZlciBzaWxlbnQ6IGEgcmVhZCBvciBhIGRlbGV0ZSBpdCBjb3VsZCBub3QgbWFrZSBpcyBsb2dnZWQsIGJlY2F1c2VcbiAqIGEgc3dlZXAgdGhhdCBxdWlldGx5IGRpZCBub3RoaW5nIGlzIGhvdyBhIFBSIGNvbGxlY3RzIDc2NSBsb2NrIGNvbW1lbnRzXG4gKiAoSXNzdWUgIzIyNjUpLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gQ2xlYW51cCBvcHRpb25zXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGVhblN0YWxlQnJhbmNoVXBkYXRlTG9ja3MoXG4gIG9wdGlvbnM6IENsZWFuU3RhbGVMb2NrT3B0aW9ucyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7XG4gICAgcmVwbyxcbiAgICBwck51bWJlcixcbiAgICBsb2NrVHRsU2Vjb25kcyA9IERFRkFVTFRfTE9DS19UVExfU0VDT05EUyxcbiAgICBsb2NrS2luZCA9IFwiYnJhbmNoXCIsXG4gICAgZ2hDb21tYW5kRm4gPSBydW5HaENvbW1hbmQsXG4gICAgbm93Rm4gPSBkZWZhdWx0Tm93LFxuICAgIG1heERlbGV0aW9ucyA9IERFRkFVTFRfTUFYX1NUQUxFX0xPQ0tfREVMRVRJT05TLFxuICAgIGxvZyA9IChtZXNzYWdlOiBzdHJpbmcpID0+IGNvbnNvbGUud2FybihtZXNzYWdlKSxcbiAgfSA9IG9wdGlvbnM7XG5cbiAgY29uc3Qgd2hlcmUgPSBgW3ByLWJyYW5jaC1sb2NrXSAke3JlcG99IyR7cHJOdW1iZXJ9OmA7XG5cbiAgbGV0IGxvY2tDb21tZW50czogTG9ja0NvbW1lbnRbXTtcbiAgdHJ5IHtcbiAgICBsb2NrQ29tbWVudHMgPSBhd2FpdCBmZXRjaExvY2tDb21tZW50cyhcbiAgICAgIHJlcG8sXG4gICAgICBwck51bWJlcixcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgbG9ja0tpbmQsXG4gICAgKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nKFxuICAgICAgYCR7d2hlcmV9IGNvdWxkIG5vdCByZWFkIHRoZSBsb2NrIGNvbW1lbnRzLCBzbyBubyBzdGFsZSBsb2NrIHdhcyBgICtcbiAgICAgICAgYGV4cGlyZWQgdGhpcyBwYXNzIOKAlCAke1xuICAgICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgICB9YCxcbiAgICApO1xuICAgIHJldHVybjsgLy8gQmVzdC1lZmZvcnRcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IG5vd0ZuKCk7XG4gIGNvbnN0IHN0YWxlID0gbG9ja0NvbW1lbnRzLmZpbHRlcigoY29tbWVudCkgPT4ge1xuICAgIGNvbnN0IGxvY2tEYXRhID0gcGFyc2VMb2NrQ29tbWVudChjb21tZW50LmJvZHksIGxvY2tLaW5kKTtcbiAgICByZXR1cm4gbG9ja0RhdGEgIT09IG51bGwgJiYgbm93IC0gbG9ja0RhdGEudGltZXN0YW1wID49IGxvY2tUdGxTZWNvbmRzO1xuICB9KTtcblxuICBmb3IgKGNvbnN0IGNvbW1lbnQgb2Ygc3RhbGUuc2xpY2UoMCwgbWF4RGVsZXRpb25zKSkge1xuICAgIGNvbnN0IGVycm9yID0gYXdhaXQgZGVsZXRlTG9ja0NvbW1lbnQocmVwbywgY29tbWVudC5pZCwgZ2hDb21tYW5kRm4pO1xuICAgIGlmIChlcnJvcikge1xuICAgICAgbG9nKFxuICAgICAgICBgJHt3aGVyZX0gY291bGQgbm90IGRlbGV0ZSBzdGFsZSBsb2NrIGNvbW1lbnQgJHtjb21tZW50LmlkfSDigJQgYCArXG4gICAgICAgICAgYCR7ZXJyb3IubWVzc2FnZX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBpZiAoc3RhbGUubGVuZ3RoID4gbWF4RGVsZXRpb25zKSB7XG4gICAgbG9nKFxuICAgICAgYCR7d2hlcmV9ICR7c3RhbGUubGVuZ3RoIC0gbWF4RGVsZXRpb25zfSBzdGFsZSBsb2NrIGNvbW1lbnQocykgcmVtYWluIGAgK1xuICAgICAgICBgYWZ0ZXIgdGhpcyBwYXNzJ3MgJHttYXhEZWxldGlvbnN9OyB0aGUgbmV4dCBwYXNzIGNsZWFycyBtb3JlIGAgK1xuICAgICAgICBgKElzc3VlICMyMjY1KWAsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIEFjcXVpcmUgYSBkaXN0cmlidXRlZCBsb2NrIGZvciB1cGRhdGluZyBhIFBSIGJyYW5jaC5cbiAqXG4gKiBQb3N0cyBhIGhpZGRlbiBsb2NrIGNvbW1lbnQgb24gdGhlIFBSLCB3YWl0cyBicmllZmx5IGZvciBHaXRIdWInc1xuICogZXZlbnR1YWwgY29uc2lzdGVuY3ksIHRoZW4gdmVyaWZpZXMgbm8gY29tcGV0aW5nIGxvY2tzIGV4aXN0LlxuICogSWYgbXVsdGlwbGUgd29ya2VycyBwb3N0ZWQgc2ltdWx0YW5lb3VzbHksIHRoZSBlYXJsaWVzdCBsb2NrXG4gKiAoYnkgY3JlYXRlZF9hdCB0aW1lc3RhbXApIHdpbnMuXG4gKlxuICogQHBhcmFtIG9wdGlvbnMgLSBMb2NrIGFjcXVpc2l0aW9uIG9wdGlvbnNcbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIGxvY2sgb3V0Y29tZVxuICovXG4vKipcbiAqIFRoZSB3b3JrZXIgaWQgb2YgYSBsb2NrIHRoYXQgaXMgc3RpbGwgaW5zaWRlIGl0cyBUVEwsIG9yIG51bGwgd2hlbiBub25lIGlzLlxuICpcbiAqIEEgbG9jayB0aGUgZmxlZXQgZGlkIG5vdCBwb3N0IGlzIG5vdCBhIGxvY2sgKElzc3VlICMxMTI0KTogdGhlIHdvcmtlciBpZFxuICogYW5kIHRpbWVzdGFtcCBpbnNpZGUgdGhlIG1hcmtlciBhcmUgd2hhdGV2ZXIgdGhlIGNvbW1lbnRlciB0eXBlZCwgYW5kIGFcbiAqIGZ1dHVyZSB0aW1lc3RhbXAgbmV2ZXIgZXhwaXJlcy4gQW4gdW50cnVzdGVkIG1hcmtlciBpcyBpZ25vcmVkLCB0aGUgc2FtZVxuICogd2F5IHtAbGluayBhY3F1aXJlQnJhbmNoVXBkYXRlTG9ja30gaWdub3JlcyBvbmUuIEEgcmVhZCB0aGF0IGZhaWxzIHJldHVybnNcbiAqIG51bGwgYW5kIGlzIGxvZ2dlZDogdGhlIGNhbGxlciB0aGVuIHByb2NlZWRzIGFzIGlmIHRoZSBsb2NrIHdlcmUgZnJlZSxcbiAqIHdoaWNoIGlzIHRoZSBzYW1lIGFuc3dlciBhIG1pc3NpbmcgdGhyZWFkIGdpdmVzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYWN0aXZlQnJhbmNoVXBkYXRlTG9ja0hvbGRlcihvcHRpb25zOiB7XG4gIHJlcG86IHN0cmluZztcbiAgcHJOdW1iZXI6IG51bWJlcjtcbiAgZ2hDb21tYW5kRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbiAgbm93Rm4/OiAoKSA9PiBudW1iZXI7XG4gIGxvY2tUdGxTZWNvbmRzPzogbnVtYmVyO1xuICBsb2c/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuICAvKiogU2FtZSBhdXRob3IgZ2F0ZSBhY3F1aXNpdGlvbiB1c2VzLiBPbWl0dGVkIHJlYWRzIHRoZSBjb25maWd1cmVkIGZsZWV0LiAqL1xuICBhdXRob3JPcHRpb25zPzogQWxlcnREZWR1cEF1dGhvck9wdGlvbnM7XG59KTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHtcbiAgICByZXBvLFxuICAgIHByTnVtYmVyLFxuICAgIGdoQ29tbWFuZEZuID0gcnVuR2hDb21tYW5kLFxuICAgIG5vd0ZuID0gZGVmYXVsdE5vdyxcbiAgICBsb2NrVHRsU2Vjb25kcyA9IERFRkFVTFRfTE9DS19UVExfU0VDT05EUyxcbiAgICBsb2cgPSAobWVzc2FnZTogc3RyaW5nKSA9PiBjb25zb2xlLndhcm4obWVzc2FnZSksXG4gICAgYXV0aG9yT3B0aW9ucyA9IHt9LFxuICB9ID0gb3B0aW9ucztcbiAgbGV0IGxvY2tDb21tZW50czogTG9ja0NvbW1lbnRbXTtcbiAgdHJ5IHtcbiAgICBsb2NrQ29tbWVudHMgPSBhd2FpdCBmZXRjaExvY2tDb21tZW50cyhcbiAgICAgIHJlcG8sXG4gICAgICBwck51bWJlcixcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZyhcbiAgICAgIGBbcHItYnJhbmNoLWxvY2tdICR7cmVwb30jJHtwck51bWJlcn06IGNvdWxkIG5vdCByZWFkIHRoZSBsb2NrIGAgK1xuICAgICAgICBgY29tbWVudHMg4oCUICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCBmbGVldExvY2tzID0gYXdhaXQgc2VsZWN0RmxlZXRBdXRob3JlZENvbW1lbnRzKFxuICAgIGxvY2tDb21tZW50cyxcbiAgICBgYnJhbmNoIHVwZGF0ZSBsb2NrICR7cmVwb30jJHtwck51bWJlcn1gLFxuICAgIGF1dGhvck9wdGlvbnMsXG4gICAgbG9nLFxuICAgIFwibm8gbG9jayBpcyBjb3VudGVkIGFuZCB0aGUgbWlsZXN0b25lIHN5bmMgcHJvY2VlZHMg4oCUIGEgbG9jayBtYXJrZXIgXCIgK1xuICAgICAgXCJhbnlvbmUgY2FuIHBvc3QgbXVzdCBub3Qgc3RhbGwgYSBQUiBpbmRlZmluaXRlbHlcIixcbiAgKTtcbiAgY29uc3Qgbm93ID0gbm93Rm4oKTtcbiAgZm9yIChjb25zdCBjb21tZW50IG9mIGZsZWV0TG9ja3MpIHtcbiAgICBjb25zdCBsb2NrRGF0YSA9IHBhcnNlTG9ja0NvbW1lbnQoY29tbWVudC5ib2R5KTtcbiAgICBpZiAoXG4gICAgICBsb2NrRGF0YSAhPT0gbnVsbCAmJiBub3cgLSBsb2NrRGF0YS50aW1lc3RhbXAgPCBsb2NrVHRsU2Vjb25kc1xuICAgICkge1xuICAgICAgcmV0dXJuIGxvY2tEYXRhLndvcmtlcklkO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgZmxlZXQtYXV0aG9yZWQgUFIgbG9jayBpcyBzdGlsbCBpbnNpZGUgaXRzIFRUTCAoSXNzdWUgIzI5NjUpLlxuICpcbiAqIFRoZSBtaWxlc3RvbmUgc3luYydzIHByb2R1Y3Rpb24gYHByVXBkYXRlTG9ja0hlbGRGbmAuIFRydWUgb25seSBmb3IgYVxuICogZnJlc2ggbG9jayBhIGZsZWV0IGFjY291bnQgd3JvdGU7IGFuIHVudHJ1c3RlZCBtYXJrZXIsIGFuIGV4cGlyZWQgbWFya2VyXG4gKiBhbmQgYSByZWFkIHRoYXQgZmFpbHMgYXJlIGFsbCBcIm5vdCBoZWxkXCIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwclVwZGF0ZUxvY2tJc0hlbGQoXG4gIHJlcG86IHN0cmluZyxcbiAgcHJOdW1iZXI6IG51bWJlcixcbiAgb3B0aW9uczogT21pdDxcbiAgICBQYXJhbWV0ZXJzPHR5cGVvZiBhY3RpdmVCcmFuY2hVcGRhdGVMb2NrSG9sZGVyPlswXSxcbiAgICBcInJlcG9cIiB8IFwicHJOdW1iZXJcIlxuICA+ID0ge30sXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgaG9sZGVyID0gYXdhaXQgYWN0aXZlQnJhbmNoVXBkYXRlTG9ja0hvbGRlcih7XG4gICAgcmVwbyxcbiAgICBwck51bWJlcixcbiAgICAuLi5vcHRpb25zLFxuICB9KTtcbiAgcmV0dXJuIGhvbGRlciAhPT0gbnVsbDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFjcXVpcmVCcmFuY2hVcGRhdGVMb2NrKFxuICBvcHRpb25zOiBCcmFuY2hVcGRhdGVMb2NrT3B0aW9ucyxcbik6IFByb21pc2U8UmVzdWx0PEJyYW5jaFVwZGF0ZUxvY2tSZXN1bHQ+PiB7XG4gIGNvbnN0IHtcbiAgICByZXBvLFxuICAgIHByTnVtYmVyLFxuICAgIHdvcmtlcklkLFxuICAgIGxvY2tUdGxTZWNvbmRzID0gREVGQVVMVF9MT0NLX1RUTF9TRUNPTkRTLFxuICAgIGxvY2tLaW5kID0gXCJicmFuY2hcIixcbiAgICBzbGVlcEZuID0gZGVmYXVsdFNsZWVwLFxuICAgIGdoQ29tbWFuZEZuID0gcnVuR2hDb21tYW5kLFxuICAgIG5vd0ZuID0gZGVmYXVsdE5vdyxcbiAgICBhdXRob3JPcHRpb25zID0ge30sXG4gICAgbG9nID0gKG1lc3NhZ2U6IHN0cmluZykgPT4gY29uc29sZS53YXJuKG1lc3NhZ2UpLFxuICB9ID0gb3B0aW9ucztcblxuICBjb25zdCB3aGVyZSA9IGBbcHItYnJhbmNoLWxvY2tdICR7cmVwb30jJHtwck51bWJlcn06YDtcblxuICAvLyBTdGVwIDE6IENsZWFuIHVwIHN0YWxlIGxvY2tzIGZyb20gcHJldmlvdXMgcnVucyAvIGNyYXNoZWQgd29ya2Vyc1xuICBhd2FpdCBjbGVhblN0YWxlQnJhbmNoVXBkYXRlTG9ja3Moe1xuICAgIHJlcG8sXG4gICAgcHJOdW1iZXIsXG4gICAgbG9ja1R0bFNlY29uZHMsXG4gICAgbG9ja0tpbmQsXG4gICAgZ2hDb21tYW5kRm4sXG4gICAgbm93Rm4sXG4gICAgbG9nLFxuICB9KTtcblxuICAvLyBTdGVwIDI6IFBvc3Qgb3VyIGxvY2sgY29tbWVudFxuICBjb25zdCBub3cgPSBub3dGbigpO1xuICBjb25zdCBsb2NrQ29tbWVudEJvZHkgPSBidWlsZExvY2tCb2R5KHdvcmtlcklkLCBub3csIG9wdGlvbnMubm90ZSwgbG9ja0tpbmQpO1xuXG4gIC8vIGBnaCBpc3N1ZSBjb21tZW50YCBwcmludHMgdGhlIG5ldyBjb21tZW50J3MgVVJMLCB3aG9zZVxuICAvLyBgI2lzc3VlY29tbWVudC08aWQ+YCBmcmFnbWVudCBpZGVudGlmaWVzIHRoZSBjb21tZW50IHdlIGp1c3QgcG9zdGVkLlxuICAvLyBUaGF0IGlkIOKAlCBub3QgdGhlIHdvcmtlciBpZCBpbnNpZGUgdGhlIGJvZHkg4oCUIGlzIHdoYXQgbWFrZXMgYSBsb2NrXG4gIC8vIG91cnMgKElzc3VlICMxMjQ5LCBmaW5kaW5nIDYpLlxuICBsZXQgb3duTG9ja0NvbW1lbnRJZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcG9zdGVkID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJpc3N1ZVwiLFxuICAgICAgXCJjb21tZW50XCIsXG4gICAgICBTdHJpbmcocHJOdW1iZXIpLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tYm9keVwiLFxuICAgICAgbG9ja0NvbW1lbnRCb2R5LFxuICAgIF0pO1xuICAgIG93bkxvY2tDb21tZW50SWQgPSBwYXJzZVBvc3RlZENvbW1lbnRJZChwb3N0ZWQpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgYWNxdWlyZWQ6IGZhbHNlIH0gfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUYWtlIGJhY2sgdGhlIGNvbW1lbnQgcG9zdGVkIG1vbWVudHMgYWdvIChJc3N1ZSAjMjI2NSkuXG4gICAqXG4gICAqIEV2ZXJ5IG5vdC1hY3F1aXJlZCByZXR1cm4gYWZ0ZXIgdGhlIHBvc3QgdXNlZCB0byBsZWF2ZSBpdCBvbiB0aGUgUFIsXG4gICAqIHNvIGEgaG9zdCB0aGF0IGNvdWxkIG5ldmVyIGFjcXVpcmUgYWRkZWQgb25lIGNvbW1lbnQgcGVyIGN5Y2xlIGZvclxuICAgKiBldmVyLiBOb3RoaW5nIGJ1dCB0aGUgd2lubmVyJ3Mgb3duIGxvY2sgYmVsb25ncyBvbiB0aGUgdGhyZWFkLlxuICAgKi9cbiAgY29uc3QgZHJvcE93bkxvY2tDb21tZW50ID0gYXN5bmMgKCk6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIGlmIChvd25Mb2NrQ29tbWVudElkID09PSBudWxsKSByZXR1cm47XG4gICAgY29uc3QgZXJyb3IgPSBhd2FpdCBkZWxldGVMb2NrQ29tbWVudChcbiAgICAgIHJlcG8sXG4gICAgICBvd25Mb2NrQ29tbWVudElkLFxuICAgICAgZ2hDb21tYW5kRm4sXG4gICAgKTtcbiAgICBpZiAoZXJyb3IpIHtcbiAgICAgIGxvZyhcbiAgICAgICAgYCR7d2hlcmV9IGNvdWxkIG5vdCBkZWxldGUgdGhpcyBob3N0J3Mgb3duIGxvY2sgY29tbWVudCBgICtcbiAgICAgICAgICBgJHtvd25Mb2NrQ29tbWVudElkfSDigJQgdGhlIHN0YWxlIHN3ZWVwIGNsZWFycyBpdCBvbmNlIHRoZSBUVEwgYCArXG4gICAgICAgICAgYHBhc3NlczogJHtlcnJvci5tZXNzYWdlfWAsXG4gICAgICApO1xuICAgIH1cbiAgfTtcblxuICAvLyBTdGVwIDM6IEJyaWVmIHBhdXNlIGZvciBHaXRIdWIncyBldmVudHVhbCBjb25zaXN0ZW5jeVxuICBhd2FpdCBzbGVlcEZuKERFRkFVTFRfQ09OU0lTVEVOQ1lfREVMQVlfTVMpO1xuXG4gIC8vIFN0ZXAgNDogUmUtcmVhZCBjb21tZW50cyB0byBjaGVjayBmb3IgY29tcGV0aW5nIGxvY2tzXG4gIGxldCByZWFkTG9ja0NvbW1lbnRzOiBMb2NrQ29tbWVudFtdO1xuICB0cnkge1xuICAgIHJlYWRMb2NrQ29tbWVudHMgPSBhd2FpdCBmZXRjaExvY2tDb21tZW50cyhcbiAgICAgIHJlcG8sXG4gICAgICBwck51bWJlcixcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgbG9ja0tpbmQsXG4gICAgKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gQ2Fubm90IHZlcmlmeSDigJQgYmFjayBvZmYgdG8gYXZvaWQgY29uZmxpY3RzLCB0YWtpbmcgb3VyIGNvbW1lbnQgd2l0aCB1c1xuICAgIGF3YWl0IGRyb3BPd25Mb2NrQ29tbWVudCgpO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBhY3F1aXJlZDogZmFsc2UgfSB9O1xuICB9XG5cbiAgLy8gU3RlcCA0YTogQSBsb2NrIHRoZSBmbGVldCBkaWQgbm90IHBvc3QgaXMgbm90IGEgbG9jayAoSXNzdWUgIzExMjQpLlxuICAvL1xuICAvLyBPdXJzIGlzIHRoZSBjb21tZW50IHdob3NlICoqaWQqKiBHaXRIdWIgcmV0dXJuZWQgd2hlbiB3ZSBwb3N0ZWQgaXRcbiAgLy8gbW9tZW50cyBhZ28gKElzc3VlICMxMjQ5LCBmaW5kaW5nIDYpLiBNYXRjaGluZyBvbiB0aGUgd29ya2VyIGlkIGluc2lkZVxuICAvLyB0aGUgYm9keSB3YXMgbmV2ZXIgZXZpZGVuY2Ugd2Ugd3JvdGUgaXQ6IHRoZSBpZCBpcyBgbmFtZUBob3N0bmFtZWAgYW5kIGlzXG4gIC8vIHByaW50ZWQgdmVyYmF0aW0gaW50byBldmVyeSBwdWJsaWMgbG9jayBjb21tZW50LCBzbyByZXBsYXlpbmcgaXQgd2l0aCBhblxuICAvLyBlYXJsaWVyIHRpbWVzdGFtcCBtYWRlIGEgc3RyYW5nZXIncyBjb21tZW50IHJlYWQgYXMgb3VycyDigJQgYW5kIHR3b1xuICAvLyB3b3JrZXJzIGJvdGggcmVwb3J0ZWQgYGFjcXVpcmVkOiB0cnVlYCwgZGVmZWF0aW5nIHRoZSBtdXR1YWwgZXhjbHVzaW9uXG4gIC8vIHRoaXMgbW9kdWxlIGV4aXN0cyBmb3IuIEV2ZXJ5dGhpbmcgdGhhdCBpcyBub3QgdGhhdCBjb21tZW50IGhhcyB0byBwcm92ZVxuICAvLyB3aG8gd3JvdGUgaXQsIHNvIHRoZSBsb2cgc3RpbGwgbmFtZXMgdGhlIGNvbW1lbnRzIHRoYXQgd291bGQgb3RoZXJ3aXNlXG4gIC8vIGhhdmUgc3RhbGxlZCB0aGlzIGJyYW5jaC5cbiAgLy9cbiAgLy8gTm8gaWQgYmFjayBmcm9tIGBnaGAgbWVhbnMgbm90aGluZyBpbiB0aGUgdGhyZWFkIGNhbiBiZSBlc3RhYmxpc2hlZCBhc1xuICAvLyBvdXJzLCBzbyB0aGUgbG9jayBpcyBub3QgdGFrZW4gdGhpcyBjeWNsZTogYSBtdXR1YWwtZXhjbHVzaW9uIHByaW1pdGl2ZVxuICAvLyB0aGF0IGNhbm5vdCBpZGVudGlmeSBpdHMgb3duIGhvbGRlciBtdXN0IGZhaWwgY2xvc2VkLCBhbmQgdGhlIGJyYW5jaFxuICAvLyB1cGRhdGUgaXMgc2ltcGx5IHJldHJpZWQgb24gdGhlIG5leHQgc2Nhbi5cbiAgaWYgKG93bkxvY2tDb21tZW50SWQgPT09IG51bGwpIHtcbiAgICBsb2coXG4gICAgICBgJHt3aGVyZX0gZ2ggcmV0dXJuZWQgbm8gY29tbWVudCBVUkwgZm9yIGAgK1xuICAgICAgICBgdGhlIGxvY2sgY29tbWVudCwgc28gdGhpcyB3b3JrZXIgY2Fubm90IGlkZW50aWZ5IGl0cyBvd24gbG9jayDigJQgYCArXG4gICAgICAgIGBub3QgYWNxdWlyaW5nOyB0aGUgc3RhbGUgc3dlZXAgY2xlYXJzIHRoZSBjb21tZW50IG9uY2UgdGhlIFRUTCBgICtcbiAgICAgICAgYHBhc3NlcyBhbmQgdGhlIGJyYW5jaCB1cGRhdGUgcmV0cmllcyBuZXh0IGN5Y2xlIChJc3N1ZSAjMTI0OSkuYCxcbiAgICApO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBhY3F1aXJlZDogZmFsc2UgfSB9O1xuICB9XG5cbiAgY29uc3QgaXNPdXJzID0gKGM6IExvY2tDb21tZW50KSA9PiBjLmlkID09PSBvd25Mb2NrQ29tbWVudElkO1xuICBjb25zdCBvdXJMb2NrcyA9IHJlYWRMb2NrQ29tbWVudHMuZmlsdGVyKGlzT3Vycyk7XG4gIGNvbnN0IGZsZWV0TG9ja3MgPSBhd2FpdCBzZWxlY3RGbGVldEF1dGhvcmVkQ29tbWVudHMoXG4gICAgcmVhZExvY2tDb21tZW50cy5maWx0ZXIoKGMpID0+ICFpc091cnMoYykpLFxuICAgIGBicmFuY2ggdXBkYXRlIGxvY2sgJHtyZXBvfSMke3ByTnVtYmVyfWAsXG4gICAgYXV0aG9yT3B0aW9ucyxcbiAgICBsb2csXG4gICAgXCJubyBjb21wZXRpbmcgbG9jayBpcyBjb3VudGVkIGFuZCB0aGUgYnJhbmNoIHN0YXlzIHVwZGF0YWJsZSDigJQgYSBsb2NrIFwiICtcbiAgICAgIFwibWFya2VyIGFueW9uZSBjYW4gcG9zdCBtdXN0IG5vdCBzdGFsbCBhIFBSIGluZGVmaW5pdGVseVwiLFxuICApO1xuXG4gIC8vIEFuIGV4cGlyZWQgbWFya2VyIGlzIG5vdCBhIGNvbXBldGluZyBsb2NrLCBob3dldmVyIGxvbmcgaXQgbGluZ2Vyc1xuICAvLyAoSXNzdWUgIzIyNjUpLiBUaGUgc3dlZXAgYWJvdmUgaXMgYmVzdC1lZmZvcnQsIHNvIGEgZGVsZXRlIHRoYXQgbmV2ZXJcbiAgLy8gc3VjY2VlZGVkIHdvdWxkIG90aGVyd2lzZSB3aW4gZXZlcnkgcmFjZSBmb3IgZXZlciDigJQgaXQgYWx3YXlzIHNvcnRzXG4gIC8vIGVhcmxpZXN0IOKAlCBhbmQgbm8gaG9zdCBjb3VsZCB1cGRhdGUgdGhlIGJyYW5jaCBhZ2Fpbi5cbiAgY29uc3QgY29tcGV0aW5nTG9ja3MgPSBmbGVldExvY2tzLmZpbHRlcigoYykgPT4ge1xuICAgIGNvbnN0IGxvY2tEYXRhID0gcGFyc2VMb2NrQ29tbWVudChjLmJvZHksIGxvY2tLaW5kKTtcbiAgICByZXR1cm4gbG9ja0RhdGEgIT09IG51bGwgJiYgbm93IC0gbG9ja0RhdGEudGltZXN0YW1wIDwgbG9ja1R0bFNlY29uZHM7XG4gIH0pO1xuICBjb25zdCBhbGxMb2NrQ29tbWVudHMgPSBbLi4ub3VyTG9ja3MsIC4uLmNvbXBldGluZ0xvY2tzXTtcblxuICAvLyBTdGVwIDU6IERldGVybWluZSB0aGUgd2lubmVyXG4gIGlmIChhbGxMb2NrQ29tbWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgLy8gT3VyIGNvbW1lbnQgdmFuaXNoZWQg4oCUIHNvbWV0aGluZyB1bmV4cGVjdGVkIGhhcHBlbmVkXG4gICAgYXdhaXQgZHJvcE93bkxvY2tDb21tZW50KCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGFjcXVpcmVkOiBmYWxzZSB9IH07XG4gIH1cblxuICBpZiAoYWxsTG9ja0NvbW1lbnRzLmxlbmd0aCA9PT0gMSkge1xuICAgIC8vIE5vIGNvbnRlbnRpb24g4oCUIHdlIGFyZSB0aGUgc29sZSBsb2NrIGhvbGRlclxuICAgIGNvbnN0IHNvbGVDb21tZW50ID0gYWxsTG9ja0NvbW1lbnRzWzBdITtcbiAgICBjb25zdCBsb2NrRGF0YSA9IHBhcnNlTG9ja0NvbW1lbnQoc29sZUNvbW1lbnQuYm9keSwgbG9ja0tpbmQpO1xuICAgIGlmIChsb2NrRGF0YT8ud29ya2VySWQgPT09IHdvcmtlcklkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgdmFsdWU6IHsgYWNxdWlyZWQ6IHRydWUsIGxvY2tDb21tZW50SWQ6IHNvbGVDb21tZW50LmlkIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICAvLyBUaGUgc29sZSBsb2NrIGlzIG5vdCBvdXJzIOKAlCBhbm90aGVyIHdvcmtlciBzbnVjayBpblxuICAgIGF3YWl0IGRyb3BPd25Mb2NrQ29tbWVudCgpO1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIGFjcXVpcmVkOiBmYWxzZSxcbiAgICAgICAgd2lubmVySWQ6IGxvY2tEYXRhPy53b3JrZXJJZCxcbiAgICAgICAgLi4uKGxvY2tEYXRhID8geyB3aW5uZXJMb2NrZWRBdDogbG9ja0RhdGEudGltZXN0YW1wIH0gOiB7fSksXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICAvLyBNdWx0aXBsZSBsb2NrcyDigJQgZWFybGllc3QgY3JlYXRlZF9hdCB3aW5zIChjb25zaXN0ZW50IHdpdGggQ0xBSU1fTE9DSylcbiAgY29uc3Qgc29ydGVkID0gWy4uLmFsbExvY2tDb21tZW50c10uc29ydCgoYSwgYikgPT5cbiAgICBhLmNyZWF0ZWRBdC5sb2NhbGVDb21wYXJlKGIuY3JlYXRlZEF0KVxuICApO1xuICBjb25zdCB3aW5uZXJDb21tZW50ID0gc29ydGVkWzBdITtcbiAgY29uc3Qgd2lubmVyRGF0YSA9IHBhcnNlTG9ja0NvbW1lbnQod2lubmVyQ29tbWVudC5ib2R5LCBsb2NrS2luZCk7XG4gIGNvbnN0IHdpbm5lcklkID0gd2lubmVyRGF0YT8ud29ya2VySWQgPz8gXCJcIjtcblxuICBpZiAod2lubmVySWQgPT09IHdvcmtlcklkKSB7XG4gICAgLy8gV2Ugd29uIHRoZSByYWNlXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHtcbiAgICAgICAgYWNxdWlyZWQ6IHRydWUsXG4gICAgICAgIGxvY2tDb21tZW50SWQ6IHdpbm5lckNvbW1lbnQuaWQsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICAvLyBXZSBsb3N0IOKAlCBjbGVhbiB1cCBvdXIgbG9jayBjb21tZW50LiBJdCBpcyBpZGVudGlmaWVkIGJ5IHRoZSBpZCBHaXRIdWJcbiAgLy8gcmV0dXJuZWQgd2hlbiB3ZSBwb3N0ZWQgaXQsIG5vdCBieSB0aGUgd29ya2VyIGlkIGluc2lkZSBhIGJvZHkgYW55b25lXG4gIC8vIG1heSBjb3B5IChJc3N1ZSAjMTI0OSkuXG4gIGF3YWl0IGRyb3BPd25Mb2NrQ29tbWVudCgpO1xuXG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHtcbiAgICAgIGFjcXVpcmVkOiBmYWxzZSxcbiAgICAgIHdpbm5lcklkLFxuICAgICAgLi4uKHdpbm5lckRhdGEgPyB7IHdpbm5lckxvY2tlZEF0OiB3aW5uZXJEYXRhLnRpbWVzdGFtcCB9IDoge30pLFxuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogUmVuZXcgYSBoZWxkIGxvY2sgYnkgcmV3cml0aW5nIGl0cyBjb21tZW50IHdpdGggYSBmcmVzaCB0aW1lc3RhbXBcbiAqIChJc3N1ZSAjMzc1NCkuXG4gKlxuICogV29yayB0aGF0IG91dGxpdmVzIHRoZSBUVEwg4oCUIGEgMzAtbWludXRlIENJIGZpeCBhZ2FpbnN0IGEgNS1taW51dGUgVFRMIOKAlFxuICogd291bGQgb3RoZXJ3aXNlIGJlIHRyZWF0ZWQgYXMgc3RhbGUgYW5kIGNsZWFuZWQgYnkgYSBzZWNvbmQgaG9zdCwgd2hpY2hcbiAqIGlzIGV4YWN0bHkgdGhlIGNvbmN1cnJlbnQtZml4IHJhY2UgdGhpcyBndWFyZHMgYWdhaW5zdC5cbiAqXG4gKiBGYWlscyBsb3VkOiBhIHJlbmV3YWwgZmFpbHVyZSBjb21lcyBiYWNrIGFzIGB7IG9rOiBmYWxzZSB9YCBzbyB0aGUgY2FsbGVyXG4gKiBjYW4gbG9nIGl0IHJhdGhlciB0aGFuIHNpbGVudGx5IGNvbnRpbnVpbmcgb24gYW4gZXhwaXJpbmcgbG9jay5cbiAqXG4gKiBAcGFyYW0gb3B0aW9ucyAtIFJlbmV3YWwgb3B0aW9uc1xuICogQHJldHVybnMgVGhlIG5ldyBsb2NrIHRpbWVzdGFtcCBvbiBzdWNjZXNzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW5ld0JyYW5jaFVwZGF0ZUxvY2soXG4gIG9wdGlvbnM6IEJyYW5jaFVwZGF0ZVJlbmV3T3B0aW9ucyxcbik6IFByb21pc2U8UmVzdWx0PG51bWJlcj4+IHtcbiAgY29uc3Qge1xuICAgIHJlcG8sXG4gICAgbG9ja0NvbW1lbnRJZCxcbiAgICB3b3JrZXJJZCxcbiAgICBub3RlLFxuICAgIGdoQ29tbWFuZEZuID0gcnVuR2hDb21tYW5kLFxuICAgIG5vd0ZuID0gZGVmYXVsdE5vdyxcbiAgfSA9IG9wdGlvbnM7XG5cbiAgY29uc3QgdGltZXN0YW1wID0gbm93Rm4oKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcImFwaVwiLFxuICAgICAgXCItWFwiLFxuICAgICAgXCJQQVRDSFwiLFxuICAgICAgYHJlcG9zLyR7cmVwb30vaXNzdWVzL2NvbW1lbnRzLyR7bG9ja0NvbW1lbnRJZH1gLFxuICAgICAgXCItZlwiLFxuICAgICAgYGJvZHk9JHtidWlsZExvY2tCb2R5KHdvcmtlcklkLCB0aW1lc3RhbXAsIG5vdGUpfWAsXG4gICAgXSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHRpbWVzdGFtcCB9O1xufVxuXG4vKipcbiAqIFN0YXJ0IHJlbmV3aW5nIGEgaGVsZCBsb2NrIHBlcmlvZGljYWxseSB1bnRpbCBzdG9wcGVkIChJc3N1ZSAjMzc1NCkuXG4gKlxuICogVGhlIGNhbGxlciBtdXN0IGBzdG9wKClgIHRoZSByZXR1cm5lZCBoYW5kbGUgb24gZXZlcnkgZXhpdCBwYXRoIOKAlFxuICogYWxvbmdzaWRlIHJlbGVhc2luZyB0aGUgbG9jayDigJQgc28gbm8gdGltZXIgb3V0bGl2ZXMgdGhlIHdvcmsgaXQgY292ZXJzLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gUmVuZXdhbCBvcHRpb25zLCBpbmNsdWRpbmcgdGhlIGludGVydmFsXG4gKiBAcmV0dXJucyBIYW5kbGUgdXNlZCB0byBzdG9wIHJlbmV3aW5nXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEJyYW5jaFVwZGF0ZUxvY2tSZW5ld2FsKFxuICBvcHRpb25zOiBCcmFuY2hMb2NrUmVuZXdhbE9wdGlvbnMsXG4pOiBCcmFuY2hMb2NrUmVuZXdhbEhhbmRsZSB7XG4gIGNvbnN0IHtcbiAgICBpbnRlcnZhbE1zID0gREVGQVVMVF9MT0NLX1JFTkVXQUxfSU5URVJWQUxfTVMsXG4gICAgb25FcnJvcixcbiAgICAuLi5yZW5ld09wdGlvbnNcbiAgfSA9IG9wdGlvbnM7XG5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcblxuICBjb25zdCB0aW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICByZW5ld0JyYW5jaFVwZGF0ZUxvY2socmVuZXdPcHRpb25zKS50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgIGlmICghcmVzdWx0Lm9rICYmICFzdG9wcGVkKSB7XG4gICAgICAgIG9uRXJyb3I/LihcbiAgICAgICAgICBgRmFpbGVkIHRvIHJlbmV3IFBSIGxvY2sgY29tbWVudCAke3JlbmV3T3B0aW9ucy5sb2NrQ29tbWVudElkfSBvbiBgICtcbiAgICAgICAgICAgIGAke3JlbmV3T3B0aW9ucy5yZXBvfTogJHtyZXN1bHQuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pO1xuICB9LCBpbnRlcnZhbE1zKTtcblxuICByZXR1cm4ge1xuICAgIHN0b3AoKTogdm9pZCB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuO1xuICAgICAgc3RvcHBlZCA9IHRydWU7XG4gICAgICBjbGVhckludGVydmFsKHRpbWVyKTtcbiAgICB9LFxuICB9O1xufVxuXG4vKipcbiAqIFJlbGVhc2UgYSBicmFuY2ggdXBkYXRlIGxvY2sgYnkgZGVsZXRpbmcgdGhlIGxvY2sgY29tbWVudC5cbiAqXG4gKiBUaGlzIHNob3VsZCBiZSBjYWxsZWQgYWZ0ZXIgdGhlIGJyYW5jaCB1cGRhdGUgY29tcGxldGVzIChzdWNjZXNzIG9yXG4gKiBmYWlsdXJlKSB0byBhbGxvdyBvdGhlciB3b3JrZXJzIHRvIHByb2NlZWQuXG4gKlxuICogQmVzdC1lZmZvcnQ6IGlmIHRoZSBkZWxldGUgZmFpbHMsIHRoZSBsb2NrIHdpbGwgZXhwaXJlIHZpYSBUVEwgY2xlYW51cC5cbiAqXG4gKiBAcGFyYW0gb3B0aW9ucyAtIFJlbGVhc2Ugb3B0aW9uc1xuICogQHJldHVybnMgUmVzdWx0IGluZGljYXRpbmcgc3VjY2VzcyAoYWx3YXlzIG9rIOKAlCBiZXN0LWVmZm9ydCByZWxlYXNlKVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVsZWFzZUJyYW5jaFVwZGF0ZUxvY2soXG4gIG9wdGlvbnM6IEJyYW5jaFVwZGF0ZVJlbGVhc2VPcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3Qge1xuICAgIHJlcG8sXG4gICAgbG9ja0NvbW1lbnRJZCxcbiAgICBnaENvbW1hbmRGbiA9IHJ1bkdoQ29tbWFuZCxcbiAgfSA9IG9wdGlvbnM7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcImFwaVwiLFxuICAgICAgXCItWFwiLFxuICAgICAgXCJERUxFVEVcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy9jb21tZW50cy8ke2xvY2tDb21tZW50SWR9YCxcbiAgICBdKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gQmVzdC1lZmZvcnQg4oCUIGxvY2sgd2lsbCBleHBpcmUgdmlhIFRUTCBjbGVhbnVwXG4gIH1cblxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTRDQyxHQUdELFNBQVMsWUFBWSxRQUFRLGNBQWM7QUFDM0MsU0FHRSwyQkFBMkIsUUFDdEIsMkJBQTJCO0FBQ2xDLFNBQ0Usa0JBQWtCLEVBQ2xCLG1CQUFtQixFQUNuQix1QkFBdUIsUUFDbEIsNEJBQTRCO0FBRW5DLDhFQUE4RTtBQUM5RSxZQUFZO0FBQ1osOEVBQThFO0FBRTlFLFNBQVMsV0FBVyxJQUE4QztFQUNoRSxJQUFJLFNBQVMsY0FBYyxPQUFPO0VBQ2xDLE9BQU8sU0FBUyxXQUNaLDRCQUNBO0FBQ047QUFFQSwwRUFBMEUsR0FDMUUsT0FBTyxNQUFNLDRCQUE0QiwyQkFBMkI7QUFFcEUsNkNBQTZDLEdBQzdDLE9BQU8sTUFBTSwyQkFBMkIsSUFBSTtB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
// denoCacheMetadata=3332958313964452577,6505851007698900120