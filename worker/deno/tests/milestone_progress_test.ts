/**
 * Tests for milestone progress notifications (Issue #1236).
 *
 * When a milestone issue is closed after PR merge, a progress comment
 * is posted showing X of Y issues complete and listing remaining issues.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMilestoneProgressComment,
  getMilestoneProgress,
  type MilestoneProgressInfo,
  postMilestoneProgressComment,
} from "../lib/milestone_progress.ts";

// ============================================================================
// buildMilestoneProgressComment
// ============================================================================

Deno.test("buildMilestoneProgressComment - shows progress fraction and milestone name", () => {
  const info: MilestoneProgressInfo = {
    milestoneTitle: "OIDC",
    closedCount: 3,
    totalCount: 5,
    remainingIssues: [
      { number: 101, title: "Add token refresh" },
      { number: 102, title: "Fix redirect URI" },
    ],
  };

  const comment = buildMilestoneProgressComment(info);
  assertStringIncludes(comment, "OIDC");
  assertStringIncludes(comment, "3 of 5");
  assertStringIncludes(comment, "#101");
  assertStringIncludes(comment, "#102");
  assertStringIncludes(comment, "Add token refresh");
  assertStringIncludes(comment, "Fix redirect URI");
});

Deno.test("buildMilestoneProgressComment - shows completion message when all issues done", () => {
  const info: MilestoneProgressInfo = {
    milestoneTitle: "v2.0",
    closedCount: 4,
    totalCount: 4,
    remainingIssues: [],
  };

  const comment = buildMilestoneProgressComment(info);
  assertStringIncludes(comment, "v2.0");
  assertStringIncludes(comment, "4 of 4");
  assertStringIncludes(comment, "complete");
});

Deno.test("buildMilestoneProgressComment - handles single remaining issue", () => {
  const info: MilestoneProgressInfo = {
    milestoneTitle: "Auth",
    closedCount: 2,
    totalCount: 3,
    remainingIssues: [
      { number: 50, title: "Final cleanup" },
    ],
  };

  const comment = buildMilestoneProgressComment(info);
  assertStringIncludes(comment, "2 of 3");
  assertStringIncludes(comment, "#50");
});

Deno.test("buildMilestoneProgressComment - handles single issue milestone", () => {
  const info: MilestoneProgressInfo = {
    milestoneTitle: "Hotfix",
    closedCount: 1,
    totalCount: 1,
    remainingIssues: [],
  };

  const comment = buildMilestoneProgressComment(info);
  assertStringIncludes(comment, "1 of 1");
  assertStringIncludes(comment, "complete");
});

// ============================================================================
// getMilestoneProgress
// ============================================================================

Deno.test("getMilestoneProgress - returns correct counts and remaining issues", async () => {
  // Issue #1786: getMilestoneProgress now reads through `fetchAllIssues`
  // for the open path, so the open-state stub returns the richer
  // `issues_all` shape (with milestone) and the helper filters locally.
  // Issue #1908: closed-batch payload tags each issue with its milestone
  // so the local filter in `fetchClosedIssuesByMilestone` can partition.
  const closedIssues = [
    { number: 10, title: "Issue A", milestone: { title: "v1.0" } },
    { number: 11, title: "Issue B", milestone: { title: "v1.0" } },
  ];
  const openIssues = [
    {
      number: 12,
      title: "Issue C",
      assignees: [],
      labels: [],
      createdAt: "2024-01-01T00:00:00Z",
      milestone: { title: "v1.0" },
      author: { login: "alice" },
      url: "u",
    },
    {
      number: 13,
      title: "Issue D",
      assignees: [],
      labels: [],
      createdAt: "2024-01-01T00:00:00Z",
      milestone: { title: "v1.0" },
      author: { login: "alice" },
      url: "u",
    },
  ];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("--state closed")) {
      return JSON.stringify(closedIssues);
    }
    if (key.includes("--state open")) {
      return JSON.stringify(openIssues);
    }
    return "[]";
  };

  const result = await getMilestoneProgress("owner/repo", "v1.0", ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.milestoneTitle, "v1.0");
    assertEquals(result.value.closedCount, 2);
    assertEquals(result.value.totalCount, 4);
    assertEquals(result.value.remainingIssues.length, 2);
    assertEquals(result.value.remainingIssues[0]!.number, 12);
    assertEquals(result.value.remainingIssues[1]!.number, 13);
  }
});

Deno.test("getMilestoneProgress - returns error on gh failure for closed issues", async () => {
  const ghFn = async (_args: string[]): Promise<string> => {
    throw new Error("API error");
  };

  const result = await getMilestoneProgress("owner/repo", "v1.0", ghFn);
  assertEquals(result.ok, false);
});

Deno.test("getMilestoneProgress - handles zero open issues (all complete)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("--state closed")) {
      return JSON.stringify([
        { number: 1, title: "Done A", milestone: { title: "Sprint1" } },
        { number: 2, title: "Done B", milestone: { title: "Sprint1" } },
      ]);
    }
    if (key.includes("--state open")) {
      return "[]";
    }
    return "[]";
  };

  const result = await getMilestoneProgress("owner/repo", "Sprint1", ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closedCount, 2);
    assertEquals(result.value.totalCount, 2);
    assertEquals(result.value.remainingIssues.length, 0);
  }
});

// ============================================================================
// postMilestoneProgressComment
// ============================================================================

Deno.test("postMilestoneProgressComment - posts comment on the closed issue", async () => {
  const postedComments: { issueNumber: string; body: string }[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Issue A", milestone: { title: "v1.0" } },
        { number: 11, title: "Issue B", milestone: { title: "v1.0" } },
      ]);
    }
    if (key.includes("--state open")) {
      return JSON.stringify([
        {
          number: 12,
          title: "Issue C",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "v1.0" },
          author: { login: "alice" },
          url: "u",
        },
      ]);
    }
    if (key.includes("issue comment")) {
      // Extract issue number and body from args
      const issueIdx = args.indexOf("comment") + 1;
      const bodyIdx = args.indexOf("--body") + 1;
      postedComments.push({
        issueNumber: args[issueIdx]!,
        body: args[bodyIdx]!,
      });
      return "";
    }
    return "[]";
  };

  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  const result = await postMilestoneProgressComment(
    "owner/repo",
    11,
    "v1.0",
    ghFn,
    log,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, true);
  }
  assertEquals(postedComments.length, 1);
  assertEquals(postedComments[0]!.issueNumber, "11");
  assertStringIncludes(postedComments[0]!.body, "2 of 3");
  assertStringIncludes(postedComments[0]!.body, "#12");
});

Deno.test("postMilestoneProgressComment - returns false when progress query fails", async () => {
  const ghFn = async (_args: string[]): Promise<string> => {
    throw new Error("API error");
  };

  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  const result = await postMilestoneProgressComment(
    "owner/repo",
    11,
    "v1.0",
    ghFn,
    log,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("postMilestoneProgressComment - handles comment post failure gracefully", async () => {
  let commentAttempted = false;

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("--state closed")) {
      return JSON.stringify([{
        number: 10,
        title: "A",
        milestone: { title: "Sprint1" },
      }]);
    }
    if (key.includes("--state open")) {
      return "[]";
    }
    if (key.includes("issue comment")) {
      commentAttempted = true;
      throw new Error("Comment failed");
    }
    return "[]";
  };

  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  const result = await postMilestoneProgressComment(
    "owner/repo",
    10,
    "Sprint1",
    ghFn,
    log,
  );

  assertEquals(commentAttempted, true);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("postMilestoneProgressComment - logs progress information", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("--state closed")) {
      return JSON.stringify([{
        number: 5,
        title: "X",
        milestone: { title: "Alpha" },
      }]);
    }
    if (key.includes("--state open")) {
      return JSON.stringify([
        {
          number: 6,
          title: "Y",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "Alpha" },
          author: { login: "alice" },
          url: "u",
        },
      ]);
    }
    if (key.includes("issue comment")) {
      return "";
    }
    return "[]";
  };

  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  await postMilestoneProgressComment("owner/repo", 5, "Alpha", ghFn, log);

  const hasProgressLog = logs.some((l) =>
    l.includes("Alpha") && l.includes("1 of 2")
  );
  assertEquals(hasProgressLog, true);
});
