/**
 * Trust-aware comment filtering for issue prompts (Issue #1340).
 *
 * Classifies comment authors as trusted or untrusted based on the
 * `allowedAuthors` and `authorisedCommenters` configuration lists.
 * Annotates comments with trust-level markers in the prompt context
 * and runs suspicious pattern detection on untrusted comments.
 *
 * This is the highest-priority defence — comments are the most
 * accessible attack vector on public repositories.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { SHELL_OPERATIONAL_DEFAULTS } from "./operational_defaults.ts";
import { detectSuspiciousPatterns } from "./security.ts";
import { normaliseLogin } from "./identity_guard.ts";
import type { IssueComment, IssueData } from "./comment_filter.ts";
import {
  applyCommentRateLimits,
  COMMENT_RATE_LIMIT_DEFAULTS,
  detectCommentFlood,
} from "./comment_rate_limiter.ts";
import {
  formatDelimitedComment,
  generateBoundaryId,
  sanitiseDelimiterPatterns,
} from "./prompt_delimiter.ts";

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

/** Trust level classification for a comment author. */
export type TrustLevel = "TRUSTED" | "UNTRUSTED";

/**
 * Configuration options for trust-aware comment filtering.
 */
export interface CommentTrustOptions {
  /** List of allowed issue authors (primary trusted users). */
  allowedAuthors: string[];
  /** List of authorised commenters (secondary trusted users). */
  authorisedCommenters: string[];
  /**
   * Whether to include untrusted comments in the prompt context.
   * - `true` (default): include with trust-level annotations (defence in depth)
   * - `false` (strict mode): exclude untrusted comments entirely
   */
  includeUntrustedComments?: boolean;
  /** Maximum characters to keep from bot answers before truncating. */
  truncateLength?: number;
}

/**
 * A comment annotated with trust-level information.
 */
export interface AnnotatedComment {
  /** The original comment. */
  original: IssueComment;
  /** Trust level of the comment author. */
  trustLevel: TrustLevel;
  /** The comment body with trust-level prefix annotation. */
  annotatedBody: string;
  /** Whether suspicious patterns were detected (untrusted comments only). */
  suspicious: boolean;
  /** Security audit message if suspicious patterns were detected. */
  securityAuditMessage?: string;
}

/**
 * Result of trust-annotated comment preparation.
 */
export interface TrustAnnotatedResult {
  /** Formatted comment string with trust annotations, ready for prompt inclusion. */
  formattedComments: string;
  /** Security audit messages for logging (one per suspicious comment). */
  securityAuditMessages: string[];
  /** The boundary ID used for per-comment delimiters (Issue #1343). */
  boundaryId: string;
}

/**
 * Classify a comment author as trusted or untrusted.
 *
 * An author is trusted if they appear in either the `allowedAuthors`
 * (may direct work) or `authorisedCommenters` (input we act on) sets.
 *
 * Case-insensitive, because GitHub logins are (Issue #1066): both sets are
 * now derived from repository collaborators and normalised to lower case,
 * while a comment author arrives in the account's own casing.
 *
 * @param authorLogin - The GitHub username of the comment author
 * @param options - Trust configuration containing author lists
 * @returns Trust level classification
 */
export function classifyCommentAuthor(
  authorLogin: string,
  options: Pick<CommentTrustOptions, "allowedAuthors" | "authorisedCommenters">,
): TrustLevel {
  const { allowedAuthors, authorisedCommenters } = options;
  const key = normaliseLogin(authorLogin);
  if (!key) return "UNTRUSTED";

  const listed = (logins: readonly string[]) =>
    logins.some((a) => typeof a === "string" && normaliseLogin(a) === key);

  return listed(allowedAuthors) || listed(authorisedCommenters)
    ? "TRUSTED"
    : "UNTRUSTED";
}

/**
 * Check if a comment is a worker operational comment that should be filtered out.
 */
function isOperationalComment(body: string): boolean {
  return OPERATIONAL_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * Annotate comments with trust-level information.
 *
 * Processes each comment to:
 * 1. Filter out worker operational comments
 * 2. Classify the author as trusted or untrusted
 * 3. Optionally exclude untrusted comments (strict mode)
 * 4. Run suspicious pattern detection on untrusted comments
 * 5. Add trust-level prefix annotations
 *
 * @param comments - Array of issue comments
 * @param options - Trust configuration
 * @returns Array of annotated comments (operational comments excluded)
 */
export function annotateCommentsWithTrust(
  comments: IssueComment[],
  options: CommentTrustOptions,
): AnnotatedComment[] {
  const includeUntrusted = options.includeUntrustedComments ?? true;
  const maxLen = options.truncateLength ?? DEFAULT_TRUNCATE_LENGTH;
  const result: AnnotatedComment[] = [];

  for (const comment of comments) {
    // Filter out operational comments entirely
    if (isOperationalComment(comment.body)) {
      continue;
    }

    const trustLevel = classifyCommentAuthor(comment.author.login, options);

    // In strict mode, exclude untrusted comments entirely
    if (trustLevel === "UNTRUSTED" && !includeUntrusted) {
      continue;
    }

    // Run suspicious pattern detection on untrusted comments only
    let suspicious = false;
    let securityAuditMessage: string | undefined;

    if (trustLevel === "UNTRUSTED") {
      const suspiciousResult = detectSuspiciousPatterns(
        comment.body,
        `comment from ${comment.author.login}`,
      );
      suspicious = suspiciousResult.detected;
      if (suspicious) {
        securityAuditMessage =
          `[SECURITY] Suspicious patterns detected in untrusted comment from ` +
          `${comment.author.login}: ${suspiciousResult.context}`;
      }
    }

    // Build annotated body with trust prefix
    let body = comment.body;

    // Truncate bot answers that are too long (same behaviour as original filter)
    if (BOT_ANSWER_PATTERN.test(body) && body.length > maxLen) {
      const truncated = body.substring(0, maxLen);
      const omitted = body.length - maxLen;
      body =
        `${truncated}\n\n[Previous answer truncated — ${omitted} characters omitted]`;
    }

    // Sanitise delimiter-like patterns in comment bodies (Issue #1343)
    body = sanitiseDelimiterPatterns(body);

    const annotatedBody = `[${trustLevel} - ${comment.author.login}]: ${body}`;

    result.push({
      original: comment,
      trustLevel,
      annotatedBody,
      suspicious,
      securityAuditMessage,
    });
  }

  return result;
}

/**
 * Prepare trust-annotated comments from raw JSON issue data.
 *
 * This is the main entry point for trust-aware comment filtering.
 * It replaces `prepareQuestionComments` when trust context is available.
 *
 * @param jsonData - Raw JSON string from fetch_issue_data (contains .comments array)
 * @param options - Trust configuration
 * @returns Formatted comments and security audit messages
 */
export function prepareTrustAnnotatedComments(
  jsonData: string,
  options: CommentTrustOptions,
): TrustAnnotatedResult {
  // Generate a per-invocation boundary ID for comment delimiters (Issue #1343)
  const boundaryId = generateBoundaryId();

  const emptyResult: TrustAnnotatedResult = {
    formattedComments: "",
    securityAuditMessages: [],
    boundaryId,
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

  return prepareTrustAnnotatedCommentList(
    data.comments ?? [],
    options,
    boundaryId,
  );
}

/**
 * Prepare trust-annotated comments from an already-parsed comment list.
 *
 * The structural core of {@link prepareTrustAnnotatedComments}: trust
 * annotation, the Issue #1342 volume caps, and per-comment nonce headers.
 * Callers that already hold typed comments (the grill-me processor fetches
 * `GitHubComment[]` straight from the API — Issue #3706) use this rather than
 * re-serialising to JSON, so no prompt path has an excuse to hand-roll its own
 * unannotated comment formatter.
 *
 * @param comments - Comments in chronological order
 * @param options - Trust configuration
 * @param boundaryId - Per-invocation nonce for the per-comment headers
 * @returns Formatted comments and security audit messages
 */
export function prepareTrustAnnotatedCommentList(
  comments: IssueComment[],
  options: CommentTrustOptions,
  boundaryId: string = generateBoundaryId(),
): TrustAnnotatedResult {
  const emptyResult: TrustAnnotatedResult = {
    formattedComments: "",
    securityAuditMessages: [],
    boundaryId,
  };

  if (comments.length === 0) {
    return emptyResult;
  }

  const annotated = annotateCommentsWithTrust(comments, options);
  if (annotated.length === 0) {
    return emptyResult;
  }

  // Detect comment flooding from untrusted authors before any caps are
  // applied, so a flood is reported even when the surplus is later dropped
  // (Issue #1342 / #2873).
  const flood = detectCommentFlood(
    annotated,
    COMMENT_RATE_LIMIT_DEFAULTS.commentFloodThreshold,
  );

  // Suspicious-pattern audit events are collected from the full annotated set
  // (before rate limiting) so a security signal is never silently dropped.
  const securityAuditMessages = annotated
    .filter((c) => c.securityAuditMessage !== undefined)
    .map((c) => c.securityAuditMessage!);
  if (flood.detected && flood.auditMessage) {
    securityAuditMessages.push(flood.auditMessage);
  }

  // Enforce the Issue #1342 volume caps: per-untrusted-comment size cap,
  // untrusted comment count cap, and total character budget. Without this the
  // caps were dead code (Issue #2873).
  const { comments: limited, omittedSummary } = applyCommentRateLimits(
    annotated,
    {
      maxTotalCommentChars: COMMENT_RATE_LIMIT_DEFAULTS.maxTotalCommentChars,
      maxUntrustedCommentChars:
        COMMENT_RATE_LIMIT_DEFAULTS.maxUntrustedCommentChars,
      maxUntrustedCommentCount:
        COMMENT_RATE_LIMIT_DEFAULTS.maxUntrustedCommentCount,
    },
  );

  if (limited.length === 0) {
    return { formattedComments: "", securityAuditMessages, boundaryId };
  }

  // Format each (rate-limited) comment with individual per-comment delimiters
  // (Issue #1343). Render from original.body, which the rate limiter has
  // truncated in lockstep where caps applied (Issue #2873).
  const parts = limited.map((c) =>
    formatDelimitedComment(
      c.original.body,
      c.original.author.login,
      c.trustLevel,
      boundaryId,
    )
  );
  if (omittedSummary) {
    parts.push(omittedSummary);
  }
  const formattedComments = parts.join("\n\n");

  return { formattedComments, securityAuditMessages, boundaryId };
}
