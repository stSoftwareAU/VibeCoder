/**
 * Tests for closed PR blocking — prevents creating duplicate PRs for the
 * same issue when a recent PR was already closed (Issue #1427).
 *
 * When a PR is closed without merge, the worker should not immediately
 * pick up the same issue and create another PR. This wastes tokens and time.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  fetchRecentlyClosedPRsByUser,
  isBlockedByRecentlyClosedPR,
  parseClosedPRListJson,
} from "../lib/issue_query.ts";
import { findExistingPrForIssue } from "../lib/pr_issue_linking.ts";

// =============================================================================
// parseClosedPRListJson tests
// =============================================================================

Deno.test("closed_pr_blocking - parseClosedPRListJson parses valid JSON", () => {
  const json = JSON.stringify([
    {
      number: 2337,
      title: "Pipelined double-buffered I/O (#2331)",
      closedAt: "2026-04-17T11:45:09Z",
    },
  ]);
  const result = parseClosedPRListJson(json);
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 2337);
  assertEquals(result[0]?.title, "Pipelined double-buffered I/O (#2331)");
  assertEquals(result[0]?.closedAt, "2026-04-17T11:45:09Z");
});

Deno.test("closed_pr_blocking - parseClosedPRListJson returns empty for invalid JSON", () => {
  assertEquals(parseClosedPRListJson("not json"), []);
  assertEquals(parseClosedPRListJson(""), []);
  assertEquals(parseClosedPRListJson("null"), []);
});

Deno.test("closed_pr_blocking - parseClosedPRListJson filters invalid entries", () => {
  const json = JSON.stringify([
    { number: 1, title: "Valid (#42)", closedAt: "2026-01-01T00:00:00Z" },
    {
      number: "bad",
      title: "Invalid number",
      closedAt: "2026-01-01T00:00:00Z",
    },
    { title: "Missing number", closedAt: "2026-01-01T00:00:00Z" },
  ]);
  const result = parseClosedPRListJson(json);
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 1);
});

// =============================================================================
// isBlockedByRecentlyClosedPR tests
// =============================================================================

Deno.test("closed_pr_blocking - isBlockedByRecentlyClosedPR blocks by title pattern (#N)", () => {
  const closedPRs = [
    {
      number: 2337,
      title: "Pipelined double-buffered I/O (#2331)",
      closedAt: "2026-04-17T11:45:09Z",
    },
  ];
  const result = isBlockedByRecentlyClosedPR(closedPRs, 2331);
  assertNotEquals(result, null);
  assertEquals(result?.number, 2337);
});

Deno.test("closed_pr_blocking - isBlockedByRecentlyClosedPR blocks by title pattern (Issue #N)", () => {
  const closedPRs = [
    {
      number: 100,
      title: "Fix the widget (Issue #42)",
      closedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const result = isBlockedByRecentlyClosedPR(closedPRs, 42);
  assertNotEquals(result, null);
  assertEquals(result?.number, 100);
});

Deno.test("closed_pr_blocking - isBlockedByRecentlyClosedPR does not match partial issue numbers", () => {
  const closedPRs = [
    { number: 50, title: "Fix (#421)", closedAt: "2026-01-01T00:00:00Z" },
    { number: 51, title: "Fix (#4210)", closedAt: "2026-01-01T00:00:00Z" },
  ];
  // Issue #42 should NOT match #421 or #4210
  const result = isBlockedByRecentlyClosedPR(closedPRs, 42);
  assertEquals(result, null);
});

Deno.test("closed_pr_blocking - isBlockedByRecentlyClosedPR returns null when no match", () => {
  const closedPRs = [
    {
      number: 10,
      title: "Unrelated fix (#99)",
      closedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const result = isBlockedByRecentlyClosedPR(closedPRs, 42);
  assertEquals(result, null);
});

Deno.test("closed_pr_blocking - isBlockedByRecentlyClosedPR returns null for empty array", () => {
  assertEquals(isBlockedByRecentlyClosedPR([], 42), null);
});

Deno.test("closed_pr_blocking - isBlockedByRecentlyClosedPR matches #N at end of title", () => {
  const closedPRs = [
    { number: 5, title: "Fix bug #42", closedAt: "2026-01-01T00:00:00Z" },
  ];
  const result = isBlockedByRecentlyClosedPR(closedPRs, 42);
  assertNotEquals(result, null);
});

// =============================================================================
// fetchRecentlyClosedPRsByUser tests
// =============================================================================

Deno.test("closed_pr_blocking - fetchRecentlyClosedPRsByUser fetches closed PRs", async () => {
  const now = new Date();
  const recentClose = new Date(now.getTime() - 30 * 60 * 1000).toISOString(); // 30 min ago
  const oldClose = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

  const mockGh = async (args: string[]): Promise<string> => {
    assertEquals(args.includes("--state"), true);
    assertEquals(args.includes("closed"), true);
    return JSON.stringify([
      { number: 10, title: "Recent fix (#42)", closedAt: recentClose },
      { number: 5, title: "Old fix (#99)", closedAt: oldClose },
    ]);
  };

  const result = await fetchRecentlyClosedPRsByUser(
    "owner/repo",
    "worker-bot",
    3600,
    undefined,
    mockGh,
  );
  // Only the recent one should be returned (within 3600s cooldown)
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 10);
});

Deno.test("closed_pr_blocking - fetchRecentlyClosedPRsByUser propagates API failure", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API failure");
  };
  await assertRejects(
    () =>
      fetchRecentlyClosedPRsByUser(
        "owner/repo",
        "worker-bot",
        3600,
        undefined,
        mockGh,
      ),
    Error,
    "API failure",
  );
});

Deno.test("closed_pr_blocking - fetchRecentlyClosedPRsByUser returns empty for no closed PRs", async () => {
  const mockGh = async (_args: string[]): Promise<string> => "[]";
  const result = await fetchRecentlyClosedPRsByUser(
    "owner/repo",
    "worker-bot",
    3600,
    undefined,
    mockGh,
  );
  assertEquals(result.length, 0);
});

// =============================================================================
// findExistingPrForIssue — closed PR detection (defence-in-depth)
// =============================================================================

Deno.test("closed_pr_blocking - findExistingPrForIssue detects recently closed PR", async () => {
  const recentClose = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
  const statesQueried: string[] = [];

  const mockGh = async (args: string[]): Promise<string> => {
    const stateIdx = args.indexOf("--state");
    const state = stateIdx >= 0 ? args[stateIdx + 1] : "";
    statesQueried.push(state!);

    if (state === "open") return "[]";
    if (state === "merged") return "[]";
    if (state === "closed") {
      return JSON.stringify([
        {
          number: 2337,
          title: "Pipelined double-buffered I/O (#2331)",
          body: "",
          url: "https://github.com/owner/repo/pull/2337",
          closedAt: recentClose,
        },
      ]);
    }
    return "[]";
  };

  const result = await findExistingPrForIssue("owner/repo", 2331, mockGh);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/2337");
  }
  // Should have checked all three states
  assertEquals(statesQueried.includes("closed"), true);
});

Deno.test("closed_pr_blocking - findExistingPrForIssue ignores old closed PR", async () => {
  const oldClose = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

  const mockGh = async (args: string[]): Promise<string> => {
    const stateIdx = args.indexOf("--state");
    const state = stateIdx >= 0 ? args[stateIdx + 1] : "";

    if (state === "closed") {
      return JSON.stringify([
        {
          number: 100,
          title: "Old fix (#42)",
          body: "",
          url: "https://github.com/owner/repo/pull/100",
          closedAt: oldClose,
        },
      ]);
    }
    return "[]";
  };

  const result = await findExistingPrForIssue("owner/repo", 42, mockGh);
  assertEquals(result.ok, false);
});

Deno.test("closed_pr_blocking - findExistingPrForIssue still prefers open PR", async () => {
  const recentClose = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const mockGh = async (args: string[]): Promise<string> => {
    const stateIdx = args.indexOf("--state");
    const state = stateIdx >= 0 ? args[stateIdx + 1] : "";

    if (state === "open") {
      return JSON.stringify([
        {
          number: 10,
          title: "Open PR (#42)",
          body: "",
          url: "https://github.com/owner/repo/pull/10",
        },
      ]);
    }
    if (state === "closed") {
      return JSON.stringify([
        {
          number: 5,
          title: "Closed PR (#42)",
          body: "",
          url: "https://github.com/owner/repo/pull/5",
          closedAt: recentClose,
        },
      ]);
    }
    return "[]";
  };

  const result = await findExistingPrForIssue("owner/repo", 42, mockGh);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Should find the open PR first (priority order: open > merged > closed)
    assertEquals(result.value, "https://github.com/owner/repo/pull/10");
  }
});
