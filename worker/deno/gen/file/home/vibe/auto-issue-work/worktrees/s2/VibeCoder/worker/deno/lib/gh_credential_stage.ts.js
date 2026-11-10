/**
 * Staging and re-staging the worker's writable `gh` configuration
 * (Issue #564).
 *
 * `gh` performs a config-migration WRITE on first use, so `GH_CONFIG_DIR`
 * must point at something writable — and the credential itself arrives on a
 * read-only mount. The container entrypoint therefore copies `hosts.yml` out
 * of the mount at launch, and this module is what keeps that copy honest for
 * the rest of the run.
 *
 * It exists because the copy went missing. Staged under `/tmp` (mode 1777 —
 * also the coding agents' scratch and TMPDIR, holding 2860 directories their
 * test suites had left), it was deleted fourteen minutes into a run. Every
 * `gh` call and every `git push` failed from that moment, and the run died
 * with the intact credential sitting on its mount, unread. The entrypoint
 * now stages onto the durable state root instead — and the worker, which is
 * the process that suffers, re-stages for itself rather than dying:
 *
 * - the **mount** is the source of truth and is always present, so a copy
 *   that is absent, empty or unwritable is rebuilt from it — never from the
 *   broken copy, which is what the Issue #554 fallback tried and could not
 *   do;
 * - the staging targets are private and ordered: the durable state root
 *   first, then scratch, then a per-account directory under `TMPDIR`, so the
 *   copy follows the entrypoint's own policy;
 * - re-staging is bounded (see {@link MAX_RESTAGE_ATTEMPTS}) so a genuinely
 *   revoked token fails loudly instead of spinning.
 *
 * On a **host** run neither `VIBE_STATE_DIR` nor `VIBE_SCRATCH_DIR` is set —
 * the container entrypoint exports them, `loop.sh` does not — so `TMPDIR` is
 * the only candidate, and `/tmp` is shared with every other local account
 * (Issue #1282). The staging therefore binds the copy to this account before
 * the token touches the disk:
 *
 * - the directory is per-account ({@link sharedTmpStateDir}) and created
 *   non-recursively at {@link PRIVATE_DIR_MODE}, so a pre-existing path is
 *   inspected rather than adopted;
 * - a directory that is not ours — a symlink, a file, another uid's, or one
 *   with group/other bits — is **refused loudly** for that candidate instead
 *   of being written into and chmod'd afterwards;
 * - `hosts.yml` is unlinked and then created exclusively at
 *   {@link STAGED_HOSTS_MODE}, so a planted symlink is dropped rather than
 *   followed and there is no world-readable window between the write and a
 *   later `chmod`;
 * - a directory this process created is removed when the run ends
 *   ({@link removeStagedGhConfigDirs}), so the credential does not outlive
 *   the worker.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */ import { DEFAULT_CREDENTIAL_DIR_SUFFIX, GH_CREDENTIAL_SUBDIR, GH_HOSTS_FILE, SCRATCH_DIR_ENV } from "./credential_preflight.ts";
import { PRIVATE_DIR_MODE, resolveOwnUid, sharedTmpStateDir } from "./private_cache_dir.ts";
/** Environment variable naming the container's durable state root. */ export const STATE_DIR_ENV = "VIBE_STATE_DIR";
/** Leaf directory the worker stages its own copy into. */ export const STAGED_GH_DIR_NAME = "gh-config";
/** Mode the staged `hosts.yml` is created with: owner read/write only. */ export const STAGED_HOSTS_MODE = 0o600;
/**
 * Re-stagings one process will perform.
 *
 * A copy that keeps vanishing is a fault to report, not to paper over; and a
 * revoked or expired token would otherwise re-stage on every call for the
 * life of the run.
 */ export const MAX_RESTAGE_ATTEMPTS = 3;
const productionIo = {
  readFile (path) {
    try {
      return Deno.readFileSync(path);
    } catch  {
      return null;
    }
  },
  writePrivateFile (path, data, mode) {
    // `createNew` plus `mode`: the credential is never on disk at the umask
    // default, and an exclusive create cannot be redirected by a symlink
    // planted between the unlink and this call (Issue #1282).
    Deno.writeFileSync(path, data, {
      mode,
      createNew: true
    });
  },
  makePrivateDir (path, mode) {
    // The leaf is created non-recursively with `mode` applied at creation, so
    // a directory that already exists is reported (EEXIST) rather than
    // silently adopted — including one that appeared since the `lstat`.
    // Missing parents are still created: a staging root the entrypoint chose
    // always exists, but the leaf is the only directory the credential lands
    // in and the only one whose mode matters.
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent.length > 0) Deno.mkdirSync(parent, {
      recursive: true
    });
    Deno.mkdirSync(path, {
      recursive: false,
      mode
    });
  },
  lstat (path) {
    try {
      const info = Deno.lstatSync(path);
      return {
        directory: info.isDirectory,
        uid: info.uid,
        mode: info.mode === null ? null : info.mode & 0o7777
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  },
  remove (path, recursive = false) {
    try {
      Deno.removeSync(path, {
        recursive
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  },
  ownerUid () {
    // Stats `$HOME` rather than calling `Deno.uid()`, which needs an
    // `--allow-sys=uid` grant the worker does not hold.
    return resolveOwnUid();
  },
  isWritableDir (path) {
    // A fixed probe name is an arbitrary-truncation primitive on every path
    // this probes (Issue #1238): `writeTextFileSync` is O_CREAT|O_TRUNC and
    // follows symlinks, so a link planted at the predictable name was
    // followed and its target truncated — and the probe then removed the
    // link, leaving the damage with nothing to show for it. A kernel-random
    // name cannot be pre-positioned, and `createNew` refuses anything already
    // at the name rather than opening it.
    const probe = `${path}/.vibe-write-probe.${crypto.randomUUID()}`;
    try {
      Deno.openSync(probe, {
        write: true,
        createNew: true,
        mode: STAGED_HOSTS_MODE
      }).close();
      Deno.removeSync(probe);
      return true;
    } catch  {
      return false;
    }
  }
};
function defaultEnv(name) {
  try {
    return Deno.env.get(name);
  } catch  {
    return undefined;
  }
}
/**
 * The read-only credential mount `hosts.yml` — the source of truth.
 *
 * @param home - Worker home directory.
 */ export function mountedHostsPath(home) {
  return `${home}/${DEFAULT_CREDENTIAL_DIR_SUFFIX}/${GH_CREDENTIAL_SUBDIR}/` + GH_HOSTS_FILE;
}
/**
 * Whether a `GH_CONFIG_DIR` can actually serve a `gh` call.
 *
 * Present, non-empty and writable — an empty `hosts.yml` authenticates
 * nothing, and the Issue #554 fallback left exactly that behind when its
 * copy failed.
 */ export function isGhConfigDirUsable(dir, io = productionIo) {
  if (!dir) return false;
  const hosts = io.readFile(`${dir}/${GH_HOSTS_FILE}`);
  if (hosts === null || hosts.length === 0) return false;
  return io.isWritableDir(dir);
}
/**
 * Staging candidates in preference order, mirroring the entrypoint's policy.
 *
 * The durable state root first — it is the worker's own, and not the `/tmp`
 * the agents churn. Scratch and `TMPDIR` follow so a host without a state
 * root still authenticates.
 *
 * The `TMPDIR` candidate is per-account ({@link sharedTmpStateDir}, Issue
 * #1215): `/tmp/vibe-gh-config` was the same path for every local account on
 * a shared host, so whoever created it first owned what the worker staged
 * into it (Issue #1282).
 */ export function stagingCandidates(env = defaultEnv) {
  const state = env(STATE_DIR_ENV);
  const scratch = env(SCRATCH_DIR_ENV);
  return [
    state ? `${state}/${STAGED_GH_DIR_NAME}` : undefined,
    scratch ? `${scratch}/${STAGED_GH_DIR_NAME}` : undefined,
    sharedTmpStateDir(`vibe-${STAGED_GH_DIR_NAME}`, env)
  ].filter((dir)=>dir !== undefined);
}
/**
 * Why a pre-existing staging path is not the worker's own, or null when it
 * is (Issue #1282).
 *
 * Exported so the refusal is testable against literal stats: a symlink or a
 * file where the directory should be, another account's directory, or one
 * any local account can write into are all paths the credential must not be
 * copied to.
 *
 * @param stat - What `lstat` reported for the candidate.
 * @param ownUid - This account's uid, or null when it cannot be determined.
 * @returns The refusal reason, or null when the path may be staged into.
 */ export function stagingDirRefusal(stat, ownUid) {
  if (!stat.directory) {
    return "the path is not a directory (a symlink or file occupies it)";
  }
  if (ownUid !== null && stat.uid !== null && stat.uid !== ownUid) {
    return `the directory is owned by uid ${stat.uid}, not this account ` + `(uid ${ownUid})`;
  }
  if (stat.mode !== null && (stat.mode & 0o077) !== 0) {
    const octal = stat.mode.toString(8).padStart(4, "0");
    return `the directory is group/other accessible (mode ${octal}, ` + "expected 0700)";
  }
  return null;
}
/**
 * Directories this process created, removed when the run ends.
 *
 * Only what this process created: a directory the entrypoint or a sibling
 * worker staged is still in use and is not ours to delete.
 */ const createdStagingDirs = new Set();
let runEndCleanupRegistered = false;
/**
 * Remove the staging directories this process created (Issue #1282).
 *
 * Registered on `unload` by the first successful staging, so the credential
 * does not outlive the run on a shared host; exported so a caller — or a
 * test — can trigger the removal itself.
 *
 * @returns The directories actually removed.
 */ export function removeStagedGhConfigDirs(options = {}) {
  const io = options.io ?? productionIo;
  const warn = options.warn ?? ((message)=>console.error(message));
  const removed = [];
  for (const dir of createdStagingDirs){
    try {
      io.remove(dir, true);
      removed.push(dir);
    } catch (error) {
      warn(`[SECURITY] could not remove the staged gh credential at ${dir}: ` + describeError(error));
    }
  }
  createdStagingDirs.clear();
  return removed;
}
/** Note a directory this process created, and arm the run-end removal. */ function rememberCreatedStagingDir(dir) {
  createdStagingDirs.add(dir);
  if (runEndCleanupRegistered) return;
  runEndCleanupRegistered = true;
  globalThis.addEventListener("unload", ()=>{
    removeStagedGhConfigDirs();
  });
}
/** The message of a thrown value, whatever it turned out to be. */ function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
/**
 * Make `candidate` a directory this account owns, or throw saying why not.
 *
 * @returns True when this call created it — and so owns removing it.
 */ function prepareStagingDir(candidate, io) {
  const existing = io.lstat(candidate);
  if (existing === null) {
    io.makePrivateDir(candidate, PRIVATE_DIR_MODE);
    return true;
  }
  const refusal = stagingDirRefusal(existing, io.ownerUid());
  if (refusal !== null) throw new Error(refusal);
  return false;
}
/** Write `hosts.yml` into a prepared staging directory, 0600 from birth. */ function writeStagedCredential(candidate, source, io) {
  const hosts = `${candidate}/${GH_HOSTS_FILE}`;
  // Unlink first so a planted symlink is dropped rather than followed; the
  // exclusive create then fails loudly if anything reappears in between.
  io.remove(hosts);
  io.writePrivateFile(hosts, source, STAGED_HOSTS_MODE);
}
/**
 * Rebuild the writable `gh` configuration from the read-only mount.
 *
 * @returns The staged directory, or null when the mount holds no credential
 *   or nowhere is writable — both of which the caller must report rather
 *   than retry.
 */ export function restageGhConfigDir(options = {}) {
  const env = options.env ?? defaultEnv;
  const io = options.io ?? productionIo;
  const home = options.home ?? env("HOME") ?? "";
  const warn = options.warn ?? ((message)=>console.error(message));
  const source = io.readFile(mountedHostsPath(home));
  if (source === null || source.length === 0) {
    // Nothing to re-stage from: this is a credential problem, not a staging
    // problem, and the preflight's message is the one that should be read.
    warn(`[SECURITY] cannot re-stage the gh credential: ${mountedHostsPath(home)} is missing or empty`);
    return null;
  }
  for (const candidate of stagingCandidates(env)){
    let created = false;
    try {
      created = prepareStagingDir(candidate, io);
      writeStagedCredential(candidate, source, io);
    } catch (error) {
      // Loud, and per candidate (Issue #1282): a refusal here is either a
      // directory that is not this account's or a genuinely unusable
      // candidate, and the old silent catch hid both — after the token had
      // already been written.
      warn(`[SECURITY] refusing to stage the gh credential at ${candidate}: ` + describeError(error));
      continue;
    }
    if (created) rememberCreatedStagingDir(candidate);
    if (!isGhConfigDirUsable(candidate, io)) continue;
    warn(`[SECURITY] re-staged the gh credential from the read-only mount to ` + `${candidate} (Issue #564)`);
    return candidate;
  }
  warn("[SECURITY] cannot re-stage the gh credential: no writable staging " + `directory (tried ${stagingCandidates(env).join(", ")})`);
  return null;
}
/**
 * Decide what `GH_CONFIG_DIR` should be, **without writing the process
 * environment** (Issue #967).
 *
 * The re-stage itself still copies `hosts.yml` out of the read-only mount —
 * that is the point of it — but the resulting variable is returned rather
 * than applied, so a test can assert on the map without mutating state every
 * other parallel worker shares. {@link ensureUsableGhConfigDir} is this
 * function plus the application step.
 *
 * @param options - Home, environment lookup, filesystem seams and warn sink.
 * @returns Whether the configuration is usable, and what to establish.
 */ export function resolveUsableGhConfigDir(options = {}) {
  const env = options.env ?? defaultEnv;
  const io = options.io ?? productionIo;
  const current = env("GH_CONFIG_DIR");
  if (isGhConfigDirUsable(current, io)) return {
    usable: true,
    env: {}
  };
  const staged = restageGhConfigDir(options);
  if (staged === null) return {
    usable: false,
    env: {}
  };
  return {
    usable: true,
    env: {
      GH_CONFIG_DIR: staged
    }
  };
}
/** Apply one variable to the process, tolerating a permission denial. */ function processSetEnv(name, value) {
  try {
    Deno.env.set(name, value);
  } catch  {
  // A test environment without env-set permission still gets the copy.
  }
}
/**
 * Ensure `GH_CONFIG_DIR` names a usable directory, re-staging if it does not.
 *
 * Applies the result to the run environment so every child `gh` and `git`
 * inherits it.
 *
 * @returns True when the environment now points at a usable configuration.
 */ export function ensureUsableGhConfigDir(options = {}) {
  const resolution = resolveUsableGhConfigDir(options);
  const setEnv = options.setEnv ?? processSetEnv;
  for (const [name, value] of Object.entries(resolution.env)){
    setEnv(name, value);
  }
  return resolution.usable;
}
/** True when a finished `gh` call failed because it had no authentication. */ export function isGhAuthMissingFailure(result) {
  if (result.code === 0) return false;
  const stderr = result.stderr.toLowerCase();
  return stderr.includes("gh auth login") || stderr.includes("no accounts configured") || stderr.includes("authentication token not found");
}
// ---------------------------------------------------------------------------
// The git half (Issue #564, second failure)
// ---------------------------------------------------------------------------
/**
 * True when a finished `git` call failed for want of credentials or identity.
 *
 * `gh` and `git` fail differently and independently — a run was found with a
 * working `gh api user` and a `git fetch` that could not authenticate, because
 * the staged global config had been reduced to its `safe.directory` line while
 * `hosts.yml` was intact. Recognising only the `gh` shape misses that entirely.
 */ export function isGitAuthMissingFailure(result) {
  if (result.code === 0) return false;
  const stderr = result.stderr.toLowerCase();
  return stderr.includes("could not read username") || stderr.includes("terminal prompts disabled") || stderr.includes("please tell me who you are") || stderr.includes("unable to auto-detect email address") || stderr.includes("authentication failed");
}
/**
 * The global git configuration the container needs, rebuilt from the mount.
 *
 * Mirrors `container/entrypoint.sh`: SSH remotes rewritten to HTTPS, `gh` as
 * the credential helper, and an identity taken from the mounted credential.
 * Returns an empty list when the mount names no user — nothing is guessed.
 *
 * @param login - The service-account login, from the mounted `hosts.yml`.
 */ export function gitGlobalConfigEntries(login) {
  const entries = [
    {
      args: [
        "--global",
        "--add",
        "safe.directory",
        "*"
      ],
      add: true
    },
    // --replace-all, not a plain set (Issue #635). Both of these keys are
    // multi-valued — the entrypoint adds a second value to each — and the
    // global config now survives the run in ${STATE_ROOT}/gitconfig. A plain
    // set against an existing multi-valued key fails with "cannot overwrite
    // multiple values with a single value", which would make this repair path
    // fail in exactly the situation it exists to repair.
    {
      args: [
        "--global",
        "--replace-all",
        "url.https://github.com/.insteadOf",
        "git@github.com:"
      ]
    },
    {
      args: [
        "--global",
        "--replace-all",
        "credential.https://github.com.helper",
        ""
      ]
    },
    {
      args: [
        "--global",
        "--add",
        "credential.https://github.com.helper",
        "!gh auth git-credential"
      ],
      add: true
    }
  ];
  if (login) {
    entries.push({
      args: [
        "--global",
        "user.name",
        login
      ]
    });
    entries.push({
      args: [
        "--global",
        "user.email",
        `${login}@users.noreply.github.com`
      ]
    });
  }
  return entries;
}
/**
 * The service-account login recorded in the mounted `hosts.yml`.
 *
 * The same `sed` the entrypoint uses, in TypeScript: the first `user:` line.
 */ export function mountedGitLogin(home, io = productionIo) {
  const raw = io.readFile(mountedHostsPath(home));
  if (raw === null) return null;
  const text = new TextDecoder().decode(raw);
  const match = text.match(/^\s*user:\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9jcmVkZW50aWFsX3N0YWdlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU3RhZ2luZyBhbmQgcmUtc3RhZ2luZyB0aGUgd29ya2VyJ3Mgd3JpdGFibGUgYGdoYCBjb25maWd1cmF0aW9uXG4gKiAoSXNzdWUgIzU2NCkuXG4gKlxuICogYGdoYCBwZXJmb3JtcyBhIGNvbmZpZy1taWdyYXRpb24gV1JJVEUgb24gZmlyc3QgdXNlLCBzbyBgR0hfQ09ORklHX0RJUmBcbiAqIG11c3QgcG9pbnQgYXQgc29tZXRoaW5nIHdyaXRhYmxlIOKAlCBhbmQgdGhlIGNyZWRlbnRpYWwgaXRzZWxmIGFycml2ZXMgb24gYVxuICogcmVhZC1vbmx5IG1vdW50LiBUaGUgY29udGFpbmVyIGVudHJ5cG9pbnQgdGhlcmVmb3JlIGNvcGllcyBgaG9zdHMueW1sYCBvdXRcbiAqIG9mIHRoZSBtb3VudCBhdCBsYXVuY2gsIGFuZCB0aGlzIG1vZHVsZSBpcyB3aGF0IGtlZXBzIHRoYXQgY29weSBob25lc3QgZm9yXG4gKiB0aGUgcmVzdCBvZiB0aGUgcnVuLlxuICpcbiAqIEl0IGV4aXN0cyBiZWNhdXNlIHRoZSBjb3B5IHdlbnQgbWlzc2luZy4gU3RhZ2VkIHVuZGVyIGAvdG1wYCAobW9kZSAxNzc3IOKAlFxuICogYWxzbyB0aGUgY29kaW5nIGFnZW50cycgc2NyYXRjaCBhbmQgVE1QRElSLCBob2xkaW5nIDI4NjAgZGlyZWN0b3JpZXMgdGhlaXJcbiAqIHRlc3Qgc3VpdGVzIGhhZCBsZWZ0KSwgaXQgd2FzIGRlbGV0ZWQgZm91cnRlZW4gbWludXRlcyBpbnRvIGEgcnVuLiBFdmVyeVxuICogYGdoYCBjYWxsIGFuZCBldmVyeSBgZ2l0IHB1c2hgIGZhaWxlZCBmcm9tIHRoYXQgbW9tZW50LCBhbmQgdGhlIHJ1biBkaWVkXG4gKiB3aXRoIHRoZSBpbnRhY3QgY3JlZGVudGlhbCBzaXR0aW5nIG9uIGl0cyBtb3VudCwgdW5yZWFkLiBUaGUgZW50cnlwb2ludFxuICogbm93IHN0YWdlcyBvbnRvIHRoZSBkdXJhYmxlIHN0YXRlIHJvb3QgaW5zdGVhZCDigJQgYW5kIHRoZSB3b3JrZXIsIHdoaWNoIGlzXG4gKiB0aGUgcHJvY2VzcyB0aGF0IHN1ZmZlcnMsIHJlLXN0YWdlcyBmb3IgaXRzZWxmIHJhdGhlciB0aGFuIGR5aW5nOlxuICpcbiAqIC0gdGhlICoqbW91bnQqKiBpcyB0aGUgc291cmNlIG9mIHRydXRoIGFuZCBpcyBhbHdheXMgcHJlc2VudCwgc28gYSBjb3B5XG4gKiAgIHRoYXQgaXMgYWJzZW50LCBlbXB0eSBvciB1bndyaXRhYmxlIGlzIHJlYnVpbHQgZnJvbSBpdCDigJQgbmV2ZXIgZnJvbSB0aGVcbiAqICAgYnJva2VuIGNvcHksIHdoaWNoIGlzIHdoYXQgdGhlIElzc3VlICM1NTQgZmFsbGJhY2sgdHJpZWQgYW5kIGNvdWxkIG5vdFxuICogICBkbztcbiAqIC0gdGhlIHN0YWdpbmcgdGFyZ2V0cyBhcmUgcHJpdmF0ZSBhbmQgb3JkZXJlZDogdGhlIGR1cmFibGUgc3RhdGUgcm9vdFxuICogICBmaXJzdCwgdGhlbiBzY3JhdGNoLCB0aGVuIGEgcGVyLWFjY291bnQgZGlyZWN0b3J5IHVuZGVyIGBUTVBESVJgLCBzbyB0aGVcbiAqICAgY29weSBmb2xsb3dzIHRoZSBlbnRyeXBvaW50J3Mgb3duIHBvbGljeTtcbiAqIC0gcmUtc3RhZ2luZyBpcyBib3VuZGVkIChzZWUge0BsaW5rIE1BWF9SRVNUQUdFX0FUVEVNUFRTfSkgc28gYSBnZW51aW5lbHlcbiAqICAgcmV2b2tlZCB0b2tlbiBmYWlscyBsb3VkbHkgaW5zdGVhZCBvZiBzcGlubmluZy5cbiAqXG4gKiBPbiBhICoqaG9zdCoqIHJ1biBuZWl0aGVyIGBWSUJFX1NUQVRFX0RJUmAgbm9yIGBWSUJFX1NDUkFUQ0hfRElSYCBpcyBzZXQg4oCUXG4gKiB0aGUgY29udGFpbmVyIGVudHJ5cG9pbnQgZXhwb3J0cyB0aGVtLCBgbG9vcC5zaGAgZG9lcyBub3Qg4oCUIHNvIGBUTVBESVJgIGlzXG4gKiB0aGUgb25seSBjYW5kaWRhdGUsIGFuZCBgL3RtcGAgaXMgc2hhcmVkIHdpdGggZXZlcnkgb3RoZXIgbG9jYWwgYWNjb3VudFxuICogKElzc3VlICMxMjgyKS4gVGhlIHN0YWdpbmcgdGhlcmVmb3JlIGJpbmRzIHRoZSBjb3B5IHRvIHRoaXMgYWNjb3VudCBiZWZvcmVcbiAqIHRoZSB0b2tlbiB0b3VjaGVzIHRoZSBkaXNrOlxuICpcbiAqIC0gdGhlIGRpcmVjdG9yeSBpcyBwZXItYWNjb3VudCAoe0BsaW5rIHNoYXJlZFRtcFN0YXRlRGlyfSkgYW5kIGNyZWF0ZWRcbiAqICAgbm9uLXJlY3Vyc2l2ZWx5IGF0IHtAbGluayBQUklWQVRFX0RJUl9NT0RFfSwgc28gYSBwcmUtZXhpc3RpbmcgcGF0aCBpc1xuICogICBpbnNwZWN0ZWQgcmF0aGVyIHRoYW4gYWRvcHRlZDtcbiAqIC0gYSBkaXJlY3RvcnkgdGhhdCBpcyBub3Qgb3VycyDigJQgYSBzeW1saW5rLCBhIGZpbGUsIGFub3RoZXIgdWlkJ3MsIG9yIG9uZVxuICogICB3aXRoIGdyb3VwL290aGVyIGJpdHMg4oCUIGlzICoqcmVmdXNlZCBsb3VkbHkqKiBmb3IgdGhhdCBjYW5kaWRhdGUgaW5zdGVhZFxuICogICBvZiBiZWluZyB3cml0dGVuIGludG8gYW5kIGNobW9kJ2QgYWZ0ZXJ3YXJkcztcbiAqIC0gYGhvc3RzLnltbGAgaXMgdW5saW5rZWQgYW5kIHRoZW4gY3JlYXRlZCBleGNsdXNpdmVseSBhdFxuICogICB7QGxpbmsgU1RBR0VEX0hPU1RTX01PREV9LCBzbyBhIHBsYW50ZWQgc3ltbGluayBpcyBkcm9wcGVkIHJhdGhlciB0aGFuXG4gKiAgIGZvbGxvd2VkIGFuZCB0aGVyZSBpcyBubyB3b3JsZC1yZWFkYWJsZSB3aW5kb3cgYmV0d2VlbiB0aGUgd3JpdGUgYW5kIGFcbiAqICAgbGF0ZXIgYGNobW9kYDtcbiAqIC0gYSBkaXJlY3RvcnkgdGhpcyBwcm9jZXNzIGNyZWF0ZWQgaXMgcmVtb3ZlZCB3aGVuIHRoZSBydW4gZW5kc1xuICogICAoe0BsaW5rIHJlbW92ZVN0YWdlZEdoQ29uZmlnRGlyc30pLCBzbyB0aGUgY3JlZGVudGlhbCBkb2VzIG5vdCBvdXRsaXZlXG4gKiAgIHRoZSB3b3JrZXIuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgYXV0aG9yaXNlZCkuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9DUkVERU5USUFMX0RJUl9TVUZGSVgsXG4gIEdIX0NSRURFTlRJQUxfU1VCRElSLFxuICBHSF9IT1NUU19GSUxFLFxuICBTQ1JBVENIX0RJUl9FTlYsXG59IGZyb20gXCIuL2NyZWRlbnRpYWxfcHJlZmxpZ2h0LnRzXCI7XG5pbXBvcnQgdHlwZSB7IEVudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcbmltcG9ydCB7XG4gIFBSSVZBVEVfRElSX01PREUsXG4gIHJlc29sdmVPd25VaWQsXG4gIHNoYXJlZFRtcFN0YXRlRGlyLFxufSBmcm9tIFwiLi9wcml2YXRlX2NhY2hlX2Rpci50c1wiO1xuXG4vKiogRW52aXJvbm1lbnQgdmFyaWFibGUgbmFtaW5nIHRoZSBjb250YWluZXIncyBkdXJhYmxlIHN0YXRlIHJvb3QuICovXG5leHBvcnQgY29uc3QgU1RBVEVfRElSX0VOViA9IFwiVklCRV9TVEFURV9ESVJcIjtcblxuLyoqIExlYWYgZGlyZWN0b3J5IHRoZSB3b3JrZXIgc3RhZ2VzIGl0cyBvd24gY29weSBpbnRvLiAqL1xuZXhwb3J0IGNvbnN0IFNUQUdFRF9HSF9ESVJfTkFNRSA9IFwiZ2gtY29uZmlnXCI7XG5cbi8qKiBNb2RlIHRoZSBzdGFnZWQgYGhvc3RzLnltbGAgaXMgY3JlYXRlZCB3aXRoOiBvd25lciByZWFkL3dyaXRlIG9ubHkuICovXG5leHBvcnQgY29uc3QgU1RBR0VEX0hPU1RTX01PREUgPSAwbzYwMDtcblxuLyoqXG4gKiBSZS1zdGFnaW5ncyBvbmUgcHJvY2VzcyB3aWxsIHBlcmZvcm0uXG4gKlxuICogQSBjb3B5IHRoYXQga2VlcHMgdmFuaXNoaW5nIGlzIGEgZmF1bHQgdG8gcmVwb3J0LCBub3QgdG8gcGFwZXIgb3ZlcjsgYW5kIGFcbiAqIHJldm9rZWQgb3IgZXhwaXJlZCB0b2tlbiB3b3VsZCBvdGhlcndpc2UgcmUtc3RhZ2Ugb24gZXZlcnkgY2FsbCBmb3IgdGhlXG4gKiBsaWZlIG9mIHRoZSBydW4uXG4gKi9cbmV4cG9ydCBjb25zdCBNQVhfUkVTVEFHRV9BVFRFTVBUUyA9IDM7XG5cbi8qKiBXaGF0IGFuIGBsc3RhdGAgb2YgYSBzdGFnaW5nIHBhdGggc2hvd3M7IGEgc3ltbGluayBpcyBuZXZlciBmb2xsb3dlZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RhZ2VkUGF0aFN0YXQge1xuICAvKiogVHJ1ZSBvbmx5IGZvciBhIHJlYWwgZGlyZWN0b3J5IOKAlCBhIHN5bWxpbmsgdG8gb25lIGlzIG5vdCBhIGRpcmVjdG9yeS4gKi9cbiAgZGlyZWN0b3J5OiBib29sZWFuO1xuICAvKiogT3duaW5nIHVpZCwgb3IgbnVsbCB3aGVuIHRoZSBwbGF0Zm9ybSBkb2VzIG5vdCByZXBvcnQgb25lLiAqL1xuICB1aWQ6IG51bWJlciB8IG51bGw7XG4gIC8qKiBQZXJtaXNzaW9uIGJpdHMgKGBtb2RlICYgMG83Nzc3YCksIG9yIG51bGwgd2hlbiB1bmF2YWlsYWJsZS4gKi9cbiAgbW9kZTogbnVtYmVyIHwgbnVsbDtcbn1cblxuLyoqIEZpbGVzeXN0ZW0gc2VhbXMsIGluamVjdGVkIHNvIHRoZSB0ZXN0cyBuZXZlciB0b3VjaCBhIHJlYWwgY3JlZGVudGlhbC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2hDcmVkZW50aWFsU3RhZ2VJbyB7XG4gIHJlYWRGaWxlOiAocGF0aDogc3RyaW5nKSA9PiBVaW50OEFycmF5IHwgbnVsbDtcbiAgLyoqXG4gICAqIENyZWF0ZSBgcGF0aGAgZXhjbHVzaXZlbHkgd2l0aCBgbW9kZWAgYXBwbGllZCBhdCBjcmVhdGlvbi4gVGhyb3dzIHdoZW5cbiAgICogYW55dGhpbmcgYWxyZWFkeSBvY2N1cGllcyB0aGUgcGF0aCDigJQgbmV2ZXIgdHJ1bmNhdGVzLCBuZXZlciBmb2xsb3dzIGFcbiAgICogc3ltbGluayBpbnRvIHNvbWV3aGVyZSBlbHNlLlxuICAgKi9cbiAgd3JpdGVQcml2YXRlRmlsZTogKHBhdGg6IHN0cmluZywgZGF0YTogVWludDhBcnJheSwgbW9kZTogbnVtYmVyKSA9PiB2b2lkO1xuICAvKiogQ3JlYXRlIGBwYXRoYCBub24tcmVjdXJzaXZlbHkgd2l0aCBgbW9kZWA7IHRocm93cyB3aGVuIGl0IGV4aXN0cy4gKi9cbiAgbWFrZVByaXZhdGVEaXI6IChwYXRoOiBzdHJpbmcsIG1vZGU6IG51bWJlcikgPT4gdm9pZDtcbiAgLyoqIGBsc3RhdGAgdGhlIHBhdGg6IG51bGwgd2hlbiBhYnNlbnQsIHN5bWxpbmtzIHJlcG9ydGVkIGFzIHRoZW1zZWx2ZXMuICovXG4gIGxzdGF0OiAocGF0aDogc3RyaW5nKSA9PiBTdGFnZWRQYXRoU3RhdCB8IG51bGw7XG4gIC8qKiBSZW1vdmUgYSBwYXRoLCB0b2xlcmF0aW5nIGFuIGFic2VudCBvbmU7IG5ldmVyIGZvbGxvd3MgYSBzeW1saW5rLiAqL1xuICByZW1vdmU6IChwYXRoOiBzdHJpbmcsIHJlY3Vyc2l2ZT86IGJvb2xlYW4pID0+IHZvaWQ7XG4gIC8qKiB1aWQgb2YgdGhlIGFjY291bnQgcnVubmluZyB0aGUgd29ya2VyLCBvciBudWxsIHdoZW4gdW5rbm93bi4gKi9cbiAgb3duZXJVaWQ6ICgpID0+IG51bWJlciB8IG51bGw7XG4gIGlzV3JpdGFibGVEaXI6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XG59XG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgcmVzdGFnZUdoQ29uZmlnRGlyfSwgYWxsIHNlYW1zIGRlZmF1bHRlZCB0byBwcm9kdWN0aW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZXN0YWdlT3B0aW9ucyB7XG4gIC8qKiBXb3JrZXIgaG9tZSBkaXJlY3Rvcnk7IGRlZmF1bHRzIHRvIGAkSE9NRWAuICovXG4gIGhvbWU/OiBzdHJpbmc7XG4gIC8qKiBFbnZpcm9ubWVudCBsb29rdXAsIGluamVjdGFibGUgZm9yIHRlc3RzLiAqL1xuICBlbnY/OiBFbnZMb29rdXA7XG4gIGlvPzogR2hDcmVkZW50aWFsU3RhZ2VJbztcbiAgLyoqIFdoZXJlIGEgd2FybmluZyBnb2VzOyBkZWZhdWx0cyB0byBzdGRlcnIuICovXG4gIHdhcm4/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG5jb25zdCBwcm9kdWN0aW9uSW86IEdoQ3JlZGVudGlhbFN0YWdlSW8gPSB7XG4gIHJlYWRGaWxlKHBhdGgpIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIERlbm8ucmVhZEZpbGVTeW5jKHBhdGgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9LFxuICB3cml0ZVByaXZhdGVGaWxlKHBhdGgsIGRhdGEsIG1vZGUpIHtcbiAgICAvLyBgY3JlYXRlTmV3YCBwbHVzIGBtb2RlYDogdGhlIGNyZWRlbnRpYWwgaXMgbmV2ZXIgb24gZGlzayBhdCB0aGUgdW1hc2tcbiAgICAvLyBkZWZhdWx0LCBhbmQgYW4gZXhjbHVzaXZlIGNyZWF0ZSBjYW5ub3QgYmUgcmVkaXJlY3RlZCBieSBhIHN5bWxpbmtcbiAgICAvLyBwbGFudGVkIGJldHdlZW4gdGhlIHVubGluayBhbmQgdGhpcyBjYWxsIChJc3N1ZSAjMTI4MikuXG4gICAgRGVuby53cml0ZUZpbGVTeW5jKHBhdGgsIGRhdGEsIHsgbW9kZSwgY3JlYXRlTmV3OiB0cnVlIH0pO1xuICB9LFxuICBtYWtlUHJpdmF0ZURpcihwYXRoLCBtb2RlKSB7XG4gICAgLy8gVGhlIGxlYWYgaXMgY3JlYXRlZCBub24tcmVjdXJzaXZlbHkgd2l0aCBgbW9kZWAgYXBwbGllZCBhdCBjcmVhdGlvbiwgc29cbiAgICAvLyBhIGRpcmVjdG9yeSB0aGF0IGFscmVhZHkgZXhpc3RzIGlzIHJlcG9ydGVkIChFRVhJU1QpIHJhdGhlciB0aGFuXG4gICAgLy8gc2lsZW50bHkgYWRvcHRlZCDigJQgaW5jbHVkaW5nIG9uZSB0aGF0IGFwcGVhcmVkIHNpbmNlIHRoZSBgbHN0YXRgLlxuICAgIC8vIE1pc3NpbmcgcGFyZW50cyBhcmUgc3RpbGwgY3JlYXRlZDogYSBzdGFnaW5nIHJvb3QgdGhlIGVudHJ5cG9pbnQgY2hvc2VcbiAgICAvLyBhbHdheXMgZXhpc3RzLCBidXQgdGhlIGxlYWYgaXMgdGhlIG9ubHkgZGlyZWN0b3J5IHRoZSBjcmVkZW50aWFsIGxhbmRzXG4gICAgLy8gaW4gYW5kIHRoZSBvbmx5IG9uZSB3aG9zZSBtb2RlIG1hdHRlcnMuXG4gICAgY29uc3QgcGFyZW50ID0gcGF0aC5zbGljZSgwLCBwYXRoLmxhc3RJbmRleE9mKFwiL1wiKSk7XG4gICAgaWYgKHBhcmVudC5sZW5ndGggPiAwKSBEZW5vLm1rZGlyU3luYyhwYXJlbnQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIERlbm8ubWtkaXJTeW5jKHBhdGgsIHsgcmVjdXJzaXZlOiBmYWxzZSwgbW9kZSB9KTtcbiAgfSxcbiAgbHN0YXQocGF0aCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpbmZvID0gRGVuby5sc3RhdFN5bmMocGF0aCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBkaXJlY3Rvcnk6IGluZm8uaXNEaXJlY3RvcnksXG4gICAgICAgIHVpZDogaW5mby51aWQsXG4gICAgICAgIG1vZGU6IGluZm8ubW9kZSA9PT0gbnVsbCA/IG51bGwgOiBpbmZvLm1vZGUgJiAwbzc3NzcsXG4gICAgICB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIG51bGw7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH0sXG4gIHJlbW92ZShwYXRoLCByZWN1cnNpdmUgPSBmYWxzZSkge1xuICAgIHRyeSB7XG4gICAgICBEZW5vLnJlbW92ZVN5bmMocGF0aCwgeyByZWN1cnNpdmUgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSByZXR1cm47XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH0sXG4gIG93bmVyVWlkKCkge1xuICAgIC8vIFN0YXRzIGAkSE9NRWAgcmF0aGVyIHRoYW4gY2FsbGluZyBgRGVuby51aWQoKWAsIHdoaWNoIG5lZWRzIGFuXG4gICAgLy8gYC0tYWxsb3ctc3lzPXVpZGAgZ3JhbnQgdGhlIHdvcmtlciBkb2VzIG5vdCBob2xkLlxuICAgIHJldHVybiByZXNvbHZlT3duVWlkKCk7XG4gIH0sXG4gIGlzV3JpdGFibGVEaXIocGF0aCkge1xuICAgIC8vIEEgZml4ZWQgcHJvYmUgbmFtZSBpcyBhbiBhcmJpdHJhcnktdHJ1bmNhdGlvbiBwcmltaXRpdmUgb24gZXZlcnkgcGF0aFxuICAgIC8vIHRoaXMgcHJvYmVzIChJc3N1ZSAjMTIzOCk6IGB3cml0ZVRleHRGaWxlU3luY2AgaXMgT19DUkVBVHxPX1RSVU5DIGFuZFxuICAgIC8vIGZvbGxvd3Mgc3ltbGlua3MsIHNvIGEgbGluayBwbGFudGVkIGF0IHRoZSBwcmVkaWN0YWJsZSBuYW1lIHdhc1xuICAgIC8vIGZvbGxvd2VkIGFuZCBpdHMgdGFyZ2V0IHRydW5jYXRlZCDigJQgYW5kIHRoZSBwcm9iZSB0aGVuIHJlbW92ZWQgdGhlXG4gICAgLy8gbGluaywgbGVhdmluZyB0aGUgZGFtYWdlIHdpdGggbm90aGluZyB0byBzaG93IGZvciBpdC4gQSBrZXJuZWwtcmFuZG9tXG4gICAgLy8gbmFtZSBjYW5ub3QgYmUgcHJlLXBvc2l0aW9uZWQsIGFuZCBgY3JlYXRlTmV3YCByZWZ1c2VzIGFueXRoaW5nIGFscmVhZHlcbiAgICAvLyBhdCB0aGUgbmFtZSByYXRoZXIgdGhhbiBvcGVuaW5nIGl0LlxuICAgIGNvbnN0IHByb2JlID0gYCR7cGF0aH0vLnZpYmUtd3JpdGUtcHJvYmUuJHtjcnlwdG8ucmFuZG9tVVVJRCgpfWA7XG4gICAgdHJ5IHtcbiAgICAgIERlbm8ub3BlblN5bmMocHJvYmUsIHtcbiAgICAgICAgd3JpdGU6IHRydWUsXG4gICAgICAgIGNyZWF0ZU5ldzogdHJ1ZSxcbiAgICAgICAgbW9kZTogU1RBR0VEX0hPU1RTX01PREUsXG4gICAgICB9KS5jbG9zZSgpO1xuICAgICAgRGVuby5yZW1vdmVTeW5jKHByb2JlKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfSxcbn07XG5cbmZ1bmN0aW9uIGRlZmF1bHRFbnYobmFtZTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gRGVuby5lbnYuZ2V0KG5hbWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKlxuICogVGhlIHJlYWQtb25seSBjcmVkZW50aWFsIG1vdW50IGBob3N0cy55bWxgIOKAlCB0aGUgc291cmNlIG9mIHRydXRoLlxuICpcbiAqIEBwYXJhbSBob21lIC0gV29ya2VyIGhvbWUgZGlyZWN0b3J5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbW91bnRlZEhvc3RzUGF0aChob21lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7aG9tZX0vJHtERUZBVUxUX0NSRURFTlRJQUxfRElSX1NVRkZJWH0vJHtHSF9DUkVERU5USUFMX1NVQkRJUn0vYCArXG4gICAgR0hfSE9TVFNfRklMRTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgYEdIX0NPTkZJR19ESVJgIGNhbiBhY3R1YWxseSBzZXJ2ZSBhIGBnaGAgY2FsbC5cbiAqXG4gKiBQcmVzZW50LCBub24tZW1wdHkgYW5kIHdyaXRhYmxlIOKAlCBhbiBlbXB0eSBgaG9zdHMueW1sYCBhdXRoZW50aWNhdGVzXG4gKiBub3RoaW5nLCBhbmQgdGhlIElzc3VlICM1NTQgZmFsbGJhY2sgbGVmdCBleGFjdGx5IHRoYXQgYmVoaW5kIHdoZW4gaXRzXG4gKiBjb3B5IGZhaWxlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzR2hDb25maWdEaXJVc2FibGUoXG4gIGRpcjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpbzogR2hDcmVkZW50aWFsU3RhZ2VJbyA9IHByb2R1Y3Rpb25Jbyxcbik6IGJvb2xlYW4ge1xuICBpZiAoIWRpcikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBob3N0cyA9IGlvLnJlYWRGaWxlKGAke2Rpcn0vJHtHSF9IT1NUU19GSUxFfWApO1xuICBpZiAoaG9zdHMgPT09IG51bGwgfHwgaG9zdHMubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpby5pc1dyaXRhYmxlRGlyKGRpcik7XG59XG5cbi8qKlxuICogU3RhZ2luZyBjYW5kaWRhdGVzIGluIHByZWZlcmVuY2Ugb3JkZXIsIG1pcnJvcmluZyB0aGUgZW50cnlwb2ludCdzIHBvbGljeS5cbiAqXG4gKiBUaGUgZHVyYWJsZSBzdGF0ZSByb290IGZpcnN0IOKAlCBpdCBpcyB0aGUgd29ya2VyJ3Mgb3duLCBhbmQgbm90IHRoZSBgL3RtcGBcbiAqIHRoZSBhZ2VudHMgY2h1cm4uIFNjcmF0Y2ggYW5kIGBUTVBESVJgIGZvbGxvdyBzbyBhIGhvc3Qgd2l0aG91dCBhIHN0YXRlXG4gKiByb290IHN0aWxsIGF1dGhlbnRpY2F0ZXMuXG4gKlxuICogVGhlIGBUTVBESVJgIGNhbmRpZGF0ZSBpcyBwZXItYWNjb3VudCAoe0BsaW5rIHNoYXJlZFRtcFN0YXRlRGlyfSwgSXNzdWVcbiAqICMxMjE1KTogYC90bXAvdmliZS1naC1jb25maWdgIHdhcyB0aGUgc2FtZSBwYXRoIGZvciBldmVyeSBsb2NhbCBhY2NvdW50IG9uXG4gKiBhIHNoYXJlZCBob3N0LCBzbyB3aG9ldmVyIGNyZWF0ZWQgaXQgZmlyc3Qgb3duZWQgd2hhdCB0aGUgd29ya2VyIHN0YWdlZFxuICogaW50byBpdCAoSXNzdWUgIzEyODIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhZ2luZ0NhbmRpZGF0ZXMoXG4gIGVudjogRW52TG9va3VwID0gZGVmYXVsdEVudixcbik6IHN0cmluZ1tdIHtcbiAgY29uc3Qgc3RhdGUgPSBlbnYoU1RBVEVfRElSX0VOVik7XG4gIGNvbnN0IHNjcmF0Y2ggPSBlbnYoU0NSQVRDSF9ESVJfRU5WKTtcbiAgcmV0dXJuIFtcbiAgICBzdGF0ZSA/IGAke3N0YXRlfS8ke1NUQUdFRF9HSF9ESVJfTkFNRX1gIDogdW5kZWZpbmVkLFxuICAgIHNjcmF0Y2ggPyBgJHtzY3JhdGNofS8ke1NUQUdFRF9HSF9ESVJfTkFNRX1gIDogdW5kZWZpbmVkLFxuICAgIHNoYXJlZFRtcFN0YXRlRGlyKGB2aWJlLSR7U1RBR0VEX0dIX0RJUl9OQU1FfWAsIGVudiksXG4gIF0uZmlsdGVyKChkaXIpOiBkaXIgaXMgc3RyaW5nID0+IGRpciAhPT0gdW5kZWZpbmVkKTtcbn1cblxuLyoqXG4gKiBXaHkgYSBwcmUtZXhpc3Rpbmcgc3RhZ2luZyBwYXRoIGlzIG5vdCB0aGUgd29ya2VyJ3Mgb3duLCBvciBudWxsIHdoZW4gaXRcbiAqIGlzIChJc3N1ZSAjMTI4MikuXG4gKlxuICogRXhwb3J0ZWQgc28gdGhlIHJlZnVzYWwgaXMgdGVzdGFibGUgYWdhaW5zdCBsaXRlcmFsIHN0YXRzOiBhIHN5bWxpbmsgb3IgYVxuICogZmlsZSB3aGVyZSB0aGUgZGlyZWN0b3J5IHNob3VsZCBiZSwgYW5vdGhlciBhY2NvdW50J3MgZGlyZWN0b3J5LCBvciBvbmVcbiAqIGFueSBsb2NhbCBhY2NvdW50IGNhbiB3cml0ZSBpbnRvIGFyZSBhbGwgcGF0aHMgdGhlIGNyZWRlbnRpYWwgbXVzdCBub3QgYmVcbiAqIGNvcGllZCB0by5cbiAqXG4gKiBAcGFyYW0gc3RhdCAtIFdoYXQgYGxzdGF0YCByZXBvcnRlZCBmb3IgdGhlIGNhbmRpZGF0ZS5cbiAqIEBwYXJhbSBvd25VaWQgLSBUaGlzIGFjY291bnQncyB1aWQsIG9yIG51bGwgd2hlbiBpdCBjYW5ub3QgYmUgZGV0ZXJtaW5lZC5cbiAqIEByZXR1cm5zIFRoZSByZWZ1c2FsIHJlYXNvbiwgb3IgbnVsbCB3aGVuIHRoZSBwYXRoIG1heSBiZSBzdGFnZWQgaW50by5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YWdpbmdEaXJSZWZ1c2FsKFxuICBzdGF0OiBTdGFnZWRQYXRoU3RhdCxcbiAgb3duVWlkOiBudW1iZXIgfCBudWxsLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghc3RhdC5kaXJlY3RvcnkpIHtcbiAgICByZXR1cm4gXCJ0aGUgcGF0aCBpcyBub3QgYSBkaXJlY3RvcnkgKGEgc3ltbGluayBvciBmaWxlIG9jY3VwaWVzIGl0KVwiO1xuICB9XG4gIGlmIChvd25VaWQgIT09IG51bGwgJiYgc3RhdC51aWQgIT09IG51bGwgJiYgc3RhdC51aWQgIT09IG93blVpZCkge1xuICAgIHJldHVybiBgdGhlIGRpcmVjdG9yeSBpcyBvd25lZCBieSB1aWQgJHtzdGF0LnVpZH0sIG5vdCB0aGlzIGFjY291bnQgYCArXG4gICAgICBgKHVpZCAke293blVpZH0pYDtcbiAgfVxuICBpZiAoc3RhdC5tb2RlICE9PSBudWxsICYmIChzdGF0Lm1vZGUgJiAwbzA3NykgIT09IDApIHtcbiAgICBjb25zdCBvY3RhbCA9IHN0YXQubW9kZS50b1N0cmluZyg4KS5wYWRTdGFydCg0LCBcIjBcIik7XG4gICAgcmV0dXJuIGB0aGUgZGlyZWN0b3J5IGlzIGdyb3VwL290aGVyIGFjY2Vzc2libGUgKG1vZGUgJHtvY3RhbH0sIGAgK1xuICAgICAgXCJleHBlY3RlZCAwNzAwKVwiO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIERpcmVjdG9yaWVzIHRoaXMgcHJvY2VzcyBjcmVhdGVkLCByZW1vdmVkIHdoZW4gdGhlIHJ1biBlbmRzLlxuICpcbiAqIE9ubHkgd2hhdCB0aGlzIHByb2Nlc3MgY3JlYXRlZDogYSBkaXJlY3RvcnkgdGhlIGVudHJ5cG9pbnQgb3IgYSBzaWJsaW5nXG4gKiB3b3JrZXIgc3RhZ2VkIGlzIHN0aWxsIGluIHVzZSBhbmQgaXMgbm90IG91cnMgdG8gZGVsZXRlLlxuICovXG5jb25zdCBjcmVhdGVkU3RhZ2luZ0RpcnMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxubGV0IHJ1bkVuZENsZWFudXBSZWdpc3RlcmVkID0gZmFsc2U7XG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgcmVtb3ZlU3RhZ2VkR2hDb25maWdEaXJzfS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVtb3ZlU3RhZ2VkT3B0aW9ucyB7XG4gIGlvPzogR2hDcmVkZW50aWFsU3RhZ2VJbztcbiAgd2Fybj86IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG59XG5cbi8qKlxuICogUmVtb3ZlIHRoZSBzdGFnaW5nIGRpcmVjdG9yaWVzIHRoaXMgcHJvY2VzcyBjcmVhdGVkIChJc3N1ZSAjMTI4MikuXG4gKlxuICogUmVnaXN0ZXJlZCBvbiBgdW5sb2FkYCBieSB0aGUgZmlyc3Qgc3VjY2Vzc2Z1bCBzdGFnaW5nLCBzbyB0aGUgY3JlZGVudGlhbFxuICogZG9lcyBub3Qgb3V0bGl2ZSB0aGUgcnVuIG9uIGEgc2hhcmVkIGhvc3Q7IGV4cG9ydGVkIHNvIGEgY2FsbGVyIOKAlCBvciBhXG4gKiB0ZXN0IOKAlCBjYW4gdHJpZ2dlciB0aGUgcmVtb3ZhbCBpdHNlbGYuXG4gKlxuICogQHJldHVybnMgVGhlIGRpcmVjdG9yaWVzIGFjdHVhbGx5IHJlbW92ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVTdGFnZWRHaENvbmZpZ0RpcnMoXG4gIG9wdGlvbnM6IFJlbW92ZVN0YWdlZE9wdGlvbnMgPSB7fSxcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgaW8gPSBvcHRpb25zLmlvID8/IHByb2R1Y3Rpb25JbztcbiAgY29uc3Qgd2FybiA9IG9wdGlvbnMud2FybiA/PyAoKG1lc3NhZ2U6IHN0cmluZykgPT4gY29uc29sZS5lcnJvcihtZXNzYWdlKSk7XG4gIGNvbnN0IHJlbW92ZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgZGlyIG9mIGNyZWF0ZWRTdGFnaW5nRGlycykge1xuICAgIHRyeSB7XG4gICAgICBpby5yZW1vdmUoZGlyLCB0cnVlKTtcbiAgICAgIHJlbW92ZWQucHVzaChkaXIpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICB3YXJuKFxuICAgICAgICBgW1NFQ1VSSVRZXSBjb3VsZCBub3QgcmVtb3ZlIHRoZSBzdGFnZWQgZ2ggY3JlZGVudGlhbCBhdCAke2Rpcn06IGAgK1xuICAgICAgICAgIGRlc2NyaWJlRXJyb3IoZXJyb3IpLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgY3JlYXRlZFN0YWdpbmdEaXJzLmNsZWFyKCk7XG4gIHJldHVybiByZW1vdmVkO1xufVxuXG4vKiogTm90ZSBhIGRpcmVjdG9yeSB0aGlzIHByb2Nlc3MgY3JlYXRlZCwgYW5kIGFybSB0aGUgcnVuLWVuZCByZW1vdmFsLiAqL1xuZnVuY3Rpb24gcmVtZW1iZXJDcmVhdGVkU3RhZ2luZ0RpcihkaXI6IHN0cmluZyk6IHZvaWQge1xuICBjcmVhdGVkU3RhZ2luZ0RpcnMuYWRkKGRpcik7XG4gIGlmIChydW5FbmRDbGVhbnVwUmVnaXN0ZXJlZCkgcmV0dXJuO1xuICBydW5FbmRDbGVhbnVwUmVnaXN0ZXJlZCA9IHRydWU7XG4gIGdsb2JhbFRoaXMuYWRkRXZlbnRMaXN0ZW5lcihcInVubG9hZFwiLCAoKSA9PiB7XG4gICAgcmVtb3ZlU3RhZ2VkR2hDb25maWdEaXJzKCk7XG4gIH0pO1xufVxuXG4vKiogVGhlIG1lc3NhZ2Ugb2YgYSB0aHJvd24gdmFsdWUsIHdoYXRldmVyIGl0IHR1cm5lZCBvdXQgdG8gYmUuICovXG5mdW5jdGlvbiBkZXNjcmliZUVycm9yKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuLyoqXG4gKiBNYWtlIGBjYW5kaWRhdGVgIGEgZGlyZWN0b3J5IHRoaXMgYWNjb3VudCBvd25zLCBvciB0aHJvdyBzYXlpbmcgd2h5IG5vdC5cbiAqXG4gKiBAcmV0dXJucyBUcnVlIHdoZW4gdGhpcyBjYWxsIGNyZWF0ZWQgaXQg4oCUIGFuZCBzbyBvd25zIHJlbW92aW5nIGl0LlxuICovXG5mdW5jdGlvbiBwcmVwYXJlU3RhZ2luZ0RpcihcbiAgY2FuZGlkYXRlOiBzdHJpbmcsXG4gIGlvOiBHaENyZWRlbnRpYWxTdGFnZUlvLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGV4aXN0aW5nID0gaW8ubHN0YXQoY2FuZGlkYXRlKTtcbiAgaWYgKGV4aXN0aW5nID09PSBudWxsKSB7XG4gICAgaW8ubWFrZVByaXZhdGVEaXIoY2FuZGlkYXRlLCBQUklWQVRFX0RJUl9NT0RFKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBjb25zdCByZWZ1c2FsID0gc3RhZ2luZ0RpclJlZnVzYWwoZXhpc3RpbmcsIGlvLm93bmVyVWlkKCkpO1xuICBpZiAocmVmdXNhbCAhPT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKHJlZnVzYWwpO1xuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKiBXcml0ZSBgaG9zdHMueW1sYCBpbnRvIGEgcHJlcGFyZWQgc3RhZ2luZyBkaXJlY3RvcnksIDA2MDAgZnJvbSBiaXJ0aC4gKi9cbmZ1bmN0aW9uIHdyaXRlU3RhZ2VkQ3JlZGVudGlhbChcbiAgY2FuZGlkYXRlOiBzdHJpbmcsXG4gIHNvdXJjZTogVWludDhBcnJheSxcbiAgaW86IEdoQ3JlZGVudGlhbFN0YWdlSW8sXG4pOiB2b2lkIHtcbiAgY29uc3QgaG9zdHMgPSBgJHtjYW5kaWRhdGV9LyR7R0hfSE9TVFNfRklMRX1gO1xuICAvLyBVbmxpbmsgZmlyc3Qgc28gYSBwbGFudGVkIHN5bWxpbmsgaXMgZHJvcHBlZCByYXRoZXIgdGhhbiBmb2xsb3dlZDsgdGhlXG4gIC8vIGV4Y2x1c2l2ZSBjcmVhdGUgdGhlbiBmYWlscyBsb3VkbHkgaWYgYW55dGhpbmcgcmVhcHBlYXJzIGluIGJldHdlZW4uXG4gIGlvLnJlbW92ZShob3N0cyk7XG4gIGlvLndyaXRlUHJpdmF0ZUZpbGUoaG9zdHMsIHNvdXJjZSwgU1RBR0VEX0hPU1RTX01PREUpO1xufVxuXG4vKipcbiAqIFJlYnVpbGQgdGhlIHdyaXRhYmxlIGBnaGAgY29uZmlndXJhdGlvbiBmcm9tIHRoZSByZWFkLW9ubHkgbW91bnQuXG4gKlxuICogQHJldHVybnMgVGhlIHN0YWdlZCBkaXJlY3RvcnksIG9yIG51bGwgd2hlbiB0aGUgbW91bnQgaG9sZHMgbm8gY3JlZGVudGlhbFxuICogICBvciBub3doZXJlIGlzIHdyaXRhYmxlIOKAlCBib3RoIG9mIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXBvcnQgcmF0aGVyXG4gKiAgIHRoYW4gcmV0cnkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXN0YWdlR2hDb25maWdEaXIoXG4gIG9wdGlvbnM6IFJlc3RhZ2VPcHRpb25zID0ge30sXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgZW52ID0gb3B0aW9ucy5lbnYgPz8gZGVmYXVsdEVudjtcbiAgY29uc3QgaW8gPSBvcHRpb25zLmlvID8/IHByb2R1Y3Rpb25JbztcbiAgY29uc3QgaG9tZSA9IG9wdGlvbnMuaG9tZSA/PyBlbnYoXCJIT01FXCIpID8/IFwiXCI7XG4gIGNvbnN0IHdhcm4gPSBvcHRpb25zLndhcm4gPz8gKChtZXNzYWdlOiBzdHJpbmcpID0+IGNvbnNvbGUuZXJyb3IobWVzc2FnZSkpO1xuXG4gIGNvbnN0IHNvdXJjZSA9IGlvLnJlYWRGaWxlKG1vdW50ZWRIb3N0c1BhdGgoaG9tZSkpO1xuICBpZiAoc291cmNlID09PSBudWxsIHx8IHNvdXJjZS5sZW5ndGggPT09IDApIHtcbiAgICAvLyBOb3RoaW5nIHRvIHJlLXN0YWdlIGZyb206IHRoaXMgaXMgYSBjcmVkZW50aWFsIHByb2JsZW0sIG5vdCBhIHN0YWdpbmdcbiAgICAvLyBwcm9ibGVtLCBhbmQgdGhlIHByZWZsaWdodCdzIG1lc3NhZ2UgaXMgdGhlIG9uZSB0aGF0IHNob3VsZCBiZSByZWFkLlxuICAgIHdhcm4oXG4gICAgICBgW1NFQ1VSSVRZXSBjYW5ub3QgcmUtc3RhZ2UgdGhlIGdoIGNyZWRlbnRpYWw6ICR7XG4gICAgICAgIG1vdW50ZWRIb3N0c1BhdGgoaG9tZSlcbiAgICAgIH0gaXMgbWlzc2luZyBvciBlbXB0eWAsXG4gICAgKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIHN0YWdpbmdDYW5kaWRhdGVzKGVudikpIHtcbiAgICBsZXQgY3JlYXRlZCA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBjcmVhdGVkID0gcHJlcGFyZVN0YWdpbmdEaXIoY2FuZGlkYXRlLCBpbyk7XG4gICAgICB3cml0ZVN0YWdlZENyZWRlbnRpYWwoY2FuZGlkYXRlLCBzb3VyY2UsIGlvKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgLy8gTG91ZCwgYW5kIHBlciBjYW5kaWRhdGUgKElzc3VlICMxMjgyKTogYSByZWZ1c2FsIGhlcmUgaXMgZWl0aGVyIGFcbiAgICAgIC8vIGRpcmVjdG9yeSB0aGF0IGlzIG5vdCB0aGlzIGFjY291bnQncyBvciBhIGdlbnVpbmVseSB1bnVzYWJsZVxuICAgICAgLy8gY2FuZGlkYXRlLCBhbmQgdGhlIG9sZCBzaWxlbnQgY2F0Y2ggaGlkIGJvdGgg4oCUIGFmdGVyIHRoZSB0b2tlbiBoYWRcbiAgICAgIC8vIGFscmVhZHkgYmVlbiB3cml0dGVuLlxuICAgICAgd2FybihcbiAgICAgICAgYFtTRUNVUklUWV0gcmVmdXNpbmcgdG8gc3RhZ2UgdGhlIGdoIGNyZWRlbnRpYWwgYXQgJHtjYW5kaWRhdGV9OiBgICtcbiAgICAgICAgICBkZXNjcmliZUVycm9yKGVycm9yKSxcbiAgICAgICk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNyZWF0ZWQpIHJlbWVtYmVyQ3JlYXRlZFN0YWdpbmdEaXIoY2FuZGlkYXRlKTtcbiAgICBpZiAoIWlzR2hDb25maWdEaXJVc2FibGUoY2FuZGlkYXRlLCBpbykpIGNvbnRpbnVlO1xuICAgIHdhcm4oXG4gICAgICBgW1NFQ1VSSVRZXSByZS1zdGFnZWQgdGhlIGdoIGNyZWRlbnRpYWwgZnJvbSB0aGUgcmVhZC1vbmx5IG1vdW50IHRvIGAgK1xuICAgICAgICBgJHtjYW5kaWRhdGV9IChJc3N1ZSAjNTY0KWAsXG4gICAgKTtcbiAgICByZXR1cm4gY2FuZGlkYXRlO1xuICB9XG5cbiAgd2FybihcbiAgICBcIltTRUNVUklUWV0gY2Fubm90IHJlLXN0YWdlIHRoZSBnaCBjcmVkZW50aWFsOiBubyB3cml0YWJsZSBzdGFnaW5nIFwiICtcbiAgICAgIGBkaXJlY3RvcnkgKHRyaWVkICR7c3RhZ2luZ0NhbmRpZGF0ZXMoZW52KS5qb2luKFwiLCBcIil9KWAsXG4gICk7XG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogV2hhdCB7QGxpbmsgcmVzb2x2ZVVzYWJsZUdoQ29uZmlnRGlyfSBkZWNpZGVkLCB3aXRoIG5vdGhpbmcgYXBwbGllZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2hDb25maWdEaXJSZXNvbHV0aW9uIHtcbiAgLyoqIFRydWUgd2hlbiB0aGUgY29uZmlndXJhdGlvbiBpcyB1c2FibGUgb25jZSB7QGxpbmsgZW52fSBpcyBhcHBsaWVkLiAqL1xuICB1c2FibGU6IGJvb2xlYW47XG4gIC8qKlxuICAgKiBUaGUgdmFyaWFibGVzIHRvIGVzdGFibGlzaCDigJQgYEdIX0NPTkZJR19ESVJgIHdoZW4gYSByZS1zdGFnZSBwcm9kdWNlZCBhXG4gICAqIG5ldyBkaXJlY3RvcnksIGFuZCBlbXB0eSB3aGVuIHRoZSBjdXJyZW50IG9uZSB3YXMgYWxyZWFkeSB1c2FibGUgb3JcbiAgICogbm90aGluZyBjb3VsZCBiZSBzdGFnZWQuXG4gICAqL1xuICBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG59XG5cbi8qKlxuICogRGVjaWRlIHdoYXQgYEdIX0NPTkZJR19ESVJgIHNob3VsZCBiZSwgKip3aXRob3V0IHdyaXRpbmcgdGhlIHByb2Nlc3NcbiAqIGVudmlyb25tZW50KiogKElzc3VlICM5NjcpLlxuICpcbiAqIFRoZSByZS1zdGFnZSBpdHNlbGYgc3RpbGwgY29waWVzIGBob3N0cy55bWxgIG91dCBvZiB0aGUgcmVhZC1vbmx5IG1vdW50IOKAlFxuICogdGhhdCBpcyB0aGUgcG9pbnQgb2YgaXQg4oCUIGJ1dCB0aGUgcmVzdWx0aW5nIHZhcmlhYmxlIGlzIHJldHVybmVkIHJhdGhlclxuICogdGhhbiBhcHBsaWVkLCBzbyBhIHRlc3QgY2FuIGFzc2VydCBvbiB0aGUgbWFwIHdpdGhvdXQgbXV0YXRpbmcgc3RhdGUgZXZlcnlcbiAqIG90aGVyIHBhcmFsbGVsIHdvcmtlciBzaGFyZXMuIHtAbGluayBlbnN1cmVVc2FibGVHaENvbmZpZ0Rpcn0gaXMgdGhpc1xuICogZnVuY3Rpb24gcGx1cyB0aGUgYXBwbGljYXRpb24gc3RlcC5cbiAqXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEhvbWUsIGVudmlyb25tZW50IGxvb2t1cCwgZmlsZXN5c3RlbSBzZWFtcyBhbmQgd2FybiBzaW5rLlxuICogQHJldHVybnMgV2hldGhlciB0aGUgY29uZmlndXJhdGlvbiBpcyB1c2FibGUsIGFuZCB3aGF0IHRvIGVzdGFibGlzaC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVVc2FibGVHaENvbmZpZ0RpcihcbiAgb3B0aW9uczogUmVzdGFnZU9wdGlvbnMgPSB7fSxcbik6IEdoQ29uZmlnRGlyUmVzb2x1dGlvbiB7XG4gIGNvbnN0IGVudiA9IG9wdGlvbnMuZW52ID8/IGRlZmF1bHRFbnY7XG4gIGNvbnN0IGlvID0gb3B0aW9ucy5pbyA/PyBwcm9kdWN0aW9uSW87XG4gIGNvbnN0IGN1cnJlbnQgPSBlbnYoXCJHSF9DT05GSUdfRElSXCIpO1xuICBpZiAoaXNHaENvbmZpZ0RpclVzYWJsZShjdXJyZW50LCBpbykpIHJldHVybiB7IHVzYWJsZTogdHJ1ZSwgZW52OiB7fSB9O1xuXG4gIGNvbnN0IHN0YWdlZCA9IHJlc3RhZ2VHaENvbmZpZ0RpcihvcHRpb25zKTtcbiAgaWYgKHN0YWdlZCA9PT0gbnVsbCkgcmV0dXJuIHsgdXNhYmxlOiBmYWxzZSwgZW52OiB7fSB9O1xuICByZXR1cm4geyB1c2FibGU6IHRydWUsIGVudjogeyBHSF9DT05GSUdfRElSOiBzdGFnZWQgfSB9O1xufVxuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIGVuc3VyZVVzYWJsZUdoQ29uZmlnRGlyfS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRW5zdXJlR2hDb25maWdEaXJPcHRpb25zIGV4dGVuZHMgUmVzdGFnZU9wdGlvbnMge1xuICAvKipcbiAgICogRXN0YWJsaXNoZXMgb25lIHZhcmlhYmxlIGluIHRoZSBydW4gZW52aXJvbm1lbnQ7IGRlZmF1bHRzIHRvXG4gICAqIGBEZW5vLmVudi5zZXRgLCB3aGljaCBpcyB3aGF0IGV2ZXJ5IGNoaWxkIGBnaGAgYW5kIGBnaXRgIGluaGVyaXRzLiBBIHRlc3RcbiAgICogaGFuZHMgaW4gYSByZWNvcmRlciBhbmQgYXNzZXJ0cyBvbiB0aGUgbWFwIGluc3RlYWQuXG4gICAqL1xuICBzZXRFbnY/OiAobmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG4vKiogQXBwbHkgb25lIHZhcmlhYmxlIHRvIHRoZSBwcm9jZXNzLCB0b2xlcmF0aW5nIGEgcGVybWlzc2lvbiBkZW5pYWwuICovXG5mdW5jdGlvbiBwcm9jZXNzU2V0RW52KG5hbWU6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIERlbm8uZW52LnNldChuYW1lLCB2YWx1ZSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIEEgdGVzdCBlbnZpcm9ubWVudCB3aXRob3V0IGVudi1zZXQgcGVybWlzc2lvbiBzdGlsbCBnZXRzIHRoZSBjb3B5LlxuICB9XG59XG5cbi8qKlxuICogRW5zdXJlIGBHSF9DT05GSUdfRElSYCBuYW1lcyBhIHVzYWJsZSBkaXJlY3RvcnksIHJlLXN0YWdpbmcgaWYgaXQgZG9lcyBub3QuXG4gKlxuICogQXBwbGllcyB0aGUgcmVzdWx0IHRvIHRoZSBydW4gZW52aXJvbm1lbnQgc28gZXZlcnkgY2hpbGQgYGdoYCBhbmQgYGdpdGBcbiAqIGluaGVyaXRzIGl0LlxuICpcbiAqIEByZXR1cm5zIFRydWUgd2hlbiB0aGUgZW52aXJvbm1lbnQgbm93IHBvaW50cyBhdCBhIHVzYWJsZSBjb25maWd1cmF0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW5zdXJlVXNhYmxlR2hDb25maWdEaXIoXG4gIG9wdGlvbnM6IEVuc3VyZUdoQ29uZmlnRGlyT3B0aW9ucyA9IHt9LFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHJlc29sdXRpb24gPSByZXNvbHZlVXNhYmxlR2hDb25maWdEaXIob3B0aW9ucyk7XG4gIGNvbnN0IHNldEVudiA9IG9wdGlvbnMuc2V0RW52ID8/IHByb2Nlc3NTZXRFbnY7XG4gIGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyZXNvbHV0aW9uLmVudikpIHtcbiAgICBzZXRFbnYobmFtZSwgdmFsdWUpO1xuICB9XG4gIHJldHVybiByZXNvbHV0aW9uLnVzYWJsZTtcbn1cblxuLyoqIFRydWUgd2hlbiBhIGZpbmlzaGVkIGBnaGAgY2FsbCBmYWlsZWQgYmVjYXVzZSBpdCBoYWQgbm8gYXV0aGVudGljYXRpb24uICovXG5leHBvcnQgZnVuY3Rpb24gaXNHaEF1dGhNaXNzaW5nRmFpbHVyZShcbiAgcmVzdWx0OiB7IGNvZGU6IG51bWJlcjsgc3RkZXJyOiBzdHJpbmcgfSxcbik6IGJvb2xlYW4ge1xuICBpZiAocmVzdWx0LmNvZGUgPT09IDApIHJldHVybiBmYWxzZTtcbiAgY29uc3Qgc3RkZXJyID0gcmVzdWx0LnN0ZGVyci50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gc3RkZXJyLmluY2x1ZGVzKFwiZ2ggYXV0aCBsb2dpblwiKSB8fFxuICAgIHN0ZGVyci5pbmNsdWRlcyhcIm5vIGFjY291bnRzIGNvbmZpZ3VyZWRcIikgfHxcbiAgICBzdGRlcnIuaW5jbHVkZXMoXCJhdXRoZW50aWNhdGlvbiB0b2tlbiBub3QgZm91bmRcIik7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGhlIGdpdCBoYWxmIChJc3N1ZSAjNTY0LCBzZWNvbmQgZmFpbHVyZSlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFRydWUgd2hlbiBhIGZpbmlzaGVkIGBnaXRgIGNhbGwgZmFpbGVkIGZvciB3YW50IG9mIGNyZWRlbnRpYWxzIG9yIGlkZW50aXR5LlxuICpcbiAqIGBnaGAgYW5kIGBnaXRgIGZhaWwgZGlmZmVyZW50bHkgYW5kIGluZGVwZW5kZW50bHkg4oCUIGEgcnVuIHdhcyBmb3VuZCB3aXRoIGFcbiAqIHdvcmtpbmcgYGdoIGFwaSB1c2VyYCBhbmQgYSBgZ2l0IGZldGNoYCB0aGF0IGNvdWxkIG5vdCBhdXRoZW50aWNhdGUsIGJlY2F1c2VcbiAqIHRoZSBzdGFnZWQgZ2xvYmFsIGNvbmZpZyBoYWQgYmVlbiByZWR1Y2VkIHRvIGl0cyBgc2FmZS5kaXJlY3RvcnlgIGxpbmUgd2hpbGVcbiAqIGBob3N0cy55bWxgIHdhcyBpbnRhY3QuIFJlY29nbmlzaW5nIG9ubHkgdGhlIGBnaGAgc2hhcGUgbWlzc2VzIHRoYXQgZW50aXJlbHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0dpdEF1dGhNaXNzaW5nRmFpbHVyZShcbiAgcmVzdWx0OiB7IGNvZGU6IG51bWJlcjsgc3RkZXJyOiBzdHJpbmcgfSxcbik6IGJvb2xlYW4ge1xuICBpZiAocmVzdWx0LmNvZGUgPT09IDApIHJldHVybiBmYWxzZTtcbiAgY29uc3Qgc3RkZXJyID0gcmVzdWx0LnN0ZGVyci50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gc3RkZXJyLmluY2x1ZGVzKFwiY291bGQgbm90IHJlYWQgdXNlcm5hbWVcIikgfHxcbiAgICBzdGRlcnIuaW5jbHVkZXMoXCJ0ZXJtaW5hbCBwcm9tcHRzIGRpc2FibGVkXCIpIHx8XG4gICAgc3RkZXJyLmluY2x1ZGVzKFwicGxlYXNlIHRlbGwgbWUgd2hvIHlvdSBhcmVcIikgfHxcbiAgICBzdGRlcnIuaW5jbHVkZXMoXCJ1bmFibGUgdG8gYXV0by1kZXRlY3QgZW1haWwgYWRkcmVzc1wiKSB8fFxuICAgIHN0ZGVyci5pbmNsdWRlcyhcImF1dGhlbnRpY2F0aW9uIGZhaWxlZFwiKTtcbn1cblxuLyoqIFRoZSB0cmFuc3BvcnQsIGNyZWRlbnRpYWwgaGVscGVyIGFuZCBpZGVudGl0eSB0aGUgZW50cnlwb2ludCBzdGFnZXMuICovXG5leHBvcnQgaW50ZXJmYWNlIEdpdEdsb2JhbENvbmZpZ0VudHJ5IHtcbiAgYXJnczogc3RyaW5nW107XG4gIC8qKiBUcnVlIHdoZW4gdGhlIGVudHJ5IGlzIGFkZGVkIHRvIGEgbXVsdGktdmFsdWVkIGtleS4gKi9cbiAgYWRkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBUaGUgZ2xvYmFsIGdpdCBjb25maWd1cmF0aW9uIHRoZSBjb250YWluZXIgbmVlZHMsIHJlYnVpbHQgZnJvbSB0aGUgbW91bnQuXG4gKlxuICogTWlycm9ycyBgY29udGFpbmVyL2VudHJ5cG9pbnQuc2hgOiBTU0ggcmVtb3RlcyByZXdyaXR0ZW4gdG8gSFRUUFMsIGBnaGAgYXNcbiAqIHRoZSBjcmVkZW50aWFsIGhlbHBlciwgYW5kIGFuIGlkZW50aXR5IHRha2VuIGZyb20gdGhlIG1vdW50ZWQgY3JlZGVudGlhbC5cbiAqIFJldHVybnMgYW4gZW1wdHkgbGlzdCB3aGVuIHRoZSBtb3VudCBuYW1lcyBubyB1c2VyIOKAlCBub3RoaW5nIGlzIGd1ZXNzZWQuXG4gKlxuICogQHBhcmFtIGxvZ2luIC0gVGhlIHNlcnZpY2UtYWNjb3VudCBsb2dpbiwgZnJvbSB0aGUgbW91bnRlZCBgaG9zdHMueW1sYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdpdEdsb2JhbENvbmZpZ0VudHJpZXMoXG4gIGxvZ2luOiBzdHJpbmcgfCBudWxsLFxuKTogR2l0R2xvYmFsQ29uZmlnRW50cnlbXSB7XG4gIGNvbnN0IGVudHJpZXM6IEdpdEdsb2JhbENvbmZpZ0VudHJ5W10gPSBbXG4gICAgeyBhcmdzOiBbXCItLWdsb2JhbFwiLCBcIi0tYWRkXCIsIFwic2FmZS5kaXJlY3RvcnlcIiwgXCIqXCJdLCBhZGQ6IHRydWUgfSxcbiAgICAvLyAtLXJlcGxhY2UtYWxsLCBub3QgYSBwbGFpbiBzZXQgKElzc3VlICM2MzUpLiBCb3RoIG9mIHRoZXNlIGtleXMgYXJlXG4gICAgLy8gbXVsdGktdmFsdWVkIOKAlCB0aGUgZW50cnlwb2ludCBhZGRzIGEgc2Vjb25kIHZhbHVlIHRvIGVhY2gg4oCUIGFuZCB0aGVcbiAgICAvLyBnbG9iYWwgY29uZmlnIG5vdyBzdXJ2aXZlcyB0aGUgcnVuIGluICR7U1RBVEVfUk9PVH0vZ2l0Y29uZmlnLiBBIHBsYWluXG4gICAgLy8gc2V0IGFnYWluc3QgYW4gZXhpc3RpbmcgbXVsdGktdmFsdWVkIGtleSBmYWlscyB3aXRoIFwiY2Fubm90IG92ZXJ3cml0ZVxuICAgIC8vIG11bHRpcGxlIHZhbHVlcyB3aXRoIGEgc2luZ2xlIHZhbHVlXCIsIHdoaWNoIHdvdWxkIG1ha2UgdGhpcyByZXBhaXIgcGF0aFxuICAgIC8vIGZhaWwgaW4gZXhhY3RseSB0aGUgc2l0dWF0aW9uIGl0IGV4aXN0cyB0byByZXBhaXIuXG4gICAge1xuICAgICAgYXJnczogW1xuICAgICAgICBcIi0tZ2xvYmFsXCIsXG4gICAgICAgIFwiLS1yZXBsYWNlLWFsbFwiLFxuICAgICAgICBcInVybC5odHRwczovL2dpdGh1Yi5jb20vLmluc3RlYWRPZlwiLFxuICAgICAgICBcImdpdEBnaXRodWIuY29tOlwiLFxuICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGFyZ3M6IFtcbiAgICAgICAgXCItLWdsb2JhbFwiLFxuICAgICAgICBcIi0tcmVwbGFjZS1hbGxcIixcbiAgICAgICAgXCJjcmVkZW50aWFsLmh0dHBzOi8vZ2l0aHViLmNvbS5oZWxwZXJcIixcbiAgICAgICAgXCJcIixcbiAgICAgIF0sXG4gICAgfSxcbiAgICB7XG4gICAgICBhcmdzOiBbXG4gICAgICAgIFwiLS1nbG9iYWxcIixcbiAgICAgICAgXCItLWFkZFwiLFxuICAgICAgICBcImNyZWRlbnRpYWwuaHR0cHM6Ly9naXRodWIuY29tLmhlbHBlclwiLFxuICAgICAgICBcIiFnaCBhdXRoIGdpdC1jcmVkZW50aWFsXCIsXG4gICAgICBdLFxuICAgICAgYWRkOiB0cnVlLFxuICAgIH0sXG4gIF07XG4gIGlmIChsb2dpbikge1xuICAgIGVudHJpZXMucHVzaCh7IGFyZ3M6IFtcIi0tZ2xvYmFsXCIsIFwidXNlci5uYW1lXCIsIGxvZ2luXSB9KTtcbiAgICBlbnRyaWVzLnB1c2goe1xuICAgICAgYXJnczogW1wiLS1nbG9iYWxcIiwgXCJ1c2VyLmVtYWlsXCIsIGAke2xvZ2lufUB1c2Vycy5ub3JlcGx5LmdpdGh1Yi5jb21gXSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gZW50cmllcztcbn1cblxuLyoqXG4gKiBUaGUgc2VydmljZS1hY2NvdW50IGxvZ2luIHJlY29yZGVkIGluIHRoZSBtb3VudGVkIGBob3N0cy55bWxgLlxuICpcbiAqIFRoZSBzYW1lIGBzZWRgIHRoZSBlbnRyeXBvaW50IHVzZXMsIGluIFR5cGVTY3JpcHQ6IHRoZSBmaXJzdCBgdXNlcjpgIGxpbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtb3VudGVkR2l0TG9naW4oXG4gIGhvbWU6IHN0cmluZyxcbiAgaW86IEdoQ3JlZGVudGlhbFN0YWdlSW8gPSBwcm9kdWN0aW9uSW8sXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgcmF3ID0gaW8ucmVhZEZpbGUobW91bnRlZEhvc3RzUGF0aChob21lKSk7XG4gIGlmIChyYXcgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBjb25zdCB0ZXh0ID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJhdyk7XG4gIGNvbnN0IG1hdGNoID0gdGV4dC5tYXRjaCgvXlxccyp1c2VyOlxccyooXFxTKylcXHMqJC9tKTtcbiAgcmV0dXJuIG1hdGNoID8gbWF0Y2hbMV0hIDogbnVsbDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWlEQyxHQUVELFNBQ0UsNkJBQTZCLEVBQzdCLG9CQUFvQixFQUNwQixhQUFhLEVBQ2IsZUFBZSxRQUNWLDRCQUE0QjtBQUVuQyxTQUNFLGdCQUFnQixFQUNoQixhQUFhLEVBQ2IsaUJBQWlCLFFBQ1oseUJBQXlCO0FBRWhDLG9FQUFvRSxHQUNwRSxPQUFPLE1BQU0sZ0JBQWdCLGlCQUFpQjtBQUU5Qyx3REFBd0QsR0FDeEQsT0FBTyxNQUFNLHFCQUFxQixZQUFZO0FBRTlDLHdFQUF3RSxHQUN4RSxPQUFPLE1BQU0sb0JBQW9CLE1BQU07QUFFdkM7Ozs7OztDQU1DLEdBQ0QsT0FBTyxNQUFNLHVCQUF1QixFQUFFO0FBMkN0QyxNQUFNLGVBQW9DO0VBQ3hDLFVBQVMsSUFBSTtJQUNYLElBQUk7TUFDRixPQUFPLEtBQUssWUFBWSxDQUFDO0lBQzNCLEVBQUUsT0FBTTtNQUNOLE9BQU87SUFDVDtFQUNGO0VBQ0Esa0JBQWlCLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSTtJQUMvQix3RUFBd0U7SUFDeEUscUVBQXFFO0lBQ3JFLDBEQUEwRDtJQUMxRCxLQUFLLGFBQWEsQ0FBQyxNQUFNLE1BQU07TUFBRTtNQUFNLFdBQVc7SUFBSztFQUN6RDtFQUNBLGdCQUFlLElBQUksRUFBRSxJQUFJO0lBQ3ZCLDBFQUEwRTtJQUMxRSxtRUFBbUU7SUFDbkUsb0VBQW9FO0lBQ3BFLHlFQUF5RTtJQUN6RSx5RUFBeUU7SUFDekUsMENBQTBDO0lBQzFDLE1BQU0sU0FBUyxLQUFLLEtBQUssQ0FBQyxHQUFHLEtBQUssV0FBVyxDQUFDO0lBQzlDLElBQUksT0FBTyxNQUFNLEdBQUcsR0FBRyxLQUFLLFNBQVMsQ0FBQyxRQUFRO01B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
// denoCacheMetadata=2382050541504606629,11571182768784300927