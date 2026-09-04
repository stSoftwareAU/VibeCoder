/**
 * Find issues across configured repositories that carry a specific label.
 *
 * Used by refinement, planning, and question workflows. Honours
 * allowed-author checks, local cooldowns, and cross-worker cooldowns.
 * Returns candidates sorted oldest-first.
 *
 * New-work gating (Issue #937): the label routes that *answer* an issue —
 * `planning`, `question`, `refine-issue`, `grill-me` — remove their own label
 * when they finish, so re-dispatch is self-limiting and they need no further
 * gate. A route that *raises a pull request* has no such stop: the label
 * stays on the issue, `unassign_on_pr_created` unassigns it, and the next
 * cycle re-runs the whole implementation pipeline against the open PR. Such a
 * route opts in with `gateNewWork`, which applies the same eligibility gates
 * `work-on` gets through `lib/new_work_eligibility.ts`.
 *
 * Authorship gate (Issue #3083): for operational dispatch labels
 * (planning/question/refine-issue/grill-me/needs-revision, plus the operator's
 * `custom_label_prompts` labels — Issue #847) the label *adder* must always be
 * on the allowlist — these labels drive privileged automation phases, so a
 * trusted issue author alone is not enough (AND semantics). For any other label
 * the original OR semantics apply: the issue author or the label adder must be
 * in the allowlist.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import { runGhCommand } from "./github.ts";
import { IssueCache } from "./issue_cache.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import {
  fetchIssuesByLabel,
  wasLabelAddedByAllowedAuthor,
} from "./issue_query.ts";
import { buildBatchedGh } from "./timeline_batch.ts";
import {
  formatCandidateOutput,
  type IssueCandidate,
  orderCandidatesByNiceTier,
  type SelectionOptions,
} from "./issue_priority.ts";
import { extractMilestonePriority } from "./milestone_priority.ts";
import { getRepoNice } from "./repo_config.ts";
import { isRepoAllowed } from "./config_validator.ts";
import { requiresLabelAdderTrust } from "./operational_dispatch_labels.ts";
import { resolveFleetAuthors } from "./fleet_authors.ts";
import {
  type FindIssuesOptions,
  type FindIssuesResult,
  isRateLimitError,
} from "./issue_finder_common.ts";
import {
  buildNewWorkGateContext,
  filterNewWorkEligible,
} from "./new_work_eligibility.ts";
import type { BlockedCandidateInfo } from "./issue_finder_logger.ts";
import { shuffleArray } from "./array_utils.ts";

/**
 * Options for {@link findIssuesByLabel}.
 *
 * Extends the shared finder options with the opt-in gating switch, which is
 * meaningful only on this entry point — `findOldestIssue` gates
 * unconditionally through its candidate collectors.
 */
export interface FindIssuesByLabelOptions extends FindIssuesOptions {
  /**
   * Apply the `work-on` new-work eligibility gates to this scan
   * (Issue #937).
   *
   * Opt-in, and required of every label route that raises a pull request:
   * issues carrying a blocking label (`failed` among them) are dropped, and
   * each survivor must clear milestone occupancy, the closed/merged-PR
   * block, the open-PR block and dependency blocking before it is
   * dispatched. Left unset the scan behaves exactly as it did, which is what
   * the label-removing routes want.
   */
  gateNewWork?: boolean;
}

/**
 * Find issues by a specific label across all configured repositories.
 *
 * @param config - Worker configuration
 * @param label - Label to search for
 * @param filterFailed - Whether to filter out issues with the failed label.
 *   Implied by `options.gateNewWork`, which drops every blocking label
 *   (Issue #937)
 * @param options - Search options
 * @returns Array of formatted candidate strings (one per line)
 */
export async function findIssuesByLabel(
  config: WorkerConfig,
  label: string,
  filterFailed: boolean,
  options: FindIssuesByLabelOptions,
): Promise<FindIssuesResult> {
  const ghFn = options.ghCommandFn ?? runGhCommand;
  const cache = options.cache ?? new IssueCache();

  const noResult: FindIssuesResult = {
    output: "",
    found: false,
    summary: `No issues found with label '${label}'`,
  };

  if (config.repos.length === 0) {
    return noResult;
  }

  const repos = config.shuffleRepos
    ? shuffleArray([...config.repos])
    : [...config.repos];

  const candidates: IssueCandidate[] = [];
  /** Issue #937: one entry per issue a gate refused, and which gate. */
  const blockedDetails: BlockedCandidateInfo[] = [];

  // Issue #3083: operational dispatch labels (planning/question/refine-issue/
  // grill-me/needs-revision) drive privileged automation phases. For these the
  // label *adder* must always be on the allowlist — a trusted issue author is
  // not sufficient. Otherwise a non-allowlisted triage collaborator could
  // apply an operational label to a trusted-authored issue and steer the
  // worker into a privileged phase (broken access control, A01:2025).
  const strictLabelAdderCheck = requiresLabelAdderTrust(config, label);

  // Issue #3416: exclude fleet worker logins (own host + siblings) from the
  // label-adder trust set. In a fleet the worker's own login is required in
  // allowedAuthors for PR-dedup (#3138), so without this a reserved discovery
  // label (`top-priority`, `work-on`, …) a worker self-applied directly would
  // be honoured instead of stripped — mirroring the operational-label backstop
  // (verifyOperationalLabels, #3225).
  const fleetWorkerLogins = resolveFleetAuthors(
    options.githubUser,
    [],
    config.fleetPrAuthors,
  );

  for (const repo of repos) {
    if (!isRepoAllowed(config.repos, repo)) continue;

    let issues: FilterableIssue[];
    try {
      issues = await fetchIssuesByLabel(repo, label, cache, 50, ghFn);
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      continue;
    }

    // Issue #937: a gated scan leaves this to `filterAndSort`, which runs
    // *after* `cleanStaleLabels` has shed the stale `failed` label a reopened
    // issue still carries — filtering here first would strand it.
    if (filterFailed && !options.gateNewWork) {
      issues = issues.filter((i) => !i.labels.includes(config.failedLabel));
    }

    // Filter out assigned issues
    issues = issues.filter((i) => i.assignees.length === 0);

    // Issue #1874: skip issues that carry `needs-human`. The worker
    // applies this label after posting a grill-me round (and other
    // hand-back paths) so the developer's reply is the turn signal.
    // Without this filter the discovery path re-surfaces the same
    // issue on the next iteration — Round N+1 fires before the
    // developer has finished replying. Mirrors the equivalent
    // exclusion in `filterAndSort` (Issue #1470) used by
    // `findOldestIssue` and `collectLabelCandidates`.
    issues = issues.filter((i) => !i.labels.includes(config.needsHumanLabel));

    // Issue #1674: batch-fetch timelines for any issue that may need
    // a label-author check, so per-issue REST calls collapse into
    // one GraphQL call per repo.
    //
    // Issue #1783: When an iteration-scoped registry is supplied,
    // route the batch through it so overlapping issue numbers across
    // the four candidate collectors are fetched at most once per
    // iteration.
    const needsCheck = issues.filter(
      (i) =>
        // Issue #3083: for operational dispatch labels every issue needs the
        // label-author check, so pre-fetch the timeline for all of them.
        strictLabelAdderCheck ||
        !config.allowedAuthors.some(
          (a) => a.toLowerCase() === i.author.toLowerCase(),
        ),
    );
    // Issue #937: a gated scan asks the timeline for every survivor too —
    // the closed-PR re-label escape hatch and the `ignore-open-prs` check
    // both read it — so batch the whole set rather than issuing REST calls
    // per issue behind the gates.
    const needsCheckNumbers = options.gateNewWork
      ? issues.map((i) => i.number)
      : needsCheck.map((i) => i.number);
    const batchedGh = options.timelineBatchRegistry
      ? await options.timelineBatchRegistry.getBatchedGh(
        repo,
        needsCheckNumbers,
        ghFn,
      )
      : await buildBatchedGh(repo, needsCheckNumbers, ghFn);

    const trusted: FilterableIssue[] = [];

    for (const issue of issues) {
      // Check author or label authorship
      const authorAllowed = config.allowedAuthors.some(
        (a) => a.toLowerCase() === issue.author.toLowerCase(),
      );

      // Issue #3083: operational dispatch labels demand label-adder trust
      // unconditionally (AND); other labels keep the original OR semantics
      // (trusted author OR trusted label adder).
      if (strictLabelAdderCheck || !authorAllowed) {
        const labelAdded = await wasLabelAddedByAllowedAuthor(
          repo,
          issue.number,
          label,
          config.allowedAuthors,
          batchedGh,
          options.timelineCache,
          fleetWorkerLogins,
        );
        if (!labelAdded) continue;
      }

      trusted.push(issue);
    }

    // Issue #937: a PR-producing label route runs the same eligibility gates
    // `work-on` runs, so an issue whose PR is still open is not dispatched
    // again and a failing one cools down. The label-removing routes opt out
    // and keep their historical behaviour.
    let eligible = trusted;
    if (options.gateNewWork && trusted.length > 0) {
      const gateContext = await buildNewWorkGateContext(
        repo,
        config,
        options,
        batchedGh,
      );
      const verdict = await filterNewWorkEligible(trusted, label, gateContext);
      eligible = verdict.eligible;
      blockedDetails.push(...verdict.blocked);
    }

    for (const issue of eligible) {
      candidates.push({
        repo,
        number: issue.number,
        url: issue.url,
        title: issue.title,
        milestone: issue.milestone,
        createdAt: issue.createdAt,
        labelIndex: 0,
        source: "configured-label",
        milestonePriority: extractMilestonePriority(issue.labels),
      });
    }
  }

  // Apply local cooldown filtering
  let filtered = options.isIssueInCooldown
    ? candidates.filter((c) => !options.isIssueInCooldown!(c.repo, c.number))
    : candidates;

  // Issue #1087: Apply cross-worker cooldown filtering
  if (options.hasCrossWorkerCooldown && filtered.length > 0) {
    const crossFiltered: IssueCandidate[] = [];
    for (const c of filtered) {
      const inCooldown = await options.hasCrossWorkerCooldown(c.repo, c.number);
      if (!inCooldown) crossFiltered.push(c);
    }
    filtered = crossFiltered;
  }

  if (filtered.length === 0) {
    return blockedDetails.length > 0
      ? { ...noResult, blockedDetails }
      : noResult;
  }

  // Issue #2775: order `nice`-tier ascending first, then within-tier fair /
  // oldest, so the first emitted candidate (the one dispatch consumes) is the
  // `nice`-correct, within-tier-fair choice. The repo→`nice` lookup comes from
  // operator-side `config.repoConfig` via the #2772 resolver.
  const selectionOptions: SelectionOptions = {
    ...options.selectionOptions,
    randomFn: options.selectionOptions?.randomFn ?? Math.random,
    repoNice: (repo: string) => getRepoNice(config.repoConfig, repo),
  };
  const ordered = orderCandidatesByNiceTier(filtered, selectionOptions);
  const output = ordered.map(formatCandidateOutput).join("\n");

  return {
    output,
    found: true,
    summary: `Found ${ordered.length} issue(s) with label '${label}'`,
    ...(blockedDetails.length > 0 ? { blockedDetails } : {}),
  };
}
