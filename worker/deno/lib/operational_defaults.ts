/**
 * Operational defaults — internal tuning parameters.
 *
 * Single source of truth for operational constants that are not typically
 * user-configurable. These are internal plumbing parameters — timeouts, TTLs,
 * retry limits, backoff thresholds, and other values that were previously
 * hardcoded as magic numbers in individual shell modules.
 *
 * User-configurable defaults (labels, model selection, scan intervals) remain
 * in config_defaults.ts. This file covers the operational plumbing constants.
 *
 * Issue #692: Centralise hardcoded operational constants into a shared module.
 * Issue #907: Migrated from worker/shared/operational_defaults.sh to Deno.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

/**
 * All operational default values as a readonly object.
 *
 * The `: "${VAR:=default}"` pattern in shell is replaced by the load-config
 * command outputting these as `export VAR="${VAR:-value}"` — only setting
 * if not already defined, allowing environment-variable overrides.
 */
export const SHELL_OPERATIONAL_DEFAULTS = {
  // --- Token Estimation ---
  /** Approximate characters per token for English text (claude_runner.sh) */
  CHARS_PER_TOKEN: "4",

  // --- Evidence and Output Paths ---
  /** Default directory for screenshot evidence files (pr_manager.sh) */
  SCREENSHOT_EVIDENCE_DIR: "docs/evidence",

  // --- Git Operation Timeouts (Issue #619) ---
  /** Timeout for standard git commands (fetch, push) in seconds */
  GIT_COMMAND_TIMEOUT: "60",
  /** Timeout for merge/rebase/pull operations in seconds */
  GIT_MERGE_TIMEOUT: "120",

  // --- GitHub CLI Timeouts (Issue #619) ---
  /** Timeout for individual gh CLI commands in seconds */
  GH_COMMAND_TIMEOUT: "60",
  /** Timeout for gh repo clone operations in seconds */
  GH_CLONE_TIMEOUT: "600",
  /** Rate-limit circuit breaker cooldown in seconds (Issue #650) */
  GH_RATE_LIMIT_COOLDOWN: "300",

  // --- Stuck Issue Detection (Issue #632, #604) ---
  /** Grace period for assigned issues with no heartbeat (seconds) */
  ASSIGNED_NO_HEARTBEAT_TIMEOUT: "1800",
  /** Timeout for GitHub-based stale assignment recovery (seconds) */
  STALE_ASSIGNMENT_TIMEOUT: "14400",

  // --- Cache TTLs ---
  /** Health check cache time-to-live in seconds */
  HEALTH_CHECK_CACHE_TTL: "300",
  /** Issue cache time-to-live in seconds (Issue #626) */
  ISSUE_CACHE_TTL: "600",

  // --- Retry Configuration ---
  /** Maximum retry attempts for transient failures */
  RETRY_MAX_ATTEMPTS: "4",
  /** Initial delay between retries in seconds */
  RETRY_INITIAL_DELAY: "2",
  /** Maximum seconds to honour from a Retry-After header (1 hour) */
  RATE_LIMIT_MAX_WAIT: "3600",

  // --- Circuit Breaker and Failure Tracking ---
  /** Expiry threshold for persisted circuit breaker state (seconds, 1 hour) */
  CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS: "3600",
  /** Consecutive failure threshold for operation-specific backoff escalation */
  OPERATION_BACKOFF_THRESHOLD: "2",
  /** Expiry threshold for persisted failure tracker state (seconds, 1 hour) */
  FAILURE_STATE_EXPIRY_SECONDS: "3600",

  // --- Software Update Checks (Issue #373) ---
  /** How often to check for software updates (seconds, default: 7 days) */
  SOFTWARE_UPDATE_CHECK_INTERVAL_SECONDS: "604800",
  /** Claude CLI update timeout in seconds */
  CLAUDE_UPDATE_TIMEOUT: "120",
  /** Claude CLI update kill grace period in seconds */
  CLAUDE_UPDATE_KILL_AFTER: "10",
  /** GH CLI update timeout in seconds (Issue #294) */
  GH_UPDATE_TIMEOUT: "120",
  /** GH CLI update kill grace period in seconds */
  GH_UPDATE_KILL_AFTER: "10",
  /** Deno update timeout in seconds */
  DENO_UPDATE_TIMEOUT: "120",
  /** Deno update kill grace period in seconds */
  DENO_UPDATE_KILL_AFTER: "10",

  // --- Crash Notification (Issue #634) ---
  /** Minimum seconds between crash notifications to prevent spam */
  CRASH_NOTIFICATION_COOLDOWN_SECONDS: "600",

  // --- Claude Runner Operational Constants ---
  /** Minimum timeout (seconds) before enabling progress monitoring */
  PROGRESS_MONITOR_MIN_TIMEOUT: "60",
  /** Number of tail lines to scan for rate-limit / auth error patterns */
  ERROR_SCAN_TAIL_LINES: "30",
  /** Heartbeat update interval in seconds (2-5 minute range, Issue #622) */
  HEARTBEAT_UPDATE_INTERVAL: "120",

  // --- Comment Filtering ---
  /** Maximum characters to keep from a bot answer before truncating */
  ANSWER_TRUNCATE_LENGTH: "500",

  // --- Pre-Setup Command (Issue #484) ---
  /** Timeout for repository pre-setup commands in seconds */
  PRE_SETUP_TIMEOUT: "300",

  // --- Issue Query Limits ---
  /** Default limit for gh issue list queries */
  GH_ISSUE_LIST_LIMIT: "50",
} as const;

/**
 * Type for the keys of SHELL_OPERATIONAL_DEFAULTS.
 */
export type OperationalDefaultKey = keyof typeof SHELL_OPERATIONAL_DEFAULTS;

/**
 * Get an operational default value by key.
 *
 * Returns the default value as a string, matching the shell convention
 * where all values are strings.
 */
export function getOperationalDefault(key: OperationalDefaultKey): string {
  return SHELL_OPERATIONAL_DEFAULTS[key];
}

/**
 * Get all operational default keys.
 */
export function getOperationalDefaultKeys(): readonly OperationalDefaultKey[] {
  return Object.keys(SHELL_OPERATIONAL_DEFAULTS) as OperationalDefaultKey[];
}
