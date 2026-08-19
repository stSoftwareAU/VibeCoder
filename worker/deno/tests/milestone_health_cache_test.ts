/**
 * Tests for cache wiring in `milestone_health.ts` (Issue #1805).
 *
 * Validates that the three call sites called out in the issue actually
 * resolve via the cached/shared helpers:
 *
 *   1. Default branch resolves via the persistent default-branch cache
 *      so a warm hit needs no `gh api repos/{repo}` call.
 *   2. Open-issues per milestone reads through the shared `issues_all`
 *      cache via `fetchOpenIssuesByMilestone`, so a follow-up scan in
 *      the same iteration is free.
 *   3. Branch info is fetched via a single GraphQL `repository.ref`
 *      query, with a REST fallback when GraphQL fails.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { getMilestoneHealth } from "../lib/milestone_health.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  clearDefaultBranchMemoryCache,
  getRepoDefaultBranch,
} from "../lib/shell_helpers.ts";
import { setCachedDefaultBranch } from "../lib/default_branch_cache.ts";

const CACHE_ENV = "VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH";

async function withIsolatedDefaultBranchCache<T>(
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "milestone-health-1805-" });
  const path = `${dir}/cache.json`;
  const previous = Deno.env.get(CACHE_ENV);
  Deno.env.set(CACHE_ENV, path);
  clearDefaultBranchMemoryCache();
  try {
    return await fn(path);
  } finally {
    if (previous === undefined) {
      Deno.env.delete(CACHE_ENV);
    } else {
      Deno.env.set(CACHE_ENV, previous);
    }
    clearDefaultBranchMemoryCache();
    await Deno.remove(dir, { recursive: true });
  }
}

function makeIssueCache(ttlSeconds = 600): { cache: IssueCache; dir: string } {
  const dir = Deno.makeTempDirSync({ prefix: "milestone-health-cache-1805-" });
  return { cache: new IssueCache(dir, ttlSeconds), dir };
}

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

function buildGraphQLBranchResponse(
  compare: { aheadBy: number; behindBy: number } | null,
): string {
  const ref = compare === null ? null : { compare };
  return JSON.stringify({ data: { repository: { ref } } });
}

// ---------------------------------------------------------------------------
// Site 1: default branch resolves via the persistent cache.
// ---------------------------------------------------------------------------

Deno.test(
  "milestone_health (Issue #1805) — default branch served from persistent cache without a second gh call",
  async () => {
    await withIsolatedDefaultBranchCache(async () => {
      // Pre-seed the persistent cache so the helper resolves without
      // ever calling the gh CLI for the default branch.
      await setCachedDefaultBranch("owner/repo", "main");

      let defaultBranchCalls = 0;
      const ghFn = (args: string[]): Promise<string> => {
        const key = args.join(" ");
        if (
          key.includes("repos/owner/repo") && key.includes(".default_branch")
        ) {
          defaultBranchCalls += 1;
          return Promise.resolve("main");
        }
        if (key.includes("repos/owner/repo/milestones")) {
          return Promise.resolve("[]");
        }
        return Promise.resolve("[]");
      };

      const result = await getMilestoneHealth({
        repos: ["owner/repo"],
        ghCommandFn: ghFn,
      });

      assertEquals(result.ok, true);
      assertEquals(
        defaultBranchCalls,
        0,
        "default branch must come from cache, not gh",
      );
    });
  },
);

Deno.test(
  "milestone_health (Issue #1805) — getRepoDefaultBranch returns persistent cache value before invoking ghCommandFn",
  async () => {
    await withIsolatedDefaultBranchCache(async () => {
      await setCachedDefaultBranch("owner/cached-repo", "trunk");

      let calls = 0;
      const ghFn = (_args: string[]): Promise<string> => {
        calls += 1;
        return Promise.resolve("should-not-be-used");
      };

      const result = await getRepoDefaultBranch("owner/cached-repo", ghFn);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value, "trunk");
      }
      assertEquals(calls, 0);
    });
  },
);

// ---------------------------------------------------------------------------
// Site 2: open-issues per milestone reads through the IssueCache.
// ---------------------------------------------------------------------------

Deno.test(
  "milestone_health (Issue #1805) — second milestone scan in the same iteration hits the issues_all cache",
  async () => {
    await withIsolatedDefaultBranchCache(async () => {
      await setCachedDefaultBranch("owner/repo", "main");

      const milestones = [
        { title: "v1.0", number: 1 },
        { title: "v2.0", number: 2 },
      ];
      const allOpenIssues = [
        buildAllIssuesItem({
          number: 11,
          title: "Open A",
          milestone: "v1.0",
        }),
        buildAllIssuesItem({
          number: 22,
          title: "Open B",
          milestone: "v2.0",
        }),
      ];

      let openIssueListCalls = 0;
      const ghFn = (args: string[]): Promise<string> => {
        const key = args.join(" ");
        if (key.includes("repos/owner/repo/milestones")) {
          return Promise.resolve(JSON.stringify(milestones));
        }
        if (key.includes("--state closed")) {
          return Promise.resolve("[]");
        }
        if (key.includes("--state open") && !key.includes("--milestone")) {
          openIssueListCalls += 1;
          return Promise.resolve(JSON.stringify(allOpenIssues));
        }
        if (key.includes("graphql")) {
          return Promise.resolve(buildGraphQLBranchResponse(null));
        }
        return Promise.resolve("[]");
      };

      const { cache, dir } = makeIssueCache();
      try {
        // Two calls to getMilestoneHealth using the same cache. The
        // second scan must serve the open-issues read from cache.
        const r1 = await getMilestoneHealth({
          repos: ["owner/repo"],
          ghCommandFn: ghFn,
          cache,
        });
        assertEquals(r1.ok, true);
        assertEquals(openIssueListCalls, 1);

        const r2 = await getMilestoneHealth({
          repos: ["owner/repo"],
          ghCommandFn: ghFn,
          cache,
        });
        assertEquals(r2.ok, true);

        // The second scan must not have triggered another open-issue
        // list — it should have come from the issues_all cache.
        assertEquals(openIssueListCalls, 1);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
);

Deno.test(
  "milestone_health (Issue #1805) — second milestone in the same scan reuses issues_all without a fresh gh call",
  async () => {
    await withIsolatedDefaultBranchCache(async () => {
      await setCachedDefaultBranch("owner/repo", "main");

      const milestones = [
        { title: "v1.0", number: 1 },
        { title: "v2.0", number: 2 },
      ];
      const allOpenIssues = [
        buildAllIssuesItem({ number: 11, title: "A", milestone: "v1.0" }),
        buildAllIssuesItem({ number: 22, title: "B", milestone: "v2.0" }),
      ];

      let openIssueListCalls = 0;
      const ghFn = (args: string[]): Promise<string> => {
        const key = args.join(" ");
        if (key.includes("repos/owner/repo/milestones")) {
          return Promise.resolve(JSON.stringify(milestones));
        }
        if (key.includes("--state closed")) return Promise.resolve("[]");
        if (key.includes("--state open") && !key.includes("--milestone")) {
          openIssueListCalls += 1;
          return Promise.resolve(JSON.stringify(allOpenIssues));
        }
        if (key.includes("graphql")) {
          return Promise.resolve(buildGraphQLBranchResponse(null));
        }
        return Promise.resolve("[]");
      };

      const { cache, dir } = makeIssueCache();
      try {
        const result = await getMilestoneHealth({
          repos: ["owner/repo"],
          ghCommandFn: ghFn,
          cache,
        });
        assertEquals(result.ok, true);
        // Two milestones share the single `issues_all` payload, so only
        // one underlying gh call is needed for both.
        assertEquals(openIssueListCalls, 1);
        if (result.ok) {
          const ms = result.value.repos[0]!.milestones;
          assertEquals(ms.length, 2);
          assertEquals(ms[0]!.openCount, 1);
          assertEquals(ms[1]!.openCount, 1);
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Site 3: GraphQL combined branch + compare with REST fallback.
// ---------------------------------------------------------------------------

Deno.test(
  "milestone_health (Issue #1805) — branch info fetched via a single GraphQL call when available",
  async () => {
    await withIsolatedDefaultBranchCache(async () => {
      await setCachedDefaultBranch("owner/repo", "main");

      const milestones = [{ title: "v1.0", number: 1 }];
      let graphqlCalls = 0;
      let restCompareCalls = 0;
      let restBranchCalls = 0;

      const ghFn = (args: string[]): Promise<string> => {
        const key = args.join(" ");
        if (key.includes("repos/owner/repo/milestones")) {
          return Promise.resolve(JSON.stringify(milestones));
        }
        if (key.includes("--state closed")) return Promise.resolve("[]");
        if (key.includes("--state open")) return Promise.resolve("[]");
        if (key.includes("graphql")) {
          graphqlCalls += 1;
          return Promise.resolve(
            buildGraphQLBranchResponse({ aheadBy: 5, behindBy: 2 }),
          );
        }
        if (key.includes("/branches/")) {
          restBranchCalls += 1;
          return Promise.resolve("{}");
        }
        if (key.includes("/compare/")) {
          restCompareCalls += 1;
          return Promise.resolve('{"ahead_by":99,"behind_by":99}');
        }
        return Promise.resolve("[]");
      };

      const result = await getMilestoneHealth({
        repos: ["owner/repo"],
        ghCommandFn: ghFn,
      });
      assertEquals(result.ok, true);
      if (result.ok) {
        const branch = result.value.repos[0]!.milestones[0]!.branch;
        assertEquals(branch?.aheadBy, 5);
        assertEquals(branch?.behindBy, 2);
      }
      // Exactly one GraphQL call replaces the previous two REST calls.
      assertEquals(graphqlCalls, 1);
      assertEquals(restBranchCalls, 0);
      assertEquals(restCompareCalls, 0);
    });
  },
);

Deno.test(
  "milestone_health (Issue #1805) — falls back to REST pair when GraphQL fails",
  async () => {
    await withIsolatedDefaultBranchCache(async () => {
      await setCachedDefaultBranch("owner/repo", "main");

      const milestones = [{ title: "v1.0", number: 1 }];
      let graphqlCalls = 0;
      let restBranchCalls = 0;
      let restCompareCalls = 0;

      const ghFn = (args: string[]): Promise<string> => {
        const key = args.join(" ");
        if (key.includes("repos/owner/repo/milestones")) {
          return Promise.resolve(JSON.stringify(milestones));
        }
        if (key.includes("--state closed")) return Promise.resolve("[]");
        if (key.includes("--state open")) return Promise.resolve("[]");
        if (key.includes("graphql")) {
          graphqlCalls += 1;
          // Simulate a transient GraphQL failure — the REST fallback
          // must take over.
          return Promise.reject(new Error("graphql unavailable"));
        }
        if (key.includes("/branches/")) {
          restBranchCalls += 1;
          return Promise.resolve(
            JSON.stringify({ name: "milestone/v1-0", commit: { sha: "abc" } }),
          );
        }
        if (key.includes("/compare/")) {
          restCompareCalls += 1;
          return Promise.resolve(
            JSON.stringify({ ahead_by: 7, behind_by: 1 }),
          );
        }
        return Promise.resolve("[]");
      };

      const result = await getMilestoneHealth({
        repos: ["owner/repo"],
        ghCommandFn: ghFn,
      });
      assertEquals(result.ok, true);
      if (result.ok) {
        const branch = result.value.repos[0]!.milestones[0]!.branch;
        assertEquals(branch?.aheadBy, 7);
        assertEquals(branch?.behindBy, 1);
      }
      assertEquals(graphqlCalls, 1);
      assertEquals(restBranchCalls, 1);
      assertEquals(restCompareCalls, 1);
    });
  },
);

Deno.test(
  "milestone_health (Issue #1805) — GraphQL ref:null reports branch missing without a REST fallback",
  async () => {
    await withIsolatedDefaultBranchCache(async () => {
      await setCachedDefaultBranch("owner/repo", "main");

      const milestones = [{ title: "v1.0", number: 1 }];
      let restBranchCalls = 0;

      const ghFn = (args: string[]): Promise<string> => {
        const key = args.join(" ");
        if (key.includes("repos/owner/repo/milestones")) {
          return Promise.resolve(JSON.stringify(milestones));
        }
        if (key.includes("--state closed")) return Promise.resolve("[]");
        if (key.includes("--state open")) return Promise.resolve("[]");
        if (key.includes("graphql")) {
          return Promise.resolve(buildGraphQLBranchResponse(null));
        }
        if (key.includes("/branches/")) {
          restBranchCalls += 1;
          return Promise.resolve("{}");
        }
        return Promise.resolve("[]");
      };

      const result = await getMilestoneHealth({
        repos: ["owner/repo"],
        ghCommandFn: ghFn,
      });
      assertEquals(result.ok, true);
      if (result.ok) {
        const branch = result.value.repos[0]!.milestones[0]!.branch;
        assertEquals(branch, undefined);
      }
      // GraphQL gave a definitive "branch absent" answer — no REST
      // fallback should fire.
      assertEquals(restBranchCalls, 0);
    });
  },
);
