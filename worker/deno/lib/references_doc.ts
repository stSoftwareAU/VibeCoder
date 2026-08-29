/**
 * Parser for `docs/REFERENCES.md` — the credit list for the external sources
 * whose ideas are embedded in the Vibe Coder's prompts and documentation
 * (Issue #517).
 *
 * The document is prose for humans, but it makes two machine-checkable
 * promises: every credit names a real source with a live URL, and every credit
 * points at a path in this repository where the idea actually shows up. This
 * parser turns the credit tables into data so the tests can hold the document
 * to both promises instead of trusting it.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

/** One credited external source. */
export interface ReferenceEntry {
  /** Display name of the source, e.g. "OWASP Top 10 (2025)". */
  name: string;
  /** Canonical `https://` URL for the source. */
  url: string;
  /** One line on what we took from it. */
  note: string;
  /** Repo-relative paths where the idea shows up. */
  usedIn: string[];
}

/** Header row that marks a table as a credit table. */
const CREDIT_HEADER = ["Source", "What we took", "Where it shows up"];

/** Split a markdown table row into trimmed cells. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

/** True for a `| --- | --- |` separator row. */
function isSeparator(line: string): boolean {
  return cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function fail(message: string, row: string): never {
  throw new Error(`${message} — offending row: ${row.trim()}`);
}

function parseRow(row: string): ReferenceEntry {
  const [source = "", note = "", usage = ""] = cells(row);

  const link = source.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
  if (!link) {
    fail("Every credit needs a linked source — `[Name](url)`", row);
  }
  const name = link[1]?.trim() ?? "";
  const url = link[2]?.trim() ?? "";
  if (!url.startsWith("https://")) {
    fail("Source URLs must be https:// so the link is not downgraded", row);
  }
  if (name === "") {
    fail("Every credit needs a source name", row);
  }
  if (note === "") {
    fail("Every credit needs a note saying what we took", row);
  }

  const usedIn = [...usage.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((path) => path !== "");
  if (usedIn.length === 0) {
    fail("Every credit needs at least one backticked repo path", row);
  }

  return { name, url, note, usedIn };
}

/**
 * Parse every credit table in the references document.
 *
 * A credit table is one whose header is exactly
 * `| Source | What we took | Where it shows up |`; any other table in the
 * document (a legend, a summary) is ignored. A malformed row inside a credit
 * table throws rather than being skipped — a silently dropped credit is an
 * uncredited source.
 *
 * @param markdown - Contents of `docs/REFERENCES.md`
 * @returns Every credited source, in document order
 * @throws Error if the document has no credit table, or a row is malformed
 */
export function parseReferenceEntries(markdown: string): ReferenceEntry[] {
  const lines = markdown.split("\n");
  const entries: ReferenceEntry[] = [];
  let inCreditTable = false;
  let sawCreditTable = false;

  for (const line of lines) {
    const isRow = line.trim().startsWith("|");
    if (!isRow) {
      inCreditTable = false;
      continue;
    }
    if (isSeparator(line)) continue;

    const header = cells(line);
    if (
      header.length === CREDIT_HEADER.length &&
      header.every((cell, index) => cell === CREDIT_HEADER[index])
    ) {
      inCreditTable = true;
      sawCreditTable = true;
      continue;
    }
    if (!inCreditTable) continue;

    entries.push(parseRow(line));
  }

  if (!sawCreditTable) {
    throw new Error(
      "The references document has no credit table — expected a table headed " +
        `| ${CREDIT_HEADER.join(" | ")} |`,
    );
  }
  return entries;
}
