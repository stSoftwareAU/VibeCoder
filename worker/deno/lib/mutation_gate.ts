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
 * backtracking; lines over {@link MAX_MUTATED_LINE_LENGTH} are not mutated.
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
    total: number;
    budgetSeconds: number;
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

function negateTernary(line: string): string | null {
  const q = line.indexOf(" ? ");
  if (q <= 0 || line.indexOf(" : ", q) < 0) return null;
  let start = q;
  while (start > 0 && /[\w$.]/.test(line.charAt(start - 1))) start--;
  const cond = line.slice(start, q);
  if (cond === "" || !/^[A-Za-z_$]/.test(cond)) return null;
  if (!isCodeAt(line, start)) return null;
  return `${line.slice(0, start)}!${cond}${line.slice(q)}`;
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

/**
 * Generate mutants for the added lines of one source file. One mutant per
 * mutation kind per line, ordered by line then kind, stopping at `cap`.
 * Test files and comment lines yield nothing.
 */
export function generateDenoMutants(
  file: string,
  source: string,
  addedLines: readonly number[],
  cap: number,
): DenoMutant[] {
  const out: DenoMutant[] = [];
  if (isDenoTestFile(file) || cap <= 0) return out;
  const lines = source.split("\n");
  const sorted = [...new Set(addedLines)].sort((a, b) => a - b);
  for (const n of sorted) {
    if (n < 1 || n > lines.length) continue;
    const raw = lines[n - 1] ?? "";
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    if (line.length > MAX_MUTATED_LINE_LENGTH) continue;
    const t = line.trimStart();
    if (
      t === "" || t.startsWith("//") || t.startsWith("*") ||
      t.startsWith("/*")
    ) continue;

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

    for (const [text, description] of candidates) {
      if (text === null) continue;
      if (out.length >= cap) return out;
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
  return out;
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
    ? `mutation budget exhausted after ${result.tested} of ${result.total} mutants (${result.budgetSeconds} s) — remaining mutants untested, not passed`
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
