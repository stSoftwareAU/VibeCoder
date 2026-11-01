/**
 * A cargo-budget withhold is not a refusal (Issue #4588).
 *
 * A milestone branch whose agent rung was withheld because a cargo build would
 * not fit the host (`agent: cargo budget withheld the agent`) is a wait for the
 * host's disk, not a refusal the merge gate made. The verdict was marked
 * `refusal: true`, so each withheld cycle added 1 to `refusedCycles`. Three
 * withholds pre-loaded the refusal ceiling, and the first real gate refusal
 * after a disk shortage climbed straight to the roll-back.
 *
 * A withhold never advances the refusal streak, in the sweep or in the pre-cut
 * sync. A merge-gate refusal still does, and still climbs at the ceiling.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CARGO_BUDGET_AGENT_WITHHELD,
  judgeSyncFailure,
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
  MILESTONE_REFUSAL_CEILING,
  milestoneSyncStreakPath,
  type SyncStreakEntry,
  syncStreakKey,
} from "../lib/milestone_sync_streak.ts";

const REPO = "owner/repo";
const TITLE = "#4588 Cargo Withhold";
const BRANCH = createMilestoneBranchName(TITLE);
const KEY = syncStreakKey(REPO, BRANCH);
const DEFAULT_BRANCH = "main";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
/** A cycle with the runway to offer the agent rung, so the withhold is reached. */
const LONG_CYCLE_MS = 6 * 60 * 60 * 1000;
const MILESTONE_SHA = "c".repeat(40);
const FLAG_ISSUE = 4588;
/** Withheld cycles run: past the ceiling, so a climb would show. */
const WITHHOLDS = MILESTONE_REFUSAL_CEILING + 3;

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

/**
 * The conflict a cycle reports when a cargo build would not fit the host, so
 * the agent rung was withheld (Issues #4326 and #4588). No gate ran.
 */
function cargoWithheldError(): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "every rung left it undecided",
    [
      fileAnalysis(
        `agent: ${CARGO_BUDGET_AGENT_WITHHELD}: the host has no room for a cargo build`,
      ),
    ],
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
    deadlineEpochMs: NOW + (options.deadlineMs ?? LONG_CYCLE_MS),
    streakPath: options.streakPath,
    log: () => undefined,
    rollbackFn: (request) => {
      seen.push(
        `${request.repo}|${request.milestoneBranch}|${request.attempts}`,
      );
      return Promise.resolve(undefined);
    },
    rebuildFn: () => Promise.resolve(undefined),
    closeMilestoneFn: () => Promise.resolve(true),
  };
}

/** A ledger file in a fresh work directory, removed by the caller. */
async function workDir(): Promise<{ dir: string; streakPath: string }> {
  const dir = await Deno.makeTempDir({ prefix: "issue-4588-cargo-withhold-" });
  return { dir, streakPath: milestoneSyncStreakPath(dir) };
}

async function readEntry(
  streakPath: string,
): Promise<SyncStreakEntry | undefined> {
  return (await loadSyncStreaks(streakPath))[KEY];
}

Deno.test("syncMilestoneBranches - a cargo-budget withhold never climbs to the roll-back or counts as a refusal, however many cycles it repeats (Issue #4588)", async () => {
  const { dir, streakPath } = await workDir();
  try {
    const syncCalls: string[] = [];
    const rollbacks: string[] = [];
    for (let cycle = 1; cycle <= WITHHOLDS; cycle++) {
      await syncMilestoneBranches(sweepDeps({
        streakPath,
        defaultSha: tip(cycle),
        syncError: cargoWithheldError,
        syncCalls,
        rollbacks,
      }));
      assertEquals(
        rollbacks,
        [],
        `cycle ${cycle} is a withhold and must not roll back`,
      );
    }
    // Positive control: every withheld cycle really ran the sync.
    assertEquals(syncCalls.length, WITHHOLDS);
    const entry = await readEntry(streakPath);
    assert(entry);
    assertEquals(entry.refusedCycles ?? 0, 0, "a withhold is never counted");
    assertEquals(
      entry.conflictAttempts ?? 0,
      0,
      "a withhold spends no attempt",
    );
    assertEquals(entry.lastAttempt?.reason, CARGO_BUDGET_AGENT_WITHHELD);
    assertEquals(entry.lastAttempt?.outcome, "not-charged");

    // The first real gate refusal after the shortage is refusal 1, not a climb.
    await syncMilestoneBranches(sweepDeps({
      streakPath,
      defaultSha: tip(WITHHOLDS + 1),
      syncError: gateRefusedError,
      syncCalls,
      rollbacks,
    }));
    assertEquals(rollbacks, [], "the first gate refusal must not roll back");
    // Positive control: the gate refusal really ran the sync.
    assertEquals(syncCalls.length, WITHHOLDS + 1);
    const refused = await readEntry(streakPath);
    assert(refused);
    assertEquals(refused.refusedCycles, 1, "the gate refusal is refusal 1");
    assertEquals(
      refused.conflictAttempts ?? 0,
      0,
      "the gate refusal does not spend an attempt",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("presyncMilestoneBranch - a cargo-budget withhold never exhausts the ledger, however many cycles it repeats (Issue #4588)", async () => {
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
          error: cargoWithheldError(),
        });
      },
      log: () => undefined,
    });
    // The grant offers the agent, so the withhold is what the sync reports.
    const args = {
      repo: REPO,
      milestoneBranch: BRANCH,
      defaultBranch: DEFAULT_BRANCH,
      streakPath,
      grant: { agentAllowed: true },
      nowMs: NOW,
    };
    for (let withhold = 1; withhold <= WITHHOLDS; withhold++) {
      await presyncMilestoneBranch(args, presyncDeps());
      const entry = await readEntry(streakPath);
      assert(entry);
      assertEquals(
        entry.refusedCycles ?? 0,
        0,
        `withhold ${withhold} is not counted`,
      );
      assertEquals(
        isConflictBudgetExhausted(entry),
        false,
        `withhold ${withhold} never spends the budget`,
      );
      assertEquals(entry.lastAttempt?.reason, CARGO_BUDGET_AGENT_WITHHELD);
      assertEquals(entry.lastAttempt?.outcome, "not-charged");
    }
    // Positive control: every withheld pre-cut sync really ran.
    assertEquals(syncs, WITHHOLDS);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("judgeSyncFailure - a cargo-budget withhold is not-charged and carries no refusal (Issue #4588)", () => {
  const conclusion = judgeSyncFailure(cargoWithheldError(), true);
  assertEquals(conclusion.outcome, "not-charged");
  assertEquals(conclusion.reason, CARGO_BUDGET_AGENT_WITHHELD);
  assertEquals(conclusion.refusal, undefined, "a withhold is not a refusal");
});
