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
 *   revoked token fails loudly instead of spinning.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import {
  DEFAULT_CREDENTIAL_DIR_SUFFIX,
  GH_CREDENTIAL_SUBDIR,
  GH_HOSTS_FILE,
  SCRATCH_DIR_ENV,
} from "./credential_preflight.ts";

/** Environment variable naming the container's durable state root. */
export const STATE_DIR_ENV = "VIBE_STATE_DIR";

/** Leaf directory the worker stages its own copy into. */
export const STAGED_GH_DIR_NAME = "gh-config";

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
  env?: (name: string) => string | undefined;
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
    Deno.writeFileSync(path, data);
  },
  mkdir(path) {
    Deno.mkdirSync(path, { recursive: true, mode: 0o700 });
  },
  chmod(path, mode) {
    Deno.chmodSync(path, mode);
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
 */
export function stagingCandidates(
  env: (name: string) => string | undefined = defaultEnv,
): string[] {
  const state = env(STATE_DIR_ENV);
  const scratch = env(SCRATCH_DIR_ENV);
  const tmp = env("TMPDIR")?.replace(/\/+$/, "");
  return [
    state ? `${state}/${STAGED_GH_DIR_NAME}` : undefined,
    scratch ? `${scratch}/${STAGED_GH_DIR_NAME}` : undefined,
    `${tmp && tmp.length > 0 ? tmp : "/tmp"}/vibe-${STAGED_GH_DIR_NAME}`,
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
      io.writeFile(`${candidate}/${GH_HOSTS_FILE}`, source);
      io.chmod(candidate, 0o700);
      io.chmod(`${candidate}/${GH_HOSTS_FILE}`, 0o600);
      if (!isGhConfigDirUsable(candidate, io)) continue;
      warn(
        `[SECURITY] re-staged the gh credential from the read-only mount to ` +
          `${candidate} (Issue #564)`,
      );
      return candidate;
    } catch {
      // Try the next candidate; the caller's own failure stays the loud one.
    }
  }

  warn(
    "[SECURITY] cannot re-stage the gh credential: no writable staging " +
      `directory (tried ${stagingCandidates(env).join(", ")})`,
  );
  return null;
}

/**
 * Ensure `GH_CONFIG_DIR` names a usable directory, re-staging if it does not.
 *
 * Applies the result to the process environment so every child `gh` and
 * `git` inherits it.
 *
 * @returns True when the environment now points at a usable configuration.
 */
export function ensureUsableGhConfigDir(
  options: RestageOptions = {},
): boolean {
  const env = options.env ?? defaultEnv;
  const io = options.io ?? productionIo;
  const current = env("GH_CONFIG_DIR");
  if (isGhConfigDirUsable(current, io)) return true;

  const staged = restageGhConfigDir(options);
  if (staged === null) return false;
  try {
    Deno.env.set("GH_CONFIG_DIR", staged);
  } catch {
    // A test environment without env-set permission still gets the copy.
  }
  return true;
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
