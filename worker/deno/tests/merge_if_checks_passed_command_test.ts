/**
 * Tests for the merge-if-checks-passed command (Issue #1309).
 *
 * Tests argument validation and decision logic paths.
 * The actual CI status checks and merge operations delegate to lib/direct_merge.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  blockedReason,
  mergeIfChecksPassedCommand,
} from "../commands/merge_if_checks_passed.ts";
import type { MergeBlockedReason } from "../lib/direct_merge.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("mergeIfChecksPassedCommand - has correct name", () => {
  assertEquals(mergeIfChecksPassedCommand.name, "merge-if-checks-passed");
});

Deno.test("mergeIfChecksPassedCommand - has description", () => {
  assertEquals(typeof mergeIfChecksPassedCommand.description, "string");
  assertEquals(mergeIfChecksPassedCommand.description.length > 0, true);
});

// ============================================================================
// blockedReason — exhaustiveness guard (Issue #2794)
// ============================================================================

Deno.test("blockedReason - maps an absent reason to checks_pending", () => {
  assertEquals(blockedReason(undefined), "checks_pending");
});

Deno.test("blockedReason - maps each known reason to its stable string", () => {
  assertEquals(blockedReason("checks_failed"), "checks_failed");
  assertEquals(blockedReason("behind_target"), "behind_target");
  assertEquals(blockedReason("checks_pending"), "checks_pending");
  // Issue #1082: a default-branch PR held for want of a review reports the
  // hold, not a generic "checks pending" that hides why it did not land.
  assertEquals(
    blockedReason("default_branch_unapproved"),
    "default_branch_unapproved",
  );
});

Deno.test("blockedReason - throws via assertNever on an out-of-union reason", () => {
  assertThrows(
    () => blockedReason("frozen" as MergeBlockedReason),
    Error,
    "Unreachable",
  );
});

// ============================================================================
// Argument validation (exercised through execute)
// ============================================================================

Deno.test("mergeIfChecksPassedCommand - fails when repo is missing", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { pr: 42 },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required argument: --repo");
});

Deno.test("mergeIfChecksPassedCommand - fails when repo is empty string", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "", pr: 42 },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required argument: --repo");
});

Deno.test("mergeIfChecksPassedCommand - fails when repo has invalid format", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "invalid-no-slash", pr: 42 },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Invalid --repo format");
});

Deno.test("mergeIfChecksPassedCommand - fails when repo has multiple slashes", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "a/b/c", pr: 42 },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Invalid --repo format");
});

Deno.test("mergeIfChecksPassedCommand - fails when pr is missing", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "owner/repo" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing or invalid --pr argument");
});

Deno.test("mergeIfChecksPassedCommand - fails when pr is zero", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "owner/repo", pr: 0 },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing or invalid --pr argument");
});

Deno.test("mergeIfChecksPassedCommand - fails when pr is negative", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "owner/repo", pr: -1 },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing or invalid --pr argument");
});

Deno.test("mergeIfChecksPassedCommand - fails when pr is not an integer", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "owner/repo", pr: 3.5 },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing or invalid --pr argument");
});

Deno.test("mergeIfChecksPassedCommand - accepts string pr number", async () => {
  // This will pass validation but fail at the CI check stage (no real GitHub)
  // We're testing that string-to-number conversion works for the PR argument
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "owner/repo", pr: "42" },
    config,
  );
  // Should pass validation and attempt the CI check (which will fail without GitHub)
  // The key assertion is that it does NOT fail with a validation error
  if (!result.success) {
    // It should fail for a reason other than argument validation
    assertEquals(result.message.includes("Missing"), false);
    assertEquals(result.message.includes("Invalid"), false);
  }
});
