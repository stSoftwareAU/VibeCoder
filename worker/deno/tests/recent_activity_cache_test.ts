/**
 * Cache wiring tests for recent_activity.ts (Issue #1799).
 *
 * Verifies that `collectRecentActivity` routes the merged-PR (no-author)
 * and open-worker-PR fetches through `IssueCache`, sharing the
 * iteration-scoped cache with sibling helpers.
 *
 * Uses Australian English spelling throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  collectRecentActivity,
  type CommandRunner,
} from "../lib/recent_activity.ts";
import { IssueCache } from "../lib/issue_cache.ts";

async function makeTempCache(): Promise<{
  cache: IssueCache;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "recent-activity-cache-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

/** Build a runner that records gh-args for assertions. */
function recordingRunner(
  responses: Array<{ match: (args: string[]) => boolean; output: string }>,
): { runner: CommandRunner; ghCalls: string[][] } {
  const ghCalls: string[][] = [];
  const runner: CommandRunner = (command, args) => {
    if (command === "gh") ghCalls.push(args);
    for (const r of responses) {
      if (r.match(args)) {
        return Promise.resolve({ ok: true as const, value: r.output });
      }
    }
    if (command === "git") {
      return Promise.resolve({ ok: true as const, value: "" });
    }
    return Promise.resolve({ ok: true as const, value: "[]" });
  };
  return { runner, ghCalls };
}

Deno.test("recent_activity - merged PRs routed through IssueCache (cache miss)", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const merged = JSON.stringify([
      { number: 42, title: "Fix bug", changedFiles: 3 },
    ]);
    const { runner, ghCalls } = recordingRunner([
      { match: (a) => a.includes("merged"), output: merged },
      { match: (a) => a.includes("open"), output: "[]" },
    ]);

    const result = await collectRecentActivity({
      repo: "owner/repo",
      githubUser: "bot",
      mergedPrLimit: 10,
      commitLimit: 5,
      runner,
      cache,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.mergedPrs.length, 1);
    assertEquals(result.value.mergedPrs[0]?.number, 42);
    assertEquals(result.value.mergedPrs[0]?.filesChanged, 3);

    // Confirm the merged-PR call was issued (cache miss).
    const mergedCalls = ghCalls.filter((a) => a.includes("merged"));
    assertEquals(mergedCalls.length, 1);

    // Confirm the cache key was populated under `prs_recent_merged_${limit}`.
    const cached = await cache.read<unknown[]>(
      "owner/repo",
      "prs_recent_merged_10",
    );
    assert(cached !== null);
    assertEquals(cached?.length, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("recent_activity - merged PRs cache hit pre-populated by sibling helper", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    // Pre-populate the cache as if a sibling helper had already fetched
    // the merged-PR list earlier in the iteration.
    await cache.write("owner/repo", "prs_recent_merged_10", [
      { number: 99, title: "Pre-cached", changedFiles: 1 },
    ]);

    let mergedCallCount = 0;
    const runner: CommandRunner = (command, args) => {
      if (command === "gh" && args.includes("merged")) {
        mergedCallCount++;
      }
      // Return empty for any uncached call; the test fails if
      // mergedCallCount becomes > 0.
      return Promise.resolve({ ok: true as const, value: "[]" });
    };

    const result = await collectRecentActivity({
      repo: "owner/repo",
      // Use a unique githubUser so the recent-activity composite cache
      // key (which is independent here) does not collide with prior runs.
      githubUser: "bot-sibling",
      mergedPrLimit: 10,
      commitLimit: 5,
      runner,
      cache,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.mergedPrs.length, 1);
    assertEquals(result.value.mergedPrs[0]?.number, 99);
    assertEquals(result.value.mergedPrs[0]?.filesChanged, 1);
    assertEquals(
      mergedCallCount,
      0,
      "merged-PR fetch should hit the pre-populated cache",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("recent_activity - merged PRs cache invalidation forces refetch", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let mergedCallCount = 0;
    const runner: CommandRunner = (command, args) => {
      if (command === "gh" && args.includes("merged")) {
        mergedCallCount++;
        return Promise.resolve({
          ok: true as const,
          value: JSON.stringify([
            { number: 1, title: "T", changedFiles: 1 },
          ]),
        });
      }
      return Promise.resolve({ ok: true as const, value: "[]" });
    };

    const opts = {
      repo: "owner/repo",
      githubUser: "bot-invalidation",
      mergedPrLimit: 10,
      commitLimit: 5,
      runner,
      cache,
    };

    await collectRecentActivity(opts);
    assertEquals(mergedCallCount, 1);

    // Invalidate both the composite recent-activity cache and the
    // underlying merged-PR cache so the next call must refetch.
    await cache.invalidate("owner/repo", "recent-activity");
    await cache.invalidate("owner/repo", "prs_recent_merged_10");

    await collectRecentActivity(opts);
    assertEquals(
      mergedCallCount,
      2,
      "post-invalidate read must hit the network",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("recent_activity - open-worker-PR fetch routed through fetchOpenPRsByUser cache", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    // Pre-populate the open-PR cache for the worker user.
    await cache.write("owner/repo", "prs_bot-open", [
      {
        number: 7,
        title: "WIP",
        baseRefName: "main",
        headRefName: "feature-7",
      },
    ]);

    let openCallCount = 0;
    const runner: CommandRunner = (command, args) => {
      if (command === "gh" && args.includes("open")) {
        openCallCount++;
      }
      if (command === "gh" && args.includes("merged")) {
        return Promise.resolve({ ok: true as const, value: "[]" });
      }
      return Promise.resolve({ ok: true as const, value: "[]" });
    };

    const result = await collectRecentActivity({
      repo: "owner/repo",
      githubUser: "bot-open",
      mergedPrLimit: 10,
      commitLimit: 5,
      runner,
      cache,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.openWorkerPrs.length, 1);
    assertEquals(result.value.openWorkerPrs[0]?.number, 7);
    assertEquals(result.value.openWorkerPrs[0]?.targetBranch, "main");
    assertEquals(
      openCallCount,
      0,
      "open-PR fetch should hit the pre-populated cache",
    );
  } finally {
    await cleanup();
  }
});
