/**
 * WIP marker vocabulary (Issue #148, follow-up to #47).
 *
 * Three parts of the worker have to agree on what "this is preserved WIP,
 * not finished work" looks like, and they must not each carry their own
 * copy of the string:
 *
 *  - `wip_checkpoint.ts` writes the commit subjects — the periodic #4170
 *    checkpoint and the one-shot #47 timeout preservation;
 *  - the completion phase refuses to raise a PR whose every commit is one
 *    of those markers and whose run added nothing of its own — a `wip:`
 *    commit is by definition half-done work, so a PR built from it alone
 *    would look finished while being anything but;
 *  - the claim-release path reads the failure reason to decide whether the
 *    durable resume state survives the release: work preserved on the
 *    branch is only resumable if the pointer to it is not deleted in the
 *    same breath.
 *
 * Pure string vocabulary — no I/O, no git, importable from anywhere.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Subject prefix of the one-shot commit a timed-out execute preserves. */
export const WIP_TIMEOUT_COMMIT_PREFIX = "wip:";

/** Subject prefix of the periodic execute-phase checkpoint commit. */
export const WIP_CHECKPOINT_COMMIT_PREFIX = "WIP checkpoint:";

/**
 * Marker phrase naming preserved WIP in a failure reason (and therefore in
 * the claim-release comment built from it).
 */
export const WIP_PRESERVED_RELEASE_MARKER = "WIP preserved:";

/**
 * True when a commit subject is one the worker itself wrote to park
 * unfinished work, rather than a commit the agent made deliberately.
 *
 * Matched case-insensitively on the leading prefix only: the rest of the
 * subject carries the file count, the elapsed seconds and the issue
 * reference, all of which vary per run.
 */
export function isWipCommitSubject(subject: string): boolean {
  const trimmed = subject.trim().toLowerCase();
  return trimmed.startsWith(WIP_TIMEOUT_COMMIT_PREFIX.toLowerCase()) ||
    trimmed.startsWith(WIP_CHECKPOINT_COMMIT_PREFIX.toLowerCase());
}

/**
 * True when `subjects` (a branch's commits ahead of its base, newest first)
 * is non-empty and consists ENTIRELY of WIP markers.
 *
 * An empty range returns `false`: "nothing ahead of base" is the
 * pre-existing ahead-of-base guard's business, not this one's.
 */
export function isWipOnlyRange(subjects: readonly string[]): boolean {
  const real = subjects.map((s) => s.trim()).filter((s) => s.length > 0);
  return real.length > 0 && real.every(isWipCommitSubject);
}

/**
 * True when a failure reason reports that the run's work was preserved as a
 * WIP commit on the issue branch (Issue #47's preservation path).
 */
export function describesPreservedWip(message: string | undefined): boolean {
  return message !== undefined &&
    message.includes(WIP_PRESERVED_RELEASE_MARKER);
}
