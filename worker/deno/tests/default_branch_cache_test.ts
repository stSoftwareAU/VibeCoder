/**
 * Tests for the persistent default-branch cache (Issue #1509).
 *
 * The cache persists default-branch lookups to disk with a 7-day TTL so
 * we don't re-query the GitHub API every run_core cycle. Stale entries
 * can be invalidated when callers detect a branch has been renamed.
 *
 * **Fully migrated off the now-deleted `tests/support/env.ts` (Issues #944,
 * #969).** What the last three cases assert is the *resolution of the default
 * path itself* — that `WORK_DIR` unset means no cache directory at all
 * (Issue #132) and that the legacy `$HOME/.vibe-coder` location is not even
 * read. Both variables are read by `lib/worker_cache_dir.ts`, and
 * `defaultBranchCachePath` now hands it the `EnvLookup` it was given rather
 * than letting it reach the process environment on its own; the
 * legacy-fallback read inside `loadDefaultBranchCache` takes the same lookup.
 * So the suite states the environment it wants and mutates nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_BRANCH_CACHE_FILE,
  DEFAULT_BRANCH_CACHE_PATH_ENV,
  DEFAULT_BRANCH_CACHE_TTL_MS,
  defaultBranchCachePath,
  getCachedDefaultBranch,
  invalidateCachedDefaultBranch,
  loadDefaultBranchCache,
  saveDefaultBranchCache,
  setCachedDefaultBranch,
} from "../lib/default_branch_cache.ts";
import { workerCachePath } from "../lib/worker_cache_dir.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

async function tempCachePath(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-dbcache-" });
  return `${dir}/default-branch-cache.json`;
}

Deno.test("default_branch_cache - defaultBranchCachePath answers from the lookup it is given (Issue #964)", () => {
  // A path no host exports: a read that fell back to `Deno.env.get` would
  // return the worker cache path (or undefined) instead.
  const sentinel = "/tmp/sentinel-964/default-branch-cache.json";
  assertEquals(
    defaultBranchCachePath(
      envFrom({ [DEFAULT_BRANCH_CACHE_PATH_ENV]: sentinel }),
    ),
    sentinel,
  );

  // No override in the map means the worker cache directory decides, and an
  // empty override is not an override. The same lookup reaches
  // `workerCachePath`, so `WORK_DIR` in the map is the WORK_DIR that counts —
  // a resolution that fell through to the process environment would answer
  // with whatever the host running the suite happens to export (Issue #969).
  const onWorkVolume = envFrom({ WORK_DIR: "/vol/work" });
  assertEquals(
    defaultBranchCachePath(onWorkVolume),
    workerCachePath(DEFAULT_BRANCH_CACHE_FILE, { env: onWorkVolume }),
  );
  assertEquals(
    defaultBranchCachePath(onWorkVolume),
    "/vol/work/.vibe-cache/default-branch-cache.json",
  );
  assertEquals(
    defaultBranchCachePath(
      envFrom({ WORK_DIR: "/vol/work", [DEFAULT_BRANCH_CACHE_PATH_ENV]: "" }),
    ),
    "/vol/work/.vibe-cache/default-branch-cache.json",
  );

  // No WORK_DIR means no cache directory at all (Issue #131).
  assertEquals(defaultBranchCachePath(emptyEnv), undefined);
});

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
  // No WORK_DIR and no override: the resolver must answer "no cache at all".
  // HOME is named so the legacy fallback, if it were ever consulted, would
  // land inside this temp tree and be caught by the emptiness assertion below.
  const env = envFrom({ HOME: home });
  try {
    const path = defaultBranchCachePath(env);
    assertEquals(path, undefined);

    await setCachedDefaultBranch("owner/repo", "main", path, env);
    await invalidateCachedDefaultBranch("owner/repo", path, env);
    await saveDefaultBranchCache(
      new Map([["owner/repo", { branch: "main", fetchedAt: Date.now() }]]),
      path,
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
    assertEquals((await loadDefaultBranchCache(path, env)).size, 0);
    assertEquals(await getCachedDefaultBranch("owner/repo", path, env), null);
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("default_branch_cache - WORK_DIR unset: load does not even read the legacy HOME location (Issue #132)", async () => {
  const home = await Deno.makeTempDir({ prefix: "vibe-dbcache-home-" });
  const env = envFrom({ HOME: home });
  try {
    // Plant a valid legacy cache file at exactly the path the legacy
    // fallback would read for this lookup; with no cache directory the
    // load must ignore it entirely (no filesystem access at all).
    await Deno.mkdir(`${home}/.vibe-coder`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.vibe-coder/default-branch-cache.json`,
      JSON.stringify({
        "owner/repo": { branch: "main", fetchedAt: Date.now() },
      }),
    );

    const path = defaultBranchCachePath(env);
    assertEquals(path, undefined);
    assertEquals((await loadDefaultBranchCache(path, env)).size, 0);
    assertEquals(await getCachedDefaultBranch("owner/repo", path, env), null);
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("default_branch_cache - VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH stays honoured with WORK_DIR unset", async () => {
  const file = await tempCachePath();
  // An override with no WORK_DIR beside it: the override alone decides.
  const env = envFrom({ [DEFAULT_BRANCH_CACHE_PATH_ENV]: file });
  const path = defaultBranchCachePath(env);
  assertEquals(path, file);

  await setCachedDefaultBranch("owner/repo", "main", path, env);
  assertEquals(await getCachedDefaultBranch("owner/repo", path, env), "main");

  await invalidateCachedDefaultBranch("owner/repo", path, env);
  assertEquals(await getCachedDefaultBranch("owner/repo", path, env), null);
});

Deno.test("default_branch_cache - an explicit undefined path means no cache directory, not the default (Issue #969)", async () => {
  const work = await Deno.makeTempDir({ prefix: "vibe-dbcache-work-" });
  // A lookup that *does* resolve to a cache file. Passing on the `undefined`
  // a caller was handed must not silently re-resolve to it: a default
  // parameter fires on an explicit `undefined` as readily as on an omitted
  // argument, which is how the accessors used to write the very file they had
  // just reported did not exist (Issue #132's failure mode).
  const env = envFrom({ WORK_DIR: work });
  try {
    assertEquals(
      defaultBranchCachePath(env),
      `${work}/.vibe-cache/default-branch-cache.json`,
    );

    await setCachedDefaultBranch("owner/repo", "main", undefined, env);
    await invalidateCachedDefaultBranch("owner/repo", undefined, env);
    await saveDefaultBranchCache(
      new Map([["owner/repo", { branch: "main", fetchedAt: Date.now() }]]),
      undefined,
      env,
    );
    assertEquals((await loadDefaultBranchCache(undefined, env)).size, 0);
    assertEquals(
      await getCachedDefaultBranch("owner/repo", undefined, env),
      null,
    );

    // Nothing was created under the work volume the lookup names.
    const entries: string[] = [];
    for await (const entry of Deno.readDir(work)) entries.push(entry.name);
    assertEquals(entries, []);

    // Naming the path the same lookup resolves still writes there, so the
    // guard above is the explicit `undefined` and not a broken accessor.
    const resolved = defaultBranchCachePath(env);
    await setCachedDefaultBranch("owner/repo", "main", resolved, env);
    assertEquals(
      await getCachedDefaultBranch("owner/repo", resolved, env),
      "main",
    );
  } finally {
    await Deno.remove(work, { recursive: true }).catch(() => undefined);
  }
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
