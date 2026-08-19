/**
 * Tests for shell_helpers module (Issue #964, Issue #1509).
 *
 * Covers sleepWithJitter, getRepoDefaultBranch, and the persistent
 * default-branch cache integration.
 */

import { assertEquals } from "@std/assert";
import {
  calculateJitter,
  clearDefaultBranchMemoryCache,
  getRepoDefaultBranch,
  invalidateDefaultBranch,
  sleepWithJitter,
} from "../lib/shell_helpers.ts";
import {
  getCachedDefaultBranch,
  setCachedDefaultBranch,
} from "../lib/default_branch_cache.ts";

const CACHE_ENV = "VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH";

async function withIsolatedCache<T>(
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-dbcache-shell-" });
  const path = `${dir}/cache.json`;
  const previous = Deno.env.get(CACHE_ENV);
  Deno.env.set(CACHE_ENV, path);
  clearDefaultBranchMemoryCache();
  try {
    return await fn(path);
  } finally {
    if (previous === undefined) {
      Deno.env.delete(CACHE_ENV);
    } else {
      Deno.env.set(CACHE_ENV, previous);
    }
    clearDefaultBranchMemoryCache();
  }
}

// =============================================================================
// calculateJitter tests
// =============================================================================

Deno.test("shell_helpers - calculateJitter returns value within expected range", () => {
  // With base 100, jitter should be between 50% and 150% of base
  // i.e., between 50 and 150
  for (let i = 0; i < 50; i++) {
    const result = calculateJitter(100);
    assertEquals(result >= 50, true, `Expected >= 50, got ${result}`);
    assertEquals(result <= 150, true, `Expected <= 150, got ${result}`);
  }
});

Deno.test("shell_helpers - calculateJitter returns integer values", () => {
  for (let i = 0; i < 20; i++) {
    const result = calculateJitter(60);
    assertEquals(
      Number.isInteger(result),
      true,
      `Expected integer, got ${result}`,
    );
  }
});

Deno.test("shell_helpers - calculateJitter with zero base returns zero", () => {
  const result = calculateJitter(0);
  assertEquals(result, 0);
});

Deno.test("shell_helpers - calculateJitter with small base still produces valid range", () => {
  for (let i = 0; i < 20; i++) {
    const result = calculateJitter(2);
    assertEquals(result >= 1, true, `Expected >= 1, got ${result}`);
    assertEquals(result <= 3, true, `Expected <= 3, got ${result}`);
  }
});

Deno.test("shell_helpers - calculateJitter with negative base returns zero", () => {
  const result = calculateJitter(-10);
  assertEquals(result, 0);
});

// =============================================================================
// sleepWithJitter tests
// =============================================================================

Deno.test("shell_helpers - sleepWithJitter resolves for zero base", async () => {
  // calculateJitter(0) === 0, so sleepWithJitter(0) takes the early-return
  // path and resolves without scheduling a timer. Issue #2434: assert the
  // observable contract (resolves to undefined) rather than a wall-clock
  // threshold, which depends on machine speed and CI load. Race against a
  // generous deadline so a genuine hang (not slowness) still fails the test.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("sleepWithJitter(0) hung")),
      30_000,
    );
  });
  try {
    const result = await Promise.race([sleepWithJitter(0), deadline]);
    assertEquals(result, undefined);
  } finally {
    clearTimeout(timeoutId);
  }
});

// =============================================================================
// getRepoDefaultBranch — persistent cache integration (Issue #1509)
// =============================================================================

Deno.test("shell_helpers - getRepoDefaultBranch rejects empty repo", async () => {
  const result = await getRepoDefaultBranch("");
  assertEquals(result.ok, false);
});

Deno.test("shell_helpers - getRepoDefaultBranch returns cached value without calling gh", async () => {
  await withIsolatedCache(async () => {
    await setCachedDefaultBranch("owner/repo", "main");

    const result = await getRepoDefaultBranch("owner/repo");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "main");
    }
  });
});

Deno.test("shell_helpers - invalidateDefaultBranch removes the persistent entry", async () => {
  await withIsolatedCache(async (path) => {
    await setCachedDefaultBranch("owner/repo", "main");
    // Prime the in-memory cache too so we can prove it was cleared.
    await getRepoDefaultBranch("owner/repo");

    await invalidateDefaultBranch("owner/repo");

    const cached = await getCachedDefaultBranch("owner/repo", path);
    assertEquals(cached, null);
  });
});

Deno.test("shell_helpers - invalidateDefaultBranch tolerates empty repo", async () => {
  // Should not throw
  await invalidateDefaultBranch("");
});
