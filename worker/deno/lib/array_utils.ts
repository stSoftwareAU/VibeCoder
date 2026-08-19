/**
 * Array utility functions for the Vibe Coder worker.
 *
 * Provides array manipulation utilities including Fisher-Yates shuffle
 * and conditional repo ordering.
 *
 * Migrated from worker/shared/array_utils.sh (Issue #901).
 * Issue #271: Randomise repo scan order for fair work distribution.
 * Issue #435: Conditional shuffle based on configuration.
 */

import type { Result } from "../types.ts";

/**
 * Shuffle an array using the Fisher-Yates algorithm.
 *
 * Returns a new array with elements in randomised order.
 * The original array is not modified.
 *
 * @param items - Array elements to shuffle
 * @returns New array with elements in randomised order
 */
export function shuffleArray<T>(items: readonly T[]): T[] {
  if (items.length === 0) {
    return [];
  }

  const result = [...items];
  const n = result.length;

  // Fisher-Yates shuffle
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }

  return result;
}

/** Options for maybeShuffleRepos. */
export interface ShuffleReposOptions {
  /** The repository list to optionally shuffle. */
  repos: readonly string[];
  /** When false, preserves the configured scan order. Defaults to true. */
  shuffle?: boolean;
}

/**
 * Conditionally shuffle or preserve repo scan order (Issue #435).
 *
 * When shuffle is false, returns repos in the given order (configured scan
 * order). Otherwise, returns repos in randomised order via Fisher-Yates.
 *
 * This controls the order in which repos are scanned (API call order), not
 * which issue is selected — selection is always by globally oldest eligible
 * issue across all repos (Issue #281).
 *
 * @param options - Repos and shuffle flag
 * @returns Result containing the ordered repo list
 */
export function maybeShuffleRepos(
  options: ShuffleReposOptions,
): Result<string[]> {
  const { repos, shuffle = true } = options;

  if (repos.length === 0) {
    return { ok: true, value: [] };
  }

  if (!shuffle) {
    return { ok: true, value: [...repos] };
  }

  return { ok: true, value: shuffleArray(repos) };
}
