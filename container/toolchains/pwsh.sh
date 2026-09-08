#!/usr/bin/env bash
# PowerShell 7 toolchain installation fragment (Issue #1596, parent #1574).
#
# This repository ships .ps1 launchers (run.ps1, setup.ps1, loop.ps1) whose
# suites .github/workflows/validate-scripts.yml refuses to skip: without pwsh
# that job fails loud. The local gate excludes those suites (Issue #971), so
# pwsh is the one user-directed exception to "the gate runs it".
#
# Pins live in container/tools.json, read here with jq rather than restated.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG (Issue #1014); it must word-split, hence the deliberate
# lack of quotes.
#
# No apt step: the runtime libraries the .NET host needs (libicu76,
# libssl3t64, libstdc++6, libgssapi-krb5-2) are already in the digest-pinned
# base image, which is why the version assertion below is load-bearing — it
# proves the runtime starts rather than that the file exists.
#
# Fails loud (Issue #3234): an unknown architecture, a missing pin, a failed
# download, a checksum mismatch, or a binary that reports the wrong version
# aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="pwsh"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
RELEASES="https://github.com/PowerShell/PowerShell/releases/download"
# Microsoft's own layout for a tarball install: one major-version directory,
# so a 7.x bump replaces its contents rather than accumulating trees.
INSTALL_DIR="/opt/microsoft/powershell/7"

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

archive="${workdir}/powershell.tar.gz"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" \
    "${RELEASES}/v${version}/powershell-${version}-linux-${asset_arch}.tar.gz"
echo "${checksum}  ${archive}" | sha256sum -c -

# The tarball is the installation tree itself (no leading directory), so it is
# extracted straight into the install directory.
mkdir -p "${INSTALL_DIR}"
tar -xzf "${archive}" -C "${INSTALL_DIR}"
chmod a+x "${INSTALL_DIR}/pwsh"
# Every unprivileged account in the image runs the launcher suites, so the
# tree has to be readable and traversable by them, not just by root.
chmod -R a+rX "${INSTALL_DIR}"
ln -sf "${INSTALL_DIR}/pwsh" /usr/local/bin/pwsh

# Prove the .NET runtime starts in this image rather than assuming the base
# carries the libraries it needs.
installed="$(pwsh --version < /dev/null)"
case "${installed}" in
    *"PowerShell ${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected PowerShell ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed PowerShell ${version}"
