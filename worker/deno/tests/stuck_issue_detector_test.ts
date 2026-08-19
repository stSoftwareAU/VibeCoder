/**
 * Tests for stuck_issue_detector.ts — heartbeat-based detection and
 * recovery of stuck issues (Issue #471, #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  clearHeartbeat,
  DEFAULT_MARKER_REFRESH_SECONDS,
  detectAndRecoverStuckHeartbeats,
  detectAssignedWithClosedPr,
  detectAssignedWithoutHeartbeat,
  formatHeartbeatMarker,
  hasOpenLinkedPR,
  HEARTBEAT_MARKER_PREFIX,
  heartbeatFilePath,
  isIssueStuck,
  markerStateFilePath,
  parseHeartbeatFilename,
  parseHeartbeatMarker,
  publishOrRefreshMarker,
  recordHeartbeat,
  recoverStaleGithubAssignments,
  renderHeartbeatBody,
  scanHeartbeatMarkers,
  seedMarkerState,
  shouldSkipRecoveryForMarker,
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "../lib/stuck_issue_detector.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "sid-test-" });
}

function testConfig(workDir: string): StuckIssueConfig {
  return {
    workDir,
    stuckIssueTimeout: STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
    assignedNoHeartbeatTimeout: STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout,
    staleAssignmentTimeout: STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout,
    repos: [],
  };
}

// ============================================================================
// heartbeatFilePath
// ============================================================================

Deno.test("stuck issue detector - heartbeatFilePath generates correct path", () => {
  const path = heartbeatFilePath("/work", "org/repo", 42);
  assertEquals(path, "/work/.heartbeat_org_repo_42");
});

Deno.test("stuck issue detector - heartbeatFilePath handles different repos", () => {
  const path = heartbeatFilePath("/work", "myorg/myrepo", 100);
  assertEquals(path, "/work/.heartbeat_myorg_myrepo_100");
});

// ============================================================================
// recordHeartbeat
// ============================================================================

Deno.test("stuck issue detector - recordHeartbeat creates file with timestamp", async () => {
  const dir = await makeTempDir();
  try {
    const fixedNow = () => 1700000000;
    const result = await recordHeartbeat(dir, "org/repo", 42, fixedNow);
    assertEquals(result.ok, true);

    const content = await Deno.readTextFile(
      heartbeatFilePath(dir, "org/repo", 42),
    );
    assertEquals(content, "1700000000");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - recordHeartbeat updates existing file", async () => {
  const dir = await makeTempDir();
  try {
    await recordHeartbeat(dir, "org/repo", 42, () => 1000);
    await recordHeartbeat(dir, "org/repo", 42, () => 2000);

    const content = await Deno.readTextFile(
      heartbeatFilePath(dir, "org/repo", 42),
    );
    assertEquals(content, "2000");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// clearHeartbeat
// ============================================================================

Deno.test("stuck issue detector - clearHeartbeat removes file", async () => {
  const dir = await makeTempDir();
  try {
    await recordHeartbeat(dir, "org/repo", 42);
    const result = await clearHeartbeat(dir, "org/repo", 42);
    assertEquals(result.ok, true);

    try {
      await Deno.stat(heartbeatFilePath(dir, "org/repo", 42));
      assertEquals(true, false, "File should not exist");
    } catch (e) {
      assertEquals((e as Deno.errors.NotFound).name, "NotFound");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - clearHeartbeat succeeds when no file", async () => {
  const dir = await makeTempDir();
  try {
    const result = await clearHeartbeat(dir, "org/repo", 999);
    assertEquals(result.ok, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// isIssueStuck
// ============================================================================

Deno.test("stuck issue detector - issue is not stuck when heartbeat is recent", async () => {
  const dir = await makeTempDir();
  try {
    const now = 1700000000;
    await recordHeartbeat(dir, "org/repo", 42, () => now);
    const stuck = await isIssueStuck(
      dir,
      "org/repo",
      42,
      7200,
      () => now + 100,
    );
    assertEquals(stuck, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - issue is stuck when heartbeat exceeds timeout", async () => {
  const dir = await makeTempDir();
  try {
    const now = 1700000000;
    await recordHeartbeat(dir, "org/repo", 42, () => now);
    const stuck = await isIssueStuck(
      dir,
      "org/repo",
      42,
      7200,
      () => now + 7201,
    );
    assertEquals(stuck, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - issue is not stuck at exact timeout boundary", async () => {
  const dir = await makeTempDir();
  try {
    const now = 1700000000;
    await recordHeartbeat(dir, "org/repo", 42, () => now);
    const stuck = await isIssueStuck(
      dir,
      "org/repo",
      42,
      7200,
      () => now + 7200,
    );
    assertEquals(stuck, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - issue is not stuck when no heartbeat file", async () => {
  const dir = await makeTempDir();
  try {
    const stuck = await isIssueStuck(dir, "org/repo", 999, 7200);
    assertEquals(stuck, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// parseHeartbeatFilename
// ============================================================================

Deno.test("stuck issue detector - parseHeartbeatFilename extracts repo and issue", () => {
  const result = parseHeartbeatFilename(".heartbeat_org_repo_42");
  assertEquals(result, { repo: "org/repo", issueNumber: 42 });
});

Deno.test("stuck issue detector - parseHeartbeatFilename handles multi-underscore repo", () => {
  const result = parseHeartbeatFilename(".heartbeat_myorg_my_repo_100");
  assertEquals(result, { repo: "myorg/my_repo", issueNumber: 100 });
});

Deno.test("stuck issue detector - parseHeartbeatFilename returns null for invalid format", () => {
  assertEquals(parseHeartbeatFilename("not_a_heartbeat"), null);
  assertEquals(parseHeartbeatFilename(".heartbeat_"), null);
  assertEquals(parseHeartbeatFilename(".heartbeat_org"), null);
});

Deno.test("stuck issue detector - parseHeartbeatFilename returns null for non-numeric issue", () => {
  assertEquals(parseHeartbeatFilename(".heartbeat_org_repo_abc"), null);
});

// ============================================================================
// detectAndRecoverStuckHeartbeats (integration — no GitHub calls)
// ============================================================================

Deno.test("stuck issue detector - scan finds no stuck issues in empty dir", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const recovered = await detectAndRecoverStuckHeartbeats(config, "testuser");
    assertEquals(recovered, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - scan skips recent heartbeats", async () => {
  const dir = await makeTempDir();
  try {
    const now = 1700000000;
    await recordHeartbeat(dir, "org/repo", 42, () => now);

    const config = testConfig(dir);
    // Note: recover_stuck_issue calls gh which won't be available in test
    // but the issue shouldn't be detected as stuck since heartbeat is recent
    const recovered = await detectAndRecoverStuckHeartbeats(
      config,
      "testuser",
      () => now + 100,
    );
    assertEquals(recovered, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Defaults
// ============================================================================

Deno.test("stuck issue detector - defaults have expected values", () => {
  assertEquals(STUCK_ISSUE_DEFAULTS.stuckIssueTimeout, 7200);
  assertEquals(STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout, 1800);
  assertEquals(STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout, 14400);
});

// ============================================================================
// detectAssignedWithClosedPr — planning issue protection (Issue #1193)
// ============================================================================

Deno.test("stuck issue detector - detectAssignedWithClosedPr skips planning issues", async () => {
  const dir = await makeTempDir();
  try {
    const closedIssues: number[] = [];
    const config = testConfig(dir);
    config.repos = ["org/repo"];

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 10,
            title: "Planning: break down feature",
            labels: [{ name: "planning" }],
          },
        ]);
      }
      if (args[0] === "issue" && args[1] === "close") {
        closedIssues.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
    );
    assertEquals(recovered, 0);
    assertEquals(closedIssues.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - detectAssignedWithClosedPr processes non-planning issues with merged PR", async () => {
  const dir = await makeTempDir();
  try {
    const closedIssues: number[] = [];
    const config = testConfig(dir);
    config.repos = ["org/repo"];

    const ghFn = async (args: string[]): Promise<string> => {
      // Issue #1787: detectAssignedWithClosedPr now reads through
      // `fetchAllIssues` and filters locally by assignee, and
      // through `fetchMergedPRsByUser` (matches title locally).
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 10,
            title: "Fix bug",
            assignees: [{ login: "testuser" }],
            labels: [{ name: "bug" }],
            author: { login: "testuser" },
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            url: "",
          },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("merged")) {
        // Merged-PR cache shape: number, title (must reference #10), headRefName.
        return JSON.stringify([
          { number: 5, title: "Fix bug (#10)", headRefName: "issue-10" },
        ]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        // Also feeds the #4396 landing check: merged onto main, landed.
        return JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-01-01T00:00:00Z",
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
        closedIssues.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
    );
    assertEquals(recovered, 1);
    assertEquals(closedIssues[0], 10);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// hasOpenLinkedPR — shared helper (Issue #1452)
// ============================================================================

Deno.test("stuck issue detector - hasOpenLinkedPR returns true when open PR exists", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
      return JSON.stringify([{ number: 42 }]);
    }
    return "";
  };
  const result = await hasOpenLinkedPR("org/repo", 10, ghFn);
  assertEquals(result, true);
});

Deno.test("stuck issue detector - hasOpenLinkedPR returns false when no open PR", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
      return JSON.stringify([]);
    }
    return "";
  };
  const result = await hasOpenLinkedPR("org/repo", 10, ghFn);
  assertEquals(result, false);
});

Deno.test("stuck issue detector - hasOpenLinkedPR returns false on parse error", async () => {
  const ghFn = async (_args: string[]): Promise<string> => {
    return "not valid json";
  };
  const result = await hasOpenLinkedPR("org/repo", 10, ghFn);
  assertEquals(result, false);
});

Deno.test("stuck issue detector - hasOpenLinkedPR returns false on empty response", async () => {
  const ghFn = async (_args: string[]): Promise<string> => {
    return "";
  };
  const result = await hasOpenLinkedPR("org/repo", 10, ghFn);
  assertEquals(result, false);
});

// =============================================================================
// hasOpenLinkedPR cache-routed path (Issues #1787, #1797)
//
// Issue #1797 swapped the underlying helper from `fetchOpenPRsByUser`
// (`prs_${user}` cache key) to `fetchPRsForIssueByTitle`
// (`prs_title_open_${issueNumber}` cache key) so the per-issue
// title-search lookups share an iteration-scoped cache without
// poisoning the worker-author-only `prs_${user}` cache. The tests
// below assert the new shape.
// =============================================================================

Deno.test("stuck issue detector - hasOpenLinkedPR routes through title-search cache when provided", async () => {
  const { IssueCache } = await import("../lib/issue_cache.ts");
  const dir = await Deno.makeTempDir({ prefix: "stuck-cache-" });
  try {
    const cache = new IssueCache(dir);
    let networkCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      networkCalls++;
      // Issue #1797: the cache path uses fetchPRsForIssueByTitle which
      // calls `gh pr list --search 'in:title (#N) OR in:title (Issue #N)'`.
      assertEquals(args.includes("--search"), true);
      assertEquals(args.includes("--author"), false);
      return JSON.stringify([
        {
          number: 5,
          title: "Fix bug (#10)",
          baseRefName: "main",
          headRefName: "issue-10",
          mergedAt: null,
        },
      ]);
    };

    const first = await hasOpenLinkedPR("org/repo", 10, ghFn, cache, "bot");
    const second = await hasOpenLinkedPR("org/repo", 10, ghFn, cache, "bot");
    assertEquals(first, true);
    assertEquals(second, true);
    assertEquals(networkCalls, 1, "second call must be served from cache");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stuck issue detector - hasOpenLinkedPR cache returns false when title-search yields no PRs", async () => {
  const { IssueCache } = await import("../lib/issue_cache.ts");
  const dir = await Deno.makeTempDir({ prefix: "stuck-cache-" });
  try {
    const cache = new IssueCache(dir);
    const ghFn = async (_args: string[]): Promise<string> => JSON.stringify([]);
    const result = await hasOpenLinkedPR("org/repo", 10, ghFn, cache, "bot");
    assertEquals(result, false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stuck issue detector - hasOpenLinkedPR caches per-issue (different issue numbers do not collide)", async () => {
  const { IssueCache } = await import("../lib/issue_cache.ts");
  const dir = await Deno.makeTempDir({ prefix: "stuck-cache-" });
  try {
    const cache = new IssueCache(dir);
    let calls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      calls++;
      // Differentiate by which issue the search is targeting.
      const searchIdx = args.indexOf("--search");
      const expr = searchIdx >= 0 ? args[searchIdx + 1] ?? "" : "";
      if (expr.includes("(#10)")) {
        return JSON.stringify([{
          number: 1,
          title: "x (#10)",
          baseRefName: "main",
          headRefName: "h",
          mergedAt: null,
        }]);
      }
      return JSON.stringify([]);
    };
    const a = await hasOpenLinkedPR("org/repo", 10, ghFn, cache, "bot");
    const b = await hasOpenLinkedPR("org/repo", 99, ghFn, cache, "bot");
    assertEquals(a, true);
    assertEquals(b, false);
    // Issue #1887 hardened the linkage check with three additional
    // signals (`closing_ref`, `cross_ref`, `worker_comment`) reached via
    // a single GraphQL fallback when the title search returns nothing.
    // Issue 10 returns a title hit (1 call); issue 99 returns an empty
    // title search (1 call) and then runs the GraphQL fallback (1 more
    // call) — three calls total. The cache claim under test (no
    // collision between issue numbers) still holds: a repeat lookup of
    // the same number does not increment `calls`.
    assertEquals(calls, 3, "different issues must trigger separate gh calls");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stuck issue detector - hasOpenLinkedPR works without cache via fetchPRsForIssueByTitle", async () => {
  let usedSearchPath = false;
  const ghFn = async (args: string[]): Promise<string> => {
    if (args.includes("--search")) {
      usedSearchPath = true;
      return JSON.stringify([{
        number: 5,
        title: "Fix (#10)",
        baseRefName: "main",
        headRefName: "h",
        mergedAt: null,
      }]);
    }
    return "";
  };
  const result = await hasOpenLinkedPR("org/repo", 10, ghFn);
  assertEquals(result, true);
  assertEquals(usedSearchPath, true);
});

// ============================================================================
// detectAssignedWithoutHeartbeat — open PR skip (Issue #1452)
// ============================================================================

Deno.test("stuck issue detector - detectAssignedWithoutHeartbeat skips when open PR linked", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    config.repos = ["org/repo"];
    const unassigned: number[] = [];

    const now = 1700000000;
    const oldUpdatedAt = new Date(
      (now - config.assignedNoHeartbeatTimeout - 100) * 1000,
    ).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          { number: 10, updatedAt: oldUpdatedAt, title: "Fix something" },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([{ number: 55 }]);
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
    );
    assertEquals(recovered, 0);
    assertEquals(unassigned.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - detectAssignedWithoutHeartbeat recovers when no PR and timeout elapsed", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    config.repos = ["org/repo"];
    const unassigned: number[] = [];

    const now = 1700000000;
    const oldUpdatedAt = new Date(
      (now - config.assignedNoHeartbeatTimeout - 100) * 1000,
    ).toISOString();

    // Issue #1787: detectAssignedWithoutHeartbeat now reads through
    // `fetchAllIssues` and filters locally by assignee, so the stub
    // must include the richer issues_all projection (with assignees).
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 10,
            updatedAt: oldUpdatedAt,
            title: "Fix something",
            assignees: [{ login: "testuser" }],
            labels: [],
            createdAt: oldUpdatedAt,
            milestone: null,
            author: { login: "alice" },
            url: "u",
          },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
    );
    assertEquals(recovered, 1);
    assertEquals(unassigned[0], 10);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// recoverStaleGithubAssignments — open PR skip (Issue #1452)
// ============================================================================

Deno.test("stuck issue detector - recoverStaleGithubAssignments skips when open PR linked", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    config.repos = ["org/repo"];
    const unassigned: number[] = [];

    const now = 1700000000;
    const oldUpdatedAt = new Date(
      (now - config.staleAssignmentTimeout - 100) * 1000,
    ).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          { number: 20, updatedAt: oldUpdatedAt, title: "Stale issue" },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([{ number: 77 }]);
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await recoverStaleGithubAssignments(
      config,
      "testuser",
      () => now,
      ghFn,
    );
    assertEquals(recovered, 0);
    assertEquals(unassigned.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - recoverStaleGithubAssignments recovers when no PR and timeout elapsed", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    config.repos = ["org/repo"];
    const unassigned: number[] = [];

    const now = 1700000000;
    const oldUpdatedAt = new Date(
      (now - config.staleAssignmentTimeout - 100) * 1000,
    ).toISOString();

    // Issue #1787: recoverStaleGithubAssignments now reads through
    // `fetchAllIssues` and filters locally by assignee.
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 20,
            updatedAt: oldUpdatedAt,
            title: "Stale issue",
            assignees: [{ login: "testuser" }],
            labels: [],
            createdAt: oldUpdatedAt,
            milestone: null,
            author: { login: "alice" },
            url: "u",
          },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await recoverStaleGithubAssignments(
      config,
      "testuser",
      () => now,
      ghFn,
    );
    assertEquals(recovered, 1);
    assertEquals(unassigned[0], 20);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Multi-worker heartbeat markers (Issue #1454)
// ============================================================================

Deno.test("stuck issue detector - formatHeartbeatMarker wraps id+epoch in HTML comment", () => {
  const body = formatHeartbeatMarker("host-abc123", 1700000000);
  assertEquals(
    body,
    `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-abc123:1700000000 -->`,
  );
});

Deno.test("stuck issue detector - parseHeartbeatMarker extracts latest marker", () => {
  const body = `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-a:1700000000 -->\n` +
    `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-a:1700000500 -->`;
  assertEquals(
    parseHeartbeatMarker(body),
    { machineId: "host-a", epoch: 1700000500, cleared: false },
  );
});

Deno.test("stuck issue detector - parseHeartbeatMarker returns null when absent", () => {
  assertEquals(parseHeartbeatMarker("normal comment body"), null);
});

Deno.test("stuck issue detector - markerStateFilePath is derived from repo and issue", () => {
  assertEquals(
    markerStateFilePath("/work", "org/repo", 42),
    "/work/.heartbeat-marker_org_repo_42",
  );
});

Deno.test("stuck issue detector - publishOrRefreshMarker posts a new comment on first call", async () => {
  const dir = await makeTempDir();
  try {
    const calls: Array<{ args: string[]; body: string | null }> = [];
    const ghFn = async (args: string[]): Promise<string> => {
      const bodyArg = args.findIndex((a) => a.startsWith("body="));
      calls.push({
        args,
        body: bodyArg >= 0 ? args[bodyArg]!.substring("body=".length) : null,
      });
      // Simulate the `gh api --jq .id` output for POST
      if (args.includes("POST")) return "98765";
      return "";
    };
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn },
      () => 1700000000,
    );
    // One POST call
    const postCalls = calls.filter((c) => c.args.includes("POST"));
    assertEquals(postCalls.length, 1);
    // Issue #3752: the body now carries visible status text after the
    // marker, which stays first and unchanged.
    assertEquals(
      postCalls[0]!.body,
      renderHeartbeatBody(
        {
          machineId: "host-A",
          epoch: 1700000000,
          startedEpoch: 1700000000,
        },
        () => 1700000000,
      ),
    );
    assertEquals(
      postCalls[0]!.body!.startsWith(
        formatHeartbeatMarker("host-A", 1700000000),
      ),
      true,
    );
    // State persisted
    const raw = await Deno.readTextFile(
      markerStateFilePath(dir, "org/repo", 42),
    );
    const state = JSON.parse(raw);
    assertEquals(state.commentId, 98765);
    assertEquals(state.lastRefresh, 1700000000);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - publishOrRefreshMarker skips PATCH inside refresh window", async () => {
  const dir = await makeTempDir();
  try {
    // Seed existing marker state
    await Deno.writeTextFile(
      markerStateFilePath(dir, "org/repo", 42),
      JSON.stringify({ commentId: 1, lastRefresh: 1700000000 }),
    );
    let patchCount = 0;
    let postCount = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        patchCount++;
        return "1";
      }
      if (args.includes("POST")) {
        postCount++;
        return "1";
      }
      return "";
    };
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, minRefreshSeconds: 300 },
      () => 1700000100, // 100s later — inside the 300s window
    );
    assertEquals(patchCount, 0);
    assertEquals(postCount, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - publishOrRefreshMarker edits comment after refresh window", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.writeTextFile(
      markerStateFilePath(dir, "org/repo", 42),
      JSON.stringify({ commentId: 55, lastRefresh: 1700000000 }),
    );
    let patchCount = 0;
    let patchedCommentId: number | null = null;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        patchCount++;
        const endpoint = args[1] ?? "";
        const match = endpoint.match(/issues\/comments\/(\d+)/);
        if (match) patchedCommentId = parseInt(match[1]!, 10);
        return "55";
      }
      return "";
    };
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, minRefreshSeconds: 300 },
      () => 1700000400, // 400s later — past the 300s window
    );
    assertEquals(patchCount, 1);
    assertEquals(patchedCommentId, 55);
    const state = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 42)),
    );
    assertEquals(state.commentId, 55);
    assertEquals(state.lastRefresh, 1700000400);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - publishOrRefreshMarker falls back to new comment when PATCH fails", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.writeTextFile(
      markerStateFilePath(dir, "org/repo", 42),
      JSON.stringify({ commentId: 55, lastRefresh: 1700000000 }),
    );
    let patchCount = 0;
    let postCount = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        patchCount++;
        return ""; // simulate PATCH failure
      }
      if (args.includes("POST")) {
        postCount++;
        return "99";
      }
      return "";
    };
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn },
      () => 1700001000,
    );
    assertEquals(patchCount, 1);
    assertEquals(postCount, 1);
    const state = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 42)),
    );
    assertEquals(state.commentId, 99);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - recordHeartbeat publishes marker when machineId supplied", async () => {
  const dir = await makeTempDir();
  try {
    let postCount = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.includes("POST")) {
        postCount++;
        return "42";
      }
      return "";
    };
    const result = await recordHeartbeat(
      dir,
      "org/repo",
      7,
      () => 1700000000,
      { machineId: "host-B", ghFn },
    );
    assertEquals(result.ok, true);
    assertEquals(postCount, 1);
    // Local heartbeat file written
    const local = await Deno.readTextFile(
      heartbeatFilePath(dir, "org/repo", 7),
    );
    assertEquals(local, "1700000000");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - recordHeartbeat skips marker when machineId absent", async () => {
  const dir = await makeTempDir();
  try {
    let ghCalls = 0;
    const ghFn = async (_args: string[]): Promise<string> => {
      ghCalls++;
      return "";
    };
    // Omit markerOptions entirely
    const result = await recordHeartbeat(dir, "org/repo", 7, () => 1700000000);
    assertEquals(result.ok, true);
    assertEquals(ghCalls, 0);
    // machineId empty string also skips
    await recordHeartbeat(
      dir,
      "org/repo",
      8,
      () => 1700000000,
      { machineId: "", ghFn },
    );
    assertEquals(ghCalls, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - clearHeartbeat invalidates marker when machineId supplied", async () => {
  const dir = await makeTempDir();
  try {
    // Seed marker state and heartbeat file
    await Deno.writeTextFile(
      heartbeatFilePath(dir, "org/repo", 11),
      "1700000000",
    );
    await Deno.writeTextFile(
      markerStateFilePath(dir, "org/repo", 11),
      JSON.stringify({ commentId: 77, lastRefresh: 1700000000 }),
    );
    let patchedBody = "";
    let patchedId: number | null = null;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        const endpoint = args[1] ?? "";
        const match = endpoint.match(/issues\/comments\/(\d+)/);
        if (match) patchedId = parseInt(match[1]!, 10);
        const bodyIdx = args.findIndex((a) => a.startsWith("body="));
        if (bodyIdx >= 0) {
          patchedBody = args[bodyIdx]!.substring("body=".length);
        }
        return "77";
      }
      return "";
    };
    await clearHeartbeat(dir, "org/repo", 11, { machineId: "host-B", ghFn });
    assertEquals(patchedId, 77);
    // Body records :0 epoch to signal invalidation
    assertEquals(
      patchedBody.includes(`${HEARTBEAT_MARKER_PREFIX}:host-B:0`),
      true,
    );
    // Issue #3751 changed this behaviour deliberately: the state file is
    // retained with `released: true` (previously it was deleted) so a
    // re-claim on this host revives the same comment instead of posting a
    // new marker.
    const released = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 11)),
    );
    assertEquals(released.commentId, 77);
    assertEquals(released.released, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - scanHeartbeatMarkers extracts markers from comments", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return JSON.stringify([
        { body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-A:1700000000 -->` },
        { body: "just a normal comment" },
        { body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-B:1700000500 -->` },
      ]);
    }
    return "";
  };
  const markers = await scanHeartbeatMarkers("org/repo", 10, ghFn);
  assertEquals(markers.length, 2);
  assertEquals(markers[0], {
    machineId: "host-A",
    epoch: 1700000000,
    cleared: false,
  });
  assertEquals(markers[1], {
    machineId: "host-B",
    epoch: 1700000500,
    cleared: false,
  });
});

Deno.test("stuck issue detector - scanHeartbeatMarkers returns [] on empty/invalid response", async () => {
  const emptyFn = async (_args: string[]): Promise<string> => "";
  assertEquals(await scanHeartbeatMarkers("org/repo", 10, emptyFn), []);
  const invalidFn = async (_args: string[]): Promise<string> => "not json";
  assertEquals(await scanHeartbeatMarkers("org/repo", 10, invalidFn), []);
});

Deno.test("stuck issue detector - scanHeartbeatMarkers ignores a marker from a non-fleet author (Issue #3164)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return JSON.stringify([
        // Forged marker from an attacker who can merely comment.
        {
          body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-EVIL:9999999999 -->`,
          author: "attacker",
        },
        // Genuine marker from a fleet account.
        {
          body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-A:1700000000 -->`,
          author: "VibeCoderBot",
        },
      ]);
    }
    return "";
  };
  const markers = await scanHeartbeatMarkers("org/repo", 10, ghFn, [
    "VibeCoderBot",
  ]);
  assertEquals(markers.length, 1);
  assertEquals(markers[0]?.machineId, "host-A");
});

Deno.test("stuck issue detector - scanHeartbeatMarkers honours all authors when no fleet list is given (Issue #3164)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return JSON.stringify([
        {
          body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-A:1700000000 -->`,
          author: "anyone",
        },
      ]);
    }
    return "";
  };
  // Backward compatibility: no allowedAuthors → author filter disabled.
  const markers = await scanHeartbeatMarkers("org/repo", 10, ghFn);
  assertEquals(markers.length, 1);
});

Deno.test("stuck issue detector - shouldSkipRecoveryForMarker does not skip on a forged fresh marker from a non-fleet author (Issue #3164)", async () => {
  const now = 1700010000;
  const ghFn = async (_args: string[]): Promise<string> => {
    // Attacker posts a far-future (fresh) heartbeat marker.
    return JSON.stringify([
      {
        body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-EVIL:${now + 99999} -->`,
        author: "attacker",
      },
    ]);
  };
  const skip = await shouldSkipRecoveryForMarker(
    "org/repo",
    10,
    "host-ME",
    1800,
    () => now,
    ghFn,
    ["VibeCoderBot"], // fleet allow-list — attacker is not in it
  );
  // Recovery must NOT be suppressed by a forged marker.
  assertEquals(skip, false);
});

Deno.test("stuck issue detector - shouldSkipRecoveryForMarker still skips on a fresh marker from a fleet author (Issue #3164)", async () => {
  const now = 1700010000;
  const ghFn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-OTHER:${now - 60} -->`,
        author: "stsvcbot",
      },
    ]);
  };
  const skip = await shouldSkipRecoveryForMarker(
    "org/repo",
    10,
    "host-ME",
    1800,
    () => now,
    ghFn,
    ["VibeCoderBot", "stsvcbot"],
  );
  assertEquals(skip, true);
});

Deno.test("stuck issue detector - shouldSkipRecoveryForMarker skips when another machine's marker is fresh", async () => {
  const now = 1700010000;
  const ghFn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      { body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-OTHER:${now - 60} -->` },
    ]);
  };
  const skip = await shouldSkipRecoveryForMarker(
    "org/repo",
    10,
    "host-ME",
    1800,
    () => now,
    ghFn,
  );
  assertEquals(skip, true);
});

Deno.test("stuck issue detector - shouldSkipRecoveryForMarker proceeds when marker is stale", async () => {
  const now = 1700010000;
  const ghFn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      { body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-OTHER:${now - 5000} -->` },
    ]);
  };
  const skip = await shouldSkipRecoveryForMarker(
    "org/repo",
    10,
    "host-ME",
    1800,
    () => now,
    ghFn,
  );
  assertEquals(skip, false);
});

Deno.test("stuck issue detector - shouldSkipRecoveryForMarker skips when marker matches this machine", async () => {
  const now = 1700010000;
  const ghFn = async (_args: string[]): Promise<string> => {
    // Marker is stale by epoch but belongs to this machine — lost local state
    return JSON.stringify([
      { body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-ME:${now - 9999} -->` },
    ]);
  };
  const skip = await shouldSkipRecoveryForMarker(
    "org/repo",
    10,
    "host-ME",
    1800,
    () => now,
    ghFn,
  );
  assertEquals(skip, true);
});

Deno.test("stuck issue detector - shouldSkipRecoveryForMarker returns false when no markers", async () => {
  const ghFn = async (_args: string[]): Promise<string> => JSON.stringify([]);
  const skip = await shouldSkipRecoveryForMarker(
    "org/repo",
    10,
    "host-ME",
    1800,
    () => 1700010000,
    ghFn,
  );
  assertEquals(skip, false);
});

Deno.test("stuck issue detector - detectAssignedWithoutHeartbeat skips when another machine's marker is fresh", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    config.repos = ["org/repo"];
    config.machineId = "host-ME";
    const unassigned: number[] = [];
    const now = 1700010000;
    const oldUpdatedAt = new Date(
      (now - config.assignedNoHeartbeatTimeout - 100) * 1000,
    ).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          { number: 10, updatedAt: oldUpdatedAt, title: "Machine A's work" },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([
          {
            body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-OTHER:${now - 30} -->`,
          },
        ]);
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
    );
    assertEquals(recovered, 0);
    assertEquals(unassigned.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - detectAssignedWithoutHeartbeat recovers when marker is stale", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    config.repos = ["org/repo"];
    config.machineId = "host-ME";
    const unassigned: number[] = [];
    const now = 1700010000;
    const oldUpdatedAt = new Date(
      (now - config.assignedNoHeartbeatTimeout - 100) * 1000,
    ).toISOString();

    // Issue #1787: stub returns the richer issues_all projection.
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 10,
            updatedAt: oldUpdatedAt,
            title: "Abandoned work",
            assignees: [{ login: "testuser" }],
            labels: [],
            createdAt: oldUpdatedAt,
            milestone: null,
            author: { login: "alice" },
            url: "u",
          },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        // Marker is far older than the timeout and does not match this machine
        return JSON.stringify([
          {
            body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-GHOST:${
              now - 9999
            } -->`,
          },
        ]);
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
    );
    assertEquals(recovered, 1);
    assertEquals(unassigned[0], 10);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - detectAssignedWithoutHeartbeat falls back to updatedAt when no marker", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    config.repos = ["org/repo"];
    config.machineId = "host-ME";
    const unassigned: number[] = [];
    const now = 1700010000;
    const oldUpdatedAt = new Date(
      (now - config.assignedNoHeartbeatTimeout - 100) * 1000,
    ).toISOString();

    // Issue #1787: stub returns the richer issues_all projection.
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 10,
            updatedAt: oldUpdatedAt,
            title: "No marker",
            assignees: [{ login: "testuser" }],
            labels: [],
            createdAt: oldUpdatedAt,
            milestone: null,
            author: { login: "alice" },
            url: "u",
          },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([]); // No markers
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
    );
    assertEquals(recovered, 1);
    assertEquals(unassigned[0], 10);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - detectAssignedWithoutHeartbeat skips when marker matches this machine", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    config.repos = ["org/repo"];
    config.machineId = "host-ME";
    const unassigned: number[] = [];
    const now = 1700010000;
    const oldUpdatedAt = new Date(
      (now - config.assignedNoHeartbeatTimeout - 100) * 1000,
    ).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 10,
            updatedAt: oldUpdatedAt,
            title: "Ours, missing local heartbeat",
          },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        // Epoch is outside the timeout window but machineId matches
        return JSON.stringify([
          { body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-ME:${now - 9999} -->` },
        ]);
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
    );
    assertEquals(recovered, 0);
    assertEquals(unassigned.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - recoverStaleGithubAssignments skips when marker fresh from another machine", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    config.repos = ["org/repo"];
    config.machineId = "host-ME";
    const unassigned: number[] = [];
    const now = 1700010000;
    const oldUpdatedAt = new Date(
      (now - config.staleAssignmentTimeout - 100) * 1000,
    ).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          { number: 20, updatedAt: oldUpdatedAt, title: "Active remote claim" },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([
          {
            body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-OTHER:${now - 60} -->`,
          },
        ]);
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await recoverStaleGithubAssignments(
      config,
      "testuser",
      () => now,
      ghFn,
    );
    assertEquals(recovered, 0);
    assertEquals(unassigned.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - DEFAULT_MARKER_REFRESH_SECONDS is 300", () => {
  assertEquals(DEFAULT_MARKER_REFRESH_SECONDS, 300);
});

// ============================================================================
// seedMarkerState + claimPrefix preservation (Issue #1628)
// ============================================================================

Deno.test("stuck issue detector - seedMarkerState persists claimPrefix for refreshes", async () => {
  const dir = await makeTempDir();
  try {
    await seedMarkerState(dir, "org/repo", 123, {
      commentId: 5555,
      lastRefresh: 1700000000,
      claimPrefix: "<!-- CLAIM_LOCK:my-worker -->\nClaimed by `my-worker`",
    });

    const raw = await Deno.readTextFile(
      markerStateFilePath(dir, "org/repo", 123),
    );
    const state = JSON.parse(raw);
    assertEquals(state.commentId, 5555);
    assertEquals(state.lastRefresh, 1700000000);
    assertEquals(
      state.claimPrefix,
      "<!-- CLAIM_LOCK:my-worker -->\nClaimed by `my-worker`",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - publishOrRefreshMarker preserves claimPrefix on PATCH (Issue #1628)", async () => {
  const dir = await makeTempDir();
  try {
    await seedMarkerState(dir, "org/repo", 42, {
      commentId: 77,
      lastRefresh: 1700000000,
      claimPrefix: "<!-- CLAIM_LOCK:my-worker -->\nClaimed by `my-worker`",
    });

    let patchedBody: string | null = null;
    let patchedCommentId: number | null = null;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        const endpoint = args[1] ?? "";
        const m = endpoint.match(/issues\/comments\/(\d+)/);
        if (m) patchedCommentId = parseInt(m[1]!, 10);
        const bodyArg = args.find((a) => a.startsWith("body="));
        if (bodyArg) patchedBody = bodyArg.substring("body=".length);
        return "77";
      }
      return "";
    };

    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-X", ghFn, minRefreshSeconds: 300 },
      () => 1700000400, // past refresh window
    );

    assertEquals(patchedCommentId, 77);
    assertEquals(patchedBody !== null, true);
    assertEquals(
      patchedBody!.includes("<!-- CLAIM_LOCK:my-worker -->"),
      true,
      "PATCH body must preserve the CLAIM_LOCK marker so race detection keeps working",
    );
    assertEquals(
      patchedBody!.includes(formatHeartbeatMarker("host-X", 1700000400)),
      true,
      "PATCH body must include the refreshed heartbeat marker",
    );

    // State after refresh must keep the claimPrefix.
    const state = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 42)),
    );
    assertEquals(
      state.claimPrefix,
      "<!-- CLAIM_LOCK:my-worker -->\nClaimed by `my-worker`",
    );
    assertEquals(state.lastRefresh, 1700000400);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stuck issue detector - publishOrRefreshMarker honours refresh window when claimPrefix is set", async () => {
  const dir = await makeTempDir();
  try {
    await seedMarkerState(dir, "org/repo", 42, {
      commentId: 77,
      lastRefresh: 1700000000,
      claimPrefix: "<!-- CLAIM_LOCK:my-worker -->",
    });

    let patchCount = 0;
    let postCount = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        patchCount++;
        return "77";
      }
      if (args.includes("POST")) {
        postCount++;
        return "77";
      }
      return "";
    };

    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-X", ghFn, minRefreshSeconds: 300 },
      () => 1700000100, // inside window
    );

    assertEquals(patchCount, 0, "must not refresh inside window");
    assertEquals(postCount, 0, "must not post a new comment inside window");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Cleared heartbeat markers (Issue #1886)
// ============================================================================

Deno.test("stuck issue detector - parseHeartbeatMarker returns cleared=true for epoch=0 with cleared suffix", () => {
  const body = `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-A:0 --> ` +
    `<!-- cleared: claim released by machine host-A -->`;
  assertEquals(
    parseHeartbeatMarker(body),
    { machineId: "host-A", epoch: 0, cleared: true },
  );
});

Deno.test("stuck issue detector - parseHeartbeatMarker returns cleared=false when only epoch=0 (no cleared suffix)", () => {
  const body = `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-A:0 -->`;
  assertEquals(
    parseHeartbeatMarker(body),
    { machineId: "host-A", epoch: 0, cleared: false },
  );
});

Deno.test("stuck issue detector - parseHeartbeatMarker returns cleared=false when cleared suffix appears with non-zero epoch", () => {
  // The cleared suffix is only meaningful alongside epoch=0. A live
  // marker with a stray cleared comment should not be misclassified.
  const body = `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-A:1700000000 --> ` +
    `<!-- cleared: claim released by machine host-A -->`;
  assertEquals(
    parseHeartbeatMarker(body),
    { machineId: "host-A", epoch: 1700000000, cleared: false },
  );
});

Deno.test("stuck issue detector - parseHeartbeatMarker returns cleared=false for live marker", () => {
  const body = `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-A:1700000000 -->`;
  assertEquals(
    parseHeartbeatMarker(body),
    { machineId: "host-A", epoch: 1700000000, cleared: false },
  );
});

Deno.test("stuck issue detector - shouldSkipRecoveryForMarker skips when any cleared marker is present", async () => {
  const now = 1_700_010_000;
  const ghFn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      {
        body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-OTHER:0 --> ` +
          `<!-- cleared: claim released by machine host-OTHER -->`,
      },
    ]);
  };
  const skip = await shouldSkipRecoveryForMarker(
    "org/repo",
    10,
    "host-ME",
    1800,
    () => now,
    ghFn,
  );
  assertEquals(skip, true);
});

Deno.test("stuck issue detector - shouldSkipRecoveryForMarker skips when cleared marker coexists with stale live marker", async () => {
  // A cleared marker plus an older live-shaped marker on a separate
  // comment — most-recent action was a clean release, so we must skip.
  const now = 1_700_010_000;
  const ghFn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      { body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-OTHER:${now - 9999} -->` },
      {
        body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-OTHER:0 --> ` +
          `<!-- cleared: claim released by machine host-OTHER -->`,
      },
    ]);
  };
  const skip = await shouldSkipRecoveryForMarker(
    "org/repo",
    10,
    "host-ME",
    1800,
    () => now,
    ghFn,
  );
  assertEquals(skip, true);
});

Deno.test("stuck issue detector - shouldSkipRecoveryForMarker still proceeds when zero-epoch marker has no cleared suffix", async () => {
  // epoch=0 without the explicit cleared suffix is treated as a stale
  // marker, not a release signal — fall through to updatedAt logic.
  const now = 1_700_010_000;
  const ghFn = async (_args: string[]): Promise<string> => {
    return JSON.stringify([
      { body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-OTHER:0 -->` },
    ]);
  };
  const skip = await shouldSkipRecoveryForMarker(
    "org/repo",
    10,
    "host-ME",
    1800,
    () => now,
    ghFn,
  );
  assertEquals(skip, false);
});

Deno.test("stuck issue detector - scanHeartbeatMarkers exposes cleared flag", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return JSON.stringify([
        {
          body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-A:0 --> ` +
            `<!-- cleared: claim released by machine host-A -->`,
        },
        { body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-B:1700000500 -->` },
      ]);
    }
    return "";
  };
  const markers = await scanHeartbeatMarkers("org/repo", 10, ghFn);
  assertEquals(markers.length, 2);
  assertEquals(markers[0], { machineId: "host-A", epoch: 0, cleared: true });
  assertEquals(markers[1], {
    machineId: "host-B",
    epoch: 1700000500,
    cleared: false,
  });
});
