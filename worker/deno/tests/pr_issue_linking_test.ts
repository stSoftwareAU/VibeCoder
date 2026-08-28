/**
 * Tests for pr_issue_linking.ts — PR-to-issue linking (Issue #915).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { alwaysLanded } from "./fixtures/merge_landing_stub.ts";
import {
  closeDuplicatePrs,
  closeIssuesForMergedPrs,
  findClosedUnmergedPrForBranch,
  findExistingPrForBranch,
  findExistingPrForIssue,
  linkPrToIssue,
  postIssueLinkWithRetry,
  prTitleMatchesIssue,
  reopenPr,
  updatePrLabels,
  verifyIssueLinkComment,
} from "../lib/pr_issue_linking.ts";
import { IssueCache } from "../lib/issue_cache.ts";

// --- linkPrToIssue ---

Deno.test("pr_issue_linking - linkPrToIssue posts comment on issue", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  const result = await linkPrToIssue(
    "owner/repo",
    42,
    "https://github.com/owner/repo/pull/1",
    fn,
  );
  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]![0], "issue");
  assertEquals(calls[0]![1], "comment");
  assertEquals(calls[0]![2], "42");
});

Deno.test("pr_issue_linking - linkPrToIssue returns error on failure", async () => {
  const fn = async (): Promise<string> => {
    throw new Error("API failure");
  };
  const result = await linkPrToIssue(
    "owner/repo",
    42,
    "https://example.com/pull/1",
    fn,
  );
  assertEquals(result.ok, false);
});

Deno.test("pr_issue_linking - linkPrToIssue rejects non-URL prUrl (error message)", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  // Pass an error message instead of a URL — must not post a comment
  const result = await linkPrToIssue(
    "owner/repo",
    42,
    "No open PRs found in owner/repo",
    fn,
  );
  assertEquals(result.ok, false);
  assertEquals(calls.length, 0); // Must NOT post any comment
});

Deno.test("pr_issue_linking - linkPrToIssue rejects empty prUrl", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  const result = await linkPrToIssue("owner/repo", 42, "", fn);
  assertEquals(result.ok, false);
  assertEquals(calls.length, 0);
});

// --- verifyIssueLinkComment ---

Deno.test("pr_issue_linking - verifyIssueLinkComment returns true when comment exists", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      "Pull request https://github.com/owner/repo/pull/1 has been created",
    ]);
  };
  const result = await verifyIssueLinkComment(
    "owner/repo",
    42,
    "https://github.com/owner/repo/pull/1",
    fn,
  );
  assertEquals(result, true);
});

Deno.test("pr_issue_linking - verifyIssueLinkComment returns false when no matching comment", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify(["Some unrelated comment"]);
  };
  const result = await verifyIssueLinkComment(
    "owner/repo",
    42,
    "https://github.com/owner/repo/pull/1",
    fn,
  );
  assertEquals(result, false);
});

// --- postIssueLinkWithRetry ---

Deno.test("pr_issue_linking - postIssueLinkWithRetry succeeds on first try", async () => {
  let callCount = 0;
  const fn = async (args: string[]): Promise<string> => {
    callCount++;
    // verifyIssueLinkComment call returns no match
    if (args[0] === "api") return "[]";
    // linkPrToIssue call succeeds
    return "";
  };
  const result = await postIssueLinkWithRetry(
    "owner/repo",
    42,
    "https://example.com/pull/1",
    3,
    fn,
  );
  assertEquals(result.ok, true);
});

Deno.test("pr_issue_linking - postIssueLinkWithRetry skips when comment already exists", async () => {
  let linkCalls = 0;
  const fn = async (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      return '["Pull request https://example.com/pull/1 has been created"]';
    }
    linkCalls++;
    return "";
  };
  const result = await postIssueLinkWithRetry(
    "owner/repo",
    42,
    "https://example.com/pull/1",
    3,
    fn,
  );
  assertEquals(result.ok, true);
  assertEquals(linkCalls, 0); // Should not have attempted to post
});

// --- findExistingPrForBranch ---

Deno.test("pr_issue_linking - findExistingPrForBranch returns URL when PR exists", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return "https://github.com/owner/repo/pull/42\n";
  };
  const result = await findExistingPrForBranch("owner/repo", "fix-branch", fn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/42");
  }
});

Deno.test("pr_issue_linking - findExistingPrForBranch returns error when no PR", async () => {
  const fn = async (_args: string[]): Promise<string> => "\n";
  const result = await findExistingPrForBranch("owner/repo", "nonexistent", fn);
  assertEquals(result.ok, false);
});

Deno.test("pr_issue_linking - findExistingPrForBranch returns error for empty branch", async () => {
  const fn = async (_args: string[]): Promise<string> => "";
  const result = await findExistingPrForBranch("owner/repo", "", fn);
  assertEquals(result.ok, false);
});

// --- findClosedUnmergedPrForBranch (Issue #3152) ---

Deno.test("pr_issue_linking - findClosedUnmergedPrForBranch returns closed-unmerged PR URL", async () => {
  const fn = async (_args: string[]): Promise<string> =>
    JSON.stringify([
      {
        number: 7,
        title: "Fix (#1)",
        mergedAt: null,
        closedAt: "2026-07-01T00:00:00Z",
      },
    ]);
  const result = await findClosedUnmergedPrForBranch(
    "owner/repo",
    "issue-1-fix",
    fn,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/7");
  }
});

Deno.test("pr_issue_linking - findClosedUnmergedPrForBranch skips merged PRs", async () => {
  const fn = async (_args: string[]): Promise<string> =>
    JSON.stringify([
      {
        number: 5,
        title: "Fix (#1)",
        mergedAt: "2026-07-01T00:00:00Z",
        closedAt: "2026-07-01T00:00:00Z",
      },
    ]);
  const result = await findClosedUnmergedPrForBranch(
    "owner/repo",
    "issue-1-fix",
    fn,
  );
  assertEquals(result.ok, false);
});

Deno.test("pr_issue_linking - findClosedUnmergedPrForBranch picks most recent when several", async () => {
  const fn = async (_args: string[]): Promise<string> =>
    JSON.stringify([
      {
        number: 3,
        title: "Fix (#1)",
        mergedAt: null,
        closedAt: "2026-06-01T00:00:00Z",
      },
      {
        number: 9,
        title: "Fix (#1)",
        mergedAt: null,
        closedAt: "2026-06-30T00:00:00Z",
      },
    ]);
  const result = await findClosedUnmergedPrForBranch(
    "owner/repo",
    "issue-1-fix",
    fn,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/9");
  }
});

Deno.test("pr_issue_linking - findClosedUnmergedPrForBranch returns error for empty branch", async () => {
  let called = false;
  const fn = async (_args: string[]): Promise<string> => {
    called = true;
    return "[]";
  };
  const result = await findClosedUnmergedPrForBranch("owner/repo", "", fn);
  assertEquals(result.ok, false);
  assertEquals(called, false);
});

Deno.test("pr_issue_linking - findClosedUnmergedPrForBranch returns error when none", async () => {
  const fn = async (_args: string[]): Promise<string> => "[]";
  const result = await findClosedUnmergedPrForBranch(
    "owner/repo",
    "issue-1-fix",
    fn,
  );
  assertEquals(result.ok, false);
});

// --- reopenPr (Issue #3152) ---

Deno.test("pr_issue_linking - reopenPr runs gh pr reopen", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  const result = await reopenPr("owner/repo", 7, fn);
  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.slice(0, 3), ["pr", "reopen", "7"]);
  assertEquals(calls[0]!.includes("owner/repo"), true);
});

Deno.test("pr_issue_linking - reopenPr rejects invalid PR number", async () => {
  let called = false;
  const fn = async (_args: string[]): Promise<string> => {
    called = true;
    return "";
  };
  const result = await reopenPr("owner/repo", 0, fn);
  assertEquals(result.ok, false);
  assertEquals(called, false);
});

Deno.test("pr_issue_linking - reopenPr surfaces gh failure as error", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    throw new Error("cannot reopen a merged pull request");
  };
  const result = await reopenPr("owner/repo", 5, fn);
  assertEquals(result.ok, false);
});

// --- findExistingPrForIssue ---

Deno.test("pr_issue_linking - findExistingPrForIssue finds by title pattern", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        number: 1,
        title: "Fix: Bug fix (#42)",
        body: "",
        url: "https://github.com/owner/repo/pull/1",
      },
    ]);
  };
  const result = await findExistingPrForIssue("owner/repo", 42, fn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/1");
  }
});

Deno.test("pr_issue_linking - findExistingPrForIssue finds human-style '(Issue #N)' title", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        number: 7,
        title: "Escape literal Liquid tags in pr-summary docs (Issue #1574)",
        body: "",
        url: "https://github.com/owner/repo/pull/7",
      },
    ]);
  };
  const result = await findExistingPrForIssue("owner/repo", 1574, fn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/7");
  }
});

Deno.test("pr_issue_linking - findExistingPrForIssue finds lowercase 'issue #N' title", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        number: 8,
        title: "Some fix (issue #99)",
        body: "",
        url: "https://github.com/owner/repo/pull/8",
      },
    ]);
  };
  const result = await findExistingPrForIssue("owner/repo", 99, fn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/8");
  }
});

Deno.test("pr_issue_linking - findExistingPrForIssue does NOT match digit-prefix variants", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        number: 9,
        title: "Cross-issue ref (#142)",
        body: "",
        url: "https://github.com/owner/repo/pull/9",
      },
    ]);
  };
  // Looking for #42 — must not match (#142)
  const result = await findExistingPrForIssue("owner/repo", 42, fn);
  assertEquals(result.ok, false);
});

Deno.test("pr_issue_linking - findExistingPrForIssue finds bracket-style '[#N]' title (Issue #106)", async () => {
  // PR GRQ-validation#844 was titled "[#836] …"; the paren-only pattern missed
  // it, so the existing-PR backstop failed to recognise the completed run.
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        number: 844,
        title: "[#836] Forward the native memory budget to the Rust cache",
        body: "",
        url: "https://github.com/owner/repo/pull/844",
      },
    ]);
  };
  const result = await findExistingPrForIssue("owner/repo", 836, fn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/844");
  }
});

Deno.test("pr_issue_linking - findExistingPrForIssue finds '[Issue #N]' bracket title (Issue #106)", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        number: 10,
        title: "Some fix [Issue #77]",
        body: "",
        url: "https://github.com/owner/repo/pull/10",
      },
    ]);
  };
  const result = await findExistingPrForIssue("owner/repo", 77, fn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/10");
  }
});

Deno.test("pr_issue_linking - the bracket pattern still rejects digit-prefix variants (Issue #106)", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        number: 11,
        title: "Cross ref [#142]",
        body: "",
        url: "https://github.com/owner/repo/pull/11",
      },
    ]);
  };
  // Looking for #42 — must not match [#142]
  const result = await findExistingPrForIssue("owner/repo", 42, fn);
  assertEquals(result.ok, false);
});

Deno.test("pr_issue_linking - findExistingPrForIssue finds by body marker", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        number: 2,
        title: "Different title",
        body: "Some text <!-- vibe-worker-issue-42 --> more text",
        url: "https://github.com/owner/repo/pull/2",
      },
    ]);
  };
  const result = await findExistingPrForIssue("owner/repo", 42, fn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/2");
  }
});

Deno.test("pr_issue_linking - findExistingPrForIssue finds merged PR for issue", async () => {
  const fn = async (args: string[]): Promise<string> => {
    const stateIdx = args.indexOf("--state");
    const state = stateIdx >= 0 ? args[stateIdx + 1] : "open";
    if (state === "open") {
      return "[]";
    }
    if (state === "merged") {
      return JSON.stringify([
        {
          number: 99,
          title: "Fix: Already done (#42)",
          body: "",
          url: "https://github.com/owner/repo/pull/99",
        },
      ]);
    }
    return "[]";
  };
  const result = await findExistingPrForIssue("owner/repo", 42, fn);
  assertEquals(result.ok, true);
  // The observable outcome is the selected merged-PR URL. We deliberately
  // do NOT assert the number of gh calls (Issue #2690): that would pin the
  // implementation to issuing two separate state-scoped queries. Folding
  // `--state open` and `--state merged` into a single `--state all` fetch
  // would return the identical URL and must keep passing. The sibling
  // "prefers open PR over merged" test already pins the WHAT — which PR is
  // selected — without constraining how many queries are issued.
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/99");
  }
});

Deno.test("pr_issue_linking - findExistingPrForIssue prefers open PR over merged", async () => {
  const fn = async (args: string[]): Promise<string> => {
    const stateIdx = args.indexOf("--state");
    const state = stateIdx >= 0 ? args[stateIdx + 1] : "open";
    if (state === "open") {
      return JSON.stringify([
        {
          number: 10,
          title: "Fix: Open PR (#42)",
          body: "",
          url: "https://github.com/owner/repo/pull/10",
        },
      ]);
    }
    if (state === "merged") {
      return JSON.stringify([
        {
          number: 5,
          title: "Fix: Merged PR (#42)",
          body: "",
          url: "https://github.com/owner/repo/pull/5",
        },
      ]);
    }
    return "[]";
  };
  const result = await findExistingPrForIssue("owner/repo", 42, fn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://github.com/owner/repo/pull/10");
  }
});

Deno.test("pr_issue_linking - findExistingPrForIssue does not match partial issue numbers", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        number: 1,
        title: "Fix (#421)",
        body: "vibe-worker-issue-421",
        url: "https://example.com/pull/1",
      },
    ]);
  };
  const result = await findExistingPrForIssue("owner/repo", 42, fn);
  assertEquals(result.ok, false);
});

// --- closeDuplicatePrs ---

Deno.test("pr_issue_linking - closeDuplicatePrs returns 0 for invalid keepPrUrl (error message)", async () => {
  const closedPrs: string[] = [];
  const fn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      return "10|https://github.com/owner/repo/pull/10\n";
    }
    if (args[0] === "pr" && args[1] === "close") {
      closedPrs.push(args[2]!);
    }
    return "";
  };
  // Pass an error message instead of a URL — this is the bug from Issue #921
  const count = await closeDuplicatePrs(
    "owner/repo",
    "fix-branch",
    "No open PR found for issue #921",
    fn,
  );
  assertEquals(count, 0);
  assertEquals(closedPrs.length, 0); // Must NOT close any PRs
});

Deno.test("pr_issue_linking - closeDuplicatePrs returns 0 for non-URL keepPrUrl", async () => {
  const closedPrs: string[] = [];
  const fn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      return "5|https://github.com/owner/repo/pull/5\n";
    }
    if (args[0] === "pr" && args[1] === "close") {
      closedPrs.push(args[2]!);
    }
    return "";
  };
  const count = await closeDuplicatePrs(
    "owner/repo",
    "fix-branch",
    "No open PRs found in owner/repo",
    fn,
  );
  assertEquals(count, 0);
  assertEquals(closedPrs.length, 0);
});

Deno.test("pr_issue_linking - closeDuplicatePrs closes duplicates and keeps specified PR", async () => {
  const closedPrs: string[] = [];
  const fn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      return "10|https://github.com/owner/repo/pull/10\n42|https://github.com/owner/repo/pull/42\n";
    }
    if (args[0] === "pr" && args[1] === "close") {
      closedPrs.push(args[2]!);
    }
    return "";
  };
  const count = await closeDuplicatePrs(
    "owner/repo",
    "fix-branch",
    "https://github.com/owner/repo/pull/42",
    fn,
  );
  assertEquals(count, 1);
  assertEquals(closedPrs.includes("10"), true);
  assertEquals(closedPrs.includes("42"), false);
});

Deno.test("pr_issue_linking - closeDuplicatePrs returns 0 for empty branch", async () => {
  const fn = async (_args: string[]): Promise<string> => "";
  const count = await closeDuplicatePrs(
    "owner/repo",
    "",
    "https://example.com/pull/1",
    fn,
  );
  assertEquals(count, 0);
});

// --- closeIssuesForMergedPrs ---

// Issue #1787: closeIssuesForMergedPrs now reads through
// `fetchMergedPRsByUser`, so the mocked `pr list` response must be the
// JSON shape `[{ number, title, headRefName }, ...]`.
const MOCK_MERGED_PRS = JSON.stringify([
  {
    number: 1,
    title: "Fix: Bug (#42)",
    headRefName: "issue-42",
    mergedAt: "2026-01-02T00:00:00Z",
  },
]);

Deno.test("pr_issue_linking - closeIssuesForMergedPrs closes open issues", async () => {
  const closedIssues: string[] = [];
  const fn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      return MOCK_MERGED_PRS;
    }
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({
        state: "OPEN",
        labels: [],
        createdAt: "2026-01-01T00:00:00Z",
      });
    }
    if (args[0] === "issue" && args[1] === "close") {
      closedIssues.push(args[2]!);
    }
    return "";
  };
  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );
  assertEquals(count, 1);
  assertEquals(closedIssues[0], "42");
});

Deno.test("pr_issue_linking - closeIssuesForMergedPrs skips closed issues", async () => {
  const fn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      return MOCK_MERGED_PRS;
    }
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ state: "CLOSED", labels: [] });
    }
    return "";
  };
  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );
  assertEquals(count, 0);
});

Deno.test("pr_issue_linking - closeIssuesForMergedPrs skips planning issues (Issue #1193)", async () => {
  const closedIssues: string[] = [];
  const fn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      return MOCK_MERGED_PRS;
    }
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({
        state: "OPEN",
        labels: [{ name: "planning" }],
        createdAt: "2026-01-01T00:00:00Z",
      });
    }
    if (args[0] === "issue" && args[1] === "close") {
      closedIssues.push(args[2]!);
    }
    return "";
  };
  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );
  assertEquals(count, 0);
  assertEquals(closedIssues.length, 0);
});

Deno.test("pr_issue_linking - closeIssuesForMergedPrs closes non-planning issues normally (Issue #1193)", async () => {
  const closedIssues: string[] = [];
  const fn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      return MOCK_MERGED_PRS;
    }
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({
        state: "OPEN",
        labels: [{ name: "enhancement" }],
        createdAt: "2026-01-01T00:00:00Z",
      });
    }
    if (args[0] === "issue" && args[1] === "close") {
      closedIssues.push(args[2]!);
    }
    return "";
  };
  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );
  assertEquals(count, 1);
  assertEquals(closedIssues[0], "42");
});

// --- updatePrLabels (Issue #1189) ---

Deno.test("pr_issue_linking - updatePrLabels adds labels to PR", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  const result = await updatePrLabels(
    "owner/repo",
    5,
    ["bug", "priority-high"],
    fn,
  );
  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]![0], "pr");
  assertEquals(calls[0]![1], "edit");
  assertEquals(calls[0]![2], "5");
  assertEquals(calls[0]!.includes("--add-label"), true);
  assertEquals(calls[0]!.includes("bug"), true);
  assertEquals(calls[0]!.includes("priority-high"), true);
});

Deno.test("pr_issue_linking - updatePrLabels returns ok for empty labels", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  const result = await updatePrLabels("owner/repo", 5, [], fn);
  assertEquals(result.ok, true);
  assertEquals(calls.length, 0, "Should not call gh for empty labels");
});

Deno.test("pr_issue_linking - updatePrLabels handles API errors gracefully", async () => {
  const fn = async (_args: string[]): Promise<string> => {
    throw new Error("API rate limit exceeded");
  };
  const result = await updatePrLabels("owner/repo", 5, ["bug"], fn);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("Failed to update labels"),
      true,
    );
  }
});

// --- updatePrLabels workflow-label filtering (Issue #1711) ---

Deno.test("pr_issue_linking - updatePrLabels drops workflow labels (Issue #1711)", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  // Mix workflow labels with content labels — only content labels should reach gh.
  const result = await updatePrLabels(
    "owner/repo",
    5,
    ["work-on", "top-priority", "planning", "bug", "priority-high"],
    fn,
  );
  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
  const args = calls[0]!;
  assertEquals(
    args.includes("bug"),
    true,
    "content label 'bug' should be applied",
  );
  assertEquals(
    args.includes("priority-high"),
    true,
    "content label 'priority-high' should be applied",
  );
  assertEquals(
    args.includes("work-on"),
    false,
    "workflow label 'work-on' must not reach the PR",
  );
  assertEquals(
    args.includes("top-priority"),
    false,
    "workflow label 'top-priority' must not reach the PR",
  );
  assertEquals(
    args.includes("planning"),
    false,
    "workflow label 'planning' must not reach the PR",
  );
});

Deno.test("pr_issue_linking - updatePrLabels skips gh when only workflow labels supplied (Issue #1711)", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  const result = await updatePrLabels(
    "owner/repo",
    5,
    ["work-on", "help wanted", "needs-human", "claude", "top-priority"],
    fn,
  );
  assertEquals(result.ok, true);
  assertEquals(
    calls.length,
    0,
    "no gh call should be made when every label is a workflow label",
  );
});

// =============================================================================
// Issue #1787: cache-routed paths
// =============================================================================

async function makeTempCache(): Promise<
  { cache: IssueCache; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix: "pr-link-cache-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

Deno.test("pr_issue_linking - findExistingPrForBranch hits cache on second call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const fn = async (_args: string[]): Promise<string> => {
      callCount++;
      return JSON.stringify([
        {
          number: 1,
          title: "Fix",
          baseRefName: "main",
          headRefName: "fix-branch",
          body: "",
          url: "https://github.com/o/r/pull/1",
        },
      ]);
    };
    const a = await findExistingPrForBranch("o/r", "fix-branch", fn, cache);
    const b = await findExistingPrForBranch("o/r", "fix-branch", fn, cache);
    assertEquals(a.ok, true);
    assertEquals(b.ok, true);
    assertEquals(callCount, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("pr_issue_linking - findExistingPrForBranch returns error when cache has no head match", async () => {
  // Issue #1796: refactored to use `fetchPRsByBranch`, which delegates
  // the `--head` filter to gh server-side. The mock now returns an
  // empty list to simulate "no PR for this branch" — the previous
  // fixture, which returned a PR with a non-matching headRefName, no
  // longer makes sense for the narrow per-branch helper.
  const { cache, cleanup } = await makeTempCache();
  try {
    const fn = async (_args: string[]): Promise<string> => "[]";
    const result = await findExistingPrForBranch(
      "o/r",
      "fix-branch",
      fn,
      cache,
    );
    assertEquals(result.ok, false);
  } finally {
    await cleanup();
  }
});

Deno.test("pr_issue_linking - closeDuplicatePrs invalidates cache after closing", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const calls: string[][] = [];
    const fn = async (args: string[]): Promise<string> => {
      calls.push(args);
      const argsStr = args.join(" ");
      // fetchAllOpenPRs lookup
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 100,
            title: "Keep",
            baseRefName: "main",
            headRefName: "fix-branch",
            body: "",
            url: "https://github.com/o/r/pull/100",
          },
          {
            number: 101,
            title: "Dup",
            baseRefName: "main",
            headRefName: "fix-branch",
            body: "",
            url: "https://github.com/o/r/pull/101",
          },
        ]);
      }
      // pr close
      if (argsStr.startsWith("pr close")) return "";
      return "";
    };

    const closed = await closeDuplicatePrs(
      "o/r",
      "fix-branch",
      "https://github.com/o/r/pull/100",
      fn,
      cache,
    );
    assertEquals(closed, 1);

    // Issue #1796: cache key migrated from the broad `prs_open_all`
    // to the narrow `prs_branch_open_<branch>`. Verify the per-branch
    // entry was invalidated after the close.
    const cached = await cache.read<unknown[]>(
      "o/r",
      "prs_branch_open_fix-branch",
    );
    assertEquals(cached, null);
  } finally {
    await cleanup();
  }
});

Deno.test("pr_issue_linking - closeIssuesForMergedPrs invalidates issues_all on closure", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    // Pre-populate the issues_all cache to verify invalidation.
    await cache.write("o/r", "issues_all", [{ number: 1 }]);

    const fn = async (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 5,
            title: "Fix (#42)",
            headRefName: "issue-42",
            mergedAt: "2026-01-02T00:00:00Z",
          },
        ]);
      }
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({
          state: "OPEN",
          labels: [],
          createdAt: "2026-01-01T00:00:00Z",
        });
      }
      // issue close
      return "";
    };

    const count = await closeIssuesForMergedPrs(
      ["o/r"],
      "bot",
      fn,
      "planning",
      cache,
      { verifyMergeLandedFn: alwaysLanded },
    );
    assertEquals(count, 1);

    const cached = await cache.read<unknown>("o/r", "issues_all");
    assertEquals(
      cached,
      null,
      "issues_all cache must be invalidated after closure",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("pr_issue_linking - closeIssuesForMergedPrs reuses prs_merged cache across repos", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let mergedListCalls = 0;
    const fn = async (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") {
        mergedListCalls++;
        return JSON.stringify([]);
      }
      return "";
    };
    await closeIssuesForMergedPrs(["o/r"], "bot", fn, "planning", cache, {
      verifyMergeLandedFn: alwaysLanded,
    });
    await closeIssuesForMergedPrs(["o/r"], "bot", fn, "planning", cache, {
      verifyMergeLandedFn: alwaysLanded,
    });
    assertEquals(
      mergedListCalls,
      1,
      "second invocation should be served from cache",
    );
  } finally {
    await cleanup();
  }
});

// --- closeIssuesForMergedPrs reconcile watermark (Issue #4256) ---

/** Call-recording gh mock for the watermark tests. */
function createRecordingGh(handlers: {
  prs: string;
  view?: (issueNumber: string) => string | Error;
}) {
  const calls: string[][] = [];
  const closed: string[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(handlers.prs);
    }
    if (args[0] === "issue" && args[1] === "view") {
      const answer = handlers.view?.(args[2]!) ??
        JSON.stringify({
          state: "OPEN",
          labels: [],
          createdAt: "2026-01-01T00:00:00Z",
        });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    }
    if (args[0] === "issue" && args[1] === "close") {
      closed.push(args[2]!);
    }
    return Promise.resolve("");
  };
  return { fn, calls, closed };
}

Deno.test("pr_issue_linking - the reconcile watermark suppresses issue views on the next cycle (Issue #4256)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const watermarkPath = `${tempDir}/merged_reconcile_watermarks.json`;
    const prs = JSON.stringify([
      {
        number: 5,
        title: "Fix: Bug (#42)",
        headRefName: "issue-42",
        mergedAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const first = createRecordingGh({ prs });
    const c1 = await closeIssuesForMergedPrs(
      ["owner/repo"],
      "bot-user",
      first.fn,
      "planning",
      undefined,
      { verifyMergeLandedFn: alwaysLanded, watermarkPath },
    );
    assertEquals(c1, 1);
    assertEquals(first.closed, ["42"]);

    // Same 30-PR window next cycle: PR 5 is at the watermark, so the
    // only call is the merged-PR list itself — no issue views.
    const second = createRecordingGh({ prs });
    const c2 = await closeIssuesForMergedPrs(
      ["owner/repo"],
      "bot-user",
      second.fn,
      "planning",
      undefined,
      { verifyMergeLandedFn: alwaysLanded, watermarkPath },
    );
    assertEquals(c2, 0);
    const viewCalls = second.calls.filter((c) =>
      c[0] === "issue" && c[1] === "view"
    );
    assertEquals(
      viewCalls.length,
      0,
      "already-reconciled PRs must not be re-viewed",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("pr_issue_linking - a failed issue view holds the watermark back for retry (Issue #4256)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const watermarkPath = `${tempDir}/merged_reconcile_watermarks.json`;
    const prs = JSON.stringify([
      {
        number: 7,
        title: "Fix: Bug (#77)",
        headRefName: "issue-77",
        mergedAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const failing = createRecordingGh({
      prs,
      view: () => new Error("GraphQL: API rate limit already exceeded"),
    });
    const c1 = await closeIssuesForMergedPrs(
      ["owner/repo"],
      "bot-user",
      failing.fn,
      "planning",
      undefined,
      { verifyMergeLandedFn: alwaysLanded, watermarkPath },
    );
    assertEquals(c1, 0);
    const marks = JSON.parse(await Deno.readTextFile(watermarkPath));
    assertEquals(
      marks["owner/repo"],
      6,
      "a failed reconciliation must stay below the watermark",
    );

    // Next cycle the view succeeds and the issue is closed.
    const good = createRecordingGh({ prs });
    const c2 = await closeIssuesForMergedPrs(
      ["owner/repo"],
      "bot-user",
      good.fn,
      "planning",
      undefined,
      { verifyMergeLandedFn: alwaysLanded, watermarkPath },
    );
    assertEquals(c2, 1);
    assertEquals(good.closed, ["77"]);
    const after = JSON.parse(await Deno.readTextFile(watermarkPath));
    assertEquals(after["owner/repo"], 7);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("pr_issue_linking - a planning-label skip holds the watermark back (Issue #4256)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const watermarkPath = `${tempDir}/merged_reconcile_watermarks.json`;
    const prs = JSON.stringify([
      {
        number: 9,
        title: "Plan: Feature (#90)",
        headRefName: "issue-90",
        mergedAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const planning = createRecordingGh({
      prs,
      view: () =>
        JSON.stringify({
          state: "OPEN",
          labels: [{ name: "planning" }],
          createdAt: "2026-01-01T00:00:00Z",
        }),
    });
    const c1 = await closeIssuesForMergedPrs(
      ["owner/repo"],
      "bot-user",
      planning.fn,
      "planning",
      undefined,
      { verifyMergeLandedFn: alwaysLanded, watermarkPath },
    );
    assertEquals(c1, 0);
    const marks = JSON.parse(await Deno.readTextFile(watermarkPath));
    assertEquals(
      marks["owner/repo"],
      8,
      "a planning issue stays deliberately open — keep re-checking it " +
        "until the label comes off or the issue closes",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("pr_issue_linking - prTitleMatchesIssue accepts paren and bracket styles, rejects prefixes (Issue #106)", () => {
  // Accepted delimiter styles.
  for (
    const title of [
      "Fix (#42)",
      "Fix (Issue #42)",
      "Fix (issue #42)",
      "[#42] Fix",
      "[Issue #42] Fix",
      "[issue #42] Fix",
    ]
  ) {
    assertEquals(prTitleMatchesIssue(title, 42), true, title);
  }
  // Digit-prefix / suffix variants must NOT match (closing delimiter guards it).
  for (
    const title of ["Ref (#142)", "Ref [#142]", "Ref (#420)", "Ref [#420]"]
  ) {
    assertEquals(prTitleMatchesIssue(title, 42), false, title);
  }
});
