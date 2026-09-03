/**
 * Tests for fleet-level telemetry accumulation (Issue #855).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  beginBusy,
  deriveIdleReason,
  endBusy,
  formatFleetSummary,
  getFleetTelemetry,
  recordBlockedSeconds,
  recordClaim,
  recordCycleIdle,
  recordInRunBlockedSeconds,
  recordOutcome,
  resetFleetTelemetry,
  startFleetCycle,
  startFleetTelemetry,
} from "../lib/fleet_telemetry.ts";

function fresh(startMs = 0): void {
  resetFleetTelemetry();
  startFleetTelemetry(startMs);
}

Deno.test("fleet_telemetry - a quiet cycle accumulates idle under its reason", () => {
  fresh(0);
  startFleetCycle(0);
  recordCycleIdle("nothing_claimable_empty", 60_000);

  const snapshot = getFleetTelemetry(60_000);
  assertEquals(snapshot.idleSeconds, 60);
  assertEquals(snapshot.idleByReason["nothing_claimable_empty"], 60);
  assertEquals(snapshot.busySeconds, 0);
  assertEquals(snapshot.wallSeconds, 60);
});

Deno.test("fleet_telemetry - idle accumulates across cycles by reason", () => {
  fresh(0);
  startFleetCycle(0);
  recordCycleIdle("nothing_claimable_backlog", 30_000);
  startFleetCycle(30_000);
  recordCycleIdle("host_disk_low", 90_000);
  startFleetCycle(90_000);
  recordCycleIdle("nothing_claimable_backlog", 120_000);

  const snapshot = getFleetTelemetry(120_000);
  assertEquals(snapshot.idleSeconds, 120);
  assertEquals(snapshot.idleByReason["nothing_claimable_backlog"], 60);
  assertEquals(snapshot.idleByReason["host_disk_low"], 60);
});

Deno.test("fleet_telemetry - an early-returning cycle's wall time is not lost", () => {
  fresh(0);
  startFleetCycle(0);
  // This cycle returns before attributing (a failed health check), so the
  // next attributed segment must span both cycles.
  startFleetCycle(60_000);
  recordCycleIdle("nothing_claimable_empty", 120_000);

  const snapshot = getFleetTelemetry(120_000);
  assertEquals(snapshot.idleSeconds, 120);
  assertEquals(snapshot.idleByReason["nothing_claimable_empty"], 120);
});

Deno.test("fleet_telemetry - blocked time carried across cycles is counted once", () => {
  fresh(0);
  startFleetCycle(0);
  recordBlockedSeconds("rate_limited", 40);
  // The rate-limit branch restarts the cycle without attributing.
  startFleetCycle(40_000);
  recordCycleIdle("nothing_claimable_empty", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.idleByReason["rate_limited"], 40);
  assertEquals(snapshot.idleByReason["nothing_claimable_empty"], 60);
  assertEquals(snapshot.idleSeconds, 100);
});

Deno.test("fleet_telemetry - occupied time is excluded from the cycle's idle", () => {
  fresh(0);
  startFleetCycle(0);
  beginBusy("serial", 0);
  endBusy("serial", 40_000);
  recordCycleIdle("served", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.busySeconds, 40);
  assertEquals(snapshot.occupiedSeconds, 40);
  assertEquals(snapshot.busyByStream["serial"], 40);
  assertEquals(snapshot.idleSeconds, 60);
  assertEquals(snapshot.idleByReason["served"], 60);
});

Deno.test("fleet_telemetry - concurrent streams never drive idle negative", () => {
  fresh(0);
  startFleetCycle(0);
  // Two slots each busy for the whole cycle: summed busy exceeds wall.
  beginBusy("slot-1", 0);
  beginBusy("slot-2", 0);
  endBusy("slot-1", 100_000);
  endBusy("slot-2", 100_000);
  recordCycleIdle("served", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.idleSeconds, 0);
  assertEquals(snapshot.busySeconds, 200);
  // Occupancy is "any slot busy", so it never exceeds the wall clock.
  assertEquals(snapshot.occupiedSeconds, 100);
});

Deno.test("fleet_telemetry - a half-idle pool still reports its idle half", () => {
  fresh(0);
  startFleetCycle(0);
  // Two slots, each busy for half the cycle but at the same time: the
  // fleet was occupied for 50s and idle for the other 50s. Summing the
  // streams would have claimed 100s busy and reported zero idle.
  beginBusy("slot-1", 0);
  beginBusy("slot-2", 0);
  endBusy("slot-1", 50_000);
  endBusy("slot-2", 50_000);
  recordCycleIdle("nothing_claimable_empty", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.busySeconds, 100);
  assertEquals(snapshot.occupiedSeconds, 50);
  assertEquals(snapshot.idleSeconds, 50);
  assertEquals(snapshot.idleByReason["nothing_claimable_empty"], 50);
});

Deno.test("fleet_telemetry - overlapping slots count occupancy once", () => {
  fresh(0);
  startFleetCycle(0);
  beginBusy("slot-1", 10_000);
  beginBusy("slot-2", 20_000);
  endBusy("slot-1", 40_000);
  endBusy("slot-2", 60_000);
  recordCycleIdle("served", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  // Occupied from 10s to 60s = 50s, not 30s + 40s.
  assertEquals(snapshot.occupiedSeconds, 50);
  assertEquals(snapshot.idleSeconds, 50);
});

Deno.test("fleet_telemetry - a run spanning a cycle boundary is not idle", () => {
  fresh(0);
  startFleetCycle(0);
  beginBusy("serial", 0);
  // The cycle closes while the run is still going.
  recordCycleIdle("served", 60_000);
  endBusy("serial", 100_000);
  recordCycleIdle("served", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.occupiedSeconds, 100);
  assertEquals(snapshot.idleSeconds, 0);
  assertEquals(snapshot.busyByStream["serial"], 100);
});

Deno.test("fleet_telemetry - blocked time is its own idle reason and is not double counted", () => {
  fresh(0);
  startFleetCycle(0);
  recordBlockedSeconds("rate_limited", 30);
  recordBlockedSeconds("token_blocked", 20);
  recordCycleIdle("nothing_claimable_empty", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.rateLimitedSeconds, 30);
  assertEquals(snapshot.tokenBlockedSeconds, 20);
  assertEquals(snapshot.rateLimitWaits, 1);
  assertEquals(snapshot.tokenBlockedWaits, 1);
  assertEquals(snapshot.idleByReason["rate_limited"], 30);
  assertEquals(snapshot.idleByReason["token_blocked"], 20);
  // 100s cycle: 30 rate-limited + 20 token-blocked + 50 unattributed idle.
  assertEquals(snapshot.idleByReason["nothing_claimable_empty"], 50);
  assertEquals(snapshot.idleSeconds, 100);
});

Deno.test("fleet_telemetry - repeated rate-limit waits count retries and total backoff", () => {
  fresh(0);
  startFleetCycle(0);
  recordBlockedSeconds("rate_limited", 15);
  recordBlockedSeconds("rate_limited", 45);

  const snapshot = getFleetTelemetry(60_000);
  assertEquals(snapshot.rateLimitWaits, 2);
  assertEquals(snapshot.rateLimitedSeconds, 60);
});

Deno.test("fleet_telemetry - a block inside a run counts as blocked, not idle", () => {
  fresh(0);
  startFleetCycle(0);
  beginBusy("serial", 0);
  // The agent's own retry ladder sleeps in-process, mid-run.
  recordInRunBlockedSeconds("token_blocked", 30);
  endBusy("serial", 60_000);
  recordCycleIdle("served", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  // Reported as token-blocked time — the number the issue asks for …
  assertEquals(snapshot.tokenBlockedSeconds, 30);
  assertEquals(snapshot.tokenBlockedWaits, 1);
  // … but the fleet held a claim throughout, so it is not idle.
  assertEquals(snapshot.idleByReason["token_blocked"], undefined);
  assertEquals(snapshot.occupiedSeconds, 60);
  assertEquals(snapshot.idleSeconds, 40);
});

Deno.test("fleet_telemetry - a zero-length wait is not reported as a wait", () => {
  fresh(0);
  startFleetCycle(0);
  recordBlockedSeconds("rate_limited", 0);
  recordInRunBlockedSeconds("token_blocked", 0);

  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.rateLimitWaits, 0);
  assertEquals(snapshot.tokenBlockedWaits, 0);
});

Deno.test("fleet_telemetry - success rate counts completed runs, not skips", () => {
  fresh(0);
  for (let i = 0; i < 32; i++) recordClaim();
  for (let i = 0; i < 17; i++) recordOutcome("success");
  for (let i = 0; i < 13; i++) recordOutcome("failure", "execute");
  recordOutcome("skip");
  recordOutcome("skip");

  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.claims, 32);
  assertEquals(snapshot.successes, 17);
  assertEquals(snapshot.failures, 13);
  assertEquals(snapshot.skips, 2);
  assertAlmostEquals(snapshot.successRate ?? -1, 17 / 30, 1e-9);
});

Deno.test("fleet_telemetry - success rate is null before any run completes", () => {
  fresh(0);
  recordClaim();
  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.successRate, null);
});

Deno.test("fleet_telemetry - failures break down by class", () => {
  fresh(0);
  recordOutcome("failure", "setup");
  recordOutcome("failure", "execute");
  recordOutcome("failure", "execute");
  recordOutcome("failure", "timeout");
  recordOutcome("failure");

  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.failuresByClass["setup"], 1);
  assertEquals(snapshot.failuresByClass["execute"], 2);
  assertEquals(snapshot.failuresByClass["timeout"], 1);
  assertEquals(snapshot.failuresByClass["unknown"], 1);
});

Deno.test("fleet_telemetry - utilisation is busy over wall time per stream", () => {
  fresh(0);
  startFleetCycle(0);
  beginBusy("slot-1", 0);
  endBusy("slot-1", 50_000);
  beginBusy("slot-2", 0);
  endBusy("slot-2", 25_000);

  const snapshot = getFleetTelemetry(100_000);
  assertAlmostEquals(snapshot.utilisation["slot-1"] ?? -1, 0.5, 1e-9);
  assertAlmostEquals(snapshot.utilisation["slot-2"] ?? -1, 0.25, 1e-9);
});

Deno.test("fleet_telemetry - summary is one machine-readable line", () => {
  fresh(0);
  startFleetCycle(0);
  recordClaim();
  recordOutcome("success");
  beginBusy("serial", 0);
  endBusy("serial", 40_000);
  recordBlockedSeconds("rate_limited", 10);
  recordCycleIdle("nothing_claimable_backlog", 100_000);

  const line = formatFleetSummary(100_000);
  assertEquals(line.split("\n").length, 1);
  assertStringIncludes(line, "fleet-summary:");
  assertStringIncludes(line, "wall=100s");
  assertStringIncludes(line, "idle=60s");
  assertStringIncludes(line, "busy=40s");
  assertStringIncludes(line, "rate_limited=10s");
  assertStringIncludes(line, "token_blocked=0s");
  assertStringIncludes(line, "claims=1");
  assertStringIncludes(line, "successes=1");
  assertStringIncludes(line, "failures=0");
  assertStringIncludes(line, "success_rate=1.00");
  assertStringIncludes(line, "idle_by_reason=");
  assertStringIncludes(line, "nothing_claimable_backlog=50s");
  assertStringIncludes(line, "utilisation=serial=0.40");
});

Deno.test("fleet_telemetry - summary reports success_rate=n/a with no completed runs", () => {
  fresh(0);
  startFleetCycle(0);
  recordCycleIdle("nothing_claimable_empty", 10_000);
  assertStringIncludes(formatFleetSummary(10_000), "success_rate=n/a");
});

Deno.test("fleet_telemetry - reset clears every accumulator", () => {
  fresh(0);
  startFleetCycle(0);
  recordClaim();
  recordOutcome("failure", "execute");
  beginBusy("serial", 0);
  endBusy("serial", 10_000);
  recordCycleIdle("served", 20_000);

  resetFleetTelemetry();
  const snapshot = getFleetTelemetry(20_000);
  assertEquals(snapshot.claims, 0);
  assertEquals(snapshot.failures, 0);
  assertEquals(snapshot.busySeconds, 0);
  assertEquals(snapshot.idleSeconds, 0);
  assertEquals(snapshot.wallSeconds, 0);
  assertEquals(snapshot.idleByReason, {});
});

// --- deriveIdleReason -------------------------------------------------

Deno.test("deriveIdleReason - unblocked priority work reports a non-empty backlog", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "scanned", inversionSignal: true },
      { skipReason: "scanned", inversionSignal: false },
    ]),
    "nothing_claimable_backlog",
  );
});

Deno.test("deriveIdleReason - a scanned fleet with no open work reports an empty backlog", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "scanned", inversionSignal: false },
      { skipReason: "scanned", inversionSignal: false },
    ]),
    "nothing_claimable_empty",
  );
});

// The census only ever sets a skip reason for the claim gates, so without
// this split the reasons the issue names could never be produced.
Deno.test("deriveIdleReason - the dominant deferral names a scanned fleet's reason", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "scanned", dependencyBlocked: 1, streamOccupied: 4 },
      { skipReason: "scanned", streamOccupied: 2 },
    ]),
    "stream_occupied",
  );
  assertEquals(
    deriveIdleReason([{ skipReason: "scanned", dependencyBlocked: 3 }]),
    "dependency_blocked",
  );
  assertEquals(
    deriveIdleReason([{ skipReason: "scanned", prBlocked: 2 }]),
    "pr_blocked",
  );
  assertEquals(
    deriveIdleReason([{ skipReason: "scanned", runLocalHold: 2 }]),
    "cooldown_local",
  );
  assertEquals(
    deriveIdleReason([{ skipReason: "scanned", lowPrioritySuppressed: 2 }]),
    "low_priority_suppressed",
  );
});

Deno.test("deriveIdleReason - an inversion outranks a deferral count", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "scanned", inversionSignal: true, streamOccupied: 9 },
    ]),
    "nothing_claimable_backlog",
  );
});

Deno.test("deriveIdleReason - the dominant gate reason wins over a lone scan", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "host_disk_low" },
      { skipReason: "host_disk_low" },
      { skipReason: "scanned" },
    ]),
    "host_disk_low",
  );
});

Deno.test("deriveIdleReason - ties break on first-seen order for determinism", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "dependency_blocked" },
      { skipReason: "stream_occupied" },
    ]),
    "dependency_blocked",
  );
});

Deno.test("deriveIdleReason - no census entries reports unknown", () => {
  assertEquals(deriveIdleReason([]), "unknown");
});
