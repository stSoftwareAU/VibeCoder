/**
 * Tests for the green-gate evidence report (Issue #4189).
 *
 * The Phase 0 gate of plan #4160: the fleet running clean in container
 * mode, no host-mode fallback, over a long enough window, with no open
 * regression from the setup/run-mode work. These tests drive the pure
 * analyser and the Markdown renderer over fixture log sets that mirror the
 * live `~/logs` formats: a clean window is GREEN with the window stated; a
 * host-mode launch is NOT GREEN and named; a short window is NOT GREEN with
 * the reason; an empty log set is "insufficient evidence", never GREEN.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  analyseGreenGate,
  formatGreenGateReport,
  gatherGreenGateEvidence,
  type GreenGateSources,
} from "../lib/green_gate_report.ts";

const NOW = new Date("2026-08-18T12:00:00Z");

/** A launch block in run_core.log, with a run-mode record. */
function launchBlock(
  ts: string,
  runId: string,
  mode: string,
  host = "host-23",
): string {
  return [
    `${ts} PATH bootstrapped: /usr/local/bin`,
    `${ts} VIBE_RUN_ID=${runId}`,
    `${ts} run mode: ${mode} host=${host} run_id=${runId}`,
    `${ts} Resetting repo to origin/Develop`,
  ].join("\n");
}

/** A worker log for one run: N processed issues plus the summary. */
function workerLog(
  start: string,
  options: { issues?: number; extra?: string[] } = {},
): string {
  const day = start.slice(0, 10);
  const lines = [`run_core pid=20 start=${start} (Worker timestamps are UTC)`];
  const n = options.issues ?? 1;
  for (let i = 0; i < n; i++) {
    lines.push(
      `[${day} 02:0${i}:00Z] INFO: Processing issue stSoftwareAU/VibeCoder#${
        4000 + i
      }: something [version=1.0.0 commit=unknown]`,
    );
    lines.push(
      `[${day} 03:0${i}:00Z] INFO: Releasing claim stSoftwareAU/VibeCoder#${
        4000 + i
      } — outcome pr:#${4100 + i}`,
    );
  }
  lines.push(...(options.extra ?? []));
  lines.push(
    `[${day} 04:00:00Z] [WORKER_SUMMARY] issues_processed=${n} duration=3600s human=1h avg=3600s_per_issue`,
  );
  return lines.join("\n") + "\n";
}

function sources(over: Partial<GreenGateSources> = {}): GreenGateSources {
  return {
    now: () => NOW,
    hostId: () => "host-23",
    readRunCoreLogs: () => Promise.resolve([]),
    listWorkerLogs: () => Promise.resolve([]),
    readSelfHealEvents: () => Promise.resolve(""),
    openIssues: () => Promise.resolve([]),
    ...over,
  };
}

const CLEAN_RUN_CORE = [
  launchBlock("2026-07-20T01:00:00Z", "vibe-a", "container"),
  launchBlock("2026-08-01T01:00:00Z", "vibe-b", "container"),
  launchBlock("2026-08-17T01:00:00Z", "vibe-c", "container"),
].join("\n");

const CLEAN_WORKER_LOGS = [
  {
    name: "worker-20260720-010000.log.gz",
    read: () =>
      Promise.resolve(workerLog("2026-07-20T01:00:00Z", { issues: 2 })),
  },
  {
    name: "worker-20260817-010000.log",
    read: () =>
      Promise.resolve(workerLog("2026-08-17T01:00:00Z", { issues: 1 })),
  },
];

const OPTIONS = {
  windowDays: 30,
  minWindowDays: 14,
  regressionIssues: [4145, 4162],
};

Deno.test("green gate - a clean window is GREEN and states the window length (Issue #4189)", async () => {
  const evidence = await gatherGreenGateEvidence(
    sources({
      readRunCoreLogs: () => Promise.resolve([CLEAN_RUN_CORE]),
      listWorkerLogs: () => Promise.resolve(CLEAN_WORKER_LOGS),
    }),
    OPTIONS,
  );
  const report = analyseGreenGate(evidence, OPTIONS);
  assertEquals(report.verdict, "GREEN");
  assertEquals(report.reasons, []);
  assertEquals(report.host.launches.container, 3);
  assertEquals(report.host.launches.hostMode, 0);
  assertEquals(report.host.issuesProcessed, 3);
  // The window: first evidence 2026-07-20 → now 2026-08-18 = 29 days,
  // capped by the requested 30.
  assertEquals(report.observedWindowDays, 29);
  const md = formatGreenGateReport(report);
  assertStringIncludes(md, "**Verdict: GREEN**");
  assertStringIncludes(md, "29 days");
  assertStringIncludes(md, "host-23");
});

Deno.test("green gate - a host-mode launch is NOT GREEN and the offending launch is named (Issue #4189)", async () => {
  const runCore = [
    launchBlock("2026-07-20T01:00:00Z", "vibe-a", "container"),
    launchBlock("2026-08-02T09:00:00Z", "vibe-fallback", "native"),
    launchBlock("2026-08-17T01:00:00Z", "vibe-c", "seatbelt"),
  ].join("\n");
  const evidence = await gatherGreenGateEvidence(
    sources({
      readRunCoreLogs: () => Promise.resolve([runCore]),
      listWorkerLogs: () => Promise.resolve(CLEAN_WORKER_LOGS),
    }),
    OPTIONS,
  );
  const report = analyseGreenGate(evidence, OPTIONS);
  assertEquals(report.verdict, "NOT GREEN");
  assertEquals(report.host.launches.hostMode, 2);
  assert(
    report.reasons.some((r) => r.includes("host-mode") && r.includes("2")),
    JSON.stringify(report.reasons),
  );
  const md = formatGreenGateReport(report);
  assertStringIncludes(md, "**Verdict: NOT GREEN**");
  // Named: run id, mode and time of each offending launch.
  assertStringIncludes(md, "vibe-fallback");
  assertStringIncludes(md, "native");
  assertStringIncludes(md, "2026-08-02T09:00:00Z");
  assertStringIncludes(md, "seatbelt");
});

Deno.test("green gate - a window shorter than the minimum is NOT GREEN with the reason (Issue #4189)", async () => {
  const runCore = [
    launchBlock("2026-08-15T01:00:00Z", "vibe-x", "container"),
    launchBlock("2026-08-17T01:00:00Z", "vibe-y", "container"),
  ].join("\n");
  const evidence = await gatherGreenGateEvidence(
    sources({
      readRunCoreLogs: () => Promise.resolve([runCore]),
      listWorkerLogs: () => Promise.resolve([CLEAN_WORKER_LOGS[1]!]),
    }),
    OPTIONS,
  );
  const report = analyseGreenGate(evidence, OPTIONS);
  assertEquals(report.verdict, "NOT GREEN");
  assertEquals(report.observedWindowDays, 3);
  assert(
    report.reasons.some((r) =>
      /window.*3 day.*(minimum|at least).*14/i.test(r)
    ),
    JSON.stringify(report.reasons),
  );
});

Deno.test("green gate - an empty log set is INSUFFICIENT EVIDENCE, never GREEN (Issue #4189)", async () => {
  const evidence = await gatherGreenGateEvidence(sources(), OPTIONS);
  const report = analyseGreenGate(evidence, OPTIONS);
  assertEquals(report.verdict, "INSUFFICIENT EVIDENCE");
  assert(report.reasons.length > 0);
  const md = formatGreenGateReport(report);
  assertStringIncludes(md, "**Verdict: INSUFFICIENT EVIDENCE**");
  assert(!md.includes("Verdict: GREEN"), md);
});

Deno.test("green gate - launches with no run-mode record are unverified and block GREEN (Issue #4189)", async () => {
  // Older run_core.log blocks predate the record: a launch is visible
  // (VIBE_RUN_ID) but its mode is not — never counted as container.
  const runCore = [
    "2026-07-20T01:00:00Z VIBE_RUN_ID=vibe-old",
    launchBlock("2026-08-17T01:00:00Z", "vibe-c", "container"),
  ].join("\n");
  const evidence = await gatherGreenGateEvidence(
    sources({
      readRunCoreLogs: () => Promise.resolve([runCore]),
      listWorkerLogs: () => Promise.resolve(CLEAN_WORKER_LOGS),
    }),
    OPTIONS,
  );
  const report = analyseGreenGate(evidence, OPTIONS);
  assertEquals(report.host.launches.unknown, 1);
  assertEquals(report.verdict, "NOT GREEN");
  assert(
    report.reasons.some((r) => /no run-mode record/i.test(r)),
    JSON.stringify(report.reasons),
  );
});

Deno.test("green gate - an open regression issue is NOT GREEN; a failed lookup is unverified (Issue #4189)", async () => {
  const base = {
    readRunCoreLogs: () => Promise.resolve([CLEAN_RUN_CORE]),
    listWorkerLogs: () => Promise.resolve(CLEAN_WORKER_LOGS),
  };
  const withOpen = analyseGreenGate(
    await gatherGreenGateEvidence(
      sources({
        ...base,
        openIssues: () =>
          Promise.resolve([{ number: 4162, title: "still open" }]),
      }),
      OPTIONS,
    ),
    OPTIONS,
  );
  assertEquals(withOpen.verdict, "NOT GREEN");
  assert(
    withOpen.reasons.some((r) => r.includes("#4162")),
    JSON.stringify(withOpen.reasons),
  );

  const unknown = analyseGreenGate(
    await gatherGreenGateEvidence(
      sources({
        ...base,
        openIssues: () => Promise.reject(new Error("gh offline")),
      }),
      OPTIONS,
    ),
    OPTIONS,
  );
  assertEquals(unknown.verdict, "NOT GREEN");
  assert(
    unknown.reasons.some((r) => /could not verify/i.test(r)),
    JSON.stringify(unknown.reasons),
  );
});

Deno.test("green gate - restarts, breaker trips and kills are counted from the logs (Issue #4189)", async () => {
  const selfHeal = [
    JSON.stringify({
      timestamp: "2026-08-10T01:00:00Z",
      module: "container_restart",
      action: "restart_backoff",
      reason: "x",
      result: "ok",
    }),
    JSON.stringify({
      timestamp: "2026-08-11T01:00:00Z",
      module: "container_restart",
      action: "escalated",
      reason: "x",
      result: "ok",
    }),
    JSON.stringify({
      timestamp: "2026-06-01T01:00:00Z",
      module: "container_restart",
      action: "restart_backoff",
      reason: "outside window",
      result: "ok",
    }),
    JSON.stringify({
      timestamp: "2026-08-12T01:00:00Z",
      module: "crash_cleanup",
      action: "cleared",
      reason: "x",
      result: "ok",
    }),
  ].join("\n");
  const noisy = workerLog("2026-08-17T01:00:00Z", {
    issues: 1,
    extra: [
      "[2026-08-17 02:30:00Z] ERROR: ACTION REQUIRED: agent credential is failing (fresh auth probe after 2 consecutive claim failures) — boom. Stopping claims for this cycle; the next cycle's health gate re-checks automatically.",
      "[2026-08-17 02:50:00Z] [SECURITY] [AGENT_KILLED] raw_exit_code=137 memory_pressure=high",
    ],
  });
  const evidence = await gatherGreenGateEvidence(
    sources({
      readRunCoreLogs: () => Promise.resolve([CLEAN_RUN_CORE]),
      listWorkerLogs: () =>
        Promise.resolve([{
          name: "worker-20260817-010000.log",
          read: () => Promise.resolve(noisy),
        }]),
      readSelfHealEvents: () => Promise.resolve(selfHeal),
    }),
    OPTIONS,
  );
  const report = analyseGreenGate(evidence, OPTIONS);
  assertEquals(
    report.host.restarts,
    2,
    "container_restart events inside the window",
  );
  assertEquals(report.host.crashCleanups, 1);
  assertEquals(report.host.authBreakerTrips, 1);
  assertEquals(report.host.agentKills, 1);
  const md = formatGreenGateReport(report);
  assertStringIncludes(md, "| Auth-failure breaker trips | 1 |");
});

Deno.test("green gate - the report never carries a credential-shaped value (Issue #4189)", async () => {
  const leaky = workerLog("2026-08-17T01:00:00Z", {
    extra: [
      "[2026-08-17 02:00:00Z] INFO: token value SHOULDNOTAPPEAR-in-the-report",
    ],
  });
  const evidence = await gatherGreenGateEvidence(
    sources({
      readRunCoreLogs: () => Promise.resolve([CLEAN_RUN_CORE]),
      listWorkerLogs: () =>
        Promise.resolve([{
          name: "worker-20260817-010000.log",
          read: () => Promise.resolve(leaky),
        }]),
    }),
    OPTIONS,
  );
  const md = formatGreenGateReport(analyseGreenGate(evidence, OPTIONS));
  assert(
    !md.includes("SHOULDNOTAPPEAR"),
    "the report quotes counts, never log lines",
  );
});
