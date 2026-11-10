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
 * | On disk after the crash                              | Settled as |
 * | ---------------------------------------------------- | ---------- |
 * | pending, one more line that **is** the declared entry | completed  |
 * | pending, one more line torn or not the declared entry | discarded  |
 * | no pending, one more line                             | **broken** |
 * | anything at or before the anchored head altered       | **broken** |
 * | more than one line past the anchor                    | **broken** |
 *
 * A declaration whose entry never reached the file needs no settling at
 * all: the journal already matches its anchor, and the next append
 * overwrites the whole anchor record — declaration included — before it
 * writes anything. Rewriting the anchor of a journal that is *not* about
 * to be appended to would only touch evidence for nothing.
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
 */ import { readAnchor, writeAnchor } from "./audit_anchor.ts";
import { computeEntryHash } from "./audit_entry.ts";
import { freeSidecarPath, quoteDropped } from "./torn_bytes.ts";
/** Read a journal's bytes with line offsets, or null when it is absent. */ async function readJournalBytes(path) {
  let raw;
  try {
    raw = await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  const text = new TextDecoder().decode(raw);
  const encoder = new TextEncoder();
  const lines = [];
  const lineEnds = [];
  let offset = 0;
  for (const segment of text.split("\n")){
    // Every segment but the last was newline-terminated; measuring the
    // encoded length keeps the offsets right for multi-byte content.
    offset += encoder.encode(segment).length + 1;
    if (segment.trim().length === 0) continue;
    lines.push(segment);
    lineEnds.push(offset);
  }
  return {
    raw,
    lines,
    lineEnds,
    endsWithNewline: text.endsWith("\n")
  };
}
/** Byte offset just past the last anchored entry. */ function anchoredLength(journal, count) {
  if (count === 0) return 0;
  return journal.lineEnds[count - 1] ?? journal.raw.length;
}
/**
 * Move the bytes past the anchored head into a sidecar and truncate.
 *
 * Preserve first, truncate second: a failure to write the sidecar leaves
 * the journal exactly as it was, still failing the sweep, which is the
 * safe direction. Nothing is ever deleted.
 */ async function discardTornTail(path, journal, anchor) {
  const keep = anchoredLength(journal, anchor.count);
  const dropped = journal.raw.slice(keep);
  const sidecar = await freeSidecarPath(path);
  await Deno.writeFile(sidecar, dropped, {
    createNew: true
  });
  await Deno.truncate(path, keep);
  await clearPending(path, anchor);
  return {
    path,
    kind: "discarded",
    count: anchor.count,
    droppedBytes: dropped.length,
    preservedAs: sidecar,
    droppedText: quoteDropped(dropped)
  };
}
/** Rewrite the anchor at its current position, dropping the intent record. */ async function clearPending(path, anchor) {
  const written = await writeAnchor(path, {
    count: anchor.count,
    headHash: anchor.headHash
  });
  if (!written.ok) throw written.error;
}
/**
 * Does `line` parse as a whole journal entry?
 *
 * The question separates damage from forgery. A kill can leave bytes that
 * do not parse; it cannot leave a *complete* entry the writer never set
 * out to append. So a parseable tail is never discarded as torn, whether
 * or not the anchor declares an append (Issue #1074, Issue #3949).
 *
 * @param line - The trailing line, without its terminator
 * @returns true when the line is complete, parseable JSON
 */ function parsesAsEntry(line) {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null;
  } catch  {
    return false;
  }
}
/** Is `line` exactly the entry the anchor declared as in flight? */ async function isDeclaredEntry(line, anchor) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch  {
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
/**
 * Settle an append that was interrupted, if one was.
 *
 * Callers must hold the audit-directory lock: this reads the journal and
 * its anchor and may rewrite both, so a concurrent append would see a
 * half-settled state. Callers should also have found the journal broken
 * first — a journal that verifies has nothing here to settle.
 *
 * @param path - Journal file path
 * @returns Result carrying the recovery performed, or `null` when there
 *   was nothing to settle — including every shape that must stay broken
 */ export async function settleInterruptedAppend(path) {
  try {
    const anchor = await readAnchor(path);
    // No anchor is the pre-#3712 `--adopt` case, not an interrupted
    // append: there is no recorded position to recover to.
    if (!anchor) return {
      ok: true,
      value: null
    };
    const journal = await readJournalBytes(path);
    // A journal that is absent, or already the length its anchor records,
    // has nothing past the anchored head to settle. A stale declaration
    // may be sitting in the anchor, and is left there: it costs nothing
    // (verification ignores it, and the next append overwrites the whole
    // record), and rewriting the anchor of a file this call has not
    // repaired would be touching evidence for nothing.
    if (journal === null) return {
      ok: true,
      value: null
    };
    const extra = journal.lines.length - anchor.count;
    if (extra === 0) return {
      ok: true,
      value: null
    };
    // More than one line past the anchor is never an interrupted append:
    // the writer declares one entry at a time. Two torn lines, or a torn
    // line followed by a valid one, land here and stay broken.
    if (extra !== 1) return {
      ok: true,
      value: null
    };
    const tail = journal.lines[anchor.count] ?? "";
    if (anchor.pending) {
      const declared = await isDeclaredEntry(tail, anchor);
      if (declared && journal.endsWithNewline) {
        // The line landed whole; only the confirming anchor write was
        // lost. Finish the append rather than throwing the entry away.
        const written = await writeAnchor(path, {
          count: anchor.count + 1,
          headHash: declared.hash
        });
        if (!written.ok) return {
          ok: false,
          error: written.error
        };
        return {
          ok: true,
          value: {
            path,
            kind: "completed",
            count: anchor.count + 1,
            droppedBytes: 0
          }
        };
      }
      // The tail is not the declared entry. A crash cannot produce that:
      // the writer only ever appends the one entry it declared, so the
      // shapes a kill can leave are nothing at all, that entry whole, or
      // that entry torn. A *complete, parseable* line that is something
      // else is therefore not damage — it is the forged-tail shape Issue
      // #3949 keeps red, and a stale declaration must not become the way
      // to launder it. Only genuinely torn bytes are discarded.
      if (journal.endsWithNewline && parsesAsEntry(tail)) {
        return {
          ok: true,
          value: null
        };
      }
      return {
        ok: true,
        value: await discardTornTail(path, journal, anchor)
      };
    }
    // No intent record — a journal written before Issue #1074, or one
    // whose anchor never recorded the attempt. A *parseable* trailing
    // entry is the forged-tail shape Issue #3949 keeps red, and stays
    // red. Unterminated, unparseable trailing bytes are a partial write:
    // they can carry no forgery, because a forgery has to parse and chain
    // to be worth anything, and they sit past the anchored head, so
    // discarding them removes nothing the chain ever confirmed.
    if (journal.endsWithNewline || parsesAsEntry(tail)) {
      return {
        ok: true,
        value: null
      };
    }
    return {
      ok: true,
      value: await discardTornTail(path, journal, anchor)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
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
 */ export function formatAppendRecovery(recovery) {
  const head = `[SECURITY] [AUDIT_APPEND_RECOVERED] ${recovery.path}: ` + `interrupted append ${recovery.kind}`;
  if (recovery.kind === "completed") {
    return `${head} — the entry had reached the journal, so the anchor was ` + `advanced to ${recovery.count} entries; nothing was dropped`;
  }
  return `${head} — ${recovery.droppedBytes} torn byte(s) past the anchored ` + `head were moved to ${recovery.preservedAs} and the journal truncated ` + `to its anchored ${recovery.count} entries; dropped: ${JSON.stringify(recovery.droppedText ?? "")}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hdWRpdF9hcHBlbmRfcmVjb3ZlcnkudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDcmFzaCByZWNvdmVyeSBmb3IgYW4gaW50ZXJydXB0ZWQgYXVkaXQtam91cm5hbCBhcHBlbmQgKElzc3VlICMxMDc0KS5cbiAqXG4gKiAjIyBXaGF0IGFjdHVhbGx5IGJyZWFrcyB0aGUgY2hhaW5cbiAqXG4gKiBBIGpvdXJuYWwgbGluZSBhbmQgaXRzIGFuY2hvciBhcmUgdHdvIGZpbGVzLiBgYXBwZW5kRW50cnlgIHdyaXRlcyB0aGVcbiAqIGxpbmUsIHRoZW4gdGhlIGFuY2hvciwgYW5kIG5vdGhpbmcgbWFrZXMgdGhhdCBwYWlyIGF0b21pYyDigJQgc28gYSBwcm9jZXNzXG4gKiB0aGF0IGRpZXMgYmV0d2VlbiB0aGVtIGxlYXZlcyBhIGpvdXJuYWwgb25lIGVudHJ5IGxvbmdlciB0aGFuIGl0c1xuICogYW5jaG9yLiBNZWFzdXJlZCBvbiBhIGNvbnRhaW5lciBob3N0OiBTSUdLSUxMaW5nIGEgd3JpdGVyIG1pZC1ydW4gbGVhdmVzXG4gKiB0aGF0IHNoYXBlIGFib3V0IGEgZmlmdGggb2YgdGhlIHRpbWUsIGFuZCBuZXZlciBsZWF2ZXMgYSBwYXJ0aWFsIGxpbmUsXG4gKiBiZWNhdXNlIGEgc2luZ2xlIGB3cml0ZSgyKWAgb2Ygb25lIHNtYWxsIGxpbmUgdG8gYSByZWd1bGFyIGZpbGUgaXMgbm90XG4gKiBpbnRlcnJ1cHRpYmxlLiBBICoqdG9ybioqIGxpbmUgY29tZXMgZnJvbSBhIGxldmVsIGJlbG93IHRoZSBwcm9jZXNzIOKAlCBhblxuICogdW5mbHVzaGVkIHBhZ2UgY2FjaGUgbG9zdCB3aXRoIHRoZSBtYWNoaW5lLCBvciBhIHNob3J0IHdyaXRlIGZyb20gYSBmdWxsXG4gKiBvciBmYWlsaW5nIHZvbHVtZSDigJQgYW5kIGl0cyBieXRlcyBhbHdheXMgbGFuZCBwYXN0IHRoZSBhbmNob3JlZCBoZWFkIGZvclxuICogdGhlIHNhbWUgcmVhc29uOiB0aGUgYW5jaG9yIGlzIG9ubHkgYWR2YW5jZWQgYWZ0ZXIgdGhlIGFwcGVuZCByZXR1cm5zLlxuICpcbiAqIEJvdGggc2hhcGVzIHByZXZpb3VzbHkgZGVtYW5kZWQgYSBodW1hbiBzaWduYXR1cmVcbiAqIChgYXVkaXQtY2hhaW4tdmVyaWZ5IC0tYWNrbm93bGVkZ2UtZGFtYWdlYCkgZXZlbiB0aG91Z2ggbm90aGluZyB2ZXJpZmllZFxuICogaGFkIGJlZW4gbG9zdCwgYW5kIGEgY29udHJvbCB0aGF0IHJvdXRpbmVseSBhc2tzIGEgaHVtYW4gdG8gd2F2ZSBkYW1hZ2VcbiAqIHRocm91Z2ggaXMgb25lIHRoYXQgZ2V0cyB3YXZlZCB0aHJvdWdoIHVucmVhZC5cbiAqXG4gKiAjIyBUaGUgd3JpdGUtYWhlYWQgaW50ZW50IHJlY29yZFxuICpcbiAqIFRoZSB3cml0ZXIgbm93IGRlY2xhcmVzIHRoZSBhcHBlbmQgaW4gdGhlIGFuY2hvciAqKmJlZm9yZSoqIG1ha2luZyBpdCDigJRcbiAqIGBwZW5kaW5nOiB7IGhhc2gsIHN0YXJ0ZWRBdCB9YCwgbmFtaW5nIHRoZSBlbnRyeSBieSBpdHMgY2hhaW4gaGFzaC4gVGhhdFxuICogc2luZ2xlIGZhY3Qgc2VwYXJhdGVzIGEgY3Jhc2ggZnJvbSBhIGZvcmdlcnksIGFuZCByZWNvdmVyeSBpcyB0aGVuXG4gKiBkZWNpZGFibGUgcmF0aGVyIHRoYW4gZ3Vlc3NlZDpcbiAqXG4gKiB8IE9uIGRpc2sgYWZ0ZXIgdGhlIGNyYXNoICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfCBTZXR0bGVkIGFzIHxcbiAqIHwgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSB8IC0tLS0tLS0tLS0gfFxuICogfCBwZW5kaW5nLCBvbmUgbW9yZSBsaW5lIHRoYXQgKippcyoqIHRoZSBkZWNsYXJlZCBlbnRyeSB8IGNvbXBsZXRlZCAgfFxuICogfCBwZW5kaW5nLCBvbmUgbW9yZSBsaW5lIHRvcm4gb3Igbm90IHRoZSBkZWNsYXJlZCBlbnRyeSB8IGRpc2NhcmRlZCAgfFxuICogfCBubyBwZW5kaW5nLCBvbmUgbW9yZSBsaW5lICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8ICoqYnJva2VuKiogfFxuICogfCBhbnl0aGluZyBhdCBvciBiZWZvcmUgdGhlIGFuY2hvcmVkIGhlYWQgYWx0ZXJlZCAgICAgICB8ICoqYnJva2VuKiogfFxuICogfCBtb3JlIHRoYW4gb25lIGxpbmUgcGFzdCB0aGUgYW5jaG9yICAgICAgICAgICAgICAgICAgICB8ICoqYnJva2VuKiogfFxuICpcbiAqIEEgZGVjbGFyYXRpb24gd2hvc2UgZW50cnkgbmV2ZXIgcmVhY2hlZCB0aGUgZmlsZSBuZWVkcyBubyBzZXR0bGluZyBhdFxuICogYWxsOiB0aGUgam91cm5hbCBhbHJlYWR5IG1hdGNoZXMgaXRzIGFuY2hvciwgYW5kIHRoZSBuZXh0IGFwcGVuZFxuICogb3ZlcndyaXRlcyB0aGUgd2hvbGUgYW5jaG9yIHJlY29yZCDigJQgZGVjbGFyYXRpb24gaW5jbHVkZWQg4oCUIGJlZm9yZSBpdFxuICogd3JpdGVzIGFueXRoaW5nLiBSZXdyaXRpbmcgdGhlIGFuY2hvciBvZiBhIGpvdXJuYWwgdGhhdCBpcyAqbm90KiBhYm91dFxuICogdG8gYmUgYXBwZW5kZWQgdG8gd291bGQgb25seSB0b3VjaCBldmlkZW5jZSBmb3Igbm90aGluZy5cbiAqXG4gKiBOb3RoaW5nIHZlcmlmaWVkIGlzIGV2ZXIgZHJvcHBlZDogb25seSBieXRlcyBwYXN0IHRoZSBhbmNob3JlZCBoZWFkIGFyZVxuICogdG91Y2hlZCwgYW5kIHRoZSBhbmNob3JlZCBoZWFkIGlzIHRoZSBsYXN0IHBvc2l0aW9uIHRoZSBjaGFpbiB3YXMgZXZlclxuICogY29uZmlybWVkIGF0LiBEaXNjYXJkZWQgYnl0ZXMgYXJlIG5vdCBkZWxldGVkIGVpdGhlciDigJQgdGhleSBhcmUgbW92ZWQgdG9cbiAqIGEgYC50b3JuLTxuPmAgc2lkZWNhciBiZXNpZGUgdGhlIGpvdXJuYWwgYW5kIHJlcG9ydGVkLCBzbyBhIHNlbGYtaGVhbFxuICogY2FuIGJlIHJlYWQgYmFjayBieXRlIGZvciBieXRlLlxuICpcbiAqIEEgZm9yZ2VkIHRhaWwgc3RheXMgYnJva2VuLiBXaXRob3V0IGEgcGVuZGluZyByZWNvcmQgdGhlIGV4dHJhIGxpbmUgaXNcbiAqIHJlZnVzZWQgZXhhY3RseSBhcyBJc3N1ZSAjMzk0OSByZXF1aXJlczsgd2l0aCBvbmUsIHRoZSBsaW5lIG11c3QgaGFzaCB0b1xuICogdGhlIGRlY2xhcmVkIHZhbHVlICphbmQqIHJlLWRlcml2ZSB0aGF0IGhhc2ggZnJvbSBpdHMgb3duIHBheWxvYWQsIHdoaWNoXG4gKiBpcyBhIFNIQS0yNTYgc2Vjb25kIHByZWltYWdlLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uLCBhdXRob3Jpc2VkKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgdHlwZSBDaGFpbkFuY2hvciwgcmVhZEFuY2hvciwgd3JpdGVBbmNob3IgfSBmcm9tIFwiLi9hdWRpdF9hbmNob3IudHNcIjtcbmltcG9ydCB7IHR5cGUgQXVkaXRFbnRyeSwgY29tcHV0ZUVudHJ5SGFzaCB9IGZyb20gXCIuL2F1ZGl0X2VudHJ5LnRzXCI7XG5pbXBvcnQgeyBmcmVlU2lkZWNhclBhdGgsIHF1b3RlRHJvcHBlZCB9IGZyb20gXCIuL3Rvcm5fYnl0ZXMudHNcIjtcblxuLyoqIEhvdyBhbiBpbnRlcnJ1cHRlZCBhcHBlbmQgd2FzIHNldHRsZWQuICovXG5leHBvcnQgdHlwZSBBcHBlbmRSZWNvdmVyeUtpbmQgPSBcImNvbXBsZXRlZFwiIHwgXCJkaXNjYXJkZWRcIjtcblxuLyoqIFdoYXQgYSBzZXR0bGVkIGFwcGVuZCBkaWQsIHJlcG9ydGVkIHJhdGhlciB0aGFuIGRvbmUgcXVpZXRseS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwZW5kUmVjb3Zlcnkge1xuICAvKiogSm91cm5hbCB0aGUgcmVjb3ZlcnkgYXBwbGllZCB0by4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogV2hpY2ggb2YgdGhlIHR3byBvdXRjb21lcyB0aGlzIHdhcy4gKi9cbiAga2luZDogQXBwZW5kUmVjb3ZlcnlLaW5kO1xuICAvKiogRW50cmllcyB0aGUgam91cm5hbCBob2xkcywgYW5kIGl0cyBhbmNob3IgcmVjb3JkcywgYWZ0ZXJ3YXJkcy4gKi9cbiAgY291bnQ6IG51bWJlcjtcbiAgLyoqIEJ5dGVzIHJlbW92ZWQgZnJvbSB0aGUgdGFpbCAoMCB1bmxlc3MgYGtpbmRgIGlzIFwiZGlzY2FyZGVkXCIpLiAqL1xuICBkcm9wcGVkQnl0ZXM6IG51bWJlcjtcbiAgLyoqIFNpZGVjYXIgdGhlIHJlbW92ZWQgYnl0ZXMgd2VyZSBtb3ZlZCB0bywgd2hlbiBhbnkgd2VyZSByZW1vdmVkLiAqL1xuICBwcmVzZXJ2ZWRBcz86IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSByZW1vdmVkIGJ5dGVzIGFzIHRleHQsIHNvIHRoZSByZXBvcnQgbmFtZXMgd2hhdCB3ZW50LlxuICAgKlxuICAgKiBRdW90ZWQgYnkgYHRvcm5fYnl0ZXMudHNgIHRvIGEgbGVuZ3RoIGEgbG9nIGNhbiBjYXJyeSwgd2l0aCB0aGUgZnVsbFxuICAgKiBsZW5ndGggbmFtZWQgd2hlbiBpdCBpcyBsb25nZXI7IGBwcmVzZXJ2ZWRBc2AgaG9sZHMgZXZlcnkgYnl0ZS5cbiAgICovXG4gIGRyb3BwZWRUZXh0Pzogc3RyaW5nO1xufVxuXG4vKiogSm91cm5hbCBieXRlcywgaXRzIG5vbi1lbXB0eSBsaW5lcywgYW5kIHdoZXJlIGVhY2ggbGluZSBlbmRzLiAqL1xuaW50ZXJmYWNlIEpvdXJuYWxCeXRlcyB7XG4gIHJhdzogVWludDhBcnJheTtcbiAgbGluZXM6IHN0cmluZ1tdO1xuICAvKiogQnl0ZSBvZmZzZXQganVzdCBwYXN0IHRoZSBuZXdsaW5lIHRlcm1pbmF0aW5nIGVhY2ggbm9uLWVtcHR5IGxpbmUuICovXG4gIGxpbmVFbmRzOiBudW1iZXJbXTtcbiAgZW5kc1dpdGhOZXdsaW5lOiBib29sZWFuO1xufVxuXG4vKiogUmVhZCBhIGpvdXJuYWwncyBieXRlcyB3aXRoIGxpbmUgb2Zmc2V0cywgb3IgbnVsbCB3aGVuIGl0IGlzIGFic2VudC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWRKb3VybmFsQnl0ZXMocGF0aDogc3RyaW5nKTogUHJvbWlzZTxKb3VybmFsQnl0ZXMgfCBudWxsPiB7XG4gIGxldCByYXc6IFVpbnQ4QXJyYXk7XG4gIHRyeSB7XG4gICAgcmF3ID0gYXdhaXQgRGVuby5yZWFkRmlsZShwYXRoKTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIG51bGw7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgY29uc3QgdGV4dCA9IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpO1xuICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBsaW5lRW5kczogbnVtYmVyW10gPSBbXTtcbiAgbGV0IG9mZnNldCA9IDA7XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiB0ZXh0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgLy8gRXZlcnkgc2VnbWVudCBidXQgdGhlIGxhc3Qgd2FzIG5ld2xpbmUtdGVybWluYXRlZDsgbWVhc3VyaW5nIHRoZVxuICAgIC8vIGVuY29kZWQgbGVuZ3RoIGtlZXBzIHRoZSBvZmZzZXRzIHJpZ2h0IGZvciBtdWx0aS1ieXRlIGNvbnRlbnQuXG4gICAgb2Zmc2V0ICs9IGVuY29kZXIuZW5jb2RlKHNlZ21lbnQpLmxlbmd0aCArIDE7XG4gICAgaWYgKHNlZ21lbnQudHJpbSgpLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgbGluZXMucHVzaChzZWdtZW50KTtcbiAgICBsaW5lRW5kcy5wdXNoKG9mZnNldCk7XG4gIH1cbiAgcmV0dXJuIHsgcmF3LCBsaW5lcywgbGluZUVuZHMsIGVuZHNXaXRoTmV3bGluZTogdGV4dC5lbmRzV2l0aChcIlxcblwiKSB9O1xufVxuXG4vKiogQnl0ZSBvZmZzZXQganVzdCBwYXN0IHRoZSBsYXN0IGFuY2hvcmVkIGVudHJ5LiAqL1xuZnVuY3Rpb24gYW5jaG9yZWRMZW5ndGgoam91cm5hbDogSm91cm5hbEJ5dGVzLCBjb3VudDogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKGNvdW50ID09PSAwKSByZXR1cm4gMDtcbiAgcmV0dXJuIGpvdXJuYWwubGluZUVuZHNbY291bnQgLSAxXSA/PyBqb3VybmFsLnJhdy5sZW5ndGg7XG59XG5cbi8qKlxuICogTW92ZSB0aGUgYnl0ZXMgcGFzdCB0aGUgYW5jaG9yZWQgaGVhZCBpbnRvIGEgc2lkZWNhciBhbmQgdHJ1bmNhdGUuXG4gKlxuICogUHJlc2VydmUgZmlyc3QsIHRydW5jYXRlIHNlY29uZDogYSBmYWlsdXJlIHRvIHdyaXRlIHRoZSBzaWRlY2FyIGxlYXZlc1xuICogdGhlIGpvdXJuYWwgZXhhY3RseSBhcyBpdCB3YXMsIHN0aWxsIGZhaWxpbmcgdGhlIHN3ZWVwLCB3aGljaCBpcyB0aGVcbiAqIHNhZmUgZGlyZWN0aW9uLiBOb3RoaW5nIGlzIGV2ZXIgZGVsZXRlZC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGlzY2FyZFRvcm5UYWlsKFxuICBwYXRoOiBzdHJpbmcsXG4gIGpvdXJuYWw6IEpvdXJuYWxCeXRlcyxcbiAgYW5jaG9yOiBDaGFpbkFuY2hvcixcbik6IFByb21pc2U8QXBwZW5kUmVjb3Zlcnk+IHtcbiAgY29uc3Qga2VlcCA9IGFuY2hvcmVkTGVuZ3RoKGpvdXJuYWwsIGFuY2hvci5jb3VudCk7XG4gIGNvbnN0IGRyb3BwZWQgPSBqb3VybmFsLnJhdy5zbGljZShrZWVwKTtcbiAgY29uc3Qgc2lkZWNhciA9IGF3YWl0IGZyZWVTaWRlY2FyUGF0aChwYXRoKTtcbiAgYXdhaXQgRGVuby53cml0ZUZpbGUoc2lkZWNhciwgZHJvcHBlZCwgeyBjcmVhdGVOZXc6IHRydWUgfSk7XG4gIGF3YWl0IERlbm8udHJ1bmNhdGUocGF0aCwga2VlcCk7XG4gIGF3YWl0IGNsZWFyUGVuZGluZyhwYXRoLCBhbmNob3IpO1xuICByZXR1cm4ge1xuICAgIHBhdGgsXG4gICAga2luZDogXCJkaXNjYXJkZWRcIixcbiAgICBjb3VudDogYW5jaG9yLmNvdW50LFxuICAgIGRyb3BwZWRCeXRlczogZHJvcHBlZC5sZW5ndGgsXG4gICAgcHJlc2VydmVkQXM6IHNpZGVjYXIsXG4gICAgZHJvcHBlZFRleHQ6IHF1b3RlRHJvcHBlZChkcm9wcGVkKSxcbiAgfTtcbn1cblxuLyoqIFJld3JpdGUgdGhlIGFuY2hvciBhdCBpdHMgY3VycmVudCBwb3NpdGlvbiwgZHJvcHBpbmcgdGhlIGludGVudCByZWNvcmQuICovXG5hc3luYyBmdW5jdGlvbiBjbGVhclBlbmRpbmcoXG4gIHBhdGg6IHN0cmluZyxcbiAgYW5jaG9yOiBDaGFpbkFuY2hvcixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB3cml0dGVuID0gYXdhaXQgd3JpdGVBbmNob3IocGF0aCwge1xuICAgIGNvdW50OiBhbmNob3IuY291bnQsXG4gICAgaGVhZEhhc2g6IGFuY2hvci5oZWFkSGFzaCxcbiAgfSk7XG4gIGlmICghd3JpdHRlbi5vaykgdGhyb3cgd3JpdHRlbi5lcnJvcjtcbn1cblxuLyoqXG4gKiBEb2VzIGBsaW5lYCBwYXJzZSBhcyBhIHdob2xlIGpvdXJuYWwgZW50cnk/XG4gKlxuICogVGhlIHF1ZXN0aW9uIHNlcGFyYXRlcyBkYW1hZ2UgZnJvbSBmb3JnZXJ5LiBBIGtpbGwgY2FuIGxlYXZlIGJ5dGVzIHRoYXRcbiAqIGRvIG5vdCBwYXJzZTsgaXQgY2Fubm90IGxlYXZlIGEgKmNvbXBsZXRlKiBlbnRyeSB0aGUgd3JpdGVyIG5ldmVyIHNldFxuICogb3V0IHRvIGFwcGVuZC4gU28gYSBwYXJzZWFibGUgdGFpbCBpcyBuZXZlciBkaXNjYXJkZWQgYXMgdG9ybiwgd2hldGhlclxuICogb3Igbm90IHRoZSBhbmNob3IgZGVjbGFyZXMgYW4gYXBwZW5kIChJc3N1ZSAjMTA3NCwgSXNzdWUgIzM5NDkpLlxuICpcbiAqIEBwYXJhbSBsaW5lIC0gVGhlIHRyYWlsaW5nIGxpbmUsIHdpdGhvdXQgaXRzIHRlcm1pbmF0b3JcbiAqIEByZXR1cm5zIHRydWUgd2hlbiB0aGUgbGluZSBpcyBjb21wbGV0ZSwgcGFyc2VhYmxlIEpTT05cbiAqL1xuZnVuY3Rpb24gcGFyc2VzQXNFbnRyeShsaW5lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGxpbmUpIGFzIHVua25vd247XG4gICAgcmV0dXJuIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIgJiYgcGFyc2VkICE9PSBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIElzIGBsaW5lYCBleGFjdGx5IHRoZSBlbnRyeSB0aGUgYW5jaG9yIGRlY2xhcmVkIGFzIGluIGZsaWdodD8gKi9cbmFzeW5jIGZ1bmN0aW9uIGlzRGVjbGFyZWRFbnRyeShcbiAgbGluZTogc3RyaW5nLFxuICBhbmNob3I6IENoYWluQW5jaG9yLFxuKTogUHJvbWlzZTxBdWRpdEVudHJ5IHwgbnVsbD4ge1xuICBsZXQgZW50cnk6IEF1ZGl0RW50cnk7XG4gIHRyeSB7XG4gICAgZW50cnkgPSBKU09OLnBhcnNlKGxpbmUpIGFzIEF1ZGl0RW50cnk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmIChlbnRyeS5wcmV2SGFzaCAhPT0gYW5jaG9yLmhlYWRIYXNoKSByZXR1cm4gbnVsbDtcbiAgaWYgKGVudHJ5Lmhhc2ggIT09IGFuY2hvci5wZW5kaW5nPy5oYXNoKSByZXR1cm4gbnVsbDtcbiAgLy8gUmUtZGVyaXZlIHRoZSBoYXNoIGZyb20gdGhlIHBheWxvYWQ6IGEgbGluZSB0aGF0IG1lcmVseSAqY2xhaW1zKiB0aGVcbiAgLy8gZGVjbGFyZWQgaGFzaCBpcyBub3QgdGhlIGRlY2xhcmVkIGVudHJ5LCBhbmQgcHJvbW90aW5nIGl0IHdvdWxkIG1vdmVcbiAgLy8gdGhlIGFuY2hvciBvbnRvIGNvbnRlbnQgdGhhdCBoYXMgbmV2ZXIgY2hhaW5lZC5cbiAgaWYgKGF3YWl0IGNvbXB1dGVFbnRyeUhhc2goZW50cnksIGFuY2hvci5oZWFkSGFzaCkgIT09IGVudHJ5Lmhhc2gpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXR1cm4gZW50cnk7XG59XG5cbi8qKlxuICogU2V0dGxlIGFuIGFwcGVuZCB0aGF0IHdhcyBpbnRlcnJ1cHRlZCwgaWYgb25lIHdhcy5cbiAqXG4gKiBDYWxsZXJzIG11c3QgaG9sZCB0aGUgYXVkaXQtZGlyZWN0b3J5IGxvY2s6IHRoaXMgcmVhZHMgdGhlIGpvdXJuYWwgYW5kXG4gKiBpdHMgYW5jaG9yIGFuZCBtYXkgcmV3cml0ZSBib3RoLCBzbyBhIGNvbmN1cnJlbnQgYXBwZW5kIHdvdWxkIHNlZSBhXG4gKiBoYWxmLXNldHRsZWQgc3RhdGUuIENhbGxlcnMgc2hvdWxkIGFsc28gaGF2ZSBmb3VuZCB0aGUgam91cm5hbCBicm9rZW5cbiAqIGZpcnN0IOKAlCBhIGpvdXJuYWwgdGhhdCB2ZXJpZmllcyBoYXMgbm90aGluZyBoZXJlIHRvIHNldHRsZS5cbiAqXG4gKiBAcGFyYW0gcGF0aCAtIEpvdXJuYWwgZmlsZSBwYXRoXG4gKiBAcmV0dXJucyBSZXN1bHQgY2FycnlpbmcgdGhlIHJlY292ZXJ5IHBlcmZvcm1lZCwgb3IgYG51bGxgIHdoZW4gdGhlcmVcbiAqICAgd2FzIG5vdGhpbmcgdG8gc2V0dGxlIOKAlCBpbmNsdWRpbmcgZXZlcnkgc2hhcGUgdGhhdCBtdXN0IHN0YXkgYnJva2VuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXR0bGVJbnRlcnJ1cHRlZEFwcGVuZChcbiAgcGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8QXBwZW5kUmVjb3ZlcnkgfCBudWxsPj4ge1xuICB0cnkge1xuICAgIGNvbnN0IGFuY2hvciA9IGF3YWl0IHJlYWRBbmNob3IocGF0aCk7XG4gICAgLy8gTm8gYW5jaG9yIGlzIHRoZSBwcmUtIzM3MTIgYC0tYWRvcHRgIGNhc2UsIG5vdCBhbiBpbnRlcnJ1cHRlZFxuICAgIC8vIGFwcGVuZDogdGhlcmUgaXMgbm8gcmVjb3JkZWQgcG9zaXRpb24gdG8gcmVjb3ZlciB0by5cbiAgICBpZiAoIWFuY2hvcikgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBudWxsIH07XG5cbiAgICBjb25zdCBqb3VybmFsID0gYXdhaXQgcmVhZEpvdXJuYWxCeXRlcyhwYXRoKTtcbiAgICAvLyBBIGpvdXJuYWwgdGhhdCBpcyBhYnNlbnQsIG9yIGFscmVhZHkgdGhlIGxlbmd0aCBpdHMgYW5jaG9yIHJlY29yZHMsXG4gICAgLy8gaGFzIG5vdGhpbmcgcGFzdCB0aGUgYW5jaG9yZWQgaGVhZCB0byBzZXR0bGUuIEEgc3RhbGUgZGVjbGFyYXRpb25cbiAgICAvLyBtYXkgYmUgc2l0dGluZyBpbiB0aGUgYW5jaG9yLCBhbmQgaXMgbGVmdCB0aGVyZTogaXQgY29zdHMgbm90aGluZ1xuICAgIC8vICh2ZXJpZmljYXRpb24gaWdub3JlcyBpdCwgYW5kIHRoZSBuZXh0IGFwcGVuZCBvdmVyd3JpdGVzIHRoZSB3aG9sZVxuICAgIC8vIHJlY29yZCksIGFuZCByZXdyaXRpbmcgdGhlIGFuY2hvciBvZiBhIGZpbGUgdGhpcyBjYWxsIGhhcyBub3RcbiAgICAvLyByZXBhaXJlZCB3b3VsZCBiZSB0b3VjaGluZyBldmlkZW5jZSBmb3Igbm90aGluZy5cbiAgICBpZiAoam91cm5hbCA9PT0gbnVsbCkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBudWxsIH07XG5cbiAgICBjb25zdCBleHRyYSA9IGpvdXJuYWwubGluZXMubGVuZ3RoIC0gYW5jaG9yLmNvdW50O1xuICAgIGlmIChleHRyYSA9PT0gMCkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBudWxsIH07XG5cbiAgICAvLyBNb3JlIHRoYW4gb25lIGxpbmUgcGFzdCB0aGUgYW5jaG9yIGlzIG5ldmVyIGFuIGludGVycnVwdGVkIGFwcGVuZDpcbiAgICAvLyB0aGUgd3JpdGVyIGRlY2xhcmVzIG9uZSBlbnRyeSBhdCBhIHRpbWUuIFR3byB0b3JuIGxpbmVzLCBvciBhIHRvcm5cbiAgICAvLyBsaW5lIGZvbGxvd2VkIGJ5IGEgdmFsaWQgb25lLCBsYW5kIGhlcmUgYW5kIHN0YXkgYnJva2VuLlxuICAgIGlmIChleHRyYSAhPT0gMSkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBudWxsIH07XG5cbiAgICBjb25zdCB0YWlsID0gam91cm5hbC5saW5lc1thbmNob3IuY291bnRdID8/IFwiXCI7XG5cbiAgICBpZiAoYW5jaG9yLnBlbmRpbmcpIHtcbiAgICAgIGNvbnN0IGRlY2xhcmVkID0gYXdhaXQgaXNEZWNsYXJlZEVudHJ5KHRhaWwsIGFuY2hvcik7XG4gICAgICBpZiAoZGVjbGFyZWQgJiYgam91cm5hbC5lbmRzV2l0aE5ld2xpbmUpIHtcbiAgICAgICAgLy8gVGhlIGxpbmUgbGFuZGVkIHdob2xlOyBvbmx5IHRoZSBjb25maXJtaW5nIGFuY2hvciB3cml0ZSB3YXNcbiAgICAgICAgLy8gbG9zdC4gRmluaXNoIHRoZSBhcHBlbmQgcmF0aGVyIHRoYW4gdGhyb3dpbmcgdGhlIGVudHJ5IGF3YXkuXG4gICAgICAgIGNvbnN0IHdyaXR0ZW4gPSBhd2FpdCB3cml0ZUFuY2hvcihwYXRoLCB7XG4gICAgICAgICAgY291bnQ6IGFuY2hvci5jb3VudCArIDEsXG4gICAgICAgICAgaGVhZEhhc2g6IGRlY2xhcmVkLmhhc2gsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXdyaXR0ZW4ub2spIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHdyaXR0ZW4uZXJyb3IgfTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgcGF0aCxcbiAgICAgICAgICAgIGtpbmQ6IFwiY29tcGxldGVkXCIsXG4gICAgICAgICAgICBjb3VudDogYW5jaG9yLmNvdW50ICsgMSxcbiAgICAgICAgICAgIGRyb3BwZWRCeXRlczogMCxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgLy8gVGhlIHRhaWwgaXMgbm90IHRoZSBkZWNsYXJlZCBlbnRyeS4gQSBjcmFzaCBjYW5ub3QgcHJvZHVjZSB0aGF0OlxuICAgICAgLy8gdGhlIHdyaXRlciBvbmx5IGV2ZXIgYXBwZW5kcyB0aGUgb25lIGVudHJ5IGl0IGRlY2xhcmVkLCBzbyB0aGVcbiAgICAgIC8vIHNoYXBlcyBhIGtpbGwgY2FuIGxlYXZlIGFyZSBub3RoaW5nIGF0IGFsbCwgdGhhdCBlbnRyeSB3aG9sZSwgb3JcbiAgICAgIC8vIHRoYXQgZW50cnkgdG9ybi4gQSAqY29tcGxldGUsIHBhcnNlYWJsZSogbGluZSB0aGF0IGlzIHNvbWV0aGluZ1xuICAgICAgLy8gZWxzZSBpcyB0aGVyZWZvcmUgbm90IGRhbWFnZSDigJQgaXQgaXMgdGhlIGZvcmdlZC10YWlsIHNoYXBlIElzc3VlXG4gICAgICAvLyAjMzk0OSBrZWVwcyByZWQsIGFuZCBhIHN0YWxlIGRlY2xhcmF0aW9uIG11c3Qgbm90IGJlY29tZSB0aGUgd2F5XG4gICAgICAvLyB0byBsYXVuZGVyIGl0LiBPbmx5IGdlbnVpbmVseSB0b3JuIGJ5dGVzIGFyZSBkaXNjYXJkZWQuXG4gICAgICBpZiAoam91cm5hbC5lbmRzV2l0aE5ld2xpbmUgJiYgcGFyc2VzQXNFbnRyeSh0YWlsKSkge1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG51bGwgfTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZTogYXdhaXQgZGlzY2FyZFRvcm5UYWlsKHBhdGgsIGpvdXJuYWwsIGFuY2hvciksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIE5vIGludGVudCByZWNvcmQg4oCUIGEgam91cm5hbCB3cml0dGVuIGJlZm9yZSBJc3N1ZSAjMTA3NCwgb3Igb25lXG4gICAgLy8gd2hvc2UgYW5jaG9yIG5ldmVyIHJlY29yZGVkIHRoZSBhdHRlbXB0LiBBICpwYXJzZWFibGUqIHRyYWlsaW5nXG4gICAgLy8gZW50cnkgaXMgdGhlIGZvcmdlZC10YWlsIHNoYXBlIElzc3VlICMzOTQ5IGtlZXBzIHJlZCwgYW5kIHN0YXlzXG4gICAgLy8gcmVkLiBVbnRlcm1pbmF0ZWQsIHVucGFyc2VhYmxlIHRyYWlsaW5nIGJ5dGVzIGFyZSBhIHBhcnRpYWwgd3JpdGU6XG4gICAgLy8gdGhleSBjYW4gY2Fycnkgbm8gZm9yZ2VyeSwgYmVjYXVzZSBhIGZvcmdlcnkgaGFzIHRvIHBhcnNlIGFuZCBjaGFpblxuICAgIC8vIHRvIGJlIHdvcnRoIGFueXRoaW5nLCBhbmQgdGhleSBzaXQgcGFzdCB0aGUgYW5jaG9yZWQgaGVhZCwgc29cbiAgICAvLyBkaXNjYXJkaW5nIHRoZW0gcmVtb3ZlcyBub3RoaW5nIHRoZSBjaGFpbiBldmVyIGNvbmZpcm1lZC5cbiAgICBpZiAoam91cm5hbC5lbmRzV2l0aE5ld2xpbmUgfHwgcGFyc2VzQXNFbnRyeSh0YWlsKSkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBudWxsIH07XG4gICAgfVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogYXdhaXQgZGlzY2FyZFRvcm5UYWlsKHBhdGgsIGpvdXJuYWwsIGFuY2hvcikgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogT25lIGxvdWQsIGdyZXBwYWJsZSBsaW5lIGRlc2NyaWJpbmcgYSBzZXR0bGVkIGFwcGVuZC5cbiAqXG4gKiBBIHNlbGYtaGVhbCB0aGF0IHNheXMgbm90aGluZyBpcyBhIHNpbGVudCB0cmltIG9mIHRoZSBhdWRpdCB0cmFpbCwgc29cbiAqIGV2ZXJ5IHJlY292ZXJ5IG5hbWVzIHRoZSBqb3VybmFsLCB3aGF0IHdhcyBkb25lLCBhbmQg4oCUIHdoZW4gYnl0ZXMgd2VyZVxuICogbW92ZWQgYXNpZGUg4oCUIGhvdyBtYW55LCBhbmQgd2hlcmUgdGhleSBub3cgbGl2ZS5cbiAqXG4gKiBAcGFyYW0gcmVjb3ZlcnkgLSBUaGUgcmVjb3ZlcnkgdG8gZGVzY3JpYmVcbiAqIEByZXR1cm5zIFRoZSBsb2cgbGluZSwgd2l0aG91dCBhIHRyYWlsaW5nIG5ld2xpbmVcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEFwcGVuZFJlY292ZXJ5KHJlY292ZXJ5OiBBcHBlbmRSZWNvdmVyeSk6IHN0cmluZyB7XG4gIGNvbnN0IGhlYWQgPSBgW1NFQ1VSSVRZXSBbQVVESVRfQVBQRU5EX1JFQ09WRVJFRF0gJHtyZWNvdmVyeS5wYXRofTogYCArXG4gICAgYGludGVycnVwdGVkIGFwcGVuZCAke3JlY292ZXJ5LmtpbmR9YDtcbiAgaWYgKHJlY292ZXJ5LmtpbmQgPT09IFwiY29tcGxldGVkXCIpIHtcbiAgICByZXR1cm4gYCR7aGVhZH0g4oCUIHRoZSBlbnRyeSBoYWQgcmVhY2hlZCB0aGUgam91cm5hbCwgc28gdGhlIGFuY2hvciB3YXMgYCArXG4gICAgICBgYWR2YW5jZWQgdG8gJHtyZWNvdmVyeS5jb3VudH0gZW50cmllczsgbm90aGluZyB3YXMgZHJvcHBlZGA7XG4gIH1cbiAgcmV0dXJuIGAke2hlYWR9IOKAlCAke3JlY292ZXJ5LmRyb3BwZWRCeXRlc30gdG9ybiBieXRlKHMpIHBhc3QgdGhlIGFuY2hvcmVkIGAgK1xuICAgIGBoZWFkIHdlcmUgbW92ZWQgdG8gJHtyZWNvdmVyeS5wcmVzZXJ2ZWRBc30gYW5kIHRoZSBqb3VybmFsIHRydW5jYXRlZCBgICtcbiAgICBgdG8gaXRzIGFuY2hvcmVkICR7cmVjb3ZlcnkuY291bnR9IGVudHJpZXM7IGRyb3BwZWQ6ICR7XG4gICAgICBKU09OLnN0cmluZ2lmeShyZWNvdmVyeS5kcm9wcGVkVGV4dCA/PyBcIlwiKVxuICAgIH1gO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FzREMsR0FHRCxTQUEyQixVQUFVLEVBQUUsV0FBVyxRQUFRLG9CQUFvQjtBQUM5RSxTQUEwQixnQkFBZ0IsUUFBUSxtQkFBbUI7QUFDckUsU0FBUyxlQUFlLEVBQUUsWUFBWSxRQUFRLGtCQUFrQjtBQW1DaEUseUVBQXlFLEdBQ3pFLGVBQWUsaUJBQWlCLElBQVk7RUFDMUMsSUFBSTtFQUNKLElBQUk7SUFDRixNQUFNLE1BQU0sS0FBSyxRQUFRLENBQUM7RUFDNUIsRUFBRSxPQUFPLE9BQWdCO0lBQ3ZCLElBQUksaUJBQWlCLEtBQUssTUFBTSxDQUFDLFFBQVEsRUFBRSxPQUFPO0lBQ2xELE1BQU07RUFDUjtFQUNBLE1BQU0sT0FBTyxJQUFJLGNBQWMsTUFBTSxDQUFDO0VBQ3RDLE1BQU0sVUFBVSxJQUFJO0VBQ3BCLE1BQU0sUUFBa0IsRUFBRTtFQUMxQixNQUFNLFdBQXFCLEVBQUU7RUFDN0IsSUFBSSxTQUFTO0VBQ2IsS0FBSyxNQUFNLFdBQVcsS0FBSyxLQUFLLENBQUMsTUFBTztJQUN0QyxtRUFBbUU7SUFDbkUsaUVBQWlFO0lBQ2pFLFVBQVUsUUFBUSxNQUFNLENBQUMsU0FBUyxNQUFNLEdBQUc7SUFDM0MsSUFBSSxRQUFRLElBQUksR0FBRyxNQUFNLEtBQUssR0FBRztJQUNqQyxNQUFNLElBQUksQ0FBQztJQUNYLFNBQVMsSUFBSSxDQUFDO0VBQ2hCO0VBQ0EsT0FBTztJQUFFO0lBQUs7SUFBTztJQUFVLGlCQUFpQixLQUFLLFFBQVEsQ0FBQztFQUFNO0FBQ3RFO0FBRUEs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
// denoCacheMetadata=2572147415595216597,11224488923545275481