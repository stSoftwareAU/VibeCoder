/**
 * Comment filtering for question prompts (Issue #664, #914, #190).
 *
 * Filters and trims issue comments for follow-up question prompts to avoid
 * context bloat from prior bot answers. User comments are preserved in full,
 * bot answers are truncated, and worker operational comments are removed.
 *
 * Per-comment trust classification, suspicious-pattern detection and delimiter
 * sanitisation are delegated to `comment_trust_filter.ts` rather than
 * duplicated here, so this path and the trust-configured path share one set of
 * security controls (Issue #190).
 *
 * Migrated from worker/shared/comment_filter.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { capFormattedComments } from "./comment_rate_limiter.ts";
import { annotateCommentsWithTrust } from "./comment_trust_filter.ts";

/**
 * Comment from issue JSON data.
 */
export interface IssueComment {
  body: string;
  author: {
    login: string;
  };
}

/**
 * Issue data containing comments array.
 */
export interface IssueData {
  comments?: IssueComment[];
}

/**
 * Formatted comments plus the security audit events raised while building them.
 */
export interface QuestionCommentsResult {
  /** Formatted comment string, ready for prompt inclusion. */
  formattedComments: string;
  /** `[SECURITY]` audit messages for logging (one per suspicious comment). */
  securityAuditMessages: string[];
}

/**
 * Prepare question comments, returning the security audit events too.
 *
 * Processes issue comments to reduce context bloat in follow-up questions:
 * 1. Filters out worker operational comments entirely
 * 2. Classifies each author and runs suspicious-pattern detection (Issue #190)
 * 3. Truncates prior bot answers to first N characters
 * 4. Preserves all user comments in full
 * 5. Caps the assembled blob at a total character budget (Issue #3648)
 *
 * Step 2 is delegated to `annotateCommentsWithTrust` with *empty* trust lists,
 * because this path runs precisely when no trust configuration exists: no
 * author can be established as trusted, so every author classifies UNTRUSTED
 * and every body is scanned. Previously this path formatted comments as
 * `[login]: body` with no classification and no detection at all, so an
 * operator watching the audit log (SECURITY.md §8) was blind to attack
 * attempts routed through it (Issue #190).
 *
 * Step 5 matters because only *bot* answers are truncated: user comments are
 * concatenated in full and `comment_rate_limiter`'s per-author caps never fire
 * without trust configuration. Audit events are collected before the cap so a
 * security signal is never dropped with the text it came from.
 *
 * @param jsonData - Raw JSON string from fetch_issue_data (contains .comments array)
 * @param truncateLength - Maximum characters to keep from bot answers (default: 500)
 * @param maxTotalChars - Total character budget (defaults to the shared 20,000 cap)
 * @returns Formatted comments and their security audit messages
 */
export function prepareQuestionCommentsWithAudit(
  jsonData: string,
  truncateLength?: number,
  maxTotalChars?: number,
): QuestionCommentsResult {
  const emptyResult: QuestionCommentsResult = {
    formattedComments: "",
    securityAuditMessages: [],
  };

  if (!jsonData || jsonData === "{}") {
    return emptyResult;
  }

  let data: IssueData;
  try {
    data = JSON.parse(jsonData) as IssueData;
  } catch {
    return emptyResult;
  }

  const comments = data.comments ?? [];
  if (comments.length === 0) {
    return emptyResult;
  }

  const annotated = annotateCommentsWithTrust(comments, {
    allowedAuthors: [],
    authorisedCommenters: [],
    includeUntrustedComments: true,
    truncateLength,
  });
  if (annotated.length === 0) {
    return emptyResult;
  }

  const securityAuditMessages = annotated
    .filter((c) => c.securityAuditMessage !== undefined)
    .map((c) => c.securityAuditMessage!);

  const formattedComments = capFormattedComments(
    annotated.map((c) => c.annotatedBody).join("\n\n---\n\n"),
    maxTotalChars,
  );

  return { formattedComments, securityAuditMessages };
}

/**
 * Prepare question comments by filtering and truncating.
 *
 * Thin wrapper over {@link prepareQuestionCommentsWithAudit} for callers that
 * only need the formatted blob. Callers that can log should prefer the audit
 * variant so suspicious-comment events reach the security audit log.
 *
 * @param jsonData - Raw JSON string from fetch_issue_data (contains .comments array)
 * @param truncateLength - Maximum characters to keep from bot answers (default: 500)
 * @param maxTotalChars - Total character budget (defaults to the shared 20,000 cap)
 * @returns Formatted comment string with filtered/truncated comments
 */
export function prepareQuestionComments(
  jsonData: string,
  truncateLength?: number,
  maxTotalChars?: number,
): string {
  return prepareQuestionCommentsWithAudit(
    jsonData,
    truncateLength,
    maxTotalChars,
  ).formattedComments;
}
