#!/usr/bin/env bash
# Install the deployer-supplied container build-time tools (Issue #70, parent #5).
#
# A deployment declares the extra tools its image bakes in — Java and Maven are
# the first expected use — as a top-level `container_tools` array in
# `.config.json`. Each entry is a *declarative archive install*: download →
# verify SHA-256 → extract into /opt/vibe-tools/<id> → record the `bin`
# directories and `env` values for the PATH/env step to consume. No install
# commands, no apt packages, no installer scripts.
#
# Usage:  install-tools.sh <spec-file.json>
#
# The spec file is either the `container_tools` array itself or the whole
# `.config.json` object carrying it, so the Containerfile may hand over either.
#
# Environment:
#   VIBE_TOOLS_PREFIX  install prefix root (default /opt/vibe-tools)
#   VIBE_TOOLS_ARCH    build architecture, amd64 or arm64 (default: uname -m)
#
# Fails loud (Issue #3234), never half-installed: the whole set is validated
# first — id shape, a tool id twice, no download for the build architecture, a
# non-https URL, a missing or malformed SHA-256, an archive type that is not
# .tar.gz/.tar.xz/.zip, a bin/env value escaping the install prefix, two tools
# claiming one environment variable — so a bad set is rejected before the first
# byte is downloaded. After that, any download, checksum or extraction failure
# aborts the build non-zero with the offending tool id named.
#
# An *empty* set is not a failure, unlike install-providers.sh: a deployment
# that declares no extra tools is ordinary, and the image is complete without
# them. It still writes an empty environment file so the consumer always has one
# to read.
#
# Australian English spelling throughout (behaviour, organisation).

# Every jq program below is single-quoted on purpose: $i, $a, $k and $b are jq
# variables bound with --arg/--argjson, never shell expansions. Interpolating
# spec values into a jq program is exactly the injection this avoids.
# shellcheck disable=SC2016

set -euo pipefail

# Install prefix root. The Containerfile uses the default; tests point this at a
# temporary directory.
TOOLS_PREFIX="${VIBE_TOOLS_PREFIX:-/opt/vibe-tools}"

# One KEY=value line per resolved value, in spec order. A `PATH=<dir>` line is
# additive — each names one directory to put on PATH — and every other key is
# set once, which is why a clash between two tools is rejected below.
ENVIRONMENT_FILE="${TOOLS_PREFIX}/environment"

# The environment file shares the prefix root with the tool directories, so no
# tool may be called this.
ENVIRONMENT_FILE_NAME="environment"

fail() {
    echo "install-tools: $*" >&2
    exit 1
}

# --------------------------------------------------------------------------
# Arguments and prerequisites
# --------------------------------------------------------------------------

if [[ $# -lt 1 ]]; then
    fail "No tool spec given: pass the container_tools spec file as the first argument."
fi

SPEC_FILE="$1"
[[ -f "${SPEC_FILE}" ]] || fail "Tool spec file \"${SPEC_FILE}\" does not exist."

for required in jq curl sha256sum tar mktemp; do
    command -v "${required}" > /dev/null 2>&1 ||
        fail "\"${required}\" is required to install container tools."
done

jq empty "${SPEC_FILE}" > /dev/null 2>&1 ||
    fail "Tool spec file \"${SPEC_FILE}\" is not valid JSON."

# Accept the array itself or the .config.json object carrying it; anything else
# is a shape the build must not guess at.
SPEC_JSON="$(jq -c '
    if type == "array" then .
    elif type == "object" and ((.container_tools // null) | type) == "array"
    then .container_tools
    else empty end' "${SPEC_FILE}")"
[[ -n "${SPEC_JSON}" ]] ||
    fail "Tool spec file \"${SPEC_FILE}\" must be a container_tools array, or an object with one."

# Query the spec: spec <jq-args...> '<program>'
spec() {
    jq -r "$@" <<< "${SPEC_JSON}"
}

# --------------------------------------------------------------------------
# Build architecture
# --------------------------------------------------------------------------

BUILD_ARCH="${VIBE_TOOLS_ARCH:-}"
if [[ -z "${BUILD_ARCH}" ]]; then
    machine="$(uname -m)"
    case "${machine}" in
        x86_64 | amd64) BUILD_ARCH="amd64" ;;
        aarch64 | arm64) BUILD_ARCH="arm64" ;;
        *) fail "Unsupported build architecture: ${machine}" ;;
    esac
fi
case "${BUILD_ARCH}" in
    amd64 | arm64) ;;
    *) fail "Unsupported build architecture \"${BUILD_ARCH}\": expected amd64 or arm64." ;;
esac

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# Whether a bin/env value stays inside the tool's install prefix. "" is the
# prefix root; anything absolute, ~-anchored, or walking up with .. is out, so
# no spec can aim PATH or JAVA_HOME at an arbitrary path in the image.
is_confined() {
    local value="$1"
    case "${value}" in
        /* | '~'* | '..' | '../'* | *'/../'* | *'/..') return 1 ;;
    esac
    if [[ "${value}" == *$'\n'* ]]; then
        return 1
    fi
    return 0
}

# Read one value per line from a jq query into the global REPLY_LINES array,
# refusing a value that carries a newline (it would arrive here as two).
REPLY_LINES=()
read_lines() {
    local file="$1" expected="$2" context="$3" actual
    actual="$(wc -l < "${file}" | tr -d '[:space:]')"
    [[ "${actual}" == "${expected}" ]] ||
        fail "${context}: a value contains a newline."

    REPLY_LINES=()
    local line
    while IFS= read -r line; do
        REPLY_LINES+=("${line}")
    done < "${file}"
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

# --------------------------------------------------------------------------
# Validate the whole set before anything is downloaded
# --------------------------------------------------------------------------

COUNT="$(spec 'length')"

IDS=()
URLS=()
SHAS=()
KINDS=()
STRIPS=()
ARCHIVE_NAMES=()

seen_ids=" "
seen_env=" "

for ((index = 0; index < COUNT; index++)); do
    id="$(spec --argjson i "${index}" '(.[$i].id // "") | tostring')"
    entry="container_tools[${index}]"

    [[ "${id}" =~ ^[a-z][a-z0-9-]*$ ]] ||
        fail "${entry}: tool id \"${id}\" must be lower-case letters, digits and hyphens, starting with a letter."
    [[ "${id}" != "${ENVIRONMENT_FILE_NAME}" ]] ||
        fail "${entry}: tool id \"${id}\" is reserved — ${ENVIRONMENT_FILE} is the environment file."
    case "${seen_ids}" in
        *" ${id} "*) fail "${entry}: duplicate tool id \"${id}\"." ;;
    esac
    seen_ids="${seen_ids}${id} "

    # Every later fault names the tool, so an operator can find it in the file.
    where="${entry} (\"${id}\")"

    for block in url sha256; do
        block_type="$(spec --argjson i "${index}" --arg b "${block}" '(.[$i][$b] // null) | type')"
        [[ "${block_type}" == "object" ]] ||
            fail "${where}: ${block} must be an object keyed by architecture (amd64, arm64, noarch)."
    done

    # The architecture-specific download wins; noarch is the fallback. URL and
    # digest are taken from the same key so a mismatched pair cannot verify.
    arch_key="$(spec --argjson i "${index}" --arg a "${BUILD_ARCH}" '
        .[$i].url as $u
        | if ($u[$a] // null) != null then $a
          elif ($u.noarch // null) != null then "noarch"
          else "" end')"
    [[ -n "${arch_key}" ]] ||
        fail "${where}: no url for the build architecture \"${BUILD_ARCH}\" and no noarch fallback."

    url="$(spec --argjson i "${index}" --arg k "${arch_key}" '(.[$i].url[$k] // "") | tostring')"
    [[ "${url}" =~ ^https://[^[:space:]]+$ ]] ||
        fail "${where}: url.${arch_key} must be an https URL, got \"${url}\"."

    sha="$(spec --argjson i "${index}" --arg k "${arch_key}" '(.[$i].sha256[$k] // "") | tostring')"
    [[ "${sha}" =~ ^[0-9a-fA-F]{64}$ ]] ||
        fail "${where}: sha256.${arch_key} must be 64 hexadecimal characters, got \"${sha}\" — an unverified download is never installed."
    sha="$(printf '%s' "${sha}" | tr '[:upper:]' '[:lower:]')"

    # Archive type comes from the extension alone — never guessed.
    archive_name="${url%%\?*}"
    archive_name="${archive_name%%#*}"
    archive_name="${archive_name##*/}"
    case "${archive_name}" in
        *.tar.gz) kind="tar.gz" ;;
        *.tar.xz) kind="tar.xz" ;;
        *.zip)
            kind="zip"
            command -v unzip > /dev/null 2>&1 ||
                fail "${where}: \"unzip\" is required to extract ${archive_name}."
            ;;
        *) fail "${where}: unsupported archive \"${archive_name}\" — only .tar.gz, .tar.xz and .zip are extracted." ;;
    esac

    strip="$(spec --argjson i "${index}" '(.[$i].stripComponents // 0) | tostring')"
    [[ "${strip}" =~ ^[0-9]+$ ]] ||
        fail "${where}: stripComponents must be a non-negative integer, got \"${strip}\"."

    # bin: prefix-relative directories to put on PATH.
    bin_type="$(spec --argjson i "${index}" '(.[$i].bin // []) | type')"
    [[ "${bin_type}" == "array" ]] ||
        fail "${where}: bin must be an array of prefix-relative paths."
    non_strings="$(spec --argjson i "${index}" '[(.[$i].bin // [])[] | select(type != "string")] | length')"
    [[ "${non_strings}" == "0" ]] ||
        fail "${where}: every bin entry must be a string."
    spec --argjson i "${index}" '(.[$i].bin // [])[]' > "${WORKDIR}/bin.txt"
    bin_count="$(spec --argjson i "${index}" '(.[$i].bin // []) | length')"
    read_lines "${WORKDIR}/bin.txt" "${bin_count}" "${where}: bin"
    for value in ${REPLY_LINES[@]+"${REPLY_LINES[@]}"}; do
        is_confined "${value}" ||
            fail "${where}: bin entry \"${value}\" must be relative to ${TOOLS_PREFIX}/${id}."
    done

    # env: prefix-relative paths exported under the given names.
    env_type="$(spec --argjson i "${index}" '(.[$i].env // {}) | type')"
    [[ "${env_type}" == "object" ]] ||
        fail "${where}: env must be an object of environment variable names to prefix-relative paths."
    non_strings="$(spec --argjson i "${index}" '[(.[$i].env // {}) | to_entries[] | select((.value | type) != "string")] | length')"
    [[ "${non_strings}" == "0" ]] ||
        fail "${where}: every env value must be a string."
    spec --argjson i "${index}" '(.[$i].env // {}) | to_entries[] | "\(.key)=\(.value)"' > "${WORKDIR}/env.txt"
    env_count="$(spec --argjson i "${index}" '(.[$i].env // {}) | length')"
    read_lines "${WORKDIR}/env.txt" "${env_count}" "${where}: env"
    for line in ${REPLY_LINES[@]+"${REPLY_LINES[@]}"}; do
        name="${line%%=*}"
        value="${line#*=}"
        [[ "${name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
            fail "${where}: \"${name}\" is not a valid environment variable name."
        [[ "${name}" != "PATH" ]] ||
            fail "${where}: env must not set PATH — declare bin directories instead."
        case "${seen_env}" in
            *" ${name} "*) fail "${where}: environment variable \"${name}\" is already set by another tool." ;;
        esac
        seen_env="${seen_env}${name} "
        is_confined "${value}" ||
            fail "${where}: env ${name}=\"${value}\" must be relative to ${TOOLS_PREFIX}/${id}."
    done

    IDS+=("${id}")
    URLS+=("${url}")
    SHAS+=("${sha}")
    KINDS+=("${kind}")
    STRIPS+=("${strip}")
    ARCHIVE_NAMES+=("${archive_name}")
done

# --------------------------------------------------------------------------
# Install
# --------------------------------------------------------------------------

mkdir -p "${TOOLS_PREFIX}"
: > "${ENVIRONMENT_FILE}"
chmod 0644 "${ENVIRONMENT_FILE}"

if [[ "${COUNT}" -eq 0 ]]; then
    echo "No container tools requested."
    exit 0
fi

echo "Installing container tools: ${IDS[*]}"

for ((index = 0; index < COUNT; index++)); do
    id="${IDS[index]}"
    url="${URLS[index]}"
    sha="${SHAS[index]}"
    kind="${KINDS[index]}"
    strip="${STRIPS[index]}"
    archive_name="${ARCHIVE_NAMES[index]}"

    prefix="${TOOLS_PREFIX}/${id}"
    archive="${WORKDIR}/${id}-${archive_name}"

    echo "[${id}] downloading ${url}"
    curl -fsSL -o "${archive}" "${url}" ||
        fail "tool \"${id}\": download failed: ${url}"

    if ! printf '%s  %s\n' "${sha}" "${archive}" | sha256sum -c - > /dev/null; then
        actual="$(sha256sum "${archive}" | cut -d ' ' -f 1)"
        fail "tool \"${id}\": SHA-256 mismatch for ${url} — expected ${sha}, got ${actual}."
    fi

    mkdir -p "${prefix}"
    case "${kind}" in
        tar.gz)
            tar -xzf "${archive}" -C "${prefix}" \
                --strip-components="${strip}" --no-same-owner ||
                fail "tool \"${id}\": extracting ${archive_name} failed."
            ;;
        tar.xz)
            tar -xJf "${archive}" -C "${prefix}" \
                --strip-components="${strip}" --no-same-owner ||
                fail "tool \"${id}\": extracting ${archive_name} failed."
            ;;
        zip)
            # unzip has no --strip-components, so descend the leading
            # directories by hand and refuse to guess when a level does not
            # hold exactly one directory.
            unzip_dir="${WORKDIR}/unzip"
            rm -rf "${unzip_dir}"
            mkdir -p "${unzip_dir}"
            unzip -q "${archive}" -d "${unzip_dir}" ||
                fail "tool \"${id}\": extracting ${archive_name} failed."

            source_dir="${unzip_dir}"
            for ((level = 0; level < strip; level++)); do
                entries=0
                only=""
                for path in "${source_dir}"/* "${source_dir}"/.[!.]*; do
                    [[ -e "${path}" ]] || continue
                    entries=$((entries + 1))
                    only="${path}"
                done
                if [[ "${entries}" -ne 1 || ! -d "${only}" ]]; then
                    fail "tool \"${id}\": stripComponents=${strip} cannot be applied to ${archive_name} — level $((level + 1)) does not hold exactly one directory."
                fi
                source_dir="${only}"
            done

            cp -a "${source_dir}/." "${prefix}/" ||
                fail "tool \"${id}\": copying ${archive_name} into ${prefix} failed."
            rm -rf "${unzip_dir}"
            ;;
    esac
    rm -f "${archive}"

    # Record the resolved PATH directories and env values. A declared path that
    # the archive does not contain is a fault now, not a broken PATH later.
    spec --argjson i "${index}" '(.[$i].bin // [])[]' > "${WORKDIR}/bin.txt"
    while IFS= read -r value; do
        resolved="${prefix}${value:+/}${value}"
        [[ -d "${resolved}" ]] ||
            fail "tool \"${id}\": bin directory \"${value}\" does not exist in ${archive_name} (looked for ${resolved})."
        printf 'PATH=%s\n' "${resolved}" >> "${ENVIRONMENT_FILE}"
    done < "${WORKDIR}/bin.txt"

    spec --argjson i "${index}" '(.[$i].env // {}) | to_entries[] | "\(.key)=\(.value)"' > "${WORKDIR}/env.txt"
    while IFS= read -r line; do
        name="${line%%=*}"
        value="${line#*=}"
        resolved="${prefix}${value:+/}${value}"
        [[ -e "${resolved}" ]] ||
            fail "tool \"${id}\": ${name}=\"${value}\" does not exist in ${archive_name} (looked for ${resolved})."
        printf '%s=%s\n' "${name}" "${resolved}" >> "${ENVIRONMENT_FILE}"
    done < "${WORKDIR}/env.txt"

    echo "[${id}] installed into ${prefix}"
done

echo "Installed container tools: ${IDS[*]}"
