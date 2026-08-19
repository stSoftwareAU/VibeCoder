/**
 * Quality gate check: no hardcoded default branch names (Issue #1182).
 *
 * Scans Deno lib/ and commands/ source files for patterns that hardcode
 * default branch names (e.g. "main", "master"). Default branches vary
 * per repo, so code must detect the branch dynamically rather than
 * assuming a specific name.
 *
 * Legitimate uses (fallbacks after dynamic detection, protected branch
 * lists) can be allow-listed with an inline `// allow-hardcoded-branch`
 * comment.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A single violation found during scanning. */
export interface BranchCheckViolation {
  file: string;
  line: number;
  content: string;
}

/** Result of scanning one or more directories. */
export interface BranchCheckResult {
  violations: BranchCheckViolation[];
  filesScanned: number;
}

const BRANCH_NAMES = ["main", "master", "Develop", "develop"]; // allow-hardcoded-branch

const ALLOW_MARKER = /\/\/\s*allow-hardcoded-branch/;

const COMMENT_LINE = /^\s*\/\//;

const BRANCH_VAR_ASSIGN = /\b\w*(?:branch|base)\w*\s*=/i;

const HARDCODED_BRANCH_STRING = new RegExp(
  `["'\`](?:${BRANCH_NAMES.join("|")})["'\`]`,
);

function buildBranchArrayPattern(): RegExp {
  const nameAlt = BRANCH_NAMES.join("|");
  const quotedName = `["'\`](?:${nameAlt})["'\`]`;
  return new RegExp(
    `\\[\\s*(?:${quotedName}\\s*,\\s*){1,}${quotedName}\\s*\\]`,
  );
}

const BRANCH_ARRAY_PATTERN = buildBranchArrayPattern();

function countBranchNamesInArray(line: string): number {
  let count = 0;
  for (const name of BRANCH_NAMES) {
    const patterns = [`"${name}"`, `'${name}'`, `\`${name}\``];
    for (const p of patterns) {
      if (line.includes(p)) {
        count++;
        break;
      }
    }
  }
  return count;
}

/**
 * Check whether a single line contains a hardcoded default branch pattern.
 *
 * Returns `true` if the line is a violation (should be flagged).
 */
export function scanLineForHardcodedBranch(line: string): boolean {
  if (ALLOW_MARKER.test(line)) return false;

  if (COMMENT_LINE.test(line)) return false;

  if (BRANCH_VAR_ASSIGN.test(line) && HARDCODED_BRANCH_STRING.test(line)) {
    return true;
  }

  if (line.includes("[") && countBranchNamesInArray(line) >= 2) {
    if (BRANCH_ARRAY_PATTERN.test(line)) return true;
  }

  return false;
}

/**
 * Scan a file's content for hardcoded branch patterns.
 *
 * Returns an array of violations with file path and line numbers.
 */
export function scanFileForHardcodedBranches(
  content: string,
  filePath: string,
): BranchCheckViolation[] {
  const violations: BranchCheckViolation[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (scanLineForHardcodedBranch(line)) {
      violations.push({
        file: filePath,
        line: i + 1,
        content: line.trim(),
      });
    }
  }

  return violations;
}

/**
 * Recursively collect `.ts` files from a directory, excluding test files.
 */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    for await (const entry of Deno.readDir(dir)) {
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        const nested = await collectSourceFiles(fullPath);
        files.push(...nested);
      } else if (
        entry.isFile &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith("_test.ts")
      ) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory does not exist — return empty
  }

  return files;
}

/**
 * Scan directories for TypeScript source files containing hardcoded
 * default branch names.
 *
 * Skips test files (`_test.ts`) and non-TypeScript files.
 */
export async function scanDirectoriesForHardcodedBranches(
  dirs: string[],
): Promise<BranchCheckResult> {
  const allViolations: BranchCheckViolation[] = [];
  let filesScanned = 0;

  for (const dir of dirs) {
    const files = await collectSourceFiles(dir);
    for (const filePath of files) {
      filesScanned++;
      const content = await Deno.readTextFile(filePath);
      const violations = scanFileForHardcodedBranches(content, filePath);
      allViolations.push(...violations);
    }
  }

  return { violations: allViolations, filesScanned };
}
