#!/bin/bash
set -euo pipefail

# Container entrypoint for the Vibe Coder worker (Issue #4061).
#
# Deliberately does no host-specific PATH guessing: the image bakes a PATH
# that resolves deno, git, gh and jq (container/Containerfile), so this
# script only locates the repository and execs the Deno driver. run.sh
# (Issue #4065) and run.ps1 (Issue #4066) launch this container and mount the
# checkout at VIBE_BASE_DIR.
#
# The base directory is VIBE_BASE_DIR when set (the image points it at the
# mounted work path), otherwise the repository this script ships in.

BASE_DIR="${VIBE_BASE_DIR:-$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"

DRIVER="${BASE_DIR}/worker/deno/mod.ts"
LOCKFILE="${BASE_DIR}/worker/deno/deno.lock"

if ! command -v deno >/dev/null 2>&1; then
  echo "Error: deno not found on PATH (${PATH})" >&2
  exit 1
fi

# Fail loud rather than letting Deno report a confusing module error.
if [[ ! -f "${DRIVER}" ]]; then
  echo "Error: worker driver not found at ${DRIVER}" >&2
  echo "Mount the repository at ${BASE_DIR} or set VIBE_BASE_DIR." >&2
  exit 1
fi

# Trust the mounted repositories. The runtime maps mount roots as root-owned
# while files map to the container user, so git's dubious-ownership guard
# refuses /workspace and every worker-managed clone ("fatal: detected dubious
# ownership"). Inside this single-purpose container the only repositories
# visible ARE the worker's own mounts, so the container-scoped wildcard trust
# gives away nothing. `command -v` guard: the image always ships git, but the
# entrypoint tests run with a minimal PATH.
if command -v git >/dev/null 2>&1; then
  git config --global --add safe.directory '*' ||
    echo "Warning: could not set git safe.directory — git may refuse the mounted repositories" >&2
fi

# Git transport inside the container is HTTPS with the mounted gh token: no
# SSH key ever crosses the containment boundary (Issue #4064), so SSH remotes
# are rewritten to HTTPS and gh becomes git's credential helper. Warn-only —
# bootstrap's own git fetch remains the loud failure when auth is broken.
#
# The mounted credential is copied into a writable VM-local directory first
# (under ~/.config — the runtime creates ~/.vibe-coder root-owned for the
# mount targets, so nothing can be created beside them):
# gh performs a config migration WRITE on first use, and every run is a fresh
# VM, so a read-only GH_CONFIG_DIR can never satisfy it (observed live:
# "failed to write config after migration: … read-only file system"). The
# copy never leaves the VM and the read-only mount stays the source of truth.
GH_CRED_DIR="${HOME:-/home/vibe}/.vibe-coder/credentials/gh"
GH_RUNTIME_DIR="${HOME:-/home/vibe}/.config/gh-runtime"
if [[ -f "${GH_CRED_DIR}/hosts.yml" ]]; then
  {
    mkdir -p "${GH_RUNTIME_DIR}" &&
      cp "${GH_CRED_DIR}/hosts.yml" "${GH_RUNTIME_DIR}/hosts.yml" &&
      chmod 700 "${GH_RUNTIME_DIR}" &&
      chmod 600 "${GH_RUNTIME_DIR}/hosts.yml"
  } || echo "Warning: could not stage the gh credential for runtime use" >&2
  # The staged copy is the container's gh configuration, for EVERY process
  # (Issue #4220): the worker's own plumbing pointed GH_CONFIG_DIR here
  # per-call, but raw scripts — FLEET-health's repos.sh running plain `git
  # push` — inherited an env without it, so the credential helper read an
  # absent default config and every heartbeat push died unauthenticated
  # behind the script's exit 0. Exported only when the staging succeeded.
  if [[ -f "${GH_RUNTIME_DIR}/hosts.yml" ]]; then
    export GH_CONFIG_DIR="${GH_RUNTIME_DIR}"
  fi
fi
if command -v git >/dev/null 2>&1 && [[ -f "${GH_CRED_DIR}/hosts.yml" ]]; then
  {
    git config --global url."https://github.com/".insteadOf "git@github.com:" &&
      git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" &&
      # The helper written directly rather than via `gh auth setup-git`,
      # which would need its own writable config. `gh auth git-credential`
      # reads GH_CONFIG_DIR at fetch time (the worker points it at the
      # staged runtime copy above).
      git config --global credential."https://github.com".helper "" &&
      git config --global --add credential."https://github.com".helper "!gh auth git-credential"
  } || echo "Warning: could not configure the HTTPS git transport" >&2
  # A container-wide git identity from the mounted credential (Issue #4235):
  # the worker's own plumbing injects identity per call, but raw scripts —
  # FLEET-health's repos.sh committing the heartbeat — inherit none, so their
  # `git commit` died ("please tell me who you are"), exited 0, and the
  # uncommitted local edit then satisfied the script's own rate limit on
  # every retry. Observed live behind the #4219 did-not-land warning.
  GH_USER="$(sed -n 's/^[[:space:]]*user:[[:space:]]*//p' "${GH_CRED_DIR}/hosts.yml" | head -1)"
  if [[ -n "${GH_USER}" ]]; then
    {
      git config --global user.name "${GH_USER}" &&
        git config --global user.email "${GH_USER}@users.noreply.github.com"
    } || echo "Warning: could not configure the git identity" >&2
  fi
fi

# --- Per-launch cache/recompute tax (Issue #4302) ---------------------------
# Both fixes are gated on HOME being set (the image sets /home/vibe; the
# entrypoint tests run with a cleared environment and keep legacy behaviour).
if [[ -n "${HOME:-}" ]]; then
  # 1. Durable Deno cache: the image's DENO_DIR sits in the container's
  #    ephemeral overlay, and the container runs with --rm — so every cycle
  #    re-downloaded every dependency and re-type-checked the whole worker
  #    graph from zero. Pointing DENO_DIR at the vibe-work named volume
  #    makes every launch after the first a warm start. The dot-prefixed
  #    directory is skipped by the stale-workdir scanner; a size guard in
  #    run_housekeeping keeps it bounded.
  DENO_CACHE_DIR="${VIBE_DENO_CACHE_DIR:-${HOME}/auto-issue-work/.deno-cache}"
  if mkdir -p "${DENO_CACHE_DIR}" 2>/dev/null && [[ -w "${DENO_CACHE_DIR}" ]]; then
    export DENO_DIR="${DENO_CACHE_DIR}"
    # 1b. Seed a cold durable cache from the image's pre-warmed one (Issue
    #     #4392): the Containerfile ran `deno cache` for the pinned
    #     @playwright/mcp (and its own playwright-core) and the worker's
    #     JSR deps into ${VIBE_DENO_SEED_DIR}, so the first launch on a
    #     fresh volume — or after the cache guard wiped it — needs no npm
    #     or jsr.io round trip. No-clobber: whatever the volume already
    #     holds wins — only the files the cache lacks are copied, in one
    #     tar pipe (portable: GNU and BSD tar both take -T; `cp -n` exit
    #     codes differ between them).
    DENO_SEED_DIR="${VIBE_DENO_SEED_DIR:-/opt/deno-seed}"
    seeded=false
    for sub in npm remote; do
      [[ -d "${DENO_SEED_DIR}/${sub}" ]] || continue
      missing_list="$(mktemp 2>/dev/null || echo "/tmp/vibe-deno-seed-$$.${sub}")"
      (cd "${DENO_SEED_DIR}/${sub}" && find . -type f 2>/dev/null) \
        | while IFS= read -r rel; do
            [[ -e "${DENO_CACHE_DIR}/${sub}/${rel}" ]] || printf '%s\n' "${rel}"
          done > "${missing_list}"
      if [[ -s "${missing_list}" ]]; then
        mkdir -p "${DENO_CACHE_DIR}/${sub}"
        if (cd "${DENO_SEED_DIR}/${sub}" && tar cf - -T "${missing_list}") \
          | (cd "${DENO_CACHE_DIR}/${sub}" && tar xf -); then
          seeded=true
        else
          echo "Warning: could not seed ${DENO_CACHE_DIR}/${sub} from ${DENO_SEED_DIR}/${sub} — the first use will fetch from the registry" >&2
        fi
      fi
      rm -f "${missing_list}"
    done
    if [[ "${seeded}" == "true" ]]; then
      echo "entrypoint: seeded the Deno cache at ${DENO_CACHE_DIR} from ${DENO_SEED_DIR} (Issue #4392)" >&2
    fi
  else
    echo "Warning: could not use durable Deno cache at ${DENO_CACHE_DIR} — falling back to the image default (cold cache every launch)" >&2
  fi

  # 2. Run the driver from VM-local storage instead of the virtiofs mount:
  #    the module graph is ~1,500 files and virtiofs pays a host round trip
  #    per read, every launch. One sequential copy is cheap by comparison.
  #    The mounted checkout stays the source of truth — --base-dir still
  #    points at it for repo-root assets — and a copy failure falls back
  #    loudly to running from the mount, exactly as before.
  LOCAL_SRC="${HOME}/.worker-src"
  if rm -rf "${LOCAL_SRC}" 2>/dev/null &&
    mkdir -p "${LOCAL_SRC}/worker" 2>/dev/null &&
    cp -R "${BASE_DIR}/worker/deno" "${LOCAL_SRC}/worker/" 2>/dev/null; then
    DRIVER="${LOCAL_SRC}/worker/deno/mod.ts"
    LOCKFILE="${LOCAL_SRC}/worker/deno/deno.lock"
    # Repo assets stay in the checkout (Issue #4302 regression): modules
    # that resolve `prompts/` relative to their own path would otherwise
    # look under the staged copy — observed live as "Prompt 'planning' not
    # found in ~/.worker-src/worker/deno/lib/../../../prompts". Point the
    # prompt loader at the checkout explicitly.
    export PROMPTS_DIR="${BASE_DIR}/prompts"
  else
    echo "Warning: could not stage the worker source locally — running from ${BASE_DIR} (virtiofs)" >&2
  fi
fi

# The image is the agent CLI's update mechanism too (Issue #4248): the CLI
# ships a self-updater that RESTARTS (kills) the running process when an
# update lands, and the image pins an older CLI than current — so every
# containerised session invited a silent mid-run SIGKILL at
# whenever-the-download-finished timing. The worker's own updates were
# suppressed in-container from day one (#4062); this extends the same
# principle to the agent.
export DISABLE_AUTOUPDATER=1

cd "${BASE_DIR}"

# --frozen + --lock fail closed on dependency drift (Issue #2896). The driver
# needs env/read/write/run plus --allow-net (GitHub API, webhooks, FLEET health)
# and --allow-sys=hostname (worker identity); the container boundary, not this
# permission set, is what keeps the worker off the host.
#
# The driver runs as a CHILD, never via exec (Issue #4239): this script is
# the container's PID 1, and PID 1 must reap the orphans that reparent to
# it — double-forked gits from agent bash tools and the quality gate's test
# suites. exec-ing made the Deno driver PID 1, and Deno never waits on
# children it did not spawn, so every orphan became a permanent zombie
# (2,137 dead `git` processes counted live after two hours of sessions).
# bash reaps reparented children as they exit; the traps forward the
# runtime's stop signals to the driver so graceful shutdown is unchanged,
# and the driver's exit status is propagated verbatim.
deno run \
  --frozen --lock="${LOCKFILE}" \
  --allow-env --allow-read --allow-write --allow-run \
  --allow-net --allow-sys=hostname \
  "${DRIVER}" run-entrypoint \
  --base-dir "${BASE_DIR}" "$@" < /dev/null &
driver_pid=$!
trap 'kill -TERM "${driver_pid}" 2>/dev/null' TERM INT
driver_status=0
while :; do
  if wait "${driver_pid}"; then
    driver_status=0
    break
  else
    driver_status=$?
    # wait returns >128 when interrupted by a trapped signal while the
    # driver is still running — loop and keep waiting for the real exit.
    kill -0 "${driver_pid}" 2>/dev/null || break
  fi
done
exit "${driver_status}"
