/**
 * A rendezvous for concurrency tests (Issue #1098).
 *
 * A test that asserts "N of these ran at once" has to hold each participant
 * open long enough for the others to start. Holding it for a fixed number of
 * milliseconds — `await new Promise((r) => setTimeout(r, 10))` — makes that
 * assertion a statement about the host: on an idle laptop ten milliseconds is
 * ample, and under the gate's own `--parallel` suite the first participant
 * finished before the third had started, so `expected 3 concurrent, saw 2`
 * failed a pool that was behaving correctly.
 *
 * A rendezvous states the requirement directly instead: each participant
 * announces its arrival and waits until every expected participant has
 * arrived. Nobody leaves early however loaded the host is, and a slow host
 * only makes the wait longer, never the answer different.
 *
 * {@link waitUntil} is the same idea for a condition rather than a count —
 * "hold this slot until the other has finished" — and the rendezvous is built
 * on it.
 *
 * Both waits are bounded, so a genuine regression — one participant that
 * never arrives — fails the test's own assertion rather than hanging the
 * suite.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** How many 1 ms ticks a wait runs for before giving up. */
export const DEFAULT_MAX_TICKS = 2000;

/**
 * Wait until `ready()` holds, for at most `maxTicks` one-millisecond ticks.
 *
 * Returns whether it held in the end, so a caller can assert on the outcome
 * rather than on how long it took. The bound is the difference between a
 * failed assertion and a hung suite.
 */
export async function waitUntil(
  ready: () => boolean,
  maxTicks: number = DEFAULT_MAX_TICKS,
): Promise<boolean> {
  for (let tick = 0; tick < maxTicks && !ready(); tick++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return ready();
}

/** A meeting point for concurrent participants. */
export interface Rendezvous {
  /**
   * Announce arrival and wait for the rest. Resolves with how many
   * participants had arrived when the wait ended — `expected` when the
   * rendezvous was met, fewer when the bound was reached first.
   */
  arrive(): Promise<number>;
  /** How many participants have arrived so far. */
  readonly arrived: number;
}

/**
 * Create a rendezvous for `expected` participants.
 *
 * @param expected How many participants must arrive before any may leave.
 * @param maxTicks Bound on the wait, in 1 ms ticks. Reached, the waiter
 * returns anyway with a count below `expected`, so the caller's assertion
 * reports the shortfall instead of the suite hanging.
 */
export function createRendezvous(
  expected: number,
  maxTicks: number = DEFAULT_MAX_TICKS,
): Rendezvous {
  let arrived = 0;
  return {
    get arrived() {
      return arrived;
    },
    async arrive(): Promise<number> {
      arrived++;
      await waitUntil(() => arrived >= expected, maxTicks);
      return arrived;
    },
  };
}
