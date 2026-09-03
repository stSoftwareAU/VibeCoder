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
  deriveIdleReason,
  formatFleetSummary,
  getFleetTelemetry,
  recordBlockedSeconds,
  recordBusySeconds,
  recordClaim,
  recordCycleIdle,
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

Deno.test("fleet_telemetry - busy time is excluded from the cycle's idle", () => {
  fresh(0);
  startFleetCycle(0);
  recordBusySeconds("serial", 40);
  recordCycleIdle("served", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.busySeconds, 40);
  assertEquals(snapshot.busyByStream["serial"], 40);
  assertEquals(snapshot.idleSeconds, 60);
  assertEquals(snapshot.idleByReason["served"], 60);
});

Deno.test("fleet_telemetry - concurrent streams never drive idle negative", () => {
  fresh(0);
  startFleetCycle(0);
  // Two slots each busy for the whole cycle: summed busy exceeds wall.
  recordBusySeconds("slot-1", 100);
  recordBusySeconds("slot-2", 100);
  recordCycleIdle("served", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.idleSeconds, 0);
  assertEquals(snapshot.busySeconds, 200);
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
  recordBusySeconds("slot-1", 50);
  recordBusySeconds("slot-2", 25);

  const snapshot = getFleetTelemetry(100_000);
  assertAlmostEquals(snapshot.utilisation["slot-1"] ?? -1, 0.5, 1e-9);
  assertAlmostEquals(snapshot.utilisation["slot-2"] ?? -1, 0.25, 1e-9);
});

Deno.test("fleet_telemetry - summary is one machine-readable line", () => {
  fresh(0);
  startFleetCycle(0);
  recordClaim();
  recordOutcome("success");
  recordBusySeconds("serial", 40);
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
  recordBusySeconds("serial", 10);
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

Deno.test("deriveIdleReason - a scanned fleet with open work reports a non-empty backlog", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "scanned", availability: "busy" },
      { skipReason: "scanned", availability: "empty" },
    ]),
    "nothing_claimable_backlog",
  );
});

Deno.test("deriveIdleReason - a scanned fleet with no open work reports an empty backlog", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "scanned", availability: "empty" },
      { skipReason: "scanned", availability: "empty" },
    ]),
    "nothing_claimable_empty",
  );
});

Deno.test("deriveIdleReason - the dominant gate reason wins over a lone scan", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "host_disk_low", availability: "available" },
      { skipReason: "host_disk_low", availability: "available" },
      { skipReason: "scanned", availability: "empty" },
    ]),
    "host_disk_low",
  );
});

Deno.test("deriveIdleReason - ties break on first-seen order for determinism", () => {
  assertEquals(
    deriveIdleReason([
      { skipReason: "dependency_blocked", availability: "available" },
      { skipReason: "stream_occupied", availability: "available" },
    ]),
    "dependency_blocked",
  );
});

Deno.test("deriveIdleReason - no census entries reports unknown", () => {
  assertEquals(deriveIdleReason([]), "unknown");
});
