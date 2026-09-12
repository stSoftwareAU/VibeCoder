/**
 * The pre-cut milestone sync a child issue run performs (Issue #1780).
 *
 * Every test drives the real helper with injected git work and a real ledger
 * file, and asserts on what it returned and on what the ledger holds
 * afterwards — the two things the child run and the periodic sweep both act
 * on.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  MILESTONE_BEHIND_DEFER_REASON,
  milestonePacedUntil,
  presyncMilestoneBranch,
  presyncMilestoneOnceForArming,
  resetMilestoneArmSyncMemo,
} from "../lib/milestone_presync.ts";
import type { MilestonePresyncDeps } from "../lib/milestone_presync.ts";
import {
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  milestoneSyncStreakPath,
  saveSyncStreaks,
  type SyncStreaks,
} from "../lib/milestone_sync_streak.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import type { MilestoneSyncConflict } from "../lib/milestone_sync_conflict.ts";
import type { IssueRunPresyncArgs } from "../lib/milestone_presync.ts";
import { presyncMilestoneBranchForIssueRun } from "../lib/milestone_presync.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Logger, Result } from "../types.ts";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

const REPO = "owner/repo";
const MILESTONE = "milestone/1730-resolve-merge-conflicts";
const DEFAULT_BRANCH = "main";
const KEY = `${REPO}|${MILESTONE}`;
const NOW = Date.parse("2026-09-10T12:00:00.000Z");

/** A ledger file in a temp work directory, cleaned up by the caller. */
async function ledger(entries: SyncStreaks = {}): Promise<{
  path: string;
  workDir: string;
  cleanup: () => Promise<void>;
}> {
  const workDir = await Deno.makeTempDir({ prefix: "issue-1780-ledger-" });
  const path = milestoneSyncStreakPath(workDir);
  if (Object.keys(entries).length > 0) await saveSyncStreaks(path, entries);
  return {
    path,
    workDir,
    cleanup: () => Deno.remove(workDir, { recursive: true }).catch(() => {}),
  };
}

/** Injected git work: behind by `behindBy`, sync answers `sync`. */
function deps(overrides: Partial<MilestonePresyncDeps> & {
  behindBy?: number;
  syncCalls?: string[];
} = {}): MilestonePresyncDeps & { logs: string[] } {
  const logs: string[] = [];
  const behindBy = overrides.behindBy ?? 2;
  return {
    logs,
    countBehind: overrides.countBehind ??
      (() => Promise.resolve({ ok: true as const, value: behindBy })),
    defaultTipSha: overrides.defaultTipSha ??
      (() => Promise.resolve({ ok: true as const, value: "d".repeat(40) })),
    milestoneTipSha: overrides.milestoneTipSha ??
      (() => Promise.resolve({ ok: true as const, value: "m".repeat(40) })),
    syncBranch: overrides.syncBranch ??
      (() =>
        Promise.resolve({ ok: true as const, value: { message: "merged" } })),
    ...(overrides.reportConflict
      ? { reportConflict: overrides.reportConflict }
      : {}),
    log: (message: string) => logs.push(message),
  };
}

// ---------------------------------------------------------------------------
// Level — the sub-second ordinary path
// ---------------------------------------------------------------------------

Deno.test("presyncMilestoneBranch - a level branch runs no merge and touches no ledger", async () => {
  const fx = await ledger();
  try {
    let synced = 0;
    const d = deps({
      behindBy: 0,
      syncBranch: () => {
        synced++;
        return Promise.resolve({ ok: true as const, value: { message: "x" } });
      },
    });
    const result = await presyncMilestoneBranch({
      repo: REPO,
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      streakPath: fx.path,
      grant: { agentAllowed: true },
      nowMs: NOW,
    }, d);

    assertEquals(result.status, "level");
    assertEquals(result.behindBy, 0);
    assertEquals(synced, 0, "a level branch must not be merged into");
    assertEquals(await loadSyncStreaks(fx.path), {});
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Behind and the sync lands
// ---------------------------------------------------------------------------

Deno.test("presyncMilestoneBranch - a behind branch is synced and the new tip reported", async () => {
  const fx = await ledger();
  try {
    const grants: boolean[] = [];
    const d = deps({
      behindBy: 3,
      syncBranch: (grant) => {
        grants.push(grant.agentAllowed);
        return Promise.resolve({
          ok: true as const,
          value: { message: "Merged main into milestone" },
        });
      },
      milestoneTipSha: () =>
        Promise.resolve({ ok: true as const, value: "a".repeat(40) }),
    });
    const result = await presyncMilestoneBranch({
      repo: REPO,
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      streakPath: fx.path,
      grant: { agentAllowed: true },
      nowMs: NOW,
    }, d);

    assertEquals(result.status, "synced");
    assertEquals(result.behindBy, 3);
    // The tip the child branch is cut from, after the merge landed.
    assertEquals(result.baseSha, "a".repeat(40));
    assertEquals(grants, [true]);

    // Success refills the budget and records the tip the branch now carries.
    const entry = (await loadSyncStreaks(fx.path))[KEY];
    assert(entry, "a successful sync records the tip it synced against");
    assertEquals(entry.conflictAttempts, 0);
    assertEquals(entry.attemptOpenedAt, undefined);
    assertEquals(entry.deferUntil, undefined);
    assertEquals(entry.lastSyncedDefaultSha, "d".repeat(40));
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - a spent conflict budget is refilled by a later success", async () => {
  const fx = await ledger({
    [KEY]: { count: 1, escalated: false, conflictAttempts: 2 },
  });
  try {
    const result = await presyncMilestoneBranch({
      repo: REPO,
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      streakPath: fx.path,
      grant: { agentAllowed: true },
      nowMs: NOW,
    }, deps());

    assertEquals(result.status, "synced");
    assertEquals((await loadSyncStreaks(fx.path))[KEY]?.conflictAttempts, 0);
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Behind and the sync fails — one charge, and the branch is paced
// ---------------------------------------------------------------------------

Deno.test("presyncMilestoneBranch - an unresolved conflict charges exactly one attempt and paces the branch", async () => {
  const fx = await ledger();
  try {
    const conflict = new MilestoneConflictEscalation(
      "lib/foo.ts: neither rung could settle it",
      [{
        path: "lib/foo.ts",
        // The rung prefix is how `failedConflictRung` reads how far the
        // ladder got — the agent tried and gave up.
        reason: "agent: could not settle the collision",
        oursExports: [],
        theirsExports: [],
        oursTests: [],
        theirsTests: [],
        onlyOursTests: [],
        onlyTheirsTests: [],
      }],
      [],
      "d".repeat(40),
      undefined,
      "b".repeat(40),
    );
    const result = await presyncMilestoneBranch(
      {
        repo: REPO,
        milestoneBranch: MILESTONE,
        defaultBranch: DEFAULT_BRANCH,
        streakPath: fx.path,
        grant: { agentAllowed: true },
        nowMs: NOW,
      },
      deps({
        behindBy: 4,
        syncBranch: () =>
          Promise.resolve({ ok: false as const, error: conflict }),
      }),
    );

    assertEquals(result.status, "deferred");
    assertStringIncludes(result.detail, MILESTONE_BEHIND_DEFER_REASON);
    assertStringIncludes(result.detail, "(4 commits)");
    assertStringIncludes(result.detail, "conflict attempt 1 of");

    const entry = (await loadSyncStreaks(fx.path))[KEY];
    assert(entry);
    assertEquals(entry.conflictAttempts, 1, "charged exactly once");
    assertEquals(entry.attemptOpenedAt, undefined, "the marker is closed");
    assert(entry.deferUntil, "a charged failure paces the branch");
    assert(
      Date.parse(entry.deferUntil) > NOW,
      "the deferral must be in the future",
    );
    assertEquals(entry.lastAttempt?.outcome, "failed");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - a non-conflict git failure defers without charging", async () => {
  const fx = await ledger();
  try {
    const result = await presyncMilestoneBranch(
      {
        repo: REPO,
        milestoneBranch: MILESTONE,
        defaultBranch: DEFAULT_BRANCH,
        streakPath: fx.path,
        grant: { agentAllowed: true },
        nowMs: NOW,
      },
      deps({
        syncBranch: () =>
          Promise.resolve({
            ok: false as const,
            error: new Error("fatal: could not read from remote"),
          }),
      }),
    );

    assertEquals(result.status, "deferred");
    assertStringIncludes(result.detail, "not charged");
    const entry = (await loadSyncStreaks(fx.path))[KEY];
    assertEquals(entry?.conflictAttempts, 0);
    assertEquals(entry?.lastAttempt?.outcome, "not-charged");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - a merge that landed on a resolved conflict is reported once", async () => {
  const fx = await ledger();
  try {
    const reported: string[] = [];
    const conflict: MilestoneSyncConflict = {
      files: ["lib/foo.ts"],
      defaultSha: "d".repeat(40),
      milestoneSha: "b".repeat(40),
      resolution: "auto",
    };
    const request = {
      repo: REPO,
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      streakPath: fx.path,
      grant: { agentAllowed: true },
      nowMs: NOW,
    };
    const d = deps({
      syncBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: { message: "merged with a resolved conflict", conflict },
        }),
      reportConflict: (c) => {
        reported.push(c.defaultSha);
        return Promise.resolve(true);
      },
    });

    assertEquals((await presyncMilestoneBranch(request, d)).status, "synced");
    assertEquals(reported, ["d".repeat(40)]);
    // The conflicting commit is remembered, so the same one is not reported
    // again — by this run, or by the periodic sweep.
    assertEquals(
      (await loadSyncStreaks(fx.path))[KEY]?.conflictEscalatedSha,
      "d".repeat(40),
    );

    // A second run against the same conflicting commit reports nothing.
    assertEquals((await presyncMilestoneBranch(request, d)).status, "synced");
    assertEquals(reported.length, 1);

    // And it is never silent: the log names the conflict either way.
    assert(
      d.logs.some((line) => line.includes("resolved a conflict itself")),
      `the conflict is said out loud; logs were: ${d.logs.join(" | ")}`,
    );
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The ledger holds the branch back
// ---------------------------------------------------------------------------

Deno.test("presyncMilestoneBranch - a live deferral defers without attempting a merge", async () => {
  const deferUntil = new Date(NOW + 3600_000).toISOString();
  const fx = await ledger({
    [KEY]: {
      count: 1,
      escalated: false,
      conflictAttempts: 1,
      deferUntil,
      lastAttempt: {
        at: new Date(NOW - 60_000).toISOString(),
        outcome: "failed",
        reason: "conflict unresolved at rung agent",
        defaultSha: "d".repeat(40),
      },
    },
  });
  try {
    let synced = 0;
    const result = await presyncMilestoneBranch(
      {
        repo: REPO,
        milestoneBranch: MILESTONE,
        defaultBranch: DEFAULT_BRANCH,
        streakPath: fx.path,
        grant: { agentAllowed: true },
        nowMs: NOW,
      },
      deps({
        syncBranch: () => {
          synced++;
          return Promise.resolve({
            ok: true as const,
            value: { message: "x" },
          });
        },
      }),
    );

    assertEquals(result.status, "deferred");
    assertEquals(synced, 0, "a paced branch is not merged into again");
    assertStringIncludes(result.detail, `not due until ${deferUntil}`);
    assertEquals((await loadSyncStreaks(fx.path))[KEY]?.conflictAttempts, 1);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - a spent budget defers to the roll-back rather than merging", async () => {
  const fx = await ledger({
    [KEY]: {
      count: 3,
      escalated: false,
      conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET,
    },
  });
  try {
    let synced = 0;
    const result = await presyncMilestoneBranch(
      {
        repo: REPO,
        milestoneBranch: MILESTONE,
        defaultBranch: DEFAULT_BRANCH,
        streakPath: fx.path,
        grant: { agentAllowed: true },
        nowMs: NOW,
      },
      deps({
        syncBranch: () => {
          synced++;
          return Promise.resolve({
            ok: true as const,
            value: { message: "x" },
          });
        },
      }),
    );

    assertEquals(result.status, "deferred");
    assertEquals(synced, 0);
    assertStringIncludes(result.detail, "conflict budget is spent");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - an attempt a previous run left open concludes disrupted, not charged", async () => {
  const fx = await ledger({
    [KEY]: {
      count: 0,
      escalated: false,
      attemptOpenedAt: new Date(NOW - 600_000).toISOString(),
    },
  });
  try {
    const result = await presyncMilestoneBranch({
      repo: REPO,
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      streakPath: fx.path,
      grant: { agentAllowed: true },
      nowMs: NOW,
    }, deps());

    assertEquals(result.status, "synced");
    const entry = (await loadSyncStreaks(fx.path))[KEY];
    assertEquals(entry?.conflictAttempts, 0, "a disrupted attempt is free");
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// An unverifiable base is never cut from
// ---------------------------------------------------------------------------

Deno.test("presyncMilestoneBranch - a behind count that cannot be read defers rather than cutting", async () => {
  const fx = await ledger();
  try {
    let synced = 0;
    const result = await presyncMilestoneBranch(
      {
        repo: REPO,
        milestoneBranch: MILESTONE,
        defaultBranch: DEFAULT_BRANCH,
        streakPath: fx.path,
        grant: { agentAllowed: true },
        nowMs: NOW,
      },
      deps({
        countBehind: () =>
          Promise.resolve({
            ok: false as const,
            error: new Error("unknown revision origin/milestone/1730"),
          }),
        syncBranch: () => {
          synced++;
          return Promise.resolve({
            ok: true as const,
            value: { message: "x" },
          });
        },
      }),
    );

    assertEquals(result.status, "deferred");
    assertEquals(synced, 0);
    assertStringIncludes(result.detail, "could not be read");
    assertStringIncludes(result.detail, "unverified base");
    assertEquals(await loadSyncStreaks(fx.path), {});
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - the default tip is read (and so fetched) before the branch is measured", async () => {
  // Order is load-bearing: reading the tip is what fetches `origin/<default>`,
  // and counting against a stale one would answer "level" for a branch that is
  // behind — the defect this gate exists to stop.
  const calls: string[] = [];
  const fx = await ledger();
  try {
    const result = await presyncMilestoneBranch(
      {
        repo: REPO,
        milestoneBranch: MILESTONE,
        defaultBranch: DEFAULT_BRANCH,
        streakPath: fx.path,
        grant: { agentAllowed: true },
        nowMs: NOW,
      },
      deps({
        behindBy: 0,
        defaultTipSha: () => {
          calls.push("defaultTipSha");
          return Promise.resolve({ ok: true as const, value: "d".repeat(40) });
        },
        countBehind: () => {
          calls.push("countBehind");
          return Promise.resolve({ ok: true as const, value: 0 });
        },
      }),
    );

    assertEquals(result.status, "level");
    assertEquals(calls, ["defaultTipSha", "countBehind"]);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - a landed sync ends the failure streak and its escalation flags", async () => {
  // The sweep's own `recordSuccess` transition, not a second one: a branch that
  // has synced must not keep a stale streak count or a spent escalation flag.
  const fx = await ledger({
    [KEY]: {
      count: 2,
      escalated: true,
      gateEscalated: true,
      analysisEscalatedSha: "c".repeat(40),
      conflictAttempts: 1,
    },
  });
  try {
    const result = await presyncMilestoneBranch({
      repo: REPO,
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      streakPath: fx.path,
      grant: { agentAllowed: true },
      nowMs: NOW,
    }, deps());

    assertEquals(result.status, "synced");
    const entry = (await loadSyncStreaks(fx.path))[KEY];
    assert(entry);
    assertEquals(entry.count, 0);
    assertEquals(entry.escalated, false);
    assertEquals(entry.gateEscalated, false);
    assertEquals(entry.analysisEscalatedSha, undefined);
    assertEquals(entry.conflictAttempts, 0);
    assertEquals(entry.lastSyncedDefaultSha, "d".repeat(40));
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - a ledger that cannot be written still syncs, loudly", async () => {
  // A directory nothing can be written into stands in for an unwritable
  // ledger: the merge is the useful work, so it still runs, but the run must
  // say the attempt cannot be charged or paced rather than pass in silence.
  const d = deps({ behindBy: 2 });
  const result = await presyncMilestoneBranch({
    repo: REPO,
    milestoneBranch: MILESTONE,
    defaultBranch: DEFAULT_BRANCH,
    streakPath: "/proc/definitely-not-writable/milestone_sync_failures.json",
    grant: { agentAllowed: true },
    nowMs: NOW,
  }, d);

  assertEquals(result.status, "synced");
  assert(
    d.logs.some((line) =>
      line.includes("could not be written") &&
      line.includes("cannot be charged or paced")
    ),
    `the write failure is reported; logs were: ${d.logs.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// Two lanes, one shared clone
// ---------------------------------------------------------------------------

Deno.test("presyncMilestoneBranchForIssueRun - two runs on one repository do not merge at the same time", async () => {
  // The merge resets and checks the shared clone out, so two lanes overlapping
  // in it would reset the tree under each other's merge. The chain makes the
  // second wait; `overlapped` proves it never ran inside the first.
  const workDir = await Deno.makeTempDir({ prefix: "issue-1780-serial-" });
  try {
    let inFlight = 0;
    let overlapped = false;
    let entries = 0;
    const release: Array<() => void> = [];
    // Promise ordering, not timing: each merge announces that it started, so
    // the test never sleeps or polls.
    const entered: Array<() => void> = [];
    const hasEntered = [0, 1].map(() =>
      new Promise<void>((resolve) => entered.push(resolve))
    );
    const syncFn = () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      entered[entries++]?.();
      return new Promise<Result<{ message: string }>>((resolve) => {
        release.push(() => {
          inFlight--;
          resolve({ ok: true as const, value: { message: "merged" } });
        });
      });
    };
    const args = {
      repo: REPO,
      milestoneTitle: "#1730 Resolve merge conflicts",
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      cwd: workDir,
      workDir,
      config: { ...buildDefaultWorkerConfig(), workDir },
      logger: silentLogger,
      countCommitsAheadFn: () =>
        Promise.resolve({ ok: true as const, value: 2 }),
      syncMilestoneBranchFn: syncFn as unknown as IssueRunPresyncArgs[
        "syncMilestoneBranchFn"
      ],
      runGitCommandFn: () =>
        Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: "a".repeat(40), stderr: "" },
        }),
    } satisfies IssueRunPresyncArgs;

    const first = presyncMilestoneBranchForIssueRun(args);
    const second = presyncMilestoneBranchForIssueRun(args);

    await hasEntered[0];
    assertEquals(release.length, 1, "only one merge is in flight");
    release[0]!();
    assertEquals((await first).status, "synced");
    await hasEntered[1];
    release[1]!();
    assertEquals((await second).status, "synced");
    assertEquals(overlapped, false);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// The selector's read of the same ledger
// ---------------------------------------------------------------------------

Deno.test("milestonePacedUntil - reports a live deferral for the milestone's branch", () => {
  const deferUntil = new Date(NOW + 60_000).toISOString();
  const streaks: SyncStreaks = {
    "owner/repo|milestone/1730-resolve-merge-conflicts": {
      count: 1,
      escalated: false,
      deferUntil,
    },
  };
  assertEquals(
    milestonePacedUntil(
      streaks,
      "owner/repo",
      "#1730 Resolve merge conflicts",
      NOW,
    ),
    deferUntil,
  );
});

Deno.test("milestonePacedUntil - a passed deferral, a missing entry and no milestone all pace nothing", () => {
  const passed: SyncStreaks = {
    "owner/repo|milestone/1730-resolve-merge-conflicts": {
      count: 1,
      escalated: false,
      deferUntil: new Date(NOW - 1000).toISOString(),
    },
  };
  assertEquals(
    milestonePacedUntil(
      passed,
      "owner/repo",
      "#1730 Resolve merge conflicts",
      NOW,
    ),
    undefined,
  );
  assertEquals(
    milestonePacedUntil({}, "owner/repo", "#1730 X", NOW),
    undefined,
  );
  assertEquals(milestonePacedUntil(passed, "owner/repo", "", NOW), undefined);
});

Deno.test("presyncMilestoneOnceForArming - two PRs on one milestone share a single attempt (Issue #2005)", async () => {
  resetMilestoneArmSyncMemo();
  const workDir = await Deno.makeTempDir({ prefix: "issue-2005-memo-" });
  try {
    let syncs = 0;
    const args = {
      repo: REPO,
      milestoneTitle: "#1730 Resolve merge conflicts",
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      cwd: workDir,
      workDir,
      config: { ...buildDefaultWorkerConfig(), workDir },
      logger: silentLogger,
      countCommitsAheadFn: () =>
        Promise.resolve({ ok: true as const, value: 2 }),
      syncMilestoneBranchFn: (() => {
        syncs++;
        return Promise.resolve({
          ok: true as const,
          value: { message: "merged" },
        });
      }) as unknown as IssueRunPresyncArgs["syncMilestoneBranchFn"],
      runGitCommandFn: () =>
        Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: "a".repeat(40), stderr: "" },
        }),
    } satisfies IssueRunPresyncArgs;

    const first = await presyncMilestoneOnceForArming(args);
    const second = await presyncMilestoneOnceForArming(args);
    assertEquals(first.status, "synced");
    assertEquals(second.status, "synced");
    assertEquals(syncs, 1, "the sweep memoises one sync per milestone");
    resetMilestoneArmSyncMemo();
    const third = await presyncMilestoneOnceForArming(args);
    assertEquals(third.status, "synced");
    assertEquals(syncs, 2, "a new cycle may try again");
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("milestonePacedUntil - an unparseable deferral paces the branch rather than releasing it", () => {
  const streaks: SyncStreaks = {
    "owner/repo|milestone/1730-resolve-merge-conflicts": {
      count: 1,
      escalated: false,
      deferUntil: "not-a-date",
    },
  };
  assertEquals(
    milestonePacedUntil(
      streaks,
      "owner/repo",
      "#1730 Resolve merge conflicts",
      NOW,
    ),
    "not-a-date",
  );
});
