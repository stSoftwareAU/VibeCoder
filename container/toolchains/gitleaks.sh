#!/usr/bin/env bash
# gitleaks toolchain installation fragment (Issue #1596, parent #1574).
#
# GRQ-AutoTrader and NEAT-AI-Explore both enforce a gitleaks secret scan in
# CI, so an agent working either repository can run the same scanner locally
# rather than meeting its findings only after the PR is open.
#
# Pins live in container/tools.json, read here with jq rather than restated.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG (Issue #1014); it must word-split, hence the deliberate
# lack of quotes.
#
# Fails loud (Issue #3234): an unknown architecture, a missing pin, a failed
# download, a checksum mismatch, or a binary that reports the wrong version
# aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="gitleaks"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
RELEASES="https://github.com/gitleaks/gitleaks/releases/download"

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

archive="${workdir}/gitleaks.tar.gz"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" \
    "${RELEASES}/v${version}/gitleaks_${version}_linux_${asset_arch}.tar.gz"
echo "${checksum}  ${archive}" | sha256sum -c -
# The archive also carries LICENSE and README.md; only the binary is wanted.
tar -xzf "${archive}" -C "${workdir}" gitleaks
install -m 0755 "${workdir}/gitleaks" /usr/local/bin/gitleaks

# Prove the installed binary runs in this image rather than assuming it does.
installed="$(gitleaks --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed gitleaks ${version}"
