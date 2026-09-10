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
 *   The bound has two halves (Issue #1693): the drain refuses to start at all
 *   below {@link DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT}, and what it does start
 *   is granted an agent timeout that fits inside the budget that is left —
 *   never the configured one when the cycle cannot cover it. See
 *   `docs/workflows/merge-conflicts.md` for the incident behind it.
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
  type ConflictDeferralNotice,
  type ConflictDeferralState,
  deferralCursor,
  type DeferralNoticeBounds,
  markDeferralNotified,
  recordDeferral,
  shouldAnnounceDeferral,
} from "./merge_conflict_deferrals.ts";
import { logPrLiveSkip, type PrLiveStateReading } from "./pr_live_state.ts";

/**
 * Conflicting PRs one cycle's pass will take.
 *
 * Past this many the rest wait for the next cycle, which the other lanes
 * share.
 */
export const DEFAULT_MAX_CONFLICTS_PER_CYCLE = 5;

/**
 * Agent time that must remain before the drain starts another resolution —
 * the cycle time left less {@link DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS}.
 *
 * Sized for an AI-fallback resolution rather than for a token gesture
 * (Issue #1693): the agent killed mid-edit on NEAT-AI-core#637 had already
 * spent 11m13s and 83 tool calls on six conflicted files. Ten minutes was
 * enough to *start* that resolution and never enough to finish it.
 */
export const DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT = 20 * 60 * 1000;

/**
 * Budget one resolution spends outside the agent (Issue #1693): the clone,
 * the base fetch, the merge and the attempt marker before it, and the
 * unmerged/marker guards, the commit, the push, the conclusion comment and
 * the label clear after it.
 *
 * The agent's own timeout is granted out of what is left once this is
 * reserved, so an agent that runs to its full grant still has room to
 * conclude its attempt rather than being killed on the way to the conclusion.
 * It is an allowance, not a measurement — the drain cannot know what a
 * particular clone will cost — so it is deliberately generous.
 */
export const DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS = 4 * 60 * 1000;

/**
 * What one attempt may grant its coding agent, decided by the drain from the
 * handler budget that is actually left (Issue #1693).
 */
export interface ConflictAttemptBudget {
  /**
   * Seconds the resolution may give its agent. Never more than the handler
   * budget left minus {@link DEFAULT_CONFLICT_POST_AGENT_TAIL_MS}, so the
   * watchdog cannot end an agent run this pass chose to start.
   */
  agentTimeoutSeconds: number;
}

/** What one resolution attempt did. */
export interface ConflictResolutionOutcome {
  /** The pass did work on this PR (drives the priority's `processed`). */
  processed: boolean;
  /** A merge was pushed. */
  merged: boolean;
  /**
   * Explicitly `false` when the resolution opened an attempt and then
   * withdrew it — the watchdog cut the agent short (Issue #1693), or a
   * repository ruleset refused the push (Issue #1772). Either way the PR's
   * budget is untouched. Recorded for the summary; what the drain steers on
   * is {@link ConflictResolutionOutcome.runEnded}.
   */
  attemptCharged?: boolean;
  /**
   * Explicitly `true` when the withdrawal happened because the **run** was
   * ending (Issue #1693). Only that withdrawal stops the pass: the PR is
   * still waiting, so its deferral streak stands, exactly as it does for an
   * attempt that never got off the ground. An uncharged attempt that ran to
   * an answer — a ruleset-refused push — leaves the drain free to take the
   * next PR (Issue #1772).
   */
  runEnded?: boolean;
}

/** A held repository lease, released when the attempt finishes. */
export interface RepoLease {
  release: () => void;
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
  /**
   * Re-read the PR's live state at the claim point (Issue #1774).
   *
   * The queue is built from a listing up to ten minutes old, so a PR closed
   * since it was taken still looks conflicting. Required, not optional: a
   * guard that can be switched off by omission is a guard that is off in
   * production the day someone adds a wiring site and forgets it.
   */
  prLiveState: (pr: ConflictingPr) => Promise<PrLiveStateReading>;
  /**
   * Resolve one conflict. Returns null when the attempt failed loudly.
   *
   * `budget` is the agent timeout this attempt may grant, sized to the
   * handler budget still left (Issue #1693). Absent when the pass runs
   * unbounded — no deadline, or no configured agent timeout — in which case
   * the resolution keeps its own default.
   */
  resolve: (
    pr: ConflictingPr,
    budget?: ConflictAttemptBudget,
  ) => Promise<ConflictResolutionOutcome | null>;
  logger: Logger;
  /** Watchdog deadline for the pass, when the dispatcher supplied one. */
  deadlineEpochMs?: number;
  /** Clock seam (epoch milliseconds). */
  now?: () => number;
  maxPerCycle?: number;
  minMsPerAttempt?: number;
  /**
   * The agent timeout one resolution would otherwise be granted, in
   * milliseconds (Issue #1693). The drain never grants more than the handler
   * budget left, so a cycle that cannot cover the configured timeout hands
   * the agent the time that genuinely remains instead of a promise the
   * watchdog then breaks.
   */
  agentTimeoutMs?: number;
  /**
   * Budget reserved for everything a resolution does outside the agent.
   * Defaults to {@link DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS}.
   */
  attemptOverheadMs?: number;
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
    agentTimeoutMs,
    attemptOverheadMs = DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS,
    deferrals,
    prLiveState,
  } = options;

  const handled = new Set<string>();
  const decisions: ConflictPrDecision[] = [];
  let merged = 0;
  let deferred = 0;
  let leftBehind = 0;
  let processed = false;
  let maxDeferralStreak = 0;
  let deferralNotices = 0;
  /** An attempt was withdrawn because the run ended under it (Issue #1693). */
  let cutShort = false;

  /**
   * The cursor the previous pass left (Issue #1111). Read once, so the order
   * offered to `findNext` is stable for the whole pass.
   *
   * A cursor that cannot be read costs fairness for this cycle, never the
   * cycle's work — the same bargain `lane_rotation.ts` strikes — but it is
   * said out loud, so a host that has silently stopped being fair is
   * diagnosable.
   */
  const loadCursor = async (): Promise<ConflictDeferralState> => {
    if (!deferrals) return new Map();
    try {
      return await deferrals.load();
    } catch (error) {
      logger.warn("Merge-conflict drain: could not read the deferral cursor", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }
  };

  const state = await loadCursor();
  const prefer = deferralCursor(state);

  /**
   * Count one deferral against a PR, and tell the PR once its streak says it
   * is being starved rather than merely queued.
   *
   * Takes the tracking explicitly so it can only be called where a cursor
   * exists, and always returns a real streak.
   *
   * @returns The PR's consecutive-deferral streak, including this one.
   */
  const noteDeferral = async (
    deferrals: ConflictDeferralTracking,
    pr: ConflictingPr,
    bound: ConflictDeferralBound,
  ): Promise<number> => {
    const key = conflictPrKey(pr.repo, pr.prNumber);
    const entry = recordDeferral(state, key, bound, now());
    maxDeferralStreak = Math.max(maxDeferralStreak, entry.streak);

    if (!deferrals.announce || !shouldAnnounceDeferral(entry, deferrals)) {
      return entry.streak;
    }
    const notice: ConflictDeferralNotice = {
      repo: pr.repo,
      prNumber: pr.prNumber,
      entry,
    };
    try {
      if (await deferrals.announce(notice)) {
        // Marked only when *this* host posted. A host that found another's
        // marker keeps checking, so a notice suppressed by a stale marker
        // resumes the moment an attempt closes the streak it belonged to.
        markDeferralNotified(state, key);
        deferralNotices++;
      }
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
    /**
     * The agent timeout this attempt may grant (Issue #1693), or undefined
     * when the pass declared none and the resolution keeps its own.
     *
     * Read as late as the drain can read it — after the lease, immediately
     * before the resolution starts — so the listing and the lease do not come
     * out of the agent's share.
     */
    const grantFor = (): ConflictAttemptBudget | undefined => {
      if (deadlineEpochMs === undefined || agentTimeoutMs === undefined) {
        return undefined;
      }
      const attemptBudgetMs = deadlineEpochMs - now() - attemptOverheadMs;
      // Never more than the budget that is left: an agent promised more time
      // than the handler has is an agent the watchdog kills mid-edit, and
      // that kill was charged to the PR (Issue #1693). Never below a second
      // either — a nonsense bound must not become a nonsense grant.
      return {
        agentTimeoutSeconds: Math.max(
          1,
          Math.floor(Math.min(agentTimeoutMs, attemptBudgetMs) / 1000),
        ),
      };
    };

    for (let taken = 0; taken < maxPerCycle; taken++) {
      if (deadlineEpochMs !== undefined) {
        const remaining = deadlineEpochMs - now();
        // What the agent would actually get: the clone, the merge and the
        // conclusion are not its to spend, so the floor is measured against
        // the agent's own share rather than the whole budget.
        const attemptBudgetMs = remaining - attemptOverheadMs;
        if (attemptBudgetMs < minMsPerAttempt) {
          // Said out loud only once the drain has done something: a pass that
          // starts late and takes nothing is the ordinary quiet case.
          if (taken > 0) {
            logger.info(
              "Merge-conflict drain stopping: too little of the cycle left " +
                "for another resolution",
              {
                taken,
                merged,
                remainingMs: remaining,
                attemptBudgetMs,
                minMsPerAttempt,
              },
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

      // Issue #1774: one live `pr view` before the lease, the clone and the
      // agent. A PR closed since the listing is skipped without a push, a
      // comment or a label, and a state that cannot be read is skipped this
      // cycle too — no attempt is opened, so the PR's budget is untouched and
      // the next pass retries it.
      const reading = await prLiveState(next);
      if (!reading.open) {
        const decision: ConflictPrDecision = {
          repo: next.repo,
          prNumber: next.prNumber,
          outcome: "skipped",
          reason: {
            kind: "pr-not-open",
            state: reading.unknown ? "UNKNOWN" : reading.state,
          },
        };
        decisions.push(decision);
        recordConflictDecision(logger, decision);
        logPrLiveSkip(
          logger,
          "Merge-conflict drain",
          next.repo,
          next.prNumber,
          reading,
        );
        continue;
      }

      const lease = acquireLease(next);
      if (lease === null) {
        // The deferral is a decision on a labelled PR like any other, so it
        // is recorded rather than left to an unstructured line (Issue #1109),
        // and it is counted against the PR so a repeat cannot stay quiet
        // (Issue #1111).
        const streak = deferrals
          ? await noteDeferral(deferrals, next, "repo-leased")
          : undefined;
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

      try {
        const outcome = await resolve(next, grantFor());
        if (outcome && outcome.runEnded !== true) {
          // The attempt ran, so the PR is not starved — whatever it then
          // concluded (Issue #1111). A `null` outcome is an attempt that never
          // got off the ground (a clone that would not set up, a branch that
          // is gone), and that PR is still waiting, so its streak stands. So
          // is an attempt the watchdog cut short (Issue #1693): it was
          // withdrawn, spent nothing, and is still queued. A ruleset-refused
          // push is not that (Issue #1772) — the PR got its full turn and
          // reached an answer, so its streak clears like any other attempt.
          clearDeferral(state, conflictPrKey(next.repo, next.prNumber));
        }
        if (outcome) {
          processed = processed || outcome.processed;
          if (outcome.merged) merged++;
        }
        if (outcome && outcome.runEnded === true) {
          // The run itself ended under this attempt (Issue #1693). Taking the
          // next PR would open an attempt marker and withdraw it again, so
          // the pass stops here and the queue keeps its place. Keyed on
          // `runEnded`, never on "uncharged": a ruleset refusal is uncharged
          // too and would otherwise starve every other conflicting PR in the
          // cycle under a log line naming the wrong cause (Issue #1772).
          cutShort = true;
        }
      } finally {
        lease.release();
      }
      if (cutShort) {
        const remaining = deadlineEpochMs !== undefined
          ? deadlineEpochMs - now()
          : 0;
        logger.info(
          "Merge-conflict drain stopping: the run ended under the last " +
            "resolution, which was withdrawn rather than judged",
          { taken: taken + 1, merged, remainingMs: remaining },
        );
        return { kind: "deadline", remainingMs: remaining };
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
    const deferralStreak = await noteDeferral(deferrals, left, bound);
    const decision: ConflictPrDecision = {
      repo: left.repo,
      prNumber: left.prNumber,
      outcome: "skipped",
      reason: { kind: "deferred-bound", bound, deferralStreak },
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
