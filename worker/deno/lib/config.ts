/**
 * Configuration loader for the Vibe Coder worker.
 *
 * Issue #266: All configuration is now loaded from .config.json only.
 * Issue #277: Operational settings (timeouts, intervals) are also loaded
 * from .config.json. Only overrides are stored — defaults flow from code.
 *
 * Environment variable overrides are no longer supported at runtime.
 * Use setup.sh to configure via .config.json.
 */

import type {
  AuthorSource,
  ConfigFile,
  RepoConfig,
  WorkerConfig,
} from "../types.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import {
  EXCLUSION_TEAM_PATTERN,
  validateConfigFileJson,
} from "./validation.ts";
import {
  resolveAgentProviderId,
  resolveEnabledAgentProviderIds,
  setConfiguredAgentProviderId,
  setConfiguredEnabledAgentProviderIds,
} from "./agent_provider.ts";
import { DEFAULT_LONG_JOB_LABELS } from "./claim_runway_evidence.ts";
import { resolveRunMode } from "./run_mode.ts";
import { resolveEffectiveFleetPrAuthors } from "./fleet_authors.ts";
import { parsePreFlightCommands } from "./repo_config.ts";
import { parseIdleTaskCadence } from "./idle_task_cadence_config.ts";
import { parseContainerTools } from "./container_tools_config.ts";
import { validateUpdateModeSettings } from "./config_validator.ts";
import {
  detectUnknownConfigKeys,
  formatUnknownKeyWarnings,
} from "./config_unknown_keys.ts";
import {
  DEFAULT_BEST_PLANNING_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_SHUFFLE_REPOS,
  DEFAULT_TRUSTED_REVIEW_BOTS,
  DEFAULT_UPDATE_MODE,
  DEFAULT_VERBOSITY,
  DEFAULT_WORKER_NAME,
  defaultQuorumJudge,
  defaultQuorumPlanners,
  LABEL_DEFAULTS,
  OPERATIONAL_DEFAULTS,
} from "./config_defaults.ts";
import type { VerbosityLevel } from "../types.ts";

/**
 * Pattern matching a valid GitHub `owner/repo` slug.
 *
 * Defined once and shared between config validation (`validateConfig`)
 * and the add-repo flow in `add_repo.ts` (Issue #2575) so the literal is
 * never duplicated.
 *
 * Each segment must begin with an alphanumeric, underscore, or hyphen —
 * never a dot. This rejects path-traversal and dot-only segments such as
 * `owner/..`, `owner/.`, or `../x` (Issue #2692): the slug is derived into
 * a filesystem path by `setupRepo()`, so a `..` segment would otherwise
 * steer destructive git commands above `WORK_DIR`. GitHub slugs never
 * legitimately start with a dot, so the constraint costs no valid input.
 */
export const REPO_SLUG_PATTERN =
  /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;

/**
 * Get an environment variable or return a default value.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @param env - Environment lookup (Issue #956). Defaults to the process
 *   environment, so every existing caller is unchanged; a test injects a
 *   fixed map instead of mutating `Deno.env`, which races under
 *   `deno test --parallel`.
 * @returns The environment variable value or default
 */
export function getEnvOrDefault(
  name: string,
  defaultValue: string,
  env: EnvLookup = processEnvLookup,
): string {
  return env(name) ?? defaultValue;
}

/**
 * Get an environment variable as a number or return a default value.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @param env - Environment lookup (Issue #956); defaults to the process
 *   environment.
 * @returns The environment variable value as number or default
 */
export function getEnvNumberOrDefault(
  name: string,
  defaultValue: number,
  env: EnvLookup = processEnvLookup,
): number {
  const value = env(name);
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Read a non-negative number from the environment, or `undefined` when the
 * variable is unset, empty, or not a finite non-negative number (Issue #289).
 *
 * Distinct from {@link getEnvNumberOrDefault}: the caller needs to tell "the
 * operator set nothing" from "the operator set a value", so that a
 * `.config.json` key can take precedence over the environment without a
 * sentinel default standing in for an absent variable.
 *
 * @param name - Environment variable name
 * @param env - Environment lookup (Issue #956); defaults to the process
 *   environment.
 * @returns The parsed value, or `undefined` when there is no usable one
 */
export function readNonNegativeNumberEnv(
  name: string,
  env: EnvLookup = processEnvLookup,
): number | undefined {
  const raw = env(name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Get an environment variable as a comma-separated array or return a default value.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @param env - Environment lookup (Issue #956); defaults to the process
 *   environment.
 * @returns The environment variable value as array or default
 */
export function getEnvArrayOrDefault(
  name: string,
  defaultValue: string[],
  env: EnvLookup = processEnvLookup,
): string[] {
  const value = env(name);
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Load configuration from a JSON file.
 *
 * @param configPath - Path to the .config.json file
 * @returns Parsed config file or empty object if file doesn't exist
 */
/**
 * Map of snake_case JSON keys to camelCase RepoConfig field names.
 *
 * The `.config.json` documentation uses snake_case for repo_config fields
 * (e.g., `skip_screenshot_check`), but the TypeScript `RepoConfig` interface
 * uses camelCase (e.g., `skipScreenshotCheck`). This map normalises the
 * JSON-parsed keys so both formats are accepted (Issue #1296).
 */
const REPO_CONFIG_KEY_MAP: Record<string, keyof RepoConfig> = {
  pre_setup_command: "preSetupCommand",
  skip_quality_check: "skipQualityCheck",
  quality_command: "qualityCommand",
  custom_instructions: "customInstructions",
  skip_auto_merge: "skipAutoMerge",
  skip_reviewer_request: "skipReviewerRequest",
  skip_screenshot_check: "skipScreenshotCheck",
  skip_security_fix_check: "skipSecurityFixCheck",
  // Credentials this repository's checks need (Issues #573, #574).
  quality_credentials: "qualityCredentials",
  docker_image: "dockerImage",
  quality_check_timeout: "qualityCheckTimeout",
  // Per-repo nice value — lower = sooner (Issue #2772). Key is identical
  // in snake_case and camelCase; mapped explicitly for documentation parity.
  nice: "nice",
  // Per-repo model/effort routing (Issue #2625).
  claude_model: "claudeModel",
  // Per-repo best planning model for degraded-model detection (Issue #2654).
  best_planning_model: "bestPlanningModel",
  phase_model_overrides: "phaseModelOverrides",
  phase_effort_overrides: "phaseEffortOverrides",
  // Per-repo Codex model/effort routing (Issue #363).
  codex_model: "codexModel",
  codex_phase_model_overrides: "codexPhaseModelOverrides",
  codex_phase_effort_overrides: "codexPhaseEffortOverrides",
  // Per-repo Gemini model routing (Issue #364). Model only — the Gemini CLI
  // has no reasoning-effort option to override.
  gemini_model: "geminiModel",
  gemini_phase_model_overrides: "geminiPhaseModelOverrides",
  // Per-repo DeepSeek model routing (Issue #413). Model only — DeepSeek's
  // Anthropic-compatible endpoint has no effort control to override.
  deepseek_model: "deepseekModel",
  deepseek_phase_model_overrides: "deepseekPhaseModelOverrides",
  // Pre-flight enforcement gate (Issue #3577). Accept the kebab-case form
  // shown in the issue/docs example (`"pre-flight"`) and the snake_case form
  // (`pre_flight`); camelCase (`preFlight`) passes through unchanged.
  "pre-flight": "preFlight",
  pre_flight: "preFlight",
  // Issue-mode CI-failure log auto-fetch (Issue #3581).
  ci_failure_labels: "ciFailureLabels",
  ci_failure_job_path: "ciFailureJobPath",
  // Per-repo auto-fix attempt cap (Issue #3582).
  max_auto_fix_attempts: "maxAutoFixAttempts",
  // Per-repo blocking-PR stall threshold (Issue #4025).
  blocking_pr_stall_threshold_seconds: "blockingPrStallThresholdSeconds",
};

/**
 * Normalise a single RepoConfig object from snake_case to camelCase keys.
 *
 * Accepts both snake_case and camelCase — snake_case keys are converted,
 * camelCase keys are kept as-is. Unknown keys are dropped.
 */
function normaliseRepoConfig(raw: Record<string, unknown>): RepoConfig {
  const normalised: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const mappedKey = REPO_CONFIG_KEY_MAP[key];
    if (mappedKey) {
      // Snake_case key — map to camelCase
      normalised[mappedKey] = value;
    } else {
      // Already camelCase or unknown — keep as-is
      normalised[key] = value;
    }
  }

  return normalised as RepoConfig;
}

/**
 * Normalise all repo configs in a repo_config map.
 *
 * Each repo's config object gets its snake_case keys converted to camelCase
 * so that `getRepoConfig()` can find them by their TypeScript field names.
 */
function normaliseRepoConfigs(
  raw: Record<string, RepoConfig> | undefined,
): Record<string, RepoConfig> | undefined {
  if (!raw) return undefined;

  const result: Record<string, RepoConfig> = {};
  for (const [repo, config] of Object.entries(raw)) {
    result[repo] = normaliseRepoConfig(
      config as unknown as Record<string, unknown>,
    );
  }
  return result;
}

async function loadConfigFile(configPath: string): Promise<ConfigFile> {
  let content: string;
  try {
    content = await Deno.readTextFile(configPath);
  } catch {
    // File doesn't exist - return empty config
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `Config file ${configPath} contains invalid JSON`,
    );
  }

  const validated = validateConfigFileJson(parsed);
  if (!validated.ok) {
    throw new Error(
      `Config file ${configPath} has invalid structure: ${validated.error.field} - ${validated.error.message}`,
    );
  }

  // Issue #1334: Detect unknown keys and warn about typos / camelCase mistakes
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const warnings = detectUnknownConfigKeys(
      parsed as Record<string, unknown>,
    );
    if (warnings.length > 0) {
      const formatted = formatUnknownKeyWarnings(warnings);
      console.error(formatted);
    }
  }

  // Issue #69 (parent #5): deployer-supplied container tool specs are the
  // trust boundary for an unverified download — a malformed spec fails the
  // config load loudly rather than reaching the image build.
  const tools = parseContainerTools(
    (validated.value as ConfigFile).container_tools,
  );
  if (!tools.ok) {
    throw new Error(`Config file ${configPath} is invalid: ${tools.error}`);
  }

  // Issue #622 (part of #583): the pinned ref and tool versions are meant to
  // be hand-edited without re-running setup, so a bad edit fails here —
  // naming the offending field — rather than checking out the wrong thing or
  // installing a version nobody asked for.
  const file = validated.value as ConfigFile;
  const updateModeErrors = validateUpdateModeSettings({
    updateMode: file.update_mode,
    pinnedRef: file.pinned_ref,
    pinnedToolVersions: file.pinned_tool_versions,
  });
  if (updateModeErrors.length > 0) {
    throw new Error(
      `Config file ${configPath} is invalid: ${updateModeErrors.join(" ")}`,
    );
  }

  return file;
}

/**
 * Options for loadConfig behaviour.
 */
export interface LoadConfigOptions {
  /** When true, validates required fields at load time (Issue #630) */
  validate?: boolean;
  /**
   * Environment lookup for the handful of variables that still override the
   * file (Issue #956). Defaults to the process environment, so production
   * behaviour is unchanged; a test injects a fixed map and needs no
   * `Deno.env.set`.
   */
  env?: EnvLookup;
}

/**
 * Load worker configuration from config file only (Issue #266, #277).
 *
 * All values come from the config file, with hardcoded defaults as fallback.
 * Environment variable overrides are no longer supported at runtime.
 * Only values that differ from defaults need to be stored in .config.json.
 *
 * @param configPath - Path to the .config.json file
 * @param options - Optional behaviour overrides
 * @returns Complete worker configuration
 */
export async function loadConfig(
  configPath: string,
  options?: LoadConfigOptions,
): Promise<WorkerConfig> {
  const file = await loadConfigFile(configPath);
  // The one environment seam this loader reads through (Issue #956).
  const env = options?.env ?? processEnvLookup;

  // Load allowed authors array (Issue #137)
  const allowedAuthors = file.allowed_authors ?? [];
  const allowedAuthor: string = allowedAuthors[0] ?? "";

  // Load PR reviewers array (Issue #141)
  const prReviewers = file.pr_reviewers ?? [];
  const prReviewer = prReviewers[0] ?? allowedAuthor ?? "";

  const repos = file.repos ?? [];

  // Issue #1834: the three discovery labels (top-priority, work-on,
  // low-priority) are hardwired and NOT configurable. issueLabels is the
  // configured-label tier that the label-based collector iterates; only
  // top-priority belongs here, since work-on and low-priority have
  // dedicated, author-checked collectors with stricter authorisation
  // checks. Routing them through the label collector would bypass those
  // checks.
  const issueLabels = [LABEL_DEFAULTS.topPriorityLabel];

  const authorisedCommenters = file.authorized_commenters ??
    (allowedAuthor ? [allowedAuthor] : []);

  // Issue #252: local arrays remain the default source. `"github"` is
  // accepted here so the later wiring sub-issue can flip behaviour without
  // another schema change. Absent matches today's `"config"` path.
  const authorSource: AuthorSource = file.author_source ?? "config";
  const exclusionTeam = file.exclusion_team;

  // Issue #3528: allowlist of service-account logins the identity guard
  // validates the resolved `gh` login against. Empty leaves the guard
  // inactive (loudly warned), never silently permissive.
  const serviceAccounts = file.service_accounts ?? [];

  // Issue #3530: service-account auth env sources. Kept raw (no ~ expansion)
  // — applyServiceAccountEnv expands when it sets GH_CONFIG_DIR /
  // GIT_SSH_COMMAND on the shared command path.
  const ghConfigDir = file.gh_config_dir ?? "";
  const sshKeyPath = file.ssh_key_path ?? "";

  // Trusted review bots (Issue #1856). Precedence: TRUSTED_REVIEW_BOTS
  // env var > .config.json (`trusted_review_bots`) > built-in defaults.
  const trustedReviewBots: string[] = getEnvArrayOrDefault(
    "TRUSTED_REVIEW_BOTS",
    file.trusted_review_bots ?? [...DEFAULT_TRUSTED_REVIEW_BOTS],
    env,
  );

  // Sibling fleet PR authors (fleet-aware PR maintenance). Precedence:
  // FLEET_PR_AUTHORS env var > .config.json (`fleet_pr_authors`) > [].
  const configuredFleetPrAuthors: string[] = getEnvArrayOrDefault(
    "FLEET_PR_AUTHORS",
    file.fleet_pr_authors ?? [],
    env,
  );

  // Issue #209: `service_accounts` names fleet accounts too, so the two
  // keys resolve to one effective sibling list here. A fleet that listed
  // its siblings only under `service_accounts` had an empty
  // `fleet_pr_authors`, which left every sibling outside the PR guards:
  // their open PRs did not block a claim and their merged PRs did not
  // close one, so two hosts worked the same issue minutes apart. Unioning
  // once at load means no consumer — including the ones that build their
  // own author list from `fleetPrAuthors` — can see one key without the
  // other.
  const fleetPrAuthors = resolveEffectiveFleetPrAuthors(
    configuredFleetPrAuthors,
    serviceAccounts,
  );

  // Label configuration — all from LABEL_DEFAULTS. Issue #1834 hardwires
  // workOnLabel and lowPriorityLabel; the remaining labels still load
  // from .config.json so admins can rename workflow labels (failed,
  // needs-clarification, etc.) when integrating with existing repos.
  const workOnLabel = LABEL_DEFAULTS.workOnLabel;
  const failedOnceLabel = file.failed_once_label ??
    LABEL_DEFAULTS.failedOnceLabel;
  const failedLabel = file.failed_label ?? LABEL_DEFAULTS.failedLabel;
  const refineIssueLabel = file.refine_issue_label ??
    LABEL_DEFAULTS.refineIssueLabel;
  const planningLabel = file.planning_label ?? LABEL_DEFAULTS.planningLabel;
  const questionLabel = file.question_label ?? LABEL_DEFAULTS.questionLabel;
  const needsRevisionLabel = file.needs_revision_label ??
    LABEL_DEFAULTS.needsRevisionLabel;
  const needsHumanLabel = file.needs_human_label ??
    LABEL_DEFAULTS.needsHumanLabel;
  const grillMeLabel = file.grill_me_label ?? LABEL_DEFAULTS.grillMeLabel;
  const quorumLabel = file.quorum_label ?? LABEL_DEFAULTS.quorumLabel;
  // Issue #1834: lowPriorityLabel is hardwired — `.config.json` may not override.
  const lowPriorityLabel = LABEL_DEFAULTS.lowPriorityLabel;

  const home = env("HOME") ?? "/tmp";
  const workDir = `${home}/auto-issue-work`;

  // Where this host runs the worker (Issue #4146). Container by default;
  // `native` is an explicit opt-in, and an unrecognised value fails loudly
  // here rather than quietly launching in the mode nobody asked for.
  const runMode = resolveRunMode({ configured: file.run_mode });

  // How this host tracks releases (Issue #622, part of #583). Absent means
  // `dynamic`, so a host with no update-mode keys behaves exactly as before.
  // The pins are carried through in either mode — nothing acts on them under
  // `dynamic`, but keeping them lets a host flip back without re-editing.
  const updateMode = file.update_mode ?? DEFAULT_UPDATE_MODE;
  const pinnedRef = file.pinned_ref;
  const pinnedToolVersions = file.pinned_tool_versions;

  // Coding-agent provider selection (Issue #4067). Resolved here so an
  // unsupported id fails loudly at startup, naming the supported providers,
  // rather than surfacing as a missing binary mid-run. The selection is also
  // recorded on the seam, because the low-level modules that spawn the agent
  // hold no configuration handle.
  const agentProvider = resolveAgentProviderId({
    configured: file.agent_provider,
  });
  setConfiguredAgentProviderId(agentProvider);

  // The providers enabled for this run (Issue #4108). Each one is provisioned,
  // preflighted and mounted separately; a provider outside the set has no
  // credential mount at all. Resolved here so an unusable set — an unknown id,
  // a duplicate, or one that excludes the active provider — fails loudly at
  // startup, and recorded on the seam for the modules that hold no
  // configuration handle.
  // Cleared first so a selection recorded by an earlier load cannot leak into
  // this one: the file in hand decides the set on its own.
  setConfiguredEnabledAgentProviderIds(undefined);
  const enabledAgentProviderIds = resolveEnabledAgentProviderIds({
    configured: file.agent_provider,
    configuredProviders: file.agent_providers,
  });
  setConfiguredEnabledAgentProviderIds(enabledAgentProviderIds);

  // Claude model selection (Issue #260)
  const claudeModel = file.claude_model ?? DEFAULT_CLAUDE_MODEL;

  // Configured best planning model for degraded-model detection (Issue #2654).
  // Empty default → expected model derived from the planning routing chain.
  const bestPlanningModel = file.best_planning_model ??
    DEFAULT_BEST_PLANNING_MODEL;

  // Operational settings — all from .config.json with defaults (Issue #277)
  const claudeTimeout = file.claude_timeout ??
    OPERATIONAL_DEFAULTS.claudeTimeout;
  // Claim-runway floor (Issue #289). Config first, then the legacy
  // environment variables, then the default. The env vars are never
  // forwarded into the worker container (`container_launch.ts` passes only
  // the five it sets itself), so on a containerised host the config key is
  // the only interface that works — hence the key, and hence config winning.
  const minClaimRunwaySeconds = file.min_claim_runway_seconds ??
    readNonNegativeNumberEnv("MIN_CLAIM_RUNWAY_SECONDS", env) ??
    OPERATIONAL_DEFAULTS.minClaimRunwaySeconds;
  // Adaptive claim floor (Issue #245): labels that mark an issue as a long
  // job, alongside the preserved-WIP and prior-execute-timeout evidence.
  const claimLongJobLabels = file.claim_long_job_labels ??
    [...DEFAULT_LONG_JOB_LABELS];
  // Re-armable issue-work deadline (Issue #4296, part of #4290). Off by
  // default; only issue work consults it. Non-positive tunables are rejected
  // loudly rather than silently disabling or extending forever (#3234).
  const progressExtensionEnabled = file.progress_extension_enabled ??
    OPERATIONAL_DEFAULTS.progressExtensionEnabled;
  const progressExtensionGrantSeconds = file.progress_extension_grant_seconds ??
    OPERATIONAL_DEFAULTS.progressExtensionGrantSeconds;
  const progressExtensionStallSeconds = file.progress_extension_stall_seconds ??
    OPERATIONAL_DEFAULTS.progressExtensionStallSeconds;
  if (progressExtensionGrantSeconds <= 0) {
    throw new Error(
      `progress_extension_grant_seconds must be positive, got ` +
        `${progressExtensionGrantSeconds}. A non-positive grant would re-arm ` +
        `the deadline in the past and spin the watchdog.`,
    );
  }
  if (progressExtensionStallSeconds <= 0) {
    throw new Error(
      `progress_extension_stall_seconds must be positive, got ` +
        `${progressExtensionStallSeconds}. A non-positive stall window would ` +
        `treat every run as inactive and kill it on schedule.`,
    );
  }
  const progressExtensionCheckSeconds = file.progress_extension_check_seconds ??
    OPERATIONAL_DEFAULTS.progressExtensionCheckSeconds;
  if (progressExtensionCheckSeconds <= 0) {
    throw new Error(
      `progress_extension_check_seconds must be positive, got ` +
        `${progressExtensionCheckSeconds}. A non-positive interval would ` +
        `spin the watchdog instead of sampling the working tree.`,
    );
  }
  if (progressExtensionStallSeconds < progressExtensionCheckSeconds) {
    // The deadline decision reads tree evidence up to one check interval old,
    // so a shorter activity window kills runs that demonstrably progressed
    // inside that same window (Issue #4295).
    throw new Error(
      `progress_extension_stall_seconds must be at least ` +
        `progress_extension_check_seconds, got ` +
        `${progressExtensionStallSeconds} < ${progressExtensionCheckSeconds}. ` +
        `A stall window shorter than the check interval would kill a healthy ` +
        `run whose tool activity landed between checks.`,
    );
  }
  // Self-scheduling for auto-filed worker diagnostics (Issue #505). On by
  // default; `false` restores the wait-for-a-human behaviour exactly. The
  // in-flight cap is refused loudly when it is not a whole number — a
  // fractional or negative cap would silently disable a feature the operator
  // believes is on.
  const selfScheduleDiagnosticsEnabled =
    file.self_schedule_diagnostics_enabled ??
      OPERATIONAL_DEFAULTS.selfScheduleDiagnosticsEnabled;
  const selfScheduleDiagnosticsMaxInFlight =
    file.self_schedule_diagnostics_max_in_flight ??
      OPERATIONAL_DEFAULTS.selfScheduleDiagnosticsMaxInFlight;
  if (
    !Number.isInteger(selfScheduleDiagnosticsMaxInFlight) ||
    selfScheduleDiagnosticsMaxInFlight < 0
  ) {
    throw new Error(
      `self_schedule_diagnostics_max_in_flight must be a non-negative ` +
        `integer, got ${selfScheduleDiagnosticsMaxInFlight}. Use 0 to refuse ` +
        `every self-scheduled diagnostic, or ` +
        `self_schedule_diagnostics_enabled: false to turn the path off.`,
    );
  }

  // Issue #1824: distinct hard timeouts for reactive phases — PR feedback
  // and CI fix should not inherit the larger issue-work budget. Falls back
  // to claude_timeout if explicitly set in config (back-compat), then to
  // the phase-specific operational default.
  const prFeedbackTimeout = file.pr_feedback_timeout ??
    file.claude_timeout ??
    OPERATIONAL_DEFAULTS.prFeedbackTimeout;
  const ciFixTimeout = file.ci_fix_timeout ??
    file.claude_timeout ??
    OPERATIONAL_DEFAULTS.ciFixTimeout;
  const claudeKillAfter = file.claude_kill_after ??
    OPERATIONAL_DEFAULTS.claudeKillAfter;
  const maxClarificationRounds = file.max_clarification_rounds ??
    OPERATIONAL_DEFAULTS.maxClarificationRounds;
  const sleepInterval = file.sleep_interval ??
    OPERATIONAL_DEFAULTS.sleepInterval;
  const maxConcurrentIssues = file.max_concurrent_issues ??
    OPERATIONAL_DEFAULTS.maxConcurrentIssues;
  const creditWaitInterval = file.credit_wait_interval ??
    OPERATIONAL_DEFAULTS.creditWaitInterval;
  const refinementTimeout = file.refinement_timeout ??
    OPERATIONAL_DEFAULTS.refinementTimeout;
  const refinementKillAfter = file.refinement_kill_after ??
    OPERATIONAL_DEFAULTS.refinementKillAfter;
  const planningTimeout = file.planning_timeout ??
    OPERATIONAL_DEFAULTS.planningTimeout;
  const planningKillAfter = file.planning_kill_after ??
    OPERATIONAL_DEFAULTS.planningKillAfter;
  const questionTimeout = file.question_timeout ??
    OPERATIONAL_DEFAULTS.questionTimeout;
  const questionKillAfter = file.question_kill_after ??
    OPERATIONAL_DEFAULTS.questionKillAfter;
  const clarificationTimeout = file.clarification_timeout ??
    OPERATIONAL_DEFAULTS.clarificationTimeout;
  const clarificationKillAfter = file.clarification_kill_after ??
    OPERATIONAL_DEFAULTS.clarificationKillAfter;
  const maxGrillMeRounds = file.max_grill_me_rounds ??
    OPERATIONAL_DEFAULTS.maxGrillMeRounds;
  const grillMeTimeout = file.grill_me_timeout ??
    OPERATIONAL_DEFAULTS.grillMeTimeout;
  const grillMeKillAfter = file.grill_me_kill_after ??
    OPERATIONAL_DEFAULTS.grillMeKillAfter;
  // Quorum bounds and provider trio (Issue #4112). A configured planner list
  // that is not exactly two ids is rejected loudly rather than padded or
  // truncated — a one-sided "quorum" would have nothing to judge (#3234).
  const quorumTimeout = file.quorum_timeout ??
    OPERATIONAL_DEFAULTS.quorumTimeout;
  const quorumKillAfter = file.quorum_kill_after ??
    OPERATIONAL_DEFAULTS.quorumKillAfter;
  const quorumPlanners = file.quorum_planners ?? defaultQuorumPlanners();
  if (quorumPlanners.length !== 2) {
    throw new Error(
      `quorum_planners must name exactly two drafting providers, got ` +
        `${quorumPlanners.length}. Quorum judges two plans against each other.`,
    );
  }
  const quorumJudge = file.quorum_judge ?? defaultQuorumJudge();
  const maxRateLimitRetries = file.max_rate_limit_retries ??
    OPERATIONAL_DEFAULTS.maxRateLimitRetries;
  const maxRateLimitWait = file.max_rate_limit_wait ??
    OPERATIONAL_DEFAULTS.maxRateLimitWait;
  const retryMaxDelay = file.retry_max_delay ??
    OPERATIONAL_DEFAULTS.retryMaxDelay;
  const maxIssueBodyTokens = file.max_issue_body_tokens ??
    OPERATIONAL_DEFAULTS.maxIssueBodyTokens;
  const summariseTimeout = file.summarise_timeout ??
    OPERATIONAL_DEFAULTS.summariseTimeout;
  const summariseKillAfter = file.summarise_kill_after ??
    OPERATIONAL_DEFAULTS.summariseKillAfter;
  const featureCheckTimeout = file.feature_check_timeout ??
    OPERATIONAL_DEFAULTS.featureCheckTimeout;
  const claudeNoOutputTimeout = file.claude_no_output_timeout ??
    OPERATIONAL_DEFAULTS.claudeNoOutputTimeout;
  const qualityCheckTimeout = file.quality_check_timeout ??
    OPERATIONAL_DEFAULTS.qualityCheckTimeout;

  // Health check cache TTL (Issue #1070)
  const healthCacheTtl = file.health_cache_ttl ??
    OPERATIONAL_DEFAULTS.healthCacheTtl;

  // Repository scanning order (Issue #435)
  const shuffleRepos = file.shuffle_repos ?? DEFAULT_SHUFFLE_REPOS;

  // Worker name for multi-worker visibility (Issue #436)
  const workerName = file.worker_name ?? DEFAULT_WORKER_NAME;

  // Model fallback on rate limit (Issue #1113)
  const enableModelFallback = file.enable_model_fallback ??
    OPERATIONAL_DEFAULTS.enableModelFallback;

  // Minimum free disk space before large git operations (Issue #1174)
  const minDiskSpaceMb = file.min_disk_space_mb ??
    OPERATIONAL_DEFAULTS.minDiskSpaceMb;

  // The claiming floor's two terms (Issue #732). Deliberately *not* defaulted
  // here: `resolveDiskFloors` applies the defaults, so an unset key falls
  // through to the environment override and then to DEFAULT_LOW_FLOOR_*,
  // rather than this file restating a number that would then drift.
  const hostDiskLowFloorGb = file.host_disk_low_floor_gb;
  const hostDiskLowFloorPercent = file.host_disk_low_floor_percent;

  // Periodic milestone branch sync (Issue #1238)
  const syncMilestoneBranches = file.sync_milestone_branches ??
    OPERATIONAL_DEFAULTS.syncMilestoneBranches;
  const milestoneSyncCooldownSeconds = file.milestone_sync_cooldown_seconds ??
    OPERATIONAL_DEFAULTS.milestoneSyncCooldownSeconds;

  // Stale workflow thresholds (Issue #1240, #2031 — needs-clarification retired)
  const staleFailedDiagnosticDays = file.stale_failed_diagnostic_days ??
    OPERATIONAL_DEFAULTS.staleFailedDiagnosticDays;
  const stalePlanningWarningDays = file.stale_planning_warning_days ??
    OPERATIONAL_DEFAULTS.stalePlanningWarningDays;

  // Phase-specific model overrides (Issue #1265)
  const phaseModelOverrides: Record<string, string> =
    file.phase_model_overrides ?? {};

  // Phase-specific effort overrides (Issue #1403)
  const phaseEffortOverrides: Record<string, string> =
    file.phase_effort_overrides ?? {};

  // Phase-specific Codex model/effort overrides (Issue #363)
  const codexPhaseModelOverrides: Record<string, string> =
    file.codex_phase_model_overrides ?? {};
  const codexPhaseEffortOverrides: Record<string, string> =
    file.codex_phase_effort_overrides ?? {};

  // Phase-specific Gemini model overrides (Issue #364)
  const geminiPhaseModelOverrides: Record<string, string> =
    file.gemini_phase_model_overrides ?? {};

  // Phase-specific DeepSeek model overrides (Issue #413)
  const deepseekPhaseModelOverrides: Record<string, string> =
    file.deepseek_phase_model_overrides ?? {};

  // Session resume for multi-phase issue processing (Issue #1324)
  const enableSessionResume = file.enable_session_resume ??
    OPERATIONAL_DEFAULTS.enableSessionResume;

  // Verbosity level (Issue #1330)
  const verbosity: VerbosityLevel =
    (file.verbosity as VerbosityLevel | undefined) ?? DEFAULT_VERBOSITY;

  // Context budget monitoring thresholds (Issue #1327)
  const contextBudgetWarningPercent = file.context_budget_warning_percent ??
    OPERATIONAL_DEFAULTS.contextBudgetWarningPercent;
  const contextBudgetErrorPercent = file.context_budget_error_percent ??
    OPERATIONAL_DEFAULTS.contextBudgetErrorPercent;
  // Hard context-budget ceiling (Issue #3713)
  const contextBudgetBlockPercent = file.context_budget_block_percent ??
    OPERATIONAL_DEFAULTS.contextBudgetBlockPercent;

  // Untrusted comment inclusion (Issue #1340)
  const includeUntrustedComments = file.include_untrusted_comments ??
    OPERATIONAL_DEFAULTS.includeUntrustedComments;

  // Closed PR cooldown (Issue #1427)
  const closedPrCooldownSeconds = file.closed_pr_cooldown_seconds ??
    OPERATIONAL_DEFAULTS.closedPrCooldownSeconds;

  // Unassign worker after successful PR creation (Issue #1453)
  const unassignOnPrCreated = file.unassign_on_pr_created ??
    OPERATIONAL_DEFAULTS.unassignOnPrCreated;

  // Stale work directory age threshold (Issue #1493)
  const staleWorkDirDays = file.stale_work_dir_days ??
    OPERATIONAL_DEFAULTS.staleWorkDirDays;

  // Software update retry settings (Issue #1496)
  const updateRetryMaxAttempts = file.update_retry_max_attempts ??
    OPERATIONAL_DEFAULTS.updateRetryMaxAttempts;
  const updateRetryBackoffSeconds = file.update_retry_backoff_seconds ??
    [...OPERATIONAL_DEFAULTS.updateRetryBackoffSeconds];

  // Treat post-Claude quality failures as passed when no new findings vs baseline (Issue #1549)
  const baselineAwareQualityGate = file.baseline_aware_quality_gate ??
    OPERATIONAL_DEFAULTS.baselineAwareQualityGate;

  // In-process retry backoff for infrastructure-category phase failures (Issue #1550)
  const infraRetryBackoffMs = file.infra_retry_backoff_ms ??
    OPERATIONAL_DEFAULTS.infraRetryBackoffMs;

  // Auto-fix attempt cap per failure signature (Issue #3582)
  const maxAutoFixAttempts = file.max_auto_fix_attempts ??
    OPERATIONAL_DEFAULTS.maxAutoFixAttempts;

  // Blocking-PR stall watchdog threshold (Issue #4025). Left undefined when
  // unset so `resolveBlockingPrStallThresholdSeconds` applies its default.
  const blockingPrStallThresholdSeconds =
    file.blocking_pr_stall_threshold_seconds;

  // Per-template weights for the idle-task draw (Issue #2401)
  const idleTaskTemplateWeights: Record<string, number> =
    file.idle_task_template_weights ?? {};

  // Cadence floor for the important idle-task templates (Issues #4003, #4011).
  // Warn-and-fall-back: a malformed block never stops the worker.
  const idleTaskCadence = parseIdleTaskCadence(file.idle_task_cadence);

  // Per-tool minimum version floors for software auto-update (Issue #2622)
  const softwareMinVersions: Record<string, string> =
    file.software_min_versions ??
      { ...OPERATIONAL_DEFAULTS.softwareMinVersions };

  // Recent activity settings (Issue #1326)
  const includeRecentActivity = file.include_recent_activity ??
    OPERATIONAL_DEFAULTS.includeRecentActivity;
  const recentActivityMergedPrLimit = file.recent_activity_merged_pr_limit ??
    OPERATIONAL_DEFAULTS.recentActivityMergedPrLimit;
  const recentActivityCommitLimit = file.recent_activity_commit_limit ??
    OPERATIONAL_DEFAULTS.recentActivityCommitLimit;
  const recentActivityMaxTokens = file.recent_activity_max_tokens ??
    OPERATIONAL_DEFAULTS.recentActivityMaxTokens;
  const recentActivityCacheTtlSeconds =
    file.recent_activity_cache_ttl_seconds ??
      OPERATIONAL_DEFAULTS.recentActivityCacheTtlSeconds;
  const timelineCacheTtlSeconds = file.timeline_cache_ttl_seconds ??
    OPERATIONAL_DEFAULTS.timelineCacheTtlSeconds;

  // Codebase map injection (Issue #4281)
  const includeCodebaseMap = file.include_codebase_map ??
    OPERATIONAL_DEFAULTS.includeCodebaseMap;

  const config: WorkerConfig = {
    allowedAuthors,
    allowedAuthor,
    prReviewer,
    prReviewers,
    repos,
    issueLabels,
    authorisedCommenters,
    authorSource,
    exclusionTeam,
    serviceAccounts,
    ghConfigDir,
    sshKeyPath,
    trustedReviewBots,
    fleetPrAuthors,
    workOnLabel,
    failedOnceLabel,
    failedLabel,
    refineIssueLabel,
    planningLabel,
    questionLabel,
    needsRevisionLabel,
    needsHumanLabel,
    grillMeLabel,
    quorumLabel,
    lowPriorityLabel,
    workDir,
    runMode,
    updateMode,
    pinnedRef,
    pinnedToolVersions,
    agentProvider,
    enabledAgentProviders: enabledAgentProviderIds,
    claudeModel,
    bestPlanningModel,
    claudeTimeout,
    minClaimRunwaySeconds,
    claimLongJobLabels,
    progressExtensionEnabled,
    progressExtensionGrantSeconds,
    progressExtensionStallSeconds,
    progressExtensionCheckSeconds,
    selfScheduleDiagnosticsEnabled,
    selfScheduleDiagnosticsMaxInFlight,
    prFeedbackTimeout,
    ciFixTimeout,
    claudeKillAfter,
    maxClarificationRounds,
    sleepInterval,
    maxConcurrentIssues,
    creditWaitInterval,
    refinementTimeout,
    refinementKillAfter,
    planningTimeout,
    planningKillAfter,
    questionTimeout,
    questionKillAfter,
    clarificationTimeout,
    clarificationKillAfter,
    maxGrillMeRounds,
    grillMeTimeout,
    grillMeKillAfter,
    quorumTimeout,
    quorumKillAfter,
    quorumPlanners,
    quorumJudge,
    maxRateLimitRetries,
    maxRateLimitWait,
    retryMaxDelay,
    maxIssueBodyTokens,
    summariseTimeout,
    summariseKillAfter,
    featureCheckTimeout,
    claudeNoOutputTimeout,
    qualityCheckTimeout,
    healthCacheTtl,
    shuffleRepos,
    workerName,
    enableModelFallback,
    minDiskSpaceMb,
    ...(hostDiskLowFloorGb === undefined ? {} : { hostDiskLowFloorGb }),
    ...(hostDiskLowFloorPercent === undefined
      ? {}
      : { hostDiskLowFloorPercent }),
    syncMilestoneBranches,
    milestoneSyncCooldownSeconds,
    staleFailedDiagnosticDays,
    stalePlanningWarningDays,
    phaseModelOverrides,
    phaseEffortOverrides,
    codexPhaseModelOverrides,
    codexPhaseEffortOverrides,
    geminiPhaseModelOverrides,
    deepseekPhaseModelOverrides,
    includeRecentActivity,
    includeCodebaseMap,
    recentActivityMergedPrLimit,
    recentActivityCommitLimit,
    recentActivityMaxTokens,
    recentActivityCacheTtlSeconds,
    timelineCacheTtlSeconds,
    enableSessionResume,
    verbosity,
    contextBudgetWarningPercent,
    contextBudgetErrorPercent,
    contextBudgetBlockPercent,
    includeUntrustedComments,
    closedPrCooldownSeconds,
    unassignOnPrCreated,
    staleWorkDirDays,
    updateRetryMaxAttempts,
    updateRetryBackoffSeconds,
    baselineAwareQualityGate,
    infraRetryBackoffMs,
    maxAutoFixAttempts,
    blockingPrStallThresholdSeconds,
    idleTaskTemplateWeights,
    idleTaskCadence,
    softwareMinVersions,
    repoConfig: normaliseRepoConfigs(file.repo_config),
  };

  // Issue #3577: reject a malformed pre-flight gate loudly at config load,
  // rather than silently ignoring it and running the repo unguarded.
  validatePreFlightConfigs(config.repoConfig);

  // Issue #630: Optionally validate required fields at load time
  if (options?.validate) {
    validateConfig(config);
  }

  return config;
}

/**
 * Validate every repo's `preFlight` gate configuration at load time
 * (Issue #3577).
 *
 * Throws with a clear per-repo message on the first malformed entry so a
 * typo in `.config.json` fails loudly instead of silently disabling the gate.
 */
function validatePreFlightConfigs(
  repoConfig: Record<string, RepoConfig> | undefined,
): void {
  if (!repoConfig) return;
  for (const [repo, cfg] of Object.entries(repoConfig)) {
    const raw = (cfg as { preFlight?: unknown }).preFlight;
    if (raw === undefined) continue;
    const result = parsePreFlightCommands(raw);
    if (!result.ok) {
      throw new Error(
        `Invalid pre-flight for ${repo}: ${result.error}`,
      );
    }
  }
}

/**
 * Validate that the configuration has all required fields.
 *
 * @param config - Configuration to validate
 * @throws Error if required fields are missing or invalid
 */
export function validateConfig(config: WorkerConfig): void {
  // Check required fields (Issue #137 - now checking allowedAuthors array).
  // Issue #252: under author_source "github" the local arrays are optional
  // (and ignored) — an empty list must not throw, or every existing host
  // would be stranded the moment they flip the source.
  const authorSource = config.authorSource ?? "config";
  if (authorSource !== "github" && config.allowedAuthors.length === 0) {
    throw new Error(
      "Configuration error: allowed_authors is required. " +
        "Set via .config.json (run setup.sh to configure).",
    );
  }

  if (authorSource === "github") {
    warnIgnoredLocalAllowlists(config);
  }

  if (config.exclusionTeam !== undefined) {
    if (!EXCLUSION_TEAM_PATTERN.test(config.exclusionTeam)) {
      throw new Error(
        `Configuration error: Invalid exclusion_team "${config.exclusionTeam}". ` +
          "Expected org/slug (e.g. stSoftwareAU/vibe-workers).",
      );
    }
  }

  if (config.repos.length === 0) {
    throw new Error(
      "Configuration error: repos is required. " +
        "Set via .config.json (run setup.sh to configure).",
    );
  }

  // Issue #1834: issueLabels is hardwired in code, so an empty list here
  // signals an internal bug rather than user misconfiguration.
  if (config.issueLabels.length === 0) {
    throw new Error(
      "Configuration error: issueLabels is empty. The discovery label set " +
        "is hardwired in lib/config_defaults.ts; this indicates a build " +
        "bug rather than a configuration problem.",
    );
  }

  // Validate repo format (must be owner/repo)
  for (const repo of config.repos) {
    if (!REPO_SLUG_PATTERN.test(repo)) {
      throw new Error(
        `Configuration error: Invalid repository format "${repo}". ` +
          "Repositories must be in owner/repo format.",
      );
    }
  }

  // Validate username format for all allowed authors (Issue #137)
  const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(\[bot\])?$/;
  for (const author of config.allowedAuthors) {
    if (!usernamePattern.test(author)) {
      throw new Error(
        `Configuration error: Invalid username format "${author}" in allowed_authors.`,
      );
    }
  }
}

/**
 * Warn when local trust arrays are still populated under `author_source:
 * "github"` (Issue #252). The GitHub-derived lists fully replace the local
 * arrays, so a leftover login must never be mistaken for a grant of trust.
 */
function warnIgnoredLocalAllowlists(config: WorkerConfig): void {
  const ignoredAuthors = config.allowedAuthors;
  const ignoredCommenters = config.authorisedCommenters;
  if (ignoredAuthors.length === 0 && ignoredCommenters.length === 0) {
    return;
  }

  const parts: string[] = [];
  if (ignoredAuthors.length > 0) {
    parts.push(`allowed_authors: ${ignoredAuthors.join(", ")}`);
  }
  if (ignoredCommenters.length > 0) {
    parts.push(`authorized_commenters: ${ignoredCommenters.join(", ")}`);
  }

  console.warn(
    `⚠️  DEPRECATION: author_source is "github", so local allowlist ` +
      `entries are ignored and do not grant trust (${parts.join("; ")}). ` +
      `Remove them from .config.json or set author_source to "config".`,
  );
}

/**
 * Check if a username is in the allowed authors list.
 *
 * @param config - Worker configuration
 * @param username - Username to check
 * @returns true if the username is an allowed author
 */
export function isAllowedAuthor(
  config: WorkerConfig,
  username: string,
): boolean {
  return config.allowedAuthors.includes(username);
}
