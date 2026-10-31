/**
 * A cycle-budget deferral is not a refusal (Issue #4517).
 *
 * A milestone branch was deferred the agent rung because too little of the
 * cycle was left to cover a run (`agent deferred: cycle budget`). That is a
 * wait for a cycle with the runway, not a refusal the merge gate made. It was
 * counted toward the refusal ceiling, so after three cycles it climbed to the
 * roll-back and filed a `merge-fallback` issue. No agent ever looked at the
 * conflict, so the roll-back was not the branch's fault and freed nothing.
 *
 * A deferral never advances the refusal streak, in the sweep or in the pre-cut
 * sync. A merge-gate refusal still does, and still climbs at the ceiling.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  AGENT_DEFERRED_CYCLE_BUDGET,
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  type MilestonePresyncDeps,
  presyncMilestoneBranch,
} from "../lib/milestone_presync.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import {
  isConflictBudgetExhausted,
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  MILESTONE_REFUSAL_CEILING,
  milestoneSyncStreakPath,
  type SyncStreakEntry,
  syncStreakKey,
} from "../lib/milestone_sync_streak.ts";

const REPO = "owner/repo";
const TITLE = "#4517 Cycle Budget";
const BRANCH = createMilestoneBranchName(TITLE);
const KEY = syncStreakKey(REPO, BRANCH);
const DEFAULT_BRANCH = "main";
const NOW = Date.parse("2026-10-31T12:00:00.000Z");
/**
 * A cycle with five minutes of deadline left: the pass still runs, but after
 * the conflict overhead less than one agent run remains, so the agent rung is
 * not offered (Issue #2309). The sweep's grant is therefore `agentAllowed:
 * false`, which is what produces the deferral.
 */
const SHORT_CYCLE_MS = 5 * 60 * 1000;
/** A cycle with the runway to offer the agent rung. */
const LONG_CYCLE_MS = 6 * 60 * 60 * 1000;
const MILESTONE_SHA = "c".repeat(40);
const FLAG_ISSUE = 4517;
/** Cycles a branch is deferred for: past the ceiling, so a climb would show. */
const DEFERRALS = MILESTONE_REFUSAL_CEILING + 3;

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

/** The conflict the agent ran on and left undecided (Issue #4328). */
function agentDeclinedError(): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "every rung of the ladder left them undecided",
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
  /** The error this sync of the branch returns. */
  syncError: () => Error;
  /** Every branch a sync was started for, in order. */
  syncCalls: string[];
  /** Wires the injected roll-back and records each request's key. */
  rollbacks: string[];
  /** Every rebuild requested, when the test watches for one. */
  rebuilds?: string[];
  /** Every milestone close requested, when the test watches for one. */
  closes?: string[];
  /** Captures operator messages when the test checks their meaning. */
  logs?: string[];
  /** Overrides the cycle's deadline: a long one offers the agent rung. */
  deadlineMs?: number;
}

/** A one-milestone sweep whose sync fails with `syncError`. */
function sweepDeps(options: SweepOptions): MilestoneBranchSyncDeps {
  const seen = options.rollbacks;
  return {
    repos: [REPO],
    ghCommandFn: (args: string[]): Promise<string> =>
      Promise.resolve(ghAnswer(args)),
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
    log: (message) => options.logs?.push(message),
    rollbackFn: (request) => {
      seen.push(
        `${request.repo}|${request.milestoneBranch}|${request.attempts}`,
      );
      return Promise.resolve(undefined);
    },
    rebuildFn: () => {
      options.rebuilds?.push(BRANCH);
      return Promise.resolve(undefined);
    },
    closeMilestoneFn: () => {
      options.closes?.push(BRANCH);
      return Promise.resolve(true);
    },
  };
}

/** A ledger file in a fresh work directory, removed by the caller. */
async function workDir(): Promise<{ dir: string; streakPath: string }> {
  const dir = await Deno.makeTempDir({ prefix: "issue-4517-cycle-budget-" });
  return { dir, streakPath: milestoneSyncStreakPath(dir) };
}

async function readEntry(
  streakPath: string,
): Promise<SyncStreakEntry | undefined> {
  return (await loadSyncStreaks(streakPath))[KEY];
}

Deno.test("syncMilestoneBranches - short-cycle logs distinguish deferrals from counted gate refusals", async () => {
  for (
    const [syncError, deferred] of [
      [agentDeferredError, true],
      [gateRefusedError, false],
    ] as const
  ) {
    const { dir, streakPath } = await workDir();
    try {
      const logs: string[] = [];
      await syncMilestoneBranches(sweepDeps({
        streakPath,
        defaultSha: tip(1),
        syncError,
        syncCalls: [],
        rollbacks: [],
        logs,
      }));
      const message = logs.join("\n");
      assertEquals(
        message.includes("not counted toward the roll-back"),
        deferred,
      );
      if (!deferred) {
        assert(message.includes("merge gate"));
        assert(message.includes("counted toward the roll-back"));
        assertEquals((await readEntry(streakPath))?.refusedCycles, 1);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("syncMilestoneBranches - a cycle-budget deferral never climbs to the roll-back, however many cycles it repeats (Issue #4517)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    const syncCalls: string[] = [];
    const rollbacks: string[] = [];
    for (let cycle = 1; cycle <= DEFERRALS; cycle++) {
      await syncMilestoneBranches(sweepDeps({
        streakPath,
        defaultSha: tip(cycle),
        syncError: () => agentDeferredError(),
        syncCalls,
        rollbacks,
      }));
      assertEquals(
        rollbacks,
        [],
        `cycle ${cycle} is a deferral and must not roll back`,
      );
    }
    // Positive control: every deferred cycle really ran the sync.
    assertEquals(syncCalls.length, DEFERRALS);
    const entry = await readEntry(streakPath);
    assert(entry);
    assertEquals(entry.refusedCycles ?? 0, 0, "a deferral is never counted");
    assertEquals(
      entry.conflictAttempts ?? 0,
      0,
      "a deferral spends no attempt",
    );
    assertEquals(entry.lastAttempt?.reason, AGENT_DEFERRED_CYCLE_BUDGET);
    assertEquals(entry.lastAttempt?.outcome, "not-charged");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("presyncMilestoneBranch - a cycle-budget deferral never exhausts the ledger, however many cycles it repeats (Issue #4517)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    let syncs = 0;
    const presyncDeps = (): MilestonePresyncDeps => ({
      countBehind: () => Promise.resolve({ ok: true as const, value: 4 }),
      defaultTipSha: () =>
        Promise.resolve({ ok: true as const, value: tip(1) }),
      milestoneTipSha: () =>
        Promise.resolve({ ok: true as const, value: MILESTONE_SHA }),
      syncBranch: () => {
        syncs++;
        return Promise.resolve({
          ok: false as const,
          error: agentDeferredError(),
        });
      },
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
    for (let deferral = 1; deferral <= DEFERRALS; deferral++) {
      await presyncMilestoneBranch(args, presyncDeps());
      const entry = await readEntry(streakPath);
      assert(entry);
      assertEquals(
        entry.refusedCycles ?? 0,
        0,
        `deferral ${deferral} is not counted`,
      );
      assertEquals(
        isConflictBudgetExhausted(entry),
        false,
        `deferral ${deferral} never spends the budget`,
      );
      assertEquals(entry.lastAttempt?.reason, AGENT_DEFERRED_CYCLE_BUDGET);
      assertEquals(entry.lastAttempt?.outcome, "not-charged");
    }
    // Positive control: every deferred pre-cut sync really ran.
    assertEquals(syncs, DEFERRALS);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a gate refusal still climbs at the ceiling after cycle-budget deferrals interleave (Issue #4517)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    const syncCalls: string[] = [];
    const rollbacks: string[] = [];
    let cycle = 0;
    const runCycle = (syncError: () => Error) => {
      cycle++;
      return syncMilestoneBranches(sweepDeps({
        streakPath,
        defaultSha: tip(cycle),
        syncError,
        syncCalls,
        rollbacks,
      }));
    };

    await runCycle(gateRefusedError);
    await runCycle(gateRefusedError);
    assertEquals((await readEntry(streakPath))?.refusedCycles, 2);
    for (let i = 0; i < 5; i++) await runCycle(agentDeferredError);
    // The five deferrals advanced nothing: still two refusals, still no climb.
    assertEquals(
      (await readEntry(streakPath))?.refusedCycles,
      2,
      "deferrals do not advance the refusal streak",
    );
    assertEquals(rollbacks, [], "no climb after the deferrals");

    await runCycle(gateRefusedError);
    assertEquals(
      (await readEntry(streakPath))?.refusedCycles,
      3,
      "the third gate refusal is counted",
    );
    assertEquals(
      rollbacks,
      [],
      "the third refusal is below the ceiling when concluded",
    );

    await runCycle(gateRefusedError);
    assertEquals(rollbacks, [
      `${REPO}|${BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);
    // Positive control: all nine cycles really ran the sync.
    assertEquals(syncCalls.length, 9);
    const entry = await readEntry(streakPath);
    assert(entry);
    assertEquals(
      entry.refusedCycles ?? 0,
      0,
      "a charged climb ends the streak",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a deferral streak then one agent decline is attempt 1 of 3, never a roll-back, rebuild or close (PR #4581 review)", async () => {
  // Nine deferrals would, if counted, carry the first decline to the close rung.
  for (const deferrals of [3, 6, 9]) {
    const { dir, streakPath } = await workDir();
    try {
      const syncCalls: string[] = [];
      const rollbacks: string[] = [];
      const rebuilds: string[] = [];
      const closes: string[] = [];
      let cycle = 0;
      const runCycle = (syncError: () => Error, deadlineMs?: number) => {
        cycle++;
        return syncMilestoneBranches(sweepDeps({
          streakPath,
          defaultSha: tip(cycle),
          syncError,
          syncCalls,
          rollbacks,
          rebuilds,
          closes,
          ...(deadlineMs !== undefined ? { deadlineMs } : {}),
        }));
      };
      for (let i = 0; i < deferrals; i++) await runCycle(agentDeferredError);
      const deferred = await readEntry(streakPath);
      assertEquals(
        deferred?.count,
        0,
        `${deferrals} deferrals add nothing to the figure the ladder reads`,
      );

      // The cycle with the runway: the agent runs and declines once.
      await runCycle(agentDeclinedError, LONG_CYCLE_MS);
      const entry = await readEntry(streakPath);
      assert(entry);
      // Positive control: the decline was a charged resolver decline.
      assertEquals(entry.lastAttempt?.outcome, "failed");
      assertEquals(entry.lastAttempt?.reason, "the conflict resolver declined");
      assertEquals(entry.conflictAttempts, 1, `after ${deferrals} deferrals`);
      assertEquals(rollbacks, [], `after ${deferrals} deferrals`);
      assertEquals(rebuilds, [], `after ${deferrals} deferrals`);
      assertEquals(closes, [], `after ${deferrals} deferrals`);
      assertEquals(syncCalls.length, deferrals + 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
