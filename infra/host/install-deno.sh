#!/usr/bin/env bash
# Install a pinned, checksum-verified Deno on a Linux host (Issue #2199).
#
# The documented host path used to be `curl -fsSL https://deno.land/install.sh
# | sh`: whatever the URL served was executed, unpinned and unverified, while
# every toolchain the container fetches is checked with `sha256sum -c` against
# a pin in container/tools.json first. This script gives the host the same
# shape: the release asset denoland/deno publishes for this version and
# architecture is downloaded, its SHA-256 is compared with the pin below, and
# only then is the binary installed under ~/.deno/bin (or $DENO_INSTALL/bin).
#
# The version tracks the container image's Deno (container/Containerfile
# DENO_IMAGE, `bin-<version>`); worker/deno/tests/host_install_scripts_test.ts
# fails when the two drift. To raise it: change DENO_VERSION, then replace
# both checksums with the contents of
#   https://github.com/denoland/deno/releases/download/v<version>/deno-<arch>-unknown-linux-gnu.zip.sha256sum
set -euo pipefail

DENO_VERSION="2.9.8"
# SHA-256 of deno-<arch>-unknown-linux-gnu.zip, from the release's .sha256sum files.
DENO_SHA256_X86_64="e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609"
DENO_SHA256_AARCH64="d49596c20b9788cf8f5d8ddf644103d4bde56ed239753f0bdb92ba9361d51905"

# Overridable for a mirror; the checksum check is what authenticates the bytes.
DENO_RELEASE_BASE_URL="${DENO_RELEASE_BASE_URL:-https://github.com/denoland/deno/releases/download}"

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "[install-deno] This installer is for Linux hosts; on macOS use Homebrew (brew install deno)" >&2
    exit 1
fi
for tool in curl unzip sha256sum install; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "[install-deno] ${tool} is required (apt-get install -y curl unzip coreutils)" >&2
        exit 1
    fi
done

arch="$(uname -m)"
case "${arch}" in
    x86_64) checksum="${DENO_SHA256_X86_64}" ;;
    aarch64) checksum="${DENO_SHA256_AARCH64}" ;;
    *)
        echo "[install-deno] Unsupported architecture: ${arch}" >&2
        exit 1
        ;;
esac

asset="deno-${arch}-unknown-linux-gnu.zip"
url="${DENO_RELEASE_BASE_URL}/v${DENO_VERSION}/${asset}"
dest="${DENO_INSTALL:-${HOME}/.deno}/bin"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

echo "[install-deno] Downloading deno ${DENO_VERSION} for ${arch}"
curl -fsSL -o "${workdir}/${asset}" "${url}"
# Nothing from the archive is executed or installed until this passes.
echo "${checksum}  ${workdir}/${asset}" | sha256sum -c -
unzip -q -o "${workdir}/${asset}" -d "${workdir}"

install -d "${dest}"
install -m 0755 "${workdir}/deno" "${dest}/deno"
installed="$("${dest}/deno" --version </dev/null | head -n 1)"
case "${installed}" in
    *"deno ${DENO_VERSION}"*) ;;
    *)
        echo "[install-deno] Installed binary reports \"${installed}\", expected deno ${DENO_VERSION}" >&2
        exit 1
        ;;
esac
echo "[install-deno] Installed ${installed} to ${dest} — add ${dest} to PATH"
