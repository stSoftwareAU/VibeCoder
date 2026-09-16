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
  saveSyncStreaks,
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

    const started = Date.now();
    const deadlineEpochMs = started + 1_500;
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
    const elapsed = Date.now() - started;

    // The handler returned inside its budget rather than being abandoned by
    // the watchdog with every later milestone unvisited.
    assert(
      elapsed < 1_500 + 1_000,
      `the sweep took ${elapsed}ms, past its own deadline`,
    );
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
    const hungry = "milestone/needs-an-agent";
    const starved = "milestone/never-reached";
    // The previous cycle reached the first milestone and never got to the
    // second, which is exactly the record the order is read from.
    await saveSyncStreaks(streakPath, {
      [`${REPO}|${hungry}`]: {
        count: 1,
        escalated: false,
        lastVisitedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    const order: string[] = [];
    const result = await syncMilestoneBranches(sweepDeps({
      branches: [hungry, starved],
      streakPath,
      syncBranchFn: (_repo, branch) => {
        order.push(branch);
        return Promise.resolve({
          ok: true as const,
          value: { message: "merged" },
        });
      },
    }));

    assert(result.ok);
    assertEquals(order, [starved, hungry]);
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
