#!/usr/bin/env bash
# codespell toolchain installation fragment (Issue #1595, parent #1574).
#
# NEAT-AI-core's quality.sh skips its spelling check with a warning when the
# binary is absent, and NEAT-AI-scorer's scripts/spell-check.sh preflight
# exits 1 — so that gate fails outright in an image without codespell.
#
# Pins live in container/tools.json, read here with jq rather than restated:
# the codespell wheel from toolchains[], and the pip that installs it from
# tools[], the same artefact the semgrep layer uses. ${CURL_RETRY} and
# ${PIP_RETRY} are the build's shared retry policies, inherited from the
# Containerfile ARGs (Issue #1014); both must word-split, hence the deliberate
# lack of quotes.
#
# It follows the semgrep pattern (Issue #650): a pure-Python console script
# with no standalone binary, installed from its pinned wheel into its own
# virtualenv, because the system interpreter is PEP 668 externally managed and
# Debian ships no ensurepip. Both wheels are fetched by pinned
# files.pythonhosted.org URL and checksum-verified before pip sees them, so
# nothing is resolved from the index — codespell declares no required runtime
# dependencies (chardet and tomli are extras), which is what makes --no-deps a
# fully pinned install rather than a broken one.
#
# Fails loud (Issue #3234): a missing pin, a failed download, a checksum
# mismatch, or a binary that reports the wrong version aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="codespell"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
PACKAGES="https://files.pythonhosted.org/packages"
VENV="/opt/codespell"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

version="$(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .version' "${MANIFEST}")"
# Pure Python: one digest covers every architecture, so there is no uname case.
checksum="$(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .sha256.noarch' "${MANIFEST}")"

# The installer is an artefact in its own right, pinned beside semgrep's.
pip_version="$(jq -er '.tools[] | select(.name == "pip") | .version' "${MANIFEST}")"
pip_checksum="$(jq -er '.tools[] | select(.name == "pip") | .sha256.noarch' "${MANIFEST}")"

echo "[${TOOLCHAIN_ID}] Installing ${version} with pip ${pip_version}"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

# pip runs straight from its wheel as a zipapp: nothing installs pip into the
# image, and the system interpreter stays externally managed.
pip_wheel="${workdir}/pip-${pip_version}-py3-none-any.whl"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${pip_wheel}" \
    "${PACKAGES}/py3/p/pip/pip-${pip_version}-py3-none-any.whl"
echo "${pip_checksum}  ${pip_wheel}" | sha256sum -c -

# The local copy keeps the wheel's own file name: pip reads the compatibility
# tags out of it, and a downloaded-to `cs.whl` fails with "Invalid wheel
# filename".
wheel="${workdir}/codespell-${version}-py3-none-any.whl"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${wheel}" \
    "${PACKAGES}/py3/c/codespell/codespell-${version}-py3-none-any.whl"
echo "${checksum}  ${wheel}" | sha256sum -c -

python3 -m venv --without-pip "${VENV}"
# shellcheck disable=SC2086  # PIP_RETRY is a flag list that must word-split.
"${VENV}/bin/python" "${pip_wheel}/pip" install --no-deps \
    --only-binary=:all: --no-cache-dir -q ${PIP_RETRY} "${wheel}"
ln -sf "${VENV}/bin/codespell" /usr/local/bin/codespell
# Both unprivileged accounts run the monitored repositories' gates, so the
# whole tree has to be readable and traversable by them, not just by root.
chmod -R a+rX "${VENV}"

# Prove the installed console script runs on this image's interpreter rather
# than assuming the venv is usable.
installed="$(codespell --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed codespell ${version}"
