/**
 * Tests for fault_tolerance_counters.ts — structured fault tolerance
 * event counters for observability (Issue #1168).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  formatCounterSummary,
  getCounterSnapshot,
  getFaultEventCount,
  recordFaultEvent,
  resetFaultCounters,
} from "../lib/fault_tolerance_counters.ts";

Deno.test("fault_tolerance_counters - recordFaultEvent increments counter", () => {
  resetFaultCounters();
  assertEquals(getFaultEventCount("retry_attempt"), 0);
  recordFaultEvent("retry_attempt");
  assertEquals(getFaultEventCount("retry_attempt"), 1);
  recordFaultEvent("retry_attempt");
  assertEquals(getFaultEventCount("retry_attempt"), 2);
  resetFaultCounters();
});

Deno.test("fault_tolerance_counters - different events tracked independently", () => {
  resetFaultCounters();
  recordFaultEvent("heartbeat_failure");
  recordFaultEvent("timeout");
  recordFaultEvent("timeout");
  assertEquals(getFaultEventCount("heartbeat_failure"), 1);
  assertEquals(getFaultEventCount("timeout"), 2);
  assertEquals(getFaultEventCount("retry_attempt"), 0);
  resetFaultCounters();
});

Deno.test("fault_tolerance_counters - getCounterSnapshot returns correct totals", () => {
  resetFaultCounters();
  recordFaultEvent("heartbeat_failure");
  recordFaultEvent("circuit_breaker_open");
  recordFaultEvent("circuit_breaker_open");
  const snapshot = getCounterSnapshot();
  assertEquals(snapshot.totalEvents, 3);
  assertEquals(snapshot.counters.get("heartbeat_failure"), 1);
  assertEquals(snapshot.counters.get("circuit_breaker_open"), 2);
  resetFaultCounters();
});

Deno.test("fault_tolerance_counters - resetFaultCounters clears all counters", () => {
  resetFaultCounters();
  recordFaultEvent("heartbeat_failure");
  recordFaultEvent("timeout");
  resetFaultCounters();
  assertEquals(getFaultEventCount("heartbeat_failure"), 0);
  assertEquals(getFaultEventCount("timeout"), 0);
  assertEquals(getCounterSnapshot().totalEvents, 0);
});

Deno.test("fault_tolerance_counters - formatCounterSummary returns null when empty", () => {
  resetFaultCounters();
  assertEquals(formatCounterSummary(), null);
});

Deno.test("fault_tolerance_counters - formatCounterSummary includes all non-zero events", () => {
  resetFaultCounters();
  recordFaultEvent("heartbeat_failure");
  recordFaultEvent("disk_space_cleanup");
  recordFaultEvent("disk_space_cleanup");
  const summary = formatCounterSummary();
  assertNotEquals(summary, null);
  assertEquals(summary!.includes("heartbeat_failure: 1"), true);
  assertEquals(summary!.includes("disk_space_cleanup: 2"), true);
  assertEquals(summary!.includes("total: 3"), true);
  resetFaultCounters();
});

Deno.test("fault_tolerance_counters - snapshot is immutable copy", () => {
  resetFaultCounters();
  recordFaultEvent("retry_attempt");
  const snapshot = getCounterSnapshot();
  recordFaultEvent("retry_attempt");
  assertEquals(snapshot.counters.get("retry_attempt"), 1);
  assertEquals(getFaultEventCount("retry_attempt"), 2);
  resetFaultCounters();
});
