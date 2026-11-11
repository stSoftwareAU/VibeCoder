/**
 * The repository's default branch from the local clone, kept in its own module
 * so the standalone pre-push hook (`pre_push_gate_cli.ts`, which must run with
 * no bare specifiers) can use it without importing `git_push.ts`.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";

/**
 * Resolve the repository's default branch from the local clone (Issue #2584).
 *
 * Uses `git symbolic-ref refs/remotes/origin/HEAD` — the same local resolution
 * `setupRepo()` relies on — so the push guard needs no GitHub API call and works
 * purely from the working tree selected by `options.cwd`. A `git clone` sets
 * `origin/HEAD` to the remote's default branch, so this resolves correctly for
 * every monitored clone.
 *
 * @param options - Git command options (cwd selects the repo)
 * @returns The default branch name, or null when it cannot be determined
 *   (e.g. `origin/HEAD` is unset).
 */
export async function resolveLocalDefaultBranch(
  options: GitCommandOptions = {},
): Promise<string | null> {
  const result = await runGitCommand(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    options,
  );
  if (result.ok && result.value.code === 0) {
    const branch = result.value.stdout.trim().replace(
      "refs/remotes/origin/",
      "",
    );
    return branch || null;
  }
  return null;
}
