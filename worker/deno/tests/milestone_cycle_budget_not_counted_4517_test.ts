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
  resolverRungDue,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  type MilestonePresyncDeps,
  presyncMilestoneBranch,
} from "../lib/milestone_presync.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import { AGENT_PROVIDER_UNAVAILABLE } from "../lib/milestone_conflict_ladder.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import {
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

Deno.test("syncMilestoneBranches - the gate-refusal log needs both a conflict gate failure and a cycle that withheld the agent (PR #4581 review)", async () => {
  const cases: Array<
    { name: string; syncError: () => Error; deadlineMs: number }
  > = [
    {
      // Short cycle, but the failure is a fetch fault, not a gate refusal.
      name: "short cycle, non-conflict failure",
      syncError: () => new Error("fatal: unable to access 'https://x/y.git'"),
      deadlineMs: SHORT_CYCLE_MS,
    },
    {
      // Short cycle, a conflict nobody gated: the deferral, not a refusal.
      name: "short cycle, conflict without a gate failure",
      syncError: agentDeferredError,
      deadlineMs: SHORT_CYCLE_MS,
    },
    {
      // Long cycle: the agent rung ran, so the "agent withheld" log is not said.
      name: "long cycle, gate refusal",
      syncError: gateRefusedError,
      deadlineMs: LONG_CYCLE_MS,
    },
  ];
  for (const c of cases) {
    const { dir, streakPath } = await workDir();
    try {
      const logs: string[] = [];
      await syncMilestoneBranches(sweepDeps({
        streakPath,
        defaultSha: tip(1),
        syncError: c.syncError,
        syncCalls: [],
        rollbacks: [],
        logs,
        deadlineMs: c.deadlineMs,
      }));
      assertEquals(
        logs.join("\n").includes("merge gate refused the resolution"),
        false,
        c.name,
      );
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

/** A plain non-conflict git failure: not charged, and it advances `count`. */
function fetchFailedError(): Error {
  return new Error("fetch failed: network unreachable");
}

/** A conflict the agent provider could not answer for: disrupted, not charged. */
function disruptedError(): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "every rung left it undecided",
    [fileAnalysis(`agent: ${AGENT_PROVIDER_UNAVAILABLE}`)],
    [],
    tip(0),
    undefined,
    MILESTONE_SHA,
  );
}

Deno.test("syncMilestoneBranches - a non-climbing failure streak then one resolver decline is attempt 1 of 3 (Issue #4587)", async () => {
  // Non-climbing failures advance `count`, but never `resolverDeclines`, so
  // the first real decline after any such streak must not climb the ladder.
  const failures: Array<{ name: string; syncError: () => Error }> = [
    { name: "non-conflict git failure", syncError: fetchFailedError },
    { name: "disrupted provider outage", syncError: disruptedError },
  ];
  for (const failure of failures) {
    for (const streak of [3, 6, 9]) {
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
        for (let i = 0; i < streak; i++) await runCycle(failure.syncError);
        // Positive control: each failure really advanced the streak count.
        const failing = await readEntry(streakPath);
        assertEquals(
          failing?.count,
          streak,
          `${failure.name} x${streak} advances count`,
        );
        assertEquals(
          failing?.resolverDeclines ?? 0,
          0,
          `${failure.name} x${streak} is never a decline`,
        );

        // The cycle with the runway: the agent runs and declines once.
        await runCycle(agentDeclinedError, LONG_CYCLE_MS);
        const entry = await readEntry(streakPath);
        assert(entry);
        // Positive control: the decline was a charged resolver decline.
        assertEquals(entry.lastAttempt?.outcome, "failed");
        assertEquals(
          entry.lastAttempt?.reason,
          "the conflict resolver declined",
        );
        assertEquals(
          entry.conflictAttempts,
          1,
          `after ${failure.name} x${streak}`,
        );
        assertEquals(rollbacks, [], `after ${failure.name} x${streak}`);
        assertEquals(rebuilds, [], `after ${failure.name} x${streak}`);
        assertEquals(closes, [], `after ${failure.name} x${streak}`);
        assertEquals(syncCalls.length, streak + 1);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
});

Deno.test("syncMilestoneBranches - three consecutive resolver declines still climb to the roll-back on the fourth cycle (Issue #4587)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    const syncCalls: string[] = [];
    const rollbacks: string[] = [];
    for (let cycle = 1; cycle <= MILESTONE_CONFLICT_ATTEMPT_BUDGET; cycle++) {
      await syncMilestoneBranches(sweepDeps({
        streakPath,
        defaultSha: tip(cycle),
        syncError: () => agentDeclinedError(),
        syncCalls,
        rollbacks,
        deadlineMs: LONG_CYCLE_MS,
      }));
      assertEquals(
        rollbacks,
        [],
        `decline ${cycle} is within the budget and must not roll back`,
      );
    }
    // Positive control: the three declines were counted by the ladder.
    assertEquals(
      (await readEntry(streakPath))?.resolverDeclines,
      MILESTONE_CONFLICT_ATTEMPT_BUDGET,
    );

    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(MILESTONE_CONFLICT_ATTEMPT_BUDGET + 1),
      syncError: () => agentDeclinedError(),
      syncCalls,
      rollbacks,
      deadlineMs: LONG_CYCLE_MS,
    }));
    assertEquals(rollbacks, [
      `${REPO}|${BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolverRungDue - the ladder reads resolverDeclines, not count (Issue #4587)", () => {
  const declined = {
    at: "2026-10-31T12:00:00.000Z",
    outcome: "failed" as const,
    reason: "the conflict resolver declined",
  };
  // Nine failures of other kinds and no declines: still resolve.
  assertEquals(
    resolverRungDue({
      count: 9,
      escalated: false,
      resolverDeclines: 0,
      lastAttempt: declined,
    }),
    null,
  );
  // Three declines climb to the roll-back, whatever `count` holds.
  assertEquals(
    resolverRungDue({
      count: 1,
      escalated: false,
      resolverDeclines: 3,
      lastAttempt: declined,
    }),
    "rollback",
  );
});

Deno.test("sync streak ledger - resolverDeclines round-trips, and an older file reads as zero (Issue #4587)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    // An old-shape ledger file: `count` only, no `resolverDeclines`.
    await Deno.writeTextFile(
      streakPath,
      JSON.stringify({ [KEY]: { count: 9, escalated: false } }),
    );
    const older = await readEntry(streakPath);
    assertEquals(older?.count, 9);
    assertEquals(older?.resolverDeclines, undefined);

    await saveSyncStreaks(streakPath, {
      [KEY]: { count: 1, escalated: false, resolverDeclines: 2 },
    });
    assertEquals((await readEntry(streakPath))?.resolverDeclines, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resetConflictLedgerOnSuccess - a landed sync drops resolverDeclines (Issue #4587)", () => {
  const reset = resetConflictLedgerOnSuccess({
    count: 3,
    escalated: false,
    resolverDeclines: 2,
  });
  assertEquals("resolverDeclines" in reset, false);
});

Deno.test("syncMilestoneBranches - a moved default tip re-arms a spent budget but keeps the resolver declines (Issue #4587)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    // A spent budget whose roll-back has already run, which is what lets the
    // moved default tip re-arm it at all, after three resolver declines.
    await saveSyncStreaks(streakPath, {
      [KEY]: {
        count: 0,
        escalated: false,
        conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET,
        rollbacks: 1,
        resolverDeclines: 3,
        fallbackDefaultSha: tip(0),
        lastAttempt: {
          at: new Date(1_000).toISOString(),
          outcome: "failed",
          reason: "the conflict resolver declined",
        },
      },
    });
    const syncCalls: string[] = [];
    const rollbacks: string[] = [];
    const rebuilds: string[] = [];
    const logs: string[] = [];
    const runCycle = (cycle: number) => {
      const deps = sweepDeps({
        streakPath,
        defaultSha: tip(cycle),
        syncError: () => agentDeclinedError(),
        syncCalls,
        rollbacks,
        logs,
        deadlineMs: LONG_CYCLE_MS,
      });
      deps.rebuildMilestoneFn = () => {
        rebuilds.push(BRANCH);
        return Promise.resolve(true);
      };
      return syncMilestoneBranches(deps);
    };

    await runCycle(1);
    // Positive control: the moved tip really re-armed the spent budget.
    assert(logs.join("\n").includes("has moved to"));
    assertEquals(syncCalls.length, 1);
    // The re-arm reset the attempts but carried the three declines over, so
    // this decline is the fourth, not attempt 1 of 3.
    const rearmed = await readEntry(streakPath);
    assertEquals(rearmed?.resolverDeclines, 4);
    assertEquals(rearmed?.conflictAttempts, 1);

    await runCycle(2);
    await runCycle(3);
    assertEquals((await readEntry(streakPath))?.resolverDeclines, 6);
    assertEquals(rebuilds, [], "the rebuild rung is not yet due");

    // Six carried-over declines reach the rebuild rung on the next cycle.
    await runCycle(4);
    assertEquals(rebuilds, [BRANCH], "the carried declines reach the rebuild");
    assertEquals(rollbacks, [], "the spent roll-back is not taken again");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a landed roll-back clears the budget but keeps the resolver declines (Issue #4587)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    // A spent budget after three declines, with no roll-back yet: the third
    // decline's rung is the roll-back, which lands this cycle.
    await saveSyncStreaks(streakPath, {
      [KEY]: {
        count: 0,
        escalated: false,
        conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET,
        resolverDeclines: 3,
        lastAttempt: {
          at: new Date(1_000).toISOString(),
          outcome: "failed",
          reason: "the conflict resolver declined",
        },
      },
    });
    const syncCalls: string[] = [];
    const rollbacks: string[] = [];
    const deps = sweepDeps({
      streakPath,
      defaultSha: tip(1),
      syncError: () => agentDeclinedError(),
      syncCalls,
      rollbacks,
      deadlineMs: LONG_CYCLE_MS,
    });
    const recorded = deps.rollbackFn!;
    deps.rollbackFn = async (request) => {
      await recorded(request);
      return { merged: true, reverted: [] };
    };
    await syncMilestoneBranches(deps);
    // Positive control: the roll-back really ran, and it landed.
    assertEquals(rollbacks, [
      `${REPO}|${BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);
    const entry = await readEntry(streakPath);
    assert(entry);
    assertEquals(entry.rollbacks, 1, "the landed roll-back is recorded");
    assertEquals(
      entry.conflictAttempts,
      0,
      "a landed roll-back refills the budget",
    );
    assertEquals(
      entry.resolverDeclines,
      3,
      "a landed roll-back does not reset the decline count",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
