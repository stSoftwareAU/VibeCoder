/**
 * Find planning issues with comment-based fallback detection (Issue #977).
 *
 * Primary path delegates to `findIssuesByLabel` to discover issues
 * carrying the configured planning label. If none are found, falls
 * back to scanning open unassigned issues for escalation comment
 * headings posted by `escalateToPlanning()` or claim-churn detection.
 * Issue #1476: the fallback only reports detection — it does not
 * programmatically add the planning label.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import { runGhCommand } from "./github.ts";
import { IssueCache } from "./issue_cache.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import { detectPlanningEscalationInComments } from "./label_planning_escalation.ts";
import { fetchAllIssues } from "./issue_query.ts";
import {
  formatCandidateOutput,
  type IssueCandidate,
  orderCandidatesByNiceTier,
  type SelectionOptions,
} from "./issue_priority.ts";
import { extractMilestonePriority } from "./milestone_priority.ts";
import { getRepoNice } from "./repo_config.ts";
import { isRepoAllowed } from "./config_validator.ts";
import {
  type FindIssuesOptions,
  type FindIssuesResult,
  isRateLimitError,
} from "./issue_finder_common.ts";
import { shuffleArray } from "./array_utils.ts";
import { findIssuesByLabel } from "./find_issues_by_label.ts";

/**
 * Find planning issues with comment-based fallback detection.
 *
 * @param config - Worker configuration
 * @param options - Search options
 * @returns Search result (same format as findIssuesByLabel)
 */
export async function findPlanningIssuesWithFallback(
  config: WorkerConfig,
  options: FindIssuesOptions,
): Promise<FindIssuesResult> {
  // Primary path: find issues with the planning label
  const labelResult = await findIssuesByLabel(
    config,
    config.planningLabel,
    true,
    options,
  );

  if (labelResult.found) {
    return labelResult;
  }

  // Fallback: scan for escalation comments on issues without the label
  const ghFn = options.ghCommandFn ?? runGhCommand;
  const cache = options.cache ?? new IssueCache();
  const candidates: IssueCandidate[] = [];

  const repos = config.shuffleRepos
    ? shuffleArray([...config.repos])
    : [...config.repos];

  for (const repo of repos) {
    if (!isRepoAllowed(config.repos, repo)) continue;

    let issues: FilterableIssue[];
    try {
      issues = await fetchAllIssues(repo, cache, 100, ghFn);
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      continue;
    }

    // Only check unassigned issues without the planning label.
    // Issue #999: Do NOT pre-filter by failed label here — churn-escalated
    // issues have the failed label but should still be found via their
    // escalation comment. The comment check below is the actual gate.
    // Issue #1874: also exclude `needs-human` so the comment-fallback
    // path matches the primary `findIssuesByLabel` path. Without this
    // filter, an issue handed back to a human (with `needs-human`) but
    // also carrying a planning-escalation comment could be re-surfaced.
    issues = issues.filter((i) =>
      i.assignees.length === 0 &&
      !i.labels.includes(config.planningLabel) &&
      !i.labels.includes(config.needsHumanLabel)
    );

    for (const issue of issues) {
      let commentsText: string;
      try {
        commentsText = await ghFn([
          "issue",
          "view",
          String(issue.number),
          "--repo",
          repo,
          "--json",
          "comments",
          "--jq",
          '[.comments[].body] | join("\\n")',
        ]);
      } catch {
        continue;
      }

      if (!detectPlanningEscalationInComments(commentsText)) {
        continue;
      }

      // Issue #1476: Do NOT add the planning label programmatically. The
      // planning label is operational — a trusted human must add it to
      // confirm escalation. The escalation comment stands alone as the
      // human-facing signal; this fallback only reports detection.
      console.log(
        `[issue_finder] Planning escalation comment detected on ${repo}#${issue.number} — waiting for a trusted human to add the '${config.planningLabel}' label.`,
      );

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
    return {
      output: "",
      found: false,
      summary: `No planning issues found (label or comment fallback)`,
    };
  }

  // Issue #2775: mirror the primary `findIssuesByLabel` path — order
  // `nice`-tier ascending first, then within-tier fair / oldest, so the
  // comment-fallback path surfaces the same `nice`-correct first candidate.
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
    summary:
      `Found ${ordered.length} planning issue(s) via comment fallback (Issue #977)`,
  };
}
