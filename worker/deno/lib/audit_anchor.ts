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

/**
 * Write-ahead record of an append that is in flight (Issue #1074).
 *
 * A journal line and its anchor are two files and cannot be updated
 * atomically, so a process killed between them leaves a journal that
 * disagrees with its anchor — indistinguishable, after the fact, from a
 * forged tail. Declaring the append **before** making it removes the
 * ambiguity: the entry that was in flight is named by its chain hash, so
 * recovery can finish the append, roll it back, or discard a torn line,
 * and anything the writer never declared stays broken.
 *
 * Naming the *hash* rather than the payload is what keeps this from being
 * a forgery aid: producing a different entry that satisfies a pending
 * record means finding a SHA-256 second preimage.
 */
export interface PendingAppend {
  /** Chain hash of the entry the writer was about to append. */
  hash: string;
  /** ISO 8601 timestamp the append was declared. */
  startedAt: string;
}

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
  /** Append declared but not yet confirmed (Issue #1074). */
  pending?: PendingAppend;
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

/**
 * Is `value` a structurally valid pending-append record (Issue #1074)?
 *
 * Absent is valid — the steady state carries no pending record. Present
 * but malformed is not: a half-written intent record is a tamper signal
 * like any other, and `readAnchor` rejects the whole anchor for it rather
 * than quietly reading it as "no append was in flight".
 */
function hasValidPending(value: Record<string, unknown>): boolean {
  const pending = value["pending"];
  if (pending === undefined) return true;
  if (typeof pending !== "object" || pending === null) return false;
  const p = pending as Record<string, unknown>;
  return typeof p["hash"] === "string" && /^[0-9a-f]{64}$/.test(p["hash"]) &&
    typeof p["startedAt"] === "string" && p["startedAt"].length > 0;
}

/** Is `value` a structurally valid anchor record? */
function isAnchor(value: unknown): value is ChainAnchor {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return typeof a["journal"] === "string" &&
    typeof a["count"] === "number" &&
    Number.isInteger(a["count"]) && a["count"] >= 0 &&
    typeof a["headHash"] === "string" &&
    typeof a["updatedAt"] === "string" &&
    hasValidPending(a);
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
 * A `pending` record is written only when the caller supplies one, so the
 * confirming write after a successful append clears it (Issue #1074).
 *
 * @param journalPath - Path to the `.jsonl` journal
 * @param state - Record count, head hash, and any in-flight append
 * @param now - ISO timestamp override (tests)
 * @returns Result carrying the persisted anchor
 */
export async function writeAnchor(
  journalPath: string,
  state: { count: number; headHash: string; pending?: PendingAppend },
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
    ...(state.pending ? { pending: state.pending } : {}),
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
 * One roster line acknowledging that an expected journal is genuinely gone
 * and the loss has been accounted for (Issue #359).
 *
 * The roster stays append-only: acknowledging a loss **adds** a line, it
 * never removes the `RosterEntry` that records the journal existed. The
 * roster therefore keeps saying "this journal was here" and additionally
 * says "and its absence was signed for, by whom, when, and why".
 *
 * This is not a claim of unforgeability. A principal who can append to the
 * roster can already delete it outright — which trips the complete-erasure
 * alarm (Issue #270). What the acknowledgement buys is accountability: the
 * loss stops being an anonymous recurring alarm and becomes a dated,
 * attributed, reviewable record, mirrored into the hash chain itself by
 * `acknowledgeJournalLoss` in `audit_journal.ts`.
 */
export interface RosterAcknowledgement {
  /** Basename of the journal whose loss is acknowledged. */
  journal: string;
  /** ISO 8601 timestamp the acknowledgement was recorded. */
  acknowledgedAt: string;
  /** Why the journal is gone — free text, required, never empty. */
  reason: string;
  /** Who signed for the loss. */
  by: string;
}

/**
 * One roster line signing for a journal that is **present but does not
 * verify** (Issue #491).
 *
 * Distinct from {@link RosterAcknowledgement} on purpose, and never
 * interchangeable with it: signing that a journal is *gone* must not
 * silence one that is *corrupt*, and vice versa. `kind` is the
 * discriminator, and a loss line is refused if it carries it.
 *
 * The signature is pinned to the bytes it was given. `digest` is the
 * SHA-256 of the journal at the moment of signing and `entries` its line
 * count; the sweep only honours the acknowledgement while the file still
 * hashes to that value. Without the pin, signing for today's damage would
 * also bless every future edit to the same file — which is laundering, and
 * is exactly what the loss path already refuses to do.
 */
export interface RosterDamageAcknowledgement extends RosterAcknowledgement {
  /** Discriminator: this line signs for damage, not for a loss. */
  kind: "damage";
  /** Lowercase hex SHA-256 of the journal's bytes when it was signed for. */
  digest: string;
  /** Number of entries the journal held when it was signed for. */
  entries: number;
}

/** Everything one roster file holds, in a single read. */
export interface RosterContents {
  /** Journal basenames the directory is expected to hold, first-seen order. */
  journals: string[];
  /** Acknowledged losses, keyed by journal basename (last line wins). */
  acknowledged: Map<string, RosterAcknowledgement>;
  /** Acknowledged damage, keyed by journal basename (last line wins). */
  damaged: Map<string, RosterDamageAcknowledgement>;
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

/** The four fields every acknowledgement line carries (Issue #359). */
function hasAcknowledgementShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e["journal"] === "string" && e["journal"].length > 0 &&
    typeof e["acknowledgedAt"] === "string" &&
    typeof e["reason"] === "string" && e["reason"].trim().length > 0 &&
    typeof e["by"] === "string" && e["by"].trim().length > 0;
}

/**
 * Is `value` a structurally valid *loss* acknowledgement (Issue #359)?
 *
 * A line carrying `kind` is refused here: a damage signature must never be
 * read as a loss signature, which would silence a genuinely deleted
 * journal (Issue #491).
 */
function isRosterAcknowledgement(
  value: unknown,
): value is RosterAcknowledgement {
  if (!hasAcknowledgementShape(value)) return false;
  return (value as Record<string, unknown>)["kind"] === undefined;
}

/** Is `value` a structurally valid *damage* acknowledgement (Issue #491)? */
function isRosterDamageAcknowledgement(
  value: unknown,
): value is RosterDamageAcknowledgement {
  if (!hasAcknowledgementShape(value)) return false;
  const e = value as Record<string, unknown>;
  return e["kind"] === "damage" &&
    typeof e["digest"] === "string" && /^[0-9a-f]{64}$/.test(e["digest"]) &&
    typeof e["entries"] === "number" && Number.isInteger(e["entries"]) &&
    e["entries"] >= 0;
}

/**
 * Read the whole roster for an audit directory — expectations and
 * acknowledgements in one pass.
 *
 * @param baseDir - Audit directory the roster covers
 * @returns Journal basenames in first-seen order, plus acknowledged losses
 *   (both empty when no roster file exists)
 * @throws When the roster exists but a line is unreadable or matches
 *   neither line shape — a corrupted roster is a tamper signal, never a
 *   silent "no expectations".
 */
export async function readRosterContents(
  baseDir: string,
): Promise<RosterContents> {
  const path = rosterPath(baseDir);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) {
      return { journals: [], acknowledged: new Map(), damaged: new Map() };
    }
    throw new Error(
      `audit roster unreadable: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const journals: string[] = [];
  const seen = new Set<string>();
  const acknowledged = new Map<string, RosterAcknowledgement>();
  const damaged = new Map<string, RosterDamageAcknowledgement>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`audit roster has a malformed line: ${path}: ${line}`);
    }
    // Acknowledgements are checked first: they carry `journal` too, and a
    // half-formed acknowledgement must be rejected rather than silently
    // read as an expectation line that happens to lack `addedAt`.
    if (isRosterDamageAcknowledgement(parsed)) {
      damaged.set(parsed.journal, parsed);
      continue;
    }
    if (isRosterAcknowledgement(parsed)) {
      acknowledged.set(parsed.journal, parsed);
      continue;
    }
    if (!isRosterEntry(parsed)) {
      throw new Error(
        `audit roster entry has an unexpected shape: ${path}: ${line}`,
      );
    }
    if (!seen.has(parsed.journal)) {
      seen.add(parsed.journal);
      journals.push(parsed.journal);
    }
  }
  return { journals, acknowledged, damaged };
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
  return (await readRosterContents(baseDir)).journals;
}

/**
 * Record that an expected journal is genuinely gone and the loss has been
 * accounted for (Issue #359).
 *
 * Append-only, like every other roster write: the journal's `RosterEntry`
 * stays exactly where it is, and this adds a dated, attributed line beside
 * it. Re-acknowledging a journal appends a fresh line; the newest wins.
 *
 * The caller is responsible for the checks that make an acknowledgement
 * legitimate — that the journal is on the roster, that it really is absent,
 * and that the act has been mirrored into the hash chain. See
 * `acknowledgeJournalLoss` in `audit_journal.ts`, which is the only
 * supported way in.
 *
 * @param baseDir - Audit directory the roster covers
 * @param journalName - Basename of the lost journal
 * @param reason - Why it is gone; must not be blank
 * @param by - Who is signing for the loss; must not be blank
 * @param now - ISO timestamp override (tests)
 * @returns Result carrying the appended acknowledgement
 */
export async function acknowledgeRosterLoss(
  baseDir: string,
  journalName: string,
  reason: string,
  by: string,
  now?: string,
): Promise<Result<RosterAcknowledgement>> {
  if (reason.trim().length === 0) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge ${journalName}: a reason is required`,
      ),
    };
  }
  if (by.trim().length === 0) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge ${journalName}: an operator identity is ` +
          `required`,
      ),
    };
  }
  const acknowledgement: RosterAcknowledgement = {
    journal: journalName,
    acknowledgedAt: now ?? new Date().toISOString(),
    reason: reason.trim(),
    by: by.trim(),
  };
  try {
    await Deno.writeTextFile(
      rosterPath(baseDir),
      `${JSON.stringify(acknowledgement)}\n`,
      { append: true },
    );
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `audit roster acknowledgement could not be appended: ${
          rosterPath(baseDir)
        }: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  return { ok: true, value: acknowledgement };
}

/**
 * Sign for a journal that is present but does not verify (Issue #491).
 *
 * Append-only like every other roster write, and pinned to the bytes it
 * was shown: the sweep honours the signature only while the journal still
 * hashes to `digest`, so this closes today's alarm without blessing
 * tomorrow's edit. The journal file itself is never touched.
 *
 * The caller is responsible for the checks that make the signature
 * legitimate — that the journal really is on disk, really does fail, and
 * that the act has been mirrored into a healthy hash chain. See
 * `acknowledgeJournalDamage` in `audit_journal.ts`, which is the only
 * supported way in.
 *
 * @param baseDir - Audit directory the roster covers
 * @param journalName - Basename of the damaged journal
 * @param reason - Why the damage is accounted for; must not be blank
 * @param by - Who is signing; must not be blank
 * @param digest - SHA-256 of the journal's bytes, as signed for
 * @param entries - Line count of the journal, as signed for
 * @param now - ISO timestamp override (tests)
 * @returns Result carrying the appended acknowledgement
 */
export async function acknowledgeRosterDamage(
  baseDir: string,
  journalName: string,
  reason: string,
  by: string,
  digest: string,
  entries: number,
  now?: string,
): Promise<Result<RosterDamageAcknowledgement>> {
  if (reason.trim().length === 0) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge damage to ${journalName}: a reason is ` +
          `required`,
      ),
    };
  }
  if (by.trim().length === 0) {
    return {
      ok: false,
      error: new Error(
        `refusing to acknowledge damage to ${journalName}: an operator ` +
          `identity is required`,
      ),
    };
  }
  const acknowledgement: RosterDamageAcknowledgement = {
    kind: "damage",
    journal: journalName,
    acknowledgedAt: now ?? new Date().toISOString(),
    reason: reason.trim(),
    by: by.trim(),
    digest,
    entries,
  };
  try {
    await Deno.writeTextFile(
      rosterPath(baseDir),
      `${JSON.stringify(acknowledgement)}\n`,
      { append: true },
    );
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `audit roster damage acknowledgement could not be appended: ${
          rosterPath(baseDir)
        }: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  return { ok: true, value: acknowledgement };
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
