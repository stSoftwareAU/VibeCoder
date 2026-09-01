/**
 * Unknown config key detection for .config.json validation (Issue #1334).
 *
 * Detects unknown attributes in .config.json at startup and provides
 * clear warnings with suggestions for likely intended keys (e.g.,
 * camelCase vs snake_case mistakes, typos).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Warning about an unknown configuration key.
 */
export interface UnknownKeyWarning {
  /** The unrecognised key name from .config.json */
  field: string;
  /** Human-readable warning message */
  message: string;
  /** Suggested correct key name, or null if no close match found */
  suggestion: string | null;
}

/**
 * Complete set of valid top-level keys in .config.json.
 *
 * This is the single source of truth for recognised config attributes.
 * When adding a new config field, add its snake_case key here.
 */
export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  // Core fields
  // Issue #1834: `issue_labels` removed — top-priority/work-on/low-priority
  // are hardwired discovery labels.
  "allowed_authors",
  "pr_reviewers",
  "repos",
  "authorized_commenters",
  "author_source",
  "exclusion_team",
  "service_accounts",
  "trusted_review_bots",
  "fleet_pr_authors",
  "repo_config",
  "run_mode",
  // Update mode and its pins (Issue #622, part of #583).
  "update_mode",
  "pinned_ref",
  "pinned_tool_versions",
  "agent_provider",
  "agent_providers",
  "claude_model",
  "best_planning_model",
  "phase_model_overrides",
  "phase_effort_overrides",
  // Codex per-phase routing overrides (Issue #363).
  "codex_phase_model_overrides",
  "codex_phase_effort_overrides",
  // Gemini per-phase model overrides (Issue #364). Model only — the Gemini
  // CLI has no reasoning-effort option to override.
  "gemini_phase_model_overrides",
  // DeepSeek per-phase model overrides (Issue #413). Model only — DeepSeek's
  // Anthropic-compatible endpoint has no effort control to override.
  "deepseek_phase_model_overrides",

  // Label fields
  // Issue #1834: `work_on_label` and `low_priority_label` removed — both
  // are hardwired and not configurable.
  "failed_once_label",
  "failed_label",
  "refine_issue_label",
  "planning_label",
  "question_label",
  "needs_revision_label",
  "needs_human_label",
  // Quorum plan-off (Issue #4112) — label, bounds and provider trio.
  "quorum_label",

  // Timeout and interval fields
  "claude_timeout",
  "min_claim_runway_seconds",
  // Issue #425: `claim_require_full_execute_budget` removed — the #47 rule it
  // switched on was retired with the deadline truncation that justified it.
  // Adaptive claim floor (Issue #245)
  "claim_long_job_labels",
  // Re-armable issue-work deadline (Issue #4296, part of #4290)
  "progress_extension_enabled",
  "progress_extension_grant_seconds",
  "progress_extension_stall_seconds",
  // Working-tree sampling interval (Issue #4295)
  "progress_extension_check_seconds",
  // Self-scheduled worker diagnostics (Issue #505)
  "self_schedule_diagnostics_enabled",
  "self_schedule_diagnostics_max_in_flight",
  "claude_kill_after",
  "max_clarification_rounds",
  "sleep_interval",
  "max_concurrent_issues",
  "credit_wait_interval",
  "refinement_timeout",
  "refinement_kill_after",
  "planning_timeout",
  "planning_kill_after",
  "question_timeout",
  "question_kill_after",
  "clarification_timeout",
  "clarification_kill_after",
  "quorum_timeout",
  "quorum_kill_after",
  "quorum_planners",
  "quorum_judge",
  "max_rate_limit_retries",
  "max_rate_limit_wait",
  "retry_max_delay",
  "max_issue_body_tokens",
  "summarise_timeout",
  "summarise_kill_after",
  "feature_check_timeout",
  "claude_no_output_timeout",
  "quality_check_timeout",
  "health_cache_ttl",

  // Boolean flags
  "shuffle_repos",
  "update_gh_user_status",
  "enable_model_fallback",
  "sync_milestone_branches",

  // String settings
  "worker_name",
  "ssh_key_path",
  "gh_config_dir",
  "imgbb_api_key",
  "fleet_health_dir",
  "fleet_health_repo",
  "github_app_id",
  "github_app_installation_id",
  "github_app_private_key_path",

  // Numeric settings
  "log_max_size_mb",
  "log_max_rotations",
  "stuck_issue_timeout",
  "issue_retry_cooldown",
  "min_disk_space_mb",
  "milestone_sync_cooldown_seconds",
  "stale_failed_diagnostic_days",
  "stale_planning_warning_days",

  // Recent activity settings (Issue #1326)
  "include_recent_activity",
  "recent_activity_merged_pr_limit",
  "recent_activity_commit_limit",
  "recent_activity_max_tokens",
  "recent_activity_cache_ttl_seconds",

  // Codebase map (Issue #4281)
  "include_codebase_map",
  "timeline_cache_ttl_seconds",

  // Verbosity settings (Issue #1330)
  "verbosity",

  // Session resume (Issue #1324)
  "enable_session_resume",

  // Trust-aware comment filtering (Issue #1340)
  "include_untrusted_comments",

  // Software update self-heal (Issue #1496)
  "update_retry_max_attempts",
  "update_retry_backoff_seconds",

  // Baseline-aware quality gate (Issue #1549)
  "baseline_aware_quality_gate",

  // In-process infrastructure retry (Issue #1550)
  "infra_retry_backoff_ms",

  // Auto-fix attempt cap per failure signature (Issue #3582)
  "max_auto_fix_attempts",

  // Stall threshold for PRs blocking work-on issues (Issue #4025)
  "blocking_pr_stall_threshold_seconds",

  // Idle-task template draw weights (Issue #2401)
  "idle_task_template_weights",

  // Idle-task cadence floor for the important templates (Issue #4011)
  "idle_task_cadence",

  // Software auto-update minimum version floors (Issue #2622)
  "software_min_versions",

  // Deployer-supplied container build-time tools (Issue #69, parent #5)
  "container_tools",

  // Host claiming floor (Issue #732) — read on the host by the launch plan,
  // not by the worker's config loader, so these are not WorkerConfig fields.
  "host_disk_low_floor_gb",
  "host_disk_low_floor_percent",
]);

/**
 * Convert a camelCase string to snake_case.
 *
 * @param camel - The camelCase string
 * @returns The snake_case equivalent
 */
function camelToSnake(camel: string): string {
  return camel
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");
}

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Used to find close matches for typos in config keys.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use a two-row optimisation for space efficiency
  let previousRow: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    const currentRow: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        (previousRow[j] ?? 0) + 1, // deletion
        (currentRow[j - 1] ?? 0) + 1, // insertion
        (previousRow[j - 1] ?? 0) + cost, // substitution
      );
    }
    previousRow = currentRow;
  }

  return previousRow[n] ?? m;
}

/**
 * Suggest the most likely intended key for an unrecognised key name.
 *
 * Checks two strategies:
 * 1. camelCase → snake_case conversion (most common mistake)
 * 2. Levenshtein distance for close typo matches
 *
 * @param unknownKey - The unrecognised key from .config.json
 * @returns The suggested correct key, or null if no close match found
 */
export function suggestSimilarKey(unknownKey: string): string | null {
  // Strategy 1: Try camelCase → snake_case conversion
  const snakeVersion = camelToSnake(unknownKey);
  if (KNOWN_CONFIG_KEYS.has(snakeVersion)) {
    return snakeVersion;
  }

  // Strategy 2: Find the closest match by edit distance
  // Allow up to 3 edits for longer keys, 2 for shorter ones
  const maxDistance = unknownKey.length <= 8 ? 2 : 3;
  let bestMatch: string | null = null;
  let bestDistance = maxDistance + 1;

  for (const knownKey of KNOWN_CONFIG_KEYS) {
    const distance = levenshteinDistance(unknownKey, knownKey);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = knownKey;
    }
  }

  return bestMatch;
}

/**
 * Detect unknown keys in a parsed .config.json object.
 *
 * Returns a list of warnings for any keys not in KNOWN_CONFIG_KEYS,
 * each with a suggestion for the likely intended key when possible.
 *
 * @param data - The parsed config object (top-level keys only)
 * @returns Array of warnings for unknown keys
 */
export function detectUnknownConfigKeys(
  data: Record<string, unknown>,
): UnknownKeyWarning[] {
  const warnings: UnknownKeyWarning[] = [];

  for (const key of Object.keys(data)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      const suggestion = suggestSimilarKey(key);
      const message = suggestion
        ? `Unknown config key "${key}" in .config.json. Did you mean "${suggestion}"?`
        : `Unknown config key "${key}" in .config.json. This attribute is not recognised and will be ignored.`;

      warnings.push({ field: key, message, suggestion });
    }
  }

  return warnings;
}

/**
 * Format unknown key warnings as a human-readable string for logging.
 *
 * @param warnings - Array of unknown key warnings
 * @returns Formatted warning string, or empty string if no warnings
 */
export function formatUnknownKeyWarnings(
  warnings: UnknownKeyWarning[],
): string {
  if (warnings.length === 0) return "";

  const lines = [
    `⚠️  .config.json validation: ${warnings.length} unknown attribute${
      warnings.length === 1 ? "" : "s"
    } found:`,
  ];

  for (const warning of warnings) {
    if (warning.suggestion) {
      lines.push(
        `  - "${warning.field}" → did you mean "${warning.suggestion}"?`,
      );
    } else {
      lines.push(`  - "${warning.field}" is not a recognised config key`);
    }
  }

  lines.push(
    "  See docs/CONFIGURATION.md for the full list of valid attributes.",
  );

  return lines.join("\n");
}
