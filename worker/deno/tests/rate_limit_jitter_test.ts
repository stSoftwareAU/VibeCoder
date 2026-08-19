/**
 * Tests for rate-limit jitter and shared rate-limit signal (Issue #1073).
 *
 * Verifies that:
 *   - applyJitter() adds ±30% jitter to a base interval
 *   - The jitter range is correct (0.7x to 1.3x)
 *   - Different calls produce varying results (stochastic check)
 *   - Shared rate-limit signal file can be written and read
 *   - Expired signals are correctly identified
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { applyJitter } from "../lib/rate_limit_jitter.ts";
import {
  isRateLimitActive,
  rateLimitSignalPath,
  readRateLimitSignal,
  writeRateLimitSignal,
} from "../lib/rate_limit_signal.ts";

// ---------------------------------------------------------------------------
// applyJitter tests
// ---------------------------------------------------------------------------

Deno.test("applyJitter - returns value within ±30% of base interval", () => {
  const base = 300;
  const minExpected = base * 0.7;
  const maxExpected = base * 1.3;

  // Run many iterations to check the range
  for (let i = 0; i < 100; i++) {
    const result = applyJitter(base);
    assert(
      result >= minExpected && result <= maxExpected,
      `Expected ${result} to be between ${minExpected} and ${maxExpected}`,
    );
  }
});

Deno.test("applyJitter - returns integer seconds", () => {
  for (let i = 0; i < 50; i++) {
    const result = applyJitter(300);
    assertEquals(
      result,
      Math.floor(result),
      "Jitter result should be an integer",
    );
  }
});

Deno.test("applyJitter - produces varying results across calls", () => {
  const results = new Set<number>();
  for (let i = 0; i < 50; i++) {
    results.add(applyJitter(300));
  }
  // With ±30% jitter on 300 (range 210–390), 50 calls should produce
  // more than 1 unique value virtually always
  assert(
    results.size > 1,
    `Expected multiple unique values but got ${results.size}: ${[...results]}`,
  );
});

Deno.test("applyJitter - handles zero base interval", () => {
  assertEquals(applyJitter(0), 0);
});

Deno.test("applyJitter - handles small base interval", () => {
  const base = 10;
  for (let i = 0; i < 50; i++) {
    const result = applyJitter(base);
    assert(result >= 7 && result <= 13, `Expected ${result} in [7, 13]`);
  }
});

Deno.test("applyJitter - custom jitter factor", () => {
  const base = 100;
  // ±50% jitter: range should be 50–150
  for (let i = 0; i < 50; i++) {
    const result = applyJitter(base, 0.5);
    assert(result >= 50 && result <= 150, `Expected ${result} in [50, 150]`);
  }
});

// ---------------------------------------------------------------------------
// Rate-limit signal file tests
// ---------------------------------------------------------------------------

Deno.test("rateLimitSignalPath - returns expected path", () => {
  const path = rateLimitSignalPath("/tmp/work");
  assertEquals(path, "/tmp/work/.rate_limit_signal");
});

Deno.test("writeRateLimitSignal - creates signal file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await writeRateLimitSignal(tmpDir, 300);
    assert(
      result.ok,
      `Expected ok but got error: ${!result.ok && result.error}`,
    );

    const content = await Deno.readTextFile(rateLimitSignalPath(tmpDir));
    const data = JSON.parse(content);
    assert(typeof data.timestamp === "number");
    assertEquals(data.waitSeconds, 300);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readRateLimitSignal - reads valid signal", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const now = Math.floor(Date.now() / 1000);
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: now, waitSeconds: 300 }),
    );

    const result = await readRateLimitSignal(tmpDir);
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.timestamp, now);
      assertEquals(result.value.waitSeconds, 300);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readRateLimitSignal - returns error for missing file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await readRateLimitSignal(tmpDir);
    assert(!result.ok);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("isRateLimitActive - returns true for recent signal", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const now = Math.floor(Date.now() / 1000);
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: now - 10, waitSeconds: 300 }),
    );

    const result = await isRateLimitActive(tmpDir);
    assert(result.ok);
    if (result.ok) {
      assert(
        result.value.active,
        "Signal should be active when within wait window",
      );
      assert(
        result.value.remainingSeconds > 0,
        "Should have remaining seconds",
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("isRateLimitActive - returns false for expired signal", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const now = Math.floor(Date.now() / 1000);
    // Signal was written 400s ago with a 300s wait — expired
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: now - 400, waitSeconds: 300 }),
    );

    const result = await isRateLimitActive(tmpDir);
    assert(result.ok);
    if (result.ok) {
      assert(!result.value.active, "Signal should be inactive when expired");
      assertEquals(result.value.remainingSeconds, 0);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("isRateLimitActive - returns false when no signal exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await isRateLimitActive(tmpDir);
    assert(result.ok);
    if (result.ok) {
      assert(!result.value.active);
      assertEquals(result.value.remainingSeconds, 0);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
