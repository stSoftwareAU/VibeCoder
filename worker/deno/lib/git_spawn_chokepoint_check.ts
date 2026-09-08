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

/**
 * The directories the quality gate scans (Issue #1259).
 *
 * `worker/deno/setup` was never scanned, so the setup prerequisite probe ran
 * `git config --global …` through its own untimed, unjournalled spawn while
 * the gate reported a clean tree. Kept in step with
 * `GH_SPAWN_SCAN_DIRS` — the two checks scan the same tree.
 */
export const GIT_SPAWN_SCAN_DIRS: readonly string[] = [
  "worker/deno/lib",
  "worker/deno/commands",
  "worker/deno/setup",
];

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
  // Issue #1553: a generic pass-through runner never names the binary — its
  // argv is built by callers in other modules — so `argvHeadPattern` cannot
  // see it. `resolve_cross_repo_dep.ts` spawned real `git` that way while
  // this gate reported a clean tree.
  flagArgvHeadSpawn: true,
};

/**
 * Modules exempt from the indirection signal (Issue #1378). Their **literal**
 * spawns are never exempt. See {@link GH_INDIRECT_KNOWN_GAPS} for why a false
 * positive and a known gap are recorded as different things.
 *
 * Issue #1429 emptied the known-gap half: `benchmark.ts` builds its throwaway
 * fixture repositories through `runGitCommand` (Issue #1396) and satisfies
 * the rule on its own merits.
 *
 * The one entry below is a false positive, carried over from the checker this
 * one supersedes (Issue #1227's `GIT_VARIABLE_SPAWN_ALLOWLIST`, merged in
 * from `main`). `prerequisite_install_plan.ts` names `git` as the package a
 * host installs (Issue #1259); the process it spawns is the package manager.
 *
 * That allowlist held two further entries — `secrets_history_scan.ts`, which
 * passes `git` as the *source type* argument to gitleaks and trufflehog, and
 * `claude_runner.ts`, which lists it among the CLI tools the worker requires.
 * Neither is needed here: this rule demands an indirect construction in the
 * same file as well as the argv-head shape, and neither module has one. The
 * narrower rule needs fewer exemptions, which is the point of it.
 */
export const GIT_INDIRECT_KNOWN_GAPS: ReadonlySet<string> = new Set<string>([
  "worker/deno/setup/prerequisite_install_plan.ts",
]);

/**
 * Modules exempt from the **pass-through** rule only (Issue #1553).
 *
 * The rule asks a generic argv-head spawn to delegate `git`, because its
 * callers are invisible to a per-file scan. Every entry below is the case the
 * rule cannot distinguish: the argv head is built inside the module from
 * literals, so no caller can make it `git`. Each is a false positive with its
 * reason recorded, never a licence to spawn `git` — a literal or wrapper
 * spawn in these files is still a violation.
 *
 * `quality_gate_phase.ts` spawns the **repository's own** quality command,
 * wrapped by `asUntrustedUser` and run under a built environment with
 * `clearEnv` (Issues #571, #572). Routing it through `runGitCommand` would
 * drop that isolation, which is a worse outcome than the timeout it would
 * gain — and the argv is the repo's script, never the worker's `git`.
 *
 * `quality_helpers.ts` spawns a locally-built `timeout … bash -c <command>`
 * argv; the head is `timeout` or `bash`, chosen a few lines above the spawn.
 *
 * `quality_gate.ts` runs the gate's own tools (`deno`, `bash`, `find`), each
 * argv assembled in that module, and its `env` option is a whole-environment
 * replacement (`clearEnv`, Issue #1098) that the chokepoint does not offer.
 * Its second match is prose inside this check's own failure message.
 *
 * `software_updates.ts` runs the update tools (`brew`, `claude`, `deno`,
 * `npm`, `which`) under a caller-supplied `AbortSignal`, again from
 * module-local literals; `gh` is already delegated there by name.
 */
export const GIT_PASS_THROUGH_KNOWN_GAPS: ReadonlySet<string> = new Set<
  string
>([
  "worker/deno/lib/quality_gate.ts",
  "worker/deno/lib/quality_gate_phase.ts",
  "worker/deno/lib/software_updates.ts",
  "worker/deno/commands/quality_helpers.ts",
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
    passThroughExempt: GIT_PASS_THROUGH_KNOWN_GAPS,
  });
}
