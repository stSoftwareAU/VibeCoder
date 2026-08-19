/**
 * Tests for the durable Deno cache size guard (Issue #4302).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_DENO_CACHE_MAX_BYTES,
  denoCacheDir,
  guardDenoCache,
} from "../lib/deno_cache_guard.ts";

Deno.test("deno_cache_guard - path matches the entrypoint's DENO_DIR", () => {
  assertEquals(denoCacheDir("/work"), "/work/.deno-cache");
  assert(DEFAULT_DENO_CACHE_MAX_BYTES > 1024 * 1024 * 1024);
});

Deno.test("deno_cache_guard - absent cache is a clean no-op", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "deno_guard_" });
  try {
    const result = await guardDenoCache({ workDir });
    assertEquals(result.wiped, false);
    assertEquals(result.bytes, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("deno_cache_guard - a cache within the cap is preserved", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "deno_guard_" });
  try {
    const dir = denoCacheDir(workDir);
    await Deno.mkdir(`${dir}/deps`, { recursive: true });
    await Deno.writeTextFile(`${dir}/deps/module.ts`, "x".repeat(500));
    const result = await guardDenoCache({ workDir, maxBytes: 1000 });
    assertEquals(result.wiped, false);
    assertEquals(result.bytes, 500);
    await Deno.stat(`${dir}/deps/module.ts`);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("deno_cache_guard - a cache over the cap is wiped entirely", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "deno_guard_" });
  try {
    const dir = denoCacheDir(workDir);
    await Deno.mkdir(`${dir}/deps/nested`, { recursive: true });
    await Deno.writeTextFile(`${dir}/deps/a.ts`, "x".repeat(600));
    await Deno.writeTextFile(`${dir}/deps/nested/b.ts`, "x".repeat(600));
    const result = await guardDenoCache({ workDir, maxBytes: 1000 });
    assertEquals(result.wiped, true);
    assertEquals(result.bytes, 1200);
    assertStringIncludes(result.message, "wiped");
    let exists = true;
    try {
      await Deno.stat(dir);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
