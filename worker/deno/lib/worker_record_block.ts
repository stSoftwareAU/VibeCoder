/**
 * The worker's machine-owned record block in an issue body (Issue #1631).
 *
 * The deferral bookkeeping write (`blocked_deferral.ts`) appends
 * `Depends on owner/repo#N` to an approved issue body, and the
 * content-approval gate reads that as "content changed after approval" — the
 * fleet's own routine write tripping the control meant to catch tampering.
 *
 * Exempting the *author* would defeat the gate: a compromised agent runs as
 * exactly that login. So the exemption is scoped to the **edit**, not the
 * editor. The worker writes its bookkeeping inside a delimited block, and the
 * gate hashes the body with that block removed — but only when every line
 * inside it matches a strict machine grammar. The rule is author-blind:
 *
 * - anyone may write a block, and a block containing anything other than the
 *   permitted grammar is **not** stripped, so it is hashed like any other
 *   content and the gate fires;
 * - the only text that can ever be hidden from the gate is a
 *   `Depends on owner/repo#N` line, whose sole effect is to make the
 *   dependency gate *skip* the issue. That is a denial, never a path to
 *   processing unapproved content — the direction the gate already fails in.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Opening delimiter of the machine-owned block. */
export const WORKER_RECORD_START = "<!-- vibe-worker-record-start -->";

/** Closing delimiter of the machine-owned block. */
export const WORKER_RECORD_END = "<!-- vibe-worker-record-end -->";

/**
 * The exact separator the worker writes between the body and the block.
 *
 * Stripping removes this separator along with the block, so the normalised
 * body is byte-identical to the body that was approved — including whatever
 * trailing newlines it carried. A greedier "any run of newlines" rule would
 * eat those too, and a baseline captured before the block existed would stop
 * matching.
 */
const BLOCK_SEPARATOR = "\n\n";

/**
 * The only line shape permitted inside the block: the dependency line
 * `buildDependencyLine` writes, with or without an `owner/repo` prefix.
 */
const PERMITTED_LINE =
  /^Depends on (?:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)?#\d+$/;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a delimited block, capturing its content; tolerates CRLF. */
function blockPattern(): RegExp {
  return new RegExp(
    `${escapeRegExp(WORKER_RECORD_START)}\\r?\\n([\\s\\S]*?)\\r?\\n${
      escapeRegExp(WORKER_RECORD_END)
    }`,
    "g",
  );
}

/** The block occurrences in `body`, in order. */
function findBlocks(
  body: string,
): { start: number; end: number; content: string }[] {
  const pattern = blockPattern();
  const found: { start: number; end: number; content: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[1] ?? "",
    });
  }
  return found;
}

/** True when every line inside a block is machine-written bookkeeping. */
export function isMachineOwnedContent(content: string): boolean {
  const lines = content.split("\n").map((line) => line.replace(/\r$/, ""));
  const meaningful = lines.filter((line) => line.trim() !== "");
  if (meaningful.length === 0) return false;
  return meaningful.every((line) => PERMITTED_LINE.test(line));
}

/** Render the delimited block around the given bookkeeping lines. */
export function buildWorkerRecordBlock(lines: readonly string[]): string {
  return `${WORKER_RECORD_START}\n${lines.join("\n")}\n${WORKER_RECORD_END}`;
}

/**
 * Add `line` to the body's machine-owned block, creating the block when the
 * body has none. An existing line is left alone rather than duplicated.
 *
 * Only a block whose content is already machine-owned is extended: a block
 * carrying anything else is somebody's hand-written text wearing the
 * delimiters, and the worker does not write into it.
 */
export function upsertWorkerRecordLine(body: string, line: string): string {
  const block = findBlocks(body).find((candidate) =>
    isMachineOwnedContent(candidate.content)
  );
  if (!block) {
    return `${body}${BLOCK_SEPARATOR}${buildWorkerRecordBlock([line])}`;
  }
  const existing = block.content
    .split("\n")
    .map((entry) => entry.replace(/\r$/, "").trim())
    .filter((entry) => entry !== "");
  if (existing.includes(line)) return body;
  return body.slice(0, block.start) +
    buildWorkerRecordBlock([...existing, line]) +
    body.slice(block.end);
}

/** How many characters of separator sit immediately before `start`. */
function separatorLength(body: string, start: number): number {
  for (const separator of ["\r\n\r\n", BLOCK_SEPARATOR]) {
    if (body.startsWith(separator, start - separator.length)) {
      return separator.length;
    }
  }
  return 0;
}

/**
 * Remove every machine-owned block from `body`, along with the separator the
 * worker wrote before it, leaving all other content byte-identical.
 *
 * A block whose content is not machine-owned is left in place, so it is
 * hashed like any other text and the content-approval gate still sees it.
 */
export function stripWorkerRecordBlocks(body: string): string {
  if (!body.includes(WORKER_RECORD_START)) return body;
  let out = "";
  let cursor = 0;
  for (const block of findBlocks(body)) {
    if (!isMachineOwnedContent(block.content)) continue;
    const separator = separatorLength(body, block.start);
    out += body.slice(cursor, block.start - separator);
    cursor = block.end;
  }
  return out + body.slice(cursor);
}
