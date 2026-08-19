#!/bin/bash
# shellcheck disable=SC2034

################################################################################
# worker/shared/config_defaults.sh — Compatibility shim (Issue #904)
#
# The canonical config defaults now live in worker/deno/lib/config_defaults.ts
# and are loaded via the `load-config` Deno command. This file exists ONLY as
# a compatibility layer for shell modules that source it
# for default values.
#
# This file MUST NOT contain any logic — only default assignments.
# Issue #907: operational_defaults.sh migrated to Deno; constants
# are now loaded via deno_run_command "load-config".
################################################################################

# =============================================================================
# Directory and Interval Defaults
# =============================================================================
: "${WORK_DIR:=$HOME/auto-issue-work}"
: "${SLEEP_INTERVAL:=30}"
: "${LOG_FILE:=$HOME/logs/worker.log}"
: "${CREDIT_WAIT_INTERVAL:=300}"

# =============================================================================
# Label Defaults
# =============================================================================
: "${TOP_PRIORITY_LABEL:=top-priority}"
: "${WORK_ON_LABEL:=work-on}"
: "${FAILED_LABEL:=failed}"
: "${FAILED_ONCE_LABEL:=failed-once}"
# Issue #2031: NEEDS_CLARIFICATION_LABEL retired — clarification handoff is
# signalled via NEEDS_HUMAN_LABEL.
: "${REFINE_ISSUE_LABEL:=refine-issue}"
: "${PLANNING_LABEL:=planning}"
: "${QUESTION_LABEL:=question}"
# Issue #2030: ANSWERED_LABEL retired — question workflow now signals handoff
# via NEEDS_HUMAN_LABEL.
: "${NEEDS_SCREENSHOT_LABEL:=needs-screenshot}"
: "${NEEDS_REVISION_LABEL:=needs-revision}"
: "${NEEDS_HUMAN_LABEL:=needs-human}"
: "${GRILL_ME_LABEL:=grill-me}"
# Issue #4112: the Quorum plan-off label — human-applied only, reserved so
# the worker never self-applies it.
: "${QUORUM_LABEL:=quorum}"
: "${LOW_PRIORITY_LABEL:=low-priority}"
: "${DOCUMENTATION_LABEL:=documentation}"
: "${LABEL_CACHE_TTL:=3600}"

# =============================================================================
# Timeout Defaults (seconds)
# =============================================================================
: "${REFINEMENT_TIMEOUT:=300}"
: "${REFINEMENT_KILL_AFTER:=10}"
: "${PLANNING_TIMEOUT:=1800}"
: "${PLANNING_KILL_AFTER:=10}"
: "${QUESTION_TIMEOUT:=600}"
: "${QUESTION_KILL_AFTER:=10}"
: "${MAX_CLARIFICATION_ROUNDS:=3}"
: "${CLARIFICATION_TIMEOUT:=120}"
: "${CLARIFICATION_KILL_AFTER:=10}"
: "${MAX_GRILL_ME_ROUNDS:=5}"
# Issue #3154: grill-me is an analysis phase (may probe the served model /
# investigate the codebase at top-tier + max effort) — matches CLAUDE_TIMEOUT.
: "${GRILL_ME_TIMEOUT:=3600}"
: "${GRILL_ME_KILL_AFTER:=10}"
# Issue #4112: per-agent bounds for one Quorum member. Planning-shaped work,
# so the budget matches PLANNING_TIMEOUT rather than the issue-work hour.
: "${QUORUM_TIMEOUT:=1800}"
: "${QUORUM_KILL_AFTER:=10}"
: "${CLAUDE_TIMEOUT:=3600}"
# Issue #1824: distinct hard timeouts for reactive phases — keep PR feedback
# and CI fix work bounded so a wedged Claude run cannot consume an entire
# iteration's run-duration budget.
: "${PR_FEEDBACK_TIMEOUT:=1800}"
: "${CI_FIX_TIMEOUT:=1800}"
: "${CLAUDE_KILL_AFTER:=30}"
: "${MAX_RATE_LIMIT_RETRIES:=2}"
: "${MAX_RATE_LIMIT_WAIT:=600}"
: "${RETRY_MAX_DELAY:=60}"
: "${MAX_ISSUE_BODY_TOKENS:=50000}"
: "${SUMMARISE_TIMEOUT:=120}"
: "${SUMMARISE_KILL_AFTER:=10}"
: "${FEATURE_CHECK_TIMEOUT:=5}"
: "${TIMEOUT_DIAGNOSTIC_LINES:=50}"
: "${OUTPUT_PROGRESS_INTERVAL:=300}"
: "${CLAUDE_NO_OUTPUT_TIMEOUT:=600}"
: "${CLAUDE_STALL_TIMEOUT:=1800}"
: "${QUALITY_CHECK_TIMEOUT:=600}"
: "${MAX_INFRA_RETRIES:=5}"
: "${HEALTH_CHECK_TIMEOUT:=30}"

# =============================================================================
# Claude Model Selection (Issue #260)
# Planning runs on the Fable 5 top tier (Issue #2621) — a better plan
# compounds across every downstream sub-issue.
# =============================================================================
: "${CLAUDE_MODEL:=opus}"
: "${CLAUDE_MODEL_PLANNING:=fable}"

# =============================================================================
# Run Mode (Issue #4146)
# =============================================================================
# Container by default; `native` is an explicit host opt-in. The canonical
# resolver is worker/deno/lib/run_mode.ts — the launchers read it through
# `deno run mod.ts run-mode` rather than parsing .config.json in bash.
: "${RUN_MODE:=container}"

# =============================================================================
# Toggles
# =============================================================================
: "${SET_WINDOW_TITLE:=true}"
: "${UPDATE_GH_USER_STATUS:=true}"
: "${SHUFFLE_REPOS:=true}"
: "${WORKER_NAME:=}"

# =============================================================================
# Circuit Breaker, Retry, and Detection Defaults
# =============================================================================
: "${CIRCUIT_BREAKER_THRESHOLD:=3}"
: "${ISSUE_RETRY_COOLDOWN:=600}"
: "${STUCK_ISSUE_TIMEOUT:=7200}"
: "${LOG_MAX_SIZE_MB:=10}"
: "${LOG_MAX_ROTATIONS:=3}"
: "${REPO_BLOCKED_ALERT_HOURS:=24}"
: "${CLAIM_CHURN_THRESHOLD:=3}"
: "${CI_CHECK_MAX_RETRIES:=3}"
: "${MAX_TITLE_LENGTH:=500}"
: "${MAX_BODY_LENGTH:=50000}"
: "${SECURITY_LOG_FILE:=}"

# Issue #907: operational_defaults.sh migrated to Deno TypeScript.
# Operational constants are now loaded via deno_run_command "load-config".

# =============================================================================
# Array Defaults
# =============================================================================
# Issue #1834: ISSUE_LABELS now contains only the top-priority discovery
# label. work-on and low-priority have dedicated, author-checked
# collectors in the Deno worker — they must NOT be routed through the
# label-based collector.
if [[ -z "${ISSUE_LABELS+x}" ]]; then
    ISSUE_LABELS=("top-priority")
fi

if [[ -z "${REPOS+x}" ]]; then
    REPOS=()
fi

if [[ -z "${ALLOWED_AUTHORS+x}" ]]; then
    ALLOWED_AUTHORS=()
fi
: "${ALLOWED_AUTHOR:=${ALLOWED_AUTHORS[0]:-}}"

if [[ -z "${PR_REVIEWERS+x}" ]]; then
    PR_REVIEWERS=()
fi
: "${PR_REVIEWER:=${PR_REVIEWERS[0]:-}}"

if [[ -z "${AUTHORIZED_COMMENTERS+x}" ]]; then
    AUTHORIZED_COMMENTERS=()
fi
