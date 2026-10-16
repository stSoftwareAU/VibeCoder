/**
 * Paths a PR summary claims to change, checked against the branch's diff
 * (Issue #3617).
 *
 * A merge from the base branch can absorb part of a PR's change. The summary
 * was written before the merge, so it kept claiming files the diff no longer
 * changes — GRQ-validation#904 and a private fleet PR both did this after a
 * merge-conflict pass. This module extracts the paths a summary claims to
 * change, so the docs-sweep gate can check them against the changed-files
 * list. It has two sources: the `updated:` list of the **Docs sweep** line,
 * and the list items of a change section (`## Changes`, `## Files changed`,
 * and similar).
 *
 * The summary is agent-authored and steered by an untrusted issue body, so
 * all scanning here is treated as untrusted text: input is capped, every scan
 * is a linear index loop or an anchored regex with no overlapping quantifiers,
 * and no regex is built from input.
 *
 * Claims are only checked when the extension is on the allowlist. A path with
 * no extension (`Dockerfile`, `docs/`) is not claim-checked, so a claim of
 * that shape goes unverified rather than being rejected.
 *
 * Uses Australian English throughout (behaviour, normalise, recognise, etc.).
 */

import { splitMarkdownLines } from "./markdown_code_spans.ts";

/** Cap on the number of paths one extractor returns (dedupe keeps the first spelling). */
export const MAX_CLAIMED_PATHS = 50;

/** Cap on the `Docs sweep` raw body scanned for `updated:` (defence in depth). */
const MAX_UPDATED_SCAN_CHARS = 4_000;

/** Cap on the summary text scanned for change sections (defence in depth). */
const MAX_CHANGE_SECTION_SCAN_CHARS = 200_000;

/** Longest raw path accepted before any other check runs. */
const MAX_PATH_CHARS = 300;

/** Characters a claimed path may contain, after the rejects are applied. */
const PATH_CHARS_RE = /^[A-Za-z0-9_.\-][A-Za-z0-9_.\/\-]*$/;

/** A `:N` or `:N-M` line suffix, anchored, with no overlap between the parts. */
const LINE_SUFFIX_RE = /^\d+(?:-\d+)?$/;

/**
 * Extensions a claimed path may end in, lowercased. A path whose basename
 * extension is not listed is not claim-checked.
 */
const CLAIMABLE_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "rst",
  "adoc",
  "txt",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "sh",
  "bash",
  "ps1",
  "psm1",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "rb",
  "php",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "vue",
  "svelte",
  "sql",
  "xml",
  "csv",
  "svg",
  "lock",
]);

/** Opening quote characters and their closing characters. */
const QUOTE_CLOSERS: Readonly<Record<string, string>> = {
  "`": "`",
  '"': '"',
  "“": "”",
};

/** The `updated` label's letters, matched case-insensitively. */
const UPDATED_LABEL = "updated";

/** A word character, for the "preceded by a non-word char" rule on the label. */
const WORD_CHAR_RE = /[A-Za-z0-9_]/;

/** A whitespace character, for the sentence-end rule. */
const WHITESPACE_RE = /\s/;

/** A list-item marker at the start of a line (Issue #3617 change sections). */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;

/** An ATX heading: at most three leading spaces, 1–6 `#`, then a space. */
const HEADING_RE = /^ {0,3}(#{1,6}) (.*)$/;

/** Titles of the change sections whose list items name claimed paths. */
const CHANGE_SECTION_TITLES = new Set([
  "changes",
  "changes made",
  "what changed",
  "files changed",
  "changed files",
  "file changes",
  "files",
]);

/**
 * Normalise one raw claimed path to a repo-relative path, or `null` when it
 * is not a path the gate can check.
 *
 * Strips a leading `./` (repeatedly), a trailing `#anchor`, and a trailing
 * `:N` or `:N-M` line suffix. Rejects an empty value, one over 300 characters,
 * one with whitespace, `*`, `?` or `://`, one starting with `/` or `-`, one
 * ending with `/`, one with a `.` or `..` segment, and one outside the
 * allowed character set. Finally the basename's extension must be on the
 * allowlist: an extensionless file (`Dockerfile`), a directory (`docs/`), a
 * config key (`codegraph_context.enabled`) or an `owner/repo` pair
 * (`stSoftwareAU/VibeCoder`) all return `null`, so they are not
 * claim-checked. A leading-dot path such as `.github/workflows/ci.yml` is
 * allowed when its basename extension is listed.
 *
 * @param raw - The span text as written in the summary
 * @returns The normalised path, or `null` when it is not claim-checkable
 */
export function normaliseClaimedPath(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "" || trimmed.length > MAX_PATH_CHARS) return null;
  if (/\s/.test(trimmed) || /[*?]/.test(trimmed) || trimmed.includes("://")) {
    return null;
  }

  let path = trimmed;
  while (path.startsWith("./")) path = path.slice(2);

  const hash = path.indexOf("#");
  if (hash >= 0) path = path.slice(0, hash);

  const colon = path.lastIndexOf(":");
  if (colon >= 0 && LINE_SUFFIX_RE.test(path.slice(colon + 1))) {
    path = path.slice(0, colon);
  }

  if (path === "" || path.startsWith("/") || path.startsWith("-")) return null;
  if (path.endsWith("/")) return null;
  if (!PATH_CHARS_RE.test(path)) return null;

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  const basename = segments[segments.length - 1]!;
  const dot = basename.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = basename.slice(dot + 1).toLowerCase();
  if (!CLAIMABLE_EXTENSIONS.has(extension)) return null;

  return path;
}

/**
 * Whether a character at `index` in `text` is a word character, or `false`
 * at the start of the text.
 */
function precededByWordChar(text: string, index: number): boolean {
  if (index === 0) return false;
  return WORD_CHAR_RE.test(text[index - 1]!);
}

/**
 * The index just past `updated` and any spaces or tabs, when a `:` follows.
 * Returns `-1` when the label at `start` is not followed by a colon.
 */
function labelColonEnd(text: string, start: number): number {
  let k = start + UPDATED_LABEL.length;
  while (k < text.length && (text[k] === " " || text[k] === "\t")) k++;
  return k < text.length && text[k] === ":" ? k + 1 : -1;
}

/**
 * Find the first `updated:` label outside any quoted span, returning the
 * index just past its colon, or `-1` when there is none. One linear pass:
 * quoted spans are skipped whole, so a label inside a quoted grep term is
 * ignored.
 */
function findUpdatedValueStart(text: string): number {
  let closer: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (closer !== null) {
      if (ch === closer) closer = null;
      continue;
    }
    if (ch in QUOTE_CLOSERS) {
      closer = QUOTE_CLOSERS[ch]!;
      continue;
    }
    if (
      (ch === "u" || ch === "U") &&
      !precededByWordChar(text, i) &&
      text.slice(i, i + UPDATED_LABEL.length).toLowerCase() === UPDATED_LABEL
    ) {
      const end = labelColonEnd(text, i);
      if (end >= 0) return end;
    }
  }
  return -1;
}

/**
 * Read the paths listed after `updated:`. Each quoted span at parenthesis
 * depth 0 is a claimed path. The list ends at the first `;`, at a `.` that
 * ends a sentence (followed by whitespace or the end of the text, at depth
 * 0), or at an unterminated quote. A parenthetical's quoted spans are
 * description, not claims.
 */
function readUpdatedSpans(text: string, start: number): string[] {
  const spans: string[] = [];
  let closer: string | null = null;
  let spanStart = 0;
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    const ch = text[j]!;
    if (closer !== null) {
      if (ch === closer) {
        if (depth === 0) spans.push(text.slice(spanStart, j));
        closer = null;
      }
      continue;
    }
    if (ch in QUOTE_CLOSERS) {
      closer = QUOTE_CLOSERS[ch]!;
      spanStart = j + 1;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === ";") {
      break;
    } else if (
      ch === "." &&
      depth === 0 &&
      (j + 1 >= text.length || WHITESPACE_RE.test(text[j + 1]!))
    ) {
      break;
    }
  }
  return spans;
}

/**
 * Extract the paths a Docs sweep line's `updated:` list claims to change.
 *
 * Only the first `updated` label outside a quoted span counts. Only quoted
 * spans in the list count, so a `file:line` reference or a path after `;` is
 * not a claim. Bare, unquoted words are not checked. Each span goes through
 * {@link normaliseClaimedPath}, and the result is deduplicated and capped at
 * {@link MAX_CLAIMED_PATHS}.
 *
 * @param rawBody - The Docs sweep entry with list markers stripped, backticks
 *   and quotes intact
 * @returns The claimed paths, in the order written
 */
export function extractUpdatedPaths(rawBody: string): string[] {
  const text = (rawBody ?? "").slice(0, MAX_UPDATED_SCAN_CHARS);
  const start = findUpdatedValueStart(text);
  if (start < 0) return [];

  const paths: string[] = [];
  for (const span of readUpdatedSpans(text, start)) {
    const path = normaliseClaimedPath(span);
    if (path === null || paths.includes(path)) continue;
    paths.push(path);
    if (paths.length >= MAX_CLAIMED_PATHS) break;
  }
  return paths;
}

/**
 * Remove trailing `#` and whitespace characters, with a backward index loop
 * so a long run cannot backtrack.
 */
function trimTrailingHashesAndSpace(title: string): string {
  let end = title.length;
  while (end > 0) {
    const ch = title[end - 1]!;
    if (ch !== "#" && ch !== " " && ch !== "\t") break;
    end--;
  }
  return title.slice(0, end);
}

/**
 * Normalise a heading title for comparison with {@link CHANGE_SECTION_TITLES}:
 * trailing `#`s and spaces, `*`, `_` and backtick decoration, leading
 * non-letters (such as an emoji), and a trailing `:` are removed, then the
 * result is lowercased and trimmed.
 */
function normaliseHeadingTitle(title: string): string {
  let text = trimTrailingHashesAndSpace(title).replace(/[*_`]/g, "");
  text = text.replace(/^[^\p{L}]+/u, "");
  while (text.endsWith(":")) text = text.slice(0, -1);
  return text.toLowerCase().trim();
}

/**
 * Extract the paths named by the list items of a change section (`## Changes`,
 * `## Files changed`, and similar), one per item.
 *
 * A change section is a heading of level 2–4 whose normalised title is in
 * {@link CHANGE_SECTION_TITLES}; it runs until the next heading of any level.
 * Fenced code is ignored, headings inside a fence included. An item is a list
 * line whose first backticked span is a claimed path — only the opening span
 * counts, so a later span in the item is description.
 *
 * @param summary - The PR summary text
 * @returns The claimed paths, in the order written, deduplicated and capped
 */
export function extractChangeSectionPaths(summary: string): string[] {
  const lines = splitMarkdownLines(
    (summary ?? "").slice(0, MAX_CHANGE_SECTION_SCAN_CHARS),
  );
  const paths: string[] = [];
  let inFence = false;
  let inSection = false;

  for (const line of lines) {
    const leading = line.trimStart();
    if (leading.startsWith("```") || leading.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1]!.length;
      inSection = level >= 2 && level <= 4 &&
        CHANGE_SECTION_TITLES.has(normaliseHeadingTitle(heading[2]!));
      continue;
    }
    if (!inSection) continue;

    const item = line.match(LIST_ITEM_RE);
    if (!item) continue;
    let rest = line.slice(item[0].length);
    if (rest.startsWith("**") || rest.startsWith("__")) rest = rest.slice(2);
    if (!rest.startsWith("`")) continue;
    const close = rest.indexOf("`", 1);
    if (close < 0) continue;
    const path = normaliseClaimedPath(rest.slice(1, close));
    if (path === null || paths.includes(path)) continue;
    paths.push(path);
    if (paths.length >= MAX_CLAIMED_PATHS) break;
  }
  return paths;
}

/**
 * Whether a claimed path is in the changed-files list: a changed file equals
 * the path, or ends with `"/" + path`, so a summary's `lib/foo.ts` matches
 * `worker/deno/lib/foo.ts`.
 *
 * The suffix match is lenient on purpose. It can only make a false claim look
 * backed (a miss), never make a true claim look unbacked, so it cannot invent
 * a finding. `foo.ts` does not match `barfoo.ts`, because the match must
 * start at a `/` boundary.
 *
 * @param path - A normalised claimed path
 * @param changedFiles - The branch's changed files, repo-relative
 * @returns True when a changed file backs the claim
 */
export function isPathInChangedFiles(
  path: string,
  changedFiles: readonly string[],
): boolean {
  const suffix = "/" + path;
  return changedFiles.some(
    (file) => file === path || file.endsWith(suffix),
  );
}

/**
 * The claimed paths that no changed file backs, in the order given.
 *
 * @param paths - Normalised claimed paths
 * @param changedFiles - The branch's changed files, repo-relative
 * @returns The paths not matched by {@link isPathInChangedFiles}
 */
export function unbackedPaths(
  paths: readonly string[],
  changedFiles: readonly string[],
): string[] {
  return paths.filter((path) => !isPathInChangedFiles(path, changedFiles));
}
