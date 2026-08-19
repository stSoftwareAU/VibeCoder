/**
 * Helpers for building safe `git branch` argument arrays (Issue #2798).
 *
 * A branch name reaching these calls is an untrusted positional: it is derived
 * from `git branch` output, the GitHub API, or a PR `headRefName`. We always
 * place the `--` end-of-options separator before it so a name beginning with
 * `-` (e.g. `-D`, `--force`) can never be parsed by git as an option rather
 * than a ref. This is argument/option-injection defence-in-depth — the calls
 * use `Deno.Command` argument arrays, so there is no shell exposure, and
 * git/GitHub already reject `-`-leading ref components — but adding the
 * separator makes the practice consistent and removes the foot-gun.
 *
 * Note: this helper deliberately covers only `git branch -d/-D`. The analogous
 * `git checkout <branch>` switch calls cannot be hardened the same way —
 * `git checkout -- <branch>` changes semantics (it treats the argument as a
 * pathspec to restore, not a branch to switch to), so a `--` separator is not
 * applicable there.
 */

/**
 * Build the argv for deleting a local branch with the `--` end-of-options
 * separator before the (untrusted) branch name.
 *
 * @param branchName - The branch to delete (untrusted positional).
 * @param force - When true use `-D` (force delete), otherwise `-d` (safe
 *   delete that refuses to drop unmerged work). Defaults to `false`.
 * @returns The git argument array, e.g. `["branch", "-d", "--", branchName]`.
 */
export function buildBranchDeleteArgs(
  branchName: string,
  force = false,
): string[] {
  return ["branch", force ? "-D" : "-d", "--", branchName];
}
