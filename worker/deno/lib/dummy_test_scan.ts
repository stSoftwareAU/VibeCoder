/**
 * Deterministic dummy-test scan (Issue #5016).
 *
 * Reads a unified diff and judges the tests the change adds or edits, in Rust
 * (`#[test]`, `#[tokio::test]`) and Deno/TypeScript (`Deno.test`, and `it` /
 * `test` in test files). It enforces the rules in `CODING-STANDARDS.md`,
 * **Dummy tests and "how" tests are refused**; it does not restate them.
 *
 * Blocking findings:
 *
 * - `no-assertion` — the test body has no assertion at all;
 * - `success-only` — every assertion only checks success, presence or
 *   non-emptiness (`is_ok`, `is_some`, `!is_empty`, `assertExists`, a bare
 *   truthy `assert(x)`, `toBeDefined`, `not.toThrow`);
 * - `ignored-without-reason` — an added ignore or skip marker with no reason.
 *
 * Reviewer notes (a checklist item the reviewer must judge, never a hard
 * fail): mock-interaction assertions such as `toHaveBeenCalled`,
 * `assertSpyCalls` or mockall's `.times(n)`.
 *
 * Only what the diff shows is judged. A test whose body runs past the end of
 * its hunk is not judged for assertions (the reviewer still reads it), so the
 * scan never guesses at lines it cannot see. String and comment contents are
 * masked before any pattern runs, so an assertion named inside a fixture
 * string does not count. Every pattern is linear (no nested quantifiers).
 *
 * The fleet reviewer (`.claude/skills/review-fleet-prs/scripts/gate.ts` and
 * `post.ts`) and the worker's pre-PR verifier (`pre_pr_verifier.ts`) both
 * apply it, the same way they apply the capability fixture judgement.
 *
 * Australian English throughout.
 *
 * @module
 */

import type { CapabilityReview } from "./capability_security_guidance.ts";
import { inlineSafe } from "./review_checklists.ts";

/** The section of `CODING-STANDARDS.md` every finding points at. */
export const DUMMY_TEST_RULES_URL =
  "https://github.com/stSoftwareAU/VibeCoder/blob/main/CODING-STANDARDS.md#dummy-tests-and-how-tests-are-refused";

/** How every finding and note names the rules it enforces. */
export const DUMMY_TEST_RULES_SECTION =
  `the Vibe Coder rule **Dummy tests and "how" tests are refused** (${DUMMY_TEST_RULES_URL})`;

/** The checklist id the reviewer notes are reported under. */
export const DUMMY_TEST_CHECKLIST = "dummy-test-scan";

export type DummyTestRule =
  | "no-assertion"
  | "success-only"
  | "ignored-without-reason";

export interface DummyTestFinding {
  file: string;
  line: number;
  rule: DummyTestRule;
  problem: string;
  fix: string;
}

/**
 * A reviewer note: `interaction` for a mock-interaction assertion, `unseen`
 * for an edited file's test that asserts nothing the diff shows but calls a
 * function defined out of view, which may be the helper that asserts.
 */
export interface DummyTestNote {
  file: string;
  line: number;
  kind: "interaction" | "unseen";
}

export interface DummyTestScan {
  findings: DummyTestFinding[];
  notes: DummyTestNote[];
}

/** Bounds, so a huge diff cannot produce an unreadable review. */
export const MAX_DUMMY_TEST_FINDINGS = 25;
export const MAX_DUMMY_TEST_NOTES = 10;

type Lang = "rust" | "ts";

interface NewLine {
  text: string;
  line: number;
  added: boolean;
}

interface Hunk {
  file: string;
  /** The file is new, so every line of it is in view. */
  isNew: boolean;
  lines: NewLine[];
}

const TS_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const RUST_FILE = /\.rs$/;
const TEST_PATH =
  /(?:^|\/)tests?\/|_test\.[a-z]+$|\.test\.[a-z]+$|\.spec\.[a-z]+$/i;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function langOf(file: string): Lang | null {
  if (RUST_FILE.test(file)) return "rust";
  if (TS_FILE.test(file)) return "ts";
  return null;
}

/**
 * The new-side lines of every hunk, per file. Hunk lengths come from the
 * header, so an added line that itself starts with `+++` is never misread as
 * a file header.
 */
function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const rows = diff.split("\n");
  let file = "";
  let isNew = false;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.startsWith("--- ")) {
      isNew = row.slice(4).trim() === "/dev/null";
      i++;
      continue;
    }
    if (row.startsWith("+++ ")) {
      const path = row.slice(4).trim();
      file = path === "/dev/null" ? "" : path.replace(/^b\//, "");
      i++;
      continue;
    }
    const header = HUNK_HEADER.exec(row);
    if (!header) {
      i++;
      continue;
    }
    let oldLeft = header[1] === undefined ? 1 : Number(header[1]);
    let newLeft = header[3] === undefined ? 1 : Number(header[3]);
    let line = Number(header[2]);
    const lines: NewLine[] = [];
    i++;
    while (i < rows.length && (oldLeft > 0 || newLeft > 0)) {
      const r = rows[i]!;
      if (r.startsWith("\\")) {
        i++;
        continue;
      }
      const mark = r[0];
      if (mark === "+") {
        lines.push({ text: r.slice(1), line: line++, added: true });
        newLeft--;
      } else if (mark === "-") {
        oldLeft--;
      } else if (mark === " " || r === "") {
        lines.push({ text: r.slice(1), line: line++, added: false });
        oldLeft--;
        newLeft--;
      } else {
        break;
      }
      i++;
    }
    if (file !== "" && lines.length > 0) hunks.push({ file, isNew, lines });
  }
  return hunks;
}

const isIdent = (c: string | undefined) =>
  c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * The source with every string, regex-literal and comment body replaced by
 * spaces (newlines and the delimiters kept), so offsets and line numbers are
 * unchanged and brackets inside text cannot unbalance a count.
 */
export function maskSource(src: string, lang: Lang): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  let lastCode = "";
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      blank(i + 2, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end;
      blank(i + 2, stop);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (lang === "rust" && (c === "r" || c === "b") && !isIdent(src[i - 1])) {
      let j = i + (c === "b" && next === "r" ? 2 : 1);
      if (c === "r" || src[i + 1] === "r") {
        let hashes = 0;
        while (src[j] === "#") {
          hashes++;
          j++;
        }
        if (src[j] === '"') {
          const close = '"' + "#".repeat(hashes);
          const end = src.indexOf(close, j + 1);
          const stop = end < 0 ? src.length : end;
          blank(j + 1, stop);
          i = end < 0 ? src.length : end + close.length;
          lastCode = '"';
          continue;
        }
      }
    }
    if (lang === "rust" && c === "'") {
      // A char literal ('x', '\n'); otherwise a lifetime, which is code.
      const lit = /^'(?:\\.[^']{0,8}|[^'\\\n])'/.exec(src.slice(i, i + 12));
      if (lit) {
        blank(i + 1, i + lit[0].length - 1);
        i += lit[0].length;
        lastCode = "'";
        continue;
      }
      i++;
      continue;
    }
    const quote = c === '"' || (lang === "ts" && (c === "'" || c === "`"));
    const regex = lang === "ts" && c === "/" && /^$|[(,=:[!&|?{};+\-*%<>~^]$/
      .test(lastCode);
    if (quote || regex) {
      const close = c;
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (regex && d === "\n") break;
        if (regex && d === "[") inClass = true;
        else if (regex && d === "]") inClass = false;
        else if (d === close && !inClass) break;
        if (c !== "`" && lang === "ts" && d === "\n") break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastCode = close;
      continue;
    }
    if (!/\s/.test(c)) lastCode = c;
    i++;
  }
  return out.join("");
}

/** Offset of the bracket closing the one at `open`, or -1 past the end. */
function closingBracket(masked: string, open: number): number {
  const opener = masked[open];
  const closer = opener === "(" ? ")" : opener === "{" ? "}" : "]";
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Top-level comma-separated arguments of the call whose `(` is at `open`. */
function callArgs(masked: string, open: number): string[] | null {
  const close = closingBracket(masked, open);
  if (close < 0) return null;
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let k = open + 1; k < close; k++) {
    const ch = masked[k]!;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      args.push(masked.slice(start, k));
      start = k + 1;
    }
  }
  args.push(masked.slice(start, close));
  return args.map((a) => a.replace(/\s+/g, "")).filter((a) => a !== "");
}

type Strength = "weak" | "strong" | "interaction";

const INTERACTION =
  /\.(?:toHaveBeenCalled\w*|toBeCalled\w*|toHaveBeenNthCalledWith|toHaveBeenLastCalledWith|calledOnce|calledTwice|calledWith|callCount|call_count)\b|\bassertSpyCalls?\b|\bassertSpyCallArgs?\b|\.calls\.length\b|\.mock\.calls\b|\.times\(\s*\d+\s*\)|\.called\b/;

// Rust weak shapes, matched against an assertion's argument with all
// whitespace removed. A combined check (`a.is_ok() && b == 2`) is never weak.
const COMBINED = /&&|\|\||==|!=|<=|>=/;

function rustWeakAssert(arg: string): boolean {
  if (arg === "true") return true;
  if (/^matches!\([^,]*,(?:Ok|Some)\(_\)\)$/.test(arg)) return true;
  const len = /\.len\(\)(?:>0|>=1|!=0)$/.exec(arg);
  if (len) return !COMBINED.test(arg.slice(0, len.index));
  if (COMBINED.test(arg)) return false;
  if (/^!.*\.is_empty\(\)$/.test(arg)) return true;
  return !arg.startsWith("!") && /\.is_(?:ok|some)\(\)$/.test(arg);
}

function rustStrength(name: string, args: string[] | null): Strength {
  if (!/^(?:debug_)?assert(?:_eq|_ne)?$/.test(name)) return "strong";
  if (args === null || args.length === 0) return "strong";
  const [a, b] = args;
  if (name.endsWith("assert")) return rustWeakAssert(a!) ? "weak" : "strong";
  if (b === undefined) return "strong";
  const pair = [a!, b];
  const has = (re: RegExp, v: string) =>
    pair.includes(v) && pair.some((p) => !COMBINED.test(p) && re.test(p));
  if (name.endsWith("assert_eq")) {
    if (has(/\.is_(?:ok|some)\(\)$/, "true")) return "weak";
    if (has(/\.is_empty\(\)$/, "false")) return "weak";
    return "strong";
  }
  if (has(/\.len\(\)$/, "0")) return "weak";
  if (pair.includes("None")) return "weak";
  return "strong";
}

// A bare truthy check: a lone identifier, or a path ending in `.ok`.
const TS_BARE_PATH = /^(?:!!)?(?:[\w$]+|[\w$?.[\]]+\.ok)$/;
const TS_WEAK_MATCHERS = new Set(["toBeDefined", "toBeTruthy"]);
const TS_WEAK_NOT_MATCHERS = new Set([
  "toBeNull",
  "toBeUndefined",
  "toBeFalsy",
  "toThrow",
  "toHaveLength",
]);

function tsStrength(
  masked: string,
  name: string,
  open: number,
): Strength {
  const args = callArgs(masked, open);
  if (args === null) return "strong";
  const [a, b] = args;
  if (name === "assertExists") return "weak";
  if (name === "assert") {
    if (a === undefined) return "strong";
    if (TS_BARE_PATH.test(a)) return "weak";
    if (/^[\w$?.]+\.length(?:>0|>=1|!==0|!=0)$/.test(a)) return "weak";
    return "strong";
  }
  if (name === "assertEquals" || name === "assertStrictEquals") {
    if (
      a !== undefined && b === "true" && /^[\w$?.]+\.ok$/.test(a)
    ) {
      return "weak";
    }
    return "strong";
  }
  if (name === "assertNotEquals" || name === "assertNotStrictEquals") {
    if (b === "undefined" || b === "null") return "weak";
    if (b === "0" && a !== undefined && /\.length$/.test(a)) return "weak";
    return "strong";
  }
  if (name === "expect") {
    const close = closingBracket(masked, open);
    const tail = masked.slice(close + 1, close + 200);
    const m =
      /^\s*(\.not)?\s*\.(?:resolves\s*\.|rejects\s*\.)?(?:(not)\s*\.)?\s*(\w+)\s*\(/
        .exec(tail);
    if (!m) return "strong";
    const negated = m[1] !== undefined || m[2] !== undefined;
    const matcher = m[3]!;
    if (/^(?:toHaveBeen|toBe)(?:Nth|Last)?Called/.test(matcher)) {
      return "interaction";
    }
    if (!negated && TS_WEAK_MATCHERS.has(matcher)) return "weak";
    if (negated && TS_WEAK_NOT_MATCHERS.has(matcher)) return "weak";
    if (
      matcher === "toBeGreaterThan" && a !== undefined && /\.length$/.test(a)
    ) {
      const mArgs = callArgs(masked, close + m[0].length);
      if (mArgs && mArgs[0] === "0") return "weak";
    }
    return "strong";
  }
  if (/^assertSpyCall/.test(name)) return "interaction";
  return "strong";
}

// A call whose name reads as an assertion helper (`assert_round_trip`,
// `expectRefusal`, `checkOutcome`) counts as a strong assertion: its body is
// out of view, and the scan only refuses what it can see.
const HELPER_CALL =
  /(?:^|[^\w$.])(?:(?:assert|expect|verify|check|ensure)\w*|\w+(?:Assert|Expect|Verify|_assert|_expect|_check|_verify)\w*)\s*\(/g;

/** Every assertion in a masked test body, as its strength. */
function assertionsIn(body: string, lang: Lang): Strength[] {
  const found: Strength[] = [];
  if (lang === "rust") {
    for (const m of body.matchAll(/(?:^|[^\w.])([A-Za-z_]\w*)!\s*\(/g)) {
      const name = m[1]!;
      if (!/assert|panic|unreachable/.test(name)) continue;
      const open = (m.index ?? 0) + m[0].length - 1;
      found.push(rustStrength(name, callArgs(body, open)));
    }
    for (const _ of body.matchAll(HELPER_CALL)) found.push("strong");
    return found;
  }
  const named = new Set<number>();
  for (
    const m of body.matchAll(
      /(?:^|[^\w$.])((?:assert|expect|fail)\w*)\s*\(/g,
    )
  ) {
    const open = (m.index ?? 0) + m[0].length - 1;
    named.add(open);
    found.push(tsStrength(body, m[1]!, open));
  }
  for (const m of body.matchAll(HELPER_CALL)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (!named.has(open)) found.push("strong");
  }
  if (/(?:^|[^\w$.])throw\b/.test(body)) found.push("strong");
  return found;
}

const TS_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "function",
  "catch",
  "typeof",
  "await",
  "it",
  "test",
  "describe",
]);
const RUST_KEYWORDS = new Set(["if", "while", "for", "match", "return", "fn"]);

/** Names of the plain (not method, not path) calls in a masked body. */
function calleesIn(body: string, lang: Lang): string[] {
  const out = new Set<string>();
  const re = lang === "rust"
    ? /(?:^|[^\w.:])([a-z_]\w*)\s*\(/g
    : /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  const keywords = lang === "rust" ? RUST_KEYWORDS : TS_KEYWORDS;
  for (const m of body.matchAll(re)) {
    const name = m[1]!;
    const before = body.slice(Math.max(0, (m.index ?? 0) - 4), m.index ?? 0);
    if (keywords.has(name) || /new\s*$/.test(before)) continue;
    out.add(name);
  }
  return [...out];
}

/**
 * Functions defined in view (name to masked body, or null when the body runs
 * past its hunk), so a test that delegates to a helper is judged by the
 * helper's assertions.
 */
function definitionsIn(
  masked: string,
  lang: Lang,
  into: Map<string, string | null>,
) {
  const re = lang === "rust"
    ? /\bfn\s+([A-Za-z_]\w*)/g
    : /(?:^|[^\w$.])(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,120})?=\s*(?:async\s*)?(?:function\b|\())/g;
  for (const m of masked.matchAll(re)) {
    const name = m[1] ?? m[2];
    if (!name || into.get(name)) continue;
    const from = (m.index ?? 0) + m[0].length;
    const paren = masked.indexOf("(", from - 1);
    const paramsEnd = paren < 0 ? -1 : closingBracket(masked, paren);
    if (paramsEnd < 0) {
      into.set(name, null);
      continue;
    }
    const rest = masked.slice(paramsEnd + 1);
    const brace = masked.indexOf("{", paramsEnd);
    const arrowExpr = lang === "ts" &&
      /^\s*(?::[^=]{0,120})?=>\s*[^{\s]/.test(rest);
    if (arrowExpr) {
      const nl = masked.indexOf("\n", paramsEnd);
      into.set(name, masked.slice(paramsEnd, nl < 0 ? masked.length : nl));
      continue;
    }
    const close = brace < 0 ? -1 : closingBracket(masked, brace);
    into.set(name, close < 0 ? null : masked.slice(brace, close + 1));
  }
}

const RUST_TEST_ATTR = /#\[\s*(?:[A-Za-z_]\w*::)*test\b[^\]\n]*\]/g;
const TS_TEST_START =
  /(?:^|[^\w$.])(Deno\.test(?:\.ignore|\.only)?|it(?:\.skip|\.only|\.todo)?|test(?:\.skip|\.only|\.todo)?|xit|xtest|describe\.skip|xdescribe)\s*\(/g;

interface LineIndex {
  starts: number[];
}

function lineAt(index: LineIndex, offset: number): number {
  let lo = 0;
  let hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Whether a line holds a comment with text. The masked line keeps comment
 * delimiters but blanks strings, so a `//` inside a string never counts.
 */
function commentWithText(raw: string, masked: string): boolean {
  for (const marker of ["//", "/*"]) {
    const at = masked.indexOf(marker);
    if (at >= 0 && raw.slice(at + 2).replace(/\*\/\s*$/, "").trim() !== "") {
      return true;
    }
  }
  return false;
}

/** A reason: a comment on the marker's own line or on the line above it. */
function hasReasonComment(
  lines: NewLine[],
  masked: string[],
  at: number,
): boolean {
  if (commentWithText(lines[at]?.text ?? "", masked[at] ?? "")) return true;
  const above = at - 1;
  return above >= 0 && /^\s*(?:\/\/|\/\*|\*)/.test(masked[above] ?? "") &&
      commentWithText(lines[above]!.text, masked[above]!) ||
    above >= 0 && /^\s*\*\s*\S/.test(lines[above]!.text);
}

const FIX_TEXT: Record<DummyTestRule, string> = {
  "no-assertion":
    "Drive the public entry point and assert the observable outcome (the returned value, the stored record, the served response, or the error and its message), or delete the test.",
  "success-only":
    "Assert the actual value or error the code produces, not only that it succeeded, exists or is non-empty.",
  "ignored-without-reason":
    'Give the ignore its reason (`#[ignore = "why"]`, or a comment on the line above), or make the test run.',
};

function problemFor(rule: DummyTestRule): string {
  const what = rule === "no-assertion"
    ? "This test asserts nothing, so it passes whatever the code does."
    : rule === "success-only"
    ? "This test only asserts success, presence or non-emptiness, so it passes while the value is wrong."
    : "This test is ignored or skipped without a reason.";
  return `${what} It is a dummy test, refused by ${DUMMY_TEST_RULES_SECTION}.`;
}

/**
 * Scan a unified diff for dummy tests and mock-interaction assertions. A test
 * with no assertion that calls a helper defined in view is judged by that
 * helper's assertions; in an edited file a call out of view makes it a note.
 */
export function scanDummyTests(diff: string): DummyTestScan {
  const findings: DummyTestFinding[] = [];
  const notes: DummyTestNote[] = [];
  const seen = new Set<string>();
  const add = (file: string, line: number, rule: DummyTestRule) => {
    const key = `${file}:${line}:${rule}`;
    if (seen.has(key) || findings.length >= MAX_DUMMY_TEST_FINDINGS) return;
    seen.add(key);
    findings.push({
      file,
      line,
      rule,
      problem: problemFor(rule),
      fix: FIX_TEXT[rule],
    });
  };
  const noted = new Set<string>();
  const note = (file: string, line: number, kind: DummyTestNote["kind"]) => {
    const key = `${file}:${line}`;
    if (noted.has(key) || notes.length >= MAX_DUMMY_TEST_NOTES) return;
    noted.add(key);
    notes.push({ file, line, kind });
  };

  const hunks = parseHunks(diff);
  const definitions = new Map<string, Map<string, string | null>>();
  for (const hunk of hunks) {
    const lang = langOf(hunk.file);
    if (lang === null) continue;
    const defs = definitions.get(hunk.file) ?? new Map();
    definitionsIn(
      maskSource(hunk.lines.map((l) => l.text).join("\n"), lang),
      lang,
      defs,
    );
    definitions.set(hunk.file, defs);
  }

  for (const hunk of hunks) {
    const lang = langOf(hunk.file);
    if (lang === null) continue;
    const defs = definitions.get(hunk.file)!;
    // What a body's calls add: the helpers' own assertions, one level deep
    // and then one more; a call out of view in an edited file is unseen.
    const delegated = (
      body: string,
      depth: number,
    ): { out: Strength[]; unseen: boolean } => {
      const out: Strength[] = [];
      let unseen = false;
      for (const name of calleesIn(body, lang)) {
        const helper = defs.get(name);
        if (helper === undefined || helper === null) {
          if (!hunk.isNew || helper === null) unseen = true;
          continue;
        }
        out.push(...assertionsIn(helper, lang));
        if (depth < 2) {
          const deeper = delegated(helper, depth + 1);
          out.push(...deeper.out);
          unseen ||= deeper.unseen;
        }
      }
      return { out, unseen };
    };
    const testFile = TEST_PATH.test(hunk.file);
    const raw = hunk.lines.map((l) => l.text).join("\n");
    const masked = maskSource(raw, lang);
    const starts: number[] = [];
    let offset = 0;
    for (const l of hunk.lines) {
      starts.push(offset);
      offset += l.text.length + 1;
    }
    const index = { starts };
    const maskedLines = masked.split("\n");

    const judge = (
      declLine: number,
      reportLine: number,
      bodyStart: number,
      bodyEnd: number,
      lastLine: number,
      extraStrong: boolean,
    ) => {
      const span = hunk.lines.slice(declLine, lastLine + 1);
      if (!span.some((l) => l.added)) return;
      for (let k = declLine; k <= lastLine; k++) {
        if (hunk.lines[k]!.added && INTERACTION.test(maskedLines[k] ?? "")) {
          note(hunk.file, hunk.lines[k]!.line, "interaction");
        }
      }
      if (bodyEnd < 0) return; // body runs past the hunk: not judged
      const body = masked.slice(bodyStart, bodyEnd + 1);
      const found = assertionsIn(body, lang);
      if (extraStrong) found.push("strong");
      const helpers = delegated(body, 1);
      found.push(...helpers.out);
      const file = hunk.file;
      const line = hunk.lines[reportLine]!.line;
      if (found.length === 0) {
        if (helpers.unseen) note(file, line, "unseen");
        else add(file, line, "no-assertion");
      } else if (found.every((s) => s === "weak")) {
        add(file, line, "success-only");
      }
    };

    if (lang === "rust") {
      for (const m of masked.matchAll(RUST_TEST_ATTR)) {
        const at = m.index ?? 0;
        const attrLine = lineAt(index, at);
        // The attribute block around `#[test]`: attributes and comments.
        let first = attrLine;
        while (
          first > 0 &&
          /^\s*(?:#\[|\/\/)/.test(hunk.lines[first - 1]!.text)
        ) first--;
        const fnRel = masked.slice(at).search(/\bfn\b/);
        if (fnRel < 0) continue;
        const fnAt = at + fnRel;
        const fnLine = lineAt(index, fnAt);
        if (fnLine - attrLine > 10) continue;
        const block = hunk.lines.slice(first, fnLine);
        for (let k = 0; k < block.length; k++) {
          const l = block[k]!;
          const ig = /#\[\s*ignore\s*(?:=\s*"([^"]*)")?\s*\]/.exec(l.text);
          if (!ig || !l.added) continue;
          const reason = (ig[1] ?? "").trim() !== "" ||
            block.some((b, n) =>
              commentWithText(b.text, maskedLines[first + n] ?? "")
            );
          if (!reason) add(hunk.file, l.line, "ignored-without-reason");
        }
        const shouldPanic = block.some((b) =>
          /#\[\s*should_panic/.test(b.text)
        );
        const open = masked.indexOf("{", fnAt);
        if (open < 0) continue;
        const close = closingBracket(masked, open);
        const last = close < 0 ? hunk.lines.length - 1 : lineAt(index, close);
        judge(first, fnLine, open, close, last, shouldPanic);
      }
    } else {
      for (const m of masked.matchAll(TS_TEST_START)) {
        const token = m[1]!;
        if (!token.startsWith("Deno.") && !testFile) continue;
        const open = (m.index ?? 0) + m[0].length - 1;
        const declLine = lineAt(index, open);
        const decl = hunk.lines[declLine]!;
        const close = closingBracket(masked, open);
        const last = close < 0 ? hunk.lines.length - 1 : lineAt(index, close);
        const skipToken = /\.(?:ignore|skip|todo)$|^x/.test(token);
        if (
          skipToken && decl.added &&
          !hasReasonComment(hunk.lines, maskedLines, declLine)
        ) {
          add(hunk.file, decl.line, "ignored-without-reason");
        }
        if (token.includes("describe")) continue;
        const bodyEnd = close < 0 ? masked.length : close;
        const opts = masked.slice(open, bodyEnd);
        for (const ig of opts.matchAll(/\bignore\s*:\s*true\b/g)) {
          const k = lineAt(index, open + (ig.index ?? 0));
          if (
            hunk.lines[k]!.added &&
            !hasReasonComment(hunk.lines, maskedLines, k)
          ) {
            add(hunk.file, hunk.lines[k]!.line, "ignored-without-reason");
          }
        }
        if (skipToken) continue; // a skipped test is judged by the rule above
        judge(declLine, declLine, open, close, last, false);
      }
      if (testFile) {
        hunk.lines.forEach((l, k) => {
          if (l.added && INTERACTION.test(maskedLines[k] ?? "")) {
            note(hunk.file, l.line, "interaction");
          }
        });
      }
    }
  }
  return { findings, notes };
}

/** The text of a reviewer-note checklist item; the reply copies it exactly. */
export function dummyTestNoteItem(note: DummyTestNote): string {
  const path = inlineSafe(note.file, 200).replace(/[^\w./ ()@+~[\]-]/g, "_");
  return note.kind === "interaction"
    ? `${path}:${note.line} asserts a mock interaction: met only if the test also asserts an observable outcome and the mock stands at a real external boundary (network, broker, clock).`
    : `${path}:${note.line} asserts nothing the diff shows: met only if a helper it calls asserts an observable outcome.`;
}

/**
 * The reviewer notes as a checklist section, shaped like the capability
 * review so it merges through `mergeCapabilityReview`. Empty with no notes.
 */
export function dummyTestNotesReview(scan: DummyTestScan): CapabilityReview {
  if (scan.notes.length === 0) {
    return {
      markdown: "",
      state: { problem: null, expected: [] },
      retry: false,
    };
  }
  const items = scan.notes.map(dummyTestNoteItem);
  return {
    markdown: [
      "### Dummy-test scan: tests to judge",
      "",
      `The deterministic dummy-test scan found tests this change adds or edits that it cannot judge alone: a mock-interaction assertion, or a test with no visible assertion that calls a function out of view. A test that asserts which internal functions or mocks were called, how often or in what order is a "how" test, and a test that asserts nothing is a dummy test; both are refused by ${DUMMY_TEST_RULES_SECTION}. Report EVERY item below in the reply \`checklist\` array as \`met\`, \`missing\` or \`not applicable\`, copying the checklist name and the item text exactly. Any \`missing\` item is also a blocking finding.`,
      "",
      `Checklist \`${DUMMY_TEST_CHECKLIST}\``,
      ...items.map((item, i) => `${i + 1}. ${item}`),
    ].join("\n"),
    state: {
      problem: null,
      expected: items.map((item) => ({
        checklist: DUMMY_TEST_CHECKLIST,
        item,
      })),
    },
    retry: false,
  };
}

/**
 * Add the scan's blocking findings to a review. A finding the review already
 * holds at the same file and line is not repeated.
 */
export function applyDummyTestScan<
  T extends {
    findings: { file: string; line: number; problem: string; fix?: string }[];
  },
>(review: T, scan: DummyTestScan): T {
  const findings = [...review.findings];
  for (const f of scan.findings) {
    if (findings.some((g) => g.file === f.file && g.line === f.line)) continue;
    findings.push({
      file: f.file,
      line: f.line,
      problem: f.problem,
      fix: f.fix,
    });
  }
  return { ...review, findings };
}
