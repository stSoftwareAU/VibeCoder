/**
 * Weekly report section for the TokenEconomizer trial (Issue #4958).
 *
 * Compares the trial host's switched-on runs with the two comparison sets that
 * `docs/TOKEN-ECONOMIZER-TRIAL.md` section 5 defines (before, and concurrent),
 * on cost per completed implementation run, success rate and merge rate.
 *
 * The module is pure: run records and a pull request state lookup go in, a
 * report comes out. It renders no verdict; not yet: #4959 will apply the
 * predeclared bar. This module only shows the populations, the exclusions and
 * the figures, and says `unavailable` rather than guessing a missing one.
 *
 * Uses Australian English spelling throughout.
 */

const DAY_MS = 86_400_000;

/** Days before the window the "before" comparison reads (trial section 5). */
export const BEFORE_DAYS = 14;

/** The plugin states a run record can carry. */
export const TRIAL_STATUSES = [
  "on",
  "fallback",
  "stopped",
  "not-run",
  "off",
] as const;

/** One plugin status. */
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

/** The final-or-not state of a run's pull request. */
export type PrState = "merged" | "closed" | "open";

/** Injected pull request lookup. `undefined` means the state is unknown. */
export type PrStateLookup = (
  repository: string,
  prNumber: number,
) => Promise<PrState | undefined>;

/** A run record that passed validation. */
interface RunRecord {
  host: string;
  repository: string;
  completed: boolean;
  finishedAtMs: number;
  mode?: string;
  provider?: string;
  /** `telemetry.estimatedCostUsd`, when a valid number. */
  telemetryCostUsd?: number;
  prNumber?: number;
  rtkEnabled?: boolean;
  /** The document's `telemetryAbsentReason`, when a string. */
  absentReason?: string;
  /** The block, absent when the record carries no block. */
  block?: {
    /** `enabled === true`: the switch was on, whatever the plugin did. */
    enabled: boolean;
    status: TrialStatus;
    persisted: boolean;
    runCostUsd?: number;
    pluginCostUsd?: number;
    pluginEffectiveTokens?: number;
  };
}

/** Report options. */
export interface TrialReportOptions {
  trialHost: string;
  /** ISO instant. */
  windowStart: string;
  /** ISO instant; defaults to the injected clock. */
  windowEnd?: string;
  /** ISO instant from which a record without the block counts as switch-off. */
  recordedSince: string;
  /** Implementation mode label. Default `work-on`. */
  mode?: string;
  /** Injected clock. */
  now?: () => Date;
}

/** The cost figure for one population. */
export type CostFigure =
  | { available: true; totalUsd: number; perCompletedUsd: number }
  | {
    available: false;
    reason: string;
    missingCostRuns: number;
    /** Lower bound on cost per completed run from the known costs. */
    lowerBoundPerCompletedUsd?: number;
  };

/** The merge figure for one population. */
export interface MergeFigure {
  merged: number;
  closed: number;
  /** Pull requests with a final state: `merged + closed`. */
  known: number;
  open: number;
  unknown: number;
  /** Runs that raised no pull request; not in the denominator. */
  noPr: number;
  /** `merged / known`, or undefined when `known` is 0. */
  rate?: number;
}

/** Metrics for one population. */
export interface PopulationMetrics {
  runs: number;
  completed: number;
  successRate?: number;
  cost: CostFigure;
  merge: MergeFigure;
}

/** The relative cost difference of the switched-on side against a comparison. */
export type CostDifference =
  | { available: true; percent: number }
  | { available: false; reason: string };

/** Exclusion and population counts, all explicit. */
export interface TrialExclusions {
  malformed: number;
  /** Not an implementation run. */
  otherMode: number;
  /** Provider other than claude, or no provider. */
  nonClaude: number;
  /** No block and recorded before `recordedSince`. */
  unflagged: number;
  /** Trial host window runs with the switch off (in no comparison). */
  trialHostOff: number;
  /** Size of the switched-on population (intention to treat). */
  onRuns: number;
  /** Trial host window runs the switch was on for but another provider served (plugin off; in no comparison). */
  otherProviderOff: number;
  /** The switched-on population by plugin status (`off` is excluded above). */
  onByStatus: Record<Exclude<TrialStatus, "off">, number>;
  onPersisted: number;
  /** Trial host runs in the before period that were not switched off. */
  beforeNotOff: number;
  /** Other hosts' runs that were switched on or fell back (not controls). */
  otherHostNotOff: number;
  trialHostRtk: "enabled" | "disabled" | "mixed-or-unknown";
  rtkMismatchHosts: string[];
  rtkMismatchRecords: number;
  /** Repositories on one side of the concurrent comparison only. */
  oneSidedRepositories: number;
  oneSidedRepositoryNames: string[];
}

/** The whole report. */
export interface TokenEconomizerTrialReport {
  trialHost: string;
  mode: string;
  windowStart: string;
  windowEnd: string;
  beforeStart: string;
  recordedSince: string;
  switchedOn: PopulationMetrics;
  before: PopulationMetrics;
  concurrentOn: PopulationMetrics;
  concurrent: PopulationMetrics;
  beforeDifference: CostDifference;
  concurrentDifference: CostDifference;
  concurrentHosts: string[];
  exclusions: TrialExclusions;
}

/** Strict ISO 8601 instant parse. Returns undefined when invalid. */
export function parseIsoInstant(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  if (
    !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/
      .test(text.trim())
  ) {
    return undefined;
  }
  const ms = Date.parse(text.trim());
  return Number.isNaN(ms) ? undefined : ms;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function validCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Parse one untrusted record. Returns undefined when malformed. */
function parseRecord(raw: unknown): RunRecord | undefined {
  if (!isObject(raw)) return undefined;
  const host = nonEmptyString(raw.host);
  const repository = nonEmptyString(raw.repository);
  const finishedAtMs = parseIsoInstant(raw.finishedAt);
  if (
    host === undefined || repository === undefined ||
    finishedAtMs === undefined ||
    (raw.result !== "success" && raw.result !== "failure")
  ) {
    return undefined;
  }
  const record: RunRecord = {
    host,
    repository,
    completed: raw.result === "success",
    finishedAtMs,
  };
  if (typeof raw.mode === "string") record.mode = raw.mode;
  if (typeof raw.provider === "string") record.provider = raw.provider;
  if (typeof raw.telemetryAbsentReason === "string") {
    record.absentReason = raw.telemetryAbsentReason;
  }
  if (isObject(raw.telemetry)) {
    record.telemetryCostUsd = validCost(raw.telemetry.estimatedCostUsd);
  }
  if (isObject(raw.outcome)) {
    const pr = raw.outcome.prNumber;
    if (typeof pr === "number" && Number.isSafeInteger(pr) && pr > 0) {
      record.prNumber = pr;
    }
  }
  if (isObject(raw.rtk) && typeof raw.rtk.enabled === "boolean") {
    record.rtkEnabled = raw.rtk.enabled;
  }
  if (raw.tokenEconomizer !== undefined) {
    const block = raw.tokenEconomizer;
    if (!isObject(block)) return undefined;
    const status = block.enabled === false
      ? "off"
      : TRIAL_STATUSES.find((s) => s === block.status);
    if (status === undefined) return undefined;
    record.block = {
      enabled: block.enabled === true,
      status,
      persisted: block.persistence === "available",
      runCostUsd: validCost(block.runCostUsd),
      pluginCostUsd: validCost(block.pluginCostUsd),
      pluginEffectiveTokens: validCost(block.pluginEffectiveTokens),
    };
  }
  return record;
}

/** A run as the metrics see it. */
interface Sample {
  repository: string;
  completed: boolean;
  costUsd?: number;
  lowerBoundUsd?: number;
  prNumber?: number;
}

/** Missing plugin accounting is unknown spend, even when the run stopped. */
function onCost(r: RunRecord): number | undefined {
  if (r.absentReason === "agent_not_invoked") return 0;
  const b = r.block;
  if (b?.runCostUsd !== undefined) return b.runCostUsd;
  if (b?.pluginCostUsd === 0) return r.telemetryCostUsd;
  return undefined;
}

function onSample(r: RunRecord): Sample {
  return {
    repository: r.repository,
    completed: r.completed,
    costUsd: onCost(r),
    lowerBoundUsd: r.telemetryCostUsd,
    prNumber: r.prNumber,
  };
}

function offSample(r: RunRecord): Sample {
  return {
    repository: r.repository,
    completed: r.completed,
    costUsd: r.absentReason === "agent_not_invoked" ? 0 : r.telemetryCostUsd,
    prNumber: r.prNumber,
  };
}

type PrKey = string;
const prKey = (repository: string, pr: number): PrKey => `${repository}#${pr}`;

function computeMetrics(
  samples: readonly Sample[],
  states: ReadonlyMap<PrKey, PrState | undefined>,
): PopulationMetrics {
  const runs = samples.length;
  const completed = samples.filter((s) => s.completed).length;

  const missing = samples.filter((s) => s.costUsd === undefined).length;
  const knownTotal = samples.reduce(
    (sum, s) => sum + (s.costUsd ?? s.lowerBoundUsd ?? 0),
    0,
  );
  let cost: CostFigure;
  if (runs === 0) {
    cost = { available: false, reason: "no runs", missingCostRuns: 0 };
  } else if (missing > 0) {
    cost = {
      available: false,
      reason: `${missing} of ${runs} runs have no cost`,
      missingCostRuns: missing,
      ...(completed > 0
        ? { lowerBoundPerCompletedUsd: knownTotal / completed }
        : {}),
    };
  } else if (completed === 0) {
    cost = {
      available: false,
      reason: "no completed runs",
      missingCostRuns: 0,
    };
  } else {
    cost = {
      available: true,
      totalUsd: knownTotal,
      perCompletedUsd: knownTotal / completed,
    };
  }

  let merged = 0;
  let closed = 0;
  let open = 0;
  let unknown = 0;
  let noPr = 0;
  const seen = new Set<PrKey>();
  for (const s of samples) {
    if (s.prNumber === undefined) {
      noPr++;
      continue;
    }
    const key = prKey(s.repository, s.prNumber);
    if (seen.has(key)) continue;
    seen.add(key);
    const state = states.get(key);
    if (state === "merged") merged++;
    else if (state === "closed") closed++;
    else if (state === "open") open++;
    else unknown++;
  }
  const known = merged + closed;
  return {
    runs,
    completed,
    successRate: runs > 0 ? completed / runs : undefined,
    cost,
    merge: {
      merged,
      closed,
      known,
      open,
      unknown,
      noPr,
      rate: known > 0 ? merged / known : undefined,
    },
  };
}

function costDifference(
  on: PopulationMetrics,
  comparison: PopulationMetrics,
): CostDifference {
  if (!on.cost.available) {
    return { available: false, reason: "switched-on cost is unavailable" };
  }
  if (!comparison.cost.available) {
    return { available: false, reason: "comparison cost is unavailable" };
  }
  if (comparison.cost.perCompletedUsd === 0) {
    return { available: false, reason: "comparison cost is zero" };
  }
  return {
    available: true,
    percent: (on.cost.perCompletedUsd - comparison.cost.perCompletedUsd) /
      comparison.cost.perCompletedUsd * 100,
  };
}

/**
 * Build the report from untrusted parsed JSON records.
 *
 * @param rawRecords - Run archive documents, in any order.
 * @param options - Trial host, window and recording boundary.
 * @param lookup - Pull request state lookup, called once per distinct PR.
 * @throws RangeError when a date option is not a valid ISO instant.
 */
export async function buildTokenEconomizerTrialReport(
  rawRecords: readonly unknown[],
  options: TrialReportOptions,
  lookup: PrStateLookup,
): Promise<TokenEconomizerTrialReport> {
  const mode = options.mode ?? "work-on";
  const startMs = parseIsoInstant(options.windowStart);
  const endMs = options.windowEnd === undefined
    ? (options.now ?? (() => new Date()))().getTime()
    : parseIsoInstant(options.windowEnd);
  const sinceMs = parseIsoInstant(options.recordedSince);
  if (startMs === undefined) throw new RangeError("windowStart is not ISO");
  if (endMs === undefined) throw new RangeError("windowEnd is not ISO");
  if (sinceMs === undefined) throw new RangeError("recordedSince is not ISO");
  const beforeStartMs = startMs - BEFORE_DAYS * DAY_MS;

  const ex: TrialExclusions = {
    malformed: 0,
    otherMode: 0,
    nonClaude: 0,
    unflagged: 0,
    trialHostOff: 0,
    otherProviderOff: 0,
    onRuns: 0,
    onByStatus: { on: 0, fallback: 0, stopped: 0, "not-run": 0 },
    onPersisted: 0,
    beforeNotOff: 0,
    otherHostNotOff: 0,
    trialHostRtk: "mixed-or-unknown",
    rtkMismatchHosts: [],
    rtkMismatchRecords: 0,
    oneSidedRepositories: 0,
    oneSidedRepositoryNames: [],
  };

  const on: RunRecord[] = [];
  const before: RunRecord[] = [];
  const otherOff: RunRecord[] = [];
  const trialWindow: RunRecord[] = [];

  for (const raw of rawRecords) {
    const r = parseRecord(raw);
    if (r === undefined) {
      ex.malformed++;
      continue;
    }
    const inWindow = r.finishedAtMs >= startMs && r.finishedAtMs < endMs;
    const inBefore = r.finishedAtMs >= beforeStartMs &&
      r.finishedAtMs < startMs;
    if (!inWindow && !inBefore) continue;
    if (r.mode !== mode) {
      ex.otherMode++;
      continue;
    }
    if (r.provider !== "claude") {
      ex.nonClaude++;
      continue;
    }
    // A record without the block is a switch-off run only once records carry
    // the flag; earlier ones are unflagged, never assumed to be controls.
    if (r.block === undefined && r.finishedAtMs < sinceMs) {
      ex.unflagged++;
      continue;
    }
    // Switched on means the switch was on, whatever the plugin then did:
    // failed, stopped and early-exit attempts stay in (intention to treat).
    const switchedOn = r.block?.enabled === true;
    if (r.host === options.trialHost) {
      if (inWindow) {
        trialWindow.push(r);
        const block = r.block;
        if (switchedOn && block?.status === "off") {
          // Switch on but served by a non-Claude provider: plugin off, in
          // neither comparison (trial doc sections 2 and 5).
          ex.otherProviderOff++;
        } else if (switchedOn && block !== undefined) {
          on.push(r);
          ex.onRuns++;
          // `off` is handled above, so the status is an on-population one.
          ex.onByStatus[block.status as keyof typeof ex.onByStatus]++;
          if (block.persisted) ex.onPersisted++;
        } else ex.trialHostOff++;
      } else if (!switchedOn) before.push(r);
      else ex.beforeNotOff++;
    } else if (inWindow) {
      if (!switchedOn) otherOff.push(r);
      else ex.otherHostNotOff++;
    }
  }

  // RTK screening: a concurrent host must share the trial host's setting.
  const trialRtk = new Set(trialWindow.map((r) => r.rtkEnabled));
  let screened: boolean | undefined;
  if (trialRtk.size === 1 && !trialRtk.has(undefined)) {
    screened = [...trialRtk][0];
    ex.trialHostRtk = screened ? "enabled" : "disabled";
  }
  const hostRtk = new Map<string, Set<boolean | undefined>>();
  for (const r of otherOff) {
    const set = hostRtk.get(r.host) ?? new Set();
    set.add(r.rtkEnabled);
    hostRtk.set(r.host, set);
  }
  const mismatched = new Set<string>();
  if (screened !== undefined) {
    for (const [host, set] of hostRtk) {
      if (set.size !== 1 || !set.has(screened)) mismatched.add(host);
    }
  }
  ex.rtkMismatchHosts = [...mismatched].sort();
  const controls = otherOff.filter((r) => !mismatched.has(r.host));
  ex.rtkMismatchRecords = otherOff.length - controls.length;

  // Same repositories only: one-sided repositories leave both sides.
  const onRepos = new Set(on.map((r) => r.repository));
  const controlRepos = new Set(controls.map((r) => r.repository));
  const common = new Set([...onRepos].filter((x) => controlRepos.has(x)));
  const oneSided = [...onRepos, ...controlRepos].filter((x) => !common.has(x));
  ex.oneSidedRepositoryNames = [...new Set(oneSided)].sort();
  ex.oneSidedRepositories = ex.oneSidedRepositoryNames.length;
  const concurrentOn = on.filter((r) => common.has(r.repository));
  const concurrent = controls.filter((r) => common.has(r.repository));

  const onSamples = on.map(onSample);
  const beforeSamples = before.map(offSample);
  const concurrentOnSamples = concurrentOn.map(onSample);
  const concurrentSamples = concurrent.map(offSample);

  // Resolve each distinct pull request once.
  const states = new Map<PrKey, PrState | undefined>();
  for (
    const s of [
      ...onSamples,
      ...beforeSamples,
      ...concurrentOnSamples,
      ...concurrentSamples,
    ]
  ) {
    if (s.prNumber === undefined) continue;
    const key = prKey(s.repository, s.prNumber);
    if (states.has(key)) continue;
    try {
      states.set(key, await lookup(s.repository, s.prNumber));
    } catch {
      states.set(key, undefined);
    }
  }

  const switchedOn = computeMetrics(onSamples, states);
  const beforeMetrics = computeMetrics(beforeSamples, states);
  const concurrentOnMetrics = computeMetrics(concurrentOnSamples, states);
  const concurrentMetrics = computeMetrics(concurrentSamples, states);

  return {
    trialHost: options.trialHost,
    mode,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    beforeStart: new Date(beforeStartMs).toISOString(),
    recordedSince: new Date(sinceMs).toISOString(),
    switchedOn,
    before: beforeMetrics,
    concurrentOn: concurrentOnMetrics,
    concurrent: concurrentMetrics,
    beforeDifference: costDifference(switchedOn, beforeMetrics),
    concurrentDifference: costDifference(
      concurrentOnMetrics,
      concurrentMetrics,
    ),
    concurrentHosts: [...new Set(concurrent.map((r) => r.host))].sort(),
    exclusions: ex,
  };
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function successCell(m: PopulationMetrics): string {
  return m.successRate === undefined
    ? "unavailable — no runs"
    : `${pct(m.successRate)} (${m.completed} of ${m.runs})`;
}

function costCell(m: PopulationMetrics): string {
  const c = m.cost;
  if (c.available) {
    return `${usd(c.perCompletedUsd)} (${
      usd(c.totalUsd)
    } over ${m.completed} completed)`;
  }
  if (c.missingCostRuns > 0) {
    const bound = c.lowerBoundPerCompletedUsd === undefined
      ? ""
      : `; ≥ ${usd(c.lowerBoundPerCompletedUsd)}`;
    return `unavailable — ${c.reason}${bound}`;
  }
  return `unavailable — ${c.reason}`;
}

function mergeCell(m: PopulationMetrics): string {
  const g = m.merge;
  const detail =
    `${g.merged} merged, ${g.closed} closed, ${g.open} open, ${g.unknown} unknown; ${g.noPr} runs with no PR`;
  return g.rate === undefined
    ? `unavailable — no final pull request states (${detail})`
    : `${pct(g.rate)} (${g.merged} of ${g.known} final; ${detail})`;
}

function diffLine(label: string, d: CostDifference): string {
  return d.available
    ? `- ${label}: ${d.percent >= 0 ? "+" : ""}${d.percent.toFixed(1)}%`
    : `- ${label}: unavailable (${d.reason})`;
}

function table(
  onTitle: string,
  on: PopulationMetrics,
  cmpTitle: string,
  cmp: PopulationMetrics,
): string[] {
  return [
    `| Figure | ${onTitle} | ${cmpTitle} |`,
    "| ------ | ---------- | ---------- |",
    `| Runs | ${on.runs} | ${cmp.runs} |`,
    `| Completed | ${on.completed} | ${cmp.completed} |`,
    `| Success rate | ${successCell(on)} | ${successCell(cmp)} |`,
    `| Cost per completed run | ${costCell(on)} | ${costCell(cmp)} |`,
    `| Merge rate | ${mergeCell(on)} | ${mergeCell(cmp)} |`,
  ];
}

/** Render the weekly report section as Markdown. */
export function formatTokenEconomizerTrialSection(
  report: TokenEconomizerTrialReport,
): string {
  const e = report.exclusions;
  const lines: string[] = [
    "## TokenEconomizer trial comparison",
    "",
    `Trial host \`${report.trialHost}\`, mode \`${report.mode}\`, window ` +
    `${report.windowStart} to ${report.windowEnd}.`,
    "",
    "This section reports figures only. It renders no verdict; not yet: #4959 will apply the bar.",
    "",
    "### Before vs switched-on",
    "",
    `Before = the trial host's switch-off runs from ${report.beforeStart} to ${report.windowStart}.`,
    "",
    ...table("Switched on", report.switchedOn, "Before", report.before),
    "",
    diffLine(
      "Relative cost difference (on vs before)",
      report.beforeDifference,
    ),
    "",
    "### Concurrent vs switched-on",
    "",
    `Concurrent = other hosts' switch-off runs in the same window, on shared repositories (hosts: ${
      report.concurrentHosts.length > 0
        ? report.concurrentHosts.join(", ")
        : "none"
    }).`,
    "",
    ...table(
      "Switched on",
      report.concurrentOn,
      "Concurrent",
      report.concurrent,
    ),
    "",
    diffLine(
      "Relative cost difference (on vs concurrent)",
      report.concurrentDifference,
    ),
    "",
    "### Populations and exclusions",
    "",
    `- Switched-on population (intention to treat: every trial host window run with the switch on that the plugin was eligible for, whatever the plugin status): ${e.onRuns} runs, by status ${e.onByStatus.on} on, ${e.onByStatus.fallback} fallback, ${e.onByStatus.stopped} stopped, ${
      e.onByStatus["not-run"]
    } not-run; persisted ${e.onPersisted} of ${e.onRuns}`,
    `- Trial host runs served by another provider (plugin off; in no comparison): ${e.otherProviderOff}`,
    `- Trial host window runs with the switch off (in no comparison): ${e.trialHostOff}`,
    `- Malformed records excluded: ${e.malformed}`,
    `- Unflagged records excluded (no flag, before ${report.recordedSince}): ${e.unflagged}`,
    `- Non-claude or no-provider runs excluded: ${e.nonClaude}`,
    `- Other-mode runs excluded: ${e.otherMode}`,
    `- Trial host before-period runs not switched off: ${e.beforeNotOff}`,
    `- Other hosts' switched-on or fallback runs (not controls): ${e.otherHostNotOff}`,
    `- Trial host RTK setting: ${e.trialHostRtk}${
      e.trialHostRtk === "mixed-or-unknown"
        ? " (mixed or unknown; concurrent hosts were not screened for RTK)"
        : ""
    }`,
    `- Concurrent hosts excluded for a different RTK setting: ${
      e.rtkMismatchHosts.length > 0 ? e.rtkMismatchHosts.join(", ") : "none"
    } (${e.rtkMismatchRecords} records)`,
    `- Repositories left out of the concurrent comparison (one side only): ${e.oneSidedRepositories}${
      e.oneSidedRepositories > 0
        ? ` (${e.oneSidedRepositoryNames.join(", ")})`
        : ""
    }`,
    "- Not checked: the run record carries no advisor/executor-split setting, so that section 5 exclusion cannot be applied from the archive; the reader must check it (#4959).",
    "- Not checked: the run record's provider is the host's configured provider, not the one that served the run, so a switch-off control run served by another provider cannot be excluded from the archive; the reader must check it (#4959).",
    "- Not checked: the run record carries no other-trial-window flag, so that section 5 exclusion cannot be applied from the archive; the reader must check it (#4959).",
  ];
  return lines.join("\n");
}
