/**
 * Exactly-once guard for a claim's post-run callbacks (Issue #806).
 *
 * A terminal issue run reaches the callback layer from more than one place: a
 * slot's own release, the slot-level catch when something after that release
 * throws, and the shutdown drain that abandons a slot still running. Each is
 * correct on its own, and together they can report the same claim twice.
 *
 * The guard is the single chokepoint that decides. One instance per scan cycle
 * is shared by every dispatch site; the first site to reach a claim wins and
 * every later one is refused. A refusal is not silent — the caller logs it —
 * so a wiring fault reads as "already reported", never as "never ran".
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

/** Tracks which claims have already had their callbacks dispatched. */
export class IssueCallbackGuard {
  readonly #fired = new Set<string>();

  /**
   * Claim the right to dispatch this run's callbacks.
   *
   * @returns `true` the first time for a given issue, `false` afterwards.
   */
  tryClaim(repo: string, issueNumber: number): boolean {
    const key = `${repo}#${issueNumber}`;
    if (this.#fired.has(key)) return false;
    this.#fired.add(key);
    return true;
  }

  /** How many claims have reported so far — for assertions and diagnostics. */
  get size(): number {
    return this.#fired.size;
  }
}
