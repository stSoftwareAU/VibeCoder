/**
 * Quality gate check: a worker state directory under the host's shared
 * temporary root must be composed by `sharedTmpStateDir()`, never by raw
 * interpolation of `TMPDIR`/`TEMP`/`TMP` or a fixed `/tmp` literal
 * (Issue #1242, SEC-1215-06, CWE-377).
 *
 * `private_cache_dir.ts` exists because a fixed path under a world-writable
 * temporary root is the same path for every account on the host, so whoever
 * creates it first owns what the worker later reads back (Issue #3709). Issue
 * #1215 moved the file-backed caches onto the helper; the label cache, the
 * Playwright MCP config, the audit journal, the repo failure counters and the
 * browser profile still built their own path, which is the residual this
 * check closes for good.
 *
 * Like the `gh` spawn chokepoint check (Issue #3703) this is an
 * architectural, whole-codebase invariant — a static property of the tree
 * rather than the behaviour of one function — so it lives in the quality gate
 * rather than the unit-test runner, and the scanning functions are pure and
 * exported so they can be tested behaviourally against literal inputs.
 *
 * Two shapes are flagged:
 *
 *  - an interpolated temp root followed by a further path segment, whether
 *    the root is read inline or held in a local variable; and
 *  - a fixed `/tmp/` literal naming a worker state directory — either a
 *    `vibe-` prefixed name or an interpolated constant.
 *
 * Deliberately out of scope: a temp root reached through a helper function
 * the scanner cannot follow, and a `/tmp/<fixed-name>` literal that is
 * neither of the two shapes above (`/tmp/auto-issue-work`, test doubles).
 * Those are not worker state directories built from the environment, and
 * widening the rule to reach them costs false positives the gate cannot
 * afford.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  stripLineAndBlockComments,
  walkTsFiles,
} from "./spawn_chokepoint_scan.ts";

/** A single shared-tmp path construction found during scanning. */
export interface SharedTmpPathViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number the offending path segment lands on. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
}

/** Result of scanning one or more directories. */
export interface SharedTmpPathScanResult {
  violations: SharedTmpPathViolation[];
  filesScanned: number;
}

/**
 * Files permitted to name the shared temporary root directly.
 *
 * `private_cache_dir.ts` is the helper itself — it is the one place the root
 * is read and a per-account directory composed from it.
 */
export const TMP_STATE_DIR_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "worker/deno/lib/private_cache_dir.ts",
]);

/** Matches an environment read of the host's shared temporary root. */
export const TMP_ENV_READ_PATTERN =
  /(?:Deno\.env\.get|env|lookup|getEnv)\s*\(\s*["'`](?:TMPDIR|TEMP|TMP)["'`]/;

/** Matches a declaration, capturing its name and its initialiser. */
const DECLARATION_PATTERN =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([^;]*);/g;

/**
 * Matches `${…}` followed immediately by a further literal path segment.
 *
 * The interpolated expression may span lines but may not contain a brace of
 * its own: a `[\s\S]*?` inner would backtrack across the whole file to reach
 * some later `}/segment`, and report an unrelated line as a violation.
 */
const INTERPOLATED_CHILD_PATTERN = /\$\{([^{}]*)\}(\/[A-Za-z0-9._-]+)/g;

/**
 * Matches a fixed shared-root literal naming a state directory — either a
 * `vibe-` prefixed name or a name supplied by an interpolated constant.
 */
const LITERAL_TMP_STATE_DIR_PATTERN = /["'`]\/tmp\/(?:\$\{|vibe-)/g;

/** Names bound to the shared temporary root within one file. */
function tmpRootIdentifiers(code: string): Set<string> {
  const names = new Set<string>();
  for (const match of code.matchAll(DECLARATION_PATTERN)) {
    const name = match[1];
    const initialiser = match[2] ?? "";
    if (name && TMP_ENV_READ_PATTERN.test(initialiser)) names.add(name);
  }
  return names;
}

/** 1-based line number of `index` within `code`. */
function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === "\n") line++;
  }
  return line;
}

/** Matches every identifier token in an expression. */
const IDENTIFIER_TOKEN_PATTERN = /[A-Za-z_$][\w$]*/g;

/**
 * Whether `expression` resolves to the shared temporary root — read inline,
 * or through a name bound to it earlier in the same file.
 *
 * Identifier tokens are compared against the set rather than compiled into a
 * `new RegExp(name)`, which the gate's own semgrep stage flags as a ReDoS
 * risk (see `spawn_chokepoint_scan.ts`).
 */
function isTmpRootExpression(
  expression: string,
  identifiers: ReadonlySet<string>,
): boolean {
  if (TMP_ENV_READ_PATTERN.test(expression)) return true;
  for (const token of expression.matchAll(IDENTIFIER_TOKEN_PATTERN)) {
    if (identifiers.has(token[0])) return true;
  }
  return false;
}

/**
 * Scan a file's content for a state directory built from the shared
 * temporary root by hand.
 *
 * Comments are stripped first, so prose describing the fault — including
 * this module's own documentation — is not a violation.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @returns One violation per offending construction, in line order.
 */
export function scanContentForSharedTmpPath(
  content: string,
  repoRelPath: string,
): SharedTmpPathViolation[] {
  const rawLines = content.split("\n");
  const code = stripLineAndBlockComments(content);
  const identifiers = tmpRootIdentifiers(code);
  const lines = new Set<number>();

  for (const match of code.matchAll(INTERPOLATED_CHILD_PATTERN)) {
    if (!isTmpRootExpression(match[1] ?? "", identifiers)) continue;
    // Report where the child segment sits: a multi-line interpolation should
    // point at the name being composed, not at the opening backtick.
    lines.add(lineOf(code, (match.index ?? 0) + match[0].length));
  }

  for (const match of code.matchAll(LITERAL_TMP_STATE_DIR_PATTERN)) {
    lines.add(lineOf(code, match.index ?? 0));
  }

  return [...lines].sort((a, b) => a - b).map((line) => ({
    file: repoRelPath,
    line,
    text: (rawLines[line - 1] ?? "").trim(),
  }));
}

/**
 * Scan the given repo-relative directories for hand-built shared-tmp state
 * directories outside {@link TMP_STATE_DIR_ALLOWLIST}.
 *
 * Test files are skipped: a test legitimately builds throwaway paths under a
 * directory it created itself.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 */
export async function scanDirectoriesForSharedTmpPath(
  repoRoot: string,
  relDirs: readonly string[],
): Promise<SharedTmpPathScanResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: SharedTmpPathViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    for await (const absFile of walkTsFiles(`${root}/${relDir}`, true)) {
      const repoRel = absFile.slice(root.length + 1);
      if (TMP_STATE_DIR_ALLOWLIST.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      violations.push(...scanContentForSharedTmpPath(content, repoRel));
    }
  }

  return { violations, filesScanned };
}
