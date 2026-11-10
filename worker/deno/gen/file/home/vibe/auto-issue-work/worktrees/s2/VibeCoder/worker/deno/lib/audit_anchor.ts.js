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
 */ import { atomicWrite } from "./file_utils.ts";
/** Directory name holding anchors, relative to the journal's directory. */ const ANCHOR_DIR = "anchors";
/** Split a path into its directory and basename components. */ function splitPath(path) {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return {
    dir: ".",
    base: path
  };
  return {
    dir: path.slice(0, idx) || "/",
    base: path.slice(idx + 1)
  };
}
/**
 * Anchor file path for a journal.
 *
 * @param journalPath - Path to the `.jsonl` journal
 * @returns Path of the sidecar anchor, in the `anchors/` subdirectory
 */ export function anchorPath(journalPath) {
  const { dir, base } = splitPath(journalPath);
  return `${dir}/${ANCHOR_DIR}/${base}.anchor.json`;
}
/** Journal basename an anchor file covers, or null when not an anchor. */ export function journalNameForAnchor(anchorFileName) {
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
 */ function hasValidPending(value) {
  const pending = value["pending"];
  if (pending === undefined) return true;
  if (typeof pending !== "object" || pending === null) return false;
  const p = pending;
  return typeof p["hash"] === "string" && /^[0-9a-f]{64}$/.test(p["hash"]) && typeof p["startedAt"] === "string" && p["startedAt"].length > 0;
}
/** Is `value` a structurally valid anchor record? */ function isAnchor(value) {
  if (typeof value !== "object" || value === null) return false;
  const a = value;
  return typeof a["journal"] === "string" && typeof a["count"] === "number" && Number.isInteger(a["count"]) && a["count"] >= 0 && typeof a["headHash"] === "string" && typeof a["updatedAt"] === "string" && hasValidPending(a);
}
/**
 * Read the anchor for a journal.
 *
 * @param journalPath - Path to the `.jsonl` journal
 * @returns The anchor, or `null` when no anchor file exists
 * @throws When the anchor exists but is unreadable or malformed — a
 *   corrupted anchor is a tamper signal, never a silent "no anchor".
 */ export async function readAnchor(journalPath) {
  const path = anchorPath(journalPath);
  let raw;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw new Error(`audit anchor unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch  {
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
 */ export async function writeAnchor(journalPath, state, now) {
  const { base } = splitPath(journalPath);
  const target = anchorPath(journalPath);
  const { dir: anchorDir } = splitPath(target);
  const anchor = {
    journal: base,
    count: state.count,
    headHash: state.headHash,
    updatedAt: now ?? new Date().toISOString(),
    ...state.pending ? {
      pending: state.pending
    } : {}
  };
  try {
    await Deno.mkdir(anchorDir, {
      recursive: true
    });
  } catch (error) {
    return {
      ok: false,
      error: new Error(`failed to create audit anchor directory ${anchorDir}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
  const written = await atomicWrite({
    targetFile: target,
    content: `${JSON.stringify(anchor)}\n`
  });
  if (!written.ok) return {
    ok: false,
    error: written.error
  };
  return {
    ok: true,
    value: anchor
  };
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
 */ export function rosterPath(baseDir) {
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
 */ export function rosterSeenPath(baseDir) {
  const trimmed = baseDir.endsWith("/") ? baseDir.slice(0, -1) : baseDir;
  return `${trimmed}.roster.seen`;
}
/** Is `value` a structurally valid roster entry? */ function isRosterEntry(value) {
  if (typeof value !== "object" || value === null) return false;
  const e = value;
  return typeof e["journal"] === "string" && e["journal"].length > 0 && typeof e["addedAt"] === "string";
}
/** The four fields every acknowledgement line carries (Issue #359). */ function hasAcknowledgementShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const e = value;
  return typeof e["journal"] === "string" && e["journal"].length > 0 && typeof e["acknowledgedAt"] === "string" && typeof e["reason"] === "string" && e["reason"].trim().length > 0 && typeof e["by"] === "string" && e["by"].trim().length > 0;
}
/**
 * Is `value` a structurally valid *loss* acknowledgement (Issue #359)?
 *
 * A line carrying `kind` is refused here: a damage signature must never be
 * read as a loss signature, which would silence a genuinely deleted
 * journal (Issue #491).
 */ function isRosterAcknowledgement(value) {
  if (!hasAcknowledgementShape(value)) return false;
  return value["kind"] === undefined;
}
/** Is `value` a structurally valid *damage* acknowledgement (Issue #491)? */ function isRosterDamageAcknowledgement(value) {
  if (!hasAcknowledgementShape(value)) return false;
  const e = value;
  return e["kind"] === "damage" && typeof e["digest"] === "string" && /^[0-9a-f]{64}$/.test(e["digest"]) && typeof e["entries"] === "number" && Number.isInteger(e["entries"]) && e["entries"] >= 0;
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
 */ export async function readRosterContents(baseDir) {
  const path = rosterPath(baseDir);
  let raw;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        journals: [],
        acknowledged: new Map(),
        damaged: new Map()
      };
    }
    throw new Error(`audit roster unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const journals = [];
  const seen = new Set();
  const acknowledged = new Map();
  const damaged = new Map();
  for (const line of raw.split("\n")){
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch  {
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
      throw new Error(`audit roster entry has an unexpected shape: ${path}: ${line}`);
    }
    if (!seen.has(parsed.journal)) {
      seen.add(parsed.journal);
      journals.push(parsed.journal);
    }
  }
  return {
    journals,
    acknowledged,
    damaged
  };
}
/**
 * Read the roster for an audit directory.
 *
 * @param baseDir - Audit directory the roster covers
 * @returns Deduplicated journal basenames, in first-seen order (empty when
 *   no roster file exists)
 * @throws When the roster exists but a line is unreadable or malformed — a
 *   corrupted roster is a tamper signal, never a silent "no expectations".
 */ export async function readRoster(baseDir) {
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
 */ export async function acknowledgeRosterLoss(baseDir, journalName, reason, by, now) {
  if (reason.trim().length === 0) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge ${journalName}: a reason is required`)
    };
  }
  if (by.trim().length === 0) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge ${journalName}: an operator identity is ` + `required`)
    };
  }
  const acknowledgement = {
    journal: journalName,
    acknowledgedAt: now ?? new Date().toISOString(),
    reason: reason.trim(),
    by: by.trim()
  };
  try {
    await Deno.writeTextFile(rosterPath(baseDir), `${JSON.stringify(acknowledgement)}\n`, {
      append: true
    });
  } catch (error) {
    return {
      ok: false,
      error: new Error(`audit roster acknowledgement could not be appended: ${rosterPath(baseDir)}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
  return {
    ok: true,
    value: acknowledgement
  };
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
 */ export async function acknowledgeRosterDamage(baseDir, journalName, reason, by, digest, entries, now) {
  if (reason.trim().length === 0) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge damage to ${journalName}: a reason is ` + `required`)
    };
  }
  if (by.trim().length === 0) {
    return {
      ok: false,
      error: new Error(`refusing to acknowledge damage to ${journalName}: an operator ` + `identity is required`)
    };
  }
  const acknowledgement = {
    kind: "damage",
    journal: journalName,
    acknowledgedAt: now ?? new Date().toISOString(),
    reason: reason.trim(),
    by: by.trim(),
    digest,
    entries
  };
  try {
    await Deno.writeTextFile(rosterPath(baseDir), `${JSON.stringify(acknowledgement)}\n`, {
      append: true
    });
  } catch (error) {
    return {
      ok: false,
      error: new Error(`audit roster damage acknowledgement could not be appended: ${rosterPath(baseDir)}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
  return {
    ok: true,
    value: acknowledgement
  };
}
/**
 * Record a journal in the roster (idempotent, append-only).
 *
 * @param baseDir - Audit directory the roster covers
 * @param journalName - Basename of the journal to expect from now on
 * @param now - ISO timestamp override (tests)
 * @returns Result; ok when the journal is on the roster (already or newly)
 */ export async function addToRoster(baseDir, journalName, now) {
  try {
    const existing = await readRoster(baseDir);
    if (!existing.includes(journalName)) {
      const entry = {
        journal: journalName,
        addedAt: now ?? new Date().toISOString()
      };
      await Deno.writeTextFile(rosterPath(baseDir), `${JSON.stringify(entry)}\n`, {
        append: true
      });
    }
    // Issue #270: persist a third witness the first time the roster is
    // known to be non-empty, including the idempotent already-present
    // path so an upgrade writes the marker on the next append.
    const marked = await markRosterSeen(baseDir, now);
    if (!marked.ok) return marked;
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
/**
 * Persist the last-known-non-empty roster marker (idempotent).
 *
 * @param baseDir - Audit directory the roster covers
 * @param now - ISO timestamp override (tests)
 * @returns Result; ok when the marker is on disk (already or newly)
 */ export async function markRosterSeen(baseDir, now) {
  const path = rosterSeenPath(baseDir);
  try {
    const stat = await Deno.stat(path);
    if (stat.isFile) return {
      ok: true,
      value: undefined
    };
    return {
      ok: false,
      error: new Error(`audit roster-seen marker is not a file: ${path}`)
    };
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: new Error(`audit roster-seen marker unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`)
      };
    }
  }
  const marker = {
    nonEmpty: true,
    updatedAt: now ?? new Date().toISOString()
  };
  // The temp file lives inside the journal directory, not beside the
  // marker (Issue #1604): the agent-side gh guard journals a refusal from a
  // child whose write grant is the journal directory plus this one file, so
  // a sibling temp path would be refused — and the marker never written.
  const written = await atomicWrite({
    targetFile: path,
    content: `${JSON.stringify(marker)}\n`,
    tempDir: baseDir
  });
  if (!written.ok) return {
    ok: false,
    error: written.error
  };
  return {
    ok: true,
    value: undefined
  };
}
/**
 * Has this audit directory ever been observed with a non-empty roster?
 *
 * @param baseDir - Audit directory the roster covers
 * @returns True when the seen-marker file exists
 * @throws When the marker path exists but is unreadable or not a file —
 *   a corrupted witness is a tamper signal, never a silent "never seen".
 */ export async function rosterWasSeen(baseDir) {
  const path = rosterSeenPath(baseDir);
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) {
      throw new Error(`audit roster-seen marker is not a file: ${path}`);
    }
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error instanceof Error ? error : new Error(`audit roster-seen marker unreadable: ${path}: ${String(error)}`);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hdWRpdF9hbmNob3IudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDaGFpbiBhbmNob3IgZm9yIHRoZSB0YW1wZXItZXZpZGVudCBhdWRpdCBqb3VybmFsIChJc3N1ZSAjMzcxMikuXG4gKlxuICogVGhlIFNIQS0yNTYgY2hhaW4gaW4gYGF1ZGl0X2pvdXJuYWwudHNgIG9ubHkgZGV0ZWN0cyAqaW50ZXJpb3IqIGVkaXRzOiBhXG4gKiB0cnVuY2F0ZWQgdGFpbCBzdGlsbCB2ZXJpZmllcyBjbGVhbiAodGhlIHN1cnZpdmluZyBwcmVmaXggY2hhaW5zXG4gKiBwZXJmZWN0bHkpLCBhbmQgZGVsZXRpbmcgdGhlIGZpbGUgb3V0cmlnaHQgbGVhdmVzIG5vdGhpbmcgdG8gdmVyaWZ5LiBUaGVcbiAqIGFuY2hvciBjbG9zZXMgYm90aCBob2xlcyBieSBwZXJzaXN0aW5nIHRoZSB0d28gZmFjdHMgdGhhdCB0cnVuY2F0aW9uIGFuZFxuICogZGVsZXRpb24gZGVzdHJveSDigJQgdGhlIHJlY29yZCAqKmNvdW50KiogYW5kIHRoZSAqKmhlYWQgaGFzaCoqIOKAlCBvdXRzaWRlXG4gKiB0aGUgam91cm5hbCBmaWxlOlxuICpcbiAqICAgYCR7ZGlyfS9hbmNob3JzL2F1ZGl0LTx3b3JrZXJJZD4tWVlZWS1NTS1ERC5qc29ubC5hbmNob3IuanNvbmBcbiAqXG4gKiBBIGpvdXJuYWwgdGhhdCBpcyBzaG9ydGVyIHRoYW4gaXRzIGFuY2hvciwgd2hvc2UgYW5jaG9yZWQgZW50cnkgbm8gbG9uZ2VyXG4gKiBjYXJyaWVzIHRoZSBhbmNob3JlZCBoYXNoLCBvciB0aGF0IGhhcyB2YW5pc2hlZCB3aGlsZSBpdHMgYW5jaG9yIHN1cnZpdmVzLFxuICogaXMgdGFtcGVyaW5nIOKAlCBhbmQgaXMgcmVwb3J0ZWQgbG91ZCByYXRoZXIgdGhhbiBhYnNvcmJlZCBhcyBhIGZyZXNoIGNoYWluXG4gKiAoSXNzdWUgIzMyMzQpLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uLCBhdXRob3Jpc2VkKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgYXRvbWljV3JpdGUgfSBmcm9tIFwiLi9maWxlX3V0aWxzLnRzXCI7XG5cbi8qKlxuICogV3JpdGUtYWhlYWQgcmVjb3JkIG9mIGFuIGFwcGVuZCB0aGF0IGlzIGluIGZsaWdodCAoSXNzdWUgIzEwNzQpLlxuICpcbiAqIEEgam91cm5hbCBsaW5lIGFuZCBpdHMgYW5jaG9yIGFyZSB0d28gZmlsZXMgYW5kIGNhbm5vdCBiZSB1cGRhdGVkXG4gKiBhdG9taWNhbGx5LCBzbyBhIHByb2Nlc3Mga2lsbGVkIGJldHdlZW4gdGhlbSBsZWF2ZXMgYSBqb3VybmFsIHRoYXRcbiAqIGRpc2FncmVlcyB3aXRoIGl0cyBhbmNob3Ig4oCUIGluZGlzdGluZ3Vpc2hhYmxlLCBhZnRlciB0aGUgZmFjdCwgZnJvbSBhXG4gKiBmb3JnZWQgdGFpbC4gRGVjbGFyaW5nIHRoZSBhcHBlbmQgKipiZWZvcmUqKiBtYWtpbmcgaXQgcmVtb3ZlcyB0aGVcbiAqIGFtYmlndWl0eTogdGhlIGVudHJ5IHRoYXQgd2FzIGluIGZsaWdodCBpcyBuYW1lZCBieSBpdHMgY2hhaW4gaGFzaCwgc29cbiAqIHJlY292ZXJ5IGNhbiBmaW5pc2ggdGhlIGFwcGVuZCwgcm9sbCBpdCBiYWNrLCBvciBkaXNjYXJkIGEgdG9ybiBsaW5lLFxuICogYW5kIGFueXRoaW5nIHRoZSB3cml0ZXIgbmV2ZXIgZGVjbGFyZWQgc3RheXMgYnJva2VuLlxuICpcbiAqIE5hbWluZyB0aGUgKmhhc2gqIHJhdGhlciB0aGFuIHRoZSBwYXlsb2FkIGlzIHdoYXQga2VlcHMgdGhpcyBmcm9tIGJlaW5nXG4gKiBhIGZvcmdlcnkgYWlkOiBwcm9kdWNpbmcgYSBkaWZmZXJlbnQgZW50cnkgdGhhdCBzYXRpc2ZpZXMgYSBwZW5kaW5nXG4gKiByZWNvcmQgbWVhbnMgZmluZGluZyBhIFNIQS0yNTYgc2Vjb25kIHByZWltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFBlbmRpbmdBcHBlbmQge1xuICAvKiogQ2hhaW4gaGFzaCBvZiB0aGUgZW50cnkgdGhlIHdyaXRlciB3YXMgYWJvdXQgdG8gYXBwZW5kLiAqL1xuICBoYXNoOiBzdHJpbmc7XG4gIC8qKiBJU08gODYwMSB0aW1lc3RhbXAgdGhlIGFwcGVuZCB3YXMgZGVjbGFyZWQuICovXG4gIHN0YXJ0ZWRBdDogc3RyaW5nO1xufVxuXG4vKiogUGVyc2lzdGVkIGhlYWQtb2YtY2hhaW4gc3RhdGUgZm9yIG9uZSBqb3VybmFsIGZpbGUuICovXG5leHBvcnQgaW50ZXJmYWNlIENoYWluQW5jaG9yIHtcbiAgLyoqIEJhc2VuYW1lIG9mIHRoZSBqb3VybmFsIHRoaXMgYW5jaG9yIGNvdmVycy4gKi9cbiAgam91cm5hbDogc3RyaW5nO1xuICAvKiogTnVtYmVyIG9mIGVudHJpZXMgdGhlIGpvdXJuYWwgaGVsZCB3aGVuIHRoZSBhbmNob3Igd2FzIHdyaXR0ZW4uICovXG4gIGNvdW50OiBudW1iZXI7XG4gIC8qKiBIYXNoIG9mIHRoZSBlbnRyeSBhdCBpbmRleCBgY291bnQgLSAxYCAoXCJcIiB3aGVuIGNvdW50IGlzIDApLiAqL1xuICBoZWFkSGFzaDogc3RyaW5nO1xuICAvKiogSVNPIDg2MDEgdGltZXN0YW1wIG9mIHRoZSBsYXN0IGFuY2hvciB1cGRhdGUuICovXG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xuICAvKiogQXBwZW5kIGRlY2xhcmVkIGJ1dCBub3QgeWV0IGNvbmZpcm1lZCAoSXNzdWUgIzEwNzQpLiAqL1xuICBwZW5kaW5nPzogUGVuZGluZ0FwcGVuZDtcbn1cblxuLyoqIERpcmVjdG9yeSBuYW1lIGhvbGRpbmcgYW5jaG9ycywgcmVsYXRpdmUgdG8gdGhlIGpvdXJuYWwncyBkaXJlY3RvcnkuICovXG5jb25zdCBBTkNIT1JfRElSID0gXCJhbmNob3JzXCI7XG5cbi8qKiBTcGxpdCBhIHBhdGggaW50byBpdHMgZGlyZWN0b3J5IGFuZCBiYXNlbmFtZSBjb21wb25lbnRzLiAqL1xuZnVuY3Rpb24gc3BsaXRQYXRoKHBhdGg6IHN0cmluZyk6IHsgZGlyOiBzdHJpbmc7IGJhc2U6IHN0cmluZyB9IHtcbiAgY29uc3QgaWR4ID0gcGF0aC5sYXN0SW5kZXhPZihcIi9cIik7XG4gIGlmIChpZHggPCAwKSByZXR1cm4geyBkaXI6IFwiLlwiLCBiYXNlOiBwYXRoIH07XG4gIHJldHVybiB7IGRpcjogcGF0aC5zbGljZSgwLCBpZHgpIHx8IFwiL1wiLCBiYXNlOiBwYXRoLnNsaWNlKGlkeCArIDEpIH07XG59XG5cbi8qKlxuICogQW5jaG9yIGZpbGUgcGF0aCBmb3IgYSBqb3VybmFsLlxuICpcbiAqIEBwYXJhbSBqb3VybmFsUGF0aCAtIFBhdGggdG8gdGhlIGAuanNvbmxgIGpvdXJuYWxcbiAqIEByZXR1cm5zIFBhdGggb2YgdGhlIHNpZGVjYXIgYW5jaG9yLCBpbiB0aGUgYGFuY2hvcnMvYCBzdWJkaXJlY3RvcnlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFuY2hvclBhdGgoam91cm5hbFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHsgZGlyLCBiYXNlIH0gPSBzcGxpdFBhdGgoam91cm5hbFBhdGgpO1xuICByZXR1cm4gYCR7ZGlyfS8ke0FOQ0hPUl9ESVJ9LyR7YmFzZX0uYW5jaG9yLmpzb25gO1xufVxuXG4vKiogSm91cm5hbCBiYXNlbmFtZSBhbiBhbmNob3IgZmlsZSBjb3ZlcnMsIG9yIG51bGwgd2hlbiBub3QgYW4gYW5jaG9yLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGpvdXJuYWxOYW1lRm9yQW5jaG9yKGFuY2hvckZpbGVOYW1lOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3Qgc3VmZml4ID0gXCIuYW5jaG9yLmpzb25cIjtcbiAgaWYgKCFhbmNob3JGaWxlTmFtZS5lbmRzV2l0aChzdWZmaXgpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgbmFtZSA9IGFuY2hvckZpbGVOYW1lLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKTtcbiAgcmV0dXJuIG5hbWUubGVuZ3RoID4gMCA/IG5hbWUgOiBudWxsO1xufVxuXG4vKipcbiAqIElzIGB2YWx1ZWAgYSBzdHJ1Y3R1cmFsbHkgdmFsaWQgcGVuZGluZy1hcHBlbmQgcmVjb3JkIChJc3N1ZSAjMTA3NCk/XG4gKlxuICogQWJzZW50IGlzIHZhbGlkIOKAlCB0aGUgc3RlYWR5IHN0YXRlIGNhcnJpZXMgbm8gcGVuZGluZyByZWNvcmQuIFByZXNlbnRcbiAqIGJ1dCBtYWxmb3JtZWQgaXMgbm90OiBhIGhhbGYtd3JpdHRlbiBpbnRlbnQgcmVjb3JkIGlzIGEgdGFtcGVyIHNpZ25hbFxuICogbGlrZSBhbnkgb3RoZXIsIGFuZCBgcmVhZEFuY2hvcmAgcmVqZWN0cyB0aGUgd2hvbGUgYW5jaG9yIGZvciBpdCByYXRoZXJcbiAqIHRoYW4gcXVpZXRseSByZWFkaW5nIGl0IGFzIFwibm8gYXBwZW5kIHdhcyBpbiBmbGlnaHRcIi5cbiAqL1xuZnVuY3Rpb24gaGFzVmFsaWRQZW5kaW5nKHZhbHVlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IGJvb2xlYW4ge1xuICBjb25zdCBwZW5kaW5nID0gdmFsdWVbXCJwZW5kaW5nXCJdO1xuICBpZiAocGVuZGluZyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKHR5cGVvZiBwZW5kaW5nICE9PSBcIm9iamVjdFwiIHx8IHBlbmRpbmcgPT09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgcCA9IHBlbmRpbmcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiB0eXBlb2YgcFtcImhhc2hcIl0gPT09IFwic3RyaW5nXCIgJiYgL15bMC05YS1mXXs2NH0kLy50ZXN0KHBbXCJoYXNoXCJdKSAmJlxuICAgIHR5cGVvZiBwW1wic3RhcnRlZEF0XCJdID09PSBcInN0cmluZ1wiICYmIHBbXCJzdGFydGVkQXRcIl0ubGVuZ3RoID4gMDtcbn1cblxuLyoqIElzIGB2YWx1ZWAgYSBzdHJ1Y3R1cmFsbHkgdmFsaWQgYW5jaG9yIHJlY29yZD8gKi9cbmZ1bmN0aW9uIGlzQW5jaG9yKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgQ2hhaW5BbmNob3Ige1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiIHx8IHZhbHVlID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGEgPSB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgcmV0dXJuIHR5cGVvZiBhW1wiam91cm5hbFwiXSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIHR5cGVvZiBhW1wiY291bnRcIl0gPT09IFwibnVtYmVyXCIgJiZcbiAgICBOdW1iZXIuaXNJbnRlZ2VyKGFbXCJjb3VudFwiXSkgJiYgYVtcImNvdW50XCJdID49IDAgJiZcbiAgICB0eXBlb2YgYVtcImhlYWRIYXNoXCJdID09PSBcInN0cmluZ1wiICYmXG4gICAgdHlwZW9mIGFbXCJ1cGRhdGVkQXRcIl0gPT09IFwic3RyaW5nXCIgJiZcbiAgICBoYXNWYWxpZFBlbmRpbmcoYSk7XG59XG5cbi8qKlxuICogUmVhZCB0aGUgYW5jaG9yIGZvciBhIGpvdXJuYWwuXG4gKlxuICogQHBhcmFtIGpvdXJuYWxQYXRoIC0gUGF0aCB0byB0aGUgYC5qc29ubGAgam91cm5hbFxuICogQHJldHVybnMgVGhlIGFuY2hvciwgb3IgYG51bGxgIHdoZW4gbm8gYW5jaG9yIGZpbGUgZXhpc3RzXG4gKiBAdGhyb3dzIFdoZW4gdGhlIGFuY2hvciBleGlzdHMgYnV0IGlzIHVucmVhZGFibGUgb3IgbWFsZm9ybWVkIOKAlCBhXG4gKiAgIGNvcnJ1cHRlZCBhbmNob3IgaXMgYSB0YW1wZXIgc2lnbmFsLCBuZXZlciBhIHNpbGVudCBcIm5vIGFuY2hvclwiLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZEFuY2hvcihcbiAgam91cm5hbFBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8Q2hhaW5BbmNob3IgfCBudWxsPiB7XG4gIGNvbnN0IHBhdGggPSBhbmNob3JQYXRoKGpvdXJuYWxQYXRoKTtcbiAgbGV0IHJhdzogc3RyaW5nO1xuICB0cnkge1xuICAgIHJhdyA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHBhdGgpO1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSByZXR1cm4gbnVsbDtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgYXVkaXQgYW5jaG9yIHVucmVhZGFibGU6ICR7cGF0aH06ICR7XG4gICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBhdWRpdCBhbmNob3IgaXMgbWFsZm9ybWVkIEpTT046ICR7cGF0aH1gKTtcbiAgfVxuICBpZiAoIWlzQW5jaG9yKHBhcnNlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGF1ZGl0IGFuY2hvciBoYXMgYW4gdW5leHBlY3RlZCBzaGFwZTogJHtwYXRofWApO1xuICB9XG4gIHJldHVybiBwYXJzZWQ7XG59XG5cbi8qKlxuICogV3JpdGUgKG9yIHJlcGxhY2UpIHRoZSBhbmNob3IgZm9yIGEgam91cm5hbCwgYXRvbWljYWxseS5cbiAqXG4gKiBBIGBwZW5kaW5nYCByZWNvcmQgaXMgd3JpdHRlbiBvbmx5IHdoZW4gdGhlIGNhbGxlciBzdXBwbGllcyBvbmUsIHNvIHRoZVxuICogY29uZmlybWluZyB3cml0ZSBhZnRlciBhIHN1Y2Nlc3NmdWwgYXBwZW5kIGNsZWFycyBpdCAoSXNzdWUgIzEwNzQpLlxuICpcbiAqIEBwYXJhbSBqb3VybmFsUGF0aCAtIFBhdGggdG8gdGhlIGAuanNvbmxgIGpvdXJuYWxcbiAqIEBwYXJhbSBzdGF0ZSAtIFJlY29yZCBjb3VudCwgaGVhZCBoYXNoLCBhbmQgYW55IGluLWZsaWdodCBhcHBlbmRcbiAqIEBwYXJhbSBub3cgLSBJU08gdGltZXN0YW1wIG92ZXJyaWRlICh0ZXN0cylcbiAqIEByZXR1cm5zIFJlc3VsdCBjYXJyeWluZyB0aGUgcGVyc2lzdGVkIGFuY2hvclxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd3JpdGVBbmNob3IoXG4gIGpvdXJuYWxQYXRoOiBzdHJpbmcsXG4gIHN0YXRlOiB7IGNvdW50OiBudW1iZXI7IGhlYWRIYXNoOiBzdHJpbmc7IHBlbmRpbmc/OiBQZW5kaW5nQXBwZW5kIH0sXG4gIG5vdz86IHN0cmluZyxcbik6IFByb21pc2U8UmVzdWx0PENoYWluQW5jaG9yPj4ge1xuICBjb25zdCB7IGJhc2UgfSA9IHNwbGl0UGF0aChqb3VybmFsUGF0aCk7XG4gIGNvbnN0IHRhcmdldCA9IGFuY2hvclBhdGgoam91cm5hbFBhdGgpO1xuICBjb25zdCB7IGRpcjogYW5jaG9yRGlyIH0gPSBzcGxpdFBhdGgodGFyZ2V0KTtcbiAgY29uc3QgYW5jaG9yOiBDaGFpbkFuY2hvciA9IHtcbiAgICBqb3VybmFsOiBiYXNlLFxuICAgIGNvdW50OiBzdGF0ZS5jb3VudCxcbiAgICBoZWFkSGFzaDogc3RhdGUuaGVhZEhhc2gsXG4gICAgdXBkYXRlZEF0OiBub3cgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIC4uLihzdGF0ZS5wZW5kaW5nID8geyBwZW5kaW5nOiBzdGF0ZS5wZW5kaW5nIH0gOiB7fSksXG4gIH07XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihhbmNob3JEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgZmFpbGVkIHRvIGNyZWF0ZSBhdWRpdCBhbmNob3IgZGlyZWN0b3J5ICR7YW5jaG9yRGlyfTogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgY29uc3Qgd3JpdHRlbiA9IGF3YWl0IGF0b21pY1dyaXRlKHtcbiAgICB0YXJnZXRGaWxlOiB0YXJnZXQsXG4gICAgY29udGVudDogYCR7SlNPTi5zdHJpbmdpZnkoYW5jaG9yKX1cXG5gLFxuICB9KTtcbiAgaWYgKCF3cml0dGVuLm9rKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiB3cml0dGVuLmVycm9yIH07XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogYW5jaG9yIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRXhwZWN0ZWQtam91cm5hbCByb3N0ZXIgKElzc3VlICMzOTQ5KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBPbmUgcm9zdGVyIGxpbmU6IGEgam91cm5hbCB0aGlzIGF1ZGl0IGRpcmVjdG9yeSBpcyBleHBlY3RlZCB0byBob2xkLiAqL1xuaW50ZXJmYWNlIFJvc3RlckVudHJ5IHtcbiAgam91cm5hbDogc3RyaW5nO1xuICBhZGRlZEF0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogT25lIHJvc3RlciBsaW5lIGFja25vd2xlZGdpbmcgdGhhdCBhbiBleHBlY3RlZCBqb3VybmFsIGlzIGdlbnVpbmVseSBnb25lXG4gKiBhbmQgdGhlIGxvc3MgaGFzIGJlZW4gYWNjb3VudGVkIGZvciAoSXNzdWUgIzM1OSkuXG4gKlxuICogVGhlIHJvc3RlciBzdGF5cyBhcHBlbmQtb25seTogYWNrbm93bGVkZ2luZyBhIGxvc3MgKiphZGRzKiogYSBsaW5lLCBpdFxuICogbmV2ZXIgcmVtb3ZlcyB0aGUgYFJvc3RlckVudHJ5YCB0aGF0IHJlY29yZHMgdGhlIGpvdXJuYWwgZXhpc3RlZC4gVGhlXG4gKiByb3N0ZXIgdGhlcmVmb3JlIGtlZXBzIHNheWluZyBcInRoaXMgam91cm5hbCB3YXMgaGVyZVwiIGFuZCBhZGRpdGlvbmFsbHlcbiAqIHNheXMgXCJhbmQgaXRzIGFic2VuY2Ugd2FzIHNpZ25lZCBmb3IsIGJ5IHdob20sIHdoZW4sIGFuZCB3aHlcIi5cbiAqXG4gKiBUaGlzIGlzIG5vdCBhIGNsYWltIG9mIHVuZm9yZ2VhYmlsaXR5LiBBIHByaW5jaXBhbCB3aG8gY2FuIGFwcGVuZCB0byB0aGVcbiAqIHJvc3RlciBjYW4gYWxyZWFkeSBkZWxldGUgaXQgb3V0cmlnaHQg4oCUIHdoaWNoIHRyaXBzIHRoZSBjb21wbGV0ZS1lcmFzdXJlXG4gKiBhbGFybSAoSXNzdWUgIzI3MCkuIFdoYXQgdGhlIGFja25vd2xlZGdlbWVudCBidXlzIGlzIGFjY291bnRhYmlsaXR5OiB0aGVcbiAqIGxvc3Mgc3RvcHMgYmVpbmcgYW4gYW5vbnltb3VzIHJlY3VycmluZyBhbGFybSBhbmQgYmVjb21lcyBhIGRhdGVkLFxuICogYXR0cmlidXRlZCwgcmV2aWV3YWJsZSByZWNvcmQsIG1pcnJvcmVkIGludG8gdGhlIGhhc2ggY2hhaW4gaXRzZWxmIGJ5XG4gKiBgYWNrbm93bGVkZ2VKb3VybmFsTG9zc2AgaW4gYGF1ZGl0X2pvdXJuYWwudHNgLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFJvc3RlckFja25vd2xlZGdlbWVudCB7XG4gIC8qKiBCYXNlbmFtZSBvZiB0aGUgam91cm5hbCB3aG9zZSBsb3NzIGlzIGFja25vd2xlZGdlZC4gKi9cbiAgam91cm5hbDogc3RyaW5nO1xuICAvKiogSVNPIDg2MDEgdGltZXN0YW1wIHRoZSBhY2tub3dsZWRnZW1lbnQgd2FzIHJlY29yZGVkLiAqL1xuICBhY2tub3dsZWRnZWRBdDogc3RyaW5nO1xuICAvKiogV2h5IHRoZSBqb3VybmFsIGlzIGdvbmUg4oCUIGZyZWUgdGV4dCwgcmVxdWlyZWQsIG5ldmVyIGVtcHR5LiAqL1xuICByZWFzb246IHN0cmluZztcbiAgLyoqIFdobyBzaWduZWQgZm9yIHRoZSBsb3NzLiAqL1xuICBieTogc3RyaW5nO1xufVxuXG4vKipcbiAqIE9uZSByb3N0ZXIgbGluZSBzaWduaW5nIGZvciBhIGpvdXJuYWwgdGhhdCBpcyAqKnByZXNlbnQgYnV0IGRvZXMgbm90XG4gKiB2ZXJpZnkqKiAoSXNzdWUgIzQ5MSkuXG4gKlxuICogRGlzdGluY3QgZnJvbSB7QGxpbmsgUm9zdGVyQWNrbm93bGVkZ2VtZW50fSBvbiBwdXJwb3NlLCBhbmQgbmV2ZXJcbiAqIGludGVyY2hhbmdlYWJsZSB3aXRoIGl0OiBzaWduaW5nIHRoYXQgYSBqb3VybmFsIGlzICpnb25lKiBtdXN0IG5vdFxuICogc2lsZW5jZSBvbmUgdGhhdCBpcyAqY29ycnVwdCosIGFuZCB2aWNlIHZlcnNhLiBga2luZGAgaXMgdGhlXG4gKiBkaXNjcmltaW5hdG9yLCBhbmQgYSBsb3NzIGxpbmUgaXMgcmVmdXNlZCBpZiBpdCBjYXJyaWVzIGl0LlxuICpcbiAqIFRoZSBzaWduYXR1cmUgaXMgcGlubmVkIHRvIHRoZSBieXRlcyBpdCB3YXMgZ2l2ZW4uIGBkaWdlc3RgIGlzIHRoZVxuICogU0hBLTI1NiBvZiB0aGUgam91cm5hbCBhdCB0aGUgbW9tZW50IG9mIHNpZ25pbmcgYW5kIGBlbnRyaWVzYCBpdHMgbGluZVxuICogY291bnQ7IHRoZSBzd2VlcCBvbmx5IGhvbm91cnMgdGhlIGFja25vd2xlZGdlbWVudCB3aGlsZSB0aGUgZmlsZSBzdGlsbFxuICogaGFzaGVzIHRvIHRoYXQgdmFsdWUuIFdpdGhvdXQgdGhlIHBpbiwgc2lnbmluZyBmb3IgdG9kYXkncyBkYW1hZ2Ugd291bGRcbiAqIGFsc28gYmxlc3MgZXZlcnkgZnV0dXJlIGVkaXQgdG8gdGhlIHNhbWUgZmlsZSDigJQgd2hpY2ggaXMgbGF1bmRlcmluZywgYW5kXG4gKiBpcyBleGFjdGx5IHdoYXQgdGhlIGxvc3MgcGF0aCBhbHJlYWR5IHJlZnVzZXMgdG8gZG8uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUm9zdGVyRGFtYWdlQWNrbm93bGVkZ2VtZW50IGV4dGVuZHMgUm9zdGVyQWNrbm93bGVkZ2VtZW50IHtcbiAgLyoqIERpc2NyaW1pbmF0b3I6IHRoaXMgbGluZSBzaWducyBmb3IgZGFtYWdlLCBub3QgZm9yIGEgbG9zcy4gKi9cbiAga2luZDogXCJkYW1hZ2VcIjtcbiAgLyoqIExvd2VyY2FzZSBoZXggU0hBLTI1NiBvZiB0aGUgam91cm5hbCdzIGJ5dGVzIHdoZW4gaXQgd2FzIHNpZ25lZCBmb3IuICovXG4gIGRpZ2VzdDogc3RyaW5nO1xuICAvKiogTnVtYmVyIG9mIGVudHJpZXMgdGhlIGpvdXJuYWwgaGVsZCB3aGVuIGl0IHdhcyBzaWduZWQgZm9yLiAqL1xuICBlbnRyaWVzOiBudW1iZXI7XG59XG5cbi8qKiBFdmVyeXRoaW5nIG9uZSByb3N0ZXIgZmlsZSBob2xkcywgaW4gYSBzaW5nbGUgcmVhZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUm9zdGVyQ29udGVudHMge1xuICAvKiogSm91cm5hbCBiYXNlbmFtZXMgdGhlIGRpcmVjdG9yeSBpcyBleHBlY3RlZCB0byBob2xkLCBmaXJzdC1zZWVuIG9yZGVyLiAqL1xuICBqb3VybmFsczogc3RyaW5nW107XG4gIC8qKiBBY2tub3dsZWRnZWQgbG9zc2VzLCBrZXllZCBieSBqb3VybmFsIGJhc2VuYW1lIChsYXN0IGxpbmUgd2lucykuICovXG4gIGFja25vd2xlZGdlZDogTWFwPHN0cmluZywgUm9zdGVyQWNrbm93bGVkZ2VtZW50PjtcbiAgLyoqIEFja25vd2xlZGdlZCBkYW1hZ2UsIGtleWVkIGJ5IGpvdXJuYWwgYmFzZW5hbWUgKGxhc3QgbGluZSB3aW5zKS4gKi9cbiAgZGFtYWdlZDogTWFwPHN0cmluZywgUm9zdGVyRGFtYWdlQWNrbm93bGVkZ2VtZW50Pjtcbn1cblxuLyoqXG4gKiBSb3N0ZXIgZmlsZSBwYXRoIGZvciBhbiBhdWRpdCBkaXJlY3RvcnkuXG4gKlxuICogVGhlIGFuY2hvciBjbG9zZWQgdGhlIGxvbmUtZGVsZXRlIGhvbGUsIGJ1dCBhIGpvdXJuYWwgZGVsZXRlZCAqKnRvZ2V0aGVyXG4gKiB3aXRoKiogaXRzIGFuY2hvciBsZWZ0IG5vdGhpbmcgYmVoaW5kIHRvIGRpc2FncmVlIOKAlCBhbmQgYHJtIC1yZmAgb2YgdGhlXG4gKiBhdWRpdCBkaXJlY3RvcnkgcmVhZCBhcyBhIGNsZWFuLCBlbXB0eSBzd2VlcC4gVGhlIHJvc3RlciBpcyB0aGUgcGVyc2lzdGVkXG4gKiBleHBlY3RhdGlvbiBib3RoIGVyYXNlOiBhbiBhcHBlbmQtb25seSBKU09OTCBpbmRleCBvZiBldmVyeSBqb3VybmFsIG5hbWVcbiAqIGV2ZXIgYW5jaG9yZWQsIHN0b3JlZCBhcyBhICoqc2libGluZyBvZiB0aGUgYXVkaXQgZGlyZWN0b3J5KiogKG5vdCBpbnNpZGVcbiAqIGl0KSBwcmVjaXNlbHkgc28gcmVtb3ZpbmcgdGhlIGRpcmVjdG9yeSBjYW5ub3QgcmVtb3ZlIHRoZSBleHBlY3RhdGlvbi5cbiAqIERlbGV0aW5nIHRoZSByb3N0ZXIgdG9nZXRoZXIgd2l0aCB0aGUgZGlyZWN0b3J5IGlzIGNsb3NlZCBieSBhXG4gKiBsYXN0LWtub3duLW5vbi1lbXB0eSBtYXJrZXIgYmVzaWRlIHRoZSByb3N0ZXIgKElzc3VlICMyNzApLlxuICpcbiAqIEBwYXJhbSBiYXNlRGlyIC0gQXVkaXQgZGlyZWN0b3J5IHRoZSByb3N0ZXIgY292ZXJzXG4gKiBAcmV0dXJucyBQYXRoIG9mIHRoZSByb3N0ZXIgZmlsZSwgYmVzaWRlIChub3QgdW5kZXIpIGBiYXNlRGlyYFxuICovXG5leHBvcnQgZnVuY3Rpb24gcm9zdGVyUGF0aChiYXNlRGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gYmFzZURpci5lbmRzV2l0aChcIi9cIikgPyBiYXNlRGlyLnNsaWNlKDAsIC0xKSA6IGJhc2VEaXI7XG4gIHJldHVybiBgJHt0cmltbWVkfS5yb3N0ZXIuanNvbmxgO1xufVxuXG4vKipcbiAqIFBhdGggb2YgdGhlIGxhc3Qta25vd24tbm9uLWVtcHR5IHJvc3RlciBtYXJrZXIgKElzc3VlICMyNzApLlxuICpcbiAqIFNpYmxpbmcgb2YgdGhlIHJvc3RlciDigJQgbm90IHRoZSByb3N0ZXIgaXRzZWxmLCBhbmQgbm90IHVuZGVyIHRoZSBhdWRpdFxuICogZGlyZWN0b3J5IOKAlCBzbyBkZWxldGluZyBgJHtkaXJ9YCBhbmQgYCR7ZGlyfS5yb3N0ZXIuanNvbmxgIHRvZ2V0aGVyXG4gKiBjYW5ub3QgYWxzbyByZW1vdmUgdGhpcyB3aXRuZXNzIHVubGVzcyB0aGUgcHJpbmNpcGFsIGtub3dzIHRvIGxvb2sgZm9yXG4gKiBpdC5cbiAqXG4gKiBAcGFyYW0gYmFzZURpciAtIEF1ZGl0IGRpcmVjdG9yeSB0aGUgcm9zdGVyIGNvdmVyc1xuICogQHJldHVybnMgUGF0aCBvZiB0aGUgc2Vlbi1tYXJrZXIgZmlsZSwgYmVzaWRlIChub3QgdW5kZXIpIGBiYXNlRGlyYFxuICovXG5leHBvcnQgZnVuY3Rpb24gcm9zdGVyU2VlblBhdGgoYmFzZURpcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IGJhc2VEaXIuZW5kc1dpdGgoXCIvXCIpID8gYmFzZURpci5zbGljZSgwLCAtMSkgOiBiYXNlRGlyO1xuICByZXR1cm4gYCR7dHJpbW1lZH0ucm9zdGVyLnNlZW5gO1xufVxuXG4vKiogSXMgYHZhbHVlYCBhIHN0cnVjdHVyYWxseSB2YWxpZCByb3N0ZXIgZW50cnk/ICovXG5mdW5jdGlvbiBpc1Jvc3RlckVudHJ5KHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUm9zdGVyRW50cnkge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiIHx8IHZhbHVlID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGUgPSB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgcmV0dXJuIHR5cGVvZiBlW1wiam91cm5hbFwiXSA9PT0gXCJzdHJpbmdcIiAmJiBlW1wiam91cm5hbFwiXS5sZW5ndGggPiAwICYmXG4gICAgdHlwZW9mIGVbXCJhZGRlZEF0XCJdID09PSBcInN0cmluZ1wiO1xufVxuXG4vKiogVGhlIGZvdXIgZmllbGRzIGV2ZXJ5IGFja25vd2xlZGdlbWVudCBsaW5lIGNhcnJpZXMgKElzc3VlICMzNTkpLiAqL1xuZnVuY3Rpb24gaGFzQWNrbm93bGVkZ2VtZW50U2hhcGUodmFsdWU6IHVua25vd24pOiBib29sZWFuIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIiB8fCB2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBlID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiB0eXBlb2YgZVtcImpvdXJuYWxcIl0gPT09IFwic3RyaW5nXCIgJiYgZVtcImpvdXJuYWxcIl0ubGVuZ3RoID4gMCAmJlxuICAgIHR5cGVvZiBlW1wiYWNrbm93bGVkZ2VkQXRcIl0gPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgZVtcInJlYXNvblwiXSA9PT0gXCJzdHJpbmdcIiAmJiBlW1wicmVhc29uXCJdLnRyaW0oKS5sZW5ndGggPiAwICYmXG4gICAgdHlwZW9mIGVbXCJieVwiXSA9PT0gXCJzdHJpbmdcIiAmJiBlW1wiYnlcIl0udHJpbSgpLmxlbmd0aCA+IDA7XG59XG5cbi8qKlxuICogSXMgYHZhbHVlYCBhIHN0cnVjdHVyYWxseSB2YWxpZCAqbG9zcyogYWNrbm93bGVkZ2VtZW50IChJc3N1ZSAjMzU5KT9cbiAqXG4gKiBBIGxpbmUgY2FycnlpbmcgYGtpbmRgIGlzIHJlZnVzZWQgaGVyZTogYSBkYW1hZ2Ugc2lnbmF0dXJlIG11c3QgbmV2ZXIgYmVcbiAqIHJlYWQgYXMgYSBsb3NzIHNpZ25hdHVyZSwgd2hpY2ggd291bGQgc2lsZW5jZSBhIGdlbnVpbmVseSBkZWxldGVkXG4gKiBqb3VybmFsIChJc3N1ZSAjNDkxKS5cbiAqL1xuZnVuY3Rpb24gaXNSb3N0ZXJBY2tub3dsZWRnZW1lbnQoXG4gIHZhbHVlOiB1bmtub3duLFxuKTogdmFsdWUgaXMgUm9zdGVyQWNrbm93bGVkZ2VtZW50IHtcbiAgaWYgKCFoYXNBY2tub3dsZWRnZW1lbnRTaGFwZSh2YWx1ZSkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuICh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilbXCJraW5kXCJdID09PSB1bmRlZmluZWQ7XG59XG5cbi8qKiBJcyBgdmFsdWVgIGEgc3RydWN0dXJhbGx5IHZhbGlkICpkYW1hZ2UqIGFja25vd2xlZGdlbWVudCAoSXNzdWUgIzQ5MSk/ICovXG5mdW5jdGlvbiBpc1Jvc3RlckRhbWFnZUFja25vd2xlZGdlbWVudChcbiAgdmFsdWU6IHVua25vd24sXG4pOiB2YWx1ZSBpcyBSb3N0ZXJEYW1hZ2VBY2tub3dsZWRnZW1lbnQge1xuICBpZiAoIWhhc0Fja25vd2xlZGdlbWVudFNoYXBlKHZhbHVlKSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBlID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiBlW1wia2luZFwiXSA9PT0gXCJkYW1hZ2VcIiAmJlxuICAgIHR5cGVvZiBlW1wiZGlnZXN0XCJdID09PSBcInN0cmluZ1wiICYmIC9eWzAtOWEtZl17NjR9JC8udGVzdChlW1wiZGlnZXN0XCJdKSAmJlxuICAgIHR5cGVvZiBlW1wiZW50cmllc1wiXSA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNJbnRlZ2VyKGVbXCJlbnRyaWVzXCJdKSAmJlxuICAgIGVbXCJlbnRyaWVzXCJdID49IDA7XG59XG5cbi8qKlxuICogUmVhZCB0aGUgd2hvbGUgcm9zdGVyIGZvciBhbiBhdWRpdCBkaXJlY3Rvcnkg4oCUIGV4cGVjdGF0aW9ucyBhbmRcbiAqIGFja25vd2xlZGdlbWVudHMgaW4gb25lIHBhc3MuXG4gKlxuICogQHBhcmFtIGJhc2VEaXIgLSBBdWRpdCBkaXJlY3RvcnkgdGhlIHJvc3RlciBjb3ZlcnNcbiAqIEByZXR1cm5zIEpvdXJuYWwgYmFzZW5hbWVzIGluIGZpcnN0LXNlZW4gb3JkZXIsIHBsdXMgYWNrbm93bGVkZ2VkIGxvc3Nlc1xuICogICAoYm90aCBlbXB0eSB3aGVuIG5vIHJvc3RlciBmaWxlIGV4aXN0cylcbiAqIEB0aHJvd3MgV2hlbiB0aGUgcm9zdGVyIGV4aXN0cyBidXQgYSBsaW5lIGlzIHVucmVhZGFibGUgb3IgbWF0Y2hlc1xuICogICBuZWl0aGVyIGxpbmUgc2hhcGUg4oCUIGEgY29ycnVwdGVkIHJvc3RlciBpcyBhIHRhbXBlciBzaWduYWwsIG5ldmVyIGFcbiAqICAgc2lsZW50IFwibm8gZXhwZWN0YXRpb25zXCIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkUm9zdGVyQ29udGVudHMoXG4gIGJhc2VEaXI6IHN0cmluZyxcbik6IFByb21pc2U8Um9zdGVyQ29udGVudHM+IHtcbiAgY29uc3QgcGF0aCA9IHJvc3RlclBhdGgoYmFzZURpcik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkge1xuICAgICAgcmV0dXJuIHsgam91cm5hbHM6IFtdLCBhY2tub3dsZWRnZWQ6IG5ldyBNYXAoKSwgZGFtYWdlZDogbmV3IE1hcCgpIH07XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBhdWRpdCByb3N0ZXIgdW5yZWFkYWJsZTogJHtwYXRofTogJHtcbiAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG4gICAgICB9YCxcbiAgICApO1xuICB9XG4gIGNvbnN0IGpvdXJuYWxzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGFja25vd2xlZGdlZCA9IG5ldyBNYXA8c3RyaW5nLCBSb3N0ZXJBY2tub3dsZWRnZW1lbnQ+KCk7XG4gIGNvbnN0IGRhbWFnZWQgPSBuZXcgTWFwPHN0cmluZywgUm9zdGVyRGFtYWdlQWNrbm93bGVkZ2VtZW50PigpO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgcmF3LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUudHJpbSgpLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgYXVkaXQgcm9zdGVyIGhhcyBhIG1hbGZvcm1lZCBsaW5lOiAke3BhdGh9OiAke2xpbmV9YCk7XG4gICAgfVxuICAgIC8vIEFja25vd2xlZGdlbWVudHMgYXJlIGNoZWNrZWQgZmlyc3Q6IHRoZXkgY2FycnkgYGpvdXJuYWxgIHRvbywgYW5kIGFcbiAgICAvLyBoYWxmLWZvcm1lZCBhY2tub3dsZWRnZW1lbnQgbXVzdCBiZSByZWplY3RlZCByYXRoZXIgdGhhbiBzaWxlbnRseVxuICAgIC8vIHJlYWQgYXMgYW4gZXhwZWN0YXRpb24gbGluZSB0aGF0IGhhcHBlbnMgdG8gbGFjayBgYWRkZWRBdGAuXG4gICAgaWYgKGlzUm9zdGVyRGFtYWdlQWNrbm93bGVkZ2VtZW50KHBhcnNlZCkpIHtcbiAgICAgIGRhbWFnZWQuc2V0KHBhcnNlZC5qb3VybmFsLCBwYXJzZWQpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc1Jvc3RlckFja25vd2xlZGdlbWVudChwYXJzZWQpKSB7XG4gICAgICBhY2tub3dsZWRnZWQuc2V0KHBhcnNlZC5qb3VybmFsLCBwYXJzZWQpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghaXNSb3N0ZXJFbnRyeShwYXJzZWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBhdWRpdCByb3N0ZXIgZW50cnkgaGFzIGFuIHVuZXhwZWN0ZWQgc2hhcGU6ICR7cGF0aH06ICR7bGluZX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCFzZWVuLmhhcyhwYXJzZWQuam91cm5hbCkpIHtcbiAgICAgIHNlZW4uYWRkKHBhcnNlZC5qb3VybmFsKTtcbiAgICAgIGpvdXJuYWxzLnB1c2gocGFyc2VkLmpvdXJuYWwpO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyBqb3VybmFscywgYWNrbm93bGVkZ2VkLCBkYW1hZ2VkIH07XG59XG5cbi8qKlxuICogUmVhZCB0aGUgcm9zdGVyIGZvciBhbiBhdWRpdCBkaXJlY3RvcnkuXG4gKlxuICogQHBhcmFtIGJhc2VEaXIgLSBBdWRpdCBkaXJlY3RvcnkgdGhlIHJvc3RlciBjb3ZlcnNcbiAqIEByZXR1cm5zIERlZHVwbGljYXRlZCBqb3VybmFsIGJhc2VuYW1lcywgaW4gZmlyc3Qtc2VlbiBvcmRlciAoZW1wdHkgd2hlblxuICogICBubyByb3N0ZXIgZmlsZSBleGlzdHMpXG4gKiBAdGhyb3dzIFdoZW4gdGhlIHJvc3RlciBleGlzdHMgYnV0IGEgbGluZSBpcyB1bnJlYWRhYmxlIG9yIG1hbGZvcm1lZCDigJQgYVxuICogICBjb3JydXB0ZWQgcm9zdGVyIGlzIGEgdGFtcGVyIHNpZ25hbCwgbmV2ZXIgYSBzaWxlbnQgXCJubyBleHBlY3RhdGlvbnNcIi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRSb3N0ZXIoYmFzZURpcjogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICByZXR1cm4gKGF3YWl0IHJlYWRSb3N0ZXJDb250ZW50cyhiYXNlRGlyKSkuam91cm5hbHM7XG59XG5cbi8qKlxuICogUmVjb3JkIHRoYXQgYW4gZXhwZWN0ZWQgam91cm5hbCBpcyBnZW51aW5lbHkgZ29uZSBhbmQgdGhlIGxvc3MgaGFzIGJlZW5cbiAqIGFjY291bnRlZCBmb3IgKElzc3VlICMzNTkpLlxuICpcbiAqIEFwcGVuZC1vbmx5LCBsaWtlIGV2ZXJ5IG90aGVyIHJvc3RlciB3cml0ZTogdGhlIGpvdXJuYWwncyBgUm9zdGVyRW50cnlgXG4gKiBzdGF5cyBleGFjdGx5IHdoZXJlIGl0IGlzLCBhbmQgdGhpcyBhZGRzIGEgZGF0ZWQsIGF0dHJpYnV0ZWQgbGluZSBiZXNpZGVcbiAqIGl0LiBSZS1hY2tub3dsZWRnaW5nIGEgam91cm5hbCBhcHBlbmRzIGEgZnJlc2ggbGluZTsgdGhlIG5ld2VzdCB3aW5zLlxuICpcbiAqIFRoZSBjYWxsZXIgaXMgcmVzcG9uc2libGUgZm9yIHRoZSBjaGVja3MgdGhhdCBtYWtlIGFuIGFja25vd2xlZGdlbWVudFxuICogbGVnaXRpbWF0ZSDigJQgdGhhdCB0aGUgam91cm5hbCBpcyBvbiB0aGUgcm9zdGVyLCB0aGF0IGl0IHJlYWxseSBpcyBhYnNlbnQsXG4gKiBhbmQgdGhhdCB0aGUgYWN0IGhhcyBiZWVuIG1pcnJvcmVkIGludG8gdGhlIGhhc2ggY2hhaW4uIFNlZVxuICogYGFja25vd2xlZGdlSm91cm5hbExvc3NgIGluIGBhdWRpdF9qb3VybmFsLnRzYCwgd2hpY2ggaXMgdGhlIG9ubHlcbiAqIHN1cHBvcnRlZCB3YXkgaW4uXG4gKlxuICogQHBhcmFtIGJhc2VEaXIgLSBBdWRpdCBkaXJlY3RvcnkgdGhlIHJvc3RlciBjb3ZlcnNcbiAqIEBwYXJhbSBqb3VybmFsTmFtZSAtIEJhc2VuYW1lIG9mIHRoZSBsb3N0IGpvdXJuYWxcbiAqIEBwYXJhbSByZWFzb24gLSBXaHkgaXQgaXMgZ29uZTsgbXVzdCBub3QgYmUgYmxhbmtcbiAqIEBwYXJhbSBieSAtIFdobyBpcyBzaWduaW5nIGZvciB0aGUgbG9zczsgbXVzdCBub3QgYmUgYmxhbmtcbiAqIEBwYXJhbSBub3cgLSBJU08gdGltZXN0YW1wIG92ZXJyaWRlICh0ZXN0cylcbiAqIEByZXR1cm5zIFJlc3VsdCBjYXJyeWluZyB0aGUgYXBwZW5kZWQgYWNrbm93bGVkZ2VtZW50XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhY2tub3dsZWRnZVJvc3Rlckxvc3MoXG4gIGJhc2VEaXI6IHN0cmluZyxcbiAgam91cm5hbE5hbWU6IHN0cmluZyxcbiAgcmVhc29uOiBzdHJpbmcsXG4gIGJ5OiBzdHJpbmcsXG4gIG5vdz86IHN0cmluZyxcbik6IFByb21pc2U8UmVzdWx0PFJvc3RlckFja25vd2xlZGdlbWVudD4+IHtcbiAgaWYgKHJlYXNvbi50cmltKCkubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBhY2tub3dsZWRnZSAke2pvdXJuYWxOYW1lfTogYSByZWFzb24gaXMgcmVxdWlyZWRgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGlmIChieS50cmltKCkubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBhY2tub3dsZWRnZSAke2pvdXJuYWxOYW1lfTogYW4gb3BlcmF0b3IgaWRlbnRpdHkgaXMgYCArXG4gICAgICAgICAgYHJlcXVpcmVkYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBjb25zdCBhY2tub3dsZWRnZW1lbnQ6IFJvc3RlckFja25vd2xlZGdlbWVudCA9IHtcbiAgICBqb3VybmFsOiBqb3VybmFsTmFtZSxcbiAgICBhY2tub3dsZWRnZWRBdDogbm93ID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICByZWFzb246IHJlYXNvbi50cmltKCksXG4gICAgYnk6IGJ5LnRyaW0oKSxcbiAgfTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICByb3N0ZXJQYXRoKGJhc2VEaXIpLFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoYWNrbm93bGVkZ2VtZW50KX1cXG5gLFxuICAgICAgeyBhcHBlbmQ6IHRydWUgfSxcbiAgICApO1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgYXVkaXQgcm9zdGVyIGFja25vd2xlZGdlbWVudCBjb3VsZCBub3QgYmUgYXBwZW5kZWQ6ICR7XG4gICAgICAgICAgcm9zdGVyUGF0aChiYXNlRGlyKVxuICAgICAgICB9OiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogYWNrbm93bGVkZ2VtZW50IH07XG59XG5cbi8qKlxuICogU2lnbiBmb3IgYSBqb3VybmFsIHRoYXQgaXMgcHJlc2VudCBidXQgZG9lcyBub3QgdmVyaWZ5IChJc3N1ZSAjNDkxKS5cbiAqXG4gKiBBcHBlbmQtb25seSBsaWtlIGV2ZXJ5IG90aGVyIHJvc3RlciB3cml0ZSwgYW5kIHBpbm5lZCB0byB0aGUgYnl0ZXMgaXRcbiAqIHdhcyBzaG93bjogdGhlIHN3ZWVwIGhvbm91cnMgdGhlIHNpZ25hdHVyZSBvbmx5IHdoaWxlIHRoZSBqb3VybmFsIHN0aWxsXG4gKiBoYXNoZXMgdG8gYGRpZ2VzdGAsIHNvIHRoaXMgY2xvc2VzIHRvZGF5J3MgYWxhcm0gd2l0aG91dCBibGVzc2luZ1xuICogdG9tb3Jyb3cncyBlZGl0LiBUaGUgam91cm5hbCBmaWxlIGl0c2VsZiBpcyBuZXZlciB0b3VjaGVkLlxuICpcbiAqIFRoZSBjYWxsZXIgaXMgcmVzcG9uc2libGUgZm9yIHRoZSBjaGVja3MgdGhhdCBtYWtlIHRoZSBzaWduYXR1cmVcbiAqIGxlZ2l0aW1hdGUg4oCUIHRoYXQgdGhlIGpvdXJuYWwgcmVhbGx5IGlzIG9uIGRpc2ssIHJlYWxseSBkb2VzIGZhaWwsIGFuZFxuICogdGhhdCB0aGUgYWN0IGhhcyBiZWVuIG1pcnJvcmVkIGludG8gYSBoZWFsdGh5IGhhc2ggY2hhaW4uIFNlZVxuICogYGFja25vd2xlZGdlSm91cm5hbERhbWFnZWAgaW4gYGF1ZGl0X2pvdXJuYWwudHNgLCB3aGljaCBpcyB0aGUgb25seVxuICogc3VwcG9ydGVkIHdheSBpbi5cbiAqXG4gKiBAcGFyYW0gYmFzZURpciAtIEF1ZGl0IGRpcmVjdG9yeSB0aGUgcm9zdGVyIGNvdmVyc1xuICogQHBhcmFtIGpvdXJuYWxOYW1lIC0gQmFzZW5hbWUgb2YgdGhlIGRhbWFnZWQgam91cm5hbFxuICogQHBhcmFtIHJlYXNvbiAtIFdoeSB0aGUgZGFtYWdlIGlzIGFjY291bnRlZCBmb3I7IG11c3Qgbm90IGJlIGJsYW5rXG4gKiBAcGFyYW0gYnkgLSBXaG8gaXMgc2lnbmluZzsgbXVzdCBub3QgYmUgYmxhbmtcbiAqIEBwYXJhbSBkaWdlc3QgLSBTSEEtMjU2IG9mIHRoZSBqb3VybmFsJ3MgYnl0ZXMsIGFzIHNpZ25lZCBmb3JcbiAqIEBwYXJhbSBlbnRyaWVzIC0gTGluZSBjb3VudCBvZiB0aGUgam91cm5hbCwgYXMgc2lnbmVkIGZvclxuICogQHBhcmFtIG5vdyAtIElTTyB0aW1lc3RhbXAgb3ZlcnJpZGUgKHRlc3RzKVxuICogQHJldHVybnMgUmVzdWx0IGNhcnJ5aW5nIHRoZSBhcHBlbmRlZCBhY2tub3dsZWRnZW1lbnRcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFja25vd2xlZGdlUm9zdGVyRGFtYWdlKFxuICBiYXNlRGlyOiBzdHJpbmcsXG4gIGpvdXJuYWxOYW1lOiBzdHJpbmcsXG4gIHJlYXNvbjogc3RyaW5nLFxuICBieTogc3RyaW5nLFxuICBkaWdlc3Q6IHN0cmluZyxcbiAgZW50cmllczogbnVtYmVyLFxuICBub3c/OiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxSb3N0ZXJEYW1hZ2VBY2tub3dsZWRnZW1lbnQ+PiB7XG4gIGlmIChyZWFzb24udHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gYWNrbm93bGVkZ2UgZGFtYWdlIHRvICR7am91cm5hbE5hbWV9OiBhIHJlYXNvbiBpcyBgICtcbiAgICAgICAgICBgcmVxdWlyZWRgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGlmIChieS50cmltKCkubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBhY2tub3dsZWRnZSBkYW1hZ2UgdG8gJHtqb3VybmFsTmFtZX06IGFuIG9wZXJhdG9yIGAgK1xuICAgICAgICAgIGBpZGVudGl0eSBpcyByZXF1aXJlZGAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgY29uc3QgYWNrbm93bGVkZ2VtZW50OiBSb3N0ZXJEYW1hZ2VBY2tub3dsZWRnZW1lbnQgPSB7XG4gICAga2luZDogXCJkYW1hZ2VcIixcbiAgICBqb3VybmFsOiBqb3VybmFsTmFtZSxcbiAgICBhY2tub3dsZWRnZWRBdDogbm93ID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICByZWFzb246IHJlYXNvbi50cmltKCksXG4gICAgYnk6IGJ5LnRyaW0oKSxcbiAgICBkaWdlc3QsXG4gICAgZW50cmllcyxcbiAgfTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICByb3N0ZXJQYXRoKGJhc2VEaXIpLFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoYWNrbm93bGVkZ2VtZW50KX1cXG5gLFxuICAgICAgeyBhcHBlbmQ6IHRydWUgfSxcbiAgICApO1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgYXVkaXQgcm9zdGVyIGRhbWFnZSBhY2tub3dsZWRnZW1lbnQgY291bGQgbm90IGJlIGFwcGVuZGVkOiAke1xuICAgICAgICAgIHJvc3RlclBhdGgoYmFzZURpcilcbiAgICAgICAgfTogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGFja25vd2xlZGdlbWVudCB9O1xufVxuXG4vKipcbiAqIFJlY29yZCBhIGpvdXJuYWwgaW4gdGhlIHJvc3RlciAoaWRlbXBvdGVudCwgYXBwZW5kLW9ubHkpLlxuICpcbiAqIEBwYXJhbSBiYXNlRGlyIC0gQXVkaXQgZGlyZWN0b3J5IHRoZSByb3N0ZXIgY292ZXJzXG4gKiBAcGFyYW0gam91cm5hbE5hbWUgLSBCYXNlbmFtZSBvZiB0aGUgam91cm5hbCB0byBleHBlY3QgZnJvbSBub3cgb25cbiAqIEBwYXJhbSBub3cgLSBJU08gdGltZXN0YW1wIG92ZXJyaWRlICh0ZXN0cylcbiAqIEByZXR1cm5zIFJlc3VsdDsgb2sgd2hlbiB0aGUgam91cm5hbCBpcyBvbiB0aGUgcm9zdGVyIChhbHJlYWR5IG9yIG5ld2x5KVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYWRkVG9Sb3N0ZXIoXG4gIGJhc2VEaXI6IHN0cmluZyxcbiAgam91cm5hbE5hbWU6IHN0cmluZyxcbiAgbm93Pzogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHJlYWRSb3N0ZXIoYmFzZURpcik7XG4gICAgaWYgKCFleGlzdGluZy5pbmNsdWRlcyhqb3VybmFsTmFtZSkpIHtcbiAgICAgIGNvbnN0IGVudHJ5OiBSb3N0ZXJFbnRyeSA9IHtcbiAgICAgICAgam91cm5hbDogam91cm5hbE5hbWUsXG4gICAgICAgIGFkZGVkQXQ6IG5vdyA/PyBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9O1xuICAgICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgICByb3N0ZXJQYXRoKGJhc2VEaXIpLFxuICAgICAgICBgJHtKU09OLnN0cmluZ2lmeShlbnRyeSl9XFxuYCxcbiAgICAgICAgeyBhcHBlbmQ6IHRydWUgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIElzc3VlICMyNzA6IHBlcnNpc3QgYSB0aGlyZCB3aXRuZXNzIHRoZSBmaXJzdCB0aW1lIHRoZSByb3N0ZXIgaXNcbiAgICAvLyBrbm93biB0byBiZSBub24tZW1wdHksIGluY2x1ZGluZyB0aGUgaWRlbXBvdGVudCBhbHJlYWR5LXByZXNlbnRcbiAgICAvLyBwYXRoIHNvIGFuIHVwZ3JhZGUgd3JpdGVzIHRoZSBtYXJrZXIgb24gdGhlIG5leHQgYXBwZW5kLlxuICAgIGNvbnN0IG1hcmtlZCA9IGF3YWl0IG1hcmtSb3N0ZXJTZWVuKGJhc2VEaXIsIG5vdyk7XG4gICAgaWYgKCFtYXJrZWQub2spIHJldHVybiBtYXJrZWQ7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogUGVyc2lzdCB0aGUgbGFzdC1rbm93bi1ub24tZW1wdHkgcm9zdGVyIG1hcmtlciAoaWRlbXBvdGVudCkuXG4gKlxuICogQHBhcmFtIGJhc2VEaXIgLSBBdWRpdCBkaXJlY3RvcnkgdGhlIHJvc3RlciBjb3ZlcnNcbiAqIEBwYXJhbSBub3cgLSBJU08gdGltZXN0YW1wIG92ZXJyaWRlICh0ZXN0cylcbiAqIEByZXR1cm5zIFJlc3VsdDsgb2sgd2hlbiB0aGUgbWFya2VyIGlzIG9uIGRpc2sgKGFscmVhZHkgb3IgbmV3bHkpXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXJrUm9zdGVyU2VlbihcbiAgYmFzZURpcjogc3RyaW5nLFxuICBub3c/OiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICBjb25zdCBwYXRoID0gcm9zdGVyU2VlblBhdGgoYmFzZURpcik7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChwYXRoKTtcbiAgICBpZiAoc3RhdC5pc0ZpbGUpIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoYGF1ZGl0IHJvc3Rlci1zZWVuIG1hcmtlciBpcyBub3QgYSBmaWxlOiAke3BhdGh9YCksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBpZiAoIShlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgIGBhdWRpdCByb3N0ZXItc2VlbiBtYXJrZXIgdW5yZWFkYWJsZTogJHtwYXRofTogJHtcbiAgICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgICAgIH1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gIH1cbiAgY29uc3QgbWFya2VyID0ge1xuICAgIG5vbkVtcHR5OiB0cnVlLFxuICAgIHVwZGF0ZWRBdDogbm93ID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfTtcbiAgLy8gVGhlIHRlbXAgZmlsZSBsaXZlcyBpbnNpZGUgdGhlIGpvdXJuYWwgZGlyZWN0b3J5LCBub3QgYmVzaWRlIHRoZVxuICAvLyBtYXJrZXIgKElzc3VlICMxNjA0KTogdGhlIGFnZW50LXNpZGUgZ2ggZ3VhcmQgam91cm5hbHMgYSByZWZ1c2FsIGZyb20gYVxuICAvLyBjaGlsZCB3aG9zZSB3cml0ZSBncmFudCBpcyB0aGUgam91cm5hbCBkaXJlY3RvcnkgcGx1cyB0aGlzIG9uZSBmaWxlLCBzb1xuICAvLyBhIHNpYmxpbmcgdGVtcCBwYXRoIHdvdWxkIGJlIHJlZnVzZWQg4oCUIGFuZCB0aGUgbWFya2VyIG5ldmVyIHdyaXR0ZW4uXG4gIGNvbnN0IHdyaXR0ZW4gPSBhd2FpdCBhdG9taWNXcml0ZSh7XG4gICAgdGFyZ2V0RmlsZTogcGF0aCxcbiAgICBjb250ZW50OiBgJHtKU09OLnN0cmluZ2lmeShtYXJrZXIpfVxcbmAsXG4gICAgdGVtcERpcjogYmFzZURpcixcbiAgfSk7XG4gIGlmICghd3JpdHRlbi5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogd3JpdHRlbi5lcnJvciB9O1xuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xufVxuXG4vKipcbiAqIEhhcyB0aGlzIGF1ZGl0IGRpcmVjdG9yeSBldmVyIGJlZW4gb2JzZXJ2ZWQgd2l0aCBhIG5vbi1lbXB0eSByb3N0ZXI/XG4gKlxuICogQHBhcmFtIGJhc2VEaXIgLSBBdWRpdCBkaXJlY3RvcnkgdGhlIHJvc3RlciBjb3ZlcnNcbiAqIEByZXR1cm5zIFRydWUgd2hlbiB0aGUgc2Vlbi1tYXJrZXIgZmlsZSBleGlzdHNcbiAqIEB0aHJvd3MgV2hlbiB0aGUgbWFya2VyIHBhdGggZXhpc3RzIGJ1dCBpcyB1bnJlYWRhYmxlIG9yIG5vdCBhIGZpbGUg4oCUXG4gKiAgIGEgY29ycnVwdGVkIHdpdG5lc3MgaXMgYSB0YW1wZXIgc2lnbmFsLCBuZXZlciBhIHNpbGVudCBcIm5ldmVyIHNlZW5cIi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJvc3Rlcldhc1NlZW4oYmFzZURpcjogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHBhdGggPSByb3N0ZXJTZWVuUGF0aChiYXNlRGlyKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KHBhdGgpO1xuICAgIGlmICghc3RhdC5pc0ZpbGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgYXVkaXQgcm9zdGVyLXNlZW4gbWFya2VyIGlzIG5vdCBhIGZpbGU6ICR7cGF0aH1gKTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQpIHJldHVybiBmYWxzZTtcbiAgICB0aHJvdyBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoXG4gICAgICBgYXVkaXQgcm9zdGVyLXNlZW4gbWFya2VyIHVucmVhZGFibGU6ICR7cGF0aH06ICR7U3RyaW5nKGVycm9yKX1gLFxuICAgICk7XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBa0JDLEdBR0QsU0FBUyxXQUFXLFFBQVEsa0JBQWtCO0FBc0M5Qyx5RUFBeUUsR0FDekUsTUFBTSxhQUFhO0FBRW5CLDZEQUE2RCxHQUM3RCxTQUFTLFVBQVUsSUFBWTtFQUM3QixNQUFNLE1BQU0sS0FBSyxXQUFXLENBQUM7RUFDN0IsSUFBSSxNQUFNLEdBQUcsT0FBTztJQUFFLEtBQUs7SUFBSyxNQUFNO0VBQUs7RUFDM0MsT0FBTztJQUFFLEtBQUssS0FBSyxLQUFLLENBQUMsR0FBRyxRQUFRO0lBQUssTUFBTSxLQUFLLEtBQUssQ0FBQyxNQUFNO0VBQUc7QUFDckU7QUFFQTs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FBUyxXQUFXLFdBQW1CO0VBQzVDLE1BQU0sRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLEdBQUcsVUFBVTtFQUNoQyxPQUFPLEdBQUcsSUFBSSxD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
// denoCacheMetadata=5845813730402808384,8226030956764147058