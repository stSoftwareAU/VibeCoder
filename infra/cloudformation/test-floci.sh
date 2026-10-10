#!/usr/bin/env bash
# Deploy every CloudFormation template in this directory into the Floci AWS
# emulator and assert each stack reaches CREATE_COMPLETE (Issue #3369).
#
# Run by .github/workflows/floci.yml, and runnable locally. Floci is started on
# demand if nothing already answers on the endpoint. Templates that create an
# AWS::EC2::Instance need the Docker socket (Floci runs instances as
# containers): in CI a missing socket is an error, elsewhere those templates
# are reported as skipped.
#
# FLOCI_ENDPOINT overrides the endpoint (default http://127.0.0.1:4566).
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

ENDPOINT="${FLOCI_ENDPOINT:-http://127.0.0.1:4566}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Template discovery ------------------------------------------------------
templates=()
for candidate in "${SCRIPT_DIR}"/*.yaml "${SCRIPT_DIR}"/*.yml "${SCRIPT_DIR}"/*.json; do
    if [[ -f "${candidate}" ]]; then
        templates+=("${candidate}")
    fi
done
if [[ ${#templates[@]} -eq 0 ]]; then
    echo "::error::No CloudFormation templates (*.yaml, *.yml, *.json) found in ${SCRIPT_DIR}"
    exit 1
fi

# --- Docker gate (before requiring aws) --------------------------------------
docker_socket="${DOCKER_HOST:-/var/run/docker.sock}"
docker_socket="${docker_socket#unix://}"
in_ci="false"
if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    in_ci="true"
fi

to_deploy=()
for template in "${templates[@]}"; do
    if grep -q 'AWS::EC2::Instance' "${template}"; then
        if [[ -S "${docker_socket}" ]]; then
            to_deploy+=("${template}")
        elif [[ "${in_ci}" == "true" ]]; then
            echo "::error::Docker socket ${docker_socket} not found; Floci needs it to run AWS::EC2::Instance (${template##*/})"
            exit 1
        else
            echo "SKIPPED (needs Docker): ${template##*/}"
        fi
    else
        to_deploy+=("${template}")
    fi
done

if [[ ${#to_deploy[@]} -eq 0 ]]; then
    echo "Nothing to deploy; every template was skipped."
    exit 0
fi

# --- Tooling and credentials -------------------------------------------------
if ! command -v aws > /dev/null 2>&1; then
    echo "::error::aws CLI not found — the worker image does not ship it; install AWS CLI v2"
    exit 1
fi
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

# --- Floci on demand ---------------------------------------------------------
floci_pid=""
scratch=""
# shellcheck disable=SC2329  # Invoked via the EXIT trap below.
cleanup() {
    if [[ -n "${floci_pid}" ]]; then
        kill "${floci_pid}" 2> /dev/null || true
        # Floci dies from our SIGTERM, so its exit status is meaningless here.
        wait "${floci_pid}" 2> /dev/null || true
    fi
    if [[ -n "${scratch}" ]]; then
        rm -rf "${scratch}"
    fi
}
trap cleanup EXIT

if curl -sS -o /dev/null --max-time 5 "${ENDPOINT}/" > /dev/null 2>&1; then
    echo "Floci already answering on ${ENDPOINT}"
else
    if ! command -v floci > /dev/null 2>&1; then
        echo "::error::Nothing answers on ${ENDPOINT} and floci is not on PATH"
        exit 1
    fi
    scratch="$(mktemp -d)"
    # Floci writes ./data, so run it from the scratch directory.
    (
        cd "${scratch}"
        FLOCI_SERVICES_CLOUDFORMATION_ALLOW_STUB_UNSUPPORTED_RESOURCE_TYPES=true \
            exec floci -Dquarkus.http.host=127.0.0.1 > "${scratch}/floci.log" 2>&1
    ) < /dev/null &
    floci_pid=$!
    if ! curl -sS -o /dev/null --retry 30 --retry-delay 1 --retry-connrefused \
        --max-time 5 "${ENDPOINT}/"; then
        echo "--- floci log (tail) ---"
        tail -n 50 "${scratch}/floci.log" || true
        echo "::error::Floci did not answer on ${ENDPOINT}"
        exit 1
    fi
fi

# --- Per-template helpers ----------------------------------------------------
# SIMPLE-ON-PURPOSE: awk over the Parameters: block assuming 2-space parameter
# names and 4-space keys, with single-line Type/Default values — upgrade when a
# template uses flow-style, anchors, multi-line or tab-indented parameters.
# Prints "<Type><TAB><Default>" for each SSM-typed parameter with a Default.
ssm_parameters() {
    awk '
        /^Parameters:[[:space:]]*$/ { inparams = 1; next }
        inparams && /^[^[:space:]#]/ { inparams = 0 }
        !inparams { next }
        /^  [^[:space:]#][^:]*:[[:space:]]*$/ { type = ""; next }
        /^    Type:[[:space:]]/ {
            type = $0
            sub(/^    Type:[[:space:]]*/, "", type)
            sub(/[[:space:]]+$/, "", type)
            next
        }
        /^    Default:[[:space:]]/ {
            def = $0
            sub(/^    Default:[[:space:]]*/, "", def)
            sub(/[[:space:]]+$/, "", def)
            gsub(/^["\x27]|["\x27]$/, "", def)
            if (type ~ /^AWS::SSM::Parameter::Value</) { printf "%s\t%s\n", type, def }
        }
    ' "$1"
}

failures=0
deployed=0

for template in "${to_deploy[@]}"; do
    name="${template##*/}"
    base="${name%.*}"
    stack="floci-${base}"
    echo "=== ${name} (stack ${stack}) ==="

    # Floci cannot resolve public SSM paths, so seed each one with a fake value.
    while IFS=$'\t' read -r ptype ppath; do
        [[ -n "${ptype}" ]] || continue
        value="placeholder"
        if [[ "${ptype}" == *"AWS::EC2::Image::Id"* ]]; then
            value="ami-0123456789abcdef0"
        fi
        aws ssm put-parameter --endpoint-url "${ENDPOINT}" --name "${ppath}" \
            --type String --value "${value}" --overwrite > /dev/null
    done < <(ssm_parameters "${template}")

    # Record a deploy failure rather than aborting, so every template is tried.
    deploy_failed=0
    if ! aws cloudformation deploy --endpoint-url "${ENDPOINT}" \
        --template-file "${template}" --stack-name "${stack}" \
        --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
        --no-fail-on-empty-changeset; then
        deploy_failed=1
    fi

    status="$(aws cloudformation describe-stacks --endpoint-url "${ENDPOINT}" \
        --stack-name "${stack}" --query 'Stacks[0].StackStatus' --output text)" || status="UNKNOWN"
    deployed=$((deployed + 1))

    if [[ "${status}" != "CREATE_COMPLETE" || "${deploy_failed}" -ne 0 ]]; then
        echo "::error::${name}: stack ${stack} is ${status}, expected CREATE_COMPLETE"
        # Diagnostic only: the failure is already recorded, so a failing events
        # call must not mask it.
        aws cloudformation describe-stack-events --endpoint-url "${ENDPOINT}" \
            --stack-name "${stack}" --output table || true
        failures=$((failures + 1))
    else
        echo "PASS: ${name} CREATE_COMPLETE"
    fi

    # Floci reports stubbed resources as "It was stubbed and nothing was created for it."
    if ! stubbed="$(aws cloudformation describe-stack-resources --endpoint-url "${ENDPOINT}" \
        --stack-name "${stack}" \
        --query "StackResources[?contains(ResourceStatusReason || '', 'stubbed')].ResourceType" \
        --output text)"; then
        echo "::error::${name}: describe-stack-resources failed for ${stack}"
        failures=$((failures + 1))
        continue
    fi
    stub_types="$(printf '%s\n' "${stubbed}" | tr '[:space:]' '\n' | awk 'NF && $0 != "None"' | sort -u)"
    while IFS= read -r rtype; do
        [[ -n "${rtype}" ]] || continue
        echo "::warning::Floci stubbed ${rtype} in ${name}: nothing was created for it"
    done <<< "${stub_types}"
done

echo "Floci CloudFormation summary: ${deployed} deployed, ${failures} failed"
if [[ "${failures}" -ne 0 ]]; then
    exit 1
fi
exit 0
