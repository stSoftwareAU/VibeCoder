/**
 * The fleet-board note for a host that has stopped claiming work (Issue #477).
 *
 * # Why this exists
 *
 * The fleet-health payload already names *conditions* — `host-disk low: …`
 * (Issue #226), `work-volume fault: …` (Issue #229). It never named the
 * *consequence*, and on a board of hosts the consequence is the only part an
 * operator can triage: "short of disk" reads as a housekeeping note, while
 * "not claiming work" reads as an outage.
 *
 * On GRQ-23 that gap cost three days. The host declined all 43 claimable
 * issues across its monitored repos for as long as it sat below its disk
 * floor, and nothing outside the machine's own logs said so. The operator
 * happened to be sitting at that laptop; on an unattended host the same fault
 * is invisible, which is the failure this module exists to end.
 *
 * # The contract
 *
 * A host that will not pick up new work must never be readable as healthy.
 * The note therefore leads with {@link CLAIM_SUPPRESSED_PREFIX} and names
 * every gate responsible — fixing only the gate that happened to be reported
 * leaves the host just as stuck.
 *
 * A host that is claiming normally produces no note at all, so a healthy
 * report stays byte-identical to the historical invocation.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

/**
 * The consequence, stated first and in the words an operator triages by.
 *
 * Deliberately not a severity word like "degraded": a host declining every
 * issue is not running slowly, it is not running at all, and the board must
 * not let that read as a performance note.
 */
export const CLAIM_SUPPRESSED_PREFIX = "NOT CLAIMING WORK";

/** A gate that stops this host claiming new work. */
export interface ClaimGate {
  /**
   * Short stable token naming the gate — `host-disk-low`,
   * `work-volume-fault`. Greppable across hosts, so a fleet-wide pattern is
   * visible without reading every detail string.
   */
  id: string;
  /** Operator-facing detail; may be empty when the gate has none to add. */
  detail: string;
}

/**
 * The fleet-board note for the given gates, or `null` when the host is
 * claiming normally.
 *
 * Gates with a blank id are dropped rather than reported as anonymous gates:
 * a false alarm on the board is paid for by every operator who investigates
 * it, and an alarm that cannot name what is wrong cannot be actioned.
 *
 * @param gates - Gates currently suppressing claims on this host.
 */
export function claimSuppressedNote(
  gates: readonly ClaimGate[],
): string | null {
  const named = gates.filter((gate) => gate.id.trim() !== "");
  if (named.length === 0) return null;

  const described = named.map((gate) => {
    const id = gate.id.trim();
    const detail = gate.detail.trim();
    return detail === "" ? id : `${id}: ${detail}`;
  });

  return `${CLAIM_SUPPRESSED_PREFIX} — ${described.join("; ")}`;
}
