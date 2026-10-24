/**
 * Declared-handoff phase (Issue #3088).
 *
 * `work-on` can commit code AND, in the same final message, declare a
 * hand-off — a `## Blocked:` dependency, a `vibe-defer-until` time
 * deferral, or a `<!-- vibe-needs-planning -->` planning request. Those
 * signals were previously only detected by the no-changes phase, which only
 * runs when the execute phase makes no commits at all — so a run that both
 * committed code and declared a hand-off slipped straight through to
 * `bump_deps` → `quality_gate` → `completion`, raising a `Closes #N` PR that
 * closed the very issue the agent asked to defer or hand off.
 *
 * This phase runs after a commit-producing execute phase and before
 * `bump_deps`, applying the same `handOffDeclaredOutcome` detection/apply
 * logic used by the no-changes phase. A detected-but-unhandled signal (a
 * guard — repeat deferral, repeat planning request, missing anchor label,
 * image gate — fell through) is retried with its branch pushed (Issue
 * #4227), rather than allowed to continue to completion or handed to a human.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { retryUnfinishedIssue } from "../unfinished_issue_retry.ts";
import { redactedTail } from "../redacted_text.ts";
import {
  handOffDeclaredOutcome,
  pushCommittedBranchForHandoff,
} from "./declared_handoff.ts";

export async function workOnIssueDeclaredHandoff(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const outcome = await handOffDeclaredOutcome(
    ctx,
    state,
    deps,
    "declared_handoff",
  );
  if (outcome.result) return outcome.result;

  if (outcome.declared) {
    const failed = await pushCommittedBranchForHandoff(state, deps);
    if (failed) return failed;
    // Issue #4227: the branch is pushed, so the retry resumes the committed
    // work; the approved issue is never handed to a human.
    return await retryUnfinishedIssue({
      ghClient: deps.github.createClient(deps.logger),
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      why:
        "it committed work but declared a hand-off the worker could not honour",
      agentOutput: state.claudeOutput,
      diagnostics: {
        clarityStatus: state.clarityStatus,
        outputSize: state.claudeOutput.length,
        lastOutputSnippet: redactedTail(state.claudeOutput, 500) || undefined,
      },
      logger: deps.logger,
    });
  }

  return { status: "continue" };
}
