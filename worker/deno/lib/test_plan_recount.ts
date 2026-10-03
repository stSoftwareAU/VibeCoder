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
 * The PR summary is untrusted, agent-authored text, so this module only
 * ever uses bounded, hardcoded regexes against it (never `new RegExp` built
 * from input) and caps the amount of text it scans at 200_000 characters.
 */

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
function stripNonCode(source: string): string {
  let out = "";
  let i = 0;
  let prev = "";
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
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n && source[i] !== quote) {
        i += source[i] === "\\" ? 2 : 1;
      }
      i++;
      out += " ";
      prev = quote;
      continue;
    }
    if (c === "`") {
      i++;
      let depth = 0;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "`" && depth === 0) {
          i++;
          break;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (source[i] === "}" && depth > 0) {
          depth--;
          i++;
          continue;
        }
        i++;
      }
      out += " ";
      prev = "`";
      continue;
    }
    // Regex literal, only after a token that cannot end an expression
    // (operator, opening bracket, or start of input) — distinguishes
    // `const re = /foo/;` from a division `a / b` (same heuristic common
    // tokenizers use; a missed case merely falls back to the old,
    // over-counting behaviour rather than mis-stripping real code).
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
  return out;
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

function countCalls(
  text: string,
  re: RegExp,
  skippedModifiers: ReadonlySet<string>,
): TestDeclarationCounts {
  let total = 0;
  let runnable = 0;
  for (const m of text.matchAll(re)) {
    total++;
    if (!skippedModifiers.has(m[1] ?? "")) runnable++;
  }
  return { total, runnable };
}

/**
 * Count test declarations in a test file's source, both the total and the
 * subset `deno test` actually runs.
 */
export function countTestDeclarationsDetailed(
  source: string,
): TestDeclarationCounts {
  const capped = source.slice(0, MAX_SCAN_CHARS);
  const code = stripNonCode(capped);

  const denoTestRe = /\bDeno\.test(?:\.(only|ignore))?\s*\(/g;
  const itRe = /(?<![\w.$])it(?:\.(only|ignore|skip))?\s*\(/g;

  const deno = countCalls(code, denoTestRe, DENO_SKIPPED_MODIFIERS);
  const it = countCalls(code, itRe, IT_SKIPPED_MODIFIERS);

  return {
    total: deno.total + it.total,
    runnable: deno.runnable + it.runnable,
  };
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
// Captures the claim word too: a "passed" figure is what `deno test` actually
// ran (`.ignore`/`.skip` excluded); a "tests" figure is every declaration.
const CLAIM_RE = /(?<![\w.])(\d{1,5})\s+(tests?|passed)\b/gi;

export function findTestPlanMismatches(opts: {
  summary: string;
  /**
   * Repo-relative path → declaration counts at the head, for the PR's
   * changed test files only (total > 0).
   */
  headCounts: ReadonlyMap<string, TestDeclarationCounts>;
}): TestPlanMismatch[] {
  const section = extractTestPlanSection(opts.summary);
  const results: TestPlanMismatch[] = [];

  for (const rawLine of section.split("\n")) {
    if (rawLine.includes("--filter")) continue;

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

  return results;
}

/** One line describing a mismatch, for a recovery prompt or a PR reply. */
export function describeTestPlanMismatch(m: TestPlanMismatch): string {
  if (m.files.length === 1) {
    return `the Test Plan line "${m.line}" quotes ${m.claimed} tests for ${
      m.files[0]
    }, but the head has ${m.actual}`;
  }
  return `the Test Plan line "${m.line}" quotes ${m.claimed} for ${
    m.files.join(", ")
  }, but those files have ${m.actual} at the head`;
}
