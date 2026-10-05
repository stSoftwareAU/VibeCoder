/**
 * Shared helpers for the documentation tests — reading a repo document and
 * slicing one section out of it (Issue #871).
 *
 * Two suites had grown their own copy of this, and the copies drifted: one
 * read a `# comment` inside a ```bash block as a heading, which silently
 * truncates every section carrying a shell example and lets the prose after it
 * say anything at all. One fence-aware implementation, used by both.
 *
 * Section-scoped text carries the `DocSection` brand, so a whole-file drift
 * pin is a `deno check` error rather than a silently-too-broad test
 * (Issue #3234).
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assert } from "@std/assert";

declare const docSectionBrand: unique symbol;

/**
 * Text narrowed to one heading's section, as produced by `section()`. `flat()`
 * accepts only this, so a whole-file drift pin — `flat(wholeDoc)` rather than
 * `flat(section(wholeDoc, title))` — fails `deno check` instead of silently
 * passing on a page that moved the rule elsewhere (CODING-STANDARDS.md §
 * Documentation-drift tests, condition 1; Issue #3234).
 */
export type DocSection = string & { readonly [docSectionBrand]: true };

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
export function section(markdown: string, title: string): DocSection {
  const lines = markdown.split("\n");
  const { start, end } = sectionBounds(lines, title);
  return lines.slice(start + 1, end).join("\n") as DocSection;
}

/**
 * The document with the section opened by the first heading containing
 * `title` removed entirely, heading included — the negative control for
 * `section()`: a predicate that still holds here pins nothing. Branded as a
 * `DocSection` too, so this negative control can be flattened the same way
 * as the section it stands in for.
 */
export function withoutSection(markdown: string, title: string): DocSection {
  const lines = markdown.split("\n");
  const { start, end } = sectionBounds(lines, title);
  return [...lines.slice(0, start), ...lines.slice(end)].join(
    "\n",
  ) as DocSection;
}

/**
 * A slice of a section is still within that section — for paragraph/bullet
 * helpers that cut one rule out of a larger section.
 */
export function excerpt(
  text: DocSection,
  start: number,
  end?: number,
): DocSection {
  return text.slice(start, end) as DocSection;
}

/** A section split into pieces — each piece is still within that section. */
export function splitSection(
  text: DocSection,
  separator: string | RegExp,
): DocSection[] {
  return text.split(separator) as DocSection[];
}

/**
 * One line, single-spaced — prose wrapped at 80 columns still matches.
 * Accepts only section-scoped text (`DocSection`), not a whole file; a
 * whole-file drift pin is a type error (Issue #3234). Flattening a whole
 * file that is not a drift pin is `flatWholeFile()`.
 */
export function flat(text: DocSection): string {
  return text.replace(/\s+/g, " ");
}

/**
 * One line, single-spaced, for text that is not a section of a documentation
 * page — a pinned phrase itself, a filesystem-derived invariant, or a
 * rendered prompt checked by the code that produces it. A documentation-drift
 * test must not use this on a whole file; see CODING-STANDARDS.md §
 * Documentation-drift tests, condition 1.
 */
export function flatWholeFile(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * The pinned phrases the base branch's version of a section already held
 * (Issue #3193). Such a pin stays green when the new rule is deleted, so it
 * guards nothing — CODING-STANDARDS.md § Documentation-drift tests,
 * condition 4. The check is per phrase on purpose: a test that pins several
 * phrases goes red against the base as soon as one of them is new, which
 * hides a vacuous pin beside it.
 *
 * `baseMarkdown` is the whole document at the base ref, or `undefined` when
 * the base never had it; a missing doc or section holds no pins. Phrases are
 * matched as the drift tests match them, against the `flat()` section text.
 */
export function pinsAlreadyInSection(
  baseMarkdown: string | undefined,
  title: string,
  phrases: readonly string[],
): string[] {
  if (baseMarkdown === undefined) return [];
  const lines = baseMarkdown.split("\n");
  const levels = headingLevels(lines);
  const hasSection = lines.some((line, index) =>
    (levels[index] ?? 0) >= 2 && line.includes(title)
  );
  if (!hasSection) return [];
  const text = flat(section(baseMarkdown, title));
  return phrases.filter((phrase) => text.includes(flatWholeFile(phrase)));
}

/** The `deno task` that runs the per-phrase check from the command line. */
export const DRIFT_PINS_TASK = "drift-pins-on-base";

/** What `pinsAlreadyOnBase` checks: one doc section at one base ref. */
export interface BasePinCheck {
  /** Repo-relative path of the doc, as `readRepoDoc` takes it. */
  doc: string;
  /** The same title the drift test passes to `section()`. */
  title: string;
  /** Every phrase the drift test pins in that section. */
  phrases: readonly string[];
  /** The base ref, e.g. `origin/main`. */
  baseRef: string;
  /** Repository to read from; defaults to this repo's root. */
  repo?: string;
}

/** Run git in `cwd`, returning its exit code and stdout. */
async function runGit(
  args: string[],
  cwd: string | URL,
): Promise<{ code: number; stdout: string }> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "null",
  }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

/**
 * The pinned phrases already present in `doc`'s `title` section at
 * `baseRef` — each one is a vacuous pin. Throws when `baseRef` does not
 * resolve, so a mistyped ref cannot pass as "nothing on base".
 */
export async function pinsAlreadyOnBase(
  check: BasePinCheck,
): Promise<string[]> {
  const repo = check.repo ?? REPO_ROOT;
  const ref = await runGit(
    ["rev-parse", "--verify", "--quiet", `${check.baseRef}^{commit}`],
    repo,
  );
  if (ref.code !== 0) {
    throw new Error(`base ref "${check.baseRef}" does not resolve in ${repo}`);
  }
  const shown = await runGit(["show", `${check.baseRef}:${check.doc}`], repo);
  const markdown = shown.code === 0 ? shown.stdout : undefined;
  return pinsAlreadyInSection(markdown, check.title, check.phrases);
}

/**
 * Command line: `deno task drift-pins-on-base <base-ref> <doc> <section>
 * <phrase>...` prints each phrase with whether the base section already held
 * it, and exits 1 when any did — the per-phrase check, run rather than
 * eyeballed.
 */
if (import.meta.main) {
  const [baseRef, doc, title, ...phrases] = Deno.args;
  if (!baseRef || !doc || !title || phrases.length === 0) {
    console.error(
      `usage: ${DRIFT_PINS_TASK} <base-ref> <doc> <section> <phrase>...`,
    );
    Deno.exit(2);
  }
  const vacuous = await pinsAlreadyOnBase({ doc, title, phrases, baseRef });
  for (const phrase of phrases) {
    const held = vacuous.includes(phrase);
    console.log(`${held ? "ALREADY ON BASE" : "absent on base"}: ${phrase}`);
  }
  if (vacuous.length > 0) Deno.exit(1);
}
