/**
 * Claude execution phase orchestration (Issue #1227).
 *
 * Migrates the business logic from work_on_issue_execute_claude() in
 * issue_worker.sh to Deno TypeScript. Handles:
 * - Screenshot requirement detection (label and file pattern matching)
 * - Prompt building orchestration with per-repo configuration
 * - Claude invocation via runClaudeWithRetry with heartbeat monitoring
 * - Timeout and rate-limit error handling with failure message formatting
 * - Self-healing: finding existing PR if Claude times out or produces no changes
 * - Change detection (uncommitted changes and new commits)
 * - Remote branch self-healing (Issue #585)
 *
 * The shell wrapper remains responsible for:
 * - Calling handle_issue_failure for GitHub comments (via label_manager)
 * - Returning the appropriate exit code (0, 1, 2)
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type {
  CiProviderConfig,
  CustomLabelPromptMapping,
  Logger,
  RepoConfig,
  Result,
} from "../types.ts";
import {
  buildQualityInstructions,
  getCiFailureLabels,
  getCiProviders,
  getCustomInstructions,
  getRepoConfig,
} from "./repo_config.ts";
import { buildCiFailureContext, isCiFailureIssue } from "./ci_failure_issue.ts";
import { generateBoundaryId } from "./prompt_delimiter.ts";
import { resolveVerbosity } from "./verbosity.ts";
import {
  buildIssuePrompt,
  type IssuePromptOptions,
  type PromptParts,
} from "./prompt_builder.ts";
import {
  buildCachedIssuePrompt,
  type CachedIssuePromptOptions,
  type CachedPromptParts,
} from "./prompt_builder_cache.ts";
import { PromptCache } from "./prompt_cache.ts";
import { getPromptsCommit } from "./prompt_manager.ts";
import {
  type ClaudeRunResult,
  type RetryOptions,
  type RunClaudeOptions,
  runClaudeWithRetry,
} from "./claude_runner.ts";
import { setActiveRepoModelEffortOverrides } from "./claude_executor.ts";
import { setActiveRepoCodexModelEffortOverrides } from "./codex_executor.ts";
import { setActiveRepoGeminiModelOverrides } from "./gemini_executor.ts";
import { setActiveRepoDeepSeekModelOverrides } from "./deepseek_executor.ts";
import type { AgentProviderSelector } from "./agent_provider.ts";
import type { ProgressExtensionOptions } from "./progress_extension.ts";
import {
  buildTimeoutFailureReason,
  type ExtensionTelemetry,
} from "./timeout_extension_telemetry.ts";
import {
  type ClearFn,
  type HeartbeatHandle,
  type RecordFn,
  startHeartbeat,
  stopHeartbeat,
} from "./heartbeat.ts";
import { getOrGenerateCodebaseMap } from "./codebase_map_cache.ts";
import { validateRepoState } from "./git_repo_validation.ts";
import { findExistingPrForBranch } from "./pr_issue_linking.ts";
import { retargetPrToMilestone } from "./pr_retarget.ts";
import { finalisePr } from "./pr_auto_merge.ts";
import {
  ensureIssueClosedIfPrMerged,
  type LifecycleDeps,
} from "./issue_lifecycle.ts";
import { ensureHistoryDepth } from "./git_history.ts";
import { createLogger } from "./logger.ts";
import {
  collectRecentActivity,
  formatRecentActivity,
} from "./recent_activity.ts";
import { IssueCache } from "./issue_cache.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import type { SessionResumeState } from "./session_resume.ts";
import {
  type BudgetLogEntry,
  checkContextBudget,
  formatBudgetBreakdown,
  logContextBudget,
} from "./context_budget.ts";
import {
  buildContextBudgetEscalationReason,
  buildContextComponents,
  CONTEXT_BUDGET_NEXT_STEP,
} from "./context_budget_guard.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import { runGhOrThrow } from "./gh_spawn.ts";
import {
  readSecurityFixGateBlock,
  resolveSecurityGateStateDir,
} from "./security_fix_gate_feedback.ts";
import { buildFetchArgs } from "./git_ref_args.ts";
import { runGitCommandChecked } from "./git_timeout.ts";

// =============================================================================
// Types
// =============================================================================

/** Action outcomes from the execute-claude phase. */
export type ExecuteClaudeAction =
  | "success" // Claude made changes (uncommitted or committed)
  | "self_healed" // PR found despite timeout/no-changes — issue addressed
  | "remote_self_healed" // Remote branch has commits from prior attempt
  | "no_changes" // Claude completed but made no changes
  | "failure"; // Fatal error (timeout, rate limit, validation failure)

/** Failure type classification. */
export type ExecuteClaudeFailureType =
  | "timeout"
  | "rate_limit"
  | "out_of_memory"
  /** SIGKILLed with no watchdog firing — possible VM OOM (Issue #4202). */
  | "killed"
  | "validation"
  | "execution_error"
  /** Prompt reached the hard context-budget ceiling (Issue #3713). */
  | "context_budget";

/** Result returned by the execute-claude phase. */
export interface ExecuteClaudePhaseResult {
  /** What happened. */
  action: ExecuteClaudeAction;
  /** Type of failure (only set when action = "failure"). */
  failureType?: ExecuteClaudeFailureType;
  /** Formatted failure message for GitHub comment (only set on failure). */
  failureMessage?: string;
  /** Worker diagnostic context for zero-output detection. */
  diagnosticContext?: string;
  /** URL of self-healed PR (only set when action = "self_healed"). */
  prUrl?: string;
  /** Number of the self-healed PR. */
  prNumber?: number;
  /** Whether Claude left uncommitted changes. */
  hasUncommittedChanges?: boolean;
  /** Whether Claude created new commits. */
  hasNewCommits?: boolean;
  /**
   * Short commit hash of the prompts checkout, for traceability (Issue #844).
   * Undefined when git could not resolve it — the phase logs that loudly.
   */
  promptsCommit?: string;
  /**
   * The prompt template file this run read (Issue #849, part of #843).
   *
   * `prompts/issue/prompt.md` normally; an operator's file when a mapping
   * dispatched or overrode the phase. The prompts commit identifies the
   * repository's templates but says nothing about an operator file, so this
   * is what makes such a run traceable.
   */
  promptTemplate?: string;
  /** SHA-256 hash of the static prompt content (Issue #1273). */
  promptSha?: string;
  /** Whether the prompt cache was hit (Issue #1273). */
  promptCacheHit?: boolean;
  /** Elapsed time in seconds. */
  elapsedSeconds?: number;
}

/** Options for the execute-claude phase. */
export interface ExecuteClaudePhaseOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number. */
  issueNumber: number;
  /** Issue title. */
  issueTitle: string;
  /** Issue body. */
  issueBody: string;
  /** Comma-separated issue labels. */
  issueLabels: string;
  /** GitHub username of the worker. */
  githubUser: string;
  /** Feature branch name. */
  branchName: string;
  /** Base branch (default branch or milestone branch). */
  baseBranch: string;
  /** Milestone branch (empty string if none). */
  milestoneBranch: string;
  /** Clarity status from the clarity phase. */
  clarityStatus: string;
  /** Working directory for heartbeat files. */
  workDir: string;
  /** Per-repo configuration map. */
  repoConfigs?: Record<string, RepoConfig>;
  /**
   * Validated `custom_label_prompts` mappings (Issue #849, part of #843).
   * An entry overriding the `issue` phase replaces the built-in template.
   */
  promptOverrides?: readonly CustomLabelPromptMapping[];
  /** Claude timeout in seconds. */
  claudeTimeout?: number;
  /**
   * Opt-in re-armable hard deadline for this issue-work run (Issue #4296,
   * part of #4290). Built by the caller from config
   * (`buildProgressExtension`); omitted, the hard timeout is unchanged.
   */
  progressExtension?: ProgressExtensionOptions;
  /** Grace period after SIGTERM in seconds. */
  claudeKillAfter?: number;
  /** Maximum rate-limit retries. */
  maxRateLimitRetries?: number;
  /** Maximum total rate-limit wait in seconds. */
  maxRateLimitWait?: number;
  /** Claude no-output timeout for diagnostics. */
  claudeNoOutputTimeout?: number;
  /** Needs-screenshot label name. */
  needsScreenshotLabel?: string;
  /** Directory for credit usage logs (Issue #1074). */
  creditLogDir?: string;
  /** Worker name for credit tracking. */
  workerName?: string;
  /** Directory for prompt cache files (Issue #1273). Omit to disable caching. */
  promptCacheDir?: string;
  /** Whether to include recent repo activity in prompts (Issue #1326, default: true). */
  includeRecentActivity?: boolean;
  /** Maximum merged PRs in activity summary (Issue #1326, default: 10). */
  recentActivityMergedPrLimit?: number;
  /** Maximum commits in activity summary (Issue #1326, default: 20). */
  recentActivityCommitLimit?: number;
  /** Maximum token budget for activity summary (Issue #1326, default: 1000). */
  recentActivityMaxTokens?: number;
  /** Cache TTL in seconds for recent activity data (Issue #1326, default: 300). */
  recentActivityCacheTtlSeconds?: number;
  /**
   * Whether to inject the generated codebase map (Issue #4281, default: true).
   * The map orients a cold session in the repository's layout, modules, and
   * canonical commands so it does not rediscover them by grepping.
   */
  includeCodebaseMap?: boolean;
  /** Directory for cached codebase maps (Issue #4281). */
  codebaseMapCacheDir?: string;
  /** Session resume state for multi-phase continuity (Issue #1324). */
  sessionResumeState?: SessionResumeState;
  /** Warning threshold for the context budget (Issue #1327, default: 50). */
  contextBudgetWarningPercent?: number;
  /** Error threshold for the context budget (Issue #1327, default: 80). */
  contextBudgetErrorPercent?: number;
  /**
   * Hard context-budget ceiling as a percentage (Issue #3713, default: 95).
   * At or above it the phase stops and escalates; `0` disables the ceiling.
   */
  contextBudgetBlockPercent?: number;
  /** Needs-human label name (Issue #3713, default: "needs-human"). */
  needsHumanLabel?: string;
  /**
   * Coding-agent provider for this phase's invocation only (Issue #4109).
   *
   * A registered id or a descriptor. Naming one here selects the agent for
   * this phase without mutating process-wide state, so a Quorum run can drive
   * two planners and a judge from one worker process. Omit it and the phase
   * runs on the active provider exactly as before.
   */
  agentProvider?: AgentProviderSelector;
}

/** Injectable dependencies for testing. */
export interface ExecuteClaudePhaseDeps {
  /** Run Claude with retry and timeout. */
  runClaudeWithRetry: (
    options: RunClaudeOptions,
    retryOptions?: RetryOptions,
  ) => Promise<Result<ClaudeRunResult>>;
  /** Build the issue prompt (returns PromptParts for caching, Issue #1262). */
  buildIssuePrompt: (
    options: IssuePromptOptions,
  ) => Promise<Result<PromptParts>>;
  /** Build the issue prompt with SHA-based cache integration (Issue #1273). */
  buildCachedIssuePrompt: (
    options: CachedIssuePromptOptions,
  ) => Promise<Result<CachedPromptParts>>;
  /**
   * Fetch the CI-failure build log and render the diagnosis context
   * (Issue #3581). Optional so existing test doubles need no change — the
   * real implementation is used when omitted.
   */
  buildCiFailureContext?: (
    options: {
      issueBody: string;
      repo: string;
      jobPath?: string;
      ciProviders?: readonly CiProviderConfig[];
      boundaryId: string;
    },
  ) => Promise<string>;
  /** Validate repository state before Claude invocation. */
  validateRepoState: (
    featureBranch: string,
    baseBranch: string,
    attemptRecovery: boolean,
    options?: { cwd?: string },
  ) => Promise<
    Result<{ valid: boolean; actions: string[]; warnings: string[] }>
  >;
  /** Find an existing PR for a branch. */
  findExistingPrForBranch: (
    repo: string,
    branchName: string,
  ) => Promise<Result<string, Error>>;
  /** Retarget a PR to a milestone branch. */
  retargetPrToMilestone: (
    repo: string,
    prNumber: number,
    milestoneBranch: string,
  ) => Promise<Result<string, Error>>;
  /** Finalise a PR (auto-merge, etc.). */
  finalisePr: (
    options: { repo: string; prNumber: number; skipAutoMerge?: boolean },
  ) => Promise<Result<string, Error>>;
  /** Ensure an issue is closed when its PR is merged. */
  ensureIssueClosedIfPrMerged: (
    repo: string,
    issueNumber: number,
    prNumber: number,
    githubUser: string,
    /** Branch this run worked — provenance for the close (Issue #174). */
    runBranch?: string,
  ) => Promise<Result<unknown, Error>>;
  /** Run a git command and return stdout. */
  runGitCommand: (args: string[]) => Promise<Result<string>>;
  /** Record a heartbeat. */
  recordHeartbeat: RecordFn;
  /** Clear a heartbeat. */
  clearHeartbeat: ClearFn;
  /**
   * Short commit hash of the checkout the prompt templates came from
   * (Issue #844) — the traceability record that replaced version numbers.
   */
  getPromptsCommit: () => Promise<Result<string>>;
  /**
   * Hand the issue to a human when the context-budget ceiling blocks the
   * phase (Issue #3713). Optional so existing test doubles need no change —
   * {@link defaultEscalateContextBudget} (the shared `escalateToHuman`
   * chokepoint) is used when omitted.
   */
  escalateContextBudget?: (options: ContextBudgetEscalation) => Promise<void>;
  /** Log a message. */
  log: (message: string) => void;
}

/** Arguments for the context-budget hand-off (Issue #3713). */
export interface ContextBudgetEscalation {
  repo: string;
  issueNumber: number;
  githubUser: string;
  needsHumanLabel: string;
  /** The `**Why:**` line — why the phase stopped. */
  reason: string;
}

// =============================================================================
// Screenshot requirement detection
// =============================================================================

/**
 * Detect whether screenshot instructions should be injected into the prompt.
 *
 * Screenshot is required when:
 * 1. The issue has the needs-screenshot label (Issue #344), OR
 * 2. The repo has requires_screenshots=true in config (Issue #793)
 *
 * @param issueLabels - Comma-separated issue labels
 * @param needsScreenshotLabel - The label name to check for
 * @param repoConfigs - Per-repo configuration map
 * @param repo - Repository in "owner/repo" format
 * @returns Whether screenshots are required
 */
export function detectScreenshotRequired(
  issueLabels: string,
  needsScreenshotLabel: string,
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): boolean {
  // Check for needs-screenshot label (case-insensitive)
  if (issueLabels.toLowerCase().includes(needsScreenshotLabel.toLowerCase())) {
    return true;
  }

  // Check repo config for requires_screenshots (Issue #793)
  // Note: requires_screenshots is not a typed RepoConfig field — it uses
  // the generic jq-based lookup in shell. In Deno, we check it as a custom
  // property on the config object.
  if (repoConfigs) {
    const config = repoConfigs[repo];
    if (config) {
      // Access the property via indexing since it's not part of the typed interface
      const requiresScreenshots =
        (config as Record<string, unknown>)["requiresScreenshots"];
      if (requiresScreenshots === true || requiresScreenshots === "true") {
        return true;
      }
    }
  }

  return false;
}

// =============================================================================
// Failure message formatting
// =============================================================================

/**
 * Build a failure message for timeout or rate-limit failures.
 *
 * Matches the formatting from the shell implementation, including
 * failure output, diagnostics, and diagnosis sections.
 */
export function buildFailureMessage(options: {
  failureType: "timeout" | "rate_limit" | "killed";
  failureReason: string;
  failureOutput: string;
  timeoutFailureSummary: string;
  diagnosticContent: string;
}): string {
  const {
    failureType,
    failureReason,
    failureOutput,
    timeoutFailureSummary,
    diagnosticContent,
  } = options;

  let diagnosis: string;
  if (options.failureType === "killed") {
    // A SIGKILL is not a time problem (Issue #4202): the process was ended
    // from outside, most often by the VM's out-of-memory killer — which
    // leaves no memory evidence in the output, because a SIGKILLed process
    // prints nothing.
    diagnosis = "The agent process was **killed from outside** (SIGKILL) — " +
      "no worker watchdog fired and the time budget was not exhausted. The " +
      "most common cause is the VM's out-of-memory killer under memory " +
      "pressure. This is an infrastructure failure, not a property of the " +
      "issue; the worker retries once automatically.";
  } else if (!failureOutput) {
    diagnosis = "Claude produced **zero output** before the timeout. " +
      "This typically indicates Claude CLI hung during startup or got stuck " +
      "in a tool call loop — not that the issue is too complex.";
  } else {
    diagnosis = "Claude was actively working but did not finish within the " +
      "time limit. The partial output below may help diagnose where it got stuck.";
  }

  let timeoutSummarySection = "";
  if (timeoutFailureSummary) {
    timeoutSummarySection =
      `\n\n### Failure Summary\n\n${timeoutFailureSummary}\n`;
  }

  let diagnosticSection = "";
  if (!failureOutput && diagnosticContent) {
    diagnosticSection =
      `\n<details>\n<summary>Timeout diagnostics (click to expand)</summary>\n\n\`\`\`\n${diagnosticContent}\n\`\`\`\n</details>`;
  }

  const _ = failureType; // acknowledge for linting

  return `Claude ${failureReason}.\n\n${diagnosis}${timeoutSummarySection}\n\n` +
    `<details>\n<summary>Last output from Claude (click to expand)</summary>\n\n` +
    `\`\`\`\n${
      failureOutput || "No output captured"
    }\n\`\`\`\n</details>${diagnosticSection}`;
}

/**
 * Build a failure message for an out-of-memory (heap-exhaustion) failure
 * (Issue #2742, parent #2721).
 *
 * OOM is terminal: unlike a timeout or a rate limit, waiting cannot reclaim
 * memory, so the message states plainly that the run failed fast rather than
 * pausing/retrying. The output tail (which carries the V8 / OOM-killer
 * diagnostics) is included so an operator can confirm the cause.
 */
export function buildOutOfMemoryMessage(options: {
  failureOutput: string;
}): string {
  const { failureOutput } = options;

  return "Claude ran out of memory (OOM) — failing fast rather than " +
    "pausing/retrying, since waiting cannot recover memory.\n\n" +
    "The run was terminated by a heap-exhaustion / out-of-memory error. " +
    "This is terminal, not a transient rate limit or timeout: retrying the " +
    "same work would hit the same memory ceiling. Reduce the work size " +
    "(split the issue) or raise the memory available to the Claude CLI.\n\n" +
    `<details>\n<summary>Last output from Claude (click to expand)</summary>\n\n` +
    `\`\`\`\n${failureOutput || "No output captured"}\n\`\`\`\n</details>`;
}

/**
 * Build worker diagnostic context for zero-output timeouts.
 *
 * When the re-armable deadline was active (Issue #4298) the extension history
 * is appended, so the diagnosis explains a three-hour run instead of quoting
 * the configured budget it outlived. Field separators (`;` and `=`) are
 * stripped from the free-text reason so one reason string cannot corrupt the
 * key/value encoding.
 */
export function buildDiagnosticContext(options: {
  clarityStatus: string;
  elapsedSeconds: number;
  claudeNoOutputTimeout: number;
  claudeTimeout: number;
  extensions?: ExtensionTelemetry;
}): string {
  const base = `health_check=passed;clarity=${options.clarityStatus};` +
    `elapsed_seconds=${options.elapsedSeconds};` +
    `no_output_timeout=${options.claudeNoOutputTimeout};` +
    `claude_timeout=${options.claudeTimeout}`;
  const ext = options.extensions;
  if (!ext) return base;
  return `${base};extensions_granted=${ext.granted};` +
    `extended_seconds=${ext.extendedSeconds};` +
    `final_deadline_seconds=${ext.finalDeadlineSeconds}` +
    (ext.refusalReason
      ? `;extension_refused=${ext.refusalReason.replace(/[;=]/g, " ")}`
      : "");
}

// =============================================================================
// Self-healing PR recovery
// =============================================================================

/**
 * Attempt to recover from a timeout or no-changes scenario by finding
 * an existing PR for the branch, retargeting it if needed, and finalising.
 */
export async function attemptPrSelfHealing(
  options: {
    repo: string;
    branchName: string;
    milestoneBranch: string;
    issueNumber: number;
    githubUser: string;
  },
  deps: Pick<
    ExecuteClaudePhaseDeps,
    | "findExistingPrForBranch"
    | "retargetPrToMilestone"
    | "finalisePr"
    | "ensureIssueClosedIfPrMerged"
    | "log"
  >,
): Promise<Result<{ prUrl: string; prNumber: number }>> {
  const { repo, branchName, milestoneBranch, issueNumber, githubUser } =
    options;

  const prResult = await deps.findExistingPrForBranch(repo, branchName);
  if (!prResult.ok) {
    return { ok: false, error: new Error("No existing PR found for branch") };
  }

  const prUrl = prResult.value;
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1]!, 10) : 0;

  deps.log(`SELF-HEALING: Found existing PR: ${prUrl}`);

  // Retarget to milestone if applicable (best-effort)
  if (milestoneBranch && prNumber > 0) {
    await deps.retargetPrToMilestone(repo, prNumber, milestoneBranch).catch(
      () => {
        deps.log("SELF-HEALING: retarget to milestone failed (non-fatal)");
      },
    );
  }

  // Finalise the PR (best-effort)
  if (prNumber > 0) {
    await deps.finalisePr({ repo, prNumber }).catch(() => {
      deps.log("SELF-HEALING: finalise PR failed (non-fatal)");
    });

    // Issue #174: this PR came from `findExistingPrForBranch`, so its head is
    // this run's branch by construction — naming it makes the provenance
    // check pass here and fail loudly if that ever stops being true.
    await deps.ensureIssueClosedIfPrMerged(
      repo,
      issueNumber,
      prNumber,
      githubUser,
      branchName,
    ).catch(() => {
      deps.log("SELF-HEALING: ensure issue closed failed (non-fatal)");
    });
  }

  return { ok: true, value: { prUrl, prNumber } };
}

// =============================================================================
// Main execution phase
// =============================================================================

/**
 * Hand the issue to a human through the shared `escalateToHuman`
 * chokepoint when the context-budget ceiling blocks the phase (Issue #3713).
 *
 * Escalation failures are logged, never swallowed into a silent success —
 * the phase still fails loud with `failureType: "context_budget"`.
 */
export async function defaultEscalateContextBudget(
  options: ContextBudgetEscalation,
): Promise<void> {
  const logger = createLogger();
  const result = await escalateToHuman({
    ghClient: createGhEscalationClient((args) => runGhOrThrow(args)),
    repo: options.repo,
    target: { kind: "issue", number: options.issueNumber },
    needsHumanLabel: options.needsHumanLabel,
    heading: "Context budget ceiling reached",
    reason: options.reason,
    nextStep: CONTEXT_BUDGET_NEXT_STEP,
    dedupKey: `context-budget-${options.issueNumber}`,
    githubUser: options.githubUser,
    logger,
  });
  if (!result.ok) {
    logger.error("Context-budget escalation failed", {
      repo: options.repo,
      issueNumber: options.issueNumber,
      error: result.error.message,
    });
  }
}

/**
 * The repo's configured CI log providers, or none.
 *
 * `getCiProviders` throws on malformed configuration, which is right for the
 * PR flow that is about to act on it. In issue mode a bad `ciProviders`
 * entry must not abort the run: the log simply is not fetched and the
 * prompt says so. The parse error is logged so the operator can see it.
 */
function readCiProviders(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
  log: (message: string) => void,
): readonly CiProviderConfig[] {
  try {
    return getCiProviders(repoConfigs, repo);
  } catch (err: unknown) {
    log(
      `Ignoring malformed ciProviders for ${repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

/**
 * Default production dependencies.
 */
export function createDefaultDeps(): ExecuteClaudePhaseDeps {
  return {
    escalateContextBudget: defaultEscalateContextBudget,
    runClaudeWithRetry,
    buildIssuePrompt,
    buildCachedIssuePrompt,
    buildCiFailureContext,
    validateRepoState: async (
      featureBranch,
      baseBranch,
      attemptRecovery,
      options,
    ) => {
      const result = await validateRepoState(
        featureBranch,
        baseBranch,
        attemptRecovery,
        options,
      );
      return result;
    },
    findExistingPrForBranch,
    retargetPrToMilestone: async (repo, prNumber, milestoneBranch) =>
      await retargetPrToMilestone(repo, prNumber, milestoneBranch),
    finalisePr: async (options) => await finalisePr(options),
    ensureIssueClosedIfPrMerged: async (
      repo,
      issueNumber,
      prNumber,
      githubUser,
      runBranch,
    ) => {
      // Issue #3703: the issue-close path spawns via the shared chokepoint.
      const defaultGhCommand = (args: string[]): Promise<string> =>
        runGhOrThrow(args);
      const lifecycleDeps: LifecycleDeps = {
        ghCommandFn: defaultGhCommand,
        logger: createLogger(),
      };
      return await ensureIssueClosedIfPrMerged(
        repo,
        issueNumber,
        prNumber,
        githubUser,
        lifecycleDeps,
        runBranch,
      );
    },
    // Issue #268: the shared timed runner journals mutations (reset/push)
    // and applies the default git timeout. Tests inject their own double.
    runGitCommand: (args: string[]) => runGitCommandChecked(args),
    recordHeartbeat: async (_workDir, _repo, _issueNumber) => ({
      ok: true,
      value: undefined,
    }),
    clearHeartbeat: async (_workDir, _repo, _issueNumber) => ({
      ok: true,
      value: undefined,
    }),
    getPromptsCommit: async () => await getPromptsCommit(),
    log: (message: string) => console.log(`[execute-claude-phase] ${message}`),
  };
}

/**
 * Run the full Claude execution phase.
 *
 * This is the main orchestration function that replaces the business logic
 * in work_on_issue_execute_claude() from issue_worker.sh.
 */
export async function runExecuteClaudePhase(
  options: ExecuteClaudePhaseOptions,
  deps: ExecuteClaudePhaseDeps = createDefaultDeps(),
): Promise<ExecuteClaudePhaseResult> {
  const {
    repo,
    issueNumber,
    issueTitle,
    issueBody,
    issueLabels,
    githubUser,
    branchName,
    baseBranch,
    milestoneBranch,
    clarityStatus,
    workDir,
    repoConfigs,
    promptOverrides,
    // Issue #1824: default sourced from OPERATIONAL_DEFAULTS so all timeout
    // defaults flow from a single source of truth.
    claudeTimeout = OPERATIONAL_DEFAULTS.claudeTimeout,
    claudeKillAfter = OPERATIONAL_DEFAULTS.claudeKillAfter,
    maxRateLimitRetries = OPERATIONAL_DEFAULTS.maxRateLimitRetries,
    maxRateLimitWait = OPERATIONAL_DEFAULTS.maxRateLimitWait,
    claudeNoOutputTimeout = OPERATIONAL_DEFAULTS.claudeNoOutputTimeout,
    needsScreenshotLabel = "needs-screenshot",
    creditLogDir,
    workerName,
    promptCacheDir,
    includeRecentActivity = OPERATIONAL_DEFAULTS.includeRecentActivity,
    recentActivityMergedPrLimit =
      OPERATIONAL_DEFAULTS.recentActivityMergedPrLimit,
    recentActivityCommitLimit = OPERATIONAL_DEFAULTS.recentActivityCommitLimit,
    recentActivityMaxTokens = OPERATIONAL_DEFAULTS.recentActivityMaxTokens,
    recentActivityCacheTtlSeconds =
      OPERATIONAL_DEFAULTS.recentActivityCacheTtlSeconds,
    includeCodebaseMap = OPERATIONAL_DEFAULTS.includeCodebaseMap,
    codebaseMapCacheDir,
    sessionResumeState,
    contextBudgetWarningPercent =
      OPERATIONAL_DEFAULTS.contextBudgetWarningPercent,
    contextBudgetErrorPercent = OPERATIONAL_DEFAULTS.contextBudgetErrorPercent,
    contextBudgetBlockPercent = OPERATIONAL_DEFAULTS.contextBudgetBlockPercent,
    needsHumanLabel = "needs-human",
  } = options;

  const startTime = Date.now();

  // Apply per-repo model/effort routing overrides (Issue #2625) before any
  // Claude phase runs for this repo. Replaces any previously-active repo
  // overrides so a high-value repo's premium tier never leaks into a filler
  // repo when one worker process serves several repos in sequence.
  setActiveRepoModelEffortOverrides(repoConfigs?.[repo]);
  // The same replace-never-merge switch for Codex's routing (Issue #363), so a
  // repo's Codex tier is scoped to that repo exactly as its Claude tier is.
  setActiveRepoCodexModelEffortOverrides(repoConfigs?.[repo]);
  // And the same for Gemini's model routing (Issue #364).
  setActiveRepoGeminiModelOverrides(repoConfigs?.[repo]);
  // And the same for DeepSeek's model routing (Issue #413).
  setActiveRepoDeepSeekModelOverrides(repoConfigs?.[repo]);

  // Build a Logger instance from the log function for APIs that require it
  const logger: Logger = buildLoggerFromFn(deps.log);

  // --- Screenshot requirement detection ---
  const screenshotRequired = detectScreenshotRequired(
    issueLabels,
    needsScreenshotLabel,
    repoConfigs,
    repo,
  );
  if (screenshotRequired) {
    deps.log(
      "Screenshot instructions will be injected into prompt (Issue #344/#793)",
    );
  }

  const skipScreenshotCheck =
    getRepoConfig(repoConfigs, repo, "skipScreenshotCheck") === "true";

  // --- Build quality and custom instructions ---
  const qualityInstructions = buildQualityInstructions(repoConfigs, repo);
  const customInstructions = getCustomInstructions(repoConfigs, repo);

  // --- CI-failure log auto-fetch (Issue #3581) ---
  // A CI-failure issue (e.g. one opened by develop-build-watch.yml) carries
  // only a small pre-summary of the console log. Fetch the full log for the
  // referenced build before the prompt is built and route to the diagnosis
  // framing. A fetch fault renders an explicit failure block rather than
  // silently degrading to a fix attempted on no evidence.
  let ciFailureContext: string | undefined;
  // Boundary id shared by the fetched-log fence and the issue prompt so the
  // integrity instruction covers the console log (Issue #3639).
  let ciFailureBoundaryId: string | undefined;
  if (isCiFailureIssue(issueLabels, getCiFailureLabels(repoConfigs, repo))) {
    deps.log(
      `Issue #${issueNumber} carries a configured CI-failure label — fetching the build log (Issue #3581)`,
    );
    const fetchContext = deps.buildCiFailureContext ?? buildCiFailureContext;
    ciFailureBoundaryId = generateBoundaryId();
    ciFailureContext = await fetchContext({
      issueBody,
      repo,
      jobPath: getRepoConfig(repoConfigs, repo, "ciFailureJobPath") ||
        undefined,
      ciProviders: readCiProviders(repoConfigs, repo, deps.log),
      boundaryId: ciFailureBoundaryId,
    });
  }

  // --- Collect recent repository activity (Issue #1326) ---
  let recentActivity: string | undefined;
  if (includeRecentActivity) {
    deps.log("Collecting recent repository activity for prompt context...");
    const activityCache = new IssueCache(
      undefined,
      recentActivityCacheTtlSeconds,
    );
    const activityResult = await collectRecentActivity({
      repo,
      githubUser,
      mergedPrLimit: recentActivityMergedPrLimit,
      commitLimit: recentActivityCommitLimit,
      cache: activityCache,
    });
    if (activityResult.ok) {
      recentActivity = formatRecentActivity(
        activityResult.value,
        recentActivityMaxTokens,
      );
      if (recentActivity) {
        deps.log(
          `Recent activity summary: ${recentActivity.split("\n").length} lines`,
        );
      } else {
        deps.log("No recent activity found for this repository");
      }
    } else {
      deps.log(
        `Failed to collect recent activity (non-fatal): ${activityResult.error.message}`,
      );
    }
  }

  // --- Generate (or reuse) the per-repo codebase map (Issue #4281) ---
  // Without it every session starts blind and spends its first minutes
  // grepping for where the code lives. The map is keyed on the repository's
  // tree hash, so this is a disk read on all but the first run after the
  // structure changes. A generation fault is logged and the run continues
  // unmapped — degraded, never silently blank.
  let codebaseMap: string | undefined;
  if (includeCodebaseMap) {
    const repoName = repo.split("/").pop() ?? repo;
    const repoDir = `${workDir}/${repoName}`;
    const mapResult = await getOrGenerateCodebaseMap({
      repo,
      repoDir,
      cacheDir: codebaseMapCacheDir,
    });
    if (mapResult.ok) {
      codebaseMap = mapResult.value.content;
      deps.log(
        `Codebase map: ${codebaseMap.length} chars, tree=${
          mapResult.value.treeHash.slice(0, 12)
        }... ${mapResult.value.cacheHit ? "(cached)" : "(generated)"}`,
      );
    } else {
      deps.log(
        `WARN: codebase map unavailable for ${repoDir} (non-fatal, Issue #4281): ${mapResult.error.message}`,
      );
    }
  }

  // --- Previous security-fix gate verdict (Issue #4057) ---
  // A gate block leaves its verdict in worker run state. Replaying it here is
  // the only trusted channel back into the retry: the gate's issue comment is
  // authored by the service account and so is classified UNTRUSTED, which is
  // why ten runs on #4030 repeated the same blocked outcome.
  const securityGateBlock = await readSecurityFixGateBlock(
    resolveSecurityGateStateDir(workDir),
    repo,
    issueNumber,
  );
  if (securityGateBlock) {
    deps.log(
      `Previous security-fix gate block found for #${issueNumber} (block ${securityGateBlock.blockCount}); injecting its missing evidence into the prompt (Issue #4057): ${
        securityGateBlock.missing.join(", ")
      }`,
    );
  }

  // --- Resolve verbosity level (Issue #1332) ---
  // The verbosity level controls how verbose Claude's response should be.
  // Two tiers since Issue #798: per-repo override > global default.
  const repoConfig = repoConfigs?.[repo];
  const verbosityLevel = resolveVerbosity(repoConfig);
  if (verbosityLevel !== "standard") {
    deps.log(
      `Verbosity level resolved to '${verbosityLevel}' from the ${repo} repo config (Issue #1332)`,
    );
  }

  // --- Build prompt (with SHA-based cache integration, Issue #1273) ---
  // When a prompt cache directory is configured, use the cached prompt builder
  // to avoid re-reading and re-assembling static templates on every invocation.
  // This also ensures byte-identical system prompts for Claude token caching.
  const promptCache = promptCacheDir
    ? new PromptCache({ cacheDir: promptCacheDir })
    : undefined;

  const promptResult = await deps.buildCachedIssuePrompt({
    repo,
    issueNumber: String(issueNumber),
    issueTitle,
    issueBody,
    issueLabels,
    qualityInstructions,
    customInstructions,
    screenshotRequired,
    skipScreenshotCheck,
    milestoneBranch: milestoneBranch || undefined,
    recentActivity,
    codebaseMap,
    ciFailureContext,
    ciFailureBoundaryId,
    securityGateBlock,
    cache: promptCache,
    logger,
    verbosityLevel,
    // Issue #849: an operator's `work-on` mapping replaces the built-in issue
    // template here too — this phase is a second entry point into the same
    // build, and skipping the overrides would silently run the built-in one.
    ...(promptOverrides ? { promptOverrides } : {}),
  });

  if (!promptResult.ok) {
    return {
      action: "failure",
      failureType: "execution_error",
      failureMessage: `Failed to build prompt: ${promptResult.error.message}`,
      elapsedSeconds: elapsedSince(startTime),
    };
  }

  // Extract structured prompt parts with cache metadata (Issue #1273).
  // Static content (coding guidelines) goes into the system prompt,
  // dynamic content (issue details) goes into the user prompt.
  const {
    systemPrompt,
    prompt: userPrompt,
    promptSha,
    cacheHit: promptCacheHit,
    templateSource: promptTemplate,
  } = promptResult.value;
  // Issue #849: the traceability record names the file, beside the commit.
  deps.log(`Issue prompt template: ${promptTemplate ?? "unknown"}`);

  // --- Context budget monitoring and hard ceiling (Issues #1327, #3713) ---
  // Estimate token counts for each major prompt component and log the budget
  // breakdown. Warnings and errors are observational; the ceiling is not —
  // at or above it the phase stops before any billed invocation and the
  // issue is handed to a human, so a non-converging issue is bounded by
  // context rather than by wall-clock alone.
  {
    const components = buildContextComponents({
      systemPrompt,
      userPrompt,
      issueBody,
      customInstructions,
      recentActivity,
      ciFailureContext,
    });

    const model = "opus"; // Phase model resolution happens downstream
    const budgetResult = checkContextBudget(components, model, {
      warningThresholdPercent: contextBudgetWarningPercent,
      errorThresholdPercent: contextBudgetErrorPercent,
      blockThresholdPercent: contextBudgetBlockPercent,
    });

    deps.log(formatBudgetBreakdown(budgetResult));

    if (budgetResult.warning) {
      deps.log(`WARN: ${budgetResult.warning}`);
    }
    if (budgetResult.error) {
      deps.log(`ERROR: ${budgetResult.error}`);
    }

    // Log budget entry for daily summary aggregation (fire-and-forget)
    if (creditLogDir) {
      const entry: BudgetLogEntry = {
        timestamp: new Date().toISOString(),
        repo,
        phase: "implementation",
        model,
        components: budgetResult.components,
        totalTokens: budgetResult.totalTokens,
        contextWindowSize: budgetResult.contextWindowSize,
        usagePercent: budgetResult.usagePercent,
        ...(budgetResult.warning ? { warning: budgetResult.warning } : {}),
        ...(budgetResult.error ? { error: budgetResult.error } : {}),
        ...(budgetResult.ok ? {} : { blocked: true }),
      };
      logContextBudget(creditLogDir, entry).catch(() => {
        /* Budget logging must never fail the main flow */
      });
    }

    if (!budgetResult.ok) {
      const failureMessage = buildContextBudgetEscalationReason(budgetResult);
      deps.log(`BLOCKED: ${failureMessage}`);
      const escalate = deps.escalateContextBudget ??
        defaultEscalateContextBudget;
      await escalate({
        repo,
        issueNumber,
        githubUser,
        needsHumanLabel,
        reason: failureMessage,
      });
      return {
        action: "failure",
        failureType: "context_budget",
        failureMessage,
        elapsedSeconds: elapsedSince(startTime),
      };
    }
  }

  // --- Record the prompt revision for traceability (Issue #197, #844) ---
  // Templates are no longer versioned by filename, so the checkout's commit
  // is what identifies the text this run used. A failure is logged loudly
  // rather than recorded as an unknown-but-fine revision.
  const promptsCommitResult = await deps.getPromptsCommit();
  if (!promptsCommitResult.ok) {
    deps.log(
      `WARNING: could not resolve the prompts commit — ${promptsCommitResult.error.message}`,
    );
  } else {
    deps.log(`Using prompts from commit ${promptsCommitResult.value}`);
  }
  const promptsCommit = promptsCommitResult.ok
    ? promptsCommitResult.value
    : undefined;

  // --- Validate repository state (Issue #621) ---
  deps.log("Validating repository state before Claude invocation...");
  const validationResult = await deps.validateRepoState(
    branchName,
    baseBranch,
    true,
  );
  if (!validationResult.ok) {
    return {
      action: "failure",
      failureType: "validation",
      failureMessage:
        `Repository state validation failed: ${validationResult.error.message}`,
      elapsedSeconds: elapsedSince(startTime),
    };
  }
  if (!validationResult.value.valid) {
    return {
      action: "failure",
      failureType: "validation",
      failureMessage:
        `Repository state validation failed for issue #${issueNumber} — cannot proceed safely`,
      elapsedSeconds: elapsedSince(startTime),
    };
  }

  // --- Start heartbeat ---
  // The initial record is awaited (Issue #1888); a failure is logged but
  // not fatal here — by the time this phase runs the worker has already
  // claimed the issue and is about to execute Claude. The periodic
  // refresh and stuck-issue detector still provide recovery if the
  // marker is never published.
  let heartbeatHandle: HeartbeatHandle | undefined;
  try {
    const heartbeatStart = await startHeartbeat({
      repo,
      issueNumber,
      workDir,
      recordFn: deps.recordHeartbeat,
      clearFn: deps.clearHeartbeat,
    });
    if (heartbeatStart.ok) {
      heartbeatHandle = heartbeatStart.value;
    } else {
      deps.log(
        `WARNING: Failed to start heartbeat (non-fatal): ${heartbeatStart.error.message}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`WARNING: Failed to start heartbeat (non-fatal): ${msg}`);
  }

  // --- Execute Claude ---
  deps.log("Starting Claude Code to work on the issue...");
  let claudeResult: Result<ClaudeRunResult>;
  try {
    claudeResult = await deps.runClaudeWithRetry(
      {
        prompt: userPrompt,
        systemPrompt,
        // Route the coding run through the documented `issue` phase (Issue
        // #2709) so model/effort resolve via the phase precedence chain
        // (CLAUDE_MODEL_ISSUE / phase_model_overrides.issue → PHASE_MODEL_DEFAULTS.issue,
        // CLAUDE_EFFORT_ISSUE / phase_effort_overrides.issue → PHASE_EFFORT_DEFAULTS.issue)
        // rather than silently landing on the CLI default.
        phase: "issue",
        timeoutSeconds: claudeTimeout,
        killAfterSeconds: claudeKillAfter,
        logger,
        creditLogDir,
        workerName,
        repo,
        promptSha,
        promptCacheHit,
        sessionResumeState,
        // Transcript tee file name (Issue #4169): agent-<runid>-<issue>.jsonl.
        issueNumber: options.issueNumber,
        // Per-invocation provider selection (Issue #4109); undefined keeps the
        // active provider, exactly as before.
        agentProvider: options.agentProvider,
        // Browser/network capability is granted on need, not by default
        // (Issue #192): only an issue that must produce screenshot evidence
        // gets the Playwright MCP server. A backend issue's agent has no
        // browser tool to be steered into by prompt injection.
        mcpConfig: screenshotRequired,
        // Opt-in only (Issue #4296) — absent, the hard timeout is unchanged.
        ...(options.progressExtension
          ? { progressExtension: options.progressExtension }
          : {}),
      },
      {
        maxRetries: maxRateLimitRetries,
        maxWaitSeconds: maxRateLimitWait,
      },
    );
  } finally {
    // Always stop heartbeat
    if (heartbeatHandle) {
      await stopHeartbeat(heartbeatHandle).catch(() => {
        deps.log("WARNING: Failed to stop heartbeat (non-fatal)");
      });
    }
  }

  const elapsedSeconds = elapsedSince(startTime);

  if (!claudeResult.ok) {
    return {
      action: "failure",
      failureType: "execution_error",
      failureMessage: `Claude execution failed: ${claudeResult.error.message}`,
      elapsedSeconds,
    };
  }

  const { exitCode, output: claudeOutput, timedOut, outOfMemory, killed } =
    claudeResult.value;

  // --- Handle out-of-memory (Issue #2742, parent #2721) ---
  // OOM is terminal and must be classified BEFORE the timeout / rate-limit
  // branch below: the runner reports an OOM with exitCode 137 (OOM_EXIT_CODE),
  // whose "heap limit" wording would otherwise be mistaken for a rate limit, or
  // a SIGKILL would be lumped in with timeouts. Waiting cannot reclaim memory,
  // so we fail fast with a dedicated, actionable diagnostic — while still
  // crediting a PR that an earlier turn managed to push before the OOM.
  if (outOfMemory) {
    deps.log(`Claude ran out of memory while working on issue #${issueNumber}`);

    const failureOutput = claudeOutput
      ? claudeOutput.split("\n").slice(-100).join("\n")
      : "";

    const failureMessage = buildOutOfMemoryMessage({ failureOutput });

    // Self-healing: an OOM late in the run may follow a pushed PR (Issue #386).
    const selfHealResult = await attemptPrSelfHealing(
      { repo, branchName, milestoneBranch, issueNumber, githubUser },
      deps,
    );

    if (selfHealResult.ok) {
      deps.log(
        `Issue #${issueNumber} has been addressed (PR found after out_of_memory)`,
      );
      return {
        action: "self_healed",
        prUrl: selfHealResult.value.prUrl,
        prNumber: selfHealResult.value.prNumber,
        elapsedSeconds,
        promptsCommit,
        promptTemplate,
        promptSha,
        promptCacheHit,
      };
    }

    return {
      action: "failure",
      failureType: "out_of_memory",
      failureMessage,
      elapsedSeconds,
      promptsCommit,
      promptTemplate,
      promptSha,
      promptCacheHit,
    };
  }

  // --- Handle a killed run (Issue #4202) ---
  // SIGKILL with no watchdog firing — the usual culprit is the VM's
  // out-of-memory killer. Used to be lumped into the timeout branch below,
  // asserting a false "timed out"; the SIGKILL wording now classifies as
  // `killed` (infrastructure), and the raw exit survives in the message.
  if (killed) {
    deps.log(
      `Claude was killed (SIGKILL, no watchdog) while working on issue #${issueNumber}`,
    );

    const failureOutput = claudeOutput
      ? claudeOutput.split("\n").slice(-100).join("\n")
      : "";

    // Self-healing: a kill late in the run may follow a pushed PR (#386).
    const selfHealResult = await attemptPrSelfHealing(
      { repo, branchName, milestoneBranch, issueNumber, githubUser },
      deps,
    );
    if (selfHealResult.ok) {
      deps.log(
        `Issue #${issueNumber} has been addressed (PR found after kill)`,
      );
      return {
        action: "self_healed",
        prUrl: selfHealResult.value.prUrl,
        prNumber: selfHealResult.value.prNumber,
        elapsedSeconds,
        promptsCommit,
        promptTemplate,
        promptSha,
        promptCacheHit,
      };
    }

    const rawExit = claudeResult.value.rawExitCode ?? exitCode;
    return {
      action: "failure",
      failureType: "killed",
      failureMessage: buildFailureMessage({
        failureType: "killed",
        failureReason:
          `was killed (exit ${rawExit}, SIGKILL — possible out-of-memory ` +
          `in the VM); no worker watchdog fired`,
        failureOutput,
        timeoutFailureSummary: "",
        diagnosticContent: "",
      }),
      elapsedSeconds,
      promptsCommit,
      promptTemplate,
      promptSha,
      promptCacheHit,
    };
  }

  // --- Handle timeout or rate-limit exhaustion ---
  // Only a genuine watchdog fire (`timedOut`) or the rate-limit give-up code
  // is a timeout/rate-limit here (Issue #4202): a child that exits 124 by
  // itself is no longer claimed as a timeout, and a bare 137 is `killed`.
  if (timedOut || exitCode === 2) {
    const failureType: ExecuteClaudeFailureType = (exitCode === 2)
      ? "rate_limit"
      : "timeout";
    // Honest timeout wording (Issue #4298): an extended run must not claim it
    // "timed out after 3600 seconds" when it ran for three hours. With no
    // extension telemetry the text is byte-identical to what it always was.
    const failureReason = (exitCode === 2)
      ? `hit rate limit after ${maxRateLimitRetries} retries (max wait: ${maxRateLimitWait}s)`
      : buildTimeoutFailureReason(claudeTimeout, claudeResult.value.extensions);

    deps.log(`Claude ${failureType} while working on issue #${issueNumber}`);

    // Extract tail output for diagnostics
    const failureOutput = claudeOutput
      ? claudeOutput.split("\n").slice(-100).join("\n")
      : "";

    // Build failure message
    const failureMessage = buildFailureMessage({
      failureType,
      failureReason,
      failureOutput,
      timeoutFailureSummary: "", // extracted from output file in shell — not available here
      diagnosticContent: "", // timeout diagnostic file content — handled separately
    });

    // Build diagnostic context for zero-output timeouts
    let diagnosticContext = "";
    if (!failureOutput) {
      diagnosticContext = buildDiagnosticContext({
        clarityStatus,
        elapsedSeconds,
        claudeNoOutputTimeout,
        claudeTimeout,
        // Extension history (Issue #4298), when the feature was active.
        ...(claudeResult.value.extensions
          ? { extensions: claudeResult.value.extensions }
          : {}),
      });
    }

    // Self-healing: check if Claude already created a PR (Issue #386)
    const selfHealResult = await attemptPrSelfHealing(
      { repo, branchName, milestoneBranch, issueNumber, githubUser },
      deps,
    );

    if (selfHealResult.ok) {
      deps.log(
        `Issue #${issueNumber} has been addressed (PR found after ${failureType})`,
      );
      return {
        action: "self_healed",
        prUrl: selfHealResult.value.prUrl,
        prNumber: selfHealResult.value.prNumber,
        elapsedSeconds,
        promptsCommit,
        promptTemplate,
        promptSha,
        promptCacheHit,
      };
    }

    return {
      action: "failure",
      failureType,
      failureMessage,
      diagnosticContext,
      elapsedSeconds,
      promptsCommit,
      promptTemplate,
      promptSha,
      promptCacheHit,
    };
  }

  // --- Check what changes Claude made ---
  const statusResult = await deps.runGitCommand(["status", "--porcelain"]);
  const hasUncommittedChanges = statusResult.ok &&
    statusResult.value.trim().length > 0;

  // Ensure enough history for the commit-range log on a shallow clone (Issue #1502)
  await ensureHistoryDepth([baseBranch, branchName]);
  const logResult = await deps.runGitCommand([
    "log",
    `${baseBranch}..${branchName}`,
    "--oneline",
  ]);
  const hasNewCommits = logResult.ok && logResult.value.trim().length > 0;

  if (hasNewCommits) {
    const commitCount = logResult.value.trim().split("\n").length;
    deps.log(`Claude made commits: ${commitCount} commit(s)`);
  }
  if (hasUncommittedChanges) {
    deps.log("Claude left uncommitted changes");
  }

  // --- Self-healing for no local changes (Issue #386, #585) ---
  if (!hasUncommittedChanges && !hasNewCommits) {
    // Check for existing PR
    const selfHealResult = await attemptPrSelfHealing(
      { repo, branchName, milestoneBranch, issueNumber, githubUser },
      deps,
    );

    if (selfHealResult.ok) {
      deps.log(
        `Issue #${issueNumber} has been addressed (PR found despite no local changes)`,
      );
      return {
        action: "self_healed",
        prUrl: selfHealResult.value.prUrl,
        prNumber: selfHealResult.value.prNumber,
        elapsedSeconds,
        promptsCommit,
        promptTemplate,
        promptSha,
        promptCacheHit,
      };
    }

    // Check remote branch for commits from a prior attempt (Issue #585).
    // `branchName` is an issue/PR identifier — a dash-leading value is the
    // Issue #12 remote-command class (`git fetch origin --upload-pack=…`).
    let fetchArgs: string[];
    try {
      fetchArgs = buildFetchArgs("origin", branchName);
    } catch (err: unknown) {
      return {
        action: "failure",
        failureType: "execution_error",
        failureMessage: err instanceof Error ? err.message : String(err),
        elapsedSeconds,
        promptsCommit,
        promptTemplate,
        promptSha,
        promptCacheHit,
      };
    }
    const fetchResult = await deps.runGitCommand(fetchArgs);
    if (fetchResult.ok) {
      // Ensure enough history for the commit-range log on a shallow clone (Issue #1502)
      await ensureHistoryDepth([baseBranch, `origin/${branchName}`]);
      const remoteLogResult = await deps.runGitCommand(
        ["log", `${baseBranch}..origin/${branchName}`, "--oneline"],
      );
      if (remoteLogResult.ok && remoteLogResult.value.trim().length > 0) {
        const remoteCommitCount =
          remoteLogResult.value.trim().split("\n").length;
        deps.log(
          `SELF-HEALING: Found ${remoteCommitCount} commit(s) on remote branch from prior attempt — ` +
            `resetting to remote (Issue #585)`,
        );
        await deps.runGitCommand([
          "reset",
          "--hard",
          "--end-of-options",
          `origin/${branchName}`,
        ]);
        return {
          action: "remote_self_healed",
          hasUncommittedChanges: false,
          hasNewCommits: true,
          elapsedSeconds,
          promptsCommit,
          promptTemplate,
          promptSha,
          promptCacheHit,
        };
      }
    }

    // No changes at all
    return {
      action: "no_changes",
      hasUncommittedChanges: false,
      hasNewCommits: false,
      elapsedSeconds,
      promptsCommit,
      promptTemplate,
      promptSha,
      promptCacheHit,
    };
  }

  // --- Success: Claude made changes ---
  return {
    action: "success",
    hasUncommittedChanges,
    hasNewCommits,
    elapsedSeconds,
    promptsCommit,
    promptTemplate,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/** Calculate elapsed seconds since a start timestamp. */
function elapsedSince(startTime: number): number {
  return Math.round((Date.now() - startTime) / 1000);
}

/** Build a Logger interface from a simple log function. */
function buildLoggerFromFn(logFn: (message: string) => void): Logger {
  return {
    info: (msg: string) => logFn(msg),
    warn: (msg: string) => logFn(`WARN: ${msg}`),
    error: (msg: string) => logFn(`ERROR: ${msg}`),
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}
