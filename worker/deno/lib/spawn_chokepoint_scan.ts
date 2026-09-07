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
 * Each check owns its own **literal** spawn pattern rather than composing one
 * from the binary name: a `new RegExp(...)` built from a variable is a ReDoS
 * warning the gate's own semgrep stage raises, and hardcoding two short
 * regexes is both cheaper and clearer than defending a builder.
 *
 * A literal pattern alone cannot see `new Deno.Command(cmd[0]!, …)` in a
 * module whose callers hand it `["gh", "api", …]` — the evasion Issue #1227
 * records. {@link scanContentForVariableBinarySpawn} closes that gap: a
 * variable binary is a violation when the module itself names the guarded
 * binary in an argv literal and does not route it through the chokepoint.
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

/**
 * Matches a `Deno.Command` whose binary is an expression rather than a string
 * literal — `new Deno.Command(cmd[0]!, …)` (Issue #1227).
 *
 * A literal-matching pattern cannot see such a spawn, so a module handed
 * `["gh", "api", …]` by its callers spawns the guarded binary in full view of
 * a gate that reports a clean tree.
 */
export const VARIABLE_BINARY_SPAWN_PATTERN =
  /new\s+Deno\.Command\s*\(\s*[^"'`\s)]/;

/**
 * Narrowing rules for the variable-binary scan (Issue #1227).
 *
 * A variable binary is only a violation when the module itself supplies the
 * guarded binary name — a generic subprocess helper that never mentions it is
 * not spawning it. A module that routes the binary through the chokepoint is
 * exempt: it has the control, and its remaining variable spawn is for other
 * binaries.
 */
export interface VariableBinarySpawnOptions {
  /**
   * Matches an argv literal naming the guarded binary — e.g. `"gh",` as the
   * head of a command array. Without one in the module, a variable binary is
   * some other program.
   */
  argvPattern: RegExp;
  /**
   * Matches an import of the module that owns the chokepoint. A module that
   * imports it delegates the guarded binary there, so its remaining direct
   * spawn is for other binaries.
   */
  delegationPattern: RegExp;
  /**
   * Repo-relative paths whose match is a documented false positive — the
   * argv literal names a sub-command of a *different* tool, or a tool list
   * rather than a spawn.
   */
  allowlist: ReadonlySet<string>;
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
  /**
   * Also flag a spawn whose binary is a variable (Issue #1227). Omitted, only
   * the literal {@link DirectSpawnScanOptions.pattern} is applied.
   */
  variableBinary?: VariableBinarySpawnOptions;
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
 * Strip block comments and trailing line comments, preserving newlines so
 * line numbers (and therefore reported violations) stay aligned with the
 * original source.
 *
 * Shared with the shared-tmp state-directory check (Issue #1242), which scans
 * across lines and so needs the whole file rather than one line at a time.
 *
 * @param source - The raw file text.
 * @returns The same text with comment content blanked out.
 */
export function stripLineAndBlockComments(source: string): string {
  return stripBlockComments(source)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
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

/**
 * Scan a file's content for a spawn whose binary is a variable, in a module
 * that names the guarded binary itself (Issue #1227).
 *
 * Returns nothing when the module never mentions the binary in an argv
 * literal, when it delegates the binary to the chokepoint, or when it is a
 * documented false positive. Comments are stripped first, so prose describing
 * the forbidden shape is not a violation.
 *
 * Only single-line spawns are matched — the binary and `new Deno.Command(`
 * must share a line, which is how every spawn in this tree is written.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @param options - Argv, delegation and false-positive rules.
 * @returns One violation per offending line.
 */
export function scanContentForVariableBinarySpawn(
  content: string,
  repoRelPath: string,
  options: VariableBinarySpawnOptions,
): DirectSpawnViolation[] {
  if (options.allowlist.has(repoRelPath)) return [];

  const rawLines = content.split("\n");
  const codeLines = stripBlockComments(content).split("\n").map((line) =>
    line.replace(/\/\/.*$/, "")
  );
  const code = codeLines.join("\n");

  // Not this binary's problem: no argv literal names it, or the module hands
  // it to the chokepoint.
  if (!options.argvPattern.test(code)) return [];
  if (options.delegationPattern.test(code)) return [];

  const violations: DirectSpawnViolation[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    if (VARIABLE_BINARY_SPAWN_PATTERN.test(codeLines[i] ?? "")) {
      violations.push({
        file: repoRelPath,
        line: i + 1,
        text: (rawLines[i] ?? "").trim(),
      });
    }
  }
  return violations;
}

/**
 * Recursively walk a directory yielding `.ts` file paths (absolute).
 *
 * Exported for the sibling static checks that scan the same tree
 * (Issue #1242) — the walk is identical, so it lives here once.
 *
 * @param dir - Absolute directory to walk; a missing directory yields nothing.
 * @param excludeTests - Skip `*_test.ts` files.
 */
export async function* walkTsFiles(
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
      if (options.variableBinary) {
        violations.push(
          ...scanContentForVariableBinarySpawn(
            content,
            repoRel,
            options.variableBinary,
          ),
        );
      }
    }
  }

  return { violations, filesScanned };
}
