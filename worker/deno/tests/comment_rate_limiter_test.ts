/**
 * Tests for comment rate limiting and size caps (Issue #1342).
 *
 * Validates that untrusted comments are rate-limited by:
 * - Total comment character budget enforcement
 * - Per-comment character limits for untrusted authors
 * - Untrusted comment count caps
 * - Comment flood detection with security audit events
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyCommentRateLimits,
  COMMENT_RATE_LIMIT_DEFAULTS,
  type CommentRateLimitOptions,
  detectCommentFlood,
  effectiveCommentBody,
} from "../lib/comment_rate_limiter.ts";
import type { AnnotatedComment } from "../lib/comment_trust_filter.ts";
import type { IssueComment } from "../lib/comment_filter.ts";

/** Helper to build an annotated comment for testing. */
function makeAnnotated(
  login: string,
  body: string,
  trustLevel: "TRUSTED" | "UNTRUSTED",
): AnnotatedComment {
  return {
    original: { body, author: { login } } as IssueComment,
    trustLevel,
    annotatedBody: `[${trustLevel} - ${login}]: ${body}`,
    suspicious: false,
  };
}

// --- Default configuration values ---

Deno.test("rate limiter - defaults are sensible", () => {
  assertEquals(COMMENT_RATE_LIMIT_DEFAULTS.maxTotalCommentChars, 20_000);
  assertEquals(COMMENT_RATE_LIMIT_DEFAULTS.maxUntrustedCommentChars, 2_000);
  assertEquals(COMMENT_RATE_LIMIT_DEFAULTS.maxUntrustedCommentCount, 5);
  assertEquals(COMMENT_RATE_LIMIT_DEFAULTS.commentFloodThreshold, 10);
});

// --- Per-comment truncation for untrusted authors ---

Deno.test("rate limiter - truncates long untrusted comments", () => {
  const longBody = "X".repeat(3_000);
  const comments = [makeAnnotated("stranger", longBody, "UNTRUSTED")];
  const options: CommentRateLimitOptions = {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 50_000,
    maxUntrustedCommentCount: 10,
  };

  const result = applyCommentRateLimits(comments, options);
  assertEquals(result.comments.length, 1);
  assertStringIncludes(
    result.comments[0]!.annotatedBody,
    "[Comment truncated — untrusted author, 1000 characters omitted]",
  );
});

Deno.test("rate limiter - does not truncate short untrusted comments", () => {
  const shortBody = "Short comment.";
  const comments = [makeAnnotated("stranger", shortBody, "UNTRUSTED")];
  const options: CommentRateLimitOptions = {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 50_000,
    maxUntrustedCommentCount: 10,
  };

  const result = applyCommentRateLimits(comments, options);
  assertEquals(result.comments.length, 1);
  assertEquals(
    result.comments[0]!.annotatedBody.includes("truncated"),
    false,
  );
});

Deno.test("rate limiter - does not truncate trusted comments at untrusted limit", () => {
  const longBody = "Y".repeat(5_000);
  const comments = [makeAnnotated("owner", longBody, "TRUSTED")];
  const options: CommentRateLimitOptions = {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 50_000,
    maxUntrustedCommentCount: 10,
  };

  const result = applyCommentRateLimits(comments, options);
  assertEquals(result.comments.length, 1);
  assertEquals(
    result.comments[0]!.annotatedBody.includes("untrusted author"),
    false,
  );
});

// --- Untrusted comment count cap ---

Deno.test("rate limiter - caps untrusted comment count", () => {
  const comments: AnnotatedComment[] = [];
  for (let i = 0; i < 8; i++) {
    comments.push(makeAnnotated(`user${i}`, `Comment ${i}`, "UNTRUSTED"));
  }
  const options: CommentRateLimitOptions = {
    maxUntrustedCommentChars: 10_000,
    maxTotalCommentChars: 100_000,
    maxUntrustedCommentCount: 5,
  };

  const result = applyCommentRateLimits(comments, options);
  // Should include only 5 untrusted comments plus a summary
  const untrustedIncluded = result.comments.filter(
    (c) => c.trustLevel === "UNTRUSTED",
  );
  assertEquals(untrustedIncluded.length, 5);
  assertStringIncludes(
    result.omittedSummary!,
    "3 additional untrusted comments omitted",
  );
});

Deno.test("rate limiter - does not cap trusted comment count", () => {
  const comments: AnnotatedComment[] = [];
  for (let i = 0; i < 10; i++) {
    comments.push(makeAnnotated(`owner${i}`, `Comment ${i}`, "TRUSTED"));
  }
  const options: CommentRateLimitOptions = {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 100_000,
    maxUntrustedCommentCount: 5,
  };

  const result = applyCommentRateLimits(comments, options);
  assertEquals(result.comments.length, 10);
  assertEquals(result.omittedSummary, undefined);
});

Deno.test("rate limiter - mixed trusted and untrusted respects cap on untrusted only", () => {
  const comments: AnnotatedComment[] = [
    makeAnnotated("owner", "Trusted 1", "TRUSTED"),
    makeAnnotated("user1", "Untrusted 1", "UNTRUSTED"),
    makeAnnotated("user2", "Untrusted 2", "UNTRUSTED"),
    makeAnnotated("user3", "Untrusted 3", "UNTRUSTED"),
    makeAnnotated("owner", "Trusted 2", "TRUSTED"),
    makeAnnotated("user4", "Untrusted 4", "UNTRUSTED"),
    makeAnnotated("user5", "Untrusted 5", "UNTRUSTED"),
    makeAnnotated("user6", "Untrusted 6", "UNTRUSTED"),
  ];
  const options: CommentRateLimitOptions = {
    maxUntrustedCommentChars: 10_000,
    maxTotalCommentChars: 100_000,
    maxUntrustedCommentCount: 3,
  };

  const result = applyCommentRateLimits(comments, options);
  const trusted = result.comments.filter((c) => c.trustLevel === "TRUSTED");
  const untrusted = result.comments.filter((c) => c.trustLevel === "UNTRUSTED");
  assertEquals(trusted.length, 2);
  assertEquals(untrusted.length, 3);
  assertStringIncludes(
    result.omittedSummary!,
    "3 additional untrusted comments omitted",
  );
});

// --- Total comment budget enforcement ---

Deno.test("rate limiter - enforces total comment character budget", () => {
  const comments: AnnotatedComment[] = [
    makeAnnotated("owner", "A".repeat(5_000), "TRUSTED"),
    makeAnnotated("owner", "B".repeat(5_000), "TRUSTED"),
    makeAnnotated("owner", "C".repeat(5_000), "TRUSTED"),
  ];
  const options: CommentRateLimitOptions = {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 12_000,
    maxUntrustedCommentCount: 10,
  };

  const result = applyCommentRateLimits(comments, options);
  // Total budget is 12,000. First two comments use ~10,000 chars of annotated body.
  // The budget should trim the oldest comments first (from the beginning).
  // Let's verify the total character count is within budget.
  const totalChars = result.comments.reduce(
    (sum, c) => sum + c.annotatedBody.length,
    0,
  );
  assertEquals(totalChars <= 12_000, true);
});

Deno.test("rate limiter - oldest comments truncated first in budget enforcement", () => {
  const comments: AnnotatedComment[] = [
    makeAnnotated("owner", "A".repeat(8_000), "TRUSTED"),
    makeAnnotated("owner", "B".repeat(3_000), "TRUSTED"),
  ];
  const options: CommentRateLimitOptions = {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 5_000,
    maxUntrustedCommentCount: 10,
  };

  const result = applyCommentRateLimits(comments, options);
  // The second comment (newer) should be preserved; the first (oldest) truncated
  // Verify the newest comment is intact
  const lastComment = result.comments[result.comments.length - 1]!;
  assertStringIncludes(lastComment.annotatedBody, "B".repeat(3_000));
});

// --- Comment flood detection ---

Deno.test("rate limiter - detects comment flood from untrusted authors", () => {
  const comments: AnnotatedComment[] = [];
  for (let i = 0; i < 12; i++) {
    comments.push(makeAnnotated(`user${i}`, `Comment ${i}`, "UNTRUSTED"));
  }

  const result = detectCommentFlood(comments, 10);
  assertEquals(result.detected, true);
  assertStringIncludes(result.auditMessage!, "[SECURITY]");
  assertStringIncludes(result.auditMessage!, "[COMMENT_FLOOD]");
  assertStringIncludes(result.auditMessage!, "12");
});

Deno.test("rate limiter - no flood when untrusted count is at threshold", () => {
  const comments: AnnotatedComment[] = [];
  for (let i = 0; i < 10; i++) {
    comments.push(makeAnnotated(`user${i}`, `Comment ${i}`, "UNTRUSTED"));
  }

  const result = detectCommentFlood(comments, 10);
  assertEquals(result.detected, false);
  assertEquals(result.auditMessage, undefined);
});

Deno.test("rate limiter - no flood for trusted comments regardless of count", () => {
  const comments: AnnotatedComment[] = [];
  for (let i = 0; i < 20; i++) {
    comments.push(makeAnnotated(`owner`, `Comment ${i}`, "TRUSTED"));
  }

  const result = detectCommentFlood(comments, 10);
  assertEquals(result.detected, false);
});

Deno.test("rate limiter - flood detection counts only untrusted comments", () => {
  const comments: AnnotatedComment[] = [];
  // 8 untrusted + 20 trusted = should not trigger flood (threshold 10)
  for (let i = 0; i < 8; i++) {
    comments.push(makeAnnotated(`user${i}`, `Comment ${i}`, "UNTRUSTED"));
  }
  for (let i = 0; i < 20; i++) {
    comments.push(makeAnnotated("owner", `Trusted ${i}`, "TRUSTED"));
  }

  const result = detectCommentFlood(comments, 10);
  assertEquals(result.detected, false);
});

// --- Edge cases ---

Deno.test("rate limiter - handles empty comment list", () => {
  const result = applyCommentRateLimits([], {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 20_000,
    maxUntrustedCommentCount: 5,
  });
  assertEquals(result.comments.length, 0);
  assertEquals(result.omittedSummary, undefined);
});

Deno.test("rate limiter - handles single comment within all limits", () => {
  const comments = [makeAnnotated("owner", "Hello.", "TRUSTED")];
  const result = applyCommentRateLimits(comments, {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 20_000,
    maxUntrustedCommentCount: 5,
  });
  assertEquals(result.comments.length, 1);
  assertStringIncludes(result.comments[0]!.annotatedBody, "Hello.");
});

Deno.test("rate limiter - truncation marker shows correct omitted character count", () => {
  const body = "Z".repeat(5_000);
  const comments = [makeAnnotated("attacker", body, "UNTRUSTED")];
  const result = applyCommentRateLimits(comments, {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 50_000,
    maxUntrustedCommentCount: 10,
  });

  assertStringIncludes(
    result.comments[0]!.annotatedBody,
    "3000 characters omitted",
  );
});

// --- Effective body extraction (Issue #2873) ---

Deno.test("rate limiter - effectiveCommentBody strips the trust prefix", () => {
  const comment = makeAnnotated("stranger", "Hello there.", "UNTRUSTED");
  assertEquals(effectiveCommentBody(comment), "Hello there.");
});

Deno.test("rate limiter - effectiveCommentBody returns truncated body after rate limiting", () => {
  const longBody = "X".repeat(3_000);
  const comments = [makeAnnotated("stranger", longBody, "UNTRUSTED")];
  const result = applyCommentRateLimits(comments, {
    maxUntrustedCommentChars: 2_000,
    maxTotalCommentChars: 50_000,
    maxUntrustedCommentCount: 10,
  });
  const body = effectiveCommentBody(result.comments[0]!);
  // The prefix is gone but the truncation marker is preserved.
  assertEquals(body.startsWith("[UNTRUSTED"), false);
  assertStringIncludes(body, "[Comment truncated — untrusted author");
});

Deno.test("rate limiter - effectiveCommentBody returns body unchanged without prefix", () => {
  const comment = makeAnnotated("owner", "Plain body.", "TRUSTED");
  comment.annotatedBody = "Plain body, no prefix.";
  assertEquals(effectiveCommentBody(comment), "Plain body, no prefix.");
});

Deno.test("rate limiter - flood detection uses default threshold from defaults", () => {
  // Verify the flood detection works with the default threshold value
  const comments: AnnotatedComment[] = [];
  for (let i = 0; i < 11; i++) {
    comments.push(makeAnnotated(`user${i}`, `msg`, "UNTRUSTED"));
  }

  const result = detectCommentFlood(
    comments,
    COMMENT_RATE_LIMIT_DEFAULTS.commentFloodThreshold,
  );
  assertEquals(result.detected, true);
});
