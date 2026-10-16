/**
 * Existing callers of changed functions (Issue #3779).
 *
 * A change can alter what a function returns and so break a caller the change
 * never touched. This module reads the diff for the functions whose body it
 * edits, then greps the head for other lines naming each one. The pre-PR
 * verifier must give every listed caller a verdict: a missing verdict or a
 * `regressed` one is a blocking finding the code adds itself, in the same shape
 * as review checklists (Issue #3594).
 *
 * The scan is line-based and over-inclusive on purpose. It skips test, doc and
 * comment lines, and keeps any other line that names the function outside the
 * lines the diff changes. It is a search aid, not a call graph.
 *
 * @module
 */

import { isTestFilePath } from "./security_fix_gate.ts";
import { fenceUntrustedIssueText } from "./prompt_delimiter.ts";
import { gapText, inlineSafe } from "./review_checklists.ts";

/** Callers listed for one changed function; the rest are counted in a note. */
export const MAX_CALLERS_PER_SYMBOL = 10;
/** Changed functions that may have callers listed. */
export const MAX_SYMBOLS = 15;
/** Changed functions searched for callers at most (bounds the git grep calls). */
export const MAX_SYMBOLS_SEARCHED = 40;

export const CALLER_VERDICTS = [
  "unchanged",
  "changed and tested",
  "regressed",
] as const;
export type CallerVerdictValue = typeof CALLER_VERDICTS[number];
export interface CallerVerdict {
  symbol: string;
  caller: string;
  verdict: CallerVerdictValue;
  note: string;
}
/** A caller the reply must give a verdict for. */
export interface CallerExpectation {
  symbol: string;
  /** `path:line` of the changed function's definition. */
  definedAt: string;
  /** `path:line` of the caller. */
  caller: string;
}
/**
 * What the code knows about the callers: the ones the reply owes a verdict for,
 * and what was capped or not scanned, rendered to the verifier as notes.
 */
export interface CallerCheckState {
  expected: CallerExpectation[];
  notes: string[];
}
export type CallerCheckGit = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string } | null>;

/** A blocking finding the worker adds itself. */
export interface CallerGapFinding {
  file: string;
  line: number;
  problem: string;
  fix: string;
}

// SIMPLE-ON-PURPOSE: line regexes, not a parser, so a definition split over several lines or written in an unlisted form is missed — upgrade when a repo's callers go unlisted for want of a definition (then use the language's own parser).
const DEFINITION_PATTERNS: readonly RegExp[] = [
  // JS/TS/bash `function`, with export, default, async and generator stars.
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b[\s*]*([A-Za-z_$][\w$]*)/,
  // JS/TS arrow or function expression bound by const, let or var.
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\b\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/,
  // Rust fn, with visibility and modifiers.
  /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*fn\s+([A-Za-z_$][\w$]*)/,
  // Python and Ruby def.
  /^(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/,
  // Go func, with an optional receiver.
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
  // bash `name()`, with an optional opening brace.
  /^([A-Za-z_$][\w$]*)\s*\(\)(?:\s*\{)?$/,
  // TS/JS class method with at least one modifier.
  /^(?:(?:public|private|protected|static|async|override|get|set)\s+)+([A-Za-z_$][\w$]*)\s*[<(]/,
  // TS/JS class method without a modifier, opening a block.
  /^([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{$/,
];

/** Words that look like a definition to the patterns above but are not one. */
const CONTROL_WORDS: ReadonlySet<string> = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "else",
  "do",
  "try",
  "with",
  "elif",
  "until",
  "case",
  "select",
  "new",
  "await",
  "typeof",
  "constructor",
]);

/** The name a line defines, or null. Best effort across languages. */
export function definitionName(line: string): string | null {
  const text = line.trim();
  for (const pattern of DEFINITION_PATTERNS) {
    const name = pattern.exec(text)?.[1];
    if (name !== undefined && name.length >= 3 && !CONTROL_WORDS.has(name)) {
      return name;
    }
  }
  return null;
}

/** A definition found in a file: its name, 1-based line and indentation. */
export interface SourceDefinition {
  name: string;
  line: number;
  indent: number;
}

function leadingWhitespace(text: string): number {
  return text.length - text.trimStart().length;
}

/** Index a file's definitions once, in line order. */
export function indexDefinitions(lines: readonly string[]): SourceDefinition[] {
  const out: SourceDefinition[] = [];
  lines.forEach((text, i) => {
    const name = definitionName(text);
    if (name !== null) {
      out.push({ name, line: i + 1, indent: leadingWhitespace(text) });
    }
  });
  return out;
}

/**
 * The definitions that enclose a line, innermost first. A definition on the
 * line itself counts. Any other must be shallower than the line, and each one
 * found narrows the search to shallower still, so a closure that has already
 * ended is not reported. A blank or absent line has no indentation, so every
 * definition above it is a candidate until one is recorded. Walks the index
 * once, so the cost is O(definitions), not O(file).
 */
export function enclosingDefinitions(
  defs: readonly SourceDefinition[],
  lines: readonly string[],
  lineNo: number,
): Array<{ name: string; line: number }> {
  const text = lines[lineNo - 1];
  let cap = text === undefined || text.trim() === ""
    ? Infinity
    : leadingWhitespace(text) - 1;
  const out: Array<{ name: string; line: number }> = [];
  for (let i = defs.length - 1; i >= 0; i--) {
    const d = defs[i]!;
    if (d.line > lineNo) continue;
    if (d.line === lineNo) {
      out.push({ name: d.name, line: d.line });
      cap = d.indent - 1;
      continue;
    }
    if (cap < 0) break;
    if (d.indent <= cap) {
      out.push({ name: d.name, line: d.line });
      cap = d.indent - 1;
    }
  }
  return out;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The changed line numbers per file, from `git diff -U0` output. A pure
 * deletion anchors on the line before it. A header whose path git quoted is
 * counted in `unparsed` and its hunks are skipped. Hunk bodies are consumed by
 * their counts, so an added line that starts with `++ ` is not read as a header.
 */
export function parseDiffChangedLines(diff: string): {
  files: Map<string, number[]>;
  unparsed: number;
} {
  const files = new Map<string, number[]>();
  let unparsed = 0;
  let current: number[] | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const take = (n: number) => Math.max(0, n - 1);
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) oldLeft = take(oldLeft);
      else if (line.startsWith("+")) newLeft = take(newLeft);
      else if (line.startsWith(" ")) {
        oldLeft = take(oldLeft);
        newLeft = take(newLeft);
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t$/, "");
      if (target === "/dev/null") {
        current = null;
      } else if (target.startsWith('"')) {
        unparsed++;
        current = null;
      } else {
        const path = target.startsWith("b/") ? target.slice(2) : target;
        current = [];
        files.set(path, current);
      }
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      oldLeft = oldCount;
      newLeft = newCount;
      const start = Number(hunk[3]);
      if (
        current !== null && Number.isSafeInteger(start) &&
        Number.isSafeInteger(newCount)
      ) {
        if (newCount === 0) {
          current.push(Math.max(start, 1));
        } else {
          for (let i = 0; i < newCount; i++) current.push(start + i);
        }
      }
    }
  }
  return { files, unparsed };
}

const isDocPath = (p: string) => p.startsWith("docs/") || p.endsWith(".md");

/**
 * Whether a trimmed line is only the name in an import or export list: `name`,
 * `name,`, `type name` or `type name,`. String operations, so no regex is
 * built from the name.
 */
function isBareNameLine(trimmed: string, name: string): boolean {
  const body = trimmed.endsWith(",") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  const bare = body.startsWith("type") && /\s/.test(body.charAt(4))
    ? body.slice(4).trimStart()
    : body;
  return bare === name;
}

/** Lines that name a symbol but do not call it. */
const NON_CALLER_LINES: readonly RegExp[] = [
  /^import\b/,
  /^export\s*\{/,
  /^(?:\}\s*)?from\s+["']/,
];

function isCallerHit(
  path: string,
  line: number,
  text: string,
  name: string,
  changed: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  if (isTestFilePath(path) || isDocPath(path)) return false;
  if (changed.get(path)?.has(line)) return false;
  if (definitionName(text) === name) return false;
  const trimmed = text.trim();
  if (
    trimmed.startsWith("//") || trimmed.startsWith("/*") ||
    trimmed.startsWith("*") || trimmed.startsWith("#")
  ) {
    return false;
  }
  if (NON_CALLER_LINES.some((re) => re.test(trimmed))) return false;
  if (isBareNameLine(trimmed, name)) return false;
  return true;
}

function gitFailure(
  what: string,
  r: { code: number; stderr: string } | null,
): string {
  if (r === null) return `${what}: git could not be spawned`;
  const cause =
    r.stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ??
      `git exited ${r.code}`;
  return `${what}: ${inlineSafe(cause, 200)}`;
}

/**
 * List the callers of every function the change edits, at the head. Returns
 * `ok: false` (with git's cause) when the diff or a file cannot be read, so the
 * pass is "not checked" rather than silently clean.
 */
export async function collectCallerChecks(
  runGit: CallerCheckGit,
  cwd: string,
  baseSha: string,
  headSha: string,
): Promise<
  { ok: true; state: CallerCheckState } | { ok: false; reason: string }
> {
  const diff = await runGit(
    ["diff", "-U0", "--no-color", "--no-ext-diff", `${baseSha}...${headSha}`],
    cwd,
  );
  if (diff === null || diff.code !== 0) {
    return { ok: false, reason: gitFailure("git diff failed", diff) };
  }
  const { files, unparsed } = parseDiffChangedLines(diff.stdout);
  const notes: string[] = [];
  if (unparsed > 0) {
    notes.push(
      `${unparsed} changed file(s) with quoted paths were not scanned`,
    );
  }
  const changed = new Map<string, ReadonlySet<number>>();
  for (const [path, lines] of files) changed.set(path, new Set(lines));

  // Changed functions in first-seen order, each with its definition.
  const symbols = new Map<string, string>();
  for (const [path, lines] of files) {
    if (isTestFilePath(path) || isDocPath(path)) continue;
    const shown = await runGit(["show", `${headSha}:${path}`], cwd);
    if (shown === null || shown.code !== 0) {
      return {
        ok: false,
        reason: gitFailure(`git show ${inlineSafe(path, 200)} failed`, shown),
      };
    }
    const source = shown.stdout.split("\n");
    const defs = indexDefinitions(source);
    for (const lineNo of new Set(lines)) {
      for (const d of enclosingDefinitions(defs, source, lineNo)) {
        if (!symbols.has(d.name)) symbols.set(d.name, `${path}:${d.line}`);
      }
    }
  }

  const expected: CallerExpectation[] = [];
  const names = [...symbols.keys()];
  const prefix = `${headSha}:`;
  let searched = 0;
  let withCallers = 0;
  for (const name of names) {
    if (withCallers >= MAX_SYMBOLS || searched >= MAX_SYMBOLS_SEARCHED) break;
    searched++;
    const grep = await runGit(
      ["grep", "-n", "-z", "-w", "-I", "-F", "-e", name, headSha, "--"],
      cwd,
    );
    // Exit 1 is "no match"; anything else non-zero is a failure.
    if (grep === null || (grep.code !== 0 && grep.code !== 1)) {
      return {
        ok: false,
        reason: gitFailure(
          `git grep for ${inlineSafe(name, 100)} failed`,
          grep,
        ),
      };
    }
    if (grep.code === 1) continue;
    // Each record is `<head>:<path>\0<line>\0<text>`, ending in a newline.
    const kept: string[] = [];
    for (const record of grep.stdout.split("\n")) {
      if (record === "") continue;
      const a = record.indexOf("\0");
      const b = a < 0 ? -1 : record.indexOf("\0", a + 1);
      if (a < 0 || b < 0 || !record.startsWith(prefix)) {
        return {
          ok: false,
          reason: "git grep returned output in an unexpected form",
        };
      }
      const path = record.slice(prefix.length, a);
      const line = Number(record.slice(a + 1, b));
      const text = record.slice(b + 1);
      if (isCallerHit(path, line, text, name, changed)) {
        kept.push(`${path}:${line}`);
      }
    }
    if (kept.length === 0) continue;
    withCallers++;
    const definedAt = symbols.get(name) ?? "";
    for (const caller of kept.slice(0, MAX_CALLERS_PER_SYMBOL)) {
      expected.push({ symbol: name, definedAt, caller });
    }
    if (kept.length > MAX_CALLERS_PER_SYMBOL) {
      notes.push(
        `${
          kept.length - MAX_CALLERS_PER_SYMBOL
        } more caller(s) of \`${name}\` not listed`,
      );
    }
  }
  const unsearched = names.length - searched;
  if (unsearched > 0) {
    notes.push(
      `${unsearched} more changed function(s) were not searched for callers`,
    );
  }
  return { ok: true, state: { expected, notes } };
}

/**
 * The section the verifier brief carries: empty when there is no caller to
 * check and nothing was capped. The list is fenced as untrusted text.
 */
export function renderCallerCheckSection(
  state: CallerCheckState,
  boundaryId: string,
): string[] {
  if (state.expected.length === 0 && state.notes.length === 0) return [];
  const lines = [
    "### Existing callers of changed functions",
    "",
    'The worker listed each function or method whose body the change touches, and searched the head\'s tracked source files (tests, docs and comment lines excluded) by word for other places naming it, outside the lines the diff changes. The search is over-inclusive, so a line that only mentions the name still needs a verdict. Add a `callers` key to the reply JSON the brief asks for (beside `checklist`), holding one entry per caller below: {...}. For EVERY caller listed, decide whether its behaviour changes under the function\'s new result, and report it in the reply `callers` array as {"symbol": "<name>", "caller": "<file>:<line>", "verdict": "unchanged" | "changed and tested" | "regressed", "note": "<why>"}, copying symbol and caller exactly. An `unchanged` note says why the change does not reach that caller. A `changed and tested` note names the test that exercises this caller under the new result. A `regressed` verdict is also a BLOCKING finding. The worker checks that every caller got a verdict: one with none, or one marked `regressed`, sends the change back.',
  ];
  const body = [
    ...state.expected.map((e) =>
      `- \`${inlineSafe(e.symbol, 200)}\` (defined at \`${
        inlineSafe(e.definedAt, 300)
      }\`): caller \`${inlineSafe(e.caller, 300)}\``
    ),
    ...state.notes.map((n) => `- Note: ${inlineSafe(n, 300)}`),
  ];
  lines.push(
    "",
    ...fenceUntrustedIssueText(
      body.join("\n"),
      "Existing callers to report:",
      boundaryId,
    ),
  );
  return lines;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate the reply's `callers` array; throws naming the problem. */
export function parseCallerVerdicts(value: unknown): CallerVerdict[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("review JSON callers is not an array");
  }
  return value.map((raw, i) => {
    if (!isObject(raw)) {
      throw new Error(`review JSON callers[${i}] is not an object`);
    }
    for (const key of ["symbol", "caller", "note"] as const) {
      const v = raw[key];
      if (typeof v !== "string" || v.trim() === "") {
        throw new Error(
          `review JSON callers[${i}] lacks a non-empty "${key}"`,
        );
      }
    }
    if (
      typeof raw.verdict !== "string" ||
      !(CALLER_VERDICTS as readonly string[]).includes(raw.verdict)
    ) {
      throw new Error(
        `review JSON callers[${i}] has verdict=${
          JSON.stringify(raw.verdict)
        }; expected ${CALLER_VERDICTS.join(", ")}`,
      );
    }
    return {
      symbol: raw.symbol as string,
      caller: raw.caller as string,
      verdict: raw.verdict as CallerVerdictValue,
      note: raw.note as string,
    };
  });
}

/** Same symbol and caller, ignoring backticks, spacing, case and a leading "./". */
function callerKey(symbol: string, caller: string): string {
  const flat = (t: string) =>
    t.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return `${flat(symbol)}\u0000${flat(caller).replace(/^(?:\.\/)+/, "")}`;
}

/** `path:line` split; line 0 when there is no usable line number. */
function splitPathLine(where: string): { file: string; line: number } {
  const i = where.lastIndexOf(":");
  if (i <= 0) return { file: where, line: 0 };
  const line = Number(where.slice(i + 1));
  return Number.isInteger(line) && line > 0
    ? { file: where.slice(0, i), line }
    : { file: where, line: 0 };
}

const MAX_GAPS_NAMED = 5;

/**
 * Blocking findings decided by the code, not the model: one for every expected
 * caller the reply left without a verdict, and one for each `regressed` verdict.
 * "No verdict" is never read as a pass.
 */
export function callerGapFindings(
  state: CallerCheckState,
  verdicts: readonly CallerVerdict[],
): CallerGapFinding[] {
  const out: CallerGapFinding[] = [];
  const reported = new Set(
    verdicts.map((v) => callerKey(v.symbol, v.caller)),
  );
  const unreported = state.expected.filter((e) =>
    !reported.has(callerKey(e.symbol, e.caller))
  );
  if (unreported.length > 0) {
    const first = splitPathLine(unreported[0]!.definedAt);
    const named = unreported.slice(0, MAX_GAPS_NAMED).map((e) =>
      `\`${gapText(e.symbol, 200)}\` at \`${gapText(e.caller, 300)}\``
    ).join("; ");
    const more = unreported.length > MAX_GAPS_NAMED
      ? `; and ${unreported.length - MAX_GAPS_NAMED} more`
      : "";
    out.push({
      file: first.file,
      line: first.line,
      problem:
        `Existing callers of changed functions: no verdict was reported for ${unreported.length} of ${state.expected.length} caller(s), so they were not checked: ${named}${more}.`,
      fix:
        "Report each of these callers in the reply `callers` array with a verdict of `unchanged`, `changed and tested` or `regressed`, copying the symbol and caller exactly as listed.",
    });
  }
  for (const v of verdicts) {
    if (v.verdict !== "regressed") continue;
    const at = splitPathLine(v.caller);
    out.push({
      file: at.file,
      line: at.line,
      problem: `Existing caller \`${gapText(v.caller, 300)}\` of \`${
        gapText(v.symbol, 200)
      }\` regresses under the changed result: ${gapText(v.note, 500)}`,
      fix:
        "Keep the function's old result for this caller (apply the new behaviour at the new call site), or change this caller and add a test that exercises it under the new result.",
    });
  }
  return out;
}
