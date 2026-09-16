/**
 * The milestone sweep reaches every milestone every cycle (Issue #2215).
 *
 * GRQ-23 watched one conflict resolution take the handler's whole 795 s
 * watchdog budget: the handler was abandoned, every milestone behind it in
 * the fleet-wide repository order went unsynced, and a both-added ledger file
 * the sweep's own triage settles by union in seconds was left conflicting for
 * a human to merge by hand. These are the two behaviours that stop that
 * repeating — the cheap rungs run across every milestone before any agent
 * does, and a starved milestone goes first on the next cycle.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import {
  loadSyncStreaks,
  milestoneSyncStreakPath,
} from "../lib/milestone_sync_streak.ts";

const REPO = "owner/repo";
const TIP = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

/** The conflict a deterministic rung could not settle. */
function conflictFailure(): Error {
  return new MilestoneConflictEscalation(
    "the conflict was not settled",
    [{
      path: "docs/audits/lib-sweep-coverage.json",
      reason: "triage: both sides added the file",
      oursExports: [],
      theirsExports: [],
      oursTests: [],
      theirsTests: [],
      onlyOursTests: [],
      onlyTheirsTests: [],
    }],
    [],
    TIP,
  );
}

/** A sweep over one repository's milestones, with every side effect stubbed. */
function sweepDeps(options: {
  branches: string[];
  streakPath: string;
  syncBranchFn: MilestoneBranchSyncDeps["syncBranchFn"];
  deadlineEpochMs?: number;
  log?: (message: string) => void;
}): MilestoneBranchSyncDeps {
  const deps: MilestoneBranchSyncDeps = {
    repos: [REPO],
    ghCommandFn: (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes(`repos/${REPO}/milestones`)) {
        return Promise.resolve(
          JSON.stringify(
            options.branches.map((branch, i) => ({
              title: branch.replace("milestone/", ""),
              number: i + 1,
            })),
          ),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("branches/milestone")) {
        return Promise.resolve(args[2]!.split("/").slice(-2).join("/"));
      }
      return Promise.resolve("[]");
    },
    syncBranchFn: options.syncBranchFn,
    defaultTipShaFn: () => Promise.resolve({ ok: true as const, value: TIP }),
    log: options.log ?? (() => undefined),
    streakPath: options.streakPath,
    // Milliseconds rather than minutes, so the bound this exercises is
    // reached inside a unit test's budget.
    attemptShareFloorMs: 200,
    attemptShareReserveMs: 100,
    minMsPerAgentAttempt: 50,
    attemptOverheadMs: 10,
    agentTimeoutMs: 1_000,
  };
  if (options.deadlineEpochMs !== undefined) {
    deps.deadlineEpochMs = options.deadlineEpochMs;
  }
  return deps;
}

Deno.test("syncMilestoneBranches - a resolution that outruns its share is abandoned and the milestone behind it is still synced (Issue #2215)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2215-share-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const hungry = "milestone/needs-an-agent";
    const union = "milestone/ledger-union";
    const logs: string[] = [];

    // The agent run that never returns, and the handle that lets the test
    // settle it before it exits.
    let releaseAgent: (() => void) | undefined;
    const agentRun = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });

    const deadlineEpochMs = Date.now() + 1_500;
    const result = await syncMilestoneBranches(sweepDeps({
      branches: [hungry, union],
      streakPath,
      deadlineEpochMs,
      log: (m) => logs.push(m),
      syncBranchFn: async (_repo, branch, _base, syncOptions) => {
        if (branch === union) {
          // The #2207 shape: the triage settles it by union, no agent needed.
          return { ok: true as const, value: { message: "merged by union" } };
        }
        if (!syncOptions?.agentAllowed) {
          return { ok: false as const, error: conflictFailure() };
        }
        await agentRun;
        return { ok: true as const, value: { message: "never reached" } };
      },
    }));

    // Returning at all is the assertion: the agent stub never settles, so a
    // sweep that waited for it would hang here rather than hand the watchdog
    // a handler to abandon. No stopwatch — the bound is the sweep's own
    // injected budget, not this machine's speed.
    assert(result.ok);
    // The union merged, and it did not wait behind the agent.
    assertEquals(result.value.synced, 1);

    const streaks = await loadSyncStreaks(streakPath);
    const starved = streaks[`${REPO}|${hungry}`];
    assertEquals(starved?.lastAttempt?.outcome, "disrupted");
    // Disrupted is charged nothing, exactly as a killed attempt already is.
    assertEquals(starved?.conflictAttempts, 0);
    assertEquals(streaks[`${REPO}|${union}`]?.lastSyncedDefaultSha, TIP);
    assert(
      logs.some((l) => l.includes("outran its share of the handler budget")),
      `no abandonment line in: ${JSON.stringify(logs)}`,
    );

    releaseAgent!();
    await agentRun;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - the milestone the budget starved goes first next cycle (Issue #2215)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2215-rotation-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const hungry = "milestone/eats-the-budget";
    const starved = "milestone/never-reached";

    let releaseHungry: (() => void) | undefined;
    const hungryRun = new Promise<void>((resolve) => {
      releaseHungry = resolve;
    });

    // Cycle 1: the first milestone outruns its share and is abandoned, so
    // nothing else in its repository is touched and the second is never
    // visited at all.
    const firstCycle: string[] = [];
    const cycleOne = await syncMilestoneBranches(sweepDeps({
      branches: [hungry, starved],
      streakPath,
      deadlineEpochMs: Date.now() + 600,
      syncBranchFn: async (_repo, branch) => {
        firstCycle.push(branch);
        if (branch === hungry) await hungryRun;
        return { ok: true as const, value: { message: "merged" } };
      },
    }));
    assert(cycleOne.ok);
    assertEquals(firstCycle, [hungry]);

    // Cycle 2: the starved milestone is the one with no visit on record, so
    // it goes first — read from the ledger the first cycle persisted, not
    // from anything this test wrote.
    const secondCycle: string[] = [];
    const cycleTwo = await syncMilestoneBranches(sweepDeps({
      branches: [hungry, starved],
      streakPath,
      syncBranchFn: (_repo, branch) => {
        secondCycle.push(branch);
        return Promise.resolve({
          ok: true as const,
          value: { message: "merged" },
        });
      },
    }));
    assert(cycleTwo.ok);
    assertEquals(secondCycle, [starved, hungry]);

    releaseHungry!();
    await hungryRun;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - the cheap rungs run across every milestone before any agent does (Issue #2215)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2215-order-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const first = "milestone/conflicts";
    const second = "milestone/ledger-union";
    const calls: string[] = [];

    const result = await syncMilestoneBranches(sweepDeps({
      branches: [first, second],
      streakPath,
      syncBranchFn: (_repo, branch, _base, syncOptions) => {
        calls.push(
          `${branch}:${syncOptions?.agentAllowed ? "agent" : "rules"}`,
        );
        if (branch === second) {
          return Promise.resolve({
            ok: true as const,
            value: { message: "merged by union" },
          });
        }
        return Promise.resolve(
          syncOptions?.agentAllowed
            ? { ok: true as const, value: { message: "resolved by the agent" } }
            : { ok: false as const, error: conflictFailure() },
        );
      },
    }));

    assert(result.ok);
    // Both deterministic attempts come first; the agent rung is last.
    assertEquals(calls, [
      `${first}:rules`,
      `${second}:rules`,
      `${first}:agent`,
    ]);
    // One cycle, one verdict: the branch the agent settled is counted synced
    // and not also failed.
    assertEquals(result.value.synced, 2);
    assertEquals(result.value.failed, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - an abandoned attempt keeps its repository's lease until it settles (Issue #2215)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2215-lease-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const hungry = "milestone/eats-the-budget";
    const behind = "milestone/behind-it";

    let releaseHungry: (() => void) | undefined;
    const hungryRun = new Promise<void>((resolve) => {
      releaseHungry = resolve;
    });

    let released = 0;
    const touched: string[] = [];
    const deps = sweepDeps({
      branches: [hungry, behind],
      streakPath,
      deadlineEpochMs: Date.now() + 600,
      syncBranchFn: async (_repo, branch) => {
        touched.push(branch);
        if (branch === hungry) await hungryRun;
        return { ok: true as const, value: { message: "merged" } };
      },
    });
    deps.leaseRepoFn = () => ({ release: () => released++ });

    const result = await syncMilestoneBranches(deps);
    assert(result.ok);

    // The clone belongs to the attempt still running inside it: nothing else
    // in the repository was touched, and the lease is still held.
    assertEquals(touched, [hungry]);
    assertEquals(released, 0);

    releaseHungry!();
    await hungryRun;
    // A microtask for the release attached to the abandoned attempt.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(released, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
