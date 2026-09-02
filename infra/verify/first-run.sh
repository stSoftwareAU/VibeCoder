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
# It verifies; it never repairs. A host that already carries one of the
# reporter's workarounds is refused before any stage runs, because a run
# started from a patched host proves nothing. Every stage's output is captured
# to its own file under the transcript directory and summarised in `report.md`,
# ready to paste onto the issue being verified.
#
# The two known-benign messages are classified, not hidden: a ruleset 403 on a
# private repository (Issue #733) and a runtime that refuses FITRIM (Issue
# #734) are recorded as expected warnings, so anything else standing out in
# the transcript is a new defect rather than noise a reader must re-derive.
#
# Usage:
#   infra/verify/first-run.sh [--transcript-dir DIR] [--claim-timeout SECONDS]
#                             [--repo-root DIR] [--poll-interval SECONDS]
#
# Exit status: 0 only when every stage passed and no defect was detected.
# Anything else - a refused precondition, a failed stage, a skipped stage, a
# detected defect - exits non-zero and says which.
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
  sed -n '3,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# ---------------------------------------------------------------------------
# Recording
#
# Nothing here treats "no failure was printed" as success: a stage records a
# status explicitly, and a stage that never ran is SKIPPED, which is not a
# pass.
# ---------------------------------------------------------------------------

STAGE_INDEX=0
STAGE_NAMES=()
STAGE_STATUSES=()
STAGE_DETAILS=()
STAGE_LOGS=()
VIOLATIONS=()
EXPECTED_WARNINGS=()
DEFECTS=()
NOTES=()

say() { printf '[first-run] %s\n' "$*"; }

record_stage() {
  local name="$1" status="$2" detail="$3" log="$4"
  STAGE_NAMES+=("${name}")
  STAGE_STATUSES+=("${status}")
  STAGE_DETAILS+=("${detail}")
  STAGE_LOGS+=("${log}")
  say "${name}: ${status} - ${detail}"
}

note() { NOTES+=("$1"); }
violation() { VIOLATIONS+=("$1"); }
defect() { DEFECTS+=("$1"); }
expected_warning() { EXPECTED_WARNINGS+=("$1"); }

# Path of the log file for the next stage. The counter is advanced by the
# caller: incrementing it here would be lost, because this runs in the command
# substitution that takes the path.
next_log() {
  printf '%s/%02d-%s.log' "${TRANSCRIPT_DIR}" "$1" "$2"
}

# First line of `file` matching `pattern`, or the empty string.
first_match() {
  local pattern="$1" file="$2"
  [[ -f "${file}" ]] || return 0
  grep -m1 -F -e "${pattern}" "${file}" 2>/dev/null || true
}

first_match_re() {
  local pattern="$1" file="$2"
  [[ -f "${file}" ]] || return 0
  grep -m1 -E -e "${pattern}" "${file}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Stage 1 - fresh state
#
# Each workaround the reporter of #722 needed is checked for here. A host
# carrying one is refused: applying it and declaring success is exactly what
# this run exists to rule out.
# ---------------------------------------------------------------------------

CONFIG_FILE_RESOLVED=""

resolve_config_file() {
  local canonical="${CONFIG_FILE:-}" alias_value="${CONFIG_PATH:-}"
  if [[ -n "${canonical}" && -n "${alias_value}" &&
    "${canonical}" != "${alias_value}" ]]; then
    violation "CONFIG_FILE and CONFIG_PATH name different files (${canonical} vs ${alias_value}) - a split configuration, not a fresh host"
  fi
  CONFIG_FILE_RESOLVED="${canonical:-${alias_value:-${REPO_ROOT}/.config.json}}"
  [[ "${CONFIG_FILE_RESOLVED}" == /* ]] ||
    CONFIG_FILE_RESOLVED="${REPO_ROOT}/${CONFIG_FILE_RESOLVED}"
}

# `unqualified-search-registries` or an `[aliases]` block in the operator's own
# registries.conf is the short-name workaround from Issue #728. Both base
# images name docker.io outright now, so a fresh host needs neither.
check_registries_conf() {
  local user_conf="${HOME}/.config/containers/registries.conf"
  local system_conf="/etc/containers/registries.conf"
  local setting
  for setting in '[aliases]' 'unqualified-search-registries'; do
    if [[ -f "${user_conf}" ]] &&
      grep -qE "^[[:space:]]*${setting//[/\\[}" "${user_conf}"; then
      violation "${user_conf} sets ${setting} - the Issue #728 short-name workaround, which a fresh host must not need"
    fi
  done
  # The distribution's own file is host baseline, not an operator workaround,
  # so it is recorded rather than refused.
  if [[ -f "${system_conf}" ]] &&
    grep -qE '^[[:space:]]*unqualified-search-registries' "${system_conf}"; then
    note "${system_conf} sets unqualified-search-registries (distribution default; both base images name docker.io, so the build must not depend on it)"
  fi
}

check_fresh_state() {
  local log="$1" var image_line
  {
    echo "== environment overrides =="
    for var in VIBE_SKIP_PREREQ_CHECK VIBE_SKIP_AUTH_CHECK \
      VIBE_HOST_DISK_LOW_FLOOR_GB VIBE_HOST_DISK_LOW_FLOOR_PERCENT \
      VIBE_HOST_DISK_HARD_FLOOR_GB CONFIG_FILE CONFIG_PATH; do
      printf '%s=%s\n' "${var}" "${!var:-<unset>}"
    done
    echo
    echo "== checkout =="
    git -C "${REPO_ROOT}" status --porcelain 2>&1 || true
    git -C "${REPO_ROOT}" rev-parse HEAD 2>&1 || true
    echo
    echo "== podman images =="
    podman image ls --format '{{.Repository}}:{{.Tag}}' 2>&1 || true
    echo
    echo "== registries.conf =="
    cat "${HOME}/.config/containers/registries.conf" 2>&1 || true
  } >"${log}" 2>&1

  for var in VIBE_SKIP_PREREQ_CHECK VIBE_SKIP_AUTH_CHECK; do
    [[ -z "${!var:-}" ]] ||
      violation "${var} is set - the prerequisite probe must run unaided (Issue #730)"
  done
  for var in VIBE_HOST_DISK_LOW_FLOOR_GB VIBE_HOST_DISK_LOW_FLOOR_PERCENT \
    VIBE_HOST_DISK_HARD_FLOOR_GB; do
    [[ -z "${!var:-}" ]] ||
      violation "${var} is set - the host must claim work at its resolved floor, not a moved one (Issue #732)"
  done

  resolve_config_file
  [[ ! -e "${CONFIG_FILE_RESOLVED}" ]] ||
    violation "${CONFIG_FILE_RESOLVED} already exists - setup.sh must write it, not a prior run or a hand edit"

  if command -v claude >/dev/null 2>&1; then
    violation "the Claude CLI is on PATH - a Codex-only configuration must complete with no Claude CLI present (Issue #730)"
  fi

  if command -v podman >/dev/null 2>&1; then
    image_line="$(podman image ls --format '{{.Repository}}' 2>/dev/null |
      grep -c '^vibe-coder$' || true)"
    [[ "${image_line}" == "0" ]] ||
      violation "a vibe-coder image is already present - the build must run from nothing on a fresh host"
  fi

  if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain 2>/dev/null || echo dirty)" ]]; then
    violation "the checkout at ${REPO_ROOT} has uncommitted changes - a patched checkout is a workaround, not a fresh run"
  fi

  check_registries_conf

  ((${#VIOLATIONS[@]} == 0))
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
  return 0
}

# ---------------------------------------------------------------------------
# Stage 3 - setup.sh
#
# Every credential and configuration prompt is behind a TTY check, so a run
# with no terminal skips them all and writes nothing. When this script has a
# terminal, setup runs under util-linux `script` so the operator answers on the
# terminal and the transcript is still captured; with no terminal the run is
# recorded as exactly that, so a stage-4 failure is not mistaken for a defect
# in setup.
# ---------------------------------------------------------------------------

run_setup() {
  local log="$1" status=0
  if [[ -t 0 ]] && command -v script >/dev/null 2>&1; then
    script -q -e -c "cd '${REPO_ROOT}' && ./setup.sh" "${log}" || status=$?
  else
    note "setup.sh ran with no terminal attached - every interactive prompt was skipped, so the configuration it writes is not an operator's answers"
    (cd "${REPO_ROOT}" && ./setup.sh) >"${log}" 2>&1 || status=$?
  fi
  return "${status}"
}

# ---------------------------------------------------------------------------
# Stage 4 - the configuration setup wrote
# ---------------------------------------------------------------------------

check_config() {
  local log="$1" providers
  if [[ ! -f "${CONFIG_FILE_RESOLVED}" ]]; then
    echo "setup.sh did not write ${CONFIG_FILE_RESOLVED}" >"${log}"
    return 1
  fi
  {
    echo "== ${CONFIG_FILE_RESOLVED} =="
    # The file carries no secret - credentials live outside it - but the
    # provider selection is what this stage is about.
    jq '.agent_providers, .repositories, .allowed_authors' \
      "${CONFIG_FILE_RESOLVED}" 2>&1 || cat "${CONFIG_FILE_RESOLVED}"
  } >"${log}" 2>&1

  providers="$(jq -r '(.agent_providers // []) | join(",")' \
    "${CONFIG_FILE_RESOLVED}" 2>/dev/null || echo "")"
  printf 'agent_providers=%s\n' "${providers}" >>"${log}"
  if [[ "${providers}" != *codex* ]]; then
    echo "agent_providers does not select codex - this run verifies a Codex-only configuration" >>"${log}"
    return 1
  fi
  if [[ "${providers}" == *claude* ]]; then
    echo "agent_providers also selects claude - not the Codex-only configuration under test" >>"${log}"
    return 1
  fi
  return 0
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
  local log="$1" reference providers tools
  reference="$(cd "${REPO_ROOT}" && deno run --allow-env --allow-read \
    worker/deno/mod.ts container-image-hash 2>/dev/null | tail -1)"
  if [[ -z "${reference}" ]]; then
    echo "could not resolve the expected image reference" >"${log}"
    return 1
  fi
  {
    echo "== ${reference} =="
    podman image inspect "${reference}" \
      --format '{{range .Config.Env}}{{println .}}{{end}}' 2>&1 || true
  } >"${log}" 2>&1

  providers="$(podman image inspect "${reference}" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
    grep '^VIBE_IMAGE_AGENT_PROVIDERS=' | head -1 | cut -d= -f2- || true)"
  printf 'VIBE_IMAGE_AGENT_PROVIDERS=%s\n' "${providers}" >>"${log}"
  if [[ "${providers}" != *codex* ]]; then
    echo "the built image does not report codex in VIBE_IMAGE_AGENT_PROVIDERS (Issue #729)" >>"${log}"
    return 1
  fi

  tools="$(podman run --rm --entrypoint /bin/sh "${reference}" -c \
    'command -v codex || echo NO_CODEX; command -v claude || echo NO_CLAUDE' \
    2>&1 || true)"
  printf '%s\n' "${tools}" >>"${log}"
  if [[ "${tools}" == *NO_CODEX* ]]; then
    echo "the built image carries no Codex CLI (Issue #729)" >>"${log}"
    return 1
  fi
  if [[ "${tools}" != *NO_CLAUDE* ]]; then
    echo "the built image carries the Claude CLI, which a Codex-only configuration must not build (Issue #729)" >>"${log}"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Stage 7 - volume initialisation, and what followed a refused trim
# ---------------------------------------------------------------------------

check_volume_init() {
  local log="$1" trim refusal unrecovered
  if [[ -z "${LAUNCH_LOG}" || ! -f "${LAUNCH_LOG}" ]]; then
    echo "the launcher produced no output to analyse" >"${log}"
    return 2
  fi
  {
    echo "== volume-init and disk lines from the launch =="
    grep -E 'volume-init|VOLUME_TRIM_REFUSED|host-disk|WORK_VOLUME_UNRECOVERED' \
      "${LAUNCH_LOG}" 2>/dev/null || echo "(none)"
  } >"${log}" 2>&1

  trim="$(first_match 'VOLUME_TRIM_REFUSED' "${LAUNCH_LOG}")"
  if [[ -n "${trim}" ]]; then
    expected_warning "refused FITRIM on a named volume, stated not warned (Issue #734): ${trim}"
  fi

  unrecovered="$(first_match '[WORK_VOLUME_UNRECOVERED]' "${LAUNCH_LOG}")"
  if [[ -n "${unrecovered}" ]]; then
    defect "volume recovery could not repair the work volume (Issue #731): ${unrecovered}"
    return 1
  fi

  refusal="$(first_match_re 'refus(ing|ed) (to launch|launch)' "${LAUNCH_LOG}")"
  if [[ -n "${refusal}" ]]; then
    if [[ -n "${trim}" ]]; then
      defect "a refused trim was followed by a refused launch (Issue #734): ${refusal}"
    else
      defect "the launcher refused to launch (Issue #732): ${refusal}"
    fi
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Stage 8 - the worker claims one issue and takes it to completion
# ---------------------------------------------------------------------------

check_claim() {
  local log="$1" worker_log="${HOME}/logs/worker.log" waited=0 claimed="" done_line=""
  while ((waited < CLAIM_TIMEOUT)); do
    claimed="$(first_match_re 'Claimed by |Processing .*#[0-9]+' "${worker_log}")"
    done_line="$(first_match 'Successfully processed' "${worker_log}")"
    if [[ -n "${done_line}" ]]; then
      break
    fi
    sleep "${POLL_INTERVAL}"
    waited=$((waited + POLL_INTERVAL))
  done
  {
    echo "== ${worker_log} (tail) =="
    tail -n 200 "${worker_log}" 2>&1 || echo "(no worker log)"
    echo
    printf 'claim line: %s\n' "${claimed:-<none>}"
    printf 'completion line: %s\n' "${done_line:-<none>}"
    printf 'waited: %ss of %ss\n' "${waited}" "${CLAIM_TIMEOUT}"
  } >"${log}" 2>&1

  if [[ -z "${done_line}" ]]; then
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
# Classification
#
# The expected warnings are named so a reader can tell them from a new defect
# without re-deriving the distinction; the defect patterns are the faults the
# sibling fixes removed, so a regression is reported as the regression it is.
# ---------------------------------------------------------------------------

classify_output() {
  local stage_name="$1" file="$2" hit
  [[ -f "${file}" ]] || return 0

  # Only the stages that capture what setup, the launcher and the image said
  # are classified. The host-inspection stages record the environment on
  # purpose - naming a variable there is the evidence, not a defect, and
  # matching it would report the harness's own transcript as a fault.
  case "${stage_name}" in
    setup | config | launch | volume-init | image | claim) ;;
    *) return 0 ;;
  esac

  hit="$(first_match 'repository rulesets need GitHub Pro' "${file}")"
  [[ -z "${hit}" ]] ||
    expected_warning "private-repository ruleset 403, non-fatal (Issue #733): ${hit}"

  hit="$(first_match 'unknown mount option' "${file}")"
  [[ -z "${hit}" ]] ||
    defect "Podman refused a tmpfs mount option (Issue #727): ${hit}"

  hit="$(first_match_re 'short-name|unable to find a name|resolve.*docker.io' "${file}")"
  [[ -z "${hit}" ]] ||
    defect "a base image did not resolve without a search registry (Issue #728): ${hit}"

  hit="$(first_match_re 'unrecognized command|volume with name .* already exists' "${file}")"
  [[ -z "${hit}" ]] ||
    defect "a volume verb the runtime does not accept (Issue #731): ${hit}"

  # Setup names `VIBE_SKIP_PREREQ_CHECK` in its own summary, so the signature
  # of Issue #730 is the demand itself: the Claude CLI reported missing, or
  # named as something container mode needs, on a host that runs Codex.
  hit="$(first_match_re 'claude CLI is not installed|the claude CLI \(setup mints' \
    "${file}")"
  [[ -z "${hit}" ]] ||
    defect "setup demanded the Claude CLI on a Codex-only host (Issue #730): ${hit}"
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

write_report() {
  local verdict="$1" index item
  {
    printf '# Fresh first-run verification (Issue #736)\n\n'
    printf -- "- host: \`%s\`\n" "$(uname -srm 2>/dev/null || echo unknown)"
    printf -- "- checkout: \`%s\` at \`%s\`\n" "${REPO_ROOT}" \
      "$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    printf -- "- transcript: \`%s\`\n" "${TRANSCRIPT_DIR}"
    printf -- '- verdict: **%s**\n\n' "${verdict}"

    printf '## Stages\n\n'
    printf '| # | Stage | Status | Detail | Output |\n'
    printf '| --- | --- | --- | --- | --- |\n'
    for index in "${!STAGE_NAMES[@]}"; do
      printf "| %d | %s | %s | %s | \`%s\` |\n" "$((index + 1))" \
        "${STAGE_NAMES[index]}" "${STAGE_STATUSES[index]}" \
        "${STAGE_DETAILS[index]}" "$(basename "${STAGE_LOGS[index]}")"
    done
    printf '\n'

    printf '## Fresh-state violations\n\n'
    if ((${#VIOLATIONS[@]} == 0)); then
      printf 'None — the host carried no workaround.\n\n'
    else
      for item in "${VIOLATIONS[@]}"; do printf -- '- %s\n' "${item}"; done
      printf '\n'
    fi

    printf '## Expected warnings\n\n'
    if ((${#EXPECTED_WARNINGS[@]} == 0)); then
      printf 'None observed.\n\n'
    else
      for item in "${EXPECTED_WARNINGS[@]}"; do printf -- '- %s\n' "${item}"; done
      printf '\n'
    fi

    printf '## New defects\n\n'
    if ((${#DEFECTS[@]} == 0)); then
      printf 'None — no workaround was required.\n\n'
    else
      printf 'Each of these is a defect to file as a further sub-issue of #722.\n\n'
      for item in "${DEFECTS[@]}"; do printf -- '- %s\n' "${item}"; done
      printf '\n'
    fi

    if ((${#NOTES[@]} > 0)); then
      printf '## Notes\n\n'
      for item in "${NOTES[@]}"; do printf -- '- %s\n' "${item}"; done
      printf '\n'
    fi
  } >"${REPORT}"
}

# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

# Run one stage, capturing its output, and record what happened. A stage after
# a failure is recorded SKIPPED rather than omitted, so the report never reads
# as if it covered ground it did not.
FAILED=0

stage() {
  local name="$1" fn="$2" log status=0
  STAGE_INDEX=$((STAGE_INDEX + 1))
  log="$(next_log "${STAGE_INDEX}" "${name}")"
  if ((FAILED)); then
    : >"${log}"
    record_stage "${name}" "SKIPPED" "an earlier stage failed" "${log}"
    return 0
  fi
  "${fn}" "${log}" || status=$?
  classify_output "${name}" "${log}"
  if ((status == 0)); then
    record_stage "${name}" "PASS" "exit 0" "${log}"
  else
    FAILED=1
    record_stage "${name}" "FAIL" "exit ${status}; see $(basename "${log}")" "${log}"
  fi
}

# A stage that only reads output already captured. It runs even after a
# failure - the reported chain of Issue #734 (a refused trim, then a refused
# launch) is exactly what a failed launch leaves behind, and skipping the
# reading of it would drop the finding the run exists to make. Exit 2 means
# there was no output to read, which is recorded as skipped, never as a pass.
stage_analysis() {
  local name="$1" fn="$2" log status=0
  STAGE_INDEX=$((STAGE_INDEX + 1))
  log="$(next_log "${STAGE_INDEX}" "${name}")"
  "${fn}" "${log}" || status=$?
  classify_output "${name}" "${log}"
  case "${status}" in
    0) record_stage "${name}" "PASS" "exit 0" "${log}" ;;
    2) record_stage "${name}" "SKIPPED" "no output to analyse" "${log}" ;;
    *)
      FAILED=1
      record_stage "${name}" "FAIL" "exit ${status}; see $(basename "${log}")" "${log}"
      ;;
  esac
}

say "transcript directory: ${TRANSCRIPT_DIR}"

stage fresh-state check_fresh_state
stage prerequisites check_prerequisites
stage setup run_setup
stage config check_config
stage launch run_launcher
stage_analysis volume-init check_volume_init
stage image check_image
stage claim check_claim

VERDICT="PASS"
if ((FAILED)) || ((${#VIOLATIONS[@]} > 0)) || ((${#DEFECTS[@]} > 0)); then
  VERDICT="FAIL"
fi

write_report "${VERDICT}"
cat "${REPORT}"

if [[ "${VERDICT}" == "PASS" ]]; then
  say "every stage passed with no workaround; paste ${REPORT} onto the issue"
  exit 0
fi
say "verification failed - ${REPORT} names the stage, the violations and the defects"
exit 1
