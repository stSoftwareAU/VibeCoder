/**
 * Tests for the find-issues-by-label command (Issue #1309).
 *
 * Tests argument validation and output formatting.
 * The actual label-based issue discovery delegates to lib/issue_finder.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { findIssuesByLabelCommand } from "../commands/find_issues_by_label.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("findIssuesByLabelCommand - has correct name", () => {
  assertEquals(findIssuesByLabelCommand.name, "find-issues-by-label");
});

Deno.test("findIssuesByLabelCommand - has description", () => {
  assertEquals(typeof findIssuesByLabelCommand.description, "string");
  assertEquals(findIssuesByLabelCommand.description.length > 0, true);
});

// ============================================================================
// Argument validation
// ============================================================================

Deno.test("findIssuesByLabelCommand - fails when label is missing", async () => {
  const result = await findIssuesByLabelCommand.execute(
    { "github-user": "test-user" },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'label' is missing");
});

Deno.test("findIssuesByLabelCommand - fails when github-user is missing", async () => {
  const result = await findIssuesByLabelCommand.execute(
    { label: "work-on" },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'github-user' is missing");
});

Deno.test("findIssuesByLabelCommand - fails when both args are missing", async () => {
  const result = await findIssuesByLabelCommand.execute({}, config);
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'label' is missing");
});

Deno.test("findIssuesByLabelCommand - fails when label is empty string", async () => {
  const result = await findIssuesByLabelCommand.execute(
    { label: "", "github-user": "test-user" },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'label' is missing");
});
