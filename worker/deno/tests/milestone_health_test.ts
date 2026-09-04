/**
 * Tests for milestone health diagnostics.
 *
 * Issue #1239: Add milestone health diagnostics command.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatMilestoneHealthReport,
  getMilestoneHealth,
  type MilestoneHealthDeps,
  type MilestoneHealthReport,
  type MilestoneIssueStatus,
} from "../lib/milestone_health.ts";
import { clearDefaultBranchMemoryCache } from "../lib/shell_helpers.ts";
import { setCachedDefaultBranch } from "../lib/default_branch_cache.ts";

// Issue #1805: milestone_health now reads default-branch through the
// shared in-process + persistent cache. Reset the in-process cache
// before each test so scenarios stay isolated. The persistent cache is
// pointed at a throwaway file so it never reaches the real disk.
//
// Issue #964: the path is handed to `getMilestoneHealth` as
// `defaultBranchCachePath` rather than exported into the process
// environment — a `Deno.env.set` here races every other worker under
// `deno test --parallel` and is what kept this suite in the gate's serial
// second pass.

async function withFreshCaches<T>(
  fn: (cachePath: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "milestone-health-test-" });
  const path = `${dir}/cache.json`;
  clearDefaultBranchMemoryCache();
  try {
    return await fn(path);
  } finally {
    clearDefaultBranchMemoryCache();
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Build a single open-issue payload in the shape `fetchAllIssues`
 * expects from gh CLI (Issue #1805 — milestone_health now reads
 * through the shared `issues_all` cache).
 */
function buildAllIssuesItem(args: {
  number: number;
  title: string;
  assignees?: string[];
  body?: string;
  milestone?: string;
}): Record<string, unknown> {
  return {
    number: args.number,
    title: args.title,
    assignees: (args.assignees ?? []).map((login) => ({ login })),
    labels: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    author: { login: "alice" },
    milestone: args.milestone ? { title: args.milestone } : null,
    url: "https://example/issue",
    body: args.body ?? "",
  };
}

/**
 * Build a GraphQL response payload for the combined branch existence +
 * compare query introduced in Issue #1805. Pass `null` for `compare` to
 * model a missing branch.
 */
function buildGraphQLBranchResponse(
  compare: { aheadBy: number; behindBy: number } | null,
): string {
  const ref = compare === null ? null : { compare };
  return JSON.stringify({ data: { repository: { ref } } });
}

// ============================================================================
// Helper: build a mock GhCommandFn
// ============================================================================

/**
 * Build a mock gh command function from a response map.
 *
 * Keys are substrings matched against the joined args. First match wins.
 */
function buildMockGhFn(
  responses: Record<string, string>,
): (args: string[]) => Promise<string> {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return response;
      }
    }
    return "[]";
  };
}

// ============================================================================
// getMilestoneHealth — basic scenarios
// ============================================================================

Deno.test("getMilestoneHealth - returns empty report when no repos configured", async () => {
  const deps: MilestoneHealthDeps = {
    repos: [],
    ghCommandFn: buildMockGhFn({}),
  };

  const result = await getMilestoneHealth(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.repos.length, 0);
  }
});

Deno.test("getMilestoneHealth - resolves the default branch from the cache path it is given (Issue #964)", async () => {
  await withFreshCaches(async (cachePath) => {
    // A branch name that exists nowhere but this throwaway file. A code
    // path that ignored `defaultBranchCachePath` and fell back to the
    // process default would miss the warm entry and ask gh instead.
    await setCachedDefaultBranch("owner/repo", "sentinel-964-main", cachePath);

    let defaultBranchCalls = 0;
    const deps: MilestoneHealthDeps = {
      defaultBranchCachePath: cachePath,
      repos: ["owner/repo"],
      ghCommandFn: (args: string[]) => {
        const key = args.join(" ");
        if (key.includes(".default_branch")) {
          defaultBranchCalls += 1;
          return Promise.resolve("main");
        }
        return Promise.resolve("[]");
      },
    };

    const result = await getMilestoneHealth(deps);
    assertEquals(result.ok, true);
    assertEquals(
      defaultBranchCalls,
      0,
      "the branch must come from the cache path the deps named, not gh",
    );
  });
});

Deno.test("getMilestoneHealth - returns empty report when repo has no milestones", async () => {
  await withFreshCaches(async (cachePath) => {
    const deps: MilestoneHealthDeps = {
      defaultBranchCachePath: cachePath,
      repos: ["owner/repo"],
      // Issue #1805: default-branch resolves via `--jq .default_branch`.
      ghCommandFn: buildMockGhFn({
        "repos/owner/repo/milestones": "[]",
        ".default_branch": "main",
      }),
    };

    const result = await getMilestoneHealth(deps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.repos.length, 1);
      assertEquals(result.value.repos[0]!.milestones.length, 0);
    }
  });
});

Deno.test("getMilestoneHealth - reports milestone with mixed issue states", async () => {
  await withFreshCaches(async (cachePath) => {
    // Issue #1805: open issues now flow through `fetchAllIssues` (the
    // shared `issues_all` cache) and branch info via GraphQL.
    const milestones = [{ title: "OIDC", number: 1 }];
    // Issue #1908: closed-batch payload tags each issue with milestone.
    const closedIssues = [
      {
        number: 101,
        title: "Add OIDC discovery endpoint",
        milestone: { title: "OIDC" },
      },
      {
        number: 102,
        title: "Implement token validation",
        milestone: { title: "OIDC" },
      },
    ];
    const openIssues = [
      buildAllIssuesItem({
        number: 103,
        title: "Add integration tests",
        assignees: ["worker-bot"],
        body: "",
        milestone: "OIDC",
      }),
      buildAllIssuesItem({
        number: 104,
        title: "Update documentation",
        body: "Depends on #103",
        milestone: "OIDC",
      }),
    ];

    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify(milestones);
      }
      // GraphQL combined branch + compare (Issue #1805).
      if (
        key.includes("graphql") &&
        key.includes("milestoneRef=refs/heads/milestone/oidc")
      ) {
        return buildGraphQLBranchResponse({ aheadBy: 3, behindBy: 0 });
      }
      // Issue #1908: closed batch is fetched without --milestone; filter happens locally.
      if (key.includes("--state closed")) {
        return JSON.stringify(closedIssues);
      }
      if (key.includes("--state open") && !key.includes("--milestone")) {
        return JSON.stringify(openIssues);
      }
      if (key.includes("repos/owner/repo") && key.includes(".default_branch")) {
        return "main";
      }
      return "[]";
    };

    const deps: MilestoneHealthDeps = {
      defaultBranchCachePath: cachePath,
      repos: ["owner/repo"],
      ghCommandFn: ghFn,
    };

    const result = await getMilestoneHealth(deps);
    assertEquals(result.ok, true);
    if (result.ok) {
      const report = result.value;
      assertEquals(report.repos.length, 1);
      const repoReport = report.repos[0]!;
      assertEquals(repoReport.milestones.length, 1);

      const ms = repoReport.milestones[0]!;
      assertEquals(ms.title, "OIDC");
      assertEquals(ms.closedCount, 2);
      assertEquals(ms.openCount, 2);
      assertEquals(ms.totalCount, 4);
      assertEquals(ms.issues.length, 4);

      // Verify closed issues
      const closedStatuses = ms.issues.filter((i) => i.state === "closed");
      assertEquals(closedStatuses.length, 2);

      // Verify assigned issue
      const assigned = ms.issues.find((i) => i.number === 103);
      assertEquals(assigned?.state, "assigned");
      assertEquals(assigned?.assignee, "worker-bot");

      // Verify blocked issue (depends on open #103)
      const blocked = ms.issues.find((i) => i.number === 104);
      assertEquals(blocked?.state, "blocked");
      assertStringIncludes(blocked?.blockReason ?? "", "#103");

      // Branch info
      assertEquals(ms.branch?.aheadBy, 3);
      assertEquals(ms.branch?.behindBy, 0);
    }
  });
});

Deno.test("getMilestoneHealth - handles missing milestone branch gracefully", async () => {
  await withFreshCaches(async (cachePath) => {
    const milestones = [{ title: "v2.0", number: 2 }];
    // Issue #1908: closed-batch payload tags each issue with milestone.
    const closedIssues = [{
      number: 201,
      title: "Feature A",
      milestone: { title: "v2.0" },
    }];

    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify(milestones);
      }
      if (key.includes("repos/owner/repo") && key.includes(".default_branch")) {
        return "main";
      }
      // Issue #1805: GraphQL signals "branch missing" via `ref: null`.
      if (
        key.includes("graphql") &&
        key.includes("milestoneRef=refs/heads/milestone/v2-0")
      ) {
        return buildGraphQLBranchResponse(null);
      }
      if (key.includes("--state closed")) return JSON.stringify(closedIssues);
      if (key.includes("--state open")) return "[]";
      return "[]";
    };

    const deps: MilestoneHealthDeps = {
      defaultBranchCachePath: cachePath,
      repos: ["owner/repo"],
      ghCommandFn: ghFn,
    };

    const result = await getMilestoneHealth(deps);
    assertEquals(result.ok, true);
    if (result.ok) {
      const ms = result.value.repos[0]!.milestones[0]!;
      assertEquals(ms.branch, undefined);
    }
  });
});

Deno.test("getMilestoneHealth - pending issue has no assignee and no dependencies", async () => {
  await withFreshCaches(async (cachePath) => {
    const milestones = [{ title: "Alpha", number: 3 }];
    const openIssues = [
      buildAllIssuesItem({
        number: 301,
        title: "Unassigned task",
        body: "",
        milestone: "Alpha",
      }),
    ];

    const deps: MilestoneHealthDeps = {
      defaultBranchCachePath: cachePath,
      repos: ["owner/repo"],
      ghCommandFn: buildMockGhFn({
        "repos/owner/repo/milestones": JSON.stringify(milestones),
        ".default_branch": "main",
        "--state closed": "[]",
        // `fetchAllIssues` does not pass `--milestone` — match by `--state open`.
        "--state open": JSON.stringify(openIssues),
        // Issue #1805: GraphQL combined branch + compare for milestone/alpha.
        "milestoneRef=refs/heads/milestone/alpha": buildGraphQLBranchResponse({
          aheadBy: 0,
          behindBy: 0,
        }),
      }),
    };

    const result = await getMilestoneHealth(deps);
    assertEquals(result.ok, true);
    if (result.ok) {
      const issue = result.value.repos[0]!.milestones[0]!.issues[0]!;
      assertEquals(issue.state, "pending");
      assertEquals(issue.assignee, undefined);
    }
  });
});

// ============================================================================
// getMilestoneHealth — multiple repos
// ============================================================================

Deno.test("getMilestoneHealth - handles multiple repos", async () => {
  await withFreshCaches(async (cachePath) => {
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/org/repo1/milestones")) {
        return JSON.stringify([{ title: "M1", number: 1 }]);
      }
      if (key.includes("repos/org/repo2/milestones")) {
        return "[]";
      }
      if (
        (key.includes("repos/org/repo1") || key.includes("repos/org/repo2")) &&
        key.includes(".default_branch")
      ) {
        return "main";
      }
      // Issue #1908: closed batch is fetched without --milestone.
      if (key.includes("--state closed")) {
        return "[]";
      }
      if (key.includes("--state open") && !key.includes("--milestone")) {
        return "[]";
      }
      // Issue #1805: GraphQL returns ref:null when the branch is absent.
      if (key.includes("graphql")) {
        return buildGraphQLBranchResponse(null);
      }
      return "[]";
    };

    const deps: MilestoneHealthDeps = {
      defaultBranchCachePath: cachePath,
      repos: ["org/repo1", "org/repo2"],
      ghCommandFn: ghFn,
    };

    const result = await getMilestoneHealth(deps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.repos.length, 2);
      assertEquals(result.value.repos[0]!.milestones.length, 1);
      assertEquals(result.value.repos[1]!.milestones.length, 0);
    }
  });
});

// ============================================================================
// getMilestoneHealth — error handling
// ============================================================================

Deno.test("getMilestoneHealth - continues when one repo fails", async () => {
  await withFreshCaches(async (cachePath) => {
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/org/bad-repo")) {
        throw new Error("Permission denied");
      }
      if (key.includes("repos/org/good-repo/milestones")) return "[]";
      if (
        key.includes("repos/org/good-repo") && key.includes(".default_branch")
      ) {
        return "main";
      }
      return "[]";
    };

    const deps: MilestoneHealthDeps = {
      defaultBranchCachePath: cachePath,
      repos: ["org/bad-repo", "org/good-repo"],
      ghCommandFn: ghFn,
    };

    const result = await getMilestoneHealth(deps);
    assertEquals(result.ok, true);
    if (result.ok) {
      // Bad repo should be skipped, good repo included
      assertEquals(result.value.repos.length, 1);
      assertEquals(result.value.repos[0]!.repo, "org/good-repo");
    }
  });
});

// ============================================================================
// formatMilestoneHealthReport
// ============================================================================

Deno.test("formatMilestoneHealthReport - formats empty report", () => {
  const report: MilestoneHealthReport = { repos: [] };
  const output = formatMilestoneHealthReport(report);
  assertStringIncludes(output, "No repositories");
});

Deno.test("formatMilestoneHealthReport - formats repo with no milestones", () => {
  const report: MilestoneHealthReport = {
    repos: [{ repo: "owner/repo", milestones: [] }],
  };
  const output = formatMilestoneHealthReport(report);
  assertStringIncludes(output, "owner/repo");
  assertStringIncludes(output, "No active milestones");
});

Deno.test("formatMilestoneHealthReport - formats milestone with issues", () => {
  const issues: MilestoneIssueStatus[] = [
    { number: 101, title: "Done task", state: "closed" },
    {
      number: 102,
      title: "In progress",
      state: "assigned",
      assignee: "worker",
    },
    { number: 103, title: "Waiting", state: "pending" },
    {
      number: 104,
      title: "Stuck",
      state: "blocked",
      blockReason: "depends on #103",
    },
  ];

  const report: MilestoneHealthReport = {
    repos: [{
      repo: "owner/repo",
      milestones: [{
        title: "OIDC",
        closedCount: 1,
        openCount: 3,
        totalCount: 4,
        issues,
        branch: { name: "milestone/oidc", aheadBy: 5, behindBy: 1 },
        statusSummary: "In progress — 1 issue assigned, 1 blocked",
      }],
    }],
  };

  const output = formatMilestoneHealthReport(report);

  // Check structure
  assertStringIncludes(output, "Repository: owner/repo");
  assertStringIncludes(output, "Milestone: OIDC (1/4 issues complete)");
  assertStringIncludes(output, "✅ #101: Done task");
  assertStringIncludes(output, "🔄 #102: In progress (assigned to worker)");
  assertStringIncludes(output, "⏳ #103: Waiting");
  assertStringIncludes(output, "⏳ #104: Stuck (blocked: depends on #103)");
  assertStringIncludes(
    output,
    "Branch: milestone/oidc (5 commits ahead, 1 behind default)",
  );
  assertStringIncludes(output, "Status: In progress");
});

Deno.test("formatMilestoneHealthReport - shows completed milestone status", () => {
  const report: MilestoneHealthReport = {
    repos: [{
      repo: "owner/repo",
      milestones: [{
        title: "v1.0",
        closedCount: 3,
        openCount: 0,
        totalCount: 3,
        issues: [
          { number: 1, title: "A", state: "closed" },
          { number: 2, title: "B", state: "closed" },
          { number: 3, title: "C", state: "closed" },
        ],
        branch: { name: "milestone/v1-0", aheadBy: 10, behindBy: 0 },
        statusSummary: "Complete — all issues closed",
      }],
    }],
  };

  const output = formatMilestoneHealthReport(report);
  assertStringIncludes(output, "3/3 issues complete");
  assertStringIncludes(output, "Complete");
});

// ============================================================================
// Comparison direction — GraphQL must agree with its own REST fallback
// (Issue #470)
// ============================================================================

/**
 * Milestone-branch drift used by the direction tests: five commits ahead of
 * the default branch and two behind it. Both counts are non-zero and
 * different, so a swapped answer is unambiguous.
 */
const DRIFT_AHEAD = 5;
const DRIFT_BEHIND = 2;

/**
 * Commits reachable from each ref. `milestone/oidc` carries five commits
 * `main` lacks; `main` carries two `milestone/oidc` lacks.
 */
const DRIFT_COMMITS: Record<string, string[]> = {
  "main": ["c1", "c2", "m1", "m2"],
  "milestone/oidc": ["c1", "c2", "b1", "b2", "b3", "b4", "b5"],
};

/**
 * Answer the branch-drift GraphQL query the way GitHub does: the ref the
 * `compare` field hangs off is the comparison **base**, and the `headRef:`
 * argument is the comparison **head**. The query names its refs through
 * variables, so resolve those from the `-F` arguments before comparing.
 */
function answerDriftQuery(args: string[]): string {
  const query = args.find((a) => a.startsWith("query="))?.slice(6) ?? "";
  const variables: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-F") continue;
    const [name, ...rest] = args[i + 1]!.split("=");
    variables[name!] = rest.join("=").replace(/^refs\/heads\//, "");
  }

  const shape = query.match(
    /ref\(qualifiedName:\$(\w+)\)\{compare\(headRef:\$(\w+)\)/,
  );
  if (!shape) throw new Error(`Unrecognised drift query: ${query}`);
  const comparisonBase = variables[shape[1]!] ?? "";
  const comparisonHead = variables[shape[2]!] ?? "";

  const baseCommits = DRIFT_COMMITS[comparisonBase] ?? [];
  const headCommits = DRIFT_COMMITS[comparisonHead] ?? [];
  return buildGraphQLBranchResponse({
    aheadBy: headCommits.filter((c) => !baseCommits.includes(c)).length,
    behindBy: baseCommits.filter((c) => !headCommits.includes(c)).length,
  });
}

/**
 * Fake gh for the drift tests. `graphqlWorks: false` makes the GraphQL call
 * fail so the REST fallback runs instead, which is how the two paths are
 * compared against each other.
 */
function driftGhFn(graphqlWorks: boolean): (a: string[]) => Promise<string> {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("repos/owner/repo/milestones")) {
      return JSON.stringify([{ title: "OIDC", number: 1 }]);
    }
    if (key.includes("graphql")) {
      if (!graphqlWorks) throw new Error("GraphQL unavailable");
      return answerDriftQuery(args);
    }
    // REST fallback pair: branch existence, then `compare/<base>...<head>`.
    if (key.includes("/branches/milestone/oidc")) {
      return JSON.stringify({ name: "milestone/oidc" });
    }
    const rest = key.match(/compare\/([^.]+)\.\.\.(\S+)/);
    if (rest) {
      const baseCommits = DRIFT_COMMITS[rest[1]!] ?? [];
      const headCommits = DRIFT_COMMITS[rest[2]!] ?? [];
      return JSON.stringify({
        ahead_by: headCommits.filter((c) => !baseCommits.includes(c)).length,
        behind_by: baseCommits.filter((c) => !headCommits.includes(c)).length,
      });
    }
    if (key.includes("repos/owner/repo") && key.includes(".default_branch")) {
      return "main";
    }
    return "[]";
  };
}

async function driftFor(
  graphqlWorks: boolean,
): Promise<{ aheadBy: number; behindBy: number }> {
  return await withFreshCaches(async (cachePath) => {
    const result = await getMilestoneHealth({
      defaultBranchCachePath: cachePath,
      repos: ["owner/repo"],
      ghCommandFn: driftGhFn(graphqlWorks),
    });
    assertEquals(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    const branch = result.value.repos[0]!.milestones[0]!.branch;
    if (!branch) throw new Error("branch drift missing from report");
    return { aheadBy: branch.aheadBy, behindBy: branch.behindBy };
  });
}

Deno.test("getMilestoneHealth - GraphQL reports milestone drift the same way round as REST (Issue #470)", async () => {
  const viaGraphQL = await driftFor(true);
  const viaRest = await driftFor(false);

  assertEquals(
    viaGraphQL,
    viaRest,
    "the GraphQL path and its own REST fallback must not disagree about which way round the drift runs (Issue #470)",
  );
});

Deno.test("getMilestoneHealth - milestone branch ahead of default is not reported as behind it (Issue #470)", async () => {
  const drift = await driftFor(true);

  assertEquals(
    drift.aheadBy,
    DRIFT_AHEAD,
    "the milestone branch carries five commits the default branch lacks",
  );
  assertEquals(
    drift.behindBy,
    DRIFT_BEHIND,
    "the default branch carries two commits the milestone branch lacks",
  );
});
