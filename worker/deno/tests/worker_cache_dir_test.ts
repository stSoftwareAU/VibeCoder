/**
 * Tests for the worker cache directory resolver (Issue #4318).
 *
 * Migrated off the now-deleted `tests/support/env.ts` (Issues #944, #969):
 * every variable the resolver reads — `WORK_DIR`, `HOME`, `USERPROFILE` — now
 * arrives through the `env` seam `WorkerCacheDirOptions` already carried, so
 * the suite states the environment it wants instead of writing one into the
 * process every parallel worker shares.
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
import {
  defaultBranchCachePath,
  loadDefaultBranchCache,
} from "../lib/default_branch_cache.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

Deno.test("worker_cache_dir - WORK_DIR set: `${WORK_DIR}/.vibe-cache` exactly", () => {
  const env = envFrom({ WORK_DIR: "/vol/work", HOME: "/Users/op" });
  assertEquals(workerCacheDir({ env }), "/vol/work/.vibe-cache");
  assertEquals(
    workerCachePath("x.json", { env }),
    "/vol/work/.vibe-cache/x.json",
  );
  assertEquals(
    legacyHomeCachePath("x.json", { env }),
    "/Users/op/.vibe-coder/x.json",
  );
});

Deno.test("worker_cache_dir - WORK_DIR unset: no cache dir at all, never a HOME/USERPROFILE/'.' fallback (Issue #131)", () => {
  const withHome = envFrom({ HOME: "/Users/op", USERPROFILE: "C:\\Users\\op" });
  assertEquals(workerCacheDir({ env: withHome }), undefined);
  assertEquals(workerCachePath("x.json", { env: withHome }), undefined);

  // Even with no HOME/USERPROFILE either, "." must not be used.
  assertEquals(workerCacheDir({ env: emptyEnv }), undefined);
  assertEquals(workerCachePath("x.json", { env: emptyEnv }), undefined);
});

Deno.test("worker_cache_dir - the legacy HOME file is read when the new one is absent, and ignored once it exists", async () => {
  const root = await Deno.makeTempDir({ prefix: "wcd_" });
  const home = `${root}/home`;
  const work = `${root}/work`;
  await Deno.mkdir(`${home}/.vibe-coder`, { recursive: true });
  await Deno.mkdir(`${work}/.vibe-cache`, { recursive: true });
  const env = envFrom({ WORK_DIR: work, HOME: home });
  try {
    await Deno.writeTextFile(`${home}/.vibe-coder/c.json`, "legacy");
    assertEquals(
      await readCacheWithLegacyFallback("c.json", { env }),
      "legacy",
    );
    await Deno.writeTextFile(`${work}/.vibe-cache/c.json`, "new");
    assertEquals(await readCacheWithLegacyFallback("c.json", { env }), "new");
    assertEquals(
      await readCacheWithLegacyFallback("missing.json", { env }),
      null,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("worker_cache_dir - the default-branch cache migrates: legacy file readable at the new default path (Issue #4318)", async () => {
  const root = await Deno.makeTempDir({ prefix: "wcd_" });
  const home = `${root}/home`;
  const work = `${root}/work`;
  await Deno.mkdir(`${home}/.vibe-coder`, { recursive: true });
  const env = envFrom({ WORK_DIR: work, HOME: home });
  try {
    await Deno.writeTextFile(
      `${home}/.vibe-coder/default-branch-cache.json`,
      JSON.stringify({
        "o/r": { branch: "main", fetchedAt: Date.now() },
      }),
    );
    const cache = await loadDefaultBranchCache(
      defaultBranchCachePath(env),
      env,
    );
    assertEquals(cache.get("o/r")?.branch, "main");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
