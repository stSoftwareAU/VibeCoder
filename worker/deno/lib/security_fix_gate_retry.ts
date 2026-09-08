/**
 * In-run recovery from a security-fix gate block (Issue #1575).
 *
 * A gate block (`security_fix_gate.ts`) used to end the run: the completion
 * phase returned `failure`, no PR was raised, and the verdict reached the next
 * attempt only through host-local run state (`security_fix_gate_feedback.ts`,
 * Issue #4057). One *false* block therefore cost a whole run — issue #1385 lost
 * three of them (~USD 10.50, 28 minutes) to a regex that could not read a test
 * name `deno fmt` had wrapped onto the following line, with a correct branch
 * every time.
 *
 * The regex fault is fixed (#1581). This module closes the cost model behind
 * it: the first block inside a run is recoverable — the worker replays the
 * verdict into a fresh agent invocation and re-runs the gates — and only a
 * second block in the same run ends the run. Two consecutive *blocked runs*
 * then hand the issue to a human rather than burning a third.
 *
 * The completion phase calls {@link recoverFromSecurityGateBlock} and supplies
 * the completion attempt to re-run; everything else here is pure text.
 * Australian English throughout.
 */

import {
  buildSecurityFixGateMessage,
  type SecurityFixEvidenceKind,
} from "./security_fix_gate.ts";
import {
  buildSecurityFixGateFeedbackSection,
  recordSecurityFixGateBlock,
  resolveSecurityGateStateDir,
  type SecurityFixGateBlock,
} from "./security_fix_gate_feedback.ts";
import {
  type IssueContext,
  type PhaseResult,
  type PhaseState,
  recordClaudeRunStats,
} from "./issue_worker_types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { workOnIssueQualityGate } from "./phases/quality_gate_remediation_phase.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";

/** One gate verdict observed during a single run. */
export interface SecurityGateRunVerdict {
  /** Evidence items the gate reported missing. */
  missing: SecurityFixEvidenceKind[];
  /** Test declarations the gate matched in the branch diff (capped). */
  declarations: string[];
}

/**
 * Consecutive blocked runs tolerated on one issue before the worker stops
 * re-attempting and hands it to a human (Issue #1575).
 *
 * A *blocked run* is a run that ended in `failure` from the gate. The first
 * block inside a run is recovered by the in-run retry and never counts.
 */
export const MAX_CONSECUTIVE_BLOCKED_RUNS = 2;

/** Whether the recorded blocked-run count has reached the escalation point. */
export function shouldEscalateBlockedRuns(blockCount: number): boolean {
  return blockCount >= MAX_CONSECUTIVE_BLOCKED_RUNS;
}

/**
 * The single operator-facing comment a blocked run posts.
 *
 * A run that recovers on the retry posts nothing — the first verdict was never
 * a run-ending outcome. A run blocked twice posts one comment carrying both
 * verdicts, so the issue does not accumulate a comment per invocation.
 */
export function buildSecurityFixGateBlockComment(
  verdicts: readonly SecurityGateRunVerdict[],
): string {
  const last = verdicts[verdicts.length - 1];
  if (!last) {
    throw new Error(
      "buildSecurityFixGateBlockComment requires at least one verdict",
    );
  }
  const body = buildSecurityFixGateMessage(last.missing, last.declarations);
  if (verdicts.length === 1) return body;

  const earlier = verdicts
    .slice(0, -1)
    .map((verdict, index) =>
      `- Attempt ${index + 1}: ${verdict.missing.join(", ")}`
    )
    .join("\n");
  return `${body}

### Earlier verdicts in this run (Issue #1575)

The worker re-invoked the agent once inside this run after the first block and
the gate blocked again. The earlier verdict was:

${earlier}`;
}

/**
 * Prompt for the in-run retry invocation.
 *
 * A fresh invocation (never `--resume`): the previous turn concluded the work
 * was finished, so continuing it reproduces that conclusion. The verdict rides
 * in on the same worker-authored replay section the next-run prompt uses
 * (Issue #4057), so the agent reads one contract however it is retried.
 */
export function buildSecurityFixGateRetryPrompt(
  block: SecurityFixGateBlock,
): string {
  return `The security-fix gate blocked PR creation for ${block.repo}#${block.issueNumber}, in THIS run. Nothing else about the run has changed: your branch and its commits are intact, and the worker will re-run the quality gate and re-raise the PR as soon as the gate is satisfied.

${buildSecurityFixGateFeedbackSection(block)}

Do exactly this, and nothing else:

1. Read \`docs/archive/pr-summaries/pr-summary-${block.issueNumber}.md\` and the tests your branch actually added (\`git diff\` against the base branch).
2. Fix ONLY what the verdict above lists. The code on the branch is very likely already correct — the usual fault is a PR summary that cites a test identifier which does not match the test declaration in the diff.
3. Commit the change. Do not create the PR yourself, do not close the issue, and do not start new work.

If the verdict is wrong — the summary already cites a test the diff declares — say so plainly in your final message and commit nothing.`;
}

/**
 * Escalation text for an issue that has now cost {@link
 * MAX_CONSECUTIVE_BLOCKED_RUNS} consecutive blocked runs.
 */
export function buildBlockedRunsEscalation(
  block: SecurityFixGateBlock,
): { reason: string; nextStep: string } {
  return {
    reason:
      `${block.blockCount} consecutive runs on this issue ended blocked by the security-fix gate (Issue #1575), each after an in-run retry. The last verdict reported these evidence items missing: ${
        block.missing.join(", ")
      }.`,
    nextStep:
      "Read the gate comment above: it lists the test declarations the gate matched in the branch diff. If the summary already cites one of them, the gate itself is at fault — fix `worker/deno/lib/security_fix_gate.ts`. Otherwise supply the missing evidence in the PR summary and remove `needs-human` to release the issue.",
  };
}

/**
 * Persist this run's latest gate verdict (Issue #4057, recounted by #1575).
 *
 * `countsAsBlockedRun` is false for a block the run recovers from — that block
 * costs no run, so it must not charge the issue one. Fail loud but non-fatal:
 * the PR is blocked either way, and an operator must be able to see that the
 * count could not be updated.
 */
async function persistVerdict(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  countsAsBlockedRun: boolean,
): Promise<SecurityFixGateBlock | undefined> {
  const verdicts = state.securityGateBlocks ?? [];
  const latest = verdicts[verdicts.length - 1];
  if (!latest) return undefined;
  try {
    const block = await recordSecurityFixGateBlock(
      resolveSecurityGateStateDir(ctx.config.workDir),
      ctx.repo,
      ctx.issueNumber,
      latest.missing,
      { countsAsBlockedRun, declarations: latest.declarations },
    );
    deps.logger.info("Recorded security-fix gate verdict", {
      blockedRuns: block.blockCount,
      countsAsBlockedRun,
    });
    return block;
  } catch (err) {
    deps.logger.warn(
      `Could not persist the security-fix gate verdict — the next attempt will start blind and the consecutive-blocked-run count is NOT updated, so the ${MAX_CONSECUTIVE_BLOCKED_RUNS}-run hand-off may be delayed: ${
        (err as Error).message
      }`,
    );
    // The retry still needs the verdict, so fall back to the in-memory one.
    return {
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      missing: latest.missing,
      blockedAt: new Date().toISOString(),
      blockCount: countsAsBlockedRun ? 1 : 0,
      declarations: latest.declarations,
    };
  }
}

/**
 * Report a gate block that this run could not recover from.
 *
 * Posts the single operator-facing comment carrying every verdict the run
 * collected, and — only when the block genuinely ended the run in `failure`
 * from the gate — counts the blocked run and hands the issue to a human once
 * {@link MAX_CONSECUTIVE_BLOCKED_RUNS} consecutive runs have ended that way. An
 * agent invocation that could not be launched is not a gate verdict, so it is
 * reported without charging the issue a blocked run.
 */
async function reportBlock(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  countsAsBlockedRun: boolean,
  reasonPrefix = "",
): Promise<PhaseResult> {
  const logger = deps.logger;
  const { repo, issueNumber } = ctx;
  const verdicts = state.securityGateBlocks ?? [];
  const block = await persistVerdict(ctx, state, deps, countsAsBlockedRun);
  const comment = buildSecurityFixGateBlockComment(verdicts);

  const client = deps.github.createClient(logger);
  try {
    await client.postComment(repo, issueNumber, comment);
  } catch (err) {
    logger.warn(
      `Failed to post the security-fix gate comment (non-fatal): ${
        (err as Error).message
      }`,
    );
  }

  if (
    countsAsBlockedRun && block && shouldEscalateBlockedRuns(block.blockCount)
  ) {
    const escalation = buildBlockedRunsEscalation(block);
    await escalateToHuman({
      ghClient: client,
      repo,
      target: { kind: "issue", number: issueNumber },
      needsHumanLabel: ctx.config.needsHumanLabel,
      reason: escalation.reason,
      nextStep: escalation.nextStep,
      heading: "Security-fix gate blocked this issue twice",
      dedupKey: `security-fix-gate-${issueNumber}`,
      githubUser: ctx.githubUser,
      deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
      logger,
    });
  }

  return { status: "failure", reason: `${reasonPrefix}${comment}` };
}

/**
 * Recover from a security-fix gate block inside the run (Issue #1575).
 *
 * The first block re-invokes the agent with the verdict replayed into a FRESH
 * invocation (never `--resume`: the previous turn already concluded the work
 * was finished), then re-runs the quality gate and the completion attempt.
 * `bump-deps` is not re-run — the bump is already on the branch. A second block
 * ends the run exactly as any block did before, with one comment carrying both
 * verdicts.
 *
 * @param rerunCompletion - Re-runs the completion attempt after the retry.
 */
export async function recoverFromSecurityGateBlock(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  rerunCompletion: () => Promise<PhaseResult>,
): Promise<PhaseResult> {
  const logger = deps.logger;
  const { repo, issueNumber, config } = ctx;

  // Persisted before the retry so a run that dies mid-recovery still leaves the
  // verdict for the next attempt — charging no blocked run, because this block
  // has not ended one.
  const block = await persistVerdict(ctx, state, deps, false);
  if (!block) {
    return {
      status: "failure",
      reason: "No security-fix gate verdict to act on",
    };
  }

  logger.warn("security-fix gate block — retrying once in-run (Issue #1575)", {
    repo,
    issueNumber,
    missing: block.missing,
  });

  const retryResult = await deps.claude.runClaudeWithRetry(
    {
      prompt: buildSecurityFixGateRetryPrompt(block),
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
    // The agent could not be re-invoked. That is not a second gate verdict, so
    // it is reported without charging the issue a blocked run.
    logger.warn(
      `Security-fix gate retry invocation failed: ${retryResult.error.message}`,
    );
    return await reportBlock(
      ctx,
      state,
      deps,
      false,
      `The in-run gate retry could not be launched (${retryResult.error.message}).\n\n`,
    );
  }
  recordClaudeRunStats(state, retryResult.value);

  // The retry changed the tree, so the quality gate runs again before the
  // completion gates — the same order the pipeline uses after any agent turn.
  const quality = await workOnIssueQualityGate(ctx, state, deps);
  if (quality.status !== "continue") return quality;

  const result = await rerunCompletion();
  if (
    result.status === "failure" && (state.securityGateBlocks?.length ?? 0) > 1
  ) {
    return await reportBlock(ctx, state, deps, true);
  }
  return result;
}
