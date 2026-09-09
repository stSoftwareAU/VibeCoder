/**
 * The sync runs on every cycle in which the default-branch tip moved
 * (Issue #1776).
 *
 * `main` takes ~27 commits a day, so an hourly per-branch cooldown left a
 * milestone branch up to an hour behind, and the closed-issue gate left a
 * milestone that had completed nothing out of the sweep entirely — the two
 * conditions under which drift is cheapest to clear. The cadence is now one
 * comparison: the default tip as git sees it, against the tip the branch was
 * last successfully synced against in `milestone_sync_failures.json`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  loadSyncStreaks,
  milestoneSyncStreakPath,
  saveSyncStreaks,
} from "../lib/milestone_sync_streak.ts";

const TITLE = "#1558 Drift";
const BRANCH = "milestone/1558-drift";
const FRESH_TITLE = "#1776 Fresh";
const FRESH_BRANCH = "milestone/1776-fresh";
const KEY = `owner/repo|${BRANCH}`;

/** One cycle's worth of recorded activity. */
interface Recorded {
  /** Milestone branches handed to `syncBranchFn`. */
  synced: string[];
  /** Every gh argument list the pass issued. */
  ghCalls: string[][];
  /** Every log line the pass wrote. */
  logs: string[];
}

/** Options for {@link cadenceDeps}. */
interface CadenceOptions {
  /** Path of the streak/ledger file. */
  streakPath: string;
  /** Default tip as git reports it; `undefined` means it could not be read. */
  defaultSha?: string;
  /** Milestones the REST listing returns. */
  milestones?: Array<{ title: string; number: number; closed_issues?: number }>;
  /** False makes every sync fail. */
  succeed?: boolean;
}

/** Deps for one repo, recording what the cycle did. */
function cadenceDeps(
  options: CadenceOptions,
  recorded: Recorded,
): MilestoneBranchSyncDeps {
  const milestones = options.milestones ??
    [{ title: TITLE, number: 7, closed_issues: 3 }];
  const succeed = options.succeed ?? true;
  return {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      recorded.ghCalls.push([...args]);
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(JSON.stringify(milestones));
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("branches/milestone")) {
        // The branch probe answers with the branch it was asked about.
        return Promise.resolve(key.split("branches/")[1]?.split(" ")[0] ?? "");
      }
      return Promise.resolve("[]");
    },
    defaultTipShaFn: () => Promise.resolve(options.defaultSha),
    syncBranchFn: (_repo, milestoneBranch) => {
      recorded.synced.push(milestoneBranch);
      return succeed
        ? Promise.resolve({ ok: true as const, value: { message: "merged" } })
        : Promise.resolve({
          ok: false as const,
          error: new Error("refusing to merge unrelated histories"),
        });
    },
    log: (message: string) => recorded.logs.push(message),
    streakPath: options.streakPath,
  };
}

/** Fresh recorder. */
function recorder(): Recorded {
  return { synced: [], ghCalls: [], logs: [] };
}

Deno.test(
  "syncMilestoneBranches - an unchanged default tip syncs nothing (Issue #1776)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1776-unchanged-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      await saveSyncStreaks(streakPath, {
        [KEY]: { count: 0, escalated: false, lastSyncedDefaultSha: "sha-a" },
      });

      const recorded = recorder();
      const result = await syncMilestoneBranches(
        cadenceDeps({ streakPath, defaultSha: "sha-a" }, recorded),
      );

      assert(result.ok);
      assertEquals(recorded.synced, [], "the tip has not moved since the sync");
      assertEquals(result.value.skipped, 1);
      assertEquals(result.value.synced, 0);
      assert(
        recorded.logs.some((line) => line.includes("default tip unchanged")),
        `expected a 'default tip unchanged' skip line, got ${
          JSON.stringify(recorded.logs)
        }`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "syncMilestoneBranches - a moved tip syncs every open milestone, including one with no closed issues (Issue #1776)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1776-moved-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      await saveSyncStreaks(streakPath, {
        [KEY]: { count: 0, escalated: false, lastSyncedDefaultSha: "sha-a" },
      });

      const recorded = recorder();
      const result = await syncMilestoneBranches(
        cadenceDeps({
          streakPath,
          defaultSha: "sha-b",
          milestones: [
            { title: TITLE, number: 7, closed_issues: 3 },
            // Nothing closed here yet: under the old gate this milestone was
            // never swept at all.
            { title: FRESH_TITLE, number: 8, closed_issues: 0 },
          ],
        }, recorded),
      );

      assert(result.ok);
      assertEquals(recorded.synced, [BRANCH, FRESH_BRANCH]);
      assertEquals(result.value.synced, 2);
      assertEquals(result.value.skipped, 0);
      assertEquals(
        recorded.ghCalls.filter((args) =>
          args.join(" ").includes("--state closed")
        ).length,
        0,
        "the closed-issue query is gone, not merely skipped",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "syncMilestoneBranches - a successful sync records the tip, so the next cycle skips it (Issue #1776)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1776-record-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);

      const first = recorder();
      await syncMilestoneBranches(
        cadenceDeps({ streakPath, defaultSha: "sha-b" }, first),
      );
      assertEquals(first.synced, [BRANCH]);
      assertEquals(
        (await loadSyncStreaks(streakPath))[KEY]?.lastSyncedDefaultSha,
        "sha-b",
      );

      const second = recorder();
      const result = await syncMilestoneBranches(
        cadenceDeps({ streakPath, defaultSha: "sha-b" }, second),
      );
      assert(result.ok);
      assertEquals(second.synced, [], "same tip, nothing to merge down");
      assertEquals(result.value.skipped, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "syncMilestoneBranches - a failed sync leaves the recorded tip alone so the next cycle retries (Issue #1776)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1776-retry-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      await saveSyncStreaks(streakPath, {
        [KEY]: { count: 0, escalated: false, lastSyncedDefaultSha: "sha-a" },
      });

      const first = recorder();
      const failed = await syncMilestoneBranches(
        cadenceDeps(
          { streakPath, defaultSha: "sha-b", succeed: false },
          first,
        ),
      );
      assert(failed.ok);
      assertEquals(failed.value.failed, 1);
      assertEquals(
        (await loadSyncStreaks(streakPath))[KEY]?.lastSyncedDefaultSha,
        "sha-a",
        "a failure records nothing — the branch is not synced against sha-b",
      );

      // The next cycle tries again against the same moved tip.
      const second = recorder();
      await syncMilestoneBranches(
        cadenceDeps(
          { streakPath, defaultSha: "sha-b", succeed: false },
          second,
        ),
      );
      assertEquals(second.synced, [BRANCH], "the failed sync is retried");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "syncMilestoneBranches - a tip git cannot report is synced rather than silently skipped (Issue #1776)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1776-no-tip-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      await saveSyncStreaks(streakPath, {
        [KEY]: { count: 0, escalated: false, lastSyncedDefaultSha: "sha-a" },
      });

      const recorded = recorder();
      const result = await syncMilestoneBranches(
        cadenceDeps({ streakPath, defaultSha: undefined }, recorded),
      );

      assert(result.ok);
      assertEquals(
        recorded.synced,
        [BRANCH],
        "an unreadable tip must not read as 'unchanged'",
      );
      assertEquals(
        (await loadSyncStreaks(streakPath))[KEY]?.lastSyncedDefaultSha,
        "sha-a",
        "with no tip to record, the last known one stands",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
