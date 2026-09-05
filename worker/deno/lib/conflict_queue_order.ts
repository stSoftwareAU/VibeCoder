/**
 * Ordering the merge-conflict queue around a fairness cursor (Issue #1111).
 *
 * The scan re-derives the same order every pass, so a PR the drain's lease,
 * deadline or cap bound left behind is offered in exactly the same losing
 * position next time. These two pure helpers are how a cursor changes that
 * without changing which PRs are eligible: they reorder, and nothing else —
 * every gate in the scan still runs on whatever comes out.
 *
 * Kept in their own module so `pr_merge_conflict_scan.ts` and
 * `merge_conflict_deferrals.ts` can both use them without importing each
 * other.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/**
 * Order `items` so the preferred keys lead, in the order they are preferred.
 *
 * Stable for everything else, so the cursor changes who goes first without
 * otherwise reshuffling the queue. A preferred key that matches no item is
 * ignored, and a duplicate key keeps its first position.
 */
export function orderByPreference<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  prefer: readonly string[] | undefined,
): T[] {
  if (!prefer || prefer.length === 0) return [...items];
  const rank = new Map<string, number>();
  prefer.forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index);
  });
  return [...items]
    .map((item, index) => ({ item, index, rank: rank.get(keyOf(item)) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) {
        if (a.rank === undefined) return 1;
        if (b.rank === undefined) return -1;
        return a.rank - b.rank;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * The repositories named by `owner/repo#number` keys, in cursor order.
 *
 * A PR cannot lead the pass if its repository is scanned last, so the cursor
 * has to move the repository too.
 */
export function preferredRepos(
  prefer: readonly string[] | undefined,
): readonly string[] {
  if (!prefer) return [];
  const repos: string[] = [];
  for (const key of prefer) {
    const hash = key.lastIndexOf("#");
    if (hash <= 0) continue;
    const repo = key.slice(0, hash);
    if (!repos.includes(repo)) repos.push(repo);
  }
  return repos;
}
