/**
 * How one milestone-branch sync sweep spends and orders its cycle
 * (Issue #2215).
 *
 * The sweep is a single handler under a single watchdog, and until this
 * module it handed each milestone whatever budget was left. On GRQ-23 one
 * conflict resolution took the handler's entire 795 s, the watchdog abandoned
 * the handler, and every milestone after it in the fleet-wide repository order
 * went unsynced — including a both-added ledger file the sweep's own triage
 * settles by union in seconds. Next cycle the same repository came first and
 * ate the budget again.
 *
 * Two rules answer that, and both are pure functions so the sweep's loop can
 * be read without them:
 *
 * - **A share, not the remainder.** {@link milestoneAttemptShareMs} divides
 *   what is left of the handler budget by the work still to do, so no single
 *   attempt can take the cycle. An attempt that outruns its share is
 *   abandoned and concluded `disrupted` — charged nothing, exactly as a
 *   killed attempt already is.
 * - **Stalest first.** {@link orderReposByStaleness} and
 *   {@link orderMilestonesByStaleness} put whatever the previous cycle never
 *   reached at the front of this one, so a starved milestone is starved once
 *   rather than for ever.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { SyncStreakEntry, SyncStreaks } from "./milestone_sync_streak.ts";

/**
 * Budget the sweep keeps back for its own close-out — persisting the ledger
 * and the summary line — so the last attempt it starts does not leave the
 * handler with nothing to finish in.
 */
export const MILESTONE_SWEEP_RESERVE_MS = 15_000;

/**
 * The smallest share worth starting an attempt on.
 *
 * A milestone sync fetches, merges, runs the merge gate and pushes. Below a
 * minute that is a sliver nothing completes in, so the share is raised to
 * this floor and the milestones the budget genuinely cannot cover are refused
 * by name — and, being unvisited, sort first on the next cycle.
 */
export const MIN_MILESTONE_ATTEMPT_MS = 60_000;

/** What one milestone attempt may spend. */
export interface MilestoneAttemptShare {
  /** Whether the attempt may start at all. */
  attempt: boolean;
  /**
   * Milliseconds the attempt may take before it is abandoned. Undefined
   * means the pass stated no deadline and the attempt is unbounded.
   */
  budgetMs?: number;
  /** Why the attempt was refused; set only when `attempt` is false. */
  reason?: string;
}

/**
 * The share of the handler budget one milestone attempt may spend.
 *
 * @param opts.deadlineEpochMs - The handler's watchdog deadline, when it has one
 * @param opts.nowMs - Current time in epoch milliseconds
 * @param opts.unitsLeft - Attempts still to make in this pass, including this one
 * @param opts.reserveMs - Budget kept back for the sweep's close-out
 * @param opts.minMs - Floor below which no attempt is started
 */
export function milestoneAttemptShareMs(opts: {
  deadlineEpochMs?: number;
  nowMs: number;
  unitsLeft: number;
  reserveMs?: number;
  minMs?: number;
}): MilestoneAttemptShare {
  if (opts.deadlineEpochMs === undefined) return { attempt: true };
  const reserve = opts.reserveMs ?? MILESTONE_SWEEP_RESERVE_MS;
  const floor = opts.minMs ?? MIN_MILESTONE_ATTEMPT_MS;
  const left = opts.deadlineEpochMs - opts.nowMs - reserve;
  if (left < floor) {
    return {
      attempt: false,
      reason: `${Math.max(0, Math.round(left / 1000))}s of the handler ` +
        `budget is left and an attempt needs at least ` +
        `${Math.round(floor / 1000)}s`,
    };
  }
  const units = Math.max(1, Math.floor(opts.unitsLeft));
  // Never below the floor — a sliver starts nothing — and never more than
  // what is actually left, which is what the floor could otherwise promise.
  return {
    attempt: true,
    budgetMs: Math.min(left, Math.max(floor, Math.floor(left / units))),
  };
}

/**
 * When the sweep last got as far as attempting this branch, in epoch
 * milliseconds; 0 when it never has, or the record cannot be read.
 *
 * Unreadable reads as "never", which puts the branch first: the conservative
 * direction here is to visit a branch again, not to park it.
 */
export function lastVisitedMs(entry: SyncStreakEntry | undefined): number {
  const at = entry?.lastVisitedAt;
  if (!at) return 0;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Stable ascending sort on a numeric key — the least recently visited first. */
function stalestFirst<T>(items: readonly T[], keyOf: (item: T) => number): T[] {
  return [...items].sort((a, b) => keyOf(a) - keyOf(b));
}

/**
 * The repositories of one sweep, least recently visited first (Issue #2215).
 *
 * A repository's visit time is the most recent visit of any of its milestone
 * branches: one whose milestones were all reached last cycle sorts behind one
 * the budget never got to.
 */
export function orderReposByStaleness(
  repos: readonly string[],
  streaks: SyncStreaks,
): string[] {
  const visited = new Map<string, number>();
  for (const [key, entry] of Object.entries(streaks)) {
    const repo = key.split("|")[0];
    if (!repo) continue;
    visited.set(repo, Math.max(visited.get(repo) ?? 0, lastVisitedMs(entry)));
  }
  return stalestFirst(repos, (repo) => visited.get(repo) ?? 0);
}

/**
 * One repository's milestones, least recently visited first (Issue #2215).
 *
 * Generic over the milestone shape so the sweep's own `ActiveMilestone` and a
 * test's stub both order through this one function.
 */
export function orderMilestonesByStaleness<
  T extends { milestoneBranch: string },
>(
  repo: string,
  milestones: readonly T[],
  streaks: SyncStreaks,
): T[] {
  return stalestFirst(
    milestones,
    (milestone) =>
      lastVisitedMs(streaks[`${repo}|${milestone.milestoneBranch}`]),
  );
}
