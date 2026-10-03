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
 * image gate — fell through) is handed to a human via `handOffAnalysisOnly`
 * rather than allowed to continue to completion.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { handOffAnalysisOnly } from "../analysis_only_handoff.ts";
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
    const logger = deps.logger;
    await handOffAnalysisOnly({
      ghClient: deps.github.createClient(logger),
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      needsHumanLabel: ctx.config.needsHumanLabel,
      githubUser: ctx.githubUser,
      trigger: "declared_handoff",
      logger,
      deps: { ensureLabelExists: deps.github.ensureLabelExists },
    });
    return { status: "early_exit", reason: "analysis_only_handed_off" };
  }

  return { status: "continue" };
}
