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
 * page — a pinned phrase itself, a filesystem-derived invariant, a rendered
 * prompt checked by the code that produces it, or a whole file read for an
 * absence check. A documentation-drift test must not use this for a positive
 * pin over a whole file; see CODING-STANDARDS.md § Documentation-drift tests,
 * condition 1.
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
  /**
   * Path to the doc, relative to the repo root, with no ".." segment — it
   * must exist as a real file in the working tree (Issue #3238); see
   * `resolveRepoDoc`.
   */
  doc: string;
  /** The same title the drift test passes to `section()`. */
  title: string;
  /** Every phrase the drift test pins in that section. */
  phrases: readonly string[];
  /** The base ref, e.g. `origin/main`. */
  baseRef: string;
  /** Repository to read from; defaults to this repo's root. */
  repo?: string | URL;
}

/** The absolute filesystem path a repo root (string or `file:` URL) names. */
function repoRootPath(repo: string | URL): string {
  const path = repo instanceof URL ? decodeURIComponent(repo.pathname) : repo;
  return path.replace(/\/+$/, "");
}

/**
 * Normalise `doc` to a repo-relative path and confirm it names a real file
 * in `repo`'s working tree, with no ".." escape and no symlink on the way
 * (Issue #3238). `git show <ref>:<path>` misses silently on an unresolvable
 * path — the drift-pins check must never read that miss as "doc new on
 * base", so the path is validated before git ever sees it.
 */
export async function resolveRepoDoc(
  doc: string,
  repo: string | URL = REPO_ROOT,
): Promise<string> {
  const segments = doc.split(/[/\\]/);
  const escapesRoot = doc === "" ||
    /^[/\\]/.test(doc) ||
    /^[A-Za-z]:/.test(doc) ||
    segments.includes("..");
  if (escapesRoot) {
    throw new Error(
      `doc path "${doc}" must be relative to the repo root with no ".." ` +
        `segments (e.g. prompts/issue/prompt.md)`,
    );
  }
  const normalised = segments.filter((part) => part !== "" && part !== ".")
    .join("/");
  const root = repoRootPath(repo);
  const joined = `${root}/${normalised}`;

  let stat: Deno.FileInfo | undefined;
  try {
    stat = await Deno.stat(joined);
  } catch {
    stat = undefined;
  }
  if (!stat || !stat.isFile) {
    throw new Error(
      `doc "${doc}" not found in the working tree at ${joined} — ${doc} is ` +
        `relative to the repo root`,
    );
  }

  // git reads the base tree by path and does not follow working-tree
  // symlinks, so a symlinked path would silently miss there too.
  const realJoined = await Deno.realPath(joined);
  const realRoot = await Deno.realPath(root);
  if (realJoined !== `${realRoot}/${normalised}`) {
    throw new Error(
      `doc "${doc}" goes through a symlink (resolves to ${realJoined})`,
    );
  }
  return normalised;
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
 * `baseRef` — each one is a vacuous pin. `undefined` means `baseRef` never
 * had `doc` at all (a genuinely new doc holds no pins). Throws when
 * `baseRef` does not resolve, when `doc` cannot be resolved to a real file
 * in the working tree (Issue #3238 — a bad path must never be read as "doc
 * new on base"), or when git fails to read a path `cat-file -e` just
 * confirmed exists.
 */
export async function pinsAlreadyOnBase(
  check: BasePinCheck,
): Promise<string[] | undefined> {
  const repo = check.repo ?? REPO_ROOT;
  const ref = await runGit(
    ["rev-parse", "--verify", "--quiet", `${check.baseRef}^{commit}`],
    repo,
  );
  if (ref.code !== 0) {
    throw new Error(`base ref "${check.baseRef}" does not resolve in ${repo}`);
  }
  const path = await resolveRepoDoc(check.doc, repo);
  const exists = await runGit(
    ["cat-file", "-e", `${check.baseRef}:${path}`],
    repo,
  );
  if (exists.code !== 0) return undefined;
  const shown = await runGit(["show", `${check.baseRef}:${path}`], repo);
  if (shown.code !== 0) {
    throw new Error(
      `git show ${check.baseRef}:${path} failed in ${repo} even though ` +
        `cat-file -e reported it present`,
    );
  }
  return pinsAlreadyInSection(shown.stdout, check.title, check.phrases);
}

/**
 * Command line: `deno task drift-pins-on-base <base-ref> <doc> <section>
 * <phrase>...` prints each phrase with whether the base section already held
 * it. `<doc>` is relative to the repo root (no ".." segments) and must exist
 * in the working tree. Exit codes: `0` nothing vacuous (or the doc was never
 * on `<base-ref>`, reported as a single `doc not on base: <doc>` line), `1`
 * at least one phrase is already on base, `2` bad arguments, a base ref that
 * does not resolve, or a `<doc>` that cannot be resolved — never read as
 * "absent on base".
 */
export async function driftPinsCli(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  repo?: string | URL,
): Promise<number> {
  const [baseRef, doc, title, ...phrases] = args;
  if (!baseRef || !doc || !title || phrases.length === 0) {
    err(`usage: ${DRIFT_PINS_TASK} <base-ref> <doc> <section> <phrase>...`);
    return 2;
  }
  let vacuous: string[] | undefined;
  try {
    vacuous = await pinsAlreadyOnBase({ doc, title, phrases, baseRef, repo });
  } catch (error) {
    err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (vacuous === undefined) {
    out(`doc not on base: ${doc}`);
    return 0;
  }
  for (const phrase of phrases) {
    const held = vacuous.includes(phrase);
    out(`${held ? "ALREADY ON BASE" : "absent on base"}: ${phrase}`);
  }
  return vacuous.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  Deno.exit(await driftPinsCli(Deno.args, console.log, console.error));
}
