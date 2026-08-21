/**
 * Host-local view of the issues live slots currently own (Issue #214).
 *
 * The concurrent issue pool (Issue #4168) tracks its claims in an
 * {@link InFlightRepoRegistry}, but the recovery and cleanup passes —
 * stuck-heartbeat recovery, assigned-without-heartbeat recovery, the
 * closed-PR recovery of Priority 1.68 — predate the pool and decide from
 * GitHub state plus a local heartbeat file alone. When one of those passes
 * unassigns an issue a live slot is still working, the claim lock is gone
 * while the run continues: the issue reads as unassigned to every sibling
 * host, which then double-claims it (live evidence: VibeCoder#185,
 * unassigned at 06:31Z with its heartbeat still beating at 06:40Z).
 *
 * This module is the one place those passes consult. The pool registers a
 * provider at wiring time; every pass asks {@link isHeldByLiveSlot} before
 * mutating an issue's assignee.
 *
 * Host-local only — cross-host coordination is the GitHub claim lock plus
 * the live-heartbeat check in `claim_issue.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { recordFaultEvent } from "./fault_tolerance_counters.ts";

/** One issue a live slot owns. */
export interface LiveSlotHold {
  repo: string;
  issueNumber: number;
}

/** Supplies the `(repo, issue)` pairs live slots currently hold. */
export type LiveSlotHoldsProvider = () => ReadonlyArray<LiveSlotHold>;

let provider: LiveSlotHoldsProvider | undefined;

/**
 * Register the live-slot provider (the pool's `InFlightRepoRegistry`).
 *
 * @returns A restore function that reinstates the previous provider, so
 *   tests can install one without leaking it into the next case.
 */
export function setLiveSlotHolds(
  next: LiveSlotHoldsProvider | undefined,
): () => void {
  const previous = provider;
  provider = next;
  return () => {
    provider = previous;
  };
}

/**
 * The issues live slots hold right now.
 *
 * An unregistered provider yields an empty list: a host with no pool holds
 * nothing, which is the truth rather than a fallback. A provider that throws
 * is a programming error — it is recorded and logged loudly, and the caller
 * sees an empty list so recovery is never wedged by a broken registry.
 */
export function liveSlotHolds(): ReadonlyArray<LiveSlotHold> {
  if (provider === undefined) return [];
  try {
    return provider() ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordFaultEvent(
      "catch_block_warning",
      `live slot holds provider threw: ${message}`,
    );
    console.warn(
      `[live_slot_holds] provider_threw error=${message} — treating the host ` +
        `as holding nothing (Issue #214)`,
    );
    return [];
  }
}

/** Whether a live slot on this host is working `repo#issueNumber`. */
export function isHeldByLiveSlot(repo: string, issueNumber: number): boolean {
  return liveSlotHolds().some(
    (hold) => hold.repo === repo && hold.issueNumber === issueNumber,
  );
}

/**
 * Guard a maintenance mutation: log and report whether a live slot owns the
 * issue, so a recovery pass never removes an in-flight claim's assignee.
 *
 * @param pass - Name of the calling pass, for the log line.
 * @returns True when the issue is held and the caller must leave it alone.
 */
export function skipBecauseLiveSlotHolds(
  pass: string,
  repo: string,
  issueNumber: number,
): boolean {
  if (!isHeldByLiveSlot(repo, issueNumber)) return false;
  console.warn(
    `[live_slot_holds] pass=${pass} repo=${repo} issue=#${issueNumber} ` +
      `skipped=live_slot_hold — a live slot on this host owns this claim; ` +
      `only the owning slot's release may unassign it (Issue #214)`,
  );
  return true;
}
