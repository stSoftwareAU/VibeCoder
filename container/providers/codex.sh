#!/usr/bin/env bash
# OpenAI Codex CLI provider installation fragment (Issue #4106, parent #4102).
#
# The second provider the image can install, and the first test that the
# provider layer is genuinely separable (Issue #4067): this file plus a
# container/tools.json `providers` entry and a descriptor in
# worker/deno/lib/agent_provider.ts is the whole addition — the base
# Containerfile and container/install-providers.sh do not change.
#
# Pins live in container/tools.json (the single source of truth for every
# version the image installs), read here with jq rather than restated, so a
# version bump is a manifest edit. The release archive is verified against the
# pinned per-architecture SHA-256 before it is extracted; nothing is piped into
# a shell and no floating "latest" is resolved.
#
# Fails loud (Issue #3234): an unknown architecture, a missing pin, a failed
# download, a checksum mismatch, a missing binary inside the archive, or a
# binary that will not run aborts the build rather than producing an image
# whose agent is broken.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

PROVIDER_ID="codex"
MANIFEST="${AGENT_PROVIDER_MANIFEST:-/tmp/tools.json}"
RELEASES="https://github.com/openai/codex/releases/download"
# Codex tags its Rust workspace releases; the version itself comes from the
# manifest, so only the prefix is stated here.
TAG_PREFIX="rust-v"

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
        target="x86_64-unknown-linux-musl"
        ;;
    aarch64)
        manifest_arch="arm64"
        target="aarch64-unknown-linux-musl"
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

echo "[${PROVIDER_ID}] Installing ${binary} ${version} for ${target}"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

archive="${workdir}/codex.tar.gz"
curl -fsSL -o "${archive}" \
    "${RELEASES}/${TAG_PREFIX}${version}/${binary}-${target}.tar.gz"
echo "${checksum}  ${archive}" | sha256sum -c -

tar -xzf "${archive}" -C "${workdir}"
extracted="${workdir}/${binary}-${target}"
if [[ ! -f "${extracted}" ]]; then
    echo "[${PROVIDER_ID}] Archive does not contain ${binary}-${target}" >&2
    exit 1
fi
install -m 0755 "${extracted}" "/usr/local/bin/${binary}"

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
