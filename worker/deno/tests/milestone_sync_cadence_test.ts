/**
 * The default branch is merged down after each sub-issue PR merges, not once
 * per cooldown window (Issue #1558).
 *
 * A milestone whose REST `closed_issues` count has moved since the previous
 * cycle has just had something closed — a sub-issue PR merged — which is
 * exactly the moment both sides have moved and a conflict is still one day
 * wide. That milestone syncs now; every other milestone still waits out the
 * cooldown, so the cadence costs no extra API calls.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  milestoneActivityPath,
  saveMilestoneActivity,
} from "../lib/milestone_activity_gate.ts";

const TITLE = "#1558 Drift";
const BRANCH = "milestone/1558-drift";

/** Deps for one repo with one milestone at `closedIssues` closed items. */
function deps(
  closedIssues: number,
  syncedBranches: string[],
  activityPath: string,
  lastSyncTimes: Map<string, number>,
): MilestoneBranchSyncDeps {
  return {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(
          JSON.stringify([{
            title: TITLE,
            number: 7,
            closed_issues: closedIssues,
          }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("issue list") && key.includes("--state closed")) {
        return Promise.resolve(
          JSON.stringify([{
            number: 10,
            title: "t",
            milestone: { title: TITLE },
          }]),
        );
      }
      if (key.includes("branches/milestone")) return Promise.resolve(BRANCH);
      return Promise.resolve("");
    },
    syncBranchFn: (_repo, milestoneBranch) => {
      syncedBranches.push(milestoneBranch);
      return Promise.resolve({
        ok: true as const,
        value: { message: "merged" },
      });
    },
    log: () => undefined,
    // An hour of cooldown, and a sync that just happened.
    cooldownSeconds: 3600,
    lastSyncTimes,
    activityPath,
  };
}

Deno.test(
  "syncMilestoneBranches - a milestone that just closed an issue syncs despite the cooldown (Issue #1558)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1558-cadence-" });
    try {
      const activityPath = milestoneActivityPath(dir);
      // The previous cycle observed two closed items; a sub-issue PR has
      // since merged and closed a third.
      await saveMilestoneActivity(activityPath, {
        "owner/repo|7": { closedIssues: 2, active: true },
      });

      const synced: string[] = [];
      const lastSyncTimes = new Map([["owner/repo|" + TITLE, Date.now()]]);
      const result = await syncMilestoneBranches(
        deps(3, synced, activityPath, lastSyncTimes),
      );

      assert(result.ok);
      assertEquals(
        synced,
        [BRANCH],
        "a sub-issue PR merging pulls the merge-down forward",
      );
      assertEquals(result.value.skipped, 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "syncMilestoneBranches - an unchanged milestone still waits out the cooldown (Issue #1558)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1558-cooldown-" });
    try {
      const activityPath = milestoneActivityPath(dir);
      await saveMilestoneActivity(activityPath, {
        "owner/repo|7": { closedIssues: 3, active: true },
      });

      const synced: string[] = [];
      const lastSyncTimes = new Map([["owner/repo|" + TITLE, Date.now()]]);
      const result = await syncMilestoneBranches(
        deps(3, synced, activityPath, lastSyncTimes),
      );

      assert(result.ok);
      assertEquals(synced, [], "nothing closed, so the cooldown still holds");
      assertEquals(result.value.skipped, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
