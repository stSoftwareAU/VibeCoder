/**
 * A PR that merges mid-cycle is not a failed branch update (Issue #386).
 *
 * The scan decides a PR is behind, the execute step pushes ~60 s later, and
 * the PR can merge inside that window. `--force-with-lease` then refuses the
 * push with `(stale info)` — the lease doing its job, nothing broken — but the
 * run counted it as `failedCount` and logged a WARNING, so a genuine push
 * failure (protected branch, permissions, someone else's commits) read exactly
 * like a routine mid-cycle merge.
 *
 * These tests pin both halves: a since-merged PR is a no-op at INFO, and a
 * rejection against a still-open PR stays loud.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { prBranchConflictError } from "../lib/git_pull.ts";
import {
  classifyPrLiveState,
  executePrBranchUpdates,
  makeGhPrStateFetcher,
  type PrBranchExecutionDeps,
  type PrBranchUpdateAction,
  resetPrConflictWarnings,
} from "../lib/pr_branch_update.ts";
import {
  loadPrBranchFailureStreaks,
  prBranchFailureKey,
} from "../lib/pr_branch_update_failure_streak.ts";
import type { Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedLogs {
  info: string[];
  warn: string[];
}

function makeCapturingLogger(captured: CapturedLogs): Logger {
  const noop = () => {};
  return {
    info: (m: string) => {
      captured.info.push(m);
    },
    warn: (m: string) => {
      captured.warn.push(m);
    },
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

function makeAction(
  overrides?: Partial<PrBranchUpdateAction>,
): PrBranchUpdateAction {
  return {
    repo: "org/repo",
    prNumber: 381,
    branchName: "issue-364-fix-thing",
    baseBranch: "milestone/357-cleanup",
    behindBy: 2,
    reason: "behind",
    ...overrides,
  };
}

/** The exact git rejection a lease refusal produces. */
const STALE_INFO_ERROR = new Error(
  "Failed to push updated branch 'issue-364-fix-thing': " +
    " ! [rejected] issue-364-fix-thing -> issue-364-fix-thing (stale info)",
);

function makeExecDeps(
  overrides?: Partial<PrBranchExecutionDeps>,
): PrBranchExecutionDeps {
  return {
    workDir: "/tmp/work",
    logger: makeCapturingLogger({ info: [], warn: [] }),
    setupRepo: async () =>
      ({ ok: true, value: "/tmp/work/repo" }) as Result<
        string
      >,
    getDefaultBranch: async () => "main",
    performBranchUpdate: async () =>
      ({ ok: true, value: "Updated successfully" }) as Result<string>,
    ...overrides,
  };
}

// =============================================================================
// classifyPrLiveState
// =============================================================================

Deno.test("classifyPrLiveState - maps gh state strings onto the three outcomes", () => {
  assertEquals(classifyPrLiveState("OPEN"), "OPEN");
  assertEquals(classifyPrLiveState(" merged \n"), "MERGED");
  assertEquals(classifyPrLiveState("closed"), "CLOSED");
  assertEquals(classifyPrLiveState(""), "UNKNOWN");
  assertEquals(classifyPrLiveState("SOMETHING_ELSE"), "UNKNOWN");
});

Deno.test("makeGhPrStateFetcher - asks gh for the PR's state and returns it raw", async () => {
  const calls: string[][] = [];
  const fetcher = makeGhPrStateFetcher(async (args: string[]) => {
    calls.push(args);
    return "MERGED\n";
  });

  assertEquals(await fetcher("org/repo", 381), "MERGED\n");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.includes("381"), true);
  assertEquals(calls[0]!.includes("org/repo"), true);
  assertEquals(calls[0]!.includes("state"), true);
});

// =============================================================================
// Pre-push freshness re-check (Issue #386, same shape as #344 / #352)
// =============================================================================

Deno.test("executePrBranchUpdates - a PR merged between scan and push is a no-op, not an update attempt", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  let updateCalls = 0;
  const deps = makeExecDeps({
    logger: makeCapturingLogger(captured),
    getPrState: async () => "MERGED",
    performBranchUpdate: async () => {
      updateCalls++;
      return { ok: true, value: "should not run" };
    },
  });

  const result = await executePrBranchUpdates([makeAction()], deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(updateCalls, 0, "a merged PR must not be pushed at all");
  assertEquals(result.value.mergedCount, 1);
  assertEquals(result.value.failedCount, 0);
  assertEquals(result.value.updatedCount, 0);
  assertEquals(result.value.details[0]!.status, "merged");
  assertEquals(
    captured.info.some((m) =>
      m.includes("PR #381") && m.includes("merged") &&
      m.includes("nothing to do")
    ),
    true,
    captured.info.join(" | "),
  );
  assertEquals(captured.warn.length, 0, captured.warn.join(" | "));
});

Deno.test("executePrBranchUpdates - a PR closed between scan and push is a no-op too", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  const deps = makeExecDeps({
    logger: makeCapturingLogger(captured),
    getPrState: async () => "CLOSED",
  });

  const result = await executePrBranchUpdates([makeAction()], deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.mergedCount, 1);
  assertEquals(result.value.failedCount, 0);
  assertEquals(
    captured.info.some((m) => m.includes("closed") && m.includes("PR #381")),
    true,
    captured.info.join(" | "),
  );
});

Deno.test("executePrBranchUpdates - the lock is released when the PR merged mid-cycle", async () => {
  const released: number[] = [];
  const deps = makeExecDeps({
    workerId: "worker-a",
    getPrState: async () => "MERGED",
    acquireLock: async () => ({
      ok: true,
      value: { acquired: true, lockCommentId: 99 },
    }),
    releaseLock: async (options: { lockCommentId: number }) => {
      released.push(options.lockCommentId);
      return { ok: true, value: undefined };
    },
  });

  const result = await executePrBranchUpdates([makeAction()], deps);

  assertEquals(result.ok, true);
  assertEquals(released, [99]);
});

// =============================================================================
// Post-push classification — stale info against a since-merged PR
// =============================================================================

Deno.test("executePrBranchUpdates - a 'stale info' rejection on a since-merged PR is a no-op, not a failure", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  const states = ["OPEN", "MERGED"];
  const deps = makeExecDeps({
    logger: makeCapturingLogger(captured),
    getPrState: async () => states.shift() ?? "MERGED",
    performBranchUpdate: async () => ({ ok: false, error: STALE_INFO_ERROR }),
  });

  const result = await executePrBranchUpdates([makeAction()], deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.failedCount, 0, "nothing actually failed");
  assertEquals(result.value.mergedCount, 1);
  assertEquals(result.value.details[0]!.status, "merged");
  assertEquals(
    result.value.details[0]!.message.includes("stale info"),
    true,
    "the git rejection stays in the detail for traceability",
  );
  assertEquals(
    captured.info.some((m) =>
      m.includes("PR #381") && m.includes("in flight") &&
      m.includes("nothing to do")
    ),
    true,
    captured.info.join(" | "),
  );
  assertEquals(captured.warn.length, 0, captured.warn.join(" | "));
});

Deno.test("executePrBranchUpdates - a 'stale info' rejection on a still-open PR stays a loud failure", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  const deps = makeExecDeps({
    logger: makeCapturingLogger(captured),
    getPrState: async () => "OPEN",
    performBranchUpdate: async () => ({ ok: false, error: STALE_INFO_ERROR }),
  });

  const result = await executePrBranchUpdates([makeAction()], deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.failedCount, 1);
  assertEquals(result.value.mergedCount, 0);
  assertEquals(result.value.details[0]!.status, "failed");
  assertEquals(
    captured.warn.some((m) =>
      m.includes("PR #381") && m.includes("stale info")
    ),
    true,
    captured.warn.join(" | "),
  );
});

Deno.test("executePrBranchUpdates - without a state fetcher a push rejection is still counted as a failure", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  const deps = makeExecDeps({
    logger: makeCapturingLogger(captured),
    performBranchUpdate: async () => ({ ok: false, error: STALE_INFO_ERROR }),
  });

  const result = await executePrBranchUpdates([makeAction()], deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.failedCount, 1);
  assertEquals(result.value.mergedCount, 0);
});

Deno.test("executePrBranchUpdates - an unreachable state lookup warns and leaves the failure loud", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  const deps = makeExecDeps({
    logger: makeCapturingLogger(captured),
    getPrState: async () => {
      throw new Error("gh: API rate limit exceeded");
    },
    performBranchUpdate: async () => ({ ok: false, error: STALE_INFO_ERROR }),
  });

  const result = await executePrBranchUpdates([makeAction()], deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.failedCount,
    1,
    "an unknown state never excuses a failure",
  );
  assertEquals(result.value.mergedCount, 0);
  assertEquals(
    captured.warn.some((m) => m.includes("rate limit")),
    true,
    "the lookup failure is surfaced, not swallowed",
  );
});

// =============================================================================
// conflictCount has the same problem (Issue #386)
// =============================================================================

Deno.test("executePrBranchUpdates - a conflict reported for a since-merged PR is a no-op, not a conflict", async () => {
  resetPrConflictWarnings();
  const captured: CapturedLogs = { info: [], warn: [] };
  const states = ["OPEN", "MERGED"];
  const deps = makeExecDeps({
    logger: makeCapturingLogger(captured),
    getPrState: async () => states.shift() ?? "MERGED",
    performBranchUpdate: async () => ({
      ok: false,
      error: prBranchConflictError(
        "issue-364-fix-thing",
        "milestone/357-cleanup",
        "merge",
      ),
    }),
  });

  const result = await executePrBranchUpdates([makeAction()], deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.conflictCount, 0);
  assertEquals(result.value.mergedCount, 1);
  assertEquals(result.value.failedCount, 0);
  assertEquals(captured.warn.length, 0, captured.warn.join(" | "));
});

Deno.test("executePrBranchUpdates - a conflict on a still-open PR is still handed to the merge-conflict pass", async () => {
  resetPrConflictWarnings();
  const captured: CapturedLogs = { info: [], warn: [] };
  const deps = makeExecDeps({
    logger: makeCapturingLogger(captured),
    getPrState: async () => "OPEN",
    performBranchUpdate: async () => ({
      ok: false,
      error: prBranchConflictError(
        "issue-364-fix-thing",
        "milestone/357-cleanup",
        "merge",
      ),
    }),
  });

  const result = await executePrBranchUpdates([makeAction()], deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.conflictCount, 1);
  assertEquals(result.value.mergedCount, 0);
  assertEquals(result.value.details[0]!.status, "conflict");
  assertEquals(
    captured.warn.some((m) => m.includes("left untouched")),
    true,
    captured.warn.join(" | "),
  );
});

// =============================================================================
// A mid-cycle merge must not feed the failure streak (Issue #335 interaction)
// =============================================================================

Deno.test("executePrBranchUpdates - a mid-cycle merge does not count towards the failure streak", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pr-branch-386-" });
  try {
    const statePath = `${dir}/pr-branch-failures.json`;
    const ghCalls: string[][] = [];
    const states = ["OPEN", "MERGED"];
    const action = makeAction();
    const deps = makeExecDeps({
      getPrState: async () => states.shift() ?? "MERGED",
      performBranchUpdate: async () => ({ ok: false, error: STALE_INFO_ERROR }),
      failureStreak: {
        statePath,
        cycleId: "cycle-1",
        ghFn: async (args: string[]) => {
          ghCalls.push(args);
          return "";
        },
      },
    });

    const result = await executePrBranchUpdates([action], deps);

    assertEquals(result.ok, true);
    assertEquals(ghCalls.length, 0, "no escalation issue for a merged PR");
    const streaks = await loadPrBranchFailureStreaks(statePath);
    assertEquals(
      streaks[prBranchFailureKey(action.repo, action.branchName)],
      undefined,
      "a mid-cycle merge leaves no failure recorded",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
