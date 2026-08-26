#!/usr/bin/env bash
# DeepSeek provider installation fragment (Issue #415, parent #396).
#
# DeepSeek serves an Anthropic-compatible API, so the CLI that drives it is the
# Claude Code CLI — the same upstream artefact container/providers/claude.sh
# installs. This fragment is deliberately a second installation of that
# artefact rather than a call into claude.sh, for two reasons:
#
#   * It installs the CLI under its own command name, read from the manifest's
#     `binary` field (`deepseek`). Both fragments run in an image built with
#     AGENT_PROVIDERS="claude,deepseek", so a shared command name would mean
#     one provider silently overwriting the other.
#   * Its version is pinned independently in container/tools.json. DeepSeek's
#     endpoint is a third party tracking Anthropic's API surface, so holding
#     `deepseek` on a known-good CLI version while `claude` moves ahead is the
#     point of the second pin — it is not duplication to be collapsed.
#
# Everything else follows claude.sh step for step: the pins live in
# container/tools.json (the single source of truth for every version the image
# installs) and are read here with jq rather than restated, the download is
# verified against the pinned per-architecture SHA-256 before it is installed,
# nothing is piped into a shell and no floating "latest" is resolved.
#
# Fails loud (Issue #3234): an unknown architecture, a missing pin, a failed
# download, a checksum mismatch, or a binary that will not run aborts the
# build rather than producing an image without a working agent.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

PROVIDER_ID="deepseek"
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

# The command name is the manifest's, not the release asset's: upstream ships
# the file as "claude", and installing it under that name here would clobber
# the claude provider in a "claude,deepseek" image.
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
