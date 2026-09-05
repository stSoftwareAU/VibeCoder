/**
 * Collect configured-label issue candidates from a single repository.
 *
 * Iterates the worker's configured issue labels in priority order,
 * fetches matching issues, strips untrusted operational labels,
 * applies filterAndSort, and then enforces label-author authorisation,
 * content-integrity verification (Issue #2967 — parity with the work-on
 * and low-priority collectors), milestone occupancy, recently-closed PR
 * cooldowns, milestone-aware PR blocking, and dependency blocking. Used
 * by `findOldestIssue`.
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
import type { BlockedCandidateInfo } from "./issue_finder_logger.ts";

/**
 * Collect configured-label candidates from a single repository.
 */
export async function collectLabelCandidates(
  repo: string,
  config: WorkerConfig,
  options: FindIssuesOptions,
  repoPRs: OpenPR[],
  repoAllIssues: FilterableIssue[],
  fetcher: IssueFetcher,
  repoClosedPRs: ClosedPR[] = [],
): Promise<{
  candidates: IssueCandidate[];
  blocked: Array<{ repo: string; milestone: string }>;
  /**
   * Per-blocked-issue diagnostics with skip reason (Issue #1718).
   * Parallel structure to `blocked` — `blocked` retains its original
   * `{ repo, milestone }` shape so existing work-on suppression logic in
   * `selectHighestPriority` is unchanged. `blockedDetails` carries the
   * issue number and skip reason for the selection-reasoning log line.
   * Includes every configured-label issue that survived `filterAndSort`
   * but was rejected by a per-issue eligibility check.
   */
  blockedDetails: BlockedCandidateInfo[];
  /**
   * Number of configured-label issues that reached the per-issue
   * eligibility checks (Issue #1718). Equals `candidates.length +
   * blockedDetails.length` and feeds the `configured-label-considered`
   * field of the selection-reasoning line.
   */
  considered: number;
}> {
  const ghFn = options.ghCommandFn ?? runGhCommand;
  const diag = options.diagnostics;
  const candidates: IssueCandidate[] = [];
  const blocked: Array<{ repo: string; milestone: string }> = [];
  const blockedDetails: BlockedCandidateInfo[] = [];
  let considered = 0;

  // Issue #2031: needs-clarification retired — needs-human is the only handoff label.
  const filterLabels = {
    failedLabel: config.failedLabel,
    refineIssueLabel: config.refineIssueLabel,
    planningLabel: config.planningLabel,
    questionLabel: config.questionLabel,
    needsRevisionLabel: config.needsRevisionLabel,
    needsHumanLabel: config.needsHumanLabel,
  };

  // Issue #1808: derive the open-state map once per repo so per-child
  // `getIssueState` calls inside `isDependencyBlocked` resolve from
  // the local map on the warm path.
  const openStateMap = buildOpenIssueStateMap(repoAllIssues);

  for (let labelIdx = 0; labelIdx < config.issueLabels.length; labelIdx++) {
    const label = config.issueLabels[labelIdx]!;

    let issues: FilterableIssue[] = await fetchIssuesByLabel(
      repo,
      label,
      options.cache,
      50,
      ghFn,
    );

    issues = await cleanStaleLabels(
      issues,
      repo,
      config.failedLabel,
      config.failedOnceLabel,
      ghFn,
      options.timelineCache,
    );

    // Issue #1674: Pre-fetch label-event timelines for all candidate
    // issues in a single GraphQL call so the per-issue
    // verifyOperationalLabels checks below resolve from cached data
    // instead of making one REST call each. Falls back to the
    // existing per-issue REST path if the batch call fails.
    //
    // Issue #1783: When an iteration-scoped registry is supplied,
    // route the batch through it so overlapping issue numbers across
    // the four candidate collectors are fetched at most once per
    // iteration.
    const issueNumbers = issues.map((i) => i.number);
    const batchedGh = options.timelineBatchRegistry
      ? await options.timelineBatchRegistry.getBatchedGh(
        repo,
        issueNumbers,
        ghFn,
      )
      : await buildBatchedGh(repo, issueNumbers, ghFn);

    // Issue #1344: Verify operational labels were added by trusted users.
    // Strip untrusted operational labels before filterAndSort so that
    // malicious label additions (e.g. planning, question) are ignored.
    // Issue #3225: exclude fleet worker logins (own host + siblings) from the
    // operational-label trust set — required in allowedAuthors for PR-dedup,
    // but never trusted to apply operational labels themselves.
    // Issue #3426: the exclusion set is deliberately `github_user ∪
    // fleet_pr_authors`, NOT `allowed_authors` — the latter also lists the human
    // authors who legitimately apply these labels, so passing it here would
    // strip humans' labels too. Sibling workers must be configured in
    // fleet_pr_authors (the canonical sibling-login list) to be excluded.
    const fleetWorkerLogins = resolveFleetAuthors(
      options.githubUser,
      [],
      config.fleetPrAuthors,
    );

    // Issue #4133: only the fleet's own open PRs defer an issue — a
    // human's open PR is theirs to manage and never blocks issue pickup.
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
        // Issue #847: a `custom_label_prompts` label dispatches a privileged
        // phase, so an untrusted actor's add is stripped here rather than
        // falling through as a plain descriptive label.
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

    // Filter and sort. Per-issue label-author authorisation and
    // content-integrity (TOCTOU) re-checks run inside the loop below
    // (Issue #2967) so the highest-priority tier has the same trust
    // posture as the work-on and low-priority collectors.
    const filtered = filterAndSort(issues, filterLabels);

    // Log issues removed by filterAndSort
    if (diag) {
      const filteredNumbers = new Set(filtered.map((i) => i.number));
      for (const issue of issues) {
        if (!filteredNumbers.has(issue.number)) {
          diag.logIssueConsidered(repo, issue.number, issue.title);
          // Issue #1470: surface the needs-human skip specifically so
          // audits show the issue was bypassed because a human is required.
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
      const milestoneTitle = issue.milestone;
      diag?.logIssueConsidered(repo, issue.number, issue.title);
      considered++;

      // Issue #2967: verify the priority label was added by an allowed
      // author. The configured-label tier (`top-priority`) is selected
      // first, so an untrusted triager applying the label must not steer
      // the worker — bring it to parity with the work-on and low-priority
      // collectors (Issue #1344).
      // Issue #3416: exclude fleet worker logins (own host + siblings) — they
      // sit in allowedAuthors for PR-dedup but must not be trusted to
      // self-apply a reserved discovery label such as `top-priority`.
      const labelAdded = await wasLabelAddedByAllowedAuthor(
        repo,
        issue.number,
        label,
        config.allowedAuthors,
        batchedGh,
        options.timelineCache,
        fleetWorkerLogins,
      );
      if (!labelAdded) {
        diag?.logIssueSkipped(repo, issue.number, "label-author-not-allowed");
        blockedDetails.push({
          repo,
          issueNumber: issue.number,
          milestone: milestoneTitle,
          reason: "label-author-not-allowed",
        });
        continue;
      }

      // Issue #2967 / #1341: TOCTOU protection — verify content has not
      // been modified after the priority label was approved by a trusted
      // author. Reuses the same TOCTOU machinery as the sibling
      // collectors, parameterised by the priority label name.
      const contentCheckResult = await verifyWorkOnContentIntegrity(
        repo,
        issue,
        config,
        ghFn,
        diag,
        options.contentApprovalDeps,
        options.timelineCache,
        label,
      );
      if (contentCheckResult === "blocked") {
        blockedDetails.push({
          repo,
          issueNumber: issue.number,
          milestone: milestoneTitle,
          reason: "content-modified-after-approval",
        });
        continue;
      }

      // Check work-stream occupancy. Issue #1064: only the accounts the
      // fleet operates occupy a stream — `config.allowedAuthors` is a
      // permission list that legitimately holds humans, and a human
      // assignee must never stall the worker.
      if (
        isMilestoneOccupied(
          repoAllIssues,
          milestoneTitle,
          options.githubUser,
          pushCapableAuthors,
        )
      ) {
        diag?.logIssueSkipped(
          repo,
          issue.number,
          "milestone-occupied",
          milestoneTitle,
        );
        blocked.push({ repo, milestone: milestoneTitle });
        blockedDetails.push({
          repo,
          issueNumber: issue.number,
          milestone: milestoneTitle,
          reason: "milestone-occupied",
        });
        continue;
      }

      // Issue #1427: Check recently-closed PR blocking — prevent duplicate PRs
      if (repoClosedPRs.length > 0) {
        const closedPR = isBlockedByRecentlyClosedPR(
          repoClosedPRs,
          issue.number,
        );
        // VibeCoder#42: a trusted re-label dated after the PR closed/merged
        // reopens the issue for the fleet — the gate's documented escape hatch.
        const reopened = closedPR !== null &&
          await wasLabelReappliedAfterClosedPR(
            repo,
            issue.number,
            label,
            config.allowedAuthors,
            closedPR,
            batchedGh,
            options.timelineCache,
            fleetWorkerLogins,
          );
        if (closedPR && !reopened) {
          diag?.logIssueSkipped(
            repo,
            issue.number,
            "closed-pr-cooldown",
            `PR #${closedPR.number} closed at ${closedPR.closedAt}`,
          );
          // Issue #1718: surface the blocked issue in the
          // selection-reasoning line. We deliberately do NOT push to
          // `blocked` here — that array drives work-on suppression in
          // `selectHighestPriority`, and closed-pr-cooldown has never
          // suppressed work-on. Diagnostic-only.
          blockedDetails.push({
            repo,
            issueNumber: issue.number,
            milestone: milestoneTitle,
            reason: "closed-pr-cooldown",
          });
          continue;
        }
      }

      // Check PR blocking (per-issue, milestone-aware)
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
            config.workOnLabel === "work-on"
              ? "ignore-open-prs"
              : "ignore-open-prs",
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
            blocked.push({ repo, milestone: milestoneTitle });
            blockedDetails.push({
              repo,
              issueNumber: issue.number,
              milestone: milestoneTitle,
              reason: "pr-blocked",
            });
            continue;
          }
        }
      }

      // Check dependency blocking
      if (
        await isDependencyBlocked(repo, issue.number, fetcher, openStateMap)
      ) {
        diag?.logIssueSkipped(repo, issue.number, "dependency-blocked");
        if (repoPRs.length > 0) {
          blocked.push({ repo, milestone: milestoneTitle });
        }
        blockedDetails.push({
          repo,
          issueNumber: issue.number,
          milestone: milestoneTitle,
          reason: "dependency-blocked",
        });
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
        labelIndex: labelIdx,
        source: "configured-label",
        milestonePriority: extractMilestonePriority(issue.labels),
      });
    }
  }

  return { candidates, blocked, blockedDetails, considered };
}
