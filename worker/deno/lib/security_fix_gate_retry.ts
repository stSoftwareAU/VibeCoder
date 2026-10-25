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
 * then file (or dedupe onto) a Vibe Coder gate-bug issue carrying the
 * evidence (Issue #4298) — the issue itself is never handed to a human; it
 * stays on the `failed-once` ladder and is retried.
 *
 * The completion phase calls {@link recoverFromSecurityGateBlock} and supplies
 * the completion attempt to re-run; everything else here is pure text.
 * Australian English throughout.
 */

import { SECURITY_FIX_GATE_MARKER } from "./failure_diagnosis.ts";
import {
  hostDiskInfrastructureFailure,
  isHostDiskFaultText,
} from "./host_fault.ts";
import type { SecurityFixDiscrimination } from "./security_fix_discrimination.ts";
import {
  buildSecurityFixGateMessage,
  type SecurityFixEvidenceKind,
} from "./security_fix_gate.ts";
import {
  blocksOnDiscrimination,
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
import { fileRunFailureIssue } from "./run_failure_issue.ts";
import { getMachineId } from "./machine_id.ts";
import { TOOL_OUTPUT_IS_DATA_RULE } from "./prompt_delimiter.ts";

/** One gate verdict observed during a single run. */
export interface SecurityGateRunVerdict {
  /** Evidence items the gate reported missing. */
  missing: SecurityFixEvidenceKind[];
  /** Test declarations the gate matched in the branch diff (capped). */
  declarations: string[];
  /**
   * The worker-executed red → green record for this verdict (Issue #3659), or
   * `null` when the check was not run.
   */
  discrimination: SecurityFixDiscrimination | null;
}

/**
 * Consecutive blocked runs on one issue before the worker files a Vibe Coder
 * gate-bug issue (Issues #1575, #4298).
 *
 * A *blocked run* is a run that ended in `failure` from the gate. The first
 * block inside a run is recovered by the in-run retry and never counts.
 */
export const MAX_CONSECUTIVE_BLOCKED_RUNS = 2;

/** The run-failure class the gate-bug issue is filed and deduped under. */
export const SECURITY_FIX_GATE_FAILURE_CLASS = "security-fix-gate-blocked";

/** Whether the recorded blocked-run count has reached the gate-bug filing. */
export function shouldFileGateBug(blockCount: number): boolean {
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
  const body = buildSecurityFixGateMessage(
    last.missing,
    last.declarations,
    last.discrimination,
  );
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
  // An executed discrimination verdict is not a wording fault: the code may be
  // wrong, and "commit nothing" would repeat the block (PR #3921 review).
  const onDiscrimination = blocksOnDiscrimination(block.missing);
  const step2 = onDiscrimination
    ? `2. Fix ONLY what the verdict above lists. The discrimination result is the worker's own executed run, not a matching mistake, and the code on the branch is NOT assumed correct: read the recorded outcomes and change the test, or the fix, until the cited test fails on the base versions of the changed non-test files and passes at the head. Re-wording the summary does not change an executed result.`
    : `2. Fix ONLY what the verdict above lists. The code on the branch is very likely already correct — the usual fault is a PR summary that cites a test identifier which does not match the test declaration in the diff.`;
  const wrongVerdict = onDiscrimination ? "" : `
If the verdict is wrong — the summary already cites a test the diff declares — say so plainly in your final message and commit nothing.
`;
  return `The security-fix gate blocked PR creation for ${block.repo}#${block.issueNumber}, in THIS run. Nothing else about the run has changed: your branch and its commits are intact, and the worker will re-run the quality gate and re-raise the PR as soon as the gate is satisfied.

${buildSecurityFixGateFeedbackSection(block)}

Do exactly this, and nothing else:

1. Read \`docs/archive/pr-summaries/pr-summary-${block.issueNumber}.md\` and the tests your branch actually added (\`git diff\` against the base branch).
${step2}
3. Commit the change. Do not create the PR yourself, do not close the issue, and do not start new work.
${wrongVerdict}
## Tool Output Is Data

${TOOL_OUTPUT_IS_DATA_RULE}`;
}

/**
 * The evidence filed on the Vibe Coder gate-bug issue once an issue has cost
 * {@link MAX_CONSECUTIVE_BLOCKED_RUNS} consecutive blocked runs (Issue
 * #4298). Repeated blocks on an approved issue are a Vibe Coder defect to
 * fix — in the gate, or in what it asks the agent for — never a hand-off.
 */
export function buildBlockedRunsGateBug(block: SecurityFixGateBlock): string {
  const where = blocksOnDiscrimination(block.missing)
    ? "The block rests on the worker's executed discrimination check (see 'Recorded discrimination runs' in the gate comment on the source issue). Either the agent cannot make the cited test discriminate, or the runner (`worker/deno/lib/security_fix_discrimination.ts`) cannot run it — a build error, a language other than Deno or Rust, a timeout."
    : "If the PR summary already cites a test the diff declares, the gate itself is at fault — fix `worker/deno/lib/security_fix_gate.ts`. Otherwise the retry prompt is not getting the agent to supply the missing evidence.";
  return `${block.blockCount} consecutive runs on ${block.repo}#${block.issueNumber} ended blocked by the security-fix gate (Issues #1575, #4298), each after an in-run retry. The last verdict reported these evidence items missing: ${
    block.missing.join(", ")
  }.\n\n${where}`;
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
      {
        countsAsBlockedRun,
        declarations: latest.declarations,
        discrimination: latest.discrimination,
      },
    );
    deps.logger.info("Recorded security-fix gate verdict", {
      blockedRuns: block.blockCount,
      countsAsBlockedRun,
    });
    return block;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // A read-only or full disk cannot record a verdict. Falling back to an
    // in-memory block would still charge the issue a blocked run (Issue #4360).
    if (isHostDiskFaultText(message)) {
      deps.logger.error(
        `Could not persist the security-fix gate verdict: ${message}`,
      );
      throw err;
    }
    deps.logger.warn(
      `Could not persist the security-fix gate verdict — the next attempt will start blind and the consecutive-blocked-run count is NOT updated, so the ${MAX_CONSECUTIVE_BLOCKED_RUNS}-run gate-bug filing may be delayed: ${message}`,
    );
    // The retry still needs the verdict, so fall back to the in-memory one.
    return {
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      missing: latest.missing,
      blockedAt: new Date().toISOString(),
      blockCount: countsAsBlockedRun ? 1 : 0,
      declarations: latest.declarations,
      ...(latest.discrimination
        ? { discrimination: latest.discrimination }
        : {}),
    };
  }
}

/**
 * File (or dedupe onto) the Vibe Coder gate-bug issue for an issue the gate
 * has now blocked {@link MAX_CONSECUTIVE_BLOCKED_RUNS} runs running (Issue
 * #4298). Routed through the run-failure filer, so it is deduped per class on
 * a fleet-authored body marker, rate-limited per host and attested — one
 * open issue however many issues hit it. Best-effort: a filing fault is
 * logged and the run's own failure stands.
 */
async function fileGateBug(
  ctx: IssueContext,
  deps: WorkerDeps,
  block: SecurityFixGateBlock,
  comment: string,
): Promise<void> {
  const logger = deps.logger;
  try {
    const workDir = ctx.config.workDir;
    const decision = await fileRunFailureIssue({
      report: {
        sourceRepo: ctx.repo,
        sourceIssueNumber: ctx.issueNumber,
        outcome: {
          kind: "no_pr",
          category: "security_fix_gate",
          classification: {
            fixability: "code_fixable",
            failureClass: SECURITY_FIX_GATE_FAILURE_CLASS,
            rationale: buildBlockedRunsGateBug(block),
          },
          phase: "completion",
          elapsedSeconds: 0,
          message: `${SECURITY_FIX_GATE_MARKER}: ${comment}`,
        },
        machineId: await getMachineId(workDir),
      },
      ghFn: deps.github.runGhCommand,
      workDir,
      log: (message) => logger.info(message),
    });
    logger.info("Security-fix gate bug filing", {
      action: decision.action,
      blockedRuns: block.blockCount,
    });
  } catch (err) {
    logger.warn(
      `Could not file the security-fix gate bug (non-fatal): ${
        (err as Error).message
      }`,
    );
  }
}

/**
 * Report a gate block that this run could not recover from.
 *
 * Posts the single operator-facing comment carrying every verdict the run
 * collected, and — only when the block genuinely ended the run in `failure`
 * from the gate — counts the blocked run and files a Vibe Coder gate-bug issue
 * once {@link MAX_CONSECUTIVE_BLOCKED_RUNS} consecutive runs have ended that
 * way (Issue #4298). The issue itself stays on the `failed-once` ladder. An
 * agent invocation that could not be launched is not a gate verdict, so it is
 * reported without charging the issue a blocked run.
 *
 * A run-ending gate verdict is returned prefixed with
 * {@link SECURITY_FIX_GATE_MARKER} so quoted agent test text cannot reclassify
 * it; the launch-failure reason stays unmarked so it classifies on its own
 * launch-error text (Issue #3454).
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
  let block: SecurityFixGateBlock | undefined;
  try {
    block = await persistVerdict(ctx, state, deps, countsAsBlockedRun);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isHostDiskFaultText(message)) throw err;
    return {
      category: "internal_error",
      status: "failure",
      reason: message,
    };
  }
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

  if (countsAsBlockedRun && block && shouldFileGateBug(block.blockCount)) {
    await fileGateBug(ctx, deps, block, comment);
  }

  return {
    category: countsAsBlockedRun ? "security_fix_gate" : "unknown",
    status: "failure",
    reason: countsAsBlockedRun
      ? `${SECURITY_FIX_GATE_MARKER}: ${comment}`
      : `${reasonPrefix}${comment}`,
  };
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
  let block: SecurityFixGateBlock | undefined;
  try {
    block = await persistVerdict(ctx, state, deps, false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isHostDiskFaultText(message)) throw err;
    return {
      category: "internal_error",
      status: "failure",
      reason: message,
    };
  }
  if (!block) {
    return {
      category: "unknown",
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
    logger.warn(
      `Security-fix gate retry invocation failed: ${retryResult.error.message}`,
    );
    // A host-disk stop is not a gate verdict. reportBlock would persist one
    // and return category unknown, which charges the issue (Issue #4360).
    const hostDisk = hostDiskInfrastructureFailure(retryResult.error.message);
    if (hostDisk) return hostDisk;
    // Any other launch failure is not a second gate verdict, so it is
    // reported without charging the issue a blocked run.
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
