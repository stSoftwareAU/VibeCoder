/**
 * The milestone sweep's pacing: what one attempt may spend, and the order the
 * sweep offers its milestones in (Issue #2215).
 */

import { assertEquals } from "@std/assert";
import {
  lastVisitedMs,
  MILESTONE_SWEEP_RESERVE_MS,
  milestoneAttemptShareMs,
  MIN_MILESTONE_ATTEMPT_MS,
  orderMilestonesByStaleness,
  orderReposByStaleness,
} from "../lib/milestone_sync_pacing.ts";
import type { SyncStreaks } from "../lib/milestone_sync_streak.ts";

Deno.test("milestoneAttemptShareMs - a pass with no deadline is unbounded", () => {
  const share = milestoneAttemptShareMs({ nowMs: 1_000, unitsLeft: 4 });
  assertEquals(share.attempt, true);
  assertEquals(share.budgetMs, undefined);
});

Deno.test("milestoneAttemptShareMs - one attempt never takes the whole budget", () => {
  // 800s of budget, four milestones still to visit: each gets a quarter, so
  // the fourth is still reached (Issue #2215).
  const share = milestoneAttemptShareMs({
    deadlineEpochMs: 800_000 + MILESTONE_SWEEP_RESERVE_MS,
    nowMs: 0,
    unitsLeft: 4,
  });
  assertEquals(share.attempt, true);
  assertEquals(share.budgetMs, 200_000);
});

Deno.test("milestoneAttemptShareMs - a share below the floor is raised to it", () => {
  // Twenty milestones and 300s left: a 15s sliver starts nothing useful, so
  // the early ones get the floor and the rest are refused when it runs out.
  const share = milestoneAttemptShareMs({
    deadlineEpochMs: 300_000 + MILESTONE_SWEEP_RESERVE_MS,
    nowMs: 0,
    unitsLeft: 20,
  });
  assertEquals(share.budgetMs, MIN_MILESTONE_ATTEMPT_MS);
});

Deno.test("milestoneAttemptShareMs - a spent budget refuses the attempt by name", () => {
  const share = milestoneAttemptShareMs({
    deadlineEpochMs: 10_000,
    nowMs: 0,
    unitsLeft: 1,
  });
  assertEquals(share.attempt, false);
  assertEquals(typeof share.reason, "string");
  assertEquals(share.reason!.length > 0, true);
});

Deno.test("milestoneAttemptShareMs - a single milestone keeps what is left, not more", () => {
  const share = milestoneAttemptShareMs({
    deadlineEpochMs: 120_000 + MILESTONE_SWEEP_RESERVE_MS,
    nowMs: 0,
    unitsLeft: 1,
  });
  assertEquals(share.budgetMs, 120_000);
});

Deno.test("lastVisitedMs - absent and unparseable both read as never visited", () => {
  assertEquals(lastVisitedMs(undefined), 0);
  assertEquals(lastVisitedMs({ count: 0, escalated: false }), 0);
  assertEquals(
    lastVisitedMs({ count: 0, escalated: false, lastVisitedAt: "not a date" }),
    0,
  );
  assertEquals(
    lastVisitedMs({
      count: 0,
      escalated: false,
      lastVisitedAt: "2026-09-16T11:12:56.000Z",
    }),
    Date.parse("2026-09-16T11:12:56.000Z"),
  );
});

Deno.test("orderMilestonesByStaleness - the starved milestone goes first", () => {
  const streaks: SyncStreaks = {
    "owner/repo|milestone/visited": {
      count: 0,
      escalated: false,
      lastVisitedAt: "2026-09-16T11:12:56.000Z",
    },
    "owner/repo|milestone/older": {
      count: 0,
      escalated: false,
      lastVisitedAt: "2026-09-16T10:00:00.000Z",
    },
  };
  const ordered = orderMilestonesByStaleness(
    "owner/repo",
    [
      { milestoneBranch: "milestone/visited" },
      { milestoneBranch: "milestone/older" },
      { milestoneBranch: "milestone/never" },
    ],
    streaks,
  );
  assertEquals(ordered.map((m) => m.milestoneBranch), [
    "milestone/never",
    "milestone/older",
    "milestone/visited",
  ]);
});

Deno.test("orderReposByStaleness - the repo that ate the budget goes last", () => {
  const streaks: SyncStreaks = {
    "owner/hungry|milestone/a": {
      count: 0,
      escalated: false,
      lastVisitedAt: "2026-09-16T11:12:56.000Z",
    },
    "owner/starved|milestone/b": {
      count: 0,
      escalated: false,
      lastVisitedAt: "2026-09-16T09:00:00.000Z",
    },
  };
  assertEquals(
    orderReposByStaleness(
      ["owner/hungry", "owner/starved", "owner/fresh"],
      streaks,
    ),
    ["owner/fresh", "owner/starved", "owner/hungry"],
  );
});

Deno.test("orderReposByStaleness - equal staleness keeps the configured order", () => {
  assertEquals(
    orderReposByStaleness(["owner/a", "owner/b", "owner/c"], {}),
    ["owner/a", "owner/b", "owner/c"],
  );
});
