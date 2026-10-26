/**
 * Nothing new starts once the run target has passed: the milestone sync and
 * the in-cycle milestone sync on an auto-merge PR both stop at their start
 * gates (Issue #4243).
 *
 * #4242 put the run's timeline in one process-wide place. Once its target
 * mark has passed, a sync that has not begun must not begin: it would only
 * be cut off at the finish. A sync already under way is never interrupted,
 * because the gates sit between repositories, milestones and PRs only.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  loadSyncCursor,
  milestoneSyncCursorPath,
  milestoneSyncStreakPath,
} from "../lib/milestone_sync_streak.ts";
import {
  _resetBaseProtectionMemo,
  AutoMergeResult,
  enableAutoMerge,
  MILESTONE_BEHIND_SYNC_MARKER,
  resetBehindSyncComments,
} from "../lib/pr_auto_merge.ts";
import {
  resetRunTimelineForTests,
  resolveRunTimeline,
  setRunTimeline,
} from "../lib/run_timeline.ts";

/** The run starts here (epoch ms); its target is one hour later. */
const STARTED_MS = 1_000_000;
const TARGET_MS = STARTED_MS + 3600 * 1000;

/** Install a one-hour target for the duration of `fn`, then forget it. */
async function withRunTarget<T>(fn: () => Promise<T>): Promise<T> {
  setRunTimeline(resolveRunTimeline({
    startedMs: STARTED_MS,
    runDurationSeconds: 3600,
    runFinishSeconds: 7200,
    env: () => undefined,
    killAfterSeconds: 30,
    warn: () => {},
  }));
  try {
    return await fn();
  } finally {
    resetRunTimelineForTests();
  }
}

/** The lines that name the run target, which must appear once per pass. */
function targetLines(log: string[]): string[] {
  return log.filter((l) => l.includes("run target has passed"));
}

/**
 * Every line that reports a stopped pass, whichever mechanism stopped it.
 * With a cursor set, a stop must log exactly one such line in all (Issue #4243).
 */
function stopLines(log: string[]): string[] {
  return log.filter((l) =>
    l.includes("Milestone sync stopped") ||
    l.includes("Milestone sync pass incomplete")
  );
}

interface FleetOptions {
  dir: string;
  nowMs: number;
  /** Repository → the titles of its open milestones. */
  milestones: Record<string, string[]>;
  synced: string[];
  log: string[];
  /** Calls to ghCommandFn, so a test can see whether any API call was spent. */
  ghCalls: string[];
  /** Runs inside a sync, after it was started and before it completes. */
  onSync?: (clock: { ms: number }) => void;
  /** The handler's deadline (#2215), for a budget stop. */
  deadlineEpochMs?: number;
}

/** Deps over the given repositories and milestones, with an injected clock. */
function fleetDeps(options: FleetOptions): MilestoneBranchSyncDeps {
  const clock = { ms: options.nowMs };
  return {
    ...(options.deadlineEpochMs !== undefined
      ? { deadlineEpochMs: options.deadlineEpochMs }
      : {}),
    repos: Object.keys(options.milestones),
    ghCommandFn: (args: string[]): Promise<string> => {
      const key = args.join(" ");
      options.ghCalls.push(key);
      const repo = Object.keys(options.milestones).find((r) =>
        key.includes(`repos/${r}/`)
      );
      if (key.includes("/milestones") && repo) {
        const titles = options.milestones[repo] ?? [];
        return Promise.resolve(
          JSON.stringify(titles.map((title, i) => ({
            title,
            number: i + 1,
          }))),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("/branches/milestone/")) {
        // A branch probe: a non-empty tip means the branch exists.
        return Promise.resolve("a".repeat(40));
      }
      return Promise.resolve("[]");
    },
    syncBranchFn: (repo, milestoneBranch) => {
      options.synced.push(`${repo}|${milestoneBranch}`);
      options.onSync?.(clock);
      return Promise.resolve({
        ok: true as const,
        value: { message: "merged" },
      });
    },
    defaultTipShaFn: () =>
      Promise.resolve({ ok: true as const, value: "b".repeat(40) }),
    log: (m) => options.log.push(m),
    streakPath: milestoneSyncStreakPath(options.dir),
    cursorPath: milestoneSyncCursorPath(options.dir),
    now: () => clock.ms,
  };
}

Deno.test("syncMilestoneBranches - past the run target no repository is started: no sync, no API call, one line, and the cursor resumes at the first repository (Issue #4243)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4243-past-" });
  try {
    const synced: string[] = [];
    const log: string[] = [];
    const ghCalls: string[] = [];
    const result = await withRunTarget(() =>
      syncMilestoneBranches(fleetDeps({
        dir,
        nowMs: TARGET_MS + 1000,
        milestones: {
          "owner/alpha": ["#1 alpha one"],
          "owner/beta": ["#1 beta one"],
        },
        synced,
        log,
        ghCalls,
      }))
    );

    assertEquals(synced.length, 0, synced.join(", "));
    assertEquals(
      ghCalls.filter((k) => k.includes("/branches/milestone/")).length,
      0,
      "no branch probe is spent once the target has passed",
    );
    assertEquals(
      ghCalls.length,
      0,
      "the repository gate sits before the milestone listing, so no call is made",
    );
    assertEquals(targetLines(log).length, 1, log.join("\n"));
    assertEquals(
      stopLines(log).length,
      1,
      `with a cursor set, the stop logs one line in all: ${log.join("\n")}`,
    );
    assert(
      targetLines(log)[0]!.includes("the milestones of owner/alpha"),
      "the one line names the first repository it refused",
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, { synced: 0, skipped: 0, failed: 0 });
    }
    const cursor = await loadSyncCursor(milestoneSyncCursorPath(dir));
    assertEquals(
      cursor?.repo,
      "owner/alpha",
      "the next pass resumes at the repository it refused",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a sync already under way finishes when the target passes mid-pass, and the next milestone is not started (Issue #4243)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4243-crossing-" });
  try {
    const synced: string[] = [];
    const log: string[] = [];
    const ghCalls: string[] = [];
    const result = await withRunTarget(() =>
      syncMilestoneBranches(fleetDeps({
        dir,
        nowMs: STARTED_MS,
        milestones: {
          "owner/alpha": ["#1 alpha one", "#2 alpha two"],
        },
        synced,
        log,
        ghCalls,
        // The first sync runs past the target, and must still complete.
        onSync: (clock) => {
          clock.ms = TARGET_MS + 1;
        },
      }))
    );

    assertEquals(
      synced.length,
      1,
      `only the sync under way starts: ${synced.join(", ")}`,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(
        result.value.synced,
        1,
        "the sync that was under way completed and is counted as synced",
      );
      assertEquals(result.value.failed, 0);
    }
    const lines = targetLines(log);
    assertEquals(lines.length, 1, log.join("\n"));
    assertEquals(
      stopLines(log).length,
      1,
      `with a cursor set, the stop logs one line in all: ${log.join("\n")}`,
    );
    const notStarted = synced.length === 1 &&
      !lines[0]!.includes(`'${synced[0]!.split("|")[1]}'`);
    assert(
      notStarted,
      "the line names the milestone that was not started, not the one synced",
    );
    const cursor = await loadSyncCursor(milestoneSyncCursorPath(dir));
    assertEquals(
      cursor?.repo,
      "owner/alpha",
      "the next pass resumes at this repository",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Control for the suppression above: a #2215 budget stop, with a cursor set,
// is not a target stop, so it keeps both its line and the pass-incomplete
// line. The budget stop itself is covered by milestone_sync_budget_cursor_2215_test.ts.
Deno.test("syncMilestoneBranches - a budget stop with a cursor still logs the pass-incomplete line, and no target line (Issue #4243 control, Issue #2215)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4243-budget-" });
  try {
    const synced: string[] = [];
    const log: string[] = [];
    const ghCalls: string[] = [];
    // The target is an hour off, so only the handler budget can stop the pass.
    const result = await withRunTarget(() =>
      syncMilestoneBranches(fleetDeps({
        dir,
        nowMs: STARTED_MS,
        deadlineEpochMs: STARTED_MS + 1000,
        milestones: {
          "owner/alpha": ["#1 alpha one"],
        },
        synced,
        log,
        ghCalls,
      }))
    );

    assertEquals(synced.length, 0, synced.join(", "));
    assertEquals(targetLines(log).length, 0, log.join("\n"));
    assertEquals(
      log.filter((l) => l.includes("Milestone sync stopped")).length,
      1,
      log.join("\n"),
    );
    assertEquals(
      log.filter((l) => l.includes("Milestone sync pass incomplete")).length,
      1,
      log.join("\n"),
    );
    assertEquals(result.ok, true);
    const cursor = await loadSyncCursor(milestoneSyncCursorPath(dir));
    assertEquals(
      cursor?.repo,
      "owner/alpha",
      "the next pass resumes at the repository the budget stopped",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - before the run target every repository is synced and no target line is logged (Issue #4243 control)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-4243-before-" });
  try {
    const synced: string[] = [];
    const log: string[] = [];
    const ghCalls: string[] = [];
    const result = await withRunTarget(() =>
      syncMilestoneBranches(fleetDeps({
        dir,
        nowMs: STARTED_MS,
        milestones: {
          "owner/alpha": ["#1 alpha one"],
          "owner/beta": ["#1 beta one"],
        },
        synced,
        log,
        ghCalls,
      }))
    );

    assertEquals(synced.length, 2, synced.join(", "));
    assertEquals(targetLines(log).length, 0, log.join("\n"));
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.synced, 2);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// In-cycle milestone sync on an auto-merge PR (Issue #4243)
// ---------------------------------------------------------------------------

const BEHIND_ONCE = {
  decision: "defer" as const,
  reason: "milestone-behind" as const,
  milestoneBranch: "milestone/1730-sync",
  behindBy: 1,
  detail: "milestone/1730-sync is 1 commit behind Develop",
};

Deno.test("enableAutoMerge - past the run target the sweep's in-cycle sync is not called when deferred, one line is logged, and the child is still armed (Issue #4243)", async () => {
  resetBehindSyncComments();
  _resetBaseProtectionMemo();
  const logs: string[] = [];
  const comments: string[] = [];
  let hookCalls = 0;
  let autoCalls = 0;
  const result = await withRunTarget(() =>
    enableAutoMerge({
      repo: "owner/repo",
      prNumber: 61,
      headRefName: "issue-61-child",
      baseRefName: "milestone/1730-sync",
      now: () => TARGET_MS + 1,
      deferSyncPastRunTarget: true,
      isBaseProtectedFn: async () => true,
      decideMilestoneBaseFn: () => Promise.resolve(BEHIND_ONCE),
      syncBehindMilestone: () => {
        hookCalls++;
        return Promise.resolve({
          status: "synced" as const,
          detail: "merged default down",
        });
      },
      commentFn: async (_r, _n, body) => {
        comments.push(body);
      },
      log: (m) => logs.push(m),
      ghCommandFn: async (args) => {
        if (args.includes("--auto")) autoCalls++;
        return "";
      },
    })
  );

  assertEquals(hookCalls, 0, "no new in-cycle sync starts past the target");
  assertEquals(targetLines(logs).length, 1, logs.join("\n"));
  assert(
    targetLines(logs)[0]!.includes(
      "In-cycle milestone sync deferred for owner/repo#61",
    ),
    logs.join("\n"),
  );
  // The arming outcome is the one an ordinary deferred sync produces (#2460).
  assertEquals(result.result, AutoMergeResult.Enabled);
  assertEquals(result.deferral, "milestone-behind");
  assertEquals(autoCalls, 1, "the behind child is still armed");
  assertEquals(comments.length, 1);
  assert(comments[0]!.includes(MILESTONE_BEHIND_SYNC_MARKER));
  assert(comments[0]!.includes("Auto-merge is armed anyway"));
  assert(
    comments[0]!.includes(
      "the run target has passed; deferred to the next cycle",
    ),
    comments[0],
  );
});

Deno.test("enableAutoMerge - past the run target without the defer flag (the issue-run completion case) the in-cycle sync is still called once and no target line is logged (Issue #4243)", async () => {
  resetBehindSyncComments();
  _resetBaseProtectionMemo();
  const logs: string[] = [];
  const comments: string[] = [];
  let hookCalls = 0;
  let autoCalls = 0;
  const result = await withRunTarget(() =>
    enableAutoMerge({
      repo: "owner/repo",
      prNumber: 63,
      headRefName: "issue-63-child",
      baseRefName: "milestone/1730-sync",
      now: () => TARGET_MS + 1,
      isBaseProtectedFn: async () => true,
      decideMilestoneBaseFn: () => Promise.resolve(BEHIND_ONCE),
      syncBehindMilestone: () => {
        hookCalls++;
        return Promise.resolve({
          status: "deferred" as const,
          detail: "unresolved conflict on src/bar.ts",
        });
      },
      commentFn: async (_r, _n, body) => {
        comments.push(body);
      },
      log: (m) => logs.push(m),
      ghCommandFn: async (args) => {
        if (args.includes("--auto")) autoCalls++;
        return "";
      },
    })
  );

  // An issue run completing its already-claimed PR syncs past the target.
  assertEquals(hookCalls, 1, "the completion sync is not gated by the target");
  assertEquals(targetLines(logs).length, 0, logs.join("\n"));
  assertEquals(result.result, AutoMergeResult.Enabled);
  assertEquals(autoCalls, 1);
  assertEquals(comments.length, 1);
  assert(comments[0]!.includes("unresolved conflict on src/bar.ts"));
});

Deno.test("enableAutoMerge - before the run target the in-cycle sync is called once and no target line is logged (Issue #4243 control)", async () => {
  resetBehindSyncComments();
  _resetBaseProtectionMemo();
  const logs: string[] = [];
  const comments: string[] = [];
  let hookCalls = 0;
  let autoCalls = 0;
  const result = await withRunTarget(() =>
    enableAutoMerge({
      repo: "owner/repo",
      prNumber: 62,
      headRefName: "issue-62-child",
      baseRefName: "milestone/1730-sync",
      now: () => TARGET_MS - 1,
      isBaseProtectedFn: async () => true,
      decideMilestoneBaseFn: () => Promise.resolve(BEHIND_ONCE),
      syncBehindMilestone: () => {
        hookCalls++;
        return Promise.resolve({
          status: "deferred" as const,
          detail: "unresolved conflict on src/foo.ts",
        });
      },
      commentFn: async (_r, _n, body) => {
        comments.push(body);
      },
      log: (m) => logs.push(m),
      ghCommandFn: async (args) => {
        if (args.includes("--auto")) autoCalls++;
        return "";
      },
    })
  );

  assertEquals(hookCalls, 1, "the in-cycle sync is called before the target");
  assertEquals(targetLines(logs).length, 0, logs.join("\n"));
  assertEquals(result.result, AutoMergeResult.Enabled);
  assertEquals(autoCalls, 1);
  assertEquals(comments.length, 1);
  assert(comments[0]!.includes("unresolved conflict on src/foo.ts"));
});
