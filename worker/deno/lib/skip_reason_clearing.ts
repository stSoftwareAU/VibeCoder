/**
 * How each claim-scan gate's refusal is lifted (Issue #524).
 *
 * "Claim a labelled issue" is a conjunction of ~24 {@link SkipReason} gates.
 * One property of a gate decides whether an issue it refuses may still
 * *serialise* its repository — i.e. park the lower tiers behind it: does the
 * refusal clear on its own?
 *
 * That property used to be encoded as a subtraction of the two gates somebody
 * remembered:
 *
 * ```ts
 * (filtered.length - dependencyBlockedCount - mergedPrPermanentCount) > 0
 * ```
 *
 * which is #499 waiting to happen again — a 25th gate with permanent semantics
 * reintroduces the defect and nothing forces anyone to notice. Here the
 * property is **data**: {@link SKIP_REASON_CLEARING} is total over
 * {@link SKIP_REASONS}, so a new skip reason fails the type check until
 * somebody declares how it clears, and the suppression rule is derived from
 * the declaration rather than restated per gate.
 *
 * The same shape, and the same reason for it, as `CENSUS_SCAN_GATE_COVERAGE`
 * in `idle_decision_census.ts` — whose docblock records that #3526, #3852 and
 * GRQ#4419 were each a forgotten gate.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { SKIP_REASONS, type SkipReason } from "./issue_finder_logger.ts";

/**
 * How a gate's refusal is lifted.
 *
 * - `self` — the ordinary claim cycle lifts it with nobody acting: a cooldown
 *   window expires, an open PR lands, an occupied work stream frees, a
 *   transient read succeeds on the next pass. Waiting is correct, so an issue
 *   held here still serialises its repo.
 * - `permanent` — nothing the fleet does in its ordinary operation lifts it.
 *   Only an explicit trusted re-approval (`merged-pr-permanent`) or an
 *   operator configuration change does.
 * - `human` — someone outside this cycle must act first: remove a label,
 *   unassign the issue, answer an escalation — or land work that the
 *   suppression itself would freeze, which is the `dependency-blocked` case
 *   (#2610: the dependency is frequently a `low-priority` issue in the same
 *   repo).
 *
 * Only `self` suppresses. A `permanent` or `human` gate that raised the
 * suppression signal would strand the repo's lower tiers behind work no cycle
 * can ever clear — the #499 deadlock, in which one `work-on` issue named by a
 * merged PR parked all 28 `low-priority` issues in `NEAT-AI-Rebase`
 * indefinitely.
 */
export type GateClearing = "self" | "permanent" | "human";

/**
 * Every gate the claim scan applies, and how its refusal is lifted.
 *
 * **Total** over {@link SkipReason}: adding a reason to `SKIP_REASONS` without
 * classifying it here is a compile error, which is the whole point — the class
 * of bug this removes is "a new gate nobody classified".
 */
export const SKIP_REASON_CLEARING: Record<SkipReason, GateClearing> = {
  // Repo-level. Busyness and a failed fetch pass; the operator's allow-list
  // and `nice` deprioritisation do not.
  "repo-not-allowed": "permanent",
  "repo-deprioritised": "permanent",
  "repo-busy": "self",
  "fetch-error": "self",
  // Label / assignee state. Every one of these needs somebody to change the
  // issue — which is why `filterAndSort` drops them and #2751 stopped them
  // suppressing.
  "assigned": "human",
  "blocking-label": "human",
  "needs-human": "human",
  "filtered-out": "human",
  "non-wrapper-title": "human",
  "label-author-not-allowed": "human",
  "untrusted-operational-label": "human",
  // Serialisation. All three end with the fleet's own next step: the PR
  // merges or closes, the stream frees, the window expires.
  "milestone-occupied": "self",
  "pr-blocked": "self",
  "closed-pr-cooldown": "self",
  "cooldown": "self",
  "cross-worker-cooldown": "self",
  /**
   * Issue #3151: a **merged** fleet PR blocks for ever. Only a trusted
   * re-label dated after the merge lifts it (or the housekeeping sweep closes
   * the issue outright, Issue #504). This is the gate whose subtraction this
   * map replaces.
   */
  "merged-pr-permanent": "permanent",
  /**
   * Issue #2610: cleared by closing the dependency — which is frequently a
   * `low-priority` issue in the same repo, i.e. exactly the work suppression
   * would freeze. Treated as needing an actor outside this cycle so the chain
   * cannot deadlock against itself.
   */
  "dependency-blocked": "human",
  // Content integrity. A transient fault retries next cycle; a real
  // modification, a missing baseline and an unconfigured store all need a
  // person (a trusted re-approval, or operator configuration).
  "content-check-error": "self",
  "content-editor-unresolved": "self",
  "content-snapshot-persist-failed": "self",
  "content-modified-after-approval": "human",
  "no-approval-snapshot": "human",
  "content-store-unconfigured": "human",
  // Issue #505: the in-flight cap frees on a later cycle.
  "self-schedule-refused": "self",
  // Already in front of a human on the issue itself.
  "dependency-cycle-escalated": "human",
  "dead-label-tracker-escalated": "human",
  "human-pr-blocked-escalated": "human",
  "self-schedule-escalated": "human",
};

/**
 * Whether an issue refused by `reason` still serialises its repository —
 * i.e. whether it may park the lower tiers behind it.
 *
 * `undefined` means the issue was refused by nothing at all: an eligible
 * higher-tier issue is the original serialisation signal (#2164) and always
 * suppresses.
 *
 * @param reason - The gate that refused the issue, or `undefined` when it is
 *   eligible.
 * @returns `true` when the block clears by itself, so waiting is correct.
 */
export function suppressesLowerTiers(reason: SkipReason | undefined): boolean {
  return reason === undefined || SKIP_REASON_CLEARING[reason] === "self";
}

/**
 * The skip reasons whose refusal never clears without an outside actor.
 *
 * Exposed so a caller (and the guard test) can enumerate the class rather than
 * restate its members — the restatement is what #499 was.
 */
export function permanentlyBlockingReasons(): SkipReason[] {
  return SKIP_REASONS.filter((reason) => !suppressesLowerTiers(reason));
}
