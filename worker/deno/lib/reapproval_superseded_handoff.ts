/**
 * Hand off a re-approved issue whose fresh run had nothing to do (Issue #1862).
 *
 * Two rules, each right on its own, combined into a per-cycle loop on
 * GRQ-AutoTrader#106:
 *
 *   - the merged-PR pre-check honours a re-approval (Issue #1618) — a
 *     discovery label a trusted human added *after* the linked PR merged means
 *     the human wants more, so the issue is not closed; and
 *   - the superseded release honours the merge (Issue #218) — a branch level
 *     with its base because the merged PR already carries the work is released
 *     as superseded, not failed.
 *
 * Nothing in between asked what the re-approval was *for*. The agent was
 * started on the original issue text, which the merged PR already satisfied,
 * so it had nothing to change; the run was recorded as a success, no comment
 * was left, the label was not touched, and the next cycle claimed the issue
 * again. Three claims in four hours, each an Opus invocation for no output.
 *
 * This module closes the loop at the one point that sees both facts: a run
 * whose pre-check found a post-merge re-approval and which then ended
 * superseded is handed to a human with one marker-deduped comment naming the
 * PR that resolved the issue and asking what the re-approval should change.
 * The escalation routes through the shared {@link escalateUnworkableWorkOn}
 * plumbing, so `needs-human` is never applied without that comment, and the
 * main loop's `stripDiscoveryLabelsOnEscalation` then removes `work-on` — so
 * the issue is not re-claimed until a human answers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import type { RunOutcome } from "./run_outcome.ts";
import {
  type EscalateUnworkableDeps,
  escalateUnworkableWorkOn,
  type UnworkableEscalation,
} from "./escalate_unworkable_work_on.ts";

/**
 * A trusted discovery label whose most recent add post-dates the merge of the
 * PR linked to the issue (Issue #1618), recorded by the merged-PR pre-check so
 * a later superseded release can explain itself (Issue #1862).
 */
export interface PostMergeReapproval {
  /** The approval label whose add post-dates the merge. */
  label: string;
  /** The trusted login that added it. */
  addedBy: string;
  /** When it was added (unix seconds). */
  addedAt: number;
  /** The merged PR the approval post-dates. */
  prNumber: number;
  /** When that PR merged, as GitHub reported it (ISO 8601). */
  mergedAt: string;
}

/** Heading on the escalation comment — names what the human must answer. */
export const REAPPROVAL_SUPERSEDED_HEADING =
  "Re-approved after the PR merged — what should change?";

/**
 * The `escalateToHuman` dedup key for this hand-off on one issue.
 *
 * Stable per issue, so a second run recognises the comment the first one
 * posted rather than posting its own.
 */
export function reapprovalSupersededDedupKey(issueNumber: number): string {
  return `reapproval-superseded-${issueNumber}`;
}

/**
 * Render unix seconds as an ISO-8601 instant, or the raw value if unusable.
 *
 * `toISOString` throws a `RangeError` for a finite value outside the Date
 * range, so the conversion is guarded: a timestamp the API reported oddly
 * must degrade to its raw form in the comment, never take down the hand-off
 * the comment exists to deliver.
 */
function formatUnixSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return String(seconds);
  try {
    return new Date(seconds * 1000).toISOString();
  } catch {
    return String(seconds);
  }
}

/**
 * Build the escalation message for a re-approved issue whose fresh run ended
 * superseded.
 *
 * `supersedingPrNumber` is the PR the release named; it is normally the same
 * PR the pre-check saw, and the message only mentions it separately when it is
 * a different one, so a reader is never given two numbers for one fact.
 */
export function buildReapprovalSupersededEscalation(opts: {
  issueNumber: number;
  reapproval: PostMergeReapproval;
  supersedingPrNumber: number;
  supersedingPrUrl?: string;
}): UnworkableEscalation {
  const { reapproval } = opts;
  const resolvedBy =
    `PR #${reapproval.prNumber} (merged ${reapproval.mergedAt})`;
  const alsoNamed = opts.supersedingPrNumber > 0 &&
      opts.supersedingPrNumber !== reapproval.prNumber
    ? ` The release named PR #${opts.supersedingPrNumber}${
      opts.supersedingPrUrl ? ` (${opts.supersedingPrUrl})` : ""
    } as the PR that carries the work.`
    : "";

  return {
    reason:
      `\`${reapproval.label}\` was re-applied by @${reapproval.addedBy} ` +
      `at ${formatUnixSeconds(reapproval.addedAt)}, after ${resolvedBy} had ` +
      `already resolved this issue. This run gave a fresh agent the original ` +
      `issue description, which that PR already satisfies, so there was ` +
      `nothing left to change and the branch was released as superseded.` +
      alsoNamed +
      ` The re-approval does not say what it is for, so re-claiming would ` +
      `repeat the same empty run every cycle.`,
    nextStep: "Say what the re-approval is for — what is still missing after " +
      `PR #${reapproval.prNumber}, in its own words rather than the original ` +
      "description. **Put it in the issue description**, which is the text a " +
      "fresh agent is given; a comment alone does not reach it. Then remove " +
      `\`needs-human\` and re-apply \`${reapproval.label}\`. If that PR ` +
      "finished the work, close this issue instead.",
    dedupKey: reapprovalSupersededDedupKey(opts.issueNumber),
  };
}

/**
 * Whether a run outcome is a superseded release (Issue #218).
 *
 * The `superseded` kind is the only outcome that means "a merged or closed PR
 * already carries this work"; every other kind — a PR raised, a failure, a
 * stale claim — leaves the loop untouched.
 */
function isSupersededOutcome(
  outcome: RunOutcome | undefined,
): outcome is Extract<RunOutcome, { kind: "superseded" }> {
  return outcome?.kind === "superseded";
}

/**
 * Escalate a re-approved issue whose fresh run ended superseded (Issue #1862).
 *
 * A no-op unless **both** facts hold: the pre-check recorded a post-merge
 * re-approval, and the run's outcome is a superseded release. Both are
 * required — a re-approved issue whose run raised a PR was worked normally,
 * and a superseded release with no re-approval is the ordinary #218 stop.
 *
 * Best-effort and non-fatal, like every other escalation: a failure is logged
 * by the shared helper and reported here as `false`, never thrown, so a
 * hand-off that could not be posted cannot lose the run's own outcome.
 *
 * @returns the note to state on the claim-release comment when the hand-off
 *   fired, or `null` when nothing was escalated
 */
export async function escalateReapprovalSuperseded(opts: {
  repo: string;
  issueNumber: number;
  needsHumanLabel: string;
  reapproval: PostMergeReapproval | undefined;
  outcome: RunOutcome | undefined;
  githubUser?: string;
  ghFn: (args: string[]) => Promise<string>;
  logger?: Logger;
  deps?: EscalateUnworkableDeps;
}): Promise<string | null> {
  if (!opts.reapproval) return null;
  if (!isSupersededOutcome(opts.outcome)) return null;

  const escalation = buildReapprovalSupersededEscalation({
    issueNumber: opts.issueNumber,
    reapproval: opts.reapproval,
    supersedingPrNumber: opts.outcome.prNumber,
    supersedingPrUrl: opts.outcome.prUrl,
  });

  const escalated = await escalateUnworkableWorkOn({
    repo: opts.repo,
    issueNumber: opts.issueNumber,
    needsHumanLabel: opts.needsHumanLabel,
    escalation,
    heading: REAPPROVAL_SUPERSEDED_HEADING,
    ...(opts.githubUser ? { githubUser: opts.githubUser } : {}),
    ghFn: opts.ghFn,
    deps: {
      ...(opts.deps ?? {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    },
  });

  if (!escalated) return null;

  return `Re-approved after PR #${opts.reapproval.prNumber} merged, but this ` +
    `run found nothing left to change — handed to a human via ` +
    `\`${opts.needsHumanLabel}\` for the remaining scope (Issue #1862).`;
}
