/**
 * The milestone sync runs again when the milestone's own tip moved, not only
 * when the default tip did (Issue #2285).
 *
 * PR #2284 on GRQ-23, 2026-09-17: the sync raised its sync PR at 08:07:18Z;
 * a child PR landed on the milestone at 08:07:22Z with a ledger slice, main
 * had added another, and the sync PR was conflicting from then on. The
 * cadence guard keyed only on main's tip, so nothing refreshed it until
 * main happened to move.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  loadSyncStreaks,
  milestoneSyncStreakPath,
} from "../lib/milestone_sync_streak.ts";

const REPO = "owner/repo";
const BRANCH = "milestone/10-one-milestone";
const DEFAULT_SHA = "d".repeat(40);

/** Deps with one milestone, a fixed default tip, and a milestone tip we move. */
function deps(options: {
  streakPath: string;
  milestoneTip: () => string;
  synced: string[];
  log: string[];
}): MilestoneBranchSyncDeps {
  return {
    repos: [REPO],
    ghCommandFn: (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("/milestones")) {
        return Promise.resolve(
          JSON.stringify([{ title: "#10 one milestone", number: 1 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes(`branches/${BRANCH}`)) {
        return Promise.resolve(options.milestoneTip());
      }
      return Promise.resolve("[]");
    },
    syncBranchFn: (_repo, milestoneBranch) => {
      options.synced.push(milestoneBranch);
      return Promise.resolve({
        ok: true as const,
        value: { message: "merged" },
      });
    },
    defaultTipShaFn: () =>
      Promise.resolve({ ok: true as const, value: DEFAULT_SHA }),
    log: (m) => options.log.push(m),
    streakPath: options.streakPath,
  };
}

Deno.test("syncMilestoneBranches - with the default tip unchanged, a milestone whose tip moved is synced again; one that did not move is skipped (Issue #2285)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2285-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    let tip = "m".repeat(40);
    const synced: string[] = [];
    const log: string[] = [];
    const run = () =>
      syncMilestoneBranches(deps({
        streakPath,
        milestoneTip: () => tip,
        synced,
        log,
      }));

    await run();
    assertEquals(synced.length, 1, "first cycle syncs");
    const recorded = (await loadSyncStreaks(streakPath))[`${REPO}|${BRANCH}`];
    assertEquals(recorded?.lastSyncedDefaultSha, DEFAULT_SHA);
    assertEquals(recorded?.lastSyncedMilestoneSha, tip);

    await run();
    assertEquals(synced.length, 1, "nothing moved: the second cycle skips");
    assertEquals(
      log.some((l) => l.includes("milestone tip unchanged")),
      true,
      log.join("\n"),
    );

    // A child PR lands on the milestone; main stays where it was.
    tip = "n".repeat(40);
    await run();
    assertEquals(
      synced.length,
      2,
      "the moved milestone tip is a reason to sync",
    );
    assertEquals(
      (await loadSyncStreaks(streakPath))[`${REPO}|${BRANCH}`]
        ?.lastSyncedMilestoneSha,
      tip,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
