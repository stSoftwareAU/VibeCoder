/**
 * Runtime JSON schema validation for gh CLI responses and config files.
 *
 * Provides type guard functions that validate unknown JSON data at runtime,
 * returning typed results or explicit errors (Issue #214).
 */ import { isRunMode, REMOVED_RUN_MODES, RUN_MODE_CONFIG_KEY, RUN_MODES } from "./run_mode.ts";
import { isAbsolutePath, pathStyleFor } from "./host_path_style.ts";
import { LOG_DIR_CONFIG_KEY } from "./log_dir.ts";
import { isValidRepoSlug, renderInertRepoSlug } from "./repo_slug.ts";
import { isValidLifecycleLabel } from "./lifecycle_ledger.ts";
/**
 * GitHub org team slug in `org/slug` form (Issue #252).
 *
 * Each segment starts with an alphanumeric and may contain hyphens.
 * A bare slug, extra path segments, or whitespace is unparseable — a typo
 * that silently disabled team exclusion is the failure mode this rejects.
 */ export const EXCLUSION_TEAM_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
/**
 * Config keys this worker once honoured, mapped to the migration an operator
 * still carrying one has to make (Issue #805).
 *
 * A removed key is refused rather than ignored: a setting that reads as live
 * and does nothing is the silent failure the whole config load exists to
 * prevent. The message names the replacement so the fix is one edit, not an
 * investigation.
 */ export const REMOVED_CONFIG_KEYS = new Map([
  [
    "fleet_health_dir",
    "Built-in fleet health reporting was removed (Issue #805): report host " + "health from a `callbacks.success` (or `callbacks.always`) hook " + "instead — see docs/CONFIGURATION.md. Remove the key."
  ],
  [
    "fleet_health_repo",
    "Built-in fleet health reporting was removed (Issue #805): report host " + "health from a `callbacks.success` (or `callbacks.always`) hook " + "instead — see docs/CONFIGURATION.md. Remove the key."
  ],
  [
    "author_source",
    "The trust-source switch was removed (Issue #1066): there is now exactly " + "one source — the write/maintain/admin collaborators of each monitored " + "repo, minus the Vibe Coder logins and bots. Remove the key; nothing " + "replaces it. `./setup.sh` strips it for you."
  ]
]);
// --- Helpers ---
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(field, message) {
  return {
    ok: false,
    error: {
      field,
      message
    }
  };
}
function ok(value) {
  return {
    ok: true,
    value
  };
}
// --- String array validation ---
function validateStringArray(arr, fieldName) {
  if (!Array.isArray(arr)) {
    return fail(fieldName, `Expected array, got ${typeof arr}`);
  }
  for(let i = 0; i < arr.length; i++){
    if (typeof arr[i] !== "string") {
      return fail(`${fieldName}[${i}]`, `Expected string, got ${typeof arr[i]}`);
    }
  }
  return ok(arr);
}
// --- Optional string field validation ---
function validateOptionalString(value, fieldName) {
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== "string") {
    return fail(fieldName, `Expected string, got ${typeof value}`);
  }
  return ok(value);
}
// --- Optional string array validation ---
function validateOptionalStringArray(value, fieldName) {
  if (value === undefined) {
    return ok(undefined);
  }
  return validateStringArray(value, fieldName);
}
// --- Optional boolean field validation (Issue #435) ---
function validateOptionalBoolean(value, fieldName) {
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== "boolean") {
    return fail(fieldName, `Expected boolean, got ${typeof value}`);
  }
  return ok(value);
}
// --- Optional number field validation (Issue #277) ---
function validateOptionalNumber(value, fieldName) {
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== "number") {
    return fail(fieldName, `Expected number, got ${typeof value}`);
  }
  return ok(value);
}
// --- GhIssueJson validation ---
/**
 * Validate unknown data as a GhIssueJson structure.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns Validated GhIssueJson or a ValidationError
 */ export function validateGhIssueJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  // number
  if (typeof data.number !== "number") {
    return fail("number", `Expected number, got ${typeof data.number}`);
  }
  // title
  if (typeof data.title !== "string") {
    return fail("title", `Expected string, got ${typeof data.title}`);
  }
  // body: string | null
  if (data.body !== null && typeof data.body !== "string") {
    return fail("body", `Expected string or null, got ${typeof data.body}`);
  }
  // labels: Array<{ name: string }>
  if (!Array.isArray(data.labels)) {
    return fail("labels", `Expected array, got ${typeof data.labels}`);
  }
  for(let i = 0; i < data.labels.length; i++){
    const label = data.labels[i];
    if (!isObject(label) || typeof label.name !== "string") {
      return fail(`labels[${i}].name`, "Expected object with string 'name' field");
    }
  }
  // author: { login: string }
  if (!isObject(data.author)) {
    return fail("author", `Expected object, got ${data.author === null ? "null" : typeof data.author}`);
  }
  if (typeof data.author.login !== "string") {
    return fail("author.login", `Expected string, got ${typeof data.author.login}`);
  }
  // assignees: Array<{ login: string }>
  if (!Array.isArray(data.assignees)) {
    return fail("assignees", `Expected array, got ${typeof data.assignees}`);
  }
  for(let i = 0; i < data.assignees.length; i++){
    const assignee = data.assignees[i];
    if (!isObject(assignee) || typeof assignee.login !== "string") {
      return fail(`assignees[${i}].login`, "Expected object with string 'login' field");
    }
  }
  // createdAt
  if (typeof data.createdAt !== "string") {
    return fail("createdAt", `Expected string, got ${typeof data.createdAt}`);
  }
  // updatedAt
  if (typeof data.updatedAt !== "string") {
    return fail("updatedAt", `Expected string, got ${typeof data.updatedAt}`);
  }
  // state is optional: older callers omit it. When present it is whatever
  // string `gh issue view` returned. A merged pull request is `MERGED`, and
  // rejecting that made every `getIssue` on a merged PR throw (Issue #3088
  // review). A non-string is still rejected.
  if (data.state !== undefined && typeof data.state !== "string") {
    return fail("state", `Expected string, got ${typeof data.state}`);
  }
  return ok(data);
}
// --- GhCommentJson validation ---
/**
 * Validate unknown data as a GhCommentJson structure.
 * Normalises null/missing reaction values to 0.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns Validated GhCommentJson or a ValidationError
 */ export function validateGhCommentJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  // id
  if (typeof data.id !== "number") {
    return fail("id", `Expected number, got ${typeof data.id}`);
  }
  // body
  if (typeof data.body !== "string") {
    return fail("body", `Expected string, got ${typeof data.body}`);
  }
  // author
  if (!isObject(data.author)) {
    return fail("author", `Expected object, got ${data.author === null ? "null" : typeof data.author}`);
  }
  if (typeof data.author.login !== "string") {
    return fail("author.login", `Expected string, got ${typeof data.author.login}`);
  }
  // createdAt
  if (typeof data.createdAt !== "string") {
    return fail("createdAt", `Expected string, got ${typeof data.createdAt}`);
  }
  // reactions
  if (!isObject(data.reactions)) {
    return fail("reactions", `Expected object, got ${data.reactions === null ? "null" : typeof data.reactions}`);
  }
  // Normalise null/undefined/missing reaction values to 0
  const reactions = data.reactions;
  const thumbsUp = typeof reactions["+1"] === "number" ? reactions["+1"] : 0;
  const eyes = typeof reactions.eyes === "number" ? reactions.eyes : 0;
  const confused = typeof reactions.confused === "number" ? reactions.confused : 0;
  const validated = {
    id: data.id,
    body: data.body,
    author: {
      login: data.author.login
    },
    createdAt: data.createdAt,
    reactions: {
      "+1": thumbsUp,
      eyes,
      confused
    }
  };
  return ok(validated);
}
// --- Comments array validation ---
/**
 * Validate unknown data as an array of GhCommentJson.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns Validated GhCommentJson array or a ValidationError
 */ export function validateGhCommentsJson(data) {
  if (!Array.isArray(data)) {
    return fail("root", `Expected array, got ${typeof data}`);
  }
  const result = [];
  for(let i = 0; i < data.length; i++){
    const commentResult = validateGhCommentJson(data[i]);
    if (!commentResult.ok) {
      return fail(`comments[${i}].${commentResult.error.field}`, commentResult.error.message);
    }
    result.push(commentResult.value);
  }
  return ok(result);
}
// --- ConfigFile validation ---
/**
 * Validate unknown data as a ConfigFile structure.
 * All fields are optional, but those present must have correct types.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns Validated ConfigFileJson or a ValidationError
 */ export function validateConfigFileJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  // A key this worker used to honour and no longer does must fail loudly:
  // ignoring it would leave the operator with a setting that reads as live
  // and does nothing (Issue #805).
  const stale = [
    ...REMOVED_CONFIG_KEYS.keys()
  ].filter((key)=>data[key] !== undefined);
  if (stale.length > 0) {
    // One message for the whole migration — fixing one key and rediscovering
    // the next on the following start is not actionable.
    const guidance = [
      ...new Set(stale.map((key)=>REMOVED_CONFIG_KEYS.get(key)))
    ];
    return fail(stale.join(", "), `${stale.map((key)=>`"${key}"`).join(" and ")} ${stale.length === 1 ? "was" : "were"} removed. ${guidance.join(" ")}`);
  }
  // Optional string fields
  // Issue #1834: `work_on_label` and `low_priority_label` removed — the
  // three discovery labels are hardwired and not configurable.
  const stringFields = [
    "failed_once_label",
    "failed_label",
    "refine_issue_label",
    "planning_label",
    "question_label",
    "needs_revision_label",
    "needs_human_label",
    "run_mode",
    // Update mode and the checkout pin (Issue #622). The accepted values and
    // the frozen-mode rules are enforced by `validateUpdateModeSettings`;
    // here only the JSON type is checked.
    "update_mode",
    "pinned_ref",
    "agent_provider_mode",
    "agent_provider",
    "claude_model",
    "best_planning_model",
    "worker_name",
    "ssh_key_path",
    "gh_config_dir",
    LOG_DIR_CONFIG_KEY,
    "imgbb_api_key",
    "github_app_id",
    "github_app_installation_id",
    "github_app_private_key_path",
    "verbosity",
    "exclusion_team"
  ];
  for (const field of stringFields){
    const result = validateOptionalString(data[field], field);
    if (!result.ok) return result;
  }
  // run_mode accepts only container (Issues #4146, #4) — a typo must fail
  // here rather than be coerced to the default (Issue #3234), and a removed
  // mode (native, seatbelt) is named as removed so the operator learns why.
  if (data[RUN_MODE_CONFIG_KEY] !== undefined && !isRunMode(data[RUN_MODE_CONFIG_KEY])) {
    const raw = data[RUN_MODE_CONFIG_KEY];
    if (typeof raw === "string" && REMOVED_RUN_MODES.includes(raw.trim())) {
      return fail(RUN_MODE_CONFIG_KEY, `Run mode ${JSON.stringify(raw)} was removed (Issue #4): containment ` + `is mandatory, the worker runs only inside the container. Remove ` + `the key.`);
    }
    return fail(RUN_MODE_CONFIG_KEY, `Expected one of ${RUN_MODES.join(", ")}, got ${JSON.stringify(raw)}`);
  }
  if (data.agent_provider_mode !== undefined && data.agent_provider_mode !== "pinned" && data.agent_provider_mode !== "auto") {
    return fail("agent_provider_mode", `Expected one of pinned, auto, got ${JSON.stringify(data.agent_provider_mode)}`);
  }
  // log_dir must be a path a launcher can act on (Issue #873). A relative
  // value resolves against whichever directory each launcher was started in,
  // so the logs would split across directories — exactly what this key exists
  // to prevent. Refused here, where the operator is told which key is wrong.
  if (data[LOG_DIR_CONFIG_KEY] !== undefined) {
    const raw = data[LOG_DIR_CONFIG_KEY];
    const stated = raw.trim();
    const anchored = stated === "~" || stated.startsWith("~/") || stated.startsWith("~\\");
    if (stated !== "" && !anchored && !isAbsolutePath(stated, pathStyleFor(stated))) {
      return fail(LOG_DIR_CONFIG_KEY, `Expected an absolute path or one starting with "~/", got ${JSON.stringify(raw)}`);
    }
  }
  // exclusion_team must be org/slug when present (Issue #252). A typo that
  // silently disables team exclusion is the failure mode this rejects.
  if (data.exclusion_team !== undefined) {
    if (!EXCLUSION_TEAM_PATTERN.test(data.exclusion_team)) {
      return fail("exclusion_team", `Expected org/slug (e.g. stSoftwareAU/vibe-workers), got ${JSON.stringify(data.exclusion_team)}`);
    }
  }
  // fleet_run_archive must be an owner/repo slug when present (Issue #2930):
  // measurement issues treat it as a repository to read, so a typo or a
  // hostile value must fail loudly rather than be used as-is.
  if (data.fleet_run_archive !== undefined) {
    const raw = data.fleet_run_archive;
    const trimmed = typeof raw === "string" ? raw.trim() : raw;
    if (!isValidRepoSlug(trimmed)) {
      return fail("fleet_run_archive", `Expected an owner/repo slug, got ${renderInertRepoSlug(raw)}`);
    }
  }
  // subscription_allocation_label is an operator label (Issue #3718). The
  // ledger owns the label rule. The message never echoes the value, which
  // could be an account email. Whitespace is invalid (Issue #3752).
  if (data.subscription_allocation_label !== undefined) {
    const raw = data.subscription_allocation_label;
    if (!isValidLifecycleLabel(raw)) {
      return fail("subscription_allocation_label", "Expected an operator label of lowercase letters, digits, '.', '_' or '-' (at most 64 characters) — never an account email, ID or fee");
    }
  }
  // Optional string array fields
  // Issue #1834: `issue_labels` removed — the three discovery labels are
  // hardwired and not configurable.
  const arrayFields = [
    "allowed_authors",
    "pr_reviewers",
    "repos",
    "authorized_commenters",
    "trusted_review_bots",
    "agent_providers",
    "agent_provider_fallback",
    "claude_week_pace_drain",
    // Long-job labels for the adaptive claim floor (Issue #245).
    "claim_long_job_labels"
  ];
  for (const field of arrayFields){
    const result = validateOptionalStringArray(data[field], field);
    if (!result.ok) return result;
  }
  // Optional number fields (Issue #277 — operational settings)
  const numberFields = [
    "claude_timeout",
    "min_claim_runway_seconds",
    "run_finish_seconds",
    "claude_kill_after",
    "max_clarification_rounds",
    "sleep_interval",
    "credit_wait_interval",
    "refinement_timeout",
    "refinement_kill_after",
    "planning_timeout",
    "planning_kill_after",
    "question_timeout",
    "question_kill_after",
    "clarification_timeout",
    "clarification_kill_after",
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
    "log_max_size_mb",
    "log_max_rotations",
    "stuck_issue_timeout",
    "issue_retry_cooldown",
    "min_disk_space_mb",
    "host_disk_low_floor_gb",
    "host_disk_low_floor_percent",
    "stale_failed_diagnostic_days",
    "stale_planning_warning_days",
    "fast_failure_seconds",
    "repo_fast_failure_threshold",
    "repo_fast_failure_window_hours",
    "context_budget_warning_percent",
    "context_budget_error_percent",
    "context_budget_block_percent"
  ];
  for (const field of numberFields){
    const result = validateOptionalNumber(data[field], field);
    if (!result.ok) return result;
  }
  // Optional boolean fields (Issue #435)
  const booleanFields = [
    "shuffle_repos",
    "update_gh_user_status",
    "enable_model_fallback",
    "sync_milestone_branches",
    "enable_session_resume",
    // Host-wide issue-executor split (Issue #2341).
    "issue_executor_split",
    // Host-wide reviewer sub-agents (Issue #2575).
    "issue_reviewer_agents",
    // Drain the held Claude token to zero (Issue #2474).
    "claude_week_pace_drain"
  ];
  for (const field of booleanFields){
    const result = validateOptionalBoolean(data[field], field);
    if (!result.ok) return result;
  }
  // pinned_tool_versions is an object of tool → exact version string
  // (Issue #622). Only the shape is checked here; whether the versions are
  // present and usable is `validateUpdateModeSettings`'s call.
  if (data.pinned_tool_versions !== undefined) {
    if (!isObject(data.pinned_tool_versions)) {
      return fail("pinned_tool_versions", `Expected object, got ${data.pinned_tool_versions === null ? "null" : typeof data.pinned_tool_versions}`);
    }
    for (const [tool, version] of Object.entries(data.pinned_tool_versions)){
      const result = validateOptionalString(version, `pinned_tool_versions.${tool}`);
      if (!result.ok) return result;
    }
  }
  // repo_config is optional and loosely typed (validated elsewhere)
  if (data.repo_config !== undefined && !isObject(data.repo_config)) {
    return fail("repo_config", `Expected object, got ${typeof data.repo_config}`);
  }
  // Per-phase routing overrides are optional Record<string, string> maps —
  // Claude's (Issues #1265, #1403), Codex's (Issue #363), Gemini's
  // (Issue #364, model only) and DeepSeek's (Issue #413, model only).
  const phaseOverrideFields = [
    "phase_model_overrides",
    "phase_effort_overrides",
    "codex_phase_model_overrides",
    "codex_phase_effort_overrides",
    "gemini_phase_model_overrides",
    "deepseek_phase_model_overrides"
  ];
  for (const field of phaseOverrideFields){
    const value = data[field];
    if (value === undefined) continue;
    if (!isObject(value)) {
      return fail(field, `Expected object, got ${typeof value}`);
    }
    for (const [key, val] of Object.entries(value)){
      if (typeof val !== "string") {
        return fail(`${field}.${key}`, `Expected string, got ${typeof val}`);
      }
    }
  }
  // idle_task_template_weights is optional Record<string, number> (Issue #2401)
  if (data.idle_task_template_weights !== undefined) {
    if (!isObject(data.idle_task_template_weights)) {
      return fail("idle_task_template_weights", `Expected object, got ${typeof data.idle_task_template_weights}`);
    }
    for (const [key, val] of Object.entries(data.idle_task_template_weights)){
      if (typeof val !== "number") {
        return fail(`idle_task_template_weights.${key}`, `Expected number, got ${typeof val}`);
      }
    }
  }
  // software_min_versions is optional Record<string, string> (Issue #2622)
  if (data.software_min_versions !== undefined) {
    if (!isObject(data.software_min_versions)) {
      return fail("software_min_versions", `Expected object, got ${typeof data.software_min_versions}`);
    }
    for (const [key, val] of Object.entries(data.software_min_versions)){
      if (typeof val !== "string") {
        return fail(`software_min_versions.${key}`, `Expected string, got ${typeof val}`);
      }
    }
  }
  // custom_label_prompts is optional and must be an array of objects when
  // present (Issue #846). Field-level checks happen in
  // parseCustomLabelPrompts()/assertCustomLabelPrompts() — this is only the
  // shallow JSON-shape gate every other config key gets here.
  if (data.custom_label_prompts !== undefined) {
    if (!Array.isArray(data.custom_label_prompts)) {
      return fail("custom_label_prompts", `Expected array, got ${typeof data.custom_label_prompts}`);
    }
    for(let i = 0; i < data.custom_label_prompts.length; i++){
      if (!isObject(data.custom_label_prompts[i])) {
        return fail(`custom_label_prompts[${i}]`, `Expected object, got ${typeof data.custom_label_prompts[i]}`);
      }
    }
  }
  return ok(data);
}
/**
 * Validate unknown data as an array of GitHub milestones.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns Validated milestones or a ValidationError
 */ export function validateGitHubMilestonesJson(data) {
  if (!Array.isArray(data)) {
    return fail("root", `Expected array, got ${typeof data}`);
  }
  for(let i = 0; i < data.length; i++){
    const item = data[i];
    if (!isObject(item)) {
      return fail(`milestones[${i}]`, "Expected object");
    }
    if (typeof item.title !== "string") {
      return fail(`milestones[${i}].title`, `Expected string, got ${typeof item.title}`);
    }
    if (typeof item.number !== "number") {
      return fail(`milestones[${i}].number`, `Expected number, got ${typeof item.number}`);
    }
  }
  return ok(data);
}
/**
 * Validate unknown `gh api graphql` output for a branch compare (Issue #3856).
 *
 * Non-empty `errors` win over `data`. A null `ref` means the branch is absent;
 * a null `compare` means the comparison is unavailable.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns The classified outcome or a ValidationError
 */ export function validateGraphQLBranchCompareJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  const errors = data.errors;
  if (errors !== undefined && errors !== null) {
    if (!Array.isArray(errors)) {
      return fail("errors", `Expected array, got ${typeof errors}`);
    }
    const messages = [];
    for(let i = 0; i < errors.length; i++){
      const item = errors[i];
      if (!isObject(item)) {
        return fail(`errors[${i}]`, `Expected object, got ${item === null ? "null" : typeof item}`);
      }
      if (typeof item.message !== "string") {
        return fail(`errors[${i}].message`, `Expected string, got ${typeof item.message}`);
      }
      messages.push(item.message);
    }
    if (messages.length > 0) {
      return ok({
        kind: "errors",
        messages
      });
    }
  }
  const payload = data.data;
  if (!isObject(payload)) {
    return fail("data", `Expected object, got ${payload === null ? "null" : typeof payload}`);
  }
  const repository = payload.repository;
  if (!isObject(repository)) {
    return fail("data.repository", `Expected object, got ${repository === null ? "null" : typeof repository}`);
  }
  const ref = repository.ref;
  // GraphQL returns every selected field, null when unresolved: only an
  // explicit null means "branch absent"; an omitted key is malformed.
  if (ref === null) {
    return ok({
      kind: "absent"
    });
  }
  if (!isObject(ref)) {
    return fail("data.repository.ref", `Expected object or null, got ${typeof ref}`);
  }
  const compare = ref.compare;
  if (compare === null) {
    return ok({
      kind: "unavailable"
    });
  }
  if (!isObject(compare)) {
    return fail("data.repository.ref.compare", `Expected object or null, got ${typeof compare}`);
  }
  if (typeof compare.aheadBy !== "number") {
    return fail("data.repository.ref.compare.aheadBy", `Expected number, got ${typeof compare.aheadBy}`);
  }
  if (typeof compare.behindBy !== "number") {
    return fail("data.repository.ref.compare.behindBy", `Expected number, got ${typeof compare.behindBy}`);
  }
  return ok({
    kind: "compare",
    aheadBy: compare.aheadBy,
    behindBy: compare.behindBy
  });
}
/**
 * Validate unknown REST compare output (Issue #3856). Extra fields are ignored.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns Validated counts or a ValidationError
 */ export function validateRestCompareJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  if (typeof data.ahead_by !== "number") {
    return fail("ahead_by", `Expected number, got ${typeof data.ahead_by}`);
  }
  if (typeof data.behind_by !== "number") {
    return fail("behind_by", `Expected number, got ${typeof data.behind_by}`);
  }
  return ok({
    ahead_by: data.ahead_by,
    behind_by: data.behind_by
  });
}
// --- Issue number list (used for closed issue checks, etc.) ---
/**
 * Validate unknown data as an array of `{ number: number }`.
 *
 * Matches gh output where only the issue number field was requested.
 */ export function validateIssueNumberListJson(data) {
  if (!Array.isArray(data)) {
    return fail("root", `Expected array, got ${typeof data}`);
  }
  for(let i = 0; i < data.length; i++){
    const item = data[i];
    if (!isObject(item)) {
      return fail(`items[${i}]`, "Expected object");
    }
    if (typeof item.number !== "number") {
      return fail(`items[${i}].number`, `Expected number, got ${typeof item.number}`);
    }
  }
  return ok(data);
}
/**
 * Validate `{ labels: [{ name }] }` — used by gh issue view --json labels.
 */ export function validateIssueLabelsJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  if (!Array.isArray(data.labels)) {
    return fail("labels", `Expected array, got ${typeof data.labels}`);
  }
  for(let i = 0; i < data.labels.length; i++){
    const label = data.labels[i];
    if (!isObject(label) || typeof label.name !== "string") {
      return fail(`labels[${i}].name`, "Expected object with string 'name' field");
    }
  }
  return ok(data);
}
/**
 * Validate a timeline events array. Only events with `event: "labeled"`
 * rely on label/actor fields, so those fields remain optional.
 */ export function validateTimelineLabelEventsJson(data) {
  if (!Array.isArray(data)) {
    return fail("root", `Expected array, got ${typeof data}`);
  }
  for(let i = 0; i < data.length; i++){
    const item = data[i];
    if (!isObject(item)) {
      return fail(`timeline[${i}]`, "Expected object");
    }
    if (typeof item.event !== "string") {
      return fail(`timeline[${i}].event`, `Expected string, got ${typeof item.event}`);
    }
    if (item.label !== undefined && item.label !== null) {
      if (!isObject(item.label) || typeof item.label.name !== "string") {
        return fail(`timeline[${i}].label.name`, "Expected object with string 'name' field");
      }
    }
    if (item.actor !== undefined && item.actor !== null) {
      if (!isObject(item.actor) || typeof item.actor.login !== "string") {
        return fail(`timeline[${i}].actor.login`, "Expected object with string 'login' field");
      }
    }
    if (item.assignee !== undefined && item.assignee !== null) {
      if (!isObject(item.assignee) || typeof item.assignee.login !== "string") {
        return fail(`timeline[${i}].assignee.login`, "Expected object with string 'login' field");
      }
    }
    if (item.created_at !== undefined && item.created_at !== null) {
      if (typeof item.created_at !== "string") {
        return fail(`timeline[${i}].created_at`, "Expected string");
      }
    }
  }
  return ok(data);
}
/**
 * Validate `{ milestone: { title } | null | undefined }` — used by
 * gh issue view --json milestone.
 */ export function validateIssueMilestoneJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  if (data.milestone === undefined || data.milestone === null) {
    return ok({
      milestone: null
    });
  }
  if (!isObject(data.milestone)) {
    return fail("milestone", `Expected object or null, got ${typeof data.milestone}`);
  }
  if (typeof data.milestone.title !== "string") {
    return fail("milestone.title", `Expected string, got ${typeof data.milestone.title}`);
  }
  return ok({
    milestone: {
      title: data.milestone.title
    }
  });
}
/**
 * Validate `{ body?: string }`. The body field is optional; when present
 * it must be a string.
 */ export function validateIssueBodyJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  if (data.body === undefined || data.body === null) {
    return ok({});
  }
  if (typeof data.body !== "string") {
    return fail("body", `Expected string, got ${typeof data.body}`);
  }
  return ok({
    body: data.body
  });
}
/**
 * Validate an issue state response.
 */ export function validateIssueStateJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  if (typeof data.number !== "number") {
    return fail("number", `Expected number, got ${typeof data.number}`);
  }
  if (typeof data.state !== "string") {
    return fail("state", `Expected string, got ${typeof data.state}`);
  }
  if (typeof data.title !== "string") {
    return fail("title", `Expected string, got ${typeof data.title}`);
  }
  // Issue #2533: `gh` returns `milestone` as an object (or null); anything
  // else is treated as "no milestone" rather than failing the whole read, so a
  // caller that never requested the field still validates.
  const milestone = isObject(data.milestone) && typeof data.milestone.title === "string" ? data.milestone.title : null;
  return ok({
    number: data.number,
    state: data.state,
    title: data.title,
    milestone
  });
}
/**
 * Validate the full issue view JSON (with assignees, labels, etc.).
 */ export function validateGhIssueViewJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  if (typeof data.number !== "number") {
    return fail("number", `Expected number, got ${typeof data.number}`);
  }
  if (typeof data.title !== "string") {
    return fail("title", `Expected string, got ${typeof data.title}`);
  }
  if (typeof data.url !== "string") {
    return fail("url", `Expected string, got ${typeof data.url}`);
  }
  if (typeof data.createdAt !== "string") {
    return fail("createdAt", `Expected string, got ${typeof data.createdAt}`);
  }
  if (!isObject(data.author)) {
    return fail("author", `Expected object, got ${data.author === null ? "null" : typeof data.author}`);
  }
  if (typeof data.author.login !== "string") {
    return fail("author.login", `Expected string, got ${typeof data.author.login}`);
  }
  if (!Array.isArray(data.assignees)) {
    return fail("assignees", `Expected array, got ${typeof data.assignees}`);
  }
  for(let i = 0; i < data.assignees.length; i++){
    const a = data.assignees[i];
    if (!isObject(a) || typeof a.login !== "string") {
      return fail(`assignees[${i}].login`, "Expected object with string 'login' field");
    }
  }
  if (!Array.isArray(data.labels)) {
    return fail("labels", `Expected array, got ${typeof data.labels}`);
  }
  for(let i = 0; i < data.labels.length; i++){
    const l = data.labels[i];
    if (!isObject(l) || typeof l.name !== "string") {
      return fail(`labels[${i}].name`, "Expected object with string 'name' field");
    }
  }
  // milestone is optional
  if (data.milestone !== undefined && data.milestone !== null) {
    if (!isObject(data.milestone) || typeof data.milestone.title !== "string") {
      return fail("milestone.title", "Expected object with string 'title' field");
    }
  }
  return ok(data);
}
/**
 * Validate a `Record<string, {branch, fetchedAt}>` persisted cache.
 *
 * Entries that fail validation are dropped (rather than rejecting the
 * whole cache) so a single corrupt entry does not invalidate the file.
 * Returns the validated entries as a plain record.
 */ export function validateDefaultBranchCacheJson(data) {
  if (!isObject(data)) {
    return fail("root", `Expected object, got ${data === null ? "null" : typeof data}`);
  }
  const validated = {};
  for (const [key, entry] of Object.entries(data)){
    if (isObject(entry) && typeof entry.branch === "string" && typeof entry.fetchedAt === "number") {
      validated[key] = {
        branch: entry.branch,
        fetchedAt: entry.fetchedAt
      };
    }
  // Silently drop malformed entries — the cache is best-effort.
  }
  return ok(validated);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi92YWxpZGF0aW9uLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUnVudGltZSBKU09OIHNjaGVtYSB2YWxpZGF0aW9uIGZvciBnaCBDTEkgcmVzcG9uc2VzIGFuZCBjb25maWcgZmlsZXMuXG4gKlxuICogUHJvdmlkZXMgdHlwZSBndWFyZCBmdW5jdGlvbnMgdGhhdCB2YWxpZGF0ZSB1bmtub3duIEpTT04gZGF0YSBhdCBydW50aW1lLFxuICogcmV0dXJuaW5nIHR5cGVkIHJlc3VsdHMgb3IgZXhwbGljaXQgZXJyb3JzIChJc3N1ZSAjMjE0KS5cbiAqL1xuXG5pbXBvcnQge1xuICBpc1J1bk1vZGUsXG4gIFJFTU9WRURfUlVOX01PREVTLFxuICBSVU5fTU9ERV9DT05GSUdfS0VZLFxuICBSVU5fTU9ERVMsXG59IGZyb20gXCIuL3J1bl9tb2RlLnRzXCI7XG5pbXBvcnQgeyBpc0Fic29sdXRlUGF0aCwgcGF0aFN0eWxlRm9yIH0gZnJvbSBcIi4vaG9zdF9wYXRoX3N0eWxlLnRzXCI7XG5pbXBvcnQgeyBMT0dfRElSX0NPTkZJR19LRVkgfSBmcm9tIFwiLi9sb2dfZGlyLnRzXCI7XG5pbXBvcnQgeyBpc1ZhbGlkUmVwb1NsdWcsIHJlbmRlckluZXJ0UmVwb1NsdWcgfSBmcm9tIFwiLi9yZXBvX3NsdWcudHNcIjtcbmltcG9ydCB7IGlzVmFsaWRMaWZlY3ljbGVMYWJlbCB9IGZyb20gXCIuL2xpZmVjeWNsZV9sZWRnZXIudHNcIjtcblxuLyoqXG4gKiBHaXRIdWIgb3JnIHRlYW0gc2x1ZyBpbiBgb3JnL3NsdWdgIGZvcm0gKElzc3VlICMyNTIpLlxuICpcbiAqIEVhY2ggc2VnbWVudCBzdGFydHMgd2l0aCBhbiBhbHBoYW51bWVyaWMgYW5kIG1heSBjb250YWluIGh5cGhlbnMuXG4gKiBBIGJhcmUgc2x1ZywgZXh0cmEgcGF0aCBzZWdtZW50cywgb3Igd2hpdGVzcGFjZSBpcyB1bnBhcnNlYWJsZSDigJQgYSB0eXBvXG4gKiB0aGF0IHNpbGVudGx5IGRpc2FibGVkIHRlYW0gZXhjbHVzaW9uIGlzIHRoZSBmYWlsdXJlIG1vZGUgdGhpcyByZWplY3RzLlxuICovXG5leHBvcnQgY29uc3QgRVhDTFVTSU9OX1RFQU1fUEFUVEVSTiA9XG4gIC9eW2EtekEtWjAtOV0oPzpbYS16QS1aMC05LV0qW2EtekEtWjAtOV0pP1xcL1thLXpBLVowLTldKD86W2EtekEtWjAtOS1dKlthLXpBLVowLTldKT8kLztcblxuLyoqXG4gKiBDb25maWcga2V5cyB0aGlzIHdvcmtlciBvbmNlIGhvbm91cmVkLCBtYXBwZWQgdG8gdGhlIG1pZ3JhdGlvbiBhbiBvcGVyYXRvclxuICogc3RpbGwgY2Fycnlpbmcgb25lIGhhcyB0byBtYWtlIChJc3N1ZSAjODA1KS5cbiAqXG4gKiBBIHJlbW92ZWQga2V5IGlzIHJlZnVzZWQgcmF0aGVyIHRoYW4gaWdub3JlZDogYSBzZXR0aW5nIHRoYXQgcmVhZHMgYXMgbGl2ZVxuICogYW5kIGRvZXMgbm90aGluZyBpcyB0aGUgc2lsZW50IGZhaWx1cmUgdGhlIHdob2xlIGNvbmZpZyBsb2FkIGV4aXN0cyB0b1xuICogcHJldmVudC4gVGhlIG1lc3NhZ2UgbmFtZXMgdGhlIHJlcGxhY2VtZW50IHNvIHRoZSBmaXggaXMgb25lIGVkaXQsIG5vdCBhblxuICogaW52ZXN0aWdhdGlvbi5cbiAqL1xuZXhwb3J0IGNvbnN0IFJFTU9WRURfQ09ORklHX0tFWVM6IFJlYWRvbmx5TWFwPHN0cmluZywgc3RyaW5nPiA9IG5ldyBNYXAoW1xuICBbXG4gICAgXCJmbGVldF9oZWFsdGhfZGlyXCIsXG4gICAgXCJCdWlsdC1pbiBmbGVldCBoZWFsdGggcmVwb3J0aW5nIHdhcyByZW1vdmVkIChJc3N1ZSAjODA1KTogcmVwb3J0IGhvc3QgXCIgK1xuICAgIFwiaGVhbHRoIGZyb20gYSBgY2FsbGJhY2tzLnN1Y2Nlc3NgIChvciBgY2FsbGJhY2tzLmFsd2F5c2ApIGhvb2sgXCIgK1xuICAgIFwiaW5zdGVhZCDigJQgc2VlIGRvY3MvQ09ORklHVVJBVElPTi5tZC4gUmVtb3ZlIHRoZSBrZXkuXCIsXG4gIF0sXG4gIFtcbiAgICBcImZsZWV0X2hlYWx0aF9yZXBvXCIsXG4gICAgXCJCdWlsdC1pbiBmbGVldCBoZWFsdGggcmVwb3J0aW5nIHdhcyByZW1vdmVkIChJc3N1ZSAjODA1KTogcmVwb3J0IGhvc3QgXCIgK1xuICAgIFwiaGVhbHRoIGZyb20gYSBgY2FsbGJhY2tzLnN1Y2Nlc3NgIChvciBgY2FsbGJhY2tzLmFsd2F5c2ApIGhvb2sgXCIgK1xuICAgIFwiaW5zdGVhZCDigJQgc2VlIGRvY3MvQ09ORklHVVJBVElPTi5tZC4gUmVtb3ZlIHRoZSBrZXkuXCIsXG4gIF0sXG4gIFtcbiAgICBcImF1dGhvcl9zb3VyY2VcIixcbiAgICBcIlRoZSB0cnVzdC1zb3VyY2Ugc3dpdGNoIHdhcyByZW1vdmVkIChJc3N1ZSAjMTA2Nik6IHRoZXJlIGlzIG5vdyBleGFjdGx5IFwiICtcbiAgICBcIm9uZSBzb3VyY2Ug4oCUIHRoZSB3cml0ZS9tYWludGFpbi9hZG1pbiBjb2xsYWJvcmF0b3JzIG9mIGVhY2ggbW9uaXRvcmVkIFwiICtcbiAgICBcInJlcG8sIG1pbnVzIHRoZSBWaWJlIENvZGVyIGxvZ2lucyBhbmQgYm90cy4gUmVtb3ZlIHRoZSBrZXk7IG5vdGhpbmcgXCIgK1xuICAgIFwicmVwbGFjZXMgaXQuIGAuL3NldHVwLnNoYCBzdHJpcHMgaXQgZm9yIHlvdS5cIixcbiAgXSxcbl0pO1xuXG4vKipcbiAqIFZhbGlkYXRpb24gZXJyb3Igd2l0aCB0aGUgZmllbGQgdGhhdCBmYWlsZWQgYW5kIGEgaHVtYW4tcmVhZGFibGUgbWVzc2FnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBWYWxpZGF0aW9uRXJyb3Ige1xuICBmaWVsZDogc3RyaW5nO1xuICBtZXNzYWdlOiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmVzdWx0IG9mIGEgdmFsaWRhdGlvbjogZWl0aGVyIGEgdHlwZWQgdmFsdWUgb3IgYW4gZXJyb3IuXG4gKi9cbmV4cG9ydCB0eXBlIFZhbGlkYXRpb25SZXN1bHQ8VD4gPVxuICB8IHsgb2s6IHRydWU7IHZhbHVlOiBUIH1cbiAgfCB7IG9rOiBmYWxzZTsgZXJyb3I6IFZhbGlkYXRpb25FcnJvciB9O1xuXG4vKipcbiAqIFJhdyBKU09OIHN0cnVjdHVyZSBmcm9tIGdoIGlzc3VlIHZpZXcgKHZhbGlkYXRlZCBhdCBydW50aW1lKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaElzc3VlSnNvbiB7XG4gIG51bWJlcjogbnVtYmVyO1xuICB0aXRsZTogc3RyaW5nO1xuICBib2R5OiBzdHJpbmcgfCBudWxsO1xuICBsYWJlbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nIH0+O1xuICBhdXRob3I6IHsgbG9naW46IHN0cmluZyB9O1xuICBhc3NpZ25lZXM6IEFycmF5PHsgbG9naW46IHN0cmluZyB9PjtcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xuICAvKipcbiAgICogUHJlc2VudCB3aGVuIGBnaCBpc3N1ZSB2aWV3YCB3YXMgYXNrZWQgZm9yIGBzdGF0ZWAuIEFueSBzdHJpbmcgYGdoYFxuICAgKiByZXR1cm5zLCBpbmNsdWRpbmcgYE1FUkdFRGAgd2hlbiB0aGUgbnVtYmVyIGlzIGEgcHVsbCByZXF1ZXN0XG4gICAqIChJc3N1ZSAjMzA4OCByZXZpZXcpLlxuICAgKi9cbiAgc3RhdGU/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmF3IEpTT04gc3RydWN0dXJlIGZyb20gZ2ggaXNzdWUgY29tbWVudHMgKHZhbGlkYXRlZCBhdCBydW50aW1lKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaENvbW1lbnRKc29uIHtcbiAgaWQ6IG51bWJlcjtcbiAgYm9keTogc3RyaW5nO1xuICBhdXRob3I6IHsgbG9naW46IHN0cmluZyB9O1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbiAgcmVhY3Rpb25zOiB7XG4gICAgXCIrMVwiOiBudW1iZXI7XG4gICAgZXllczogbnVtYmVyO1xuICAgIGNvbmZ1c2VkOiBudW1iZXI7XG4gIH07XG59XG5cbi8qKlxuICogRnVsbCBjb25maWd1cmF0aW9uIGZpbGUgc3RydWN0dXJlICh2YWxpZGF0ZWQgYXQgcnVudGltZSkuXG4gKlxuICogSXNzdWUgIzI3NzogSW5jbHVkZXMgb3BlcmF0aW9uYWwgc2V0dGluZ3MgKHRpbWVvdXRzLCBpbnRlcnZhbHMpLlxuICogQWxsIGZpZWxkcyBhcmUgb3B0aW9uYWwg4oCUIG9ubHkgb3ZlcnJpZGVzIGFyZSBzdG9yZWQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29uZmlnRmlsZUpzb24ge1xuICBhbGxvd2VkX2F1dGhvcnM/OiBzdHJpbmdbXTtcbiAgcHJfcmV2aWV3ZXJzPzogc3RyaW5nW107XG4gIHJlcG9zPzogc3RyaW5nW107XG4gIGF1dGhvcml6ZWRfY29tbWVudGVycz86IHN0cmluZ1tdO1xuICAvKiogYFwiZ2l0aHViXCJgIHwgYFwiY29uZmlnXCJgIOKAlCBkZWZhdWx0IGBcImNvbmZpZ1wiYCAoSXNzdWUgIzI1MikuICovXG4gIC8qKiBPcmcgdGVhbSBzbHVnIGBvcmcvc2x1Z2AgZXhjbHVkZWQgZnJvbSBHaXRIdWItZGVyaXZlZCBhbGxvd2xpc3RzLiAqL1xuICBleGNsdXNpb25fdGVhbT86IHN0cmluZztcbiAgLyoqIEJvdCBhY2NvdW50cyB3aG9zZSBQUiByZXZpZXcgY29tbWVudHMgYXJlIGF1dG8tdHJ1c3RlZCAoSXNzdWUgIzE4NTYpICovXG4gIHRydXN0ZWRfcmV2aWV3X2JvdHM/OiBzdHJpbmdbXTtcbiAgLy8gSXNzdWUgIzE4MzQ6IGBpc3N1ZV9sYWJlbHNgLCBgd29ya19vbl9sYWJlbGAsIGFuZCBgbG93X3ByaW9yaXR5X2xhYmVsYFxuICAvLyBhcmUgbm8gbG9uZ2VyIHZhbGlkIGtleXMuIFRoZSB0aHJlZSBkaXNjb3ZlcnkgbGFiZWxzICh0b3AtcHJpb3JpdHksXG4gIC8vIHdvcmstb24sIGxvdy1wcmlvcml0eSkgYXJlIGhhcmR3aXJlZCBpbiBgbGliL2NvbmZpZ19kZWZhdWx0cy50c2AuXG4gIGZhaWxlZF9vbmNlX2xhYmVsPzogc3RyaW5nO1xuICBmYWlsZWRfbGFiZWw/OiBzdHJpbmc7XG4gIHJlZmluZV9pc3N1ZV9sYWJlbD86IHN0cmluZztcbiAgcGxhbm5pbmdfbGFiZWw/OiBzdHJpbmc7XG4gIHF1ZXN0aW9uX2xhYmVsPzogc3RyaW5nO1xuICBuZWVkc19yZXZpc2lvbl9sYWJlbD86IHN0cmluZztcbiAgbmVlZHNfaHVtYW5fbGFiZWw/OiBzdHJpbmc7XG4gIHJlcG9fY29uZmlnPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIC8qKiBXaGVyZSB0aGUgd29ya2VyIHJ1bnMg4oCUIGBjb250YWluZXJgIG9yIGBuYXRpdmVgIChJc3N1ZSAjNDE0NikuICovXG4gIHJ1bl9tb2RlPzogc3RyaW5nO1xuICAvKiogSG93IHRoZSBob3N0IHRyYWNrcyByZWxlYXNlcyDigJQgYGR5bmFtaWNgIG9yIGBmcm96ZW5gIChJc3N1ZSAjNjIyKS4gKi9cbiAgdXBkYXRlX21vZGU/OiBzdHJpbmc7XG4gIC8qKiBDb21taXQgU0hBIG9yIHRhZyBhIGZyb3plbiBob3N0IGlzIGhlbGQgYXQgKElzc3VlICM2MjIpLiAqL1xuICBwaW5uZWRfcmVmPzogc3RyaW5nO1xuICAvKiogRXhhY3QgdG9vbCB2ZXJzaW9ucyBhIGZyb3plbiBob3N0IGluc3RhbGxzIChJc3N1ZSAjNjIyKS4gKi9cbiAgcGlubmVkX3Rvb2xfdmVyc2lvbnM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgLyoqIEFjdGl2ZSBjb2RpbmctYWdlbnQgcHJvdmlkZXIgaWQgKElzc3VlICM0MDY3KS4gKi9cbiAgYWdlbnRfcHJvdmlkZXI/OiBzdHJpbmc7XG4gIC8qKiBQcm92aWRlciBzZWxlY3Rpb24gc3RyYXRlZ3kgKElzc3VlICMxOTI2KS4gKi9cbiAgYWdlbnRfcHJvdmlkZXJfbW9kZT86IHN0cmluZztcbiAgLyoqIFByb3ZpZGVycyBlbmFibGVkIGZvciBhIHJ1biAoSXNzdWUgIzQxMDgpLiAqL1xuICBhZ2VudF9wcm92aWRlcnM/OiBzdHJpbmdbXTtcbiAgLyoqIE9wdC1pbiBvcmRlcmVkIGZhbGxiYWNrIHByb3ZpZGVycyAoSXNzdWUgIzE3MDApLiAqL1xuICBhZ2VudF9wcm92aWRlcl9mYWxsYmFjaz86IHN0cmluZ1tdO1xuICAvKipcbiAgICogRHJhaW4gdGhlIGhlbGQgQ2xhdWRlIHRva2VuIHRvIHplcm8gcmF0aGVyIHRoYW4gcGFya2luZyB0aGUgYmFja2xvZ1xuICAgKiBhdCB0aGUgd2Vlay1wYWNlIHByb2plY3Rpb24gKElzc3VlICMyNDc0KS5cbiAgICovXG4gIGNsYXVkZV93ZWVrX3BhY2VfZHJhaW4/OiBib29sZWFuO1xuICBjbGF1ZGVfbW9kZWw/OiBzdHJpbmc7XG4gIGJlc3RfcGxhbm5pbmdfbW9kZWw/OiBzdHJpbmc7XG4gIGNsYXVkZV90aW1lb3V0PzogbnVtYmVyO1xuICBtaW5fY2xhaW1fcnVud2F5X3NlY29uZHM/OiBudW1iZXI7XG4gIC8qKiBTZWNvbmRzIGZyb20gcnVuIHN0YXJ0IHRvIHRoZSBydW4ncyBmaW5pc2ggZGVhZGxpbmUgKElzc3VlICM0MjQyKS4gKi9cbiAgcnVuX2ZpbmlzaF9zZWNvbmRzPzogbnVtYmVyO1xuICAvKiogTGFiZWxzIG1hcmtpbmcgYW4gaXNzdWUgYXMgYSBsb25nIGpvYiAoSXNzdWUgIzI0NSkuICovXG4gIGNsYWltX2xvbmdfam9iX2xhYmVscz86IHN0cmluZ1tdO1xuICBjbGF1ZGVfa2lsbF9hZnRlcj86IG51bWJlcjtcbiAgbWF4X2NsYXJpZmljYXRpb25fcm91bmRzPzogbnVtYmVyO1xuICBzbGVlcF9pbnRlcnZhbD86IG51bWJlcjtcbiAgY3JlZGl0X3dhaXRfaW50ZXJ2YWw/OiBudW1iZXI7XG4gIHJlZmluZW1lbnRfdGltZW91dD86IG51bWJlcjtcbiAgcmVmaW5lbWVudF9raWxsX2FmdGVyPzogbnVtYmVyO1xuICBwbGFubmluZ190aW1lb3V0PzogbnVtYmVyO1xuICBwbGFubmluZ19raWxsX2FmdGVyPzogbnVtYmVyO1xuICBxdWVzdGlvbl90aW1lb3V0PzogbnVtYmVyO1xuICBxdWVzdGlvbl9raWxsX2FmdGVyPzogbnVtYmVyO1xuICBjbGFyaWZpY2F0aW9uX3RpbWVvdXQ/OiBudW1iZXI7XG4gIGNsYXJpZmljYXRpb25fa2lsbF9hZnRlcj86IG51bWJlcjtcbiAgbWF4X3JhdGVfbGltaXRfcmV0cmllcz86IG51bWJlcjtcbiAgbWF4X3JhdGVfbGltaXRfd2FpdD86IG51bWJlcjtcbiAgcmV0cnlfbWF4X2RlbGF5PzogbnVtYmVyO1xuICBtYXhfaXNzdWVfYm9keV90b2tlbnM/OiBudW1iZXI7XG4gIHN1bW1hcmlzZV90aW1lb3V0PzogbnVtYmVyO1xuICBzdW1tYXJpc2Vfa2lsbF9hZnRlcj86IG51bWJlcjtcbiAgZmVhdHVyZV9jaGVja190aW1lb3V0PzogbnVtYmVyO1xuICBjbGF1ZGVfbm9fb3V0cHV0X3RpbWVvdXQ/OiBudW1iZXI7XG4gIHF1YWxpdHlfY2hlY2tfdGltZW91dD86IG51bWJlcjtcbiAgaGVhbHRoX2NhY2hlX3R0bD86IG51bWJlcjtcbiAgc2h1ZmZsZV9yZXBvcz86IGJvb2xlYW47XG4gIHVwZGF0ZV9naF91c2VyX3N0YXR1cz86IGJvb2xlYW47XG4gIGVuYWJsZV9tb2RlbF9mYWxsYmFjaz86IGJvb2xlYW47XG4gIHN5bmNfbWlsZXN0b25lX2JyYW5jaGVzPzogYm9vbGVhbjtcbiAgd29ya2VyX25hbWU/OiBzdHJpbmc7XG4gIHNzaF9rZXlfcGF0aD86IHN0cmluZztcbiAgZ2hfY29uZmlnX2Rpcj86IHN0cmluZztcbiAgbG9nX2Rpcj86IHN0cmluZztcbiAgbG9nX21heF9zaXplX21iPzogbnVtYmVyO1xuICBsb2dfbWF4X3JvdGF0aW9ucz86IG51bWJlcjtcbiAgc3R1Y2tfaXNzdWVfdGltZW91dD86IG51bWJlcjtcbiAgaXNzdWVfcmV0cnlfY29vbGRvd24/OiBudW1iZXI7XG4gIGltZ2JiX2FwaV9rZXk/OiBzdHJpbmc7XG4gIGdpdGh1Yl9hcHBfaWQ/OiBzdHJpbmc7XG4gIGdpdGh1Yl9hcHBfaW5zdGFsbGF0aW9uX2lkPzogc3RyaW5nO1xuICBnaXRodWJfYXBwX3ByaXZhdGVfa2V5X3BhdGg/OiBzdHJpbmc7XG4gIG1pbl9kaXNrX3NwYWNlX21iPzogbnVtYmVyO1xuICBob3N0X2Rpc2tfbG93X2Zsb29yX2diPzogbnVtYmVyO1xuICBob3N0X2Rpc2tfbG93X2Zsb29yX3BlcmNlbnQ/OiBudW1iZXI7XG4gIHN0YWxlX2ZhaWxlZF9kaWFnbm9zdGljX2RheXM/OiBudW1iZXI7XG4gIHN0YWxlX3BsYW5uaW5nX3dhcm5pbmdfZGF5cz86IG51bWJlcjtcbiAgZmFzdF9mYWlsdXJlX3NlY29uZHM/OiBudW1iZXI7XG4gIHJlcG9fZmFzdF9mYWlsdXJlX3RocmVzaG9sZD86IG51bWJlcjtcbiAgcmVwb19mYXN0X2ZhaWx1cmVfd2luZG93X2hvdXJzPzogbnVtYmVyO1xuICBwaGFzZV9tb2RlbF9vdmVycmlkZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICBwaGFzZV9lZmZvcnRfb3ZlcnJpZGVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgY29kZXhfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgY29kZXhfcGhhc2VfZWZmb3J0X292ZXJyaWRlcz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIGdlbWluaV9waGFzZV9tb2RlbF9vdmVycmlkZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICBkZWVwc2Vla19waGFzZV9tb2RlbF9vdmVycmlkZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAvKiogSG9zdC13aWRlIGlzc3VlLWV4ZWN1dG9yIHNwbGl0IChJc3N1ZSAjMjM0MSkgKi9cbiAgaXNzdWVfZXhlY3V0b3Jfc3BsaXQ/OiBib29sZWFuO1xuICAvKipcbiAgICogSG9zdC13aWRlIGlzc3VlIHN1Yi1hZ2VudCB0aWVyIChJc3N1ZSAjMzQwMSkuIERlbGliZXJhdGVseSBOT1QgZmFpbGVkIGJ5XG4gICAqIGB2YWxpZGF0ZUNvbmZpZ0ZpbGVKc29uYDogYGxvYWRDb25maWdgIHRocm93cyBvbiBhbnkgdmFsaWRhdGlvbiBlcnJvciwgc29cbiAgICogYSBiYWQgdGllciAobm9uLXN0cmluZyBvciB1bmtub3duIHZhbHVlKSBpcyB3YXJuZWQgYWJvdXQgYW5kIHJlcGxhY2VkIGJ5XG4gICAqIHRoZSBkZWZhdWx0IGF0IGxvYWQgaW5zdGVhZCBvZiBzdG9wcGluZyB0aGUgd29ya2VyLlxuICAgKi9cbiAgaXNzdWVfc3ViX2FnZW50X3RpZXI/OiB1bmtub3duO1xuICAvKiogSG9zdC13aWRlIHJldmlld2VyIHN1Yi1hZ2VudHMgKElzc3VlICMyNTc1KSAqL1xuICBpc3N1ZV9yZXZpZXdlcl9hZ2VudHM/OiBib29sZWFuO1xuICAvKiogRmxlZXQtd2lkZSBydW4gYXJjaGl2ZSByZXBvIHNsdWcgZm9yIG1lYXN1cmVtZW50IGlzc3VlcyAoSXNzdWUgIzI5MzApICovXG4gIGZsZWV0X3J1bl9hcmNoaXZlPzogc3RyaW5nO1xuICAvKiogT3BlcmF0b3IgbGFiZWwgZm9yIHRoZSBzdWJzY3JpcHRpb24gYWxsb2NhdGlvbiAoSXNzdWUgIzM3MTgpICovXG4gIHN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uX2xhYmVsPzogc3RyaW5nO1xuICBlbmFibGVfc2Vzc2lvbl9yZXN1bWU/OiBib29sZWFuO1xuICAvKiogR2xvYmFsIHZlcmJvc2l0eSBsZXZlbCBvdmVycmlkZSAoSXNzdWUgIzEzMzApICovXG4gIHZlcmJvc2l0eT86IHN0cmluZztcbiAgY29udGV4dF9idWRnZXRfd2FybmluZ19wZXJjZW50PzogbnVtYmVyO1xuICBjb250ZXh0X2J1ZGdldF9lcnJvcl9wZXJjZW50PzogbnVtYmVyO1xuICBjb250ZXh0X2J1ZGdldF9ibG9ja19wZXJjZW50PzogbnVtYmVyO1xuICAvKiogUGVyLXRlbXBsYXRlIHdlaWdodHMgZm9yIHRoZSBpZGxlLXRhc2sgZHJhdyAoSXNzdWUgIzI0MDEpICovXG4gIGlkbGVfdGFza190ZW1wbGF0ZV93ZWlnaHRzPzogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgLyoqXG4gICAqIENhZGVuY2UgZmxvb3IgZm9yIHRoZSBpbXBvcnRhbnQgaWRsZS10YXNrIHRlbXBsYXRlcyAoSXNzdWUgIzQwMTEpLlxuICAgKlxuICAgKiBEZWxpYmVyYXRlbHkgdW52YWxpZGF0ZWQgaGVyZTogYHBhcnNlSWRsZVRhc2tDYWRlbmNlKClgIHdhcm5zIGxvdWRseSBhbmRcbiAgICogZmFsbHMgYmFjayBwZXIgZmF1bHQsIGJlY2F1c2UgYSB0eXBvIGluIGEgc3BlbmQgcG9saWN5IG11c3Qgbm90IHN0b3AgdGhlXG4gICAqIHdvcmtlciBmcm9tIHN0YXJ0aW5nLlxuICAgKi9cbiAgaWRsZV90YXNrX2NhZGVuY2U/OiB1bmtub3duO1xuICAvKiogUGVyLXRvb2wgbWluaW11bSB2ZXJzaW9uIGZsb29ycyBmb3Igc29mdHdhcmUgYXV0by11cGRhdGUgKElzc3VlICMyNjIyKSAqL1xuICBzb2Z0d2FyZV9taW5fdmVyc2lvbnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAvKipcbiAgICogUG9zdC1ydW4gY2FsbGJhY2sgaG9va3MgKElzc3VlICM4MDYsIHBhcmVudCAjNzk2KS5cbiAgICpcbiAgICogRGVsaWJlcmF0ZWx5IHVudmFsaWRhdGVkIGhlcmU6IGBwYXJzZUNhbGxiYWNrc0NvbmZpZygpYCBvd25zIHRoZSBzaGFwZSBhbmRcbiAgICogZmFpbHMgdGhlIGNvbmZpZyBsb2FkIGxvdWRseSwgc28gYSBob29rIHRoYXQgd291bGQgbmV2ZXIgcnVuIGlzIGNhdWdodFxuICAgKiBiZWZvcmUgYW55IGlzc3VlIGlzIGNsYWltZWQgYWdhaW5zdCBpdC5cbiAgICovXG4gIGNhbGxiYWNrcz86IHVua25vd247XG59XG5cbi8vIC0tLSBIZWxwZXJzIC0tLVxuXG5mdW5jdGlvbiBpc09iamVjdCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIGZhaWwoZmllbGQ6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKTogVmFsaWRhdGlvblJlc3VsdDxuZXZlcj4ge1xuICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiB7IGZpZWxkLCBtZXNzYWdlIH0gfTtcbn1cblxuZnVuY3Rpb24gb2s8VD4odmFsdWU6IFQpOiBWYWxpZGF0aW9uUmVzdWx0PFQ+IHtcbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlIH07XG59XG5cbi8vIC0tLSBTdHJpbmcgYXJyYXkgdmFsaWRhdGlvbiAtLS1cblxuZnVuY3Rpb24gdmFsaWRhdGVTdHJpbmdBcnJheShcbiAgYXJyOiB1bmtub3duLFxuICBmaWVsZE5hbWU6IHN0cmluZyxcbik6IFZhbGlkYXRpb25SZXN1bHQ8c3RyaW5nW10+IHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGFycikpIHtcbiAgICByZXR1cm4gZmFpbChmaWVsZE5hbWUsIGBFeHBlY3RlZCBhcnJheSwgZ290ICR7dHlwZW9mIGFycn1gKTtcbiAgfVxuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyci5sZW5ndGg7IGkrKykge1xuICAgIGlmICh0eXBlb2YgYXJyW2ldICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICByZXR1cm4gZmFpbChcbiAgICAgICAgYCR7ZmllbGROYW1lfVske2l9XWAsXG4gICAgICAgIGBFeHBlY3RlZCBzdHJpbmcsIGdvdCAke3R5cGVvZiBhcnJbaV19YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiBvayhhcnIgYXMgc3RyaW5nW10pO1xufVxuXG4vLyAtLS0gT3B0aW9uYWwgc3RyaW5nIGZpZWxkIHZhbGlkYXRpb24gLS0tXG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3B0aW9uYWxTdHJpbmcoXG4gIHZhbHVlOiB1bmtub3duLFxuICBmaWVsZE5hbWU6IHN0cmluZyxcbik6IFZhbGlkYXRpb25SZXN1bHQ8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIG9rKHVuZGVmaW5lZCk7XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiBmYWlsKGZpZWxkTmFtZSwgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIHZhbHVlfWApO1xuICB9XG4gIHJldHVybiBvayh2YWx1ZSk7XG59XG5cbi8vIC0tLSBPcHRpb25hbCBzdHJpbmcgYXJyYXkgdmFsaWRhdGlvbiAtLS1cblxuZnVuY3Rpb24gdmFsaWRhdGVPcHRpb25hbFN0cmluZ0FycmF5KFxuICB2YWx1ZTogdW5rbm93bixcbiAgZmllbGROYW1lOiBzdHJpbmcsXG4pOiBWYWxpZGF0aW9uUmVzdWx0PHN0cmluZ1tdIHwgdW5kZWZpbmVkPiB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIG9rKHVuZGVmaW5lZCk7XG4gIH1cbiAgcmV0dXJuIHZhbGlkYXRlU3RyaW5nQXJyYXkodmFsdWUsIGZpZWxkTmFtZSk7XG59XG5cbi8vIC0tLSBPcHRpb25hbCBib29sZWFuIGZpZWxkIHZhbGlkYXRpb24gKElzc3VlICM0MzUpIC0tLVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU9wdGlvbmFsQm9vbGVhbihcbiAgdmFsdWU6IHVua25vd24sXG4gIGZpZWxkTmFtZTogc3RyaW5nLFxuKTogVmFsaWRhdGlvblJlc3VsdDxib29sZWFuIHwgdW5kZWZpbmVkPiB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIG9rKHVuZGVmaW5lZCk7XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJib29sZWFuXCIpIHtcbiAgICByZXR1cm4gZmFpbChmaWVsZE5hbWUsIGBFeHBlY3RlZCBib29sZWFuLCBnb3QgJHt0eXBlb2YgdmFsdWV9YCk7XG4gIH1cbiAgcmV0dXJuIG9rKHZhbHVlKTtcbn1cblxuLy8gLS0tIE9wdGlvbmFsIG51bWJlciBmaWVsZCB2YWxpZGF0aW9uIChJc3N1ZSAjMjc3KSAtLS1cblxuZnVuY3Rpb24gdmFsaWRhdGVPcHRpb25hbE51bWJlcihcbiAgdmFsdWU6IHVua25vd24sXG4gIGZpZWxkTmFtZTogc3RyaW5nLFxuKTogVmFsaWRhdGlvblJlc3VsdDxudW1iZXIgfCB1bmRlZmluZWQ+IHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gb2sodW5kZWZpbmVkKTtcbiAgfVxuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm51bWJlclwiKSB7XG4gICAgcmV0dXJuIGZhaWwoZmllbGROYW1lLCBgRXhwZWN0ZWQgbnVtYmVyLCBnb3QgJHt0eXBlb2YgdmFsdWV9YCk7XG4gIH1cbiAgcmV0dXJuIG9rKHZhbHVlKTtcbn1cblxuLy8gLS0tIEdoSXNzdWVKc29uIHZhbGlkYXRpb24gLS0tXG5cbi8qKlxuICogVmFsaWRhdGUgdW5rbm93biBkYXRhIGFzIGEgR2hJc3N1ZUpzb24gc3RydWN0dXJlLlxuICpcbiAqIEBwYXJhbSBkYXRhIC0gVW5rbm93biBkYXRhICh0eXBpY2FsbHkgZnJvbSBKU09OLnBhcnNlKVxuICogQHJldHVybnMgVmFsaWRhdGVkIEdoSXNzdWVKc29uIG9yIGEgVmFsaWRhdGlvbkVycm9yXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUdoSXNzdWVKc29uKFxuICBkYXRhOiB1bmtub3duLFxuKTogVmFsaWRhdGlvblJlc3VsdDxHaElzc3VlSnNvbj4ge1xuICBpZiAoIWlzT2JqZWN0KGRhdGEpKSB7XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBcInJvb3RcIixcbiAgICAgIGBFeHBlY3RlZCBvYmplY3QsIGdvdCAke2RhdGEgPT09IG51bGwgPyBcIm51bGxcIiA6IHR5cGVvZiBkYXRhfWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIG51bWJlclxuICBpZiAodHlwZW9mIGRhdGEubnVtYmVyICE9PSBcIm51bWJlclwiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJudW1iZXJcIiwgYEV4cGVjdGVkIG51bWJlciwgZ290ICR7dHlwZW9mIGRhdGEubnVtYmVyfWApO1xuICB9XG5cbiAgLy8gdGl0bGVcbiAgaWYgKHR5cGVvZiBkYXRhLnRpdGxlICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJ0aXRsZVwiLCBgRXhwZWN0ZWQgc3RyaW5nLCBnb3QgJHt0eXBlb2YgZGF0YS50aXRsZX1gKTtcbiAgfVxuXG4gIC8vIGJvZHk6IHN0cmluZyB8IG51bGxcbiAgaWYgKGRhdGEuYm9keSAhPT0gbnVsbCAmJiB0eXBlb2YgZGF0YS5ib2R5ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJib2R5XCIsIGBFeHBlY3RlZCBzdHJpbmcgb3IgbnVsbCwgZ290ICR7dHlwZW9mIGRhdGEuYm9keX1gKTtcbiAgfVxuXG4gIC8vIGxhYmVsczogQXJyYXk8eyBuYW1lOiBzdHJpbmcgfT5cbiAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGEubGFiZWxzKSkge1xuICAgIHJldHVybiBmYWlsKFwibGFiZWxzXCIsIGBFeHBlY3RlZCBhcnJheSwgZ290ICR7dHlwZW9mIGRhdGEubGFiZWxzfWApO1xuICB9XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZGF0YS5sYWJlbHMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBsYWJlbCA9IGRhdGEubGFiZWxzW2ldO1xuICAgIGlmICghaXNPYmplY3QobGFiZWwpIHx8IHR5cGVvZiBsYWJlbC5uYW1lICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICByZXR1cm4gZmFpbChcbiAgICAgICAgYGxhYmVsc1ske2l9XS5uYW1lYCxcbiAgICAgICAgXCJFeHBlY3RlZCBvYmplY3Qgd2l0aCBzdHJpbmcgJ25hbWUnIGZpZWxkXCIsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8vIGF1dGhvcjogeyBsb2dpbjogc3RyaW5nIH1cbiAgaWYgKCFpc09iamVjdChkYXRhLmF1dGhvcikpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwiYXV0aG9yXCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0LCBnb3QgJHtcbiAgICAgICAgZGF0YS5hdXRob3IgPT09IG51bGwgPyBcIm51bGxcIiA6IHR5cGVvZiBkYXRhLmF1dGhvclxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuICBpZiAodHlwZW9mIGRhdGEuYXV0aG9yLmxvZ2luICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBcImF1dGhvci5sb2dpblwiLFxuICAgICAgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIGRhdGEuYXV0aG9yLmxvZ2lufWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIGFzc2lnbmVlczogQXJyYXk8eyBsb2dpbjogc3RyaW5nIH0+XG4gIGlmICghQXJyYXkuaXNBcnJheShkYXRhLmFzc2lnbmVlcykpIHtcbiAgICByZXR1cm4gZmFpbChcImFzc2lnbmVlc1wiLCBgRXhwZWN0ZWQgYXJyYXksIGdvdCAke3R5cGVvZiBkYXRhLmFzc2lnbmVlc31gKTtcbiAgfVxuICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGEuYXNzaWduZWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXNzaWduZWUgPSBkYXRhLmFzc2lnbmVlc1tpXTtcbiAgICBpZiAoIWlzT2JqZWN0KGFzc2lnbmVlKSB8fCB0eXBlb2YgYXNzaWduZWUubG9naW4gIT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBgYXNzaWduZWVzWyR7aX1dLmxvZ2luYCxcbiAgICAgICAgXCJFeHBlY3RlZCBvYmplY3Qgd2l0aCBzdHJpbmcgJ2xvZ2luJyBmaWVsZFwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBjcmVhdGVkQXRcbiAgaWYgKHR5cGVvZiBkYXRhLmNyZWF0ZWRBdCAhPT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiBmYWlsKFwiY3JlYXRlZEF0XCIsIGBFeHBlY3RlZCBzdHJpbmcsIGdvdCAke3R5cGVvZiBkYXRhLmNyZWF0ZWRBdH1gKTtcbiAgfVxuXG4gIC8vIHVwZGF0ZWRBdFxuICBpZiAodHlwZW9mIGRhdGEudXBkYXRlZEF0ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJ1cGRhdGVkQXRcIiwgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIGRhdGEudXBkYXRlZEF0fWApO1xuICB9XG5cbiAgLy8gc3RhdGUgaXMgb3B0aW9uYWw6IG9sZGVyIGNhbGxlcnMgb21pdCBpdC4gV2hlbiBwcmVzZW50IGl0IGlzIHdoYXRldmVyXG4gIC8vIHN0cmluZyBgZ2ggaXNzdWUgdmlld2AgcmV0dXJuZWQuIEEgbWVyZ2VkIHB1bGwgcmVxdWVzdCBpcyBgTUVSR0VEYCwgYW5kXG4gIC8vIHJlamVjdGluZyB0aGF0IG1hZGUgZXZlcnkgYGdldElzc3VlYCBvbiBhIG1lcmdlZCBQUiB0aHJvdyAoSXNzdWUgIzMwODhcbiAgLy8gcmV2aWV3KS4gQSBub24tc3RyaW5nIGlzIHN0aWxsIHJlamVjdGVkLlxuICBpZiAoZGF0YS5zdGF0ZSAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBkYXRhLnN0YXRlICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJzdGF0ZVwiLCBgRXhwZWN0ZWQgc3RyaW5nLCBnb3QgJHt0eXBlb2YgZGF0YS5zdGF0ZX1gKTtcbiAgfVxuXG4gIHJldHVybiBvayhkYXRhIGFzIHVua25vd24gYXMgR2hJc3N1ZUpzb24pO1xufVxuXG4vLyAtLS0gR2hDb21tZW50SnNvbiB2YWxpZGF0aW9uIC0tLVxuXG4vKipcbiAqIFZhbGlkYXRlIHVua25vd24gZGF0YSBhcyBhIEdoQ29tbWVudEpzb24gc3RydWN0dXJlLlxuICogTm9ybWFsaXNlcyBudWxsL21pc3NpbmcgcmVhY3Rpb24gdmFsdWVzIHRvIDAuXG4gKlxuICogQHBhcmFtIGRhdGEgLSBVbmtub3duIGRhdGEgKHR5cGljYWxseSBmcm9tIEpTT04ucGFyc2UpXG4gKiBAcmV0dXJucyBWYWxpZGF0ZWQgR2hDb21tZW50SnNvbiBvciBhIFZhbGlkYXRpb25FcnJvclxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVHaENvbW1lbnRKc29uKFxuICBkYXRhOiB1bmtub3duLFxuKTogVmFsaWRhdGlvblJlc3VsdDxHaENvbW1lbnRKc29uPiB7XG4gIGlmICghaXNPYmplY3QoZGF0YSkpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwicm9vdFwiLFxuICAgICAgYEV4cGVjdGVkIG9iamVjdCwgZ290ICR7ZGF0YSA9PT0gbnVsbCA/IFwibnVsbFwiIDogdHlwZW9mIGRhdGF9YCxcbiAgICApO1xuICB9XG5cbiAgLy8gaWRcbiAgaWYgKHR5cGVvZiBkYXRhLmlkICE9PSBcIm51bWJlclwiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJpZFwiLCBgRXhwZWN0ZWQgbnVtYmVyLCBnb3QgJHt0eXBlb2YgZGF0YS5pZH1gKTtcbiAgfVxuXG4gIC8vIGJvZHlcbiAgaWYgKHR5cGVvZiBkYXRhLmJvZHkgIT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4gZmFpbChcImJvZHlcIiwgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIGRhdGEuYm9keX1gKTtcbiAgfVxuXG4gIC8vIGF1dGhvclxuICBpZiAoIWlzT2JqZWN0KGRhdGEuYXV0aG9yKSkge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJhdXRob3JcIixcbiAgICAgIGBFeHBlY3RlZCBvYmplY3QsIGdvdCAke1xuICAgICAgICBkYXRhLmF1dGhvciA9PT0gbnVsbCA/IFwibnVsbFwiIDogdHlwZW9mIGRhdGEuYXV0aG9yXG4gICAgICB9YCxcbiAgICApO1xuICB9XG4gIGlmICh0eXBlb2YgZGF0YS5hdXRob3IubG9naW4gIT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwiYXV0aG9yLmxvZ2luXCIsXG4gICAgICBgRXhwZWN0ZWQgc3RyaW5nLCBnb3QgJHt0eXBlb2YgZGF0YS5hdXRob3IubG9naW59YCxcbiAgICApO1xuICB9XG5cbiAgLy8gY3JlYXRlZEF0XG4gIGlmICh0eXBlb2YgZGF0YS5jcmVhdGVkQXQgIT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4gZmFpbChcImNyZWF0ZWRBdFwiLCBgRXhwZWN0ZWQgc3RyaW5nLCBnb3QgJHt0eXBlb2YgZGF0YS5jcmVhdGVkQXR9YCk7XG4gIH1cblxuICAvLyByZWFjdGlvbnNcbiAgaWYgKCFpc09iamVjdChkYXRhLnJlYWN0aW9ucykpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwicmVhY3Rpb25zXCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0LCBnb3QgJHtcbiAgICAgICAgZGF0YS5yZWFjdGlvbnMgPT09IG51bGwgPyBcIm51bGxcIiA6IHR5cGVvZiBkYXRhLnJlYWN0aW9uc1xuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIE5vcm1hbGlzZSBudWxsL3VuZGVmaW5lZC9taXNzaW5nIHJlYWN0aW9uIHZhbHVlcyB0byAwXG4gIGNvbnN0IHJlYWN0aW9ucyA9IGRhdGEucmVhY3Rpb25zIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCB0aHVtYnNVcCA9IHR5cGVvZiByZWFjdGlvbnNbXCIrMVwiXSA9PT0gXCJudW1iZXJcIlxuICAgID8gcmVhY3Rpb25zW1wiKzFcIl0gYXMgbnVtYmVyXG4gICAgOiAwO1xuICBjb25zdCBleWVzID0gdHlwZW9mIHJlYWN0aW9ucy5leWVzID09PSBcIm51bWJlclwiXG4gICAgPyByZWFjdGlvbnMuZXllcyBhcyBudW1iZXJcbiAgICA6IDA7XG4gIGNvbnN0IGNvbmZ1c2VkID0gdHlwZW9mIHJlYWN0aW9ucy5jb25mdXNlZCA9PT0gXCJudW1iZXJcIlxuICAgID8gcmVhY3Rpb25zLmNvbmZ1c2VkIGFzIG51bWJlclxuICAgIDogMDtcblxuICBjb25zdCB2YWxpZGF0ZWQ6IEdoQ29tbWVudEpzb24gPSB7XG4gICAgaWQ6IGRhdGEuaWQgYXMgbnVtYmVyLFxuICAgIGJvZHk6IGRhdGEuYm9keSBhcyBzdHJpbmcsXG4gICAgYXV0aG9yOiB7IGxvZ2luOiBkYXRhLmF1dGhvci5sb2dpbiBhcyBzdHJpbmcgfSxcbiAgICBjcmVhdGVkQXQ6IGRhdGEuY3JlYXRlZEF0IGFzIHN0cmluZyxcbiAgICByZWFjdGlvbnM6IHsgXCIrMVwiOiB0aHVtYnNVcCwgZXllcywgY29uZnVzZWQgfSxcbiAgfTtcblxuICByZXR1cm4gb2sodmFsaWRhdGVkKTtcbn1cblxuLy8gLS0tIENvbW1lbnRzIGFycmF5IHZhbGlkYXRpb24gLS0tXG5cbi8qKlxuICogVmFsaWRhdGUgdW5rbm93biBkYXRhIGFzIGFuIGFycmF5IG9mIEdoQ29tbWVudEpzb24uXG4gKlxuICogQHBhcmFtIGRhdGEgLSBVbmtub3duIGRhdGEgKHR5cGljYWxseSBmcm9tIEpTT04ucGFyc2UpXG4gKiBAcmV0dXJucyBWYWxpZGF0ZWQgR2hDb21tZW50SnNvbiBhcnJheSBvciBhIFZhbGlkYXRpb25FcnJvclxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVHaENvbW1lbnRzSnNvbihcbiAgZGF0YTogdW5rbm93bixcbik6IFZhbGlkYXRpb25SZXN1bHQ8R2hDb21tZW50SnNvbltdPiB7XG4gIGlmICghQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgIHJldHVybiBmYWlsKFwicm9vdFwiLCBgRXhwZWN0ZWQgYXJyYXksIGdvdCAke3R5cGVvZiBkYXRhfWApO1xuICB9XG5cbiAgY29uc3QgcmVzdWx0OiBHaENvbW1lbnRKc29uW10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBkYXRhLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgY29tbWVudFJlc3VsdCA9IHZhbGlkYXRlR2hDb21tZW50SnNvbihkYXRhW2ldKTtcbiAgICBpZiAoIWNvbW1lbnRSZXN1bHQub2spIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBgY29tbWVudHNbJHtpfV0uJHtjb21tZW50UmVzdWx0LmVycm9yLmZpZWxkfWAsXG4gICAgICAgIGNvbW1lbnRSZXN1bHQuZXJyb3IubWVzc2FnZSxcbiAgICAgICk7XG4gICAgfVxuICAgIHJlc3VsdC5wdXNoKGNvbW1lbnRSZXN1bHQudmFsdWUpO1xuICB9XG5cbiAgcmV0dXJuIG9rKHJlc3VsdCk7XG59XG5cbi8vIC0tLSBDb25maWdGaWxlIHZhbGlkYXRpb24gLS0tXG5cbi8qKlxuICogVmFsaWRhdGUgdW5rbm93biBkYXRhIGFzIGEgQ29uZmlnRmlsZSBzdHJ1Y3R1cmUuXG4gKiBBbGwgZmllbGRzIGFyZSBvcHRpb25hbCwgYnV0IHRob3NlIHByZXNlbnQgbXVzdCBoYXZlIGNvcnJlY3QgdHlwZXMuXG4gKlxuICogQHBhcmFtIGRhdGEgLSBVbmtub3duIGRhdGEgKHR5cGljYWxseSBmcm9tIEpTT04ucGFyc2UpXG4gKiBAcmV0dXJucyBWYWxpZGF0ZWQgQ29uZmlnRmlsZUpzb24gb3IgYSBWYWxpZGF0aW9uRXJyb3JcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlQ29uZmlnRmlsZUpzb24oXG4gIGRhdGE6IHVua25vd24sXG4pOiBWYWxpZGF0aW9uUmVzdWx0PENvbmZpZ0ZpbGVKc29uPiB7XG4gIGlmICghaXNPYmplY3QoZGF0YSkpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwicm9vdFwiLFxuICAgICAgYEV4cGVjdGVkIG9iamVjdCwgZ290ICR7ZGF0YSA9PT0gbnVsbCA/IFwibnVsbFwiIDogdHlwZW9mIGRhdGF9YCxcbiAgICApO1xuICB9XG5cbiAgLy8gQSBrZXkgdGhpcyB3b3JrZXIgdXNlZCB0byBob25vdXIgYW5kIG5vIGxvbmdlciBkb2VzIG11c3QgZmFpbCBsb3VkbHk6XG4gIC8vIGlnbm9yaW5nIGl0IHdvdWxkIGxlYXZlIHRoZSBvcGVyYXRvciB3aXRoIGEgc2V0dGluZyB0aGF0IHJlYWRzIGFzIGxpdmVcbiAgLy8gYW5kIGRvZXMgbm90aGluZyAoSXNzdWUgIzgwNSkuXG4gIGNvbnN0IHN0YWxlID0gWy4uLlJFTU9WRURfQ09ORklHX0tFWVMua2V5cygpXS5maWx0ZXIoKGtleSkgPT5cbiAgICBkYXRhW2tleV0gIT09IHVuZGVmaW5lZFxuICApO1xuICBpZiAoc3RhbGUubGVuZ3RoID4gMCkge1xuICAgIC8vIE9uZSBtZXNzYWdlIGZvciB0aGUgd2hvbGUgbWlncmF0aW9uIOKAlCBmaXhpbmcgb25lIGtleSBhbmQgcmVkaXNjb3ZlcmluZ1xuICAgIC8vIHRoZSBuZXh0IG9uIHRoZSBmb2xsb3dpbmcgc3RhcnQgaXMgbm90IGFjdGlvbmFibGUuXG4gICAgY29uc3QgZ3VpZGFuY2UgPSBbXG4gICAgICAuLi5uZXcgU2V0KHN0YWxlLm1hcCgoa2V5KSA9PiBSRU1PVkVEX0NPTkZJR19LRVlTLmdldChrZXkpISkpLFxuICAgIF07XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBzdGFsZS5qb2luKFwiLCBcIiksXG4gICAgICBgJHtzdGFsZS5tYXAoKGtleSkgPT4gYFwiJHtrZXl9XCJgKS5qb2luKFwiIGFuZCBcIil9ICR7XG4gICAgICAgIHN0YWxlLmxlbmd0aCA9PT0gMSA/IFwid2FzXCIgOiBcIndlcmVcIlxuICAgICAgfSByZW1vdmVkLiAke2d1aWRhbmNlLmpvaW4oXCIgXCIpfWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIE9wdGlvbmFsIHN0cmluZyBmaWVsZHNcbiAgLy8gSXNzdWUgIzE4MzQ6IGB3b3JrX29uX2xhYmVsYCBhbmQgYGxvd19wcmlvcml0eV9sYWJlbGAgcmVtb3ZlZCDigJQgdGhlXG4gIC8vIHRocmVlIGRpc2NvdmVyeSBsYWJlbHMgYXJlIGhhcmR3aXJlZCBhbmQgbm90IGNvbmZpZ3VyYWJsZS5cbiAgY29uc3Qgc3RyaW5nRmllbGRzID0gW1xuICAgIFwiZmFpbGVkX29uY2VfbGFiZWxcIixcbiAgICBcImZhaWxlZF9sYWJlbFwiLFxuICAgIFwicmVmaW5lX2lzc3VlX2xhYmVsXCIsXG4gICAgXCJwbGFubmluZ19sYWJlbFwiLFxuICAgIFwicXVlc3Rpb25fbGFiZWxcIixcbiAgICBcIm5lZWRzX3JldmlzaW9uX2xhYmVsXCIsXG4gICAgXCJuZWVkc19odW1hbl9sYWJlbFwiLFxuICAgIFwicnVuX21vZGVcIixcbiAgICAvLyBVcGRhdGUgbW9kZSBhbmQgdGhlIGNoZWNrb3V0IHBpbiAoSXNzdWUgIzYyMikuIFRoZSBhY2NlcHRlZCB2YWx1ZXMgYW5kXG4gICAgLy8gdGhlIGZyb3plbi1tb2RlIHJ1bGVzIGFyZSBlbmZvcmNlZCBieSBgdmFsaWRhdGVVcGRhdGVNb2RlU2V0dGluZ3NgO1xuICAgIC8vIGhlcmUgb25seSB0aGUgSlNPTiB0eXBlIGlzIGNoZWNrZWQuXG4gICAgXCJ1cGRhdGVfbW9kZVwiLFxuICAgIFwicGlubmVkX3JlZlwiLFxuICAgIFwiYWdlbnRfcHJvdmlkZXJfbW9kZVwiLFxuICAgIFwiYWdlbnRfcHJvdmlkZXJcIixcbiAgICBcImNsYXVkZV9tb2RlbFwiLFxuICAgIFwiYmVzdF9wbGFubmluZ19tb2RlbFwiLFxuICAgIFwid29ya2VyX25hbWVcIixcbiAgICBcInNzaF9rZXlfcGF0aFwiLFxuICAgIFwiZ2hfY29uZmlnX2RpclwiLFxuICAgIExPR19ESVJfQ09ORklHX0tFWSxcbiAgICBcImltZ2JiX2FwaV9rZXlcIixcbiAgICBcImdpdGh1Yl9hcHBfaWRcIixcbiAgICBcImdpdGh1Yl9hcHBfaW5zdGFsbGF0aW9uX2lkXCIsXG4gICAgXCJnaXRodWJfYXBwX3ByaXZhdGVfa2V5X3BhdGhcIixcbiAgICBcInZlcmJvc2l0eVwiLFxuICAgIFwiZXhjbHVzaW9uX3RlYW1cIixcbiAgXSBhcyBjb25zdDtcblxuICBmb3IgKGNvbnN0IGZpZWxkIG9mIHN0cmluZ0ZpZWxkcykge1xuICAgIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlT3B0aW9uYWxTdHJpbmcoZGF0YVtmaWVsZF0sIGZpZWxkKTtcbiAgICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHJlc3VsdCBhcyBWYWxpZGF0aW9uUmVzdWx0PG5ldmVyPjtcbiAgfVxuXG4gIC8vIHJ1bl9tb2RlIGFjY2VwdHMgb25seSBjb250YWluZXIgKElzc3VlcyAjNDE0NiwgIzQpIOKAlCBhIHR5cG8gbXVzdCBmYWlsXG4gIC8vIGhlcmUgcmF0aGVyIHRoYW4gYmUgY29lcmNlZCB0byB0aGUgZGVmYXVsdCAoSXNzdWUgIzMyMzQpLCBhbmQgYSByZW1vdmVkXG4gIC8vIG1vZGUgKG5hdGl2ZSwgc2VhdGJlbHQpIGlzIG5hbWVkIGFzIHJlbW92ZWQgc28gdGhlIG9wZXJhdG9yIGxlYXJucyB3aHkuXG4gIGlmIChcbiAgICBkYXRhW1JVTl9NT0RFX0NPTkZJR19LRVldICE9PSB1bmRlZmluZWQgJiZcbiAgICAhaXNSdW5Nb2RlKGRhdGFbUlVOX01PREVfQ09ORklHX0tFWV0pXG4gICkge1xuICAgIGNvbnN0IHJhdyA9IGRhdGFbUlVOX01PREVfQ09ORklHX0tFWV07XG4gICAgaWYgKHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgJiYgUkVNT1ZFRF9SVU5fTU9ERVMuaW5jbHVkZXMocmF3LnRyaW0oKSkpIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBSVU5fTU9ERV9DT05GSUdfS0VZLFxuICAgICAgICBgUnVuIG1vZGUgJHtKU09OLnN0cmluZ2lmeShyYXcpfSB3YXMgcmVtb3ZlZCAoSXNzdWUgIzQpOiBjb250YWlubWVudCBgICtcbiAgICAgICAgICBgaXMgbWFuZGF0b3J5LCB0aGUgd29ya2VyIHJ1bnMgb25seSBpbnNpZGUgdGhlIGNvbnRhaW5lci4gUmVtb3ZlIGAgK1xuICAgICAgICAgIGB0aGUga2V5LmAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFJVTl9NT0RFX0NPTkZJR19LRVksXG4gICAgICBgRXhwZWN0ZWQgb25lIG9mICR7UlVOX01PREVTLmpvaW4oXCIsIFwiKX0sIGdvdCAke0pTT04uc3RyaW5naWZ5KHJhdyl9YCxcbiAgICApO1xuICB9XG5cbiAgaWYgKFxuICAgIGRhdGEuYWdlbnRfcHJvdmlkZXJfbW9kZSAhPT0gdW5kZWZpbmVkICYmXG4gICAgZGF0YS5hZ2VudF9wcm92aWRlcl9tb2RlICE9PSBcInBpbm5lZFwiICYmXG4gICAgZGF0YS5hZ2VudF9wcm92aWRlcl9tb2RlICE9PSBcImF1dG9cIlxuICApIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwiYWdlbnRfcHJvdmlkZXJfbW9kZVwiLFxuICAgICAgYEV4cGVjdGVkIG9uZSBvZiBwaW5uZWQsIGF1dG8sIGdvdCAke1xuICAgICAgICBKU09OLnN0cmluZ2lmeShkYXRhLmFnZW50X3Byb3ZpZGVyX21vZGUpXG4gICAgICB9YCxcbiAgICApO1xuICB9XG5cbiAgLy8gbG9nX2RpciBtdXN0IGJlIGEgcGF0aCBhIGxhdW5jaGVyIGNhbiBhY3Qgb24gKElzc3VlICM4NzMpLiBBIHJlbGF0aXZlXG4gIC8vIHZhbHVlIHJlc29sdmVzIGFnYWluc3Qgd2hpY2hldmVyIGRpcmVjdG9yeSBlYWNoIGxhdW5jaGVyIHdhcyBzdGFydGVkIGluLFxuICAvLyBzbyB0aGUgbG9ncyB3b3VsZCBzcGxpdCBhY3Jvc3MgZGlyZWN0b3JpZXMg4oCUIGV4YWN0bHkgd2hhdCB0aGlzIGtleSBleGlzdHNcbiAgLy8gdG8gcHJldmVudC4gUmVmdXNlZCBoZXJlLCB3aGVyZSB0aGUgb3BlcmF0b3IgaXMgdG9sZCB3aGljaCBrZXkgaXMgd3JvbmcuXG4gIGlmIChkYXRhW0xPR19ESVJfQ09ORklHX0tFWV0gIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHJhdyA9IGRhdGFbTE9HX0RJUl9DT05GSUdfS0VZXSBhcyBzdHJpbmc7XG4gICAgY29uc3Qgc3RhdGVkID0gcmF3LnRyaW0oKTtcbiAgICBjb25zdCBhbmNob3JlZCA9IHN0YXRlZCA9PT0gXCJ+XCIgfHwgc3RhdGVkLnN0YXJ0c1dpdGgoXCJ+L1wiKSB8fFxuICAgICAgc3RhdGVkLnN0YXJ0c1dpdGgoXCJ+XFxcXFwiKTtcbiAgICBpZiAoXG4gICAgICBzdGF0ZWQgIT09IFwiXCIgJiYgIWFuY2hvcmVkICYmXG4gICAgICAhaXNBYnNvbHV0ZVBhdGgoc3RhdGVkLCBwYXRoU3R5bGVGb3Ioc3RhdGVkKSlcbiAgICApIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBMT0dfRElSX0NPTkZJR19LRVksXG4gICAgICAgIGBFeHBlY3RlZCBhbiBhYnNvbHV0ZSBwYXRoIG9yIG9uZSBzdGFydGluZyB3aXRoIFwifi9cIiwgZ290ICR7XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkocmF3KVxuICAgICAgICB9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gZXhjbHVzaW9uX3RlYW0gbXVzdCBiZSBvcmcvc2x1ZyB3aGVuIHByZXNlbnQgKElzc3VlICMyNTIpLiBBIHR5cG8gdGhhdFxuICAvLyBzaWxlbnRseSBkaXNhYmxlcyB0ZWFtIGV4Y2x1c2lvbiBpcyB0aGUgZmFpbHVyZSBtb2RlIHRoaXMgcmVqZWN0cy5cbiAgaWYgKGRhdGEuZXhjbHVzaW9uX3RlYW0gIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghRVhDTFVTSU9OX1RFQU1fUEFUVEVSTi50ZXN0KGRhdGEuZXhjbHVzaW9uX3RlYW0gYXMgc3RyaW5nKSkge1xuICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgIFwiZXhjbHVzaW9uX3RlYW1cIixcbiAgICAgICAgYEV4cGVjdGVkIG9yZy9zbHVnIChlLmcuIHN0U29mdHdhcmVBVS92aWJlLXdvcmtlcnMpLCBnb3QgJHtcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeShkYXRhLmV4Y2x1c2lvbl90ZWFtKVxuICAgICAgICB9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gZmxlZXRfcnVuX2FyY2hpdmUgbXVzdCBiZSBhbiBvd25lci9yZXBvIHNsdWcgd2hlbiBwcmVzZW50IChJc3N1ZSAjMjkzMCk6XG4gIC8vIG1lYXN1cmVtZW50IGlzc3VlcyB0cmVhdCBpdCBhcyBhIHJlcG9zaXRvcnkgdG8gcmVhZCwgc28gYSB0eXBvIG9yIGFcbiAgLy8gaG9zdGlsZSB2YWx1ZSBtdXN0IGZhaWwgbG91ZGx5IHJhdGhlciB0aGFuIGJlIHVzZWQgYXMtaXMuXG4gIGlmIChkYXRhLmZsZWV0X3J1bl9hcmNoaXZlICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCByYXcgPSBkYXRhLmZsZWV0X3J1bl9hcmNoaXZlO1xuICAgIGNvbnN0IHRyaW1tZWQgPSB0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3LnRyaW0oKSA6IHJhdztcbiAgICBpZiAoIWlzVmFsaWRSZXBvU2x1Zyh0cmltbWVkKSkge1xuICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgIFwiZmxlZXRfcnVuX2FyY2hpdmVcIixcbiAgICAgICAgYEV4cGVjdGVkIGFuIG93bmVyL3JlcG8gc2x1ZywgZ290ICR7cmVuZGVySW5lcnRSZXBvU2x1ZyhyYXcpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8vIHN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uX2xhYmVsIGlzIGFuIG9wZXJhdG9yIGxhYmVsIChJc3N1ZSAjMzcxOCkuIFRoZVxuICAvLyBsZWRnZXIgb3ducyB0aGUgbGFiZWwgcnVsZS4gVGhlIG1lc3NhZ2UgbmV2ZXIgZWNob2VzIHRoZSB2YWx1ZSwgd2hpY2hcbiAgLy8gY291bGQgYmUgYW4gYWNjb3VudCBlbWFpbC4gV2hpdGVzcGFjZSBpcyBpbnZhbGlkIChJc3N1ZSAjMzc1MikuXG4gIGlmIChkYXRhLnN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uX2xhYmVsICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCByYXcgPSBkYXRhLnN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uX2xhYmVsO1xuICAgIGlmICghaXNWYWxpZExpZmVjeWNsZUxhYmVsKHJhdykpIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBcInN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uX2xhYmVsXCIsXG4gICAgICAgIFwiRXhwZWN0ZWQgYW4gb3BlcmF0b3IgbGFiZWwgb2YgbG93ZXJjYXNlIGxldHRlcnMsIGRpZ2l0cywgJy4nLCAnXycgb3IgJy0nIChhdCBtb3N0IDY0IGNoYXJhY3RlcnMpIOKAlCBuZXZlciBhbiBhY2NvdW50IGVtYWlsLCBJRCBvciBmZWVcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gT3B0aW9uYWwgc3RyaW5nIGFycmF5IGZpZWxkc1xuICAvLyBJc3N1ZSAjMTgzNDogYGlzc3VlX2xhYmVsc2AgcmVtb3ZlZCDigJQgdGhlIHRocmVlIGRpc2NvdmVyeSBsYWJlbHMgYXJlXG4gIC8vIGhhcmR3aXJlZCBhbmQgbm90IGNvbmZpZ3VyYWJsZS5cbiAgY29uc3QgYXJyYXlGaWVsZHMgPSBbXG4gICAgXCJhbGxvd2VkX2F1dGhvcnNcIixcbiAgICBcInByX3Jldmlld2Vyc1wiLFxuICAgIFwicmVwb3NcIixcbiAgICBcImF1dGhvcml6ZWRfY29tbWVudGVyc1wiLFxuICAgIFwidHJ1c3RlZF9yZXZpZXdfYm90c1wiLFxuICAgIFwiYWdlbnRfcHJvdmlkZXJzXCIsXG4gICAgXCJhZ2VudF9wcm92aWRlcl9mYWxsYmFja1wiLFxuICAgIFwiY2xhdWRlX3dlZWtfcGFjZV9kcmFpblwiLFxuICAgIC8vIExvbmctam9iIGxhYmVscyBmb3IgdGhlIGFkYXB0aXZlIGNsYWltIGZsb29yIChJc3N1ZSAjMjQ1KS5cbiAgICBcImNsYWltX2xvbmdfam9iX2xhYmVsc1wiLFxuICBdIGFzIGNvbnN0O1xuXG4gIGZvciAoY29uc3QgZmllbGQgb2YgYXJyYXlGaWVsZHMpIHtcbiAgICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZU9wdGlvbmFsU3RyaW5nQXJyYXkoZGF0YVtmaWVsZF0sIGZpZWxkKTtcbiAgICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHJlc3VsdCBhcyBWYWxpZGF0aW9uUmVzdWx0PG5ldmVyPjtcbiAgfVxuXG4gIC8vIE9wdGlvbmFsIG51bWJlciBmaWVsZHMgKElzc3VlICMyNzcg4oCUIG9wZXJhdGlvbmFsIHNldHRpbmdzKVxuICBjb25zdCBudW1iZXJGaWVsZHMgPSBbXG4gICAgXCJjbGF1ZGVfdGltZW91dFwiLFxuICAgIFwibWluX2NsYWltX3J1bndheV9zZWNvbmRzXCIsXG4gICAgXCJydW5fZmluaXNoX3NlY29uZHNcIixcbiAgICBcImNsYXVkZV9raWxsX2FmdGVyXCIsXG4gICAgXCJtYXhfY2xhcmlmaWNhdGlvbl9yb3VuZHNcIixcbiAgICBcInNsZWVwX2ludGVydmFsXCIsXG4gICAgXCJjcmVkaXRfd2FpdF9pbnRlcnZhbFwiLFxuICAgIFwicmVmaW5lbWVudF90aW1lb3V0XCIsXG4gICAgXCJyZWZpbmVtZW50X2tpbGxfYWZ0ZXJcIixcbiAgICBcInBsYW5uaW5nX3RpbWVvdXRcIixcbiAgICBcInBsYW5uaW5nX2tpbGxfYWZ0ZXJcIixcbiAgICBcInF1ZXN0aW9uX3RpbWVvdXRcIixcbiAgICBcInF1ZXN0aW9uX2tpbGxfYWZ0ZXJcIixcbiAgICBcImNsYXJpZmljYXRpb25fdGltZW91dFwiLFxuICAgIFwiY2xhcmlmaWNhdGlvbl9raWxsX2FmdGVyXCIsXG4gICAgXCJtYXhfcmF0ZV9saW1pdF9yZXRyaWVzXCIsXG4gICAgXCJtYXhfcmF0ZV9saW1pdF93YWl0XCIsXG4gICAgXCJyZXRyeV9tYXhfZGVsYXlcIixcbiAgICBcIm1heF9pc3N1ZV9ib2R5X3Rva2Vuc1wiLFxuICAgIFwic3VtbWFyaXNlX3RpbWVvdXRcIixcbiAgICBcInN1bW1hcmlzZV9raWxsX2FmdGVyXCIsXG4gICAgXCJmZWF0dXJlX2NoZWNrX3RpbWVvdXRcIixcbiAgICBcImNsYXVkZV9ub19vdXRwdXRfdGltZW91dFwiLFxuICAgIFwicXVhbGl0eV9jaGVja190aW1lb3V0XCIsXG4gICAgXCJoZWFsdGhfY2FjaGVfdHRsXCIsXG4gICAgXCJsb2dfbWF4X3NpemVfbWJcIixcbiAgICBcImxvZ19tYXhfcm90YXRpb25zXCIsXG4gICAgXCJzdHVja19pc3N1ZV90aW1lb3V0XCIsXG4gICAgXCJpc3N1ZV9yZXRyeV9jb29sZG93blwiLFxuICAgIFwibWluX2Rpc2tfc3BhY2VfbWJcIixcbiAgICBcImhvc3RfZGlza19sb3dfZmxvb3JfZ2JcIixcbiAgICBcImhvc3RfZGlza19sb3dfZmxvb3JfcGVyY2VudFwiLFxuICAgIFwic3RhbGVfZmFpbGVkX2RpYWdub3N0aWNfZGF5c1wiLFxuICAgIFwic3RhbGVfcGxhbm5pbmdfd2FybmluZ19kYXlzXCIsXG4gICAgXCJmYXN0X2ZhaWx1cmVfc2Vjb25kc1wiLFxuICAgIFwicmVwb19mYXN0X2ZhaWx1cmVfdGhyZXNob2xkXCIsXG4gICAgXCJyZXBvX2Zhc3RfZmFpbHVyZV93aW5kb3dfaG91cnNcIixcbiAgICBcImNvbnRleHRfYnVkZ2V0X3dhcm5pbmdfcGVyY2VudFwiLFxuICAgIFwiY29udGV4dF9idWRnZXRfZXJyb3JfcGVyY2VudFwiLFxuICAgIFwiY29udGV4dF9idWRnZXRfYmxvY2tfcGVyY2VudFwiLFxuICBdIGFzIGNvbnN0O1xuXG4gIGZvciAoY29uc3QgZmllbGQgb2YgbnVtYmVyRmllbGRzKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVPcHRpb25hbE51bWJlcihkYXRhW2ZpZWxkXSwgZmllbGQpO1xuICAgIGlmICghcmVzdWx0Lm9rKSByZXR1cm4gcmVzdWx0IGFzIFZhbGlkYXRpb25SZXN1bHQ8bmV2ZXI+O1xuICB9XG5cbiAgLy8gT3B0aW9uYWwgYm9vbGVhbiBmaWVsZHMgKElzc3VlICM0MzUpXG4gIGNvbnN0IGJvb2xlYW5GaWVsZHMgPSBbXG4gICAgXCJzaHVmZmxlX3JlcG9zXCIsXG4gICAgXCJ1cGRhdGVfZ2hfdXNlcl9zdGF0dXNcIixcbiAgICBcImVuYWJsZV9tb2RlbF9mYWxsYmFja1wiLFxuICAgIFwic3luY19taWxlc3RvbmVfYnJhbmNoZXNcIixcbiAgICBcImVuYWJsZV9zZXNzaW9uX3Jlc3VtZVwiLFxuICAgIC8vIEhvc3Qtd2lkZSBpc3N1ZS1leGVjdXRvciBzcGxpdCAoSXNzdWUgIzIzNDEpLlxuICAgIFwiaXNzdWVfZXhlY3V0b3Jfc3BsaXRcIixcbiAgICAvLyBIb3N0LXdpZGUgcmV2aWV3ZXIgc3ViLWFnZW50cyAoSXNzdWUgIzI1NzUpLlxuICAgIFwiaXNzdWVfcmV2aWV3ZXJfYWdlbnRzXCIsXG4gICAgLy8gRHJhaW4gdGhlIGhlbGQgQ2xhdWRlIHRva2VuIHRvIHplcm8gKElzc3VlICMyNDc0KS5cbiAgICBcImNsYXVkZV93ZWVrX3BhY2VfZHJhaW5cIixcbiAgXSBhcyBjb25zdDtcblxuICBmb3IgKGNvbnN0IGZpZWxkIG9mIGJvb2xlYW5GaWVsZHMpIHtcbiAgICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZU9wdGlvbmFsQm9vbGVhbihkYXRhW2ZpZWxkXSwgZmllbGQpO1xuICAgIGlmICghcmVzdWx0Lm9rKSByZXR1cm4gcmVzdWx0IGFzIFZhbGlkYXRpb25SZXN1bHQ8bmV2ZXI+O1xuICB9XG5cbiAgLy8gcGlubmVkX3Rvb2xfdmVyc2lvbnMgaXMgYW4gb2JqZWN0IG9mIHRvb2wg4oaSIGV4YWN0IHZlcnNpb24gc3RyaW5nXG4gIC8vIChJc3N1ZSAjNjIyKS4gT25seSB0aGUgc2hhcGUgaXMgY2hlY2tlZCBoZXJlOyB3aGV0aGVyIHRoZSB2ZXJzaW9ucyBhcmVcbiAgLy8gcHJlc2VudCBhbmQgdXNhYmxlIGlzIGB2YWxpZGF0ZVVwZGF0ZU1vZGVTZXR0aW5nc2AncyBjYWxsLlxuICBpZiAoZGF0YS5waW5uZWRfdG9vbF92ZXJzaW9ucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFpc09iamVjdChkYXRhLnBpbm5lZF90b29sX3ZlcnNpb25zKSkge1xuICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgIFwicGlubmVkX3Rvb2xfdmVyc2lvbnNcIixcbiAgICAgICAgYEV4cGVjdGVkIG9iamVjdCwgZ290ICR7XG4gICAgICAgICAgZGF0YS5waW5uZWRfdG9vbF92ZXJzaW9ucyA9PT0gbnVsbFxuICAgICAgICAgICAgPyBcIm51bGxcIlxuICAgICAgICAgICAgOiB0eXBlb2YgZGF0YS5waW5uZWRfdG9vbF92ZXJzaW9uc1xuICAgICAgICB9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGZvciAoXG4gICAgICBjb25zdCBbdG9vbCwgdmVyc2lvbl0gb2YgT2JqZWN0LmVudHJpZXMoZGF0YS5waW5uZWRfdG9vbF92ZXJzaW9ucylcbiAgICApIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlT3B0aW9uYWxTdHJpbmcoXG4gICAgICAgIHZlcnNpb24sXG4gICAgICAgIGBwaW5uZWRfdG9vbF92ZXJzaW9ucy4ke3Rvb2x9YCxcbiAgICAgICk7XG4gICAgICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHJlc3VsdCBhcyBWYWxpZGF0aW9uUmVzdWx0PG5ldmVyPjtcbiAgICB9XG4gIH1cblxuICAvLyByZXBvX2NvbmZpZyBpcyBvcHRpb25hbCBhbmQgbG9vc2VseSB0eXBlZCAodmFsaWRhdGVkIGVsc2V3aGVyZSlcbiAgaWYgKGRhdGEucmVwb19jb25maWcgIT09IHVuZGVmaW5lZCAmJiAhaXNPYmplY3QoZGF0YS5yZXBvX2NvbmZpZykpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwicmVwb19jb25maWdcIixcbiAgICAgIGBFeHBlY3RlZCBvYmplY3QsIGdvdCAke3R5cGVvZiBkYXRhLnJlcG9fY29uZmlnfWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIFBlci1waGFzZSByb3V0aW5nIG92ZXJyaWRlcyBhcmUgb3B0aW9uYWwgUmVjb3JkPHN0cmluZywgc3RyaW5nPiBtYXBzIOKAlFxuICAvLyBDbGF1ZGUncyAoSXNzdWVzICMxMjY1LCAjMTQwMyksIENvZGV4J3MgKElzc3VlICMzNjMpLCBHZW1pbmknc1xuICAvLyAoSXNzdWUgIzM2NCwgbW9kZWwgb25seSkgYW5kIERlZXBTZWVrJ3MgKElzc3VlICM0MTMsIG1vZGVsIG9ubHkpLlxuICBjb25zdCBwaGFzZU92ZXJyaWRlRmllbGRzID0gW1xuICAgIFwicGhhc2VfbW9kZWxfb3ZlcnJpZGVzXCIsXG4gICAgXCJwaGFzZV9lZmZvcnRfb3ZlcnJpZGVzXCIsXG4gICAgXCJjb2RleF9waGFzZV9tb2RlbF9vdmVycmlkZXNcIixcbiAgICBcImNvZGV4X3BoYXNlX2VmZm9ydF9vdmVycmlkZXNcIixcbiAgICBcImdlbWluaV9waGFzZV9tb2RlbF9vdmVycmlkZXNcIixcbiAgICBcImRlZXBzZWVrX3BoYXNlX21vZGVsX292ZXJyaWRlc1wiLFxuICBdIGFzIGNvbnN0O1xuXG4gIGZvciAoY29uc3QgZmllbGQgb2YgcGhhc2VPdmVycmlkZUZpZWxkcykge1xuICAgIGNvbnN0IHZhbHVlID0gZGF0YVtmaWVsZF07XG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGlmICghaXNPYmplY3QodmFsdWUpKSB7XG4gICAgICByZXR1cm4gZmFpbChmaWVsZCwgYEV4cGVjdGVkIG9iamVjdCwgZ290ICR7dHlwZW9mIHZhbHVlfWApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUpKSB7XG4gICAgICBpZiAodHlwZW9mIHZhbCAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgICByZXR1cm4gZmFpbChgJHtmaWVsZH0uJHtrZXl9YCwgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIHZhbH1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBpZGxlX3Rhc2tfdGVtcGxhdGVfd2VpZ2h0cyBpcyBvcHRpb25hbCBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+IChJc3N1ZSAjMjQwMSlcbiAgaWYgKGRhdGEuaWRsZV90YXNrX3RlbXBsYXRlX3dlaWdodHMgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghaXNPYmplY3QoZGF0YS5pZGxlX3Rhc2tfdGVtcGxhdGVfd2VpZ2h0cykpIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBcImlkbGVfdGFza190ZW1wbGF0ZV93ZWlnaHRzXCIsXG4gICAgICAgIGBFeHBlY3RlZCBvYmplY3QsIGdvdCAke3R5cGVvZiBkYXRhLmlkbGVfdGFza190ZW1wbGF0ZV93ZWlnaHRzfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoZGF0YS5pZGxlX3Rhc2tfdGVtcGxhdGVfd2VpZ2h0cykpIHtcbiAgICAgIGlmICh0eXBlb2YgdmFsICE9PSBcIm51bWJlclwiKSB7XG4gICAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICAgIGBpZGxlX3Rhc2tfdGVtcGxhdGVfd2VpZ2h0cy4ke2tleX1gLFxuICAgICAgICAgIGBFeHBlY3RlZCBudW1iZXIsIGdvdCAke3R5cGVvZiB2YWx9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBzb2Z0d2FyZV9taW5fdmVyc2lvbnMgaXMgb3B0aW9uYWwgUmVjb3JkPHN0cmluZywgc3RyaW5nPiAoSXNzdWUgIzI2MjIpXG4gIGlmIChkYXRhLnNvZnR3YXJlX21pbl92ZXJzaW9ucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFpc09iamVjdChkYXRhLnNvZnR3YXJlX21pbl92ZXJzaW9ucykpIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBcInNvZnR3YXJlX21pbl92ZXJzaW9uc1wiLFxuICAgICAgICBgRXhwZWN0ZWQgb2JqZWN0LCBnb3QgJHt0eXBlb2YgZGF0YS5zb2Z0d2FyZV9taW5fdmVyc2lvbnN9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgW2tleSwgdmFsXSBvZiBPYmplY3QuZW50cmllcyhkYXRhLnNvZnR3YXJlX21pbl92ZXJzaW9ucykpIHtcbiAgICAgIGlmICh0eXBlb2YgdmFsICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICAgIGBzb2Z0d2FyZV9taW5fdmVyc2lvbnMuJHtrZXl9YCxcbiAgICAgICAgICBgRXhwZWN0ZWQgc3RyaW5nLCBnb3QgJHt0eXBlb2YgdmFsfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gY3VzdG9tX2xhYmVsX3Byb21wdHMgaXMgb3B0aW9uYWwgYW5kIG11c3QgYmUgYW4gYXJyYXkgb2Ygb2JqZWN0cyB3aGVuXG4gIC8vIHByZXNlbnQgKElzc3VlICM4NDYpLiBGaWVsZC1sZXZlbCBjaGVja3MgaGFwcGVuIGluXG4gIC8vIHBhcnNlQ3VzdG9tTGFiZWxQcm9tcHRzKCkvYXNzZXJ0Q3VzdG9tTGFiZWxQcm9tcHRzKCkg4oCUIHRoaXMgaXMgb25seSB0aGVcbiAgLy8gc2hhbGxvdyBKU09OLXNoYXBlIGdhdGUgZXZlcnkgb3RoZXIgY29uZmlnIGtleSBnZXRzIGhlcmUuXG4gIGlmIChkYXRhLmN1c3RvbV9sYWJlbF9wcm9tcHRzICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YS5jdXN0b21fbGFiZWxfcHJvbXB0cykpIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBcImN1c3RvbV9sYWJlbF9wcm9tcHRzXCIsXG4gICAgICAgIGBFeHBlY3RlZCBhcnJheSwgZ290ICR7dHlwZW9mIGRhdGEuY3VzdG9tX2xhYmVsX3Byb21wdHN9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZGF0YS5jdXN0b21fbGFiZWxfcHJvbXB0cy5sZW5ndGg7IGkrKykge1xuICAgICAgaWYgKCFpc09iamVjdChkYXRhLmN1c3RvbV9sYWJlbF9wcm9tcHRzW2ldKSkge1xuICAgICAgICByZXR1cm4gZmFpbChcbiAgICAgICAgICBgY3VzdG9tX2xhYmVsX3Byb21wdHNbJHtpfV1gLFxuICAgICAgICAgIGBFeHBlY3RlZCBvYmplY3QsIGdvdCAke3R5cGVvZiBkYXRhLmN1c3RvbV9sYWJlbF9wcm9tcHRzW2ldfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG9rKGRhdGEgYXMgdW5rbm93biBhcyBDb25maWdGaWxlSnNvbik7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBTaGFyZWQgZ2ggQ0xJIHZhbGlkYXRvcnMgKElzc3VlICMxNTMyKVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vXG4vLyBUaGVzZSB2YWxpZGF0b3JzIGNvdmVyIHRoZSByZW1haW5pbmcgYEpTT04ucGFyc2UoLi4uKSBhcyBUeXBlYCBib3VuZGFyaWVzXG4vLyBpbiB0aGUgRGVubyBsaWJzIHNvIG1hbGZvcm1lZCBnaCBDTEkgb3V0cHV0IHByb2R1Y2VzIGEgdHlwZWQgZXJyb3IgcmF0aGVyXG4vLyB0aGFuIGEgbGF0ZS1iaW5kaW5nIHJ1bnRpbWUgY3Jhc2guIEVhY2ggdmFsaWRhdG9yIHJldHVybnMgYVxuLy8gVmFsaWRhdGlvblJlc3VsdCDigJQgY2FsbGVycyBkZWNpZGUgd2hldGhlciB0byBzdXJmYWNlIHRoZSBlcnJvciBhcyBhXG4vLyBSZXN1bHQgb3IgbG9nLWFuZC1mYWxsYmFjay5cblxuLy8gLS0tIEdpdEh1YiBtaWxlc3RvbmVzIC0tLVxuXG4vKiogTWluaW1hbCBtaWxlc3RvbmUgc2hhcGUgdXNlZCBieSBzeW5jL2NvbXBsZXRpb24vaGVhbHRoIGNoZWNrcy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2l0SHViTWlsZXN0b25lSnNvbiB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIG51bWJlcjogbnVtYmVyO1xuICAvKipcbiAgICogQ2xvc2VkIGlzc3VlICsgUFIgY291bnQgY2FycmllZCBieSB0aGUgUkVTVCBtaWxlc3RvbmUgcGF5bG9hZFxuICAgKiAoSXNzdWUgIzE0ODgpLiBPcHRpb25hbCBhbmQgZGVsaWJlcmF0ZWx5IG5vdCByZXF1aXJlZCBoZXJlOiBhIHBheWxvYWRcbiAgICogYnVpbHQgd2l0aCBgLS1qcWAgbWF5IG9taXQgaXQsIGFuZCBhIGNhbGxlciB0aGF0IGdhdGVzIG9uIGl0IGZhaWxzXG4gICAqIG9wZW4gKHNwZW5kcyB0aGUgcXVlcnkpIGZvciBhbnl0aGluZyB0aGF0IGlzIG5vdCBhIG51bWJlciwgcmF0aGVyXG4gICAqIHRoYW4gcmVqZWN0aW5nIHRoZSB3aG9sZSBsaXN0aW5nIGFuZCBkaXNhYmxpbmcgdGhlIHN3ZWVwLlxuICAgKi9cbiAgY2xvc2VkX2lzc3Vlcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSB1bmtub3duIGRhdGEgYXMgYW4gYXJyYXkgb2YgR2l0SHViIG1pbGVzdG9uZXMuXG4gKlxuICogQHBhcmFtIGRhdGEgLSBVbmtub3duIGRhdGEgKHR5cGljYWxseSBmcm9tIEpTT04ucGFyc2UpXG4gKiBAcmV0dXJucyBWYWxpZGF0ZWQgbWlsZXN0b25lcyBvciBhIFZhbGlkYXRpb25FcnJvclxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVHaXRIdWJNaWxlc3RvbmVzSnNvbihcbiAgZGF0YTogdW5rbm93bixcbik6IFZhbGlkYXRpb25SZXN1bHQ8R2l0SHViTWlsZXN0b25lSnNvbltdPiB7XG4gIGlmICghQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgIHJldHVybiBmYWlsKFwicm9vdFwiLCBgRXhwZWN0ZWQgYXJyYXksIGdvdCAke3R5cGVvZiBkYXRhfWApO1xuICB9XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZGF0YS5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGl0ZW0gPSBkYXRhW2ldO1xuICAgIGlmICghaXNPYmplY3QoaXRlbSkpIHtcbiAgICAgIHJldHVybiBmYWlsKGBtaWxlc3RvbmVzWyR7aX1dYCwgXCJFeHBlY3RlZCBvYmplY3RcIik7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgaXRlbS50aXRsZSAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgIGBtaWxlc3RvbmVzWyR7aX1dLnRpdGxlYCxcbiAgICAgICAgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIGl0ZW0udGl0bGV9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgaXRlbS5udW1iZXIgIT09IFwibnVtYmVyXCIpIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBgbWlsZXN0b25lc1ske2l9XS5udW1iZXJgLFxuICAgICAgICBgRXhwZWN0ZWQgbnVtYmVyLCBnb3QgJHt0eXBlb2YgaXRlbS5udW1iZXJ9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiBvayhkYXRhIGFzIEdpdEh1Yk1pbGVzdG9uZUpzb25bXSk7XG59XG5cbi8vIC0tLSBCcmFuY2ggY29tcGFyZSAobWlsZXN0b25lIGhlYWx0aCkgLS0tXG5cbi8qKiBDbGFzc2lmaWVkIG91dGNvbWUgb2YgYSBHcmFwaFFMIGJyYW5jaCBjb21wYXJlIHF1ZXJ5IChJc3N1ZSAjMzg1NikuICovXG5leHBvcnQgdHlwZSBHcmFwaFFMQnJhbmNoQ29tcGFyZSA9XG4gIHwgeyBraW5kOiBcImVycm9yc1wiOyBtZXNzYWdlczogc3RyaW5nW10gfVxuICB8IHsga2luZDogXCJhYnNlbnRcIiB9XG4gIHwgeyBraW5kOiBcInVuYXZhaWxhYmxlXCIgfVxuICB8IHsga2luZDogXCJjb21wYXJlXCI7IGFoZWFkQnk6IG51bWJlcjsgYmVoaW5kQnk6IG51bWJlciB9O1xuXG4vKipcbiAqIFZhbGlkYXRlIHVua25vd24gYGdoIGFwaSBncmFwaHFsYCBvdXRwdXQgZm9yIGEgYnJhbmNoIGNvbXBhcmUgKElzc3VlICMzODU2KS5cbiAqXG4gKiBOb24tZW1wdHkgYGVycm9yc2Agd2luIG92ZXIgYGRhdGFgLiBBIG51bGwgYHJlZmAgbWVhbnMgdGhlIGJyYW5jaCBpcyBhYnNlbnQ7XG4gKiBhIG51bGwgYGNvbXBhcmVgIG1lYW5zIHRoZSBjb21wYXJpc29uIGlzIHVuYXZhaWxhYmxlLlxuICpcbiAqIEBwYXJhbSBkYXRhIC0gVW5rbm93biBkYXRhICh0eXBpY2FsbHkgZnJvbSBKU09OLnBhcnNlKVxuICogQHJldHVybnMgVGhlIGNsYXNzaWZpZWQgb3V0Y29tZSBvciBhIFZhbGlkYXRpb25FcnJvclxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVHcmFwaFFMQnJhbmNoQ29tcGFyZUpzb24oXG4gIGRhdGE6IHVua25vd24sXG4pOiBWYWxpZGF0aW9uUmVzdWx0PEdyYXBoUUxCcmFuY2hDb21wYXJlPiB7XG4gIGlmICghaXNPYmplY3QoZGF0YSkpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwicm9vdFwiLFxuICAgICAgYEV4cGVjdGVkIG9iamVjdCwgZ290ICR7ZGF0YSA9PT0gbnVsbCA/IFwibnVsbFwiIDogdHlwZW9mIGRhdGF9YCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgZXJyb3JzID0gZGF0YS5lcnJvcnM7XG4gIGlmIChlcnJvcnMgIT09IHVuZGVmaW5lZCAmJiBlcnJvcnMgIT09IG51bGwpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoZXJyb3JzKSkge1xuICAgICAgcmV0dXJuIGZhaWwoXCJlcnJvcnNcIiwgYEV4cGVjdGVkIGFycmF5LCBnb3QgJHt0eXBlb2YgZXJyb3JzfWApO1xuICAgIH1cbiAgICBjb25zdCBtZXNzYWdlczogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGVycm9ycy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgaXRlbSA9IGVycm9yc1tpXTtcbiAgICAgIGlmICghaXNPYmplY3QoaXRlbSkpIHtcbiAgICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgICAgYGVycm9yc1ske2l9XWAsXG4gICAgICAgICAgYEV4cGVjdGVkIG9iamVjdCwgZ290ICR7aXRlbSA9PT0gbnVsbCA/IFwibnVsbFwiIDogdHlwZW9mIGl0ZW19YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgaXRlbS5tZXNzYWdlICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICAgIGBlcnJvcnNbJHtpfV0ubWVzc2FnZWAsXG4gICAgICAgICAgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIGl0ZW0ubWVzc2FnZX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgbWVzc2FnZXMucHVzaChpdGVtLm1lc3NhZ2UpO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZXMubGVuZ3RoID4gMCkge1xuICAgICAgcmV0dXJuIG9rKHsga2luZDogXCJlcnJvcnNcIiwgbWVzc2FnZXMgfSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgcGF5bG9hZCA9IGRhdGEuZGF0YTtcbiAgaWYgKCFpc09iamVjdChwYXlsb2FkKSkge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJkYXRhXCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0LCBnb3QgJHtwYXlsb2FkID09PSBudWxsID8gXCJudWxsXCIgOiB0eXBlb2YgcGF5bG9hZH1gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmVwb3NpdG9yeSA9IHBheWxvYWQucmVwb3NpdG9yeTtcbiAgaWYgKCFpc09iamVjdChyZXBvc2l0b3J5KSkge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJkYXRhLnJlcG9zaXRvcnlcIixcbiAgICAgIGBFeHBlY3RlZCBvYmplY3QsIGdvdCAke1xuICAgICAgICByZXBvc2l0b3J5ID09PSBudWxsID8gXCJudWxsXCIgOiB0eXBlb2YgcmVwb3NpdG9yeVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHJlZiA9IHJlcG9zaXRvcnkucmVmO1xuICAvLyBHcmFwaFFMIHJldHVybnMgZXZlcnkgc2VsZWN0ZWQgZmllbGQsIG51bGwgd2hlbiB1bnJlc29sdmVkOiBvbmx5IGFuXG4gIC8vIGV4cGxpY2l0IG51bGwgbWVhbnMgXCJicmFuY2ggYWJzZW50XCI7IGFuIG9taXR0ZWQga2V5IGlzIG1hbGZvcm1lZC5cbiAgaWYgKHJlZiA9PT0gbnVsbCkge1xuICAgIHJldHVybiBvayh7IGtpbmQ6IFwiYWJzZW50XCIgfSk7XG4gIH1cbiAgaWYgKCFpc09iamVjdChyZWYpKSB7XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBcImRhdGEucmVwb3NpdG9yeS5yZWZcIixcbiAgICAgIGBFeHBlY3RlZCBvYmplY3Qgb3IgbnVsbCwgZ290ICR7dHlwZW9mIHJlZn1gLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBjb21wYXJlID0gcmVmLmNvbXBhcmU7XG4gIGlmIChjb21wYXJlID09PSBudWxsKSB7XG4gICAgcmV0dXJuIG9rKHsga2luZDogXCJ1bmF2YWlsYWJsZVwiIH0pO1xuICB9XG4gIGlmICghaXNPYmplY3QoY29tcGFyZSkpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwiZGF0YS5yZXBvc2l0b3J5LnJlZi5jb21wYXJlXCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0IG9yIG51bGwsIGdvdCAke3R5cGVvZiBjb21wYXJlfWAsXG4gICAgKTtcbiAgfVxuICBpZiAodHlwZW9mIGNvbXBhcmUuYWhlYWRCeSAhPT0gXCJudW1iZXJcIikge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJkYXRhLnJlcG9zaXRvcnkucmVmLmNvbXBhcmUuYWhlYWRCeVwiLFxuICAgICAgYEV4cGVjdGVkIG51bWJlciwgZ290ICR7dHlwZW9mIGNvbXBhcmUuYWhlYWRCeX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKHR5cGVvZiBjb21wYXJlLmJlaGluZEJ5ICE9PSBcIm51bWJlclwiKSB7XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBcImRhdGEucmVwb3NpdG9yeS5yZWYuY29tcGFyZS5iZWhpbmRCeVwiLFxuICAgICAgYEV4cGVjdGVkIG51bWJlciwgZ290ICR7dHlwZW9mIGNvbXBhcmUuYmVoaW5kQnl9YCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIG9rKHtcbiAgICBraW5kOiBcImNvbXBhcmVcIixcbiAgICBhaGVhZEJ5OiBjb21wYXJlLmFoZWFkQnksXG4gICAgYmVoaW5kQnk6IGNvbXBhcmUuYmVoaW5kQnksXG4gIH0pO1xufVxuXG4vKiogQ29tcGFyZSBwYXlsb2FkIGZyb20gdGhlIFJFU1QgYHJlcG9zL3tyZXBvfS9jb21wYXJlLy4uLmAgZW5kcG9pbnQgKElzc3VlICMzODU2KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVzdENvbXBhcmVKc29uIHtcbiAgYWhlYWRfYnk6IG51bWJlcjtcbiAgYmVoaW5kX2J5OiBudW1iZXI7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdW5rbm93biBSRVNUIGNvbXBhcmUgb3V0cHV0IChJc3N1ZSAjMzg1NikuIEV4dHJhIGZpZWxkcyBhcmUgaWdub3JlZC5cbiAqXG4gKiBAcGFyYW0gZGF0YSAtIFVua25vd24gZGF0YSAodHlwaWNhbGx5IGZyb20gSlNPTi5wYXJzZSlcbiAqIEByZXR1cm5zIFZhbGlkYXRlZCBjb3VudHMgb3IgYSBWYWxpZGF0aW9uRXJyb3JcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlUmVzdENvbXBhcmVKc29uKFxuICBkYXRhOiB1bmtub3duLFxuKTogVmFsaWRhdGlvblJlc3VsdDxSZXN0Q29tcGFyZUpzb24+IHtcbiAgaWYgKCFpc09iamVjdChkYXRhKSkge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJyb290XCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0LCBnb3QgJHtkYXRhID09PSBudWxsID8gXCJudWxsXCIgOiB0eXBlb2YgZGF0YX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKHR5cGVvZiBkYXRhLmFoZWFkX2J5ICE9PSBcIm51bWJlclwiKSB7XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBcImFoZWFkX2J5XCIsXG4gICAgICBgRXhwZWN0ZWQgbnVtYmVyLCBnb3QgJHt0eXBlb2YgZGF0YS5haGVhZF9ieX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKHR5cGVvZiBkYXRhLmJlaGluZF9ieSAhPT0gXCJudW1iZXJcIikge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJiZWhpbmRfYnlcIixcbiAgICAgIGBFeHBlY3RlZCBudW1iZXIsIGdvdCAke3R5cGVvZiBkYXRhLmJlaGluZF9ieX1gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG9rKHsgYWhlYWRfYnk6IGRhdGEuYWhlYWRfYnksIGJlaGluZF9ieTogZGF0YS5iZWhpbmRfYnkgfSk7XG59XG5cbi8vIC0tLSBJc3N1ZSBudW1iZXIgbGlzdCAodXNlZCBmb3IgY2xvc2VkIGlzc3VlIGNoZWNrcywgZXRjLikgLS0tXG5cbi8qKlxuICogVmFsaWRhdGUgdW5rbm93biBkYXRhIGFzIGFuIGFycmF5IG9mIGB7IG51bWJlcjogbnVtYmVyIH1gLlxuICpcbiAqIE1hdGNoZXMgZ2ggb3V0cHV0IHdoZXJlIG9ubHkgdGhlIGlzc3VlIG51bWJlciBmaWVsZCB3YXMgcmVxdWVzdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVJc3N1ZU51bWJlckxpc3RKc29uKFxuICBkYXRhOiB1bmtub3duLFxuKTogVmFsaWRhdGlvblJlc3VsdDx7IG51bWJlcjogbnVtYmVyIH1bXT4ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICByZXR1cm4gZmFpbChcInJvb3RcIiwgYEV4cGVjdGVkIGFycmF5LCBnb3QgJHt0eXBlb2YgZGF0YX1gKTtcbiAgfVxuICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGEubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBpdGVtID0gZGF0YVtpXTtcbiAgICBpZiAoIWlzT2JqZWN0KGl0ZW0pKSB7XG4gICAgICByZXR1cm4gZmFpbChgaXRlbXNbJHtpfV1gLCBcIkV4cGVjdGVkIG9iamVjdFwiKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBpdGVtLm51bWJlciAhPT0gXCJudW1iZXJcIikge1xuICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgIGBpdGVtc1ske2l9XS5udW1iZXJgLFxuICAgICAgICBgRXhwZWN0ZWQgbnVtYmVyLCBnb3QgJHt0eXBlb2YgaXRlbS5udW1iZXJ9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiBvayhkYXRhIGFzIHsgbnVtYmVyOiBudW1iZXIgfVtdKTtcbn1cblxuLy8gLS0tIElzc3VlIGxhYmVscyB3cmFwcGVyIC0tLVxuXG4vKiogYHsgbGFiZWxzOiBBcnJheTx7IG5hbWU6IHN0cmluZyB9PiB9YCBzaGFwZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSXNzdWVMYWJlbHNXcmFwcGVySnNvbiB7XG4gIGxhYmVsczogQXJyYXk8eyBuYW1lOiBzdHJpbmcgfT47XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYHsgbGFiZWxzOiBbeyBuYW1lIH1dIH1gIOKAlCB1c2VkIGJ5IGdoIGlzc3VlIHZpZXcgLS1qc29uIGxhYmVscy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlSXNzdWVMYWJlbHNKc29uKFxuICBkYXRhOiB1bmtub3duLFxuKTogVmFsaWRhdGlvblJlc3VsdDxJc3N1ZUxhYmVsc1dyYXBwZXJKc29uPiB7XG4gIGlmICghaXNPYmplY3QoZGF0YSkpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwicm9vdFwiLFxuICAgICAgYEV4cGVjdGVkIG9iamVjdCwgZ290ICR7ZGF0YSA9PT0gbnVsbCA/IFwibnVsbFwiIDogdHlwZW9mIGRhdGF9YCxcbiAgICApO1xuICB9XG4gIGlmICghQXJyYXkuaXNBcnJheShkYXRhLmxhYmVscykpIHtcbiAgICByZXR1cm4gZmFpbChcImxhYmVsc1wiLCBgRXhwZWN0ZWQgYXJyYXksIGdvdCAke3R5cGVvZiBkYXRhLmxhYmVsc31gKTtcbiAgfVxuICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGEubGFiZWxzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGFiZWwgPSBkYXRhLmxhYmVsc1tpXTtcbiAgICBpZiAoIWlzT2JqZWN0KGxhYmVsKSB8fCB0eXBlb2YgbGFiZWwubmFtZSAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgIGBsYWJlbHNbJHtpfV0ubmFtZWAsXG4gICAgICAgIFwiRXhwZWN0ZWQgb2JqZWN0IHdpdGggc3RyaW5nICduYW1lJyBmaWVsZFwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG9rKGRhdGEgYXMgdW5rbm93biBhcyBJc3N1ZUxhYmVsc1dyYXBwZXJKc29uKTtcbn1cblxuLy8gLS0tIFRpbWVsaW5lIGxhYmVsIGV2ZW50cyAobGFiZWwgc2VjdXJpdHkgLyBhdXRob3JzaGlwIGNoZWNrcykgLS0tXG5cbi8qKiBUaW1lbGluZSBldmVudCBhcyByZXR1cm5lZCBieSBgZ2ggYXBpIC4uLi90aW1lbGluZWAuICovXG5leHBvcnQgaW50ZXJmYWNlIFRpbWVsaW5lTGFiZWxFdmVudEpzb24ge1xuICBldmVudDogc3RyaW5nO1xuICBsYWJlbD86IHsgbmFtZTogc3RyaW5nIH07XG4gIGFjdG9yPzogeyBsb2dpbjogc3RyaW5nIH07XG4gIGFzc2lnbmVlPzogeyBsb2dpbjogc3RyaW5nIH07XG4gIC8qKiBJU08tODYwMSB0aW1lc3RhbXAgd2hlbiB0aGUgZXZlbnQgb2NjdXJyZWQgKElzc3VlICMxNTYxKS4gKi9cbiAgY3JlYXRlZF9hdD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhIHRpbWVsaW5lIGV2ZW50cyBhcnJheS4gT25seSBldmVudHMgd2l0aCBgZXZlbnQ6IFwibGFiZWxlZFwiYFxuICogcmVseSBvbiBsYWJlbC9hY3RvciBmaWVsZHMsIHNvIHRob3NlIGZpZWxkcyByZW1haW4gb3B0aW9uYWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVRpbWVsaW5lTGFiZWxFdmVudHNKc29uKFxuICBkYXRhOiB1bmtub3duLFxuKTogVmFsaWRhdGlvblJlc3VsdDxUaW1lbGluZUxhYmVsRXZlbnRKc29uW10+IHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGEpKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJyb290XCIsIGBFeHBlY3RlZCBhcnJheSwgZ290ICR7dHlwZW9mIGRhdGF9YCk7XG4gIH1cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBkYXRhLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgaXRlbSA9IGRhdGFbaV07XG4gICAgaWYgKCFpc09iamVjdChpdGVtKSkge1xuICAgICAgcmV0dXJuIGZhaWwoYHRpbWVsaW5lWyR7aX1dYCwgXCJFeHBlY3RlZCBvYmplY3RcIik7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgaXRlbS5ldmVudCAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgIGB0aW1lbGluZVske2l9XS5ldmVudGAsXG4gICAgICAgIGBFeHBlY3RlZCBzdHJpbmcsIGdvdCAke3R5cGVvZiBpdGVtLmV2ZW50fWAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoaXRlbS5sYWJlbCAhPT0gdW5kZWZpbmVkICYmIGl0ZW0ubGFiZWwgIT09IG51bGwpIHtcbiAgICAgIGlmICghaXNPYmplY3QoaXRlbS5sYWJlbCkgfHwgdHlwZW9mIGl0ZW0ubGFiZWwubmFtZSAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgICByZXR1cm4gZmFpbChcbiAgICAgICAgICBgdGltZWxpbmVbJHtpfV0ubGFiZWwubmFtZWAsXG4gICAgICAgICAgXCJFeHBlY3RlZCBvYmplY3Qgd2l0aCBzdHJpbmcgJ25hbWUnIGZpZWxkXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChpdGVtLmFjdG9yICE9PSB1bmRlZmluZWQgJiYgaXRlbS5hY3RvciAhPT0gbnVsbCkge1xuICAgICAgaWYgKCFpc09iamVjdChpdGVtLmFjdG9yKSB8fCB0eXBlb2YgaXRlbS5hY3Rvci5sb2dpbiAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgICByZXR1cm4gZmFpbChcbiAgICAgICAgICBgdGltZWxpbmVbJHtpfV0uYWN0b3IubG9naW5gLFxuICAgICAgICAgIFwiRXhwZWN0ZWQgb2JqZWN0IHdpdGggc3RyaW5nICdsb2dpbicgZmllbGRcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGl0ZW0uYXNzaWduZWUgIT09IHVuZGVmaW5lZCAmJiBpdGVtLmFzc2lnbmVlICE9PSBudWxsKSB7XG4gICAgICBpZiAoIWlzT2JqZWN0KGl0ZW0uYXNzaWduZWUpIHx8IHR5cGVvZiBpdGVtLmFzc2lnbmVlLmxvZ2luICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICAgIGB0aW1lbGluZVske2l9XS5hc3NpZ25lZS5sb2dpbmAsXG4gICAgICAgICAgXCJFeHBlY3RlZCBvYmplY3Qgd2l0aCBzdHJpbmcgJ2xvZ2luJyBmaWVsZFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoaXRlbS5jcmVhdGVkX2F0ICE9PSB1bmRlZmluZWQgJiYgaXRlbS5jcmVhdGVkX2F0ICE9PSBudWxsKSB7XG4gICAgICBpZiAodHlwZW9mIGl0ZW0uY3JlYXRlZF9hdCAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgICByZXR1cm4gZmFpbChgdGltZWxpbmVbJHtpfV0uY3JlYXRlZF9hdGAsIFwiRXhwZWN0ZWQgc3RyaW5nXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gb2soZGF0YSBhcyBUaW1lbGluZUxhYmVsRXZlbnRKc29uW10pO1xufVxuXG4vLyAtLS0gSXNzdWUgbWlsZXN0b25lIHdyYXBwZXIgLS0tXG5cbi8qKiBgeyBtaWxlc3RvbmU/OiB7IHRpdGxlIH0gfCBudWxsIH1gIHNoYXBlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBJc3N1ZU1pbGVzdG9uZVdyYXBwZXJKc29uIHtcbiAgbWlsZXN0b25lPzogeyB0aXRsZTogc3RyaW5nIH0gfCBudWxsO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIGB7IG1pbGVzdG9uZTogeyB0aXRsZSB9IHwgbnVsbCB8IHVuZGVmaW5lZCB9YCDigJQgdXNlZCBieVxuICogZ2ggaXNzdWUgdmlldyAtLWpzb24gbWlsZXN0b25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVJc3N1ZU1pbGVzdG9uZUpzb24oXG4gIGRhdGE6IHVua25vd24sXG4pOiBWYWxpZGF0aW9uUmVzdWx0PElzc3VlTWlsZXN0b25lV3JhcHBlckpzb24+IHtcbiAgaWYgKCFpc09iamVjdChkYXRhKSkge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJyb290XCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0LCBnb3QgJHtkYXRhID09PSBudWxsID8gXCJudWxsXCIgOiB0eXBlb2YgZGF0YX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKGRhdGEubWlsZXN0b25lID09PSB1bmRlZmluZWQgfHwgZGF0YS5taWxlc3RvbmUgPT09IG51bGwpIHtcbiAgICByZXR1cm4gb2soeyBtaWxlc3RvbmU6IG51bGwgfSk7XG4gIH1cbiAgaWYgKCFpc09iamVjdChkYXRhLm1pbGVzdG9uZSkpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwibWlsZXN0b25lXCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0IG9yIG51bGwsIGdvdCAke3R5cGVvZiBkYXRhLm1pbGVzdG9uZX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKHR5cGVvZiBkYXRhLm1pbGVzdG9uZS50aXRsZSAhPT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJtaWxlc3RvbmUudGl0bGVcIixcbiAgICAgIGBFeHBlY3RlZCBzdHJpbmcsIGdvdCAke3R5cGVvZiBkYXRhLm1pbGVzdG9uZS50aXRsZX1gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG9rKHsgbWlsZXN0b25lOiB7IHRpdGxlOiBkYXRhLm1pbGVzdG9uZS50aXRsZSBhcyBzdHJpbmcgfSB9KTtcbn1cblxuLy8gLS0tIElzc3VlIGJvZHkgd3JhcHBlciAtLS1cblxuLyoqIGB7IGJvZHk/OiBzdHJpbmcgfWAgc2hhcGUg4oCUIHVzZWQgYnkgZ2ggaXNzdWUgdmlldyAtLWpzb24gYm9keS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSXNzdWVCb2R5V3JhcHBlckpzb24ge1xuICBib2R5Pzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIGB7IGJvZHk/OiBzdHJpbmcgfWAuIFRoZSBib2R5IGZpZWxkIGlzIG9wdGlvbmFsOyB3aGVuIHByZXNlbnRcbiAqIGl0IG11c3QgYmUgYSBzdHJpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUlzc3VlQm9keUpzb24oXG4gIGRhdGE6IHVua25vd24sXG4pOiBWYWxpZGF0aW9uUmVzdWx0PElzc3VlQm9keVdyYXBwZXJKc29uPiB7XG4gIGlmICghaXNPYmplY3QoZGF0YSkpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwicm9vdFwiLFxuICAgICAgYEV4cGVjdGVkIG9iamVjdCwgZ290ICR7ZGF0YSA9PT0gbnVsbCA/IFwibnVsbFwiIDogdHlwZW9mIGRhdGF9YCxcbiAgICApO1xuICB9XG4gIGlmIChkYXRhLmJvZHkgPT09IHVuZGVmaW5lZCB8fCBkYXRhLmJvZHkgPT09IG51bGwpIHtcbiAgICByZXR1cm4gb2soe30pO1xuICB9XG4gIGlmICh0eXBlb2YgZGF0YS5ib2R5ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJib2R5XCIsIGBFeHBlY3RlZCBzdHJpbmcsIGdvdCAke3R5cGVvZiBkYXRhLmJvZHl9YCk7XG4gIH1cbiAgcmV0dXJuIG9rKHsgYm9keTogZGF0YS5ib2R5IH0pO1xufVxuXG4vLyAtLS0gSXNzdWUgc3RhdGUgd3JhcHBlciAtLS1cblxuLyoqXG4gKiBgeyBudW1iZXIsIHN0YXRlLCB0aXRsZSwgbWlsZXN0b25lPyB9YCDigJQgdXNlZCBieVxuICogYGdoIGlzc3VlIHZpZXcgLS1qc29uIG51bWJlcixzdGF0ZSx0aXRsZSxtaWxlc3RvbmVgLlxuICpcbiAqIElzc3VlICMyNTMzOiBgbWlsZXN0b25lYCBpcyBvcHRpb25hbCBzbyBjYWxsZXJzIHRoYXQgc3RpbGwgcmVxdWVzdCBvbmx5XG4gKiBgbnVtYmVyLHN0YXRlLHRpdGxlYCBrZWVwIHZhbGlkYXRpbmcsIHdoaWxlIHRoZSBkaWFnbm9zZSBjb21tYW5kcyBjYW4gY2FycnlcbiAqIHRoZSBkZXBlbmRlbmN5J3MgbWlsZXN0b25lIHRpdGxlIGludG8gdGhlIGNyb3NzLW1pbGVzdG9uZSBob2xkIChJc3N1ZSAjMjE3MykuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSXNzdWVTdGF0ZUpzb24ge1xuICBudW1iZXI6IG51bWJlcjtcbiAgc3RhdGU6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgLyoqIE1pbGVzdG9uZSB0aXRsZSwgb3IgYG51bGxgIHdoZW4gdGhlIGlzc3VlIGhhcyBubyBtaWxlc3RvbmUuICovXG4gIG1pbGVzdG9uZT86IHN0cmluZyB8IG51bGw7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYW4gaXNzdWUgc3RhdGUgcmVzcG9uc2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUlzc3VlU3RhdGVKc29uKFxuICBkYXRhOiB1bmtub3duLFxuKTogVmFsaWRhdGlvblJlc3VsdDxJc3N1ZVN0YXRlSnNvbj4ge1xuICBpZiAoIWlzT2JqZWN0KGRhdGEpKSB7XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBcInJvb3RcIixcbiAgICAgIGBFeHBlY3RlZCBvYmplY3QsIGdvdCAke2RhdGEgPT09IG51bGwgPyBcIm51bGxcIiA6IHR5cGVvZiBkYXRhfWAsXG4gICAgKTtcbiAgfVxuICBpZiAodHlwZW9mIGRhdGEubnVtYmVyICE9PSBcIm51bWJlclwiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJudW1iZXJcIiwgYEV4cGVjdGVkIG51bWJlciwgZ290ICR7dHlwZW9mIGRhdGEubnVtYmVyfWApO1xuICB9XG4gIGlmICh0eXBlb2YgZGF0YS5zdGF0ZSAhPT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiBmYWlsKFwic3RhdGVcIiwgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIGRhdGEuc3RhdGV9YCk7XG4gIH1cbiAgaWYgKHR5cGVvZiBkYXRhLnRpdGxlICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJ0aXRsZVwiLCBgRXhwZWN0ZWQgc3RyaW5nLCBnb3QgJHt0eXBlb2YgZGF0YS50aXRsZX1gKTtcbiAgfVxuICAvLyBJc3N1ZSAjMjUzMzogYGdoYCByZXR1cm5zIGBtaWxlc3RvbmVgIGFzIGFuIG9iamVjdCAob3IgbnVsbCk7IGFueXRoaW5nXG4gIC8vIGVsc2UgaXMgdHJlYXRlZCBhcyBcIm5vIG1pbGVzdG9uZVwiIHJhdGhlciB0aGFuIGZhaWxpbmcgdGhlIHdob2xlIHJlYWQsIHNvIGFcbiAgLy8gY2FsbGVyIHRoYXQgbmV2ZXIgcmVxdWVzdGVkIHRoZSBmaWVsZCBzdGlsbCB2YWxpZGF0ZXMuXG4gIGNvbnN0IG1pbGVzdG9uZTogc3RyaW5nIHwgbnVsbCA9XG4gICAgaXNPYmplY3QoZGF0YS5taWxlc3RvbmUpICYmIHR5cGVvZiBkYXRhLm1pbGVzdG9uZS50aXRsZSA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBkYXRhLm1pbGVzdG9uZS50aXRsZVxuICAgICAgOiBudWxsO1xuICByZXR1cm4gb2soe1xuICAgIG51bWJlcjogZGF0YS5udW1iZXIgYXMgbnVtYmVyLFxuICAgIHN0YXRlOiBkYXRhLnN0YXRlIGFzIHN0cmluZyxcbiAgICB0aXRsZTogZGF0YS50aXRsZSBhcyBzdHJpbmcsXG4gICAgbWlsZXN0b25lLFxuICB9KTtcbn1cblxuLy8gLS0tIEZ1bGwgaXNzdWUgdmlldyAoZGlhZ25vc2UpIC0tLVxuXG4vKipcbiAqIFNoYXBlIHJldHVybmVkIGJ5IGBnaCBpc3N1ZSB2aWV3IC4uLiAtLWpzb24gbnVtYmVyLHRpdGxlLGFzc2lnbmVlcyx1cmwsXG4gKiBsYWJlbHMsY3JlYXRlZEF0LGF1dGhvcixtaWxlc3RvbmVgLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEdoSXNzdWVWaWV3SnNvbiB7XG4gIG51bWJlcjogbnVtYmVyO1xuICB0aXRsZTogc3RyaW5nO1xuICB1cmw6IHN0cmluZztcbiAgYXNzaWduZWVzOiBBcnJheTx7IGxvZ2luOiBzdHJpbmcgfT47XG4gIGxhYmVsczogQXJyYXk8eyBuYW1lOiBzdHJpbmcgfT47XG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xuICBhdXRob3I6IHsgbG9naW46IHN0cmluZyB9O1xuICBtaWxlc3RvbmU/OiB7IHRpdGxlOiBzdHJpbmcgfSB8IG51bGw7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdGhlIGZ1bGwgaXNzdWUgdmlldyBKU09OICh3aXRoIGFzc2lnbmVlcywgbGFiZWxzLCBldGMuKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlR2hJc3N1ZVZpZXdKc29uKFxuICBkYXRhOiB1bmtub3duLFxuKTogVmFsaWRhdGlvblJlc3VsdDxHaElzc3VlVmlld0pzb24+IHtcbiAgaWYgKCFpc09iamVjdChkYXRhKSkge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJyb290XCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0LCBnb3QgJHtkYXRhID09PSBudWxsID8gXCJudWxsXCIgOiB0eXBlb2YgZGF0YX1gLFxuICAgICk7XG4gIH1cblxuICBpZiAodHlwZW9mIGRhdGEubnVtYmVyICE9PSBcIm51bWJlclwiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJudW1iZXJcIiwgYEV4cGVjdGVkIG51bWJlciwgZ290ICR7dHlwZW9mIGRhdGEubnVtYmVyfWApO1xuICB9XG4gIGlmICh0eXBlb2YgZGF0YS50aXRsZSAhPT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiBmYWlsKFwidGl0bGVcIiwgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIGRhdGEudGl0bGV9YCk7XG4gIH1cbiAgaWYgKHR5cGVvZiBkYXRhLnVybCAhPT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiBmYWlsKFwidXJsXCIsIGBFeHBlY3RlZCBzdHJpbmcsIGdvdCAke3R5cGVvZiBkYXRhLnVybH1gKTtcbiAgfVxuICBpZiAodHlwZW9mIGRhdGEuY3JlYXRlZEF0ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJjcmVhdGVkQXRcIiwgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIGRhdGEuY3JlYXRlZEF0fWApO1xuICB9XG5cbiAgaWYgKCFpc09iamVjdChkYXRhLmF1dGhvcikpIHtcbiAgICByZXR1cm4gZmFpbChcbiAgICAgIFwiYXV0aG9yXCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0LCBnb3QgJHtcbiAgICAgICAgZGF0YS5hdXRob3IgPT09IG51bGwgPyBcIm51bGxcIiA6IHR5cGVvZiBkYXRhLmF1dGhvclxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuICBpZiAodHlwZW9mIGRhdGEuYXV0aG9yLmxvZ2luICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBcImF1dGhvci5sb2dpblwiLFxuICAgICAgYEV4cGVjdGVkIHN0cmluZywgZ290ICR7dHlwZW9mIGRhdGEuYXV0aG9yLmxvZ2lufWAsXG4gICAgKTtcbiAgfVxuXG4gIGlmICghQXJyYXkuaXNBcnJheShkYXRhLmFzc2lnbmVlcykpIHtcbiAgICByZXR1cm4gZmFpbChcImFzc2lnbmVlc1wiLCBgRXhwZWN0ZWQgYXJyYXksIGdvdCAke3R5cGVvZiBkYXRhLmFzc2lnbmVlc31gKTtcbiAgfVxuICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGEuYXNzaWduZWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYSA9IGRhdGEuYXNzaWduZWVzW2ldO1xuICAgIGlmICghaXNPYmplY3QoYSkgfHwgdHlwZW9mIGEubG9naW4gIT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBgYXNzaWduZWVzWyR7aX1dLmxvZ2luYCxcbiAgICAgICAgXCJFeHBlY3RlZCBvYmplY3Qgd2l0aCBzdHJpbmcgJ2xvZ2luJyBmaWVsZFwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YS5sYWJlbHMpKSB7XG4gICAgcmV0dXJuIGZhaWwoXCJsYWJlbHNcIiwgYEV4cGVjdGVkIGFycmF5LCBnb3QgJHt0eXBlb2YgZGF0YS5sYWJlbHN9YCk7XG4gIH1cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBkYXRhLmxhYmVscy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGwgPSBkYXRhLmxhYmVsc1tpXTtcbiAgICBpZiAoIWlzT2JqZWN0KGwpIHx8IHR5cGVvZiBsLm5hbWUgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiBmYWlsKFxuICAgICAgICBgbGFiZWxzWyR7aX1dLm5hbWVgLFxuICAgICAgICBcIkV4cGVjdGVkIG9iamVjdCB3aXRoIHN0cmluZyAnbmFtZScgZmllbGRcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gbWlsZXN0b25lIGlzIG9wdGlvbmFsXG4gIGlmIChkYXRhLm1pbGVzdG9uZSAhPT0gdW5kZWZpbmVkICYmIGRhdGEubWlsZXN0b25lICE9PSBudWxsKSB7XG4gICAgaWYgKCFpc09iamVjdChkYXRhLm1pbGVzdG9uZSkgfHwgdHlwZW9mIGRhdGEubWlsZXN0b25lLnRpdGxlICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICByZXR1cm4gZmFpbChcbiAgICAgICAgXCJtaWxlc3RvbmUudGl0bGVcIixcbiAgICAgICAgXCJFeHBlY3RlZCBvYmplY3Qgd2l0aCBzdHJpbmcgJ3RpdGxlJyBmaWVsZFwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gb2soZGF0YSBhcyB1bmtub3duIGFzIEdoSXNzdWVWaWV3SnNvbik7XG59XG5cbi8vIC0tLSBEZWZhdWx0IGJyYW5jaCBjYWNoZSBlbnRyaWVzIC0tLVxuXG4vKiogT25lIGVudHJ5IGluIHRoZSBwZXJzaXN0ZW50IGRlZmF1bHQtYnJhbmNoIGNhY2hlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBEZWZhdWx0QnJhbmNoQ2FjaGVFbnRyeUpzb24ge1xuICBicmFuY2g6IHN0cmluZztcbiAgZmV0Y2hlZEF0OiBudW1iZXI7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYSBgUmVjb3JkPHN0cmluZywge2JyYW5jaCwgZmV0Y2hlZEF0fT5gIHBlcnNpc3RlZCBjYWNoZS5cbiAqXG4gKiBFbnRyaWVzIHRoYXQgZmFpbCB2YWxpZGF0aW9uIGFyZSBkcm9wcGVkIChyYXRoZXIgdGhhbiByZWplY3RpbmcgdGhlXG4gKiB3aG9sZSBjYWNoZSkgc28gYSBzaW5nbGUgY29ycnVwdCBlbnRyeSBkb2VzIG5vdCBpbnZhbGlkYXRlIHRoZSBmaWxlLlxuICogUmV0dXJucyB0aGUgdmFsaWRhdGVkIGVudHJpZXMgYXMgYSBwbGFpbiByZWNvcmQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZURlZmF1bHRCcmFuY2hDYWNoZUpzb24oXG4gIGRhdGE6IHVua25vd24sXG4pOiBWYWxpZGF0aW9uUmVzdWx0PFJlY29yZDxzdHJpbmcsIERlZmF1bHRCcmFuY2hDYWNoZUVudHJ5SnNvbj4+IHtcbiAgaWYgKCFpc09iamVjdChkYXRhKSkge1xuICAgIHJldHVybiBmYWlsKFxuICAgICAgXCJyb290XCIsXG4gICAgICBgRXhwZWN0ZWQgb2JqZWN0LCBnb3QgJHtkYXRhID09PSBudWxsID8gXCJudWxsXCIgOiB0eXBlb2YgZGF0YX1gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdmFsaWRhdGVkOiBSZWNvcmQ8c3RyaW5nLCBEZWZhdWx0QnJhbmNoQ2FjaGVFbnRyeUpzb24+ID0ge307XG4gIGZvciAoY29uc3QgW2tleSwgZW50cnldIG9mIE9iamVjdC5lbnRyaWVzKGRhdGEpKSB7XG4gICAgaWYgKFxuICAgICAgaXNPYmplY3QoZW50cnkpICYmXG4gICAgICB0eXBlb2YgZW50cnkuYnJhbmNoID09PSBcInN0cmluZ1wiICYmXG4gICAgICB0eXBlb2YgZW50cnkuZmV0Y2hlZEF0ID09PSBcIm51bWJlclwiXG4gICAgKSB7XG4gICAgICB2YWxpZGF0ZWRba2V5XSA9IHsgYnJhbmNoOiBlbnRyeS5icmFuY2gsIGZldGNoZWRBdDogZW50cnkuZmV0Y2hlZEF0IH07XG4gICAgfVxuICAgIC8vIFNpbGVudGx5IGRyb3AgbWFsZm9ybWVkIGVudHJpZXMg4oCUIHRoZSBjYWNoZSBpcyBiZXN0LWVmZm9ydC5cbiAgfVxuICByZXR1cm4gb2sodmFsaWRhdGVkKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Q0FLQyxHQUVELFNBQ0UsU0FBUyxFQUNULGlCQUFpQixFQUNqQixtQkFBbUIsRUFDbkIsU0FBUyxRQUNKLGdCQUFnQjtBQUN2QixTQUFTLGNBQWMsRUFBRSxZQUFZLFFBQVEsdUJBQXVC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
// denoCacheMetadata=15579826158874505547,354796830471886455