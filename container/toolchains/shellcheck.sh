#!/usr/bin/env bash
# ShellCheck toolchain installation fragment (Issue #1594, parent #1574).
#
# Moved verbatim out of container/Containerfile: every fleet repo with a
# committed shell gate hard-fails without this binary, and the Containerfile
# has a byte cap to respect (worker/deno/lib/containerfile_strip.ts), so the
# fetch-verify-extract body lives here and the definition only names the id.
#
# Pins live in container/tools.json (the single source of truth for every
# version the image installs), read here with jq rather than restated, so a
# version bump is a manifest edit. ${CURL_RETRY} is the build's shared retry
# policy, inherited from the Containerfile ARG (Issue #1014); it must
# word-split, hence the deliberate lack of quotes.
#
# Fails loud (Issue #3234): an unknown architecture, a missing pin, a failed
# download, a checksum mismatch, or a binary that reports the wrong version
# aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="shellcheck"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
RELEASES="https://github.com/koalaman/shellcheck/releases/download"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

# `jq -e` fails when the selection is absent or null, so an unpinned toolchain
# stops the build rather than installing something nothing recorded.
version="$(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .version' "${MANIFEST}")"

arch="$(uname -m)"
case "${arch}" in
    x86_64) manifest_arch="amd64" ;;
    aarch64) manifest_arch="arm64" ;;
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

archive="${workdir}/shellcheck.tar.xz"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" \
    "${RELEASES}/v${version}/shellcheck-v${version}.linux.${arch}.tar.xz"
echo "${checksum}  ${archive}" | sha256sum -c -
tar -xJf "${archive}" -C "${workdir}"
install -m 0755 "${workdir}/shellcheck-v${version}/shellcheck" \
    /usr/local/bin/shellcheck

# Prove the installed binary runs in this image rather than assuming it does.
installed="$(shellcheck --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed shellcheck ${version}"
