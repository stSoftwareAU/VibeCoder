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
import { buildDegradationReport } from "./planning_run_stats.ts";
import {
  buildPhaseInvocations,
  type PhaseClaudeResult,
} from "./phase_run_stats.ts";
import { formatUsd } from "./cost_estimate.ts";
import { getRunId } from "./run_id.ts";

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
 * @returns The comment body, or `""` when no invocation produced stats (so
 *   callers post nothing rather than an empty comment)
 */
export function buildIssueRunStatsComment(args: {
  phase: string;
  claudeResults: PhaseClaudeResult[];
  configuredBestModel?: string;
  runId?: string;
  priorComments?: readonly string[];
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
  const body = `${marker}\n${section}`;
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

  // Built without the issue's comments first, purely to answer "is there
  // anything to report?" — so a stats-free wrap-up costs no GitHub call.
  if (
    !buildIssueRunStatsComment({
      phase,
      claudeResults: args.claudeResults,
      runId,
      ...bestModel,
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
