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

/** Injected seams for {@link drainConflictingPrs}. */
export interface ConflictDrainOptions {
  /** The next due PR, excluding those this cycle already handled. */
  findNext: (
    exclude: ReadonlySet<string>,
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
  } = options;

  const handled = new Set<string>();
  const decisions: ConflictPrDecision[] = [];
  let merged = 0;
  let deferred = 0;
  let processed = false;
  // The cap is the stop that needs no branch: the loop simply runs out.
  let stop: ConflictDrainStop = { kind: "cap", maxPerCycle };

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
        stop = { kind: "deadline", remainingMs: remaining };
        break;
      }
    }

    const next = await findNext(handled);
    if (next === null) {
      stop = { kind: "queue-empty" };
      break;
    }
    // Excluded before the attempt, not after: a resolution that throws must
    // not put the same PR back at the head of the queue.
    handled.add(conflictPrKey(next.repo, next.prNumber));

    const lease = acquireLease(next);
    if (lease === null) {
      // The deferral is a decision on a labelled PR like any other, so it is
      // recorded rather than left as an unstructured log line (Issue #1109).
      const deferral: ConflictPrDecision = {
        repo: next.repo,
        prNumber: next.prNumber,
        outcome: "skipped",
        reason: { kind: "repo-leased" },
      };
      decisions.push(deferral);
      recordConflictDecision(logger, deferral);
      logger.info(
        "Deferring merge-conflict resolution: an issue slot holds the repository",
        { repo: next.repo, prNumber: next.prNumber },
      );
      deferred++;
      continue;
    }

    const attempt: ConflictPrDecision = {
      repo: next.repo,
      prNumber: next.prNumber,
      outcome: "attempted",
    };
    decisions.push(attempt);

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

  if (handled.size > 1) {
    logger.info(
      `Merge-conflict drain complete: ${handled.size} PR(s) taken, ` +
        `${merged} merged, ${deferred} deferred (${stop.kind})`,
    );
  }

  // One pass-level summary, always — including the stop reason and its
  // operands, so a cycle that took nothing still says why (Issue #1109).
  recordConflictPassSummary(logger, "drain", decisions, {
    ...conflictReasonOperands(stop),
    stopReason: stop.kind,
    taken: handled.size,
    merged,
    deferred,
  });

  return {
    taken: handled.size,
    merged,
    deferred,
    processed,
    stopReason: stop.kind,
    decisions,
  };
}
