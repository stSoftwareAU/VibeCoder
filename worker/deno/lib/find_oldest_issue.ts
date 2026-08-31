/**
 * Find the oldest eligible issue across all configured repositories.
 *
 * Main entry point for cross-repo issue discovery. Categorises repos
 * as free or busy via milestone-aware availability checks, then
 * collects configured-label and work-on candidates and applies
 * cooldown filters before selecting the highest-priority issue.
 *
 * Per-repo collection logic lives in `collect_label_candidates.ts`
 * and `collect_work_on_candidates.ts`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import { runGhCommand } from "./github.ts";
import { IssueCache } from "./issue_cache.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import {
  fetchAllIssues,
  fetchOpenPRsForFleet,
  fetchRecentlyClosedPRsForFleet,
} from "./issue_query.ts";
import {
  formatCandidateOutput,
  type IssueCandidate,
  selectHighestPriority,
  type SelectionOptions,
  type SelectionResult,
} from "./issue_priority.ts";
import { getGhCallMetrics } from "./gh_call_metrics.ts";
import { checkRepoAvailability } from "./repo_availability.ts";
import type { RepoIssueInfo } from "./repo_availability.ts";
import { isRepoAllowed } from "./config_validator.ts";
import {
  type BlockedCandidateInfo,
  createDiagnostics,
  type SkipReason,
} from "./issue_finder_logger.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
  type FindIssuesResult,
  isRateLimitError,
} from "./issue_finder_common.ts";
import { shuffleArray } from "./array_utils.ts";
import { collectLabelCandidates } from "./collect_label_candidates.ts";
import { collectWorkOnCandidates } from "./collect_work_on_candidates.ts";
import { collectLowPriorityCandidates } from "./collect_low_priority_candidates.ts";
import { collectIdleTaskCandidates } from "./collect_idle_task_candidates.ts";
import { collectSelfDiagnosticCandidates } from "./collect_self_diagnostic_candidates.ts";
import { getRepoNice } from "./repo_config.ts";
import {
  compareFleetAuthorSets,
  resolveFleetPrAuthorSet,
} from "./fleet_authors.ts";

/**
 * Find the oldest eligible issue across all configured repositories.
 *
 * This is the main entry point for issue finding. Searches through all
 * configured repositories and returns the oldest eligible issue.
 *
 * @param config - Worker configuration
 * @param options - Search options
 * @returns Search result
 */
export async function findOldestIssue(
  config: WorkerConfig,
  options: FindIssuesOptions,
): Promise<FindIssuesResult> {
  const ghFn = options.ghCommandFn ?? runGhCommand;
  const cache = options.cache ?? new IssueCache();
  cache.resetStats();

  const diag = options.diagnostics ?? createDiagnostics();

  const noResult: FindIssuesResult = {
    output: "",
    found: false,
    summary: "No eligible issues found",
  };

  if (config.repos.length === 0) {
    return noResult;
  }

  // Shuffle repos for fairness (unless disabled)
  const repos = config.shuffleRepos
    ? shuffleArray([...config.repos])
    : [...config.repos];

  // Categorise repos as free or busy
  const freeRepos: string[] = [];
  const busyRepos: string[] = [];

  // Issue #1672: cache the all-issues list fetched during availability
  // classification and reuse it during the second-phase candidate scan,
  // avoiding a redundant cache file read + JSON parse per repo per iteration.
  const issuesByRepo = new Map<string, FilterableIssue[]>();

  for (const repo of repos) {
    if (!isRepoAllowed(config.repos, repo)) {
      diag.logRepoClassification(repo, "not-allowed");
      continue;
    }

    if (options.isRepoDeprioritised?.(repo)) {
      diag.logRepoClassification(repo, "deprioritised");
      continue;
    }

    // Held by another slot on this host (Issue #4176): no two slots may
    // share a clone, so this repository is invisible to this scan.
    if (options.excludeRepos?.has(repo)) {
      diag.logRepoClassification(repo, "in-flight");
      continue;
    }

    // Check availability using milestone-aware logic
    try {
      const allIssuesForCheck = await fetchAllIssues(repo, cache, 200, ghFn);
      issuesByRepo.set(repo, allIssuesForCheck);
      const repoIssueInfos: RepoIssueInfo[] = allIssuesForCheck.map((i) => ({
        number: i.number,
        milestone: i.milestone,
        assignees: i.assignees,
      }));
      const availability = checkRepoAvailability(
        repoIssueInfos,
        options.githubUser,
      );
      if (availability.hasAvailableWork) {
        freeRepos.push(repo);
        diag.logRepoClassification(repo, "free");
      } else {
        busyRepos.push(repo);
        diag.logRepoClassification(repo, "busy");
      }
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      freeRepos.push(repo); // Fail open
      diag.logRepoClassification(repo, "error");
    }
  }

  // Prefer free repos; scan all if none are free (avoid deadlock)
  const scanRepos = freeRepos.length > 0 ? freeRepos : busyRepos;

  const allLabelCandidates: IssueCandidate[] = [];
  const allWorkOnCandidates: IssueCandidate[] = [];
  /** Issue #505: tier 2b — auto-filed diagnostics the worker schedules. */
  const allSelfDiagnosticCandidates: IssueCandidate[] = [];
  const allLowPriorityCandidates: IssueCandidate[] = [];
  const allIdleTaskCandidates: IssueCandidate[] = [];
  const allBlocked: Array<{ repo: string; milestone: string }> = [];
  // Issue #2164: track repos with raw open work-on / low-priority issues
  // so `selectHighestPriority` can suppress lower-tier selection in those
  // repos even when every candidate was filtered out by per-issue checks.
  const reposWithOpenWorkOn = new Set<string>();
  const reposWithOpenLowPriority = new Set<string>();
  // Issue #1718: accumulate per-issue blocked details and the total
  // count of configured-label candidates considered across every repo
  // so the selection-reasoning line can quote actual issue numbers and
  // skip reasons.
  const allBlockedDetails: BlockedCandidateInfo[] = [];
  let configuredLabelConsidered = 0;

  const fetcher = createIssueFetcher(ghFn);

  // Issue #3100/#3138: feed the open-PR duplicate guard the union of every
  // fleet account's open PRs so another host's open PR for the same issue
  // blocks a duplicate PR being raised. #3138 root cause: the fleet set
  // was built from `allowedAuthors` only, so a sibling listed solely in
  // `fleetPrAuthors` was never queried and its PRs were invisible. The
  // resolver unions the host login, `allowedAuthors`, and
  // `fleetPrAuthors` so no configured sibling can be a blind spot.
  // Issue #4024: resolved once per iteration through the shared
  // `resolveFleetPrAuthorSet` helper — the single source of truth every
  // consumer of "PRs the fleet owns" shares.
  // Issue #209: `config.fleetPrAuthors` is the *effective* sibling list —
  // `loadConfig` has already unioned `service_accounts` into it, so a
  // sibling configured only under that key is covered here too.
  const fleetAuthors = resolveFleetPrAuthorSet({
    githubUser: options.githubUser,
    allowedAuthors: config.allowedAuthors,
    fleetPrAuthors: config.fleetPrAuthors ?? [],
  });

  // Issue #4024: the PR-maintenance scans resolve their own set from the
  // same helper. Compare the two once per iteration and warn — never
  // abort — when they diverge, because a blocking PR outside the
  // maintenance set is a PR nothing will fix, answer, or merge (#4023).
  // Issue #4079: since #4076 the maintenance set omits `allowed_authors`
  // by design, so those logins are declared as the expected delta. Only
  // an unexpected gap — a fleet-owned sibling nothing maintains, or a
  // maintained login the guard cannot see — still warns.
  const maintenanceAuthors = options.maintenanceAuthors ?? fleetAuthors;
  diag.logFleetAuthorSetDivergence(
    compareFleetAuthorSets(fleetAuthors, maintenanceAuthors, {
      expectedMaintenanceExclusions: config.allowedAuthors ?? [],
    }),
  );

  // Thread diagnostics through to collector functions
  const optionsWithDiag = {
    ...options,
    cache,
    ghCommandFn: ghFn,
    diagnostics: diag,
    maintenanceAuthors,
  };

  for (const repo of scanRepos) {
    if (!isRepoAllowed(config.repos, repo)) continue;

    if (options.isRepoDeprioritised?.(repo)) continue;
    if (options.excludeRepos?.has(repo)) continue;

    const perAuthorPrCounts: Record<string, number> = {};
    const repoPRs = await fetchOpenPRsForFleet(
      repo,
      fleetAuthors,
      cache,
      ghFn,
      perAuthorPrCounts,
    );
    // Issue #3138 observability: record the guard's inputs so a future
    // duplicate-PR miss is diagnosable from the logs alone.
    diag.logFleetPrGuard(repo, fleetAuthors, perAuthorPrCounts, repoPRs.length);

    // Issue #1427: Fetch recently-closed PRs to prevent duplicate PR creation.
    // Issue #3151: query the fleet set (not just this host) and cover *merged*
    // PRs permanently. `fetchRecentlyClosedPRsForFleet` unions every fleet
    // author's closed/merged PRs so a sibling account's merge blocks re-pickup
    // (Failure Mode B in #3136), and a merged PR skips the issue for good
    // regardless of the cooldown window — re-pickup then requires a human to
    // re-open/re-label. Closed-unmerged PRs still expire with the window so
    // the retry path is preserved.
    const closedPrCooldown = options.closedPrCooldownSeconds ?? 3600;
    const repoClosedPRs = await fetchRecentlyClosedPRsForFleet(
      repo,
      fleetAuthors,
      closedPrCooldown,
      cache,
      ghFn,
    );

    // Issue #1672: reuse the all-issues list captured during availability
    // classification when present. Fall back to fetchAllIssues only if the
    // map does not contain this repo (e.g., classification raised an error
    // before issuesByRepo.set could run).
    const repoAllIssues = issuesByRepo.get(repo) ??
      await fetchAllIssues(repo, cache, 200, ghFn);

    const labelResult = await collectLabelCandidates(
      repo,
      config,
      optionsWithDiag,
      repoPRs,
      repoAllIssues,
      fetcher,
      repoClosedPRs,
    );
    allLabelCandidates.push(...labelResult.candidates);
    allBlocked.push(...labelResult.blocked);
    allBlockedDetails.push(...labelResult.blockedDetails);
    configuredLabelConsidered += labelResult.considered;

    const workOnResult = await collectWorkOnCandidates(
      repo,
      config,
      optionsWithDiag,
      repoPRs,
      repoAllIssues,
      fetcher,
      repoClosedPRs,
    );
    allWorkOnCandidates.push(...workOnResult.candidates);
    // Issue #460: the work-on collector's per-issue skip reasons join the
    // label collector's, so the result names every gate that refused work.
    allBlockedDetails.push(...workOnResult.blockedDetails);
    // Issue #2610: suppress this repo's low-priority/idle-task tiers only
    // when it has an open work-on issue that is not *solely* dependency-
    // blocked. A repo whose only work-on issues are waiting on open
    // dependencies must keep its low-priority backlog eligible so the
    // dependency chain can be worked rather than deadlocking.
    if (workOnResult.hasSuppressingWorkOn) {
      reposWithOpenWorkOn.add(repo);
    }

    // Issue #505: Collect self-scheduled worker diagnostics. Tier 2b —
    // below both human-scheduled tiers, above the backlog. A no-op for
    // every repo but the worker's own, and when the path is disabled.
    const selfDiagnosticResult = await collectSelfDiagnosticCandidates(
      repo,
      config,
      optionsWithDiag,
      repoPRs,
      repoAllIssues,
      fetcher,
      repoClosedPRs,
    );
    allSelfDiagnosticCandidates.push(...selfDiagnosticResult.candidates);

    // Issue #1725: Collect low-priority candidates per repo. Tier 3
    // suppression is enforced globally in selectHighestPriority once
    // every repo has been scanned.
    const lowPriorityResult = await collectLowPriorityCandidates(
      repo,
      config,
      optionsWithDiag,
      repoPRs,
      repoAllIssues,
      fetcher,
      repoClosedPRs,
    );
    allLowPriorityCandidates.push(...lowPriorityResult.candidates);
    if (lowPriorityResult.hasOpenIssues) {
      reposWithOpenLowPriority.add(repo);
    }

    // Issue #2006: Collect idle-task candidates per repo. Tier 4 —
    // strictly below low-priority. selectHighestPriority enforces
    // global suppression once every repo has been scanned.
    const idleTaskResult = await collectIdleTaskCandidates(
      repo,
      config,
      optionsWithDiag,
      repoPRs,
      repoAllIssues,
      fetcher,
      repoClosedPRs,
    );
    allIdleTaskCandidates.push(...idleTaskResult);
  }

  // Issue #655: a refusal here is recorded, not merely logged. `blockedDetails`
  // is what the idle-inversion escalation reads to name the gate that refused
  // each issue the census called claimable (Issue #460); these filters wrote
  // nothing, so VibeCoder#655 was filed with an empty "what the claim scan did
  // with them" section — the one fact its reader needed.
  const noteCooldown = (c: IssueCandidate, reason: SkipReason): void => {
    diag.logIssueSkipped(c.repo, c.number, reason);
    allBlockedDetails.push({
      repo: c.repo,
      issueNumber: c.number,
      milestone: c.milestone,
      reason,
    });
  };

  // Apply local cooldown filtering. Every tier gets the same treatment:
  // configured-label, work-on, self-scheduled diagnostics (Issue #505),
  // low-priority (Issue #1725) and idle-task (Issue #2006) alike — an issue
  // the worker just released must not be re-claimed straight away.
  const applyLocalCooldown = (
    candidates: IssueCandidate[],
  ): IssueCandidate[] => {
    if (!options.isIssueInCooldown) return candidates;
    return candidates.filter((c) => {
      const inCooldown = options.isIssueInCooldown!(c.repo, c.number);
      if (inCooldown) noteCooldown(c, "cooldown");
      return !inCooldown;
    });
  };

  const localFilteredLabel = applyLocalCooldown(allLabelCandidates);
  const localFilteredWorkOn = applyLocalCooldown(allWorkOnCandidates);
  const localFilteredSelfDiagnostic = applyLocalCooldown(
    allSelfDiagnosticCandidates,
  );
  const localFilteredLowPriority = applyLocalCooldown(allLowPriorityCandidates);
  const localFilteredIdleTask = applyLocalCooldown(allIdleTaskCandidates);

  // Issue #1087: Apply cross-worker cooldown filtering (supplementary to local)
  let filteredLabel = localFilteredLabel;
  let filteredWorkOn = localFilteredWorkOn;
  let filteredSelfDiagnostic = localFilteredSelfDiagnostic;
  let filteredLowPriority = localFilteredLowPriority;
  let filteredIdleTask = localFilteredIdleTask;

  if (options.hasCrossWorkerCooldown) {
    const crossWorkerFilter = async (
      candidates: IssueCandidate[],
    ): Promise<IssueCandidate[]> => {
      const result: IssueCandidate[] = [];
      for (const c of candidates) {
        const inCooldown = await options.hasCrossWorkerCooldown!(
          c.repo,
          c.number,
        );
        if (inCooldown) {
          noteCooldown(c, "cross-worker-cooldown");
        } else {
          result.push(c);
        }
      }
      return result;
    };

    filteredLabel = await crossWorkerFilter(localFilteredLabel);
    filteredWorkOn = await crossWorkerFilter(localFilteredWorkOn);
    filteredSelfDiagnostic = await crossWorkerFilter(
      localFilteredSelfDiagnostic,
    );
    filteredLowPriority = await crossWorkerFilter(localFilteredLowPriority);
    filteredIdleTask = await crossWorkerFilter(localFilteredIdleTask);
  }

  const selectionResult: SelectionResult = {
    selected: null,
    labelCandidates: filteredLabel,
    workOnCandidates: filteredWorkOn,
    selfDiagnosticCandidates: filteredSelfDiagnostic,
    blockedEntries: allBlocked,
    lowPriorityCandidates: filteredLowPriority,
    idleTaskCandidates: filteredIdleTask,
    // Issue #2164: per-repo suppression of low-priority/idle-task when
    // higher tiers have open issues that did not survive eligibility
    // filtering.
    reposWithOpenWorkOn,
    reposWithOpenLowPriority,
  };

  // Randomise among equal-priority candidates to reduce claim races
  // when multiple workers scan simultaneously (Issue #1089).
  // Tests may inject a deterministic randomFn via options.selectionOptions
  // (Issue #1725) — default to Math.random in production.
  const baseSelectionOptions: SelectionOptions = options.selectionOptions ?? {
    randomFn: Math.random,
    randomPoolSize: 3,
  };

  // Issue #2774 (part of #2771): make the final selection `nice`-aware by
  // wiring an operator-side repo→`nice` resolver (Issue #2772) into the
  // selection (Issue #2773). Fairness across repos now lives in *selection*,
  // not in the repo scan-order shuffle (`config.shuffleRepos`) — within a
  // single `nice` tier, equal repos rotate fairly. The earlier note in
  // `array_utils.ts` (shuffle controls scan order, selection is oldest-first)
  // is therefore outdated for fairness: selection draws the lowest-`nice`
  // non-empty tier first and only falls through to a higher-`nice` tier when
  // no lower tier yields a selectable candidate. A test-supplied `repoNice`
  // wins; otherwise resolve from `config.repoConfig` (defaults to `0`/neutral
  // for every repo when unset, preserving today's behaviour).
  const selectionOptions: SelectionOptions = {
    ...baseSelectionOptions,
    repoNice: baseSelectionOptions.repoNice ??
      ((repo: string) => getRepoNice(config.repoConfig, repo)),
  };
  const selected = selectHighestPriority(selectionResult, selectionOptions);

  if (selected) {
    diag.logFinalSelection(selected.repo, selected.number, selected.source);

    // Issue #1718: when a work-on candidate is selected and any
    // configured-label candidate was considered or blocked, emit a
    // structured selection-reasoning line so the user can see at a
    // glance why top-priority was passed over. Suppressed when a
    // configured-label was selected (avoids noise) or when no
    // configured-label candidates exist at all (no surprise).
    if (
      selected.source === "work-on" &&
      (configuredLabelConsidered > 0 || allBlockedDetails.length > 0)
    ) {
      diag.logSelectionReasoning(
        {
          repo: selected.repo,
          number: selected.number,
          source: selected.source,
        },
        configuredLabelConsidered,
        allBlockedDetails,
      );
    }
  }
  // Issue #219: the counts ride the result so a caller that gets nothing
  // back can say why, whether or not diagnostics are enabled.
  const diagnosticSummary = diag.getSummary();

  if (!selected) {
    // Issue #460: the reasons ride the result alongside the counts, so a
    // caller handed `found: false` can name the gate per issue instead of
    // asking a human to reconstruct it from an aggregate log line.
    return {
      ...noResult,
      diagnosticSummary,
      blockedDetails: allBlockedDetails,
    };
  }

  const stats = cache.getStats();
  // Issue #1671: include total `gh` call count alongside cache stats so
  // the existing log line gives a baseline for the reduce-gh-calls work.
  const ghMetrics = getGhCallMetrics();
  return {
    output: formatCandidateOutput(selected),
    found: true,
    summary: `Selected issue #${selected.number} from ${selected.repo} ` +
      `(cache: ${stats.hits} hits, ${stats.misses} misses, ` +
      `gh-calls: ${ghMetrics.total} total)`,
    diagnosticSummary,
    blockedDetails: allBlockedDetails,
  };
}
