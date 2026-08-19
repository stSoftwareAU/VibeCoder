/**
 * Regression test suite — git operations parity validation (Issue #1235).
 *
 * Validates that the Deno git operations produce identical results to the
 * original shell implementations, focusing on branch naming, protection
 * detection, and edge cases with special characters and empty inputs.
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  createBranchName,
  createMilestoneBranchName,
  isProtectedBranch,
} from "../lib/git_branch.ts";

// ============================================================================
// createBranchName — edge cases and parity with shell implementation
// ============================================================================

Deno.test("regression git - createBranchName with empty title", () => {
  const result = createBranchName(42, "");
  assertEquals(result, "issue-42-");
});

Deno.test("regression git - createBranchName with whitespace-only title", () => {
  const result = createBranchName(42, "   ");
  // Whitespace chars become hyphens, consecutive hyphens collapse to one
  assert(result.startsWith("issue-42-"), "Should start with issue prefix");
});

Deno.test("regression git - createBranchName with special characters", () => {
  const result = createBranchName(42, "Fix: login bug (authentication) @#$%");
  // All special chars should be replaced with hyphens, consecutive hyphens collapsed
  assert(!result.includes(" "), "Branch name should not contain spaces");
  assert(!result.includes("("), "Branch name should not contain parentheses");
  assert(!result.includes("@"), "Branch name should not contain @");
  assert(!result.includes("#"), "Branch name should not contain #");
  assert(
    result.startsWith("issue-42-"),
    "Branch name should start with issue prefix",
  );
});

Deno.test("regression git - createBranchName with Unicode characters", () => {
  const result = createBranchName(42, "Fix für überprüfung");
  // Unicode chars are not [a-z0-9], so they become hyphens
  assert(!result.includes("ü"), "Branch name should not contain Unicode");
  assertEquals(result, "issue-42-fix-f-r-berpr-fung");
});

Deno.test("regression git - createBranchName truncates long titles to 50 chars", () => {
  const longTitle = "a".repeat(100);
  const result = createBranchName(1, longTitle);
  // "issue-1-" prefix (8 chars) + up to 50 chars from title
  const titlePart = result.substring("issue-1-".length);
  assert(
    titlePart.length <= 50,
    `Title part should be at most 50 chars, got ${titlePart.length}`,
  );
});

Deno.test("regression git - createBranchName with issue number 0", () => {
  const result = createBranchName(0, "test");
  assertEquals(result, "issue-0-test");
});

Deno.test("regression git - createBranchName with large issue number", () => {
  const result = createBranchName(999999, "test");
  assertEquals(result, "issue-999999-test");
});

Deno.test("regression git - createBranchName collapses consecutive hyphens", () => {
  const result = createBranchName(42, "fix -- multiple --- hyphens");
  assert(
    !result.includes("--"),
    "Branch name should not contain consecutive hyphens",
  );
});

Deno.test("regression git - createBranchName lowercases all characters", () => {
  const result = createBranchName(42, "FIX LOGIN Bug");
  assertEquals(result, "issue-42-fix-login-bug");
});

Deno.test("regression git - createBranchName with numbers in title", () => {
  const result = createBranchName(42, "Fix issue 123 in module 456");
  assertEquals(result, "issue-42-fix-issue-123-in-module-456");
});

// ============================================================================
// createMilestoneBranchName — edge cases
// ============================================================================

Deno.test("regression git - createMilestoneBranchName with empty title", () => {
  const result = createMilestoneBranchName("");
  assertEquals(result, "milestone/");
});

Deno.test("regression git - createMilestoneBranchName strips leading/trailing hyphens", () => {
  const result = createMilestoneBranchName("  OIDC Auth  ");
  assert(!result.endsWith("-"), "Should strip trailing hyphens");
  assertEquals(result, "milestone/oidc-auth");
});

Deno.test("regression git - createMilestoneBranchName truncates to 50 chars", () => {
  const longTitle = "a".repeat(100);
  const result = createMilestoneBranchName(longTitle);
  const titlePart = result.substring("milestone/".length);
  assert(
    titlePart.length <= 50,
    `Title part should be at most 50 chars, got ${titlePart.length}`,
  );
});

Deno.test("regression git - createMilestoneBranchName with special characters", () => {
  const result = createMilestoneBranchName("OIDC Authentication (Phase 2)");
  assertEquals(result, "milestone/oidc-authentication-phase-2");
});

Deno.test("regression git - createMilestoneBranchName with version numbers", () => {
  const result = createMilestoneBranchName("v2.0 Release");
  assertEquals(result, "milestone/v2-0-release");
});

// ============================================================================
// isProtectedBranch — comprehensive detection
// ============================================================================

Deno.test("regression git - isProtectedBranch detects all standard protected branches", () => {
  const protectedNames = [
    "main",
    "master",
    "develop",
    "release",
    "production",
    "staging",
  ];

  for (const name of protectedNames) {
    assert(isProtectedBranch(name), `"${name}" should be protected`);
  }
});

Deno.test("regression git - isProtectedBranch is case-insensitive", () => {
  assert(isProtectedBranch("MAIN"), "MAIN should be protected");
  assert(isProtectedBranch("Main"), "Main should be protected");
  assert(isProtectedBranch("DEVELOP"), "DEVELOP should be protected");
  assert(isProtectedBranch("Master"), "Master should be protected");
});

Deno.test("regression git - isProtectedBranch detects milestone branches", () => {
  assert(
    isProtectedBranch("milestone/oidc-auth"),
    "milestone/ branches should be protected",
  );
  assert(isProtectedBranch("milestone/v2"), "milestone/v2 should be protected");
  assert(
    isProtectedBranch("MILESTONE/test"),
    "MILESTONE/ should be protected (case-insensitive)",
  );
});

Deno.test("regression git - isProtectedBranch allows feature branches", () => {
  assert(
    !isProtectedBranch("issue-42-fix-bug"),
    "Feature branches should not be protected",
  );
  assert(
    !isProtectedBranch("feature/new-login"),
    "feature/ branches should not be protected",
  );
  assert(
    !isProtectedBranch("hotfix/urgent-fix"),
    "hotfix/ branches should not be protected",
  );
  assert(
    !isProtectedBranch("main-feature"),
    "'main-feature' should not be protected",
  );
});

Deno.test("regression git - isProtectedBranch handles empty string", () => {
  assert(!isProtectedBranch(""), "Empty string should not be protected");
});

Deno.test("regression git - isProtectedBranch does not match partial names", () => {
  assert(
    !isProtectedBranch("maintainer"),
    "'maintainer' should not match 'main'",
  );
  assert(
    !isProtectedBranch("developer"),
    "'developer' should not match 'develop'",
  );
  assert(
    !isProtectedBranch("masterclass"),
    "'masterclass' should not match 'master'",
  );
});
