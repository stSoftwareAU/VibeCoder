/**
 * Retry a merge that refused as "unrelated histories" after unshallowing
 * (Issue #2896).
 *
 * A shallow clone (`--depth=1 --no-single-branch`) only carries the commits
 * git fetched, so `git merge <ref>` can find no common ancestor locally even
 * though one exists on the remote — git then refuses with "fatal: refusing
 * to merge unrelated histories", and the milestone sync used to report that
 * as the genuinely-unrelated, permanent non-conflict failure it is for an
 * orphan branch, rather than the shallow-history artefact it actually is
 * here.
 *
 * This is deliberately the LAST resort, run only once the first merge has
 * already refused: unshallowing fetches the repository's entire history,
 * which is exactly the cost `ensureHistoryDepth`'s doubling steps exist to
 * avoid paying on every sync. A refusal that is NOT the unrelated-histories
 * message, or a repository that is not shallow, is handed straight back —
 * nothing here changes the failure a genuinely unrelated history reports.
 *
 * A refusal with "unrelated histories" happens before git starts applying
 * the merge — no index is touched, no `MERGE_HEAD` is written — so no
 * `git merge --abort` is needed before the retry.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions, GitCommandOutput } from "./git_timeout.ts";
import { isShallowRepo } from "./git_history.ts";
import { describeGitFailure } from "./milestone_merge_state.ts";

/** Matches git's own "refusing to merge unrelated histories" refusal. */
const UNRELATED_HISTORIES_RE = /refusing to merge unrelated histories/i;

/** Whether a merge result's own output names the unrelated-histories refusal. */
function isUnrelatedHistoriesRefusal(
  result: Result<GitCommandOutput>,
): boolean {
  if (!result.ok) return false;
  const text = `${result.value.stderr}\n${result.value.stdout}`;
  return UNRELATED_HISTORIES_RE.test(text);
}

/**
 * Run `git merge <ref> --no-edit`, and when it refuses because the clone is
 * too shallow to see the merge base, unshallow and retry exactly once
 * (Issue #2896).
 *
 * @param ref - The ref to merge into the current branch (e.g. the default
 *   branch name)
 * @param options - Git command options
 * @returns The merge result to use — the first attempt, unless it refused
 *   as unrelated histories AND the repository was shallow, in which case the
 *   retried merge (success or failure) is returned instead. Only the
 *   unshallow itself failing is reported as an error here.
 */
export async function mergeWithUnshallowRetry(
  ref: string,
  options: GitCommandOptions = {},
): Promise<Result<GitCommandOutput>> {
  const firstAttempt = await runGitCommand(
    ["merge", ref, "--no-edit"],
    options,
  );

  if (firstAttempt.ok && firstAttempt.value.code === 0) return firstAttempt;
  if (!isUnrelatedHistoriesRefusal(firstAttempt)) return firstAttempt;

  const shallow = await isShallowRepo(options);
  if (!shallow.ok || !shallow.value) {
    // Not shallow (or the shallow check itself could not be run) — this is
    // a genuinely unrelated history, or the check failed; either way
    // unshallowing would not help, so the original refusal stands.
    return firstAttempt;
  }

  const unshallowed = await runGitCommand(
    ["fetch", "--unshallow", "origin"],
    options,
  );
  if (!unshallowed.ok || unshallowed.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Refusing to merge '${ref}': the shallow clone could not be ` +
          `unshallowed after a "refusing to merge unrelated histories" ` +
          `refusal (Issue #2896): ${describeGitFailure(unshallowed)}`,
      ),
    };
  }

  return await runGitCommand(["merge", ref, "--no-edit"], options);
}
