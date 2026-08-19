#!/bin/bash
# We deliberately do NOT use `set -e` here. The whole point of this
# script is to continue regardless of what run.sh, sleep, or git pull
# return — Issue #1836. `-u` and `pipefail` stay on for safety.
set -uo pipefail

################################################################################
# loop.sh — never-exit supervisor wrapper around run.sh
#
# The canonical production supervision model is cron/launchd calling run.sh
# every 5 minutes. run_core runs for ~1 hour then exits; the next cron/launchd
# invocation picks up fresh code. See docs/workflows/resilience-and-concurrency.md.
#
# This script is an alternative for environments without cron/launchd.
# It continuously re-invokes run.sh and must NEVER exit on its own — only on
# SIGINT (Ctrl+C) from a human at the terminal.
#
# Issues:
#   #919  — Simplified to thin launcher matching run.sh pattern.
#   #1836 — Stop dying on SIGTERM propagated from the worker's process group
#           and on transient git pull / run.sh failures.
#   #3504 — run.sh now execs the Deno `run-entrypoint` driver directly (the bash
#           run_core.sh conductor was deleted); the signal notes below refer to
#           that driver's own SIGTERM/SIGINT handling.
#   #4065 — run.sh launches that driver inside the worker container and
#           forwards SIGTERM/SIGINT to it, exiting with the container's status,
#           so the notes below still hold across the containment boundary.
#   #4072 — a failed launcher is now recorded rather than retried blindly: the
#           worker's `container-restart-backoff` command grows the wait across
#           consecutive failures, records the recovery as a self-heal event and
#           escalates a repeatedly failing host through GitHub.
################################################################################

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${SCRIPT_DIR}" || exit 1

# Base sleep between iterations, and the first failure's backoff. Configurable
# so tests can use a short value.
LOOP_SLEEP_SECONDS="${LOOP_SLEEP_SECONDS:-60}"

# Where run.sh records the phase it reached, so a failure can be attributed to
# runtime detection, image build, container start or the worker run itself.
VIBE_STATE_DIR="${VIBE_STATE_DIR:-${HOME:-/tmp}/.vibe-coder}"
VIBE_LAUNCH_PHASE_FILE="${VIBE_LAUNCH_PHASE_FILE:-${VIBE_STATE_DIR}/last-launch-phase}"
export VIBE_STATE_DIR VIBE_LAUNCH_PHASE_FILE

WORKER_MOD="${SCRIPT_DIR}/worker/deno/mod.ts"

DENO_CMD=""
for candidate in deno "${HOME:-/tmp}/.deno/bin/deno" /opt/homebrew/bin/deno /usr/local/bin/deno; do
    if command -v "${candidate}" >/dev/null 2>&1; then
        DENO_CMD="${candidate}"
        break
    fi
done

# A wedged recorder must never wedge the supervisor: bound it where the host
# has a timeout command (gtimeout on macOS, timeout on Linux).
TIMEOUT_PREFIX=()
if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_PREFIX=(timeout 120)
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_PREFIX=(gtimeout 120)
fi

# Record one launcher outcome and echo the seconds to wait before the next
# attempt. Falls back — loudly, never silently — to the base sleep when the
# recorder cannot run or does not answer with a plain integer (Issue #3234).
next_sleep_seconds() {
    local status="$1"
    local seconds=""

    if [[ -z "${DENO_CMD}" || ! -f "${WORKER_MOD}" ]]; then
        echo "loop.sh: cannot record launcher outcome (deno or ${WORKER_MOD} missing)" \
            "— falling back to ${LOOP_SLEEP_SECONDS}s" >&2
        echo "${LOOP_SLEEP_SECONDS}"
        return
    fi

    seconds="$(${TIMEOUT_PREFIX[@]+"${TIMEOUT_PREFIX[@]}"} "${DENO_CMD}" run \
        --frozen --lock="${SCRIPT_DIR}/worker/deno/deno.lock" \
        --allow-env --allow-read --allow-write --allow-run --allow-net \
        "${WORKER_MOD}" container-restart-backoff \
        --exit-status "${status}" \
        --base-sleep-seconds "${LOOP_SLEEP_SECONDS}" </dev/null 2>/dev/null)"

    seconds="${seconds##*$'\n'}"
    if [[ "${seconds}" =~ ^[0-9]+$ ]]; then
        echo "${seconds}"
    else
        echo "loop.sh: container-restart-backoff gave no usable interval" \
            "— falling back to ${LOOP_SLEEP_SECONDS}s" >&2
        echo "${LOOP_SLEEP_SECONDS}"
    fi
}

# Signal handling.
#
# The Deno `run-entrypoint` driver installs its own SIGTERM/SIGINT handlers
# (the run-core loop shuts down gracefully) and exits cleanly when its
# run-duration timer expires. If launchd / cron / a human delivers SIGTERM to
# the worker process group, the signal also reaches loop.sh — which would
# otherwise inherit the default disposition and die. That is exactly what
# Issue #1836 reports: a 10-hour gap in the logs after a clean worker
# shutdown, with no "Sleeping..." line, because loop.sh died from the same
# signal that cleanly stopped the worker.
#
# We install no-op traps for SIGTERM and SIGHUP so loop.sh survives them and
# keeps supervising. Bash custom traps do not propagate to children, so the
# child still sees the default disposition for these signals — the Deno
# driver's own SIGTERM handling continues to work.
#
# SIGINT is left alone so a human at the terminal can stop the loop with
# Ctrl+C in the obvious way.
on_signal() {
    local sig="$1"
    echo "loop.sh: ${sig} received — ignoring and continuing supervision"
}
trap 'on_signal SIGTERM' SIGTERM
trap 'on_signal SIGHUP'  SIGHUP

# This supervisor records every launcher outcome itself, so run.sh must not
# also record it — one failure must be counted once (Issue #4072).
export VIBE_SUPERVISOR_RECORDS_OUTCOME=1

while true; do
    run_status=0
    ./run.sh || run_status=$?
    if [[ "${run_status}" -ne 0 ]]; then
        echo "loop.sh: ./run.sh exited with status ${run_status} — backing off and retrying"
    fi

    sleep_seconds="$(next_sleep_seconds "${run_status}")"
    echo "Sleeping ${sleep_seconds}s..."
    sleep "${sleep_seconds}" || \
        echo "loop.sh: sleep interrupted — continuing"

    if git pull; then
        :
    else
        echo "loop.sh: git pull exited with status $? — continuing"
    fi
done
