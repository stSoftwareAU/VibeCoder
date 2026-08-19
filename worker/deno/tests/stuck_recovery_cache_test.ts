/**
 * Cache wiring tests for stuck_recovery.ts (Issue #1797).
 *
 * Verifies that the refactored title-search PR sites in
 * `stuck_recovery.ts` resolve through `IssueCache` (cache hit/miss),
 * and that mutation paths invalidate the matching `issues_all` and
 * `prs_title_*_${issueNumber}` keys so a follow-up scan in the same
 * iteration sees fresh state.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  detectAssignedWithClosedPr,
  detectAssignedWithoutHeartbeat,
  recoverStaleGithubAssignments,
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "../lib/stuck_issue_detector.ts";

async function makeTempDir(prefix = "src-test-"): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}

function testConfig(workDir: string): StuckIssueConfig {
  return {
    workDir,
    stuckIssueTimeout: STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
    assignedNoHeartbeatTimeout: STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout,
    staleAssignmentTimeout: STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout,
    repos: ["org/repo"],
  };
}

/**
 * Build a base issue payload matching the `issues_all` cache shape.
 */
function buildIssue(num: number, updatedAt: string, opts?: {
  title?: string;
  labels?: Array<{ name: string }>;
}): Record<string, unknown> {
  return {
    number: num,
    title: opts?.title ?? `Issue ${num}`,
    assignees: [{ login: "testuser" }],
    labels: opts?.labels ?? [],
    author: { login: "alice" },
    createdAt: updatedAt,
    updatedAt,
    url: `https://example/${num}`,
    milestone: null,
  };
}

// ============================================================================
// detectAssignedWithoutHeartbeat — cache hit / miss / invalidation
// ============================================================================

Deno.test("stuck_recovery cache - detectAssignedWithoutHeartbeat shares prs_title_open_N across issues", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);
    const now = 1700000000;
    const oldUpdatedAt = new Date(
      (now - config.assignedNoHeartbeatTimeout - 100) * 1000,
    )
      .toISOString();

    let issueListCalls = 0;
    let prSearchCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        issueListCalls++;
        return JSON.stringify([buildIssue(10, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        prSearchCalls++;
        return JSON.stringify([{
          number: 99,
          title: "Existing PR (#10)",
          baseRefName: "main",
          headRefName: "issue-10",
          mergedAt: null,
        }]);
      }
      return "";
    };

    // First scan: open PR found → no recovery, but caches are populated.
    const first = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    // Second scan in the same iteration: should reuse the caches.
    const second = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );

    assertEquals(first, 0);
    assertEquals(second, 0);
    assertEquals(issueListCalls, 1, "issues_all should be cached across scans");
    assertEquals(
      prSearchCalls,
      1,
      "prs_title_open_10 should be cached across scans",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("stuck_recovery cache - detectAssignedWithoutHeartbeat invalidates issues_all + prs_title_open after unassign", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);
    const now = 1700000000;
    const oldUpdatedAt = new Date(
      (now - config.assignedNoHeartbeatTimeout - 100) * 1000,
    )
      .toISOString();

    let issueListCalls = 0;
    let prSearchCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        issueListCalls++;
        return JSON.stringify([buildIssue(11, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        prSearchCalls++;
        return JSON.stringify([]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    // After mutation, issues_all and prs_title_open_11 must be invalidated.
    const cachedIssues = await cache.read("org/repo", "issues_all");
    const cachedPrs = await cache.read("org/repo", "prs_title_open_11");
    assertEquals(cachedIssues, null, "issues_all cache should be invalidated");
    assertEquals(
      cachedPrs,
      null,
      "prs_title_open_11 cache should be invalidated",
    );

    // A follow-up scan triggers fresh fetches.
    await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(
      issueListCalls,
      2,
      "issues_all must refetch after invalidation",
    );
    assertEquals(
      prSearchCalls >= 2,
      true,
      "prs_title_open_11 must refetch after invalidation",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// recoverStaleGithubAssignments — invalidation after unassign
// ============================================================================

Deno.test("stuck_recovery cache - recoverStaleGithubAssignments invalidates issues_all on mutation", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);
    const now = 1700000000;
    const oldUpdatedAt = new Date(
      (now - config.staleAssignmentTimeout - 100) * 1000,
    )
      .toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(20, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      return "";
    };

    const recovered = await recoverStaleGithubAssignments(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    const cachedIssues = await cache.read("org/repo", "issues_all");
    const cachedPrs = await cache.read("org/repo", "prs_title_open_20");
    assertEquals(cachedIssues, null, "issues_all cache should be invalidated");
    assertEquals(
      cachedPrs,
      null,
      "prs_title_open_20 cache should be invalidated",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// detectAssignedWithClosedPr — title-search caches and invalidation
// ============================================================================

Deno.test("stuck_recovery cache - detectAssignedWithClosedPr resolves merged + closed via fetchPRsForIssueByTitle", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    let mergedSearchCalls = 0;
    // Issue #1809: closed-PR scan now uses a repo-wide list call instead
    // of a per-issue --search. Counter renamed to reflect the new path.
    let closedListCalls = 0;

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          buildIssue(30, "2026-01-01T00:00:00Z", { title: "Bug" }),
        ]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        args.includes("--search") && args.includes("open")
      ) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        args.includes("--search") && args.includes("merged")
      ) {
        mergedSearchCalls++;
        return JSON.stringify([]);
      }
      // Issue #1809: repo-wide closed-PR list (no --search), filtered
      // locally by `prTitleMatchesIssue`.
      if (
        args[0] === "pr" && args[1] === "list" &&
        !args.includes("--search") &&
        args.includes("--state") && args.includes("closed") &&
        args.includes("--author")
      ) {
        closedListCalls++;
        return JSON.stringify([{
          number: 77,
          title: "Old PR (#30)",
          mergedAt: null,
          closedAt: "2026-02-01T00:00:00Z",
        }]);
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

    // Cache must be populated for this issue/state pair before mutation
    // and dropped after. After invalidation, follow-up scans refetch.
    const cachedClosed = await cache.read("org/repo", "prs_title_closed_30");
    assertEquals(
      cachedClosed,
      null,
      "prs_title_closed_30 should be invalidated",
    );
    const cachedMerged = await cache.read("org/repo", "prs_title_merged_30");
    assertEquals(
      cachedMerged,
      null,
      "prs_title_merged_30 should be invalidated",
    );
    const cachedIssues = await cache.read("org/repo", "issues_all");
    assertEquals(cachedIssues, null, "issues_all should be invalidated");
    // Issue #1809: the shared closed-PR list is invalidated after
    // mutation so a follow-up scan in the same iteration sees fresh state.
    const cachedClosedList = await cache.read(
      "org/repo",
      "prs_closed_testuser",
    );
    assertEquals(
      cachedClosedList,
      null,
      "prs_closed_testuser should be invalidated",
    );

    assertEquals(mergedSearchCalls, 1);
    assertEquals(closedListCalls, 1);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("stuck_recovery cache - detectAssignedWithClosedPr cache hit avoids second gh search", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    // Pre-populate the merged-title cache so the helper does not call gh
    // for that lookup when no merged PR exists.
    await cache.write("org/repo", "prs_title_merged_40", []);
    await cache.write("org/repo", "prs_title_open_40", []);
    // Issue #1809: closed-PR scan now reads from `prs_closed_${user}`
    // — pre-populate so the closed lookup also hits cache.
    await cache.write("org/repo", "prs_closed_testuser", []);

    const config = testConfig(workDir);

    let prSearchCalls = 0;
    let prListCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(40, "2026-01-01T00:00:00Z")]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        prSearchCalls++;
        return JSON.stringify([]);
      }
      if (args[0] === "pr" && args[1] === "list") {
        prListCalls++;
        return JSON.stringify([]);
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
    assertEquals(recovered, 0);
    assertEquals(prSearchCalls, 0, "all PR title searches must hit cache");
    assertEquals(prListCalls, 0, "the repo-wide closed-PR list must hit cache");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("stuck_recovery cache - detectAssignedWithClosedPr merged PR closes issue and drops caches", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    const closed: number[] = [];

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(50, "2026-01-01T00:00:00Z")]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        args.includes("--search") && args.includes("open")
      ) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        args.includes("--search") && args.includes("merged")
      ) {
        return JSON.stringify([{
          number: 5,
          title: "Fix bug (#50)",
          baseRefName: "main",
          headRefName: "h",
          mergedAt: "2026-02-01T00:00:00Z",
        }]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        // Also feeds the #4396 landing check: merged onto main, landed.
        return JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-02-01T00:00:00Z",
          mergeCommit: { oid: "abc123" },
          baseRefName: "main",
        });
      }
      if (args[0] === "api" && args.join(" ").includes("/compare/")) {
        return JSON.stringify({ status: "behind" });
      }
      if (args[0] === "api" && args.join(" ").includes(".default_branch")) {
        return "main\n";
      }
      if (args[0] === "api") {
        return "2025-01-01T00:00:00Z";
      }
      if (args[0] === "issue" && args[1] === "close") {
        closed.push(parseInt(args[2]!));
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
    assertEquals(closed[0], 50);

    // Mutation must invalidate all three title-search keys + issues_all.
    assertEquals(await cache.read("org/repo", "prs_title_open_50"), null);
    assertEquals(await cache.read("org/repo", "prs_title_merged_50"), null);
    assertEquals(await cache.read("org/repo", "prs_title_closed_50"), null);
    assertEquals(await cache.read("org/repo", "issues_all"), null);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});
Deno.test("stuck_recovery cache - detectAssignedWithClosedPr leaves an issue OPEN (and unassigns) when its merged PR was orphaned by a rolled-up milestone (Issue #4396)", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    const closed: number[] = [];
    const unassigned: number[] = [];

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(50, "2026-01-01T00:00:00Z")]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        args.includes("--search") && args.includes("open")
      ) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        args.includes("--search") && args.includes("merged")
      ) {
        return JSON.stringify([{
          number: 5,
          title: "Fix bug (#50)",
          baseRefName: "main",
          headRefName: "h",
          mergedAt: "2026-02-01T00:00:00Z",
        }]);
      }
      if (args[0] === "pr" && args[1] === "view" && args[2] === "3125") {
        // The rollup PR merged two weeks before the child.
        return JSON.stringify({ mergedAt: "2026-01-15T00:00:00Z" });
      }
      if (args[0] === "pr" && args[1] === "view") {
        // Also feeds the #4396 landing check: merged onto main, landed.
        return JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-02-01T00:00:00Z",
          mergeCommit: { oid: "abc123" },
          baseRefName: "milestone/clean-up",
        });
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--head")) {
        // The milestone's rollup merged BEFORE this PR: orphaned.
        return JSON.stringify([{
          number: 3125,
          state: "MERGED",
          baseRefName: "main",
          mergedAt: "2026-01-15T00:00:00Z",
        }]);
      }
      if (
        args[0] === "api" && args.join(" ").includes("/milestones?state=all")
      ) {
        return JSON.stringify([{
          number: 7,
          title: "Clean up",
          state: "closed",
        }]);
      }
      if (args[0] === "api" && args.join(" ").includes("/compare/")) {
        return JSON.stringify({ status: "diverged" });
      }
      if (args[0] === "api" && args.join(" ").includes(".default_branch")) {
        return "main\n";
      }
      if (args[0] === "api") {
        return "2025-01-01T00:00:00Z";
      }
      if (args[0] === "issue" && args[1] === "close") {
        closed.push(parseInt(args[2]!));
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
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
    // Unassigned so a fresh attempt can claim it — but NOT closed.
    assertEquals(recovered, 1);
    assertEquals(closed, []);
    assertEquals(
      unassigned,
      [50],
      "the orphaned issue must be unassigned, not closed",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});
