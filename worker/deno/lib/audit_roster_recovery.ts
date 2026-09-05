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
 */

import type { Result } from "../types.ts";
import { rosterPath } from "./audit_anchor.ts";
import { freeSidecarPath, quoteDropped } from "./torn_bytes.ts";

/** What a settled roster append did, reported rather than done quietly. */
export interface RosterRecovery {
  /** Roster file the repair applied to. */
  path: string;
  /** Bytes removed from the tail. */
  droppedBytes: number;
  /** Sidecar the removed bytes were moved to. */
  preservedAs: string;
  /**
   * The removed bytes as text, so the report names what went.
   *
   * Quoted to a length a log can carry; `preservedAs` holds every byte.
   */
  droppedText: string;
}

/**
 * Does `line` parse as a whole roster line?
 *
 * The question separates damage from forgery, as it does for the journal:
 * a kill can leave bytes that do not parse, but it cannot leave a
 * *complete* line the writer never set out to append.
 */
function parsesAsLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null;
  } catch {
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
 */
export async function settleTornRosterLine(
  baseDir: string,
): Promise<Result<RosterRecovery | null>> {
  const path = rosterPath(baseDir);
  try {
    let raw: Uint8Array;
    try {
      raw = await Deno.readFile(path);
    } catch (error: unknown) {
      if (error instanceof Deno.errors.NotFound) {
        return { ok: true, value: null };
      }
      throw error;
    }

    const text = new TextDecoder().decode(raw);
    // A terminated file has no torn tail: whatever is wrong with it, a
    // short write did not do it, and trimming it would be editing the
    // tamper-evidence file on a guess.
    if (text.length === 0 || text.endsWith("\n")) {
      return { ok: true, value: null };
    }

    const cut = text.lastIndexOf("\n") + 1;
    const tail = text.slice(cut);
    // Trailing whitespace is skipped by the reader, so there is nothing
    // broken to repair; a complete, parseable line is the forged-line
    // shape and stays red.
    if (tail.trim().length === 0 || parsesAsLine(tail)) {
      return { ok: true, value: null };
    }

    // Measure the kept prefix as bytes: the roster carries free text
    // (reasons, operator identities) and may hold multi-byte content.
    const keep = new TextEncoder().encode(text.slice(0, cut)).length;
    const dropped = raw.slice(keep);

    // Preserve first, truncate second: a failure to write the sidecar
    // leaves the roster exactly as it was, still failing the sweep, which
    // is the safe direction. Nothing is ever deleted.
    const sidecar = await freeSidecarPath(path);
    await Deno.writeFile(sidecar, dropped, { createNew: true });

    // Truncate only the bytes this call actually read. A roster that grew
    // underneath the repair means a writer is appending to it right now,
    // and truncating to a stale offset would destroy that writer's line.
    const size = (await Deno.stat(path)).size;
    if (size !== raw.length) {
      throw new Error(
        `refusing to truncate ${path}: it grew from ${raw.length} to ` +
          `${size} bytes while its torn tail was being set aside, so a live ` +
          `writer's line would be destroyed`,
      );
    }
    await Deno.truncate(path, keep);

    return {
      ok: true,
      value: {
        path,
        droppedBytes: dropped.length,
        preservedAs: sidecar,
        droppedText: quoteDropped(dropped),
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
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
 */
export function formatRosterRecovery(recovery: RosterRecovery): string {
  return `[SECURITY] [AUDIT_ROSTER_RECOVERED] ${recovery.path}: an ` +
    `interrupted roster append was discarded — ${recovery.droppedBytes} ` +
    `torn byte(s) in an unterminated final line were moved to ` +
    `${recovery.preservedAs} and the roster truncated to its last complete ` +
    `line; dropped: ${JSON.stringify(recovery.droppedText)}`;
}
