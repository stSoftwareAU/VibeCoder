/**
 * Apply the `needs-failure-detection-repair` label on a partially-repaired
 * planning run (Issue #59, part of #54).
 *
 * When the Failure-Detection self-repair (#3272) fixes some — but not all —
 * published sub-issues, the planning run is **not** a failure: the plan is
 * published and usable, and the published sub-issues stay published whatever
 * the run reports. Marking the parent `failed-once` therefore told the retry
 * machinery to re-run planning from the top, which is the wrong recovery for a
 * plan that is already 75% compliant.
 *
 * This label is that outcome's marker instead: it names the parent as carrying
 * outstanding Failure-Detection repairs, so a later resume pass can find it,
 * re-gate its sub-issues, and finish the job.
 *
 * The label is reserved (see `RESERVED_LABELS` in `config_defaults.ts`) so the
 * planner can never apply it as a descriptive label on a sub-issue, but it is
 * worker-appliable (see `WORKER_APPLIABLE_LABEL_LITERALS`) because the worker
 * itself is the only thing that may raise it.
 *
 * Every label operation here is **non-fatal**: a create or apply failure is
 * logged loudly and never aborts the planning-run closure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import { getLabelByName } from "../setup/label_definitions.ts";
import { addLabelToIssue, ensureLabelExists } from "./label_operations.ts";
import { FAILURE_DETECTION_REPAIR_LABEL } from "./config_defaults.ts";
import {
  buildParentPartialRepairComment,
  type FailureDetectionOffender,
} from "./failure_detection_gate.ts";

// Re-exported so callers can reach the label name and its apply helper from one
// module; the single definition stays beside `RESERVED_LABELS` (Issue #59).
export { FAILURE_DETECTION_REPAIR_LABEL };

/**
 * Apply {@link FAILURE_DETECTION_REPAIR_LABEL} to a planning parent issue whose
 * run left one or more published sub-issues without a filled
 * `## Failure Detection` section.
 *
 * Ensures the label exists (create-if-missing, mirroring the `degraded-model`
 * pattern), then adds it to the parent. Both steps are non-fatal.
 *
 * @param args.repo - Repository in "owner/repo" format
 * @param args.parentIssueNumber - The planning (parent) issue number
 * @param args.ghCommandFn - gh command runner (injected for testability)
 * @param args.logger - Logger for non-fatal warnings
 * @param args.cacheDir - Optional label-cache directory (injected for testability)
 * @returns True when the label was applied, false when it could not be.
 */
export async function applyFailureDetectionRepairLabel(args: {
  repo: string;
  parentIssueNumber: number;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
  cacheDir?: string;
}): Promise<boolean> {
  const { repo, parentIssueNumber, ghCommandFn, logger } = args;
  const labelDeps = args.cacheDir
    ? { ghCommandFn, cacheDir: args.cacheDir }
    : { ghCommandFn };

  const def = getLabelByName(FAILURE_DETECTION_REPAIR_LABEL);
  const colour = def?.colour ?? "d4c5f9";
  const description = def?.description ??
    "Published sub-issues still need their `## Failure Detection` criterion";

  try {
    const ensured = await ensureLabelExists(
      repo,
      FAILURE_DETECTION_REPAIR_LABEL,
      colour,
      description,
      labelDeps,
    );
    if (!ensured.ok) {
      logger.warn(
        "Failed to ensure needs-failure-detection-repair label exists (non-fatal)",
        { repo, error: ensured.error.message },
      );
    }
  } catch (err) {
    logger.warn(
      "Failed to ensure needs-failure-detection-repair label exists (non-fatal)",
      { repo, error: err instanceof Error ? err.message : String(err) },
    );
  }

  try {
    const added = await addLabelToIssue(
      repo,
      parentIssueNumber,
      FAILURE_DETECTION_REPAIR_LABEL,
      labelDeps,
    );
    if (!added.ok) {
      // Loud (Issue #3234): without the label the outstanding repairs are
      // invisible to the resume pass, so the partial outcome would go silent.
      logger.error(
        "Failed to apply the needs-failure-detection-repair label — the " +
          "outstanding repairs will not be picked up by the resume pass " +
          "(Issue #59)",
        { repo, issueNumber: parentIssueNumber, error: added.error.message },
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      "Failed to apply the needs-failure-detection-repair label — the " +
        "outstanding repairs will not be picked up by the resume pass " +
        "(Issue #59)",
      {
        repo,
        issueNumber: parentIssueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return false;
  }
}

/**
 * Record a partial Failure-Detection repair on the planning parent (Issue #59).
 *
 * Three steps, in order, each non-fatal to the planning-run closure:
 *   1. apply {@link FAILURE_DETECTION_REPAIR_LABEL},
 *   2. post one comment naming every sub-issue still needing repair and why,
 *   3. reopen the parent when Claude closed it inline, so the resume pass
 *      (#60) — which lists *open* parents carrying the label — can find it.
 *
 * @param args.parentClosed - Whether the parent is already closed (an inline
 *   close by Claude). Only then is the reopen attempted.
 * @returns Whether the label landed — false means the outstanding repairs are
 *   not discoverable, which the caller reports loudly.
 */
export async function recordPartialFailureDetectionRepair(args: {
  repo: string;
  parentIssueNumber: number;
  offenders: FailureDetectionOffender[];
  parentClosed: boolean;
  ghCommandFn: (args: string[]) => Promise<string>;
  postComment: (
    repo: string,
    issueNumber: number,
    body: string,
  ) => Promise<void>;
  logger: Logger;
  cacheDir?: string;
}): Promise<boolean> {
  const {
    repo,
    parentIssueNumber,
    offenders,
    parentClosed,
    ghCommandFn,
    postComment,
    logger,
  } = args;

  const labelled = await applyFailureDetectionRepairLabel({
    repo,
    parentIssueNumber,
    ghCommandFn,
    logger,
    ...(args.cacheDir ? { cacheDir: args.cacheDir } : {}),
  });

  try {
    await postComment(
      repo,
      parentIssueNumber,
      buildParentPartialRepairComment(
        offenders,
        FAILURE_DETECTION_REPAIR_LABEL,
      ),
    );
  } catch (err) {
    logger.warn(
      "Failed to post the partial Failure-Detection repair comment (non-fatal)",
      {
        repo,
        issueNumber: parentIssueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  if (parentClosed) {
    try {
      await ghCommandFn([
        "issue",
        "reopen",
        String(parentIssueNumber),
        "--repo",
        repo,
      ]);
      logger.info(
        "Reopened the planning parent so the outstanding Failure-Detection repairs stay resumable (Issue #59)",
        { repo, issueNumber: parentIssueNumber },
      );
    } catch (err) {
      logger.warn(
        "Failed to reopen the planning parent for the outstanding Failure-Detection repairs (non-fatal)",
        {
          repo,
          issueNumber: parentIssueNumber,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return labelled;
}
