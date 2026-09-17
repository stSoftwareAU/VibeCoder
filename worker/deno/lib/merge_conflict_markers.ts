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

// ---------------------------------------------------------------------------
// The stale-verdict ladder (Issues #2272, #2276)
// ---------------------------------------------------------------------------

/*
 * The three markers below are the rungs the resolver climbs when GitHub's
 * `CONFLICTING` verdict is stale — the loop NEAT-AI-Lamarck#239 sat in. They
 * record which rung already ran at which head sha, which is what bounds each
 * rung to one run per head.
 *
 * Canonical `vibe-*` grammar — a bare `vibe-` prefix and `key="value"`
 * attributes (Issue #842). The frozen `vibe-coder:` shapes above are frozen
 * only because live threads already carry them; these are new, so they are
 * written the canonical way.
 *
 * No rung name contains an attempt-vocabulary literal, and none of the three
 * contains another, so a rung marker is invisible to `parseConflictAttempts`
 * and to its siblings: a rung neither spends nor resets the attempt budget.
 */

/** A 7-to-40 character lowercase git object name, as a marker may carry. */
const HEAD_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Whether a value is a head sha these markers may carry.
 *
 * Exported so the writer and the reader agree on what a usable sha is: two
 * copies of the pattern would let a marker be written that the ladder then
 * discards, which is a rung that runs again at the same head.
 */
export function isConflictHeadSha(value: string): boolean {
  return HEAD_SHA_PATTERN.test(value);
}

/**
 * Marker posted by the nudge rung.
 *
 * `head` is the sha the nudge **produced** — the head GitHub reports next —
 * not the head it started from. The ladder is keyed on the current head, so a
 * marker naming the pre-nudge head would leave the new head unnamed and nudge
 * it again on the following scan, which is the loop this ladder ends.
 */
export const CONFLICT_NUDGE_MARKER = "<!-- vibe-merge-conflict-nudge";

/** Marker posted by the rebase rung, naming the head it replaced and the new one. */
export const CONFLICT_REBASE_MARKER = "<!-- vibe-merge-conflict-rebase";

/** Marker posted when a rung ran at a head sha and failed. */
export const CONFLICT_RUNG_FAILED_MARKER =
  "<!-- vibe-merge-conflict-rung-failed";

/** The rungs whose failure is recorded by {@link CONFLICT_RUNG_FAILED_MARKER}. */
export type ConflictLadderRung = "rebase" | "abandon";

/**
 * The sha as a marker attribute, or a throw.
 *
 * Fails loud rather than writing an attribute the reader will discard: a
 * marker nobody can read back is a rung that runs again at the same head,
 * which is the loop this ladder exists to break.
 */
function headAttribute(name: string, sha: string): string {
  const trimmed = sha.trim().toLowerCase();
  if (!isConflictHeadSha(trimmed)) {
    throw new Error(
      `Refusing to write a merge-conflict rung marker with ${name}="${sha}" ` +
        "— a head sha must be 7–40 hex characters",
    );
  }
  return `${name}="${trimmed}"`;
}

/** The marker line for one nudged head. */
export function conflictNudgeMarker(head: string): string {
  return `${CONFLICT_NUDGE_MARKER} ${headAttribute("head", head)} -->`;
}

/** The marker line for one rebase, naming the head it replaced. */
export function conflictRebaseMarker(
  oldHead: string,
  newHead: string,
): string {
  return `${CONFLICT_REBASE_MARKER} ${headAttribute("old", oldHead)} ` +
    `${headAttribute("new", newHead)} -->`;
}

/** The marker line for one rung that ran at a head sha and failed. */
export function conflictRungFailedMarker(
  rung: ConflictLadderRung,
  head: string,
): string {
  return `${CONFLICT_RUNG_FAILED_MARKER} rung="${rung}" ` +
    `${headAttribute("head", head)} -->`;
}
