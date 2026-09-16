#!/usr/bin/env bash
# Install the pinned, checksum-verified Claude CLI on a Linux host
# (Issue #2199).
#
# The documented host path used to be `curl -fsSL https://claude.ai/install.sh
# | bash` — unpinned and unverified. The container already installs this CLI
# the right way: container/providers/claude.sh reads the version, release
# source and per-architecture SHA-256 from container/tools.json and checks the
# download before installing it. This script reads the same pins from the same
# manifest, so the host and the image install the same verified binary, and
# raising the pin in one place raises both. Installs under ~/.local/bin (or
# $CLAUDE_INSTALL_DIR) as the invoking user, never as root.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${AGENT_PROVIDER_MANIFEST:-${script_dir}/../../container/tools.json}"
PROVIDER_ID="claude"

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "[install-claude] This installer is for Linux hosts; see https://docs.anthropic.com/en/docs/claude-code for macOS" >&2
    exit 1
fi
for tool in curl jq sha256sum install; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "[install-claude] ${tool} is required (apt-get install -y curl jq coreutils)" >&2
        exit 1
    fi
done
if [[ ! -f "${MANIFEST}" ]]; then
    echo "[install-claude] Manifest ${MANIFEST} is missing — run this from a VibeCoder checkout" >&2
    exit 1
fi

version="$(jq -er --arg id "${PROVIDER_ID}" '.providers[] | select(.id == $id) | .version' "${MANIFEST}")"
source_url="$(jq -er --arg id "${PROVIDER_ID}" '.providers[] | select(.id == $id) | .source' "${MANIFEST}")"
binary="$(jq -er --arg id "${PROVIDER_ID}" '.providers[] | select(.id == $id) | .binary' "${MANIFEST}")"

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
        echo "[install-claude] Unsupported architecture: ${arch}" >&2
        exit 1
        ;;
esac
checksum="$(jq -er --arg id "${PROVIDER_ID}" --arg arch "${manifest_arch}" \
    '.providers[] | select(.id == $id) | .sha256[$arch]' "${MANIFEST}")"

dest="${CLAUDE_INSTALL_DIR:-${HOME}/.local/bin}"
download="$(mktemp)"
trap 'rm -f "${download}"' EXIT

echo "[install-claude] Downloading ${binary} ${version} for ${platform}"
curl -fsSL -o "${download}" "${source_url}/${version}/${platform}/claude"
# Nothing is installed until the download matches the manifest's pin.
echo "${checksum}  ${download}" | sha256sum -c -

install -d "${dest}"
install -m 0755 "${download}" "${dest}/${binary}"
installed="$("${dest}/${binary}" --version </dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[install-claude] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac
echo "[install-claude] Installed ${installed} to ${dest} — add ${dest} to PATH"
