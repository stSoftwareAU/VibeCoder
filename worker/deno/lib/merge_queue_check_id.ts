/**
 * Synthetic check identity for a merge-queue removal (Issue #4424).
 *
 * A GitHub merge queue that removes a PR is handled as a red CI check on that
 * PR. No check run exists behind that check, so its id is synthesised from the
 * head commit. Every path that would otherwise ask GitHub about a check id
 * (an Actions job lookup, a check-run annotation read, a re-run) must first
 * ask {@link isMergeQueueCheckId} and skip the call.
 *
 * Real check-run ids are numeric and startup-suite ids are `suite-<n>`, so the
 * prefix can never collide with either.
 *
 * Uses Australian English spelling (behaviour, organisation, etc.).
 */

/** Prefix shared by every merge-queue check id. */
export const MERGE_QUEUE_CHECK_ID_PREFIX = "merge-queue-";

/** How many leading characters of the head sha identify the removal. */
const HEAD_SHA_PREFIX_LENGTH = 12;

/**
 * The synthetic check id for a merge-queue removal at `headSha`.
 *
 * The id names the head it belongs to, so a fresh head gets a fresh id and
 * its own retry budget.
 *
 * @param headSha - The PR head commit sha
 */
export function mergeQueueCheckId(headSha: string): string {
  return `${MERGE_QUEUE_CHECK_ID_PREFIX}${
    headSha.slice(0, HEAD_SHA_PREFIX_LENGTH)
  }`;
}

/**
 * Whether a check id is a synthetic merge-queue id rather than a GitHub
 * check run or startup-suite id.
 *
 * @param id - The check id as carried on a failed check
 */
export function isMergeQueueCheckId(id: string): boolean {
  return id.startsWith(MERGE_QUEUE_CHECK_ID_PREFIX);
}
