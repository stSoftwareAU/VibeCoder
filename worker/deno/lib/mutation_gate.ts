/**
 * Diff-scoped mutation gate (Issue #3393).
 *
 * A PR whose changed lines survive a mutation check (a mutant of an added line
 * leaves every covering test green) has tests that do not pin the behaviour
 * the PR claims to add. This module holds the pure half of that check: diff
 * parsing, Deno mutant generation, exemption parsing, the verdict and the
 * feedback comment. All process and filesystem work lives in
 * `mutation_runner.ts`.
 *
 * Every pattern here is bounded or hand-scanned so a hostile line cannot cause
 * backtracking; lines over {@link MAX_MUTATED_LINE_LENGTH} are not mutated and
 * are counted as untested (see {@link DenoMutantGeneration}).
 *
 * Australian English spelling used throughout.
 */

export type MutationLanguage = "rust" | "deno";

export interface Mutant {
  file: string;
  line: number;
  description: string;
}

export interface DenoMutant extends Mutant {
  /** Full mutated source of `file`. */
  mutatedSource: string;
}

export type MutationCheckResult =
  | { kind: "not_applicable"; reason: string }
  | {
    kind: "completed";
    language: MutationLanguage;
    survivors: Mutant[];
    killed: number;
    total: number;
  }
  | {
    kind: "budget_exhausted";
    language: MutationLanguage;
    survivors: Mutant[];
    killed: number;
    tested: number;
    /** Every candidate mutant, those not tried included. */
    total: number;
    budgetSeconds: number;
    /**
     * What ran out: absent means the wall-clock budget; `"mutant_cap"` means
     * the run finished inside its budget but candidate mutants beyond the cap
     * (or on over-long lines) were never tried.
     */
    limit?: "mutant_cap";
  }
  | { kind: "error"; reason: string };

export interface MutationGateVerdict {
  blocked: boolean;
  reason: string;
  survivors: Mutant[];
  exempted: Mutant[];
  budgetExhausted: boolean;
  note: string;
}

export const DEFAULT_MUTATION_BUDGET_SECONDS = 300;
export const DEFAULT_MUTANT_CAP = 40;

/** Lines longer than this are never mutated (bounds all per-line scanning). */
const MAX_MUTATED_LINE_LENGTH = 400;
/** Summary lines longer than this are ignored when reading exemptions. */
const MAX_SUMMARY_LINE_LENGTH = 2000;

const EXEMPT_MARKER = "exempt (untestable):";

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into new-file path (the `b/` side) -> added line
 * numbers. Deleted files (`+++ /dev/null`) are skipped. Hunk line counts are
 * honoured so an added line whose content starts with `++` is not mistaken for
 * a file header.
 */
export function parseAddedLines(diff: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let file: string | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (oldRemaining > 0 || newRemaining > 0) {
      const c = line.charAt(0);
      if (c === "+") {
        newRemaining--;
        if (file !== null) {
          const list = out.get(file) ?? [];
          list.push(newLine);
          out.set(file, list);
        }
        newLine++;
        continue;
      }
      if (c === "-") {
        oldRemaining--;
        continue;
      }
      if (c === " " || line === "") {
        oldRemaining--;
        newRemaining--;
        newLine++;
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file"
      // Anything else ends the hunk early; fall through to header handling.
      oldRemaining = 0;
      newRemaining = 0;
    }
    if (line.startsWith("diff ")) {
      file = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      let p = line.slice(4);
      const tab = p.indexOf("\t");
      if (tab >= 0) p = p.slice(0, tab);
      if (p === "/dev/null") file = null;
      else if (p.startsWith("b/")) file = p.slice(2);
      else file = p;
      continue;
    }
    const m = HUNK_HEADER.exec(line);
    if (m) {
      oldRemaining = m[1] === undefined ? 1 : Number(m[1]);
      newRemaining = m[3] === undefined ? 1 : Number(m[3]);
      newLine = Number(m[2]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deno mutant generation
// ---------------------------------------------------------------------------

/** True for `*_test.ts`, `*.test.ts` and friends. */
export function isDenoTestFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return /(?:_test|\.test)\.[a-z]+$/.test(base);
}

const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/;
const BOOLEAN_LITERAL = /\b(?:true|false)\b/g;
const CALL_HEAD = /^(?:await )?[A-Za-z_$][\w$.]*\(/;
const NON_CALL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "throw",
  "super",
  "import",
  "typeof",
  "void",
  "delete",
]);

/** Index of the paren matching the `(` at `open`, skipping strings; -1 if none. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && s[i + 1] === "/") return -1;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True when index `idx` of `s` is outside any string literal or `//` comment. */
function isCodeAt(s: string, idx: number): boolean {
  let quote = "";
  for (let i = 0; i < idx; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && s[i + 1] === "/") return false;
  }
  return quote === "";
}

function negateIf(line: string): string | null {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);
  let prefix = "";
  let rest = trimmed;
  if (rest.startsWith("} else ")) {
    prefix = "} else ";
    rest = rest.slice(prefix.length);
  }
  if (!rest.startsWith("if (")) return null;
  const open = 3;
  const close = matchingParen(rest, open);
  if (close < 0) return null;
  const cond = rest.slice(open + 1, close);
  if (cond.trim() === "") return null;
  return `${indent}${prefix}if (!(${cond}))${rest.slice(close + 1)}`;
}

/** True when the `=` at `i` is an assignment or arrow, not part of `==`, `<=` etc. */
function isAssignmentEquals(s: string, i: number): boolean {
  const prev = i > 0 ? s.charAt(i - 1) : "";
  const next = s.charAt(i + 1);
  return (prev === "" || !"=!<>".includes(prev)) && next !== "=";
}

const CONDITION_LEAD_KEYWORDS = ["return ", "yield ", "throw ", "case "];

/**
 * Index where the ternary condition ending just before `q` starts, or -1 when
 * it cannot be found safely. Scans backwards across the whole condition (so
 * `a === b ? x : y` yields `a === b`, not only `b`), stopping at an unmatched
 * opening bracket, a comma, `;`, `:`, `?`, an assignment or an arrow.
 */
function ternaryConditionStart(line: string, q: number): number {
  let depth = 0;
  for (let i = q - 1; i >= 0; i--) {
    const c = line.charAt(i);
    if (c === '"' || c === "'" || c === "`") {
      // Skip the whole string literal; an unmatched quote is unsafe to mutate.
      let j = i - 1;
      while (j >= 0 && !(line.charAt(j) === c && line.charAt(j - 1) !== "\\")) {
        j--;
      }
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) return i + 1;
      depth--;
    } else if (depth === 0) {
      if (c === "," || c === ";" || c === ":") return i + 1;
      if (c === "=" && isAssignmentEquals(line, i)) {
        return line.charAt(i + 1) === ">" ? i + 2 : i + 1;
      }
      if (
        c === "?" && line.charAt(i + 1) !== "." && line.charAt(i + 1) !== "?" &&
        line.charAt(i - 1) !== "?"
      ) return i + 1;
    }
  }
  return 0;
}

const STATEMENT_KEYWORD =
  /(?:^|[^\w$.])(?:if|else|return|throw|yield|case|export|default|const|let|var|for|while|do|switch|try)(?![\w$])/;

/**
 * Whether `cond` can stand alone inside `!(...)`: brackets balance and no
 * statement keyword sits outside a bracket. The backwards scan for a ternary's
 * condition runs to the start of the line, so `if (c) return a ? b : c;`
 * yields `if (c) return a`, and negating that would not parse.
 */
function isSingleExpression(cond: string): boolean {
  let depth = 0;
  let quote = "";
  let topLevel = "";
  for (let i = 0; i < cond.length; i++) {
    const c = cond.charAt(i);
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return false;
    } else if (depth === 0) topLevel += c;
  }
  return depth === 0 && quote === "" && !STATEMENT_KEYWORD.test(topLevel);
}

function negateTernary(line: string): string | null {
  let q = line.indexOf(" ? ");
  while (q > 0 && !isCodeAt(line, q)) q = line.indexOf(" ? ", q + 1);
  if (q <= 0 || line.indexOf(" : ", q) < 0) return null;
  let start = ternaryConditionStart(line, q);
  if (start < 0) return null;
  const skipSpaces = () => {
    while (start < q && line.charAt(start) === " ") start++;
  };
  skipSpaces();
  for (const kw of CONDITION_LEAD_KEYWORDS) {
    if (line.startsWith(kw, start)) {
      start += kw.length;
      skipSpaces();
      break;
    }
  }
  const cond = line.slice(start, q).trimEnd();
  if (cond === "" || !isCodeAt(line, start) || !isSingleExpression(cond)) {
    return null;
  }
  return `${line.slice(0, start)}!(${cond})${line.slice(q)}`;
}

function swapBoolean(line: string): { text: string; from: string } | null {
  BOOLEAN_LITERAL.lastIndex = 0;
  for (const m of line.matchAll(BOOLEAN_LITERAL)) {
    if (!isCodeAt(line, m.index)) continue;
    const to = m[0] === "true" ? "false" : "true";
    return {
      text: line.slice(0, m.index) + to + line.slice(m.index + m[0].length),
      from: m[0],
    };
  }
  return null;
}

function replaceReturn(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("return ") || !trimmed.endsWith(";")) return null;
  const expr = trimmed.slice(7, -1).trim();
  if (expr === "" || expr.includes(";")) return null;
  const indent = line.slice(0, line.length - line.trimStart().length);
  let replacement: string;
  if (expr === "true") replacement = "false";
  else if (expr === "false") replacement = "true";
  else if (NUMERIC_LITERAL.test(expr)) replacement = expr === "0" ? "1" : "0";
  else if (
    expr.length >= 2 && (expr[0] === '"' || expr[0] === "'") &&
    expr[expr.length - 1] === expr[0] &&
    !expr.slice(1, -1).includes(expr[0])
  ) replacement = '""';
  else replacement = "undefined";
  if (replacement === expr) return null;
  return `${indent}return ${replacement};`;
}

function deleteCall(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.endsWith(");") || !CALL_HEAD.test(trimmed)) return null;
  const head = trimmed.startsWith("await ") ? trimmed.slice(6) : trimmed;
  const name = head.slice(0, head.indexOf("("));
  if (NON_CALL_KEYWORDS.has(name)) return null;
  const open = trimmed.indexOf("(");
  if (matchingParen(trimmed, open) !== trimmed.length - 2) return null;
  return "";
}

// ---------------------------------------------------------------------------
// Wiring mutants (Issue #3601)
// ---------------------------------------------------------------------------
//
// The call-site rule asks for a manual revert of each caller's change, and it
// keeps being skipped. These operators make the gate perform it: delete an
// object-literal property, delete an array element, and revert a renamed
// property value to the shorthand. The runner runs mutants with `--no-check`,
// so a mutant of a type-only line would survive and block a PR on a line no
// test can pin. A line is therefore mutated only when a scan of the whole file
// places it directly inside an object or array literal, and a file whose
// brackets do not balance gets no wiring mutants at all (fail safe).

/** What the innermost open bracket at the start of a line belongs to. */
export type LineContext = "object" | "array" | "other";

type Frame =
  | "object"
  | "array"
  | "paren"
  | "block"
  | "type"
  | "generic"
  | "template"
  | "template-expr";

const IDENT_CHAR = /[\w$]/;
/** Characters after which a `/` starts a regex literal rather than dividing. */
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";
const TYPE_ALIAS_LINE = /^\s*(?:export\s+)?(?:declare\s+)?type\s/;

/**
 * Context at the start of every line of `source`, or `null` when the scan
 * cannot be trusted (a closer that does not match its opener, or a string,
 * comment or bracket left open at the end). Linear in the source length.
 */
export function lineContexts(source: string): LineContext[] | null {
  const contexts: LineContext[] = [];
  // Template literals sit on the same stack as brackets, so a `${}` holding
  // its own braces or parens nests correctly: `template` is the literal's
  // text, `template-expr` one of its `${}` expressions.
  const stack: Frame[] = [];
  let prevSig = "";
  let prevWord = "";
  let lineStart = 0;
  const top = (): Frame | undefined => stack[stack.length - 1];
  const inType = () => stack.some((f) => f === "type" || f === "generic");
  const record = () => {
    const t = top();
    contexts.push(
      t === "object" ? "object" : t === "array" ? "array" : "other",
    );
  };
  record();
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\n") {
      lineStart = i + 1;
      record();
      continue;
    }
    // Inside a template literal's text: only `` ` `` and `${` matter.
    if (top() === "template") {
      if (c === "\\") i++;
      else if (c === "`") {
        stack.pop();
        prevSig = "`";
      } else if (c === "$" && source[i + 1] === "{") {
        stack.push("template-expr");
        i++;
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") continue;
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return null;
      for (let j = i; j < end; j++) {
        if (source[j] === "\n") {
          lineStart = j + 1;
          contexts.push("other");
        }
      }
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") {
        if (source[j] === "\\") j++;
        j++;
      }
      if (source[j] !== c) return null;
      i = j;
      prevSig = c;
      continue;
    }
    if (c === "`") {
      stack.push("template");
      continue;
    }
    if (
      c === "/" &&
      (prevSig === "" || REGEX_PRECEDERS.includes(prevSig) ||
        prevWord === "return" || prevWord === "typeof")
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        const d = source[j];
        if (d === "\\") j++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      if (source[j] !== "/") return null;
      i = j;
      prevSig = "/";
      prevWord = "";
      continue;
    }
    if (IDENT_CHAR.test(c)) {
      let j = i;
      while (j + 1 < source.length && IDENT_CHAR.test(source[j + 1]!)) j++;
      prevWord = source.slice(i, j + 1);
      prevSig = source[j]!;
      i = j;
      continue;
    }
    if (c === "{") {
      let frame: Frame;
      if (inType()) frame = "type";
      else if (prevSig === "=" && source[i - 1] !== ">") {
        const lineText = source.slice(lineStart, i);
        frame = TYPE_ALIAS_LINE.test(lineText) ? "type" : "object";
      } else if ("(,[?".includes(prevSig) && prevSig !== "") frame = "object";
      else if (prevSig === ":") frame = top() === "object" ? "object" : "type";
      else if (prevWord === "return" && prevSig === "n") frame = "object";
      else frame = "block";
      stack.push(frame);
    } else if (c === "[") {
      if (inType()) stack.push("type");
      else if (IDENT_CHAR.test(prevSig) && prevWord !== "return") {
        stack.push("paren"); // index access or a type such as `string[]`
      } else if (prevSig === ")" || prevSig === "]") stack.push("paren");
      else if (prevSig === ":") {
        stack.push(top() === "object" ? "array" : "type");
      } else if (
        prevSig === "=" && TYPE_ALIAS_LINE.test(source.slice(lineStart, i))
      ) {
        stack.push("type");
      } else stack.push("array");
    } else if (c === "(") {
      stack.push(inType() ? "type" : "paren");
    } else if (c === "<" && IDENT_CHAR.test(source[i - 1] ?? "")) {
      stack.push("generic");
    } else if (c === ">" && top() === "generic" && source[i - 1] !== "=") {
      stack.pop();
    } else if (c === "}" || c === "]" || c === ")") {
      const open = stack.pop();
      if (open === undefined) return null;
      if (open === "template-expr") {
        if (c !== "}") return null;
        prevSig = "`";
        continue;
      }
      const expected = open === "object" || open === "block"
        ? "}"
        : open === "array"
        ? "]"
        : open === "paren"
        ? (c === "]" ? "]" : ")")
        : open === "generic"
        ? ">"
        : c; // a type frame closes with whatever opened it
      if (open === "generic" || c !== expected) return null;
    }
    prevSig = c;
    if (c !== ".") {
      prevWord = c === "{" || c === "(" || c === "[" ? "" : prevWord;
    }
  }
  if (stack.length > 0) return null;
  return contexts;
}

const SIMPLE_KEY = /^[A-Za-z_$][\w$]*$/;
/** Values that read as identifiers but are literals, never a renamed variable. */
const LITERAL_VALUES: ReadonlySet<string> = new Set([
  "null",
  "undefined",
  "true",
  "false",
  "this",
  "NaN",
  "Infinity",
]);
const SHORTHAND_ENTRY = /^(?:\.\.\.)?[A-Za-z_$][\w$.]*,?$/;
const KEYED_ENTRY = /^([A-Za-z_$][\w$]*|"[^"\\]*"|'[^'\\]*')\s*:\s*(.+?),?$/;
const ARRAY_ELEMENT = /^(?:"[^"\\]*"|'[^'\\]*'|[A-Za-z_$][\w$.]*),?$/;
const CONTINUES = /(?:[+\-*/%&|^?:.=<>!]|\bas|\b(?:new|await|typeof))$/;

/**
 * Whether a property or element line is a whole entry: the code line before
 * it ended an entry or opened the literal (so it does not continue an
 * expression such as `"a " +`), and it ends where it stands.
 */
function standsAlone(
  trimmed: string,
  lines: readonly string[],
  n: number,
): boolean {
  if (!isSingleExpression(trimmed.replace(/,$/, ""))) return false;
  for (let i = n - 2; i >= 0; i--) {
    const prev = (lines[i] ?? "").trim();
    if (prev === "" || prev.startsWith("//")) continue;
    if (!/[,[{]$/.test(prev)) return false;
    break;
  }
  const body = trimmed.replace(/,$/, "").trimEnd();
  if (CONTINUES.test(body)) return false;
  if (trimmed.endsWith(",")) return true;
  for (let i = n; i < lines.length; i++) {
    const next = (lines[i] ?? "").trim();
    if (next === "") continue;
    return next.startsWith("}") || next.startsWith("]");
  }
  return false;
}

/** The display name of a property entry: its key, or the spread expression. */
function entryName(entry: string): string {
  const keyed = KEYED_ENTRY.exec(entry);
  return keyed ? keyed[1]! : entry.replace(/,$/, "");
}

/**
 * Whether `name` appears as a bare identifier (not a member `.name`) within
 * the 200 lines before line `n`: a cheap stand-in for "in scope". A wrong
 * guess only yields a mutant that throws at runtime and is caught, never a
 * false survivor.
 */
function nameInUse(name: string, lines: readonly string[], n: number): boolean {
  // A plain scan, not a RegExp built from `name`: identifiers may hold `$`,
  // which a pattern would read as an anchor.
  const isIdent = (c: string | undefined) =>
    c !== undefined && IDENT_CHAR.test(c);
  for (let i = Math.max(0, n - 201); i < n - 1; i++) {
    const text = lines[i] ?? "";
    if (text.length > MAX_MUTATED_LINE_LENGTH) continue;
    for (
      let at = text.indexOf(name);
      at >= 0;
      at = text.indexOf(name, at + 1)
    ) {
      const before = text[at - 1];
      if (isIdent(before) || before === ".") continue;
      if (isIdent(text[at + name.length])) continue;
      return true;
    }
  }
  return false;
}

/**
 * Split the top-level comma-separated entries of a single-line `{ ... }`.
 * Returns null when the text does not split cleanly.
 */
function splitEntries(inner: string): string[] | null {
  const entries: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      entries.push(inner.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) return null;
  }
  if (depth !== 0 || quote) return null;
  const last = inner.slice(start).trim();
  if (last !== "") entries.push(last);
  return entries.length > 0 && entries.every((e) => e !== "") ? entries : null;
}

/** Delete one entry of a single-line object literal argument `f({ a, ...b })`. */
function deleteInlineProperty(
  line: string,
): { text: string; name: string } | null {
  for (
    let open = line.indexOf("{");
    open >= 0;
    open = line.indexOf("{", open + 1)
  ) {
    if (!isCodeAt(line, open)) continue;
    const before = line.slice(0, open).trimEnd();
    if (!/[(,[]$/.test(before)) continue;
    const close = line.indexOf("}", open);
    if (close < 0) return null;
    const inner = line.slice(open + 1, close);
    if (inner.includes("{")) return null;
    const entries = splitEntries(inner);
    if (entries === null || entries.length < 2) return null;
    const target = entries.findIndex((e) => !e.startsWith("...")) >= 0
      ? entries.findIndex((e) => !e.startsWith("..."))
      : 0;
    const kept = entries.filter((_, i) => i !== target);
    return {
      text: `${line.slice(0, open)}{ ${kept.join(", ")} }${
        line.slice(close + 1)
      }`,
      name: entryName(entries[target]!),
    };
  }
  return null;
}

/** The wiring mutants of one line, as `[text, description]` candidates. */
function wiringCandidates(
  line: string,
  context: LineContext,
  lines: readonly string[],
  n: number,
): Array<[string | null, string]> {
  const out: Array<[string | null, string]> = [];
  const trimmed = line.trim();
  const indent = line.slice(0, line.length - line.trimStart().length);
  if (context === "object" && standsAlone(trimmed, lines, n)) {
    const keyed = KEYED_ENTRY.exec(trimmed);
    if (SHORTHAND_ENTRY.test(trimmed) || keyed) {
      out.push(["", `deleted object property \`${entryName(trimmed)}\``]);
    }
    const value = keyed?.[2]?.trim();
    if (
      keyed && SIMPLE_KEY.test(keyed[1]!) && value !== undefined &&
      SIMPLE_KEY.test(value) && !LITERAL_VALUES.has(value) &&
      value !== keyed[1] &&
      nameInUse(keyed[1]!, lines, n)
    ) {
      out.push([
        `${indent}${keyed[1]}${trimmed.endsWith(",") ? "," : ""}`,
        `reverted property \`${keyed[1]}\` to shorthand`,
      ]);
    }
  } else if (
    context === "array" && ARRAY_ELEMENT.test(trimmed) &&
    standsAlone(trimmed, lines, n)
  ) {
    out.push(["", `deleted array element \`${trimmed.replace(/,$/, "")}\``]);
  }
  if (context !== "object" && context !== "array") {
    const inline = deleteInlineProperty(line);
    if (inline) {
      out.push([inline.text, `deleted object property \`${inline.name}\``]);
    }
  }
  return out;
}

/** Mutants generated for one file, and how many candidates were not generated. */
export interface DenoMutantGeneration {
  mutants: DenoMutant[];
  /**
   * Candidate mutations dropped without being tried: those past `cap`, and
   * one per added line longer than {@link MAX_MUTATED_LINE_LENGTH}. A caller
   * that ignores this reports a partly mutated change as fully checked.
   */
  dropped: number;
}

// ---------------------------------------------------------------------------
// Operand mutants (Issue #3901)
// ---------------------------------------------------------------------------

const OPERAND_TEXT_MAX = 60;
/**
 * Masks comments and template `${}` code in {@link maskedLines}. Unlike a blank,
 * it ends an operand region, so a comment or expression never joins an operand.
 */
const OPAQUE_MASK = "\u0001";
/** Statement heads stripped before an operand scan, so the scan starts at the operands. */
const OPERAND_PREFIX =
  /^\s*(?:\}\s*)?(?:else\s+)?(?:\b(?:if|while)\s*\(|return\b\s*|(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=(?![=>])\s*|[\w$.]+\s*=(?![=>])\s*)/;

/**
 * `source` line by line with string, template, comment and regex literal text
 * blanked to spaces. Lengths are kept, so an index into a masked line is the
 * same index into the raw line. Returns `null` when a block comment or template
 * literal is still open at the end of the file.
 */
export function maskedLines(source: string): string[] | null {
  type Mode = "code" | "line" | "block" | "str" | "re" | "tpl";
  const out: string[] = [];
  let buf: string[] = [];
  let mode: Mode = "code";
  let quote = "";
  let inClass = false;
  let prev = "";
  let braces = 0;
  // Brace depth at each open `${`, so its closing brace returns to the template.
  const exprDepths: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    const next = source.charAt(i + 1);
    if (c === "\n") {
      out.push(buf.join(""));
      buf = [];
      if (mode === "line" || mode === "str" || mode === "re") mode = "code";
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        buf.push(OPAQUE_MASK + OPAQUE_MASK);
        i++;
        mode = "code";
      } else {
        buf.push(OPAQUE_MASK);
      }
      continue;
    }
    if (mode === "line") {
      buf.push(OPAQUE_MASK);
      continue;
    }
    if (mode === "tpl" || mode === "str" || mode === "re") {
      if (c === "\\" && next !== "\n" && next !== "") {
        buf.push("  ");
        i++;
        continue;
      }
      if (mode === "tpl") {
        if (c === "`") {
          mode = "code";
          prev = c;
        } else if (c === "$" && next === "{") {
          exprDepths.push(braces);
          mode = "code";
          prev = "{";
          buf.push("  ");
          i++;
          continue;
        }
      } else if (mode === "str") {
        if (c === quote) {
          mode = "code";
          prev = c;
        }
      } else if (c === "[") {
        inClass = true;
      } else if (c === "]") {
        inClass = false;
      } else if (c === "/" && !inClass) {
        mode = "code";
        prev = c;
      }
      buf.push(" ");
      continue;
    }
    if (c === "/" && next === "/") {
      mode = "line";
      buf.push(OPAQUE_MASK + OPAQUE_MASK);
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      mode = "block";
      buf.push(OPAQUE_MASK + OPAQUE_MASK);
      i++;
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_PRECEDERS.includes(prev))) {
      mode = "re";
      inClass = false;
      buf.push(" ");
      continue;
    }
    if (c === '"' || c === "'") {
      mode = "str";
      quote = c;
      prev = c;
      buf.push(" ");
      continue;
    }
    if (c === "`") {
      mode = "tpl";
      buf.push(" ");
      continue;
    }
    if (c === "{") {
      braces++;
    } else if (c === "}") {
      // An empty stack reads `undefined`, which never equals a brace depth.
      if (exprDepths[exprDepths.length - 1] === braces) {
        exprDepths.pop();
        mode = "tpl";
        buf.push(" ");
        continue;
      }
      if (braces > 0) braces--;
    }
    // Code inside a `${}` is opaque too: an operator there is not a plain operand.
    buf.push(exprDepths.length > 0 ? OPAQUE_MASK : c);
    if (!/\s/.test(c)) prev = c;
  }
  if (mode === "block" || mode === "tpl") return null;
  out.push(buf.join(""));
  return out;
}

/**
 * The chain operator that continues onto line `n` from a line break: a
 * trailing `||`/`&&` on the line before, or a leading one on the line after.
 */
function sourcedOperator(
  masked: readonly string[],
  n: number,
): "||" | "&&" | null {
  const prior = masked[n - 2] ?? "";
  const cut = prior.indexOf(OPAQUE_MASK);
  const before = (cut < 0 ? prior : prior.slice(0, cut)).trimEnd();
  const after = (masked[n] ?? "").trimStart();
  if (/(?:\|\||&&)$/.test(before)) return before.endsWith("||") ? "||" : "&&";
  if (/^(?:\|\||&&)(?!=)/.test(after)) {
    return after.startsWith("||") ? "||" : "&&";
  }
  return null;
}

/**
 * Whether `text` has balanced brackets: `(`, `[` and `{` never close more than
 * they open, and all are closed at the end. Applied to masked text, so a
 * bracket inside a string, comment or template is not counted.
 */
function bracketsBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Operand mutants for line `n` (Issue #3901): for the operands of one top-level
 * `||` or `&&` chain, each operand replaced by the chain identity (`false` for
 * `||`, `true` for `&&`). The chain operator is the line's edge operator when
 * it has one: its own trailing `||`/`&&`, else its own leading one, else the one
 * sourced from the adjacent line. Only that operator splits the line, and only
 * at bracket depth 0 relative to the region start, so a wrapped group such as
 * `(a && b)` after `!x ||` is one operand, and the other kind stays inside its
 * operand. A line with no edge operator takes the shallowest operator on the
 * line, `||` preferred over `&&`. A segment whose masked text does not balance
 * its brackets is skipped, so every mutant stays syntactically valid. Lines
 * that are types, assignments, arrows or `||=`/`&&=` yield nothing.
 */
function operandCandidates(
  line: string,
  masked: readonly string[],
  n: number,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (TYPE_ALIAS_LINE.test(line)) return out;
  const m = (masked[n - 1] ?? "").slice(0, line.length);
  const start = OPERAND_PREFIX.exec(m)?.[0].length ?? 0;
  // The region ends at the first unmatched closer, or a depth-0 separator.
  let end = m.length;
  let depth = 0;
  for (let i = start; i < m.length; i++) {
    const ch = m.charAt(i);
    if (ch === OPAQUE_MASK) {
      end = i;
      break;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    } else if (depth === 0) {
      const nx = m.charAt(i + 1);
      if (ch === ";" || ch === "," || ch === ":") {
        end = i;
        break;
      }
      if (ch === "?" && nx !== "?" && nx !== "." && m.charAt(i - 1) !== "?") {
        end = i;
        break;
      }
      // An assignment or arrow (`=`, `+=`, `=>`, `||=`) is not a plain chain.
      if (ch === "=") {
        const pv = m.charAt(i - 1);
        if (nx !== "=" && !"=!<>".includes(pv)) return out;
      }
    }
  }
  const splits: Array<{ at: number; op: "||" | "&&"; depth: number }> = [];
  depth = 0;
  for (let i = start; i < end; i++) {
    const ch = m.charAt(i);
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
    } else if (
      (ch === "|" || ch === "&") && m.charAt(i + 1) === ch
    ) {
      splits.push({ at: i, op: ch === "|" ? "||" : "&&", depth });
      i++;
    }
  }
  // Issue #3901: the edge operator first, so a wrapped group is one operand.
  const tail = m.trimEnd().length;
  const lead = m.length - m.trimStart().length;
  const trailing = splits.find((s) => s.depth === 0 && s.at === tail - 2);
  const leading = splits.find((s) =>
    s.depth === 0 && s.at === lead && m.charAt(lead + 2) !== "="
  );
  const edge = trailing?.op ?? leading?.op ?? sourcedOperator(masked, n);
  let op: "||" | "&&";
  let bounds: number[];
  if (edge !== null) {
    op = edge;
    bounds = splits.filter((s) => s.depth === 0 && s.op === edge).map((s) =>
      s.at
    );
  } else if (splits.length > 0) {
    const minDepth = Math.min(...splits.map((s) => s.depth));
    const atMin = splits.filter((s) => s.depth === minDepth);
    op = atMin.some((s) => s.op === "||") ? "||" : "&&";
    bounds = atMin.filter((s) => s.op === op).map((s) => s.at);
  } else {
    return out;
  }
  const identity = op === "||" ? "false" : "true";
  const segments: Array<[number, number]> = [];
  let from = start;
  for (const at of bounds) {
    segments.push([from, at]);
    from = at + 2;
  }
  segments.push([from, end]);
  for (const [a, b] of segments) {
    const raw = line.slice(a, b);
    const s = a + raw.length - raw.trimStart().length;
    const e = b - (raw.length - raw.trimEnd().length);
    // Blank, or only strings, templates or regexes: no plain operand to replace.
    if (m.slice(s, e).trim() === "") continue;
    // Issue #3901: a segment cut inside a bracket pair is not an operand.
    if (!bracketsBalanced(m.slice(s, e))) continue;
    const text = line.slice(s, e);
    const shown = (text.length > OPERAND_TEXT_MAX
      ? `${text.slice(0, OPERAND_TEXT_MAX - 3)}...`
      : text).replaceAll("`", "'");
    out.push([
      `${line.slice(0, s)}${identity}${line.slice(e)}`,
      `dropped operand \`${shown}\` (replaced with ${identity})`,
    ]);
  }
  return out;
}

/**
 * Generate mutants for the added lines of one source file. One mutant per
 * mutation kind per line, ordered by line then kind, stopping at `cap`; the
 * candidates past `cap` and the over-long lines are counted in `dropped`
 * rather than silently lost. Test files and comment lines yield nothing.
 */
export function generateDenoMutantsDetailed(
  file: string,
  source: string,
  addedLines: readonly number[],
  cap: number,
): DenoMutantGeneration {
  const out: DenoMutant[] = [];
  let dropped = 0;
  if (isDenoTestFile(file)) return { mutants: out, dropped };
  const lines = source.split("\n");
  // Issue #3601: computed once per file; null disables only the wiring kinds.
  const contexts = lineContexts(source);
  // Issue #3901: masked once per file; null disables only the operand kind.
  const masks = maskedLines(source);
  const sorted = [...new Set(addedLines)].sort((a, b) => a - b);
  for (const n of sorted) {
    if (n < 1 || n > lines.length) continue;
    const raw = lines[n - 1] ?? "";
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    const t = line.trimStart();
    if (
      t === "" || t.startsWith("//") || t.startsWith("*") ||
      t.startsWith("/*")
    ) continue;
    if (line.length > MAX_MUTATED_LINE_LENGTH) {
      dropped++;
      continue;
    }

    const candidates: Array<[string | null, string]> = [];
    candidates.push([negateIf(line), "negated if condition"]);
    candidates.push([negateTernary(line), "negated ternary condition"]);
    const swapped = swapBoolean(line);
    candidates.push([
      swapped?.text ?? null,
      `swapped ${swapped?.from} -> ${
        swapped?.from === "true" ? "false" : "true"
      }`,
    ]);
    const ret = replaceReturn(line);
    candidates.push([
      ret,
      `replaced return value with ${
        ret === null ? "" : ret.trim().slice(7, -1)
      }`,
    ]);
    candidates.push([deleteCall(line), "deleted call statement"]);
    if (contexts !== null) {
      candidates.push(
        ...wiringCandidates(line, contexts[n - 1] ?? "other", lines, n),
      );
    }
    if (masks !== null) candidates.push(...operandCandidates(line, masks, n));

    for (const [text, description] of candidates) {
      if (text === null) continue;
      if (out.length >= cap) {
        dropped++;
        continue;
      }
      const mutated = [...lines];
      mutated[n - 1] = text + cr;
      out.push({
        file,
        line: n,
        description,
        mutatedSource: mutated.join("\n"),
      });
    }
  }
  return { mutants: out, dropped };
}

/** The mutants of {@link generateDenoMutantsDetailed}, without the dropped count. */
export function generateDenoMutants(
  file: string,
  source: string,
  addedLines: readonly number[],
  cap: number,
): DenoMutant[] {
  return generateDenoMutantsDetailed(file, source, addedLines, cap).mutants;
}

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

const LOCATION_SEPARATORS = /[\s`'"()<>,]+/;
const DIGITS = /^\d{1,7}$/;

/**
 * Read `` `path:line` exempt (untestable): reason `` entries from a PR
 * summary. An empty reason is not an exemption.
 */
export function parseMutationExemptions(
  prSummary: string,
): Array<{ file: string; line: number; reason: string }> {
  const out: Array<{ file: string; line: number; reason: string }> = [];
  for (const line of prSummary.split("\n")) {
    if (line.length > MAX_SUMMARY_LINE_LENGTH) continue;
    const idx = line.toLowerCase().indexOf(EXEMPT_MARKER);
    if (idx < 0) continue;
    const reason = line.slice(idx + EXEMPT_MARKER.length).trim();
    if (reason === "") continue;
    for (let token of line.slice(0, idx).split(LOCATION_SEPARATORS)) {
      if (token.endsWith(":")) token = token.slice(0, -1);
      const colon = token.lastIndexOf(":");
      if (colon <= 0) continue;
      const num = token.slice(colon + 1);
      if (!DIGITS.test(num)) continue;
      out.push({ file: token.slice(0, colon), line: Number(num), reason });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verdict and comment
// ---------------------------------------------------------------------------

/** Verdict for a mutation-check result, honouring PR-summary exemptions. */
export function evaluateMutationGate(
  result: MutationCheckResult,
  prSummary: string,
): MutationGateVerdict {
  if (result.kind === "not_applicable") {
    return {
      blocked: false,
      reason: "",
      survivors: [],
      exempted: [],
      budgetExhausted: false,
      note: `mutation check not applicable: ${result.reason}`,
    };
  }
  if (result.kind === "error") {
    return {
      blocked: true,
      reason:
        `mutation check failed to run (${result.reason}); fix the error or set skip_mutation_check for this repo`,
      survivors: [],
      exempted: [],
      budgetExhausted: false,
      note: "",
    };
  }
  const exemptions = parseMutationExemptions(prSummary);
  const survivors: Mutant[] = [];
  const exempted: Mutant[] = [];
  for (const s of result.survivors) {
    const isExempt = exemptions.some((e) =>
      e.file === s.file && e.line === s.line
    );
    (isExempt ? exempted : survivors).push(s);
  }
  const budgetExhausted = result.kind === "budget_exhausted";
  const note = result.kind === "budget_exhausted"
    ? (result.limit === "mutant_cap"
      ? `mutation cap reached: ${result.tested} of ${result.total} candidate mutants tried — ${
        result.total - result.tested
      } untested (past the mutant cap or on lines over ${MAX_MUTATED_LINE_LENGTH} characters), not passed`
      : `mutation budget exhausted after ${result.tested} of ${result.total} mutants (${result.budgetSeconds} s) — remaining mutants untested, not passed`)
    : `${result.killed} of ${result.total} mutants killed`;
  if (survivors.length > 0) {
    return {
      blocked: true,
      reason: `${survivors.length} mutant${
        survivors.length === 1 ? "" : "s"
      } of changed lines survived (no test went red)`,
      survivors,
      exempted,
      budgetExhausted,
      note,
    };
  }
  return {
    blocked: false,
    reason: "",
    survivors,
    exempted,
    budgetExhausted,
    note,
  };
}

function mdSafe(s: string): string {
  return s.replaceAll("`", "").replace(/[\r\n]+/g, " ");
}

/** Markdown feedback for the agent when the gate blocks. */
export function buildMutationGateComment(verdict: MutationGateVerdict): string {
  const out: string[] = ["## Mutation check: changed lines are not pinned", ""];
  out.push(verdict.reason ? mdSafe(verdict.reason) + "." : "");
  out.push("");
  if (verdict.survivors.length > 0) {
    out.push(
      "No test went red when each of these mutations was applied to the changed line:",
      "",
    );
    for (const s of verdict.survivors) {
      out.push(`- \`${mdSafe(s.file)}:${s.line}\` — ${mdSafe(s.description)}`);
    }
    out.push(
      "",
      "Add a test that kills each mutation, or, where a line genuinely cannot be tested, record " +
        "`file:line` exempt (untestable): <reason> in the PR summary.",
    );
  }
  if (verdict.budgetExhausted && verdict.note) {
    out.push("", mdSafe(verdict.note));
  }
  return out.join("\n").trimEnd() + "\n";
}
