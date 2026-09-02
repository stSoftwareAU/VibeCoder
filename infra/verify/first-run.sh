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
# the image, expected warning versus new defect, the verdict and the report —
# is made by `first-run-verify` in worker/deno, where it is unit-tested
# without a host.
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

  podman image ls --format '{{.Repository}}' >"${images}" 2>/dev/null || : >"${images}"
  git -C "${REPO_ROOT}" status --porcelain >"${status_file}" 2>&1 ||
    echo "?? the checkout could not be read" >"${status_file}"
  claude_on_path="$(command -v claude >/dev/null 2>&1 && echo true || echo false)"

  {
    printf 'configuration file: %s\n' "${CONFIG_FILE_RESOLVED}"
    verify --mode preflight \
      --config-file "${CONFIG_FILE_RESOLVED}" \
      --claude-on-path "${claude_on_path}" \
      --images "${images}" \
      --checkout-status "${status_file}" \
      --user-registries "${HOME}/.config/containers/registries.conf" \
      --system-registries /etc/containers/registries.conf \
      --out "${FRESH_STATE_JSON}"
  } >"${log}" 2>&1
}

# ---------------------------------------------------------------------------
# Stage 2 - prerequisites present on the host
# ---------------------------------------------------------------------------

check_prerequisites() {
  local log="$1" missing=() tool
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
    echo "== container runtime the launcher will use =="
    (cd "${REPO_ROOT}" && deno run --allow-run --allow-env \
      worker/deno/mod.ts container-runtime-detect) 2>&1 || true
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
  if ! grep -qi podman "${log}"; then
    echo "the launcher did not resolve podman as this host's runtime" >>"${log}"
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
  if [[ -t 0 ]] && command -v script >/dev/null 2>&1; then
    script -q -e -c "cd '${REPO_ROOT}' && ./setup.sh" "${log}" || status=$?
  else
    (cd "${REPO_ROOT}" && ./setup.sh) >"${log}" 2>&1 || status=$?
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
  local log="$1" waited=0 claimed="" completed=""
  while ((waited < CLAIM_TIMEOUT)); do
    if [[ -f "${WORKER_LOG}" ]] &&
      grep -q 'Successfully processed' "${WORKER_LOG}" 2>/dev/null; then
      completed="yes"
      break
    fi
    sleep "${POLL_INTERVAL}"
    waited=$((waited + POLL_INTERVAL))
  done
  if [[ -f "${WORKER_LOG}" ]] &&
    grep -qE 'Claimed by |Processing .*#[0-9]+' "${WORKER_LOG}" 2>/dev/null; then
    claimed="yes"
  fi
  {
    echo "== ${WORKER_LOG} (tail) =="
    tail -n 200 "${WORKER_LOG}" 2>&1 || echo "(no worker log)"
    echo
    printf 'claimed: %s\n' "${claimed:-no}"
    printf 'completed: %s\n' "${completed:-no}"
    printf 'waited: %ss of %ss\n' "${waited}" "${CLAIM_TIMEOUT}"
  } >"${log}" 2>&1

  if [[ -z "${completed}" ]]; then
    if [[ -z "${claimed}" ]]; then
      echo "the worker claimed no issue within ${CLAIM_TIMEOUT}s" >>"${log}"
    else
      echo "the worker claimed an issue but did not complete one within ${CLAIM_TIMEOUT}s" >>"${log}"
    fi
    return 1
  fi
  return 0
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
# fresh, which is a refusal, not a blank.
if [[ ! -f "${FRESH_STATE_JSON}" ]]; then
  printf '{"violations":["the preflight wrote no verdict, so the host was never confirmed fresh"],"notes":[]}' \
    >"${FRESH_STATE_JSON}"
fi

REPORT_STATUS=0
verify --mode report \
  --stages "${STAGES_FILE}" \
  --fresh-state "${FRESH_STATE_JSON}" \
  --transcript "${TRANSCRIPT_DIR}" \
  --checkout "${REPO_ROOT}" \
  --host "$(uname -srm 2>/dev/null || echo unknown)" \
  --commit "$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
  --launch-log "${LAUNCH_LOG:-/nonexistent}" \
  --run-core-log "${RUN_CORE_LOG}" \
  --out "${REPORT}" || REPORT_STATUS=$?

if ((REPORT_STATUS == 0)); then
  say "every stage passed with no workaround; paste ${REPORT} onto the issue"
  exit 0
fi
say "verification failed - ${REPORT} names the stage, the violations and the defects"
exit 1
