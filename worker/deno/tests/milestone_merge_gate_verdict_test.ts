/**
 * The sync charges a merge-gate refusal only when the check judged the tree
 * (Issue #4847).
 *
 * A check that timed out, could not be run, could not read the tree or needed
 * a newer rustc did not reach a verdict on the merged tree. It is not charged,
 * is re-checked next cycle, and the refusal ceiling bounds the repeats. A check
 * that ran and rejected the tree is still charged (Issue #4304). The merge
 * fallback issue names the cause without a path.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  escalateRepeatedRefusal,
  isMergeGateRefusedReason,
  judgeSyncFailure,
  MERGE_GATE_REFUSED_TREE,
  MERGE_GATE_UNVERIFIED_TREE,
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  describeMergeGateCause,
  isMergeGateCause,
  type MergeGateCause,
  mergeGateFailureError,
} from "../lib/milestone_merge_gate.ts";
import {
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  MILESTONE_REFUSAL_CEILING,
  milestoneSyncStreakPath,
  saveSyncStreaks,
} from "../lib/milestone_sync_streak.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import {
  buildMergeFallbackBody,
  mergeFallbackCause,
  type MergeFallbackFiling,
  mergeFallbackTitle,
} from "../lib/merge_fallback_issue.ts";

const BRANCH = "milestone/4847-gate";

/** A merge-gate refusal, carrying the cause when one is given. */
function gateError(cause?: MergeGateCause): Error {
  return mergeGateFailureError(BRANCH, "main", {
    status: "failed",
    detail: "the merged tree was checked",
    output: "",
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** The causes the gate can name that mean the tree was not verified. */
const UNVERIFIED: ReadonlyArray<readonly [MergeGateCause, string]> = [
  ["check-timed-out", "the check timed out"],
  ["check-could-not-run", "the check could not be run"],
  ["tree-unreadable", "the tree could not be read"],
  ["rust-toolchain-too-old", "Rust toolchain too old"],
];

Deno.test("judgeSyncFailure - a check that rejected the tree is charged, with its cause (Issue #4847)", () => {
  assertEquals(judgeSyncFailure(gateError("tree-check-failed"), true), {
    outcome: "failed",
    reason: `${MERGE_GATE_REFUSED_TREE} (the repository's check failed)`,
  });
});

for (const [cause, phrase] of UNVERIFIED) {
  Deno.test(`judgeSyncFailure - ${cause} is not charged and is re-checked (Issue #4847)`, () => {
    assertEquals(judgeSyncFailure(gateError(cause), true), {
      outcome: "not-charged",
      reason: `${MERGE_GATE_UNVERIFIED_TREE} (${phrase})`,
      refusal: true,
    });
  });
}

Deno.test("judgeSyncFailure - a refusal with no cause keeps the bare refused-tree reason (Issue #4847)", () => {
  assertEquals(judgeSyncFailure(gateError(), true), {
    outcome: "failed",
    reason: MERGE_GATE_REFUSED_TREE,
  });
});

Deno.test("describeMergeGateCause - each cause has its fixed short phrase with no path or tool output (Issue #4847)", () => {
  assertEquals(
    describeMergeGateCause("tree-check-failed"),
    "the repository's check failed",
  );
  for (const [cause, phrase] of UNVERIFIED) {
    assertEquals(describeMergeGateCause(cause), phrase);
  }
  assert(isMergeGateCause("check-timed-out"));
  assertEquals(isMergeGateCause("check-timed-out "), false);
  assertEquals(isMergeGateCause(undefined), false);
});

Deno.test("escalateRepeatedRefusal - an unverified tree climbs at the ceiling, as a repeated resolution refusal does (Issue #4847)", () => {
  const unverified = judgeSyncFailure(gateError("check-timed-out"), true);
  const atCeiling = escalateRepeatedRefusal(unverified, 3);
  assertEquals(atCeiling.outcome, "failed");
  assertEquals(atCeiling.exhaust, true);
  assertStringIncludes(
    atCeiling.reason,
    `refused 3 cycles in a row (${MERGE_GATE_UNVERIFIED_TREE} (the check timed out))`,
  );
});

Deno.test("escalateRepeatedRefusal - below the ceiling an unverified tree is returned unchanged (Issue #4847)", () => {
  const unverified = judgeSyncFailure(gateError("check-timed-out"), true);
  assertEquals(escalateRepeatedRefusal(unverified, 2), unverified);
});

Deno.test("isMergeGateRefusedReason - accepts the bare and the cause-carrying refused-tree reason, and rejects the unverified one (Issue #4847)", () => {
  assert(isMergeGateRefusedReason(MERGE_GATE_REFUSED_TREE));
  assert(
    isMergeGateRefusedReason(
      `${MERGE_GATE_REFUSED_TREE} (the repository's check failed)`,
    ),
  );
  assertEquals(
    isMergeGateRefusedReason(
      `${MERGE_GATE_UNVERIFIED_TREE} (the check timed out)`,
    ),
    false,
  );
  assertEquals(
    isMergeGateRefusedReason("the merge gate refused the resolution"),
    false,
  );
});

Deno.test("mergeFallbackCause - an unverified tree names the cause without a path in the filed body (Issue #4847)", () => {
  const event: MergeFallbackFiling = {
    target: {
      kind: "milestone",
      repo: "acme/secret-trading",
      milestoneBranch: BRANCH,
      defaultBranch: "main",
    },
    conflictedFiles: [],
    runs: [{
      run: 1,
      host: "vibe-coder-6674",
      timings: [{ stage: "merge", seconds: 0 }],
      analysis:
        "Concluded `failed` at 2026-11-09T00:00:00.000Z: refused 3 cycles in " +
        "a row (the merge gate could not verify the merged tree (the check " +
        "timed out)) — climbing to the next rung",
    }],
    behindBy: 0,
    fallbackAction: "Nothing was reverted.",
  };
  assertEquals(
    mergeFallbackCause(event),
    "the merge gate could not verify the merged tree (the check timed out)",
  );
  assertEquals(
    mergeFallbackTitle(event),
    "Merge fallback: the merge gate could not verify the merged tree (the check timed out)",
  );
  const body = buildMergeFallbackBody(event, "private");
  for (
    const leak of ["acme", "secret-trading", BRANCH, "/home/", "worker/deno"]
  ) {
    assert(!body.includes(leak), `the body leaks ${leak}:\n${body}`);
  }
});

// ---------------------------------------------------------------------------
// One ledger cycle through the sync (Issue #4847)
// ---------------------------------------------------------------------------

const LEDGER_TITLE = "#4847 Gate";
const LEDGER_BRANCH = createMilestoneBranchName(LEDGER_TITLE);
const LEDGER_KEY = `owner/repo|${LEDGER_BRANCH}`;

/** Options for {@link gateDeps}. */
interface GateDepsOptions {
  streakPath: string;
  error: Error;
  logs: string[];
  /** Every gh argv the sweep ran, in order. */
  calls?: string[][];
  /** Wires the injected roll-back and records each request's key. */
  rollbacks?: string[];
}

/** Sync deps that fail the one milestone with `error`, recording the log. */
function gateDeps(options: GateDepsOptions): MilestoneBranchSyncDeps {
  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      options.calls?.push([...args]);
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(
          JSON.stringify([{ title: LEDGER_TITLE, number: 1 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("branches/milestone")) {
        return Promise.resolve(args[2]!.split("/").slice(-2).join("/"));
      }
      return Promise.resolve("[]");
    },
    syncBranchFn: () =>
      Promise.resolve({ ok: false as const, error: options.error }),
    defaultTipShaFn: () =>
      Promise.resolve({ ok: true as const, value: "a".repeat(40) }),
    log: (message: string) => {
      options.logs.push(message);
    },
    streakPath: options.streakPath,
    now: () => 10_000,
  };
  if (options.rollbacks) {
    const seen = options.rollbacks;
    deps.rollbackFn = (request) => {
      seen.push(
        `${request.repo}|${request.milestoneBranch}|${request.attempts}`,
      );
      return Promise.resolve(undefined);
    };
  }
  return deps;
}

Deno.test("syncMilestoneBranches - an unverified merge check is not charged to the ledger and is re-checked (Issue #4847)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4847-ledger-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const logs: string[] = [];
    await syncMilestoneBranches(
      gateDeps({ streakPath, error: gateError("check-timed-out"), logs }),
    );
    const entry = (await loadSyncStreaks(streakPath))[LEDGER_KEY];
    assertEquals(entry?.conflictAttempts ?? 0, 0);
    assertEquals(entry?.lastAttempt?.outcome, "not-charged");
    assertEquals(
      entry?.lastAttempt?.reason,
      `${MERGE_GATE_UNVERIFIED_TREE} (the check timed out)`,
    );
    assertEquals(entry?.refusedCycles, 1);
    assert(
      logs.some((line) => line.includes("not charged, re-checked next cycle")),
      `logs: ${JSON.stringify(logs)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a check that rejected the merged tree is charged to the ledger (Issue #4847)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4847-ledger-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const logs: string[] = [];
    await syncMilestoneBranches(
      gateDeps({ streakPath, error: gateError("tree-check-failed"), logs }),
    );
    const entry = (await loadSyncStreaks(streakPath))[LEDGER_KEY];
    assertEquals(entry?.conflictAttempts, 1);
    assertEquals(entry?.lastAttempt?.outcome, "failed");
    assertEquals(
      entry?.lastAttempt?.reason,
      `${MERGE_GATE_REFUSED_TREE} (the repository's check failed)`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a charged merge-gate refusal counts a resolver decline (Issue #4847)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4847-decline-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const logs: string[] = [];
    await syncMilestoneBranches(
      gateDeps({ streakPath, error: gateError("tree-check-failed"), logs }),
    );
    const entry = (await loadSyncStreaks(streakPath))[LEDGER_KEY];
    assertEquals(entry?.conflictAttempts, 1);
    assertEquals(entry?.resolverDeclines, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a merge-gate refusal with a cause closes after three budgets (Issue #4847)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4847-gate-close-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    await saveSyncStreaks(streakPath, {
      [LEDGER_KEY]: {
        count: 0,
        resolverDeclines: MILESTONE_CONFLICT_ATTEMPT_BUDGET * 3,
        escalated: false,
        lastAttempt: {
          at: new Date(1_000).toISOString(),
          outcome: "failed",
          reason: `${MERGE_GATE_REFUSED_TREE} (the repository's check failed)`,
        },
      },
    });
    const calls: string[][] = [];
    const logs: string[] = [];
    let syncs = 0;
    const deps = gateDeps({
      streakPath,
      error: gateError("tree-check-failed"),
      calls,
      logs,
    });
    const inner = deps.syncBranchFn;
    deps.syncBranchFn = (repo, branch, base, opts) => {
      syncs++;
      return inner(repo, branch, base, opts);
    };
    await syncMilestoneBranches(deps);
    assertEquals(syncs, 0, "a long-refused check failure is not merged again");
    const closed = calls.filter((args) =>
      args.includes("--method") && args.includes("PATCH") &&
      args.some((arg) => arg.includes("/milestones/")) &&
      args.includes("state=closed")
    );
    assertEquals(closed.length, 1, JSON.stringify(calls));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a merge-gate refusal with a cause that fills the budget hands off this cycle (Issue #4847)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4847-gate-handoff-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    await saveSyncStreaks(streakPath, {
      [LEDGER_KEY]: {
        count: 0,
        conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET - 1,
        escalated: false,
        lastAttempt: {
          at: new Date(1_000).toISOString(),
          outcome: "failed",
          reason: `${MERGE_GATE_REFUSED_TREE} (the repository's check failed)`,
        },
      },
    });
    const rollbacks: string[] = [];
    const logs: string[] = [];
    await syncMilestoneBranches(gateDeps({
      streakPath,
      error: gateError("tree-check-failed"),
      rollbacks,
      logs,
    }));
    assertEquals(rollbacks, [
      `owner/repo|${LEDGER_BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);
    const entry = (await loadSyncStreaks(streakPath))[LEDGER_KEY];
    assertEquals(entry?.conflictAttempts, MILESTONE_CONFLICT_ATTEMPT_BUDGET);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - an unverified tree at the refusal ceiling is charged and handed off (Issue #4847)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4847-ceiling-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    await saveSyncStreaks(streakPath, {
      [LEDGER_KEY]: {
        count: 0,
        refusedCycles: MILESTONE_REFUSAL_CEILING,
        escalated: false,
        lastAttempt: {
          at: new Date(1_000).toISOString(),
          outcome: "not-charged",
          reason: `${MERGE_GATE_UNVERIFIED_TREE} (the check timed out)`,
        },
      },
    });
    const rollbacks: string[] = [];
    const logs: string[] = [];
    await syncMilestoneBranches(gateDeps({
      streakPath,
      error: gateError("check-timed-out"),
      rollbacks,
      logs,
    }));
    const entry = (await loadSyncStreaks(streakPath))[LEDGER_KEY];
    assertEquals(entry?.conflictAttempts, MILESTONE_CONFLICT_ATTEMPT_BUDGET);
    assertEquals(entry?.lastAttempt?.outcome, "failed");
    assertStringIncludes(
      entry?.lastAttempt?.reason ?? "",
      "refused 3 cycles in a row",
    );
    assertEquals(rollbacks, [
      `owner/repo|${LEDGER_BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);
    assert(
      logs.some((line) =>
        line.includes(
          "the merge gate could not verify the merged tree for 3 cycles in a row",
        )
      ),
      `logs: ${JSON.stringify(logs)}`,
    );
    assert(
      !logs.some((line) => line.includes("not charged, re-checked next cycle")),
      `the ceiling cycle must not log the below-ceiling wording: ${
        JSON.stringify(logs)
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
