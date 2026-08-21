/**
 * Collect idle-task issue candidates from a single repository (Issue #2006).
 *
 * Mirrors `collect_low_priority_candidates.ts` but fetches issues by the
 * `idle-task` label (see `IDLE_TASK_LABEL` in `idle_task_issue.ts`).
 * Applies the same `cleanStaleLabels`, `filterAndSort`, operational-label
 * verification, milestone-occupancy, recently-closed-PR cooldown,
 * milestone-aware PR blocking, and dependency-blocking checks as the
 * lower-tier collectors.
 *
 * `idle-task` is simply the lowest of the four work-trigger priorities
 * (`top-priority` > `work-on` > `low-priority` > `idle-task`): it means
 * "work on this issue, but only when nothing higher-priority is
 * available". It carries no other logic. The only thing special about
 * `idle-task` is *who may apply it* — the Vibe Coder may self-apply
 * `idle-task` (the other three are reserved for trusted humans; see
 * `RESERVED_LABELS`). So **every** `idle-task` issue is a claimable
 * candidate here, regardless of its title.
 *
 * Issue #3641: claimability still requires a trusted *origin* — either the
 * `idle-task` label was added by a trusted login (allowed authors ∪ fleet
 * logins) or the issue was filed by one. An untrusted actor applying
 * `idle-task` to their own issue no longer starts a billed issue→PR run.
 *
 * A claimed `idle-task` issue is routed at dispatch time: if its title or
 * body identifies it as a registered scan-wrapper it runs that template's
 * `runTask` (the scan *is* the work); otherwise it flows through the
 * standard issue→PR pipeline like any other work item. That routing lives
 * in `idle_task_claim_handler.ts` / `issue_worker.ts`, not here — this
 * collector only decides claimability.
 *
 * Emitted candidates carry `labelIndex: 299` and `source: "idle-task"`
 * so they sort strictly below low-priority's 199.
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
import {
  isFleetAuthor,
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
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";

/**
 * `labelIndex` for idle-task candidates. Set above low-priority's 199 so
 * the priority sort places idle-task candidates strictly last within the
 * same priority tier (#1961).
 */
export const IDLE_TASK_LABEL_INDEX = 299;

/**
 * Collect idle-task candidates from a single repository.
 */
export async function collectIdleTaskCandidates(
  repo: string,
  config: WorkerConfig,
  options: FindIssuesOptions,
  repoPRs: OpenPR[],
  repoAllIssues: FilterableIssue[],
  fetcher: IssueFetcher,
  repoClosedPRs: ClosedPR[] = [],
): Promise<IssueCandidate[]> {
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
    IDLE_TASK_LABEL,
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

  // Pre-fetch label-event timelines for all candidate issues in a single
  // GraphQL call so subsequent per-issue checks resolve from cached
  // data. Falls back to per-issue REST if the batch call fails.
  const issueNumbers = issues.map((i) => i.number);
  const batchedGh = options.timelineBatchRegistry
    ? await options.timelineBatchRegistry.getBatchedGh(repo, issueNumbers, ghFn)
    : await buildBatchedGh(repo, issueNumbers, ghFn);

  // Derive an open-state map from the cached open-issues list once per
  // repo so the per-child `getIssueState` calls inside
  // `isDependencyBlocked` collapse to local map reads on the warm path.
  const openStateMap = buildOpenIssueStateMap(repoAllIssues);

  // Verify operational labels (failed, needs-human, etc.) were
  // added by trusted users — strip any that weren't.
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

  // Issue #3641: trust set for the `idle-task` work trigger. Unlike the
  // reserved discovery labels, `idle-task` is deliberately worker-appliable
  // (Issue #2022), so fleet logins are *included* here rather than excluded —
  // the worker must stay able to claim wrappers it (or a sibling host) filed.
  const idleTaskTrustedAuthors = resolveFleetAuthors(
    options.githubUser,
    config.allowedAuthors,
    config.fleetPrAuthors,
  );

  // Issue #4133: only the fleet's own open PRs defer an issue — a human's
  // open PR is theirs to manage and never blocks issue pickup.
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
    );
    if (verification.untrustedLabels.length > 0) {
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "untrusted-operational-label",
        verification.untrustedLabels
          .map((u) => `${u.label}(${u.addedBy})`)
          .join(", "),
      );
      issue.labels = filterTrustedLabels(issue.labels, verification);
    }
  }

  const filtered = filterAndSort(issues, filterLabels);

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

    // No title gate: `idle-task` is just the lowest work-trigger
    // priority, so every idle-task issue is claimable here regardless of
    // its title. Whether a claimed issue runs a scan template or flows
    // through the standard issue→PR pipeline is a dispatch-time decision
    // (see `idle_task_claim_handler.ts` / `issue_worker.ts`), not a
    // claimability one.

    // Issue #3641: origin trust gate. Without it, `idle-task` was the only
    // work-discovery tier an untrusted actor could trigger — applying the
    // label to an issue whose body they authored was enough to start a full
    // billed issue→PR run on attacker-supplied content (CWE-862).
    //
    // The claim is honoured when *either* signal is trusted:
    //   - the most recent `idle-task` label add was by a trusted login, or
    //   - the issue itself was filed by a trusted login.
    // The second arm keeps the documented backfill case working (a wrapper
    // the worker filed, labelled later by an operator running the backfill
    // from their own gh auth), while the attacker case — untrusted body AND
    // untrusted label add — is rejected.
    const labelAddedByTrusted = await wasLabelAddedByAllowedAuthor(
      repo,
      issue.number,
      IDLE_TASK_LABEL,
      idleTaskTrustedAuthors,
      batchedGh,
      options.timelineCache,
      // No fleet exclusion: `idle-task` is the one label the worker may
      // self-apply, so a fleet login here is a legitimate adder.
      [],
    );
    if (
      !labelAddedByTrusted &&
      !isFleetAuthor(issue.author, idleTaskTrustedAuthors)
    ) {
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "label-author-not-allowed",
        `untrusted idle-task origin (author=${issue.author})`,
      );
      continue;
    }

    // Issue #3641: TOCTOU protection — reject content edited after the
    // `idle-task` label was applied. `allowedAuthors` is widened to the
    // idle-task trust set so worker- and sibling-filed wrappers are treated
    // as trusted content, matching the gate above.
    const contentCheckResult = await verifyWorkOnContentIntegrity(
      repo,
      issue,
      { ...config, allowedAuthors: idleTaskTrustedAuthors },
      ghFn,
      diag,
      options.contentApprovalDeps,
      options.timelineCache,
      IDLE_TASK_LABEL,
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

    if (repoClosedPRs.length > 0) {
      const closedPR = isBlockedByRecentlyClosedPR(repoClosedPRs, issue.number);
      // VibeCoder#42: a trusted re-label dated after the PR closed/merged
      // reopens the issue for the fleet — the gate's documented escape hatch.
      const reopened = closedPR !== null &&
        await wasLabelReappliedAfterClosedPR(
          repo,
          issue.number,
          IDLE_TASK_LABEL,
          idleTaskTrustedAuthors,
          closedPR,
          batchedGh,
          options.timelineCache,
          [],
        );
      if (closedPR && !reopened) {
        diag?.logIssueSkipped(
          repo,
          issue.number,
          "closed-pr-cooldown",
          `PR #${closedPR.number} closed at ${closedPR.closedAt}`,
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
      labelIndex: IDLE_TASK_LABEL_INDEX,
      source: "idle-task",
      milestonePriority: extractMilestonePriority(issue.labels),
    });
  }

  return candidates;
}
