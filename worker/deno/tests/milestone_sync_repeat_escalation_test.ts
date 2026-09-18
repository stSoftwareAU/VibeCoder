/**
 * A milestone conflict never asks a human, however often it repeats
 * (Issue #2311).
 *
 * Issue #1964 escalated an identical second failure with `needs-human` on the
 * second cycle rather than the fourth. The conflict budget, the roll-back and
 * the `merge-fallback` flag replaced that outright: two runs, then a
 * fallback that files one flag issue. What survives here is the ordinary
 * streak escalation for a **non-conflict** failure — a fetch, a push or a
 * plain git error — which is not a conflict outcome and still reaches a
 * human at {@link MILESTONE_SYNC_ESCALATION_THRESHOLD}.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import {
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  milestoneSyncStreakPath,
} from "../lib/milestone_sync_streak.ts";

const MILESTONE_TITLE = "#168 Emergency stop";
const MILESTONE_BRANCH = "milestone/168-emergency-stop";
const DEFAULT_SHA = "dddddddddddddddddddddddddddddddddddddddd";

/** The non-conflict failure the fleet actually saw, carrying git's stdout. */
const FETCH_FAILURE =
  `Failed to fetch 'main' for '${MILESTONE_BRANCH}': could not read from ` +
  `remote repository`;

/** A conflict every rung of the ladder left undecided. */
function conflictFailure(): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "every rung left it undecided",
    [{
      path: "worker/deno/lib/scan_content.ts",
      reason: "agent: agent timed out after 1800s",
      oursExports: [],
      theirsExports: [],
      oursTests: [],
      theirsTests: [],
      onlyOursTests: [],
      onlyTheirsTests: [],
    }],
    [],
    DEFAULT_SHA,
  );
}

/** Sync deps whose sync fails the same way on every cycle. */
function failingDeps(
  calls: string[][],
  streakPath: string,
  failure: () => Error,
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
        : Promise.resolve({ ok: false as const, error: failure() }),
    log: () => undefined,
  };
}

/** The `gh issue comment` calls made during a sweep. */
function commentCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "issue" && c[1] === "comment");
}

/** Every gh argv, flattened — what a human would have been sent. */
function everyWrite(calls: string[][]): string {
  return calls.map((c) => c.join(" ")).join("\n");
}

Deno.test(
  "milestone sync - a conflict repeating cycle after cycle never writes needs-human (Issue #2311)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-2311-conflict-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];

      for (let cycle = 0; cycle < 4; cycle++) {
        await syncMilestoneBranches(
          failingDeps(calls, streakPath, conflictFailure),
        );
      }

      assert(
        !everyWrite(calls).includes("needs-human"),
        `a conflict outcome reached a human: ${
          JSON.stringify(everyWrite(calls))
        }`,
      );
      assertEquals(
        commentCalls(calls).length,
        0,
        "the budget and the flag answer a conflict, not a comment",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a persistent non-conflict failure still escalates at the threshold (Issue #2311)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-2311-fetch-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const fetchFailure = () => new Error(FETCH_FAILURE);

      for (
        let cycle = 1;
        cycle < MILESTONE_SYNC_ESCALATION_THRESHOLD;
        cycle++
      ) {
        await syncMilestoneBranches(
          failingDeps(calls, streakPath, fetchFailure),
        );
        assertEquals(
          commentCalls(calls).length,
          0,
          `cycle ${cycle} is below the threshold and escalates nothing`,
        );
      }

      await syncMilestoneBranches(failingDeps(calls, streakPath, fetchFailure));
      const comments = commentCalls(calls);
      assertEquals(comments.length, 1, "the threshold escalates once");
      const body = comments[0]![comments[0]!.length - 1] ?? "";
      assertStringIncludes(body, MILESTONE_BRANCH);
      assertStringIncludes(
        body,
        "could not read from remote repository",
        "the escalation carries git's own output",
      );
      assertStringIncludes(body, "needs a human");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a non-conflict failure repeating escalates once, not every cycle (Issue #2311)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-2311-once-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      for (let i = 0; i < MILESTONE_SYNC_ESCALATION_THRESHOLD + 3; i++) {
        await syncMilestoneBranches(
          failingDeps(calls, streakPath, () => new Error(FETCH_FAILURE)),
        );
      }
      assertEquals(
        commentCalls(calls).length,
        1,
        "exactly one comment across every identical failure",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a success clears the streak, so the count starts again (Issue #2311)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-2311-cleared-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const same = () => new Error(FETCH_FAILURE);

      for (let i = 1; i < MILESTONE_SYNC_ESCALATION_THRESHOLD; i++) {
        await syncMilestoneBranches(failingDeps(calls, streakPath, same));
      }
      await syncMilestoneBranches(failingDeps(calls, streakPath, same, true));
      await syncMilestoneBranches(failingDeps(calls, streakPath, same));

      assertEquals(
        commentCalls(calls).length,
        0,
        "the success broke the streak, so the count is below the threshold",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
