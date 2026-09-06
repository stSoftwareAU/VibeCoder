/**
 * Worker-private cache directory helpers (Issue #3709, SEC-e70b8134af26).
 *
 * File-backed caches under `TMPDIR` live at a predictable, world-writable
 * path on a shared host. Any local account could therefore pre-create a
 * cache directory (or drop a file into one) and have the worker read
 * attacker-authored data back as if it were a GitHub API response.
 *
 * These helpers bind such a cache to the account running the worker:
 *
 *  - {@link cacheDirUserSuffix} gives each account its own directory, so two
 *    users on one host never share a cache path.
 *  - {@link ensurePrivateDir} creates it `0700` (owner-only).
 *  - {@link verifyPrivateDir} refuses a directory that is group/other
 *    accessible or owned by another uid.
 *
 * The uid is resolved by stat-ing `$HOME` rather than calling `Deno.uid()`,
 * which needs `--allow-sys=uid` the worker does not grant (an ungranted
 * permission would prompt, and an unattended worker has no one to answer).
 *
 * These are defence in depth only: a cache must never be the sole basis for a
 * trust decision (see `wasLabelAddedByAllowedAuthor`).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Mode a worker-private cache directory must have: owner-only access. */
export const PRIVATE_DIR_MODE = 0o700;

/** Outcome of a {@link verifyPrivateDir} check. */
export interface PrivateDirTrust {
  /** True when the directory is safe for the worker to read cached data from. */
  trusted: boolean;
  /** Human-readable reason when `trusted` is false. */
  reason?: string;
}

/** Read an environment variable, tolerating a missing `--allow-env` grant. */
function envOrNull(name: string): string | null {
  try {
    return Deno.env.get(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the uid of the account running the worker, or null when it cannot be
 * determined (Windows, no `$HOME`, unreadable home directory).
 */
export function resolveOwnUid(): number | null {
  const home = envOrNull("HOME");
  if (!home) return null;
  try {
    return Deno.statSync(home).uid;
  } catch {
    return null;
  }
}

/**
 * Per-account suffix for a shared-tmp cache directory, so the path is not the
 * same for every user on the host. Prefers the uid; falls back to a sanitised
 * login name, then a fixed literal (the ownership check in
 * {@link verifyPrivateDir} still applies in that case).
 */
export function cacheDirUserSuffix(): string {
  const uid = resolveOwnUid();
  if (uid !== null) return `uid${uid}`;
  const login = envOrNull("USER") ?? envOrNull("LOGNAME");
  const safe = (login ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "unknown-user";
}

/**
 * The single place a shared-tmp state directory name is built (Issue #1215).
 *
 * `${TMPDIR}/<name>` is the same path for every account on the host, so any
 * local user can create it first and own what the worker later reads back.
 * Composing the name here — never by interpolating `TMPDIR` at the call site
 * — binds the directory to this account, and the quality gate's
 * `tmp_state_dir_check.ts` fails the build on a raw interpolation that
 * bypasses it.
 *
 * @param name - Stable base name for the directory, e.g. `vibe-issue-cache`.
 * @param lookup - Environment reader, injectable for tests.
 * @returns Absolute path of the per-account directory (not created).
 */
export function sharedTmpStateDir(
  name: string,
  lookup: (key: string) => string | undefined = defaultLookup,
): string {
  return `${sharedTmpRoot(lookup)}/${name}-${cacheDirUserSuffix()}`;
}

/** Environment reader used when a caller supplies none. */
function defaultLookup(key: string): string | undefined {
  return envOrNull(key) ?? undefined;
}

/** The host's shared temporary root, with trailing separators stripped. */
function sharedTmpRoot(
  lookup: (key: string) => string | undefined = defaultLookup,
): string {
  const configured = lookup("TMPDIR") ?? lookup("TEMP") ?? lookup("TMP");
  return (configured ?? "/tmp").replace(/\/+$/, "") || "/tmp";
}

/**
 * Whether `dir` sits inside the host's shared temporary root (Issue #1215).
 *
 * A cache told to use an explicit directory cannot assume that directory is
 * private: `codebase_map_cache.ts` passed a fixed `/tmp` literal, which is
 * every bit as world-writable as the default was. Callers use this to decide
 * whether the ownership check applies, so the control follows the *location*
 * rather than the argument.
 *
 * @param dir - Directory to classify.
 * @param lookup - Environment reader, injectable for tests.
 * @returns True when `dir` is at or below `TMPDIR`/`TEMP`/`TMP`/`/tmp`.
 */
export function isSharedTmpPath(
  dir: string,
  lookup: (key: string) => string | undefined = defaultLookup,
): boolean {
  const normalised = dir.replace(/\/+$/, "") || "/";
  const roots = new Set([sharedTmpRoot(lookup), "/tmp"]);
  for (const root of roots) {
    if (normalised === root || normalised.startsWith(`${root}/`)) return true;
  }
  return false;
}

/** Create `dir` (and any parents) with owner-only permissions. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Create a worker state directory and report whether it may be trusted
 * (Issue #1242).
 *
 * The control follows the directory's **location**, exactly as `IssueCache`
 * decides: a directory at or below the shared temporary root is created
 * `0700` and ownership-checked, because any local account could have created
 * it first; a directory on the work volume — whose permissions the worker
 * does not own — is created as given and trusted.
 *
 * Callers must act on an untrusted verdict (skip the cache, refuse the
 * write, warn loudly). Returning the verdict rather than throwing lets each
 * caller choose, but never lets one ignore the answer by accident.
 *
 * @param dir - Directory to create.
 * @param lookup - Environment reader, injectable for tests.
 * @returns Whether the created directory is safe for this worker to use.
 */
export async function ensureStateDir(
  dir: string,
  lookup: (key: string) => string | undefined = defaultLookup,
): Promise<PrivateDirTrust> {
  if (!isSharedTmpPath(dir, lookup)) {
    await Deno.mkdir(dir, { recursive: true });
    return { trusted: true };
  }
  try {
    await ensurePrivateDir(dir);
  } catch {
    // Creation failure is reported by the verification below.
  }
  const trust = await verifyPrivateDir(dir);
  if (trust.trusted) return trust;
  return await tightenOwnDir(dir);
}

/**
 * Tighten a directory only this account could have written to, then re-verify.
 *
 * A pre-existing directory at the umask default (`0755`) is ours and no other
 * account can have planted anything in it, so narrowing it to `0700` is safe
 * — and is what keeps a work directory that happens to sit under the
 * temporary root usable. A group/other **writable** directory is a different
 * thing entirely: anyone could already have dropped a file in it, so it is
 * refused rather than healed, and so is a directory owned by another uid.
 */
async function tightenOwnDir(dir: string): Promise<PrivateDirTrust> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(dir);
  } catch (err) {
    return {
      trusted: false,
      reason: `cannot stat directory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const ownUid = resolveOwnUid();
  const ownedByUs = ownUid === null || info.uid === null ||
    info.uid === ownUid;
  const writableByOthers = info.mode !== null && (info.mode & 0o022) !== 0;
  if (!info.isDirectory || !ownedByUs || writableByOthers) {
    return await verifyPrivateDir(dir);
  }

  try {
    await Deno.chmod(dir, PRIVATE_DIR_MODE);
  } catch {
    // Reported by the verification below.
  }
  return await verifyPrivateDir(dir);
}

/**
 * Verify `dir` is a worker-private directory — a real directory, owned by this
 * account, with no group or other access bits.
 *
 * Platforms that do not report `mode`/`uid` (Windows) skip the corresponding
 * check rather than failing every read.
 */
export async function verifyPrivateDir(
  dir: string,
): Promise<PrivateDirTrust> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(dir);
  } catch (err) {
    return {
      trusted: false,
      reason: `cannot stat directory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!info.isDirectory) return { trusted: false, reason: "not a directory" };

  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    const octal = (info.mode & 0o7777).toString(8).padStart(4, "0");
    return {
      trusted: false,
      reason: `group/other accessible (mode ${octal}, expected 0700)`,
    };
  }

  const ownUid = resolveOwnUid();
  if (ownUid !== null && info.uid !== null && info.uid !== ownUid) {
    return {
      trusted: false,
      reason: `owned by uid ${info.uid}, expected uid ${ownUid}`,
    };
  }

  return { trusted: true };
}
