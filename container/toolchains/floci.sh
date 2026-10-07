#!/usr/bin/env bash
# Floci toolchain installation fragment (Issue #3367, parent #3346).
#
# Floci is the MIT-licensed LocalStack drop-in (AWS Local Emulator) on port
# 4566 that the worker's own runs use. This fragment only installs the
# binary onto the PATH — the entrypoint must never start it automatically;
# only a repository's own tooling, or a trial run, does that.
#
# Pins live in container/tools.json, read here with jq rather than restated.
#
# Layout: the Containerfile copies the pinned floci image's /app/application
# Quarkus native binary out via `COPY --from=floci` before this fragment
# runs, so unlike the other fragments here this one never downloads
# anything itself — it only verifies and installs bytes the build already
# copied in.
#
# The binary has no --version flag (one just starts the full server), so the
# fragment installs a thin /usr/local/bin/floci wrapper that answers
# --version with the pinned version baked in at install time, and otherwise
# execs the native binary unchanged.
#
# Fails loud: a missing pin, a missing source binary, a checksum mismatch, an
# unsupported architecture, or a binary that does not answer on its HTTP port
# aborts the build.
#
# FLOCI_PREFIX overrides the install prefix (default /usr/local), letting
# tests run the fragment end to end without root.
#
# Australian English spelling throughout (behaviour, organisation).

set -euo pipefail

TOOLCHAIN_ID="floci"
MANIFEST="${TOOLCHAIN_MANIFEST:-/tmp/tools.json}"
FLOCI_SOURCE="${FLOCI_SOURCE:-/tmp/floci-application}"
# Install prefix, overridable so tests can run the fragment end to end without root.
FLOCI_PREFIX="${FLOCI_PREFIX:-/usr/local}"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[${TOOLCHAIN_ID}] Manifest ${MANIFEST} is missing — cannot resolve the pinned version" >&2
    exit 1
fi

# jq -er exits non-zero on an absent or null field but says nothing useful, so
# a dropped pin would abort the build with a bare exit code. Name what is
# missing instead.
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

echo "[${TOOLCHAIN_ID}] Installing ${version} for ${manifest_arch}"

if [[ ! -f "${FLOCI_SOURCE}" ]]; then
    echo "[${TOOLCHAIN_ID}] Source binary ${FLOCI_SOURCE} is missing — expected the Containerfile's COPY --from=floci stage to have placed it there" >&2
    exit 1
fi

echo "${checksum}  ${FLOCI_SOURCE}" | sha256sum -c -

install -d "${FLOCI_PREFIX}/lib/floci"
install -m 0755 "${FLOCI_SOURCE}" "${FLOCI_PREFIX}/lib/floci/application"

# The binary has no --version flag, so a thin wrapper answers it from the
# version pinned at install time and otherwise execs the native binary.
wrapper="$(mktemp)"
cat > "${wrapper}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
    echo "floci ${version}"
    exit 0
fi
exec ${FLOCI_PREFIX}/lib/floci/application "\$@"
EOF
install -d "${FLOCI_PREFIX}/bin"
install -m 0755 "${wrapper}" "${FLOCI_PREFIX}/bin/floci"
rm -f "${wrapper}"

# Prove the installed wrapper runs in this image rather than assuming it does.
installed="$("${FLOCI_PREFIX}/bin/floci" --version < /dev/null)"
case "${installed}" in
    *"${version}"*) ;;
    *)
        echo "[${TOOLCHAIN_ID}] Installed binary reports \"${installed}\", expected ${version}" >&2
        exit 1
        ;;
esac

# Build-time smoke check: prove the native binary actually starts and
# answers HTTP on its default port, run from a scratch working directory so
# the ./data directory it creates does not linger in the build context.
workdir="$(mktemp -d)"
floci_pid=""
cleanup() {
    if [[ -n "${floci_pid}" ]] && kill -0 "${floci_pid}" 2>/dev/null; then
        kill "${floci_pid}" 2>/dev/null || true
        wait "${floci_pid}" 2>/dev/null || true
    fi
    rm -rf "${workdir}"
}
trap cleanup EXIT

(cd "${workdir}" && exec timeout -k 5 120 "${FLOCI_PREFIX}/lib/floci/application" -Dquarkus.http.host=127.0.0.1) &
floci_pid=$!

status="$(curl -sS -o /dev/null -w '%{http_code}' --retry 30 --retry-delay 1 \
    --retry-connrefused --max-time 5 http://127.0.0.1:4566/ || true)"
echo "[${TOOLCHAIN_ID}] smoke check: http://127.0.0.1:4566/ answered HTTP ${status}"

if [[ -z "${status}" || "${status}" == "000" ]]; then
    kill "${floci_pid}" 2>/dev/null || true
    wait "${floci_pid}" 2>/dev/null || true
    floci_pid=""
    echo "[${TOOLCHAIN_ID}] Installed binary did not answer on http://127.0.0.1:4566/" >&2
    exit 1
fi

kill "${floci_pid}" 2>/dev/null || true
wait "${floci_pid}" 2>/dev/null || true
floci_pid=""

rm -f "${FLOCI_SOURCE}"

echo "[${TOOLCHAIN_ID}] Installed floci ${version}"
