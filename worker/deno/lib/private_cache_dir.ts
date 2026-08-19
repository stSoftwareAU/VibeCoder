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

/** Create `dir` (and any parents) with owner-only permissions. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
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
