/**
 * Issue diagnosis library (Issue #1063).
 *
 * Analyses a specific issue in a specific repo and reports exactly why
 * it would or would not be picked up by the worker. Each filtering check
 * from `findOldestIssue()` is run independently and reported as PASS/FAIL
 * with actionable suggestions.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import type { IssueFetcher } from "./issue_dependencies.ts";
import { isRepoAllowed } from "./config_validator.ts";
import { isMilestoneOccupied } from "./issue_filter.ts";
import {
  fetchAllIssues,
  fetchOpenPRsForFleet,
  getBlockingPRForIssue,
  wasLabelAddedByAllowedAuthor,
} from "./issue_query.ts";
import { checkRepoAvailability } from "./repo_availability.ts";
import type { RepoIssueInfo } from "./repo_availability.ts";
import {
  checkParentBlocked,
  extractDependencyReferences,
  normaliseIssueState,
} from "./issue_dependencies.ts";
import { runGhCommand } from "./github.ts";
import {
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
} from "./fleet_authors.ts";
import type { TimelineCache } from "./timeline_cache.ts";
import {
  validateGhIssueViewJson,
  validateIssueBodyJson,
  validateIssueStateJson,
} from "./validation.ts";

/**
 * Result of a single diagnostic check.
 */
export interface DiagnosticCheck {
  /** Short name for the check. */
  name: string;
  /** Whether the check passed (issue is eligible from this check's perspective). */
  passed: boolean;
  /** Human-readable explanation of the result. */
  detail: string;
  /** Actionable suggestion when the check fails. */
  suggestion?: string;
}

/**
 * Full diagnostic report for an issue.
 */
export interface DiagnosticReport {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number. */
  issueNumber: number;
  /** Issue title (if fetchable). */
  issueTitle: string;
  /** Individual check results. */
  checks: DiagnosticCheck[];
  /** Overall verdict: would the issue be picked up? */
  wouldBePickedUp: boolean;
}

/**
 * Options for diagnosing an issue.
 */
export interface DiagnoseOptions {
  /** GitHub username of the worker. */
  githubUser: string;
  /** Optional gh command function for testing. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Optional function to check if repo is deprioritised. */
  isRepoDeprioritised?: (repo: string) => boolean;
  /** Optional function to check if issue is in cooldown. */
  isIssueInCooldown?: (repo: string, issueNumber: number) => boolean;
  /**
   * Optional timeline cache for label-author timeline lookups (Issue #1673).
   */
  timelineCache?: TimelineCache;
}

/**
 * Fetch a single issue's data via the gh CLI.
 */
async function fetchIssueData(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<FilterableIssue | null> {
  try {
    const output = await ghFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "number,title,assignees,url,labels,createdAt,author,milestone",
    ]);
    const parsed: unknown = JSON.parse(output);
    const validated = validateGhIssueViewJson(parsed);
    if (!validated.ok) return null;
    const raw = validated.value;
    return {
      number: raw.number,
      title: raw.title,
      url: raw.url ?? "",
      author: raw.author?.login ?? "",
      assignees: (raw.assignees ?? []).map((a) => a.login),
      labels: (raw.labels ?? []).map((l) => l.name),
      createdAt: raw.createdAt ?? "",
      milestone: raw.milestone?.title ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Create an IssueFetcher from a gh command function.
 */
function createIssueFetcher(
  ghCommandFn: (args: string[]) => Promise<string>,
): IssueFetcher {
  return {
    async getIssueState(repo: string, issueNumber: number) {
      const output = await ghCommandFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        "number,state,title",
      ]);
      const parsed: unknown = JSON.parse(output);
      const validated = validateIssueStateJson(parsed);
      if (!validated.ok) {
        throw new Error(
          `Invalid issue state JSON (${validated.error.field}): ${validated.error.message}`,
        );
      }
      const v = validated.value;
      return {
        number: v.number,
        // Issue #3218: a merged PR reports `MERGED` — resolve it to CLOSED.
        state: normaliseIssueState(v.state),
        title: v.title,
      };
    },
    async getSubIssues(repo: string, issueNumber: number) {
      try {
        const output = await ghCommandFn([
          "api",
          `repos/${repo}/issues/${issueNumber}`,
        ]);
        const parsed: unknown = JSON.parse(output);
        const validated = validateIssueBodyJson(parsed);
        if (!validated.ok || !validated.value.body) return [];
        const { extractSubIssueReferences } = await import(
          "./issue_dependencies.ts"
        );
        return extractSubIssueReferences(validated.value.body, repo);
      } catch {
        return [];
      }
    },
    async getIssueBody(repo: string, issueNumber: number) {
      const output = await ghCommandFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        "body",
      ]);
      const parsed: unknown = JSON.parse(output);
      const validated = validateIssueBodyJson(parsed);
      if (!validated.ok) return "";
      return validated.value.body ?? "";
    },
  };
}

/**
 * Run all diagnostic checks on a specific issue.
 *
 * Each check mirrors a filtering condition in `findOldestIssue()` and
 * reports PASS or FAIL with an explanation and actionable suggestion.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number to diagnose
 * @param config - Worker configuration
 * @param options - Diagnosis options
 * @returns Full diagnostic report
 */
export async function diagnoseIssue(
  repo: string,
  issueNumber: number,
  config: WorkerConfig,
  options: DiagnoseOptions,
): Promise<DiagnosticReport> {
  const ghFn = options.ghCommandFn ?? runGhCommand;
  const checks: DiagnosticCheck[] = [];

  // Fetch issue data
  const issue = await fetchIssueData(repo, issueNumber, ghFn);
  if (!issue) {
    return {
      repo,
      issueNumber,
      issueTitle: "",
      checks: [{
        name: "issue-exists",
        passed: false,
        detail: `Could not fetch issue #${issueNumber} from ${repo}`,
        suggestion: "Check that the issue number and repository are correct",
      }],
      wouldBePickedUp: false,
    };
  }

  // 1. Repo in configured repos list
  const repoAllowed = isRepoAllowed(config.repos, repo);
  checks.push({
    name: "repo-allowed",
    passed: repoAllowed,
    detail: repoAllowed
      ? `${repo} is in the configured repos list`
      : `${repo} is NOT in the configured repos list`,
    suggestion: repoAllowed
      ? undefined
      : `Add "${repo}" to the repos array in .config.json`,
  });

  // 2. Repo deprioritised
  const isDeprioritised = options.isRepoDeprioritised?.(repo) ?? false;
  checks.push({
    name: "repo-not-deprioritised",
    passed: !isDeprioritised,
    detail: isDeprioritised
      ? `${repo} is deprioritised due to consecutive failures`
      : `${repo} is not deprioritised`,
    suggestion: isDeprioritised
      ? "Wait for the deprioritisation to expire, or fix the consecutive failures"
      : undefined,
  });

  // 3. Discovery label check
  // Issue #1834: build the discovery-label list from the three hardwired
  // constants (top-priority + work-on + low-priority) and dedup so the
  // diagnostic message lists each label exactly once. Previously the list
  // came from `[...config.issueLabels, config.workOnLabel]`, which double-
  // counted work-on whenever an admin's `issue_labels` override happened
  // to include it.
  const allDiscoveryLabels = Array.from(
    new Set<string>([
      ...config.issueLabels,
      config.workOnLabel,
      config.lowPriorityLabel,
    ]),
  );
  const matchingLabels = issue.labels.filter((l) =>
    allDiscoveryLabels.includes(l)
  );
  const hasDiscoveryLabel = matchingLabels.length > 0;
  checks.push({
    name: "has-discovery-label",
    passed: hasDiscoveryLabel,
    detail: hasDiscoveryLabel
      ? `Issue has discovery label(s): ${matchingLabels.join(", ")}`
      : `Issue has none of the required labels: ${
        allDiscoveryLabels.join(", ")
      }`,
    suggestion: hasDiscoveryLabel
      ? undefined
      : `Add one of these labels to the issue: ${
        allDiscoveryLabels.join(", ")
      }`,
  });

  // 4. Assigned check
  const isAssigned = issue.assignees.length > 0;
  checks.push({
    name: "not-assigned",
    passed: !isAssigned,
    detail: isAssigned
      ? `Issue is assigned to: ${issue.assignees.join(", ")}`
      : "Issue is not assigned",
    suggestion: isAssigned
      ? "Unassign the issue so the worker can pick it up"
      : undefined,
  });

  // 5. Blocking labels check
  // Issue #2031: needs-clarification retired — needs-human is the
  // single handoff label.
  const blockingLabels = [
    config.failedLabel,
    config.needsHumanLabel,
    config.refineIssueLabel,
    config.planningLabel,
    config.questionLabel,
    config.needsRevisionLabel,
  ];
  const presentBlockingLabels = issue.labels.filter((l) =>
    blockingLabels.includes(l)
  );
  const hasBlockingLabel = presentBlockingLabels.length > 0;
  checks.push({
    name: "no-blocking-labels",
    passed: !hasBlockingLabel,
    detail: hasBlockingLabel
      ? `Issue has blocking label(s): ${presentBlockingLabels.join(", ")}`
      : "Issue has no blocking labels",
    suggestion: hasBlockingLabel
      ? `Remove blocking label(s): ${presentBlockingLabels.join(", ")}`
      : undefined,
  });

  // 6. Milestone occupancy check
  let milestoneOccupied = false;
  try {
    const allIssues = await fetchAllIssues(repo, undefined, 100, ghFn);
    milestoneOccupied = isMilestoneOccupied(
      allIssues,
      issue.milestone,
      options.githubUser,
      config.allowedAuthors,
    );

    checks.push({
      name: "milestone-not-occupied",
      passed: !milestoneOccupied,
      detail: milestoneOccupied
        ? `Milestone "${issue.milestone}" already has a worker-assigned issue`
        : issue.milestone
        ? `Milestone "${issue.milestone}" has no worker-assigned issues`
        : "Issue has no milestone (not affected by milestone occupancy)",
      suggestion: milestoneOccupied
        ? `Wait for the worker's current work in milestone "${issue.milestone}" to complete`
        : undefined,
    });
  } catch {
    checks.push({
      name: "milestone-not-occupied",
      passed: true,
      detail: "Could not check milestone occupancy (assuming not occupied)",
    });
  }

  // 7. PR blocking check
  let prBlocked = false;
  let blockingPRDetail = "";
  try {
    // Issue #3100/#3138: widen the diagnostic open-PR guard to the whole
    // fleet so "why was this skipped" matches the discovery path
    // (find_oldest_issue). #3138: resolve the fleet author set via the shared
    // resolver so a sibling listed only in `fleetPrAuthors` is queried here
    // too, matching the guard's real inputs.
    const repoPRs = await fetchOpenPRsForFleet(
      repo,
      resolveFleetAuthors(
        options.githubUser,
        config.allowedAuthors,
        config.fleetPrAuthors ?? [],
      ),
      undefined,
      ghFn,
    );
    if (repoPRs.length > 0) {
      // Issue #4133: only the fleet's own open PRs block — a human's PR is
      // theirs to manage, so it never appears as a blocker here either.
      const blockingPR = getBlockingPRForIssue(
        repoPRs,
        issue.milestone,
        resolveFleetMaintenanceAuthorSet({
          githubUser: options.githubUser,
          fleetPrAuthors: config.fleetPrAuthors ?? [],
        }),
      );
      if (blockingPR) {
        prBlocked = true;
        blockingPRDetail = `PR #${blockingPR.number} ("${blockingPR.title}")`;
      }
    }
    checks.push({
      name: "no-blocking-pr",
      passed: !prBlocked,
      detail: prBlocked
        ? `Issue is blocked by open ${blockingPRDetail}`
        : "No blocking PRs found",
      suggestion: prBlocked
        ? `Merge or close the blocking ${blockingPRDetail}`
        : undefined,
    });
  } catch {
    checks.push({
      name: "no-blocking-pr",
      passed: true,
      detail: "Could not check PR blocking (assuming not blocked)",
    });
  }

  // 8. Dependency blocking check
  let depBlocked = false;
  let depBlockDetail = "";
  try {
    const fetcher = createIssueFetcher(ghFn);
    const parentResult = await checkParentBlocked(fetcher, repo, issueNumber);
    if (parentResult.ok && parentResult.value.isBlocked) {
      depBlocked = true;
      const openRefs = parentResult.value.openChildren.map((n) => `#${n}`).join(
        ", ",
      );
      depBlockDetail = `blocked by open sub-issue(s): ${openRefs}`;
    }

    if (!depBlocked) {
      const body = await fetcher.getIssueBody(repo, issueNumber);
      const deps = extractDependencyReferences(body);
      for (const dep of deps) {
        try {
          const depState = await fetcher.getIssueState(repo, dep);
          if (depState.state === "OPEN") {
            depBlocked = true;
            depBlockDetail = `depends on #${dep} ("${
              depState.title ?? ""
            }") which is OPEN`;
            break;
          }
        } catch {
          depBlocked = true;
          depBlockDetail = `depends on #${dep} (could not verify state)`;
          break;
        }
      }
    }

    checks.push({
      name: "not-dependency-blocked",
      passed: !depBlocked,
      detail: depBlocked
        ? `Issue is ${depBlockDetail}`
        : "Issue has no unresolved dependencies",
      suggestion: depBlocked
        ? depBlockDetail.includes("sub-issue")
          ? "Close the open sub-issues first, or remove the parent/child relationship"
          : "Close the blocking dependency first, or remove the dependency reference"
        : undefined,
    });
  } catch {
    checks.push({
      name: "not-dependency-blocked",
      passed: true,
      detail: "Could not check dependencies (assuming not blocked)",
    });
  }

  // 9. Cooldown check
  const inCooldown = options.isIssueInCooldown?.(repo, issueNumber) ?? false;
  checks.push({
    name: "not-in-cooldown",
    passed: !inCooldown,
    detail: inCooldown
      ? "Issue is currently in cooldown"
      : "Issue is not in cooldown",
    suggestion: inCooldown
      ? "Wait for the cooldown period to expire"
      : undefined,
  });

  // 10. Work-on label author check (only relevant if issue has work-on label)
  const hasWorkOnLabel = issue.labels.includes(config.workOnLabel);
  if (hasWorkOnLabel) {
    let authorAllowed = false;
    try {
      authorAllowed = await wasLabelAddedByAllowedAuthor(
        repo,
        issueNumber,
        config.workOnLabel,
        config.allowedAuthors,
        ghFn,
        options.timelineCache,
      );
    } catch {
      // If we can't check, report as failed
    }
    checks.push({
      name: "work-on-author-allowed",
      passed: authorAllowed,
      detail: authorAllowed
        ? `The "${config.workOnLabel}" label was added by an allowed author`
        : `The "${config.workOnLabel}" label was NOT added by an allowed author (allowed: ${
          config.allowedAuthors.join(", ")
        })`,
      suggestion: authorAllowed
        ? undefined
        : `Have an allowed author (${
          config.allowedAuthors.join(", ")
        }) add the "${config.workOnLabel}" label`,
    });
  } else {
    checks.push({
      name: "work-on-author-allowed",
      passed: true,
      detail:
        `Issue does not have the "${config.workOnLabel}" label (author check not applicable)`,
    });
  }

  // 11. Repo availability (milestone-aware)
  try {
    const allIssues = await fetchAllIssues(repo, undefined, 100, ghFn);
    const repoIssueInfos: RepoIssueInfo[] = allIssues.map((i) => ({
      number: i.number,
      milestone: i.milestone,
      assignees: i.assignees,
    }));
    const availability = checkRepoAvailability(
      repoIssueInfos,
      options.githubUser,
    );
    checks.push({
      name: "repo-available",
      passed: availability.hasAvailableWork,
      detail: availability.hasAvailableWork
        ? `Repo has ${availability.availableStreams.length} available work stream(s)`
        : `All ${availability.totalStreams} work stream(s) are occupied`,
      suggestion: availability.hasAvailableWork
        ? undefined
        : "Wait for current work to complete, or unassign issues in occupied streams",
    });
  } catch {
    checks.push({
      name: "repo-available",
      passed: true,
      detail: "Could not check repo availability (assuming available)",
    });
  }

  const wouldBePickedUp = checks.every((c) => c.passed);

  return {
    repo,
    issueNumber,
    issueTitle: issue.title,
    checks,
    wouldBePickedUp,
  };
}

/**
 * Format a diagnostic report as a human-readable string.
 *
 * @param report - The diagnostic report to format
 * @returns Formatted string with PASS/FAIL indicators
 */
export function formatDiagnosticReport(report: DiagnosticReport): string {
  const lines: string[] = [];

  lines.push(`=== Diagnostic Report: ${report.repo}#${report.issueNumber} ===`);
  if (report.issueTitle) {
    lines.push(`Title: ${report.issueTitle}`);
  }
  lines.push("");

  for (const check of report.checks) {
    const status = check.passed ? "PASS" : "FAIL";
    lines.push(`[${status}] ${check.name}: ${check.detail}`);
    if (!check.passed && check.suggestion) {
      lines.push(`       → ${check.suggestion}`);
    }
  }

  lines.push("");
  const passCount = report.checks.filter((c) => c.passed).length;
  const totalCount = report.checks.length;
  lines.push(`Result: ${passCount}/${totalCount} checks passed`);

  if (report.wouldBePickedUp) {
    lines.push("Verdict: Issue WOULD be picked up by the worker");
  } else {
    lines.push("Verdict: Issue would NOT be picked up by the worker");
  }

  return lines.join("\n");
}
