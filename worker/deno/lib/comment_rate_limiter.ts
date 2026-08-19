/**
 * Rate limiting and size caps for issue comments (Issue #1342).
 *
 * Provides configurable limits on comment volume to defend against
 * context flooding attacks on public repositories:
 * - Total comment character budget
 * - Per-comment character limits for untrusted authors
 * - Untrusted comment count cap
 * - Comment flood detection with security audit events
 *
 * Builds on the trust-level classification from Issue #1340.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { AnnotatedComment } from "./comment_trust_filter.ts";

/**
 * Default values for comment rate limiting.
 *
 * Registered in config_defaults.ts as the single source of truth.
 */
export const COMMENT_RATE_LIMIT_DEFAULTS = {
  /** Maximum total characters across all comments included in the prompt. */
  maxTotalCommentChars: 20_000,
  /** Maximum characters per untrusted comment before truncation. */
  maxUntrustedCommentChars: 2_000,
  /** Maximum number of untrusted comments to include. */
  maxUntrustedCommentCount: 5,
  /** Threshold of untrusted comments that triggers a flood audit event. */
  commentFloodThreshold: 10,
} as const;

/**
 * Configuration options for comment rate limiting.
 */
export interface CommentRateLimitOptions {
  /** Maximum total characters across all comments included in the prompt. */
  maxTotalCommentChars: number;
  /** Maximum characters per untrusted comment before truncation. */
  maxUntrustedCommentChars: number;
  /** Maximum number of untrusted comments to include. */
  maxUntrustedCommentCount: number;
}

/**
 * Result of applying comment rate limits.
 */
export interface CommentRateLimitResult {
  /** Comments after rate limiting has been applied. */
  comments: AnnotatedComment[];
  /** Summary of omitted untrusted comments, if any were dropped. */
  omittedSummary?: string;
}

/**
 * Result of comment flood detection.
 */
export interface CommentFloodResult {
  /** Whether a comment flood was detected. */
  detected: boolean;
  /** Security audit message if a flood was detected. */
  auditMessage?: string;
}

/**
 * Cap an already-formatted comment blob at a total character budget
 * (Issue #3648).
 *
 * {@link applyCommentRateLimits} only runs on the trust-annotated path, which
 * is entered when `allowedAuthors`/`authorisedCommenters` are configured. With
 * no trust configuration the plain formatters concatenated every comment
 * verbatim, so an attacker on a public repository could add N large comments
 * and push all of them straight into the prompt. This is the unconditional
 * backstop applied by those formatters.
 *
 * The truncation is announced rather than silent — a clipped blob must never
 * read as the complete comment history.
 *
 * @param formatted - The formatted comment blob
 * @param maxTotalChars - Character budget (defaults to the shared 20,000 cap)
 * @returns The blob unchanged, or truncated with an explicit omission notice
 */
export function capFormattedComments(
  formatted: string,
  maxTotalChars: number = COMMENT_RATE_LIMIT_DEFAULTS.maxTotalCommentChars,
): string {
  if (formatted.length <= maxTotalChars) {
    return formatted;
  }
  const omitted = formatted.length - maxTotalChars;
  return `${formatted.slice(0, maxTotalChars)}\n\n` +
    `[Comment context truncated — ${omitted} characters omitted ` +
    `(total cap: ${maxTotalChars} characters).]`;
}

/**
 * Apply rate limits to annotated comments.
 *
 * Processing order:
 * 1. Truncate individual untrusted comments that exceed the per-comment limit
 * 2. Cap the number of untrusted comments (keeping the earliest ones)
 * 3. Enforce the total character budget (truncating oldest comments first)
 *
 * @param comments - Annotated comments from trust-aware filtering
 * @param options - Rate limiting configuration
 * @returns Rate-limited comments with optional omission summary
 */
export function applyCommentRateLimits(
  comments: AnnotatedComment[],
  options: CommentRateLimitOptions,
): CommentRateLimitResult {
  if (comments.length === 0) {
    return { comments: [] };
  }

  // Step 1: Truncate individual untrusted comments that exceed per-comment limit
  let processed = comments.map((comment) => {
    if (comment.trustLevel !== "UNTRUSTED") {
      return comment;
    }

    const body = comment.original.body;
    if (body.length <= options.maxUntrustedCommentChars) {
      return comment;
    }

    const truncatedBody = body.substring(0, options.maxUntrustedCommentChars);
    const omitted = body.length - options.maxUntrustedCommentChars;
    const newBody =
      `${truncatedBody}\n\n[Comment truncated — untrusted author, ${omitted} characters omitted]`;
    const annotatedBody =
      `[${comment.trustLevel} - ${comment.original.author.login}]: ${newBody}`;

    // Keep original.body in lockstep with annotatedBody so the live
    // delimiter-formatting path (which renders from original.body) reflects
    // the truncation (Issue #2873).
    return {
      ...comment,
      annotatedBody,
      original: { ...comment.original, body: newBody },
    };
  });

  // Step 2: Cap untrusted comment count
  let omittedSummary: string | undefined;
  let untrustedCount = 0;
  let droppedCount = 0;
  const afterCountCap: AnnotatedComment[] = [];

  for (const comment of processed) {
    if (comment.trustLevel === "UNTRUSTED") {
      untrustedCount++;
      if (untrustedCount > options.maxUntrustedCommentCount) {
        droppedCount++;
        continue;
      }
    }
    afterCountCap.push(comment);
  }

  if (droppedCount > 0) {
    omittedSummary = `[${droppedCount} additional untrusted comments omitted]`;
  }

  processed = afterCountCap;

  // Step 3: Enforce total character budget (truncate oldest comments first)
  const totalChars = processed.reduce(
    (sum, c) => sum + c.annotatedBody.length,
    0,
  );

  if (totalChars > options.maxTotalCommentChars) {
    // Work backwards from newest to oldest, accumulating budget
    let remaining = options.maxTotalCommentChars;
    const kept: { index: number; comment: AnnotatedComment }[] = [];

    // Reserve space for newest comments first
    for (let i = processed.length - 1; i >= 0; i--) {
      const comment = processed[i]!;
      const len = comment.annotatedBody.length;

      if (remaining >= len) {
        remaining -= len;
        kept.unshift({ index: i, comment });
      } else if (remaining > 0) {
        // Partially truncate this comment to fit the remaining budget.
        // Truncate original.body in lockstep (the live formatter renders from
        // it), accounting for the trust-prefix overhead in annotatedBody
        // (Issue #2873).
        const truncatedAnnotated = comment.annotatedBody.substring(
          0,
          remaining,
        );
        const prefixLen = comment.annotatedBody.length -
          comment.original.body.length;
        const bodyKeep = Math.max(0, remaining - prefixLen);
        kept.unshift({
          index: i,
          comment: {
            ...comment,
            annotatedBody: truncatedAnnotated,
            original: {
              ...comment.original,
              body: comment.original.body.substring(0, bodyKeep),
            },
          },
        });
        remaining = 0;
      }
      // else: comment is dropped entirely (oldest comments dropped first)
    }

    processed = kept.map((k) => k.comment);
  }

  return { comments: processed, omittedSummary };
}

/**
 * Detect comment flooding from untrusted authors.
 *
 * Emits a security audit event when the number of untrusted comments
 * exceeds the configured threshold, indicating a potential flooding attack.
 *
 * @param comments - All annotated comments (before rate limiting)
 * @param threshold - Number of untrusted comments that triggers the alert
 * @returns Flood detection result with optional audit message
 */
export function detectCommentFlood(
  comments: AnnotatedComment[],
  threshold: number,
): CommentFloodResult {
  const untrustedCount = comments.filter(
    (c) => c.trustLevel === "UNTRUSTED",
  ).length;

  if (untrustedCount > threshold) {
    return {
      detected: true,
      auditMessage:
        `[SECURITY] [COMMENT_FLOOD] Issue has ${untrustedCount} untrusted comments ` +
        `(threshold: ${threshold}). Possible comment flooding attack.`,
    };
  }

  return { detected: false };
}

/**
 * Matches the trust-level prefix added by the trust filter (Issue #1340):
 * `[TRUSTED - login]: ` or `[UNTRUSTED - login]: ` at the start of the body.
 */
const TRUST_PREFIX_PATTERN = /^\[(?:TRUSTED|UNTRUSTED) - [^\]]+\]: /;

/**
 * Extract the effective comment body from an annotated comment (Issue #2873).
 *
 * Strips the leading trust-level prefix (`[UNTRUSTED - login]: `) so callers
 * see the author's actual text, while preserving any truncation marker added
 * by the rate limiter. A body without the prefix is returned unchanged.
 *
 * @param comment - The annotated comment (post rate limiting)
 * @returns The body with the trust prefix removed
 */
export function effectiveCommentBody(comment: AnnotatedComment): string {
  return comment.annotatedBody.replace(TRUST_PREFIX_PATTERN, "");
}
