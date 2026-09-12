/**
 * Tests for the milestone-sync failure-streak escalation (Issue #4260,
 * proposal 2). A branch that fails to sync for the threshold number of
 * consecutive cycles gets one needs-human comment on its tracking issue;
 * a success clears the streak.
 *
 * Issue #1766 adds the per-branch conflict attempt ledger: a budget of
 * concluded failures, a deferral that paces retries on an unmoved default
 * tip, and a reset that only a successful sync performs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  concludeConflictAttempt,
  isConflictAttemptDue,
  isConflictBudgetExhausted,
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  milestoneSyncStreakPath,
  openConflictAttempt,
  recordDefaultSha,
  resetConflictLedgerOnSuccess,
  saveSyncStreaks,
  type SyncStreakEntry,
  trackingIssueFromMilestoneTitle,
} from "../lib/milestone_sync_streak.ts";
import {
  DEFAULT_CONFLICT_COOLDOWN_HOURS,
  DEFAULT_MAX_CONFLICT_ATTEMPTS,
} from "../lib/pr_merge_conflict_scan.ts";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";

Deno.test("trackingIssueFromMilestoneTitle - reads the leading #N (Issue #4260)", () => {
  assertEquals(
    trackingIssueFromMilestoneTitle("#3648 Learn stage fails"),
    3648,
  );
  assertEquals(trackingIssueFromMilestoneTitle("  #42 spaced"), 42);
  assertEquals(trackingIssueFromMilestoneTitle("no number here"), null);
  assertEquals(trackingIssueFromMilestoneTitle("mid #99 not leading"), null);
});

Deno.test("sync streaks - a corrupt file reads as empty (Issue #4260)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = milestoneSyncStreakPath(dir);
    await Deno.writeTextFile(path, "{not json");
    assertEquals(await loadSyncStreaks(path), {});
    await saveSyncStreaks(path, {
      "o/r|milestone/x": { count: 2, escalated: false },
    });
    const back = await loadSyncStreaks(path);
    assertEquals(back["o/r|milestone/x"]?.count, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Build sync deps that always fail the sync, recording gh calls. */
function failingSyncDeps(
  streakPath: string,
  calls: string[][],
): MilestoneBranchSyncDeps {
  return {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      calls.push(args);
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(
          JSON.stringify([{ title: "#77 Stuck milestone", number: 1 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("issue list") && key.includes("--state closed")) {
        return Promise.resolve(
          JSON.stringify([{
            number: 10,
            title: "t",
            milestone: { title: "#77 Stuck milestone" },
          }]),
        );
      }
      if (key.includes("branches/milestone")) {
        return Promise.resolve("milestone/77-stuck-milestone");
      }
      if (key.includes("compare/")) return Promise.resolve("3 ahead, 5 behind");
      return Promise.resolve("");
    },
    syncBranchFn: () =>
      Promise.resolve({
        ok: false as const,
        error: new Error("refusing to merge unrelated histories"),
      }),
    log: () => undefined,
    streakPath,
  };
}

Deno.test("sync streaks - escalates once at the threshold, then not again (Issue #4260)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const commentCalls: string[][] = [];

    for (
      let cycle = 1;
      cycle <= MILESTONE_SYNC_ESCALATION_THRESHOLD + 2;
      cycle++
    ) {
      const calls: string[][] = [];
      await syncMilestoneBranches(failingSyncDeps(streakPath, calls));
      for (const c of calls) {
        if (c[0] === "issue" && c[1] === "comment") commentCalls.push(c);
      }
    }

    assertEquals(
      commentCalls.length,
      1,
      "exactly one needs-human comment across many failing cycles",
    );
    const commentArgs = commentCalls[0]!;
    assertStringIncludes(commentArgs.join(" "), "77"); // tracking issue #77
    const commentBody = commentArgs[commentArgs.length - 1] ?? "";
    assertStringIncludes(commentBody, "unrelated histories");
    assertStringIncludes(commentBody, "3 ahead, 5 behind");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sync streaks - a success clears the streak so it can re-escalate later (Issue #4260)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    // Drive it to escalation.
    for (let i = 0; i < MILESTONE_SYNC_ESCALATION_THRESHOLD; i++) {
      await syncMilestoneBranches(failingSyncDeps(streakPath, []));
    }
    let streaks = await loadSyncStreaks(streakPath);
    assert(streaks["owner/repo|milestone/77-stuck-milestone"]?.escalated);

    // Now a success clears it.
    const okDeps = failingSyncDeps(streakPath, []);
    okDeps.syncBranchFn = () =>
      Promise.resolve({ ok: true as const, value: { message: "synced" } });
    await syncMilestoneBranches(okDeps);
    streaks = await loadSyncStreaks(streakPath);
    // Issue #1778 changed what survives a success: the failure streak and its
    // escalation flag are cleared as before, and the ledger's `lastAttempt`
    // audit record is kept, so the entry itself now outlives the streak.
    const cleared = streaks["owner/repo|milestone/77-stuck-milestone"];
    assertEquals(cleared?.count, 0, "a successful sync clears the streak");
    assertEquals(cleared?.escalated, false, "and it can escalate again later");
    assertEquals(cleared?.conflictAttempts, 0, "and the budget is refilled");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sync streaks - no streakPath means no tracking and no comment (Issue #4260)", async () => {
  const calls: string[][] = [];
  const deps = failingSyncDeps("/unused", calls);
  delete deps.streakPath;
  for (let i = 0; i < MILESTONE_SYNC_ESCALATION_THRESHOLD + 1; i++) {
    await syncMilestoneBranches(deps);
  }
  assertEquals(
    calls.filter((c) => c[0] === "issue" && c[1] === "comment").length,
    0,
    "without a streak path nothing is tracked or escalated",
  );
});

// ---------------------------------------------------------------------------
// Per-branch conflict attempt ledger (Issue #1766)
// ---------------------------------------------------------------------------

Deno.test("conflict ledger - the budget is the one the PR ladder spends (Issue #1766)", () => {
  assertEquals(
    MILESTONE_CONFLICT_ATTEMPT_BUDGET,
    DEFAULT_MAX_CONFLICT_ATTEMPTS,
  );
  assertEquals(MILESTONE_CONFLICT_ATTEMPT_BUDGET, 3);
});

Deno.test("conflict ledger - only a concluded failure is charged (Issue #1766)", () => {
  let entry: SyncStreakEntry = { count: 0, escalated: false };

  entry = openConflictAttempt(entry, Date.parse("2026-09-09T00:00:00Z"));
  assertEquals(entry.conflictAttempts ?? 0, 0, "opening charges nothing");
  assertEquals(entry.attemptOpenedAt, "2026-09-09T00:00:00.000Z");

  entry = concludeConflictAttempt(
    entry,
    "failed",
    "both sides rewrote the same file",
    "sha-x",
    Date.parse("2026-09-09T00:10:00Z"),
  );
  assertEquals(entry.conflictAttempts, 1);
  assertEquals(entry.attemptOpenedAt, undefined, "the open attempt is closed");
  assertEquals(entry.lastAttempt?.outcome, "failed");
  assertEquals(entry.lastAttempt?.defaultSha, "sha-x");
  assertStringIncludes(entry.lastAttempt?.reason ?? "", "same file");

  // A disrupted or not-charged conclusion leaves the budget alone.
  entry = openConflictAttempt(entry, Date.parse("2026-09-10T00:00:00Z"));
  entry = concludeConflictAttempt(
    entry,
    "disrupted",
    "run cut short by the cycle ending",
    "sha-x",
    Date.parse("2026-09-10T00:05:00Z"),
  );
  assertEquals(entry.conflictAttempts, 1, "a disrupted attempt is not charged");

  entry = openConflictAttempt(entry, Date.parse("2026-09-11T00:00:00Z"));
  entry = concludeConflictAttempt(
    entry,
    "not-charged",
    "the merge gate refused the push",
    "sha-x",
    Date.parse("2026-09-11T00:05:00Z"),
  );
  assertEquals(
    entry.conflictAttempts,
    1,
    "a not-charged attempt is not charged",
  );
});

Deno.test("conflict ledger - exhaustion counts concluded failures only (Issue #1766)", () => {
  const threeFailures: SyncStreakEntry = {
    count: 0,
    escalated: false,
    conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  };
  assert(isConflictBudgetExhausted(threeFailures));

  const twoFailuresOneOpen: SyncStreakEntry = {
    count: 0,
    escalated: false,
    conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET - 1,
    attemptOpenedAt: "2026-09-09T00:00:00.000Z",
  };
  assert(
    !isConflictBudgetExhausted(twoFailuresOneOpen),
    "an open, unconcluded attempt does not spend the budget",
  );

  assert(!isConflictBudgetExhausted({ count: 0, escalated: false }));
});

Deno.test("conflict ledger - a failure defers the same tip and not a moved one (Issue #1766)", () => {
  const failedAt = Date.parse("2026-09-09T00:00:00Z");
  const entry = concludeConflictAttempt(
    { count: 0, escalated: false },
    "failed",
    "conflict",
    "sha-x",
    failedAt,
  );
  assert(entry.deferUntil !== undefined, "a failure sets the cooldown");

  assert(
    !isConflictAttemptDue(entry, "sha-x", failedAt + 60_000),
    "not due again on the same tip inside the cooldown",
  );
  assert(
    isConflictAttemptDue(
      entry,
      "sha-x",
      failedAt + (DEFAULT_CONFLICT_COOLDOWN_HOURS + 1) * 3600_000,
    ),
    "due on the same tip once the cooldown has passed",
  );
  assert(
    isConflictAttemptDue(entry, "sha-y", failedAt + 60_000),
    "due immediately on a moved tip",
  );
  assert(
    isConflictAttemptDue({ count: 0, escalated: false }, "sha-x", failedAt),
    "a branch with no ledger is due",
  );
});

Deno.test("conflict ledger - a moved tip clears the deferral and zeroes the count (Issue #2016)", () => {
  const failedAt = Date.parse("2026-09-09T00:00:00Z");
  const failed = concludeConflictAttempt(
    { count: 0, escalated: false, conflictAttempts: 1 },
    "failed",
    "conflict",
    "sha-x",
    failedAt,
  );
  assertEquals(failed.conflictAttempts, 2);

  const moved = recordDefaultSha(failed, "sha-y");
  assertEquals(moved.lastSyncedDefaultSha, "sha-y");
  assertEquals(
    moved.conflictAttempts,
    0,
    "a moved tip zeroes the attempt count — the conflict is a new one",
  );
  assertEquals(moved.deferUntil, undefined, "a moved tip clears the deferral");

  // The unmoved tip is the case the pacing depends on: recording the tip the
  // attempt just failed against must leave the cooldown running, even on the
  // first recording, when `lastSyncedDefaultSha` is still unset.
  assertEquals(failed.lastSyncedDefaultSha, undefined);
  const same = recordDefaultSha(failed, "sha-x");
  assertEquals(same.conflictAttempts, 2);
  assertEquals(same.deferUntil, failed.deferUntil, "the cooldown still runs");
  assert(
    !isConflictAttemptDue(same, "sha-x", failedAt + 30_000),
    "an unmoved tip is not re-attempted 30 seconds later",
  );

  // And once the tip has been recorded, a later move clears it as before.
  const thenMoved = recordDefaultSha(same, "sha-y");
  assertEquals(thenMoved.deferUntil, undefined);
  assertEquals(thenMoved.conflictAttempts, 0);
});

Deno.test("conflict ledger - an uncharged conclusion on a moved tip clears the deferral (Issue #1766)", () => {
  const failedAt = Date.parse("2026-09-09T00:00:00Z");
  const failed = concludeConflictAttempt(
    { count: 0, escalated: false },
    "failed",
    "conflict",
    "sha-x",
    failedAt,
  );

  // Same tip: the cooldown set for it still stands.
  const stillX = concludeConflictAttempt(
    openConflictAttempt(failed, failedAt + 60_000),
    "disrupted",
    "the cycle ended",
    "sha-x",
    failedAt + 120_000,
  );
  assertEquals(stillX.deferUntil, failed.deferUntil);
  assert(!isConflictAttemptDue(stillX, "sha-x", failedAt + 180_000));

  // A different tip: the conflict being paced is not the one in front of the
  // branch any more, so the deferral goes even though nothing was charged.
  const onY = concludeConflictAttempt(
    openConflictAttempt(failed, failedAt + 60_000),
    "disrupted",
    "the cycle ended",
    "sha-y",
    failedAt + 120_000,
  );
  assertEquals(onY.deferUntil, undefined);
  assertEquals(onY.conflictAttempts, 0, "a moved tip zeroes the spent budget");
  assert(isConflictAttemptDue(onY, "sha-y", failedAt + 180_000));
});

Deno.test("conflict ledger - only success zeroes the ledger (Issue #1766)", () => {
  const spent: SyncStreakEntry = {
    count: 0,
    escalated: false,
    conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET,
    attemptOpenedAt: "2026-09-09T00:00:00.000Z",
    deferUntil: "2026-09-09T04:00:00.000Z",
    lastAttempt: {
      at: "2026-09-09T00:10:00.000Z",
      outcome: "failed",
      reason: "conflict",
      defaultSha: "sha-x",
    },
    lastSyncedDefaultSha: "sha-x",
    rollbacks: 2,
  };

  const reset = resetConflictLedgerOnSuccess(spent);
  assertEquals(reset.conflictAttempts, 0);
  assertEquals(reset.deferUntil, undefined);
  assertEquals(reset.attemptOpenedAt, undefined);
  assertEquals(
    reset.lastAttempt,
    spent.lastAttempt,
    "the audit record of the last attempt survives the reset",
  );
  assert(!isConflictBudgetExhausted(reset));
  assertEquals(reset.rollbacks, 2, "the lifetime rollback count survives");
  assertEquals(reset.lastSyncedDefaultSha, "sha-x");
});

Deno.test("conflict ledger - a pre-change streak file loads as zero attempts (Issue #1766)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = milestoneSyncStreakPath(dir);
    // Exactly the shape written before this change.
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        "o/r|milestone/x": {
          count: 2,
          escalated: true,
          gateEscalated: false,
          conflictEscalatedSha: "sha-old",
        },
      }),
    );
    const loaded = await loadSyncStreaks(path);
    const entry = loaded["o/r|milestone/x"];
    assert(entry, "the old entry still loads");
    assertEquals(entry.count, 2);
    assertEquals(entry.conflictEscalatedSha, "sha-old");
    assertEquals(entry.conflictAttempts ?? 0, 0);
    assertEquals(entry.attemptOpenedAt, undefined);
    assertEquals(entry.deferUntil, undefined);
    assert(!isConflictBudgetExhausted(entry));
    assert(isConflictAttemptDue(entry, "sha-any", Date.now()));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("conflict ledger - a malformed ledger field is never trusted (Issue #1766)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = milestoneSyncStreakPath(dir);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        "o/r|milestone/x": {
          count: 1,
          escalated: false,
          conflictAttempts: "two",
          attemptOpenedAt: 17,
          deferUntil: "not a timestamp",
          lastAttempt: { at: "2026-09-09T00:00:00.000Z", outcome: "invented" },
          rollbacks: "many",
        },
      }),
    );
    const entry = (await loadSyncStreaks(path))["o/r|milestone/x"];
    assert(entry, "the rest of the entry still loads");
    assertEquals(entry.count, 1);
    assertEquals(entry.conflictAttempts, undefined);
    assertEquals(entry.attemptOpenedAt, undefined);
    assertEquals(entry.rollbacks, undefined);
    assertEquals(
      entry.lastAttempt,
      undefined,
      "an outcome outside the three the ledger knows is not kept",
    );
    assertEquals(
      entry.deferUntil,
      "not a timestamp",
      "an unparseable deferral is kept, never read as 'no cooldown applies'",
    );
    assert(
      !isConflictAttemptDue(entry, "sha-x", Date.now()),
      "a corrupt persisted deferral holds the branch back",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("conflict ledger - a full ledger survives a save/load round trip (Issue #1766)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = milestoneSyncStreakPath(dir);
    const at = Date.parse("2026-09-09T00:00:00Z");
    let entry: SyncStreakEntry = { count: 1, escalated: false, rollbacks: 1 };
    entry = openConflictAttempt(entry, at);
    entry = concludeConflictAttempt(entry, "failed", "conflict", "sha-x", at);
    entry = recordDefaultSha(entry, "sha-x");
    // Re-open an attempt so the open marker and the live deferral — the two
    // fields a conclusion would otherwise have cleared — are both persisted.
    entry = openConflictAttempt(entry, at + 60_000);
    assert(
      entry.deferUntil !== undefined && entry.attemptOpenedAt !== undefined,
    );

    await saveSyncStreaks(path, { "o/r|milestone/x": entry });
    const back = (await loadSyncStreaks(path))["o/r|milestone/x"];
    assertEquals(
      back,
      // The loader normalises `gateEscalated` for every entry it reads.
      { ...entry, gateEscalated: false },
      "every ledger field round trips",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("conflict ledger - a corrupt deferUntil holds the branch back, not forward (Issue #1766)", () => {
  const entry: SyncStreakEntry = {
    count: 0,
    escalated: false,
    conflictAttempts: 1,
    deferUntil: "not a timestamp",
    lastAttempt: {
      at: "2026-09-09T00:00:00.000Z",
      outcome: "failed",
      reason: "conflict",
      defaultSha: "sha-x",
    },
  };
  assert(
    !isConflictAttemptDue(entry, "sha-x", Date.now()),
    "an unparseable deferral is treated as still running",
  );
  assert(
    isConflictAttemptDue(entry, "sha-y", Date.now()),
    "a moved tip is still due",
  );
});

Deno.test("conflict ledger - the first cycle-budget deferral is remembered (Issue #2016)", () => {
  const now = Date.parse("2026-09-12T00:00:00Z");
  const first = concludeConflictAttempt(
    { count: 0, escalated: false },
    "not-charged",
    "agent deferred: cycle budget",
    "sha-x",
    now,
  );
  assertEquals(first.agentDeferredSince, new Date(now).toISOString());
  assertEquals(first.conflictAttempts ?? 0, 0);

  const again = concludeConflictAttempt(
    first,
    "not-charged",
    "agent deferred: cycle budget",
    "sha-x",
    now + 3600_000,
  );
  assertEquals(
    again.agentDeferredSince,
    first.agentDeferredSince,
    "further deferrals keep the original timestamp",
  );

  const failed = concludeConflictAttempt(
    again,
    "failed",
    "conflict unresolved at rung agent",
    "sha-x",
    now + 7200_000,
  );
  assertEquals(failed.agentDeferredSince, undefined);
  assertEquals(failed.conflictAttempts, 1);
});
