/**
 * Tests for the milestone-sync failure-streak escalation (Issue #4260,
 * proposal 2). A branch that fails to sync for the threshold number of
 * consecutive cycles gets one needs-human comment on its tracking issue;
 * a success clears the streak.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  loadSyncStreaks,
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  milestoneSyncStreakPath,
  saveSyncStreaks,
  trackingIssueFromMilestoneTitle,
} from "../lib/milestone_sync_streak.ts";
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
    cooldownSeconds: 0,
    lastSyncTimes: new Map(),
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
      Promise.resolve({ ok: true as const, value: "synced" });
    await syncMilestoneBranches(okDeps);
    streaks = await loadSyncStreaks(streakPath);
    assertEquals(
      streaks["owner/repo|milestone/77-stuck-milestone"],
      undefined,
      "a successful sync clears the streak entry",
    );
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
