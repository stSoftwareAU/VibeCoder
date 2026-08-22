/**
 * Chain anchor for the tamper-evident audit journal (Issue #3712).
 *
 * The SHA-256 chain in `audit_journal.ts` only detects *interior* edits: a
 * truncated tail still verifies clean (the surviving prefix chains
 * perfectly), and deleting the file outright leaves nothing to verify. The
 * anchor closes both holes by persisting the two facts that truncation and
 * deletion destroy — the record **count** and the **head hash** — outside
 * the journal file:
 *
 *   `${dir}/anchors/audit-<workerId>-YYYY-MM-DD.jsonl.anchor.json`
 *
 * A journal that is shorter than its anchor, whose anchored entry no longer
 * carries the anchored hash, or that has vanished while its anchor survives,
 * is tampering — and is reported loud rather than absorbed as a fresh chain
 * (Issue #3234).
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";

/** Persisted head-of-chain state for one journal file. */
export interface ChainAnchor {
  /** Basename of the journal this anchor covers. */
  journal: string;
  /** Number of entries the journal held when the anchor was written. */
  count: number;
  /** Hash of the entry at index `count - 1` ("" when count is 0). */
  headHash: string;
  /** ISO 8601 timestamp of the last anchor update. */
  updatedAt: string;
}

/** Directory name holding anchors, relative to the journal's directory. */
const ANCHOR_DIR = "anchors";

/** Split a path into its directory and basename components. */
function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: ".", base: path };
  return { dir: path.slice(0, idx) || "/", base: path.slice(idx + 1) };
}

/**
 * Anchor file path for a journal.
 *
 * @param journalPath - Path to the `.jsonl` journal
 * @returns Path of the sidecar anchor, in the `anchors/` subdirectory
 */
export function anchorPath(journalPath: string): string {
  const { dir, base } = splitPath(journalPath);
  return `${dir}/${ANCHOR_DIR}/${base}.anchor.json`;
}

/** Journal basename an anchor file covers, or null when not an anchor. */
export function journalNameForAnchor(anchorFileName: string): string | null {
  const suffix = ".anchor.json";
  if (!anchorFileName.endsWith(suffix)) return null;
  const name = anchorFileName.slice(0, -suffix.length);
  return name.length > 0 ? name : null;
}

/** Is `value` a structurally valid anchor record? */
function isAnchor(value: unknown): value is ChainAnchor {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return typeof a["journal"] === "string" &&
    typeof a["count"] === "number" &&
    Number.isInteger(a["count"]) && a["count"] >= 0 &&
    typeof a["headHash"] === "string" &&
    typeof a["updatedAt"] === "string";
}

/**
 * Read the anchor for a journal.
 *
 * @param journalPath - Path to the `.jsonl` journal
 * @returns The anchor, or `null` when no anchor file exists
 * @throws When the anchor exists but is unreadable or malformed — a
 *   corrupted anchor is a tamper signal, never a silent "no anchor".
 */
export async function readAnchor(
  journalPath: string,
): Promise<ChainAnchor | null> {
  const path = anchorPath(journalPath);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw new Error(
      `audit anchor unreadable: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`audit anchor is malformed JSON: ${path}`);
  }
  if (!isAnchor(parsed)) {
    throw new Error(`audit anchor has an unexpected shape: ${path}`);
  }
  return parsed;
}

/**
 * Write (or replace) the anchor for a journal, atomically.
 *
 * @param journalPath - Path to the `.jsonl` journal
 * @param state - Record count and head hash to anchor
 * @param now - ISO timestamp override (tests)
 * @returns Result carrying the persisted anchor
 */
export async function writeAnchor(
  journalPath: string,
  state: { count: number; headHash: string },
  now?: string,
): Promise<Result<ChainAnchor>> {
  const { base } = splitPath(journalPath);
  const target = anchorPath(journalPath);
  const { dir: anchorDir } = splitPath(target);
  const anchor: ChainAnchor = {
    journal: base,
    count: state.count,
    headHash: state.headHash,
    updatedAt: now ?? new Date().toISOString(),
  };
  try {
    await Deno.mkdir(anchorDir, { recursive: true });
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `failed to create audit anchor directory ${anchorDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
  const written = await atomicWrite({
    targetFile: target,
    content: `${JSON.stringify(anchor)}\n`,
  });
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, value: anchor };
}

// ---------------------------------------------------------------------------
// Expected-journal roster (Issue #3949)
// ---------------------------------------------------------------------------

/** One roster line: a journal this audit directory is expected to hold. */
interface RosterEntry {
  journal: string;
  addedAt: string;
}

/**
 * Roster file path for an audit directory.
 *
 * The anchor closed the lone-delete hole, but a journal deleted **together
 * with** its anchor left nothing behind to disagree — and `rm -rf` of the
 * audit directory read as a clean, empty sweep. The roster is the persisted
 * expectation both erase: an append-only JSONL index of every journal name
 * ever anchored, stored as a **sibling of the audit directory** (not inside
 * it) precisely so removing the directory cannot remove the expectation.
 * Deleting the roster together with the directory is closed by a
 * last-known-non-empty marker beside the roster (Issue #270).
 *
 * @param baseDir - Audit directory the roster covers
 * @returns Path of the roster file, beside (not under) `baseDir`
 */
export function rosterPath(baseDir: string): string {
  const trimmed = baseDir.endsWith("/") ? baseDir.slice(0, -1) : baseDir;
  return `${trimmed}.roster.jsonl`;
}

/**
 * Path of the last-known-non-empty roster marker (Issue #270).
 *
 * Sibling of the roster — not the roster itself, and not under the audit
 * directory — so deleting `${dir}` and `${dir}.roster.jsonl` together
 * cannot also remove this witness unless the principal knows to look for
 * it.
 *
 * @param baseDir - Audit directory the roster covers
 * @returns Path of the seen-marker file, beside (not under) `baseDir`
 */
export function rosterSeenPath(baseDir: string): string {
  const trimmed = baseDir.endsWith("/") ? baseDir.slice(0, -1) : baseDir;
  return `${trimmed}.roster.seen`;
}

/** Is `value` a structurally valid roster entry? */
function isRosterEntry(value: unknown): value is RosterEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e["journal"] === "string" && e["journal"].length > 0 &&
    typeof e["addedAt"] === "string";
}

/**
 * Read the roster for an audit directory.
 *
 * @param baseDir - Audit directory the roster covers
 * @returns Deduplicated journal basenames, in first-seen order (empty when
 *   no roster file exists)
 * @throws When the roster exists but a line is unreadable or malformed — a
 *   corrupted roster is a tamper signal, never a silent "no expectations".
 */
export async function readRoster(baseDir: string): Promise<string[]> {
  const path = rosterPath(baseDir);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw new Error(
      `audit roster unreadable: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`audit roster has a malformed line: ${path}: ${line}`);
    }
    if (!isRosterEntry(parsed)) {
      throw new Error(
        `audit roster entry has an unexpected shape: ${path}: ${line}`,
      );
    }
    if (!seen.has(parsed.journal)) {
      seen.add(parsed.journal);
      names.push(parsed.journal);
    }
  }
  return names;
}

/**
 * Record a journal in the roster (idempotent, append-only).
 *
 * @param baseDir - Audit directory the roster covers
 * @param journalName - Basename of the journal to expect from now on
 * @param now - ISO timestamp override (tests)
 * @returns Result; ok when the journal is on the roster (already or newly)
 */
export async function addToRoster(
  baseDir: string,
  journalName: string,
  now?: string,
): Promise<Result<void>> {
  try {
    const existing = await readRoster(baseDir);
    if (!existing.includes(journalName)) {
      const entry: RosterEntry = {
        journal: journalName,
        addedAt: now ?? new Date().toISOString(),
      };
      await Deno.writeTextFile(
        rosterPath(baseDir),
        `${JSON.stringify(entry)}\n`,
        { append: true },
      );
    }
    // Issue #270: persist a third witness the first time the roster is
    // known to be non-empty, including the idempotent already-present
    // path so an upgrade writes the marker on the next append.
    const marked = await markRosterSeen(baseDir, now);
    if (!marked.ok) return marked;
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Persist the last-known-non-empty roster marker (idempotent).
 *
 * @param baseDir - Audit directory the roster covers
 * @param now - ISO timestamp override (tests)
 * @returns Result; ok when the marker is on disk (already or newly)
 */
export async function markRosterSeen(
  baseDir: string,
  now?: string,
): Promise<Result<void>> {
  const path = rosterSeenPath(baseDir);
  try {
    const stat = await Deno.stat(path);
    if (stat.isFile) return { ok: true, value: undefined };
    return {
      ok: false,
      error: new Error(`audit roster-seen marker is not a file: ${path}`),
    };
  } catch (error: unknown) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: new Error(
          `audit roster-seen marker unreadable: ${path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }
  }
  const marker = {
    nonEmpty: true,
    updatedAt: now ?? new Date().toISOString(),
  };
  const written = await atomicWrite({
    targetFile: path,
    content: `${JSON.stringify(marker)}\n`,
  });
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, value: undefined };
}

/**
 * Has this audit directory ever been observed with a non-empty roster?
 *
 * @param baseDir - Audit directory the roster covers
 * @returns True when the seen-marker file exists
 * @throws When the marker path exists but is unreadable or not a file —
 *   a corrupted witness is a tamper signal, never a silent "never seen".
 */
export async function rosterWasSeen(baseDir: string): Promise<boolean> {
  const path = rosterSeenPath(baseDir);
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) {
      throw new Error(`audit roster-seen marker is not a file: ${path}`);
    }
    return true;
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error instanceof Error ? error : new Error(
      `audit roster-seen marker unreadable: ${path}: ${String(error)}`,
    );
  }
}
