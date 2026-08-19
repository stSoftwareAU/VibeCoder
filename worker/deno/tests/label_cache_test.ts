/**
 * Tests for the per-repo label cache (Issue #333) — pagination guard added
 * by Issue #4337.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { getCachedLabels, labelCacheInvalidate } from "../lib/label_cache.ts";

Deno.test("label cache - lists labels beyond gh's default page of 30 (Issue #4337)", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "label_cache_4337_" });
  const seen: string[][] = [];
  try {
    const result = await getCachedLabels(
      cacheDir,
      "o/r",
      3600,
      (args: string[]) => {
        seen.push(args);
        return Promise.resolve("a\nb\n");
      },
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, ["a", "b"]);
    const listCall = seen.find((a) => a[0] === "label" && a[1] === "list");
    assertEquals(listCall !== undefined, true, "expected a gh label list call");
    const limitIndex = listCall!.indexOf("--limit");
    assertEquals(limitIndex > 0, true, "gh label list must pass --limit");
    assertEquals(Number(listCall![limitIndex + 1]) >= 100, true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("label cache - a cached list is served without a gh call until invalidated", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "label_cache_" });
  let calls = 0;
  const gh = () => {
    calls++;
    return Promise.resolve("x\n");
  };
  try {
    await getCachedLabels(cacheDir, "o/r", 3600, gh);
    await getCachedLabels(cacheDir, "o/r", 3600, gh);
    assertEquals(calls, 1);
    await labelCacheInvalidate(cacheDir, "o/r");
    await getCachedLabels(cacheDir, "o/r", 3600, gh);
    assertEquals(calls, 2);
  } finally {
    await Deno.remove(cacheDir, { recursive: true }).catch(() => undefined);
  }
});
