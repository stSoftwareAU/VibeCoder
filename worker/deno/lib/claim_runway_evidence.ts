/**
 * Adaptive claim-runway floor (Issues #245/#425, parent #397).
 *
 * The plain floor (`claim_runway.ts`, Issue #4304) is the same for every
 * issue: enough runway to finish setup, and WIP preservation carries whatever
 * the run did not finish into the next cycle. That is right for a fresh issue
 * — a one-file fix genuinely fits the runway that is left — and wrong for an
 * issue already known to be a long job. VibeCoder#222 (21 files) was claimed
 * with 933 s of runway left: a near-certain timeout the moment it was taken,
 * which cost a claim cycle, a Fable-tier run and a claim/release comment pair,
 * and contributed nothing the next attempt did not redo.
 *
 * So the floor adapts to what is already known about the issue:
 *
 * - **No evidence** → no extra floor. Late claims of fresh small issues still
 *   happen, which is what keeps the tail of a cycle productive.
 * - **Evidence it is not a short job** — preserved WIP on the issue branch, a
 *   previous attempt that timed out in `execute`, or a configured long-job
 *   size label — → the claim needs a runway that can host a real execute, not
 *   a slice of one.
 *
 * ## Which runway, post-#397
 *
 * Issue #420 stopped truncating an execute budget at the cycle deadline, so
 * "the runway left" is no longer the runway left in the *cycle* — a claim
 * taken at minute 59 keeps its full `claude_timeout`. What still kills a run
 * short is the **supervisor hard cap** (`run_hard_cap.ts`, Issue #421), so
 * that is what this floor is measured against: `remainingRunwaySeconds` is the
 * runway to the hard-cap ceiling, and an uncapped run has none of this floor
 * at all (the caller skips it — nothing can cut the execute short).
 *
 * ## What "a real execute" means, including on a short-cap host
 *
 * The requirement is {@link LONG_JOB_BUDGET_SHARE} of the largest execute
 * budget the host can actually offer: `min(claudeTimeout, runwayWindowSeconds)`
 * — the configured budget where the hard-cap window can fit one, and the
 * window's own equivalent on a host whose cap is shorter than the budget.
 *
 * The share exists because the requirement must stay satisfiable. Demanding
 * the entire budget would make a short-cap host claim nothing at all. Three
 * quarters separates the doomed slice from the workable run on the observed
 * #222 timeline: 933 s of a 3600 s budget (26 %) is refused, while the
 * attempts that actually made progress — 56 min (93 %) and 49 min (82 %) —
 * are not.
 *
 * Pure and side-effect free: the caller gathers the evidence (see
 * `claim_evidence_lookup.ts`), applies the decision at its claim gate, and
 * logs the reason.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { describesPreservedWip } from "./wip_markers.ts";

/**
 * Size labels that mark an issue as a long job by default. Overridden per
 * host with `.config.json` `claim_long_job_labels`; matching is
 * case-insensitive, so `size/L` and `size/l` are the same label.
 */
export const DEFAULT_LONG_JOB_LABELS: readonly string[] = [
  "size/l",
  "size/xl",
  "epic",
];

/**
 * Share of the host's best execute budget an evidenced issue must have as
 * runway before it may be claimed. See the module doc for why it is below 1.
 */
export const LONG_JOB_BUDGET_SHARE = 0.75;

/** What is already known about an issue at claim time. */
export interface IssueClaimEvidence {
  /** Preserved WIP exists for this issue (a `WIP:`/`wip:` checkpoint). */
  preservedWip?: boolean;
  /** A previous attempt's recorded outcome was `timeout` in `execute`. */
  previousExecuteTimeout?: boolean;
  /** Long-job labels the issue carries, as written on the issue. */
  longJobLabels?: readonly string[];
}

/** Outcome of {@link decideAdaptiveClaim}. */
export interface AdaptiveClaimDecision {
  /** False when the issue must be left for a cycle that can host it. */
  claim: boolean;
  /** Evidence phrases, for the log line and the skip reason. */
  evidence: string[];
  /** Runway the evidenced issue needed; 0 when no adaptive floor applied. */
  requiredRunwaySeconds: number;
  /** One sentence naming why the claim was refused. Set only on a skip. */
  reason?: string;
}

/** Stable `owner/repo#number` key for a per-cycle deferral set. */
export function issueClaimKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

/**
 * Render the evidence as human phrases, in the order Issue #245 lists them.
 * An empty list means nothing is known — the plain floor stands.
 */
export function describeClaimEvidence(
  evidence: IssueClaimEvidence,
): string[] {
  const phrases: string[] = [];
  if (evidence.preservedWip) {
    phrases.push("preserved WIP exists on the issue branch");
  }
  if (evidence.previousExecuteTimeout) {
    phrases.push("the previous attempt timed out in the execute phase");
  }
  const labels = (evidence.longJobLabels ?? []).filter((l) =>
    l.trim().length > 0
  );
  if (labels.length > 0) {
    phrases.push(`the issue is labelled ${labels.join(", ")}`);
  }
  return phrases;
}

/**
 * Decide whether an issue may be claimed with the runway that is left.
 *
 * @param options.evidence - What is known about the issue (see
 *   {@link IssueClaimEvidence}). Empty evidence always claims.
 * @param options.remainingRunwaySeconds - Seconds to the supervisor hard-cap
 *   ceiling (Issue #425) — the deadline that still kills a run short.
 * @param options.fullExecuteBudgetSeconds - `config.claudeTimeout`.
 *   Non-positive (or unknown) disables the adaptive floor entirely.
 * @param options.runwayWindowSeconds - The whole hard-cap window (run start to
 *   ceiling), so a host whose cap can never fit the configured budget requires
 *   the window's equivalent instead of a floor it could never meet.
 * @param options.budgetShare - Override for {@link LONG_JOB_BUDGET_SHARE};
 *   values outside `(0, 1]` are rejected in favour of the default rather
 *   than silently disabling or idling the gate.
 */
export function decideAdaptiveClaim(options: {
  evidence: IssueClaimEvidence;
  remainingRunwaySeconds: number;
  fullExecuteBudgetSeconds: number;
  runwayWindowSeconds: number;
  budgetShare?: number;
}): AdaptiveClaimDecision {
  const {
    evidence,
    remainingRunwaySeconds,
    fullExecuteBudgetSeconds,
    runwayWindowSeconds,
  } = options;
  const phrases = describeClaimEvidence(evidence);
  const noFloor = { claim: true, evidence: phrases, requiredRunwaySeconds: 0 };
  if (phrases.length === 0) return noFloor;
  if (fullExecuteBudgetSeconds <= 0 || runwayWindowSeconds <= 0) return noFloor;

  const share = options.budgetShare !== undefined && options.budgetShare > 0 &&
      options.budgetShare <= 1
    ? options.budgetShare
    : LONG_JOB_BUDGET_SHARE;
  // The best execute this host can offer: the configured budget, or the
  // hard-cap window's equivalent on a host whose cap is shorter than it.
  const effectiveBudget = Math.min(
    fullExecuteBudgetSeconds,
    runwayWindowSeconds,
  );
  const required = Math.ceil(share * effectiveBudget);
  if (remainingRunwaySeconds >= required) {
    return { claim: true, evidence: phrases, requiredRunwaySeconds: required };
  }

  // A hard-cap window no longer than the budget can never offer it either,
  // once startup, the maintenance passes and the scan are paid for.
  const budgetClause = runwayWindowSeconds <= fullExecuteBudgetSeconds
    ? `this run's supervisor hard cap (${runwayWindowSeconds}s) can never ` +
      `offer the configured ${fullExecuteBudgetSeconds}s execute budget, so ` +
      `its own ${effectiveBudget}s equivalent is required`
    : `needs the full ${effectiveBudget}s execute budget`;
  return {
    claim: false,
    evidence: phrases,
    requiredRunwaySeconds: required,
    reason: `${budgetClause} (${phrases.join("; ")}); ` +
      `${remainingRunwaySeconds}s of hard-cap runway left, below the ` +
      `${required}s adaptive floor — leaving it for the next cycle ` +
      `(Issue #245)`,
  };
}

/**
 * Derive the evidence from an issue's own signals.
 *
 * `commentBodies` must be **fleet-authored** comments only: the markers below
 * are worker-written, and a body from an untrusted author could otherwise
 * spell one out to keep an issue from being claimed. The caller filters by
 * author; this function does not see the authors.
 *
 * @param signals.labels - The issue's labels, as written on the issue.
 * @param signals.commentBodies - Fleet-authored comment bodies (release
 *   comments and their collapsed attempt tally).
 * @param signals.longJobLabels - Configured long-job labels; defaults to
 *   {@link DEFAULT_LONG_JOB_LABELS}. Matched case-insensitively.
 */
export function evidenceFromIssueSignals(signals: {
  labels?: readonly string[];
  commentBodies?: readonly string[];
  longJobLabels?: readonly string[];
}): IssueClaimEvidence {
  const bodies = signals.commentBodies ?? [];
  const wanted = new Set(
    (signals.longJobLabels ?? DEFAULT_LONG_JOB_LABELS)
      .map((label) => label.trim().toLowerCase())
      .filter((label) => label.length > 0),
  );
  return {
    preservedWip: bodies.some((body) => describesPreservedWip(body)),
    previousExecuteTimeout: bodies.some(describesExecuteTimeout),
    longJobLabels: (signals.labels ?? []).filter((label) =>
      wanted.has(label.trim().toLowerCase())
    ),
  };
}

/**
 * True when a fleet-authored comment records an attempt that timed out in the
 * execute phase — either as a collapsed attempt-tally line (#4327) or as the
 * release comment's own outcome block (#4326).
 */
function describesExecuteTimeout(body: string): boolean {
  if (/no PR \(`timeout`, phase `execute`\)/i.test(body)) return true;
  return /no PR raised — `timeout`/i.test(body) &&
    /died in phase `execute`/i.test(body);
}
