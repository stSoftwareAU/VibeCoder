#!/bin/bash

################################################################################
# worker/shared/deno_bridge.sh
#
# Bridge between shell scripts and the Deno worker module.
# This module provides functions to call Deno commands from shell scripts,
# enabling the use of TypeScript for complex business logic.
#
# Deno is a required dependency (Issue #518). Call require_deno() at startup
# to fail fast if Deno is not installed.
#
# Issue #134 - Refactor worker for maintainability and extendability
################################################################################

# Locate the Deno executable
# Checks common installation locations in order of preference
_find_deno() {
    local deno_cmd=""

    # Check if deno is in PATH
    if command -v deno &>/dev/null; then
        deno_cmd="deno"
    # Check user's local Deno installation
    elif [[ -x "$HOME/.deno/bin/deno" ]]; then
        deno_cmd="$HOME/.deno/bin/deno"
    # Check Homebrew installation on macOS (Apple Silicon)
    elif [[ -x "/opt/homebrew/bin/deno" ]]; then
        deno_cmd="/opt/homebrew/bin/deno"
    # Check Homebrew installation on macOS (Intel)
    elif [[ -x "/usr/local/bin/deno" ]]; then
        deno_cmd="/usr/local/bin/deno"
    fi

    echo "$deno_cmd"
}

# Global Deno command path (cached for performance)
_DENO_CMD=""

# require_deno — Verify Deno is installed (required dependency)
#
# Deno is required for TypeScript business logic (Issue #518).
# Call this at worker startup to fail fast with a clear error.
#
# Returns:
#   0 if Deno is found (sets _DENO_CMD)
#   1 with error message if Deno is not installed
#
require_deno() {
    if [[ -z "$_DENO_CMD" ]]; then
        _DENO_CMD=$(_find_deno)
    fi

    if [[ -z "$_DENO_CMD" ]]; then
        echo "ERROR: Deno is required but not installed." >&2
        echo "Deno is core to Vibe Coder for TypeScript business logic." >&2
        echo "Install from: https://deno.com/ or with: curl -fsSL https://deno.land/install.sh | sh" >&2
        return 1
    fi

    return 0
}

# Get the path to the Deno worker module
_get_deno_worker_dir() {
    local script_dir
    script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
    echo "${script_dir}/../deno"
}

# Run a Deno worker command
#
# Arguments:
#   $1 - Command name (e.g., "version", "assess-clarity")
#   $@ - Additional arguments to pass to the command
#
# Returns:
#   Command output on stdout
#   Exit code from Deno
#
# Example:
#   deno_run_command "version"
#   deno_run_command "assess-clarity" --title "Fix bug" --body "Description"
#
# Only define deno_run_command if not already defined (allows test mocking)
if ! declare -F deno_run_command >/dev/null 2>&1; then
deno_run_command() {
    local command="$1"
    shift

    # Ensure Deno is available
    if [[ -z "$_DENO_CMD" ]]; then
        _DENO_CMD=$(_find_deno)
    fi

    if [[ -z "$_DENO_CMD" ]]; then
        echo "ERROR: Deno is not installed" >&2
        return 1
    fi

    local deno_worker_dir
    deno_worker_dir=$(_get_deno_worker_dir)

    if [[ ! -f "${deno_worker_dir}/mod.ts" ]]; then
        echo "ERROR: Deno worker module not found at ${deno_worker_dir}" >&2
        return 1
    fi

    # Run the Deno module with appropriate permissions
    # --frozen + --lock: Fail closed on dependency drift (Issue #2896).
    #   The committed worker/deno/deno.lock is enforced regardless of CWD; a
    #   stale or missing lockfile becomes a hard error instead of a silent
    #   re-resolve/rewrite that could pull in unreviewed transitive code.
    # --allow-env: For reading configuration from environment variables
    # --allow-read: For reading config files
    # --allow-run: For executing gh CLI commands
    # --allow-write: For writing temporary files
    # --allow-net: For potential future network operations
    # --allow-sys=hostname: For resolving machine hostname (Issue #1058)
    "$_DENO_CMD" run \
        --frozen \
        --lock="${deno_worker_dir}/deno.lock" \
        --allow-env \
        --allow-read \
        --allow-run \
        --allow-write \
        --allow-net \
        --allow-sys=hostname \
        "${deno_worker_dir}/mod.ts" \
        "$command" \
        "$@"
}
fi # end guard: deno_run_command

# =============================================================================
# Issue #905: Thin shell wrappers for migrated GitHub modules.
#
# These functions provide the same interface as the deleted shell scripts
# (gh_auth.sh, gh_wrapper.sh, github_status.sh) but delegate all business
# logic to Deno TypeScript via deno_run_command.
# =============================================================================

# --- gh_auth wrappers (migrated from gh_auth.sh, Issue #587/905) ---
#
# Authentication verification orchestration. The pure logic (error pattern
# matching, message formatting) lives in Deno TypeScript
# (worker/deno/lib/gh_auth.ts). Shell handles the `gh auth status` call.

# is_gh_auth_error — Check whether error output indicates an auth failure.
# Delegates to Deno TypeScript (Issue #1123).
is_gh_auth_error() {
    local error_output="${1:-}"
    [[ -z "$error_output" ]] && return 1

    local result
    result=$(deno_run_command "gh-auth" \
        --operation "is-auth-error" \
        --error-output "$error_output" 2>/dev/null) || return 1
    [[ "$result" == "IS_AUTH_ERROR" ]]
}

# gh_auth_actionable_message — Return human-readable fix instructions.
gh_auth_actionable_message() {
    if [[ -n "${GH_CONFIG_DIR:-}" ]]; then
        echo "gh auth expired in GH_CONFIG_DIR=${GH_CONFIG_DIR} — run: GH_CONFIG_DIR=${GH_CONFIG_DIR} gh auth refresh"
    else
        echo "gh auth expired — run: gh auth refresh"
    fi
}

# check_gh_auth — Verify that gh CLI authentication is valid.
# Delegates to Deno TypeScript (Issue #1123).
check_gh_auth() {
    local skip_flag="false"
    [[ "${VIBE_SKIP_AUTH_CHECK:-}" == "true" ]] && skip_flag="true"

    local result
    result=$(deno_run_command "gh-auth" \
        --operation "check-auth" \
        --skip-auth-check "$skip_flag" \
        --gh-config-dir "${GH_CONFIG_DIR:-}" 2>/dev/null) || {
        local message
        message="$(gh_auth_actionable_message)"
        if declare -f log &>/dev/null; then
            log "ERROR: gh auth check failed"
            log "ACTION REQUIRED: ${message}"
        fi
        echo "ERROR: ${message}" >&2
        return 1
    }

    # Deno exits non-zero when auth is invalid
    return 0
}

# --- gh_wrapper wrappers (migrated from gh_wrapper.sh, Issue #619/650) ---
#
# The business logic (circuit breaker state, error classification) lives in
# Deno TypeScript (worker/deno/lib/gh_wrapper.ts). The shell functions below
# handle orchestration: calling `gh` with timeout, checking/writing the
# file-based circuit breaker flag. This keeps the hot path fast and
# compatible with shell test mocking.

# Default timeout for gh commands (seconds).
: "${GH_COMMAND_TIMEOUT:=60}"

# Default cooldown for rate limit circuit breaker (seconds).
: "${GH_RATE_LIMIT_COOLDOWN:=300}"

# Rate limit exit code (matches retry.sh RATE_LIMIT_EXIT_CODE).
_GH_RATE_LIMIT_EXIT_CODE=223

# _gh_rate_limit_flag_file — Get the path to the circuit breaker flag file.
_gh_rate_limit_flag_file() {
    local flag_dir="${GH_RATE_LIMIT_FLAG_DIR:-${WORK_DIR:-${TMPDIR:-/tmp}}}"
    echo "${flag_dir}/.gh_rate_limit_active"
}

# _gh_rate_limit_is_active — Check if the rate limit circuit breaker is active.
# Delegates to Deno TypeScript (Issue #1123).
_gh_rate_limit_is_active() {
    local result
    result=$(deno_run_command "gh-wrapper" \
        --operation "is-rate-limit-active" \
        --rate-limit-flag-dir "${GH_RATE_LIMIT_FLAG_DIR:-${WORK_DIR:-${TMPDIR:-/tmp}}}" \
        --rate-limit-cooldown "${GH_RATE_LIMIT_COOLDOWN}" 2>/dev/null) || return 1
    [[ "$result" == "ACTIVE" ]]
}

# _gh_rate_limit_trip — Activate the rate limit circuit breaker.
# Delegates to Deno TypeScript (Issue #1123).
_gh_rate_limit_trip() {
    local result
    result=$(deno_run_command "gh-wrapper" \
        --operation "trip-rate-limit" \
        --rate-limit-flag-dir "${GH_RATE_LIMIT_FLAG_DIR:-${WORK_DIR:-${TMPDIR:-/tmp}}}" \
        --rate-limit-cooldown "${GH_RATE_LIMIT_COOLDOWN}" 2>/dev/null) || true

    if [[ "$result" == "TRIPPED" ]]; then
        if declare -F log >/dev/null 2>&1; then
            log "Rate limit circuit breaker activated — skipping GH API calls for ${GH_RATE_LIMIT_COOLDOWN}s (Issue #650)"
        fi
    fi
}

# gh_rate_limit_circuit_breaker_reset — Reset the rate limit circuit breaker.
# Delegates to Deno TypeScript (Issue #1123).
gh_rate_limit_circuit_breaker_reset() {
    deno_run_command "gh-wrapper" \
        --operation "reset-circuit-breaker" \
        --rate-limit-flag-dir "${GH_RATE_LIMIT_FLAG_DIR:-${WORK_DIR:-${TMPDIR:-/tmp}}}" \
        >/dev/null 2>&1 || true
}

# safe_gh_command — Execute a gh CLI command with timeout and circuit breaker.
#
# Checks the file-based rate limit circuit breaker, then wraps the gh CLI
# invocation with $TIMEOUT_CMD. If the command returns exit code 223
# (rate limit), the circuit breaker is tripped.
safe_gh_command() {
    # Check rate limit circuit breaker before making the API call
    if _gh_rate_limit_is_active; then
        return "$_GH_RATE_LIMIT_EXIT_CODE"
    fi

    # Use a longer timeout for clone operations
    local timeout_duration="${GH_COMMAND_TIMEOUT}"
    if [[ "${1:-}" == "repo" && "${2:-}" == "clone" ]]; then
        timeout_duration="${GH_CLONE_TIMEOUT:-600}"
    fi
    local timeout_cmd="${TIMEOUT_CMD:-}"
    local timeout_exit="${TIMEOUT_EXIT_CODE:-124}"

    local exit_code=0
    if [[ -n "$timeout_cmd" ]]; then
        "$timeout_cmd" "$timeout_duration" gh "$@" || exit_code=$?
    else
        gh "$@" || exit_code=$?
    fi

    if [[ "$exit_code" -eq "$timeout_exit" ]]; then
        if declare -F log >/dev/null 2>&1; then
            log "TIMEOUT: gh $* timed out after ${timeout_duration}s (Issue #619)"
        fi
    fi

    # Trip the circuit breaker on rate limit detection
    if [[ "$exit_code" -eq "$_GH_RATE_LIMIT_EXIT_CODE" ]]; then
        _gh_rate_limit_trip
    fi

    return "$exit_code"
}

# is_gh_timeout — Check if an exit code indicates a timeout.
is_gh_timeout() {
    local exit_code="$1"
    local timeout_exit="${TIMEOUT_EXIT_CODE:-124}"
    [[ "$exit_code" -eq "$timeout_exit" ]]
}

# --- github_status wrappers (migrated from github_status.sh, Issue #409/905) ---
#
# GitHub user status management. Pure logic (emoji selection, message building)
# lives in Deno TypeScript (worker/deno/lib/github_status.ts). Shell handles
# the `gh api graphql` calls (orchestration).

# set_gh_user_status — Update the GitHub user status.
# Delegates to Deno TypeScript (Issue #1123).
set_gh_user_status() {
    [[ "${UPDATE_GH_USER_STATUS:-}" == "true" ]] || return 0

    local state="$1"
    local repo="${2:-}"
    local number="${3:-}"
    local title="${4:-}"

    deno_run_command "github-status" \
        --operation "set-status" \
        --state "$state" \
        --repo "$repo" \
        --number "$number" \
        --title "$title" >/dev/null 2>&1 || {
            if type log_warning &>/dev/null; then
                log_warning "Failed to update GitHub user status (missing 'user' scope?)"
            fi
        }
    return 0
}

# clear_gh_user_status — Clear the GitHub user status.
# Delegates to Deno TypeScript (Issue #1123).
clear_gh_user_status() {
    [[ "${UPDATE_GH_USER_STATUS:-}" == "true" ]] || return 0

    deno_run_command "github-status" \
        --operation "clear-status" >/dev/null 2>&1 || {
            if type log_warning &>/dev/null; then
                log_warning "Failed to clear GitHub user status"
            fi
        }
    return 0
}

# set_gh_status_working — Set status to working.
set_gh_status_working() { set_gh_user_status "working" "$1" "$2" "$3"; }

# set_gh_status_idle — Set status to idle.
set_gh_status_idle() { set_gh_user_status "idle"; }

# set_gh_status_success — Set status to success.
set_gh_status_success() { set_gh_user_status "success" "$1" "$2" "$3"; }

# set_gh_status_failure — Set status to failure.
set_gh_status_failure() { set_gh_user_status "failure" "$1" "$2" "$3"; }

# check_gh_status_available — Check if GitHub status updates are available.
# Delegates to Deno TypeScript (Issue #1123).
check_gh_status_available() {
    [[ "${UPDATE_GH_USER_STATUS:-}" == "true" ]] || return 1

    local result
    result=$(deno_run_command "github-status" \
        --operation "check-available" 2>/dev/null) || return 1
    [[ "$result" == "AVAILABLE" ]]
}

# =============================================================================
# Issue #906: Thin shell wrappers for migrated logging, health check cache,
# and software updates modules.
#
# Logging functions are kept as pure shell (hot path — spawning Deno per log
# call would be prohibitive). Health check cache and software updates delegate
# to Deno TypeScript via deno_run_command.
# =============================================================================

# --- Logging wrappers (migrated from logging.sh, Issue #906) ---
#
# These provide the same interface as the deleted logging.sh. The business
# logic (structured logging, log levels) lives in Deno TypeScript
# (worker/deno/lib/logger.ts). Shell keeps a minimal implementation for
# hot-path log calls.

# LOG_FILE should be set by the parent script, default to stderr-only if not
LOG_FILE="${LOG_FILE:-/dev/stderr}"

# Security audit log file (optional, for separate security event tracking)
SECURITY_LOG_FILE="${SECURITY_LOG_FILE:-}"

# Metrics file for timing data (optional, for operator review)
METRICS_FILE="${METRICS_FILE:-}"

_get_timestamp() {
    # Issue #1904: emit UTC with trailing `Z` so worker logs are unambiguous
    # and consistent with the Deno logger output.
    date -u '+%Y-%m-%d %H:%M:%SZ'
}

_log_level_to_num() {
    local level
    level=$(echo "$1" | tr '[:lower:]' '[:upper:]')
    case "$level" in
        DEBUG)   echo "0" ;;
        INFO)    echo "1" ;;
        WARNING) echo "2" ;;
        ERROR)   echo "3" ;;
        *)       echo "1" ;;
    esac
}

_should_log() {
    local message_level_num
    local configured_level_num
    message_level_num=$(_log_level_to_num "$1")
    configured_level_num=$(_log_level_to_num "${LOG_LEVEL:-INFO}")
    [[ "$message_level_num" -ge "$configured_level_num" ]]
}

log() {
    _should_log "INFO" || return 0
    local timestamp
    timestamp=$(_get_timestamp)
    echo "[$timestamp] INFO: $*" >> "$LOG_FILE"
    echo "[$timestamp] INFO: $*" >> /dev/stderr
}

log_silent() {
    local timestamp
    timestamp=$(_get_timestamp)
    echo "[$timestamp] $*" >> "$LOG_FILE"
}

log_debug() {
    _should_log "DEBUG" || return 0
    local timestamp
    timestamp=$(_get_timestamp)
    echo "[$timestamp] DEBUG: $*" >> "$LOG_FILE"
    echo "[$timestamp] DEBUG: $*" >> /dev/stderr
}

log_warning() {
    _should_log "WARNING" || return 0
    local timestamp
    timestamp=$(_get_timestamp)
    echo "[$timestamp] WARNING: $*" >> "$LOG_FILE"
    echo "[$timestamp] WARNING: $*" >> /dev/stderr
}

error_exit() {
    local timestamp
    timestamp=$(_get_timestamp)
    echo "[$timestamp] ERROR: $*" >> "$LOG_FILE"
    echo "[$timestamp] ERROR: $*" >> /dev/stderr
    exit 1
}

_format_duration() {
    local total_seconds="$1"
    local hours=$((total_seconds / 3600))
    local minutes=$(( (total_seconds % 3600) / 60 ))
    local seconds=$((total_seconds % 60))

    if [[ $hours -gt 0 ]]; then
        echo "${hours}h ${minutes}m"
    elif [[ $minutes -gt 0 ]]; then
        echo "${minutes}m ${seconds}s"
    else
        echo "${seconds}s"
    fi
}

log_skip_reason() {
    local reason_code="$1"
    local details="$2"
    local timestamp
    timestamp=$(_get_timestamp)

    local log_line="[$timestamp] [SKIP] [$reason_code] $details"
    _should_log "DEBUG" || return 0

    echo "$log_line" >> "$LOG_FILE"
    echo "$log_line" >> /dev/stderr
}

log_timing() {
    local operation="$1"
    local duration_seconds="$2"
    local details="${3:-}"
    local timestamp
    timestamp=$(_get_timestamp)

    local human_duration
    human_duration=$(_format_duration "$duration_seconds")

    local log_line="[$timestamp] [TIMING] [$operation] duration=${duration_seconds}s human=${human_duration}"
    if [[ -n "$details" ]]; then
        log_line="$log_line $details"
    fi

    _should_log "INFO" || return 0

    echo "$log_line" >> "$LOG_FILE"
    echo "$log_line" >> /dev/stderr

    if [[ -n "$METRICS_FILE" ]]; then
        local metrics_dir
        metrics_dir=$(dirname "$METRICS_FILE")
        if [[ ! -d "$metrics_dir" ]]; then
            mkdir -p "$metrics_dir" 2>/dev/null || true
        fi
        echo "$log_line" >> "$METRICS_FILE"
    fi
}

log_scan_summary() {
    local repos_scanned="$1"
    local issues_found="$2"
    local issues_skipped="$3"
    local skip_reasons="${4:-none}"
    local timestamp
    timestamp=$(_get_timestamp)

    local log_line="[$timestamp] [SCAN_SUMMARY] repos_scanned=$repos_scanned issues_found=$issues_found issues_skipped=$issues_skipped reasons=$skip_reasons"

    _should_log "INFO" || return 0

    echo "$log_line" >> "$LOG_FILE"
    echo "$log_line" >> /dev/stderr
}

log_worker_summary() {
    local issues_processed="$1"
    local duration_seconds="$2"
    local timestamp
    timestamp=$(_get_timestamp)

    local human_duration
    human_duration=$(_format_duration "$duration_seconds")

    local avg="0"
    if [[ "$issues_processed" -gt 0 ]] && [[ "$duration_seconds" -gt 0 ]]; then
        avg=$((duration_seconds / issues_processed))
    fi

    local log_line="[$timestamp] [WORKER_SUMMARY] issues_processed=$issues_processed duration=${duration_seconds}s human=${human_duration} avg=${avg}s_per_issue"

    _should_log "INFO" || return 0

    echo "$log_line" >> "$LOG_FILE"
    echo "$log_line" >> /dev/stderr

    if [[ -n "$METRICS_FILE" ]]; then
        local metrics_dir
        metrics_dir=$(dirname "$METRICS_FILE")
        if [[ ! -d "$metrics_dir" ]]; then
            mkdir -p "$metrics_dir" 2>/dev/null || true
        fi
        echo "$log_line" >> "$METRICS_FILE"
    fi
}

log_security() {
    local event_type="$1"
    local details="$2"
    local timestamp
    timestamp=$(_get_timestamp)

    local log_line="[$timestamp] [SECURITY] [$event_type] $details"

    echo "$log_line" >> "$LOG_FILE"
    echo "$log_line" >> /dev/stderr

    if [[ -n "$SECURITY_LOG_FILE" ]]; then
        local security_log_dir
        security_log_dir=$(dirname "$SECURITY_LOG_FILE")
        if [[ ! -d "$security_log_dir" ]]; then
            mkdir -p "$security_log_dir" 2>/dev/null || true
        fi
        echo "$log_line" >> "$SECURITY_LOG_FILE"
    fi
}

# --- Health check cache wrappers (migrated from health_check_cache.sh, Issue #906) ---
#
# These delegate to the Deno health-check-cache command. The file-based cache
# logic lives in worker/deno/lib/health_check_cache.ts.

is_health_cache_valid() {
    local check_type="${1:?check_type required}"
    local ttl="${2:-${HEALTH_CHECK_CACHE_TTL:-300}}"
    local work_dir="${WORK_DIR:-.}"

    local result
    result=$(deno_run_command "health-check-cache" \
        --action "is-valid" \
        --check-type "$check_type" \
        --work-dir "$work_dir" \
        --ttl "$ttl" 2>/dev/null) || return 1

    [[ "$result" == "valid" ]]
}

record_health_check_success() {
    local check_type="${1:?check_type required}"
    local work_dir="${WORK_DIR:-.}"

    deno_run_command "health-check-cache" \
        --action "record-success" \
        --check-type "$check_type" \
        --work-dir "$work_dir" >/dev/null 2>&1 || true
}

invalidate_health_cache() {
    local check_type="${1:?check_type required}"
    local work_dir="${WORK_DIR:-.}"

    deno_run_command "health-check-cache" \
        --action "invalidate" \
        --check-type "$check_type" \
        --work-dir "$work_dir" >/dev/null 2>&1 || true
}

cached_check_claude_health() {
    if is_health_cache_valid "claude"; then
        log "Claude health check skipped (cached, still valid)"
        return 0
    fi

    local exit_code=0
    set +e
    check_claude_health
    exit_code=$?
    set -e

    if [[ "$exit_code" -eq 0 ]]; then
        record_health_check_success "claude"
    else
        invalidate_health_cache "claude"
    fi

    return "$exit_code"
}

cached_check_gh_auth() {
    if is_health_cache_valid "gh_auth"; then
        log "GitHub auth check skipped (cached, still valid)"
        return 0
    fi

    local exit_code=0
    set +e
    check_gh_auth
    exit_code=$?
    set -e

    if [[ "$exit_code" -eq 0 ]]; then
        record_health_check_success "gh_auth"
    else
        invalidate_health_cache "gh_auth"
    fi

    return "$exit_code"
}

# --- Software updates wrapper (migrated from software_updates.sh, Issue #906) ---
#
# Delegates to the Deno software-updates command. The update orchestration
# logic lives in worker/deno/lib/software_updates.ts.

check_software_updates() {
    deno_run_command "software-updates" \
        --timestamp-dir "${SOFTWARE_UPDATE_TIMESTAMP_DIR:-$HOME}" \
        --interval "${SOFTWARE_UPDATE_CHECK_INTERVAL_SECONDS:-604800}" \
        --timeout "${CLAUDE_UPDATE_TIMEOUT:-120}" \
        2>&1 || true
}

# =============================================================================
# Issue #908: Thin shell wrappers for migrated resilience modules.
#
# These functions provide the same interface as the deleted shell scripts
# (circuit_breaker.sh, failure_tracker.sh, cooldown_state.sh) but delegate
# all business logic to Deno TypeScript via deno_run_command.
# =============================================================================

# Shell-visible defaults for resilience parameters (previously set by sourced scripts).
: "${MAX_CONSECUTIVE_FAILURES:=3}"

# --- Circuit breaker wrappers (migrated from circuit_breaker.sh, Issue #588/908) ---

# circuit_breaker_record_zero_progress — Record a zero-progress scan cycle.
circuit_breaker_record_zero_progress() {
    local result
    result=$(deno_run_command "circuit-breaker" \
        --operation "record-zero-progress" \
        --work-dir "${WORK_DIR:-}" \
        --threshold "${CIRCUIT_BREAKER_THRESHOLD:-3}" \
        --sleep-interval "${SLEEP_INTERVAL:-30}" \
        --credit-wait-interval "${CREDIT_WAIT_INTERVAL:-300}" \
        --state-expiry-seconds "${CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS:-3600}" 2>/dev/null) || true

    if [[ -n "$result" ]]; then
        local cycles="$result"
        local threshold="${CIRCUIT_BREAKER_THRESHOLD:-3}"
        if [[ "$cycles" -gt "$threshold" ]] && declare -f log &>/dev/null; then
            local interval
            interval=$(circuit_breaker_get_sleep_interval)
            log "No progress in ${cycles} cycles — backing off to ${interval}s between scans"
        fi
    fi
}

# circuit_breaker_reset — Reset the circuit breaker (call on any success).
circuit_breaker_reset() {
    deno_run_command "circuit-breaker" \
        --operation "reset" \
        --work-dir "${WORK_DIR:-}" \
        --threshold "${CIRCUIT_BREAKER_THRESHOLD:-3}" \
        --state-expiry-seconds "${CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS:-3600}" >/dev/null 2>&1 || true
}

# circuit_breaker_get_sleep_interval — Get the current sleep interval.
circuit_breaker_get_sleep_interval() {
    local result
    result=$(deno_run_command "circuit-breaker" \
        --operation "get-sleep-interval" \
        --work-dir "${WORK_DIR:-}" \
        --threshold "${CIRCUIT_BREAKER_THRESHOLD:-3}" \
        --sleep-interval "${SLEEP_INTERVAL:-30}" \
        --credit-wait-interval "${CREDIT_WAIT_INTERVAL:-300}" \
        --state-expiry-seconds "${CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS:-3600}" 2>/dev/null) || true
    echo "${result:-${SLEEP_INTERVAL:-30}}"
}

# circuit_breaker_is_active — Check if the circuit breaker backoff is active.
circuit_breaker_is_active() {
    local result
    result=$(deno_run_command "circuit-breaker" \
        --operation "is-active" \
        --work-dir "${WORK_DIR:-}" \
        --threshold "${CIRCUIT_BREAKER_THRESHOLD:-3}" \
        --state-expiry-seconds "${CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS:-3600}" 2>/dev/null) || true
    [[ "$result" == "ACTIVE" ]]
}

# operation_backoff_record_failure — Record a failure for a specific operation.
operation_backoff_record_failure() {
    local operation="$1"
    deno_run_command "circuit-breaker" \
        --operation "record-operation-failure" \
        --op-name "$operation" \
        --work-dir "${WORK_DIR:-}" \
        --sleep-interval "${SLEEP_INTERVAL:-30}" \
        --credit-wait-interval "${CREDIT_WAIT_INTERVAL:-300}" \
        --operation-backoff-threshold "${OPERATION_BACKOFF_THRESHOLD:-2}" \
        --state-expiry-seconds "${CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS:-3600}" >/dev/null 2>&1 || true
}

# operation_backoff_reset — Reset the failure counter for an operation.
operation_backoff_reset() {
    local operation="$1"
    deno_run_command "circuit-breaker" \
        --operation "reset-operation" \
        --op-name "$operation" \
        --work-dir "${WORK_DIR:-}" \
        --state-expiry-seconds "${CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS:-3600}" >/dev/null 2>&1 || true
}

# operation_backoff_get_failure_count — Get failure count for an operation.
operation_backoff_get_failure_count() {
    local operation="$1"
    local result
    result=$(deno_run_command "circuit-breaker" \
        --operation "get-operation-failure-count" \
        --op-name "$operation" \
        --work-dir "${WORK_DIR:-}" \
        --state-expiry-seconds "${CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS:-3600}" 2>/dev/null) || true
    echo "${result:-0}"
}

# operation_backoff_get_sleep_interval — Get backoff interval for an operation.
operation_backoff_get_sleep_interval() {
    local operation="$1"
    local result
    result=$(deno_run_command "circuit-breaker" \
        --operation "get-operation-sleep-interval" \
        --op-name "$operation" \
        --work-dir "${WORK_DIR:-}" \
        --sleep-interval "${SLEEP_INTERVAL:-30}" \
        --credit-wait-interval "${CREDIT_WAIT_INTERVAL:-300}" \
        --operation-backoff-threshold "${OPERATION_BACKOFF_THRESHOLD:-2}" \
        --state-expiry-seconds "${CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS:-3600}" 2>/dev/null) || true
    echo "${result:-${SLEEP_INTERVAL:-30}}"
}

# --- Failure tracker wrappers (migrated from failure_tracker.sh, Issue #451/908) ---

# track_failure — Record a failure for a given work item key.
track_failure() {
    local failure_key="$1"
    local result
    result=$(deno_run_command "failure-tracker" \
        --operation "track-failure" \
        --failure-key "$failure_key" \
        --work-dir "${WORK_DIR:-}" \
        --max-consecutive-failures "${MAX_CONSECUTIVE_FAILURES:-3}" \
        --state-expiry-seconds "${FAILURE_STATE_EXPIRY_SECONDS:-3600}" 2>/dev/null) || true

    if declare -f log &>/dev/null && [[ -n "$result" ]]; then
        log "Consecutive failure #${result} for: ${failure_key}"
    fi
}

# reset_failures — Reset the consecutive failure counter (call on success).
reset_failures() {
    deno_run_command "failure-tracker" \
        --operation "reset-failures" \
        --work-dir "${WORK_DIR:-}" \
        --state-expiry-seconds "${FAILURE_STATE_EXPIRY_SECONDS:-3600}" >/dev/null 2>&1 || true
}

# should_exit_on_failures — Check whether the failure threshold has been reached.
should_exit_on_failures() {
    local result
    result=$(deno_run_command "failure-tracker" \
        --operation "should-exit-on-failures" \
        --work-dir "${WORK_DIR:-}" \
        --max-consecutive-failures "${MAX_CONSECUTIVE_FAILURES:-3}" \
        --state-expiry-seconds "${FAILURE_STATE_EXPIRY_SECONDS:-3600}" 2>/dev/null) || true

    if [[ "$result" == "SHOULD_EXIT" ]]; then
        if declare -f log &>/dev/null; then
            log "ERROR: Consecutive failures on same work item — exiting for restart"
        fi
        return 0
    fi
    return 1
}

# --- Cooldown state wrappers (migrated from cooldown_state.sh, Issue #633/908) ---

# record_issue_cooldown — Record that an issue failed (skip for cooldown period).
record_issue_cooldown() {
    local repo="$1"
    local issue_number="$2"
    deno_run_command "cooldown-state" \
        --operation "record-cooldown" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --work-dir "${WORK_DIR:-}" \
        --issue-retry-cooldown "${ISSUE_RETRY_COOLDOWN:-600}" >/dev/null 2>&1 || true
}

# is_issue_in_cooldown — Check if an issue is still in cooldown.
is_issue_in_cooldown() {
    local repo="$1"
    local issue_number="$2"
    local result
    result=$(deno_run_command "cooldown-state" \
        --operation "is-in-cooldown" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --work-dir "${WORK_DIR:-}" \
        --issue-retry-cooldown "${ISSUE_RETRY_COOLDOWN:-600}" 2>/dev/null) || true
    [[ "$result" == "IN_COOLDOWN" ]]
}

# --- Failure diagnosis wrappers (migrated from failure_diagnosis.sh, Issue #398/909) ---

# detect_failure_category — Analyse a failure message and return a category.
detect_failure_category() {
    local failure_message="$1"
    deno_run_command "failure-diagnosis" \
        --operation "detect-category" \
        --message "$failure_message" 2>/dev/null || echo "unknown"
}

# is_infrastructure_failure — Check if a failure category is infrastructure/transient.
is_infrastructure_failure() {
    local category="$1"
    local result
    result=$(deno_run_command "failure-diagnosis" \
        --operation "is-infrastructure" \
        --category "$category" 2>/dev/null) || true
    [[ "$result" == "true" ]]
}

# get_failure_category_display — Map category to user-facing display name.
get_failure_category_display() {
    local category="$1"
    deno_run_command "failure-diagnosis" \
        --operation "get-category-display" \
        --category "$category" 2>/dev/null || echo "unknown"
}

# get_failure_diagnosis — Return category-specific diagnosis text.
get_failure_diagnosis() {
    local category="$1"
    local clarity_status="${2:-not_assessed}"
    local diagnostic_context="${3:-}"
    deno_run_command "failure-diagnosis" \
        --operation "get-diagnosis" \
        --category "$category" \
        --clarity-status "$clarity_status" \
        --diagnostic-context "$diagnostic_context" 2>/dev/null || echo "- Failure diagnosis unavailable"
}

# get_failure_diagnosis_oneliner — Return brief one-line cause summary.
get_failure_diagnosis_oneliner() {
    local category="$1"
    local clarity_status="${2:-not_assessed}"
    deno_run_command "failure-diagnosis" \
        --operation "get-diagnosis-oneliner" \
        --category "$category" \
        --clarity-status "$clarity_status" 2>/dev/null || echo "Likely cause: could not be automatically determined."
}

# extract_key_error_lines — Extract key error lines from text.
extract_key_error_lines() {
    local text="$1"
    deno_run_command "failure-diagnosis" \
        --operation "extract-key-errors" \
        --text "$text" 2>/dev/null || true
}

# _format_zero_output_diagnostics — Format zero-output diagnostic context.
_format_zero_output_diagnostics() {
    local diagnostic_context="$1"
    deno_run_command "failure-diagnosis" \
        --operation "format-zero-output-diagnostics" \
        --diagnostic-context "$diagnostic_context" 2>/dev/null || true
}

# --- Repo failure tracker wrappers (migrated from repo_failure_tracker.sh, Issue #586/909) ---

# record_repo_failure — Record a failure for a given repository.
record_repo_failure() {
    local repo="$1"
    local result
    result=$(deno_run_command "repo-failure-tracker" \
        --operation "record-failure" \
        --repo "$repo" \
        --failure-file "${REPO_FAILURE_FILE:-}" \
        --threshold "${REPO_FAILURE_THRESHOLD:-3}" 2>/dev/null) || true
    if declare -f log &>/dev/null && [[ -n "$result" ]]; then
        log "Issue #586: Repo '$repo' failure count: $result/${REPO_FAILURE_THRESHOLD:-3} this cycle"
    fi
}

# record_repo_success — Reset failure count for a repo after success.
record_repo_success() {
    local repo="$1"
    deno_run_command "repo-failure-tracker" \
        --operation "record-success" \
        --repo "$repo" \
        --failure-file "${REPO_FAILURE_FILE:-}" >/dev/null 2>&1 || true
}

# get_repo_failure_count — Get current failure count for a repo.
get_repo_failure_count() {
    local repo="$1"
    deno_run_command "repo-failure-tracker" \
        --operation "get-failure-count" \
        --repo "$repo" \
        --failure-file "${REPO_FAILURE_FILE:-}" 2>/dev/null || echo "0"
}

# is_repo_deprioritised — Check if repo should be skipped this cycle.
is_repo_deprioritised() {
    local repo="$1"
    local result
    result=$(deno_run_command "repo-failure-tracker" \
        --operation "is-deprioritised" \
        --repo "$repo" \
        --failure-file "${REPO_FAILURE_FILE:-}" \
        --threshold "${REPO_FAILURE_THRESHOLD:-3}" 2>/dev/null) || true
    [[ "$result" == "DEPRIORITISED" ]]
}

# reset_repo_failures — Reset all repo failure counts.
reset_repo_failures() {
    deno_run_command "repo-failure-tracker" \
        --operation "reset-all" \
        --failure-file "${REPO_FAILURE_FILE:-}" >/dev/null 2>&1 || true
}

# --- Crash cleanup wrappers (migrated from crash_cleanup.sh, Issue #631/909) ---

# cleanup_in_progress_issue — Clear heartbeat and unassign if a crash occurs.
cleanup_in_progress_issue() {
    deno_run_command "crash-cleanup" \
        --operation "cleanup" \
        --repo "${_CURRENT_WORK_REPO:-}" \
        --issue-number "${_CURRENT_WORK_ISSUE:-}" \
        --github-user "${_CURRENT_WORK_USER:-}" \
        --work-dir "${WORK_DIR:-}" 2>/dev/null || true
}

# clear_heartbeat — Clear the heartbeat file for a specific issue.
clear_heartbeat() {
    local repo="$1"
    local issue_number="$2"
    deno_run_command "crash-cleanup" \
        --operation "clear-heartbeat" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --work-dir "${WORK_DIR:-}" 2>/dev/null || true
}

# --- Crash notification wrappers (migrated from crash_notification.sh, Issue #634/909) ---

# send_crash_notification — Orchestrator: send crash notifications if appropriate.
send_crash_notification() {
    local exit_code="$1"
    local repo="${2:-}"
    local issue_number="${3:-}"
    local log_tail="${4:-}"
    local claude_output="${5:-}"

    deno_run_command "crash-notification" \
        --operation "send" \
        --exit-code "$exit_code" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --log-tail "$log_tail" \
        --claude-output "$claude_output" \
        --work-stage "${_CURRENT_WORK_STAGE:-unknown}" \
        --work-start-time "${_CURRENT_WORK_START_TIME:-0}" \
        --planned-shutdown "${PLANNED_SHUTDOWN:-false}" \
        --worker-name "${WORKER_NAME:-}" \
        --state-dir "${CRASH_NOTIFICATION_STATE_DIR:-${HOME}/.vibe-coder}" \
        --cooldown-seconds "${CRASH_NOTIFICATION_COOLDOWN_SECONDS:-600}" \
        --webhook-url "${CRASH_WEBHOOK_URL:-}" 2>/dev/null || true
}

# capture_worker_log_tail — Safely read last N lines from worker log file.
capture_worker_log_tail() {
    local log_file="${1:-}"
    local line_count="${2:-80}"
    if [[ -z "$log_file" ]] || [[ ! -f "$log_file" ]] || [[ ! -s "$log_file" ]]; then
        return 0
    fi
    tail -n "$line_count" "$log_file" 2>/dev/null || true
}

# capture_claude_output_tail — Safely read last N lines from Claude output file.
capture_claude_output_tail() {
    local output_file="${1:-}"
    local line_count="${2:-100}"
    if [[ -z "$output_file" ]] || [[ ! -f "$output_file" ]] || [[ ! -s "$output_file" ]]; then
        return 0
    fi
    tail -n "$line_count" "$output_file" 2>/dev/null || true
}

# is_crash_exit — Determine whether an exit code represents an unexpected crash.
is_crash_exit() {
    local exit_code="$1"
    local result
    result=$(deno_run_command "crash-notification" \
        --operation "is-crash-exit" \
        --exit-code "$exit_code" \
        --planned-shutdown "${PLANNED_SHUTDOWN:-false}" 2>/dev/null) || true
    [[ "$result" == "CRASH" ]]
}

# format_elapsed_time — Convert seconds to human-readable elapsed time.
format_elapsed_time() {
    local seconds="$1"
    deno_run_command "crash-notification" \
        --operation "format-elapsed-time" \
        --seconds "$seconds" 2>/dev/null || echo "unknown"
}

# --- Stuck issue detector wrappers (migrated from stuck_issue_detector.sh, Issue #471/909) ---

# record_heartbeat — Write/update heartbeat for an issue.
record_heartbeat() {
    local repo="$1"
    local issue_number="$2"
    deno_run_command "stuck-issue-detector" \
        --operation "record-heartbeat" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --work-dir "${WORK_DIR:-}" >/dev/null 2>&1 || true
}

# detect_and_recover_stuck_issues — Full recovery scan on startup.
detect_and_recover_stuck_issues() {
    local github_user="$1"
    local result
    result=$(deno_run_command "stuck-issue-detector" \
        --operation "detect-and-recover" \
        --github-user "$github_user" \
        --work-dir "${WORK_DIR:-}" \
        --stuck-issue-timeout "${STUCK_ISSUE_TIMEOUT:-7200}" \
        --assigned-no-heartbeat-timeout "${ASSIGNED_NO_HEARTBEAT_TIMEOUT:-1800}" \
        --stale-assignment-timeout "${STALE_ASSIGNMENT_TIMEOUT:-14400}" 2>/dev/null) || true
    if declare -f log &>/dev/null && [[ -n "$result" ]] && [[ "$result" != "0" ]]; then
        log "Recovered $result stuck issue(s)"
    fi
}

# detect_assigned_with_closed_pr — Scan for assigned issues with closed PRs (Issue #787).
detect_assigned_with_closed_pr() {
    local github_user="$1"
    local result
    result=$(deno_run_command "stuck-issue-detector" \
        --operation "detect-closed-pr" \
        --github-user "$github_user" \
        --work-dir "${WORK_DIR:-}" 2>/dev/null) || true
    if declare -f log &>/dev/null && [[ -n "$result" ]] && [[ "$result" != "0" ]]; then
        log "Issue #787: Recovered $result issue(s) with closed PRs"
    fi
}

# --- Repo blocked alert wrappers (migrated from repo_blocked_alert.sh, Issue #745/909) ---

# record_repo_blocked — Record that a repo's issues are all blocked by PRs.
record_repo_blocked() {
    local repo="$1"
    local blocked_issue_count="$2"
    local prs_json="$3"
    deno_run_command "repo-blocked-alert" \
        --operation "record-blocked" \
        --repo "$repo" \
        --issue-count "$blocked_issue_count" \
        --prs-json "$prs_json" \
        --work-dir "${WORK_DIR:-}" \
        --alert-hours "${REPO_BLOCKED_ALERT_HOURS:-24}" >/dev/null 2>&1 || true
}

# clear_repo_blocked — Clear blocking state for a repo.
clear_repo_blocked() {
    local repo="$1"
    deno_run_command "repo-blocked-alert" \
        --operation "clear-blocked" \
        --repo "$repo" \
        --work-dir "${WORK_DIR:-}" >/dev/null 2>&1 || true
}

# check_repo_blocked_alert — Check if alert threshold is reached.
check_repo_blocked_alert() {
    local repo="$1"
    local blocked_issue_count="$2"
    local prs_json="$3"
    local result
    result=$(deno_run_command "repo-blocked-alert" \
        --operation "check-alert" \
        --repo "$repo" \
        --issue-count "$blocked_issue_count" \
        --prs-json "$prs_json" \
        --work-dir "${WORK_DIR:-}" \
        --alert-hours "${REPO_BLOCKED_ALERT_HOURS:-24}" 2>/dev/null) || true
    [[ "$result" == "ALERTED" ]]
}

# --- Claim PR comment wrapper (Issue #1061) ---

# claim_pr_comment — Atomically claim a PR comment before processing.
# Prevents multiple workers from responding to the same PR feedback.
claim_pr_comment() {
    local repo="$1"
    local pr_number="$2"
    local comment_type="$3"
    local comment_id="$4"
    local result
    result=$(deno_run_command "pr-manager" \
        --operation "claim-pr-comment" \
        --repo "$repo" \
        --pr-number "$pr_number" \
        --comment-type "$comment_type" \
        --comment-id "$comment_id" 2>/dev/null) || true
    [[ "$result" == "CLAIMED" ]]
}

# --- Claim issue wrappers (migrated from claim_issue.sh, Issue #911) ---

# claim_issue — Atomically claim an issue with verification.
claim_issue() {
    local repo="$1"
    local issue_number="$2"
    local github_user="$3"
    local result
    result=$(deno_run_command "claim-issue" \
        --operation "claim" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --github-user "$github_user" 2>/dev/null) || true
    [[ "$result" == "CLAIMED" ]]
}

# check_claim_churn — Detect claim/release churn and escalate if threshold met.
check_claim_churn() {
    local repo="$1"
    local issue_number="$2"
    local github_user="$3"
    local threshold="${CLAIM_CHURN_THRESHOLD:-3}"
    local result
    result=$(deno_run_command "claim-issue" \
        --operation "check-churn" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --github-user "$github_user" \
        --threshold "$threshold" \
        --planning-label "${PLANNING_LABEL:-planning}" 2>/dev/null) || true
    [[ "$result" == "ESCALATED" ]]
}

# --- Label manager wrappers (migrated from label_manager.sh, Issue #911) ---

# ensure_label_exists — Create a label if it does not exist.
ensure_label_exists() {
    local repo="$1"
    local label_name="$2"
    local colour="${3:-d73a4a}"
    local description="${4:-}"
    deno_run_command "label-manager" \
        --operation "ensure-label" \
        --repo "$repo" \
        --label-name "$label_name" \
        --colour "$colour" \
        --description "$description" 2>/dev/null || true
}

# check_issue_has_failed_once — Check if an issue has the failed-once label.
check_issue_has_failed_once() {
    local repo="$1"
    local issue_number="$2"
    local result
    result=$(deno_run_command "label-manager" \
        --operation "check-failed-once" \
        --repo "$repo" \
        --issue-number "$issue_number" 2>/dev/null) || true
    [[ "$result" == "true" ]]
}

# mark_issue_as_failed_once — Mark an issue as having failed once.
mark_issue_as_failed_once() {
    local repo="$1"
    local issue_number="$2"
    local github_user="$3"
    local failure_message="$4"
    local clarity_status="${5:-not_assessed}"
    local diagnostic_context="${6:-}"
    deno_run_command "label-manager" \
        --operation "mark-failed-once" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --github-user "$github_user" \
        --failure-message "$failure_message" \
        --clarity-status "$clarity_status" \
        --diagnostic-context "$diagnostic_context" 2>/dev/null || true
}

# mark_issue_as_failed — Mark an issue as permanently failed.
mark_issue_as_failed() {
    local repo="$1"
    local issue_number="$2"
    local github_user="$3"
    local failure_message="$4"
    local clarity_status="${5:-not_assessed}"
    local diagnostic_context="${6:-}"
    deno_run_command "label-manager" \
        --operation "mark-failed" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --github-user "$github_user" \
        --failure-message "$failure_message" \
        --clarity-status "$clarity_status" \
        --diagnostic-context "$diagnostic_context" 2>/dev/null || true
}

# handle_issue_failure — Unified failure handler (GitHub operations only).
# NOTE: This does NOT handle git branch cleanup. The caller must handle
# git checkout and branch deletion separately.
handle_issue_failure() {
    local repo="$1"
    local issue_number="$2"
    local github_user="$3"
    local failure_message="$4"
    local branch_name="$5"
    local clarity_status="${6:-not_assessed}"
    local diagnostic_context="${7:-}"

    # Handle GitHub issue operations via Deno
    deno_run_command "label-manager" \
        --operation "handle-failure" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --github-user "$github_user" \
        --failure-message "$failure_message" \
        --clarity-status "$clarity_status" \
        --diagnostic-context "$diagnostic_context" \
        --max-infra-retries "${MAX_INFRA_RETRIES:-5}" 2>/dev/null || true

    # Issue #596: Invalidate issue cache after failure changes labels/assignees
    if declare -F issue_cache_invalidate_repo >/dev/null 2>&1; then
        issue_cache_invalidate_repo "$repo"
    fi

    # Git branch cleanup — decision logic delegated to Deno (Issue #1123),
    # shell keeps only direct git/gh calls (orchestration).
    local default_branch
    default_branch=$(get_repo_default_branch "$repo" 2>/dev/null) || default_branch="main"
    git checkout "$default_branch" 2>/dev/null || true
    if [[ -n "$branch_name" ]]; then
        # Issue #386, #3931: ask Deno whether the remote branch may go. The
        # check refuses protected branches, branches an open PR uses as head
        # or base, and any branch whose state could not be read.
        local pr_check_result=""
        pr_check_result=$(deno_run_command "branch-cleanup" \
            --operation "check-branch-has-open-pr" \
            --repo "$repo" \
            --branch-name "$branch_name" 2>/dev/null) || pr_check_result=""

        # Issue #3931: delete only on an explicit SAFE_TO_DELETE. A failed or
        # unreadable check is not permission — it used to fall through to the
        # delete, which is how a branch other PRs were based on could vanish.
        if [[ "$pr_check_result" == "SAFE_TO_DELETE" ]]; then
            log "Deleting stale remote branch $branch_name (if it exists)..."
            git push origin --delete "$branch_name" 2>/dev/null || true
        else
            log "WARNING: Skipping remote branch deletion of '$branch_name' — the safety check returned '${pr_check_result:-<no result>}' rather than SAFE_TO_DELETE (Issue #3931)"
        fi
        git branch -D "$branch_name" 2>/dev/null || true
    fi

    return 1
}

# handle_question_failure — Handle question answering failure.
handle_question_failure() {
    local repo="$1"
    local issue_number="$2"
    local github_user="$3"
    local failure_message="$4"
    deno_run_command "label-manager" \
        --operation "handle-question-failure" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --github-user "$github_user" \
        --failure-message "$failure_message" 2>/dev/null || true
}

# count_clarification_rounds — Count clarification comments on an issue.
count_clarification_rounds() {
    local issue_comments="$1"
    deno_run_command "label-manager" \
        --operation "count-clarification-rounds" \
        --issue-comments "$issue_comments" 2>/dev/null || echo "0"
}

# validate_clarifying_questions — Validate that questions contain actual questions.
validate_clarifying_questions() {
    local questions="$1"
    local result
    result=$(deno_run_command "label-manager" \
        --operation "validate-clarifying-questions" \
        --questions "$questions" 2>/dev/null) || true
    [[ "$result" == "VALID" ]]
}

# post_clarifying_questions — Post clarifying questions and mark issue.
post_clarifying_questions() {
    local repo="$1"
    local issue_number="$2"
    local github_user="$3"
    local clarifying_questions="$4"
    deno_run_command "label-manager" \
        --operation "post-clarifying-questions" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --github-user "$github_user" \
        --questions "$clarifying_questions" 2>/dev/null || return 1
}

# escalate_to_planning — Escalate issue to planning mode.
escalate_to_planning() {
    local repo="$1"
    local issue_number="$2"
    local github_user="$3"
    local escalation_reason="${4:-}"
    deno_run_command "label-manager" \
        --operation "escalate-to-planning" \
        --repo "$repo" \
        --issue-number "$issue_number" \
        --github-user "$github_user" \
        --reason "$escalation_reason" 2>/dev/null || return 1
}

# check_issue_too_complex — Check if issue is too complex.
# Delegates to Deno TypeScript (Issue #1123).
check_issue_too_complex() {
    local issue_title="$1"
    local issue_body="$2"
    if ! declare -F deno_run_command &>/dev/null; then
        return 0
    fi
    local result
    result=$(deno_run_command "assess-clarity" \
        --operation "check-too-complex" \
        --title "$issue_title" \
        --body "$issue_body" \
        --labels "[]" 2>/dev/null) || {
        return 0
    }
    if [[ "$result" == "TOO_COMPLEX" ]]; then
        echo "TOO_COMPLEX"
    fi
    return 0
}
