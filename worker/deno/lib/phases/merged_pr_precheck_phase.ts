/**
 * Phase 0 — Merged PR pre-flight check (Issue #1560).
 *
 * Detects issues whose work has already been merged, closes them,
 * and exits early before cloning the repo, running Claude, or the
 * quality gate. This is the "suspenders" half of the belt-and-
 * suspenders fix for the loop described in parent issue #1557 —
 * completion-phase closure (#1559) is the belt.
 *
 * Behaviour:
 * - Looks up an existing PR for the issue via `deps.pr.findExistingPrForIssue`.
 * - If a PR URL is returned, reads the PR state via `gh pr view --json state`.
 * - When the PR is merged, calls `ensureIssueClosedIfPrMerged` to close the
 *   issue (idempotent — no-op if already closed) and returns `early_exit`.
 * - Any other PR state, or no PR at all, returns `continue`.
 * - Any error is logged as a warning and falls through to `continue`
 *   (non-fatal — the normal pipeline handles recovery).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { ensureIssueClosedIfPrMerged } from "../issue_lifecycle.ts";
import { repairOrphanedMilestoneMerge } from "../orphaned_rollup.ts";

/** Reason string for the early-exit result — stable identifier used by the orchestrator. */
export const MERGED_PR_PRECHECK_EARLY_EXIT_REASON = "pr_already_merged";

/**
 * Reason prefix for a pre-check that refused to close the issue because the
 * merge never landed (Issue #175). Distinct from
 * {@link MERGED_PR_PRECHECK_EARLY_EXIT_REASON} so the orchestrator can report
 * a bounce rather than a success — a bounce reported as success is what let
 * both pool slots re-claim the same issue every scan cycle.
 */
export const MERGED_PR_PRECHECK_UNRESOLVED_REASON = "merged_pr_did_not_land";

/**
 * Pre-flight check: close the issue and exit early when a merged PR already exists.
 *
 * Runs before any repo I/O so the worker never wastes a cycle on an
 * issue whose work is already merged.
 */
export async function workOnIssueMergedPrPrecheck(
  ctx: IssueContext,
  _state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber, githubUser } = ctx;
  const logger = deps.logger;

  // Look up any existing PR for this issue. Non-fatal — if this errors
  // (e.g. gh API hiccup) fall through to the normal flow.
  let prUrl: string;
  try {
    const findResult = await deps.pr.findExistingPrForIssue(repo, issueNumber);
    if (!findResult.ok) {
      // No PR found — nothing to pre-check.
      return { status: "continue" };
    }
    // Defensive: some mocks/shapes can return ok=true with no URL value.
    if (!findResult.value || typeof findResult.value !== "string") {
      return { status: "continue" };
    }
    prUrl = findResult.value;
  } catch (err) {
    logger.warn(
      "Merged PR pre-check: findExistingPrForIssue errored (non-fatal)",
      {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return { status: "continue" };
  }

  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  if (!prNumberMatch) {
    logger.warn(
      "Merged PR pre-check: could not parse PR number from URL (non-fatal)",
      {
        prUrl,
      },
    );
    return { status: "continue" };
  }
  const prNumber = parseInt(prNumberMatch[1]!, 10);

  // Look up the PR state. Non-fatal on error.
  let prState: string;
  try {
    const output = await deps.github.runGhCommand([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state",
    ]);
    const parsed = JSON.parse(output) as { state?: string };
    prState = parsed.state ?? "";
  } catch (err) {
    logger.warn("Merged PR pre-check: PR state lookup errored (non-fatal)", {
      repo,
      issueNumber,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "continue" };
  }

  if (prState !== "MERGED") {
    return { status: "continue" };
  }

  // PR is merged — close the issue if still open. `ensureIssueClosedIfPrMerged`
  // is idempotent: it returns closed=false when the issue is already closed.
  logger.info("Merged PR pre-check: PR is merged, ensuring issue is closed", {
    repo,
    issueNumber,
    prNumber,
    prUrl,
  });

  const closeResult = await ensureIssueClosedIfPrMerged(
    repo,
    issueNumber,
    prNumber,
    githubUser,
    { ghCommandFn: deps.github.runGhCommand, logger },
  );

  if (!closeResult.ok) {
    logger.warn(
      "Merged PR pre-check: ensureIssueClosedIfPrMerged errored (non-fatal)",
      {
        repo,
        issueNumber,
        prNumber,
        error: closeResult.error.message,
      },
    );
    // Still short-circuit — the PR is merged, so running the full pipeline
    // would waste cycles. A subsequent run will retry the close.
    return {
      status: "early_exit",
      reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON,
    };
  }

  // Issue #175: the merge did not land, so the pre-check could not resolve
  // the issue. Self-heal what it can (an orphaned milestone merge needs a
  // fresh rollup PR), then report a bounce — NOT a success. Reporting it as
  // a success made the scan forget the issue immediately, and both pool
  // slots re-claimed it every cycle for the whole run.
  const unlanded = closeResult.value.unlanded;
  if (unlanded) {
    const repair = await selfHealOrphanedMerge(
      repo,
      prNumber,
      unlanded.baseRefName ?? "",
      deps,
    );
    logger.warn(
      `Merged PR pre-check could not resolve issue #${issueNumber}: ` +
        `${closeResult.value.reason}. Self-heal: ${repair}. The issue is ` +
        `placed in the retry cooldown so it is not re-claimed until ` +
        `something changes (Issue #175)`,
      { repo, issueNumber, prNumber, landingReason: unlanded.reason },
    );
    return {
      status: "early_exit",
      reason:
        `${MERGED_PR_PRECHECK_UNRESOLVED_REASON}: ${closeResult.value.reason}`,
      expectedSkip: true,
    };
  }

  return { status: "early_exit", reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON };
}

/**
 * Raise (or confirm) a rollup PR for a milestone branch carrying an orphaned
 * merge, and describe the outcome for the warning log.
 *
 * Never throws: the pre-check's job is to report the bounce, and a repair
 * that failed is reported as a failure in the message rather than swallowed.
 */
async function selfHealOrphanedMerge(
  repo: string,
  prNumber: number,
  baseRefName: string,
  deps: WorkerDeps,
): Promise<string> {
  const outcome = await repairOrphanedMilestoneMerge({
    repo,
    milestoneBranch: baseRefName,
    orphanedPrNumber: prNumber,
    ghCommandFn: deps.github.runGhCommand,
  }).catch((err) => ({
    action: "failed" as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  switch (outcome.action) {
    case "created":
      return `raised rollup PR ${outcome.prUrl} for ${outcome.milestoneBranch}`;
    case "exists":
      return `rollup PR #${outcome.prNumber} for ${outcome.milestoneBranch} is already open`;
    case "nothing-to-merge":
      return `${outcome.milestoneBranch} is not ahead of the default branch — no rollup PR needed`;
    case "not-applicable":
      return `no rollup repair applies (${outcome.reason})`;
    case "failed":
      return `rollup repair FAILED — ${outcome.reason}`;
  }
}
