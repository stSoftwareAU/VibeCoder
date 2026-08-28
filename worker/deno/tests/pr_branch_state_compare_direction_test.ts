/**
 * Regression tests for the ahead/behind comparison direction (Issue #470).
 *
 * `buildBatchQuery` used to ask GitHub for
 * `headRef { compare(headRef: <base>) }`. In GitHub's GraphQL schema the
 * ref the `compare` field hangs off is the comparison **base** and the
 * `headRef:` argument is the comparison **head**, so that query asked how
 * the base branch compared to the PR head and got `aheadBy`/`behindBy`
 * back **swapped**. Nothing errored — the answer was correct for the
 * question actually asked.
 *
 * The consequence in production: `enforcePreMergeRequirements` read the
 * PR's *ahead* count as `behindBy`, refused every PR with at least one
 * commit as `behind_target`, and the gated direct-merge path never merged
 * anything — so milestone children never merged, their issues never
 * closed, and no milestone ever completed.
 *
 * These tests do not pattern-match the query text for its own sake. The
 * fake `gh` below **emulates GitHub's real `Ref.compare` semantics**: it
 * reads whichever ref the query hangs the comparison off, treats that as
 * the comparison base, and answers from a fixed branch topology. A query
 * asking the wrong way round therefore receives a truthfully-swapped
 * answer, exactly as GitHub gives one, and the assertions are on the
 * decision that follows rather than on the query string.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildBatchQuery,
  fetchPRBranchStateBatch,
} from "../lib/pr_branch_state.ts";
import { enforcePreMergeRequirements } from "../lib/direct_merge.ts";

// ---------------------------------------------------------------------------
// A fake GitHub that honours real `Ref.compare` semantics
// ---------------------------------------------------------------------------

/**
 * Branch topology mirroring the live PR that exposed the bug
 * (TitlePage/tp-web-react#2399): the feature branch sits three commits
 * ahead of its milestone base and is not behind at all.
 */
const BASE_REF = "milestone/apa-tpmum-documentation-sprint-18";
const HEAD_REF = "issue-2357-task-tpmum-769-document-mfa-setup";
const HEAD_AHEAD_OF_BASE = 3;

/**
 * Commits reachable from each ref, oldest first. The base is a prefix of
 * the head: the feature branch has three commits on top, and the base has
 * nothing the feature branch lacks.
 */
const COMMITS: Record<string, string[]> = {
  [BASE_REF]: ["c1", "c2", "c3", "c4"],
  [HEAD_REF]: ["c1", "c2", "c3", "c4", "f1", "f2", "f3"],
};

/**
 * Emulate `Ref.compare(headRef:)`: the ref the field hangs off is the
 * comparison **base**, the argument is the comparison **head**. `aheadBy`
 * counts commits the head has that the base lacks; `behindBy` counts
 * commits the base has that the head lacks.
 */
function compareRefs(
  comparisonBase: string,
  comparisonHead: string,
): { aheadBy: number; behindBy: number } {
  const baseCommits = COMMITS[comparisonBase] ?? [];
  const headCommits = COMMITS[comparisonHead] ?? [];
  return {
    aheadBy: headCommits.filter((c) => !baseCommits.includes(c)).length,
    behindBy: baseCommits.filter((c) => !headCommits.includes(c)).length,
  };
}

/**
 * Answer a batch query the way GitHub would: read which ref carries the
 * `compare` field and which ref it is given, then compare in that
 * direction.
 */
function answerCompareQuery(query: string): string {
  const match = query.match(
    /(baseRef|headRef)\s*\{\s*compare\(headRef:\s*"([^"]+)"\)/,
  );
  if (!match) {
    throw new Error(`Query has no recognisable compare field: ${query}`);
  }
  const receiver = match[1] === "baseRef" ? BASE_REF : HEAD_REF;
  const comparison = compareRefs(receiver, match[2]!);
  return JSON.stringify({
    data: {
      repository: {
        p0: {
          number: 2399,
          headRefName: HEAD_REF,
          baseRefName: BASE_REF,
          mergeable: "MERGEABLE",
          // Both fields carry the same answer, so it is the *query
          // direction* that decides the numbers, not the fixture's shape.
          baseRef: { compare: comparison },
          headRef: { compare: comparison },
        },
      },
    },
  });
}

/** Fake `gh` covering the calls the batch fetch and the gate make. */
function fakeGh(args: string[]): Promise<string> {
  const joined = args.join(" ");
  if (joined.startsWith("api graphql")) {
    return Promise.resolve(
      answerCompareQuery(args[3]?.slice("query=".length) ?? ""),
    );
  }
  if (joined.includes("pr view") && joined.includes("baseRefName")) {
    return Promise.resolve(
      JSON.stringify({ baseRefName: BASE_REF, headRefName: HEAD_REF }),
    );
  }
  return Promise.reject(new Error(`Unexpected gh command: ${joined}`));
}

// ---------------------------------------------------------------------------
// The batch fetch reports the PR's own ahead/behind, not its base's
// ---------------------------------------------------------------------------

Deno.test("pr_branch_state - a PR ahead of its base is not reported as behind", async () => {
  const result = await fetchPRBranchStateBatch(
    "TitlePage/tp-web-react",
    [{ number: 2399, baseRefName: BASE_REF, headRefName: HEAD_REF }],
    fakeGh,
  );

  assert(result.ok, "batch fetch should succeed");
  if (!result.ok) return;
  const state = result.states.get(2399);
  assert(state, "state for PR 2399 should be present");
  if (!state) return;
  assertEquals(
    state.behindBy,
    0,
    "the PR is not behind its base — a non-zero behindBy is the inverted comparison (Issue #470)",
  );
  assertEquals(
    state.aheadBy,
    HEAD_AHEAD_OF_BASE,
    "the PR is three commits ahead of its base",
  );
});

// ---------------------------------------------------------------------------
// An unorientable comparison is refused, never guessed
// ---------------------------------------------------------------------------

Deno.test("pr_branch_state - a PR with no head ref is refused, not compared blindly", () => {
  assertThrows(
    () =>
      buildBatchQuery("acme", "tools", [{ number: 1, baseRefName: "main" }]),
    Error,
    "cannot be oriented",
  );
});

Deno.test("pr_branch_state - an unorientable PR fails the fetch so the caller falls back to REST", async () => {
  const result = await fetchPRBranchStateBatch(
    "acme/tools",
    [{ number: 1, baseRefName: "main" }],
    () => Promise.reject(new Error("gh must not be called")),
  );
  assert(!result.ok, "a comparison that cannot be oriented must not succeed");
});

// ---------------------------------------------------------------------------
// The decision that actually mattered in production
// ---------------------------------------------------------------------------

Deno.test("direct_merge - pre-merge gate allows a green PR that is ahead of its base", async () => {
  const result = await enforcePreMergeRequirements(
    "TitlePage/tp-web-react",
    2399,
    fakeGh,
    {
      // Keep this test about the branch comparison: the milestone route and
      // head recency each have their own tests.
      decideMilestoneBaseFn: () =>
        Promise.resolve({ decision: "allow", reason: "route-open" as const }),
      fetchHeadRecency: () =>
        Promise.resolve({ headSha: "d7590aa", committedAtMs: 0 }),
      minHeadAgeSeconds: 0,
    },
    // CI is green on the head the gate will pin the merge to.
    () =>
      Promise.resolve({
        ok: true as const,
        value: { status: "passed" as const, headSha: "d7590aa" },
      }),
  );

  assert(result.ok, "gate should not error");
  if (!result.ok) return;
  assertEquals(
    result.value.reason,
    undefined,
    "a PR three commits ahead and zero behind must not be refused as behind_target (Issue #470)",
  );
  assertEquals(result.value.allowed, true);
  assertEquals(result.value.headSha, "d7590aa");
});
