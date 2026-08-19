/**
 * Regression test suite — PR body generation parity validation (Issue #1235).
 *
 * Validates that the Deno PR body utilities produce identical results to the
 * original shell implementations, focusing on closing keywords, milestone
 * sections, idempotency markers, and edge cases.
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIdempotencyMarker,
  buildMilestonePrSection,
  ensurePrReferencesIssue,
  extractIssueNumberFromPrTitle,
  hasClosingKeyword,
} from "../lib/pr_body.ts";

// ============================================================================
// hasClosingKeyword — edge cases
// ============================================================================

Deno.test("regression pr_body - hasClosingKeyword with empty body", () => {
  assertEquals(hasClosingKeyword("", 42), false);
});

Deno.test("regression pr_body - hasClosingKeyword detects all closing keywords", () => {
  assertEquals(hasClosingKeyword("Closes #42", 42), true);
  assertEquals(hasClosingKeyword("Fixes #42", 42), true);
  assertEquals(hasClosingKeyword("Resolves #42", 42), true);
});

Deno.test("regression pr_body - hasClosingKeyword is case-insensitive", () => {
  assertEquals(hasClosingKeyword("closes #42", 42), true);
  assertEquals(hasClosingKeyword("CLOSES #42", 42), true);
  assertEquals(hasClosingKeyword("fIxEs #42", 42), true);
});

Deno.test("regression pr_body - hasClosingKeyword does not match partial issue numbers", () => {
  // #421 should not match when looking for #42
  assertEquals(hasClosingKeyword("Closes #421", 42), false);
  // #142 should not match #42
  assertEquals(hasClosingKeyword("Closes #142", 42), false);
});

Deno.test("regression pr_body - hasClosingKeyword matches at end of line", () => {
  assertEquals(hasClosingKeyword("Closes #42\nSome other text", 42), true);
  assertEquals(hasClosingKeyword("Summary. Closes #42", 42), true);
});

Deno.test("regression pr_body - hasClosingKeyword with issue number 0", () => {
  assertEquals(hasClosingKeyword("Closes #0", 0), true);
});

Deno.test("regression pr_body - hasClosingKeyword does not match non-keyword prefixes", () => {
  assertEquals(hasClosingKeyword("Addresses #42", 42), false);
  assertEquals(hasClosingKeyword("Related to #42", 42), false);
  assertEquals(hasClosingKeyword("See #42", 42), false);
});

Deno.test("regression pr_body - hasClosingKeyword with issue at end of body", () => {
  assertEquals(hasClosingKeyword("Done. Closes #42", 42), true);
});

// ============================================================================
// ensurePrReferencesIssue — idempotency and edge cases
// ============================================================================

Deno.test("regression pr_body - ensurePrReferencesIssue is idempotent", () => {
  const body = "Summary. Closes #42";
  const result = ensurePrReferencesIssue(body, 42);
  assertEquals(result, body, "Should not duplicate closing keyword");
});

Deno.test("regression pr_body - ensurePrReferencesIssue appends when missing", () => {
  const body = "Summary of changes";
  const result = ensurePrReferencesIssue(body, 42);
  assert(result.includes("Closes #42"), "Should append Closes #42");
  assert(result.startsWith(body), "Original body should be preserved");
});

Deno.test("regression pr_body - ensurePrReferencesIssue with empty body", () => {
  const result = ensurePrReferencesIssue("", 42);
  assert(
    result.includes("Closes #42"),
    "Should add closing keyword to empty body",
  );
});

Deno.test("regression pr_body - ensurePrReferencesIssue preserves existing different issue ref", () => {
  const body = "Summary. Closes #99";
  const result = ensurePrReferencesIssue(body, 42);
  assert(result.includes("Closes #42"), "Should add ref for issue 42");
  assert(
    result.includes("Closes #99"),
    "Should preserve existing ref for issue 99",
  );
});

Deno.test("regression pr_body - ensurePrReferencesIssue with special characters in body", () => {
  const body = 'Fix: handle `<script>` tags & "quotes" in PR body';
  const result = ensurePrReferencesIssue(body, 42);
  assert(result.includes("Closes #42"), "Should append closing keyword");
  assert(result.includes(body), "Should preserve special characters");
});

// ============================================================================
// buildMilestonePrSection — edge cases
// ============================================================================

Deno.test("regression pr_body - buildMilestonePrSection with empty title", () => {
  assertEquals(
    buildMilestonePrSection({
      milestoneTitle: "",
      milestoneBranch: "milestone/branch",
      baseBranch: "milestone/branch",
    }),
    "",
  );
});

Deno.test("regression pr_body - buildMilestonePrSection with empty branch", () => {
  assertEquals(
    buildMilestonePrSection({
      milestoneTitle: "Title",
      milestoneBranch: "",
      baseBranch: "Develop",
    }),
    "",
  );
});

Deno.test("regression pr_body - buildMilestonePrSection with both empty", () => {
  assertEquals(
    buildMilestonePrSection({
      milestoneTitle: "",
      milestoneBranch: "",
      baseBranch: "",
    }),
    "",
  );
});

Deno.test("regression pr_body - buildMilestonePrSection generates valid markdown", () => {
  const result = buildMilestonePrSection({
    milestoneTitle: "OIDC Auth",
    milestoneBranch: "milestone/oidc-auth",
    baseBranch: "milestone/oidc-auth",
  });
  assert(result.includes("## Milestone"), "Should include milestone heading");
  assert(result.includes("**OIDC Auth**"), "Should bold the milestone title");
  assert(
    result.includes("`milestone/oidc-auth`"),
    "Should inline-code the branch name",
  );
});

Deno.test("regression pr_body - buildMilestonePrSection with special characters in title", () => {
  const result = buildMilestonePrSection({
    milestoneTitle: "Phase 2: Auth & SSO",
    milestoneBranch: "milestone/phase-2",
    baseBranch: "milestone/phase-2",
  });
  assert(
    result.includes("**Phase 2: Auth & SSO**"),
    "Should preserve special characters in title",
  );
});

Deno.test("regression pr_body - buildMilestonePrSection names the base, not the milestone branch, on mismatch (Issue #3911)", () => {
  const result = buildMilestonePrSection({
    milestoneTitle: "Phase 2: Auth & SSO",
    milestoneBranch: "milestone/phase-2",
    baseBranch: "Develop",
  });
  assert(
    result.includes("`Develop`"),
    "Should name the branch the PR is actually based on",
  );
  assert(
    !result.includes("milestone/phase-2"),
    "Should not claim a milestone branch that is not the PR's base",
  );
});

// ============================================================================
// buildIdempotencyMarker — format validation
// ============================================================================

Deno.test("regression pr_body - buildIdempotencyMarker creates HTML comment", () => {
  const marker = buildIdempotencyMarker(42);
  assertEquals(marker, "<!-- vibe-worker-issue-42 -->");
});

Deno.test("regression pr_body - buildIdempotencyMarker is invisible in rendered markdown", () => {
  const marker = buildIdempotencyMarker(42);
  assert(marker.startsWith("<!--"), "Should start with HTML comment opener");
  assert(marker.endsWith("-->"), "Should end with HTML comment closer");
});

Deno.test("regression pr_body - buildIdempotencyMarker with large issue number", () => {
  const marker = buildIdempotencyMarker(999999);
  assertEquals(marker, "<!-- vibe-worker-issue-999999 -->");
});

// ============================================================================
// extractIssueNumberFromPrTitle — edge cases
// ============================================================================

Deno.test("regression pr_body - extractIssueNumberFromPrTitle with standard format", () => {
  const result = extractIssueNumberFromPrTitle("Fix: Login bug (#42)");
  assert(result.ok, "Should extract issue number");
  assertEquals(result.ok ? result.value : null, 42);
});

Deno.test("regression pr_body - extractIssueNumberFromPrTitle with Issue prefix", () => {
  const result = extractIssueNumberFromPrTitle("Feat: Add auth (Issue #123)");
  assert(result.ok, "Should extract issue number with Issue prefix");
  assertEquals(result.ok ? result.value : null, 123);
});

Deno.test("regression pr_body - extractIssueNumberFromPrTitle with no issue number", () => {
  const result = extractIssueNumberFromPrTitle("Fix some bug");
  assert(!result.ok, "Should return error for title without issue number");
});

Deno.test("regression pr_body - extractIssueNumberFromPrTitle with empty title", () => {
  const result = extractIssueNumberFromPrTitle("");
  assert(!result.ok, "Should return error for empty title");
});

Deno.test("regression pr_body - extractIssueNumberFromPrTitle with hash mid-title", () => {
  // Issue number must be at the end in parentheses
  const result = extractIssueNumberFromPrTitle("Fix #42 in module");
  assert(!result.ok, "Should not extract mid-title references");
});

Deno.test("regression pr_body - extractIssueNumberFromPrTitle with large issue number", () => {
  const result = extractIssueNumberFromPrTitle("Fix: bug (#999999)");
  assert(result.ok, "Should extract large issue number");
  assertEquals(result.ok ? result.value : null, 999999);
});
