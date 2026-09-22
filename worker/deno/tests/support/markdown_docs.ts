/**
 * Shared helpers for the documentation tests — reading a repo document and
 * slicing one section out of it (Issue #871).
 *
 * Two suites had grown their own copy of this, and the copies drifted: one
 * read a `# comment` inside a ```bash block as a heading, which silently
 * truncates every section carrying a shell example and lets the prose after it
 * say anything at all. One fence-aware implementation, used by both.
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assert } from "@std/assert";

/** `tests/support/` → repo root is four levels up. */
const REPO_ROOT = new URL("../../../../", import.meta.url);

/** Read a file by its repo-relative path. */
export async function readRepoDoc(relative: string): Promise<string> {
  return await Deno.readTextFile(new URL(relative, REPO_ROOT));
}

/**
 * Heading levels per line, with fenced code blocks masked out — a `# comment`
 * inside a fenced block is not a heading.
 */
function headingLevels(lines: string[]): (number | undefined)[] {
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return undefined;
    }
    if (fenced) return undefined;
    return line.match(/^(#{1,6}) /)?.[1]?.length;
  });
}

/**
 * Start/end line indices of the section opened by the first heading
 * containing `title` (start is the heading line itself; end is exclusive,
 * the next heading at the same or a higher level, or the end of the
 * document). Throws when no such heading exists — a renamed section fails
 * loudly rather than asserting against an empty string.
 */
function sectionBounds(
  lines: string[],
  title: string,
): { start: number; end: number } {
  const levels = headingLevels(lines);
  const start = lines.findIndex((line, index) =>
    (levels[index] ?? 0) >= 2 && line.includes(title)
  );
  assert(start >= 0, `no heading containing "${title}"`);
  const level = levels[start] ?? 2;
  const endOffset = levels.slice(start + 1).findIndex((depth) =>
    depth !== undefined && depth <= level
  );
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  return { start, end };
}

/**
 * The body of the section introduced by the first heading containing `title`
 * (heading excluded), up to the next heading at the same or a higher level.
 */
export function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const { start, end } = sectionBounds(lines, title);
  return lines.slice(start + 1, end).join("\n");
}

/**
 * The document with the section opened by the first heading containing
 * `title` removed entirely, heading included — the negative control for
 * `section()`: a predicate that still holds here pins nothing.
 */
export function withoutSection(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const { start, end } = sectionBounds(lines, title);
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** One line, single-spaced — prose wrapped at 80 columns still matches. */
export function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}
