#!/usr/bin/env bash
# CodeGraph toolchain installation fragment (Issue #2153, parent #2145).
#
# CodeGraph is trialled as a second repo-context candidate, so the worker's
# own runs need the indexer in the image. It is the one toolchain here that no
# monitored repository's quality gate invokes.
#
# Pins live in container/tools.json, read here with jq rather than restated.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG (Issue #1014); it must word-split, hence the deliberate
# lack of quotes.
#
# Layout: the release tarball is not a bare binary. It extracts a
# codegraph-linux-<asset arch>/ bundle carrying bin/codegraph (a POSIX shell
# launcher), its own node runtime and lib/, so the whole bundle is installed
# under /opt/codegraph and /usr/local/bin/codegraph is a symlink at the
# launcher — which resolves symlinks itself to find its bundle directory.
#
# Fails loud (Issue #3234): an unknown architecture, a missing pin, a failed
# download, a checksum mismatch, or a binary that reports the wrong version
# aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="codegraph"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
RELEASES="https://github.com/colbymchenry/codegraph/releases/download"
BUNDLE="/opt/codegraph"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

version="$(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .version' "${MANIFEST}")"

# The release names the 64-bit Intel asset x64, not amd64, so the asset
# architecture and the manifest key are resolved separately.
arch="$(uname -m)"
case "${arch}" in
    x86_64) manifest_arch="amd64"; asset_arch="x64" ;;
    aarch64) manifest_arch="arm64"; asset_arch="arm64" ;;
    *)
        echo "[${TOOLCHAIN_ID}] Unsupported build architecture: ${arch}" >&2
        exit 1
        ;;
esac

checksum="$(jq -er --arg id "${TOOLCHAIN_ID}" --arg arch "${manifest_arch}" \
    '.toolchains[] | select(.id == $id) | .sha256[$arch]' "${MANIFEST}")"

echo "[${TOOLCHAIN_ID}] Installing ${version} for ${manifest_arch}"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

archive="${workdir}/codegraph.tar.gz"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" \
    "${RELEASES}/v${version}/codegraph-linux-${asset_arch}.tar.gz"
echo "${checksum}  ${archive}" | sha256sum -c -

# --no-same-owner: the archive records its build host's uid, which does not
# exist in the image; the bundle belongs to root like every other install here.
tar -xzf "${archive}" --no-same-owner -C "${workdir}"
extracted="${workdir}/codegraph-linux-${asset_arch}"
if [[ ! -x "${extracted}/bin/codegraph" || ! -x "${extracted}/node" ]]; then
    echo "[${TOOLCHAIN_ID}] Archive does not carry the expected bundle layout (bin/codegraph plus its own node) under ${extracted##*/}" >&2
    exit 1
fi

rm -rf "${BUNDLE}"
mv "${extracted}" "${BUNDLE}"
# The launcher and the bundled runtime must be executable for every user; the
# worker runs as the non-root vibe user.
chmod -R a+rX "${BUNDLE}"
chmod 0755 "${BUNDLE}/bin/codegraph" "${BUNDLE}/node"
ln -sf "${BUNDLE}/bin/codegraph" /usr/local/bin/codegraph

# Prove the installed launcher runs in this image rather than assuming it does.
installed="$(codegraph --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed codegraph ${version}"
