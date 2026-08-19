#!/usr/bin/env bash
# Claude Code provider installation fragment (Issue #4067, parent #4060).
#
# The base image installs the worker runtime; the coding-agent provider is a
# separable layer, so each provider owns one fragment here and the build runs
# one fragment per id in the AGENT_PROVIDERS build set (Issue #4105). Adding
# Codex means adding container/providers/codex.sh — the base definition does
# not change.
#
# Pins live in container/tools.json (the single source of truth for every
# version the image installs), read here with jq rather than restated, so a
# version bump is a manifest edit. The download is verified against the pinned
# per-architecture SHA-256 before it is installed; nothing is piped into a
# shell and no floating "latest" is resolved.
#
# Fails loud (Issue #3234): an unknown architecture, a missing pin, a failed
# download, a checksum mismatch, or a binary that will not run aborts the
# build rather than producing an image without a working agent.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

PROVIDER_ID="claude"
MANIFEST="${AGENT_PROVIDER_MANIFEST:-/tmp/tools.json}"
RELEASES="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${PROVIDER_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

# Read the pinned version and per-architecture checksums. `jq -e` fails when
# the selection is absent or null, so an unpinned provider stops the build.
version="$(jq -er --arg id "${PROVIDER_ID}" \
    '.providers[] | select(.id == $id) | .version' "${MANIFEST}")"

arch="$(uname -m)"
case "${arch}" in
    x86_64)
        manifest_arch="amd64"
        platform="linux-x64"
        ;;
    aarch64)
        manifest_arch="arm64"
        platform="linux-arm64"
        ;;
    *)
        echo "[${PROVIDER_ID}] Unsupported build architecture: ${arch}" >&2
        exit 1
        ;;
esac

checksum="$(jq -er --arg id "${PROVIDER_ID}" --arg arch "${manifest_arch}" \
    '.providers[] | select(.id == $id) | .sha256[$arch]' "${MANIFEST}")"

binary="$(jq -er --arg id "${PROVIDER_ID}" \
    '.providers[] | select(.id == $id) | .binary' "${MANIFEST}")"

echo "[${PROVIDER_ID}] Installing ${binary} ${version} for ${platform}"

download="$(mktemp)"
trap 'rm -f "${download}"' EXIT

curl -fsSL -o "${download}" "${RELEASES}/${version}/${platform}/claude"
echo "${checksum}  ${download}" | sha256sum -c -
install -m 0755 "${download}" "/usr/local/bin/${binary}"

# Prove the installed binary runs in this image rather than assuming it does.
installed="$("/usr/local/bin/${binary}" --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${PROVIDER_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${PROVIDER_ID}] Installed ${installed}"
