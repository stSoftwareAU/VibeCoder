/**
 * One cost/model run-stats comment per **run**, posted when the worker wraps an
 * issue up (Issues #3756, #797).
 *
 * Before this, only the planning close path posted a `## Planning run model
 * stats` comment (Issue #2649/#3750); every other phase reported stats **only
 * when the round was degraded** (Issue #3232), and a `work-on` issue closed by
 * a merged PR got nothing at all. So most issues the Vibe Coder completed
 * carried no cost indication.
 *
 * This module closes that gap without inventing a second format: it reuses the
 * shared {@link ./planning_run_stats.ts} render (via
 * {@link ./phase_run_stats.ts}) and adds three things a wrap-up needs:
 *
 * 1. **A run-scoped hidden marker plus a one-comment-per-run guard.** The
 *    original #3756 guard was issue-scoped, so the *first* wrap-up on an issue
 *    won the slot and every later run reported nothing. On issue #762 that was
 *    a $1.34 grill-me round; the work-on run that actually completed the issue
 *    — the expensive one — posted no figures at all, which is exactly the gap
 *    #797 reported. The marker now carries the run id
 *    (`<!-- vibe-issue-run-stats run="…" -->`) and the guard matches only the
 *    same run, so a repeat post inside one run is still suppressed while every
 *    completed run's spend stays visible.
 * 2. **A cumulative issue total.** From the second stats comment onward the
 *    block carries the sum across the run-stats comments on the issue, so the
 *    cost of the issue is readable without adding the comments up by hand.
 * 3. **An estimate disclaimer.** KISS on multi-worker coverage: no cross-worker
 *    aggregation infrastructure is introduced, so the comment says plainly what
 *    the figures do and do not cover.
 * 4. **The run's Graft figures** (Issue #2105, part of #2060). The host's
 *    worker log is private, so the status and figures of the run's Graft
 *    collection ride one bullet of the same comment — readable on the issue by
 *    whoever is judging the trial.
 *
 * Every GitHub operation here is **non-fatal** — a listing or comment failure
 * is logged and never aborts the phase that was wrapping the issue up
 * (mirroring the planning/grill-me closures). The return value reports what
 * actually happened, so a failure is never silently read as "posted".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import { buildDegradationReport, formatCount } from "./planning_run_stats.ts";
import { GEMINI_PROVIDER_ID } from "./agent_provider.ts";
import type { CodegraphContextResult } from "./codegraph_context.ts";
import {
  buildPhaseInvocations,
  type PhaseClaudeResult,
} from "./phase_run_stats.ts";
import {
  attributeUsageByModel,
  estimateRunCost,
  formatUsd,
  type ModelUsageEntry,
} from "./cost_estimate.ts";
import type { IssuePhaseRun } from "./fleet_telemetry.ts";
import type { IssueExecutorSplitStats } from "./issue_executor_enforcement.ts";
import type { GraftContextResult } from "./graft_context.ts";
import type { RtkOutputResult } from "./rtk_output.ts";
import { getRunId } from "./run_id.ts";

/**
 * What the implementation run's quality gate did (Issue #2345, part of #2320).
 *
 * The gate is bounded to two attempts — the initial `./quality.sh` run plus one
 * `quality_fix` remediation and re-run — so `attempt` is its own loop counter:
 * `1` for a gate that passed outright, `2` for one that passed after
 * remediation. A gate that never went green carries no attempt; `failed` is the
 * whole report, which covers a gate bypassed as pre-existing breakage and one
 * that only passed once the bump audit reverted the dependency bump. Recorded
 * by `workOnIssueQualityGate` on the phase state and rendered here.
 */
export type QualityGateAttemptOutcome =
  | { readonly status: "passed"; readonly attempt: number }
  | { readonly status: "failed" };

/**
 * Hidden HTML marker prefix every run-stats comment carries.
 *
 * The full marker is run-scoped — `<!-- vibe-issue-run-stats run="<id>" -->` —
 * so the duplicate guard suppresses a repeat post *within one run* without
 * suppressing the next run's costs (Issue #797).
 */
export const ISSUE_RUN_STATS_MARKER = "<!-- vibe-issue-run-stats";

/**
 * Heading every run-stats comment shares — `## <Phase> run model stats`.
 *
 * Matching on the heading (not just the marker) means the pre-existing
 * planning and degraded-round comments, which carry no marker, still count as
 * run-stats comments for the issue cost tally.
 */
const STATS_HEADING_PATTERN = /^##[ \t]+\S.*run model stats[ \t]*$/im;

/** Characters a run id may contribute to the HTML marker. */
const RUN_ID_UNSAFE_PATTERN = /[^A-Za-z0-9._-]+/g;

/**
 * Reduce a run id to marker-safe characters.
 *
 * The id is interpolated into an HTML comment, so anything that could close it
 * (`-->`, quotes, newlines) is collapsed to `-` before use — an untrusted or
 * malformed `VIBE_RUN_ID` can never break out of the marker. An id that
 * sanitises away entirely becomes `unknown` rather than an empty attribute.
 */
export function sanitiseStatsRunId(runId: string): string {
  const cleaned = runId.trim().replace(RUN_ID_UNSAFE_PATTERN, "-").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** Build the run-scoped hidden marker for `runId`. */
export function buildIssueRunStatsMarker(runId: string): string {
  return `${ISSUE_RUN_STATS_MARKER} run="${sanitiseStatsRunId(runId)}" -->`;
}

/**
 * The estimate disclaimer appended to every run-stats comment posted at
 * wrap-up. States the two limits of the figures explicitly: they are an
 * estimate, and the per-run block covers only the run that posted it.
 */
export const ISSUE_RUN_STATS_DISCLAIMER =
  "_Estimate only — this block covers the run that posted it. The issue total " +
  "sums the run-stats comments visible on this issue; runs that reported no " +
  "figures are not included._";

/**
 * The CodeGraph line's fixed prefix — one line per run, whatever the status.
 *
 * Deliberately outside the cost lines' shape ({@link ESTIMATED_COST_PATTERN}),
 * so the figures the CodeGraph trial reads can never be mistaken for spend by
 * {@link tallyIssueCost}.
 */
const CODEGRAPH_STATS_PREFIX = "- **CodeGraph:**";

/**
 * Format the index duration the way the trial reads it — `1.8`, `300` — with
 * no trailing `.0` on a whole number of seconds.
 */
function formatIndexSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Render the single CodeGraph line for a run's stats comment (Issue #2161).
 *
 * One line on **every** run, so the trial can tell an index that never ran
 * from one that failed: the status always appears, and whichever figures the
 * step actually gathered follow it. A `failed` run that timed out during the
 * index still reports the seconds it spent; a status with no figures at all
 * (`off`, `unsupported`) reports the status alone rather than an empty tail.
 *
 * `unsupported` names the provider that causes it — a Gemini-routed run has no
 * MCP transport to reach the index through, which is the only way this status
 * arises ({@link prepareCodegraphContext}).
 *
 * @param codegraph - What this run's CodeGraph step produced
 * @returns The markdown line, ready to append to the stats section
 */
export function buildCodegraphStatsLine(
  codegraph: CodegraphContextResult,
): string {
  const status = codegraph.status === "unsupported"
    ? `unsupported (${GEMINI_PROVIDER_ID})`
    : codegraph.status;
  const figures = [
    codegraph.indexSeconds === undefined
      ? undefined
      : `index ${formatIndexSeconds(codegraph.indexSeconds)} s`,
    codegraph.nodeCount === undefined
      ? undefined
      : `${formatCount(codegraph.nodeCount)} nodes`,
    codegraph.relationshipCount === undefined
      ? undefined
      : `${formatCount(codegraph.relationshipCount)} relationships`,
    codegraph.queries === undefined
      ? undefined
      : `${formatCount(codegraph.queries)} queries`,
  ].filter((part): part is string => part !== undefined);
  return figures.length > 0
    ? `${CODEGRAPH_STATS_PREFIX} ${status} — ${figures.join(", ")}`
    : `${CODEGRAPH_STATS_PREFIX} ${status}`;
}

/**
 * The RTK line's fixed prefix — one line per run, whatever the status.
 *
 * A status line, never a cost line: like {@link CODEGRAPH_STATS_PREFIX} it sits
 * outside the cost lines' shape ({@link ESTIMATED_COST_PATTERN}), so the
 * saved-token figure can never be mistaken for spend by {@link tallyIssueCost}.
 */
export const RTK_STATS_PREFIX = "- **RTK:**";

/**
 * Render the single RTK line for a run's stats comment (Issue #2385).
 *
 * One line on **every** run — `off` included — so the trial can separate the
 * enabled runs from the control runs by reading the comment alone. Only `ok`
 * carries a figure, the `rtk gain` delta the run recorded; a run whose delta
 * could not be read reports the bare status, because no figure beats a wrong
 * one ({@link RtkOutputResult.savedTokens}).
 *
 * `unsupported` names the provider that could not take the hook, when the run
 * resolved one.
 *
 * @param rtk - What this run's RTK preparation produced
 * @returns The markdown line, ready to append to the stats section
 */
export function buildRtkStatsLine(rtk: RtkOutputResult): string {
  if (rtk.status === "unsupported") {
    return rtk.provider === undefined
      ? `${RTK_STATS_PREFIX} unsupported`
      : `${RTK_STATS_PREFIX} unsupported (${rtk.provider})`;
  }
  return rtk.status === "ok" && rtk.savedTokens !== undefined
    ? `${RTK_STATS_PREFIX} ok — ${formatCount(rtk.savedTokens)} tokens saved`
    : `${RTK_STATS_PREFIX} ${rtk.status}`;
}

/**
 * The top-level cost line the shared render emits, e.g.
 * `- **Estimated cost (USD, estimate only):** ~$1.34`. Per-model sub-bullets
 * use a different shape, so only the run total is matched.
 */
const ESTIMATED_COST_PATTERN =
  /\*\*Estimated cost \(USD, estimate only\):\*\*\s*~\$([0-9][0-9,]*(?:\.[0-9]+)?)/;

/** What the run-stats comments on an issue add up to. */
export interface IssueCostTally {
  /** Run-stats comments counted (including the one being built). */
  runs: number;
  /** Sum of the parseable run totals, in USD. */
  total: number;
  /**
   * True when at least one counted comment contributed no parseable figure, or
   * itself reported a partial total — the sum is then a floor, not the whole
   * cost, and must say so rather than reading as complete (fail loud).
   */
  partial: boolean;
}

/**
 * Add up the estimated cost across an issue's run-stats comments.
 *
 * Only bodies that are themselves run-stats comments are parsed, so a comment
 * merely quoting a cost line never inflates the tally.
 *
 * @param bodies - Comment bodies to tally (prior comments plus the new one)
 */
export function tallyIssueCost(bodies: readonly string[]): IssueCostTally {
  let runs = 0;
  let total = 0;
  let partial = false;

  for (const body of bodies) {
    if (typeof body !== "string" || !hasIssueRunStatsComment([body])) continue;
    runs++;
    const line = body.split("\n").find((l) => ESTIMATED_COST_PATTERN.test(l));
    const amount = line
      ? Number(line.match(ESTIMATED_COST_PATTERN)?.[1]?.replace(/,/g, ""))
      : Number.NaN;
    if (!Number.isFinite(amount)) {
      partial = true;
      continue;
    }
    total += amount;
    if (line?.includes("(partial")) partial = true;
  }

  return { runs, total, partial };
}

/**
 * Render the cumulative-cost line, or `""` when this is the issue's first
 * run-stats comment (the block's own total already says everything).
 */
export function buildIssueCostTotalLine(tally: IssueCostTally): string {
  if (tally.runs < 2) return "";
  const suffix = tally.partial ? " (partial — some runs report no total)" : "";
  return `- **Issue total across ${tally.runs} run-stats comments:** ~${
    formatUsd(tally.total)
  }${suffix}`;
}

/** The three statuses a Graft collection can report. */
const GRAFT_STATUSES: readonly string[] = ["ok", "failed", "off"];

/**
 * Render one figure, or nothing when the collection never produced it.
 *
 * A figure that is absent or not a finite number is dropped rather than
 * rendered as `NaN`: a half-gathered collection reports what it reached and
 * says nothing about what it did not.
 */
function graftFigure(
  value: number | undefined,
  render: (value: number) => string,
): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? render(value)
    : undefined;
}

/**
 * Seconds to at most one decimal place, so `47` never reads as `47.0`.
 *
 * Deliberately unseparated: a build is bounded by the Graft build timeout, so
 * a figure with a thousands separator on the integers and none on the
 * fractions would be the only inconsistency the line could carry.
 */
function formatGraftSeconds(seconds: number): string {
  return String(Math.round(seconds * 10) / 10);
}

/**
 * The quality-gate line's fixed prefix (Issue #2345, part of #2320).
 *
 * **Stable and greppable by contract.** The advisor/executor pilot's
 * first-attempt quality-gate pass rate is counted by grepping these exact
 * strings off the issue — `quality gate: passed on attempt 1`,
 * `quality gate: passed on attempt 2`, `quality gate: failed` — so the wording,
 * the lower case and the ordering must not be re-styled. Bolding the prefix or
 * renaming the verb empties the metric silently, with nothing failing to say
 * so.
 *
 * Deliberately outside the cost lines' shape ({@link ESTIMATED_COST_PATTERN}),
 * so it can never be mistaken for spend by {@link tallyIssueCost}.
 */
const QUALITY_GATE_STATS_PREFIX = "- quality gate:";

/**
 * Render the run's quality-gate line for the stats block (Issue #2345).
 *
 * One line on every run that reached the gate: which of the gate's two bounded
 * attempts it passed on, or `failed` when it never passed. A caller with no
 * outcome — every phase that runs no quality gate — renders nothing, so those
 * comments are byte-for-byte what they were before this line existed.
 *
 * @param outcome - What the quality gate did, from the phase state
 * @returns The bullet line, or `""` when the run had no quality gate
 */
export function buildQualityGateStatsLine(
  outcome?: QualityGateAttemptOutcome,
): string {
  if (!outcome) return "";
  if (outcome.status === "failed") {
    return `${QUALITY_GATE_STATS_PREFIX} failed`;
  }
  return `${QUALITY_GATE_STATS_PREFIX} passed on attempt ${outcome.attempt}`;
}

/**
 * Render the run's Graft line for the stats block (Issue #2105, part of #2060).
 *
 * One line on every run, so the figures are readable on the issue itself
 * rather than only in the host's private worker log: the status always, and
 * whichever of the build time, bundle size, node count and call-edge count the
 * collection actually reached. A `failed` collection therefore reports what it
 * got to before it failed, and `off` says plainly that the host switch was off
 * rather than looking like a run that never reported.
 *
 * The status is rendered through an allow-list, so a value from a
 * deserialised outcome can never inject markdown into the comment.
 *
 * @param graft - The outcome from `collectGraftContext`, or undefined when the
 *   caller has none (the line is then omitted entirely)
 * @returns The bullet line, or `""` when there is no outcome to report
 */
export function buildGraftStatsLine(graft?: GraftContextResult): string {
  if (!graft) return "";
  const status = GRAFT_STATUSES.includes(graft.status)
    ? graft.status
    : "unknown";
  const figures = [
    graftFigure(graft.buildSeconds, (s) => `build ${formatGraftSeconds(s)} s`),
    graftFigure(
      graft.bundleChars,
      (n) => `bundle ${formatCount(Math.round(n))} chars`,
    ),
    graftFigure(graft.nodeCount, (n) => `${formatCount(Math.round(n))} nodes`),
    graftFigure(
      graft.callEdgeCount,
      (n) => `${formatCount(Math.round(n))} call edges`,
    ),
    // Issue #2314: the `graft_*` tool calls, when the tools were handed over.
    graftFigure(graft.queries, (n) => `${formatCount(Math.round(n))} queries`),
  ].filter((entry): entry is string => entry !== undefined);
  const detail = figures.length > 0 ? ` — ${figures.join(", ")}` : "";
  return `- **Graft:** ${status}${detail}`;
}

/**
 * The phase string every implementation run reports its stats under.
 *
 * Exported so the phases that post implementation run stats share this one
 * spelling: the split figures below render only for this phase, and a drifting
 * copy would silently empty the pilot metric.
 */
export const IMPLEMENTATION_RUN_STATS_PHASE = "issue";

/**
 * Prefixes of the advisor/executor split lines (Issues #2344, #2346).
 *
 * Greppable by contract, like the quality-gate line above: a pilot run's
 * figures are read off the issue by matching these prefixes, so the wording,
 * the lower case and the ordering must not be re-styled. None of them can match
 * {@link ESTIMATED_COST_PATTERN}, so the cumulative tally never reads a count as
 * spend.
 */
const SPLIT_STATS_PREFIX = "- split:";
const EXECUTOR_DISPATCH_STATS_PREFIX = "- executors dispatched:";
const EXECUTOR_RETASK_STATS_PREFIX = "- re-tasks issued:";
const ADVISOR_EDIT_STATS_PREFIX = "- advisor edit calls:";

/** The split figures a run recorded — empty when the split was off. */
function executorSplitStats(
  claudeResults: readonly PhaseClaudeResult[],
): IssueExecutorSplitStats[] {
  return claudeResults
    .map((result) => result.runStats?.executorSplit)
    .filter((stats): stats is IssueExecutorSplitStats => stats !== undefined);
}

/**
 * Render the run's advisor/executor split lines (Issues #2344, #2346).
 *
 * Every implementation run carries exactly one `split: on`/`split: off` line,
 * so a pilot run and a control run are separable when the numbers are read
 * later. A split run adds the executors dispatched, the re-tasks issued and the
 * advisor edit calls that got through (with the guard's denials in brackets); a
 * non-split run adds nothing beyond `split: off`. Phases that are not
 * implementation runs — the planning-shaped ones — render no split line at all,
 * so their comments stay byte-for-byte what they were.
 *
 * @param phase - The phase being reported
 * @param claudeResults - Completed invocations of the run being reported
 * @returns The bullet lines, empty for a non-implementation phase
 */
export function buildExecutorSplitStatsLines(
  phase: string,
  claudeResults: readonly PhaseClaudeResult[],
): string[] {
  if (phase !== IMPLEMENTATION_RUN_STATS_PHASE) return [];

  const splits = executorSplitStats(claudeResults);
  if (splits.length === 0) return [`${SPLIT_STATS_PREFIX} off`];

  const total = splits.reduce((sum, stats) => ({
    advisorEditCalls: sum.advisorEditCalls + stats.advisorEditCalls,
    denials: sum.denials + stats.deniedAdvisorEdits.length,
    executorDispatches: sum.executorDispatches + stats.executorDispatches,
    executorRetasks: sum.executorRetasks + stats.executorRetasks,
  }), {
    advisorEditCalls: 0,
    denials: 0,
    executorDispatches: 0,
    executorRetasks: 0,
  });

  return [
    `${SPLIT_STATS_PREFIX} on`,
    `${EXECUTOR_DISPATCH_STATS_PREFIX} ${total.executorDispatches}`,
    `${EXECUTOR_RETASK_STATS_PREFIX} ${total.executorRetasks}`,
    `${ADVISOR_EDIT_STATS_PREFIX} ${total.advisorEditCalls} (${total.denials} denied)`,
  ];
}

/**
 * Derive the fleet-telemetry figures for one completed implementation run
 * (Issue #2347, part of #2320).
 *
 * The same numbers this module renders on the comment — the estimated spend,
 * the summed invocation duration, whether the split was on, and the attempt the
 * quality gate passed on — reduced to what
 * {@link ../fleet_telemetry.ts recordIssuePhaseRun} accumulates per host. Kept
 * here rather than at the call site so the figures cannot drift from the
 * comment: the invocations, the expected model the cost falls back to and the
 * split rule are all the ones {@link buildIssueRunStatsComment} renders with.
 *
 * The expected model matters because it is what an invocation the API reported
 * no served model for is priced at. Taking the requested model instead would
 * make this figure and the comment's disagree on exactly the runs where the
 * price is least certain, so it is resolved through the same
 * {@link buildDegradationReport} call the comment uses.
 *
 * Spend is the estimate the comment reports, so a model with no pricing row
 * contributes nothing and the sum is a floor — exactly as the comment's own
 * `(partial — see below)` total says.
 *
 * @param args.phase - The phase being reported; only `issue` is measured
 * @param args.claudeResults - Completed invocations of the run
 * @param args.configuredBestModel - Pinned best model, when the phase has one;
 *   part of the expected-model routing chain, so it is passed exactly as the
 *   comment passes it
 * @param args.qualityGate - What the run's quality gate did, when it ran
 * @returns The run's figures, or `undefined` for a non-implementation phase or
 *   a run no invocation produced stats for — neither is a measurable run
 */
export function measureIssuePhaseRun(args: {
  phase: string;
  claudeResults: readonly PhaseClaudeResult[];
  configuredBestModel?: string;
  qualityGate?: QualityGateAttemptOutcome;
}): IssuePhaseRun | undefined {
  if (args.phase !== IMPLEMENTATION_RUN_STATS_PHASE) return undefined;

  const measured = args.claudeResults.filter((result) => result.runStats);
  // A run with invocations but no stats renders no comment at all, so there is
  // nothing to record and no figures to record it with. Counting it would add
  // a $0 run to the denominator of the pilot's first-attempt pass rate — the
  // one number this feature exists to produce.
  if (measured.length === 0) return undefined;

  const { expectedModel } = buildDegradationReport({
    invocations: measured.flatMap((result) =>
      buildPhaseInvocations(args.phase, result)
    ),
    phase: args.phase,
    ...(args.configuredBestModel
      ? { configuredBestModel: args.configuredBestModel }
      : {}),
  });

  const costEntries: ModelUsageEntry[] = [];
  let durationMs = 0;
  for (const result of measured) {
    const stats = result.runStats!;
    if (stats.tokenUsage) {
      costEntries.push(
        ...attributeUsageByModel(
          stats.tokenUsage,
          stats.modelUsage,
          stats.servedModels[0] ?? expectedModel,
        ),
      );
    }
    if (typeof stats.durationMs === "number") durationMs += stats.durationMs;
  }

  const gate = args.qualityGate;
  return {
    usd: estimateRunCost(costEntries).totalCost,
    durationSeconds: Math.round(durationMs / 1000),
    split: executorSplitStats(measured).length > 0,
    ...(gate?.status === "passed" ? { gatePassedOnAttempt: gate.attempt } : {}),
  };
}

/**
 * Build the wrap-up run-stats comment body for an issue.
 *
 * The stats block itself is rendered by the shared
 * {@link buildDegradationReport} triple, so the format matches the planning
 * comment exactly (requested/served models, effort, tokens, turns, duration,
 * estimated cost, degraded verdict).
 *
 * @param args.phase - The phase whose invocations are reported (e.g. `issue`,
 *   `grill_me`, `question`) — drives both the heading and the expected-model
 *   routing chain
 * @param args.claudeResults - Completed Claude invocations from this run
 * @param args.configuredBestModel - Pinned best model, when the phase has one
 * @param args.runId - Run this comment reports; defaults to the canonical
 *   {@link getRunId}
 * @param args.priorComments - Comment bodies already on the issue, used for the
 *   cumulative issue total
 * @param args.graft - What the run's Graft collection did (Issue #2105);
 *   omitted renders exactly the comment this function rendered before it
 *   existed
 * @param args.codegraph - What this run's CodeGraph step produced (Issue
 *   #2161); omitted renders exactly the comment this function rendered before
 *   the trial existed
 * @param args.qualityGate - What the run's quality gate did (Issue #2345);
 *   omitted — every phase that runs no gate — renders no such line, so those
 *   comments are byte-for-byte what they were before
 * @param args.rtk - What this run's RTK preparation produced (Issue #2385);
 *   omitted renders exactly the comment this function rendered before the
 *   line existed
 *
 * An implementation run also carries the split figures (Issue #2346): one
 * `split: on`/`split: off` line always, and the executor counts on a split run
 * — see {@link buildExecutorSplitStatsLines}.
 *
 * @returns The comment body, or `""` when no invocation produced stats (so
 *   callers post nothing rather than an empty comment)
 */
export function buildIssueRunStatsComment(args: {
  phase: string;
  claudeResults: PhaseClaudeResult[];
  configuredBestModel?: string;
  runId?: string;
  priorComments?: readonly string[];
  graft?: GraftContextResult;
  codegraph?: CodegraphContextResult;
  qualityGate?: QualityGateAttemptOutcome;
  rtk?: RtkOutputResult;
}): string {
  const invocations = args.claudeResults.flatMap((result) =>
    buildPhaseInvocations(args.phase, result)
  );
  const { section } = buildDegradationReport({
    invocations,
    phase: args.phase,
    ...(args.configuredBestModel
      ? { configuredBestModel: args.configuredBestModel }
      : {}),
  });
  if (!section) return "";

  const marker = buildIssueRunStatsMarker(args.runId ?? getRunId());
  // Appended to the stats bullets, so the Graft and CodeGraph figures and the
  // RTK status sit with the run they describe and ahead of the cumulative
  // issue total (Issues #2105, #2161, #2385).
  const graftLine = buildGraftStatsLine(args.graft);
  const codegraphLine = args.codegraph
    ? `\n${buildCodegraphStatsLine(args.codegraph)}`
    : "";
  // Issue #2345: the gate's own outcome, beside the figures of the run it
  // gated and ahead of the cumulative issue total.
  const qualityGateLine = buildQualityGateStatsLine(args.qualityGate);
  // Issues #2344, #2346: whether the run was split, and what the split did.
  const splitLines = buildExecutorSplitStatsLines(
    args.phase,
    args.claudeResults,
  );
  const splitBlock = splitLines.map((line) => `\n${line}`).join("");
  const rtkLine = args.rtk ? `\n${buildRtkStatsLine(args.rtk)}` : "";
  const body = `${marker}\n${section}${
    graftLine ? `\n${graftLine}` : ""
  }${codegraphLine}${
    qualityGateLine ? `\n${qualityGateLine}` : ""
  }${splitBlock}${rtkLine}`;
  const totalLine = buildIssueCostTotalLine(
    tallyIssueCost([...(args.priorComments ?? []), body]),
  );
  const withTotal = totalLine ? `${body}\n${totalLine}` : body;
  return `${withTotal}\n\n${ISSUE_RUN_STATS_DISCLAIMER}`;
}

/**
 * Report whether a body is a run-stats comment.
 *
 * True when any body carries the {@link ISSUE_RUN_STATS_MARKER} or a
 * `## <Phase> run model stats` heading — the latter covers the planning-path
 * and degraded-round comments written before this module existed.
 *
 * @param bodies - Existing comment bodies on the issue
 */
export function hasIssueRunStatsComment(bodies: readonly string[]): boolean {
  return bodies.some((body) =>
    typeof body === "string" &&
    (body.includes(ISSUE_RUN_STATS_MARKER) ||
      STATS_HEADING_PATTERN.test(body))
  );
}

/**
 * Report whether this run already posted its stats comment on the issue.
 *
 * Run-scoped, not issue-scoped (Issue #797): an earlier run's comment — a
 * grill-me round, a previous attempt, another Vibe Coder — does not suppress
 * this run's costs, so every completed run's spend is visible on the issue.
 *
 * @param bodies - Existing comment bodies on the issue
 * @param runId - The run about to post
 */
export function hasRunStatsCommentForRun(
  bodies: readonly string[],
  runId: string,
): boolean {
  const marker = buildIssueRunStatsMarker(runId);
  return bodies.some((body) =>
    typeof body === "string" && body.includes(marker)
  );
}

/**
 * Build an existing-comment lister backed by `gh issue view --json comments`.
 *
 * Every wrap-up call site already has a `runGhCommand`, so this keeps the
 * duplicate guard available without threading a `GitHubClient` through phases
 * that do not have one (e.g. the clarity phase).
 *
 * A malformed or unparseable response throws rather than degrading to "no
 * comments found" — treating a failed lookup as an empty thread would post a
 * duplicate and read as success (fail loud, Issue #3234). The caller
 * ({@link postIssueRunStatsComment}) catches it and reports `"error"`.
 */
export function ghIssueCommentLister(
  runGhCommand: (args: string[]) => Promise<string>,
): (
  repo: string,
  issueNumber: number,
) => Promise<{ body: string; author: string | null }[]> {
  return async (repo, issueNumber) => {
    const raw = await runGhCommand([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "comments",
    ]);
    const parsed = JSON.parse(raw) as {
      comments?: { body?: unknown; author?: unknown }[];
    };
    if (!Array.isArray(parsed?.comments)) {
      throw new Error(
        "gh issue view returned no `comments` array — cannot check for an existing run-stats comment",
      );
    }
    // The author rides along because the cumulative tally is only counted
    // over fleet-authored comments (Issue #1249, finding 12).
    return parsed.comments.map((c) => ({
      body: typeof c?.body === "string" ? c.body : "",
      author: typeof (c?.author as { login?: unknown } | undefined)?.login ===
          "string"
        ? (c.author as { login: string }).login
        : null,
    }));
  };
}

/** Why {@link postIssueRunStatsComment} did not post. */
export type IssueRunStatsSkipReason =
  /** No invocation produced stats — there is nothing to report. */
  | "no_stats"
  /** This run already posted its stats comment on the issue. */
  | "already_posted"
  /** A GitHub call failed; the comment was not posted. */
  | "error";

/** Outcome of {@link postIssueRunStatsComment}. */
export interface IssueRunStatsPostResult {
  /** True only when a comment was actually created. */
  posted: boolean;
  /** Present when {@link posted} is false. */
  reason?: IssueRunStatsSkipReason;
}

/**
 * Post this run's run-stats comment when the worker wraps an issue up.
 *
 * Called from every worker-handled wrap-up path: the `work-on` PR-raise (the
 * issue is auto-closed later by the merge, with no worker attached), the
 * grill-me / question / refinement final closes, and the not-planned closes.
 *
 * One comment **per run** (Issue #797): an earlier run's stats no longer
 * suppress this one, so the run that actually completed the issue reports what
 * it cost, and the comment carries the cumulative issue total.
 *
 * Non-fatal by contract: any GitHub failure is logged and reported as
 * `{ posted: false, reason: "error" }` — never swallowed into a success.
 *
 * @returns What happened, so callers can log or assert on it
 */
export async function postIssueRunStatsComment(args: {
  repo: string;
  issueNumber: number;
  phase: string;
  claudeResults: PhaseClaudeResult[];
  configuredBestModel?: string;
  /** Run this comment reports; defaults to the canonical {@link getRunId}. */
  runId?: string;
  /** What the run's Graft collection did (Issue #2105); omitted renders no line. */
  graft?: GraftContextResult;
  /** What this run's CodeGraph step produced (Issue #2161). */
  codegraph?: CodegraphContextResult;
  /** What this run's quality gate did (Issue #2345); omitted renders no line. */
  qualityGate?: QualityGateAttemptOutcome;
  /** What this run's RTK preparation produced (Issue #2385). */
  rtk?: RtkOutputResult;
  getIssueComments: (
    repo: string,
    issueNumber: number,
  ) => Promise<readonly { body: string; author?: string | null }[]>;
  /**
   * Fleet identity inputs for the cumulative-tally author check (Issue #1249,
   * finding 12). Omitted reads the configured fleet.
   */
  authorOptions?: AlertDedupAuthorOptions;
  postComment: (
    repo: string,
    issueNumber: number,
    body: string,
  ) => Promise<unknown>;
  logger: Logger;
}): Promise<IssueRunStatsPostResult> {
  const { repo, issueNumber, phase, logger } = args;
  const runId = args.runId ?? getRunId();
  const bestModel = args.configuredBestModel
    ? { configuredBestModel: args.configuredBestModel }
    : {};
  const graft = args.graft ? { graft: args.graft } : {};
  const codegraph = args.codegraph ? { codegraph: args.codegraph } : {};
  const qualityGate = args.qualityGate ? { qualityGate: args.qualityGate } : {};
  const rtk = args.rtk ? { rtk: args.rtk } : {};

  // Built without the issue's comments first, purely to answer "is there
  // anything to report?" — so a stats-free wrap-up costs no GitHub call. The
  // CodeGraph figures, the quality-gate outcome and the RTK status are left
  // out of this probe deliberately: none of them makes a stats-free run
  // worth a comment, so none of them can change the answer.
  if (
    !buildIssueRunStatsComment({
      phase,
      claudeResults: args.claudeResults,
      runId,
      ...bestModel,
      ...graft,
    })
  ) {
    logger.debug("No run stats to report on issue wrap-up (Issue #3756)", {
      repo,
      issueNumber,
      phase,
    });
    return { posted: false, reason: "no_stats" };
  }

  try {
    const existing = await args.getIssueComments(repo, issueNumber);
    // The published total is a number the worker vouches for, so it is summed
    // over fleet-authored comments only: anybody can post a body carrying the
    // run-stats marker and a cost line, and an unfiltered tally republished
    // whatever they typed as the issue's spend (Issue #1249, finding 12).
    // Fail direction: nothing attributable means nothing counted, so the
    // comment reports this run's own cost rather than a total it cannot stand
    // behind.
    const fleetComments = await selectFleetAuthoredComments(
      existing.filter((c) => hasIssueRunStatsComment([c.body])),
      `issue run-stats tally ${repo}#${issueNumber}`,
      args.authorOptions ?? {},
      (message) => logger.warn(message),
      "no prior run is counted and the comment reports this run's cost alone " +
        "— a cost line anyone can post must not inflate a published total",
    );
    const priorComments = fleetComments.map((c) => c.body);
    if (hasRunStatsCommentForRun(existing.map((c) => c.body), runId)) {
      logger.info("This run already posted its stats comment — skipping", {
        repo,
        issueNumber,
        phase,
        runId,
      });
      return { posted: false, reason: "already_posted" };
    }
    await args.postComment(
      repo,
      issueNumber,
      buildIssueRunStatsComment({
        phase,
        claudeResults: args.claudeResults,
        runId,
        priorComments,
        ...bestModel,
        ...graft,
        ...codegraph,
        ...qualityGate,
        ...rtk,
      }),
    );
    return { posted: true };
  } catch (err) {
    logger.warn("Failed to post issue run stats comment (non-fatal)", {
      repo,
      issueNumber,
      phase,
      error: err instanceof Error ? err.message : String(err),
    });
    return { posted: false, reason: "error" };
  }
}
