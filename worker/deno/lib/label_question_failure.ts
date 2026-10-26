/**
 * Question answering failure handling for the Vibe Coder worker (Issue #663).
 *
 * Handles the failure path when the worker cannot answer a `question`-labelled
 * issue. The question label is preserved so the question is retried (Issue #672).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import {
  detectFailureCategory,
  type FailureCategory,
  getFailureCategoryDisplay,
} from "./failure_diagnosis.ts";
import type {
  LabelManagerDeps,
  QuestionFailureOptions,
} from "./label_types.ts";
import { DEFAULT_LABEL_CONFIG } from "./label_types.ts";
import { addLabelToIssue, ensureLabelExists } from "./label_operations.ts";
import { checkIssueHasFailedOnce } from "./label_failure.ts";
import { redactSecrets } from "./secret_redaction.ts";

/**
 * Return a user-friendly reason for a question failure category.
 */
export function getQuestionFailureReason(category: FailureCategory): string {
  switch (category) {
    case "timeout":
      return "The question may require analysis that exceeds the time limit. Claude ran out of time before completing the answer.";
    case "zero_output":
      return "Claude produced no output. This is typically a startup or environment issue, not related to the question itself.";
    case "rate_limit":
      return "Claude was rate-limited during processing. This is a transient infrastructure issue and not related to the question.";
    case "internal_error":
      return "An internal error occurred in the worker tooling. This is not related to the question itself.";
    default:
      return "An unexpected error occurred while processing the question.";
  }
}

/**
 * Build a question-specific failure comment body.
 */
export function buildQuestionFailureComment(
  rawFailureMessage: string,
  isSecondFailure: boolean,
  questionLabel: string = "question",
): string {
  // Public sink: the raw failure text is arbitrary worker/Claude output, so
  // mask known secret shapes before publishing it, mirroring the equivalent
  // issue path in `label_failure.ts` (Issue #3707).
  const failureMessage = redactSecrets(rawFailureMessage);
  const failureCategory = detectFailureCategory(failureMessage);
  const categoryDisplay = getFailureCategoryDisplay(failureCategory);
  const reason = getQuestionFailureReason(failureCategory);

  const header = isSecondFailure
    ? "## Question Answering Failed (Repeat Attempt)"
    : "## Question Answering Failed";

  let commentBody = `${header}

**Category:** \`${categoryDisplay}\`

**Reason:** ${reason}

### Failure Details
${failureMessage}

### Suggestions
- **Simplify the question**: Try asking a more focused question about a single specific aspect
- **Break it down**: If your question has multiple parts, create separate issues for each part
- **Add context**: If the question references external resources, include the relevant details directly in the issue
- **Retry**: The \`${questionLabel}\` label has been kept — the question will be retried automatically`;

  if (isSecondFailure) {
    commentBody += `

### What happened?
This question has failed more than once. It keeps the \`${questionLabel}\` label and is retried automatically once its cooldown ends — the Vibe Coder never parks it (Issue #4158).`;
  }

  commentBody += `

*This notice was generated automatically by the Vibe Coder.*`;

  return commentBody;
}

/**
 * Handle a failed question answering attempt.
 *
 * Keeps the question label on the issue so the question can be retried
 * (Issue #672). Uses the failed-once/failed progression to track failures.
 */
export async function handleQuestionFailure(
  options: QuestionFailureOptions,
  deps: LabelManagerDeps = {},
): Promise<Result<void>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const labels = options.labels ?? DEFAULT_LABEL_CONFIG;

  const isSecondFailure = await checkIssueHasFailedOnce(
    options.repo,
    options.issueNumber,
    labels.failedOnceLabel,
    ghCommandFn,
  );

  // Build question-specific failure comment (Issue #663)
  let commentBody = buildQuestionFailureComment(
    options.failureMessage,
    isSecondFailure,
    labels.questionLabel,
  );

  // Append worker identity footer (Issue #436)
  if (options.workerFooter) {
    commentBody += options.workerFooter;
  }

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(options.issueNumber),
      "--repo",
      options.repo,
      "--body",
      commentBody,
    ]);
  } catch {
    // Best-effort
  }

  // Issue #4158: a repeat failure keeps `failed-once` and is never parked
  // behind `failed`; the question stays queued for its next attempt.
  await ensureLabelExists(
    options.repo,
    labels.failedOnceLabel,
    "fbca04",
    "Issue failed once - will be retried",
    deps,
  );
  // Issue #976: Use REST API with CLI fallback for label operations
  // Issue #978: Label-add is non-fatal — the comment is the primary signal
  const failedOnceResult = await addLabelToIssue(
    options.repo,
    options.issueNumber,
    labels.failedOnceLabel,
    deps,
  );
  if (!failedOnceResult.ok) {
    console.warn(
      `[label_manager] Warning: Failed to add '${labels.failedOnceLabel}' label to issue #${options.issueNumber} in ${options.repo} — continuing workflow (Issue #978)`,
    );
  }

  // Remove assignee
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(options.issueNumber),
      "--repo",
      options.repo,
      "--remove-assignee",
      options.githubUser,
    ]);
  } catch {
    // Best-effort
  }

  return { ok: true, value: undefined };
}
