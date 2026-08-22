/**
 * Issue worker orchestrator — chains the per-phase modules under lib/phases/.
 *
 * The pipeline is: setup → clarity → baseline quality → execute Claude
 * → (handle no changes | quality gate → completion). Each phase lives
 * in its own module and is independently testable via dependency
 * injection through WorkerDeps. This file only stitches the phases
 * together and records per-phase timings.
 *
 * Shared types (`IssueContext`, `PhaseState`, `PhaseResult`,
 * `WorkOnIssueResult`) live in `issue_worker_types.ts` and are re-
 * exported from here for backwards compatibility with existing call
 * sites.
 *
 * Issue #965: Part of the Deno worker orchestration migration (#918).
 * Issue #1527: Split into per-phase modules so each file stays small.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { stopHeartbeat } from "./heartbeat.ts";
import { startPhaseProgress } from "./phase_progress.ts";
import { recordStepDuration } from "./cycle_timings.ts";
import {
  deriveRunOutcome,
  expectedNoPrOutcome,
  type RunOutcome,
} from "./run_outcome.ts";
import { deleteResumeState } from "./resume_state_store.ts";
import {
  handOffAnalysisOnly,
  hasAnalysisOnlyMarker,
} from "./analysis_only_handoff.ts";
import { isAdminOnlyRepoSettingsIssue } from "./admin_only_finding.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import {
  detectSuspiciousImageFlag,
  handOffSuspiciousImage,
} from "./suspicious_image_handoff.ts";
import {
  detectCrossRepoPrDeclaration,
  handOffCrossRepoPr,
} from "./cross_repo_pr_handoff.ts";
import {
  isLegacyInRepoConfigPresent,
  LEGACY_IN_REPO_CONFIG_WARNING,
} from "./legacy_in_repo_config_warning.ts";
import { saveSession } from "./session_manager.ts";
import { stripReservedLabelsFromModelFollowUp } from "./escape_hatch_label_strip.ts";
import {
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "./write_repo_allowlist.ts";
import {
  resetClaimedIssueGuard,
  seedClaimedIssueGuard,
} from "./claimed_issue_guard.ts";
import { listTemplates } from "./idle_task_template.ts";
// Importing the security-scan template ensures it is registered when
// the idle-task pre-flight check below consults the registry. Issue
// #2398 added the supply-chain-readiness side-effect import alongside
// it so listTemplates() sees the fifth template even when the claim
// handler has not been imported first. Issue #2930 added the four Boy
// Scout templates so the pre-flight check sees them too.
import "./idle_task_templates/security_scan_template.ts";
import "./idle_task_templates/supply_chain_readiness_template.ts";
import "./idle_task_templates/orphan_deps_template.ts";
import "./idle_task_templates/dead_code_template.ts";
import "./idle_task_templates/doc_coverage_template.ts";
import "./idle_task_templates/format_drift_template.ts";
import "./idle_task_templates/deprecated_api_template.ts";
import "./idle_task_templates/bash_script_refs_template.ts";

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
  WorkOnIssueResult,
} from "./issue_worker_types.ts";

import { workOnIssueMergedPrPrecheck } from "./phases/merged_pr_precheck_phase.ts";
import { workOnIssueSetupBranch } from "./phases/setup_branch_phase.ts";
import { workOnIssueClarityPhase } from "./phases/clarity_assessment_phase.ts";
import { workOnIssueBaselineQuality } from "./phases/baseline_quality_phase.ts";
import { workOnIssueExecuteClaude } from "./phases/execute_phase.ts";
import { workOnIssueHandleNoChanges } from "./phases/handle_no_changes_phase.ts";
import { workOnIssueQualityGate } from "./phases/quality_gate_remediation_phase.ts";
import { workOnIssueBumpDeps } from "./phases/bump_deps_phase.ts";
import { workOnIssueCompletion } from "./phases/completion_phase.ts";

// Re-export shared types so existing call sites that import from
// issue_worker.ts keep working after the split (Issue #1527).
export type {
  IssueContext,
  PhaseResult,
  PhaseState,
  WorkOnIssueResult,
} from "./issue_worker_types.ts";

// Re-export phase functions so existing tests and commands that import
// from issue_worker.ts keep working after the split (Issue #1527).
export {
  workOnIssueBaselineQuality,
  workOnIssueBumpDeps,
  workOnIssueClarityPhase,
  workOnIssueCompletion,
  workOnIssueExecuteClaude,
  workOnIssueHandleNoChanges,
  workOnIssueMergedPrPrecheck,
  workOnIssueQualityGate,
  workOnIssueSetupBranch,
};

/**
 * Main orchestrator — chains all phases in sequence.
 *
 * Claims the issue, runs each phase, handles inter-phase errors,
 * and records timing for each phase.
 */
export async function workOnIssue(
  ctx: IssueContext,
  deps: WorkerDeps,
): Promise<WorkOnIssueResult> {
  const startedAtMs = Date.now();
  const state: PhaseState = {
    branchName: "",
    baseBranch: "",
    defaultBranch: "",
    repoPath: "",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  let outcome: RunOutcome | undefined;
  try {
    const result = await workOnIssueCore(ctx, deps, state);
    // The run outcome travels to the claim-release comment (Issue #4325):
    // the PR the completion phase raised or recovered, or the diagnosed
    // failure, or a deliberate no-PR. Derived once, here, from the result
    // every terminal return produced — no per-return plumbing to forget.
    outcome = result.outcome ?? deriveRunOutcome({
      success: result.success,
      phase: result.phase,
      reason: result.reason,
      timings: result.timings,
      prUrl: state.prUrl,
      prNumber: state.prNumber,
      elapsedSeconds: (Date.now() - startedAtMs) / 1000,
    });
    return { ...result, outcome };
  } catch (err) {
    outcome = deriveRunOutcome({
      success: false,
      phase: "unknown",
      reason: err instanceof Error ? err.message : String(err),
      elapsedSeconds: (Date.now() - startedAtMs) / 1000,
    });
    throw err;
  } finally {
    // The heartbeat's final clear carries the outcome (Issue #4330), so the
    // release comment states it even before the claim-release path runs.
    if (state.heartbeatHandle) {
      await stopHeartbeat(state.heartbeatHandle, outcome);
    }
  }
}

async function workOnIssueCore(
  ctx: IssueContext,
  deps: WorkerDeps,
  state: PhaseState,
): Promise<WorkOnIssueResult> {
  const timings: Record<string, number> = {};

  const logger = deps.logger;

  // Issue #3311 — egress containment. Seed the per-run write-repo allowlist
  // with this issue's own target repo before any GitHub write. Every
  // subsequent worker `gh` write is validated against this allowlist at the
  // shared chokepoint (runGhCommandRaw); an off-allowlist write is refused.
  seedWriteRepoAllowlist(ctx.repo);

  // Issue #222 — issue-lifecycle containment. The agent this run spawns may
  // comment on and label the claimed issue, but closing/reopening/locking it
  // is the worker's or a human's call. Seeding here bakes the refusal into the
  // agent's `gh` guard shim for the whole run.
  seedClaimedIssueGuard(ctx.repo, ctx.issueNumber);

  /** Run a single phase with timing. */
  async function runPhase(
    name: string,
    fn: () => Promise<PhaseResult>,
  ): Promise<PhaseResult> {
    const start = Date.now();
    // Phase heartbeat (Issue #4305): a long clone, baseline gate, or
    // quality run used to be a silent stretch in the worker log —
    // observed live as 43+ minutes with no line after `Processing
    // issue …`. Every phase now logs start/heartbeat/completion, so a
    // wedged phase shows as a stopped heartbeat, not a silent log.
    const progress = startPhaseProgress({
      label: `${name} (${ctx.repo}#${ctx.issueNumber})`,
      log: (message) => logger.info(message),
    });
    try {
      const result = await fn();
      timings[name] = (Date.now() - start) / 1000;
      // Issue #4299: per-issue phase wall time feeds the cycle table.
      recordStepDuration(`phase-${name}`, Date.now() - start);
      progress.done(result.status);
      return result;
    } catch (err) {
      timings[name] = (Date.now() - start) / 1000;
      recordStepDuration(`phase-${name}`, Date.now() - start);
      progress.done("threw");
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Phase ${name} threw an unexpected error`, {
        error: message,
      });
      return {
        status: "failure",
        reason: `Unexpected error in ${name}: ${message}`,
      };
    }
  }

  // Issue #2083 defence-in-depth, extended by #2087: refuse to enter
  // the standard issue-worker pipeline for any issue that is a genuine
  // idle-task scan *wrapper*. A wrapper is identified by two signals:
  // a title match against a registered template, or a body fingerprint
  // via `matchesIdleTaskBody`. The claim handler should have routed
  // these to the template runner already — if execution reaches this
  // orchestrator, the routing missed and continuing would let the
  // standard flow raise a PR (or post a Partial Answer, as seen in
  // Issue #2087 against VibeCoder#2086) from a "Must not modify the
  // codebase" prompt. Fail loud instead.
  //
  // The bare `idle-task` LABEL is deliberately NOT a guard signal:
  // `idle-task` is just the lowest work-trigger priority, so a plain
  // `idle-task` finding or work item is meant to run through this
  // standard pipeline. All ten scan templates implement
  // `matchesIdleTaskBody`, so a real wrapper is still caught here by
  // its body even if its title was mangled.
  const wantedTitle = ctx.issueTitle.trim();
  const registeredTemplates = listTemplates();
  const matchesIdleTaskTitle = registeredTemplates.some(
    (t) => t.buildIssueTitle(ctx.repo).trim() === wantedTitle,
  );
  const matchesIdleTaskBody = registeredTemplates.some(
    (t) => t.matchesIdleTaskBody?.(ctx.issueBody) === true,
  );
  if (matchesIdleTaskTitle || matchesIdleTaskBody) {
    logger.warn(
      "Refusing to run standard issue pipeline on an idle-task wrapper",
      {
        repo: ctx.repo,
        issueNumber: ctx.issueNumber,
        issueTitle: ctx.issueTitle,
        matchesIdleTaskTitle,
        matchesIdleTaskBody,
      },
    );
    // Deactivate the allowlist seeded above before the early return so it
    // does not leak into the main loop (Issue #3311).
    resetWriteRepoAllowlist();
    resetClaimedIssueGuard();
    return {
      success: false,
      phase: "idle_task_guard",
      reason: "Issue is an idle-task scan wrapper (title or body match) — " +
        "refused to run the standard pipeline. The claim handler should " +
        "have routed this to the template runner.",
      timings,
    };
  }

  try {
    // Phase 0 — Merged PR pre-flight check (Issue #1560)
    // Skips all downstream work when a merged PR already resolves the issue.
    const precheckResult = await runPhase(
      "merged_pr_precheck",
      () => workOnIssueMergedPrPrecheck(ctx, state, deps),
    );
    if (precheckResult.status === "failure") {
      return {
        success: false,
        phase: "merged_pr_precheck",
        reason: precheckResult.reason,
        timings,
      };
    }
    if (precheckResult.status === "early_exit") {
      // Issue #175: a pre-check that could not resolve the issue (the PR
      // merged but the change never landed) is a bounce, not a success. It
      // is reported as an expected skip so the main loop records the retry
      // cooldown and leaves it out of the processed-issue count, instead of
      // freeing the slot for the very same issue on the next scan.
      const expectedSkip = precheckResult.expectedSkip === true;
      return {
        success: !expectedSkip,
        ...(expectedSkip ? { expectedSkip: true } : {}),
        phase: "merged_pr_precheck",
        reason: precheckResult.reason,
        timings,
        // A bounce raised no PR by design — keep it out of the failure
        // diagnosis so the claim-release comment states it plainly.
        ...(expectedSkip
          ? {
            outcome: expectedNoPrOutcome(
              "merged_pr_precheck",
              precheckResult.reason,
            ),
          }
          : {}),
      };
    }

    // Issue #2849 — up-front analysis-only / no-PR hand-off.
    // When the issue body declares itself analysis-only via the
    // `<!-- analysis-only -->` marker, `work-on` has no PR to raise as
    // its completion signal, so it would re-pick-up and re-run the issue
    // indefinitely (the #2834 loop). Hand off to `needs-human` before
    // cloning the repo or running Claude. This is the up-front detection
    // signal; the post-run signal (no code changes) is handled in the
    // handle-no-changes phase. A clean hand-off is NOT a failure.
    if (hasAnalysisOnlyMarker(ctx.issueBody)) {
      logger.info(
        "Analysis-only marker present — handing off to needs-human before running Claude",
        { repo: ctx.repo, issueNumber: ctx.issueNumber },
      );
      await runPhase("analysis_only_handoff", async () => {
        const ghClient = deps.github.createClient(logger);
        await handOffAnalysisOnly({
          ghClient,
          repo: ctx.repo,
          issueNumber: ctx.issueNumber,
          needsHumanLabel: ctx.config.needsHumanLabel,
          githubUser: ctx.githubUser,
          trigger: "marker",
          logger,
          deps: { ensureLabelExists: deps.github.ensureLabelExists },
        });
        return { status: "early_exit", reason: "analysis_only_marker" };
      });
      return {
        success: true,
        phase: "analysis_only_handoff",
        reason: "analysis_only_marker",
        timings,
      };
    }

    // Issue #53 — up-front hand-off for a repository-admin finding.
    // `repo_settings_scanner.ts` files `BP-REPO-*` findings whose fix is a
    // settings change only an admin can make. If a human bulk-triaged one to
    // `work-on`, running the agent changes nothing and completion fails "no
    // commits ahead", releasing the claim so the still-`work-on` issue loops
    // back into the pool forever. Recognise it from its body and hand it to a
    // human before cloning the repo or running Claude. A clean hand-off is not
    // a failure.
    if (isAdminOnlyRepoSettingsIssue(ctx.issueBody)) {
      logger.info(
        "Repository-admin finding — handing off to needs-human before running Claude (Issue #53)",
        { repo: ctx.repo, issueNumber: ctx.issueNumber },
      );
      await runPhase("admin_only_handoff", async () => {
        await escalateToHuman({
          ghClient: deps.github.createClient(logger),
          repo: ctx.repo,
          target: { kind: "issue", number: ctx.issueNumber },
          needsHumanLabel: ctx.config.needsHumanLabel,
          heading: "Repository-admin action required",
          reason:
            "This finding's fix is a repository settings change that only a " +
            "repository admin can make — the worker cannot change repository " +
            "settings, so an agent run would change nothing and fail at " +
            "completion. Handing off rather than looping on it.",
          nextStep:
            "A repository admin should apply the change described in the " +
            "issue's Suggested fix, then close the issue.",
          dedupKey: `admin-only-${ctx.issueNumber}`,
          githubUser: ctx.githubUser,
          deps: {
            github: { ensureLabelExists: deps.github.ensureLabelExists },
          },
          logger,
        });
        return { status: "early_exit", reason: "admin_only_finding" };
      });
      return {
        success: true,
        phase: "admin_only_handoff",
        reason: "admin_only_finding",
        timings,
      };
    }

    // Phase 1 — Setup Branch
    const setupResult = await runPhase(
      "setup",
      () => workOnIssueSetupBranch(ctx, state, deps),
    );
    if (setupResult.status === "failure") {
      return {
        success: false,
        phase: "setup",
        reason: setupResult.reason,
        timings,
      };
    }
    if (setupResult.status === "early_exit") {
      return {
        success: false,
        phase: "setup",
        reason: setupResult.reason,
        timings,
      };
    }

    // In-repo `.vibecoder.json` configuration was removed (Issue #2626) — a
    // config channel from repo content into worker behaviour is a steering
    // surface. Per-repo configuration is operator-side only, in `.config.json`
    // `repo_config`. A leftover file is ignored with one informative warning.
    if (state.repoPath && await isLegacyInRepoConfigPresent(state.repoPath)) {
      logger.warn(LEGACY_IN_REPO_CONFIG_WARNING, { repo: ctx.repo });
    }

    // Phase 2 — Clarity Assessment
    const clarityResult = await runPhase(
      "clarity",
      () => workOnIssueClarityPhase(ctx, state, deps),
    );
    if (clarityResult.status === "failure") {
      return {
        success: false,
        phase: "clarity",
        reason: clarityResult.reason,
        timings,
      };
    }
    if (clarityResult.status === "early_exit") {
      return {
        success: true,
        phase: "clarity",
        reason: clarityResult.reason,
        timings,
      };
    }

    // Phase 2b — Baseline Quality Check (Issue #1183)
    const baselineResult = await runPhase(
      "baseline_quality",
      () => workOnIssueBaselineQuality(ctx, state, deps),
    );
    if (baselineResult.status === "failure") {
      return {
        success: false,
        phase: "baseline_quality",
        reason: baselineResult.reason,
        timings,
      };
    }

    // Phase 3 — Execute Claude
    const executeResult = await runPhase(
      "execute",
      () => workOnIssueExecuteClaude(ctx, state, deps),
    );

    // Save session to the correct work stream after Claude execution (Issue #1322)
    await saveSession(
      state.repoPath,
      ctx.config.workDir,
      ctx.repo,
      undefined,
      ctx.milestoneNumber,
    );

    // Issue #3389 — GhostCommit detect-and-flag. Before acting on anything
    // Claude produced, check whether the agent flagged a suspicious untrusted
    // image during its turn (the standing #3388 rule tells it to emit the
    // documented marker and stop rather than obey the image). On a positive
    // detection the worker must NOT act on the image's content and must NOT
    // raise a PR: hand the issue off to `needs-human` via the guarded
    // `escalateToHuman` chokepoint (Issue #1471) and stop. Checked before the
    // execute-status branches so a flag always wins, even if Claude also made
    // partial changes. Trusted worker-authored evidence screenshots are never
    // flagged (provenance is enforced in the prompt), so this never fires for
    // them.
    const suspiciousImage = detectSuspiciousImageFlag(state.claudeOutput);
    if (suspiciousImage.flagged) {
      logger.warn(
        "Suspicious untrusted image flagged by the agent — handing off to needs-human, not acting on the image",
        {
          repo: ctx.repo,
          issueNumber: ctx.issueNumber,
          source: suspiciousImage.source,
        },
      );
      await runPhase("suspicious_image_handoff", async () => {
        const ghClient = deps.github.createClient(logger);
        await handOffSuspiciousImage({
          ghClient,
          repo: ctx.repo,
          issueNumber: ctx.issueNumber,
          needsHumanLabel: ctx.config.needsHumanLabel,
          githubUser: ctx.githubUser,
          detection: suspiciousImage,
          logger,
          deps: { ensureLabelExists: deps.github.ensureLabelExists },
        });
        return { status: "early_exit", reason: "suspicious_image_flagged" };
      });
      return {
        success: true,
        phase: "suspicious_image_handoff",
        reason: "suspicious_image_flagged",
        timings,
      };
    }

    // Issue #182 — cross-repo dependency-PR bridge. The guidelines require a
    // root cause in an internal `stSoftwareAU/*` dependency to be fixed there
    // with a PR in that repo, but the agent's `gh` guard only allows writes to
    // the claim repo, so `gh pr create --repo stSoftwareAU/<dep>` is refused
    // and the fix strands on an unreferenced branch (GRQ#4206 burned two runs
    // on it). The agent instead pushes the branch and declares the PR; the
    // worker validates the target and opens it here, behind a grant scoped to
    // that single write. Runs whatever the execute status: the dependency PR
    // can be the entire deliverable, with no change in the consuming repo. It
    // never terminates the run — the consuming repo's own PR still follows.
    const crossRepoPr = detectCrossRepoPrDeclaration(state.claudeOutput);
    if (crossRepoPr.status !== "none") {
      await runPhase("cross_repo_pr_handoff", async () => {
        await handOffCrossRepoPr({
          ghClient: deps.github.createClient(logger),
          repo: ctx.repo,
          issueNumber: ctx.issueNumber,
          needsHumanLabel: ctx.config.needsHumanLabel,
          githubUser: ctx.githubUser,
          detection: crossRepoPr,
          logger,
          deps: { ensureLabelExists: deps.github.ensureLabelExists },
        });
        return { status: "continue" };
      });
    }

    // Issue #3708 (SEC-6403af1e8b72) — the issue-work escape hatch also lets
    // Claude file (and label) its own follow-up issue, and this path had no
    // post-hoc strip at all. Run it on Claude's own output, whatever the
    // execute status: a hand-off can accompany changes as easily as none.
    // A reference to *this* issue is a self-reference, not a follow-up, so it
    // is excluded — the run must never strip a human-applied `work-on` from
    // the issue it is working on. The cross-repo target stays the current-repo
    // secure default, matching the write-repo allowlist seeded for this run
    // (Issue #3311). Non-fatal; a failed strip is logged loudly.
    await runPhase("follow_up_label_strip", async () => {
      const stripResult = await stripReservedLabelsFromModelFollowUp({
        message: state.claudeOutput,
        currentRepo: ctx.repo,
        excludeIssueNumber: ctx.issueNumber,
        ghClient: deps.github.createClient(logger),
        logger,
      });
      if (!stripResult.ok) {
        logger.error(
          "Reserved-label strip did not apply to the issue-work follow-up — " +
            "it may still carry a reserved label (Issue #3708)",
          {
            repo: ctx.repo,
            issueNumber: ctx.issueNumber,
            error: stripResult.error.message,
          },
        );
      }
      return { status: "continue" };
    });

    if (executeResult.status === "failure") {
      return {
        success: false,
        phase: "execute",
        reason: executeResult.reason,
        timings,
      };
    }
    if (executeResult.status === "early_exit") {
      // No changes — delegate to handle-no-changes phase
      if (executeResult.reason === "no_changes") {
        const noChangesResult = await runPhase(
          "handle_no_changes",
          () => workOnIssueHandleNoChanges(ctx, state, deps),
        );
        if (noChangesResult.status === "failure") {
          return {
            success: false,
            phase: "handle_no_changes",
            reason: noChangesResult.reason,
            timings,
          };
        }
        const noChangesReason = noChangesResult.status === "early_exit"
          ? noChangesResult.reason
          : "no_changes_handled";
        return {
          success: true,
          phase: "handle_no_changes",
          reason: noChangesReason,
          timings,
        };
      }
      return {
        success: true,
        phase: "execute",
        reason: executeResult.reason,
        timings,
        // A phase that decided its own outcome keeps it (Issue #218): the
        // superseded-by-a-merged-PR stop names the PR that resolved the
        // issue, which cannot be derived from success/reason alone.
        ...(executeResult.outcome ? { outcome: executeResult.outcome } : {}),
      };
    }

    // Phase 3.5 — Dependency bump (Issue #1613)
    // Runs the per-repo `bump-deps.sh` (when present) before the
    // quality gate. No-op when the script is absent, preserving
    // backwards-compatible behaviour for repos that haven't opted in.
    await runPhase("bump_deps", () => workOnIssueBumpDeps(ctx, state, deps));

    // Phase 4 — Quality Gate
    const qualityResult = await runPhase(
      "quality_gate",
      () => workOnIssueQualityGate(ctx, state, deps),
    );
    if (qualityResult.status === "failure") {
      return {
        success: false,
        phase: "quality_gate",
        reason: qualityResult.reason,
        timings,
      };
    }

    // Phase 5 — Completion
    const completionResult = await runPhase(
      "completion",
      () => workOnIssueCompletion(ctx, state, deps),
    );
    if (completionResult.status === "failure") {
      return {
        success: false,
        phase: "completion",
        reason: completionResult.reason,
        timings,
      };
    }
    // The completion phase stopped without raising a PR and without failing
    // (Issue #218) — a merged/closed PR already resolved the issue, so the
    // branch was level with its base. Report the phase's own outcome; the
    // durable resume state is deleted below only on the PR path.
    if (completionResult.status === "early_exit") {
      return {
        success: true,
        phase: "completion",
        reason: completionResult.reason,
        timings,
        ...(completionResult.outcome
          ? { outcome: completionResult.outcome }
          : {}),
      };
    }

    // The PR exists — the checkpointed work reached its destination, so
    // the durable resume state is finished with (Issue #4170).
    await deleteResumeState(ctx.config.workDir, ctx.repo, ctx.issueNumber);

    return {
      success: true,
      phase: "completion",
      reason: "Issue processed successfully",
      timings,
    };
  } finally {
    // The heartbeat is stopped by the workOnIssue wrapper, with the run
    // outcome (Issue #4330).
    // Issue #3311 — deactivate the write-repo allowlist so enforcement does
    // not leak into the main loop's legitimate cross-repo maintenance
    // (which is re-seeded per run when the next issue is claimed).
    resetWriteRepoAllowlist();
    // Issue #222 — same for the claimed-issue lifecycle guard.
    resetClaimedIssueGuard();
  }
}
