/**
 * Runtime JSON schema validation for gh CLI responses and config files.
 *
 * Provides type guard functions that validate unknown JSON data at runtime,
 * returning typed results or explicit errors (Issue #214).
 */

import {
  isRunMode,
  REMOVED_RUN_MODES,
  RUN_MODE_CONFIG_KEY,
  RUN_MODES,
} from "./run_mode.ts";

/**
 * GitHub org team slug in `org/slug` form (Issue #252).
 *
 * Each segment starts with an alphanumeric and may contain hyphens.
 * A bare slug, extra path segments, or whitespace is unparseable — a typo
 * that silently disabled team exclusion is the failure mode this rejects.
 */
export const EXCLUSION_TEAM_PATTERN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/**
 * Config keys this worker once honoured, mapped to the migration an operator
 * still carrying one has to make (Issue #805).
 *
 * A removed key is refused rather than ignored: a setting that reads as live
 * and does nothing is the silent failure the whole config load exists to
 * prevent. The message names the replacement so the fix is one edit, not an
 * investigation.
 */
export const REMOVED_CONFIG_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "fleet_health_dir",
    "Built-in fleet health reporting was removed (Issue #805): report host " +
    "health from a `callbacks.success` (or `callbacks.always`) hook " +
    "instead — see docs/CONFIGURATION.md. Remove the key.",
  ],
  [
    "fleet_health_repo",
    "Built-in fleet health reporting was removed (Issue #805): report host " +
    "health from a `callbacks.success` (or `callbacks.always`) hook " +
    "instead — see docs/CONFIGURATION.md. Remove the key.",
  ],
]);

/**
 * Validation error with the field that failed and a human-readable message.
 */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Result of a validation: either a typed value or an error.
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ValidationError };

/**
 * Raw JSON structure from gh issue view (validated at runtime).
 */
export interface GhIssueJson {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  author: { login: string };
  assignees: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Raw JSON structure from gh issue comments (validated at runtime).
 */
export interface GhCommentJson {
  id: number;
  body: string;
  author: { login: string };
  createdAt: string;
  reactions: {
    "+1": number;
    eyes: number;
    confused: number;
  };
}

/**
 * Full configuration file structure (validated at runtime).
 *
 * Issue #277: Includes operational settings (timeouts, intervals).
 * All fields are optional — only overrides are stored.
 */
export interface ConfigFileJson {
  allowed_authors?: string[];
  pr_reviewers?: string[];
  repos?: string[];
  authorized_commenters?: string[];
  /** `"github"` | `"config"` — default `"config"` (Issue #252). */
  author_source?: string;
  /** Org team slug `org/slug` excluded from GitHub-derived allowlists. */
  exclusion_team?: string;
  /** Bot accounts whose PR review comments are auto-trusted (Issue #1856) */
  trusted_review_bots?: string[];
  // Issue #1834: `issue_labels`, `work_on_label`, and `low_priority_label`
  // are no longer valid keys. The three discovery labels (top-priority,
  // work-on, low-priority) are hardwired in `lib/config_defaults.ts`.
  failed_once_label?: string;
  failed_label?: string;
  refine_issue_label?: string;
  planning_label?: string;
  question_label?: string;
  needs_revision_label?: string;
  needs_human_label?: string;
  repo_config?: Record<string, unknown>;
  /** Where the worker runs — `container` or `native` (Issue #4146). */
  run_mode?: string;
  /** How the host tracks releases — `dynamic` or `frozen` (Issue #622). */
  update_mode?: string;
  /** Commit SHA or tag a frozen host is held at (Issue #622). */
  pinned_ref?: string;
  /** Exact tool versions a frozen host installs (Issue #622). */
  pinned_tool_versions?: Record<string, unknown>;
  /** Active coding-agent provider id (Issue #4067). */
  agent_provider?: string;
  /** Providers enabled for a run (Issue #4108). */
  agent_providers?: string[];
  claude_model?: string;
  best_planning_model?: string;
  claude_timeout?: number;
  min_claim_runway_seconds?: number;
  /** Labels marking an issue as a long job (Issue #245). */
  claim_long_job_labels?: string[];
  claude_kill_after?: number;
  max_clarification_rounds?: number;
  sleep_interval?: number;
  credit_wait_interval?: number;
  refinement_timeout?: number;
  refinement_kill_after?: number;
  planning_timeout?: number;
  planning_kill_after?: number;
  question_timeout?: number;
  question_kill_after?: number;
  clarification_timeout?: number;
  clarification_kill_after?: number;
  max_rate_limit_retries?: number;
  max_rate_limit_wait?: number;
  retry_max_delay?: number;
  max_issue_body_tokens?: number;
  summarise_timeout?: number;
  summarise_kill_after?: number;
  feature_check_timeout?: number;
  claude_no_output_timeout?: number;
  quality_check_timeout?: number;
  health_cache_ttl?: number;
  shuffle_repos?: boolean;
  update_gh_user_status?: boolean;
  enable_model_fallback?: boolean;
  sync_milestone_branches?: boolean;
  worker_name?: string;
  ssh_key_path?: string;
  gh_config_dir?: string;
  log_max_size_mb?: number;
  log_max_rotations?: number;
  stuck_issue_timeout?: number;
  issue_retry_cooldown?: number;
  imgbb_api_key?: string;
  github_app_id?: string;
  github_app_installation_id?: string;
  github_app_private_key_path?: string;
  min_disk_space_mb?: number;
  host_disk_low_floor_gb?: number;
  host_disk_low_floor_percent?: number;
  milestone_sync_cooldown_seconds?: number;
  stale_failed_diagnostic_days?: number;
  stale_planning_warning_days?: number;
  phase_model_overrides?: Record<string, string>;
  phase_effort_overrides?: Record<string, string>;
  codex_phase_model_overrides?: Record<string, string>;
  codex_phase_effort_overrides?: Record<string, string>;
  gemini_phase_model_overrides?: Record<string, string>;
  deepseek_phase_model_overrides?: Record<string, string>;
  enable_session_resume?: boolean;
  /** Global verbosity level override (Issue #1330) */
  verbosity?: string;
  context_budget_warning_percent?: number;
  context_budget_error_percent?: number;
  context_budget_block_percent?: number;
  /** Per-template weights for the idle-task draw (Issue #2401) */
  idle_task_template_weights?: Record<string, number>;
  /**
   * Cadence floor for the important idle-task templates (Issue #4011).
   *
   * Deliberately unvalidated here: `parseIdleTaskCadence()` warns loudly and
   * falls back per fault, because a typo in a spend policy must not stop the
   * worker from starting.
   */
  idle_task_cadence?: unknown;
  /** Per-tool minimum version floors for software auto-update (Issue #2622) */
  software_min_versions?: Record<string, string>;
  /**
   * Post-run callback hooks (Issue #806, parent #796).
   *
   * Deliberately unvalidated here: `parseCallbacksConfig()` owns the shape and
   * fails the config load loudly, so a hook that would never run is caught
   * before any issue is claimed against it.
   */
  callbacks?: unknown;
}

// --- Helpers ---

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string, message: string): ValidationResult<never> {
  return { ok: false, error: { field, message } };
}

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

// --- String array validation ---

function validateStringArray(
  arr: unknown,
  fieldName: string,
): ValidationResult<string[]> {
  if (!Array.isArray(arr)) {
    return fail(fieldName, `Expected array, got ${typeof arr}`);
  }
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "string") {
      return fail(
        `${fieldName}[${i}]`,
        `Expected string, got ${typeof arr[i]}`,
      );
    }
  }
  return ok(arr as string[]);
}

// --- Optional string field validation ---

function validateOptionalString(
  value: unknown,
  fieldName: string,
): ValidationResult<string | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== "string") {
    return fail(fieldName, `Expected string, got ${typeof value}`);
  }
  return ok(value);
}

// --- Optional string array validation ---

function validateOptionalStringArray(
  value: unknown,
  fieldName: string,
): ValidationResult<string[] | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  return validateStringArray(value, fieldName);
}

// --- Optional boolean field validation (Issue #435) ---

function validateOptionalBoolean(
  value: unknown,
  fieldName: string,
): ValidationResult<boolean | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== "boolean") {
    return fail(fieldName, `Expected boolean, got ${typeof value}`);
  }
  return ok(value);
}

// --- Optional number field validation (Issue #277) ---

function validateOptionalNumber(
  value: unknown,
  fieldName: string,
): ValidationResult<number | undefined> {
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
 */
export function validateGhIssueJson(
  data: unknown,
): ValidationResult<GhIssueJson> {
  if (!isObject(data)) {
    return fail(
      "root",
      `Expected object, got ${data === null ? "null" : typeof data}`,
    );
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
  for (let i = 0; i < data.labels.length; i++) {
    const label = data.labels[i];
    if (!isObject(label) || typeof label.name !== "string") {
      return fail(
        `labels[${i}].name`,
        "Expected object with string 'name' field",
      );
    }
  }

  // author: { login: string }
  if (!isObject(data.author)) {
    return fail(
      "author",
      `Expected object, got ${
        data.author === null ? "null" : typeof data.author
      }`,
    );
  }
  if (typeof data.author.login !== "string") {
    return fail(
      "author.login",
      `Expected string, got ${typeof data.author.login}`,
    );
  }

  // assignees: Array<{ login: string }>
  if (!Array.isArray(data.assignees)) {
    return fail("assignees", `Expected array, got ${typeof data.assignees}`);
  }
  for (let i = 0; i < data.assignees.length; i++) {
    const assignee = data.assignees[i];
    if (!isObject(assignee) || typeof assignee.login !== "string") {
      return fail(
        `assignees[${i}].login`,
        "Expected object with string 'login' field",
      );
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

  return ok(data as unknown as GhIssueJson);
}

// --- GhCommentJson validation ---

/**
 * Validate unknown data as a GhCommentJson structure.
 * Normalises null/missing reaction values to 0.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns Validated GhCommentJson or a ValidationError
 */
export function validateGhCommentJson(
  data: unknown,
): ValidationResult<GhCommentJson> {
  if (!isObject(data)) {
    return fail(
      "root",
      `Expected object, got ${data === null ? "null" : typeof data}`,
    );
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
    return fail(
      "author",
      `Expected object, got ${
        data.author === null ? "null" : typeof data.author
      }`,
    );
  }
  if (typeof data.author.login !== "string") {
    return fail(
      "author.login",
      `Expected string, got ${typeof data.author.login}`,
    );
  }

  // createdAt
  if (typeof data.createdAt !== "string") {
    return fail("createdAt", `Expected string, got ${typeof data.createdAt}`);
  }

  // reactions
  if (!isObject(data.reactions)) {
    return fail(
      "reactions",
      `Expected object, got ${
        data.reactions === null ? "null" : typeof data.reactions
      }`,
    );
  }

  // Normalise null/undefined/missing reaction values to 0
  const reactions = data.reactions as Record<string, unknown>;
  const thumbsUp = typeof reactions["+1"] === "number"
    ? reactions["+1"] as number
    : 0;
  const eyes = typeof reactions.eyes === "number"
    ? reactions.eyes as number
    : 0;
  const confused = typeof reactions.confused === "number"
    ? reactions.confused as number
    : 0;

  const validated: GhCommentJson = {
    id: data.id as number,
    body: data.body as string,
    author: { login: data.author.login as string },
    createdAt: data.createdAt as string,
    reactions: { "+1": thumbsUp, eyes, confused },
  };

  return ok(validated);
}

// --- Comments array validation ---

/**
 * Validate unknown data as an array of GhCommentJson.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns Validated GhCommentJson array or a ValidationError
 */
export function validateGhCommentsJson(
  data: unknown,
): ValidationResult<GhCommentJson[]> {
  if (!Array.isArray(data)) {
    return fail("root", `Expected array, got ${typeof data}`);
  }

  const result: GhCommentJson[] = [];
  for (let i = 0; i < data.length; i++) {
    const commentResult = validateGhCommentJson(data[i]);
    if (!commentResult.ok) {
      return fail(
        `comments[${i}].${commentResult.error.field}`,
        commentResult.error.message,
      );
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
 */
export function validateConfigFileJson(
  data: unknown,
): ValidationResult<ConfigFileJson> {
  if (!isObject(data)) {
    return fail(
      "root",
      `Expected object, got ${data === null ? "null" : typeof data}`,
    );
  }

  // A key this worker used to honour and no longer does must fail loudly:
  // ignoring it would leave the operator with a setting that reads as live
  // and does nothing (Issue #805).
  const stale = [...REMOVED_CONFIG_KEYS.keys()].filter((key) =>
    data[key] !== undefined
  );
  if (stale.length > 0) {
    // One message for the whole migration — fixing one key and rediscovering
    // the next on the following start is not actionable.
    const guidance = [
      ...new Set(stale.map((key) => REMOVED_CONFIG_KEYS.get(key)!)),
    ];
    return fail(
      stale.join(", "),
      `${stale.map((key) => `"${key}"`).join(" and ")} ${
        stale.length === 1 ? "was" : "were"
      } removed. ${guidance.join(" ")}`,
    );
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
    "agent_provider",
    "claude_model",
    "best_planning_model",
    "worker_name",
    "ssh_key_path",
    "gh_config_dir",
    "imgbb_api_key",
    "github_app_id",
    "github_app_installation_id",
    "github_app_private_key_path",
    "verbosity",
    "author_source",
    "exclusion_team",
  ] as const;

  for (const field of stringFields) {
    const result = validateOptionalString(data[field], field);
    if (!result.ok) return result as ValidationResult<never>;
  }

  // run_mode accepts only container (Issues #4146, #4) — a typo must fail
  // here rather than be coerced to the default (Issue #3234), and a removed
  // mode (native, seatbelt) is named as removed so the operator learns why.
  if (
    data[RUN_MODE_CONFIG_KEY] !== undefined &&
    !isRunMode(data[RUN_MODE_CONFIG_KEY])
  ) {
    const raw = data[RUN_MODE_CONFIG_KEY];
    if (typeof raw === "string" && REMOVED_RUN_MODES.includes(raw.trim())) {
      return fail(
        RUN_MODE_CONFIG_KEY,
        `Run mode ${JSON.stringify(raw)} was removed (Issue #4): containment ` +
          `is mandatory, the worker runs only inside the container. Remove ` +
          `the key.`,
      );
    }
    return fail(
      RUN_MODE_CONFIG_KEY,
      `Expected one of ${RUN_MODES.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }

  // author_source accepts only github | config (Issue #252). A typo must
  // fail here rather than be coerced to the default — that would silently
  // keep a host on local arrays when the operator asked for GitHub.
  if (data.author_source !== undefined) {
    if (
      data.author_source !== "github" && data.author_source !== "config"
    ) {
      return fail(
        "author_source",
        `Expected "github" or "config", got ${
          JSON.stringify(data.author_source)
        }`,
      );
    }
  }

  // exclusion_team must be org/slug when present (Issue #252). A typo that
  // silently disables team exclusion is the failure mode this rejects.
  if (data.exclusion_team !== undefined) {
    if (!EXCLUSION_TEAM_PATTERN.test(data.exclusion_team as string)) {
      return fail(
        "exclusion_team",
        `Expected org/slug (e.g. stSoftwareAU/vibe-workers), got ${
          JSON.stringify(data.exclusion_team)
        }`,
      );
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
    // Long-job labels for the adaptive claim floor (Issue #245).
    "claim_long_job_labels",
  ] as const;

  for (const field of arrayFields) {
    const result = validateOptionalStringArray(data[field], field);
    if (!result.ok) return result as ValidationResult<never>;
  }

  // Optional number fields (Issue #277 — operational settings)
  const numberFields = [
    "claude_timeout",
    "min_claim_runway_seconds",
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
    "milestone_sync_cooldown_seconds",
    "stale_failed_diagnostic_days",
    "stale_planning_warning_days",
    "context_budget_warning_percent",
    "context_budget_error_percent",
    "context_budget_block_percent",
  ] as const;

  for (const field of numberFields) {
    const result = validateOptionalNumber(data[field], field);
    if (!result.ok) return result as ValidationResult<never>;
  }

  // Optional boolean fields (Issue #435)
  const booleanFields = [
    "shuffle_repos",
    "update_gh_user_status",
    "enable_model_fallback",
    "sync_milestone_branches",
    "enable_session_resume",
  ] as const;

  for (const field of booleanFields) {
    const result = validateOptionalBoolean(data[field], field);
    if (!result.ok) return result as ValidationResult<never>;
  }

  // pinned_tool_versions is an object of tool → exact version string
  // (Issue #622). Only the shape is checked here; whether the versions are
  // present and usable is `validateUpdateModeSettings`'s call.
  if (data.pinned_tool_versions !== undefined) {
    if (!isObject(data.pinned_tool_versions)) {
      return fail(
        "pinned_tool_versions",
        `Expected object, got ${
          data.pinned_tool_versions === null
            ? "null"
            : typeof data.pinned_tool_versions
        }`,
      );
    }
    for (
      const [tool, version] of Object.entries(data.pinned_tool_versions)
    ) {
      const result = validateOptionalString(
        version,
        `pinned_tool_versions.${tool}`,
      );
      if (!result.ok) return result as ValidationResult<never>;
    }
  }

  // repo_config is optional and loosely typed (validated elsewhere)
  if (data.repo_config !== undefined && !isObject(data.repo_config)) {
    return fail(
      "repo_config",
      `Expected object, got ${typeof data.repo_config}`,
    );
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
    "deepseek_phase_model_overrides",
  ] as const;

  for (const field of phaseOverrideFields) {
    const value = data[field];
    if (value === undefined) continue;
    if (!isObject(value)) {
      return fail(field, `Expected object, got ${typeof value}`);
    }
    for (const [key, val] of Object.entries(value)) {
      if (typeof val !== "string") {
        return fail(`${field}.${key}`, `Expected string, got ${typeof val}`);
      }
    }
  }

  // idle_task_template_weights is optional Record<string, number> (Issue #2401)
  if (data.idle_task_template_weights !== undefined) {
    if (!isObject(data.idle_task_template_weights)) {
      return fail(
        "idle_task_template_weights",
        `Expected object, got ${typeof data.idle_task_template_weights}`,
      );
    }
    for (const [key, val] of Object.entries(data.idle_task_template_weights)) {
      if (typeof val !== "number") {
        return fail(
          `idle_task_template_weights.${key}`,
          `Expected number, got ${typeof val}`,
        );
      }
    }
  }

  // software_min_versions is optional Record<string, string> (Issue #2622)
  if (data.software_min_versions !== undefined) {
    if (!isObject(data.software_min_versions)) {
      return fail(
        "software_min_versions",
        `Expected object, got ${typeof data.software_min_versions}`,
      );
    }
    for (const [key, val] of Object.entries(data.software_min_versions)) {
      if (typeof val !== "string") {
        return fail(
          `software_min_versions.${key}`,
          `Expected string, got ${typeof val}`,
        );
      }
    }
  }

  return ok(data as unknown as ConfigFileJson);
}

// =============================================================================
// Shared gh CLI validators (Issue #1532)
// =============================================================================
//
// These validators cover the remaining `JSON.parse(...) as Type` boundaries
// in the Deno libs so malformed gh CLI output produces a typed error rather
// than a late-binding runtime crash. Each validator returns a
// ValidationResult — callers decide whether to surface the error as a
// Result or log-and-fallback.

// --- GitHub milestones ---

/** Minimal milestone shape used by sync/completion/health checks. */
export interface GitHubMilestoneJson {
  title: string;
  number: number;
}

/**
 * Validate unknown data as an array of GitHub milestones.
 *
 * @param data - Unknown data (typically from JSON.parse)
 * @returns Validated milestones or a ValidationError
 */
export function validateGitHubMilestonesJson(
  data: unknown,
): ValidationResult<GitHubMilestoneJson[]> {
  if (!Array.isArray(data)) {
    return fail("root", `Expected array, got ${typeof data}`);
  }
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!isObject(item)) {
      return fail(`milestones[${i}]`, "Expected object");
    }
    if (typeof item.title !== "string") {
      return fail(
        `milestones[${i}].title`,
        `Expected string, got ${typeof item.title}`,
      );
    }
    if (typeof item.number !== "number") {
      return fail(
        `milestones[${i}].number`,
        `Expected number, got ${typeof item.number}`,
      );
    }
  }
  return ok(data as GitHubMilestoneJson[]);
}

// --- Issue number list (used for closed issue checks, etc.) ---

/**
 * Validate unknown data as an array of `{ number: number }`.
 *
 * Matches gh output where only the issue number field was requested.
 */
export function validateIssueNumberListJson(
  data: unknown,
): ValidationResult<{ number: number }[]> {
  if (!Array.isArray(data)) {
    return fail("root", `Expected array, got ${typeof data}`);
  }
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!isObject(item)) {
      return fail(`items[${i}]`, "Expected object");
    }
    if (typeof item.number !== "number") {
      return fail(
        `items[${i}].number`,
        `Expected number, got ${typeof item.number}`,
      );
    }
  }
  return ok(data as { number: number }[]);
}

// --- Issue labels wrapper ---

/** `{ labels: Array<{ name: string }> }` shape. */
export interface IssueLabelsWrapperJson {
  labels: Array<{ name: string }>;
}

/**
 * Validate `{ labels: [{ name }] }` — used by gh issue view --json labels.
 */
export function validateIssueLabelsJson(
  data: unknown,
): ValidationResult<IssueLabelsWrapperJson> {
  if (!isObject(data)) {
    return fail(
      "root",
      `Expected object, got ${data === null ? "null" : typeof data}`,
    );
  }
  if (!Array.isArray(data.labels)) {
    return fail("labels", `Expected array, got ${typeof data.labels}`);
  }
  for (let i = 0; i < data.labels.length; i++) {
    const label = data.labels[i];
    if (!isObject(label) || typeof label.name !== "string") {
      return fail(
        `labels[${i}].name`,
        "Expected object with string 'name' field",
      );
    }
  }
  return ok(data as unknown as IssueLabelsWrapperJson);
}

// --- Timeline label events (label security / authorship checks) ---

/** Timeline event as returned by `gh api .../timeline`. */
export interface TimelineLabelEventJson {
  event: string;
  label?: { name: string };
  actor?: { login: string };
  /** ISO-8601 timestamp when the event occurred (Issue #1561). */
  created_at?: string;
}

/**
 * Validate a timeline events array. Only events with `event: "labeled"`
 * rely on label/actor fields, so those fields remain optional.
 */
export function validateTimelineLabelEventsJson(
  data: unknown,
): ValidationResult<TimelineLabelEventJson[]> {
  if (!Array.isArray(data)) {
    return fail("root", `Expected array, got ${typeof data}`);
  }
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!isObject(item)) {
      return fail(`timeline[${i}]`, "Expected object");
    }
    if (typeof item.event !== "string") {
      return fail(
        `timeline[${i}].event`,
        `Expected string, got ${typeof item.event}`,
      );
    }
    if (item.label !== undefined && item.label !== null) {
      if (!isObject(item.label) || typeof item.label.name !== "string") {
        return fail(
          `timeline[${i}].label.name`,
          "Expected object with string 'name' field",
        );
      }
    }
    if (item.actor !== undefined && item.actor !== null) {
      if (!isObject(item.actor) || typeof item.actor.login !== "string") {
        return fail(
          `timeline[${i}].actor.login`,
          "Expected object with string 'login' field",
        );
      }
    }
    if (item.created_at !== undefined && item.created_at !== null) {
      if (typeof item.created_at !== "string") {
        return fail(`timeline[${i}].created_at`, "Expected string");
      }
    }
  }
  return ok(data as TimelineLabelEventJson[]);
}

// --- Issue milestone wrapper ---

/** `{ milestone?: { title } | null }` shape. */
export interface IssueMilestoneWrapperJson {
  milestone?: { title: string } | null;
}

/**
 * Validate `{ milestone: { title } | null | undefined }` — used by
 * gh issue view --json milestone.
 */
export function validateIssueMilestoneJson(
  data: unknown,
): ValidationResult<IssueMilestoneWrapperJson> {
  if (!isObject(data)) {
    return fail(
      "root",
      `Expected object, got ${data === null ? "null" : typeof data}`,
    );
  }
  if (data.milestone === undefined || data.milestone === null) {
    return ok({ milestone: null });
  }
  if (!isObject(data.milestone)) {
    return fail(
      "milestone",
      `Expected object or null, got ${typeof data.milestone}`,
    );
  }
  if (typeof data.milestone.title !== "string") {
    return fail(
      "milestone.title",
      `Expected string, got ${typeof data.milestone.title}`,
    );
  }
  return ok({ milestone: { title: data.milestone.title as string } });
}

// --- Issue body wrapper ---

/** `{ body?: string }` shape — used by gh issue view --json body. */
export interface IssueBodyWrapperJson {
  body?: string;
}

/**
 * Validate `{ body?: string }`. The body field is optional; when present
 * it must be a string.
 */
export function validateIssueBodyJson(
  data: unknown,
): ValidationResult<IssueBodyWrapperJson> {
  if (!isObject(data)) {
    return fail(
      "root",
      `Expected object, got ${data === null ? "null" : typeof data}`,
    );
  }
  if (data.body === undefined || data.body === null) {
    return ok({});
  }
  if (typeof data.body !== "string") {
    return fail("body", `Expected string, got ${typeof data.body}`);
  }
  return ok({ body: data.body });
}

// --- Issue state wrapper ---

/** `{ number, state, title }` — used by gh issue view --json number,state,title. */
export interface IssueStateJson {
  number: number;
  state: string;
  title: string;
}

/**
 * Validate an issue state response.
 */
export function validateIssueStateJson(
  data: unknown,
): ValidationResult<IssueStateJson> {
  if (!isObject(data)) {
    return fail(
      "root",
      `Expected object, got ${data === null ? "null" : typeof data}`,
    );
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
  return ok({
    number: data.number as number,
    state: data.state as string,
    title: data.title as string,
  });
}

// --- Full issue view (diagnose) ---

/**
 * Shape returned by `gh issue view ... --json number,title,assignees,url,
 * labels,createdAt,author,milestone`.
 */
export interface GhIssueViewJson {
  number: number;
  title: string;
  url: string;
  assignees: Array<{ login: string }>;
  labels: Array<{ name: string }>;
  createdAt: string;
  author: { login: string };
  milestone?: { title: string } | null;
}

/**
 * Validate the full issue view JSON (with assignees, labels, etc.).
 */
export function validateGhIssueViewJson(
  data: unknown,
): ValidationResult<GhIssueViewJson> {
  if (!isObject(data)) {
    return fail(
      "root",
      `Expected object, got ${data === null ? "null" : typeof data}`,
    );
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
    return fail(
      "author",
      `Expected object, got ${
        data.author === null ? "null" : typeof data.author
      }`,
    );
  }
  if (typeof data.author.login !== "string") {
    return fail(
      "author.login",
      `Expected string, got ${typeof data.author.login}`,
    );
  }

  if (!Array.isArray(data.assignees)) {
    return fail("assignees", `Expected array, got ${typeof data.assignees}`);
  }
  for (let i = 0; i < data.assignees.length; i++) {
    const a = data.assignees[i];
    if (!isObject(a) || typeof a.login !== "string") {
      return fail(
        `assignees[${i}].login`,
        "Expected object with string 'login' field",
      );
    }
  }

  if (!Array.isArray(data.labels)) {
    return fail("labels", `Expected array, got ${typeof data.labels}`);
  }
  for (let i = 0; i < data.labels.length; i++) {
    const l = data.labels[i];
    if (!isObject(l) || typeof l.name !== "string") {
      return fail(
        `labels[${i}].name`,
        "Expected object with string 'name' field",
      );
    }
  }

  // milestone is optional
  if (data.milestone !== undefined && data.milestone !== null) {
    if (!isObject(data.milestone) || typeof data.milestone.title !== "string") {
      return fail(
        "milestone.title",
        "Expected object with string 'title' field",
      );
    }
  }

  return ok(data as unknown as GhIssueViewJson);
}

// --- Default branch cache entries ---

/** One entry in the persistent default-branch cache. */
export interface DefaultBranchCacheEntryJson {
  branch: string;
  fetchedAt: number;
}

/**
 * Validate a `Record<string, {branch, fetchedAt}>` persisted cache.
 *
 * Entries that fail validation are dropped (rather than rejecting the
 * whole cache) so a single corrupt entry does not invalidate the file.
 * Returns the validated entries as a plain record.
 */
export function validateDefaultBranchCacheJson(
  data: unknown,
): ValidationResult<Record<string, DefaultBranchCacheEntryJson>> {
  if (!isObject(data)) {
    return fail(
      "root",
      `Expected object, got ${data === null ? "null" : typeof data}`,
    );
  }
  const validated: Record<string, DefaultBranchCacheEntryJson> = {};
  for (const [key, entry] of Object.entries(data)) {
    if (
      isObject(entry) &&
      typeof entry.branch === "string" &&
      typeof entry.fetchedAt === "number"
    ) {
      validated[key] = { branch: entry.branch, fetchedAt: entry.fetchedAt };
    }
    // Silently drop malformed entries — the cache is best-effort.
  }
  return ok(validated);
}
