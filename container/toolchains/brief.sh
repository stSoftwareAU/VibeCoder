#!/usr/bin/env bash
# brief toolchain installation fragment (Issue #2601, parent #2581).
#
# git-pkgs/brief is trialled by the worker itself, so the image carries the
# pinned CLI and nothing else — no enrich configuration and no remote scans,
# because the trial uses the offline scan only. Like rtk it is a toolchain no
# monitored repository's quality gate invokes.
#
# Pins live in container/tools.json, read here with jq rather than restated.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG (Issue #1014); it must word-split, hence the deliberate
# lack of quotes.
#
# Layout: each release tarball carries a bare `brief` binary at its top level
# (beside LICENSE and README.md), installed straight onto the PATH. An archive
# whose layout differs aborts the build rather than installing something else.
#
# Fails loud: an unknown architecture, a missing pin, a failed download, a
# checksum mismatch, an archive without `brief` at its top level, or a binary
# that reports the wrong version aborts the build, naming brief.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="brief"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
RELEASES="https://github.com/git-pkgs/brief/releases/download"

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

# The release names each asset by Go's GOARCH, which is also the manifest key.
arch="$(uname -m)"
case "${arch}" in
    x86_64) manifest_arch="amd64" ;;
    aarch64) manifest_arch="arm64" ;;
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

archive="${workdir}/brief.tar.gz"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" \
    "${RELEASES}/v${version}/brief_${version}_linux_${manifest_arch}.tar.gz"
if ! echo "${checksum}  ${archive}" | sha256sum -c -; then
    echo "[${TOOLCHAIN_ID}] Checksum mismatch for brief ${version} (${manifest_arch}) — the download does not match the sha256 pin in ${MANIFEST}" >&2
    exit 1
fi

# --no-same-owner: the archive records its build host's uid, which does not
# exist in the image. The whole archive is unpacked rather than one named
# member, so a layout that changed upstream is reported by the check below
# rather than by tar's own "not found in archive".
tar -xzf "${archive}" --no-same-owner -C "${workdir}"
if [[ ! -f "${workdir}/brief" ]]; then
    echo "[${TOOLCHAIN_ID}] Archive does not carry brief at its top level" >&2
    exit 1
fi
install -m 0755 "${workdir}/brief" /usr/local/bin/brief

# Prove the installed binary runs in this image and is the pinned release.
# The version must appear as a whole token, as the start-up self-check
# requires, so a pin that is only a substring of the reported version fails.
installed="$(brief --version < /dev/null)"
if [[ " ${installed} " != *" ${version} "* ]]; then
    echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
    exit 1
fi

echo "[${TOOLCHAIN_ID}] Installed brief ${version}"
