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
 * unit-test runner. The scanning machinery is shared with the sibling `git`
 * check (Issue #1214) in `spawn_chokepoint_scan.ts`, and is pure and exported
 * so both can be tested behaviourally against literal inputs.
 *
 * Issue #1378 closed the indirection blind spot this check used to carry: a
 * spawn written as `new Deno.Command(cmd[0], …)` with `"gh"` supplied by the
 * caller, or `runWithTimeout("gh", …)`, is now flagged by
 * {@link GH_INDIRECT_SPAWN_RULES} as well.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  type DirectSpawnScanResult,
  type DirectSpawnViolation,
  type IndirectSpawnRules,
  scanContentForDirectSpawn,
  scanDirectoriesForDirectSpawn,
} from "./spawn_chokepoint_scan.ts";

/** A single direct-spawn violation found during scanning. */
export type GhSpawnViolation = DirectSpawnViolation;

/** Result of scanning one or more directories. */
export type GhSpawnCheckResult = DirectSpawnScanResult;

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
 * The indirection signals for `gh` (Issue #1378) — the shapes that reached
 * the binary through a variable and so stayed invisible to
 * {@link GH_SPAWN_PATTERN}.
 */
export const GH_INDIRECT_SPAWN_RULES: IndirectSpawnRules = {
  wrapperPattern: /\brunWithTimeout\s*\(\s*["'`]gh["'`]/,
  argvHeadPattern: /\(\s*\[?\s*["'`]gh["'`]\s*,/,
  chokepointImportPattern: /from\s+["'`][^"'`]*gh_spawn\.ts["'`]/,
};

/**
 * Modules exempt from the indirection signal (Issue #1378). Empty since
 * Issue #1429: the one entry, `software_updates.ts`, routes `gh extension
 * install/list` through `spawnGh` (Issue #1396) and satisfies the rule on
 * its own merits. Their **literal** spawns were never exempt. The set stays
 * as the documented shape for a future gap — and must shrink, never grow.
 */
export const GH_INDIRECT_KNOWN_GAPS: ReadonlySet<string> = new Set<string>();

/**
 * Scan a file's content for direct or indirect `gh` spawns.
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
  return scanContentForDirectSpawn(
    content,
    repoRelPath,
    GH_SPAWN_PATTERN,
    GH_INDIRECT_SPAWN_RULES,
  );
}

/**
 * Scan the given repo-relative directories for direct `gh` spawns outside
 * {@link GH_SPAWN_ALLOWLIST}.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 */
export function scanDirectoriesForGhSpawn(
  repoRoot: string,
  relDirs: readonly string[],
): Promise<GhSpawnCheckResult> {
  return scanDirectoriesForDirectSpawn(repoRoot, relDirs, {
    pattern: GH_SPAWN_PATTERN,
    allowlist: GH_SPAWN_ALLOWLIST,
    rules: GH_INDIRECT_SPAWN_RULES,
    indirectExempt: GH_INDIRECT_KNOWN_GAPS,
  });
}
