/**
 * Type definitions for the Vibe Coder worker.
 *
 * This module provides TypeScript interfaces for configuration,
 * commands, and workflow state.
 */

import type { CadencePolicy } from "./lib/idle_task_cadence.ts";
import type { RunMode } from "./lib/run_mode.ts";
import type { CallbacksConfig } from "./lib/run_callbacks_config.ts";

/**
 * Verbosity levels for configurable response output (Issue #1330).
 *
 * Part of #1329 (caveman mode). Controls how much detail Claude
 * includes in its responses for different task types and repositories.
 */
export type VerbosityLevel = "minimal" | "concise" | "standard" | "verbose";

/**
 * Where trusted-author / authorised-commenter allowlists come from
 * (Issue #252). `"config"` uses the local `.config.json` arrays (the
 * historical default). `"github"` will derive them from collaborators in
 * a later wiring sub-issue; this schema lands the selector only.
 */
export type AuthorSource = "github" | "config";

/**
 * How a host tracks Vibe Coder releases (Issue #622, part of #583).
 *
 * `"dynamic"` (the default, and what every existing host does) updates the
 * worker checkout and its tools to the latest. `"frozen"` holds the host at
 * `pinned_ref` with the exact tool versions in `pinned_tool_versions`.
 */
export type UpdateMode = "dynamic" | "frozen";

/**
 * Exact tool versions a frozen host installs (Issue #622, part of #583).
 *
 * Every entry is required under `update_mode: "frozen"` — a partially pinned
 * host would silently drift on whichever tool was left out. Ignored entirely
 * in `dynamic` mode, so a host can flip back without deleting its pins.
 */
export interface PinnedToolVersions {
  /** Exact Claude Code CLI version, e.g. `2.0.76`. */
  claude?: string;
  /** Exact GitHub CLI version, e.g. `2.62.0`. */
  gh?: string;
  /** Exact Deno version, e.g. `2.5.4`. */
  deno?: string;
}

/**
 * Worker configuration loaded from .config.json.
 */
export interface WorkerConfig {
  /** GitHub usernames authorised to create issues (Issue #137) */
  allowedAuthors: string[];
  /** @deprecated Use allowedAuthors instead. First author for backward compatibility */
  allowedAuthor: string;
  /** GitHub username to request as reviewer on PRs */
  prReviewer: string;
  /** GitHub usernames to request as reviewers on PRs (Issue #141) */
  prReviewers: string[];
  /** Repositories to monitor in "owner/repo" format */
  repos: string[];
  /**
   * Configured-label discovery tier (Issue #1834).
   * Hardwired to `[topPriorityLabel]` — the label-based collector iterates
   * this list. work-on and low-priority have dedicated, author-checked
   * collectors and are NOT included here.
   */
  issueLabels: string[];
  /** GitHub users authorised to trigger PR feedback fixes */
  authorisedCommenters: string[];
  /**
   * Source of the trusted-author / authorised-commenter allowlists
   * (Issue #252). Defaults to `"config"` so existing hosts keep today's
   * behaviour. `"github"` makes the local arrays optional and deprecated.
   */
  authorSource: AuthorSource;
  /**
   * Org team whose members are excluded from GitHub-derived allowlists
   * (Issue #252). `org/slug` (e.g. `stSoftwareAU/vibe-workers`).
   * Absent means team exclusion is off.
   */
  exclusionTeam?: string;
  /**
   * Allowlist of GitHub service-account logins the worker is permitted to
   * operate as (Issue #3528). The identity guard fails loud at startup and
   * before milestone writes when the resolved `gh` login is not on this list,
   * so a host whose auth has drifted to a human personal token cannot silently
   * act with that human's permissions. An allowlist, not a per-host key.
   * Empty (the default) leaves the guard inactive but loudly warned.
   */
  serviceAccounts: string[];
  /**
   * Custom `gh` config directory for the worker's service-account auth
   * (`.config.json` `gh_config_dir`, Issue #3530). Raw operator value —
   * a leading `~` is expanded when the env is applied. Empty means "use
   * ambient `gh` auth". Applied to `GH_CONFIG_DIR` by
   * `applyServiceAccountEnv` on the shared command path in `mod.ts`.
   */
  ghConfigDir: string;
  /**
   * SSH private-key path for service-account git pushes (`.config.json`
   * `ssh_key_path`, Issue #583/#3530). Raw operator value — a leading `~`
   * is expanded when the env is applied. Empty means "use ambient SSH
   * config". Applied to `GIT_SSH_COMMAND` by `applyServiceAccountEnv`.
   */
  sshKeyPath: string;
  /**
   * GitHub bot accounts whose PR review comments are auto-trusted (Issue #1856).
   *
   * Listed bots have their **PR review comments** (line-level, on
   * `/pulls/{n}/comments`) treated as authoritative without requiring a
   * thumbs-up reaction or membership in `authorisedCommenters`.
   * Issue comments (top-level discussion) still require a thumbs-up or
   * `authorisedCommenters` membership.
   */
  trustedReviewBots: string[];
  /**
   * GitHub logins of sibling fleet hosts whose open PRs this host should
   * also maintain (PR feedback + CI fixes). The host's own `githubUser`
   * is always covered implicitly; default `[]` keeps the prior
   * single-author behaviour. See `PrScanOptions.prAuthors` in
   * `lib/pr_maintenance.ts`.
   *
   * This is the **effective** list: `loadConfig` unions `service_accounts`
   * into it (Issue #209), because a service account is a fleet account by
   * definition. A fleet that named its siblings only under
   * `service_accounts` was previously invisible to every PR guard.
   */
  fleetPrAuthors: string[];
  /** Label to signal work on issues not created by allowedAuthor */
  workOnLabel: string;
  /** Label applied after first failure (issue will be retried) */
  failedOnceLabel: string;
  /** Label applied after second failure (issue permanently failed) */
  failedLabel: string;
  /** Label for collaborative issue refinement before implementation */
  refineIssueLabel: string;
  /** Directory where repos are cloned */
  workDir: string;
  /**
   * Where the worker runs (Issue #4146, `.config.json` `run_mode`).
   * `container` (the default) launches the worker inside the Vibe Coder
   * container; `native` is an explicit host opt-in for a host that cannot be
   * contained — e.g. one monitoring a repo whose build shells out to `docker`.
   * `VIBE_RUN_MODE` overrides it for one run. See `lib/run_mode.ts`.
   */
  runMode: RunMode;
  /**
   * How this host tracks Vibe Coder releases (Issue #622, part of #583,
   * `.config.json` `update_mode`). `dynamic` — the default, and what every
   * host did before the key existed — follows the latest; `frozen` holds the
   * host at {@link pinnedRef} with {@link pinnedToolVersions}.
   */
  updateMode: UpdateMode;
  /**
   * Commit SHA or tag the worker checkout is held at in `frozen` mode
   * (Issue #622, `.config.json` `pinned_ref`). Undefined in `dynamic` mode,
   * where a leftover pin is carried through but never acted on.
   */
  pinnedRef?: string;
  /**
   * Exact tool versions a `frozen` host installs (Issue #622, `.config.json`
   * `pinned_tool_versions`). Undefined in `dynamic` mode.
   */
  pinnedToolVersions?: PinnedToolVersions;
  /**
   * Active coding-agent provider id (Issue #4067, `.config.json`
   * `agent_provider`). The provider seam (`lib/agent_provider.ts`) resolves
   * the agent binary, its credential material, its child environment and its
   * invocation from this id. Defaults to `claude`.
   */
  agentProvider: string;
  /**
   * Every coding-agent provider enabled for this run (Issue #4108,
   * `.config.json` `agent_providers`). Each enabled provider gets its own
   * credential file, its own preflight check and its own read-only container
   * mount; a provider outside the set is never mounted, so no vendor can read
   * another's secret. Defaults to the active provider alone.
   */
  enabledAgentProviders: string[];
  /** Claude model ID to use (empty string means CLI default) (Issue #260) */
  claudeModel: string;
  /**
   * Configured best planning model (Issue #2654). The degraded-model detector
   * flags a planning run as degraded when a plan-generating response is served
   * by a model other than this. Empty (the default) means "derive the expected
   * model from the planning routing chain" — see DEFAULT_BEST_PLANNING_MODEL.
   * Operators pin a specific model globally here or per-repo via `repo_config`.
   */
  bestPlanningModel: string;
  /** Label for planning mode (task breakdown instead of implementation) */
  planningLabel: string;
  /** Label for question answering mode (Issue #287) */
  questionLabel: string;
  /** Label for needs-revision workflow (Issue #898) */
  needsRevisionLabel: string;
  /** Label for worker-to-human escalation (Issue #1469) */
  needsHumanLabel: string;
  /** Label for grill-me iterative-clarification workflow (Issue #1616) */
  grillMeLabel: string;
  /**
   * Label for the Quorum plan-off phase (Issue #4112, parent #4102).
   * Human-applied only — reserved so the worker never self-applies it.
   */
  quorumLabel: string;
  /**
   * Label marking issues as low priority (Issue #1723).
   * Reserved so the worker never self-applies it. Used by the priority
   * hierarchy collector and selector built in subsequent sub-issues of #1721.
   */
  lowPriorityLabel: string;
  /** Timeout in seconds for Claude CLI (default: 3600 = 1 hour, Issue #1824) */
  claudeTimeout: number;
  /**
   * Seconds of runway to the supervisor hard cap a new implementation claim
   * must have (`.config.json` `min_claim_runway_seconds`, Issues #289/#425).
   * `0` disables the floor. Environment variable `MIN_CLAIM_RUNWAY_SECONDS`
   * is the fallback when the key is absent — it does not cross the container
   * boundary, so only a native run can set it. See `lib/claim_runway.ts`.
   */
  minClaimRunwaySeconds: number;
  /**
   * Labels marking an issue as a long job for the adaptive claim floor
   * (`.config.json` `claim_long_job_labels`, Issue #245). An issue carrying
   * one is claimed only with a runway that can host a real execute, the same
   * as an issue with preserved WIP or a prior `timeout` in `execute`.
   * Optional: absent uses `DEFAULT_LONG_JOB_LABELS`.
   */
  claimLongJobLabels?: string[];
  /**
   * Extend the issue-work hard deadline while the run is demonstrably
   * progressing (Issue #4296, part of #4290; default: false).
   *
   * Optional so the 60-odd existing `WorkerConfig` literals stay valid;
   * `loadConfig` always populates it from `OPERATIONAL_DEFAULTS`.
   */
  progressExtensionEnabled?: boolean;
  /** Seconds each progress grant adds to the deadline (Issue #4296). */
  progressExtensionGrantSeconds?: number;
  /** Tool-activity stall window in seconds (Issue #4296). */
  progressExtensionStallSeconds?: number;
  /**
   * Seconds between progress samples — working tree and descendant CPU —
   * while a run is inside its budget (Issue #4295, Issue #508). Never longer
   * than `progressExtensionStallSeconds`.
   */
  progressExtensionCheckSeconds?: number;
  /**
   * Let the worker schedule its own auto-filed diagnostics (Issue #505;
   * default: true).
   *
   * An issue the worker filed about itself, in its own repo, carrying a
   * recognised provenance marker, becomes claimable without a human
   * applying `work-on`. Nothing is self-labelled: the claim scan gains a
   * tier (`collect_self_diagnostic_candidates.ts`), and the reserved-label
   * guards are untouched. `false` restores today's behaviour exactly — the
   * diagnostic waits for a human.
   *
   * Optional so the existing `WorkerConfig` literals stay valid;
   * `loadConfig` always populates it from `OPERATIONAL_DEFAULTS`.
   */
  selfScheduleDiagnosticsEnabled?: boolean;
  /**
   * How many self-scheduled diagnostics may be in flight at once
   * (Issue #505, default: 1). A misfiring detector cannot fill the queue
   * with its own work; the surplus is refused and logged.
   */
  selfScheduleDiagnosticsMaxInFlight?: number;
  /**
   * Timeout in seconds for the PR feedback phase (Issue #1824, default: 1800 = 30 min).
   * A single PR comment cannot reasonably need more than 30 minutes —
   * keeping this distinct from `claudeTimeout` prevents reactive phases
   * from inheriting the larger issue-work budget.
   */
  prFeedbackTimeout: number;
  /**
   * Timeout in seconds for the CI fix phase (Issue #1824, default: 1800 = 30 min).
   * Failed annotation sets are bounded — keeping this distinct from
   * `claudeTimeout` prevents reactive phases from inheriting the larger
   * issue-work budget.
   */
  ciFixTimeout: number;
  /** Seconds to wait after SIGTERM before SIGKILL for Claude process */
  claudeKillAfter: number;
  /** Maximum clarification rounds before auto-proceeding */
  maxClarificationRounds: number;
  /** Seconds between issue scans */
  sleepInterval: number;
  /** Maximum issues worked concurrently per host (Issue #4174; default 1). */
  maxConcurrentIssues: number;
  /** Seconds to wait when credits are exhausted */
  creditWaitInterval: number;
  /** Timeout in seconds for issue refinement */
  refinementTimeout: number;
  /** Seconds to wait after SIGTERM for refinement process */
  refinementKillAfter: number;
  /** Timeout in seconds for planning mode */
  planningTimeout: number;
  /** Seconds to wait after SIGTERM for planning process */
  planningKillAfter: number;
  /** Timeout in seconds for question answering (Issue #287) */
  questionTimeout: number;
  /** Seconds to wait after SIGTERM for question process (Issue #287) */
  questionKillAfter: number;
  /** Timeout in seconds for clarification rounds */
  clarificationTimeout: number;
  /** Seconds to wait after SIGTERM for clarification process */
  clarificationKillAfter: number;
  /** Maximum grill-me iterative-clarification rounds (Issue #1616) */
  maxGrillMeRounds: number;
  /** Timeout in seconds for a single grill-me round (Issue #1616) */
  grillMeTimeout: number;
  /** Seconds to wait after SIGTERM before SIGKILL for the grill-me process (Issue #1616) */
  grillMeKillAfter: number;
  /** Wall-clock budget in seconds for one Quorum agent (Issue #4112) */
  quorumTimeout: number;
  /** Grace in seconds after quorumTimeout before the agent is killed (Issue #4112) */
  quorumKillAfter: number;
  /**
   * The two drafting providers of a Quorum run (Issue #4112).
   * Exactly two ids; both default to the active provider so the wiring lands
   * behind a Claude-only default until multi-vendor credentials exist.
   */
  quorumPlanners: string[];
  /** The adjudicating provider of a Quorum run (Issue #4112) */
  quorumJudge: string;
  /** Maximum retries when rate limited */
  maxRateLimitRetries: number;
  /** Maximum total wait time in seconds for rate limit retries */
  maxRateLimitWait: number;
  /** Maximum delay in seconds between retries */
  retryMaxDelay: number;
  /** Maximum tokens in issue body before summarisation */
  maxIssueBodyTokens: number;
  /** Timeout in seconds for summarisation */
  summariseTimeout: number;
  /** Seconds to wait after SIGTERM for summarisation process */
  summariseKillAfter: number;
  /** Timeout in seconds for feature availability checks */
  featureCheckTimeout: number;
  /** Seconds with zero output before early termination (Issue #384) */
  claudeNoOutputTimeout: number;
  /** Timeout in seconds for quality.sh execution (default: 600) */
  qualityCheckTimeout: number;
  /** TTL in seconds for health check cache (Issue #1070) */
  healthCacheTtl: number;
  /** When true, repos are shuffled; when false, scanned in configured order (Issue #435) */
  shuffleRepos: boolean;
  /** Optional human-readable worker name for multi-worker visibility (Issue #436) */
  workerName: string;
  /** Whether to attempt cheaper model fallback on rate limit (Issue #1113, default: true) */
  enableModelFallback: boolean;
  /** Minimum free disk space in MB before large git operations (Issue #1174, default: 500) */
  minDiskSpaceMb: number;
  /**
   * Gigabyte term of the claiming floor (Issue #732). Unset → the
   * `VIBE_HOST_DISK_LOW_FLOOR_GB` override, else 20.
   */
  hostDiskLowFloorGb?: number;
  /**
   * Percentage term of the claiming floor (Issue #732). Unset → the
   * `VIBE_HOST_DISK_LOW_FLOOR_PERCENT` override, else 10. The floor is the
   * larger of the two terms.
   */
  hostDiskLowFloorPercent?: number;
  /** Whether to periodically sync milestone branches with the default branch (Issue #1238, default: true) */
  syncMilestoneBranches: boolean;
  /** Cooldown in seconds between sync attempts for the same milestone (Issue #1238, default: 3600) */
  milestoneSyncCooldownSeconds: number;
  /** Days before posting a diagnostic on stale failed issues (Issue #1240) */
  staleFailedDiagnosticDays: number;
  /** Days before warning about stuck planning issues (Issue #1240) */
  stalePlanningWarningDays: number;
  /** Per-phase model tier overrides from .config.json (Issue #1265) */
  phaseModelOverrides: Record<string, string>;
  /** Per-phase effort level overrides from .config.json (Issue #1403) */
  phaseEffortOverrides: Record<string, string>;
  /** Per-phase Codex model overrides from .config.json (Issue #363) */
  codexPhaseModelOverrides: Record<string, string>;
  /** Per-phase Codex effort overrides from .config.json (Issue #363) */
  codexPhaseEffortOverrides: Record<string, string>;
  /** Per-phase Gemini model overrides from .config.json (Issue #364) */
  geminiPhaseModelOverrides: Record<string, string>;
  /** Per-phase DeepSeek model overrides from .config.json (Issue #413) */
  deepseekPhaseModelOverrides: Record<string, string>;
  /** Whether to include recent repo activity in prompts (Issue #1326, default: true) */
  includeRecentActivity: boolean;
  /** Maximum number of merged PRs to include in activity summary (Issue #1326) */
  recentActivityMergedPrLimit: number;
  /** Maximum number of commits to include in activity summary (Issue #1326) */
  recentActivityCommitLimit: number;
  /** Maximum token budget for the activity summary (Issue #1326) */
  recentActivityMaxTokens: number;
  /** Cache TTL in seconds for recent activity data (Issue #1326) */
  recentActivityCacheTtlSeconds: number;
  /**
   * Whether to inject the generated codebase map into prompts
   * (Issue #4281, default: true)
   */
  includeCodebaseMap: boolean;
  /**
   * Cache TTL in seconds for the issue-timeline cache (Issue #1673).
   * Used by label-authorship checks (`wasLabelAddedByAllowedAuthor`,
   * `getLabelLastAddInfo`). Defaults to 300 seconds (5 minutes).
   */
  timelineCacheTtlSeconds: number;
  /** Whether to enable CLI session resume across phases of the same issue (Issue #1324, default: false) */
  enableSessionResume: boolean;
  /** Global verbosity level override (Issue #1330, default: "standard") */
  verbosity: VerbosityLevel;
  /** Warning threshold percentage for context window budget (Issue #1327, default: 50) */
  contextBudgetWarningPercent: number;
  /** Error threshold percentage for context window budget (Issue #1327, default: 80) */
  contextBudgetErrorPercent: number;
  /**
   * Hard blocking threshold percentage for the context window budget
   * (Issue #3713, default: 95). `0` disables the ceiling.
   */
  contextBudgetBlockPercent: number;
  /** Whether to include untrusted comments in prompts (Issue #1340, default: true — include with trust annotations) */
  includeUntrustedComments: boolean;
  /** Cooldown in seconds for recently-closed PR blocking (Issue #1427, default: 3600) */
  closedPrCooldownSeconds: number;
  /** Whether to unassign the worker from the source issue after successful PR creation (Issue #1453, default: true) */
  unassignOnPrCreated: boolean;
  /** Age threshold in days before a repo work directory with no heartbeat is removed (Issue #1493, default: 7) */
  staleWorkDirDays: number;
  /** Maximum retry attempts for a single software update command (Issue #1496, default: 3) */
  updateRetryMaxAttempts: number;
  /** Exponential backoff delays in seconds between software update retries (Issue #1496, default: [30, 90, 300]) */
  updateRetryBackoffSeconds: number[];
  /** Maximum auto-fix attempts per PR CI failure signature before escalating (Issue #3582, default: 3) */
  maxAutoFixAttempts: number;
  /**
   * Seconds a PR blocking a `work-on` issue may sit red — or with an
   * unanswered authorised comment — before the stall watchdog escalates
   * it (Issue #4025, default: 7200). Per-repo override is honoured via
   * `repoConfig[repo].blockingPrStallThresholdSeconds`.
   */
  blockingPrStallThresholdSeconds?: number;
  /**
   * Whether the worker's quality gate compares post-Claude diffable
   * findings (mermaid, markdownlint, docs prompt-version) against the
   * baseline captured before Claude started, and treats the gate as
   * passed when no new findings were introduced (Issue #1549, generalised
   * by #2604, default: true). Per-repo override is honoured via
   * `repoConfig[repo].baselineAwareQualityGate`.
   */
  baselineAwareQualityGate: boolean;
  /**
   * Backoff in milliseconds before an in-process retry of an infrastructure-
   * category phase failure (Issue #1550, default: 15000). Set to 0 in tests
   * to skip the delay.
   */
  infraRetryBackoffMs: number;
  /**
   * Per-template weights for the idle-task draw (Issue #2401).
   *
   * Maps an idle-task template slug (e.g. `security-scan`) to a relative
   * weight in the weighted random draw the idle-task filer uses to pick the
   * next template. A higher weight biases the draw toward that template.
   * Templates absent from the map — or given a non-positive or non-finite
   * weight — take a baseline weight of 1, so naming only the templates to
   * boost is sufficient. When no template has a positive weight (the default
   * empty map, or an all-zero map) the draw falls back to a uniform pick,
   * preserving the pre-#2401 behaviour.
   */
  idleTaskTemplateWeights: Record<string, number>;
  /**
   * Cadence floor for the important idle-task templates (Issues #4003, #4011).
   *
   * Which templates are guaranteed a scan, over which rolling windows, and at
   * which model tier is a spend decision, so it is operator-only configuration
   * read from the `.config.json` `idle_task_cadence` block (#2625/#2626) and
   * validated by `parseIdleTaskCadence()` in `lib/idle_task_cadence_config.ts`.
   * Defaults to the converged #4003 policy: `security-scan`,
   * `supply-chain-readiness` and `github-actions-audit`, weekly `sonnet` and
   * monthly `fable`, over 7- and 30-day windows. `enabled: false` is the single
   * kill switch reverting the filer to a pure random pick.
   */
  idleTaskCadence: CadencePolicy;
  /**
   * Per-tool minimum version floors for software auto-update (Issue #2622).
   * When the installed version of a tool is below its floor, the update runs
   * immediately, bypassing the interval gate. Default: `{ claude: "2.1.170" }`.
   */
  softwareMinVersions: Record<string, string>;
  /**
   * Post-run callbacks — the public extension contract (Issue #806).
   *
   * Optional absolute executable paths run after a terminal issue run:
   * `success` or `failure`, then `always`. Validated by
   * `parseCallbacksConfig()` in `lib/run_callbacks_config.ts`, which fails the
   * config load on any fault so a hook an operator believes is wired can never
   * silently never run.
   */
  callbacks: CallbacksConfig;
  /** Per-repo configuration overrides (Issue #1187) */
  repoConfig?: Record<string, RepoConfig>;
}

/**
 * GitHub issue representation.
 */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  assignees: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * GitHub PR comment representation.
 */
export interface GitHubComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  reactions: {
    thumbsUp: number;
    eyes: number;
    confused: number;
  };
}

/**
 * Discriminated union Result type for consistent error handling (Issue #223).
 *
 * Enables type-safe error handling without try/catch:
 * ```typescript
 * const result = registry.register(command);
 * if (!result.ok) {
 *   console.error(result.error.message);
 *   return;
 * }
 * // result.value is typed here
 * ```
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Result of a command execution.
 *
 * Generic type parameter allows commands to specify their data type (Issue #223):
 * ```typescript
 * const result: CommandResult<VersionInfo> = {
 *   success: true,
 *   message: "v1.0.0",
 *   data: { version: "1.0.0", runtime: "Deno" },
 * };
 * ```
 */
export interface CommandResult<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  /**
   * Process exit status when this result is the CLI's own outcome
   * (Issue #4441).
   *
   * Almost every command wants the default — 0 on success, 1 on failure — and
   * leaves this undefined. It exists for commands whose caller must tell two
   * *correct* outcomes apart: `container-build-heal` exits 3 to say "this
   * build failure is not one I heal", which is a different instruction to the
   * launcher than either "healed, retry" (0) or "the heal itself failed" (1).
   */
  exitCode?: number;
}

/**
 * Command handler interface for extendable commands.
 *
 * This allows the worker to be extended with custom commands
 * by implementing this interface.
 */
export interface Command {
  /** Unique command name (e.g., "process-issue", "fix-spelling") */
  name: string;
  /** Human-readable description of what this command does */
  description: string;
  /**
   * Execute the command.
   * @param args Command-specific arguments
   * @param config Worker configuration
   * @returns Result of the command execution
   */
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult>;
}

/**
 * Structured context for log messages (key=value pairs).
 */
export type LogContext = Record<string, unknown>;

/**
 * Logger interface for consistent logging across the worker.
 *
 * Issue #906: Extended with structured logging for skip reasons, timing
 * metrics, scan summaries, and worker summaries (migrated from logging.sh).
 */
export interface Logger {
  /** Log informational message with optional structured context */
  info(message: string, context?: LogContext): void;
  /** Log warning message with optional structured context */
  warn(message: string, context?: LogContext): void;
  /** Log error message with optional structured context */
  error(message: string, context?: LogContext): void;
  /** Log debug message (only shown when log level allows) with optional structured context */
  debug(message: string, context?: LogContext): void;
  /** Log security-related event (always logged regardless of level) */
  security(event: string, details: string): void;
  /** Log structured skip reason at DEBUG level (Issue #627) */
  skipReason(reasonCode: string, details: string): void;
  /** Log operation timing metrics at INFO level (Issue #627) */
  timing(operation: string, durationSeconds: number, details?: string): void;
  /** Log scan cycle summary at INFO level (Issue #627) */
  scanSummary(
    reposScanned: number,
    issuesFound: number,
    issuesSkipped: number,
    skipReasons?: string,
  ): void;
  /** Log worker run summary at INFO level (Issue #627) */
  workerSummary(issuesProcessed: number, durationSeconds: number): void;
}

/**
 * GitHub API client interface.
 */
export interface GitHubClient {
  /** Get issue details by number */
  getIssue(repo: string, issueNumber: number): Promise<GitHubIssue>;
  /** Get comments on an issue */
  getIssueComments(repo: string, issueNumber: number): Promise<GitHubComment[]>;
  /** Add a label to an issue */
  addLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  /** Remove a label from an issue */
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  /**
   * Post a comment on an issue or PR.
   *
   * Issue #1843: returns the created `GitHubComment` (id, body, author,
   * createdAt) when the REST POST succeeds so callers can append the
   * comment to an in-memory list instead of refetching the full
   * comment thread. Returns `undefined` when the body has no visible
   * content (skipped) or when the gh response could not be parsed
   * (legacy fallback path).
   */
  postComment(
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubComment | undefined>;
  /** Edit issue title and/or body */
  editIssue(
    repo: string,
    issueNumber: number,
    updates: { title?: string; body?: string },
  ): Promise<void>;
  /** Assign users to an issue */
  assignIssue(
    repo: string,
    issueNumber: number,
    assignees: string[],
  ): Promise<void>;
  /** Unassign users from an issue */
  unassignIssue(
    repo: string,
    issueNumber: number,
    assignees: string[],
  ): Promise<void>;
  /** Close an issue with an optional comment (Issue #1364) */
  closeIssue(
    repo: string,
    issueNumber: number,
    comment?: string,
  ): Promise<void>;
}

/**
 * Per-repo configuration selecting a CI log provider (Issue #3579).
 *
 * One entry names a registered {@link "./lib/ci_log_provider.ts" CiLogProvider}
 * by id and carries that provider's options. GitHub Actions is the built-in
 * default and needs no entry; external CI systems (Jenkins first) are
 * configured here.
 */
export interface CiProviderConfig {
  /** Registered provider id, e.g. `jenkins` or `github-actions`. */
  provider: string;
  /**
   * Optional regex matching the failing PR check this provider handles.
   * Each provider supplies its own default when omitted.
   */
  checkNamePattern?: string;
  /**
   * Jenkins job path naming the folders and job in order, e.g.
   * `example-org/private-repo-58/Develop`. `buildJenkinsUrl()` inserts the
   * `/job/` separators, so the expanded form
   * (`example-org/private-repo-26/ST-pipeline/job/Develop`) is accepted too.
   * Required when `provider` is `jenkins`; ignored by other providers.
   *
   * Used as the fallback: when the failing check's `target_url` names a
   * job in this same folder (as a Jenkins PR check does), that job wins,
   * because pairing a URL build number with this configured path would
   * fetch a real but unrelated build.
   */
  jobPath?: string;
}

/**
 * Action the worker should take when a PR build fails (Issue #1890).
 *
 * @deprecated Superseded by {@link CiProviderConfig} / `ciProviders`
 * (Issue #3579). Still parsed and converted into an equivalent
 * `ciProviders` entry, so existing `.config.json` files keep working
 * unchanged; new configuration should use `ciProviders`.
 */
export type PrFailureAction = {
  /** Discriminator. Currently the only supported variant. */
  type: "fetch-jenkins-log";
  /**
   * Jenkins job path, e.g. `example-org/private-repo-58/Develop` (the
   * expanded `example-org/private-repo-26/ST-pipeline/job/Develop` form is accepted
   * too). Forwarded to the Jenkins log fetcher when this action fires.
   */
  jobPath: string;
  /**
   * Optional regex matching the failing PR check whose log should be
   * fetched. Defaults to a case-insensitive match on `jenkins` when
   * omitted.
   */
  checkNamePattern?: string;
};

/**
 * Repository configuration for per-repo settings.
 */
export interface RepoConfig {
  /** Command to run before Claude starts working */
  preSetupCommand?: string;
  /** When true, skips running quality checks */
  skipQualityCheck?: boolean;
  /** Custom command to run instead of ./quality.sh */
  qualityCommand?: string;
  /** Additional instructions for Claude */
  customInstructions?: string;
  /** When true, disables auto squash merge */
  skipAutoMerge?: boolean;
  /** When true, skips requesting reviewers on PRs (Issue #147) */
  skipReviewerRequest?: boolean;
  /** When true, skips screenshot validation in PR completion (Issue #1185) */
  skipScreenshotCheck?: boolean;
  /**
   * When true, skips the security-fix patch-verification gate on PRs that
   * close a `security`-labelled finding (Issue #3540).
   */
  skipSecurityFixCheck?: boolean;
  /**
   * Credentials this repository's own checks need (Issues #573, #574).
   *
   * Scoped here rather than ambient: since Issue #572 the child environment
   * is built from an allowlist, so a repository whose quality gate needs a
   * cloud credential declares it and only that repository receives it.
   * Prefer `mint` — a credential that expires cannot be spent by a leak.
   */
  qualityCredentials?: {
    /** Command whose stdout is `KEY=value` lines, run once per use. */
    mint?: string;
    /** Names taken from the worker's environment. Long-lived; declared. */
    passthrough?: string[];
  };
  /** Docker image for running quality checks in a container (Issue #1228) */
  dockerImage?: string;
  /** Per-repo quality check timeout in seconds (Issue #1228) */
  qualityCheckTimeout?: number;
  /** Per-repo override of the auto-fix attempt cap (Issue #3582) */
  maxAutoFixAttempts?: number;
  /**
   * Per-repo override of the blocking-PR stall threshold in seconds
   * (Issue #4025). Non-positive or non-integer values fall back to the
   * global `blocking_pr_stall_threshold_seconds`.
   */
  blockingPrStallThresholdSeconds?: number;
  /** Per-repo verbosity level override (Issue #1330) */
  verbosity?: "minimal" | "concise" | "standard" | "verbose";
  /**
   * Per-repo `nice` value (Issue #2772, part of #2771). Unix-`nice`
   * semantics: **lower = worked sooner**; default `0` (see
   * `DEFAULT_REPO_NICE`). Operator-side only — read from `.config.json`
   * `repo_config.<owner/repo>`, never from the target repo (Issue #2626).
   *
   * Distinct from the failure-based `isRepoDeprioritised`
   * (`repo_failure_tracker.ts`): `nice` is a static operator preference,
   * not a transient per-cycle penalty. Resolve via `getRepoNice()`.
   */
  nice?: number;
  /**
   * Per-repo override for the baseline-aware quality gate (Issue #1549).
   * Defaults to the global `baselineAwareQualityGate` when omitted.
   */
  baselineAwareQualityGate?: boolean;
  /**
   * CI log providers the worker consults when a PR build fails
   * (Issue #3579). Opt-in; omit to use the built-in GitHub Actions
   * provider alone. Validated via `parseCiProviders()` in
   * `repo_config.ts`.
   */
  ciProviders?: CiProviderConfig[];
  /**
   * Actions the worker should take when a PR build fails (Issue #1890).
   *
   * @deprecated Use `ciProviders` (Issue #3579). Existing entries are
   * still validated via `parsePrFailureActions()` in `repo_config.ts`
   * and converted into equivalent `ciProviders` entries, so no repo's
   * `.config.json` breaks on upgrade.
   */
  prFailureActions?: PrFailureAction[];
  /**
   * Mandatory pre-flight commands run in the repo working tree immediately
   * before the worker's automated commit (Issue #3577). Optional — omit or
   * use an empty array to disable the gate, in which case the repo runs
   * exactly as it does today with zero added latency.
   *
   * When set, every command runs in listed order at the same chokepoint as
   * `assertSafeToCommit()`; the **first non-zero exit blocks BOTH the commit
   * and the push**. There is deliberately no override/force flag and no
   * environment escape hatch. A command that is missing, not executable,
   * cannot be started, or times out is treated as a **block**, never a pass
   * ("could not run the check" is never "check passed" — Issue #3577,
   * carried over from Migration_v21#563).
   *
   * Stored untyped because it arrives from `.config.json`; validated by
   * `parsePreFlightCommands()` in `repo_config.ts` (rejects a malformed
   * entry loudly at config load, following the `prFailureActions`
   * precedent).
   */
  preFlight?: string[];
  /**
   * Issue labels that mark an issue as a CI-failure report (Issue #3581),
   * e.g. `["develop-build-failure"]`. Opt-in; omit or use an empty array to
   * disable. When an issue carries one of these labels the worker parses the
   * build reference out of the issue body, fetches the full console log, and
   * routes to the CI diagnosis-and-fix prompt instead of the generic
   * implementation prompt.
   *
   * Stored untyped-ish because it arrives from `.config.json`; validated by
   * `parseCiFailureLabels()` in `repo_config.ts`.
   */
  ciFailureLabels?: string[];
  /**
   * Fallback Jenkins job path (e.g. `Migration/job/Develop`) used when a
   * CI-failure issue body carries a build number but no `Build URL`
   * (Issue #3581). Without it, a build-number-only body cannot be fetched
   * and the run is told so explicitly.
   */
  ciFailureJobPath?: string;
  /**
   * Per-repo base Claude model tier (Issue #2625). Alias (e.g. `"fable"`,
   * `"sonnet"`, `"opus"`) or a full model id. Overrides the global base model
   * for every phase in this repo, but is itself overridden by a per-repo phase
   * model override and by a phase-specific `CLAUDE_MODEL_<PHASE>` env var.
   *
   * ⚠️ This base tier sits **above** every per-phase `PHASE_MODEL_DEFAULTS`
   * entry, so it overrides *all* of them — not just the implementation phase
   * (Issue #2716, audit #2702 F2/F3). Setting it cheaply (e.g. `"sonnet"`)
   * silently demotes `planning`/`grill_me` off the Fable top tier; setting it
   * to `"fable"` silently promotes the trivial Haiku phases
   * (`spelling_fix`/`summarise`/`health`) to Fable (~5× their intended cost).
   * Re-pin individual phases via `phaseModelOverrides` to keep them on their
   * own tier. A one-line note is logged on repo switch when this happens.
   *
   * Operator-only — a spend decision that must stay in `.config.json`. There
   * is no in-repo configuration mechanism (Issue #2626 removed `.vibecoder.json`),
   * so a repo can never self-upgrade itself to a premium model.
   */
  claudeModel?: string;
  /**
   * Per-repo configured best planning model (Issue #2654). Overrides the global
   * `best_planning_model` for this repo's degraded-model detection. Empty or
   * omitted falls back to the global value. Operator-only — configured in
   * `.config.json` (no in-repo config mechanism — Issue #2626).
   */
  bestPlanningModel?: string;
  /**
   * Per-repo per-phase model overrides (Issue #2625). Same shape as the global
   * `phase_model_overrides` key, but scoped to this repo. Operator-only —
   * configured in `.config.json` (no in-repo config mechanism — Issue #2626).
   */
  phaseModelOverrides?: Record<string, string>;
  /**
   * Per-repo per-phase effort overrides (Issue #2625). Same shape as the global
   * `phase_effort_overrides` key, but scoped to this repo. Operator-only —
   * configured in `.config.json` (no in-repo config mechanism — Issue #2626).
   */
  phaseEffortOverrides?: Record<string, string>;
  /**
   * Per-repo base Codex model tier (Issue #363) — the Codex counterpart of
   * `claudeModel`. Overrides {@link CODEX_PHASE_MODEL_DEFAULTS} for every phase
   * in this repo, and is itself overridden by `codexPhaseModelOverrides` and by
   * a phase-specific `CODEX_MODEL_<PHASE>` env var. Operator-only.
   */
  codexModel?: string;
  /**
   * Per-repo per-phase Codex model overrides (Issue #363). Same shape as the
   * global `codex_phase_model_overrides` key, but scoped to this repo.
   * Operator-only.
   */
  codexPhaseModelOverrides?: Record<string, string>;
  /**
   * Per-repo per-phase Codex reasoning-effort overrides (Issue #363). Same
   * shape as the global `codex_phase_effort_overrides` key, but scoped to this
   * repo. Operator-only.
   */
  codexPhaseEffortOverrides?: Record<string, string>;
  /**
   * Per-repo base Gemini model tier (Issue #364) — the Gemini counterpart of
   * `claudeModel`. Overrides {@link GEMINI_PHASE_MODEL_DEFAULTS} for every
   * phase in this repo, and is itself overridden by
   * `geminiPhaseModelOverrides` and by a phase-specific `GEMINI_MODEL_<PHASE>`
   * env var. Operator-only.
   */
  geminiModel?: string;
  /**
   * Per-repo per-phase Gemini model overrides (Issue #364). Same shape as the
   * global `gemini_phase_model_overrides` key, but scoped to this repo.
   * Operator-only. There is no Gemini effort counterpart: the Gemini CLI has
   * no reasoning-effort option, and an effort requested for a Gemini phase is
   * reported loudly rather than configured.
   */
  geminiPhaseModelOverrides?: Record<string, string>;
  /**
   * Per-repo base DeepSeek model tier (Issue #413) — the DeepSeek counterpart
   * of `claudeModel`. Overrides {@link DEEPSEEK_PHASE_MODEL_DEFAULTS} for every
   * phase in this repo, and is itself overridden by
   * `deepseekPhaseModelOverrides` and by a phase-specific
   * `DEEPSEEK_MODEL_<PHASE>` env var. Operator-only.
   */
  deepseekModel?: string;
  /**
   * Per-repo per-phase DeepSeek model overrides (Issue #413). Same shape as the
   * global `deepseek_phase_model_overrides` key, but scoped to this repo.
   * Operator-only. There is no DeepSeek effort counterpart: DeepSeek's
   * Anthropic-compatible endpoint has no effort control, and an effort
   * requested for a DeepSeek phase is reported loudly rather than configured.
   */
  deepseekPhaseModelOverrides?: Record<string, string>;
}

/**
 * Full configuration file structure.
 *
 * Issue #277: All configuration is now stored in .config.json.
 * Only values that differ from built-in defaults need to be present.
 */
export interface ConfigFile {
  /** GitHub usernames authorised to create issues (Issue #137) */
  allowed_authors?: string[];
  /** GitHub usernames to request as reviewers on PRs (Issue #141) */
  pr_reviewers?: string[];
  repos?: string[];
  authorized_commenters?: string[];
  /**
   * `"github"` derives allowlists from collaborators; `"config"` uses the
   * local arrays. Default `"config"` (Issue #252).
   */
  author_source?: AuthorSource;
  /**
   * Org team excluded from GitHub-derived allowlists, `org/slug`
   * (Issue #252). Absent means team exclusion is off.
   */
  exclusion_team?: string;
  /**
   * Allowlist of GitHub service-account logins the worker may operate as
   * (Issue #3528). Drives the fail-loud identity guard.
   */
  service_accounts?: string[];
  /** Bot accounts whose PR review comments are auto-trusted (Issue #1856) */
  trusted_review_bots?: string[];
  /**
   * GitHub logins of sibling fleet hosts whose open PRs this host should
   * also maintain (PR feedback + CI fixes). Each host lists the *other*
   * fleet identities (its own login is always covered implicitly).
   */
  fleet_pr_authors?: string[];
  // Issue #1834: `issue_labels`, `work_on_label`, and `low_priority_label`
  // removed. The three discovery labels (top-priority, work-on,
  // low-priority) are hardwired in `lib/config_defaults.ts` and may not
  // be overridden via .config.json.
  failed_once_label?: string;
  failed_label?: string;
  refine_issue_label?: string;
  planning_label?: string;
  question_label?: string;
  needs_revision_label?: string;
  /** Label for worker-to-human escalation (Issue #1469) */
  needs_human_label?: string;
  /** Label for grill-me iterative-clarification workflow (Issue #1616) */
  grill_me_label?: string;
  /** Label for the Quorum plan-off phase (Issue #4112) */
  quorum_label?: string;
  repo_config?: Record<string, RepoConfig>;
  /**
   * Where the worker runs (Issue #4146) — `container` (the default) or
   * `native`, the explicit opt-in for a host that cannot be contained.
   * `VIBE_RUN_MODE` overrides it for one run.
   */
  run_mode?: string;
  /**
   * How this host tracks Vibe Coder releases (Issue #622, part of #583).
   * Absent means `"dynamic"` — the behaviour of every host before the key
   * existed.
   */
  update_mode?: UpdateMode;
  /**
   * Commit SHA or tag the worker checkout is held at (Issue #622). Required
   * under `update_mode: "frozen"`; ignored in `dynamic` mode.
   */
  pinned_ref?: string;
  /**
   * Exact tool versions a frozen host installs (Issue #622). All three
   * entries are required under `update_mode: "frozen"`; ignored in `dynamic`
   * mode.
   */
  pinned_tool_versions?: PinnedToolVersions;
  /** Claude model ID to use (Issue #260) */
  /**
   * Coding-agent provider id (Issue #4067) — the provider seam resolves the
   * binary, credentials, environment and invocation from it. Defaults to
   * `claude`; `VIBE_AGENT_PROVIDER` overrides it for one run.
   */
  agent_provider?: string;
  /**
   * Providers enabled for a run (Issue #4108) — each gets its own credential
   * file, preflight check and read-only mount. Defaults to the active
   * provider alone; `VIBE_AGENT_PROVIDERS` overrides it for one run.
   */
  agent_providers?: string[];
  claude_model?: string;
  /** Configured best planning model for degraded-model detection (Issue #2654) */
  best_planning_model?: string;
  /** Operational settings (Issue #277) — only overrides stored */
  claude_timeout?: number;
  min_claim_runway_seconds?: number;
  /** Labels marking an issue as a long job (Issue #245) */
  claim_long_job_labels?: string[];
  /** Extend the issue-work deadline while progress holds (Issue #4296) */
  progress_extension_enabled?: boolean;
  /** Seconds each progress grant adds to the deadline (Issue #4296) */
  progress_extension_grant_seconds?: number;
  /** Tool-activity stall window in seconds (Issue #4296) */
  progress_extension_stall_seconds?: number;
  /** Seconds between working-tree progress checks (Issue #4295) */
  progress_extension_check_seconds?: number;
  /**
   * Let the worker schedule its own auto-filed diagnostics (Issue #505;
   * default true). `false` restores the human-`work-on`-only behaviour.
   */
  self_schedule_diagnostics_enabled?: boolean;
  /** Self-scheduled diagnostics allowed in flight at once (Issue #505) */
  self_schedule_diagnostics_max_in_flight?: number;
  /** Hard timeout in seconds for the PR feedback phase (Issue #1824) */
  pr_feedback_timeout?: number;
  /** Hard timeout in seconds for the CI fix phase (Issue #1824) */
  ci_fix_timeout?: number;
  claude_kill_after?: number;
  max_clarification_rounds?: number;
  sleep_interval?: number;
  /** Concurrent-issue slot count (Issue #4174; integer 1..8, default 1). */
  max_concurrent_issues?: number;
  credit_wait_interval?: number;
  refinement_timeout?: number;
  refinement_kill_after?: number;
  planning_timeout?: number;
  planning_kill_after?: number;
  question_timeout?: number;
  question_kill_after?: number;
  clarification_timeout?: number;
  clarification_kill_after?: number;
  /** Maximum grill-me clarification rounds (Issue #1616) */
  max_grill_me_rounds?: number;
  /** Timeout in seconds for a single grill-me round (Issue #1616) */
  grill_me_timeout?: number;
  /** Grace period in seconds after grillMeTimeout before kill (Issue #1616) */
  grill_me_kill_after?: number;
  /** Wall-clock budget in seconds for one Quorum agent (Issue #4112) */
  quorum_timeout?: number;
  /** Grace period in seconds after quorum_timeout before kill (Issue #4112) */
  quorum_kill_after?: number;
  /** The two drafting providers of a Quorum run (Issue #4112) */
  quorum_planners?: string[];
  /** The adjudicating provider of a Quorum run (Issue #4112) */
  quorum_judge?: string;
  max_rate_limit_retries?: number;
  max_rate_limit_wait?: number;
  retry_max_delay?: number;
  max_issue_body_tokens?: number;
  summarise_timeout?: number;
  summarise_kill_after?: number;
  feature_check_timeout?: number;
  claude_no_output_timeout?: number;
  quality_check_timeout?: number;
  /** TTL in seconds for health check cache (Issue #1070) */
  health_cache_ttl?: number;
  /** When true, repos are shuffled; when false, scanned in configured order (Issue #435) */
  shuffle_repos?: boolean;
  /** Optional human-readable worker name for multi-worker visibility (Issue #436) */
  worker_name?: string;
  /** SSH key path for service account git transport (Issue #583) */
  ssh_key_path?: string;
  /** gh config dir for separate gh CLI identity (Issue #583) */
  gh_config_dir?: string;
  /** GitHub user status toggle (Issue #409) */
  update_gh_user_status?: boolean;
  /** Log rotation max file size in MB (Issue #469) */
  log_max_size_mb?: number;
  /** Log rotation max rotations (Issue #469) */
  log_max_rotations?: number;
  /** Stuck issue detection timeout in seconds (Issue #471) */
  stuck_issue_timeout?: number;
  /** Issue retry cooldown in seconds (Issue #589) */
  issue_retry_cooldown?: number;
  /** ImgBB API key for screenshot uploads (Issue #535) */
  imgbb_api_key?: string;
  /** FLEET health directory (Issue #535) */
  fleet_health_dir?: string;
  /**
   * Git URL of the FLEET health repository, cloned into `fleet_health_dir`
   * when that checkout is missing. Set once by the interactive setup; the
   * worker never assumes a URL.
   */
  fleet_health_repo?: string;
  /** GitHub App ID for App-based authentication (Issue #957) */
  github_app_id?: string;
  /** GitHub App Installation ID for App-based authentication (Issue #957) */
  github_app_installation_id?: string;
  /** Path to GitHub App private key file (Issue #957) */
  github_app_private_key_path?: string;
  /** Whether to attempt cheaper model fallback on rate limit (Issue #1113) */
  enable_model_fallback?: boolean;
  /** Minimum free disk space in MB before large git operations (Issue #1174) */
  min_disk_space_mb?: number;
  /** Gigabyte term of the claiming floor (Issue #732) */
  host_disk_low_floor_gb?: number;
  /** Percentage term of the claiming floor (Issue #732) */
  host_disk_low_floor_percent?: number;
  /** Whether to periodically sync milestone branches with the default branch (Issue #1238) */
  sync_milestone_branches?: boolean;
  /** Cooldown in seconds between milestone branch sync attempts (Issue #1238) */
  milestone_sync_cooldown_seconds?: number;
  /** Stale workflow thresholds (Issue #1240) */
  stale_failed_diagnostic_days?: number;
  stale_planning_warning_days?: number;
  /** Per-phase model tier overrides (Issue #1265) */
  phase_model_overrides?: Record<string, string>;
  /** Per-phase effort level overrides (Issue #1403) */
  phase_effort_overrides?: Record<string, string>;
  /** Per-phase Codex model overrides (Issue #363) */
  codex_phase_model_overrides?: Record<string, string>;
  /** Per-phase Codex reasoning-effort overrides (Issue #363) */
  codex_phase_effort_overrides?: Record<string, string>;
  /** Per-phase Gemini model overrides (Issue #364) */
  gemini_phase_model_overrides?: Record<string, string>;
  /** Per-phase DeepSeek model overrides (Issue #413) */
  deepseek_phase_model_overrides?: Record<string, string>;
  /** Whether to include recent repo activity in prompts (Issue #1326) */
  include_recent_activity?: boolean;
  /** Maximum merged PRs in activity summary (Issue #1326) */
  recent_activity_merged_pr_limit?: number;
  /** Maximum commits in activity summary (Issue #1326) */
  recent_activity_commit_limit?: number;
  /** Maximum token budget for activity summary (Issue #1326) */
  recent_activity_max_tokens?: number;
  /** Cache TTL in seconds for recent activity data (Issue #1326) */
  recent_activity_cache_ttl_seconds?: number;
  /** Whether to inject the generated codebase map into prompts (Issue #4281) */
  include_codebase_map?: boolean;
  /** Cache TTL in seconds for the issue-timeline cache (Issue #1673) */
  timeline_cache_ttl_seconds?: number;
  /** Whether to enable CLI session resume across phases (Issue #1324) */
  enable_session_resume?: boolean;
  /** Global verbosity level override (Issue #1330) */
  verbosity?: "minimal" | "concise" | "standard" | "verbose";
  /** Warning threshold percentage for context window budget (Issue #1327) */
  context_budget_warning_percent?: number;
  /** Error threshold percentage for context window budget (Issue #1327) */
  context_budget_error_percent?: number;
  /** Hard blocking threshold percentage for the context window budget (Issue #3713) */
  context_budget_block_percent?: number;
  /** Whether to include untrusted comments in prompts (Issue #1340) */
  include_untrusted_comments?: boolean;
  /** Cooldown in seconds for recently-closed PR blocking (Issue #1427) */
  closed_pr_cooldown_seconds?: number;
  /** Whether to unassign the worker from the source issue after successful PR creation (Issue #1453) */
  unassign_on_pr_created?: boolean;
  /** Age threshold in days before a repo work directory with no heartbeat is removed (Issue #1493) */
  stale_work_dir_days?: number;
  /** Maximum retry attempts for a software update command (Issue #1496) */
  update_retry_max_attempts?: number;
  /** Stall threshold in seconds for PRs blocking `work-on` issues (Issue #4025) */
  blocking_pr_stall_threshold_seconds?: number;
  /** Exponential backoff delays in seconds between software update retries (Issue #1496) */
  update_retry_backoff_seconds?: number[];
  /** Maximum auto-fix attempts per PR CI failure signature (Issue #3582) */
  max_auto_fix_attempts?: number;
  /**
   * Whether the worker should mechanically apply safe-list shellcheck
   * auto-fixes before reporting a quality-gate failure (Issue #1548).
   */
  auto_shellcheck_fix_enabled?: boolean;
  /**
   * Whether the post-Claude quality gate should treat a failing run as
   * passed when no new shellcheck findings were introduced versus the
   * baseline (Issue #1549, default: true).
   */
  baseline_aware_quality_gate?: boolean;
  /**
   * Backoff in milliseconds before an in-process retry of an
   * infrastructure-category phase failure (Issue #1550, default: 15000).
   */
  infra_retry_backoff_ms?: number;
  /** Per-template weights for the idle-task draw (Issue #2401) */
  idle_task_template_weights?: Record<string, number>;
  /** Cadence floor for the important idle-task templates (Issue #4011) */
  idle_task_cadence?: IdleTaskCadenceFileConfig;
  /** Per-tool minimum version floors for software auto-update (Issue #2622) */
  software_min_versions?: Record<string, string>;
  /**
   * Extra build-time tools this deployment's container image bakes in
   * (Issue #69, parent #5).
   *
   * Arrives untrusted from the operator's file: only
   * `parseContainerTools()` / `assertContainerTools()` in
   * `lib/container_tools_config.ts` may be trusted to produce this shape, and
   * they fail loud on any fault rather than repairing it.
   */
  container_tools?: ContainerToolSpec[];
  /**
   * Post-run callback hooks (Issue #806, parent #796).
   *
   * Deliberately untyped here: the block arrives untrusted from the
   * operator's file, and only `parseCallbacksConfig()` /
   * `assertCallbacksConfig()` in `lib/run_callbacks_config.ts` may be trusted
   * to produce a {@link CallbacksConfig}. They fail loud on any fault rather
   * than repairing it.
   */
  callbacks?: unknown;
}

/**
 * Architectures a {@link ContainerToolSpec} may supply a download for — the
 * same convention `container/tools.json` `toolchains[].sha256` uses. A
 * single-architecture deployment may supply only the one it builds.
 */
export type ContainerToolArchitecture = "amd64" | "arm64" | "noarch";

/** Per-architecture map of URLs or SHA-256 digests. */
export type ContainerToolArchMap = Partial<
  Record<ContainerToolArchitecture, string>
>;

/**
 * A validated deployer-supplied container build-time tool (Issue #69,
 * parent #5).
 *
 * Declarative archive install only: download → verify SHA-256 → extract →
 * expose `bin` on PATH → set `env`. The install prefix is fixed at
 * `/opt/vibe-tools/<id>` and `bin`/`env` values are relative to it (`""` is the
 * prefix root), so no spec can aim PATH or `JAVA_HOME` at an arbitrary host
 * path.
 */
export interface ContainerToolSpec {
  /** Lower-case letters, digits and hyphens; unique within the array. */
  id: string;
  /** Tool version, e.g. `21.0.5+11`. Free-form but required. */
  version: string;
  /** Download URL per architecture. Every entry has a matching `sha256`. */
  url: ContainerToolArchMap;
  /** SHA-256 digest per architecture, lower-case hex. */
  sha256: ContainerToolArchMap;
  /** Leading archive path components to strip on extract (default 0). */
  stripComponents: number;
  /** Prefix-relative directories to add to PATH (default none). */
  bin: string[];
  /** Environment variables set to prefix-relative paths (default none). */
  env: Record<string, string>;
}

/**
 * Raw `idle_task_cadence` block as it appears in `.config.json` (Issue #4011).
 *
 * Every field is optional and deliberately loosely typed: the block arrives
 * untrusted from an operator's file, so `parseIdleTaskCadence()` validates it
 * and falls back to the default policy per fault rather than trusting the
 * declared shape.
 */
export interface IdleTaskCadenceFileConfig {
  /** Kill switch — `false` reverts the filer to a pure random pick. */
  enabled?: boolean;
  /** Important templates, keyed by registered template name. */
  templates?: Record<string, {
    /** Model alias the weekly scan runs on (`fable`/`opus`/`sonnet`/`haiku`). */
    weekly_model?: string;
    /** Model alias the monthly scan runs on. */
    monthly_model?: string;
  }>;
  /** Weekly rolling window, in days (default 7). */
  weekly_days?: number;
  /** Monthly rolling window, in days (default 30, must exceed `weekly_days`). */
  monthly_days?: number;
}
