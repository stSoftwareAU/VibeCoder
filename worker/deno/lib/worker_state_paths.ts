/**
 * Worker-owned state file shapes (Issue #1661, part of #1644).
 *
 * The worker writes a handful of its own state files into the directory it
 * runs from. When that directory happens to be a repository clone, `git add
 * -A` at the final-mile chokepoint stages them and the pre-commit safety gate
 * (Issue #1758) refuses the whole commit — losing genuine work over a file the
 * worker itself dropped there.
 *
 * This module is the single source of truth for what those files look like, so
 * the writers (`heartbeat_storage.ts`) and the chokepoint that unstages them
 * (`git_push.ts`) cannot drift apart.
 *
 * The matcher is deliberately strict: only an exact top-level name counts, so
 * a nested path or a looser shape is never silently dropped from a commit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Filename prefix of the per-issue heartbeat file. */
export const HEARTBEAT_FILE_PREFIX = ".heartbeat_";

/** Filename prefix of the per-issue heartbeat marker-state file (Issue #1454). */
export const HEARTBEAT_MARKER_FILE_PREFIX = ".heartbeat-marker_";

/** Exact filename of the cached default-branch name (Issue #1269). */
export const DEFAULT_BRANCH_CACHE_FILE = ".vibe_default_branch";

/**
 * The `<owner>_<repo>_<issue>` tail both heartbeat prefixes carry — the repo
 * with its slash replaced by an underscore, then the issue number.
 */
const REPO_AND_ISSUE_PATTERN = /^[A-Za-z0-9._-]+_\d+$/;

/**
 * Is `path` a worker-owned state file that must never reach a commit?
 *
 * @param path Repository-relative path, exactly as `git diff --cached
 *   --name-only` reports it.
 * @returns `true` only for an exact top-level worker state filename —
 *   `.heartbeat_<owner>_<repo>_<n>`, `.heartbeat-marker_<owner>_<repo>_<n>`,
 *   or `.vibe_default_branch`. Nested paths (`.heartbeat_a_1/x`), truncated
 *   shapes (`.heartbeat_a`) and everything else are `false`.
 */
export function isWorkerStatePath(path: string): boolean {
  if (path === DEFAULT_BRANCH_CACHE_FILE) return true;

  for (
    const prefix of [HEARTBEAT_FILE_PREFIX, HEARTBEAT_MARKER_FILE_PREFIX]
  ) {
    if (path.startsWith(prefix)) {
      return REPO_AND_ISSUE_PATTERN.test(path.slice(prefix.length));
    }
  }

  return false;
}
