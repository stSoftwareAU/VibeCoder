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

################################################################################
# Supervisor deadline (Issue #322)
#
# run_core bounds itself with in-process `setTimeout` watchdogs. Those are only
# as reliable as the event loop they run on, and on 2026-08-22 two agents
# saturated the container: the watchdogs fired 1350 s and 2737 s late, a kill
# could not complete, and the cycle ran 2h26m past its deadline until a human
# killed it. A timer that only fires when the process is healthy cannot bound
# an unhealthy process.
#
# So the supervisor — the one process guaranteed not to be inside the failure —
# owns a wall-clock cap. `timeout` sends SIGTERM at the cap and SIGKILL after
# the grace, and the expiry is reported to the backoff recorder as a launcher
# failure so a host that does this repeatedly escalates (Issue #4072).
#
# Default 5400 s: the 3600 s run duration plus a wide margin for a slow but
# genuinely progressing shutdown. Set VIBE_RUN_MAX_SECONDS=0 to disable.
################################################################################
VIBE_RUN_MAX_SECONDS="${VIBE_RUN_MAX_SECONDS:-5400}"
VIBE_RUN_KILL_GRACE_SECONDS="${VIBE_RUN_KILL_GRACE_SECONDS:-120}"

# `timeout` exits 124 on expiry; 137 when its own SIGKILL was what stopped the
# child. Both mean "the supervisor ended this run", not "the run failed".
readonly RUN_DEADLINE_EXIT=124
readonly RUN_KILLED_EXIT=137

# Reap what a killed run.sh leaves behind (Issue #322).
#
# run.sh execs the worker inside a container named `vibe-coder-<run.sh pid>`.
# Killing run.sh does not stop that container: on 2026-08-22 the orphaned VM
# kept running at 705% CPU with nothing supervising it, which makes the *next*
# cycle fail the same way.
#
# Orphans are identified by reparenting rather than by PID: after run.sh dies,
# its `container run` client is reparented to init (PPID 1). That test needs no
# bookkeeping, and it also clears a client stranded by an earlier cycle or by a
# human kill. A client still owned by a live run.sh has a PPID that is not 1
# and is never touched, so a healthy run is safe.
#
# Best-effort and always logged. Recovering a container whose own init has died
# is Issue #323.
reap_orphaned_containers() {
    command -v pgrep >/dev/null 2>&1 || return 0
    local pid ppid reaped=0
    while read -r pid; do
        [[ -z "${pid}" ]] && continue
        ppid="$(ps -o ppid= -p "${pid}" 2>/dev/null | tr -d ' ')"
        [[ "${ppid}" == "1" ]] || continue
        echo "loop.sh: reaping orphaned container client PID ${pid} (parent gone)"
        kill -TERM "${pid}" 2>/dev/null || true
        reaped=1
    done < <(pgrep -f "container run .*--name vibe-coder-" 2>/dev/null || true)

    [[ "${reaped}" == "1" ]] || return 0
    sleep 5
    while read -r pid; do
        [[ -z "${pid}" ]] && continue
        ppid="$(ps -o ppid= -p "${pid}" 2>/dev/null | tr -d ' ')"
        [[ "${ppid}" == "1" ]] || continue
        echo "loop.sh: orphaned client PID ${pid} survived SIGTERM — SIGKILL"
        kill -KILL "${pid}" 2>/dev/null || true
    done < <(pgrep -f "container run .*--name vibe-coder-" 2>/dev/null || true)
}

################################################################################
# Container control-plane liveness (Issue #323)
#
# On 2026-08-22 the container's init (`vminitd`) stopped answering. Every
# control-plane operation failed — `container exec` reset its socket,
# `container stop` returned 0 while the container kept running, `container
# kill` did nothing — and `container ls` reported the container healthy and
# `running` the whole time. Liveness was being *inferred* from the worker
# writing logs, which is a symptom of health rather than a check, and a wedged
# worker stops writing at precisely the moment a check is needed.
#
# So probe, do not infer: a trivial `exec` against the live container, and N
# consecutive failures means the control plane is gone whatever `container ls`
# says. Recovery skips `stop`/`kill` — they are already known not to work in
# this state — and terminates the host-side client, then the VM, verifying
# each. Killing the client alone leaves the VM running: on 2026-08-22 it sat
# at 705% CPU with nothing supervising it.
################################################################################
VIBE_PROBE_INTERVAL_SECONDS="${VIBE_PROBE_INTERVAL_SECONDS:-120}"
VIBE_PROBE_FAILURES="${VIBE_PROBE_FAILURES:-3}"

# Echo the name of the running vibe-coder container, or nothing.
running_vibe_container() {
    command -v container >/dev/null 2>&1 || return 0
    timeout 30 container ls 2>/dev/null |
        awk '$1 ~ /^vibe-coder-/ && $0 ~ /running/ { print $1; exit }'
}

# Terminate a container whose control plane is dead, and the VM behind it.
force_stop_container() {
    local name="$1"
    [[ -z "${name}" ]] && return 0

    # Try the runtime first — it costs a second and works when the control
    # plane is merely slow rather than gone.
    timeout 30 container kill "${name}" >/dev/null 2>&1 || true
    sleep 3
    # Verify, never trust the exit code: `container stop` returned 0 on
    # 2026-08-22 while the container kept running.
    if ! timeout 30 container ls 2>/dev/null | grep -q "${name}.*running"; then
        echo "loop.sh: ${name} stopped by the runtime"
        return 0
    fi

    echo "loop.sh: ${name} survived the runtime kill — terminating the client"
    local client
    client="$(pgrep -f "container run .*--name ${name}( |$)" 2>/dev/null | head -1 || true)"
    if [[ -n "${client}" ]]; then
        kill -TERM "${client}" 2>/dev/null || true
        sleep 5
        kill -KILL "${client}" 2>/dev/null || true
    fi

    # The VM outlives its client (Issue #323): killing the client alone left a
    # VM at 705% CPU on 2026-08-22, which makes the next cycle fail the same
    # way. Only VMs with no live client are touched.
    local vm ppid
    while read -r vm; do
        [[ -z "${vm}" ]] && continue
        ppid="$(ps -o ppid= -p "${vm}" 2>/dev/null | tr -d ' ')"
        [[ "${ppid}" == "1" ]] || continue
        echo "loop.sh: reaping orphaned VM PID ${vm}"
        kill -TERM "${vm}" 2>/dev/null || true
    done < <(pgrep -f "Virtualization.VirtualMachine" 2>/dev/null || true)
}

# Probe the control plane until it fails N times in a row, then recover.
# Runs in the background beside run.sh and exits when the container goes away.
probe_control_plane() {
    command -v container >/dev/null 2>&1 || return 0
    local failures=0 name
    while true; do
        sleep "${VIBE_PROBE_INTERVAL_SECONDS}"
        name="$(running_vibe_container)"
        if [[ -z "${name}" ]]; then
            failures=0
            continue
        fi
        if timeout 30 container exec "${name}" true >/dev/null 2>&1; then
            failures=0
            continue
        fi
        failures=$((failures + 1))
        echo "loop.sh: control-plane probe failed for ${name}" \
             "(${failures}/${VIBE_PROBE_FAILURES})"
        if (( failures >= VIBE_PROBE_FAILURES )); then
            echo "loop.sh: ${name} control plane is unresponsive — recovering" \
                 "(Issue #323)"
            force_stop_container "${name}"
            return 0
        fi
    done
}

# Run "$@" under the supervisor deadline, echoing its exit status.
run_under_deadline() {
    if [[ "${VIBE_RUN_MAX_SECONDS}" == "0" ]] || \
       [[ ${#TIMEOUT_PREFIX[@]} -eq 0 ]]; then
        "$@"
        return $?
    fi
    "${TIMEOUT_PREFIX[0]}" --kill-after="${VIBE_RUN_KILL_GRACE_SECONDS}" \
        "${VIBE_RUN_MAX_SECONDS}" "$@"
}

while true; do
    run_status=0
    # Issue #323: probe the container's control plane while the run is up. The
    # probe exits on its own once it recovers a dead container; otherwise it is
    # stopped below when the run ends.
    probe_control_plane &
    probe_pid=$!
    run_under_deadline ./run.sh || run_status=$?
    kill "${probe_pid}" 2>/dev/null || true
    wait "${probe_pid}" 2>/dev/null || true
    if [[ "${run_status}" -eq "${RUN_DEADLINE_EXIT}" ]] || \
       [[ "${run_status}" -eq "${RUN_KILLED_EXIT}" ]]; then
        # Issue #322: the run outlived its wall-clock cap. Say so distinctly —
        # a cycle ended by its supervisor must be as visible in the log as one
        # that failed on its own, or an unattended host looks merely slow.
        echo "loop.sh: ./run.sh exceeded VIBE_RUN_MAX_SECONDS=${VIBE_RUN_MAX_SECONDS}s" \
             "(status ${run_status}) — terminated by the supervisor; reaping and retrying"
        reap_orphaned_containers
    elif [[ "${run_status}" -ne 0 ]]; then
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
