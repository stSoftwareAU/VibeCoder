#!/usr/bin/env bash
# RTK toolchain installation fragment (Issue #2381, parent #2328).
#
# RTK is trialled by the worker itself, so the image carries the stable CLI.
# Like codegraph it is a toolchain no monitored repository's quality gate
# invokes.
#
# Pins live in container/tools.json, read here with jq rather than restated.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG (Issue #1014); it must word-split, hence the deliberate
# lack of quotes.
#
# Layout: unlike codegraph's bundle each release tarball carries a bare `rtk`
# binary at its top level, installed straight onto the PATH. An archive whose
# layout differs aborts the build rather than installing something else.
#
# The release names each asset by target triple — musl on x86_64, gnu on
# aarch64 — so the asset architecture and the manifest key are resolved
# separately.
#
# Fails loud: an unknown architecture, a missing pin, a failed
# download, a checksum mismatch, an archive without `rtk` at its top level, or
# a binary that reports the wrong version aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="rtk"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
RELEASES="https://github.com/rtk-ai/rtk/releases/download"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

# jq -er exits non-zero on an absent or null field but says nothing useful, so
# a dropped pin would abort the build with a bare exit code. Name what is
# missing instead.
manifest_field() {
    local filter="$1" description="$2" value
    if ! value="$(jq -er --arg id "${TOOLCHAIN_ID}" \
        --arg arch "${manifest_arch:-}" "${filter}" "${MANIFEST}")"; then
        echo "[${TOOLCHAIN_ID}] ${description} is missing from ${MANIFEST}" >&2
        exit 1
    fi
    printf '%s\n' "${value}"
}

# shellcheck disable=SC2016  # jq filter literal; $id is a jq variable.
version="$(manifest_field \
    '.toolchains[] | select(.id == $id) | .version' "the version pin")"

arch="$(uname -m)"
case "${arch}" in
    x86_64) manifest_arch="amd64"; asset_target="x86_64-unknown-linux-musl" ;;
    aarch64) manifest_arch="arm64"; asset_target="aarch64-unknown-linux-gnu" ;;
    *)
        echo "[${TOOLCHAIN_ID}] Unsupported build architecture: ${arch}" >&2
        exit 1
        ;;
esac

# shellcheck disable=SC2016  # jq filter literal; $id/$arch are jq variables.
checksum="$(manifest_field \
    '.toolchains[] | select(.id == $id) | .sha256[$arch]' \
    "the sha256 pin for ${manifest_arch}")"

echo "[${TOOLCHAIN_ID}] Installing ${version} for ${manifest_arch}"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

archive="${workdir}/rtk.tar.gz"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" \
    "${RELEASES}/v${version}/rtk-${asset_target}.tar.gz"
echo "${checksum}  ${archive}" | sha256sum -c -

# --no-same-owner: the archive records its build host's uid, which does not
# exist in the image. The whole archive is unpacked rather than one named
# member, so a layout that changed upstream is reported by the check below
# rather than by tar's own "not found in archive".
tar -xzf "${archive}" --no-same-owner -C "${workdir}"
if [[ ! -f "${workdir}/rtk" ]]; then
    echo "[${TOOLCHAIN_ID}] Archive does not carry rtk at its top level" >&2
    exit 1
fi
install -m 0755 "${workdir}/rtk" /usr/local/bin/rtk

# Prove the installed binary runs in this image rather than assuming it does.
installed="$(rtk --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed rtk ${version}"
