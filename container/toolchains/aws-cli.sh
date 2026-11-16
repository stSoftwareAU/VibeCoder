#!/usr/bin/env bash
# AWS CLI v2 toolchain installation fragment (Issue #5109).
#
# The AWS Emulator's helper (aws-emulator-run) and the repositories' tests
# drive it with the `aws` command, so the CLI is pinned and checksum-verified
# like every other tool rather than taken from whatever the base image ships.
#
# Pins live in container/tools.json, read here with jq rather than restated.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG; it must word-split, hence the deliberate lack of quotes.
#
# Fails loud: a missing pin, an unsupported architecture, a failed download, a
# checksum mismatch, a missing installer, or a CLI that reports the wrong
# version aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="aws-cli"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
DOWNLOADS="https://awscli.amazonaws.com"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

# jq -er exits non-zero on an absent or null field but says nothing useful, so
# name what is missing instead.
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

# The download names the architecture x86_64/aarch64, while the manifest keys
# its checksums amd64/arm64, so the two are resolved separately.
arch="$(uname -m)"
case "${arch}" in
    x86_64) manifest_arch="amd64"; cli_arch="x86_64" ;;
    aarch64) manifest_arch="arm64"; cli_arch="aarch64" ;;
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

archive="${workdir}/awscli.zip"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" \
    "${DOWNLOADS}/awscli-exe-linux-${cli_arch}-${version}.zip"
echo "${checksum}  ${archive}" | sha256sum -c -

unzip -q "${archive}" -d "${workdir}"
if [[ ! -f "${workdir}/aws/install" ]]; then
    echo "[${TOOLCHAIN_ID}] Archive did not contain aws/install" >&2
    exit 1
fi
bash "${workdir}/aws/install" --install-dir /usr/local/aws-cli --bin-dir /usr/local/bin

# Prove the installed CLI runs in this image rather than assuming it does.
installed="$(aws --version < /dev/null 2>&1)"
case "${installed}" in
    "aws-cli/${version} "*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed CLI reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed aws-cli ${version}"
