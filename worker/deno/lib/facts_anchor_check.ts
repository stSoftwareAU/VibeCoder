/**
 * Issue #4125, stateless anchor check; needs no previous head so it covers
 * worker pushes, foreign pushes and base merges.
 *
 * Each facts entry may carry an `anchor`: the trimmed text of the source line
 * cited at `line`. This module reads each cited file at the head and checks
 * that the anchor still sits on the cited line. When it has moved, the message
 * names where it now appears, so the facts can be corrected. Nothing is kept
 * between runs: every check reads the head afresh.
 *
 * The file reader is injected, so the check itself is pure. `gitReadAtHead`
 * supplies a reader that reads `HEAD` (never the working tree) via `git show`.
 *
 * Australian English spelling used throughout.
 */

import type { Result } from "../types.ts";
import { MAX_FIELD_CHARS, type SummaryFacts } from "./summary_facts.ts";

/** Cap on a cited file's text; a larger file is not checked (notChecked). */
export const MAX_ANCHOR_FILE_CHARS = 5_000_000;

/** Longest source text echoed into a message, in characters. */
const MAX_ECHO_CHARS = 120;

/** Most line numbers named when an anchor has moved. */
const MAX_NAMED_LINES = 5;

/** Text of a repo-relative file at the head, null when the file is absent there; throws when it cannot be read. */
export type ReadAtHead = (path: string) => Promise<string | null>;

export interface AnchorCheckResult {
  stale: string[];
  notChecked: string[];
  checked: number;
}

/**
 * The comparison key for a source line: trimmed, then capped at
 * `MAX_FIELD_CHARS`. Used for BOTH sides of every comparison, so a capped
 * anchor still matches the same capped line.
 */
export function anchorKey(line: string): string {
  return line.trim().slice(0, MAX_FIELD_CHARS);
}

/** Source text for a message: trimmed, capped, with backticks made apostrophes. */
function excerpt(text: string): string {
  return text.trim().slice(0, MAX_ECHO_CHARS).replaceAll("`", "'");
}

/** The first line of an error message, or a fixed fallback when it is empty. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > 0 ? line : "unknown error";
}

type Loaded =
  | { kind: "lines"; lines: string[] }
  | { kind: "absent" }
  | { kind: "too-large" }
  | { kind: "unreadable"; cause: string };

/**
 * Check every anchored entry against the head. Each distinct cited path is
 * read once. An entry without an anchor is reported as not checked, never as
 * passed. A reader that throws marks each anchored entry on that path as not
 * checked, with the cause, never as passed.
 */
export async function checkFactsAnchors(
  facts: SummaryFacts,
  readAtHead: ReadAtHead,
  factsPath: string,
): Promise<AnchorCheckResult> {
  const stale: string[] = [];
  const notChecked: string[] = [];
  let checked = 0;
  const loaded = new Map<string, Loaded>();

  const load = async (path: string): Promise<Loaded> => {
    const cached = loaded.get(path);
    if (cached) return cached;
    let result: Loaded;
    try {
      const text = await readAtHead(path);
      if (text === null) {
        result = { kind: "absent" };
      } else if (text.length > MAX_ANCHOR_FILE_CHARS) {
        result = { kind: "too-large" };
      } else {
        result = { kind: "lines", lines: text.split(/\r\n|\n/) };
      }
    } catch (err) {
      result = { kind: "unreadable", cause: firstLine(err) };
    }
    loaded.set(path, result);
    return result;
  };

  const entries = facts.branchOutcomes.entries;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const where = `${factsPath}: entries[${i}] (${entry.path}:${entry.line})`;

    if (entry.anchor === undefined) {
      notChecked.push(
        `${where} has no anchor, so its line citation was not checked`,
      );
      continue;
    }
    const key = anchorKey(entry.anchor);
    const file = await load(entry.path);

    if (file.kind === "unreadable") {
      notChecked.push(
        `${where} was not checked because the file could not be read at the head: ${file.cause}`,
      );
      continue;
    }
    if (file.kind === "too-large") {
      notChecked.push(
        `${where} was not checked because the file is too large to check (over ${MAX_ANCHOR_FILE_CHARS} chars)`,
      );
      continue;
    }
    if (file.kind === "absent") {
      checked++;
      stale.push(
        `${where} is stale: anchor not found because ${entry.path} does not exist at the head`,
      );
      continue;
    }

    checked++;
    const { lines } = file;
    const cited = lines[entry.line - 1];
    if (cited !== undefined && anchorKey(cited) === key) continue;

    const found: number[] = [];
    for (let n = 0; n < lines.length; n++) {
      const text = lines[n];
      if (text !== undefined && anchorKey(text) === key) found.push(n + 1);
    }
    if (found.length > 0) {
      const named = found.slice(0, MAX_NAMED_LINES).join(", ");
      stale.push(
        `${where} is stale: line ${entry.line} no longer holds its anchor; the anchor now appears at line(s) ${named} — set \`line\` (and \`endLine\`) to the head`,
      );
      continue;
    }

    const holds = cited === undefined
      ? `the file has fewer than ${entry.line} lines`
      : `line ${entry.line} holds \`${excerpt(cited)}\``;
    stale.push(
      `${where} is stale: anchor not found in ${entry.path} at the head; ${holds}`,
    );
  }

  return { stale, notChecked, checked };
}

/**
 * A `ReadAtHead` that reads the committed text at `HEAD` via
 * `git show HEAD:<path>`, so uncommitted working-tree edits are never seen.
 *
 * Returns `null` when git reports the path does not exist at `HEAD`. Any other
 * failure (the command could not run, or git exited non-zero for another
 * reason) throws an Error whose message is the first non-empty line of git's
 * output, so the caller reports it as not checked, never as passed.
 */
export function gitReadAtHead(
  runGit: (
    args: string[],
  ) => Promise<Result<{ code: number; stdout: string; stderr: string }>>,
): ReadAtHead {
  return async (path: string): Promise<string | null> => {
    const result = await runGit(["show", `HEAD:${path}`]);
    if (!result.ok) throw new Error(firstLine(result.error));
    const { code, stdout, stderr } = result.value;
    if (code === 0) return stdout;
    if (false) {
      return null;
    }
    const cause = stderr.split(/\r?\n/).find((line) => line.trim().length > 0);
    throw new Error(cause ? cause.trim() : `git show exited with code ${code}`);
  };
}
