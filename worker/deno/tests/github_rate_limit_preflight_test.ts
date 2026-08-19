/**
 * Tests for the pre-flight GitHub rate-limit check.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_PREFLIGHT_THRESHOLD,
  preflightGitHubRateLimit,
} from "../lib/github_rate_limit_preflight.ts";
import {
  rateLimitSignalPath,
  readRateLimitSignal,
  writeRateLimitSignal,
} from "../lib/rate_limit_signal.ts";
import {
  readPreflightCache,
  writePreflightCache,
} from "../lib/rate_limit_preflight_cache.ts";

function makeRateLimitPayload(options: {
  graphqlRemaining: number;
  graphqlLimit?: number;
  graphqlResetEpoch: number;
}): string {
  return JSON.stringify({
    resources: {
      core: {
        limit: 5000,
        used: 0,
        remaining: 5000,
        reset: options.graphqlResetEpoch,
      },
      graphql: {
        limit: options.graphqlLimit ?? 5000,
        used: (options.graphqlLimit ?? 5000) - options.graphqlRemaining,
        remaining: options.graphqlRemaining,
        reset: options.graphqlResetEpoch,
      },
    },
  });
}

// ============================================================================
// Healthy quota → not rate-limited
// ============================================================================

Deno.test("preflightGitHubRateLimit - healthy quota proceeds", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logs: string[] = [];
  try {
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () =>
        Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 4800,
            graphqlResetEpoch: 4600,
          }),
        ),
      log: (m) => logs.push(m),
    });

    assertEquals(outcome.rateLimited, false);
    assertEquals(outcome.remainingSeconds, 0);
    assert(outcome.message.includes("4800/5000"));

    // No signal file should be written.
    const signalRead = await readRateLimitSignal(tmpDir);
    assertEquals(signalRead.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Exhausted quota → rate-limited + signal written
// ============================================================================

Deno.test("preflightGitHubRateLimit - exhausted quota writes signal", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () =>
        Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 0,
            graphqlResetEpoch: 2800,
          }),
        ),
      log: () => {},
    });

    assertEquals(outcome.rateLimited, true);
    // reset at 2800 - now 1000 = 1800 wait; clamped within [MIN, MAX].
    assertEquals(outcome.remainingSeconds, 1800);
    assert(outcome.message.includes("0/5000"));

    // Signal file should exist with the computed wait.
    const signalRead = await readRateLimitSignal(tmpDir);
    assertEquals(signalRead.ok, true);
    if (signalRead.ok) {
      assertEquals(signalRead.value.waitSeconds, 1800);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - below default threshold writes signal", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const belowThreshold = DEFAULT_PREFLIGHT_THRESHOLD - 1;
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () =>
        Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: belowThreshold,
            graphqlResetEpoch: 2000,
          }),
        ),
      log: () => {},
    });

    assertEquals(outcome.rateLimited, true);
    const signalRead = await readRateLimitSignal(tmpDir);
    assertEquals(signalRead.ok, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - custom threshold honoured", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () =>
        Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 200,
            graphqlResetEpoch: 2000,
          }),
        ),
      log: () => {},
      threshold: 500,
    });

    assertEquals(outcome.rateLimited, true);
    const signalRead = await readRateLimitSignal(tmpDir);
    assertEquals(signalRead.ok, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Reset-in-past fallback
// ============================================================================

Deno.test("preflightGitHubRateLimit - reset in past uses fallback wait", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      // now is AFTER the reset epoch → fallback path.
      nowSeconds: () => 9000,
      runGhRateLimit: () =>
        Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 0,
            graphqlResetEpoch: 1000,
          }),
        ),
      log: () => {},
    });

    assertEquals(outcome.rateLimited, true);
    assertEquals(outcome.remainingSeconds, 3600);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - very near reset clamps to MIN_WAIT", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      // reset 10s away — should be clamped up to MIN (60s).
      nowSeconds: () => 1000,
      runGhRateLimit: () =>
        Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 0,
            graphqlResetEpoch: 1010,
          }),
        ),
      log: () => {},
    });

    assertEquals(outcome.rateLimited, true);
    assertEquals(outcome.remainingSeconds, 60);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Existing signal short-circuits without calling gh
// ============================================================================

Deno.test("preflightGitHubRateLimit - existing active signal short-circuits", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Pre-populate an active signal.
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: 1000, waitSeconds: 600 }),
    );

    let ghCalls = 0;
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1100, // 500s remaining
      runGhRateLimit: () => {
        ghCalls++;
        return Promise.resolve("{}");
      },
      log: () => {},
    });

    assertEquals(outcome.rateLimited, true);
    assertEquals(outcome.remainingSeconds, 500);
    assertEquals(ghCalls, 0, "should not hit gh when signal is already active");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - expired signal falls through to gh check", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Signal exists but is expired.
    await writeRateLimitSignal(tmpDir, 60);
    // Manually overwrite with a long-past timestamp so the signal is expired.
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: 500, waitSeconds: 60 }),
    );

    let ghCalls = 0;
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 2000,
      runGhRateLimit: () => {
        ghCalls++;
        return Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 4500,
            graphqlResetEpoch: 5000,
          }),
        );
      },
      log: () => {},
    });

    assertEquals(outcome.rateLimited, false);
    assertEquals(ghCalls, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Fail-open on errors
// ============================================================================

Deno.test("preflightGitHubRateLimit - gh failure is fail-open", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logs: string[] = [];
  try {
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () => Promise.reject(new Error("boom")),
      log: (m) => logs.push(m),
    });

    assertEquals(outcome.rateLimited, false);
    assert(outcome.message.includes("boom"));
    assert(logs.some((m) => m.includes("boom")));

    // No signal should be written on fail-open.
    const signalRead = await readRateLimitSignal(tmpDir);
    assertEquals(signalRead.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - malformed JSON is fail-open", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () => Promise.resolve("not valid json"),
      log: () => {},
    });

    assertEquals(outcome.rateLimited, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - missing resources is fail-open", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () =>
        Promise.resolve(JSON.stringify({ rate: { remaining: 0 } })),
      log: () => {},
    });

    assertEquals(outcome.rateLimited, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Core fallback when graphql resource is missing (older GHE)
// ============================================================================

// ============================================================================
// Cache behaviour (Issue #1675)
// ============================================================================

Deno.test("preflightGitHubRateLimit - healthy live check populates the cache", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () =>
        Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 4800,
            graphqlResetEpoch: 4600,
          }),
        ),
      log: () => {},
    });
    assertEquals(outcome.rateLimited, false);

    const cached = await readPreflightCache(tmpDir, () => 1010);
    assertEquals(cached.ok, true);
    if (cached.ok) {
      assertEquals(cached.value.remaining, 4800);
      assertEquals(cached.value.limit, 5000);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - cache hit short-circuits gh", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writePreflightCache(tmpDir, {
      timestamp: 1000,
      remaining: 4500,
      limit: 5000,
      reset: 9999,
    });
    let ghCalls = 0;
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      // Within TTL window.
      nowSeconds: () => 1030,
      runGhRateLimit: () => {
        ghCalls++;
        return Promise.resolve("{}");
      },
      log: () => {},
    });
    assertEquals(outcome.rateLimited, false);
    assert(outcome.message.includes("cached"));
    assertEquals(ghCalls, 0, "cache hit must not call gh");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - stale cache falls through to gh", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writePreflightCache(tmpDir, {
      timestamp: 1000,
      remaining: 4500,
      limit: 5000,
      reset: 9999,
    });
    let ghCalls = 0;
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      // Now is well past the 90s default TTL.
      nowSeconds: () => 5000,
      runGhRateLimit: () => {
        ghCalls++;
        return Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 4000,
            graphqlResetEpoch: 9999,
          }),
        );
      },
      log: () => {},
    });
    assertEquals(outcome.rateLimited, false);
    assertEquals(ghCalls, 1, "stale cache must trigger live check");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - near-threshold cached value is bypassed", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Cached remaining sits within 2× of the default threshold (50 → 99
    // is below the 100 cut-off), so the cache must be ignored.
    await writePreflightCache(tmpDir, {
      timestamp: 1000,
      remaining: 80,
      limit: 5000,
      reset: 9999,
    });
    let ghCalls = 0;
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1030,
      runGhRateLimit: () => {
        ghCalls++;
        return Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 4500,
            graphqlResetEpoch: 9999,
          }),
        );
      },
      log: () => {},
    });
    assertEquals(outcome.rateLimited, false);
    assertEquals(ghCalls, 1, "near-threshold cache must not be reused");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - active signal bypasses cache and gh", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Both a healthy cache and an active signal exist. The signal must win.
    await writePreflightCache(tmpDir, {
      timestamp: 1000,
      remaining: 4500,
      limit: 5000,
      reset: 9999,
    });
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: 1000, waitSeconds: 600 }),
    );
    let ghCalls = 0;
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1100,
      runGhRateLimit: () => {
        ghCalls++;
        return Promise.resolve("{}");
      },
      log: () => {},
    });
    assertEquals(outcome.rateLimited, true);
    assertEquals(
      ghCalls,
      0,
      "active signal must short-circuit before cache/gh",
    );
    assertEquals(outcome.remainingSeconds, 500);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - noCache forces a live check even on hit", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writePreflightCache(tmpDir, {
      timestamp: 1000,
      remaining: 4500,
      limit: 5000,
      reset: 9999,
    });
    let ghCalls = 0;
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1030,
      runGhRateLimit: () => {
        ghCalls++;
        return Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 4800,
            graphqlResetEpoch: 9999,
          }),
        );
      },
      log: () => {},
      noCache: true,
    });
    assertEquals(outcome.rateLimited, false);
    assertEquals(ghCalls, 1, "noCache must always perform the live check");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - near-threshold live result is not cached", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Healthy enough to proceed (above threshold) but within 2× threshold,
    // so the cache must not be populated.
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () =>
        Promise.resolve(
          makeRateLimitPayload({
            graphqlRemaining: 80,
            graphqlResetEpoch: 9999,
          }),
        ),
      log: () => {},
    });
    assertEquals(outcome.rateLimited, false);
    const cacheRead = await readPreflightCache(tmpDir, () => 1000);
    assertEquals(
      cacheRead.ok,
      false,
      "near-threshold result must not be cached",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("preflightGitHubRateLimit - falls back to core when graphql missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const payload = JSON.stringify({
      resources: {
        core: { limit: 5000, used: 4999, remaining: 1, reset: 2000 },
      },
    });
    const outcome = await preflightGitHubRateLimit({
      workDir: tmpDir,
      nowSeconds: () => 1000,
      runGhRateLimit: () => Promise.resolve(payload),
      log: () => {},
    });

    assertEquals(outcome.rateLimited, true);
    assertEquals(outcome.remainingSeconds, 1000);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
