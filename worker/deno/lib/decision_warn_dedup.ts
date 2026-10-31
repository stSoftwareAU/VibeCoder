/**
 * Once-per-decision warning suppression (Issue #4495).
 *
 * A "Not closing" decision for an issue/PR pair was logged at WARNING on every
 * cycle, even when nothing about it had changed — about 380 identical lines a
 * day. A repeated identical decision is not actionable, so it is warned once
 * when it first applies or when its inputs change, and logged at DEBUG after
 * that. The state is process-lifetime only, so a restart reports it again.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** The last signature recorded for each decision key. */
const lastSignatures = new Map<string, string>();

/**
 * Whether a decision should be logged at WARNING.
 *
 * Returns true when no signature is recorded for `key`, or when the recorded
 * signature differs from `signature` — and records `signature` in either case.
 * Returns false when the recorded signature is identical.
 *
 * @param key - Identifies the decision, e.g. one issue/PR pair.
 * @param signature - The inputs that make the decision what it is.
 * @returns true when the decision is new or changed since it was last recorded.
 */
export function shouldWarnDecision(key: string, signature: string): boolean {
  if (lastSignatures.get(key) === signature) return false;
  lastSignatures.set(key, signature);
  return true;
}

/**
 * Clear all recorded decision signatures. Exported for tests.
 */
export function resetDecisionWarnings(): void {
  lastSignatures.clear();
}
