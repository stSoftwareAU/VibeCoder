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
const PARTIAL_ADD_RE = /\badded to\b|\bextended\b|\bwith\s+\d{1,5}\s+tests?\b/i;

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
 * a single "N tests"/"N passed" claim is compared with the named files' counts,
 * and a paired "N passed, M failed" run result is compared by N + M with the
 * runnable count of the test file it ran (Issue #3381).
 */
export function findTestPlanMismatches(
  opts: TestPlanScanOptions,
): TestPlanMismatch[] {
  return scanTestPlan(opts).mismatches;
}

/**
 * A paired run result the recount could not check, so it was neither
 * compared nor passed as correct (Issue #3381). The worker logs these rather
 * than letting an unchecked figure pass silently.
 */
export interface UncheckedRunResult {
  /** The Test Plan line, trimmed (truncated to 300 chars). */
  line: string;
  /** Why the result could not be compared with the head. */
  reason: string;
}

/**
 * The paired run results `findTestPlanMismatches` could not check: a block
 * naming a test file that is not one of the PR's changed test files, a block
 * naming several files whose runs differ, or a red result naming no test file
 * when the section has no sole changed test file. A `quality.sh` block and a
 * file-less green run are out of scope by design and are not reported. Comes
 * from the same scan as `findTestPlanMismatches`.
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
    if (hasUnknownToken) continue;

    const claimMatches = [...rawLine.matchAll(CLAIM_RE)];
    if (claimMatches.length === 0) continue;
    const claims = claimMatches.map((m) => Number(m[1]));
    const uniqueClaims = new Set(claims);
    if (uniqueClaims.size > 1) continue;
    // A "passed" figure never includes a skipped declaration; mixing a
    // "passed" claim with a "tests" claim on the same line is ambiguous.
    const words = new Set(
      claimMatches.map((m) => (m[2] ?? "").toLowerCase()),
    );
    const isPassedClaim = words.has("passed");
    if (isPassedClaim && words.size > 1) continue;
    // "Added to file (3 tests)" describes tests added to an existing file,
    // not the file's whole declaration count. A "passed" command result
    // is still the whole run.
    if (!isPassedClaim && PARTIAL_ADD_RE.test(rawLine)) continue;

    const claimed = claims[0] as number;
    let actual = 0;
    for (const key of resolvedKeys) {
      const counts = opts.headCounts.get(key);
      actual += counts ? (isPassedClaim ? counts.runnable : counts.total) : 0;
    }

    if (claimed !== actual) {
      results.push({
        line: rawLine.trim().slice(0, 300),
        files: [...resolvedKeys],
        claimed,
        actual,
      });
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
