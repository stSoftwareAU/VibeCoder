/**
 * Tests for the merge-gate escalation in the milestone sync (Issue #974).
 *
 * A merged tree that does not compile is not a transient failure a retry
 * clears, so it escalates to the milestone's tracking issue on the first
 * occurrence rather than after the ordinary failure-streak threshold — and
 * only once, so a branch stuck for days does not comment every cycle.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import { mergeGateFailureError } from "../lib/milestone_merge_gate.ts";
import {
  loadSyncStreaks,
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  milestoneSyncStreakPath,
} from "../lib/milestone_sync_streak.ts";

const MILESTONE_TITLE = "#974 CI gates";
const MILESTONE_BRANCH = "milestone/974-ci-gates";

/** Sync deps whose sync always fails the merge gate, recording gh calls. */
function gateFailingDeps(
  calls: string[][],
  streakPath?: string,
): MilestoneBranchSyncDeps {
  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      calls.push(args);
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(
          JSON.stringify([{ title: MILESTONE_TITLE, number: 1 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("issue list") && key.includes("--state closed")) {
        return Promise.resolve(
          JSON.stringify([{
            number: 10,
            title: "t",
            milestone: { title: MILESTONE_TITLE },
          }]),
        );
      }
      if (key.includes("branches/milestone")) {
        return Promise.resolve(MILESTONE_BRANCH);
      }
      return Promise.resolve("");
    },
    syncBranchFn: () =>
      Promise.resolve({
        ok: false as const,
        error: mergeGateFailureError(MILESTONE_BRANCH, "main", {
          status: "failed",
          detail: "deno task check in /w/worker/deno failed (exit 1)",
          output: "TS2339 [ERROR]: Property 'onSlotIdle' does not exist",
        }),
      }),
    log: () => undefined,
    cooldownSeconds: 0,
    lastSyncTimes: new Map(),
  };
  if (streakPath) deps.streakPath = streakPath;
  return deps;
}

/** The `gh issue comment` calls made during a sweep. */
function commentCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "issue" && c[1] === "comment");
}

Deno.test(
  "milestone sync - a gate failure escalates on the first cycle, not at the streak threshold (Issue #974)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-974-escalation-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];

      const result = await syncMilestoneBranches(gateFailingDeps(
        calls,
        streakPath,
      ));

      assert(result.ok);
      assertEquals(result.value.failed, 1, "the sync is reported as failed");
      const comments = commentCalls(calls);
      assertEquals(
        comments.length,
        1,
        "one needs-human comment on the very first gate failure",
      );
      const args = comments[0]!;
      assertEquals(args[2], "974", "posted on the milestone's tracking issue");
      const body = args[args.length - 1] ?? "";
      assertStringIncludes(body, MILESTONE_BRANCH);
      assertStringIncludes(body, "main");
      assertStringIncludes(body, "onSlotIdle");
      assertStringIncludes(body, "not pushed");
      assert(
        MILESTONE_SYNC_ESCALATION_THRESHOLD > 1,
        "precondition: the ordinary streak escalation would not have fired yet",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a stuck gate failure comments once, not every cycle (Issue #974)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-974-escalation-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const all: string[][] = [];
      for (let cycle = 0; cycle < 4; cycle++) {
        await syncMilestoneBranches(gateFailingDeps(all, streakPath));
      }
      assertEquals(
        commentCalls(all).length,
        1,
        "exactly one comment across four failing cycles",
      );
      const streaks = await loadSyncStreaks(streakPath);
      const entry = streaks[`owner/repo|${MILESTONE_BRANCH}`];
      assert(entry?.escalated, "the streak records that it escalated");
      assertEquals(entry?.count, 4, "every failing cycle is still counted");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - an ordinary merge failure still waits for the streak threshold (Issue #974)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-974-escalation-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const deps = gateFailingDeps(calls, streakPath);
      deps.syncBranchFn = () =>
        Promise.resolve({
          ok: false as const,
          error: new Error("refusing to merge unrelated histories"),
        });

      await syncMilestoneBranches(deps);

      assertEquals(
        commentCalls(calls).length,
        0,
        "a non-gate failure does not escalate on its first cycle",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
