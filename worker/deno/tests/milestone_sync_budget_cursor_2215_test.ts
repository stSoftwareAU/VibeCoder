/**
 * The milestone sync stops cleanly when its budget runs out and resumes
 * where it stopped next cycle (Issue #2215).
 *
 * GRQ-23, 2026-09-16 11:12Z: the sync started 13 minutes before the cycle
 * end, ran a full fleet pass it could not finish, logged nothing per
 * milestone, and was abandoned by the watchdog mid-way; the next pass
 * started over from the first repository, so VibeCoder's conflicting
 * milestone/2163 was never reached and a human merged it by hand.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  MIN_MS_PER_MILESTONE_SYNC,
  rotateReposFrom,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  loadSyncCursor,
  milestoneSyncCursorPath,
  milestoneSyncStreakPath,
  saveSyncCursor,
} from "../lib/milestone_sync_streak.ts";

const REPOS = ["owner/alpha", "owner/beta", "owner/gamma"];

/** Deps over three repositories with one milestone each and a ticking clock. */
function fleetDeps(options: {
  dir: string;
  nowMs: number;
  deadlineEpochMs?: number;
  msPerSync: number;
  synced: string[];
  log?: string[];
}): MilestoneBranchSyncDeps {
  let clock = options.nowMs;
  return {
    repos: REPOS,
    ghCommandFn: (args: string[]): Promise<string> => {
      const key = args.join(" ");
      const repo = REPOS.find((r) => key.includes(`repos/${r}/`));
      if (key.includes("/milestones")) {
        const name = repo?.split("/")[1] ?? "x";
        return Promise.resolve(
          JSON.stringify([{ title: `#10 ${name} milestone`, number: 1 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("branches/milestone")) {
        return Promise.resolve(args[2]!.split("/").slice(-2).join("/"));
      }
      return Promise.resolve("[]");
    },
    syncBranchFn: (repo, milestoneBranch) => {
      options.synced.push(`${repo}|${milestoneBranch}`);
      clock += options.msPerSync;
      return Promise.resolve({
        ok: true as const,
        value: { message: "merged" },
      });
    },
    defaultTipShaFn: () =>
      Promise.resolve({ ok: true as const, value: "a".repeat(40) }),
    log: (m) => options.log?.push(m),
    streakPath: milestoneSyncStreakPath(options.dir),
    cursorPath: milestoneSyncCursorPath(options.dir),
    now: () => clock,
    ...(options.deadlineEpochMs !== undefined
      ? { deadlineEpochMs: options.deadlineEpochMs }
      : {}),
  };
}

Deno.test("rotateReposFrom - starts at the named repository and wraps; an unknown start keeps the order", () => {
  assertEquals(rotateReposFrom(REPOS, "owner/beta"), [
    "owner/beta",
    "owner/gamma",
    "owner/alpha",
  ]);
  assertEquals(rotateReposFrom(REPOS, undefined), REPOS);
  assertEquals(rotateReposFrom(REPOS, "owner/none"), REPOS);
  assertEquals(rotateReposFrom(REPOS, "owner/alpha"), REPOS);
});

Deno.test("syncMilestoneBranches - a pass that runs out of budget stops before the next sync, records the cursor, and names the repositories not reached (Issue #2215)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2215-budget-" });
  try {
    const synced: string[] = [];
    const log: string[] = [];
    // Each sync takes five minutes; the handler has seven left: the first
    // sync fits, and the two minutes left after it are under the floor.
    await syncMilestoneBranches(fleetDeps({
      dir,
      nowMs: 1_000_000,
      deadlineEpochMs: 1_000_000 + 7 * 60 * 1000,
      msPerSync: 5 * 60 * 1000,
      synced,
      log,
    }));

    assertEquals(synced.length, 1, synced.join(", "));
    assert(synced[0]!.startsWith("owner/alpha|"));
    const cursor = await loadSyncCursor(milestoneSyncCursorPath(dir));
    assertEquals(cursor?.repo, "owner/beta");
    assert(
      log.some((l) => l.includes("stopped before") && l.includes("owner/beta")),
      log.join("\n"),
    );
    assert(
      log.some((l) => l.includes("1 repository not reached")),
      log.join("\n"),
    );
    assert(
      log.some((l) => l.startsWith("Syncing milestone branch")),
      "each sync is named before it starts",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - the next pass resumes from the cursor, and a completed pass clears it (Issue #2215)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2215-cursor-" });
  try {
    await saveSyncCursor(milestoneSyncCursorPath(dir), { repo: "owner/beta" });
    const synced: string[] = [];
    const log: string[] = [];
    await syncMilestoneBranches(fleetDeps({
      dir,
      nowMs: 1_000_000,
      deadlineEpochMs: 1_000_000 + 60 * 60 * 1000,
      msPerSync: 1000,
      synced,
      log,
    }));

    assertEquals(
      synced.map((s) => s.split("|")[0]),
      ["owner/beta", "owner/gamma", "owner/alpha"],
      "beta first, then round to alpha",
    );
    assertEquals(await loadSyncCursor(milestoneSyncCursorPath(dir)), null);
    assert(
      log.some((l) => l.includes("resumes from owner/beta")),
      log.join("\n"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - with no deadline every repository is synced and no cursor is written (Issue #2215)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2215-unbounded-" });
  try {
    const synced: string[] = [];
    await syncMilestoneBranches(fleetDeps({
      dir,
      nowMs: 1_000_000,
      msPerSync: MIN_MS_PER_MILESTONE_SYNC * 10,
      synced,
    }));
    assertEquals(synced.length, 3);
    assertEquals(await loadSyncCursor(milestoneSyncCursorPath(dir)), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
