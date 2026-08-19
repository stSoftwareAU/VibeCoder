/**
 * Tests for the find-issues command (Issue #1309).
 *
 * Tests argument validation and output parsing logic.
 * The actual issue discovery delegates to lib/issue_finder.ts which
 * has its own tests — here we focus on the command wrapper behaviour.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { findIssuesCommand } from "../commands/find_issues.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("findIssuesCommand - has correct name", () => {
  assertEquals(findIssuesCommand.name, "find-issues");
});

Deno.test("findIssuesCommand - has description", () => {
  assertEquals(typeof findIssuesCommand.description, "string");
  assertEquals(findIssuesCommand.description.length > 0, true);
});

// ============================================================================
// Argument validation
// ============================================================================

Deno.test("findIssuesCommand - fails when github-user is missing", async () => {
  const result = await findIssuesCommand.execute({}, config);
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'github-user' is missing");
});

Deno.test("findIssuesCommand - fails when github-user is empty string", async () => {
  const result = await findIssuesCommand.execute(
    { "github-user": "" },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'github-user' is missing");
});
