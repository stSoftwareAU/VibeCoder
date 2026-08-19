/**
 * Comment filtering for question prompts (Issue #664, #914).
 *
 * Filters and trims issue comments for follow-up question prompts to avoid
 * context bloat from prior bot answers. User comments are preserved in full,
 * bot answers are truncated, and worker operational comments are removed.
 *
 * Migrated from worker/shared/comment_filter.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { SHELL_OPERATIONAL_DEFAULTS } from "./operational_defaults.ts";
import { capFormattedComments } from "./comment_rate_limiter.ts";

/** Default maximum characters to keep from a bot answer before truncating. */
const DEFAULT_TRUNCATE_LENGTH = parseInt(
  SHELL_OPERATIONAL_DEFAULTS.ANSWER_TRUNCATE_LENGTH,
  10,
);

/** Patterns that identify worker operational comments to filter out entirely. */
const OPERATIONAL_PATTERNS: readonly RegExp[] = [
  /<!-- CLAIM_LOCK:/,
  /^## Automated Processing Failed/,
  /^Automatic recovery:/,
];

/** Pattern that identifies bot answer comments (containing "## Answer"). */
const BOT_ANSWER_PATTERN = /## Answer/;

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
 * Check if a comment is a worker operational comment that should be filtered out.
 */
function isOperationalComment(body: string): boolean {
  return OPERATIONAL_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * Prepare question comments by filtering and truncating.
 *
 * Processes issue comments to reduce context bloat in follow-up questions:
 * 1. Filters out worker operational comments entirely
 * 2. Truncates prior bot answers to first N characters
 * 3. Preserves all user comments in full
 * 4. Caps the assembled blob at a total character budget (Issue #3648)
 *
 * Step 4 matters because only *bot* answers were truncated: user comments were
 * concatenated in full and this path runs precisely when no trust
 * configuration exists, so `comment_rate_limiter`'s per-author caps never fire.
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
  if (!jsonData || jsonData === "{}") {
    return "";
  }

  const maxLen = truncateLength ?? DEFAULT_TRUNCATE_LENGTH;

  let data: IssueData;
  try {
    data = JSON.parse(jsonData) as IssueData;
  } catch {
    return "";
  }

  const comments = data.comments ?? [];
  if (comments.length === 0) {
    return "";
  }

  // Filter out operational comments
  const filtered = comments.filter(
    (comment) => !isOperationalComment(comment.body),
  );

  // Process each remaining comment
  const processed = filtered.map((comment) => {
    const { body, author } = comment;

    // Truncate bot answers that are too long
    if (BOT_ANSWER_PATTERN.test(body) && body.length > maxLen) {
      const truncated = body.substring(0, maxLen);
      const omitted = body.length - maxLen;
      return `[${author.login}]: ${truncated}\n\n[Previous answer truncated — ${omitted} characters omitted]`;
    }

    return `[${author.login}]: ${body}`;
  });

  return capFormattedComments(processed.join("\n\n---\n\n"), maxTotalChars);
}
