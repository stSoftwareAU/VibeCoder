/**
 * Docs sweep term re-run (Issue #3172).
 *
 * The docs-sweep gate (`docs_sweep_gate.ts`, Issue #3073) requires a PR
 * summary's **Docs sweep** line and the manual `section:` it names, but
 * nothing checked the line against the head. Fleet PRs passed with a
 * complete-looking sweep while hits of their own declared grep terms — or an
 * inflected form of one — still stated the removed behaviour, often in a file
 * the line listed as updated: the agent fixed the section it named and
 * stopped (GRQ-AutoTrader#2413 missed `:320` and `:559` of a file it edited;
 * #2405 was sent back three times for the same claim).
 *
 * Once the gate accepts the line, this re-runs each term the line quotes
 * after `grep:` (backticked or double-quoted), and each term it quotes after
 * `siblings:` (Issue #3371), case-insensitively, over the
 * head's `README.md`, every `*\/README.md` and `docs/` (excluding
 * `docs/archive/`). A hit is stale unless it sits in a line the branch's
 * diff added or changed, or the Docs sweep line names it as left alone by
 * `file:line` (or `file:start-end`). Stale hits are advisory (Issue #3237):
 * the worker posts them once as a PR comment for the reviewer and logs them,
 * but they never block the run.
 *
 * The `siblings:` terms are re-run too (Issue #3371): fleet PRs that added a
 * member to a set grepped only the new member's name, which is in no doc
 * yet, and left lists of the set one short (GRQ-AutoTrader#2460, #2481,
 * #2682, #2792). They reach the same hit rules as the grep terms.
 *
 * The grep and sibling terms are also re-run over source files outside `docs/`
 * (`SOURCE_COMMENT_PATHSPECS`), keeping only hits on a whole comment line
 * (Issue #3219). Fleet PRs fixed the manuals and the comment above the code
 * they edited, but left doc comments on a shared constant, a reader or a
 * helper in another file describing the removed behaviour (VibeCoder#3215,
 * GRQ-AutoTrader#2460, #2393). Those hits are cleared the same way — a line
 * the diff changed, or `file:line` in the Docs sweep line — and the
 * broad-term cap is counted for docs and source comments apart, so a term
 * common in comments cannot set aside its doc hits. A code line, or a
 * comment trailing code, is not read: the issue is stale prose, and a
 * term's own definition is not a sentence to clear.
 *
 * Terms are literal: every regex metacharacter is escaped before the pattern
 * reaches `git grep -E`, except a `\w*` / `\w+` stem marker, which becomes a
 * word-character run so `replac\w*` finds "replaced" and "replaces". No
 * `RegExp` is built from the summary in this process, and git is given a
 * pattern made only of escaped literals and those runs.
 *
 * A grep or diff that cannot run is `not_checked` — logged and reported by
 * the caller, never a clean pass (CODING-STANDARDS "Writing a gate over
 * text", item 3).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** The doc surfaces the issue prompt's docs step greps (git pathspecs). */
export const DOCS_SWEEP_PATHSPECS: readonly string[] = [
  "README.md",
  "*/README.md",
  "docs",
  ":(exclude)docs/archive",
];

/** Source-file globs whose comment lines the re-run reads (Issue #3219). */
const SOURCE_FILE_GLOBS: readonly string[] = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.rs",
  "*.py",
  "*.go",
  "*.java",
  "*.kt",
  "*.swift",
  "*.c",
  "*.h",
  "*.cc",
  "*.cpp",
  "*.cs",
  "*.rb",
  "*.sh",
  "*.ps1",
  "*.psm1",
];

/**
 * Source files outside `docs/` (which the docs pass already reads), as git
 * pathspecs. Git's default pathspec `*` crosses `/`, so `*.ts` matches at
 * any depth.
 */
export const SOURCE_COMMENT_PATHSPECS: readonly string[] = [
  ...SOURCE_FILE_GLOBS,
  ":(exclude)docs",
];

/** Every file either pass reads — the diff is taken over these. */
const DIFF_PATHSPECS: readonly string[] = [
  "README.md",
  "*/README.md",
  "docs",
  ...SOURCE_FILE_GLOBS,
  ":(exclude)docs/archive",
];

/**
 * A whole comment line: `//` (and `///`, `//!`), `/*`, a `*` block-comment
 * continuation, or `#` followed by a space or the end of the line. `#[…]`,
 * `#!` and `#include` are code, and so is a comment trailing code.
 */
const SOURCE_COMMENT_RE = /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$)|#(?:\s|$))/;

/** Whether a source line is a whole comment line (Issue #3219). */
export function isSourceCommentLine(text: string): boolean {
  return SOURCE_COMMENT_RE.test(text);
}

/** Up to how many grep terms are re-run from one Docs sweep line. */
export const MAX_TERMS = 20;

/** A term longer than this is not a grep term anyone typed; it is skipped. */
const MAX_TERM_CHARS = 200;

/** Up to how many stale hits are named in the comment and the log line. */
export const MAX_REPORTED_HITS = 20;

/** Hit sentences are trimmed to this many characters in the comment. */
const MAX_HIT_TEXT_CHARS = 200;

/** Cap on grep / diff output read, per call (defence in depth). */
const MAX_GIT_OUTPUT_CHARS = 2_000_000;

/** One line a Docs sweep term still hits at the head. */
export interface DocsSweepHit {
  /** Repo-relative path. */
  path: string;
  /** 1-based line number at the head. */
  line: number;
  /** The line's text. */
  text: string;
  /** The Docs sweep term that hit it. */
  term: string;
}

/** Outcome of re-running the Docs sweep line's terms. */
export type DocsSweepTermCheck =
  | { status: "skipped"; reason: string }
  | { status: "not_checked"; reason: string; terms: string[] }
  | {
    status: "checked";
    terms: string[];
    staleHits: DocsSweepHit[];
    /** Terms too broad to list line by line (see `MAX_UNTOUCHED_HITS_PER_TERM`). */
    broadTerms: string[];
  };

/** A git runner: resolves with the exit code and output; may reject. */
export type DocsSweepGitRunner = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The `grep:` field label. */
const GREP_LABEL_RE = /\bgrep\s*:/i;

/** Closing quote for each opening quote a term may be wrapped in. */
const CLOSING_QUOTE: Readonly<Record<string, string>> = {
  "`": "`",
  '"': '"',
  "“": "”",
};

/**
 * The grep terms a Docs sweep line quotes after `grep:` — each backticked or
 * double-quoted span, up to the first `;` outside a span (the next field).
 * Deduplicated case-insensitively, first spelling kept, capped at
 * `MAX_TERMS`.
 *
 * @param rawBody - The Docs sweep entry with backticks and quotes intact
 *   (`DocsSweepLine.rawBody`).
 */
export function extractGrepTerms(rawBody: string): string[] {
  return quotedTermsAfter(rawBody ?? "", GREP_LABEL_RE);
}

/** The `siblings:` field label (Issue #3371). */
const SIBLINGS_LABEL_RE = /\bsiblings?\s*:/i;

/** The honest negative a `siblings:` value opens with (Issue #3371). */
const SIBLINGS_NONE_RE = /^none\b/i;

/** Whitespace and quote marks skipped before a `siblings:` value is read. */
const LEADING_QUOTE_RE = /^[\s`"“”]+/;

/**
 * Whether a `siblings:` value (the text after its label) is the honest
 * `none — <why>` negative (Issue #3371). Leading whitespace, backticks and
 * straight or curly double quotes are skipped first, so `"none" — x` and
 * `“none” — x` are the negative too.
 */
export function isSiblingsNegative(value: string): boolean {
  return SIBLINGS_NONE_RE.test(value.replace(LEADING_QUOTE_RE, ""));
}

/**
 * The quoted terms after a field label: each backticked or double-quoted
 * span, up to the first `;` outside a span (the next field). Deduplicated
 * case-insensitively, first spelling kept, capped at `MAX_TERMS`; an empty
 * term or one longer than `MAX_TERM_CHARS` is skipped.
 */
function quotedTermsAfter(text: string, labelRe: RegExp): string[] {
  const label = text.match(labelRe);
  if (!label || label.index === undefined) return [];

  const terms: string[] = [];
  const seen = new Set<string>();
  let i = label.index + label[0].length;
  while (i < text.length && terms.length < MAX_TERMS) {
    const ch = text[i]!;
    if (ch === ";") break;
    const closing = CLOSING_QUOTE[ch];
    if (closing === undefined) {
      i++;
      continue;
    }
    const end = text.indexOf(closing, i + 1);
    if (end === -1) break;
    const term = text.slice(i + 1, end).trim();
    i = end + 1;
    if (term === "" || term.length > MAX_TERM_CHARS) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/**
 * The sibling terms a Docs sweep line quotes after `siblings:` (Issue #3371),
 * read exactly as `extractGrepTerms` reads `grep:`. Returns `[]` when the
 * value is the honest negative `siblings: none — <why>`, even if the reason
 * quotes a term.
 *
 * @param rawBody - The Docs sweep entry with backticks and quotes intact
 *   (`DocsSweepLine.rawBody`).
 */
export function extractSiblingTerms(rawBody: string): string[] {
  const text = rawBody ?? "";
  const label = text.match(SIBLINGS_LABEL_RE);
  if (!label || label.index === undefined) return [];
  if (isSiblingsNegative(text.slice(label.index + label[0].length))) return [];
  return quotedTermsAfter(text, SIBLINGS_LABEL_RE);
}

/**
 * The terms a Docs sweep line re-runs: its grep terms, then its sibling terms
 * (Issue #3371), deduplicated case-insensitively across both with the first
 * spelling kept. Each source is capped at `MAX_TERMS` on its own, so twenty
 * grep terms never crowd out the siblings.
 *
 * @param rawBody - The Docs sweep entry (`DocsSweepLine.rawBody`).
 */
export function extractSweepTerms(rawBody: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...extractGrepTerms(rawBody),
    ...extractSiblingTerms(rawBody),
  ];
  for (const term of candidates) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/**
 * A `file:line` or `file:start-end` reference to any file with an
 * extension — `docs/` can hold JSON, YAML or images as well as Markdown,
 * and the grep hits all of them. Bounded character classes only.
 */
const NAMED_LINE_RE =
  /([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]{1,10}):(\d{1,7})(?:\s?[-–]\s?(\d{1,7}))?/g;

/**
 * The lines a Docs sweep line names as left alone, by path, as inclusive
 * `[start, end]` ranges.
 */
export function extractNamedLines(
  rawBody: string,
): Map<string, Array<[number, number]>> {
  const named = new Map<string, Array<[number, number]>>();
  for (const match of (rawBody ?? "").matchAll(NAMED_LINE_RE)) {
    const path = match[1]!.replace(/^(?:\.\/)+/, "");
    const start = Number(match[2]);
    const end = match[3] === undefined ? start : Number(match[3]);
    const ranges = named.get(path) ?? [];
    ranges.push([Math.min(start, end), Math.max(start, end)]);
    named.set(path, ranges);
  }
  return named;
}

/** POSIX ERE metacharacters, each escaped in a literal term. */
const ERE_SPECIAL = new Set([
  "\\",
  ".",
  "[",
  "]",
  "(",
  ")",
  "{",
  "}",
  "*",
  "+",
  "?",
  "^",
  "$",
  "|",
]);

/**
 * A `git grep -E` pattern for a Docs sweep term: every character literal,
 * except a `\w*` or `\w+` stem marker, which matches a run of word
 * characters.
 */
export function termToGitGrepPattern(term: string): string {
  let out = "";
  let i = 0;
  while (i < term.length) {
    if (
      term[i] === "\\" && term[i + 1] === "w" &&
      (term[i + 2] === "*" || term[i + 2] === "+")
    ) {
      out += `[[:alnum:]_]${term[i + 2]}`;
      i += 3;
      continue;
    }
    const ch = term[i]!;
    out += ERE_SPECIAL.has(ch) ? `\\${ch}` : ch;
    i++;
  }
  return out;
}

/**
 * Parse `git grep -n -z <rev>` output: `<rev>:<path>\0<line>\0<text>` per
 * line. A line that does not have that shape throws — unread output is never
 * read as "no hits".
 */
export function parseGitGrepOutput(
  stdout: string,
  term: string,
): DocsSweepHit[] {
  const hits: DocsSweepHit[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw === "") continue;
    const parts = raw.split("\u0000");
    if (parts.length < 3) {
      throw new Error(`unexpected git grep output line: ${raw.slice(0, 80)}`);
    }
    const revPath = parts[0]!;
    const colon = revPath.indexOf(":");
    const path = colon === -1 ? revPath : revPath.slice(colon + 1);
    const line = Number(parts[1]);
    if (path === "" || !Number.isInteger(line) || line < 1) {
      throw new Error(`unexpected git grep output line: ${raw.slice(0, 80)}`);
    }
    hits.push({ path, line, text: parts.slice(2).join("\u0000"), term });
  }
  return hits;
}

/** A unified-diff hunk header's new-side start and optional count. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * The new-side line ranges each file's hunks added or changed, read from
 * `git diff --unified=0`. Every file the diff touches gets an entry, so a
 * file whose only change is a deletion maps to `[]`; a deleted file gets no
 * entry. A `+++` line counts as a file header only straight after a `---`
 * line, so an added line that itself starts with `++ ` is not read as one.
 * A hunk header with no file header before it throws.
 */
export function parseChangedLines(
  diff: string,
): Map<string, Array<[number, number]>> {
  const changed = new Map<string, Array<[number, number]>>();
  let current: string | null | undefined = undefined;
  let previous = "";
  for (const line of diff.split("\n")) {
    const afterOld = previous.startsWith("--- ");
    previous = line;
    if (afterOld && line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      current = target === "/dev/null"
        ? null
        : target.replace(/^"|"$/g, "").replace(/^b\//, "");
      if (current !== null && !changed.has(current)) changed.set(current, []);
      continue;
    }
    const hunk = line.match(HUNK_HEADER_RE);
    if (!hunk) continue;
    if (current === undefined) {
      throw new Error("diff hunk header with no file before it");
    }
    if (current === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    changed.get(current)!.push([start, start + count - 1]);
  }
  return changed;
}

/**
 * A term with more stale hits than this in doc files the diff did not touch
 * (or, counted apart, in source comment lines — Issue #3219) is a locator
 * word (a section name, a common verb), not a removed claim:
 * its hits in untouched files are not listed one by one, and the term is
 * reported as `broadTerms` for the caller to log as not checked line by
 * line. Its hits in files the diff touched are always listed — that is
 * where both incidents behind Issue #3172 sat.
 */
export const MAX_UNTOUCHED_HITS_PER_TERM = 10;

/** Set aside the untouched-file hits of a term too broad to list. */
function splitBroadTerms(
  staleHits: readonly DocsSweepHit[],
  changed: ReadonlyMap<string, unknown>,
): { staleHits: DocsSweepHit[]; broadTerms: string[] } {
  const untouchedPerTerm = new Map<string, number>();
  for (const hit of staleHits) {
    if (changed.has(hit.path)) continue;
    untouchedPerTerm.set(hit.term, (untouchedPerTerm.get(hit.term) ?? 0) + 1);
  }
  const broadTerms = [...untouchedPerTerm]
    .filter(([, count]) => count > MAX_UNTOUCHED_HITS_PER_TERM)
    .map(([term]) => term);
  const broad = new Set(broadTerms);
  return {
    staleHits: staleHits.filter((hit) =>
      changed.has(hit.path) || !broad.has(hit.term)
    ),
    broadTerms,
  };
}

/** Whether `line` falls in any of `ranges`. */
function inRanges(
  ranges: ReadonlyArray<[number, number]> | undefined,
  line: number,
): boolean {
  return (ranges ?? []).some(([start, end]) => line >= start && line <= end);
}

/** Read a git command's output, throwing on a non-zero exit. */
async function readGit(
  runGit: DocsSweepGitRunner,
  args: string[],
  okCodes: readonly number[],
): Promise<string> {
  const result = await runGit(args);
  if (!okCodes.includes(result.code)) {
    throw new Error(
      `git ${args[0]} exited ${result.code}: ${result.stderr.trim()}`,
    );
  }
  if (result.stdout.length > MAX_GIT_OUTPUT_CHARS) {
    throw new Error(`git ${args[0]} output exceeds the scan cap`);
  }
  return result.stdout;
}

/**
 * Re-run a Docs sweep line's grep and sibling terms (Issue #3371) over the
 * head's docs and the comment lines of its source files, and return the hits
 * the branch neither changed nor named as left alone. A sibling term's hit is
 * cleared or reported exactly as a grep term's is.
 *
 * @param opts.rawBody - The Docs sweep entry (`DocsSweepLine.rawBody`).
 * @param opts.base - The ref the branch's diff is taken against.
 * @param opts.runGit - Runs `git <args>` in the repository.
 */
export async function checkDocsSweepTerms(opts: {
  rawBody: string;
  base: string;
  runGit: DocsSweepGitRunner;
}): Promise<DocsSweepTermCheck> {
  const terms = extractSweepTerms(opts.rawBody);
  if (terms.length === 0) {
    return {
      status: "skipped",
      reason: "the Docs sweep line quotes no grep or sibling term",
    };
  }

  const grepHead = async (
    term: string,
    pathspecs: readonly string[],
  ): Promise<DocsSweepHit[]> =>
    parseGitGrepOutput(
      await readGit(opts.runGit, [
        "grep",
        "-n",
        "-z",
        "-I",
        "-i",
        "-E",
        "-e",
        termToGitGrepPattern(term),
        "HEAD",
        "--",
        ...pathspecs,
      ], [0, 1]),
      term,
    );

  try {
    const docHits: DocsSweepHit[] = [];
    const sourceHits: DocsSweepHit[] = [];
    for (const term of terms) {
      docHits.push(...await grepHead(term, DOCS_SWEEP_PATHSPECS));
      sourceHits.push(
        ...(await grepHead(term, SOURCE_COMMENT_PATHSPECS)).filter((hit) =>
          isSourceCommentLine(hit.text)
        ),
      );
    }
    if (docHits.length === 0 && sourceHits.length === 0) {
      return { status: "checked", terms, staleHits: [], broadTerms: [] };
    }

    const diff = await readGit(opts.runGit, [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=0",
      `${opts.base}...HEAD`,
      "--",
      ...DIFF_PATHSPECS,
    ], [0]);
    const changed = parseChangedLines(diff);
    const named = extractNamedLines(opts.rawBody);

    const seen = new Set<string>();
    const stale = (hits: readonly DocsSweepHit[]): DocsSweepHit[] =>
      hits.filter((hit) => {
        const key = `${hit.path}:${hit.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return !inRanges(changed.get(hit.path), hit.line) &&
          !inRanges(named.get(hit.path), hit.line);
      });
    // The broad-term cap is counted per surface, so a term common in source
    // comments never sets aside its hits in the docs (Issue #3219).
    const docs = splitBroadTerms(stale(docHits), changed);
    const source = splitBroadTerms(stale(sourceHits), changed);
    return {
      status: "checked",
      terms,
      staleHits: [...docs.staleHits, ...source.staleHits],
      broadTerms: [...new Set([...docs.broadTerms, ...source.broadTerms])],
    };
  } catch (err) {
    return {
      status: "not_checked",
      reason: `the Docs sweep terms could not be re-run (git grep/diff): ${
        err instanceof Error ? err.message : String(err)
      }`,
      terms,
    };
  }
}

/** Render a hit's sentence as an inert code span (no backticks, no mentions). */
function renderHitText(text: string): string {
  const flat = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_HIT_TEXT_CHARS
    ? `${flat.slice(0, MAX_HIT_TEXT_CHARS)}…`
    : flat;
}

/** The warning-log description of stale hits, naming the first few. */
export function describeDocsSweepHits(hits: readonly DocsSweepHit[]): string {
  const named = hits.slice(0, 5).map((h) => `${h.path}:${h.line}`).join(", ");
  const extra = hits.length - 5;
  return `the Docs sweep's own grep and sibling terms still hit ${hits.length} doc ` +
    `or source-comment line(s) outside the diff and not named as still true: ${named}${
      extra > 0 ? ` and ${extra} more` : ""
    }`;
}

/**
 * Build the PR comment posted for the reviewer when the Docs sweep's own
 * terms still hit lines the branch neither changed nor named. Advisory only
 * (Issue #3237): posted once, and the run completes regardless.
 */
export function buildDocsSweepHitsComment(
  hits: readonly DocsSweepHit[],
): string {
  const listed = hits.slice(0, MAX_REPORTED_HITS).map((hit) =>
    `- \`${hit.path}:${hit.line}\` — \`${renderHitText(hit.text)}\` ` +
    `(term: \`${renderHitText(hit.term)}\`)`
  );
  const extra = hits.length - MAX_REPORTED_HITS;
  if (extra > 0) listed.push(`- … and ${extra} more`);
  return [
    "ℹ️ **Docs sweep terms still hit the head (advisory).** Re-running the " +
    "grep and sibling terms this PR's **Docs sweep** line quotes over " +
    "`README.md`, " +
    "`*/README.md` and `docs/` (excluding `docs/archive/`), and over the " +
    "comment lines in source files outside `docs/`, at the head finds lines " +
    "the diff did not change and the line does not name:",
    "",
    ...listed,
    "",
    "These hits are advisory: they do not block this PR. Reviewer: check " +
    "each sentence is still true.",
    "",
    "To resolve one, either:",
    "",
    "1. fix it in this change, if the change makes it false — including in " +
    "a file whose other section was already updated; or",
    "2. name it in the Docs sweep line as `<file>:<line> — still true " +
    "because <reason>`.",
    "",
    "Grep for the stem of a behavioural claim, not one inflection " +
    '(`replac\\w* or remov\\w*`, not "replaces or removes"), and re-run the ' +
    "grep on the final head after editing.",
  ].join("\n");
}
