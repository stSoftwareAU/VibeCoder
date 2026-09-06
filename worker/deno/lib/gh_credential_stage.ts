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
 * - the staging targets are private-ish and ordered: the durable state root
 *   first, then scratch, then `TMPDIR`, so the copy follows the entrypoint's
 *   own policy;
 * - re-staging is bounded (see {@link MAX_RESTAGE_ATTEMPTS}) so a genuinely
 *   revoked token fails loudly instead of spinning; and
 * - the copy is made symlink-free and worker-private from the first byte
 *   (Issue #1238): the directory is tightened to 0700 *before* the token is
 *   written, and the write itself is an exclusive create at 0600 renamed over
 *   the target, so a link pre-positioned in the agents' scratch space is
 *   replaced rather than followed.
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
import { atomicWriteSync } from "./file_utils.ts";
import { sharedTmpStateDir } from "./private_cache_dir.ts";

/** Environment variable naming the container's durable state root. */
export const STATE_DIR_ENV = "VIBE_STATE_DIR";

/** Leaf directory the worker stages its own copy into. */
export const STAGED_GH_DIR_NAME = "gh-config";

/** Mode the staged `hosts.yml` is created with — never the umask's (#1238). */
export const CREDENTIAL_FILE_MODE = 0o600;

/** Mode the staging directory is tightened to, before the token lands (#1238). */
export const CREDENTIAL_DIR_MODE = 0o700;

/**
 * Re-stagings one process will perform.
 *
 * A copy that keeps vanishing is a fault to report, not to paper over; and a
 * revoked or expired token would otherwise re-stage on every call for the
 * life of the run.
 */
export const MAX_RESTAGE_ATTEMPTS = 3;

/** Filesystem seams, injected so the tests never touch a real credential. */
export interface GhCredentialStageIo {
  readFile: (path: string) => Uint8Array | null;
  /**
   * Write a credential file, never through a symlink already at the path and
   * never at the process umask's mode (Issue #1238). Throws on failure — a
   * credential that did not land is not a staged credential.
   */
  writeFile: (path: string, data: Uint8Array) => void;
  mkdir: (path: string) => void;
  chmod: (path: string, mode: number) => void;
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
  writeFile(path, data) {
    // Issue #1238: a bare Deno.writeFileSync is O_CREAT|O_TRUNC at the umask's
    // mode and follows a symlink, so a token could be written straight through
    // a link a co-located account had pre-positioned at hosts.yml — and sat at
    // 0644 until the chmod that followed. atomicWriteSync creates a
    // kernel-random sibling with createNew (O_EXCL) at 0600 and renames it over
    // the target: rename replaces a planted link rather than following it, and
    // the credential is never readable at any other mode.
    const result = atomicWriteSync({
      targetFile: path,
      content: data,
      mode: CREDENTIAL_FILE_MODE,
    });
    if (!result.ok) throw result.error;
  },
  mkdir(path) {
    Deno.mkdirSync(path, { recursive: true, mode: CREDENTIAL_DIR_MODE });
  },
  chmod(path, mode) {
    Deno.chmodSync(path, mode);
  },
  isWritableDir(path) {
    // A fixed probe name is an arbitrary-truncation primitive on every path
    // this probes (Issue #1238): a link planted at it was followed and its
    // target truncated. A kernel-random name cannot be pre-positioned, and
    // createNew refuses anything already at the name rather than opening it.
    const probe = `${path}/.vibe-write-probe.${crypto.randomUUID()}`;
    try {
      Deno.openSync(probe, {
        write: true,
        createNew: true,
        mode: CREDENTIAL_FILE_MODE,
      }).close();
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
 * Issue #1242: the temporary-root candidate is composed by
 * {@link sharedTmpStateDir}, so the staged `gh` credentials land in a
 * per-account directory rather than at one path every account on the host
 * could create first.
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
    try {
      io.mkdir(candidate);
      // Tighten the directory BEFORE the token lands in it (Issue #1238).
      // mkdir accepts an already-existing directory of any mode or ownership
      // silently, so a chmod afterwards left the credential readable to a
      // co-located account for the width of the write. Doing it first also
      // rejects a candidate another uid owns — chmod is the owner's alone, so
      // a directory (or a symlinked one) planted by the `agent` account fails
      // here, loudly, with nothing written.
      io.chmod(candidate, CREDENTIAL_DIR_MODE);
      io.writeFile(`${candidate}/${GH_HOSTS_FILE}`, source);
      io.chmod(`${candidate}/${GH_HOSTS_FILE}`, CREDENTIAL_FILE_MODE);
      if (!isGhConfigDirUsable(candidate, io)) continue;
      warn(
        `[SECURITY] re-staged the gh credential from the read-only mount to ` +
          `${candidate} (Issue #564)`,
      );
      return candidate;
    } catch (err) {
      // Try the next candidate — but never silently: a refused symlink or a
      // directory owned by another account is exactly what an operator has to
      // hear about (Issue #1238).
      warn(
        `[SECURITY] cannot stage the gh credential into ${candidate}: ` +
          `${(err as Error).message}`,
      );
    }
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
