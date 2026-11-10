/**
 * Tamper-evident audit journal for worker GitHub mutations (Issue #2380).
 *
 * Implements the highest-impact "Tamper-proof audit log" improvements from
 * docs/AGENT-ACCOUNTABILITY.md (Theme 1): an append-only, hash-chained
 * journal of every GitHub mutation the worker performs. Each entry records
 * the action, target, outcome and caller, and is linked to the previous
 * entry by a SHA-256 chain so that any single-entry corruption (or a
 * deleted interior entry) is detectable on verification.
 *
 * The journal lives OUTSIDE any repo working tree — under `VIBE_AUDIT_DIR`
 * when set, otherwise `${WORK_DIR}/audit/` — so a bug in the worker that
 * rewrites a repo's history cannot rewrite the history of its own audit log.
 * `VIBE_AUDIT_DIR` must be an absolute path with no `..` segment (see
 * {@link resolveBaseDir}). Files are partitioned per worker and per UTC day:
 *   `<audit directory>/audit-<workerId>-YYYY-MM-DD.jsonl`
 * where `<audit directory>` is `VIBE_AUDIT_DIR` or `${WORK_DIR}/audit`.
 *
 * The chain alone only detects interior edits, so every append also
 * updates a **chain anchor** (`audit_anchor.ts`) holding the record count
 * and head hash outside the journal file. Truncating the tail, deleting
 * the journal, rewriting an anchored entry, or appending past the anchored
 * head all break the anchor and are reported loud — never absorbed as a
 * fresh chain (Issues #3712, #3949).
 *
 * The anchor still cannot expose a journal deleted **together with** its
 * anchor, nor `rm -rf` of the audit directory, so every anchored journal is
 * also recorded in an append-only **roster** stored as a sibling of the
 * audit directory (`${dir}.roster.jsonl`, Issue #3949). The sweep treats a
 * rostered journal with neither file nor anchor on disk — and a missing
 * directory with a non-empty roster — as broken, not as an empty sweep.
 * A last-known-non-empty marker beside the roster (Issue #270) also
 * treats complete erasure of the journal directory **and** the roster as
 * a broken chain.
 *
 * Concurrency: appends to a given file are serialised through an
 * in-process async mutex so the hash chain stays consistent even when many
 * mutations are recorded concurrently. Cross-worker concurrency is avoided
 * by partitioning the filename on the worker id (each worker owns its own
 * chain).
 *
 * Crash safety: the line and the anchor are two files, so every append is
 * declared in the anchor before it is made and settled by
 * `audit_append_recovery.ts` on the next run (Issue #1074). A killed
 * writer therefore leaves a chain that heals back to its last confirmed
 * position, while an undeclared tail — the forged-tail shape — stays as
 * broken as it ever was.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { acknowledgeRosterDamage, acknowledgeRosterLoss, addToRoster, anchorPath, journalNameForAnchor, readAnchor, readRosterContents, rosterPath, rosterWasSeen, writeAnchor } from "./audit_anchor.ts";
import { formatAppendRecovery, settleInterruptedAppend } from "./audit_append_recovery.ts";
import { formatRosterRecovery, settleTornRosterLine } from "./audit_roster_recovery.ts";
import { computeEntryHash } from "./audit_entry.ts";
import { processEnvLookup } from "./env_lookup.ts";
import { ensureStateDir, sharedTmpStateDir } from "./private_cache_dir.ts";
import { withFileLock } from "./file_lock.ts";
// Entry shape and chain hashing live in `audit_entry.ts` since Issue #1074
// so the crash-recovery module can hash an entry without importing this
// one. Re-exported here: this module stays the front door.
export { computeEntryHash };
/**
 * Raised when the journal on disk disagrees with its chain anchor —
 * truncation, deletion, an anchored-entry rewrite, or a missing anchor
 * beside an existing journal. Never absorbed as a fresh chain.
 */ export class AuditChainAnchorError extends Error {
  /**
   * Is this damage the kind a fresh segment should be started beside
   * (Issue #361)?
   *
   * True for a journal that exists and disagrees with its anchor —
   * truncated, rewritten, carrying a torn line, or appended past the
   * anchored head. Those cannot be repaired without destroying evidence,
   * and until now they stopped journalling on that host dead: every later
   * mutation logged `[SECURITY] [AUDIT_JOURNAL_REFUSED]` and went
   * unrecorded, so damage to yesterday's evidence quietly cost all of
   * today's.
   *
   * False for a journal with **no anchor at all** — a pre-#3712 chain
   * awaiting `audit-chain-verify --adopt`. Rolling that over would strand
   * the very journal the operator is about to adopt.
   */ quarantinable;
  constructor(message, quarantinable = true){
    super(message);
    this.name = "AuditChainAnchorError";
    this.quarantinable = quarantinable;
  }
}
/** In-process per-key write queue keeping this process's appends serial. */ const writeQueues = new Map();
/**
 * Chain state is deliberately **not** cached (Issue #491).
 *
 * The previous implementation kept a `Map<path, ChainState>` seeded on
 * first use and never re-read it. Under a second writer — a child `deno`
 * command inheriting `VIBE_RUN_ID`, or a concurrent run — the cached head
 * went stale the moment the other process appended, and the next append
 * chained onto an entry that was no longer the tail. Reading the head from
 * disk inside the lock costs one read of a file that holds a few hundred
 * lines, which is nothing beside getting the chain wrong.
 */ /** Today's UTC date as `YYYY-MM-DD`. */ function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
/** Sanitise a worker id for safe use in a filename. */ function sanitiseWorkerId(id) {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "worker";
}
/**
 * Resolve the default audit base directory from the environment.
 *
 * @param override - Explicit directory, used verbatim when supplied.
 * @param env - Environment lookup for the `VIBE_AUDIT_DIR`, `WORK_DIR` and
 *   `TMPDIR` fallback (Issue #963). Defaults to the real process environment.
 */ export function resolveBaseDir(override, env = processEnvLookup) {
  if (override) return override;
  const auditDir = env("VIBE_AUDIT_DIR");
  if (auditDir) {
    if (!auditDir.startsWith("/") || auditDir.split("/").includes("..")) {
      throw new Error("VIBE_AUDIT_DIR must be an absolute path without a '..' segment");
    }
    return auditDir;
  }
  const workDir = env("WORK_DIR");
  if (workDir) return `${workDir}/audit`;
  // Issue #1242: per-account, not the fixed `${TMPDIR}/vibe-audit` every
  // account on the host shared — the journal is the tamper-evident record of
  // the worker's own mutations.
  return sharedTmpStateDir("vibe-audit", env);
}
/**
 * Resolve the worker partition id from the environment.
 *
 * The partition is **per worker, not per process** (Issue #491). Every
 * process on a host — the run driver and every child `deno` command it
 * spawns — deliberately shares one journal, so the trail reads in the
 * order the mutations actually happened rather than being scattered across
 * a file per pid. Concurrency safety therefore comes from the directory
 * lock in `recordMutation`, never from the filename: `WORKER_UNIQUE_ID` is
 * a deployment seam for running two workers against one volume, and is
 * unset on the standard single-worker host, which is why journals there
 * are named `audit-worker-<date>.jsonl`.
 */ export function resolveWorkerId(override, env = processEnvLookup) {
  if (override) return sanitiseWorkerId(override);
  const id = env("WORKER_UNIQUE_ID") ?? env("WORKER_NAME") ?? "worker";
  return sanitiseWorkerId(id);
}
/**
 * Resolve the run-correlation id from the environment (joins to #2381).
 *
 * @param env - Environment lookup (Issue #963). Defaults to the real process
 *   environment, so production callers pass nothing.
 */ export function resolveRunId(env = processEnvLookup) {
  return env("VIBE_RUN_ID") ?? env("WORKER_UNIQUE_ID") ?? "unknown";
}
/** Build the journal file path for the given partition. */ export function auditFilePath(opts = {}) {
  const env = opts.env ?? processEnvLookup;
  const baseDir = resolveBaseDir(opts.baseDir, env);
  const workerId = resolveWorkerId(opts.workerId, env);
  const date = opts.date ?? todayUtc();
  return `${baseDir}/audit-${workerId}-${date}.jsonl`;
}
/**
 * Queue `fn` behind this process's other callers for `key`.
 *
 * **This is not a lock.** It is a chain of promises in a module-level
 * `Map`, so it orders callers inside one Deno process and is invisible to
 * every other process on the host — which is precisely how 10 of 14
 * journals on GRQ-23 ended up with orphaned head hashes (Issue #491).
 * Exclusion across processes is {@link withFileLock}'s job; this stays
 * only as a fast path, so concurrent callers in one process wait on a
 * promise rather than spinning on the lock file.
 */ function withLock(key, fn) {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  // Chain regardless of whether the previous task resolved or rejected.
  const next = prev.then(fn, fn);
  // Swallow rejection on the stored tail so it never becomes unhandled.
  writeQueues.set(key, next.then(()=>{}, ()=>{}));
  return next;
}
/**
 * Lock file guarding every append to one audit directory (Issue #491).
 *
 * Directory-wide rather than per-journal, because journal *selection* is
 * itself part of the critical section: `resolveWritableJournal` decides
 * which segment to write to by reading chain state, and two writers making
 * that decision concurrently is the same race as two writers appending
 * concurrently. Held for the length of one append — a read, a hash and two
 * small writes — so a single lock costs nothing at the rate mutations
 * actually occur.
 *
 * The name is dot-prefixed and does not match the `audit-*.jsonl` pattern
 * `verifyAllChains` sweeps, so it is never mistaken for a journal.
 */ function auditLockPath(baseDir) {
  return `${baseDir}/.audit-append.lock`;
}
/** Read a journal's non-empty lines, or `null` when the file is absent. */ async function readJournalLines(path) {
  try {
    const content = await Deno.readTextFile(path);
    return content.split("\n").filter((l)=>l.trim().length > 0);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}
/** Hash of the entry at `index`, or null when it is absent/unparseable. */ function hashAt(lines, index) {
  const line = lines[index];
  if (!line) return null;
  try {
    return JSON.parse(line).hash ?? null;
  } catch  {
    return null;
  }
}
/**
 * Cross-check a journal against its anchor and return the chain position.
 *
 * Throws {@link AuditChainAnchorError} whenever the two disagree — the
 * journal is shorter than the anchor (truncation), the anchored entry no
 * longer carries the anchored hash (rewrite), the journal has vanished
 * while its anchor survives (deletion), or a journal exists with no anchor
 * at all (anchor removed, or a pre-#3712 journal awaiting `adoptAnchor`).
 */ function reconcile(path, anchor, lines) {
  if (lines === null) {
    if (anchor && anchor.count > 0) {
      throw new AuditChainAnchorError(`audit journal deleted: ${path} is missing but its anchor records ` + `${anchor.count} entries`);
    }
    return {
      count: 0,
      headHash: ""
    };
  }
  if (!anchor) {
    throw new AuditChainAnchorError(`audit journal has no chain anchor: ${path} — the anchor at ` + `${anchorPath(path)} is missing. Adopt the existing chain with ` + `\`deno task audit-chain-verify --adopt\` once it has been reviewed.`, false);
  }
  if (lines.length < anchor.count) {
    throw new AuditChainAnchorError(`audit journal truncated: ${path} holds ${lines.length} entries but ` + `its anchor records ${anchor.count}`);
  }
  // Issue #3949: a longer journal is as suspect as a shorter one. Extending
  // it here would re-anchor on the next append, laundering a forged tail
  // into the anchor.
  if (lines.length > anchor.count) {
    throw new AuditChainAnchorError(`audit journal has entries appended past the anchor: ${path} holds ` + `${lines.length} entries but its anchor records ${anchor.count}`);
  }
  if (anchor.count > 0 && hashAt(lines, anchor.count - 1) !== anchor.headHash) {
    throw new AuditChainAnchorError(`audit journal rewritten: ${path} entry ${anchor.count - 1} no longer ` + `carries the anchored head hash`);
  }
  const headHash = lines.length > 0 ? hashAt(lines, lines.length - 1) ?? "" : "";
  return {
    count: lines.length,
    headHash
  };
}
/**
 * Chain position for a path, read from disk and its anchor every time.
 *
 * Callers must hold the directory lock (Issue #491): the value is only
 * true for as long as no other process appends, so reading it outside the
 * lock and writing on the strength of it is the original bug.
 */ /**
 * Has an operator signed for this journal's current damage?
 *
 * Mirrors the sweep's `damageAcknowledgements` guard for the append path
 * (Issue #1074). A signature covers the exact bytes it was given, so a
 * journal whose acknowledgement no longer matches its digest is *not*
 * protected — that is the alarm coming back, and healing is the lesser
 * concern at that point.
 *
 * @param path - Journal file path
 * @returns true when a current acknowledgement covers these exact bytes
 */ async function damageIsAcknowledged(path) {
  const baseDir = path.slice(0, path.lastIndexOf("/")) || ".";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const damage = (await readRosterContents(baseDir)).damaged.get(name);
  if (!damage) return false;
  const digest = await journalDigest(path);
  return digest.ok && digest.value === damage.digest;
}
async function getChainState(path) {
  try {
    return reconcile(path, await readAnchor(path), await readJournalLines(path));
  } catch (error) {
    if (!(error instanceof AuditChainAnchorError)) throw error;
    // Issue #1074: a journal that disagrees with its anchor may simply be
    // one the previous process did not live long enough to confirm. Settle
    // that here — inside the lock, and only for a journal that has already
    // failed — before quarantining it. A journal that settles nothing
    // keeps its original error, so nothing is repaired on the strength of
    // a second look.
    //
    // Except one an operator has already signed for. The sweep refuses to
    // heal those because the signature is pinned to the journal's exact
    // bytes, and repairing them would lapse it; the guarantee is worth
    // nothing if the *write* path quietly does what the sweep declines to,
    // so the same check stands on both.
    if (await damageIsAcknowledged(path)) throw error;
    const settled = await settleInterruptedAppend(path);
    if (!settled.ok) {
      // Loud, and the original verdict stands — exactly as on the sweep.
      // Replacing it with the recovery's own error would also replace a
      // *quarantinable* failure with one that is not, and the caller
      // quarantines on that flag: the journal would stop taking writes
      // altogether and the mutation would go unrecorded, which is a
      // worse outcome than the damage that triggered it.
      console.error(`[SECURITY] [AUDIT_APPEND_RECOVERY_FAILED] ${path}: an interrupted ` + `append could not be settled: ${settled.error.message}`);
      throw error;
    }
    if (!settled.value) throw error;
    console.error(formatAppendRecovery(settled.value));
    return reconcile(path, await readAnchor(path), await readJournalLines(path));
  }
}
/**
 * Append a hash-chained entry recording a single GitHub mutation.
 *
 * Best-effort by contract: returns a Result rather than throwing so a
 * journalling failure never aborts the mutation it is recording.
 *
 * @param mutation - The mutation to record
 * @param opts - Storage location overrides (mainly for tests)
 * @returns Result with the persisted entry, or an error on IO failure
 */ export async function recordMutation(mutation, opts = {}) {
  try {
    const env = opts.env ?? processEnvLookup;
    const baseDir = resolveBaseDir(opts.baseDir, env);
    // Issue #1242: a journal directory under the shared temporary root is
    // created 0700 and refused when another account owns it. Appending a
    // hash-chained entry to a directory a local user controls would make the
    // audit trail evidence of nothing; failing here is reported through the
    // Result the caller already handles. The same injected lookup decides
    // what "shared temporary root" means (Issue #1604): the agent-side gh
    // guard journals from a child with no `--allow-env`, so it hands in a
    // lookup that answers nothing rather than one that would throw.
    const trust = await ensureStateDir(baseDir, env);
    if (!trust.trusted) {
      throw new Error(`Audit directory ${baseDir} is not worker-private: ${trust.reason ?? "unknown"}`);
    }
    // Issue #491: journal selection and the append are one critical
    // section, guarded across processes. The in-process queue wraps the
    // file lock so same-process callers wait on a promise instead of
    // spinning on the lock file.
    const entry = await withLock(baseDir, ()=>withFileLock(auditLockPath(baseDir), async ()=>{
        const path = await resolveWritableJournal(auditFilePath(opts));
        return await appendEntry(path, mutation);
      }));
    return {
      ok: true,
      value: entry
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
/** Append one chained, anchored, rostered entry to `path`. */ async function appendEntry(path, mutation) {
  const baseDir = path.slice(0, path.lastIndexOf("/")) || ".";
  const state = await getChainState(path);
  const timestamp = mutation.timestamp ?? new Date().toISOString();
  const payload = {
    ...mutation,
    timestamp
  };
  const hash = await computeEntryHash(payload, state.headHash);
  const full = {
    ...payload,
    prevHash: state.headHash,
    hash
  };
  // Issue #1074: declare the append before making it. The line and the
  // anchor are two files and cannot be written atomically, so the writer
  // records which entry is in flight; a process killed anywhere after
  // this leaves evidence of what it was doing, and the next run finishes
  // or rolls back the append instead of demanding a human signature.
  const declared = await writeAnchor(path, {
    count: state.count,
    headHash: state.headHash,
    pending: {
      hash,
      startedAt: timestamp
    }
  });
  if (!declared.ok) {
    throw new AuditChainAnchorError(`audit entry could not be declared before the append: ` + declared.error.message);
  }
  await Deno.writeTextFile(path, `${JSON.stringify(full)}\n`, {
    append: true
  });
  const next = {
    count: state.count + 1,
    headHash: hash
  };
  const anchored = await writeAnchor(path, next);
  if (!anchored.ok) {
    // Fail loud (Issue #3234): an un-anchored append leaves the chain
    // unverifiable, so the caller must see the failure.
    throw new AuditChainAnchorError(`audit entry appended but its anchor could not be written: ` + anchored.error.message);
  }
  // Issue #3949: record the journal in the expected-journal roster so a
  // later deletion of the journal together with its anchor (or of the
  // whole audit directory) is a broken chain, not an empty sweep.
  const rostered = await addToRoster(baseDir, path.slice(path.lastIndexOf("/") + 1));
  if (!rostered.ok) {
    throw new AuditChainAnchorError(`audit entry appended but the journal roster could not be ` + `updated: ${rostered.error.message}`);
  }
  return full;
}
/** Verb recorded as the first entry of a segment opened beside damage. */ export const AUDIT_JOURNAL_QUARANTINED_VERB = "audit-journal-quarantined";
/** Segment suffix for the nth journal opened beside a damaged one. */ function segmentPath(basePath, n) {
  return `${basePath.replace(/\.jsonl$/, "")}.s${n}.jsonl`;
}
/**
 * The journal this process should append to (Issue #361).
 *
 * Normally the day's journal. When that journal exists but disagrees with
 * its anchor, it is **quarantined**: left exactly as it is — evidence is
 * never repaired or deleted — and a fresh segment is opened beside it,
 * `audit-<worker>-<date>.s1.jsonl`, whose first entry records what was
 * quarantined and why.
 *
 * The alternative, which is what happened on host GRQ-23 on 2026-08-25, is
 * that one torn line at entry 31 stopped the trail dead: every subsequent
 * `gh` and `git` mutation logged `[SECURITY] [AUDIT_JOURNAL_REFUSED]` and
 * went unrecorded, for the rest of the host's life, while the worker
 * carried on mutating GitHub. Damage to yesterday's evidence must not cost
 * today's — an audit trail that stops recording when it is damaged is
 * precisely the wrong failure direction.
 *
 * Nothing is laundered by this. The damaged journal keeps its own anchor,
 * stays on the roster, and keeps failing `audit-chain-verify` exactly as
 * loudly as before — a forged tail is never re-anchored, because the file
 * carrying it is never written to again.
 */ async function resolveWritableJournal(basePath) {
  let damaged = null;
  // Bounded: a host that has quarantined 100 segments in one day has a
  // problem no further segment is going to help with, and an unbounded
  // walk would spin.
  for(let n = 0; n <= 100; n++){
    const path = n === 0 ? basePath : segmentPath(basePath, n);
    try {
      const state = await getChainState(path);
      // Note the quarantine once, when the segment is opened. Every later
      // process re-detects the same damage on its way past; repeating the
      // note would bury the segment's real content under duplicates.
      if (damaged && state.count === 0) await noteQuarantine(path, damaged);
      return path;
    } catch (error) {
      if (!(error instanceof AuditChainAnchorError) || !error.quarantinable) {
        throw error;
      }
      if (!damaged) damaged = {
        path,
        reason: error.message
      };
    }
  }
  throw new AuditChainAnchorError(`audit journal cannot be opened: ${basePath} and 100 segments beside it ` + `all disagree with their anchors`);
}
/**
 * Open a quarantine segment by recording what was displaced, loudly.
 *
 * The note is the segment's first chained entry, so "why does this host
 * have a `.s1` journal" is answerable from the trail itself rather than
 * from whoever happened to read the console that day.
 */ async function noteQuarantine(segment, damaged) {
  console.error(`[SECURITY] [AUDIT_JOURNAL_QUARANTINED] ${damaged.path}: ${damaged.reason} ` + `— left intact as evidence and still failing the sweep; recording ` + `continues in ${segment}`);
  // Already inside the directory lock (Issue #491): re-entering it here
  // would deadlock, and the note is part of the same critical section.
  await appendEntry(segment, {
    runId: resolveRunId(),
    verb: AUDIT_JOURNAL_QUARANTINED_VERB,
    target: damaged.path.slice(damaged.path.lastIndexOf("/") + 1),
    outcome: "error",
    caller: damaged.reason
  });
}
/**
 * Load every entry from a journal file in order.
 *
 * @param path - Journal file path
 * @returns Result with the parsed entries, or an error on IO failure
 */ export async function loadEntries(path) {
  let content;
  try {
    content = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        ok: false,
        error: new Error(`Audit journal not found: ${path}`)
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
  const entries = [];
  const lines = content.split("\n");
  for (const line of lines){
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch  {
      return {
        ok: false,
        error: new Error(`Malformed journal line: ${line}`)
      };
    }
  }
  return {
    ok: true,
    value: entries
  };
}
/**
 * Verify a journal file's hash chain end-to-end, and cross-check it
 * against its chain anchor.
 *
 * Returns `ok: false` only for IO failures the anchor cannot explain (an
 * unreadable directory, say). A broken chain — including a truncated tail,
 * a deleted journal, or a missing anchor — returns `ok: true` with
 * `valid: false` and a reason, so callers can distinguish "could not read"
 * from "read and tampered".
 *
 * @param path - Journal file path
 */ export async function verifyChain(path) {
  let anchor;
  try {
    anchor = await readAnchor(path);
  } catch (error) {
    return {
      ok: true,
      value: {
        valid: false,
        count: 0,
        reason: error instanceof Error ? error.message : String(error)
      }
    };
  }
  let content;
  try {
    content = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // An anchor that records no entries *and* declares an append is
      // what a writer killed before its first line leaves behind (Issue
      // #1074): it anchors nothing, so there is nothing to be missing.
      // Without the declaration it is still a deletion, and still red.
      //
      // The anchor alone cannot carry that verdict, because it is plain
      // JSON an attacker may rewrite: "delete the journal, then declare
      // it empty and in-flight" would launder an erasure into a clean
      // sweep. The roster is the independent witness (Issue #3949) —
      // `addToRoster` runs only *after* an append has landed, so a
      // journal that was never successfully written to is absent from it,
      // while one that ever held an entry is on it for good. A missing
      // journal that the roster expects is a deletion, whatever its
      // anchor says.
      if (anchor && anchor.count === 0 && anchor.pending) {
        const baseDir = path.slice(0, path.lastIndexOf("/")) || ".";
        const name = path.slice(path.lastIndexOf("/") + 1);
        let expected;
        try {
          expected = (await readRosterContents(baseDir)).journals.includes(name);
        } catch (error) {
          // A corrupted roster is a tamper signal, never a silent pass.
          return {
            ok: false,
            error: error instanceof Error ? error : new Error(String(error))
          };
        }
        if (!expected) {
          return {
            ok: true,
            value: {
              valid: true,
              count: 0
            }
          };
        }
      }
      if (anchor) {
        return {
          ok: true,
          value: {
            valid: false,
            count: 0,
            reason: `journal deleted — anchor records ${anchor.count} entries with ` + `head ${anchor.headHash.slice(0, 12)}`
          }
        };
      }
      return {
        ok: false,
        error: new Error(`Audit journal not found: ${path}`)
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
  const lines = content.split("\n").filter((l)=>l.trim().length > 0);
  let prev = "";
  for(let i = 0; i < lines.length; i++){
    const line = lines[i];
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch  {
      return {
        ok: true,
        value: {
          valid: false,
          count: lines.length,
          brokenIndex: i,
          reason: "malformed JSON"
        }
      };
    }
    if (entry.prevHash !== prev) {
      return {
        ok: true,
        value: {
          valid: false,
          count: lines.length,
          brokenIndex: i,
          reason: "prevHash linkage mismatch"
        }
      };
    }
    const expected = await computeEntryHash(entry, prev);
    if (expected !== entry.hash) {
      return {
        ok: true,
        value: {
          valid: false,
          count: lines.length,
          brokenIndex: i,
          reason: "hash mismatch"
        }
      };
    }
    prev = entry.hash;
  }
  // The chain is internally consistent — now check what the chain alone
  // cannot see: a truncated tail, or an anchor that was removed with it.
  if (!anchor) {
    return {
      ok: true,
      value: {
        valid: false,
        count: lines.length,
        reason: `chain anchor missing: ${anchorPath(path)}`
      }
    };
  }
  if (lines.length < anchor.count) {
    return {
      ok: true,
      value: {
        valid: false,
        count: lines.length,
        brokenIndex: lines.length,
        reason: `journal truncated — ${lines.length} entries present, anchor ` + `records ${anchor.count}`
      }
    };
  }
  // Issue #3949: the anchor is the only truth for where the chain ends. A
  // correctly-chained entry appended after the anchored head previously
  // verified clean; it is unanchored content and must be reported.
  if (lines.length > anchor.count) {
    return {
      ok: true,
      value: {
        valid: false,
        count: lines.length,
        brokenIndex: anchor.count,
        reason: `entries appended past the anchor — ${lines.length} entries ` + `present, anchor records ${anchor.count}`
      }
    };
  }
  if (anchor.count > 0 && hashAt(lines, anchor.count - 1) !== anchor.headHash) {
    return {
      ok: true,
      value: {
        valid: false,
        count: lines.length,
        brokenIndex: anchor.count - 1,
        reason: "anchor head hash mismatch"
      }
    };
  }
  return {
    ok: true,
    value: {
      valid: true,
      count: lines.length
    }
  };
}
/**
 * Adopt the current contents of a journal as its chain anchor.
 *
 * Explicit operator action, needed once for a journal written before the
 * anchor existed (or after an anchor was lost). The journal's own chain
 * must verify first, so a tampered file can never be blessed by adoption.
 *
 * @param path - Journal file path
 * @returns Result carrying the written anchor
 */ export async function adoptAnchor(path) {
  const lines = await readJournalLines(path).catch(()=>null);
  if (lines === null) {
    return {
      ok: false,
      error: new Error(`Audit journal not found: ${path}`)
    };
  }
  // Walk the chain itself before trusting it. verifyChain would fail on
  // the (expected) missing anchor, so the linkage is re-walked here.
  let prev = "";
  for(let i = 0; i < lines.length; i++){
    const line = lines[i];
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch  {
      return {
        ok: false,
        error: new Error(`cannot adopt ${path}: malformed JSON at entry ${i}`)
      };
    }
    if (entry.prevHash !== prev) {
      return {
        ok: false,
        error: new Error(`cannot adopt ${path}: prevHash linkage mismatch at entry ${i}`)
      };
    }
    if (await computeEntryHash(entry, prev) !== entry.hash) {
      return {
        ok: false,
        error: new Error(`cannot adopt ${path}: hash mismatch at entry ${i}`)
      };
    }
    prev = entry.hash;
  }
  const written = await writeAnchor(path, {
    count: lines.length,
    headHash: prev
  });
  if (!written.ok) return written;
  // No cache to invalidate since Issue #491: the next append reads the
  // freshly written anchor from disk.
  // Issue #3949: an adopted journal is an expected journal from here on.
  const slash = path.lastIndexOf("/");
  const rostered = await addToRoster(slash > -1 ? path.slice(0, slash) : ".", path.slice(slash + 1));
  if (!rostered.ok) {
    return {
      ok: false,
      error: new Error(`anchor adopted but the journal roster could not be updated: ` + rostered.error.message)
    };
  }
  return written;
}
/**
 * Verb recorded in the chain when damage to a present journal is signed
 * for (Issue #491).
 *
 * Greppable in the journal itself, and in every downstream consumer of the
 * audit trail, so "who silenced which alarm" is answerable from the chain
 * rather than from a sidecar alone.
 */ export const AUDIT_DAMAGE_ACKNOWLEDGED_VERB = "audit-damage-acknowledged";
/**
 * SHA-256 of a journal's bytes, with its entry count.
 *
 * The digest covers the whole file, not the chain, so it changes on any
 * edit at all — including one that leaves the chain just as broken.
 */ async function journalDigest(path) {
  try {
    const bytes = await Deno.readFile(path);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      ok: true,
      value: Array.from(new Uint8Array(digest)).map((b)=>b.toString(16).padStart(2, "0")).join("")
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
/**
 * Sign for a journal that is present but does not verify (Issue #491).
 *
 * The cross-process append race left ten journals on GRQ-23 with an
 * orphaned head hash. Fixing the writer stops new damage; it cannot repair
 * the existing files, and repairing them is the last thing anyone should
 * want — they are the evidence. But `--acknowledge-loss` refuses them by
 * design (only a journal that is genuinely *gone* can be signed for), so
 * the host was left with a permanent `[SECURITY]` alarm and no documented
 * way out. An alarm that can never be cleared is an alarm nobody reads,
 * which is the failure Issue #359 already identified for losses.
 *
 * This is the exit for damage, and it is narrower than the loss path:
 *
 *   - the journal must be **on disk** — a missing journal is a loss, and
 *     `acknowledgeJournalLoss` is where that is signed for,
 *   - it must **actually fail** verification. A journal that verifies has
 *     nothing to sign for, and accepting one would let an operator
 *     pre-sign a file they were about to damage,
 *   - a **reason** and an **operator identity** are required,
 *   - the signature is **pinned to the journal's exact bytes**. The sweep
 *     honours it only while the file still hashes to the recorded digest,
 *     so this closes today's finding without blessing tomorrow's edit,
 *   - and the act is written into the hash chain **first**, in the
 *     currently-writable journal, so who silenced what is itself chained.
 *
 * The damaged journal is never modified, re-anchored, or removed.
 *
 * @param params - Which journal, why, and on whose authority
 * @param opts - Storage overrides for the chained record (mainly tests)
 * @returns Result carrying the persisted acknowledgement
 */ export async function acknowledgeJournalDamage(params, opts = {}) {
  const { baseDir, journalName, reason, by } = params;
  const path = `${baseDir}/${journalName}`;
  // Issue #1202: every write below eventually appends to the roster, so a
  // roster torn by a kill would block this exit before it began. Repair
  // that one shape first; any other unreadable roster still fails loud.
  const healed = await healRoster(baseDir);
  if (!healed.ok) return {
    ok: false,
    error: healed.error
  };
  if (!await pathExists(path)) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge damage to ${journalName}: it is not on ` + `disk — a journal that is gone is a loss, signed for with ` + `--acknowledge-loss, not damage`)
    };
  }
  const verified = await verifyChain(path);
  if (verified.ok && verified.value.valid) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge damage to ${journalName}: its chain ` + `verifies — there is nothing to sign for, and a signature taken ` + `now would cover damage that has not happened yet`)
    };
  }
  const digest = await journalDigest(path);
  if (!digest.ok) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge damage to ${journalName}: its bytes could ` + `not be read, so the signature could not be pinned to them: ` + `${digest.error.message}`)
    };
  }
  const entries = verified.ok ? verified.value.count : 0;
  // The chain record comes first, as it does for a loss: a failure here
  // leaves the alarm sounding, which is the safe direction to fail in.
  const recorded = await recordMutation({
    runId: resolveRunId(),
    verb: AUDIT_DAMAGE_ACKNOWLEDGED_VERB,
    target: journalName,
    outcome: "success",
    caller: `${by}: ${reason}`
  }, {
    ...opts,
    baseDir
  });
  if (!recorded.ok) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge damage to ${journalName}: the ` + `acknowledgement could not be recorded in the audit chain, so it ` + `will not be recorded in the roster either: ` + `${recorded.error.message}`)
    };
  }
  return await acknowledgeRosterDamage(baseDir, journalName, reason, by, digest.value, entries);
}
/**
 * Verb recorded in the chain when a journal loss is signed for (Issue
 * #359). See {@link AUDIT_DAMAGE_ACKNOWLEDGED_VERB} for the damage
 * counterpart — the two are deliberately distinct verbs.
 */ export const AUDIT_LOSS_ACKNOWLEDGED_VERB = "audit-loss-acknowledged";
/**
 * Sign for a journal that is genuinely gone (Issue #359).
 *
 * Issue #337 had the work-volume housekeeping prune the worker's own audit
 * directory. That bug is fixed, but the fix could only stop further losses —
 * on hosts already swept, the roster kept expecting three journals that no
 * longer exist, so `audit-chain-verify` failed on every worker start, for
 * ever. The only exits were a human editing the tamper-evidence file by hand
 * or rebuilding the container: teaching operators to hand-edit the roster
 * destroys the very witness it is there to be.
 *
 * This is the supported exit, and it is deliberately narrow:
 *
 *   - the journal must be **on the roster** — you cannot pre-acknowledge a
 *     journal that was never expected,
 *   - it must be **absent from disk**, journal and anchor both — a journal
 *     that is present but truncated, rewritten or hash-broken is never
 *     acknowledgeable and keeps failing the sweep exactly as before,
 *   - a **reason** and an **operator identity** are required,
 *   - and the act is written into the hash chain **first**. If the chain
 *     append fails, nothing is acknowledged and the alarm keeps sounding;
 *     the sidecar is never silenced without a chained record of who did it.
 *
 * It is not, and does not claim to be, unforgeable: a principal who can
 * append to the roster can already delete it, which trips the complete-
 * erasure alarm instead. What it changes is that an accounted-for loss stops
 * being an anonymous recurring alarm and becomes a dated, attributed,
 * reviewable record — so a *new* deletion on the same host is once again the
 * only red line in the sweep.
 *
 * @param params - Which journal, why, and on whose authority
 * @param opts - Storage overrides for the chained record (mainly tests)
 * @returns Result carrying the persisted acknowledgement
 */ export async function acknowledgeJournalLoss(params, opts = {}) {
  const { baseDir, journalName, reason, by } = params;
  let rostered;
  try {
    // Issue #1202: a roster torn by a kill would otherwise block this exit
    // outright — it is read here and appended to below — leaving no way out
    // but hand-editing the tamper-evidence file.
    rostered = (await readRosterHealed(baseDir)).contents.journals;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
  if (!rostered.includes(journalName)) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge ${journalName}: it is not on the roster for ` + `${baseDir}, so nothing expects it`)
    };
  }
  const journalThere = await pathExists(`${baseDir}/${journalName}`);
  const anchorThere = await pathExists(anchorPath(`${baseDir}/${journalName}`));
  if (journalThere || anchorThere) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge ${journalName}: it is still on disk ` + `(${journalThere ? "journal" : "anchor"} present) — only a journal ` + `that is genuinely gone can be signed for, never one whose chain ` + `simply does not verify`)
    };
  }
  // The chain record comes first, deliberately. A failure here leaves the
  // alarm sounding, which is the safe direction to fail in.
  const recorded = await recordMutation({
    runId: resolveRunId(),
    verb: AUDIT_LOSS_ACKNOWLEDGED_VERB,
    target: journalName,
    outcome: "success",
    caller: `${by}: ${reason}`
  }, {
    ...opts,
    baseDir
  });
  if (!recorded.ok) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge ${journalName}: the acknowledgement could ` + `not be recorded in the audit chain, so it will not be recorded ` + `in the roster either: ${recorded.error.message}`)
    };
  }
  return await acknowledgeRosterLoss(baseDir, journalName, reason, by);
}
/**
 * Settle an interrupted append while holding the audit-directory lock.
 *
 * The sweep does not otherwise take the lock, but the recovery rewrites
 * the anchor and may truncate the journal, so it must not run beside a
 * live appender (Issue #491's rule applies to every writer, including
 * this one).
 *
 * @param baseDir - Audit directory holding the journal and its lock
 * @param path - Journal to settle
 * @returns Result carrying the recovery performed, or `null` when there
 *   was nothing to settle
 */ async function settleAppendUnderLock(baseDir, path) {
  try {
    return await withFileLock(auditLockPath(baseDir), ()=>settleInterruptedAppend(path));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
/**
 * Settle a torn roster line while holding the audit-directory lock.
 *
 * The lock lives *inside* the audit directory while the roster lives
 * beside it, so a directory that has been removed has no lock to take —
 * and no appender to exclude either, since every roster writer creates the
 * directory before it writes. The repair then runs directly, and refuses
 * to truncate a roster that grew underneath it.
 *
 * @param baseDir - Audit directory the roster covers
 * @returns Result carrying the repair performed, or `null` when there was
 *   nothing to settle
 */ async function settleRosterUnderLock(baseDir) {
  try {
    if (!await pathExists(baseDir)) return await settleTornRosterLine(baseDir);
    return await withFileLock(auditLockPath(baseDir), ()=>settleTornRosterLine(baseDir));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
/**
 * Read the roster, repairing a torn final line first if that is what is
 * wrong with it (Issue #1202).
 *
 * Every reader of the roster that a torn line locks out goes through here:
 * the sweep, and both acknowledgement exits. A roster that fails for any
 * other reason keeps its original error — nothing is repaired on the
 * strength of a second look.
 *
 * @param baseDir - Audit directory the roster covers
 * @returns The roster contents, plus the repair performed to read them
 * @throws The original read error when no repair applied, or the second
 *   read's error when a repair did not make the roster readable
 */ async function readRosterHealed(baseDir) {
  try {
    return {
      contents: await readRosterContents(baseDir),
      repaired: null
    };
  } catch (error) {
    const settled = await settleRosterUnderLock(baseDir);
    if (!settled.ok) {
      // Loud, and the original verdict stands: the roster is still
      // unreadable for its original reason. Silence here would read as
      // "nothing to settle".
      console.error(`[SECURITY] [AUDIT_ROSTER_RECOVERY_FAILED] ${rosterPath(baseDir)}: a ` + `torn roster line could not be settled: ${settled.error.message}`);
      throw error;
    }
    if (!settled.value) throw error;
    console.error(formatRosterRecovery(settled.value));
    return {
      contents: await readRosterContents(baseDir),
      repaired: settled.value
    };
  }
}
/**
 * Repair a torn roster line before a writer needs the roster (Issue #1202).
 *
 * @param baseDir - Audit directory the roster covers
 * @returns Result; ok when the roster is readable (already or after the
 *   repair), an error carrying the original read failure otherwise
 */ async function healRoster(baseDir) {
  try {
    await readRosterHealed(baseDir);
    return {
      ok: true,
      value: undefined
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
/** Does `path` exist? Any stat error other than absence is propagated up. */ async function pathExists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
/** Sweep verdict for complete erasure of the journal directory and roster. */ function completeErasureSweep(dir, rosterRepaired) {
  return {
    ok: true,
    value: {
      baseDir: dir,
      checked: 1,
      acknowledged: [],
      recovered: [],
      ...rosterRepaired ? {
        rosterRepaired
      } : {},
      broken: [
        {
          path: dir,
          valid: false,
          count: 0,
          reason: "audit directory and roster are both missing but a last-known-non-empty marker records that journals existed — complete erasure"
        }
      ]
    }
  };
}
/** Journal filename contract shared by the verifier and evidence consumers. */ export function isAuditJournalName(name) {
  return /^audit-.*\.jsonl$/.test(name);
}
/**
 * Verify every audit chain under `baseDir` — the scheduled sweep.
 *
 * Anchors are enumerated alongside journals so a journal that was deleted
 * outright is still inspected (and flagged) rather than simply vanishing
 * from the sweep. The expected-journal roster (Issue #3949) — persisted as
 * a sibling of the audit directory — is folded in as well, so a journal
 * deleted **together with** its anchor, or an `rm -rf` of the whole audit
 * directory, is a broken chain rather than an empty sweep. A last-known-
 * non-empty marker (Issue #270) covers the remaining hole: deleting the
 * directory **and** the roster together.
 *
 * @param baseDir - Audit directory (default: resolved from the environment)
 * @param options.recoverInterruptedAppends - Defaults to `true` for the
 *   scheduled sweep; reporting passes `false` so verification never writes.
 * @returns Result carrying the sweep verdict; an absent directory is a
 *   clean, empty sweep only when nothing was ever observed
 */ export async function verifyAllChains(baseDir, options = {}) {
  const dir = resolveBaseDir(baseDir);
  const journalsOnDisk = new Set();
  const anchorsOnDisk = new Set();
  let rostered;
  let acknowledgements;
  let damageAcknowledgements;
  let seen;
  // Issue #1202: a roster whose final line was torn by a kill is repaired
  // here, before it can fail the whole directory's sweep. Only that one
  // shape is repaired; every other unreadable roster still fails loud.
  let rosterRepaired;
  try {
    const recover = options.recoverInterruptedAppends !== false;
    const healed = recover ? await readRosterHealed(dir) : {
      contents: await readRosterContents(dir),
      repaired: null
    };
    rosterRepaired = healed.repaired ?? undefined;
    const contents = healed.contents;
    rostered = contents.journals;
    acknowledgements = contents.acknowledged;
    damageAcknowledgements = contents.damaged;
    seen = await rosterWasSeen(dir);
  } catch (error) {
    // A corrupted roster or seen-marker is a tamper signal in its own right.
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
  let dirMissing = false;
  try {
    for await (const item of Deno.readDir(dir)){
      if (item.isFile && isAuditJournalName(item.name)) {
        journalsOnDisk.add(item.name);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
    // Issue #3949: an absent directory is a clean, empty sweep only when
    // nothing was ever journalled. When the roster expects journals, the
    // directory's removal is the tampering, not a fresh start.
    // Issue #270: a missing roster after a previously observed non-empty
    // one is the same erasure, not a first-ever start.
    if (rostered.length === 0) {
      if (seen) return completeErasureSweep(dir, rosterRepaired);
      return {
        ok: true,
        value: {
          baseDir: dir,
          checked: 0,
          broken: [],
          acknowledged: [],
          recovered: [],
          ...rosterRepaired ? {
            rosterRepaired
          } : {}
        }
      };
    }
    dirMissing = true;
  }
  if (!dirMissing) {
    try {
      for await (const item of Deno.readDir(`${dir}/anchors`)){
        if (!item.isFile) continue;
        const journal = journalNameForAnchor(item.name);
        if (journal) anchorsOnDisk.add(journal);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        return {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    }
  }
  const names = new Set([
    ...journalsOnDisk,
    ...anchorsOnDisk,
    ...rostered
  ]);
  // Issue #270: directory present but empty of journals/anchors, roster
  // gone, marker still there — the same complete erasure as a missing dir.
  if (names.size === 0 && seen) {
    return completeErasureSweep(dir, rosterRepaired);
  }
  const broken = [];
  const acknowledged = [];
  const recovered = [];
  for (const name of [
    ...names
  ].sort()){
    const path = `${dir}/${name}`;
    // Rostered with neither journal nor anchor left on disk: the pair was
    // deleted together (or the directory removed), which is exactly the
    // erasure the roster exists to expose (Issue #3949).
    if (!journalsOnDisk.has(name) && !anchorsOnDisk.has(name)) {
      // Issue #359: unless the loss has been signed for. Then it is a
      // closed finding — still reported on every sweep, no longer failing
      // it. Only *this* shape of breakage is acknowledgeable: a journal
      // that is present but truncated, rewritten, or hash-broken falls
      // through to `verifyChain` below and can never be silenced.
      const ack = acknowledgements.get(name);
      if (ack) {
        acknowledged.push({
          path,
          kind: "loss",
          acknowledgement: ack
        });
        continue;
      }
      broken.push({
        path,
        valid: false,
        count: 0,
        reason: dirMissing ? `audit directory missing but the roster records this journal — ` + `directory deleted` : `journal and its anchor are both missing but the roster records ` + `this journal — pair deleted`
      });
      continue;
    }
    // Issue #1074: a journal that fails only because the writer was killed
    // mid-append is settled here — the sweep runs first at every worker
    // start, so a host that was killed verifies clean on its next run
    // rather than asking an operator to sign for the kill. Only journals
    // that already fail are touched, and only past the anchored head.
    //
    // A journal an operator has already signed for is left alone: the
    // signature is pinned to its exact bytes, so healing it would lapse
    // the signature the operator gave and turn a closed finding back into
    // a red one.
    let result = await verifyChain(path);
    if (options.recoverInterruptedAppends !== false && result.ok && !result.value.valid && !dirMissing && !damageAcknowledgements.has(name)) {
      const settled = await settleAppendUnderLock(dir, path);
      if (!settled.ok) {
        // Loud, and the original verdict stands: the journal is still
        // broken for its original reason and still carries the remedy
        // that names it. Silence here would read as "nothing to settle".
        console.error(`[SECURITY] [AUDIT_APPEND_RECOVERY_FAILED] ${path}: an ` + `interrupted append could not be settled: ${settled.error.message}`);
      } else if (settled.value) {
        recovered.push(settled.value);
        result = await verifyChain(path);
      }
    }
    if (!result.ok) {
      broken.push({
        path,
        valid: false,
        count: 0,
        reason: result.error.message
      });
      continue;
    }
    if (result.value.valid) continue;
    // Issue #491: a journal that is present but does not verify can be
    // signed for — but only against the exact bytes that were shown to
    // the operator. If the file has changed since, the signature no
    // longer covers it and the alarm comes back, naming why.
    const damage = damageAcknowledgements.get(name);
    if (damage) {
      const current = await journalDigest(path);
      if (current.ok && current.value === damage.digest) {
        acknowledged.push({
          path,
          kind: "damage",
          acknowledgement: damage
        });
        continue;
      }
      broken.push({
        path,
        ...result.value,
        reason: `${result.value.reason ?? "chain does not verify"} — the ` + `damage acknowledgement signed by ${damage.by} on ` + `${damage.acknowledgedAt} no longer applies: the journal has ` + `changed since it was signed for`
      });
      continue;
    }
    broken.push({
      path,
      ...result.value
    });
  }
  return {
    ok: true,
    value: {
      baseDir: dir,
      checked: names.size,
      broken,
      acknowledged,
      recovered,
      ...rosterRepaired ? {
        rosterRepaired
      } : {}
    }
  };
}
/**
 * Reset in-process state. Test-only helper.
 *
 * Since Issue #491 there is no chain-state cache to clear — the head is
 * read from disk on every append — so this only drops the write queues.
 */ export function _resetAuditCaches() {
  writeQueues.clear();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hdWRpdF9qb3VybmFsLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGFtcGVyLWV2aWRlbnQgYXVkaXQgam91cm5hbCBmb3Igd29ya2VyIEdpdEh1YiBtdXRhdGlvbnMgKElzc3VlICMyMzgwKS5cbiAqXG4gKiBJbXBsZW1lbnRzIHRoZSBoaWdoZXN0LWltcGFjdCBcIlRhbXBlci1wcm9vZiBhdWRpdCBsb2dcIiBpbXByb3ZlbWVudHMgZnJvbVxuICogZG9jcy9BR0VOVC1BQ0NPVU5UQUJJTElUWS5tZCAoVGhlbWUgMSk6IGFuIGFwcGVuZC1vbmx5LCBoYXNoLWNoYWluZWRcbiAqIGpvdXJuYWwgb2YgZXZlcnkgR2l0SHViIG11dGF0aW9uIHRoZSB3b3JrZXIgcGVyZm9ybXMuIEVhY2ggZW50cnkgcmVjb3Jkc1xuICogdGhlIGFjdGlvbiwgdGFyZ2V0LCBvdXRjb21lIGFuZCBjYWxsZXIsIGFuZCBpcyBsaW5rZWQgdG8gdGhlIHByZXZpb3VzXG4gKiBlbnRyeSBieSBhIFNIQS0yNTYgY2hhaW4gc28gdGhhdCBhbnkgc2luZ2xlLWVudHJ5IGNvcnJ1cHRpb24gKG9yIGFcbiAqIGRlbGV0ZWQgaW50ZXJpb3IgZW50cnkpIGlzIGRldGVjdGFibGUgb24gdmVyaWZpY2F0aW9uLlxuICpcbiAqIFRoZSBqb3VybmFsIGxpdmVzIE9VVFNJREUgYW55IHJlcG8gd29ya2luZyB0cmVlIOKAlCB1bmRlciBgVklCRV9BVURJVF9ESVJgXG4gKiB3aGVuIHNldCwgb3RoZXJ3aXNlIGAke1dPUktfRElSfS9hdWRpdC9gIOKAlCBzbyBhIGJ1ZyBpbiB0aGUgd29ya2VyIHRoYXRcbiAqIHJld3JpdGVzIGEgcmVwbydzIGhpc3RvcnkgY2Fubm90IHJld3JpdGUgdGhlIGhpc3Rvcnkgb2YgaXRzIG93biBhdWRpdCBsb2cuXG4gKiBgVklCRV9BVURJVF9ESVJgIG11c3QgYmUgYW4gYWJzb2x1dGUgcGF0aCB3aXRoIG5vIGAuLmAgc2VnbWVudCAoc2VlXG4gKiB7QGxpbmsgcmVzb2x2ZUJhc2VEaXJ9KS4gRmlsZXMgYXJlIHBhcnRpdGlvbmVkIHBlciB3b3JrZXIgYW5kIHBlciBVVEMgZGF5OlxuICogICBgPGF1ZGl0IGRpcmVjdG9yeT4vYXVkaXQtPHdvcmtlcklkPi1ZWVlZLU1NLURELmpzb25sYFxuICogd2hlcmUgYDxhdWRpdCBkaXJlY3Rvcnk+YCBpcyBgVklCRV9BVURJVF9ESVJgIG9yIGAke1dPUktfRElSfS9hdWRpdGAuXG4gKlxuICogVGhlIGNoYWluIGFsb25lIG9ubHkgZGV0ZWN0cyBpbnRlcmlvciBlZGl0cywgc28gZXZlcnkgYXBwZW5kIGFsc29cbiAqIHVwZGF0ZXMgYSAqKmNoYWluIGFuY2hvcioqIChgYXVkaXRfYW5jaG9yLnRzYCkgaG9sZGluZyB0aGUgcmVjb3JkIGNvdW50XG4gKiBhbmQgaGVhZCBoYXNoIG91dHNpZGUgdGhlIGpvdXJuYWwgZmlsZS4gVHJ1bmNhdGluZyB0aGUgdGFpbCwgZGVsZXRpbmdcbiAqIHRoZSBqb3VybmFsLCByZXdyaXRpbmcgYW4gYW5jaG9yZWQgZW50cnksIG9yIGFwcGVuZGluZyBwYXN0IHRoZSBhbmNob3JlZFxuICogaGVhZCBhbGwgYnJlYWsgdGhlIGFuY2hvciBhbmQgYXJlIHJlcG9ydGVkIGxvdWQg4oCUIG5ldmVyIGFic29yYmVkIGFzIGFcbiAqIGZyZXNoIGNoYWluIChJc3N1ZXMgIzM3MTIsICMzOTQ5KS5cbiAqXG4gKiBUaGUgYW5jaG9yIHN0aWxsIGNhbm5vdCBleHBvc2UgYSBqb3VybmFsIGRlbGV0ZWQgKip0b2dldGhlciB3aXRoKiogaXRzXG4gKiBhbmNob3IsIG5vciBgcm0gLXJmYCBvZiB0aGUgYXVkaXQgZGlyZWN0b3J5LCBzbyBldmVyeSBhbmNob3JlZCBqb3VybmFsIGlzXG4gKiBhbHNvIHJlY29yZGVkIGluIGFuIGFwcGVuZC1vbmx5ICoqcm9zdGVyKiogc3RvcmVkIGFzIGEgc2libGluZyBvZiB0aGVcbiAqIGF1ZGl0IGRpcmVjdG9yeSAoYCR7ZGlyfS5yb3N0ZXIuanNvbmxgLCBJc3N1ZSAjMzk0OSkuIFRoZSBzd2VlcCB0cmVhdHMgYVxuICogcm9zdGVyZWQgam91cm5hbCB3aXRoIG5laXRoZXIgZmlsZSBub3IgYW5jaG9yIG9uIGRpc2sg4oCUIGFuZCBhIG1pc3NpbmdcbiAqIGRpcmVjdG9yeSB3aXRoIGEgbm9uLWVtcHR5IHJvc3RlciDigJQgYXMgYnJva2VuLCBub3QgYXMgYW4gZW1wdHkgc3dlZXAuXG4gKiBBIGxhc3Qta25vd24tbm9uLWVtcHR5IG1hcmtlciBiZXNpZGUgdGhlIHJvc3RlciAoSXNzdWUgIzI3MCkgYWxzb1xuICogdHJlYXRzIGNvbXBsZXRlIGVyYXN1cmUgb2YgdGhlIGpvdXJuYWwgZGlyZWN0b3J5ICoqYW5kKiogdGhlIHJvc3RlciBhc1xuICogYSBicm9rZW4gY2hhaW4uXG4gKlxuICogQ29uY3VycmVuY3k6IGFwcGVuZHMgdG8gYSBnaXZlbiBmaWxlIGFyZSBzZXJpYWxpc2VkIHRocm91Z2ggYW5cbiAqIGluLXByb2Nlc3MgYXN5bmMgbXV0ZXggc28gdGhlIGhhc2ggY2hhaW4gc3RheXMgY29uc2lzdGVudCBldmVuIHdoZW4gbWFueVxuICogbXV0YXRpb25zIGFyZSByZWNvcmRlZCBjb25jdXJyZW50bHkuIENyb3NzLXdvcmtlciBjb25jdXJyZW5jeSBpcyBhdm9pZGVkXG4gKiBieSBwYXJ0aXRpb25pbmcgdGhlIGZpbGVuYW1lIG9uIHRoZSB3b3JrZXIgaWQgKGVhY2ggd29ya2VyIG93bnMgaXRzIG93blxuICogY2hhaW4pLlxuICpcbiAqIENyYXNoIHNhZmV0eTogdGhlIGxpbmUgYW5kIHRoZSBhbmNob3IgYXJlIHR3byBmaWxlcywgc28gZXZlcnkgYXBwZW5kIGlzXG4gKiBkZWNsYXJlZCBpbiB0aGUgYW5jaG9yIGJlZm9yZSBpdCBpcyBtYWRlIGFuZCBzZXR0bGVkIGJ5XG4gKiBgYXVkaXRfYXBwZW5kX3JlY292ZXJ5LnRzYCBvbiB0aGUgbmV4dCBydW4gKElzc3VlICMxMDc0KS4gQSBraWxsZWRcbiAqIHdyaXRlciB0aGVyZWZvcmUgbGVhdmVzIGEgY2hhaW4gdGhhdCBoZWFscyBiYWNrIHRvIGl0cyBsYXN0IGNvbmZpcm1lZFxuICogcG9zaXRpb24sIHdoaWxlIGFuIHVuZGVjbGFyZWQgdGFpbCDigJQgdGhlIGZvcmdlZC10YWlsIHNoYXBlIOKAlCBzdGF5cyBhc1xuICogYnJva2VuIGFzIGl0IGV2ZXIgd2FzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQge1xuICBhY2tub3dsZWRnZVJvc3RlckRhbWFnZSxcbiAgYWNrbm93bGVkZ2VSb3N0ZXJMb3NzLFxuICBhZGRUb1Jvc3RlcixcbiAgYW5jaG9yUGF0aCxcbiAgdHlwZSBDaGFpbkFuY2hvcixcbiAgam91cm5hbE5hbWVGb3JBbmNob3IsXG4gIHJlYWRBbmNob3IsXG4gIHJlYWRSb3N0ZXJDb250ZW50cyxcbiAgdHlwZSBSb3N0ZXJBY2tub3dsZWRnZW1lbnQsXG4gIHR5cGUgUm9zdGVyQ29udGVudHMsXG4gIHR5cGUgUm9zdGVyRGFtYWdlQWNrbm93bGVkZ2VtZW50LFxuICByb3N0ZXJQYXRoLFxuICByb3N0ZXJXYXNTZWVuLFxuICB3cml0ZUFuY2hvcixcbn0gZnJvbSBcIi4vYXVkaXRfYW5jaG9yLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEFwcGVuZFJlY292ZXJ5LFxuICBmb3JtYXRBcHBlbmRSZWNvdmVyeSxcbiAgc2V0dGxlSW50ZXJydXB0ZWRBcHBlbmQsXG59IGZyb20gXCIuL2F1ZGl0X2FwcGVuZF9yZWNvdmVyeS50c1wiO1xuaW1wb3J0IHtcbiAgZm9ybWF0Um9zdGVyUmVjb3ZlcnksXG4gIHR5cGUgUm9zdGVyUmVjb3ZlcnksXG4gIHNldHRsZVRvcm5Sb3N0ZXJMaW5lLFxufSBmcm9tIFwiLi9hdWRpdF9yb3N0ZXJfcmVjb3ZlcnkudHNcIjtcbmltcG9ydCB7XG4gIHR5cGUgQXVkaXRFbnRyeSxcbiAgdHlwZSBBdWRpdE11dGF0aW9uLFxuICB0eXBlIEF1ZGl0T3V0Y29tZSxcbiAgY29tcHV0ZUVudHJ5SGFzaCxcbn0gZnJvbSBcIi4vYXVkaXRfZW50cnkudHNcIjtcbmltcG9ydCB7IHR5cGUgRW52TG9va3VwLCBwcm9jZXNzRW52TG9va3VwIH0gZnJvbSBcIi4vZW52X2xvb2t1cC50c1wiO1xuaW1wb3J0IHsgZW5zdXJlU3RhdGVEaXIsIHNoYXJlZFRtcFN0YXRlRGlyIH0gZnJvbSBcIi4vcHJpdmF0ZV9jYWNoZV9kaXIudHNcIjtcbmltcG9ydCB7IHdpdGhGaWxlTG9jayB9IGZyb20gXCIuL2ZpbGVfbG9jay50c1wiO1xuXG4vLyBFbnRyeSBzaGFwZSBhbmQgY2hhaW4gaGFzaGluZyBsaXZlIGluIGBhdWRpdF9lbnRyeS50c2Agc2luY2UgSXNzdWUgIzEwNzRcbi8vIHNvIHRoZSBjcmFzaC1yZWNvdmVyeSBtb2R1bGUgY2FuIGhhc2ggYW4gZW50cnkgd2l0aG91dCBpbXBvcnRpbmcgdGhpc1xuLy8gb25lLiBSZS1leHBvcnRlZCBoZXJlOiB0aGlzIG1vZHVsZSBzdGF5cyB0aGUgZnJvbnQgZG9vci5cbmV4cG9ydCB7XG4gIHR5cGUgQXVkaXRFbnRyeSxcbiAgdHlwZSBBdWRpdE11dGF0aW9uLFxuICB0eXBlIEF1ZGl0T3V0Y29tZSxcbiAgY29tcHV0ZUVudHJ5SGFzaCxcbn07XG5leHBvcnQgdHlwZSB7IEFwcGVuZFJlY292ZXJ5LCBSb3N0ZXJSZWNvdmVyeSB9O1xuXG4vKipcbiAqIFJhaXNlZCB3aGVuIHRoZSBqb3VybmFsIG9uIGRpc2sgZGlzYWdyZWVzIHdpdGggaXRzIGNoYWluIGFuY2hvciDigJRcbiAqIHRydW5jYXRpb24sIGRlbGV0aW9uLCBhbiBhbmNob3JlZC1lbnRyeSByZXdyaXRlLCBvciBhIG1pc3NpbmcgYW5jaG9yXG4gKiBiZXNpZGUgYW4gZXhpc3Rpbmcgam91cm5hbC4gTmV2ZXIgYWJzb3JiZWQgYXMgYSBmcmVzaCBjaGFpbi5cbiAqL1xuZXhwb3J0IGNsYXNzIEF1ZGl0Q2hhaW5BbmNob3JFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgLyoqXG4gICAqIElzIHRoaXMgZGFtYWdlIHRoZSBraW5kIGEgZnJlc2ggc2VnbWVudCBzaG91bGQgYmUgc3RhcnRlZCBiZXNpZGVcbiAgICogKElzc3VlICMzNjEpP1xuICAgKlxuICAgKiBUcnVlIGZvciBhIGpvdXJuYWwgdGhhdCBleGlzdHMgYW5kIGRpc2FncmVlcyB3aXRoIGl0cyBhbmNob3Ig4oCUXG4gICAqIHRydW5jYXRlZCwgcmV3cml0dGVuLCBjYXJyeWluZyBhIHRvcm4gbGluZSwgb3IgYXBwZW5kZWQgcGFzdCB0aGVcbiAgICogYW5jaG9yZWQgaGVhZC4gVGhvc2UgY2Fubm90IGJlIHJlcGFpcmVkIHdpdGhvdXQgZGVzdHJveWluZyBldmlkZW5jZSxcbiAgICogYW5kIHVudGlsIG5vdyB0aGV5IHN0b3BwZWQgam91cm5hbGxpbmcgb24gdGhhdCBob3N0IGRlYWQ6IGV2ZXJ5IGxhdGVyXG4gICAqIG11dGF0aW9uIGxvZ2dlZCBgW1NFQ1VSSVRZXSBbQVVESVRfSk9VUk5BTF9SRUZVU0VEXWAgYW5kIHdlbnRcbiAgICogdW5yZWNvcmRlZCwgc28gZGFtYWdlIHRvIHllc3RlcmRheSdzIGV2aWRlbmNlIHF1aWV0bHkgY29zdCBhbGwgb2ZcbiAgICogdG9kYXkncy5cbiAgICpcbiAgICogRmFsc2UgZm9yIGEgam91cm5hbCB3aXRoICoqbm8gYW5jaG9yIGF0IGFsbCoqIOKAlCBhIHByZS0jMzcxMiBjaGFpblxuICAgKiBhd2FpdGluZyBgYXVkaXQtY2hhaW4tdmVyaWZ5IC0tYWRvcHRgLiBSb2xsaW5nIHRoYXQgb3ZlciB3b3VsZCBzdHJhbmRcbiAgICogdGhlIHZlcnkgam91cm5hbCB0aGUgb3BlcmF0b3IgaXMgYWJvdXQgdG8gYWRvcHQuXG4gICAqL1xuICByZWFkb25seSBxdWFyYW50aW5hYmxlOiBib29sZWFuO1xuXG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgcXVhcmFudGluYWJsZSA9IHRydWUpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkF1ZGl0Q2hhaW5BbmNob3JFcnJvclwiO1xuICAgIHRoaXMucXVhcmFudGluYWJsZSA9IHF1YXJhbnRpbmFibGU7XG4gIH1cbn1cblxuLyoqIE9wdGlvbnMgY29udHJvbGxpbmcgd2hlcmUgYW4gZW50cnkgaXMgd3JpdHRlbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVjb3JkT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBCYXNlIGRpcmVjdG9yeSBvdmVycmlkZSAoZGVmYXVsdDogYFZJQkVfQVVESVRfRElSYCB3aGVuIHNldCwgb3RoZXJ3aXNlXG4gICAqIGAke1dPUktfRElSfS9hdWRpdGApLlxuICAgKi9cbiAgYmFzZURpcj86IHN0cmluZztcbiAgLyoqIFdvcmtlciBwYXJ0aXRpb24gb3ZlcnJpZGUgKGRlZmF1bHQ6IHJlc29sdmVkIGZyb20gZW52KS4gKi9cbiAgd29ya2VySWQ/OiBzdHJpbmc7XG4gIC8qKiBVVEMgZGF0ZSBzdHJpbmcgb3ZlcnJpZGUgKGRlZmF1bHQ6IHRvZGF5LCBgWVlZWS1NTS1ERGApLiAqL1xuICBkYXRlPzogc3RyaW5nO1xuICAvKipcbiAgICogRW52aXJvbm1lbnQgbG9va3VwIGJlaGluZCB0aGUgYGJhc2VEaXJgL2B3b3JrZXJJZGAgZGVmYXVsdHMgKElzc3VlICM5NjMpLlxuICAgKlxuICAgKiBEZWZhdWx0cyB0byB0aGUgcmVhbCBwcm9jZXNzIGVudmlyb25tZW50LCBzbyBwcm9kdWN0aW9uIGNhbGxlcnMgcGFzc1xuICAgKiBub3RoaW5nLiBBIHRlc3QgaGFuZHMgb3ZlciBhIGZpeGVkIG1hcCBpbnN0ZWFkIG9mIHNldHRpbmcgYFdPUktfRElSYCBhbmRcbiAgICogYFdPUktFUl9VTklRVUVfSURgIG9uIHRoZSBwcm9jZXNzLCB3aGljaCByYWNlcyBldmVyeSBvdGhlciB0ZXN0IHJ1bm5pbmdcbiAgICogYXQgdGhhdCBtb21lbnQgKElzc3VlICM4ODApLlxuICAgKi9cbiAgZW52PzogRW52TG9va3VwO1xufVxuXG4vKiogUmVzdWx0IG9mIHZlcmlmeWluZyBhIGpvdXJuYWwgZmlsZSdzIGhhc2ggY2hhaW4uICovXG5leHBvcnQgaW50ZXJmYWNlIENoYWluVmVyaWZpY2F0aW9uIHtcbiAgLyoqIFRydWUgd2hlbiB0aGUgY2hhaW4gaXMgaW50YWN0IGVuZC10by1lbmQgQU5EIG1hdGNoZXMgaXRzIGFuY2hvci4gKi9cbiAgdmFsaWQ6IGJvb2xlYW47XG4gIC8qKiBOdW1iZXIgb2YgZW50cmllcyBpbnNwZWN0ZWQuICovXG4gIGNvdW50OiBudW1iZXI7XG4gIC8qKiBaZXJvLWJhc2VkIGluZGV4IG9mIHRoZSBmaXJzdCBicm9rZW4gZW50cnksIHdoZW4gaW52YWxpZC4gKi9cbiAgYnJva2VuSW5kZXg/OiBudW1iZXI7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSByZWFzb24gdGhlIGNoYWluIGZhaWxlZCwgd2hlbiBpbnZhbGlkLiAqL1xuICByZWFzb24/OiBzdHJpbmc7XG59XG5cbi8qKiBPbmUgam91cm5hbCdzIHZlcmRpY3Qgd2l0aGluIGEgZGlyZWN0b3J5LXdpZGUgc3dlZXAuICovXG5leHBvcnQgaW50ZXJmYWNlIENoYWluU3dlZXBFbnRyeSBleHRlbmRzIENoYWluVmVyaWZpY2F0aW9uIHtcbiAgLyoqIEpvdXJuYWwgZmlsZSBwYXRoIHRoaXMgdmVyZGljdCBiZWxvbmdzIHRvLiAqL1xuICBwYXRoOiBzdHJpbmc7XG59XG5cbi8qKiBSZXN1bHQgb2YgdmVyaWZ5aW5nIGV2ZXJ5IGNoYWluIHVuZGVyIGFuIGF1ZGl0IGRpcmVjdG9yeS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2hhaW5Td2VlcCB7XG4gIC8qKiBBdWRpdCBkaXJlY3Rvcnkgc3dlcHQuICovXG4gIGJhc2VEaXI6IHN0cmluZztcbiAgLyoqIE51bWJlciBvZiBqb3VybmFscyBpbnNwZWN0ZWQgKGpvdXJuYWxzIHBsdXMgb3JwaGFuZWQgYW5jaG9ycykuICovXG4gIGNoZWNrZWQ6IG51bWJlcjtcbiAgLyoqIEpvdXJuYWxzIHdob3NlIGNoYWluIG9yIGFuY2hvciBmYWlsZWQgdmVyaWZpY2F0aW9uLiAqL1xuICBicm9rZW46IENoYWluU3dlZXBFbnRyeVtdO1xuICAvKipcbiAgICogQXBwZW5kcyBzZXR0bGVkIGJ5IHRoaXMgc3dlZXAgKElzc3VlICMxMDc0KS5cbiAgICpcbiAgICogUmVwb3J0ZWQsIG5ldmVyIGEgZmFpbHVyZSBhbmQgbmV2ZXIgc2lsZW50OiBhbiBpbnRlcnJ1cHRlZCBhcHBlbmQgaXNcbiAgICogZXhwZWN0ZWQgb3BlcmF0aW9uYWwgZGFtYWdlIG9uIGEgaG9zdCB3aG9zZSBydW5zIGFyZSBraWxsZWQsIGFuZCB0aGVcbiAgICogY2hhaW4gaXMgb25seSBldmVyIHJlcGFpcmVkIGJhY2sgdG8gdGhlIHBvc2l0aW9uIGl0IHdhcyBsYXN0XG4gICAqIGNvbmZpcm1lZCBhdC5cbiAgICovXG4gIHJlY292ZXJlZDogQXBwZW5kUmVjb3ZlcnlbXTtcbiAgLyoqXG4gICAqIFRvcm4gcm9zdGVyIGxpbmUgZGlzY2FyZGVkIGJ5IHRoaXMgc3dlZXAgKElzc3VlICMxMjAyKS5cbiAgICpcbiAgICogQWJzZW50IG9uIGV2ZXJ5IHN3ZWVwIHRoYXQgcmVwYWlyZWQgbm90aGluZy4gUHJlc2VudCwgaXQgaXMgcmVwb3J0ZWRcbiAgICogYW5kIG5ldmVyIGEgZmFpbHVyZSDigJQgZm9yIHRoZSBzYW1lIHJlYXNvbiBhbiBpbnRlcnJ1cHRlZCBhcHBlbmQgaXM6XG4gICAqIHRoZSBieXRlcyBhIGtpbGwgbGVmdCBiZWhpbmQgd2VyZSBuZXZlciBhIGNvbXBsZXRlIHJvc3RlciBsaW5lLCBhbmRcbiAgICogdGhleSBhcmUgcHJlc2VydmVkIGJlc2lkZSB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGRlbGV0ZWQuXG4gICAqL1xuICByb3N0ZXJSZXBhaXJlZD86IFJvc3RlclJlY292ZXJ5O1xuICAvKipcbiAgICogSm91cm5hbHMgdGhhdCBhcmUgZ29uZSBhbmQgd2hvc2UgbG9zcyBoYXMgYmVlbiBzaWduZWQgZm9yIChJc3N1ZSAjMzU5KS5cbiAgICpcbiAgICogUmVwb3J0ZWQsIG5ldmVyIGhpZGRlbiDigJQgYnV0IG5vdCBhIGZhaWx1cmUuIEEgcGVybWFuZW50bHktcmVkIGludGVncml0eVxuICAgKiBhbGFybSBpcyBhIGJyb2tlbiBpbnRlZ3JpdHkgYWxhcm06IG9uY2UgYSBob3N0J3Mgc2VsZi1pbmZsaWN0ZWQgbG9zc2VzXG4gICAqIGFyZSBhbHdheXMgcHJlc2VudCwgYSBnZW51aW5lIGRlbGV0aW9uIGFycml2aW5nIGxhdGVyIGp1c3QgYWRkcyBhIGxpbmVcbiAgICogbm9ib2R5IHJlYWRzLlxuICAgKi9cbiAgYWNrbm93bGVkZ2VkOiBBY2tub3dsZWRnZWRMb3NzW107XG59XG5cbi8qKlxuICogT25lIGFjY291bnRlZC1mb3IgZmluZGluZyB3aXRoaW4gYSBzd2VlcC5cbiAqXG4gKiBFaXRoZXIgYSBqb3VybmFsIHRoYXQgaXMgZ29uZSBhbmQgd2hvc2UgbG9zcyB3YXMgc2lnbmVkIGZvciAoSXNzdWVcbiAqICMzNTkpLCBvciBvbmUgdGhhdCBpcyBwcmVzZW50IGJ1dCBkb2VzIG5vdCB2ZXJpZnkgYW5kIHdob3NlIGRhbWFnZSB3YXNcbiAqIHNpZ25lZCBmb3IgYWdhaW5zdCBpdHMgZXhhY3QgYnl0ZXMgKElzc3VlICM0OTEpLiBCb3RoIGFyZSByZXBvcnRlZCBvblxuICogZXZlcnkgc3dlZXAgYW5kIG5laXRoZXIgZmFpbHMgaXQ7IGBraW5kYCBzYXlzIHdoaWNoLCBiZWNhdXNlIFwid2UgZGVsZXRlZFxuICogdGhpc1wiIGFuZCBcInRoaXMgaXMgY29ycnVwdCBhbmQgd2Uga25vdyB3aHlcIiBhcmUgZGlmZmVyZW50IGFkbWlzc2lvbnMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQWNrbm93bGVkZ2VkTG9zcyB7XG4gIC8qKiBKb3VybmFsIGZpbGUgcGF0aCB0aGUgYWNrbm93bGVkZ2VtZW50IGNvdmVycy4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogV2hpY2ggYWRtaXNzaW9uIHRoaXMgaXMuICovXG4gIGtpbmQ6IFwibG9zc1wiIHwgXCJkYW1hZ2VcIjtcbiAgLyoqIFdoeSBpdCBpcyBhY2NvdW50ZWQgZm9yLCBhbmQgd2hvIHNpZ25lZCBmb3IgaXQuICovXG4gIGFja25vd2xlZGdlbWVudDogUm9zdGVyQWNrbm93bGVkZ2VtZW50IHwgUm9zdGVyRGFtYWdlQWNrbm93bGVkZ2VtZW50O1xufVxuXG4vKiogSW4tcHJvY2VzcyBwZXIta2V5IHdyaXRlIHF1ZXVlIGtlZXBpbmcgdGhpcyBwcm9jZXNzJ3MgYXBwZW5kcyBzZXJpYWwuICovXG5jb25zdCB3cml0ZVF1ZXVlcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPHVua25vd24+PigpO1xuXG4vKiogTGl2ZSBjaGFpbiBwb3NpdGlvbiBmb3IgYSBqb3VybmFsOiBob3cgbWFueSBlbnRyaWVzLCBhbmQgdGhlIGhlYWQgaGFzaC4gKi9cbmludGVyZmFjZSBDaGFpblN0YXRlIHtcbiAgY291bnQ6IG51bWJlcjtcbiAgaGVhZEhhc2g6IHN0cmluZztcbn1cblxuLyoqXG4gKiBDaGFpbiBzdGF0ZSBpcyBkZWxpYmVyYXRlbHkgKipub3QqKiBjYWNoZWQgKElzc3VlICM0OTEpLlxuICpcbiAqIFRoZSBwcmV2aW91cyBpbXBsZW1lbnRhdGlvbiBrZXB0IGEgYE1hcDxwYXRoLCBDaGFpblN0YXRlPmAgc2VlZGVkIG9uXG4gKiBmaXJzdCB1c2UgYW5kIG5ldmVyIHJlLXJlYWQgaXQuIFVuZGVyIGEgc2Vjb25kIHdyaXRlciDigJQgYSBjaGlsZCBgZGVub2BcbiAqIGNvbW1hbmQgaW5oZXJpdGluZyBgVklCRV9SVU5fSURgLCBvciBhIGNvbmN1cnJlbnQgcnVuIOKAlCB0aGUgY2FjaGVkIGhlYWRcbiAqIHdlbnQgc3RhbGUgdGhlIG1vbWVudCB0aGUgb3RoZXIgcHJvY2VzcyBhcHBlbmRlZCwgYW5kIHRoZSBuZXh0IGFwcGVuZFxuICogY2hhaW5lZCBvbnRvIGFuIGVudHJ5IHRoYXQgd2FzIG5vIGxvbmdlciB0aGUgdGFpbC4gUmVhZGluZyB0aGUgaGVhZCBmcm9tXG4gKiBkaXNrIGluc2lkZSB0aGUgbG9jayBjb3N0cyBvbmUgcmVhZCBvZiBhIGZpbGUgdGhhdCBob2xkcyBhIGZldyBodW5kcmVkXG4gKiBsaW5lcywgd2hpY2ggaXMgbm90aGluZyBiZXNpZGUgZ2V0dGluZyB0aGUgY2hhaW4gd3JvbmcuXG4gKi9cblxuLyoqIFRvZGF5J3MgVVRDIGRhdGUgYXMgYFlZWVktTU0tRERgLiAqL1xuZnVuY3Rpb24gdG9kYXlVdGMoKTogc3RyaW5nIHtcbiAgcmV0dXJuIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG59XG5cbi8qKiBTYW5pdGlzZSBhIHdvcmtlciBpZCBmb3Igc2FmZSB1c2UgaW4gYSBmaWxlbmFtZS4gKi9cbmZ1bmN0aW9uIHNhbml0aXNlV29ya2VySWQoaWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGNsZWFuZWQgPSBpZC5yZXBsYWNlKC9bXkEtWmEtejAtOS5fLV0rL2csIFwiLVwiKS5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpO1xuICByZXR1cm4gY2xlYW5lZC5sZW5ndGggPiAwID8gY2xlYW5lZCA6IFwid29ya2VyXCI7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZGVmYXVsdCBhdWRpdCBiYXNlIGRpcmVjdG9yeSBmcm9tIHRoZSBlbnZpcm9ubWVudC5cbiAqXG4gKiBAcGFyYW0gb3ZlcnJpZGUgLSBFeHBsaWNpdCBkaXJlY3RvcnksIHVzZWQgdmVyYmF0aW0gd2hlbiBzdXBwbGllZC5cbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgZm9yIHRoZSBgVklCRV9BVURJVF9ESVJgLCBgV09SS19ESVJgIGFuZFxuICogICBgVE1QRElSYCBmYWxsYmFjayAoSXNzdWUgIzk2MykuIERlZmF1bHRzIHRvIHRoZSByZWFsIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQmFzZURpcihcbiAgb3ZlcnJpZGU/OiBzdHJpbmcsXG4gIGVudjogRW52TG9va3VwID0gcHJvY2Vzc0Vudkxvb2t1cCxcbik6IHN0cmluZyB7XG4gIGlmIChvdmVycmlkZSkgcmV0dXJuIG92ZXJyaWRlO1xuICBjb25zdCBhdWRpdERpciA9IGVudihcIlZJQkVfQVVESVRfRElSXCIpO1xuICBpZiAoYXVkaXREaXIpIHtcbiAgICBpZiAoIWF1ZGl0RGlyLnN0YXJ0c1dpdGgoXCIvXCIpIHx8IGF1ZGl0RGlyLnNwbGl0KFwiL1wiKS5pbmNsdWRlcyhcIi4uXCIpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiVklCRV9BVURJVF9ESVIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBwYXRoIHdpdGhvdXQgYSAnLi4nIHNlZ21lbnRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBhdWRpdERpcjtcbiAgfVxuICBjb25zdCB3b3JrRGlyID0gZW52KFwiV09SS19ESVJcIik7XG4gIGlmICh3b3JrRGlyKSByZXR1cm4gYCR7d29ya0Rpcn0vYXVkaXRgO1xuICAvLyBJc3N1ZSAjMTI0MjogcGVyLWFjY291bnQsIG5vdCB0aGUgZml4ZWQgYCR7VE1QRElSfS92aWJlLWF1ZGl0YCBldmVyeVxuICAvLyBhY2NvdW50IG9uIHRoZSBob3N0IHNoYXJlZCDigJQgdGhlIGpvdXJuYWwgaXMgdGhlIHRhbXBlci1ldmlkZW50IHJlY29yZCBvZlxuICAvLyB0aGUgd29ya2VyJ3Mgb3duIG11dGF0aW9ucy5cbiAgcmV0dXJuIHNoYXJlZFRtcFN0YXRlRGlyKFwidmliZS1hdWRpdFwiLCBlbnYpO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIHdvcmtlciBwYXJ0aXRpb24gaWQgZnJvbSB0aGUgZW52aXJvbm1lbnQuXG4gKlxuICogVGhlIHBhcnRpdGlvbiBpcyAqKnBlciB3b3JrZXIsIG5vdCBwZXIgcHJvY2VzcyoqIChJc3N1ZSAjNDkxKS4gRXZlcnlcbiAqIHByb2Nlc3Mgb24gYSBob3N0IOKAlCB0aGUgcnVuIGRyaXZlciBhbmQgZXZlcnkgY2hpbGQgYGRlbm9gIGNvbW1hbmQgaXRcbiAqIHNwYXducyDigJQgZGVsaWJlcmF0ZWx5IHNoYXJlcyBvbmUgam91cm5hbCwgc28gdGhlIHRyYWlsIHJlYWRzIGluIHRoZVxuICogb3JkZXIgdGhlIG11dGF0aW9ucyBhY3R1YWxseSBoYXBwZW5lZCByYXRoZXIgdGhhbiBiZWluZyBzY2F0dGVyZWQgYWNyb3NzXG4gKiBhIGZpbGUgcGVyIHBpZC4gQ29uY3VycmVuY3kgc2FmZXR5IHRoZXJlZm9yZSBjb21lcyBmcm9tIHRoZSBkaXJlY3RvcnlcbiAqIGxvY2sgaW4gYHJlY29yZE11dGF0aW9uYCwgbmV2ZXIgZnJvbSB0aGUgZmlsZW5hbWU6IGBXT1JLRVJfVU5JUVVFX0lEYCBpc1xuICogYSBkZXBsb3ltZW50IHNlYW0gZm9yIHJ1bm5pbmcgdHdvIHdvcmtlcnMgYWdhaW5zdCBvbmUgdm9sdW1lLCBhbmQgaXNcbiAqIHVuc2V0IG9uIHRoZSBzdGFuZGFyZCBzaW5nbGUtd29ya2VyIGhvc3QsIHdoaWNoIGlzIHdoeSBqb3VybmFscyB0aGVyZVxuICogYXJlIG5hbWVkIGBhdWRpdC13b3JrZXItPGRhdGU+Lmpzb25sYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVXb3JrZXJJZChcbiAgb3ZlcnJpZGU/OiBzdHJpbmcsXG4gIGVudjogRW52TG9va3VwID0gcHJvY2Vzc0Vudkxvb2t1cCxcbik6IHN0cmluZyB7XG4gIGlmIChvdmVycmlkZSkgcmV0dXJuIHNhbml0aXNlV29ya2VySWQob3ZlcnJpZGUpO1xuICBjb25zdCBpZCA9IGVudihcIldPUktFUl9VTklRVUVfSURcIikgPz9cbiAgICBlbnYoXCJXT1JLRVJfTkFNRVwiKSA/P1xuICAgIFwid29ya2VyXCI7XG4gIHJldHVybiBzYW5pdGlzZVdvcmtlcklkKGlkKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBydW4tY29ycmVsYXRpb24gaWQgZnJvbSB0aGUgZW52aXJvbm1lbnQgKGpvaW5zIHRvICMyMzgxKS5cbiAqXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwIChJc3N1ZSAjOTYzKS4gRGVmYXVsdHMgdG8gdGhlIHJlYWwgcHJvY2Vzc1xuICogICBlbnZpcm9ubWVudCwgc28gcHJvZHVjdGlvbiBjYWxsZXJzIHBhc3Mgbm90aGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVSdW5JZChlbnY6IEVudkxvb2t1cCA9IHByb2Nlc3NFbnZMb29rdXApOiBzdHJpbmcge1xuICByZXR1cm4gZW52KFwiVklCRV9SVU5fSURcIikgPz9cbiAgICBlbnYoXCJXT1JLRVJfVU5JUVVFX0lEXCIpID8/XG4gICAgXCJ1bmtub3duXCI7XG59XG5cbi8qKiBCdWlsZCB0aGUgam91cm5hbCBmaWxlIHBhdGggZm9yIHRoZSBnaXZlbiBwYXJ0aXRpb24uICovXG5leHBvcnQgZnVuY3Rpb24gYXVkaXRGaWxlUGF0aChvcHRzOiBSZWNvcmRPcHRpb25zID0ge30pOiBzdHJpbmcge1xuICBjb25zdCBlbnYgPSBvcHRzLmVudiA/PyBwcm9jZXNzRW52TG9va3VwO1xuICBjb25zdCBiYXNlRGlyID0gcmVzb2x2ZUJhc2VEaXIob3B0cy5iYXNlRGlyLCBlbnYpO1xuICBjb25zdCB3b3JrZXJJZCA9IHJlc29sdmVXb3JrZXJJZChvcHRzLndvcmtlcklkLCBlbnYpO1xuICBjb25zdCBkYXRlID0gb3B0cy5kYXRlID8/IHRvZGF5VXRjKCk7XG4gIHJldHVybiBgJHtiYXNlRGlyfS9hdWRpdC0ke3dvcmtlcklkfS0ke2RhdGV9Lmpzb25sYDtcbn1cblxuLyoqXG4gKiBRdWV1ZSBgZm5gIGJlaGluZCB0aGlzIHByb2Nlc3MncyBvdGhlciBjYWxsZXJzIGZvciBga2V5YC5cbiAqXG4gKiAqKlRoaXMgaXMgbm90IGEgbG9jay4qKiBJdCBpcyBhIGNoYWluIG9mIHByb21pc2VzIGluIGEgbW9kdWxlLWxldmVsXG4gKiBgTWFwYCwgc28gaXQgb3JkZXJzIGNhbGxlcnMgaW5zaWRlIG9uZSBEZW5vIHByb2Nlc3MgYW5kIGlzIGludmlzaWJsZSB0b1xuICogZXZlcnkgb3RoZXIgcHJvY2VzcyBvbiB0aGUgaG9zdCDigJQgd2hpY2ggaXMgcHJlY2lzZWx5IGhvdyAxMCBvZiAxNFxuICogam91cm5hbHMgb24gR1JRLTIzIGVuZGVkIHVwIHdpdGggb3JwaGFuZWQgaGVhZCBoYXNoZXMgKElzc3VlICM0OTEpLlxuICogRXhjbHVzaW9uIGFjcm9zcyBwcm9jZXNzZXMgaXMge0BsaW5rIHdpdGhGaWxlTG9ja30ncyBqb2I7IHRoaXMgc3RheXNcbiAqIG9ubHkgYXMgYSBmYXN0IHBhdGgsIHNvIGNvbmN1cnJlbnQgY2FsbGVycyBpbiBvbmUgcHJvY2VzcyB3YWl0IG9uIGFcbiAqIHByb21pc2UgcmF0aGVyIHRoYW4gc3Bpbm5pbmcgb24gdGhlIGxvY2sgZmlsZS5cbiAqL1xuZnVuY3Rpb24gd2l0aExvY2s8VD4oa2V5OiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IHByZXYgPSB3cml0ZVF1ZXVlcy5nZXQoa2V5KSA/PyBQcm9taXNlLnJlc29sdmUoKTtcbiAgLy8gQ2hhaW4gcmVnYXJkbGVzcyBvZiB3aGV0aGVyIHRoZSBwcmV2aW91cyB0YXNrIHJlc29sdmVkIG9yIHJlamVjdGVkLlxuICBjb25zdCBuZXh0ID0gcHJldi50aGVuKGZuLCBmbik7XG4gIC8vIFN3YWxsb3cgcmVqZWN0aW9uIG9uIHRoZSBzdG9yZWQgdGFpbCBzbyBpdCBuZXZlciBiZWNvbWVzIHVuaGFuZGxlZC5cbiAgd3JpdGVRdWV1ZXMuc2V0KGtleSwgbmV4dC50aGVuKCgpID0+IHt9LCAoKSA9PiB7fSkpO1xuICByZXR1cm4gbmV4dDtcbn1cblxuLyoqXG4gKiBMb2NrIGZpbGUgZ3VhcmRpbmcgZXZlcnkgYXBwZW5kIHRvIG9uZSBhdWRpdCBkaXJlY3RvcnkgKElzc3VlICM0OTEpLlxuICpcbiAqIERpcmVjdG9yeS13aWRlIHJhdGhlciB0aGFuIHBlci1qb3VybmFsLCBiZWNhdXNlIGpvdXJuYWwgKnNlbGVjdGlvbiogaXNcbiAqIGl0c2VsZiBwYXJ0IG9mIHRoZSBjcml0aWNhbCBzZWN0aW9uOiBgcmVzb2x2ZVdyaXRhYmxlSm91cm5hbGAgZGVjaWRlc1xuICogd2hpY2ggc2VnbWVudCB0byB3cml0ZSB0byBieSByZWFkaW5nIGNoYWluIHN0YXRlLCBhbmQgdHdvIHdyaXRlcnMgbWFraW5nXG4gKiB0aGF0IGRlY2lzaW9uIGNvbmN1cnJlbnRseSBpcyB0aGUgc2FtZSByYWNlIGFzIHR3byB3cml0ZXJzIGFwcGVuZGluZ1xuICogY29uY3VycmVudGx5LiBIZWxkIGZvciB0aGUgbGVuZ3RoIG9mIG9uZSBhcHBlbmQg4oCUIGEgcmVhZCwgYSBoYXNoIGFuZCB0d29cbiAqIHNtYWxsIHdyaXRlcyDigJQgc28gYSBzaW5nbGUgbG9jayBjb3N0cyBub3RoaW5nIGF0IHRoZSByYXRlIG11dGF0aW9uc1xuICogYWN0dWFsbHkgb2NjdXIuXG4gKlxuICogVGhlIG5hbWUgaXMgZG90LXByZWZpeGVkIGFuZCBkb2VzIG5vdCBtYXRjaCB0aGUgYGF1ZGl0LSouanNvbmxgIHBhdHRlcm5cbiAqIGB2ZXJpZnlBbGxDaGFpbnNgIHN3ZWVwcywgc28gaXQgaXMgbmV2ZXIgbWlzdGFrZW4gZm9yIGEgam91cm5hbC5cbiAqL1xuZnVuY3Rpb24gYXVkaXRMb2NrUGF0aChiYXNlRGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7YmFzZURpcn0vLmF1ZGl0LWFwcGVuZC5sb2NrYDtcbn1cblxuLyoqIFJlYWQgYSBqb3VybmFsJ3Mgbm9uLWVtcHR5IGxpbmVzLCBvciBgbnVsbGAgd2hlbiB0aGUgZmlsZSBpcyBhYnNlbnQuICovXG5hc3luYyBmdW5jdGlvbiByZWFkSm91cm5hbExpbmVzKHBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nW10gfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHBhdGgpO1xuICAgIHJldHVybiBjb250ZW50LnNwbGl0KFwiXFxuXCIpLmZpbHRlcigobCkgPT4gbC50cmltKCkubGVuZ3RoID4gMCk7XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQpIHJldHVybiBudWxsO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5cbi8qKiBIYXNoIG9mIHRoZSBlbnRyeSBhdCBgaW5kZXhgLCBvciBudWxsIHdoZW4gaXQgaXMgYWJzZW50L3VucGFyc2VhYmxlLiAqL1xuZnVuY3Rpb24gaGFzaEF0KGxpbmVzOiByZWFkb25seSBzdHJpbmdbXSwgaW5kZXg6IG51bWJlcik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuICBpZiAoIWxpbmUpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIHJldHVybiAoSlNPTi5wYXJzZShsaW5lKSBhcyBBdWRpdEVudHJ5KS5oYXNoID8/IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogQ3Jvc3MtY2hlY2sgYSBqb3VybmFsIGFnYWluc3QgaXRzIGFuY2hvciBhbmQgcmV0dXJuIHRoZSBjaGFpbiBwb3NpdGlvbi5cbiAqXG4gKiBUaHJvd3Mge0BsaW5rIEF1ZGl0Q2hhaW5BbmNob3JFcnJvcn0gd2hlbmV2ZXIgdGhlIHR3byBkaXNhZ3JlZSDigJQgdGhlXG4gKiBqb3VybmFsIGlzIHNob3J0ZXIgdGhhbiB0aGUgYW5jaG9yICh0cnVuY2F0aW9uKSwgdGhlIGFuY2hvcmVkIGVudHJ5IG5vXG4gKiBsb25nZXIgY2FycmllcyB0aGUgYW5jaG9yZWQgaGFzaCAocmV3cml0ZSksIHRoZSBqb3VybmFsIGhhcyB2YW5pc2hlZFxuICogd2hpbGUgaXRzIGFuY2hvciBzdXJ2aXZlcyAoZGVsZXRpb24pLCBvciBhIGpvdXJuYWwgZXhpc3RzIHdpdGggbm8gYW5jaG9yXG4gKiBhdCBhbGwgKGFuY2hvciByZW1vdmVkLCBvciBhIHByZS0jMzcxMiBqb3VybmFsIGF3YWl0aW5nIGBhZG9wdEFuY2hvcmApLlxuICovXG5mdW5jdGlvbiByZWNvbmNpbGUoXG4gIHBhdGg6IHN0cmluZyxcbiAgYW5jaG9yOiBDaGFpbkFuY2hvciB8IG51bGwsXG4gIGxpbmVzOiBzdHJpbmdbXSB8IG51bGwsXG4pOiBDaGFpblN0YXRlIHtcbiAgaWYgKGxpbmVzID09PSBudWxsKSB7XG4gICAgaWYgKGFuY2hvciAmJiBhbmNob3IuY291bnQgPiAwKSB7XG4gICAgICB0aHJvdyBuZXcgQXVkaXRDaGFpbkFuY2hvckVycm9yKFxuICAgICAgICBgYXVkaXQgam91cm5hbCBkZWxldGVkOiAke3BhdGh9IGlzIG1pc3NpbmcgYnV0IGl0cyBhbmNob3IgcmVjb3JkcyBgICtcbiAgICAgICAgICBgJHthbmNob3IuY291bnR9IGVudHJpZXNgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgY291bnQ6IDAsIGhlYWRIYXNoOiBcIlwiIH07XG4gIH1cblxuICBpZiAoIWFuY2hvcikge1xuICAgIHRocm93IG5ldyBBdWRpdENoYWluQW5jaG9yRXJyb3IoXG4gICAgICBgYXVkaXQgam91cm5hbCBoYXMgbm8gY2hhaW4gYW5jaG9yOiAke3BhdGh9IOKAlCB0aGUgYW5jaG9yIGF0IGAgK1xuICAgICAgICBgJHthbmNob3JQYXRoKHBhdGgpfSBpcyBtaXNzaW5nLiBBZG9wdCB0aGUgZXhpc3RpbmcgY2hhaW4gd2l0aCBgICtcbiAgICAgICAgYFxcYGRlbm8gdGFzayBhdWRpdC1jaGFpbi12ZXJpZnkgLS1hZG9wdFxcYCBvbmNlIGl0IGhhcyBiZWVuIHJldmlld2VkLmAsXG4gICAgICBmYWxzZSxcbiAgICApO1xuICB9XG5cbiAgaWYgKGxpbmVzLmxlbmd0aCA8IGFuY2hvci5jb3VudCkge1xuICAgIHRocm93IG5ldyBBdWRpdENoYWluQW5jaG9yRXJyb3IoXG4gICAgICBgYXVkaXQgam91cm5hbCB0cnVuY2F0ZWQ6ICR7cGF0aH0gaG9sZHMgJHtsaW5lcy5sZW5ndGh9IGVudHJpZXMgYnV0IGAgK1xuICAgICAgICBgaXRzIGFuY2hvciByZWNvcmRzICR7YW5jaG9yLmNvdW50fWAsXG4gICAgKTtcbiAgfVxuICAvLyBJc3N1ZSAjMzk0OTogYSBsb25nZXIgam91cm5hbCBpcyBhcyBzdXNwZWN0IGFzIGEgc2hvcnRlciBvbmUuIEV4dGVuZGluZ1xuICAvLyBpdCBoZXJlIHdvdWxkIHJlLWFuY2hvciBvbiB0aGUgbmV4dCBhcHBlbmQsIGxhdW5kZXJpbmcgYSBmb3JnZWQgdGFpbFxuICAvLyBpbnRvIHRoZSBhbmNob3IuXG4gIGlmIChsaW5lcy5sZW5ndGggPiBhbmNob3IuY291bnQpIHtcbiAgICB0aHJvdyBuZXcgQXVkaXRDaGFpbkFuY2hvckVycm9yKFxuICAgICAgYGF1ZGl0IGpvdXJuYWwgaGFzIGVudHJpZXMgYXBwZW5kZWQgcGFzdCB0aGUgYW5jaG9yOiAke3BhdGh9IGhvbGRzIGAgK1xuICAgICAgICBgJHtsaW5lcy5sZW5ndGh9IGVudHJpZXMgYnV0IGl0cyBhbmNob3IgcmVjb3JkcyAke2FuY2hvci5jb3VudH1gLFxuICAgICk7XG4gIH1cbiAgaWYgKGFuY2hvci5jb3VudCA+IDAgJiYgaGFzaEF0KGxpbmVzLCBhbmNob3IuY291bnQgLSAxKSAhPT0gYW5jaG9yLmhlYWRIYXNoKSB7XG4gICAgdGhyb3cgbmV3IEF1ZGl0Q2hhaW5BbmNob3JFcnJvcihcbiAgICAgIGBhdWRpdCBqb3VybmFsIHJld3JpdHRlbjogJHtwYXRofSBlbnRyeSAke2FuY2hvci5jb3VudCAtIDF9IG5vIGxvbmdlciBgICtcbiAgICAgICAgYGNhcnJpZXMgdGhlIGFuY2hvcmVkIGhlYWQgaGFzaGAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGhlYWRIYXNoID0gbGluZXMubGVuZ3RoID4gMFxuICAgID8gaGFzaEF0KGxpbmVzLCBsaW5lcy5sZW5ndGggLSAxKSA/PyBcIlwiXG4gICAgOiBcIlwiO1xuICByZXR1cm4geyBjb3VudDogbGluZXMubGVuZ3RoLCBoZWFkSGFzaCB9O1xufVxuXG4vKipcbiAqIENoYWluIHBvc2l0aW9uIGZvciBhIHBhdGgsIHJlYWQgZnJvbSBkaXNrIGFuZCBpdHMgYW5jaG9yIGV2ZXJ5IHRpbWUuXG4gKlxuICogQ2FsbGVycyBtdXN0IGhvbGQgdGhlIGRpcmVjdG9yeSBsb2NrIChJc3N1ZSAjNDkxKTogdGhlIHZhbHVlIGlzIG9ubHlcbiAqIHRydWUgZm9yIGFzIGxvbmcgYXMgbm8gb3RoZXIgcHJvY2VzcyBhcHBlbmRzLCBzbyByZWFkaW5nIGl0IG91dHNpZGUgdGhlXG4gKiBsb2NrIGFuZCB3cml0aW5nIG9uIHRoZSBzdHJlbmd0aCBvZiBpdCBpcyB0aGUgb3JpZ2luYWwgYnVnLlxuICovXG4vKipcbiAqIEhhcyBhbiBvcGVyYXRvciBzaWduZWQgZm9yIHRoaXMgam91cm5hbCdzIGN1cnJlbnQgZGFtYWdlP1xuICpcbiAqIE1pcnJvcnMgdGhlIHN3ZWVwJ3MgYGRhbWFnZUFja25vd2xlZGdlbWVudHNgIGd1YXJkIGZvciB0aGUgYXBwZW5kIHBhdGhcbiAqIChJc3N1ZSAjMTA3NCkuIEEgc2lnbmF0dXJlIGNvdmVycyB0aGUgZXhhY3QgYnl0ZXMgaXQgd2FzIGdpdmVuLCBzbyBhXG4gKiBqb3VybmFsIHdob3NlIGFja25vd2xlZGdlbWVudCBubyBsb25nZXIgbWF0Y2hlcyBpdHMgZGlnZXN0IGlzICpub3QqXG4gKiBwcm90ZWN0ZWQg4oCUIHRoYXQgaXMgdGhlIGFsYXJtIGNvbWluZyBiYWNrLCBhbmQgaGVhbGluZyBpcyB0aGUgbGVzc2VyXG4gKiBjb25jZXJuIGF0IHRoYXQgcG9pbnQuXG4gKlxuICogQHBhcmFtIHBhdGggLSBKb3VybmFsIGZpbGUgcGF0aFxuICogQHJldHVybnMgdHJ1ZSB3aGVuIGEgY3VycmVudCBhY2tub3dsZWRnZW1lbnQgY292ZXJzIHRoZXNlIGV4YWN0IGJ5dGVzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRhbWFnZUlzQWNrbm93bGVkZ2VkKHBhdGg6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBiYXNlRGlyID0gcGF0aC5zbGljZSgwLCBwYXRoLmxhc3RJbmRleE9mKFwiL1wiKSkgfHwgXCIuXCI7XG4gIGNvbnN0IG5hbWUgPSBwYXRoLnNsaWNlKHBhdGgubGFzdEluZGV4T2YoXCIvXCIpICsgMSk7XG4gIGNvbnN0IGRhbWFnZSA9IChhd2FpdCByZWFkUm9zdGVyQ29udGVudHMoYmFzZURpcikpLmRhbWFnZWQuZ2V0KG5hbWUpO1xuICBpZiAoIWRhbWFnZSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBkaWdlc3QgPSBhd2FpdCBqb3VybmFsRGlnZXN0KHBhdGgpO1xuICByZXR1cm4gZGlnZXN0Lm9rICYmIGRpZ2VzdC52YWx1ZSA9PT0gZGFtYWdlLmRpZ2VzdDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0Q2hhaW5TdGF0ZShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPENoYWluU3RhdGU+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVjb25jaWxlKFxuICAgICAgcGF0aCxcbiAgICAgIGF3YWl0IHJlYWRBbmNob3IocGF0aCksXG4gICAgICBhd2FpdCByZWFkSm91cm5hbExpbmVzKHBhdGgpLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgaWYgKCEoZXJyb3IgaW5zdGFuY2VvZiBBdWRpdENoYWluQW5jaG9yRXJyb3IpKSB0aHJvdyBlcnJvcjtcbiAgICAvLyBJc3N1ZSAjMTA3NDogYSBqb3VybmFsIHRoYXQgZGlzYWdyZWVzIHdpdGggaXRzIGFuY2hvciBtYXkgc2ltcGx5IGJlXG4gICAgLy8gb25lIHRoZSBwcmV2aW91cyBwcm9jZXNzIGRpZCBub3QgbGl2ZSBsb25nIGVub3VnaCB0byBjb25maXJtLiBTZXR0bGVcbiAgICAvLyB0aGF0IGhlcmUg4oCUIGluc2lkZSB0aGUgbG9jaywgYW5kIG9ubHkgZm9yIGEgam91cm5hbCB0aGF0IGhhcyBhbHJlYWR5XG4gICAgLy8gZmFpbGVkIOKAlCBiZWZvcmUgcXVhcmFudGluaW5nIGl0LiBBIGpvdXJuYWwgdGhhdCBzZXR0bGVzIG5vdGhpbmdcbiAgICAvLyBrZWVwcyBpdHMgb3JpZ2luYWwgZXJyb3IsIHNvIG5vdGhpbmcgaXMgcmVwYWlyZWQgb24gdGhlIHN0cmVuZ3RoIG9mXG4gICAgLy8gYSBzZWNvbmQgbG9vay5cbiAgICAvL1xuICAgIC8vIEV4Y2VwdCBvbmUgYW4gb3BlcmF0b3IgaGFzIGFscmVhZHkgc2lnbmVkIGZvci4gVGhlIHN3ZWVwIHJlZnVzZXMgdG9cbiAgICAvLyBoZWFsIHRob3NlIGJlY2F1c2UgdGhlIHNpZ25hdHVyZSBpcyBwaW5uZWQgdG8gdGhlIGpvdXJuYWwncyBleGFjdFxuICAgIC8vIGJ5dGVzLCBhbmQgcmVwYWlyaW5nIHRoZW0gd291bGQgbGFwc2UgaXQ7IHRoZSBndWFyYW50ZWUgaXMgd29ydGhcbiAgICAvLyBub3RoaW5nIGlmIHRoZSAqd3JpdGUqIHBhdGggcXVpZXRseSBkb2VzIHdoYXQgdGhlIHN3ZWVwIGRlY2xpbmVzIHRvLFxuICAgIC8vIHNvIHRoZSBzYW1lIGNoZWNrIHN0YW5kcyBvbiBib3RoLlxuICAgIGlmIChhd2FpdCBkYW1hZ2VJc0Fja25vd2xlZGdlZChwYXRoKSkgdGhyb3cgZXJyb3I7XG4gICAgY29uc3Qgc2V0dGxlZCA9IGF3YWl0IHNldHRsZUludGVycnVwdGVkQXBwZW5kKHBhdGgpO1xuICAgIGlmICghc2V0dGxlZC5vaykge1xuICAgICAgLy8gTG91ZCwgYW5kIHRoZSBvcmlnaW5hbCB2ZXJkaWN0IHN0YW5kcyDigJQgZXhhY3RseSBhcyBvbiB0aGUgc3dlZXAuXG4gICAgICAvLyBSZXBsYWNpbmcgaXQgd2l0aCB0aGUgcmVjb3ZlcnkncyBvd24gZXJyb3Igd291bGQgYWxzbyByZXBsYWNlIGFcbiAgICAgIC8vICpxdWFyYW50aW5hYmxlKiBmYWlsdXJlIHdpdGggb25lIHRoYXQgaXMgbm90LCBhbmQgdGhlIGNhbGxlclxuICAgICAgLy8gcXVhcmFudGluZXMgb24gdGhhdCBmbGFnOiB0aGUgam91cm5hbCB3b3VsZCBzdG9wIHRha2luZyB3cml0ZXNcbiAgICAgIC8vIGFsdG9nZXRoZXIgYW5kIHRoZSBtdXRhdGlvbiB3b3VsZCBnbyB1bnJlY29yZGVkLCB3aGljaCBpcyBhXG4gICAgICAvLyB3b3JzZSBvdXRjb21lIHRoYW4gdGhlIGRhbWFnZSB0aGF0IHRyaWdnZXJlZCBpdC5cbiAgICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICAgIGBbU0VDVVJJVFldIFtBVURJVF9BUFBFTkRfUkVDT1ZFUllfRkFJTEVEXSAke3BhdGh9OiBhbiBpbnRlcnJ1cHRlZCBgICtcbiAgICAgICAgICBgYXBwZW5kIGNvdWxkIG5vdCBiZSBzZXR0bGVkOiAke3NldHRsZWQuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgICBpZiAoIXNldHRsZWQudmFsdWUpIHRocm93IGVycm9yO1xuICAgIGNvbnNvbGUuZXJyb3IoZm9ybWF0QXBwZW5kUmVjb3Zlcnkoc2V0dGxlZC52YWx1ZSkpO1xuICAgIHJldHVybiByZWNvbmNpbGUoXG4gICAgICBwYXRoLFxuICAgICAgYXdhaXQgcmVhZEFuY2hvcihwYXRoKSxcbiAgICAgIGF3YWl0IHJlYWRKb3VybmFsTGluZXMocGF0aCksXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIEFwcGVuZCBhIGhhc2gtY2hhaW5lZCBlbnRyeSByZWNvcmRpbmcgYSBzaW5nbGUgR2l0SHViIG11dGF0aW9uLlxuICpcbiAqIEJlc3QtZWZmb3J0IGJ5IGNvbnRyYWN0OiByZXR1cm5zIGEgUmVzdWx0IHJhdGhlciB0aGFuIHRocm93aW5nIHNvIGFcbiAqIGpvdXJuYWxsaW5nIGZhaWx1cmUgbmV2ZXIgYWJvcnRzIHRoZSBtdXRhdGlvbiBpdCBpcyByZWNvcmRpbmcuXG4gKlxuICogQHBhcmFtIG11dGF0aW9uIC0gVGhlIG11dGF0aW9uIHRvIHJlY29yZFxuICogQHBhcmFtIG9wdHMgLSBTdG9yYWdlIGxvY2F0aW9uIG92ZXJyaWRlcyAobWFpbmx5IGZvciB0ZXN0cylcbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIHRoZSBwZXJzaXN0ZWQgZW50cnksIG9yIGFuIGVycm9yIG9uIElPIGZhaWx1cmVcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlY29yZE11dGF0aW9uKFxuICBtdXRhdGlvbjogQXVkaXRNdXRhdGlvbixcbiAgb3B0czogUmVjb3JkT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8QXVkaXRFbnRyeT4+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBlbnYgPSBvcHRzLmVudiA/PyBwcm9jZXNzRW52TG9va3VwO1xuICAgIGNvbnN0IGJhc2VEaXIgPSByZXNvbHZlQmFzZURpcihvcHRzLmJhc2VEaXIsIGVudik7XG4gICAgLy8gSXNzdWUgIzEyNDI6IGEgam91cm5hbCBkaXJlY3RvcnkgdW5kZXIgdGhlIHNoYXJlZCB0ZW1wb3Jhcnkgcm9vdCBpc1xuICAgIC8vIGNyZWF0ZWQgMDcwMCBhbmQgcmVmdXNlZCB3aGVuIGFub3RoZXIgYWNjb3VudCBvd25zIGl0LiBBcHBlbmRpbmcgYVxuICAgIC8vIGhhc2gtY2hhaW5lZCBlbnRyeSB0byBhIGRpcmVjdG9yeSBhIGxvY2FsIHVzZXIgY29udHJvbHMgd291bGQgbWFrZSB0aGVcbiAgICAvLyBhdWRpdCB0cmFpbCBldmlkZW5jZSBvZiBub3RoaW5nOyBmYWlsaW5nIGhlcmUgaXMgcmVwb3J0ZWQgdGhyb3VnaCB0aGVcbiAgICAvLyBSZXN1bHQgdGhlIGNhbGxlciBhbHJlYWR5IGhhbmRsZXMuIFRoZSBzYW1lIGluamVjdGVkIGxvb2t1cCBkZWNpZGVzXG4gICAgLy8gd2hhdCBcInNoYXJlZCB0ZW1wb3Jhcnkgcm9vdFwiIG1lYW5zIChJc3N1ZSAjMTYwNCk6IHRoZSBhZ2VudC1zaWRlIGdoXG4gICAgLy8gZ3VhcmQgam91cm5hbHMgZnJvbSBhIGNoaWxkIHdpdGggbm8gYC0tYWxsb3ctZW52YCwgc28gaXQgaGFuZHMgaW4gYVxuICAgIC8vIGxvb2t1cCB0aGF0IGFuc3dlcnMgbm90aGluZyByYXRoZXIgdGhhbiBvbmUgdGhhdCB3b3VsZCB0aHJvdy5cbiAgICBjb25zdCB0cnVzdCA9IGF3YWl0IGVuc3VyZVN0YXRlRGlyKGJhc2VEaXIsIGVudik7XG4gICAgaWYgKCF0cnVzdC50cnVzdGVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBdWRpdCBkaXJlY3RvcnkgJHtiYXNlRGlyfSBpcyBub3Qgd29ya2VyLXByaXZhdGU6ICR7XG4gICAgICAgICAgdHJ1c3QucmVhc29uID8/IFwidW5rbm93blwiXG4gICAgICAgIH1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgLy8gSXNzdWUgIzQ5MTogam91cm5hbCBzZWxlY3Rpb24gYW5kIHRoZSBhcHBlbmQgYXJlIG9uZSBjcml0aWNhbFxuICAgIC8vIHNlY3Rpb24sIGd1YXJkZWQgYWNyb3NzIHByb2Nlc3Nlcy4gVGhlIGluLXByb2Nlc3MgcXVldWUgd3JhcHMgdGhlXG4gICAgLy8gZmlsZSBsb2NrIHNvIHNhbWUtcHJvY2VzcyBjYWxsZXJzIHdhaXQgb24gYSBwcm9taXNlIGluc3RlYWQgb2ZcbiAgICAvLyBzcGlubmluZyBvbiB0aGUgbG9jayBmaWxlLlxuICAgIGNvbnN0IGVudHJ5ID0gYXdhaXQgd2l0aExvY2soXG4gICAgICBiYXNlRGlyLFxuICAgICAgKCkgPT5cbiAgICAgICAgd2l0aEZpbGVMb2NrKGF1ZGl0TG9ja1BhdGgoYmFzZURpciksIGFzeW5jICgpID0+IHtcbiAgICAgICAgICBjb25zdCBwYXRoID0gYXdhaXQgcmVzb2x2ZVdyaXRhYmxlSm91cm5hbChhdWRpdEZpbGVQYXRoKG9wdHMpKTtcbiAgICAgICAgICByZXR1cm4gYXdhaXQgYXBwZW5kRW50cnkocGF0aCwgbXV0YXRpb24pO1xuICAgICAgICB9KSxcbiAgICApO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogZW50cnkgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKiBBcHBlbmQgb25lIGNoYWluZWQsIGFuY2hvcmVkLCByb3N0ZXJlZCBlbnRyeSB0byBgcGF0aGAuICovXG5hc3luYyBmdW5jdGlvbiBhcHBlbmRFbnRyeShcbiAgcGF0aDogc3RyaW5nLFxuICBtdXRhdGlvbjogQXVkaXRNdXRhdGlvbixcbik6IFByb21pc2U8QXVkaXRFbnRyeT4ge1xuICBjb25zdCBiYXNlRGlyID0gcGF0aC5zbGljZSgwLCBwYXRoLmxhc3RJbmRleE9mKFwiL1wiKSkgfHwgXCIuXCI7XG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZ2V0Q2hhaW5TdGF0ZShwYXRoKTtcbiAgY29uc3QgdGltZXN0YW1wID0gbXV0YXRpb24udGltZXN0YW1wID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgY29uc3QgcGF5bG9hZCA9IHsgLi4ubXV0YXRpb24sIHRpbWVzdGFtcCB9O1xuICBjb25zdCBoYXNoID0gYXdhaXQgY29tcHV0ZUVudHJ5SGFzaChwYXlsb2FkLCBzdGF0ZS5oZWFkSGFzaCk7XG4gIGNvbnN0IGZ1bGw6IEF1ZGl0RW50cnkgPSB7IC4uLnBheWxvYWQsIHByZXZIYXNoOiBzdGF0ZS5oZWFkSGFzaCwgaGFzaCB9O1xuICAvLyBJc3N1ZSAjMTA3NDogZGVjbGFyZSB0aGUgYXBwZW5kIGJlZm9yZSBtYWtpbmcgaXQuIFRoZSBsaW5lIGFuZCB0aGVcbiAgLy8gYW5jaG9yIGFyZSB0d28gZmlsZXMgYW5kIGNhbm5vdCBiZSB3cml0dGVuIGF0b21pY2FsbHksIHNvIHRoZSB3cml0ZXJcbiAgLy8gcmVjb3JkcyB3aGljaCBlbnRyeSBpcyBpbiBmbGlnaHQ7IGEgcHJvY2VzcyBraWxsZWQgYW55d2hlcmUgYWZ0ZXJcbiAgLy8gdGhpcyBsZWF2ZXMgZXZpZGVuY2Ugb2Ygd2hhdCBpdCB3YXMgZG9pbmcsIGFuZCB0aGUgbmV4dCBydW4gZmluaXNoZXNcbiAgLy8gb3Igcm9sbHMgYmFjayB0aGUgYXBwZW5kIGluc3RlYWQgb2YgZGVtYW5kaW5nIGEgaHVtYW4gc2lnbmF0dXJlLlxuICBjb25zdCBkZWNsYXJlZCA9IGF3YWl0IHdyaXRlQW5jaG9yKHBhdGgsIHtcbiAgICBjb3VudDogc3RhdGUuY291bnQsXG4gICAgaGVhZEhhc2g6IHN0YXRlLmhlYWRIYXNoLFxuICAgIHBlbmRpbmc6IHsgaGFzaCwgc3RhcnRlZEF0OiB0aW1lc3RhbXAgfSxcbiAgfSk7XG4gIGlmICghZGVjbGFyZWQub2spIHtcbiAgICB0aHJvdyBuZXcgQXVkaXRDaGFpbkFuY2hvckVycm9yKFxuICAgICAgYGF1ZGl0IGVudHJ5IGNvdWxkIG5vdCBiZSBkZWNsYXJlZCBiZWZvcmUgdGhlIGFwcGVuZDogYCArXG4gICAgICAgIGRlY2xhcmVkLmVycm9yLm1lc3NhZ2UsXG4gICAgKTtcbiAgfVxuICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUocGF0aCwgYCR7SlNPTi5zdHJpbmdpZnkoZnVsbCl9XFxuYCwge1xuICAgIGFwcGVuZDogdHJ1ZSxcbiAgfSk7XG4gIGNvbnN0IG5leHQ6IENoYWluU3RhdGUgPSB7IGNvdW50OiBzdGF0ZS5jb3VudCArIDEsIGhlYWRIYXNoOiBoYXNoIH07XG4gIGNvbnN0IGFuY2hvcmVkID0gYXdhaXQgd3JpdGVBbmNob3IocGF0aCwgbmV4dCk7XG4gIGlmICghYW5jaG9yZWQub2spIHtcbiAgICAvLyBGYWlsIGxvdWQgKElzc3VlICMzMjM0KTogYW4gdW4tYW5jaG9yZWQgYXBwZW5kIGxlYXZlcyB0aGUgY2hhaW5cbiAgICAvLyB1bnZlcmlmaWFibGUsIHNvIHRoZSBjYWxsZXIgbXVzdCBzZWUgdGhlIGZhaWx1cmUuXG4gICAgdGhyb3cgbmV3IEF1ZGl0Q2hhaW5BbmNob3JFcnJvcihcbiAgICAgIGBhdWRpdCBlbnRyeSBhcHBlbmRlZCBidXQgaXRzIGFuY2hvciBjb3VsZCBub3QgYmUgd3JpdHRlbjogYCArXG4gICAgICAgIGFuY2hvcmVkLmVycm9yLm1lc3NhZ2UsXG4gICAgKTtcbiAgfVxuICAvLyBJc3N1ZSAjMzk0OTogcmVjb3JkIHRoZSBqb3VybmFsIGluIHRoZSBleHBlY3RlZC1qb3VybmFsIHJvc3RlciBzbyBhXG4gIC8vIGxhdGVyIGRlbGV0aW9uIG9mIHRoZSBqb3VybmFsIHRvZ2V0aGVyIHdpdGggaXRzIGFuY2hvciAob3Igb2YgdGhlXG4gIC8vIHdob2xlIGF1ZGl0IGRpcmVjdG9yeSkgaXMgYSBicm9rZW4gY2hhaW4sIG5vdCBhbiBlbXB0eSBzd2VlcC5cbiAgY29uc3Qgcm9zdGVyZWQgPSBhd2FpdCBhZGRUb1Jvc3RlcihcbiAgICBiYXNlRGlyLFxuICAgIHBhdGguc2xpY2UocGF0aC5sYXN0SW5kZXhPZihcIi9cIikgKyAxKSxcbiAgKTtcbiAgaWYgKCFyb3N0ZXJlZC5vaykge1xuICAgIHRocm93IG5ldyBBdWRpdENoYWluQW5jaG9yRXJyb3IoXG4gICAgICBgYXVkaXQgZW50cnkgYXBwZW5kZWQgYnV0IHRoZSBqb3VybmFsIHJvc3RlciBjb3VsZCBub3QgYmUgYCArXG4gICAgICAgIGB1cGRhdGVkOiAke3Jvc3RlcmVkLmVycm9yLm1lc3NhZ2V9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiBmdWxsO1xufVxuXG4vKiogVmVyYiByZWNvcmRlZCBhcyB0aGUgZmlyc3QgZW50cnkgb2YgYSBzZWdtZW50IG9wZW5lZCBiZXNpZGUgZGFtYWdlLiAqL1xuZXhwb3J0IGNvbnN0IEFVRElUX0pPVVJOQUxfUVVBUkFOVElORURfVkVSQiA9IFwiYXVkaXQtam91cm5hbC1xdWFyYW50aW5lZFwiO1xuXG4vKiogU2VnbWVudCBzdWZmaXggZm9yIHRoZSBudGggam91cm5hbCBvcGVuZWQgYmVzaWRlIGEgZGFtYWdlZCBvbmUuICovXG5mdW5jdGlvbiBzZWdtZW50UGF0aChiYXNlUGF0aDogc3RyaW5nLCBuOiBudW1iZXIpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7YmFzZVBhdGgucmVwbGFjZSgvXFwuanNvbmwkLywgXCJcIil9LnMke259Lmpzb25sYDtcbn1cblxuLyoqXG4gKiBUaGUgam91cm5hbCB0aGlzIHByb2Nlc3Mgc2hvdWxkIGFwcGVuZCB0byAoSXNzdWUgIzM2MSkuXG4gKlxuICogTm9ybWFsbHkgdGhlIGRheSdzIGpvdXJuYWwuIFdoZW4gdGhhdCBqb3VybmFsIGV4aXN0cyBidXQgZGlzYWdyZWVzIHdpdGhcbiAqIGl0cyBhbmNob3IsIGl0IGlzICoqcXVhcmFudGluZWQqKjogbGVmdCBleGFjdGx5IGFzIGl0IGlzIOKAlCBldmlkZW5jZSBpc1xuICogbmV2ZXIgcmVwYWlyZWQgb3IgZGVsZXRlZCDigJQgYW5kIGEgZnJlc2ggc2VnbWVudCBpcyBvcGVuZWQgYmVzaWRlIGl0LFxuICogYGF1ZGl0LTx3b3JrZXI+LTxkYXRlPi5zMS5qc29ubGAsIHdob3NlIGZpcnN0IGVudHJ5IHJlY29yZHMgd2hhdCB3YXNcbiAqIHF1YXJhbnRpbmVkIGFuZCB3aHkuXG4gKlxuICogVGhlIGFsdGVybmF0aXZlLCB3aGljaCBpcyB3aGF0IGhhcHBlbmVkIG9uIGhvc3QgR1JRLTIzIG9uIDIwMjYtMDgtMjUsIGlzXG4gKiB0aGF0IG9uZSB0b3JuIGxpbmUgYXQgZW50cnkgMzEgc3RvcHBlZCB0aGUgdHJhaWwgZGVhZDogZXZlcnkgc3Vic2VxdWVudFxuICogYGdoYCBhbmQgYGdpdGAgbXV0YXRpb24gbG9nZ2VkIGBbU0VDVVJJVFldIFtBVURJVF9KT1VSTkFMX1JFRlVTRURdYCBhbmRcbiAqIHdlbnQgdW5yZWNvcmRlZCwgZm9yIHRoZSByZXN0IG9mIHRoZSBob3N0J3MgbGlmZSwgd2hpbGUgdGhlIHdvcmtlclxuICogY2FycmllZCBvbiBtdXRhdGluZyBHaXRIdWIuIERhbWFnZSB0byB5ZXN0ZXJkYXkncyBldmlkZW5jZSBtdXN0IG5vdCBjb3N0XG4gKiB0b2RheSdzIOKAlCBhbiBhdWRpdCB0cmFpbCB0aGF0IHN0b3BzIHJlY29yZGluZyB3aGVuIGl0IGlzIGRhbWFnZWQgaXNcbiAqIHByZWNpc2VseSB0aGUgd3JvbmcgZmFpbHVyZSBkaXJlY3Rpb24uXG4gKlxuICogTm90aGluZyBpcyBsYXVuZGVyZWQgYnkgdGhpcy4gVGhlIGRhbWFnZWQgam91cm5hbCBrZWVwcyBpdHMgb3duIGFuY2hvcixcbiAqIHN0YXlzIG9uIHRoZSByb3N0ZXIsIGFuZCBrZWVwcyBmYWlsaW5nIGBhdWRpdC1jaGFpbi12ZXJpZnlgIGV4YWN0bHkgYXNcbiAqIGxvdWRseSBhcyBiZWZvcmUg4oCUIGEgZm9yZ2VkIHRhaWwgaXMgbmV2ZXIgcmUtYW5jaG9yZWQsIGJlY2F1c2UgdGhlIGZpbGVcbiAqIGNhcnJ5aW5nIGl0IGlzIG5ldmVyIHdyaXR0ZW4gdG8gYWdhaW4uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVXcml0YWJsZUpvdXJuYWwoYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGxldCBkYW1hZ2VkOiB7IHBhdGg6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfSB8IG51bGwgPSBudWxsO1xuICAvLyBCb3VuZGVkOiBhIGhvc3QgdGhhdCBoYXMgcXVhcmFudGluZWQgMTAwIHNlZ21lbnRzIGluIG9uZSBkYXkgaGFzIGFcbiAgLy8gcHJvYmxlbSBubyBmdXJ0aGVyIHNlZ21lbnQgaXMgZ29pbmcgdG8gaGVscCB3aXRoLCBhbmQgYW4gdW5ib3VuZGVkXG4gIC8vIHdhbGsgd291bGQgc3Bpbi5cbiAgZm9yIChsZXQgbiA9IDA7IG4gPD0gMTAwOyBuKyspIHtcbiAgICBjb25zdCBwYXRoID0gbiA9PT0gMCA/IGJhc2VQYXRoIDogc2VnbWVudFBhdGgoYmFzZVBhdGgsIG4pO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGdldENoYWluU3RhdGUocGF0aCk7XG4gICAgICAvLyBOb3RlIHRoZSBxdWFyYW50aW5lIG9uY2UsIHdoZW4gdGhlIHNlZ21lbnQgaXMgb3BlbmVkLiBFdmVyeSBsYXRlclxuICAgICAgLy8gcHJvY2VzcyByZS1kZXRlY3RzIHRoZSBzYW1lIGRhbWFnZSBvbiBpdHMgd2F5IHBhc3Q7IHJlcGVhdGluZyB0aGVcbiAgICAgIC8vIG5vdGUgd291bGQgYnVyeSB0aGUgc2VnbWVudCdzIHJlYWwgY29udGVudCB1bmRlciBkdXBsaWNhdGVzLlxuICAgICAgaWYgKGRhbWFnZWQgJiYgc3RhdGUuY291bnQgPT09IDApIGF3YWl0IG5vdGVRdWFyYW50aW5lKHBhdGgsIGRhbWFnZWQpO1xuICAgICAgcmV0dXJuIHBhdGg7XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIGlmIChcbiAgICAgICAgIShlcnJvciBpbnN0YW5jZW9mIEF1ZGl0Q2hhaW5BbmNob3JFcnJvcikgfHwgIWVycm9yLnF1YXJhbnRpbmFibGVcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIGlmICghZGFtYWdlZCkgZGFtYWdlZCA9IHsgcGF0aCwgcmVhc29uOiBlcnJvci5tZXNzYWdlIH07XG4gICAgfVxuICB9XG4gIHRocm93IG5ldyBBdWRpdENoYWluQW5jaG9yRXJyb3IoXG4gICAgYGF1ZGl0IGpvdXJuYWwgY2Fubm90IGJlIG9wZW5lZDogJHtiYXNlUGF0aH0gYW5kIDEwMCBzZWdtZW50cyBiZXNpZGUgaXQgYCArXG4gICAgICBgYWxsIGRpc2FncmVlIHdpdGggdGhlaXIgYW5jaG9yc2AsXG4gICk7XG59XG5cbi8qKlxuICogT3BlbiBhIHF1YXJhbnRpbmUgc2VnbWVudCBieSByZWNvcmRpbmcgd2hhdCB3YXMgZGlzcGxhY2VkLCBsb3VkbHkuXG4gKlxuICogVGhlIG5vdGUgaXMgdGhlIHNlZ21lbnQncyBmaXJzdCBjaGFpbmVkIGVudHJ5LCBzbyBcIndoeSBkb2VzIHRoaXMgaG9zdFxuICogaGF2ZSBhIGAuczFgIGpvdXJuYWxcIiBpcyBhbnN3ZXJhYmxlIGZyb20gdGhlIHRyYWlsIGl0c2VsZiByYXRoZXIgdGhhblxuICogZnJvbSB3aG9ldmVyIGhhcHBlbmVkIHRvIHJlYWQgdGhlIGNvbnNvbGUgdGhhdCBkYXkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG5vdGVRdWFyYW50aW5lKFxuICBzZWdtZW50OiBzdHJpbmcsXG4gIGRhbWFnZWQ6IHsgcGF0aDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnNvbGUuZXJyb3IoXG4gICAgYFtTRUNVUklUWV0gW0FVRElUX0pPVVJOQUxfUVVBUkFOVElORURdICR7ZGFtYWdlZC5wYXRofTogJHtkYW1hZ2VkLnJlYXNvbn0gYCArXG4gICAgICBg4oCUIGxlZnQgaW50YWN0IGFzIGV2aWRlbmNlIGFuZCBzdGlsbCBmYWlsaW5nIHRoZSBzd2VlcDsgcmVjb3JkaW5nIGAgK1xuICAgICAgYGNvbnRpbnVlcyBpbiAke3NlZ21lbnR9YCxcbiAgKTtcbiAgLy8gQWxyZWFkeSBpbnNpZGUgdGhlIGRpcmVjdG9yeSBsb2NrIChJc3N1ZSAjNDkxKTogcmUtZW50ZXJpbmcgaXQgaGVyZVxuICAvLyB3b3VsZCBkZWFkbG9jaywgYW5kIHRoZSBub3RlIGlzIHBhcnQgb2YgdGhlIHNhbWUgY3JpdGljYWwgc2VjdGlvbi5cbiAgYXdhaXQgYXBwZW5kRW50cnkoc2VnbWVudCwge1xuICAgIHJ1bklkOiByZXNvbHZlUnVuSWQoKSxcbiAgICB2ZXJiOiBBVURJVF9KT1VSTkFMX1FVQVJBTlRJTkVEX1ZFUkIsXG4gICAgdGFyZ2V0OiBkYW1hZ2VkLnBhdGguc2xpY2UoZGFtYWdlZC5wYXRoLmxhc3RJbmRleE9mKFwiL1wiKSArIDEpLFxuICAgIG91dGNvbWU6IFwiZXJyb3JcIixcbiAgICBjYWxsZXI6IGRhbWFnZWQucmVhc29uLFxuICB9KTtcbn1cblxuLyoqXG4gKiBMb2FkIGV2ZXJ5IGVudHJ5IGZyb20gYSBqb3VybmFsIGZpbGUgaW4gb3JkZXIuXG4gKlxuICogQHBhcmFtIHBhdGggLSBKb3VybmFsIGZpbGUgcGF0aFxuICogQHJldHVybnMgUmVzdWx0IHdpdGggdGhlIHBhcnNlZCBlbnRyaWVzLCBvciBhbiBlcnJvciBvbiBJTyBmYWlsdXJlXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkRW50cmllcyhwYXRoOiBzdHJpbmcpOiBQcm9taXNlPFJlc3VsdDxBdWRpdEVudHJ5W10+PiB7XG4gIGxldCBjb250ZW50OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgY29udGVudCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHBhdGgpO1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoYEF1ZGl0IGpvdXJuYWwgbm90IGZvdW5kOiAke3BhdGh9YCksXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IGVudHJpZXM6IEF1ZGl0RW50cnlbXSA9IFtdO1xuICBjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoXCJcXG5cIik7XG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmIChsaW5lLnRyaW0oKS5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgIHRyeSB7XG4gICAgICBlbnRyaWVzLnB1c2goSlNPTi5wYXJzZShsaW5lKSBhcyBBdWRpdEVudHJ5KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG5ldyBFcnJvcihgTWFsZm9ybWVkIGpvdXJuYWwgbGluZTogJHtsaW5lfWApIH07XG4gICAgfVxuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogZW50cmllcyB9O1xufVxuXG4vKipcbiAqIFZlcmlmeSBhIGpvdXJuYWwgZmlsZSdzIGhhc2ggY2hhaW4gZW5kLXRvLWVuZCwgYW5kIGNyb3NzLWNoZWNrIGl0XG4gKiBhZ2FpbnN0IGl0cyBjaGFpbiBhbmNob3IuXG4gKlxuICogUmV0dXJucyBgb2s6IGZhbHNlYCBvbmx5IGZvciBJTyBmYWlsdXJlcyB0aGUgYW5jaG9yIGNhbm5vdCBleHBsYWluIChhblxuICogdW5yZWFkYWJsZSBkaXJlY3RvcnksIHNheSkuIEEgYnJva2VuIGNoYWluIOKAlCBpbmNsdWRpbmcgYSB0cnVuY2F0ZWQgdGFpbCxcbiAqIGEgZGVsZXRlZCBqb3VybmFsLCBvciBhIG1pc3NpbmcgYW5jaG9yIOKAlCByZXR1cm5zIGBvazogdHJ1ZWAgd2l0aFxuICogYHZhbGlkOiBmYWxzZWAgYW5kIGEgcmVhc29uLCBzbyBjYWxsZXJzIGNhbiBkaXN0aW5ndWlzaCBcImNvdWxkIG5vdCByZWFkXCJcbiAqIGZyb20gXCJyZWFkIGFuZCB0YW1wZXJlZFwiLlxuICpcbiAqIEBwYXJhbSBwYXRoIC0gSm91cm5hbCBmaWxlIHBhdGhcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHZlcmlmeUNoYWluKFxuICBwYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxDaGFpblZlcmlmaWNhdGlvbj4+IHtcbiAgbGV0IGFuY2hvcjogQ2hhaW5BbmNob3IgfCBudWxsO1xuICB0cnkge1xuICAgIGFuY2hvciA9IGF3YWl0IHJlYWRBbmNob3IocGF0aCk7XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHtcbiAgICAgICAgdmFsaWQ6IGZhbHNlLFxuICAgICAgICBjb3VudDogMCxcbiAgICAgICAgcmVhc29uOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICBsZXQgY29udGVudDogc3RyaW5nO1xuICB0cnkge1xuICAgIGNvbnRlbnQgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkge1xuICAgICAgLy8gQW4gYW5jaG9yIHRoYXQgcmVjb3JkcyBubyBlbnRyaWVzICphbmQqIGRlY2xhcmVzIGFuIGFwcGVuZCBpc1xuICAgICAgLy8gd2hhdCBhIHdyaXRlciBraWxsZWQgYmVmb3JlIGl0cyBmaXJzdCBsaW5lIGxlYXZlcyBiZWhpbmQgKElzc3VlXG4gICAgICAvLyAjMTA3NCk6IGl0IGFuY2hvcnMgbm90aGluZywgc28gdGhlcmUgaXMgbm90aGluZyB0byBiZSBtaXNzaW5nLlxuICAgICAgLy8gV2l0aG91dCB0aGUgZGVjbGFyYXRpb24gaXQgaXMgc3RpbGwgYSBkZWxldGlvbiwgYW5kIHN0aWxsIHJlZC5cbiAgICAgIC8vXG4gICAgICAvLyBUaGUgYW5jaG9yIGFsb25lIGNhbm5vdCBjYXJyeSB0aGF0IHZlcmRpY3QsIGJlY2F1c2UgaXQgaXMgcGxhaW5cbiAgICAgIC8vIEpTT04gYW4gYXR0YWNrZXIgbWF5IHJld3JpdGU6IFwiZGVsZXRlIHRoZSBqb3VybmFsLCB0aGVuIGRlY2xhcmVcbiAgICAgIC8vIGl0IGVtcHR5IGFuZCBpbi1mbGlnaHRcIiB3b3VsZCBsYXVuZGVyIGFuIGVyYXN1cmUgaW50byBhIGNsZWFuXG4gICAgICAvLyBzd2VlcC4gVGhlIHJvc3RlciBpcyB0aGUgaW5kZXBlbmRlbnQgd2l0bmVzcyAoSXNzdWUgIzM5NDkpIOKAlFxuICAgICAgLy8gYGFkZFRvUm9zdGVyYCBydW5zIG9ubHkgKmFmdGVyKiBhbiBhcHBlbmQgaGFzIGxhbmRlZCwgc28gYVxuICAgICAgLy8gam91cm5hbCB0aGF0IHdhcyBuZXZlciBzdWNjZXNzZnVsbHkgd3JpdHRlbiB0byBpcyBhYnNlbnQgZnJvbSBpdCxcbiAgICAgIC8vIHdoaWxlIG9uZSB0aGF0IGV2ZXIgaGVsZCBhbiBlbnRyeSBpcyBvbiBpdCBmb3IgZ29vZC4gQSBtaXNzaW5nXG4gICAgICAvLyBqb3VybmFsIHRoYXQgdGhlIHJvc3RlciBleHBlY3RzIGlzIGEgZGVsZXRpb24sIHdoYXRldmVyIGl0c1xuICAgICAgLy8gYW5jaG9yIHNheXMuXG4gICAgICBpZiAoYW5jaG9yICYmIGFuY2hvci5jb3VudCA9PT0gMCAmJiBhbmNob3IucGVuZGluZykge1xuICAgICAgICBjb25zdCBiYXNlRGlyID0gcGF0aC5zbGljZSgwLCBwYXRoLmxhc3RJbmRleE9mKFwiL1wiKSkgfHwgXCIuXCI7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBwYXRoLnNsaWNlKHBhdGgubGFzdEluZGV4T2YoXCIvXCIpICsgMSk7XG4gICAgICAgIGxldCBleHBlY3RlZDogYm9vbGVhbjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBleHBlY3RlZCA9IChhd2FpdCByZWFkUm9zdGVyQ29udGVudHMoYmFzZURpcikpLmpvdXJuYWxzLmluY2x1ZGVzKFxuICAgICAgICAgICAgbmFtZSxcbiAgICAgICAgICApO1xuICAgICAgICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgICAgICAgIC8vIEEgY29ycnVwdGVkIHJvc3RlciBpcyBhIHRhbXBlciBzaWduYWwsIG5ldmVyIGEgc2lsZW50IHBhc3MuXG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSksXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWV4cGVjdGVkKSB7XG4gICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IHZhbGlkOiB0cnVlLCBjb3VudDogMCB9IH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChhbmNob3IpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgdmFsaWQ6IGZhbHNlLFxuICAgICAgICAgICAgY291bnQ6IDAsXG4gICAgICAgICAgICByZWFzb246XG4gICAgICAgICAgICAgIGBqb3VybmFsIGRlbGV0ZWQg4oCUIGFuY2hvciByZWNvcmRzICR7YW5jaG9yLmNvdW50fSBlbnRyaWVzIHdpdGggYCArXG4gICAgICAgICAgICAgIGBoZWFkICR7YW5jaG9yLmhlYWRIYXNoLnNsaWNlKDAsIDEyKX1gLFxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoYEF1ZGl0IGpvdXJuYWwgbm90IGZvdW5kOiAke3BhdGh9YCksXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KFwiXFxuXCIpLmZpbHRlcigobCkgPT4gbC50cmltKCkubGVuZ3RoID4gMCk7XG4gIGxldCBwcmV2ID0gXCJcIjtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXTtcbiAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuICAgIGxldCBlbnRyeTogQXVkaXRFbnRyeTtcbiAgICB0cnkge1xuICAgICAgZW50cnkgPSBKU09OLnBhcnNlKGxpbmUpIGFzIEF1ZGl0RW50cnk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgdmFsdWU6IHtcbiAgICAgICAgICB2YWxpZDogZmFsc2UsXG4gICAgICAgICAgY291bnQ6IGxpbmVzLmxlbmd0aCxcbiAgICAgICAgICBicm9rZW5JbmRleDogaSxcbiAgICAgICAgICByZWFzb246IFwibWFsZm9ybWVkIEpTT05cIixcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChlbnRyeS5wcmV2SGFzaCAhPT0gcHJldikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIHZhbHVlOiB7XG4gICAgICAgICAgdmFsaWQ6IGZhbHNlLFxuICAgICAgICAgIGNvdW50OiBsaW5lcy5sZW5ndGgsXG4gICAgICAgICAgYnJva2VuSW5kZXg6IGksXG4gICAgICAgICAgcmVhc29uOiBcInByZXZIYXNoIGxpbmthZ2UgbWlzbWF0Y2hcIixcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNvbnN0IGV4cGVjdGVkID0gYXdhaXQgY29tcHV0ZUVudHJ5SGFzaChlbnRyeSwgcHJldik7XG4gICAgaWYgKGV4cGVjdGVkICE9PSBlbnRyeS5oYXNoKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgdmFsdWU6IHtcbiAgICAgICAgICB2YWxpZDogZmFsc2UsXG4gICAgICAgICAgY291bnQ6IGxpbmVzLmxlbmd0aCxcbiAgICAgICAgICBicm9rZW5JbmRleDogaSxcbiAgICAgICAgICByZWFzb246IFwiaGFzaCBtaXNtYXRjaFwiLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgcHJldiA9IGVudHJ5Lmhhc2g7XG4gIH1cblxuICAvLyBUaGUgY2hhaW4gaXMgaW50ZXJuYWxseSBjb25zaXN0ZW50IOKAlCBub3cgY2hlY2sgd2hhdCB0aGUgY2hhaW4gYWxvbmVcbiAgLy8gY2Fubm90IHNlZTogYSB0cnVuY2F0ZWQgdGFpbCwgb3IgYW4gYW5jaG9yIHRoYXQgd2FzIHJlbW92ZWQgd2l0aCBpdC5cbiAgaWYgKCFhbmNob3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZToge1xuICAgICAgICB2YWxpZDogZmFsc2UsXG4gICAgICAgIGNvdW50OiBsaW5lcy5sZW5ndGgsXG4gICAgICAgIHJlYXNvbjogYGNoYWluIGFuY2hvciBtaXNzaW5nOiAke2FuY2hvclBhdGgocGF0aCl9YCxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuICBpZiAobGluZXMubGVuZ3RoIDwgYW5jaG9yLmNvdW50KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHtcbiAgICAgICAgdmFsaWQ6IGZhbHNlLFxuICAgICAgICBjb3VudDogbGluZXMubGVuZ3RoLFxuICAgICAgICBicm9rZW5JbmRleDogbGluZXMubGVuZ3RoLFxuICAgICAgICByZWFzb246IGBqb3VybmFsIHRydW5jYXRlZCDigJQgJHtsaW5lcy5sZW5ndGh9IGVudHJpZXMgcHJlc2VudCwgYW5jaG9yIGAgK1xuICAgICAgICAgIGByZWNvcmRzICR7YW5jaG9yLmNvdW50fWAsXG4gICAgICB9LFxuICAgIH07XG4gIH1cbiAgLy8gSXNzdWUgIzM5NDk6IHRoZSBhbmNob3IgaXMgdGhlIG9ubHkgdHJ1dGggZm9yIHdoZXJlIHRoZSBjaGFpbiBlbmRzLiBBXG4gIC8vIGNvcnJlY3RseS1jaGFpbmVkIGVudHJ5IGFwcGVuZGVkIGFmdGVyIHRoZSBhbmNob3JlZCBoZWFkIHByZXZpb3VzbHlcbiAgLy8gdmVyaWZpZWQgY2xlYW47IGl0IGlzIHVuYW5jaG9yZWQgY29udGVudCBhbmQgbXVzdCBiZSByZXBvcnRlZC5cbiAgaWYgKGxpbmVzLmxlbmd0aCA+IGFuY2hvci5jb3VudCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIHZhbGlkOiBmYWxzZSxcbiAgICAgICAgY291bnQ6IGxpbmVzLmxlbmd0aCxcbiAgICAgICAgYnJva2VuSW5kZXg6IGFuY2hvci5jb3VudCxcbiAgICAgICAgcmVhc29uOiBgZW50cmllcyBhcHBlbmRlZCBwYXN0IHRoZSBhbmNob3Ig4oCUICR7bGluZXMubGVuZ3RofSBlbnRyaWVzIGAgK1xuICAgICAgICAgIGBwcmVzZW50LCBhbmNob3IgcmVjb3JkcyAke2FuY2hvci5jb3VudH1gLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG4gIGlmIChhbmNob3IuY291bnQgPiAwICYmIGhhc2hBdChsaW5lcywgYW5jaG9yLmNvdW50IC0gMSkgIT09IGFuY2hvci5oZWFkSGFzaCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIHZhbGlkOiBmYWxzZSxcbiAgICAgICAgY291bnQ6IGxpbmVzLmxlbmd0aCxcbiAgICAgICAgYnJva2VuSW5kZXg6IGFuY2hvci5jb3VudCAtIDEsXG4gICAgICAgIHJlYXNvbjogXCJhbmNob3IgaGVhZCBoYXNoIG1pc21hdGNoXCIsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgdmFsaWQ6IHRydWUsIGNvdW50OiBsaW5lcy5sZW5ndGggfSB9O1xufVxuXG4vKipcbiAqIEFkb3B0IHRoZSBjdXJyZW50IGNvbnRlbnRzIG9mIGEgam91cm5hbCBhcyBpdHMgY2hhaW4gYW5jaG9yLlxuICpcbiAqIEV4cGxpY2l0IG9wZXJhdG9yIGFjdGlvbiwgbmVlZGVkIG9uY2UgZm9yIGEgam91cm5hbCB3cml0dGVuIGJlZm9yZSB0aGVcbiAqIGFuY2hvciBleGlzdGVkIChvciBhZnRlciBhbiBhbmNob3Igd2FzIGxvc3QpLiBUaGUgam91cm5hbCdzIG93biBjaGFpblxuICogbXVzdCB2ZXJpZnkgZmlyc3QsIHNvIGEgdGFtcGVyZWQgZmlsZSBjYW4gbmV2ZXIgYmUgYmxlc3NlZCBieSBhZG9wdGlvbi5cbiAqXG4gKiBAcGFyYW0gcGF0aCAtIEpvdXJuYWwgZmlsZSBwYXRoXG4gKiBAcmV0dXJucyBSZXN1bHQgY2FycnlpbmcgdGhlIHdyaXR0ZW4gYW5jaG9yXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhZG9wdEFuY2hvcihwYXRoOiBzdHJpbmcpOiBQcm9taXNlPFJlc3VsdDxDaGFpbkFuY2hvcj4+IHtcbiAgY29uc3QgbGluZXMgPSBhd2FpdCByZWFkSm91cm5hbExpbmVzKHBhdGgpLmNhdGNoKCgpID0+IG51bGwpO1xuICBpZiAobGluZXMgPT09IG51bGwpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBuZXcgRXJyb3IoYEF1ZGl0IGpvdXJuYWwgbm90IGZvdW5kOiAke3BhdGh9YCkgfTtcbiAgfVxuXG4gIC8vIFdhbGsgdGhlIGNoYWluIGl0c2VsZiBiZWZvcmUgdHJ1c3RpbmcgaXQuIHZlcmlmeUNoYWluIHdvdWxkIGZhaWwgb25cbiAgLy8gdGhlIChleHBlY3RlZCkgbWlzc2luZyBhbmNob3IsIHNvIHRoZSBsaW5rYWdlIGlzIHJlLXdhbGtlZCBoZXJlLlxuICBsZXQgcHJldiA9IFwiXCI7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBsaW5lID0gbGluZXNbaV07XG4gICAgaWYgKCFsaW5lKSBjb250aW51ZTtcbiAgICBsZXQgZW50cnk6IEF1ZGl0RW50cnk7XG4gICAgdHJ5IHtcbiAgICAgIGVudHJ5ID0gSlNPTi5wYXJzZShsaW5lKSBhcyBBdWRpdEVudHJ5O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKGBjYW5ub3QgYWRvcHQgJHtwYXRofTogbWFsZm9ybWVkIEpTT04gYXQgZW50cnkgJHtpfWApLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKGVudHJ5LnByZXZIYXNoICE9PSBwcmV2KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYGNhbm5vdCBhZG9wdCAke3BhdGh9OiBwcmV2SGFzaCBsaW5rYWdlIG1pc21hdGNoIGF0IGVudHJ5ICR7aX1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKGF3YWl0IGNvbXB1dGVFbnRyeUhhc2goZW50cnksIHByZXYpICE9PSBlbnRyeS5oYXNoKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoYGNhbm5vdCBhZG9wdCAke3BhdGh9OiBoYXNoIG1pc21hdGNoIGF0IGVudHJ5ICR7aX1gKSxcbiAgICAgIH07XG4gICAgfVxuICAgIHByZXYgPSBlbnRyeS5oYXNoO1xuICB9XG5cbiAgY29uc3Qgd3JpdHRlbiA9IGF3YWl0IHdyaXRlQW5jaG9yKHBhdGgsIHtcbiAgICBjb3VudDogbGluZXMubGVuZ3RoLFxuICAgIGhlYWRIYXNoOiBwcmV2LFxuICB9KTtcbiAgaWYgKCF3cml0dGVuLm9rKSByZXR1cm4gd3JpdHRlbjtcbiAgLy8gTm8gY2FjaGUgdG8gaW52YWxpZGF0ZSBzaW5jZSBJc3N1ZSAjNDkxOiB0aGUgbmV4dCBhcHBlbmQgcmVhZHMgdGhlXG4gIC8vIGZyZXNobHkgd3JpdHRlbiBhbmNob3IgZnJvbSBkaXNrLlxuXG4gIC8vIElzc3VlICMzOTQ5OiBhbiBhZG9wdGVkIGpvdXJuYWwgaXMgYW4gZXhwZWN0ZWQgam91cm5hbCBmcm9tIGhlcmUgb24uXG4gIGNvbnN0IHNsYXNoID0gcGF0aC5sYXN0SW5kZXhPZihcIi9cIik7XG4gIGNvbnN0IHJvc3RlcmVkID0gYXdhaXQgYWRkVG9Sb3N0ZXIoXG4gICAgc2xhc2ggPiAtMSA/IHBhdGguc2xpY2UoMCwgc2xhc2gpIDogXCIuXCIsXG4gICAgcGF0aC5zbGljZShzbGFzaCArIDEpLFxuICApO1xuICBpZiAoIXJvc3RlcmVkLm9rKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBhbmNob3IgYWRvcHRlZCBidXQgdGhlIGpvdXJuYWwgcm9zdGVyIGNvdWxkIG5vdCBiZSB1cGRhdGVkOiBgICtcbiAgICAgICAgICByb3N0ZXJlZC5lcnJvci5tZXNzYWdlLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB3cml0dGVuO1xufVxuXG4vKipcbiAqIFZlcmIgcmVjb3JkZWQgaW4gdGhlIGNoYWluIHdoZW4gZGFtYWdlIHRvIGEgcHJlc2VudCBqb3VybmFsIGlzIHNpZ25lZFxuICogZm9yIChJc3N1ZSAjNDkxKS5cbiAqXG4gKiBHcmVwcGFibGUgaW4gdGhlIGpvdXJuYWwgaXRzZWxmLCBhbmQgaW4gZXZlcnkgZG93bnN0cmVhbSBjb25zdW1lciBvZiB0aGVcbiAqIGF1ZGl0IHRyYWlsLCBzbyBcIndobyBzaWxlbmNlZCB3aGljaCBhbGFybVwiIGlzIGFuc3dlcmFibGUgZnJvbSB0aGUgY2hhaW5cbiAqIHJhdGhlciB0aGFuIGZyb20gYSBzaWRlY2FyIGFsb25lLlxuICovXG5leHBvcnQgY29uc3QgQVVESVRfREFNQUdFX0FDS05PV0xFREdFRF9WRVJCID0gXCJhdWRpdC1kYW1hZ2UtYWNrbm93bGVkZ2VkXCI7XG5cbi8qKlxuICogU0hBLTI1NiBvZiBhIGpvdXJuYWwncyBieXRlcywgd2l0aCBpdHMgZW50cnkgY291bnQuXG4gKlxuICogVGhlIGRpZ2VzdCBjb3ZlcnMgdGhlIHdob2xlIGZpbGUsIG5vdCB0aGUgY2hhaW4sIHNvIGl0IGNoYW5nZXMgb24gYW55XG4gKiBlZGl0IGF0IGFsbCDigJQgaW5jbHVkaW5nIG9uZSB0aGF0IGxlYXZlcyB0aGUgY2hhaW4ganVzdCBhcyBicm9rZW4uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGpvdXJuYWxEaWdlc3QocGF0aDogc3RyaW5nKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nPj4ge1xuICB0cnkge1xuICAgIGNvbnN0IGJ5dGVzID0gYXdhaXQgRGVuby5yZWFkRmlsZShwYXRoKTtcbiAgICBjb25zdCBkaWdlc3QgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmRpZ2VzdChcIlNIQS0yNTZcIiwgYnl0ZXMpO1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiBBcnJheS5mcm9tKG5ldyBVaW50OEFycmF5KGRpZ2VzdCkpXG4gICAgICAgIC5tYXAoKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSlcbiAgICAgICAgLmpvaW4oXCJcIiksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKiBJbnB1dHMgZm9yIHtAbGluayBhY2tub3dsZWRnZUpvdXJuYWxEYW1hZ2V9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBY2tub3dsZWRnZURhbWFnZVBhcmFtcyB7XG4gIC8qKiBBdWRpdCBkaXJlY3RvcnkgdGhlIHJvc3RlciBjb3ZlcnMuICovXG4gIGJhc2VEaXI6IHN0cmluZztcbiAgLyoqIEJhc2VuYW1lIG9mIHRoZSBkYW1hZ2VkIGpvdXJuYWwgYmVpbmcgc2lnbmVkIGZvci4gKi9cbiAgam91cm5hbE5hbWU6IHN0cmluZztcbiAgLyoqIFdoeSB0aGUgZGFtYWdlIGlzIGFjY291bnRlZCBmb3IuIE11c3Qgbm90IGJlIGJsYW5rLiAqL1xuICByZWFzb246IHN0cmluZztcbiAgLyoqIFdobyBpcyBzaWduaW5nIGZvciBpdC4gTXVzdCBub3QgYmUgYmxhbmsuICovXG4gIGJ5OiBzdHJpbmc7XG59XG5cbi8qKlxuICogU2lnbiBmb3IgYSBqb3VybmFsIHRoYXQgaXMgcHJlc2VudCBidXQgZG9lcyBub3QgdmVyaWZ5IChJc3N1ZSAjNDkxKS5cbiAqXG4gKiBUaGUgY3Jvc3MtcHJvY2VzcyBhcHBlbmQgcmFjZSBsZWZ0IHRlbiBqb3VybmFscyBvbiBHUlEtMjMgd2l0aCBhblxuICogb3JwaGFuZWQgaGVhZCBoYXNoLiBGaXhpbmcgdGhlIHdyaXRlciBzdG9wcyBuZXcgZGFtYWdlOyBpdCBjYW5ub3QgcmVwYWlyXG4gKiB0aGUgZXhpc3RpbmcgZmlsZXMsIGFuZCByZXBhaXJpbmcgdGhlbSBpcyB0aGUgbGFzdCB0aGluZyBhbnlvbmUgc2hvdWxkXG4gKiB3YW50IOKAlCB0aGV5IGFyZSB0aGUgZXZpZGVuY2UuIEJ1dCBgLS1hY2tub3dsZWRnZS1sb3NzYCByZWZ1c2VzIHRoZW0gYnlcbiAqIGRlc2lnbiAob25seSBhIGpvdXJuYWwgdGhhdCBpcyBnZW51aW5lbHkgKmdvbmUqIGNhbiBiZSBzaWduZWQgZm9yKSwgc29cbiAqIHRoZSBob3N0IHdhcyBsZWZ0IHdpdGggYSBwZXJtYW5lbnQgYFtTRUNVUklUWV1gIGFsYXJtIGFuZCBubyBkb2N1bWVudGVkXG4gKiB3YXkgb3V0LiBBbiBhbGFybSB0aGF0IGNhbiBuZXZlciBiZSBjbGVhcmVkIGlzIGFuIGFsYXJtIG5vYm9keSByZWFkcyxcbiAqIHdoaWNoIGlzIHRoZSBmYWlsdXJlIElzc3VlICMzNTkgYWxyZWFkeSBpZGVudGlmaWVkIGZvciBsb3NzZXMuXG4gKlxuICogVGhpcyBpcyB0aGUgZXhpdCBmb3IgZGFtYWdlLCBhbmQgaXQgaXMgbmFycm93ZXIgdGhhbiB0aGUgbG9zcyBwYXRoOlxuICpcbiAqICAgLSB0aGUgam91cm5hbCBtdXN0IGJlICoqb24gZGlzayoqIOKAlCBhIG1pc3Npbmcgam91cm5hbCBpcyBhIGxvc3MsIGFuZFxuICogICAgIGBhY2tub3dsZWRnZUpvdXJuYWxMb3NzYCBpcyB3aGVyZSB0aGF0IGlzIHNpZ25lZCBmb3IsXG4gKiAgIC0gaXQgbXVzdCAqKmFjdHVhbGx5IGZhaWwqKiB2ZXJpZmljYXRpb24uIEEgam91cm5hbCB0aGF0IHZlcmlmaWVzIGhhc1xuICogICAgIG5vdGhpbmcgdG8gc2lnbiBmb3IsIGFuZCBhY2NlcHRpbmcgb25lIHdvdWxkIGxldCBhbiBvcGVyYXRvclxuICogICAgIHByZS1zaWduIGEgZmlsZSB0aGV5IHdlcmUgYWJvdXQgdG8gZGFtYWdlLFxuICogICAtIGEgKipyZWFzb24qKiBhbmQgYW4gKipvcGVyYXRvciBpZGVudGl0eSoqIGFyZSByZXF1aXJlZCxcbiAqICAgLSB0aGUgc2lnbmF0dXJlIGlzICoqcGlubmVkIHRvIHRoZSBqb3VybmFsJ3MgZXhhY3QgYnl0ZXMqKi4gVGhlIHN3ZWVwXG4gKiAgICAgaG9ub3VycyBpdCBvbmx5IHdoaWxlIHRoZSBmaWxlIHN0aWxsIGhhc2hlcyB0byB0aGUgcmVjb3JkZWQgZGlnZXN0LFxuICogICAgIHNvIHRoaXMgY2xvc2VzIHRvZGF5J3MgZmluZGluZyB3aXRob3V0IGJsZXNzaW5nIHRvbW9ycm93J3MgZWRpdCxcbiAqICAgLSBhbmQgdGhlIGFjdCBpcyB3cml0dGVuIGludG8gdGhlIGhhc2ggY2hhaW4gKipmaXJzdCoqLCBpbiB0aGVcbiAqICAgICBjdXJyZW50bHktd3JpdGFibGUgam91cm5hbCwgc28gd2hvIHNpbGVuY2VkIHdoYXQgaXMgaXRzZWxmIGNoYWluZWQuXG4gKlxuICogVGhlIGRhbWFnZWQgam91cm5hbCBpcyBuZXZlciBtb2RpZmllZCwgcmUtYW5jaG9yZWQsIG9yIHJlbW92ZWQuXG4gKlxuICogQHBhcmFtIHBhcmFtcyAtIFdoaWNoIGpvdXJuYWwsIHdoeSwgYW5kIG9uIHdob3NlIGF1dGhvcml0eVxuICogQHBhcmFtIG9wdHMgLSBTdG9yYWdlIG92ZXJyaWRlcyBmb3IgdGhlIGNoYWluZWQgcmVjb3JkIChtYWlubHkgdGVzdHMpXG4gKiBAcmV0dXJucyBSZXN1bHQgY2FycnlpbmcgdGhlIHBlcnNpc3RlZCBhY2tub3dsZWRnZW1lbnRcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFja25vd2xlZGdlSm91cm5hbERhbWFnZShcbiAgcGFyYW1zOiBBY2tub3dsZWRnZURhbWFnZVBhcmFtcyxcbiAgb3B0czogUmVjb3JkT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8Um9zdGVyRGFtYWdlQWNrbm93bGVkZ2VtZW50Pj4ge1xuICBjb25zdCB7IGJhc2VEaXIsIGpvdXJuYWxOYW1lLCByZWFzb24sIGJ5IH0gPSBwYXJhbXM7XG4gIGNvbnN0IHBhdGggPSBgJHtiYXNlRGlyfS8ke2pvdXJuYWxOYW1lfWA7XG5cbiAgLy8gSXNzdWUgIzEyMDI6IGV2ZXJ5IHdyaXRlIGJlbG93IGV2ZW50dWFsbHkgYXBwZW5kcyB0byB0aGUgcm9zdGVyLCBzbyBhXG4gIC8vIHJvc3RlciB0b3JuIGJ5IGEga2lsbCB3b3VsZCBibG9jayB0aGlzIGV4aXQgYmVmb3JlIGl0IGJlZ2FuLiBSZXBhaXJcbiAgLy8gdGhhdCBvbmUgc2hhcGUgZmlyc3Q7IGFueSBvdGhlciB1bnJlYWRhYmxlIHJvc3RlciBzdGlsbCBmYWlscyBsb3VkLlxuICBjb25zdCBoZWFsZWQgPSBhd2FpdCBoZWFsUm9zdGVyKGJhc2VEaXIpO1xuICBpZiAoIWhlYWxlZC5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogaGVhbGVkLmVycm9yIH07XG5cbiAgaWYgKCFhd2FpdCBwYXRoRXhpc3RzKHBhdGgpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBhY2tub3dsZWRnZSBkYW1hZ2UgdG8gJHtqb3VybmFsTmFtZX06IGl0IGlzIG5vdCBvbiBgICtcbiAgICAgICAgICBgZGlzayDigJQgYSBqb3VybmFsIHRoYXQgaXMgZ29uZSBpcyBhIGxvc3MsIHNpZ25lZCBmb3Igd2l0aCBgICtcbiAgICAgICAgICBgLS1hY2tub3dsZWRnZS1sb3NzLCBub3QgZGFtYWdlYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdmVyaWZ5Q2hhaW4ocGF0aCk7XG4gIGlmICh2ZXJpZmllZC5vayAmJiB2ZXJpZmllZC52YWx1ZS52YWxpZCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gYWNrbm93bGVkZ2UgZGFtYWdlIHRvICR7am91cm5hbE5hbWV9OiBpdHMgY2hhaW4gYCArXG4gICAgICAgICAgYHZlcmlmaWVzIOKAlCB0aGVyZSBpcyBub3RoaW5nIHRvIHNpZ24gZm9yLCBhbmQgYSBzaWduYXR1cmUgdGFrZW4gYCArXG4gICAgICAgICAgYG5vdyB3b3VsZCBjb3ZlciBkYW1hZ2UgdGhhdCBoYXMgbm90IGhhcHBlbmVkIHlldGAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBkaWdlc3QgPSBhd2FpdCBqb3VybmFsRGlnZXN0KHBhdGgpO1xuICBpZiAoIWRpZ2VzdC5vaykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gYWNrbm93bGVkZ2UgZGFtYWdlIHRvICR7am91cm5hbE5hbWV9OiBpdHMgYnl0ZXMgY291bGQgYCArXG4gICAgICAgICAgYG5vdCBiZSByZWFkLCBzbyB0aGUgc2lnbmF0dXJlIGNvdWxkIG5vdCBiZSBwaW5uZWQgdG8gdGhlbTogYCArXG4gICAgICAgICAgYCR7ZGlnZXN0LmVycm9yLm1lc3NhZ2V9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBjb25zdCBlbnRyaWVzID0gdmVyaWZpZWQub2sgPyB2ZXJpZmllZC52YWx1ZS5jb3VudCA6IDA7XG5cbiAgLy8gVGhlIGNoYWluIHJlY29yZCBjb21lcyBmaXJzdCwgYXMgaXQgZG9lcyBmb3IgYSBsb3NzOiBhIGZhaWx1cmUgaGVyZVxuICAvLyBsZWF2ZXMgdGhlIGFsYXJtIHNvdW5kaW5nLCB3aGljaCBpcyB0aGUgc2FmZSBkaXJlY3Rpb24gdG8gZmFpbCBpbi5cbiAgY29uc3QgcmVjb3JkZWQgPSBhd2FpdCByZWNvcmRNdXRhdGlvbih7XG4gICAgcnVuSWQ6IHJlc29sdmVSdW5JZCgpLFxuICAgIHZlcmI6IEFVRElUX0RBTUFHRV9BQ0tOT1dMRURHRURfVkVSQixcbiAgICB0YXJnZXQ6IGpvdXJuYWxOYW1lLFxuICAgIG91dGNvbWU6IFwic3VjY2Vzc1wiLFxuICAgIGNhbGxlcjogYCR7Ynl9OiAke3JlYXNvbn1gLFxuICB9LCB7IC4uLm9wdHMsIGJhc2VEaXIgfSk7XG4gIGlmICghcmVjb3JkZWQub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYHJlZnVzaW5nIHRvIGFja25vd2xlZGdlIGRhbWFnZSB0byAke2pvdXJuYWxOYW1lfTogdGhlIGAgK1xuICAgICAgICAgIGBhY2tub3dsZWRnZW1lbnQgY291bGQgbm90IGJlIHJlY29yZGVkIGluIHRoZSBhdWRpdCBjaGFpbiwgc28gaXQgYCArXG4gICAgICAgICAgYHdpbGwgbm90IGJlIHJlY29yZGVkIGluIHRoZSByb3N0ZXIgZWl0aGVyOiBgICtcbiAgICAgICAgICBgJHtyZWNvcmRlZC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4gYXdhaXQgYWNrbm93bGVkZ2VSb3N0ZXJEYW1hZ2UoXG4gICAgYmFzZURpcixcbiAgICBqb3VybmFsTmFtZSxcbiAgICByZWFzb24sXG4gICAgYnksXG4gICAgZGlnZXN0LnZhbHVlLFxuICAgIGVudHJpZXMsXG4gICk7XG59XG5cbi8qKlxuICogVmVyYiByZWNvcmRlZCBpbiB0aGUgY2hhaW4gd2hlbiBhIGpvdXJuYWwgbG9zcyBpcyBzaWduZWQgZm9yIChJc3N1ZVxuICogIzM1OSkuIFNlZSB7QGxpbmsgQVVESVRfREFNQUdFX0FDS05PV0xFREdFRF9WRVJCfSBmb3IgdGhlIGRhbWFnZVxuICogY291bnRlcnBhcnQg4oCUIHRoZSB0d28gYXJlIGRlbGliZXJhdGVseSBkaXN0aW5jdCB2ZXJicy5cbiAqL1xuZXhwb3J0IGNvbnN0IEFVRElUX0xPU1NfQUNLTk9XTEVER0VEX1ZFUkIgPSBcImF1ZGl0LWxvc3MtYWNrbm93bGVkZ2VkXCI7XG5cbi8qKiBJbnB1dHMgZm9yIHtAbGluayBhY2tub3dsZWRnZUpvdXJuYWxMb3NzfS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQWNrbm93bGVkZ2VMb3NzUGFyYW1zIHtcbiAgLyoqIEF1ZGl0IGRpcmVjdG9yeSB0aGUgcm9zdGVyIGNvdmVycy4gKi9cbiAgYmFzZURpcjogc3RyaW5nO1xuICAvKiogQmFzZW5hbWUgb2YgdGhlIGpvdXJuYWwgd2hvc2UgbG9zcyBpcyBiZWluZyBzaWduZWQgZm9yLiAqL1xuICBqb3VybmFsTmFtZTogc3RyaW5nO1xuICAvKiogV2h5IGl0IGlzIGdvbmUuIE11c3Qgbm90IGJlIGJsYW5rIOKAlCBhbiB1bmV4cGxhaW5lZCBsb3NzIHN0YXlzIGxvdWQuICovXG4gIHJlYXNvbjogc3RyaW5nO1xuICAvKiogV2hvIGlzIHNpZ25pbmcgZm9yIGl0LiBNdXN0IG5vdCBiZSBibGFuay4gKi9cbiAgYnk6IHN0cmluZztcbn1cblxuLyoqXG4gKiBTaWduIGZvciBhIGpvdXJuYWwgdGhhdCBpcyBnZW51aW5lbHkgZ29uZSAoSXNzdWUgIzM1OSkuXG4gKlxuICogSXNzdWUgIzMzNyBoYWQgdGhlIHdvcmstdm9sdW1lIGhvdXNla2VlcGluZyBwcnVuZSB0aGUgd29ya2VyJ3Mgb3duIGF1ZGl0XG4gKiBkaXJlY3RvcnkuIFRoYXQgYnVnIGlzIGZpeGVkLCBidXQgdGhlIGZpeCBjb3VsZCBvbmx5IHN0b3AgZnVydGhlciBsb3NzZXMg4oCUXG4gKiBvbiBob3N0cyBhbHJlYWR5IHN3ZXB0LCB0aGUgcm9zdGVyIGtlcHQgZXhwZWN0aW5nIHRocmVlIGpvdXJuYWxzIHRoYXQgbm9cbiAqIGxvbmdlciBleGlzdCwgc28gYGF1ZGl0LWNoYWluLXZlcmlmeWAgZmFpbGVkIG9uIGV2ZXJ5IHdvcmtlciBzdGFydCwgZm9yXG4gKiBldmVyLiBUaGUgb25seSBleGl0cyB3ZXJlIGEgaHVtYW4gZWRpdGluZyB0aGUgdGFtcGVyLWV2aWRlbmNlIGZpbGUgYnkgaGFuZFxuICogb3IgcmVidWlsZGluZyB0aGUgY29udGFpbmVyOiB0ZWFjaGluZyBvcGVyYXRvcnMgdG8gaGFuZC1lZGl0IHRoZSByb3N0ZXJcbiAqIGRlc3Ryb3lzIHRoZSB2ZXJ5IHdpdG5lc3MgaXQgaXMgdGhlcmUgdG8gYmUuXG4gKlxuICogVGhpcyBpcyB0aGUgc3VwcG9ydGVkIGV4aXQsIGFuZCBpdCBpcyBkZWxpYmVyYXRlbHkgbmFycm93OlxuICpcbiAqICAgLSB0aGUgam91cm5hbCBtdXN0IGJlICoqb24gdGhlIHJvc3RlcioqIOKAlCB5b3UgY2Fubm90IHByZS1hY2tub3dsZWRnZSBhXG4gKiAgICAgam91cm5hbCB0aGF0IHdhcyBuZXZlciBleHBlY3RlZCxcbiAqICAgLSBpdCBtdXN0IGJlICoqYWJzZW50IGZyb20gZGlzayoqLCBqb3VybmFsIGFuZCBhbmNob3IgYm90aCDigJQgYSBqb3VybmFsXG4gKiAgICAgdGhhdCBpcyBwcmVzZW50IGJ1dCB0cnVuY2F0ZWQsIHJld3JpdHRlbiBvciBoYXNoLWJyb2tlbiBpcyBuZXZlclxuICogICAgIGFja25vd2xlZGdlYWJsZSBhbmQga2VlcHMgZmFpbGluZyB0aGUgc3dlZXAgZXhhY3RseSBhcyBiZWZvcmUsXG4gKiAgIC0gYSAqKnJlYXNvbioqIGFuZCBhbiAqKm9wZXJhdG9yIGlkZW50aXR5KiogYXJlIHJlcXVpcmVkLFxuICogICAtIGFuZCB0aGUgYWN0IGlzIHdyaXR0ZW4gaW50byB0aGUgaGFzaCBjaGFpbiAqKmZpcnN0KiouIElmIHRoZSBjaGFpblxuICogICAgIGFwcGVuZCBmYWlscywgbm90aGluZyBpcyBhY2tub3dsZWRnZWQgYW5kIHRoZSBhbGFybSBrZWVwcyBzb3VuZGluZztcbiAqICAgICB0aGUgc2lkZWNhciBpcyBuZXZlciBzaWxlbmNlZCB3aXRob3V0IGEgY2hhaW5lZCByZWNvcmQgb2Ygd2hvIGRpZCBpdC5cbiAqXG4gKiBJdCBpcyBub3QsIGFuZCBkb2VzIG5vdCBjbGFpbSB0byBiZSwgdW5mb3JnZWFibGU6IGEgcHJpbmNpcGFsIHdobyBjYW5cbiAqIGFwcGVuZCB0byB0aGUgcm9zdGVyIGNhbiBhbHJlYWR5IGRlbGV0ZSBpdCwgd2hpY2ggdHJpcHMgdGhlIGNvbXBsZXRlLVxuICogZXJhc3VyZSBhbGFybSBpbnN0ZWFkLiBXaGF0IGl0IGNoYW5nZXMgaXMgdGhhdCBhbiBhY2NvdW50ZWQtZm9yIGxvc3Mgc3RvcHNcbiAqIGJlaW5nIGFuIGFub255bW91cyByZWN1cnJpbmcgYWxhcm0gYW5kIGJlY29tZXMgYSBkYXRlZCwgYXR0cmlidXRlZCxcbiAqIHJldmlld2FibGUgcmVjb3JkIOKAlCBzbyBhICpuZXcqIGRlbGV0aW9uIG9uIHRoZSBzYW1lIGhvc3QgaXMgb25jZSBhZ2FpbiB0aGVcbiAqIG9ubHkgcmVkIGxpbmUgaW4gdGhlIHN3ZWVwLlxuICpcbiAqIEBwYXJhbSBwYXJhbXMgLSBXaGljaCBqb3VybmFsLCB3aHksIGFuZCBvbiB3aG9zZSBhdXRob3JpdHlcbiAqIEBwYXJhbSBvcHRzIC0gU3RvcmFnZSBvdmVycmlkZXMgZm9yIHRoZSBjaGFpbmVkIHJlY29yZCAobWFpbmx5IHRlc3RzKVxuICogQHJldHVybnMgUmVzdWx0IGNhcnJ5aW5nIHRoZSBwZXJzaXN0ZWQgYWNrbm93bGVkZ2VtZW50XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhY2tub3dsZWRnZUpvdXJuYWxMb3NzKFxuICBwYXJhbXM6IEFja25vd2xlZGdlTG9zc1BhcmFtcyxcbiAgb3B0czogUmVjb3JkT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8Um9zdGVyQWNrbm93bGVkZ2VtZW50Pj4ge1xuICBjb25zdCB7IGJhc2VEaXIsIGpvdXJuYWxOYW1lLCByZWFzb24sIGJ5IH0gPSBwYXJhbXM7XG5cbiAgbGV0IHJvc3RlcmVkOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICAvLyBJc3N1ZSAjMTIwMjogYSByb3N0ZXIgdG9ybiBieSBhIGtpbGwgd291bGQgb3RoZXJ3aXNlIGJsb2NrIHRoaXMgZXhpdFxuICAgIC8vIG91dHJpZ2h0IOKAlCBpdCBpcyByZWFkIGhlcmUgYW5kIGFwcGVuZGVkIHRvIGJlbG93IOKAlCBsZWF2aW5nIG5vIHdheSBvdXRcbiAgICAvLyBidXQgaGFuZC1lZGl0aW5nIHRoZSB0YW1wZXItZXZpZGVuY2UgZmlsZS5cbiAgICByb3N0ZXJlZCA9IChhd2FpdCByZWFkUm9zdGVySGVhbGVkKGJhc2VEaXIpKS5jb250ZW50cy5qb3VybmFscztcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG4gIGlmICghcm9zdGVyZWQuaW5jbHVkZXMoam91cm5hbE5hbWUpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBhY2tub3dsZWRnZSAke2pvdXJuYWxOYW1lfTogaXQgaXMgbm90IG9uIHRoZSByb3N0ZXIgZm9yIGAgK1xuICAgICAgICAgIGAke2Jhc2VEaXJ9LCBzbyBub3RoaW5nIGV4cGVjdHMgaXRgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3Qgam91cm5hbFRoZXJlID0gYXdhaXQgcGF0aEV4aXN0cyhgJHtiYXNlRGlyfS8ke2pvdXJuYWxOYW1lfWApO1xuICBjb25zdCBhbmNob3JUaGVyZSA9IGF3YWl0IHBhdGhFeGlzdHMoYW5jaG9yUGF0aChgJHtiYXNlRGlyfS8ke2pvdXJuYWxOYW1lfWApKTtcbiAgaWYgKGpvdXJuYWxUaGVyZSB8fCBhbmNob3JUaGVyZSkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gYWNrbm93bGVkZ2UgJHtqb3VybmFsTmFtZX06IGl0IGlzIHN0aWxsIG9uIGRpc2sgYCArXG4gICAgICAgICAgYCgke2pvdXJuYWxUaGVyZSA/IFwiam91cm5hbFwiIDogXCJhbmNob3JcIn0gcHJlc2VudCkg4oCUIG9ubHkgYSBqb3VybmFsIGAgK1xuICAgICAgICAgIGB0aGF0IGlzIGdlbnVpbmVseSBnb25lIGNhbiBiZSBzaWduZWQgZm9yLCBuZXZlciBvbmUgd2hvc2UgY2hhaW4gYCArXG4gICAgICAgICAgYHNpbXBseSBkb2VzIG5vdCB2ZXJpZnlgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gVGhlIGNoYWluIHJlY29yZCBjb21lcyBmaXJzdCwgZGVsaWJlcmF0ZWx5LiBBIGZhaWx1cmUgaGVyZSBsZWF2ZXMgdGhlXG4gIC8vIGFsYXJtIHNvdW5kaW5nLCB3aGljaCBpcyB0aGUgc2FmZSBkaXJlY3Rpb24gdG8gZmFpbCBpbi5cbiAgY29uc3QgcmVjb3JkZWQgPSBhd2FpdCByZWNvcmRNdXRhdGlvbih7XG4gICAgcnVuSWQ6IHJlc29sdmVSdW5JZCgpLFxuICAgIHZlcmI6IEFVRElUX0xPU1NfQUNLTk9XTEVER0VEX1ZFUkIsXG4gICAgdGFyZ2V0OiBqb3VybmFsTmFtZSxcbiAgICBvdXRjb21lOiBcInN1Y2Nlc3NcIixcbiAgICBjYWxsZXI6IGAke2J5fTogJHtyZWFzb259YCxcbiAgfSwgeyAuLi5vcHRzLCBiYXNlRGlyIH0pO1xuICBpZiAoIXJlY29yZGVkLm9rKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBhY2tub3dsZWRnZSAke2pvdXJuYWxOYW1lfTogdGhlIGFja25vd2xlZGdlbWVudCBjb3VsZCBgICtcbiAgICAgICAgICBgbm90IGJlIHJlY29yZGVkIGluIHRoZSBhdWRpdCBjaGFpbiwgc28gaXQgd2lsbCBub3QgYmUgcmVjb3JkZWQgYCArXG4gICAgICAgICAgYGluIHRoZSByb3N0ZXIgZWl0aGVyOiAke3JlY29yZGVkLmVycm9yLm1lc3NhZ2V9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiBhd2FpdCBhY2tub3dsZWRnZVJvc3Rlckxvc3MoYmFzZURpciwgam91cm5hbE5hbWUsIHJlYXNvbiwgYnkpO1xufVxuXG4vKipcbiAqIFNldHRsZSBhbiBpbnRlcnJ1cHRlZCBhcHBlbmQgd2hpbGUgaG9sZGluZyB0aGUgYXVkaXQtZGlyZWN0b3J5IGxvY2suXG4gKlxuICogVGhlIHN3ZWVwIGRvZXMgbm90IG90aGVyd2lzZSB0YWtlIHRoZSBsb2NrLCBidXQgdGhlIHJlY292ZXJ5IHJld3JpdGVzXG4gKiB0aGUgYW5jaG9yIGFuZCBtYXkgdHJ1bmNhdGUgdGhlIGpvdXJuYWwsIHNvIGl0IG11c3Qgbm90IHJ1biBiZXNpZGUgYVxuICogbGl2ZSBhcHBlbmRlciAoSXNzdWUgIzQ5MSdzIHJ1bGUgYXBwbGllcyB0byBldmVyeSB3cml0ZXIsIGluY2x1ZGluZ1xuICogdGhpcyBvbmUpLlxuICpcbiAqIEBwYXJhbSBiYXNlRGlyIC0gQXVkaXQgZGlyZWN0b3J5IGhvbGRpbmcgdGhlIGpvdXJuYWwgYW5kIGl0cyBsb2NrXG4gKiBAcGFyYW0gcGF0aCAtIEpvdXJuYWwgdG8gc2V0dGxlXG4gKiBAcmV0dXJucyBSZXN1bHQgY2FycnlpbmcgdGhlIHJlY292ZXJ5IHBlcmZvcm1lZCwgb3IgYG51bGxgIHdoZW4gdGhlcmVcbiAqICAgd2FzIG5vdGhpbmcgdG8gc2V0dGxlXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNldHRsZUFwcGVuZFVuZGVyTG9jayhcbiAgYmFzZURpcjogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxBcHBlbmRSZWNvdmVyeSB8IG51bGw+PiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IHdpdGhGaWxlTG9jayhcbiAgICAgIGF1ZGl0TG9ja1BhdGgoYmFzZURpciksXG4gICAgICAoKSA9PiBzZXR0bGVJbnRlcnJ1cHRlZEFwcGVuZChwYXRoKSxcbiAgICApO1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFN0cmluZyhlcnJvcikpLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBTZXR0bGUgYSB0b3JuIHJvc3RlciBsaW5lIHdoaWxlIGhvbGRpbmcgdGhlIGF1ZGl0LWRpcmVjdG9yeSBsb2NrLlxuICpcbiAqIFRoZSBsb2NrIGxpdmVzICppbnNpZGUqIHRoZSBhdWRpdCBkaXJlY3Rvcnkgd2hpbGUgdGhlIHJvc3RlciBsaXZlc1xuICogYmVzaWRlIGl0LCBzbyBhIGRpcmVjdG9yeSB0aGF0IGhhcyBiZWVuIHJlbW92ZWQgaGFzIG5vIGxvY2sgdG8gdGFrZSDigJRcbiAqIGFuZCBubyBhcHBlbmRlciB0byBleGNsdWRlIGVpdGhlciwgc2luY2UgZXZlcnkgcm9zdGVyIHdyaXRlciBjcmVhdGVzIHRoZVxuICogZGlyZWN0b3J5IGJlZm9yZSBpdCB3cml0ZXMuIFRoZSByZXBhaXIgdGhlbiBydW5zIGRpcmVjdGx5LCBhbmQgcmVmdXNlc1xuICogdG8gdHJ1bmNhdGUgYSByb3N0ZXIgdGhhdCBncmV3IHVuZGVybmVhdGggaXQuXG4gKlxuICogQHBhcmFtIGJhc2VEaXIgLSBBdWRpdCBkaXJlY3RvcnkgdGhlIHJvc3RlciBjb3ZlcnNcbiAqIEByZXR1cm5zIFJlc3VsdCBjYXJyeWluZyB0aGUgcmVwYWlyIHBlcmZvcm1lZCwgb3IgYG51bGxgIHdoZW4gdGhlcmUgd2FzXG4gKiAgIG5vdGhpbmcgdG8gc2V0dGxlXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNldHRsZVJvc3RlclVuZGVyTG9jayhcbiAgYmFzZURpcjogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8Um9zdGVyUmVjb3ZlcnkgfCBudWxsPj4ge1xuICB0cnkge1xuICAgIGlmICghYXdhaXQgcGF0aEV4aXN0cyhiYXNlRGlyKSkgcmV0dXJuIGF3YWl0IHNldHRsZVRvcm5Sb3N0ZXJMaW5lKGJhc2VEaXIpO1xuICAgIHJldHVybiBhd2FpdCB3aXRoRmlsZUxvY2soXG4gICAgICBhdWRpdExvY2tQYXRoKGJhc2VEaXIpLFxuICAgICAgKCkgPT4gc2V0dGxlVG9yblJvc3RlckxpbmUoYmFzZURpciksXG4gICAgKTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogUmVhZCB0aGUgcm9zdGVyLCByZXBhaXJpbmcgYSB0b3JuIGZpbmFsIGxpbmUgZmlyc3QgaWYgdGhhdCBpcyB3aGF0IGlzXG4gKiB3cm9uZyB3aXRoIGl0IChJc3N1ZSAjMTIwMikuXG4gKlxuICogRXZlcnkgcmVhZGVyIG9mIHRoZSByb3N0ZXIgdGhhdCBhIHRvcm4gbGluZSBsb2NrcyBvdXQgZ29lcyB0aHJvdWdoIGhlcmU6XG4gKiB0aGUgc3dlZXAsIGFuZCBib3RoIGFja25vd2xlZGdlbWVudCBleGl0cy4gQSByb3N0ZXIgdGhhdCBmYWlscyBmb3IgYW55XG4gKiBvdGhlciByZWFzb24ga2VlcHMgaXRzIG9yaWdpbmFsIGVycm9yIOKAlCBub3RoaW5nIGlzIHJlcGFpcmVkIG9uIHRoZVxuICogc3RyZW5ndGggb2YgYSBzZWNvbmQgbG9vay5cbiAqXG4gKiBAcGFyYW0gYmFzZURpciAtIEF1ZGl0IGRpcmVjdG9yeSB0aGUgcm9zdGVyIGNvdmVyc1xuICogQHJldHVybnMgVGhlIHJvc3RlciBjb250ZW50cywgcGx1cyB0aGUgcmVwYWlyIHBlcmZvcm1lZCB0byByZWFkIHRoZW1cbiAqIEB0aHJvd3MgVGhlIG9yaWdpbmFsIHJlYWQgZXJyb3Igd2hlbiBubyByZXBhaXIgYXBwbGllZCwgb3IgdGhlIHNlY29uZFxuICogICByZWFkJ3MgZXJyb3Igd2hlbiBhIHJlcGFpciBkaWQgbm90IG1ha2UgdGhlIHJvc3RlciByZWFkYWJsZVxuICovXG5hc3luYyBmdW5jdGlvbiByZWFkUm9zdGVySGVhbGVkKFxuICBiYXNlRGlyOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgY29udGVudHM6IFJvc3RlckNvbnRlbnRzOyByZXBhaXJlZDogUm9zdGVyUmVjb3ZlcnkgfCBudWxsIH0+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4geyBjb250ZW50czogYXdhaXQgcmVhZFJvc3RlckNvbnRlbnRzKGJhc2VEaXIpLCByZXBhaXJlZDogbnVsbCB9O1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBzZXR0bGVSb3N0ZXJVbmRlckxvY2soYmFzZURpcik7XG4gICAgaWYgKCFzZXR0bGVkLm9rKSB7XG4gICAgICAvLyBMb3VkLCBhbmQgdGhlIG9yaWdpbmFsIHZlcmRpY3Qgc3RhbmRzOiB0aGUgcm9zdGVyIGlzIHN0aWxsXG4gICAgICAvLyB1bnJlYWRhYmxlIGZvciBpdHMgb3JpZ2luYWwgcmVhc29uLiBTaWxlbmNlIGhlcmUgd291bGQgcmVhZCBhc1xuICAgICAgLy8gXCJub3RoaW5nIHRvIHNldHRsZVwiLlxuICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgYFtTRUNVUklUWV0gW0FVRElUX1JPU1RFUl9SRUNPVkVSWV9GQUlMRURdICR7cm9zdGVyUGF0aChiYXNlRGlyKX06IGEgYCArXG4gICAgICAgICAgYHRvcm4gcm9zdGVyIGxpbmUgY291bGQgbm90IGJlIHNldHRsZWQ6ICR7c2V0dGxlZC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICApO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICAgIGlmICghc2V0dGxlZC52YWx1ZSkgdGhyb3cgZXJyb3I7XG4gICAgY29uc29sZS5lcnJvcihmb3JtYXRSb3N0ZXJSZWNvdmVyeShzZXR0bGVkLnZhbHVlKSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnRzOiBhd2FpdCByZWFkUm9zdGVyQ29udGVudHMoYmFzZURpciksXG4gICAgICByZXBhaXJlZDogc2V0dGxlZC52YWx1ZSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogUmVwYWlyIGEgdG9ybiByb3N0ZXIgbGluZSBiZWZvcmUgYSB3cml0ZXIgbmVlZHMgdGhlIHJvc3RlciAoSXNzdWUgIzEyMDIpLlxuICpcbiAqIEBwYXJhbSBiYXNlRGlyIC0gQXVkaXQgZGlyZWN0b3J5IHRoZSByb3N0ZXIgY292ZXJzXG4gKiBAcmV0dXJucyBSZXN1bHQ7IG9rIHdoZW4gdGhlIHJvc3RlciBpcyByZWFkYWJsZSAoYWxyZWFkeSBvciBhZnRlciB0aGVcbiAqICAgcmVwYWlyKSwgYW4gZXJyb3IgY2FycnlpbmcgdGhlIG9yaWdpbmFsIHJlYWQgZmFpbHVyZSBvdGhlcndpc2VcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGVhbFJvc3RlcihiYXNlRGlyOiBzdHJpbmcpOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICB0cnkge1xuICAgIGF3YWl0IHJlYWRSb3N0ZXJIZWFsZWQoYmFzZURpcik7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKiBEb2VzIGBwYXRoYCBleGlzdD8gQW55IHN0YXQgZXJyb3Igb3RoZXIgdGhhbiBhYnNlbmNlIGlzIHByb3BhZ2F0ZWQgdXAuICovXG5hc3luYyBmdW5jdGlvbiBwYXRoRXhpc3RzKHBhdGg6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8uc3RhdChwYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIGZhbHNlO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5cbi8qKiBTd2VlcCB2ZXJkaWN0IGZvciBjb21wbGV0ZSBlcmFzdXJlIG9mIHRoZSBqb3VybmFsIGRpcmVjdG9yeSBhbmQgcm9zdGVyLiAqL1xuZnVuY3Rpb24gY29tcGxldGVFcmFzdXJlU3dlZXAoXG4gIGRpcjogc3RyaW5nLFxuICByb3N0ZXJSZXBhaXJlZD86IFJvc3RlclJlY292ZXJ5LFxuKTogUmVzdWx0PENoYWluU3dlZXA+IHtcbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICB2YWx1ZToge1xuICAgICAgYmFzZURpcjogZGlyLFxuICAgICAgY2hlY2tlZDogMSxcbiAgICAgIGFja25vd2xlZGdlZDogW10sXG4gICAgICByZWNvdmVyZWQ6IFtdLFxuICAgICAgLi4uKHJvc3RlclJlcGFpcmVkID8geyByb3N0ZXJSZXBhaXJlZCB9IDoge30pLFxuICAgICAgYnJva2VuOiBbe1xuICAgICAgICBwYXRoOiBkaXIsXG4gICAgICAgIHZhbGlkOiBmYWxzZSxcbiAgICAgICAgY291bnQ6IDAsXG4gICAgICAgIHJlYXNvbjpcbiAgICAgICAgICBcImF1ZGl0IGRpcmVjdG9yeSBhbmQgcm9zdGVyIGFyZSBib3RoIG1pc3NpbmcgYnV0IGEgbGFzdC1rbm93bi1ub24tZW1wdHkgbWFya2VyIHJlY29yZHMgdGhhdCBqb3VybmFscyBleGlzdGVkIOKAlCBjb21wbGV0ZSBlcmFzdXJlXCIsXG4gICAgICB9XSxcbiAgICB9LFxuICB9O1xufVxuXG4vKiogSm91cm5hbCBmaWxlbmFtZSBjb250cmFjdCBzaGFyZWQgYnkgdGhlIHZlcmlmaWVyIGFuZCBldmlkZW5jZSBjb25zdW1lcnMuICovXG5leHBvcnQgZnVuY3Rpb24gaXNBdWRpdEpvdXJuYWxOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gL15hdWRpdC0uKlxcLmpzb25sJC8udGVzdChuYW1lKTtcbn1cblxuLyoqXG4gKiBWZXJpZnkgZXZlcnkgYXVkaXQgY2hhaW4gdW5kZXIgYGJhc2VEaXJgIOKAlCB0aGUgc2NoZWR1bGVkIHN3ZWVwLlxuICpcbiAqIEFuY2hvcnMgYXJlIGVudW1lcmF0ZWQgYWxvbmdzaWRlIGpvdXJuYWxzIHNvIGEgam91cm5hbCB0aGF0IHdhcyBkZWxldGVkXG4gKiBvdXRyaWdodCBpcyBzdGlsbCBpbnNwZWN0ZWQgKGFuZCBmbGFnZ2VkKSByYXRoZXIgdGhhbiBzaW1wbHkgdmFuaXNoaW5nXG4gKiBmcm9tIHRoZSBzd2VlcC4gVGhlIGV4cGVjdGVkLWpvdXJuYWwgcm9zdGVyIChJc3N1ZSAjMzk0OSkg4oCUIHBlcnNpc3RlZCBhc1xuICogYSBzaWJsaW5nIG9mIHRoZSBhdWRpdCBkaXJlY3Rvcnkg4oCUIGlzIGZvbGRlZCBpbiBhcyB3ZWxsLCBzbyBhIGpvdXJuYWxcbiAqIGRlbGV0ZWQgKip0b2dldGhlciB3aXRoKiogaXRzIGFuY2hvciwgb3IgYW4gYHJtIC1yZmAgb2YgdGhlIHdob2xlIGF1ZGl0XG4gKiBkaXJlY3RvcnksIGlzIGEgYnJva2VuIGNoYWluIHJhdGhlciB0aGFuIGFuIGVtcHR5IHN3ZWVwLiBBIGxhc3Qta25vd24tXG4gKiBub24tZW1wdHkgbWFya2VyIChJc3N1ZSAjMjcwKSBjb3ZlcnMgdGhlIHJlbWFpbmluZyBob2xlOiBkZWxldGluZyB0aGVcbiAqIGRpcmVjdG9yeSAqKmFuZCoqIHRoZSByb3N0ZXIgdG9nZXRoZXIuXG4gKlxuICogQHBhcmFtIGJhc2VEaXIgLSBBdWRpdCBkaXJlY3RvcnkgKGRlZmF1bHQ6IHJlc29sdmVkIGZyb20gdGhlIGVudmlyb25tZW50KVxuICogQHBhcmFtIG9wdGlvbnMucmVjb3ZlckludGVycnVwdGVkQXBwZW5kcyAtIERlZmF1bHRzIHRvIGB0cnVlYCBmb3IgdGhlXG4gKiAgIHNjaGVkdWxlZCBzd2VlcDsgcmVwb3J0aW5nIHBhc3NlcyBgZmFsc2VgIHNvIHZlcmlmaWNhdGlvbiBuZXZlciB3cml0ZXMuXG4gKiBAcmV0dXJucyBSZXN1bHQgY2FycnlpbmcgdGhlIHN3ZWVwIHZlcmRpY3Q7IGFuIGFic2VudCBkaXJlY3RvcnkgaXMgYVxuICogICBjbGVhbiwgZW1wdHkgc3dlZXAgb25seSB3aGVuIG5vdGhpbmcgd2FzIGV2ZXIgb2JzZXJ2ZWRcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHZlcmlmeUFsbENoYWlucyhcbiAgYmFzZURpcj86IHN0cmluZyxcbiAgb3B0aW9uczogeyByZWNvdmVySW50ZXJydXB0ZWRBcHBlbmRzPzogYm9vbGVhbiB9ID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxDaGFpblN3ZWVwPj4ge1xuICBjb25zdCBkaXIgPSByZXNvbHZlQmFzZURpcihiYXNlRGlyKTtcbiAgY29uc3Qgam91cm5hbHNPbkRpc2sgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgYW5jaG9yc09uRGlzayA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGxldCByb3N0ZXJlZDogc3RyaW5nW107XG4gIGxldCBhY2tub3dsZWRnZW1lbnRzOiBNYXA8c3RyaW5nLCBSb3N0ZXJBY2tub3dsZWRnZW1lbnQ+O1xuICBsZXQgZGFtYWdlQWNrbm93bGVkZ2VtZW50czogTWFwPHN0cmluZywgUm9zdGVyRGFtYWdlQWNrbm93bGVkZ2VtZW50PjtcbiAgbGV0IHNlZW46IGJvb2xlYW47XG4gIC8vIElzc3VlICMxMjAyOiBhIHJvc3RlciB3aG9zZSBmaW5hbCBsaW5lIHdhcyB0b3JuIGJ5IGEga2lsbCBpcyByZXBhaXJlZFxuICAvLyBoZXJlLCBiZWZvcmUgaXQgY2FuIGZhaWwgdGhlIHdob2xlIGRpcmVjdG9yeSdzIHN3ZWVwLiBPbmx5IHRoYXQgb25lXG4gIC8vIHNoYXBlIGlzIHJlcGFpcmVkOyBldmVyeSBvdGhlciB1bnJlYWRhYmxlIHJvc3RlciBzdGlsbCBmYWlscyBsb3VkLlxuICBsZXQgcm9zdGVyUmVwYWlyZWQ6IFJvc3RlclJlY292ZXJ5IHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGNvbnN0IHJlY292ZXIgPSBvcHRpb25zLnJlY292ZXJJbnRlcnJ1cHRlZEFwcGVuZHMgIT09IGZhbHNlO1xuICAgIGNvbnN0IGhlYWxlZCA9IHJlY292ZXJcbiAgICAgID8gYXdhaXQgcmVhZFJvc3RlckhlYWxlZChkaXIpXG4gICAgICA6IHsgY29udGVudHM6IGF3YWl0IHJlYWRSb3N0ZXJDb250ZW50cyhkaXIpLCByZXBhaXJlZDogbnVsbCB9O1xuICAgIHJvc3RlclJlcGFpcmVkID0gaGVhbGVkLnJlcGFpcmVkID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjb250ZW50cyA9IGhlYWxlZC5jb250ZW50cztcbiAgICByb3N0ZXJlZCA9IGNvbnRlbnRzLmpvdXJuYWxzO1xuICAgIGFja25vd2xlZGdlbWVudHMgPSBjb250ZW50cy5hY2tub3dsZWRnZWQ7XG4gICAgZGFtYWdlQWNrbm93bGVkZ2VtZW50cyA9IGNvbnRlbnRzLmRhbWFnZWQ7XG4gICAgc2VlbiA9IGF3YWl0IHJvc3Rlcldhc1NlZW4oZGlyKTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAvLyBBIGNvcnJ1cHRlZCByb3N0ZXIgb3Igc2Vlbi1tYXJrZXIgaXMgYSB0YW1wZXIgc2lnbmFsIGluIGl0cyBvd24gcmlnaHQuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSksXG4gICAgfTtcbiAgfVxuXG4gIGxldCBkaXJNaXNzaW5nID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgZm9yIGF3YWl0IChjb25zdCBpdGVtIG9mIERlbm8ucmVhZERpcihkaXIpKSB7XG4gICAgICBpZiAoaXRlbS5pc0ZpbGUgJiYgaXNBdWRpdEpvdXJuYWxOYW1lKGl0ZW0ubmFtZSkpIHtcbiAgICAgICAgam91cm5hbHNPbkRpc2suYWRkKGl0ZW0ubmFtZSk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIGlmICghKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSksXG4gICAgICB9O1xuICAgIH1cbiAgICAvLyBJc3N1ZSAjMzk0OTogYW4gYWJzZW50IGRpcmVjdG9yeSBpcyBhIGNsZWFuLCBlbXB0eSBzd2VlcCBvbmx5IHdoZW5cbiAgICAvLyBub3RoaW5nIHdhcyBldmVyIGpvdXJuYWxsZWQuIFdoZW4gdGhlIHJvc3RlciBleHBlY3RzIGpvdXJuYWxzLCB0aGVcbiAgICAvLyBkaXJlY3RvcnkncyByZW1vdmFsIGlzIHRoZSB0YW1wZXJpbmcsIG5vdCBhIGZyZXNoIHN0YXJ0LlxuICAgIC8vIElzc3VlICMyNzA6IGEgbWlzc2luZyByb3N0ZXIgYWZ0ZXIgYSBwcmV2aW91c2x5IG9ic2VydmVkIG5vbi1lbXB0eVxuICAgIC8vIG9uZSBpcyB0aGUgc2FtZSBlcmFzdXJlLCBub3QgYSBmaXJzdC1ldmVyIHN0YXJ0LlxuICAgIGlmIChyb3N0ZXJlZC5sZW5ndGggPT09IDApIHtcbiAgICAgIGlmIChzZWVuKSByZXR1cm4gY29tcGxldGVFcmFzdXJlU3dlZXAoZGlyLCByb3N0ZXJSZXBhaXJlZCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgdmFsdWU6IHtcbiAgICAgICAgICBiYXNlRGlyOiBkaXIsXG4gICAgICAgICAgY2hlY2tlZDogMCxcbiAgICAgICAgICBicm9rZW46IFtdLFxuICAgICAgICAgIGFja25vd2xlZGdlZDogW10sXG4gICAgICAgICAgcmVjb3ZlcmVkOiBbXSxcbiAgICAgICAgICAuLi4ocm9zdGVyUmVwYWlyZWQgPyB7IHJvc3RlclJlcGFpcmVkIH0gOiB7fSksXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBkaXJNaXNzaW5nID0gdHJ1ZTtcbiAgfVxuXG4gIGlmICghZGlyTWlzc2luZykge1xuICAgIHRyeSB7XG4gICAgICBmb3IgYXdhaXQgKGNvbnN0IGl0ZW0gb2YgRGVuby5yZWFkRGlyKGAke2Rpcn0vYW5jaG9yc2ApKSB7XG4gICAgICAgIGlmICghaXRlbS5pc0ZpbGUpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBqb3VybmFsID0gam91cm5hbE5hbWVGb3JBbmNob3IoaXRlbS5uYW1lKTtcbiAgICAgICAgaWYgKGpvdXJuYWwpIGFuY2hvcnNPbkRpc2suYWRkKGpvdXJuYWwpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgICBpZiAoIShlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFN0cmluZyhlcnJvcikpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KFtcbiAgICAuLi5qb3VybmFsc09uRGlzayxcbiAgICAuLi5hbmNob3JzT25EaXNrLFxuICAgIC4uLnJvc3RlcmVkLFxuICBdKTtcblxuICAvLyBJc3N1ZSAjMjcwOiBkaXJlY3RvcnkgcHJlc2VudCBidXQgZW1wdHkgb2Ygam91cm5hbHMvYW5jaG9ycywgcm9zdGVyXG4gIC8vIGdvbmUsIG1hcmtlciBzdGlsbCB0aGVyZSDigJQgdGhlIHNhbWUgY29tcGxldGUgZXJhc3VyZSBhcyBhIG1pc3NpbmcgZGlyLlxuICBpZiAobmFtZXMuc2l6ZSA9PT0gMCAmJiBzZWVuKSB7XG4gICAgcmV0dXJuIGNvbXBsZXRlRXJhc3VyZVN3ZWVwKGRpciwgcm9zdGVyUmVwYWlyZWQpO1xuICB9XG5cbiAgY29uc3QgYnJva2VuOiBDaGFpblN3ZWVwRW50cnlbXSA9IFtdO1xuICBjb25zdCBhY2tub3dsZWRnZWQ6IEFja25vd2xlZGdlZExvc3NbXSA9IFtdO1xuICBjb25zdCByZWNvdmVyZWQ6IEFwcGVuZFJlY292ZXJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIFsuLi5uYW1lc10uc29ydCgpKSB7XG4gICAgY29uc3QgcGF0aCA9IGAke2Rpcn0vJHtuYW1lfWA7XG5cbiAgICAvLyBSb3N0ZXJlZCB3aXRoIG5laXRoZXIgam91cm5hbCBub3IgYW5jaG9yIGxlZnQgb24gZGlzazogdGhlIHBhaXIgd2FzXG4gICAgLy8gZGVsZXRlZCB0b2dldGhlciAob3IgdGhlIGRpcmVjdG9yeSByZW1vdmVkKSwgd2hpY2ggaXMgZXhhY3RseSB0aGVcbiAgICAvLyBlcmFzdXJlIHRoZSByb3N0ZXIgZXhpc3RzIHRvIGV4cG9zZSAoSXNzdWUgIzM5NDkpLlxuICAgIGlmICgham91cm5hbHNPbkRpc2suaGFzKG5hbWUpICYmICFhbmNob3JzT25EaXNrLmhhcyhuYW1lKSkge1xuICAgICAgLy8gSXNzdWUgIzM1OTogdW5sZXNzIHRoZSBsb3NzIGhhcyBiZWVuIHNpZ25lZCBmb3IuIFRoZW4gaXQgaXMgYVxuICAgICAgLy8gY2xvc2VkIGZpbmRpbmcg4oCUIHN0aWxsIHJlcG9ydGVkIG9uIGV2ZXJ5IHN3ZWVwLCBubyBsb25nZXIgZmFpbGluZ1xuICAgICAgLy8gaXQuIE9ubHkgKnRoaXMqIHNoYXBlIG9mIGJyZWFrYWdlIGlzIGFja25vd2xlZGdlYWJsZTogYSBqb3VybmFsXG4gICAgICAvLyB0aGF0IGlzIHByZXNlbnQgYnV0IHRydW5jYXRlZCwgcmV3cml0dGVuLCBvciBoYXNoLWJyb2tlbiBmYWxsc1xuICAgICAgLy8gdGhyb3VnaCB0byBgdmVyaWZ5Q2hhaW5gIGJlbG93IGFuZCBjYW4gbmV2ZXIgYmUgc2lsZW5jZWQuXG4gICAgICBjb25zdCBhY2sgPSBhY2tub3dsZWRnZW1lbnRzLmdldChuYW1lKTtcbiAgICAgIGlmIChhY2spIHtcbiAgICAgICAgYWNrbm93bGVkZ2VkLnB1c2goeyBwYXRoLCBraW5kOiBcImxvc3NcIiwgYWNrbm93bGVkZ2VtZW50OiBhY2sgfSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYnJva2VuLnB1c2goe1xuICAgICAgICBwYXRoLFxuICAgICAgICB2YWxpZDogZmFsc2UsXG4gICAgICAgIGNvdW50OiAwLFxuICAgICAgICByZWFzb246IGRpck1pc3NpbmdcbiAgICAgICAgICA/IGBhdWRpdCBkaXJlY3RvcnkgbWlzc2luZyBidXQgdGhlIHJvc3RlciByZWNvcmRzIHRoaXMgam91cm5hbCDigJQgYCArXG4gICAgICAgICAgICBgZGlyZWN0b3J5IGRlbGV0ZWRgXG4gICAgICAgICAgOiBgam91cm5hbCBhbmQgaXRzIGFuY2hvciBhcmUgYm90aCBtaXNzaW5nIGJ1dCB0aGUgcm9zdGVyIHJlY29yZHMgYCArXG4gICAgICAgICAgICBgdGhpcyBqb3VybmFsIOKAlCBwYWlyIGRlbGV0ZWRgLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBJc3N1ZSAjMTA3NDogYSBqb3VybmFsIHRoYXQgZmFpbHMgb25seSBiZWNhdXNlIHRoZSB3cml0ZXIgd2FzIGtpbGxlZFxuICAgIC8vIG1pZC1hcHBlbmQgaXMgc2V0dGxlZCBoZXJlIOKAlCB0aGUgc3dlZXAgcnVucyBmaXJzdCBhdCBldmVyeSB3b3JrZXJcbiAgICAvLyBzdGFydCwgc28gYSBob3N0IHRoYXQgd2FzIGtpbGxlZCB2ZXJpZmllcyBjbGVhbiBvbiBpdHMgbmV4dCBydW5cbiAgICAvLyByYXRoZXIgdGhhbiBhc2tpbmcgYW4gb3BlcmF0b3IgdG8gc2lnbiBmb3IgdGhlIGtpbGwuIE9ubHkgam91cm5hbHNcbiAgICAvLyB0aGF0IGFscmVhZHkgZmFpbCBhcmUgdG91Y2hlZCwgYW5kIG9ubHkgcGFzdCB0aGUgYW5jaG9yZWQgaGVhZC5cbiAgICAvL1xuICAgIC8vIEEgam91cm5hbCBhbiBvcGVyYXRvciBoYXMgYWxyZWFkeSBzaWduZWQgZm9yIGlzIGxlZnQgYWxvbmU6IHRoZVxuICAgIC8vIHNpZ25hdHVyZSBpcyBwaW5uZWQgdG8gaXRzIGV4YWN0IGJ5dGVzLCBzbyBoZWFsaW5nIGl0IHdvdWxkIGxhcHNlXG4gICAgLy8gdGhlIHNpZ25hdHVyZSB0aGUgb3BlcmF0b3IgZ2F2ZSBhbmQgdHVybiBhIGNsb3NlZCBmaW5kaW5nIGJhY2sgaW50b1xuICAgIC8vIGEgcmVkIG9uZS5cbiAgICBsZXQgcmVzdWx0ID0gYXdhaXQgdmVyaWZ5Q2hhaW4ocGF0aCk7XG4gICAgaWYgKFxuICAgICAgb3B0aW9ucy5yZWNvdmVySW50ZXJydXB0ZWRBcHBlbmRzICE9PSBmYWxzZSAmJiByZXN1bHQub2sgJiZcbiAgICAgICFyZXN1bHQudmFsdWUudmFsaWQgJiYgIWRpck1pc3NpbmcgJiZcbiAgICAgICFkYW1hZ2VBY2tub3dsZWRnZW1lbnRzLmhhcyhuYW1lKVxuICAgICkge1xuICAgICAgY29uc3Qgc2V0dGxlZCA9IGF3YWl0IHNldHRsZUFwcGVuZFVuZGVyTG9jayhkaXIsIHBhdGgpO1xuICAgICAgaWYgKCFzZXR0bGVkLm9rKSB7XG4gICAgICAgIC8vIExvdWQsIGFuZCB0aGUgb3JpZ2luYWwgdmVyZGljdCBzdGFuZHM6IHRoZSBqb3VybmFsIGlzIHN0aWxsXG4gICAgICAgIC8vIGJyb2tlbiBmb3IgaXRzIG9yaWdpbmFsIHJlYXNvbiBhbmQgc3RpbGwgY2FycmllcyB0aGUgcmVtZWR5XG4gICAgICAgIC8vIHRoYXQgbmFtZXMgaXQuIFNpbGVuY2UgaGVyZSB3b3VsZCByZWFkIGFzIFwibm90aGluZyB0byBzZXR0bGVcIi5cbiAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICBgW1NFQ1VSSVRZXSBbQVVESVRfQVBQRU5EX1JFQ09WRVJZX0ZBSUxFRF0gJHtwYXRofTogYW4gYCArXG4gICAgICAgICAgICBgaW50ZXJydXB0ZWQgYXBwZW5kIGNvdWxkIG5vdCBiZSBzZXR0bGVkOiAke3NldHRsZWQuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIGlmIChzZXR0bGVkLnZhbHVlKSB7XG4gICAgICAgIHJlY292ZXJlZC5wdXNoKHNldHRsZWQudmFsdWUpO1xuICAgICAgICByZXN1bHQgPSBhd2FpdCB2ZXJpZnlDaGFpbihwYXRoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAgIGJyb2tlbi5wdXNoKHtcbiAgICAgICAgcGF0aCxcbiAgICAgICAgdmFsaWQ6IGZhbHNlLFxuICAgICAgICBjb3VudDogMCxcbiAgICAgICAgcmVhc29uOiByZXN1bHQuZXJyb3IubWVzc2FnZSxcbiAgICAgIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChyZXN1bHQudmFsdWUudmFsaWQpIGNvbnRpbnVlO1xuXG4gICAgLy8gSXNzdWUgIzQ5MTogYSBqb3VybmFsIHRoYXQgaXMgcHJlc2VudCBidXQgZG9lcyBub3QgdmVyaWZ5IGNhbiBiZVxuICAgIC8vIHNpZ25lZCBmb3Ig4oCUIGJ1dCBvbmx5IGFnYWluc3QgdGhlIGV4YWN0IGJ5dGVzIHRoYXQgd2VyZSBzaG93biB0b1xuICAgIC8vIHRoZSBvcGVyYXRvci4gSWYgdGhlIGZpbGUgaGFzIGNoYW5nZWQgc2luY2UsIHRoZSBzaWduYXR1cmUgbm9cbiAgICAvLyBsb25nZXIgY292ZXJzIGl0IGFuZCB0aGUgYWxhcm0gY29tZXMgYmFjaywgbmFtaW5nIHdoeS5cbiAgICBjb25zdCBkYW1hZ2UgPSBkYW1hZ2VBY2tub3dsZWRnZW1lbnRzLmdldChuYW1lKTtcbiAgICBpZiAoZGFtYWdlKSB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgam91cm5hbERpZ2VzdChwYXRoKTtcbiAgICAgIGlmIChjdXJyZW50Lm9rICYmIGN1cnJlbnQudmFsdWUgPT09IGRhbWFnZS5kaWdlc3QpIHtcbiAgICAgICAgYWNrbm93bGVkZ2VkLnB1c2goeyBwYXRoLCBraW5kOiBcImRhbWFnZVwiLCBhY2tub3dsZWRnZW1lbnQ6IGRhbWFnZSB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBicm9rZW4ucHVzaCh7XG4gICAgICAgIHBhdGgsXG4gICAgICAgIC4uLnJlc3VsdC52YWx1ZSxcbiAgICAgICAgcmVhc29uOiBgJHtyZXN1bHQudmFsdWUucmVhc29uID8/IFwiY2hhaW4gZG9lcyBub3QgdmVyaWZ5XCJ9IOKAlCB0aGUgYCArXG4gICAgICAgICAgYGRhbWFnZSBhY2tub3dsZWRnZW1lbnQgc2lnbmVkIGJ5ICR7ZGFtYWdlLmJ5fSBvbiBgICtcbiAgICAgICAgICBgJHtkYW1hZ2UuYWNrbm93bGVkZ2VkQXR9IG5vIGxvbmdlciBhcHBsaWVzOiB0aGUgam91cm5hbCBoYXMgYCArXG4gICAgICAgICAgYGNoYW5nZWQgc2luY2UgaXQgd2FzIHNpZ25lZCBmb3JgLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgYnJva2VuLnB1c2goeyBwYXRoLCAuLi5yZXN1bHQudmFsdWUgfSk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIHZhbHVlOiB7XG4gICAgICBiYXNlRGlyOiBkaXIsXG4gICAgICBjaGVja2VkOiBuYW1lcy5zaXplLFxuICAgICAgYnJva2VuLFxuICAgICAgYWNrbm93bGVkZ2VkLFxuICAgICAgcmVjb3ZlcmVkLFxuICAgICAgLi4uKHJvc3RlclJlcGFpcmVkID8geyByb3N0ZXJSZXBhaXJlZCB9IDoge30pLFxuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogUmVzZXQgaW4tcHJvY2VzcyBzdGF0ZS4gVGVzdC1vbmx5IGhlbHBlci5cbiAqXG4gKiBTaW5jZSBJc3N1ZSAjNDkxIHRoZXJlIGlzIG5vIGNoYWluLXN0YXRlIGNhY2hlIHRvIGNsZWFyIOKAlCB0aGUgaGVhZCBpc1xuICogcmVhZCBmcm9tIGRpc2sgb24gZXZlcnkgYXBwZW5kIOKAlCBzbyB0aGlzIG9ubHkgZHJvcHMgdGhlIHdyaXRlIHF1ZXVlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9yZXNldEF1ZGl0Q2FjaGVzKCk6IHZvaWQge1xuICB3cml0ZVF1ZXVlcy5jbGVhcigpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGlu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
// denoCacheMetadata=5239555433045059547,9831043122972533347