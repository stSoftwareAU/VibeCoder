/**
 * Idle-task cadence policy — important vs busy work (Issues #4003, #4008).
 *
 * The steady-state filer picks one template for one repo at random per idle
 * tick (#2092), which is right for background work but leaves no floor under
 * the scans that actually matter. #4003 splits the registered templates in two:
 *
 *   - **important** — `security-scan`, `supply-chain-readiness` and
 *     `github-actions-audit` — each monitored repository is guaranteed a cheap
 *     `sonnet` scan at least **weekly** and an expensive `fable` scan at least
 *     **monthly**; and
 *   - **busy work** — every other registered template, untouched by cadence
 *     logic and still drawn at random.
 *
 * This module owns that policy and nothing else. It is **pure**: it imports
 * `IdleTaskFreshnessEntry` as a type only, performs no I/O, spawns no process,
 * and never reaches for `gh`. The freshness report (#3864, #4007) supplies the
 * history; the filer (#4009) consumes the due list. Neither is imported here.
 *
 * The rules, in one place:
 *
 *   - **Rolling windows.** Measured from the last **completed** scan, never
 *     calendar-anchored: 7 days for the weekly window, 30 for the monthly one.
 *   - **Boundaries are inclusive.** Exactly 7.0 / 30.0 days old counts as due
 *     (`>=`), matching the 168h cooldown boundary so a weekly pair is never
 *     blocked by its own cooldown.
 *   - **A fable run satisfies the week.** When both windows have lapsed the
 *     pair is emitted **once**, at the monthly tier — the expensive scan
 *     discharges both obligations.
 *   - **Pre-stamp wrappers count towards the week, not the month.** A wrapper
 *     filed before the tier stamp (#4007) sets `lastRunAt` but appears under no
 *     key in `lastRunAtByModel`, so it can never falsely satisfy the fable
 *     floor.
 *   - **`never-run` is maximally overdue** and sorts first.
 *   - **`unknown` yields nothing.** A repo whose history could not be read is
 *     fail-open: a failed read never biases the filer either way.
 *
 * Malformed input fails loud rather than being reconciled as "fresh": an
 * unparseable timestamp or a nonsensical window throws.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { IdleTaskFreshnessEntry } from "./idle_task_freshness.ts";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Templates whose cadence is guaranteed per monitored repository (#4003). */
export const IMPORTANT_TEMPLATE_NAMES: readonly string[] = [
  "security-scan",
  "supply-chain-readiness",
  "github-actions-audit",
];

/** Rolling window, in days, for the cheap scan. */
export const WEEKLY_WINDOW_DAYS = 7;

/** Rolling window, in days, for the expensive scan. */
export const MONTHLY_WINDOW_DAYS = 30;

/** Model tier the weekly scan runs on. */
export const WEEKLY_MODEL_TIER = "sonnet";

/** Model tier the monthly scan runs on. */
export const MONTHLY_MODEL_TIER = "fable";

/**
 * `overdueDays` for a window whose clock has no reading at all — the pair has
 * never run, or has never run at the tier the window governs.
 *
 * A finite sentinel rather than `Infinity` so the value survives a JSON round
 * trip (`JSON.stringify(Infinity)` is `null`, which would silently read back as
 * "not overdue").
 */
export const NEVER_RUN_OVERDUE_DAYS = Number.MAX_SAFE_INTEGER;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Model aliases a cadence window may be pinned to (cf. `ModelTier` in
 * `token_usage.ts`). Exported as a runtime list so the `.config.json` parser
 * (#4011) validates an operator's value against the same single source of
 * truth the type expresses.
 */
export const CADENCE_MODEL_TIERS = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
] as const;

/** Model aliases a cadence window may be pinned to (cf. `ModelTier`). */
export type CadenceModelTier = typeof CADENCE_MODEL_TIERS[number];

/** Per-template tier assignment for the two windows. */
export interface CadenceTemplatePolicy {
  /** Tier the weekly scan runs on. */
  weeklyModel: CadenceModelTier;
  /** Tier the monthly scan runs on. */
  monthlyModel: CadenceModelTier;
}

/**
 * The whole cadence policy. Mirrors the `idle_task_cadence` config block
 * (#4011) so wiring the operator's `.config.json` through is mechanical; until
 * that lands, {@link DEFAULT_CADENCE_POLICY} is the policy in force.
 */
export interface CadencePolicy {
  /** Kill switch — when false, no pair is ever reported as due. */
  enabled: boolean;
  /** Weekly rolling window, in days. */
  weeklyDays: number;
  /** Monthly rolling window, in days. */
  monthlyDays: number;
  /** Important templates, keyed by template name. Anything absent is busy work. */
  templates: Readonly<Record<string, CadenceTemplatePolicy>>;
}

/** One (repo, template) pair that is overdue, and the tier owed to it. */
export interface DueScan {
  repo: string;
  template: string;
  /** Tier the owed scan should run on. */
  tier: CadenceModelTier;
  /**
   * Days past the window's deadline, fractional. {@link NEVER_RUN_OVERDUE_DAYS}
   * when the window's clock has no reading at all.
   */
  overdueDays: number;
}

/** The #4003 policy: three important templates, 7-day sonnet, 30-day fable. */
export const DEFAULT_CADENCE_POLICY: CadencePolicy = {
  enabled: true,
  weeklyDays: WEEKLY_WINDOW_DAYS,
  monthlyDays: MONTHLY_WINDOW_DAYS,
  templates: Object.fromEntries(
    IMPORTANT_TEMPLATE_NAMES.map((name) => [name, {
      weeklyModel: WEEKLY_MODEL_TIER,
      monthlyModel: MONTHLY_MODEL_TIER,
    } as CadenceTemplatePolicy]),
  ),
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Whether a template is on the important list — i.e. subject to the cadence
 * floor. Classification is independent of {@link CadencePolicy.enabled}: the
 * kill switch stops scans being *reported as due*, it does not reclassify a
 * template as busy work.
 */
export function isImportantTemplate(
  name: string,
  policy: CadencePolicy = DEFAULT_CADENCE_POLICY,
): boolean {
  return Object.hasOwn(policy.templates, name);
}

// ---------------------------------------------------------------------------
// Due computation
// ---------------------------------------------------------------------------

/** Days between `then` and `now`, or null when `then` is absent. */
function daysSince(
  now: Date,
  then: string | null | undefined,
  entry: IdleTaskFreshnessEntry,
): number | null {
  if (then === null || then === undefined || then.length === 0) return null;
  const ms = Date.parse(then);
  if (Number.isNaN(ms)) {
    throw new Error(
      `idle-task cadence: unparseable timestamp "${then}" for ` +
        `${entry.repo} / ${entry.template}`,
    );
  }
  return (now.getTime() - ms) / MS_PER_DAY;
}

/** Reject a policy whose windows cannot express the intended cadence. */
function assertUsableWindows(policy: CadencePolicy): void {
  const check = (label: string, value: number) => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `idle-task cadence: ${label} must be a finite positive number, got ${value}`,
      );
    }
  };
  check("weeklyDays", policy.weeklyDays);
  check("monthlyDays", policy.monthlyDays);
  if (policy.monthlyDays <= policy.weeklyDays) {
    throw new Error(
      `idle-task cadence: monthlyDays (${policy.monthlyDays}) must exceed ` +
        `weeklyDays (${policy.weeklyDays})`,
    );
  }
}

/**
 * Compute the (repo, template, tier) pairs whose cadence floor has lapsed,
 * most-overdue first.
 *
 * Busy-work templates and `unknown` freshness readings are absent from the
 * output. A pair overdue on both windows is emitted once, at the monthly tier.
 *
 * @param entries Freshness readings, one per (repo, template) pair.
 * @param now Reference instant — injected so the caller owns the clock.
 * @param policy Cadence policy; defaults to {@link DEFAULT_CADENCE_POLICY}.
 * @throws Error when a timestamp is unparseable or the windows are unusable.
 */
export function computeDueScans(
  entries: readonly IdleTaskFreshnessEntry[],
  now: Date,
  policy: CadencePolicy = DEFAULT_CADENCE_POLICY,
): DueScan[] {
  if (!policy.enabled) return [];
  assertUsableWindows(policy);

  const due: DueScan[] = [];
  const neverRun = new Set<DueScan>();

  for (const entry of entries) {
    const templatePolicy = policy.templates[entry.template];
    if (templatePolicy === undefined) continue; // busy work
    // Fail-open: a repo whose history could not be read never biases the pick.
    if (entry.status === "unknown") continue;

    // The weekly window counts any completed scan, including pre-stamp
    // wrappers; the monthly window counts only scans stamped with its tier.
    const sinceAny = daysSince(now, entry.lastRunAt, entry);
    const sinceMonthlyTier = daysSince(
      now,
      entry.lastRunAtByModel?.[templatePolicy.monthlyModel],
      entry,
    );

    const monthlyOverdue = sinceMonthlyTier === null
      ? NEVER_RUN_OVERDUE_DAYS
      : sinceMonthlyTier - policy.monthlyDays;
    const weeklyOverdue = sinceAny === null
      ? NEVER_RUN_OVERDUE_DAYS
      : sinceAny - policy.weeklyDays;

    // The expensive tier wins when both windows have lapsed — one fable run
    // discharges the month and the week together.
    let scan: DueScan | null = null;
    if (monthlyOverdue >= 0) {
      scan = {
        repo: entry.repo,
        template: entry.template,
        tier: templatePolicy.monthlyModel,
        overdueDays: monthlyOverdue,
      };
    } else if (weeklyOverdue >= 0) {
      scan = {
        repo: entry.repo,
        template: entry.template,
        tier: templatePolicy.weeklyModel,
        overdueDays: weeklyOverdue,
      };
    }
    if (scan === null) continue;

    due.push(scan);
    if (sinceAny === null) neverRun.add(scan);
  }

  // Most overdue first; a pair that has never run at all outranks one that has
  // merely never run at the monthly tier. Repo then template break the rest.
  return due.sort((a, b) => {
    if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
    const rank = Number(neverRun.has(b)) - Number(neverRun.has(a));
    if (rank !== 0) return rank;
    if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
    return a.template < b.template ? -1 : a.template > b.template ? 1 : 0;
  });
}
