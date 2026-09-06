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
 * A literal pattern cannot see `new Deno.Command(cmd[0], …)` with `"git"`
 * supplied by the caller, so the check also flags a variable binary in any
 * module that names `git` at the head of an argv literal and does not import
 * the chokepoint (Issue #1227).
 *
 * Residual risk, stated: the variable-binary half is module-level, so a module
 * that legitimately imports `git_timeout.ts` for one path can still spawn a
 * variable `git` on another, and the two entries in
 * {@link GIT_VARIABLE_SPAWN_ALLOWLIST} are exempt outright.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  type DirectSpawnScanResult,
  type DirectSpawnViolation,
  scanContentForDirectSpawn,
  scanContentForVariableBinarySpawn,
  scanDirectoriesForDirectSpawn,
  type VariableBinarySpawnOptions,
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
 * Modules whose `git` argv literal is not a `git` spawn (Issue #1227).
 *
 * Both name `git` as data rather than as a binary: `secrets_history_scan.ts`
 * passes it as the *source type* argument to gitleaks and trufflehog
 * (`gitleaks git <dir>`), and `claude_runner.ts` lists it among the CLI tools
 * the worker requires. Neither spawns `git` itself.
 */
export const GIT_VARIABLE_SPAWN_ALLOWLIST: ReadonlySet<string> = new Set<
  string
>([
  "worker/deno/lib/secrets_history_scan.ts",
  "worker/deno/lib/claude_runner.ts",
]);

/** Rules for the variable-binary half of the check (Issue #1227). */
export const GIT_VARIABLE_BINARY_RULES: VariableBinarySpawnOptions = {
  /** `"git",` as an argv element — the head of a `git` command array. */
  argvPattern: /["'`]git["'`]\s*,/,
  /** An import of the chokepoint module, i.e. the module delegates `git`. */
  delegationPattern: /from\s+["'][^"']*git_timeout\.ts["']/,
  allowlist: GIT_VARIABLE_SPAWN_ALLOWLIST,
};

/**
 * Scan a file's content for direct `git` spawns — both the literal binary
 * name and a variable binary in a module that names `git` itself.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @returns One violation per offending line.
 */
export function scanContentForGitSpawn(
  content: string,
  repoRelPath: string,
): DirectSpawnViolation[] {
  return [
    ...scanContentForDirectSpawn(content, repoRelPath, GIT_SPAWN_PATTERN),
    ...scanContentForVariableBinarySpawn(
      content,
      repoRelPath,
      GIT_VARIABLE_BINARY_RULES,
    ),
  ];
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
    variableBinary: GIT_VARIABLE_BINARY_RULES,
  });
}
