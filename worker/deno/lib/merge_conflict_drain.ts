/**
 * Merge-conflict queue drain (Issue #561).
 *
 * The merge-conflict pass used to resolve exactly one PR per cycle: the scan
 * returned a single PR, the pass merged it and returned, and the maintenance
 * lane runs each pass once per cycle. With two conflicting PRs the second
 * waited a full cycle — most of an hour once issue work is running — and a
 * conflicting PR is a PR no CI will run on, held behind the open-PR gate that
 * also holds new issue claims. One-per-cycle throughput on conflicts throttles
 * issue throughput.
 *
 * This is the loop that empties the queue instead, and the three bounds that
 * keep it from becoming a monopoly:
 *
 * - **The cycle deadline.** Each attempt runs a coding agent. One started
 *   without room to finish is abandoned at the deadline, and an abandoned
 *   attempt counts as a *disrupted* attempt on the PR's record — three of
 *   those escalate it to a human (Issue #395). Leaving the PR for the next
 *   cycle costs an hour; starting it costs a third of its escalation budget.
 * - **A per-cycle cap**, so one repository's backlog cannot take the whole run.
 * - **The exclusion set**, so a PR already taken — or one deferred because an
 *   issue slot holds its repository — is not re-selected by the next scan.
 *   Without it the drain spins on the same PR.
 *
 * Per-PR budgets (4-hour cooldown, two concluded attempts, `needs-human`) are
 * the scan's, unchanged: this loop only decides how many of the PRs already
 * due get taken this cycle.
 *
 * All three bounds drop a due PR, and repeated every cycle they starve one
 * (Issue #1111): the scan re-derives the same order every pass, so the PR
 * behind a busy repository or at position 6 of a backlog loses the same race
 * forever. The drain therefore keeps a persisted deferral cursor
 * (`merge_conflict_deferrals.ts`) — a PR any of the three bounds dropped is
 * offered **first** next pass, and one that keeps losing is told so on itself.
 * A deferral is not an attempt: it spends neither the two-attempt budget nor
 * the three-disruption budget, because nothing was started.
 *
 * Every side effect is injected, so the loop is unit-tested without git,
 * GitHub or an agent.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Logger } from "../types.ts";
import {
  type ConflictingPr,
  type ConflictPrDecision,
  conflictPrKey,
  conflictReasonOperands,
  type ConflictSkipReason,
  recordConflictDecision,
  recordConflictPassSummary,
} from "./pr_merge_conflict_scan.ts";
import {
  clearDeferral,
  type ConflictDeferralBound,
  type ConflictDeferralEntry,
  type ConflictDeferralState,
  deferralCursor,
  type DeferralNoticeBounds,
  markDeferralNotified,
  recordDeferral,
  shouldAnnounceDeferral,
} from "./merge_conflict_deferrals.ts";

/**
 * Conflicting PRs one cycle's pass will take.
 *
 * Past this many the rest wait for the next cycle, which the other lanes
 * share.
 */
export const DEFAULT_MAX_CONFLICTS_PER_CYCLE = 5;

/** Cycle time that must remain before the drain starts another resolution. */
export const DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT = 10 * 60 * 1000;

/** What one resolution attempt did. */
export interface ConflictResolutionOutcome {
  /** The pass did work on this PR (drives the priority's `processed`). */
  processed: boolean;
  /** A merge was pushed. */
  merged: boolean;
}

/** A held repository lease, released when the attempt finishes. */
export interface RepoLease {
  release: () => void;
}

/** One PR's starvation, as the drain hands it to the announcer (Issue #1111). */
export interface ConflictDeferralNotice {
  repo: string;
  prNumber: number;
  entry: ConflictDeferralEntry;
}

/**
 * The persisted fairness cursor, as seams (Issue #1111).
 *
 * Optional: a drain given no tracking behaves exactly as it did before —
 * no cursor, no notice, and no extra lookup at the deadline or the cap.
 */
export interface ConflictDeferralTracking extends DeferralNoticeBounds {
  /** Read the cursor persisted by the previous pass. */
  load: () => Promise<ConflictDeferralState>;
  /** Persist the cursor for the next pass. */
  save: (state: ConflictDeferralState) => Promise<void>;
  /**
   * Post the once-per-streak notice on the PR. Returns true when this call
   * posted it; false means another host already had.
   */
  announce?: (notice: ConflictDeferralNotice) => Promise<boolean>;
}

/** Injected seams for {@link drainConflictingPrs}. */
export interface ConflictDrainOptions {
  /**
   * The next due PR, excluding those this cycle already handled.
   *
   * `prefer` carries the deferral cursor — PRs a previous pass deferred
   * without attempting, most starved first (Issue #1111). It is an ordering
   * hint: the scan's gates still decide what is due.
   */
  findNext: (
    exclude: ReadonlySet<string>,
    prefer?: readonly string[],
  ) => Promise<ConflictingPr | null>;
  /** Lease the shared clone, or null when an issue slot holds it. */
  acquireLease: (pr: ConflictingPr) => RepoLease | null;
  /** Resolve one conflict. Returns null when the attempt failed loudly. */
  resolve: (pr: ConflictingPr) => Promise<ConflictResolutionOutcome | null>;
  logger: Logger;
  /** Watchdog deadline for the pass, when the dispatcher supplied one. */
  deadlineEpochMs?: number;
  /** Clock seam (epoch milliseconds). */
  now?: () => number;
  maxPerCycle?: number;
  minMsPerAttempt?: number;
  /**
   * Fairness cursor and starvation notice (Issue #1111). Omit it and the
   * drain keeps no cursor at all.
   */
  deferrals?: ConflictDeferralTracking;
}

/** Why the drain stopped. */
export type ConflictDrainStopReason =
  /** Nothing else is due — the queue is empty. */
  | "queue-empty"
  /** Too little of the cycle remains for another agent run. */
  | "deadline"
  /** The per-cycle cap was reached. */
  | "cap";

/**
 * The drain's stop, as a member of the closed skip taxonomy (Issue #1109).
 *
 * Derived from {@link ConflictSkipReason} rather than declared beside it, so
 * the reason and its operands cannot drift from the record the pass emits —
 * and {@link ConflictDrainResult.stopReason} is read straight off `kind`,
 * leaving one source of truth for why the drain stopped.
 */
export type ConflictDrainStop = Extract<
  ConflictSkipReason,
  { kind: ConflictDrainStopReason }
>;

/** What the drain did this cycle. */
export interface ConflictDrainResult {
  /** PRs selected — merged, failed and deferred alike. */
  taken: number;
  /** PRs whose merge was pushed. */
  merged: number;
  /** PRs deferred because an issue slot held the repository. */
  deferred: number;
  /** True when any attempt did work (the priority's `processed`). */
  processed: boolean;
  stopReason: ConflictDrainStopReason;
  /** One decision per PR the drain itself decided on (Issue #1109). */
  decisions: readonly ConflictPrDecision[];
  /** Due PRs the deadline or the cap left in the queue (Issue #1111). */
  leftBehind: number;
  /** Longest consecutive-deferral streak this pass touched (Issue #1111). */
  maxDeferralStreak: number;
  /** Starvation notices this pass posted (Issue #1111). */
  deferralNotices: number;
}

/**
 * Take every conflicting PR that is due, within the cycle's bounds.
 *
 * @param options - The injected scan, lease and resolve seams plus bounds.
 * @returns A count of what was taken, merged and deferred, and why it stopped.
 */
export async function drainConflictingPrs(
  options: ConflictDrainOptions,
): Promise<ConflictDrainResult> {
  const {
    findNext,
    acquireLease,
    resolve,
    logger,
    deadlineEpochMs,
    now = () => Date.now(),
    maxPerCycle = DEFAULT_MAX_CONFLICTS_PER_CYCLE,
    minMsPerAttempt = DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT,
    deferrals,
  } = options;

  const handled = new Set<string>();
  const decisions: ConflictPrDecision[] = [];
  let merged = 0;
  let deferred = 0;
  let leftBehind = 0;
  let processed = false;
  let maxDeferralStreak = 0;
  let deferralNotices = 0;

  // Issue #1111: the cursor the previous pass left. Read once, so the order
  // offered to `findNext` is stable for the whole pass.
  const state: ConflictDeferralState = deferrals
    ? await deferrals.load()
    : new Map();
  const prefer = deferralCursor(state);

  /**
   * Count one deferral against a PR, and tell the PR once its streak says it
   * is being starved rather than merely queued.
   *
   * @returns The streak, or undefined when no cursor is kept.
   */
  const noteDeferral = async (
    pr: ConflictingPr,
    bound: ConflictDeferralBound,
  ): Promise<number | undefined> => {
    if (!deferrals) return undefined;
    const key = conflictPrKey(pr.repo, pr.prNumber);
    const entry = recordDeferral(state, key, bound, now());
    maxDeferralStreak = Math.max(maxDeferralStreak, entry.streak);

    if (!deferrals.announce || !shouldAnnounceDeferral(entry, deferrals)) {
      return entry.streak;
    }
    try {
      const posted = await deferrals.announce({
        repo: pr.repo,
        prNumber: pr.prNumber,
        entry,
      });
      // Marked whoever posted it: the marker on the PR is the cross-host
      // guard, and this only saves the next pass a comment read.
      markDeferralNotified(state, key);
      if (posted) deferralNotices++;
    } catch (error) {
      // Left unmarked on purpose, so the next pass tries again — but never
      // silently: a PR that is starved and cannot be told so is exactly the
      // #1076 symptom.
      logger.warn(
        "Merge-conflict drain: could not post the deferral notice",
        {
          repo: pr.repo,
          prNumber: pr.prNumber,
          deferralStreak: entry.streak,
          bound,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return entry.streak;
  };

  /**
   * The loop, as a function that must return a stop.
   *
   * The declared return type is the drain's half of the closed taxonomy: an
   * exit added here without a stop does not compile, the same way a per-PR
   * exit in the scan cannot be added without a reason (Issue #1109).
   */
  const runDrain = async (): Promise<ConflictDrainStop> => {
    for (let taken = 0; taken < maxPerCycle; taken++) {
      if (deadlineEpochMs !== undefined) {
        const remaining = deadlineEpochMs - now();
        if (remaining < minMsPerAttempt) {
          // Said out loud only once the drain has done something: a pass that
          // starts late and takes nothing is the ordinary quiet case.
          if (taken > 0) {
            logger.info(
              "Merge-conflict drain stopping: too little of the cycle left " +
                "for another resolution",
              { taken, merged, remainingMs: remaining },
            );
          }
          return { kind: "deadline", remainingMs: remaining };
        }
      }

      const next = await findNext(handled, prefer);
      if (next === null) return { kind: "queue-empty" };
      // Excluded before the attempt, not after: a resolution that throws must
      // not put the same PR back at the head of the queue.
      handled.add(conflictPrKey(next.repo, next.prNumber));

      const lease = acquireLease(next);
      if (lease === null) {
        // The deferral is a decision on a labelled PR like any other, so it
        // is recorded rather than left to an unstructured line (Issue #1109),
        // and it is counted against the PR so a repeat cannot stay quiet
        // (Issue #1111).
        const streak = await noteDeferral(next, "repo-leased");
        const deferral: ConflictPrDecision = {
          repo: next.repo,
          prNumber: next.prNumber,
          outcome: "skipped",
          reason: {
            kind: "repo-leased",
            ...(streak !== undefined ? { deferralStreak: streak } : {}),
          },
        };
        decisions.push(deferral);
        recordConflictDecision(logger, deferral);
        deferred++;
        continue;
      }

      decisions.push({
        repo: next.repo,
        prNumber: next.prNumber,
        outcome: "attempted",
      });
      // Something was started, so the PR is not starved — whatever the
      // attempt then concludes (Issue #1111).
      clearDeferral(state, conflictPrKey(next.repo, next.prNumber));

      try {
        const outcome = await resolve(next);
        if (outcome) {
          processed = processed || outcome.processed;
          if (outcome.merged) merged++;
        }
      } finally {
        lease.release();
      }
    }
    // The loop ran out rather than breaking: the per-cycle cap.
    return { kind: "cap", maxPerCycle };
  };

  const stop = await runDrain();

  /**
   * Name the PR a pass-level bound left in the queue (Issue #1111).
   *
   * The deadline and the cap end the loop without ever asking who was next,
   * which is why the cheap exits were the invisible ones. One more `findNext`
   * — a listing, not an agent run — is what turns "the pass stopped" into
   * "this PR was left behind, for the third pass running". Only done when a
   * cursor is kept, so a drain with no tracking costs exactly what it did.
   */
  const noteLeftBehind = async (bound: "deadline" | "cap"): Promise<void> => {
    if (!deferrals) return;
    const left = await findNext(handled, prefer);
    if (left === null) return;
    const streak = await noteDeferral(left, bound);
    const decision: ConflictPrDecision = {
      repo: left.repo,
      prNumber: left.prNumber,
      outcome: "skipped",
      reason: { kind: "deferred-bound", bound, deferralStreak: streak ?? 1 },
    };
    decisions.push(decision);
    recordConflictDecision(logger, decision);
    leftBehind++;
  };

  if (stop.kind === "deadline" || stop.kind === "cap") {
    await noteLeftBehind(stop.kind);
  }

  if (deferrals) {
    try {
      await deferrals.save(state);
    } catch (error) {
      // Best-effort like the lane rotation's counter: an unwritable cursor
      // costs fairness on the next pass, never this pass's work — but it is
      // said out loud so a silently unfair host is diagnosable.
      logger.warn(
        "Merge-conflict drain: could not persist the deferral cursor",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  if (handled.size > 1) {
    logger.info(
      `Merge-conflict drain complete: ${handled.size} PR(s) taken, ` +
        `${merged} merged, ${deferred} deferred (${stop.kind})`,
    );
  }

  // One pass-level summary per completed pass — the stop reason and its
  // operands, so a cycle that took nothing still says why (Issue #1109). A
  // resolution that throws propagates past here, loudly, as it did before.
  recordConflictPassSummary(logger, "drain", decisions, {
    ...conflictReasonOperands(stop),
    stopReason: stop.kind,
    taken: handled.size,
    merged,
    deferred,
    // Issue #1111: "deferred once, fine" and "deferred nine times" are the
    // same line without these.
    leftBehind,
    maxDeferralStreak,
    deferralNotices,
  });

  return {
    taken: handled.size,
    merged,
    deferred,
    processed,
    stopReason: stop.kind,
    decisions,
    leftBehind,
    maxDeferralStreak,
    deferralNotices,
  };
}
