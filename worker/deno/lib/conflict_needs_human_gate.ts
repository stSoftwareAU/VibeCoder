/**
 * Whether a `needs-human` PR may still have its merge conflict resolved
 * (Issue #2728).
 *
 * A fleet PR whose CI fix ran out of attempts carries `needs-human` from the
 * CI-fix lane. When that PR also conflicts, skipping it leaves the human with
 * a conflict on top of the red check — resolving the conflict is mechanical
 * work the conflict lane owns, and it does not touch the CI escalation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { parseCiFixAttemptMarkers } from "./ci_fix_attempt_markers.ts";
import { buildDedupMarker } from "./needs_human_escalation.ts";

/**
 * Prefix every conflict-lane escalation's dedup marker opens with — the scan
 * and the processor both key their escalations `merge-conflict-…`.
 */
const CONFLICT_ESCALATION_PREFIX = buildDedupMarker("merge-conflict-")
  .replace(/ -->$/, "");

/** The string body of a raw REST comment, or `undefined`. */
function commentBody(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = (raw as { body?: unknown }).body;
  return typeof body === "string" ? body : undefined;
}

/**
 * Decide whether `needs-human` on a conflicting PR came from a CI-fix
 * escalation the conflict lane may work under.
 *
 * @param trustedComments - The PR thread, already reduced to fleet-authored
 *   comments — a marker anyone can post must not lift the skip.
 * @returns `true` only when a comment carries a well-formed
 *   `vibe-ci-fix-attempt` marker and none carries a conflict-lane escalation
 *   marker; the conflict lane never resolves under its own escalation.
 */
export function isCiFixEscalationOnly(
  trustedComments: readonly unknown[],
): boolean {
  let ciFixAttempted = false;
  for (const raw of trustedComments) {
    const body = commentBody(raw);
    if (body === undefined) continue;
    if (body.includes(CONFLICT_ESCALATION_PREFIX)) return false;
    if (parseCiFixAttemptMarkers(body).length > 0) ciFixAttempted = true;
  }
  return ciFixAttempted;
}
