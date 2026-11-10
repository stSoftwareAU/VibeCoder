/**
 * Crash recovery for an interrupted audit-roster append (Issue #1202).
 *
 * ## Why the roster needs its own recovery
 *
 * Issue #1074 gave the *journal* append a declared-then-settled protocol,
 * so a run killed mid-append heals on the next run. The roster beside it —
 * `${dir}.roster.jsonl`, written by `addToRoster`, `markRosterSeen` and the
 * two acknowledgement writers — was left appending with a plain
 * `Deno.writeTextFile(..., { append: true })`.
 *
 * A torn roster line is worse than a torn journal line, because it is not
 * scoped to one journal: `readRosterContents` throws on a line that does
 * not parse, `verifyAllChains` turns that into a failed sweep for the
 * **whole directory**, and both acknowledgement exits read the roster
 * first, so neither `--acknowledge-loss` nor `--acknowledge-damage`
 * applies. The only remaining way out was hand-editing the tamper-evidence
 * file, which is precisely what Issue #359 established must never be the
 * remedy.
 *
 * ## Why no write-ahead declaration is needed
 *
 * The roster is append-only and each line stands alone — there is no chain
 * to re-anchor and no head to advance, so there is nothing for a pending
 * record to disambiguate. The one shape a kill can leave that the roster
 * cannot read is an **unterminated, unparseable final line**, and that is
 * the only shape this module removes:
 *
 * | Final line on disk                        | Settled as |
 * | ----------------------------------------- | ---------- |
 * | newline-terminated, whatever it holds     | **broken** |
 * | unterminated but complete, parseable JSON | **broken** |
 * | unterminated and unparseable              | discarded  |
 *
 * A complete line the roster cannot read is not damage: a short write
 * cannot produce a whole JSON object the writer never set out to append,
 * so that is the forged-line shape and it stays as red as it ever was. A
 * missing newline must never become the way to launder one.
 *
 * Nothing is deleted. The discarded bytes are moved to a `.torn-<n>`
 * sidecar beside the roster and reported, exactly as
 * `audit_append_recovery.ts` does for a journal, so a self-heal can be read
 * back byte for byte.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */ import { rosterPath } from "./audit_anchor.ts";
import { freeSidecarPath, quoteDropped } from "./torn_bytes.ts";
/**
 * Does `line` parse as a whole roster line?
 *
 * The question separates damage from forgery, as it does for the journal:
 * a kill can leave bytes that do not parse, but it cannot leave a
 * *complete* line the writer never set out to append.
 */ function parsesAsLine(line) {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null;
  } catch  {
    return false;
  }
}
/**
 * Discard a torn final roster line, if that is what the roster ends with.
 *
 * Callers should hold the audit-directory lock: this may truncate the
 * roster, so it must not run beside a live appender.
 *
 * @param baseDir - Audit directory the roster covers
 * @returns Result carrying the repair performed, or `null` when there was
 *   nothing to settle — including every shape that must stay broken
 */ export async function settleTornRosterLine(baseDir) {
  const path = rosterPath(baseDir);
  try {
    let raw;
    try {
      raw = await Deno.readFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {
          ok: true,
          value: null
        };
      }
      throw error;
    }
    const text = new TextDecoder().decode(raw);
    // A terminated file has no torn tail: whatever is wrong with it, a
    // short write did not do it, and trimming it would be editing the
    // tamper-evidence file on a guess.
    if (text.length === 0 || text.endsWith("\n")) {
      return {
        ok: true,
        value: null
      };
    }
    const cut = text.lastIndexOf("\n") + 1;
    const tail = text.slice(cut);
    // Trailing whitespace is skipped by the reader, so there is nothing
    // broken to repair; a complete, parseable line is the forged-line
    // shape and stays red.
    if (tail.trim().length === 0 || parsesAsLine(tail)) {
      return {
        ok: true,
        value: null
      };
    }
    // Measure the kept prefix as bytes: the roster carries free text
    // (reasons, operator identities) and may hold multi-byte content.
    const keep = new TextEncoder().encode(text.slice(0, cut)).length;
    const dropped = raw.slice(keep);
    // Preserve first, truncate second: a failure to write the sidecar
    // leaves the roster exactly as it was, still failing the sweep, which
    // is the safe direction. Nothing is ever deleted.
    const sidecar = await freeSidecarPath(path);
    await Deno.writeFile(sidecar, dropped, {
      createNew: true
    });
    // Truncate only the bytes this call actually read. A roster that grew
    // underneath the repair means a writer is appending to it right now,
    // and truncating to a stale offset would destroy that writer's line.
    const size = (await Deno.stat(path)).size;
    if (size !== raw.length) {
      throw new Error(`refusing to truncate ${path}: it grew from ${raw.length} to ` + `${size} bytes while its torn tail was being set aside, so a live ` + `writer's line would be destroyed`);
    }
    await Deno.truncate(path, keep);
    return {
      ok: true,
      value: {
        path,
        droppedBytes: dropped.length,
        preservedAs: sidecar,
        droppedText: quoteDropped(dropped)
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
/**
 * One loud, greppable line describing a repaired roster.
 *
 * A self-heal that says nothing is a silent trim of the tamper-evidence
 * file, so every repair names the roster, how many bytes went, and where
 * they now live.
 *
 * @param recovery - The repair to describe
 * @returns The log line, without a trailing newline
 */ export function formatRosterRecovery(recovery) {
  return `[SECURITY] [AUDIT_ROSTER_RECOVERED] ${recovery.path}: an ` + `interrupted roster append was discarded — ${recovery.droppedBytes} ` + `torn byte(s) in an unterminated final line were moved to ` + `${recovery.preservedAs} and the roster truncated to its last complete ` + `line; dropped: ${JSON.stringify(recovery.droppedText)}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hdWRpdF9yb3N0ZXJfcmVjb3ZlcnkudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDcmFzaCByZWNvdmVyeSBmb3IgYW4gaW50ZXJydXB0ZWQgYXVkaXQtcm9zdGVyIGFwcGVuZCAoSXNzdWUgIzEyMDIpLlxuICpcbiAqICMjIFdoeSB0aGUgcm9zdGVyIG5lZWRzIGl0cyBvd24gcmVjb3ZlcnlcbiAqXG4gKiBJc3N1ZSAjMTA3NCBnYXZlIHRoZSAqam91cm5hbCogYXBwZW5kIGEgZGVjbGFyZWQtdGhlbi1zZXR0bGVkIHByb3RvY29sLFxuICogc28gYSBydW4ga2lsbGVkIG1pZC1hcHBlbmQgaGVhbHMgb24gdGhlIG5leHQgcnVuLiBUaGUgcm9zdGVyIGJlc2lkZSBpdCDigJRcbiAqIGAke2Rpcn0ucm9zdGVyLmpzb25sYCwgd3JpdHRlbiBieSBgYWRkVG9Sb3N0ZXJgLCBgbWFya1Jvc3RlclNlZW5gIGFuZCB0aGVcbiAqIHR3byBhY2tub3dsZWRnZW1lbnQgd3JpdGVycyDigJQgd2FzIGxlZnQgYXBwZW5kaW5nIHdpdGggYSBwbGFpblxuICogYERlbm8ud3JpdGVUZXh0RmlsZSguLi4sIHsgYXBwZW5kOiB0cnVlIH0pYC5cbiAqXG4gKiBBIHRvcm4gcm9zdGVyIGxpbmUgaXMgd29yc2UgdGhhbiBhIHRvcm4gam91cm5hbCBsaW5lLCBiZWNhdXNlIGl0IGlzIG5vdFxuICogc2NvcGVkIHRvIG9uZSBqb3VybmFsOiBgcmVhZFJvc3RlckNvbnRlbnRzYCB0aHJvd3Mgb24gYSBsaW5lIHRoYXQgZG9lc1xuICogbm90IHBhcnNlLCBgdmVyaWZ5QWxsQ2hhaW5zYCB0dXJucyB0aGF0IGludG8gYSBmYWlsZWQgc3dlZXAgZm9yIHRoZVxuICogKip3aG9sZSBkaXJlY3RvcnkqKiwgYW5kIGJvdGggYWNrbm93bGVkZ2VtZW50IGV4aXRzIHJlYWQgdGhlIHJvc3RlclxuICogZmlyc3QsIHNvIG5laXRoZXIgYC0tYWNrbm93bGVkZ2UtbG9zc2Agbm9yIGAtLWFja25vd2xlZGdlLWRhbWFnZWBcbiAqIGFwcGxpZXMuIFRoZSBvbmx5IHJlbWFpbmluZyB3YXkgb3V0IHdhcyBoYW5kLWVkaXRpbmcgdGhlIHRhbXBlci1ldmlkZW5jZVxuICogZmlsZSwgd2hpY2ggaXMgcHJlY2lzZWx5IHdoYXQgSXNzdWUgIzM1OSBlc3RhYmxpc2hlZCBtdXN0IG5ldmVyIGJlIHRoZVxuICogcmVtZWR5LlxuICpcbiAqICMjIFdoeSBubyB3cml0ZS1haGVhZCBkZWNsYXJhdGlvbiBpcyBuZWVkZWRcbiAqXG4gKiBUaGUgcm9zdGVyIGlzIGFwcGVuZC1vbmx5IGFuZCBlYWNoIGxpbmUgc3RhbmRzIGFsb25lIOKAlCB0aGVyZSBpcyBubyBjaGFpblxuICogdG8gcmUtYW5jaG9yIGFuZCBubyBoZWFkIHRvIGFkdmFuY2UsIHNvIHRoZXJlIGlzIG5vdGhpbmcgZm9yIGEgcGVuZGluZ1xuICogcmVjb3JkIHRvIGRpc2FtYmlndWF0ZS4gVGhlIG9uZSBzaGFwZSBhIGtpbGwgY2FuIGxlYXZlIHRoYXQgdGhlIHJvc3RlclxuICogY2Fubm90IHJlYWQgaXMgYW4gKip1bnRlcm1pbmF0ZWQsIHVucGFyc2VhYmxlIGZpbmFsIGxpbmUqKiwgYW5kIHRoYXQgaXNcbiAqIHRoZSBvbmx5IHNoYXBlIHRoaXMgbW9kdWxlIHJlbW92ZXM6XG4gKlxuICogfCBGaW5hbCBsaW5lIG9uIGRpc2sgICAgICAgICAgICAgICAgICAgICAgICB8IFNldHRsZWQgYXMgfFxuICogfCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSB8IC0tLS0tLS0tLS0gfFxuICogfCBuZXdsaW5lLXRlcm1pbmF0ZWQsIHdoYXRldmVyIGl0IGhvbGRzICAgICB8ICoqYnJva2VuKiogfFxuICogfCB1bnRlcm1pbmF0ZWQgYnV0IGNvbXBsZXRlLCBwYXJzZWFibGUgSlNPTiB8ICoqYnJva2VuKiogfFxuICogfCB1bnRlcm1pbmF0ZWQgYW5kIHVucGFyc2VhYmxlICAgICAgICAgICAgICB8IGRpc2NhcmRlZCAgfFxuICpcbiAqIEEgY29tcGxldGUgbGluZSB0aGUgcm9zdGVyIGNhbm5vdCByZWFkIGlzIG5vdCBkYW1hZ2U6IGEgc2hvcnQgd3JpdGVcbiAqIGNhbm5vdCBwcm9kdWNlIGEgd2hvbGUgSlNPTiBvYmplY3QgdGhlIHdyaXRlciBuZXZlciBzZXQgb3V0IHRvIGFwcGVuZCxcbiAqIHNvIHRoYXQgaXMgdGhlIGZvcmdlZC1saW5lIHNoYXBlIGFuZCBpdCBzdGF5cyBhcyByZWQgYXMgaXQgZXZlciB3YXMuIEFcbiAqIG1pc3NpbmcgbmV3bGluZSBtdXN0IG5ldmVyIGJlY29tZSB0aGUgd2F5IHRvIGxhdW5kZXIgb25lLlxuICpcbiAqIE5vdGhpbmcgaXMgZGVsZXRlZC4gVGhlIGRpc2NhcmRlZCBieXRlcyBhcmUgbW92ZWQgdG8gYSBgLnRvcm4tPG4+YFxuICogc2lkZWNhciBiZXNpZGUgdGhlIHJvc3RlciBhbmQgcmVwb3J0ZWQsIGV4YWN0bHkgYXNcbiAqIGBhdWRpdF9hcHBlbmRfcmVjb3ZlcnkudHNgIGRvZXMgZm9yIGEgam91cm5hbCwgc28gYSBzZWxmLWhlYWwgY2FuIGJlIHJlYWRcbiAqIGJhY2sgYnl0ZSBmb3IgYnl0ZS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbiwgYXV0aG9yaXNlZCkuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHJvc3RlclBhdGggfSBmcm9tIFwiLi9hdWRpdF9hbmNob3IudHNcIjtcbmltcG9ydCB7IGZyZWVTaWRlY2FyUGF0aCwgcXVvdGVEcm9wcGVkIH0gZnJvbSBcIi4vdG9ybl9ieXRlcy50c1wiO1xuXG4vKiogV2hhdCBhIHNldHRsZWQgcm9zdGVyIGFwcGVuZCBkaWQsIHJlcG9ydGVkIHJhdGhlciB0aGFuIGRvbmUgcXVpZXRseS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUm9zdGVyUmVjb3Zlcnkge1xuICAvKiogUm9zdGVyIGZpbGUgdGhlIHJlcGFpciBhcHBsaWVkIHRvLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBCeXRlcyByZW1vdmVkIGZyb20gdGhlIHRhaWwuICovXG4gIGRyb3BwZWRCeXRlczogbnVtYmVyO1xuICAvKiogU2lkZWNhciB0aGUgcmVtb3ZlZCBieXRlcyB3ZXJlIG1vdmVkIHRvLiAqL1xuICBwcmVzZXJ2ZWRBczogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIHJlbW92ZWQgYnl0ZXMgYXMgdGV4dCwgc28gdGhlIHJlcG9ydCBuYW1lcyB3aGF0IHdlbnQuXG4gICAqXG4gICAqIFF1b3RlZCB0byBhIGxlbmd0aCBhIGxvZyBjYW4gY2Fycnk7IGBwcmVzZXJ2ZWRBc2AgaG9sZHMgZXZlcnkgYnl0ZS5cbiAgICovXG4gIGRyb3BwZWRUZXh0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogRG9lcyBgbGluZWAgcGFyc2UgYXMgYSB3aG9sZSByb3N0ZXIgbGluZT9cbiAqXG4gKiBUaGUgcXVlc3Rpb24gc2VwYXJhdGVzIGRhbWFnZSBmcm9tIGZvcmdlcnksIGFzIGl0IGRvZXMgZm9yIHRoZSBqb3VybmFsOlxuICogYSBraWxsIGNhbiBsZWF2ZSBieXRlcyB0aGF0IGRvIG5vdCBwYXJzZSwgYnV0IGl0IGNhbm5vdCBsZWF2ZSBhXG4gKiAqY29tcGxldGUqIGxpbmUgdGhlIHdyaXRlciBuZXZlciBzZXQgb3V0IHRvIGFwcGVuZC5cbiAqL1xuZnVuY3Rpb24gcGFyc2VzQXNMaW5lKGxpbmU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSkgYXMgdW5rbm93bjtcbiAgICByZXR1cm4gdHlwZW9mIHBhcnNlZCA9PT0gXCJvYmplY3RcIiAmJiBwYXJzZWQgIT09IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIERpc2NhcmQgYSB0b3JuIGZpbmFsIHJvc3RlciBsaW5lLCBpZiB0aGF0IGlzIHdoYXQgdGhlIHJvc3RlciBlbmRzIHdpdGguXG4gKlxuICogQ2FsbGVycyBzaG91bGQgaG9sZCB0aGUgYXVkaXQtZGlyZWN0b3J5IGxvY2s6IHRoaXMgbWF5IHRydW5jYXRlIHRoZVxuICogcm9zdGVyLCBzbyBpdCBtdXN0IG5vdCBydW4gYmVzaWRlIGEgbGl2ZSBhcHBlbmRlci5cbiAqXG4gKiBAcGFyYW0gYmFzZURpciAtIEF1ZGl0IGRpcmVjdG9yeSB0aGUgcm9zdGVyIGNvdmVyc1xuICogQHJldHVybnMgUmVzdWx0IGNhcnJ5aW5nIHRoZSByZXBhaXIgcGVyZm9ybWVkLCBvciBgbnVsbGAgd2hlbiB0aGVyZSB3YXNcbiAqICAgbm90aGluZyB0byBzZXR0bGUg4oCUIGluY2x1ZGluZyBldmVyeSBzaGFwZSB0aGF0IG11c3Qgc3RheSBicm9rZW5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldHRsZVRvcm5Sb3N0ZXJMaW5lKFxuICBiYXNlRGlyOiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxSb3N0ZXJSZWNvdmVyeSB8IG51bGw+PiB7XG4gIGNvbnN0IHBhdGggPSByb3N0ZXJQYXRoKGJhc2VEaXIpO1xuICB0cnkge1xuICAgIGxldCByYXc6IFVpbnQ4QXJyYXk7XG4gICAgdHJ5IHtcbiAgICAgIHJhdyA9IGF3YWl0IERlbm8ucmVhZEZpbGUocGF0aCk7XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogbnVsbCB9O1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuXG4gICAgY29uc3QgdGV4dCA9IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpO1xuICAgIC8vIEEgdGVybWluYXRlZCBmaWxlIGhhcyBubyB0b3JuIHRhaWw6IHdoYXRldmVyIGlzIHdyb25nIHdpdGggaXQsIGFcbiAgICAvLyBzaG9ydCB3cml0ZSBkaWQgbm90IGRvIGl0LCBhbmQgdHJpbW1pbmcgaXQgd291bGQgYmUgZWRpdGluZyB0aGVcbiAgICAvLyB0YW1wZXItZXZpZGVuY2UgZmlsZSBvbiBhIGd1ZXNzLlxuICAgIGlmICh0ZXh0Lmxlbmd0aCA9PT0gMCB8fCB0ZXh0LmVuZHNXaXRoKFwiXFxuXCIpKSB7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG51bGwgfTtcbiAgICB9XG5cbiAgICBjb25zdCBjdXQgPSB0ZXh0Lmxhc3RJbmRleE9mKFwiXFxuXCIpICsgMTtcbiAgICBjb25zdCB0YWlsID0gdGV4dC5zbGljZShjdXQpO1xuICAgIC8vIFRyYWlsaW5nIHdoaXRlc3BhY2UgaXMgc2tpcHBlZCBieSB0aGUgcmVhZGVyLCBzbyB0aGVyZSBpcyBub3RoaW5nXG4gICAgLy8gYnJva2VuIHRvIHJlcGFpcjsgYSBjb21wbGV0ZSwgcGFyc2VhYmxlIGxpbmUgaXMgdGhlIGZvcmdlZC1saW5lXG4gICAgLy8gc2hhcGUgYW5kIHN0YXlzIHJlZC5cbiAgICBpZiAodGFpbC50cmltKCkubGVuZ3RoID09PSAwIHx8IHBhcnNlc0FzTGluZSh0YWlsKSkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBudWxsIH07XG4gICAgfVxuXG4gICAgLy8gTWVhc3VyZSB0aGUga2VwdCBwcmVmaXggYXMgYnl0ZXM6IHRoZSByb3N0ZXIgY2FycmllcyBmcmVlIHRleHRcbiAgICAvLyAocmVhc29ucywgb3BlcmF0b3IgaWRlbnRpdGllcykgYW5kIG1heSBob2xkIG11bHRpLWJ5dGUgY29udGVudC5cbiAgICBjb25zdCBrZWVwID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHRleHQuc2xpY2UoMCwgY3V0KSkubGVuZ3RoO1xuICAgIGNvbnN0IGRyb3BwZWQgPSByYXcuc2xpY2Uoa2VlcCk7XG5cbiAgICAvLyBQcmVzZXJ2ZSBmaXJzdCwgdHJ1bmNhdGUgc2Vjb25kOiBhIGZhaWx1cmUgdG8gd3JpdGUgdGhlIHNpZGVjYXJcbiAgICAvLyBsZWF2ZXMgdGhlIHJvc3RlciBleGFjdGx5IGFzIGl0IHdhcywgc3RpbGwgZmFpbGluZyB0aGUgc3dlZXAsIHdoaWNoXG4gICAgLy8gaXMgdGhlIHNhZmUgZGlyZWN0aW9uLiBOb3RoaW5nIGlzIGV2ZXIgZGVsZXRlZC5cbiAgICBjb25zdCBzaWRlY2FyID0gYXdhaXQgZnJlZVNpZGVjYXJQYXRoKHBhdGgpO1xuICAgIGF3YWl0IERlbm8ud3JpdGVGaWxlKHNpZGVjYXIsIGRyb3BwZWQsIHsgY3JlYXRlTmV3OiB0cnVlIH0pO1xuXG4gICAgLy8gVHJ1bmNhdGUgb25seSB0aGUgYnl0ZXMgdGhpcyBjYWxsIGFjdHVhbGx5IHJlYWQuIEEgcm9zdGVyIHRoYXQgZ3Jld1xuICAgIC8vIHVuZGVybmVhdGggdGhlIHJlcGFpciBtZWFucyBhIHdyaXRlciBpcyBhcHBlbmRpbmcgdG8gaXQgcmlnaHQgbm93LFxuICAgIC8vIGFuZCB0cnVuY2F0aW5nIHRvIGEgc3RhbGUgb2Zmc2V0IHdvdWxkIGRlc3Ryb3kgdGhhdCB3cml0ZXIncyBsaW5lLlxuICAgIGNvbnN0IHNpemUgPSAoYXdhaXQgRGVuby5zdGF0KHBhdGgpKS5zaXplO1xuICAgIGlmIChzaXplICE9PSByYXcubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byB0cnVuY2F0ZSAke3BhdGh9OiBpdCBncmV3IGZyb20gJHtyYXcubGVuZ3RofSB0byBgICtcbiAgICAgICAgICBgJHtzaXplfSBieXRlcyB3aGlsZSBpdHMgdG9ybiB0YWlsIHdhcyBiZWluZyBzZXQgYXNpZGUsIHNvIGEgbGl2ZSBgICtcbiAgICAgICAgICBgd3JpdGVyJ3MgbGluZSB3b3VsZCBiZSBkZXN0cm95ZWRgLFxuICAgICAgKTtcbiAgICB9XG4gICAgYXdhaXQgRGVuby50cnVuY2F0ZShwYXRoLCBrZWVwKTtcblxuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIHBhdGgsXG4gICAgICAgIGRyb3BwZWRCeXRlczogZHJvcHBlZC5sZW5ndGgsXG4gICAgICAgIHByZXNlcnZlZEFzOiBzaWRlY2FyLFxuICAgICAgICBkcm9wcGVkVGV4dDogcXVvdGVEcm9wcGVkKGRyb3BwZWQpLFxuICAgICAgfSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFN0cmluZyhlcnJvcikpLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBPbmUgbG91ZCwgZ3JlcHBhYmxlIGxpbmUgZGVzY3JpYmluZyBhIHJlcGFpcmVkIHJvc3Rlci5cbiAqXG4gKiBBIHNlbGYtaGVhbCB0aGF0IHNheXMgbm90aGluZyBpcyBhIHNpbGVudCB0cmltIG9mIHRoZSB0YW1wZXItZXZpZGVuY2VcbiAqIGZpbGUsIHNvIGV2ZXJ5IHJlcGFpciBuYW1lcyB0aGUgcm9zdGVyLCBob3cgbWFueSBieXRlcyB3ZW50LCBhbmQgd2hlcmVcbiAqIHRoZXkgbm93IGxpdmUuXG4gKlxuICogQHBhcmFtIHJlY292ZXJ5IC0gVGhlIHJlcGFpciB0byBkZXNjcmliZVxuICogQHJldHVybnMgVGhlIGxvZyBsaW5lLCB3aXRob3V0IGEgdHJhaWxpbmcgbmV3bGluZVxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0Um9zdGVyUmVjb3ZlcnkocmVjb3Zlcnk6IFJvc3RlclJlY292ZXJ5KTogc3RyaW5nIHtcbiAgcmV0dXJuIGBbU0VDVVJJVFldIFtBVURJVF9ST1NURVJfUkVDT1ZFUkVEXSAke3JlY292ZXJ5LnBhdGh9OiBhbiBgICtcbiAgICBgaW50ZXJydXB0ZWQgcm9zdGVyIGFwcGVuZCB3YXMgZGlzY2FyZGVkIOKAlCAke3JlY292ZXJ5LmRyb3BwZWRCeXRlc30gYCArXG4gICAgYHRvcm4gYnl0ZShzKSBpbiBhbiB1bnRlcm1pbmF0ZWQgZmluYWwgbGluZSB3ZXJlIG1vdmVkIHRvIGAgK1xuICAgIGAke3JlY292ZXJ5LnByZXNlcnZlZEFzfSBhbmQgdGhlIHJvc3RlciB0cnVuY2F0ZWQgdG8gaXRzIGxhc3QgY29tcGxldGUgYCArXG4gICAgYGxpbmU7IGRyb3BwZWQ6ICR7SlNPTi5zdHJpbmdpZnkocmVjb3ZlcnkuZHJvcHBlZFRleHQpfWA7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTZDQyxHQUdELFNBQVMsVUFBVSxRQUFRLG9CQUFvQjtBQUMvQyxTQUFTLGVBQWUsRUFBRSxZQUFZLFFBQVEsa0JBQWtCO0FBa0JoRTs7Ozs7O0NBTUMsR0FDRCxTQUFTLGFBQWEsSUFBWTtFQUNoQyxJQUFJO0lBQ0YsTUFBTSxTQUFTLEtBQUssS0FBSyxDQUFDO0lBQzFCLE9BQU8sT0FBTyxXQUFXLFlBQVksV0FBVztFQUNsRCxFQUFFLE9BQU07SUFDTixPQUFPO0VBQ1Q7QUFDRjtBQUVBOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sZUFBZSxxQkFDcEIsT0FBZTtFQUVmLE1BQU0sT0FBTyxXQUFXO0VBQ3hCLElBQUk7SUFDRixJQUFJO0lBQ0osSUFBSTtNQUNGLE1BQU0sTUFBTSxLQUFLLFFBQVEsQ0FBQztJQUM1QixFQUFFLE9BQU8sT0FBZ0I7TUFDdkIsSUFBSSxpQkFBaUIsS0FBSyxNQUFNLENBQUMsUUFBUSxFQUFFO1FBQ3pDLE9BQU87VUFBRSxJQUFJO1VBQU0sT0FBTztRQUFLO01BQ2pDO01BQ0EsTUFBTTtJQUNSO0lBRUEsTUFBTSxPQUFPLElBQUksY0FBYyxNQUFNLENBQUM7SUFDdEMsbUVBQW1FO0lBQ25FLGtFQUFrRTtJQUNsRSxtQ0FBbUM7SUFDbkMsSUFBSSxLQUFLLE1BQU0sS0FBSyxLQUFLLEtBQUssUUFBUSxDQUFDLE9BQU87TUFDNUMsT0FBTztRQUFFLElBQUk7UUFBTSxPQUFPO01BQUs7SUFDakM7SUFFQSxNQUFNLE1BQU0sS0FBSyxXQUFXLENBQUMsUUFBUTtJQUNyQyxNQUFNLE9BQU8sS0FBSyxLQUFLLENBQUM7SUFDeEIsb0VBQW9FO0lBQ3BFLGtFQUFrRTtJQUNsRSx1QkFBdUI7SUFDdkIsSUFBSSxLQUFLLElBQUksR0FBRyxNQUFNLEtBQUssS0FBSyxhQUFhLE9BQU87TUFDbEQsT0FBTztRQUFFLElBQUk7UUFBTSxPQUFPO01BQUs7SUFDakM7SUFFQSxpRUFBaUU7SUFDakUsa0VBQWtFO0lBQ2xFLE1BQU0sT0FBTyxJQUFJLGNBQWMsTUFBTSxDQUFDLEtBQUssS0FBSyxDQUFDLEdBQUcsTUFBTSxNQUFNO0lBQ2hFLE1BQU0sVUFBVSxJQUFJLEtBQUssQ0FBQztJQUUxQixrRUFBa0U7SUFDbEUsc0VBQXNFO0lBQ3RFLGtEQUFrRDtJQUNsRCxNQUFNLFVBQVUsTUFBTSxnQkFBZ0I7SUFDdEMsTUFBTSxLQUFLLFNBQVMsQ0FBQyxTQUFTLFNBQVM7TUFBRSxXQUFXO0lBQUs7SUFFekQsc0VBQXNFO0lBQ3RFLHFFQUFxRTtJQUNyRSxxRUFBcUU7SUFDckUsTUFBTSxPQUFPLENBQUMsTUFBTSxLQUFLLElBQUksQ0FBQyxLQUFLLEVBQUUsSUFBSTtJQUN6QyxJQUFJLFNBQVMsSUFBSSxNQUFNLEVBQUU7TUFDdkIsTUFBTSxJQUFJLE1BQ1IsQ0FBQyxxQkFBcUIsRUFBRSxLQUFLLGVBQWUsRUFBRSxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FDNUQsR0FBRyxLQUFLLDBEQUEwRCxDQUFDLEdBQ25FLENBQUMsZ0NBQWdDLENBQUM7SUFFeEM7SUFDQSxNQUFNLEtBQUssUUFBUSxDQUFDLE1BQU07SUFFMUIsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPO1FBQ0w7UUFDQSxjQUFjLFFBQVEsTUFBTTtRQUM1QixhQUFhO1FBQ2IsYUFBYSxhQUFhO01BQzVCO0lBQ0Y7RUFDRixFQUFFLE9BQU8sT0FBZ0I7SUFDdkIsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLGlCQUFpQixRQUFRLFFBQVEsSUFBSSxNQUFNLE9BQU87SUFDM0Q7RUFDRjtBQUNGO0FBRUE7Ozs7Ozs7OztDQVNDLEdBQ0QsT0FBTyxTQUFTLHFCQUFxQixRQUF3QjtFQUMzRCxPQUFPLENBQUMsb0NBQW9DLEVBQUUsU0FBUyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQ2hFLENBQUMsMENBQTBDLEVBQUUsU0FBUyxZQUFZLENBQUMsQ0FBQyxDQUFDLEdBQ3JFLENBQUMseURBQXlELENBQUMsR0FDM0QsR0FBRyxTQUFTLFdBQVcsQ0FBQywrQ0FBK0MsQ0FBQyxHQUN4RSxDQUFDLGVBQWUsRUFBRSxLQUFLLFNBQVMsQ0FBQyxTQUFTLFdBQVcsR0FBRztBQUM1RCJ9
// denoCacheMetadata=17695449843264613245,16165790175086877235