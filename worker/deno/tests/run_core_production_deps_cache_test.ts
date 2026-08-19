/**
 * Cache wiring tests for run_core_production_deps.ts (Issue #1799).
 *
 * Verifies the cache-key contracts the production deps factory relies
 * on for the deferred PR call sites:
 *
 * - `prs_open_all` — cached open-PR list used by `updateOpenPrBranches`
 *   (worker-PR identification via body marker).
 * - `prs_${user}` — cached open worker PRs used by `ensureAutoMerge`.
 * - `prs_recent_merged_${limit}` — cached recent merged PRs used by
 *   `recent_activity.ts`.
 *
 * These tests focus on cache-key correctness and post-mutation
 * invalidation, since the surrounding deps wire `runGhCommand` /
 * `runGitCommand` directly and a full integration test would require
 * extensive mocking of unrelated subsystems.
 *
 * Uses Australian English spelling throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  fetchAllOpenPRs,
  fetchOpenPRsByUser,
  fetchRecentMergedPRs,
} from "../lib/issue_query.ts";

async function makeTempCache(): Promise<{
  cache: IssueCache;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "run-core-deps-cache-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

Deno.test("run_core deps cache - prs_open_all cache hit avoids gh call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve(JSON.stringify([
        {
          number: 1,
          title: "Cached PR",
          baseRefName: "main",
          headRefName: "feature-1",
          body: "vibe-worker-issue-1",
          url: "u",
        },
      ]));
    };

    // Cold read populates cache.
    const first = await fetchAllOpenPRs("o/r", cache, 50, mockGh);
    assertEquals(first.length, 1);
    assertEquals(callCount, 1);

    // Warm read served from cache.
    const second = await fetchAllOpenPRs("o/r", cache, 50, mockGh);
    assertEquals(second.length, 1);
    assertEquals(callCount, 1, "cache hit must not invoke gh");
  } finally {
    await cleanup();
  }
});

Deno.test("run_core deps cache - prs_open_all post-mutation invalidation forces refetch", async () => {
  // Mirrors the invalidation step in `updateOpenPrBranches`: after a
  // successful branch update, the open-PR cache for the touched repo is
  // cleared so the next reader inside the same iteration sees current
  // state.
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };

    await fetchAllOpenPRs("o/r", cache, 50, mockGh);
    assertEquals(callCount, 1);

    // Simulate post-mutation invalidation.
    await cache.invalidate("o/r", "prs_open_all");

    await fetchAllOpenPRs("o/r", cache, 50, mockGh);
    assertEquals(
      callCount,
      2,
      "post-invalidate read must hit the network (mutation visibility)",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("run_core deps cache - prs_${user} cache hit avoids gh call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve(JSON.stringify([
        { number: 9, title: "T", baseRefName: "main", headRefName: "h" },
      ]));
    };

    await fetchOpenPRsByUser("o/r", "bot", cache, mockGh);
    await fetchOpenPRsByUser("o/r", "bot", cache, mockGh);
    assertEquals(callCount, 1, "second call must use the cache");
  } finally {
    await cleanup();
  }
});

Deno.test("run_core deps cache - prs_${user} post-mutation invalidation forces refetch", async () => {
  // Mirrors the invalidation step in `ensureAutoMerge`: enabling
  // auto-merge can immediately close PRs whose checks already pass, so
  // the cached open-worker-PR list must be cleared after the sweep.
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };

    await fetchOpenPRsByUser("o/r", "bot", cache, mockGh);
    assertEquals(callCount, 1);

    // Simulate post-mutation invalidation following auto-merge enable.
    await cache.invalidate("o/r", "prs_bot");

    await fetchOpenPRsByUser("o/r", "bot", cache, mockGh);
    assertEquals(
      callCount,
      2,
      "post-invalidate read must hit the network (mutation visibility)",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("run_core deps cache - prs_recent_merged_${limit} cache miss then hit", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (args: string[]): Promise<string> => {
      callCount++;
      // Verify the limit was passed through.
      const limitIndex = args.indexOf("--limit");
      assert(limitIndex >= 0, "expected --limit argument");
      assertEquals(args[limitIndex + 1], "10");
      return Promise.resolve(JSON.stringify([
        { number: 1, title: "T", changedFiles: 4 },
      ]));
    };

    const cold = await fetchRecentMergedPRs("o/r", 10, cache, mockGh);
    assertEquals(cold.length, 1);
    assertEquals(cold[0]?.changedFiles, 4);
    assertEquals(callCount, 1);

    const warm = await fetchRecentMergedPRs("o/r", 10, cache, mockGh);
    assertEquals(warm.length, 1);
    assertEquals(callCount, 1, "warm read must come from cache");
  } finally {
    await cleanup();
  }
});

Deno.test("run_core deps cache - prs_recent_merged_${limit} different limits are cached separately", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };

    await fetchRecentMergedPRs("o/r", 10, cache, mockGh);
    await fetchRecentMergedPRs("o/r", 20, cache, mockGh);
    assertEquals(
      callCount,
      2,
      "different limits must use distinct cache keys",
    );
  } finally {
    await cleanup();
  }
});
