/**
 * Tests for the rate-limit signal module (Issue #1309).
 *
 * Tests the signal file write/read cycle, path generation,
 * and TTL expiry calculation using injectable time sources.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatRateLimitReset,
  isRateLimitActive,
  rateLimitSignalPath,
  readRateLimitSignal,
  writeRateLimitSignal,
} from "../lib/rate_limit_signal.ts";

// ============================================================================
// rateLimitSignalPath — pure function
// ============================================================================

Deno.test("rateLimitSignalPath - returns correct path", () => {
  const path = rateLimitSignalPath("/home/worker");
  assertEquals(path, "/home/worker/.rate_limit_signal");
});

Deno.test("rateLimitSignalPath - handles trailing content in workDir", () => {
  const path = rateLimitSignalPath("/tmp/test-dir");
  assertEquals(path, "/tmp/test-dir/.rate_limit_signal");
});

// ============================================================================
// writeRateLimitSignal and readRateLimitSignal — round-trip tests
// ============================================================================

Deno.test("writeRateLimitSignal - writes signal file successfully", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await writeRateLimitSignal(tmpDir, 300);
    assertEquals(result.ok, true);

    // Verify the file exists and contains valid JSON
    const content = await Deno.readTextFile(rateLimitSignalPath(tmpDir));
    const data = JSON.parse(content);
    assertEquals(typeof data.timestamp, "number");
    assertEquals(data.waitSeconds, 300);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readRateLimitSignal - reads valid signal file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeRateLimitSignal(tmpDir, 600);
    const result = await readRateLimitSignal(tmpDir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.waitSeconds, 600);
      assertEquals(typeof result.value.timestamp, "number");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readRateLimitSignal - returns error when file does not exist", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await readRateLimitSignal(tmpDir);
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readRateLimitSignal - returns error for invalid JSON", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(rateLimitSignalPath(tmpDir), "not json");
    const result = await readRateLimitSignal(tmpDir);
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readRateLimitSignal - returns error for invalid format", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: "not-a-number", waitSeconds: 100 }),
    );
    const result = await readRateLimitSignal(tmpDir);
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// isRateLimitActive — with injectable time source
// ============================================================================

Deno.test("isRateLimitActive - returns active when within wait window", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Write signal at timestamp 1000 with 300s wait (expires at 1300)
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: 1000, waitSeconds: 300 }),
    );

    // Check at timestamp 1100 (within window)
    const result = await isRateLimitActive(tmpDir, () => 1100);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.active, true);
      assertEquals(result.value.remainingSeconds, 200);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("isRateLimitActive - returns inactive when past wait window", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Write signal at timestamp 1000 with 300s wait (expires at 1300)
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: 1000, waitSeconds: 300 }),
    );

    // Check at timestamp 1500 (past window)
    const result = await isRateLimitActive(tmpDir, () => 1500);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.active, false);
      assertEquals(result.value.remainingSeconds, 0);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("isRateLimitActive - returns inactive when exactly at expiry", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify({ timestamp: 1000, waitSeconds: 300 }),
    );

    // Check at exact expiry time (1300)
    const result = await isRateLimitActive(tmpDir, () => 1300);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.active, false);
      assertEquals(result.value.remainingSeconds, 0);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("isRateLimitActive - returns inactive when no signal file exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await isRateLimitActive(tmpDir, () => 1000);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.active, false);
      assertEquals(result.value.remainingSeconds, 0);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("writeRateLimitSignal - returns error for non-existent directory", async () => {
  const result = await writeRateLimitSignal(
    "/nonexistent/dir/that/should/not/exist",
    100,
  );
  assertEquals(result.ok, false);
});

// ============================================================================
// formatRateLimitReset — operator-facing log enrichment (Issue #1910)
// ============================================================================

Deno.test("formatRateLimitReset - future reset in AEST shows absolute and relative", () => {
  // 2026-05-11 04:23:00 UTC == 2026-05-11 14:23:00 AEST (May is outside DST).
  const resetEpoch = Math.floor(Date.UTC(2026, 4, 11, 4, 23, 0) / 1000);
  const nowEpoch = resetEpoch - (47 * 60 + 12);
  const result = formatRateLimitReset(resetEpoch, nowEpoch);
  assertStringIncludes(result, "2026-05-11");
  assertStringIncludes(result, "14:23:00");
  assertStringIncludes(result, "AEST");
  assertStringIncludes(result, "in 47m 12s");
});

Deno.test("formatRateLimitReset - DST window labels AEDT", () => {
  // 2026-01-15 03:00:00 UTC == 2026-01-15 14:00:00 AEDT (January is DST, +11).
  const resetEpoch = Math.floor(Date.UTC(2026, 0, 15, 3, 0, 0) / 1000);
  const nowEpoch = resetEpoch - 600;
  const result = formatRateLimitReset(resetEpoch, nowEpoch);
  assertStringIncludes(result, "2026-01-15");
  assertStringIncludes(result, "14:00:00");
  assertStringIncludes(result, "AEDT");
});

Deno.test("formatRateLimitReset - duration over one hour shows hours and minutes", () => {
  const resetEpoch = Math.floor(Date.UTC(2026, 4, 11, 4, 23, 0) / 1000);
  const nowEpoch = resetEpoch - (3 * 3600 + 7 * 60);
  const result = formatRateLimitReset(resetEpoch, nowEpoch);
  assertStringIncludes(result, "in 3h 7m");
});

Deno.test("formatRateLimitReset - duration under one minute shows seconds only", () => {
  const resetEpoch = Math.floor(Date.UTC(2026, 4, 11, 4, 23, 0) / 1000);
  const nowEpoch = resetEpoch - 42;
  const result = formatRateLimitReset(resetEpoch, nowEpoch);
  assertStringIncludes(result, "in 42s");
});

Deno.test("formatRateLimitReset - past reset reports already reset", () => {
  const resetEpoch = Math.floor(Date.UTC(2026, 4, 11, 4, 23, 0) / 1000);
  const nowEpoch = resetEpoch + 5;
  const result = formatRateLimitReset(resetEpoch, nowEpoch);
  assertStringIncludes(result, "already reset");
});

Deno.test("formatRateLimitReset - exactly at reset reports already reset", () => {
  const resetEpoch = Math.floor(Date.UTC(2026, 4, 11, 4, 23, 0) / 1000);
  const result = formatRateLimitReset(resetEpoch, resetEpoch);
  assertStringIncludes(result, "already reset");
});

Deno.test("formatRateLimitReset - non-finite reset returns sentinel", () => {
  const result = formatRateLimitReset(Number.NaN, 1_700_000_000);
  assertStringIncludes(result, "unknown");
});
