#!/usr/bin/env bash
# cargo-mutants toolchain installation fragment (Issue #3393).
#
# Backs the diff-scoped mutation check: Rust target repositories run
# `cargo mutants --in-diff`, so the binary must be in the image.
#
# On x86_64 the upstream release tarball is downloaded and verified against the
# checksum pinned in container/tools.json. Upstream publishes no arm64 Linux
# asset, so on aarch64 the pinned version is built from source with
# `cargo install --locked`, which needs the Rust toolchain fragment (and a C
# linker) to have run first — the Containerfile installs this id in the same
# run as `rust`, after it. crates.io verifies the crate checksum itself, and
# there is no pinned digest for a source build, hence none for arm64.
#
# Pins live in container/tools.json, read here with jq rather than restated.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG (Issue #1014); it must word-split, hence the deliberate
# lack of quotes.
#
# Fails loud (Issue #3234): an unknown architecture, a missing pin, a missing
# cargo or linker, a failed download or build, a checksum mismatch, or a binary
# that reports the wrong version aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="cargo-mutants"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
RELEASES="https://github.com/sourcefrog/cargo-mutants/releases/download"

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

echo "[${TOOLCHAIN_ID}] Installing ${version} for ${manifest_arch}"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

if [[ "${manifest_arch}" == "amd64" ]]; then
    checksum="$(jq -er --arg id "${TOOLCHAIN_ID}" --arg arch "${manifest_arch}" \
        '.toolchains[] | select(.id == $id) | .sha256[$arch]' "${MANIFEST}")"
    archive="${workdir}/cargo-mutants.tar.gz"
    # shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
    curl -fsSL ${CURL_RETRY} -o "${archive}" \
        "${RELEASES}/v${version}/cargo-mutants-x86_64-unknown-linux-gnu.tar.gz"
    echo "${checksum}  ${archive}" | sha256sum -c -
    mkdir "${workdir}/extract"
    tar -xzf "${archive}" -C "${workdir}/extract"
    install -m 0755 "${workdir}/extract/cargo-mutants" /usr/local/bin/cargo-mutants
else
    for needed in cargo cc; do
        if ! command -v "${needed}" > /dev/null 2>&1; then
            echo "[${TOOLCHAIN_ID}] ${needed} is not available: the arm64 build compiles from source, so the rust toolchain (and a C linker) must be installed first" >&2
            exit 1
        fi
    done
    CARGO_HOME="${workdir}/cargo-home" \
        cargo install --locked cargo-mutants --version "${version}" --root /usr/local
fi

# Prove the installed binary runs in this image rather than assuming it does.
installed="$(cargo-mutants mutants --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed cargo-mutants ${version}"
