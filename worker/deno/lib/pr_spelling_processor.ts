/**
 * PR spelling fix processor (Issue #967).
 *
 * Handles fixing spelling check failures on PRs by decoding check
 * annotations, building a spelling fix prompt, running Claude to fix
 * the issues, committing changes, and replying with results.
 *
 * Migrated from work_on_spelling_failure() in issue_worker.sh.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, RepoConfig, Result } from "../types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { resolvePreFlightSpec } from "./git_push.ts";
import {
  buildSpellingFixPrompt,
  type SpellingFixPromptOptions,
} from "./prompt_builder.ts";
import { readRepoContext } from "./repo_context_reader.ts";
import {
  type HeartbeatHandle,
  startHeartbeat,
  stopHeartbeat,
} from "./heartbeat.ts";
import { preparePrBranch } from "./pr_branch_preparation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single check run annotation. */
export interface CheckAnnotation {
  /** File path. */
  path: string;
  /** Start line number. */
  start_line: number;
  /** Annotation message. */
  message: string;
}

/** Input for the spelling fix processor. */
export interface SpellingFixInput {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Head branch name. */
  branchName: string;
  /** GitHub check run ID. */
  checkRunId: string;
  /** Name of the failed check. */
  checkName: string;
  /** Base64-encoded annotations JSON. */
  encodedAnnotations: string;
}

/** Result of spelling fix processing. */
export interface SpellingFixResult {
  /** Whether processing completed successfully. */
  processed: boolean;
  /** Whether code changes were made and pushed. */
  changesPushed: boolean;
  /** Number of annotations addressed. */
  annotationCount: number;
  /** Human-readable summary. */
  summary: string;
}

/** Dependencies specific to the spelling fix processor. */
export interface SpellingProcessorDeps {
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Worker deps for cross-cutting concerns. */
  deps: WorkerDeps;
  /** Working directory for heartbeat files. */
  workDir?: string;
  /** Quality instructions for the prompt. */
  qualityInstructions?: string;
  /** Custom repo-specific instructions. */
  customInstructions?: string;
  /** Claude timeout in seconds. */
  claudeTimeout?: number;
  /**
   * Silence watchdog: kill Claude if stdout has been idle for this many
   * seconds (Issue #1825). Distinct from the hard `claudeTimeout`.
   */
  claudeNoOutputTimeout?: number;
  /** Maximum rate limit retries. */
  maxRateLimitRetries?: number;
  /** Claude model override. */
  claudeModel?: string;
  /**
   * Per-repo configuration map, used to resolve the pre-flight enforcement
   * gate (Issue #3577). Omitted → no gate.
   */
  repoConfigs?: Record<string, RepoConfig>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CLAUDE_TIMEOUT = 14400;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
/** Default silence watchdog (Issue #1825) — mirrors OPERATIONAL_DEFAULTS.claudeNoOutputTimeout. */
const DEFAULT_CLAUDE_NO_OUTPUT_TIMEOUT = 600;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Decode base64-encoded annotations JSON.
 *
 * @param encoded - Base64-encoded string
 * @returns Parsed annotations array, or empty array on failure
 */
export function decodeAnnotations(encoded: string): CheckAnnotation[] {
  if (!encoded) return [];

  try {
    const decoded = atob(encoded);
    const parsed: unknown = JSON.parse(decoded);
    if (!Array.isArray(parsed)) return [];
    return parsed as CheckAnnotation[];
  } catch {
    return [];
  }
}

/**
 * Format check annotations into a readable string for Claude.
 *
 * @param annotations - Parsed annotation objects
 * @returns Formatted annotation details string
 */
export function formatAnnotations(annotations: CheckAnnotation[]): string {
  if (annotations.length === 0) {
    return "No specific annotations were available. Please run the spelling check locally to identify issues.";
  }

  let details = "The following spelling issues were detected:\n\n";
  for (const annotation of annotations) {
    details +=
      `- **${annotation.path}:${annotation.start_line}**: ${annotation.message}\n`;
  }
  return details;
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Process a spelling check failure on a PR.
 *
 * This is the Deno equivalent of work_on_spelling_failure() from issue_worker.sh.
 * It:
 * 1. Decodes and formats check annotations
 * 2. Builds a spelling fix prompt
 * 3. Runs Claude with retry/timeout handling
 * 4. Reports results via PR comment
 *
 * @param input - Spelling fix input data
 * @param processorDeps - Processor dependencies
 * @returns Result containing the processing outcome
 */
export async function processSpellingFailure(
  input: SpellingFixInput,
  processorDeps: SpellingProcessorDeps,
): Promise<Result<SpellingFixResult>> {
  const { repo, prNumber, checkName } = input;
  const { logger, deps } = processorDeps;

  logger.info("Processing spelling failure", {
    repo,
    prNumber,
    checkName,
  });

  // Start periodic heartbeat to prevent false crash detection (Issue #1204).
  // The initial record is awaited (Issue #1888); on failure return early so
  // the next worker iteration can re-attempt the spelling fix.
  const workDir = processorDeps.workDir ?? Deno.env.get("WORK_DIR") ?? "/tmp";
  const heartbeatStart = await startHeartbeat({
    repo,
    issueNumber: prNumber,
    workDir,
    recordFn: deps.crashHandling.recordHeartbeat,
    clearFn: deps.crashHandling.clearHeartbeat,
  });
  if (!heartbeatStart.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to start heartbeat for PR ${repo}#${prNumber}: ${heartbeatStart.error.message}`,
      ),
    };
  }
  const heartbeatHandle: HeartbeatHandle = heartbeatStart.value;

  try {
    return await _processSpellingWithHeartbeat(input, processorDeps);
  } finally {
    await stopHeartbeat(heartbeatHandle);
  }
}

/**
 * Inner spelling fix processing logic, separated to allow heartbeat
 * lifecycle management in the outer function (Issue #1204).
 */
async function _processSpellingWithHeartbeat(
  input: SpellingFixInput,
  processorDeps: SpellingProcessorDeps,
): Promise<Result<SpellingFixResult>> {
  const { repo, prNumber, checkName, encodedAnnotations } = input;
  const {
    logger,
    deps,
    qualityInstructions,
    customInstructions,
    claudeTimeout = DEFAULT_CLAUDE_TIMEOUT,
    claudeNoOutputTimeout = DEFAULT_CLAUDE_NO_OUTPUT_TIMEOUT,
    maxRateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES,
  } = processorDeps;

  // Decode and format annotations
  const annotations = decodeAnnotations(encodedAnnotations);
  const annotationDetails = formatAnnotations(annotations);

  logger.info("Decoded annotations", { count: annotations.length });

  // Checkout the PR branch before running Claude (Issue #1458).
  // Shell work_on_spelling_failure did this; the Deno migration missed it,
  // leaving milestone-branch PRs running on the wrong branch.
  const prepared = await preparePrBranch(input.branchName, {
    logger,
    git: deps.git,
    cwd: processorDeps.workDir,
  });
  if (!prepared.ok) {
    // Issue #4376: never run the agent on the wrong branch.
    logger.warn(
      `Spelling fix skipped for PR #${prNumber}: PR branch '${input.branchName}' ${
        prepared.reason === "branch_missing"
          ? "no longer exists on origin (merged or closed?)"
          : "could not be checked out"
      } — ${prepared.detail}`,
    );
    return {
      ok: true,
      value: {
        processed: false,
        changesPushed: false,
        annotationCount: 0,
        summary:
          `PR branch '${input.branchName}' unavailable (${prepared.reason})`,
      },
    };
  }

  // Capture pre-Claude HEAD so we can detect commits Claude pushes itself
  // (Issue #1863). The final-mile commitAndPushPending only sees uncommitted
  // work, so a Claude self-push leaves hasChanges=false and the worker posts
  // a misleading "no changes" reply. branchHeadChanged is the authoritative
  // signal.
  const beforeShaResult = await deps.git.captureBranchHead(input.branchName, {
    cwd: processorDeps.workDir,
  });
  const beforeSha = beforeShaResult.ok ? beforeShaResult.value : undefined;
  if (!beforeShaResult.ok) {
    logger.warn("Failed to capture pre-Claude HEAD SHA", {
      branchName: input.branchName,
      error: beforeShaResult.error.message,
    });
  }

  // Read repo context (CLAUDE.md/AGENTS.md) for system prompt injection (Issue #1325)
  const spellingWorkDir = processorDeps.workDir ?? Deno.env.get("WORK_DIR") ??
    "/tmp";
  const repoName = repo.split("/").pop() ?? repo;
  const repoDir = `${spellingWorkDir}/${repoName}`;
  const repoContextResult = await readRepoContext(repoDir);
  const repoContextContent =
    repoContextResult.ok && repoContextResult.value.content
      ? repoContextResult.value.content
      : undefined;

  // Build prompt
  const promptOptions: SpellingFixPromptOptions = {
    repo,
    prNumber: String(prNumber),
    checkName,
    annotationDetails,
    qualityInstructions,
    customInstructions,
    repoContextContent,
  };

  const promptResult = await buildSpellingFixPrompt(promptOptions);
  if (!promptResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to build spelling fix prompt: ${promptResult.error.message}`,
      ),
    };
  }

  // Destructure PromptParts for prompt caching (Issue #1262)
  const { systemPrompt, prompt: userPrompt } = promptResult.value;

  // Execute Claude in the target repo directory (Issue #1297)
  const claudeResult = await deps.claude.runClaudeWithRetry(
    {
      prompt: userPrompt,
      systemPrompt,
      timeoutSeconds: claudeTimeout,
      noOutputTimeout: claudeNoOutputTimeout,
      phase: "spelling_fix",
      cwd: processorDeps.workDir,
      logger,
    },
    {
      maxRetries: maxRateLimitRetries,
    },
  );

  if (!claudeResult.ok) {
    const failureMessage =
      `Failed to fix spelling issues: Claude execution failed — ${claudeResult.error.message}`;
    await replyToComment(repo, prNumber, failureMessage, deps);
    return {
      ok: false,
      error: new Error(failureMessage),
    };
  }

  // Check for timeout (Issue #1825: distinguish silence watchdog from hard timeout)
  if (claudeResult.value.timedOut) {
    const failureMessage = claudeResult.value.timeoutReason === "no-output"
      ? `Failed to fix spelling issues: Claude produced no output for ${claudeNoOutputTimeout} seconds (silence watchdog fired)`
      : `Failed to fix spelling issues: Claude timed out after ${claudeTimeout} seconds`;
    await replyToComment(repo, prNumber, failureMessage, deps);
    return {
      ok: false,
      error: new Error(failureMessage),
    };
  }

  // Always commit and push any pending work (Issue #1643).
  // Previously gated on `claudeOutput.length > 0`, but Claude stdout is
  // not a reliable signal of git state — silent commits or uncommitted
  // working-tree changes left local-only work behind on unattended
  // machines. Use git itself as the source of truth.
  //
  // Issue #3577: enforce the repo's pre-flight gate — a non-zero exit blocks
  // both the commit and the push.
  const preFlight = resolvePreFlightSpec(
    processorDeps.repoConfigs,
    input.repo,
  );
  const finaliseResult = await deps.git.commitAndPushPending(
    input.branchName,
    `Fix spelling check failures: ${checkName}\n\nAutomated final-mile commit for PR #${prNumber} (Issue #1643).`,
    { cwd: processorDeps.workDir },
    false,
    preFlight,
  );

  let pushSucceeded = false;
  let hasChanges = false;
  let finalUnpushedAfterPush = 0;
  if (finaliseResult.ok) {
    const { committedNewChanges, commitsPushed, finalUnpushedCount } =
      finaliseResult.value;
    hasChanges = committedNewChanges || commitsPushed > 0;
    finalUnpushedAfterPush = finalUnpushedCount;
    pushSucceeded = finalUnpushedCount === 0 && hasChanges;
    logger.info("Final-mile commit-and-push complete", {
      committedNewChanges,
      commitsPushed,
      finalUnpushedCount,
      // Issue #211: how the count was established — a `local-fallback`
      // source means the remote could not be consulted, not that the push
      // failed.
      unpushedSource: finaliseResult.value.finalUnpushedSource,
      unpushedDetail: finaliseResult.value.finalUnpushedDetail,
    });

    if (finalUnpushedCount > 0) {
      logger.warn("Local commits remain after push, attempting recovery", {
        unpushed: finalUnpushedCount,
        unpushedSource: finaliseResult.value.finalUnpushedSource,
      });
      const recoveryResult = await deps.git.recoverFromPushRejection(
        input.branchName,
        { cwd: processorDeps.workDir },
      );
      let retryDetail: string | undefined;
      if (recoveryResult.ok) {
        const retryFinalise = await deps.git.commitAndPushPending(
          input.branchName,
          `Fix spelling check failures: ${checkName}\n\nRetry after rebase recovery for PR #${prNumber} (Issue #1643).`,
          { cwd: processorDeps.workDir },
          false,
          preFlight,
        );
        if (retryFinalise.ok && retryFinalise.value.finalUnpushedCount === 0) {
          hasChanges = true;
          pushSucceeded = true;
          finalUnpushedAfterPush = 0;
        } else {
          retryDetail = retryFinalise.ok
            ? `${retryFinalise.value.finalUnpushedCount} commit(s) still unpushed`
            : retryFinalise.error.message;
        }
      }
      if (!pushSucceeded) {
        // Issue #211: name the failing recovery step and carry git's stderr.
        logger.error("Push failed after recovery attempt", {
          repo,
          prNumber,
          unpushed: finalUnpushedAfterPush,
          recoveryError: recoveryResult.ok
            ? undefined
            : recoveryResult.error.message,
          retryError: retryDetail,
        });
      }
    }
  } else {
    logger.error("commitAndPushPending failed", {
      error: finaliseResult.error.message,
    });
  }

  // Issue #1863: detect commits Claude pushed itself during its run.
  // commitAndPushPending only sees uncommitted work, so a clean self-push
  // leaves hasChanges=false. Compare the post-run HEAD against the SHA we
  // captured before Claude ran. branchHeadChanged degrades safely on read
  // failure (returns false), so this never fabricates a change signal.
  if (beforeSha !== undefined) {
    const movedResult = await deps.git.branchHeadChanged(
      beforeSha,
      input.branchName,
      { cwd: processorDeps.workDir },
    );
    if (movedResult.ok && movedResult.value) {
      logger.info("Branch HEAD moved during Claude run", {
        branchName: input.branchName,
        beforeSha,
      });
      hasChanges = true;
      pushSucceeded = finalUnpushedAfterPush === 0;
    }
  }

  // Reply with outcome — only claim "pushed" if push actually succeeded
  if (hasChanges && pushSucceeded) {
    await replyToComment(
      repo,
      prNumber,
      "I've pushed fixes for the spelling issues. Please review the changes.",
      deps,
    );
  } else if (hasChanges && !pushSucceeded) {
    await replyToComment(
      repo,
      prNumber,
      "I fixed the spelling issues locally but failed to push the changes. Please check the branch status.",
      deps,
    );
  } else {
    await replyToComment(
      repo,
      prNumber,
      "I reviewed the spelling check failures but determined no changes were needed. The spelling checker may need configuration updates.",
      deps,
    );
  }

  const actuallyPushed = hasChanges && pushSucceeded;

  logger.info("Spelling fix processing complete", {
    repo,
    prNumber,
    changesPushed: actuallyPushed,
    annotationCount: annotations.length,
  });

  return {
    ok: true,
    value: {
      processed: true,
      changesPushed: actuallyPushed,
      annotationCount: annotations.length,
      summary: actuallyPushed
        ? `Pushed spelling fixes for PR #${prNumber} (${annotations.length} annotations)`
        : hasChanges
        ? `Fixed spelling for PR #${prNumber} but failed to push`
        : `Reviewed spelling failures for PR #${prNumber} — no changes needed`,
    },
  };
}

// ---------------------------------------------------------------------------
// Reply helper
// ---------------------------------------------------------------------------

async function replyToComment(
  repo: string,
  prNumber: number,
  message: string,
  deps: WorkerDeps,
): Promise<void> {
  try {
    await deps.github.runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      message,
    ]);
  } catch {
    // Comment failure is non-critical
  }
}
