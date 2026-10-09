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
  costPerMergedPr,
  deriveIdleReason,
  endBusy,
  formatFleetSummary,
  getFleetTelemetry,
  recordBlockedSeconds,
  recordCiFixRun,
  recordClaim,
  recordCycleIdle,
  recordInRunBlockedSeconds,
  recordIssuePhaseRun,
  recordMergedPr,
  recordOutcome,
  recordPrFeedbackRun,
  recordPrRejection,
  resetFleetTelemetry,
  startFleetCycle,
  startFleetTelemetry,
} from "../lib/fleet_telemetry.ts";

const WINDOW_START_MS = Date.parse("2026-06-01T00:00:00Z");
const BEFORE_WINDOW = "2026-05-31T23:59:59Z";
const AT_WINDOW_START = "2026-06-01T00:00:00Z";
const AFTER_WINDOW_START = "2026-06-01T00:00:05Z";

function resolvesTo(
  tier: "sonnet" | "haiku" | null,
): () => Promise<"sonnet" | "haiku" | null> {
  return () => Promise.resolve(tier);
}

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
  recordBlockedSeconds("usage_blocked", 20);
  recordCycleIdle("nothing_claimable_empty", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.rateLimitedSeconds, 30);
  assertEquals(snapshot.tokenBlockedSeconds, 20);
  assertEquals(snapshot.rateLimitWaits, 1);
  assertEquals(snapshot.tokenBlockedWaits, 1);
  assertEquals(snapshot.idleByReason["rate_limited"], 30);
  assertEquals(snapshot.idleByReason["usage_blocked"], 20);
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
  recordInRunBlockedSeconds("usage_blocked", 30);
  endBusy("serial", 60_000);
  recordCycleIdle("served", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  // Reported as token-blocked time — the number the issue asks for …
  assertEquals(snapshot.tokenBlockedSeconds, 30);
  assertEquals(snapshot.tokenBlockedWaits, 1);
  // … but the fleet held a claim throughout, so it is not idle.
  assertEquals(snapshot.idleByReason["usage_blocked"], undefined);
  assertEquals(snapshot.occupiedSeconds, 60);
  assertEquals(snapshot.idleSeconds, 40);
});

Deno.test("fleet_telemetry - a zero-length wait is not reported as a wait", () => {
  fresh(0);
  startFleetCycle(0);
  recordBlockedSeconds("rate_limited", 0);
  recordInRunBlockedSeconds("usage_blocked", 0);

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
  assertStringIncludes(line, "usage_blocked=0s");
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

// --- issue-phase counters (Issue #2347) -------------------------------

/** The pilot's three-run shape: two split runs and one control run. */
function threeIssueRuns(): void {
  recordIssuePhaseRun({
    usd: 1.25,
    gatePassedOnAttempt: 1,
    durationSeconds: 900,
    split: true,
    subAgentTier: "sonnet",
  });
  recordIssuePhaseRun({
    usd: 0.5,
    gatePassedOnAttempt: 2,
    durationSeconds: 1_200,
    split: true,
    subAgentTier: "sonnet",
  });
  recordIssuePhaseRun({
    usd: 2.25,
    gatePassedOnAttempt: 1,
    durationSeconds: 600,
    split: false,
    subAgentTier: "sonnet",
  });
}

Deno.test("fleet_telemetry - issue-phase runs count, with the split runs visible", () => {
  fresh(0);
  threeIssueRuns();

  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.issuePhaseRuns, 3);
  // A half-configured host is visible: two of the three ran split.
  assertEquals(snapshot.issuePhaseSplitRuns, 2);
});

Deno.test("fleet_telemetry - issue-phase spend sums the recorded per-run figures", () => {
  fresh(0);
  threeIssueRuns();

  assertAlmostEquals(getFleetTelemetry(1_000).issuePhaseUsd, 4.0, 1e-9);
});

Deno.test("fleet_telemetry - only a gate that passed on attempt 1 counts as a first-attempt pass", () => {
  fresh(0);
  threeIssueRuns();

  const snapshot = getFleetTelemetry(1_000);
  // The first-attempt pass rate is a division of two recorded numbers: 2/3.
  assertEquals(snapshot.issuePhaseFirstAttemptGatePasses, 2);
  assertEquals(snapshot.issuePhaseRuns, 3);
});

Deno.test("fleet_telemetry - a run that never passed the gate counts no first-attempt pass", () => {
  fresh(0);
  recordIssuePhaseRun({
    usd: 0.75,
    durationSeconds: 300,
    split: true,
    subAgentTier: "sonnet",
  });

  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.issuePhaseRuns, 1);
  assertEquals(snapshot.issuePhaseFirstAttemptGatePasses, 0);
});

Deno.test("fleet_telemetry - issue-phase duration sums the recorded durations and gates nothing", () => {
  fresh(0);
  startFleetCycle(0);
  threeIssueRuns();
  recordCycleIdle("served", 100_000);

  const snapshot = getFleetTelemetry(100_000);
  assertEquals(snapshot.issuePhaseDurationSeconds, 2_700);
  // Reported beside the cost, with no threshold of its own: the duration of
  // the recorded runs changes neither the idle arithmetic nor any outcome.
  assertEquals(snapshot.idleSeconds, 100);
  assertEquals(snapshot.occupiedSeconds, 0);
  assertEquals(snapshot.successes, 0);
  assertEquals(snapshot.failures, 0);
});

Deno.test("fleet_telemetry - a run with no figures still counts as a run", () => {
  fresh(0);
  recordIssuePhaseRun({ subAgentTier: "sonnet" });

  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.issuePhaseRuns, 1);
  assertEquals(snapshot.issuePhaseUsd, 0);
  assertEquals(snapshot.issuePhaseDurationSeconds, 0);
  assertEquals(snapshot.issuePhaseSplitRuns, 0);
});

Deno.test("fleet_telemetry - an unusable figure contributes nothing rather than NaN", () => {
  fresh(0);
  recordIssuePhaseRun({
    usd: Number.NaN,
    durationSeconds: -30,
    split: true,
    subAgentTier: "sonnet",
  });
  recordIssuePhaseRun({
    usd: 1.5,
    durationSeconds: 60,
    split: true,
    subAgentTier: "sonnet",
  });

  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.issuePhaseRuns, 2);
  assertAlmostEquals(snapshot.issuePhaseUsd, 1.5, 1e-9);
  assertEquals(snapshot.issuePhaseDurationSeconds, 60);
});

Deno.test("fleet_telemetry - a snapshot is a copy, so a later run cannot mutate it", () => {
  fresh(0);
  recordIssuePhaseRun({
    usd: 1,
    durationSeconds: 60,
    split: true,
    subAgentTier: "sonnet",
  });
  const snapshot = getFleetTelemetry(1_000);
  recordIssuePhaseRun({
    usd: 1,
    durationSeconds: 60,
    split: true,
    subAgentTier: "sonnet",
  });

  assertEquals(snapshot.issuePhaseRuns, 1);
  assertEquals(getFleetTelemetry(1_000).issuePhaseRuns, 2);
});

Deno.test("fleet_telemetry - the summary line reports the issue-phase counters", () => {
  fresh(0);
  startFleetCycle(0);
  threeIssueRuns();

  const line = formatFleetSummary(100_000);
  assertEquals(line.split("\n").length, 1);
  assertStringIncludes(line, "issue_runs=3");
  assertStringIncludes(line, "issue_split_runs=2");
  assertStringIncludes(line, "issue_usd=4.0000");
  assertStringIncludes(line, "issue_gate_first_attempt_passes=2");
  assertStringIncludes(line, "issue_duration=2700s");
});

Deno.test("fleet_telemetry - reset clears the issue-phase counters too", () => {
  fresh(0);
  threeIssueRuns();

  resetFleetTelemetry();
  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.issuePhaseRuns, 0);
  assertEquals(snapshot.issuePhaseUsd, 0);
  assertEquals(snapshot.issuePhaseFirstAttemptGatePasses, 0);
  assertEquals(snapshot.issuePhaseDurationSeconds, 0);
  assertEquals(snapshot.issuePhaseSplitRuns, 0);
});

// --- per-tier issue-phase counters (Issue #3403) ----------------------

Deno.test("fleet_telemetry - a haiku run moves only the haiku counters", () => {
  fresh(0);
  recordIssuePhaseRun({
    usd: 0.4,
    gatePassedOnAttempt: 1,
    durationSeconds: 120,
    subAgentTier: "haiku",
  });

  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.issuePhaseHaikuRuns, 1);
  assertAlmostEquals(snapshot.issuePhaseHaikuUsd, 0.4, 1e-9);
  assertEquals(snapshot.issuePhaseSonnetRuns, 0);
  assertEquals(snapshot.issuePhaseSonnetUsd, 0);
  // The combined totals still move.
  assertEquals(snapshot.issuePhaseRuns, 1);
  assertAlmostEquals(snapshot.issuePhaseUsd, 0.4, 1e-9);
});

Deno.test("fleet_telemetry - a sonnet run moves only the sonnet counters", () => {
  fresh(0);
  recordIssuePhaseRun({
    usd: 1.1,
    gatePassedOnAttempt: 1,
    durationSeconds: 300,
    subAgentTier: "sonnet",
  });

  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.issuePhaseSonnetRuns, 1);
  assertAlmostEquals(snapshot.issuePhaseSonnetUsd, 1.1, 1e-9);
  assertEquals(snapshot.issuePhaseHaikuRuns, 0);
  assertEquals(snapshot.issuePhaseHaikuUsd, 0);
});

Deno.test("fleet_telemetry - a sonnet-only fleet's summary is byte-identical to today's", () => {
  fresh(0);
  startFleetCycle(0);
  recordClaim();
  recordOutcome("success");
  recordIssuePhaseRun({
    usd: 1.25,
    gatePassedOnAttempt: 1,
    durationSeconds: 900,
    split: true,
    subAgentTier: "sonnet",
  });
  recordCycleIdle("served", 100_000);

  const line = formatFleetSummary(100_000);
  assertEquals(
    line,
    "fleet-summary: wall=100s idle=100s idle_pct=100.0 occupied=0s busy=0s " +
      "usage_blocked=0s usage_blocked_waits=0 rate_limited=0s " +
      "rate_limit_waits=0 claims=1 successes=1 failures=0 skips=0 " +
      "hook_failures=0 success_rate=1.00 issue_runs=1 issue_split_runs=1 " +
      "issue_usd=1.2500 issue_gate_first_attempt_passes=1 " +
      "issue_duration=900s idle_by_reason=served=100s " +
      "failures_by_class=none utilisation=none",
  );
  assertEquals(line.includes("issue_tier_"), false, line);
});

Deno.test("fleet_telemetry - a haiku run adds the tier tokens right after issue_duration", () => {
  fresh(0);
  startFleetCycle(0);
  recordIssuePhaseRun({
    usd: 1.0,
    subAgentTier: "sonnet",
  });
  recordIssuePhaseRun({
    usd: 0.25,
    subAgentTier: "haiku",
  });
  recordCycleIdle("served", 100_000);

  const line = formatFleetSummary(100_000);
  assertStringIncludes(
    line,
    "issue_duration=0s issue_tier_runs=sonnet=1,haiku=1 " +
      "issue_tier_usd=sonnet=1.0000,haiku=0.2500 pr_tier_rejections=",
  );
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
  assertEquals(
    deriveIdleReason([{ skipReason: "scanned", workOnSuppressed: 2 }]),
    "work_on_suppressed",
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

Deno.test("fleet_telemetry - a haiku PR rejection increments the haiku counter only", async () => {
  fresh(WINDOW_START_MS);
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 10,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: resolvesTo("haiku"),
  });
  const snapshot = getFleetTelemetry(WINDOW_START_MS + 1_000);
  assertEquals(snapshot.prRejectionsHaiku, 1);
  assertEquals(snapshot.prRejectionsSonnet, 0);
});

Deno.test("fleet_telemetry - a sonnet PR rejection increments the sonnet counter only", async () => {
  fresh(WINDOW_START_MS);
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 10,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: resolvesTo("sonnet"),
  });
  const snapshot = getFleetTelemetry(WINDOW_START_MS + 1_000);
  assertEquals(snapshot.prRejectionsSonnet, 1);
  assertEquals(snapshot.prRejectionsHaiku, 0);
});

Deno.test("fleet_telemetry - the same review id is counted once", async () => {
  fresh(WINDOW_START_MS);
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 10,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: resolvesTo("haiku"),
  });
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 10,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: resolvesTo("haiku"),
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).prRejectionsHaiku, 1);
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 11,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: resolvesTo("haiku"),
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).prRejectionsHaiku, 2);
});

Deno.test("fleet_telemetry - reset clears the rejection and merge dedupe", async () => {
  fresh(WINDOW_START_MS);
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 10,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: resolvesTo("haiku"),
  });
  recordMergedPr({
    repo: "o/r",
    number: 1,
    mergedAt: AFTER_WINDOW_START,
    tier: "haiku",
  });
  fresh(WINDOW_START_MS);
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 10,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: resolvesTo("haiku"),
  });
  recordMergedPr({
    repo: "o/r",
    number: 1,
    mergedAt: AFTER_WINDOW_START,
    tier: "haiku",
  });
  const snapshot = getFleetTelemetry(WINDOW_START_MS + 1_000);
  assertEquals(snapshot.prRejectionsHaiku, 1);
  assertEquals(snapshot.mergedPrsHaiku, 1);
});

Deno.test("fleet_telemetry - a haiku CI-fix run adds runs and usd", () => {
  fresh(0);
  recordCiFixRun({ usd: 0.25, tier: "haiku" });
  recordCiFixRun({ tier: "haiku" });
  recordCiFixRun({ usd: 1, tier: "sonnet" });
  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.ciFixRunsHaiku, 2);
  assertAlmostEquals(snapshot.ciFixUsdHaiku, 0.25);
  assertEquals(snapshot.ciFixRunsSonnet, 1);
  assertAlmostEquals(snapshot.ciFixUsdSonnet, 1);
});

Deno.test("fleet_telemetry - PR-feedback runs add runs and usd per tier", () => {
  fresh(0);
  recordPrFeedbackRun({ usd: 0.5, tier: "haiku" });
  recordPrFeedbackRun({ usd: 2, tier: "sonnet" });
  const snapshot = getFleetTelemetry(1_000);
  assertEquals(snapshot.prFeedbackRunsHaiku, 1);
  assertAlmostEquals(snapshot.prFeedbackUsdHaiku, 0.5);
  assertEquals(snapshot.prFeedbackRunsSonnet, 1);
  assertAlmostEquals(snapshot.prFeedbackUsdSonnet, 2);
});

Deno.test("fleet_telemetry - a merged PR is counted once per repo and number", () => {
  fresh(WINDOW_START_MS);
  recordMergedPr({
    repo: "o/a",
    number: 5,
    mergedAt: AFTER_WINDOW_START,
    tier: "haiku",
  });
  recordMergedPr({
    repo: "o/a",
    number: 5,
    mergedAt: AFTER_WINDOW_START,
    tier: "haiku",
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).mergedPrsHaiku, 1);
  recordMergedPr({
    repo: "o/b",
    number: 5,
    mergedAt: AFTER_WINDOW_START,
    tier: "haiku",
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).mergedPrsHaiku, 2);
});

Deno.test("fleet_telemetry - costPerMergedPr guards against nothing merged", () => {
  assertEquals(costPerMergedPr(1.5, 0), "n/a");
  assertEquals(costPerMergedPr(0, 0), "n/a");
  assertEquals(costPerMergedPr(3, 2), "1.5000");
  assertEquals(costPerMergedPr(NaN, 2), "n/a");
  // -2 / -1 = 2 is finite, so only the `merged <= 0` guard returns n/a here.
  assertEquals(costPerMergedPr(-2, -1), "n/a");
});

Deno.test("fleet_telemetry - the summary renders cost per merged PR per tier", async () => {
  fresh(WINDOW_START_MS);
  recordIssuePhaseRun({ usd: 1, subAgentTier: "sonnet" });
  recordIssuePhaseRun({ usd: 0.5, subAgentTier: "haiku" });
  recordPrFeedbackRun({ usd: 0.25, tier: "haiku" });
  recordCiFixRun({ usd: 0.25, tier: "haiku" });
  recordMergedPr({
    repo: "o/r",
    number: 1,
    mergedAt: AFTER_WINDOW_START,
    tier: "haiku",
  });
  recordMergedPr({
    repo: "o/r",
    number: 2,
    mergedAt: AFTER_WINDOW_START,
    tier: "haiku",
  });
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 1,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: resolvesTo("haiku"),
  });

  const line = formatFleetSummary(WINDOW_START_MS + 1_000);
  // haiku: (0.5 + 0.25 + 0.25) / 2 merged; sonnet: nothing merged.
  assertStringIncludes(line, "cost_per_merged_pr=sonnet=n/a,haiku=0.5000");
  assertStringIncludes(line, "pr_tier_rejections=sonnet=0,haiku=1");
  assertStringIncludes(line, "ci_fix_tier_runs=sonnet=0,haiku=1");
  assertStringIncludes(line, "ci_fix_tier_usd=sonnet=0.0000,haiku=0.2500");
  assertStringIncludes(line, "pr_feedback_tier_usd=sonnet=0.0000,haiku=0.2500");
  assertStringIncludes(line, "merged_tier_prs=sonnet=0,haiku=2");
  assertEquals(line.includes("Infinity"), false);
  assertEquals(line.includes("NaN"), false);
  assertEquals(line.includes("TOKEN"), false);
});

Deno.test("fleet_telemetry - a sonnet-only summary omits the PR outcome keys", () => {
  fresh(WINDOW_START_MS);
  recordIssuePhaseRun({ usd: 1, subAgentTier: "sonnet" });
  recordMergedPr({
    repo: "o/r",
    number: 1,
    mergedAt: AFTER_WINDOW_START,
    tier: "sonnet",
  });
  const line = formatFleetSummary(WINDOW_START_MS + 1_000);
  assertEquals(line.includes("pr_tier_rejections"), false);
  assertEquals(line.includes("cost_per_merged_pr"), false);
});

Deno.test("fleet_telemetry - a merged PR before the window start is not counted", () => {
  fresh(WINDOW_START_MS);
  recordMergedPr({
    repo: "o/r",
    number: 1,
    mergedAt: BEFORE_WINDOW,
    tier: "haiku",
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).mergedPrsHaiku, 0);
  // Not recorded as seen either: nothing to dedupe against later.
  recordMergedPr({
    repo: "o/r",
    number: 1,
    mergedAt: AFTER_WINDOW_START,
    tier: "haiku",
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).mergedPrsHaiku, 1);
});

Deno.test("fleet_telemetry - a merged PR at the window start is counted", () => {
  fresh(WINDOW_START_MS);
  recordMergedPr({
    repo: "o/r",
    number: 2,
    mergedAt: AT_WINDOW_START,
    tier: "sonnet",
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).mergedPrsSonnet, 1);
});

Deno.test("fleet_telemetry - a merged PR with an empty or unparseable mergedAt is not counted", () => {
  fresh(WINDOW_START_MS);
  recordMergedPr({ repo: "o/r", number: 3, mergedAt: "", tier: "haiku" });
  recordMergedPr({
    repo: "o/r",
    number: 4,
    mergedAt: "not a date",
    tier: "haiku",
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).mergedPrsHaiku, 0);
});

Deno.test("fleet_telemetry - a review submitted before the window start is not counted and never resolves a tier", async () => {
  fresh(WINDOW_START_MS);
  let calls = 0;
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 1,
    submittedAt: BEFORE_WINDOW,
    resolveTier: () => {
      calls += 1;
      return Promise.resolve("haiku");
    },
  });
  assertEquals(calls, 0);
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).prRejectionsHaiku, 0);
});

Deno.test("fleet_telemetry - a review with a missing or unparseable submittedAt is not counted", async () => {
  fresh(WINDOW_START_MS);
  for (const submittedAt of [null, undefined, "", "garbage"]) {
    await recordPrRejection({
      repo: "o/r",
      prNumber: 1,
      reviewId: 1,
      submittedAt,
      resolveTier: resolvesTo("haiku"),
    });
  }
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).prRejectionsHaiku, 0);
});

Deno.test("fleet_telemetry - an unresolved tier is not counted and the review is retried later", async () => {
  fresh(WINDOW_START_MS);
  const base = {
    repo: "o/r",
    prNumber: 1,
    reviewId: 7,
    submittedAt: AFTER_WINDOW_START,
  };
  await recordPrRejection({ ...base, resolveTier: resolvesTo(null) });
  const first = getFleetTelemetry(WINDOW_START_MS + 1_000);
  assertEquals(first.prRejectionsHaiku + first.prRejectionsSonnet, 0);
  await recordPrRejection({ ...base, resolveTier: resolvesTo("haiku") });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).prRejectionsHaiku, 1);
});

Deno.test("fleet_telemetry - a repeated review does not resolve the tier again", async () => {
  fresh(WINDOW_START_MS);
  let calls = 0;
  const args = {
    repo: "o/r",
    prNumber: 1,
    reviewId: 9,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: () => {
      calls += 1;
      return Promise.resolve("haiku" as const);
    },
  };
  await recordPrRejection(args);
  await recordPrRejection(args);
  assertEquals(calls, 1);
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).prRejectionsHaiku, 1);
});

Deno.test("fleet_telemetry - a reset during the tier lookup does not credit the new window", async () => {
  fresh(WINDOW_START_MS);
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 5,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: () => {
      fresh(WINDOW_START_MS);
      return Promise.resolve("haiku");
    },
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).prRejectionsHaiku, 0);
  // The stale result did not poison the new window's dedupe.
  await recordPrRejection({
    repo: "o/r",
    prNumber: 1,
    reviewId: 5,
    submittedAt: AFTER_WINDOW_START,
    resolveTier: resolvesTo("haiku"),
  });
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).prRejectionsHaiku, 1);
});

Deno.test("fleet_telemetry - concurrent calls for the same review count it once", async () => {
  fresh(WINDOW_START_MS);
  const resolvers: Array<() => void> = [];
  const deferredTier = () =>
    new Promise<"haiku">((resolve) => {
      resolvers.push(() => resolve("haiku"));
    });
  const base = {
    repo: "o/r",
    prNumber: 1,
    reviewId: 77,
    submittedAt: AFTER_WINDOW_START,
  };
  // Both calls pass the first dedupe check before either resolves.
  const first = recordPrRejection({ ...base, resolveTier: deferredTier });
  const second = recordPrRejection({ ...base, resolveTier: deferredTier });
  assertEquals(resolvers.length, 2);
  for (const resolve of resolvers) resolve();
  await Promise.all([first, second]);
  assertEquals(getFleetTelemetry(WINDOW_START_MS + 1_000).prRejectionsHaiku, 1);
});
