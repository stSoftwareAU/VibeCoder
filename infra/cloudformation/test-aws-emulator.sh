#!/usr/bin/env bash
# test-aws-emulator.sh: deploy every CloudFormation template in this directory
# into the official AWS Emulator and assert what it built (Issue #5110). It
# replaces test-floci.sh, which Issue #5110 removes.
#
# Contract
#   * Reference command: infra/cloudformation/test-aws-emulator.sh, run by any
#     non-root account other than `vibe`. Outside the emulator it re-execs
#     itself as `aws-emulator-run --timeout 900 -- <this script>` (Issue #5109);
#     the helper starts a private emulator and its exit status flows through.
#   * Inside the emulator it refuses (exit 2) unless AWS_ENDPOINT_URL is
#     https://127.0.0.1:<port> and AWS_CA_BUNDLE is a readable file. It never
#     falls back to real AWS.
#   * It round-trips one SSM parameter (ParameterNotFound is the supported
#     negative case), seeds a user-owned String parameter whose name the
#     templates pass for their SSM-typed parameters, deploys each template with
#     create-stack --on-failure DO_NOTHING, and asserts every resource's status
#     and each template's material properties. A template without a property
#     check fails the run, so status alone never passes a new template.
#   * KNOWN_GAPS names resources this emulator cannot build. Each must fail with
#     exactly the expected reason. Any other outcome fails with "gap changed:
#     update KNOWN_GAPS". Gaps are reported as UNSUPPORTED, never as passes.
#   * An HTTP 501 or NotImplemented answer fails with
#     "UNSUPPORTED OPERATION: <op>: <cause>". Any other unexpected AWS failure
#     fails with its first cause line.
#   * Every stack and seeded parameter is removed, and removal is asserted. An
#     early exit still attempts the stack and seeded-parameter deletes without
#     masking the original exit status.
#   * A reproduced gap prints an UNSUPPORTED line, which is not counted as a
#     pass; "all N assertions passed" counts real assertions only.
#
# Exit: 0 every assertion passed; 1 an assertion or AWS call failed; 2 refused
# (endpoint is not a loopback emulator, or CA bundle missing); 4 aws-emulator-run
# or aws is missing.
#
# Australian English spelling throughout (behaviour, organisation).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_SELF="${SCRIPT_DIR}/${BASH_SOURCE[0]##*/}"
ENDPOINT_RE='^https://127\.0\.0\.1:[0-9]+$'
UNSUPPORTED_RE='(^|[^0-9])501([^0-9]|$)|NotImplemented|not implemented'
FAKE_AMI_ID="ami-0123456789abcdef0"

# Named gaps: resources this emulator cannot build. One entry per line, fields
# separated by `|` (no `|` may appear inside a field):
#   template|LogicalId|ResourceType|expected reason substring|alternative validation|recheck condition
KNOWN_GAPS=(
    "linux-verification-host.yaml|VerificationHost|AWS::EC2::Instance|this emulator does not apply the MetadataOptions property of AWS::EC2::Instance|static checks: .github/workflows/checkov.yml scans the template, and worker/deno/tests/linux_verification_host_template_test.ts asserts MetadataOptions HttpTokens is required (IMDSv2 only); real-AWS deployment as docs/EC2-LINUX-VERIFICATION.md describes|recheck when the aws-emulator pin in container/tools.json changes, or when this script reports the gap no longer reproduces (gap changed)"
)

WORK=""
STACK_NAME=""
STACK_DELETED=1
SEEDED_AMI_PARAM=""
RUN_SUFFIX=""
RUN_OUT=""
PHYS=""
PASS_COUNT=0
EXERCISED=0
PROPERTY_CHECKED=" "
GONE_VPC=""
GONE_ROLE=""

die() {
    local code="$1"
    shift
    echo "::error::$*" >&2
    exit "${code}"
}

pass() {
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "PASS: $*"
}

# Records that the property checks of the current template cover logical id $1.
property_checked() {
    PROPERTY_CHECKED="${PROPERTY_CHECKED}$1 "
}

# --- Outside the emulator: re-exec under aws-emulator-run --------------------
if [[ -z "${AWS_EMULATOR_STATE_DIR:-}" ]]; then
    if ! command -v aws-emulator-run > /dev/null 2>&1; then
        die 4 "aws-emulator-run is not on PATH; install it (Issue #5109) so this script can start a private AWS Emulator"
    fi
    exec aws-emulator-run --timeout 900 -- "${SCRIPT_SELF}" "$@"
fi

# --- Inside the emulator: refuse anything that is not the loopback emulator --
if [[ ! "${AWS_ENDPOINT_URL:-}" =~ ${ENDPOINT_RE} ]]; then
    die 2 "refusing: AWS_ENDPOINT_URL must be https://127.0.0.1:<port>, got '${AWS_ENDPOINT_URL:-}'; this script never talks to real AWS"
fi
if [[ ! -f "${AWS_CA_BUNDLE:-}" || ! -r "${AWS_CA_BUNDLE:-}" ]]; then
    die 2 "refusing: AWS_CA_BUNDLE must name a readable CA file, got '${AWS_CA_BUNDLE:-}'"
fi
if ! command -v aws > /dev/null 2>&1; then
    die 4 "aws CLI not found on PATH; the AWS Emulator run needs it"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-aws-emulator.XXXXXX")" ||
    die 1 "cannot create a work directory under ${TMPDIR:-/tmp}"

# shellcheck disable=SC2329 # invoked by the EXIT trap below
on_exit() {
    local rc=$?
    trap - EXIT
    if [[ "${STACK_DELETED}" -eq 0 && -n "${STACK_NAME}" ]]; then
        # Early exit: attempt the delete only. Its outcome must not mask rc.
        aws cloudformation delete-stack --stack-name "${STACK_NAME}" > /dev/null 2>&1 || true
    fi
    if [[ -n "${SEEDED_AMI_PARAM}" ]]; then
        # Early exit: attempt the seeded parameter delete only. Must not mask rc.
        aws ssm delete-parameter --name "${SEEDED_AMI_PARAM}" > /dev/null 2>&1 || true
    fi
    rm -rf "${WORK}"
    exit "${rc}"
}
trap on_exit EXIT

# --- AWS call helpers --------------------------------------------------------
# First non-blank line of a captured stderr file, or a placeholder.
cause_line() {
    local line
    line="$(grep -v '^[[:space:]]*$' "$1" | head -n 1 || true)"
    if [[ -z "${line}" ]]; then
        line="(no stderr output)"
    fi
    printf '%s' "${line}"
}

is_unsupported() {
    grep -Eq -- "${UNSUPPORTED_RE}" "$1"
}

# Runs `aws ARGS`, with OP as the label for any failure. On success RUN_OUT holds
# stdout. On failure the run stops: UNSUPPORTED OPERATION when the emulator
# answers 501 or NotImplemented, else the first cause line.
run_aws() {
    local op="$1"
    shift
    local errfile="${WORK}/last-stderr"
    local status=0
    RUN_OUT="$(aws "$@" 2> "${errfile}")" || status=$?
    if [[ ${status} -ne 0 ]]; then
        if is_unsupported "${errfile}"; then
            die 1 "UNSUPPORTED OPERATION: ${op}: $(cause_line "${errfile}")"
        fi
        die 1 "${op} failed (exit ${status}): $(cause_line "${errfile}")"
    fi
}

# Runs `aws ARGS`, which must fail with stderr containing EXPECT (fixed text).
expect_aws_error() {
    local op="$1"
    local expect="$2"
    shift 2
    local errfile="${WORK}/expect-stderr"
    local status=0
    aws "$@" > /dev/null 2> "${errfile}" || status=$?
    if [[ ${status} -eq 0 ]]; then
        die 1 "${op}: expected a failure containing '${expect}', but the call succeeded"
    fi
    if ! grep -qF -- "${expect}" "${errfile}"; then
        if is_unsupported "${errfile}"; then
            die 1 "UNSUPPORTED OPERATION: ${op}: $(cause_line "${errfile}")"
        fi
        die 1 "${op}: expected '${expect}', got: $(cause_line "${errfile}")"
    fi
    pass "${op}: ${expect} (as expected)"
}

assert_eq() {
    local label="$1"
    local expected="$2"
    local actual="$3"
    if [[ "${actual}" != "${expected}" ]]; then
        die 1 "${label}: expected '${expected}', got '${actual}'"
    fi
    pass "${label} = ${expected}"
}

random_suffix() {
    od -An -N6 -tx1 /dev/urandom | tr -d ' \n'
}

# Sets PHYS to the physical id of logical resource $2 in stack $1.
physical_id() {
    run_aws "describe-stack-resource ${2}" cloudformation describe-stack-resource \
        --stack-name "$1" --logical-resource-id "$2" \
        --query StackResourceDetail.PhysicalResourceId --output text
    PHYS="${RUN_OUT}"
}

# --- Templates ---------------------------------------------------------------
# SIMPLE-ON-PURPOSE: 2-space names, 4-space keys, single-line Type, as in the retired test-floci.sh — upgrade when a template uses flow-style or anchors
# Prints "<Name><TAB><Type>" for each SSM-typed parameter of template $1.
ssm_parameters() {
    awk '
        /^Parameters:[[:space:]]*$/ { inparams = 1; next }
        inparams && /^[^[:space:]#]/ { inparams = 0 }
        !inparams { next }
        /^  [^[:space:]#][^:]*:[[:space:]]*$/ {
            pname = $0
            sub(/^  /, "", pname)
            sub(/:[[:space:]]*$/, "", pname)
            next
        }
        /^    Type:[[:space:]]/ {
            type = $0
            sub(/^    Type:[[:space:]]*/, "", type)
            sub(/[[:space:]]+$/, "", type)
            if (type ~ /^AWS::SSM::Parameter::Value</) { printf "%s\t%s\n", pname, type }
        }
    ' "$1"
}

# Prints the logical ids declared directly under Resources: of template $1.
template_resource_ids() {
    awk '
        /^Resources:[[:space:]]*$/ { inres = 1; next }
        inres && /^[^[:space:]#]/ { inres = 0 }
        !inres { next }
        /^  [A-Za-z0-9]+:[[:space:]]*$/ {
            id = $0
            sub(/^  /, "", id)
            sub(/:[[:space:]]*$/, "", id)
            print id
        }
    ' "$1"
}

# Prints the KNOWN_GAPS entry for template $1 and logical id $2, if any.
gap_entry() {
    local entry e_tpl e_lid
    for entry in "${KNOWN_GAPS[@]}"; do
        IFS='|' read -r e_tpl e_lid _ _ _ _ <<< "${entry}"
        if [[ "${e_tpl}" == "$1" && "${e_lid}" == "$2" ]]; then
            printf '%s\n' "${entry}"
            return 0
        fi
    done
}

# --- Property checks (one function per template, keyed by file name) ---------
check_linux_verification_host() {
    local stack="$1"
    local vpc subnet rtb igw sg role profile egress expected_egress
    physical_id "${stack}" VerificationVpc
    vpc="${PHYS}"
    run_aws "ec2 describe-vpcs" ec2 describe-vpcs --vpc-ids "${vpc}" \
        --query 'Vpcs[0].CidrBlock' --output text
    assert_eq "VerificationVpc CidrBlock" "10.42.0.0/16" "${RUN_OUT}"
    run_aws "ec2 describe-vpc-attribute" ec2 describe-vpc-attribute --vpc-id "${vpc}" \
        --attribute enableDnsHostnames --query 'EnableDnsHostnames.Value' --output text
    assert_eq "VerificationVpc enableDnsHostnames" "True" "${RUN_OUT}"

    physical_id "${stack}" PublicSubnet
    subnet="${PHYS}"
    run_aws "ec2 describe-subnets (CIDR)" ec2 describe-subnets --subnet-ids "${subnet}" \
        --query 'Subnets[0].CidrBlock' --output text
    assert_eq "PublicSubnet CidrBlock" "10.42.0.0/24" "${RUN_OUT}"
    run_aws "ec2 describe-subnets (VPC)" ec2 describe-subnets --subnet-ids "${subnet}" \
        --query 'Subnets[0].VpcId' --output text
    assert_eq "PublicSubnet VpcId" "${vpc}" "${RUN_OUT}"
    run_aws "ec2 describe-subnets (public IP)" ec2 describe-subnets --subnet-ids "${subnet}" \
        --query 'Subnets[0].MapPublicIpOnLaunch' --output text
    assert_eq "PublicSubnet MapPublicIpOnLaunch" "True" "${RUN_OUT}"

    physical_id "${stack}" InternetGateway
    igw="${PHYS}"
    # Covers the gateway's attachment too: VpcGatewayAttachment has no other
    # property of its own. The first attachment is the stack's VPC.
    run_aws "ec2 describe-internet-gateways" ec2 describe-internet-gateways \
        --internet-gateway-ids "${igw}" \
        --query 'InternetGateways[0].Attachments[0].[VpcId,State]' --output text
    read -r igw_vpc igw_state <<< "${RUN_OUT}" || true
    assert_eq "InternetGateway attachment VpcId" "${vpc}" "${igw_vpc:-}"
    assert_eq "VpcGatewayAttachment State" "available" "${igw_state:-}"

    physical_id "${stack}" PublicRouteTable
    rtb="${PHYS}"
    # The JMESPath filter uses backticks, which must not expand in bash.
    # shellcheck disable=SC2016
    run_aws "ec2 describe-route-tables (default route)" ec2 describe-route-tables \
        --route-table-ids "${rtb}" \
        --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].GatewayId' --output text
    assert_eq "PublicRouteTable 0.0.0.0/0 target" "${igw}" "${RUN_OUT}"
    run_aws "ec2 describe-route-tables (subnet association)" ec2 describe-route-tables \
        --filters "Name=association.subnet-id,Values=${subnet}" \
        --query 'RouteTables[0].RouteTableId' --output text
    assert_eq "PublicSubnet associated route table" "${rtb}" "${RUN_OUT}"

    physical_id "${stack}" HostSecurityGroup
    sg="${PHYS}"
    run_aws "ec2 describe-security-groups (ingress)" ec2 describe-security-groups \
        --group-ids "${sg}" --query 'length(SecurityGroups[0].IpPermissions)' --output text
    assert_eq "HostSecurityGroup inbound rule count" "0" "${RUN_OUT}"
    run_aws "ec2 describe-security-groups (egress)" ec2 describe-security-groups \
        --group-ids "${sg}" \
        --query 'SecurityGroups[0].IpPermissionsEgress[].[IpProtocol,FromPort,ToPort,IpRanges[0].CidrIp]' \
        --output text
    egress="$(printf '%s\n' "${RUN_OUT}" | tr '\t' ' ' | LC_ALL=C sort)"
    expected_egress="$(printf '%s\n' \
        "tcp 443 443 0.0.0.0/0" "tcp 80 80 0.0.0.0/0" "udp 53 53 0.0.0.0/0" \
        "tcp 53 53 0.0.0.0/0" "udp 123 123 0.0.0.0/0" | LC_ALL=C sort)"
    assert_eq "HostSecurityGroup egress (protocol, ports, CIDR)" "${expected_egress}" "${egress}"

    physical_id "${stack}" HostRole
    role="${PHYS}"
    run_aws "iam get-role" iam get-role --role-name "${role}" \
        --query 'Role.AssumeRolePolicyDocument.Statement[0].Principal.Service' --output text
    assert_eq "HostRole trust principal" "ec2.amazonaws.com" "${RUN_OUT}"
    run_aws "iam list-attached-role-policies" iam list-attached-role-policies \
        --role-name "${role}" --query 'AttachedPolicies[].PolicyArn' --output text
    assert_eq "HostRole managed policy" "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" "${RUN_OUT}"

    physical_id "${stack}" HostInstanceProfile
    profile="${PHYS}"
    run_aws "iam get-instance-profile" iam get-instance-profile \
        --instance-profile-name "${profile}" --query 'InstanceProfile.Roles[].RoleName' --output text
    assert_eq "HostInstanceProfile role" "${role}" "${RUN_OUT}"

    # Every resource whose properties are asserted above.
    property_checked VerificationVpc
    property_checked PublicSubnet
    property_checked PublicRouteTable
    property_checked DefaultEgressRoute
    property_checked PublicSubnetRouteTableAssociation
    property_checked InternetGateway
    property_checked VpcGatewayAttachment
    property_checked HostSecurityGroup
    property_checked HostRole
    property_checked HostInstanceProfile

    GONE_VPC="${vpc}"
    GONE_ROLE="${role}"
}

# --- Seeding and the SSM round trip ------------------------------------------
check_ssm_round_trip() {
    local name="/vibe-coder-test/aws-emulator-5110-${RUN_SUFFIX}"
    local value="round-trip-${RUN_SUFFIX}"
    run_aws "ssm put-parameter" ssm put-parameter --name "${name}" --type String --value "${value}"
    run_aws "ssm get-parameter" ssm get-parameter --name "${name}" \
        --query Parameter.Value --output text
    assert_eq "SSM round trip value" "${value}" "${RUN_OUT}"
    run_aws "ssm delete-parameter" ssm delete-parameter --name "${name}"
    expect_aws_error "SSM get-parameter after delete" "ParameterNotFound" \
        ssm get-parameter --name "${name}"
}

seed_ami_parameter() {
    SEEDED_AMI_PARAM="/vibe-coder-test/ubuntu-ami-id-${RUN_SUFFIX}"
    run_aws "ssm put-parameter (seed AMI id)" ssm put-parameter --name "${SEEDED_AMI_PARAM}" \
        --type String --value "${FAKE_AMI_ID}"
    pass "seeded SSM parameter ${SEEDED_AMI_PARAM} for AWS::EC2::Image::Id"
}

# --- Deploy and assert one template ------------------------------------------
deploy_and_check() {
    local template="$1"
    local name="${template##*/}"
    local base="${name%.*}"
    local stack="vc5110-${base}-${RUN_SUFFIX}"
    local params pname ptype
    local overrides=()
    local create=()
    local lid rtype rstatus rreason rows seen expected_id entry e_tpl e_lid
    local gap g_type g_expect stack_status expected_status
    local gap_count=0 gap_total=0 complete=0 complete_ids=" " checked_lid props=0
    echo "=== ${name} (stack ${stack}) ==="

    params="$(ssm_parameters "${template}")"
    while IFS=$'\t' read -r pname ptype; do
        [[ -n "${pname}" ]] || continue
        if [[ "${ptype}" != *"AWS::EC2::Image::Id"* ]]; then
            die 1 "no seed value for SSM parameter ${pname} (${ptype}); add one to seed_ami_parameter"
        fi
        overrides+=("ParameterKey=${pname},ParameterValue=${SEEDED_AMI_PARAM}")
    done <<< "${params}"

    create=(cloudformation create-stack --stack-name "${stack}"
        --template-body "file://${template}" --on-failure DO_NOTHING
        --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM)
    if [[ ${#overrides[@]} -gt 0 ]]; then
        create+=(--parameters "${overrides[@]}")
    fi
    STACK_NAME="${stack}"
    STACK_DELETED=0
    run_aws "cloudformation create-stack ${name}" "${create[@]}"

    # A waiter failure is expected when the stack ends in CREATE_FAILED; the
    # status read below decides.
    aws cloudformation wait stack-create-complete --stack-name "${stack}" > /dev/null 2>&1 || true
    run_aws "cloudformation describe-stacks ${stack}" cloudformation describe-stacks \
        --stack-name "${stack}" --query 'Stacks[0].StackStatus' --output text
    stack_status="${RUN_OUT}"
    run_aws "cloudformation describe-stack-resources ${stack}" cloudformation describe-stack-resources \
        --stack-name "${stack}" \
        --query "StackResources[].[LogicalResourceId,ResourceType,ResourceStatus,ResourceStatusReason || 'none']" \
        --output text
    rows="${RUN_OUT}"

    for entry in "${KNOWN_GAPS[@]}"; do
        IFS='|' read -r e_tpl _ _ _ _ _ <<< "${entry}"
        if [[ "${e_tpl}" == "${name}" ]]; then
            gap_total=$((gap_total + 1))
        fi
    done

    seen=" "
    while IFS=$'\t' read -r lid rtype rstatus rreason; do
        [[ -n "${lid}" ]] || continue
        seen="${seen}${lid} "
        gap="$(gap_entry "${name}" "${lid}")"
        if [[ -n "${gap}" ]]; then
            IFS='|' read -r _ _ g_type g_expect _ _ <<< "${gap}"
            if [[ "${rstatus}" != "CREATE_FAILED" || "${rtype}" != "${g_type}" ]] ||
                ! grep -qF -- "${g_expect}" <<< "${rreason}"; then
                die 1 "gap changed: update KNOWN_GAPS: ${lid} (${rtype}) is ${rstatus} with reason '${rreason}', expected ${g_type} CREATE_FAILED with '${g_expect}'"
            fi
            gap_count=$((gap_count + 1))
            echo "UNSUPPORTED (gap reproduced, not proven): ${lid} CREATE_FAILED (${g_expect})"
        else
            if [[ "${rstatus}" != "CREATE_COMPLETE" ]]; then
                die 1 "${lid} (${rtype}) is ${rstatus}: ${rreason}"
            fi
            complete=$((complete + 1))
            complete_ids="${complete_ids}${lid} "
        fi
    done <<< "${rows}"

    while IFS= read -r expected_id; do
        [[ -n "${expected_id}" ]] || continue
        if [[ " ${seen} " != *" ${expected_id} "* ]]; then
            die 1 "${expected_id} is declared in ${name} but missing from stack ${stack}"
        fi
    done <<< "$(template_resource_ids "${template}")"

    for entry in "${KNOWN_GAPS[@]}"; do
        IFS='|' read -r e_tpl e_lid _ _ _ _ <<< "${entry}"
        if [[ "${e_tpl}" == "${name}" && " ${seen} " != *" ${e_lid} "* ]]; then
            die 1 "gap changed: update KNOWN_GAPS: ${e_lid} was not reported by stack ${stack}"
        fi
    done

    expected_status="CREATE_COMPLETE"
    if [[ ${gap_total} -gt 0 ]]; then
        expected_status="CREATE_FAILED"
    fi
    if [[ "${stack_status}" != "${expected_status}" ]]; then
        if [[ ${gap_total} -gt 0 ]]; then
            die 1 "gap changed: update KNOWN_GAPS: stack ${stack} is ${stack_status}, expected CREATE_FAILED caused only by the named gap"
        fi
        die 1 "stack ${stack} is ${stack_status}, expected CREATE_COMPLETE"
    fi
    pass "stack ${stack} ${stack_status}: ${complete} resources CREATE_COMPLETE, ${gap_count} named gap(s)"

    GONE_VPC=""
    GONE_ROLE=""
    PROPERTY_CHECKED=" "
    case "${name}" in
        linux-verification-host.yaml) check_linux_verification_host "${stack}" ;;
        *) die 1 "no property checks for ${name}; add them" ;;
    esac
    # Only resources with a property assertion count as "properties checked".
    for checked_lid in ${complete_ids}; do
        if [[ "${PROPERTY_CHECKED}" == *" ${checked_lid} "* ]]; then
            props=$((props + 1))
        fi
    done
    EXERCISED=$((EXERCISED + props))

    delete_stack_and_assert "${stack}"
}

# --- Cleanup -----------------------------------------------------------------
delete_stack_and_assert() {
    local stack="$1"
    run_aws "cloudformation delete-stack" cloudformation delete-stack --stack-name "${stack}"
    STACK_DELETED=1
    run_aws "cloudformation wait stack-delete-complete" cloudformation wait stack-delete-complete \
        --stack-name "${stack}"
    expect_aws_error "stack ${stack} removed" "ValidationError" \
        cloudformation describe-stacks --stack-name "${stack}"
    if [[ -n "${GONE_ROLE}" ]]; then
        expect_aws_error "role ${GONE_ROLE} removed" "NoSuchEntity" \
            iam get-role --role-name "${GONE_ROLE}"
    fi
    if [[ -n "${GONE_VPC}" ]]; then
        expect_aws_error "VPC ${GONE_VPC} removed" "InvalidVpcID.NotFound" \
            ec2 describe-vpcs --vpc-ids "${GONE_VPC}"
    fi
    STACK_NAME=""
}

# --- Main --------------------------------------------------------------------
templates=()
for candidate in "${SCRIPT_DIR}"/*.yaml "${SCRIPT_DIR}"/*.yml "${SCRIPT_DIR}"/*.json; do
    if [[ -f "${candidate}" ]]; then
        templates+=("${candidate}")
    fi
done
if [[ ${#templates[@]} -eq 0 ]]; then
    die 1 "No CloudFormation templates (*.yaml, *.yml, *.json) found in ${SCRIPT_DIR}"
fi
for template in "${templates[@]}"; do
    name="${template##*/}"
    case "${name}" in
        linux-verification-host.yaml) ;;
        *) die 1 "no property checks for ${name}; add them" ;;
    esac
done

RUN_SUFFIX="$(random_suffix)"
check_ssm_round_trip
seed_ami_parameter
for template in "${templates[@]}"; do
    deploy_and_check "${template}"
done
run_aws "ssm delete-parameter (seeded AMI id)" ssm delete-parameter --name "${SEEDED_AMI_PARAM}"
expect_aws_error "SSM get-parameter after delete (seeded AMI id)" "ParameterNotFound" \
    ssm get-parameter --name "${SEEDED_AMI_PARAM}"
SEEDED_AMI_PARAM=""

echo "all ${PASS_COUNT} assertions passed"
echo "exercised: ${EXERCISED} resources (properties checked)"
echo
echo "UNSUPPORTED (not proven, named gaps):"
for entry in "${KNOWN_GAPS[@]}"; do
    IFS='|' read -r e_tpl e_lid e_type e_expect e_alt e_recheck <<< "${entry}"
    echo "  - ${e_tpl} ${e_lid} (${e_type}): ${e_expect}"
    echo "      alternative validation: ${e_alt}"
    echo "      recheck: ${e_recheck}"
done
exit 0
