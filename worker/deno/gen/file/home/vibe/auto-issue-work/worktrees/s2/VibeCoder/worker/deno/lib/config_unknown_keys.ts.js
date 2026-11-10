/**
 * Unknown config key detection for .config.json validation (Issue #1334).
 *
 * Detects unknown attributes in .config.json at startup and provides
 * clear warnings with suggestions for likely intended keys (e.g.,
 * camelCase vs snake_case mistakes, typos).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */ import { CODEGRAPH_CONTEXT_KEYS } from "./codegraph_context_config.ts";
import { RTK_OUTPUT_KEYS } from "./rtk_output_config.ts";
/**
 * Complete set of valid top-level keys in .config.json.
 *
 * This is the single source of truth for recognised config attributes.
 * When adding a new config field, add its snake_case key here.
 */ export const KNOWN_CONFIG_KEYS = new Set([
  // Core fields
  // Issue #1834: `issue_labels` removed — top-priority/work-on/low-priority
  // are hardwired discovery labels.
  "allowed_authors",
  "pr_reviewers",
  // The GitHub App the review-fleet-prs skill reviews as; read by that
  // skill's app_token.ts, not by the worker.
  "pr_reviewer_app",
  // No longer read since Issue #4655 (the default test-change policy is an
  // evidence review); tolerated so an existing config still loads. Read, if at
  // all, only by the review-fleet-prs skill's test_change_policy.ts.
  "pr_reviewer_auto_release",
  // Owner override for the review-fleet-prs skill's test-change policy
  // (Issue #4655): repos where every meaningful test change stays an
  // owner-comment hold. Read by that skill's test_change_policy.ts, not by the worker.
  "pr_reviewer_test_hold_repos",
  // How many review rounds the unattended review-fleet-prs runner runs at
  // once (Issue #4395); read by that skill's run.sh, not by the worker.
  "pr_reviewer_parallel",
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
  // Copilot code review on/off/leave, applied by setup (Issue #2701).
  "copilot_code_review",
  "agent_provider_mode",
  "agent_provider",
  "agent_providers",
  "agent_provider_fallback",
  "egress_allow_hosts",
  "claude_week_pace_drain",
  "claude_model",
  "best_planning_model",
  "phase_model_overrides",
  "phase_model_tiers",
  "provider_model_tiers",
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
  // Issue-executor sub-agent tier (Issue #3401). Host-wide, with a same-named
  // per-repository override under `repo_config`.
  "issue_sub_agent_tier",
  // Reviewer sub-agents (Issue #2575). Host-wide only.
  "issue_reviewer_agents",
  // External orchestrator (Issue #3642). Host-wide only.
  "external_orchestration",
  "external_orchestration_settings",
  // Fleet-wide run archive repo slug for measurement issues (Issue #2930).
  "fleet_run_archive",
  // Operator label for the subscription allocation recorded on each issue's
  // lifecycle-ledger assignment (Issue #3718). A label only.
  "subscription_allocation_label",
  "subscription_allocation",
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
  "claude_max_turns",
  "min_claim_runway_seconds",
  // Run finish deadline (Issue #4242).
  "run_finish_seconds",
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
  // Screenshot gate's one extra in-run agent turn (Issue #2960)
  "screenshot_retry_timeout_seconds",
  // Pre-push gate's one extra in-run agent turn (Issue #4128)
  "pre_push_retry_timeout_seconds",
  // Call-storm stall guard (Issue #2230)
  "call_storm_enabled",
  "call_storm_calls",
  "call_storm_window_seconds",
  // Call-storm novelty share (Issue #2773)
  "call_storm_novel_share",
  // Quota-aware polling gate floors (Issue #3628)
  "quota_poll_park_floor",
  "quota_poll_park_nice",
  "quota_poll_idle_floor",
  // Nice-derived poll cadence (Issue #3667)
  "poll_cadence_low_cycles",
  "poll_cadence_park_cycles",
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
  "pr_scanning_enabled",
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
  // Host build-cache reclaim before a work-volume recreate (Issue #4498).
  // Literals, not the HOST_CACHE_RECLAIM_*_KEY constants: host_cache_reclaim.ts
  // reaches config.ts through its imports, so importing it here would read
  // them before that module finished initialising. A test builds a record
  // from the constants and asserts none is reported unknown.
  "host_cache_reclaim_enabled",
  "host_cache_reclaim_min_age_hours",
  "host_cache_reclaim_headroom_gb",
  "host_cache_reclaim_roots"
]);
/**
 * Recognised keys **inside** a top-level block that takes an object value,
 * keyed by the block's own name (Issue #2154).
 *
 * Only blocks whose vocabulary is small and fixed belong here: a typo inside
 * one is as invisible as a typo at the top level, so it earns the same warning.
 * Free-form maps (`repo_config`, `phase_model_overrides`, …) are deliberately
 * absent — their keys are operator-chosen, so nothing could be checked.
 */ //
// Built on demand rather than at module load: `codegraph_context_config.ts`
// imports the defaults, the defaults import the Graft config, and the Graft
// config imports this module (Issue #2098) — a load-time table here would
// read `CODEGRAPH_CONTEXT_KEYS` before its module finished initialising.
export function knownNestedConfigKeys() {
  return new Map([
    [
      "codegraph_context",
      CODEGRAPH_CONTEXT_KEYS
    ],
    [
      "rtk_output",
      RTK_OUTPUT_KEYS
    ]
  ]);
}
/**
 * Convert a camelCase string to snake_case.
 *
 * @param camel - The camelCase string
 * @returns The snake_case equivalent
 */ function camelToSnake(camel) {
  return camel.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}
/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Used to find close matches for typos in config keys.
 */ function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  // Use a two-row optimisation for space efficiency
  let previousRow = Array.from({
    length: n + 1
  }, (_, i)=>i);
  for(let i = 1; i <= m; i++){
    const currentRow = [
      i
    ];
    for(let j = 1; j <= n; j++){
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow[j] = Math.min((previousRow[j] ?? 0) + 1, (currentRow[j - 1] ?? 0) + 1, (previousRow[j - 1] ?? 0) + cost);
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
 */ export function suggestSimilarKey(unknownKey) {
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
 */ function suggestKeyFrom(unknownKey, knownKeys) {
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
 */ function suggestFrom(unknownKey, candidates) {
  // Strategy 1: Try camelCase → snake_case conversion
  const snakeVersion = camelToSnake(unknownKey);
  if (candidates.has(snakeVersion)) {
    return snakeVersion;
  }
  // Strategy 2: Find the closest match by edit distance
  // Allow up to 3 edits for longer keys, 2 for shorter ones
  const maxDistance = unknownKey.length <= 8 ? 2 : 3;
  let bestMatch = null;
  let bestDistance = maxDistance + 1;
  for (const knownKey of candidates){
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
 */ export function detectUnknownConfigKeys(data) {
  const warnings = [];
  for (const key of Object.keys(data)){
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
      continue;
    }
    for (const nested of Object.keys(block)){
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
 */ export function detectUnknownNestedKeys(block, blockName, knownKeys) {
  const warnings = [];
  for (const key of Object.keys(block)){
    if (knownKeys.has(key)) continue;
    const match = suggestKeyFrom(key, knownKeys);
    const suggestion = match === null ? null : `${blockName}.${match}`;
    const field = `${blockName}.${key}`;
    const message = suggestion ? `Unknown config key "${field}" in .config.json. Did you mean "${suggestion}"?` : `Unknown config key "${field}" in .config.json. This attribute is not recognised and will be ignored.`;
    warnings.push({
      field,
      message,
      suggestion
    });
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
 */ function unknownKeyWarning(key, candidates, blockPrefix) {
  const qualify = (name)=>blockPrefix ? `${blockPrefix}.${name}` : name;
  const suggestion = suggestFrom(key, candidates);
  const field = qualify(key);
  const message = suggestion ? `Unknown config key "${field}" in .config.json. Did you mean "${qualify(suggestion)}"?` : `Unknown config key "${field}" in .config.json. This attribute is not recognised and will be ignored.`;
  return {
    field,
    message,
    suggestion: suggestion ? qualify(suggestion) : null
  };
}
/**
 * Format unknown key warnings as a human-readable string for logging.
 *
 * @param warnings - Array of unknown key warnings
 * @returns Formatted warning string, or empty string if no warnings
 */ export function formatUnknownKeyWarnings(warnings) {
  if (warnings.length === 0) return "";
  const lines = [
    `⚠️  .config.json validation: ${warnings.length} unknown attribute${warnings.length === 1 ? "" : "s"} found:`
  ];
  for (const warning of warnings){
    if (warning.suggestion) {
      lines.push(`  - "${warning.field}" → did you mean "${warning.suggestion}"?`);
    } else {
      lines.push(`  - "${warning.field}" is not a recognised config key`);
    }
  }
  lines.push("  See docs/CONFIGURATION.md for the full list of valid attributes.");
  return lines.join("\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb25maWdfdW5rbm93bl9rZXlzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVW5rbm93biBjb25maWcga2V5IGRldGVjdGlvbiBmb3IgLmNvbmZpZy5qc29uIHZhbGlkYXRpb24gKElzc3VlICMxMzM0KS5cbiAqXG4gKiBEZXRlY3RzIHVua25vd24gYXR0cmlidXRlcyBpbiAuY29uZmlnLmpzb24gYXQgc3RhcnR1cCBhbmQgcHJvdmlkZXNcbiAqIGNsZWFyIHdhcm5pbmdzIHdpdGggc3VnZ2VzdGlvbnMgZm9yIGxpa2VseSBpbnRlbmRlZCBrZXlzIChlLmcuLFxuICogY2FtZWxDYXNlIHZzIHNuYWtlX2Nhc2UgbWlzdGFrZXMsIHR5cG9zKS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLilcbiAqL1xuXG5pbXBvcnQgeyBDT0RFR1JBUEhfQ09OVEVYVF9LRVlTIH0gZnJvbSBcIi4vY29kZWdyYXBoX2NvbnRleHRfY29uZmlnLnRzXCI7XG5pbXBvcnQgeyBSVEtfT1VUUFVUX0tFWVMgfSBmcm9tIFwiLi9ydGtfb3V0cHV0X2NvbmZpZy50c1wiO1xuXG4vKipcbiAqIFdhcm5pbmcgYWJvdXQgYW4gdW5rbm93biBjb25maWd1cmF0aW9uIGtleS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBVbmtub3duS2V5V2FybmluZyB7XG4gIC8qKiBUaGUgdW5yZWNvZ25pc2VkIGtleSBuYW1lIGZyb20gLmNvbmZpZy5qc29uICovXG4gIGZpZWxkOiBzdHJpbmc7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSB3YXJuaW5nIG1lc3NhZ2UgKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xuICAvKiogU3VnZ2VzdGVkIGNvcnJlY3Qga2V5IG5hbWUsIG9yIG51bGwgaWYgbm8gY2xvc2UgbWF0Y2ggZm91bmQgKi9cbiAgc3VnZ2VzdGlvbjogc3RyaW5nIHwgbnVsbDtcbn1cblxuLyoqXG4gKiBDb21wbGV0ZSBzZXQgb2YgdmFsaWQgdG9wLWxldmVsIGtleXMgaW4gLmNvbmZpZy5qc29uLlxuICpcbiAqIFRoaXMgaXMgdGhlIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHJlY29nbmlzZWQgY29uZmlnIGF0dHJpYnV0ZXMuXG4gKiBXaGVuIGFkZGluZyBhIG5ldyBjb25maWcgZmllbGQsIGFkZCBpdHMgc25ha2VfY2FzZSBrZXkgaGVyZS5cbiAqL1xuZXhwb3J0IGNvbnN0IEtOT1dOX0NPTkZJR19LRVlTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIC8vIENvcmUgZmllbGRzXG4gIC8vIElzc3VlICMxODM0OiBgaXNzdWVfbGFiZWxzYCByZW1vdmVkIOKAlCB0b3AtcHJpb3JpdHkvd29yay1vbi9sb3ctcHJpb3JpdHlcbiAgLy8gYXJlIGhhcmR3aXJlZCBkaXNjb3ZlcnkgbGFiZWxzLlxuICBcImFsbG93ZWRfYXV0aG9yc1wiLFxuICBcInByX3Jldmlld2Vyc1wiLFxuICAvLyBUaGUgR2l0SHViIEFwcCB0aGUgcmV2aWV3LWZsZWV0LXBycyBza2lsbCByZXZpZXdzIGFzOyByZWFkIGJ5IHRoYXRcbiAgLy8gc2tpbGwncyBhcHBfdG9rZW4udHMsIG5vdCBieSB0aGUgd29ya2VyLlxuICBcInByX3Jldmlld2VyX2FwcFwiLFxuICAvLyBObyBsb25nZXIgcmVhZCBzaW5jZSBJc3N1ZSAjNDY1NSAodGhlIGRlZmF1bHQgdGVzdC1jaGFuZ2UgcG9saWN5IGlzIGFuXG4gIC8vIGV2aWRlbmNlIHJldmlldyk7IHRvbGVyYXRlZCBzbyBhbiBleGlzdGluZyBjb25maWcgc3RpbGwgbG9hZHMuIFJlYWQsIGlmIGF0XG4gIC8vIGFsbCwgb25seSBieSB0aGUgcmV2aWV3LWZsZWV0LXBycyBza2lsbCdzIHRlc3RfY2hhbmdlX3BvbGljeS50cy5cbiAgXCJwcl9yZXZpZXdlcl9hdXRvX3JlbGVhc2VcIixcbiAgLy8gT3duZXIgb3ZlcnJpZGUgZm9yIHRoZSByZXZpZXctZmxlZXQtcHJzIHNraWxsJ3MgdGVzdC1jaGFuZ2UgcG9saWN5XG4gIC8vIChJc3N1ZSAjNDY1NSk6IHJlcG9zIHdoZXJlIGV2ZXJ5IG1lYW5pbmdmdWwgdGVzdCBjaGFuZ2Ugc3RheXMgYW5cbiAgLy8gb3duZXItY29tbWVudCBob2xkLiBSZWFkIGJ5IHRoYXQgc2tpbGwncyB0ZXN0X2NoYW5nZV9wb2xpY3kudHMsIG5vdCBieSB0aGUgd29ya2VyLlxuICBcInByX3Jldmlld2VyX3Rlc3RfaG9sZF9yZXBvc1wiLFxuICAvLyBIb3cgbWFueSByZXZpZXcgcm91bmRzIHRoZSB1bmF0dGVuZGVkIHJldmlldy1mbGVldC1wcnMgcnVubmVyIHJ1bnMgYXRcbiAgLy8gb25jZSAoSXNzdWUgIzQzOTUpOyByZWFkIGJ5IHRoYXQgc2tpbGwncyBydW4uc2gsIG5vdCBieSB0aGUgd29ya2VyLlxuICBcInByX3Jldmlld2VyX3BhcmFsbGVsXCIsXG4gIFwicmVwb3NcIixcbiAgXCJhdXRob3JpemVkX2NvbW1lbnRlcnNcIixcbiAgXCJhdXRob3Jfc291cmNlXCIsXG4gIFwiZXhjbHVzaW9uX3RlYW1cIixcbiAgXCJzZXJ2aWNlX2FjY291bnRzXCIsXG4gIC8vIERlZmF1bHQgQ09ERU9XTkVSUyBvd25lcnMgd3JpdHRlbiBieSBzZXR1cCAoSXNzdWUgIzI2MjcpLlxuICBcImNvZGVvd25lcnNfb3duZXJzXCIsXG4gIFwidHJ1c3RlZF9yZXZpZXdfYm90c1wiLFxuICBcImZsZWV0X3ByX2F1dGhvcnNcIixcbiAgXCJyZXBvX2NvbmZpZ1wiLFxuICBcInJ1bl9tb2RlXCIsXG4gIC8vIFVwZGF0ZSBtb2RlIGFuZCBpdHMgcGlucyAoSXNzdWUgIzYyMiwgcGFydCBvZiAjNTgzKS5cbiAgXCJ1cGRhdGVfbW9kZVwiLFxuICBcInBpbm5lZF9yZWZcIixcbiAgXCJwaW5uZWRfdG9vbF92ZXJzaW9uc1wiLFxuICAvLyBDb3BpbG90IGNvZGUgcmV2aWV3IG9uL29mZi9sZWF2ZSwgYXBwbGllZCBieSBzZXR1cCAoSXNzdWUgIzI3MDEpLlxuICBcImNvcGlsb3RfY29kZV9yZXZpZXdcIixcbiAgXCJhZ2VudF9wcm92aWRlcl9tb2RlXCIsXG4gIFwiYWdlbnRfcHJvdmlkZXJcIixcbiAgXCJhZ2VudF9wcm92aWRlcnNcIixcbiAgXCJhZ2VudF9wcm92aWRlcl9mYWxsYmFja1wiLFxuICBcImVncmVzc19hbGxvd19ob3N0c1wiLFxuICBcImNsYXVkZV93ZWVrX3BhY2VfZHJhaW5cIixcbiAgXCJjbGF1ZGVfbW9kZWxcIixcbiAgXCJiZXN0X3BsYW5uaW5nX21vZGVsXCIsXG4gIFwicGhhc2VfbW9kZWxfb3ZlcnJpZGVzXCIsXG4gIFwicGhhc2VfbW9kZWxfdGllcnNcIixcbiAgXCJwcm92aWRlcl9tb2RlbF90aWVyc1wiLFxuICBcInBoYXNlX2VmZm9ydF9vdmVycmlkZXNcIixcbiAgLy8gQ29kZXggcGVyLXBoYXNlIHJvdXRpbmcgb3ZlcnJpZGVzIChJc3N1ZSAjMzYzKS5cbiAgXCJjb2RleF9waGFzZV9tb2RlbF9vdmVycmlkZXNcIixcbiAgXCJjb2RleF9waGFzZV9lZmZvcnRfb3ZlcnJpZGVzXCIsXG4gIC8vIEdlbWluaSBwZXItcGhhc2UgbW9kZWwgb3ZlcnJpZGVzIChJc3N1ZSAjMzY0KS4gTW9kZWwgb25seSDigJQgdGhlIEdlbWluaVxuICAvLyBDTEkgaGFzIG5vIHJlYXNvbmluZy1lZmZvcnQgb3B0aW9uIHRvIG92ZXJyaWRlLlxuICBcImdlbWluaV9waGFzZV9tb2RlbF9vdmVycmlkZXNcIixcbiAgLy8gRGVlcFNlZWsgcGVyLXBoYXNlIG1vZGVsIG92ZXJyaWRlcyAoSXNzdWUgIzQxMykuIE1vZGVsIG9ubHkg4oCUIERlZXBTZWVrJ3NcbiAgLy8gQW50aHJvcGljLWNvbXBhdGlibGUgZW5kcG9pbnQgaGFzIG5vIGVmZm9ydCBjb250cm9sIHRvIG92ZXJyaWRlLlxuICBcImRlZXBzZWVrX3BoYXNlX21vZGVsX292ZXJyaWRlc1wiLFxuICAvLyBJc3N1ZS1leGVjdXRvciBzcGxpdCAoSXNzdWUgIzIzNDEpLiBIb3N0LXdpZGUsIHdpdGggYSBzYW1lLW5hbWVkXG4gIC8vIHBlci1yZXBvc2l0b3J5IG92ZXJyaWRlIHVuZGVyIGByZXBvX2NvbmZpZ2AuXG4gIFwiaXNzdWVfZXhlY3V0b3Jfc3BsaXRcIixcbiAgLy8gSXNzdWUtZXhlY3V0b3Igc3ViLWFnZW50IHRpZXIgKElzc3VlICMzNDAxKS4gSG9zdC13aWRlLCB3aXRoIGEgc2FtZS1uYW1lZFxuICAvLyBwZXItcmVwb3NpdG9yeSBvdmVycmlkZSB1bmRlciBgcmVwb19jb25maWdgLlxuICBcImlzc3VlX3N1Yl9hZ2VudF90aWVyXCIsXG4gIC8vIFJldmlld2VyIHN1Yi1hZ2VudHMgKElzc3VlICMyNTc1KS4gSG9zdC13aWRlIG9ubHkuXG4gIFwiaXNzdWVfcmV2aWV3ZXJfYWdlbnRzXCIsXG4gIC8vIEV4dGVybmFsIG9yY2hlc3RyYXRvciAoSXNzdWUgIzM2NDIpLiBIb3N0LXdpZGUgb25seS5cbiAgXCJleHRlcm5hbF9vcmNoZXN0cmF0aW9uXCIsXG4gIFwiZXh0ZXJuYWxfb3JjaGVzdHJhdGlvbl9zZXR0aW5nc1wiLFxuICAvLyBGbGVldC13aWRlIHJ1biBhcmNoaXZlIHJlcG8gc2x1ZyBmb3IgbWVhc3VyZW1lbnQgaXNzdWVzIChJc3N1ZSAjMjkzMCkuXG4gIFwiZmxlZXRfcnVuX2FyY2hpdmVcIixcbiAgLy8gT3BlcmF0b3IgbGFiZWwgZm9yIHRoZSBzdWJzY3JpcHRpb24gYWxsb2NhdGlvbiByZWNvcmRlZCBvbiBlYWNoIGlzc3VlJ3NcbiAgLy8gbGlmZWN5Y2xlLWxlZGdlciBhc3NpZ25tZW50IChJc3N1ZSAjMzcxOCkuIEEgbGFiZWwgb25seS5cbiAgXCJzdWJzY3JpcHRpb25fYWxsb2NhdGlvbl9sYWJlbFwiLFxuICBcInN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uXCIsXG5cbiAgLy8gTGFiZWwgZmllbGRzXG4gIC8vIElzc3VlICMxODM0OiBgd29ya19vbl9sYWJlbGAgYW5kIGBsb3dfcHJpb3JpdHlfbGFiZWxgIHJlbW92ZWQg4oCUIGJvdGhcbiAgLy8gYXJlIGhhcmR3aXJlZCBhbmQgbm90IGNvbmZpZ3VyYWJsZS5cbiAgXCJmYWlsZWRfb25jZV9sYWJlbFwiLFxuICBcImZhaWxlZF9sYWJlbFwiLFxuICBcInJlZmluZV9pc3N1ZV9sYWJlbFwiLFxuICBcInBsYW5uaW5nX2xhYmVsXCIsXG4gIFwicXVlc3Rpb25fbGFiZWxcIixcbiAgXCJuZWVkc19yZXZpc2lvbl9sYWJlbFwiLFxuICBcIm5lZWRzX2h1bWFuX2xhYmVsXCIsXG4gIC8vIFF1b3J1bSBwbGFuLW9mZiAoSXNzdWUgIzQxMTIpIOKAlCBsYWJlbCwgYm91bmRzIGFuZCBwcm92aWRlciB0cmlvLlxuICBcInF1b3J1bV9sYWJlbFwiLFxuXG4gIC8vIFRpbWVvdXQgYW5kIGludGVydmFsIGZpZWxkc1xuICBcImNsYXVkZV90aW1lb3V0XCIsXG4gIFwiY2xhdWRlX21heF90dXJuc1wiLFxuICBcIm1pbl9jbGFpbV9ydW53YXlfc2Vjb25kc1wiLFxuICAvLyBSdW4gZmluaXNoIGRlYWRsaW5lIChJc3N1ZSAjNDI0MikuXG4gIFwicnVuX2ZpbmlzaF9zZWNvbmRzXCIsXG4gIC8vIElzc3VlICM0MjU6IGBjbGFpbV9yZXF1aXJlX2Z1bGxfZXhlY3V0ZV9idWRnZXRgIHJlbW92ZWQg4oCUIHRoZSAjNDcgcnVsZSBpdFxuICAvLyBzd2l0Y2hlZCBvbiB3YXMgcmV0aXJlZCB3aXRoIHRoZSBkZWFkbGluZSB0cnVuY2F0aW9uIHRoYXQganVzdGlmaWVkIGl0LlxuICAvLyBBZGFwdGl2ZSBjbGFpbSBmbG9vciAoSXNzdWUgIzI0NSlcbiAgXCJjbGFpbV9sb25nX2pvYl9sYWJlbHNcIixcbiAgLy8gUmUtYXJtYWJsZSBpc3N1ZS13b3JrIGRlYWRsaW5lIChJc3N1ZSAjNDI5NiwgcGFydCBvZiAjNDI5MClcbiAgXCJwcm9ncmVzc19leHRlbnNpb25fZW5hYmxlZFwiLFxuICBcInByb2dyZXNzX2V4dGVuc2lvbl9ncmFudF9zZWNvbmRzXCIsXG4gIFwicHJvZ3Jlc3NfZXh0ZW5zaW9uX3N0YWxsX3NlY29uZHNcIixcbiAgLy8gV29ya2luZy10cmVlIHNhbXBsaW5nIGludGVydmFsIChJc3N1ZSAjNDI5NSlcbiAgXCJwcm9ncmVzc19leHRlbnNpb25fY2hlY2tfc2Vjb25kc1wiLFxuICAvLyBTY3JlZW5zaG90IGdhdGUncyBvbmUgZXh0cmEgaW4tcnVuIGFnZW50IHR1cm4gKElzc3VlICMyOTYwKVxuICBcInNjcmVlbnNob3RfcmV0cnlfdGltZW91dF9zZWNvbmRzXCIsXG4gIC8vIFByZS1wdXNoIGdhdGUncyBvbmUgZXh0cmEgaW4tcnVuIGFnZW50IHR1cm4gKElzc3VlICM0MTI4KVxuICBcInByZV9wdXNoX3JldHJ5X3RpbWVvdXRfc2Vjb25kc1wiLFxuICAvLyBDYWxsLXN0b3JtIHN0YWxsIGd1YXJkIChJc3N1ZSAjMjIzMClcbiAgXCJjYWxsX3N0b3JtX2VuYWJsZWRcIixcbiAgXCJjYWxsX3N0b3JtX2NhbGxzXCIsXG4gIFwiY2FsbF9zdG9ybV93aW5kb3dfc2Vjb25kc1wiLFxuICAvLyBDYWxsLXN0b3JtIG5vdmVsdHkgc2hhcmUgKElzc3VlICMyNzczKVxuICBcImNhbGxfc3Rvcm1fbm92ZWxfc2hhcmVcIixcbiAgLy8gUXVvdGEtYXdhcmUgcG9sbGluZyBnYXRlIGZsb29ycyAoSXNzdWUgIzM2MjgpXG4gIFwicXVvdGFfcG9sbF9wYXJrX2Zsb29yXCIsXG4gIFwicXVvdGFfcG9sbF9wYXJrX25pY2VcIixcbiAgXCJxdW90YV9wb2xsX2lkbGVfZmxvb3JcIixcbiAgLy8gTmljZS1kZXJpdmVkIHBvbGwgY2FkZW5jZSAoSXNzdWUgIzM2NjcpXG4gIFwicG9sbF9jYWRlbmNlX2xvd19jeWNsZXNcIixcbiAgXCJwb2xsX2NhZGVuY2VfcGFya19jeWNsZXNcIixcbiAgLy8gQWdlbnQgdHJhbnNjcmlwdCB0ZWUgKElzc3VlICMxMTQxKSDigJQgb2ZmIGJ5IGRlZmF1bHQ7IHRoZSBvbmx5IG9wZXJhdG9yXG4gIC8vIHN3aXRjaCBmb3IgdGhlIHJhdyBhZ2VudCBzdHJlYW0tanNvbiB0cmFuc2NyaXB0LlxuICBcImFnZW50X3RyYW5zY3JpcHRfZW5hYmxlZFwiLFxuICAvLyBTZWxmLXNjaGVkdWxlZCB3b3JrZXIgZGlhZ25vc3RpY3MgKElzc3VlICM1MDUpXG4gIFwic2VsZl9zY2hlZHVsZV9kaWFnbm9zdGljc19lbmFibGVkXCIsXG4gIFwic2VsZl9zY2hlZHVsZV9kaWFnbm9zdGljc19tYXhfaW5fZmxpZ2h0XCIsXG4gIFwiY2xhdWRlX2tpbGxfYWZ0ZXJcIixcbiAgXCJtYXhfY2xhcmlmaWNhdGlvbl9yb3VuZHNcIixcbiAgXCJzbGVlcF9pbnRlcnZhbFwiLFxuICBcIm1heF9jb25jdXJyZW50X2lzc3Vlc1wiLFxuICBcInByX3NjYW5uaW5nX2VuYWJsZWRcIixcbiAgXCJjcmVkaXRfd2FpdF9pbnRlcnZhbFwiLFxuICBcInJlZmluZW1lbnRfdGltZW91dFwiLFxuICBcInJlZmluZW1lbnRfa2lsbF9hZnRlclwiLFxuICBcInBsYW5uaW5nX3RpbWVvdXRcIixcbiAgXCJwbGFubmluZ19raWxsX2FmdGVyXCIsXG4gIFwicXVlc3Rpb25fdGltZW91dFwiLFxuICBcInF1ZXN0aW9uX2tpbGxfYWZ0ZXJcIixcbiAgXCJjbGFyaWZpY2F0aW9uX3RpbWVvdXRcIixcbiAgXCJjbGFyaWZpY2F0aW9uX2tpbGxfYWZ0ZXJcIixcbiAgXCJxdW9ydW1fdGltZW91dFwiLFxuICBcInF1b3J1bV9raWxsX2FmdGVyXCIsXG4gIFwicXVvcnVtX3BsYW5uZXJzXCIsXG4gIFwicXVvcnVtX2p1ZGdlXCIsXG4gIFwibWF4X3JhdGVfbGltaXRfcmV0cmllc1wiLFxuICBcIm1heF9yYXRlX2xpbWl0X3dhaXRcIixcbiAgLy8gSG91cnMgYmV0d2VlbiB0cnVzdGVkLWF1dGhvciByZWZyZXNoZXMgKElzc3VlICMxNDUzKS5cbiAgXCJ0cnVzdGVkX2F1dGhvcnNfY2FjaGVfaG91cnNcIixcbiAgXCJyZXRyeV9tYXhfZGVsYXlcIixcbiAgXCJtYXhfaXNzdWVfYm9keV90b2tlbnNcIixcbiAgXCJzdW1tYXJpc2VfdGltZW91dFwiLFxuICBcInN1bW1hcmlzZV9raWxsX2FmdGVyXCIsXG4gIFwiZmVhdHVyZV9jaGVja190aW1lb3V0XCIsXG4gIFwiY2xhdWRlX25vX291dHB1dF90aW1lb3V0XCIsXG4gIFwicXVhbGl0eV9jaGVja190aW1lb3V0XCIsXG4gIFwiaGVhbHRoX2NhY2hlX3R0bFwiLFxuXG4gIC8vIEJvb2xlYW4gZmxhZ3NcbiAgXCJzaHVmZmxlX3JlcG9zXCIsXG4gIFwidXBkYXRlX2doX3VzZXJfc3RhdHVzXCIsXG4gIFwiZW5hYmxlX21vZGVsX2ZhbGxiYWNrXCIsXG4gIFwic3luY19taWxlc3RvbmVfYnJhbmNoZXNcIixcblxuICAvLyBTdHJpbmcgc2V0dGluZ3NcbiAgXCJ3b3JrZXJfbmFtZVwiLFxuICBcInNzaF9rZXlfcGF0aFwiLFxuICBcImdoX2NvbmZpZ19kaXJcIixcbiAgXCJpbWdiYl9hcGlfa2V5XCIsXG4gIC8vIElzc3VlICM4MDU6IGBmbGVldF9oZWFsdGhfZGlyYCBhbmQgYGZsZWV0X2hlYWx0aF9yZXBvYCByZW1vdmVkIOKAlCBidWlsdC1pblxuICAvLyBmbGVldCBoZWFsdGggcmVwb3J0aW5nIGlzIGdvbmU7IHJlcG9ydCBoZWFsdGggZnJvbSBhIGBjYWxsYmFja3NgIGhvb2suXG4gIC8vIGBSRU1PVkVEX0NPTkZJR19LRVlTYCBpbiBsaWIvdmFsaWRhdGlvbi50cyByZWZ1c2VzIGEgc3RhbGUgY29uZmlnIGxvdWRseS5cbiAgXCJnaXRodWJfYXBwX2lkXCIsXG4gIFwiZ2l0aHViX2FwcF9pbnN0YWxsYXRpb25faWRcIixcbiAgXCJnaXRodWJfYXBwX3ByaXZhdGVfa2V5X3BhdGhcIixcbiAgLy8gVGhlIGhvc3QgbG9nIGRpcmVjdG9yeSAoSXNzdWUgIzg3MykuIEFic29sdXRlLCBvciBhbmNob3JlZCBhdCBgfmA7IHRoZVxuICAvLyBvbmx5IHdheSB0byBtb3ZlIGl0IOKAlCBMQVVOQ0hfTE9HX0RJUiBhbmQgTE9HX0RJUiBhcmUgaWdub3JlZCAoIzEzODgpLlxuICBcImxvZ19kaXJcIixcblxuICAvLyBOdW1lcmljIHNldHRpbmdzXG4gIFwibG9nX21heF9zaXplX21iXCIsXG4gIFwibG9nX21heF9yb3RhdGlvbnNcIixcbiAgXCJzdHVja19pc3N1ZV90aW1lb3V0XCIsXG4gIFwiaXNzdWVfcmV0cnlfY29vbGRvd25cIixcbiAgXCJtaW5fZGlza19zcGFjZV9tYlwiLFxuICAvLyBJc3N1ZSAjNzMyOiB0aGUgY2xhaW1pbmcgZmxvb3IsIHN0YXRlZCB3aGVyZSB0aGUgcmVzdCBvZiB0aGUgaG9zdCBpcy5cbiAgXCJob3N0X2Rpc2tfbG93X2Zsb29yX2diXCIsXG4gIFwiaG9zdF9kaXNrX2xvd19mbG9vcl9wZXJjZW50XCIsXG4gIC8vIElzc3VlICMxNzc2OiBgbWlsZXN0b25lX3N5bmNfY29vbGRvd25fc2Vjb25kc2AgcmVtb3ZlZCDigJQgdGhlIG1pbGVzdG9uZVxuICAvLyBzeW5jIG5vdyBydW5zIG9uIGV2ZXJ5IGN5Y2xlIGluIHdoaWNoIHRoZSBkZWZhdWx0IHRpcCBtb3ZlZCwgc28gdGhlcmUgaXNcbiAgLy8gbm8gY29vbGRvd24gdG8gY29uZmlndXJlLiBBIGNvbmZpZyBzdGlsbCBjYXJyeWluZyBpdCBnZXRzIG9uZVxuICAvLyB1bmtub3duLWtleSB3YXJuaW5nIGFuZCBpcyBvdGhlcndpc2UgaWdub3JlZCwgbm90IHJlZnVzZWQuXG4gIFwic3RhbGVfZmFpbGVkX2RpYWdub3N0aWNfZGF5c1wiLFxuICBcInN0YWxlX3BsYW5uaW5nX3dhcm5pbmdfZGF5c1wiLFxuXG4gIC8vIFBlci1yZXBvc2l0b3J5IGZhc3QtZmFpbHVyZSBiYWNrLW9mZiAoSXNzdWUgIzE5NTApXG4gIFwiZmFzdF9mYWlsdXJlX3NlY29uZHNcIixcbiAgXCJyZXBvX2Zhc3RfZmFpbHVyZV90aHJlc2hvbGRcIixcbiAgXCJyZXBvX2Zhc3RfZmFpbHVyZV93aW5kb3dfaG91cnNcIixcblxuICAvLyBSZWNlbnQgYWN0aXZpdHkgc2V0dGluZ3MgKElzc3VlICMxMzI2KVxuICBcImluY2x1ZGVfcmVjZW50X2FjdGl2aXR5XCIsXG4gIFwicmVjZW50X2FjdGl2aXR5X21lcmdlZF9wcl9saW1pdFwiLFxuICBcInJlY2VudF9hY3Rpdml0eV9jb21taXRfbGltaXRcIixcbiAgXCJyZWNlbnRfYWN0aXZpdHlfbWF4X3Rva2Vuc1wiLFxuICBcInJlY2VudF9hY3Rpdml0eV9jYWNoZV90dGxfc2Vjb25kc1wiLFxuXG4gIC8vIENvZGViYXNlIG1hcCAoSXNzdWUgIzQyODEpXG4gIFwiaW5jbHVkZV9jb2RlYmFzZV9tYXBcIixcbiAgXCJ0aW1lbGluZV9jYWNoZV90dGxfc2Vjb25kc1wiLFxuXG4gIC8vIENvZGVHcmFwaCByZXBvIGNvbnRleHQgKElzc3VlICMyMTU0LCBwYXJ0IG9mICMyMTQ1KVxuICBcImNvZGVncmFwaF9jb250ZXh0XCIsXG5cbiAgLy8gUlRLIG91dHB1dCAoSXNzdWUgIzIzODAsIHBhcnQgb2YgIzIzMjgpXG4gIFwicnRrX291dHB1dFwiLFxuXG4gIC8vIFZlcmJvc2l0eSBzZXR0aW5ncyAoSXNzdWUgIzEzMzApXG4gIFwidmVyYm9zaXR5XCIsXG5cbiAgLy8gU2Vzc2lvbiByZXN1bWUgKElzc3VlICMxMzI0KVxuICBcImVuYWJsZV9zZXNzaW9uX3Jlc3VtZVwiLFxuXG4gIC8vIFRydXN0LWF3YXJlIGNvbW1lbnQgZmlsdGVyaW5nIChJc3N1ZSAjMTM0MClcbiAgXCJpbmNsdWRlX3VudHJ1c3RlZF9jb21tZW50c1wiLFxuXG4gIC8vIFNvZnR3YXJlIHVwZGF0ZSBzZWxmLWhlYWwgKElzc3VlICMxNDk2KVxuICBcInVwZGF0ZV9yZXRyeV9tYXhfYXR0ZW1wdHNcIixcbiAgXCJ1cGRhdGVfcmV0cnlfYmFja29mZl9zZWNvbmRzXCIsXG5cbiAgLy8gQmFzZWxpbmUtYXdhcmUgcXVhbGl0eSBnYXRlIChJc3N1ZSAjMTU0OSlcbiAgXCJiYXNlbGluZV9hd2FyZV9xdWFsaXR5X2dhdGVcIixcblxuICAvLyBJbi1wcm9jZXNzIGluZnJhc3RydWN0dXJlIHJldHJ5IChJc3N1ZSAjMTU1MClcbiAgXCJpbmZyYV9yZXRyeV9iYWNrb2ZmX21zXCIsXG5cbiAgLy8gQXV0by1maXggYXR0ZW1wdCBjYXAgcGVyIGZhaWx1cmUgc2lnbmF0dXJlIChJc3N1ZSAjMzU4MilcbiAgXCJtYXhfYXV0b19maXhfYXR0ZW1wdHNcIixcblxuICAvLyBTdGFsbCB0aHJlc2hvbGQgZm9yIFBScyBibG9ja2luZyB3b3JrLW9uIGlzc3VlcyAoSXNzdWUgIzQwMjUpXG4gIFwiYmxvY2tpbmdfcHJfc3RhbGxfdGhyZXNob2xkX3NlY29uZHNcIixcblxuICAvLyBGbGVldCBQUiBjYXAgb24gdGhlIGRlZmF1bHQtYnJhbmNoIHN0cmVhbSDigJQgb25lIGZsZWV0IFBSIHBlciBzbG90IChJc3N1ZSAjMjY2MylcbiAgXCJmbGVldF9wcl9zbG90c1wiLFxuXG4gIC8vIElkbGUtdGFzayB0ZW1wbGF0ZSBkcmF3IHdlaWdodHMgKElzc3VlICMyNDAxKVxuICBcImlkbGVfdGFza190ZW1wbGF0ZV93ZWlnaHRzXCIsXG5cbiAgLy8gSWRsZS10YXNrIGNhZGVuY2UgZmxvb3IgZm9yIHRoZSBpbXBvcnRhbnQgdGVtcGxhdGVzIChJc3N1ZSAjNDAxMSlcbiAgXCJpZGxlX3Rhc2tfY2FkZW5jZVwiLFxuXG4gIC8vIFNvZnR3YXJlIGF1dG8tdXBkYXRlIG1pbmltdW0gdmVyc2lvbiBmbG9vcnMgKElzc3VlICMyNjIyKVxuICBcInNvZnR3YXJlX21pbl92ZXJzaW9uc1wiLFxuXG4gIC8vIERlcGxveWVyLXN1cHBsaWVkIGNvbnRhaW5lciBidWlsZC10aW1lIHRvb2xzIChJc3N1ZSAjNjksIHBhcmVudCAjNSlcbiAgXCJjb250YWluZXJfdG9vbHNcIixcblxuICAvLyBUaGlzIGRlcGxveW1lbnQncyBwcml2YXRlIGVudmlyb25tZW50IGV4dGVuc2lvbiAoSXNzdWUgIzk3OCwgcGFyZW50ICM5MzMpXG4gIFwiY29udGFpbmVyX2V4dGVuc2lvblwiLFxuXG4gIC8vIFBvc3QtcnVuIGNhbGxiYWNrIGhvb2tzIChJc3N1ZSAjODA2LCBwYXJlbnQgIzc5NilcbiAgXCJjYWxsYmFja3NcIixcblxuICAvLyBHcmFmdCByZXBvLWNvbnRleHQgaW5qZWN0aW9uIChJc3N1ZSAjMjA5OCwgcGFydCBvZiAjMjA2MClcbiAgXCJncmFmdF9jb250ZXh0XCIsXG5cbiAgLy8gQ3VzdG9tIGxhYmVsIOKGkiBub24tcHVibGljIHByb21wdCBmaWxlIG1hcHBpbmdzIChJc3N1ZSAjODQ2LCBwYXJ0IG9mICM4NDMpXG4gIFwiY3VzdG9tX2xhYmVsX3Byb21wdHNcIixcblxuICAvLyBIb3N0IGJ1aWxkLWNhY2hlIHJlY2xhaW0gYmVmb3JlIGEgd29yay12b2x1bWUgcmVjcmVhdGUgKElzc3VlICM0NDk4KS5cbiAgLy8gTGl0ZXJhbHMsIG5vdCB0aGUgSE9TVF9DQUNIRV9SRUNMQUlNXypfS0VZIGNvbnN0YW50czogaG9zdF9jYWNoZV9yZWNsYWltLnRzXG4gIC8vIHJlYWNoZXMgY29uZmlnLnRzIHRocm91Z2ggaXRzIGltcG9ydHMsIHNvIGltcG9ydGluZyBpdCBoZXJlIHdvdWxkIHJlYWRcbiAgLy8gdGhlbSBiZWZvcmUgdGhhdCBtb2R1bGUgZmluaXNoZWQgaW5pdGlhbGlzaW5nLiBBIHRlc3QgYnVpbGRzIGEgcmVjb3JkXG4gIC8vIGZyb20gdGhlIGNvbnN0YW50cyBhbmQgYXNzZXJ0cyBub25lIGlzIHJlcG9ydGVkIHVua25vd24uXG4gIFwiaG9zdF9jYWNoZV9yZWNsYWltX2VuYWJsZWRcIixcbiAgXCJob3N0X2NhY2hlX3JlY2xhaW1fbWluX2FnZV9ob3Vyc1wiLFxuICBcImhvc3RfY2FjaGVfcmVjbGFpbV9oZWFkcm9vbV9nYlwiLFxuICBcImhvc3RfY2FjaGVfcmVjbGFpbV9yb290c1wiLFxuXSk7XG5cbi8qKlxuICogUmVjb2duaXNlZCBrZXlzICoqaW5zaWRlKiogYSB0b3AtbGV2ZWwgYmxvY2sgdGhhdCB0YWtlcyBhbiBvYmplY3QgdmFsdWUsXG4gKiBrZXllZCBieSB0aGUgYmxvY2sncyBvd24gbmFtZSAoSXNzdWUgIzIxNTQpLlxuICpcbiAqIE9ubHkgYmxvY2tzIHdob3NlIHZvY2FidWxhcnkgaXMgc21hbGwgYW5kIGZpeGVkIGJlbG9uZyBoZXJlOiBhIHR5cG8gaW5zaWRlXG4gKiBvbmUgaXMgYXMgaW52aXNpYmxlIGFzIGEgdHlwbyBhdCB0aGUgdG9wIGxldmVsLCBzbyBpdCBlYXJucyB0aGUgc2FtZSB3YXJuaW5nLlxuICogRnJlZS1mb3JtIG1hcHMgKGByZXBvX2NvbmZpZ2AsIGBwaGFzZV9tb2RlbF9vdmVycmlkZXNgLCDigKYpIGFyZSBkZWxpYmVyYXRlbHlcbiAqIGFic2VudCDigJQgdGhlaXIga2V5cyBhcmUgb3BlcmF0b3ItY2hvc2VuLCBzbyBub3RoaW5nIGNvdWxkIGJlIGNoZWNrZWQuXG4gKi9cbi8vXG4vLyBCdWlsdCBvbiBkZW1hbmQgcmF0aGVyIHRoYW4gYXQgbW9kdWxlIGxvYWQ6IGBjb2RlZ3JhcGhfY29udGV4dF9jb25maWcudHNgXG4vLyBpbXBvcnRzIHRoZSBkZWZhdWx0cywgdGhlIGRlZmF1bHRzIGltcG9ydCB0aGUgR3JhZnQgY29uZmlnLCBhbmQgdGhlIEdyYWZ0XG4vLyBjb25maWcgaW1wb3J0cyB0aGlzIG1vZHVsZSAoSXNzdWUgIzIwOTgpIOKAlCBhIGxvYWQtdGltZSB0YWJsZSBoZXJlIHdvdWxkXG4vLyByZWFkIGBDT0RFR1JBUEhfQ09OVEVYVF9LRVlTYCBiZWZvcmUgaXRzIG1vZHVsZSBmaW5pc2hlZCBpbml0aWFsaXNpbmcuXG5leHBvcnQgZnVuY3Rpb24ga25vd25OZXN0ZWRDb25maWdLZXlzKCk6IFJlYWRvbmx5TWFwPFxuICBzdHJpbmcsXG4gIFJlYWRvbmx5U2V0PHN0cmluZz5cbj4ge1xuICByZXR1cm4gbmV3IE1hcChbXG4gICAgW1wiY29kZWdyYXBoX2NvbnRleHRcIiwgQ09ERUdSQVBIX0NPTlRFWFRfS0VZU10sXG4gICAgW1wicnRrX291dHB1dFwiLCBSVEtfT1VUUFVUX0tFWVNdLFxuICBdKTtcbn1cblxuLyoqXG4gKiBDb252ZXJ0IGEgY2FtZWxDYXNlIHN0cmluZyB0byBzbmFrZV9jYXNlLlxuICpcbiAqIEBwYXJhbSBjYW1lbCAtIFRoZSBjYW1lbENhc2Ugc3RyaW5nXG4gKiBAcmV0dXJucyBUaGUgc25ha2VfY2FzZSBlcXVpdmFsZW50XG4gKi9cbmZ1bmN0aW9uIGNhbWVsVG9TbmFrZShjYW1lbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNhbWVsXG4gICAgLnJlcGxhY2UoLyhbQS1aXSkvZywgXCJfJDFcIilcbiAgICAudG9Mb3dlckNhc2UoKVxuICAgIC5yZXBsYWNlKC9eXy8sIFwiXCIpO1xufVxuXG4vKipcbiAqIENvbXB1dGUgdGhlIExldmVuc2h0ZWluIGVkaXQgZGlzdGFuY2UgYmV0d2VlbiB0d28gc3RyaW5ncy5cbiAqXG4gKiBVc2VkIHRvIGZpbmQgY2xvc2UgbWF0Y2hlcyBmb3IgdHlwb3MgaW4gY29uZmlnIGtleXMuXG4gKi9cbmZ1bmN0aW9uIGxldmVuc2h0ZWluRGlzdGFuY2UoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCBtID0gYS5sZW5ndGg7XG4gIGNvbnN0IG4gPSBiLmxlbmd0aDtcblxuICAvLyBVc2UgYSB0d28tcm93IG9wdGltaXNhdGlvbiBmb3Igc3BhY2UgZWZmaWNpZW5jeVxuICBsZXQgcHJldmlvdXNSb3c6IG51bWJlcltdID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogbiArIDEgfSwgKF8sIGkpID0+IGkpO1xuXG4gIGZvciAobGV0IGkgPSAxOyBpIDw9IG07IGkrKykge1xuICAgIGNvbnN0IGN1cnJlbnRSb3c6IG51bWJlcltdID0gW2ldO1xuICAgIGZvciAobGV0IGogPSAxOyBqIDw9IG47IGorKykge1xuICAgICAgY29uc3QgY29zdCA9IGFbaSAtIDFdID09PSBiW2ogLSAxXSA/IDAgOiAxO1xuICAgICAgY3VycmVudFJvd1tqXSA9IE1hdGgubWluKFxuICAgICAgICAocHJldmlvdXNSb3dbal0gPz8gMCkgKyAxLCAvLyBkZWxldGlvblxuICAgICAgICAoY3VycmVudFJvd1tqIC0gMV0gPz8gMCkgKyAxLCAvLyBpbnNlcnRpb25cbiAgICAgICAgKHByZXZpb3VzUm93W2ogLSAxXSA/PyAwKSArIGNvc3QsIC8vIHN1YnN0aXR1dGlvblxuICAgICAgKTtcbiAgICB9XG4gICAgcHJldmlvdXNSb3cgPSBjdXJyZW50Um93O1xuICB9XG5cbiAgcmV0dXJuIHByZXZpb3VzUm93W25dID8/IG07XG59XG5cbi8qKlxuICogU3VnZ2VzdCB0aGUgbW9zdCBsaWtlbHkgaW50ZW5kZWQga2V5IGZvciBhbiB1bnJlY29nbmlzZWQga2V5IG5hbWUuXG4gKlxuICogQ2hlY2tzIHR3byBzdHJhdGVnaWVzOlxuICogMS4gY2FtZWxDYXNlIOKGkiBzbmFrZV9jYXNlIGNvbnZlcnNpb24gKG1vc3QgY29tbW9uIG1pc3Rha2UpXG4gKiAyLiBMZXZlbnNodGVpbiBkaXN0YW5jZSBmb3IgY2xvc2UgdHlwbyBtYXRjaGVzXG4gKlxuICogQHBhcmFtIHVua25vd25LZXkgLSBUaGUgdW5yZWNvZ25pc2VkIGtleSBmcm9tIC5jb25maWcuanNvblxuICogQHJldHVybnMgVGhlIHN1Z2dlc3RlZCBjb3JyZWN0IGtleSwgb3IgbnVsbCBpZiBubyBjbG9zZSBtYXRjaCBmb3VuZFxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VnZ2VzdFNpbWlsYXJLZXkodW5rbm93bktleTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBzdWdnZXN0S2V5RnJvbSh1bmtub3duS2V5LCBLTk9XTl9DT05GSUdfS0VZUyk7XG59XG5cbi8qKlxuICogU3VnZ2VzdCB0aGUgbW9zdCBsaWtlbHkgaW50ZW5kZWQga2V5IGZyb20gYW4gYXJiaXRyYXJ5IHJlY29nbmlzZWQgc2V0LlxuICpcbiAqIFRoZSBzdHJhdGVnaWVzIGFyZSB7QGxpbmsgc3VnZ2VzdFNpbWlsYXJLZXl9J3MsIGxpZnRlZCBzbyBhIG5lc3RlZCBibG9ja1xuICogKGBncmFmdF9jb250ZXh0YCwgSXNzdWUgIzIwOTgpIGdldHMgdGhlIHNhbWUgaGVscCBhZ2FpbnN0IGl0cyBvd24ga2V5IHNldFxuICogcmF0aGVyIHRoYW4gYWdhaW5zdCB0aGUgdG9wLWxldmVsIG9uZS5cbiAqXG4gKiBAcGFyYW0gdW5rbm93bktleSAtIFRoZSB1bnJlY29nbmlzZWQga2V5XG4gKiBAcGFyYW0ga25vd25LZXlzIC0gVGhlIGtleXMgcmVjb2duaXNlZCBhdCB0aGF0IGxldmVsXG4gKiBAcmV0dXJucyBUaGUgc3VnZ2VzdGVkIGNvcnJlY3Qga2V5LCBvciBudWxsIGlmIG5vIGNsb3NlIG1hdGNoIGZvdW5kXG4gKi9cbmZ1bmN0aW9uIHN1Z2dlc3RLZXlGcm9tKFxuICB1bmtub3duS2V5OiBzdHJpbmcsXG4gIGtub3duS2V5czogUmVhZG9ubHlTZXQ8c3RyaW5nPixcbik6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gc3VnZ2VzdEZyb20odW5rbm93bktleSwga25vd25LZXlzKTtcbn1cblxuLyoqXG4gKiBTdWdnZXN0IHRoZSBtb3N0IGxpa2VseSBpbnRlbmRlZCBrZXkgZnJvbSBhIGdpdmVuIGNhbmRpZGF0ZSBzZXQuXG4gKlxuICogVGhlIHR3byBzdHJhdGVnaWVzIHtAbGluayBzdWdnZXN0U2ltaWxhcktleX0gZG9jdW1lbnRzLCBhcHBsaWVkIHRvIHdoaWNoZXZlclxuICogdm9jYWJ1bGFyeSBpcyBpbiBwbGF5IOKAlCB0aGUgdG9wLWxldmVsIGtleXMsIG9yIHRoZSBrZXlzIG9mIG9uZSBuZXN0ZWQgYmxvY2suXG4gKlxuICogQHBhcmFtIHVua25vd25LZXkgLSBUaGUgdW5yZWNvZ25pc2VkIGtleS5cbiAqIEBwYXJhbSBjYW5kaWRhdGVzIC0gVGhlIGtleXMgdGhhdCB3b3VsZCBoYXZlIGJlZW4gcmVjb2duaXNlZC5cbiAqIEByZXR1cm5zIFRoZSBzdWdnZXN0ZWQga2V5LCBvciBudWxsIGlmIG5vIGNsb3NlIG1hdGNoIGZvdW5kLlxuICovXG5mdW5jdGlvbiBzdWdnZXN0RnJvbShcbiAgdW5rbm93bktleTogc3RyaW5nLFxuICBjYW5kaWRhdGVzOiBSZWFkb25seVNldDxzdHJpbmc+LFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIC8vIFN0cmF0ZWd5IDE6IFRyeSBjYW1lbENhc2Ug4oaSIHNuYWtlX2Nhc2UgY29udmVyc2lvblxuICBjb25zdCBzbmFrZVZlcnNpb24gPSBjYW1lbFRvU25ha2UodW5rbm93bktleSk7XG4gIGlmIChjYW5kaWRhdGVzLmhhcyhzbmFrZVZlcnNpb24pKSB7XG4gICAgcmV0dXJuIHNuYWtlVmVyc2lvbjtcbiAgfVxuXG4gIC8vIFN0cmF0ZWd5IDI6IEZpbmQgdGhlIGNsb3Nlc3QgbWF0Y2ggYnkgZWRpdCBkaXN0YW5jZVxuICAvLyBBbGxvdyB1cCB0byAzIGVkaXRzIGZvciBsb25nZXIga2V5cywgMiBmb3Igc2hvcnRlciBvbmVzXG4gIGNvbnN0IG1heERpc3RhbmNlID0gdW5rbm93bktleS5sZW5ndGggPD0gOCA/IDIgOiAzO1xuICBsZXQgYmVzdE1hdGNoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgbGV0IGJlc3REaXN0YW5jZSA9IG1heERpc3RhbmNlICsgMTtcblxuICBmb3IgKGNvbnN0IGtub3duS2V5IG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBjb25zdCBkaXN0YW5jZSA9IGxldmVuc2h0ZWluRGlzdGFuY2UodW5rbm93bktleSwga25vd25LZXkpO1xuICAgIGlmIChkaXN0YW5jZSA8IGJlc3REaXN0YW5jZSkge1xuICAgICAgYmVzdERpc3RhbmNlID0gZGlzdGFuY2U7XG4gICAgICBiZXN0TWF0Y2ggPSBrbm93bktleTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gYmVzdE1hdGNoO1xufVxuXG4vKipcbiAqIERldGVjdCB1bmtub3duIGtleXMgaW4gYSBwYXJzZWQgLmNvbmZpZy5qc29uIG9iamVjdC5cbiAqXG4gKiBSZXR1cm5zIGEgbGlzdCBvZiB3YXJuaW5ncyBmb3IgYW55IGtleXMgbm90IGluIEtOT1dOX0NPTkZJR19LRVlTLFxuICogZWFjaCB3aXRoIGEgc3VnZ2VzdGlvbiBmb3IgdGhlIGxpa2VseSBpbnRlbmRlZCBrZXkgd2hlbiBwb3NzaWJsZS5cbiAqXG4gKiBAcGFyYW0gZGF0YSAtIFRoZSBwYXJzZWQgY29uZmlnIG9iamVjdCAodG9wLWxldmVsIGtleXMgb25seSlcbiAqIEByZXR1cm5zIEFycmF5IG9mIHdhcm5pbmdzIGZvciB1bmtub3duIGtleXNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdFVua25vd25Db25maWdLZXlzKFxuICBkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbik6IFVua25vd25LZXlXYXJuaW5nW10ge1xuICBjb25zdCB3YXJuaW5nczogVW5rbm93bktleVdhcm5pbmdbXSA9IFtdO1xuXG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGRhdGEpKSB7XG4gICAgaWYgKCFLTk9XTl9DT05GSUdfS0VZUy5oYXMoa2V5KSkge1xuICAgICAgd2FybmluZ3MucHVzaCh1bmtub3duS2V5V2FybmluZyhrZXksIEtOT1dOX0NPTkZJR19LRVlTKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBJc3N1ZSAjMjE1NDogYSBibG9jayB3aXRoIGl0cyBvd24gdm9jYWJ1bGFyeSBnZXRzIHRoZSBzYW1lIHRyZWF0bWVudCBvbmVcbiAgICAvLyBsZXZlbCBkb3duIOKAlCBhIHR5cG8gaW5zaWRlIGl0IHdvdWxkIG90aGVyd2lzZSByZWFkIGFzIGEgc2V0dGluZyB0aGVcbiAgICAvLyBvcGVyYXRvciBtYWRlIGFuZCB0aGUgd29ya2VyIG5ldmVyIHNhdy5cbiAgICBjb25zdCBuZXN0ZWRLZXlzID0ga25vd25OZXN0ZWRDb25maWdLZXlzKCkuZ2V0KGtleSk7XG4gICAgaWYgKCFuZXN0ZWRLZXlzKSBjb250aW51ZTtcbiAgICBjb25zdCBibG9jayA9IGRhdGFba2V5XTtcbiAgICBpZiAodHlwZW9mIGJsb2NrICE9PSBcIm9iamVjdFwiIHx8IGJsb2NrID09PSBudWxsIHx8IEFycmF5LmlzQXJyYXkoYmxvY2spKSB7XG4gICAgICAvLyBBIG1hbGZvcm1lZCBibG9jayBpcyB0aGUgYmxvY2sgcGFyc2VyJ3MgdG8gcmVmdXNlLCBub3Qgb3VycyB0byBndWVzcyBhdC5cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IG5lc3RlZCBvZiBPYmplY3Qua2V5cyhibG9jaykpIHtcbiAgICAgIGlmIChuZXN0ZWRLZXlzLmhhcyhuZXN0ZWQpKSBjb250aW51ZTtcbiAgICAgIHdhcm5pbmdzLnB1c2godW5rbm93bktleVdhcm5pbmcobmVzdGVkLCBuZXN0ZWRLZXlzLCBrZXkpKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gd2FybmluZ3M7XG59XG5cbi8qKlxuICogRGV0ZWN0IHVua25vd24ga2V5cyBpbnNpZGUgYSBuZXN0ZWQgYC5jb25maWcuanNvbmAgYmxvY2suXG4gKlxuICogVGhlIHNhbWUgd2Fybi1hbmQtaWdub3JlIHRyZWF0bWVudCB7QGxpbmsgZGV0ZWN0VW5rbm93bkNvbmZpZ0tleXN9IGdpdmVzIHRoZVxuICogdG9wIGxldmVsLCBvbmUgbGV2ZWwgZG93bjogdGhlIHJlcG9ydGVkIGZpZWxkIGlzIGRvdHRlZFxuICogKGBncmFmdF9jb250ZXh0LmVuYWJsZWRkYCkgYW5kIHRoZSBzdWdnZXN0aW9uIGlzIGRyYXduIGZyb20gdGhlIGJsb2NrJ3Mgb3duXG4gKiByZWNvZ25pc2VkIGtleXMuXG4gKlxuICogQHBhcmFtIGJsb2NrIC0gVGhlIHBhcnNlZCBuZXN0ZWQgYmxvY2tcbiAqIEBwYXJhbSBibG9ja05hbWUgLSBUaGUgYmxvY2sncyBrZXkgaW4gYC5jb25maWcuanNvbmAsIGUuZy4gYGdyYWZ0X2NvbnRleHRgXG4gKiBAcGFyYW0ga25vd25LZXlzIC0gS2V5cyByZWNvZ25pc2VkIGluc2lkZSB0aGF0IGJsb2NrXG4gKiBAcmV0dXJucyBBcnJheSBvZiB3YXJuaW5ncyBmb3IgdW5rbm93biBuZXN0ZWQga2V5c1xuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0VW5rbm93bk5lc3RlZEtleXMoXG4gIGJsb2NrOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgYmxvY2tOYW1lOiBzdHJpbmcsXG4gIGtub3duS2V5czogUmVhZG9ubHlTZXQ8c3RyaW5nPixcbik6IFVua25vd25LZXlXYXJuaW5nW10ge1xuICBjb25zdCB3YXJuaW5nczogVW5rbm93bktleVdhcm5pbmdbXSA9IFtdO1xuXG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGJsb2NrKSkge1xuICAgIGlmIChrbm93bktleXMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IG1hdGNoID0gc3VnZ2VzdEtleUZyb20oa2V5LCBrbm93bktleXMpO1xuICAgIGNvbnN0IHN1Z2dlc3Rpb24gPSBtYXRjaCA9PT0gbnVsbCA/IG51bGwgOiBgJHtibG9ja05hbWV9LiR7bWF0Y2h9YDtcbiAgICBjb25zdCBmaWVsZCA9IGAke2Jsb2NrTmFtZX0uJHtrZXl9YDtcbiAgICBjb25zdCBtZXNzYWdlID0gc3VnZ2VzdGlvblxuICAgICAgPyBgVW5rbm93biBjb25maWcga2V5IFwiJHtmaWVsZH1cIiBpbiAuY29uZmlnLmpzb24uIERpZCB5b3UgbWVhbiBcIiR7c3VnZ2VzdGlvbn1cIj9gXG4gICAgICA6IGBVbmtub3duIGNvbmZpZyBrZXkgXCIke2ZpZWxkfVwiIGluIC5jb25maWcuanNvbi4gVGhpcyBhdHRyaWJ1dGUgaXMgbm90IHJlY29nbmlzZWQgYW5kIHdpbGwgYmUgaWdub3JlZC5gO1xuXG4gICAgd2FybmluZ3MucHVzaCh7IGZpZWxkLCBtZXNzYWdlLCBzdWdnZXN0aW9uIH0pO1xuICB9XG5cbiAgcmV0dXJuIHdhcm5pbmdzO1xufVxuXG4vKipcbiAqIEJ1aWxkIG9uZSB3YXJuaW5nIGZvciBhbiB1bnJlY29nbmlzZWQga2V5LlxuICpcbiAqIEBwYXJhbSBrZXkgLSBUaGUgdW5yZWNvZ25pc2VkIGtleSwgYXMgd3JpdHRlbiBpbiB0aGUgZmlsZS5cbiAqIEBwYXJhbSBjYW5kaWRhdGVzIC0gVGhlIGtleXMgdGhhdCB3b3VsZCBoYXZlIGJlZW4gcmVjb2duaXNlZCBpbiBpdHMgcG9zaXRpb24uXG4gKiBAcGFyYW0gYmxvY2tQcmVmaXggLSBUaGUgZW5jbG9zaW5nIGJsb2NrLCBmb3IgYSBuZXN0ZWQga2V5LlxuICogQHJldHVybnMgVGhlIHdhcm5pbmcsIHdpdGggYSBzdWdnZXN0aW9uIHdoZW4gYSBjbG9zZSBtYXRjaCBleGlzdHMuXG4gKi9cbmZ1bmN0aW9uIHVua25vd25LZXlXYXJuaW5nKFxuICBrZXk6IHN0cmluZyxcbiAgY2FuZGlkYXRlczogUmVhZG9ubHlTZXQ8c3RyaW5nPixcbiAgYmxvY2tQcmVmaXg/OiBzdHJpbmcsXG4pOiBVbmtub3duS2V5V2FybmluZyB7XG4gIGNvbnN0IHF1YWxpZnkgPSAobmFtZTogc3RyaW5nKSA9PlxuICAgIGJsb2NrUHJlZml4ID8gYCR7YmxvY2tQcmVmaXh9LiR7bmFtZX1gIDogbmFtZTtcbiAgY29uc3Qgc3VnZ2VzdGlvbiA9IHN1Z2dlc3RGcm9tKGtleSwgY2FuZGlkYXRlcyk7XG4gIGNvbnN0IGZpZWxkID0gcXVhbGlmeShrZXkpO1xuICBjb25zdCBtZXNzYWdlID0gc3VnZ2VzdGlvblxuICAgID8gYFVua25vd24gY29uZmlnIGtleSBcIiR7ZmllbGR9XCIgaW4gLmNvbmZpZy5qc29uLiBEaWQgeW91IG1lYW4gXCIke1xuICAgICAgcXVhbGlmeShzdWdnZXN0aW9uKVxuICAgIH1cIj9gXG4gICAgOiBgVW5rbm93biBjb25maWcga2V5IFwiJHtmaWVsZH1cIiBpbiAuY29uZmlnLmpzb24uIFRoaXMgYXR0cmlidXRlIGlzIG5vdCByZWNvZ25pc2VkIGFuZCB3aWxsIGJlIGlnbm9yZWQuYDtcblxuICByZXR1cm4ge1xuICAgIGZpZWxkLFxuICAgIG1lc3NhZ2UsXG4gICAgc3VnZ2VzdGlvbjogc3VnZ2VzdGlvbiA/IHF1YWxpZnkoc3VnZ2VzdGlvbikgOiBudWxsLFxuICB9O1xufVxuXG4vKipcbiAqIEZvcm1hdCB1bmtub3duIGtleSB3YXJuaW5ncyBhcyBhIGh1bWFuLXJlYWRhYmxlIHN0cmluZyBmb3IgbG9nZ2luZy5cbiAqXG4gKiBAcGFyYW0gd2FybmluZ3MgLSBBcnJheSBvZiB1bmtub3duIGtleSB3YXJuaW5nc1xuICogQHJldHVybnMgRm9ybWF0dGVkIHdhcm5pbmcgc3RyaW5nLCBvciBlbXB0eSBzdHJpbmcgaWYgbm8gd2FybmluZ3NcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFVua25vd25LZXlXYXJuaW5ncyhcbiAgd2FybmluZ3M6IFVua25vd25LZXlXYXJuaW5nW10sXG4pOiBzdHJpbmcge1xuICBpZiAod2FybmluZ3MubGVuZ3RoID09PSAwKSByZXR1cm4gXCJcIjtcblxuICBjb25zdCBsaW5lcyA9IFtcbiAgICBg4pqg77iPICAuY29uZmlnLmpzb24gdmFsaWRhdGlvbjogJHt3YXJuaW5ncy5sZW5ndGh9IHVua25vd24gYXR0cmlidXRlJHtcbiAgICAgIHdhcm5pbmdzLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIlxuICAgIH0gZm91bmQ6YCxcbiAgXTtcblxuICBmb3IgKGNvbnN0IHdhcm5pbmcgb2Ygd2FybmluZ3MpIHtcbiAgICBpZiAod2FybmluZy5zdWdnZXN0aW9uKSB7XG4gICAgICBsaW5lcy5wdXNoKFxuICAgICAgICBgICAtIFwiJHt3YXJuaW5nLmZpZWxkfVwiIOKGkiBkaWQgeW91IG1lYW4gXCIke3dhcm5pbmcuc3VnZ2VzdGlvbn1cIj9gLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGluZXMucHVzaChgICAtIFwiJHt3YXJuaW5nLmZpZWxkfVwiIGlzIG5vdCBhIHJlY29nbmlzZWQgY29uZmlnIGtleWApO1xuICAgIH1cbiAgfVxuXG4gIGxpbmVzLnB1c2goXG4gICAgXCIgIFNlZSBkb2NzL0NPTkZJR1VSQVRJT04ubWQgZm9yIHRoZSBmdWxsIGxpc3Qgb2YgdmFsaWQgYXR0cmlidXRlcy5cIixcbiAgKTtcblxuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7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
// denoCacheMetadata=13891976741636723973,2091554006279960735