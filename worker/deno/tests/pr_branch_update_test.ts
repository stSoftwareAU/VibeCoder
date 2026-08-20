/**
 * Tests for pr_branch_update.ts — PR branch update decision logic.
 *
 * Issue #1122: Migrated from update_open_pr_branches() in issue_worker.sh.
 * Issue #1281: Added distributed lock integration tests.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { prBranchConflictError } from "../lib/git_pull.ts";
import { assertEquals } from "@std/assert";
import {
  decidePrUpdateAction,
  executePrBranchUpdates,
  isWorkerPr,
  type PrBranchEntry,
  type PrBranchExecutionDeps,
  type PrBranchUpdateAction,
  type PrBranchUpdateDeps,
  resetPrConflictWarnings,
  scanPrBranchUpdates,
} from "../lib/pr_branch_update.ts";
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

function makeBaseDeps(
  overrides?: Partial<PrBranchUpdateDeps>,
): PrBranchUpdateDeps {
  return {
    repos: ["org/repo"],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    getDefaultBranch: async () => "main",
    listPrs: async () => [],
    getBehindBy: async () => 0,
    getMergeableStatus: async () => "MERGEABLE",
    ...overrides,
  };
}

function makePr(overrides?: Partial<PrBranchEntry>): PrBranchEntry {
  return {
    number: 42,
    headRefName: "issue-42-fix-bug",
    baseRefName: "main",
    ...overrides,
  };
}

// =============================================================================
// decidePrUpdateAction
// =============================================================================

Deno.test("decidePrUpdateAction - returns behind action when PR is behind base", () => {
  const pr = makePr();
  const action = decidePrUpdateAction("org/repo", pr, "main", 3, "");

  assertEquals(action !== null, true);
  assertEquals(action!.reason, "behind");
  assertEquals(action!.behindBy, 3);
  assertEquals(action!.prNumber, 42);
  assertEquals(action!.branchName, "issue-42-fix-bug");
  assertEquals(action!.baseBranch, "main");
  assertEquals(action!.repo, "org/repo");
});

Deno.test("decidePrUpdateAction - returns conflicting action when PR has merge conflicts", () => {
  const pr = makePr();
  const action = decidePrUpdateAction("org/repo", pr, "main", 0, "CONFLICTING");

  assertEquals(action !== null, true);
  assertEquals(action!.reason, "conflicting");
  assertEquals(action!.behindBy, 0);
});

Deno.test("decidePrUpdateAction - returns null when PR is current and mergeable", () => {
  const pr = makePr();
  const action = decidePrUpdateAction("org/repo", pr, "main", 0, "MERGEABLE");

  assertEquals(action, null);
});

Deno.test("decidePrUpdateAction - returns null when PR is current with unknown status", () => {
  const pr = makePr();
  const action = decidePrUpdateAction("org/repo", pr, "main", 0, "UNKNOWN");

  assertEquals(action, null);
});

Deno.test("decidePrUpdateAction - returns null when PR is current and status is empty", () => {
  const pr = makePr();
  const action = decidePrUpdateAction("org/repo", pr, "main", 0, "");

  assertEquals(action, null);
});

Deno.test("decidePrUpdateAction - behind takes priority over any mergeable status", () => {
  const pr = makePr();
  // Even if mergeable status is CONFLICTING, behind_by > 0 means reason is "behind"
  const action = decidePrUpdateAction("org/repo", pr, "main", 5, "CONFLICTING");

  assertEquals(action !== null, true);
  assertEquals(action!.reason, "behind");
  assertEquals(action!.behindBy, 5);
});

Deno.test("decidePrUpdateAction - preserves custom base branch", () => {
  const pr = makePr({ baseRefName: "milestone/v2" });
  const action = decidePrUpdateAction("org/repo", pr, "milestone/v2", 1, "");

  assertEquals(action !== null, true);
  assertEquals(action!.baseBranch, "milestone/v2");
});

// =============================================================================
// scanPrBranchUpdates — empty/no repos
// =============================================================================

Deno.test("scanPrBranchUpdates - returns empty result for no repos", async () => {
  const deps = makeBaseDeps({ repos: [] });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 0);
    assertEquals(result.value.skippedCount, 0);
    assertEquals(result.value.failedCount, 0);
  }
});

Deno.test("scanPrBranchUpdates - skips repos not in allowlist", async () => {
  const deps = makeBaseDeps({
    repos: ["org/blocked-repo"],
    isRepoAllowed: () => false,
    listPrs: async () => {
      throw new Error("Should not be called");
    },
  });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 0);
  }
});

// =============================================================================
// scanPrBranchUpdates — PR scanning decisions
// =============================================================================

Deno.test("scanPrBranchUpdates - returns action for PR behind base", async () => {
  const deps = makeBaseDeps({
    listPrs: async () => [makePr()],
    getBehindBy: async () => 5,
  });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 1);
    assertEquals(result.value.actions[0]!.reason, "behind");
    assertEquals(result.value.actions[0]!.behindBy, 5);
    assertEquals(result.value.skippedCount, 0);
  }
});

Deno.test("scanPrBranchUpdates - returns action for conflicting PR", async () => {
  const deps = makeBaseDeps({
    listPrs: async () => [makePr()],
    getBehindBy: async () => 0,
    getMergeableStatus: async () => "CONFLICTING",
  });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 1);
    assertEquals(result.value.actions[0]!.reason, "conflicting");
  }
});

Deno.test("scanPrBranchUpdates - skips current and mergeable PR", async () => {
  const deps = makeBaseDeps({
    listPrs: async () => [makePr()],
    getBehindBy: async () => 0,
    getMergeableStatus: async () => "MERGEABLE",
  });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 0);
    assertEquals(result.value.skippedCount, 1);
  }
});

Deno.test("scanPrBranchUpdates - increments failedCount on getBehindBy error", async () => {
  const deps = makeBaseDeps({
    listPrs: async () => [makePr()],
    getBehindBy: async () => {
      throw new Error("API error");
    },
  });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 0);
    assertEquals(result.value.failedCount, 1);
  }
});

Deno.test("scanPrBranchUpdates - skips PR when getMergeableStatus fails", async () => {
  const deps = makeBaseDeps({
    listPrs: async () => [makePr()],
    getBehindBy: async () => 0,
    getMergeableStatus: async () => {
      throw new Error("API error");
    },
  });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 0);
    assertEquals(result.value.skippedCount, 1);
  }
});

Deno.test("scanPrBranchUpdates - uses default branch when baseRefName is empty", async () => {
  const deps = makeBaseDeps({
    listPrs: async () => [makePr({ baseRefName: "" })],
    getDefaultBranch: async () => "develop",
    getBehindBy: async () => 2,
  });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 1);
    assertEquals(result.value.actions[0]!.baseBranch, "develop");
  }
});

Deno.test("scanPrBranchUpdates - falls back to main when getDefaultBranch fails", async () => {
  const deps = makeBaseDeps({
    listPrs: async () => [makePr({ baseRefName: "" })],
    getDefaultBranch: async () => {
      throw new Error("API error");
    },
    getBehindBy: async () => 1,
  });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 1);
    assertEquals(result.value.actions[0]!.baseBranch, "main");
  }
});

Deno.test("scanPrBranchUpdates - processes multiple repos and PRs", async () => {
  const prsByRepo: Record<string, PrBranchEntry[]> = {
    "org/repo1": [
      makePr({ number: 10, headRefName: "issue-10-fix" }),
      makePr({ number: 11, headRefName: "issue-11-feat" }),
    ],
    "org/repo2": [
      makePr({ number: 20, headRefName: "issue-20-refactor" }),
    ],
  };

  const behindByPr: Record<number, number> = {
    10: 3,
    11: 0,
    20: 0,
  };

  const mergeableByPr: Record<number, string> = {
    11: "MERGEABLE",
    20: "CONFLICTING",
  };

  const deps = makeBaseDeps({
    repos: ["org/repo1", "org/repo2"],
    listPrs: async (repo: string) => prsByRepo[repo] ?? [],
    getBehindBy: async (_repo: string, _base: string, head: string) => {
      const prNum = Object.entries(prsByRepo)
        .flatMap(([, prs]) => prs)
        .find((p) => p.headRefName === head)?.number ?? 0;
      return behindByPr[prNum] ?? 0;
    },
    getMergeableStatus: async (_repo: string, prNumber: number) => {
      return mergeableByPr[prNumber] ?? "MERGEABLE";
    },
  });

  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    // PR #10 is behind (action), PR #11 is current (skipped), PR #20 is conflicting (action)
    assertEquals(result.value.actions.length, 2);
    assertEquals(result.value.skippedCount, 1);

    const pr10Action = result.value.actions.find((a) => a.prNumber === 10);
    assertEquals(pr10Action?.reason, "behind");
    assertEquals(pr10Action?.behindBy, 3);

    const pr20Action = result.value.actions.find((a) => a.prNumber === 20);
    assertEquals(pr20Action?.reason, "conflicting");
  }
});

Deno.test("scanPrBranchUpdates - continues scanning after listPrs failure", async () => {
  const deps = makeBaseDeps({
    repos: ["org/failing-repo", "org/good-repo"],
    listPrs: async (repo: string) => {
      if (repo === "org/failing-repo") throw new Error("API error");
      return [makePr({ number: 50 })];
    },
    getBehindBy: async () => 1,
  });

  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    // Good repo's PR is still found despite earlier repo failure
    assertEquals(result.value.actions.length, 1);
    assertEquals(result.value.actions[0]!.prNumber, 50);
  }
});

// =============================================================================
// scanPrBranchUpdates — fetchBranchStateBatch wiring (Issue #1807)
// =============================================================================

Deno.test("scanPrBranchUpdates - uses batched state when fetchBranchStateBatch succeeds", async () => {
  let getBehindByCalls = 0;
  let getMergeableCalls = 0;
  let batchCalls = 0;
  const prs = [
    makePr({ number: 10, headRefName: "issue-10-a" }),
    makePr({ number: 11, headRefName: "issue-11-b" }),
    makePr({ number: 12, headRefName: "issue-12-c" }),
  ];
  const deps = makeBaseDeps({
    listPrs: async () => prs,
    getBehindBy: async () => {
      getBehindByCalls++;
      return 0;
    },
    getMergeableStatus: async () => {
      getMergeableCalls++;
      return "";
    },
    fetchBranchStateBatch: async (repo, batchPrs) => {
      batchCalls++;
      assertEquals(repo, "org/repo");
      assertEquals(batchPrs.length, 3);
      return new Map([
        [10, { behindBy: 5, mergeable: "MERGEABLE" }],
        [11, { behindBy: 0, mergeable: "CONFLICTING" }],
        [12, { behindBy: 0, mergeable: "MERGEABLE" }],
      ]);
    },
  });

  const result = await scanPrBranchUpdates(deps);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(batchCalls, 1);
  assertEquals(
    getBehindByCalls,
    0,
    "batch hit should skip per-PR REST behind call",
  );
  assertEquals(
    getMergeableCalls,
    0,
    "batch hit should skip per-PR REST mergeable call",
  );
  assertEquals(result.value.actions.length, 2);
  assertEquals(result.value.skippedCount, 1);
  const pr10 = result.value.actions.find((a) => a.prNumber === 10);
  assertEquals(pr10?.reason, "behind");
  assertEquals(pr10?.behindBy, 5);
  const pr11 = result.value.actions.find((a) => a.prNumber === 11);
  assertEquals(pr11?.reason, "conflicting");
});

Deno.test("scanPrBranchUpdates - falls back to per-PR REST when batch returns null", async () => {
  let getBehindByCalls = 0;
  let getMergeableCalls = 0;
  const deps = makeBaseDeps({
    listPrs: async () => [
      makePr({ number: 10 }),
      makePr({ number: 11, headRefName: "issue-11" }),
    ],
    getBehindBy: async () => {
      getBehindByCalls++;
      return 0;
    },
    getMergeableStatus: async () => {
      getMergeableCalls++;
      return "MERGEABLE";
    },
    fetchBranchStateBatch: async () => null,
  });

  const result = await scanPrBranchUpdates(deps);
  assertEquals(result.ok, true);
  assertEquals(
    getBehindByCalls,
    2,
    "fall back to per-PR behindBy when batch returns null",
  );
  assertEquals(
    getMergeableCalls,
    2,
    "fall back to per-PR mergeable when batch returns null",
  );
});

Deno.test("scanPrBranchUpdates - falls back to per-PR REST when batch throws", async () => {
  let getBehindByCalls = 0;
  const deps = makeBaseDeps({
    listPrs: async () => [makePr({ number: 10 })],
    getBehindBy: async () => {
      getBehindByCalls++;
      return 1;
    },
    fetchBranchStateBatch: async () => {
      throw new Error("graphql outage");
    },
  });

  const result = await scanPrBranchUpdates(deps);
  assertEquals(result.ok, true);
  assertEquals(
    getBehindByCalls,
    1,
    "fall back to per-PR REST on batch failure",
  );
});

Deno.test("scanPrBranchUpdates - missing PR in batch falls back to per-PR REST for that PR", async () => {
  let getBehindByCalls = 0;
  const deps = makeBaseDeps({
    listPrs: async () => [
      makePr({ number: 10 }),
      makePr({ number: 11, headRefName: "issue-11" }),
    ],
    getBehindBy: async (_repo, _base, head) => {
      getBehindByCalls++;
      return head === "issue-11" ? 2 : 0;
    },
    getMergeableStatus: async () => "MERGEABLE",
    fetchBranchStateBatch: async () => {
      // Only #10 in batch — #11 falls back.
      return new Map([[10, { behindBy: 0, mergeable: "MERGEABLE" }]]);
    },
  });

  const result = await scanPrBranchUpdates(deps);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(getBehindByCalls, 1, "PR not in batch must use REST fallback");
  // PR #11 is behind 2 → action; PR #10 is current+mergeable → skipped.
  assertEquals(result.value.actions.length, 1);
  assertEquals(result.value.actions[0]?.prNumber, 11);
});

Deno.test("scanPrBranchUpdates - skips batch helper for empty PR list", async () => {
  let batchCalls = 0;
  const deps = makeBaseDeps({
    listPrs: async () => [],
    fetchBranchStateBatch: async () => {
      batchCalls++;
      return new Map();
    },
  });
  const result = await scanPrBranchUpdates(deps);
  assertEquals(result.ok, true);
  assertEquals(batchCalls, 0);
});

Deno.test("scanPrBranchUpdates - behind PR uses behind reason regardless of mergeable status", async () => {
  const deps = makeBaseDeps({
    listPrs: async () => [makePr()],
    getBehindBy: async () => 3,
    getMergeableStatus: async () => "MERGEABLE",
  });

  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 1);
    assertEquals(result.value.actions[0]!.reason, "behind");
    assertEquals(result.value.actions[0]!.behindBy, 3);
  }
});

// =============================================================================
// executePrBranchUpdates — Issue #1233
// =============================================================================

function makeAction(
  overrides?: Partial<PrBranchUpdateAction>,
): PrBranchUpdateAction {
  return {
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    baseBranch: "main",
    behindBy: 3,
    reason: "behind",
    ...overrides,
  };
}

function makeExecDeps(
  overrides?: Partial<PrBranchExecutionDeps>,
): PrBranchExecutionDeps {
  return {
    workDir: "/tmp/work",
    logger: makeSilentLogger(),
    setupRepo: async (_repo: string, _workDir: string) =>
      ({ ok: true, value: "/tmp/work/repo" }) as Result<string>,
    getDefaultBranch: async () => "main",
    performBranchUpdate: async () =>
      ({ ok: true, value: "Updated successfully" }) as Result<string>,
    ...overrides,
  };
}

Deno.test("executePrBranchUpdates - returns empty result when no actions", async () => {
  const deps = makeExecDeps();
  const result = await executePrBranchUpdates([], deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 0);
    assertEquals(result.value.failedCount, 0);
    assertEquals(result.value.lockedCount, 0);
    assertEquals(result.value.details.length, 0);
  }
});

Deno.test("executePrBranchUpdates - successfully updates a behind PR", async () => {
  const actions = [makeAction()];
  const deps = makeExecDeps();
  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 1);
    assertEquals(result.value.failedCount, 0);
    assertEquals(result.value.details.length, 1);
    assertEquals(result.value.details[0]!.status, "updated");
    assertEquals(result.value.details[0]!.prNumber, 42);
    assertEquals(result.value.details[0]!.branchName, "issue-42-fix-bug");
  }
});

Deno.test("executePrBranchUpdates - records failure when setupRepo fails", async () => {
  const actions = [makeAction()];
  const deps = makeExecDeps({
    setupRepo: async () => ({ ok: false, error: new Error("Clone failed") }),
  });
  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 0);
    assertEquals(result.value.failedCount, 1);
    assertEquals(result.value.details[0]!.status, "failed");
    assertEquals(
      result.value.details[0]!.message.includes("Clone failed"),
      true,
    );
  }
});

Deno.test("executePrBranchUpdates - records failure when performBranchUpdate fails", async () => {
  const actions = [makeAction()];
  const deps = makeExecDeps({
    performBranchUpdate: async () => ({
      ok: false,
      error: new Error("Rebase failed"),
    }),
  });
  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 0);
    assertEquals(result.value.failedCount, 1);
    assertEquals(result.value.details[0]!.status, "failed");
    assertEquals(
      result.value.details[0]!.message.includes("Rebase failed"),
      true,
    );
  }
});

Deno.test("executePrBranchUpdates - a conflicting PR is recorded as 'conflict' (not failed), logged loudly, and never counted as updated (Issue #4373)", async () => {
  resetPrConflictWarnings();
  const actions = [makeAction({ prNumber: 4372, branchName: "issue-4369-x" })];
  const warnings: string[] = [];
  const deps = makeExecDeps({
    performBranchUpdate: async () => ({
      ok: false,
      error: prBranchConflictError("issue-4369-x", "Develop", "rebase"),
    }),
  });
  deps.logger = {
    ...deps.logger,
    warn: (m: string) => {
      warnings.push(m);
    },
  } as typeof deps.logger;
  const result = await executePrBranchUpdates(actions, deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 0);
    assertEquals(
      result.value.failedCount,
      0,
      "a conflict is not a failure of the updater",
    );
    assertEquals(result.value.details[0]!.status, "conflict");
    assertEquals(
      result.value.details[0]!.message.includes("left untouched"),
      true,
    );
  }
  assertEquals(
    warnings.some((w) =>
      w.includes("PR #4372") && w.includes("left untouched") &&
      w.includes("Issue #4373")
    ),
    true,
    warnings.join(" | "),
  );
});

Deno.test("executePrBranchUpdates - processes multiple actions across repos", async () => {
  const actions = [
    makeAction({ repo: "org/repo1", prNumber: 10, branchName: "issue-10-fix" }),
    makeAction({
      repo: "org/repo1",
      prNumber: 11,
      branchName: "issue-11-feat",
    }),
    makeAction({
      repo: "org/repo2",
      prNumber: 20,
      branchName: "issue-20-refactor",
    }),
  ];

  const deps = makeExecDeps({
    setupRepo: async (repo: string, _workDir: string) => {
      const repoName = repo.split("/").pop() ?? repo;
      return { ok: true, value: `/tmp/work/${repoName}` } as Result<string>;
    },
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 3);
    assertEquals(result.value.failedCount, 0);
    assertEquals(result.value.details.length, 3);
    // Verify each PR is represented in the results
    const prNumbers = result.value.details.map((d) => d.prNumber);
    assertEquals(prNumbers.includes(10), true);
    assertEquals(prNumbers.includes(11), true);
    assertEquals(prNumbers.includes(20), true);
  }
});

Deno.test("executePrBranchUpdates - continues after individual failures", async () => {
  const actions = [
    makeAction({ prNumber: 10, branchName: "issue-10-fix" }),
    makeAction({ prNumber: 11, branchName: "issue-11-feat" }),
    makeAction({ prNumber: 12, branchName: "issue-12-docs" }),
  ];

  const deps = makeExecDeps({
    performBranchUpdate: async (params: { branchName: string }) => {
      if (params.branchName === "issue-11-feat") {
        return { ok: false, error: new Error("Conflict") };
      }
      return { ok: true, value: "Updated" } as Result<string>;
    },
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 2);
    assertEquals(result.value.failedCount, 1);
    assertEquals(result.value.details.length, 3);

    const failedDetail = result.value.details.find((d) => d.prNumber === 11);
    assertEquals(failedDetail?.status, "failed");

    const successDetails = result.value.details.filter((d) =>
      d.status === "updated"
    );
    assertEquals(successDetails.length, 2);
  }
});

Deno.test("executePrBranchUpdates - succeeds when getDefaultBranch fails (fallback)", async () => {
  const actions = [makeAction()];

  const deps = makeExecDeps({
    getDefaultBranch: async () => {
      throw new Error("API error");
    },
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 1);
    assertEquals(result.value.failedCount, 0);
    assertEquals(result.value.details[0]!.status, "updated");
  }
});

Deno.test("executePrBranchUpdates - succeeds for custom base branch action", async () => {
  const actions = [makeAction({
    repo: "org/myrepo",
    branchName: "issue-99-feature",
    baseBranch: "develop",
  })];

  const deps = makeExecDeps({
    setupRepo: async () =>
      ({ ok: true, value: "/tmp/work/myrepo" }) as Result<string>,
    getDefaultBranch: async () => "develop",
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 1);
    assertEquals(result.value.details[0]!.status, "updated");
    assertEquals(result.value.details[0]!.branchName, "issue-99-feature");
  }
});

Deno.test("executePrBranchUpdates - behind PR is updated successfully", async () => {
  const actions = [makeAction({ reason: "behind", behindBy: 5 })];
  const deps = makeExecDeps();

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 1);
    assertEquals(result.value.details[0]!.status, "updated");
  }
});

Deno.test("executePrBranchUpdates - conflicting PR is updated successfully", async () => {
  const actions = [makeAction({ reason: "conflicting", behindBy: 0 })];
  const deps = makeExecDeps();

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 1);
    assertEquals(result.value.details[0]!.status, "updated");
  }
});

// =============================================================================
// executePrBranchUpdates — Distributed lock integration (Issue #1281)
// =============================================================================

Deno.test("executePrBranchUpdates - succeeds with lock when workerId set", async () => {
  const actions = [makeAction({ prNumber: 42 })];
  const deps = makeExecDeps({
    workerId: "test-worker",
    acquireLock: async () => ({
      ok: true,
      value: { acquired: true, lockCommentId: 999 } as BranchUpdateLockResult,
    }),
    releaseLock: async () => ({ ok: true, value: undefined }),
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 1);
    assertEquals(result.value.lockedCount, 0);
    assertEquals(result.value.details[0]!.status, "updated");
  }
});

Deno.test("executePrBranchUpdates - skips PR when lock not acquired", async () => {
  const actions = [makeAction({ prNumber: 42 })];
  const deps = makeExecDeps({
    workerId: "test-worker",
    acquireLock: async () => ({
      ok: true,
      value: {
        acquired: false,
        winnerId: "other-worker",
      } as BranchUpdateLockResult,
    }),
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 0);
    assertEquals(result.value.lockedCount, 1);
    assertEquals(result.value.failedCount, 0);
    assertEquals(result.value.details[0]!.status, "failed");
    assertEquals(
      result.value.details[0]!.message.includes("locked by another worker"),
      true,
    );
  }
});

Deno.test("executePrBranchUpdates - records failure when setup fails with lock", async () => {
  const actions = [makeAction()];
  const deps = makeExecDeps({
    workerId: "test-worker",
    acquireLock: async () => ({
      ok: true,
      value: { acquired: true, lockCommentId: 888 } as BranchUpdateLockResult,
    }),
    releaseLock: async () => ({ ok: true, value: undefined }),
    setupRepo: async () => ({ ok: false, error: new Error("Clone failed") }),
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.failedCount, 1);
    assertEquals(result.value.updatedCount, 0);
    assertEquals(result.value.details[0]!.status, "failed");
  }
});

Deno.test("executePrBranchUpdates - records failure when update fails with lock", async () => {
  const actions = [makeAction()];
  const deps = makeExecDeps({
    workerId: "test-worker",
    acquireLock: async () => ({
      ok: true,
      value: { acquired: true, lockCommentId: 777 } as BranchUpdateLockResult,
    }),
    releaseLock: async () => ({ ok: true, value: undefined }),
    performBranchUpdate: async () => ({
      ok: false,
      error: new Error("Rebase failed"),
    }),
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.failedCount, 1);
    assertEquals(result.value.updatedCount, 0);
    assertEquals(result.value.details[0]!.status, "failed");
  }
});

Deno.test("executePrBranchUpdates - succeeds without locking when no workerId", async () => {
  const actions = [makeAction()];
  const deps = makeExecDeps({
    // No workerId set — locking should be skipped
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.updatedCount, 1);
    assertEquals(result.value.lockedCount, 0);
    assertEquals(result.value.details[0]!.status, "updated");
  }
});

Deno.test("executePrBranchUpdates - handles lock acquisition error gracefully", async () => {
  const actions = [makeAction()];
  const deps = makeExecDeps({
    workerId: "test-worker",
    acquireLock: async () => ({
      ok: false,
      error: new Error("Lock API failure"),
    }),
  });

  const result = await executePrBranchUpdates(actions, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.lockedCount, 1);
    assertEquals(result.value.updatedCount, 0);
  }
});

// =============================================================================
// isWorkerPr — worker PR identification by body marker
// =============================================================================

Deno.test("isWorkerPr - the body marker is trusted only with a safe head branch (Issue #12)", () => {
  // Marker present and the branch is a safe git ref: worker-owned.
  assertEquals(
    isWorkerPr(
      "Some body\n<!-- vibe-worker-issue-42 -->",
      "milestone/17-security",
    ),
    true,
  );
  // Marker present but no branch to check: not trusted for maintenance.
  assertEquals(isWorkerPr("Some body\n<!-- vibe-worker-issue-42 -->"), false);
  // Marker pasted by an outside PR onto an argument-injecting branch: refused.
  assertEquals(
    isWorkerPr("<!-- vibe-worker-issue-42 -->", "--upload-pack=touch /tmp/x"),
    false,
  );
});

Deno.test("isWorkerPr - returns false for PR without marker or worker branch", () => {
  assertEquals(isWorkerPr("Just a normal PR body", "feature/something"), false);
});

Deno.test("isWorkerPr - returns false for empty body and no branch", () => {
  assertEquals(isWorkerPr(""), false);
});

Deno.test("isWorkerPr - returns false for undefined body and no branch", () => {
  assertEquals(isWorkerPr(undefined), false);
});

Deno.test("isWorkerPr - a marker from another worker identity is trusted with a safe branch", () => {
  const body =
    "## Summary\nSome changes\n\n🤖 Processed by: maintainer<!-- vibe-worker-issue-15 -->";
  assertEquals(isWorkerPr(body, "issue-15-something"), true);
  // …but the marker alone (no branch to vet) is not enough (Issue #12).
  assertEquals(isWorkerPr(body), false);
});

Deno.test("isWorkerPr - falls back to branch name pattern for older PRs", () => {
  // PR created before the marker was added — use branch name as fallback
  assertEquals(
    isWorkerPr("No marker here", "issue-14-extract-constants"),
    true,
  );
});

Deno.test("isWorkerPr - branch name fallback rejects non-worker branches", () => {
  assertEquals(isWorkerPr("No marker", "feature/my-change"), false);
  assertEquals(isWorkerPr(undefined, "hotfix-123"), false);
});

Deno.test("scanPrBranchUpdates - finds worker PRs regardless of author identity", async () => {
  // Simulates a PR created by a previous worker identity (e.g. maintainer)
  // that listPrs returns because it has the worker marker in its body
  const deps = makeBaseDeps({
    listPrs: async () => [makePr({ number: 23 })],
    getBehindBy: async () => 3,
  });
  const result = await scanPrBranchUpdates(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actions.length, 1);
    assertEquals(result.value.actions[0]!.prNumber, 23);
    assertEquals(result.value.actions[0]!.reason, "behind");
  }
});

Deno.test("executePrBranchUpdates - the conflict warning fires once per PR, not once per pass (Issue #84)", async () => {
  resetPrConflictWarnings();
  const actions = [makeAction({ prNumber: 48, branchName: "issue-16-fix" })];
  const warnings: string[] = [];
  const deps = makeExecDeps({
    performBranchUpdate: async () => ({
      ok: false,
      error: prBranchConflictError("issue-16-fix", "main", "merge"),
    }),
  });
  deps.logger = {
    ...deps.logger,
    warn: (m: string) => {
      warnings.push(m);
    },
  } as typeof deps.logger;

  // Three consecutive passes over the same still-conflicting PR.
  for (let pass = 0; pass < 3; pass++) {
    const result = await executePrBranchUpdates(actions, deps);
    assertEquals(result.ok, true);
    if (result.ok) {
      // Every pass still records the conflict — only the log line is deduped.
      assertEquals(result.value.details[0]!.status, "conflict");
      assertEquals(result.value.conflictCount, 1);
    }
  }

  assertEquals(
    warnings.filter((w) => w.includes("PR #48")).length,
    1,
    warnings.join(" | "),
  );
});

Deno.test("executePrBranchUpdates - each conflicting PR gets its own warning (Issue #84)", async () => {
  resetPrConflictWarnings();
  const warnings: string[] = [];
  const deps = makeExecDeps({
    performBranchUpdate: async () => ({
      ok: false,
      error: prBranchConflictError("branch", "main", "merge"),
    }),
  });
  deps.logger = {
    ...deps.logger,
    warn: (m: string) => {
      warnings.push(m);
    },
  } as typeof deps.logger;

  await executePrBranchUpdates([
    makeAction({ prNumber: 101, branchName: "issue-101-a" }),
    makeAction({ prNumber: 102, branchName: "issue-102-b" }),
  ], deps);

  assertEquals(warnings.filter((w) => w.includes("PR #101")).length, 1);
  assertEquals(warnings.filter((w) => w.includes("PR #102")).length, 1);
});
