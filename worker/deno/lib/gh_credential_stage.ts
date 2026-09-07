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
 */

import {
  DEFAULT_CREDENTIAL_DIR_SUFFIX,
  GH_CREDENTIAL_SUBDIR,
  GH_HOSTS_FILE,
  SCRATCH_DIR_ENV,
} from "./credential_preflight.ts";
import type { EnvLookup } from "./env_lookup.ts";
import {
  PRIVATE_DIR_MODE,
  resolveOwnUid,
  sharedTmpStateDir,
} from "./private_cache_dir.ts";

/** Environment variable naming the container's durable state root. */
export const STATE_DIR_ENV = "VIBE_STATE_DIR";

/** Leaf directory the worker stages its own copy into. */
export const STAGED_GH_DIR_NAME = "gh-config";

/** Mode the staged `hosts.yml` is created with: owner read/write only. */
export const STAGED_HOSTS_MODE = 0o600;

/**
 * Re-stagings one process will perform.
 *
 * A copy that keeps vanishing is a fault to report, not to paper over; and a
 * revoked or expired token would otherwise re-stage on every call for the
 * life of the run.
 */
export const MAX_RESTAGE_ATTEMPTS = 3;

/** What an `lstat` of a staging path shows; a symlink is never followed. */
export interface StagedPathStat {
  /** True only for a real directory — a symlink to one is not a directory. */
  directory: boolean;
  /** Owning uid, or null when the platform does not report one. */
  uid: number | null;
  /** Permission bits (`mode & 0o7777`), or null when unavailable. */
  mode: number | null;
}

/** Filesystem seams, injected so the tests never touch a real credential. */
export interface GhCredentialStageIo {
  readFile: (path: string) => Uint8Array | null;
  /**
   * Create `path` exclusively with `mode` applied at creation. Throws when
   * anything already occupies the path — never truncates, never follows a
   * symlink into somewhere else.
   */
  writePrivateFile: (path: string, data: Uint8Array, mode: number) => void;
  /** Create `path` non-recursively with `mode`; throws when it exists. */
  makePrivateDir: (path: string, mode: number) => void;
  /** `lstat` the path: null when absent, symlinks reported as themselves. */
  lstat: (path: string) => StagedPathStat | null;
  /** Remove a path, tolerating an absent one; never follows a symlink. */
  remove: (path: string, recursive?: boolean) => void;
  /** uid of the account running the worker, or null when unknown. */
  ownerUid: () => number | null;
  isWritableDir: (path: string) => boolean;
}

/** Options for {@link restageGhConfigDir}, all seams defaulted to production. */
export interface RestageOptions {
  /** Worker home directory; defaults to `$HOME`. */
  home?: string;
  /** Environment lookup, injectable for tests. */
  env?: EnvLookup;
  io?: GhCredentialStageIo;
  /** Where a warning goes; defaults to stderr. */
  warn?: (message: string) => void;
}

const productionIo: GhCredentialStageIo = {
  readFile(path) {
    try {
      return Deno.readFileSync(path);
    } catch {
      return null;
    }
  },
  writePrivateFile(path, data, mode) {
    // `createNew` plus `mode`: the credential is never on disk at the umask
    // default, and an exclusive create cannot be redirected by a symlink
    // planted between the unlink and this call (Issue #1282).
    Deno.writeFileSync(path, data, { mode, createNew: true });
  },
  makePrivateDir(path, mode) {
    // The leaf is created non-recursively with `mode` applied at creation, so
    // a directory that already exists is reported (EEXIST) rather than
    // silently adopted — including one that appeared since the `lstat`.
    // Missing parents are still created: a staging root the entrypoint chose
    // always exists, but the leaf is the only directory the credential lands
    // in and the only one whose mode matters.
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent.length > 0) Deno.mkdirSync(parent, { recursive: true });
    Deno.mkdirSync(path, { recursive: false, mode });
  },
  lstat(path) {
    try {
      const info = Deno.lstatSync(path);
      return {
        directory: info.isDirectory,
        uid: info.uid,
        mode: info.mode === null ? null : info.mode & 0o7777,
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  },
  remove(path, recursive = false) {
    try {
      Deno.removeSync(path, { recursive });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  },
  ownerUid() {
    // Stats `$HOME` rather than calling `Deno.uid()`, which needs an
    // `--allow-sys=uid` grant the worker does not hold.
    return resolveOwnUid();
  },
  isWritableDir(path) {
    const probe = `${path}/.vibe-write-probe`;
    try {
      Deno.writeTextFileSync(probe, "");
      Deno.removeSync(probe);
      return true;
    } catch {
      return false;
    }
  },
};

function defaultEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/**
 * The read-only credential mount `hosts.yml` — the source of truth.
 *
 * @param home - Worker home directory.
 */
export function mountedHostsPath(home: string): string {
  return `${home}/${DEFAULT_CREDENTIAL_DIR_SUFFIX}/${GH_CREDENTIAL_SUBDIR}/` +
    GH_HOSTS_FILE;
}

/**
 * Whether a `GH_CONFIG_DIR` can actually serve a `gh` call.
 *
 * Present, non-empty and writable — an empty `hosts.yml` authenticates
 * nothing, and the Issue #554 fallback left exactly that behind when its
 * copy failed.
 */
export function isGhConfigDirUsable(
  dir: string | undefined,
  io: GhCredentialStageIo = productionIo,
): boolean {
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
 */
export function stagingCandidates(
  env: EnvLookup = defaultEnv,
): string[] {
  const state = env(STATE_DIR_ENV);
  const scratch = env(SCRATCH_DIR_ENV);
  return [
    state ? `${state}/${STAGED_GH_DIR_NAME}` : undefined,
    scratch ? `${scratch}/${STAGED_GH_DIR_NAME}` : undefined,
    sharedTmpStateDir(`vibe-${STAGED_GH_DIR_NAME}`, env),
  ].filter((dir): dir is string => dir !== undefined);
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
 */
export function stagingDirRefusal(
  stat: StagedPathStat,
  ownUid: number | null,
): string | null {
  if (!stat.directory) {
    return "the path is not a directory (a symlink or file occupies it)";
  }
  if (ownUid !== null && stat.uid !== null && stat.uid !== ownUid) {
    return `the directory is owned by uid ${stat.uid}, not this account ` +
      `(uid ${ownUid})`;
  }
  if (stat.mode !== null && (stat.mode & 0o077) !== 0) {
    const octal = stat.mode.toString(8).padStart(4, "0");
    return `the directory is group/other accessible (mode ${octal}, ` +
      "expected 0700)";
  }
  return null;
}

/**
 * Directories this process created, removed when the run ends.
 *
 * Only what this process created: a directory the entrypoint or a sibling
 * worker staged is still in use and is not ours to delete.
 */
const createdStagingDirs = new Set<string>();

let runEndCleanupRegistered = false;

/** Options for {@link removeStagedGhConfigDirs}. */
export interface RemoveStagedOptions {
  io?: GhCredentialStageIo;
  warn?: (message: string) => void;
}

/**
 * Remove the staging directories this process created (Issue #1282).
 *
 * Registered on `unload` by the first successful staging, so the credential
 * does not outlive the run on a shared host; exported so a caller — or a
 * test — can trigger the removal itself.
 *
 * @returns The directories actually removed.
 */
export function removeStagedGhConfigDirs(
  options: RemoveStagedOptions = {},
): string[] {
  const io = options.io ?? productionIo;
  const warn = options.warn ?? ((message: string) => console.error(message));
  const removed: string[] = [];
  for (const dir of createdStagingDirs) {
    try {
      io.remove(dir, true);
      removed.push(dir);
    } catch (error) {
      warn(
        `[SECURITY] could not remove the staged gh credential at ${dir}: ` +
          describeError(error),
      );
    }
  }
  createdStagingDirs.clear();
  return removed;
}

/** Note a directory this process created, and arm the run-end removal. */
function rememberCreatedStagingDir(dir: string): void {
  createdStagingDirs.add(dir);
  if (runEndCleanupRegistered) return;
  runEndCleanupRegistered = true;
  globalThis.addEventListener("unload", () => {
    removeStagedGhConfigDirs();
  });
}

/** The message of a thrown value, whatever it turned out to be. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Make `candidate` a directory this account owns, or throw saying why not.
 *
 * @returns True when this call created it — and so owns removing it.
 */
function prepareStagingDir(
  candidate: string,
  io: GhCredentialStageIo,
): boolean {
  const existing = io.lstat(candidate);
  if (existing === null) {
    io.makePrivateDir(candidate, PRIVATE_DIR_MODE);
    return true;
  }
  const refusal = stagingDirRefusal(existing, io.ownerUid());
  if (refusal !== null) throw new Error(refusal);
  return false;
}

/** Write `hosts.yml` into a prepared staging directory, 0600 from birth. */
function writeStagedCredential(
  candidate: string,
  source: Uint8Array,
  io: GhCredentialStageIo,
): void {
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
 */
export function restageGhConfigDir(
  options: RestageOptions = {},
): string | null {
  const env = options.env ?? defaultEnv;
  const io = options.io ?? productionIo;
  const home = options.home ?? env("HOME") ?? "";
  const warn = options.warn ?? ((message: string) => console.error(message));

  const source = io.readFile(mountedHostsPath(home));
  if (source === null || source.length === 0) {
    // Nothing to re-stage from: this is a credential problem, not a staging
    // problem, and the preflight's message is the one that should be read.
    warn(
      `[SECURITY] cannot re-stage the gh credential: ${
        mountedHostsPath(home)
      } is missing or empty`,
    );
    return null;
  }

  for (const candidate of stagingCandidates(env)) {
    let created = false;
    try {
      created = prepareStagingDir(candidate, io);
      writeStagedCredential(candidate, source, io);
    } catch (error) {
      // Loud, and per candidate (Issue #1282): a refusal here is either a
      // directory that is not this account's or a genuinely unusable
      // candidate, and the old silent catch hid both — after the token had
      // already been written.
      warn(
        `[SECURITY] refusing to stage the gh credential at ${candidate}: ` +
          describeError(error),
      );
      continue;
    }
    if (created) rememberCreatedStagingDir(candidate);
    if (!isGhConfigDirUsable(candidate, io)) continue;
    warn(
      `[SECURITY] re-staged the gh credential from the read-only mount to ` +
        `${candidate} (Issue #564)`,
    );
    return candidate;
  }

  warn(
    "[SECURITY] cannot re-stage the gh credential: no writable staging " +
      `directory (tried ${stagingCandidates(env).join(", ")})`,
  );
  return null;
}

/** What {@link resolveUsableGhConfigDir} decided, with nothing applied. */
export interface GhConfigDirResolution {
  /** True when the configuration is usable once {@link env} is applied. */
  usable: boolean;
  /**
   * The variables to establish — `GH_CONFIG_DIR` when a re-stage produced a
   * new directory, and empty when the current one was already usable or
   * nothing could be staged.
   */
  env: Record<string, string>;
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
 */
export function resolveUsableGhConfigDir(
  options: RestageOptions = {},
): GhConfigDirResolution {
  const env = options.env ?? defaultEnv;
  const io = options.io ?? productionIo;
  const current = env("GH_CONFIG_DIR");
  if (isGhConfigDirUsable(current, io)) return { usable: true, env: {} };

  const staged = restageGhConfigDir(options);
  if (staged === null) return { usable: false, env: {} };
  return { usable: true, env: { GH_CONFIG_DIR: staged } };
}

/** Options for {@link ensureUsableGhConfigDir}. */
export interface EnsureGhConfigDirOptions extends RestageOptions {
  /**
   * Establishes one variable in the run environment; defaults to
   * `Deno.env.set`, which is what every child `gh` and `git` inherits. A test
   * hands in a recorder and asserts on the map instead.
   */
  setEnv?: (name: string, value: string) => void;
}

/** Apply one variable to the process, tolerating a permission denial. */
function processSetEnv(name: string, value: string): void {
  try {
    Deno.env.set(name, value);
  } catch {
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
 */
export function ensureUsableGhConfigDir(
  options: EnsureGhConfigDirOptions = {},
): boolean {
  const resolution = resolveUsableGhConfigDir(options);
  const setEnv = options.setEnv ?? processSetEnv;
  for (const [name, value] of Object.entries(resolution.env)) {
    setEnv(name, value);
  }
  return resolution.usable;
}

/** True when a finished `gh` call failed because it had no authentication. */
export function isGhAuthMissingFailure(
  result: { code: number; stderr: string },
): boolean {
  if (result.code === 0) return false;
  const stderr = result.stderr.toLowerCase();
  return stderr.includes("gh auth login") ||
    stderr.includes("no accounts configured") ||
    stderr.includes("authentication token not found");
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
 */
export function isGitAuthMissingFailure(
  result: { code: number; stderr: string },
): boolean {
  if (result.code === 0) return false;
  const stderr = result.stderr.toLowerCase();
  return stderr.includes("could not read username") ||
    stderr.includes("terminal prompts disabled") ||
    stderr.includes("please tell me who you are") ||
    stderr.includes("unable to auto-detect email address") ||
    stderr.includes("authentication failed");
}

/** The transport, credential helper and identity the entrypoint stages. */
export interface GitGlobalConfigEntry {
  args: string[];
  /** True when the entry is added to a multi-valued key. */
  add?: boolean;
}

/**
 * The global git configuration the container needs, rebuilt from the mount.
 *
 * Mirrors `container/entrypoint.sh`: SSH remotes rewritten to HTTPS, `gh` as
 * the credential helper, and an identity taken from the mounted credential.
 * Returns an empty list when the mount names no user — nothing is guessed.
 *
 * @param login - The service-account login, from the mounted `hosts.yml`.
 */
export function gitGlobalConfigEntries(
  login: string | null,
): GitGlobalConfigEntry[] {
  const entries: GitGlobalConfigEntry[] = [
    { args: ["--global", "--add", "safe.directory", "*"], add: true },
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
        "git@github.com:",
      ],
    },
    {
      args: [
        "--global",
        "--replace-all",
        "credential.https://github.com.helper",
        "",
      ],
    },
    {
      args: [
        "--global",
        "--add",
        "credential.https://github.com.helper",
        "!gh auth git-credential",
      ],
      add: true,
    },
  ];
  if (login) {
    entries.push({ args: ["--global", "user.name", login] });
    entries.push({
      args: ["--global", "user.email", `${login}@users.noreply.github.com`],
    });
  }
  return entries;
}

/**
 * The service-account login recorded in the mounted `hosts.yml`.
 *
 * The same `sed` the entrypoint uses, in TypeScript: the first `user:` line.
 */
export function mountedGitLogin(
  home: string,
  io: GhCredentialStageIo = productionIo,
): string | null {
  const raw = io.readFile(mountedHostsPath(home));
  if (raw === null) return null;
  const text = new TextDecoder().decode(raw);
  const match = text.match(/^\s*user:\s*(\S+)\s*$/m);
  return match ? match[1]! : null;
}
