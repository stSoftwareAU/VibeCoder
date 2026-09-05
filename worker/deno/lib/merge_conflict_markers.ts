/**
 * The merge-conflict marker vocabulary (Issues #84, #395, #1115).
 *
 * A leaf module on purpose. Attempt history lives in marker comments on the
 * PR itself rather than in host-local state, so several modules read the same
 * three markers back: the scan, the resolution processor, the stall watchdog,
 * the deferral tracker, and the abandon-and-restart rung. Keeping the literals
 * here — rather than in whichever module happened to need them first — is what
 * lets those modules depend on the vocabulary without depending on each other.
 *
 * The `vibe-coder:` shapes below deviate from the canonical `vibe-*` grammar
 * and are **frozen** rather than fixed (Issue #842): every one is read back out
 * of comments already posted, so renaming any of them makes every marker in
 * the wild invisible to its guard.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Marker that identifies one recorded conflict-resolution attempt. */
export const CONFLICT_ATTEMPT_MARKER = "<!-- vibe-coder:merge-conflict-attempt";

/**
 * Marker posted when an attempt merged successfully. Everything before it
 * belongs to a conflict that is already resolved, so the attempt budget
 * restarts from it — a PR that conflicts again months later gets a full
 * budget rather than inheriting a spent one.
 */
export const CONFLICT_RESOLVED_MARKER =
  "<!-- vibe-coder:merge-conflict-resolved -->";

/**
 * Marker posted when an attempt reached a merge conclusion and failed
 * (Issue #395). It is what turns an opened attempt into a *spent* one — an
 * attempt marker with no conclusion after it was disrupted, not judged.
 */
export const CONFLICT_FAILED_MARKER = "<!-- vibe-coder:merge-conflict-failed";
