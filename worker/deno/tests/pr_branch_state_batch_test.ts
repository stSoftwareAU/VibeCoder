/**
 * Tests for pr_branch_state.ts (Issue #1807).
 *
 * Verifies that fetchPRBranchStateBatch:
 *  - issues a single GraphQL call for all PRs in a repo,
 *  - is a no-op when given an empty PR list,
 *  - returns ok:false on GraphQL transport / errors-payload failures so
 *    callers can fall back to per-PR REST,
 *  - reuses cached results within the IssueCache TTL.
 */

import { assert, assertEquals } from "@std/assert";
import { fetchPRBranchStateBatch } from "../lib/pr_branch_state.ts";
import { IssueCache } from "../lib/issue_cache.ts";

// ---------------------------------------------------------------------------
// buildBatchQuery
// ---------------------------------------------------------------------------

Deno.test("pr_branch_state - each PR in a batch gets its own base comparison", async () => {
  // Behaviour, not shape (Issue #471): two PRs on different bases, each with
  // its own drift, must come back with its own numbers. This previously
  // asserted the query text — and so passed for the whole life of the
  // inverted-comparison bug (Issue #470). The comparison *direction* is
  // covered behaviourally in pr_branch_state_compare_direction_test.ts.
  const drift: Record<number, { aheadBy: number; behindBy: number }> = {
    10: { aheadBy: 4, behindBy: 0 },
    20: { aheadBy: 1, behindBy: 7 },
  };
  const gh = (args: string[]): Promise<string> => {
    const query = args[3]?.slice("query=".length) ?? "";
    const repo: Record<string, unknown> = {};
    for (const [i, number] of [10, 20].entries()) {
      // Answer from whichever ref the query names as the comparison head.
      const head = [...query.matchAll(/compare\(headRef: "([^"]+)"\)/g)][i]
        ?.[1];
      repo[`p${i}`] = {
        number,
        mergeable: "MERGEABLE",
        baseRef: {
          compare: head === `feature-${number}` ? drift[number] : null,
        },
      };
    }
    return Promise.resolve(JSON.stringify({ data: { repository: repo } }));
  };

  const result = await fetchPRBranchStateBatch("acme/tools", [
    { number: 10, baseRefName: "main", headRefName: "feature-10" },
    { number: 20, baseRefName: "release/v2", headRefName: "feature-20" },
  ], gh);

  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.states.get(10), {
    aheadBy: 4,
    behindBy: 0,
    mergeable: "MERGEABLE",
  });
  assertEquals(result.states.get(20), {
    aheadBy: 1,
    behindBy: 7,
    mergeable: "MERGEABLE",
  });
});
// ---------------------------------------------------------------------------
// fetchPRBranchStateBatch — happy path / empty / failure / cache
// ---------------------------------------------------------------------------

interface FakePR {
  number: number;
  baseRefName: string;
  mergeable: string;
  aheadBy: number;
  behindBy: number;
}

function fakeGraphQLResponse(prs: FakePR[]): string {
  const repo: Record<string, unknown> = {};
  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i]!;
    repo[`p${i}`] = {
      number: pr.number,
      headRefName: `feature-${pr.number}`,
      baseRefName: pr.baseRefName,
      mergeable: pr.mergeable,
      baseRef: {
        compare: {
          aheadBy: pr.aheadBy,
          behindBy: pr.behindBy,
        },
      },
    };
  }
  return JSON.stringify({ data: { repository: repo } });
}

Deno.test("pr_branch_state - happy path: one GraphQL call returns all states", async () => {
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    assertEquals(args[0], "api");
    assertEquals(args[1], "graphql");
    assertEquals(args[2], "-f");
    assert(args[3]?.startsWith("query="));
    return Promise.resolve(fakeGraphQLResponse([
      {
        number: 1,
        baseRefName: "main",
        mergeable: "MERGEABLE",
        aheadBy: 1,
        behindBy: 0,
      },
      {
        number: 2,
        baseRefName: "main",
        mergeable: "CONFLICTING",
        aheadBy: 0,
        behindBy: 0,
      },
      {
        number: 3,
        baseRefName: "main",
        mergeable: "MERGEABLE",
        aheadBy: 2,
        behindBy: 5,
      },
    ]));
  };
  const result = await fetchPRBranchStateBatch(
    "acme/tools",
    [
      { number: 1, baseRefName: "main", headRefName: "feature-1" },
      { number: 2, baseRefName: "main", headRefName: "feature-2" },
      { number: 3, baseRefName: "main", headRefName: "feature-3" },
    ],
    gh,
  );
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(calls, 1);
  assertEquals(result.callCount, 1);
  assertEquals(result.states.size, 3);
  assertEquals(result.states.get(1)?.behindBy, 0);
  assertEquals(result.states.get(1)?.mergeable, "MERGEABLE");
  assertEquals(result.states.get(2)?.mergeable, "CONFLICTING");
  assertEquals(result.states.get(3)?.behindBy, 5);
  assertEquals(result.states.get(3)?.aheadBy, 2);
});

Deno.test("pr_branch_state - empty PR list issues no calls", async () => {
  let calls = 0;
  const gh = (_args: string[]): Promise<string> => {
    calls++;
    return Promise.resolve("{}");
  };
  const result = await fetchPRBranchStateBatch("acme/tools", [], gh);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(calls, 0);
  assertEquals(result.callCount, 0);
  assertEquals(result.states.size, 0);
});

Deno.test("pr_branch_state - returns error on gh failure (caller falls back to REST)", async () => {
  const gh = (_args: string[]): Promise<string> => {
    return Promise.reject(new Error("boom"));
  };
  const result = await fetchPRBranchStateBatch(
    "acme/tools",
    [{ number: 1, baseRefName: "main", headRefName: "feature-1" }],
    gh,
  );
  assert(!result.ok);
  if (result.ok) return;
  assertEquals(result.error.message, "boom");
});

Deno.test("pr_branch_state - returns error on GraphQL errors payload", async () => {
  const gh = (_args: string[]): Promise<string> => {
    return Promise.resolve(JSON.stringify({
      errors: [{ message: "compare not allowed on Ref" }],
    }));
  };
  const result = await fetchPRBranchStateBatch(
    "acme/tools",
    [{ number: 1, baseRefName: "main", headRefName: "feature-1" }],
    gh,
  );
  assert(!result.ok);
});

Deno.test("pr_branch_state - rejects malformed repo identifier", async () => {
  const gh = (_args: string[]): Promise<string> => Promise.resolve("{}");
  const r1 = await fetchPRBranchStateBatch(
    "not-a-repo",
    [{ number: 1, baseRefName: "main", headRefName: "feature-1" }],
    gh,
  );
  assert(!r1.ok);
  const r2 = await fetchPRBranchStateBatch(
    "ow ner/repo",
    [{ number: 1, baseRefName: "main", headRefName: "feature-1" }],
    gh,
  );
  assert(!r2.ok);
});

Deno.test("pr_branch_state - rejects unsafe base ref characters", async () => {
  const gh = (_args: string[]): Promise<string> => Promise.resolve("{}");
  const result = await fetchPRBranchStateBatch(
    "acme/tools",
    [{ number: 1, baseRefName: 'main"; injected', headRefName: "feature-1" }],
    gh,
  );
  assert(!result.ok);
});

Deno.test("pr_branch_state - cache hit on second invocation skips GraphQL call", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "vibe-pr-branch-state-cache-",
  });
  try {
    const cache = new IssueCache(tmpDir, 120);
    let calls = 0;
    const gh = (_args: string[]): Promise<string> => {
      calls++;
      return Promise.resolve(fakeGraphQLResponse([
        {
          number: 1,
          baseRefName: "main",
          mergeable: "MERGEABLE",
          aheadBy: 0,
          behindBy: 0,
        },
      ]));
    };

    const r1 = await fetchPRBranchStateBatch(
      "acme/tools",
      [{ number: 1, baseRefName: "main", headRefName: "feature-1" }],
      gh,
      cache,
    );
    assert(r1.ok);
    if (!r1.ok) return;
    assertEquals(calls, 1);
    assertEquals(r1.callCount, 1);

    const r2 = await fetchPRBranchStateBatch(
      "acme/tools",
      [{ number: 1, baseRefName: "main", headRefName: "feature-1" }],
      gh,
      cache,
    );
    assert(r2.ok);
    if (!r2.ok) return;
    assertEquals(calls, 1, "second invocation must hit cache, not call gh");
    assertEquals(r2.callCount, 0);
    assertEquals(r2.states.get(1)?.mergeable, "MERGEABLE");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("pr_branch_state - GraphQL response missing data.repository returns error", async () => {
  const gh = (_args: string[]): Promise<string> => {
    return Promise.resolve(JSON.stringify({ data: { repository: null } }));
  };
  const result = await fetchPRBranchStateBatch(
    "acme/tools",
    [{ number: 1, baseRefName: "main", headRefName: "feature-1" }],
    gh,
  );
  assert(!result.ok);
});

Deno.test("pr_branch_state - missing compare node defaults to zero ahead/behind", async () => {
  const gh = (_args: string[]): Promise<string> => {
    return Promise.resolve(JSON.stringify({
      data: {
        repository: {
          p0: {
            number: 1,
            headRefName: "feature-1",
            baseRefName: "main",
            mergeable: "UNKNOWN",
            baseRef: null,
          },
        },
      },
    }));
  };
  const result = await fetchPRBranchStateBatch(
    "acme/tools",
    [{ number: 1, baseRefName: "main", headRefName: "feature-1" }],
    gh,
  );
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.states.get(1)?.aheadBy, 0);
  assertEquals(result.states.get(1)?.behindBy, 0);
  assertEquals(result.states.get(1)?.mergeable, "UNKNOWN");
});
