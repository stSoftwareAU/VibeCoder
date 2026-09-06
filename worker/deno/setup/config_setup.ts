/**
 * TypeScript configuration setup for VibeCoder.
 *
 * Provides non-interactive configuration setup that writes only
 * overridden values to .config.json (not defaults). Setup is always
 * non-interactive — the Vibe Coder runs on unattended machines (Issue #269).
 *
 * Consolidated from setup/ts/config_setup.ts as part of Issue #923.
 *
 * Issue #266: Move setup logic to TypeScript (Deno).
 * Issue #277: All configuration (including operational) stored in .config.json.
 */

import {
  DEFAULT_TRUSTED_INPUT_BOTS,
  LABEL_DEFAULTS,
  OPERATIONAL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { REMOVED_CONFIG_KEYS } from "../lib/validation.ts";
import { atomicWrite } from "../lib/file_utils.ts";

/**
 * Configuration values that can be set during setup.
 * Only fields that differ from defaults are written to .config.json.
 */
export interface SetupConfig {
  allowed_authors?: string[];
  pr_reviewer?: string;
  pr_reviewers?: string[];
  repos?: string[];
  authorized_commenters?: string[];
  /** `"github"` | `"config"` — default `"config"` (Issue #252). */
  /** Org team slug `org/slug` excluded from GitHub-derived allowlists. */
  exclusion_team?: string;
  /**
   * Worker identity guard allowlist (Issues #3528, #4030). Setup writes it
   * from `VIBE_SERVICE_ACCOUNTS`, defaulting to the resolved worker login so
   * the guard enforces from the first run instead of shipping inactive.
   */
  service_accounts?: string[];
  // Issue #1834: `issue_labels` and `work_on_label` removed — top-priority,
  // work-on, and low-priority are hardwired discovery labels.
  failed_label?: string;
  failed_once_label?: string;
  refine_issue_label?: string;
  planning_label?: string;
  claude_model?: string;
  repo_config?: Record<string, unknown>;
  // SSH key path for service account git transport (Issue #583)
  ssh_key_path?: string;
  // gh config dir for separate gh CLI identity (Issue #583)
  gh_config_dir?: string;
  // Optional feature configuration (Issue #535)
  imgbb_api_key?: string;
  update_gh_user_status?: boolean;
  // GitHub App authentication (Issue #957)
  github_app_id?: string;
  github_app_installation_id?: string;
  github_app_private_key_path?: string;
  // Operational settings (Issue #277)
  claude_timeout?: number;
  claude_kill_after?: number;
  max_clarification_rounds?: number;
  sleep_interval?: number;
  credit_wait_interval?: number;
  refinement_timeout?: number;
  refinement_kill_after?: number;
  planning_timeout?: number;
  planning_kill_after?: number;
  clarification_timeout?: number;
  clarification_kill_after?: number;
  max_rate_limit_retries?: number;
  max_rate_limit_wait?: number;
  retry_max_delay?: number;
  max_issue_body_tokens?: number;
  summarise_timeout?: number;
  summarise_kill_after?: number;
  feature_check_timeout?: number;
}

/**
 * Mapping of operational config keys to their defaults.
 * Used by buildOverridesOnly to omit values matching defaults.
 */
const OPERATIONAL_CONFIG_DEFAULTS: Record<string, number> = {
  claude_timeout: OPERATIONAL_DEFAULTS.claudeTimeout,
  claude_kill_after: OPERATIONAL_DEFAULTS.claudeKillAfter,
  max_clarification_rounds: OPERATIONAL_DEFAULTS.maxClarificationRounds,
  sleep_interval: OPERATIONAL_DEFAULTS.sleepInterval,
  credit_wait_interval: OPERATIONAL_DEFAULTS.creditWaitInterval,
  refinement_timeout: OPERATIONAL_DEFAULTS.refinementTimeout,
  refinement_kill_after: OPERATIONAL_DEFAULTS.refinementKillAfter,
  planning_timeout: OPERATIONAL_DEFAULTS.planningTimeout,
  planning_kill_after: OPERATIONAL_DEFAULTS.planningKillAfter,
  clarification_timeout: OPERATIONAL_DEFAULTS.clarificationTimeout,
  clarification_kill_after: OPERATIONAL_DEFAULTS.clarificationKillAfter,
  max_rate_limit_retries: OPERATIONAL_DEFAULTS.maxRateLimitRetries,
  max_rate_limit_wait: OPERATIONAL_DEFAULTS.maxRateLimitWait,
  retry_max_delay: OPERATIONAL_DEFAULTS.retryMaxDelay,
  max_issue_body_tokens: OPERATIONAL_DEFAULTS.maxIssueBodyTokens,
  summarise_timeout: OPERATIONAL_DEFAULTS.summariseTimeout,
  summarise_kill_after: OPERATIONAL_DEFAULTS.summariseKillAfter,
  feature_check_timeout: OPERATIONAL_DEFAULTS.featureCheckTimeout,
};

/**
 * Known default values for string/label comparison.
 * Only values that differ from these will be written to config.
 *
 * Issue #1834: `issue_labels` and `work_on_label` removed — those keys
 * are hardwired and may not appear in `.config.json`.
 */
interface LabelDefaults {
  failed_label: string;
  failed_once_label: string;
  refine_issue_label: string;
  planning_label: string;
}

const LABEL_DEFAULT_VALUES: LabelDefaults = {
  failed_label: LABEL_DEFAULTS.failedLabel,
  failed_once_label: LABEL_DEFAULTS.failedOnceLabel,
  refine_issue_label: LABEL_DEFAULTS.refineIssueLabel,
  planning_label: LABEL_DEFAULTS.planningLabel,
};

/**
 * Config keys `buildOverridesOnly` handles explicitly below.
 *
 * Everything else in the input is an operator-set override that must be
 * carried through untouched (Issue #4033).
 */
const EXPLICITLY_HANDLED_KEYS: ReadonlySet<string> = new Set([
  "allowed_authors",
  "pr_reviewer",
  "pr_reviewers",
  "repos",
  "authorized_commenters",
  "exclusion_team",
  "claude_model",
  "failed_label",
  "failed_once_label",
  "refine_issue_label",
  "planning_label",
  ...Object.keys(OPERATIONAL_CONFIG_DEFAULTS),
  "ssh_key_path",
  "gh_config_dir",
  "imgbb_api_key",
  "update_gh_user_status",
  "github_app_id",
  "github_app_installation_id",
  "github_app_private_key_path",
  "repo_config",
]);

/**
 * Drop the config keys this worker no longer honours, naming each removal
 * (Issue #805).
 *
 * Setup rewrites `.config.json` from scratch on every run and carries
 * operator-set keys through untouched (Issue #4033), so a stale key would be
 * written straight back and the next worker start would refuse the config.
 * Stripping it here fixes the file; the warning is what stops the fix being
 * silent — the operator is told where the behaviour went.
 *
 * @param config - The configuration about to be written
 * @returns The config without removed keys, plus one warning per key dropped
 */
export function stripRemovedConfigKeys(
  config: SetupConfig,
): { config: SetupConfig; warnings: string[] } {
  const result = { ...config } as Record<string, unknown>;
  const warnings: string[] = [];
  for (const [key, guidance] of REMOVED_CONFIG_KEYS) {
    if (result[key] === undefined) continue;
    delete result[key];
    warnings.push(`Removed '${key}' from .config.json — ${guidance}`);
  }
  return { config: result as SetupConfig, warnings };
}

/**
 * Keys that are hardwired and must never be written back to `.config.json`
 * (Issue #1834) — the three discovery labels are not configurable.
 */
const HARDWIRED_KEYS: ReadonlySet<string> = new Set([
  "issue_labels",
  "work_on_label",
  "low_priority_label",
]);

/**
 * Build a config object containing only overridden values (not defaults).
 *
 * This is the core logic: if a value matches the built-in default,
 * it is omitted from the output. This means changing a default in the code
 * will flow through to all users unless they have explicitly overridden it.
 *
 * Keys this function does not handle explicitly are copied straight through
 * (Issue #4033). `.config.json` is rewritten from this object on every
 * `./setup.sh` run, so anything dropped here — `fleet_pr_authors`,
 * `worker_name`, … — is silently destroyed. Operator-set keys are overrides by
 * definition; only the hardwired keys are stripped. `service_accounts` rides
 * this passthrough too, and is populated by setup itself (Issue #4030).
 *
 * @param config - The full configuration values to evaluate
 * @returns An object containing only non-default values
 */
export function buildOverridesOnly(
  config: SetupConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Passthrough for operator-set keys with no default handling (Issue #4033).
  for (const [key, value] of Object.entries(config)) {
    if (EXPLICITLY_HANDLED_KEYS.has(key) || HARDWIRED_KEYS.has(key)) continue;
    // Issue #805: a key the worker has removed is never written back — the
    // config it produced would fail the next start.
    if (REMOVED_CONFIG_KEYS.has(key)) continue;
    if (value === undefined) continue;
    result[key] = value;
  }

  // These fields have no defaults — always include if present
  if (config.allowed_authors && config.allowed_authors.length > 0) {
    result.allowed_authors = config.allowed_authors;
  }

  if (config.pr_reviewer) {
    result.pr_reviewer = config.pr_reviewer;
  }

  if (config.pr_reviewers && config.pr_reviewers.length > 0) {
    result.pr_reviewers = config.pr_reviewers;
  }

  if (config.repos && config.repos.length > 0) {
    result.repos = config.repos;
  }

  if (config.authorized_commenters && config.authorized_commenters.length > 0) {
    result.authorized_commenters = config.authorized_commenters;
  }

  if (config.exclusion_team) {
    result.exclusion_team = config.exclusion_team;
  }

  if (config.claude_model) {
    result.claude_model = config.claude_model;
  }

  // These fields have defaults — only include if different from default.
  // Issue #1834: `issue_labels` and `work_on_label` are not configurable.
  if (
    config.failed_label &&
    config.failed_label !== LABEL_DEFAULT_VALUES.failed_label
  ) {
    result.failed_label = config.failed_label;
  }

  if (
    config.failed_once_label &&
    config.failed_once_label !== LABEL_DEFAULT_VALUES.failed_once_label
  ) {
    result.failed_once_label = config.failed_once_label;
  }

  if (
    config.refine_issue_label &&
    config.refine_issue_label !== LABEL_DEFAULT_VALUES.refine_issue_label
  ) {
    result.refine_issue_label = config.refine_issue_label;
  }

  if (
    config.planning_label &&
    config.planning_label !== LABEL_DEFAULT_VALUES.planning_label
  ) {
    result.planning_label = config.planning_label;
  }

  // Operational number fields — only include if different from default (Issue #277)
  for (
    const [key, defaultValue] of Object.entries(OPERATIONAL_CONFIG_DEFAULTS)
  ) {
    const configValue = config[key as keyof SetupConfig] as number | undefined;
    if (configValue !== undefined && configValue !== defaultValue) {
      result[key] = configValue;
    }
  }

  // SSH key + gh config dir for service account authentication (Issue #583)
  if (config.ssh_key_path) {
    result.ssh_key_path = config.ssh_key_path;
  }

  if (config.gh_config_dir) {
    result.gh_config_dir = config.gh_config_dir;
  }

  // Optional feature configuration — no default for imgbb,
  // update_gh_user_status defaults to true (Issue #535)
  if (config.imgbb_api_key) {
    result.imgbb_api_key = config.imgbb_api_key;
  }

  if (
    config.update_gh_user_status !== undefined &&
    config.update_gh_user_status === false
  ) {
    result.update_gh_user_status = false;
  }

  // GitHub App authentication (Issue #957) — no defaults, always include if present
  if (config.github_app_id) {
    result.github_app_id = config.github_app_id;
  }
  if (config.github_app_installation_id) {
    result.github_app_installation_id = config.github_app_installation_id;
  }
  if (config.github_app_private_key_path) {
    result.github_app_private_key_path = config.github_app_private_key_path;
  }

  // repo_config is always included if present (no default)
  if (config.repo_config && Object.keys(config.repo_config).length > 0) {
    result.repo_config = config.repo_config;
  }

  return result;
}

/** Result of pruning orphan `repo_config` entries (Issue #4033). */
export interface RepoConfigPruneResult {
  /** The config with orphan `repo_config` entries removed. */
  config: SetupConfig;
  /** `repo_config` keys that were removed, in input order. */
  removed: string[];
}

/**
 * Drop `repo_config` entries whose repo is not in `repos` (Issue #4033).
 *
 * Dead per-repo config is never read and misleads anyone auditing which repos
 * are configured. Matching is case-insensitive, and the prune is a no-op when
 * `repos` is empty or absent so an unconfigured host cannot be nuked.
 *
 * Pure — the input is not mutated. Callers must report `removed` so the prune
 * is never silent.
 */
export function pruneOrphanRepoConfig(
  config: SetupConfig,
): RepoConfigPruneResult {
  const repoConfig = config.repo_config;
  const repos = config.repos;
  if (!repoConfig || Object.keys(repoConfig).length === 0) {
    return { config, removed: [] };
  }
  if (!repos || repos.length === 0) {
    return { config, removed: [] };
  }

  const monitored = new Set(repos.map((r) => r.toLowerCase()));
  const kept: Record<string, unknown> = {};
  const removed: string[] = [];

  for (const [repo, value] of Object.entries(repoConfig)) {
    if (monitored.has(repo.toLowerCase())) {
      kept[repo] = value;
    } else {
      removed.push(repo);
    }
  }

  if (removed.length === 0) return { config, removed };

  return { config: { ...config, repo_config: kept }, removed };
}

/** Result of defaulting the service-account allowlist (Issue #4030). */
export interface ServiceAccountDefaultResult {
  /** The config, with `service_accounts` populated where it was empty. */
  config: SetupConfig;
  /** True when the resolved worker login was written as a new allowlist. */
  defaulted: boolean;
}

/**
 * Default an empty `service_accounts` list to the resolved worker login
 * (Issue #4030).
 *
 * The #3528 identity guard treats an empty allowlist as "cannot enforce", so a
 * host that never had the key written ran with the guard inactive — which is
 * how the host-3 drift (#4028) went undetected. A one-entry allowlist holding
 * the account setup just authenticated as is strictly better than an empty
 * one: it enforces from the first run, and later drift fails loud.
 *
 * Pure — the input is not mutated, and an already-configured allowlist is
 * never overridden. Callers must report `defaulted` so the write is not
 * silent.
 *
 * @param config - The merged setup config.
 * @param workerLogin - Login `gh` resolved, or undefined when unresolved.
 */
export function applyServiceAccountDefault(
  config: SetupConfig,
  workerLogin: string | undefined,
): ServiceAccountDefaultResult {
  const configured = (config.service_accounts ?? [])
    .map((account) => account.trim())
    .filter((account) => account.length > 0);

  if (configured.length > 0) {
    return {
      config: { ...config, service_accounts: configured },
      defaulted: false,
    };
  }

  const login = workerLogin?.trim() ?? "";
  if (login === "") {
    // Nothing to default to — the caller must warn loudly rather than leave
    // the inactive guard unreported (never fail silently).
    return { config, defaulted: false };
  }

  return { config: { ...config, service_accounts: [login] }, defaulted: true };
}

/**
 * Write configuration to a JSON file, including only overridden values.
 *
 * `.config.json` is a forbidden-to-commit secrets file (Issue #2805): it holds
 * the imgbb API key, GitHub App identifiers, the private-key path, and the
 * per-repo `repo_config` block. It must never be left world-readable.
 *
 * Written through {@link atomicWrite}, as `writeSecurePlist` in
 * launchagent.ts and `writeUpdateModeConfig` in config_writer.ts already are
 * (Issue #1220). The `Deno.writeTextFile` + late `chmod` pair this replaced
 * applied `mode` only when *creating* the file, so a pre-existing 0o644 copy
 * was truncated and filled with the secrets before the mode was narrowed, and
 * both calls followed a symlink pre-positioned at the path. `atomicWrite`
 * creates its temp file `O_EXCL` at 0o600 and renames it into place, so
 * neither window exists.
 *
 * @param configPath - Path to the .config.json file
 * @param config - The configuration values to write
 * @throws When the write fails — a config that was not written must never
 *   look like one that was
 */
export async function writeConfigFile(
  configPath: string,
  config: SetupConfig,
): Promise<void> {
  const overrides = buildOverridesOnly(config);
  const json = JSON.stringify(overrides, null, 2) + "\n";
  const result = await atomicWrite({
    targetFile: configPath,
    content: json,
    mode: 0o600,
  });
  if (!result.ok) {
    throw new Error(
      `Could not write ${configPath}: ${result.error.message}`,
    );
  }
}

/**
 * Load existing configuration from a JSON file.
 *
 * @param configPath - Path to the .config.json file
 * @returns The existing configuration, or empty object if file doesn't exist
 */
export async function loadExistingConfig(
  configPath: string,
): Promise<SetupConfig> {
  try {
    const content = await Deno.readTextFile(configPath);
    return JSON.parse(content) as SetupConfig;
  } catch {
    return {};
  }
}

/**
 * Parse a comma-separated string into an array, trimming whitespace.
 */
export function parseCsv(csv: string): string[] {
  if (!csv || csv.trim() === "") return [];
  return csv.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Merge existing config with new values from environment variables (non-interactive mode).
 *
 * Environment variables (VIBE_* prefixed) control what gets written.
 * Only values that differ from defaults are stored.
 *
 * @param existing - The existing configuration
 * @param env - Environment variable getter (for testability)
 * @returns Merged configuration
 */
export function mergeNonInteractive(
  existing: SetupConfig,
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): SetupConfig {
  const result: SetupConfig = { ...existing };

  // Handle allowed_authors
  const vibeAllowedAuthors = env("VIBE_ALLOWED_AUTHORS");
  const vibeAllowedAuthor = env("VIBE_ALLOWED_AUTHOR");
  if (vibeAllowedAuthors) {
    result.allowed_authors = parseCsv(vibeAllowedAuthors);
  } else if (vibeAllowedAuthor) {
    result.allowed_authors = [vibeAllowedAuthor];
  }

  // Handle PR reviewer
  const vibePrReviewer = env("VIBE_PR_REVIEWER");
  if (vibePrReviewer) {
    result.pr_reviewer = vibePrReviewer;
  }

  // Handle repos
  const vibeRepos = env("VIBE_REPOS");
  const vibeAddRepos = env("VIBE_ADD_REPOS");
  if (vibeRepos) {
    result.repos = parseCsv(vibeRepos);
  }
  if (vibeAddRepos) {
    const addRepos = parseCsv(vibeAddRepos);
    const existingRepos = result.repos ?? [];
    const merged = [...new Set([...existingRepos, ...addRepos])];
    result.repos = merged;
  }

  // Issue #1834: VIBE_ISSUE_LABELS no longer applied — issue_labels is
  // hardwired and not configurable.

  // Handle authorized commenters
  const vibeAuthorizedCommenters = env("VIBE_AUTHORIZED_COMMENTERS");
  const vibeIncludeBots = env("VIBE_INCLUDE_BOT_COMMENTERS");
  if (vibeAuthorizedCommenters) {
    result.authorized_commenters = parseCsv(vibeAuthorizedCommenters);
  } else if (vibeIncludeBots === "true") {
    const firstAuthor = result.allowed_authors?.[0] ?? "";
    if (firstAuthor) {
      result.authorized_commenters = [
        firstAuthor,
        "github-copilot[bot]",
        "copilot[bot]",
        "cursor-bugbot",
        "cursor[bot]",
      ];
    }
  } else if (
    !result.authorized_commenters ||
    result.authorized_commenters.length === 0
  ) {
    // Issue #1066: `authorized_commenters` is the *known bot* input list —
    // logins whose test results and reviews we act on although a GitHub App
    // is never a repository collaborator. A human no longer needs to be here:
    // write access to a monitored repo already carries input trust.
    result.authorized_commenters = [...DEFAULT_TRUSTED_INPUT_BOTS];
  }

  // Worker identity guard allowlist (Issue #4030). Without this the guard
  // built for #3528 never activates, because nothing else writes the key.
  const vibeServiceAccounts = env("VIBE_SERVICE_ACCOUNTS");
  if (vibeServiceAccounts) {
    result.service_accounts = parseCsv(vibeServiceAccounts);
  }

  // Issue #1834: VIBE_WORK_ON_LABEL no longer applied — work_on_label is
  // hardwired and not configurable.

  // Handle optional feature configuration (Issue #535)
  const vibeImgbbApiKey = env("VIBE_IMGBB_API_KEY");
  if (vibeImgbbApiKey) {
    result.imgbb_api_key = vibeImgbbApiKey;
  }

  const vibeUpdateGhUserStatus = env("VIBE_UPDATE_GH_USER_STATUS");
  if (vibeUpdateGhUserStatus === "true") {
    result.update_gh_user_status = true;
  } else if (vibeUpdateGhUserStatus === "false") {
    result.update_gh_user_status = false;
  }

  // Handle GitHub App authentication (Issue #957)
  const vibeGithubAppId = env("VIBE_GITHUB_APP_ID");
  if (vibeGithubAppId) {
    result.github_app_id = vibeGithubAppId;
  }

  const vibeGithubAppInstallationId = env("VIBE_GITHUB_APP_INSTALLATION_ID");
  if (vibeGithubAppInstallationId) {
    result.github_app_installation_id = vibeGithubAppInstallationId;
  }

  const vibeGithubAppPrivateKeyPath = env("VIBE_GITHUB_APP_PRIVATE_KEY_PATH");
  if (vibeGithubAppPrivateKeyPath) {
    result.github_app_private_key_path = vibeGithubAppPrivateKeyPath;
  }

  // Handle operational settings via VIBE_* env vars (Issue #277)
  const operationalEnvMap: Array<[string, keyof SetupConfig]> = [
    ["VIBE_CLAUDE_TIMEOUT", "claude_timeout"],
    ["VIBE_CLAUDE_KILL_AFTER", "claude_kill_after"],
    ["VIBE_MAX_CLARIFICATION_ROUNDS", "max_clarification_rounds"],
    ["VIBE_SLEEP_INTERVAL", "sleep_interval"],
    ["VIBE_CREDIT_WAIT_INTERVAL", "credit_wait_interval"],
    ["VIBE_REFINEMENT_TIMEOUT", "refinement_timeout"],
    ["VIBE_REFINEMENT_KILL_AFTER", "refinement_kill_after"],
    ["VIBE_PLANNING_TIMEOUT", "planning_timeout"],
    ["VIBE_PLANNING_KILL_AFTER", "planning_kill_after"],
    ["VIBE_CLARIFICATION_TIMEOUT", "clarification_timeout"],
    ["VIBE_CLARIFICATION_KILL_AFTER", "clarification_kill_after"],
    ["VIBE_MAX_RATE_LIMIT_RETRIES", "max_rate_limit_retries"],
    ["VIBE_MAX_RATE_LIMIT_WAIT", "max_rate_limit_wait"],
    ["VIBE_RETRY_MAX_DELAY", "retry_max_delay"],
    ["VIBE_MAX_ISSUE_BODY_TOKENS", "max_issue_body_tokens"],
    ["VIBE_SUMMARISE_TIMEOUT", "summarise_timeout"],
    ["VIBE_SUMMARISE_KILL_AFTER", "summarise_kill_after"],
    ["VIBE_FEATURE_CHECK_TIMEOUT", "feature_check_timeout"],
  ];

  for (const [envVar, configKey] of operationalEnvMap) {
    const value = env(envVar);
    if (value !== undefined && value !== "") {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) {
        // deno-lint-ignore no-explicit-any
        (result as any)[configKey] = parsed;
      }
    }
  }

  return result;
}

/**
 * Run setup in non-interactive mode.
 *
 * Reads environment variables, merges with existing config,
 * and writes only overridden values to .config.json.
 */
export async function runNonInteractive(
  configPath: string,
  env?: (name: string) => string | undefined,
): Promise<void> {
  const existing = await loadExistingConfig(configPath);
  const merged = mergeNonInteractive(existing, env);
  await writeConfigFile(configPath, merged);
}
