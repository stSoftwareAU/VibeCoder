#!/bin/bash
#
# Scripted first-run verification for a fresh Ubuntu + Podman host (Issue #736).
#
# Issue #722's definition of done is an end-to-end run, not green unit tests:
# on a fresh host with a Codex-only configuration, `setup.sh` then `run.sh`
# must complete and the worker must take one issue end to end with **no**
# manual workarounds. This script is that run, scripted rather than
# hand-driven, so its output is comparable between attempts and a later
# regression is caught by running it again against a fresh host.
#
# It verifies; it never repairs. A host already carrying one of the reporter's
# workarounds is refused before any stage runs, because a run started from a
# patched host proves nothing.
#
# This file only sequences the run: it gathers facts, starts `setup.sh` and
# `run.sh`, waits on the container and the worker, and captures what each
# stage printed. Every judgement — fresh state, the Codex-only configuration,
# the image, whether the worker claimed and completed, expected warning versus
# new defect, the verdict and the report — is made by `first-run-verify` in
# worker/deno, where it is unit-tested without a host.
#
# It leaves no worker behind: the launcher and any vibe-coder container are
# stopped on exit, however the run ends. The image it built is left alone —
# re-provision the host before the next run, which stage 1 requires anyway.
#
# Usage:
#   infra/verify/first-run.sh [--transcript-dir DIR] [--repo-root DIR]
#                             [--claim-timeout SECONDS]
#                             [--launch-timeout SECONDS]
#                             [--poll-interval SECONDS]
#
# Exit status: 0 only when every stage passed and no defect was detected.
# Anything else — a refused precondition, a failed stage, a skipped stage, a
# detected defect — exits non-zero and the report says which.
#
# Australian English spelling used throughout (behaviour, colour, etc.).

# Every stage function is reached through the stage() dispatcher below rather
# than by name, so ShellCheck cannot see the call sites.
# shellcheck disable=SC2329

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -P "${SCRIPT_DIR}/../.." && pwd -P)"
TRANSCRIPT_DIR=""
# The provider this verification configures. Issue #736 is the Codex-only run;
# a bare host has no .config.json for setup to read the selection from.
PROVIDER="codex"
CLAIM_TIMEOUT=2700
LAUNCH_TIMEOUT=1800
POLL_INTERVAL=15

usage() {
  cat <<'USAGE'
Scripted first-run verification for a fresh Ubuntu + Podman host (Issue #736).

Usage:
  infra/verify/first-run.sh [options]

Options:
  --transcript-dir DIR    Where stage output and report.md are written
                          (default: ~/vibe-first-run-verification/<timestamp>)
  --repo-root DIR         Checkout under test (default: this script's checkout)
  --claim-timeout SECONDS How long the worker gets to take one issue to
                          completion (default: 2700)
  --launch-timeout SECONDS How long run.sh gets to start the container
                          (default: 1800)
  --poll-interval SECONDS  Wait between polls (default: 15)
  -h, --help              Print this help

Exit status is 0 only when every stage passed and no defect was detected.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --transcript-dir)
      TRANSCRIPT_DIR="${2:?--transcript-dir needs a directory}"
      shift 2
      ;;
    --claim-timeout)
      CLAIM_TIMEOUT="${2:?--claim-timeout needs seconds}"
      shift 2
      ;;
    --launch-timeout)
      LAUNCH_TIMEOUT="${2:?--launch-timeout needs seconds}"
      shift 2
      ;;
    --poll-interval)
      POLL_INTERVAL="${2:?--poll-interval needs seconds}"
      shift 2
      ;;
    --repo-root)
      REPO_ROOT="${2:?--repo-root needs a directory}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "first-run: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${TRANSCRIPT_DIR}" ]]; then
  TRANSCRIPT_DIR="${HOME}/vibe-first-run-verification/$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "${TRANSCRIPT_DIR}"
TRANSCRIPT_DIR="$(cd -P "${TRANSCRIPT_DIR}" && pwd -P)"
REPORT="${TRANSCRIPT_DIR}/report.md"
FRESH_STATE_JSON="${TRANSCRIPT_DIR}/fresh-state.json"
RUN_CORE_LOG="${HOME}/logs/run_core.log"
WORKER_LOG="${HOME}/logs/worker.log"

say() { printf '[first-run] %s\n' "$*"; }

# The decision half. Run from the checkout under test, so the verification
# judges the code it is verifying.
verify() {
  (cd "${REPO_ROOT}" && deno run --allow-read --allow-write --allow-env \
    worker/deno/mod.ts first-run-verify "$@")
}

# ---------------------------------------------------------------------------
# Stage 1 - fresh state
#
# The facts are gathered here; whether they mean the host is fresh is decided
# by the preflight mode.
# ---------------------------------------------------------------------------

CONFIG_FILE_RESOLVED=""

check_fresh_state() {
  local log="$1" images="${TRANSCRIPT_DIR}/local-images.txt"
  local status_file="${TRANSCRIPT_DIR}/checkout-status.txt" claude_on_path

  # `CONFIG_FILE` is canonical and `CONFIG_PATH` its alias (Issue #750). The
  # repository's own resolver answers which file this host uses, and refuses a
  # host that sets the two to different files.
  if ! CONFIG_FILE_RESOLVED="$(verify --mode config-path \
    --base-dir "${REPO_ROOT}" 2>&1 | tail -1)"; then
    printf '%s\n' "${CONFIG_FILE_RESOLVED}" >"${log}"
    return 1
  fi

  # A podman that cannot list its images is a fault, never an empty list: an
  # empty list reads as "no image was pre-built", which is the fresh-state
  # answer this run must earn rather than inherit from a broken probe.
  if ! podman image ls --format '{{.Repository}}' >"${images}" 2>"${log}"; then
    echo "podman could not list its images, so freshness cannot be judged" \
      >>"${log}"
    return 1
  fi
  if ! git -C "${REPO_ROOT}" status --porcelain >"${status_file}" 2>>"${log}"; then
    echo "the checkout could not be read, so it cannot be shown unpatched" \
      >>"${log}"
    return 1
  fi
  claude_on_path="$(command -v claude >/dev/null 2>&1 && echo true || echo false)"

  {
    printf 'configuration file: %s\n' "${CONFIG_FILE_RESOLVED}"
    verify --mode preflight \
      --config-file "${CONFIG_FILE_RESOLVED}" \
      --claude-on-path "${claude_on_path}" \
      --declared-provider "${PROVIDER}" \
      --images "${images}" \
      --checkout-status "${status_file}" \
      --user-registries "${HOME}/.config/containers/registries.conf" \
      --system-registries /etc/containers/registries.conf \
      --out "${FRESH_STATE_JSON}"
  } >>"${log}" 2>&1
}

# ---------------------------------------------------------------------------
# Stage 2 - prerequisites present on the host
# ---------------------------------------------------------------------------

check_prerequisites() {
  local log="$1" missing=() tool
  local runtime_file="${TRANSCRIPT_DIR}/container-runtime.txt"
  {
    for tool in podman deno gh git codex; do
      if command -v "${tool}" >/dev/null 2>&1; then
        printf '%s: %s\n' "${tool}" "$(command -v "${tool}")"
        "${tool}" --version 2>&1 | head -2 || true
      else
        printf '%s: ABSENT\n' "${tool}"
      fi
    done
    echo
    echo "== free space =="
    df -h / 2>&1 || true
  } >"${log}" 2>&1

  for tool in podman deno gh git; do
    command -v "${tool}" >/dev/null 2>&1 || missing+=("${tool}")
  done
  if ((${#missing[@]} > 0)); then
    printf 'missing host prerequisites: %s\n' "${missing[*]}" >>"${log}"
    return 1
  fi

  # The launcher must take the podman branch: Docker is deliberately absent.
  # The detector's own answer is captured to its own file and its exit status
  # is honoured — grepping this stage's log would only find the `podman:
  # /usr/bin/podman` line written above, so the check could never fail.
  echo "== container runtime the launcher will use ==" >>"${log}"
  if ! (cd "${REPO_ROOT}" && deno run --allow-run --allow-env \
    worker/deno/mod.ts container-runtime-detect) >"${runtime_file}" 2>>"${log}"; then
    cat "${runtime_file}" >>"${log}"
    echo "the launcher's runtime detection failed, so the runtime it would" \
      "use is unknown" >>"${log}"
    return 1
  fi
  cat "${runtime_file}" >>"${log}"
  if ! grep -qi podman "${runtime_file}"; then
    echo "the launcher resolved $(tr -d '\n' <"${runtime_file}")," \
      "not podman, as this host's runtime" >>"${log}"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Stage 3 - setup.sh
#
# Every credential and configuration prompt is behind a TTY check, so a run
# with no terminal skips them all and writes nothing. With a terminal, setup
# runs under util-linux `script` so the operator answers live and the
# transcript is still captured; with none, the log says so and stage 4 fails
# on the configuration that was never written.
# ---------------------------------------------------------------------------

run_setup() {
  local log="$1" status=0
  # A bare host has no .config.json for setup to read the provider selection
  # from - criterion 2 requires setup to write it - so the run says which agent
  # this host is being configured for, which docs/SETUP.md names as the
  # first-run way to do it (Issue #730). The preflight records the declaration
  # in the report so a reader judges it rather than finding it in a log.
  export VIBE_AGENT_PROVIDER="${PROVIDER}"
  if [[ -t 0 ]] && command -v script >/dev/null 2>&1; then
    script -q -e -c "cd '${REPO_ROOT}' && ./setup.sh" "${log}" || status=$?
  else
    (cd "${REPO_ROOT}" && ./setup.sh) >"${log}" 2>&1 </dev/null || status=$?
    echo "setup.sh ran with no terminal attached - every interactive prompt was skipped" >>"${log}"
  fi
  return "${status}"
}

# ---------------------------------------------------------------------------
# Stage 4 - the configuration setup wrote
# ---------------------------------------------------------------------------

check_config() {
  local log="$1"
  verify --mode config --config "${CONFIG_FILE_RESOLVED}" >"${log}" 2>&1
}

# ---------------------------------------------------------------------------
# Stage 5 - run.sh: build, volume initialisation, container launch
#
# run.sh runs the worker in the foreground, so it is started in the background
# here and watched, bounded, until the container is up or it exits.
# ---------------------------------------------------------------------------

LAUNCH_LOG=""
LAUNCH_PID=""
RUN_CORE_OFFSET=0

# Only the run_core.log this launch wrote. `tail -c +N` counts from byte N, so
# the offset recorded before the launch becomes the first byte to read.
run_core_window() {
  local out="${TRANSCRIPT_DIR}/run_core-window.log"
  : >"${out}"
  if [[ -f "${RUN_CORE_LOG}" ]]; then
    tail -c "+$((RUN_CORE_OFFSET + 1))" "${RUN_CORE_LOG}" >"${out}"
  fi
  printf '%s' "${out}"
}

launcher_running() { kill -0 "${LAUNCH_PID}" 2>/dev/null; }

container_listed() {
  podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^vibe-coder'
}

# Report the exit status run.sh finished with, and say so in the log.
reap_launcher() {
  local log="$1" status=0
  wait "${LAUNCH_PID}" || status=$?
  echo "run.sh exited ${status}" >>"${log}"
  return "${status}"
}

run_launcher() {
  local log="$1" waited=0 status=0
  LAUNCH_LOG="${log}"
  # run_core.log is appended to and never truncated, so an earlier launch on
  # this host would otherwise hand this run its refused trim or its refused
  # launch. Only the bytes this launch appends are read back.
  RUN_CORE_OFFSET=0
  if [[ -f "${RUN_CORE_LOG}" ]]; then
    RUN_CORE_OFFSET="$(wc -c <"${RUN_CORE_LOG}")"
  fi
  (cd "${REPO_ROOT}" && ./run.sh) >"${log}" 2>&1 </dev/null &
  LAUNCH_PID=$!
  while ((waited < LAUNCH_TIMEOUT)); do
    if ! launcher_running; then
      reap_launcher "${log}" || status=$?
      return "${status}"
    fi
    if container_listed; then
      # A listed container only counts while the launcher is still running it:
      # run.sh exits with the container's own status, so an entry left behind
      # by a launch that has already failed is stale, not a started worker.
      sleep "${POLL_INTERVAL}"
      waited=$((waited + POLL_INTERVAL))
      if ! launcher_running; then
        reap_launcher "${log}" || status=$?
        return "${status}"
      fi
      echo "container running after ${waited}s" >>"${log}"
      return 0
    fi
    sleep "${POLL_INTERVAL}"
    waited=$((waited + POLL_INTERVAL))
  done
  echo "gave up waiting ${LAUNCH_TIMEOUT}s for the container to start" >>"${log}"
  return 1
}

# ---------------------------------------------------------------------------
# Stage 6 - the image the build produced
# ---------------------------------------------------------------------------

check_image() {
  local log="$1" reference status=0
  local inspect="${TRANSCRIPT_DIR}/image-env.txt"
  local cli="${TRANSCRIPT_DIR}/image-cli.txt"

  if ! reference="$(cd "${REPO_ROOT}" && deno run --allow-env --allow-read \
    worker/deno/mod.ts container-image-hash \
    --config "${CONFIG_FILE_RESOLVED}" 2>&1 | tail -1)"; then
    echo "could not resolve the expected image reference: ${reference}" >"${log}"
    return 1
  fi
  echo "expected image: ${reference}" >"${log}"

  if ! podman image inspect "${reference}" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' \
    >"${inspect}" 2>>"${log}"; then
    echo "podman could not inspect ${reference}" >>"${log}"
    return 1
  fi

  # Both answers are stated, so a probe that failed outright is never read as
  # "the CLI is absent" (or, worse, as "Claude is installed").
  if ! podman run --rm --entrypoint /bin/sh "${reference}" -c \
    'command -v codex >/dev/null && echo CODEX_PRESENT || echo CODEX_ABSENT
     command -v claude >/dev/null && echo CLAUDE_PRESENT || echo CLAUDE_ABSENT' \
    >"${cli}" 2>>"${log}"; then
    echo "the image CLI probe did not run" >>"${log}"
    return 1
  fi

  cat "${inspect}" "${cli}" >>"${log}"
  verify --mode image --inspect "${inspect}" --cli "${cli}" >>"${log}" 2>&1 ||
    status=$?
  return "${status}"
}

# ---------------------------------------------------------------------------
# Stage 7 - the worker claims one issue and takes it to completion
# ---------------------------------------------------------------------------

check_claim() {
  local log="$1" waited=0 status=0 verdict="" died=""
  # Which markers mean "claimed" and "completed" is decided by `first-run-verify`
  # alongside every other signature this run reads. A launcher that has already
  # exited ends the wait at once: sitting out the full claim timeout for a
  # container that died in the first seconds reports nothing extra.
  while ((waited < CLAIM_TIMEOUT)); do
    if verify --mode claim --worker-log "${WORKER_LOG}" >/dev/null 2>&1; then
      break
    fi
    if [[ -n "${LAUNCH_PID}" ]] && ! launcher_running; then
      died="yes"
      break
    fi
    sleep "${POLL_INTERVAL}"
    waited=$((waited + POLL_INTERVAL))
  done

  verdict="$(verify --mode claim --worker-log "${WORKER_LOG}" 2>&1)" || status=$?
  {
    echo "== ${WORKER_LOG} (tail) =="
    tail -n 200 "${WORKER_LOG}" 2>&1 || echo "(no worker log)"
    echo
    printf '%s\n' "${verdict}"
    printf 'waited: %ss of %ss\n' "${waited}" "${CLAIM_TIMEOUT}"
    if [[ -n "${died}" ]]; then
      echo "run.sh exited before the worker finished, so the wait ended early"
    fi
  } >"${log}" 2>&1
  return "${status}"
}

# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

STAGE_INDEX=0
STAGES_FILE="${TRANSCRIPT_DIR}/stages.tsv"
: >"${STAGES_FILE}"
FAILED=0

# Record one stage for the report: one tab-separated line, in the order the
# stages ran. A stage that did not run is SKIPPED, which is never a pass.
record_stage() {
  local name="$1" status="$2" detail="$3" log="$4"
  printf '%s\t%s\t%s\t%s\n' "${name}" "${status}" "${detail}" "${log}" \
    >>"${STAGES_FILE}"
  say "${name}: ${status} - ${detail}"
}

stage() {
  local name="$1" fn="$2" log base status=0
  STAGE_INDEX=$((STAGE_INDEX + 1))
  base="$(printf '%02d-%s.log' "${STAGE_INDEX}" "${name}")"
  log="${TRANSCRIPT_DIR}/${base}"
  if ((FAILED)); then
    : >"${log}"
    record_stage "${name}" "SKIPPED" "an earlier stage failed" "${base}"
    return 0
  fi
  "${fn}" "${log}" || status=$?
  if ((status == 0)); then
    record_stage "${name}" "PASS" "exit 0" "${base}"
  else
    FAILED=1
    record_stage "${name}" "FAIL" "exit ${status}; see ${base}" "${base}"
  fi
}

# Leave the host as the run found it, whatever happened. The worker runs in the
# foreground under run.sh, so without this a verification would exit leaving a
# worker claiming issues and its own stage-1 gate would refuse the next run on
# the same host. The built image is deliberately left alone: removing it is the
# operator's call, and the guide says to re-provision between runs.
stop_worker() {
  if [[ -n "${LAUNCH_PID}" ]] && kill -0 "${LAUNCH_PID}" 2>/dev/null; then
    say "stopping the launcher (pid ${LAUNCH_PID})"
    kill "${LAUNCH_PID}" 2>/dev/null || :
    wait "${LAUNCH_PID}" 2>/dev/null || :
  fi
  local container
  while read -r container; do
    [[ -n "${container}" ]] || continue
    say "stopping container ${container}"
    podman stop --time 30 "${container}" >/dev/null 2>&1 ||
      say "could not stop ${container} - stop it by hand before the next run"
  done < <(podman ps --format '{{.Names}}' 2>/dev/null | grep '^vibe-coder' || :)
}
trap stop_worker EXIT

say "transcript directory: ${TRANSCRIPT_DIR}"

stage fresh-state check_fresh_state
stage prerequisites check_prerequisites
stage setup run_setup
stage config check_config
stage launch run_launcher
stage image check_image
stage claim check_claim

# The fresh-state verdict is read back from the file the preflight wrote, so
# the report states the decision that was actually taken rather than one
# recomputed later. A preflight that wrote none is a host never confirmed
# fresh; the report mode says so itself, so no verdict is ever hand-written
# here.
REPORT_ARGS=(
  --stages "${STAGES_FILE}"
  --fresh-state "${FRESH_STATE_JSON}"
  --transcript "${TRANSCRIPT_DIR}"
  --checkout "${REPO_ROOT}"
  --host "$(uname -srm 2>/dev/null || echo unknown)"
  --commit "$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  --run-core-log "$(run_core_window)"
  --worker-log "${WORKER_LOG}"
  --out "${REPORT}"
)
# Named only when a launch actually produced one: a sentinel path would be read
# back as empty evidence, which is the silence this run must not report as calm.
if [[ -n "${LAUNCH_LOG}" ]]; then
  REPORT_ARGS+=(--launch-log "${LAUNCH_LOG}")
fi

REPORT_STATUS=0
verify --mode report "${REPORT_ARGS[@]}" || REPORT_STATUS=$?

if ((REPORT_STATUS == 0)); then
  say "every stage passed with no workaround; paste ${REPORT} onto the issue"
  exit 0
fi
say "verification failed - ${REPORT} names the stage, the violations and the defects"
exit 1
