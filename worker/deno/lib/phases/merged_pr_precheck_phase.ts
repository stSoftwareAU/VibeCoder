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
 * - If a PR URL is returned, reads the PR state and merge time via
 *   `gh pr view --json state,mergedAt`.
 * - When the PR is merged, calls `ensureIssueClosedIfPrMerged` to close the
 *   issue (idempotent — no-op if already closed) and returns `early_exit`.
 * - Except when a trusted author re-approved the issue *after* that merge
 *   (Issue #1618): the remaining scope was blessed by a human who could see
 *   the merged PR, so the close is skipped and the run continues.
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
import { isAuthorTrusted } from "../content_approval_tracker.ts";
import { resolveFleetMaintenanceAuthorSet } from "../fleet_authors.ts";
import {
  fetchCompleteTimeline,
  lastAddInfoFromTimeline,
} from "../issue_query.ts";
import { repairOrphanedMilestoneMerge } from "../orphaned_rollup.ts";
import {
  describeStrandedBranches,
  findStrandedIssueBranches,
} from "../stranded_issue_branch.ts";
import type { PostMergeReapproval } from "../reapproval_superseded_handoff.ts";

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
  state: PhaseState,
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

  // Look up the PR state and merge time. Non-fatal on error. `mergedAt` is
  // what the re-approval check below compares an approval label against
  // (Issue #1618).
  let prState: string;
  let mergedAt: string;
  try {
    const output = await deps.github.runGhCommand([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state,mergedAt",
    ]);
    const parsed = JSON.parse(output) as {
      state?: string;
      mergedAt?: string | null;
    };
    prState = parsed.state ?? "";
    mergedAt = parsed.mergedAt ?? "";
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

  // Issue #1618: a trusted author who re-approved the issue AFTER this PR
  // merged has blessed the scope that is left. #1562 was grilled to Ready and
  // given `top-priority` at 00:21; twenty minutes later this pre-check found
  // PR #1567 — matched only by the issue number in its title — merged at 22:49
  // the night before, and closed it. Re-opening by hand achieved nothing:
  // the pre-check runs on every claim.
  const reapproval = await findPostMergeApproval(ctx, mergedAt, prNumber, deps);
  if (reapproval) {
    logger.warn(
      "Merged PR pre-check: NOT closing — approval post-dates merge",
      {
        repo,
        issueNumber,
        prNumber,
        label: reapproval.label,
        addedBy: reapproval.addedBy,
        addedAt: reapproval.addedAt,
        mergedAt,
      },
    );
    // Issue #1862: carry the re-approval to the claim-release site. A run
    // that then ends superseded — the merged PR already satisfies the original
    // description, so a fresh agent had nothing to change — is handed to a
    // human rather than silently re-claimed every cycle.
    state.postMergeReapproval = {
      label: reapproval.label,
      addedBy: reapproval.addedBy,
      addedAt: reapproval.addedAt,
      prNumber,
      mergedAt,
    };
    // Continue rather than early-exit: the run works the re-approved scope
    // and raises its own PR. That PR's merge is newer than the approval, so
    // the next claim closes the issue by the ordinary path.
    return { status: "continue" };
  }

  // Issue #174: before closing on someone's merged PR, check whether this
  // issue has a pushed branch holding commits nobody has published. The
  // linker matches any PR referencing the issue, so a human's partial PR —
  // merged mid-run on VibeCoder#42 — closed an issue whose real work sat on
  // `issue-42-primary-graphql-quota-…`. And because this pre-check runs on
  // every claim, re-opening the issue by hand got it closed again next time.
  //
  // Only on the close path, so the extra API calls never land on a normal
  // claim.
  const stranded = await findStrandedIssueBranches({
    repo,
    issueNumber,
    ghFn: deps.github.runGhCommand,
    warn: (message) => logger.warn(message),
  });
  if (stranded.length > 0) {
    logger.warn(
      "Merged PR pre-check: NOT closing — this issue has unpublished work " +
        "on a pushed branch (Issue #174)",
      {
        repo,
        issueNumber,
        prNumber,
        prUrl,
        stranded: describeStrandedBranches(stranded),
      },
    );
    // Continue rather than early-exit: the run resumes that branch
    // (Issue #220) and completion raises the PR for it.
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
 * A trusted approval label added after the linked PR merged (Issue #1618).
 *
 * The label fields of {@link PostMergeReapproval}, which the phase completes
 * with the PR facts before recording it on the state (Issue #1862).
 */
type PostMergeApproval = Omit<PostMergeReapproval, "prNumber" | "mergedAt">;

/**
 * Find a trusted approval label whose most recent add post-dates the linked
 * PR's merge (Issue #1618).
 *
 * Only labels **still on the issue at claim time** are considered, so a
 * historical add of a label since removed cannot resurrect the issue. The
 * adder must be a trusted human: `allowedAuthors` minus the fleet's own
 * push-capable logins, because a label the fleet applied is maintenance, not
 * review.
 *
 * Fail-safe: an unverifiable approval time — no or unparseable `mergedAt`, a
 * timeline lookup that throws or exceeds the page cap — is logged at `WARNING`
 * and returns `null`, so the pre-check keeps today's close behaviour rather
 * than silently skipping it.
 *
 * @returns the qualifying approval, or `null` when there is none
 */
async function findPostMergeApproval(
  ctx: IssueContext,
  mergedAt: string,
  prNumber: number,
  deps: WorkerDeps,
): Promise<PostMergeApproval | null> {
  const { repo, issueNumber, config } = ctx;

  // Only labels the issue still carries can express an approval that stands.
  const present = new Set(ctx.issueLabels);
  const approvalLabels = [
    ...new Set([...config.issueLabels, config.workOnLabel]),
  ]
    .filter((label) => present.has(label));
  if (approvalLabels.length === 0) return null;

  const mergedAtSeconds = Date.parse(mergedAt) / 1000;
  if (!Number.isFinite(mergedAtSeconds)) {
    deps.logger.warn(
      "Merged PR pre-check: cannot read the PR's merge time, so a later " +
        "approval cannot be detected — closing as before",
      { repo, issueNumber, prNumber, mergedAt },
    );
    return null;
  }

  const fleetAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser: ctx.githubUser,
    serviceAccounts: config.serviceAccounts ?? [],
    fleetPrAuthors: config.fleetPrAuthors ?? [],
  });

  // One read answers every label (Issue #1617 exported the seam for exactly
  // this). The *complete* timeline, not the page-1 slice: a re-approval is by
  // definition the newest `labeled` event, and #1562 — grilled to Ready over
  // many rounds — is exactly the >100-event issue whose newest event falls off
  // page 1. No timeline cache is plumbed into the phases, so this always
  // paginates. A throw (page cap, API error) and a `null` (unparseable
  // response) are both *failed* reads — an issue with no label events is an
  // empty array — so they are reported rather than passing as "nobody
  // re-approved".
  const timeline = await fetchCompleteTimeline(
    repo,
    issueNumber,
    deps.github.runGhCommand,
  ).catch(() => null);
  if (timeline === null) {
    deps.logger.warn(
      "Merged PR pre-check: approval-time lookup failed, so a later " +
        "approval cannot be detected — closing as before",
      { repo, issueNumber, prNumber, labels: approvalLabels },
    );
    return null;
  }

  for (const label of approvalLabels) {
    const info = lastAddInfoFromTimeline(timeline, label);
    if (info === null) continue;
    if (info.addedAt <= mergedAtSeconds) continue;
    if (!isAuthorTrusted(info.addedBy, config.allowedAuthors)) continue;
    if (isAuthorTrusted(info.addedBy, fleetAuthors)) continue;
    return { label, addedBy: info.addedBy, addedAt: info.addedAt };
  }

  return null;
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
