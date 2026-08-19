/**
 * Phase 4 — Quality Gate (with remediation).
 *
 * Runs the quality gate once, and if it fails, invokes Claude with a
 * fix prompt and reruns. Bounded to two attempts: the initial run plus
 * one remediation cycle. Reports a detailed failure (with baseline
 * context) if the gate still fails after the fix attempt. Single
 * responsibility: ensure quality passes or record a diagnostic failure.
 *
 * Extracted from worker/deno/lib/issue_worker.ts (Issue #1527).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { formatQualityFailureMessage } from "../quality_helpers.ts";
import { formatDetailedFailureMessage } from "../failure_message.ts";
import {
  detectFailureCategory,
  isInfrastructureFailure,
} from "../failure_diagnosis.ts";
import { shouldRetryInfrastructureFailure } from "../infra_retry.ts";
import { isBaselineAwareQualityGateEnabled } from "../baseline_aware_gate.ts";
import { decideGateBypass, formatCarryoverFindings } from "../baseline_gate.ts";
import { formatBaselineCarryoverNote } from "../quality_helpers.ts";
import { fenceQualityOutput } from "../untrusted_quality_output.ts";
import { buildBoundaryIntegrityInstruction } from "../prompt_delimiter.ts";

/**
 * Result of a single quality-gate body pass — see `runQualityGateBody`.
 *
 * The body intentionally does NOT call `handleIssueFailure`. That call is
 * made only by the outer `workOnIssueQualityGate` after the in-process
 * infrastructure retry has been exhausted (Issue #1550).
 */
interface QualityGateBodyResult {
  phaseResult: PhaseResult;
  /**
   * If the quality gate ultimately failed, this is the raw quality-output
   * failure message (not the formatted reason) that should be passed to
   * `handleIssueFailure`. `undefined` when the phase succeeded or when the
   * failure is not from the quality gate itself (e.g. runQualityGate errored).
   */
  qualityFailureMessage?: string;
}

/** Characters of quality output carried into the fix prompt. */
const FIX_PROMPT_OUTPUT_CHARS = 2000;

/**
 * Build the Claude fix prompt from failing `quality.sh` output (Issue #3706,
 * SEC-9ba5e2c704f1).
 *
 * The output tail used to be interpolated raw — no delimiter scrub, no secret
 * redaction, no fence — even though it is produced by tests, linters and build
 * tools on the branch under repair and routinely echoes credentials. It now
 * goes through the same chokepoint as the shell-driven remediation prompt, and
 * the boundary-integrity instruction naming this run's nonce is appended so the
 * fenced span is explicitly covered.
 *
 * The worker-authored framing (the focused new-findings override, the "fix all
 * failing checks" instruction) stays outside the fence — it is task
 * instruction, not data.
 *
 * @param qualityOutput - Raw stdout/stderr from the failing quality script
 * @param newFindingsPromptOverride - Focused findings framing, when available
 * @param boundaryId - Optional fixed boundary id (tests only)
 * @returns The fix prompt
 */
export function buildQualityFixPrompt(
  qualityOutput: string,
  newFindingsPromptOverride = "",
  boundaryId?: string,
): string {
  const { block, boundaryId: usedId } = fenceQualityOutput(
    qualityOutput.slice(-FIX_PROMPT_OUTPUT_CHARS),
    boundaryId,
  );
  const integrity = buildBoundaryIntegrityInstruction(usedId);

  if (newFindingsPromptOverride) {
    return `${newFindingsPromptOverride}

Full quality output for context (last ${FIX_PROMPT_OUTPUT_CHARS} chars):

${block}

${integrity}`;
  }

  return `The quality checks failed. The output is below.

${block}

Please fix all failing quality checks. Do not modify any test files unless they are testing code you changed.

${integrity}`;
}

/**
 * Run quality checks and attempt remediation if they fail.
 *
 * Runs the quality gate, and if it fails, runs Claude again with
 * fix instructions. Retries up to a configurable maximum.
 *
 * Issue #1550: Wraps the phase body with a bounded in-process retry for
 * infrastructure-category failures. Only invokes `handleIssueFailure`
 * after the retry has been exhausted (or was not applicable), so a
 * transient infrastructure blip on the first attempt does not apply the
 * `failed-once` label.
 */
export async function workOnIssueQualityGate(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  let { phaseResult, qualityFailureMessage } = await runQualityGateBody(
    ctx,
    state,
    deps,
  );

  if (phaseResult.status === "failure") {
    // Only infrastructure-category quality failures qualify for the extra
    // in-process retry — real quality-check failures are not retried.
    const category = detectFailureCategory(
      qualityFailureMessage ?? phaseResult.reason,
    );
    if (isInfrastructureFailure(category)) {
      const shouldRetry = await shouldRetryInfrastructureFailure(
        "quality_gate",
        qualityFailureMessage ?? phaseResult.reason,
        state,
        deps.logger,
        { backoffMs: ctx.config.infraRetryBackoffMs },
      );
      if (shouldRetry) {
        ({ phaseResult, qualityFailureMessage } = await runQualityGateBody(
          ctx,
          state,
          deps,
        ));
      }
    }
  }

  // Issue #1613: Dependency-bump audit gate. If the gate has ultimately
  // failed and a `bump-deps.sh` bump was applied earlier in the pipeline,
  // revert the bump and re-run the gate once. If quality only passes
  // without the bump, the substantive change still ships — the bump is
  // recorded as `rejected_by_audit` for the completion phase to surface
  // via PR comment.
  if (
    phaseResult.status === "failure" &&
    state.bumpInfo?.status === "applied"
  ) {
    const auditResult = await attemptBumpAudit(state, deps);
    if (auditResult !== null) {
      phaseResult = auditResult;
      qualityFailureMessage = undefined;
    }
  }

  if (phaseResult.status === "failure" && qualityFailureMessage !== undefined) {
    await deps.github.handleIssueFailure({
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      githubUser: ctx.githubUser,
      failureMessage: qualityFailureMessage,
      labels: {
        failedLabel: ctx.config.failedLabel,
        failedOnceLabel: ctx.config.failedOnceLabel,
        // Issue #2031: clarification handoff is via needs-human.
        needsHumanLabel: ctx.config.needsHumanLabel,
        planningLabel: ctx.config.planningLabel,
        questionLabel: ctx.config.questionLabel,
      },
    });
  }

  return phaseResult;
}

/**
 * Attempt the bump-deps audit gate (Issue #1613).
 *
 * Reverts the bump commit by `git reset --hard` to the SHA captured in
 * `state.bumpInfo.beforeBumpSha`, re-runs `quality.sh` once, and:
 *
 * - On pass — flips `state.bumpInfo.status` to `rejected_by_audit`,
 *   records a rejection reason, and returns `{ status: "continue" }`
 *   so the substantive (pre-bump) change still ships.
 * - On fail — restores the original HEAD via `git reset --hard` and
 *   returns `null` so the caller proceeds with normal failure handling.
 *
 * Returns `null` if the audit cannot run (no `beforeBumpSha`, reset
 * fails, etc.) so the calling failure path stays intact.
 */
async function attemptBumpAudit(
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult | null> {
  const logger = deps.logger;
  const bumpInfo = state.bumpInfo;
  if (!bumpInfo || bumpInfo.status !== "applied" || !bumpInfo.beforeBumpSha) {
    return null;
  }

  // Capture HEAD now so we can restore on a failed audit. May include
  // Claude's remediation commits added on top of the bump.
  const currentHead = await deps.git.runGitCommand(
    ["rev-parse", "HEAD"],
    { cwd: state.repoPath },
  );
  if (!currentHead.ok) {
    logger.warn("bump audit: cannot capture current HEAD, skipping audit", {
      error: currentHead.error.message,
    });
    return null;
  }
  const restoreSha = currentHead.value.stdout.trim();

  logger.info("bump audit: reverting bump and re-running quality gate", {
    beforeBumpSha: bumpInfo.beforeBumpSha,
    currentHead: restoreSha,
  });

  // Drop the bump (and any later commits) for the audit run.
  const reset = await deps.git.runGitCommand(
    ["reset", "--hard", bumpInfo.beforeBumpSha],
    { cwd: state.repoPath },
  );
  if (!reset.ok) {
    logger.warn("bump audit: reset --hard failed, skipping audit", {
      error: reset.error.message,
    });
    return null;
  }

  // Re-run quality once — no remediation, no auto-fix. We only need a
  // pass/fail signal to attribute the failure to the bump or not.
  const recheck = await deps.quality.runQualityGate({
    scriptDir: state.repoPath,
    options: { strict: false, sequential: false, validatePrompts: false },
  });

  const passedWithoutBump = recheck.ok && recheck.value.passed;

  if (passedWithoutBump) {
    logger.warn(
      "bump audit: quality passes without the bump — accepting reverted state",
      { files: bumpInfo.files.length },
    );
    state.bumpInfo = {
      ...bumpInfo,
      status: "rejected_by_audit",
      rejectionReason:
        "Quality gate failed with the bump applied but passed once it was reverted. The bump has been dropped from this PR.",
    };
    return { status: "continue" };
  }

  // Audit did not exonerate the bump. Restore the original HEAD so the
  // caller's failure-reporting machinery sees the same tree it would
  // have seen without the audit.
  logger.info("bump audit: quality still fails without bump, restoring HEAD");
  const restore = await deps.git.runGitCommand(
    ["reset", "--hard", restoreSha],
    { cwd: state.repoPath },
  );
  if (!restore.ok) {
    logger.warn("bump audit: failed to restore HEAD after audit", {
      error: restore.error.message,
    });
  }
  return null;
}

/**
 * Single-pass quality gate logic — runs the gate and one Claude fix attempt
 * if the first run fails. Returns the phase outcome plus, when the gate
 * itself failed, the raw quality-output failure message for
 * `handleIssueFailure`. Does NOT call `handleIssueFailure` itself; that is
 * the outer wrapper's responsibility (Issue #1550).
 */
async function runQualityGateBody(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<QualityGateBodyResult> {
  const { repo, config } = ctx;
  const logger = deps.logger;
  const maxAttempts = 2; // Initial check + 1 fix attempt

  // Holds a focused Claude retry prompt when the post-Claude run only
  // introduced specific new diffable findings versus the baseline
  // (Issue #1549). When non-empty, supplied to Claude in place of the
  // raw quality output so Claude focuses on what it actually broke.
  let newFindingsPromptOverride = "";
  // Captures the diff carryover for the failure message when the gate
  // ultimately fails — helps reviewers see what was pre-existing.
  let lastDiffCarryover = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const qualityResult = await deps.quality.runQualityGate({
      scriptDir: state.repoPath,
      options: { strict: false, sequential: false, validatePrompts: false },
    });

    if (!qualityResult.ok) {
      return {
        phaseResult: {
          status: "failure",
          reason: `Quality gate error: ${qualityResult.error.message}`,
        },
      };
    }

    if (qualityResult.value.passed) {
      logger.info("Quality gate passed", { attempt });
      return { phaseResult: { status: "continue" } };
    }

    // Generic baseline-aware bypass (Issue #2604): when every current
    // diffable finding (shellcheck, mermaid, markdownlint, docs) was
    // already present at baseline, treat the gate as passed so a
    // pre-existing residue in an untouched artefact does not consume a
    // `failed-once` attempt. Reasoning over ALL failing checks at once
    // also closes the shellcheck-only hole (Issue #1549): a genuinely-new
    // non-shellcheck failure is never waved through. Only invoke the
    // (subprocess-heavy) capture when the feature is enabled.
    if (isBaselineAwareQualityGateEnabled(config, repo)) {
      const failingChecks = qualityResult.value.checks
        .filter((c) => c.status === "FAILED")
        .map((c) => c.name);
      const currentFindings = await deps.quality.collectDiffableGateFindings(
        state.repoPath,
      );
      const decision = decideGateBypass(
        state.baselineGateFindings ?? [],
        currentFindings,
        failingChecks,
      );
      if (decision.bypass) {
        logger.warn(
          "Quality gate bypassed — every current diffable finding was already present on the baseline",
          {
            preExistingCount: decision.preExisting.length,
            failingChecks,
            repo,
          },
        );
        // Issue #2605: file the pre-existing breakage on its own line as a
        // deduplicated `needs-human` tracker so a human fixes it
        // independently rather than letting it silently rot. Non-fatal —
        // never blocks the bypass.
        await deps.quality.fileBaselineCarryoverTracker(
          repo,
          decision.preExisting,
          { logger },
        );
        return { phaseResult: { status: "continue" } };
      }
      lastDiffCarryover = decision.preExisting.length;
      if (decision.newFindings.length > 0) {
        // Stash the new-findings prompt so the Claude retry below uses it
        // instead of the raw quality output.
        newFindingsPromptOverride = formatCarryoverFindings(
          decision.newFindings,
        );
      }
    }

    if (attempt >= maxAttempts) {
      logger.warn("Quality gate failed after fix attempt", {
        output: qualityResult.value.output.slice(-500),
      });

      // Report failure with baseline context (Issue #1183).
      // Issue #1549: when a baseline-aware diff was computed, append a
      // distinct note that calls out which findings were pre-existing
      // versus introduced by the change so reviewers can tell at a glance.
      const carryoverNote = formatBaselineCarryoverNote(lastDiffCarryover);
      const failureMessage = formatQualityFailureMessage(
        qualityResult.value.output,
        state.baselineQualityPassed,
        state.baselineQualityOutput,
      ) + (carryoverNote ? `\n\n${carryoverNote}` : "");

      // Issue #1188 — detailed failure reason with diagnostic context
      const elapsedSeconds = state.executeStartTime > 0
        ? Math.round((Date.now() - state.executeStartTime) / 1000)
        : 0;
      const snippet = qualityResult.value.output.slice(-500);
      const detailedReason = formatDetailedFailureMessage(
        "Quality gate failed after remediation attempt",
        {
          elapsedSeconds,
          clarityStatus: state.clarityStatus,
          baselineQualityPassed: state.baselineQualityPassed,
          lastOutputSnippet: snippet || undefined,
        },
      );
      return {
        phaseResult: { status: "failure", reason: detailedReason },
        qualityFailureMessage: failureMessage,
      };
    }

    // Attempt Claude fix.
    // Issue #1549: when the baseline-aware decision identified specific
    // new shellcheck findings introduced by the current change, supply
    // ONLY those to Claude so it focuses on the regression rather than
    // pre-existing carryover.
    logger.info("Quality gate failed, running Claude fix attempt", {
      focusedOnNewFindings: newFindingsPromptOverride.length > 0,
    });
    const fixPrompt = buildQualityFixPrompt(
      qualityResult.value.output,
      newFindingsPromptOverride,
    );

    const fixResult = await deps.claude.runClaudeWithRetry(
      {
        prompt: fixPrompt,
        timeoutSeconds: config.claudeTimeout,
        killAfterSeconds: config.claudeKillAfter,
        phase: "quality_fix",
        cwd: state.repoPath,
        logger,
      },
    );

    if (!fixResult.ok) {
      logger.warn("Claude fix attempt failed", {
        error: fixResult.error.message,
      });
    }
  }

  return {
    phaseResult: { status: "failure", reason: "Quality gate loop exhausted" },
  };
}
