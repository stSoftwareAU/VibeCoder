/**
 * Tests for a merge-gate refusal in the milestone sync (Issues #974, #4304).
 *
 * A merged tree that does not compile is not a transient failure a retry
 * clears. It used to be handed to a human with a "resolve the merge by hand"
 * comment on the milestone's tracking issue. It is now the conflict ladder's
 * (Issue #4304): each refusal is charged to the branch's conflict budget, and
 * a spent budget rolls the branch back and files the `merge-fallback` flag —
 * the same self-heal path a conflict takes. Nobody is asked to act.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import { mergeGateFailureError } from "../lib/milestone_merge_gate.ts";
import {
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
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
  };
  if (streakPath) deps.streakPath = streakPath;
  return deps;
}

/** The `gh issue comment` calls made during a sweep. */
function commentCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "issue" && c[1] === "comment");
}

Deno.test(
  "milestone sync - a gate failure asks nobody to resolve it by hand, and is charged to the conflict budget (Issue #4304)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-4304-gate-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];

      const result = await syncMilestoneBranches(gateFailingDeps(
        calls,
        streakPath,
      ));

      assert(result.ok);
      assertEquals(result.value.failed, 1, "the sync is reported as failed");
      assertEquals(commentCalls(calls), [], "no hand-back comment");
      const streaks = await loadSyncStreaks(streakPath);
      const entry = streaks[`owner/repo|${MILESTONE_BRANCH}`];
      assertEquals(entry?.conflictAttempts, 1);
      assertEquals(entry?.lastAttempt?.outcome, "failed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a gate failure that repeats reaches the roll-back ladder (Issue #4304)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-4304-gate-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const all: string[][] = [];
      const rollbacks: string[] = [];
      for (let cycle = 0; cycle < MILESTONE_CONFLICT_ATTEMPT_BUDGET; cycle++) {
        const deps = gateFailingDeps(all, streakPath);
        deps.rollbackFn = (request) => {
          rollbacks.push(`${request.milestoneBranch}|${request.attempts}`);
          return Promise.resolve();
        };
        await syncMilestoneBranches(deps);
      }
      assertEquals(rollbacks, [
        `${MILESTONE_BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
      ]);
      assert(
        !all.some((c) => c.join(" ").includes("needs a human")),
        "nothing asks a human",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - without a streak file the refusal is logged, not commented (Issue #974)",
  async () => {
    const calls: string[][] = [];
    const logs: Array<{ message: string; level: string }> = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const deps = gateFailingDeps(calls);
      deps.log = (m: string, level = "info") =>
        logs.push({ message: m, level });
      await syncMilestoneBranches(deps);
    }
    assertEquals(commentCalls(calls).length, 0);
    assert(
      logs.some((l) =>
        l.level === "warn" &&
        l.message.includes("onSlotIdle") &&
        l.message.includes(MILESTONE_BRANCH)
      ),
      "the refusal is still loud in the log",
    );
  },
);
