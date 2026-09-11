/**
 * A milestone sync that fails twice for the identical reason escalates on the
 * second cycle, not the fourth (Issue #1964).
 *
 * `milestone/168-…` in the GRQ fleet spent four cycles — and four agent runs —
 * producing the same one-line failure before anyone was told. A reason that
 * has not changed is a reason no retry will change, so the second occurrence
 * is the escalation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  isRepeatedFailureReason,
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  milestoneSyncStreakPath,
  type SyncStreakEntry,
} from "../lib/milestone_sync_streak.ts";

const MILESTONE_TITLE = "#168 Emergency stop";
const MILESTONE_BRANCH = "milestone/168-emergency-stop";

/** The failure the fleet actually saw, now carrying git's stdout. */
const COMMIT_FAILURE =
  `Failed to re-word the conflict resolution for '${MILESTONE_BRANCH}' ` +
  `(Issues #4260, #1964): nothing to commit, working tree clean`;

/** Sync deps whose sync fails with `reason` on every cycle. */
function failingDeps(
  calls: string[][],
  streakPath: string,
  reason: () => string,
  succeed = false,
): MilestoneBranchSyncDeps {
  return {
    repos: ["owner/repo"],
    streakPath,
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
      succeed
        ? Promise.resolve({
          ok: true as const,
          value: { message: "Synced" },
        })
        : Promise.resolve({ ok: false as const, error: new Error(reason()) }),
    log: () => undefined,
  };
}

/** The `gh issue comment` calls made during a sweep. */
function commentCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "issue" && c[1] === "comment");
}

Deno.test(
  "milestone sync - two cycles failing for the identical reason escalate on the second (Issue #1964)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1964-repeat-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];

      await syncMilestoneBranches(
        failingDeps(calls, streakPath, () => COMMIT_FAILURE),
      );
      assertEquals(
        commentCalls(calls).length,
        0,
        "one failure is not yet a pattern",
      );

      await syncMilestoneBranches(
        failingDeps(calls, streakPath, () => COMMIT_FAILURE),
      );
      const comments = commentCalls(calls);
      assertEquals(
        comments.length,
        1,
        "the second identical failure escalates",
      );
      const body = comments[0]![comments[0]!.length - 1] ?? "";
      assertStringIncludes(body, MILESTONE_BRANCH);
      assertStringIncludes(
        body,
        "nothing to commit, working tree clean",
        "the escalation carries git's own output",
      );
      assertStringIncludes(
        body,
        "identical",
        "the escalation says the reason has not changed",
      );
      assert(
        MILESTONE_SYNC_ESCALATION_THRESHOLD > 2,
        "precondition: the ordinary streak threshold would not have fired yet",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a reason that changes each cycle still waits for the ordinary threshold (Issue #1964)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1964-repeat-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      let cycle = 0;

      for (let i = 0; i < 2; i++) {
        await syncMilestoneBranches(
          failingDeps(calls, streakPath, () => `transient failure ${++cycle}`),
        );
      }
      assertEquals(
        commentCalls(calls).length,
        0,
        "two different reasons are not the stuck loop this rule catches",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a repeated failure escalates once, not every cycle (Issue #1964)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1964-repeat-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      for (let i = 0; i < 4; i++) {
        await syncMilestoneBranches(
          failingDeps(calls, streakPath, () => COMMIT_FAILURE),
        );
      }
      assertEquals(
        commentCalls(calls).length,
        1,
        "exactly one comment across four identical failures",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a failure, a success, then the same failure is a first failure again (Issue #1964)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1964-repeat-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const same = () => COMMIT_FAILURE;

      await syncMilestoneBranches(failingDeps(calls, streakPath, same));
      await syncMilestoneBranches(
        failingDeps(calls, streakPath, same, true),
      );
      await syncMilestoneBranches(failingDeps(calls, streakPath, same));

      assertEquals(
        commentCalls(calls).length,
        0,
        "the success broke the streak, so this is the first failure again",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "isRepeatedFailureReason - only an unbroken run of identical reasons counts (Issue #1964)",
  () => {
    const entry = (reason: string): SyncStreakEntry => ({
      count: 2,
      escalated: false,
      lastAttempt: { at: "2026-09-11T00:00:00Z", outcome: "failed", reason },
    });

    assertEquals(isRepeatedFailureReason(entry("same"), "same", 2), true);
    assertEquals(
      isRepeatedFailureReason(entry("same"), "different", 2),
      false,
      "a changed reason is progress, however small",
    );
    assertEquals(
      isRepeatedFailureReason(entry("same"), "same", 1),
      false,
      "one failure is not a repeat, whatever the audit record says",
    );
    assertEquals(
      isRepeatedFailureReason(entry(""), "", 2),
      false,
      "an empty reason matches nothing — it says nothing to repeat",
    );
    assertEquals(
      isRepeatedFailureReason({ count: 2, escalated: false }, "same", 2),
      false,
      "a branch with no recorded attempt has nothing to compare against",
    );
  },
);
