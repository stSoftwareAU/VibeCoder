/**
 * Behaviour tests locking in the milestone merge flow (Issue #470).
 *
 * These do not assert query text or call shapes. They wire the **real**
 * production code — `enableAutoMerge` → `directMergePr` →
 * `enforcePreMergeRequirements` → `fetchPRBranchStateBatch`, and
 * `scanPrBranchUpdates` → the same batch fetcher — to a fake GitHub that
 * answers from a branch topology using GitHub's own rules, and assert what
 * the worker *does*: does the PR merge, and does the branch-update pass
 * leave an already-current branch alone.
 *
 * The bug they lock out (Issue #470) made both answers wrong at once, and
 * the two wrong answers sustained each other: the pre-merge gate refused
 * every PR as `behind_target` while the branch-update pass "updated" the
 * same branches every cycle for ever, reporting success each time. No
 * milestone child ever merged, so no milestone ever completed and no
 * rollup PR to the default branch was ever raised.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  _resetBaseProtectionMemo,
  AutoMergeResult,
  enableAutoMerge,
} from "../lib/pr_auto_merge.ts";
import { fetchPRBranchStateBatch } from "../lib/pr_branch_state.ts";
import {
  type PrBranchEntry,
  type PrBranchStateEntry,
  scanPrBranchUpdates,
} from "../lib/pr_branch_update.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// A fake GitHub answering from a branch topology
// ---------------------------------------------------------------------------

const REPO = "TitlePage/tp-web-react";
const DEFAULT_BRANCH = "Develop";
const MILESTONE_BASE = "milestone/apa-tpmum-documentation-sprint-18";
const PR_NUMBER = 2399;
const PR_HEAD = "issue-2357-task-tpmum-769-document-mfa-setup";
const HEAD_SHA = "d7590aab3d0fbcbc94971856825bdf67b5db3810";

/** Commits reachable from each ref, oldest first. */
type Topology = Record<string, string[]>;

/** The live shape when the bug was found: three ahead, nothing behind. */
const CURRENT_TOPOLOGY: Topology = {
  [MILESTONE_BASE]: ["c1", "c2", "c3", "c4"],
  [PR_HEAD]: ["c1", "c2", "c3", "c4", "f1", "f2", "f3"],
};

/** A genuinely stale branch: two ahead and four behind its base. */
const STALE_TOPOLOGY: Topology = {
  [MILESTONE_BASE]: ["c1", "c2", "c3", "c4", "b1", "b2", "b3", "b4"],
  [PR_HEAD]: ["c1", "c2", "c3", "c4", "f1", "f2"],
};

/**
 * Emulate `Ref.compare(headRef:)`: the ref carrying the field is the
 * comparison base, the argument is the comparison head.
 */
function compareRefs(
  topology: Topology,
  comparisonBase: string,
  comparisonHead: string,
): { aheadBy: number; behindBy: number } {
  const baseCommits = topology[comparisonBase] ?? [];
  const headCommits = topology[comparisonHead] ?? [];
  return {
    aheadBy: headCommits.filter((c) => !baseCommits.includes(c)).length,
    behindBy: baseCommits.filter((c) => !headCommits.includes(c)).length,
  };
}

/** Calls the fake GitHub recorded for assertions. */
interface Recorder {
  mergeCalls: string[][];
}

/**
 * Build a fake `gh`. It answers every read the production path makes, and
 * — crucially — answers the ahead/behind comparison from the topology
 * using GitHub's own direction rules, so a query asked the wrong way round
 * receives a truthfully-swapped answer rather than the one the caller
 * hoped for.
 */
function fakeGitHub(
  topology: Topology,
  recorder: Recorder,
  options: { ciState?: string } = {},
): (args: string[]) => Promise<string> {
  const ciState = options.ciState ?? "SUCCESS";

  return (args: string[]): Promise<string> => {
    const joined = args.join(" ");

    if (joined.startsWith("api graphql")) {
      const query = args.find((a) => a.startsWith("query="))?.slice(6) ?? "";

      // CI rollup read (checkCiStatus).
      if (query.includes("statusCheckRollup")) {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              // The rollup batch aliases PRs `n0`, `n1`, ... (the branch-state
              // batch uses `p0`), so the two GraphQL reads stay distinct.
              n0: {
                number: PR_NUMBER,
                commits: {
                  nodes: [{
                    commit: {
                      oid: HEAD_SHA,
                      statusCheckRollup: {
                        state: ciState,
                        contexts: {
                          nodes: [{
                            __typename: "CheckRun",
                            name: "quality",
                            status: "COMPLETED",
                            conclusion: ciState === "SUCCESS"
                              ? "SUCCESS"
                              : "FAILURE",
                          }],
                        },
                      },
                    },
                  }],
                },
              },
            },
          },
        }));
      }

      // Ahead/behind comparison.
      const shape = query.match(
        /(baseRef|headRef)\s*\{\s*compare\(headRef:\s*"([^"]+)"\)/,
      );
      if (shape) {
        const receiver = shape[1] === "baseRef" ? MILESTONE_BASE : PR_HEAD;
        const comparison = compareRefs(topology, receiver, shape[2]!);
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              p0: {
                number: PR_NUMBER,
                headRefName: PR_HEAD,
                baseRefName: MILESTONE_BASE,
                mergeable: "MERGEABLE",
                baseRef: { compare: comparison },
                headRef: { compare: comparison },
              },
            },
          },
        }));
      }
      return Promise.reject(new Error(`Unhandled GraphQL: ${query}`));
    }

    // Milestone-base route gate: no rollup merged, milestone still open.
    if (joined.includes("pr list") && joined.includes("--head")) {
      return Promise.resolve("[]");
    }
    if (joined.includes("/milestones?state=all")) {
      return Promise.resolve(JSON.stringify([{
        number: 43,
        title: "APA TPMUM Documentation – Sprint 18",
        state: "open",
      }]));
    }

    if (joined.includes("default_branch")) {
      return Promise.resolve(DEFAULT_BRANCH);
    }

    if (joined.includes("pr view")) {
      if (joined.includes("headRefOid")) {
        // Head recency: settled long ago.
        return Promise.resolve(JSON.stringify({
          headSha: HEAD_SHA,
          committedDate: "2020-01-01T00:00:00Z",
        }));
      }
      if (joined.includes("--jq")) {
        // Blast-radius guard reads the base alone.
        return Promise.resolve(MILESTONE_BASE);
      }
      return Promise.resolve(
        JSON.stringify({
          baseRefName: MILESTONE_BASE,
          headRefName: PR_HEAD,
        }),
      );
    }

    if (joined.includes("pr merge")) {
      recorder.mergeCalls.push(args);
      return Promise.resolve("Merged");
    }

    return Promise.reject(new Error(`Unexpected gh command: ${joined}`));
  };
}

/** Run `enableAutoMerge` against an unprotected milestone base. */
async function attemptMerge(
  topology: Topology,
  options: { ciState?: string } = {},
): Promise<{ result: AutoMergeResult; recorder: Recorder }> {
  _resetBaseProtectionMemo();
  const recorder: Recorder = { mergeCalls: [] };
  const outcome = await enableAutoMerge({
    repo: REPO,
    prNumber: PR_NUMBER,
    headRefName: PR_HEAD,
    baseRefName: MILESTONE_BASE,
    ghCommandFn: fakeGitHub(topology, recorder, options),
    // The milestone branch carries no required checks — the case that
    // routes to the gated direct merge (Issue #4375).
    isBaseProtectedFn: () => Promise.resolve(false),
    log: () => {},
  });
  return { result: outcome.result, recorder };
}

// ---------------------------------------------------------------------------
// Behaviour: a green milestone child merges
// ---------------------------------------------------------------------------

Deno.test("milestone flow - a green PR on an unprotected milestone base is merged", async () => {
  const { result, recorder } = await attemptMerge(CURRENT_TOPOLOGY);

  assertEquals(
    result,
    AutoMergeResult.MergedDirectly,
    "a green, current, settled milestone child must merge — refusing it is what froze the milestone (Issue #470)",
  );
  assertEquals(recorder.mergeCalls.length, 1, "exactly one merge is issued");
});

Deno.test("milestone flow - the merge is squashed and pinned to the commit CI verified", async () => {
  const { recorder } = await attemptMerge(CURRENT_TOPOLOGY);

  const merge = recorder.mergeCalls[0]!;
  assert(merge.includes("--squash"), "milestone children merge squashed");
  const pinned = merge[merge.indexOf("--match-head-commit") + 1];
  assertEquals(
    pinned,
    HEAD_SHA,
    "the merge must name the commit the gate read its checks for (Issue #3946)",
  );
});

// ---------------------------------------------------------------------------
// Behaviour: the safety gates still bite
// ---------------------------------------------------------------------------

Deno.test("milestone flow - a genuinely stale branch is not merged", async () => {
  const { result, recorder } = await attemptMerge(STALE_TOPOLOGY);

  assertEquals(
    result,
    AutoMergeResult.Deferred,
    "a branch four commits behind its base must still be held back",
  );
  assertEquals(recorder.mergeCalls.length, 0, "no merge is issued");
});

Deno.test("milestone flow - a red PR is not merged", async () => {
  const { result, recorder } = await attemptMerge(CURRENT_TOPOLOGY, {
    ciState: "FAILURE",
  });

  assertEquals(result, AutoMergeResult.Deferred, "failing CI still blocks");
  assertEquals(recorder.mergeCalls.length, 0, "no merge is issued");
});

// ---------------------------------------------------------------------------
// Behaviour: the branch-update pass converges
// ---------------------------------------------------------------------------

/** Logger that records nothing — these tests assert on actions, not lines. */
function silentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  } as unknown as Logger;
}

/**
 * Run the real branch-update scan over one PR, wired to the real batch
 * fetcher and the topology-driven fake GitHub — the same path priority 1.6
 * takes in production.
 */
async function scanFor(topology: Topology) {
  const recorder: Recorder = { mergeCalls: [] };
  const gh = fakeGitHub(topology, recorder);
  const pr: PrBranchEntry = {
    number: PR_NUMBER,
    headRefName: PR_HEAD,
    baseRefName: MILESTONE_BASE,
  };

  return await scanPrBranchUpdates({
    repos: [REPO],
    logger: silentLogger(),
    isRepoAllowed: () => true,
    getDefaultBranch: () => Promise.resolve(DEFAULT_BRANCH),
    listPrs: () => Promise.resolve([pr]),
    getBehindBy: () => Promise.reject(new Error("batch path should be used")),
    getMergeableStatus: () => Promise.resolve("MERGEABLE"),
    fetchBranchStateBatch: async (
      repo: string,
      prs: readonly PrBranchEntry[],
    ): Promise<Map<number, PrBranchStateEntry> | null> => {
      const batch = await fetchPRBranchStateBatch(
        repo,
        prs.map((p) => ({
          number: p.number,
          baseRefName: p.baseRefName,
          headRefName: p.headRefName,
        })),
        gh,
      );
      if (!batch.ok) return null;
      const out = new Map<number, PrBranchStateEntry>();
      for (const [number, state] of batch.states) {
        out.set(number, {
          behindBy: state.behindBy,
          mergeable: state.mergeable,
        });
      }
      return out;
    },
  });
}

Deno.test("branch update - a PR already current with its base is left alone", async () => {
  const result = await scanFor(CURRENT_TOPOLOGY);

  assert(result.ok);
  if (!result.ok) return;
  assertEquals(
    result.value.actions,
    [],
    "a PR that is ahead of its base and not behind needs no update — proposing one every cycle is the oscillation (Issue #470)",
  );
  assertEquals(result.value.skippedCount, 1);
});

Deno.test("branch update - a PR genuinely behind its base is still updated", async () => {
  const result = await scanFor(STALE_TOPOLOGY);

  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.actions.length, 1, "a stale branch still updates");
  const action = result.value.actions[0]!;
  assertEquals(action.prNumber, PR_NUMBER);
  assertEquals(action.reason, "behind");
  assertEquals(action.behindBy, 4);
});
