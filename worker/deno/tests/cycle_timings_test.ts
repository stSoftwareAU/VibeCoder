/**
 * Tests for per-cycle wall-time telemetry (Issue #4299).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  formatCycleTimingsSummary,
  getCycleTimings,
  recordStepDuration,
  resetCycleTimings,
  startCycleTimings,
  timeStep,
} from "../lib/cycle_timings.ts";

Deno.test("cycle_timings - records, accumulates, normalises names and formats longest-first", () => {
  resetCycleTimings();
  startCycleTimings(1_000_000);
  recordStepDuration("PR Feedback", 16_000);
  recordStepDuration("Issue Scanning", 2_870_000);
  recordStepDuration("PR Feedback", 4_000); // accumulates
  const snap = getCycleTimings();
  assertEquals(snap.byStep["pr-feedback"], 20_000);
  assertEquals(snap.byStep["issue-scanning"], 2_870_000);
  assertEquals(
    formatCycleTimingsSummary(1_000_000 + 3_412_000),
    "cycle-timings: total=3412s issue-scanning=2870s pr-feedback=20s",
  );
  resetCycleTimings();
  assertEquals(formatCycleTimingsSummary(), "cycle-timings: none");
});

Deno.test("cycle_timings - timeStep records the duration even when fn throws", async () => {
  resetCycleTimings();
  let clock = 0;
  const now = () => clock;
  await assertRejects(() =>
    timeStep("Auto-Merge", () => {
      clock += 7_000;
      return Promise.reject(new Error("boom"));
    }, now)
  );
  const ok = await timeStep("Auto-Merge", () => {
    clock += 3_000;
    return Promise.resolve("done");
  }, now);
  assertEquals(ok, "done");
  assertEquals(getCycleTimings().byStep["auto-merge"], 10_000);
  resetCycleTimings();
});
