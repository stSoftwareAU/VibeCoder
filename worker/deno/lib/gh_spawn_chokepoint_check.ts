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

/**
 * The directories the quality gate scans (Issue #1259).
 *
 * `worker/deno/setup` was never in this set, so `setup/` grew seven copies of
 * a runner that spawned `gh` itself — outside the write-repo allowlist, the
 * body redaction and the audit journal — while the gate reported a clean
 * tree. Scanning the directory is the durable half of that fix: it is what
 * stops the next one.
 */
export const GH_SPAWN_SCAN_DIRS: readonly string[] = [
  "worker/deno/lib",
  "worker/deno/commands",
  "worker/deno/setup",
];

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
 * Modules exempt from the indirection signal (Issue #1378). Their **literal**
 * spawns are never exempt.
 *
 * Two different things can put an entry here, and conflating them is how an
 * exemption set rots:
 *
 *  - a **documented false positive** — the module names `gh` as data, not as
 *    a binary, so there is nothing to fix and the entry is permanent;
 *  - a **known gap** — a real bypass carrying its own follow-up issue, which
 *    must shrink, never grow.
 *
 * Issue #1429 emptied the known-gap half: `software_updates.ts` routes
 * `gh extension install/list` through `spawnGh` (Issue #1396) and satisfies
 * the rule on its own merits.
 *
 * The one entry below is a false positive, carried over from the checker this
 * one supersedes (Issue #1227's `GH_VARIABLE_SPAWN_ALLOWLIST`, merged in from
 * `main`). `prerequisite_install_plan.ts` names `gh` as *package data* — the
 * formula and package identifiers a host installs the CLI from, written
 * `brewFormula("gh", "gh")`, which reads to the argv-head pattern as a
 * command array. The one process it spawns is the package manager (`brew`,
 * `apt-get`, `winget`), never `gh`.
 */
export const GH_INDIRECT_KNOWN_GAPS: ReadonlySet<string> = new Set<string>([
  "worker/deno/setup/prerequisite_install_plan.ts",
]);

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
