/**
 * Git settings that shut a test's git calls away from the host's config, hooks
 * and live audit journal (Issue #5254, Issue #5309, Issue #5371, Issue #5385).
 *
 * The fleet container injects a `core.hooksPath` through `GIT_CONFIG_COUNT`,
 * so a fixture push would run the host's pre-push hook. These constants close
 * that route for every git call a fixture makes.
 *
 * `runGitCommand` journals every push to `${WORK_DIR}/audit` (or
 * `VIBE_AUDIT_DIR`) unless `VIBE_AUDIT_DISABLED` is set. The shield sets it, so
 * a fixture push writes no `git-push` row to the host journal. A test that
 * asserts on the journal must name its own `WORK_DIR`/`VIBE_AUDIT_DIR` and
 * spread `VIBE_AUDIT_DISABLED: "0"` AFTER the shield. Because `runFixtureGit`
 * and `runShieldedGit` spread the shield last, they never journal.
 *
 * Production functions a test calls (`pushUnpushedCommits`,
 * `commitAndPushPending`, `syncMilestoneBranchWithDefault`, `updatePrBranch`,
 * `claimMilestoneSync`, ...) run git through `runGitCommand`, which overlays
 * only `options.env` on the inherited environment. Such a test must therefore
 * pass `env: NO_HOST_GIT_CONFIG` in the `GitCommandOptions` it hands them,
 * spreading the shield last over any env it already has. Where a test instead
 * injects a production `runGit` seam, pass `runShieldedGit`, which applies the
 * same shield without changing the argv production built (Issue #5371).
 *
 * Fixtures and tests whose production calls commit, when using
 * `NO_HOST_GIT_CONFIG`, must set their own identity (`user.name` and
 * `user.email` via repo config, `-c`, or `GIT_AUTHOR_*`/`GIT_COMMITTER_*`),
 * because the global config is no longer read.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type GitCommandOptions,
  runGitCommand,
} from "../../lib/git_timeout.ts";

/**
 * Pass as a git child's `env`. Deno overlays it on the inherited environment,
 * so it cancels the host's injected `GIT_CONFIG_COUNT` entries, shuts out the
 * global and system config files, and switches off the audit journal
 * (Issue #5385).
 */
export const NO_HOST_GIT_CONFIG: Readonly<Record<string, string>> = Object
  .freeze({
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    VIBE_AUDIT_DISABLED: "true",
  });

/**
 * Prepend to git args so no hook runs, even where the env cannot be set.
 */
export const NO_HOST_HOOKS_ARGS: readonly string[] = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
]);

/** Fixture git with the shield spread last, so a caller's env cannot re-inject host config. */
export function runFixtureGit(
  args: string[],
  options: GitCommandOptions = {},
): ReturnType<typeof runGitCommand> {
  return runGitCommand([...NO_HOST_HOOKS_ARGS, ...args], {
    ...options,
    env: { ...options.env, ...NO_HOST_GIT_CONFIG },
  });
}

/** Shielded git for injecting as a production `runGit` seam, where argv must stay as production built it (Issue #5371). */
export function runShieldedGit(
  args: string[],
  options: GitCommandOptions = {},
): ReturnType<typeof runGitCommand> {
  return runGitCommand(args, {
    ...options,
    env: { ...options.env, ...NO_HOST_GIT_CONFIG },
  });
}
