/**
 * Tests for the persistent default-branch cache (Issue #1509).
 *
 * The cache persists default-branch lookups to disk with a 7-day TTL so
 * we don't re-query the GitHub API every run_core cycle. Stale entries
 * can be invalidated when callers detect a branch has been renamed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_BRANCH_CACHE_TTL_MS,
  defaultBranchCachePath,
  getCachedDefaultBranch,
  invalidateCachedDefaultBranch,
  loadDefaultBranchCache,
  saveDefaultBranchCache,
  setCachedDefaultBranch,
} from "../lib/default_branch_cache.ts";

async function tempCachePath(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-dbcache-" });
  return `${dir}/default-branch-cache.json`;
}

/** Run `fn` with env vars temporarily set (undefined = unset), restoring after. */
function withEnv(
  values: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) saved[key] = Deno.env.get(key);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  });
}

Deno.test("default_branch_cache - TTL constant is 7 days", () => {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  assertEquals(DEFAULT_BRANCH_CACHE_TTL_MS, sevenDaysMs);
});

Deno.test("default_branch_cache - loadDefaultBranchCache returns empty map when file missing", async () => {
  const path = await tempCachePath();
  const cache = await loadDefaultBranchCache(path);
  assertEquals(cache.size, 0);
});

Deno.test("default_branch_cache - saveDefaultBranchCache round-trips with loadDefaultBranchCache", async () => {
  const path = await tempCachePath();
  const now = Date.now();

  const original = new Map([
    ["owner/repo1", { branch: "main", fetchedAt: now }],
    ["owner/repo2", { branch: "develop", fetchedAt: now - 1000 }],
  ]);

  await saveDefaultBranchCache(original, path);
  const reloaded = await loadDefaultBranchCache(path);

  assertEquals(reloaded.size, 2);
  assertEquals(reloaded.get("owner/repo1"), { branch: "main", fetchedAt: now });
  assertEquals(reloaded.get("owner/repo2"), {
    branch: "develop",
    fetchedAt: now - 1000,
  });
});

Deno.test("default_branch_cache - getCachedDefaultBranch returns value on cache hit", async () => {
  const path = await tempCachePath();
  await setCachedDefaultBranch("owner/repo", "main", path);

  const branch = await getCachedDefaultBranch("owner/repo", path);
  assertEquals(branch, "main");
});

Deno.test("default_branch_cache - getCachedDefaultBranch returns null on cache miss", async () => {
  const path = await tempCachePath();

  const branch = await getCachedDefaultBranch("owner/unknown", path);
  assertEquals(branch, null);
});

Deno.test("default_branch_cache - getCachedDefaultBranch returns null when entry is expired", async () => {
  const path = await tempCachePath();
  const stale = Date.now() - DEFAULT_BRANCH_CACHE_TTL_MS - 1000;

  const cache = new Map([
    ["owner/repo", { branch: "main", fetchedAt: stale }],
  ]);
  await saveDefaultBranchCache(cache, path);

  const branch = await getCachedDefaultBranch("owner/repo", path);
  assertEquals(branch, null);
});

Deno.test("default_branch_cache - getCachedDefaultBranch returns value just inside TTL window", async () => {
  const path = await tempCachePath();
  const justFresh = Date.now() - DEFAULT_BRANCH_CACHE_TTL_MS + 60_000;

  const cache = new Map([
    ["owner/repo", { branch: "main", fetchedAt: justFresh }],
  ]);
  await saveDefaultBranchCache(cache, path);

  const branch = await getCachedDefaultBranch("owner/repo", path);
  assertEquals(branch, "main");
});

Deno.test("default_branch_cache - setCachedDefaultBranch overwrites existing entry", async () => {
  const path = await tempCachePath();
  await setCachedDefaultBranch("owner/repo", "main", path);
  await setCachedDefaultBranch("owner/repo", "develop", path);

  const branch = await getCachedDefaultBranch("owner/repo", path);
  assertEquals(branch, "develop");
});

Deno.test("default_branch_cache - invalidateCachedDefaultBranch removes entry", async () => {
  const path = await tempCachePath();
  await setCachedDefaultBranch("owner/repo", "main", path);

  await invalidateCachedDefaultBranch("owner/repo", path);

  const branch = await getCachedDefaultBranch("owner/repo", path);
  assertEquals(branch, null);
});

Deno.test("default_branch_cache - invalidateCachedDefaultBranch is a no-op for missing entry", async () => {
  const path = await tempCachePath();
  // Should not throw
  await invalidateCachedDefaultBranch("owner/missing", path);

  const cache = await loadDefaultBranchCache(path);
  assertEquals(cache.size, 0);
});

Deno.test("default_branch_cache - loadDefaultBranchCache tolerates corrupt JSON", async () => {
  const path = await tempCachePath();
  await Deno.writeTextFile(path, "not json at all {");

  const cache = await loadDefaultBranchCache(path);
  assertEquals(cache.size, 0);
});

Deno.test("default_branch_cache - WORK_DIR unset: save/set/invalidate create no directory or file anywhere (Issue #132)", async () => {
  const home = await Deno.makeTempDir({ prefix: "vibe-dbcache-home-" });
  try {
    await withEnv(
      {
        WORK_DIR: undefined,
        VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH: undefined,
        HOME: home,
      },
      async () => {
        assertEquals(defaultBranchCachePath(), undefined);

        await setCachedDefaultBranch("owner/repo", "main");
        await invalidateCachedDefaultBranch("owner/repo");
        await saveDefaultBranchCache(
          new Map([["owner/repo", { branch: "main", fetchedAt: Date.now() }]]),
        );

        // The parent directory the old HOME-derived default used to
        // create (Issue #118) must be ABSENT — not merely empty.
        let strayExists = true;
        try {
          await Deno.stat(`${home}/auto-issue-work`);
        } catch (err) {
          assertEquals(err instanceof Deno.errors.NotFound, true);
          strayExists = false;
        }
        assertEquals(strayExists, false);

        // Nothing at all may be created under HOME by the no-op calls.
        const entries: string[] = [];
        for await (const entry of Deno.readDir(home)) {
          entries.push(entry.name);
        }
        assertEquals(entries, []);

        // Reads return empty/null.
        assertEquals((await loadDefaultBranchCache()).size, 0);
        assertEquals(await getCachedDefaultBranch("owner/repo"), null);
      },
    );
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("default_branch_cache - WORK_DIR unset: load does not even read the legacy HOME location (Issue #132)", async () => {
  const home = await Deno.makeTempDir({ prefix: "vibe-dbcache-home-" });
  try {
    await withEnv(
      {
        WORK_DIR: undefined,
        VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH: undefined,
        HOME: home,
      },
      async () => {
        // Plant a valid legacy cache file; with no cache directory the
        // load must ignore it entirely (no filesystem access at all).
        await Deno.mkdir(`${home}/.vibe-coder`, { recursive: true });
        await Deno.writeTextFile(
          `${home}/.vibe-coder/default-branch-cache.json`,
          JSON.stringify({
            "owner/repo": { branch: "main", fetchedAt: Date.now() },
          }),
        );

        assertEquals((await loadDefaultBranchCache()).size, 0);
        assertEquals(await getCachedDefaultBranch("owner/repo"), null);
      },
    );
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("default_branch_cache - VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH stays honoured with WORK_DIR unset", async () => {
  const path = await tempCachePath();
  await withEnv(
    {
      WORK_DIR: undefined,
      VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH: path,
    },
    async () => {
      assertEquals(defaultBranchCachePath(), path);

      await setCachedDefaultBranch("owner/repo", "main");
      assertEquals(await getCachedDefaultBranch("owner/repo"), "main");

      await invalidateCachedDefaultBranch("owner/repo");
      assertEquals(await getCachedDefaultBranch("owner/repo"), null);
    },
  );
});

Deno.test("default_branch_cache - saveDefaultBranchCache creates parent directory if missing", async () => {
  const baseDir = await Deno.makeTempDir({ prefix: "vibe-dbcache-" });
  const path = `${baseDir}/nested/sub/default-branch-cache.json`;

  const cache = new Map([
    ["owner/repo", { branch: "main", fetchedAt: Date.now() }],
  ]);
  await saveDefaultBranchCache(cache, path);

  const reloaded = await loadDefaultBranchCache(path);
  assertEquals(reloaded.size, 1);
});
