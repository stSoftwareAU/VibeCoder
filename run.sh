#!/bin/bash
set -euo pipefail

# Cron entrypoint - thin, trusted, host-side launcher.
#
# The worker runs inside a container by default (Issue #4060). This script is
# the containment boundary, so it is deliberately small enough to audit: it
# asks the Deno "container-launch-plan" command what to run, then runs exactly
# that. Every decision - which runtime, which image, which mounts, which
# privilege flags - is made in worker/deno/lib/container_launch.ts, so code
# running inside the container cannot broaden its own mounts or capabilities
# by editing shell here.
#
# Containment is mandatory (Issue #4): container is the only run mode. The
# Deno "run-mode" command (Issue #4146) is still consulted once up front, so a
# .config.json (or VIBE_RUN_MODE) naming a removed mode - the former native
# and macOS seatbelt opt-ins - fails loud with the removal explained, rather
# than being silently run in a container the operator did not know they were
# getting. An absent container runtime is a loud failure, never a fallback to
# the host (Issue #3234): there is no host path to fall back to.
#
# Steps:
#   1. Locate Deno on the host (the only host tool this script needs).
#   2. Update the worker checkout - origin's default branch, or the pinned
#      ref when update_mode is frozen (Issues #512, #624).
#   3. Notify a pinned host when a newer release exists (Issue #690).
#   4. Build the launch plan (runtime detection, image reference, mounts).
#   5. Build the image when the content-derived reference is absent.
#   6. Launch the container, propagate SIGTERM/SIGINT, and exit with the
#      container's exit status so loop.sh / launchd / cron / systemd see real
#      failures.
#
# Issue #919:  Simplified from inline bash to a thin Deno launcher.
# Issue #3504: Dropped the run_core.sh shadow-copy.
# Issue #4065: Cut over to a containerised launch - no supported runtime is a
#              loud non-zero exit, never a fallback to running on the host.
# Issue #4072: Record the phase reached, so the supervisor's self-heal backoff
#              can tell a host that cannot rebuild its environment from a
#              worker that crashed inside a perfectly good container.
# Issue #4148: Restored the host-native path from before #4065 behind the #4146
#              opt-in; Issue #4 removed it again (and the #4300 seatbelt mode)
#              - containment is mandatory.
# Issue #4173: Outer kill-and-reap watchdog. A wedged container VM leaves the
#              host-side `container run` client waiting for ever, which blocked
#              this launcher - and loop.sh behind it - for three hours on
#              host-23. The wait now runs under the plan's `watchdog` deadline,
#              and a stale worker container is reaped before the launch.
# Issue #512:  The worker checkout is updated here, on the host, before the
#              launch plan is built - the prerequisite for mounting it
#              read-only (Issue #509). A failed update is a warning, never a
#              refused launch, and VIBE_SKIP_CHECKOUT_UPDATE turns it off for
#              a development checkout or a CI tree.
# Issue #690:  A frozen host behind the newest release is told so at launch -
#              one line naming both versions and the upgrade command. The
#              check never blocks the launch: a failure is a warning.

BASE_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${BASE_DIR}"

# Phase marker for the supervisor (loop.sh / loop.ps1 read this alongside the
# exit status). Best-effort by design: an unwritable marker degrades the
# supervisor's attribution, it must not stop the worker from launching - but it
# says so on stderr rather than failing quietly (Issue #3234).
VIBE_STATE_DIR="${VIBE_STATE_DIR:-${HOME:-/tmp}/.vibe-coder}"
LAUNCH_PHASE_FILE="${VIBE_LAUNCH_PHASE_FILE:-${VIBE_STATE_DIR}/last-launch-phase}"
record_phase() {
  if ! { mkdir -p "$(dirname "${LAUNCH_PHASE_FILE}")" &&
    printf '%s\n' "$1" >"${LAUNCH_PHASE_FILE}"; } 2>/dev/null; then
    echo "[run.sh] warning: cannot record launch phase to ${LAUNCH_PHASE_FILE}" >&2
  fi
}

record_phase runtime_detection

# PATH bootstrap for cron/launchd environments. The caller's PATH stays
# authoritative and the usual install locations are appended, so an operator
# who installed Deno or the container runtime somewhere unusual still wins.
FALLBACK_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ -n "${PATH:-}" ]]; then
  export PATH="${PATH}:${FALLBACK_PATH}"
else
  export PATH="${FALLBACK_PATH}"
fi

# Locate Deno
DENO_CMD=""
for candidate in deno "${HOME}/.deno/bin/deno" /opt/homebrew/bin/deno /usr/local/bin/deno; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    DENO_CMD="${candidate}"
    break
  fi
done

if [[ -z "${DENO_CMD}" ]]; then
  echo "Error: Deno not found" >&2
  exit 1
fi

CONTAINER_NAME="vibe-coder-$$"
# Set once the launch plan is built, so the EXIT trap can clean it up.
PLAN_FILE=""
# Marker the watchdog writes before it reaps, so the exit status can name the
# reason (Issue #4173). Set only once the container path starts the container.
WEDGE_MARKER=""
# Where the image build's output is captured, so a failed build can be
# classified by container-build-heal (Issue #4441). Set only when a build runs.
BUILD_LOG=""
# Where the container run client's stderr is captured, so a start the runtime
# refused can be quoted (Issue #711), and the FIFO it streams through. Both are
# set together, immediately before the container is started.
RUN_LOG=""
RUN_ERR_FIFO=""
# The log the outcome recorder quotes as evidence in its escalation (Issue
# #709). Set only on a path that is about to fail - a successful build's
# output is not what a later failure was caused by, and an alert that quoted
# it would point the reader at the wrong thing.
EVIDENCE_LOG=""

# Exit status container-build-heal reports for a build failure it does not
# cover, as opposed to 0 (healed - retry) or any other status (the heal itself
# failed). Kept in step with BUILD_NOT_HEALABLE_EXIT in
# worker/deno/commands/container_build_heal.ts by the launcher tests.
BUILD_NOT_HEALABLE_EXIT=3

# Exit status container-reap reports when another worker is already running on
# this host (Issue #26) - one worker per host, so this launch stops before it
# builds or launches anything, saying so plainly. Kept in step with
# ANOTHER_WORKER_RUNNING_EXIT in worker/deno/commands/container_reap.ts by the
# launcher tests.
ANOTHER_WORKER_RUNNING_EXIT=4

# A wedged helper must never wedge this launcher: the helpers below run under
# a time bound where the host has one (gtimeout on macOS, timeout on Linux).
TIMEOUT_CMD=""
for candidate in timeout gtimeout; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    TIMEOUT_CMD="${candidate}"
    break
  fi
done

# Run a command under a time bound, where the host has one.
# Usage: bounded <seconds> <command> [args...]
bounded() {
  local seconds="$1"
  shift
  if [[ -n "${TIMEOUT_CMD}" ]]; then
    "${TIMEOUT_CMD}" "${seconds}" "$@"
  else
    "$@"
  fi
}

# ./run.sh upgrade - move this host onto the latest release (Issue #691).
#
# One .config.json rewrite: pinned_ref and all three pinned_tool_versions, and
# nothing else. It installs nothing, moves no checkout and starts no container
# - the next launch installs exactly what the pins name. Every decision lives
# in the Deno "upgrade" command, so this shell keeps no upgrade logic of its
# own, the same split worker-checkout-update uses below.
#
# Handled here, before the EXIT trap is installed: an upgrade is not a launch,
# so it must not be counted as a launch outcome by the self-heal backoff.
if [[ "${1:-}" == "upgrade" ]]; then
  upgrade_status=0
  bounded 300 "${DENO_CMD}" run \
    --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
    --allow-env --allow-read --allow-write --allow-run \
    "${BASE_DIR}/worker/deno/mod.ts" upgrade \
    --base-dir "${BASE_DIR}" </dev/null || upgrade_status=$?
  exit "${upgrade_status}"
fi

# Self-heal accounting (Issue #4072). Under cron / launchd / systemd / Task
# Scheduler there is no supervising process between runs, so the launcher
# records its own outcome: consecutive failures grow the backoff and, past the
# phase's threshold, escalate through GitHub. loop.sh and loop.ps1 set
# VIBE_SUPERVISOR_RECORDS_OUTCOME because they record the same outcome
# themselves - one failure must be counted once, not twice. Best-effort: a
# recorder that cannot run says so on stderr and never changes this launcher's
# exit status.
# Invoked from the EXIT trap below; shellcheck cannot see that call and reports
# it as never-invoked (SC2317 on older versions, SC2329 on newer ones).
#
# --allow-sys=hostname: the escalation this recorder files names the machine it
# is about (Issues #633, #710). Without it `Deno.hostname()` is refused, the
# report is titled `unknown-host` and says `Host: unknown`, which is close to
# useless in a fleet reporting into one shared repository. loop.sh has carried
# the flag since #633; the scheduler path through this launcher had not.
# shellcheck disable=SC2317,SC2329
record_outcome() {
  local status="$1"
  if [[ -n "${VIBE_SUPERVISOR_RECORDS_OUTCOME:-}" ]]; then
    return 0
  fi
  # --allow-sys=hostname: this record is what escalates, and the escalation is
  # titled for the host. Without the permission Deno.hostname() throws, the
  # report is filed as "unknown-host" - and the title is also its dedup key,
  # so every host in the fleet collapses onto one issue per phase and no
  # report can be traced to a machine. Issues #709, #710 and #711 arrived
  # exactly that way. loop.sh has carried the flag since Issue #633.
  #
  # --launch-log: the failing step's own output - the build's, when a build is
  # what failed (Issue #709), or the container capture, for every launch that
  # started one and did not exit 0 (Issues #711, #1029): the runtime client's
  # refusal when the container never started, and the worker's own error lines
  # when it started and the worker stopped itself. An escalation without it
  # names the phase and the status and nothing at all about why, which is the
  # difference between a report an operator can act on and one they cannot.
  if ! bounded 120 "${DENO_CMD}" run \
    --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
    --allow-env --allow-read --allow-write --allow-run --allow-net \
    --allow-sys=hostname \
    "${BASE_DIR}/worker/deno/mod.ts" container-restart-backoff \
    --exit-status "${status}" \
    ${EVIDENCE_LOG:+--launch-log "${EVIDENCE_LOG}"} </dev/null >/dev/null; then
    echo "[run.sh] warning: could not record launcher outcome ${status}" >&2
  fi
}

# shellcheck disable=SC2317,SC2329
on_exit() {
  local status=$?
  # Never from a background subshell. Bash runs this trap in an asynchronous
  # subshell too - when the watchdog returns, and when the drain guard below is
  # killed - and a second run records a second launcher outcome and deletes the
  # evidence the launcher itself is about to quote. Each background job clears
  # the trap for its own subshell (`trap - EXIT`); this is the guard that says
  # so where the damage would be done (Issue #711).
  if [[ "${BASH_SUBSHELL}" != "0" ]]; then
    return 0
  fi
  if [[ -n "${PLAN_FILE}" ]]; then
    rm -f "${PLAN_FILE}" "${PLAN_FILE}.Containerfile"
  fi
  if [[ -n "${WEDGE_MARKER}" ]]; then
    rm -f "${WEDGE_MARKER}"
  fi
  record_outcome "${status}"
  # Removed after the record, never before it: the recorder quotes this log as
  # the image-build evidence, and deleting it first is what left Issue #709
  # reporting a failed build it could say nothing about.
  if [[ -n "${BUILD_LOG}" ]]; then
    rm -f "${BUILD_LOG}"
  fi
  # Same ordering, same reason (Issue #711): the refused start's evidence is
  # this capture, so it outlives the record and nothing else. The FIFO beside
  # it goes here too. A SIGKILLed launcher runs no trap and leaves both behind,
  # exactly as it already does for the plan file and the wedge marker.
  if [[ -n "${RUN_LOG}" ]]; then
    rm -f "${RUN_LOG}" "${RUN_ERR_FIFO}"
  fi
}
trap on_exit EXIT

# Both branches run their child in the background rather than exec-ing, so this
# shell survives to forward termination to it: the Deno driver's
# graceful-shutdown handling only runs if it gets the signal, and an exec'd
# shell would take the EXIT trap - and with it the outcome record above - away.
CHILD_PID=""
RUNTIME=""
# Set around the background launch below, because bash runs a trap at a command
# boundary and CHILD_PID is assigned on the line after the launch: a signal
# landing in that window has a child to forward to but no PID to forward with
# (Issue #668). While this is set the signal is held rather than re-raised, and
# delivered by deliver_pending_signal as soon as the PID is known.
LAUNCH_IN_FLIGHT=""
PENDING_SIGNAL=""
# Invoked indirectly by the traps below; shellcheck cannot see that call, and
# reports it as unreachable/never-invoked (SC2317 on older versions, SC2329 on
# newer ones).
# shellcheck disable=SC2317,SC2329
forward_signal() {
  local signal="$1"
  if [[ -z "${CHILD_PID}" && -n "${LAUNCH_IN_FLIGHT}" ]]; then
    # The child exists (or is a fork away) and only its PID is missing, so
    # hold the signal here. Held, never dropped: the launch site delivers it
    # the moment CHILD_PID is assigned.
    PENDING_SIGNAL="${signal}"
    return
  fi
  if [[ -z "${CHILD_PID}" ]]; then
    # Nothing has been launched yet, so there is nothing to forward to. Take
    # the signal's default disposition rather than swallowing it: a launcher
    # that ignored a shutdown request while building an image would look hung.
    trap - "${signal}"
    kill -s "${signal}" $$
    return
  fi
  kill -s "${signal}" "${CHILD_PID}" 2>/dev/null || true
  # Belt and braces: the runtime CLI proxies signals to the container, and
  # this covers one that does not. Best-effort by design - the container may
  # not have started yet, and RUNTIME is empty until the plan resolved it.
  if [[ -n "${RUNTIME}" ]]; then
    "${RUNTIME}" stop "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

# Deliver a signal held while the launch was in flight (Issue #668). Called
# once, immediately after CHILD_PID is assigned, so the shutdown request
# reaches the container instead of being lost with the window that held it.
deliver_pending_signal() {
  local signal="${PENDING_SIGNAL}"
  PENDING_SIGNAL=""
  [[ -n "${signal}" ]] || return 0
  forward_signal "${signal}"
}

# wait returns 128+signum when a trap interrupts it without reaping the child,
# so keep waiting until the child process is really gone.
# shellcheck disable=SC2317,SC2329
wait_for_child() {
  local status=0
  while true; do
    set +e
    wait "${CHILD_PID}"
    status=$?
    set -e
    kill -0 "${CHILD_PID}" 2>/dev/null || break
  done
  return "${status}"
}

# One line per launcher decision in the worker's own host log, so a fleet host
# that keeps failing a step is visible without reading stderr. Best-effort: an
# unwritable log must never fail a launch.
#
# Issue #872: `LOG_DIR` was honoured by loop.sh and ignored here, so setting it
# split the logs across two directories with no warning.
# Issue #873: the default moved off `$HOME/logs` and onto the platform's own
# location, so the resolution is asked for rather than spelled here — one
# default, in worker/deno/lib/log_dir.ts, shared with loop.sh, run.ps1 and the
# container mount. The command also prints the one-off legacy-location notice
# on stderr. Only the last stdout line is taken: warnings a loaded config emits
# go to stderr, and this stays correct if one ever does not.
if ! RUN_CORE_LOG_DIR="$("${DENO_CMD}" run \
  --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
  --allow-env --allow-read \
  "${BASE_DIR}/worker/deno/mod.ts" log-dir </dev/null)"; then
  echo "Error: cannot resolve the log directory (see above) - refusing to launch" >&2
  exit 1
fi
RUN_CORE_LOG_DIR="${RUN_CORE_LOG_DIR##*$'\n'}"
if [[ -z "${RUN_CORE_LOG_DIR// }" ]]; then
  echo "Error: the log directory resolved empty - refusing to launch" >&2
  exit 1
fi

log_run_core() {
  # The log directory is created by the launch plan later in the run, so it
  # may not exist yet at the first line written (Issue #512).
  mkdir -p "${RUN_CORE_LOG_DIR}" 2>/dev/null || true
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" \
    >>"${RUN_CORE_LOG_DIR}/run_core.log" 2>/dev/null || true
}

# The run mode - container, the only one (Issue #4). Still resolved by Deno
# rather than parsed here, so a .config.json (or VIBE_RUN_MODE) that names a
# removed mode fails loud in one place with the removal explained, and never
# silently becomes a container run the operator did not know they were
# getting (Issue #3234).
if ! RUN_MODE="$("${DENO_CMD}" run \
  --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
  --allow-env --allow-read \
  "${BASE_DIR}/worker/deno/mod.ts" run-mode </dev/null)"; then
  echo "Error: cannot resolve the run mode (see above)" >&2
  exit 1
fi
# Container is the only run mode (Issue #4): a removed or unrecognised value
# has already failed loud above, so this is the contract check, not a branch -
# the plan, the build and the launch below are the whole launcher.
if [[ "${RUN_MODE}" != "container" ]]; then
  echo "Error: unrecognised run mode: ${RUN_MODE}" >&2
  exit 1
fi

# Update the worker checkout on the host, before the container is launched
# (Issue #512). This is the only update of that checkout since Issue #513
# retired the in-container reset: nothing inside the container writes to
# /workspace, which is what lets that mount be read-only (Issue #509) - and it
# has to be, because the fleet self-update rewrites this very script, code the
# host executes.
#
# Failure is not fatal: a host that cannot reach GitHub still launches the
# worker on the checkout it already has. It says so loudly on stderr and in
# the run-core log rather than passing quietly (Issue #3234), and three
# consecutive failures raise a GitHub issue naming this host (Issue #4204).
#
# --allow-sys=hostname: that escalation titles its issue with the host id, so
# each host gets its own report instead of every host sharing one.
#
# The command reads update_mode and pinned_ref from .config.json itself, since
# it runs before the configuration load: a frozen host is held at its pinned
# ref rather than reset to the tip, and says so in the run-core log
# (Issue #624).
checkout_update_status=0
bounded 300 "${DENO_CMD}" run \
  --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
  --allow-env --allow-read --allow-write --allow-run --allow-sys=hostname \
  "${BASE_DIR}/worker/deno/mod.ts" worker-checkout-update \
  --base-dir "${BASE_DIR}" </dev/null >&2 || checkout_update_status=$?
if ((checkout_update_status != 0)); then
  echo "[run.sh] warning: could not update the worker checkout (status ${checkout_update_status}) - launching on the existing checkout" >&2
  log_run_core "worker-checkout-update: failed (status ${checkout_update_status}) - launching on the existing checkout"
fi

# Tell a pinned host when a newer release exists (Issue #690, part of #674).
# One line naming both versions and the command that installs the new one,
# once per launch, on stderr and in the run-core log so a non-interactive
# host's notice is not lost.
#
# All the logic lives in the Deno command, exactly as the checkout update's
# does: this shell captures stdout and prints it, nothing more. Stdout is the
# notice or empty - a dynamic host, a host already on the newest release, a
# commit-SHA pin and a repository with no releases all print nothing.
#
# Notifying only: nothing here changes a pin or moves the checkout, and a
# failed or timed-out check is a warning, never a refused launch. The bound is
# short because an unreachable GitHub must cost seconds, not a hung launch.
release_notice=""
release_notice_status=0
release_notice="$(bounded 120 "${DENO_CMD}" run \
  --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
  --allow-env --allow-read --allow-run \
  "${BASE_DIR}/worker/deno/mod.ts" release-notice \
  --base-dir "${BASE_DIR}" </dev/null)" || release_notice_status=$?
if ((release_notice_status != 0)); then
  echo "[run.sh] warning: could not check for a newer release (status ${release_notice_status}) - ${release_notice:-no explanation given}" >&2
  log_run_core "release-notice: failed (status ${release_notice_status}) - ${release_notice:-no explanation given}"
elif [[ -n "${release_notice}" ]]; then
  echo "${release_notice}" >&2
  log_run_core "${release_notice}"
fi
# The plan resolves and validates the container runtime, computes the
# content-derived image reference, and constructs the fixed least-privilege
# mount set. A missing runtime, config file or credential directory exits
# non-zero here with an actionable message (Issue #3234).
#
# --frozen + --lock fail closed on dependency drift (Issue #2896).
#
# The plan is written to a file rather than stdout because the worker's
# console secret redaction (Issue #3661) would mangle a mount value that
# looks like a credential; --allow-write is scoped to that file plus the
# read-only config staging directory the plan mounts (Apple container cannot
# mount a single file, so the command stages a copy there).
PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/vibe-launch-plan.XXXXXX")"
CONFIG_STAGE_DIR="${HOME}/.vibe-coder/run-config"
# --allow-sys=hostname: the plan resolves the host identity it passes into
# the container as VIBE_HOST_ID (fleet telemetry). Without it Deno.hostname()
# throws and heartbeats silently report the ephemeral container name.
if ! "${DENO_CMD}" run \
  --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
  --allow-env --allow-read --allow-run --allow-sys=hostname,systemMemoryInfo \
  --allow-write="${PLAN_FILE},${PLAN_FILE}.Containerfile,${CONFIG_STAGE_DIR}" \
  "${BASE_DIR}/worker/deno/mod.ts" container-launch-plan \
  --base-dir "${BASE_DIR}" \
  --container-name "${CONTAINER_NAME}" \
  --out "${PLAN_FILE}" </dev/null >&2; then
  echo "Error: cannot launch the Vibe Coder container (see above)" >&2
  exit 1
fi

# Read the NUL-delimited "key=value" plan into the argument lists it names.
IMAGE=""
WATCHDOG_SECONDS=""
ensure_dirs=()
volume_names=()
init_args=()
volume_remove_args=()
claim_floor_gb=""
claim_floor_percent=""
claim_floor_origin=""
exists_args=()
build_args=()
builder_stop_args=()
builder_absent_patterns=()
run_args=()

while IFS= read -r -d '' token; do
  key="${token%%=*}"
  value="${token#*=}"
  case "${key}" in
    runtime) RUNTIME="${value}" ;;
    image) IMAGE="${value}" ;;
    name) CONTAINER_NAME="${value}" ;;
    watchdog) WATCHDOG_SECONDS="${value}" ;;
    ensure) ensure_dirs+=("${value}") ;;
    volume) volume_names+=("${value}") ;;
    init) init_args+=("${value}") ;;
    volume-remove) volume_remove_args+=("${value}") ;;
    claim-floor-gb) claim_floor_gb="${value}" ;;
    claim-floor-percent) claim_floor_percent="${value}" ;;
    claim-floor-origin) claim_floor_origin="${value}" ;;
    exists) exists_args+=("${value}") ;;
    build) build_args+=("${value}") ;;
    builder-stop) builder_stop_args+=("${value}") ;;
    builder-absent) builder_absent_patterns+=("${value}") ;;
    run) run_args+=("${value}") ;;
    *)
      echo "Error: unrecognised launch-plan key: ${key}" >&2
      exit 1
      ;;
  esac
done <"${PLAN_FILE}"

if [[ -z "${RUNTIME}" || -z "${IMAGE}" ]] || [[ ${#run_args[@]} -eq 0 ]] ||
  [[ ${#build_args[@]} -eq 0 ]] || [[ ${#exists_args[@]} -eq 0 ]] ||
  [[ ${#volume_names[@]} -eq 0 ]] || [[ ${#init_args[@]} -eq 0 ]] ||
  [[ ${#volume_remove_args[@]} -eq 0 ]] ||
  [[ -z "${claim_floor_gb}" ]] || [[ -z "${claim_floor_percent}" ]]; then
  echo "Error: incomplete container launch plan - refusing to launch" >&2
  exit 1
fi

# The watchdog deadline is what stops a wedged container VM blocking this
# launcher for ever (Issue #4173), so a plan without a usable one is a loud
# failure rather than a launch with no deadline at all.
if ! [[ "${WATCHDOG_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: launch plan carries no usable watchdog deadline" \
    "(got \"${WATCHDOG_SECONDS}\") - refusing to launch" >&2
  exit 1
fi

# Only the read/write mounts are created here; a missing config file or
# credential directory already failed the plan above.
for dir in ${ensure_dirs[@]+"${ensure_dirs[@]}"}; do
  mkdir -p "${dir}"
done

# Pre-launch reaper (Issue #4173), before the image build so a leaked 1 GB VM
# is not still holding the host's memory through it. Any `vibe-coder-*`
# container older than the watchdog deadline - or with no live launcher process
# behind it, which is how a wedge that outlived a host reboot is caught - is
# killed here. Best-effort by design: a reaper that cannot run says so and the
# launch continues, because a leaked container from a previous cycle must not
# stop this one.
#
# What does stop this one is a worker container somebody else is legitimately
# running (Issue #26): the work volumes are per-host singletons, so a second
# worker would only fail on its storage attachment with a VM-internals error
# that names nothing. --refuse-live has the reaper say "already running"
# instead, and this launcher exits on that status alone.
reap_status=0
bounded 300 "${DENO_CMD}" run \
  --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
  --allow-env --allow-read --allow-write --allow-run \
  "${BASE_DIR}/worker/deno/mod.ts" container-reap \
  --runtime "${RUNTIME}" \
  --stale \
  --max-age-seconds "${WATCHDOG_SECONDS}" \
  --exclude "${CONTAINER_NAME}" \
  --refuse-live </dev/null >&2 || reap_status=$?
if ((reap_status == ANOTHER_WORKER_RUNNING_EXIT)); then
  echo "[run.sh] another worker is already running on this host - one worker per host; not launching (Issue #26)" >&2
  exit 1
elif ((reap_status != 0)); then
  echo "[run.sh] warning: the pre-launch container reaper did not complete" >&2
fi

# Build the image, streaming the output and capturing it for the heal.
# Returns the build's own exit status, not tee's.
run_build() {
  local status=0
  set +e
  "${RUNTIME}" "${build_args[@]}" </dev/null 2>&1 | tee "${BUILD_LOG}" >&2
  status="${PIPESTATUS[0]}"
  set -e
  return "${status}"
}

# Ask container-build-heal to classify the captured build failure and, when the
# builder's storage is what failed, restart it (Issue #4441). Exit 0 = healed,
# 3 = not a healable failure, anything else = the heal itself failed.
heal_builder() {
  local attempt="$1"
  bounded 900 "${DENO_CMD}" run \
    --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
    --allow-env --allow-read --allow-run \
    "${BASE_DIR}/worker/deno/mod.ts" container-build-heal \
    --runtime "${RUNTIME}" \
    --log "${BUILD_LOG}" \
    --attempt "${attempt}" </dev/null >&2
}

# Content-derived identity: a changed container definition is a different
# reference, so an absent reference is exactly the rebuild signal (#4062).
if ! "${RUNTIME}" "${exists_args[@]}" >/dev/null 2>&1; then
  echo "[run.sh] building ${IMAGE}" >&2
  record_phase image_build
  BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/vibe-build.XXXXXX")"

  build_status=0
  run_build || build_status=$?

  # Builder self-heal (Issue #4441). An ENOSPC mid-export leaves Apple
  # container's BuildKit VM with a read-only filesystem, and every later
  # launch then dies with "read-only file system" before it builds anything -
  # on host-23 loop.sh backed off to 960 s and would have retried for ever.
  # Exactly one heal and one retry per launch: a build that failed for its own
  # reasons still fails here, exactly as it always has.
  if ((build_status != 0)); then
    heal_status=0
    heal_builder 1 || heal_status=$?

    if ((heal_status == 0)); then
      echo "[run.sh] retrying the build of ${IMAGE} after a builder" \
        "restart (Issue #4441)" >&2
      log_run_core "container-build-heal: builder restarted after a storage failure - retrying ${IMAGE}"
      build_status=0
      run_build || build_status=$?
      if ((build_status == 0)); then
        log_run_core "container-build-heal: retry of ${IMAGE} succeeded"
      else
        # A second failure in the same launch escalates to a builder recreate,
        # so the next launch starts from a clean builder rather than the
        # damaged one. This launch still fails - it never loops.
        log_run_core "container-build-heal: retry of ${IMAGE} failed (status ${build_status}) - recreating the builder"
        heal_builder 2 || echo "[run.sh] warning: could not recreate the" \
          "${RUNTIME} builder" >&2
      fi
    elif ((heal_status == BUILD_NOT_HEALABLE_EXIT)); then
      log_run_core "container-build-heal: ${IMAGE} build failed for a reason the builder heal does not cover"
    else
      log_run_core "container-build-heal: could not heal the ${RUNTIME} builder (status ${heal_status})"
    fi

    if ((build_status != 0)); then
      echo "Error: failed to build ${IMAGE}" >&2
      # The build's own diagnostics are the only account of why this host
      # cannot reconstruct its environment, so the escalation carries them
      # (Issue #709).
      EVIDENCE_LOG="${BUILD_LOG}"
      exit "${build_status}"
    fi
  fi
fi

# Prune the tags this reference superseded (Issue #4162). The content-derived
# tag rebuilds on every container-definition change and nothing used to delete
# the tag it replaced: on host-23 four multi-gigabyte images filled the store and
# the next build died mid-export with "No space left on device". ${IMAGE} is the
# only reference a future launch of this checkout can use, so every other
# vibe-coder tag goes - a rollback rebuilds from the builder cache, which is
# deliberately left alone. Runs on every launch, not only after a build, so a
# host already carrying a backlog reclaims it now. Best-effort by design: a
# prune that cannot run says so and the launch continues, because reclaiming
# disk must never block the worker.
if ! bounded 600 "${DENO_CMD}" run \
  --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
  --allow-env --allow-read --allow-run \
  "${BASE_DIR}/worker/deno/mod.ts" container-image-prune \
  --runtime "${RUNTIME}" \
  --keep "${IMAGE}" </dev/null >&2; then
  echo "[run.sh] warning: could not prune superseded ${IMAGE} tags" >&2
fi

# Container-store telemetry (Issue #4331): the store lives on the host, so
# only the launcher can see it. One line per launch in run_core.log names
# the size per component; a fleet host that starts growing shows it here
# long before "No space left on device". Best-effort, macOS/Apple container
# only (Docker/Podman keep their stores elsewhere and prune themselves).
container_store="${HOME:-}/Library/Application Support/com.apple.container"
if [[ -d "${container_store}" ]] && command -v du >/dev/null 2>&1; then
  store_line="$(cd "${container_store}" 2>/dev/null && du -sh -- * 2>/dev/null | awk '{printf "%s=%s ", $2, $1}')"
  store_total="$(du -sh "${container_store}" 2>/dev/null | cut -f1)"
  printf '%s container-store: total=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${store_total:-?}" "${store_line}" \
    >>"${RUN_CORE_LOG_DIR}/run_core.log" 2>/dev/null || true
fi

# Reclaim the host container store (Issue #227). Host GRQ-23 crashed out of
# disk with ~20 GB reclaimable that nothing touched: the stopped builder's
# 13 GB rootfs, 5.8 GB of dangling image layers, and throwaway volumes the
# container tests leaked when they were killed. The command removes
# `vibe-test-*` volumes by name (never the production volumes, which nothing
# references at this point), prunes dangling layers (never the pinned base
# images), and deletes the builder only when the store's filesystem is below
# the free-space floor — its cache is what keeps a rebuild cheap. Best-effort:
# reclaiming disk must never block a launch.
if ! bounded 600 "${DENO_CMD}" run \
  --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
  --allow-env --allow-read --allow-run \
  "${BASE_DIR}/worker/deno/mod.ts" container-store-prune \
  --runtime "${RUNTIME}" \
  --store-path "${container_store}" </dev/null >&2; then
  echo "[run.sh] warning: could not reclaim the ${RUNTIME} store" >&2
fi

# Does the runtime's stop failure mean "there was no builder to stop"?
#
# Substring match, case-insensitively, against the fragments the launch plan
# carries for this runtime. An empty pattern list answers no to everything,
# so a runtime whose wording is unknown keeps warning rather than going
# quiet about a real failure.
builder_absent() {
  local detail lowered pattern
  detail="$1"
  ((${#builder_absent_patterns[@]})) || return 1
  lowered="$(printf '%s' "${detail}" | tr '[:upper:]' '[:lower:]')"
  for pattern in "${builder_absent_patterns[@]}"; do
    pattern="$(printf '%s' "${pattern}" | tr '[:upper:]' '[:lower:]')"
    [[ -n "${pattern}" && "${lowered}" == *"${pattern}"* ]] && return 0
  done
  return 1
}

# Stop the runtime's persistent build helper (Issue #4331). Apple container
# starts a `buildkit` builder VM for `container build` and leaves it running
# for ever — 2 CPUs, 2 GB and a 13 GB rootfs on every fleet host, observed
# still up 25 hours after the build it served. The image exists at this
# point (built above or already present), so the builder has nothing to do
# until the next definition change, when `container build` restarts it
# implicitly. Runtimes without a builder container carry no arguments here.
#
# Runs *after* the store prune (Issue #492), which deletes the builder
# outright when the host is below the free-space floor: stopping something
# a later step in the same launch is about to delete was pointless work,
# and it guaranteed that the next launch found nothing to stop.
#
# "Nothing to stop" is success, and the common case: the builder only
# exists after a build, and most launches find the image already built. A
# stop that fails for any other reason still warns — with the runtime's own
# explanation, which the previous `2>&1` to /dev/null threw away, leaving a
# warning that named no cause at all.
if [[ ${#builder_stop_args[@]} -gt 0 ]]; then
  builder_stop_err="$(mktemp -t vibe-builder-stop.XXXXXX)"
  if ! bounded 120 "${RUNTIME}" "${builder_stop_args[@]}" \
    </dev/null >/dev/null 2>"${builder_stop_err}"; then
    builder_stop_detail="$(tr '\n' ' ' <"${builder_stop_err}" | sed 's/[[:space:]]*$//')"
    if builder_absent "${builder_stop_detail}"; then
      log_run_core "builder-stop: no ${RUNTIME} builder to stop"
    else
      echo "[run.sh] warning: could not stop the ${RUNTIME} builder helper:" \
        "${builder_stop_detail:-no explanation given}" >&2
      log_run_core "builder-stop: failed: ${builder_stop_detail:-no explanation given}"
    fi
  fi
  rm -f "${builder_stop_err}"
fi

# Work-volume preparation (Issue #710). Everything from here to the launch
# below drives the container runtime - `volume create`, and the ownership init,
# which is itself a `run`. Those failures used to reach the supervisor still
# carrying the `runtime_detection` marker written on this script's first line,
# so an init container that never started (the runtime's own 125) was reported
# as a runtime-detection failure while the same alert said the status came from
# the runtime client. The marker now names the phase the launcher is really in.
record_phase volume_init

# Named volumes (Issue #4186): the work dir and its approval-state sibling
# live on runtime-managed volumes, not host directories. `volume inspect` and
# `volume create` are spelled identically on every supported runtime, so they
# are written out here; *removal* is not — Docker and Podman say `volume rm`,
# Apple `container` says `volume delete` — so the plan carries that verb and
# `recreate_volume` below uses it (Issue #731). The ownership init runs on
# every launch — it is
# an idempotent root chown of the mount roots, so a first launch that dies
# between create and chown heals on the next one.
for volume in ${volume_names[@]+"${volume_names[@]}"}; do
  if ! "${RUNTIME}" volume inspect "${volume}" >/dev/null 2>&1; then
    echo "[run.sh] creating volume ${volume}" >&2
    "${RUNTIME}" volume create "${volume}" </dev/null >/dev/null
  fi
done
# One line of a captured stderr file, for a message an operator reads.
#
# Empty output becomes an explicit "no explanation given" rather than a
# message that trails off — a failure with no words is still a failure.
runtime_error_detail() {
  local text
  text="$(tr '\n' ' ' <"$1" 2>/dev/null | sed 's/  */ /g; s/^ //; s/ $//')"
  printf '%s' "${text:-no explanation given}"
}

# Recreate one named volume, loudly (Issues #229, #478, #731).
#
# The removal verb comes from the plan — Docker and Podman spell it
# `volume rm`, Apple `container` spells it `volume delete` — because this
# script used to hardcode one of them and swallow the result. On Podman that
# meant `volume delete` was not a command at all: the error went to
# /dev/null, the volume survived, and the very next line failed with
# `volume with name vibe-work already exists`, which describes neither the
# fault nor its cause.
#
# A failed removal is judged by the volume, not by the exit code: one that is
# gone was nothing to remove and the create proceeds; one that is still there
# is reported in the runtime's own words, and the create that would certainly
# fail is not attempted.
#
# Arguments: the volume name. Returns non-zero when it could not be recreated.
recreate_volume() {
  local volume="$1" err detail
  err="$(mktemp)"

  if ! "${RUNTIME}" "${volume_remove_args[@]}" "${volume}" \
    </dev/null >/dev/null 2>"${err}"; then
    if "${RUNTIME}" volume inspect "${volume}" >/dev/null 2>&1; then
      detail="$(runtime_error_detail "${err}")"
      rm -f "${err}"
      echo "[run.sh] could not remove volume ${volume}: ${detail}" >&2
      log_run_core "volume: removing ${volume} failed: ${detail}"
      return 1
    fi
  fi

  if ! "${RUNTIME}" volume create "${volume}" </dev/null >/dev/null 2>"${err}"; then
    detail="$(runtime_error_detail "${err}")"
    rm -f "${err}"
    echo "[run.sh] could not create volume ${volume}: ${detail}" >&2
    log_run_core "volume: creating ${volume} failed: ${detail}"
    return 1
  fi

  rm -f "${err}"
  return 0
}

# The named volume mounted at an init target, on stdout; non-zero when no
# volume maps to that target.
volume_for_target() {
  local target="$1" candidate arg
  for candidate in ${volume_names[@]+"${volume_names[@]}"}; do
    for arg in "${init_args[@]}"; do
      if [[ "${arg}" == "${candidate}:${target}" ]]; then
        printf '%s' "${candidate}"
        return 0
      fi
    done
  done
  return 1
}

# Volumes the runtime refused to trim, by name (Issue #478). Rewritten by
# every run_volume_init from the init's `VOLUME_TRIM_REFUSED <target>` lines.
trim_refused_volumes=()

# Record the trim refusals in one init's output. A refusal is a fact about
# this host's runtime, not a warning to be lost in stderr: it is what
# heal_untrimmable_volumes below acts on.
note_trim_refusals() {
  local line target volume
  trim_refused_volumes=()
  while IFS= read -r line; do
    [[ "${line}" == VOLUME_TRIM_REFUSED\ * ]] || continue
    target="${line#VOLUME_TRIM_REFUSED }"
    volume="$(volume_for_target "${target}" || true)"
    if [[ -z "${volume}" ]]; then
      echo "[run.sh] volume-init could not trim ${target} but no volume maps to it" >&2
      continue
    fi
    trim_refused_volumes+=("${volume}")
    log_run_core "work-volume: the runtime refused to trim ${volume} (${target}) - the volume image keeps every block it holds (Issue #478)"
  done <<<"${1}"
}

# The init run (Issues #4186, #229) checks each block-device volume's
# filesystem and chowns the roots. Exit 3 names the volume(s) e2fsck could
# not repair on stdout (`VOLUME_UNREPAIRABLE <target>`): those are recreated
# — the clones are disposable, everything of value is pushed — and the init
# runs once more. Any other failure is the launch failure it always was.
run_volume_init() {
  local out status=0
  out="$("${RUNTIME}" "${init_args[@]}" </dev/null)" || status=$?
  if ((status == 3)); then
    local target volume line recreated=0
    while IFS= read -r line; do
      [[ "${line}" == VOLUME_UNREPAIRABLE\ * ]] || continue
      target="${line#VOLUME_UNREPAIRABLE }"
      volume="$(volume_for_target "${target}" || true)"
      if [[ -z "${volume}" ]]; then
        echo "[run.sh] volume-init reported ${target} unrepairable but no volume maps to it" >&2
        continue
      fi
      echo "[run.sh] recreating volume ${volume}: its filesystem could not be repaired (Issue #229)" >&2
      log_run_core "volume-init: recreating ${volume} (${target}) - filesystem unrepairable (Issue #229)"
      # A recreate that fails leaves the init's own exit 3 to be reported:
      # better the unrepairable filesystem than a misleading "already exists".
      if recreate_volume "${volume}"; then
        recreated=1
      fi
    done <<<"${out}"
    if ((recreated)); then
      status=0
      out="$("${RUNTIME}" "${init_args[@]}" </dev/null)" || status=$?
    fi
  fi
  note_trim_refusals "${out}"
  return "${status}"
}
run_volume_init

# Where the host's free space is measured: the container store when it
# exists, else HOME (the same filesystem on macOS).
disk_gate_path="${HOME}"
if [[ -d "${container_store}" ]]; then
  disk_gate_path="${container_store}"
fi

# Self-heal a volume the runtime will not trim (Issue #478).
#
# #384 made the launch-time `fstrim` the supported compaction path, but the
# Apple container runtime refuses FITRIM outright — as root, on a device that
# advertises discard — so it has never returned a byte on this fleet and the
# thin-provisioned image only grows. GRQ-23 held ~14 GB of dead space, sat
# below its floor for three days claiming nothing, and the only remedy on
# offer (a hand-run `volume rm vibe-work`, or `volume delete` on Apple
# `container`) was addressed to a human who
# was not there. An unattended host has no human, so the launcher takes it.
#
# When the init reports the trim refused AND the host is below the floor the
# worker stops claiming at, the volume is recreated here — before any
# container runs, so no work is in flight; the clones re-clone and the
# approval snapshots re-baseline, exactly as #384 documents.
#
# Bounded and never silent: at most one recreate per
# VIBE_WORK_VOLUME_HEAL_INTERVAL_HOURS, never for volumes too small to hold
# the host's missing space, and a recreate that leaves the host below the
# floor is reported as `[WORK_VOLUME_UNRECOVERED]` rather than as a fix. The
# launch continues either way: a host that cannot claim must still run and
# report (Issue #477), and the hard floor below is what stops it.
HEAL_STATE_FILE="${VIBE_WORK_VOLUME_HEAL_STATE:-${HOME}/.vibe-coder/work-volume-heal}"

# Free (field 2) or total (field 4) kilobytes of the gate's filesystem.
host_disk_field_kb() {
  df -kP "${disk_gate_path}" 2>/dev/null |
    awk -v f="$1" 'NR>1 {v=$(NF-f)} END {print v}'
}

# The floor the worker stops claiming at, in kilobytes: the larger of the two
# terms the plan carries. The terms are resolved by `resolveDiskFloors` in
# worker/deno/lib/host_disk.ts — `.config.json` first, then
# VIBE_HOST_DISK_LOW_FLOOR_GB / VIBE_HOST_DISK_LOW_FLOOR_PERCENT, then the
# defaults (Issues #289, #732) — so the launcher heals at exactly the floor
# the worker claims at, and a floor stated in the configuration is not
# silently ignored by the launcher because it only ever read the environment.
claim_floor_kb() {
  local total_kb="$1" gb="${claim_floor_gb}" pct="${claim_floor_percent}"
  local by_gb by_pct
  [[ "${gb}" =~ ^[0-9]+$ ]] || gb=20
  [[ "${pct}" =~ ^[0-9]+$ && "${pct}" -le 100 ]] || pct=10
  by_gb=$((gb * 1024 * 1024))
  by_pct=$((total_kb * pct / 100))
  if ((by_gb > by_pct)); then printf '%s' "${by_gb}"; else printf '%s' "${by_pct}"; fi
}

# The floor, and where it came from, for a message an operator can act on.
# A refused claim that names only a number leaves the reader to guess which
# knob would move it (Issue #732).
claim_floor_detail() {
  local total_kb="$1" floor_kb
  floor_kb="$(claim_floor_kb "${total_kb}")"
  printf 'floor %s MB (larger of %s GB and %s%% of %s MB; %s)' \
    "$((floor_kb / 1024))" "${claim_floor_gb}" "${claim_floor_percent}" \
    "$((total_kb / 1024))" "${claim_floor_origin:-unknown}"
}

# Kilobytes the runtime's store holds for a named volume; non-zero when the
# store layout is one this launcher cannot measure.
volume_store_kb() {
  local path="${container_store}/volumes/$1"
  [[ -d "${path}" ]] || return 1
  du -sk "${path}" 2>/dev/null | awk 'END {print $1}'
}

# A heal that did not clear the floor reports what is still wrong. Never a
# silent retry, and never dressed up as a fix.
report_unrecovered() {
  echo "[run.sh] [WORK_VOLUME_UNRECOVERED] $1 (Issues #478, #226)" >&2
  log_run_core "[WORK_VOLUME_UNRECOVERED] $1 (Issues #478, #226)"
}

heal_untrimmable_volumes() {
  ((${#trim_refused_volumes[@]})) || return 0

  local avail_kb total_kb floor_kb volume
  avail_kb="$(host_disk_field_kb 2)"
  total_kb="$(host_disk_field_kb 4)"
  if ! [[ "${avail_kb}" =~ ^[0-9]+$ && "${total_kb}" =~ ^[1-9][0-9]*$ ]]; then
    report_unrecovered "the runtime refused to trim ${trim_refused_volumes[*]} and ${disk_gate_path} could not be measured - no volume is destroyed on a guess"
    return 0
  fi
  floor_kb="$(claim_floor_kb "${total_kb}")"
  local floor_detail
  floor_detail="$(claim_floor_detail "${total_kb}")"
  if ((avail_kb >= floor_kb)); then
    log_run_core "work-volume: trim refused for ${trim_refused_volumes[*]}; $((avail_kb / 1024)) MB free is above the claiming ${floor_detail} - the image is ratcheting but the host is not short (Issue #478)"
    return 0
  fi
  log_run_core "host-disk: $((avail_kb / 1024)) MB free on ${disk_gate_path} is below the claiming ${floor_detail} (Issues #226, #732)"

  local now last interval_hours
  now="$(date +%s)"
  interval_hours="${VIBE_WORK_VOLUME_HEAL_INTERVAL_HOURS:-24}"
  [[ "${interval_hours}" =~ ^[0-9]+$ ]] || interval_hours=24
  last="$(cat "${HEAL_STATE_FILE}" 2>/dev/null || echo 0)"
  [[ "${last}" =~ ^[0-9]+$ ]] || last=0
  if ((last > 0 && now - last < interval_hours * 3600)); then
    report_unrecovered "the last recreate was $(((now - last) / 60)) minutes ago and ${disk_gate_path} still has $((avail_kb / 1024)) MB free, below the $((floor_kb / 1024)) MB claiming floor - recreating again would destroy the clones without clearing the floor"
    return 0
  fi

  # Only a volume big enough to hold the missing space is worth destroying.
  local kb held_kb=0 measured=0 min_gb="${VIBE_WORK_VOLUME_HEAL_MIN_GB:-1}"
  [[ "${min_gb}" =~ ^[0-9]+$ ]] || min_gb=1
  for volume in "${trim_refused_volumes[@]}"; do
    kb="$(volume_store_kb "${volume}" || true)"
    if [[ "${kb}" =~ ^[0-9]+$ ]]; then
      measured=1
      held_kb=$((held_kb + kb))
    fi
  done
  if ((measured)) && ((held_kb < min_gb * 1024 * 1024)); then
    report_unrecovered "${trim_refused_volumes[*]} hold only $((held_kb / 1024)) MB in ${container_store} - the host's missing space is somewhere else, so recreating them would destroy the clones for nothing"
    return 0
  fi

  for volume in "${trim_refused_volumes[@]}"; do
    echo "[run.sh] recreating volume ${volume}: the runtime refuses to trim it and the host is below its claiming floor (Issue #478)" >&2
    log_run_core "work-volume: recreating ${volume} - trim refused and $((avail_kb / 1024)) MB free is below the $((floor_kb / 1024)) MB claiming floor (Issue #478)"
    if ! recreate_volume "${volume}"; then
      report_unrecovered "${volume} could not be recreated - see the runtime error above; the host is still below its claiming floor"
      return 0
    fi
  done
  mkdir -p "$(dirname "${HEAL_STATE_FILE}")" 2>/dev/null || true
  printf '%s\n' "${now}" >"${HEAL_STATE_FILE}" 2>/dev/null || true

  # A fresh volume is root-owned and unchecked, so the init runs again.
  run_volume_init

  # Measured, not assumed: the heal is only a heal if the host got the space.
  avail_kb="$(host_disk_field_kb 2)"
  if [[ "${avail_kb}" =~ ^[0-9]+$ ]] && ((avail_kb >= floor_kb)); then
    log_run_core "work-volume: the recreate returned ${disk_gate_path} to $((avail_kb / 1024)) MB free, above the $((floor_kb / 1024)) MB claiming floor (Issue #478)"
    return 0
  fi
  report_unrecovered "the recreate left ${disk_gate_path} with $((avail_kb / 1024)) MB free, still below the $((floor_kb / 1024)) MB claiming floor - the work volume is not where this host's space went"
}
heal_untrimmable_volumes

# Hard free-disk floor (Issue #226). Host GRQ-23 ran its data volume to zero
# with the worker running: log writes failed, two issues' work was lost and
# the host went down. Everything above has had its chance to reclaim; if the
# filesystem holding the container store is still below the floor, this
# launch stops here — the supervisor's backoff retries later. Measured on the
# store when it exists, else on HOME (the same filesystem on macOS).
#
# The gate runs AFTER the volume init (Issue #384), because the init is what
# trims the work volume and that trim is the only thing that returns the
# guest's freed blocks to the host. Gating first made the floor unreachable
# by construction: a host below it refused the launch, the volume was never
# trimmed, and the thin-provisioned image kept every block it had ever been
# allocated — GRQ-23 sat there for days, claiming nothing. Where the runtime
# refuses that trim, the self-heal above has already recreated the volume
# (Issue #478), so this reading is taken after both have had their chance.
disk_avail_kb="$(host_disk_field_kb 2)"
disk_hard_floor_gb="${VIBE_HOST_DISK_HARD_FLOOR_GB:-5}"

# A disk decision taken after a refused trim must say so (Issue #734). The
# refusal never triggers a decision by itself — the heal above requires the
# host to be below its claiming floor as well, and this floor is a measurement
# of the host — but where a runtime cannot discard, the space the guest freed
# never comes back, so the refusal is the reason the reading is what it is. An
# operator reading "refusing to launch: 900 MB free" with no mention of it is
# left with an unexplained work refusal.
trim_refusal_note=""
if ((${#trim_refused_volumes[@]})); then
  trim_refusal_note=" - this runtime refused to trim ${trim_refused_volumes[*]} on this launch, so the volume image keeps every block it holds and the guest's own reclaim cannot return host disk (Issues #384, #734)"
fi

if [[ "${disk_avail_kb}" =~ ^[0-9]+$ && "${disk_hard_floor_gb}" =~ ^[0-9]+$ ]]; then
  if ((disk_avail_kb < disk_hard_floor_gb * 1024 * 1024)); then
    echo "[run.sh] refusing to launch: ${disk_gate_path} has $((disk_avail_kb / 1024)) MB free," \
      "below the ${disk_hard_floor_gb} GB hard floor (VIBE_HOST_DISK_HARD_FLOOR_GB) (Issue #226)${trim_refusal_note}" >&2
    log_run_core "host-disk: refused launch - $((disk_avail_kb / 1024)) MB free on ${disk_gate_path} is below the ${disk_hard_floor_gb} GB hard floor (Issue #226)${trim_refusal_note}"
    exit 1
  fi
  disk_total_kb="$(host_disk_field_kb 4)"
  if [[ "${disk_total_kb}" =~ ^[1-9][0-9]*$ ]]; then
    log_run_core "host-disk: $((disk_avail_kb / 1024)) MB free on ${disk_gate_path}; claiming $(claim_floor_detail "${disk_total_kb}")${trim_refusal_note}"
  else
    log_run_core "host-disk: $((disk_avail_kb / 1024)) MB free on ${disk_gate_path}${trim_refusal_note}"
  fi
fi

# Exit status this launcher reports after reaping a wedged container - a named
# reason rather than a bare failure, and deliberately outside the runtime CLI's
# own 125/126/127 range. Kept in step with CONTAINER_WEDGED_EXIT_STATUS in
# worker/deno/lib/container_watchdog.ts by the launcher tests (Issue #4173).
CONTAINER_WEDGED_EXIT_STATUS=87

# The outer watchdog (Issue #4173). The runtime client is waited on under the
# plan's deadline instead of for ever: on expiry the reaper kills the container
# and, when the runtime refuses ("running and can not be deleted"), SIGKILLs
# the client and the runtime helper process holding the VM. Runs as a child of
# this shell so the wait below is untouched - `wait` still reports the client's
# own status - and writes the marker before reaping so the exit status can name
# the reason.
# shellcheck disable=SC2317,SC2329
watchdog_reap_on_deadline() {
  # Runs only as a background job, so it drops the launcher's EXIT trap for its
  # own subshell: bash would otherwise run that trap when this returns, and the
  # launcher would record a second outcome and remove its own evidence
  # (Issue #711).
  trap - EXIT
  local client_pid="$1"
  local poll=15
  if ((WATCHDOG_SECONDS < poll)); then
    poll=1
  fi

  local waited=0
  while ((waited < WATCHDOG_SECONDS)); do
    kill -0 "${client_pid}" 2>/dev/null || return 0
    # The sleep's own streams are detached: when this watchdog is stopped after
    # a clean run, an orphaned sleep must not hold the launcher's stdout pipe
    # open and stall whoever is reading it.
    sleep "${poll}" >/dev/null 2>&1
    waited=$((waited + poll))
  done
  kill -0 "${client_pid}" 2>/dev/null || return 0

  echo "[run.sh] watchdog: ${CONTAINER_NAME} is still running after" \
    "${WATCHDOG_SECONDS}s - reaping it (Issue #4173)" >&2
  printf 'container_wedged\n' >"${WEDGE_MARKER}"

  if ! bounded 300 "${DENO_CMD}" run \
    --frozen --lock="${BASE_DIR}/worker/deno/deno.lock" \
    --allow-env --allow-read --allow-write --allow-run \
    "${BASE_DIR}/worker/deno/mod.ts" container-reap \
    --runtime "${RUNTIME}" \
    --name "${CONTAINER_NAME}" \
    --client-pid "${client_pid}" \
    --reason "the launcher's ${WATCHDOG_SECONDS}s watchdog deadline expired" \
    </dev/null >&2; then
    echo "[run.sh] warning: the container reaper did not clear" \
      "${CONTAINER_NAME}" >&2
  fi

  # Last resort, whatever the reaper managed: the client must not outlive its
  # own reaping, or this launcher - and the supervisor behind it - waits for
  # ever, which is the failure this watchdog exists to end.
  kill -KILL "${client_pid}" 2>/dev/null || true
}

# Created before the container starts: a launcher that cannot write its own
# marker must fail here, not after it has a container to look after.
WEDGE_MARKER="$(mktemp "${TMPDIR:-/tmp}/vibe-wedge.XXXXXX")"

record_phase container_run

# How long the capture is given to drain once the client has exited, before it
# is quoted as far as it got. Seconds, because end-of-file arrives with the
# client's last write; the bound is only there so a helper still holding the
# pipe cannot stall this launcher.
RUN_DRAIN_SECONDS=10

# Capture the client's stderr while it still reaches the console (Issue #711).
# Issue #711 was the third self-heal report to say `container_start`, `exit
# status 125` and nothing about why: the client's own explanation went to the
# console and was kept nowhere. tee keeps the console live - the container's
# output IS this run's console, so it must not be held back until exit - and
# leaves a copy the outcome recorder can quote.
#
# Through a FIFO rather than a pipeline, because $! must stay the client's own
# PID: a pipeline would put tee there instead, and the watchdog below would
# then wait on, and reap, the wrong process.
#
# Set up before the container starts, because a capture armed after the launch
# would miss the refusal it exists to record. A host with no tee or mkfifo
# launches without it and says so: evidence is what a failure would be reported
# with, and the worker run itself is what the host is for - so the missing tool
# costs the report its cause, never the run.
if command -v tee >/dev/null 2>&1 && command -v mkfifo >/dev/null 2>&1; then
  RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/vibe-run.XXXXXX")"
  RUN_ERR_FIFO="${RUN_LOG}.err"
  mkfifo "${RUN_ERR_FIFO}"
  tee -a "${RUN_LOG}" >&2 <"${RUN_ERR_FIFO}" &
  RUN_TEE_PID=$!
else
  echo "[run.sh] warning: no tee/mkfifo on this host - a refused container" \
    "start will be reported without the runtime's own explanation" \
    "(Issue #711)" >&2
fi

LAUNCH_IN_FLIGHT=1
if [[ -n "${RUN_LOG}" ]]; then
  "${RUNTIME}" "${run_args[@]}" "$@" </dev/null 2>"${RUN_ERR_FIFO}" &
else
  "${RUNTIME}" "${run_args[@]}" "$@" </dev/null &
fi
CHILD_PID=$!
LAUNCH_IN_FLIGHT=""
deliver_pending_signal

watchdog_reap_on_deadline "${CHILD_PID}" &
WATCHDOG_PID=$!

status=0
wait_for_child || status=$?

# The client is gone, so the watchdog has nothing left to guard.
kill "${WATCHDOG_PID}" 2>/dev/null || true

# The capture is only evidence once the copier has drained the client's stderr,
# which it has when it exits on end-of-file. Waited on rather than assumed:
# quoting a half-written log would report a refusal missing the line that
# explains it.
#
# Bounded, because this wait must never become the wedge the watchdog exists to
# end: a runtime helper that inherited the client's stderr can hold the pipe
# open after the client itself is gone. The guard's streams are detached so an
# orphaned sleep cannot hold this launcher's stdout open behind it - killing
# the guard leaves that sleep running, which is why they are detached rather
# than merely closed.
#
# A guard that ran to completion is a guard that fired, so the truncation it
# caused is reported rather than quoted as if the capture were whole.
if [[ -n "${RUN_LOG}" ]]; then
  # The guard drops every trap it inherited: EXIT so it cannot record a second
  # launcher outcome, TERM/INT so the kill below actually ends it rather than
  # being caught by this launcher's signal forwarder and leaving the drain
  # waiting out the whole deadline on every launch.
  { trap - EXIT TERM INT
    sleep "${RUN_DRAIN_SECONDS}" && kill "${RUN_TEE_PID}"; } >/dev/null 2>&1 &
  RUN_DRAIN_GUARD_PID=$!
  wait "${RUN_TEE_PID}" 2>/dev/null || true
  # SIGKILL, because SIGTERM can land in the window between the guard being
  # forked and it clearing the traps it inherited - and in that window this
  # launcher's own TERM forwarder catches it, the guard keeps sleeping, and
  # every launch pays the full deadline here. The guard holds no state, so
  # there is nothing for it to clean up on the way out.
  kill -KILL "${RUN_DRAIN_GUARD_PID}" 2>/dev/null || true
  drain_guard_status=0
  wait "${RUN_DRAIN_GUARD_PID}" 2>/dev/null || drain_guard_status=$?
  if ((drain_guard_status == 0)); then
    echo "[run.sh] warning: the container's stderr was still being written" \
      "${RUN_DRAIN_SECONDS}s after the client exited - the captured evidence" \
      "is incomplete (Issue #711)" >&2
  fi
fi

if [[ -s "${WEDGE_MARKER}" ]]; then
  echo "Error: container ${CONTAINER_NAME} wedged past the" \
    "${WATCHDOG_SECONDS}s watchdog deadline and was reaped - exiting" \
    "${CONTAINER_WEDGED_EXIT_STATUS} so the next cycle runs (Issue #4173)" >&2
  status="${CONTAINER_WEDGED_EXIT_STATUS}"
fi

# A launch that failed hands this capture over as its evidence, whatever the
# status (Issue #1029).
#
# Issue #711 restricted it to the three statuses only the runtime client
# produces, reasoning that any other status came from a container that started
# and so said nothing about the launch. That does not survive a worker_run
# escalation. Exit 1 IS the worker reporting its own bootstrap, config,
# credential or loop failure, and the lines naming which one are on the stream
# this capture holds - so the one status whose cause is most knowable was the
# one reported with nothing at all. Issues #994, #995, #996 and #1029 all
# arrived that way, naming a phase and a status; Issue #945 is the same
# failure on a host running loop.sh, which passes its cycle log
# unconditionally, and it carried the cause.
#
# It also restores the network-unavailable suppression (Issue #949) on this
# path: the recorder reads the VIBE-NETWORK-UNAVAILABLE marker out of the log
# it is handed, so a launcher that hands over nothing can never classify a
# transient GitHub outage as one. Every blip then climbs the failure ladder
# instead of re-probing at the base cadence, which is how a host reaches nine
# consecutive failures over a link that has since come back.
#
# A launch that succeeded is still never quoted: there is no failure for its
# output to be the evidence of.
if ((status != 0)) && [[ -n "${RUN_LOG}" ]]; then
  EVIDENCE_LOG="${RUN_LOG}"
fi

exit "${status}"
