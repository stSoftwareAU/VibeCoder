/**
 * Tests for the check-parent-deps command (Issue #484).
 *
 * Tests the command handler and the gh CLI-backed IssueFetcher.
 * GitHub API responses are mocked to enable deterministic testing.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkParentDepsCommand,
  createGhIssueFetcher,
} from "../commands/check_parent_dependencies.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;
}

// =============================================================================
// createGhIssueFetcher tests
// =============================================================================

Deno.test("createGhIssueFetcher - getIssueState parses gh output", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify({ number: 42, state: "OPEN", title: "Test issue" });
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const state = await fetcher.getIssueState("owner/repo", 42);

  assertEquals(state.number, 42);
  assertEquals(state.state, "OPEN");
  assertEquals(state.title, "Test issue");
});

Deno.test("createGhIssueFetcher - getIssueState handles CLOSED", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify({ number: 10, state: "CLOSED", title: "Done" });
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const state = await fetcher.getIssueState("owner/repo", 10);

  assertEquals(state.state, "CLOSED");
});

Deno.test("createGhIssueFetcher - getIssueBody parses body", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify({ body: "Issue body content" });
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const body = await fetcher.getIssueBody("owner/repo", 42);

  assertEquals(body, "Issue body content");
});

Deno.test("createGhIssueFetcher - getIssueBody handles null body", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify({ body: null });
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const body = await fetcher.getIssueBody("owner/repo", 42);

  assertEquals(body, "");
});

Deno.test("createGhIssueFetcher - getSubIssues returns empty on failure", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API error");
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const subs = await fetcher.getSubIssues("owner/repo", 42);

  assertEquals(subs, []);
});

// =============================================================================
// checkParentDepsCommand tests
// =============================================================================

Deno.test("checkParentDepsCommand - returns error for missing repo", async () => {
  const config = createMockConfig();
  const result = await checkParentDepsCommand.execute(
    { issue: 42 },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "repo");
});

Deno.test("checkParentDepsCommand - returns error for missing issue", async () => {
  const config = createMockConfig();
  const result = await checkParentDepsCommand.execute(
    { repo: "owner/repo" },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "issue");
});

Deno.test("checkParentDepsCommand - has correct name and description", () => {
  assertEquals(checkParentDepsCommand.name, "check-parent-deps");
  assertStringIncludes(checkParentDepsCommand.description, "sub-issues");
});
