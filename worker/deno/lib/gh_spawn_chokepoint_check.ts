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
 * A literal binary name is not the only way to spawn `gh`. Two modules wrote
 * `new Deno.Command(cmd[0]!, …)` and were handed `["gh", "api", …]` by their
 * callers, so they spawned `gh` outside the chokepoint while this check
 * reported a clean tree (Issue #1227). The check now also flags a variable
 * binary in any module that names `gh` at the head of an argv literal and does
 * not import the chokepoint.
 *
 * Like the `needs-human` chokepoint check (Issue #2689) this is an
 * architectural, whole-codebase invariant — a static property rather than the
 * behaviour of a single function — so it lives in the quality gate, not the
 * unit-test runner. The scanning machinery is shared with the sibling `git`
 * check (Issue #1214) in `spawn_chokepoint_scan.ts`, and is pure and exported
 * so both can be tested behaviourally against literal inputs.
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
 * Rules for the variable-binary half of the check (Issue #1227).
 *
 * `language_detector.ts` and `workflow_auditor.ts` spawned `new
 * Deno.Command(cmd[0]!, …)` and were handed `["gh", "api", …]` by their
 * production callers — direct `gh` spawns the literal pattern above could not
 * see. A module is flagged when it names `gh` at the head of an argv literal
 * and does not import the chokepoint.
 */
export const GH_VARIABLE_BINARY_RULES: VariableBinarySpawnOptions = {
  /** `"gh",` as an argv element — the head of a `gh` command array. */
  argvPattern: /["'`]gh["'`]\s*,/,
  /** An import of the chokepoint module, i.e. the module delegates `gh`. */
  delegationPattern: /from\s+["'][^"']*gh_spawn\.ts["']/,
  allowlist: new Set<string>(),
};

/**
 * Scan a file's content for direct `gh` spawns — both the literal binary name
 * and a variable binary in a module that names `gh` itself (Issue #1227).
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
  return [
    ...scanContentForDirectSpawn(content, repoRelPath, GH_SPAWN_PATTERN),
    ...scanContentForVariableBinarySpawn(
      content,
      repoRelPath,
      GH_VARIABLE_BINARY_RULES,
    ),
  ];
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
    variableBinary: GH_VARIABLE_BINARY_RULES,
  });
}
