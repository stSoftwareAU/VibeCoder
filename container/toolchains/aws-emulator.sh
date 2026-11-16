#!/usr/bin/env bash
# AWS Emulator toolchain installation fragment (Issue #5109).
#
# The AWS Emulator is the local AWS service endpoint repository tests reach
# through /usr/local/bin/aws-emulator-run. This fragment only installs the
# binary onto the PATH — nothing starts it at build or run time; the
# Containerfile's agent-account smoke and the helper do that.
#
# Pins (version, packageRevision, per-architecture sha256) live in
# container/tools.json, read here with jq rather than restated. The versioned
# .deb is fetched from the flat LTS/ path; a `latest` URL is never used.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG; it must word-split, hence the deliberate lack of quotes.
#
# Fails loud: a missing pin, an unsupported architecture, a failed download, a
# checksum mismatch, a missing extracted binary, or a binary that reports the
# wrong version aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="aws-emulator"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
PACKAGES="https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS"

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
# shellcheck disable=SC2016  # jq filter literal; $id is a jq variable.
revision="$(manifest_field \
    '.toolchains[] | select(.id == $id) | .packageRevision' "the packageRevision pin")"

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

echo "[${TOOLCHAIN_ID}] Installing ${version}-${revision} for ${manifest_arch}"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

package="${workdir}/aws-emulator.deb"
staging="${workdir}/staging"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${package}" \
    "${PACKAGES}/aws-emulator_${version}-${revision}_${manifest_arch}.deb"
echo "${checksum}  ${package}" | sha256sum -c -

# The package installs only /opt/aws-emulator; extract rather than dpkg -i so
# no maintainer script runs and the package database is untouched.
mkdir -p "${staging}"
dpkg-deb -x "${package}" "${staging}"

binary="${staging}/opt/aws-emulator/bin/aws-emulator"
if [[ ! -f "${binary}" ]]; then
    echo "[${TOOLCHAIN_ID}] Package did not contain opt/aws-emulator/bin/aws-emulator" >&2
    exit 1
fi

install -d /opt/aws-emulator/bin
install -m 0755 "${binary}" /opt/aws-emulator/bin/aws-emulator
if [[ -f "${staging}/opt/aws-emulator/THIRD_PARTY_LICENSES" ]]; then
    install -m 0644 "${staging}/opt/aws-emulator/THIRD_PARTY_LICENSES" \
        /opt/aws-emulator/THIRD_PARTY_LICENSES
fi
ln -sf /opt/aws-emulator/bin/aws-emulator /usr/local/bin/aws-emulator

# Prove the installed binary runs in this image rather than assuming it does.
# --version prints a "Version: <version>" line and starts nothing.
installed="$(aws-emulator --version < /dev/null)"
case "${installed}" in
    *"Version: ${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed aws-emulator ${version}"
