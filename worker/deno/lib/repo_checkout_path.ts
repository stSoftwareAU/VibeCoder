/**
 * Derive the local checkout path of a target repo from the parent work
 * directory and its `owner/repo` slug.
 *
 * The worker clones each target repo into `${workDir}/${repoName}` (see
 * `setupRepo` in `commands/git_operations.ts`). Callers that need to read
 * the checked-out tree directly — e.g. the best-practices linter-in-CI
 * pre-check (Issue #2880) — must derive this path rather than using the
 * parent `workDir`, which holds only the clones, not the repo files.
 *
 * Single source of truth for the derivation so the linter pre-check never
 * drifts from where `setupRepo` actually places the clone.
 *
 * @param workDir Parent directory containing the local clones (the
 *   worker's `config.workDir`, e.g. `~/auto-issue-work`).
 * @param repo Repository slug in `owner/repo` form.
 * @returns Absolute-or-relative path to the repo's checked-out root.
 */
export function repoCheckoutPath(workDir: string, repo: string): string {
  const repoName = repo.split("/").pop() ?? repo;
  return `${workDir}/${repoName}`;
}
