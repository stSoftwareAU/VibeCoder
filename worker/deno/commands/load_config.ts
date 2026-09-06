/**
 * Load-config command — loads configuration and outputs shell variable
 * assignments for consumption by shell scripts.
 *
 * Replaces config_loader.sh and config_defaults.sh (Issue #904).
 * Deno TypeScript is now the single source of truth for configuration
 * loading, validation, and defaults.
 *
 * Usage from shell:
 *   eval "$(deno_run_command load-config)"
 *
 * Output format:
 *   export VAR="value"          — for scalar values
 *   VAR=("val1" "val2")         — for array values (bash arrays)
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import type {
  Command,
  CommandResult,
  ConfigFile,
  WorkerConfig,
} from "../types.ts";
import { loadConfig } from "../lib/config.ts";
import { validateConfigFull } from "../lib/config_validator.ts";
import {
  DEFAULT_CLAUDE_MODEL_HEALTH,
  DEFAULT_CLAUDE_MODEL_PLANNING,
  OPERATIONAL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { SHELL_OPERATIONAL_DEFAULTS } from "../lib/operational_defaults.ts";
import { buildGitSshCommand } from "../lib/shell_quote.ts";

/**
 * Additional defaults not in WorkerConfig but needed by shell scripts.
 * These were previously defined in config_defaults.sh.
 */
const SHELL_DEFAULTS = {
  SET_WINDOW_TITLE: "true",
  UPDATE_GH_USER_STATUS: "true",
  NEEDS_SCREENSHOT_LABEL: "needs-screenshot",
  DOCUMENTATION_LABEL: "documentation",
  LABEL_CACHE_TTL: "3600",
  TIMEOUT_DIAGNOSTIC_LINES: "50",
  OUTPUT_PROGRESS_INTERVAL: "300",
  CLAUDE_STALL_TIMEOUT: "1800",
  QUALITY_CHECK_TIMEOUT: "600",
  MAX_INFRA_RETRIES: "5",
  HEALTH_CHECK_TIMEOUT: "30",
  CI_CHECK_MAX_RETRIES: "3",
  MAX_TITLE_LENGTH: "500",
  MAX_BODY_LENGTH: "50000",
  SECURITY_LOG_FILE: "",
  LOG_MAX_SIZE_MB: "10",
  LOG_MAX_ROTATIONS: "3",
  STUCK_ISSUE_TIMEOUT: "7200",
  ISSUE_RETRY_COOLDOWN: "600",
  CIRCUIT_BREAKER_THRESHOLD: "3",
  REPO_BLOCKED_ALERT_HOURS: "24",
  CLAIM_CHURN_THRESHOLD: "5",
} as const;

/**
 * Escape a string for safe use in shell single-quoted context.
 * We use double quotes with proper escaping for reliability.
 */
function shellEscape(value: string): string {
  // Replace backslash, double-quote, dollar sign, and backtick
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

/**
 * A syntactically valid POSIX shell variable name.
 *
 * Issue #1218: `exportScalar` escapes the *value* it emits but never the
 * *name*, and one name is built from data — `CLAUDE_MODEL_${phase.toUpperCase()}`,
 * where `phase` is a key of `.config.json`'s `phase_model_overrides` map and is
 * copied verbatim by `lib/config.ts` with no key filter. The emitted script is
 * `eval`'d (`lib/quality_gate.ts`), so a key such as
 * `PLAN; PATH=/tmp/evil; #` produced
 * `export CLAUDE_MODEL_PLAN; PATH=/tmp/evil; #="…"` — a second statement that
 * ran, with the trailing `#` commenting the remainder of the line so the
 * injection was silent.
 */
const SHELL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether a name is safe to emit unquoted as a shell variable name.
 *
 * Exported so the refusal is testable against literal names.
 *
 * @param name - The candidate variable name.
 * @returns True when the name is a plain POSIX shell identifier.
 */
export function isSafeShellIdentifier(name: string): boolean {
  return SHELL_IDENTIFIER_PATTERN.test(name);
}

/**
 * Format a scalar value as a shell conditional export statement.
 * Uses :- syntax to preserve existing environment variable values,
 * matching the behaviour of the original config_defaults.sh.
 *
 * @throws When `name` is not a plain shell identifier — an unescapable name
 *   in text that will be `eval`'d must fail loudly, never be emitted.
 */
function exportScalar(name: string, value: string | number | boolean): string {
  if (!isSafeShellIdentifier(name)) {
    throw new Error(
      `Refusing to emit shell variable ${
        JSON.stringify(name)
      }: a name in eval'd output must match ${SHELL_IDENTIFIER_PATTERN.source} ` +
        `(Issue #1218). Check the keys of "phase_model_overrides" in .config.json.`,
    );
  }
  return `export ${name}="\${${name}:-${shellEscape(String(value))}}"`;
}

/**
 * Format an array as a bash array declaration.
 * Arrays cannot be exported in bash, so we declare them.
 * Always sets the value unconditionally — load-config is the authoritative
 * config source and must override defaults set by config_defaults.sh.
 * On bash 4+ empty arrays ARE considered set for ${VAR+x}, so a guard
 * would prevent config values from being applied.
 */
function declareArray(name: string, values: string[]): string {
  const escaped = values.map((v) => `"${shellEscape(v)}"`).join(" ");
  return `${name}=(${escaped})`;
}

/**
 * Load the raw ConfigFile to access fields not in WorkerConfig
 * (ssh_key_path, gh_config_dir, etc.).
 */
async function loadRawConfigFile(configPath: string): Promise<ConfigFile> {
  try {
    const content = await Deno.readTextFile(configPath);
    return JSON.parse(content) as ConfigFile;
  } catch {
    return {};
  }
}

/**
 * Build shell variable assignments from a WorkerConfig and raw ConfigFile.
 */
function buildShellOutput(
  config: WorkerConfig,
  rawFile: ConfigFile,
): string[] {
  const lines: string[] = [];

  // --- Array values (bash arrays, not exported) ---
  // Issue #1066: this command renders **the config file** in shell form, so
  // `ALLOWED_AUTHORS` mirrors the file's `allowed_authors` key. It is not the
  // worker's trusted-author set: who may direct work is derived from
  // repository collaborators each cycle and never reaches a shell variable.
  lines.push(declareArray("ALLOWED_AUTHORS", rawFile.allowed_authors ?? []));
  lines.push(declareArray("PR_REVIEWERS", config.prReviewers));
  lines.push(declareArray("REPOS", config.repos));
  lines.push(declareArray("ISSUE_LABELS", config.issueLabels));
  lines.push(
    declareArray("AUTHORIZED_COMMENTERS", config.authorisedCommenters),
  );
  // Issue #1856: bots whose PR review comments are auto-trusted.
  lines.push(declareArray("TRUSTED_REVIEW_BOTS", config.trustedReviewBots));

  // --- Legacy scalar compatibility ---
  // Issue #3206: derive the legacy scalar from the same array the block above
  // renders, so the two never disagree (matches lib/config.ts).
  lines.push(
    exportScalar("ALLOWED_AUTHOR", (rawFile.allowed_authors ?? [])[0] ?? ""),
  );
  lines.push(exportScalar("PR_REVIEWER", config.prReviewer));

  // --- Label configuration ---
  lines.push(exportScalar("WORK_ON_LABEL", config.workOnLabel));
  lines.push(exportScalar("FAILED_LABEL", config.failedLabel));
  lines.push(exportScalar("FAILED_ONCE_LABEL", config.failedOnceLabel));
  // Issue #2031: NEEDS_CLARIFICATION_LABEL export retired — clarification
  // handoff is signalled via NEEDS_HUMAN_LABEL.
  lines.push(exportScalar("REFINE_ISSUE_LABEL", config.refineIssueLabel));
  lines.push(exportScalar("PLANNING_LABEL", config.planningLabel));
  lines.push(exportScalar("QUESTION_LABEL", config.questionLabel));
  // Issue #2030: ANSWERED_LABEL retired — question workflow now signals
  // handoff via NEEDS_HUMAN_LABEL.
  lines.push(exportScalar("NEEDS_REVISION_LABEL", config.needsRevisionLabel));
  lines.push(exportScalar("NEEDS_HUMAN_LABEL", config.needsHumanLabel));
  // Issue #1723: low-priority label scaffolding for the priority hierarchy.
  lines.push(exportScalar("LOW_PRIORITY_LABEL", config.lowPriorityLabel));
  lines.push(
    exportScalar(
      "NEEDS_SCREENSHOT_LABEL",
      SHELL_DEFAULTS.NEEDS_SCREENSHOT_LABEL,
    ),
  );
  lines.push(
    exportScalar("DOCUMENTATION_LABEL", SHELL_DEFAULTS.DOCUMENTATION_LABEL),
  );
  lines.push(exportScalar("LABEL_CACHE_TTL", SHELL_DEFAULTS.LABEL_CACHE_TTL));

  // --- Paths ---
  lines.push(exportScalar("WORK_DIR", config.workDir));

  // --- Update mode (Issue #622, part of #583) ---
  // Exported so run.sh can tell a frozen host from a dynamic one without
  // re-parsing .config.json.
  lines.push(exportScalar("VIBE_UPDATE_MODE", config.updateMode));

  // --- Claude model ---
  lines.push(exportScalar("CLAUDE_MODEL", config.claudeModel));
  lines.push(
    exportScalar("CLAUDE_MODEL_PLANNING", DEFAULT_CLAUDE_MODEL_PLANNING),
  );
  lines.push(exportScalar("CLAUDE_MODEL_HEALTH", DEFAULT_CLAUDE_MODEL_HEALTH));

  // --- Phase model config overrides (Issue #1265) ---
  for (const [phase, model] of Object.entries(config.phaseModelOverrides)) {
    const envVar = `CLAUDE_MODEL_${phase.toUpperCase()}`;
    lines.push(exportScalar(envVar, model));
  }

  // --- Operational timeouts ---
  lines.push(exportScalar("CLAUDE_TIMEOUT", config.claudeTimeout));
  // Re-armable issue-work deadline (Issues #4295, #4296). Exported so bash
  // consumers see the same tunables the Deno runner decides with — an
  // operator reading the shell environment must not have to guess whether
  // the hard timeout is extendable.
  lines.push(
    exportScalar(
      "PROGRESS_EXTENSION_ENABLED",
      config.progressExtensionEnabled ??
        OPERATIONAL_DEFAULTS.progressExtensionEnabled,
    ),
  );
  lines.push(
    exportScalar(
      "PROGRESS_EXTENSION_GRANT_SECONDS",
      config.progressExtensionGrantSeconds ??
        OPERATIONAL_DEFAULTS.progressExtensionGrantSeconds,
    ),
  );
  lines.push(
    exportScalar(
      "PROGRESS_EXTENSION_STALL_SECONDS",
      config.progressExtensionStallSeconds ??
        OPERATIONAL_DEFAULTS.progressExtensionStallSeconds,
    ),
  );
  lines.push(
    exportScalar(
      "PROGRESS_EXTENSION_CHECK_SECONDS",
      config.progressExtensionCheckSeconds ??
        OPERATIONAL_DEFAULTS.progressExtensionCheckSeconds,
    ),
  );
  // Issue #1824: distinct hard timeouts for reactive phases.
  lines.push(exportScalar("PR_FEEDBACK_TIMEOUT", config.prFeedbackTimeout));
  lines.push(exportScalar("CI_FIX_TIMEOUT", config.ciFixTimeout));
  lines.push(exportScalar("CLAUDE_KILL_AFTER", config.claudeKillAfter));
  lines.push(
    exportScalar("MAX_CLARIFICATION_ROUNDS", config.maxClarificationRounds),
  );
  lines.push(exportScalar("SLEEP_INTERVAL", config.sleepInterval));
  lines.push(exportScalar("CREDIT_WAIT_INTERVAL", config.creditWaitInterval));
  lines.push(exportScalar("REFINEMENT_TIMEOUT", config.refinementTimeout));
  lines.push(exportScalar("REFINEMENT_KILL_AFTER", config.refinementKillAfter));
  lines.push(exportScalar("PLANNING_TIMEOUT", config.planningTimeout));
  lines.push(exportScalar("PLANNING_KILL_AFTER", config.planningKillAfter));
  lines.push(exportScalar("QUESTION_TIMEOUT", config.questionTimeout));
  lines.push(exportScalar("QUESTION_KILL_AFTER", config.questionKillAfter));
  lines.push(
    exportScalar("CLARIFICATION_TIMEOUT", config.clarificationTimeout),
  );
  lines.push(
    exportScalar("CLARIFICATION_KILL_AFTER", config.clarificationKillAfter),
  );
  lines.push(
    exportScalar("MAX_RATE_LIMIT_RETRIES", config.maxRateLimitRetries),
  );
  lines.push(exportScalar("MAX_RATE_LIMIT_WAIT", config.maxRateLimitWait));
  lines.push(exportScalar("RETRY_MAX_DELAY", config.retryMaxDelay));
  lines.push(exportScalar("MAX_ISSUE_BODY_TOKENS", config.maxIssueBodyTokens));
  lines.push(exportScalar("SUMMARISE_TIMEOUT", config.summariseTimeout));
  lines.push(exportScalar("SUMMARISE_KILL_AFTER", config.summariseKillAfter));
  lines.push(exportScalar("FEATURE_CHECK_TIMEOUT", config.featureCheckTimeout));
  lines.push(
    exportScalar("CLAUDE_NO_OUTPUT_TIMEOUT", config.claudeNoOutputTimeout),
  );
  lines.push(exportScalar("QUALITY_CHECK_TIMEOUT", config.qualityCheckTimeout));

  // --- Toggles ---
  lines.push(exportScalar("SHUFFLE_REPOS", config.shuffleRepos));
  lines.push(exportScalar("WORKER_NAME", config.workerName));
  lines.push(exportScalar("SET_WINDOW_TITLE", SHELL_DEFAULTS.SET_WINDOW_TITLE));

  // --- Additional shell defaults ---
  lines.push(
    exportScalar(
      "TIMEOUT_DIAGNOSTIC_LINES",
      SHELL_DEFAULTS.TIMEOUT_DIAGNOSTIC_LINES,
    ),
  );
  lines.push(
    exportScalar(
      "OUTPUT_PROGRESS_INTERVAL",
      SHELL_DEFAULTS.OUTPUT_PROGRESS_INTERVAL,
    ),
  );
  lines.push(
    exportScalar("CLAUDE_STALL_TIMEOUT", SHELL_DEFAULTS.CLAUDE_STALL_TIMEOUT),
  );
  lines.push(
    exportScalar("MAX_INFRA_RETRIES", SHELL_DEFAULTS.MAX_INFRA_RETRIES),
  );
  lines.push(
    exportScalar("HEALTH_CHECK_TIMEOUT", SHELL_DEFAULTS.HEALTH_CHECK_TIMEOUT),
  );
  lines.push(
    exportScalar("CI_CHECK_MAX_RETRIES", SHELL_DEFAULTS.CI_CHECK_MAX_RETRIES),
  );
  lines.push(exportScalar("MAX_TITLE_LENGTH", SHELL_DEFAULTS.MAX_TITLE_LENGTH));
  lines.push(exportScalar("MAX_BODY_LENGTH", SHELL_DEFAULTS.MAX_BODY_LENGTH));
  lines.push(exportScalar("LOG_MAX_SIZE_MB", SHELL_DEFAULTS.LOG_MAX_SIZE_MB));
  lines.push(
    exportScalar("LOG_MAX_ROTATIONS", SHELL_DEFAULTS.LOG_MAX_ROTATIONS),
  );
  lines.push(
    exportScalar("STUCK_ISSUE_TIMEOUT", SHELL_DEFAULTS.STUCK_ISSUE_TIMEOUT),
  );
  lines.push(
    exportScalar("ISSUE_RETRY_COOLDOWN", SHELL_DEFAULTS.ISSUE_RETRY_COOLDOWN),
  );
  lines.push(
    exportScalar(
      "CIRCUIT_BREAKER_THRESHOLD",
      SHELL_DEFAULTS.CIRCUIT_BREAKER_THRESHOLD,
    ),
  );
  lines.push(
    exportScalar(
      "REPO_BLOCKED_ALERT_HOURS",
      SHELL_DEFAULTS.REPO_BLOCKED_ALERT_HOURS,
    ),
  );
  lines.push(
    exportScalar("CLAIM_CHURN_THRESHOLD", SHELL_DEFAULTS.CLAIM_CHURN_THRESHOLD),
  );

  // --- Config file overrides for shell defaults ---
  // These are loaded from raw config file and override the defaults above
  const updateGhStatus = rawFile.update_gh_user_status;
  if (updateGhStatus !== undefined) {
    lines.push(exportScalar("UPDATE_GH_USER_STATUS", String(updateGhStatus)));
  } else {
    lines.push(
      exportScalar(
        "UPDATE_GH_USER_STATUS",
        SHELL_DEFAULTS.UPDATE_GH_USER_STATUS,
      ),
    );
  }

  const logMaxSizeMb = rawFile.log_max_size_mb;
  if (typeof logMaxSizeMb === "number") {
    lines.push(exportScalar("LOG_MAX_SIZE_MB", logMaxSizeMb));
  }

  const logMaxRotations = rawFile.log_max_rotations;
  if (typeof logMaxRotations === "number") {
    lines.push(exportScalar("LOG_MAX_ROTATIONS", logMaxRotations));
  }

  const stuckIssueTimeout = rawFile.stuck_issue_timeout;
  if (typeof stuckIssueTimeout === "number") {
    lines.push(exportScalar("STUCK_ISSUE_TIMEOUT", stuckIssueTimeout));
  }

  const issueRetryCooldown = rawFile.issue_retry_cooldown;
  if (typeof issueRetryCooldown === "number") {
    lines.push(exportScalar("ISSUE_RETRY_COOLDOWN", issueRetryCooldown));
  }

  // --- Service account authentication (Issue #583) ---
  const sshKeyPath = rawFile.ssh_key_path;
  if (sshKeyPath) {
    const expandedPath = sshKeyPath.replace(/^~/, Deno.env.get("HOME") ?? "");
    // Quote the key path for the inner shell: git hands GIT_SSH_COMMAND to
    // /bin/sh, so `shellEscape` (which only protects the outer export
    // statement) is not enough (Issue #3661, SEC-a228ff008ed4).
    lines.push(
      exportScalar("GIT_SSH_COMMAND", buildGitSshCommand(expandedPath)),
    );
  }

  const ghConfigDir = rawFile.gh_config_dir;
  if (ghConfigDir) {
    const expandedDir = ghConfigDir.replace(/^~/, Deno.env.get("HOME") ?? "");
    lines.push(exportScalar("GH_CONFIG_DIR", expandedDir));
  }

  // --- Optional features (Issue #535) ---
  const imgbbApiKey = rawFile.imgbb_api_key;
  if (imgbbApiKey) {
    lines.push(exportScalar("VIBE_IMGBB_API_KEY", imgbbApiKey));
  }

  // --- GitHub App authentication (Issue #957) ---
  const githubAppId = rawFile.github_app_id;
  if (githubAppId) {
    lines.push(exportScalar("GITHUB_APP_ID", githubAppId));
  }

  const githubAppInstallationId = rawFile.github_app_installation_id;
  if (githubAppInstallationId) {
    lines.push(
      exportScalar("GITHUB_APP_INSTALLATION_ID", githubAppInstallationId),
    );
  }

  const githubAppPrivateKeyPath = rawFile.github_app_private_key_path;
  if (githubAppPrivateKeyPath) {
    const expandedKeyPath = githubAppPrivateKeyPath.replace(
      /^~/,
      Deno.env.get("HOME") ?? "",
    );
    lines.push(exportScalar("GITHUB_APP_PRIVATE_KEY_PATH", expandedKeyPath));
  }

  // --- Operational defaults (Issue #907: migrated from operational_defaults.sh) ---
  for (
    const [key, value] of Object.entries(SHELL_OPERATIONAL_DEFAULTS)
  ) {
    lines.push(exportScalar(key, value));
  }

  return lines;
}

export const loadConfigCommand: Command = {
  name: "load-config",
  description: "Load configuration and output shell variable assignments",
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<{ shellOutput: string }>> {
    // Determine config path — prefer explicit argument, then env, then default
    const configPath = (args["config-path"] as string) ??
      Deno.env.get("CONFIG_PATH") ??
      Deno.env.get("CONFIG_FILE") ??
      ".config.json";

    // Load configuration
    const config = await loadConfig(configPath);
    const rawFile = await loadRawConfigFile(configPath);

    // Validate configuration (pass rawFile for GitHub App validation — Issue #957)
    const validation = validateConfigFull(config, rawFile);

    // Output warnings to stderr
    for (const warning of validation.warnings) {
      console.error(`CONFIG WARNING: ${warning}`);
    }

    // Output errors to stderr but don't fail — let the caller decide
    for (const error of validation.errors) {
      console.error(`CONFIG ERROR: ${error}`);
    }

    // Build shell output
    const shellLines = buildShellOutput(config, rawFile);
    const shellOutput = shellLines.join("\n");

    // The message is the shell output (consumed by eval)
    return {
      success: validation.valid,
      message: shellOutput,
      data: { shellOutput },
    };
  },
};
