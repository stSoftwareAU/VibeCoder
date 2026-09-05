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
 * The journal lives OUTSIDE any repo working tree — under
 * `${WORK_DIR}/audit/` — so a bug in the worker that rewrites a repo's
 * history cannot rewrite the history of its own audit log. Files are
 * partitioned per worker and per UTC day:
 *   `${WORK_DIR}/audit/audit-<workerId>-YYYY-MM-DD.jsonl`
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
 */

import type { Result } from "../types.ts";
import {
  acknowledgeRosterDamage,
  acknowledgeRosterLoss,
  addToRoster,
  anchorPath,
  type ChainAnchor,
  journalNameForAnchor,
  readAnchor,
  readRosterContents,
  type RosterAcknowledgement,
  type RosterDamageAcknowledgement,
  rosterWasSeen,
  writeAnchor,
} from "./audit_anchor.ts";
import {
  type AppendRecovery,
  formatAppendRecovery,
  settleInterruptedAppend,
} from "./audit_append_recovery.ts";
import {
  type AuditEntry,
  type AuditMutation,
  type AuditOutcome,
  computeEntryHash,
} from "./audit_entry.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { withFileLock } from "./file_lock.ts";

// Entry shape and chain hashing live in `audit_entry.ts` since Issue #1074
// so the crash-recovery module can hash an entry without importing this
// one. Re-exported here: this module stays the front door.
export {
  type AuditEntry,
  type AuditMutation,
  type AuditOutcome,
  computeEntryHash,
};
export type { AppendRecovery };

/**
 * Raised when the journal on disk disagrees with its chain anchor —
 * truncation, deletion, an anchored-entry rewrite, or a missing anchor
 * beside an existing journal. Never absorbed as a fresh chain.
 */
export class AuditChainAnchorError extends Error {
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
   */
  readonly quarantinable: boolean;

  constructor(message: string, quarantinable = true) {
    super(message);
    this.name = "AuditChainAnchorError";
    this.quarantinable = quarantinable;
  }
}

/** Options controlling where an entry is written. */
export interface RecordOptions {
  /** Base directory override (default: `${WORK_DIR}/audit`). */
  baseDir?: string;
  /** Worker partition override (default: resolved from env). */
  workerId?: string;
  /** UTC date string override (default: today, `YYYY-MM-DD`). */
  date?: string;
  /**
   * Environment lookup behind the `baseDir`/`workerId` defaults (Issue #963).
   *
   * Defaults to the real process environment, so production callers pass
   * nothing. A test hands over a fixed map instead of setting `WORK_DIR` and
   * `WORKER_UNIQUE_ID` on the process, which races every other test running
   * at that moment (Issue #880).
   */
  env?: EnvLookup;
}

/** Result of verifying a journal file's hash chain. */
export interface ChainVerification {
  /** True when the chain is intact end-to-end AND matches its anchor. */
  valid: boolean;
  /** Number of entries inspected. */
  count: number;
  /** Zero-based index of the first broken entry, when invalid. */
  brokenIndex?: number;
  /** Human-readable reason the chain failed, when invalid. */
  reason?: string;
}

/** One journal's verdict within a directory-wide sweep. */
export interface ChainSweepEntry extends ChainVerification {
  /** Journal file path this verdict belongs to. */
  path: string;
}

/** Result of verifying every chain under an audit directory. */
export interface ChainSweep {
  /** Audit directory swept. */
  baseDir: string;
  /** Number of journals inspected (journals plus orphaned anchors). */
  checked: number;
  /** Journals whose chain or anchor failed verification. */
  broken: ChainSweepEntry[];
  /**
   * Appends settled by this sweep (Issue #1074).
   *
   * Reported, never a failure and never silent: an interrupted append is
   * expected operational damage on a host whose runs are killed, and the
   * chain is only ever repaired back to the position it was last
   * confirmed at.
   */
  recovered: AppendRecovery[];
  /**
   * Journals that are gone and whose loss has been signed for (Issue #359).
   *
   * Reported, never hidden — but not a failure. A permanently-red integrity
   * alarm is a broken integrity alarm: once a host's self-inflicted losses
   * are always present, a genuine deletion arriving later just adds a line
   * nobody reads.
   */
  acknowledged: AcknowledgedLoss[];
}

/**
 * One accounted-for finding within a sweep.
 *
 * Either a journal that is gone and whose loss was signed for (Issue
 * #359), or one that is present but does not verify and whose damage was
 * signed for against its exact bytes (Issue #491). Both are reported on
 * every sweep and neither fails it; `kind` says which, because "we deleted
 * this" and "this is corrupt and we know why" are different admissions.
 */
export interface AcknowledgedLoss {
  /** Journal file path the acknowledgement covers. */
  path: string;
  /** Which admission this is. */
  kind: "loss" | "damage";
  /** Why it is accounted for, and who signed for it. */
  acknowledgement: RosterAcknowledgement | RosterDamageAcknowledgement;
}

/** In-process per-key write queue keeping this process's appends serial. */
const writeQueues = new Map<string, Promise<unknown>>();

/** Live chain position for a journal: how many entries, and the head hash. */
interface ChainState {
  count: number;
  headHash: string;
}

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
 */

/** Today's UTC date as `YYYY-MM-DD`. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sanitise a worker id for safe use in a filename. */
function sanitiseWorkerId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "worker";
}

/**
 * Resolve the default audit base directory from the environment.
 *
 * @param override - Explicit directory, used verbatim when supplied.
 * @param env - Environment lookup for the `WORK_DIR`/`TMPDIR` fallback
 *   (Issue #963). Defaults to the real process environment.
 */
export function resolveBaseDir(
  override?: string,
  env: EnvLookup = processEnvLookup,
): string {
  if (override) return override;
  const workDir = env("WORK_DIR");
  if (workDir) return `${workDir}/audit`;
  const tmp = env("TMPDIR") ?? "/tmp";
  return `${tmp}/vibe-audit`;
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
 */
export function resolveWorkerId(
  override?: string,
  env: EnvLookup = processEnvLookup,
): string {
  if (override) return sanitiseWorkerId(override);
  const id = env("WORKER_UNIQUE_ID") ??
    env("WORKER_NAME") ??
    "worker";
  return sanitiseWorkerId(id);
}

/**
 * Resolve the run-correlation id from the environment (joins to #2381).
 *
 * @param env - Environment lookup (Issue #963). Defaults to the real process
 *   environment, so production callers pass nothing.
 */
export function resolveRunId(env: EnvLookup = processEnvLookup): string {
  return env("VIBE_RUN_ID") ??
    env("WORKER_UNIQUE_ID") ??
    "unknown";
}

/** Build the journal file path for the given partition. */
export function auditFilePath(opts: RecordOptions = {}): string {
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
 */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  // Chain regardless of whether the previous task resolved or rejected.
  const next = prev.then(fn, fn);
  // Swallow rejection on the stored tail so it never becomes unhandled.
  writeQueues.set(key, next.then(() => {}, () => {}));
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
 */
function auditLockPath(baseDir: string): string {
  return `${baseDir}/.audit-append.lock`;
}

/** Read a journal's non-empty lines, or `null` when the file is absent. */
async function readJournalLines(path: string): Promise<string[] | null> {
  try {
    const content = await Deno.readTextFile(path);
    return content.split("\n").filter((l) => l.trim().length > 0);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** Hash of the entry at `index`, or null when it is absent/unparseable. */
function hashAt(lines: readonly string[], index: number): string | null {
  const line = lines[index];
  if (!line) return null;
  try {
    return (JSON.parse(line) as AuditEntry).hash ?? null;
  } catch {
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
 */
function reconcile(
  path: string,
  anchor: ChainAnchor | null,
  lines: string[] | null,
): ChainState {
  if (lines === null) {
    if (anchor && anchor.count > 0) {
      throw new AuditChainAnchorError(
        `audit journal deleted: ${path} is missing but its anchor records ` +
          `${anchor.count} entries`,
      );
    }
    return { count: 0, headHash: "" };
  }

  if (!anchor) {
    throw new AuditChainAnchorError(
      `audit journal has no chain anchor: ${path} — the anchor at ` +
        `${anchorPath(path)} is missing. Adopt the existing chain with ` +
        `\`deno task audit-chain-verify --adopt\` once it has been reviewed.`,
      false,
    );
  }

  if (lines.length < anchor.count) {
    throw new AuditChainAnchorError(
      `audit journal truncated: ${path} holds ${lines.length} entries but ` +
        `its anchor records ${anchor.count}`,
    );
  }
  // Issue #3949: a longer journal is as suspect as a shorter one. Extending
  // it here would re-anchor on the next append, laundering a forged tail
  // into the anchor.
  if (lines.length > anchor.count) {
    throw new AuditChainAnchorError(
      `audit journal has entries appended past the anchor: ${path} holds ` +
        `${lines.length} entries but its anchor records ${anchor.count}`,
    );
  }
  if (anchor.count > 0 && hashAt(lines, anchor.count - 1) !== anchor.headHash) {
    throw new AuditChainAnchorError(
      `audit journal rewritten: ${path} entry ${anchor.count - 1} no longer ` +
        `carries the anchored head hash`,
    );
  }

  const headHash = lines.length > 0
    ? hashAt(lines, lines.length - 1) ?? ""
    : "";
  return { count: lines.length, headHash };
}

/**
 * Chain position for a path, read from disk and its anchor every time.
 *
 * Callers must hold the directory lock (Issue #491): the value is only
 * true for as long as no other process appends, so reading it outside the
 * lock and writing on the strength of it is the original bug.
 */
/**
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
 */
async function damageIsAcknowledged(path: string): Promise<boolean> {
  const baseDir = path.slice(0, path.lastIndexOf("/")) || ".";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const damage = (await readRosterContents(baseDir)).damaged.get(name);
  if (!damage) return false;
  const digest = await journalDigest(path);
  return digest.ok && digest.value === damage.digest;
}

async function getChainState(path: string): Promise<ChainState> {
  try {
    return reconcile(
      path,
      await readAnchor(path),
      await readJournalLines(path),
    );
  } catch (error: unknown) {
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
      console.error(
        `[SECURITY] [AUDIT_APPEND_RECOVERY_FAILED] ${path}: an interrupted ` +
          `append could not be settled: ${settled.error.message}`,
      );
      throw error;
    }
    if (!settled.value) throw error;
    console.error(formatAppendRecovery(settled.value));
    return reconcile(
      path,
      await readAnchor(path),
      await readJournalLines(path),
    );
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
 */
export async function recordMutation(
  mutation: AuditMutation,
  opts: RecordOptions = {},
): Promise<Result<AuditEntry>> {
  try {
    const baseDir = resolveBaseDir(opts.baseDir, opts.env ?? processEnvLookup);
    await Deno.mkdir(baseDir, { recursive: true });
    // Issue #491: journal selection and the append are one critical
    // section, guarded across processes. The in-process queue wraps the
    // file lock so same-process callers wait on a promise instead of
    // spinning on the lock file.
    const entry = await withLock(
      baseDir,
      () =>
        withFileLock(auditLockPath(baseDir), async () => {
          const path = await resolveWritableJournal(auditFilePath(opts));
          return await appendEntry(path, mutation);
        }),
    );
    return { ok: true, value: entry };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Append one chained, anchored, rostered entry to `path`. */
async function appendEntry(
  path: string,
  mutation: AuditMutation,
): Promise<AuditEntry> {
  const baseDir = path.slice(0, path.lastIndexOf("/")) || ".";
  const state = await getChainState(path);
  const timestamp = mutation.timestamp ?? new Date().toISOString();
  const payload = { ...mutation, timestamp };
  const hash = await computeEntryHash(payload, state.headHash);
  const full: AuditEntry = { ...payload, prevHash: state.headHash, hash };
  // Issue #1074: declare the append before making it. The line and the
  // anchor are two files and cannot be written atomically, so the writer
  // records which entry is in flight; a process killed anywhere after
  // this leaves evidence of what it was doing, and the next run finishes
  // or rolls back the append instead of demanding a human signature.
  const declared = await writeAnchor(path, {
    count: state.count,
    headHash: state.headHash,
    pending: { hash, startedAt: timestamp },
  });
  if (!declared.ok) {
    throw new AuditChainAnchorError(
      `audit entry could not be declared before the append: ` +
        declared.error.message,
    );
  }
  await Deno.writeTextFile(path, `${JSON.stringify(full)}\n`, {
    append: true,
  });
  const next: ChainState = { count: state.count + 1, headHash: hash };
  const anchored = await writeAnchor(path, next);
  if (!anchored.ok) {
    // Fail loud (Issue #3234): an un-anchored append leaves the chain
    // unverifiable, so the caller must see the failure.
    throw new AuditChainAnchorError(
      `audit entry appended but its anchor could not be written: ` +
        anchored.error.message,
    );
  }
  // Issue #3949: record the journal in the expected-journal roster so a
  // later deletion of the journal together with its anchor (or of the
  // whole audit directory) is a broken chain, not an empty sweep.
  const rostered = await addToRoster(
    baseDir,
    path.slice(path.lastIndexOf("/") + 1),
  );
  if (!rostered.ok) {
    throw new AuditChainAnchorError(
      `audit entry appended but the journal roster could not be ` +
        `updated: ${rostered.error.message}`,
    );
  }
  return full;
}

/** Verb recorded as the first entry of a segment opened beside damage. */
export const AUDIT_JOURNAL_QUARANTINED_VERB = "audit-journal-quarantined";

/** Segment suffix for the nth journal opened beside a damaged one. */
function segmentPath(basePath: string, n: number): string {
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
 */
async function resolveWritableJournal(basePath: string): Promise<string> {
  let damaged: { path: string; reason: string } | null = null;
  // Bounded: a host that has quarantined 100 segments in one day has a
  // problem no further segment is going to help with, and an unbounded
  // walk would spin.
  for (let n = 0; n <= 100; n++) {
    const path = n === 0 ? basePath : segmentPath(basePath, n);
    try {
      const state = await getChainState(path);
      // Note the quarantine once, when the segment is opened. Every later
      // process re-detects the same damage on its way past; repeating the
      // note would bury the segment's real content under duplicates.
      if (damaged && state.count === 0) await noteQuarantine(path, damaged);
      return path;
    } catch (error: unknown) {
      if (
        !(error instanceof AuditChainAnchorError) || !error.quarantinable
      ) {
        throw error;
      }
      if (!damaged) damaged = { path, reason: error.message };
    }
  }
  throw new AuditChainAnchorError(
    `audit journal cannot be opened: ${basePath} and 100 segments beside it ` +
      `all disagree with their anchors`,
  );
}

/**
 * Open a quarantine segment by recording what was displaced, loudly.
 *
 * The note is the segment's first chained entry, so "why does this host
 * have a `.s1` journal" is answerable from the trail itself rather than
 * from whoever happened to read the console that day.
 */
async function noteQuarantine(
  segment: string,
  damaged: { path: string; reason: string },
): Promise<void> {
  console.error(
    `[SECURITY] [AUDIT_JOURNAL_QUARANTINED] ${damaged.path}: ${damaged.reason} ` +
      `— left intact as evidence and still failing the sweep; recording ` +
      `continues in ${segment}`,
  );
  // Already inside the directory lock (Issue #491): re-entering it here
  // would deadlock, and the note is part of the same critical section.
  await appendEntry(segment, {
    runId: resolveRunId(),
    verb: AUDIT_JOURNAL_QUARANTINED_VERB,
    target: damaged.path.slice(damaged.path.lastIndexOf("/") + 1),
    outcome: "error",
    caller: damaged.reason,
  });
}

/**
 * Load every entry from a journal file in order.
 *
 * @param path - Journal file path
 * @returns Result with the parsed entries, or an error on IO failure
 */
export async function loadEntries(path: string): Promise<Result<AuditEntry[]>> {
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        ok: false,
        error: new Error(`Audit journal not found: ${path}`),
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  const entries: AuditEntry[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      return { ok: false, error: new Error(`Malformed journal line: ${line}`) };
    }
  }
  return { ok: true, value: entries };
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
 */
export async function verifyChain(
  path: string,
): Promise<Result<ChainVerification>> {
  let anchor: ChainAnchor | null;
  try {
    anchor = await readAnchor(path);
  } catch (error: unknown) {
    return {
      ok: true,
      value: {
        valid: false,
        count: 0,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }

  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (error: unknown) {
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
        let expected: boolean;
        try {
          expected = (await readRosterContents(baseDir)).journals.includes(
            name,
          );
        } catch (error: unknown) {
          // A corrupted roster is a tamper signal, never a silent pass.
          return {
            ok: false,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
        if (!expected) {
          return { ok: true, value: { valid: true, count: 0 } };
        }
      }
      if (anchor) {
        return {
          ok: true,
          value: {
            valid: false,
            count: 0,
            reason:
              `journal deleted — anchor records ${anchor.count} entries with ` +
              `head ${anchor.headHash.slice(0, 12)}`,
          },
        };
      }
      return {
        ok: false,
        error: new Error(`Audit journal not found: ${path}`),
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  let prev = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      return {
        ok: true,
        value: {
          valid: false,
          count: lines.length,
          brokenIndex: i,
          reason: "malformed JSON",
        },
      };
    }
    if (entry.prevHash !== prev) {
      return {
        ok: true,
        value: {
          valid: false,
          count: lines.length,
          brokenIndex: i,
          reason: "prevHash linkage mismatch",
        },
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
          reason: "hash mismatch",
        },
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
        reason: `chain anchor missing: ${anchorPath(path)}`,
      },
    };
  }
  if (lines.length < anchor.count) {
    return {
      ok: true,
      value: {
        valid: false,
        count: lines.length,
        brokenIndex: lines.length,
        reason: `journal truncated — ${lines.length} entries present, anchor ` +
          `records ${anchor.count}`,
      },
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
        reason: `entries appended past the anchor — ${lines.length} entries ` +
          `present, anchor records ${anchor.count}`,
      },
    };
  }
  if (anchor.count > 0 && hashAt(lines, anchor.count - 1) !== anchor.headHash) {
    return {
      ok: true,
      value: {
        valid: false,
        count: lines.length,
        brokenIndex: anchor.count - 1,
        reason: "anchor head hash mismatch",
      },
    };
  }

  return { ok: true, value: { valid: true, count: lines.length } };
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
 */
export async function adoptAnchor(path: string): Promise<Result<ChainAnchor>> {
  const lines = await readJournalLines(path).catch(() => null);
  if (lines === null) {
    return { ok: false, error: new Error(`Audit journal not found: ${path}`) };
  }

  // Walk the chain itself before trusting it. verifyChain would fail on
  // the (expected) missing anchor, so the linkage is re-walked here.
  let prev = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      return {
        ok: false,
        error: new Error(`cannot adopt ${path}: malformed JSON at entry ${i}`),
      };
    }
    if (entry.prevHash !== prev) {
      return {
        ok: false,
        error: new Error(
          `cannot adopt ${path}: prevHash linkage mismatch at entry ${i}`,
        ),
      };
    }
    if (await computeEntryHash(entry, prev) !== entry.hash) {
      return {
        ok: false,
        error: new Error(`cannot adopt ${path}: hash mismatch at entry ${i}`),
      };
    }
    prev = entry.hash;
  }

  const written = await writeAnchor(path, {
    count: lines.length,
    headHash: prev,
  });
  if (!written.ok) return written;
  // No cache to invalidate since Issue #491: the next append reads the
  // freshly written anchor from disk.

  // Issue #3949: an adopted journal is an expected journal from here on.
  const slash = path.lastIndexOf("/");
  const rostered = await addToRoster(
    slash > -1 ? path.slice(0, slash) : ".",
    path.slice(slash + 1),
  );
  if (!rostered.ok) {
    return {
      ok: false,
      error: new Error(
        `anchor adopted but the journal roster could not be updated: ` +
          rostered.error.message,
      ),
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
 */
export const AUDIT_DAMAGE_ACKNOWLEDGED_VERB = "audit-damage-acknowledged";

/**
 * SHA-256 of a journal's bytes, with its entry count.
 *
 * The digest covers the whole file, not the chain, so it changes on any
 * edit at all — including one that leaves the chain just as broken.
 */
async function journalDigest(path: string): Promise<Result<string>> {
  try {
    const bytes = await Deno.readFile(path);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      ok: true,
      value: Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Inputs for {@link acknowledgeJournalDamage}. */
export interface AcknowledgeDamageParams {
  /** Audit directory the roster covers. */
  baseDir: string;
  /** Basename of the damaged journal being signed for. */
  journalName: string;
  /** Why the damage is accounted for. Must not be blank. */
  reason: string;
  /** Who is signing for it. Must not be blank. */
  by: string;
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
 */
export async function acknowledgeJournalDamage(
  params: AcknowledgeDamageParams,
  opts: RecordOptions = {},
): Promise<Result<RosterDamageAcknowledgement>> {
  const { baseDir, journalName, reason, by } = params;
  const path = `${baseDir}/${journalName}`;

  if (!await pathExists(path)) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge damage to ${journalName}: it is not on ` +
          `disk — a journal that is gone is a loss, signed for with ` +
          `--acknowledge-loss, not damage`,
      ),
    };
  }

  const verified = await verifyChain(path);
  if (verified.ok && verified.value.valid) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge damage to ${journalName}: its chain ` +
          `verifies — there is nothing to sign for, and a signature taken ` +
          `now would cover damage that has not happened yet`,
      ),
    };
  }

  const digest = await journalDigest(path);
  if (!digest.ok) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge damage to ${journalName}: its bytes could ` +
          `not be read, so the signature could not be pinned to them: ` +
          `${digest.error.message}`,
      ),
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
    caller: `${by}: ${reason}`,
  }, { ...opts, baseDir });
  if (!recorded.ok) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge damage to ${journalName}: the ` +
          `acknowledgement could not be recorded in the audit chain, so it ` +
          `will not be recorded in the roster either: ` +
          `${recorded.error.message}`,
      ),
    };
  }

  return await acknowledgeRosterDamage(
    baseDir,
    journalName,
    reason,
    by,
    digest.value,
    entries,
  );
}

/**
 * Verb recorded in the chain when a journal loss is signed for (Issue
 * #359). See {@link AUDIT_DAMAGE_ACKNOWLEDGED_VERB} for the damage
 * counterpart — the two are deliberately distinct verbs.
 */
export const AUDIT_LOSS_ACKNOWLEDGED_VERB = "audit-loss-acknowledged";

/** Inputs for {@link acknowledgeJournalLoss}. */
export interface AcknowledgeLossParams {
  /** Audit directory the roster covers. */
  baseDir: string;
  /** Basename of the journal whose loss is being signed for. */
  journalName: string;
  /** Why it is gone. Must not be blank — an unexplained loss stays loud. */
  reason: string;
  /** Who is signing for it. Must not be blank. */
  by: string;
}

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
 */
export async function acknowledgeJournalLoss(
  params: AcknowledgeLossParams,
  opts: RecordOptions = {},
): Promise<Result<RosterAcknowledgement>> {
  const { baseDir, journalName, reason, by } = params;

  let rostered: string[];
  try {
    rostered = (await readRosterContents(baseDir)).journals;
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  if (!rostered.includes(journalName)) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge ${journalName}: it is not on the roster for ` +
          `${baseDir}, so nothing expects it`,
      ),
    };
  }

  const journalThere = await pathExists(`${baseDir}/${journalName}`);
  const anchorThere = await pathExists(anchorPath(`${baseDir}/${journalName}`));
  if (journalThere || anchorThere) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge ${journalName}: it is still on disk ` +
          `(${journalThere ? "journal" : "anchor"} present) — only a journal ` +
          `that is genuinely gone can be signed for, never one whose chain ` +
          `simply does not verify`,
      ),
    };
  }

  // The chain record comes first, deliberately. A failure here leaves the
  // alarm sounding, which is the safe direction to fail in.
  const recorded = await recordMutation({
    runId: resolveRunId(),
    verb: AUDIT_LOSS_ACKNOWLEDGED_VERB,
    target: journalName,
    outcome: "success",
    caller: `${by}: ${reason}`,
  }, { ...opts, baseDir });
  if (!recorded.ok) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge ${journalName}: the acknowledgement could ` +
          `not be recorded in the audit chain, so it will not be recorded ` +
          `in the roster either: ${recorded.error.message}`,
      ),
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
 */
async function settleAppendUnderLock(
  baseDir: string,
  path: string,
): Promise<Result<AppendRecovery | null>> {
  try {
    return await withFileLock(
      auditLockPath(baseDir),
      () => settleInterruptedAppend(path),
    );
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Does `path` exist? Any stat error other than absence is propagated up. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Sweep verdict for complete erasure of the journal directory and roster. */
function completeErasureSweep(dir: string): Result<ChainSweep> {
  return {
    ok: true,
    value: {
      baseDir: dir,
      checked: 1,
      acknowledged: [],
      recovered: [],
      broken: [{
        path: dir,
        valid: false,
        count: 0,
        reason:
          "audit directory and roster are both missing but a last-known-non-empty marker records that journals existed — complete erasure",
      }],
    },
  };
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
 * @returns Result carrying the sweep verdict; an absent directory is a
 *   clean, empty sweep only when nothing was ever observed
 */
export async function verifyAllChains(
  baseDir?: string,
): Promise<Result<ChainSweep>> {
  const dir = resolveBaseDir(baseDir);
  const journalsOnDisk = new Set<string>();
  const anchorsOnDisk = new Set<string>();

  let rostered: string[];
  let acknowledgements: Map<string, RosterAcknowledgement>;
  let damageAcknowledgements: Map<string, RosterDamageAcknowledgement>;
  let seen: boolean;
  try {
    const contents = await readRosterContents(dir);
    rostered = contents.journals;
    acknowledgements = contents.acknowledged;
    damageAcknowledgements = contents.damaged;
    seen = await rosterWasSeen(dir);
  } catch (error: unknown) {
    // A corrupted roster or seen-marker is a tamper signal in its own right.
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  let dirMissing = false;
  try {
    for await (const item of Deno.readDir(dir)) {
      if (item.isFile && /^audit-.*\.jsonl$/.test(item.name)) {
        journalsOnDisk.add(item.name);
      }
    }
  } catch (error: unknown) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    // Issue #3949: an absent directory is a clean, empty sweep only when
    // nothing was ever journalled. When the roster expects journals, the
    // directory's removal is the tampering, not a fresh start.
    // Issue #270: a missing roster after a previously observed non-empty
    // one is the same erasure, not a first-ever start.
    if (rostered.length === 0) {
      if (seen) return completeErasureSweep(dir);
      return {
        ok: true,
        value: {
          baseDir: dir,
          checked: 0,
          broken: [],
          acknowledged: [],
          recovered: [],
        },
      };
    }
    dirMissing = true;
  }

  if (!dirMissing) {
    try {
      for await (const item of Deno.readDir(`${dir}/anchors`)) {
        if (!item.isFile) continue;
        const journal = journalNameForAnchor(item.name);
        if (journal) anchorsOnDisk.add(journal);
      }
    } catch (error: unknown) {
      if (!(error instanceof Deno.errors.NotFound)) {
        return {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
  }

  const names = new Set<string>([
    ...journalsOnDisk,
    ...anchorsOnDisk,
    ...rostered,
  ]);

  // Issue #270: directory present but empty of journals/anchors, roster
  // gone, marker still there — the same complete erasure as a missing dir.
  if (names.size === 0 && seen) return completeErasureSweep(dir);

  const broken: ChainSweepEntry[] = [];
  const acknowledged: AcknowledgedLoss[] = [];
  const recovered: AppendRecovery[] = [];
  for (const name of [...names].sort()) {
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
        acknowledged.push({ path, kind: "loss", acknowledgement: ack });
        continue;
      }
      broken.push({
        path,
        valid: false,
        count: 0,
        reason: dirMissing
          ? `audit directory missing but the roster records this journal — ` +
            `directory deleted`
          : `journal and its anchor are both missing but the roster records ` +
            `this journal — pair deleted`,
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
    if (
      result.ok && !result.value.valid && !dirMissing &&
      !damageAcknowledgements.has(name)
    ) {
      const settled = await settleAppendUnderLock(dir, path);
      if (!settled.ok) {
        // Loud, and the original verdict stands: the journal is still
        // broken for its original reason and still carries the remedy
        // that names it. Silence here would read as "nothing to settle".
        console.error(
          `[SECURITY] [AUDIT_APPEND_RECOVERY_FAILED] ${path}: an ` +
            `interrupted append could not be settled: ${settled.error.message}`,
        );
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
        reason: result.error.message,
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
        acknowledged.push({ path, kind: "damage", acknowledgement: damage });
        continue;
      }
      broken.push({
        path,
        ...result.value,
        reason: `${result.value.reason ?? "chain does not verify"} — the ` +
          `damage acknowledgement signed by ${damage.by} on ` +
          `${damage.acknowledgedAt} no longer applies: the journal has ` +
          `changed since it was signed for`,
      });
      continue;
    }
    broken.push({ path, ...result.value });
  }

  return {
    ok: true,
    value: {
      baseDir: dir,
      checked: names.size,
      broken,
      acknowledged,
      recovered,
    },
  };
}

/**
 * Reset in-process state. Test-only helper.
 *
 * Since Issue #491 there is no chain-state cache to clear — the head is
 * read from disk on every append — so this only drops the write queues.
 */
export function _resetAuditCaches(): void {
  writeQueues.clear();
}
