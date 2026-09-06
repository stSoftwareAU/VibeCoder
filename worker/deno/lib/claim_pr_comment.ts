/**
 * Atomic PR comment claiming to prevent multiple workers from responding
 * to the same PR feedback simultaneously (Issue #1061).
 *
 * When multiple Vibe Coders scan for PR feedback concurrently, there is a
 * race condition window between discovering an unprocessed comment and
 * marking it as processed (eyes reaction). This module implements a
 * claim-then-verify pattern similar to claim_issue.ts:
 *
 *   1. Clean up stale claim comments from previous runs
 *   2. Post a hidden claim comment with the worker's unique ID and the
 *      target comment ID
 *   3. Brief pause for GitHub's eventual consistency
 *   4. Re-read the PR's comments to check for competing claims
 *   5. Earliest claim comment wins; losers clean up and back off
 *   6. Winner also adds eyes reaction to prevent rediscovery
 *
 * **A competing claim only counts when the fleet posted it (Issue #1124).**
 * A PR comment thread on a public repository is open to anyone, so a
 * `PR_COMMENT_CLAIM:` marker is a claim from a stranger unless the comment
 * **author** says otherwise — and the worker-id inside the marker is chosen
 * by whoever typed it. A planted claim sorts earliest and hands the PR to
 * nobody: every host loses the race to an account that will never do the
 * work. The re-read therefore carries `.user.login` and competing claims
 * are filtered against the fleet identity (`alert_dedup_authors.ts`),
 * exactly as `claim_issue.ts` filters `CLAIM_LOCK` authors.
 *
 * **The fail direction leaves the work claimable.** An unresolvable fleet
 * identity means no competing claim can be attributed, so none is counted
 * and this host claims. Two hosts doing the same feedback comment is a
 * wasted run; a comment no host may ever claim is feedback nobody answers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import { type CommentType, markCommentProcessed } from "./pr_comments.ts";
import {
  type AlertDedupAuthorOptions,
  type AlertDedupCommentRow,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";

/** The claim marker prefix used in PR comments for tie-breaking. */
export const PR_COMMENT_CLAIM_PREFIX = "<!-- PR_COMMENT_CLAIM:";

/** Options for a PR comment claim attempt. */
export interface ClaimPrCommentOptions {
  repo: string;
  prNumber: number;
  /** The ID of the comment being claimed (the feedback/review comment). */
  commentId: string;
  /** The type of comment for marking processed. */
  commentType?: CommentType;
  workerId: string;
  /** Injected sleep function (for testing). Defaults to real sleep. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injected gh command function (for testing). Defaults to runGhCommand. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Fleet identity inputs for the competing-claim author check
   * (Issue #1124). Omitted reads the configured fleet, which is what
   * every production caller does.
   */
  authorOptions?: AlertDedupAuthorOptions;
  /** Sink for the author-verification diagnostics. */
  log?: (message: string) => void;
  /**
   * Injected clock in epoch milliseconds, backing the stale-claim minimum age
   * (Issue #1249). Defaults to the wall clock.
   */
  nowMsFn?: () => number;
}

/**
 * Minimum age a claim comment must reach before the stale-claim cleanup may
 * delete it (Issue #1249, finding 7). Mirrors `claim_issue.ts`'s
 * `STALE_CLAIM_MIN_AGE_MS`: anything younger is a live claim — possibly a
 * fleet sibling's in-flight one — not the leftover of a crashed run.
 */
export const STALE_CLAIM_MIN_AGE_MS = 60_000;

/** Result data from a successful claim operation. */
export interface ClaimPrCommentResult {
  claimed: boolean;
  winnerId?: string;
}

/** Claim comment parsed from the GitHub API. */
interface ClaimComment extends AlertDedupCommentRow {
  id: number;
  body: string;
  createdAt: string;
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
 * Extract claim info (worker ID and target comment ID) from a claim comment.
 *
 * Pattern: `<!-- PR_COMMENT_CLAIM:worker-id:comment-id -->`
 */
export function extractClaimInfo(
  body: string,
): { workerId: string; commentId: string } | null {
  const match = body.match(/<!-- PR_COMMENT_CLAIM:(.+):(\d+) -->/);
  if (!match) return null;
  return { workerId: match[1]!, commentId: match[2]! };
}

/**
 * Parse claim comments from a GitHub API JSON response.
 *
 * Expects a JSON array of objects with id, body, and created_at fields.
 */
function parseClaimComments(json: string): ClaimComment[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, unknown>>)
      .filter(
        (c) =>
          typeof c.body === "string" &&
          (c.body as string).includes(PR_COMMENT_CLAIM_PREFIX),
      )
      .map((c) => ({
        id: Number(c.id),
        body: String(c.body),
        createdAt: String(c.created_at ?? c.createdAt ?? ""),
        author: typeof c.author === "string" ? c.author : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Clean up **stale, fleet-authored** claim comments from previous runs.
 *
 * Stale claim comments accumulate when a worker crashes after posting a claim
 * but before completing work, so they have to be cleared — but deletion is
 * destructive and this read is driven by a marker anyone can type
 * (Issue #1249, finding 7). Unfiltered it deleted **every** comment quoting
 * `<!-- PR_COMMENT_CLAIM:`, including a human's message about the marker and
 * a sibling host's in-flight claim posted seconds earlier. The sibling in
 * `claim_issue.ts` has carried both guards since Issue #3664; this is the
 * same pair:
 *
 *   1. the comment must be **fleet-authored** — the author is the only
 *      authenticated part of it; and
 *   2. it must be at least {@link STALE_CLAIM_MIN_AGE_MS} old — anything
 *      younger is a live claim, not the leftover of a crashed run.
 *
 * Fail direction: nothing attributable, or an unresolvable fleet identity,
 * deletes nothing. A leftover claim comment is cleared by the next run once
 * it can be attributed; a deleted human comment cannot be undone.
 */
async function cleanupStaleClaimComments(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
  authorOptions: AlertDedupAuthorOptions,
  log: (message: string) => void,
  nowMs: number,
): Promise<void> {
  let commentsJson: string;
  try {
    commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${PR_COMMENT_CLAIM_PREFIX}")) | ` +
      `{id: .id, body: .body, created_at: .created_at, author: .user.login}]`,
    ]);
  } catch {
    return; // Best-effort
  }

  const claims = parseClaimComments(commentsJson);
  const aged = claims.filter((c) => {
    const createdMs = Date.parse(c.createdAt);
    // An unparseable timestamp cannot be shown to be stale, so it is left.
    if (Number.isNaN(createdMs)) return false;
    return nowMs - createdMs >= STALE_CLAIM_MIN_AGE_MS;
  });

  const deletable = await selectFleetAuthoredComments(
    aged,
    `stale PR comment claim ${repo}#${prNumber}`,
    authorOptions,
    log,
    "no claim comment is deleted — a marker anyone can quote must not drive " +
      "a destructive write",
  );

  for (const { id } of deletable) {
    try {
      await ghCommandFn([
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/issues/comments/${id}`,
      ]);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Remove this worker's claim comment after losing a contested claim.
 */
async function removeOwnClaimComment(
  repo: string,
  prNumber: number,
  workerId: string,
  commentId: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<void> {
  try {
    const commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--jq",
      `[.[] | select(.body | contains("PR_COMMENT_CLAIM:${workerId}:${commentId}")) | .id] | .[0] // empty`,
    ]);
    const claimCommentId = commentsJson.trim();
    if (claimCommentId) {
      await ghCommandFn([
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/issues/comments/${claimCommentId}`,
      ]);
    }
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Atomically claim a PR comment before processing it.
 *
 * Posts a hidden claim comment on the PR, waits for GitHub consistency,
 * then verifies no competing claims exist for the same target comment.
 * If multiple workers claimed simultaneously, the earliest claim wins.
 *
 * On success, also marks the comment as processed (eyes reaction) to
 * prevent rediscovery by find_pr_comments_to_fix.
 *
 * @returns Result with claim outcome
 */
export async function claimPrComment(
  options: ClaimPrCommentOptions,
): Promise<Result<ClaimPrCommentResult>> {
  const {
    repo,
    prNumber,
    commentId,
    commentType = "issue",
    workerId,
    sleepFn = defaultSleep,
    ghCommandFn = runGhCommand,
    authorOptions = {},
    log = (message: string) => console.warn(message),
  } = options;

  // Step 1: Remove stale claim comments from previous runs
  await cleanupStaleClaimComments(
    repo,
    prNumber,
    ghCommandFn,
    authorOptions,
    log,
    (options.nowMsFn ?? (() => Date.now()))(),
  );

  // Step 2: Post a claim comment with unique worker identity + target comment ID.
  //
  // Issue #1659: include a human-readable line as well as the HTML comment
  // marker. An HTML-comment-only body renders as a completely blank comment
  // on GitHub, so when cleanup fails the issue thread shows "multiple blank
  // comments" with no explanation. The visible line mirrors the
  // `Claimed by \`${workerId}\`` convention used by claim_issue.ts.
  const claimBody = `${PR_COMMENT_CLAIM_PREFIX}${workerId}:${commentId} -->\n` +
    `Claiming PR feedback comment ${commentId} for worker \`${workerId}\`.`;

  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      claimBody,
    ]);
  } catch {
    // Failed to post claim comment — back off
    return { ok: true, value: { claimed: false } };
  }

  // Step 3: Immediately add eyes reaction to reduce the race window.
  // This prevents other workers from rediscovering the comment via
  // find_pr_comments_to_fix() while we verify our claim.
  await markCommentProcessed(
    repo,
    commentType,
    commentId,
    prNumber,
    ghCommandFn,
  );

  // Step 4: Brief pause for GitHub's eventual consistency to settle
  await sleepFn(3000);

  // Step 5: Re-read comments to check for competing claims
  let allClaimComments: ClaimComment[];
  try {
    const commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("PR_COMMENT_CLAIM:")) | ` +
      `{id: .id, body: .body, created_at: .created_at, author: .user.login}]`,
    ]);
    allClaimComments = parseClaimComments(commentsJson);
  } catch {
    // Failed to read comments — back off, clean up
    await removeOwnClaimComment(
      repo,
      prNumber,
      workerId,
      commentId,
      ghCommandFn,
    );
    return { ok: true, value: { claimed: false } };
  }

  // Step 6: Filter to only claims for the same target comment, then to the
  // ones a fleet account actually posted. Verifying the relevant claims
  // rather than the whole thread means the log names the comments that
  // would otherwise have cost this host the race.
  const relevantClaims = await selectFleetAuthoredComments(
    allClaimComments.filter((c) => {
      const info = extractClaimInfo(c.body);
      return info !== null && info.commentId === commentId;
    }),
    `PR comment claim ${repo}#${prNumber}`,
    authorOptions,
    log,
    "no competing claim is counted and the work stays claimable — a claim " +
      "marker anyone can post must not hand the PR to nobody",
  );

  // Step 7: Verify exclusive claim
  if (relevantClaims.length <= 1) {
    return { ok: true, value: { claimed: true, winnerId: workerId } };
  }

  // Multiple claims detected — earliest comment wins
  const sorted = [...relevantClaims].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  const earliest = sorted[0];
  const winnerInfo = earliest !== undefined
    ? extractClaimInfo(earliest.body)
    : null;
  const winnerId = winnerInfo?.workerId ?? "";

  if (winnerId === workerId) {
    return { ok: true, value: { claimed: true, winnerId: workerId } };
  }

  // Lost — clean up own claim comment
  await removeOwnClaimComment(repo, prNumber, workerId, commentId, ghCommandFn);

  return { ok: true, value: { claimed: false, winnerId } };
}
