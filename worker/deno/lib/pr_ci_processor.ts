/**
 * PR CI fix processor (Issue #967).
 *
 * Handles fixing CI/integration test failures on PRs by decoding check
 * annotations, building a CI fix prompt, running Claude to diagnose and
 * fix the issue, committing changes, pushing, and tracking retry counts.
 *
 * Migrated from work_on_ci_failure() in issue_worker.sh.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, RepoConfig, Result } from "../types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { buildCiFixPrompt, type CiFixPromptOptions } from "./prompt_builder.ts";
import { readRepoContext } from "./repo_context_reader.ts";
import {
  getCiCheckRetryCount,
  postCiFixMaxRetriesComment,
  recordCiCheckRetry,
} from "./pr_ci_checks.ts";
import {
  type CheckAnnotation,
  decodeAnnotations,
} from "./pr_spelling_processor.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import {
  type HeartbeatHandle,
  startHeartbeat,
  stopHeartbeat,
} from "./heartbeat.ts";
import {
  acquireBranchUpdateLock,
  type BranchLockRenewalHandle,
  releaseBranchUpdateLock,
  startBranchUpdateLockRenewal,
} from "./pr_branch_lock.ts";
import {
  buildRetryPrompt,
  type QualityGateParams,
  type QualityGateRunResult,
  runQualityGateCheck,
} from "./quality_gate_phase.ts";
import {
  preparePrBranch,
  readPrResponseMessage,
} from "./pr_branch_preparation.ts";
import { classifyCiFailure } from "./ci_failure_classifier.ts";
import {
  buildRewriteCommitMessage,
  rebuildBranchHistory,
} from "./branch_history_rewrite.ts";
import {
  formatVerifiedPushSuffix,
  type PushVerification,
  verifyPushLanded,
} from "./push_claim_verification.ts";
import { resolveCiCheckStateDir } from "./ci_check_state_dir.ts";
import {
  type AutoFixAttempt,
  buildAutoFixCapSummary,
  computeFailureSignature,
  consumesAutoFixAttempt,
  DEFAULT_MAX_AUTO_FIX_ATTEMPTS,
  getAutoFixAttempts,
  hasReachedAutoFixCap,
  recordAutoFixAttempt,
} from "./auto_fix_attempt_tracker.ts";
import {
  buildCiNoChangesResponse,
  PR_ESCALATION_NEXT_STEP,
} from "./pr_no_changes_response.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import { stripReservedLabelsFromModelFollowUp } from "./escape_hatch_label_strip.ts";
import { loadMonitoredReposBestEffort } from "./monitored_repos_allowlist.ts";
import { getCiProviders } from "./repo_config.ts";
import { resolvePreFlightSpec } from "./git_push.ts";
import {
  formatPrFailureActionsExcerpt,
  type PrFailureActionResult,
  runPrFailureActions,
} from "./pr_failure_actions.ts";
import type { FailedCiCheck } from "./pr_ci_checks.ts";
import type { FetchFn } from "./bounded_fetch.ts";
import type { fetchGithubActionsLogExcerpt } from "./github_actions_log_fetcher.ts";
import {
  type CiFailureContext,
  resolveCiLogProvider,
} from "./ci_log_provider.ts";

// Re-export shared annotation types for convenience
export type { CheckAnnotation };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for the CI fix processor. */
export interface CiFixInput {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Head branch name. */
  branchName: string;
  /** GitHub check run ID. */
  checkRunId: string;
  /** Name of the failed CI check. */
  checkName: string;
  /** Base64-encoded annotations JSON. */
  encodedAnnotations: string;
  /**
   * Optional check `target_url` / `details_url` (Issue #1893). Used by
   * the PR failure action dispatcher to locate the external build (each
   * provider reads its own build id out of it). Optional because not all
   * CI sources populate it and the dispatcher is feature-gated by the
   * `ciProviders` repo config anyway.
   */
  targetUrl?: string;
}

/** Result of CI fix processing. */
export interface CiFixResult {
  /** Whether processing completed successfully. */
  processed: boolean;
  /** Whether code changes were made and pushed. */
  changesPushed: boolean;
  /** Number of annotations addressed. */
  annotationCount: number;
  /** Current retry count after this attempt. */
  retryCount: number;
  /** Human-readable summary. */
  summary: string;
}

/** Dependencies specific to the CI fix processor. */
export interface CiProcessorDeps {
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
  /** Maximum CI fix retries before giving up (default: 3). */
  maxCiRetries?: number;
  /**
   * Maximum auto-fix attempts per stable failure signature before the
   * worker stops and escalates with `needs-human` (Issue #3582, default: 3).
   * Distinct from `maxCiRetries`, which keys on the check-run id and so
   * resets on every push.
   */
  maxAutoFixAttempts?: number;
  /**
   * State directory for CI retry tracking. Defaults to
   * {@link resolveCiCheckStateDir} — an absolute path inside the work
   * directory, never relative to the process cwd (Issue #552).
   */
  stateDir?: string;
  /** Claude model override. */
  claudeModel?: string;
  /** Function to run gh commands (injectable for testing). */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Unique worker identity used for the cross-host PR lock (Issue #3754).
   * When unset the lock is skipped and a warning is logged — two hosts can
   * then fix the same PR concurrently, so production always sets it.
   */
  workerId?: string;
  /** Injectable lock acquisition (Issue #3754). Defaults to {@link acquireBranchUpdateLock}. */
  acquireLockFn?: typeof acquireBranchUpdateLock;
  /** Injectable lock release (Issue #3754). Defaults to {@link releaseBranchUpdateLock}. */
  releaseLockFn?: typeof releaseBranchUpdateLock;
  /** Injectable renewal scheduler (Issue #3754). Defaults to {@link startBranchUpdateLockRenewal}. */
  startLockRenewalFn?: typeof startBranchUpdateLockRenewal;
  /** Lock renewal interval override in milliseconds (Issue #3754, tests). */
  lockRenewalIntervalMs?: number;
  /** Repo-specific config for quality gate Docker image selection (Issue #1456). */
  repoConfigs?: Record<string, RepoConfig>;
  /** Function to run the quality gate (injectable for testing — Issue #1456). */
  qualityGateFn?: (params: QualityGateParams) => Promise<QualityGateRunResult>;
  /**
   * Override the remote push verification (Issue #579). Injected by tests so
   * the "a failed push produces no success claim" regression can be exercised
   * without a repository; production leaves it undefined.
   */
  verifyPushFn?: (
    branchName: string,
    options?: { cwd?: string },
  ) => Promise<PushVerification>;
  /**
   * Injectable PR failure action dispatcher (Issue #1893). Defaults to
   * {@link runPrFailureActions}. Tests inject a fake to avoid hitting
   * the real CI provider over the network.
   */
  prFailureActionsFn?: typeof runPrFailureActions;
  /**
   * Injectable fetch passed through to the PR failure action dispatcher
   * (Issue #1893). Defaults to `globalThis.fetch` inside the dispatcher.
   */
  prFailureActionsFetchFn?: FetchFn;
  /**
   * Injectable built-in GitHub Actions log provider (Issue #3580).
   * Defaults to {@link fetchGithubActionsLogExcerpt}. Tests inject a
   * fake so no live GitHub API call is made.
   */
  actionsLogFn?: typeof fetchGithubActionsLogExcerpt;
  /**
   * Prompts directory the CI-fix template is read from (Issue #1024).
   *
   * Left unset in production, where `getPromptsDir()` resolves it from the
   * launcher's environment. A test names its own checkout's `prompts/` here
   * instead of deleting `PROMPTS_DIR`/`VIBE_BASE_DIR` from the process every
   * other parallel worker shares.
   */
  promptsDir?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default hard timeout for the CI fix phase (Issue #1824).
 * Re-exported from OPERATIONAL_DEFAULTS so there is one source of truth.
 */
const DEFAULT_CLAUDE_TIMEOUT = OPERATIONAL_DEFAULTS.ciFixTimeout;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
/** Default silence watchdog (Issue #1825) — mirrors OPERATIONAL_DEFAULTS.claudeNoOutputTimeout. */
const DEFAULT_CLAUDE_NO_OUTPUT_TIMEOUT =
  OPERATIONAL_DEFAULTS.claudeNoOutputTimeout;
const DEFAULT_MAX_CI_RETRIES = 3;

// Issue #580 introduced the resolver here; Issue #552 moved it into its own
// module so `pr_maintenance` can share it without importing this one. Both
// names stay exported from here for the callers that already import them.
export {
  CI_CHECK_STATE_DIR_NAME,
  resolveCiCheckStateDir,
} from "./ci_check_state_dir.ts";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Maximum number of CI annotations rendered into the fix prompt (Issue #3648).
 *
 * Annotation text is CI-controlled and unbounded — a single failing check can
 * emit thousands of them. Its sibling excerpt paths already cap themselves
 * (`MAX_PR_FAILURE_ACTION_EXCERPT_BYTES` at 16 KiB, `DEFAULT_MAX_LOG_BYTES` at
 * 64 KiB); this closes the same gap for annotations.
 */
export const MAX_CI_ANNOTATIONS = 50;

/** Maximum total bytes of rendered annotation lines (Issue #3648). */
export const MAX_CI_ANNOTATION_BYTES = 16 * 1024;

/**
 * Format CI failure annotations with a CI-specific prefix.
 *
 * Bounded by both {@link MAX_CI_ANNOTATIONS} and
 * {@link MAX_CI_ANNOTATION_BYTES}; anything dropped is reported explicitly so
 * a truncated list never reads as the complete set (Issue #3648).
 *
 * @param annotations - Parsed annotation objects
 * @returns Formatted CI failure details string
 */
export function formatCiAnnotations(annotations: CheckAnnotation[]): string {
  if (annotations.length === 0) {
    return "No specific annotations were available. Please check the CI logs and run the failing check locally to identify the issue.";
  }

  const encoder = new TextEncoder();
  let details = "The following CI failure details were detected:\n\n";
  let usedBytes = 0;
  let rendered = 0;

  for (const annotation of annotations.slice(0, MAX_CI_ANNOTATIONS)) {
    const line =
      `- **${annotation.path}:${annotation.start_line}**: ${annotation.message}\n`;
    const lineBytes = encoder.encode(line).length;
    if (usedBytes + lineBytes > MAX_CI_ANNOTATION_BYTES) break;
    details += line;
    usedBytes += lineBytes;
    rendered++;
  }

  // A single oversized annotation must still yield something actionable —
  // render its head rather than an empty list.
  const first = annotations[0];
  if (rendered === 0 && first !== undefined) {
    const head = `- **${first.path}:${first.start_line}**: ${first.message}`
      .slice(0, MAX_CI_ANNOTATION_BYTES);
    details += `${head}…\n`;
    rendered = 1;
  }

  const omitted = annotations.length - rendered;
  if (omitted > 0) {
    details +=
      `\n_${omitted} further annotation(s) omitted (cap: ${MAX_CI_ANNOTATIONS} annotations / ${MAX_CI_ANNOTATION_BYTES} bytes). Run the failing check locally to see the full list._\n`;
  }
  return details;
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Process a CI check failure on a PR, holding the cross-host PR lock
 * (Issue #3754).
 *
 * The lock is **PR-level, not per-check**: two hosts picking different
 * failing checks on the same branch would still push to that branch
 * concurrently, so the whole PR is claimed for the duration of a fix.
 * It is the same `BRANCH_UPDATE_LOCK` used by the PR branch-update path,
 * so a CI fix and a branch rebase can never run against one branch at once.
 *
 * A loser returns early before any heartbeat, Claude run or push, and backs
 * off so the next scan can retry. The lock is released on every exit path —
 * success, failure and throw — and a crashed holder is freed by the TTL via
 * `cleanStaleBranchUpdateLocks`.
 *
 * @param input - CI fix input data
 * @param processorDeps - Processor dependencies
 * @returns Result containing the processing outcome
 */
export async function processCiFailure(
  input: CiFixInput,
  processorDeps: CiProcessorDeps,
): Promise<Result<CiFixResult>> {
  const { repo, prNumber, checkName } = input;
  const { logger, deps, workerId } = processorDeps;
  const ghFn = processorDeps.ghCommandFn ?? deps.github.runGhCommand;

  if (workerId === undefined || workerId.length === 0) {
    logger.warn(
      "pr_ci_lock=skipped reason=no-worker-id — CI fix is running unguarded",
      { repo, prNumber, checkName },
    );
    return await _processCiFailureLocked(input, processorDeps);
  }

  // Visible line under the hidden marker — a marker-only body renders as a
  // blank PR comment (Issue #1659).
  const lockNote =
    `Locked PR #${prNumber} for a CI fix (\`${checkName}\`) by worker ` +
    `\`${workerId}\` — Issue #3754.`;

  const acquireLock = processorDeps.acquireLockFn ?? acquireBranchUpdateLock;
  const lockResult = await acquireLock({
    repo,
    prNumber,
    workerId,
    ghCommandFn: ghFn,
    note: lockNote,
  });

  if (!lockResult.ok || !lockResult.value.acquired) {
    const winner = lockResult.ok
      ? lockResult.value.winnerId ?? "unknown"
      : "unknown";
    logger.info(`pr_ci_lock=lost winner=${winner}`, {
      repo,
      prNumber,
      checkName,
      ...(lockResult.ok ? {} : { error: lockResult.error.message }),
    });
    return {
      ok: true,
      value: {
        processed: false,
        changesPushed: false,
        annotationCount: 0,
        retryCount: 0,
        summary:
          `PR locked by \`${winner}\` — skipped the CI fix for PR #${prNumber} (${checkName})`,
      },
    };
  }

  const lockCommentId = lockResult.value.lockCommentId;
  logger.info(`pr_ci_lock=held worker=${workerId}`, {
    repo,
    prNumber,
    checkName,
    lockCommentId,
  });

  // A CI fix can run for `ciFixTimeout` (30 min by default), far longer
  // than the 5-minute lock TTL, so the lock is refreshed while we work.
  let renewal: BranchLockRenewalHandle | undefined;
  if (lockCommentId !== undefined) {
    const startRenewal = processorDeps.startLockRenewalFn ??
      startBranchUpdateLockRenewal;
    renewal = startRenewal({
      repo,
      lockCommentId,
      workerId,
      ghCommandFn: ghFn,
      note: lockNote,
      ...(processorDeps.lockRenewalIntervalMs !== undefined
        ? { intervalMs: processorDeps.lockRenewalIntervalMs }
        : {}),
      onError: (message: string) =>
        logger.error(`pr_ci_lock=renew-failed ${message}`, { repo, prNumber }),
    });
  }

  try {
    return await _processCiFailureLocked(input, processorDeps);
  } finally {
    renewal?.stop();
    if (lockCommentId !== undefined) {
      const release = processorDeps.releaseLockFn ?? releaseBranchUpdateLock;
      await release({ repo, prNumber, lockCommentId, ghCommandFn: ghFn });
    }
  }
}

/**
 * CI fix work performed while the PR lock is held (Issue #3754).
 *
 * Everything from the retry-count check onwards lives here so the caller
 * can wrap it in acquire/release without duplicating the early returns.
 */
async function _processCiFailureLocked(
  input: CiFixInput,
  processorDeps: CiProcessorDeps,
): Promise<Result<CiFixResult>> {
  const { repo, prNumber, checkRunId, checkName } = input;
  const {
    logger,
    deps,
    maxCiRetries = DEFAULT_MAX_CI_RETRIES,
    // Issue #552: absolute, inside the writable work directory — never
    // relative to a cwd that is read-only in container mode.
    stateDir = resolveCiCheckStateDir(),
    ghCommandFn,
  } = processorDeps;

  const ghFn = ghCommandFn ?? deps.github.runGhCommand;

  logger.info("Processing CI failure", {
    repo,
    prNumber,
    checkName,
    checkRunId,
  });

  // Check retry count before proceeding
  const currentRetries = await getCiCheckRetryCount(stateDir, repo, checkRunId);
  if (currentRetries >= maxCiRetries) {
    logger.warn("CI check has exceeded max retries", {
      repo,
      prNumber,
      checkName,
      retries: currentRetries,
      maxRetries: maxCiRetries,
    });

    // Post max-retries comment
    await postCiFixMaxRetriesComment(
      repo,
      prNumber,
      checkName,
      checkRunId,
      maxCiRetries,
      ghFn,
    );

    return {
      ok: true,
      value: {
        processed: false,
        changesPushed: false,
        annotationCount: 0,
        retryCount: currentRetries,
        summary:
          `CI check '${checkName}' exceeded max retries (${currentRetries}/${maxCiRetries})`,
      },
    };
  }

  // Record this retry attempt
  const newRetryCount = await recordCiCheckRetry(stateDir, repo, checkRunId);

  // Start periodic heartbeat to prevent false crash detection (Issue #1204).
  // The initial record is awaited (Issue #1888); on failure return early so
  // the next worker iteration can re-attempt the CI fix.
  const workDir = processorDeps.workDir ?? Deno.env.get("WORK_DIR") ?? "/tmp";
  const heartbeatStart = await startHeartbeat({
    repo,
    issueNumber: prNumber,
    // A PR, not an issue (Issue #391) — see pr_merge_conflict_processor.
    kind: "pr",
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

  // Issue #3753: make the claim visible inside the heartbeat comment itself.
  await recordCiMilestone(
    processorDeps,
    input,
    `Claimed PR #${prNumber} (CI check \`${checkName}\` failing)`,
  );

  try {
    const result = await _processCiWithHeartbeat(
      input,
      processorDeps,
      newRetryCount,
    );
    await recordCiMilestone(
      processorDeps,
      input,
      result.ok
        ? `Released — ${result.value.summary}`
        : `Released — gave up: ${result.error.message}`,
    );
    return result;
  } finally {
    await stopHeartbeat(heartbeatHandle);
  }
}

/**
 * Append one line to the heartbeat progress log (Issue #3753).
 *
 * Best-effort by construction: the storage layer already swallows its own
 * failures, and a throw here is logged rather than allowed to abort the CI
 * fix it is merely describing.
 */
async function recordCiMilestone(
  processorDeps: CiProcessorDeps,
  input: CiFixInput,
  text: string,
): Promise<void> {
  const workDir = processorDeps.workDir ?? Deno.env.get("WORK_DIR") ?? "/tmp";
  try {
    await processorDeps.deps.crashHandling.recordMilestone(
      workDir,
      input.repo,
      input.prNumber,
      text,
    );
  } catch (err) {
    processorDeps.logger.warn("Failed to record heartbeat milestone", {
      repo: input.repo,
      prNumber: input.prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Inner CI fix processing logic, separated to allow heartbeat
 * lifecycle management in the outer function (Issue #1204).
 */
async function _processCiWithHeartbeat(
  input: CiFixInput,
  processorDeps: CiProcessorDeps,
  newRetryCount: number,
): Promise<Result<CiFixResult>> {
  const { repo, prNumber, checkName, encodedAnnotations } = input;
  const {
    logger,
    deps,
    qualityInstructions,
    customInstructions,
    claudeTimeout = DEFAULT_CLAUDE_TIMEOUT,
    claudeNoOutputTimeout = DEFAULT_CLAUDE_NO_OUTPUT_TIMEOUT,
    maxRateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES,
    maxCiRetries = DEFAULT_MAX_CI_RETRIES,
    maxAutoFixAttempts = DEFAULT_MAX_AUTO_FIX_ATTEMPTS,
    stateDir = resolveCiCheckStateDir(),
  } = processorDeps;

  // Decode and format annotations
  const annotations = decodeAnnotations(encodedAnnotations);
  const annotationDetails = formatCiAnnotations(annotations);

  logger.info("Decoded CI annotations", {
    count: annotations.length,
    retryCount: newRetryCount,
  });

  // Checkout the PR branch before running Claude (Issue #1455).
  // Shell work_on_ci_failure did this; the Deno migration missed it, which
  // left milestone-branch PRs running on the wrong branch.
  const prepared = await preparePrBranch(input.branchName, {
    logger,
    git: deps.git,
    cwd: processorDeps.workDir,
  });
  if (!prepared.ok) {
    // Issue #4376: never run the agent on the wrong branch. A missing ref
    // means the PR merged/closed after it was listed — skip it.
    logger.warn(
      `CI fix skipped for PR #${prNumber}: PR branch '${input.branchName}' ${
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
        retryCount: newRetryCount,
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
  const ciWorkDir = processorDeps.workDir ?? Deno.env.get("WORK_DIR") ?? "/tmp";
  const repoName = repo.split("/").pop() ?? repo;
  const repoDir = `${ciWorkDir}/${repoName}`;
  const repoContextResult = await readRepoContext(repoDir);
  const repoContextContent =
    repoContextResult.ok && repoContextResult.value.content
      ? repoContextResult.value.content
      : undefined;

  // Resolve a CI log excerpt: configured per-repo actions first
  // (Issue #1893), falling back to the built-in GitHub Actions provider
  // (Issue #3580). All failures are tolerated — a CI log outage must not
  // stall the fix flow.
  const ciLogOutcome = await _resolveCiLogExcerpt(input, processorDeps);
  const prFailureActionsExcerpt = ciLogOutcome.excerpt;

  // Auto-fix attempt cap (Issue #3582). The signature is composed of
  // durable parts only, so three attempted fixes on one underlying failure
  // count 1, 2, 3 even though every push mints a fresh check-run id. It is
  // logged on every attempt so the sequence is auditable in the worker log.
  const classifierAnnotations = annotations.map((a) => ({
    message: a.message,
    path: a.path,
  }));
  const failureClassification = classifyCiFailure(
    checkName,
    classifierAnnotations,
    `${annotationDetails}\n${prFailureActionsExcerpt}`,
  );
  const signature = computeFailureSignature({
    repo,
    locus: { kind: "pr", number: prNumber },
    checkName,
    logExcerpt: `${annotationDetails}\n${prFailureActionsExcerpt}`,
    ...(processorDeps.workDir !== undefined
      ? { workspaceRoot: processorDeps.workDir }
      : {}),
  });
  const priorAttempts = await getAutoFixAttempts(stateDir, signature);
  logger.info("Auto-fix failure signature", {
    repo,
    prNumber,
    checkName,
    signature,
    priorAttempts: priorAttempts.length,
    maxAutoFixAttempts,
    category: failureClassification.category,
  });

  if (hasReachedAutoFixCap(priorAttempts.length, maxAutoFixAttempts)) {
    logger.warn("Auto-fix attempt cap reached — escalating to a human", {
      repo,
      prNumber,
      checkName,
      signature,
      attempts: priorAttempts.length,
      maxAutoFixAttempts,
    });

    const escalationGhFn = processorDeps.ghCommandFn ??
      deps.github.runGhCommand;
    await escalateToHuman({
      ghClient: createGhEscalationClient(escalationGhFn),
      repo,
      target: { kind: "pr", number: prNumber },
      needsHumanLabel: "needs-human",
      heading: "Automatic fix attempts exhausted",
      reason: buildAutoFixCapSummary({
        checkName,
        signature,
        maxAttempts: maxAutoFixAttempts,
        attempts: priorAttempts,
      }),
      nextStep: PR_ESCALATION_NEXT_STEP,
      // One consolidated comment per signature — never a fourth
      // "I tried again" note.
      dedupKey: `auto-fix-cap:${signature}`,
      ensureLabelColour: "d4c5f9",
      ensureLabelDescription:
        "Worker could not produce a fix; human review required",
      deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
      logger,
    });

    return {
      ok: true,
      value: {
        processed: false,
        changesPushed: false,
        annotationCount: annotations.length,
        retryCount: newRetryCount,
        summary:
          `Auto-fix cap reached for PR #${prNumber} (${checkName}, signature ${signature}) — escalated with needs-human`,
      },
    };
  }

  await recordCiMilestone(
    processorDeps,
    input,
    `Diagnosing \`${checkName}\` (${failureClassification.category}) — ` +
      `fix attempt ${priorAttempts.length + 1} of ${maxAutoFixAttempts}`,
  );

  // Build prompt — pass raw annotations so v4+ templates can surface the
  // failure classification (Issue #1692).
  const promptOptions: CiFixPromptOptions = {
    repo,
    prNumber: String(prNumber),
    checkName,
    annotationDetails,
    qualityInstructions,
    customInstructions,
    repoContextContent,
    annotations: annotations.map((a) => ({
      message: a.message,
      path: a.path,
    })),
    prFailureActions: prFailureActionsExcerpt,
    promptsDir: processorDeps.promptsDir,
  };

  const promptResult = await buildCiFixPrompt(promptOptions);
  if (!promptResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to build CI fix prompt: ${promptResult.error.message}`,
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
      phase: "ci_fix",
      cwd: processorDeps.workDir,
      logger,
    },
    {
      maxRetries: maxRateLimitRetries,
    },
  );

  if (!claudeResult.ok) {
    const failureMessage =
      `Failed to fix CI failure (${checkName}): Claude execution failed — ${claudeResult.error.message}`;
    await replyToComment(repo, prNumber, failureMessage, deps);
    return {
      ok: false,
      error: new Error(failureMessage),
    };
  }

  // Check for timeout (Issue #1825: distinguish silence watchdog from hard timeout)
  if (claudeResult.value.timedOut) {
    const failureMessage = claudeResult.value.timeoutReason === "no-output"
      ? `Failed to fix CI failure (**${checkName}**): Claude produced no output for ${claudeNoOutputTimeout} seconds (silence watchdog fired)`
      : `Failed to fix CI failure (**${checkName}**): Claude timed out after ${claudeTimeout} seconds`;
    await replyToComment(repo, prNumber, failureMessage, deps);
    return {
      ok: false,
      error: new Error(failureMessage),
    };
  }

  // Post-Claude quality check (Issue #1456).
  // Mirrors shell work_on_ci_failure: if Claude left uncommitted changes,
  // run quality.sh, give Claude a retry on fixable failures, and commit the
  // remaining changes so they are pushed as part of the CI fix.
  const postQualityResult = await _runPostClaudeQualityCheck(
    input,
    processorDeps,
  );

  // Always commit and push any pending work (Issue #1643).
  // Previously this was gated on `claudeOutput.length > 0`, but Claude
  // stdout is not a reliable signal of git state — silent commits or
  // uncommitted working-tree changes were leaving local-only work behind
  // on unattended machines. Use git itself as the source of truth.
  //
  // Issue #3577: enforce the repo's pre-flight gate at the automated-commit
  // chokepoint — a non-zero exit blocks both this commit and the push so a
  // known-broken CI "fix" is never pushed back into the expensive build.
  const preFlight = resolvePreFlightSpec(processorDeps.repoConfigs, repo);
  const finaliseResult = await deps.git.commitAndPushPending(
    input.branchName,
    `Fix CI failure: ${checkName}\n\nAutomated final-mile commit for PR #${prNumber} (Issue #1643).`,
    { cwd: processorDeps.workDir },
    false,
    preFlight,
  );

  let pushSucceeded = false;
  let hasChanges = postQualityResult.committedChanges;
  // Issue #579: `undefined` means NOT MEASURED, which is not the same as
  // measured-and-zero. Initialised to 0, a failed commit-and-push left this
  // at 0, and a local commit moving HEAD then produced `pushSucceeded = true`
  // for a push that never ran — the shape of the PR #549 incident.
  let finalUnpushedAfterPush: number | undefined;
  // Issue #211: why the branch is still not on origin — the failing recovery
  // step and git's own words. Reaches both the log and the PR comment, so a
  // human never gets a bare "please check the branch status" again.
  let pushFailureDetail = "";
  if (finaliseResult.ok) {
    const { committedNewChanges, commitsPushed, finalUnpushedCount } =
      finaliseResult.value;
    hasChanges = hasChanges || committedNewChanges || commitsPushed > 0;
    finalUnpushedAfterPush = finalUnpushedCount;
    pushSucceeded = finalUnpushedCount === 0 && hasChanges;
    logger.info("Final-mile commit-and-push complete", {
      committedNewChanges,
      commitsPushed,
      finalUnpushedCount,
    });

    // If push left commits unpushed, attempt rejection recovery and retry.
    if (finalUnpushedCount > 0) {
      logger.warn("Local commits remain after push, attempting recovery", {
        unpushed: finalUnpushedCount,
      });
      const recoveryResult = await deps.git.recoverFromPushRejection(
        input.branchName,
        { cwd: processorDeps.workDir },
      );
      // Issue #211: keep the reason the recovery failed — it names the step
      // (rebase conflict, failed auto-resolution, refused --force-with-lease)
      // and carries git's stderr. Without it the log said only "push failed".
      let failureDetail = recoveryResult.ok
        ? undefined
        : recoveryResult.error.message;
      if (recoveryResult.ok) {
        const retryFinalise = await deps.git.commitAndPushPending(
          input.branchName,
          `Fix CI failure: ${checkName}\n\nRetry after rebase recovery for PR #${prNumber} (Issue #1643).`,
          { cwd: processorDeps.workDir },
          false,
          preFlight,
        );
        if (retryFinalise.ok && retryFinalise.value.finalUnpushedCount === 0) {
          hasChanges = true;
          pushSucceeded = true;
          finalUnpushedAfterPush = 0;
        } else {
          failureDetail = retryFinalise.ok
            ? `retry after rebase recovery left ${retryFinalise.value.finalUnpushedCount} commit(s) unpushed`
            : retryFinalise.error.message;
        }
      }
      if (!pushSucceeded) {
        pushFailureDetail = failureDetail ?? "no detail reported";
        logger.error("Push failed after recovery attempt", {
          repo,
          prNumber,
          unpushed: finalUnpushedCount,
          recoveryStep: recoveryResult.ok ? "retry-push" : "recovery",
          recoveryError: pushFailureDetail,
        });
      }
    }
  } else {
    pushFailureDetail = finaliseResult.error.message;
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
      // A moved HEAD proves a commit exists locally. It proves nothing about
      // the remote — which is the whole of Issue #579 — so this only
      // re-opens the question, and the verification below answers it.
      pushSucceeded = finalUnpushedAfterPush === 0;
    }
  }

  // Issue #579: confirm against the REMOTE before any of this is claimed. An
  // unpushed count that was never taken is not a count of zero, and a local
  // commit moves HEAD whether or not the push ran. When the remote cannot be
  // reached — the incident's exact condition, a broken git credential — the
  // answer is "no evidence it landed", never success.
  //
  // This runs BEFORE the history rebuild below, which is gated on
  // `pushSucceeded`: rebuilding and force-pushing a branch whose ordinary
  // push never landed would be rewriting history on the strength of a claim
  // that has just been shown to be false.
  let pushVerification: PushVerification | undefined;
  const verifyFn = processorDeps.verifyPushFn ?? verifyPushLanded;
  if (hasChanges && pushSucceeded) {
    pushVerification = await verifyFn(input.branchName, {
      ...(processorDeps.workDir !== undefined
        ? { cwd: processorDeps.workDir }
        : {}),
    });
    pushSucceeded = pushVerification.landed;
    if (!pushSucceeded) {
      pushFailureDetail = pushVerification.reason;
      logger.error(
        "Local state looked pushed but the remote does not agree — not claiming success",
        {
          repo,
          prNumber,
          branchName: input.branchName,
          reason: pushVerification.reason,
        },
      );
    } else {
      logger.info("Push verified against the remote", {
        repo,
        prNumber,
        branchName: input.branchName,
        remoteSha: pushVerification.remoteSha,
      });
    }
  }

  // Issue #630: a secret scanner judges the COMMIT RANGE, not the working
  // tree. The content is corrected and pushed by now, and the check would
  // still fail on the original commit's diff — so the branch is collapsed to
  // a single commit and force-pushed with a lease. Without this the fix loop
  // re-commits the same correction until the attempt cap and ends at
  // `needs-human`, a wedge caused entirely by the wrong model of the check.
  let historyRewritten = false;
  if (
    failureClassification.category === "history-rewrite-required" &&
    hasChanges && pushSucceeded
  ) {
    // One rebuild per underlying failure. A finding that survives a rebuild
    // is not in this branch, so rebuilding again would be the same wrong
    // answer given twice — escalate with the evidence instead.
    const alreadyRebuilt = priorAttempts.some(
      (attempt) => attempt.category === "history-rewrite-required",
    );
    if (alreadyRebuilt) {
      logger.warn(
        "Secret finding survived a history rebuild — it is in the base branch",
        { repo, prNumber, checkName, branchName: input.branchName },
      );
    } else {
      const defaultBranchResult = await deps.git.getRepoDefaultBranch(
        repo,
        processorDeps.ghCommandFn ?? deps.github.runGhCommand,
      );
      if (!defaultBranchResult.ok) {
        logger.warn("Could not resolve the base branch for a history rebuild", {
          repo,
          prNumber,
          error: defaultBranchResult.error.message,
        });
      } else {
        const rebuild = await rebuildBranchHistory({
          branchName: input.branchName,
          baseBranch: defaultBranchResult.value,
          commitMessage: buildRewriteCommitMessage(checkName, prNumber),
          ...(processorDeps.workDir !== undefined
            ? { cwd: processorDeps.workDir }
            : {}),
        }, {
          runGitCommand: (args, options) =>
            deps.git.runGitCommand(args, options ?? {}),
          logger,
        });
        if (rebuild.ok) {
          historyRewritten = true;
          logger.info("Rebuilt branch history to clear a secret finding", {
            repo,
            prNumber,
            checkName,
            collapsedCommits: rebuild.value.collapsedCommits,
          });
          // The rebuild force-pushed a NEW commit, so the SHA verified above
          // is now stale. Re-verify rather than report it: naming a commit
          // that is no longer the branch head is precisely the false claim
          // Issue #579 exists to prevent, and a rebuild is the one path that
          // makes an honest verification go stale.
          pushVerification = await verifyFn(input.branchName, {
            ...(processorDeps.workDir !== undefined
              ? { cwd: processorDeps.workDir }
              : {}),
          });
          pushSucceeded = pushVerification.landed;
          if (!pushSucceeded) {
            pushFailureDetail = pushVerification.reason;
            logger.error(
              "History was rebuilt but the remote does not show it — not claiming success",
              {
                repo,
                prNumber,
                branchName: input.branchName,
                reason: pushVerification.reason,
              },
            );
          }
        } else {
          // The corrected content is already pushed, so the PR is no worse
          // than before — it will simply fail the same check again. Say why
          // rather than letting the next cycle rediscover it.
          logger.warn("History rebuild refused or failed", {
            repo,
            prNumber,
            checkName,
            branchName: input.branchName,
            error: rebuild.error.message,
          });
        }
      }
    }
  }

  // Re-enable auto-merge after pushing fix
  if (hasChanges && pushSucceeded) {
    try {
      // Issue #3909: pass the head branch so the milestone open-children
      // gate needs no extra lookup.
      await deps.pr.enableAutoMerge({
        repo,
        prNumber,
        headRefName: input.branchName,
      });
    } catch {
      logger.warn("Could not re-enable auto-merge", { repo, prNumber });
    }
  }

  const actuallyPushed = hasChanges && pushSucceeded;

  // Issue #3753: record the push (with its short SHA) so an observer can see
  // the fix land without reading the worker log.
  if (actuallyPushed) {
    const afterShaResult = await deps.git.captureBranchHead(input.branchName, {
      cwd: processorDeps.workDir,
    });
    const shortSha = afterShaResult.ok
      ? afterShaResult.value.substring(0, 7)
      : "unknown";
    await recordCiMilestone(
      processorDeps,
      input,
      `Fix pushed (\`${shortSha}\`) — waiting on CI re-run`,
    );
  } else if (hasChanges) {
    await recordCiMilestone(
      processorDeps,
      input,
      `Fix made locally but the push failed for \`${checkName}\``,
    );
  } else {
    await recordCiMilestone(
      processorDeps,
      input,
      `No code changes produced for \`${checkName}\``,
    );
  }

  // Read .pr_response_message if Claude created one (Issue #1455).
  // Used as the PR comment body when push succeeds, replacing the hardcoded
  // default with Claude's own summary of what it fixed.
  const customMessage = await readPrResponseMessage(processorDeps.workDir);

  // Issue #3708 (SEC-6403af1e8b72): the CI-fix prompt carries the same escape
  // hatch as PR feedback, so this path can also end with a follow-up issue
  // Claude created — and labelled — itself. Run the same post-hoc reserved-label
  // strip here; it is a no-op when no hand-off is detected. A failed strip is
  // logged loudly (the guard did not apply) but never changes the CI outcome.
  const followUpStrip = await stripReservedLabelsFromModelFollowUp({
    message: customMessage,
    currentRepo: repo,
    loadAllowedRepos: () => loadMonitoredReposBestEffort(deps, logger),
    excludeIssueNumber: prNumber,
    ghClient: deps.github.createClient(logger),
    logger,
  });
  if (!followUpStrip.ok) {
    logger.error(
      "Reserved-label strip did not apply to the CI-fix follow-up — it may " +
        "still carry a reserved label (Issue #3708)",
      { repo, prNumber, error: followUpStrip.error.message },
    );
  }

  // Reply with outcome — only claim "pushed" if push actually succeeded
  if (hasChanges && pushSucceeded) {
    const base = customMessage ??
      `I've pushed a fix for the CI failure (**${checkName}**). Please review the changes.`;
    // Issue #630: a force-push that silently rewrote the branch would be an
    // unpleasant surprise for anyone with it checked out. Say so, and say why.
    const rebuilt = historyRewritten
      ? `${base}\n\n**The branch history was rebuilt.** \`${checkName}\` scans every commit ` +
        `in the branch, not the working tree, so correcting the content in a further commit ` +
        `would have left the finding in the earlier commit's diff and the check would have ` +
        `failed again. The branch is now a single commit and was force-pushed with a lease. ` +
        `If you have it checked out, re-fetch rather than pulling.`
      : base;
    // Issue #579: carry the SHA the claim was verified against, so a stale
    // claim is falsifiable at a glance rather than by a human comparing the
    // comment against `git log`.
    const body = rebuilt +
      (pushVerification ? formatVerifiedPushSuffix(pushVerification) : "");
    await replyToComment(repo, prNumber, body, deps);
  } else if (hasChanges && !pushSucceeded) {
    // Issue #211: carry the failing recovery step and git's stderr into the
    // comment — "check the branch status" alone gives a human nothing to act on.
    const detail = pushFailureDetail
      ? `\n\nPush recovery detail: ${pushFailureDetail}`
      : "";
    await replyToComment(
      repo,
      prNumber,
      `I fixed the CI failure (**${checkName}**) locally but failed to push the changes. Please check the branch status.${detail}`,
      deps,
    );
  } else {
    // Issue #1691: replace dismissive "transient or infrastructure" fallback
    // with a classifier-aware response. For code-fix-required failures, add
    // the `needs-human` label so a reviewer takes over.
    const classification = classifyCiFailure(
      checkName,
      annotations.map((a) => ({
        message: a.message,
        path: a.path,
      })),
      claudeResult.value.output,
    );
    const response = buildCiNoChangesResponse(checkName, classification);
    if (response.addNeedsHuman) {
      // Issue #2211: route via the shared escalateToHuman helper so the
      // `needs-human` label and the explanation comment are applied
      // atomically through a single chokepoint. The classifier-derived
      // explanation becomes the `reason`; the reviewer instructions
      // become the `nextStep`.
      const escalationGhFn = processorDeps.ghCommandFn ??
        deps.github.runGhCommand;
      await escalateToHuman({
        ghClient: createGhEscalationClient(escalationGhFn),
        repo,
        target: { kind: "pr", number: prNumber },
        needsHumanLabel: "needs-human",
        heading: "CI failure needs human attention",
        reason: response.reason ?? response.body,
        nextStep: response.nextStep ?? PR_ESCALATION_NEXT_STEP,
        ensureLabelColour: "d4c5f9",
        ensureLabelDescription:
          "Worker could not produce a fix; human review required",
        deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
        logger,
      });
    } else {
      await replyToComment(repo, prNumber, response.body, deps);
    }
  }

  // Record this completed attempt against the failure signature (Issue
  // #3582). Infrastructure-category failures are deliberately not charged:
  // a runner blip is no evidence the worker cannot fix the code.
  let autoFixAttemptCount = priorAttempts.length;
  if (consumesAutoFixAttempt(failureClassification.category)) {
    const attemptRecord: AutoFixAttempt = {
      repo,
      locus: { kind: "pr", number: prNumber },
      checkName,
      category: failureClassification.category,
      diagnosis: failureClassification.reason,
      change: summariseChange(customMessage, hasChanges),
      outcome: actuallyPushed
        ? "pushed a fix; the build was still not green"
        : hasChanges
        ? "a fix was made locally but could not be pushed"
        : "no code changes were produced",
    };
    autoFixAttemptCount = await recordAutoFixAttempt(
      stateDir,
      signature,
      attemptRecord,
    );
  }

  logger.info("CI fix processing complete", {
    repo,
    prNumber,
    changesPushed: actuallyPushed,
    annotationCount: annotations.length,
    retryCount: newRetryCount,
    signature,
    autoFixAttempt: autoFixAttemptCount,
    maxAutoFixAttempts,
  });

  return {
    ok: true,
    value: {
      processed: true,
      changesPushed: actuallyPushed,
      annotationCount: annotations.length,
      retryCount: newRetryCount,
      summary: actuallyPushed
        ? `Pushed CI fix for PR #${prNumber} (${checkName}, attempt ${newRetryCount}/${maxCiRetries})`
        : hasChanges
        ? `Fixed CI failure for PR #${prNumber} (${checkName}) but failed to push`
        : `Reviewed CI failure for PR #${prNumber} (${checkName}) — no changes needed`,
    },
  };
}

/**
 * Summarise what an attempt changed, for the consolidated cap comment
 * (Issue #3582). Prefers Claude's own `.pr_response_message`, trimmed to a
 * single table-friendly line.
 */
function summariseChange(
  customMessage: string | undefined,
  hasChanges: boolean,
): string {
  const text = customMessage?.replace(/\s+/g, " ").trim();
  if (text && text.length > 0) {
    return text.length > 300 ? `${text.slice(0, 297)}...` : text;
  }
  return hasChanges ? "changes were made (no summary provided)" : "nothing";
}

// ---------------------------------------------------------------------------
// Post-Claude quality check (Issue #1456)
// ---------------------------------------------------------------------------

/** Result of the post-Claude quality check phase. */
interface PostClaudeQualityResult {
  /** Whether a new commit was created during the quality phase. */
  committedChanges: boolean;
}

/**
 * Run the post-Claude quality check (Issue #1456).
 *
 * Mirrors the shell `work_on_ci_failure` behaviour:
 * 1. Check for uncommitted changes via `git status --porcelain`. If none,
 *    return immediately.
 * 2. Run `./quality.sh` (via {@link runQualityGateCheck}) to verify the fix.
 * 3. On a fixable failure, give Claude a single retry with the failure output.
 * 4. Stage and commit any remaining uncommitted changes so the push step
 *    includes them.
 *
 * Errors here are logged but do not abort the CI fix — the push logic that
 * follows will surface any real problems.
 */
async function _runPostClaudeQualityCheck(
  input: CiFixInput,
  processorDeps: CiProcessorDeps,
): Promise<PostClaudeQualityResult> {
  const {
    logger,
    deps,
    workDir,
    claudeTimeout = DEFAULT_CLAUDE_TIMEOUT,
    claudeNoOutputTimeout = DEFAULT_CLAUDE_NO_OUTPUT_TIMEOUT,
    maxRateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES,
    repoConfigs,
    qualityGateFn,
  } = processorDeps;
  const cwd = workDir;

  // Step 1: Detect uncommitted changes
  const statusResult = await deps.git.runGitCommand(
    ["status", "--porcelain"],
    { cwd },
  );
  if (!statusResult.ok || statusResult.value.code !== 0) {
    const err = statusResult.ok
      ? statusResult.value.stderr.trim()
      : statusResult.error.message;
    logger.warn("Failed to check git status for post-Claude quality check", {
      error: err,
    });
    return { committedChanges: false };
  }
  if (statusResult.value.stdout.trim().length === 0) {
    logger.debug(
      "No uncommitted changes after Claude — skipping post-Claude quality check",
    );
    return { committedChanges: false };
  }

  logger.info("Running post-Claude quality check on uncommitted changes", {
    repo: input.repo,
    prNumber: input.prNumber,
  });

  // Step 2: Run quality gate (native or Docker via quality_gate_phase)
  const qualityFn = qualityGateFn ?? runQualityGateCheck;
  let qualityResult: QualityGateRunResult;
  try {
    qualityResult = await qualityFn({
      repo: input.repo,
      qualityScript: "./quality.sh",
      repoConfigs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      "Quality gate threw during post-Claude check — continuing to commit",
      {
        error: message,
      },
    );
    qualityResult = { action: "passed", qualityOutput: "" };
  }

  // Step 3: If fixable, give Claude one more attempt
  if (qualityResult.action === "failed_fixable") {
    logger.warn(
      "Post-Claude quality check failed — giving Claude a second attempt",
      {
        repo: input.repo,
        prNumber: input.prNumber,
      },
    );
    const retryPrompt = qualityResult.retryPrompt ??
      buildRetryPrompt(qualityResult.qualityOutput);
    const retryResult = await deps.claude.runClaudeWithRetry(
      {
        prompt: retryPrompt,
        timeoutSeconds: claudeTimeout,
        noOutputTimeout: claudeNoOutputTimeout,
        phase: "ci_fix",
        cwd,
        logger,
      },
      { maxRetries: maxRateLimitRetries },
    );
    if (!retryResult.ok) {
      logger.warn(
        "Claude quality retry failed — committing any remaining changes anyway",
        {
          error: retryResult.error.message,
        },
      );
    }
  } else if (
    qualityResult.action !== "passed" && qualityResult.action !== "skipped"
  ) {
    logger.warn("Post-Claude quality check reported non-fixable failure", {
      action: qualityResult.action,
    });
  }

  // Step 4: Commit any remaining changes
  const recheckResult = await deps.git.runGitCommand(
    ["status", "--porcelain"],
    { cwd },
  );
  if (!recheckResult.ok || recheckResult.value.code !== 0) {
    return { committedChanges: false };
  }
  if (recheckResult.value.stdout.trim().length === 0) {
    return { committedChanges: false };
  }

  const addResult = await deps.git.runGitCommand(["add", "-A"], { cwd });
  if (!addResult.ok || addResult.value.code !== 0) {
    const err = addResult.ok
      ? addResult.value.stderr.trim()
      : addResult.error.message;
    logger.warn("Failed to stage remaining post-Claude changes", {
      error: err,
    });
    return { committedChanges: false };
  }

  const commitMessage =
    `Fix CI failure: ${input.checkName}\n\nAutomated post-quality commit for PR #${input.prNumber}.`;
  const commitResult = await deps.git.runGitCommand(
    ["commit", "-m", commitMessage],
    { cwd },
  );
  if (!commitResult.ok || commitResult.value.code !== 0) {
    const err = commitResult.ok
      ? commitResult.value.stderr.trim()
      : commitResult.error.message;
    logger.warn("Failed to commit remaining post-Claude changes", {
      error: err,
    });
    return { committedChanges: false };
  }

  logger.info("Committed post-Claude quality changes", {
    repo: input.repo,
    prNumber: input.prNumber,
  });
  return { committedChanges: true };
}

// ---------------------------------------------------------------------------
// PR failure action integration (Issue #1893)
// ---------------------------------------------------------------------------

/** A resolved CI log excerpt. */
interface CiLogExcerptOutcome {
  /** Rendered Markdown excerpt, or `""` when none could be fetched. */
  excerpt: string;
}

/**
 * Resolve the CI log excerpt fed into the `{{PR_FAILURE_ACTIONS}}` prompt
 * slot (Issues #3580, #3579).
 *
 * A repo's configured CI providers win when they produce an excerpt;
 * otherwise the registry's fall-back — the built-in GitHub Actions
 * provider — runs, so every repo gets real job logs with zero
 * configuration. The chosen provider id is always logged, making a silent
 * fall-through to annotation-only diagnosis visible in the worker log.
 */
async function _resolveCiLogExcerpt(
  input: CiFixInput,
  processorDeps: CiProcessorDeps,
): Promise<CiLogExcerptOutcome> {
  const { logger } = processorDeps;

  const configured = await _runConfiguredPrFailureActions(
    input,
    processorDeps,
  );
  if (configured.excerpt !== "") {
    logger.info("CI log provider selected", {
      repo: input.repo,
      prNumber: input.prNumber,
      provider: "pr-failure-actions",
    });
    return configured;
  }

  const ctx: CiFailureContext = {
    repo: input.repo,
    prNumber: input.prNumber,
    checkName: input.checkName,
    checkRunId: input.checkRunId,
    ...(input.targetUrl !== undefined ? { targetUrl: input.targetUrl } : {}),
    ghFn: processorDeps.ghCommandFn ?? processorDeps.deps.github.runGhCommand,
    ...(processorDeps.actionsLogFn !== undefined
      ? { actionsLogFn: processorDeps.actionsLogFn }
      : {}),
  };
  const provider = resolveCiLogProvider(ctx);

  let outcome;
  try {
    outcome = await provider.fetchLog(ctx);
  } catch (err) {
    // Providers capture their own failures, so this catch handles only
    // programmer errors. Log loudly and continue without an excerpt.
    logger.warn("CI log provider threw — no CI log excerpt", {
      repo: input.repo,
      prNumber: input.prNumber,
      provider: provider.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { excerpt: "" };
  }

  if (outcome.ok && outcome.value.logText !== "") {
    logger.info("CI log provider selected", {
      repo: input.repo,
      prNumber: input.prNumber,
      provider: provider.id,
      jobId: outcome.value.buildId,
      excerptBytes: outcome.value.logText.length,
    });
    return {
      excerpt: formatPrFailureActionsExcerpt([
        { providerId: provider.id, ok: true, excerpt: outcome.value },
      ]),
    };
  }

  logger.warn("No CI log provider produced an excerpt", {
    repo: input.repo,
    prNumber: input.prNumber,
    checkName: input.checkName,
    provider: provider.id,
    reason: outcome.ok ? "provider returned an empty excerpt" : outcome.error,
  });

  return { excerpt: "" };
}

/**
 * Run the per-repo CI providers (if any) and return the rendered
 * Markdown excerpt for substitution into the ci_fix v6 prompt.
 *
 * Tolerant of every failure mode:
 * - Returns `""` when the repo configures no CI providers.
 * - Returns `""` when `getCiProviders` throws on malformed config
 *   (logged at warn level so the operator can see the parse error).
 * - Returns `""` when the dispatcher returns errors for every provider
 *   (also logged at warn level).
 * - Never throws — the CI fix flow continues with the unchanged prompt.
 */
async function _runConfiguredPrFailureActions(
  input: CiFixInput,
  processorDeps: CiProcessorDeps,
): Promise<CiLogExcerptOutcome> {
  const { logger, repoConfigs, prFailureActionsFn, prFailureActionsFetchFn } =
    processorDeps;

  let providers;
  try {
    providers = getCiProviders(repoConfigs, input.repo);
  } catch (err) {
    logger.warn(
      "Failed to load CI provider config — continuing without dispatcher",
      {
        repo: input.repo,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return { excerpt: "" };
  }

  if (providers.length === 0) {
    return { excerpt: "" };
  }

  // Synthesise a single FailedCiCheck describing the check we are
  // currently fixing. Each provider matches it against its configured
  // `checkNamePattern` to locate the upstream build.
  const failedCheck: FailedCiCheck = {
    repo: input.repo,
    prNumber: input.prNumber,
    branchName: input.branchName,
    checkId: input.checkRunId,
    checkName: input.checkName,
    encodedAnnotations: input.encodedAnnotations,
    ...(input.targetUrl !== undefined ? { targetUrl: input.targetUrl } : {}),
  };

  const dispatcher = prFailureActionsFn ?? runPrFailureActions;
  let results: PrFailureActionResult[];
  try {
    results = await dispatcher({
      repo: input.repo,
      prNumber: input.prNumber,
      failedChecks: [failedCheck],
      providers,
      ghFn: processorDeps.ghCommandFn ?? processorDeps.deps.github.runGhCommand,
      ...(processorDeps.actionsLogFn !== undefined
        ? { actionsLogFn: processorDeps.actionsLogFn }
        : {}),
      ...(prFailureActionsFetchFn !== undefined
        ? { fetchFn: prFailureActionsFetchFn }
        : {}),
      logger,
    });
  } catch (err) {
    // The dispatcher captures action-level failures internally so this
    // catch handles only programmer errors. Log and continue.
    logger.warn(
      "PR failure action dispatcher threw — continuing without excerpt",
      {
        repo: input.repo,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return { excerpt: "" };
  }

  const successes = results.filter((r) => r.ok);
  if (successes.length === 0) {
    logger.warn(
      "All configured PR failure actions errored — proceeding with unchanged CI fix prompt",
      {
        repo: input.repo,
        prNumber: input.prNumber,
        attempted: results.length,
      },
    );
    return { excerpt: "" };
  }

  return { excerpt: formatPrFailureActionsExcerpt(results) };
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
