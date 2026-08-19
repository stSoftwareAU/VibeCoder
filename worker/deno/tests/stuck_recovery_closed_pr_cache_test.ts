/**
 * Closed-PR caching tests for stuck_recovery.ts (Issue #1809).
 *
 * Verifies that the closed-PR scan in `detectAssignedWithClosedPr` uses
 * a single repo-wide `gh pr list --state closed --author <user>` call
 * shared via the `prs_closed_${user}` cache, instead of issuing one
 * `gh pr list --search` per stuck issue.
 *
 * Covers cold/warm cache behaviour, title-match patterns, merged-PR
 * exclusion, and post-mutation invalidation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  fetchClosedPRsByUser,
  invalidateClosedPRsByUser,
} from "../lib/issue_query.ts";
import {
  detectAssignedWithClosedPr,
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "../lib/stuck_issue_detector.ts";

async function makeTempDir(prefix = "src-closed-"): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}

function testConfig(workDir: string, repos = ["org/repo"]): StuckIssueConfig {
  return {
    workDir,
    stuckIssueTimeout: STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
    assignedNoHeartbeatTimeout: STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout,
    staleAssignmentTimeout: STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout,
    repos,
  };
}

function buildIssue(
  num: number,
  title = `Issue ${num}`,
): Record<string, unknown> {
  return {
    number: num,
    title,
    assignees: [{ login: "testuser" }],
    labels: [],
    author: { login: "alice" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://example/${num}`,
    milestone: null,
  };
}

// ============================================================================
// fetchClosedPRsByUser — cold / warm / parse failure
// ============================================================================

Deno.test("fetchClosedPRsByUser - cold cache issues one gh call", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    let calls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      calls++;
      assertEquals(args[0], "pr");
      assertEquals(args[1], "list");
      assertEquals(args.includes("--state"), true);
      assertEquals(args.includes("closed"), true);
      assertEquals(args.includes("--author"), true);
      assertEquals(args.includes("--search"), false);
      return JSON.stringify([
        {
          number: 1,
          title: "Fix (#42)",
          mergedAt: null,
          closedAt: "2026-04-01T00:00:00Z",
        },
      ]);
    };

    const result = await fetchClosedPRsByUser(
      "owner/repo",
      "testuser",
      100,
      cache,
      ghFn,
    );
    assertEquals(result.length, 1);
    assertEquals(result[0]?.number, 1);
    assertEquals(result[0]?.mergedAt, null);
    assertEquals(result[0]?.closedAt, "2026-04-01T00:00:00Z");
    assertEquals(calls, 1);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("fetchClosedPRsByUser - warm cache short-circuits gh", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    await cache.write("owner/repo", "prs_closed_testuser", [
      {
        number: 7,
        title: "Cached (#1)",
        mergedAt: null,
        closedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    let calls = 0;
    const ghFn = async (_args: string[]): Promise<string> => {
      calls++;
      return "[]";
    };

    const result = await fetchClosedPRsByUser(
      "owner/repo",
      "testuser",
      100,
      cache,
      ghFn,
    );
    assertEquals(result.length, 1);
    assertEquals(result[0]?.number, 7);
    assertEquals(calls, 0, "warm cache must not issue a gh call");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("fetchClosedPRsByUser - parse failure returns empty array", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    const ghFn = async (_args: string[]): Promise<string> => "not json";

    const result = await fetchClosedPRsByUser(
      "owner/repo",
      "testuser",
      100,
      cache,
      ghFn,
    );
    assertEquals(result, []);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("invalidateClosedPRsByUser - drops the cache entry", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    await cache.write("owner/repo", "prs_closed_testuser", [
      {
        number: 1,
        title: "x",
        mergedAt: null,
        closedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    await invalidateClosedPRsByUser("owner/repo", "testuser", cache);
    const after = await cache.read("owner/repo", "prs_closed_testuser");
    assertEquals(after, null);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

// ============================================================================
// detectAssignedWithClosedPr — N stuck issues collapse to one PR list call
// ============================================================================

Deno.test("detectAssignedWithClosedPr - N stuck issues issue one closed-PR list call", async () => {
  const cacheDir = await makeTempDir();
  const workDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    let closedListCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          buildIssue(101),
          buildIssue(102),
          buildIssue(103),
        ]);
      }
      // Per-issue title-search (open / merged) returns nothing.
      if (
        args[0] === "pr" && args[1] === "list" && args.includes("--search")
      ) {
        return JSON.stringify([]);
      }
      // Repo-wide closed-PR list call (no --search).
      if (
        args[0] === "pr" && args[1] === "list" &&
        !args.includes("--search") &&
        args.includes("--state") && args.includes("closed") &&
        args.includes("--author")
      ) {
        closedListCalls++;
        return JSON.stringify([
          {
            number: 201,
            title: "Fix (#101)",
            mergedAt: null,
            closedAt: "2026-04-01T00:00:00Z",
          },
          {
            number: 202,
            title: "Fix (Issue #102)",
            mergedAt: null,
            closedAt: "2026-04-01T00:00:00Z",
          },
          {
            number: 203,
            title: "Other unrelated",
            mergedAt: null,
            closedAt: "2026-04-01T00:00:00Z",
          },
        ]);
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );

    // Issues 101 and 102 match closed PRs → recovered. Issue 103 does
    // not match any closed PR → not recovered.
    assertEquals(recovered, 2);
    assertEquals(
      closedListCalls,
      1,
      "N stuck issues must share one closed-PR list call",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// Title-matching patterns — `(#N)` and `(Issue #N)`
// ============================================================================

Deno.test("detectAssignedWithClosedPr - matches both (#N) and (Issue #N) title patterns", async () => {
  const cacheDir = await makeTempDir();
  const workDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(50), buildIssue(60)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        !args.includes("--search") &&
        args.includes("--state") && args.includes("closed") &&
        args.includes("--author")
      ) {
        return JSON.stringify([
          {
            number: 1,
            title: "Worker style (#50)",
            mergedAt: null,
            closedAt: "2026-04-01T00:00:00Z",
          },
          {
            number: 2,
            title: "Human style (Issue #60)",
            mergedAt: null,
            closedAt: "2026-04-01T00:00:00Z",
          },
        ]);
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );
    assertEquals(recovered, 2);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// Merged PRs in the closed list must NOT be picked up by the closed branch
// ============================================================================

Deno.test("detectAssignedWithClosedPr - excludes merged PRs from closed-not-merged filter", async () => {
  const cacheDir = await makeTempDir();
  const workDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    let unassignCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(70)]);
      }
      // Open and merged title-searches return nothing — the closed-PR
      // path must not be re-entered for a PR with a non-null mergedAt.
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        !args.includes("--search") &&
        args.includes("--state") && args.includes("closed") &&
        args.includes("--author")
      ) {
        return JSON.stringify([
          {
            number: 9,
            title: "Already merged (#70)",
            // Non-null mergedAt: the local filter must skip this PR.
            mergedAt: "2026-03-01T00:00:00Z",
            closedAt: "2026-03-01T00:00:00Z",
          },
        ]);
      }
      if (args[0] === "issue" && args[1] === "edit") {
        if (args.includes("--remove-assignee")) unassignCalls++;
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );
    assertEquals(
      recovered,
      0,
      "merged PR must not trigger closed-PR self-healing",
    );
    assertEquals(unassignCalls, 0);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// Cache invalidation after mutation
// ============================================================================

Deno.test("detectAssignedWithClosedPr - invalidates prs_closed_${user} after mutation", async () => {
  const cacheDir = await makeTempDir();
  const workDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(80)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        !args.includes("--search") &&
        args.includes("--state") && args.includes("closed") &&
        args.includes("--author")
      ) {
        return JSON.stringify([
          {
            number: 11,
            title: "Fix (#80)",
            mergedAt: null,
            closedAt: "2026-04-01T00:00:00Z",
          },
        ]);
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    const cached = await cache.read("org/repo", "prs_closed_testuser");
    assertEquals(
      cached,
      null,
      "prs_closed_testuser must be invalidated after unassign",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// Cold + warm cache hit across two scans in the same iteration
// ============================================================================

Deno.test("detectAssignedWithClosedPr - second scan in same iteration hits closed-PR cache", async () => {
  const cacheDir = await makeTempDir();
  const workDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    let closedListCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(90)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        !args.includes("--search") &&
        args.includes("--state") && args.includes("closed") &&
        args.includes("--author")
      ) {
        closedListCalls++;
        // No matching PR for issue 90 — recovery skips, cache stays intact.
        return JSON.stringify([]);
      }
      return "";
    };

    const first = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );
    const second = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );

    assertEquals(first, 0);
    assertEquals(second, 0);
    assertEquals(
      closedListCalls,
      1,
      "second scan must read prs_closed_testuser from cache",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});
