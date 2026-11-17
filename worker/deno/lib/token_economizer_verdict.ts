/**
 * Keep-or-purge verdict for the TokenEconomizer trial (Issue #4959).
 *
 * The module is pure: a report from `token_economizer_trial_report.ts` and a
 * clock go in, a verdict comes out. It applies sections 3 to 6 of
 * `docs/TOKEN-ECONOMIZER-TRIAL.md`: a stop overrides everything, the window
 * must be at least 7 days old with at least 60 completed switched-on runs,
 * and the concurrent comparison decides, with the before comparison reported
 * beside it.
 *
 * Uses Australian English spelling throughout.
 */

import type { TokenEconomizerStopRule } from "./token_economizer_plugin.ts";
import type {
  CostDifference,
  PopulationMetrics,
  TokenEconomizerTrialReport,
} from "./token_economizer_trial_report.ts";

const DAY_MS = 86_400_000;

/** Fewest days a window must span before a verdict is due. */
export const VERDICT_MIN_DAYS = 7;
/** Fewest completed switched-on runs before a verdict is due. */
export const VERDICT_MIN_COMPLETED_RUNS = 60;
/** The switched-on cost per completed run must be at least this much lower. */
export const COST_REDUCTION_PERCENT = 10;
/** Longest wait before the next check, in days (inside the worker's 30-day defer-until cap). */
export const MAX_NEXT_CHECK_DAYS = 7;
/** Window age, in days, after which a figure still unavailable on the deciding comparison is a purge. */
export const MISSING_DATA_LIMIT_DAYS = 28;

/** Every stop rule a reported stop can name. */
export const TOKEN_ECONOMIZER_STOP_RULES = [
  "secret-in-learnings",
  "cross-repo-fact",
  "plugin-run-failure",
  "unreadable-stop-record",
] as const satisfies readonly TokenEconomizerStopRule[];

/** The result of one clause of the bar. */
export type ClauseResult = "pass" | "miss" | "unavailable";

/** The bar applied to one comparison. */
export interface ComparisonVerdict {
  cost: ClauseResult;
  success: ClauseResult;
  merge: ClauseResult;
  /** Relative cost difference in percent, when available. */
  costPercent?: number;
  outcome: ClauseResult;
}

/** The verdict. */
export type TokenEconomizerVerdict =
  | { kind: "stopped"; reason: string }
  | {
    kind: "not-due";
    reason: string;
    nextCheck: string;
    elapsedDays: number;
    completedRuns: number;
  }
  | {
    kind: "undetermined";
    reason: string;
    nextCheck: string;
    before: ComparisonVerdict;
    concurrent: ComparisonVerdict;
  }
  | {
    kind: "keep" | "purge";
    reason: string;
    before: ComparisonVerdict;
    concurrent: ComparisonVerdict;
    disagreement: boolean;
  };

/** Verdict options. */
export interface VerdictOptions {
  now: Date;
  /** A stop rule from a fleet-authored stop comment ({@link verifiedStopRule}). */
  stopRule?: TokenEconomizerStopRule;
}

/** True when the value names a stop rule. */
export function isTokenEconomizerStopRule(
  value: unknown,
): value is TokenEconomizerStopRule {
  return TOKEN_ECONOMIZER_STOP_RULES.some((rule) => rule === value);
}

export { TOKEN_ECONOMIZER_STOP_MARKER } from "./token_economizer_stop_format.ts";
import {
  TOKEN_ECONOMIZER_STOP_MARKER,
  tokenEconomizerStopLine,
} from "./token_economizer_stop_format.ts";
import { isFleetAuthor } from "./fleet_authors.ts";

/** One issue comment, as `gh issue view --json comments` returns it. */
export interface StopComment {
  author: string | null;
  body: string;
}

/**
 * The stop rule named by a stop comment a fleet account wrote, or undefined.
 *
 * The stop comment is fixed text on a public issue, so anyone can post a copy.
 * Only a comment whose author is in `fleetAuthors` (compared case-blind) and
 * which carries the controller's first line and marker counts. An empty fleet
 * set verifies no comment; the report command refuses to take a verdict then.
 */
export function verifiedStopRule(
  comments: readonly StopComment[],
  fleetAuthors: readonly string[],
): TokenEconomizerStopRule | undefined {
  for (const comment of comments) {
    if (!isFleetAuthor(comment.author, [...fleetAuthors])) continue;
    if (!comment.body.includes(TOKEN_ECONOMIZER_STOP_MARKER)) continue;
    const firstLine = comment.body.split("\n", 1)[0] ?? "";
    const rule = TOKEN_ECONOMIZER_STOP_RULES.find((rule) =>
      firstLine.replace(/\r$/, "") === tokenEconomizerStopLine(rule)
    );
    if (rule) return rule;
  }
  return undefined;
}

function rateClause(on?: number, comparison?: number): ClauseResult {
  if (on === undefined || comparison === undefined) return "unavailable";
  return on >= comparison ? "pass" : "miss";
}

/** Apply the three clauses of the bar to one comparison. */
export function compareAgainst(
  on: PopulationMetrics,
  comparison: PopulationMetrics,
  difference: CostDifference,
): ComparisonVerdict {
  const cost: ClauseResult = !difference.available
    ? "unavailable"
    : difference.percent <= -COST_REDUCTION_PERCENT
    ? "pass"
    : "miss";
  const success = rateClause(on.successRate, comparison.successRate);
  const merge = rateClause(on.merge.rate, comparison.merge.rate);
  const clauses = [cost, success, merge];
  const outcome: ClauseResult = clauses.includes("miss")
    ? "miss"
    : clauses.includes("unavailable")
    ? "unavailable"
    : "pass";
  return {
    cost,
    success,
    merge,
    ...(difference.available ? { costPercent: difference.percent } : {}),
    outcome,
  };
}

function namesOf(v: ComparisonVerdict, result: ClauseResult): string {
  const names: string[] = [];
  if (v.cost === result) names.push("cost");
  if (v.success === result) names.push("success rate");
  if (v.merge === result) names.push("merge rate");
  return names.join(", ");
}

function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

/** Decide keep, purge, stopped, not-due or undetermined. */
export function decideTokenEconomizerVerdict(
  report: TokenEconomizerTrialReport,
  options: VerdictOptions,
): TokenEconomizerVerdict {
  if (options.stopRule !== undefined) {
    return {
      kind: "stopped",
      reason:
        `stop rule ${options.stopRule} was reported by a fleet-authored stop comment`,
    };
  }
  const stopped = report.exclusions.onByStatus.stopped;
  if (stopped > 0) {
    return {
      kind: "stopped",
      reason:
        `${stopped} switched-on run(s) recorded the plugin status stopped`,
    };
  }

  const elapsedDays =
    (Date.parse(report.windowEnd) - Date.parse(report.windowStart)) / DAY_MS;
  const completedRuns = report.switchedOn.completed;
  if (
    elapsedDays < VERDICT_MIN_DAYS || completedRuns < VERDICT_MIN_COMPLETED_RUNS
  ) {
    const runsWait = completedRuns >= VERDICT_MIN_COMPLETED_RUNS
      ? 0
      : completedRuns > 0 && elapsedDays > 0
      ? (VERDICT_MIN_COMPLETED_RUNS - completedRuns) * elapsedDays /
        completedRuns
      : MAX_NEXT_CHECK_DAYS;
    const waitDays = Math.max(VERDICT_MIN_DAYS - elapsedDays, runsWait);
    const clamped = Math.min(Math.max(waitDays, 1), MAX_NEXT_CHECK_DAYS);
    return {
      kind: "not-due",
      reason: `the window is ${
        elapsedDays.toFixed(1)
      } of ${VERDICT_MIN_DAYS} days old and has ${completedRuns} of ${VERDICT_MIN_COMPLETED_RUNS} completed switched-on runs`,
      nextCheck: addDays(options.now, clamped),
      elapsedDays,
      completedRuns,
    };
  }

  const before = compareAgainst(
    report.switchedOn,
    report.before,
    report.beforeDifference,
  );
  const concurrent = compareAgainst(
    report.concurrentOn,
    report.concurrent,
    report.concurrentDifference,
  );

  if (concurrent.outcome === "unavailable") {
    const which = namesOf(concurrent, "unavailable");
    if (elapsedDays >= MISSING_DATA_LIMIT_DAYS) {
      return {
        kind: "purge",
        reason:
          `missing data is not a successful trial: ${which} unavailable on the concurrent comparison after ${
            elapsedDays.toFixed(1)
          } days`,
        before,
        concurrent,
        disagreement: before.outcome !== concurrent.outcome,
      };
    }
    return {
      kind: "undetermined",
      reason:
        `the concurrent comparison cannot decide yet: ${which} unavailable`,
      nextCheck: addDays(options.now, MAX_NEXT_CHECK_DAYS),
      before,
      concurrent,
    };
  }

  const disagreement = before.outcome !== concurrent.outcome;
  if (concurrent.outcome === "pass") {
    return {
      kind: "keep",
      reason:
        "the concurrent comparison meets the bar on cost, success rate and merge rate",
      before,
      concurrent,
      disagreement,
    };
  }
  return {
    kind: "purge",
    reason: `the concurrent comparison misses the bar on ${
      namesOf(concurrent, "miss")
    }`,
    before,
    concurrent,
    disagreement,
  };
}

function costCell(v: ComparisonVerdict): string {
  if (v.costPercent === undefined) return v.cost;
  const sign = v.costPercent >= 0 ? "+" : "";
  return `${v.cost} (${sign}${v.costPercent.toFixed(1)}%)`;
}

/** Render the verdict as Markdown. */
export function formatTokenEconomizerVerdict(
  verdict: TokenEconomizerVerdict,
): string {
  const lines: string[] = ["## TokenEconomizer trial verdict", ""];
  switch (verdict.kind) {
    case "stopped":
      lines.push(
        "**Verdict: stopped (failed).**",
        "",
        `${verdict.reason}.`,
        "",
        `A stop rule overrides the ${VERDICT_MIN_DAYS}-day and ${VERDICT_MIN_COMPLETED_RUNS}-run window; the trial goes to the section 8 purge.`,
      );
      break;
    case "not-due":
      lines.push(
        "**Verdict: not due.**",
        "",
        `${verdict.reason}.`,
        "",
        `Next check: ${verdict.nextCheck}.`,
      );
      break;
    case "undetermined":
      lines.push(
        "**Verdict: undetermined.**",
        "",
        `${verdict.reason}.`,
        "",
        `Missing data is not a successful trial: it becomes a purge after day ${MISSING_DATA_LIMIT_DAYS} of the window.`,
        "",
        `Next check: ${verdict.nextCheck}.`,
      );
      break;
    case "keep":
    case "purge":
      lines.push(
        `**Verdict: ${verdict.kind}.**`,
        "",
        `${verdict.reason}.`,
      );
      break;
  }
  if (
    verdict.kind === "keep" || verdict.kind === "purge" ||
    verdict.kind === "undetermined"
  ) {
    const c = verdict.concurrent;
    const b = verdict.before;
    lines.push(
      "",
      "| Clause | Concurrent (decides) | Before |",
      "| ------ | -------------------- | ------ |",
      `| Cost (≥ ${COST_REDUCTION_PERCENT}% lower) | ${costCell(c)} | ${
        costCell(b)
      } |`,
      `| Success rate (no worse) | ${c.success} | ${b.success} |`,
      `| Merge rate (no worse) | ${c.merge} | ${b.merge} |`,
    );
  }
  if (
    (verdict.kind === "keep" || verdict.kind === "purge") &&
    verdict.disagreement
  ) {
    lines.push(
      "",
      "The before and concurrent comparisons disagree; the concurrent comparison decides.",
    );
  }
  if (verdict.kind !== "stopped") {
    lines.push(
      "",
      "This verdict does not check the three section 5 exclusions the archive cannot apply: the advisor/executor split, other trial windows, and the provider that served a control run.",
    );
  }
  return lines.join("\n");
}
