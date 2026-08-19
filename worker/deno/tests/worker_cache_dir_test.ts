/**
 * Tests for the worker cache directory resolver (Issue #4318).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  legacyHomeCachePath,
  readCacheWithLegacyFallback,
  workerCacheDir,
  workerCachePath,
} from "../lib/worker_cache_dir.ts";
import { loadDefaultBranchCache } from "../lib/default_branch_cache.ts";

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

Deno.test("worker_cache_dir - WORK_DIR wins; HOME/auto-issue-work is the fallback", async () => {
  await withEnv({ WORK_DIR: "/vol/work", HOME: "/Users/op" }, () => {
    assertEquals(workerCacheDir(), "/vol/work/.vibe-cache");
    assertEquals(workerCachePath("x.json"), "/vol/work/.vibe-cache/x.json");
    assertEquals(legacyHomeCachePath("x.json"), "/Users/op/.vibe-coder/x.json");
  });
  await withEnv({ WORK_DIR: undefined, HOME: "/Users/op" }, () => {
    assertEquals(workerCacheDir(), "/Users/op/auto-issue-work/.vibe-cache");
  });
});

Deno.test("worker_cache_dir - the legacy HOME file is read when the new one is absent, and ignored once it exists", async () => {
  const root = await Deno.makeTempDir({ prefix: "wcd_" });
  const home = `${root}/home`;
  const work = `${root}/work`;
  await Deno.mkdir(`${home}/.vibe-coder`, { recursive: true });
  await Deno.mkdir(`${work}/.vibe-cache`, { recursive: true });
  try {
    await withEnv({ WORK_DIR: work, HOME: home }, async () => {
      await Deno.writeTextFile(`${home}/.vibe-coder/c.json`, "legacy");
      assertEquals(await readCacheWithLegacyFallback("c.json"), "legacy");
      await Deno.writeTextFile(`${work}/.vibe-cache/c.json`, "new");
      assertEquals(await readCacheWithLegacyFallback("c.json"), "new");
      assertEquals(await readCacheWithLegacyFallback("missing.json"), null);
    });
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("worker_cache_dir - the default-branch cache migrates: legacy file readable at the new default path (Issue #4318)", async () => {
  const root = await Deno.makeTempDir({ prefix: "wcd_" });
  const home = `${root}/home`;
  const work = `${root}/work`;
  await Deno.mkdir(`${home}/.vibe-coder`, { recursive: true });
  try {
    await withEnv(
      {
        WORK_DIR: work,
        HOME: home,
        VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH: undefined,
      },
      async () => {
        await Deno.writeTextFile(
          `${home}/.vibe-coder/default-branch-cache.json`,
          JSON.stringify({
            "o/r": { branch: "main", fetchedAt: Date.now() },
          }),
        );
        const cache = await loadDefaultBranchCache();
        assertEquals(cache.get("o/r")?.branch, "main");
      },
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
