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
 * scan never guesses at lines it cannot see. A callback passed by name
 * (`Deno.test("x", check)`, `fn: check`), or through a registration helper's
 * callback parameter, is judged by the body of the function it names; one the
 * diff cannot resolve is a note, never a finding. An inline test body that
 * calls a parameter of the enclosing helper, and does not assert enough by
 * itself, is judged at each call of that helper (the helper's own assertions
 * count, and only the callback arguments that registration invokes), and is a
 * note when no call is in view. String and comment contents
 * are masked before any pattern runs, so an assertion named inside a fixture
 * string does not count. Every pattern is linear (no nested quantifiers).
 * Each helper's assertions are worked out once per scan, and an inline test
 * body is judged from per-hunk indexes of its calls, assertions, ignore
 * markers and lines, so a body nested in another is not re-read and the cost
 * grows linearly with the diff (Issue #5236).
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
 * for a test that asserts nothing the diff shows and may assert in a function
 * out of view: one an edited file's test calls, or a callback it registers
 * that is not defined in view.
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

/**
 * The bracket table of the hunk being scanned. Only that one text has a
 * table: a body judged inside it is scanned forward from its opener, so
 * memory stays one table per hunk however many bodies nest (PR #5232).
 */
let hunkBrackets: { text: string; matched: Int32Array | null } | null = null;

/** Make `masked` the hunk whose bracket lookups are answered from a table. */
function scanHunk(masked: string): void {
  hunkBrackets = { text: masked, matched: null };
}

/** Offset of the bracket closing the one at `open`, or -1 past the end. */
function closingBracket(masked: string, open: number): number {
  if (hunkBrackets !== null && hunkBrackets.text === masked) {
    hunkBrackets.matched ??= bracketTable(masked);
    return hunkBrackets.matched[open] ?? -1;
  }
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

/** Each opener's matching closer (by bracket kind), or -1. */
function bracketTable(masked: string): Int32Array {
  const matched = new Int32Array(masked.length).fill(-1);
  const stacks: Record<string, number[]> = { "(": [], "{": [], "[": [] };
  const openerOf: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  for (let k = 0; k < masked.length; k++) {
    const ch = masked[k]!;
    const stack = stacks[ch];
    if (stack !== undefined) stack.push(k);
    else if (openerOf[ch] !== undefined) {
      const from = stacks[openerOf[ch]!]!.pop();
      if (from !== undefined) matched[from] = k;
    }
  }
  return matched;
}

/**
 * Top-level comma-separated pieces of `text`, whitespace removed, empty ones
 * dropped.
 */
function splitTopLevel(text: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]!;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      pieces.push(text.slice(start, k));
      start = k + 1;
    }
  }
  pieces.push(text.slice(start));
  return pieces.map((a) => a.replace(/\s+/g, "")).filter((a) => a !== "");
}

/** Top-level comma-separated arguments of the call whose `(` is at `open`. */
function callArgs(masked: string, open: number): string[] | null {
  const close = closingBracket(masked, open);
  if (close < 0) return null;
  return splitTopLevel(masked.slice(open + 1, close));
}

/** A callback reference: a bare identifier or a property path (`a.b.c`). */
const REF = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const PARAM_NAME = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)(?:[?:=]|$)/;
const FN_PROPERTY = /^fn:([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;

/** Whether a whitespace-stripped argument is an inline function. */
function inlineFunction(arg: string): boolean {
  if (arg.startsWith("{")) return false;
  return arg.includes("=>") || /^(?:async)?function.*\{/.test(arg);
}

/**
 * The top-level arguments of the call whose bracket is at `open`, whitespace
 * removed, with each nested bracket group collapsed to its two brackets
 * (`() => {}`). Groups are stepped over by their closing offset, so the cost is
 * the call's own level, not everything nested inside it (PR #5232). `start` and
 * `end` are the offsets of the argument's first and last character. Null when
 * the call does not close in view.
 */
function flatArgs(
  masked: string,
  open: number,
):
  | Array<{ flat: string; groups: number[]; start: number; end: number }>
  | null {
  const close = closingBracket(masked, open);
  if (close < 0) return null;
  const out: Array<
    { flat: string; groups: number[]; start: number; end: number }
  > = [];
  let flat = "";
  let groups: number[] = [];
  let start = -1;
  let end = -1;
  const flush = () => {
    if (flat !== "") out.push({ flat, groups, start, end });
    flat = "";
    groups = [];
    start = -1;
  };
  for (let k = open + 1; k < close; k++) {
    const ch = masked[k]!;
    if (ch === "(" || ch === "{" || ch === "[") {
      const stop = closingBracket(masked, k);
      if (stop < 0 || stop > close) return null;
      if (start < 0) start = k;
      flat += ch + masked[stop];
      groups.push(k);
      k = stop;
      end = k;
    } else if (ch === ",") flush();
    else if (!/\s/.test(ch)) {
      if (start < 0) start = k;
      flat += ch;
      end = k;
    }
  }
  flush();
  return out;
}

/**
 * The named callback a registration call (its `(` at `open`) passes: the `fn`
 * of an options object (`fn` or `fn: check`), else a trailing reference
 * (`Deno.test("x", check)`) when no argument is an inline function. A property
 * path (`suite.check`) is returned as is, so it resolves to nothing in view and
 * is a note. Null for an inline callback.
 */
function callbackName(masked: string, open: number): string | null {
  const args = flatArgs(masked, open);
  if (args === null || args.length === 0) return null;
  for (const arg of args) {
    if (arg.flat !== "{}") continue;
    for (const prop of flatArgs(masked, arg.groups[0]!) ?? []) {
      if (prop.flat === "fn") return "fn";
      const named = FN_PROPERTY.exec(prop.flat);
      if (named) return named[1]!;
    }
  }
  if (args.some((a) => inlineFunction(a.flat))) return null;
  const last = args[args.length - 1]!.flat;
  return REF.test(last) ? last : null;
}

/**
 * Parameter names by position for the parameter list whose `(` is at
 * `params`. A destructured parameter takes a position but no name (""); a
 * fragment a generic type's comma split leaves (`number>`) takes none.
 */
function paramNames(masked: string, params: number): Map<string, number> {
  const out = new Map<string, number>();
  if (params < 0) return out;
  const kept = (callArgs(masked, params) ?? []).filter((p) =>
    /^[{[]/.test(p) || PARAM_NAME.test(p)
  );
  kept.forEach((p, k) => {
    const name = PARAM_NAME.exec(p)?.[1];
    if (name !== undefined && !out.has(name)) out.set(name, k);
  });
  return out;
}

/** A plain call's name: an identifier not after `.` or a word, then `(`. */
const CALL_NAME = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
/** The head of a definition, so the definition itself is not a call. */
const FUNCTION_HEAD = /function\s*\*?\s*$/;

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

const TS_ASSERT = /(?:^|[^\w$.])((?:assert|expect|fail)\w*)\s*\(/g;
const TS_THROW = /(?:^|[^\w$.])throw\b/g;
const TS_CALLEE = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
const TS_IGNORE = /\bignore\s*:\s*true\b/g;

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
  for (const m of body.matchAll(TS_ASSERT)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    named.add(open);
    found.push(tsStrength(body, m[1]!, open));
  }
  for (const m of body.matchAll(HELPER_CALL)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (!named.has(open)) found.push("strong");
  }
  if (body.search(TS_THROW) >= 0) found.push("strong");
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

/** Whether a TS call is one `calleesIn` returns: not a keyword, not after `new`. */
function keptCall(name: string, before: string): boolean {
  return !TS_KEYWORDS.has(name) && !/new\s*$/.test(before);
}

/** Names of the plain (not method, not path) calls in a masked body. */
function calleesIn(body: string, lang: Lang): string[] {
  const out = new Set<string>();
  const re = lang === "rust" ? /(?:^|[^\w.:])([a-z_]\w*)\s*\(/g : TS_CALLEE;
  for (const m of body.matchAll(re)) {
    const name = m[1]!;
    const before = body.slice(Math.max(0, (m.index ?? 0) - 4), m.index ?? 0);
    const kept = lang === "rust"
      ? !RUST_KEYWORDS.has(name) && !/new\s*$/.test(before)
      : keptCall(name, before);
    if (kept) out.add(name);
  }
  return [...out];
}

/** What a body's calls add: the assertions of the functions it calls. */
interface Delegation {
  out: Strength[];
  /** A call out of view in an edited file: it may assert, so a note. */
  unseen: boolean;
}

const NONE: Delegation = { out: [], unseen: false };
const NO_SKIP: ReadonlySet<string> = new Set();

/**
 * What calling a name adds, keyed `${isNew}:${depth}:${name}`; one map per
 * file per scan (Issue #5236).
 */
type CalleeMemo = Map<string, Delegation>;

/** Only which strengths occur is ever read, so repeats are dropped (Issue #5236). */
function distinct(found: Strength[]): Strength[] {
  return [...new Set(found)];
}

const WEAK = 1; // a weak assertion (Issue #5236)
const STRONG = 2; // a strong or interaction assertion: anything not weak (Issue #5236)
const UNSEEN = 4; // a call out of view that may assert (Issue #5236)

/** The strengths in `found` as WEAK and STRONG bits (Issue #5236). */
function strengthBits(found: readonly Strength[]): number {
  let b = 0;
  for (const s of found) b |= s === "weak" ? WEAK : STRONG;
  return b;
}

/** A delegation as bits: its strengths and whether a call is unseen (Issue #5236). */
function delegationBits(d: Delegation): number {
  return strengthBits(d.out) | (d.unseen ? UNSEEN : 0);
}

/** First index of the sorted `xs` whose value is at least `x` (Issue #5236). */
function lowerBound(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** OR of `bits[lo..hi)` (three-bit values) by prefix counts (Issue #5236). */
function rangeOr(
  bits: readonly number[],
): (lo: number, hi: number) => number {
  const prefix = [0, 1, 2].map(() => new Int32Array(bits.length + 1));
  for (let k = 0; k < bits.length; k++) {
    for (let b = 0; b < 3; b++) {
      prefix[b]![k + 1] = prefix[b]![k]! + ((bits[k]! >> b) & 1);
    }
  }
  return (lo, hi) => {
    if (hi <= lo) return 0;
    let r = 0;
    for (let b = 0; b < 3; b++) {
      if (prefix[b]![hi]! > prefix[b]![lo]!) r |= 1 << b;
    }
    return r;
  };
}

/**
 * Visits each position of a sorted list once however many ranges cover it, so
 * nested bodies do not re-read what they share (Issue #5236).
 */
function visitOnce(
  positions: readonly number[],
): (from: number, to: number, fn: (p: number) => void) => void {
  const next = Int32Array.from({ length: positions.length + 1 }, (_, k) => k);
  const find = (k: number): number => {
    let r = k;
    while (next[r] !== r) r = next[r]!;
    while (next[k] !== r) {
      const up = next[k]!;
      next[k] = r;
      k = up;
    }
    return r;
  };
  return (from, to, fn) => {
    for (
      let k = find(lowerBound(positions, from));
      k < positions.length && positions[k]! < to;
      k = find(k + 1)
    ) {
      next[k] = k + 1;
      fn(positions[k]!);
    }
  };
}

/** One call `TS_CALLEE` reads in a hunk (Issue #5236). */
interface CallMatch {
  start: number;
  end: number;
  name: string;
  /** Not a keyword or after `new`: a call calleesIn returns. */
  kept: boolean;
}

/** Every call of a hunk, read once (Issue #5236). */
interface CallIndex {
  calls: CallMatch[];
  starts: number[];
  /** Positions in `calls` of each kept name, in order. */
  byName: Map<string, number[]>;
}

/** The calls of a masked hunk, from one pass over it (Issue #5236). */
function callIndex(masked: string): CallIndex {
  const calls: CallMatch[] = [];
  const starts: number[] = [];
  const byName = new Map<string, number[]>();
  for (const m of masked.matchAll(TS_CALLEE)) {
    const start = m.index ?? 0;
    const name = m[1]!;
    const kept = keptCall(name, masked.slice(Math.max(0, start - 4), start));
    if (kept) {
      const list = byName.get(name) ?? [];
      list.push(calls.length);
      byName.set(name, list);
    }
    starts.push(start);
    calls.push({ start, end: start + m[0].length, name, kept });
  }
  return { calls, starts, byName };
}

/**
 * The calls `calleesIn(masked.slice(from, close + 1), "ts")` would read, taken
 * from the hunk's index. `masked[from]` is a bracket and `masked[close]` its
 * closing `)`. A hunk call that runs over `from` (the `test(` before an inline
 * body consumes the `(` the slice can use as a prefix) means the slice can read
 * a call the hunk does not; those are re-read with a sticky regex at that
 * bracket until the two readings agree, and the index is used from there.
 * `head` is the re-read calls, `rest` the first index call the slice reads and
 * `stop` the first one past it (Issue #5236).
 */
function sliceCalls(
  masked: string,
  index: CallIndex,
  from: number,
  close: number,
): { head: CallMatch[]; rest: number; stop: number } {
  const sticky = new RegExp(TS_CALLEE.source, "y");
  const head: CallMatch[] = [];
  let at = from;
  let rest = -1;
  while (rest < 0) {
    const k = lowerBound(index.starts, at) - 1;
    const over = k >= 0 && index.calls[k]!.end > at ? index.calls[k]! : null;
    if (over === null) {
      rest = lowerBound(index.starts, at);
      break;
    }
    sticky.lastIndex = over.end - 1;
    const m = sticky.exec(masked);
    if (m === null || m.index + m[0].length > close + 1) {
      rest = lowerBound(index.starts, over.end);
      break;
    }
    const start = m.index;
    head.push({
      start,
      end: start + m[0].length,
      name: m[1]!,
      kept: keptCall(m[1]!, masked.slice(Math.max(from, start - 4), start)),
    });
    at = start + m[0].length;
  }
  return { head, rest, stop: Math.max(rest, lowerBound(index.starts, close)) };
}

/**
 * The kept call names in `wanted` that the slice reads, in first-occurrence
 * order (Issue #5236).
 */
function sliceCallNames(
  masked: string,
  index: CallIndex,
  from: number,
  close: number,
  wanted: ReadonlySet<string>,
): string[] {
  const { head, rest, stop } = sliceCalls(masked, index, from, close);
  const found = new Map<string, number>();
  for (const c of head) {
    if (c.kept && wanted.has(c.name) && !found.has(c.name)) {
      found.set(c.name, c.start);
    }
  }
  for (const name of wanted) {
    if (found.has(name)) continue;
    const list = index.byName.get(name);
    if (list === undefined) continue;
    const p = lowerBound(list, rest);
    if (p < list.length && list[p]! < stop) {
      found.set(name, index.calls[list[p]!]!.start);
    }
  }
  return [...found].sort((x, y) => x[1] - y[1]).map(([name]) => name);
}

/**
 * Every assertion of a masked TS hunk with its start, and the OR of the
 * strength bits over a range of them (Issue #5236). Built after `scanHunk`, so
 * the strengths read the bracket table.
 */
function assertionIndex(
  masked: string,
): { starts: number[]; or: (lo: number, hi: number) => number } {
  const entries: Array<[number, Strength]> = [];
  const named = new Set<number>();
  for (const m of masked.matchAll(TS_ASSERT)) {
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    named.add(open);
    entries.push([at, tsStrength(masked, m[1]!, open)]);
  }
  for (const m of masked.matchAll(HELPER_CALL)) {
    const at = m.index ?? 0;
    if (!named.has(at + m[0].length - 1)) entries.push([at, "strong"]);
  }
  for (const m of masked.matchAll(TS_THROW)) {
    entries.push([m.index ?? 0, "strong"]);
  }
  entries.sort((x, y) => x[0] - y[0]);
  return {
    starts: entries.map(([at]) => at),
    or: rangeOr(entries.map(([, s]) => strengthBits([s]))),
  };
}

/**
 * What the calls in `body` add: the assertions of each function it calls that
 * is defined in view, one level deep and then one more. A callee named in
 * `skip` is ignored here (a parameter the caller judges at its own call
 * sites); a call out of view is unseen in an edited file. Each callee's share
 * is worked out once per scan (Issue #5236).
 */
function delegatedAssertions(
  body: string,
  lang: Lang,
  defs: Map<string, string | null>,
  isNew: boolean,
  depth: number,
  skip: ReadonlySet<string>,
  memo: CalleeMemo,
): Delegation {
  const out: Strength[] = [];
  let unseen = false;
  for (const name of calleesIn(body, lang)) {
    if (skip.has(name)) continue;
    const c = calleeAssertions(name, lang, defs, isNew, depth, memo);
    out.push(...c.out);
    unseen ||= c.unseen;
  }
  return { out: distinct(out), unseen };
}

/** What calling `name` adds at `depth`, worked out once per memo (Issue #5236). */
function calleeAssertions(
  name: string,
  lang: Lang,
  defs: Map<string, string | null>,
  isNew: boolean,
  depth: number,
  memo: CalleeMemo,
): Delegation {
  const key = `${isNew}:${depth}:${name}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const helper = defs.get(name);
  let result: Delegation;
  if (helper === undefined || helper === null) {
    result = { out: [], unseen: !isNew || helper === null };
  } else {
    const out = assertionsIn(helper, lang);
    let unseen = false;
    if (depth < 2) {
      const deeper = delegatedAssertions(
        helper,
        lang,
        defs,
        isNew,
        depth + 1,
        NO_SKIP,
        memo,
      );
      out.push(...deeper.out);
      unseen = deeper.unseen;
    }
    result = { out: distinct(out), unseen };
  }
  memo.set(key, result);
  return result;
}

/** A registration helper's callback positions one test registration passes. */
interface Registration {
  indices: number[];
  /** The wrapper's own assertions, judged with each call of the helper. */
  wrapper: Delegation;
}

/** An inline test body that calls a parameter of an enclosing helper. */
interface Candidate {
  h: number;
  file: string;
  isNew: boolean;
  open: number;
  close: number;
  /** Per helper: the positions of the parameters the body calls. */
  byHelper: Map<string, { indices: number[]; names: Set<string> }>;
}

/**
 * Add a registration to a helper's list. A pass-through registration (wrapper
 * NONE) at a position already listed is not added twice, so a helper with many
 * registrations costs one judgement per call.
 */
function addRegistration(
  regs: Map<string, Registration[]>,
  helper: string,
  reg: Registration,
): void {
  const list = regs.get(helper) ?? [];
  const listed = reg.wrapper === NONE &&
    list.some((r) => r.wrapper === NONE && r.indices[0] === reg.indices[0]);
  if (!listed) list.push(reg);
  regs.set(helper, list);
}

/** Longest return-type annotation the body search steps over. */
const MAX_RETURN_TYPE_CHARS = 2000;

/**
 * Where a TS function's body search starts: past a `:` return-type
 * annotation, so the `{` of an object type literal in it is not taken for
 * the body (Issue #5065). For an arrow it stops at the `=>` that ends the
 * annotation. -1 when the annotation does not end in view.
 */
function afterReturnType(masked: string, from: number, arrow: boolean): number {
  let i = from;
  while (i < masked.length && /\s/.test(masked[i]!)) i++;
  if (masked[i] !== ":") return from;
  i++;
  const limit = Math.min(masked.length, i + MAX_RETURN_TYPE_CHARS);
  let angle = 0;
  let typeExpected = true;
  // SIMPLE-ON-PURPOSE: steps over at most 2,000 characters of return type, so many definitions cannot make the scan quadratic — upgrade when a real helper's return type exceeds 2,000 characters
  while (i < limit) {
    const c = masked[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "=" && masked[i + 1] === ">") {
      if (angle === 0 && arrow) return i;
      i += 2;
      typeExpected = true;
    } else if (c === "{" && angle === 0 && !typeExpected) {
      return i;
    } else if (c === "(" || c === "[" || c === "{") {
      const close = closingBracket(masked, i);
      if (close < 0) return -1;
      i = close + 1;
      typeExpected = false;
    } else if (c === "<") {
      angle++;
      typeExpected = true;
      i++;
    } else if (c === ">") {
      angle--;
      if (angle < 0) return -1;
      typeExpected = false;
      i++;
    } else if (c === "|" || c === "&" || c === "," || c === ":" || c === "?") {
      typeExpected = true;
      i++;
    } else if (c === ";" || (c === "=" && angle === 0)) {
      return -1;
    } else {
      typeExpected = false;
      i++;
    }
  }
  return -1;
}

/**
 * A function defined in view: its name, its parameter list and its body span.
 */
interface Definition {
  name: string;
  declaration: number;
  /** Parameter name to its position, parsed once. */
  params: Map<string, number>;
  /**
   * Inclusive body offsets. `end` is -1 when the body runs past the hunk or
   * cannot be found.
   */
  start: number;
  end: number;
}

/**
 * Functions defined in view, with their parameter lists and body spans. A TS
 * return-type annotation is stepped over first (Issue #5065).
 */
function definitionSpans(masked: string, lang: Lang): Definition[] {
  const out: Definition[] = [];
  const push = (name: string, paren: number, start: number, end: number) =>
    out.push({
      name,
      declaration: paren,
      params: lang === "ts" && end >= 0 ? paramNames(masked, paren) : new Map(),
      start,
      end,
    });
  const re = lang === "rust"
    ? /\bfn\s+([A-Za-z_]\w*)/g
    : /(?:^|[^\w$.])(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,120})?=\s*(?:async\s*)?(?:function\b|\())/g;
  for (const m of masked.matchAll(re)) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    const from = (m.index ?? 0) + m[0].length;
    const paren = masked.indexOf("(", from - 1);
    const paramsEnd = paren < 0 ? -1 : closingBracket(masked, paren);
    if (paramsEnd < 0) {
      push(name, paren, -1, -1);
      continue;
    }
    const arrow = lang === "ts" && m[0].endsWith("(");
    const bodyFrom = lang === "ts"
      ? afterReturnType(masked, paramsEnd + 1, arrow)
      : paramsEnd + 1;
    if (bodyFrom < 0) {
      push(name, paren, -1, -1);
      continue;
    }
    const rest = masked.slice(bodyFrom);
    const brace = masked.indexOf("{", bodyFrom);
    const arrowExpr = lang === "ts" && /^\s*=>\s*[^{\s]/.test(rest);
    if (arrowExpr) {
      const nl = masked.indexOf("\n", bodyFrom);
      push(name, paren, bodyFrom, (nl < 0 ? masked.length : nl) - 1);
      continue;
    }
    const close = brace < 0 ? -1 : closingBracket(masked, brace);
    push(name, paren, brace, close);
  }
  return out;
}

/**
 * Functions defined in view (name to masked body, or null when the body runs
 * past its hunk), so a test that delegates to a helper is judged by the
 * helper's assertions. A name already holding a body keeps it.
 */
function definitionsIn(
  masked: string,
  lang: Lang,
  into: Map<string, string | null>,
) {
  for (const d of definitionSpans(masked, lang)) {
    if (into.get(d.name)) continue;
    into.set(d.name, d.end < 0 ? null : masked.slice(d.start, d.end + 1));
  }
}

/**
 * A hunk's definitions indexed by where they sit in its bracket structure, so
 * a lookup walks up from the registration instead of over every definition
 * that shares a name (PR #5232).
 */
interface Scope {
  /** Innermost opener enclosing each offset, or -1 at the top level. */
  enclosing: Int32Array;
  /** A brace-bodied definition by the offset of its body's `{`. */
  byBody: Map<number, Definition>;
  /** Expression-bodied arrows (one line each) by the offset of their line. */
  arrowsByLine: Map<number, Definition[]>;
  /** The first definition of a name in a scope, keyed `${opener}:${name}`. */
  byScopeName: Map<string, Definition>;
  /** No bracket is cut, so ancestry in view is the whole ancestry. */
  balanced: boolean;
  /**
   * The innermost definition body enclosing each offset, so a lookup skips
   * the brackets between them (Issue #5236).
   */
  defEnclosing: Int32Array;
}

function scopeOf(masked: string, spans: Definition[]): Scope {
  // A definition is visible only inside every bracket surrounding its
  // declaration; the innermost one stands for all of them.
  const enclosing = new Int32Array(masked.length).fill(-1);
  const brackets: number[] = [];
  for (let k = 0; k < masked.length; k++) {
    while (
      brackets.length &&
      closingBracket(masked, brackets[brackets.length - 1]!) < k
    ) brackets.pop();
    enclosing[k] = brackets[brackets.length - 1] ?? -1;
    if ("([{".includes(masked[k]!)) brackets.push(k);
  }
  const byBody = new Map<number, Definition>();
  const arrowsByLine = new Map<number, Definition[]>();
  const byScopeName = new Map<string, Definition>();
  for (const d of spans) {
    if (d.end < 0) continue;
    if (masked[d.start] === "{") byBody.set(d.start, d);
    else {
      const line = masked.lastIndexOf("\n", d.start) + 1;
      arrowsByLine.set(line, [...(arrowsByLine.get(line) ?? []), d]);
    }
    const key = `${enclosing[d.declaration] ?? -1}:${d.name}`;
    if (!byScopeName.has(key)) byScopeName.set(key, d);
  }
  const defEnclosing = new Int32Array(masked.length).fill(-1);
  for (let k = 0; k < masked.length; k++) {
    const b = enclosing[k]!;
    defEnclosing[k] = b < 0 ? -1 : byBody.has(b) ? b : defEnclosing[b]!;
  }
  // A cut block has unknown ancestry: callback scope is not inferred from it.
  const stack: string[] = [];
  let balanced = true;
  for (const c of masked) {
    if ("([{".includes(c)) stack.push(c);
    else if (")]}".includes(c) && stack.pop() !== "([{"[")]}".indexOf(c)]) {
      balanced = false;
      break;
    }
  }
  return {
    enclosing,
    byBody,
    arrowsByLine,
    byScopeName,
    balanced: balanced && stack.length === 0,
    defEnclosing,
  };
}

/**
 * The registration helper a callback belongs to: the innermost function in
 * view that encloses the call at `open` and takes `name` as a parameter, with
 * that parameter's position. Null when the callback is not such a parameter.
 */
function registrarOf(
  scope: Scope,
  masked: string,
  open: number,
  name: string,
): { helper: string; index: number } | null {
  let best: { helper: string; index: number; start: number } | null = null;
  const line = masked.lastIndexOf("\n", open) + 1;
  for (const d of scope.arrowsByLine.get(line) ?? []) {
    const index = d.params.get(name);
    if (index === undefined || d.start >= open || open >= d.end) continue;
    if (best === null || d.start > best.start) {
      best = { helper: d.name, index, start: d.start };
    }
  }
  for (
    let b = scope.defEnclosing[open] ?? -1;
    b >= 0;
    b = scope.defEnclosing[b]!
  ) {
    if (best !== null && b < best.start) break;
    const d = scope.byBody.get(b)!;
    const index = d.params.get(name);
    if (index !== undefined) {
      if (best === null || d.start > best.start) {
        best = { helper: d.name, index, start: d.start };
      }
      break;
    }
  }
  return best === null ? null : { helper: best.helper, index: best.index };
}

/**
 * Every parameter name of the functions that enclose the call at `open`: the
 * arrows on its line and the definitions on its enclosing chain. A name not in
 * it has no registrar (Issue #5236).
 */
function enclosingParams(
  scope: Scope,
  masked: string,
  open: number,
): Set<string> {
  const names = new Set<string>();
  const line = masked.lastIndexOf("\n", open) + 1;
  for (const d of scope.arrowsByLine.get(line) ?? []) {
    if (d.start < open && open < d.end) {
      for (const n of d.params.keys()) names.add(n);
    }
  }
  for (
    let b = scope.defEnclosing[open] ?? -1;
    b >= 0;
    b = scope.defEnclosing[b]!
  ) {
    for (const n of scope.byBody.get(b)!.params.keys()) names.add(n);
  }
  return names;
}

/**
 * The body of the definition a named callback at `at` resolves to: the
 * innermost same-named definition whose scope encloses the registration. Null
 * when it is a helper's parameter, out of view, or the hunk cuts a block.
 */
function namedCallbackBody(
  scope: Scope,
  masked: string,
  name: string,
  at: number,
): string | null {
  if (!scope.balanced) return null;
  if (registrarOf(scope, masked, at, name) !== null) return null;
  for (let b = scope.enclosing[at] ?? -1;; b = scope.enclosing[b]!) {
    const d = scope.byScopeName.get(`${b}:${name}`);
    if (d !== undefined) return masked.slice(d.start, d.end + 1);
    if (b < 0) return null;
  }
}

const RUST_TEST_ATTR = /#\[\s*(?:[A-Za-z_]\w*::)*test\b[^\]\n]*\]/g;
const TS_TEST_START =
  /(?:^|[^\w$.])(Deno\.test(?:\.ignore|\.only)?|it(?:\.skip|\.only|\.todo)?|test(?:\.skip|\.only|\.todo)?|xit|xtest|describe\.skip|xdescribe)\s*\(/g;

/** Whether a {@link TS_TEST_START} token registers a skipped test. */
function isSkipToken(token: string): boolean {
  return /\.(?:ignore|skip|todo)$|^x/.test(token);
}

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
 * A callback registered by name, or through a registration helper's callback
 * parameter (judged at each call of that helper), is judged by the function it
 * names; a callback the diff cannot resolve is a note. An inline test body that
 * calls a parameter of the enclosing helper, and does not assert enough by
 * itself, is judged at each call of that helper, with the wrapper's own
 * assertions counted and only the callback arguments that registration invokes
 * (not another registration's); with no call in view it is a note.
 */
export function scanDummyTests(diff: string): DummyTestScan {
  hunkBrackets = null;
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
  // Per file: a registration helper's name to its registrations, each with
  // the callback positions it passes and the wrapper's own assertions
  // (Issue #5233).
  const registrars = new Map<string, Map<string, Registration[]>>();
  // Inline test bodies that call a helper's parameter, judged after the first
  // pass; those whose own assertions do not stand alone are deferred to the
  // helper's calls, keyed `${hunk}:${open}` to the helpers they are judged by.
  const candidates: Candidate[] = [];
  const deferredRegs = new Map<string, string[]>();
  // Each hunk is masked and indexed once; the second pass reuses both, so
  // its bracket lookups hit the same table.
  const maskedByHunk: string[] = [];
  const scopeByHunk: Scope[] = [];
  const callsByHunk: CallIndex[] = [];
  const callsOf = (
    h: number,
  ) => (callsByHunk[h] ??= callIndex(maskedByHunk[h]!));
  // What each callee adds, worked out once per file per scan (Issue #5236).
  const memos = new Map<string, CalleeMemo>();
  const memoFor = (file: string): CalleeMemo => {
    let m = memos.get(file);
    if (m === undefined) {
      m = new Map();
      memos.set(file, m);
    }
    return m;
  };
  for (const [h, hunk] of hunks.entries()) {
    const lang = langOf(hunk.file);
    if (lang === null) continue;
    const masked = maskSource(hunk.lines.map((l) => l.text).join("\n"), lang);
    scanHunk(masked);
    const spans = definitionSpans(masked, lang);
    const scope = scopeOf(masked, spans);
    maskedByHunk[h] = masked;
    scopeByHunk[h] = scope;
    const defs = definitions.get(hunk.file) ?? new Map();
    definitionsIn(masked, lang, defs);
    definitions.set(hunk.file, defs);
    if (lang === "ts") {
      const regs = registrars.get(hunk.file) ??
        new Map<string, Registration[]>();
      const testFile = TEST_PATH.test(hunk.file);
      for (const m of masked.matchAll(TS_TEST_START)) {
        if (!m[1]!.startsWith("Deno.") && !testFile) continue;
        if (m[1]!.includes("describe")) continue;
        const open = (m.index ?? 0) + m[0].length - 1;
        const cb = callbackName(masked, open);
        if (cb === null) {
          // An inline body may call a parameter of the helper it sits in. A
          // skipped test is never judged, so neither are its helper's calls.
          if (isSkipToken(m[1]!)) continue;
          const close = closingBracket(masked, open);
          if (close < 0) continue;
          const byHelper: Candidate["byHelper"] = new Map();
          const wanted = enclosingParams(scope, masked, open);
          const names = wanted.size > 0
            ? sliceCallNames(masked, callsOf(h), open, close, wanted)
            : [];
          for (const name of names) {
            const hit = registrarOf(scope, masked, open, name);
            if (hit === null) continue;
            const entry = byHelper.get(hit.helper) ??
              { indices: [], names: new Set<string>() };
            entry.indices.push(hit.index);
            entry.names.add(name);
            byHelper.set(hit.helper, entry);
          }
          if (byHelper.size > 0) {
            candidates.push({
              h,
              file: hunk.file,
              isNew: hunk.isNew,
              open,
              close,
              byHelper,
            });
          }
          continue;
        }
        const reg = registrarOf(scope, masked, open, cb);
        if (reg !== null) {
          addRegistration(regs, reg.helper, {
            indices: [reg.index],
            wrapper: NONE,
          });
        }
      }
      registrars.set(hunk.file, regs);
    }
  }

  // A candidate whose own assertions do not stand alone is judged at each call
  // of the helper it calls, with its own assertions counted (Issue #5233). The
  // definitions of every file are complete here, so the lookup is whole.
  for (const c of candidates) {
    const body = maskedByHunk[c.h]!.slice(c.open, c.close + 1);
    const skip = new Set<string>();
    for (const entry of c.byHelper.values()) {
      for (const name of entry.names) skip.add(name);
    }
    const deleg = delegatedAssertions(
      body,
      "ts",
      definitions.get(c.file)!,
      c.isNew,
      1,
      skip,
      memoFor(c.file),
    );
    const own = [...assertionsIn(body, "ts"), ...deleg.out];
    if (own.length > 0 && !own.every((s) => s === "weak")) continue;
    const wrapper: Delegation = { out: own, unseen: deleg.unseen };
    const regs = registrars.get(c.file) ?? new Map<string, Registration[]>();
    registrars.set(c.file, regs);
    for (const [helper, entry] of c.byHelper) {
      addRegistration(regs, helper, { indices: entry.indices, wrapper });
    }
    deferredRegs.set(`${c.h}:${c.open}`, [...c.byHelper.keys()]);
  }

  // Registrations whose callback is a helper's parameter, or whose body calls
  // one: each needs a call of one of its helpers in view, or it is a note at
  // its registration.
  const pending: Array<{ file: string; line: number; helpers: string[] }> = [];
  const called = new Map<string, Set<string>>();

  for (const [h, hunk] of hunks.entries()) {
    const lang = langOf(hunk.file);
    if (lang === null) continue;
    const masked = maskedByHunk[h]!;
    const scope = scopeByHunk[h]!;
    scanHunk(masked);
    const defs = definitions.get(hunk.file)!;
    const testFile = TEST_PATH.test(hunk.file);
    const starts: number[] = [];
    let offset = 0;
    for (const l of hunk.lines) {
      starts.push(offset);
      offset += l.text.length + 1;
    }
    const index = { starts };
    const maskedLines = masked.split("\n");
    const addedBefore = new Int32Array(hunk.lines.length + 1);
    hunk.lines.forEach((l, k) => {
      addedBefore[k + 1] = addedBefore[k]! + (l.added ? 1 : 0);
    });
    // Whether any line from `a` to `b` (inclusive) is added.
    const anyAdded = (a: number, b: number) =>
      addedBefore[b + 1]! > addedBefore[a]!;
    const visitInteractions = visitOnce(
      hunk.lines.flatMap((l, k) =>
        l.added && INTERACTION.test(maskedLines[k] ?? "") ? [k] : []
      ),
    );
    const visitIgnores = lang === "ts"
      ? visitOnce([...masked.matchAll(TS_IGNORE)].map((m) => m.index ?? 0))
      : null;
    // The assertions and callee strengths of the whole hunk, built on the
    // first inline body judged (Issue #5236).
    let inline: {
      asserts: ReturnType<typeof assertionIndex>;
      callOr: (lo: number, hi: number) => number;
    } | null = null;
    const inlineIndex = () =>
      inline ??= {
        asserts: assertionIndex(masked),
        callOr: rangeOr(
          callsOf(h).calls.map((c) =>
            c.kept
              ? delegationBits(
                calleeAssertions(
                  c.name,
                  "ts",
                  defs,
                  hunk.isNew,
                  1,
                  memoFor(hunk.file),
                ),
              )
              : 0
          ),
        ),
      };
    const judge = (
      declLine: number,
      reportLine: number,
      bodyStart: number,
      bodyEnd: number,
      lastLine: number,
      extra: Delegation,
      callback: string | null,
      spans: Array<[number, number]> | null = null,
    ) => {
      if (!anyAdded(declLine, lastLine)) return;
      visitInteractions(
        declLine,
        lastLine + 1,
        (k) => note(hunk.file, hunk.lines[k]!.line, "interaction"),
      );
      if (bodyEnd < 0) return; // body runs past the hunk: not judged
      const file = hunk.file;
      const line = hunk.lines[reportLine]!.line;
      let bits: number;
      if (lang === "ts" && spans === null && callback === null) {
        // An inline body: judged from the hunk's indexes, not re-read.
        const { asserts, callOr } = inlineIndex();
        const { head, rest, stop } = sliceCalls(
          masked,
          callsOf(h),
          bodyStart,
          bodyEnd,
        );
        bits = asserts.or(
          lowerBound(asserts.starts, bodyStart),
          lowerBound(asserts.starts, bodyEnd),
        ) | callOr(rest, stop) | delegationBits(extra);
        for (const c of head) {
          if (!c.kept) continue;
          bits |= delegationBits(
            calleeAssertions(
              c.name,
              "ts",
              defs,
              hunk.isNew,
              1,
              memoFor(hunk.file),
            ),
          );
        }
      } else {
        // A registration's own callback arguments: another registration's
        // arguments of the same helper call are not this test's body.
        let body = spans === null
          ? masked.slice(bodyStart, bodyEnd + 1)
          : spans.map(([a, b]) => masked.slice(a, b + 1)).join("\n");
        if (callback !== null) {
          // A callback passed by name is judged by the function it names.
          const named = namedCallbackBody(scope, masked, callback, bodyStart);
          if (named === null) {
            note(file, line, "unseen");
            return;
          }
          body = named;
        }
        const found = assertionsIn(body, lang);
        found.push(...extra.out);
        const helpers = delegatedAssertions(
          body,
          lang,
          defs,
          hunk.isNew,
          1,
          NO_SKIP,
          memoFor(hunk.file),
        );
        found.push(...helpers.out);
        bits = strengthBits(found) |
          (helpers.unseen || extra.unseen ? UNSEEN : 0);
      }
      if ((bits & (WEAK | STRONG)) === 0) {
        if (bits & UNSEEN) note(file, line, "unseen");
        else add(file, line, "no-assertion");
      } else if ((bits & STRONG) === 0) {
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
        const panic: Delegation = { out: ["strong"], unseen: false };
        judge(
          first,
          fnLine,
          open,
          close,
          last,
          shouldPanic ? panic : NONE,
          null,
        );
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
        const skipToken = isSkipToken(token);
        if (
          skipToken && decl.added &&
          !hasReasonComment(hunk.lines, maskedLines, declLine)
        ) {
          add(hunk.file, decl.line, "ignored-without-reason");
        }
        if (token.includes("describe")) continue;
        const bodyEnd = close < 0 ? masked.length : close;
        visitIgnores!(open, bodyEnd, (at) => {
          const k = lineAt(index, at);
          if (
            hunk.lines[k]!.added &&
            !hasReasonComment(hunk.lines, maskedLines, k)
          ) {
            add(hunk.file, hunk.lines[k]!.line, "ignored-without-reason");
          }
        });
        if (skipToken) continue; // a skipped test is judged by the rule above
        const cb = callbackName(masked, open);
        const reg = cb === null ? null : registrarOf(scope, masked, open, cb);
        const deferred = deferredRegs.get(`${h}:${open}`);
        if (reg !== null || deferred !== undefined) {
          // The callback is a helper's parameter, or the body calls one: each
          // call of that helper is judged.
          if (anyAdded(declLine, last)) {
            pending.push({
              file: hunk.file,
              line: decl.line,
              helpers: reg !== null ? [reg.helper] : deferred!,
            });
          }
        } else judge(declLine, declLine, open, close, last, NONE, cb);
      }
      if (testFile) {
        hunk.lines.forEach((l, k) => {
          if (l.added && INTERACTION.test(maskedLines[k] ?? "")) {
            note(hunk.file, l.line, "interaction");
          }
        });
      }
      const regs = registrars.get(hunk.file);
      if (regs !== undefined && regs.size > 0) {
        const calls = called.get(hunk.file) ?? new Set<string>();
        called.set(hunk.file, calls);
        for (const m of masked.matchAll(CALL_NAME)) {
          const helper = m[1]!;
          const list = regs.get(helper);
          if (list === undefined) continue;
          const at = m.index ?? 0;
          if (FUNCTION_HEAD.test(masked.slice(Math.max(0, at - 40), at))) {
            continue;
          }
          calls.add(helper);
          const open = at + m[0].length - 1;
          const declLine = lineAt(index, open);
          const close = closingBracket(masked, open);
          const last = close < 0 ? hunk.lines.length - 1 : lineAt(index, close);
          const inView = anyAdded(declLine, last);
          const args = flatArgs(masked, open);
          for (const reg of list) {
            const picked = reg.indices.map((k) => args?.[k]);
            if (picked.some((arg) => arg === undefined)) {
              if (inView) note(hunk.file, hunk.lines[declLine]!.line, "unseen");
            } else if (picked.length === 1) {
              const arg = picked[0]!;
              judge(
                declLine,
                declLine,
                open,
                close,
                last,
                reg.wrapper,
                REF.test(arg.flat) ? arg.flat : null,
                [[arg.start, arg.end]],
              );
            } else if (picked.some((arg) => REF.test(arg!.flat))) {
              // Several callbacks, one named: not resolved here, so a note.
              if (inView) note(hunk.file, hunk.lines[declLine]!.line, "unseen");
            } else {
              // One registered test invokes all of them: judged together.
              judge(
                declLine,
                declLine,
                open,
                close,
                last,
                reg.wrapper,
                null,
                picked.map((arg): [number, number] => [arg!.start, arg!.end]),
              );
            }
          }
        }
      }
    }
  }
  for (const p of pending) {
    if (!p.helpers.some((helper) => called.get(p.file)?.has(helper))) {
      note(p.file, p.line, "unseen");
    }
  }
  hunkBrackets = null;
  return { findings, notes };
}

/** The text of a reviewer-note checklist item; the reply copies it exactly. */
export function dummyTestNoteItem(note: DummyTestNote): string {
  const path = inlineSafe(note.file, 200).replace(/[^\w./ ()@+~[\]-]/g, "_");
  return note.kind === "interaction"
    ? `${path}:${note.line} asserts a mock interaction: met only if the test also asserts an observable outcome and the mock stands at a real external boundary (network, broker, clock).`
    : `${path}:${note.line} asserts nothing the diff shows: met only if a helper it calls, or the callback it registers, asserts an observable outcome.`;
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
      `The deterministic dummy-test scan found tests this change adds or edits that it cannot judge alone: a mock-interaction assertion, or a test with no visible assertion that calls a function, or registers a callback, out of view. A test that asserts which internal functions or mocks were called, how often or in what order is a "how" test, and a test that asserts nothing is a dummy test; both are refused by ${DUMMY_TEST_RULES_SECTION}. Report EVERY item below in the reply \`checklist\` array as \`met\`, \`missing\` or \`not applicable\`, copying the checklist name and the item text exactly. Any \`missing\` item is also a blocking finding.`,
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
