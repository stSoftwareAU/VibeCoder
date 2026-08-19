/**
 * Tests for the file-backed pre-flight cache (Issue #1675).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_PREFLIGHT_CACHE_TTL_SECONDS,
  rateLimitPreflightCachePath,
  readPreflightCache,
  shouldCachePreflight,
  writePreflightCache,
} from "../lib/rate_limit_preflight_cache.ts";

Deno.test("preflight cache - write then read returns the same payload", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const writeRes = await writePreflightCache(tmpDir, {
      timestamp: 1000,
      remaining: 4500,
      limit: 5000,
      reset: 6000,
    });
    assertEquals(writeRes.ok, true);

    const readRes = await readPreflightCache(tmpDir, () => 1010);
    assertEquals(readRes.ok, true);
    if (readRes.ok) {
      assertEquals(readRes.value.remaining, 4500);
      assertEquals(readRes.value.limit, 5000);
      assertEquals(readRes.value.reset, 6000);
      assertEquals(readRes.value.timestamp, 1000);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflight cache - missing file is a cache miss", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const res = await readPreflightCache(tmpDir, () => 0);
    assertEquals(res.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflight cache - entry older than TTL is treated as miss", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writePreflightCache(tmpDir, {
      timestamp: 1000,
      remaining: 4500,
      limit: 5000,
      reset: 6000,
    });
    // now is 1000 + DEFAULT_TTL + 1 → stale.
    const res = await readPreflightCache(
      tmpDir,
      () => 1000 + DEFAULT_PREFLIGHT_CACHE_TTL_SECONDS + 1,
    );
    assertEquals(res.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflight cache - entry inside TTL is a hit", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writePreflightCache(tmpDir, {
      timestamp: 1000,
      remaining: 4500,
      limit: 5000,
      reset: 6000,
    });
    const res = await readPreflightCache(
      tmpDir,
      () => 1000 + DEFAULT_PREFLIGHT_CACHE_TTL_SECONDS,
    );
    assertEquals(res.ok, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflight cache - malformed JSON is a cache miss", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(rateLimitPreflightCachePath(tmpDir), "not json");
    const res = await readPreflightCache(tmpDir, () => 0);
    assertEquals(res.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflight cache - schema-invalid file is a cache miss", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      rateLimitPreflightCachePath(tmpDir),
      JSON.stringify({ timestamp: "not a number" }),
    );
    const res = await readPreflightCache(tmpDir, () => 0);
    assertEquals(res.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflight cache - shouldCachePreflight requires 2x threshold", () => {
  // Below threshold → never cache.
  assertEquals(shouldCachePreflight(0, 50), false);
  assertEquals(shouldCachePreflight(49, 50), false);
  // Within 2x threshold → do not cache.
  assertEquals(shouldCachePreflight(50, 50), false);
  assertEquals(shouldCachePreflight(99, 50), false);
  // At or above 2x threshold → cache.
  assert(shouldCachePreflight(100, 50));
  assert(shouldCachePreflight(5000, 50));
});
