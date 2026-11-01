/**
 * Whether a PR's base branch sits behind a GitHub merge queue (Issue #4424).
 *
 * A branch whose effective rules include a `merge_queue` rule is landed by
 * that queue, which tests each PR against the real future head of the branch.
 * Three worker paths must therefore treat such a base differently:
 *
 * - the branch-update maintenance loop treats a queued base the same as any
 *   other: it never updates a PR merely because it is behind, and only its log
 *   wording differs (it still merges the base in for conflicts) (Issue #4613);
 * - the direct-merge fallback never lands a PR on a queued base;
 * - the auto-merge sweep does not ask GitHub to update an armed, behind PR.
 *
 * Only the default branch can be queued. A milestone branch keeps its rules,
 * and the rules endpoint simply does not report `merge_queue` for it.
 *
 * Every consumer treats `null` (the lookup failed, or the input was invalid)
 * as "not queued" — today's behaviour. GitHub itself still refuses a bypass.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { isValidBranchName, isValidRepoSlug } from "./repo_rulesets.ts";

/** GitHub's rule type name for a merge queue. */
export const MERGE_QUEUE_RULE_TYPE_NAME = "merge_queue";

/** How long a lookup result is trusted before it is read again (10 minutes). */
const MEMO_TTL_MS = 10 * 60 * 1000;

/** Run a `gh` command and return its stdout. */
type GhCommandFn = (args: string[]) => Promise<string>;

/**
 * Read whether a base branch's effective rules include a merge queue.
 *
 * Mirrors `isBaseProtected` in pr_auto_merge.ts. Returns `null` when the
 * lookup fails or either input is outside the allowlist — never a guess.
 *
 * @param repo - Repository in "owner/repo" format
 * @param baseRefName - Base branch name
 * @param ghCommandFn - Injectable gh command runner
 */
export async function isBaseMergeQueued(
  repo: string,
  baseRefName: string,
  ghCommandFn: GhCommandFn,
): Promise<boolean | null> {
  if (!isValidRepoSlug(repo) || !isValidBranchName(baseRefName)) {
    return null;
  }
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/rules/branches/${encodeURIComponent(baseRefName)}`,
      "--jq",
      '[.[] | .type] | join(",")',
    ]);
    const types = raw.trim().split(",").filter((t) => t.length > 0);
    return types.includes(MERGE_QUEUE_RULE_TYPE_NAME);
  } catch {
    return null;
  }
}

/** A memoised lookup and the instant it stops being trusted. */
interface MemoEntry {
  value: boolean;
  expiresAt: number;
}

/**
 * Per-process memo keyed `repo#base`. The worker is long-running, so a
 * permanent memo would hide a queue enabled after the first read; entries
 * expire after {@link MEMO_TTL_MS}.
 */
const mergeQueueMemo = new Map<string, MemoEntry>();

/** Clear the merge-queue memo (tests). */
export function _resetMergeQueueMemo(): void {
  mergeQueueMemo.clear();
}

/**
 * Read a base's merge-queue state through the memo.
 *
 * A `null` result is never memoised, so a flaky read is retried on the next
 * call rather than pinned for ten minutes.
 *
 * @param repo - Repository in "owner/repo" format
 * @param baseRefName - Base branch name
 * @param ghCommandFn - Injectable gh command runner
 * @param options - Injectable lookup and clock (tests)
 */
export async function resolveBaseMergeQueued(
  repo: string,
  baseRefName: string,
  ghCommandFn: GhCommandFn,
  options: {
    isBaseMergeQueuedFn?: typeof isBaseMergeQueued;
    now?: () => number;
  } = {},
): Promise<boolean | null> {
  const now = options.now ?? Date.now;
  const memoKey = `${repo}#${baseRefName}`;
  const memoised = mergeQueueMemo.get(memoKey);
  if (memoised !== undefined && memoised.expiresAt > now()) {
    return memoised.value;
  }
  const read = await (options.isBaseMergeQueuedFn ?? isBaseMergeQueued)(
    repo,
    baseRefName,
    ghCommandFn,
  );
  if (read !== null) {
    mergeQueueMemo.set(memoKey, {
      value: read,
      expiresAt: now() + MEMO_TTL_MS,
    });
  }
  return read;
}

/**
 * Build the production `isMergeQueueBase` dep for the branch-update scan and
 * the auto-merge sweep (Issue #4424): {@link resolveBaseMergeQueued} through
 * `ghCommandFn`, with a `null` read treated as "not queued".
 *
 * @param ghCommandFn - The gh runner the caller already uses
 */
export function makeIsMergeQueueBase(
  ghCommandFn: GhCommandFn,
): (repo: string, baseRefName: string) => Promise<boolean> {
  return async (repo, baseRefName) =>
    (await resolveBaseMergeQueued(repo, baseRefName, ghCommandFn)) === true;
}
