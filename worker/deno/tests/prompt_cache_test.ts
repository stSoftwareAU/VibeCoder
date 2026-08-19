/**
 * Tests for prompt compilation cache with SHA-based invalidation (Issue #1272).
 *
 * Written TDD-first — these tests define the expected behaviour of the
 * PromptCache class before the implementation is written.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { PromptCache } from "../lib/prompt_cache.ts";

/** Create a temporary cache directory and a PromptCache instance. */
async function createTestCache(
  options?: { ttlSeconds?: number; nowFn?: () => number },
): Promise<{ cache: PromptCache; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "prompt-cache-test-" });
  const cache = new PromptCache({
    cacheDir: dir,
    ttlSeconds: options?.ttlSeconds,
    now: options?.nowFn,
  });
  return { cache, dir };
}

/** Helper to clean up a temporary directory. */
async function cleanup(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore — may already be removed
  }
}

// --- Cache miss (first call) ---

Deno.test("prompt cache - cache miss returns null", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const result = await cache.get("org/repo", "abc123def456");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, null);
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Cache write and hit ---

Deno.test("prompt cache - write then read returns cached content", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "aabbccdd" + "0".repeat(56);
    const content = "This is the assembled static prompt content.";

    const writeResult = await cache.set("org/repo", sha, content);
    assertEquals(writeResult.ok, true);

    const readResult = await cache.get("org/repo", sha);
    assertEquals(readResult.ok, true);
    if (readResult.ok) {
      assertEquals(readResult.value, content);
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Cache hit returns stored content without re-reading ---

Deno.test("prompt cache - cache hit returns identical content", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "1234567890abcdef" + "0".repeat(48);
    const content = "Static prompt: coding guidelines + issue template";

    await cache.set("org/repo", sha, content);

    // Multiple reads should return the same content
    const result1 = await cache.get("org/repo", sha);
    const result2 = await cache.get("org/repo", sha);

    assertEquals(result1.ok, true);
    assertEquals(result2.ok, true);
    if (result1.ok && result2.ok) {
      assertEquals(result1.value, content);
      assertEquals(result2.value, content);
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Cache invalidation on SHA change ---

Deno.test("prompt cache - different SHA returns null (cache miss)", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha1 = "a".repeat(64);
    const sha2 = "b".repeat(64);
    const content = "Prompt content version 1";

    await cache.set("org/repo", sha1, content);

    // Reading with a different SHA should miss
    const result = await cache.get("org/repo", sha2);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, null);
    }
  } finally {
    await cleanup(dir);
  }
});

// --- TTL expiry ---

Deno.test("prompt cache - expired cache entry returns null", async () => {
  let currentTime = 1000;
  const { cache, dir } = await createTestCache({
    ttlSeconds: 60,
    nowFn: () => currentTime,
  });
  try {
    const sha = "c".repeat(64);
    await cache.set("org/repo", sha, "Cached content");

    // Advance time past the TTL
    currentTime = 1000 + 61;
    const result = await cache.get("org/repo", sha);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, null);
    }
  } finally {
    await cleanup(dir);
  }
});

Deno.test("prompt cache - cache entry within TTL returns content", async () => {
  let currentTime = 1000;
  const { cache, dir } = await createTestCache({
    ttlSeconds: 60,
    nowFn: () => currentTime,
  });
  try {
    const sha = "d".repeat(64);
    await cache.set("org/repo", sha, "Still fresh content");

    // Advance time but still within TTL
    currentTime = 1000 + 59;
    const result = await cache.get("org/repo", sha);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "Still fresh content");
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Old cache cleanup ---

Deno.test("prompt cache - cleanupRepo removes old cache files for the same repo", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha1 = "e".repeat(64);
    const sha2 = "f".repeat(64);

    // Write with old SHA
    await cache.set("org/repo", sha1, "Old content");

    // Verify old cache exists
    const beforeCleanup = await cache.get("org/repo", sha1);
    assertEquals(beforeCleanup.ok, true);
    if (beforeCleanup.ok) {
      assertEquals(beforeCleanup.value, "Old content");
    }

    // Clean up old entries and write with new SHA
    await cache.cleanupRepo("org/repo");
    await cache.set("org/repo", sha2, "New content");

    // Old SHA should be gone
    const oldResult = await cache.get("org/repo", sha1);
    assertEquals(oldResult.ok, true);
    if (oldResult.ok) {
      assertEquals(oldResult.value, null);
    }

    // New SHA should exist
    const newResult = await cache.get("org/repo", sha2);
    assertEquals(newResult.ok, true);
    if (newResult.ok) {
      assertEquals(newResult.value, "New content");
    }
  } finally {
    await cleanup(dir);
  }
});

Deno.test("prompt cache - cleanup does not affect other repos", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "a1b2c3d4" + "0".repeat(56);

    await cache.set("org/repo-a", sha, "Repo A content");
    await cache.set("org/repo-b", sha, "Repo B content");

    // Clean up only repo-a
    await cache.cleanupRepo("org/repo-a");

    // Repo A should be gone
    const resultA = await cache.get("org/repo-a", sha);
    assertEquals(resultA.ok, true);
    if (resultA.ok) {
      assertEquals(resultA.value, null);
    }

    // Repo B should still exist
    const resultB = await cache.get("org/repo-b", sha);
    assertEquals(resultB.ok, true);
    if (resultB.ok) {
      assertEquals(resultB.value, "Repo B content");
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Concurrent access safety (atomic writes) ---

Deno.test("prompt cache - concurrent writes do not corrupt cache files", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "1".repeat(64);
    const content = "Concurrently written content";

    // Fire multiple writes concurrently
    const writes = Array.from(
      { length: 5 },
      () => cache.set("org/repo", sha, content),
    );
    const results = await Promise.all(writes);

    // All writes should succeed
    for (const result of results) {
      assertEquals(result.ok, true);
    }

    // Read should return valid content
    const readResult = await cache.get("org/repo", sha);
    assertEquals(readResult.ok, true);
    if (readResult.ok) {
      assertEquals(readResult.value, content);
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Error handling ---

Deno.test("prompt cache - get from non-existent directory returns null", async () => {
  const cache = new PromptCache({
    cacheDir: "/tmp/nonexistent-prompt-cache-dir-" + crypto.randomUUID(),
  });
  const result = await cache.get("org/repo", "x".repeat(64));
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

Deno.test("prompt cache - set creates cache directory if missing", async () => {
  const dir = `/tmp/prompt-cache-auto-create-${crypto.randomUUID()}`;
  const cache = new PromptCache({ cacheDir: dir });
  try {
    const result = await cache.set(
      "org/repo",
      "2".repeat(64),
      "Auto-created dir",
    );
    assertEquals(result.ok, true);

    const readResult = await cache.get("org/repo", "2".repeat(64));
    assertEquals(readResult.ok, true);
    if (readResult.ok) {
      assertEquals(readResult.value, "Auto-created dir");
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Default TTL ---

Deno.test("prompt cache - default TTL is 24 hours (86400 seconds)", () => {
  const cache = new PromptCache();
  assertEquals(cache.getTtlSeconds(), 86400);
});

// --- Cache file naming ---

Deno.test("prompt cache - repo names with slashes are safely encoded", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "3".repeat(64);
    await cache.set("org/my-repo", sha, "Content with slash in repo");
    const result = await cache.get("org/my-repo", sha);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "Content with slash in repo");
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Statistics ---

Deno.test("prompt cache - tracks hit and miss statistics", async () => {
  const { cache, dir } = await createTestCache();
  try {
    cache.resetStats();

    // Miss
    await cache.get("org/repo", "4".repeat(64));
    assertEquals(cache.getStats().misses, 1);
    assertEquals(cache.getStats().hits, 0);

    // Write then hit
    await cache.set("org/repo", "4".repeat(64), "Data");
    await cache.get("org/repo", "4".repeat(64));
    assertEquals(cache.getStats().hits, 1);
    assertEquals(cache.getStats().misses, 1);

    // Reset
    cache.resetStats();
    assertEquals(cache.getStats().hits, 0);
    assertEquals(cache.getStats().misses, 0);
  } finally {
    await cleanup(dir);
  }
});

// --- getOrSet convenience method ---

Deno.test("prompt cache - getOrSet calls assembler on cache miss", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "5".repeat(64);
    let assemblerCalled = false;

    const result = await cache.getOrSet("org/repo", sha, async () => {
      assemblerCalled = true;
      return { ok: true as const, value: "Assembled prompt content" };
    });

    assertEquals(assemblerCalled, true);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "Assembled prompt content");
    }
  } finally {
    await cleanup(dir);
  }
});

Deno.test("prompt cache - getOrSet returns cached content on hit without calling assembler", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "6".repeat(64);
    const content = "Pre-cached prompt content";

    // Prime the cache
    await cache.set("org/repo", sha, content);

    let assemblerCalled = false;
    const result = await cache.getOrSet("org/repo", sha, async () => {
      assemblerCalled = true;
      return { ok: true as const, value: "Should not be returned" };
    });

    assertEquals(assemblerCalled, false);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, content);
    }
  } finally {
    await cleanup(dir);
  }
});

Deno.test("prompt cache - getOrSet cleans up old cache files for repo on miss", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const oldSha = "7".repeat(64);
    const newSha = "8".repeat(64);

    // Prime with old SHA
    await cache.set("org/repo", oldSha, "Old prompt");

    // getOrSet with new SHA should clean up old entries
    await cache.getOrSet("org/repo", newSha, async () => {
      return { ok: true as const, value: "New prompt" };
    });

    // Old SHA entry should be cleaned up
    const oldResult = await cache.get("org/repo", oldSha);
    assertEquals(oldResult.ok, true);
    if (oldResult.ok) {
      assertEquals(oldResult.value, null);
    }

    // New SHA entry should exist
    const newResult = await cache.get("org/repo", newSha);
    assertEquals(newResult.ok, true);
    if (newResult.ok) {
      assertEquals(newResult.value, "New prompt");
    }
  } finally {
    await cleanup(dir);
  }
});

Deno.test("prompt cache - getOrSet propagates assembler errors", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "9".repeat(64);
    const result = await cache.getOrSet("org/repo", sha, async () => {
      return { ok: false as const, error: new Error("Assembly failed") };
    });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.message, "Assembly failed");
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Cache content is human-readable ---

Deno.test("prompt cache - cache files are human-readable plain text", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "a".repeat(64);
    const content = "Human-readable prompt content\nWith multiple lines\n";

    await cache.set("org/repo", sha, content);

    // Find the cache file and read it directly
    const repoKey = "org_repo";
    let cacheFileContent = "";
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name.startsWith(repoKey) && entry.name.endsWith(".cache.txt")) {
        cacheFileContent = await Deno.readTextFile(`${dir}/${entry.name}`);
        break;
      }
    }

    // The file should contain the actual prompt content (human-readable)
    assertNotEquals(cacheFileContent, "");
    assertEquals(
      cacheFileContent.includes("Human-readable prompt content"),
      true,
    );
  } finally {
    await cleanup(dir);
  }
});

// --- Multiline content ---

Deno.test("prompt cache - handles multiline prompt content correctly", async () => {
  const { cache, dir } = await createTestCache();
  try {
    const sha = "b".repeat(64);
    const content = `# Coding Guidelines

## Australian English
Use colour, behaviour, organisation.

## Testing
Follow TDD.
`;

    await cache.set("org/repo", sha, content);
    const result = await cache.get("org/repo", sha);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, content);
    }
  } finally {
    await cleanup(dir);
  }
});
