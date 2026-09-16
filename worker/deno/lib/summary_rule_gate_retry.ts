/**
 * In-run recovery from a PR-summary rule block (Issue #2189).
 *
 * The three summary gates at the completion phase's PR-creation chokepoint —
 * acceptance-criteria closure (#518), independent two-axis review (#663) and
 * bug reproduction status (#521) — check a *document*, not the code. When the
 * run had already raised its own PR, `reportSummaryRuleBlock` (#1140) recovers:
 * the PR is finalised and the run reports `summary_incomplete`. With no PR the
 * block posted its remediation comment and ended the run, so the next run — a
 * whole agent session — existed only to add a documentation block to a pushed,
 * quality-gated branch. On this host that was 4 of 16 runs that reached
 * completion in a fortnight, 3 of them failed outright.
 *
 * This module closes that cost model the way the security-fix gate closed its
 * own (Issue #1575): the first block in a run replays the gate's remediation
 * comment into one short agent invocation, re-runs the quality gate, and
 * re-runs completion once. A second block in the same run ends the run exactly
 * as before, with the comment already on the thread.
 *
 * The verdict text is worker-authored — each gate's comment builder prints its
 * own template plus problem lines quoting the branch's own PR summary — so it
 * is replayed verbatim rather than fenced: the agent must reproduce the block's
 * `<!-- vibe-spec-review -->` markers exactly, and neutralising them would
 * defeat the brief.
 *
 * Australian English throughout.
 */

import {
  type IssueContext,
  type PhaseResult,
  type PhaseState,
  recordClaudeRunStats,
} from "./issue_worker_types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { workOnIssueQualityGate } from "./phases/quality_gate_remediation_phase.ts";

/** One summary-rule gate verdict observed during a single run. */
export interface SummaryRuleRunVerdict {
  /** The phase-failure reason the gate reported. */
  reason: string;
  /** The gate's remediation comment — the agent's brief on the retry. */
  comment: string;
}

/**
 * Prompt for the in-run recovery invocation.
 *
 * A fresh invocation (never `--resume`): the previous turn concluded the work
 * was finished, so continuing it reproduces that conclusion. The gate's own
 * comment rides in verbatim, so the agent reads the same brief it would have
 * read on the next run's issue thread.
 *
 * Fails loud on an unusable verdict — a prompt that names no gate comment would
 * send the agent off to re-derive the shortfall itself.
 */
export function buildSummaryRuleRetryPrompt(
  verdict: SummaryRuleRunVerdict,
  repo: string,
  issueNumber: number,
): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `buildSummaryRuleRetryPrompt requires a positive issue number, got ${issueNumber}`,
    );
  }
  if (verdict.comment.trim() === "") {
    throw new Error(
      "buildSummaryRuleRetryPrompt requires the gate's remediation comment",
    );
  }
  const summaryPath = `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`;
  return `A PR-summary gate blocked PR creation for ${repo}#${issueNumber}, in THIS run. Nothing else about the run has changed: your branch and its commits are intact, and the worker will re-run the quality gate and raise the PR as soon as the summary satisfies the gate.

The block was: ${verdict.reason}

--- PR-SUMMARY GATE RETRY NOTICE ---
${verdict.comment}
--- END OF PR-SUMMARY GATE RETRY NOTICE ---

Do exactly this, and nothing else:

1. Read \`${summaryPath}\` — the summary the gate just read — and \`git diff\` against the base branch, so the block you write describes the change that is actually on the branch.
2. Fix ONLY what the notice above lists. This is a documentation shortfall in the summary file: the code on the branch has already passed the quality gate, so do not change it.
3. Where the notice asks for the \`## Acceptance Criteria\` or \`## Standards Review\` block, dispatch the two reviewer sub-agents first and write their verdicts down. Never invent a \`reviewer:\` verdict — a fabricated review is the over-claim those blocks exist to prevent.
4. Commit the change, referencing #${issueNumber}. Do not create the PR yourself, do not close the issue, and do not start new work.

If the notice is wrong — the summary already carries what it asks for — say so plainly in your final message and commit nothing.`;
}

/**
 * Recover from a summary-rule gate block inside the run (Issue #2189).
 *
 * Called by the completion phase for the FIRST block of a run that reached no
 * PR. The agent is re-invoked with the gate's comment, the quality gate runs
 * again over the changed tree, and completion is attempted once more. A block
 * on that attempt is the run's second and is returned as the failure it is —
 * the caller does not re-enter here, so a run spends at most one recovery
 * invocation.
 *
 * @param blocked - The failure the gate reported, returned unchanged when the
 *   recovery invocation cannot be launched.
 * @param rerunCompletion - Re-runs the completion attempt after the retry.
 */
export async function recoverFromSummaryRuleBlock(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  blocked: PhaseResult,
  rerunCompletion: () => Promise<PhaseResult>,
): Promise<PhaseResult> {
  const logger = deps.logger;
  const { repo, issueNumber, config } = ctx;
  const verdicts = state.summaryRuleBlocks ?? [];
  const latest = verdicts[verdicts.length - 1];
  if (!latest) {
    // The caller only enters here with a verdict recorded; saying so beats
    // silently returning a pass.
    logger.warn(
      "No summary-rule verdict to act on — the block stands",
      { repo, issueNumber },
    );
    return blocked;
  }

  logger.warn(
    "PR-summary rule block — recovering once in-run (Issue #2189)",
    { repo, issueNumber, reason: latest.reason },
  );

  const retryResult = await deps.claude.runClaudeWithRetry(
    {
      prompt: buildSummaryRuleRetryPrompt(latest, repo, issueNumber),
      phase: "issue",
      repo,
      issueNumber,
      timeoutSeconds: config.claudeTimeout,
      killAfterSeconds: config.claudeKillAfter,
      model: config.claudeModel || undefined,
      cwd: state.repoPath,
      logger,
    },
    { maxRetries: config.maxRateLimitRetries },
  );

  if (!retryResult.ok) {
    // The agent could not be re-invoked, so nothing on the branch changed and
    // there is nothing new to gate. The block stands exactly as it did before
    // this recovery existed, with the gate's comment already on the thread.
    logger.warn(
      `Summary-rule gate recovery invocation failed — the block stands: ${retryResult.error.message}`,
      { repo, issueNumber },
    );
    return blocked;
  }
  recordClaudeRunStats(state, retryResult.value);

  // The retry changed the tree, so the quality gate runs again before the
  // completion gates — the same order the pipeline uses after any agent turn.
  const quality = await workOnIssueQualityGate(ctx, state, deps);
  if (quality.status !== "continue") return quality;

  return await rerunCompletion();
}
