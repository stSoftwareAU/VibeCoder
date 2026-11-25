/**
 * Tests for Issue #5458: a milestone rollup's "Issues addressed" list follows
 * what merged into the milestone branch, not only the milestone's current
 * membership. An issue whose work merged into this branch but which now sits
 * in another milestone is claimed with a note, and a rollup whose only merged
 * PRs went into another milestone's branch flags the issue instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  buildMilestoneSummaryBody,
  checkAndHandleMilestoneCompletions,
  classifyClosedIssues,
  type MilestoneCompletionDeps,
} from "../lib/milestone_completion.ts";
import { fetchIssuesMovedOffBranch } from "../lib/milestone_branch_deliveries.ts";
import { IssueCache } from "../lib/issue_cache.ts";

const REPO = "owner/repo";
const BRANCH_A = "milestone/secret-assignment-rule-hardening";
const BRANCH_B = "milestone/secret-redaction-follow-ups";

/** A merged-PR row as the title search returns it. */
function mergedPr(number: number, title: string, baseRefName: string) {
  return {
    number,
    title,
    baseRefName,
    headRefName: `feature-${number}`,
    mergedAt: "2026-10-05T00:00:00Z",
    author: { login: "bot" },
    isCrossRepository: false,
  };
}

/**
 * The title search for `(#N)` answers with the rows keyed by N; every other
 * `pr list` (the branch search, the `--base` list) answers `[]`.
 */
function titleSearchRows(
  args: string[],
  rowsByIssue: Record<number, unknown[]>,
): string {
  const search = args[args.indexOf("--search") + 1] ?? "";
  const m = search.match(/\(#(\d+)\)/);
  return JSON.stringify(m ? rowsByIssue[Number(m[1])] ?? [] : []);
}

async function withTempCache<T>(
  fn: (cache: IssueCache) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "milestone-deliveries-5458-" });
  try {
    return await fn(new IssueCache(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ============================================================================
// classifyClosedIssues (Issue #5458)
// ============================================================================

Deno.test("classifyClosedIssues - flags merged-into-other-milestone when every merged PR went into another milestone (Issue #5458)", async () => {
  let timelineReads = 0;
  const ghFn = async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("/timeline")) {
      timelineReads++;
      return "[]";
    }
    if (args[0] === "pr" && args[1] === "list") {
      return titleSearchRows(args, { 7: [mergedPr(70, "Fix (#7)", BRANCH_B)] });
    }
    return "[]";
  };

  const result = await classifyClosedIssues(
    REPO,
    BRANCH_A,
    [{ number: 7, title: "Moved" }],
    ghFn,
  );

  assertEquals(result[0]?.claimProblem, "merged-into-other-milestone");
  assertEquals(timelineReads, 0, "no timeline is read for this verdict");
});

Deno.test("classifyClosedIssues - claims an issue merged into the asked milestone branch or into the default branch (Issue #5458)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("/timeline")) return "[]";
    if (args[0] === "pr" && args[1] === "list") {
      return titleSearchRows(args, {
        8: [mergedPr(80, "Asked branch (#8)", BRANCH_A)],
        9: [mergedPr(90, "Default branch (#9)", "main")],
        10: [
          mergedPr(100, "Other milestone (#10)", BRANCH_B),
          mergedPr(101, "Default branch (#10)", "main"),
        ],
      });
    }
    return "[]";
  };

  const result = await classifyClosedIssues(
    REPO,
    BRANCH_A,
    [
      { number: 8, title: "Asked branch" },
      { number: 9, title: "Default branch" },
      { number: 10, title: "Mixed" },
    ],
    ghFn,
  );

  assertEquals(result[0]?.claimProblem, undefined);
  assertEquals(result[1]?.claimProblem, undefined);
  assertEquals(result[2]?.claimProblem, undefined);
});

Deno.test("classifyClosedIssues - an unreadable title search with only another milestone's branch PR is merged-pr-search-unreadable (Issue #5458)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      const search = args[args.indexOf("--search") + 1];
      if (search?.includes("in:title")) {
        throw new Error("HTTP 502: Bad Gateway");
      }
      if (search === "head:issue-7") {
        return JSON.stringify([{
          number: 70,
          title: "Adopted without reference",
          baseRefName: BRANCH_B,
          headRefName: "issue-7-fix",
          mergedAt: "2026-10-05T00:00:00Z",
          isCrossRepository: false,
        }]);
      }
    }
    return "[]";
  };

  const result = await classifyClosedIssues(
    REPO,
    BRANCH_A,
    [{ number: 7, title: "Hidden search" }],
    ghFn,
  );

  assertEquals(result[0]?.claimProblem, "merged-pr-search-unreadable");
});

Deno.test("classifyClosedIssues - a cached verdict for one milestone branch is not served for another (Issue #5458)", async () => {
  await withTempCache(async (cache) => {
    let timelineReads = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.join(" ").includes("/timeline")) {
        timelineReads++;
        return "[]";
      }
      if (args[0] === "pr" && args[1] === "list") {
        return titleSearchRows(args, {
          7: [mergedPr(70, "Fix (#7)", BRANCH_B)],
        });
      }
      return "[]";
    };
    const issues = [{
      number: 7,
      title: "Moved",
      updatedAt: "2026-10-05T00:00:00Z",
    }];

    const forA = await classifyClosedIssues(
      REPO,
      BRANCH_A,
      issues,
      ghFn,
      cache,
    );
    assertEquals(forA[0]?.claimProblem, "merged-into-other-milestone");

    const forB = await classifyClosedIssues(
      REPO,
      BRANCH_B,
      issues,
      ghFn,
      cache,
    );
    assertEquals(
      forB[0]?.claimProblem,
      undefined,
      "the PR went into the asked branch for B, so B claims it",
    );
    assertEquals(
      timelineReads,
      1,
      "B is classified live, not from A's verdict",
    );

    await classifyClosedIssues(REPO, BRANCH_B, issues, ghFn, cache);
    assertEquals(timelineReads, 1, "B's own verdict is served from cache");
  });
});

Deno.test("classifyClosedIssues - ignores an old v2 verdict for an issue whose merged PR went into another milestone (Issue #5458)", async () => {
  await withTempCache(async (cache) => {
    await cache.write(REPO, "milestone_claim_verdict_v2_7", {
      updatedAt: "2026-10-05T00:00:00Z",
      claimProblem: null,
    });
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") {
        return titleSearchRows(args, {
          7: [mergedPr(70, "Fix (#7)", BRANCH_B)],
        });
      }
      return "[]";
    };

    const result = await classifyClosedIssues(
      REPO,
      BRANCH_A,
      [{ number: 7, title: "Moved", updatedAt: "2026-10-05T00:00:00Z" }],
      ghFn,
      cache,
    );

    assertEquals(result[0]?.claimProblem, "merged-into-other-milestone");
  });
});

// ============================================================================
// checkAndHandleMilestoneCompletions (Issue #5458): the issue's own scenario
// ============================================================================

const MILESTONE_A = { title: "secret-assignment rule hardening", number: 7 };
const MILESTONE_B = { title: "secret redaction follow-ups", number: 99 };

/** The merged PR that delivered #5326 into milestone A's branch. */
const PR_5433 = mergedPr(5433, "Redact secret assignments (#5326)", BRANCH_A);
/** An own, claimed delivery of milestone A. */
const PR_5401 = mergedPr(5401, "Redact tokens (#5327)", BRANCH_A);

/**
 * A gh stub for two complete milestones. Milestone A's own closed issue is
 * #5327; #5326 is closed and sits in milestone B (per its REST view), yet its
 * only merged PR went into A's branch. Each `pr create` is captured.
 */
function scenarioGhFn(created: { head: string; body: string }[]) {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=") && !key.includes("state=closed")) {
      return "[]";
    }
    if (/api repos\/[^ ]+\/milestones\/\d+$/.test(key)) {
      return JSON.stringify({ open_issues: 0 });
    }
    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([MILESTONE_A, MILESTONE_B]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (key === "api repos/owner/repo/issues/5326") {
      return JSON.stringify({
        number: 5326,
        title: "Redact secret assignments",
        state: "closed",
        updated_at: "2026-10-20T00:00:00Z",
        milestone: { number: 99, title: "secret redaction follow-ups" },
      });
    }
    // Milestone A's own closed issue, named by its PR on A's branch: its REST
    // view shows it still in A, so it is not added as a moved issue.
    if (key === "api repos/owner/repo/issues/5327") {
      return JSON.stringify({
        number: 5327,
        title: "Redact tokens",
        state: "closed",
        updated_at: "2026-10-06T00:00:00Z",
        milestone: { number: 7, title: "secret-assignment rule hardening" },
      });
    }
    if (key.includes("/timeline")) return "[]";
    if (key.includes("issues?milestone=") && key.includes("state=closed")) {
      const m = key.match(/milestone=(\d+)/)?.[1];
      const rows = m === "7"
        ? [{
          number: 5327,
          title: "Redact tokens",
          updated_at: "2026-10-06T00:00:00Z",
        }]
        : m === "99"
        ? [{
          number: 5326,
          title: "Redact secret assignments",
          updated_at: "2026-10-20T00:00:00Z",
        }]
        : [];
      return JSON.stringify(rows);
    }
    if (args[0] === "pr" && args[1] === "list") {
      if (args.includes("--base")) {
        return args[args.indexOf("--base") + 1] === BRANCH_A
          ? JSON.stringify([PR_5433, PR_5401])
          : "[]";
      }
      const search = args[args.indexOf("--search") + 1] ?? "";
      if (search.includes("in:title")) {
        return titleSearchRows(args, { 5326: [PR_5433], 5327: [PR_5401] });
      }
      return "[]";
    }
    if (key.includes("/branches/milestone")) {
      return JSON.stringify({ name: key.split("/branches/")[1] ?? "" });
    }
    if (args[0] === "pr" && args[1] === "create") {
      const headIdx = args.indexOf("--head");
      const bodyIdx = args.indexOf("--body");
      if (headIdx >= 0 && bodyIdx >= 0) {
        created.push({ head: args[headIdx + 1]!, body: args[bodyIdx + 1]! });
      }
      return "https://github.com/owner/repo/pull/301";
    }
    if (args[0] === "issue" && args[1] === "create") {
      return "https://github.com/owner/repo/issues/300";
    }
    return "[]";
  };
}

Deno.test("checkAndHandleMilestoneCompletions - a rollup claims an issue that moved to another milestone after merging here, and the other rollup flags it (Issue #5458)", async () => {
  const created: { head: string; body: string }[] = [];
  const deps: MilestoneCompletionDeps = createMockDeps({
    ghCommandFn: scenarioGhFn(created),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  assertEquals(created.length, 2, "both complete milestones get a rollup");

  const bodyA = created.find((pr) => pr.head === BRANCH_A)?.body ?? "";
  const bodyB = created.find((pr) => pr.head === BRANCH_B)?.body ?? "";
  assertStringIncludes(
    bodyA,
    `- #5326: Redact secret assignments (now in milestone "secret redaction follow-ups")`,
  );
  assertStringIncludes(bodyA, "Part of #5326");

  assertStringIncludes(bodyB, "### Flagged — not claimed");
  assertStringIncludes(
    bodyB,
    `- #5326: Redact secret assignments (every merged PR went into another milestone's branch)`,
  );
  assertFalse(bodyB.includes("Part of #5326"));
});

function createMockDeps(
  overrides: Partial<MilestoneCompletionDeps> = {},
): MilestoneCompletionDeps {
  return {
    repos: [REPO],
    ghCommandFn: async (_args: string[]) => "[]",
    log: (_msg: string) => {},
    authorOptions: { fleetAuthors: ["bot"] },
    ...overrides,
  };
}

// ============================================================================
// fetchIssuesMovedOffBranch (Issue #5458)
// ============================================================================

/** The merged-into-branch rows the moved-off read sees, one per case. */
const MOVED_PR_ROWS = [
  {
    number: 60,
    title: "Redact secret assignments (#5326)",
    headRefName: "issue-5326-x",
    isCrossRepository: false,
  },
  {
    number: 61,
    title: "Redact tokens (#5327)",
    headRefName: "issue-5327-x",
    isCrossRepository: false,
  },
  {
    number: 62,
    title: "Open follow-up (#5328)",
    headRefName: "issue-5328-x",
    isCrossRepository: false,
  },
  {
    number: 63,
    title: "Fork delivery (#5329)",
    headRefName: "issue-5329-x",
    isCrossRepository: true,
  },
  {
    number: 64,
    title: "Milestone sync",
    headRefName: "sync/milestone-main",
    isCrossRepository: false,
  },
  {
    number: 65,
    title: "Reference to a PR (#5330)",
    headRefName: "issue-5330-x",
    isCrossRepository: false,
  },
  {
    number: 66,
    title: "Orphaned delivery (#5331)",
    headRefName: "issue-5331-x",
    isCrossRepository: false,
  },
  {
    number: 67,
    title: "Still in milestone (#5332)",
    headRefName: "issue-5332-x",
    isCrossRepository: false,
  },
];

const REST_ISSUES: Record<number, unknown> = {
  // Still a member of milestone 7: excluded by the caller, so never read in
  // the first test; listed so the other cases can use the default rows.
  5327: {
    number: 5327,
    title: "Redact tokens",
    state: "closed",
    updated_at: "2026-10-06T00:00:00Z",
    milestone: { number: 7, title: "secret-assignment rule hardening" },
  },
  5326: {
    number: 5326,
    title: "Redact secret assignments",
    state: "closed",
    updated_at: "2026-10-20T00:00:00Z",
    milestone: { number: 99, title: "secret redaction follow-ups" },
  },
  5328: {
    number: 5328,
    title: "Open follow-up",
    state: "open",
    updated_at: "2026-10-21T00:00:00Z",
    milestone: null,
  },
  5330: {
    number: 5330,
    title: "Reference to a PR",
    state: "closed",
    updated_at: "2026-10-21T00:00:00Z",
    pull_request: { url: "https://api.github.test/pulls/5330" },
    milestone: null,
  },
  5331: {
    number: 5331,
    title: "Orphaned delivery",
    state: "closed",
    updated_at: "2026-10-22T00:00:00Z",
    milestone: null,
  },
  5332: {
    number: 5332,
    title: "Still in milestone",
    state: "closed",
    updated_at: "2026-10-22T00:00:00Z",
    milestone: { number: 7, title: "secret-assignment rule hardening" },
  },
};

/** A gh stub: the `pr list --base` read and the REST issue reads. */
function movedOffGhFn(
  calls: string[][],
  options: { prList?: string; rest?: Record<number, unknown> } = {},
) {
  return async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return options.prList ?? JSON.stringify(MOVED_PR_ROWS);
    }
    if (args[0] === "api") {
      const m = args[1]?.match(/^repos\/owner\/repo\/issues\/(\d+)$/);
      if (m) {
        const row = (options.rest ?? REST_ISSUES)[Number(m[1])];
        if (row === undefined) throw new Error(`HTTP 404: #${m[1]}`);
        return JSON.stringify(row);
      }
    }
    return "[]";
  };
}

function restCallNumbers(calls: string[][]): number[] {
  return calls
    .filter((a) => a[0] === "api")
    .map((a) => Number(a[1]?.match(/issues\/(\d+)$/)?.[1]))
    .sort((x, y) => x - y);
}

Deno.test("fetchIssuesMovedOffBranch - returns closed issues that merged into the branch and now sit elsewhere (Issue #5458)", async () => {
  const calls: string[][] = [];
  const moved = await fetchIssuesMovedOffBranch(
    REPO,
    BRANCH_A,
    7,
    new Set([5327]),
    movedOffGhFn(calls),
  );

  assertEquals(moved, [
    {
      number: 5326,
      title: "Redact secret assignments",
      updatedAt: "2026-10-20T00:00:00Z",
      movedToMilestone: "secret redaction follow-ups",
    },
    {
      number: 5331,
      title: "Orphaned delivery",
      updatedAt: "2026-10-22T00:00:00Z",
      movedToMilestone: null,
    },
  ]);

  const prList = calls.find((a) => a[0] === "pr" && a[1] === "list");
  assertEquals(prList?.[prList.indexOf("--base") + 1], BRANCH_A);
  assertEquals(prList?.[prList.indexOf("--state") + 1], "merged");
  assertEquals(prList?.[prList.indexOf("--limit") + 1], "1000");

  // 5327 is excluded, 5329 is a fork, 64 is a sync head, 5330 is PR-shaped,
  // 5328 is open and 5332 is still in milestone 7. 5326 is read once although
  // both its branch and its title name it.
  assertEquals(restCallNumbers(calls), [5326, 5328, 5330, 5331, 5332]);
});

Deno.test("fetchIssuesMovedOffBranch - throws, and does not cache, an unreadable merged-PR list (Issue #5458)", async () => {
  await withTempCache(async (cache) => {
    const calls: string[][] = [];
    await assertRejects(
      () =>
        fetchIssuesMovedOffBranch(
          REPO,
          BRANCH_A,
          7,
          new Set(),
          movedOffGhFn(calls, { prList: '{"message":"Not Found"}' }),
          cache,
        ),
      Error,
      `could not read the pull requests merged into ${BRANCH_A}`,
    );
    await assertRejects(
      () =>
        fetchIssuesMovedOffBranch(
          REPO,
          BRANCH_A,
          7,
          new Set(),
          async () => {
            throw new Error("HTTP 502: Bad Gateway");
          },
          cache,
        ),
      Error,
      `could not read the pull requests merged into ${BRANCH_A}`,
    );

    // The failed reads are not cached: a later healthy read is used.
    const healthy = await fetchIssuesMovedOffBranch(
      REPO,
      BRANCH_A,
      7,
      new Set(),
      movedOffGhFn([]),
      cache,
    );
    assertEquals(healthy.map((i) => i.number), [5326, 5331]);
  });
});

Deno.test("fetchIssuesMovedOffBranch - serves the parsed merged-PR list from cache (Issue #5458)", async () => {
  await withTempCache(async (cache) => {
    const first: string[][] = [];
    await fetchIssuesMovedOffBranch(
      REPO,
      BRANCH_A,
      7,
      new Set(),
      movedOffGhFn(first),
      cache,
    );
    const prListCalls = (calls: string[][]) =>
      calls.filter((a) => a[0] === "pr" && a[1] === "list").length;
    assertEquals(prListCalls(first), 1);

    const second: string[][] = [];
    await fetchIssuesMovedOffBranch(
      REPO,
      BRANCH_A,
      7,
      new Set(),
      movedOffGhFn(second),
      cache,
    );
    assertEquals(prListCalls(second), 0, "the merged-PR list is cached");
  });
});

Deno.test("fetchIssuesMovedOffBranch - throws on a malformed or unreadable issue read (Issue #5458)", async () => {
  await assertRejects(
    () =>
      fetchIssuesMovedOffBranch(
        REPO,
        BRANCH_A,
        7,
        new Set(),
        movedOffGhFn([], {
          prList: JSON.stringify([{
            number: 60,
            title: "Broken (#5340)",
            headRefName: "issue-5340-x",
            isCrossRepository: false,
          }]),
          rest: { 5340: { number: 5340, title: 7, state: "closed" } },
        }),
      ),
    Error,
    "issue #5340",
  );

  await assertRejects(
    () =>
      fetchIssuesMovedOffBranch(
        REPO,
        BRANCH_A,
        7,
        new Set(),
        movedOffGhFn([], {
          prList: JSON.stringify([{
            number: 60,
            title: "Missing (#5341)",
            headRefName: "issue-5341-x",
            isCrossRepository: false,
          }]),
          rest: {},
        }),
      ),
    Error,
    "issue #5341",
  );
});

// ============================================================================
// buildMilestoneSummaryBody (Issue #5458)
// ============================================================================

Deno.test("buildMilestoneSummaryBody - notes where a claimed issue now sits (Issue #5458)", () => {
  const body = buildMilestoneSummaryBody(
    "secret-assignment rule hardening",
    "main",
    [
      {
        number: 5326,
        title: "Redact secret assignments",
        movedToMilestone: "secret redaction follow-ups",
      },
      { number: 5331, title: "Orphaned delivery", movedToMilestone: null },
      { number: 5332, title: "Stayed here" },
    ],
  );

  assertStringIncludes(
    body,
    `- #5326: Redact secret assignments (now in milestone "secret redaction follow-ups")`,
  );
  assertStringIncludes(
    body,
    "- #5331: Orphaned delivery (no longer in a milestone)",
  );
  assertStringIncludes(body, "- #5332: Stayed here\n");
  assertStringIncludes(body, "Part of #5326");
  assertStringIncludes(body, "Part of #5331");
  assert(!body.includes("### Flagged"));
});
