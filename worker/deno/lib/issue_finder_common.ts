/**
 * Shared types and helpers for the issue-finding entry points.
 *
 * Used by `find_oldest_issue.ts`, `find_issues_by_label.ts`, and
 * `find_planning_issues.ts`. Holds the public option/result types,
 * a few pure utility functions, and the GitHub `IssueFetcher` adapter
 * used by dependency-blocking checks.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { IssueCache } from "./issue_cache.ts";
import type { TimelineCache } from "./timeline_cache.ts";
import type { TimelineBatchRegistry } from "./timeline_batch_registry.ts";
import type {
  BlockedCandidateInfo,
  DiagnosticSummary,
  IssueFinderDiagnostics,
} from "./issue_finder_logger.ts";
import type { ContentApprovalDeps } from "./content_approval_tracker.ts";
import type { EscalateUnworkableDeps } from "./escalate_unworkable_work_on.ts";
import type { SelectionOptions } from "./issue_priority.ts";
import { classifyGitHubError, GitHubErrorCategory } from "./github_errors.ts";
import {
  checkParentBlocked,
  extractDependencyReferencesDetailed,
  normaliseIssueState,
} from "./issue_dependencies.ts";
import type {
  IssueFetcher,
  IssueState,
  OpenIssueStateMap,
} from "./issue_dependencies.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import type { InFlightClaim } from "./work_stream.ts";

/**
 * Options for the issue finder.
 */
export interface FindIssuesOptions {
  /** GitHub username of the worker */
  githubUser: string;
  /** Optional gh command function for testing */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Optional cache instance */
  cache?: IssueCache;
  /**
   * Optional timeline cache instance (Issue #1673). When provided,
   * `wasLabelAddedByAllowedAuthor` and `getLabelLastAddInfo` resolve
   * from the file-backed TTL cache before issuing a `gh api timeline`
   * call.
   */
  timelineCache?: TimelineCache;
  /**
   * Optional iteration-scoped batch registry (Issue #1783). When
   * provided, candidate collectors share a single in-memory map of
   * fetched timelines so the same issue is never fetched twice within
   * one iteration. Reset by the main loop at the iteration boundary.
   */
  timelineBatchRegistry?: TimelineBatchRegistry;
  /** Optional function to check if repo is deprioritised */
  isRepoDeprioritised?: (repo: string) => boolean;
  /**
   * Repositories leased **wholesale** on this host (Issue #4176, narrowed by
   * Issue #1091) — the maintenance lane's leases (Issue #213), whose pass
   * may touch any branch of the clone. Skipped entirely, before any
   * eligibility check runs. Absent/empty: unchanged serial behaviour.
   *
   * A sibling *slot*'s hold is deliberately **not** here. It occupies one
   * work stream, and the stream is excluded through {@link
   * FindIssuesOptions.inFlightClaims} so the scan's own occupancy check
   * refuses it — keying this by repository collapsed a repository's parallel
   * milestones into one and idled a slot for 14 minutes with 29 claimable
   * issues in front of it.
   */
  excludeRepos?: ReadonlySet<string>;
  /**
   * Every issue a slot on this host currently holds, with the work stream it
   * occupies (Issue #1091).
   *
   * Overlaid onto each repository's fetched issue list before any
   * availability or occupancy check, so `isMilestoneOccupied` sees a claim
   * the iteration-scoped `IssueCache` predates. One mechanism, not two: the
   * scan's existing per-stream gate simply stops being lied to.
   */
  inFlightClaims?: readonly InFlightClaim[];
  /** Optional function to check if issue is in cooldown */
  isIssueInCooldown?: (repo: string, issueNumber: number) => boolean;
  /**
   * Optional async function to check cross-worker cooldown via GitHub comments.
   * Issue #1087: Supplementary to local cooldown — catches cases where
   * a different worker on another machine failed on this issue.
   */
  hasCrossWorkerCooldown?: (
    repo: string,
    issueNumber: number,
  ) => Promise<boolean>;
  /** Optional diagnostics instance for pipeline logging (Issue #1062) */
  diagnostics?: IssueFinderDiagnostics;
  /** Optional content approval deps for testing (Issue #1341) */
  contentApprovalDeps?: ContentApprovalDeps;
  /**
   * Optional injectable deps for unworkable-work-on escalation (Issue
   * #2752). Mainly used by tests to inject a recording GitHub client,
   * a hermetic `ensureLabelExists`, or a fixed clock. In production the
   * escalation routes through the iteration's `ghCommandFn`.
   */
  escalateDeps?: EscalateUnworkableDeps;
  /**
   * Cooldown in seconds for recently-closed PR blocking (Issue #1427).
   * Issues with a PR closed within this window are skipped to prevent
   * duplicate PR creation. Default: 3600 (1 hour).
   */
  closedPrCooldownSeconds?: number;
  /**
   * The PR-maintenance scan author set, as the scans themselves resolve
   * it (Issue #4024).
   *
   * Supplied by the production wiring so the finder can check the fleet
   * invariant — *every open PR the blocking guard can return must be in
   * the PR-maintenance scan set* — once per iteration, and report
   * `inMaintenanceSet` on each blocking PR. When omitted it defaults to
   * the blocking-guard set (no divergence), preserving prior behaviour
   * for callers that do not run maintenance scans.
   */
  maintenanceAuthors?: string[];
  /**
   * Optional override for the priority-tier selection options
   * (Issue #1089/#1725). Mainly used by tests to inject a deterministic
   * `randomFn` so multi-candidate scenarios produce predictable output.
   * In production, defaults to `{ randomFn: Math.random, randomPoolSize: 3 }`.
   */
  selectionOptions?: SelectionOptions;
}

/**
 * Result of an issue search.
 */
export interface FindIssuesResult {
  /** The selected issue in pipe-delimited format, or empty string */
  output: string;
  /** Whether an issue was found */
  found: boolean;
  /** Summary for logging */
  summary: string;
  /**
   * Counts collected while scanning (Issue #219). Present whenever the
   * finder actually scanned, so a caller that receives `found: false` can
   * state how many issues were considered, how many were eligible, and
   * which skip reasons dominated — the diagnostics themselves stay gated
   * behind `ISSUE_FINDER_DEBUG`, but these counts do not.
   */
  diagnosticSummary?: DiagnosticSummary;
  /**
   * Per-issue skip reasons collected while scanning (Issue #460).
   *
   * `diagnosticSummary` carries the aggregate counts; this carries the
   * detail behind them, so a caller can say *which* issue was refused and
   * *why*. GRQ#4465 asked a human to work that out from a log that only ever
   * printed the top three aggregate reasons. Same rationale as the counts in
   * Issue #219: the detail rides the result, whether or not the
   * `ISSUE_FINDER_DEBUG` diagnostics are enabled.
   */
  blockedDetails?: BlockedCandidateInfo[];
}

/** Check whether an error represents a GitHub API rate limit. */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return classifyGitHubError(msg).category === GitHubErrorCategory.RateLimit;
}

/**
 * Wrap an {@link IssueFetcher} so each issue's body, sub-issues, and state
 * are fetched at most once per the wrapper's lifetime (Issue #2752).
 *
 * `collectWorkOnCandidates` consults the same per-issue data from two places
 * — the dependency-cycle graph build and the dependency-blocking gate
 * (`isDependencyBlocked`, which itself reads the body twice). Memoising by
 * issue number collapses those repeated reads to a single `gh` call each,
 * keeping the cycle-detection feature cost-neutral (and actually trimming the
 * pre-existing double body read). Promises are cached so concurrent callers
 * share one in-flight request.
 */
export function memoiseIssueFetcher(fetcher: IssueFetcher): IssueFetcher {
  const bodyCache = new Map<string, Promise<string>>();
  const subCache = new Map<string, Promise<number[]>>();
  const stateCache = new Map<string, Promise<IssueState>>();
  // Issue #222: keyed by repo AND number. A cross-repo dependency
  // (`Depends on owner/repo#560`) is now resolved against its own repo, so a
  // number-only key would serve another repository's #560 from this repo's
  // entry.
  const key = (repo: string, issueNumber: number) =>
    `${repo.trim().toLowerCase()}#${issueNumber}`;
  return {
    getIssueState(repo: string, issueNumber: number) {
      const k = key(repo, issueNumber);
      let p = stateCache.get(k);
      if (!p) {
        p = fetcher.getIssueState(repo, issueNumber);
        stateCache.set(k, p);
      }
      return p;
    },
    getSubIssues(repo: string, issueNumber: number) {
      const k = key(repo, issueNumber);
      let p = subCache.get(k);
      if (!p) {
        p = fetcher.getSubIssues(repo, issueNumber);
        subCache.set(k, p);
      }
      return p;
    },
    getIssueBody(repo: string, issueNumber: number) {
      const k = key(repo, issueNumber);
      let p = bodyCache.get(k);
      if (!p) {
        p = fetcher.getIssueBody(repo, issueNumber);
        bodyCache.set(k, p);
      }
      return p;
    },
  };
}

/**
 * Create an IssueFetcher from a gh command function.
 */
export function createIssueFetcher(
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
      const parsed = JSON.parse(output) as {
        number: number;
        state: string;
        title: string;
      };
      return {
        number: parsed.number,
        // Issue #3218: a dependency reference can be a PR number; a merged PR
        // reports `MERGED`, which must resolve to CLOSED (not OPEN).
        state: normaliseIssueState(parsed.state),
        title: parsed.title,
      };
    },
    async getSubIssues(repo: string, issueNumber: number) {
      // Issue #2470: query the native GitHub sub-issues API rather than
      // parsing the issue body. Parsing the body re-derived the same
      // task-list references that `checkParentBlocked` already extracts,
      // which bypassed the `hasBackReference` guard (FLEET#1472) and
      // mis-blocked work-on issues whose body contained a plain
      // `- [ ] #N` acceptance-criteria checkbox. The native endpoint
      // returns only genuine sub-issues (and `[]` when there are none),
      // so the body path keeps running with its back-reference check.
      try {
        const output = await ghCommandFn([
          "api",
          `repos/${repo}/issues/${issueNumber}/sub_issues`,
        ]);
        const parsed = JSON.parse(output) as Array<{ number?: number }>;
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((sub) => sub.number)
          .filter((n): n is number => typeof n === "number");
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
      const parsed = JSON.parse(output) as { body?: string };
      return parsed.body ?? "";
    },
  };
}

/**
 * Build an `OpenIssueStateMap` from the cached open-issues list
 * (Issue #1808). Pass-through: callers that already hold the
 * `repoAllIssues` array can reuse it without reissuing
 * `fetchAllIssues`.
 */
export function buildOpenIssueStateMap(
  repoAllIssues: FilterableIssue[],
): OpenIssueStateMap {
  const map: OpenIssueStateMap = new Map();
  for (const issue of repoAllIssues) {
    map.set(issue.number, "OPEN");
  }
  return map;
}

/**
 * Check if an issue is blocked by dependencies or sub-issues.
 *
 * Issue #1808: when `openStateMap` is supplied, child-issue and
 * forward-dependency state lookups resolve from the local map first;
 * misses fall back to the per-issue fetcher path.
 */
export async function isDependencyBlocked(
  repo: string,
  issueNumber: number,
  fetcher: IssueFetcher,
  openStateMap?: OpenIssueStateMap,
): Promise<boolean> {
  try {
    // Check parent/child blocking
    const parentResult = await checkParentBlocked(
      fetcher,
      repo,
      issueNumber,
      openStateMap,
    );
    if (parentResult.ok && parentResult.value.isBlocked) {
      return true;
    }

    // Check forward dependencies. Issue #222: a cross-repo reference
    // (`Depends on owner/repo#N`) is resolved against *its own* repo — the
    // form the blocked-run deferral writes — while a bare `#N` stays this
    // repo's issue and keeps using the cached open-state map.
    const body = await fetcher.getIssueBody(repo, issueNumber);
    const deps = extractDependencyReferencesDetailed(body);
    for (const dep of deps) {
      const depRepo = dep.repo ?? repo;
      const isSameRepo = depRepo.trim().toLowerCase() === repo.trim()
        .toLowerCase();
      // Map hit → still open; immediate block.
      if (isSameRepo && openStateMap?.has(dep.number)) {
        return true;
      }
      try {
        const depState = await fetcher.getIssueState(depRepo, dep.number);
        if (depState.state === "OPEN") return true;
      } catch {
        // If we can't check, assume blocked (fail safe)
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}
