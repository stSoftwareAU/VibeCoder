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
 */ /** Mode a worker-private cache directory must have: owner-only access. */ export const PRIVATE_DIR_MODE = 0o700;
/** Read an environment variable, tolerating a missing `--allow-env` grant. */ function envOrNull(name) {
  try {
    return Deno.env.get(name) ?? null;
  } catch  {
    return null;
  }
}
/**
 * Resolve the uid of the account running the worker, or null when it cannot be
 * determined (Windows, no `$HOME`, unreadable home directory).
 */ export function resolveOwnUid() {
  const home = envOrNull("HOME");
  if (!home) return null;
  try {
    return Deno.statSync(home).uid;
  } catch  {
    return null;
  }
}
/**
 * Per-account suffix for a shared-tmp cache directory, so the path is not the
 * same for every user on the host. Prefers the uid; falls back to a sanitised
 * login name, then a fixed literal (the ownership check in
 * {@link verifyPrivateDir} still applies in that case).
 */ export function cacheDirUserSuffix() {
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
 */ export function sharedTmpStateDir(name, lookup = defaultLookup) {
  return `${sharedTmpRoot(lookup)}/${name}-${cacheDirUserSuffix()}`;
}
/** Environment reader used when a caller supplies none. */ function defaultLookup(key) {
  return envOrNull(key) ?? undefined;
}
/** The host's shared temporary root, with trailing separators stripped. */ function sharedTmpRoot(lookup = defaultLookup) {
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
 */ export function isSharedTmpPath(dir, lookup = defaultLookup) {
  const normalised = dir.replace(/\/+$/, "") || "/";
  const roots = new Set([
    sharedTmpRoot(lookup),
    "/tmp"
  ]);
  for (const root of roots){
    if (normalised === root || normalised.startsWith(`${root}/`)) return true;
  }
  return false;
}
/** Create `dir` (and any parents) with owner-only permissions. */ export async function ensurePrivateDir(dir) {
  await Deno.mkdir(dir, {
    recursive: true,
    mode: PRIVATE_DIR_MODE
  });
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
 */ export async function ensureStateDir(dir, lookup = defaultLookup) {
  if (!isSharedTmpPath(dir, lookup)) {
    await Deno.mkdir(dir, {
      recursive: true
    });
    return {
      trusted: true
    };
  }
  return await hardenStateDir(dir, {
    create: true
  });
}
/**
 * Harden `dir` wherever it lives, and report whether it may be trusted
 * (Issue #1261).
 *
 * {@link ensureStateDir} trusts a work-volume directory on sight, which is
 * right for state the worker only writes. A cache whose entries are read
 * back into a prompt — or, for the baseline quality cache, read back as
 * "the gate already passed" — needs the ownership check wherever the
 * directory sits: the work volume is not automatically private either, and
 * a planted `passed: true` entry would skip a whole quality gate.
 *
 * A pre-existing directory at the umask default is narrowed to `0700` by
 * {@link tightenOwnDir} rather than refused, so a cache directory an earlier
 * release created `0755` keeps working. A group/other **writable** directory,
 * or one owned by another uid, is refused — the caller must skip the cache.
 *
 * @param dir - Directory to harden.
 * @param options.create - Create the directory `0700` when absent. Leave it
 *   off on a read path so a miss never creates anything.
 * @returns Whether the directory is safe for this worker to use.
 */ export async function hardenStateDir(dir, options = {}) {
  if (options.create) {
    try {
      await ensurePrivateDir(dir);
    } catch  {
    // Creation failure is reported by the verification below.
    }
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
 */ async function tightenOwnDir(dir) {
  let info;
  try {
    info = await Deno.stat(dir);
  } catch (err) {
    return {
      trusted: false,
      reason: `cannot stat directory: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  const ownUid = resolveOwnUid();
  const ownedByUs = ownUid === null || info.uid === null || info.uid === ownUid;
  const writableByOthers = info.mode !== null && (info.mode & 0o022) !== 0;
  if (!info.isDirectory || !ownedByUs || writableByOthers) {
    return await verifyPrivateDir(dir);
  }
  try {
    await Deno.chmod(dir, PRIVATE_DIR_MODE);
  } catch  {
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
 */ export async function verifyPrivateDir(dir) {
  let info;
  try {
    info = await Deno.stat(dir);
  } catch (err) {
    return {
      trusted: false,
      reason: `cannot stat directory: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!info.isDirectory) return {
    trusted: false,
    reason: "not a directory"
  };
  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    const octal = (info.mode & 0o7777).toString(8).padStart(4, "0");
    return {
      trusted: false,
      reason: `group/other accessible (mode ${octal}, expected 0700)`
    };
  }
  const ownUid = resolveOwnUid();
  if (ownUid !== null && info.uid !== null && info.uid !== ownUid) {
    return {
      trusted: false,
      reason: `owned by uid ${info.uid}, expected uid ${ownUid}`
    };
  }
  return {
    trusted: true
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcml2YXRlX2NhY2hlX2Rpci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFdvcmtlci1wcml2YXRlIGNhY2hlIGRpcmVjdG9yeSBoZWxwZXJzIChJc3N1ZSAjMzcwOSwgU0VDLWU3MGI4MTM0YWYyNikuXG4gKlxuICogRmlsZS1iYWNrZWQgY2FjaGVzIHVuZGVyIGBUTVBESVJgIGxpdmUgYXQgYSBwcmVkaWN0YWJsZSwgd29ybGQtd3JpdGFibGVcbiAqIHBhdGggb24gYSBzaGFyZWQgaG9zdC4gQW55IGxvY2FsIGFjY291bnQgY291bGQgdGhlcmVmb3JlIHByZS1jcmVhdGUgYVxuICogY2FjaGUgZGlyZWN0b3J5IChvciBkcm9wIGEgZmlsZSBpbnRvIG9uZSkgYW5kIGhhdmUgdGhlIHdvcmtlciByZWFkXG4gKiBhdHRhY2tlci1hdXRob3JlZCBkYXRhIGJhY2sgYXMgaWYgaXQgd2VyZSBhIEdpdEh1YiBBUEkgcmVzcG9uc2UuXG4gKlxuICogVGhlc2UgaGVscGVycyBiaW5kIHN1Y2ggYSBjYWNoZSB0byB0aGUgYWNjb3VudCBydW5uaW5nIHRoZSB3b3JrZXI6XG4gKlxuICogIC0ge0BsaW5rIGNhY2hlRGlyVXNlclN1ZmZpeH0gZ2l2ZXMgZWFjaCBhY2NvdW50IGl0cyBvd24gZGlyZWN0b3J5LCBzbyB0d29cbiAqICAgIHVzZXJzIG9uIG9uZSBob3N0IG5ldmVyIHNoYXJlIGEgY2FjaGUgcGF0aC5cbiAqICAtIHtAbGluayBlbnN1cmVQcml2YXRlRGlyfSBjcmVhdGVzIGl0IGAwNzAwYCAob3duZXItb25seSkuXG4gKiAgLSB7QGxpbmsgdmVyaWZ5UHJpdmF0ZURpcn0gcmVmdXNlcyBhIGRpcmVjdG9yeSB0aGF0IGlzIGdyb3VwL290aGVyXG4gKiAgICBhY2Nlc3NpYmxlIG9yIG93bmVkIGJ5IGFub3RoZXIgdWlkLlxuICpcbiAqIFRoZSB1aWQgaXMgcmVzb2x2ZWQgYnkgc3RhdC1pbmcgYCRIT01FYCByYXRoZXIgdGhhbiBjYWxsaW5nIGBEZW5vLnVpZCgpYCxcbiAqIHdoaWNoIG5lZWRzIGAtLWFsbG93LXN5cz11aWRgIHRoZSB3b3JrZXIgZG9lcyBub3QgZ3JhbnQgKGFuIHVuZ3JhbnRlZFxuICogcGVybWlzc2lvbiB3b3VsZCBwcm9tcHQsIGFuZCBhbiB1bmF0dGVuZGVkIHdvcmtlciBoYXMgbm8gb25lIHRvIGFuc3dlcikuXG4gKlxuICogVGhlc2UgYXJlIGRlZmVuY2UgaW4gZGVwdGggb25seTogYSBjYWNoZSBtdXN0IG5ldmVyIGJlIHRoZSBzb2xlIGJhc2lzIGZvciBhXG4gKiB0cnVzdCBkZWNpc2lvbiAoc2VlIGB3YXNMYWJlbEFkZGVkQnlBbGxvd2VkQXV0aG9yYCkuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuLyoqIE1vZGUgYSB3b3JrZXItcHJpdmF0ZSBjYWNoZSBkaXJlY3RvcnkgbXVzdCBoYXZlOiBvd25lci1vbmx5IGFjY2Vzcy4gKi9cbmV4cG9ydCBjb25zdCBQUklWQVRFX0RJUl9NT0RFID0gMG83MDA7XG5cbi8qKiBPdXRjb21lIG9mIGEge0BsaW5rIHZlcmlmeVByaXZhdGVEaXJ9IGNoZWNrLiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcml2YXRlRGlyVHJ1c3Qge1xuICAvKiogVHJ1ZSB3aGVuIHRoZSBkaXJlY3RvcnkgaXMgc2FmZSBmb3IgdGhlIHdvcmtlciB0byByZWFkIGNhY2hlZCBkYXRhIGZyb20uICovXG4gIHRydXN0ZWQ6IGJvb2xlYW47XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSByZWFzb24gd2hlbiBgdHJ1c3RlZGAgaXMgZmFsc2UuICovXG4gIHJlYXNvbj86IHN0cmluZztcbn1cblxuLyoqIFJlYWQgYW4gZW52aXJvbm1lbnQgdmFyaWFibGUsIHRvbGVyYXRpbmcgYSBtaXNzaW5nIGAtLWFsbG93LWVudmAgZ3JhbnQuICovXG5mdW5jdGlvbiBlbnZPck51bGwobmFtZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIERlbm8uZW52LmdldChuYW1lKSA/PyBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIHVpZCBvZiB0aGUgYWNjb3VudCBydW5uaW5nIHRoZSB3b3JrZXIsIG9yIG51bGwgd2hlbiBpdCBjYW5ub3QgYmVcbiAqIGRldGVybWluZWQgKFdpbmRvd3MsIG5vIGAkSE9NRWAsIHVucmVhZGFibGUgaG9tZSBkaXJlY3RvcnkpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU93blVpZCgpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgaG9tZSA9IGVudk9yTnVsbChcIkhPTUVcIik7XG4gIGlmICghaG9tZSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcmV0dXJuIERlbm8uc3RhdFN5bmMoaG9tZSkudWlkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFBlci1hY2NvdW50IHN1ZmZpeCBmb3IgYSBzaGFyZWQtdG1wIGNhY2hlIGRpcmVjdG9yeSwgc28gdGhlIHBhdGggaXMgbm90IHRoZVxuICogc2FtZSBmb3IgZXZlcnkgdXNlciBvbiB0aGUgaG9zdC4gUHJlZmVycyB0aGUgdWlkOyBmYWxscyBiYWNrIHRvIGEgc2FuaXRpc2VkXG4gKiBsb2dpbiBuYW1lLCB0aGVuIGEgZml4ZWQgbGl0ZXJhbCAodGhlIG93bmVyc2hpcCBjaGVjayBpblxuICoge0BsaW5rIHZlcmlmeVByaXZhdGVEaXJ9IHN0aWxsIGFwcGxpZXMgaW4gdGhhdCBjYXNlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhY2hlRGlyVXNlclN1ZmZpeCgpOiBzdHJpbmcge1xuICBjb25zdCB1aWQgPSByZXNvbHZlT3duVWlkKCk7XG4gIGlmICh1aWQgIT09IG51bGwpIHJldHVybiBgdWlkJHt1aWR9YDtcbiAgY29uc3QgbG9naW4gPSBlbnZPck51bGwoXCJVU0VSXCIpID8/IGVudk9yTnVsbChcIkxPR05BTUVcIik7XG4gIGNvbnN0IHNhZmUgPSAobG9naW4gPz8gXCJcIikucmVwbGFjZSgvW15BLVphLXowLTkuXy1dL2csIFwiX1wiKTtcbiAgcmV0dXJuIHNhZmUgfHwgXCJ1bmtub3duLXVzZXJcIjtcbn1cblxuLyoqXG4gKiBUaGUgc2luZ2xlIHBsYWNlIGEgc2hhcmVkLXRtcCBzdGF0ZSBkaXJlY3RvcnkgbmFtZSBpcyBidWlsdCAoSXNzdWUgIzEyMTUpLlxuICpcbiAqIGAke1RNUERJUn0vPG5hbWU+YCBpcyB0aGUgc2FtZSBwYXRoIGZvciBldmVyeSBhY2NvdW50IG9uIHRoZSBob3N0LCBzbyBhbnlcbiAqIGxvY2FsIHVzZXIgY2FuIGNyZWF0ZSBpdCBmaXJzdCBhbmQgb3duIHdoYXQgdGhlIHdvcmtlciBsYXRlciByZWFkcyBiYWNrLlxuICogQ29tcG9zaW5nIHRoZSBuYW1lIGhlcmUg4oCUIG5ldmVyIGJ5IGludGVycG9sYXRpbmcgYFRNUERJUmAgYXQgdGhlIGNhbGwgc2l0ZVxuICog4oCUIGJpbmRzIHRoZSBkaXJlY3RvcnkgdG8gdGhpcyBhY2NvdW50LCBhbmQgdGhlIHF1YWxpdHkgZ2F0ZSdzXG4gKiBgdG1wX3N0YXRlX2Rpcl9jaGVjay50c2AgZmFpbHMgdGhlIGJ1aWxkIG9uIGEgcmF3IGludGVycG9sYXRpb24gdGhhdFxuICogYnlwYXNzZXMgaXQuXG4gKlxuICogQHBhcmFtIG5hbWUgLSBTdGFibGUgYmFzZSBuYW1lIGZvciB0aGUgZGlyZWN0b3J5LCBlLmcuIGB2aWJlLWlzc3VlLWNhY2hlYC5cbiAqIEBwYXJhbSBsb29rdXAgLSBFbnZpcm9ubWVudCByZWFkZXIsIGluamVjdGFibGUgZm9yIHRlc3RzLlxuICogQHJldHVybnMgQWJzb2x1dGUgcGF0aCBvZiB0aGUgcGVyLWFjY291bnQgZGlyZWN0b3J5IChub3QgY3JlYXRlZCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGFyZWRUbXBTdGF0ZURpcihcbiAgbmFtZTogc3RyaW5nLFxuICBsb29rdXA6IChrZXk6IHN0cmluZykgPT4gc3RyaW5nIHwgdW5kZWZpbmVkID0gZGVmYXVsdExvb2t1cCxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgJHtzaGFyZWRUbXBSb290KGxvb2t1cCl9LyR7bmFtZX0tJHtjYWNoZURpclVzZXJTdWZmaXgoKX1gO1xufVxuXG4vKiogRW52aXJvbm1lbnQgcmVhZGVyIHVzZWQgd2hlbiBhIGNhbGxlciBzdXBwbGllcyBub25lLiAqL1xuZnVuY3Rpb24gZGVmYXVsdExvb2t1cChrZXk6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBlbnZPck51bGwoa2V5KSA/PyB1bmRlZmluZWQ7XG59XG5cbi8qKiBUaGUgaG9zdCdzIHNoYXJlZCB0ZW1wb3Jhcnkgcm9vdCwgd2l0aCB0cmFpbGluZyBzZXBhcmF0b3JzIHN0cmlwcGVkLiAqL1xuZnVuY3Rpb24gc2hhcmVkVG1wUm9vdChcbiAgbG9va3VwOiAoa2V5OiBzdHJpbmcpID0+IHN0cmluZyB8IHVuZGVmaW5lZCA9IGRlZmF1bHRMb29rdXAsXG4pOiBzdHJpbmcge1xuICBjb25zdCBjb25maWd1cmVkID0gbG9va3VwKFwiVE1QRElSXCIpID8/IGxvb2t1cChcIlRFTVBcIikgPz8gbG9va3VwKFwiVE1QXCIpO1xuICByZXR1cm4gKGNvbmZpZ3VyZWQgPz8gXCIvdG1wXCIpLnJlcGxhY2UoL1xcLyskLywgXCJcIikgfHwgXCIvdG1wXCI7XG59XG5cbi8qKlxuICogV2hldGhlciBgZGlyYCBzaXRzIGluc2lkZSB0aGUgaG9zdCdzIHNoYXJlZCB0ZW1wb3Jhcnkgcm9vdCAoSXNzdWUgIzEyMTUpLlxuICpcbiAqIEEgY2FjaGUgdG9sZCB0byB1c2UgYW4gZXhwbGljaXQgZGlyZWN0b3J5IGNhbm5vdCBhc3N1bWUgdGhhdCBkaXJlY3RvcnkgaXNcbiAqIHByaXZhdGU6IGBjb2RlYmFzZV9tYXBfY2FjaGUudHNgIHBhc3NlZCBhIGZpeGVkIGAvdG1wYCBsaXRlcmFsLCB3aGljaCBpc1xuICogZXZlcnkgYml0IGFzIHdvcmxkLXdyaXRhYmxlIGFzIHRoZSBkZWZhdWx0IHdhcy4gQ2FsbGVycyB1c2UgdGhpcyB0byBkZWNpZGVcbiAqIHdoZXRoZXIgdGhlIG93bmVyc2hpcCBjaGVjayBhcHBsaWVzLCBzbyB0aGUgY29udHJvbCBmb2xsb3dzIHRoZSAqbG9jYXRpb24qXG4gKiByYXRoZXIgdGhhbiB0aGUgYXJndW1lbnQuXG4gKlxuICogQHBhcmFtIGRpciAtIERpcmVjdG9yeSB0byBjbGFzc2lmeS5cbiAqIEBwYXJhbSBsb29rdXAgLSBFbnZpcm9ubWVudCByZWFkZXIsIGluamVjdGFibGUgZm9yIHRlc3RzLlxuICogQHJldHVybnMgVHJ1ZSB3aGVuIGBkaXJgIGlzIGF0IG9yIGJlbG93IGBUTVBESVJgL2BURU1QYC9gVE1QYC9gL3RtcGAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1NoYXJlZFRtcFBhdGgoXG4gIGRpcjogc3RyaW5nLFxuICBsb29rdXA6IChrZXk6IHN0cmluZykgPT4gc3RyaW5nIHwgdW5kZWZpbmVkID0gZGVmYXVsdExvb2t1cCxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBub3JtYWxpc2VkID0gZGlyLnJlcGxhY2UoL1xcLyskLywgXCJcIikgfHwgXCIvXCI7XG4gIGNvbnN0IHJvb3RzID0gbmV3IFNldChbc2hhcmVkVG1wUm9vdChsb29rdXApLCBcIi90bXBcIl0pO1xuICBmb3IgKGNvbnN0IHJvb3Qgb2Ygcm9vdHMpIHtcbiAgICBpZiAobm9ybWFsaXNlZCA9PT0gcm9vdCB8fCBub3JtYWxpc2VkLnN0YXJ0c1dpdGgoYCR7cm9vdH0vYCkpIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuLyoqIENyZWF0ZSBgZGlyYCAoYW5kIGFueSBwYXJlbnRzKSB3aXRoIG93bmVyLW9ubHkgcGVybWlzc2lvbnMuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlUHJpdmF0ZURpcihkaXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBEZW5vLm1rZGlyKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIG1vZGU6IFBSSVZBVEVfRElSX01PREUgfSk7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgd29ya2VyIHN0YXRlIGRpcmVjdG9yeSBhbmQgcmVwb3J0IHdoZXRoZXIgaXQgbWF5IGJlIHRydXN0ZWRcbiAqIChJc3N1ZSAjMTI0MikuXG4gKlxuICogVGhlIGNvbnRyb2wgZm9sbG93cyB0aGUgZGlyZWN0b3J5J3MgKipsb2NhdGlvbioqLCBleGFjdGx5IGFzIGBJc3N1ZUNhY2hlYFxuICogZGVjaWRlczogYSBkaXJlY3RvcnkgYXQgb3IgYmVsb3cgdGhlIHNoYXJlZCB0ZW1wb3Jhcnkgcm9vdCBpcyBjcmVhdGVkXG4gKiBgMDcwMGAgYW5kIG93bmVyc2hpcC1jaGVja2VkLCBiZWNhdXNlIGFueSBsb2NhbCBhY2NvdW50IGNvdWxkIGhhdmUgY3JlYXRlZFxuICogaXQgZmlyc3Q7IGEgZGlyZWN0b3J5IG9uIHRoZSB3b3JrIHZvbHVtZSDigJQgd2hvc2UgcGVybWlzc2lvbnMgdGhlIHdvcmtlclxuICogZG9lcyBub3Qgb3duIOKAlCBpcyBjcmVhdGVkIGFzIGdpdmVuIGFuZCB0cnVzdGVkLlxuICpcbiAqIENhbGxlcnMgbXVzdCBhY3Qgb24gYW4gdW50cnVzdGVkIHZlcmRpY3QgKHNraXAgdGhlIGNhY2hlLCByZWZ1c2UgdGhlXG4gKiB3cml0ZSwgd2FybiBsb3VkbHkpLiBSZXR1cm5pbmcgdGhlIHZlcmRpY3QgcmF0aGVyIHRoYW4gdGhyb3dpbmcgbGV0cyBlYWNoXG4gKiBjYWxsZXIgY2hvb3NlLCBidXQgbmV2ZXIgbGV0cyBvbmUgaWdub3JlIHRoZSBhbnN3ZXIgYnkgYWNjaWRlbnQuXG4gKlxuICogQHBhcmFtIGRpciAtIERpcmVjdG9yeSB0byBjcmVhdGUuXG4gKiBAcGFyYW0gbG9va3VwIC0gRW52aXJvbm1lbnQgcmVhZGVyLCBpbmplY3RhYmxlIGZvciB0ZXN0cy5cbiAqIEByZXR1cm5zIFdoZXRoZXIgdGhlIGNyZWF0ZWQgZGlyZWN0b3J5IGlzIHNhZmUgZm9yIHRoaXMgd29ya2VyIHRvIHVzZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuc3VyZVN0YXRlRGlyKFxuICBkaXI6IHN0cmluZyxcbiAgbG9va3VwOiAoa2V5OiBzdHJpbmcpID0+IHN0cmluZyB8IHVuZGVmaW5lZCA9IGRlZmF1bHRMb29rdXAsXG4pOiBQcm9taXNlPFByaXZhdGVEaXJUcnVzdD4ge1xuICBpZiAoIWlzU2hhcmVkVG1wUGF0aChkaXIsIGxvb2t1cCkpIHtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgcmV0dXJuIHsgdHJ1c3RlZDogdHJ1ZSB9O1xuICB9XG4gIHJldHVybiBhd2FpdCBoYXJkZW5TdGF0ZURpcihkaXIsIHsgY3JlYXRlOiB0cnVlIH0pO1xufVxuXG4vKipcbiAqIEhhcmRlbiBgZGlyYCB3aGVyZXZlciBpdCBsaXZlcywgYW5kIHJlcG9ydCB3aGV0aGVyIGl0IG1heSBiZSB0cnVzdGVkXG4gKiAoSXNzdWUgIzEyNjEpLlxuICpcbiAqIHtAbGluayBlbnN1cmVTdGF0ZURpcn0gdHJ1c3RzIGEgd29yay12b2x1bWUgZGlyZWN0b3J5IG9uIHNpZ2h0LCB3aGljaCBpc1xuICogcmlnaHQgZm9yIHN0YXRlIHRoZSB3b3JrZXIgb25seSB3cml0ZXMuIEEgY2FjaGUgd2hvc2UgZW50cmllcyBhcmUgcmVhZFxuICogYmFjayBpbnRvIGEgcHJvbXB0IOKAlCBvciwgZm9yIHRoZSBiYXNlbGluZSBxdWFsaXR5IGNhY2hlLCByZWFkIGJhY2sgYXNcbiAqIFwidGhlIGdhdGUgYWxyZWFkeSBwYXNzZWRcIiDigJQgbmVlZHMgdGhlIG93bmVyc2hpcCBjaGVjayB3aGVyZXZlciB0aGVcbiAqIGRpcmVjdG9yeSBzaXRzOiB0aGUgd29yayB2b2x1bWUgaXMgbm90IGF1dG9tYXRpY2FsbHkgcHJpdmF0ZSBlaXRoZXIsIGFuZFxuICogYSBwbGFudGVkIGBwYXNzZWQ6IHRydWVgIGVudHJ5IHdvdWxkIHNraXAgYSB3aG9sZSBxdWFsaXR5IGdhdGUuXG4gKlxuICogQSBwcmUtZXhpc3RpbmcgZGlyZWN0b3J5IGF0IHRoZSB1bWFzayBkZWZhdWx0IGlzIG5hcnJvd2VkIHRvIGAwNzAwYCBieVxuICoge0BsaW5rIHRpZ2h0ZW5Pd25EaXJ9IHJhdGhlciB0aGFuIHJlZnVzZWQsIHNvIGEgY2FjaGUgZGlyZWN0b3J5IGFuIGVhcmxpZXJcbiAqIHJlbGVhc2UgY3JlYXRlZCBgMDc1NWAga2VlcHMgd29ya2luZy4gQSBncm91cC9vdGhlciAqKndyaXRhYmxlKiogZGlyZWN0b3J5LFxuICogb3Igb25lIG93bmVkIGJ5IGFub3RoZXIgdWlkLCBpcyByZWZ1c2VkIOKAlCB0aGUgY2FsbGVyIG11c3Qgc2tpcCB0aGUgY2FjaGUuXG4gKlxuICogQHBhcmFtIGRpciAtIERpcmVjdG9yeSB0byBoYXJkZW4uXG4gKiBAcGFyYW0gb3B0aW9ucy5jcmVhdGUgLSBDcmVhdGUgdGhlIGRpcmVjdG9yeSBgMDcwMGAgd2hlbiBhYnNlbnQuIExlYXZlIGl0XG4gKiAgIG9mZiBvbiBhIHJlYWQgcGF0aCBzbyBhIG1pc3MgbmV2ZXIgY3JlYXRlcyBhbnl0aGluZy5cbiAqIEByZXR1cm5zIFdoZXRoZXIgdGhlIGRpcmVjdG9yeSBpcyBzYWZlIGZvciB0aGlzIHdvcmtlciB0byB1c2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYXJkZW5TdGF0ZURpcihcbiAgZGlyOiBzdHJpbmcsXG4gIG9wdGlvbnM6IHsgY3JlYXRlPzogYm9vbGVhbiB9ID0ge30sXG4pOiBQcm9taXNlPFByaXZhdGVEaXJUcnVzdD4ge1xuICBpZiAob3B0aW9ucy5jcmVhdGUpIHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZW5zdXJlUHJpdmF0ZURpcihkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gQ3JlYXRpb24gZmFpbHVyZSBpcyByZXBvcnRlZCBieSB0aGUgdmVyaWZpY2F0aW9uIGJlbG93LlxuICAgIH1cbiAgfVxuICBjb25zdCB0cnVzdCA9IGF3YWl0IHZlcmlmeVByaXZhdGVEaXIoZGlyKTtcbiAgaWYgKHRydXN0LnRydXN0ZWQpIHJldHVybiB0cnVzdDtcbiAgcmV0dXJuIGF3YWl0IHRpZ2h0ZW5Pd25EaXIoZGlyKTtcbn1cblxuLyoqXG4gKiBUaWdodGVuIGEgZGlyZWN0b3J5IG9ubHkgdGhpcyBhY2NvdW50IGNvdWxkIGhhdmUgd3JpdHRlbiB0bywgdGhlbiByZS12ZXJpZnkuXG4gKlxuICogQSBwcmUtZXhpc3RpbmcgZGlyZWN0b3J5IGF0IHRoZSB1bWFzayBkZWZhdWx0IChgMDc1NWApIGlzIG91cnMgYW5kIG5vIG90aGVyXG4gKiBhY2NvdW50IGNhbiBoYXZlIHBsYW50ZWQgYW55dGhpbmcgaW4gaXQsIHNvIG5hcnJvd2luZyBpdCB0byBgMDcwMGAgaXMgc2FmZVxuICog4oCUIGFuZCBpcyB3aGF0IGtlZXBzIGEgd29yayBkaXJlY3RvcnkgdGhhdCBoYXBwZW5zIHRvIHNpdCB1bmRlciB0aGVcbiAqIHRlbXBvcmFyeSByb290IHVzYWJsZS4gQSBncm91cC9vdGhlciAqKndyaXRhYmxlKiogZGlyZWN0b3J5IGlzIGEgZGlmZmVyZW50XG4gKiB0aGluZyBlbnRpcmVseTogYW55b25lIGNvdWxkIGFscmVhZHkgaGF2ZSBkcm9wcGVkIGEgZmlsZSBpbiBpdCwgc28gaXQgaXNcbiAqIHJlZnVzZWQgcmF0aGVyIHRoYW4gaGVhbGVkLCBhbmQgc28gaXMgYSBkaXJlY3Rvcnkgb3duZWQgYnkgYW5vdGhlciB1aWQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHRpZ2h0ZW5Pd25EaXIoZGlyOiBzdHJpbmcpOiBQcm9taXNlPFByaXZhdGVEaXJUcnVzdD4ge1xuICBsZXQgaW5mbzogRGVuby5GaWxlSW5mbztcbiAgdHJ5IHtcbiAgICBpbmZvID0gYXdhaXQgRGVuby5zdGF0KGRpcik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICB0cnVzdGVkOiBmYWxzZSxcbiAgICAgIHJlYXNvbjogYGNhbm5vdCBzdGF0IGRpcmVjdG9yeTogJHtcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3Qgb3duVWlkID0gcmVzb2x2ZU93blVpZCgpO1xuICBjb25zdCBvd25lZEJ5VXMgPSBvd25VaWQgPT09IG51bGwgfHwgaW5mby51aWQgPT09IG51bGwgfHxcbiAgICBpbmZvLnVpZCA9PT0gb3duVWlkO1xuICBjb25zdCB3cml0YWJsZUJ5T3RoZXJzID0gaW5mby5tb2RlICE9PSBudWxsICYmIChpbmZvLm1vZGUgJiAwbzAyMikgIT09IDA7XG4gIGlmICghaW5mby5pc0RpcmVjdG9yeSB8fCAhb3duZWRCeVVzIHx8IHdyaXRhYmxlQnlPdGhlcnMpIHtcbiAgICByZXR1cm4gYXdhaXQgdmVyaWZ5UHJpdmF0ZURpcihkaXIpO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLmNobW9kKGRpciwgUFJJVkFURV9ESVJfTU9ERSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIFJlcG9ydGVkIGJ5IHRoZSB2ZXJpZmljYXRpb24gYmVsb3cuXG4gIH1cbiAgcmV0dXJuIGF3YWl0IHZlcmlmeVByaXZhdGVEaXIoZGlyKTtcbn1cblxuLyoqXG4gKiBWZXJpZnkgYGRpcmAgaXMgYSB3b3JrZXItcHJpdmF0ZSBkaXJlY3Rvcnkg4oCUIGEgcmVhbCBkaXJlY3RvcnksIG93bmVkIGJ5IHRoaXNcbiAqIGFjY291bnQsIHdpdGggbm8gZ3JvdXAgb3Igb3RoZXIgYWNjZXNzIGJpdHMuXG4gKlxuICogUGxhdGZvcm1zIHRoYXQgZG8gbm90IHJlcG9ydCBgbW9kZWAvYHVpZGAgKFdpbmRvd3MpIHNraXAgdGhlIGNvcnJlc3BvbmRpbmdcbiAqIGNoZWNrIHJhdGhlciB0aGFuIGZhaWxpbmcgZXZlcnkgcmVhZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHZlcmlmeVByaXZhdGVEaXIoXG4gIGRpcjogc3RyaW5nLFxuKTogUHJvbWlzZTxQcml2YXRlRGlyVHJ1c3Q+IHtcbiAgbGV0IGluZm86IERlbm8uRmlsZUluZm87XG4gIHRyeSB7XG4gICAgaW5mbyA9IGF3YWl0IERlbm8uc3RhdChkaXIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgdHJ1c3RlZDogZmFsc2UsXG4gICAgICByZWFzb246IGBjYW5ub3Qgc3RhdCBkaXJlY3Rvcnk6ICR7XG4gICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxuXG4gIGlmICghaW5mby5pc0RpcmVjdG9yeSkgcmV0dXJuIHsgdHJ1c3RlZDogZmFsc2UsIHJlYXNvbjogXCJub3QgYSBkaXJlY3RvcnlcIiB9O1xuXG4gIGlmIChpbmZvLm1vZGUgIT09IG51bGwgJiYgKGluZm8ubW9kZSAmIDBvMDc3KSAhPT0gMCkge1xuICAgIGNvbnN0IG9jdGFsID0gKGluZm8ubW9kZSAmIDBvNzc3NykudG9TdHJpbmcoOCkucGFkU3RhcnQoNCwgXCIwXCIpO1xuICAgIHJldHVybiB7XG4gICAgICB0cnVzdGVkOiBmYWxzZSxcbiAgICAgIHJlYXNvbjogYGdyb3VwL290aGVyIGFjY2Vzc2libGUgKG1vZGUgJHtvY3RhbH0sIGV4cGVjdGVkIDA3MDApYCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3Qgb3duVWlkID0gcmVzb2x2ZU93blVpZCgpO1xuICBpZiAob3duVWlkICE9PSBudWxsICYmIGluZm8udWlkICE9PSBudWxsICYmIGluZm8udWlkICE9PSBvd25VaWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgdHJ1c3RlZDogZmFsc2UsXG4gICAgICByZWFzb246IGBvd25lZCBieSB1aWQgJHtpbmZvLnVpZH0sIGV4cGVjdGVkIHVpZCAke293blVpZH1gLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyB0cnVzdGVkOiB0cnVlIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXdCQyxHQUVELHdFQUF3RSxHQUN4RSxPQUFPLE1BQU0sbUJBQW1CLE1BQU07QUFVdEMsNEVBQTRFLEdBQzVFLFNBQVMsVUFBVSxJQUFZO0VBQzdCLElBQUk7SUFDRixPQUFPLEtBQUssR0FBRyxDQUFDLEdBQUcsQ0FBQyxTQUFTO0VBQy9CLEVBQUUsT0FBTTtJQUNOLE9BQU87RUFDVDtBQUNGO0FBRUE7OztDQUdDLEdBQ0QsT0FBTyxTQUFTO0VBQ2QsTUFBTSxPQUFPLFVBQVU7RUFDdkIsSUFBSSxDQUFDLE1BQU0sT0FBTztFQUNsQixJQUFJO0lBQ0YsT0FBTyxLQUFLLFFBQVEsQ0FBQyxNQUFNLEdBQUc7RUFDaEMsRUFBRSxPQUFNO0lBQ04sT0FBTztFQUNUO0FBQ0Y7QUFFQTs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FBUztFQUNkLE1BQU0sTUFBTTtFQUNaLElBQUksUUFBUSxNQUFNLE9BQU8sQ0FBQyxHQUFHLEVBQUUsS0FBSztFQUNwQyxNQUFNLFFBQVEsVUFBVSxXQUFXLFVBQVU7RUFDN0MsTUFBTSxPQUFPLENBQUMsU0FBUyxFQUFFLEVBQUUsT0FBTyxDQUFDLG9CQUFvQjtFQUN2RCxPQUFPLFFBQVE7QUFDakI7QUFFQTs7Ozs7Ozs7Ozs7OztDQWFDLEdBQ0QsT0FBTyxTQUFTLGtCQUNkLElBQVksRUFDWixTQUE4QyxhQUFhO0VBRTNELE9BQU8sR0FBRyxjQUFjLFFBQVEsQ0FBQyxFQUFFLEtBQUssQ0FBQyxFQUFFLHNCQUFzQjtBQUNuRTtBQUVBLHlEQUF5RCxHQUN6RCxTQUFTLGNBQWMsR0FBVztFQUNoQyxPQUFPLFVBQVUsUUFBUTtBQUMzQjtBQUVBLHlFQUF5RSxHQUN6RSxTQUFTLGNBQ1AsU0FBOEMsYUFBYTtFQUUzRCxNQUFNLGFBQWEsT0FBTyxhQUFhLE9BQU8sV0FBVyxPQUFPO0VBQ2hFLE9BQU8sQ0FBQyxjQUFjLE1BQU0sRUFBRSxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQ3ZEO0FBRUE7Ozs7Ozs7Ozs7OztDQVlDLEdBQ0QsT0FBTyxTQUFTLGdCQUNkLEdBQVcsRUFDWCxTQUE4QyxhQUFhO0VBRTNELE1BQU0sYUFBYSxJQUFJLE9BQU8sQ0FBQyxRQUFRLE9BQU87RUFDOUMsTUFBTSxRQUFRLElBQUksSUFBSTtJQUFDLGNBQWM7SUFBUztHQUFPO0VBQ3JELEtBQUssTUFBTSxRQUFRLE1BQU87SUFDeEIsSUFBSSxlQUFlLFFBQVEsV0FBVyxVQUFVLENBQUMsR0FBRyxLQUFLLENBQUMsQ0FBQyxHQUFHLE9BQU87RUFDdkU7RUFDQSxPQUFPO0FBQ1Q7QUFFQSxnRUFBZ0UsR0FDaEUsT0FBTyxlQUFlLGlCQUFpQixHQUFXO0VBQ2hELE1BQU0sS0FBSyxLQUFLLENBQUMsS0FBSztJQUFFLFdBQVc7SUFBTSxNQUFNO0VBQWlCO0FBQ2xFO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBaUJDLEdBQ0QsT0FBTyxlQUFlLGVBQ3BCLEdBQVcsRUFDWCxTQUE4QyxhQUFhO0VBRTNELElBQUksQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTO0lBQ2pDLE1BQU0sS0FBSyxLQUFLLENBQUMsS0FBSztNQUFFLFdBQVc7SUFBSztJQUN4QyxPQUFPO01BQUUsU0FBUztJQUFLO0VBQ3pCO0VBQ0EsT0FBTyxNQUFNLGVBQWUsS0FBSztJQUFFLFFBQVE7RUFBSztBQUNsRDtBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW9CQyxHQUNELE9BQU8sZUFBZSxlQUNwQixHQUFXLEVBQ1gsVUFBZ0MsQ0FBQyxDQUFDO0VBRWxDLElBQUksUUFBUSxNQUFNLEVBQUU7SUFDbEIsSUFBSTtNQUNGLE1BQU0saUJBQWlCO0lBQ3pCLEVBQUUsT0FBTTtJQUNOLDBEQUEwRDtJQUM1RDtFQUNGO0VBQ0EsTUFBTSxRQUFRLE1BQU0saUJBQWlCO0VBQ3JDLElBQUksTUFBTSxPQUFPLEVBQUUsT0FBTztFQUMxQixPQUFPLE1BQU0sY0FBYztBQUM3QjtBQUVBOzs7Ozs7Ozs7Q0FTQyxHQUNELGVBQWUsY0FBYyxHQUFXO0VBQ3RDLElBQUk7RUFDSixJQUFJO0lBQ0YsT0FBTyxNQUFNLEtBQUssSUFBSSxDQUFDO0VBQ3pCLEVBQUUsT0FBTyxLQUFLO0lBQ1osT0FBTztNQUNMLFNBQVM7TUFDVCxRQUFRLENBQUMsdUJBQXVCLEVBQzlCLGVBQWUsUUFBUSxJQUFJLE9BQU8sR0FBRyxPQUFPLE1BQzVDO0lBQ0o7RUFDRjtFQUVBLE1BQU0sU0FBUztFQUNmLE1BQU0sWUFBWSxXQUFXLFFBQVEsS0FBSyxHQUFHLEtBQUssUUFDaEQsS0FBSyxHQUFHLEtBQUs7RUFDZixNQUFNLG1CQUFtQixLQUFLLElBQUksS0FBSyxRQUFRLENBQUMsS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFNO0VBQ3ZFLElBQUksQ0FBQyxLQUFLLFdBQVcsSUFBSSxDQUFDLGFBQWEsa0JBQWtCO0lBQ3ZELE9BQU8sTUFBTSxpQkFBaUI7RUFDaEM7RUFFQSxJQUFJO0lBQ0YsTUFBTSxLQUFLLEtBQUssQ0FBQyxLQUFLO0VBQ3hCLEVBQUUsT0FBTTtFQUNOLHNDQUFzQztFQUN4QztFQUNBLE9BQU8sTUFBTSxpQkFBaUI7QUFDaEM7QUFFQTs7Ozs7O0NBTUMsR0FDRCxPQUFPLGVBQWUsaUJBQ3BCLEdBQVc7RUFFWCxJQUFJO0VBQ0osSUFBSTtJQUNGLE9BQU8sTUFBTSxLQUFLLElBQUksQ0FBQztFQUN6QixFQUFFLE9BQU8sS0FBSztJQUNaLE9BQU87TUFDTCxTQUFTO01BQ1QsUUFBUSxDQUFDLHVCQUF1QixFQUM5QixlQUFlLFFBQVEsSUFBSSxPQUFPLEdBQUcsT0FBTyxNQUM1QztJQUNKO0VBQ0Y7RUFFQSxJQUFJLENBQUMsS0FBSyxXQUFXLEVBQUUsT0FBTztJQUFFLFNBQVM7SUFBTyxRQUFRO0VBQWtCO0VBRTFFLElBQUksS0FBSyxJQUFJLEtBQUssUUFBUSxDQUFDLEtBQUssSUFBSSxHQUFHLEtBQUssTUFBTSxHQUFHO0lBQ25ELE1BQU0sUUFBUSxDQUFDLEtBQUssSUFBSSxHQUFHLE1BQU0sRUFBRSxRQUFRLENBQUMsR0FBRyxRQUFRLENBQUMsR0FBRztJQUMzRCxPQUFPO01BQ0wsU0FBUztNQUNULFFBQVEsQ0FBQyw2QkFBNkIsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0lBQ2pFO0VBQ0Y7RUFFQSxNQUFNLFNBQVM7RUFDZixJQUFJLFdBQVcsUUFBUSxLQUFLLEdBQUcsS0FBSyxRQUFRLEtBQUssR0FBRyxLQUFLLFFBQVE7SUFDL0QsT0FBTztNQUNMLFNBQVM7TUFDVCxRQUFRLENBQUMsYUFBYSxFQUFFLEtBQUssR0FBRyxDQUFDLGVBQWUsRUFBRSxRQUFRO0lBQzVEO0VBQ0Y7RUFFQSxPQUFPO0lBQUUsU0FBUztFQUFLO0FBQ3pCIn0=
// denoCacheMetadata=817410439334154842,13504042409954819550