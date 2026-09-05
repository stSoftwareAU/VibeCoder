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
 *   `[WORKER_SUMMARY]`, `ACTION REQUIRED: agent credential is failing`,
 *   `[SECURITY] [AGENT_KILLED]`.
 * - `~/logs/self-heal.jsonl`: `container_restart` and `crash_cleanup` events,
 *   including the `host_parked` events that say this host is offering the
 *   fleet no capacity at all, and why (Issue #997).
 * - GitHub (optional): which of the named regression issues are still open.
 *
 * Verdict rules:
 * - INSUFFICIENT EVIDENCE — no launch with a known run mode in the window.
 * - NOT GREEN — any host-mode launch (the removed native or seatbelt modes,
 *   Issue #4: both ran on the host, outside the #4060 boundary — a record
 *   naming one is a launch from a checkout older than the removal), any
 *   launch with no run-mode record
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

/**
 * Run modes that executed on the host, outside the #4060 boundary. Both were
 * removed by Issue #4 — containment is mandatory — and stay named here so a
 * launch record from an older checkout is still judged NOT GREEN.
 */
export const HOST_MODE_RUN_MODES: readonly string[] = ["native", "seatbelt"];

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
  /** This host's id, as the fleet names it. */
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

/**
 * What the launcher recorded about a host that could not run containers
 * (Issue #997).
 *
 * A parked host stops emitting everything else — no launch, no worker log, no
 * slot-utilisation line — so its absence used to be indistinguishable from a
 * quiet week. The `host_parked` self-heal events are the record that says
 * otherwise, and they carry the reason with them.
 */
export interface HostParkedEvidence {
  /** Cycles inside the window on which the host parked itself. */
  cycles: number;
  /**
   * True when the launcher's most recent word in the window was a park — the
   * host is still unavailable, rather than parked earlier and running since.
   */
  current: boolean;
  /** The named reason of the latest park, e.g. `container_egress_blocked`. */
  reason: string | undefined;
  /** When the latest park was recorded. */
  at: string | undefined;
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
  authBreakerTrips: number;
  agentKills: number;
  restarts: number;
  crashCleanups: number;
  /** What the host's own launcher last said about its availability (#997). */
  parked: HostParkedEvidence;
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
  authBreakerTrips: number;
  agentKills: number;
  /**
   * Whether this host is offering the fleet any capacity at all (Issue #997).
   * `unavailable` when its launcher parked it and nothing has launched since.
   */
  availability: "available" | "unavailable";
  /** Why it is unavailable, when it is — e.g. `container_egress_blocked`. */
  unavailableReason?: string;
  /** Cycles in the window on which the host parked itself. */
  parkedCycles: number;
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
const AUTH_BREAKER_RE = /ACTION REQUIRED: agent credential is failing/;
const AGENT_KILLED_RE = /\[SECURITY\] \[AGENT_KILLED\]/;

/** The self-heal action a launcher writes when it parks a host (Issue #997). */
const HOST_PARKED_ACTION = "host_parked";

/** The failure phase a park is recorded under (Issue #997). */
const EGRESS_PHASE = "container_egress";

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

  // --- worker logs: claims, breaker trips, kills --------------------------
  const processed = new Set<string>();
  let claimsReleased = 0;
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
      if (AUTH_BREAKER_RE.test(line)) authBreakerTrips++;
      else if (AGENT_KILLED_RE.test(line)) agentKills++;
    }
  }

  // --- self-heal.jsonl: restarts, crash cleanups and parks --------------
  //
  // Issue #997: a park is not a restart. The launcher parked *instead of*
  // building, so counting it beside the restarts would report a host that ran
  // nothing as one that kept retrying. It is counted on its own, and the
  // latest park is compared with the latest evidence that the host ran a
  // container at all — a launch that reached the worker, a recovery, a pause,
  // or a failure in any other phase — so a host parked last week but running
  // since is not reported as unavailable now.
  let restarts = 0;
  let crashCleanups = 0;
  let parkedCycles = 0;
  let latestParkAt: number | undefined;
  let parkReason: string | undefined;
  // Launches are already window-filtered above, and one that recorded its run
  // mode reached the worker — which a parked host never does.
  let latestRunningAt: number | undefined;
  for (const launch of launches.values()) {
    const at = Date.parse(launch.at);
    if (
      !Number.isNaN(at) &&
      (latestRunningAt === undefined || at > latestRunningAt)
    ) {
      latestRunningAt = at;
    }
  }
  for (const line of (await sources.readSelfHealEvents()).split("\n")) {
    if (!line.trim()) continue;
    let event: {
      timestamp?: string;
      module?: string;
      action?: string;
      details?: { reason?: unknown; phase?: unknown };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(event.timestamp ?? "");
    if (Number.isNaN(at) || !inWindow(at)) continue;
    if (event.module === "crash_cleanup") {
      crashCleanups++;
      continue;
    }
    if (event.module !== "container_restart") continue;
    if (event.action === HOST_PARKED_ACTION) {
      parkedCycles++;
      if (latestParkAt === undefined || at >= latestParkAt) {
        latestParkAt = at;
        parkReason = typeof event.details?.reason === "string"
          ? event.details.reason
          : undefined;
      }
      continue;
    }
    restarts++;
    // Everything else from this module describes a launcher that got as far
    // as running, or failing at, a phase the park replaces.
    if (event.details?.phase !== EGRESS_PHASE) {
      if (latestRunningAt === undefined || at > latestRunningAt) {
        latestRunningAt = at;
      }
    }
  }
  const parked: HostParkedEvidence = {
    cycles: parkedCycles,
    current: latestParkAt !== undefined &&
      (latestRunningAt === undefined || latestRunningAt <= latestParkAt),
    reason: parkReason,
    at: latestParkAt === undefined
      ? undefined
      : new Date(latestParkAt).toISOString(),
  };

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
    authBreakerTrips,
    agentKills,
    restarts,
    crashCleanups,
    parked,
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
      authBreakerTrips: evidence.authBreakerTrips,
      agentKills: evidence.agentKills,
      // Issue #997: capacity the fleet has lost, named. A host that cannot
      // run containers reports why rather than simply going quiet.
      availability: evidence.parked.current ? "unavailable" : "available",
      ...(evidence.parked.current && evidence.parked.reason
        ? { unavailableReason: evidence.parked.reason }
        : {}),
      parkedCycles: evidence.parked.cycles,
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
  // Issue #997: first, because a host offering no capacity makes every count
  // below it a description of a machine that is not working.
  row(
    "Availability",
    h.availability === "unavailable"
      ? `unavailable — ${h.unavailableReason ?? "reason not recorded"}`
      : "available",
  );
  row("Parked cycles (host could not run a container)", h.parkedCycles);
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
    "- Issues, claims, breaker trips, kills: `worker-*.log` (gzip included) within the window.",
  );
  lines.push(
    "- Restarts, crash cleanups and parks (availability): `self-heal.jsonl`.",
  );
  lines.push(
    "- A launch with no run-mode record is unverified and never counted as container; " +
      "an empty log set is INSUFFICIENT EVIDENCE, not GREEN.",
  );
  lines.push("");
  return lines.join("\n");
}
