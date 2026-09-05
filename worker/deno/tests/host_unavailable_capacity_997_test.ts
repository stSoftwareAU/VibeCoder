/**
 * A parked host is reported as unavailable capacity, per host (Issue #997).
 *
 * Four hosts share the configuration that broke on GRQ-23 (#991), and each
 * discovered the fault alone and silently. The park itself is only half the
 * answer: a host that cannot run containers is *capacity the fleet has lost*,
 * and it has to say so in the vocabulary the fleet already reads — the
 * slot-utilisation telemetry of Issue #925 — and in the report an operator
 * runs to see the fleet's state.
 *
 * These tests hold both halves: the telemetry line names the lost capacity and
 * its reason, and the green-gate report — one row per host, the fleet view
 * being the union of each host's report — shows the host as unavailable with
 * that reason rather than merely stopping.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatSlotUtilisation,
  parkedHostCapacity,
  SlotIdleLedger,
} from "../lib/slot_idle_accounting.ts";
import {
  HOST_EGRESS_BLOCKED_EXIT_STATUS,
  HOST_EGRESS_BLOCKED_REASON,
} from "../lib/container_egress_probe.ts";
import { recordContainerRestartOutcome } from "../lib/container_restart_backoff.ts";
import type { CrashNotificationParams } from "../lib/crash_notification.ts";
import {
  analyseGreenGate,
  formatGreenGateReport,
  gatherGreenGateEvidence,
  type GreenGateSources,
} from "../lib/green_gate_report.ts";

// ---------------------------------------------------------------------------
// The telemetry line (Issue #925's vocabulary, Issue #997's reason)
// ---------------------------------------------------------------------------

Deno.test("parkedHostCapacity - the whole host is unavailable, with the reason named", () => {
  const line = formatSlotUtilisation(parkedHostCapacity({
    host: "GRQ-23",
    slots: 2,
    parkedSeconds: 1800,
    reason: HOST_EGRESS_BLOCKED_REASON,
  }));

  // Per host: which machine lost the capacity.
  assertStringIncludes(line, "slot-utilisation:");
  assertStringIncludes(line, "host=GRQ-23");
  // The capacity: two slots for the half hour it is parked, none of it usable.
  assertStringIncludes(line, "slots=2");
  assertStringIncludes(line, "available=3600s");
  assertStringIncludes(line, "occupied=0s");
  assertStringIncludes(line, "unavailable=3600s");
  assertStringIncludes(line, "unavailable_pct=100.0");
  // The named reason — the whole point of reporting it rather than a gap.
  assertStringIncludes(
    line,
    `unavailable_reason=${HOST_EGRESS_BLOCKED_REASON}`,
  );
});

Deno.test("parkedHostCapacity - a host with no resolvable capacity still reports one slot", () => {
  const snapshot = parkedHostCapacity({
    slots: 0,
    parkedSeconds: 600,
    reason: HOST_EGRESS_BLOCKED_REASON,
  });
  assertEquals(snapshot.slots, 1);
  assertEquals(snapshot.unavailable?.slotSeconds, 600);
  // No host to name, so the line does not invent one.
  assert(!formatSlotUtilisation(snapshot).includes("host="));
});

Deno.test("formatSlotUtilisation - a running slot pool's line is unchanged", () => {
  const ledger = new SlotIdleLedger();
  ledger.start(0, 2);
  ledger.setSlotActivity("s1", "claim", 0);
  ledger.setSlotActivity("s2", "idle", 0);
  const line = formatSlotUtilisation(ledger.snapshot(60_000));

  // The fields Issue #925 defined, and nothing bolted on: a host that IS
  // running has no unavailable capacity to report.
  assert(!line.includes("unavailable="), line);
  assert(!line.includes("unavailable_reason="), line);
  assert(!line.includes("host="), line);
  assertStringIncludes(line, "occupied=60s");
});

// ---------------------------------------------------------------------------
// The parked host's own record carries that line (Issue #997)
// ---------------------------------------------------------------------------

Deno.test("recordContainerRestartOutcome - the parked host reports its lost capacity", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "vibe_egress_capacity_" });
  try {
    const sent: CrashNotificationParams[] = [];
    const outcome = await recordContainerRestartOutcome({
      workDir,
      exitStatus: HOST_EGRESS_BLOCKED_EXIT_STATUS,
      phaseMarker: "container_egress",
      crashConfig: {
        workerName: "test-worker",
        cooldownSeconds: 600,
        logTailMaxBytes: 50_000,
        stateDir: `${workDir}/state`,
      },
      hostId: "GRQ-23",
      slots: 2,
      now: () => 5_000,
      send: (_config, params) => {
        sent.push(params);
        return Promise.resolve({ ok: true, value: { notified: true } });
      },
    });

    const parked = (await Deno.readTextFile(`${workDir}/logs/self-heal.jsonl`))
      .split("\n")
      .filter((line) => line.includes("host_parked"))
      .map((line) => JSON.parse(line));
    assertEquals(parked.length, 1);

    // The event carries the telemetry line verbatim, so the reason and the
    // lost slot-seconds travel together wherever the event is read.
    const utilisation = parked[0].details.slotUtilisation as string;
    assertStringIncludes(utilisation, "slot-utilisation:");
    assertStringIncludes(utilisation, "host=GRQ-23");
    assertStringIncludes(utilisation, "slots=2");
    assertStringIncludes(
      utilisation,
      `unavailable_reason=${HOST_EGRESS_BLOCKED_REASON}`,
    );
    assertEquals(
      parked[0].details.unavailableSlotSeconds,
      2 * outcome.backoffSeconds,
    );

    // And the escalation a person reads carries it too.
    assertEquals(sent.length, 1);
    assertStringIncludes(sent[0]?.logTail ?? "", "unavailable_reason=");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The fleet report shows the host as unavailable, with the reason (Issue #997)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-18T12:00:00Z");

function sources(over: Partial<GreenGateSources> = {}): GreenGateSources {
  return {
    now: () => NOW,
    hostId: () => "GRQ-23",
    readRunCoreLogs: () => Promise.resolve([]),
    listWorkerLogs: () => Promise.resolve([]),
    readSelfHealEvents: () => Promise.resolve(""),
    openIssues: () => Promise.resolve([]),
    ...over,
  };
}

function selfHealEvent(
  timestamp: string,
  action: string,
  details: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    timestamp,
    module: "container_restart",
    action,
    reason: `${action} at ${timestamp}`,
    result: action === "host_parked" ? "failed" : "ok",
    details,
  });
}

const PARK_DETAILS = {
  availability: "unavailable",
  reason: HOST_EGRESS_BLOCKED_REASON,
  hostId: "GRQ-23",
  parkedSeconds: 1800,
  unavailableSlotSeconds: 3600,
};

Deno.test("green-gate report - a parked host is unavailable capacity with a reason", async () => {
  const events = [
    selfHealEvent("2026-08-17T01:00:00Z", "host_parked", PARK_DETAILS),
    selfHealEvent("2026-08-17T01:30:00Z", "host_parked", PARK_DETAILS),
  ].join("\n");

  const evidence = await gatherGreenGateEvidence(
    sources({ readSelfHealEvents: () => Promise.resolve(events) }),
    { windowDays: 30, minWindowDays: 30, regressionIssues: [] },
  );
  const report = analyseGreenGate(evidence, {
    windowDays: 30,
    minWindowDays: 30,
    regressionIssues: [],
  });

  assertEquals(report.host.availability, "unavailable");
  assertEquals(report.host.unavailableReason, HOST_EGRESS_BLOCKED_REASON);
  assertEquals(report.host.parkedCycles, 2);

  const markdown = formatGreenGateReport(report);
  assertStringIncludes(markdown, "| GRQ-23 | Availability |");
  assertStringIncludes(markdown, `unavailable — ${HOST_EGRESS_BLOCKED_REASON}`);

  // A park is not a restart: the doomed build it replaces never ran, so it
  // must not inflate the restart count.
  assertEquals(report.host.restarts, 0);
});

Deno.test("green-gate report - a host that launched again is available", async () => {
  const events = [
    selfHealEvent("2026-08-17T01:00:00Z", "host_parked", PARK_DETAILS),
    selfHealEvent("2026-08-17T02:00:00Z", "recovered", { previousFailures: 1 }),
  ].join("\n");

  const evidence = await gatherGreenGateEvidence(
    sources({ readSelfHealEvents: () => Promise.resolve(events) }),
    { windowDays: 30, minWindowDays: 30, regressionIssues: [] },
  );
  const report = analyseGreenGate(evidence, {
    windowDays: 30,
    minWindowDays: 30,
    regressionIssues: [],
  });

  // Parked earlier in the window, running now: the report says available and
  // still records that it was parked, so the episode is not lost.
  assertEquals(report.host.availability, "available");
  assertEquals(report.host.parkedCycles, 1);
  assertStringIncludes(formatGreenGateReport(report), "| Availability |");
});

Deno.test("green-gate report - a host with no park events is available", async () => {
  const evidence = await gatherGreenGateEvidence(
    sources(),
    { windowDays: 30, minWindowDays: 30, regressionIssues: [] },
  );
  const report = analyseGreenGate(evidence, {
    windowDays: 30,
    minWindowDays: 30,
    regressionIssues: [],
  });
  assertEquals(report.host.availability, "available");
  assertEquals(report.host.parkedCycles, 0);
  assertEquals(report.host.unavailableReason, undefined);
});
