/**
 * Provider applicability of `docs/MODEL-AND-CACHING.md` (Issue #367).
 *
 * The document is the worker's model/session/caching **behaviour** reference,
 * but most of what it describes is Claude-only. A reader running
 * `agent_provider: codex` needs to know, per behaviour, whether they still get
 * it — so the document carries a provider-applicability matrix and a one-line
 * marker under every major heading.
 *
 * These assertions are derived from `agent_provider.ts`, not from hand-written
 * prose: registering a fourth provider, or adding a section without a marker,
 * fails here until the document is updated.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";
import { agentProviderIds } from "../lib/agent_provider.ts";

const DOC_NAME = "docs/MODEL-AND-CACHING.md";
const text = await Deno.readTextFile(
  new URL(`../../../${DOC_NAME}`, import.meta.url),
);
const lines = text.split("\n");

/** Heading that opens the matrix section. */
const MATRIX_HEADING = "Provider Applicability";

/** Headings that carry no marker: the index, and the matrix section itself. */
const EXEMPT_HEADINGS = new Set(["Table of Contents", MATRIX_HEADING]);

/** Deepest heading level the matrix may link to. */
const MAX_LINKED_LEVEL = 4;

/** Deepest heading level that must carry a marker and a matrix row. */
const MAX_DOCUMENTED_LEVEL = 3;

/** A `##`–`####` heading outside every fenced code block. */
interface Heading {
  level: number;
  title: string;
  /** Zero-based index into `lines`. */
  index: number;
}

/**
 * Collect the `##`–`####` headings, skipping fenced code blocks.
 *
 * Example blocks in this document contain literal `## …` lines that are
 * content, not structure, so a naive scan would demand markers under them.
 *
 * @returns Headings in document order.
 */
function collectHeadings(): Heading[] {
  const found: Heading[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const match = new RegExp(`^(#{2,${MAX_LINKED_LEVEL}}) +(.+?)\\s*$`)
      .exec(line);
    if (match) {
      found.push({ level: match[1]!.length, title: match[2]!, index });
    }
  });
  return found;
}

/**
 * GitHub's heading anchor for a title.
 *
 * Lowercase, drop everything that is not a letter, digit, space, underscore or
 * hyphen (emoji, `&`, `/`, `:`, brackets and em dashes all go), then turn
 * spaces into hyphens — the same slug the document's own in-page links use.
 *
 * @param title - Heading text without the leading hashes.
 * @returns The anchor, without the leading `#`.
 */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

/** Body of the matrix section: the heading through to the next `##`. */
function matrixSection(): string[] {
  const start = lines.findIndex((line) => line === `## ${MATRIX_HEADING}`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

const headings = collectHeadings();
const matrixLines = matrixSection();
const matrixText = matrixLines.join("\n");

/** Headings that must carry a marker and a matrix row. */
const documented = headings.filter((h) => {
  if (h.level > MAX_DOCUMENTED_LEVEL) return false;
  if (EXEMPT_HEADINGS.has(h.title)) return false;
  // Headings inside the matrix section describe the matrix, not a behaviour.
  const matrixStart = lines.indexOf(`## ${MATRIX_HEADING}`);
  if (matrixStart < 0) return true;
  const matrixEnd = matrixStart + 1 + matrixLines.length;
  return h.index < matrixStart || h.index >= matrixEnd;
});

Deno.test("MODEL-AND-CACHING - the matrix has a column for every registered provider", () => {
  const header = matrixLines.find((line) =>
    line.trim().startsWith("|") &&
    agentProviderIds().every((id) => line.includes(`\`${id}\``))
  );
  assert(
    header,
    `the ${MATRIX_HEADING} table needs a header row naming every provider: ` +
      agentProviderIds().join(", "),
  );
});

Deno.test("MODEL-AND-CACHING - every registered provider id appears in the document", () => {
  const ids = agentProviderIds();
  assert(ids.length > 0, "at least one provider must be registered");
  for (const id of ids) {
    assert(
      text.includes(`\`${id}\``),
      `${DOC_NAME} must name the \`${id}\` provider`,
    );
  }
});

Deno.test("MODEL-AND-CACHING - the matrix covers every documented heading", () => {
  for (const heading of documented) {
    const anchor = `(#${slug(heading.title)})`;
    assert(
      matrixText.includes(anchor),
      `the ${MATRIX_HEADING} matrix must carry a row linking "${heading.title}" ` +
        `as ${anchor}`,
    );
  }
});

Deno.test("MODEL-AND-CACHING - every matrix row links a heading that exists", () => {
  const anchors = new Set(headings.map((h) => slug(h.title)));
  for (const match of matrixText.matchAll(/\]\(#([a-z0-9_-]+)\)/g)) {
    const anchor = match[1]!;
    assert(
      anchors.has(anchor),
      `the ${MATRIX_HEADING} matrix links #${anchor}, which is not a heading ` +
        `in ${DOC_NAME}`,
    );
  }
});
