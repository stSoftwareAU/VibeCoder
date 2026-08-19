/**
 * In-process keyed mutex for read-modify-write state files (Issue #4180,
 * part of #4168).
 *
 * The host-wide guards — failure tracker, cooldown state, circuit breaker —
 * each persist a small JSON file with load → mutate → atomicWrite. Under a
 * single serial loop that was safe; under concurrent slots two mutations
 * can interleave at the `await` between load and write and one slot's
 * increment is lost. `atomicWrite` already prevents TORN writes; this
 * serialises the whole read-modify-write per file so no update is dropped.
 * Cross-process safety is not the goal (one driver per checkout — the PID
 * guard); this is the in-process discipline the pool needs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` exclusively for `key`: callers with the same key are queued in
 * order; different keys run concurrently. A rejection in `fn` propagates
 * to its caller and does not poison the queue.
 */
export function withStateLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Keep the chain alive regardless of outcome, but never let a settled
  // failure leak as an unhandled rejection from the stored tail.
  const tail = run.then(() => undefined, () => undefined);
  chains.set(key, tail);
  // Drop the entry once this tail is the last one, so the map cannot grow
  // without bound across a long-running worker.
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** Test seam: number of keys currently held. */
export function _stateLockKeys(): number {
  return chains.size;
}
