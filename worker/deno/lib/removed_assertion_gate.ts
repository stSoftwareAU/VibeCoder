/**
 * Removed-test-assertion gate for PR summaries (Issue #3131).
 *
 * The fleet's PR-summary contract already told the agent (#3061) to list
 * every assertion a diff removes from an *existing* test in the PR
 * summary's Test Plan, together with the issue requirement that makes the
 * old assertion untrue. That rule was prose only — nothing in the worker
 * checked it. GRQ-AutoTrader#2370 raised a PR with no `## Test Plan`
 * section at all and silently dropped a still-true per-day `BBB` row
 * assertion, and that PR reached milestone PR GRQ-AutoTrader#2376
 * unnoticed.
 *
 * This module is the deterministic gate for that rule. It applies whenever
 * the branch's changed-files list contains a test file (or could not be
 * read at all, which fails closed), and in that case requires the PR
 * summary to carry a `## Test Plan` heading. On top of that, every
 * assertion a diff removes from a test file must be named in that Test
 * Plan — unless it was simply moved: re-wrapped, re-indented or relocated
 * with the same text and the same guards, skips and early exits around it
 * (see {@link findRemovedAssertions}). An edit to any line of a multi-line
 * assertion, or a copy re-added under a new `if`, into a skipped test or
 * after a new `return`, is a removal.
 *
 * Modelled on `docs_sweep_gate.ts`: pure functions only, hardcoded regexes
 * (never `new RegExp()` built from input), and bounded scans throughout —
 * the diff and the PR summary are both agent-authored / untrusted text, so
 * both are treated as untrusted here. Every scan is linear-time by
 * construction: no nested unbounded quantifiers, and paren-depth counting
 * is a manual character loop rather than a regex.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isTestFilePath } from "./security_fix_gate.ts";
import { codeFenceFor, scrubUntrustedText } from "./prompt_delimiter.ts";

/**
 * Cap on the diff text scanned (defence in depth; untrusted input). Exported
 * so a caller that reads the patch itself (`completion_phase.ts`) can detect
 * a patch at or past the cap and treat it as unreadable, rather than letting
 * this module silently scan only the first `MAX_DIFF_CHARS` of it.
 */
export const MAX_DIFF_CHARS = 8_000_000;

/**
 * Lines of context `removedAssertionDiffArgs` asks git for (Issue #3131
 * review). Enough that every test file's patch is one hunk holding the whole
 * old file and the whole new file, so a multi-line assertion is always seen
 * whole and the guards around it are always visible. A hunk can leave part
 * of a file out only when the file has more than 4,000,000 lines, and then
 * its context lines alone (at least two characters each) reach
 * {@link MAX_DIFF_CHARS}, so the caller already treats that patch as
 * unreadable rather than scanning part of it.
 */
export const REMOVED_ASSERTION_CONTEXT_LINES = 4_000_000;

/** Cap on a single diff line scanned for an assertion match. */
const MAX_LINE_CHARS = 4_000;

/** Cap on a removed assertion's canonical form. */
const MAX_CANONICAL_CHARS = 2_000;

/**
 * Cap on how many lines a single assertion statement can span. A statement
 * still open at the cap is "unclosed": the gate cannot tell where it ends, so
 * it is reported as removed whenever the file changes at or after its start.
 */
const MAX_STATEMENT_LINES = 200;

/**
 * Cap on early exits named in an assertion's key (the innermost ones). Past
 * it the key also carries their count, so a change in how many there are
 * still shows.
 */
const MAX_KEYED_EXITS = 32;

/**
 * Cap on lines walked back over the enclosing blocks' preceding siblings,
 * shared by all of one assertion's enclosing blocks.
 */
const MAX_SIBLING_WALK_LINES = 400;

/**
 * Cap on enclosing lines kept per assertion (the innermost ones). Deeper
 * nesting than this is hostile or generated input; the assertion's key then
 * carries a marker, so it matches only an identically nested copy.
 */
const MAX_NESTING = 128;

/** Cap on a removed assertion's display text. */
const MAX_DISPLAY_CHARS = 300;

/** Cap on the PR summary text scanned for the Test Plan section. */
const MAX_SUMMARY_SCAN_CHARS = 200_000;

/** `git diff` args listing both sides of every rename, unquoted (`-z`). */
export function removedAssertionRenameSidesArgs(base: string): string[] {
  return [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    `${base}...HEAD`,
  ];
}

/**
 * Test files from a NUL-separated `--no-renames` name list.
 *
 * `-z` leaves paths unquoted, so a non-ASCII path is a real pathspec. Both
 * sides of a rename are kept. Blank segments from the trailing NUL are
 * dropped.
 */
export function testFilesFromRenameSidesList(stdout: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const path of stdout.split("\0")) {
    if (!isTestFilePath(path) || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

/**
 * Rename pairs for the pathspec: `-z` so paths are unquoted, and
 * `--find-renames` so a rename is one record with both paths.
 */
export function removedAssertionRenameStatusArgs(base: string): string[] {
  return [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    `${base}...HEAD`,
  ];
}

/** Pathspec and test-file sides parsed from {@link removedAssertionRenameStatusArgs}. */
export interface RenameStatusPaths {
  /** Both sides when either is a test file, so `--find-renames` can pair them. */
  pathspec: string[];
  /** Sides that are test files. These decide whether the gate applies. */
  testFiles: string[];
}

/**
 * Parse `git diff --name-status -z`. A rename or copy whose old or new path
 * is a test file contributes both paths to the pathspec. A quoted
 * `--name-only` list is not used: it hides a non-ASCII path and a rename
 * whose only test-file side is the old name.
 */
export function pathsFromRenameStatus(stdout: string): RenameStatusPaths {
  const parts = stdout.split("\0");
  const pathspec: string[] = [];
  const testFiles: string[] = [];
  const seenSpec = new Set<string>();
  const seenTest = new Set<string>();
  const addSpec = (path: string) => {
    if (!path || seenSpec.has(path)) return;
    seenSpec.add(path);
    pathspec.push(path);
  };
  const addTest = (path: string) => {
    if (!isTestFilePath(path) || seenTest.has(path)) return;
    seenTest.add(path);
    testFiles.push(path);
  };

  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (!status) break;
    i++;
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = parts[i] ?? "";
      const newPath = parts[i + 1] ?? "";
      i += 2;
      if (isTestFilePath(oldPath) || isTestFilePath(newPath)) {
        addSpec(oldPath);
        addSpec(newPath);
        addTest(oldPath);
        addTest(newPath);
      }
      continue;
    }
    const path = parts[i] ?? "";
    i++;
    if (isTestFilePath(path)) {
      addSpec(path);
      addTest(path);
    }
  }

  return { pathspec, testFiles };
}

/**
 * `git diff` args for the test-file patch this gate reads (single source of
 * truth). The patch carries whole-file context
 * ({@link REMOVED_ASSERTION_CONTEXT_LINES}), so each test file is one hunk
 * holding its whole old and new side: a multi-line assertion whose inner
 * line changed is compared whole, and the guards and skips around a
 * re-added assertion are visible. `--diff-filter=AMRD` includes deletions:
 * a deleted test file (or one renamed and rewritten below git's
 * rename-similarity threshold, which git reports as a delete plus an add)
 * must still surface its removed assertions, not just the heading rule.
 *
 * `testFiles`, when given and non-empty, scopes the diff to those paths via
 * a `--` pathspec so this never has to read the whole branch diff. The
 * caller must pass both sides of every rename
 * ({@link removedAssertionRenameSidesArgs}): a pathspec of only the new
 * name makes `--find-renames` show a brand-new file and hide the removed
 * lines. The paths are attacker-controlled (the branch under review), so
 * they are placed after a literal `--` and never shell-expanded (this runs
 * through `runGitCommand`'s argv, not a shell).
 */
export function removedAssertionDiffArgs(
  base: string,
  testFiles?: readonly string[],
): string[] {
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    `--unified=${REMOVED_ASSERTION_CONTEXT_LINES}`,
    "--find-renames",
    "--diff-filter=AMRD",
    `${base}...HEAD`,
  ];
  if (testFiles && testFiles.length > 0) {
    args.push("--", ...testFiles);
  }
  return args;
}

/** A removed assertion statement found in an existing test file's diff. */
export interface RemovedAssertion {
  /** Repo-relative path of the test file (the new path for a rename). */
  file: string;
  /** Display form: statement lines trimmed, joined with single spaces, capped. */
  text: string;
  /** Canonical form used for matching (see {@link canonicalise}). */
  canonical: string;
}

/** A line starting a new file's diff header. */
const DIFF_HEADER_RE = /^diff --git /;

/** The `--- <old path>` header line, only matched while in header mode. */
const OLD_PATH_HEADER_RE = /^--- (.*)$/;

/** The `+++ <new path>` header line, only matched while in header mode. */
const NEW_PATH_HEADER_RE = /^\+\+\+ (.*)$/;

/** A hunk header, e.g. `@@ -1,2 +1,2 @@`. */
const HUNK_RE = /^@@/;

/** The "no trailing newline" marker, ignored as neither header nor content. */
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/**
 * An assertion-opening statement across this fleet's ecosystems: `assert(`,
 * `assertEquals(`, `assert_eq!(`, `assert!(`, `self.assertEqual(`,
 * `assert.equal(`, Jest `expect(`, Python bare `assert x`, and bats
 * `assert_success`. Excludes `debug_assert!` (no `\b` before `assert` after
 * `debug_`) and Rust `.expect("msg")` (the negative lookbehind on `expect`).
 */
const ASSERTION_START_RE =
  /\bassert(?:\w*!?|\.\w+)\s*\(|(?<![.\w])expect\s*\(|^\s*assert(?:_\w+)?(?:\s|$)/;

/** Whether a trimmed line is a comment, so it cannot open an assertion. */
function isCommentLine(trimmed: string): boolean {
  if (
    trimmed.startsWith("//") || trimmed.startsWith("/*") ||
    trimmed.startsWith("*")
  ) {
    return true;
  }
  return trimmed.startsWith("#") && trimmed[1] !== "[";
}

/** Strip a surrounding quote pair, then an `a/`/`b/` prefix, from a diff path. */
function parseDiffPath(raw: string): string {
  let path = raw.trim();
  if (path === "/dev/null") return path;
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  if (path.startsWith("a/") || path.startsWith("b/")) {
    path = path.slice(2);
  }
  return path;
}

/** Running paren depth contributed by a single line, counted with a char loop. */
function parenDelta(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth;
}

/**
 * Whitespace-free form of a statement: whitespace removed, a comma deleted
 * when it directly precedes `)`, `]` or `}`, and trailing `;`/`,` stripped by
 * a manual loop (never a backtracking regex). Not capped: this is the form
 * two copies of an assertion are compared on, so a difference past any cap
 * must still count.
 */
function canonicaliseUncapped(statement: string): string {
  let result = statement.replace(/\s+/g, "");
  result = result.replace(/,(?=[)\]}])/g, "");
  let end = result.length;
  while (end > 0 && (result[end - 1] === ";" || result[end - 1] === ",")) {
    end--;
  }
  return result.slice(0, end);
}

/**
 * Canonical form of a statement for Test Plan matching:
 * {@link canonicaliseUncapped}, capped at {@link MAX_CANONICAL_CHARS}.
 */
function canonicalise(statement: string): string {
  const result = canonicaliseUncapped(statement);
  return result.length > MAX_CANONICAL_CHARS
    ? result.slice(0, MAX_CANONICAL_CHARS)
    : result;
}

/** A removed or added content block: consecutive `-`/`+` lines in one hunk. */
interface DiffBlock {
  file: string;
  lines: string[];
  /** Index in the file's old side of the block's first line (removed blocks). */
  start: number;
}

/** One line of a file's old or new side, as rebuilt from its patch. */
interface SideLine {
  raw: string;
  /** True for a `-` line on the old side or a `+` line on the new side. */
  changed: boolean;
  /** Position of the line in the patch, shared by both sides. */
  seq: number;
}

/** A test file's patch, rebuilt into its old and new sides. */
interface FilePatch {
  file: string;
  lang: Lang;
  oldLines: SideLine[];
  newLines: SideLine[];
  removedBlocks: DiffBlock[];
  addedBlocks: DiffBlock[];
  /** `seq` of the last `-`/`+` line in the patch, or -1 when none. */
  lastChangeSeq: number;
}

/**
 * Parse a unified diff into the test files it touches, each with its old
 * and new side and its removed and added blocks. Header lines (`--- `/`+++ `)
 * are only read while in header mode, so a hunk line like `-- comment`
 * (rendered `--- comment`) is never mistaken for a file header.
 */
function parseTestFilePatches(diffText: string): FilePatch[] {
  const text = (diffText ?? "").slice(0, MAX_DIFF_CHARS);
  const lines = text.split(/\r\n|\n/);

  const patches: FilePatch[] = [];

  let oldPath: string | null = null;
  let newPath: string | null = null;
  let isTestFile = false;
  let inHeader = false;
  let inHunk = false;
  let patch: FilePatch | null = null;
  let seq = 0;

  let removedBlock: string[] = [];
  let removedStart = 0;
  let addedBlock: string[] = [];

  const currentFile = () =>
    newPath !== null && newPath !== "/dev/null" ? newPath : (oldPath ?? "");

  const flushRemoved = () => {
    if (removedBlock.length > 0 && patch) {
      patch.removedBlocks.push({
        file: patch.file,
        lines: removedBlock,
        start: removedStart,
      });
    }
    removedBlock = [];
  };
  const flushAdded = () => {
    if (addedBlock.length > 0 && patch) {
      patch.addedBlocks.push({ file: patch.file, lines: addedBlock, start: 0 });
    }
    addedBlock = [];
  };
  const startPatch = () => {
    if (patch || !isTestFile) return;
    const file = currentFile();
    patch = {
      file,
      lang: langFor(file),
      oldLines: [],
      newLines: [],
      removedBlocks: [],
      addedBlocks: [],
      lastChangeSeq: -1,
    };
    patches.push(patch);
  };

  for (const line of lines) {
    if (DIFF_HEADER_RE.test(line)) {
      flushRemoved();
      flushAdded();
      oldPath = null;
      newPath = null;
      isTestFile = false;
      inHeader = true;
      inHunk = false;
      patch = null;
      seq = 0;
      continue;
    }

    if (inHeader) {
      const oldMatch = line.match(OLD_PATH_HEADER_RE);
      if (oldMatch) {
        oldPath = parseDiffPath(oldMatch[1] ?? "");
        continue;
      }
      const newMatch = line.match(NEW_PATH_HEADER_RE);
      if (newMatch) {
        newPath = parseDiffPath(newMatch[1] ?? "");
        isTestFile = (newPath !== "/dev/null" && isTestFilePath(newPath)) ||
          (oldPath !== null && oldPath !== "/dev/null" &&
            isTestFilePath(oldPath));
        continue;
      }
      if (HUNK_RE.test(line)) {
        inHeader = false;
        inHunk = true;
        flushRemoved();
        flushAdded();
        startPatch();
      }
      continue;
    }

    if (HUNK_RE.test(line)) {
      flushRemoved();
      flushAdded();
      inHunk = true;
      startPatch();
      continue;
    }

    if (!inHunk || !patch) continue;
    const current: FilePatch = patch;

    if (line.startsWith(NO_NEWLINE_MARKER)) {
      continue;
    }

    if (line.startsWith("-")) {
      flushAdded();
      if (removedBlock.length === 0) removedStart = current.oldLines.length;
      removedBlock.push(line.slice(1));
      current.oldLines.push({ raw: line.slice(1), changed: true, seq });
      current.lastChangeSeq = seq;
      seq++;
      continue;
    }
    if (line.startsWith("+")) {
      flushRemoved();
      addedBlock.push(line.slice(1));
      current.newLines.push({ raw: line.slice(1), changed: true, seq });
      current.lastChangeSeq = seq;
      seq++;
      continue;
    }

    flushRemoved();
    flushAdded();
    if (line.startsWith(" ")) {
      const raw = line.slice(1);
      current.oldLines.push({ raw, changed: false, seq });
      current.newLines.push({ raw, changed: false, seq });
      seq++;
    }
  }
  flushRemoved();
  flushAdded();

  return patches;
}

// ---------------------------------------------------------------------------
// Source lexing — blank out comments and string contents before matching
// (CODING-STANDARDS.md § Writing a gate over text: "A gate that reads source
// code blanks out comments and literals before it matches").
// ---------------------------------------------------------------------------

/** Comment and string rules a test file is lexed with. */
type Lang = "rust" | "python" | "shell" | "c";

/** File extensions whose comments start with `#`, by language. */
const PYTHON_EXT_RE = /\.pyi?$/i;
const SHELL_EXT_RE = /\.(?:sh|bash|bats|zsh|rb)$/i;
const RUST_EXT_RE = /\.rs$/i;

/** The lexing rules for a test file, chosen by its extension. */
function langFor(path: string): Lang {
  if (RUST_EXT_RE.test(path)) return "rust";
  if (PYTHON_EXT_RE.test(path)) return "python";
  if (SHELL_EXT_RE.test(path)) return "shell";
  return "c";
}

/** One lexed line of a side. */
interface LexedLine {
  /** The line with comments and string contents replaced by spaces. */
  code: string;
  /** The line with comments removed and strings kept. */
  stripped: string;
  /** True when the line holds a comment and nothing else. */
  commentOnly: boolean;
  /**
   * True when the line began inside a string or block comment carried over
   * from an earlier line — the one case where a lexer mistake (a regex
   * literal holding a quote, say) can hide a whole line.
   */
  startsInside: boolean;
}

/** An open string literal carried between characters (and lines). */
interface OpenString {
  close: string;
  escapes: boolean;
  multiline: boolean;
}

/** Whether `ch` can be part of an identifier. */
function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

/**
 * Lex a side's lines with a manual character loop (linear time, no regex
 * over the whole text). Line comments, block comments and string contents
 * are blanked in `code`; comments alone are removed in `stripped`.
 * Lexing is a heuristic — a regex literal or an exotic string form can
 * mislead it — so {@link findRemovedAssertions} keeps the raw-line scan of
 * removed lines as a backstop for any assertion line it hides.
 */
function lexLines(lines: readonly SideLine[], lang: Lang): LexedLine[] {
  const out: LexedLine[] = [];
  let inBlockComment = false;
  let open: OpenString | null = null;
  const slashComments = lang === "rust" || lang === "c";

  for (const { raw } of lines) {
    let code = "";
    let stripped = "";
    const startsInside = inBlockComment || open !== null;
    let sawComment = inBlockComment;
    let sawCode = false;
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i]!;
      if (inBlockComment) {
        if (ch === "*" && raw[i + 1] === "/") {
          inBlockComment = false;
          code += "  ";
          i += 2;
        } else {
          code += " ";
          i++;
        }
        continue;
      }
      if (open) {
        sawCode = true;
        if (open.escapes && ch === "\\") {
          code += "  ";
          stripped += raw.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (raw.startsWith(open.close, i)) {
          code += open.close;
          stripped += open.close;
          i += open.close.length;
          open = null;
          continue;
        }
        code += " ";
        stripped += ch;
        i++;
        continue;
      }
      if (slashComments && ch === "/" && raw[i + 1] === "/") {
        sawComment = true;
        break;
      }
      if (slashComments && ch === "/" && raw[i + 1] === "*") {
        sawComment = true;
        inBlockComment = true;
        code += "  ";
        i += 2;
        continue;
      }
      if (
        ch === "#" && (lang === "python" ||
          (lang === "shell" && (i === 0 || /\s/.test(raw[i - 1]!))))
      ) {
        sawComment = true;
        break;
      }
      const opened = openStringAt(raw, i, lang);
      if (opened) {
        sawCode = true;
        code += raw.slice(i, i + opened.length);
        stripped += raw.slice(i, i + opened.length);
        i += opened.length;
        open = opened.string;
        continue;
      }
      if (!/\s/.test(ch)) sawCode = true;
      code += ch;
      stripped += ch;
      i++;
    }
    if (open && !open.multiline) open = null;
    out.push({
      code,
      stripped,
      commentOnly: sawComment && !sawCode,
      startsInside,
    });
  }
  return out;
}

/** A string literal opening at `raw[i]`: how many chars open it, and its rules. */
function openStringAt(
  raw: string,
  i: number,
  lang: Lang,
): { length: number; string: OpenString } | null {
  const ch = raw[i]!;
  if (lang === "python") {
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3);
      if (raw.startsWith(triple, i)) {
        return {
          length: 3,
          string: { close: triple, escapes: true, multiline: true },
        };
      }
      return {
        length: 1,
        string: { close: ch, escapes: true, multiline: false },
      };
    }
    return null;
  }
  if (lang === "shell") {
    if (ch === '"' || ch === "'") {
      return {
        length: 1,
        string: { close: ch, escapes: ch === '"', multiline: false },
      };
    }
    return null;
  }
  if (lang === "rust") {
    if ((ch === "r" || ch === "b") && !isIdentChar(raw[i - 1])) {
      // Raw string: r"…", r#"…"#, br#"…"#.
      let j = i + (ch === "b" && raw[i + 1] === "r" ? 2 : 1);
      if (ch === "b" && raw[i + 1] !== "r") return null;
      let hashes = 0;
      while (raw[j] === "#") {
        hashes++;
        j++;
      }
      if (raw[j] === '"') {
        return {
          length: j - i + 1,
          string: {
            close: '"' + "#".repeat(hashes),
            escapes: false,
            multiline: true,
          },
        };
      }
      return null;
    }
    if (ch === '"') {
      return {
        length: 1,
        string: { close: '"', escapes: true, multiline: true },
      };
    }
    if (ch === "'") {
      // A char literal ('x', '\n', '\u{1F600}'), not a lifetime ('a).
      if (raw[i + 1] === "\\") {
        const close = raw.indexOf("'", i + 2);
        if (close !== -1 && close - i <= 12) {
          return {
            length: 1,
            string: { close: "'", escapes: true, multiline: false },
          };
        }
        return null;
      }
      if (raw[i + 2] === "'") {
        return {
          length: 1,
          string: { close: "'", escapes: true, multiline: false },
        };
      }
      return null;
    }
    return null;
  }
  // C-like: TypeScript, JavaScript, Go, Java, Kotlin, C#, Swift…
  if (ch === '"' || ch === "'") {
    return {
      length: 1,
      string: { close: ch, escapes: true, multiline: false },
    };
  }
  if (ch === "`") {
    return {
      length: 1,
      string: { close: "`", escapes: true, multiline: true },
    };
  }
  return null;
}

/** Net bracket depth (`(`, `[`, `{`) a lexed line adds, by a char loop. */
function bracketDelta(code: string): number {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  return depth;
}

/** Count of leading whitespace characters. */
function indentOf(raw: string): number {
  let i = 0;
  while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) i++;
  return i;
}

// ---------------------------------------------------------------------------
// What surrounds an assertion (Issue #3131 review: an assertion re-added
// under a new guard or into a skipped test is not "moved").
// ---------------------------------------------------------------------------

/**
 * A declaration that only names a scope: a function, class or module, or a
 * test or test group (`Deno.test(`, `it(`, `describe(`, `t.step(`, `t.Run(`,
 * bats `@test`, Ruby `it "x" do`). An enclosing line that is NOT one of these
 * — an `if`/`else`/`match`/loop, a `with`/`try`, a callback such as
 * `.forEach(` or a wrapper helper — can stop the assertion from running, so
 * it is part of the assertion's context.
 */
const DECL_RE =
  /^(?:(?:pub(?:\([\w:\s]*\))?|export|default|async|unsafe|static|private|public|protected|override|extern|abstract|final|open|internal|suspend)\s+)*(?:fn|def|func|function\*?|class|mod|impl|trait|struct|enum|interface|namespace|module|object)\b/;

/**
 * A function declaration, capturing its name: `fn`, `def`, `func` (with a Go
 * receiver), `function`.
 */
const FN_DECL_RE =
  /^(?:(?:pub(?:\([\w:\s]*\))?|export|default|async|unsafe|static|private|public|protected|override|extern|abstract|final|open|internal|suspend)\s+)*(?:fn|def|func|function\*?)\b\s*(?:\([^()]*\)\s*)?([\w$]*)/;

/** A type, module or namespace declaration: it names a scope and nothing else. */
const TYPE_DECL_RE =
  /^(?:(?:pub(?:\([\w:\s]*\))?|export|default|async|unsafe|static|private|public|protected|override|extern|abstract|final|open|internal|suspend)\s+)*(?:class|mod|impl|trait|struct|enum|interface|namespace|module|object)\b/;

/** A Rust test attribute: `#[test]`, `#[tokio::test]`, `#[rstest]`. */
const RUST_TEST_ATTR_RE = /^#\[[\w:]*test\b/;

/** A test or test-group declaration (with `.only`/`.each`/`.skip` etc.). */
const TEST_DECL_RE =
  /^(?:await\s+)?(?:Deno\.test|it|test|describe|context|suite|specify|bench|t\.(?:step|test|run|Run)|\w+\.(?:step|Run))(?:\.(?:only|each|concurrent|sequential|serial|skip|ignore|todo|fixme))*\s*[(`]|^@test\b|^(?:it|describe|context|specify|test)\s+["']/;

/**
 * A skip marker: a skipped or ignored test (`it.skip(`, `Deno.test.ignore(`,
 * `xit(`, `ignore: true`), an attribute or decorator that skips or inverts a
 * test (`#[ignore]`, `#[should_panic]`, a non-test `#[cfg(…)]`,
 * `@pytest.mark.skip`, `@unittest.skip`, `@Disabled`), or `pytestmark`.
 */
const SKIP_RE =
  /\.(?:skip|ignore|todo|fixme)\b|\b(?:xit|xdescribe|xtest|xcontext|xspecify)\s*\(|\b(?:ignore|skip)\s*:\s*(?!false\b)\S|#!?\[\s*(?:ignore|should_panic)\b|#!?\[\s*cfg\s*\((?!\s*test\s*\))|@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.(?:skip\w*|expectedFailure)|skip\w*|Disabled|Ignore)\b|\bpytestmark\b/;

/** A file-level skip: `pytestmark`, a module-level `pytest.skip(`, `#![cfg(…)]`. */
const FILE_SKIP_RE =
  /^(?:pytestmark\b|pytest\.skip\s*\(|#!\[\s*cfg\s*\((?!\s*test\s*\))|#!\[\s*ignore\b)/;

/**
 * An early exit or skip that can stop the lines after it from running:
 * `return`, `continue`, `break`, `throw`, `raise`, `panic!`, `todo!`,
 * `pytest.skip(`, `self.skipTest(`, `t.Skip(`, `this.skip(`, `Deno.exit(`.
 */
const EXIT_RE =
  /(?:^|[^\w$.])(?:return|continue|break|throw|raise)\b|\b(?:panic|unreachable|todo|unimplemented)!|(?:\bpytest\.skip|\bself\.skipTest|\bt\.Skip(?:Now|f)?|\b(?:t|ctx|this|test)\.skip|\b(?:Deno|process|sys)\.exit|\bos\.Exit)\s*\(|^\s*skip\b/;

/**
 * A closure or function opened earlier on the same line, so an exit after it
 * leaves only that closure (`const f = () => { return 1; }`, `|x| { … }`).
 */
const SAME_LINE_CLOSURE_RE =
  /=>|\bfunction\b|\blambda\b|\bfn\s*\(|\|[^|\s][^|]*\||\|\|\s*\{/;

/** Whether a lexed line holds an exit that leaves the enclosing block. */
function isExitLine(code: string): boolean {
  const capped = code.length > MAX_LINE_CHARS
    ? code.slice(0, MAX_LINE_CHARS)
    : code;
  const match = capped.match(EXIT_RE);
  if (!match) return false;
  const before = capped.slice(0, match.index ?? 0);
  return !SAME_LINE_CLOSURE_RE.test(before);
}

/** Whether a lexed, trimmed line declares a function, class, module or test. */
function isDeclLine(trimmedCode: string): boolean {
  return DECL_RE.test(trimmedCode) || TEST_DECL_RE.test(trimmedCode);
}

/**
 * A bare callback opener on its own line — `async () => {`,
 * `(t) => {`, `function () {` — as `deno fmt` lays out the body of a
 * `Deno.test(` / `it(` call whose name sits on the line before.
 */
const CALLBACK_OPENER_RE =
  /^(?:async\s+)?(?:\([^()]*\)|[\w$]+)\s*(?::\s*[\w$.<>[\], ]+)?=>\s*\{$|^(?:async\s+)?function\s*\*?\s*\([^()]*\)\s*\{$/;

/** An assertion statement found on one side of a test file's patch. */
interface SideStatement {
  /** Index of the statement's first and last line on its side. */
  start: number;
  end: number;
  /** Display form and capped canonical, as in {@link RemovedAssertion}. */
  text: string;
  canonical: string;
  /**
   * Comparison key: the uncapped canonical plus the statement's context —
   * the guards and skips around it and the early exits before it. Two
   * copies of an assertion are the same only when both match.
   */
  key: string;
  /** True when the statement's brackets never closed within the cap. */
  unclosed: boolean;
}

/**
 * Per-line classification of one side, each computed at most once, so the
 * scans back from every assertion are array lookups rather than repeated
 * regex runs (linear time on many assertions in one long test).
 */
class LineFacts {
  readonly #lexed: readonly LexedLine[];
  readonly #flags = new Map<string, Uint8Array>();
  readonly #keys: (string | undefined)[] = [];

  constructor(lexed: readonly LexedLine[]) {
    this.#lexed = lexed;
  }

  #flag(name: string, i: number, test: (trimmed: string) => boolean) {
    let flags = this.#flags.get(name);
    if (!flags) {
      flags = new Uint8Array(this.#lexed.length);
      this.#flags.set(name, flags);
    }
    if (flags[i] === 0) {
      flags[i] = test(this.trimmed(i)) ? 2 : 1;
    }
    return flags[i] === 2;
  }

  /** The lexed line, trimmed and capped for regex matching. */
  trimmed(i: number): string {
    return capLine(this.#lexed[i]!.code.trim());
  }
  exit(i: number): boolean {
    return this.#flag("exit", i, isExitLine);
  }
  skip(i: number): boolean {
    return this.#flag("skip", i, (t) => SKIP_RE.test(t));
  }
  decl(i: number): boolean {
    return this.#flag("decl", i, isDeclLine);
  }
  testDecl(i: number): boolean {
    return this.#flag("testDecl", i, (t) => TEST_DECL_RE.test(t));
  }
  callback(i: number): boolean {
    return this.#flag("callback", i, (t) => CALLBACK_OPENER_RE.test(t));
  }
  /**
   * Whether line `i`, enclosing an assertion, only names its scope: a test
   * or test group, a type or module, a function that is a test (named
   * `test…`, or carrying a Rust test attribute), or the body of a test
   * declared on `parent` (`async () => {`, `fn() {`). Any other function is
   * a helper that may never be called, so it is part of the context.
   */
  scope(i: number, parent: number): boolean {
    return this.#flag("scope", i, (t) => {
      if (TEST_DECL_RE.test(t) || TYPE_DECL_RE.test(t)) return true;
      const parentIsTest = parent >= 0 && this.testDecl(parent);
      const fn = t.match(FN_DECL_RE);
      if (fn) {
        const name = fn[1] ?? "";
        if (/^test/i.test(name)) return true;
        if (name === "" && parentIsTest) return true;
        return this.#hasRustTestAttr(i);
      }
      return parentIsTest && this.callback(i);
    });
  }
  #hasRustTestAttr(i: number): boolean {
    for (let s = i - 1; s >= 0 && i - s <= 16; s--) {
      const t = this.trimmed(s);
      if (t === "") continue;
      if (!t.startsWith("#[")) return false;
      if (RUST_TEST_ATTR_RE.test(t)) return true;
    }
    return false;
  }
  /** Whitespace-free form of the line with comments removed. */
  key(i: number): string {
    return this.#keys[i] ??= canonicaliseUncapped(this.#lexed[i]!.stripped);
  }
}

/** Capped lexed text a regex is run on. */
function capLine(code: string): string {
  return code.length > MAX_LINE_CHARS ? code.slice(0, MAX_LINE_CHARS) : code;
}

/**
 * Every assertion statement on one side of a test file, each with its
 * comparison key. A single forward pass keeps two stacks of enclosing
 * lines — by indentation (Python, and formatted code anywhere) and by open
 * `{` (unformatted brace code) — and an assertion's enclosing lines are the
 * union of both, so a guard is seen whichever way the code is laid out.
 */
function analyseSide(
  lines: readonly SideLine[],
  lang: Lang,
): { statements: SideStatement[]; lexed: LexedLine[] } {
  const lexed = lexLines(lines, lang);
  const n = lines.length;
  const statements: SideStatement[] = [];

  const fileMarks: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = lexed[i]!.code;
    if (indentOf(lines[i]!.raw) !== 0) continue;
    if (FILE_SKIP_RE.test(capLine(code.trim()))) {
      fileMarks.push("F:" + canonicaliseUncapped(lexed[i]!.stripped));
    }
  }

  const facts = new LineFacts(lexed);
  /** Indices of the exit lines seen so far, ascending. */
  const exitLines: number[] = [];
  const indentStack: number[] = [];
  const braceStack: number[] = [];
  let statementEnd = -1;

  for (let i = 0; i < n; i++) {
    const code = lexed[i]!.code;
    if (code.trim() === "") continue;
    // A line that begins inside a multi-line string or block comment has
    // string or comment text for indentation, so it is kept out of the
    // indentation stack; its braces after the string closes still count.
    const indented = !lexed[i]!.startsInside;
    const indent = indentOf(lines[i]!.raw);
    while (
      indented && indentStack.length > 0 &&
      indentOf(lines[indentStack[indentStack.length - 1]!]!.raw) >= indent
    ) {
      indentStack.pop();
    }

    // A declaration named `assert…` (`function assertNoEscalation(…) {`)
    // is a helper, not an assertion: the assertions in its body are
    // tracked one by one.
    if (
      i > statementEnd && ASSERTION_START_RE.test(capLine(code)) &&
      !facts.decl(i)
    ) {
      const deep = indentStack.length > MAX_NESTING ||
        braceStack.length > MAX_NESTING;
      const ancestors = [
        ...new Set([
          ...indentStack.slice(-MAX_NESTING),
          ...braceStack.slice(-MAX_NESTING),
        ]),
      ].sort((a, b) => a - b);
      const statement = buildStatement(
        lines,
        lexed,
        facts,
        exitLines,
        i,
        ancestors,
        deep ? [...fileMarks, "N:…"] : fileMarks,
      );
      statements.push(statement);
      statementEnd = statement.end;
    }

    if (indented) indentStack.push(i);
    if (facts.exit(i)) exitLines.push(i);
    for (let c = 0; c < code.length; c++) {
      if (code[c] === "{") braceStack.push(i);
      else if (code[c] === "}") braceStack.pop();
    }
  }
  return { statements, lexed };
}

/** Build the statement starting at line `start`, with its context key. */
function buildStatement(
  lines: readonly SideLine[],
  lexed: readonly LexedLine[],
  facts: LineFacts,
  exitLines: readonly number[],
  start: number,
  ancestors: readonly number[],
  fileMarks: readonly string[],
): SideStatement {
  // The statement runs until its brackets close (or, for a Python line
  // ending in `\`, past the continuation).
  let depth = bracketDelta(lexed[start]!.code);
  let continued = lexed[start]!.stripped.trimEnd().endsWith("\\");
  let end = start;
  while (
    (depth > 0 || continued) && end + 1 < lines.length &&
    end - start + 1 < MAX_STATEMENT_LINES
  ) {
    end++;
    depth += bracketDelta(lexed[end]!.code);
    continued = lexed[end]!.stripped.trimEnd().endsWith("\\");
  }
  const unclosed = depth > 0 || continued;

  const parts: string[] = [];
  for (let i = start; i <= end; i++) {
    if (lexed[i]!.commentOnly) continue;
    const trimmed = lexed[i]!.stripped.trim();
    if (trimmed !== "") parts.push(trimmed);
  }
  const joined = parts.join(" ");
  let display = joined;
  if (display.length > MAX_DISPLAY_CHARS) {
    display = display.slice(0, MAX_DISPLAY_CHARS) + "…";
  }

  const context: string[] = [...fileMarks];
  let scopeStart = -1;
  let walked = 0;
  for (let k = 0; k < ancestors.length; k++) {
    const a = ancestors[k]!;
    const isSkip = facts.skip(a);
    const isDecl = facts.scope(a, k > 0 ? ancestors[k - 1]! : -1);
    if (isSkip) context.push("S:" + facts.key(a));
    else if (!isDecl) context.push("G:" + facts.key(a));
    // Early exits are scanned from the innermost function of any kind —
    // a helper too — since an exit above it cannot skip its body.
    if (isDecl || facts.decl(a)) scopeStart = a;

    // Preceding siblings of the enclosing line: attributes, decorators and
    // test-object properties (`#[ignore]`, `@pytest.mark.skip`,
    // `ignore: true`), and any exit before it.
    const parent = k > 0 ? ancestors[k - 1]! : -1;
    const aIndent = indentOf(lines[a]!.raw);
    for (let s = a - 1; s > parent; s--) {
      if (++walked > MAX_SIBLING_WALK_LINES) {
        context.push("S:…");
        break;
      }
      const sibling = facts.trimmed(s);
      if (sibling === "") continue;
      const sIndent = indentOf(lines[s]!.raw);
      if (sIndent < aIndent) break;
      if (sIndent > aIndent) continue;
      if (facts.skip(s) || facts.exit(s)) {
        context.push("S:" + facts.key(s));
      }
      if (
        sibling.startsWith("}") || facts.decl(s) ||
        sibling.endsWith("{") || sibling.endsWith(":")
      ) {
        break;
      }
    }
  }

  // Early exits between the innermost enclosing declaration and the
  // assertion, at any depth (`if (!ready) return;` above it). `exitLines`
  // holds only lines before `start`, so a binary search finds the first one
  // inside the scope.
  let lo = 0;
  let hi = exitLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (exitLines[mid]! <= scopeStart) lo = mid + 1;
    else hi = mid;
  }
  const exitCount = exitLines.length - lo;
  if (exitCount > MAX_KEYED_EXITS) context.push(`X#${exitCount}`);
  for (
    let e = Math.max(lo, exitLines.length - MAX_KEYED_EXITS);
    e < exitLines.length;
    e++
  ) {
    context.push("X:" + facts.key(exitLines[e]!));
  }

  return {
    start,
    end,
    text: display,
    canonical: canonicalise(joined),
    key: canonicaliseUncapped(joined) + "\u0001" + context.join("\u0002"),
    unclosed,
  };
}

/** Removed assertion statements within a single removed block, by raw line. */
function extractAssertionsFromBlock(
  block: DiffBlock,
): (RemovedAssertion & { index: number })[] {
  const results: (RemovedAssertion & { index: number })[] = [];
  const blockLines = block.lines;
  let i = 0;
  while (i < blockLines.length) {
    const raw = blockLines[i]!;
    const trimmed = raw.trim();
    if (!isCommentLine(trimmed) && ASSERTION_START_RE.test(capLine(raw))) {
      const statementLines: string[] = [raw];
      let depth = parenDelta(raw);
      let j = i + 1;
      while (
        depth > 0 && j < blockLines.length &&
        statementLines.length < MAX_STATEMENT_LINES
      ) {
        const next = blockLines[j]!;
        statementLines.push(next);
        depth += parenDelta(next);
        j++;
      }
      const joined = statementLines.map((line) => line.trim()).join(" ");
      let display = joined;
      if (display.length > MAX_DISPLAY_CHARS) {
        display = display.slice(0, MAX_DISPLAY_CHARS) + "…";
      }
      results.push({
        file: block.file,
        text: display,
        canonical: canonicalise(joined),
        index: block.start + i,
      });
      i = j;
      continue;
    }
    i++;
  }
  return results;
}

/**
 * Removed assertion statements from existing test files in a unified diff.
 *
 * Each test file's patch is rebuilt into its old and new sides — read with
 * whole-file context ({@link removedAssertionDiffArgs}) — and every
 * assertion statement on each side is found whole, however it is wrapped,
 * with comments and string contents blanked first. An assertion on the old
 * side counts as kept or moved only when the new side of some test file in
 * the diff holds a copy with the same whitespace-free text AND the same
 * context: the same enclosing guards and skips (`if`/`else`/`match`, loops,
 * callbacks, `it.skip(`, `#[ignore]`, `@pytest.mark.skip`) and the same
 * early exits before it. Copies are counted, so one copy cannot vouch for
 * two. Everything else is removed:
 *
 *   - an edit to any line of a multi-line assertion (its text differs);
 *   - an assertion commented out, deleted, or deleted with its file;
 *   - an assertion re-added under a new guard, into a skipped test, or after
 *     a new early exit (its context differs);
 *   - an unchanged assertion whose guard, skip or preceding exit changed;
 *   - an assertion whose brackets never close within the line cap, when the
 *     file changes at or after it (the gate cannot tell where it ends).
 *
 * As a backstop for a lexer mistake, a removed line that opens an assertion
 * but that the lexer entered already inside a carried-over string or block
 * comment is still reported, unless it is re-added verbatim (the earlier
 * raw-line scan).
 */
export function findRemovedAssertions(diffText: string): RemovedAssertion[] {
  const patches = parseTestFilePatches(diffText);
  const analysed = patches.map((patch) => {
    const oldSide = analyseSide(patch.oldLines, patch.lang);
    return {
      patch,
      oldStatements: oldSide.statements,
      oldLexed: oldSide.lexed,
      newStatements: analyseSide(patch.newLines, patch.lang).statements,
    };
  });

  const newCounts = new Map<string, number>();
  for (const { newStatements } of analysed) {
    for (const statement of newStatements) {
      if (statement.unclosed) continue;
      newCounts.set(statement.key, (newCounts.get(statement.key) ?? 0) + 1);
    }
  }

  // Backstop "moved" set: assertions re-extracted from the added lines,
  // compared by canonical *equality* — never substring containment, which
  // let `// assertEquals(a, b);` "contain" the removed assertion.
  const rawAddedCanonicals = new Set<string>();
  for (const { patch } of analysed) {
    for (const block of patch.addedBlocks) {
      for (const assertion of extractAssertionsFromBlock(block)) {
        rawAddedCanonicals.add(assertion.canonical);
      }
    }
  }

  const seen = new Set<string>();
  const result: RemovedAssertion[] = [];
  const report = (file: string, text: string, canonical: string) => {
    const key = `${file}\u0000${canonical}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ file, text, canonical });
  };

  for (const { patch, oldStatements, oldLexed } of analysed) {
    const covered = new Set<number>();
    for (const statement of oldStatements) {
      for (let i = statement.start; i <= statement.end; i++) covered.add(i);
      if (statement.unclosed) {
        const startSeq = patch.oldLines[statement.start]!.seq;
        if (patch.lastChangeSeq >= startSeq) {
          report(patch.file, statement.text, statement.canonical);
        }
        continue;
      }
      const count = newCounts.get(statement.key) ?? 0;
      if (count > 0) {
        newCounts.set(statement.key, count - 1);
        continue;
      }
      report(patch.file, statement.text, statement.canonical);
    }

    for (const block of patch.removedBlocks) {
      for (const candidate of extractAssertionsFromBlock(block)) {
        // Only a line the lexer entered inside a carried-over string or
        // block comment is in doubt; an assertion look-alike inside a
        // string or comment that opens on its own line is not an assertion.
        if (covered.has(candidate.index)) continue;
        if (!oldLexed[candidate.index]?.startsInside) continue;
        if (
          candidate.canonical !== "" &&
          rawAddedCanonicals.has(candidate.canonical)
        ) {
          continue;
        }
        report(candidate.file, candidate.text, candidate.canonical);
      }
    }
  }
  return result;
}

/** The `## Test Plan` section of a PR summary. */
export interface TestPlanSection {
  /** Whether a Test Plan heading was found at all. */
  present: boolean;
  /** The body text up to (not including) the next heading of equal or higher rank. */
  body: string;
}

/** A `# Test Plan` style heading, any level, case-insensitive. */
const TEST_PLAN_HEADING_RE = /^\s{0,3}(#{1,6})\s*test\s+plan\b/i;

/** Any markdown heading, used to find where a Test Plan body ends. */
const HEADING_LINE_RE = /^\s{0,3}(#{1,6})\s/;

/** A fenced code block delimiter line. */
const FENCE_LINE_RE = /^\s{0,3}(```|~~~)/;

/**
 * The first `## Test Plan` section of a PR summary. Heading-looking lines
 * inside a fenced code block are ignored when looking for the section's end.
 */
export function findTestPlanSection(prSummaryContent: string): TestPlanSection {
  const text = (prSummaryContent ?? "").slice(0, MAX_SUMMARY_SCAN_CHARS);
  const lines = text.split(/\r\n|\n/);

  let headingIndex = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(TEST_PLAN_HEADING_RE);
    if (match) {
      headingIndex = i;
      headingLevel = match[1]!.length;
      break;
    }
  }

  if (headingIndex === -1) {
    return { present: false, body: "" };
  }

  const bodyLines: string[] = [];
  let inFence = false;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      bodyLines.push(line);
      continue;
    }
    if (!inFence) {
      const headingMatch = line.match(HEADING_LINE_RE);
      if (headingMatch && headingMatch[1]!.length <= headingLevel) {
        break;
      }
    }
    bodyLines.push(line);
  }

  return { present: true, body: bodyLines.join("\n") };
}

/** A backslash-escaped markdown character, e.g. `\|` or `\*`. */
const MARKDOWN_ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!|>~])/g;

/** Canonical form of a Test Plan body, with markdown escapes undone first. */
function canonicaliseTestPlanBody(body: string): string {
  const unescaped = body.replace(MARKDOWN_ESCAPE_RE, "$1");
  return canonicalise(unescaped);
}

/** Verdict of the removed-assertion gate. */
export interface RemovedAssertionGateResult {
  /** True when the changed files include a test file, or could not be read. */
  applicable: boolean;
  /** True when the gate passes (always true when not applicable). */
  valid: boolean;
  /** False when the changed-files list could not be read at all. */
  changedFilesKnown: boolean;
  /** False when the test-file diff could not be read / was not provided. */
  testDiffKnown: boolean;
  /** Changed files that are test files (empty when the list is unknown). */
  testFiles: string[];
  /** Every removed (not-moved) assertion found. */
  removed: RemovedAssertion[];
  /** Those removed assertions the Test Plan does not name. */
  unaccounted: RemovedAssertion[];
  /** The parsed Test Plan section. */
  testPlan: TestPlanSection;
  /** One line per rule broken — empty when the gate passes. */
  problems: string[];
}

/** Up to how many test files are named in a "no Test Plan" problem. */
const MAX_NAMED_TEST_FILES = 5;

/** Render the changed test files for a problem message. */
function describeTestFiles(testFiles: readonly string[]): string {
  const named = testFiles.slice(0, MAX_NAMED_TEST_FILES).join(", ");
  const extra = testFiles.length - MAX_NAMED_TEST_FILES;
  return extra > 0 ? `${named} and ${extra} more` : named;
}

/** Up to how many unaccounted assertions are named in a problem message. */
const MAX_NAMED_UNACCOUNTED = 5;

/** Render unaccounted assertions for a problem message. */
function describeUnaccounted(unaccounted: readonly RemovedAssertion[]): string {
  const named = unaccounted
    .slice(0, MAX_NAMED_UNACCOUNTED)
    .map((assertion) => `${assertion.file}: ${assertion.text}`)
    .join("; ");
  const extra = unaccounted.length - MAX_NAMED_UNACCOUNTED;
  return extra > 0 ? `${named}; and ${extra} more` : named;
}

/** Shared rule evaluation once the gate is known to be applicable. */
function evaluateApplicable(
  testPlan: TestPlanSection,
  testFiles: string[],
  changedFilesKnown: boolean,
  testDiff: string | null,
): RemovedAssertionGateResult {
  const problems: string[] = [];

  if (!testPlan.present) {
    const diffDescription = changedFilesKnown
      ? `test files (${describeTestFiles(testFiles)})`
      : "the changed files could not be read, so the section is required";
    problems.push(
      `the PR summary has no \`## Test Plan\` section, but the diff touches ${diffDescription}`,
    );
  }

  let removed: RemovedAssertion[] = [];
  let unaccounted: RemovedAssertion[] = [];
  const testDiffKnown = testDiff !== null;

  if (testDiffKnown) {
    removed = findRemovedAssertions(testDiff!);
    // Matched against both the unescaped-markdown canonical and the raw
    // (un-unescaped) canonical of the Test Plan body. A removed assertion's
    // canonical form keeps its own backslashes verbatim (it is code, not
    // markdown), so `\.` inside a copied-verbatim regex or escaped string
    // must still match once the markdown-escape pass turns the Test Plan's
    // own `\.` into `.` — checking the raw body too is what lets the
    // verbatim copy the prompt asks for actually match.
    const planCanonical = canonicaliseTestPlanBody(testPlan.body);
    const planCanonicalRaw = canonicalise(testPlan.body);
    unaccounted = removed.filter(
      (assertion) =>
        !planCanonical.includes(assertion.canonical) &&
        !planCanonicalRaw.includes(assertion.canonical),
    );
    if (unaccounted.length > 0) {
      problems.push(
        `${unaccounted.length} assertion(s) removed from existing tests are not named in the Test Plan: ${
          describeUnaccounted(unaccounted)
        }`,
      );
      // SIMPLE-ON-PURPOSE: this gate checks only that each removed assertion
      // is named somewhere in the Test Plan, not that the stated issue
      // requirement really makes it untrue — upgrade to check the
      // requirement itself when a reviewed false entry reaches a milestone
      // (the Standards reviewer judges whether the stated reason is sound).
    }
  }

  return {
    applicable: true,
    valid: problems.length === 0,
    changedFilesKnown,
    testDiffKnown,
    testFiles,
    removed,
    unaccounted,
    testPlan,
    problems,
  };
}

/**
 * Verify that a PR summary's Test Plan accounts for every assertion the
 * diff removes from an existing test file.
 *
 * Rules, all deterministic:
 *   1. `changedFiles === null` (the diff could not be read) → the gate
 *      APPLIES (fail closed).
 *   2. A known changed-files list with no test file → not applicable, valid.
 *   3. Applicable with no `## Test Plan` section → blocked.
 *   4. When the test diff is known, every removed (not-moved) assertion must
 *      be named (as its canonical form) somewhere in the Test Plan body, or
 *      the PR is blocked.
 *   5. `testDiff === null` → no assertion-naming problem is raised (the
 *      caller logs the gap); rule 3 still applies.
 *
 * @param opts.changedFiles - The branch's changed files, or `null` when the
 *   diff could not be collected.
 * @param opts.testDiff - Output of `removedAssertionDiffArgs`, or `null`
 *   when it could not be read / was not collected.
 * @param opts.prSummaryContent - The PR summary content (or assembled body).
 */
export function validateRemovedAssertions(opts: {
  changedFiles: readonly string[] | null;
  testDiff: string | null;
  prSummaryContent: string;
}): RemovedAssertionGateResult {
  const testPlan = findTestPlanSection(opts.prSummaryContent ?? "");

  if (opts.changedFiles === null) {
    return evaluateApplicable(testPlan, [], false, opts.testDiff);
  }

  const testFiles = opts.changedFiles.filter((path) => isTestFilePath(path));
  if (testFiles.length === 0) {
    return {
      applicable: false,
      valid: true,
      changedFilesKnown: true,
      testDiffKnown: opts.testDiff !== null,
      testFiles: [],
      removed: [],
      unaccounted: [],
      testPlan,
      problems: [],
    };
  }

  return evaluateApplicable(testPlan, testFiles, true, opts.testDiff);
}

/** Cap on how many unaccounted assertions are listed in the gate comment. */
const MAX_LISTED_UNACCOUNTED = 30;

/**
 * Build the issue comment posted when the removed-assertion gate blocks PR
 * creation.
 *
 * Names every rule broken, lists the unaccounted assertions grouped by file
 * inside a fence sized so the untrusted assertion text cannot break out of
 * it, and restates the required Test Plan shape.
 */
export function buildRemovedAssertionGateComment(
  result: RemovedAssertionGateResult,
): string {
  const problems = result.problems.map((problem) => `- ${problem}`).join(
    "\n",
  );

  const lines: string[] = [
    "⚠️ **Removed test assertions not accounted for.** This diff edits an " +
    "existing test, so the PR summary must carry a `## Test Plan` that " +
    "names every assertion removed from an existing test — with the issue " +
    "requirement that makes it untrue — or says where it moved:",
    "",
    problems,
  ];

  if (result.unaccounted.length > 0) {
    const grouped = new Map<string, RemovedAssertion[]>();
    for (const assertion of result.unaccounted) {
      const list = grouped.get(assertion.file) ?? [];
      list.push(assertion);
      grouped.set(assertion.file, list);
    }

    let rendered = "";
    let listed = 0;
    for (const [file, assertions] of grouped) {
      if (listed >= MAX_LISTED_UNACCOUNTED) break;
      rendered += `${file}:\n`;
      for (const assertion of assertions) {
        if (listed >= MAX_LISTED_UNACCOUNTED) break;
        rendered += `  ${assertion.text}\n`;
        listed++;
      }
    }
    const extra = result.unaccounted.length - listed;
    if (extra > 0) {
      rendered += `…and ${extra} more\n`;
    }

    const body = scrubUntrustedText(rendered.trimEnd());
    const fence = codeFenceFor(body);
    lines.push(
      "",
      "Removed assertions not named in the Test Plan:",
      "",
      `${fence}text`,
      body,
      fence,
    );
  }

  lines.push(
    "",
    "Procedure:",
    "",
    "1. Restore any removed assertion that no issue requirement makes " +
      "untrue — the diff must not quietly drop test coverage that is still " +
      "correct.",
    "2. Where an assertion genuinely moved, move it to a test that still " +
      "covers the behaviour rather than deleting it outright. A copy " +
      "re-added under a new condition, loop or callback, into a skipped or " +
      "ignored test, or after a new early `return`, does not count as " +
      "moved; nor does a multi-line assertion with any line changed.",
    "3. Add each remaining removed assertion to the Test Plan in " +
      "`docs/archive/pr-summaries/pr-summary-<issue>.md`, copied as it " +
      "appears in the diff (whitespace differences are ignored), in this " +
      "shape:",
    "",
    "```markdown",
    "## Test Plan",
    "",
    "- Removed from `crates/api/tests/decisions.rs`: " +
      '`assert_eq!(record.score.to_string(), "-0.5")` — #2253 changes the ' +
      "score to a rating, so the old value is untrue",
    "- Moved `assertEquals(result.code, 0)` to " +
      "`worker/deno/tests/foo_test.ts::exits cleanly`",
    "```",
  );

  return lines.join("\n");
}
