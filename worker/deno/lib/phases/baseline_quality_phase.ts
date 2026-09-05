/**
 * Phase 2b — Baseline Quality Check (Issue #1183).
 *
 * Runs the quality gate on the clean repository before Claude starts
 * so pre-existing failures can be distinguished from worker-introduced
 * ones during the post-Claude quality gate phase. Single responsibility:
 * capture the baseline outcome without blocking the pipeline.
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
import { isBaselineAwareQualityGateEnabled } from "../baseline_aware_gate.ts";
import { computeBaselineQualityCacheKey } from "../baseline_quality_cache.ts";
import type { GenericFinding } from "../baseline_gate.ts";

/**
 * Run a baseline quality check on the clean repository before Claude starts.
 *
 * Captures pre-existing quality failures so they can be distinguished from
 * worker-introduced ones during the post-Claude quality gate phase.
 * This phase is non-blocking — failures are recorded but do not prevent
 * Claude from running (Option A: continue regardless).
 *
 * When the checkout is byte-identical to one already gated (clean tree, same
 * HEAD SHA), the recorded outcome is reused instead of re-running the whole
 * suite (Issue #4283). Any ambiguity falls back to the full gate.
 */
export async function workOnIssueBaselineQuality(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const logger = deps.logger;
  const wantFindings = isBaselineAwareQualityGateEnabled(ctx.config, ctx.repo);

  try {
    const cacheKey = await computeBaselineQualityCacheKey(
      ctx.repo,
      state.repoPath,
      deps.git.runGitCommand,
    );

    if (
      cacheKey && await applyCachedBaseline(cacheKey, wantFindings, state, deps)
    ) {
      return { status: "continue" };
    }

    const gateStartedMs = Date.now();
    const qualityResult = await deps.quality.runQualityGate({
      scriptDir: state.repoPath,
      options: { strict: false, sequential: false, validatePrompts: false },
    });

    if (!qualityResult.ok) {
      logger.warn("Baseline quality check could not run", {
        error: qualityResult.error.message,
      });
      return { status: "continue" };
    }

    // What the gate costs on this repository, measured rather than assumed
    // (Issue #1138). The execute phase quotes it to the agent so it can tell
    // whether the gate fits the run budget it has left. Floored at one second
    // because a gate that ran took *some* time, and zero would read as "not
    // measured" downstream.
    state.baselineQualityDurationSeconds = Math.max(
      1,
      Math.round((Date.now() - gateStartedMs) / 1000),
    );

    if (qualityResult.value.passed) {
      state.baselineQualityPassed = true;
      state.baselineQualityOutput = "";
      logger.info("Baseline quality check passed — clean repository");
    } else {
      state.baselineQualityPassed = false;
      state.baselineQualityOutput = qualityResult.value.output;
      logger.warn(
        "Baseline quality check failed — repo has pre-existing failures",
        {
          output: qualityResult.value.output.slice(-500),
        },
      );
    }

    // Capture the generic, check-agnostic diffable findings (Issue #2604)
    // so the post-Claude gate can compute a whole-gate bypass across
    // mermaid, markdownlint, and docs. Skipped when the feature is
    // disabled. Non-fatal: a capture failure leaves the field unset and
    // the post-Claude gate simply does not bypass.
    let capturedFindings: GenericFinding[] | undefined;
    if (wantFindings) {
      try {
        capturedFindings = await deps.quality.collectDiffableGateFindings(
          state.repoPath,
        );
        state.baselineGateFindings = capturedFindings;
        logger.info("Baseline diffable gate findings captured", {
          findingCount: capturedFindings.length,
        });
      } catch (err) {
        logger.warn("Baseline diffable gate capture threw (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Record the outcome so the next issue starting from this exact tree
    // reuses it (Issue #4283). Only a gate that actually ran is recorded.
    if (cacheKey) {
      try {
        await deps.quality.writeBaselineQualityCache(cacheKey, {
          passed: state.baselineQualityPassed,
          output: state.baselineQualityOutput,
          ...(capturedFindings ? { findings: capturedFindings } : {}),
        });
      } catch (err) {
        logger.warn("Baseline quality cache write failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn("Baseline quality check threw unexpectedly (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { status: "continue" };
}

/**
 * Apply a cached baseline outcome to `state`, returning whether it was used.
 *
 * The entry is rejected when the baseline-aware gate needs diffable findings
 * the entry does not carry — a partial reuse would silently weaken the
 * post-Claude carryover comparison.
 */
async function applyCachedBaseline(
  cacheKey: string,
  wantFindings: boolean,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<boolean> {
  let cached;
  try {
    cached = await deps.quality.readBaselineQualityCache(cacheKey);
  } catch (err) {
    deps.logger.warn("Baseline quality cache read failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (!cached) return false;
  if (wantFindings && !cached.findings) return false;

  state.baselineQualityPassed = cached.passed;
  state.baselineQualityOutput = cached.output;
  if (wantFindings && cached.findings) {
    state.baselineGateFindings = cached.findings;
  }

  deps.logger.info(
    "Baseline quality check reused from cache — checkout unchanged",
    {
      cacheKey,
      passed: cached.passed,
      ageMs: Date.now() - cached.storedAt,
    },
  );
  return true;
}
