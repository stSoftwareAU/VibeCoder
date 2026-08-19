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
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import { type CommentType, markCommentProcessed } from "./pr_comments.ts";

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
}

/** Result data from a successful claim operation. */
export interface ClaimPrCommentResult {
  claimed: boolean;
  winnerId?: string;
}

/** Claim comment parsed from the GitHub API. */
interface ClaimComment {
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
      }));
  } catch {
    return [];
  }
}

/**
 * Clean up stale claim comments from previous runs.
 *
 * Stale claim comments can accumulate if a worker crashes after posting
 * a claim but before completing work. We clean them all up before
 * attempting a new claim.
 */
async function cleanupStaleClaimComments(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<void> {
  let commentsJson: string;
  try {
    commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${PR_COMMENT_CLAIM_PREFIX}")) | .id]`,
    ]);
  } catch {
    return; // Best-effort
  }

  let ids: number[];
  try {
    const parsed: unknown = JSON.parse(commentsJson);
    if (!Array.isArray(parsed)) return;
    ids = (parsed as unknown[]).filter((v) =>
      typeof v === "number"
    ) as number[];
  } catch {
    return;
  }

  for (const id of ids) {
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
  } = options;

  // Step 1: Remove stale claim comments from previous runs
  await cleanupStaleClaimComments(repo, prNumber, ghCommandFn);

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
      `[.[] | select(.body | test("PR_COMMENT_CLAIM:")) | {id: .id, body: .body, created_at: .created_at}]`,
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

  // Step 6: Filter to only claims for the same target comment
  const relevantClaims = allClaimComments.filter((c) => {
    const info = extractClaimInfo(c.body);
    return info !== null && info.commentId === commentId;
  });

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
