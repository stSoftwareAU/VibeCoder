/**
 * Unknown config key detection for .config.json validation (Issue #1334).
 *
 * Detects unknown attributes in .config.json at startup and provides
 * clear warnings with suggestions for likely intended keys (e.g.,
 * camelCase vs snake_case mistakes, typos).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { CODEGRAPH_CONTEXT_KEYS } from "./codegraph_context_config.ts";
import { RTK_OUTPUT_KEYS } from "./rtk_output_config.ts";

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
  // Default CODEOWNERS owners written by setup (Issue #2627).
  "codeowners_owners",
  "trusted_review_bots",
  "fleet_pr_authors",
  "repo_config",
  "run_mode",
  // Update mode and its pins (Issue #622, part of #583).
  "update_mode",
  "pinned_ref",
  "pinned_tool_versions",
  "agent_provider_mode",
  "agent_provider",
  "agent_providers",
  "agent_provider_fallback",
  "claude_week_pace_drain",
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
  // Issue-executor split (Issue #2341). Host-wide, with a same-named
  // per-repository override under `repo_config`.
  "issue_executor_split",
  // Reviewer sub-agents (Issue #2575). Host-wide only.
  "issue_reviewer_agents",

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
  // Call-storm stall guard (Issue #2230)
  "call_storm_enabled",
  "call_storm_calls",
  "call_storm_window_seconds",
  // Agent transcript tee (Issue #1141) — off by default; the only operator
  // switch for the raw agent stream-json transcript.
  "agent_transcript_enabled",
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
  // Hours between trusted-author refreshes (Issue #1453).
  "trusted_authors_cache_hours",
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
  // Issue #805: `fleet_health_dir` and `fleet_health_repo` removed — built-in
  // fleet health reporting is gone; report health from a `callbacks` hook.
  // `REMOVED_CONFIG_KEYS` in lib/validation.ts refuses a stale config loudly.
  "github_app_id",
  "github_app_installation_id",
  "github_app_private_key_path",
  // The host log directory (Issue #873). Absolute, or anchored at `~`; the
  // only way to move it — LAUNCH_LOG_DIR and LOG_DIR are ignored (#1388).
  "log_dir",

  // Numeric settings
  "log_max_size_mb",
  "log_max_rotations",
  "stuck_issue_timeout",
  "issue_retry_cooldown",
  "min_disk_space_mb",
  // Issue #732: the claiming floor, stated where the rest of the host is.
  "host_disk_low_floor_gb",
  "host_disk_low_floor_percent",
  // Issue #1776: `milestone_sync_cooldown_seconds` removed — the milestone
  // sync now runs on every cycle in which the default tip moved, so there is
  // no cooldown to configure. A config still carrying it gets one
  // unknown-key warning and is otherwise ignored, not refused.
  "stale_failed_diagnostic_days",
  "stale_planning_warning_days",

  // Per-repository fast-failure back-off (Issue #1950)
  "fast_failure_seconds",
  "repo_fast_failure_threshold",
  "repo_fast_failure_window_hours",

  // Recent activity settings (Issue #1326)
  "include_recent_activity",
  "recent_activity_merged_pr_limit",
  "recent_activity_commit_limit",
  "recent_activity_max_tokens",
  "recent_activity_cache_ttl_seconds",

  // Codebase map (Issue #4281)
  "include_codebase_map",
  "timeline_cache_ttl_seconds",

  // CodeGraph repo context (Issue #2154, part of #2145)
  "codegraph_context",

  // RTK output (Issue #2380, part of #2328)
  "rtk_output",

  // brief toolchain (Issue #2603, part of #2581)
  "brief_toolchain",

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

  // Fleet PR cap on the default-branch stream — one fleet PR per slot (Issue #2663)
  "fleet_pr_slots",

  // Idle-task template draw weights (Issue #2401)
  "idle_task_template_weights",

  // Idle-task cadence floor for the important templates (Issue #4011)
  "idle_task_cadence",

  // Software auto-update minimum version floors (Issue #2622)
  "software_min_versions",

  // Deployer-supplied container build-time tools (Issue #69, parent #5)
  "container_tools",

  // This deployment's private environment extension (Issue #978, parent #933)
  "container_extension",

  // Post-run callback hooks (Issue #806, parent #796)
  "callbacks",

  // Graft repo-context injection (Issue #2098, part of #2060)
  "graft_context",

  // Custom label → non-public prompt file mappings (Issue #846, part of #843)
  "custom_label_prompts",
]);

/**
 * Recognised keys **inside** a top-level block that takes an object value,
 * keyed by the block's own name (Issue #2154).
 *
 * Only blocks whose vocabulary is small and fixed belong here: a typo inside
 * one is as invisible as a typo at the top level, so it earns the same warning.
 * Free-form maps (`repo_config`, `phase_model_overrides`, …) are deliberately
 * absent — their keys are operator-chosen, so nothing could be checked.
 */
//
// Built on demand rather than at module load: `codegraph_context_config.ts`
// imports the defaults, the defaults import the Graft config, and the Graft
// config imports this module (Issue #2098) — a load-time table here would
// read `CODEGRAPH_CONTEXT_KEYS` before its module finished initialising.
export function knownNestedConfigKeys(): ReadonlyMap<
  string,
  ReadonlySet<string>
> {
  return new Map([
    ["codegraph_context", CODEGRAPH_CONTEXT_KEYS],
    ["rtk_output", RTK_OUTPUT_KEYS],
  ]);
}

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
  return suggestKeyFrom(unknownKey, KNOWN_CONFIG_KEYS);
}

/**
 * Suggest the most likely intended key from an arbitrary recognised set.
 *
 * The strategies are {@link suggestSimilarKey}'s, lifted so a nested block
 * (`graft_context`, Issue #2098) gets the same help against its own key set
 * rather than against the top-level one.
 *
 * @param unknownKey - The unrecognised key
 * @param knownKeys - The keys recognised at that level
 * @returns The suggested correct key, or null if no close match found
 */
function suggestKeyFrom(
  unknownKey: string,
  knownKeys: ReadonlySet<string>,
): string | null {
  return suggestFrom(unknownKey, knownKeys);
}

/**
 * Suggest the most likely intended key from a given candidate set.
 *
 * The two strategies {@link suggestSimilarKey} documents, applied to whichever
 * vocabulary is in play — the top-level keys, or the keys of one nested block.
 *
 * @param unknownKey - The unrecognised key.
 * @param candidates - The keys that would have been recognised.
 * @returns The suggested key, or null if no close match found.
 */
function suggestFrom(
  unknownKey: string,
  candidates: ReadonlySet<string>,
): string | null {
  // Strategy 1: Try camelCase → snake_case conversion
  const snakeVersion = camelToSnake(unknownKey);
  if (candidates.has(snakeVersion)) {
    return snakeVersion;
  }

  // Strategy 2: Find the closest match by edit distance
  // Allow up to 3 edits for longer keys, 2 for shorter ones
  const maxDistance = unknownKey.length <= 8 ? 2 : 3;
  let bestMatch: string | null = null;
  let bestDistance = maxDistance + 1;

  for (const knownKey of candidates) {
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
      warnings.push(unknownKeyWarning(key, KNOWN_CONFIG_KEYS));
      continue;
    }

    // Issue #2154: a block with its own vocabulary gets the same treatment one
    // level down — a typo inside it would otherwise read as a setting the
    // operator made and the worker never saw.
    const nestedKeys = knownNestedConfigKeys().get(key);
    if (!nestedKeys) continue;
    const block = data[key];
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      // A malformed block is the block parser's to refuse, not ours to guess at.
      continue;
    }
    for (const nested of Object.keys(block)) {
      if (nestedKeys.has(nested)) continue;
      warnings.push(unknownKeyWarning(nested, nestedKeys, key));
    }
  }

  return warnings;
}

/**
 * Detect unknown keys inside a nested `.config.json` block.
 *
 * The same warn-and-ignore treatment {@link detectUnknownConfigKeys} gives the
 * top level, one level down: the reported field is dotted
 * (`graft_context.enabledd`) and the suggestion is drawn from the block's own
 * recognised keys.
 *
 * @param block - The parsed nested block
 * @param blockName - The block's key in `.config.json`, e.g. `graft_context`
 * @param knownKeys - Keys recognised inside that block
 * @returns Array of warnings for unknown nested keys
 */
export function detectUnknownNestedKeys(
  block: Record<string, unknown>,
  blockName: string,
  knownKeys: ReadonlySet<string>,
): UnknownKeyWarning[] {
  const warnings: UnknownKeyWarning[] = [];

  for (const key of Object.keys(block)) {
    if (knownKeys.has(key)) continue;
    const match = suggestKeyFrom(key, knownKeys);
    const suggestion = match === null ? null : `${blockName}.${match}`;
    const field = `${blockName}.${key}`;
    const message = suggestion
      ? `Unknown config key "${field}" in .config.json. Did you mean "${suggestion}"?`
      : `Unknown config key "${field}" in .config.json. This attribute is not recognised and will be ignored.`;

    warnings.push({ field, message, suggestion });
  }

  return warnings;
}

/**
 * Build one warning for an unrecognised key.
 *
 * @param key - The unrecognised key, as written in the file.
 * @param candidates - The keys that would have been recognised in its position.
 * @param blockPrefix - The enclosing block, for a nested key.
 * @returns The warning, with a suggestion when a close match exists.
 */
function unknownKeyWarning(
  key: string,
  candidates: ReadonlySet<string>,
  blockPrefix?: string,
): UnknownKeyWarning {
  const qualify = (name: string) =>
    blockPrefix ? `${blockPrefix}.${name}` : name;
  const suggestion = suggestFrom(key, candidates);
  const field = qualify(key);
  const message = suggestion
    ? `Unknown config key "${field}" in .config.json. Did you mean "${
      qualify(suggestion)
    }"?`
    : `Unknown config key "${field}" in .config.json. This attribute is not recognised and will be ignored.`;

  return {
    field,
    message,
    suggestion: suggestion ? qualify(suggestion) : null,
  };
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
