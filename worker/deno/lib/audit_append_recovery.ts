/**
 * Crash recovery for an interrupted audit-journal append (Issue #1074).
 *
 * ## What actually breaks the chain
 *
 * A journal line and its anchor are two files. `appendEntry` writes the
 * line, then the anchor, and nothing makes that pair atomic — so a process
 * that dies between them leaves a journal one entry longer than its
 * anchor. Measured on a container host: SIGKILLing a writer mid-run leaves
 * that shape about a fifth of the time, and never leaves a partial line,
 * because a single `write(2)` of one small line to a regular file is not
 * interruptible. A **torn** line comes from a level below the process — an
 * unflushed page cache lost with the machine, or a short write from a full
 * or failing volume — and its bytes always land past the anchored head for
 * the same reason: the anchor is only advanced after the append returns.
 *
 * Both shapes previously demanded a human signature
 * (`audit-chain-verify --acknowledge-damage`) even though nothing verified
 * had been lost, and a control that routinely asks a human to wave damage
 * through is one that gets waved through unread.
 *
 * ## The write-ahead intent record
 *
 * The writer now declares the append in the anchor **before** making it —
 * `pending: { hash, startedAt }`, naming the entry by its chain hash. That
 * single fact separates a crash from a forgery, and recovery is then
 * decidable rather than guessed:
 *
 * | On disk after the crash                            | Settled as   |
 * | -------------------------------------------------- | ------------ |
 * | pending, journal still at the anchored length       | rolled back  |
 * | pending, one more line that **is** the declared entry | completed  |
 * | pending, one more line torn or not the declared entry | discarded  |
 * | no pending, one more line                           | **broken**   |
 * | anything at or before the anchored head altered     | **broken**   |
 * | more than one line past the anchor                  | **broken**   |
 *
 * Nothing verified is ever dropped: only bytes past the anchored head are
 * touched, and the anchored head is the last position the chain was ever
 * confirmed at. Discarded bytes are not deleted either — they are moved to
 * a `.torn-<n>` sidecar beside the journal and reported, so a self-heal
 * can be read back byte for byte.
 *
 * A forged tail stays broken. Without a pending record the extra line is
 * refused exactly as Issue #3949 requires; with one, the line must hash to
 * the declared value *and* re-derive that hash from its own payload, which
 * is a SHA-256 second preimage.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import type { Result } from "../types.ts";
import { type ChainAnchor, readAnchor, writeAnchor } from "./audit_anchor.ts";
import { type AuditEntry, computeEntryHash } from "./audit_entry.ts";

/** How an interrupted append was settled. */
export type AppendRecoveryKind = "rolled-back" | "completed" | "discarded";

/** What a settled append did, reported rather than done quietly. */
export interface AppendRecovery {
  /** Journal the recovery applied to. */
  path: string;
  /** Which of the three outcomes this was. */
  kind: AppendRecoveryKind;
  /** Entries the journal holds, and its anchor records, afterwards. */
  count: number;
  /** Bytes removed from the tail (0 unless `kind` is "discarded"). */
  droppedBytes: number;
  /** Sidecar the removed bytes were moved to, when any were removed. */
  preservedAs?: string;
  /** The removed bytes as text, so the report names exactly what went. */
  droppedText?: string;
}

/** Most `.torn-<n>` sidecars one journal may accumulate before we stop. */
const MAX_TORN_SIDECARS = 100;

/** Journal bytes, its non-empty lines, and where each line ends. */
interface JournalBytes {
  raw: Uint8Array;
  text: string;
  lines: string[];
  /** Byte offset just past the newline terminating each non-empty line. */
  lineEnds: number[];
  endsWithNewline: boolean;
}

/** Read a journal's bytes with line offsets, or null when it is absent. */
async function readJournalBytes(path: string): Promise<JournalBytes | null> {
  let raw: Uint8Array;
  try {
    raw = await Deno.readFile(path);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  const text = new TextDecoder().decode(raw);
  const encoder = new TextEncoder();
  const lines: string[] = [];
  const lineEnds: number[] = [];
  let offset = 0;
  for (const segment of text.split("\n")) {
    // Every segment but the last was newline-terminated; measuring the
    // encoded length keeps the offsets right for multi-byte content.
    offset += encoder.encode(segment).length + 1;
    if (segment.trim().length === 0) continue;
    lines.push(segment);
    lineEnds.push(offset);
  }
  return { raw, text, lines, lineEnds, endsWithNewline: text.endsWith("\n") };
}

/** Byte offset just past the last anchored entry. */
function anchoredLength(journal: JournalBytes, count: number): number {
  if (count === 0) return 0;
  return journal.lineEnds[count - 1] ?? journal.raw.length;
}

/** First free `.torn-<n>` sidecar path beside `path`. */
async function freeSidecarPath(path: string): Promise<string> {
  for (let n = 1; n <= MAX_TORN_SIDECARS; n++) {
    const candidate = `${path}.torn-${n}`;
    try {
      await Deno.stat(candidate);
    } catch (error: unknown) {
      if (error instanceof Deno.errors.NotFound) return candidate;
      throw error;
    }
  }
  throw new Error(
    `refusing to discard a torn tail from ${path}: ${MAX_TORN_SIDECARS} ` +
      `.torn-<n> sidecars already exist beside it, so the previous ones ` +
      `would have to be overwritten`,
  );
}

/**
 * Move the bytes past the anchored head into a sidecar and truncate.
 *
 * Preserve first, truncate second: a failure to write the sidecar leaves
 * the journal exactly as it was, still failing the sweep, which is the
 * safe direction. Nothing is ever deleted.
 */
async function discardTornTail(
  path: string,
  journal: JournalBytes,
  anchor: ChainAnchor,
): Promise<AppendRecovery> {
  const keep = anchoredLength(journal, anchor.count);
  const dropped = journal.raw.slice(keep);
  const sidecar = await freeSidecarPath(path);
  await Deno.writeFile(sidecar, dropped, { createNew: true });
  await Deno.truncate(path, keep);
  await clearPending(path, anchor);
  return {
    path,
    kind: "discarded",
    count: anchor.count,
    droppedBytes: dropped.length,
    preservedAs: sidecar,
    droppedText: new TextDecoder().decode(dropped),
  };
}

/** Rewrite the anchor at its current position, dropping the intent record. */
async function clearPending(
  path: string,
  anchor: ChainAnchor,
): Promise<void> {
  const written = await writeAnchor(path, {
    count: anchor.count,
    headHash: anchor.headHash,
  });
  if (!written.ok) throw written.error;
}

/** Is `line` exactly the entry the anchor declared as in flight? */
async function isDeclaredEntry(
  line: string,
  anchor: ChainAnchor,
): Promise<AuditEntry | null> {
  let entry: AuditEntry;
  try {
    entry = JSON.parse(line) as AuditEntry;
  } catch {
    return null;
  }
  if (entry.prevHash !== anchor.headHash) return null;
  if (entry.hash !== anchor.pending?.hash) return null;
  // Re-derive the hash from the payload: a line that merely *claims* the
  // declared hash is not the declared entry, and promoting it would move
  // the anchor onto content that has never chained.
  if (await computeEntryHash(entry, anchor.headHash) !== entry.hash) {
    return null;
  }
  return entry;
}

/** Tuning for {@link settleInterruptedAppend}. */
export interface SettleOptions {
  /**
   * Clear an intent record whose entry never reached the journal?
   *
   * True for the writer, which is about to append and needs the anchor
   * back in its steady state. False for the sweep, which only settles
   * journals that already fail verification: a roll-back cannot make a
   * failing journal pass, so doing one there would rewrite the anchor of
   * a file that stays broken — touching evidence for no benefit.
   */
  rollBack?: boolean;
}

/**
 * Settle an append that was interrupted, if one was.
 *
 * Callers must hold the audit-directory lock: this reads the journal and
 * its anchor and may rewrite both, so a concurrent append would see a
 * half-settled state.
 *
 * @param path - Journal file path
 * @param options - Whether a never-landed append may be rolled back
 * @returns Result carrying the recovery performed, or `null` when there
 *   was nothing to settle — including every shape that must stay broken
 */
export async function settleInterruptedAppend(
  path: string,
  options: SettleOptions = {},
): Promise<Result<AppendRecovery | null>> {
  const rollBack = options.rollBack ?? true;
  try {
    const anchor = await readAnchor(path);
    // No anchor is the pre-#3712 `--adopt` case, not an interrupted
    // append: there is no recorded position to recover to.
    if (!anchor) return { ok: true, value: null };

    const journal = await readJournalBytes(path);
    if (journal === null) {
      // The journal never reached disk. Only a declared append explains
      // that; anything else is a deletion and must stay broken.
      if (!anchor.pending || anchor.count > 0 || !rollBack) {
        return { ok: true, value: null };
      }
      await clearPending(path, anchor);
      return {
        ok: true,
        value: { path, kind: "rolled-back", count: 0, droppedBytes: 0 },
      };
    }

    const extra = journal.lines.length - anchor.count;

    if (extra === 0) {
      if (!anchor.pending || !rollBack) return { ok: true, value: null };
      // Declared, never landed: the writer died before the line reached
      // the file, so there is nothing to keep and nothing to drop.
      await clearPending(path, anchor);
      return {
        ok: true,
        value: {
          path,
          kind: "rolled-back",
          count: anchor.count,
          droppedBytes: 0,
        },
      };
    }

    // More than one line past the anchor is never an interrupted append:
    // the writer declares one entry at a time. Two torn lines, or a torn
    // line followed by a valid one, land here and stay broken.
    if (extra !== 1) return { ok: true, value: null };

    const tail = journal.lines[anchor.count] ?? "";

    if (anchor.pending) {
      const declared = await isDeclaredEntry(tail, anchor);
      if (declared && journal.endsWithNewline) {
        // The line landed whole; only the confirming anchor write was
        // lost. Finish the append rather than throwing the entry away.
        const written = await writeAnchor(path, {
          count: anchor.count + 1,
          headHash: declared.hash,
        });
        if (!written.ok) return { ok: false, error: written.error };
        return {
          ok: true,
          value: {
            path,
            kind: "completed",
            count: anchor.count + 1,
            droppedBytes: 0,
          },
        };
      }
      return {
        ok: true,
        value: await discardTornTail(path, journal, anchor),
      };
    }

    // No intent record — a journal written before Issue #1074, or one
    // whose anchor never recorded the attempt. A *parseable* trailing
    // entry is the forged-tail shape Issue #3949 keeps red, and stays
    // red. Unterminated, unparseable trailing bytes are a partial write:
    // they can carry no forgery, because a forgery has to parse and chain
    // to be worth anything, and they sit past the anchored head, so
    // discarding them removes nothing the chain ever confirmed.
    if (journal.endsWithNewline) return { ok: true, value: null };
    try {
      JSON.parse(tail);
      return { ok: true, value: null };
    } catch {
      return { ok: true, value: await discardTornTail(path, journal, anchor) };
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * One loud, greppable line describing a settled append.
 *
 * A self-heal that says nothing is a silent trim of the audit trail, so
 * every recovery names the journal, what was done, and — when bytes were
 * moved aside — how many, and where they now live.
 *
 * @param recovery - The recovery to describe
 * @returns The log line, without a trailing newline
 */
export function formatAppendRecovery(recovery: AppendRecovery): string {
  const head = `[SECURITY] [AUDIT_APPEND_RECOVERED] ${recovery.path}: ` +
    `interrupted append ${recovery.kind}`;
  if (recovery.kind === "completed") {
    return `${head} — the entry had reached the journal, so the anchor was ` +
      `advanced to ${recovery.count} entries; nothing was dropped`;
  }
  if (recovery.kind === "rolled-back") {
    return `${head} — the entry never reached the journal, which stands at ` +
      `${recovery.count} entries; nothing was dropped`;
  }
  return `${head} — ${recovery.droppedBytes} torn byte(s) past the anchored ` +
    `head were moved to ${recovery.preservedAs} and the journal truncated ` +
    `to its anchored ${recovery.count} entries; dropped: ${
      JSON.stringify(recovery.droppedText ?? "")
    }`;
}
