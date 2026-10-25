/**
 * PR comment management for the Vibe Coder worker (Issue #915).
 *
 * Handles marking comments as processed, replying to comments,
 * and failure handling for PR comment processing.
 *
 * Replaces the comment-related functions from worker/shared/pr_manager.sh.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { resolveAlertDedupAuthors } from "./alert_dedup_authors.ts";
import { runGhOrThrow } from "./gh_spawn.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { fetchMarkerComments } from "./marker_comment_pages.ts";
import {
  abandonAndRestart,
  type AbandonRestartOutcome,
  type AbandonRestartRequest,
} from "./conflict_abandon_restart.ts";

/** Comment type for API routing. */
export type CommentType = "review" | "issue" | "pr_review";

/** Information about a PR comment to fix. */
export interface PrCommentToFix {
  /** Repository in "owner/repo" format */
  repo: string;
  /** PR number */
  prNumber: number;
  /** Branch name */
  branchName: string;
  /** Type of comment */
  commentType: CommentType;
  /** Comment or review ID */
  commentId: string;
  /** Base64-encoded comment body */
  encodedBody: string;
  /**
   * GitHub login of the comment author. Optional for backward
   * compatibility — populated by `findActionableComment` so downstream
   * PR-feedback processing can apply author-based gating without a
   * second `gh` fetch.
   */
  commentAuthor?: string;
  /**
   * ISO 8601 creation time of the comment, when the API supplied one
   * (Issue #211). The scan uses it to drop feedback a later fleet push has
   * already answered.
   */
  commentCreatedAt?: string;
}

/** Default gh command function — routed through the shared chokepoint. */
async function defaultGhCommand(args: string[]): Promise<string> {
  return await runGhOrThrow(args);
}

/**
 * Marker prefix recording a `pr_review` comment's first failure on the PR
 * thread (Issue #3383). A review is not an issue comment, so it has no
 * `reactions` endpoint of its own to carry a `confused` marker — the record
 * lives instead in a reply on the PR thread, keyed by review id.
 */
export const PR_REVIEW_FAILED_ONCE_PREFIX = "<!-- PR_REVIEW_FAILED_ONCE:";

/**
 * Build the hidden marker that records a `pr_review`'s first failure.
 *
 * @param reviewId - The review's id
 * @returns The exact marker text, as embedded in a reply body
 */
export function prReviewFailedOnceMarker(reviewId: string): string {
  return `${PR_REVIEW_FAILED_ONCE_PREFIX}${reviewId} -->`;
}

/**
 * The reactions collection for a comment, by type.
 *
 * Review comments live under `pulls/comments`, everything else under
 * `issues/comments`; one helper so the add, the read and the removal cannot
 * disagree about which endpoint a comment type maps to.
 */
function reactionsPath(
  repo: string,
  commentType: CommentType,
  commentId: string,
): string {
  return commentType === "review"
    ? `repos/${repo}/pulls/comments/${commentId}/reactions`
    : `repos/${repo}/issues/comments/${commentId}/reactions`;
}

/**
 * How a `pr_review` was settled — selects the dismissal message GitHub shows
 * on the dismissed review (Issue #3409). Only `addressed` claims the requested
 * changes were made; every other outcome says what actually happened.
 */
export type ReviewDismissalOutcome =
  | "addressed"
  | "permanently_failed"
  | "rebuttal"
  | "handed_off";

/** The dismissal message for each {@link ReviewDismissalOutcome}. */
export const REVIEW_DISMISSAL_MESSAGES: Record<ReviewDismissalOutcome, string> =
  {
    addressed: "Changes have been addressed by the automated worker.",
    permanently_failed:
      "Not addressed after two automated attempts — see the PR thread.",
    rebuttal:
      "Answered with a rebuttal — no code change was made. See the PR thread.",
    handed_off:
      "Not addressed — handed off to a follow-up issue. See the PR thread.",
  };

/**
 * Mark a comment as processed by adding an eyes reaction (or dismissing a
 * review).
 *
 * A dismissed `pr_review` carries the {@link REVIEW_DISMISSAL_MESSAGES} entry
 * for `outcome`; only `"addressed"` claims the change was made, so a review
 * that was rebutted, handed off or permanently failed is never
 * reported as addressed (Issue #3409).
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentType - Type of comment ("review", "issue", or "pr_review")
 * @param commentId - The comment or review ID
 * @param prNumber - PR number (required for pr_review type)
 * @param outcome - How the comment was settled; selects the dismissal message
 *   for `pr_review` and is unused for the other comment types (eyes reaction)
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function markCommentProcessed(
  repo: string,
  commentType: CommentType,
  commentId: string,
  prNumber: number | undefined,
  outcome: ReviewDismissalOutcome,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<Result<void, Error>> {
  try {
    if (commentType === "review") {
      await ghCommandFn([
        "api",
        "-X",
        "POST",
        reactionsPath(repo, commentType, commentId),
        "-f",
        "content=eyes",
      ]);
    } else if (commentType === "pr_review") {
      if (prNumber !== undefined) {
        await ghCommandFn([
          "api",
          "-X",
          "PUT",
          `repos/${repo}/pulls/${prNumber}/reviews/${commentId}/dismissals`,
          "-f",
          `message=${REVIEW_DISMISSAL_MESSAGES[outcome]}`,
        ]);
      }
    } else {
      await ghCommandFn([
        "api",
        "-X",
        "POST",
        reactionsPath(repo, commentType, commentId),
        "-f",
        "content=eyes",
      ]);
    }
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to mark comment processed: ${msg}`),
    };
  }
}

/** One `eyes` reaction on a comment, with the account that left it. */
interface OwnReaction {
  id: number;
  login: string;
}

/**
 * Read the `eyes` reactions this account left on a comment (Issue #2269).
 *
 * The reaction **id** is what the delete endpoint takes, and GitHub only lets
 * an account remove its own reaction, so the acting login — not the fleet set
 * — is the filter: a sibling host's marker is not this run's to take back.
 *
 * Throws rather than returning an empty list: "no reaction" and "the list
 * could not be read" lead to opposite actions, and the caller has to be able
 * to say the marker may still stand.
 */
async function fetchOwnEyesReactions(
  repo: string,
  commentType: CommentType,
  commentId: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<OwnReaction[]> {
  const login = (await ghCommandFn(["api", "user", "--jq", ".login"])).trim()
    .toLowerCase();
  if (login.length === 0) {
    throw new Error("gh reported no acting login");
  }

  const payload = await ghCommandFn([
    "api",
    // Paginated, and filtered to `eyes` by the API: a stranger's 30 other
    // reactions must not bury the fleet's own marker on page one.
    `${reactionsPath(repo, commentType, commentId)}?content=eyes&per_page=100`,
    "--paginate",
    "--jq",
    "[.[] | {id: .id, login: .user.login}]",
  ]);

  const mine: OwnReaction[] = [];
  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // A page that cannot be parsed, or that is not the array the filter asks
    // for, throws: an unreadable page must never pass as "this account left
    // no marker".
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `unexpected reactions payload: ${trimmed.slice(0, 120)}`,
      );
    }
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const reactor = String(entry.login ?? "").trim().toLowerCase();
      if (reactor !== login) continue;
      // An id that is not a number cannot address the delete endpoint, and
      // `reactions/NaN` would only fail later as a puzzling 404.
      const id = typeof entry.id === "number" ? entry.id : Number.NaN;
      if (!Number.isInteger(id)) {
        throw new Error(
          `reactions payload carried an unusable reaction id: ` +
            `${JSON.stringify(entry.id)}`,
        );
      }
      mine.push({ id, login: reactor });
    }
  }
  return mine;
}

/**
 * Take back the processed marker this account added (Issue #2269).
 *
 * The 👀 marker is what stops `findActionableComment` rediscovering a PR
 * feedback comment, so a marker left on a comment nobody went on to claim is
 * feedback no host will ever answer. The claim path adds the marker before it
 * verifies the claim — deliberately, to narrow the race window — and calls
 * this on every path that ends with **no winner**.
 *
 * Never throws into the caller: the failure travels back as the returned
 * error so the caller can name the consequence, and is never swallowed. The
 * `Error | null` shape mirrors `deleteIssueComment`, the sibling delete
 * helper the claim already reports failures through.
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentType - Type of comment ("review", "issue", or "pr_review")
 * @param commentId - The comment ID
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param log - Sink for the per-reaction diagnostics
 * @returns null when the comment carries no marker from this account any
 *   more, or the error explaining why the marker may still stand
 */
export async function removeProcessedMark(
  repo: string,
  commentType: CommentType,
  commentId: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<Error | null> {
  // A `pr_review` claim no longer dismisses the review to mark it processed
  // (Issue #3383), so there is no mark on the review itself to take back —
  // nothing to undo, and no gh call to make.
  if (commentType === "pr_review") {
    return null;
  }

  let reactions: OwnReaction[];
  try {
    reactions = await fetchOwnEyesReactions(
      repo,
      commentType,
      commentId,
      ghCommandFn,
    );
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }

  let failure: Error | null = null;
  for (const reaction of reactions) {
    try {
      await ghCommandFn([
        "api",
        "-X",
        "DELETE",
        `${reactionsPath(repo, commentType, commentId)}/${reaction.id}`,
      ]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log(
        `[pr-comments] could not remove the eyes reaction ${reaction.id} ` +
          `from ${repo} comment ${commentId}: ${error.message}`,
      );
      failure ??= error;
    }
  }
  return failure;
}

/**
 * Post a reply comment on a PR.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param message - Reply message
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function replyToComment(
  repo: string,
  prNumber: number,
  message: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<Result<void, Error>> {
  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      message,
    ]);
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to reply to PR #${prNumber}: ${msg}`),
    };
  }
}

/**
 * Fetch the logins that left a given reaction on a comment (Issue #1249).
 *
 * The comment payload exposes only a reaction **count**, and any account may
 * react on any comment, so a count establishes nothing about who reacted.
 * The per-comment reactions endpoint names them — the same treatment
 * `fetchCommentThumbsUpReactors` already gives `+1` (Issue #2484).
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentType - Type of comment ("review" or "issue")
 * @param commentId - The comment ID
 * @param content - Reaction content, e.g. `confused` or `eyes`
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Logins that left the reaction (empty on error)
 */
export async function fetchCommentReactors(
  repo: string,
  commentType: CommentType,
  commentId: string,
  content: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<string[]> {
  const apiPath = reactionsPath(repo, commentType, commentId);

  let output: string;
  try {
    output = await ghCommandFn([
      "api",
      // Paginated: the endpoint returns 30 per page, so without this a
      // stranger could bury the fleet's own reaction under 30 of their own
      // and the marker would read as absent for ever.
      "--paginate",
      apiPath,
      "--jq",
      `[.[] | select(.content == "${content}") | .user.login]`,
    ]);
  } catch (err) {
    // Never a silent "nobody reacted": the caller cannot tell an empty list
    // from an unreadable one, so the condition is logged where it happens.
    log(
      `[pr-comments] could not read ${content} reactors on ${repo} comment ` +
        `${commentId}: ${err instanceof Error ? err.message : String(err)} ` +
        `— treated as no reaction (Issue #1249)`,
    );
    return [];
  }

  // `--paginate` on a JSON-array endpoint concatenates arrays; gh renders
  // them as one array or several back to back, so parse each in turn.
  const logins: string[] = [];
  for (const chunk of output.split("\n")) {
    const text = chunk.trim();
    if (text.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log(
        `[pr-comments] unparseable ${content} reactions payload on ${repo} ` +
          `comment ${commentId} — treated as no reaction (Issue #1249)`,
      );
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) {
      if (typeof value === "string") logins.push(value);
    }
  }
  return logins;
}

/**
 * Check if a PR comment carries a **fleet-authored** "confused" reaction —
 * the failed-once marker.
 *
 * A bare `confused` count proves nothing: any account can react on any
 * comment, and this flag is what promotes the next failure straight to
 * *permanent* (Issue #1249, finding 5). One drive-by reaction therefore
 * retired a comment the worker would otherwise have retried. The reactor
 * logins are resolved and checked against the fleet, exactly as
 * `pr_maintenance.ts` already does for `+1`.
 *
 * Fail direction: no attributable reactor — including an empty
 * `trustedReactors`, an unreadable reactions list or an API failure — reports
 * **not** failed-once, so the comment is retried rather than permanently
 * retired. A retry is cheap; a wrongly-retired comment is feedback nobody
 * answers.
 *
 * A `pr_review` has no `reactions` endpoint of its own (Issue #3383), so its
 * marker is a {@link prReviewFailedOnceMarker} comment on the PR thread
 * instead, and reading it needs the PR number. The same fail direction
 * applies: no `prNumber`, or a thread read that fails, reports not
 * failed-once rather than throwing or guessing.
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentType - Type of comment ("review", "issue", or "pr_review")
 * @param commentId - The comment ID (the review id, for `pr_review`)
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param trustedReactors - Logins whose `confused` reaction, or PR-thread
 *   marker comment, counts as fleet-authored
 * @param prNumber - PR number whose thread carries the `pr_review` marker.
 *   Required to resolve the marker for `pr_review`; ignored otherwise.
 * @returns true if the fleet has marked the comment as failed once
 * @param restart - Abandon-and-restart override (tests); defaults to
 *   `abandonAndRestart` over `ghCommandFn` (Issue #4304).
 */
export async function checkPrCommentHasFailedOnce(
  repo: string,
  commentType: CommentType,
  commentId: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  trustedReactors: readonly string[] = [],
  prNumber?: number,
): Promise<boolean> {
  const trusted = trustedReactors
    .filter((r) => typeof r === "string" && r.trim().length > 0)
    .map((r) => r.trim().toLowerCase());
  if (trusted.length === 0) return false;

  if (commentType === "pr_review") {
    if (prNumber === undefined) {
      console.warn(
        `[pr-comments] the failed-once marker for review ${commentId} on ` +
          `${repo} lives on the PR thread, and no PR number was given — ` +
          `treated as not failed once`,
      );
      return false;
    }
    let markerComments;
    try {
      markerComments = await fetchMarkerComments(
        repo,
        prNumber,
        PR_REVIEW_FAILED_ONCE_PREFIX,
        ghCommandFn,
      );
    } catch (err) {
      console.warn(
        `[pr-comments] could not read the failed-once marker for review ` +
          `${commentId} on ${repo} PR #${prNumber}: ` +
          `${err instanceof Error ? err.message : String(err)} — treated ` +
          `as not failed once`,
      );
      return false;
    }
    const marker = prReviewFailedOnceMarker(commentId);
    return markerComments.some(
      (comment) =>
        comment.body.includes(marker) &&
        trusted.includes(
          (comment.author ?? "").trim().toLowerCase(),
        ),
    );
  }

  const reactors = await fetchCommentReactors(
    repo,
    commentType,
    commentId,
    "confused",
    ghCommandFn,
  );
  return reactors.some((login) => trusted.includes(login.trim().toLowerCase()));
}

/**
 * Mark a PR comment as having failed once.
 *
 * For `review`/`issue` comments this adds a `confused` reaction and replies.
 * A `pr_review` has no `reactions` endpoint of its own, so no reaction call
 * is made for it (Issue #3383) — the marker is a
 * {@link prReviewFailedOnceMarker} embedded in the reply instead, and the
 * review itself is left undismissed so it still requests changes.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param commentType - Type of comment
 * @param commentId - The comment ID (the review id, for `pr_review`)
 * @param failureMessage - Description of the failure
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 */
export async function markPrCommentAsFailedOnce(
  repo: string,
  prNumber: number,
  commentType: CommentType,
  commentId: string,
  failureMessage: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<void> {
  // A review has no `reactions` endpoint of its own — a `confused` reaction
  // would land on the wrong resource (Issue #3383) — so the marker for
  // `pr_review` lives only in the reply body below, never as a reaction.
  if (commentType !== "pr_review") {
    try {
      await ghCommandFn([
        "api",
        "-X",
        "POST",
        reactionsPath(repo, commentType, commentId),
        "-f",
        "content=confused",
      ]);
    } catch {
      // Reaction failure is not fatal
    }
  }

  // Public sink: the failure text is arbitrary worker/Claude output, so mask
  // known secret shapes before it is published (Issue #3707).
  const markerLine = commentType === "pr_review"
    ? `${prReviewFailedOnceMarker(commentId)}\n`
    : "";
  const whatHappensNext = commentType === "pr_review"
    ? `- This attempt has been recorded on this PR, and the review is left ` +
      `undismissed — it still requests changes\n` +
      `- The worker will attempt to process it again on the next scan\n` +
      `- If it fails again, this PR is closed and its issue redone from ` +
      `the base branch (Issue #4304)`
    : `- This comment has been marked for retry (confused reaction added)\n` +
      `- The worker will attempt to process it again on the next scan\n` +
      `- If it fails again, this PR is closed and its issue redone from ` +
      `the base branch (Issue #4304)`;
  const body = `${markerLine}## Automated Processing Failed (First Attempt)

The automated worker encountered an issue while processing this comment and will retry.

### Failure Details
${redactSecrets(failureMessage)}

### What happens next?
${whatHappensNext}`;

  await replyToComment(repo, prNumber, body, ghCommandFn);
}

/**
 * Settle a comment that failed twice by redoing the work (Issue #4304).
 *
 * It used to be marked "permanently failed" with a reply asking the reviewer
 * to post a clarified comment — a hand-back. Instead the PR is closed and its
 * originating issue re-queued through the stall ladder's rung
 * (`abandonAndRestart`), and only then is the comment marked processed, so
 * the closed PR's comment is not picked up again. A restart that is declined
 * or fails leaves the comment unmarked: the next cycle retries it.
 *
 * @returns `true` when the PR was closed and the comment marked processed.
 */
async function restartAfterRepeatedFailure(
  repo: string,
  prNumber: number,
  commentType: CommentType,
  commentId: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  trustedAuthors: readonly string[],
  restart?: (request: AbandonRestartRequest) => Promise<AbandonRestartOutcome>,
): Promise<boolean> {
  let refs: { headRefName?: unknown; baseRefName?: unknown };
  try {
    refs = JSON.parse(
      await ghCommandFn([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "headRefName,baseRefName",
      ]),
    );
  } catch (err) {
    console.warn(
      `[pr-comments] ${repo}#${prNumber}: could not read the PR's branches ` +
        `to restart it after a repeated failure — retried next cycle ` +
        `(Issue #4304): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  if (
    typeof refs.headRefName !== "string" || refs.headRefName === "" ||
    typeof refs.baseRefName !== "string" || refs.baseRefName === ""
  ) {
    console.warn(
      `[pr-comments] ${repo}#${prNumber}: the PR named no branches — ` +
        `retried next cycle (Issue #4304)`,
    );
    return false;
  }
  const rung = restart ??
    ((request: AbandonRestartRequest) =>
      abandonAndRestart(request, { gh: ghCommandFn, trustedAuthors }));
  let outcome: AbandonRestartOutcome;
  try {
    outcome = await rung({
      repo,
      prNumber,
      branchName: refs.headRefName,
      baseBranch: refs.baseRefName,
      reason: {
        kind: "stalled",
        detail: "has feedback the worker failed to process in two automated " +
          "attempts",
        tried: "review-retry",
      },
    });
  } catch (err) {
    console.warn(
      `[pr-comments] ${repo}#${prNumber}: restart after a repeated failure ` +
        `threw — retried next cycle (Issue #4304): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return false;
  }
  if (
    outcome.outcome !== "abandoned" &&
    outcome.outcome !== "closed-without-issue"
  ) {
    console.warn(
      `[pr-comments] ${repo}#${prNumber}: restart after a repeated failure ` +
        `did not complete (${outcome.outcome}) — retried next cycle ` +
        `(Issue #4304)`,
    );
    return false;
  }
  await markCommentProcessed(
    repo,
    commentType,
    commentId,
    prNumber,
    "permanently_failed",
    ghCommandFn,
  );
  return true;
}

/**
 * Unified failure handler for PR comment processing.
 *
 * A first failure is marked for retry. A second closes the PR and redoes its
 * issue (Issue #4304) — it is never left "permanently failed" for a person.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param commentType - Type of comment
 * @param commentId - The comment ID
 * @param failureMessage - Description of the failure
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param trustedReactors - Logins whose `confused` reaction, or `pr_review`
 *   marker comment, counts as the failed-once marker (Issue #1249). Omitted
 *   resolves the configured fleet identity; an unresolvable fleet means
 *   nothing is trusted, so the comment is retried rather than permanently
 *   retired.
 */
export async function handlePrCommentFailure(
  repo: string,
  prNumber: number,
  commentType: CommentType,
  commentId: string,
  failureMessage: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  trustedReactors?: readonly string[],
  restart?: (request: AbandonRestartRequest) => Promise<AbandonRestartOutcome>,
): Promise<void> {
  const trusted = trustedReactors ??
    await resolveAlertDedupAuthors({}, (m) => console.warn(m));
  const hasFailedOnce = await checkPrCommentHasFailedOnce(
    repo,
    commentType,
    commentId,
    ghCommandFn,
    trusted,
    prNumber,
  );

  if (hasFailedOnce) {
    await restartAfterRepeatedFailure(
      repo,
      prNumber,
      commentType,
      commentId,
      ghCommandFn,
      trusted,
      restart,
    );
  } else {
    await markPrCommentAsFailedOnce(
      repo,
      prNumber,
      commentType,
      commentId,
      failureMessage,
      ghCommandFn,
    );
  }
}

/**
 * Format a PR comment to fix as a pipe-delimited string (for shell integration).
 *
 * @param comment - The comment information
 * @returns Pipe-delimited string
 */
export function formatPrCommentToFix(comment: PrCommentToFix): string {
  return `${comment.repo}|${comment.prNumber}|${comment.branchName}|${comment.commentType}|${comment.commentId}|${comment.encodedBody}`;
}
