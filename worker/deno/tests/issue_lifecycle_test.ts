/**
 * Tests for issue_lifecycle.ts — self-healing lifecycle helpers.
 *
 * Issue #966: Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  commitMessagesReferenceIssue,
  ensureIssueClosedIfPrMerged,
  handlePrClosedAfterCreation,
  hasIssueChangeLandedOnBranch,
  unassignAfterPrCreated,
} from "../lib/issue_lifecycle.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A merged PR whose merge commit sits on the default branch (Issue #4396). */
const MERGED_ON_DEFAULT = {
  state: "MERGED",
  mergeCommit: { oid: "abc123" },
  baseRefName: "Develop",
};

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

// ============================================================================
// ensureIssueClosedIfPrMerged
// ============================================================================

Deno.test("ensureIssueClosedIfPrMerged - closes open issue when PR is merged", async () => {
  let closedIssue = false;
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify(MERGED_ON_DEFAULT));
    }
    if (args.join(" ").includes(".default_branch")) {
      return Promise.resolve("Develop\n");
    }
    if (args.join(" ").includes("/compare/")) {
      return Promise.resolve(JSON.stringify({ status: "behind" }));
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "OPEN" }));
    }
    if (args.includes("issue") && args.includes("close")) {
      closedIssue = true;
    }
    return Promise.resolve("");
  };

  const result = await ensureIssueClosedIfPrMerged(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closed, true);
    assertEquals(closedIssue, true);
  }
});

Deno.test("ensureIssueClosedIfPrMerged - closeCommentFn names the merge commit (Issue #504)", async () => {
  let closeComment = "";
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify(MERGED_ON_DEFAULT));
    }
    if (args.join(" ").includes(".default_branch")) {
      return Promise.resolve("Develop\n");
    }
    if (args.join(" ").includes("/compare/")) {
      return Promise.resolve(JSON.stringify({ status: "behind" }));
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "OPEN" }));
    }
    if (args.includes("issue") && args.includes("close")) {
      closeComment = args[args.indexOf("--comment") + 1] ?? "";
    }
    return Promise.resolve("");
  };

  const result = await ensureIssueClosedIfPrMerged(
    "org/repo",
    42,
    100,
    "testbot",
    {
      ghCommandFn: mockGh,
      logger: makeLogger(),
      closeCommentFn: ({ prNumber, landing }) =>
        `swept: PR #${prNumber} at ${landing.mergeCommit} via ${landing.via}`,
    },
  );

  assertEquals(result.ok, true);
  assertEquals(closeComment, "swept: PR #100 at abc123 via default-branch");
});

Deno.test("ensureIssueClosedIfPrMerged - no action when PR not merged", async () => {
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "OPEN" }));
    }
    return Promise.resolve("");
  };

  const result = await ensureIssueClosedIfPrMerged(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closed, false);
  }
});

Deno.test("ensureIssueClosedIfPrMerged - no action when issue already closed", async () => {
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify(MERGED_ON_DEFAULT));
    }
    if (args.join(" ").includes(".default_branch")) {
      return Promise.resolve("Develop\n");
    }
    if (args.join(" ").includes("/compare/")) {
      return Promise.resolve(JSON.stringify({ status: "behind" }));
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "CLOSED" }));
    }
    return Promise.resolve("");
  };

  const result = await ensureIssueClosedIfPrMerged(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closed, false);
  }
});

Deno.test("ensureIssueClosedIfPrMerged - posts milestone progress comment when issue has milestone", async () => {
  let progressCommentPosted = false;
  let progressCommentBody = "";

  const mockGh = (args: string[]) => {
    const key = args.join(" ");
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify(MERGED_ON_DEFAULT));
    }
    if (args.join(" ").includes(".default_branch")) {
      return Promise.resolve("Develop\n");
    }
    if (args.join(" ").includes("/compare/")) {
      return Promise.resolve(JSON.stringify({ status: "behind" }));
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({
        state: "OPEN",
        milestone: { title: "OIDC" },
      }));
    }
    if (args.includes("issue") && args.includes("close")) {
      return Promise.resolve("");
    }
    // Milestone progress queries — Issue #1786: open state now reads
    // through `fetchAllIssues` (no `--milestone` flag) and filters
    // locally by milestone title, so the stub returns the richer shape.
    // Issue #1908: closed batch is fetched without --milestone; payload
    // tags each issue with its milestone for local filtering.
    if (key.includes("issue list") && key.includes("--state closed")) {
      return Promise.resolve(JSON.stringify([
        { number: 42, title: "Done issue", milestone: { title: "OIDC" } },
        { number: 43, title: "Another done", milestone: { title: "OIDC" } },
      ]));
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 44,
          title: "Still open",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "OIDC" },
          author: { login: "alice" },
          url: "u",
        },
      ]));
    }
    // Progress comment post
    if (args.includes("issue") && args.includes("comment")) {
      progressCommentPosted = true;
      const bodyIdx = args.indexOf("--body") + 1;
      progressCommentBody = args[bodyIdx] ?? "";
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };

  const result = await ensureIssueClosedIfPrMerged(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closed, true);
  }
  assertEquals(progressCommentPosted, true);
  assertEquals(progressCommentBody.includes("OIDC"), true);
  assertEquals(progressCommentBody.includes("2 of 3"), true);
  assertEquals(progressCommentBody.includes("#44"), true);
});

Deno.test("ensureIssueClosedIfPrMerged - skips progress comment when no milestone", async () => {
  let commentPosted = false;

  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify(MERGED_ON_DEFAULT));
    }
    if (args.join(" ").includes(".default_branch")) {
      return Promise.resolve("Develop\n");
    }
    if (args.join(" ").includes("/compare/")) {
      return Promise.resolve(JSON.stringify({ status: "behind" }));
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(
        JSON.stringify({ state: "OPEN", milestone: null }),
      );
    }
    if (args.includes("issue") && args.includes("close")) {
      return Promise.resolve("");
    }
    if (args.includes("issue") && args.includes("comment")) {
      commentPosted = true;
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };

  const result = await ensureIssueClosedIfPrMerged(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closed, true);
  }
  // No milestone progress comment should be posted
  assertEquals(commentPosted, false);
});

Deno.test("ensureIssueClosedIfPrMerged - returns error on API failure", async () => {
  const mockGh = () => Promise.reject(new Error("API error"));

  const result = await ensureIssueClosedIfPrMerged(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, false);
});

// ============================================================================
// handlePrClosedAfterCreation
// ============================================================================

Deno.test("handlePrClosedAfterCreation - no action when PR is open", async () => {
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "OPEN" }));
    }
    return Promise.resolve("");
  };

  const result = await handlePrClosedAfterCreation(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actionTaken, false);
  }
});

Deno.test("handlePrClosedAfterCreation - closes issue when another PR was merged", async () => {
  let closedIssue = false;
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "CLOSED" }));
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "OPEN" }));
    }
    if (
      args.includes("pr") && args.includes("list") && args.includes("merged")
    ) {
      return Promise.resolve(JSON.stringify([
        { number: 99, mergedAt: "2026-01-01T00:00:00Z" },
      ]));
    }
    if (args.includes("issue") && args.includes("close")) {
      closedIssue = true;
    }
    return Promise.resolve("");
  };

  const result = await handlePrClosedAfterCreation(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actionTaken, true);
    assertEquals(closedIssue, true);
  }
});

Deno.test("handlePrClosedAfterCreation - unassigns for retry when no merged PR", async () => {
  let unassigned = false;
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "CLOSED" }));
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "OPEN" }));
    }
    if (
      args.includes("pr") && args.includes("list") && args.includes("merged")
    ) {
      return Promise.resolve("[]");
    }
    if (args.includes("--remove-assignee")) {
      unassigned = true;
    }
    return Promise.resolve("");
  };

  const result = await handlePrClosedAfterCreation(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actionTaken, true);
    assertEquals(unassigned, true);
  }
});

Deno.test("handlePrClosedAfterCreation - no action when issue already closed", async () => {
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "CLOSED" }));
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "CLOSED" }));
    }
    return Promise.resolve("");
  };

  const result = await handlePrClosedAfterCreation(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actionTaken, false);
  }
});

Deno.test("handlePrClosedAfterCreation - returns error on API failure", async () => {
  const mockGh = () => Promise.reject(new Error("API error"));

  const result = await handlePrClosedAfterCreation(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, false);
});

// ============================================================================
// Issue #2523: belt-and-braces closure when change landed without merge
// ============================================================================

Deno.test("commitMessagesReferenceIssue - matches the (Issue #N) subject convention", () => {
  assertEquals(
    commitMessagesReferenceIssue("Fix the bug (Issue #2481)", 2481),
    true,
  );
});

// --------------------------------------------------------------------------
// Issue #3661 (SEC-d8cc58c8bc6d): the match drives `gh issue close`, so an
// incidental mention must not be read as "the change for this issue landed".
// --------------------------------------------------------------------------

Deno.test("commitMessagesReferenceIssue - an incidental bare #N mention does not count", () => {
  assertEquals(
    commitMessagesReferenceIssue(
      "Tidy the parser\n\nsee #123 for context on the original approach",
      123,
    ),
    false,
  );
});

Deno.test("commitMessagesReferenceIssue - the trailing (#PR) of a squash merge does not count", () => {
  // GitHub appends `(#3694)` — the *PR* number — to squash-merge subjects.
  assertEquals(
    commitMessagesReferenceIssue(
      "Reject '..' traversal in PR evidence (Issue #3658) (#3694)",
      3694,
    ),
    false,
  );
  // The genuine issue reference in the same subject still matches.
  assertEquals(
    commitMessagesReferenceIssue(
      "Reject '..' traversal in PR evidence (Issue #3658) (#3694)",
      3658,
    ),
    true,
  );
});

Deno.test("commitMessagesReferenceIssue - a GitHub closing keyword counts", () => {
  for (
    const message of [
      "Land the fix\n\nCloses #77",
      "Land the fix\n\nFixes #77",
      "Land the fix\n\nResolved: #77",
      "land the fix\n\nfix #77",
    ]
  ) {
    assertEquals(
      commitMessagesReferenceIssue(message, 77),
      true,
      `expected a match for: ${message}`,
    );
  }
});

Deno.test("commitMessagesReferenceIssue - a keyword without # is not a reference", () => {
  // "Fixed 42 bugs" must not be read as closing issue 42.
  assertEquals(commitMessagesReferenceIssue("Fixed 42 bugs today", 42), false);
});

Deno.test("commitMessagesReferenceIssue - matches spelled-out Issue #N", () => {
  assertEquals(
    commitMessagesReferenceIssue("Resolve Issue #42 cleanly", 42),
    true,
  );
});

Deno.test("commitMessagesReferenceIssue - rejects superset/subset numbers", () => {
  // #24810 must not match #2481, and #481 must not match #2481.
  assertEquals(
    commitMessagesReferenceIssue("touch #24810 and #481", 2481),
    false,
  );
});

Deno.test("commitMessagesReferenceIssue - no match for unrelated message", () => {
  assertEquals(
    commitMessagesReferenceIssue("Refactor parser\nAdD logging", 42),
    false,
  );
});

Deno.test("commitMessagesReferenceIssue - empty input is false", () => {
  assertEquals(commitMessagesReferenceIssue("", 42), false);
});

Deno.test("hasIssueChangeLandedOnBranch - true when a commit references the issue", async () => {
  const mockGh = (args: string[]) => {
    if (args[0] === "api") {
      return Promise.resolve("Some unrelated commit\nLand fix (Issue #2481)\n");
    }
    return Promise.resolve("");
  };
  assertEquals(
    await hasIssueChangeLandedOnBranch("org/repo", 2481, "Develop", mockGh),
    true,
  );
});

Deno.test("hasIssueChangeLandedOnBranch - false when no commit references the issue", async () => {
  const mockGh = (args: string[]) => {
    if (args[0] === "api") {
      return Promise.resolve("Unrelated A\nUnrelated B\n");
    }
    return Promise.resolve("");
  };
  assertEquals(
    await hasIssueChangeLandedOnBranch("org/repo", 2481, "Develop", mockGh),
    false,
  );
});

Deno.test("hasIssueChangeLandedOnBranch - false when branch ref is empty", async () => {
  let called = false;
  const mockGh = () => {
    called = true;
    return Promise.resolve("");
  };
  assertEquals(
    await hasIssueChangeLandedOnBranch("org/repo", 1, "", mockGh),
    false,
  );
  assertEquals(called, false, "must not call gh when branch ref is empty");
});

Deno.test("hasIssueChangeLandedOnBranch - false (best-effort) on API failure", async () => {
  const mockGh = () => Promise.reject(new Error("network"));
  assertEquals(
    await hasIssueChangeLandedOnBranch("org/repo", 1, "main", mockGh),
    false,
  );
});

Deno.test("handlePrClosedAfterCreation - closes issue when change landed on base branch without merge", async () => {
  let closedIssue = false;
  let unassigned = false;
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(
        JSON.stringify({ state: "CLOSED", baseRefName: "Develop" }),
      );
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "OPEN" }));
    }
    if (
      args.includes("pr") && args.includes("list") && args.includes("merged")
    ) {
      return Promise.resolve("[]");
    }
    if (args[0] === "api") {
      // Commit landed on Develop referencing the issue, no closing keyword.
      return Promise.resolve("Force-push fix (Issue #42)\n");
    }
    if (args.includes("issue") && args.includes("close")) {
      closedIssue = true;
    }
    if (args.includes("--remove-assignee")) {
      unassigned = true;
    }
    return Promise.resolve("");
  };

  const result = await handlePrClosedAfterCreation(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actionTaken, true);
    assertEquals(result.value.reason.includes("landed"), true);
  }
  assertEquals(closedIssue, true);
  assertEquals(unassigned, true);
});

Deno.test("handlePrClosedAfterCreation - unassigns for retry when change did NOT land", async () => {
  let closedIssue = false;
  let unassigned = false;
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(
        JSON.stringify({ state: "CLOSED", baseRefName: "Develop" }),
      );
    }
    if (args.includes("issue") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({ state: "OPEN" }));
    }
    if (
      args.includes("pr") && args.includes("list") && args.includes("merged")
    ) {
      return Promise.resolve("[]");
    }
    if (args[0] === "api") {
      // No commit on Develop references this issue.
      return Promise.resolve("Unrelated work\n");
    }
    if (args.includes("issue") && args.includes("close")) {
      closedIssue = true;
    }
    if (args.includes("--remove-assignee")) {
      unassigned = true;
    }
    return Promise.resolve("");
  };

  const result = await handlePrClosedAfterCreation(
    "org/repo",
    42,
    100,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actionTaken, true);
    assertEquals(result.value.reason.includes("Unassigned"), true);
  }
  assertEquals(
    closedIssue,
    false,
    "issue must not be closed when change did not land",
  );
  assertEquals(unassigned, true);
});

// ============================================================================
// unassignAfterPrCreated (Issue #1453)
// ============================================================================

Deno.test("unassignAfterPrCreated - removes worker assignee via gh issue edit", async () => {
  const ghCalls: string[][] = [];
  const mockGh = (args: string[]) => {
    ghCalls.push([...args]);
    return Promise.resolve("");
  };

  const result = await unassignAfterPrCreated(
    "org/repo",
    42,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.unassigned, true);
  }
  // Verify a single issue edit --remove-assignee call was made
  const editCall = ghCalls.find(
    (c) =>
      c[0] === "issue" &&
      c[1] === "edit" &&
      c[2] === "42" &&
      c.includes("--remove-assignee") &&
      c.includes("testbot"),
  );
  assertEquals(editCall !== undefined, true);
});

Deno.test("unassignAfterPrCreated - returns non-ok result on gh failure (best-effort)", async () => {
  const mockGh = () => Promise.reject(new Error("gh: not found"));

  const result = await unassignAfterPrCreated(
    "org/repo",
    42,
    "testbot",
    { ghCommandFn: mockGh, logger: makeLogger() },
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("Failed to unassign"), true);
  }
});

Deno.test("unassignAfterPrCreated - logs warning but does not throw on failure", async () => {
  let warnCalled = false;
  const logger: Logger = {
    info: () => {},
    warn: () => {
      warnCalled = true;
    },
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  const mockGh = () => Promise.reject(new Error("network error"));

  // Should not throw — best-effort behaviour
  const result = await unassignAfterPrCreated(
    "org/repo",
    42,
    "testbot",
    { ghCommandFn: mockGh, logger },
  );

  assertEquals(result.ok, false);
  assertEquals(warnCalled, true);
});

// ============================================================================
// Issue #1787: cache-routed merged-PR check in handlePrClosedAfterCreation
// ============================================================================

Deno.test("handlePrClosedAfterCreation - uses cached merged-PR list when cache provided", async () => {
  const { IssueCache } = await import("../lib/issue_cache.ts");
  const dir = await Deno.makeTempDir({ prefix: "lifecycle-cache-" });
  try {
    const cache = new IssueCache(dir);
    let mergedListCalls = 0;
    const mockGh = async (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({ state: "CLOSED" });
      }
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ state: "OPEN" });
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        argsStr.includes("--state merged")
      ) {
        mergedListCalls++;
        return JSON.stringify([
          { number: 99, title: "Resolved (#42)", headRefName: "issue-42" },
        ]);
      }
      return "";
    };

    const result = await handlePrClosedAfterCreation(
      "owner/repo",
      42,
      50,
      "bot",
      { ghCommandFn: mockGh, logger: makeLogger(), cache, githubUser: "bot" },
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.actionTaken, true);
      assertEquals(result.value.reason.includes("another PR was merged"), true);
    }

    // Second call hits cache.
    const second = await handlePrClosedAfterCreation(
      "owner/repo",
      42,
      50,
      "bot",
      { ghCommandFn: mockGh, logger: makeLogger(), cache, githubUser: "bot" },
    );
    assertEquals(second.ok, true);
    assertEquals(
      mergedListCalls,
      1,
      "merged PR list must be served from cache on second call",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("handlePrClosedAfterCreation - no merged match in cache falls through to retry path", async () => {
  const { IssueCache } = await import("../lib/issue_cache.ts");
  const dir = await Deno.makeTempDir({ prefix: "lifecycle-cache-" });
  try {
    const cache = new IssueCache(dir);
    const mockGh = async (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({ state: "CLOSED" });
      }
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ state: "OPEN" });
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        argsStr.includes("--state merged")
      ) {
        // No merged PR for this issue.
        return JSON.stringify([
          { number: 1, title: "Other (#999)", headRefName: "other" },
        ]);
      }
      return "";
    };

    const result = await handlePrClosedAfterCreation(
      "owner/repo",
      42,
      50,
      "bot",
      { ghCommandFn: mockGh, logger: makeLogger(), cache, githubUser: "bot" },
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      // No merged PR → unassigned for retry.
      assertEquals(result.value.actionTaken, true);
      assertEquals(result.value.reason.includes("Unassigned"), true);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("ensureIssueClosedIfPrMerged - a merged PR whose change did not land leaves the issue OPEN with the reason (Issue #4396)", async () => {
  let closedIssue = false;
  const warns: string[] = [];
  const logger = {
    ...makeLogger(),
    warn: (m: string) => {
      warns.push(m);
    },
  };
  const mockGh = (args: string[]) => {
    if (args.includes("pr") && args.includes("view")) {
      return Promise.resolve(JSON.stringify({
        state: "MERGED",
        mergeCommit: { oid: "dea1fdcc" },
        baseRefName: "milestone/clean-up",
      }));
    }
    if (args.includes("issue") && args.includes("close")) closedIssue = true;
    return Promise.resolve("");
  };
  const result = await ensureIssueClosedIfPrMerged(
    "org/repo",
    3339,
    3371,
    "testbot",
    {
      ghCommandFn: mockGh,
      logger,
      verifyMergeLandedFn: () =>
        Promise.resolve({
          landed: false,
          reason: "orphaned",
          detail:
            "PR #3371 merged into milestone/clean-up but rollup PR #3125 (milestone/clean-up → Develop) merged at 2026-06-30T02:27:52Z; the merge commit dea1fdcc is not reachable from Develop",
          mergeCommit: "dea1fdcc",
          baseRefName: "milestone/clean-up",
        }),
    },
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closed, false);
    assert(result.value.reason?.includes("did not land"), result.value.reason);
    assert(result.value.reason?.includes("#3125"), result.value.reason);
    // Issue #175: the verdict is handed back structurally so the caller can
    // self-heal the orphaned milestone merge instead of parsing `reason`.
    assertEquals(result.value.unlanded?.reason, "orphaned");
    assertEquals(result.value.unlanded?.baseRefName, "milestone/clean-up");
  }
  assertEquals(closedIssue, false, "the issue must stay open");
  assert(warns.some((w) => w.includes("did not land")), JSON.stringify(warns));
});
