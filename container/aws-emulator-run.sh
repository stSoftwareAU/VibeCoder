#!/usr/bin/env bash
# aws-emulator-run: run one command against a private, throwaway AWS Emulator
# (Issue #5109).
#
# Contract: starts `aws-emulator` on loopback with an OS-picked port, a private
# state directory and a scrubbed environment, waits until its health endpoint
# answers over TLS verified against THIS run's own CA (a cryptographic identity
# check), runs COMMAND with only emulator-generated credentials and endpoints,
# then stops the emulator and proves the state directory is gone.
#
# Isolation: no AWS_* or other caller variable reaches the emulator; COMMAND
# loses every AWS_* / ECS_CONTAINER_METADATA_URI* variable, so no real
# credential source stays reachable and nothing falls back to real AWS. Always
# refuses uid 0 and the account `vibe` (the credential-bearing worker account);
# neither can be switched off. AWS_EMULATOR_RUN_REFUSED_USERS is additive only:
# extra space-separated account names refused on top of those.
#
# Stopping COMMAND: a retained setsid supervisor owns the command process group
# until cleanup. TERM is followed by KILL after a finite grace period, including
# ordinary command completion, so background children cannot outlive the run.
#
# Usage:
#   aws-emulator-run [--ready-timeout SECONDS] [--timeout SECONDS] -- COMMAND [ARG...]
#   aws-emulator-run [--ready-timeout SECONDS] [--timeout SECONDS] --smoke
# Exit: COMMAND's code; 2 usage; 3 refused account; 4 runtime missing;
# 5 emulator failed/not ready/not verified; 124 COMMAND timed out;
# 128+N on signal N; a cleanup failure turns 0 into 1.
set -euo pipefail

TAG="[aws-emulator-run]"
READY_TIMEOUT=60
RUN_TIMEOUT=1800
SMOKE=0
SMOKE_CLIENT=0
COMMAND=()

fail() {
    echo "${TAG} FAILED: $*" >&2
}

usage_error() {
    fail "$*"
    echo "usage: aws-emulator-run [--ready-timeout SECONDS] [--timeout SECONDS] (-- COMMAND [ARG...] | --smoke)" >&2
    exit 2
}

# Validate SECONDS: an integer 1..86400. Prints it normalised.
parse_seconds() {
    local flag="$1" value="${2-}"
    case "${value}" in
        '' | *[!0-9]*) usage_error "${flag} needs an integer number of seconds (1..86400), got '${value}'" ;;
    esac
    if [[ ${#value} -gt 5 ]] || [[ $((10#${value})) -lt 1 ]] || [[ $((10#${value})) -gt 86400 ]]; then
        usage_error "${flag} must be between 1 and 86400 seconds, got '${value}'"
    fi
    echo $((10#${value}))
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ready-timeout)
            [[ $# -ge 2 ]] || usage_error "--ready-timeout needs a value"
            READY_TIMEOUT="$(parse_seconds --ready-timeout "$2")"
            shift 2
            ;;
        --timeout)
            [[ $# -ge 2 ]] || usage_error "--timeout needs a value"
            RUN_TIMEOUT="$(parse_seconds --timeout "$2")"
            shift 2
            ;;
        --smoke)
            SMOKE=1
            shift
            ;;
        --smoke-client)
            SMOKE_CLIENT=1
            shift
            ;;
        -h | --help)
            echo "usage: aws-emulator-run [--ready-timeout SECONDS] [--timeout SECONDS] (-- COMMAND [ARG...] | --smoke)"
            exit 0
            ;;
        --)
            shift
            COMMAND=("$@")
            break
            ;;
        *)
            usage_error "unknown argument '$1'"
            ;;
    esac
done

# The bounded() pattern of loop.sh/run.sh: timeout, else gtimeout (macOS),
# else unbounded.
TIMEOUT_CMD=""
for candidate in timeout gtimeout; do
    if command -v "${candidate}" >/dev/null 2>&1; then
        TIMEOUT_CMD="${candidate}"
        break
    fi
done

# --smoke-client: the internal COMMAND of --smoke, run under the test env.
smoke_client() {
    local state="${AWS_EMULATOR_STATE_DIR-}"
    [[ -n "${state}" && -d "${state}" ]] || usage_error "--smoke-client is internal (AWS_EMULATOR_STATE_DIR unset)"
    local aws_opts=(--cli-connect-timeout 10 --cli-read-timeout 30)
    local account bucket key body got suffix version
    account="$(aws "${aws_opts[@]}" sts get-caller-identity --query Account --output text)" ||
        { fail "smoke: sts get-caller-identity failed"; exit 1; }
    if [[ "${account}" != "000000000000" ]]; then
        fail "smoke: account mismatch: expected 000000000000, got '${account}'"
        exit 1
    fi
    suffix="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    bucket="aws-emulator-run-smoke-${suffix}"
    key="smoke-object"
    body="${state}/smoke-body.txt"
    got="${state}/smoke-got.txt"
    printf 'aws-emulator-run smoke %s\n' "${suffix}" >"${body}"
    aws "${aws_opts[@]}" s3api create-bucket --bucket "${bucket}" >/dev/null ||
        { fail "smoke: create-bucket failed"; exit 1; }
    aws "${aws_opts[@]}" s3api put-object --bucket "${bucket}" --key "${key}" --body "${body}" >/dev/null ||
        { fail "smoke: put-object failed"; exit 1; }
    aws "${aws_opts[@]}" s3api get-object --bucket "${bucket}" --key "${key}" "${got}" >/dev/null ||
        { fail "smoke: get-object failed"; exit 1; }
    cmp -s "${body}" "${got}" || { fail "smoke: object read back differs from the object written"; exit 1; }
    aws "${aws_opts[@]}" s3api delete-object --bucket "${bucket}" --key "${key}" >/dev/null ||
        { fail "smoke: delete-object failed"; exit 1; }
    aws "${aws_opts[@]}" s3api delete-bucket --bucket "${bucket}" >/dev/null ||
        { fail "smoke: delete-bucket failed"; exit 1; }
    version="$(aws-emulator --version 2>/dev/null | sed -n 1p || true)"
    echo "${TAG} smoke passed: ${version}"
}

if [[ ${SMOKE_CLIENT} -eq 1 ]]; then
    smoke_client
    exit 0
fi

if [[ ${SMOKE} -eq 1 ]]; then
    [[ ${#COMMAND[@]} -eq 0 ]] || usage_error "--smoke takes no COMMAND"
    COMMAND=(bash "$0" --smoke-client)
elif [[ ${#COMMAND[@]} -eq 0 ]]; then
    usage_error "a COMMAND after -- is required (or --smoke)"
fi

# Refusals: uid 0 and `vibe` always (not switchable off), plus any extra
# accounts in AWS_EMULATOR_RUN_REFUSED_USERS. Nothing is started. `read -a`
# splits on whitespace without globbing.
if [[ "$(id -u)" -eq 0 ]]; then
    fail "refusing to run as root (uid 0)"
    exit 3
fi
ME="$(id -un)"
EXTRA_REFUSED=()
read -r -a EXTRA_REFUSED <<<"${AWS_EMULATOR_RUN_REFUSED_USERS-}" || true
REFUSED=(vibe ${EXTRA_REFUSED[@]+"${EXTRA_REFUSED[@]}"})
for refused in "${REFUSED[@]}"; do
    if [[ "${ME}" == "${refused}" ]]; then
        fail "refusing to run as account '${ME}' (always refused: vibe; plus AWS_EMULATOR_RUN_REFUSED_USERS additions)"
        exit 3
    fi
done

missing=()
for tool in aws-emulator curl setsid; do
    command -v "${tool}" >/dev/null 2>&1 || missing+=("${tool}")
done
if [[ ${SMOKE} -eq 1 ]]; then
    command -v aws >/dev/null 2>&1 || missing+=("aws")
fi
if [[ ${#missing[@]} -gt 0 ]]; then
    fail "required runtime missing from PATH: ${missing[*]}"
    exit 4
fi

STATE=""
EMU_PID=""
CMD_PID=""
STARTED=0
CLEANUP_FAILED=0

# The emulator's own words for why it stopped, redacted: lines matching an
# error-ish pattern (else the last 3 lines) joined with ' | ', with credential
# values and key ids masked. Prints nothing when the log is empty.
emulator_cause() {
    local picked line joined=""
    [[ -s "${LOG}" ]] || return 0
    picked="$(grep -Ei 'error|failed|panic|refus|denied|cannot|unable|in use' "${LOG}" 2>/dev/null | tail -n 5 || true)"
    if [[ -z "${picked}" ]]; then
        picked="$(tail -n 3 "${LOG}" 2>/dev/null || true)"
    fi
    picked="$(printf '%s\n' "${picked}" | sed -E \
        -e 's|[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy].*|<redacted>|' \
        -e 's|[Aa][Ww][Ss]_[Ss][Ee][Ss][Ss][Ii][Oo][Nn]_[Tt][Oo][Kk][Ee][Nn].*|<redacted>|' \
        -e 's|EMULATORA[KS][A-Z2-7]{10}|<redacted>|g' \
        -e 's|[A-Za-z0-9+/]{40}|<redacted>|g')"
    while IFS= read -r line; do
        joined="${joined:+${joined} | }${line}"
    done <<<"${picked}"
    printf '%s' "${joined:0:600}"
}

# shellcheck disable=SC2329 # reached via trap or recursion
cleanup() {
    trap '' INT TERM HUP
    if [[ -n "${CMD_PID}" ]] && kill -0 "${CMD_PID}" 2>/dev/null; then
        # The supervisor remains our unreaped child and holds this group id.
        # Before setsid has run, only the child exists; signal that pid too.
        kill -TERM -- "-${CMD_PID}" 2>/dev/null || true
        sleep 1
        kill -KILL -- "-${CMD_PID}" 2>/dev/null || true
        kill -KILL "${CMD_PID}" 2>/dev/null || true
        wait "${CMD_PID}" 2>/dev/null || true
    fi
    if [[ -n "${EMU_PID}" ]] && kill -0 "${EMU_PID}" 2>/dev/null; then
        kill -TERM "${EMU_PID}" 2>/dev/null || true
        local i=0
        while kill -0 "${EMU_PID}" 2>/dev/null && [[ ${i} -lt 50 ]]; do
            sleep 0.2
            i=$((i + 1))
        done
        if kill -0 "${EMU_PID}" 2>/dev/null; then
            kill -KILL "${EMU_PID}" 2>/dev/null || true
        fi
        wait "${EMU_PID}" 2>/dev/null || true
    fi
    if [[ -n "${STATE}" ]]; then
        rm -rf "${STATE}" 2>/dev/null || true
        if [[ -e "${STATE}" ]]; then
            fail "state directory ${STATE} still exists after cleanup"
            CLEANUP_FAILED=1
        fi
    fi
}

# shellcheck disable=SC2329 # reached via trap or recursion
finish() {
    local rc=$?
    cleanup
    if [[ ${CLEANUP_FAILED} -eq 1 && ${rc} -eq 0 ]]; then
        rc=1
    fi
    if [[ ${STARTED} -eq 1 ]]; then
        echo "${TAG} stopped; exit ${rc}" >&2
    fi
    exit "${rc}"
}

# shellcheck disable=SC2329 # reached via trap or recursion
on_signal() {
    local code="$1"
    if [[ -n "${CMD_PID}" ]] && kill -0 "${CMD_PID}" 2>/dev/null; then
        kill -TERM "${CMD_PID}" 2>/dev/null || true
    fi
    exit "${code}"
}

trap finish EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

STATE="$(mktemp -d "${TMPDIR:-/tmp}/aws-emulator-run.XXXXXX")" || {
    STATE=""
    fail "cannot create a state directory under ${TMPDIR:-/tmp}"
    exit 5
}
chmod 700 "${STATE}"
mkdir -p "${STATE}/home"
LOG="${STATE}/emulator.log"

VERSION_CMD=(aws-emulator --version)
if [[ -n "${TIMEOUT_CMD}" ]]; then
    VERSION_CMD=("${TIMEOUT_CMD}" 10 aws-emulator --version)
fi
VERSION_LINE="$("${VERSION_CMD[@]}" 2>/dev/null </dev/null | sed -n 1p || true)"
VERSION="${VERSION_LINE#Version: }"

# Scrubbed environment: only PATH, a private HOME, locale and telemetry off.
env -i PATH="${PATH}" HOME="${STATE}/home" LANG=C.UTF-8 EMULATOR_TELEMETRY=off \
    aws-emulator -b 127.0.0.1 -p 0 -t off -a on \
    --idle-timeout $((RUN_TIMEOUT + READY_TIMEOUT + 60)) \
    >"${LOG}" 2>&1 </dev/null &
EMU_PID=$!
STARTED=1

PORT=""
PORT_DIR=""
CA=""
reason="no port directory under ${STATE}/home/.aws/emulator"
deadline=$((SECONDS + READY_TIMEOUT))
while :; do
    if ! kill -0 "${EMU_PID}" 2>/dev/null; then
        fail "emulator exited early: $(emulator_cause)"
        EMU_PID=""
        exit 5
    fi
    candidates=()
    for d in "${STATE}"/home/.aws/emulator/*; do
        [[ -d "${d}" ]] || continue
        case "${d##*/}" in
            '' | *[!0-9]*) continue ;;
        esac
        candidates+=("${d}")
    done
    if [[ ${#candidates[@]} -eq 1 ]]; then
        d="${candidates[0]}"
        if [[ -f "${d}/config" && -f "${d}/emulator_credentials" && -f "${d}/ca.pem" ]]; then
            port="${d##*/}"
            body="$(curl -sS --fail --noproxy '*' --cacert "${d}/ca.pem" --max-time 2 \
                "https://127.0.0.1:${port}/__admin/health" 2>/dev/null || true)"
            if [[ "${body}" == "ok" ]]; then
                PORT="${port}"
                PORT_DIR="${d}"
                CA="${d}/ca.pem"
                break
            fi
            reason="health on port ${port} not verified against this run's ca.pem (got '${body}')"
        else
            reason="port directory ${d##*/} lacks config, emulator_credentials or ca.pem"
        fi
    elif [[ ${#candidates[@]} -gt 1 ]]; then
        reason="more than one port directory under ${STATE}/home/.aws/emulator"
    fi
    if [[ ${SECONDS} -ge ${deadline} ]]; then
        cause="$(emulator_cause)"
        fail "emulator not ready and verified within ${READY_TIMEOUT}s: ${reason}${cause:+; emulator log: ${cause}}"
        exit 5
    fi
    sleep 0.3
done

ACCESS_KEY="$(sed -n 's/^aws_access_key_id[[:space:]]*=[[:space:]]*//p' "${PORT_DIR}/emulator_credentials" | tr -d '\r' | sed -n 1p)"
SECRET_KEY="$(sed -n 's/^aws_secret_access_key[[:space:]]*=[[:space:]]*//p' "${PORT_DIR}/emulator_credentials" | tr -d '\r' | sed -n 1p)"
if [[ -z "${ACCESS_KEY}" || -z "${SECRET_KEY}" ]]; then
    fail "emulator_credentials holds no generated access key pair"
    exit 5
fi

echo "${TAG} emulator ${VERSION} ready on https://127.0.0.1:${PORT} (state ${STATE})" >&2

# Applied in the COMMAND subshell only. No real credential source stays
# reachable, so a client that ignores the endpoint presents emulator keys that
# real AWS rejects (Issue #5109).
apply_test_env() {
    local name java_opts
    for name in $(compgen -e); do
        case "${name}" in
            AWS_* | ECS_CONTAINER_METADATA_URI* | JAVA_TOOL_OPTIONS | _JAVA_OPTIONS | JDK_JAVA_OPTIONS) unset "${name}" ;;
        esac
    done
    java_opts="-Djavax.net.ssl.trustStore=${PORT_DIR}/truststore.p12 -Djavax.net.ssl.trustStoreType=PKCS12"
    export AWS_CONFIG_FILE="${PORT_DIR}/config"
    export AWS_SHARED_CREDENTIALS_FILE="${PORT_DIR}/emulator_credentials"
    export AWS_PROFILE=default
    export AWS_ACCESS_KEY_ID="${ACCESS_KEY}"
    export AWS_SECRET_ACCESS_KEY="${SECRET_KEY}"
    export AWS_ENDPOINT_URL="https://127.0.0.1:${PORT}"
    export AWS_CA_BUNDLE="${CA}"
    export AWS_REGION=us-east-1
    export AWS_DEFAULT_REGION=us-east-1
    export AWS_EC2_METADATA_DISABLED=true
    export AWS_SDK_LOAD_CONFIG=1
    export NODE_EXTRA_CA_CERTS="${CA}"
    export JAVA_TOOL_OPTIONS="${java_opts}"
    export EMULATOR_TELEMETRY=off
    export AWS_EMULATOR_STATE_DIR="${STATE}"
    export NO_PROXY="${NO_PROXY:+${NO_PROXY},}127.0.0.1,localhost"
    export no_proxy="${no_proxy:+${no_proxy},}127.0.0.1,localhost"
}

(
    apply_test_env
    # The inner script is deliberately single-quoted: $1/$@ expand in the child, not here.
    # shellcheck disable=SC2016
    exec setsid bash -c '
        result=$1
        shift
        trap ":" TERM INT HUP
        "$@" &
        command_pid=$!
        rc=0
        wait "$command_pid" || rc=$?
        printf "%s\n" "$rc" > "$result.tmp"
        mv "$result.tmp" "$result"
        # Retain the process-group leader even when the direct command exits.
        # The parent owns termination, including any remaining descendants.
        while :; do sleep 1; done
    ' aws-emulator-command "${STATE}/command-result" "${COMMAND[@]}"
) <&0 &
CMD_PID=$!

deadline=$((SECONDS + RUN_TIMEOUT))
rc=0
while [[ ! -f "${STATE}/command-result" ]]; do
    if ! kill -0 "${EMU_PID}" 2>/dev/null; then
        fail "emulator stopped while COMMAND ran: $(emulator_cause)"
        exit 5
    fi
    if ! kill -0 "${CMD_PID}" 2>/dev/null; then
        fail "command supervisor stopped before reporting its result"
        exit 5
    fi
    if [[ ${SECONDS} -ge ${deadline} ]]; then
        exit 124
    fi
    sleep 0.1
done
read -r rc < "${STATE}/command-result"
if ! kill -0 "${EMU_PID}" 2>/dev/null; then
    fail "emulator stopped while COMMAND ran: $(emulator_cause)"
    rc=5
fi
exit "${rc}"
