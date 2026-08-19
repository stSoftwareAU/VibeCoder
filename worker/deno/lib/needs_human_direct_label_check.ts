/**
 * Quality gate check: every `needs-human` label application must go through
 * the shared `escalateToHuman` helper (Issue #2689, originally #2212/#2202).
 *
 * The helper in `worker/deno/lib/needs_human_escalation.ts` is the only
 * chokepoint that guarantees an accompanying same-run explanation comment.
 * A direct `addLabel(... needsHumanLabel)` or
 * `addLabel(..., "needs-human")` call elsewhere in `worker/deno/lib/` or
 * `worker/deno/commands/` would re-introduce the silent-escalation
 * regression class.
 *
 * This is an architectural, whole-codebase invariant — a static property
 * rather than the behaviour of a single function — so it lives in the
 * quality gate (the CI config) alongside the benchmark audit and the
 * hardcoded-branch check, not in the unit-test runner where it would be
 * mistaken for a behavioural test (Issue #2689). The behaviour of the
 * helper itself (label + same-run comment) is covered behaviourally by
 * `worker/deno/tests/needs_human_escalation_test.ts`.
 *
 * The scanning functions below are pure and exported, so they can be
 * tested behaviourally with literal inputs (see
 * `tests/needs_human_direct_label_check_test.ts`).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A single direct-application violation found during scanning. */
export interface DirectNeedsHumanViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending call. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
  /** Source of the regex that matched (for diagnostics). */
  pattern: string;
}

/** Result of scanning one or more directories. */
export interface DirectNeedsHumanCheckResult {
  violations: DirectNeedsHumanViolation[];
  filesScanned: number;
}

/**
 * Files permitted to apply `needs-human` directly. The helper itself is
 * the only production allowance — every other caller must route through
 * `escalateToHuman`.
 */
export const NEEDS_HUMAN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "worker/deno/lib/needs_human_escalation.ts",
]);

/**
 * Patterns that count as a direct `needs-human` label application. The
 * literal label string is matched case-insensitively.
 */
export const NEEDS_HUMAN_VIOLATION_PATTERNS: ReadonlyArray<RegExp> = [
  /\.addLabel\s*\([^)]*needsHumanLabel/,
  /\.addLabel\s*\([^)]*["']needs-human["']/i,
  /addLabelToIssue\s*\([^)]*["']needs-human["']/i,
  /addLabelToIssue\s*\([^)]*needsHumanLabel/,
];

/**
 * Strip C-style block comments from `source`, preserving newlines so line
 * numbers stay aligned.
 */
function stripBlockComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\//g,
    (match) => match.replace(/[^\n]/g, " "),
  );
}

/**
 * Scan a file's content for direct `needs-human` label applications.
 *
 * Block comments and trailing line comments are ignored so that prose
 * mentioning the forbidden pattern does not trip a false positive.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @returns One violation per offending line (at most one per line).
 */
export function scanContentForDirectNeedsHuman(
  content: string,
  repoRelPath: string,
): DirectNeedsHumanViolation[] {
  const stripped = stripBlockComments(content);
  const lines = stripped.split("\n");
  const violations: DirectNeedsHumanViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    // Strip a trailing line comment. Conservative: any `//` terminates the
    // code portion. The patterns we care about would never legitimately
    // appear inside a string anyway — this strip only prevents false
    // positives where someone mentions the pattern in a `// note: …`.
    const code = rawLine.replace(/\/\/.*$/, "");
    for (const pattern of NEEDS_HUMAN_VIOLATION_PATTERNS) {
      if (pattern.test(code)) {
        violations.push({
          file: repoRelPath,
          line: i + 1,
          text: rawLine.trim(),
          pattern: pattern.source,
        });
        // One violation per line is enough — don't double-report on
        // overlapping patterns.
        break;
      }
    }
  }

  return violations;
}

/** Recursively walk a directory yielding `.ts` file paths (absolute). */
async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    // Directory does not exist — yield nothing.
    return;
  }
  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTsFiles(fullPath);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield fullPath;
    }
  }
}

/**
 * Scan the given repo-relative directories for direct `needs-human` label
 * applications outside the {@link NEEDS_HUMAN_ALLOWLIST}.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 */
export async function scanDirectoriesForDirectNeedsHuman(
  repoRoot: string,
  relDirs: string[],
): Promise<DirectNeedsHumanCheckResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: DirectNeedsHumanViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    const absDir = `${root}/${relDir}`;
    for await (const absFile of walkTsFiles(absDir)) {
      const repoRel = absFile.slice(root.length + 1);
      if (NEEDS_HUMAN_ALLOWLIST.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      violations.push(...scanContentForDirectNeedsHuman(content, repoRel));
    }
  }

  return { violations, filesScanned };
}
