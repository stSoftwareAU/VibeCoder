/**
 * One cost/model run-stats comment per issue, posted when the issue is wrapped
 * up (Issue #3756).
 *
 * Before this, only the planning close path posted a `## Planning run model
 * stats` comment (Issue #2649/#3750); every other phase reported stats **only
 * when the round was degraded** (Issue #3232), and a `work-on` issue closed by
 * a merged PR got nothing at all. So most issues the Vibe Coder completed
 * carried no cost indication.
 *
 * This module closes that gap without inventing a second format: it reuses the
 * shared {@link ./planning_run_stats.ts} render (via
 * {@link ./phase_run_stats.ts}) and adds two things a per-issue wrap-up needs:
 *
 * 1. **A hidden marker plus a one-comment-per-issue guard.** Comment volume is
 *    a defect in its own right, so the poster reads the issue's existing
 *    comments first and skips when a run-stats comment is already present —
 *    including the planning-path comment, which is matched by its heading. The
 *    result is exactly one stats comment per issue, whichever path got there
 *    first.
 * 2. **An estimate disclaimer.** KISS on multi-run/multi-worker coverage: the
 *    posting worker reports only the run(s) it knows about. No cross-worker or
 *    cross-phase aggregation infrastructure is introduced, so the comment says
 *    plainly what it does and does not cover.
 *
 * Every GitHub operation here is **non-fatal** — a listing or comment failure
 * is logged and never aborts the phase that was wrapping the issue up
 * (mirroring the planning/grill-me closures). The return value reports what
 * actually happened, so a failure is never silently read as "posted".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import { buildDegradationReport } from "./planning_run_stats.ts";
import {
  buildPhaseInvocations,
  type PhaseClaudeResult,
} from "./phase_run_stats.ts";

/**
 * Hidden HTML marker identifying the one-per-issue run-stats comment.
 *
 * Invisible when rendered, so it costs the reader nothing, and unambiguous for
 * the duplicate guard.
 */
export const ISSUE_RUN_STATS_MARKER = "<!-- vibe-issue-run-stats -->";

/**
 * Heading every run-stats comment shares — `## <Phase> run model stats`.
 *
 * Matching on the heading (not just the marker) means the pre-existing
 * planning and degraded-round comments, which carry no marker, still count as
 * "this issue already has its stats comment".
 */
const STATS_HEADING_PATTERN = /^##[ \t]+\S.*run model stats[ \t]*$/im;

/**
 * The estimate disclaimer appended to every run-stats comment posted at
 * wrap-up. States the two limits of the figures explicitly: they are an
 * estimate, and they cover only the posting worker's own run(s).
 */
export const ISSUE_RUN_STATS_DISCLAIMER =
  "_Estimate only — these figures cover the run(s) this Vibe Coder made on " +
  "this issue. Earlier phases, and any other Vibe Coder that worked the same " +
  "issue, are not included._";

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
 * @returns The comment body, or `""` when no invocation produced stats (so
 *   callers post nothing rather than an empty comment)
 */
export function buildIssueRunStatsComment(args: {
  phase: string;
  claudeResults: PhaseClaudeResult[];
  configuredBestModel?: string;
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
  return `${ISSUE_RUN_STATS_MARKER}\n${section}\n\n${ISSUE_RUN_STATS_DISCLAIMER}`;
}

/**
 * Report whether an issue already carries a run-stats comment.
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
    (body.includes(ISSUE_RUN_STATS_MARKER) || STATS_HEADING_PATTERN.test(body))
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
): (repo: string, issueNumber: number) => Promise<{ body: string }[]> {
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
    const parsed = JSON.parse(raw) as { comments?: { body?: unknown }[] };
    if (!Array.isArray(parsed?.comments)) {
      throw new Error(
        "gh issue view returned no `comments` array — cannot check for an existing run-stats comment",
      );
    }
    return parsed.comments.map((c) => ({
      body: typeof c?.body === "string" ? c.body : "",
    }));
  };
}

/** Why {@link postIssueRunStatsComment} did not post. */
export type IssueRunStatsSkipReason =
  /** No invocation produced stats — there is nothing to report. */
  | "no_stats"
  /** The issue already carries a run-stats comment. */
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
 * Post the one-per-issue run-stats comment when the worker wraps an issue up.
 *
 * Called from every worker-handled wrap-up path: the `work-on` PR-raise (the
 * issue is auto-closed later by the merge, with no worker attached), the
 * grill-me / question / refinement final closes, and the not-planned closes.
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
  getIssueComments: (
    repo: string,
    issueNumber: number,
  ) => Promise<readonly { body: string }[]>;
  postComment: (
    repo: string,
    issueNumber: number,
    body: string,
  ) => Promise<unknown>;
  logger: Logger;
}): Promise<IssueRunStatsPostResult> {
  const { repo, issueNumber, phase, logger } = args;

  const body = buildIssueRunStatsComment({
    phase,
    claudeResults: args.claudeResults,
    ...(args.configuredBestModel
      ? { configuredBestModel: args.configuredBestModel }
      : {}),
  });
  if (!body) {
    logger.debug("No run stats to report on issue wrap-up (Issue #3756)", {
      repo,
      issueNumber,
      phase,
    });
    return { posted: false, reason: "no_stats" };
  }

  try {
    const existing = await args.getIssueComments(repo, issueNumber);
    if (hasIssueRunStatsComment(existing.map((c) => c.body))) {
      logger.info("Issue already has a run stats comment — skipping", {
        repo,
        issueNumber,
        phase,
      });
      return { posted: false, reason: "already_posted" };
    }
    await args.postComment(repo, issueNumber, body);
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
