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
 * Mark a comment as processed by adding an eyes reaction (or dismissing a review).
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentType - Type of comment ("review", "issue", or "pr_review")
 * @param commentId - The comment or review ID
 * @param prNumber - PR number (required for pr_review type)
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function markCommentProcessed(
  repo: string,
  commentType: CommentType,
  commentId: string,
  prNumber?: number,
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
          "message=Changes have been addressed by the automated worker.",
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
    // A page that cannot be parsed throws: an unreadable page must never
    // pass as "this account left no marker".
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const reactor = String(entry.login ?? "").trim().toLowerCase();
      if (reactor !== login) continue;
      mine.push({ id: Number(entry.id), login: reactor });
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
 * error so the caller can name the consequence, and is never swallowed.
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
  // A dismissed review is the `pr_review` marker, and GitHub offers no
  // un-dismissal — so this is reported, not papered over.
  if (commentType === "pr_review") {
    return new Error(
      `review ${commentId} on ${repo} was dismissed to mark it processed, ` +
        `and a dismissal cannot be undone`,
    );
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
 * @param repo - Repository in "owner/repo" format
 * @param commentType - Type of comment ("review" or "issue")
 * @param commentId - The comment ID
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param trustedReactors - Logins whose `confused` reaction counts
 * @returns true if the fleet has marked the comment as failed once
 */
export async function checkPrCommentHasFailedOnce(
  repo: string,
  commentType: CommentType,
  commentId: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  trustedReactors: readonly string[] = [],
): Promise<boolean> {
  const trusted = trustedReactors
    .filter((r) => typeof r === "string" && r.trim().length > 0)
    .map((r) => r.trim().toLowerCase());
  if (trusted.length === 0) return false;

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
 * Mark a PR comment as having failed once (confused reaction + reply).
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param commentType - Type of comment
 * @param commentId - The comment ID
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
  // Add confused reaction
  const reactionPath = reactionsPath(repo, commentType, commentId);

  try {
    await ghCommandFn([
      "api",
      "-X",
      "POST",
      reactionPath,
      "-f",
      "content=confused",
    ]);
  } catch {
    // Reaction failure is not fatal
  }

  // Public sink: the failure text is arbitrary worker/Claude output, so mask
  // known secret shapes before it is published (Issue #3707).
  const body = `## Automated Processing Failed (First Attempt)

The automated worker encountered an issue while processing this comment and will retry.

### Failure Details
${redactSecrets(failureMessage)}

### What happens next?
- This comment has been marked for retry (confused reaction added)
- The worker will attempt to process it again on the next scan
- If it fails again, manual intervention will be required`;

  await replyToComment(repo, prNumber, body, ghCommandFn);
}

/**
 * Mark a PR comment as permanently failed (eyes reaction + reply).
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param commentType - Type of comment
 * @param commentId - The comment ID
 * @param failureMessage - Description of the failure
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 */
export async function markPrCommentAsFailed(
  repo: string,
  prNumber: number,
  commentType: CommentType,
  commentId: string,
  failureMessage: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<void> {
  // Mark as processed (eyes) to prevent further retries
  await markCommentProcessed(
    repo,
    commentType,
    commentId,
    prNumber,
    ghCommandFn,
  );

  // Public sink — same reasoning as the first-attempt reply (Issue #3707).
  const body =
    `## Automated Processing Failed (Second Attempt - Permanently Failed)

The automated worker has failed to process this comment twice and will not retry automatically.

### Failure Details
${redactSecrets(failureMessage)}

### Why this might be happening
- The requested change may be too complex for automated processing
- The comment may need more detail or clarification
- There may be dependencies or context that Claude doesn't have

### To retry this comment
1. Address the underlying issue described above
2. Post a new comment with clarified requirements
3. The worker will pick up the new comment on the next scan`;

  await replyToComment(repo, prNumber, body, ghCommandFn);
}

/**
 * Unified failure handler for PR comment processing.
 *
 * Checks if this is the first or second failure and calls the appropriate
 * mark function.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param commentType - Type of comment
 * @param commentId - The comment ID
 * @param failureMessage - Description of the failure
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param trustedReactors - Logins whose `confused` reaction counts as the
 *   failed-once marker (Issue #1249). Omitted resolves the configured fleet
 *   identity; an unresolvable fleet means no reaction is trusted, so the
 *   comment is retried rather than permanently retired.
 */
export async function handlePrCommentFailure(
  repo: string,
  prNumber: number,
  commentType: CommentType,
  commentId: string,
  failureMessage: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  trustedReactors?: readonly string[],
): Promise<void> {
  const trusted = trustedReactors ??
    await resolveAlertDedupAuthors({}, (m) => console.warn(m));
  const hasFailedOnce = await checkPrCommentHasFailedOnce(
    repo,
    commentType,
    commentId,
    ghCommandFn,
    trusted,
  );

  if (hasFailedOnce) {
    await markPrCommentAsFailed(
      repo,
      prNumber,
      commentType,
      commentId,
      failureMessage,
      ghCommandFn,
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
