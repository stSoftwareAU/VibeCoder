/**
 * Cadence compliance reporting for the important idle-task templates
 * (Issues #4003, #4012).
 *
 * The cadence floor is **best-effort**: the filer's bias prefers overdue pairs
 * but never preempts queued `work-on` work (#4009), so a busy week legitimately
 * misses. That trade-off is only acceptable if a miss is **visible**, and today
 * it is not — "zero open wrappers" is the normal drained state and nothing
 * anywhere says whether the weekly/monthly floor was actually delivered. This
 * module turns that invisible drift into a number.
 *
 * It is **pure**: it reasons over {@link IdleTaskFreshnessEntry} readings the
 * freshness collector (#3864, #4007) already gathered, performs no I/O, spawns
 * no process and never reaches for `gh`. The report is therefore read-only by
 * construction — there is no code path here that could mutate anything.
 *
 * The rules mirror {@link computeDueScans} exactly, because a report that
 * disagreed with the filer would be worse than no report:
 *
 *   - **The weekly clock counts any completed scan**, including a wrapper filed
 *     before the tier stamp existed (#4007). The monthly clock counts **only**
 *     scans stamped with the monthly tier, so an unknown tier can never falsely
 *     satisfy the expensive floor — and the report says which, rather than
 *     silently assuming a tier.
 *   - **Boundaries are inclusive.** Exactly 7.0 / 30.0 days old is a miss
 *     (`>=`), matching the due computation.
 *   - **A monthly miss subsumes a weekly one.** A pair overdue on both windows
 *     reports `monthly-missed`, because one `fable` run discharges both.
 *   - **`unknown` is not compliance.** A repo whose history could not be read is
 *     listed so the gap is visible, but is excluded from every met/missed count
 *     rather than being reconciled as met.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  type CadenceModelTier,
  type CadencePolicy,
  DEFAULT_CADENCE_POLICY,
  NEVER_RUN_OVERDUE_DAYS,
} from "./idle_task_cadence.ts";
import type { IdleTaskFreshnessEntry } from "./idle_task_freshness.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How many overdue pairs the rendered "worst offenders" block lists. */
export const WORST_OFFENDER_LIMIT = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Whether one window's floor was delivered for a pair. */
export type CadenceFloorState = "met" | "missed" | "unknown";

/**
 * Per-pair verdict. `never-run` (no completed scan at all) and `unknown` (the
 * repo's history could not be read) are deliberately distinct from a plain
 * missed floor — they are different operator problems.
 */
export type CadenceVerdict =
  | "ok"
  | "weekly-missed"
  | "monthly-missed"
  | "never-run"
  | "unknown";

/** Cadence compliance of a single (repo, important template) pair. */
export interface CadencePairCompliance {
  repo: string;
  template: string;
  /** Tier the weekly window owes, per the policy in force. */
  weeklyModel: CadenceModelTier;
  /** Tier the monthly window owes, per the policy in force. */
  monthlyModel: CadenceModelTier;
  /** Most recent completed scan of any tier — the weekly clock. Null when none. */
  lastRunAt: string | null;
  /**
   * Age of that scan in days, fractional. This is the weekly floor's clock: the
   * `last_sonnet_days` field of the structured log line. Null when the pair has
   * never run.
   */
  lastRunDays: number | null;
  /** Tier stamped on that scan; null for a pre-stamp wrapper (#4007). */
  lastRunModel: string | null;
  /** Most recent scan stamped at the monthly tier — the monthly clock. */
  lastMonthlyTierAt: string | null;
  /** Age of that scan in days, fractional. Null when no such scan is on record. */
  lastMonthlyTierDays: number | null;
  weekly: CadenceFloorState;
  monthly: CadenceFloorState;
  /**
   * Days past the weekly deadline: 0 when met, {@link NEVER_RUN_OVERDUE_DAYS}
   * when the clock has no reading at all, null when the reading is `unknown`.
   */
  weeklyOverdueDays: number | null;
  /** As {@link CadencePairCompliance.weeklyOverdueDays}, for the monthly window. */
  monthlyOverdueDays: number | null;
  /**
   * True when the weekly floor is met by a wrapper carrying no tier stamp, so
   * the reading is reported rather than assumed to be a weekly-tier scan.
   */
  weeklyMetByUnstampedWrapper: boolean;
  verdict: CadenceVerdict;
}

/** Fleet-wide roll-up of {@link CadencePairCompliance}. */
export interface CadenceFleetSummary {
  /** Pairs reported (repos × important templates). */
  pairs: number;
  weeklyMet: number;
  weeklyMissed: number;
  weeklyUnknown: number;
  monthlyMet: number;
  monthlyMissed: number;
  monthlyUnknown: number;
  /** Pairs with no completed scan of any tier on record. */
  neverRun: number;
  /** Pairs whose history could not be read, excluded from every count above. */
  unknown: number;
  /** Most overdue pairs first, capped at {@link WORST_OFFENDER_LIMIT}. */
  worstOffenders: CadencePairCompliance[];
  /** Overdue pairs omitted from `worstOffenders` by that cap. */
  worstOffendersOmitted: number;
}

/** Whole-fleet cadence compliance report. */
export interface CadenceComplianceReport {
  /** ISO-8601 timestamp the report was generated at. */
  generatedAt: string;
  /** Whether the cadence bias is switched on in the policy in force. */
  enabled: boolean;
  /** Weekly rolling window, in days. */
  weeklyDays: number;
  /** Monthly rolling window, in days. */
  monthlyDays: number;
  /** Important template names the report covers. */
  templates: string[];
  /** One entry per repo × important template, worst first. */
  pairs: CadencePairCompliance[];
  summary: CadenceFleetSummary;
  /**
   * Standing qualifications an operator must read the numbers against — always
   * non-empty, because the monthly column's dependency on the tier stamp
   * (#4007) must never be mistaken for compliance.
   */
  caveats: string[];
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/** Days between `then` and `now`, or null when there is no reading. */
function daysSince(now: Date, then: string | null | undefined): number | null {
  if (then === null || then === undefined || then.length === 0) return null;
  const ms = Date.parse(then);
  if (Number.isNaN(ms)) {
    throw new Error(
      `idle-task cadence report: unparseable timestamp "${then}"`,
    );
  }
  return (now.getTime() - ms) / MS_PER_DAY;
}

/** Floor state and overdue days for one window. */
function assessWindow(
  days: number | null,
  windowDays: number,
): { state: CadenceFloorState; overdue: number } {
  if (days === null) {
    return { state: "missed", overdue: NEVER_RUN_OVERDUE_DAYS };
  }
  // Inclusive boundary: exactly `windowDays` old is already a miss, matching
  // `computeDueScans` so the report and the filer never disagree.
  return days >= windowDays
    ? { state: "missed", overdue: days - windowDays }
    : { state: "met", overdue: 0 };
}

/** Compliance of one pair against the policy in force. */
function assessPair(
  entry: IdleTaskFreshnessEntry,
  now: Date,
  policy: CadencePolicy,
): CadencePairCompliance {
  const templatePolicy = policy.templates[entry.template]!;
  const base = {
    repo: entry.repo,
    template: entry.template,
    weeklyModel: templatePolicy.weeklyModel,
    monthlyModel: templatePolicy.monthlyModel,
    lastRunModel: entry.lastRunModel,
  };

  // Fail-open, exactly as the filer does: a history that could not be read is
  // reported as a gap, never counted as met and never counted as missed.
  if (entry.status === "unknown") {
    return {
      ...base,
      lastRunAt: null,
      lastRunDays: null,
      lastMonthlyTierAt: null,
      lastMonthlyTierDays: null,
      weekly: "unknown",
      monthly: "unknown",
      weeklyOverdueDays: null,
      monthlyOverdueDays: null,
      weeklyMetByUnstampedWrapper: false,
      verdict: "unknown",
    };
  }

  const lastMonthlyTierAt =
    entry.lastRunAtByModel?.[templatePolicy.monthlyModel] ?? null;
  const lastRunDays = daysSince(now, entry.lastRunAt);
  const lastMonthlyTierDays = daysSince(now, lastMonthlyTierAt);

  const weekly = assessWindow(lastRunDays, policy.weeklyDays);
  const monthly = assessWindow(lastMonthlyTierDays, policy.monthlyDays);

  const verdict: CadenceVerdict = entry.lastRunAt === null
    ? "never-run"
    // The expensive scan discharges both obligations, so a monthly miss is the
    // stronger statement when both windows have lapsed.
    : monthly.state === "missed"
    ? "monthly-missed"
    : weekly.state === "missed"
    ? "weekly-missed"
    : "ok";

  return {
    ...base,
    lastRunAt: entry.lastRunAt,
    lastRunDays,
    lastMonthlyTierAt,
    lastMonthlyTierDays,
    weekly: weekly.state,
    monthly: monthly.state,
    weeklyOverdueDays: weekly.overdue,
    monthlyOverdueDays: monthly.overdue,
    weeklyMetByUnstampedWrapper: weekly.state === "met" &&
      entry.lastRunModel === null,
    verdict,
  };
}

/** Worst overdue reading across both windows; -1 when nothing is overdue. */
function worstOverdue(pair: CadencePairCompliance): number {
  if (pair.verdict === "unknown" || pair.verdict === "ok") return -1;
  return Math.max(pair.weeklyOverdueDays ?? 0, pair.monthlyOverdueDays ?? 0);
}

/** Sort worst-first: overdue days, then unknown pairs, then repo/template. */
function sortByCompliance(
  pairs: readonly CadencePairCompliance[],
): CadencePairCompliance[] {
  return [...pairs].sort((a, b) => {
    const overdueDiff = worstOverdue(b) - worstOverdue(a);
    if (overdueDiff !== 0) return overdueDiff;
    // An unreadable history outranks a compliant pair: it is the gap an
    // operator must close before the numbers mean anything.
    const rank = Number(b.verdict === "unknown") -
      Number(a.verdict === "unknown");
    if (rank !== 0) return rank;
    if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
    return a.template < b.template ? -1 : a.template > b.template ? 1 : 0;
  });
}

/** Standing qualifications, always including the tier-stamp dependency. */
function buildCaveats(
  report: Omit<CadenceComplianceReport, "caveats">,
): string[] {
  const caveats = [
    `Monthly compliance is measured only from wrappers stamped with the ` +
    `monthly tier (Issue #4007). A wrapper filed before the tier stamp counts ` +
    `towards the weekly floor but never the monthly one, so a pair whose ` +
    `history predates the stamp reports monthly=missed with no fable reading — ` +
    `it is never assumed to be compliant.`,
  ];
  if (report.summary.unknown > 0) {
    caveats.push(
      `${report.summary.unknown} pair(s) whose history could not be read are ` +
        `listed as unknown and excluded from every met/missed count.`,
    );
  }
  if (report.summary.worstOffendersOmitted > 0) {
    caveats.push(
      `${report.summary.worstOffendersOmitted} further overdue pair(s) are ` +
        `omitted from the worst-offenders block; the full set is in the ` +
        `per-pair listing and the --json payload.`,
    );
  }
  if (!report.enabled) {
    caveats.push(
      `The cadence bias is disabled in the policy in force, so the filer is ` +
        `not working towards these floors — misses are expected.`,
    );
  }
  return caveats;
}

/**
 * Build the cadence compliance report for the important (repo, template) pairs
 * among `entries`.
 *
 * Busy-work templates are absent: they carry no floor, and today's plain
 * staleness rows already cover them.
 *
 * @param entries Freshness readings, one per (repo, template) pair.
 * @param now Reference instant — the caller owns the clock.
 * @param policy Cadence policy; defaults to {@link DEFAULT_CADENCE_POLICY}.
 * @throws Error when a timestamp in the history is unparseable.
 */
export function buildCadenceComplianceReport(
  entries: readonly IdleTaskFreshnessEntry[],
  now: Date,
  policy: CadencePolicy = DEFAULT_CADENCE_POLICY,
): CadenceComplianceReport {
  const pairs = sortByCompliance(
    entries
      .filter((entry) => Object.hasOwn(policy.templates, entry.template))
      .map((entry) => assessPair(entry, now, policy)),
  );

  const count = (
    predicate: (pair: CadencePairCompliance) => boolean,
  ): number => pairs.filter(predicate).length;

  const overdue = pairs.filter((pair) => worstOverdue(pair) >= 0);
  const summary: CadenceFleetSummary = {
    pairs: pairs.length,
    weeklyMet: count((p) => p.weekly === "met"),
    weeklyMissed: count((p) => p.weekly === "missed"),
    weeklyUnknown: count((p) => p.weekly === "unknown"),
    monthlyMet: count((p) => p.monthly === "met"),
    monthlyMissed: count((p) => p.monthly === "missed"),
    monthlyUnknown: count((p) => p.monthly === "unknown"),
    neverRun: count((p) => p.verdict === "never-run"),
    unknown: count((p) => p.verdict === "unknown"),
    worstOffenders: overdue.slice(0, WORST_OFFENDER_LIMIT),
    worstOffendersOmitted: Math.max(overdue.length - WORST_OFFENDER_LIMIT, 0),
  };

  const withoutCaveats = {
    generatedAt: now.toISOString(),
    enabled: policy.enabled,
    weeklyDays: policy.weeklyDays,
    monthlyDays: policy.monthlyDays,
    templates: Object.keys(policy.templates).sort(),
    pairs,
    summary,
  };
  return { ...withoutCaveats, caveats: buildCaveats(withoutCaveats) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Whole days for display, or `-` when the clock has no reading. */
function days(value: number | null): string {
  return value === null ? "-" : String(Math.floor(value));
}

/**
 * Structured log lines, one per pair, in the established `[idle-task] …` style
 * so a fleet's compliance can be scraped from a run's output:
 *
 * ```text
 * [idle-task-cadence] repo=org/widget template=security-scan weekly=met monthly=missed last_sonnet_days=2 last_fable_days=- weekly_tier=sonnet
 * ```
 *
 * `last_sonnet_days` is the weekly floor's clock — the age of the most recent
 * completed scan of **any** tier, since a pre-stamp wrapper counts towards the
 * week. `weekly_tier` names the tier that reading carried (`unstamped` for a
 * pre-#4007 wrapper, `none` when the pair has never run), so the report never
 * silently assumes a tier.
 */
export function cadenceLogLines(report: CadenceComplianceReport): string[] {
  return report.pairs.map((pair) => {
    const tier = pair.verdict === "unknown"
      ? "unknown"
      : pair.lastRunAt === null
      ? "none"
      : pair.lastRunModel ?? "unstamped";
    return `[idle-task-cadence] repo=${pair.repo} template=${pair.template} ` +
      `weekly=${pair.weekly} monthly=${pair.monthly} ` +
      `last_sonnet_days=${days(pair.lastRunDays)} ` +
      `last_fable_days=${days(pair.lastMonthlyTierDays)} weekly_tier=${tier}`;
  });
}

const COLUMNS = [
  "REPO",
  "TEMPLATE",
  "LAST RUN",
  "TIER",
  "AGE",
  "WEEKLY",
  "LAST MONTHLY",
  "MONTHLY",
  "VERDICT",
];

function pairRow(pair: CadencePairCompliance): string[] {
  return [
    pair.repo,
    pair.template,
    pair.lastRunAt === null ? "-" : pair.lastRunAt.slice(0, 10),
    pair.verdict === "unknown"
      ? "?"
      : pair.lastRunAt === null
      ? "-"
      : pair.lastRunModel ?? "unstamped",
    days(pair.lastRunDays),
    pair.weekly,
    pair.lastMonthlyTierAt === null ? "-" : pair.lastMonthlyTierAt.slice(0, 10),
    pair.monthly,
    pair.verdict,
  ];
}

/**
 * Render the compliance view as an aligned, greppable block: the per-pair
 * table, the fleet summary, the worst offenders, the standing caveats and the
 * structured log lines. The machine-readable form is the command's `--json`
 * mode.
 */
export function formatCadenceComplianceReport(
  report: CadenceComplianceReport,
): string {
  const rows = report.pairs.map(pairRow);
  const widths = COLUMNS.map((header, i) =>
    Math.max(header.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();

  const s = report.summary;
  const out: string[] = [
    `Idle-task cadence compliance — ${s.pairs} important pairs, weekly floor ` +
    `${report.weeklyDays}d / monthly floor ${report.monthlyDays}d` +
    (report.enabled ? "" : " (cadence bias disabled)"),
    "",
    line(COLUMNS),
    ...rows.map(line),
    "",
    `Weekly: ${s.weeklyMet} met, ${s.weeklyMissed} missed, ` +
    `${s.weeklyUnknown} unknown`,
    `Monthly: ${s.monthlyMet} met, ${s.monthlyMissed} missed, ` +
    `${s.monthlyUnknown} unknown`,
    `Pairs: ${s.neverRun} never-run, ${s.unknown} unknown`,
  ];

  if (s.worstOffenders.length > 0) {
    out.push("", "Worst offenders (most overdue first):");
    for (const pair of s.worstOffenders) {
      const overdue = worstOverdue(pair);
      const overdueText = overdue >= NEVER_RUN_OVERDUE_DAYS
        ? "never run on that clock"
        : `${overdue.toFixed(1)}d overdue`;
      out.push(
        `  ${pair.repo} ${pair.template} — ${pair.verdict}, ${overdueText}`,
      );
    }
  }

  out.push("", "Caveats:", ...report.caveats.map((c) => `  - ${c}`));
  out.push("", ...cadenceLogLines(report));
  return out.join("\n");
}
