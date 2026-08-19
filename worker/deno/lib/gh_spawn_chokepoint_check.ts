/**
 * Quality gate check: every `gh` subprocess must be spawned by the shared
 * chokepoint in `worker/deno/lib/gh_spawn.ts` (Issue #3703).
 *
 * `write_repo_allowlist.ts` documents a single `gh` entry-point, but ~20
 * modules had grown their own `new Deno.Command("gh", …)`, so remote branch
 * deletion, PR merge, issue close and branch-protection rewrites skipped both
 * the write-repo allowlist and the audit journal. Routing them through
 * `spawnGh`/`runGhOrThrow` fixed the instances; this check keeps the class
 * fixed by failing the build on any new direct spawn.
 *
 * Like the `needs-human` chokepoint check (Issue #2689) this is an
 * architectural, whole-codebase invariant — a static property rather than the
 * behaviour of a single function — so it lives in the quality gate, not the
 * unit-test runner. The scanning functions are pure and exported so they can
 * be tested behaviourally against literal inputs.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A single direct-spawn violation found during scanning. */
export interface GhSpawnViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending spawn. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
}

/** Result of scanning one or more directories. */
export interface GhSpawnCheckResult {
  violations: GhSpawnViolation[];
  filesScanned: number;
}

/**
 * The only file permitted to spawn `gh` directly — the chokepoint itself.
 */
export const GH_SPAWN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "worker/deno/lib/gh_spawn.ts",
]);

/** Matches a direct `gh` subprocess construction. */
export const GH_SPAWN_PATTERN =
  /new\s+Deno\.Command\s*\(\s*["'`]gh["'`]|Deno\.Command\s*\(\s*["'`]gh["'`]/;

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
 * Scan a file's content for direct `gh` spawns.
 *
 * Block comments and trailing line comments are ignored so prose mentioning
 * the forbidden pattern (including this module's own documentation) does not
 * trip a false positive.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @returns One violation per offending line.
 */
export function scanContentForGhSpawn(
  content: string,
  repoRelPath: string,
): GhSpawnViolation[] {
  const lines = stripBlockComments(content).split("\n");
  const violations: GhSpawnViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const code = rawLine.replace(/\/\/.*$/, "");
    if (GH_SPAWN_PATTERN.test(code)) {
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
 * Scan the given repo-relative directories for direct `gh` spawns outside
 * {@link GH_SPAWN_ALLOWLIST}.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 */
export async function scanDirectoriesForGhSpawn(
  repoRoot: string,
  relDirs: string[],
): Promise<GhSpawnCheckResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: GhSpawnViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    for await (const absFile of walkTsFiles(`${root}/${relDir}`)) {
      const repoRel = absFile.slice(root.length + 1);
      if (GH_SPAWN_ALLOWLIST.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      violations.push(...scanContentForGhSpawn(content, repoRel));
    }
  }

  return { violations, filesScanned };
}
