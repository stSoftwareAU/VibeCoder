#!/usr/bin/env bash
# cargo-deny toolchain installation fragment (Issue #1594, parent #1574).
#
# Moved verbatim out of container/Containerfile, which has a byte cap to
# respect (worker/deno/lib/containerfile_strip.ts): `cargo deny check` is not
# optional in the fleet's Rust gates — private-repo-16 exits non-zero when the
# binary is absent and private-repo-17 runs it unguarded. The linux release is
# a static musl build, so it runs on the glibc base image.
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

TOOLCHAIN_ID="cargo-deny"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
RELEASES="https://github.com/EmbarkStudios/cargo-deny/releases/download"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

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

release="cargo-deny-${version}-${arch}-unknown-linux-musl"
archive="${workdir}/cargo-deny.tar.gz"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" "${RELEASES}/${version}/${release}.tar.gz"
echo "${checksum}  ${archive}" | sha256sum -c -
tar -xzf "${archive}" -C "${workdir}"
install -m 0755 "${workdir}/${release}/cargo-deny" /usr/local/bin/cargo-deny

# Prove the installed binary runs in this image rather than assuming it does.
installed="$(cargo-deny --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed cargo-deny ${version}"
