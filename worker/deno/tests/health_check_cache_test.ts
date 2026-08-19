/**
 * Tests for the health check cache module (Issue #906).
 *
 * Following TDD: these tests define the expected behaviour for
 * file-based health check caching with configurable TTL.
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_HEALTH_CACHE_TTL,
  healthCacheFilePath,
  invalidateHealthCache,
  isHealthCacheValid,
  recordHealthCheckSuccess,
} from "../lib/health_check_cache.ts";

Deno.test("health_check_cache - DEFAULT_HEALTH_CACHE_TTL is 900 seconds", () => {
  assertEquals(DEFAULT_HEALTH_CACHE_TTL, 900);
});

Deno.test("health_check_cache - healthCacheFilePath returns correct path", () => {
  assertEquals(
    healthCacheFilePath("/tmp/work", "claude"),
    "/tmp/work/.health_cache_claude",
  );
  assertEquals(
    healthCacheFilePath("/home/user", "gh_auth"),
    "/home/user/.health_cache_gh_auth",
  );
});

Deno.test("health_check_cache - isHealthCacheValid returns false when no cache file", () => {
  const result = isHealthCacheValid("/tmp/nonexistent_dir_test", "test_check");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("health_check_cache - recordHealthCheckSuccess creates cache file", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    const result = recordHealthCheckSuccess(
      tmpDir,
      "test_check",
      () => fixedTime,
    );
    assertEquals(result.ok, true);

    const content = Deno.readTextFileSync(`${tmpDir}/.health_cache_test_check`);
    assertEquals(content, "1700000000");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - isHealthCacheValid returns true for fresh cache", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordHealthCheckSuccess(tmpDir, "test_check", () => fixedTime);

    // 60 seconds later — within 300s TTL
    const result = isHealthCacheValid(
      tmpDir,
      "test_check",
      300,
      () => fixedTime + 60,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, true);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - isHealthCacheValid returns false for expired cache", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordHealthCheckSuccess(tmpDir, "test_check", () => fixedTime);

    // 301 seconds later — past 300s TTL
    const result = isHealthCacheValid(
      tmpDir,
      "test_check",
      300,
      () => fixedTime + 301,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, false);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - isHealthCacheValid returns false for exactly-at-TTL", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordHealthCheckSuccess(tmpDir, "test_check", () => fixedTime);

    // Exactly at TTL boundary — not valid (uses < not <=)
    const result = isHealthCacheValid(
      tmpDir,
      "test_check",
      300,
      () => fixedTime + 300,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, false);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - isHealthCacheValid returns false for garbage data", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      `${tmpDir}/.health_cache_test_check`,
      "not-a-number",
    );

    const result = isHealthCacheValid(
      tmpDir,
      "test_check",
      300,
      () => 1700000000,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, false);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - isHealthCacheValid returns false for empty file", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(`${tmpDir}/.health_cache_test_check`, "");

    const result = isHealthCacheValid(
      tmpDir,
      "test_check",
      300,
      () => 1700000000,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, false);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - invalidateHealthCache removes cache file", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    recordHealthCheckSuccess(tmpDir, "test_check", () => 1700000000);

    // Verify file exists
    const content = Deno.readTextFileSync(`${tmpDir}/.health_cache_test_check`);
    assertEquals(content, "1700000000");

    // Invalidate
    const result = invalidateHealthCache(tmpDir, "test_check");
    assertEquals(result.ok, true);

    // Verify file is gone
    let fileExists = true;
    try {
      Deno.statSync(`${tmpDir}/.health_cache_test_check`);
    } catch {
      fileExists = false;
    }
    assertEquals(fileExists, false);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - invalidateHealthCache succeeds when file does not exist", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const result = invalidateHealthCache(tmpDir, "nonexistent_check");
    assertEquals(result.ok, true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - custom TTL is respected", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordHealthCheckSuccess(tmpDir, "test_check", () => fixedTime);

    // Custom TTL of 60 seconds — 30s later should still be valid
    const validResult = isHealthCacheValid(
      tmpDir,
      "test_check",
      60,
      () => fixedTime + 30,
    );
    assertEquals(validResult.ok, true);
    if (validResult.ok) {
      assertEquals(validResult.value, true);
    }

    // 61s later should be expired
    const expiredResult = isHealthCacheValid(
      tmpDir,
      "test_check",
      60,
      () => fixedTime + 61,
    );
    assertEquals(expiredResult.ok, true);
    if (expiredResult.ok) {
      assertEquals(expiredResult.value, false);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - default TTL uses 900s for multi-worker deployments (Issue #1070)", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordHealthCheckSuccess(tmpDir, "test_check", () => fixedTime);

    // 600 seconds later — within 900s TTL but past old 300s TTL
    const result = isHealthCacheValid(
      tmpDir,
      "test_check",
      DEFAULT_HEALTH_CACHE_TTL,
      () => fixedTime + 600,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, true);
    }

    // 901 seconds later — past 900s TTL
    const expiredResult = isHealthCacheValid(
      tmpDir,
      "test_check",
      DEFAULT_HEALTH_CACHE_TTL,
      () => fixedTime + 901,
    );
    assertEquals(expiredResult.ok, true);
    if (expiredResult.ok) {
      assertEquals(expiredResult.value, false);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("health_check_cache - multiple check types are independent", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordHealthCheckSuccess(tmpDir, "claude", () => fixedTime);
    recordHealthCheckSuccess(tmpDir, "gh_auth", () => fixedTime + 100);

    // Claude cache should be valid at fixedTime + 60
    const claudeResult = isHealthCacheValid(
      tmpDir,
      "claude",
      300,
      () => fixedTime + 60,
    );
    assertEquals(claudeResult.ok, true);
    if (claudeResult.ok) {
      assertEquals(claudeResult.value, true);
    }

    // GH auth cache should also be valid (recorded 100s later)
    const ghResult = isHealthCacheValid(
      tmpDir,
      "gh_auth",
      300,
      () => fixedTime + 160,
    );
    assertEquals(ghResult.ok, true);
    if (ghResult.ok) {
      assertEquals(ghResult.value, true);
    }

    // Invalidating claude should not affect gh_auth
    invalidateHealthCache(tmpDir, "claude");
    const claudeAfter = isHealthCacheValid(
      tmpDir,
      "claude",
      300,
      () => fixedTime + 60,
    );
    assertEquals(claudeAfter.ok, true);
    if (claudeAfter.ok) {
      assertEquals(claudeAfter.value, false);
    }

    const ghAfter = isHealthCacheValid(
      tmpDir,
      "gh_auth",
      300,
      () => fixedTime + 160,
    );
    assertEquals(ghAfter.ok, true);
    if (ghAfter.ok) {
      assertEquals(ghAfter.value, true);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
