/**
 * Deterministic Test Plan recount for review-fix runs (Issue #3143).
 *
 * Review-fix pushes kept leaving a stale "N tests"/"N passed" count in the PR
 * summary's `## Test Plan` section after the worker added or removed test
 * declarations (VibeCoder#3134, #3075, #3105, #3108). A prose rule telling
 * the worker to keep the count honest (#3117) was never actually checked.
 * This module counts the test declarations present in the changed test
 * files at the PR head and flags any Test Plan line whose quoted count
 * disagrees with that recount, so a drift check can catch the mismatch
 * mechanically instead of relying on the model to notice.
 *
 * A paired run result such as a red-on-base "76 passed, 4 failed" is checked
 * by its total (passed + failed), not by "passed" alone, because the run
 * executed every runnable test in the file (Issue #3381).
 *
 * A block with several figures is read one figure at a time (Issue #3740).
 * A whole-file figure such as "`a_test.ts` (8 tests)" is compared with that
 * file. A partial addition ("3 tests added to `a_test.ts`", "+3 tests",
 * "Added to `a_test.ts` (8 tests") is never compared and is reported
 * unchecked, and it does not block the other figures. "now has N" gives a
 * file's whole total and takes precedence over a partial figure for it. A
 * figure whose file the PR did not change is unchecked on its own. A count
 * with no file name, in a sentence of its own, is unchecked on its own. A
 * single-figure block and an ambiguous pairing keep the block-level skip.
 *
 * The PR summary is untrusted, agent-authored text, so this module only
 * ever uses bounded, hardcoded regexes against it (never `new RegExp` built
 * from input) and caps the amount of text it scans at 200_000 characters.
 */

import {
  markdownLogicalUnits,
  splitMarkdownLines,
} from "./markdown_code_spans.ts";

const MAX_SCAN_CHARS = 200_000;

/**
 * Whether a repo-relative path is a JS/TS test file whose declarations this
 * module can count.
 */
export function isCountableTestPath(path: string): boolean {
  if (!path) return false;
  return /(?:_test|\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs|mts)$/.test(path);
}

/**
 * Replace comments, string/template literals and regex literals with
 * whitespace, left to right, tracking escapes and `${...}` interpolation
 * depth inside template literals (Issue #3143 review).
 *
 * A declaration-shaped fixture embedded in a string or template literal — a
 * test file that quotes `Deno.test(...)` source as a sample input, or an
 * assertion message containing "it (" — must never be counted as a real
 * declaration. A plain regex over the raw source cannot tell the two apart;
 * this single-pass scanner can, because it tracks literal boundaries rather
 * than matching text wherever it appears.
 */
interface StripResult {
  code: string;
  /** A comment, string, or template was still open at the end of the scan. */
  unclosed: boolean;
}

/**
 * Consume one template literal starting at the backtick at `start`.
 * Nested templates and plain `{` / `}` inside `${...}` are tracked, so a
 * `}` that belongs to a callback does not end the interpolation early.
 */
function consumeTemplate(
  source: string,
  start: number,
): { next: number; closed: boolean } {
  type Frame = { kind: "tpl" } | { kind: "interp"; depth: number };
  const stack: Frame[] = [{ kind: "tpl" }];
  let i = start + 1;
  const n = source.length;
  while (i < n && stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const c = source[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (top.kind === "tpl") {
      if (c === "`") {
        stack.pop();
        i++;
        continue;
      }
      if (c === "$" && source[i + 1] === "{") {
        stack.push({ kind: "interp", depth: 1 });
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n && source[i] !== quote) {
        i += source[i] === "\\" ? 2 : 1;
      }
      if (i >= n) return { next: n, closed: false };
      i++;
      continue;
    }
    if (c === "`") {
      stack.push({ kind: "tpl" });
      i++;
      continue;
    }
    if (c === "{") {
      top.depth++;
      i++;
      continue;
    }
    if (c === "}") {
      top.depth--;
      i++;
      if (top.depth === 0) stack.pop();
      continue;
    }
    i++;
  }
  return { next: i, closed: stack.length === 0 };
}

function stripNonCode(source: string): StripResult {
  let out = "";
  let i = 0;
  let prev = "";
  let unclosed = false;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const c2 = i + 1 < n ? source[i + 1]! : "";

    if (c === "/" && c2 === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      if (i >= n) unclosed = true;
      else i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n && source[i] !== quote) {
        i += source[i] === "\\" ? 2 : 1;
      }
      if (i >= n) unclosed = true;
      else i++;
      out += " ";
      prev = quote;
      continue;
    }
    if (c === "`") {
      const consumed = consumeTemplate(source, i);
      if (!consumed.closed) unclosed = true;
      i = consumed.next;
      out += " ";
      prev = "`";
      continue;
    }
    // Regex literal, only after a token that cannot end an expression
    // (operator, opening bracket, or start of input) — distinguishes
    // `const re = /foo/;` from a division `a / b`. A scan that cannot
    // prove the literal closed marks the file uncountable; it is left
    // out of the head recount rather than compared to a wrong count.
    if (c === "/" && /^[([{,;:!&|?=~^%+\-*]?$/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        let k = j + 1;
        while (k < n && /[a-z]/i.test(source[k]!)) k++;
        out += " ";
        i = k;
        prev = "/";
        continue;
      }
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code: out, unclosed };
}

/** A declaration the recount will not compare against a Test Plan line. */
export interface RecountResult {
  counts: TestDeclarationCounts;
  /**
   * False when a declaration sits inside a block, parentheses, or a loop,
   * or the scan ended inside a literal or with unbalanced depth. The file
   * is then left out of the head recount.
   */
  countable: boolean;
}

const CONTROL_KEYWORD = /\b(?:for|while|if|else|do|switch)\b/;

function matchCall(
  code: string,
  i: number,
): { end: number; modifier: string; skipped: ReadonlySet<string> } | null {
  let rest = code.slice(i);
  let kind: "deno" | "it" | null = null;
  if (rest.startsWith("Deno.test")) {
    kind = "deno";
    rest = rest.slice("Deno.test".length);
  } else if (
    /(?<![\w.$])it/.test(code.slice(Math.max(0, i - 1), i + 2)) &&
    (i === 0 || !/[\w.$]/.test(code[i - 1]!)) &&
    rest.startsWith("it")
  ) {
    kind = "it";
    rest = rest.slice(2);
  } else {
    return null;
  }
  const mod = /^(?:\.(only|ignore|skip))?(\s*)\(/.exec(rest);
  if (!mod) return null;
  if (kind === "deno" && mod[1] === "skip") return null;
  const skipped = kind === "deno"
    ? DENO_SKIPPED_MODIFIERS
    : IT_SKIPPED_MODIFIERS;
  const prefix = kind === "deno" ? "Deno.test".length : 2;
  // Stop on the opening '(' so the depth walk still sees it.
  return {
    end: i + prefix + mod[0].length - 1,
    modifier: mod[1] ?? "",
    skipped,
  };
}

/**
 * Count top-level declarations and say whether that count is safe to
 * compare with a Test Plan line.
 */
export function recountTestFile(source: string): RecountResult {
  const capped = source.slice(0, MAX_SCAN_CHARS);
  const stripped = stripNonCode(capped);
  const code = stripped.code;
  let brace = 0;
  let paren = 0;
  let unbalanced = false;
  let nested = false;
  let total = 0;
  let runnable = 0;
  let statementStart = 0;

  for (let i = 0; i < code.length;) {
    const c = code[i]!;
    if (c === "{") {
      brace++;
      statementStart = i + 1;
      i++;
      continue;
    }
    if (c === "}") {
      if (brace === 0) unbalanced = true;
      else brace--;
      statementStart = i + 1;
      i++;
      continue;
    }
    if (c === "(") {
      paren++;
      i++;
      continue;
    }
    if (c === ")") {
      if (paren === 0) unbalanced = true;
      else paren--;
      i++;
      continue;
    }
    if (c === ";") {
      statementStart = i + 1;
      i++;
      continue;
    }
    const call = matchCall(code, i);
    if (call) {
      const atDepth = brace > 0 || paren > 0;
      const statement = code.slice(statementStart, i);
      if (atDepth || CONTROL_KEYWORD.test(statement)) nested = true;
      else {
        total++;
        if (!call.skipped.has(call.modifier)) runnable++;
      }
      i = call.end;
      continue;
    }
    i++;
  }

  return {
    counts: { total, runnable },
    countable: !stripped.unclosed && !unbalanced && !nested &&
      brace === 0 && paren === 0,
  };
}

/** Declaration counts: every declaration, and only the ones `deno test` runs. */
export interface TestDeclarationCounts {
  /** Every `Deno.test`/`it` declaration, including `.ignore`/`.skip`. */
  total: number;
  /** Declarations `deno test` actually runs — `.ignore`/`.skip` excluded. */
  runnable: number;
}

/** Modifiers that `deno test` leaves out of its "N passed" figure. */
const DENO_SKIPPED_MODIFIERS = new Set(["ignore"]);
const IT_SKIPPED_MODIFIERS = new Set(["ignore", "skip"]);

/**
 * Count test declarations in a test file's source, both the total and the
 * subset `deno test` actually runs. Nested declarations are omitted; use
 * `recountTestFile` to learn whether the file was countable at all.
 */
export function countTestDeclarationsDetailed(
  source: string,
): TestDeclarationCounts {
  return recountTestFile(source).counts;
}

/** Count test declarations in a test file's source (every declaration). */
export function countTestDeclarations(source: string): number {
  return countTestDeclarationsDetailed(source).total;
}

/**
 * The text under the summary's `## Test Plan` heading (case-insensitive, any
 * heading level 2-3 named "Test Plan"), up to the next heading of the same
 * or higher level; "" when absent.
 */
export function extractTestPlanSection(summary: string): string {
  const capped = summary.slice(0, MAX_SCAN_CHARS);
  const lines = capped.split("\n");
  const headingRe = /^(#{1,6})\s+(.*)$/;

  let startLine = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = headingRe.exec(line);
    if (!m) continue;
    const hLevel = (m[1] ?? "").length;
    const title = (m[2] ?? "").trim().toLowerCase();
    if ((hLevel === 2 || hLevel === 3) && title === "test plan") {
      startLine = i + 1;
      level = hLevel;
      break;
    }
  }
  if (startLine === -1) return "";

  let endLine = lines.length;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = headingRe.exec(line);
    if (m && (m[1] ?? "").length <= level) {
      endLine = i;
      break;
    }
  }

  return lines.slice(startLine, endLine).join("\n");
}

/** One Test Plan line whose quoted count disagrees with the head. */
export interface TestPlanMismatch {
  /** The Test Plan line, trimmed (truncated to 300 chars). */
  line: string;
  /** The head-count keys (repo-relative paths) the line names. */
  files: string[];
  /** The count the line quotes. */
  claimed: number;
  /** The sum of the named files' counts at the head. */
  actual: number;
  /**
   * Present when the claim is a paired run result, so `claimed` is
   * passed + failed.
   */
  run?: { passed: number; failed: number };
}

function resolveToken(
  token: string,
  headCounts: ReadonlyMap<string, TestDeclarationCounts>,
): string | undefined {
  const matches: string[] = [];
  for (const key of headCounts.keys()) {
    if (key === token || key.endsWith("/" + token)) {
      matches.push(key);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

const TOKEN_RE =
  /[A-Za-z0-9_./-]+(?:_test|\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs|mts)/g;
// `#` is excluded so `Issue #3143 tests` is not read as a count of 3143.
// A "passed" figure is what `deno test` actually ran (`.ignore`/`.skip`
// excluded); a "tests" figure is every declaration. A block holding a paired
// `N passed, M failed` result takes the RESULT_RE path instead (Issue #3381).
const CLAIM_RE = /(?<![\w.#])(\d{1,5})\s+(tests?|passed)\b/gi;
// A paired run result in either order, e.g. "76 passed, 4 failed",
// "4 failed, 76 passed", "76 passed and 4 failed" or deno's
// "FAILED | 76 passed | 4 failed (1s)". Each start scans one separator run,
// so the cost stays linear; see the hostile-input test.
const RESULT_RE =
  /(?<![\w.#])(\d{1,5})\s+(passed|failed)\b[\s,;|]*(?:and\s+)?(\d{1,5})\s+(passed|failed)\b/gi;
/**
 * Block-level partial-addition check for a single-claim block (Issue #3740).
 * "added to", "extended", "with N tests" or "+N tests" make the one figure a
 * partial addition, not the file's whole count. A multi-claim block is read per claim
 * instead, so this regex is not used there.
 */
const PARTIAL_ADD_RE =
  /\badded to\b|\bextended\b|\bwith\s+\d{1,5}\s+tests?\b|(?<![\w.#])\+\s*\d{1,5}\s+tests?\b/i;

/**
 * Split a Test Plan section into logical blocks, one claim each.
 *
 * Logical units come from the shared `markdownLogicalUnits` (Issue #3356), so
 * a hard-wrapped paragraph or list item (indented or lazy continuation) is one
 * block, and blocks never merge across a blank line, heading, new list item,
 * table row, fence or HTML comment. Each non-code unit becomes its text with
 * whitespace runs collapsed.
 *
 * Fenced lines stay one block per physical line, so two commands in one fence
 * are compared separately, with one exception: shell line continuation. A
 * fenced line directly after a fenced line ending in `\` or `/` (after
 * trimEnd) joins onto it, because a command wrapped that way names its files
 * on one line and its "N passed" result on the next.
 *
 * Exported for reuse by `summary_claim_check.ts` (Issue #3257), whose Test
 * Plan backstop walks the same logical blocks looking for a quoted
 * behaviour rather than a stale count.
 */
export function logicalBlocks(section: string): string[] {
  const lines = splitMarkdownLines(section);
  const blocks: string[] = [];
  // Index of the last physical line in the most recent code block, and
  // whether that block may be continued by the next line.
  let codeEnd = -2;
  let codeOpen = false;
  for (const unit of markdownLogicalUnits(lines)) {
    const text = unit.text.replace(/\s+/g, " ").trim();
    if (unit.kind !== "code") {
      blocks.push(text);
      codeOpen = false;
      continue;
    }
    const idx = unit.lines[0]!;
    if (codeOpen && idx === codeEnd + 1) {
      blocks[blocks.length - 1] = `${blocks[blocks.length - 1]} ${text}`;
    } else {
      blocks.push(text);
    }
    codeEnd = idx;
    codeOpen = /[/\\]$/.test(lines[idx]!.trimEnd());
  }
  return blocks.filter((b) => b !== "");
}

/**
 * Flag Test Plan lines whose quoted figure disagrees with the head recount:
 * a single "N tests"/"N passed" claim is compared with the named files' counts
 * (summed). In a block with several claims each whole-file figure is compared
 * with the files named since the previous figure (excluding files already
 * matched), and a "now has N" total is compared with its file (Issue #3740).
 * Partial additions are never compared. A paired "N passed, M failed" run
 * result is compared by N + M with the runnable count of the test file it ran
 * (Issue #3381).
 */
export function findTestPlanMismatches(
  opts: TestPlanScanOptions,
): TestPlanMismatch[] {
  return scanTestPlan(opts).mismatches;
}

/**
 * A figure the recount could not check, so it was neither compared nor passed
 * as correct: a paired run result (Issue #3381), several counts that do not
 * each follow the test file they count, a figure naming a file the PR did not
 * change, a partial addition (Issue #3740), a token-less count, mixed count
 * kinds, or a superseded whole-file figure. The worker logs these rather than
 * letting an unchecked figure pass silently.
 */
export interface UncheckedRunResult {
  /** The Test Plan line, trimmed (truncated to 300 chars). */
  line: string;
  /** Why the result could not be compared with the head. */
  reason: string;
}

/**
 * The figures `findTestPlanMismatches` could not check: a block with several
 * "N tests" counts that do not pair up with the test files before them (or
 * differ for one file), a paired run result in a block naming a test file that
 * is not one of the PR's changed test files, a block naming several files whose
 * runs differ, or a red result naming no test file when the section has no
 * sole changed test file. In a multi-claim block a partial addition, a figure
 * naming an unchanged file, or a token-less count in its own sentence is
 * reported on its own, and does not block the other figures (Issue #3740). A
 * `quality.sh` block and a file-less green run are out of scope by design and
 * are not reported. Comes from the same scan as `findTestPlanMismatches`.
 */
export function findUncheckedRunResults(
  opts: TestPlanScanOptions,
): UncheckedRunResult[] {
  return scanTestPlan(opts).unchecked;
}

interface TestPlanScanOptions {
  summary: string;
  /**
   * Repo-relative path → declaration counts at the head, for the PR's
   * changed test files only (total > 0).
   */
  headCounts: ReadonlyMap<string, TestDeclarationCounts>;
}

const PARTIAL_REASON =
  "the block describes partial test additions, not whole-file counts";
const UNKNOWN_CLAIM_REASON =
  "the figure names a test file the PR did not change";
const UNKNOWN_BLOCK_REASON =
  "the block names a test file the PR did not change";
const LOOSE_REASON = "the count names no test file in its own sentence";
const SUPERSEDED_REASON = "the block also gives this file's current total";
const AMBIGUOUS_REASON =
  "several counts that do not each follow the test file they count";

/** A file name in a block, with its resolved headCounts key if any (Issue #3740). */
interface BlockToken {
  start: number;
  end: number;
  key: string | undefined;
}

/**
 * How one figure in a multi-claim block is read (Issue #3740): `whole` is a
 * whole-file count, `total` a "now has N" total, `partial` an addition that is
 * never compared, `loose` a token-less count in its own sentence, `unknown` a
 * figure whose file the PR did not change, and `ambiguous` a pairing that
 * cannot be read, which blocks the whole line.
 */
type ClaimRole =
  | "whole"
  | "total"
  | "partial"
  | "loose"
  | "unknown"
  | "ambiguous";

interface RoledClaim {
  start: number;
  end: number;
  claimed: number;
  role: ClaimRole;
  /** Index into the block's tokens of the file the figure names, if any. */
  owner?: number;
}

const NOW_HAS_RE = /\bnow\s+has\s*$/i;
/** A "now has N" total with no "tests" word after it (Issue #3740). */
const TOTAL_RE = /\bnow\s+has\s+(\d{1,5})\b(?!\s+(?:tests?|passed)\b)/gi;
const ADDED_TO_FOLLOW_RE = /^\s+(?:tests?\s+)?added\s+to[\s`*_]*$/i;
const WHOLE_GAP_RE = /^[`*_\s]*\(\s*$/;
const PARTIAL_GAP_RE = /^[`*_\s]*(?:\(|with)?[`*_\s]*$/i;
const MARKER_RE = /\b(?:added|extended)\b/i;
/** "extended" governs every later figure in its sentence (Issue #3740). */
const EXTENDED_RE = /\bextended\b/i;
/** A figure's own segment that names a new file, which "extended" does not govern (Issue #3740). */
const NEW_RE = /\bnew\b/i;
/**
 * An "added" directly before a test-file token, after optional markdown and
 * whitespace, announces a new file rather than a partial addition (Issue #3740).
 */
const ADDED_FILE_TAIL_RE = /\badded[`*_\s]{0,40}$/i;
const PLUS_RE = /\+\s*$/;
const BARE_TO_RE = /(?<![\w.#])\d{1,5}\s+to[\s`*_]*$/;

function scanBlockTokens(
  raw: string,
  headCounts: ReadonlyMap<string, TestDeclarationCounts>,
): BlockToken[] {
  return [...raw.matchAll(TOKEN_RE)].map((m) => ({
    start: m.index as number,
    end: (m.index as number) + m[0].length,
    key: resolveToken(m[0], headCounts),
  }));
}

/**
 * Read each figure of a multi-claim block on its own (Issue #3740). A figure
 * is a whole-file count when only "`file` (" sits between the file name and
 * it, with no "added", "extended" or "+" since the previous claim or file
 * name. "N tests added to `file`", "N to `file`", "+N tests", "Added to `file`
 * (N tests" and "extended `file` with N tests" are partial. "now has N" is
 * the file's total and takes precedence over a partial figure for it.
 *
 * Two scope rules refine this (Issue #3740). First, "extended" governs every
 * figure later in its sentence (back to the nearest ". " or the block start),
 * so "Extended `a` (5 tests) and `b` (3 tests)" makes both figures partial;
 * a figure whose own segment contains "new" is not governed, so "Extended `a`
 * (5 tests) and the new `b` (3 tests)" keeps b whole. Second, "added" is a
 * partial marker only when it is not directly followed by the test-file
 * token: "Added `file` (33 tests)" announces a new file and stays whole,
 * while "Added to `file` (8 tests)" stays partial.
 */
function classifyBlockClaims(
  raw: string,
  claimMatches: RegExpMatchArray[],
  tokens: BlockToken[],
  isPassed: boolean,
  totalMatches: RegExpMatchArray[],
): RoledClaim[] {
  const claimStarts = claimMatches.map((m) => m.index as number);
  const claimBetween = (from: number, to: number): boolean =>
    claimStarts.some((s) => s >= from && s < to);
  // End of the nearest claim or file name ending at or before pos.
  const boundaryBefore = (pos: number): number => {
    let best = 0;
    for (const m of claimMatches) {
      const e = (m.index as number) + m[0].length;
      if (e <= pos && e > best) best = e;
    }
    for (const t of tokens) {
      if (t.end <= pos && t.end > best) best = t.end;
    }
    return best;
  };
  const lastTokenBefore = (pos: number): number | undefined => {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i]!.end <= pos) return i;
    }
    return undefined;
  };
  const roled = claimMatches.map((m): RoledClaim => {
    const start = m.index as number;
    const end = start + m[0].length;
    const claimed = Number(m[1]);
    // A passed run figure is always the whole run, read by segment (Issue #3315).
    if (isPassed) return { start, end, claimed, role: "whole" };
    const before = raw.slice(Math.max(0, start - 40), start);
    if (!isPassed && NOW_HAS_RE.test(before)) {
      const owner = lastTokenBefore(start);
      return {
        start,
        end,
        claimed,
        role: owner === undefined ? "loose" : "total",
        owner,
      };
    }
    const next = tokens.findIndex((t) => t.start >= end);
    if (
      !isPassed && next !== -1 && tokens[next]!.start - end <= 40 &&
      !claimBetween(end, tokens[next]!.start) &&
      ADDED_TO_FOLLOW_RE.test(raw.slice(end, tokens[next]!.start))
    ) {
      return { start, end, claimed, role: "partial", owner: next };
    }
    const prev = lastTokenBefore(start);
    const own = prev !== undefined && !claimBetween(tokens[prev]!.end, start) &&
        start - tokens[prev]!.end <= 80
      ? prev
      : undefined;
    if (own !== undefined) {
      const t = tokens[own]!;
      const gap = raw.slice(t.end, start);
      const segStart = Math.max(boundaryBefore(t.start), start - 200);
      const seg = raw.slice(segStart, start);
      // The segment with a trailing "added" before the file token removed.
      const head = raw.slice(segStart, t.start);
      const markerSeg = head.replace(ADDED_FILE_TAIL_RE, "") +
        seg.slice(head.length);
      const breakAt = raw.lastIndexOf(". ", start - 2);
      const sentence = raw.slice(breakAt === -1 ? 0 : breakAt + 2, start);
      const governed = EXTENDED_RE.test(sentence) && !NEW_RE.test(seg);
      if (
        WHOLE_GAP_RE.test(gap) && !MARKER_RE.test(markerSeg) && !governed
      ) {
        return { start, end, claimed, role: "whole", owner: own };
      }
      if (
        !isPassed && PARTIAL_GAP_RE.test(gap) &&
        (MARKER_RE.test(markerSeg) || governed)
      ) {
        return { start, end, claimed, role: "partial", owner: own };
      }
    }
    if (!isPassed && PLUS_RE.test(before)) {
      return { start, end, claimed, role: "partial", owner: own };
    }
    if (own !== undefined) {
      return { start, end, claimed, role: "ambiguous", owner: own };
    }
    const sentenceStart = boundaryBefore(start);
    const sentenceBreak = raw.lastIndexOf(". ", start - 2);
    return {
      start,
      end,
      claimed,
      role: sentenceBreak >= sentenceStart && sentenceBreak !== -1
        ? "loose"
        : "ambiguous",
    };
  });
  const totals = totalMatches.map((m): RoledClaim => {
    const start = m.index as number;
    const owner = lastTokenBefore(start);
    return {
      start,
      end: start + m[0].length,
      claimed: Number(m[1]),
      role: owner === undefined ? "loose" : "total",
      owner,
    };
  });
  return [...roled, ...totals].sort((a, b) => a.start - b.start).map((c) =>
    c.owner !== undefined && c.role !== "loose" &&
      tokens[c.owner]!.key === undefined
      ? { ...c, role: "unknown" }
      : c
  );
}

/** Bare "N to `file`" figures, which are partial and not claims (Issue #3740). */
function bareToTokens(
  raw: string,
  tokens: BlockToken[],
  claims: RoledClaim[],
): Set<number> {
  const owned = new Set(
    claims.flatMap((c) => (c.owner === undefined ? [] : [c.owner])),
  );
  const found = new Set<number>();
  tokens.forEach((t, i) => {
    if (
      !owned.has(i) &&
      BARE_TO_RE.test(raw.slice(Math.max(0, t.start - 40), t.start))
    ) {
      found.add(i);
    }
  });
  return found;
}

/**
 * One pass over the Test Plan section (Issue #3143, #3740). Runs and single
 * claims keep their block-level checks; a multi-claim block is classified per
 * figure by `classifyBlockClaims` and then compared or reported figure by
 * figure. Both `findTestPlanMismatches` and `findUncheckedRunResults` read
 * this result.
 */
function scanTestPlan(
  opts: TestPlanScanOptions,
): { mismatches: TestPlanMismatch[]; unchecked: UncheckedRunResult[] } {
  const section = extractTestPlanSection(opts.summary);
  const results: TestPlanMismatch[] = [];
  const unchecked: UncheckedRunResult[] = [];

  // The section's sole changed test file, for a red run that names none. A
  // run with failures against base must have run a test file the PR changed
  // (an unchanged test file passes on base), so a test file the PR did not
  // change, e.g. a path quoted inside an assertion, does not make it ambiguous.
  let soleFile: string | undefined;
  {
    const keys = new Set<string>();
    for (const m of section.matchAll(TOKEN_RE)) {
      const resolved = resolveToken(m[0], opts.headCounts);
      if (resolved !== undefined) keys.add(resolved);
    }
    if (keys.size === 1) soleFile = [...keys][0];
  }

  for (const rawLine of logicalBlocks(section)) {
    if (rawLine.includes("--filter")) continue;

    const runs: { passed: number; failed: number }[] = [];
    for (const m of rawLine.matchAll(RESULT_RE)) {
      const w1 = (m[2] ?? "").toLowerCase();
      const w2 = (m[4] ?? "").toLowerCase();
      if (w1 === w2) continue;
      const a = Number(m[1]);
      const b = Number(m[3]);
      runs.push(
        w1 === "passed" ? { passed: a, failed: b } : { passed: b, failed: a },
      );
    }
    if (runs.length > 0) {
      const outcome = checkRunResults(
        rawLine,
        runs,
        opts.headCounts,
        soleFile,
      );
      if (outcome.kind === "mismatch") results.push(outcome.mismatch);
      else if (outcome.kind === "unchecked") {
        unchecked.push({
          line: rawLine.trim().slice(0, 300),
          reason: outcome.reason,
        });
      }
      continue;
    }

    const tokens = [...rawLine.matchAll(TOKEN_RE)].map((m) => m[0]);
    if (tokens.length === 0) continue;

    const resolvedKeys = new Set<string>();
    let hasUnknownToken = false;
    for (const token of tokens) {
      const resolved = resolveToken(token, opts.headCounts);
      if (resolved === undefined) {
        hasUnknownToken = true;
        break;
      }
      resolvedKeys.add(resolved);
    }
    const claimMatches = [...rawLine.matchAll(CLAIM_RE)];
    if (claimMatches.length === 0) continue;
    const line = rawLine.trim().slice(0, 300);
    const skip = (reason: string) => unchecked.push({ line, reason });
    // A single claim keeps the block-level checks; several claims are read
    // one at a time (Issue #3740).
    const passedBlock = claimMatches.some((m) =>
      (m[2] ?? "").toLowerCase() === "passed"
    );
    const totalMatches = passedBlock ? [] : [...rawLine.matchAll(TOTAL_RE)];
    const multi = claimMatches.length + totalMatches.length > 1;
    if (!multi && hasUnknownToken) {
      skip(UNKNOWN_BLOCK_REASON);
      continue;
    }
    const claims = claimMatches.map((m) => Number(m[1]));
    const uniqueClaims = new Set(claims);
    // A "passed" figure never includes a skipped declaration; mixing a
    // "passed" claim with a "tests" claim on the same line is ambiguous.
    const words = new Set(
      claimMatches.map((m) => (m[2] ?? "").toLowerCase()),
    );
    const isPassedClaim = words.has("passed");
    if (isPassedClaim && words.size > 1) {
      skip("the block mixes tests and passed counts");
      continue;
    }
    // "Added to file (3 tests)" describes tests added to an existing file,
    // not the file's whole declaration count. A "passed" command result
    // is still the whole run.
    if (!multi && !isPassedClaim && PARTIAL_ADD_RE.test(rawLine)) {
      skip(PARTIAL_REASON);
      continue;
    }

    const countOf = (key: string): number => {
      const counts = opts.headCounts.get(key);
      return counts ? (isPassedClaim ? counts.runnable : counts.total) : 0;
    };
    const sumOf = (keys: Iterable<string>): number => {
      let sum = 0;
      for (const key of keys) sum += countOf(key);
      return sum;
    };
    const flag = (keys: string[], claimed: number) => {
      const actual = sumOf(keys);
      if (claimed !== actual) {
        results.push({
          line,
          files: keys,
          claimed,
          actual,
        });
      }
    };

    const blockTokens = scanBlockTokens(rawLine, opts.headCounts);
    const roled = multi
      ? classifyBlockClaims(
        rawLine,
        claimMatches,
        blockTokens,
        isPassedClaim,
        totalMatches,
      )
      : [];
    const bareTo = multi
      ? bareToTokens(rawLine, blockTokens, roled)
      : new Set<number>();
    const ownedIdx = new Set(
      roled.flatMap((c) => (c.owner === undefined ? [] : [c.owner])),
    );
    if (
      multi &&
      blockTokens.some((t, i) =>
        t.key === undefined && !ownedIdx.has(i) && !bareTo.has(i)
      )
    ) {
      skip(UNKNOWN_BLOCK_REASON);
      continue;
    }
    const allKeys = new Set(
      blockTokens.flatMap((t) => (t.key === undefined ? [] : [t.key])),
    );

    // One claim is a combined total for every file the block names (the
    // wrapped-paragraph shape of Issue #3356); the same figure repeated for
    // a sole file is that file's count.
    const onlyWhole = roled.every((c) =>
      c.role === "whole" || c.role === "ambiguous"
    );
    if (!multi || (allKeys.size === 1 && onlyWhole && bareTo.size === 0)) {
      if (uniqueClaims.size > 1) {
        skip("several different counts for one test file");
      } else flag([...allKeys], claims[0] as number);
      continue;
    }
    if (roled.some((c) => c.role === "ambiguous")) {
      skip(AMBIGUOUS_REASON);
      continue;
    }

    // Several claims over several files: each whole-file figure is the count
    // of the files named since the previous claim, so a wrapped sentence that
    // gives each file its own count is compared file by file. Anything that
    // does not pair up is reported, never passed (Issue #3553 review).
    const totalKeys = new Set(
      roled
        .filter((c) => c.role === "total")
        .map((c) => blockTokens[c.owner as number]!.key as string),
    );
    const excluded = new Set<number>(bareTo);
    for (const c of roled) {
      if (
        (c.role === "partial" || c.role === "unknown") && c.owner !== undefined
      ) {
        excluded.add(c.owner);
      }
    }
    const pending: UncheckedRunResult[] = [];
    for (const i of bareTo) {
      pending.push({
        line,
        reason: blockTokens[i]!.key === undefined
          ? UNKNOWN_CLAIM_REASON
          : PARTIAL_REASON,
      });
    }
    for (const c of roled) {
      if (c.role === "unknown") {
        pending.push({ line, reason: UNKNOWN_CLAIM_REASON });
      } else if (c.role === "partial") {
        pending.push({ line, reason: PARTIAL_REASON });
      } else if (c.role === "loose") {
        pending.push({ line, reason: LOOSE_REASON });
      }
    }

    const flags: { keys: string[]; claimed: number }[] = [];
    const matchedKeys = new Set<string>();
    let segmentStart = 0;
    let blocked = false;
    for (const c of roled) {
      if (c.role === "whole") {
        // A breakdown may repeat a file after its own total. Do not add that
        // file to the next run; an empty group remains unchecked.
        const keys = new Set<string>();
        blockTokens.forEach((t, i) => {
          if (
            t.key !== undefined && t.start >= segmentStart &&
            t.end <= c.start &&
            !excluded.has(i) && !matchedKeys.has(t.key)
          ) {
            keys.add(t.key);
          }
        });
        if (keys.size === 0) {
          blocked = true;
          break;
        }
        for (const k of keys) matchedKeys.add(k);
        if ([...keys].some((k) => totalKeys.has(k))) {
          pending.push({ line, reason: SUPERSEDED_REASON });
        } else flags.push({ keys: [...keys], claimed: c.claimed });
      }
      segmentStart = c.end;
    }
    if (
      !blocked &&
      blockTokens.some((t, i) =>
        t.key !== undefined && t.start >= segmentStart && !excluded.has(i)
      )
    ) {
      blocked = true;
    }
    if (blocked) {
      skip(AMBIGUOUS_REASON);
      continue;
    }
    unchecked.push(...pending);
    for (const f of flags) flag(f.keys, f.claimed);
    for (const c of roled) {
      if (c.role === "total") {
        flag([blockTokens[c.owner as number]!.key as string], c.claimed);
      }
    }
  }

  return { mismatches: results, unchecked };
}

type RunCheckOutcome =
  | { kind: "ok" }
  | { kind: "mismatch"; mismatch: TestPlanMismatch }
  | { kind: "unchecked"; reason: string };

/**
 * Compare a block's paired run results with the head: ok (matches, or out of
 * scope by design), a mismatch, or unchecked with the reason it could not be
 * compared.
 */
function checkRunResults(
  rawLine: string,
  runs: { passed: number; failed: number }[],
  headCounts: ReadonlyMap<string, TestDeclarationCounts>,
  soleFile: string | undefined,
): RunCheckOutcome {
  // A full-gate result covers the whole suite, so a failing test file it names
  // is not the file the figures count (corpus: pr-summary-3255.md, pr-summary-3292.md).
  if (/\bquality\.sh\b/.test(rawLine)) return { kind: "ok" };
  const tokens = [...rawLine.matchAll(TOKEN_RE)].map((m) => m[0]);
  let files: Set<string>;
  let candidates = runs;
  if (tokens.length > 0) {
    files = new Set<string>();
    for (const token of tokens) {
      const resolved = resolveToken(token, headCounts);
      if (resolved === undefined) {
        return {
          kind: "unchecked",
          reason:
            `the block names ${token}, which is not one of the PR's changed test files`,
        };
      }
      files.add(resolved);
    }
    // Two runs of different file sets cannot be told apart.
    if (
      files.size > 1 &&
      new Set(candidates.map((r) => r.passed + r.failed)).size > 1
    ) {
      return {
        kind: "unchecked",
        reason: "the block names several test files and its runs differ",
      };
    }
  } else {
    // A green full-suite line must never be compared; only a red run is.
    candidates = runs.filter((r) => r.failed > 0);
    if (candidates.length === 0) return { kind: "ok" };
    if (soleFile === undefined) {
      return {
        kind: "unchecked",
        reason:
          "a red result names no test file and the section has no sole changed test file",
      };
    }
    files = new Set([soleFile]);
  }
  let actual = 0;
  for (const key of files) actual += headCounts.get(key)?.runnable ?? 0;
  for (const run of candidates) {
    const claimed = run.passed + run.failed;
    if (claimed !== actual) {
      return {
        kind: "mismatch",
        mismatch: {
          line: rawLine.trim().slice(0, 300),
          files: [...files],
          claimed,
          actual,
          run,
        },
      };
    }
  }
  return { kind: "ok" };
}

/** One line describing a mismatch, for a recovery prompt or a PR reply. */
export function describeTestPlanMismatch(m: TestPlanMismatch): string {
  if (m.run) {
    return `the Test Plan line "${m.line}" reports a run of ${m.claimed} tests (${m.run.passed} passed, ${m.run.failed} failed) for ${
      m.files.join(", ")
    }, but the head has ${m.actual} runnable — re-run it on the head test file (against the base branch's production code for a red-on-base run) and replace the figures`;
  }
  if (m.files.length === 1) {
    return `the Test Plan line "${m.line}" quotes ${m.claimed} tests for ${
      m.files[0]
    }, but the head has ${m.actual}`;
  }
  return `the Test Plan line "${m.line}" quotes ${m.claimed} for ${
    m.files.join(", ")
  }, but those files have ${m.actual} at the head`;
}
