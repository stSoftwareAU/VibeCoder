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
 * **A busy thread must not blind the claim (Issue #2266).** Every comment
 * read here was unpaginated, so GitHub returned only the 30 oldest comments
 * and past page one the sweep saw nothing to expire, the host could not see
 * the claim comment it had posted three seconds earlier, and the comment it
 * left behind was never found again. That is the shape that left 765
 * `BRANCH_UPDATE_LOCK` comments on NEAT-AI-Lamarck#239 before Issue #2265
 * fixed the same defect in `pr_branch_lock.ts`. The same three rules apply
 * here: the reads are paginated, the posted comment is deleted on **every**
 * not-claimed path — by the comment id `gh` returned when posting it, not by
 * matching a body anyone may copy — and an **expired** claim is ignored when
 * the winner is chosen, so a delete that never succeeded cannot wedge the PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
// The `#issuecomment-<id>` fragment `gh` prints is parsed identically for a
// lock comment and a claim comment, so the parser lives in one place.
import { parsePostedCommentId } from "./pr_branch_lock.ts";
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

/**
 * Stale claim comments deleted in one sweep (Issue #2266).
 *
 * The sweep now reads every page, so a thread that accumulated a backlog
 * while the read was blind can hold hundreds of aged claims — deleting them
 * all would turn one claim attempt into hundreds of serial API calls before
 * any feedback was answered. The backlog drains a pass at a time; nothing
 * waits on it, because an expired claim is already ignored when the winner
 * is chosen.
 */
export const DEFAULT_MAX_STALE_CLAIM_DELETIONS = 100;

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
 * Flatten what `gh api --paginate --jq '[…]'` prints (Issue #2266).
 *
 * `--paginate` applies the filter to each page in turn, so the payload is
 * one JSON array per line rather than a single array — and `--slurp`, which
 * would merge them, is refused alongside `--jq`. A malformed line throws: an
 * unreadable page is a failure the caller must handle, never an empty result
 * standing in for "no claims".
 *
 * Exported for the regression test.
 *
 * @param payload - Raw stdout from the paginated comment read
 * @returns Every claim comment across every page, in page order
 */
export function parseClaimCommentPages(payload: string): ClaimComment[] {
  const rows: ClaimComment[] = [];

  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) continue;

    for (const entry of parsed as Array<Record<string, unknown>>) {
      if (
        typeof entry.body !== "string" ||
        !entry.body.includes(PR_COMMENT_CLAIM_PREFIX)
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
 * Fetch every claim comment on a PR, across every page (Issue #2266).
 *
 * The endpoint stays the first argument — `gh` accepts its flags after it —
 * so the call reads as the endpoint it queries rather than as a flag.
 *
 * Throws when the read or a page fails: a blind read must never pass as an
 * empty thread, which is precisely how the claim leaked.
 */
async function fetchClaimComments(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<ClaimComment[]> {
  const payload = await ghCommandFn([
    "api",
    `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    "--paginate",
    "--jq",
    `[.[] | select(.body | test("${PR_COMMENT_CLAIM_PREFIX}")) | ` +
    `{id: .id, body: .body, created_at: .created_at, author: .user.login}]`,
  ]);

  return parseClaimCommentPages(payload);
}

/**
 * Delete one claim comment, reporting the failure rather than hiding it.
 *
 * @returns The error when the delete failed, or null when it succeeded
 */
async function deleteClaimComment(
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
  const where = `[claim-pr-comment] ${repo}#${prNumber}:`;

  let claims: ClaimComment[];
  try {
    claims = await fetchClaimComments(repo, prNumber, ghCommandFn);
  } catch (err) {
    log(
      `${where} could not read the claim comments, so no stale claim was ` +
        `expired this pass — ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return; // Best-effort
  }

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

  for (const { id } of deletable.slice(0, DEFAULT_MAX_STALE_CLAIM_DELETIONS)) {
    const error = await deleteClaimComment(repo, id, ghCommandFn);
    if (error) {
      log(
        `${where} could not delete stale claim comment ${id} — ` +
          `${error.message}`,
      );
    }
  }

  if (deletable.length > DEFAULT_MAX_STALE_CLAIM_DELETIONS) {
    log(
      `${where} ${
        deletable.length - DEFAULT_MAX_STALE_CLAIM_DELETIONS
      } stale claim comment(s) remain after this pass's ` +
        `${DEFAULT_MAX_STALE_CLAIM_DELETIONS}; the next pass clears more ` +
        `(Issue #2266)`,
    );
  }
}

/**
 * Take back the claim comment this host posted moments ago (Issue #2266).
 *
 * The comment is identified by the **id** `gh` returned when it was posted:
 * that id is the only authenticated statement about which comment in the
 * thread this host wrote, and the body-match lookup it replaces read page
 * one only — so on a long thread it found nothing and the claim comment
 * stayed on the PR for ever.
 *
 * `postedId` is null when `gh` printed no comment URL. The paginated
 * body-match lookup is then the only way back to the comment: it is weaker
 * evidence (a marker anyone may copy), so it is a fallback, never the
 * primary path, and it deletes only a comment carrying this host's own
 * worker id and target comment id.
 *
 * Best-effort — it never throws into a claim attempt — but never silent: a
 * comment left behind is said out loud, because silence is how 765 claim
 * comments piled up unnoticed.
 */
async function removeOwnClaimComment(
  repo: string,
  prNumber: number,
  postedId: number | null,
  workerId: string,
  commentId: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  log: (message: string) => void,
): Promise<void> {
  const where = `[claim-pr-comment] ${repo}#${prNumber}:`;

  let targetId = postedId;
  if (targetId === null) {
    try {
      const marker = `PR_COMMENT_CLAIM:${workerId}:${commentId}`;
      const claims = await fetchClaimComments(repo, prNumber, ghCommandFn);
      targetId = claims.find((c) => c.body.includes(marker))?.id ?? null;
    } catch (err) {
      log(
        `${where} gh returned no comment URL for this host's claim comment ` +
          `and the thread could not be re-read, so the comment is left on ` +
          `the PR for the next run's stale sweep — ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      return;
    }
  }

  if (targetId === null) {
    log(
      `${where} this host's claim comment could not be identified, so it is ` +
        `left on the PR for the next run's stale sweep`,
    );
    return;
  }

  const error = await deleteClaimComment(repo, targetId, ghCommandFn);
  if (error) {
    log(
      `${where} could not delete this host's own claim comment ${targetId} — ` +
        `the stale sweep clears it once it ages past ` +
        `${STALE_CLAIM_MIN_AGE_MS}ms: ${error.message}`,
    );
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

  const nowMs = (options.nowMsFn ?? (() => Date.now()))();

  // Step 1: Remove stale claim comments from previous runs
  await cleanupStaleClaimComments(
    repo,
    prNumber,
    ghCommandFn,
    authorOptions,
    log,
    nowMs,
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

  // `gh pr comment` prints the new comment's URL, whose `#issuecomment-<id>`
  // fragment identifies the comment this host just posted. That id — not the
  // worker id inside a body anyone may copy — is what makes the claim
  // comment ours to delete (Issue #2266).
  let ownClaimCommentId: number | null = null;
  try {
    const posted = await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      claimBody,
    ]);
    ownClaimCommentId = parsePostedCommentId(posted);
  } catch {
    // Failed to post claim comment — back off
    return { ok: true, value: { claimed: false } };
  }

  /**
   * Take the posted claim comment back on every not-claimed path.
   *
   * Before Issue #2266 each of those paths left it on the thread, so a host
   * that could never claim added one comment per cycle for ever.
   */
  const dropOwnClaimComment = () =>
    removeOwnClaimComment(
      repo,
      prNumber,
      ownClaimCommentId,
      workerId,
      commentId,
      ghCommandFn,
      log,
    );

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

  // Step 5: Re-read comments to check for competing claims. The read covers
  // every page: page one alone hid this host's own claim on any thread
  // longer than 30 comments (Issue #2266).
  let allClaimComments: ClaimComment[];
  try {
    allClaimComments = await fetchClaimComments(repo, prNumber, ghCommandFn);
  } catch {
    // Failed to read comments — back off, clean up
    await dropOwnClaimComment();
    return { ok: true, value: { claimed: false } };
  }

  // Step 6: Consider only the claims for this target comment. Ours is the
  // comment whose id GitHub returned when it was posted; everything else has
  // to prove a fleet account wrote it (Issue #1124). Verifying the relevant
  // claims rather than the whole thread means the log names the comments
  // that would otherwise have cost this host the race.
  const relevantClaims = allClaimComments.filter((c) => {
    const info = extractClaimInfo(c.body);
    return info !== null && info.commentId === commentId;
  });

  const ownMarker = `PR_COMMENT_CLAIM:${workerId}:${commentId}`;
  const isOurs = (c: ClaimComment) =>
    ownClaimCommentId !== null
      ? c.id === ownClaimCommentId
      : c.body.includes(ownMarker);
  const ourClaims = relevantClaims.filter(isOurs);

  const fleetClaims = await selectFleetAuthoredComments(
    relevantClaims.filter((c) => !isOurs(c)),
    `PR comment claim ${repo}#${prNumber}`,
    authorOptions,
    log,
    "no competing claim is counted and the work stays claimable — a claim " +
      "marker anyone can post must not hand the PR to nobody",
  );

  // An expired claim is not a competing claim, however long it lingers
  // (Issue #2266). The sweep is best-effort, so a delete that never
  // succeeded would otherwise win every race for ever — it always sorts
  // earliest — and no host could ever answer this feedback comment.
  //
  // Age is measured against this host's own claim comment when the thread
  // shows it: GitHub stamped both, so the comparison is free of clock skew.
  // A claim whose timestamp cannot be read cannot be shown to be live, and
  // the module's fail direction leaves the work claimable.
  const ownCreatedMs = Date.parse(ourClaims[0]?.createdAt ?? "");
  const anchorMs = Number.isNaN(ownCreatedMs) ? nowMs : ownCreatedMs;
  const competingClaims = fleetClaims.filter((c) => {
    const createdMs = Date.parse(c.createdAt);
    if (Number.isNaN(createdMs)) return false;
    return anchorMs - createdMs < STALE_CLAIM_MIN_AGE_MS;
  });

  // Step 7: Earliest live claim wins
  const contenders = [...ourClaims, ...competingClaims];
  if (contenders.length === 0) {
    // Our own claim is not in the thread we just read — nothing establishes
    // this host as the claimant, so back off and leave no comment behind.
    await dropOwnClaimComment();
    return { ok: true, value: { claimed: false } };
  }

  const earliest = [...contenders].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )[0]!;

  if (isOurs(earliest)) {
    return { ok: true, value: { claimed: true, winnerId: workerId } };
  }

  // Lost — clean up own claim comment
  const winnerId = extractClaimInfo(earliest.body)?.workerId ?? "";
  await dropOwnClaimComment();

  return { ok: true, value: { claimed: false, winnerId } };
}
