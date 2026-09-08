#!/usr/bin/env bash
# Install a set of monitored-repository toolchains (Issue #1594, parent #1574).
#
# The fetch-verify-extract toolchains are a separable layer, exactly as the
# coding-agent providers are (container/install-providers.sh): each toolchain
# owns one container/toolchains/<id>.sh fragment, which reads its pinned
# version and per-architecture checksum from container/tools.json. The
# Containerfile only names the ids, so a toolchain costs it one word rather
# than two `ARG` lines and a `RUN` block — which is what keeps the
# comment-stripped definition under Apple container's size cap.
#
# Usage:  install-toolchains.sh "<id>[,<id>...]"
#
# Adding a toolchain is a new fragment, a container/tools.json entry carrying
# `fragment`, and the id added to one of the Containerfile's runs; this script
# does not change.
#
# Fails loud (Issue #3234) — an empty set, an empty entry, a malformed id, a
# duplicate id, an id the manifest does not pin, an id with no fragment, or a
# fragment that fails all abort the build. The whole set is validated before
# anything is installed, so a bad set never leaves a half-installed image
# behind, and nothing is silently skipped.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

# Where the fragments live. The Containerfile copies container/toolchains/ to
# the default path; the tests point this at a temporary directory.
TOOLCHAIN_DIR="${TOOLCHAIN_DIR:-/tmp/toolchains}"

# The pin manifest every fragment reads. Passed in by the Containerfile and
# inherited by each fragment, so no fragment restates a version.
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"

# Print the ids the fragment directory does offer, one per line.
available_ids() {
    local path found=0
    for path in "${TOOLCHAIN_DIR}"/*.sh; do
        [[ -f "${path}" ]] || continue
        basename "${path}" .sh
        found=1
    done
    if [[ "${found}" -eq 0 ]]; then
        echo "(none: ${TOOLCHAIN_DIR} holds no fragment)"
    fi
}

# Abort, naming the fragments that do exist so the operator sees the choices.
fail() {
    echo "$1" >&2
    echo "Supported toolchains:" >&2
    available_ids >&2
    exit 1
}

if [[ $# -lt 1 ]]; then
    fail "No toolchain set given: pass the toolchain ids as the first argument."
fi

requested="$1"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "Toolchain manifest ${MANIFEST} is missing — the pinned versions cannot be resolved." >&2
    exit 1
fi

# Split on commas. Empty entries survive the split (IFS is not whitespace), so
# "a,,b" is rejected below rather than silently collapsing.
ids=()
# `read` reports EOF on the trailing newline-free herestring; the empty-set
# check below is what fails loud, so the status itself is not the signal.
IFS=',' read -r -a ids <<< "${requested}" || true

if [[ ${#ids[@]} -eq 0 ]]; then
    fail "Empty toolchain set: the image would install no toolchain."
fi

# Validate the whole set first: ids, duplicates, a manifest pin and a fragment
# for each.
validated=()
seen=" "
for raw in ${ids[@]+"${ids[@]}"}; do
    # Trim surrounding whitespace so "a, b" is the same set as "a,b".
    id="${raw#"${raw%%[![:space:]]*}"}"
    id="${id%"${id##*[![:space:]]}"}"

    if [[ ! "${id}" =~ ^[a-z][a-z0-9-]*$ ]]; then
        fail "Unsupported toolchain \"${id}\": a toolchain id is lower-case letters, digits and hyphens."
    fi
    if [[ "${seen}" == *" ${id} "* ]]; then
        echo "Duplicate toolchain \"${id}\" in the requested set \"${requested}\"." >&2
        exit 1
    fi
    seen="${seen}${id} "

    if [[ ! -f "${TOOLCHAIN_DIR}/${id}.sh" ]]; then
        fail "Unsupported toolchain \"${id}\"."
    fi
    # A toolchain the manifest does not pin with a fragment would be installed
    # from nothing: the fragment resolves its version and checksum from here.
    if ! jq -e --arg id "${id}" \
        '.toolchains[] | select(.id == $id) | .fragment' \
        "${MANIFEST}" > /dev/null; then
        echo "Toolchain \"${id}\" is not pinned with a fragment in ${MANIFEST}." >&2
        exit 1
    fi
    validated+=("${id}")
done

if [[ ${#validated[@]} -eq 0 ]]; then
    fail "Empty toolchain set: the image would install no toolchain."
fi

echo "Installing toolchains: ${validated[*]}"

for id in "${validated[@]}"; do
    # Each fragment reads its own pins from the manifest this script was given;
    # it is inherited, not restated here.
    if ! TOOLCHAIN_MANIFEST="${MANIFEST}" bash "${TOOLCHAIN_DIR}/${id}.sh"; then
        echo "Toolchain \"${id}\" failed to install (${TOOLCHAIN_DIR}/${id}.sh)." >&2
        exit 1
    fi
done

echo "Installed toolchains: ${validated[*]}"
