/**
 * Tests for the pr-manager command (Issue #1309).
 *
 * Tests argument validation, operation dispatch, and pure-logic operations.
 * Many sub-operations delegate to already-tested library modules — here we
 * test the command wrapper's routing, argument validation, and the operations
 * that use pure functions (PR body, evidence, screenshot references).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { prManagerCommand } from "../commands/pr_manager.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("prManagerCommand - has correct name", () => {
  assertEquals(prManagerCommand.name, "pr-manager");
});

Deno.test("prManagerCommand - has description", () => {
  assertEquals(typeof prManagerCommand.description, "string");
  assertEquals(prManagerCommand.description.length > 0, true);
});

// ============================================================================
// Unknown operation
// ============================================================================

Deno.test("prManagerCommand - fails for unknown operation", async () => {
  const result = await prManagerCommand.execute(
    { operation: "nonexistent-op" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Unknown operation: nonexistent-op");
});

Deno.test("prManagerCommand - fails for empty operation", async () => {
  const result = await prManagerCommand.execute({}, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Unknown operation:");
});

// ============================================================================
// ensure-pr-references-issue (pure logic — delegates to pr_body.ts)
// ============================================================================

Deno.test("prManagerCommand - ensure-pr-references-issue adds reference when missing", async () => {
  const result = await prManagerCommand.execute(
    {
      operation: "ensure-pr-references-issue",
      "pr-body": "Some PR description",
      "issue-number": 42,
    },
    config,
  );
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "42");
});

Deno.test("prManagerCommand - ensure-pr-references-issue requires issue-number", async () => {
  const result = await prManagerCommand.execute(
    {
      operation: "ensure-pr-references-issue",
      "pr-body": "Some PR description",
    },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(
    result.message,
    "Missing required argument: --issue-number",
  );
});

// ============================================================================
// build-milestone-section (pure logic — delegates to pr_body.ts)
// ============================================================================

Deno.test("prManagerCommand - build-milestone-section returns section text", async () => {
  const result = await prManagerCommand.execute(
    {
      operation: "build-milestone-section",
      "milestone-title": "v2.0 Release",
      "milestone-branch": "milestone/v2-0-release",
      "base-branch": "milestone/v2-0-release",
    },
    config,
  );
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "v2.0 Release");
  assertStringIncludes(result.message, "`milestone/v2-0-release`");
});

Deno.test("prManagerCommand - build-milestone-section renders the actual base (Issue #3911)", async () => {
  const result = await prManagerCommand.execute(
    {
      operation: "build-milestone-section",
      "milestone-title": "v2.0 Release",
      "milestone-branch": "milestone/v2-0-release",
      "base-branch": "Develop",
    },
    config,
  );
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "`Develop`");
  assertEquals(
    result.message.includes("milestone/v2-0-release"),
    false,
    "must not claim a milestone branch that is not the PR's base",
  );
});

Deno.test("prManagerCommand - build-milestone-section handles empty inputs", async () => {
  const result = await prManagerCommand.execute(
    { operation: "build-milestone-section" },
    config,
  );
  assertEquals(result.success, true);
});

// ============================================================================
// build-idempotency-marker (pure logic — delegates to pr_body.ts)
// ============================================================================

Deno.test("prManagerCommand - build-idempotency-marker returns marker", async () => {
  const result = await prManagerCommand.execute(
    {
      operation: "build-idempotency-marker",
      "issue-number": 123,
    },
    config,
  );
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "123");
});

Deno.test("prManagerCommand - build-idempotency-marker requires issue-number", async () => {
  const result = await prManagerCommand.execute(
    { operation: "build-idempotency-marker" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(
    result.message,
    "Missing required argument: --issue-number",
  );
});

// ============================================================================
// extract-issue-number (pure logic — delegates to pr_body.ts)
// ============================================================================

Deno.test("prManagerCommand - extract-issue-number extracts from standard title", async () => {
  const result = await prManagerCommand.execute(
    {
      operation: "extract-issue-number",
      title: "Fix: Login bug (#42)",
    },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "42");
});

Deno.test("prManagerCommand - extract-issue-number requires title", async () => {
  const result = await prManagerCommand.execute(
    { operation: "extract-issue-number" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required argument: --title");
});

// ============================================================================
// find-screenshot-references (pure logic — delegates to pr_evidence.ts)
// ============================================================================

Deno.test("prManagerCommand - find-screenshot-references finds markdown images", async () => {
  const result = await prManagerCommand.execute(
    {
      operation: "find-screenshot-references",
      content:
        "![Screenshot](docs/evidence/test.png)\nSome text\n![Another](docs/evidence/other.jpg)",
    },
    config,
  );
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "docs/evidence/test.png");
});

Deno.test("prManagerCommand - find-screenshot-references returns empty for no images", async () => {
  const result = await prManagerCommand.execute(
    {
      operation: "find-screenshot-references",
      content: "No images here",
    },
    config,
  );
  assertEquals(result.success, true);
});

// ============================================================================
// Argument validation for operations requiring --repo, --pr-number
// ============================================================================

Deno.test("prManagerCommand - enable-auto-merge requires repo and pr-number", async () => {
  const result = await prManagerCommand.execute(
    { operation: "enable-auto-merge" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - finalise-pr requires repo and pr-number", async () => {
  const result = await prManagerCommand.execute(
    { operation: "finalise-pr" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - claim-pr-comment requires repo, pr-number, comment-id", async () => {
  const result = await prManagerCommand.execute(
    { operation: "claim-pr-comment" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - mark-comment-processed requires repo and comment-id", async () => {
  const result = await prManagerCommand.execute(
    { operation: "mark-comment-processed" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - reply-to-comment requires repo, pr-number, message", async () => {
  const result = await prManagerCommand.execute(
    { operation: "reply-to-comment" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - handle-pr-comment-failure requires repo, pr-number, comment-id", async () => {
  const result = await prManagerCommand.execute(
    { operation: "handle-pr-comment-failure" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - check-pr-comment-failed-once requires repo and comment-id", async () => {
  const result = await prManagerCommand.execute(
    { operation: "check-pr-comment-failed-once" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - record-ci-check-retry requires state-dir, repo, check-id", async () => {
  const result = await prManagerCommand.execute(
    { operation: "record-ci-check-retry" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - get-ci-check-retry-count requires state-dir, repo, check-id", async () => {
  const result = await prManagerCommand.execute(
    { operation: "get-ci-check-retry-count" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - link-pr-to-issue requires repo, issue-number, pr-url", async () => {
  const result = await prManagerCommand.execute(
    { operation: "link-pr-to-issue" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - find-existing-pr-for-branch requires repo and branch-name", async () => {
  const result = await prManagerCommand.execute(
    { operation: "find-existing-pr-for-branch" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - find-existing-pr-for-issue requires repo and issue-number", async () => {
  const result = await prManagerCommand.execute(
    { operation: "find-existing-pr-for-issue" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - close-duplicate-prs requires repo, branch-name, keep-pr-url", async () => {
  const result = await prManagerCommand.execute(
    { operation: "close-duplicate-prs" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - close-issues-for-merged-prs requires github-user and repos", async () => {
  const result = await prManagerCommand.execute(
    { operation: "close-issues-for-merged-prs" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});

Deno.test("prManagerCommand - retarget-pr-to-milestone requires repo and pr-number", async () => {
  const result = await prManagerCommand.execute(
    { operation: "retarget-pr-to-milestone" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});
