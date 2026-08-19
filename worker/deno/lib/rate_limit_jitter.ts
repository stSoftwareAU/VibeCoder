/**
 * Rate-limit backoff jitter utility (Issue #1073).
 *
 * Adds random jitter to backoff intervals to prevent thundering herd
 * when multiple workers retry simultaneously after a rate limit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Apply random jitter to a base wait interval.
 *
 * Returns an integer number of seconds in the range
 * [base * (1 - factor), base * (1 + factor)].
 *
 * The default factor of 0.3 gives ±30% jitter, so a 300s base
 * produces values in [210, 390].
 *
 * @param baseSeconds - The base wait interval in seconds
 * @param factor - Jitter factor (default 0.3 = ±30%)
 * @returns Jittered wait interval in whole seconds
 */
export function applyJitter(baseSeconds: number, factor: number = 0.3): number {
  if (baseSeconds === 0) return 0;

  const min = baseSeconds * (1 - factor);
  const max = baseSeconds * (1 + factor);
  const jittered = min + Math.random() * (max - min);

  return Math.floor(jittered);
}
