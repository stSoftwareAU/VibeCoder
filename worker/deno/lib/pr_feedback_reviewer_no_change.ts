/**
 * Retry-and-escalate handling for an unanswered request-changes review
 * (Issue #3246).
 *
 * When a reviewer posts a CHANGES_REQUESTED review (claimed as commentType
 * `"pr_review"`), and the PR-feedback agent run ends with no commit and no
 * `.pr_response_message`, `processPrFeedback` used to post the canned
 * neutral reply "I reviewed this feedback and could not identify a code
 * change to apply…" via `replyNoChanges`. It also ignored an agent-written
 * `.pr_response_message` rebuttal on the no-change path.
 *
 * A `pr_review` claim dismisses the review (`markCommentProcessed` in
 * `pr_comments.ts`), and a dismissal cannot be undone (`removeProcessedMark`
 * errors for `pr_review`), so a later cycle can never retry it — the retry
 * must happen inside this run instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { CommentType } from "./pr_comments.ts";

/**
 * Agent runs at one claimed request-changes review before the worker
 * escalates to a human rather than retrying indefinitely.
 */
export const MAX_REVIEWER_NO_CHANGE_ATTEMPTS = 2;

/**
 * Whether `commentType` claims a reviewer's CHANGES_REQUESTED review, rather
 * than a plain inline (`"review"`) or top-level (`"issue"`) comment.
 *
 * The scan (`findPrCommentsToFix` in `pr_maintenance.ts`) surfaces a
 * `pr_review` only for a CHANGES_REQUESTED review from an authorised
 * commenter or trusted review bot, which is how the fleet reviewer App posts
 * its findings (`gh pr review --request-changes`,
 * `.claude/skills/review-fleet-prs/post.ts`); the App's login is not known to
 * the worker (`pr_reviewer_app` is read only by that skill), so the review
 * state, not the login, decides. Inline (`review`) and top-level (`issue`)
 * comments keep the neutral reply.
 */
export function isReviewerChangeRequest(commentType: CommentType): boolean {
  return commentType === "pr_review";
}

/**
 * Appended to the prompt on the in-run retry, telling the agent that a
 * request-changes review is never answered with silence (Issue #3246).
 */
export const REVIEWER_NO_CHANGE_RETRY_NOTE =
  "## Your previous attempt left this review unanswered\n\n" +
  "Your previous run on this request-changes review ended with no commit, " +
  "no working-tree change and no `.pr_response_message`. A reviewer's " +
  'finding is never answered with "no change". For each finding, either ' +
  "apply it and push the commit, or write `.pr_response_message` rebutting " +
  "that finding by name with evidence — the command you ran and its " +
  "output, or the line you cite. If this run also ends with neither, the " +
  "worker labels the PR `needs-human`.";

/** What one probe of the agent's run found. */
export type AgentAnswerProbe = "answered" | "nothing" | "unknown";

/** Dependencies for {@link probeAgentAnswer}. Undefined = could not be read. */
export interface AgentAnswerProbeDeps {
  /** Reads `.pr_response_message`, if any — without consuming it. */
  readResponseMessage(): Promise<string | undefined>;
  /** Whether the push branch's HEAD moved during the run. */
  headMoved(): Promise<boolean | undefined>;
  /** `git status --porcelain` output against the working tree. */
  workingTreeStatus(): Promise<string | undefined>;
}

/**
 * Decide whether the agent's run answered the review, left nothing to show
 * for it, or could not be determined either way.
 *
 * A non-empty trimmed `.pr_response_message`, a moved HEAD, or a non-empty
 * trimmed working-tree status all count as "answered". When none of those
 * hold but either the HEAD check or the status check could not be read,
 * the outcome is "unknown" rather than a false "nothing". Only when every
 * probe came back clean and readable is the outcome "nothing".
 */
export async function probeAgentAnswer(
  deps: AgentAnswerProbeDeps,
): Promise<AgentAnswerProbe> {
  const message = await deps.readResponseMessage();
  if (message !== undefined && message.trim().length > 0) return "answered";

  const moved = await deps.headMoved();
  if (moved === true) return "answered";

  const status = await deps.workingTreeStatus();
  if (status !== undefined && status.trim().length > 0) return "answered";

  if (moved === undefined || status === undefined) return "unknown";
  return "nothing";
}

/** Escalation content for an unanswered request-changes review. */
export interface ReviewerNoChangeEscalation {
  heading: string;
  reason: string;
  nextStep: string;
}

/**
 * Build the `needs-human` escalation content for a request-changes review
 * that no run answered with either a fix or a rebuttal (Issue #3246).
 */
export function buildReviewerNoChangeEscalation(opts: {
  reviewId: string;
  attempts: number;
  lastExitCode: number;
  lastDurationSeconds: number;
}): ReviewerNoChangeEscalation {
  const { reviewId, attempts, lastExitCode, lastDurationSeconds } = opts;
  return {
    heading: "PR review not answered",
    reason:
      `Review ${reviewId} requested changes, and ${attempts} feedback run(s) ` +
      `on it ended with no fix pushed and no rebuttal written in ` +
      `\`.pr_response_message\` (last run: exit code ${lastExitCode}, ` +
      `${lastDurationSeconds}s). The worker claimed the review by ` +
      `dismissing it, so no later cycle will pick it up again.`,
    nextStep: "Apply the review's findings on this branch, or submit a new " +
      "request-changes review so the worker tries again.",
  };
}
