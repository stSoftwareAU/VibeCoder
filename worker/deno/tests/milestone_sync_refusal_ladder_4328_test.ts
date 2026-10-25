/**
 * The refusal ladder (Issue #4328).
 *
 * A milestone branch refused a conflict resolution — the agent was not
 * offered the cycle, or the merge gate refused the resolution — concluded
 * `not-charged`, so it never spent the conflict budget and was retried for
 * ever. The ladder is now resolve → roll back → rebuild:
 *
 * - a refusal repeated {@link MILESTONE_REFUSAL_CEILING} cycles in a row
 *   climbs to the roll-back on the next cycle, in both the sweep and the
 *   pre-cut sync;
 * - a budget spent by another path is handed off, not only skipped;
 * - a branch whose roll-back is already spent is rebuilt before it is rolled
 *   back again.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  escalateRepeatedRefusal,
  judgeSyncFailure,
  type MilestoneBranchSyncDeps,
  type MilestoneRebuildFn,
  type RollbackGitFn,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import type { MilestoneRebuilt } from "../lib/conflict_milestone_rebuild.ts";
import {
  type MilestonePresyncDeps,
  presyncMilestoneBranch,
} from "../lib/milestone_presync.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import {
  AGENT_PROVIDER_UNAVAILABLE,
  AGENT_RUN_ENDED_BY_WORKER,
} from "../lib/milestone_conflict_ladder.ts";
import {
  mergeGateFailureError,
  type MergeGateFn,
} from "../lib/milestone_merge_gate.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import type { RollbackOutcome } from "../lib/milestone_rollback.ts";
import {
  concludeConflictAttempt,
  isConflictBudgetExhausted,
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  MILESTONE_REFUSAL_CEILING,
  milestoneSyncStreakPath,
  resetConflictLedgerOnSuccess,
  saveSyncStreaks,
  type SyncStreakEntry,
  syncStreakKey,
} from "../lib/milestone_sync_streak.ts";

const REPO = "owner/repo";
const TITLE = "#4328 Refusal Ladder";
const BRANCH = createMilestoneBranchName(TITLE);
const KEY = syncStreakKey(REPO, BRANCH);
const DEFAULT_BRANCH = "main";
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
/**
 * A cycle with five minutes of deadline left: the pass still runs, but after
 * the conflict overhead less than one agent run remains, so the agent rung is
 * not offered (Issue #2309).
 */
const SHORT_CYCLE_MS = 5 * 60 * 1000;
const MILESTONE_SHA = "c".repeat(40);
const FLAG_ISSUE = 4242;

/** A distinct, hex default-branch tip per cycle, so the cadence guard runs it. */
const tip = (cycle: number): string => String(cycle).padStart(40, "e");

function fileAnalysis(reason: string) {
  return {
    path: "worker/deno/lib/scan_content.ts",
    reason,
    oursExports: ["a"],
    theirsExports: ["b"],
    oursTests: [],
    theirsTests: [],
    onlyOursTests: [],
    onlyTheirsTests: [],
  };
}

/** The conflict an agent-not-offered cycle reports (Issue #2309). */
function agentDeferredError(): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "every rung left it undecided",
    [fileAnalysis("agent: it left 1 path(s) unmerged: lib/scan.ts")],
    [],
    tip(0),
    undefined,
    MILESTONE_SHA,
  );
}

/** The conflict a merge gate refused the resolution of (Issue #1559). */
function gateRefusedError(): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "every rung left it undecided",
    [fileAnalysis("agent: it left 1 path(s) unmerged: lib/scan.ts")],
    [],
    tip(0),
    "TS2304: Cannot find name 'scan'",
    MILESTONE_SHA,
  );
}

function refusalError(kind: "agent" | "gate"): MilestoneConflictEscalation {
  return kind === "gate" ? gateRefusedError() : agentDeferredError();
}

/** What the stubbed gh answers; anything unlisted is an empty list. */
function ghAnswer(args: string[]): string {
  const key = args.join(" ");
  if (key.includes(`repos/${REPO}/milestones`)) {
    return JSON.stringify([{ title: TITLE, number: 1 }]);
  }
  if (key.includes("default_branch")) return DEFAULT_BRANCH;
  if (key.includes("branches/milestone")) {
    return args[2]!.split("/").slice(-2).join("/");
  }
  if (key.startsWith("issue view") && key.includes("--json")) {
    return JSON.stringify({ state: "CLOSED", labels: [{ name: "idle-task" }] });
  }
  if (key.startsWith("issue view")) return "OPEN";
  if (key.startsWith("issue create")) {
    return `https://github.com/${REPO}/issues/${FLAG_ISSUE}\n`;
  }
  return "[]";
}

interface SweepOptions {
  streakPath: string;
  defaultSha: string;
  /** The error every sync of the branch returns. */
  syncError: () => Error;
  /** Every branch a sync was started for, in order. */
  syncCalls: string[];
  /** Wires the injected roll-back and records each request's key. */
  rollbacks?: string[];
  rollbackOutcome?: RollbackOutcome;
  /** Wires the injected rebuild and records each branch it is run for. */
  rebuilds?: string[];
  rebuildOutcome?: MilestoneRebuilt | {
    outcome: "failed";
    step: "milestone-rebuild";
    message: string;
  };
  /** Injected git for the default roll-back and rebuild (Issue #1781). */
  rollbackGitFn?: RollbackGitFn;
  /** Self-heal actions emitted, in order. */
  emitted?: string[];
  /** Every gh argv the sweep ran. */
  calls?: string[][];
  deadlineMs?: number;
}

/** A one-milestone sweep whose sync always fails with `syncError`. */
function sweepDeps(options: SweepOptions): MilestoneBranchSyncDeps {
  const deps: MilestoneBranchSyncDeps = {
    repos: [REPO],
    ghCommandFn: (args: string[]): Promise<string> => {
      options.calls?.push([...args]);
      return Promise.resolve(ghAnswer(args));
    },
    syncBranchFn: (_repo, branch) => {
      options.syncCalls.push(branch);
      return Promise.resolve({
        ok: false as const,
        error: options.syncError(),
      });
    },
    defaultTipShaFn: () =>
      Promise.resolve({ ok: true as const, value: options.defaultSha }),
    now: () => NOW,
    deadlineEpochMs: NOW + (options.deadlineMs ?? SHORT_CYCLE_MS),
    streakPath: options.streakPath,
    log: () => undefined,
  };
  if (options.rollbacks) {
    const seen = options.rollbacks;
    const outcome = options.rollbackOutcome;
    deps.rollbackFn = (request) => {
      seen.push(
        `${request.repo}|${request.milestoneBranch}|${request.attempts}`,
      );
      return Promise.resolve(outcome);
    };
  }
  if (options.rebuilds) {
    const seen = options.rebuilds;
    const outcome = options.rebuildOutcome;
    const rebuildFn: MilestoneRebuildFn = (request) => {
      seen.push(`${request.repo}|${request.milestoneBranch}`);
      return Promise.resolve(outcome);
    };
    deps.rebuildFn = rebuildFn;
  }
  if (options.rollbackGitFn) deps.rollbackGitFn = options.rollbackGitFn;
  if (options.emitted) {
    const seen = options.emitted;
    deps.emitSelfHealEvent = (event) => {
      seen.push(event.action);
      return Promise.resolve(true);
    };
  }
  return deps;
}

/** A ledger file in a fresh work directory, removed by the caller. */
async function workDir(): Promise<{ dir: string; streakPath: string }> {
  const dir = await Deno.makeTempDir({ prefix: "issue-4328-ladder-" });
  return { dir, streakPath: milestoneSyncStreakPath(dir) };
}

async function readEntry(
  streakPath: string,
): Promise<SyncStreakEntry | undefined> {
  return (await loadSyncStreaks(streakPath))[KEY];
}

const spentLedger = (
  extra: Partial<SyncStreakEntry> = {},
): SyncStreakEntry => ({
  count: 3,
  escalated: false,
  conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. judgeSyncFailure: which conclusions are refusals
// ---------------------------------------------------------------------------

Deno.test("judgeSyncFailure - an agent-deferred conflict is a refusal, not charged (Issue #4328)", () => {
  const verdict = judgeSyncFailure(agentDeferredError(), false);
  assertEquals(verdict.outcome, "not-charged");
  assertEquals(verdict.reason, "agent deferred: cycle budget");
  assertEquals(verdict.refusal, true);
  assertEquals(verdict.exhaust, undefined);
});

Deno.test("judgeSyncFailure - a gate-refused resolution is a refusal, not charged (Issue #4328)", () => {
  const verdict = judgeSyncFailure(gateRefusedError(), true);
  assertEquals(verdict.outcome, "not-charged");
  assertEquals(verdict.refusal, true);
});

Deno.test("judgeSyncFailure - a disrupted, worker-ended or provider-refused run is not a refusal (Issue #4328)", () => {
  const providerRefused = new MilestoneConflictEscalation(
    "every rung left it undecided",
    [fileAnalysis(`agent: ${AGENT_PROVIDER_UNAVAILABLE}`)],
    [],
    tip(0),
  );
  const workerEnded = new MilestoneConflictEscalation(
    "every rung left it undecided",
    [fileAnalysis(`agent: ${AGENT_RUN_ENDED_BY_WORKER}`)],
    [],
    tip(0),
  );
  for (const error of [providerRefused, workerEnded]) {
    const verdict = judgeSyncFailure(error, true);
    assertEquals(verdict.outcome, "disrupted");
    assertEquals(verdict.refusal, undefined);
  }
});

Deno.test("judgeSyncFailure - a ruleset push rejection and a non-conflict git failure are not refusals (Issue #4328)", () => {
  const ruleset = judgeSyncFailure(
    new Error(
      "! [remote rejected] main -> main (protected branch hook declined)\n" +
        "GH006: Protected branch update failed",
    ),
    true,
  );
  assertEquals(ruleset.outcome, "not-charged");
  assertEquals(ruleset.refusal, undefined);

  const plain = judgeSyncFailure(
    new Error("refusing to merge unrelated histories"),
    true,
  );
  assertEquals(plain.outcome, "not-charged");
  assertEquals(plain.refusal, undefined);
});

Deno.test("judgeSyncFailure - the merge-gate failure is charged and is not a refusal (Issue #4328)", () => {
  const verdict = judgeSyncFailure(
    mergeGateFailureError(BRANCH, DEFAULT_BRANCH, {
      status: "failed",
      detail: "the merged tree does not type-check",
      output: "TS2304",
    }),
    true,
  );
  assertEquals(verdict.outcome, "failed");
  assertEquals(verdict.refusal, undefined);
});

// ---------------------------------------------------------------------------
// 2. escalateRepeatedRefusal: the ceiling
// ---------------------------------------------------------------------------

Deno.test("escalateRepeatedRefusal - a refusal below the ceiling is unchanged (Issue #4328)", () => {
  const verdict = judgeSyncFailure(agentDeferredError(), false);
  assertEquals(
    escalateRepeatedRefusal(verdict, MILESTONE_REFUSAL_CEILING - 1),
    verdict,
  );
});

Deno.test("escalateRepeatedRefusal - a refusal at the ceiling climbs to the roll-back (Issue #4328)", () => {
  const verdict = judgeSyncFailure(agentDeferredError(), false);
  const climbed = escalateRepeatedRefusal(verdict, MILESTONE_REFUSAL_CEILING);
  assertEquals(climbed.outcome, "failed");
  assertEquals(climbed.exhaust, true);
  assertEquals(climbed.rung, verdict.rung);
  assertStringIncludes(
    climbed.reason,
    `refused ${MILESTONE_REFUSAL_CEILING} cycles in a row (agent deferred`,
  );
  assertStringIncludes(climbed.reason, "climbing to the next rung");
});

Deno.test("escalateRepeatedRefusal - a verdict that is not a refusal never escalates (Issue #4328)", () => {
  const charged = judgeSyncFailure(
    mergeGateFailureError(BRANCH, DEFAULT_BRANCH, {
      status: "failed",
      detail: "x",
      output: "",
    }),
    true,
  );
  const nonConflict = judgeSyncFailure(new Error("unrelated histories"), true);
  for (const verdict of [charged, nonConflict]) {
    assertEquals(escalateRepeatedRefusal(verdict, 1_000_000), verdict);
  }
});

// ---------------------------------------------------------------------------
// 3. The sweep: a refused branch reaches the roll-back on cycle N+1
// ---------------------------------------------------------------------------

for (const kind of ["agent", "gate"] as const) {
  const label = kind === "agent"
    ? "an agent-deferred refusal"
    : "a gate-refused resolution";
  Deno.test(`syncMilestoneBranches - ${label} climbs to the roll-back on cycle N+1 (Issue #4328)`, async () => {
    const { dir, streakPath } = await workDir();
    try {
      const syncCalls: string[] = [];
      const rollbacks: string[] = [];
      for (let cycle = 1; cycle <= MILESTONE_REFUSAL_CEILING; cycle++) {
        await syncMilestoneBranches(sweepDeps({
          streakPath,
          defaultSha: tip(cycle),
          syncError: () => refusalError(kind),
          syncCalls,
          rollbacks,
        }));
        assertEquals(
          rollbacks,
          [],
          `cycle ${cycle} is a refusal and must not roll back`,
        );
        assertEquals((await readEntry(streakPath))?.refusedCycles, cycle);
      }
      // Positive control: the refused cycles really ran the sync.
      assertEquals(syncCalls.length, MILESTONE_REFUSAL_CEILING);

      await syncMilestoneBranches(sweepDeps({
        streakPath,
        defaultSha: tip(MILESTONE_REFUSAL_CEILING + 1),
        syncError: () => refusalError(kind),
        syncCalls,
        rollbacks,
      }));
      assertEquals(syncCalls.length, MILESTONE_REFUSAL_CEILING + 1);
      assertEquals(rollbacks, [
        `${REPO}|${BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
      ]);
      const entry = await readEntry(streakPath);
      assert(entry);
      assertEquals(
        entry.refusedCycles ?? 0,
        0,
        "a charged climb ends the streak",
      );
      assertEquals(entry.conflictAttempts, MILESTONE_CONFLICT_ATTEMPT_BUDGET);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

// ---------------------------------------------------------------------------
// 4. The pre-cut sync twin (milestone_presync.ts)
// ---------------------------------------------------------------------------

Deno.test("presyncMilestoneBranch - refusal N+1 leaves the ledger exhausted (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    const presyncDeps = (): MilestonePresyncDeps => ({
      countBehind: () => Promise.resolve({ ok: true as const, value: 4 }),
      defaultTipSha: () =>
        Promise.resolve({ ok: true as const, value: tip(1) }),
      milestoneTipSha: () =>
        Promise.resolve({ ok: true as const, value: MILESTONE_SHA }),
      syncBranch: () =>
        Promise.resolve({ ok: false as const, error: agentDeferredError() }),
      log: () => undefined,
    });
    const args = {
      repo: REPO,
      milestoneBranch: BRANCH,
      defaultBranch: DEFAULT_BRANCH,
      streakPath,
      grant: { agentAllowed: false },
      nowMs: NOW,
    };
    for (let refusal = 1; refusal <= MILESTONE_REFUSAL_CEILING; refusal++) {
      await presyncMilestoneBranch(args, presyncDeps());
      const entry = await readEntry(streakPath);
      assert(entry);
      assertEquals(entry.refusedCycles, refusal);
      assertEquals(
        isConflictBudgetExhausted(entry),
        false,
        `refusal ${refusal} is not yet a spent budget`,
      );
    }
    await presyncMilestoneBranch(args, presyncDeps());
    const entry = await readEntry(streakPath);
    assert(entry);
    assertEquals(isConflictBudgetExhausted(entry), true);
    assertEquals(entry.lastAttempt?.outcome, "failed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 5. A budget spent by another path is handed off, not only skipped
// ---------------------------------------------------------------------------

Deno.test("syncMilestoneBranches - a budget spent elsewhere is handed to the roll-back once (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, { [KEY]: spentLedger() });
    const syncCalls: string[] = [];
    const rollbacks: string[] = [];
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => refusalError("agent"),
      syncCalls,
      rollbacks,
    }));
    assertEquals(syncCalls, [], "a spent budget is not merged again");
    assertEquals(rollbacks, [
      `${REPO}|${BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a spent budget whose roll-back could not merge still only skips (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    // The default tip is unchanged since that roll-back, so it is still
    // waiting for the default branch to move (Issue #2311).
    await saveSyncStreaks(streakPath, {
      [KEY]: spentLedger({ fallbackDefaultSha: tip(1) }),
    });
    const syncCalls: string[] = [];
    const rollbacks: string[] = [];
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => refusalError("agent"),
      syncCalls,
      rollbacks,
    }));
    assertEquals(syncCalls, []);
    assertEquals(rollbacks, [], "negative control: no hand-off while it waits");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 6. The rebuild rung and the roll-back's failure count
// ---------------------------------------------------------------------------

const REBUILT: MilestoneRebuilt = {
  outcome: "milestone-rebuilt",
  milestoneBranch: BRANCH,
  baseBranch: DEFAULT_BRANCH,
  baseSha: "a".repeat(40),
  rebuildSha: "b".repeat(40),
  replayed: [],
  skipped: [],
  requeued: [],
  delivery: { kind: "pushed" },
};

Deno.test("syncMilestoneBranches - a spent roll-back is followed by a rebuild, which resets the ledger (Issue #4328)", async () => {
  for (const spent of [{ rollbacks: 1 }, { rollbackFailures: 1 }]) {
    const { dir, streakPath } = await workDir();
    try {
      await saveSyncStreaks(streakPath, { [KEY]: spentLedger(spent) });
      const rebuilds: string[] = [];
      const rollbacks: string[] = [];
      const emitted: string[] = [];
      await syncMilestoneBranches(sweepDeps({
        streakPath,
        defaultSha: tip(1),
        syncError: () => refusalError("agent"),
        syncCalls: [],
        rollbacks,
        rebuilds,
        rebuildOutcome: REBUILT,
        emitted,
      }));
      assertEquals(rebuilds, [`${REPO}|${BRANCH}`], JSON.stringify(spent));
      assertEquals(rollbacks, [], "a rebuilt branch is not rolled back again");
      assertEquals(emitted, ["rebuilt"]);
      const entry = await readEntry(streakPath);
      assert(entry);
      assertEquals(entry.conflictAttempts, 0);
      assertEquals(entry.rebuilds, 1);
      assertEquals(entry.rollbacks ?? 0, spent.rollbacks ?? 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("syncMilestoneBranches - with no roll-back spent the roll-back runs first, not the rebuild (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, { [KEY]: spentLedger() });
    const rebuilds: string[] = [];
    const rollbacks: string[] = [];
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => refusalError("agent"),
      syncCalls: [],
      rollbacks,
      rebuilds,
      rebuildOutcome: REBUILT,
    }));
    assertEquals(rebuilds, []);
    assertEquals(rollbacks, [
      `${REPO}|${BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a failed rebuild falls through to the roll-back (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, { [KEY]: spentLedger({ rollbacks: 1 }) });
    const rebuilds: string[] = [];
    const rollbacks: string[] = [];
    const emitted: string[] = [];
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => refusalError("agent"),
      syncCalls: [],
      rollbacks,
      rebuilds,
      rebuildOutcome: {
        outcome: "failed",
        step: "milestone-rebuild",
        message: "could not fetch 'milestone/4328-refusal-ladder'",
      },
      emitted,
    }));
    assertEquals(rebuilds.length, 1);
    assertEquals(rollbacks, [
      `${REPO}|${BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);
    assertEquals(emitted, ["rebuild_failed"]);
    assertEquals((await readEntry(streakPath))?.rebuilds, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a roll-back that cannot merge is counted in rollbackFailures (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, { [KEY]: spentLedger() });
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => refusalError("agent"),
      syncCalls: [],
      rollbacks: [],
      rollbackOutcome: {
        merged: false,
        reverted: [],
        reason: "a child would not revert",
      },
    }));
    const entry = await readEntry(streakPath);
    assert(entry);
    assertEquals(entry.rollbackFailures, 1);
    assertEquals(entry.rollbacks, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 8. prepareRollbackWorktree: a leftover index is reset and the checkout retried
// ---------------------------------------------------------------------------

const INDEX_STDERR = "error: you need to resolve your current index first";

/** Git whose first `failures` checkouts refuse with the leftover-index error. */
function rollbackGit(failures: number) {
  const calls: string[][] = [];
  let checkouts = 0;
  const gitFn: RollbackGitFn = (_repo, args) => {
    calls.push([...args]);
    if (args[0] === "checkout") {
      checkouts++;
      return Promise.resolve(
        checkouts <= failures
          ? { code: 1, stdout: "", stderr: INDEX_STDERR }
          : { code: 0, stdout: "", stderr: "" },
      );
    }
    if (args[0] === "merge") {
      return Promise.resolve({
        code: 128,
        stdout: "",
        stderr: "fatal: There is no merge to abort",
      });
    }
    if (args[0] === "reset") {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "stub: not expected",
    });
  };
  return { gitFn, calls };
}

Deno.test("prepareRollbackWorktree - a leftover index is reset with reset --hard HEAD and the checkout retried (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, { [KEY]: spentLedger() });
    const git = rollbackGit(1);
    const ghCalls: string[][] = [];
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => refusalError("agent"),
      syncCalls: [],
      rollbackGitFn: git.gitFn,
      calls: ghCalls,
    }));
    const checkouts = git.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c[0] === "checkout" && c[1] === "-B");
    assertEquals(checkouts.length, 2, "the checkout is retried once");
    const reset = git.calls.findIndex((c) =>
      c.join(" ") === "reset --hard HEAD"
    );
    assert(reset > checkouts[0]!.i && reset < checkouts[1]!.i);
    // No clean: nothing untracked is touched.
    assertEquals(git.calls.some((c) => c[0] === "clean"), false);
    // The retried checkout succeeded, so no notice names the checkout as the
    // reason the roll-back stopped.
    const notices = ghCalls
      .filter((c) => c[0] === "issue" && c[1] === "comment")
      .map((c) => String(c[c.indexOf("--body") + 1] ?? ""));
    assertEquals(
      notices.some((body) => body.includes("Could not check out")),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prepareRollbackWorktree - a checkout still refused after the reset reports the cause (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, { [KEY]: spentLedger() });
    const git = rollbackGit(2);
    const ghCalls: string[][] = [];
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => refusalError("agent"),
      syncCalls: [],
      rollbackGitFn: git.gitFn,
      calls: ghCalls,
    }));
    assertEquals(
      git.calls.filter((c) => c[0] === "checkout" && c[1] === "-B").length,
      2,
    );
    const entry = await readEntry(streakPath);
    assert(entry);
    assertEquals(entry.rollbackFailures, 1, "merged:false is counted");
    // The roll-back's notice carries the reason, which names the cause.
    const notices = ghCalls
      .filter((c) => c[0] === "issue" && c[1] === "comment")
      .map((c) => String(c[c.indexOf("--body") + 1] ?? ""));
    assert(
      notices.some((body) => body.includes(INDEX_STDERR)),
      `no notice names the cause in: ${JSON.stringify(notices)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 9. The ledger: old files read as zero, new fields survive a round trip
// ---------------------------------------------------------------------------

Deno.test("loadSyncStreaks - an entry written before #4328 reads its refusal fields as zero (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    // The shape an older worker wrote: no refusal, rollback-failure or rebuild
    // fields at all.
    await Deno.writeTextFile(
      streakPath,
      JSON.stringify({
        [KEY]: {
          count: 2,
          escalated: false,
          conflictAttempts: 1,
          rollbacks: 1,
          lastAttempt: {
            at: "2026-10-01T00:00:00.000Z",
            outcome: "failed",
            reason: "conflict unresolved at rung agent",
          },
        },
      }),
    );
    const entry = await readEntry(streakPath);
    assert(entry);
    assertEquals(entry.refusedCycles, undefined);
    assertEquals(entry.rollbackFailures, undefined);
    assertEquals(entry.rebuilds, undefined);
    assertEquals(entry.refusedCycles ?? 0, 0);
    assertEquals(entry.conflictAttempts, 1);
    assertEquals(entry.rollbacks, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadSyncStreaks - the refusal, rollback-failure and rebuild counts survive a save (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, {
      [KEY]: {
        count: 1,
        escalated: false,
        refusedCycles: 2,
        rollbackFailures: 1,
        rebuilds: 3,
      },
    });
    const entry = await readEntry(streakPath);
    assertEquals(entry?.refusedCycles, 2);
    assertEquals(entry?.rollbackFailures, 1);
    assertEquals(entry?.rebuilds, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - an old-shape ledger counts its first refusal from zero (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await Deno.writeTextFile(
      streakPath,
      JSON.stringify({ [KEY]: { count: 0, escalated: false } }),
    );
    const rollbacks: string[] = [];
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => refusalError("agent"),
      syncCalls: [],
      rollbacks,
    }));
    assertEquals(rollbacks, []);
    assertEquals((await readEntry(streakPath))?.refusedCycles, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The conclusion's own rules (concludeConflictAttempt, resetConflictLedgerOnSuccess)
// ---------------------------------------------------------------------------

Deno.test("concludeConflictAttempt - a refusal adds one, a charged failure zeroes, other conclusions keep it (Issue #4328)", () => {
  const base: SyncStreakEntry = {
    count: 0,
    escalated: false,
    refusedCycles: 2,
  };
  const refused = concludeConflictAttempt(
    base,
    "not-charged",
    "agent deferred: cycle budget",
    undefined,
    NOW,
    { refusal: true },
  );
  assertEquals(refused.refusedCycles, 3);
  assertEquals(refused.conflictAttempts ?? 0, 0);

  const disrupted = concludeConflictAttempt(
    base,
    "disrupted",
    "x",
    undefined,
    NOW,
    {
      refusal: true,
    },
  );
  assertEquals(disrupted.refusedCycles, 2, "only a not-charged refusal counts");

  const notRefusal = concludeConflictAttempt(
    base,
    "not-charged",
    "non-conflict",
    undefined,
    NOW,
  );
  assertEquals(notRefusal.refusedCycles, 2);

  const charged = concludeConflictAttempt(
    base,
    "failed",
    "conflict",
    undefined,
    NOW,
  );
  assertEquals(charged.refusedCycles, 0);
  assertEquals(charged.conflictAttempts, 1);
});

Deno.test("concludeConflictAttempt - an exhausting verdict lifts the budget to its full size (Issue #4328)", () => {
  const lifted = concludeConflictAttempt(
    { count: 0, escalated: false },
    "failed",
    "refused 3 cycles in a row",
    undefined,
    NOW,
    { refusal: false, exhaust: true },
  );
  assertEquals(lifted.conflictAttempts, MILESTONE_CONFLICT_ATTEMPT_BUDGET);
  assert(isConflictBudgetExhausted(lifted));
});

Deno.test("resetConflictLedgerOnSuccess - a landed sync drops the refusal streak (Issue #4328)", () => {
  const reset = resetConflictLedgerOnSuccess({
    count: 0,
    escalated: false,
    conflictAttempts: 2,
    refusedCycles: 2,
  });
  assertEquals(reset.refusedCycles, undefined);
  assertEquals(reset.conflictAttempts, 0);
});

// ---------------------------------------------------------------------------
// 10. The open-head-PR climb (Issue #4328)
// ---------------------------------------------------------------------------

const HEAD_PR_NUMBER = 55;

/** A sweep with an open milestone PR whose shared tally is empty. */
function withOpenHeadPr(
  deps: MilestoneBranchSyncDeps,
): MilestoneBranchSyncDeps {
  const base = deps.ghCommandFn!;
  deps.ghCommandFn = (args) => {
    const key = args.join(" ");
    if (key.startsWith("pr list") && key.includes("--head")) {
      return Promise.resolve(
        JSON.stringify([{
          number: HEAD_PR_NUMBER,
          headRefOid: "f".repeat(40),
        }]),
      );
    }
    return base(args);
  };
  return deps;
}

Deno.test("syncMilestoneBranches - a refusal climbs to the roll-back on a branch with an open head PR (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    const syncCalls: string[] = [];
    const rollbacks: string[] = [];
    for (let cycle = 1; cycle <= MILESTONE_REFUSAL_CEILING + 1; cycle++) {
      await syncMilestoneBranches(withOpenHeadPr(sweepDeps({
        streakPath,
        defaultSha: tip(cycle),
        syncError: () => refusalError("agent"),
        syncCalls,
        rollbacks,
      })));
      // Positive control: the PR's own tally (empty) never spends the budget,
      // so only the refusal ceiling can end the streak.
      assertEquals(syncCalls.length, cycle, `cycle ${cycle} ran the sync`);
      assertEquals(
        rollbacks.length,
        cycle > MILESTONE_REFUSAL_CEILING ? 1 : 0,
        `cycle ${cycle}`,
      );
    }
    assertEquals(rollbacks, [`${REPO}|${BRANCH}|1`]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 11. The default rebuild, wired in production (Issue #4328)
// ---------------------------------------------------------------------------

const SUB_PR_SHA = "d".repeat(40);
const MERGED_SUB_PRS = JSON.stringify([{
  number: 7,
  headRefName: "issue-7-sub",
  body: "",
  mergedAt: "2026-10-01T00:00:00Z",
  mergeCommit: { oid: SUB_PR_SHA },
}]);

const PASSING_GATE: MergeGateFn = () =>
  Promise.resolve({ status: "passed", detail: "gate passed", output: "" });

/** Git whose every call succeeds; `checkout -B` can be made to refuse. */
function rebuildGit(refuseCheckout?: string) {
  const calls: string[][] = [];
  const gitFn: RollbackGitFn = (_repo, args) => {
    calls.push([...args]);
    const ok = (stdout = "") =>
      Promise.resolve({ code: 0, stdout, stderr: "" });
    if (args[0] === "checkout" && args[1] === "-B" && refuseCheckout) {
      return Promise.resolve({ code: 1, stdout: "", stderr: refuseCheckout });
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return ok("a".repeat(40));
    }
    if (args[0] === "rev-parse") return ok("b".repeat(40));
    if (args[0] === "rev-list") return ok(SUB_PR_SHA);
    return ok();
  };
  return { gitFn, calls };
}

interface DefaultRebuildRun {
  ghCalls: string[][];
  logs: string[];
  rollbacks: string[];
  entry: SyncStreakEntry | undefined;
}

/**
 * One sweep over a branch whose roll-back is already spent, with no
 * `rebuildFn` injected, so the production default runs.
 */
async function runDefaultRebuild(options: {
  title?: string;
  gitFn?: RollbackGitFn;
  /** Ledger fields beyond the one spent roll-back. */
  ledger?: Partial<SyncStreakEntry>;
  /** The error every sync returns; a refusal by default. */
  syncError?: () => Error;
  /** The merged sub-PR listing gh answers. */
  merged?: string;
  /** The merge gate; passes by default, and `null` leaves it unwired. */
  gate?: MergeGateFn | null;
  /** Answers a gh call before the stub's own answer; may throw. */
  answer?: (args: string[]) => string | undefined;
}): Promise<DefaultRebuildRun> {
  const title = options.title ?? TITLE;
  const key = syncStreakKey(REPO, createMilestoneBranchName(title));
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, {
      [key]: spentLedger({ rollbacks: 1, ...options.ledger }),
    });
    const ghCalls: string[][] = [];
    const rollbacks: string[] = [];
    const logs: string[] = [];
    const deps = sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: options.syncError ?? (() => refusalError("agent")),
      syncCalls: [],
      rollbacks,
      ...(options.gitFn ? { rollbackGitFn: options.gitFn } : {}),
    });
    if (options.gate !== null) {
      deps.rebuildGateFn = options.gate ?? PASSING_GATE;
    }
    const base = deps.ghCommandFn!;
    deps.ghCommandFn = (args) => {
      ghCalls.push([...args]);
      const key = args.join(" ");
      if (key.includes(`repos/${REPO}/milestones`)) {
        return Promise.resolve(JSON.stringify([{ title, number: 1 }]));
      }
      if (key.startsWith("pr list") && key.includes("--state merged")) {
        return Promise.resolve(options.merged ?? MERGED_SUB_PRS);
      }
      const answered = options.answer?.(args);
      return answered !== undefined ? Promise.resolve(answered) : base(args);
    };
    deps.log = (message) => logs.push(message);
    await syncMilestoneBranches(deps);
    return {
      ghCalls,
      logs,
      rollbacks,
      entry: (await loadSyncStreaks(streakPath))[key],
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const issueComments = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === "issue" && c[1] === "comment");

Deno.test("syncMilestoneBranches - the default rebuild runs in the clone and announces on the escalation target (Issue #4328)", async () => {
  const git = rebuildGit();
  const run = await runDefaultRebuild({ gitFn: git.gitFn });
  assert(
    git.calls.some((c) =>
      c.join(" ") === `checkout -B ${BRANCH} origin/${BRANCH}`
    ),
    "the clone is prepared on the milestone branch first",
  );
  assertEquals(run.entry?.rebuilds, 1);
  assertEquals(run.rollbacks, [], "a rebuilt branch is not rolled back");
  const comments = issueComments(run.ghCalls);
  assertEquals(comments.length, 1);
  const comment = comments[0]!;
  assertEquals(comment.slice(0, 5), [
    "issue",
    "comment",
    "4328",
    "--repo",
    REPO,
  ]);
  assertEquals(comment[5], "--body");
  assertStringIncludes(comment[6]!, BRANCH);
  assertEquals(
    run.ghCalls.some((c) => c[0] === "pr" && c[1] === "comment"),
    false,
    "the notice is not posted on a milestone PR",
  );
});

Deno.test("syncMilestoneBranches - the default rebuild finds a tracker-less milestone's oldest child by its number (Issue #4328)", async () => {
  const title = "Refusal Ladder Plain";
  const run = await runDefaultRebuild({
    title,
    gitFn: rebuildGit().gitFn,
    answer: (args) =>
      args.join(" ").includes("issues?milestone=1")
        ? JSON.stringify([
          { number: 12, title: "later", body: "" },
          { number: 9, title: "oldest", body: "" },
        ])
        : undefined,
  });
  assertEquals(run.entry?.rebuilds, 1);
  const comments = issueComments(run.ghCalls);
  assertEquals(comments.length, 1);
  assertEquals(comments[0]![2], "9");
});

Deno.test("syncMilestoneBranches - a rebuild with nowhere to post stands in the log and posts nothing (Issue #4328)", async () => {
  const run = await runDefaultRebuild({
    title: "Refusal Ladder Plain",
    gitFn: rebuildGit().gitFn,
    answer: (args) => {
      if (args.join(" ").includes("issues?milestone=1")) {
        throw new Error("children are unreadable");
      }
      return undefined;
    },
  });
  assertEquals(run.entry?.rebuilds, 1, "the rebuild itself still stands");
  assertEquals(issueComments(run.ghCalls), []);
  assert(
    run.logs.some((l) =>
      l.includes("No open issue to carry a milestone rebuild")
    ),
    JSON.stringify(run.logs),
  );
  assert(
    run.logs.some((l) =>
      l.includes("Could not read the open children of milestone")
    ),
    "the lookup's own degraded-read line reaches the sweep log",
  );
});

Deno.test("syncMilestoneBranches - a default rebuild that cannot prepare the clone falls through to the roll-back (Issue #4328)", async () => {
  const git = rebuildGit("fatal: the clone is wedged");
  const run = await runDefaultRebuild({ gitFn: git.gitFn });
  assertEquals(run.rollbacks.length, 1);
  assertEquals(run.entry?.rebuilds, undefined);
  assertEquals(
    git.calls.some((c) => c[0] === "cherry-pick"),
    false,
    "nothing is replayed onto an unprepared clone",
  );
  assert(
    run.logs.some((l) =>
      l.includes(
        `failed at step milestone-rebuild: Could not check out '${BRANCH}' ` +
          `for roll-back: fatal: the clone is wedged`,
      )
    ),
    JSON.stringify(run.logs),
  );
});

Deno.test("syncMilestoneBranches - with no git runner the default rebuild says so and the roll-back runs (Issue #4328)", async () => {
  const run = await runDefaultRebuild({});
  assertEquals(run.rollbacks.length, 1);
  assertEquals(run.entry?.rebuilds, undefined);
  assert(
    run.logs.some((l) =>
      l.includes("rebuild not available — no git runner is wired")
    ),
    JSON.stringify(run.logs),
  );
});

const SHA_8 = "8".repeat(40);
const SUB_PRS_7_AND_8 = JSON.stringify([
  {
    number: 7,
    headRefName: "issue-7-sub",
    body: "",
    mergedAt: "2026-10-01T00:00:00Z",
    mergeCommit: { oid: SUB_PR_SHA },
  },
  {
    number: 8,
    headRefName: "issue-8-sub",
    body: "",
    mergedAt: "2026-10-02T00:00:00Z",
    mergeCommit: { oid: SHA_8 },
  },
]);

const pickedShas = (calls: string[][]): string[] =>
  calls.filter((c) => c[0] === "cherry-pick").map((c) => c[c.length - 1]!);

Deno.test("syncMilestoneBranches - the default rebuild never replays a sub-PR the earlier roll-back reverted (PR #4344 review)", async () => {
  const git = rebuildGit();
  const run = await runDefaultRebuild({
    gitFn: git.gitFn,
    merged: SUB_PRS_7_AND_8,
    ledger: { rollbacks: 1, revertedPrs: [7] },
  });
  // Positive control: the rebuild ran and replayed the other sub-PR.
  assertEquals(run.entry?.rebuilds, 1);
  assertEquals(pickedShas(git.calls), [SHA_8]);
  assertEquals(
    run.entry?.revertedPrs,
    [7],
    "the ledger still records what the roll-back reverted",
  );
});

Deno.test("syncMilestoneBranches - without a reverted sub-PR the default rebuild replays every merged sub-PR (PR #4344 review)", async () => {
  const git = rebuildGit();
  await runDefaultRebuild({ gitFn: git.gitFn, merged: SUB_PRS_7_AND_8 });
  assertEquals(pickedShas(git.calls), [SUB_PR_SHA, SHA_8]);
});

/** A spent budget that a merge-gate refusal of the merged tree pushes over. */
const gateRefusedMerge = () =>
  mergeGateFailureError(BRANCH, DEFAULT_BRANCH, {
    status: "failed",
    detail: "deno check failed",
    output: "TS2304: Cannot find name 'scan'",
  });

Deno.test("syncMilestoneBranches - a rebuild after a merge-gate refusal is not pushed when the gate refuses it too (PR #4344 review)", async () => {
  const git = rebuildGit();
  let gated = "";
  const run = await runDefaultRebuild({
    gitFn: git.gitFn,
    syncError: gateRefusedMerge,
    ledger: {
      rollbacks: 0,
      rollbackFailures: 1,
      conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET - 1,
    },
    gate: (repo) => {
      gated = repo;
      return Promise.resolve({
        status: "failed",
        detail: "deno check failed",
        output: "TS2304: Cannot find name 'scan'",
      });
    },
  });
  assertEquals(gated, REPO, "the gate judged the rebuilt tree");
  assertEquals(git.calls.some((c) => c[0] === "push"), false);
  assertEquals(run.entry?.rebuilds, undefined);
  assertEquals(run.rollbacks.length, 1, "it falls through to the roll-back");
  assert(
    run.logs.some((l) =>
      l.includes("failed at step milestone-gate") &&
      l.includes("TS2304: Cannot find name 'scan'")
    ),
    JSON.stringify(run.logs),
  );
});

Deno.test("syncMilestoneBranches - the same merge-gate-refusal budget rebuilds and pushes when the gate passes the rebuilt tree (PR #4344 review)", async () => {
  const git = rebuildGit();
  const run = await runDefaultRebuild({
    gitFn: git.gitFn,
    syncError: gateRefusedMerge,
    ledger: {
      rollbacks: 0,
      rollbackFailures: 1,
      conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET - 1,
    },
  });
  assertEquals(git.calls.some((c) => c[0] === "push"), true);
  assertEquals(run.entry?.rebuilds, 1);
  assertEquals(run.rollbacks, []);
});

Deno.test("syncMilestoneBranches - with no merge gate wired the default rebuild does not run and the roll-back does (PR #4344 review)", async () => {
  const git = rebuildGit();
  const run = await runDefaultRebuild({ gitFn: git.gitFn, gate: null });
  assertEquals(run.rollbacks.length, 1);
  assertEquals(run.entry?.rebuilds, undefined);
  assertEquals(git.calls.some((c) => c[0] === "cherry-pick"), false);
  assertEquals(git.calls.some((c) => c[0] === "push"), false);
  assert(
    run.logs.some((l) => l.includes("no merge gate is wired")),
    JSON.stringify(run.logs),
  );
});

Deno.test("prepareRollbackWorktree - a checkout that succeeded is not reset even if its output names the index (Issue #4328)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, { [KEY]: spentLedger() });
    const calls: string[][] = [];
    const gitFn: RollbackGitFn = (_repo, args) => {
      calls.push([...args]);
      return Promise.resolve({
        code: args[0] === "merge" ? 128 : 0,
        stdout: "",
        stderr: args[0] === "checkout" ? INDEX_STDERR : "",
      });
    };
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => refusalError("agent"),
      syncCalls: [],
      rollbackGitFn: gitFn,
    }));
    assertEquals(
      calls.filter((c) => c[0] === "checkout" && c[1] === "-B").length,
      1,
    );
    assertEquals(calls.some((c) => c[0] === "reset"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a landed hand-off rebuild ends recovery before the next cycle (PR #4344)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, {
      [KEY]: spentLedger({
        count: 5,
        rollbackFailures: 1,
        conflictAttempts: 2,
      }),
    });
    const rebuilds: string[] = [];
    const syncCalls: string[] = [];
    const deps = sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncCalls,
      syncError: gateRefusedMerge,
      rebuilds,
      rebuildOutcome: REBUILT,
    });
    let closes = 0;
    deps.closeMilestoneFn = () => {
      closes++;
      return Promise.resolve(true);
    };
    await syncMilestoneBranches(deps);
    assertEquals(rebuilds.length, 1);
    assertEquals((await readEntry(streakPath))?.rebuilds, 1);
    assertEquals((await readEntry(streakPath))?.conflictAttempts, 0);
    await syncMilestoneBranches({
      ...deps,
      defaultTipShaFn: () =>
        Promise.resolve({ ok: true as const, value: tip(2) }),
    });
    assertEquals(
      syncCalls.length,
      2,
      "the recovered branch is synced next cycle",
    );
    assertEquals(rebuilds.length, 1, "no redundant rebuild");
    assertEquals(closes, 0, "a recovered milestone must not be retired");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - resolver rebuild resets the same recovery ledger (PR #4344)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    await saveSyncStreaks(streakPath, {
      [KEY]: spentLedger({
        count: 6,
        rollbackFailures: 1,
        rebuilds: 2,
        lastAttempt: {
          at: new Date(NOW).toISOString(),
          outcome: "failed",
          reason: "recovery rung: rollback",
        },
      }),
    });
    const syncCalls: string[] = [];
    const deps = sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncCalls,
      syncError: gateRefusedMerge,
    });
    let rebuilds = 0;
    let closes = 0;
    deps.rebuildMilestoneFn = () => {
      rebuilds++;
      return Promise.resolve(true);
    };
    deps.closeMilestoneFn = () => {
      closes++;
      return Promise.resolve(true);
    };
    await syncMilestoneBranches(deps);
    assertEquals(rebuilds, 1);
    const entry = await readEntry(streakPath);
    assertEquals(entry?.conflictAttempts, 0);
    assertEquals(entry?.rebuilds, 3);
    assertEquals(entry?.count, 0);
    await syncMilestoneBranches({
      ...deps,
      defaultTipShaFn: () =>
        Promise.resolve({ ok: true as const, value: tip(2) }),
    });
    assertEquals(syncCalls.length, 1);
    assertEquals(rebuilds, 1);
    assertEquals(closes, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
