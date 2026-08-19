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
