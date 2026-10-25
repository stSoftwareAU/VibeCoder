/**
 * Close a re-approved issue whose fresh run had nothing to do (Issues #1862,
 * #4298).
 *
 * Two rules, each right on its own, combined into a per-cycle loop on
 * GRQ-AutoTrader#106:
 *
 *   - the merged-PR pre-check honours a re-approval (Issue #1618) — a
 *     discovery label a trusted human added *after* the linked PR merged keeps
 *     the issue open; and
 *   - the superseded release honours the merge (Issue #218) — a branch level
 *     with its base because the merged PR already carries the work is released
 *     as superseded, not failed.
 *
 * The agent was started on the original issue text, which the merged PR
 * already satisfied, so it had nothing to change, and the next cycle claimed
 * the issue again. Three claims in four hours, each an Opus invocation for no
 * output.
 *
 * This module closes the loop at the one point that sees both facts: a run
 * whose pre-check found a post-merge re-approval and which then ended
 * superseded has just shown the merged PR already does what the issue asks.
 * The issue is closed as completed by that PR, with a comment naming it. It
 * used to be handed to a human with a question; the owner's rule (Issue
 * #4298) is that the worker never hands an approved issue back. Anything the
 * re-approval wanted beyond the merged PR belongs in a new issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import { defaultLogger } from "./logger.ts";
import type { RunOutcome } from "./run_outcome.ts";

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

/**
 * Render unix seconds as an ISO-8601 instant, or the raw value if unusable.
 *
 * `toISOString` throws a `RangeError` for a finite value outside the Date
 * range, so the conversion is guarded: a timestamp the API reported oddly
 * must degrade to its raw form in the comment, never take down the close.
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
 * The closing comment for a re-approved issue whose fresh run ended
 * superseded. Exported for testing.
 */
export function buildReapprovalSupersededClose(
  reapproval: PostMergeReapproval,
): string {
  return `## Re-approved after the PR merged — closed as completed\n\n` +
    `\`${reapproval.label}\` was re-applied by @${reapproval.addedBy} at ` +
    `${formatUnixSeconds(reapproval.addedAt)}, after PR ` +
    `#${reapproval.prNumber} (merged ${reapproval.mergedAt}) had already ` +
    `resolved this issue. A fresh run on the issue description found nothing ` +
    `left to change, so the issue is closed as completed by that PR ` +
    `(Issue #4298). Anything still wanted beyond it belongs in a new issue.`;
}

/**
 * Close a re-approved issue whose fresh run ended superseded (Issue #4298).
 *
 * A no-op unless **both** facts hold: the pre-check recorded a post-merge
 * re-approval, and the run's outcome is a superseded release. A re-approved
 * issue whose run raised a PR was worked normally, and a superseded release
 * with no re-approval is the ordinary #218 stop.
 *
 * Best-effort and non-fatal: a failed close is logged and reported as `null`,
 * never thrown, so it cannot lose the run's own outcome; the next run meets
 * the same facts and closes it then.
 *
 * @returns the note to state on the claim-release comment when the issue was
 *   closed, or `null` when nothing was closed
 */
export async function closeReapprovalSuperseded(opts: {
  repo: string;
  issueNumber: number;
  reapproval: PostMergeReapproval | undefined;
  outcome: RunOutcome | undefined;
  ghFn: (args: string[]) => Promise<string>;
  logger?: Logger;
}): Promise<string | null> {
  if (!opts.reapproval) return null;
  if (opts.outcome?.kind !== "superseded") return null;
  const logger = opts.logger ?? defaultLogger;
  try {
    await opts.ghFn([
      "issue",
      "close",
      String(opts.issueNumber),
      "--repo",
      opts.repo,
      "--reason",
      "completed",
      "--comment",
      buildReapprovalSupersededClose(opts.reapproval),
    ]);
  } catch (err) {
    logger.warn("Could not close the re-approved, superseded issue", {
      repo: opts.repo,
      issueNumber: opts.issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return `Re-approved after PR #${opts.reapproval.prNumber} merged, but this ` +
    `run found nothing left to change — closed as completed by that PR ` +
    `(Issue #4298).`;
}
