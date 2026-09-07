/**
 * Change-driven gate over the milestone pass's closed-issue query
 * (Issue #1488).
 *
 * The milestone pass spends against two separate budgets per repo per
 * cycle: a cheap REST `repos/<repo>/milestones` listing, and an expensive
 * `gh issue list --state closed` (GraphQL) that answers only "has anything
 * been completed in this milestone yet?". The REST listing already carries
 * `closed_issues` per milestone, so the cheap call the pass already makes
 * contains the signal that decides whether the expensive one is worth
 * making.
 *
 * This is invalidation by change, not a TTL: the gate is derived from the
 * same authority the answer is, so a skipped cycle cannot act on a stale
 * view. Any movement in the count — up **or** down, since an issue can be
 * reopened or moved out of a milestone — re-runs the query.
 *
 * State lives beside the other milestone sync state in the work dir, keyed
 * by milestone **number** rather than title (a rename keeps the number).
 * Same shape as `milestone_sync_streak.ts`: a small JSON file and an atomic
 * write. A missing file is the ordinary first-run case; a corrupt one falls
 * back to empty but says so loudly first (#3649).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { atomicWrite } from "./file_utils.ts";
import { reportStateLoadFailure } from "./state_load_failure.ts";

/** What was last observed for one milestone. */
export interface MilestoneActivityObservation {
  /** The REST `closed_issues` count the verdict below was computed at. */
  closedIssues: number;
  /**
   * Whether the milestone had at least one closed **issue** at that count.
   * Not the same as `closedIssues > 0`: the REST count includes closed
   * pull requests, which the pass's own definition of "active" excludes.
   */
  active: boolean;
}

/** Observations keyed by "owner/repo|milestone-number". */
export type MilestoneActivityObservations = Record<
  string,
  MilestoneActivityObservation
>;

/** Mutable observation state for one pass, with a save-needed flag. */
export interface MilestoneActivityState {
  observations: MilestoneActivityObservations;
  /** True once an observation changed and the file needs rewriting. */
  dirty: boolean;
}

/** The gate's verdict for one milestone. */
export interface MilestoneQueryDecision {
  /** True when the expensive closed-issue query must be made. */
  query: boolean;
  /** The cached activity verdict — meaningful only when `query` is false. */
  active: boolean;
}

/** Resolve the observation file path for a work directory. */
export function milestoneActivityPath(workDir: string): string {
  return `${workDir}/milestone_activity.json`;
}

/** Key one milestone's observation. Number, not title (#1465). */
export function milestoneActivityKey(
  repo: string,
  milestoneNumber: number,
): string {
  return `${repo}|${milestoneNumber}`;
}

/**
 * Decide whether the closed-issue query is worth making.
 *
 * @param previous - The last observation for this milestone, if any
 * @param closedIssues - The REST `closed_issues` count, or undefined when
 *   the payload did not carry one (the gate then fails open)
 */
export function decideMilestoneQuery(
  previous: MilestoneActivityObservation | undefined,
  closedIssues: number | undefined,
): MilestoneQueryDecision {
  // No count to gate on — spend the query rather than guess.
  if (typeof closedIssues !== "number" || !Number.isFinite(closedIssues)) {
    return { query: true, active: false };
  }
  // Nothing has ever been closed in this milestone, so it cannot hold a
  // closed issue. Not active by the pass's own definition.
  if (closedIssues <= 0) {
    return { query: false, active: false };
  }
  // Unchanged since the last observation — the set of closed issues cannot
  // have moved, so the previous verdict stands.
  if (previous && previous.closedIssues === closedIssues) {
    return { query: false, active: previous.active };
  }
  return { query: true, active: false };
}

/**
 * Record the verdict a query just produced, so the next cycle can reuse it.
 *
 * A payload with no `closed_issues` count records nothing — there would be
 * no signal to invalidate the entry against.
 */
export function recordMilestoneActivity(
  state: MilestoneActivityState | undefined,
  repo: string,
  milestoneNumber: number,
  closedIssues: number | undefined,
  active: boolean,
): void {
  if (!state) return;
  if (typeof closedIssues !== "number" || !Number.isFinite(closedIssues)) {
    return;
  }
  const key = milestoneActivityKey(repo, milestoneNumber);
  const previous = state.observations[key];
  if (previous?.closedIssues === closedIssues && previous.active === active) {
    return; // Unchanged — no rewrite needed.
  }
  state.observations[key] = { closedIssues, active };
  state.dirty = true;
}

/**
 * Load observations. A missing file is the ordinary first-run case and
 * reads as empty quietly; anything else is reported loudly before the
 * fallback, because a discarded file costs a full round of queries and
 * must not look like a clean start (#3649).
 */
export async function loadMilestoneActivity(
  path: string,
  warn?: (message: string) => void,
): Promise<MilestoneActivityObservations> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object of observations");
    }
    const observations: MilestoneActivityObservations = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as MilestoneActivityObservation | null;
      // A malformed entry is dropped, not repaired: an observation that
      // cannot be trusted must re-query rather than gate on a guess.
      if (
        entry && typeof entry === "object" &&
        typeof entry.closedIssues === "number" &&
        Number.isInteger(entry.closedIssues) && entry.closedIssues >= 0 &&
        typeof entry.active === "boolean"
      ) {
        observations[key] = {
          closedIssues: entry.closedIssues,
          active: entry.active,
        };
      }
    }
    return observations;
  } catch (err) {
    reportStateLoadFailure(
      "milestone activity state",
      path,
      err,
      ...(warn ? [warn] : []),
    );
  }
  return {};
}

/** Persist observations atomically. */
export async function saveMilestoneActivity(
  path: string,
  observations: MilestoneActivityObservations,
): Promise<void> {
  await atomicWrite({
    targetFile: path,
    content: JSON.stringify(observations, null, 2) + "\n",
  });
}
