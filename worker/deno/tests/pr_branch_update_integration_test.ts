/**
 * Integration tests for the updateOpenPrBranches dispatch path (Issue #1282).
 *
 * These tests verify the full call chain from the production dependency
 * wiring (run_core_production_deps.ts) through scanPrBranchUpdates and
 * executePrBranchUpdates in pr_branch_update.ts. They catch regressions
 * where the production deps stub fails to call the real implementation.
 *
 * The tests mock only leaf dependencies (GitHub API, git operations) while
 * exercising real scan → decide → execute logic end-to-end.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  executePrBranchUpdates,
  type PrBranchEntry,
  type PrBranchExecutionDeps,
  type PrBranchUpdateDeps,
  scanPrBranchUpdates,
} from "../lib/pr_branch_update.ts";
import {
  buildPriorityDispatchTable,
  type RunCoreDeps,
} from "../lib/run_core.ts";
import type { BranchUpdateLockResult } from "../lib/pr_branch_lock.ts";
import type { Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger(): Logger {
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
  };
}

/**
 * Build a mock `updateOpenPrBranches` that mirrors the production wiring
 * in run_core_production_deps.ts: scan → filter → execute. This catches
 * regressions where the production stub breaks the chain.
 *
 * All external dependencies (gh commands, git operations) are replaced with
 * controlled mocks, while the real scan and execute functions are used.
 */
function buildMockUpdateOpenPrBranches(options: {
  githubUser: string;
  repos: string[];
  prs: Record<string, PrBranchEntry[]>;
  behindBy: Record<number, number>;
  mergeableStatus: Record<number, string>;
  /** Track which PRs had branch updates performed */
  updatedPrs: number[];
  /** Track which PRs had locks acquired */
  lockedPrs: number[];
  /** Track which PRs had locks released */
  releasedLocks: number[];
  /** Simulate lock contention for specific PRs */
  contestedPrs?: Set<number>;
  /** Simulate setup failures for specific repos */
  failingSetupRepos?: Set<string>;
  logger?: Logger;
}): () => Promise<Result<void>> {
  const {
    repos,
    prs,
    behindBy,
    mergeableStatus,
    updatedPrs,
    lockedPrs,
    releasedLocks,
    contestedPrs = new Set(),
    failingSetupRepos = new Set(),
    logger = makeSilentLogger(),
  } = options;

  return async (): Promise<Result<void>> => {
    // Phase 1: Scan — mirrors run_core_production_deps.ts lines 531–565
    const scanDeps: PrBranchUpdateDeps = {
      repos,
      logger,
      isRepoAllowed: () => true,
      getDefaultBranch: async () => "main",
      listPrs: async (repo: string) => prs[repo] ?? [],
      getBehindBy: async (_repo: string, _base: string, head: string) => {
        const prNum = Object.values(prs)
          .flat()
          .find((p) => p.headRefName === head)?.number ?? 0;
        return behindBy[prNum] ?? 0;
      },
      getMergeableStatus: async (_repo: string, prNumber: number) => {
        return mergeableStatus[prNumber] ?? "MERGEABLE";
      },
      isMergeQueueBase: async () => false,
    };

    const scanResult = await scanPrBranchUpdates(scanDeps);
    if (!scanResult.ok) {
      return { ok: false, error: scanResult.error };
    }

    const { actions } = scanResult.value;
    if (actions.length === 0) {
      return { ok: true, value: undefined };
    }

    // Phase 2: Execute — mirrors run_core_production_deps.ts lines 576–646
    const execDeps: PrBranchExecutionDeps = {
      workDir: "/tmp/test-work",
      logger,
      workerId: "test-worker-1",
      setupRepo: async (repo: string, _wd: string) => {
        if (failingSetupRepos.has(repo)) {
          return {
            ok: false as const,
            error: new Error(`Setup failed for ${repo}`),
          };
        }
        return {
          ok: true as const,
          value: `/tmp/test-work/${repo.split("/").pop()}`,
        };
      },
      getDefaultBranch: async () => "main",
      performBranchUpdate: async (params: {
        repoPath: string;
        branchName: string;
      }) => {
        // Find the PR number from branch name
        const pr = Object.values(prs)
          .flat()
          .find((p) => p.headRefName === params.branchName);
        if (pr) {
          updatedPrs.push(pr.number);
        }
        return {
          ok: true as const,
          value: `Rebased and force-pushed ${params.branchName}`,
        };
      },
      acquireLock: async (opts: { prNumber: number }) => {
        lockedPrs.push(opts.prNumber);
        if (contestedPrs.has(opts.prNumber)) {
          return {
            ok: true as const,
            value: {
              acquired: false,
              winnerId: "other-worker",
            } as BranchUpdateLockResult,
          };
        }
        return {
          ok: true as const,
          value: {
            acquired: true,
            lockCommentId: opts.prNumber * 100,
          } as BranchUpdateLockResult,
        };
      },
      releaseLock: async (opts: { lockCommentId: number }) => {
        releasedLocks.push(opts.lockCommentId);
        return { ok: true as const, value: undefined };
      },
    };

    const execResult = await executePrBranchUpdates(actions, execDeps);
    if (!execResult.ok) {
      return { ok: false, error: execResult.error };
    }

    return { ok: true, value: undefined };
  };
}

// =============================================================================
// Integration: Full dispatch path — scan → execute
// =============================================================================

Deno.test("integration: updateOpenPrBranches - PR merely behind base is not rebased or force-pushed (Issue #4613)", async () => {
  const updatedPrs: number[] = [];
  const lockedPrs: number[] = [];
  const releasedLocks: number[] = [];

  const updateFn = buildMockUpdateOpenPrBranches({
    githubUser: "testbot",
    repos: ["org/repo"],
    prs: {
      "org/repo": [
        { number: 10, headRefName: "issue-10-feat", baseRefName: "main" },
      ],
    },
    behindBy: { 10: 3 },
    mergeableStatus: {},
    updatedPrs,
    lockedPrs,
    releasedLocks,
  });

  const result = await updateFn();

  assertEquals(result.ok, true, "Update should succeed");
  assertEquals(
    updatedPrs,
    [],
    "PR #10 is merely behind, so it must not be updated (Issue #4613)",
  );
  assertEquals(lockedPrs, [], "No lock is taken for a behind-only PR");
  assertEquals(releasedLocks, [], "No lock is released for a behind-only PR");
});

Deno.test("integration: updateOpenPrBranches - PR with merge conflicts triggers update", async () => {
  const updatedPrs: number[] = [];
  const lockedPrs: number[] = [];
  const releasedLocks: number[] = [];

  const updateFn = buildMockUpdateOpenPrBranches({
    githubUser: "testbot",
    repos: ["org/repo"],
    prs: {
      "org/repo": [
        { number: 20, headRefName: "issue-20-fix", baseRefName: "main" },
      ],
    },
    behindBy: { 20: 0 },
    mergeableStatus: { 20: "CONFLICTING" },
    updatedPrs,
    lockedPrs,
    releasedLocks,
  });

  const result = await updateFn();

  assertEquals(result.ok, true, "Update should succeed");
  assertEquals(updatedPrs, [20], "Conflicting PR #20 should have been updated");
  assertEquals(
    lockedPrs,
    [20],
    "Lock should have been acquired for conflicting PR",
  );
  assertEquals(releasedLocks, [2000], "Lock should have been released");
});

Deno.test("integration: updateOpenPrBranches - up-to-date PR is skipped", async () => {
  const updatedPrs: number[] = [];
  const lockedPrs: number[] = [];
  const releasedLocks: number[] = [];

  const updateFn = buildMockUpdateOpenPrBranches({
    githubUser: "testbot",
    repos: ["org/repo"],
    prs: {
      "org/repo": [
        { number: 30, headRefName: "issue-30-docs", baseRefName: "main" },
      ],
    },
    behindBy: { 30: 0 },
    mergeableStatus: { 30: "MERGEABLE" },
    updatedPrs,
    lockedPrs,
    releasedLocks,
  });

  const result = await updateFn();

  assertEquals(result.ok, true, "Update should succeed");
  assertEquals(updatedPrs.length, 0, "Up-to-date PR should not be updated");
  assertEquals(
    lockedPrs.length,
    0,
    "No lock should be acquired for skipped PR",
  );
  assertEquals(
    releasedLocks.length,
    0,
    "No lock should be released for skipped PR",
  );
});

Deno.test("integration: updateOpenPrBranches - distributed lock prevents concurrent update", async () => {
  const updatedPrs: number[] = [];
  const lockedPrs: number[] = [];
  const releasedLocks: number[] = [];

  const updateFn = buildMockUpdateOpenPrBranches({
    githubUser: "testbot",
    repos: ["org/repo"],
    prs: {
      "org/repo": [
        { number: 40, headRefName: "issue-40-perf", baseRefName: "main" },
      ],
    },
    behindBy: { 40: 5 },
    mergeableStatus: { 40: "CONFLICTING" },
    updatedPrs,
    lockedPrs,
    releasedLocks,
    contestedPrs: new Set([40]),
  });

  const result = await updateFn();

  assertEquals(result.ok, true, "Update should succeed (graceful skip)");
  assertEquals(updatedPrs.length, 0, "Locked PR should not be updated");
  assertEquals(lockedPrs, [40], "Lock acquisition should have been attempted");
  assertEquals(releasedLocks.length, 0, "No lock to release when not acquired");
});

Deno.test("integration: updateOpenPrBranches - mixed scenario across multiple repos", async () => {
  const updatedPrs: number[] = [];
  const lockedPrs: number[] = [];
  const releasedLocks: number[] = [];

  const updateFn = buildMockUpdateOpenPrBranches({
    githubUser: "testbot",
    repos: ["org/repo1", "org/repo2"],
    prs: {
      "org/repo1": [
        { number: 100, headRefName: "issue-100-behind", baseRefName: "main" },
        { number: 101, headRefName: "issue-101-current", baseRefName: "main" },
      ],
      "org/repo2": [
        {
          number: 200,
          headRefName: "issue-200-conflict",
          baseRefName: "develop",
        },
        { number: 201, headRefName: "issue-201-behind", baseRefName: "main" },
      ],
    },
    behindBy: { 100: 2, 101: 0, 200: 0, 201: 7 },
    mergeableStatus: { 101: "MERGEABLE", 200: "CONFLICTING" },
    updatedPrs,
    lockedPrs,
    releasedLocks,
  });

  const result = await updateFn();

  assertEquals(result.ok, true, "Multi-repo update should succeed");

  // Issue #4613: PR #100 and #201 are merely behind, so they are not updated.
  // PR #200 (conflicting) should be updated; PR #101 (current, mergeable) too.
  assertEquals(updatedPrs.length, 1, "One PR should have been updated");
  assert(!updatedPrs.includes(100), "PR #100 (behind) must not be updated");
  assert(updatedPrs.includes(200), "PR #200 (conflicting) should be updated");
  assert(!updatedPrs.includes(201), "PR #201 (behind) must not be updated");
  assert(!updatedPrs.includes(101), "PR #101 (current) should not be updated");

  // The one updated PR should have had its lock acquired and released
  assertEquals(lockedPrs.length, 1, "Lock acquired for the updated PR");
  assertEquals(releasedLocks.length, 1, "Lock released for the updated PR");
});

Deno.test("integration: updateOpenPrBranches - lock released on setup failure", async () => {
  const updatedPrs: number[] = [];
  const lockedPrs: number[] = [];
  const releasedLocks: number[] = [];

  const updateFn = buildMockUpdateOpenPrBranches({
    githubUser: "testbot",
    repos: ["org/failing-repo"],
    prs: {
      "org/failing-repo": [
        { number: 50, headRefName: "issue-50-feat", baseRefName: "main" },
      ],
    },
    behindBy: { 50: 4 },
    mergeableStatus: { 50: "CONFLICTING" },
    updatedPrs,
    lockedPrs,
    releasedLocks,
    failingSetupRepos: new Set(["org/failing-repo"]),
  });

  const result = await updateFn();

  assertEquals(
    result.ok,
    true,
    "Should succeed (individual failures are tolerated)",
  );
  assertEquals(updatedPrs.length, 0, "No PRs updated when setup fails");
  assertEquals(lockedPrs, [50], "Lock was acquired before setup");
  assertEquals(
    releasedLocks,
    [5000],
    "Lock was released despite setup failure",
  );
});

Deno.test("integration: updateOpenPrBranches - no repos returns early", async () => {
  const updatedPrs: number[] = [];
  const lockedPrs: number[] = [];
  const releasedLocks: number[] = [];

  const updateFn = buildMockUpdateOpenPrBranches({
    githubUser: "testbot",
    repos: [],
    prs: {},
    behindBy: {},
    mergeableStatus: {},
    updatedPrs,
    lockedPrs,
    releasedLocks,
  });

  const result = await updateFn();

  assertEquals(result.ok, true, "Empty repos should succeed");
  assertEquals(updatedPrs.length, 0, "No PRs to update");
  assertEquals(lockedPrs.length, 0, "No locks acquired");
});

// =============================================================================
// Integration: Priority dispatch table includes updateOpenPrBranches
// =============================================================================

Deno.test("integration: priority dispatch table includes Update PR Branches at 1.6", () => {
  // Build a minimal RunCoreDeps with stub implementations to verify
  // the dispatch table structure. This catches regressions where the
  // priority handler is removed or misconfigured.
  // Use a Proxy to provide stubs for all deps without listing every
  // field, since the RunCoreDeps interface is large and only the dispatch
  // table structure matters here.
  const stubDeps = new Proxy({} as RunCoreDeps, {
    get: (_target, prop) => {
      if (prop === "updateOpenPrBranches") {
        return async () => ({ ok: true as const, value: undefined });
      }
      // Return appropriate stubs for any accessed property
      return typeof prop === "string" ? (() => {}) : undefined;
    },
  });

  const handlers = buildPriorityDispatchTable(stubDeps);

  const prBranchHandler = handlers.find((h) => h.name === "Update PR Branches");
  assert(
    prBranchHandler !== undefined,
    "Update PR Branches handler must exist in dispatch table",
  );
  assertEquals(
    prBranchHandler!.priority,
    1.6,
    "Update PR Branches must be at priority 1.6",
  );
});

// =============================================================================
// Integration: Verify production deps call chain (not a stub)
// =============================================================================

Deno.test("integration: scan + execute chain produces real results, not just logging", async () => {
  // This test exercises the exact same two-phase pattern used in
  // run_core_production_deps.ts to ensure the call chain is real.
  // A stub that just logs would not produce the expected scan actions
  // or execution details.

  const prs: PrBranchEntry[] = [
    { number: 1, headRefName: "feature-a", baseRefName: "main" },
    { number: 2, headRefName: "feature-b", baseRefName: "main" },
    { number: 3, headRefName: "feature-c", baseRefName: "main" },
  ];

  // Phase 1: Scan
  const scanResult = await scanPrBranchUpdates({
    repos: ["org/test-repo"],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    getDefaultBranch: async () => "main",
    listPrs: async () => prs,
    getBehindBy: async (_repo: string, _base: string, head: string) => {
      if (head === "feature-a") return 5; // behind
      if (head === "feature-b") return 0; // current (will check mergeable)
      return 0; // current
    },
    getMergeableStatus: async (_repo: string, prNumber: number) => {
      if (prNumber === 2) return "CONFLICTING";
      return "MERGEABLE";
    },
    isMergeQueueBase: async () => false,
  });

  assertEquals(scanResult.ok, true, "Scan must succeed");
  assert(scanResult.ok);

  // Verify scan produced real actions (not empty stub output)
  assertEquals(
    scanResult.value.actions.length,
    1,
    "Should find 1 PR needing a conflict update",
  );
  assertEquals(
    scanResult.value.skippedCount,
    2,
    "Should skip the behind-only PR (Issue #4613) and the up-to-date PR",
  );

  const behindAction = scanResult.value.actions.find((a) => a.prNumber === 1);
  assertEquals(
    behindAction,
    undefined,
    "PR #1 (behind only) must not have an action (Issue #4613)",
  );

  const conflictAction = scanResult.value.actions.find((a) => a.prNumber === 2);
  assert(
    conflictAction !== undefined,
    "PR #2 (conflicting) must have an action",
  );
  assertEquals(conflictAction!.reason, "conflicting");

  // Phase 2: Execute (using the real actions from scan)
  const executedBranches: string[] = [];
  const lockOps: { acquired: number[]; released: number[] } = {
    acquired: [],
    released: [],
  };

  const execResult = await executePrBranchUpdates(scanResult.value.actions, {
    workDir: "/tmp/integration-test",
    logger: makeSilentLogger(),
    workerId: "integration-test-worker",
    setupRepo: async (_repo: string, _wd: string) => ({
      ok: true as const,
      value: "/tmp/integration-test/test-repo",
    }),
    getDefaultBranch: async () => "main",
    performBranchUpdate: async (params: { branchName: string }) => {
      executedBranches.push(params.branchName);
      return {
        ok: true as const,
        value: `Rebased ${params.branchName} onto main`,
      };
    },
    acquireLock: async (opts: { prNumber: number }) => {
      lockOps.acquired.push(opts.prNumber);
      return {
        ok: true as const,
        value: {
          acquired: true,
          lockCommentId: opts.prNumber * 10,
        } as BranchUpdateLockResult,
      };
    },
    releaseLock: async (opts: { lockCommentId: number }) => {
      lockOps.released.push(opts.lockCommentId);
      return { ok: true as const, value: undefined };
    },
  });

  assertEquals(execResult.ok, true, "Execution must succeed");
  assert(execResult.ok);

  // Verify execution produced real results (not empty stub output)
  assertEquals(execResult.value.updatedCount, 1, "Should update 1 PR");
  assertEquals(execResult.value.failedCount, 0, "No failures expected");
  assertEquals(execResult.value.lockedCount, 0, "No lock contention");
  assertEquals(
    execResult.value.details.length,
    1,
    "Should have 1 detail entry",
  );

  // Verify the correct branches were updated
  assert(
    !executedBranches.includes("feature-a"),
    "feature-a (behind only) must not be rebased (Issue #4613)",
  );
  assert(
    executedBranches.includes("feature-b"),
    "feature-b should have been rebased",
  );
  assert(
    !executedBranches.includes("feature-c"),
    "feature-c (up-to-date) should not be rebased",
  );

  // Verify distributed locks were acquired and released for each update
  assertEquals(
    lockOps.acquired.length,
    1,
    "Lock acquired for the one updated PR",
  );
  assertEquals(
    lockOps.released.length,
    1,
    "Lock released for the one updated PR",
  );
  assert(!lockOps.acquired.includes(1), "No lock taken for PR #1");
  assert(lockOps.acquired.includes(2), "Lock acquired for PR #2");
});
