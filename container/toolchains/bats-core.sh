#!/usr/bin/env bash
# bats-core toolchain installation fragment (Issue #1595, parent #1574).
#
# NEAT-AI-core and NEAT-AI-scorer both run BATS suites from their own
# quality.sh. Without the runner in the image each gate printed "bats not
# installed — skipping" and the suites ran only in CI, where both repositories
# apt-install it — NEAT-AI-core PR 597 skipped all 394 tests locally.
#
# Pins live in container/tools.json, read here with jq rather than restated.
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG (Issue #1014); it must word-split, hence the deliberate
# lack of quotes.
#
# bats-core publishes no release asset, so the pinned artefact is the tag's
# GitHub source tarball and the install is the bundled install.sh — pure
# shell, which is why one noarch checksum covers both architectures.
#
# Fails loud (Issue #3234): a missing pin, a failed download, a checksum
# mismatch, or a runner that reports the wrong version aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="bats-core"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
ARCHIVES="https://github.com/bats-core/bats-core/archive/refs/tags"
# The bundled install.sh takes a prefix and lays out bin/, libexec/, lib/ and
# share/man/ beneath it, so the runner resolves from the image's own PATH.
PREFIX="/usr/local"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

version="$(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .version' "${MANIFEST}")"
# Pure shell: one digest covers every architecture, so there is no uname case
# here — an architecture the image cannot run would fail on the base image
# long before this fragment.
checksum="$(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .sha256.noarch' "${MANIFEST}")"

echo "[${TOOLCHAIN_ID}] Installing ${version}"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

archive="${workdir}/bats-core.tar.gz"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" "${ARCHIVES}/v${version}.tar.gz"
echo "${checksum}  ${archive}" | sha256sum -c -

# The source tarball carries one leading bats-core-<version> directory.
tar -xzf "${archive}" -C "${workdir}" --strip-components=1 --no-same-owner
bash "${workdir}/install.sh" "${PREFIX}"

# Prove the installed runner runs in this image rather than assuming it does.
installed="$(bats --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed runner reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed bats ${version}"
