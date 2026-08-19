/**
 * Aggregate observed planning-run model stats across runs (Issue #2705).
 *
 * FLEET#2569 was the first planning run to post model stats (#2649), so a single
 * data point could not tell us whether the `fable`→`opus` served-model
 * substitution was a one-off blip (transient capacity) or systemic (every
 * planning run silently served a different tier). This module reuses the
 * existing per-run "Planning run model stats" comment format — it does **not**
 * build a new dashboard, and it does **not** duplicate the daily credit
 * aggregation.
 *
 * It parses the markdown that {@link buildPlanningStatsSection} emits and folds
 * a list of observations into a one-off-vs-systemic verdict, so the team can
 * see the pattern at a glance as more runs report.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { modelFamily, modelsMatch } from "./planning_run_stats.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single observed planning run's requested-vs-served outcome. */
export interface PlanningRunObservation {
  /** The model the run requested (e.g. `fable`). */
  requestedModel: string;
  /** The model(s) the API declared it served (e.g. `claude-opus-4-8`). */
  servedModels: string[];
  /** Whether the run's stats comment flagged it degraded. */
  degraded: boolean;
  /** Optional `owner/repo` for the per-repo breakdown. */
  repo?: string;
  /** Optional parent issue number the stats were posted on. */
  issue?: number;
}

/** One-off vs systemic verdict for a set of observations. */
export type AggregateVerdict =
  | "systemic"
  | "one-off"
  | "inconclusive"
  | "none";

/** Folded summary across a set of planning-run observations. */
export interface PlanningRunSummary {
  /** Total observations supplied. */
  totalRuns: number;
  /** Observations whose requested model is the `fable` tier family. */
  fableRequested: number;
  /** Of {@link fableRequested}, runs whose served model matched `fable`. */
  fableServed: number;
  /** Of {@link fableRequested}, runs served a non-`fable` tier. */
  mismatched: number;
  /** Served tier family → count, among the mismatched `fable` runs. */
  byServedFamily: Record<string, number>;
  /** Distinct `owner/repo` values seen across the mismatched runs. */
  repos: string[];
  /** The one-off vs systemic verdict. */
  verdict: AggregateVerdict;
  /** Human-readable rationale for the verdict. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const STATS_HEADER = "## Planning run model stats";

/** Strip surrounding markdown backticks/whitespace from a captured value. */
function clean(value: string): string {
  return value.trim().replace(/^`|`$/g, "").trim();
}

/**
 * Parse a "Planning run model stats" comment body.
 *
 * Reads the markdown {@link buildPlanningStatsSection} emits. Returns null when
 * the body has no stats block or no requested model line, so callers can filter
 * non-stats comments without throwing.
 *
 * @param body - The full comment body (may contain other sections)
 * @returns The parsed observation, or null when the body has no stats block
 */
export function parsePlanningStatsComment(
  body: string,
):
  | Pick<PlanningRunObservation, "requestedModel" | "servedModels" | "degraded">
  | null {
  if (!body || !body.includes(STATS_HEADER)) return null;

  const requested = body.match(/\*\*Requested model:\*\*\s*(.+)/);
  if (!requested) return null;
  const requestedModel = clean(requested[1]!);
  if (!requestedModel) return null;

  const servedLine = body.match(/\*\*Served model\(s\):\*\*\s*(.+)/);
  const servedModels: string[] = [];
  if (servedLine) {
    const raw = servedLine[1]!.trim();
    // "_none reported_" → no served models.
    if (!/^_none reported_$/i.test(raw)) {
      for (const part of raw.split(",")) {
        const m = clean(part);
        if (m) servedModels.push(m);
      }
    }
  }

  const degradedLine = body.match(/\*\*Degraded:\*\*\s*(.+)/);
  const degraded = degradedLine ? /yes/i.test(degradedLine[1]!) : false;

  return { requestedModel, servedModels, degraded };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** True when none of the served models match the requested model's tier. */
function isMismatch(obs: PlanningRunObservation): boolean {
  if (obs.servedModels.length === 0) return false;
  return !obs.servedModels.some((s) => modelsMatch(obs.requestedModel, s));
}

/**
 * Fold a list of planning-run observations into a one-off-vs-systemic summary.
 *
 * Only runs that requested the `fable` tier family are judged (that is the tier
 * the served-model mismatch was observed on — #2698/#2701). The verdict:
 *
 * - **none** — no `fable`-requested runs, or every `fable` run was served
 *   `fable` (no mismatch observed).
 * - **inconclusive** — exactly one `fable`-requested run mismatched (a single
 *   data point cannot distinguish one-off from systemic — the #2705 premise).
 * - **systemic** — at least two `fable` runs mismatched and the mismatch rate
 *   is overwhelming (≥ 80%): the substitution recurs rather than being a blip.
 * - **one-off** — `fable` runs mismatched, but isolated (below the systemic
 *   threshold), consistent with transient capacity.
 *
 * @param observations - The observed planning runs
 * @returns The folded summary with verdict and rationale
 */
export function summarisePlanningRuns(
  observations: PlanningRunObservation[],
): PlanningRunSummary {
  const fableRuns = observations.filter(
    (o) => modelFamily(o.requestedModel) === "fable",
  );
  const mismatchedRuns = fableRuns.filter(isMismatch);

  const byServedFamily: Record<string, number> = {};
  const repoSet = new Set<string>();
  for (const run of mismatchedRuns) {
    if (run.repo) repoSet.add(run.repo);
    for (const served of run.servedModels) {
      const fam = modelFamily(served) ?? served;
      byServedFamily[fam] = (byServedFamily[fam] ?? 0) + 1;
    }
  }

  const fableRequested = fableRuns.length;
  const mismatched = mismatchedRuns.length;
  const fableServed = fableRequested - mismatched;
  const repos = [...repoSet].sort();

  let verdict: AggregateVerdict;
  let rationale: string;

  if (fableRequested === 0) {
    verdict = "none";
    rationale = "No planning runs requested the `fable` tier.";
  } else if (mismatched === 0) {
    verdict = "none";
    rationale =
      `All ${fableRequested} \`fable\` planning run(s) were served \`fable\` — no mismatch observed.`;
  } else if (mismatched === 1) {
    verdict = "inconclusive";
    rationale =
      "Only one mismatched `fable` planning run observed — a single data point cannot distinguish one-off from systemic.";
  } else {
    const rate = mismatched / fableRequested;
    if (rate >= 0.8) {
      verdict = "systemic";
      rationale =
        `${mismatched} of ${fableRequested} \`fable\` planning runs across ${repos.length} repo(s) were served a non-\`fable\` tier (${
          Math.round(rate * 100)
        }%) — the mismatch recurs.`;
    } else {
      verdict = "one-off";
      rationale =
        `${mismatched} of ${fableRequested} \`fable\` planning runs mismatched (${
          Math.round(rate * 100)
        }%) — isolated rather than pervasive, consistent with a transient cause.`;
    }
  }

  return {
    totalRuns: observations.length,
    fableRequested,
    fableServed,
    mismatched,
    byServedFamily,
    repos,
    verdict,
    rationale,
  };
}

/**
 * Render a {@link PlanningRunSummary} as a compact markdown block so the team
 * can see one-off vs systemic at a glance (no new dashboard).
 *
 * @param summary - The folded summary
 * @returns A markdown block
 */
export function formatPlanningRunSummary(summary: PlanningRunSummary): string {
  const families = Object.entries(summary.byServedFamily)
    .sort((a, b) => b[1] - a[1])
    .map(([fam, n]) => `\`${fam}\` ×${n}`)
    .join(", ");

  const lines = [
    "## Planning-run mismatch aggregate",
    "",
    `- **Verdict:** ${summary.verdict}`,
    `- **Rationale:** ${summary.rationale}`,
    `- **Runs observed:** ${summary.totalRuns} (requested \`fable\`: ${summary.fableRequested})`,
    `- **Served \`fable\`:** ${summary.fableServed} · **mismatched:** ${summary.mismatched}`,
  ];
  if (families) lines.push(`- **Mismatched served as:** ${families}`);
  if (summary.repos.length > 0) {
    lines.push(`- **Repos affected:** ${summary.repos.join(", ")}`);
  }
  return lines.join("\n");
}
