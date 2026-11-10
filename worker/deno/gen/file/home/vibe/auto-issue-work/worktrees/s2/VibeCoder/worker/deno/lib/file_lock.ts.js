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
 */ import { commandOutputWithTimeout, isCommandTimeoutError } from "./subprocess_timeout.ts";
/** `ps -p` liveness probe. Seconds. A timeout is not "the holder is gone". */ const LOCK_PROBE_TIMEOUT_MS = 10_000;
/** How long to wait for a held lock before giving up. */ export const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Age at which a held lock is treated as abandoned.
 *
 * Two orders of magnitude above the longest plausible hold (an append is a
 * read, a hash and two small writes), so a live holder is never broken.
 */ export const DEFAULT_STALE_MS = 120_000;
/**
 * Multiple of the stale age past which the pid check is overruled.
 *
 * The pid can be a false positive (recycled in a later container's pid
 * namespace) but never a false negative, so this only ever breaks locks the
 * age check had already condemned.
 */ export const HARD_STALE_MULTIPLIER = 10;
/** Delay between acquisition attempts. */ export const DEFAULT_POLL_MS = 25;
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
 */ function ownerHost() {
  try {
    return Deno.hostname();
  } catch  {
    return "";
  }
}
/** Raised when the lock could not be taken within the timeout. */ export class FileLockTimeoutError extends Error {
  constructor(path, timeoutMs, holder){
    super(`could not take the lock at ${path} within ${timeoutMs}ms — held by ` + holder);
    this.name = "FileLockTimeoutError";
  }
}
/** Sleep for `ms`, with a little jitter so contenders do not lock-step. */ function sleep(ms) {
  const jittered = ms + Math.floor(Math.random() * ms);
  return new Promise((resolve)=>setTimeout(resolve, jittered));
}
/** Read a lock file's record, or null when it is absent or unreadable. */ async function readRecord(path) {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (typeof parsed === "object" && parsed !== null && typeof parsed.token === "string") {
      return parsed;
    }
    return null;
  } catch  {
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
 */ export async function holderGone(pid, timeoutMs = LOCK_PROBE_TIMEOUT_MS) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const probe = await commandOutputWithTimeout("ps", {
      args: [
        "-p",
        String(pid)
      ],
      stdout: "null",
      stderr: "null",
      timeoutMs
    });
    // `ps -p` exits non-zero precisely when no such process exists.
    return !probe.success;
  } catch (error) {
    if (isCommandTimeoutError(error)) throw error;
    return null;
  }
}
/**
 * How long a break decision may hold the break lock before it is ignored.
 *
 * Only a `ps` spawn happens under it, so this is orders of magnitude above
 * the real hold; it exists solely so a breaker killed mid-decision cannot
 * stop anyone else ever breaking a lock again.
 */ const BREAK_LOCK_TTL_MS = 5_000;
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
 */ async function breakIfAbandoned(path, staleMs, now, probe) {
  const breakPath = `${path}.break`;
  try {
    await createLockAtomically(breakPath, new TextEncoder().encode(JSON.stringify({
      token: crypto.randomUUID(),
      pid: Deno.pid,
      acquiredAt: new Date(now()).toISOString(),
      host: ownerHost()
    })));
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    // Someone else is deciding. Let them, and come back on the next poll —
    // unless their decision has plainly outlived any real one, which means
    // the breaker was itself killed part-way through.
    try {
      const held = await Deno.stat(breakPath);
      if (now() - (held.mtime?.getTime() ?? now()) > BREAK_LOCK_TTL_MS) {
        await Deno.remove(breakPath);
      }
    } catch  {
    // Released while we looked; the next poll will find it free.
    }
    return false;
  }
  try {
    const broke = await decideAndBreak(path, staleMs, now, probe);
    if (broke) await sweepStaleTemps(path, staleMs, now);
    return broke;
  } finally{
    try {
      await Deno.remove(breakPath);
    } catch  {
    // Only cleared by its holder or by the TTL above; either way, gone.
    }
  }
}
/** The break decision itself, run under the break lock. */ async function decideAndBreak(path, staleMs, now, probe) {
  let ageMs;
  try {
    const stat = await Deno.stat(path);
    ageMs = now() - (stat.mtime?.getTime() ?? now());
  } catch  {
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
    await breakLock(path, ageMs, `pid ${record.pid} is no longer running`, record);
    return true;
  }
  const beyondDoubt = ageMs >= staleMs * HARD_STALE_MULTIPLIER;
  // Past the stale age, only a *conclusive* liveness answer protects the
  // lock. An inconclusive probe used to read as "alive" and hold the
  // audit trail for the full hard-stale window (Issue #1074).
  if (!beyondDoubt && record && await holderGone(record.pid) === false) {
    return false;
  }
  const why = beyondDoubt ? `no append takes that long, whatever pid ${record?.pid ?? "unknown"} ` + `is now` : `pid ${record?.pid ?? "unknown"} is not running, or cannot be asked ` + `about from here`;
  await breakLock(path, ageMs, why, record);
  return true;
}
/** Remove an abandoned lock, announcing it: a silent steal is the bug. */ async function breakLock(path, ageMs, why, condemned) {
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
  console.error(`[SECURITY] [AUDIT_LOCK_BROKEN] ${path}: held for ${Math.round(ageMs / 1000)}s — ${why}; breaking the abandoned lock`);
  try {
    await Deno.remove(path);
  } catch  {
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
 */ async function createLockAtomically(lockPath, payload) {
  const temp = `${lockPath}.${crypto.randomUUID()}.tmp`;
  await Deno.writeFile(temp, payload, {
    createNew: true
  });
  try {
    await Deno.link(temp, lockPath);
  } finally{
    try {
      await Deno.remove(temp);
    } catch  {
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
 */ async function sweepStaleTemps(lockPath, staleMs, now) {
  const slash = lockPath.lastIndexOf("/");
  const dir = slash === -1 ? "." : lockPath.slice(0, slash);
  const prefix = `${lockPath.slice(slash + 1)}.`;
  try {
    for await (const entry of Deno.readDir(dir)){
      if (!entry.isFile) continue;
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) {
        continue;
      }
      const candidate = `${dir}/${entry.name}`;
      const stat = await Deno.stat(candidate);
      if (now() - (stat.mtime?.getTime() ?? now()) < staleMs) continue;
      await Deno.remove(candidate);
    }
  } catch  {
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
 */ export async function withFileLock(lockPath, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? (()=>Date.now());
  const token = crypto.randomUUID();
  const record = {
    token,
    pid: Deno.pid,
    acquiredAt: new Date(now()).toISOString(),
    host: ownerHost()
  };
  const payload = new TextEncoder().encode(JSON.stringify(record));
  const deadline = now() + timeoutMs;
  const probe = {
    probed: false
  };
  let held = false;
  for(;;){
    try {
      // Published complete, not created and then filled (Issue #1074):
      // a lock file that exists but names nobody is indistinguishable
      // from a live holder mid-write, and acting on that guess is what
      // put two writers in one journal.
      await createLockAtomically(lockPath, payload);
      held = true;
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    if (await breakIfAbandoned(lockPath, staleMs, now, probe)) continue;
    if (now() >= deadline) {
      const holder = await readRecord(lockPath);
      throw new FileLockTimeoutError(lockPath, timeoutMs, holder ? `pid ${holder.pid} since ${holder.acquiredAt}` : "an unknown process");
    }
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally{
    if (held) {
      // Only release a lock we still hold: if ours was broken as abandoned
      // and retaken, removing it would evict its new owner.
      const current = await readRecord(lockPath);
      if (current === null || current.token === token) {
        try {
          await Deno.remove(lockPath);
        } catch  {
        // Already gone. Nothing to release.
        }
      }
    }
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9maWxlX2xvY2sudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDcm9zcy1wcm9jZXNzIGFkdmlzb3J5IGZpbGUgbG9jayAoSXNzdWUgIzQ5MSkuXG4gKlxuICogIyMgV2h5IHRoaXMgZXhpc3RzXG4gKlxuICogYGF1ZGl0X2pvdXJuYWwudHNgIHNlcmlhbGlzZWQgaXRzIGFwcGVuZHMgd2l0aCBhIGBNYXBgIG9mIGNoYWluZWRcbiAqIHByb21pc2VzIGFuZCBjYWxsZWQgaXQgYSBsb2NrLiBJdCBpcyBub3Qgb25lOiBpdCBvcmRlcnMgY2FsbGVycyBpbnNpZGUgYVxuICogc2luZ2xlIERlbm8gcHJvY2VzcyBhbmQgaXMgaW52aXNpYmxlIHRvIGV2ZXJ5IG90aGVyIHByb2Nlc3Mgb24gdGhlIGhvc3QuXG4gKiBUaGUgYXVkaXQgam91cm5hbCBsaXZlcyBvbiB0aGUgc2hhcmVkIHdvcmsgdm9sdW1lLCBhbmQgYFZJQkVfUlVOX0lEYCBpc1xuICogZXhwb3J0ZWQgdG8gZXZlcnkgY2hpbGQgYGRlbm9gIGNvbW1hbmQgKGBydW5faWQudHNgKSwgc28gYSBjaGlsZCB3cml0ZXJcbiAqIGFwcGVuZHMgdG8gdGhlIHNhbWUgZmlsZSB1bmRlciB0aGUgc2FtZSBydW4gaWQgd2l0aCBhIGNvbXBsZXRlbHlcbiAqIGluZGVwZW5kZW50IHZpZXcgb2YgdGhlIGNoYWluIGhlYWQuIE9uIEdSUS0yMyB0aGF0IG9ycGhhbmVkIHRoZSBoZWFkXG4gKiBoYXNoIGluIDEwIG9mIDE0IGpvdXJuYWxzOiBvbmUgd3JpdGVyIGhlbGQgaXRzIGNhY2hlZCBoZWFkIGFjcm9zcyBhXG4gKiBidXJzdCBvZiBhcHBlbmRzIGJ5IGFub3RoZXIgYW5kIHRoZW4gY2hhaW5lZCBvbiB0b3Agb2YgaXQuXG4gKlxuICogRGVubyBleHBvc2VzIG5vIGBmbG9ja2AsIHNvIHRoaXMgaXMgdGhlIHBvcnRhYmxlIHByaW1pdGl2ZTogYW4gYE9fRVhDTGBcbiAqIGxvY2sgZmlsZSwgd2hpY2ggaXMgYXRvbWljIG9uIGV2ZXJ5IGZpbGVzeXN0ZW0gdGhlIHdvcmtlciBydW5zIG9uLlxuICpcbiAqICMjIEFiYW5kb25lZCBsb2Nrc1xuICpcbiAqIEEgcHJvY2VzcyBraWxsZWQgd2hpbGUgaG9sZGluZyB0aGUgbG9jayB3b3VsZCBvdGhlcndpc2Ugd2VkZ2UgZXZlcnlcbiAqIGxhdGVyIHdyaXRlciBmb3IgZXZlciwgYW5kIGEgcnVuIGtpbGxlZCBtaWQtYXBwZW5kIGlzIHRoZSBvcmRpbmFyeSBjYXNlXG4gKiB0aGlzIHdob2xlIHN1YnN5c3RlbSBleGlzdHMgZm9yIChJc3N1ZSAjMTA3NCkg4oCUIHNvIHRoZSBhYmFuZG9uZWQgbG9ja1xuICogYW5kIHRoZSBkYW1hZ2VkIGNoYWluIGFycml2ZSB0b2dldGhlciwgYW5kIHRoZSBuZXh0IHJ1biBoYXMgdG8gY2xlYXJcbiAqIGJvdGguXG4gKlxuICogQSBsb2NrIGlzIGJyb2tlbiAqKmltbWVkaWF0ZWx5Kiogb25seSB3aGVuIGl0cyBob2xkZXIgaXMgKnByb3ZhYmx5KlxuICogZ29uZSwgd2hpY2ggbmVlZHMgdHdvIHRoaW5ncyB0byBiZSB0cnVlIGF0IG9uY2UuIFRoZSByZWNvcmQgbXVzdCBuYW1lXG4gKiB0aGUgc2FtZSB7QGxpbmsgb3duZXJIb3N0fSB0aGlzIHByb2Nlc3MgcnVucyB1bmRlciDigJQgcGlkcyBhcmUgbmFtZXNwYWNlZFxuICogcGVyIGNvbnRhaW5lciwgc28gYSBwaWQgd3JpdHRlbiBpbnNpZGUgYW5vdGhlciBjb250YWluZXIgaXMgbm90IGEgcGlkXG4gKiB0aGlzIG9uZSBjYW4gYXNrIGFib3V0LCBhbmQgYXNraW5nIGFueXdheSBpcyBob3cgYSAqbGl2ZSogaG9sZGVyJ3MgbG9ja1xuICogZ2V0cyBzdG9sZW4gYW5kIHR3byB3cml0ZXJzIGxhbmQgaW4gb25lIGpvdXJuYWwuIEFuZCBgcHMgLXBgIG11c3RcbiAqIGNvbmNsdXNpdmVseSByZXBvcnQgdGhlIHBpZCBnb25lOyB0aGUgcHJvYmUgaXMgcnVuIGF0IG1vc3Qgb25jZSBwZXJcbiAqIGNvbnRlbmRlZCBhY3F1aXNpdGlvbiwgYW5kIGFueXRoaW5nIHNob3J0IG9mIGEgY29uY2x1c2l2ZSBhbnN3ZXIgY291bnRzXG4gKiBhcyBhbGl2ZS5cbiAqXG4gKiBBIGxvY2sgZmlsZSB0aGF0IHJlY29yZHMgKipubyBob2xkZXIqKiBpcyBuZXZlciBicm9rZW4gZWFybHkuIEFuIGVhcmxpZXJcbiAqIHJldmlzaW9uIG9mIHRoaXMgbW9kdWxlIGJyb2tlIG9uZSBvbiBpdHMgc2Vjb25kIHNpZ2h0aW5nLCByZWFzb25pbmcgdGhhdFxuICogdGhlIG9wIGNyZWF0aW5nIGFuZCBmaWxsaW5nIGl0IHdhcyB0b28gbmFycm93IHRvIHN1cnZpdmUgdHdvIHBvbGxzLiBUaGF0XG4gKiB3YXMgd3JvbmcsIGFuZCB3cm9uZyBpbiB0aGUgZGlyZWN0aW9uIHRoaXMgd2hvbGUgc3Vic3lzdGVtIGV4aXN0cyB0b1xuICogcHJldmVudDogY3JlYXRpb24gd2FzIGBvcGVuKE9fQ1JFQVR8T19FWENMKWAgZm9sbG93ZWQgYnkgYSBzZXBhcmF0ZVxuICogYHdyaXRlYCwgc28gYSBob2xkZXIgZGVzY2hlZHVsZWQgYmV0d2VlbiB0aGUgdHdvIGlzIG9ic2VydmFibHkgb3duZXJsZXNzXG4gKiBmb3IgYXMgbG9uZyBhcyBpdCBpcyBvZmYgdGhlIENQVS4gTWVhc3VyZWQgc3RyYWlnaHQsIHRoZSBmaWxlIHdhc1xuICogcHJlc2VudC1idXQtZW1wdHkgaW4gMjY1IG9mIDk2MSBzaWdodGluZ3M7IHVuZGVyIENQVSBjb250ZW50aW9uIHR3b1xuICogcG9sbHMgYSBtaWxsaXNlY29uZCBhcGFydCBib3RoIGxhbmRlZCBpbnNpZGUgdGhlIHdpbmRvdywgYW5kIHRoZSBsb2NrIG9mXG4gKiBhIHBlcmZlY3RseSBsaXZlIGhvbGRlciB3YXMgYnJva2VuIOKAlCB0d28gd3JpdGVycyBpbiBvbmUgam91cm5hbCwgd2hpY2hcbiAqIGlzIHRoZSB0b3JuIGxpbmUgb2YgSXNzdWUgIzEwNzQgcmF0aGVyIHRoYW4gYSBmaXggZm9yIGl0LlxuICpcbiAqIHtAbGluayBjcmVhdGVMb2NrQXRvbWljYWxseX0gY2xvc2VzIHRoZSB3aW5kb3cgaW5zdGVhZCBvZiBndWVzc2luZyBhYm91dFxuICogaXQ6IHRoZSByZWNvcmQgaXMgd3JpdHRlbiB0byBhIHRlbXAgZmlsZSBmaXJzdCBhbmQgYGxpbmsoMilgZWQgaW50b1xuICogcGxhY2UsIHNvIHRoZSBsb2NrIGZpbGUgY2FycmllcyBpdHMgaG9sZGVyIGZyb20gdGhlIGluc3RhbnQgaXQgZXhpc3RzLlxuICogQW4gb3duZXJsZXNzIGxvY2sgaXMgdGhlcmVmb3JlIHVucmVhY2hhYmxlIGluIG5ldyB3cml0ZXMsIGFuZCBhIGxlZ2FjeVxuICogb3IgZ2VudWluZWx5IGFiYW5kb25lZCBvbmUgaXMgbGVmdCB0byB0aGUgYWdlIHJ1bGVzIGJlbG93IOKAlCBzbG93ZXIgdGhhblxuICogYW4gaW1tZWRpYXRlIGJyZWFrLCBhbmQgc291bmQuXG4gKlxuICogT3RoZXJ3aXNlIHRoZSBhZ2UgcnVsZXMgZGVjaWRlOiBhIGxvY2sgb2xkZXIgdGhhblxuICoge0BsaW5rIERFRkFVTFRfU1RBTEVfTVN9IGlzIGJyb2tlbiB1bmxlc3MgdGhlIGhvbGRlciBpcyAqY29uY2x1c2l2ZWx5KlxuICogYWxpdmUuIFRoYXQgYXN5bW1ldHJ5IGlzIGRlbGliZXJhdGUgYW5kIGlzIHRoZSBzZWNvbmQgaGFsZiBvZiBJc3N1ZVxuICogIzEwNzQuIFRoZSBsaXZlbmVzcyBwcm9iZSB1c2VkIHRvIHN0YXQgYC9wcm9jYCwgd2hpY2ggRGVubyByZWZ1c2VzXG4gKiB3aXRob3V0IGAtLWFsbG93LWFsbGA7IHRoZSB3b3JrZXIgcnVucyBvbiBncmFudWxhciBwZXJtaXNzaW9ucywgc28gdGhlXG4gKiBzdGF0IHRocmV3LCB0aGUgY2F0Y2ggcmVhZCB0aGF0IGFzIFwiYXNzdW1lIGFsaXZlXCIsIGFuZCBldmVyeSBhYmFuZG9uZWRcbiAqIGxvY2sgc3Vydml2ZWQgdG8ge0BsaW5rIEhBUkRfU1RBTEVfTVVMVElQTElFUn0g4oCUIHR3ZW50eSBtaW51dGVzIG9mXG4gKiB1bnJlY29yZGVkIG11dGF0aW9ucyBhZnRlciBldmVyeSBraWxsLiBBbiBpbmNvbmNsdXNpdmUgcHJvYmUgbXVzdCBub3RcbiAqIHByb3RlY3QgYSBsb2NrIHRoZSBhZ2UgcnVsZSBoYXMgYWxyZWFkeSBjb25kZW1uZWQuXG4gKlxuICoge0BsaW5rIEhBUkRfU1RBTEVfTVVMVElQTElFUn0gcmVtYWlucyB0aGUgYmFja3N0b3AgZm9yIGEgcGlkIHRoYXQgaXNcbiAqIGFsaXZlIGJ1dCBpcyBub3QgdGhlIGhvbGRlciDigJQgcmVpc3N1ZWQgdG8gc29tZXRoaW5nIGVsc2UgaW5zaWRlIHRoZSBzYW1lXG4gKiBjb250YWluZXIuIFBhc3QgdHdlbnR5IG1pbnV0ZXMgdGhlIGxvY2sgaXMgYnJva2VuIHdoYXRldmVyIHRoZSBwcm9iZVxuICogc2F5cywgYmVjYXVzZSBubyBhcHBlbmQgaGFzIGV2ZXIgdGFrZW4gdHdlbnR5IG1pbnV0ZXMuXG4gKlxuICogRXZlcnkgYnJlYWsgaXMgYW5ub3VuY2VkIG9uIHN0ZGVycjogc2lsZW50bHkgc3RlYWxpbmcgYSBsb2NrIGlzIGhvdyB0aGVcbiAqIGNvcnJ1cHRpb24gdGhpcyBtb2R1bGUgZXhpc3RzIHRvIHByZXZlbnQgZ2V0cyByZWludHJvZHVjZWQuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB7XG4gIGNvbW1hbmRPdXRwdXRXaXRoVGltZW91dCxcbiAgaXNDb21tYW5kVGltZW91dEVycm9yLFxufSBmcm9tIFwiLi9zdWJwcm9jZXNzX3RpbWVvdXQudHNcIjtcblxuLyoqIGBwcyAtcGAgbGl2ZW5lc3MgcHJvYmUuIFNlY29uZHMuIEEgdGltZW91dCBpcyBub3QgXCJ0aGUgaG9sZGVyIGlzIGdvbmVcIi4gKi9cbmNvbnN0IExPQ0tfUFJPQkVfVElNRU9VVF9NUyA9IDEwXzAwMDtcblxuLyoqIEhvdyBsb25nIHRvIHdhaXQgZm9yIGEgaGVsZCBsb2NrIGJlZm9yZSBnaXZpbmcgdXAuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9USU1FT1VUX01TID0gMTBfMDAwO1xuXG4vKipcbiAqIEFnZSBhdCB3aGljaCBhIGhlbGQgbG9jayBpcyB0cmVhdGVkIGFzIGFiYW5kb25lZC5cbiAqXG4gKiBUd28gb3JkZXJzIG9mIG1hZ25pdHVkZSBhYm92ZSB0aGUgbG9uZ2VzdCBwbGF1c2libGUgaG9sZCAoYW4gYXBwZW5kIGlzIGFcbiAqIHJlYWQsIGEgaGFzaCBhbmQgdHdvIHNtYWxsIHdyaXRlcyksIHNvIGEgbGl2ZSBob2xkZXIgaXMgbmV2ZXIgYnJva2VuLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TVEFMRV9NUyA9IDEyMF8wMDA7XG5cbi8qKlxuICogTXVsdGlwbGUgb2YgdGhlIHN0YWxlIGFnZSBwYXN0IHdoaWNoIHRoZSBwaWQgY2hlY2sgaXMgb3ZlcnJ1bGVkLlxuICpcbiAqIFRoZSBwaWQgY2FuIGJlIGEgZmFsc2UgcG9zaXRpdmUgKHJlY3ljbGVkIGluIGEgbGF0ZXIgY29udGFpbmVyJ3MgcGlkXG4gKiBuYW1lc3BhY2UpIGJ1dCBuZXZlciBhIGZhbHNlIG5lZ2F0aXZlLCBzbyB0aGlzIG9ubHkgZXZlciBicmVha3MgbG9ja3MgdGhlXG4gKiBhZ2UgY2hlY2sgaGFkIGFscmVhZHkgY29uZGVtbmVkLlxuICovXG5leHBvcnQgY29uc3QgSEFSRF9TVEFMRV9NVUxUSVBMSUVSID0gMTA7XG5cbi8qKiBEZWxheSBiZXR3ZWVuIGFjcXVpc2l0aW9uIGF0dGVtcHRzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfUE9MTF9NUyA9IDI1O1xuXG4vKiogVHVuaW5nIGZvciB7QGxpbmsgd2l0aEZpbGVMb2NrfTsgZXZlcnkgZmllbGQgaGFzIGEgc2FuZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBGaWxlTG9ja09wdGlvbnMge1xuICAvKiogSG93IGxvbmcgdG8gd2FpdCBmb3IgdGhlIGhvbGRlciB0byByZWxlYXNlIChtcykuICovXG4gIHRpbWVvdXRNcz86IG51bWJlcjtcbiAgLyoqIEFnZSBhdCB3aGljaCBhIGhlbGQgbG9jayBjb3VudHMgYXMgYWJhbmRvbmVkIChtcykuICovXG4gIHN0YWxlTXM/OiBudW1iZXI7XG4gIC8qKiBEZWxheSBiZXR3ZWVuIGF0dGVtcHRzIChtcykuICovXG4gIHBvbGxNcz86IG51bWJlcjtcbiAgLyoqIENsb2NrIHNlYW0gZm9yIHRlc3RzLiAqL1xuICBub3c/OiAoKSA9PiBudW1iZXI7XG59XG5cbi8qKiBXaGF0IG9uZSBob2xkZXIgd3JpdGVzIGludG8gaXRzIGxvY2sgZmlsZS4gKi9cbmludGVyZmFjZSBMb2NrUmVjb3JkIHtcbiAgdG9rZW46IHN0cmluZztcbiAgcGlkOiBudW1iZXI7XG4gIGFjcXVpcmVkQXQ6IHN0cmluZztcbiAgLyoqXG4gICAqIFdoaWNoIGhvc3Qg4oCUIGluIGEgY29udGFpbmVyLCB3aGljaCBjb250YWluZXIg4oCUIHRoZSBwaWQgYmVsb25ncyB0by5cbiAgICpcbiAgICogUGlkcyBhcmUgbmFtZXNwYWNlZCwgc28gYSBwaWQgaXMgb25seSBtZWFuaW5nZnVsIHRvIGEgcmVhZGVyIGluIHRoZVxuICAgKiBzYW1lIG5hbWVzcGFjZS4gUmVjb3JkaW5nIHRoZSBvd25lciBpcyB3aGF0IGxldHMgYSByZWFkZXIgdGVsbCBcInRoaXNcbiAgICogcGlkIGlzIGdvbmVcIiBmcm9tIFwidGhpcyBwaWQgd2FzIG5ldmVyIG1pbmUgdG8gYXNrIGFib3V0XCIgKElzc3VlXG4gICAqICMxMDc0KS4gQWJzZW50IG9uIGxvY2tzIHdyaXR0ZW4gYmVmb3JlIHRoYXQsIHdoaWNoIHNpbXBseSBuZXZlciB0YWtlXG4gICAqIHRoZSBpbW1lZGlhdGUtYnJlYWsgcGF0aC5cbiAgICovXG4gIGhvc3Q/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogSWRlbnRpdHkgb2YgdGhlIHBpZCBuYW1lc3BhY2UgdGhpcyBwcm9jZXNzIHdyaXRlcyBsb2NrcyB1bmRlci5cbiAqXG4gKiBUaGUgaG9zdG5hbWUgaXMgdGhlIGNvbnRhaW5lciBpZCBpbnNpZGUgYSBjb250YWluZXIgYW5kIHRoZSBtYWNoaW5lXG4gKiBuYW1lIG91dHNpZGUgb25lOyBlaXRoZXIgd2F5LCB0d28gcHJvY2Vzc2VzIHJlcG9ydGluZyB0aGUgc2FtZSB2YWx1ZVxuICogc2hhcmUgYSBwaWQgbmFtZXNwYWNlLCBhbmQgdHdvIHJlcG9ydGluZyBkaWZmZXJlbnQgdmFsdWVzIGRvIG5vdC5cbiAqXG4gKiBSZWFkaW5nIGl0IG5lZWRzIGAtLWFsbG93LXN5cz1ob3N0bmFtZWAuIFdpdGhvdXQgdGhhdCBwZXJtaXNzaW9uIOKAlCBvclxuICogb24gYSBob3N0IHdoZXJlIGl0IGNhbm5vdCBiZSByZWFkIOKAlCB0aGUgYW5zd2VyIGlzIHRoZSBlbXB0eSBzdHJpbmcsXG4gKiB3aGljaCBuZXZlciBtYXRjaGVzIGEgcmVjb3JkZWQgb3duZXIsIHNvIHRoZSBpbW1lZGlhdGUgYnJlYWsgc2ltcGx5XG4gKiBkb2VzIG5vdCBhcHBseSBhbmQgdGhlIGFnZSBydWxlcyBkZWNpZGUuIGBIT1NUTkFNRWAgaXMgZGVsaWJlcmF0ZWx5IG5vdFxuICogdXNlZDogaXQgaXMgYSBzaGVsbCB2YXJpYWJsZSB0aGF0IGlzIHVzdWFsbHkgbm90IGV4cG9ydGVkLCBzbyBpdCByZWFkc1xuICogYXMgZW1wdHkgZnJvbSBhIHNwYXduZWQgcHJvY2VzcyBhbmQgd291bGQgcXVpZXRseSBkaXNhYmxlIHRoaXMuXG4gKi9cbmZ1bmN0aW9uIG93bmVySG9zdCgpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBEZW5vLmhvc3RuYW1lKCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG59XG5cbi8qKiBSYWlzZWQgd2hlbiB0aGUgbG9jayBjb3VsZCBub3QgYmUgdGFrZW4gd2l0aGluIHRoZSB0aW1lb3V0LiAqL1xuZXhwb3J0IGNsYXNzIEZpbGVMb2NrVGltZW91dEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihwYXRoOiBzdHJpbmcsIHRpbWVvdXRNczogbnVtYmVyLCBob2xkZXI6IHN0cmluZykge1xuICAgIHN1cGVyKFxuICAgICAgYGNvdWxkIG5vdCB0YWtlIHRoZSBsb2NrIGF0ICR7cGF0aH0gd2l0aGluICR7dGltZW91dE1zfW1zIOKAlCBoZWxkIGJ5IGAgK1xuICAgICAgICBob2xkZXIsXG4gICAgKTtcbiAgICB0aGlzLm5hbWUgPSBcIkZpbGVMb2NrVGltZW91dEVycm9yXCI7XG4gIH1cbn1cblxuLyoqIFNsZWVwIGZvciBgbXNgLCB3aXRoIGEgbGl0dGxlIGppdHRlciBzbyBjb250ZW5kZXJzIGRvIG5vdCBsb2NrLXN0ZXAuICovXG5mdW5jdGlvbiBzbGVlcChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGppdHRlcmVkID0gbXMgKyBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBtcyk7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCBqaXR0ZXJlZCkpO1xufVxuXG4vKiogUmVhZCBhIGxvY2sgZmlsZSdzIHJlY29yZCwgb3IgbnVsbCB3aGVuIGl0IGlzIGFic2VudCBvciB1bnJlYWRhYmxlLiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVhZFJlY29yZChwYXRoOiBzdHJpbmcpOiBQcm9taXNlPExvY2tSZWNvcmQgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKSkgYXMgdW5rbm93bjtcbiAgICBpZiAoXG4gICAgICB0eXBlb2YgcGFyc2VkID09PSBcIm9iamVjdFwiICYmIHBhcnNlZCAhPT0gbnVsbCAmJlxuICAgICAgdHlwZW9mIChwYXJzZWQgYXMgTG9ja1JlY29yZCkudG9rZW4gPT09IFwic3RyaW5nXCJcbiAgICApIHtcbiAgICAgIHJldHVybiBwYXJzZWQgYXMgTG9ja1JlY29yZDtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogSGFzIGBwaWRgIGNvbmNsdXNpdmVseSBnb25lP1xuICpcbiAqIGBwcyAtcGAgaXMgdGhlIHByb2JlIHJhdGhlciB0aGFuIGAvcHJvY2AsIHdoaWNoIERlbm8gcmVmdXNlcyB0byByZWFkXG4gKiB3aXRob3V0IGAtLWFsbG93LWFsbGAgKElzc3VlICMxMDc0KSwgYW5kIHJhdGhlciB0aGFuIGEgc2lnbmFsLCBiZWNhdXNlXG4gKiB0aGlzIHJlcG9zaXRvcnkgZG9lcyBub3Qgc2lnbmFsIGEgcGlkIGl0IGNhbm5vdCBwcm92ZSBpcyBzdGlsbCBpdHMgb3duLlxuICpcbiAqIEBwYXJhbSBwaWQgLSBQaWQgcmVjb3JkZWQgYnkgdGhlIGxvY2sgaG9sZGVyXG4gKiBAcmV0dXJucyBgdHJ1ZWAgd2hlbiBgcHNgIHJlcG9ydHMgbm8gc3VjaCBwcm9jZXNzLCBgZmFsc2VgIHdoZW4gaXRcbiAqICAgcmVwb3J0cyBvbmUsIGFuZCBgbnVsbGAgd2hlbiB0aGUgcXVlc3Rpb24gY291bGQgbm90IGJlIGFza2VkIGF0IGFsbCDigJRcbiAqICAgbm8gYHBzYCwgb3Igbm8gcnVuIHBlcm1pc3Npb24uIENhbGxlcnMgdHJlYXQgYG51bGxgIGFzIFwibm90IHByb3ZlblxuICogICBnb25lXCIsIG5ldmVyIGFzIGdvbmUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBob2xkZXJHb25lKFxuICBwaWQ6IG51bWJlcixcbiAgdGltZW91dE1zOiBudW1iZXIgPSBMT0NLX1BST0JFX1RJTUVPVVRfTVMsXG4pOiBQcm9taXNlPGJvb2xlYW4gfCBudWxsPiB7XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcihwaWQpIHx8IHBpZCA8PSAwKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCBwcm9iZSA9IGF3YWl0IGNvbW1hbmRPdXRwdXRXaXRoVGltZW91dChcInBzXCIsIHtcbiAgICAgIGFyZ3M6IFtcIi1wXCIsIFN0cmluZyhwaWQpXSxcbiAgICAgIHN0ZG91dDogXCJudWxsXCIsXG4gICAgICBzdGRlcnI6IFwibnVsbFwiLFxuICAgICAgdGltZW91dE1zLFxuICAgIH0pO1xuICAgIC8vIGBwcyAtcGAgZXhpdHMgbm9uLXplcm8gcHJlY2lzZWx5IHdoZW4gbm8gc3VjaCBwcm9jZXNzIGV4aXN0cy5cbiAgICByZXR1cm4gIXByb2JlLnN1Y2Nlc3M7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKGlzQ29tbWFuZFRpbWVvdXRFcnJvcihlcnJvcikpIHRocm93IGVycm9yO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogSG93IGxvbmcgYSBicmVhayBkZWNpc2lvbiBtYXkgaG9sZCB0aGUgYnJlYWsgbG9jayBiZWZvcmUgaXQgaXMgaWdub3JlZC5cbiAqXG4gKiBPbmx5IGEgYHBzYCBzcGF3biBoYXBwZW5zIHVuZGVyIGl0LCBzbyB0aGlzIGlzIG9yZGVycyBvZiBtYWduaXR1ZGUgYWJvdmVcbiAqIHRoZSByZWFsIGhvbGQ7IGl0IGV4aXN0cyBzb2xlbHkgc28gYSBicmVha2VyIGtpbGxlZCBtaWQtZGVjaXNpb24gY2Fubm90XG4gKiBzdG9wIGFueW9uZSBlbHNlIGV2ZXIgYnJlYWtpbmcgYSBsb2NrIGFnYWluLlxuICovXG5jb25zdCBCUkVBS19MT0NLX1RUTF9NUyA9IDVfMDAwO1xuXG4vKipcbiAqIEJyZWFrIGEgbG9jayB3aG9zZSBob2xkZXIgaXMgZ29uZSwgYW5ub3VuY2luZyBpdC5cbiAqXG4gKiBTZXJpYWxpc2VkIGFjcm9zcyBwcm9jZXNzZXMgYnkgYSBzZWNvbmQsIHNob3J0LWxpdmVkIGxvY2suIERlY2lkaW5nXG4gKiB0YWtlcyByZWFsIHRpbWUg4oCUIHRoZSBsaXZlbmVzcyBwcm9iZSBzcGF3bnMgYHBzYCDigJQgYW5kIHRoZSBmaWxlc3lzdGVtXG4gKiBvZmZlcnMgbm8gXCJyZW1vdmUgdGhpcyBmaWxlIG9ubHkgaWYgaXQgc3RpbGwgY29udGFpbnMgWFwiLCBzbyB3aXRob3V0XG4gKiB0aGlzIHR3byBjb250ZW5kZXJzIGNhbiBib3RoIGNvbmRlbW4gdGhlIHNhbWUgZGVhZCBob2xkZXIsIGFuZCB0aGVcbiAqIHNlY29uZCByZW1vdmVzIHRoZSAqd2lubmVyJ3MqIGZyZXNoIGxvY2sgYW5kIGVudGVycyBiZWhpbmQgaXQuIFRoYXQgaXNcbiAqIHR3byB3cml0ZXJzIGluIG9uZSBqb3VybmFsIChJc3N1ZSAjMTA3NCk6IHRoZSBjb3JydXB0aW9uIHRoaXMgbW9kdWxlXG4gKiBleGlzdHMgdG8gcHJldmVudCwgYXJyaXZpbmcgdGhyb3VnaCB0aGUgbWFjaGluZXJ5IG1lYW50IHRvIHJlY292ZXIgZnJvbVxuICogaXQuIEhvbGRpbmcgdGhlIGJyZWFrIGxvY2sgYWNyb3NzIHRoZSB3aG9sZSByZWFkLWRlY2lkZS1yZW1vdmUgc2VxdWVuY2VcbiAqIGlzIHdoYXQgbWFrZXMgXCJhdCBtb3N0IG9uZSBjb250ZW5kZXIgbWF5IGJyZWFrIGEgZ2l2ZW4gbG9ja1wiIHRydWUuXG4gKlxuICogQHJldHVybnMgdHJ1ZSB3aGVuIHRoZSBsb2NrIGZpbGUgd2FzIHJlbW92ZWQgYnkgdGhpcyBjYWxsXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGJyZWFrSWZBYmFuZG9uZWQoXG4gIHBhdGg6IHN0cmluZyxcbiAgc3RhbGVNczogbnVtYmVyLFxuICBub3c6ICgpID0+IG51bWJlcixcbiAgcHJvYmU6IHsgcHJvYmVkOiBib29sZWFuIH0sXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgYnJlYWtQYXRoID0gYCR7cGF0aH0uYnJlYWtgO1xuICB0cnkge1xuICAgIGF3YWl0IGNyZWF0ZUxvY2tBdG9taWNhbGx5KFxuICAgICAgYnJlYWtQYXRoLFxuICAgICAgbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgdG9rZW46IGNyeXB0by5yYW5kb21VVUlEKCksXG4gICAgICAgIHBpZDogRGVuby5waWQsXG4gICAgICAgIGFjcXVpcmVkQXQ6IG5ldyBEYXRlKG5vdygpKS50b0lTT1N0cmluZygpLFxuICAgICAgICBob3N0OiBvd25lckhvc3QoKSxcbiAgICAgIH0pKSxcbiAgICApO1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIGlmICghKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuQWxyZWFkeUV4aXN0cykpIHRocm93IGVycm9yO1xuICAgIC8vIFNvbWVvbmUgZWxzZSBpcyBkZWNpZGluZy4gTGV0IHRoZW0sIGFuZCBjb21lIGJhY2sgb24gdGhlIG5leHQgcG9sbCDigJRcbiAgICAvLyB1bmxlc3MgdGhlaXIgZGVjaXNpb24gaGFzIHBsYWlubHkgb3V0bGl2ZWQgYW55IHJlYWwgb25lLCB3aGljaCBtZWFuc1xuICAgIC8vIHRoZSBicmVha2VyIHdhcyBpdHNlbGYga2lsbGVkIHBhcnQtd2F5IHRocm91Z2guXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGhlbGQgPSBhd2FpdCBEZW5vLnN0YXQoYnJlYWtQYXRoKTtcbiAgICAgIGlmIChub3coKSAtIChoZWxkLm10aW1lPy5nZXRUaW1lKCkgPz8gbm93KCkpID4gQlJFQUtfTE9DS19UVExfTVMpIHtcbiAgICAgICAgYXdhaXQgRGVuby5yZW1vdmUoYnJlYWtQYXRoKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFJlbGVhc2VkIHdoaWxlIHdlIGxvb2tlZDsgdGhlIG5leHQgcG9sbCB3aWxsIGZpbmQgaXQgZnJlZS5cbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgYnJva2UgPSBhd2FpdCBkZWNpZGVBbmRCcmVhayhwYXRoLCBzdGFsZU1zLCBub3csIHByb2JlKTtcbiAgICBpZiAoYnJva2UpIGF3YWl0IHN3ZWVwU3RhbGVUZW1wcyhwYXRoLCBzdGFsZU1zLCBub3cpO1xuICAgIHJldHVybiBicm9rZTtcbiAgfSBmaW5hbGx5IHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgRGVuby5yZW1vdmUoYnJlYWtQYXRoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE9ubHkgY2xlYXJlZCBieSBpdHMgaG9sZGVyIG9yIGJ5IHRoZSBUVEwgYWJvdmU7IGVpdGhlciB3YXksIGdvbmUuXG4gICAgfVxuICB9XG59XG5cbi8qKiBUaGUgYnJlYWsgZGVjaXNpb24gaXRzZWxmLCBydW4gdW5kZXIgdGhlIGJyZWFrIGxvY2suICovXG5hc3luYyBmdW5jdGlvbiBkZWNpZGVBbmRCcmVhayhcbiAgcGF0aDogc3RyaW5nLFxuICBzdGFsZU1zOiBudW1iZXIsXG4gIG5vdzogKCkgPT4gbnVtYmVyLFxuICBwcm9iZTogeyBwcm9iZWQ6IGJvb2xlYW4gfSxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBsZXQgYWdlTXM6IG51bWJlcjtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KHBhdGgpO1xuICAgIGFnZU1zID0gbm93KCkgLSAoc3RhdC5tdGltZT8uZ2V0VGltZSgpID8/IG5vdygpKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gR29uZSBiZXR3ZWVuIHRoZSBmYWlsZWQgY3JlYXRlIGFuZCB0aGUgc3RhdDogdGhlIG5leHQgYXR0ZW1wdCB3aW5zLlxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGNvbnN0IHJlY29yZCA9IGF3YWl0IHJlYWRSZWNvcmQocGF0aCk7XG5cbiAgaWYgKGFnZU1zIDwgc3RhbGVNcykge1xuICAgIC8vIElzc3VlICMxMDc0OiBhIGhvbGRlciB0aGlzIHByb2Nlc3MgY2FuIHByb3ZlIGlzIGdvbmUgbmVlZCBub3QgYmVcbiAgICAvLyB3YWl0ZWQgb3V0IOKAlCBhIHJ1biBraWxsZWQgbWlkLWFwcGVuZCBsZWF2ZXMgaXRzIGxvY2sgYmVoaW5kLCBhbmQgdGhlXG4gICAgLy8gbmV4dCBydW4ncyBhdWRpdCBzd2VlcCBhcnJpdmVzIHdlbGwgaW5zaWRlIHRoZSBzdGFsZSB3aW5kb3cuXG4gICAgLy9cbiAgICAvLyBcIlByb3ZlXCIgaXMgdGhlIHdob2xlIG9mIGl0LCBhbmQgYSBsb2NrIG5hbWluZyBub2JvZHkgcHJvdmVzIG5vdGhpbmc6XG4gICAgLy8gaXQgaXMgd2hhdCBhIGxpdmUgaG9sZGVyIGxvb2tzIGxpa2UgbWlkLWNyZWF0ZSBvbiBhbnkgYnVpbGQgdGhhdFxuICAgIC8vIHN0aWxsIGZpbGxzIHRoZSBmaWxlIGFmdGVyIGNyZWF0aW5nIGl0LCBhbmQgd2hhdCBhIGxlZ2FjeSBvclxuICAgIC8vIHRydW5jYXRlZCByZWNvcmQgbG9va3MgbGlrZSBhZnRlcndhcmRzLiBOZWl0aGVyIGlzIGdyb3VuZHMgZm9yIGFcbiAgICAvLyBicmVhaywgc28gaXQgd2FpdHMgZm9yIHRoZSBhZ2UgcnVsZXMuXG4gICAgaWYgKCFyZWNvcmQpIHJldHVybiBmYWxzZTtcbiAgICAvLyBPdGhlcndpc2UgdGhlIHJlY29yZGVkIHBpZCBoYXMgdG8gYmUgb25lIHRoaXMgcHJvY2VzcyBjYW4gYXNrXG4gICAgLy8gYWJvdXQuIEEgcmVjb3JkIGZyb20gYW5vdGhlciBwaWQgbmFtZXNwYWNlIG5hbWVzIGEgcGlkIHRoYXQgaXMgbm90XG4gICAgLy8gb3VycyB0byBsb29rIHVwLCBhbmQgYSBgcHNgIG1pc3MgdGhlcmUgd291bGQgYmUgYSAqbGl2ZSogaG9sZGVyJ3NcbiAgICAvLyBsb2NrIHN0b2xlbi4gVGhlIHByb2JlIHJ1bnMgYXQgbW9zdCBvbmNlIHBlciBhY3F1aXNpdGlvbjogYSBob2xkZXJcbiAgICAvLyB0aGF0IHdhcyBhbGl2ZSBhIHBvbGwgYWdvIGRvZXMgbm90IG5lZWQgcmUtYXNraW5nLCBhbmQgc3Bhd25pbmdcbiAgICAvLyBgcHNgIG9uIGV2ZXJ5IHBvbGwgd291bGQgY29zdCBtb3JlIHRoYW4gdGhlIHdhaXQuXG4gICAgaWYgKCFyZWNvcmQuaG9zdCB8fCByZWNvcmQuaG9zdCAhPT0gb3duZXJIb3N0KCkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAocHJvYmUucHJvYmVkKSByZXR1cm4gZmFsc2U7XG4gICAgcHJvYmUucHJvYmVkID0gdHJ1ZTtcbiAgICBpZiAoYXdhaXQgaG9sZGVyR29uZShyZWNvcmQucGlkKSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xuICAgIGF3YWl0IGJyZWFrTG9jayhcbiAgICAgIHBhdGgsXG4gICAgICBhZ2VNcyxcbiAgICAgIGBwaWQgJHtyZWNvcmQucGlkfSBpcyBubyBsb25nZXIgcnVubmluZ2AsXG4gICAgICByZWNvcmQsXG4gICAgKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGNvbnN0IGJleW9uZERvdWJ0ID0gYWdlTXMgPj0gc3RhbGVNcyAqIEhBUkRfU1RBTEVfTVVMVElQTElFUjtcbiAgLy8gUGFzdCB0aGUgc3RhbGUgYWdlLCBvbmx5IGEgKmNvbmNsdXNpdmUqIGxpdmVuZXNzIGFuc3dlciBwcm90ZWN0cyB0aGVcbiAgLy8gbG9jay4gQW4gaW5jb25jbHVzaXZlIHByb2JlIHVzZWQgdG8gcmVhZCBhcyBcImFsaXZlXCIgYW5kIGhvbGQgdGhlXG4gIC8vIGF1ZGl0IHRyYWlsIGZvciB0aGUgZnVsbCBoYXJkLXN0YWxlIHdpbmRvdyAoSXNzdWUgIzEwNzQpLlxuICBpZiAoIWJleW9uZERvdWJ0ICYmIHJlY29yZCAmJiBhd2FpdCBob2xkZXJHb25lKHJlY29yZC5waWQpID09PSBmYWxzZSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGNvbnN0IHdoeSA9IGJleW9uZERvdWJ0XG4gICAgPyBgbm8gYXBwZW5kIHRha2VzIHRoYXQgbG9uZywgd2hhdGV2ZXIgcGlkICR7cmVjb3JkPy5waWQgPz8gXCJ1bmtub3duXCJ9IGAgK1xuICAgICAgYGlzIG5vd2BcbiAgICA6IGBwaWQgJHtyZWNvcmQ/LnBpZCA/PyBcInVua25vd25cIn0gaXMgbm90IHJ1bm5pbmcsIG9yIGNhbm5vdCBiZSBhc2tlZCBgICtcbiAgICAgIGBhYm91dCBmcm9tIGhlcmVgO1xuICBhd2FpdCBicmVha0xvY2socGF0aCwgYWdlTXMsIHdoeSwgcmVjb3JkKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKiBSZW1vdmUgYW4gYWJhbmRvbmVkIGxvY2ssIGFubm91bmNpbmcgaXQ6IGEgc2lsZW50IHN0ZWFsIGlzIHRoZSBidWcuICovXG5hc3luYyBmdW5jdGlvbiBicmVha0xvY2soXG4gIHBhdGg6IHN0cmluZyxcbiAgYWdlTXM6IG51bWJlcixcbiAgd2h5OiBzdHJpbmcsXG4gIGNvbmRlbW5lZDogTG9ja1JlY29yZCB8IG51bGwsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gQnJlYWsgdGhlIGxvY2sgdGhhdCB3YXMgYWN0dWFsbHkganVkZ2VkLCBub3Qgd2hhdGV2ZXIgaG9sZHMgdGhlIHBhdGhcbiAgLy8gbm93LiBEZWNpZGluZyB0YWtlcyB0aW1lIOKAlCB0aGUgbGl2ZW5lc3MgcHJvYmUgc3Bhd25zIGBwc2Ag4oCUIGFuZCB0d29cbiAgLy8gY29udGVuZGVycyBjYW4gY29uZGVtbiB0aGUgc2FtZSBkZWFkIGhvbGRlciBjb25jdXJyZW50bHk6IHdpdGhvdXRcbiAgLy8gdGhpcywgdGhlIGZpcnN0IGJyZWFrcyBpdCBhbmQgdGFrZXMgdGhlIGxvY2ssIGFuZCB0aGUgc2Vjb25kIHRoZW5cbiAgLy8gcmVtb3ZlcyB0aGUgKndpbm5lcidzKiBmcmVzaCBsb2NrIGFuZCB0YWtlcyBpdCB0b28sIHdoaWNoIGlzIHR3byBsaXZlXG4gIC8vIHdyaXRlcnMgaW4gb25lIGpvdXJuYWwgKElzc3VlICMxMDc0KS4gUmUtcmVhZGluZyBpbW1lZGlhdGVseSBiZWZvcmVcbiAgLy8gdGhlIHJlbW92ZSBuYXJyb3dzIHRoYXQgdG8gdGhlIGdhcCBiZXR3ZWVuIHR3byBhZGphY2VudCBzeXNjYWxsczsgaXRcbiAgLy8gZG9lcyBub3QgbWFrZSB0aGUgY2hlY2sgYXRvbWljLCBzbyB0aGlzIHN0YXlzIGEgbGFzdCBsaW5lIG9mIGRlZmVuY2VcbiAgLy8gYmVoaW5kIHRoZSBhZ2UgYW5kIGxpdmVuZXNzIHJ1bGVzIHJhdGhlciB0aGFuIGEgc3Vic3RpdHV0ZSBmb3IgdGhlbS5cbiAgY29uc3QgY3VycmVudCA9IGF3YWl0IHJlYWRSZWNvcmQocGF0aCk7XG4gIGlmIChjb25kZW1uZWQgJiYgY3VycmVudCAmJiBjdXJyZW50LnRva2VuICE9PSBjb25kZW1uZWQudG9rZW4pIHJldHVybjtcblxuICBjb25zb2xlLmVycm9yKFxuICAgIGBbU0VDVVJJVFldIFtBVURJVF9MT0NLX0JST0tFTl0gJHtwYXRofTogaGVsZCBmb3IgJHtcbiAgICAgIE1hdGgucm91bmQoYWdlTXMgLyAxMDAwKVxuICAgIH1zIOKAlCAke3doeX07IGJyZWFraW5nIHRoZSBhYmFuZG9uZWQgbG9ja2AsXG4gICk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIEFub3RoZXIgY29udGVuZGVyIGJyb2tlIGl0IGZpcnN0OyBlaXRoZXIgd2F5IGl0IGlzIG5vIGxvbmdlciBvdXJzXG4gICAgLy8gdG8gd29ycnkgYWJvdXQuXG4gIH1cbn1cblxuLyoqXG4gKiBDcmVhdGUgYGxvY2tQYXRoYCBhbHJlYWR5IGNhcnJ5aW5nIGBwYXlsb2FkYCwgb3IgZmFpbCBiZWNhdXNlIGl0IGV4aXN0cy5cbiAqXG4gKiBgRGVuby53cml0ZUZpbGUo4oCmLCB7IGNyZWF0ZU5ldzogdHJ1ZSB9KWAgY2Fubm90IGRvIHRoaXM6IGl0IGNyZWF0ZXMgdGhlXG4gKiBmaWxlIGFuZCB3cml0ZXMgdGhlIHJlY29yZCBpbiBzZXBhcmF0ZSBzeXNjYWxscywgbGVhdmluZyBhIHdpbmRvdyBpblxuICogd2hpY2ggdGhlIGxvY2sgZXhpc3RzIGJ1dCBuYW1lcyBub2JvZHkgKElzc3VlICMxMDc0KS4gYGxpbmsoMilgIGhhcyBub1xuICogc3VjaCB3aW5kb3cg4oCUIGl0IHB1Ymxpc2hlcyBhIG5hbWUgZm9yIGEgZmlsZSB0aGF0IGlzIGFscmVhZHkgY29tcGxldGUsXG4gKiBhbmQgZmFpbHMgd2l0aCBgRUVYSVNUYCBhdG9taWNhbGx5IHdoZW4gdGhlIG5hbWUgaXMgdGFrZW4g4oCUIHNvIHRoZSB0d29cbiAqIHByb3BlcnRpZXMgdGhpcyBsb2NrIG5lZWRzLCBleGNsdXNpb24gYW5kIGEgbGVnaWJsZSBob2xkZXIsIGFycml2ZVxuICogdG9nZXRoZXIuXG4gKlxuICogVGhlIHRlbXAgZmlsZSBpcyBhIHNpYmxpbmcgYmVjYXVzZSBhIGhhcmQgbGluayBjYW5ub3QgY3Jvc3MgZmlsZXN5c3RlbXMuXG4gKiBBIHByb2Nlc3Mga2lsbGVkIGJldHdlZW4gdGhlIHdyaXRlIGFuZCB0aGUgdW5saW5rIGxlYXZlcyBvbmUgYmVoaW5kO1xuICoge0BsaW5rIHN3ZWVwU3RhbGVUZW1wc30gY2xlYXJzIHRob3NlLCBzaW5jZSBhIGtpbGwgaXMgdGhlIG9yZGluYXJ5IGNhc2VcbiAqIGhlcmUgYW5kIGFuIGF1ZGl0IGRpcmVjdG9yeSB0aGF0IGZpbGxzIHdpdGggZGVicmlzIGlzIGl0cyBvd24gcHJvYmxlbS5cbiAqXG4gKiBAcGFyYW0gbG9ja1BhdGggLSBMb2NrIGZpbGUgdG8gcHVibGlzaDsgaXRzIGRpcmVjdG9yeSBtdXN0IGFscmVhZHkgZXhpc3RcbiAqIEBwYXJhbSBwYXlsb2FkIC0gRW5jb2RlZCB7QGxpbmsgTG9ja1JlY29yZH0gdG8gcHVibGlzaCB3aXRoIGl0XG4gKiBAdGhyb3dzIHtEZW5vLmVycm9ycy5BbHJlYWR5RXhpc3RzfSBXaGVuIHRoZSBsb2NrIGlzIGhlbGRcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY3JlYXRlTG9ja0F0b21pY2FsbHkoXG4gIGxvY2tQYXRoOiBzdHJpbmcsXG4gIHBheWxvYWQ6IFVpbnQ4QXJyYXksXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGVtcCA9IGAke2xvY2tQYXRofS4ke2NyeXB0by5yYW5kb21VVUlEKCl9LnRtcGA7XG4gIGF3YWl0IERlbm8ud3JpdGVGaWxlKHRlbXAsIHBheWxvYWQsIHsgY3JlYXRlTmV3OiB0cnVlIH0pO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ubGluayh0ZW1wLCBsb2NrUGF0aCk7XG4gIH0gZmluYWxseSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKHRlbXApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gVGhlIGxpbmsgZWl0aGVyIGxhbmRlZCBvciBkaWQgbm90OyBhIGxlZnRvdmVyIHNpYmxpbmcgd291bGQgYmVcbiAgICAgIC8vIG5vaXNlLCBub3QgYSBsb2NrLCBhbmQgbXVzdCBub3QgbWFzayB0aGUgb3V0Y29tZSBvZiB0aGUgbGluay5cbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBSZW1vdmUgdGVtcCBzaWJsaW5ncyBzdHJhbmRlZCBieSBhIGtpbGwgbWlkLXB1YmxpY2F0aW9uLlxuICpcbiAqIFJ1biBvbmx5IHdoaWxlIGJyZWFraW5nIGFuIGFiYW5kb25lZCBsb2NrIOKAlCBhbHJlYWR5IHRoZSBcImNsZWFuIHVwIGFmdGVyXG4gKiBhIGtpbGxcIiBtb21lbnQsIGFuZCByYXJlIOKAlCBhbmQgb25seSBmb3Igc2libGluZ3Mgb2xkZXIgdGhhbiB0aGUgc3RhbGVcbiAqIGFnZSwgc28gYSB0ZW1wIGZpbGUgYmVsb25naW5nIHRvIGFuIGFjcXVpc2l0aW9uIGluIGZsaWdodCBpcyBuZXZlclxuICogdG91Y2hlZC4gRmFpbHVyZXMgYXJlIGlnbm9yZWQgZGVsaWJlcmF0ZWx5OiB0aGlzIGlzIHRpZHlpbmcsIGFuZCBpdCBtdXN0XG4gKiBub3Qgc3RvcCB0aGUgYnJlYWsgaXQgcmlkZXMgYWxvbmcgd2l0aC5cbiAqXG4gKiBAcGFyYW0gbG9ja1BhdGggLSBMb2NrIGZpbGUgd2hvc2Ugc2libGluZ3MgdG8gc3dlZXBcbiAqIEBwYXJhbSBzdGFsZU1zIC0gQWdlIHBhc3Qgd2hpY2ggYSB0ZW1wIGZpbGUgaXMgY2VydGFpbmx5IGFiYW5kb25lZFxuICogQHBhcmFtIG5vdyAtIENsb2NrIHNlYW1cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc3dlZXBTdGFsZVRlbXBzKFxuICBsb2NrUGF0aDogc3RyaW5nLFxuICBzdGFsZU1zOiBudW1iZXIsXG4gIG5vdzogKCkgPT4gbnVtYmVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNsYXNoID0gbG9ja1BhdGgubGFzdEluZGV4T2YoXCIvXCIpO1xuICBjb25zdCBkaXIgPSBzbGFzaCA9PT0gLTEgPyBcIi5cIiA6IGxvY2tQYXRoLnNsaWNlKDAsIHNsYXNoKTtcbiAgY29uc3QgcHJlZml4ID0gYCR7bG9ja1BhdGguc2xpY2Uoc2xhc2ggKyAxKX0uYDtcbiAgdHJ5IHtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIERlbm8ucmVhZERpcihkaXIpKSB7XG4gICAgICBpZiAoIWVudHJ5LmlzRmlsZSkgY29udGludWU7XG4gICAgICBpZiAoIWVudHJ5Lm5hbWUuc3RhcnRzV2l0aChwcmVmaXgpIHx8ICFlbnRyeS5uYW1lLmVuZHNXaXRoKFwiLnRtcFwiKSkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IGAke2Rpcn0vJHtlbnRyeS5uYW1lfWA7XG4gICAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KGNhbmRpZGF0ZSk7XG4gICAgICBpZiAobm93KCkgLSAoc3RhdC5tdGltZT8uZ2V0VGltZSgpID8/IG5vdygpKSA8IHN0YWxlTXMpIGNvbnRpbnVlO1xuICAgICAgYXdhaXQgRGVuby5yZW1vdmUoY2FuZGlkYXRlKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIFRpZHlpbmcgb25seS4gVGhlIGJyZWFrIGl0c2VsZiBpcyB3aGF0IG1hdHRlcnMgaGVyZS5cbiAgfVxufVxuXG4vKipcbiAqIFJ1biBgZm5gIHdoaWxlIGhvbGRpbmcgYW4gZXhjbHVzaXZlIGNyb3NzLXByb2Nlc3MgbG9jayBhdCBgbG9ja1BhdGhgLlxuICpcbiAqIFRoZSBsb2NrIGlzIHJlbGVhc2VkIHdoZXRoZXIgYGZuYCByZXNvbHZlcyBvciB0aHJvd3MuIEEgbG9jayB0aGlzIGNhbGxcbiAqIGRpZCBub3QgdGFrZSAoYmVjYXVzZSBhbiBhYmFuZG9uZWQtbG9jayBicmVhayBoYW5kZWQgaXQgdG8gc29tZW9uZSBlbHNlKVxuICogaXMgbmV2ZXIgcmVsZWFzZWQgYnkgdGhpcyBjYWxsLlxuICpcbiAqIEBwYXJhbSBsb2NrUGF0aCAtIExvY2sgZmlsZSB0byBjcmVhdGU7IGl0cyBkaXJlY3RvcnkgbXVzdCBhbHJlYWR5IGV4aXN0XG4gKiBAcGFyYW0gZm4gLSBXb3JrIHRvIHJ1biB1bmRlciB0aGUgbG9ja1xuICogQHBhcmFtIG9wdGlvbnMgLSBUaW1lb3V0LCBzdGFsZW5lc3MgYW5kIHBvbGwgdHVuaW5nXG4gKiBAcmV0dXJucyBXaGF0ZXZlciBgZm5gIHJldHVybnNcbiAqIEB0aHJvd3Mge0ZpbGVMb2NrVGltZW91dEVycm9yfSBXaGVuIHRoZSBsb2NrIGlzIHN0aWxsIGhlbGQgYXQgdGltZW91dFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2l0aEZpbGVMb2NrPFQ+KFxuICBsb2NrUGF0aDogc3RyaW5nLFxuICBmbjogKCkgPT4gUHJvbWlzZTxUPixcbiAgb3B0aW9uczogRmlsZUxvY2tPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFQ+IHtcbiAgY29uc3QgdGltZW91dE1zID0gb3B0aW9ucy50aW1lb3V0TXMgPz8gREVGQVVMVF9USU1FT1VUX01TO1xuICBjb25zdCBzdGFsZU1zID0gb3B0aW9ucy5zdGFsZU1zID8/IERFRkFVTFRfU1RBTEVfTVM7XG4gIGNvbnN0IHBvbGxNcyA9IG9wdGlvbnMucG9sbE1zID8/IERFRkFVTFRfUE9MTF9NUztcbiAgY29uc3Qgbm93ID0gb3B0aW9ucy5ub3cgPz8gKCgpID0+IERhdGUubm93KCkpO1xuXG4gIGNvbnN0IHRva2VuID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgY29uc3QgcmVjb3JkOiBMb2NrUmVjb3JkID0ge1xuICAgIHRva2VuLFxuICAgIHBpZDogRGVuby5waWQsXG4gICAgYWNxdWlyZWRBdDogbmV3IERhdGUobm93KCkpLnRvSVNPU3RyaW5nKCksXG4gICAgaG9zdDogb3duZXJIb3N0KCksXG4gIH07XG4gIGNvbnN0IHBheWxvYWQgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG5cbiAgY29uc3QgZGVhZGxpbmUgPSBub3coKSArIHRpbWVvdXRNcztcbiAgY29uc3QgcHJvYmUgPSB7IHByb2JlZDogZmFsc2UgfTtcbiAgbGV0IGhlbGQgPSBmYWxzZTtcbiAgZm9yICg7Oykge1xuICAgIHRyeSB7XG4gICAgICAvLyBQdWJsaXNoZWQgY29tcGxldGUsIG5vdCBjcmVhdGVkIGFuZCB0aGVuIGZpbGxlZCAoSXNzdWUgIzEwNzQpOlxuICAgICAgLy8gYSBsb2NrIGZpbGUgdGhhdCBleGlzdHMgYnV0IG5hbWVzIG5vYm9keSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgICAgLy8gZnJvbSBhIGxpdmUgaG9sZGVyIG1pZC13cml0ZSwgYW5kIGFjdGluZyBvbiB0aGF0IGd1ZXNzIGlzIHdoYXRcbiAgICAgIC8vIHB1dCB0d28gd3JpdGVycyBpbiBvbmUgam91cm5hbC5cbiAgICAgIGF3YWl0IGNyZWF0ZUxvY2tBdG9taWNhbGx5KGxvY2tQYXRoLCBwYXlsb2FkKTtcbiAgICAgIGhlbGQgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIGlmICghKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuQWxyZWFkeUV4aXN0cykpIHRocm93IGVycm9yO1xuICAgIH1cblxuICAgIGlmIChhd2FpdCBicmVha0lmQWJhbmRvbmVkKGxvY2tQYXRoLCBzdGFsZU1zLCBub3csIHByb2JlKSkgY29udGludWU7XG5cbiAgICBpZiAobm93KCkgPj0gZGVhZGxpbmUpIHtcbiAgICAgIGNvbnN0IGhvbGRlciA9IGF3YWl0IHJlYWRSZWNvcmQobG9ja1BhdGgpO1xuICAgICAgdGhyb3cgbmV3IEZpbGVMb2NrVGltZW91dEVycm9yKFxuICAgICAgICBsb2NrUGF0aCxcbiAgICAgICAgdGltZW91dE1zLFxuICAgICAgICBob2xkZXJcbiAgICAgICAgICA/IGBwaWQgJHtob2xkZXIucGlkfSBzaW5jZSAke2hvbGRlci5hY3F1aXJlZEF0fWBcbiAgICAgICAgICA6IFwiYW4gdW5rbm93biBwcm9jZXNzXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBhd2FpdCBzbGVlcChwb2xsTXMpO1xuICB9XG5cbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZm4oKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAoaGVsZCkge1xuICAgICAgLy8gT25seSByZWxlYXNlIGEgbG9jayB3ZSBzdGlsbCBob2xkOiBpZiBvdXJzIHdhcyBicm9rZW4gYXMgYWJhbmRvbmVkXG4gICAgICAvLyBhbmQgcmV0YWtlbiwgcmVtb3ZpbmcgaXQgd291bGQgZXZpY3QgaXRzIG5ldyBvd25lci5cbiAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCByZWFkUmVjb3JkKGxvY2tQYXRoKTtcbiAgICAgIGlmIChjdXJyZW50ID09PSBudWxsIHx8IGN1cnJlbnQudG9rZW4gPT09IHRva2VuKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgRGVuby5yZW1vdmUobG9ja1BhdGgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvLyBBbHJlYWR5IGdvbmUuIE5vdGhpbmcgdG8gcmVsZWFzZS5cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTBFQyxHQUVELFNBQ0Usd0JBQXdCLEVBQ3hCLHFCQUFxQixRQUNoQiwwQkFBMEI7QUFFakMsNEVBQTRFLEdBQzVFLE1BQU0sd0JBQXdCO0FBRTlCLHVEQUF1RCxHQUN2RCxPQUFPLE1BQU0scUJBQXFCLE9BQU87QUFFekM7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0sbUJB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
// denoCacheMetadata=17841783918750255558,13208161169733352152