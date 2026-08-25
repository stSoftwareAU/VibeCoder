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
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  acknowledgeRosterLoss,
  addToRoster,
  anchorPath,
  type ChainAnchor,
  journalNameForAnchor,
  readAnchor,
  readRosterContents,
  type RosterAcknowledgement,
  rosterWasSeen,
  writeAnchor,
} from "./audit_anchor.ts";

/**
 * Raised when the journal on disk disagrees with its chain anchor —
 * truncation, deletion, an anchored-entry rewrite, or a missing anchor
 * beside an existing journal. Never absorbed as a fresh chain.
 */
export class AuditChainAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditChainAnchorError";
  }
}

/** Outcome of the underlying network call. */
export type AuditOutcome = "success" | "error";

/** A GitHub mutation to record (caller-supplied fields). */
export interface AuditMutation {
  /** ISO 8601 timestamp. Filled in by {@link recordMutation} when absent. */
  timestamp?: string;
  /** Run-correlation id (joins to #2381). */
  runId: string;
  /** owner/repo target, when known. */
  repo?: string;
  /** Target ref / issue / PR / endpoint identifier, when known. */
  target?: string;
  /** Action verb, e.g. "issue-comment", "pr-merge", "git-push". */
  verb: string;
  /** Outcome of the underlying network call. */
  outcome: AuditOutcome;
  /** `gh`/`git` exit code where available. */
  exitCode?: number;
  /** Caller code path, e.g. "worker/deno/lib/pr_comments.ts". */
  caller?: string;
}

/** A persisted journal entry (mutation fields plus chain fields). */
export interface AuditEntry extends AuditMutation {
  timestamp: string;
  /** Hash of the previous entry in the chain ("" for the first entry). */
  prevHash: string;
  /** SHA-256 hex digest over prevHash + canonical payload. */
  hash: string;
}

/** Options controlling where an entry is written. */
export interface RecordOptions {
  /** Base directory override (default: `${WORK_DIR}/audit`). */
  baseDir?: string;
  /** Worker partition override (default: resolved from env). */
  workerId?: string;
  /** UTC date string override (default: today, `YYYY-MM-DD`). */
  date?: string;
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
   * Journals that are gone and whose loss has been signed for (Issue #359).
   *
   * Reported, never hidden — but not a failure. A permanently-red integrity
   * alarm is a broken integrity alarm: once a host's self-inflicted losses
   * are always present, a genuine deletion arriving later just adds a line
   * nobody reads.
   */
  acknowledged: AcknowledgedLoss[];
}

/** One accounted-for journal loss within a sweep (Issue #359). */
export interface AcknowledgedLoss {
  /** Journal file path the loss covers. */
  path: string;
  /** Why the journal is gone, and who signed for it. */
  acknowledgement: RosterAcknowledgement;
}

/** Field order used for the canonical payload (chain fields excluded). */
const PAYLOAD_FIELDS: ReadonlyArray<keyof AuditMutation> = [
  "timestamp",
  "runId",
  "repo",
  "target",
  "verb",
  "outcome",
  "exitCode",
  "caller",
];

/** In-process per-path write queue (async mutex) keeping appends serial. */
const writeQueues = new Map<string, Promise<unknown>>();

/** Live chain position for a journal: how many entries, and the head hash. */
interface ChainState {
  count: number;
  headHash: string;
}

/** Cache of the chain position per path so the chain extends correctly. */
const chainStateByPath = new Map<string, ChainState>();

/** Compute the lowercase hex SHA-256 digest of a string. */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Produce the deterministic canonical payload for hashing.
 *
 * Only the mutation fields (never the chain fields) are included, in a
 * fixed key order, with undefined values omitted — so the same logical
 * entry always hashes to the same value regardless of object key order.
 */
function canonicalPayload(
  entry: AuditMutation & { timestamp: string },
): string {
  const ordered: Record<string, unknown> = {};
  for (const key of PAYLOAD_FIELDS) {
    const value = entry[key];
    if (value !== undefined) {
      ordered[key] = value;
    }
  }
  return JSON.stringify(ordered);
}

/** Compute the chain hash for an entry given the previous hash. */
export async function computeEntryHash(
  entry: AuditMutation & { timestamp: string },
  prevHash: string,
): Promise<string> {
  return await sha256Hex(`${prevHash}\n${canonicalPayload(entry)}`);
}

/** Today's UTC date as `YYYY-MM-DD`. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sanitise a worker id for safe use in a filename. */
function sanitiseWorkerId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "worker";
}

/** Resolve the default audit base directory from the environment. */
export function resolveBaseDir(override?: string): string {
  if (override) return override;
  const workDir = Deno.env.get("WORK_DIR");
  if (workDir) return `${workDir}/audit`;
  const tmp = Deno.env.get("TMPDIR") ?? "/tmp";
  return `${tmp}/vibe-audit`;
}

/** Resolve the worker partition id from the environment. */
export function resolveWorkerId(override?: string): string {
  if (override) return sanitiseWorkerId(override);
  const id = Deno.env.get("WORKER_UNIQUE_ID") ??
    Deno.env.get("WORKER_NAME") ??
    "worker";
  return sanitiseWorkerId(id);
}

/** Resolve the run-correlation id from the environment (joins to #2381). */
export function resolveRunId(): string {
  return Deno.env.get("VIBE_RUN_ID") ??
    Deno.env.get("WORKER_UNIQUE_ID") ??
    "unknown";
}

/** Build the journal file path for the given partition. */
export function auditFilePath(opts: RecordOptions = {}): string {
  const baseDir = resolveBaseDir(opts.baseDir);
  const workerId = resolveWorkerId(opts.workerId);
  const date = opts.date ?? todayUtc();
  return `${baseDir}/audit-${workerId}-${date}.jsonl`;
}

/** Run `fn` exclusively for `path`, serialising concurrent callers. */
function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  // Chain regardless of whether the previous task resolved or rejected.
  const next = prev.then(fn, fn);
  // Swallow rejection on the stored tail so it never becomes unhandled.
  writeQueues.set(path, next.then(() => {}, () => {}));
  return next;
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

/** Chain position for a path, seeded from disk (and its anchor) on first use. */
async function getChainState(path: string): Promise<ChainState> {
  const cached = chainStateByPath.get(path);
  if (cached !== undefined) return cached;
  const anchor = await readAnchor(path);
  const lines = await readJournalLines(path);
  const state = reconcile(path, anchor, lines);
  chainStateByPath.set(path, state);
  return state;
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
    const baseDir = resolveBaseDir(opts.baseDir);
    const path = auditFilePath(opts);
    const entry = await withLock(path, async () => {
      await Deno.mkdir(baseDir, { recursive: true });
      const state = await getChainState(path);
      const timestamp = mutation.timestamp ?? new Date().toISOString();
      const payload = { ...mutation, timestamp };
      const hash = await computeEntryHash(payload, state.headHash);
      const full: AuditEntry = { ...payload, prevHash: state.headHash, hash };
      await Deno.writeTextFile(path, `${JSON.stringify(full)}\n`, {
        append: true,
      });
      const next: ChainState = { count: state.count + 1, headHash: hash };
      chainStateByPath.set(path, next);
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
    });
    return { ok: true, value: entry };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
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
  chainStateByPath.delete(path);

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
 * Verb recorded in the chain when a journal loss is signed for (Issue #359).
 *
 * Greppable in the journal itself, and in every downstream consumer of the
 * audit trail, so "who silenced which alarm" is answerable from the chain
 * rather than from a sidecar alone.
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
  let seen: boolean;
  try {
    const contents = await readRosterContents(dir);
    rostered = contents.journals;
    acknowledgements = contents.acknowledged;
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
        value: { baseDir: dir, checked: 0, broken: [], acknowledged: [] },
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
        acknowledged.push({ path, acknowledgement: ack });
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

    const result = await verifyChain(path);
    if (!result.ok) {
      broken.push({
        path,
        valid: false,
        count: 0,
        reason: result.error.message,
      });
      continue;
    }
    if (!result.value.valid) broken.push({ path, ...result.value });
  }

  return {
    ok: true,
    value: { baseDir: dir, checked: names.size, broken, acknowledged },
  };
}

/**
 * Reset in-process caches. Test-only helper so a fresh temp directory is
 * not polluted by chain state cached from a previous test's identical path.
 */
export function _resetAuditCaches(): void {
  writeQueues.clear();
  chainStateByPath.clear();
}
