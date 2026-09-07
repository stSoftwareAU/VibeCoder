/**
 * Quality gate check: every process entry point must install the console
 * redaction patch (Issue #1280, SEC-1217-12).
 *
 * `installConsoleRedaction()` (`console_redaction.ts`, Issue #3661) patches
 * `console.*` **per process**, and for as long as it existed the repo had a
 * single call site — `mod.ts`'s `main()`. Every other entry point ran
 * unpatched: `quality.ts` streams each check's raw `stdout + stderr` to
 * stdout, so a test or lint step echoing a tokenised clone URL or an
 * `export FOO_TOKEN=…` line landed verbatim on the terminal and in the
 * worker's captured output. `setup_cli.ts` and `gh_guard_cli.ts` were in the
 * same position.
 *
 * Calling the installer in each entry point fixed the instances; this check
 * keeps the class fixed by failing the build on any new `import.meta.main`
 * module that does not install the patch.
 *
 * Like the `needs-human` chokepoint check (Issue #2689), the `gh` spawn
 * chokepoint check (Issue #3703) and the issue-create label guard
 * (Issue #1276), this is an architectural, whole-codebase invariant — a
 * static property rather than the behaviour of a single function — so it
 * lives in the quality gate, not the unit-test runner. The scanning functions
 * are pure and exported so they can be tested behaviourally against literal
 * inputs (`tests/console_redaction_entrypoint_check_test.ts`).
 *
 * Scope: production source under `worker/deno`. Test files and their fixtures
 * are excluded — they are driven by `deno test`, never spawned as a process
 * of their own, and several deliberately exercise an unpatched console.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A single entry point that never installs the console patch. */
export interface EntrypointRedactionViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the `import.meta.main` guard. */
  line: number;
  /** Trimmed text of the guard line. */
  text: string;
}

/** Result of scanning one or more directories. */
export interface EntrypointRedactionCheckResult {
  violations: EntrypointRedactionViolation[];
  filesScanned: number;
}

/** Directory names skipped during the walk — see the module comment. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set<string>([
  "tests",
  "node_modules",
]);

/** Matches the `if (import.meta.main)` guard that makes a module a process. */
export const ENTRYPOINT_GUARD_PATTERN = /\bif\s*\(\s*import\.meta\.main\s*\)/;

/** Matches a call to the console redaction installer. */
export const INSTALL_REDACTION_PATTERN = /\binstallConsoleRedaction\s*\(\s*\)/;

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

/** Strip trailing `//` line comments, preserving the line count. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Scan a file's content for an entry point that never installs the patch.
 *
 * Comments are stripped first, so prose mentioning either pattern (including
 * this module's own documentation) cannot trip a false positive.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on the violation.
 * @returns One violation per unpatched entry-point guard, else an empty list.
 */
export function scanContentForMissingRedaction(
  content: string,
  repoRelPath: string,
): EntrypointRedactionViolation[] {
  const rawLines = content.split("\n");
  const code = stripLineComments(stripBlockComments(content));
  const lines = code.split("\n");

  const guardLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ENTRYPOINT_GUARD_PATTERN.test(lines[i] ?? "")) guardLines.push(i);
  }
  if (guardLines.length === 0) return [];
  if (INSTALL_REDACTION_PATTERN.test(code)) return [];

  return guardLines.map((index) => ({
    file: repoRelPath,
    line: index + 1,
    text: (rawLines[index] ?? "").trim(),
  }));
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
      if (SKIPPED_DIRS.has(entry.name)) continue;
      yield* walkTsFiles(fullPath);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield fullPath;
    }
  }
}

/**
 * Scan the given repo-relative directories for entry points that never
 * install the console redaction patch.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 */
export async function scanDirectoriesForMissingRedaction(
  repoRoot: string,
  relDirs: string[],
): Promise<EntrypointRedactionCheckResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: EntrypointRedactionViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    for await (const absFile of walkTsFiles(`${root}/${relDir}`)) {
      const repoRel = absFile.slice(root.length + 1);
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      violations.push(...scanContentForMissingRedaction(content, repoRel));
    }
  }

  return { violations, filesScanned };
}
