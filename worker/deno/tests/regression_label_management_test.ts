/**
 * Regression test suite — label management parity validation (Issue #1235).
 *
 * Validates that the Deno label management produces identical behaviour to the
 * original shell implementation, focusing on clarification validation, planning
 * escalation detection, question failure categorisation, and edge cases.
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildQuestionFailureComment,
  countClarificationRounds,
  detectPlanningEscalationInComments,
  getQuestionFailureReason,
  labelCacheFilePath,
  PLANNING_ESCALATION_HEADINGS,
  validateClarifyingQuestions,
} from "../lib/label_manager.ts";

// ============================================================================
// countClarificationRounds — edge cases
// ============================================================================

Deno.test("regression label_manager - countClarificationRounds with no headings", () => {
  assertEquals(countClarificationRounds("Some comment text"), 0);
});

Deno.test("regression label_manager - countClarificationRounds with empty string", () => {
  assertEquals(countClarificationRounds(""), 0);
});

Deno.test("regression label_manager - countClarificationRounds counts multiple rounds", () => {
  const comments = [
    "## Clarification Needed\nFirst question",
    "Answer to first",
    "## Clarification Needed\nSecond question",
  ].join("\n---\n");
  assertEquals(countClarificationRounds(comments), 2);
});

Deno.test("regression label_manager - countClarificationRounds with single round", () => {
  assertEquals(
    countClarificationRounds("## Clarification Needed\nWhat is X?"),
    1,
  );
});

Deno.test("regression label_manager - countClarificationRounds is case-sensitive", () => {
  // The heading must match exactly "## Clarification Needed"
  assertEquals(countClarificationRounds("## clarification needed"), 0);
  assertEquals(countClarificationRounds("## CLARIFICATION NEEDED"), 0);
});

// ============================================================================
// validateClarifyingQuestions — edge cases
// ============================================================================

Deno.test("regression label_manager - validateClarifyingQuestions with valid question", () => {
  const result = validateClarifyingQuestions("What is the expected behaviour?");
  assert(result.ok, "Valid question should pass");
});

Deno.test("regression label_manager - validateClarifyingQuestions with empty string", () => {
  const result = validateClarifyingQuestions("");
  assert(!result.ok, "Empty string should fail");
});

Deno.test("regression label_manager - validateClarifyingQuestions with whitespace only", () => {
  const result = validateClarifyingQuestions("   \n\t  ");
  assert(!result.ok, "Whitespace-only should fail");
});

Deno.test("regression label_manager - validateClarifyingQuestions without question mark", () => {
  const result = validateClarifyingQuestions(
    "Please clarify the requirements.",
  );
  assert(!result.ok, "No question mark should fail");
});

Deno.test("regression label_manager - validateClarifyingQuestions with multiple questions", () => {
  const result = validateClarifyingQuestions(
    "What is X? How should Y work? When is Z needed?",
  );
  assert(result.ok, "Multiple questions should pass");
});

Deno.test("regression label_manager - validateClarifyingQuestions with special characters", () => {
  const result = validateClarifyingQuestions(
    "Is the `<div>` tag & 'quotes' needed?",
  );
  assert(result.ok, "Questions with special characters should pass");
});

// ============================================================================
// getQuestionFailureReason — category mapping
// ============================================================================

Deno.test("regression label_manager - getQuestionFailureReason maps timeout", () => {
  const reason = getQuestionFailureReason("timeout");
  assert(reason.length > 0, "Should return a non-empty reason");
  assert(
    reason.toLowerCase().includes("timeout") ||
      reason.toLowerCase().includes("time"),
    "Should mention timeout",
  );
});

Deno.test("regression label_manager - getQuestionFailureReason maps rate_limit", () => {
  const reason = getQuestionFailureReason("rate_limit");
  assert(reason.length > 0, "Should return a non-empty reason for rate_limit");
});

Deno.test("regression label_manager - getQuestionFailureReason maps zero_output", () => {
  const reason = getQuestionFailureReason("zero_output");
  assert(reason.length > 0, "Should return a non-empty reason for zero_output");
});

Deno.test("regression label_manager - getQuestionFailureReason maps internal_error", () => {
  const reason = getQuestionFailureReason("internal_error");
  assert(
    reason.length > 0,
    "Should return a non-empty reason for internal_error",
  );
});

// ============================================================================
// buildQuestionFailureComment — format validation
// ============================================================================

Deno.test("regression label_manager - buildQuestionFailureComment includes failure details", () => {
  const comment = buildQuestionFailureComment(
    "Process timed out after 600s",
    false,
  );
  assert(comment.includes("timed out"), "Should include failure message");
  assert(comment.includes("Failed"), "Should include failure heading");
});

Deno.test("regression label_manager - buildQuestionFailureComment second failure variant", () => {
  const comment = buildQuestionFailureComment(
    "Process timed out after 600s",
    true,
  );
  assert(comment.includes("Second Attempt"), "Should indicate second failure");
});

Deno.test("regression label_manager - buildQuestionFailureComment with empty message", () => {
  const comment = buildQuestionFailureComment("", false);
  assert(comment.length > 0, "Should generate comment even with empty message");
});

// ============================================================================
// detectPlanningEscalationInComments — edge cases
// ============================================================================

Deno.test("regression label_manager - detectPlanningEscalationInComments with no escalation", () => {
  assertEquals(
    detectPlanningEscalationInComments("Just a normal comment"),
    false,
  );
});

Deno.test("regression label_manager - detectPlanningEscalationInComments with empty string", () => {
  assertEquals(detectPlanningEscalationInComments(""), false);
});

Deno.test("regression label_manager - detectPlanningEscalationInComments detects known headings", () => {
  for (const heading of PLANNING_ESCALATION_HEADINGS) {
    assertEquals(
      detectPlanningEscalationInComments(`Some text\n${heading}\nMore text`),
      true,
      `Should detect heading: ${heading}`,
    );
  }
});

Deno.test("regression label_manager - PLANNING_ESCALATION_HEADINGS is non-empty", () => {
  assert(
    PLANNING_ESCALATION_HEADINGS.length > 0,
    "Should have at least one escalation heading",
  );
});

// ============================================================================
// labelCacheFilePath — format validation
// ============================================================================

Deno.test("regression label_manager - labelCacheFilePath produces consistent paths", () => {
  const path = labelCacheFilePath("/tmp/cache", "org/repo");
  assert(
    path.startsWith("/tmp/cache"),
    "Should use the provided cache directory",
  );
  assert(path.includes("org"), "Should include org in path");
  assert(path.includes("repo"), "Should include repo in path");
});

Deno.test("regression label_manager - labelCacheFilePath handles different repos", () => {
  const path1 = labelCacheFilePath("/tmp/cache", "org1/repo1");
  const path2 = labelCacheFilePath("/tmp/cache", "org2/repo2");
  assert(path1 !== path2, "Different repos should produce different paths");
});
