/**
 * Collect low-priority issue candidates from a single repository (Issue #1724).
 *
 * Mirrors `collect_work_on_candidates.ts` but fetches issues by the
 * `low-priority` label instead of the work-on label. Applies the same
 * authorisation, content-integrity (TOCTOU), milestone-occupancy,
 * recently-closed PR cooldown, milestone-aware PR blocking, and
 * dependency blocking checks.
 *
 * Emitted candidates carry `labelIndex: 199` and `source: "low-priority"`
 * so they sort below all configured-label and work-on candidates.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import { runGhCommand } from "./github.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import {
  cleanStaleLabels,
  filterAndSort,
  isMilestoneOccupied,
} from "./issue_filter.ts";
import {
  fetchIssuesByLabel,
  getBlockingPRForIssue,
  hasIgnoreOpenPRsLabel,
  isBlockedByRecentlyClosedPR,
  wasLabelAddedByAllowedAuthor,
  wasLabelReappliedAfterClosedPR,
} from "./issue_query.ts";
import type { ClosedPR, OpenPR } from "./issue_query.ts";
import type { IssueCandidate } from "./issue_priority.ts";
import { extractMilestonePriority } from "./milestone_priority.ts";
import type { IssueFetcher } from "./issue_dependencies.ts";
import {
  filterTrustedLabels,
  verifyOperationalLabels,
} from "./label_security.ts";
import { customLabelPromptLabels } from "./custom_label_prompts_config.ts";
import {
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
} from "./fleet_authors.ts";
import {
  buildOpenIssueStateMap,
  type FindIssuesOptions,
  isDependencyBlocked,
} from "./issue_finder_common.ts";
import { verifyWorkOnContentIntegrity } from "./work_on_content_integrity.ts";
import { buildBatchedGh } from "./timeline_batch.ts";

/**
 * `labelIndex` for low-priority candidates. Set well above work-on's 99
 * so the priority sort places low-priority candidates last unconditionally.
 */
export const LOW_PRIORITY_LABEL_INDEX = 199;

/**
 * Result of low-priority candidate collection.
 *
 * Issue #2164: `hasOpenIssues` carries the raw "any open low-priority
 * issue in this repo" flag separately from `candidates` so the selection
 * step can suppress idle-task selection from repos that have pending
 * low-priority work even when every low-priority candidate is currently
 * filtered out.
 */
export interface LowPriorityCollectionResult {
  /** Eligible candidates that survived every filter. */
  candidates: IssueCandidate[];
  /**
   * True when the repo has at least one open issue carrying the
   * low-priority label, even if every such issue was filtered out by
   * the per-issue eligibility checks.
   */
  hasOpenIssues: boolean;
}

/**
 * Collect low-priority candidates from a single repository.
 */
export async function collectLowPriorityCandidates(
  repo: string,
  config: WorkerConfig,
  options: FindIssuesOptions,
  repoPRs: OpenPR[],
  repoAllIssues: FilterableIssue[],
  fetcher: IssueFetcher,
  repoClosedPRs: ClosedPR[] = [],
): Promise<LowPriorityCollectionResult> {
  const ghFn = options.ghCommandFn ?? runGhCommand;
  const diag = options.diagnostics;
  const candidates: IssueCandidate[] = [];

  // Issue #2031: needs-clarification retired — needs-human is the only handoff label.
  const filterLabels = {
    failedLabel: config.failedLabel,
    refineIssueLabel: config.refineIssueLabel,
    planningLabel: config.planningLabel,
    questionLabel: config.questionLabel,
    needsRevisionLabel: config.needsRevisionLabel,
    needsHumanLabel: config.needsHumanLabel,
  };

  let issues: FilterableIssue[] = await fetchIssuesByLabel(
    repo,
    config.lowPriorityLabel,
    options.cache,
    50,
    ghFn,
  );

  // Issue #2164: snapshot raw "has any open low-priority issue" before any
  // filter strips the list. Used by `selectHighestPriority` to suppress
  // idle-task selection from this repo even when every low-priority issue
  // is currently filtered out.
  const hasOpenIssues = issues.length > 0;

  issues = await cleanStaleLabels(
    issues,
    repo,
    config.failedLabel,
    config.failedOnceLabel,
    ghFn,
    options.timelineCache,
  );

  // Issue #1674: Pre-fetch label-event timelines for all candidate
  // issues in a single GraphQL call so subsequent per-issue checks
  // (verifyOperationalLabels, wasLabelAddedByAllowedAuthor,
  // hasIgnoreOpenPRsLabel) resolve from cached data instead of one
  // REST call each. Falls back to the existing per-issue REST path
  // if the batch call fails.
  //
  // Issue #1783: When an iteration-scoped registry is supplied, route
  // the batch through it so overlapping issue numbers across the four
  // candidate collectors are fetched at most once per iteration.
  const issueNumbers = issues.map((i) => i.number);
  const batchedGh = options.timelineBatchRegistry
    ? await options.timelineBatchRegistry.getBatchedGh(repo, issueNumbers, ghFn)
    : await buildBatchedGh(repo, issueNumbers, ghFn);

  // Issue #1808: derive an open-state map from the cached
  // open-issues list once per repo so the per-child
  // `getIssueState` calls inside `isDependencyBlocked` collapse to
  // local map reads on the warm path.
  const openStateMap = buildOpenIssueStateMap(repoAllIssues);

  // Issue #1344: Verify operational labels were added by trusted users.
  // Issue #3225: exclude fleet worker logins (own host + siblings) from the
  // operational-label trust set — required in allowedAuthors for PR-dedup,
  // but never trusted to apply operational labels themselves.
  // Issue #3426: the exclusion set is deliberately `github_user ∪
  // fleet_pr_authors`, NOT `allowed_authors` — the latter also lists the human
  // authors who legitimately apply these labels, so passing it here would strip
  // humans' labels too. Sibling workers must be configured in fleet_pr_authors
  // (the canonical sibling-login list) to be excluded.
  const fleetWorkerLogins = resolveFleetAuthors(
    options.githubUser,
    [],
    config.fleetPrAuthors,
  );

  // Issue #4133: the push-capable fleet set — only the fleet's own open
  // PRs defer an issue; a human's PR is theirs to manage.
  const pushCapableAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser: options.githubUser,
    fleetPrAuthors: config.fleetPrAuthors,
  });

  for (const issue of issues) {
    const verification = await verifyOperationalLabels(
      repo,
      issue.number,
      issue.labels,
      config.allowedAuthors,
      batchedGh,
      options.githubUser,
      fleetWorkerLogins,
      // Issue #847: a configured custom label dispatches a privileged phase,
      // so an untrusted actor's add is stripped here rather than surviving as
      // a plain descriptive label.
      customLabelPromptLabels(config),
    );
    if (verification.untrustedLabels.length > 0) {
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "untrusted-operational-label",
        verification.untrustedLabels.map((u) => `${u.label}(${u.addedBy})`)
          .join(", "),
      );
      issue.labels = filterTrustedLabels(issue.labels, verification);
    }
  }

  const filtered = filterAndSort(issues, filterLabels);

  // Log issues removed by filterAndSort
  if (diag) {
    const filteredNumbers = new Set(filtered.map((i) => i.number));
    for (const issue of issues) {
      if (!filteredNumbers.has(issue.number)) {
        diag.logIssueConsidered(repo, issue.number, issue.title);
        const reason = issue.labels.includes(config.needsHumanLabel)
          ? "needs-human"
          : "filtered-out";
        const detail = reason === "needs-human"
          ? config.needsHumanLabel
          : "filterAndSort";
        diag.logIssueSkipped(repo, issue.number, reason, detail);
      }
    }
  }

  for (const issue of filtered) {
    diag?.logIssueConsidered(repo, issue.number, issue.title);

    // Defence in depth — verify the low-priority label was added by an
    // allowed author. The issue must not be picked up if a low-trust
    // user attached the label.
    // Issue #3416: exclude fleet worker logins (own host + siblings) — they
    // sit in allowedAuthors for PR-dedup but must not be trusted to
    // self-apply the reserved `low-priority` discovery label.
    const labelAdded = await wasLabelAddedByAllowedAuthor(
      repo,
      issue.number,
      config.lowPriorityLabel,
      config.allowedAuthors,
      batchedGh,
      options.timelineCache,
      fleetWorkerLogins,
    );
    if (!labelAdded) {
      diag?.logIssueSkipped(repo, issue.number, "label-author-not-allowed");
      continue;
    }

    // Issue #1341 / #1724: TOCTOU protection — verify content has not
    // been modified after the low-priority label was approved by a
    // trusted author. Reuses the same TOCTOU machinery as the work-on
    // collector, parameterised by the approval label name.
    const contentCheckResult = await verifyWorkOnContentIntegrity(
      repo,
      issue,
      config,
      ghFn,
      diag,
      options.contentApprovalDeps,
      options.timelineCache,
      config.lowPriorityLabel,
    );
    if (contentCheckResult === "blocked") {
      continue;
    }

    const milestoneTitle = issue.milestone;

    if (
      isMilestoneOccupied(
        repoAllIssues,
        milestoneTitle,
        options.githubUser,
        config.allowedAuthors,
      )
    ) {
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "milestone-occupied",
        milestoneTitle,
      );
      continue;
    }

    // Issue #1427: Check recently-closed PR blocking — prevent duplicate PRs
    if (repoClosedPRs.length > 0) {
      const closedPR = isBlockedByRecentlyClosedPR(repoClosedPRs, issue.number);
      // VibeCoder#42: a trusted re-label dated after the PR closed/merged
      // reopens the issue for the fleet — the gate's documented escape hatch.
      const reopened = closedPR !== null &&
        await wasLabelReappliedAfterClosedPR(
          repo,
          issue.number,
          config.lowPriorityLabel,
          config.allowedAuthors,
          closedPR,
          batchedGh,
          options.timelineCache,
          fleetWorkerLogins,
        );
      if (closedPR && !reopened) {
        // Issue #319: a merged PR blocks permanently (Issue #3151) — calling
        // that a "cooldown" reads as self-healing and sent the diagnosis of
        // #187/#188 down the wrong path for a day. Name which it is, and say
        // what clears it.
        diag?.logIssueSkipped(
          repo,
          issue.number,
          closedPR.merged ? "merged-pr-permanent" : "closed-pr-cooldown",
          closedPR.merged
            ? `PR #${closedPR.number} merged at ${closedPR.closedAt} — ` +
              `permanent until a trusted re-label dated after the merge`
            : `PR #${closedPR.number} closed at ${closedPR.closedAt}`,
        );
        continue;
      }
    }

    if (repoPRs.length > 0) {
      const blockingPR = getBlockingPRForIssue(
        repoPRs,
        milestoneTitle,
        pushCapableAuthors,
      );
      if (blockingPR) {
        const hasIgnore = await hasIgnoreOpenPRsLabel(
          repo,
          issue.number,
          "ignore-open-prs",
          config.allowedAuthors,
          batchedGh,
          options.timelineCache,
          options.cache,
        );
        if (!hasIgnore) {
          diag?.logIssueSkipped(
            repo,
            issue.number,
            "pr-blocked",
            `PR #${blockingPR.number}`,
          );
          continue;
        }
      }
    }

    if (
      await isDependencyBlocked(repo, issue.number, fetcher, openStateMap)
    ) {
      diag?.logIssueSkipped(repo, issue.number, "dependency-blocked");
      continue;
    }

    diag?.logIssueEligible(repo, issue.number);
    candidates.push({
      repo,
      number: issue.number,
      url: issue.url,
      title: issue.title,
      milestone: milestoneTitle,
      createdAt: issue.createdAt,
      labelIndex: LOW_PRIORITY_LABEL_INDEX,
      source: "low-priority",
      milestonePriority: extractMilestonePriority(issue.labels),
    });
  }

  return { candidates, hasOpenIssues };
}
