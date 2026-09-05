/**
 * Cross-process advisory file lock (Issue #491).
 *
 * ## Why this exists
 *
 * `audit_journal.ts` serialised its appends with a `Map` of chained
 * promises and called it a lock. It is not one: it orders callers inside a
 * single Deno process and is invisible to every other process on the host.
 * The audit journal lives on the shared work volume, and `VIBE_RUN_ID` is
 * exported to every child `deno` command (`run_id.ts`), so a child writer
 * appends to the same file under the same run id with a completely
 * independent view of the chain head. On GRQ-23 that orphaned the head
 * hash in 10 of 14 journals: one writer held its cached head across a
 * burst of appends by another and then chained on top of it.
 *
 * Deno exposes no `flock`, so this is the portable primitive: an `O_EXCL`
 * lock file, which is atomic on every filesystem the worker runs on.
 *
 * ## Abandoned locks
 *
 * A process killed while holding the lock would otherwise wedge every
 * later writer for ever. A lock whose recorded pid is no longer in
 * `/proc` is broken **immediately** (Issue #1074): the pid check has no
 * false negatives, and waiting two minutes to act on a holder that is
 * provably dead is what left a killed run's successor blocking until its
 * timeout and then reporting the audit chain broken. A lock file with no
 * record yet is a holder between its `O_EXCL` create and its first write,
 * and is never broken on that basis.
 *
 * Where the pid is *not* conclusive — it is alive, or the record is
 * unreadable — a lock file older than {@link DEFAULT_STALE_MS} is treated
 * as abandoned and broken anyway; holds are milliseconds, so no live
 * holder is ever close to that age.
 *
 * That pid check has one blind spot, and it is not theoretical here: pids
 * are namespaced per container, so a lock left behind by a killed run can
 * name a pid that a *later* container has since reissued to something
 * else. The check would then protect a lock whose holder died days ago and
 * wedge the audit trail for good — a failure that needs a human, which is
 * itself the bug. So {@link HARD_STALE_MULTIPLIER} bounds it: past twenty
 * minutes the lock is broken whatever the pid says, because no append has
 * ever taken twenty minutes.
 *
 * Every break is announced on stderr: silently stealing a lock is how the
 * corruption this module exists to prevent gets reintroduced.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

/** How long to wait for a held lock before giving up. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Age at which a held lock is treated as abandoned.
 *
 * Two orders of magnitude above the longest plausible hold (an append is a
 * read, a hash and two small writes), so a live holder is never broken.
 */
export const DEFAULT_STALE_MS = 120_000;

/**
 * Multiple of the stale age past which the pid check is overruled.
 *
 * The pid can be a false positive (recycled in a later container's pid
 * namespace) but never a false negative, so this only ever breaks locks the
 * age check had already condemned.
 */
export const HARD_STALE_MULTIPLIER = 10;

/** Delay between acquisition attempts. */
export const DEFAULT_POLL_MS = 25;

/** Tuning for {@link withFileLock}; every field has a sane default. */
export interface FileLockOptions {
  /** How long to wait for the holder to release (ms). */
  timeoutMs?: number;
  /** Age at which a held lock counts as abandoned (ms). */
  staleMs?: number;
  /** Delay between attempts (ms). */
  pollMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

/** What one holder writes into its lock file. */
interface LockRecord {
  token: string;
  pid: number;
  acquiredAt: string;
}

/** Raised when the lock could not be taken within the timeout. */
export class FileLockTimeoutError extends Error {
  constructor(path: string, timeoutMs: number, holder: string) {
    super(
      `could not take the lock at ${path} within ${timeoutMs}ms — held by ` +
        holder,
    );
    this.name = "FileLockTimeoutError";
  }
}

/** Sleep for `ms`, with a little jitter so contenders do not lock-step. */
function sleep(ms: number): Promise<void> {
  const jittered = ms + Math.floor(Math.random() * ms);
  return new Promise((resolve) => setTimeout(resolve, jittered));
}

/** Read a lock file's record, or null when it is absent or unreadable. */
async function readRecord(path: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as unknown;
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as LockRecord).token === "string"
    ) {
      return parsed as LockRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Is `pid` still running?
 *
 * `/proc` is the obvious probe and was the only one, which made this
 * function dead code everywhere it mattered (Issue #1074): Deno requires
 * `--allow-all` to read `/proc`, and the worker runs on granular
 * permissions, so the stat threw `NotCapable`, the catch read that as
 * "assume alive", and a lock left by a killed run survived until the
 * twenty-minute hard-stale rule broke it. Every append in that window
 * failed to journal.
 *
 * The signal probe is the one that actually answers under the worker's
 * permissions. `SIGURG`'s default disposition is *ignore*, so it asks the
 * kernel whether the pid exists without disturbing the process if it
 * does.
 *
 * Every inconclusive answer is `true` (assume alive), so a live holder is
 * never broken on the strength of a guess and the decision falls back to
 * the age rules.
 */
async function holderAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Establish that `/proc` is readable here before reading anything
    // into a miss: on macOS it does not exist at all, and treating that
    // as "the holder is gone" would break live locks.
    await Deno.stat("/proc/self");
    try {
      await Deno.stat(`/proc/${pid}`);
      return true;
    } catch (error: unknown) {
      if (error instanceof Deno.errors.NotFound) return false;
    }
  } catch {
    // `/proc` is absent or not permitted — fall through to the signal.
  }
  try {
    Deno.kill(pid, "SIGURG");
    return true;
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return false;
    // Alive but not ours to signal, or no run permission at all.
    return true;
  }
}

/**
 * Break a lock whose holder is gone, announcing it.
 *
 * @returns true when the lock file was removed by this call
 */
async function breakIfAbandoned(
  path: string,
  staleMs: number,
  now: () => number,
): Promise<boolean> {
  let ageMs: number;
  try {
    const stat = await Deno.stat(path);
    ageMs = now() - (stat.mtime?.getTime() ?? now());
  } catch {
    // Gone between the failed create and the stat: the next attempt wins.
    return true;
  }
  if (ageMs < staleMs) {
    // Issue #1074: a holder that is *provably* gone need not be waited
    // out. A run killed mid-append leaves its lock behind, and the next
    // run — housekeeping's audit sweep first of all — arrives well inside
    // the two-minute window, so it used to block for the full timeout and
    // then report the audit chain broken. Waiting out a dead holder buys
    // nothing: the pid check has no false negatives, only false positives
    // (a recycled pid), which is what the age and hard-stale rules below
    // remain for.
    const holder = await readRecord(path);
    // No record yet means the holder is between `O_EXCL` create and its
    // first write. That is a live lock a millisecond old, not an
    // abandoned one.
    if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) {
      return false;
    }
    if (await holderAlive(holder.pid)) return false;
    await breakLock(path, ageMs, `pid ${holder.pid} is no longer running`);
    return true;
  }

  const record = await readRecord(path);
  const beyondDoubt = ageMs >= staleMs * HARD_STALE_MULTIPLIER;
  if (!beyondDoubt && record && await holderAlive(record.pid)) return false;

  const why = beyondDoubt
    ? `no append takes that long, whatever pid ${record?.pid ?? "unknown"} ` +
      `is now`
    : `pid ${record?.pid ?? "unknown"} is no longer running`;
  await breakLock(path, ageMs, why);
  return true;
}

/** Remove an abandoned lock, announcing it: a silent steal is the bug. */
async function breakLock(
  path: string,
  ageMs: number,
  why: string,
): Promise<void> {
  console.error(
    `[SECURITY] [AUDIT_LOCK_BROKEN] ${path}: held for ${
      Math.round(ageMs / 1000)
    }s — ${why}; breaking the abandoned lock`,
  );
  try {
    await Deno.remove(path);
  } catch {
    // Another contender broke it first; either way it is no longer ours
    // to worry about.
  }
}

/**
 * Run `fn` while holding an exclusive cross-process lock at `lockPath`.
 *
 * The lock is released whether `fn` resolves or throws. A lock this call
 * did not take (because an abandoned-lock break handed it to someone else)
 * is never released by this call.
 *
 * @param lockPath - Lock file to create; its directory must already exist
 * @param fn - Work to run under the lock
 * @param options - Timeout, staleness and poll tuning
 * @returns Whatever `fn` returns
 * @throws {FileLockTimeoutError} When the lock is still held at timeout
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? (() => Date.now());

  const token = crypto.randomUUID();
  const record: LockRecord = {
    token,
    pid: Deno.pid,
    acquiredAt: new Date(now()).toISOString(),
  };
  const payload = new TextEncoder().encode(JSON.stringify(record));

  const deadline = now() + timeoutMs;
  let held = false;
  for (;;) {
    try {
      const file = await Deno.open(lockPath, {
        createNew: true,
        write: true,
      });
      try {
        await file.write(payload);
      } finally {
        file.close();
      }
      held = true;
      break;
    } catch (error: unknown) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }

    if (await breakIfAbandoned(lockPath, staleMs, now)) continue;

    if (now() >= deadline) {
      const holder = await readRecord(lockPath);
      throw new FileLockTimeoutError(
        lockPath,
        timeoutMs,
        holder
          ? `pid ${holder.pid} since ${holder.acquiredAt}`
          : "an unknown process",
      );
    }
    await sleep(pollMs);
  }

  try {
    return await fn();
  } finally {
    if (held) {
      // Only release a lock we still hold: if ours was broken as abandoned
      // and retaken, removing it would evict its new owner.
      const current = await readRecord(lockPath);
      if (current === null || current.token === token) {
        try {
          await Deno.remove(lockPath);
        } catch {
          // Already gone. Nothing to release.
        }
      }
    }
  }
}
