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

/** Count test declarations in a test file's source. */
export function countTestDeclarations(source: string): number {
  const capped = source.slice(0, MAX_SCAN_CHARS);

  // Strip block comments first, then any line whose trimmed start is `//`
  // (an inline `//` is left alone so URLs embedded in strings survive).
  const withoutBlockComments = capped.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");

  const denoTestRe = /\bDeno\.test(?:\.(?:only|ignore))?\s*\(/g;
  const itRe = /(?<![\w.$])it(?:\.(?:only|ignore|skip))?\s*\(/g;

  const denoCount = [...withoutLineComments.matchAll(denoTestRe)].length;
  const itCount = [...withoutLineComments.matchAll(itRe)].length;

  return denoCount + itCount;
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
  headCounts: ReadonlyMap<string, number>,
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
const CLAIM_RE = /(?<![\w.])(\d{1,5})\s+(?:tests?|passed)\b/gi;

export function findTestPlanMismatches(opts: {
  summary: string;
  /**
   * Repo-relative path → declarations counted at the head, for the PR's
   * changed test files only (count > 0).
   */
  headCounts: ReadonlyMap<string, number>;
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

    const claims = [...rawLine.matchAll(CLAIM_RE)].map((m) => Number(m[1]));
    if (claims.length === 0) continue;
    const uniqueClaims = new Set(claims);
    if (uniqueClaims.size > 1) continue;

    const claimed = claims[0] as number;
    let actual = 0;
    for (const key of resolvedKeys) {
      actual += opts.headCounts.get(key) ?? 0;
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
