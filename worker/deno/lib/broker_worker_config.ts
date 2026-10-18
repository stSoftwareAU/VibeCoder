/**
 * Explicit projection for the future brokered worker launch (#3699).
 *
 * The trusted caller stages only workerConfig. hostOnlyConfig must stay outside
 * every worker mount, including the original checkout configuration. Separating
 * a hook or extension is not permission to ignore it: its host-side execution or
 * an explicit unsupported-configuration refusal remains the launcher's job.
 * This helper changes no active launcher and reads no environment or filesystem.
 */
export interface BrokerWorkerConfigProjection {
  /** The only object that may be serialised into the worker's config mount. */
  workerConfig: Record<string, unknown>;
  /** Private inputs requiring separate trusted-side handling; never stage here. */
  hostOnlyConfig: Record<string, unknown>;
}

type Shape =
  | "string"
  | "boolean"
  | "number"
  | "strings"
  | "numbers"
  | "stringMap"
  | "numberMap";

// Deliberately explicit: adding a key to ordinary config does not grant it
// access across this credential boundary. Values must also fit their shape.
const WORKER_FIELDS: Readonly<Record<string, Shape>> = {
  "allowed_authors": "strings",
  "pr_reviewers": "strings",
  "repos": "strings",
  "authorized_commenters": "strings",
  "exclusion_team": "string",
  "service_accounts": "strings",
  "trusted_review_bots": "strings",
  "fleet_pr_authors": "strings",
  "run_mode": "string",
  "update_mode": "string",
  "pinned_ref": "string",
  "agent_provider_mode": "string",
  "agent_provider": "string",
  "agent_providers": "strings",
  "agent_provider_fallback": "strings",
  "claude_week_pace_drain": "boolean",
  "claude_model": "string",
  "best_planning_model": "string",
  "phase_model_overrides": "stringMap",
  "phase_effort_overrides": "stringMap",
  "codex_phase_model_overrides": "stringMap",
  "codex_phase_effort_overrides": "stringMap",
  "gemini_phase_model_overrides": "stringMap",
  "deepseek_phase_model_overrides": "stringMap",
  "issue_executor_split": "boolean",
  "issue_sub_agent_tier": "string",
  "issue_reviewer_agents": "boolean",
  "fleet_run_archive": "string",
  "subscription_allocation_label": "string",
  "failed_once_label": "string",
  "failed_label": "string",
  "refine_issue_label": "string",
  "planning_label": "string",
  "question_label": "string",
  "needs_revision_label": "string",
  "needs_human_label": "string",
  "quorum_label": "string",
  "claude_timeout": "number",
  "claude_max_turns": "number",
  "min_claim_runway_seconds": "number",
  "claim_long_job_labels": "strings",
  "progress_extension_enabled": "boolean",
  "progress_extension_grant_seconds": "number",
  "progress_extension_stall_seconds": "number",
  "progress_extension_check_seconds": "number",
  "screenshot_retry_timeout_seconds": "number",
  "call_storm_enabled": "boolean",
  "call_storm_calls": "number",
  "call_storm_window_seconds": "number",
  "call_storm_novel_share": "number",
  "quota_poll_park_floor": "number",
  "quota_poll_park_nice": "number",
  "quota_poll_idle_floor": "number",
  "poll_cadence_low_cycles": "number",
  "poll_cadence_park_cycles": "number",
  "agent_transcript_enabled": "boolean",
  "self_schedule_diagnostics_enabled": "boolean",
  "self_schedule_diagnostics_max_in_flight": "number",
  "claude_kill_after": "number",
  "max_clarification_rounds": "number",
  "sleep_interval": "number",
  "max_concurrent_issues": "number",
  "credit_wait_interval": "number",
  "refinement_timeout": "number",
  "refinement_kill_after": "number",
  "planning_timeout": "number",
  "planning_kill_after": "number",
  "question_timeout": "number",
  "question_kill_after": "number",
  "clarification_timeout": "number",
  "clarification_kill_after": "number",
  "quorum_timeout": "number",
  "quorum_kill_after": "number",
  "quorum_planners": "strings",
  "quorum_judge": "string",
  "max_rate_limit_retries": "number",
  "max_rate_limit_wait": "number",
  "trusted_authors_cache_hours": "number",
  "retry_max_delay": "number",
  "max_issue_body_tokens": "number",
  "summarise_timeout": "number",
  "summarise_kill_after": "number",
  "feature_check_timeout": "number",
  "claude_no_output_timeout": "number",
  "quality_check_timeout": "number",
  "health_cache_ttl": "number",
  "shuffle_repos": "boolean",
  "update_gh_user_status": "boolean",
  "enable_model_fallback": "boolean",
  "sync_milestone_branches": "boolean",
  "worker_name": "string",
  "log_max_size_mb": "number",
  "log_max_rotations": "number",
  "stuck_issue_timeout": "number",
  "issue_retry_cooldown": "number",
  "min_disk_space_mb": "number",
  "host_disk_low_floor_gb": "number",
  "host_disk_low_floor_percent": "number",
  "stale_failed_diagnostic_days": "number",
  "stale_planning_warning_days": "number",
  "fast_failure_seconds": "number",
  "repo_fast_failure_threshold": "number",
  "repo_fast_failure_window_hours": "number",
  "include_recent_activity": "boolean",
  "recent_activity_merged_pr_limit": "number",
  "recent_activity_commit_limit": "number",
  "recent_activity_max_tokens": "number",
  "recent_activity_cache_ttl_seconds": "number",
  "include_codebase_map": "boolean",
  "timeline_cache_ttl_seconds": "number",
  "verbosity": "string",
  "enable_session_resume": "boolean",
  "include_untrusted_comments": "boolean",
  "update_retry_max_attempts": "number",
  "update_retry_backoff_seconds": "numbers",
  "baseline_aware_quality_gate": "boolean",
  "infra_retry_backoff_ms": "number",
  "max_auto_fix_attempts": "number",
  "blocking_pr_stall_threshold_seconds": "number",
  "fleet_pr_slots": "number",
  "idle_task_template_weights": "numberMap",
  "software_min_versions": "stringMap",
  "codeowners_owners": "strings",
};
const HOST_FIELDS = new Set([
  "author_source",
  "callbacks",
  "codegraph_context",
  "container_extension",
  "container_tools",
  "copilot_code_review",
  "custom_label_prompts",
  "gh_config_dir",
  "github_app_id",
  "github_app_installation_id",
  "github_app_private_key_path",
  "graft_context",
  "idle_task_cadence",
  "imgbb_api_key",
  "log_dir",
  "pinned_tool_versions",
  "pr_reviewer_app",
  "pr_reviewer_auto_release",
  "rtk_output",
  "ssh_key_path",
]);
const REPO_WORKER_FIELDS: Readonly<Record<string, Shape>> = {
  "skipQualityCheck": "boolean",
  "customInstructions": "string",
  "skipAutoMerge": "boolean",
  "skipReviewerRequest": "boolean",
  "skipScreenshotCheck": "boolean",
  "skipSecurityFixCheck": "boolean",
  "skipMutationCheck": "boolean",
  "mutationCheckBudgetSeconds": "number",
  "dockerImage": "string",
  "qualityCheckTimeout": "number",
  "maxAutoFixAttempts": "number",
  "blockingPrStallThresholdSeconds": "number",
  "fleetPrSlots": "number",
  "verbosity": "string",
  "nice": "number",
  "baselineAwareQualityGate": "boolean",
  "ciFailureLabels": "strings",
  "ciFailureJobPath": "string",
  "claudeModel": "string",
  "bestPlanningModel": "string",
  "phaseModelOverrides": "stringMap",
  "issueExecutorSplit": "boolean",
  "phaseEffortOverrides": "stringMap",
  "codexModel": "string",
  "codexPhaseModelOverrides": "stringMap",
  "codexPhaseEffortOverrides": "stringMap",
  "geminiModel": "string",
  "geminiPhaseModelOverrides": "stringMap",
  "deepseekModel": "string",
  "deepseekPhaseModelOverrides": "stringMap",
  "agentProvider": "string",
};
const REPO_HOST_FIELDS = new Set([
  "preFlight",
  "ciProviders",
  "issueSubAgentTier",
  "preSetupCommand",
  "qualityCommand",
  "qualityCredentials",
]);

/** Refuse non-JSON objects without invoking accessors or exposing their values. */
function cloneJson(
  value: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): unknown {
  if (depth > 64) throw new Error("Broker config exceeds the nesting limit");
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || seen.has(value)) {
    throw new Error("Broker config must contain finite, acyclic JSON values");
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error("Broker config must contain plain JSON objects");
  }
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.getOwnPropertySymbols(value).length ||
      Object.values(descriptors).some((d) => d.get || d.set)
    ) {
      throw new Error("Broker config cannot contain executable accessors");
    }
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new Error("Broker config cannot contain sparse arrays");
      }
      return value.map((entry) => cloneJson(entry, seen, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => {
        if (
          !descriptor.enumerable ||
          ["__proto__", "constructor", "prototype"].includes(key)
        ) throw new Error("Broker config contains an unsafe object key");
        return [key, cloneJson(descriptor.value, seen, depth + 1)];
      }),
    );
  } finally {
    seen.delete(value);
  }
}

/** Require an object at schema boundaries, not arrays or null. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Broker config requires an object");
  }
  return value as Record<string, unknown>;
}

/** Structural allowlist; normal config validation still checks semantic ranges. */
function fits(value: unknown, shape: Shape): boolean {
  if (shape === "strings" || shape === "numbers") {
    return Array.isArray(value) &&
      value.every((v) =>
        typeof v === (shape === "strings" ? "string" : "number")
      );
  }
  if (shape === "stringMap" || shape === "numberMap") {
    return value !== null && typeof value === "object" &&
      !Array.isArray(value) && Object.values(value).every((v) =>
        typeof v === (shape === "stringMap" ? "string" : "number")
      );
  }
  switch (shape) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
  }
}

/** Split one already-copied config block using a closed vocabulary. */
function splitBlock(
  raw: Record<string, unknown>,
  repository = false,
): BrokerWorkerConfigProjection {
  const workerConfig: Record<string, unknown> = {};
  const hostOnlyConfig: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    const canonical = repository
      ? key === "pre-flight"
        ? "preFlight"
        : key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
      : key;
    if (seen.has(canonical)) {
      throw new Error("Broker config contains conflicting key aliases");
    }
    seen.add(canonical);
    const hostFields = repository ? REPO_HOST_FIELDS : HOST_FIELDS;
    const workerFields = repository ? REPO_WORKER_FIELDS : WORKER_FIELDS;
    if (hostFields.has(canonical)) {
      hostOnlyConfig[key] = value;
      continue;
    }
    const shape = Object.hasOwn(workerFields, canonical)
      ? workerFields[canonical]
      : undefined;
    if (!shape || !fits(value, shape)) {
      throw new Error(
        "Broker config contains an unsupported field or value shape",
      );
    }
    workerConfig[key] = value;
  }
  return { workerConfig, hostOnlyConfig };
}

/** Separate host-only configuration; no unknown key is silently passed through. */
export function projectHostConfigForBrokeredWorker(
  raw: unknown,
): BrokerWorkerConfigProjection {
  const copied = record(cloneJson(raw));
  const repositories = copied.repo_config;
  const hasRepositories = Object.hasOwn(copied, "repo_config");
  delete copied.repo_config;
  const result = splitBlock(copied);
  if (hasRepositories) {
    const worker: Record<string, unknown> = {};
    const host: Record<string, unknown> = {};
    for (const [repo, config] of Object.entries(record(repositories))) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)
      ) throw new Error("Broker config has an invalid repository scope");
      const projected = splitBlock(record(config), true);
      worker[repo] = projected.workerConfig;
      if (Object.keys(projected.hostOnlyConfig).length) {
        host[repo] = projected.hostOnlyConfig;
      }
    }
    result.workerConfig.repo_config = worker;
    if (Object.keys(host).length) result.hostOnlyConfig.repo_config = host;
  }
  return result;
}
