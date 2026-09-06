/**
 * Quality gate check: every `git` subprocess must be spawned by the shared
 * chokepoint in `worker/deno/lib/git_timeout.ts` (Issue #1214).
 *
 * `runGitCommand` is the module that owns three controls no caller may skip:
 * an `AbortController` timeout (Issue #619 — a push to an unresponsive remote
 * otherwise hangs the worker rather than merely slowing it), the audit
 * journal for git mutations (Issue #2380), and the work-volume fault
 * detector (Issue #229). Seven modules had grown their own
 * `new Deno.Command("git", …)` and skipped all three — including
 * `stale_workdir.ts`, whose unpushed-work rescue ran an untimed
 * `git push origin <branch>` outside the journal. Routing them through
 * `runGitCommand` fixed the instances; this check keeps the class fixed by
 * failing the build on any new direct spawn.
 *
 * This mirrors `gh_spawn_chokepoint_check.ts` (Issue #3703) — the same
 * architectural, whole-codebase invariant applied to the other binary the
 * worker spawns most, sharing its scanning machinery via
 * `spawn_chokepoint_scan.ts`.
 *
 * Issue #1378 closed the indirection blind spot this check used to carry: a
 * spawn written as `new Deno.Command(cmd[0], …)` with `"git"` supplied by the
 * caller, or `runWithTimeout("git", …)`, is now flagged by
 * {@link GIT_INDIRECT_SPAWN_RULES} as well.
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

export type {
  DirectSpawnScanResult as GitSpawnCheckResult,
  DirectSpawnViolation as GitSpawnViolation,
};

/**
 * The only file permitted to spawn `git` directly — the chokepoint itself.
 */
export const GIT_SPAWN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "worker/deno/lib/git_timeout.ts",
]);

/** Matches a direct `git` subprocess construction. */
export const GIT_SPAWN_PATTERN =
  /new\s+Deno\.Command\s*\(\s*["'`]git["'`]|Deno\.Command\s*\(\s*["'`]git["'`]/;

/**
 * The indirection signals for `git` (Issue #1378) — the shapes that reached
 * the binary through a variable and so stayed invisible to
 * {@link GIT_SPAWN_PATTERN}.
 */
export const GIT_INDIRECT_SPAWN_RULES: IndirectSpawnRules = {
  wrapperPattern: /\brunWithTimeout\s*\(\s*["'`]git["'`]/,
  argvHeadPattern: /\(\s*\[?\s*["'`]git["'`]\s*,/,
  chokepointImportPattern: /from\s+["'`][^"'`]*git_timeout\.ts["'`]/,
};

/**
 * Modules whose indirect `git` routing predates the indirection rule
 * (Issue #1378 follow-up, #1396). `benchmark.ts` builds throwaway fixture
 * repositories — the same fixture case `excludeTests` already forgives for
 * `*_test.ts`. Their **literal** spawns are still forbidden, and the set must
 * shrink, never grow.
 */
export const GIT_INDIRECT_KNOWN_GAPS: ReadonlySet<string> = new Set<string>([
  "worker/deno/lib/benchmark.ts",
]);

/**
 * Scan a file's content for direct or indirect `git` spawns.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @returns One violation per offending line.
 */
export function scanContentForGitSpawn(
  content: string,
  repoRelPath: string,
): DirectSpawnViolation[] {
  return scanContentForDirectSpawn(
    content,
    repoRelPath,
    GIT_SPAWN_PATTERN,
    GIT_INDIRECT_SPAWN_RULES,
  );
}

/**
 * Scan the given repo-relative directories for direct `git` spawns outside
 * {@link GIT_SPAWN_ALLOWLIST}.
 *
 * Co-located `*_test.ts` files are skipped: test code builds throwaway
 * repositories with `git init`, which is a fixture, not a production surface.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 */
export function scanDirectoriesForGitSpawn(
  repoRoot: string,
  relDirs: readonly string[],
): Promise<DirectSpawnScanResult> {
  return scanDirectoriesForDirectSpawn(repoRoot, relDirs, {
    pattern: GIT_SPAWN_PATTERN,
    allowlist: GIT_SPAWN_ALLOWLIST,
    excludeTests: true,
    rules: GIT_INDIRECT_SPAWN_RULES,
    indirectExempt: GIT_INDIRECT_KNOWN_GAPS,
  });
}
