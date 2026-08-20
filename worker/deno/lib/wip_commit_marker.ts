/**
 * WIP-marker commit recognition (Issue #148, follow-up to #47).
 *
 * Two paths put a *placeholder* commit on a claim-locked issue branch:
 * the periodic checkpoints (#4170) and the one-shot preservation of a
 * timed-out execute (#47). Both exist so a killed run's work survives —
 * neither means the issue is finished.
 *
 * Without a way to tell those commits apart from real work, a later claim
 * that adds nothing sails through the completion phase's "commits ahead"
 * guard (the branch *is* ahead — by the WIP commit alone) and raises a
 * half-done PR from someone else's abandoned tree. This module is the
 * single place that recognises a worker-authored WIP subject, so the
 * builders in `wip_checkpoint.ts` and the completion guard cannot drift
 * apart.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Subject prefixes the worker writes for a placeholder commit:
 * `WIP checkpoint: …` (#4170) and `wip: …` (#47). The word boundary is
 * required — `wipe out the cache` is real work, not a checkpoint.
 */
const WIP_SUBJECT_PATTERN = /^wip\s*(?::|\bcheckpoint\b)/i;

/**
 * True when `subject` is a worker-authored WIP placeholder commit subject.
 *
 * Matches only the leading marker, so the descriptive tail of either
 * message may change freely without breaking recognition.
 */
export function isWipCommitSubject(subject: string): boolean {
  return WIP_SUBJECT_PATTERN.test(subject.trim());
}

/**
 * True when every commit in `subjects` is a WIP placeholder.
 *
 * An empty list returns `false`: "no commits" is the zero-commits-ahead
 * case the completion phase already guards, and reporting it as WIP-only
 * would replace that guard's clearer diagnosis.
 */
export function isWipOnlyCommitLog(subjects: readonly string[]): boolean {
  const meaningful = subjects.filter((s) => s.trim().length > 0);
  if (meaningful.length === 0) return false;
  return meaningful.every(isWipCommitSubject);
}
