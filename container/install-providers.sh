#!/usr/bin/env bash
# Install a set of coding-agent providers (Issue #4105, parent #4102).
#
# The provider layer is separable (Issue #4067): each provider owns one
# container/providers/<id>.sh fragment. Quorum mode needs several agent CLIs
# resident in one worker container, so the build selects a *set* rather than
# exactly one id — this script takes that set and runs one fragment per
# requested id, in the order requested. It names no provider itself.
#
# Usage:  install-providers.sh "<id>[,<id>...]"
#
# Adding a fourth provider is a new fragment plus a container/tools.json entry:
# neither this script nor the Containerfile changes.
#
# Fails loud (Issue #3234) — an empty set, an empty entry, a malformed id, a
# duplicate id, an id with no fragment, or a fragment that fails all abort the
# build. The whole set is validated before anything is installed, so a bad set
# never leaves a half-installed image behind, and nothing is silently skipped.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

# Where the fragments live. The Containerfile copies container/providers/ to
# the default path; the tests point this at a temporary directory.
PROVIDER_DIR="${PROVIDER_DIR:-/tmp/providers}"

# Print the ids the fragment directory does offer, one per line.
available_ids() {
    local path found=0
    for path in "${PROVIDER_DIR}"/*.sh; do
        [[ -f "${path}" ]] || continue
        basename "${path}" .sh
        found=1
    done
    if [[ "${found}" -eq 0 ]]; then
        echo "(none: ${PROVIDER_DIR} holds no fragment)"
    fi
}

# Abort, naming the fragments that do exist so the operator sees the choices.
fail() {
    echo "$1" >&2
    echo "Supported providers:" >&2
    available_ids >&2
    exit 1
}

if [[ $# -lt 1 ]]; then
    fail "No provider set given: pass AGENT_PROVIDERS as the first argument."
fi

requested="$1"

# Split on commas. Empty entries survive the split (IFS is not whitespace), so
# "a,,b" is rejected below rather than silently collapsing.
ids=()
# `read` reports EOF on the trailing newline-free herestring; the empty-set
# check below is what fails loud, so the status itself is not the signal.
IFS=',' read -r -a ids <<< "${requested}" || true

if [[ ${#ids[@]} -eq 0 ]]; then
    fail "Empty AGENT_PROVIDERS: the image would install no coding agent."
fi

# Validate the whole set first: ids, duplicates, and a fragment for each.
validated=()
seen=" "
for raw in ${ids[@]+"${ids[@]}"}; do
    # Trim surrounding whitespace so "a, b" is the same set as "a,b".
    id="${raw#"${raw%%[![:space:]]*}"}"
    id="${id%"${id##*[![:space:]]}"}"

    if [[ ! "${id}" =~ ^[a-z][a-z0-9-]*$ ]]; then
        fail "Unsupported coding-agent provider \"${id}\": a provider id is lower-case letters, digits and hyphens."
    fi
    if [[ "${seen}" == *" ${id} "* ]]; then
        echo "Duplicate coding-agent provider \"${id}\" in AGENT_PROVIDERS=\"${requested}\"." >&2
        exit 1
    fi
    seen="${seen}${id} "

    if [[ ! -f "${PROVIDER_DIR}/${id}.sh" ]]; then
        fail "Unsupported coding-agent provider \"${id}\"."
    fi
    validated+=("${id}")
done

if [[ ${#validated[@]} -eq 0 ]]; then
    fail "Empty AGENT_PROVIDERS: the image would install no coding agent."
fi

echo "Installing coding-agent providers: ${validated[*]}"

for id in "${validated[@]}"; do
    # Each fragment reads its own pins from the manifest the Containerfile
    # passes in AGENT_PROVIDER_MANIFEST; it is inherited, not restated here.
    if ! bash "${PROVIDER_DIR}/${id}.sh"; then
        echo "Coding-agent provider \"${id}\" failed to install (${PROVIDER_DIR}/${id}.sh)." >&2
        exit 1
    fi
done

echo "Installed coding-agent providers: ${validated[*]}"
