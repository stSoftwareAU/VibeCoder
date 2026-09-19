/**
 * Tests for the fleet-telemetry JSON sidecar (Issue #855).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  FLEET_TELEMETRY_SCHEMA,
  fleetTelemetryPath,
  isFleetTelemetryFile,
  mergeCumulative,
  readFleetTelemetryFile,
  writeFleetTelemetryFile,
} from "../lib/fleet_telemetry_sidecar.ts";
import {
  beginBusy,
  endBusy,
  getFleetTelemetry,
  recordBlockedSeconds,
  recordClaim,
  recordCycleIdle,
  recordIssuePhaseRun,
  recordOutcome,
  resetFleetTelemetry,
  startFleetCycle,
  startFleetTelemetry,
} from "../lib/fleet_telemetry.ts";

/** Read the sidecar, failing the test if it is not usable. */
async function readUsable(dir: string, host: string) {
  const result = await readFleetTelemetryFile(dir, host);
  return isFleetTelemetryFile(result) ? result : undefined;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "fleet-telemetry-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("fleet_telemetry_sidecar - path embeds a sanitised hostname", () => {
  assertEquals(
    fleetTelemetryPath("/work", "host-1"),
    "/work/fleet_telemetry_host-1.json",
  );
  // A hostname carrying a separator must never escape the work directory.
  assertEquals(
    fleetTelemetryPath("/work", "../../etc/passwd"),
    "/work/fleet_telemetry_.._.._etc_passwd.json",
  );
});

Deno.test("fleet_telemetry_sidecar - writes this run's totals as JSON", async () => {
  await withTempDir(async (dir) => {
    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordClaim();
    recordOutcome("success");
    recordOutcome("failure", "execute");
    beginBusy("serial", 0);
    endBusy("serial", 40_000);
    recordBlockedSeconds("rate_limited", 10);
    recordCycleIdle("nothing_claimable_backlog", 100_000);

    const written = await writeFleetTelemetryFile(dir, {
      hostname: "host-1",
      nowMs: 100_000,
    });
    assertEquals(written.ok, true);

    const read = await readUsable(dir, "host-1");
    assertEquals(read?.host, "host-1");
    assertEquals(read?.run.idleSeconds, 60);
    assertEquals(read?.run.busySeconds, 40);
    assertEquals(read?.run.rateLimitedSeconds, 10);
    assertEquals(read?.run.successes, 1);
    assertEquals(read?.run.failures, 1);
    assertEquals(read?.cumulative.idleSeconds, 60);
    assertEquals(read?.cumulative.successes, 1);
  });
});

Deno.test("fleet_telemetry_sidecar - cumulative totals grow across runs", async () => {
  await withTempDir(async (dir) => {
    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordOutcome("success");
    recordCycleIdle("nothing_claimable_empty", 100_000);
    await writeFleetTelemetryFile(dir, { hostname: "host-1", nowMs: 100_000 });

    // A second run on the same host starts its own accumulators.
    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordOutcome("failure", "timeout");
    recordCycleIdle("nothing_claimable_empty", 40_000);
    await writeFleetTelemetryFile(dir, { hostname: "host-1", nowMs: 40_000 });

    const read = await readUsable(dir, "host-1");
    assertEquals(read?.run.idleSeconds, 40);
    assertEquals(read?.cumulative.idleSeconds, 140);
    assertEquals(read?.cumulative.successes, 1);
    assertEquals(read?.cumulative.failures, 1);
    assertEquals(read?.cumulative.failuresByClass["timeout"], 1);
  });
});

Deno.test("fleet_telemetry_sidecar - re-writing within one run does not double count", async () => {
  await withTempDir(async (dir) => {
    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordOutcome("success");
    recordCycleIdle("nothing_claimable_empty", 60_000);
    await writeFleetTelemetryFile(dir, { hostname: "host-1", nowMs: 60_000 });
    await writeFleetTelemetryFile(dir, { hostname: "host-1", nowMs: 60_000 });

    const read = await readUsable(dir, "host-1");
    assertEquals(read?.cumulative.idleSeconds, 60);
    assertEquals(read?.cumulative.successes, 1);
  });
});

Deno.test("fleet_telemetry_sidecar - a corrupt sidecar is replaced, not fatal", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      fleetTelemetryPath(dir, "host-1"),
      "{ not json",
    );
    assertEquals(await readFleetTelemetryFile(dir, "host-1"), "unparseable");

    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordCycleIdle("nothing_claimable_empty", 10_000);
    const written = await writeFleetTelemetryFile(dir, {
      hostname: "host-1",
      nowMs: 10_000,
    });
    assertEquals(written.ok, true);
    assertEquals((await readUsable(dir, "host-1"))?.run.idleSeconds, 10);
  });
});

Deno.test("fleet_telemetry_sidecar - a missing sidecar reads as absent, not corrupt", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await readFleetTelemetryFile(dir, "host-1"), "absent");
  });
});

Deno.test("fleet_telemetry_sidecar - a newer schema is refused, not merged as v1", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      fleetTelemetryPath(dir, "host-1"),
      JSON.stringify({
        schema: FLEET_TELEMETRY_SCHEMA + 1,
        host: "host-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        run: {},
        cumulative: { idleSeconds: 999 },
      }),
    );
    assertEquals(
      await readFleetTelemetryFile(dir, "host-1"),
      "future-schema",
    );
  });
});

Deno.test("fleet_telemetry_sidecar - losing the baseline is reported, never silent", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(fleetTelemetryPath(dir, "host-1"), "{ not json");
    const warnings: string[] = [];

    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordCycleIdle("nothing_claimable_empty", 10_000);
    const written = await writeFleetTelemetryFile(dir, {
      hostname: "host-1",
      nowMs: 10_000,
      warn: (message) => warnings.push(message),
    });

    assertEquals(written.ok, true);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0] ?? "", "unparseable");
    assertStringIncludes(warnings[0] ?? "", "restart from zero");
  });
});

Deno.test("fleet_telemetry_sidecar - a first write warns about nothing", async () => {
  await withTempDir(async (dir) => {
    const warnings: string[] = [];
    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordCycleIdle("nothing_claimable_empty", 10_000);
    await writeFleetTelemetryFile(dir, {
      hostname: "host-1",
      nowMs: 10_000,
      warn: (message) => warnings.push(message),
    });
    assertEquals(warnings, []);
  });
});

Deno.test("fleet_telemetry_sidecar - an unwritable directory fails loudly", async () => {
  const result = await writeFleetTelemetryFile(
    "/nonexistent-fleet-telemetry-dir",
    { hostname: "host-1", nowMs: 0 },
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "fleet telemetry");
  }
});

// --- issue-phase counters (Issue #2347) -------------------------------

Deno.test("fleet_telemetry_sidecar - issue-phase counters persist and accumulate across runs", async () => {
  await withTempDir(async (dir) => {
    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordIssuePhaseRun({
      usd: 1.25,
      gatePassedOnAttempt: 1,
      durationSeconds: 900,
      split: true,
    });
    await writeFleetTelemetryFile(dir, { hostname: "host-1", nowMs: 60_000 });

    // A second run on the same host adds to the host's accumulated totals.
    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordIssuePhaseRun({
      usd: 0.75,
      gatePassedOnAttempt: 2,
      durationSeconds: 600,
      split: false,
    });
    await writeFleetTelemetryFile(dir, { hostname: "host-1", nowMs: 60_000 });

    const read = await readUsable(dir, "host-1");
    assertEquals(read?.run.issuePhaseRuns, 1);
    assertEquals(read?.run.issuePhaseSplitRuns, 0);
    assertEquals(read?.cumulative.issuePhaseRuns, 2);
    assertEquals(read?.cumulative.issuePhaseSplitRuns, 1);
    assertEquals(read?.cumulative.issuePhaseFirstAttemptGatePasses, 1);
    assertEquals(read?.cumulative.issuePhaseDurationSeconds, 1_500);
    assertAlmostEquals(read?.cumulative.issuePhaseUsd ?? -1, 2.0, 1e-9);
  });
});

Deno.test("fleet_telemetry_sidecar - a snapshot written before the counters existed still loads", async () => {
  await withTempDir(async (dir) => {
    // Exactly the shape a pre-#2347 worker wrote: schema 1, no issue-phase
    // counters anywhere.
    await Deno.writeTextFile(
      fleetTelemetryPath(dir, "host-1"),
      JSON.stringify({
        schema: FLEET_TELEMETRY_SCHEMA,
        host: "host-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        run: { idleSeconds: 30, successes: 1 },
        cumulative: {
          wallSeconds: 100,
          idleSeconds: 90,
          idleByReason: { served: 90 },
          occupiedSeconds: 10,
          busySeconds: 10,
          busyByStream: { serial: 10 },
          tokenBlockedSeconds: 0,
          rateLimitedSeconds: 0,
          rateLimitWaits: 0,
          tokenBlockedWaits: 0,
          claims: 2,
          successes: 2,
          failures: 0,
          skips: 0,
          failuresByClass: {},
        },
      }),
    );

    const prior = await readUsable(dir, "host-1");
    // The missing counters read as zero, not undefined-typed-as-number.
    assertEquals(prior?.cumulative.issuePhaseRuns, 0);
    assertEquals(prior?.cumulative.issuePhaseUsd, 0);
    assertEquals(prior?.cumulative.issuePhaseFirstAttemptGatePasses, 0);
    assertEquals(prior?.cumulative.issuePhaseDurationSeconds, 0);
    assertEquals(prior?.cumulative.issuePhaseSplitRuns, 0);
    assertEquals(prior?.run.issuePhaseRuns, 0);

    // …and this run merges onto it without poisoning any total with NaN.
    resetFleetTelemetry();
    startFleetTelemetry(0);
    startFleetCycle(0);
    recordIssuePhaseRun({
      usd: 1.5,
      gatePassedOnAttempt: 1,
      durationSeconds: 300,
      split: true,
    });
    const written = await writeFleetTelemetryFile(dir, {
      hostname: "host-1",
      nowMs: 60_000,
    });
    assertEquals(written.ok, true);

    const merged = await readUsable(dir, "host-1");
    assertEquals(merged?.cumulative.issuePhaseRuns, 1);
    assertEquals(merged?.cumulative.issuePhaseSplitRuns, 1);
    assertEquals(merged?.cumulative.issuePhaseFirstAttemptGatePasses, 1);
    assertEquals(merged?.cumulative.issuePhaseDurationSeconds, 300);
    assertAlmostEquals(merged?.cumulative.issuePhaseUsd ?? -1, 1.5, 1e-9);
    // The pre-existing history is preserved, not restarted.
    assertEquals(merged?.cumulative.successes, 2);
  });
});

Deno.test("mergeCumulative - a prior without the issue-phase counters reads them as zero", () => {
  resetFleetTelemetry();
  startFleetTelemetry(0);
  startFleetCycle(0);
  recordIssuePhaseRun({
    usd: 2,
    gatePassedOnAttempt: 1,
    durationSeconds: 120,
    split: true,
  });
  const run = getFleetTelemetry(1_000);

  const merged = mergeCumulative({
    wallSeconds: 0,
    idleSeconds: 0,
    idleByReason: {},
    occupiedSeconds: 0,
    busySeconds: 0,
    busyByStream: {},
    tokenBlockedSeconds: 0,
    rateLimitedSeconds: 0,
    rateLimitWaits: 0,
    tokenBlockedWaits: 0,
    claims: 0,
    successes: 0,
    failures: 0,
    skips: 0,
    failuresByClass: {},
  }, run);

  assertEquals(merged.issuePhaseRuns, 1);
  assertEquals(merged.issuePhaseSplitRuns, 1);
  assertEquals(merged.issuePhaseFirstAttemptGatePasses, 1);
  assertEquals(merged.issuePhaseDurationSeconds, 120);
  assertAlmostEquals(merged.issuePhaseUsd, 2, 1e-9);
});

Deno.test("mergeCumulative - adds every additive total", () => {
  resetFleetTelemetry();
  startFleetTelemetry(0);
  startFleetCycle(0);
  recordClaim();
  recordOutcome("failure", "setup");
  beginBusy("slot-1", 0);
  endBusy("slot-1", 5_000);
  recordCycleIdle("host_disk_low", 30_000);
  const run = getFleetTelemetry(30_000);

  const prior = {
    wallSeconds: 100,
    idleSeconds: 90,
    idleByReason: { host_disk_low: 90 },
    occupiedSeconds: 10,
    busySeconds: 10,
    busyByStream: { "slot-1": 10 },
    tokenBlockedSeconds: 4,
    rateLimitedSeconds: 3,
    rateLimitWaits: 1,
    tokenBlockedWaits: 1,
    claims: 2,
    successes: 1,
    failures: 1,
    skips: 0,
    failuresByClass: { setup: 1 },
  };

  const merged = mergeCumulative(prior, run);
  assertEquals(merged.wallSeconds, 130);
  assertEquals(merged.idleSeconds, 115);
  assertEquals(merged.idleByReason["host_disk_low"], 115);
  assertEquals(merged.busySeconds, 15);
  assertEquals(merged.busyByStream["slot-1"], 15);
  assertEquals(merged.claims, 3);
  assertEquals(merged.failures, 2);
  assertEquals(merged.failuresByClass["setup"], 2);
});
