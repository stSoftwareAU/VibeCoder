/**
 * Shared machinery for the direct-subprocess-spawn chokepoint checks.
 *
 * Two quality-gate checks enforce the same architectural invariant against
 * different binaries — `gh` (Issue #3703) and `git` (Issue #1214): a
 * subprocess for that binary may only be constructed inside the one module
 * that owns the allowlist, the timeout and the audit journal for it. The
 * scanning half of both checks is identical, so it lives here once rather
 * than being copied per binary.
 *
 * The scanning functions are pure (or filesystem-only) and exported so each
 * check can be tested behaviourally against literal inputs.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A single direct-spawn violation found during scanning. */
export interface DirectSpawnViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending spawn. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
}

/** Result of scanning one or more directories. */
export interface DirectSpawnScanResult {
  violations: DirectSpawnViolation[];
  filesScanned: number;
}

/** Options for {@link scanDirectoriesForDirectSpawn}. */
export interface DirectSpawnScanOptions {
  /** Matches a direct construction of the guarded binary. */
  pattern: RegExp;
  /** Repo-relative paths permitted to spawn the binary directly. */
  allowlist: ReadonlySet<string>;
  /**
   * Skip `*_test.ts` files. Test code builds throwaway fixtures (temporary
   * git repositories, for instance) and is not a production surface.
   */
  excludeTests?: boolean;
}

/**
 * Build the pattern matching a direct `new Deno.Command("<binary>", …)`.
 *
 * @param binary - The guarded executable name, e.g. `git`.
 * @returns A regular expression matching either spawn spelling.
 */
export function directSpawnPattern(binary: string): RegExp {
  return new RegExp(
    `new\\s+Deno\\.Command\\s*\\(\\s*["'\`]${binary}["'\`]` +
      `|Deno\\.Command\\s*\\(\\s*["'\`]${binary}["'\`]`,
  );
}

/**
 * Strip C-style block comments, preserving newlines so line numbers stay
 * aligned.
 */
function stripBlockComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\//g,
    (match) => match.replace(/[^\n]/g, " "),
  );
}

/**
 * Scan a file's content for direct spawns of the guarded binary.
 *
 * Block comments and trailing line comments are ignored so prose mentioning
 * the forbidden pattern (including a check module's own documentation) does
 * not trip a false positive.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @param pattern - The spawn pattern from {@link directSpawnPattern}.
 * @returns One violation per offending line.
 */
export function scanContentForDirectSpawn(
  content: string,
  repoRelPath: string,
  pattern: RegExp,
): DirectSpawnViolation[] {
  const lines = stripBlockComments(content).split("\n");
  const violations: DirectSpawnViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const code = rawLine.replace(/\/\/.*$/, "");
    if (pattern.test(code)) {
      violations.push({
        file: repoRelPath,
        line: i + 1,
        text: rawLine.trim(),
      });
    }
  }

  return violations;
}

/** Recursively walk a directory yielding `.ts` file paths (absolute). */
async function* walkTsFiles(
  dir: string,
  excludeTests: boolean,
): AsyncGenerator<string> {
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
      yield* walkTsFiles(fullPath, excludeTests);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      if (excludeTests && entry.name.endsWith("_test.ts")) continue;
      yield fullPath;
    }
  }
}

/**
 * Scan the given repo-relative directories for direct spawns outside the
 * allowlist.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @param options - Pattern, allowlist and test-file handling.
 * @returns Aggregated violations and the number of files scanned.
 */
export async function scanDirectoriesForDirectSpawn(
  repoRoot: string,
  relDirs: readonly string[],
  options: DirectSpawnScanOptions,
): Promise<DirectSpawnScanResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: DirectSpawnViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    for await (
      const absFile of walkTsFiles(
        `${root}/${relDir}`,
        options.excludeTests ?? false,
      )
    ) {
      const repoRel = absFile.slice(root.length + 1);
      if (options.allowlist.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      violations.push(
        ...scanContentForDirectSpawn(content, repoRel, options.pattern),
      );
    }
  }

  return { violations, filesScanned };
}
