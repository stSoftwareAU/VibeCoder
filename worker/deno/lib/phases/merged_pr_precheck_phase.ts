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

/** Reason string for the early-exit result — stable identifier used by the orchestrator. */
export const MERGED_PR_PRECHECK_EARLY_EXIT_REASON = "pr_already_merged";

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
  }

  return { status: "early_exit", reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON };
}
