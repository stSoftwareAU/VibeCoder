#!/usr/bin/env bash
# PyYAML toolchain installation fragment (Issue #1628, parent #1574).
#
# NEAT-AI-core's workflow-assertion BATS suites (actionlint_workflow.bats,
# ci_job_permissions.bats, workflow_sha_pinning.bats and others) parse
# workflow YAML with an inline `python3` script that imports PyYAML. With
# bats-core baked into the image (Issue #1595) those suites execute here
# rather than skipping, and 31 of them failed with
# "ModuleNotFoundError: No module named 'yaml'".
#
# Pins live in container/tools.json, read here with jq rather than restated:
# the PyYAML wheel from toolchains[], and the pip that installs it from
# tools[], the same artefact the semgrep and codespell layers use.
# ${CURL_RETRY} and ${PIP_RETRY} are the build's shared retry policies,
# inherited from the Containerfile ARGs (Issue #1014); both must word-split,
# hence the deliberate lack of quotes.
#
# This is a *library*, not a console script, so the codespell pattern does not
# transfer: the consumer is the image's own `python3 -c "import yaml"`, which
# a /opt/<tool> virtualenv would never satisfy. The wheel is installed with
# `pip --target` into the interpreter's own purelib directory — the admin
# install location already on its sys.path — which is also what keeps the
# PEP 668 externally-managed system environment untouched, because --target
# installs beside it rather than into it. Virtualenvs built later (semgrep's,
# codespell's) do not inherit that directory, so nothing here shadows their
# pinned dependencies.
#
# PyYAML ships a C extension, so the wheel is per-architecture and its name
# carries the interpreter tag. Both are derived from the running interpreter
# rather than restated: a base image whose python3 moves to another minor
# version 404s the fetch instead of installing bytes this manifest never
# pinned.
#
# Fails loud (Issue #3234): a missing pin, an unsupported architecture, a
# failed download, a checksum mismatch, a module that will not import, or a
# module that reports the wrong version aborts the build.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="pyyaml"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
PACKAGES="https://files.pythonhosted.org/packages"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

version="$(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .version' "${MANIFEST}")"

# The compiled extension makes the wheel architecture-specific, so the digest
# is looked up per architecture — as the binary toolchains do.
case "$(uname -m)" in
    x86_64) arch="x86_64"; digest_key="amd64" ;;
    aarch64) arch="aarch64"; digest_key="arm64" ;;
    *)
        echo "[${TOOLCHAIN_ID}] Unsupported build architecture: $(uname -m)" >&2
        exit 1
        ;;
esac
checksum="$(jq -er --arg id "${TOOLCHAIN_ID}" --arg key "${digest_key}" \
    '.toolchains[] | select(.id == $id) | .sha256[$key]' "${MANIFEST}")"

# The modules the manifest says this toolchain makes importable, and the one
# whose reported version must equal the pin. Read from the manifest so the
# fragment holds no second copy of either.
mapfile -t modules < <(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .modules[]' "${MANIFEST}")
version_module="$(jq -er --arg id "${TOOLCHAIN_ID}" \
    '.toolchains[] | select(.id == $id) | .versionModule' "${MANIFEST}")"

# Every name is interpolated into a `python3 -c` below, so a doctored manifest
# must not be able to smuggle anything but an importable module name through.
for module in "${modules[@]}" "${version_module}"; do
    if [[ ! "${module}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        echo "[${TOOLCHAIN_ID}] \"${module}\" is not a module name python3 can import" >&2
        exit 1
    fi
done

# The installer is an artefact in its own right, pinned beside semgrep's.
pip_version="$(jq -er '.tools[] | select(.name == "pip") | .version' "${MANIFEST}")"
pip_checksum="$(jq -er '.tools[] | select(.name == "pip") | .sha256.noarch' "${MANIFEST}")"

# Both come from the interpreter that will import the module, never from a
# value written down here: the tag names the wheel, and purelib is the
# directory that interpreter already searches.
tag="cp$(python3 -c 'import sys; print(f"{sys.version_info[0]}{sys.version_info[1]}")')"
site="$(python3 -c 'import sysconfig; print(sysconfig.get_path("purelib"))')"

echo "[${TOOLCHAIN_ID}] Installing ${version} for ${tag} into ${site} with pip ${pip_version}"

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
# tags out of it, and a downloaded-to `py.whl` fails with "Invalid wheel
# filename". files.pythonhosted.org serves the same file under the wheel's
# interpreter tag as the path segment, exactly as the semgrep layer fetches
# its own.
name="${TOOLCHAIN_ID}-${version}-${tag}-${tag}-manylinux2014_${arch}.manylinux_2_17_${arch}.manylinux_2_28_${arch}.whl"
wheel="${workdir}/${name}"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${wheel}" "${PACKAGES}/${tag}/p/${TOOLCHAIN_ID}/${name}"
echo "${checksum}  ${wheel}" | sha256sum -c -

# --target installs into the interpreter's admin directory without touching
# the PEP 668 externally-managed environment, and --no-deps keeps the install
# to the one verified artefact — PyYAML declares no runtime dependencies.
# shellcheck disable=SC2086  # PIP_RETRY is a flag list that must word-split.
python3 "${pip_wheel}/pip" install --no-deps \
    --only-binary=:all: --no-cache-dir -q ${PIP_RETRY} --target "${site}" "${wheel}"
# Both unprivileged accounts run the monitored repositories' gates, so the
# whole tree has to be readable and traversable by them, not just by root.
chmod -R a+rX "${site}"

# Prove the modules import on this image's own interpreter rather than
# assuming the install landed somewhere it searches.
for module in "${modules[@]}"; do
    if ! python3 -c "import ${module}" < /dev/null; then
        echo "[${TOOLCHAIN_ID}] python3 cannot import ${module} after the install" >&2
        exit 1
    fi
done

installed="$(python3 -c "import ${version_module}; print(${version_module}.__version__)" < /dev/null)"
if [[ "${installed}" != "${version}" ]]; then
    echo "[${TOOLCHAIN_ID}] ${version_module} reports \"${installed}\", expected ${version}" >&2
    exit 1
fi

echo "[${TOOLCHAIN_ID}] Installed ${version_module} ${version}"
