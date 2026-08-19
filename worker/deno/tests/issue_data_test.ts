/**
 * Tests for issue_data.ts (Issue #910).
 */

import { assertEquals } from "@std/assert";
import {
  fetchIssueData,
  formatCommentsLegacy,
  parseIssueDataJson,
} from "../lib/issue_data.ts";

// =============================================================================
// parseIssueDataJson tests
// =============================================================================

Deno.test("issue_data - parseIssueDataJson returns empty data for empty string", () => {
  const result = parseIssueDataJson("");
  assertEquals(result.body, "");
  assertEquals(result.labels, []);
  assertEquals(result.comments, []);
  assertEquals(result.state, "");
});

Deno.test("issue_data - parseIssueDataJson returns empty data for empty object", () => {
  const result = parseIssueDataJson("{}");
  assertEquals(result.body, "");
  assertEquals(result.labels, []);
  assertEquals(result.comments, []);
  assertEquals(result.state, "");
});

Deno.test("issue_data - parseIssueDataJson parses full issue data", () => {
  const json = JSON.stringify({
    body: "Fix the bug in login",
    labels: [{ name: "bug" }, { name: "enhancement" }],
    comments: [
      { author: { login: "user1" }, body: "This needs fixing" },
      { author: { login: "user2" }, body: "Agreed" },
    ],
    state: "OPEN",
  });

  const result = parseIssueDataJson(json);
  assertEquals(result.body, "Fix the bug in login");
  assertEquals(result.labels, ["bug", "enhancement"]);
  assertEquals(result.comments.length, 2);
  assertEquals(result.comments[0]?.author, "user1");
  assertEquals(result.comments[0]?.body, "This needs fixing");
  assertEquals(result.comments[1]?.author, "user2");
  assertEquals(result.state, "OPEN");
});

Deno.test("issue_data - parseIssueDataJson extracts the issue author login (Issue #3312)", () => {
  const json = JSON.stringify({
    author: { login: "mallory" },
    body: "Fix the bug",
    state: "OPEN",
  });
  const result = parseIssueDataJson(json);
  assertEquals(result.author, "mallory");
});

Deno.test("issue_data - parseIssueDataJson defaults author to empty string when absent (Issue #3312)", () => {
  const json = JSON.stringify({ body: "No author field" });
  const result = parseIssueDataJson(json);
  assertEquals(result.author, "");
});

Deno.test("issue_data - parseIssueDataJson handles missing fields gracefully", () => {
  const json = JSON.stringify({ body: "Just a body" });
  const result = parseIssueDataJson(json);
  assertEquals(result.body, "Just a body");
  assertEquals(result.labels, []);
  assertEquals(result.comments, []);
  assertEquals(result.state, "");
});

Deno.test("issue_data - parseIssueDataJson handles invalid JSON", () => {
  const result = parseIssueDataJson("not json");
  assertEquals(result.body, "");
  assertEquals(result.labels, []);
});

// =============================================================================
// formatCommentsLegacy tests
// =============================================================================

Deno.test("issue_data - formatCommentsLegacy returns empty string for no comments", () => {
  assertEquals(formatCommentsLegacy([]), "");
});

Deno.test("issue_data - formatCommentsLegacy formats single comment", () => {
  const result = formatCommentsLegacy([
    { author: "user1", body: "Hello world" },
  ]);
  assertEquals(result, "[user1]: Hello world");
});

Deno.test("issue_data - formatCommentsLegacy formats multiple comments with dividers", () => {
  const result = formatCommentsLegacy([
    { author: "user1", body: "First comment" },
    { author: "user2", body: "Second comment" },
  ]);
  assertEquals(
    result,
    "[user1]: First comment\n\n---\n\n[user2]: Second comment",
  );
});

// =============================================================================
// fetchIssueData tests with mock
// =============================================================================

Deno.test("issue_data - fetchIssueData returns empty data for missing repo", async () => {
  const result = await fetchIssueData("", 42);
  assertEquals(result.body, "");
  assertEquals(result.labels, []);
});

Deno.test("issue_data - fetchIssueData returns empty data for zero issue number", async () => {
  const result = await fetchIssueData("owner/repo", 0);
  assertEquals(result.body, "");
});

Deno.test("issue_data - fetchIssueData calls gh CLI and parses result", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify({
      body: "Test body",
      labels: [{ name: "bug" }],
      comments: [],
      state: "OPEN",
    });
  };

  const result = await fetchIssueData("owner/repo", 42, mockGh);
  assertEquals(result.body, "Test body");
  assertEquals(result.labels, ["bug"]);
  assertEquals(result.state, "OPEN");
});

Deno.test("issue_data - fetchIssueData requests and returns the title (Issue #3878)", async () => {
  // The pickup-time content-integrity gate hashes this title. A field list
  // that drops `title` silently reverts to hashing the stale scan-time title,
  // so a title-only edit would verify as unchanged — assert the field
  // directly rather than only via the integration path.
  let requestedFields = "";
  const mockGh = (args: string[]): Promise<string> => {
    const jsonIndex = args.indexOf("--json");
    requestedFields = args[jsonIndex + 1] ?? "";
    return Promise.resolve(JSON.stringify({
      title: "Current title",
      body: "Test body",
      state: "OPEN",
    }));
  };

  const result = await fetchIssueData("owner/repo", 42, mockGh);
  assertEquals(requestedFields.split(",").includes("title"), true);
  assertEquals(result.title, "Current title");
});

Deno.test("issue_data - parseIssueDataJson defaults title to empty string when absent (Issue #3878)", () => {
  assertEquals(parseIssueDataJson(JSON.stringify({ body: "b" })).title, "");
  assertEquals(parseIssueDataJson("").title, "");
});

Deno.test("issue_data - fetchIssueData returns empty data on gh failure", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("gh command failed");
  };

  const result = await fetchIssueData("owner/repo", 42, mockGh);
  assertEquals(result.body, "");
  assertEquals(result.labels, []);
});

// =============================================================================
// Milestone support (Issue #1300)
// =============================================================================

Deno.test("issue_data - parseIssueDataJson extracts milestone title", () => {
  const json = JSON.stringify({
    body: "Plan the feature",
    labels: [{ name: "planning" }],
    comments: [],
    state: "OPEN",
    milestone: { title: "v2.0" },
  });

  const result = parseIssueDataJson(json);
  assertEquals(result.milestoneTitle, "v2.0");
});

Deno.test("issue_data - parseIssueDataJson returns empty milestone when null", () => {
  const json = JSON.stringify({
    body: "No milestone",
    labels: [],
    comments: [],
    state: "OPEN",
    milestone: null,
  });

  const result = parseIssueDataJson(json);
  assertEquals(result.milestoneTitle, "");
});

Deno.test("issue_data - parseIssueDataJson returns empty milestone when absent", () => {
  const json = JSON.stringify({
    body: "No milestone field",
    labels: [],
    comments: [],
    state: "OPEN",
  });

  const result = parseIssueDataJson(json);
  assertEquals(result.milestoneTitle, "");
});

Deno.test("issue_data - fetchIssueData requests milestone field from gh CLI", async () => {
  let capturedArgs: string[] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    capturedArgs = args;
    return JSON.stringify({
      body: "Test",
      labels: [],
      comments: [],
      state: "OPEN",
      milestone: { title: "Sprint 3" },
    });
  };

  const result = await fetchIssueData("owner/repo", 42, mockGh);
  assertEquals(result.milestoneTitle, "Sprint 3");
  // Verify the gh command includes the milestone field
  const jsonArg = capturedArgs[capturedArgs.length - 1] ?? "";
  assertEquals(jsonArg.includes("milestone"), true);
});

Deno.test("issue_data - empty data includes milestoneTitle field", () => {
  const result = parseIssueDataJson("");
  assertEquals(result.milestoneTitle, "");
});
