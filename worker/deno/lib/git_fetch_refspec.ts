/**
 * Fetch-refspec repair for legacy single-branch clones (Issue #211).
 *
 * `setupRepo` clones with `--depth=1 --no-single-branch` so that every branch
 * keeps a `refs/remotes/origin/<branch>` tracking ref. Clones made before that
 * flag existed — and any clone made with a bare `--depth=1`, which implies
 * `--single-branch` — carry a restricted fetch refspec forever:
 *
 * ```
 * remote.origin.fetch = +refs/heads/Develop:refs/remotes/origin/Develop
 * ```
 *
 * A clone in that state never gains a tracking ref for a feature branch, not
 * even from `git fetch origin <branch>` or a successful push. Every local
 * question about the branch ("is it pushed?", "does it conflict with its
 * base?") then silently answers about the default branch instead — the
 * NEAT-AI-core #557 false "push failed" and its spurious `merge-conflict`
 * label. `setupRepo` reuses an existing clone indefinitely, so the restricted
 * refspec has to be repaired in place rather than waited out.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";

/** The refspec that keeps a tracking ref for every branch on origin. */
export const ALL_BRANCHES_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/** Outcome of {@link ensureAllBranchesFetchRefspec}. */
export interface FetchRefspecRepair {
  /** True when the all-branches refspec had to be added to this clone. */
  repaired: boolean;
  /** The refspecs configured before any repair (for logging). */
  before: string[];
}

/**
 * Ensure `remote.origin.fetch` covers every branch, repairing a clone that
 * only tracks one (Issue #211).
 *
 * The all-branches refspec is *added*, never substituted for what is there:
 * any extra refspec a clone legitimately carries keeps working, and the call
 * is idempotent because an existing all-branches entry is left alone.
 *
 * @param options - Git command options (cwd selects the clone)
 * @returns Whether a repair was applied, or the git failure that blocked it
 */
export async function ensureAllBranchesFetchRefspec(
  options: GitCommandOptions = {},
): Promise<Result<FetchRefspecRepair>> {
  const existing = await runGitCommand(
    ["config", "--get-all", "remote.origin.fetch"],
    options,
  );
  if (!existing.ok) {
    return { ok: false, error: existing.error };
  }
  // Exit 1 means "no such key" — a clone with no fetch refspec at all still
  // needs one, so only a harder failure is an error.
  if (existing.value.code > 1) {
    return {
      ok: false,
      error: new Error(
        `Failed to read remote.origin.fetch: ${
          existing.value.stderr.trim() || `git config exit ${existing.value.code}`
        }`,
      ),
    };
  }

  const before = existing.value.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (before.includes(ALL_BRANCHES_FETCH_REFSPEC)) {
    return { ok: true, value: { repaired: false, before } };
  }

  const added = await runGitCommand(
    ["config", "--add", "remote.origin.fetch", ALL_BRANCHES_FETCH_REFSPEC],
    options,
  );
  if (!added.ok) {
    return { ok: false, error: added.error };
  }
  if (added.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Failed to add the all-branches fetch refspec: ${
          added.value.stderr.trim() || `git config exit ${added.value.code}`
        }`,
      ),
    };
  }

  return { ok: true, value: { repaired: true, before } };
}
