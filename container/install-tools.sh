#!/usr/bin/env bash
# Install the deployer-supplied build-time tools (Issue #70, parent #5).
#
# The Containerfile writes the validated `container_tools` array from the
# VIBE_CONTAINER_TOOLS build argument to a spec file and runs this script over
# it — one fixed-size build step whatever the tool count (Issue #71).
#
# Usage:  install-tools.sh <spec-file.json>
#
# STUB: the download → verify SHA-256 → extract implementation is Issue #70.
# Until it lands an empty selection is a no-op (the fleet default installs
# nothing and pays nothing), and a non-empty selection aborts the build loudly
# naming the tools it would have installed — never an image that silently
# lacks what the deployment asked for (DESIGN-PRINCIPLES.md, fail loud).
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "No spec file given: pass the container_tools spec file as the first argument." >&2
    exit 1
fi

spec="$1"

if [[ ! -f "${spec}" ]]; then
    echo "Container tool spec file not found: ${spec}" >&2
    exit 1
fi

# An absent, blank or empty-array spec means the deployment selected no extra
# tools. Nothing is downloaded and the build carries on unchanged.
contents="$(tr -d '[:space:]' < "${spec}")"
if [[ -z "${contents}" || "${contents}" == "[]" ]]; then
    echo "No deployer-supplied container tools requested; installing nothing."
    exit 0
fi

# Name the ids in the failure so the operator sees which selection was refused.
requested="$(
    grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' "${spec}" |
        sed 's/.*"\([^"]*\)"$/\1/' | tr '\n' ' '
)"

echo "Refusing to install deployer-supplied container tools: ${requested:-(unreadable spec)}" >&2
echo "container/install-tools.sh is not implemented yet (Issue #70); a build that" >&2
echo "selected tools must fail rather than produce an image without them." >&2
exit 1
