/**
 * The new-work eligibility gates a PR-producing label route must apply
 * (Issue #937, part of #843).
 *
 * `collectWorkOnCandidates` has always run this sequence for the `work-on`
 * label. The custom-label dispatch added by #848 reaches the *same*
 * `workOnIssue` pipeline — real branch, real commits, real PR — through
 * `findIssuesByLabel`, which ran none of it. A custom label is not removed
 * when the run finishes and `unassign_on_pr_created` defaults to `true`, so
 * the next cycle re-ran the whole implementation pipeline while the PR from
 * the previous cycle was still open, at the cost of a full agent run each
 * time.
 *
 * This module is that sequence, lifted out so a second route can apply it
 * rather than restate it. Every gate is the *same helper* the work-on
 * collector calls — `isMilestoneOccupied`, `isBlockedByRecentlyClosedPR` with
 * its `wasLabelReappliedAfterClosedPR` escape hatch, `getBlockingPRForIssue`
 * with `hasIgnoreOpenPRsLabel`, and `isDependencyBlocked` — preceded by the
 * `cleanStaleLabels` / `filterAndSort` pair that drops issues carrying a
 * blocking label (`failed` among them).
 *
 * ## What is deliberately not here
 *
 * The `work-on` content-integrity check (Issue #1341) stays with `work-on`.
 * It verifies an issue's body against an approval snapshot the `work-on`
 * approval flow captures; a label that never took such a snapshot would fail
 * that gate closed (`no-approval-snapshot`) on every issue, which is a
 * different defect from the one #937 reports.
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
  type ClosedPR,
  fetchAllIssues,
  fetchOpenPRsForFleet,
  fetchRecentlyClosedPRsForFleet,
  getBlockingPRForIssue,
  hasIgnoreOpenPRsLabel,
  isBlockedByRecentlyClosedPR,
  type OpenPR,
  wasLabelReappliedAfterClosedPR,
} from "./issue_query.ts";
import type {
  BlockedCandidateInfo,
  SkipReason,
} from "./issue_finder_logger.ts";
import type { IssueFetcher, OpenIssueStateMap } from "./issue_dependencies.ts";
import {
  buildOpenIssueStateMap,
  createIssueFetcher,
  type FindIssuesOptions,
  isDependencyBlocked,
  memoiseIssueFetcher,
} from "./issue_finder_common.ts";
import {
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
  resolveFleetPrAuthorSet,
} from "./fleet_authors.ts";

/** Default closed-PR cooldown window, matching `findOldestIssue` (Issue #1427). */
const DEFAULT_CLOSED_PR_COOLDOWN_SECONDS = 3600;

/** The per-repo facts every gate in the sequence reads. */
export interface NewWorkGateContext {
  /** Repository in "owner/repo" format. */
  repo: string;
  config: WorkerConfig;
  options: FindIssuesOptions;
  /**
   * Timeline-batched `gh` shim covering the issues being gated, so the
   * closed-PR re-label check and the `ignore-open-prs` check resolve from
   * one GraphQL call per repo rather than one REST call each (Issue #1674).
   */
  batchedGh: (args: string[]) => Promise<string>;
  /** Unbatched `gh`, for the label mutations `cleanStaleLabels` makes. */
  ghFn: (args: string[]) => Promise<string>;
  /** Open PRs owned by the fleet in this repo. */
  repoPRs: OpenPR[];
  /** Recently-closed and merged fleet PRs in this repo. */
  repoClosedPRs: ClosedPR[];
  /** Every open issue in this repo, for milestone occupancy. */
  repoAllIssues: FilterableIssue[];
  /** Memoised issue reader used by the dependency gate. */
  fetcher: IssueFetcher;
  /** Open-state map so same-repo dependency lookups resolve locally. */
  openStateMap: OpenIssueStateMap;
  /**
   * Fleet worker logins excluded from the label-adder trust set
   * (Issue #3416) — they sit in `allowedAuthors` for PR-dedup but must not
   * be trusted to re-apply a dispatch label themselves.
   */
  fleetWorkerLogins: string[];
  /** The fleet's push-capable logins; only their PRs defer an issue (#4133). */
  pushCapableAuthors: string[];
}

/**
 * Gather the per-repo facts the gate sequence needs.
 *
 * Every fetch here is one the claim scan already makes in the same
 * iteration, keyed the same way in the shared `IssueCache`, so on a warm
 * cache this costs no additional `gh` calls.
 *
 * @param repo - Repository in "owner/repo" format
 * @param config - Worker configuration
 * @param options - The finder options carrying the caches and `gh` shim
 * @param batchedGh - Timeline-batched `gh` covering the issues being gated
 * @returns The context {@link filterNewWorkEligible} reads
 */
export async function buildNewWorkGateContext(
  repo: string,
  config: WorkerConfig,
  options: FindIssuesOptions,
  batchedGh: (args: string[]) => Promise<string>,
): Promise<NewWorkGateContext> {
  const ghFn = options.ghCommandFn ?? runGhCommand;

  // Issue #3100/#3138: the duplicate guard must see every fleet account's
  // PRs, or a sibling host's open PR is invisible and a second PR is raised.
  const fleetAuthors = resolveFleetPrAuthorSet({
    githubUser: options.githubUser,
    allowedAuthors: config.allowedAuthors,
    fleetPrAuthors: config.fleetPrAuthors ?? [],
  });

  const repoPRs = await fetchOpenPRsForFleet(
    repo,
    fleetAuthors,
    options.cache,
    ghFn,
  );
  const repoClosedPRs = await fetchRecentlyClosedPRsForFleet(
    repo,
    fleetAuthors,
    options.closedPrCooldownSeconds ?? DEFAULT_CLOSED_PR_COOLDOWN_SECONDS,
    options.cache,
    ghFn,
  );
  const repoAllIssues = await fetchAllIssues(repo, options.cache, 200, ghFn);

  return {
    repo,
    config,
    options,
    batchedGh,
    ghFn,
    repoPRs,
    repoClosedPRs,
    repoAllIssues,
    fetcher: memoiseIssueFetcher(createIssueFetcher(ghFn)),
    openStateMap: buildOpenIssueStateMap(repoAllIssues),
    fleetWorkerLogins: resolveFleetAuthors(
      options.githubUser,
      [],
      config.fleetPrAuthors ?? [],
    ),
    pushCapableAuthors: resolveFleetMaintenanceAuthorSet({
      githubUser: options.githubUser,
      fleetPrAuthors: config.fleetPrAuthors ?? [],
    }),
  };
}

/** The issues that survived every gate, and why each of the rest did not. */
export interface NewWorkEligibility {
  eligible: FilterableIssue[];
  blocked: BlockedCandidateInfo[];
}

/**
 * Apply the `work-on` new-work eligibility gates to a set of issues.
 *
 * The order matches `collectWorkOnCandidates`: shed stale failure labels
 * from reopened issues, drop the ones carrying a blocking label, then per
 * issue check milestone occupancy, the closed-PR block, the open-PR block
 * and dependency blocking.
 *
 * @param issues - The candidate issues, already trust-checked by the caller
 * @param label - The dispatch label, used by the closed-PR escape hatch: a
 *   trusted re-add of *this* label dated after the PR closed reopens the
 *   issue for the fleet (VibeCoder#42)
 * @param ctx - The per-repo facts from {@link buildNewWorkGateContext}
 * @returns The eligible issues, and one entry per refusal with its gate
 */
export async function filterNewWorkEligible(
  issues: FilterableIssue[],
  label: string,
  ctx: NewWorkGateContext,
): Promise<NewWorkEligibility> {
  const { config, options, repo } = ctx;
  const diag = options.diagnostics;
  const blocked: BlockedCandidateInfo[] = [];

  const note = (
    issue: FilterableIssue,
    reason: SkipReason,
    detail?: string,
  ): void => {
    blocked.push({
      repo,
      issueNumber: issue.number,
      milestone: issue.milestone,
      reason,
    });
    diag?.logIssueSkipped(repo, issue.number, reason, detail);
  };

  // A reopened issue sheds the `failed`/`failed-once` label that stopped it
  // last time. Without this the failure gate below, newly honoured for this
  // route, would strand a reopened issue permanently.
  const cleaned = await cleanStaleLabels(
    issues,
    repo,
    config.failedLabel,
    config.failedOnceLabel,
    ctx.ghFn,
    options.timelineCache,
  );

  const survived = filterAndSort(cleaned, {
    failedLabel: config.failedLabel,
    refineIssueLabel: config.refineIssueLabel,
    planningLabel: config.planningLabel,
    questionLabel: config.questionLabel,
    needsRevisionLabel: config.needsRevisionLabel,
    needsHumanLabel: config.needsHumanLabel,
  });
  const survivedNumbers = new Set(survived.map((issue) => issue.number));
  for (const issue of cleaned) {
    if (!survivedNumbers.has(issue.number)) {
      note(issue, "filtered-out", "filterAndSort");
    }
  }

  const eligible: FilterableIssue[] = [];

  for (const issue of survived) {
    const milestoneTitle = issue.milestone;

    if (
      isMilestoneOccupied(
        ctx.repoAllIssues,
        milestoneTitle,
        options.githubUser,
        config.allowedAuthors,
      )
    ) {
      note(issue, "milestone-occupied", milestoneTitle);
      continue;
    }

    // Issue #1427/#3151: a fleet PR already raised for this issue. A merged
    // one blocks permanently; a closed-unmerged one only for the cooldown
    // window. VibeCoder#42: a trusted re-add of the dispatch label dated
    // after the PR closed lifts either.
    if (ctx.repoClosedPRs.length > 0) {
      const closedPR = isBlockedByRecentlyClosedPR(
        ctx.repoClosedPRs,
        issue.number,
      );
      const reopened = closedPR !== null &&
        await wasLabelReappliedAfterClosedPR(
          repo,
          issue.number,
          label,
          config.allowedAuthors,
          closedPR,
          ctx.batchedGh,
          options.timelineCache,
          ctx.fleetWorkerLogins,
        );
      if (closedPR && !reopened) {
        note(
          issue,
          closedPR.merged ? "merged-pr-permanent" : "closed-pr-cooldown",
          `PR #${closedPR.number} ${
            closedPR.merged ? "merged" : "closed"
          } at ${closedPR.closedAt}`,
        );
        continue;
      }
    }

    // The gate #937 was filed for: the PR the previous cycle raised is still
    // open, so running the implementation pipeline again would burn a full
    // agent run to duplicate work already in review.
    if (ctx.repoPRs.length > 0) {
      const blockingPR = getBlockingPRForIssue(
        ctx.repoPRs,
        milestoneTitle,
        ctx.pushCapableAuthors,
      );
      if (blockingPR) {
        const hasIgnore = await hasIgnoreOpenPRsLabel(
          repo,
          issue.number,
          "ignore-open-prs",
          config.allowedAuthors,
          ctx.batchedGh,
          options.timelineCache,
          options.cache,
        );
        if (!hasIgnore) {
          note(issue, "pr-blocked", `PR #${blockingPR.number}`);
          continue;
        }
      }
    }

    if (
      await isDependencyBlocked(
        repo,
        issue.number,
        ctx.fetcher,
        ctx.openStateMap,
      )
    ) {
      note(issue, "dependency-blocked");
      continue;
    }

    diag?.logIssueEligible(repo, issue.number);
    eligible.push(issue);
  }

  return { eligible, blocked };
}
