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

# --- Writable-path policy (Issue #515) --------------------------------------
# Nothing may write to the container's image layer: the root filesystem is to
# be mounted read-only (Issue #509), so every writer this script owns — and
# every dot-directory / XDG default the agent CLIs and package managers reach
# for — is relocated to one of two container-managed roots.
#
#   VIBE_SCRATCH_DIR  Per-launch scratch, cleared on every start. Preferred
#     home is /tmp, a tmpfs where the runtime provides one. Apple `container`
#     reports supportsTmpfs: false (worker/deno/lib/container_runtime.ts), so
#     there /tmp is ordinary root filesystem and stops being writable the
#     moment the root goes read-only — the vibe-work volume is the fallback
#     that works on a runtime taking no tmpfs at all.
#   VIBE_STATE_DIR  Caches worth keeping between launches, on the vibe-work
#     volume. /tmp is the loud fallback (cold caches every launch).
#
# Every resolution warns loudly when it cannot use its preferred target, in
# the same shape as the durable-Deno-cache warning below. When no candidate is
# writable the legacy ${HOME} paths are kept and the warning says so, so a
# read-only root fails at the first write rather than silently degrading.

# Echo the first candidate directory that can be created and written to.
# Empty candidates are skipped; each rejection is reported. Returns 1 when
# none is usable, so the caller can keep the legacy path and say why.
vibe_first_writable_dir() {
  local label="$1"
  shift
  local candidate
  for candidate in "$@"; do
    [[ -n "${candidate}" ]] || continue
    if mkdir -p "${candidate}" 2>/dev/null && [[ -w "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
    echo "Warning: ${label} cannot use ${candidate} (not writable) — trying the next candidate" >&2
  done
  return 1
}

VIBE_WORK_ROOT="${HOME:-/home/vibe}/auto-issue-work"
TMP_SCRATCH_ROOT="${TMPDIR:-/tmp}/vibe-scratch"

# --- The work tree the agent account also writes (Issue #571) ----------------
# The repository's own quality command runs as `agent`, and it writes into the
# clone: build output, test artefacts, tool caches. So the work root is shared
# with the `vibework` group and marked setgid, which makes every directory
# created below it inherit that group rather than the creator's own.
#
# Only the top level is walked. The volume carries tens of gigabytes and a
# recursive chgrp at every launch would cost minutes; setgid propagates to
# what is created from here on, and `setupRepo` re-clones anything older. A
# failure is a warning, not a stop: the quality gate falls back to running as
# the worker (degraded, and it says so) rather than the container refusing to
# start.
if [[ -d "${VIBE_WORK_ROOT}" ]] && getent group vibework >/dev/null 2>&1; then
  if chgrp vibework "${VIBE_WORK_ROOT}" 2>/dev/null &&
    chmod g+rwxs "${VIBE_WORK_ROOT}" 2>/dev/null; then
    for entry in "${VIBE_WORK_ROOT}"/*/; do
      [[ -d "${entry}" ]] || continue
      chgrp vibework "${entry}" 2>/dev/null || true
      chmod g+rwxs "${entry}" 2>/dev/null || true
    done
  else
    echo "Warning: could not share ${VIBE_WORK_ROOT} with the vibework group — the repository's own commands cannot run as the 'agent' account and will run as the worker instead (Issue #571)" >&2
  fi
fi

SCRATCH_ROOT="$(
  vibe_first_writable_dir "per-launch scratch root" \
    "${VIBE_SCRATCH_DIR:-}" \
    "${TMP_SCRATCH_ROOT}" \
    "${VIBE_WORK_ROOT}/.container-scratch"
)" || SCRATCH_ROOT=""

if [[ -n "${SCRATCH_ROOT}" ]]; then
  # Per-launch by construction: on the volume fallback the previous
  # container's scratch is still on disk, and it is not this launch's state.
  if ! { rm -rf "${SCRATCH_ROOT}" 2>/dev/null && mkdir -p "${SCRATCH_ROOT}" 2>/dev/null; }; then
    echo "Warning: could not clear the scratch root at ${SCRATCH_ROOT} — a previous launch's leftovers may remain" >&2
  fi
  export VIBE_SCRATCH_DIR="${SCRATCH_ROOT}"
  export XDG_CONFIG_HOME="${SCRATCH_ROOT}/config"
  if [[ "${SCRATCH_ROOT}" != "${TMP_SCRATCH_ROOT}" ]]; then
    # /tmp was refused, so every mktemp/Deno.makeTempDir in the container
    # needs somewhere else to land as well.
    export TMPDIR="${SCRATCH_ROOT}/tmp"
    mkdir -p "${TMPDIR}" 2>/dev/null ||
      echo "Warning: could not create ${TMPDIR} — temporary files have nowhere writable to go" >&2
    echo "entrypoint: /tmp is not writable — scratch and TMPDIR relocated to ${SCRATCH_ROOT} (Issue #515)" >&2
  fi
else
  echo "Warning: no writable scratch root (tried ${TMP_SCRATCH_ROOT} and ${VIBE_WORK_ROOT}/.container-scratch) — falling back to the legacy \${HOME} paths, which need a writable root filesystem" >&2
fi

STATE_ROOT="$(
  vibe_first_writable_dir "durable state root" \
    "${VIBE_STATE_DIR:-}" \
    "${VIBE_WORK_ROOT}/.container-state" \
    "${SCRATCH_ROOT:+${SCRATCH_ROOT}/state}"
)" || STATE_ROOT=""

if [[ -n "${STATE_ROOT}" ]]; then
  export VIBE_STATE_DIR="${STATE_ROOT}"
  # git's global config: `git config --global` writes ${HOME}/.gitconfig
  # otherwise — the image layer. It holds the HTTPS transport, the `gh` credential
  # helper and the service-account identity, all recomputed at launch from the
  # mounted credential.
  #
  # On the DURABLE STATE root, not scratch (Issue #564). Observed twice on the
  # fleet: /tmp/vibe-scratch was emptied mid-run, the worker's own
  # `git config --global --add safe.directory '*'` recreated the file as a
  # 22-byte stub, and every fetch, push and commit failed for hours with a
  # perfectly healthy `gh` beside it — because a config file that EXISTS and
  # is missing its helper reads as configured. Nothing of value is left in the
  # directory that keeps being wiped.
  export GIT_CONFIG_GLOBAL="${STATE_ROOT}/gitconfig"
  # The dot-directories every other tool in the image reaches for. Left at
  # their defaults they all land under ${HOME} on the image layer.
  export XDG_CACHE_HOME="${STATE_ROOT}/cache"
  export XDG_DATA_HOME="${STATE_ROOT}/data"
  export XDG_STATE_HOME="${STATE_ROOT}/state"
  export CARGO_HOME="${STATE_ROOT}/cargo"
  export npm_config_cache="${STATE_ROOT}/npm"
elif [[ -n "${SCRATCH_ROOT}" ]]; then
  # No durable root: scratch still beats the image layer for the git config,
  # and the worker rebuilds it from the mount when it is lost (Issue #564).
  export GIT_CONFIG_GLOBAL="${SCRATCH_ROOT}/gitconfig"
  echo "Warning: no writable durable state root (tried ${VIBE_WORK_ROOT}/.container-state) — tool caches keep their \${HOME} defaults and the git config falls back to the scratch root" >&2
else
  echo "Warning: no writable durable state root (tried ${VIBE_WORK_ROOT}/.container-state) — tool caches keep their \${HOME} defaults and need a writable root filesystem" >&2
fi

# Trust the mounted repositories. The runtime maps mount roots as root-owned
# while files map to the container user, so git's dubious-ownership guard
# refuses /workspace and every worker-managed clone ("fatal: detected dubious
# ownership"). Inside this single-purpose container the only repositories
# visible ARE the worker's own mounts, so the container-scoped wildcard trust
# gives away nothing. `command -v` guard: the image always ships git, but the
# entrypoint tests run with a minimal PATH. Deliberately AFTER the
# writable-path policy above: this is the first `git config --global` of the
# launch, and without GIT_CONFIG_GLOBAL it writes ${HOME}/.gitconfig on the
# image layer (Issue #515).
if command -v git >/dev/null 2>&1; then
  git config --global --add safe.directory '*' ||
    echo "Warning: could not set git safe.directory — git may refuse the mounted repositories" >&2
fi

# Git transport inside the container is HTTPS with the mounted gh token: no
# SSH key ever crosses the containment boundary (Issue #4064), so SSH remotes
# are rewritten to HTTPS and gh becomes git's credential helper. Warn-only —
# bootstrap's own git fetch remains the loud failure when auth is broken.
#
# The mounted credential is copied into a writable directory first: gh
# performs a config migration WRITE on first use, and every run is a fresh
# VM, so a read-only GH_CONFIG_DIR can never satisfy it (observed live:
# "failed to write config after migration: … read-only file system"). The
# copy never leaves the VM and the read-only mount stays the source of truth.
#
# It lives under the DURABLE STATE root, not the scratch root (Issue #564).
# Scratch is /tmp — mode 1777, the coding agents' own scratch and TMPDIR,
# where their test suites left 2860 directories in a single run. The worker's
# live credential sat in the middle of that churn and was deleted 14 minutes
# into a run: every gh call and every git push failed from that moment and
# the run died with the intact credential still on the mount. A credential
# the agent can delete is a credential the run will lose.
GH_CRED_DIR="${HOME:-/home/vibe}/.vibe-coder/credentials/gh"
# --- The secrets mount (Issue #570) ------------------------------------------
# A memory-backed mount of its own, away from the agents' scratch, is where
# every runtime with a secrets primitive puts credentials: Docker and Podman
# `--secret` land at /run/secrets, Kubernetes mounts a Secret on tmpfs,
# systemd's LoadCredential= uses $CREDENTIALS_DIRECTORY. Nothing touches disk,
# nothing enters an image layer, nothing survives the container.
#
# Two things have to be checked rather than assumed. Apple container 1.2.2
# accepts `--tmpfs path:options` and takes the WHOLE string as the path, so
# the launcher sends it the bare path (container_launch.ts) and the mode is
# applied here. And a tmpfs the runtime silently failed to mount leaves an
# ordinary directory on the read-only root, which is not writable — so the
# mount is probed, not trusted.
VIBE_SECRETS_DIR="/run/vibe-secrets"
if [[ ! -d "${VIBE_SECRETS_DIR}" ]]; then
  # The runtime offered no such mount — a dialect that takes no tmpfs at all
  # (Apple container), or a harness. The durable state root is the designed
  # fallback, so this is not a fault and is not reported as one.
  VIBE_SECRETS_DIR=""
elif touch "${VIBE_SECRETS_DIR}/.probe" 2>/dev/null; then
  rm -f "${VIBE_SECRETS_DIR}/.probe"
  # Best-effort, and it genuinely fails on Apple container: the runtime mounts
  # the tmpfs root-owned `1777` and an unprivileged process cannot chmod what
  # it does not own ("Operation not permitted"). The mount's own mode is
  # therefore not the protection — the per-credential directory the worker
  # creates inside it is, and that one it owns and sets to 0700. What the
  # mount buys regardless is separation: it is not the `/tmp` the coding
  # agents and their test suites scribble 3000 entries into (Issue #564).
  chmod 0700 "${VIBE_SECRETS_DIR}" 2>/dev/null || true
  export VIBE_SECRETS_DIR
else
  # It EXISTS and cannot be written: the runtime was asked for a tmpfs and
  # left an ordinary directory on the read-only root. That is a fault, and a
  # silent one — the credential would be staged nowhere and the first gh call
  # would fail with no clue why.
  echo "Warning: ${VIBE_SECRETS_DIR} exists but is not writable — the tmpfs the launcher asked for did not mount; credentials fall back to the durable state root, shared with the agents' work volume (Issue #570)" >&2
  VIBE_SECRETS_DIR=""
fi

GH_RUNTIME_DIR="${VIBE_SECRETS_DIR:+${VIBE_SECRETS_DIR}/gh}"
GH_RUNTIME_DIR="${GH_RUNTIME_DIR:-${STATE_ROOT:+${STATE_ROOT}/gh}}"
GH_RUNTIME_DIR="${GH_RUNTIME_DIR:-${SCRATCH_ROOT:+${SCRATCH_ROOT}/gh}}"
GH_RUNTIME_DIR="${GH_RUNTIME_DIR:-${HOME:-/home/vibe}/.config/gh-runtime}"
if [[ -f "${GH_CRED_DIR}/hosts.yml" ]]; then
  {
    mkdir -p "${GH_RUNTIME_DIR}" &&
      cp "${GH_CRED_DIR}/hosts.yml" "${GH_RUNTIME_DIR}/hosts.yml" &&
      chmod 700 "${GH_RUNTIME_DIR}" &&
      chmod 600 "${GH_RUNTIME_DIR}/hosts.yml"
  } || echo "Warning: could not stage the gh credential for runtime use" >&2
  # The staged copy is the container's gh configuration, for EVERY process
  # (Issue #4220): the worker's own plumbing pointed GH_CONFIG_DIR here
  # per-call, but raw scripts — private-repo-6's repos.sh running plain `git
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
  # private-repo-6's repos.sh committing the heartbeat — inherit none, so their
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
  elif [[ -n "${SCRATCH_ROOT}" ]]; then
    # Never the image default (${DENO_DIR} baked at /home/vibe/.cache/deno):
    # that is the image layer, unwritable once the root filesystem is
    # read-only (Issue #515). Scratch is cold every launch but it works.
    export DENO_DIR="${SCRATCH_ROOT}/deno-cache"
    echo "Warning: could not use durable Deno cache at ${DENO_CACHE_DIR} — falling back to ${DENO_DIR} (cold cache every launch)" >&2
  else
    echo "Warning: could not use durable Deno cache at ${DENO_CACHE_DIR} and no scratch root is writable — falling back to the image default (cold cache every launch, and nothing at all once the root filesystem is read-only)" >&2
  fi

  # 2. Run the driver from VM-local storage instead of the virtiofs mount:
  #    the module graph is ~1,500 files and virtiofs pays a host round trip
  #    per read, every launch. One sequential copy is cheap by comparison.
  #    The mounted checkout stays the source of truth — --base-dir still
  #    points at it for repo-root assets — and a copy failure falls back
  #    loudly to running from the mount, exactly as before.
  #    It lands under the scratch root (Issue #515): ${HOME}/.worker-src was
  #    the image layer, and the tree is rm -rf'd and re-copied on every start
  #    — per-launch by construction, so scratch is exactly its class.
  LOCAL_SRC="${SCRATCH_ROOT:+${SCRATCH_ROOT}/worker-src}"
  LOCAL_SRC="${LOCAL_SRC:-${HOME}/.worker-src}"
  #    `chmod -R u+w` after the copy (Issue #514): the checkout is mounted
  #    read-only, `cp -R` carries the source's mode bits, and `rm -rf` cannot
  #    empty a directory it has no write bit on — so without this the NEXT
  #    launch's rm above fails and the worker falls back to virtiofs for ever
  #    on a runtime whose scratch root is the durable volume (Apple
  #    container takes no tmpfs).
  if rm -rf "${LOCAL_SRC}" 2>/dev/null &&
    mkdir -p "${LOCAL_SRC}/worker" 2>/dev/null &&
    cp -R "${BASE_DIR}/worker/deno" "${LOCAL_SRC}/worker/" 2>/dev/null &&
    chmod -R u+w "${LOCAL_SRC}" 2>/dev/null; then
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

# --- Deployer-supplied build-time tools: apply PATH/env (Issue #74) ---------
# install-tools.sh (#70) records the resolved tool locations in
# ${VIBE_TOOLS_PREFIX}/environment: one `PATH=<dir>` line per tool bin
# directory and one `<KEY>=<value>` line per env var (e.g. JAVA_HOME). The
# image bakes a fixed PATH deliberately (no host-specific guessing), and Docker
# does not interpolate a per-deployment set into `ENV PATH=`, so the selection
# is applied here at container start instead — before the worker and the agent
# it spawns inherit the environment.
#
# The file is deployer-derived DATA (from the verified .config.json), never
# shell: each line is parsed as KEY=value; it is never sourced or eval'd, and a
# malformed line aborts loudly rather than executing. Absent file → no change,
# so the default image's PATH is byte-identical to today's.
TOOLS_PREFIX="${VIBE_TOOLS_PREFIX:-/opt/vibe-tools}"
TOOLS_ENV_FILE="${TOOLS_PREFIX}/environment"
if [[ -f "${TOOLS_ENV_FILE}" ]]; then
  while IFS= read -r line || [[ -n "${line}" ]]; do
    # Ignore blank lines and comments.
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    if [[ "${line}" != *"="* ]]; then
      echo "Error: malformed line in ${TOOLS_ENV_FILE} (no '='): ${line}" >&2
      exit 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "Error: malformed key in ${TOOLS_ENV_FILE}: ${line}" >&2
      exit 1
    fi
    if [[ "${key}" == "PATH" ]]; then
      # Prepend the recorded bin directory to PATH.
      PATH="${value}:${PATH}"
      export PATH
    else
      export "${key}=${value}"
    fi
  done <"${TOOLS_ENV_FILE}"

  # Stamp the carried tool set so a running container can report it (mirrors
  # VIBE_IMAGE_AGENT_PROVIDERS, container/Containerfile). The installed tool
  # ids are the sub-directories of the prefix.
  applied_tools=""
  for tool_dir in "${TOOLS_PREFIX}"/*/; do
    [[ -d "${tool_dir}" ]] || continue
    # Pure-bash basename (the entrypoint tests run with a minimal PATH).
    tool_id="${tool_dir%/}"
    tool_id="${tool_id##*/}"
    applied_tools="${applied_tools:+${applied_tools},}${tool_id}"
  done
  export VIBE_IMAGE_CONTAINER_TOOLS="${applied_tools}"
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
