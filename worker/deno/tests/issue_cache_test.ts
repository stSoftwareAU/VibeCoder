/**
 * Tests for issue_cache.ts (Issue #910).
 */

import { assertEquals, assertExists } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";

/**
 * Create a temporary cache directory for testing.
 */
function createTestCache(ttl = 60): { cache: IssueCache; dir: string } {
  const dir = Deno.makeTempDirSync({ prefix: "issue-cache-test-" });
  return { cache: new IssueCache(dir, ttl), dir };
}

Deno.test("issue_cache - write and read back data", async () => {
  const { cache, dir } = createTestCache();
  try {
    await cache.write("owner/repo", "test_key", { count: 42 });
    const result = await cache.read<{ count: number }>(
      "owner/repo",
      "test_key",
    );
    assertExists(result);
    assertEquals(result.count, 42);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("issue_cache - returns null for missing key", async () => {
  const { cache, dir } = createTestCache();
  try {
    const result = await cache.read("owner/repo", "missing");
    assertEquals(result, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("issue_cache - returns null for expired entry", async () => {
  // TTL=0 means any entry is immediately expired (age >= 0 is not < 0)
  const { cache, dir } = createTestCache(0);
  try {
    await cache.write("owner/repo", "expired", { data: "old" });
    const result = await cache.read("owner/repo", "expired");
    assertEquals(result, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("issue_cache - invalidate removes specific entry", async () => {
  const { cache, dir } = createTestCache();
  try {
    await cache.write("owner/repo", "key1", "data1");
    await cache.write("owner/repo", "key2", "data2");

    await cache.invalidate("owner/repo", "key1");

    assertEquals(await cache.read("owner/repo", "key1"), null);
    assertEquals(await cache.read("owner/repo", "key2"), "data2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("issue_cache - invalidateRepo removes all entries for a repo", async () => {
  const { cache, dir } = createTestCache();
  try {
    await cache.write("owner/repo1", "key", "data1");
    await cache.write("owner/repo2", "key", "data2");

    await cache.invalidateRepo("owner/repo1");

    assertEquals(await cache.read("owner/repo1", "key"), null);
    assertEquals(await cache.read("owner/repo2", "key"), "data2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("issue_cache - tracks statistics", async () => {
  const { cache, dir } = createTestCache();
  try {
    cache.resetStats();

    // Miss
    await cache.read("owner/repo", "missing");
    assertEquals(cache.getStats().misses, 1);
    assertEquals(cache.getStats().hits, 0);

    // Write then hit
    await cache.write("owner/repo", "key1", "data");
    await cache.read("owner/repo", "key1");
    assertEquals(cache.getStats().hits, 1);
    assertEquals(cache.getStats().saved, 1);

    // Reset
    cache.resetStats();
    assertEquals(cache.getStats().hits, 0);
    assertEquals(cache.getStats().misses, 0);
    assertEquals(cache.getStats().saved, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("issue_cache - handles array data", async () => {
  const { cache, dir } = createTestCache();
  try {
    const data = [
      { number: 1, title: "Issue 1" },
      { number: 2, title: "Issue 2" },
    ];
    await cache.write("owner/repo", "issues", data);
    const result = await cache.read<Array<{ number: number; title: string }>>(
      "owner/repo",
      "issues",
    );
    assertExists(result);
    assertEquals(result.length, 2);
    assertEquals(result[0]?.number, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
