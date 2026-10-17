/**
 * Fleet experiment report: merged issues per estimated API-equivalent USD for
 * each arm, with intervals, warnings and a conservative verdict
 * (Issue #3645, part of milestone #3644).
 *
 * Lifecycle ledger events are grouped by assignment and reduced to one record
 * per issue. The arm comparison is intention-to-treat: each record keeps the
 * arm of its earliest assignment, whatever fallback happened later.
 *
 * A merge is a success only when classifyLifecycleOutcome, the owner of that
 * rule, finds the quality and review gates passing on the merged head strictly
 * before the merge. A bare merge is merged_unverified and is never a success.
 *
 * Costs are estimated API-equivalent USD, not billing. A missing estimate is
 * UNKNOWN and never zero, and a merged-per-USD figure with unknown cost is a
 * lower bound on cost.
 *
 * The verdict only names a leading arm when the evidence is strong and clean,
 * so an experiment never declares a winner from noise.
 *
 * Maturity depends on assignment age only. An assignment is mature once it was
 * assigned at least horizonDays ago, whatever its status. Younger assignments
 * are excluded from merged per USD, the merge rate, the per-assignment rates,
 * the evidence level and the verdict's 30-merged gate, so an early merge cannot
 * bias them towards success (survivor bias). The all-record counts (merged,
 * the throughput figures, weekly rows and breakdowns) and the exposure, bias
 * and unverified-merge warnings read every record.
 *
 * Pure functions only. The bootstrap uses a seeded mulberry32 PRNG, so the same
 * events and options always produce the same report.
 *
 * Australian English spelling used throughout.
 */

import {
  type AssignmentEvent,
  type FollowOnEvent,
  type GateEvent,
  type InvocationEvent,
  LIFECYCLE_ROLES,
  type LifecycleEvent,
  type OutcomeEvent,
  type RoleTreatment,
} from "./lifecycle_ledger.ts";
import {
  DEFAULT_EXPERIMENT_ARMS,
  type ExperimentArm,
  isExcludedModel,
} from "./fleet_experiment_arms.ts";
import { classifyLifecycleOutcome } from "./lifecycle_outcomes.ts";

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/** Milliseconds in one hour. */
const HOUR_MS = 3_600_000;

/** The assignment id that marks an event as unattributed. */
const UNATTRIBUTED_ID = "unknown";

/** Default minimum mature assignments per arm before a warning clears. */
const DEFAULT_MIN_PER_ARM = 10;

/** Default number of bootstrap resamples. */
const DEFAULT_BOOTSTRAP_SAMPLES = 1000;

/** Default bootstrap PRNG seed. */
const DEFAULT_SEED = 1;

/** Mature merged assignments needed for "preliminary" evidence or better. */
const PRELIMINARY_MERGED = 30;

/** The z value for a 99% two-sided interval. */
const Z_99 = 2.576;

/** Two-sided 99% percentile bounds for the bootstrap interval. */
const LOW_QUANTILE = 0.005;
const HIGH_QUANTILE = 0.995;

/** Total-variation distance above which a covariate counts as biased. */
const BIAS_TOTAL_VARIATION = 0.25;

/** Assignments needed before exposure is judged unequal. */
const EXPOSURE_MIN_ASSIGNED = 20;

/** Largest allowed gap between an arm's assignment share and its weight share. */
const EXPOSURE_SHARE_TOLERANCE = 0.1;

/**
 * A small, fast, seeded PRNG (mulberry32) returning values in [0, 1).
 *
 * Exported so the synthetic history generator draws from the same stream
 * family as the bootstrap.
 *
 * @param seed - The seed.
 * @returns A generator of values in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Options for building an experiment report. */
export interface ExperimentOptions {
  /** The report's reference time. Records are judged against it. */
  now: Date;
  /** Only assignments in the last `windowDays` days are reported. */
  windowDays: number;
  /** An assignment at least this many days old is mature. Older pending ones are censored. */
  horizonDays: number;
  /** The configured arms. Defaults to DEFAULT_EXPERIMENT_ARMS. */
  arms?: readonly ExperimentArm[];
  /** Mature assignments per arm needed before a low-sample warning clears. Default 10. */
  minPerArm?: number;
  /** Bootstrap resamples for the merged-per-USD interval. Default 1000. */
  bootstrapSamples?: number;
  /** Bootstrap PRNG seed. Default 1. */
  seed?: number;
  /** Covariates keyed `${repo}#${issueNumber}`, for example size, type and priority. */
  covariates?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The outcome status of one assignment. */
export type AssignmentStatus =
  | "merged"
  | "merged_unverified"
  | "failed"
  | "pending";

/** One assignment, reduced from its ledger events. */
export interface AssignmentRecord {
  assignmentId: string;
  cohort: string;
  repo: string;
  issueNumber: number | null;
  /** Sorted, distinct hosts across all of the assignment's events. */
  hosts: string[];
  /** The treatment manager's provider, or "unknown". */
  managerProvider: string;
  /** For example "manager:claude/sonnet+executor:claude/haiku". */
  roleCombination: string;
  assignedAt: string;
  /** Sum of KNOWN estimated USD over every invocation and follow-on attempt. */
  costUsd: number;
  /** Invocation and follow-on events with no estimated USD. */
  costUnknownCount: number;
  invocations: number;
  failedInvocations: number;
  quotaLimitedInvocations: number;
  followOns: number;
  reviewRejections: number;
  /** Quality gate events with result fail. Review and pr_open gates are not counted. */
  gateFailures: number;
  /**
   * Null when there are no quality gates with a pass or fail result. Otherwise
   * true when no quality gate failed. Quality gates only.
   */
  firstPassCi: boolean | null;
  status: AssignmentStatus;
  /** Hours from assignment to the merged outcome, or null unless merged. */
  timeToMergeHours: number | null;
  /**
   * Mature once assigned at least horizonDays ago, whatever the status. Only
   * mature records count in merged per USD, the merge rate, the per-assignment
   * rates, the evidence level and the verdict's 30-merged gate.
   */
  mature: boolean;
  /** True when the assignment is still pending. */
  censored: boolean;
  usesExcludedModel: boolean;
  covariates: Record<string, string>;
}

/** Evidence strength, judged from the mature merged count. */
export type EvidenceLevel =
  | "insufficient"
  | "directional"
  | "preliminary"
  | "established";

/** A closed interval. */
export interface Interval {
  low: number;
  high: number;
}

/** Summary of one arm (or one unconfigured cohort). */
export interface ArmSummary {
  armId: string;
  /** Whether the id is a configured arm. */
  known: boolean;
  assigned: number;
  mature: number;
  /** Immature records: assigned less than horizonDays ago, whatever their status. */
  pending: number;
  /** Mature records still pending, censored at the horizon. */
  censoredAtHorizon: number;
  /** Verified merges over every assigned record, mature or not. Feeds the throughput figures and the "Merged (all)" column. */
  merged: number;
  /** Verified merges among mature records. The evidence level and the verdict's 30-merged gate count these. */
  matureMerged: number;
  mergedUnverified: number;
  failed: number;
  /** Known estimated USD over mature assignments. */
  costUsd: number;
  /** Mature assignments with any unknown cost. */
  costUnknownAssignments: number;
  /** Mature merged per known USD. Null when cost or mature is zero. */
  mergedPerUsd: number | null;
  /** 99% percentile bootstrap over mature records. */
  mergedPerUsdInterval: Interval | null;
  /** Mature merged over mature. */
  mergeRate: number | null;
  /** 99% Wilson score interval for the merge rate. */
  mergeRateInterval: Interval | null;
  /** Mature known USD per mature merged. Null when merged or cost is zero. */
  costPerMerged: number | null;
  /** Median hours to merge across mature merged assignments. */
  medianTimeToMergeHours: number | null;
  /** Mature assignments with a first-pass CI result that passed. */
  firstPassCiRate: number | null;
  /** Mature review rejections per mature assignment. */
  reviewRejectionsPerAssignment: number | null;
  /** Mature follow-ons per mature assignment. */
  reworkPerAssignment: number | null;
  /** Mature failed invocations over mature invocations. */
  failedInvocationRate: number | null;
  /** Usage-limited invocations, over all assigned records. */
  quotaLimitedInvocations: number;
  /** Distinct (host, UTC day of assignment) pairs. */
  hostDays: number;
  /** Merged over host-days, over all assigned records. */
  mergedPerHostDay: number | null;
  /** Merged over the window length in days. */
  throughputPerDay: number;
  evidence: EvidenceLevel;
}

/** A warning code. */
export type ExperimentWarningCode =
  | "low-sample"
  | "missing-cost"
  | "biased-assignment"
  | "unequal-exposure"
  | "excluded-model"
  | "unverified-merge"
  | "unattributed-events"
  | "unknown-arm";

/** A plain, specific warning about the report. */
export interface ExperimentWarning {
  code: ExperimentWarningCode;
  message: string;
  arm?: string;
}

/** A dimension a breakdown can be cut by. */
export type BreakdownDimension =
  | "host"
  | "provider"
  | "role-combination"
  | "repo";

/** One row of a breakdown, for one arm. Costs use mature records. */
export interface BreakdownRow {
  dimension: BreakdownDimension;
  key: string;
  arm: string;
  assigned: number;
  mature: number;
  merged: number;
  costUsd: number;
  costUnknownAssignments: number;
}

/** One week of one arm. Costs use every assigned record. */
export interface WeeklyRow {
  /** YYYY-MM-DD, the Monday (UTC) of the week. */
  weekStart: string;
  arm: string;
  assigned: number;
  merged: number;
  costUsd: number;
}

/** The report's conclusion. */
export interface ExperimentVerdict {
  kind: "no-decision" | "leading-arm";
  arm?: string;
  reason: string;
}

/** The full experiment report. */
export interface ExperimentReport {
  generatedAt: string;
  windowDays: number;
  horizonDays: number;
  arms: ArmSummary[];
  weekly: WeeklyRow[];
  breakdowns: BreakdownRow[];
  warnings: ExperimentWarning[];
  verdict: ExperimentVerdict;
  records: AssignmentRecord[];
}

/** Compare two strings by code unit, for a deterministic order. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Sum a list of numbers. */
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Read a value that the caller has already bounded to the list. */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`index ${index} is outside the list`);
  }
  return value;
}

/** Pick the earlier assignment: earliest assignedAt, then recordedAt, then key. */
function compareIntent(a: AssignmentEvent, b: AssignmentEvent): number {
  const byAssigned = Date.parse(a.assignedAt) - Date.parse(b.assignedAt);
  if (byAssigned !== 0) return byAssigned;
  const byRecorded = Date.parse(a.recordedAt) - Date.parse(b.recordedAt);
  if (byRecorded !== 0) return byRecorded;
  return compareStrings(a.eventKey, b.eventKey);
}

/** The intention-to-treat assignment of a group, or undefined when it has none. */
function earliestAssignment(
  assignments: readonly AssignmentEvent[],
): AssignmentEvent | undefined {
  let best: AssignmentEvent | undefined;
  for (const assignment of assignments) {
    if (best === undefined || compareIntent(assignment, best) < 0) {
      best = assignment;
    }
  }
  return best;
}

/** The role combination string, in manager, executor, reviewer order. */
function roleCombination(roles: readonly RoleTreatment[]): string {
  const parts: string[] = [];
  for (const role of LIFECYCLE_ROLES) {
    const treatment = roles.find((item) => item.role === role);
    if (treatment !== undefined) {
      parts.push(`${role}:${treatment.provider}/${treatment.model ?? "?"}`);
    }
  }
  return parts.join("+");
}

/** Outcomes that end an assignment without a merge. */
const FAILURE_OUTCOMES: readonly OutcomeEvent["outcome"][] = [
  "failed",
  "closed_unmerged",
  "timeout",
  "handed_off",
];

/**
 * Reduce one assignment to its status.
 *
 * "merged" is the gated success from classifyLifecycleOutcome: the quality and
 * review gates pass on the merged head, strictly before the merge. Any other
 * merged outcome, with or without a PR number, is merged_unverified and is never
 * counted as success. Otherwise a failure outcome makes it failed, and anything
 * else is pending.
 *
 * @param verified - Whether classifyLifecycleOutcome reports a gated success.
 * @param names - The outcome names of the assignment.
 * @returns The status.
 */
function statusOf(
  verified: boolean,
  names: ReadonlySet<OutcomeEvent["outcome"]>,
): AssignmentStatus {
  if (verified) return "merged";
  if (names.has("merged")) return "merged_unverified";
  if (FAILURE_OUTCOMES.some((outcome) => names.has(outcome))) return "failed";
  return "pending";
}

/** Build one record from an assignment's ledger events. */
function buildRecord(
  assignmentId: string,
  intent: AssignmentEvent,
  group: readonly LifecycleEvent[],
  opts: ExperimentOptions,
): AssignmentRecord {
  const hosts = [...new Set(group.map((event) => event.host))].sort(
    compareStrings,
  );
  const invocations = group.filter(
    (event): event is InvocationEvent => event.kind === "invocation",
  );
  const followOns = group.filter(
    (event): event is FollowOnEvent => event.kind === "follow_on",
  );
  const gates = group.filter((event): event is GateEvent =>
    event.kind === "gate"
  );
  const outcomes = group.filter((event): event is OutcomeEvent =>
    event.kind === "outcome"
  );

  let costUsd = 0;
  let costUnknownCount = 0;
  for (const event of [...invocations, ...followOns]) {
    if (event.estimatedApiEquivalentUsd === undefined) {
      costUnknownCount++;
    } else {
      costUsd += event.estimatedApiEquivalentUsd;
    }
  }

  const failedInvocations =
    invocations.filter((event) => event.result !== "success").length;
  const quotaLimitedInvocations =
    invocations.filter((event) =>
      event.result === "usage_limited" || event.quotaStatus === "limited"
    ).length;
  const reviewRejections =
    followOns.filter((event) => event.followOn === "pr_feedback").length;
  const qualityGates = gates.filter((event) => event.gate === "quality");
  const gateFailures =
    qualityGates.filter((event) => event.result === "fail").length;
  const judgedQuality = qualityGates.some((event) =>
    event.result === "pass" || event.result === "fail"
  );
  const firstPassCi = judgedQuality ? gateFailures === 0 : null;

  const outcome = classifyLifecycleOutcome(group);
  const names = new Set(outcomes.map((event) => event.outcome));
  const status = statusOf(outcome.success, names);
  const assignedMs = Date.parse(intent.assignedAt);
  const mergedTimes = outcomes
    .filter((event) => event.outcome === "merged")
    .map((event) => Date.parse(event.recordedAt));
  const timeToMergeHours = status === "merged"
    ? (Math.min(...mergedTimes) - assignedMs) / HOUR_MS
    : null;

  const nowMs = opts.now.getTime();
  const horizonMs = opts.horizonDays * DAY_MS;
  const mature = assignedMs + horizonMs <= nowMs;

  const manager = intent.treatment.roles.find((role) =>
    role.role === "manager"
  );
  const usesExcludedModel =
    intent.treatment.roles.some((role) => isExcludedModel(role.model)) ||
    invocations.some((event) =>
      isExcludedModel(event.model) ||
      isExcludedModel(event.servedModel) ||
      (event.models ?? []).some((model) => isExcludedModel(model.model))
    );

  const issueNumber = intent.issueNumber ?? null;
  const override = issueNumber === null
    ? undefined
    : opts.covariates?.[`${intent.repo}#${issueNumber}`];

  return {
    assignmentId,
    cohort: intent.cohort,
    repo: intent.repo,
    issueNumber,
    hosts,
    managerProvider: manager?.provider ?? "unknown",
    roleCombination: roleCombination(intent.treatment.roles),
    assignedAt: intent.assignedAt,
    costUsd,
    costUnknownCount,
    invocations: invocations.length,
    failedInvocations,
    quotaLimitedInvocations,
    followOns: followOns.length,
    reviewRejections,
    gateFailures,
    firstPassCi,
    status,
    timeToMergeHours,
    mature,
    censored: status === "pending",
    usesExcludedModel,
    covariates: {
      repo: intent.repo,
      host: hosts[0] ?? "unknown",
      ...(override ?? {}),
    },
  };
}

/**
 * Group ledger events by assignment and reduce each group to one record.
 *
 * Events with the assignment id "unknown" are unattributed, as are groups with
 * no assignment event. Both are counted, not guessed at. Only assignments
 * whose assignedAt is in (now - windowDays, now] are returned, sorted by
 * assignedAt and then assignmentId.
 *
 * @param events - The ledger events, in any order.
 * @param opts - The report options. Only `now`, `windowDays`, `horizonDays`
 *   and `covariates` affect the records.
 * @returns The records and the number of unattributed events.
 */
export function buildAssignmentRecords(
  events: readonly LifecycleEvent[],
  opts: ExperimentOptions,
): { records: AssignmentRecord[]; unattributedEvents: number } {
  const groups = new Map<string, LifecycleEvent[]>();
  let unattributedEvents = 0;
  for (const event of events) {
    if (event.assignmentId === UNATTRIBUTED_ID) {
      unattributedEvents++;
      continue;
    }
    const group = groups.get(event.assignmentId);
    if (group === undefined) {
      groups.set(event.assignmentId, [event]);
    } else {
      group.push(event);
    }
  }

  const nowMs = opts.now.getTime();
  const windowStartMs = nowMs - opts.windowDays * DAY_MS;
  const records: AssignmentRecord[] = [];
  for (const [assignmentId, group] of groups) {
    const assignments = group.filter(
      (event): event is AssignmentEvent => event.kind === "assignment",
    );
    const intent = earliestAssignment(assignments);
    if (intent === undefined) {
      unattributedEvents += group.length;
      continue;
    }
    const assignedMs = Date.parse(intent.assignedAt);
    if (assignedMs <= windowStartMs || assignedMs > nowMs) continue;
    records.push(buildRecord(assignmentId, intent, group, opts));
  }

  records.sort((a, b) =>
    Date.parse(a.assignedAt) - Date.parse(b.assignedAt) ||
    compareStrings(a.assignmentId, b.assignmentId)
  );
  return { records, unattributedEvents };
}

/** The evidence level for a mature merged count. */
function evidenceFor(merged: number): EvidenceLevel {
  if (merged >= 50) return "established";
  if (merged >= PRELIMINARY_MERGED) return "preliminary";
  if (merged >= 10) return "directional";
  return "insufficient";
}

/** The Wilson score interval, at 99% confidence, for successes out of n. */
function wilsonInterval(successes: number, n: number): Interval | null {
  if (n === 0) return null;
  const z2 = Z_99 * Z_99;
  const p = successes / n;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (Z_99 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) /
    denominator;
  return {
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}

/** The median of a list, or null when it is empty. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return at(sorted, middle);
  return (at(sorted, middle - 1) + at(sorted, middle)) / 2;
}

/** A percentile of an ascending list, by nearest rank. */
function quantile(sorted: readonly number[], p: number): number {
  return at(sorted, Math.round(p * (sorted.length - 1)));
}

/**
 * The 99% percentile bootstrap interval for merged per USD.
 *
 * Resamples the mature records with replacement, with a fresh PRNG seeded the
 * same for every arm. Resamples with no known cost are skipped.
 *
 * @param mature - The mature records of one arm.
 * @param samples - The number of resamples.
 * @param seed - The PRNG seed.
 * @returns The interval, or null when no resample has a known cost.
 */
function bootstrapMergedPerUsd(
  mature: readonly AssignmentRecord[],
  samples: number,
  seed: number,
): Interval | null {
  const n = mature.length;
  if (n === 0 || samples <= 0) return null;
  const merged = mature.map((record) => record.status === "merged" ? 1 : 0);
  const cost = mature.map((record) => record.costUsd);
  const random = mulberry32(seed);
  const ratios: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let mergedCount = 0;
    let costTotal = 0;
    for (let draw = 0; draw < n; draw++) {
      const index = Math.min(n - 1, Math.floor(random() * n));
      mergedCount += at(merged, index);
      costTotal += at(cost, index);
    }
    if (costTotal > 0) ratios.push(mergedCount / costTotal);
  }
  if (ratios.length === 0) return null;
  ratios.sort((a, b) => a - b);
  return {
    low: quantile(ratios, LOW_QUANTILE),
    high: quantile(ratios, HIGH_QUANTILE),
  };
}

/** Summarise the records of one arm. */
function summariseArm(
  armId: string,
  records: readonly AssignmentRecord[],
  arms: readonly ExperimentArm[],
  opts: ExperimentOptions,
): ArmSummary {
  const mature = records.filter((record) => record.mature);
  const merged = records.filter((record) => record.status === "merged");
  const matureMerged =
    mature.filter((record) => record.status === "merged").length;
  const costUsd = sum(mature.map((record) => record.costUsd));
  const mergedPerUsd = mature.length > 0 && costUsd > 0
    ? matureMerged / costUsd
    : null;
  const mergedPerUsdInterval = mergedPerUsd === null
    ? null
    : bootstrapMergedPerUsd(
      mature,
      opts.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES,
      opts.seed ?? DEFAULT_SEED,
    );
  const mergeRate = mature.length > 0 ? matureMerged / mature.length : null;

  const judgedCi = mature.filter((record) => record.firstPassCi !== null);
  const passedCi = judgedCi.filter((record) => record.firstPassCi === true);
  const matureInvocations = sum(mature.map((record) => record.invocations));
  const matureFailed = sum(mature.map((record) => record.failedInvocations));
  const hostDayKeys = new Set<string>();
  for (const record of records) {
    const day = record.assignedAt.slice(0, 10);
    for (const host of record.hosts) hostDayKeys.add(`${host}|${day}`);
  }
  const hostDays = hostDayKeys.size;
  const windowDays = opts.windowDays;

  return {
    armId,
    known: arms.some((arm) => arm.id === armId),
    assigned: records.length,
    mature: mature.length,
    pending: records.filter((record) => !record.mature).length,
    censoredAtHorizon:
      records.filter((record) => record.censored && record.mature).length,
    merged: merged.length,
    matureMerged,
    mergedUnverified:
      records.filter((record) => record.status === "merged_unverified").length,
    failed: records.filter((record) => record.status === "failed").length,
    costUsd,
    costUnknownAssignments:
      mature.filter((record) => record.costUnknownCount > 0).length,
    mergedPerUsd,
    mergedPerUsdInterval,
    mergeRate,
    mergeRateInterval: wilsonInterval(matureMerged, mature.length),
    costPerMerged: matureMerged > 0 && costUsd > 0
      ? costUsd / matureMerged
      : null,
    medianTimeToMergeHours: median(
      mature.flatMap((record) =>
        record.timeToMergeHours === null ? [] : [record.timeToMergeHours]
      ),
    ),
    firstPassCiRate: judgedCi.length > 0
      ? passedCi.length / judgedCi.length
      : null,
    reviewRejectionsPerAssignment: mature.length > 0
      ? sum(mature.map((record) => record.reviewRejections)) / mature.length
      : null,
    reworkPerAssignment: mature.length > 0
      ? sum(mature.map((record) => record.followOns)) / mature.length
      : null,
    failedInvocationRate: matureInvocations > 0
      ? matureFailed / matureInvocations
      : null,
    quotaLimitedInvocations: sum(
      records.map((record) => record.quotaLimitedInvocations),
    ),
    hostDays,
    mergedPerHostDay: hostDays > 0 ? merged.length / hostDays : null,
    throughputPerDay: merged.length / windowDays,
    evidence: evidenceFor(matureMerged),
  };
}

/** The Monday (UTC) of the week containing a timestamp, as YYYY-MM-DD. */
function mondayOf(ms: number): string {
  const date = new Date(ms);
  const offset = (date.getUTCDay() + 6) % 7;
  const monday = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - offset,
  );
  return new Date(monday).toISOString().slice(0, 10);
}

/** The breakdown dimensions, in report order. */
const BREAKDOWN_DIMENSIONS: readonly BreakdownDimension[] = [
  "host",
  "provider",
  "role-combination",
  "repo",
];

/** The keys one record contributes to a breakdown dimension. */
function breakdownKeys(
  dimension: BreakdownDimension,
  record: AssignmentRecord,
): string[] {
  switch (dimension) {
    case "host":
      return record.hosts;
    case "provider":
      return [record.managerProvider];
    case "role-combination":
      return [record.roleCombination];
    case "repo":
      return [record.repo];
  }
}

/** Cut the records by host, provider, role combination and repo, per arm. */
function buildBreakdowns(records: readonly AssignmentRecord[]): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>();
  for (const record of records) {
    for (const dimension of BREAKDOWN_DIMENSIONS) {
      for (const key of breakdownKeys(dimension, record)) {
        const id = JSON.stringify([dimension, key, record.cohort]);
        let row = rows.get(id);
        if (row === undefined) {
          row = {
            dimension,
            key,
            arm: record.cohort,
            assigned: 0,
            mature: 0,
            merged: 0,
            costUsd: 0,
            costUnknownAssignments: 0,
          };
          rows.set(id, row);
        }
        row.assigned++;
        if (record.status === "merged") row.merged++;
        if (record.mature) {
          row.mature++;
          row.costUsd += record.costUsd;
          if (record.costUnknownCount > 0) row.costUnknownAssignments++;
        }
      }
    }
  }
  return [...rows.values()].sort((a, b) =>
    BREAKDOWN_DIMENSIONS.indexOf(a.dimension) -
      BREAKDOWN_DIMENSIONS.indexOf(b.dimension) ||
    compareStrings(a.key, b.key) ||
    compareStrings(a.arm, b.arm)
  );
}

/** Bucket the records by Monday-UTC week and arm. */
function buildWeekly(records: readonly AssignmentRecord[]): WeeklyRow[] {
  const rows = new Map<string, WeeklyRow>();
  for (const record of records) {
    const weekStart = mondayOf(Date.parse(record.assignedAt));
    const id = JSON.stringify([weekStart, record.cohort]);
    let row = rows.get(id);
    if (row === undefined) {
      row = {
        weekStart,
        arm: record.cohort,
        assigned: 0,
        merged: 0,
        costUsd: 0,
      };
      rows.set(id, row);
    }
    row.assigned++;
    if (record.status === "merged") row.merged++;
    row.costUsd += record.costUsd;
  }
  return [...rows.values()].sort((a, b) =>
    compareStrings(a.weekStart, b.weekStart) || compareStrings(a.arm, b.arm)
  );
}

/** The share of each covariate value among a set of records. */
function distributionOf(
  records: readonly AssignmentRecord[],
  key: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const value = record.covariates[key] ?? "(absent)";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const shares = new Map<string, number>();
  for (const [value, count] of counts) {
    shares.set(value, count / records.length);
  }
  return shares;
}

/** Total-variation distance between two distributions, from 0 to 1. */
function totalVariation(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number {
  const values = new Set([...a.keys(), ...b.keys()]);
  let difference = 0;
  for (const value of values) {
    difference += Math.abs((a.get(value) ?? 0) - (b.get(value) ?? 0));
  }
  return difference / 2;
}

/** Warn when an arm's covariate mix differs from the pooled mix. */
function biasedAssignmentWarnings(
  records: readonly AssignmentRecord[],
  summaries: readonly ArmSummary[],
  minPerArm: number,
): ExperimentWarning[] {
  const keys = [
    ...new Set(records.flatMap((record) => Object.keys(record.covariates))),
  ].sort(compareStrings);
  const warnings: ExperimentWarning[] = [];
  for (const key of keys) {
    const pooled = distributionOf(records, key);
    for (const summary of summaries) {
      if (summary.assigned < minPerArm) continue;
      const armRecords = records.filter((record) =>
        record.cohort === summary.armId
      );
      const distance = totalVariation(
        distributionOf(armRecords, key),
        pooled,
      );
      if (distance > BIAS_TOTAL_VARIATION) {
        warnings.push({
          code: "biased-assignment",
          arm: summary.armId,
          message:
            `Arm ${summary.armId} covariate "${key}" differs from the pooled mix by total variation ${
              distance.toFixed(2)
            }, above ${BIAS_TOTAL_VARIATION}.`,
        });
      }
    }
  }
  return warnings;
}

/** Warnings about exposure across the configured active arms. */
function exposureWarnings(
  summaries: readonly ArmSummary[],
  activeArms: readonly ExperimentArm[],
): ExperimentWarning[] {
  const active = activeArms.flatMap((arm) => {
    const summary = summaries.find((item) => item.armId === arm.id);
    return summary === undefined ? [] : [{ arm, summary }];
  });
  const totalAssigned = sum(active.map((item) => item.summary.assigned));
  if (totalAssigned < EXPOSURE_MIN_ASSIGNED) return [];

  const warnings: ExperimentWarning[] = [];
  const totalWeight = sum(active.map((item) => item.arm.weight));
  for (const { arm, summary } of active) {
    const share = summary.assigned / totalAssigned;
    const expected = arm.weight / totalWeight;
    if (Math.abs(share - expected) > EXPOSURE_SHARE_TOLERANCE) {
      warnings.push({
        code: "unequal-exposure",
        arm: arm.id,
        message:
          `Arm ${arm.id} received ${summary.assigned} of ${totalAssigned} active assignments (${
            (share * 100).toFixed(1)
          }%), against an expected ${(expected * 100).toFixed(1)}%.`,
      });
    }
  }

  const withRecords = active.filter((item) => item.summary.assigned >= 1);
  const maxHostDays = Math.max(
    0,
    ...withRecords.map((item) => item.summary.hostDays),
  );
  for (const { arm, summary } of active) {
    if (summary.hostDays < maxHostDays / 2) {
      warnings.push({
        code: "unequal-exposure",
        arm: arm.id,
        message:
          `Arm ${arm.id} covered ${summary.hostDays} host-day(s), less than half the maximum of ${maxHostDays} across active arms.`,
      });
    }
  }
  return warnings;
}

/** Every warning the report raises. */
function buildWarnings(
  records: readonly AssignmentRecord[],
  summaries: readonly ArmSummary[],
  activeArms: readonly ExperimentArm[],
  unattributedEvents: number,
  minPerArm: number,
): ExperimentWarning[] {
  const warnings: ExperimentWarning[] = [];
  for (const summary of summaries) {
    if (summary.mature < minPerArm) {
      warnings.push({
        code: "low-sample",
        arm: summary.armId,
        message:
          `Arm ${summary.armId} has ${summary.mature} mature assignment(s), below the ${minPerArm} needed per arm.`,
      });
    }
    if (summary.costUnknownAssignments > 0) {
      warnings.push({
        code: "missing-cost",
        arm: summary.armId,
        message:
          `Arm ${summary.armId} has ${summary.costUnknownAssignments} mature assignment(s) with no estimated USD, so its merged per USD is a lower bound on cost and is overstated.`,
      });
    }
    if (!summary.known) {
      warnings.push({
        code: "unknown-arm",
        arm: summary.armId,
        message:
          `Cohort ${summary.armId} is not a configured arm, so its ${summary.assigned} assignment(s) are not compared with the arms.`,
      });
    }
  }

  const unverified =
    records.filter((record) => record.status === "merged_unverified").length;
  if (unverified > 0) {
    warnings.push({
      code: "unverified-merge",
      message:
        `${unverified} assignment(s) show a merged PR without passing quality and review gates on the merged head before the merge; these are not counted as success.`,
    });
  }
  if (unattributedEvents > 0) {
    warnings.push({
      code: "unattributed-events",
      message:
        `${unattributedEvents} lifecycle event(s) could not be attributed to an assignment and were not counted.`,
    });
  }
  const excluded = records.filter((record) => record.usesExcludedModel).length;
  if (excluded > 0) {
    warnings.push({
      code: "excluded-model",
      message:
        `${excluded} assignment(s) used a Fable model, which is excluded from every arm.`,
    });
  }
  warnings.push(...exposureWarnings(summaries, activeArms));
  warnings.push(...biasedAssignmentWarnings(records, summaries, minPerArm));
  return warnings;
}

/** Warning codes that stop a leading-arm verdict. */
const BLOCKING_CODES: ReadonlySet<ExperimentWarningCode> = new Set([
  "low-sample",
  "missing-cost",
  "biased-assignment",
  "unequal-exposure",
  "unverified-merge",
]);

/**
 * The verdict. A leading arm is named only when every active arm has
 * preliminary evidence or better from mature merges, no blocking warning is raised, and one arm's
 * merged-per-USD interval lies wholly above every other active arm's.
 */
function decideVerdict(
  summaries: readonly ArmSummary[],
  warnings: readonly ExperimentWarning[],
  activeArms: readonly ExperimentArm[],
): ExperimentVerdict {
  if (activeArms.length < 2) {
    return {
      kind: "no-decision",
      reason: "fewer than two active arms to compare",
    };
  }
  const active = activeArms.map((arm) => ({
    id: arm.id,
    summary: summaries.find((item) => item.armId === arm.id),
  }));

  for (const { id, summary } of active) {
    const matureMerged = summary?.matureMerged ?? 0;
    if (matureMerged < PRELIMINARY_MERGED) {
      return {
        kind: "no-decision",
        reason:
          `arm ${id} has ${matureMerged} merged assignment(s) past the horizon; preliminary evidence needs at least ${PRELIMINARY_MERGED}`,
      };
    }
  }

  const blocking = warnings.find((warning) => BLOCKING_CODES.has(warning.code));
  if (blocking !== undefined) {
    const where = blocking.arm === undefined ? "" : ` for arm ${blocking.arm}`;
    return {
      kind: "no-decision",
      reason: `${blocking.code}${where} blocks a verdict: ${blocking.message}`,
    };
  }

  const intervals = active.map(({ id, summary }) => ({
    id,
    interval: summary?.mergedPerUsdInterval ?? null,
  }));
  for (const { id, interval } of intervals) {
    if (interval === null) {
      return {
        kind: "no-decision",
        reason:
          `arm ${id} has no merged-per-USD interval, so no arm can be separated`,
      };
    }
  }

  for (const candidate of intervals) {
    const candidateLow = candidate.interval?.low ?? Number.NEGATIVE_INFINITY;
    const beatsAll = intervals.every((other) =>
      other.id === candidate.id ||
      candidateLow > (other.interval?.high ?? Number.POSITIVE_INFINITY)
    );
    if (beatsAll) {
      return {
        kind: "leading-arm",
        arm: candidate.id,
        reason:
          `arm ${candidate.id} has the highest merged per USD, with its 99% interval above every other active arm`,
      };
    }
  }
  return {
    kind: "no-decision",
    reason: "the 99% merged-per-USD intervals of the active arms overlap",
  };
}

/**
 * Build the full experiment report from ledger events.
 *
 * @param events - The ledger events, in any order.
 * @param opts - The report options.
 * @returns The report. It is a pure function of its inputs.
 */
export function buildExperimentReport(
  events: readonly LifecycleEvent[],
  opts: ExperimentOptions,
): ExperimentReport {
  const arms = opts.arms ?? DEFAULT_EXPERIMENT_ARMS;
  const activeArms = arms.filter((arm) => arm.status === "active");
  const minPerArm = opts.minPerArm ?? DEFAULT_MIN_PER_ARM;
  const { records, unattributedEvents } = buildAssignmentRecords(events, opts);

  const cohorts = new Set<string>([
    ...records.map((record) => record.cohort),
    ...activeArms.map((arm) => arm.id),
  ]);
  const controlId = arms.find((arm) => arm.control)?.id;
  const summaries = [...cohorts]
    .sort((a, b) => {
      if (a === controlId) return -1;
      if (b === controlId) return 1;
      return compareStrings(a, b);
    })
    .map((armId) =>
      summariseArm(
        armId,
        records.filter((record) => record.cohort === armId),
        arms,
        opts,
      )
    );

  const warnings = buildWarnings(
    records,
    summaries,
    activeArms,
    unattributedEvents,
    minPerArm,
  );

  return {
    generatedAt: opts.now.toISOString(),
    windowDays: opts.windowDays,
    horizonDays: opts.horizonDays,
    arms: summaries,
    weekly: buildWeekly(records),
    breakdowns: buildBreakdowns(records),
    warnings,
    verdict: decideVerdict(summaries, warnings, activeArms),
    records,
  };
}

/** Format a number to fixed decimals, or "n/a" when it is null. */
function formatNumber(value: number | null, digits: number): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

/** Format a point estimate with its interval, or "n/a" when it is null. */
function formatWithInterval(
  value: number | null,
  interval: Interval | null,
  digits: number,
): string {
  if (value === null) return "n/a";
  if (interval === null) return value.toFixed(digits);
  return `${value.toFixed(digits)} [${interval.low.toFixed(digits)}, ${
    interval.high.toFixed(digits)
  }]`;
}

/**
 * Render a Markdown table. A cell's pipes are escaped so they cannot split a row.
 *
 * @param headers - The header cells.
 * @param alignment - The alignment row cells, one per header.
 * @param rows - The body rows.
 * @returns The table lines, with no trailing blank line.
 */
function markdownTable(
  headers: readonly string[],
  alignment: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  const cell = (value: string): string => value.replaceAll("|", "\\|");
  const line = (cells: readonly string[]): string =>
    `| ${cells.map(cell).join(" | ")} |`;
  const body = rows.length === 0
    ? [line(["None", ...headers.slice(1).map(() => "")])]
    : rows.map(line);
  return [line(headers), line(alignment), ...body];
}

/**
 * Format a report as compact Markdown, for a log or a comment.
 *
 * @param report - The report to format.
 * @returns The formatted text, ending in a newline.
 */
export function formatExperimentReport(report: ExperimentReport): string {
  const lines: string[] = [
    `Fleet experiment report, generated ${report.generatedAt}`,
    `Window ${report.windowDays} day(s), horizon ${report.horizonDays} day(s).`,
    "Estimated API-equivalent USD only — not billing",
    "",
    "| Arm | Assigned | Mature | Pending | Merged (all) | Mature merged | Merged per USD (99%) | Merge rate (99%) | Cost per merged USD | Median hours to merge | Evidence |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | --- |",
  ];
  for (const arm of report.arms) {
    const label = arm.known ? arm.armId : `${arm.armId} (unknown)`;
    lines.push(
      `| ${label} | ${arm.assigned} | ${arm.mature} | ${arm.pending} | ${arm.merged} | ${arm.matureMerged} | ${
        formatWithInterval(arm.mergedPerUsd, arm.mergedPerUsdInterval, 3)
      } | ${formatWithInterval(arm.mergeRate, arm.mergeRateInterval, 2)} | ${
        formatNumber(arm.costPerMerged, 2)
      } | ${formatNumber(arm.medianTimeToMergeHours, 1)} | ${arm.evidence} |`,
    );
  }
  lines.push("");
  lines.push("Weekly (by Monday, UTC; cost over all assigned records):");
  lines.push(
    ...markdownTable(
      ["Week starting", "Arm", "Assigned", "Merged", "Cost (USD)"],
      ["---", "---", "---:", "---:", "---:"],
      report.weekly.map((row) => [
        row.weekStart,
        row.arm,
        String(row.assigned),
        String(row.merged),
        row.costUsd.toFixed(2),
      ]),
    ),
  );
  lines.push("");
  lines.push(
    "Breakdowns (mature cost; unknown-cost counts mature assignments):",
  );
  lines.push(
    ...markdownTable(
      [
        "Dimension",
        "Key",
        "Arm",
        "Assigned",
        "Mature",
        "Merged",
        "Cost (USD)",
        "Unknown-cost assignments",
      ],
      ["---", "---", "---", "---:", "---:", "---:", "---:", "---:"],
      report.breakdowns.map((row) => [
        row.dimension,
        row.key,
        row.arm,
        String(row.assigned),
        String(row.mature),
        String(row.merged),
        row.costUsd.toFixed(2),
        String(row.costUnknownAssignments),
      ]),
    ),
  );
  lines.push("");
  if (report.warnings.length === 0) {
    lines.push("Warnings: none.");
  } else {
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }
  lines.push("");
  const arm = report.verdict.arm === undefined
    ? ""
    : ` (${report.verdict.arm})`;
  lines.push(
    `Verdict: ${report.verdict.kind}${arm}. ${report.verdict.reason}.`,
  );
  return lines.join("\n") + "\n";
}

/** Quote one CSV field per RFC 4180 when it needs it. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/**
 * Write the records as CSV: a header row, then one row per record.
 *
 * Fields are quoted per RFC 4180. Hosts are joined with ";", and covariates
 * are written as a JSON column.
 *
 * @param records - The records to write.
 * @returns The CSV text, ending in a newline.
 */
export function experimentRecordsCsv(
  records: readonly AssignmentRecord[],
): string {
  const header = [
    "assignmentId",
    "cohort",
    "repo",
    "issueNumber",
    "hosts",
    "managerProvider",
    "roleCombination",
    "assignedAt",
    "costUsd",
    "costUnknownCount",
    "invocations",
    "failedInvocations",
    "quotaLimitedInvocations",
    "followOns",
    "reviewRejections",
    "gateFailures",
    "firstPassCi",
    "status",
    "timeToMergeHours",
    "mature",
    "censored",
    "usesExcludedModel",
    "covariates",
  ];
  const rows = records.map((record) =>
    [
      record.assignmentId,
      record.cohort,
      record.repo,
      record.issueNumber === null ? "" : String(record.issueNumber),
      record.hosts.join(";"),
      record.managerProvider,
      record.roleCombination,
      record.assignedAt,
      String(record.costUsd),
      String(record.costUnknownCount),
      String(record.invocations),
      String(record.failedInvocations),
      String(record.quotaLimitedInvocations),
      String(record.followOns),
      String(record.reviewRejections),
      String(record.gateFailures),
      record.firstPassCi === null ? "" : String(record.firstPassCi),
      record.status,
      record.timeToMergeHours === null ? "" : String(record.timeToMergeHours),
      String(record.mature),
      String(record.censored),
      String(record.usesExcludedModel),
      JSON.stringify(record.covariates),
    ].map(csvField).join(",")
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}
