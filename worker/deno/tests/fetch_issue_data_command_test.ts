/**
 * Tests for the fetch-issue-data command (Issue #1309).
 *
 * Tests argument validation and result formatting.
 * The actual data fetching delegates to lib/issue_data.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { fetchIssueDataCommand } from "../commands/fetch_issue_data.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("fetchIssueDataCommand - has correct name", () => {
  assertEquals(fetchIssueDataCommand.name, "fetch-issue-data");
});

Deno.test("fetchIssueDataCommand - has description", () => {
  assertEquals(typeof fetchIssueDataCommand.description, "string");
  assertEquals(fetchIssueDataCommand.description.length > 0, true);
});

// ============================================================================
// Argument validation
// ============================================================================

Deno.test("fetchIssueDataCommand - fails when repo is missing", async () => {
  const result = await fetchIssueDataCommand.execute(
    { issue: 42 },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'repo' is missing");
});

Deno.test("fetchIssueDataCommand - fails when issue is missing", async () => {
  const result = await fetchIssueDataCommand.execute(
    { repo: "owner/repo" },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'issue' is missing");
});

Deno.test("fetchIssueDataCommand - fails when both args are missing", async () => {
  const result = await fetchIssueDataCommand.execute({}, config);
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'repo' is missing");
});

Deno.test("fetchIssueDataCommand - fails when repo is empty string", async () => {
  const result = await fetchIssueDataCommand.execute(
    { repo: "", issue: 42 },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message, "Required argument 'repo' is missing");
});
