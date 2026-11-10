#!/usr/bin/env bash
# TokenEconomizer toolchain installation fragment (Issue #4955, parent #4953).
#
# TokenEconomizer is the Microsoft plugin the worker's own trial drives. The
# image carries one source archive at one pinned commit, verified against a
# recorded sha256 and never cloned at run time. Nothing in the image invokes it
# yet: the `token_economizer` config block (Issue #4956) is what would, so the
# command sits on the PATH unused until then.
#
# Pins live in container/tools.json, read here with jq rather than restated:
# the version, the commit and the archive checksum. The Containerfile only
# names the id. Its size cap leaves no room for ARG blocks, which is the
# deliberate design choice recorded in the tools.json notes.
#
# ${CURL_RETRY} is the build's shared retry policy, inherited from the
# Containerfile ARG (Issue #1014); it must word-split, hence the deliberate
# lack of quotes.
#
# Layout: the archive unpacks to TokenEconomizer-<commit>/. Only plugin/ and
# tokeneconomizer/ are installed, side by side under the install directory, so
# the plugin's relative plugin/lib/tokeneconomizer symlink still resolves.
# experiments/, tests/ and docs/ are not installed.
#
# Python: the package is stdlib-only and its pyproject.toml declares
# requires-python. The fragment refuses an image python3 older than that floor.
#
# The /usr/local/bin/tokeneconomizer wrapper answers --version with the pinned
# version and commit baked in at install time, and otherwise execs the plugin's
# te command line unchanged (the floci precedent).
#
# Fails loud: a missing pin, a malformed commit, a failed download, a checksum
# mismatch, an archive without the expected layout, a source version that
# disagrees with the manifest, a python3 below the requires-python floor, a
# symlink that resolves outside the install directory, or a wrapper that
# reports the wrong version aborts the build. The checksum is verified before
# anything is installed.
#
# TOKENECONOMIZER_INSTALL_DIR and TOKENECONOMIZER_BIN_DIR override the install
# and bin directories (defaults /opt/tokeneconomizer and /usr/local/bin),
# letting tests run the fragment end to end without root.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="tokeneconomizer"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
SOURCE="https://github.com/microsoft/TokenEconomizer/archive"
# Install and bin directories, overridable so tests can run without root.
INSTALL_DIR="${TOKENECONOMIZER_INSTALL_DIR:-/opt/tokeneconomizer}"
BIN_DIR="${TOKENECONOMIZER_BIN_DIR:-/usr/local/bin}"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

# jq -er exits non-zero on an absent or null field but says nothing useful, so
# a dropped pin would abort the build with a bare exit code. Name what is
# missing instead.
manifest_field() {
    local filter="$1" description="$2" value
    if ! value="$(jq -er --arg id "${TOOLCHAIN_ID}" "${filter}" "${MANIFEST}")"; then
        echo "[${TOOLCHAIN_ID}] ${description} is missing from ${MANIFEST}" >&2
        exit 1
    fi
    printf '%s\n' "${value}"
}

# shellcheck disable=SC2016  # jq filter literal; $id is a jq variable.
version="$(manifest_field \
    '.toolchains[] | select(.id == $id) | .version' "the version pin")"

# shellcheck disable=SC2016  # jq filter literal; $id is a jq variable.
commit="$(manifest_field \
    '.toolchains[] | select(.id == $id) | .commit' "the commit pin")"
commit_re='^[0-9a-f]{40}$'
if [[ ! "${commit}" =~ ${commit_re} ]]; then
    echo "[${TOOLCHAIN_ID}] The commit pin \"${commit}\" is not a 40-character lower-case commit" >&2
    exit 1
fi

# shellcheck disable=SC2016  # jq filter literal; $id is a jq variable.
checksum="$(manifest_field \
    '.toolchains[] | select(.id == $id) | .sha256.noarch' \
    "the sha256 pin")"

echo "[${TOOLCHAIN_ID}] Installing ${version} (commit ${commit})"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

archive="${workdir}/tokeneconomizer.tar.gz"
src="${workdir}/src"
mkdir "${src}"
# shellcheck disable=SC2086  # CURL_RETRY is a flag list that must word-split.
curl -fsSL ${CURL_RETRY} -o "${archive}" "${SOURCE}/${commit}.tar.gz"

if ! echo "${checksum}  ${archive}" | sha256sum -c -; then
    echo "[${TOOLCHAIN_ID}] Archive checksum mismatch: ${SOURCE}/${commit}.tar.gz did not match the pinned sha256 in ${MANIFEST}; nothing installed" >&2
    exit 1
fi

# --no-same-owner: the archive records its upstream build uid, which does not
# exist in the image. --strip-components drops the TokenEconomizer-<commit>/
# directory, so the layout check below reads the same whatever the commit.
tar -xzf "${archive}" --no-same-owner --strip-components=1 -C "${src}"
for required in plugin tokeneconomizer pyproject.toml; do
    if [[ ! -e "${src}/${required}" ]]; then
        echo "[${TOOLCHAIN_ID}] Archive does not carry ${required} at its top level" >&2
        exit 1
    fi
done

# The version the wrapper reports must be the version the source declares.
# `q` stops sed at the first match, so no pipe is closed early under pipefail.
source_version="$(sed -n '/^version = /{s/^version = "\(.*\)"[[:space:]]*$/\1/p;q}' "${src}/pyproject.toml")"
if [[ "${source_version}" != "${version}" ]]; then
    echo "[${TOOLCHAIN_ID}] pyproject.toml declares version \"${source_version}\", but ${MANIFEST} pins ${version}" >&2
    exit 1
fi

# The package's own floor, read from its pyproject.toml. Only the >=MAJOR.MINOR
# form is understood; anything else fails loud rather than guessing a floor.
min_python="$(sed -n '/^requires-python/{s/^requires-python[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p;q}' "${src}/pyproject.toml")"
requirement_re='^>=([0-9]+)\.([0-9]+)$'
if [[ ! "${min_python}" =~ ${requirement_re} ]]; then
    echo "[${TOOLCHAIN_ID}] pyproject.toml requires-python \"${min_python}\" is not of the form >=MAJOR.MINOR" >&2
    exit 1
fi
min_major="${BASH_REMATCH[1]}"
min_minor="${BASH_REMATCH[2]}"

if ! command -v python3 > /dev/null 2>&1; then
    echo "[${TOOLCHAIN_ID}] python3 is missing from the image: tokeneconomizer needs requires-python ${min_python}" >&2
    exit 1
fi
py_version="$(python3 -I -c 'import sys; print("%d.%d" % sys.version_info[:2])' < /dev/null)"
py_major="${py_version%%.*}"
py_minor="${py_version#*.}"
if (( py_major < min_major || (py_major == min_major && py_minor < min_minor) )); then
    echo "[${TOOLCHAIN_ID}] python3 is ${py_version}, below requires-python ${min_python} (tokeneconomizer's pyproject.toml); nothing installed" >&2
    exit 1
fi
echo "[${TOOLCHAIN_ID}] python3 ${py_version} meets requires-python ${min_python}"

install -d "${INSTALL_DIR}"
cp -a "${src}/plugin" "${src}/tokeneconomizer" "${INSTALL_DIR}/"

# No symlink under the install directory may resolve outside it. Checked after
# the copy, because the copy is what the image will hold; a failure removes
# the two trees this fragment installed.
install_real="$(readlink -f "${INSTALL_DIR}")"
escaped=0
while IFS= read -r -d '' link; do
    target="$(readlink -f "${link}")"
    case "${target}" in
        "${install_real}"/*) ;;
        *)
            echo "[${TOOLCHAIN_ID}] symlink ${link} resolves to ${target}, outside ${INSTALL_DIR}" >&2
            escaped=1
            ;;
    esac
done < <(find "${INSTALL_DIR}" -type l -print0)
if [[ "${escaped}" -ne 0 ]]; then
    rm -rf "${INSTALL_DIR}/plugin" "${INSTALL_DIR}/tokeneconomizer"
    exit 1
fi
chmod -R a+rX "${INSTALL_DIR}"

# Prove the package imports in this image, first from the install directory and
# then through the plugin's own lib/ symlink. -I ignores PYTHONPATH and the
# working directory, so each path is named explicitly.
for path in "${INSTALL_DIR}" "${INSTALL_DIR}/plugin/lib"; do
    if ! imported="$(PYTHONDONTWRITEBYTECODE=1 python3 -I -c \
        'import sys; sys.path.insert(0, sys.argv[1]); import tokeneconomizer; print(tokeneconomizer.__file__)' \
        "${path}" < /dev/null)"; then
        echo "[${TOOLCHAIN_ID}] tokeneconomizer does not import from ${path}" >&2
        exit 1
    fi
    echo "[${TOOLCHAIN_ID}] imports from ${path}: ${imported}"
done

# The wrapper answers --version from the pins baked in here, and otherwise
# execs the plugin's own command line.
wrapper="${workdir}/tokeneconomizer"
cat > "${wrapper}" <<EOF
#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
    echo "tokeneconomizer ${version} (commit ${commit})"
    exit 0
fi
exec ${INSTALL_DIR}/plugin/scripts/te "\$@"
EOF
install -d "${BIN_DIR}"
install -m 0755 "${wrapper}" "${BIN_DIR}/tokeneconomizer"

# Prove the installed wrapper runs in this image rather than assuming it does.
installed="$("${BIN_DIR}/tokeneconomizer" --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed wrapper reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

echo "[${TOOLCHAIN_ID}] Installed tokeneconomizer ${version} (commit ${commit}) at ${BIN_DIR}/tokeneconomizer"
