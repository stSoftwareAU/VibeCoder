/**
 * Green-gate evidence report (Issue #4189).
 *
 * Phase 0 of plan #4160 is a gate, not an aspiration: the fleet must be
 * observed running clean in container mode, and Phase 4 wants "months (not
 * days) of clean containment operation as evidence, not intention". This
 * module turns the local run logs into that evidence: one host, one window,
 * counts the operator can point at, and a verdict that is GREEN only when
 * every condition is met — never GREEN by absence of data.
 *
 * Sources (all local, all injectable for tests):
 * - `~/logs/run_core.log` (+ rotated siblings): one block per launch
 *   (`VIBE_RUN_ID=…`) and, since this issue, the per-launch record
 *   `run mode: <mode> host=<host> run_id=<id>` (`run_mode_record.ts`).
 * - `~/logs/worker-*.log(.gz)`: `Processing issue`, `Releasing claim`,
 *   `[WORKER_SUMMARY]`, `Reporting health as Vibe Coder:<host>`,
 *   `FLEET heartbeat failed`, `ACTION REQUIRED: agent credential is failing`,
 *   `[SECURITY] [AGENT_KILLED]`.
 * - `~/logs/self-heal.jsonl`: `container_restart` and `crash_cleanup` events.
 * - GitHub (optional): which of the named regression issues are still open.
 *
 * Verdict rules:
 * - INSUFFICIENT EVIDENCE — no launch with a known run mode in the window.
 * - NOT GREEN — any host-mode launch (native or seatbelt: both run on the
 *   host, outside the #4060 boundary), any launch with no run-mode record
 *   (unverified is not container), a window shorter than the minimum, an
 *   open regression issue, or a regression lookup that could not be made.
 * - GREEN — otherwise, with the observed window stated.
 *
 * The report quotes counts, ids and timestamps — never raw log lines — so
 * it cannot carry a credential.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { parseRunModeRecord } from "./run_mode_record.ts";

/** Run modes that execute on the host, outside the #4060 boundary. */
export const HOST_MODE_RUN_MODES: readonly string[] = ["native", "seatbelt"];

/** A gap between consecutive private-repo-6 reports longer than this counts. */
export const HEARTBEAT_GAP_THRESHOLD_MS = 90 * 60 * 1000;

/** The regression issues the Phase 0 gate names (plan #4160, this issue). */
export const DEFAULT_REGRESSION_ISSUES: readonly number[] = [
  4145,
  4146,
  4147,
  4148,
  4149,
  4150,
  4151,
  4154,
  4155,
  4156,
  4157,
  4158,
  4162,
  4167,
  4169,
  4170,
  4173,
];

/** Injectable evidence sources. */
export interface GreenGateSources {
  now(): Date;
  /** This host's id, as private-repo-6 names it. */
  hostId(): string;
  /** Text of `run_core.log` and its rotated siblings, any order. */
  readRunCoreLogs(): Promise<string[]>;
  /** Worker logs by name, read lazily (gzip handled by the source). */
  listWorkerLogs(): Promise<
    Array<{ name: string; read: () => Promise<string> }>
  >;
  /** Text of `self-heal.jsonl` (empty when absent). */
  readSelfHealEvents(): Promise<string>;
  /** Regression issues still open — rejects when the lookup cannot be made. */
  openIssues(numbers: readonly number[]): Promise<
    Array<{ number: number; title: string }>
  >;
}

/** Report options. */
export interface GreenGateOptions {
  /** How far back to look. */
  windowDays: number;
  /** Shortest observed window that may be GREEN. */
  minWindowDays: number;
  /** Regression issues that must be closed. */
  regressionIssues: readonly number[];
}

/** One launch seen in run_core.log. */
export interface LaunchRecord {
  runId: string;
  at: string;
  mode: string | undefined;
  host: string | undefined;
}

/** Everything gathered, before analysis. */
export interface GreenGateEvidence {
  generatedAt: string;
  hostId: string;
  windowStart: string;
  launches: LaunchRecord[];
  workerLogsRead: number;
  issuesProcessed: number;
  claimsReleased: number;
  heartbeatGaps: number;
  heartbeatFailures: number;
  authBreakerTrips: number;
  agentKills: number;
  restarts: number;
  crashCleanups: number;
  /** Earliest evidence timestamp inside the window, if any. */
  earliestEvidence: string | undefined;
  regression:
    | { status: "checked"; open: Array<{ number: number; title: string }> }
    | { status: "unverified"; reason: string };
}

/** Per-host figures the report prints. */
export interface GreenGateHostSummary {
  hostId: string;
  launches: {
    total: number;
    container: number;
    hostMode: number;
    unknown: number;
  };
  hostModeLaunches: LaunchRecord[];
  unknownLaunches: LaunchRecord[];
  issuesProcessed: number;
  claimsReleased: number;
  restarts: number;
  crashCleanups: number;
  heartbeatGaps: number;
  heartbeatFailures: number;
  authBreakerTrips: number;
  agentKills: number;
}

export type GreenGateVerdict = "GREEN" | "NOT GREEN" | "INSUFFICIENT EVIDENCE";

/** The analysed report. */
export interface GreenGateReport {
  generatedAt: string;
  windowDays: number;
  minWindowDays: number;
  observedWindowDays: number;
  windowStart: string;
  host: GreenGateHostSummary;
  regressionIssues: readonly number[];
  regression: GreenGateEvidence["regression"];
  verdict: GreenGateVerdict;
  reasons: string[];
}

const RUN_CORE_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(.*)$/;
const RUN_ID_RE = /^VIBE_RUN_ID=(\S+)/;
const WORKER_TS_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})Z\]/;
const PROCESSING_RE = /INFO: (?:\[[^\]]*\] )?Processing issue (\S+#\d+)/;
const RELEASING_RE = /INFO: (?:\[[^\]]*\] )?Releasing claim (\S+#\d+)/;
const HEALTH_RE = /Reporting health as Vibe Coder:/;
const HEARTBEAT_FAILED_RE = /FLEET heartbeat failed/;
const AUTH_BREAKER_RE = /ACTION REQUIRED: agent credential is failing/;
const AGENT_KILLED_RE = /\[SECURITY\] \[AGENT_KILLED\]/;

function parseWorkerTimestamp(line: string): number | undefined {
  const m = line.match(WORKER_TS_RE);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(t) ? undefined : t;
}

/** Read every source into a {@link GreenGateEvidence}. */
export async function gatherGreenGateEvidence(
  sources: GreenGateSources,
  options: GreenGateOptions,
): Promise<GreenGateEvidence> {
  const now = sources.now();
  const windowStartMs = now.getTime() - options.windowDays * 86_400_000;
  const inWindow = (ms: number) => ms >= windowStartMs && ms <= now.getTime();
  let earliest: number | undefined;
  const noteEvidence = (ms: number) => {
    if (!inWindow(ms)) return;
    if (earliest === undefined || ms < earliest) earliest = ms;
  };

  // --- run_core.log: launches and their run mode -------------------------
  const launches = new Map<string, LaunchRecord>();
  for (const text of await sources.readRunCoreLogs()) {
    for (const raw of text.split("\n")) {
      const m = raw.match(RUN_CORE_LINE_RE);
      if (!m) continue;
      const [, ts, message] = m;
      const at = Date.parse(ts ?? "");
      if (Number.isNaN(at) || !inWindow(at)) continue;
      const runIdMatch = (message ?? "").match(RUN_ID_RE);
      if (runIdMatch) {
        const runId = runIdMatch[1] ?? "unknown";
        if (!launches.has(runId)) {
          launches.set(runId, {
            runId,
            at: ts ?? "",
            mode: undefined,
            host: undefined,
          });
        }
        noteEvidence(at);
        continue;
      }
      const record = parseRunModeRecord(message ?? "");
      if (record) {
        const existing = launches.get(record.runId);
        if (existing) {
          existing.mode = record.mode;
          existing.host = record.host;
        } else {
          launches.set(record.runId, {
            runId: record.runId,
            at: ts ?? "",
            mode: record.mode,
            host: record.host,
          });
        }
        noteEvidence(at);
      }
    }
  }

  // --- worker logs: claims, heartbeats, breaker, kills --------------------
  const processed = new Set<string>();
  let claimsReleased = 0;
  let heartbeatGaps = 0;
  let heartbeatFailures = 0;
  let authBreakerTrips = 0;
  let agentKills = 0;
  let workerLogsRead = 0;
  for (const log of await sources.listWorkerLogs()) {
    let text: string;
    try {
      text = await log.read();
    } catch {
      continue;
    }
    workerLogsRead++;
    let lastHealthMs: number | undefined;
    for (const line of text.split("\n")) {
      const ts = parseWorkerTimestamp(line);
      if (ts === undefined || !inWindow(ts)) continue;
      noteEvidence(ts);
      const p = line.match(PROCESSING_RE);
      if (p) {
        processed.add(`${p[1]}@${ts}`);
        continue;
      }
      if (RELEASING_RE.test(line)) {
        claimsReleased++;
        continue;
      }
      if (HEALTH_RE.test(line)) {
        if (
          lastHealthMs !== undefined &&
          ts - lastHealthMs > HEARTBEAT_GAP_THRESHOLD_MS
        ) {
          heartbeatGaps++;
        }
        lastHealthMs = ts;
        continue;
      }
      if (HEARTBEAT_FAILED_RE.test(line)) heartbeatFailures++;
      else if (AUTH_BREAKER_RE.test(line)) authBreakerTrips++;
      else if (AGENT_KILLED_RE.test(line)) agentKills++;
    }
  }

  // --- self-heal.jsonl: restarts and crash cleanups ---------------------
  let restarts = 0;
  let crashCleanups = 0;
  for (const line of (await sources.readSelfHealEvents()).split("\n")) {
    if (!line.trim()) continue;
    let event: { timestamp?: string; module?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(event.timestamp ?? "");
    if (Number.isNaN(at) || !inWindow(at)) continue;
    if (event.module === "container_restart") restarts++;
    else if (event.module === "crash_cleanup") crashCleanups++;
  }

  // --- regression issues -----------------------------------------------
  let regression: GreenGateEvidence["regression"];
  try {
    const open = await sources.openIssues(options.regressionIssues);
    regression = { status: "checked", open };
  } catch (err) {
    regression = {
      status: "unverified",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    generatedAt: now.toISOString(),
    hostId: sources.hostId(),
    windowStart: new Date(windowStartMs).toISOString(),
    launches: [...launches.values()].sort((a, b) => a.at.localeCompare(b.at)),
    workerLogsRead,
    issuesProcessed: processed.size,
    claimsReleased,
    heartbeatGaps,
    heartbeatFailures,
    authBreakerTrips,
    agentKills,
    restarts,
    crashCleanups,
    earliestEvidence: earliest === undefined
      ? undefined
      : new Date(earliest).toISOString(),
    regression,
  };
}

/** Pure: evidence + options → verdict and figures. */
export function analyseGreenGate(
  evidence: GreenGateEvidence,
  options: GreenGateOptions,
): GreenGateReport {
  const container = evidence.launches.filter((l) => l.mode === "container");
  const hostMode = evidence.launches.filter((l) =>
    l.mode !== undefined && HOST_MODE_RUN_MODES.includes(l.mode)
  );
  const unknown = evidence.launches.filter((l) =>
    l.mode === undefined ||
    (l.mode !== "container" && !HOST_MODE_RUN_MODES.includes(l.mode))
  );

  const nowMs = Date.parse(evidence.generatedAt);
  const observedWindowDays = evidence.earliestEvidence === undefined
    ? 0
    : Math.min(
      options.windowDays,
      Math.floor((nowMs - Date.parse(evidence.earliestEvidence)) / 86_400_000),
    );

  const reasons: string[] = [];
  let verdict: GreenGateVerdict;
  if (container.length + hostMode.length === 0) {
    verdict = "INSUFFICIENT EVIDENCE";
    reasons.push(
      unknown.length > 0
        ? `${unknown.length} launch(es) in the window carry no run-mode record — the mode cannot be verified from the logs`
        : "no launches with a run-mode record were found in the window — nothing to judge",
    );
  } else {
    if (hostMode.length > 0) {
      reasons.push(
        `${hostMode.length} host-mode launch(es) in the window (must be zero): ${
          hostMode.map((l) => `${l.runId} (${l.mode}, ${l.at})`).join("; ")
        }`,
      );
    }
    if (unknown.length > 0) {
      reasons.push(
        `${unknown.length} launch(es) have no run-mode record and count as unverified, not container: ${
          unknown.map((l) => `${l.runId} (${l.at})`).join("; ")
        }`,
      );
    }
    if (observedWindowDays < options.minWindowDays) {
      reasons.push(
        `observed window is ${observedWindowDays} day(s); the gate needs at least ${options.minWindowDays}`,
      );
    }
    if (evidence.regression.status === "unverified") {
      reasons.push(
        `could not verify the regression issues (${evidence.regression.reason})`,
      );
    } else if (evidence.regression.open.length > 0) {
      reasons.push(
        `open regression issue(s): ${
          evidence.regression.open.map((i) => `#${i.number} ${i.title}`).join(
            "; ",
          )
        }`,
      );
    }
    verdict = reasons.length === 0 ? "GREEN" : "NOT GREEN";
  }

  return {
    generatedAt: evidence.generatedAt,
    windowDays: options.windowDays,
    minWindowDays: options.minWindowDays,
    observedWindowDays,
    windowStart: evidence.windowStart,
    host: {
      hostId: evidence.hostId,
      launches: {
        total: evidence.launches.length,
        container: container.length,
        hostMode: hostMode.length,
        unknown: unknown.length,
      },
      hostModeLaunches: hostMode,
      unknownLaunches: unknown,
      issuesProcessed: evidence.issuesProcessed,
      claimsReleased: evidence.claimsReleased,
      restarts: evidence.restarts,
      crashCleanups: evidence.crashCleanups,
      heartbeatGaps: evidence.heartbeatGaps,
      heartbeatFailures: evidence.heartbeatFailures,
      authBreakerTrips: evidence.authBreakerTrips,
      agentKills: evidence.agentKills,
    },
    regressionIssues: options.regressionIssues,
    regression: evidence.regression,
    verdict,
    reasons,
  };
}

/** Render the report as Markdown (markdownlint-clean, no Liquid). */
export function formatGreenGateReport(report: GreenGateReport): string {
  const h = report.host;
  const lines: string[] = [];
  lines.push("# Green-gate evidence report");
  lines.push("");
  lines.push(
    `Generated ${report.generatedAt} by \`mod.ts green-gate-report\` (Issue #4189). ` +
      "Operator telemetry for the Phase 0 gate of plan #4160 — private, not for export.",
  );
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`**Verdict: ${report.verdict}**`);
  lines.push("");
  lines.push(
    `Observed window: ${report.observedWindowDays} days (requested ${report.windowDays}, ` +
      `minimum for GREEN ${report.minWindowDays}); window start ${report.windowStart}.`,
  );
  lines.push("");
  if (report.reasons.length > 0) {
    lines.push("Reasons:");
    lines.push("");
    for (const r of report.reasons) lines.push(`- ${r}`);
    lines.push("");
  } else {
    lines.push(
      "All conditions met: zero host-mode launches, every launch verified as container mode, " +
        "window at least the minimum, no open regression issue.",
    );
    lines.push("");
  }
  lines.push("## Host");
  lines.push("");
  lines.push(
    "One row per host; this file is produced on the host it describes " +
      "(the fleet view is the union of each host's report).",
  );
  lines.push("");
  lines.push("| Host | Metric | Value |");
  lines.push("| --- | --- | --- |");
  const row = (metric: string, value: number | string) =>
    lines.push(`| ${h.hostId} | ${metric} | ${value} |`);
  row("Launches (total)", h.launches.total);
  row("Container-mode launches", h.launches.container);
  row(
    "Host-mode launches (native/seatbelt) — must be zero",
    h.launches.hostMode,
  );
  row("Launches with no run-mode record (unverified)", h.launches.unknown);
  row("Issues processed", h.issuesProcessed);
  row("Claims released", h.claimsReleased);
  row("Container restarts / backoffs", h.restarts);
  row("Crash cleanups", h.crashCleanups);
  row(
    "Heartbeat gaps (over 90 min between private-repo-6 reports)",
    h.heartbeatGaps,
  );
  row("Heartbeat push failures", h.heartbeatFailures);
  row("Auth-failure breaker trips", h.authBreakerTrips);
  row("Agent processes killed (SIGKILL)", h.agentKills);
  lines.push("");
  if (h.hostModeLaunches.length > 0) {
    lines.push("### Host-mode launches");
    lines.push("");
    lines.push("| Run id | Mode | Started |");
    lines.push("| --- | --- | --- |");
    for (const l of h.hostModeLaunches) {
      lines.push(`| ${l.runId} | ${l.mode} | ${l.at} |`);
    }
    lines.push("");
  }
  if (h.unknownLaunches.length > 0) {
    lines.push("### Launches with no run-mode record");
    lines.push("");
    lines.push("| Run id | Started |");
    lines.push("| --- | --- |");
    for (const l of h.unknownLaunches) lines.push(`| ${l.runId} | ${l.at} |`);
    lines.push("");
  }
  lines.push("## Regression issues");
  lines.push("");
  lines.push(
    `Checked: ${report.regressionIssues.map((n) => `#${n}`).join(", ")}.`,
  );
  lines.push("");
  if (report.regression.status === "unverified") {
    lines.push(`Lookup failed: ${report.regression.reason}.`);
  } else if (report.regression.open.length === 0) {
    lines.push("All closed.");
  } else {
    lines.push("Still open:");
    lines.push("");
    for (const i of report.regression.open) {
      lines.push(`- #${i.number} ${i.title}`);
    }
  }
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push(
    "- Launches and run modes: `run_core.log` (`VIBE_RUN_ID=…` and `run mode: … host=… run_id=…` records).",
  );
  lines.push(
    "- Issues, claims, heartbeats, breaker trips, kills: `worker-*.log` (gzip included) within the window.",
  );
  lines.push("- Restarts and crash cleanups: `self-heal.jsonl`.");
  lines.push(
    "- A launch with no run-mode record is unverified and never counted as container; " +
      "an empty log set is INSUFFICIENT EVIDENCE, not GREEN.",
  );
  lines.push("");
  return lines.join("\n");
}
