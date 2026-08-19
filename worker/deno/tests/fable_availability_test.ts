/**
 * Tests for the Fable-availability probe + cached read path (Issue #3230).
 *
 * Covers three layers:
 *   1. The value-bearing cache helpers (readFableAvailability /
 *      recordFableAvailability) with an injected clock — no real sleep.
 *   2. checkFableAvailable classification via a stubbed Claude runner.
 *   3. The checkFableAvailability orchestration (cache hit vs probe + record).
 *
 * @std/assert only.
 */

import { assert, assertEquals } from "@std/assert";
import {
  FABLE_CHECK_TYPE,
  healthCacheFilePath,
  readFableAvailability,
  recordFableAvailability,
} from "../lib/health_check_cache.ts";
import {
  checkFableAvailability,
  checkFableAvailable,
  type FableProbeRunner,
} from "../lib/claude_runner.ts";
import type { ClaudeExecutionResult } from "../lib/claude_executor.ts";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

Deno.test("readFableAvailability - returns unknown when cache file missing", () => {
  assertEquals(
    readFableAvailability("/tmp/nonexistent_fable_dir_3230"),
    "unknown",
  );
});

Deno.test("recordFableAvailability - writes value-bearing line to .health_cache_fable", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    const rec = recordFableAvailability(tmpDir, false, () => now);
    assertEquals(rec.ok, true);

    const content = Deno.readTextFileSync(
      healthCacheFilePath(tmpDir, FABLE_CHECK_TYPE),
    );
    assertEquals(content, "1700000000 unavailable");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("readFableAvailability - round-trips available and unavailable", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;

    recordFableAvailability(tmpDir, true, () => now);
    assertEquals(
      readFableAvailability(tmpDir, 900, () => now + 10),
      "available",
    );

    recordFableAvailability(tmpDir, false, () => now);
    assertEquals(
      readFableAvailability(tmpDir, 900, () => now + 10),
      "unavailable",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("readFableAvailability - a fresh unavailable is honoured for the full TTL", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    recordFableAvailability(tmpDir, false, () => now);

    // 899s later — still within the 900s TTL → honoured.
    assertEquals(
      readFableAvailability(tmpDir, 900, () => now + 899),
      "unavailable",
    );

    // 900s later — expired → unknown (optimistic caller falls back).
    assertEquals(
      readFableAvailability(tmpDir, 900, () => now + 900),
      "unknown",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("readFableAvailability - malformed content returns unknown", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const cacheFile = healthCacheFilePath(tmpDir, FABLE_CHECK_TYPE);
    for (
      const bad of [
        "",
        "garbage",
        "1700000000",
        "1700000000 maybe",
        "abc available",
      ]
    ) {
      Deno.writeTextFileSync(cacheFile, bad);
      assertEquals(
        readFableAvailability(tmpDir, 900, () => 1700000000),
        "unknown",
        `expected unknown for malformed content: ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// checkFableAvailable classification
// ---------------------------------------------------------------------------

/** Build a stubbed runner returning a fixed ClaudeExecutionResult. */
function stubRunner(
  value: Partial<ClaudeExecutionResult>,
): FableProbeRunner {
  return () =>
    Promise.resolve<Result<ClaudeExecutionResult>>({
      ok: true,
      value: {
        exitCode: 0,
        output: "",
        stderr: "",
        timedOut: false,
        ...value,
      },
    });
}

Deno.test("checkFableAvailable - exit 0 with output ⇒ available", async () => {
  const verdict = await checkFableAvailable(
    30,
    undefined,
    stubRunner({ exitCode: 0, output: "OK" }),
  );
  assertEquals(verdict, "available");
});

Deno.test("checkFableAvailable - model-unavailable error ⇒ unavailable", async () => {
  const verdict = await checkFableAvailable(
    30,
    undefined,
    stubRunner({
      exitCode: 1,
      output: "",
      stderr:
        "Error: Fable is restricted in your region due to export controls",
    }),
  );
  assertEquals(verdict, "unavailable");
});

Deno.test("checkFableAvailable - 403 forbidden ⇒ unavailable", async () => {
  const verdict = await checkFableAvailable(
    30,
    undefined,
    stubRunner({ exitCode: 1, output: "HTTP 403 forbidden" }),
  );
  assertEquals(verdict, "unavailable");
});

Deno.test("checkFableAvailable - rate-limit failure ⇒ available (optimistic)", async () => {
  const verdict = await checkFableAvailable(
    30,
    undefined,
    stubRunner({ exitCode: 1, output: "HTTP 429 rate limit exceeded, retry" }),
  );
  assertEquals(verdict, "available");
});

Deno.test("checkFableAvailable - timeout ⇒ available (optimistic)", async () => {
  const verdict = await checkFableAvailable(
    30,
    undefined,
    stubRunner({ exitCode: 124, output: "", timedOut: true }),
  );
  assertEquals(verdict, "available");
});

Deno.test("checkFableAvailable - runner error ⇒ available (optimistic)", async () => {
  const runner: FableProbeRunner = () =>
    Promise.resolve<Result<ClaudeExecutionResult>>({
      ok: false,
      error: new Error("spawn failed"),
    });
  const verdict = await checkFableAvailable(30, undefined, runner);
  assertEquals(verdict, "available");
});

// ---------------------------------------------------------------------------
// checkFableAvailability orchestration (cache hit vs probe + record)
// ---------------------------------------------------------------------------

Deno.test("checkFableAvailability - probes on cache miss, then serves a cache hit", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    let probeCalls = 0;
    const probe = (): Promise<"available" | "unavailable"> => {
      probeCalls++;
      return Promise.resolve("unavailable");
    };

    // First call: cache is empty → probe runs and records the verdict.
    const first = await checkFableAvailability({
      workDir: tmpDir,
      ttlSeconds: 900,
      probe,
      now: () => now,
    });
    assertEquals(first, "unavailable");
    assertEquals(probeCalls, 1);

    // The negative verdict is persisted for the TTL.
    assertEquals(
      readFableAvailability(tmpDir, 900, () => now + 60),
      "unavailable",
    );

    // Second call within TTL: cache hit → probe must NOT run again.
    const second = await checkFableAvailability({
      workDir: tmpDir,
      ttlSeconds: 900,
      probe,
      now: () => now + 60,
    });
    assertEquals(second, "unavailable");
    assertEquals(probeCalls, 1, "second call must be a cache hit");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("checkFableAvailability - re-probes after the TTL expires", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    let probeCalls = 0;
    const probe = (): Promise<"available" | "unavailable"> => {
      probeCalls++;
      return Promise.resolve("available");
    };

    await checkFableAvailability({
      workDir: tmpDir,
      ttlSeconds: 900,
      probe,
      now: () => now,
    });
    assertEquals(probeCalls, 1);

    // 900s later the cache is stale → probe runs again.
    await checkFableAvailability({
      workDir: tmpDir,
      ttlSeconds: 900,
      probe,
      now: () => now + 900,
    });
    assertEquals(probeCalls, 2);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("checkFableAvailability - a throwing probe is treated as available and never throws", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    const probe = (): Promise<"available" | "unavailable"> => {
      throw new Error("boom");
    };

    const verdict = await checkFableAvailability({
      workDir: tmpDir,
      ttlSeconds: 900,
      probe,
      now: () => now,
    });
    assertEquals(verdict, "available");

    // The optimistic verdict is recorded so the worker does not re-probe.
    assertEquals(
      readFableAvailability(tmpDir, 900, () => now + 10),
      "available",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: boolean caches are byte-compatible (unchanged by #3230)
// ---------------------------------------------------------------------------

Deno.test("recordFableAvailability - does not touch the boolean claude/gh cache files", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    recordFableAvailability(tmpDir, true, () => 1700000000);
    // Only the fable cache file is created.
    assert(
      Deno.statSync(healthCacheFilePath(tmpDir, FABLE_CHECK_TYPE)).isFile,
    );
    let claudeExists = true;
    try {
      Deno.statSync(healthCacheFilePath(tmpDir, "claude"));
    } catch {
      claudeExists = false;
    }
    assertEquals(claudeExists, false);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
