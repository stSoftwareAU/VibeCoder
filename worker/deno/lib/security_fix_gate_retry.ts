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
 * Pure text builders only; the orchestration lives in
 * `phases/completion_phase.ts`. Australian English throughout.
 */

import {
  buildSecurityFixGateMessage,
  type SecurityFixEvidenceKind,
} from "./security_fix_gate.ts";
import {
  buildSecurityFixGateFeedbackSection,
  type SecurityFixGateBlock,
} from "./security_fix_gate_feedback.ts";

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
