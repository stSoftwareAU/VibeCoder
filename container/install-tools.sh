#!/usr/bin/env bash
# Install deployer-supplied build-time tools (Issue #70, parent #5).
#
# The container image can carry extra build-time tools (Java, Maven, …) chosen
# per deployment via the `.config.json` `container_tools` array. Issue #71
# already wired the Containerfile to hand that array to this script as a spec
# file; this script is the generic install step it invokes.
#
# Usage:  install-tools.sh <spec-file.json>
#
# The spec is the `container_tools` array. For each entry, in array order:
#   1. select the URL/SHA for the build architecture (amd64 / arm64), falling
#      back to `noarch`;
#   2. download it (curl -fsSL);
#   3. verify the declared SHA-256 (sha256sum -c -) — MANDATORY, a mismatch
#      aborts, exactly as the pinned gh / jq / Node steps in the Containerfile
#      already do;
#   4. extract into /opt/vibe-tools/<id>, honouring stripComponents, with
#      --no-same-owner; .tar.gz, .tar.xz and .zip by extension, an unknown
#      extension aborts rather than guessing;
#   5. record the resolved bin dirs (as `PATH=<dir>` lines) and env values (as
#      `<KEY>=<value>` lines) in /opt/vibe-tools/environment for the PATH/env
#      sub-issue (#74) to consume;
#   6. remove the downloaded archive.
#
# Like install-providers.sh, the WHOLE set is validated first — id shape,
# duplicate ids, a supported archive extension, and a URL+SHA for the build
# architecture — before anything is downloaded, so a bad set never leaves a
# half-installed image behind. `set -euo pipefail`; any failure aborts loudly
# with the offending tool id named (parent #5: no partial image).
#
# Install prefix, build architecture and env file are overridable via the
# environment so the tests can drive the real script against local fixtures
# with no network and no writes outside a temporary directory.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

# Fixed install prefix; bin/env values in the spec are relative to <prefix>/<id>
# so no spec can point PATH or an env var at an arbitrary host path.
TOOLS_PREFIX="${VIBE_TOOLS_PREFIX:-/opt/vibe-tools}"
ENV_FILE="${TOOLS_PREFIX}/environment"

# Abort loudly. Every message is prefixed so a build log makes the source clear.
fail() {
    echo "install-tools: $1" >&2
    exit 1
}

if [[ $# -lt 1 ]]; then
    fail "no spec file given: pass the container_tools spec JSON as the first argument."
fi
spec="$1"
[[ -f "${spec}" ]] || fail "spec file not found: ${spec}"

command -v jq >/dev/null 2>&1 || fail "jq is required but not installed."

# An empty or whitespace-only spec is an empty selection — the fleet default.
# The Containerfile already guards with `[ -s ]`, but tolerating it here too
# means a stray blank spec never fails a build over "nothing to do".
if [[ ! -s "${spec}" ]] || ! grep -q '[^[:space:]]' "${spec}"; then
    echo "install-tools: empty container_tools spec — nothing to install."
    exit 0
fi

jq -e 'type == "array"' "${spec}" >/dev/null 2>&1 ||
    fail "spec ${spec} is not a JSON array."

count="$(jq 'length' "${spec}")"
if [[ "${count}" -eq 0 ]]; then
    # An empty selection is the fleet default: install nothing, leave nothing.
    echo "install-tools: empty container_tools spec — nothing to install."
    exit 0
fi

# Build architecture, overridable for the tests. Matches the amd64/arm64
# convention container/tools.json already uses.
arch_from_uname() {
    case "$(uname -m)" in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) echo unknown ;;
    esac
}
ARCH="${VIBE_BUILD_ARCH:-$(arch_from_uname)}"

# The archive family for a URL, or empty for an unsupported extension.
archive_kind() {
    case "$1" in
    *.tar.gz | *.tgz) echo targz ;;
    *.tar.xz) echo tarxz ;;
    *.zip) echo zip ;;
    *) echo "" ;;
    esac
}

# The arch-specific value of a per-architecture object field, then noarch.
resolved_field() { # <index> <field>
    jq -r --argjson idx "$1" --arg a "${ARCH}" --arg field "$2" \
        '.[$idx][$field] | (.[$a] // .noarch // "")' "${spec}"
}

# ---------------------------------------------------------------------------
# Validate the whole set before installing anything.
# ---------------------------------------------------------------------------
ids=()
urls=()
shas=()
kinds=()
strips=()
seen=" "

for ((i = 0; i < count; i++)); do
    id="$(jq -r --argjson idx "${i}" '.[$idx].id // ""' "${spec}")"
    if [[ ! "${id}" =~ ^[a-z][a-z0-9-]*$ ]]; then
        fail "invalid tool id \"${id}\" at entry ${i}: a tool id is lower-case letters, digits and hyphens."
    fi
    if [[ "${seen}" == *" ${id} "* ]]; then
        fail "duplicate tool id \"${id}\"."
    fi
    seen="${seen}${id} "

    url="$(resolved_field "${i}" url)"
    sha="$(resolved_field "${i}" sha256)"
    [[ -n "${url}" ]] ||
        fail "tool \"${id}\" has no url for architecture ${ARCH} (or noarch)."
    [[ -n "${sha}" ]] ||
        fail "tool \"${id}\" has no sha256 for architecture ${ARCH} (or noarch)."

    kind="$(archive_kind "${url}")"
    [[ -n "${kind}" ]] ||
        fail "tool \"${id}\" has an unsupported archive extension in URL: ${url} (supported: .tar.gz, .tar.xz, .zip)."

    strip="$(jq -r --argjson idx "${i}" '.[$idx].stripComponents // 0' "${spec}")"
    [[ "${strip}" =~ ^[0-9]+$ ]] ||
        fail "tool \"${id}\" has a non-integer stripComponents: ${strip}."

    ids+=("${id}")
    urls+=("${url}")
    shas+=("${sha}")
    kinds+=("${kind}")
    strips+=("${strip}")
done

# ---------------------------------------------------------------------------
# Install each validated entry, in order.
# ---------------------------------------------------------------------------

# Extract a .zip into <dest>, descending <strip> single-directory levels first
# (unzip has no --strip-components). Portable to bash 3.2 (no mapfile).
extract_zip() { # <archive> <dest> <strip>
    local archive="$1" dest="$2" strip="$3" stage src n j
    stage="$(mktemp -d)"
    unzip -q "${archive}" -d "${stage}" || {
        rm -rf "${stage}"
        return 1
    }
    src="${stage}"
    for ((j = 0; j < strip; j++)); do
        n="$(find "${src}" -mindepth 1 -maxdepth 1 | wc -l)"
        if [[ "${n}" -ne 1 ]]; then
            rm -rf "${stage}"
            return 1
        fi
        src="$(find "${src}" -mindepth 1 -maxdepth 1)"
        [[ -d "${src}" ]] || {
            rm -rf "${stage}"
            return 1
        }
    done
    cp -a "${src}/." "${dest}/" || {
        rm -rf "${stage}"
        return 1
    }
    rm -rf "${stage}"
}

mkdir -p "${TOOLS_PREFIX}"
touch "${ENV_FILE}"

echo "install-tools: installing ${#ids[@]} tool(s) for ${ARCH}: ${ids[*]}"

for ((i = 0; i < ${#ids[@]}; i++)); do
    id="${ids[$i]}"
    url="${urls[$i]}"
    sha="${shas[$i]}"
    kind="${kinds[$i]}"
    strip="${strips[$i]}"
    dest="${TOOLS_PREFIX}/${id}"

    tmp="$(mktemp -d)"
    archive="${tmp}/archive"
    curl -fsSL "${url}" -o "${archive}" ||
        {
            rm -rf "${tmp}"
            fail "tool \"${id}\": download failed from ${url}."
        }

    if ! echo "${sha}  ${archive}" | sha256sum -c - >/dev/null 2>&1; then
        rm -rf "${tmp}"
        fail "tool \"${id}\": SHA-256 mismatch — refusing to install."
    fi

    mkdir -p "${dest}"
    case "${kind}" in
    targz) tar -xzf "${archive}" -C "${dest}" --strip-components="${strip}" --no-same-owner ;;
    tarxz) tar -xJf "${archive}" -C "${dest}" --strip-components="${strip}" --no-same-owner ;;
    zip) extract_zip "${archive}" "${dest}" "${strip}" ;;
    *) rm -rf "${tmp}" && fail "tool \"${id}\": unsupported archive kind ${kind}." ;;
    esac || {
        rm -rf "${tmp}"
        fail "tool \"${id}\": extraction failed."
    }

    rm -rf "${tmp}"

    # Record resolved bin dirs and env values for #74. bin/env values are
    # relative to <dest>; "" means <dest> itself.
    while IFS= read -r binpath; do
        [[ -n "${binpath}" ]] && echo "PATH=${binpath}" >>"${ENV_FILE}"
    done < <(jq -r --argjson idx "${i}" --arg p "${dest}" \
        '.[$idx].bin // [] | .[] | if . == "" then $p else $p + "/" + . end' "${spec}")

    while IFS= read -r kv; do
        [[ -n "${kv}" ]] && echo "${kv}" >>"${ENV_FILE}"
    done < <(jq -r --argjson idx "${i}" --arg p "${dest}" \
        '.[$idx].env // {} | to_entries[] | .key + "=" + (if .value == "" then $p else $p + "/" + .value end)' "${spec}")

    echo "install-tools: installed ${id} -> ${dest}"
done

echo "install-tools: installed ${#ids[@]} tool(s): ${ids[*]}"
