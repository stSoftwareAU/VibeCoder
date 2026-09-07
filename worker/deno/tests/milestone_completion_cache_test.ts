/**
 * Cache wiring tests for milestone_completion.ts (Issue #1798).
 *
 * Verifies that the refactored helpers in `milestone_completion.ts`
 * resolve through `IssueCache` (cache hit/miss), and that mutation
 * paths (creating tracking issue, creating summary PR, closing tracking
 * issue) invalidate the matching `issues_all_milestone_v2_${n}` /
 * `prs_all_branch_${branch}` keys so a follow-up scan in the same
 * iteration sees fresh state.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  checkAndHandleMilestoneCompletions,
  hasExistingMilestoneSummaryPr,
  hasExistingMilestoneTrackingIssue,
  type MilestoneCompletionDeps,
} from "../lib/milestone_completion.ts";
import { MILESTONE_TRACKING_MARKER } from "../lib/milestone_tracker_identity.ts";

/**
 * Issue #1246: the fleet these fixtures state, so the tracking issues they
 * serve are verifiable as the worker's own rather than merely titled that way.
 */
const VERIFICATION = { authorOptions: { fleetAuthors: ["bot"] } };

async function makeTempDir(prefix = "milestone-cache-"): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}

// ============================================================================
// hasExistingMilestoneSummaryPr — cache hit / miss
// ============================================================================

Deno.test("milestone_completion cache - hasExistingMilestoneSummaryPr serves second call from prs_all_branch cache", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    let prListCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("pr list") && key.includes("--state all")) {
        prListCalls++;
        return JSON.stringify([
          {
            number: 100,
            title: "Milestone: v1.0",
            headRefName: "milestone/v1-0",
          },
        ]);
      }
      return "[]";
    };

    const first = await hasExistingMilestoneSummaryPr(
      "owner/repo",
      "v1.0",
      "milestone/v1-0",
      ghFn,
      cache,
    );
    const second = await hasExistingMilestoneSummaryPr(
      "owner/repo",
      "v1.0",
      "milestone/v1-0",
      ghFn,
      cache,
    );

    assertEquals(first.ok, true);
    assertEquals(second.ok, true);
    if (first.ok) assertEquals(first.value, 100);
    if (second.ok) assertEquals(second.value, 100);
    assertEquals(prListCalls, 1, "second call must hit prs_all_branch cache");

    // Confirm the cache key is shaped as the helper documents.
    const cached = await cache.read(
      "owner/repo",
      "prs_all_branch_milestone/v1-0",
    );
    assertEquals(Array.isArray(cached), true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("milestone_completion cache - hasExistingMilestoneSummaryPr without cache always calls gh", async () => {
  let prListCalls = 0;
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list") && key.includes("--state all")) {
      prListCalls++;
      return JSON.stringify([]);
    }
    return "[]";
  };

  await hasExistingMilestoneSummaryPr(
    "owner/repo",
    "v1.0",
    "milestone/v1-0",
    ghFn,
  );
  await hasExistingMilestoneSummaryPr(
    "owner/repo",
    "v1.0",
    "milestone/v1-0",
    ghFn,
  );
  assertEquals(prListCalls, 2, "no cache → gh called every time");
});

// ============================================================================
// hasExistingMilestoneTrackingIssue — cache hit / miss
// ============================================================================

Deno.test("milestone_completion cache - hasExistingMilestoneTrackingIssue serves second call from issues_all_milestone cache", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    let issueListCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (
        key.includes("issue list") &&
        key.includes("--milestone 1") &&
        key.includes("--state all")
      ) {
        issueListCalls++;
        return JSON.stringify([
          {
            number: 200,
            title: "Merge milestone 'v1.0' to main",
            body: MILESTONE_TRACKING_MARKER,
            author: { login: "bot" },
          },
        ]);
      }
      return "[]";
    };

    const first = await hasExistingMilestoneTrackingIssue(
      "owner/repo",
      "v1.0",
      1,
      "main",
      ghFn,
      cache,
      VERIFICATION,
    );
    const second = await hasExistingMilestoneTrackingIssue(
      "owner/repo",
      "v1.0",
      1,
      "main",
      ghFn,
      cache,
      VERIFICATION,
    );

    assertEquals(first.ok, true);
    assertEquals(second.ok, true);
    if (first.ok) assertEquals(first.value, 200);
    if (second.ok) assertEquals(second.value, 200);
    assertEquals(
      issueListCalls,
      1,
      "second call must hit issues_all_milestone_v2_1 cache",
    );

    const cached = await cache.read("owner/repo", "issues_all_milestone_v2_1");
    assertEquals(Array.isArray(cached), true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("milestone_completion cache - hasExistingMilestoneTrackingIssue partitions cache by milestone number", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    let issueListCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("issue list") && key.includes("--milestone 1")) {
        issueListCalls++;
        return JSON.stringify([
          {
            number: 200,
            title: "Merge milestone 'v1.0' to main",
            body: MILESTONE_TRACKING_MARKER,
            author: { login: "bot" },
          },
        ]);
      }
      if (key.includes("issue list") && key.includes("--milestone 2")) {
        issueListCalls++;
        return JSON.stringify([
          {
            number: 201,
            title: "Merge milestone 'v2.0' to main",
            body: MILESTONE_TRACKING_MARKER,
            author: { login: "bot" },
          },
        ]);
      }
      return "[]";
    };

    await hasExistingMilestoneTrackingIssue(
      "owner/repo",
      "v1.0",
      1,
      "main",
      ghFn,
      cache,
      VERIFICATION,
    );
    await hasExistingMilestoneTrackingIssue(
      "owner/repo",
      "v2.0",
      2,
      "main",
      ghFn,
      cache,
      VERIFICATION,
    );
    // Each (repo, milestoneNumber) pair gets its own cache slot.
    assertEquals(
      issueListCalls,
      2,
      "different milestones must not share a cache slot",
    );

    // Re-reads should both hit cache.
    await hasExistingMilestoneTrackingIssue(
      "owner/repo",
      "v1.0",
      1,
      "main",
      ghFn,
      cache,
      VERIFICATION,
    );
    await hasExistingMilestoneTrackingIssue(
      "owner/repo",
      "v2.0",
      2,
      "main",
      ghFn,
      cache,
      VERIFICATION,
    );
    assertEquals(
      issueListCalls,
      2,
      "re-reads of either milestone must hit cache",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

// ============================================================================
// Mutation invalidates caches — full orchestration
// ============================================================================

function buildOrchestrationGhStub(
  options: {
    onPrCreated?: () => void;
    onTrackingIssueCreated?: () => void;
    onTrackingIssueClosed?: (issueNumber: number) => void;
    existingTrackingIssue?: { number: number; title: string } | null;
    existingSummaryPr?: { number: number; headRefName: string } | null;
  } = {},
): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    const key = args.join(" ");
    // Issue #3908: the fresh authoritative open-children reads — GitHub agrees
    // the milestone has no open children.
    if (key.includes("/issues?milestone=")) {
      return "[]";
    }
    if (/api repos\/[^ ]+\/milestones\/\d+$/.test(key)) {
      return JSON.stringify({ open_issues: 0 });
    }
    if (key.includes("api") && key.endsWith("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      return "[]";
    }
    // Issue #1908: closed batch is fetched without --milestone; payload
    // tags each issue with its milestone for local filtering.
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Add login", milestone: { title: "v1.0" } },
      ]);
    }
    if (
      key.includes("issue list") &&
      key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return options.existingTrackingIssue
        ? JSON.stringify([options.existingTrackingIssue])
        : "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return options.existingSummaryPr
        ? JSON.stringify([{
          ...options.existingSummaryPr,
          title: "Milestone: v1.0",
        }])
        : "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (args[0] === "issue" && args[1] === "create") {
      options.onTrackingIssueCreated?.();
      return "https://github.com/owner/repo/issues/300";
    }
    if (args[0] === "pr" && args[1] === "create") {
      options.onPrCreated?.();
      return "https://github.com/owner/repo/pull/301";
    }
    if (args[0] === "issue" && args[1] === "close") {
      const issueNumStr = args.find((a) => /^\d+$/.test(a));
      if (issueNumStr) options.onTrackingIssueClosed?.(Number(issueNumStr));
      return "";
    }
    return "[]";
  };
}

Deno.test("milestone_completion cache - tracking issue creation invalidates issues_all_milestone cache", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);

    // Pre-populate the milestone-keyed cache so we can verify it gets dropped.
    await cache.write("owner/repo", "issues_all_milestone_v2_1", []);

    const ghFn = buildOrchestrationGhStub({});

    const deps: MilestoneCompletionDeps = {
      repos: ["owner/repo"],
      ghCommandFn: ghFn,
      log: () => {},
      cache,
      authorOptions: { fleetAuthors: ["bot"] },
    };

    const result = await checkAndHandleMilestoneCompletions(deps);
    assertEquals(result.ok, true);

    // After tracking issue create + close, the cache must be invalidated.
    const cached = await cache.read("owner/repo", "issues_all_milestone_v2_1");
    assertEquals(
      cached,
      null,
      "creating + closing tracking issue must drop the milestone cache",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("milestone_completion cache - summary PR creation invalidates prs_all_branch cache", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);

    // Pre-populate the branch-keyed cache so we can verify it gets dropped.
    await cache.write("owner/repo", "prs_all_branch_milestone/v1-0", []);

    let prCreated = 0;
    const ghFn = buildOrchestrationGhStub({
      onPrCreated: () => prCreated++,
    });

    const deps: MilestoneCompletionDeps = {
      repos: ["owner/repo"],
      ghCommandFn: ghFn,
      log: () => {},
      cache,
      authorOptions: { fleetAuthors: ["bot"] },
    };

    const result = await checkAndHandleMilestoneCompletions(deps);
    assertEquals(result.ok, true);
    assertEquals(prCreated, 1, "summary PR must have been created");

    // After PR create, the branch-keyed PR cache must be invalidated.
    const cached = await cache.read(
      "owner/repo",
      "prs_all_branch_milestone/v1-0",
    );
    assertEquals(
      cached,
      null,
      "creating summary PR must drop the branch cache",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("milestone_completion cache - existing tracking issue served via cache reuses lookup", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);

    // Pre-populate the cache with the existing tracking issue.
    await cache.write("owner/repo", "issues_all_milestone_v2_1", [
      {
        number: 200,
        title: "Merge milestone 'v1.0' to main",
        body: MILESTONE_TRACKING_MARKER,
        author: "bot",
      },
    ]);

    let issueListCalls = 0;
    const baseFn = buildOrchestrationGhStub({});
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (
        key.includes("issue list") &&
        key.includes("--state all") &&
        key.includes("--milestone")
      ) {
        issueListCalls++;
      }
      return baseFn(args);
    };

    const deps: MilestoneCompletionDeps = {
      repos: ["owner/repo"],
      ghCommandFn: ghFn,
      log: () => {},
      cache,
      authorOptions: { fleetAuthors: ["bot"] },
    };

    const result = await checkAndHandleMilestoneCompletions(deps);
    assertEquals(result.ok, true);

    // Tracking issue search resolved entirely from cache — no gh issue list
    // --milestone --state all call should have occurred.
    assertEquals(issueListCalls, 0, "tracking issue search must hit cache");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});
