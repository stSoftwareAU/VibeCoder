#!/usr/bin/env bash
# Rust toolchain installation fragment (Issue #1594, parent #1574).
#
# Moved verbatim out of container/Containerfile, which has a byte cap to
# respect (worker/deno/lib/containerfile_strip.ts). The standalone rust-lang
# distribution is installed into /usr/local rather than via rustup, so there is
# no per-user toolchain directory and nothing to update at run time. The
# combined rust-<version> package carries only rustc/cargo/rust-std (rust-docs
# is dropped to keep the layer smaller); rustfmt and clippy are separate
# component packages, each with its own pinned checksum — hence the rustfmt_/
# clippy_ keys in the manifest's sha256 map.
#
# Pins live in container/tools.json, read here with jq rather than restated.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG (Issue #1014); it must word-split, hence the deliberate
# lack of quotes.
#
# Fails loud (Issue #3234): an unknown architecture, a missing pin, a failed
# download, a checksum mismatch, or a command that reports the wrong version
# aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="rust"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
DIST="https://static.rust-lang.org/dist"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

version="$(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .version' "${MANIFEST}")"

arch="$(uname -m)"
case "${arch}" in
    x86_64)
        manifest_arch="amd64"
        target="x86_64-unknown-linux-gnu"
        ;;
    aarch64)
        manifest_arch="arm64"
        target="aarch64-unknown-linux-gnu"
        ;;
    *)
        echo "[${TOOLCHAIN_ID}] Unsupported build architecture: ${arch}" >&2
        exit 1
        ;;
esac

# One pinned checksum per component package, keyed as the manifest records it.
checksum_for() {
    jq -er --arg id "${TOOLCHAIN_ID}" --arg key "$1" \
        '.toolchains[] | select(.id == $id) | .sha256[$key]' "${MANIFEST}"
}

echo "[${TOOLCHAIN_ID}] Installing ${version} for ${manifest_arch}"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

# Fetch one component package, verify it against its pin, and install it into
# /usr/local with the distribution's own installer.
install_rust_pkg() {
    local component="$1" checksum="$2"
    shift 2
    local dir="${component}-${version}-${target}"
    local archive="${workdir}/${dir}.tar.gz"
    # shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
    curl -fsSL ${CURL_RETRY} -o "${archive}" "${DIST}/${dir}.tar.gz"
    echo "${checksum}  ${archive}" | sha256sum -c -
    tar -xzf "${archive}" -C "${workdir}"
    "${workdir}/${dir}/install.sh" --prefix=/usr/local "$@"
    rm -rf "${archive}" "${workdir:?}/${dir}"
}

install_rust_pkg rust "$(checksum_for "${manifest_arch}")" --without=rust-docs
install_rust_pkg rustfmt "$(checksum_for "rustfmt_${manifest_arch}")"
install_rust_pkg clippy "$(checksum_for "clippy_${manifest_arch}")"

# Prove every installed command runs in this image rather than assuming it
# does; cargo is the version the manifest reports the toolchain by.
installed="$(cargo --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed cargo reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac
rustc --version
cargo-clippy --version
rustfmt --version

echo "[${TOOLCHAIN_ID}] Installed ${installed}"
