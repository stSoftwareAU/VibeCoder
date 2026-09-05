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
 * later writer for ever, and a run killed mid-append is the ordinary case
 * this whole subsystem exists for (Issue #1074) — so the abandoned lock
 * and the damaged chain arrive together, and the next run has to clear
 * both.
 *
 * A lock is broken **immediately** only when its holder is *provably*
 * gone, which needs two things to be true at once. The record must name
 * the same {@link ownerHost} this process runs under — pids are namespaced
 * per container, so a pid written inside another container is not a pid
 * this one can ask about, and asking anyway is how a *live* holder's lock
 * gets stolen and two writers land in one journal. And `ps -p` must
 * conclusively report the pid gone; the probe is run at most once per
 * contended acquisition, and anything short of a conclusive answer counts
 * as alive.
 *
 * A lock file that records **no holder** is never broken early. An earlier
 * revision of this module broke one on its second sighting, reasoning that
 * the op creating and filling it was too narrow to survive two polls. That
 * was wrong, and wrong in the direction this whole subsystem exists to
 * prevent: creation was `open(O_CREAT|O_EXCL)` followed by a separate
 * `write`, so a holder descheduled between the two is observably ownerless
 * for as long as it is off the CPU. Measured straight, the file was
 * present-but-empty in 265 of 961 sightings; under CPU contention two
 * polls a millisecond apart both landed inside the window, and the lock of
 * a perfectly live holder was broken — two writers in one journal, which
 * is the torn line of Issue #1074 rather than a fix for it.
 *
 * {@link createLockAtomically} closes the window instead of guessing about
 * it: the record is written to a temp file first and `link(2)`ed into
 * place, so the lock file carries its holder from the instant it exists.
 * An ownerless lock is therefore unreachable in new writes, and a legacy
 * or genuinely abandoned one is left to the age rules below — slower than
 * an immediate break, and sound.
 *
 * Otherwise the age rules decide: a lock older than
 * {@link DEFAULT_STALE_MS} is broken unless the holder is *conclusively*
 * alive. That asymmetry is deliberate and is the second half of Issue
 * #1074. The liveness probe used to stat `/proc`, which Deno refuses
 * without `--allow-all`; the worker runs on granular permissions, so the
 * stat threw, the catch read that as "assume alive", and every abandoned
 * lock survived to {@link HARD_STALE_MULTIPLIER} — twenty minutes of
 * unrecorded mutations after every kill. An inconclusive probe must not
 * protect a lock the age rule has already condemned.
 *
 * {@link HARD_STALE_MULTIPLIER} remains the backstop for a pid that is
 * alive but is not the holder — reissued to something else inside the same
 * container. Past twenty minutes the lock is broken whatever the probe
 * says, because no append has ever taken twenty minutes.
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
  /**
   * Which host — in a container, which container — the pid belongs to.
   *
   * Pids are namespaced, so a pid is only meaningful to a reader in the
   * same namespace. Recording the owner is what lets a reader tell "this
   * pid is gone" from "this pid was never mine to ask about" (Issue
   * #1074). Absent on locks written before that, which simply never take
   * the immediate-break path.
   */
  host?: string;
}

/**
 * Identity of the pid namespace this process writes locks under.
 *
 * The hostname is the container id inside a container and the machine
 * name outside one; either way, two processes reporting the same value
 * share a pid namespace, and two reporting different values do not.
 *
 * Reading it needs `--allow-sys=hostname`. Without that permission — or
 * on a host where it cannot be read — the answer is the empty string,
 * which never matches a recorded owner, so the immediate break simply
 * does not apply and the age rules decide. `HOSTNAME` is deliberately not
 * used: it is a shell variable that is usually not exported, so it reads
 * as empty from a spawned process and would quietly disable this.
 */
function ownerHost(): string {
  try {
    return Deno.hostname();
  } catch {
    return "";
  }
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
 * Has `pid` conclusively gone?
 *
 * `ps -p` is the probe rather than `/proc`, which Deno refuses to read
 * without `--allow-all` (Issue #1074), and rather than a signal, because
 * this repository does not signal a pid it cannot prove is still its own.
 *
 * @param pid - Pid recorded by the lock holder
 * @returns `true` when `ps` reports no such process, `false` when it
 *   reports one, and `null` when the question could not be asked at all —
 *   no `ps`, or no run permission. Callers treat `null` as "not proven
 *   gone", never as gone.
 */
async function holderGone(pid: number): Promise<boolean | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const probe = await new Deno.Command("ps", {
      args: ["-p", String(pid)],
      stdout: "null",
      stderr: "null",
    }).output();
    // `ps -p` exits non-zero precisely when no such process exists.
    return !probe.success;
  } catch {
    return null;
  }
}

/**
 * How long a break decision may hold the break lock before it is ignored.
 *
 * Only a `ps` spawn happens under it, so this is orders of magnitude above
 * the real hold; it exists solely so a breaker killed mid-decision cannot
 * stop anyone else ever breaking a lock again.
 */
const BREAK_LOCK_TTL_MS = 5_000;

/**
 * Break a lock whose holder is gone, announcing it.
 *
 * Serialised across processes by a second, short-lived lock. Deciding
 * takes real time — the liveness probe spawns `ps` — and the filesystem
 * offers no "remove this file only if it still contains X", so without
 * this two contenders can both condemn the same dead holder, and the
 * second removes the *winner's* fresh lock and enters behind it. That is
 * two writers in one journal (Issue #1074): the corruption this module
 * exists to prevent, arriving through the machinery meant to recover from
 * it. Holding the break lock across the whole read-decide-remove sequence
 * is what makes "at most one contender may break a given lock" true.
 *
 * @returns true when the lock file was removed by this call
 */
async function breakIfAbandoned(
  path: string,
  staleMs: number,
  now: () => number,
  probe: { probed: boolean },
): Promise<boolean> {
  const breakPath = `${path}.break`;
  try {
    await createLockAtomically(
      breakPath,
      new TextEncoder().encode(JSON.stringify({
        token: crypto.randomUUID(),
        pid: Deno.pid,
        acquiredAt: new Date(now()).toISOString(),
        host: ownerHost(),
      })),
    );
  } catch (error: unknown) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    // Someone else is deciding. Let them, and come back on the next poll —
    // unless their decision has plainly outlived any real one, which means
    // the breaker was itself killed part-way through.
    try {
      const held = await Deno.stat(breakPath);
      if (now() - (held.mtime?.getTime() ?? now()) > BREAK_LOCK_TTL_MS) {
        await Deno.remove(breakPath);
      }
    } catch {
      // Released while we looked; the next poll will find it free.
    }
    return false;
  }
  try {
    const broke = await decideAndBreak(path, staleMs, now, probe);
    if (broke) await sweepStaleTemps(path, staleMs, now);
    return broke;
  } finally {
    try {
      await Deno.remove(breakPath);
    } catch {
      // Only cleared by its holder or by the TTL above; either way, gone.
    }
  }
}

/** The break decision itself, run under the break lock. */
async function decideAndBreak(
  path: string,
  staleMs: number,
  now: () => number,
  probe: { probed: boolean },
): Promise<boolean> {
  let ageMs: number;
  try {
    const stat = await Deno.stat(path);
    ageMs = now() - (stat.mtime?.getTime() ?? now());
  } catch {
    // Gone between the failed create and the stat: the next attempt wins.
    return true;
  }
  const record = await readRecord(path);

  if (ageMs < staleMs) {
    // Issue #1074: a holder this process can prove is gone need not be
    // waited out — a run killed mid-append leaves its lock behind, and the
    // next run's audit sweep arrives well inside the stale window.
    //
    // "Prove" is the whole of it, and a lock naming nobody proves nothing:
    // it is what a live holder looks like mid-create on any build that
    // still fills the file after creating it, and what a legacy or
    // truncated record looks like afterwards. Neither is grounds for a
    // break, so it waits for the age rules.
    if (!record) return false;
    // Otherwise the recorded pid has to be one this process can ask
    // about. A record from another pid namespace names a pid that is not
    // ours to look up, and a `ps` miss there would be a *live* holder's
    // lock stolen. The probe runs at most once per acquisition: a holder
    // that was alive a poll ago does not need re-asking, and spawning
    // `ps` on every poll would cost more than the wait.
    if (!record.host || record.host !== ownerHost()) return false;
    if (probe.probed) return false;
    probe.probed = true;
    if (await holderGone(record.pid) !== true) return false;
    await breakLock(
      path,
      ageMs,
      `pid ${record.pid} is no longer running`,
      record,
    );
    return true;
  }

  const beyondDoubt = ageMs >= staleMs * HARD_STALE_MULTIPLIER;
  // Past the stale age, only a *conclusive* liveness answer protects the
  // lock. An inconclusive probe used to read as "alive" and hold the
  // audit trail for the full hard-stale window (Issue #1074).
  if (!beyondDoubt && record && await holderGone(record.pid) === false) {
    return false;
  }

  const why = beyondDoubt
    ? `no append takes that long, whatever pid ${record?.pid ?? "unknown"} ` +
      `is now`
    : `pid ${record?.pid ?? "unknown"} is not running, or cannot be asked ` +
      `about from here`;
  await breakLock(path, ageMs, why, record);
  return true;
}

/** Remove an abandoned lock, announcing it: a silent steal is the bug. */
async function breakLock(
  path: string,
  ageMs: number,
  why: string,
  condemned: LockRecord | null,
): Promise<void> {
  // Break the lock that was actually judged, not whatever holds the path
  // now. Deciding takes time — the liveness probe spawns `ps` — and two
  // contenders can condemn the same dead holder concurrently: without
  // this, the first breaks it and takes the lock, and the second then
  // removes the *winner's* fresh lock and takes it too, which is two live
  // writers in one journal (Issue #1074). Re-reading immediately before
  // the remove narrows that to the gap between two adjacent syscalls; it
  // does not make the check atomic, so this stays a last line of defence
  // behind the age and liveness rules rather than a substitute for them.
  const current = await readRecord(path);
  if (condemned && current && current.token !== condemned.token) return;

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
 * Create `lockPath` already carrying `payload`, or fail because it exists.
 *
 * `Deno.writeFile(…, { createNew: true })` cannot do this: it creates the
 * file and writes the record in separate syscalls, leaving a window in
 * which the lock exists but names nobody (Issue #1074). `link(2)` has no
 * such window — it publishes a name for a file that is already complete,
 * and fails with `EEXIST` atomically when the name is taken — so the two
 * properties this lock needs, exclusion and a legible holder, arrive
 * together.
 *
 * The temp file is a sibling because a hard link cannot cross filesystems.
 * A process killed between the write and the unlink leaves one behind;
 * {@link sweepStaleTemps} clears those, since a kill is the ordinary case
 * here and an audit directory that fills with debris is its own problem.
 *
 * @param lockPath - Lock file to publish; its directory must already exist
 * @param payload - Encoded {@link LockRecord} to publish with it
 * @throws {Deno.errors.AlreadyExists} When the lock is held
 */
async function createLockAtomically(
  lockPath: string,
  payload: Uint8Array,
): Promise<void> {
  const temp = `${lockPath}.${crypto.randomUUID()}.tmp`;
  await Deno.writeFile(temp, payload, { createNew: true });
  try {
    await Deno.link(temp, lockPath);
  } finally {
    try {
      await Deno.remove(temp);
    } catch {
      // The link either landed or did not; a leftover sibling would be
      // noise, not a lock, and must not mask the outcome of the link.
    }
  }
}

/**
 * Remove temp siblings stranded by a kill mid-publication.
 *
 * Run only while breaking an abandoned lock — already the "clean up after
 * a kill" moment, and rare — and only for siblings older than the stale
 * age, so a temp file belonging to an acquisition in flight is never
 * touched. Failures are ignored deliberately: this is tidying, and it must
 * not stop the break it rides along with.
 *
 * @param lockPath - Lock file whose siblings to sweep
 * @param staleMs - Age past which a temp file is certainly abandoned
 * @param now - Clock seam
 */
async function sweepStaleTemps(
  lockPath: string,
  staleMs: number,
  now: () => number,
): Promise<void> {
  const slash = lockPath.lastIndexOf("/");
  const dir = slash === -1 ? "." : lockPath.slice(0, slash);
  const prefix = `${lockPath.slice(slash + 1)}.`;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) {
        continue;
      }
      const candidate = `${dir}/${entry.name}`;
      const stat = await Deno.stat(candidate);
      if (now() - (stat.mtime?.getTime() ?? now()) < staleMs) continue;
      await Deno.remove(candidate);
    }
  } catch {
    // Tidying only. The break itself is what matters here.
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
    host: ownerHost(),
  };
  const payload = new TextEncoder().encode(JSON.stringify(record));

  const deadline = now() + timeoutMs;
  const probe = { probed: false };
  let held = false;
  for (;;) {
    try {
      // Published complete, not created and then filled (Issue #1074):
      // a lock file that exists but names nobody is indistinguishable
      // from a live holder mid-write, and acting on that guess is what
      // put two writers in one journal.
      await createLockAtomically(lockPath, payload);
      held = true;
      break;
    } catch (error: unknown) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }

    if (await breakIfAbandoned(lockPath, staleMs, now, probe)) continue;

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
