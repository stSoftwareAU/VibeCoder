/**
 * Tests for fault_tolerance_counters.ts — getCounters() and writeSummary()
 * functions added for Issue #1173.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getCounters,
  incrementCounter,
  resetCounters,
  writeSummary,
} from "../lib/fault_tolerance_counters.ts";

Deno.test("incrementCounter - increments named counter", () => {
  resetCounters();
  incrementCounter("retryAttempts");
  const counters = getCounters();
  assertEquals(counters["retryAttempts"], 1);
  incrementCounter("retryAttempts");
  assertEquals(getCounters()["retryAttempts"], 2);
  resetCounters();
});

Deno.test("getCounters - returns Record<string, number> with all non-zero counters", () => {
  resetCounters();
  incrementCounter("retryAttempts");
  incrementCounter("timeouts");
  incrementCounter("timeouts");
  incrementCounter("claimConflicts");
  const counters = getCounters();
  assertEquals(counters["retryAttempts"], 1);
  assertEquals(counters["timeouts"], 2);
  assertEquals(counters["claimConflicts"], 1);
  assertEquals(counters["heartbeatFailures"], undefined);
  resetCounters();
});

Deno.test("resetCounters - clears all counters", () => {
  resetCounters();
  incrementCounter("retryAttempts");
  incrementCounter("crashRecoveries");
  resetCounters();
  const counters = getCounters();
  assertEquals(Object.keys(counters).length, 0);
});

Deno.test("writeSummary - writes JSON to disk with correct structure", async () => {
  resetCounters();
  incrementCounter("retryAttempts");
  incrementCounter("rateLimitBackoffs");
  incrementCounter("rateLimitBackoffs");

  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await writeSummary(tmpDir);
    assertEquals(result.ok, true);

    const content = await Deno.readTextFile(
      `${tmpDir}/fault_tolerance_summary.json`,
    );
    const parsed = JSON.parse(content);

    assertEquals(typeof parsed.timestamp, "string");
    assertEquals(parsed.counters.retryAttempts, 1);
    assertEquals(parsed.counters.rateLimitBackoffs, 2);
    assertEquals(typeof parsed.workerIdentity, "string");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    resetCounters();
  }
});

Deno.test("writeSummary - returns ok with empty counters", async () => {
  resetCounters();
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await writeSummary(tmpDir);
    assertEquals(result.ok, true);

    const content = await Deno.readTextFile(
      `${tmpDir}/fault_tolerance_summary.json`,
    );
    const parsed = JSON.parse(content);
    assertEquals(Object.keys(parsed.counters).length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    resetCounters();
  }
});

Deno.test("writeSummary - returns error Result for invalid path", async () => {
  resetCounters();
  const result = await writeSummary("/nonexistent/deeply/nested/path");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(
      result.error.message,
      "Failed to write fault tolerance summary",
    );
  }
  resetCounters();
});

Deno.test("writeSummary - includes hostname in workerIdentity", async () => {
  resetCounters();
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeSummary(tmpDir);
    const content = await Deno.readTextFile(
      `${tmpDir}/fault_tolerance_summary.json`,
    );
    const parsed = JSON.parse(content);
    assertEquals(typeof parsed.workerIdentity, "string");
    assertEquals(parsed.workerIdentity.length > 0, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    resetCounters();
  }
});

Deno.test("incrementCounter - works with issue-specified counter names", () => {
  resetCounters();
  const counterNames = [
    "retryAttempts",
    "rateLimitBackoffs",
    "circuitBreakerActivations",
    "heartbeatFailures",
    "timeouts",
    "crashRecoveries",
    "claimConflicts",
  ];
  for (const name of counterNames) {
    incrementCounter(name);
  }
  const counters = getCounters();
  for (const name of counterNames) {
    assertEquals(counters[name], 1, `Counter ${name} should be 1`);
  }
  resetCounters();
});
