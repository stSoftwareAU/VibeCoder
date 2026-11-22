/**
 * Git settings that shut a test's git calls away from the host's config and
 * hooks (Issue #5254, Issue #5309).
 *
 * The fleet container injects a `core.hooksPath` through `GIT_CONFIG_COUNT`,
 * so a fixture push would run the host's pre-push hook. These constants close
 * that route for every git call a fixture makes.
 *
 * Fixtures using `NO_HOST_GIT_CONFIG` must set their own identity (`user.name`
 * and `user.email` via repo config, `-c`, or `GIT_AUTHOR_*`/`GIT_COMMITTER_*`),
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
 * so it cancels the host's injected `GIT_CONFIG_COUNT` entries and shuts out
 * the global and system config files.
 */
export const NO_HOST_GIT_CONFIG: Readonly<Record<string, string>> = Object
  .freeze({
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
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
