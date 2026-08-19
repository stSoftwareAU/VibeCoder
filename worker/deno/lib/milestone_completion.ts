/**
 * Milestone completion detection and tracking issue/PR creation.
 *
 * When all issues in a milestone are completed (closed), this module:
 * 1. Creates a tracking issue titled "Merge milestone '<name>' to <default>"
 * 2. Creates a summary PR from the milestone branch to the default branch
 *
 * Replaces the deleted worker/shared/milestone_completion.sh (Issue #970).
 * Issue #1106: Regression — this Deno replacement was never created.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import {
  evaluateWorkerIdentity,
  IdentityGuardError,
  readHostname,
} from "./identity_guard.ts";
import type { IssueCache } from "./issue_cache.ts";
import { isIdleTaskMilestone } from "./idle_task_merge_gate.ts";
import {
  fetchAuthoritativeOpenChildren,
  formatChildNumbers,
  isMilestoneTrackingTitle,
} from "./milestone_open_children.ts";
import {
  fetchAllStateIssuesByMilestone,
  fetchAllStatePRsByBranch,
  fetchClosedIssuesByMilestone,
  fetchOpenIssuesByMilestone,
  invalidateAllStateIssuesByMilestone,
  invalidateAllStatePRsByBranch,
} from "./issue_query.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function signature for running gh CLI commands. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/**
 * Function signature for resolving a repository's default branch.
 *
 * Issue #1509: Routed through `getRepoDefaultBranch` so the persistent
 * 7-day cache is shared with the rest of the worker.
 */
export type DefaultBranchFn = (repo: string) => Promise<Result<string>>;

/** Dependencies for the milestone completion orchestration. */
export interface MilestoneCompletionDeps {
  /** Repositories to scan (owner/repo format). */
  repos: string[];
  /** Function to execute gh CLI commands. */
  ghCommandFn: GhCommandFn;
  /**
   * Function that resolves the default branch for a repository.
   *
   * Optional. If omitted, falls back to calling `ghCommandFn` directly
   * (uncached). Production callers should inject `getRepoDefaultBranch`
   * so the persistent default-branch cache is used (Issue #1509).
   */
  defaultBranchFn?: DefaultBranchFn;
  /**
   * Optional IssueCache for read-through (Issue #1786). When provided,
   * milestone open/closed issue lookups share the per-iteration cache.
   */
  cache?: IssueCache;
  /**
   * Allowlist of service-account logins (Issue #3528). When non-empty, the
   * live `gh` login is re-resolved and validated against this list *before*
   * any milestone write (tracking-issue create, summary-PR raise, tracking
   * close). On a mismatch the whole operation fails loud — refusing to write
   * as a drifted human account. Empty/omitted leaves the re-check off.
   */
  serviceAccounts?: string[];
  /**
   * Re-resolve the live authenticated `gh` login for the write-phase identity
   * re-check (Issue #3528). Defaults to `getGithubUser`. Injected in tests.
   */
  resolveActualLogin?: () => Promise<string | null>;
  /** Resolve the hostname for identity-guard messages. Injected in tests. */
  hostname?: () => string;
  /** Logging function. */
  log: (message: string) => void;
}

/** Result of the milestone completion orchestration. */
export interface MilestoneCompletionResult {
  /** Number of summary PRs created. */
  summaryPrsCreated: number;
}

/** A closed issue in a milestone. */
interface ClosedIssue {
  number: number;
  title: string;
}

/**
 * Build a {@link DefaultBranchFn} that resolves via the injected
 * `ghCommandFn`. Used as a fallback for tests that stub only
 * `ghCommandFn` — production wiring passes `getRepoDefaultBranch`
 * directly so the persistent cache is used (Issue #1509).
 */
function makeGhDefaultBranchFn(ghFn: GhCommandFn): DefaultBranchFn {
  return async (repo: string): Promise<Result<string>> => {
    try {
      const out = await ghFn([
        "api",
        `repos/${repo}`,
        "--jq",
        ".default_branch",
      ]);
      const branch = out.trim();
      if (!branch) {
        return { ok: false, error: new Error(`empty response for ${repo}`) };
      }
      return { ok: true, value: branch };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: new Error(message) };
    }
  };
}

/** A GitHub milestone from the API. */
interface GitHubMilestone {
  title: string;
  number: number;
  /**
   * Count of open issues attached to the milestone (Issue #2125). Used
   * by the idle-task retirement gate to decide whether the milestone
   * is safe to auto-close — only fire when no in-flight work remains.
   */
  open_issues?: number;
}

/**
 * Discriminated result of attempting to create a milestone summary PR.
 *
 * Issue #1133: Distinguishes "created", "exists" (idempotent), and "failed"
 * so the caller can decide whether to close the tracking issue.
 */
export type SummaryPrOutcome =
  | { outcome: "created" }
  | { outcome: "exists"; prNumber: number }
  | { outcome: "failed"; reason: string };

// ---------------------------------------------------------------------------
// checkMilestoneComplete
// ---------------------------------------------------------------------------

/**
 * Check if all issues in a milestone are closed.
 *
 * Issue #3214: the milestone's own tracking issue
 * (`Merge milestone '<title>' to <branch>`) lives *inside* the milestone it
 * tracks, so a tracker left open by a failed summary-PR step would otherwise
 * be counted as an open issue here — the milestone would read "not complete"
 * forever and freeze (the deadlock). Tracking-shaped issues are excluded from
 * the completeness count so an open tracker never blocks its own milestone.
 * This exclusion is applied at the completion-check call path only; the
 * `milestone_health.ts` / `milestone_progress.ts` consumers of
 * `fetchOpenIssuesByMilestone` are unchanged.
 *
 * Issue #3908: this cached-list check is no longer the sole authority. It is
 * kept as the *second opinion*; `processRepoMilestones` also reads GitHub's
 * own `open_issues` counter fresh and treats a non-zero authoritative count as
 * a hard veto.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneTitle - The milestone title
 * @param ghCommandFn - Function to execute gh CLI commands
 * @returns Result with true if all non-tracking issues are closed, false otherwise
 */
export async function checkMilestoneComplete(
  repo: string,
  milestoneTitle: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<Result<boolean>> {
  // Issue #1786: route through `fetchOpenIssuesByMilestone` so the
  // shared `issues_all` cache is reused. The local milestone-title
  // filter avoids issuing a milestone-specific `gh issue list` call.
  try {
    const openIssues = await fetchOpenIssuesByMilestone(
      repo,
      milestoneTitle,
      cache,
      ghCommandFn,
    );
    // Issue #3214: ignore the milestone's own tracking issue(s).
    const openRealIssues = openIssues.filter(
      (issue) => !isMilestoneTrackingTitle(issue.title),
    );
    return { ok: true, value: openRealIssues.length === 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to check milestone '${milestoneTitle}' in ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// hasExistingMilestoneSummaryPr
// ---------------------------------------------------------------------------

/**
 * Check if a summary PR already exists for a milestone (idempotent check).
 *
 * Checks all states (open, merged, closed) to avoid re-creating PRs
 * that have already been merged or handled (Issue #568).
 *
 * Issue #1133: Returns the existing PR number when found, so it can be
 * logged when closing the tracking issue.
 *
 * Issue #1798: Routes through `fetchAllStatePRsByBranch` so the
 * `prs_all_branch_${milestoneBranch}` cache is shared across milestone
 * scans within a single iteration. The defence-in-depth `headRefName`
 * filter (Issue #859) is preserved.
 *
 * @param repo - Repository in "owner/repo" format
 * @param _milestoneTitle - The milestone title (unused, kept for API clarity)
 * @param milestoneBranch - The milestone branch name
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param cache - Optional iteration-scoped IssueCache
 * @returns Result with the existing PR number, or null if not found
 */
export async function hasExistingMilestoneSummaryPr(
  repo: string,
  _milestoneTitle: string,
  milestoneBranch: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<Result<number | null>> {
  try {
    const prs = await fetchAllStatePRsByBranch(
      repo,
      milestoneBranch,
      cache,
      ghCommandFn,
    );

    // Defence in depth: filter by headRefName in case the API returns
    // broader results than expected (Issue #859)
    const matching = prs.filter((pr) => pr.headRefName === milestoneBranch);
    const first = matching[0];
    return { ok: true, value: first !== undefined ? first.number : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to check existing PRs for milestone in ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// hasExistingMilestoneTrackingIssue
// ---------------------------------------------------------------------------

/**
 * Re-exported from `milestone_open_children.ts` (Issue #3908), which owns the
 * tracking-title shape now that both the cached and the authoritative
 * open-children lookups need it. Import path preserved for existing callers.
 */
export { isMilestoneTrackingTitle };

/**
 * Check if a tracking issue already exists for a milestone.
 *
 * Checks all states (open, closed) to prevent duplicates (Issue #568).
 *
 * Issue #1798: Routes through `fetchAllStateIssuesByMilestone` so the
 * `issues_all_milestone_${milestoneNumber}` cache is shared with sibling
 * milestone helpers within a single iteration. The tracking issue is
 * created with `--milestone <number>` (see `createMilestoneTrackingIssue`)
 * so it is always assigned to its milestone, allowing the milestone-keyed
 * lookup to find it.
 *
 * Issue #2753: The local filter now matches the tracking-issue *shape*
 * (`isMilestoneTrackingTitle`) rather than an exact full title. The previous
 * exact match — `Merge milestone '<title>' to <defaultBranch>` — drifted and
 * filed a duplicate whenever the default branch resolved differently between
 * runs (the field showed "to Develop" titles) or the milestone was renamed.
 * When several trackers exist, the canonical (lowest-numbered) one is reused.
 *
 * @param repo - Repository in "owner/repo" format
 * @param _milestoneTitle - The milestone title (unused; kept for API clarity)
 * @param milestoneNumber - The GitHub milestone number (API ID)
 * @param _defaultBranch - The default branch name (unused; kept for API clarity)
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param cache - Optional iteration-scoped IssueCache
 * @returns Result with the canonical existing issue number, or null if none
 */
export async function hasExistingMilestoneTrackingIssue(
  repo: string,
  _milestoneTitle: string,
  milestoneNumber: number,
  _defaultBranch: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<Result<number | null>> {
  try {
    const issues = await fetchAllStateIssuesByMilestone(
      repo,
      milestoneNumber,
      cache,
      ghCommandFn,
    );
    const matching = issues
      .filter((issue) => isMilestoneTrackingTitle(issue.title))
      .map((issue) => issue.number)
      .sort((a, b) => a - b);
    return { ok: true, value: matching.length > 0 ? matching[0]! : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to check tracking issues in ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// selectDuplicateTrackersToClose (Issue #2753)
// ---------------------------------------------------------------------------

/** Selection of duplicate milestone trackers to close versus keep. */
export interface DuplicateTrackerSelection {
  /** Canonical tracker to keep (lowest issue number); null when none given. */
  keep: number | null;
  /** Duplicate tracker numbers to close (the N−1 non-canonical), ascending. */
  close: number[];
}

/**
 * Given the open trackers for a single milestone, choose the canonical one
 * to keep (lowest issue number) and the N−1 duplicates to close (Issue #2753).
 *
 * Pure selection logic — performs no GitHub calls — so the one-time cleanup
 * (`Migration_v21#375`) can fetch the trackers, call this to decide, and close
 * the duplicates itself. Duplicate input numbers are de-duplicated. A no-op
 * (empty `close`) when zero or one tracker is supplied.
 *
 * @param trackerNumbers - Issue numbers of the milestone's open trackers
 * @returns The canonical tracker to keep and the duplicates to close
 */
export function selectDuplicateTrackersToClose(
  trackerNumbers: readonly number[],
): DuplicateTrackerSelection {
  const sorted = [...new Set(trackerNumbers)].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { keep: null, close: [] };
  }
  const [keep, ...close] = sorted;
  return { keep: keep!, close };
}

// ---------------------------------------------------------------------------
// getOpenMilestoneTrackers (Issue #3214)
// ---------------------------------------------------------------------------

/**
 * Return the issue numbers of the *open* tracking-shaped issues attached to a
 * milestone, ascending (Issue #3214).
 *
 * Reads through the shared `issues_all` cache via `fetchOpenIssuesByMilestone`
 * (no extra `gh` round-trip) and keeps only titles matching
 * {@link isMilestoneTrackingTitle}. Used by the completion loop each pass to
 * self-heal duplicate trackers and to dispose of premature / deadlocked
 * trackers.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneTitle - The milestone title
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param cache - Optional iteration-scoped IssueCache
 * @returns Ascending list of open tracking-issue numbers (empty on failure)
 */
export async function getOpenMilestoneTrackers(
  repo: string,
  milestoneTitle: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<number[]> {
  try {
    const openIssues = await fetchOpenIssuesByMilestone(
      repo,
      milestoneTitle,
      cache,
      ghCommandFn,
    );
    return openIssues
      .filter((issue) => isMilestoneTrackingTitle(issue.title))
      .map((issue) => issue.number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Issue numbers of the open *non-tracking* issues the cached list sees for a
 * milestone, ascending (Issue #3908).
 *
 * This is exactly the set `checkMilestoneComplete` counts, exposed so the
 * disagreement warning can name what each source saw. Reads through the shared
 * `issues_all` cache — no extra `gh` round-trip. Returns an empty list on
 * failure; the caller has already had the failure reported by
 * `checkMilestoneComplete`.
 */
async function getCachedOpenNonTrackingIssues(
  repo: string,
  milestoneTitle: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<number[]> {
  try {
    const openIssues = await fetchOpenIssuesByMilestone(
      repo,
      milestoneTitle,
      cache,
      ghCommandFn,
    );
    return openIssues
      .filter((issue) => !isMilestoneTrackingTitle(issue.title))
      .map((issue) => issue.number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// hasNothingToMerge (Issue #3214)
// ---------------------------------------------------------------------------

/**
 * Determine whether a milestone branch has nothing to merge into the default
 * branch (Issue #3214).
 *
 * "Nothing to merge" is true when either:
 *   1. the milestone branch does not exist on the remote (the common
 *      issue-only-milestone case), or
 *   2. the branch exists but is 0 commits ahead of the default branch.
 *
 * When there is genuinely nothing to merge, creating a tracking issue and a
 * summary PR is pointless — and, before this fix, the tracker left open by the
 * failed PR step deadlocked the milestone. The loop uses this to close the
 * milestone directly instead.
 *
 * Fails safe: any ambiguity (branch exists but the compare call fails, or an
 * unparseable `ahead_by`) returns `false` so the normal branch-present flow
 * runs and no milestone is closed on incomplete information.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneBranch - The milestone branch name
 * @param defaultBranch - The default branch name
 * @param ghCommandFn - Function to execute gh CLI commands
 * @returns true when there is definitively nothing to merge
 */
export async function hasNothingToMerge(
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<boolean> {
  // Branch existence — a missing branch means nothing to merge.
  try {
    await ghCommandFn([
      "api",
      `repos/${repo}/branches/${milestoneBranch}`,
      "--jq",
      ".name",
    ]);
  } catch {
    return true;
  }

  // Branch exists — count commits ahead of the default branch. `ahead_by` is
  // the number of commits the milestone branch has that the default branch
  // does not.
  try {
    const out = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${defaultBranch}...${milestoneBranch}`,
      "--jq",
      ".ahead_by",
    ]);
    const aheadBy = Number(out.trim());
    if (Number.isFinite(aheadBy)) {
      return aheadBy === 0;
    }
    // Unparseable — fail safe (assume there is work to merge).
    return false;
  } catch {
    // Compare failed — fail safe (do not close on incomplete information).
    return false;
  }
}

// ---------------------------------------------------------------------------
// buildMilestoneSummaryBody
// ---------------------------------------------------------------------------

/**
 * Build the PR body for a milestone summary PR.
 *
 * @param milestoneTitle - The milestone title
 * @param defaultBranch - The default branch name
 * @param closedIssues - List of closed issues in the milestone
 * @param trackingIssueNumber - Optional tracking issue number to reference
 * @returns Markdown PR body
 */
export function buildMilestoneSummaryBody(
  milestoneTitle: string,
  defaultBranch: string,
  closedIssues: ClosedIssue[],
  trackingIssueNumber?: number,
): string {
  const issuesList = closedIssues
    .map((issue) => `- #${issue.number}: ${issue.title}`)
    .join("\n");

  const trackingRef = trackingIssueNumber
    ? `\nCloses #${trackingIssueNumber}`
    : "";

  return `## Milestone: ${milestoneTitle}

This PR merges the completed milestone branch into ${defaultBranch}.${trackingRef}

### Issues addressed
${issuesList || "_No issues found_"}

### Review notes
All individual issues were reviewed and merged into the milestone branch via separate PRs.
This final PR consolidates all changes for a comprehensive review before merging to ${defaultBranch}.`;
}

// ---------------------------------------------------------------------------
// createMilestoneTrackingIssue (internal)
// ---------------------------------------------------------------------------

/**
 * Create a tracking issue for milestone completion (Issue #561).
 * Performs an idempotent check first to avoid duplicates.
 *
 * @returns The tracking issue number (existing or newly created), or null on failure
 */
async function createMilestoneTrackingIssue(
  repo: string,
  milestoneTitle: string,
  milestoneNumber: number,
  defaultBranch: string,
  closedIssues: ClosedIssue[],
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  cache?: IssueCache,
): Promise<number | null> {
  // Idempotent check
  const existingResult = await hasExistingMilestoneTrackingIssue(
    repo,
    milestoneTitle,
    milestoneNumber,
    defaultBranch,
    ghCommandFn,
    cache,
  );
  if (existingResult.ok && existingResult.value !== null) {
    log(
      `Tracking issue for milestone '${milestoneTitle}' already exists (#${existingResult.value}) in ${repo}`,
    );
    return existingResult.value;
  }

  const issueTitle = `Merge milestone '${milestoneTitle}' to ${defaultBranch}`;
  const issuesList = closedIssues
    .map((issue) => `- #${issue.number}: ${issue.title}`)
    .join("\n");

  const issueBody =
    `<!-- milestone-tracking-issue — do not process as regular work -->
## Milestone completion: ${milestoneTitle}

All issues in milestone '${milestoneTitle}' are now complete.
This is an auto-generated tracking issue for the milestone to ${defaultBranch} merge.

### Closed issues
${issuesList || "_No issues found_"}

### Action required
Raise a PR to merge the milestone branch to \`${defaultBranch}\`.`;

  try {
    // Issue #859: Do NOT add the discovery label to tracking issues.
    // Issue #1798: Tag the tracking issue with its milestone so the
    // cached `fetchAllStateIssuesByMilestone` lookup finds it on
    // subsequent iterations.
    const output = await ghCommandFn([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      issueTitle,
      "--body",
      issueBody,
      "--milestone",
      milestoneTitle,
    ]);

    log(`Milestone tracking issue created: ${output}`);

    // Issue #1798: invalidate the milestone-keyed cache so a subsequent
    // lookup in the same iteration sees the newly created tracking issue.
    if (cache) {
      await invalidateAllStateIssuesByMilestone(cache, repo, milestoneNumber);
    }

    // Extract issue number from URL (e.g., "https://github.com/owner/repo/issues/300")
    const match = output.match(/(\d+)\s*$/);
    return match ? Number(match[1]) : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Failed to create milestone tracking issue in ${repo}: ${message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// createMilestoneSummaryPr (internal)
// ---------------------------------------------------------------------------

/**
 * Create the final PR from milestone branch to default branch.
 * Performs idempotent checks first.
 *
 * Issue #1133: Returns a discriminated result so the caller can distinguish
 * "created", "exists" (should close tracking issue), and "failed" (leave open).
 *
 * @returns Discriminated SummaryPrOutcome
 */
async function createMilestoneSummaryPr(
  repo: string,
  milestoneTitle: string,
  milestoneBranch: string,
  defaultBranch: string,
  trackingIssueNumber: number | null,
  closedIssues: ClosedIssue[],
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  cache?: IssueCache,
): Promise<SummaryPrOutcome> {
  // Idempotent check — do not create duplicate PRs
  const existingResult = await hasExistingMilestoneSummaryPr(
    repo,
    milestoneTitle,
    milestoneBranch,
    ghCommandFn,
    cache,
  );
  if (existingResult.ok && existingResult.value !== null) {
    log(
      `Summary PR for milestone '${milestoneTitle}' already exists (#${existingResult.value}) in ${repo} — skipping`,
    );
    return { outcome: "exists", prNumber: existingResult.value };
  }

  // Check that the milestone branch exists on the remote (Issue #570)
  try {
    await ghCommandFn([
      "api",
      `repos/${repo}/branches/${milestoneBranch}`,
      "--jq",
      ".name",
    ]);
  } catch {
    log(
      `WARNING: Milestone branch '${milestoneBranch}' does not exist in ${repo} — cannot create summary PR`,
    );
    return { outcome: "failed", reason: "branch_missing" };
  }

  const prBody = buildMilestoneSummaryBody(
    milestoneTitle,
    defaultBranch,
    closedIssues,
    trackingIssueNumber ?? undefined,
  );

  try {
    log(
      `Creating milestone summary PR: '${milestoneTitle}' → ${defaultBranch} in ${repo}`,
    );
    const prUrl = await ghCommandFn([
      "pr",
      "create",
      "--repo",
      repo,
      "--title",
      `Milestone: ${milestoneTitle}`,
      "--body",
      prBody,
      "--head",
      milestoneBranch,
      "--base",
      defaultBranch,
    ]);
    log(`Milestone summary PR created: ${prUrl}`);
    // Issue #1798: invalidate the branch-keyed cache so a follow-up
    // lookup within the same iteration sees the newly created PR.
    if (cache) {
      await invalidateAllStatePRsByBranch(cache, repo, milestoneBranch);
    }
    return { outcome: "created" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Failed to create milestone summary PR for '${milestoneTitle}' in ${repo}: ${message}`,
    );
    return { outcome: "failed", reason: message };
  }
}

// ---------------------------------------------------------------------------
// isSummaryPrMerged
// ---------------------------------------------------------------------------

/**
 * Check whether a summary PR has been merged.
 *
 * Issue #1210: Used to determine whether the GitHub milestone should be closed
 * after the summary PR is confirmed to exist.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - The PR number to check
 * @param ghCommandFn - Function to execute gh CLI commands
 * @returns Result with true if the PR state is "MERGED", false otherwise
 */
export async function isSummaryPrMerged(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
): Promise<Result<boolean>> {
  try {
    const output = await ghCommandFn([
      "pr",
      "view",
      "--repo",
      repo,
      String(prNumber),
      "--json",
      "state",
    ]);
    const data = JSON.parse(output) as { state: string };
    return { ok: true, value: data.state === "MERGED" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to check PR #${prNumber} state in ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// closeGitHubMilestone
// ---------------------------------------------------------------------------

/**
 * Close a GitHub milestone via the REST API.
 *
 * Issue #1210: After the summary PR is merged, the milestone should be closed
 * so it is not re-checked on subsequent scan cycles.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneNumber - The GitHub milestone number (API ID, not title)
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param log - Logging function
 */
export async function closeGitHubMilestone(
  repo: string,
  milestoneNumber: number,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<void> {
  try {
    await ghCommandFn([
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/milestones/${milestoneNumber}`,
      "-f",
      "state=closed",
    ]);
    log(`Closed GitHub milestone #${milestoneNumber} in ${repo} (Issue #1210)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Failed to close milestone #${milestoneNumber} in ${repo}: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// closeMilestoneTrackingIssue (internal)
// ---------------------------------------------------------------------------

/**
 * Close a milestone tracking issue immediately after the summary PR is
 * created or confirmed to already exist (Issue #1133).
 *
 * This prevents the worker from discovering and claiming the tracking
 * issue as a regular work item during the review period.
 */
async function closeMilestoneTrackingIssue(
  repo: string,
  issueNumber: number,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  milestoneNumber?: number,
  cache?: IssueCache,
): Promise<void> {
  try {
    await ghCommandFn([
      "issue",
      "close",
      "--repo",
      repo,
      String(issueNumber),
      "--reason",
      "completed",
    ]);
    log(
      `Closed milestone tracking issue #${issueNumber} in ${repo} (Issue #1133)`,
    );
    // Issue #1798: closing the tracking issue mutates milestone state —
    // drop the milestone-keyed cache so a follow-up lookup sees the
    // closed state.
    if (cache && typeof milestoneNumber === "number") {
      await invalidateAllStateIssuesByMilestone(cache, repo, milestoneNumber);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Failed to close tracking issue #${issueNumber} in ${repo}: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// getClosedIssues (internal)
// ---------------------------------------------------------------------------

async function getClosedIssues(
  repo: string,
  milestoneTitle: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<ClosedIssue[]> {
  // Issue #1786: routes through the cached helper so duplicate
  // closed-issue lookups across the milestone helpers within a single
  // iteration share a payload.
  try {
    return await fetchClosedIssuesByMilestone(
      repo,
      milestoneTitle,
      cache,
      ghCommandFn,
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Write-phase identity guard (Issue #3528)
// ---------------------------------------------------------------------------

/** Default live-login resolver — the real `gh` login via getGithubUser. */
async function defaultResolveActualLogin(): Promise<string | null> {
  const { getGithubUser } = await import("./claude_runner.ts");
  const result = await getGithubUser();
  return result.ok ? result.value : null;
}

/**
 * Re-resolve the live `gh` login and validate it against the configured
 * service-account allowlist before any milestone write (Issue #3528).
 *
 * @returns An {@link IdentityGuardError} when the write must be refused, or
 *   null when it is safe to proceed (login allowed, or allowlist inactive).
 */
async function checkWriteIdentity(
  deps: MilestoneCompletionDeps,
): Promise<IdentityGuardError | null> {
  const serviceAccounts = deps.serviceAccounts ?? [];
  // Inactive allowlist: nothing to enforce. The startup guard already logged
  // the loud INACTIVE warning, so stay quiet here to avoid per-iteration noise.
  if (serviceAccounts.filter((a) => a.trim().length > 0).length === 0) {
    return null;
  }

  const resolveActualLogin = deps.resolveActualLogin ??
    defaultResolveActualLogin;
  const host = deps.hostname?.() ?? readHostname();
  const actual = (await resolveActualLogin()) ?? "";
  const evaluation = evaluateWorkerIdentity(actual, serviceAccounts, host);
  return evaluation.permitted ? null : new IdentityGuardError(evaluation);
}

// ---------------------------------------------------------------------------
// checkAndHandleMilestoneCompletions (main entry point)
// ---------------------------------------------------------------------------

/**
 * Scan configured repositories for completed milestones and create tracking
 * issues and summary PRs as needed.
 *
 * This is the main orchestration function, called from the run_core priority
 * dispatch at priority 1.7.
 *
 * @param deps - Injected dependencies
 * @returns Result with the number of summary PRs created
 */
export async function checkAndHandleMilestoneCompletions(
  deps: MilestoneCompletionDeps,
): Promise<Result<MilestoneCompletionResult>> {
  const { repos, ghCommandFn, log } = deps;
  let summaryPrsCreated = 0;

  if (repos.length === 0) {
    return { ok: true, value: { summaryPrsCreated: 0 } };
  }

  // Issue #3528: fail-loud identity re-check before any milestone write.
  // The milestone-completion path creates tracking issues, raises summary PRs,
  // and closes trackers via `runGhCommand` — worker code, not the Claude
  // subprocess. A host whose `gh` auth drifts mid-run to a human personal
  // token would perform those writes as that human. Re-resolve the live login
  // here and refuse to proceed on a mismatch. This runs *before* the per-repo
  // loop (whose try/catch swallows errors as warnings), so the mismatch is
  // never masked as success.
  const identityFailure = await checkWriteIdentity(deps);
  if (identityFailure) {
    log(identityFailure.message);
    return { ok: false, error: identityFailure };
  }

  const defaultBranchFn: DefaultBranchFn = deps.defaultBranchFn ??
    makeGhDefaultBranchFn(ghCommandFn);

  for (const repo of repos) {
    try {
      await processRepoMilestones(
        repo,
        ghCommandFn,
        defaultBranchFn,
        log,
        (count) => {
          summaryPrsCreated += count;
        },
        deps.cache,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`WARNING: Milestone check failed for ${repo}: ${message}`);
    }
  }

  if (summaryPrsCreated > 0) {
    log(
      `Milestone completion check: ${summaryPrsCreated} summary PR(s) created (Issue #425)`,
    );
  }

  return { ok: true, value: { summaryPrsCreated } };
}

/**
 * Process milestone completions for a single repository.
 */
async function processRepoMilestones(
  repo: string,
  ghCommandFn: GhCommandFn,
  defaultBranchFn: DefaultBranchFn,
  log: (message: string) => void,
  onPrCreated: (count: number) => void,
  cache?: IssueCache,
): Promise<void> {
  // Resolve default branch via injected function (Issue #1509 — uses the
  // persistent 7-day cache in production so we don't burn a GitHub REST
  // quota slot every run_core cycle).
  const branchResult = await defaultBranchFn(repo);
  if (!branchResult.ok) {
    log(
      `WARNING: Could not determine default branch for ${repo} — skipping milestone check`,
    );
    return;
  }
  const defaultBranch = branchResult.value.trim();
  if (!defaultBranch) {
    log(
      `WARNING: Could not determine default branch for ${repo} — skipping milestone check`,
    );
    return;
  }

  // List open milestones
  let milestones: GitHubMilestone[];
  try {
    const output = await ghCommandFn([
      "api",
      `repos/${repo}/milestones`,
    ]);
    milestones = JSON.parse(output) as GitHubMilestone[];
  } catch {
    return; // No milestones or API failure — nothing to do
  }

  for (const milestone of milestones) {
    // Issue #2125: idle-task milestones (e.g. `idle-task: security-scan`)
    // are retired. The security-scan template files findings directly
    // as standalone issues — the milestone has no role. Auto-close any
    // legacy milestone whose backlog has fully drained so it stops
    // generating completion-sync log noise on every iteration; skip it
    // silently otherwise. `skipMilestone: true` already prevents new
    // wrappers from being filed under a milestone, so no fresh idle-task
    // milestones will appear.
    if (isIdleTaskMilestone(milestone.title)) {
      if ((milestone.open_issues ?? 0) === 0) {
        log(
          `Closing legacy idle-task milestone '${milestone.title}' in ${repo} ` +
            `— no longer used (Issue #2125)`,
        );
        await closeGitHubMilestone(repo, milestone.number, ghCommandFn, log);
      } else {
        log(
          `Skipping idle-task milestone '${milestone.title}' in ${repo} — ` +
            `${milestone.open_issues} open issue(s) remain, no summary PR ` +
            `will be raised (Issue #2125)`,
        );
      }
      continue;
    }

    const milestoneBranch = createMilestoneBranchName(milestone.title);

    // Issue #3214: fetch the milestone's open tracking-shaped issues up front
    // so every branch below can self-heal duplicate/premature/deadlocked
    // trackers. Reads through the shared cache — no extra gh round-trip.
    const openTrackers = await getOpenMilestoneTrackers(
      repo,
      milestone.title,
      ghCommandFn,
      cache,
    );

    // Check if milestone is complete (all non-tracking issues closed —
    // Issue #3214 excludes the tracker so it can no longer block itself).
    const completeResult = await checkMilestoneComplete(
      repo,
      milestone.title,
      ghCommandFn,
      cache,
    );
    if (!completeResult.ok || !completeResult.value) {
      // Issue #3214 (scope item 4): the milestone is NOT complete but carries
      // an open tracking-shaped issue — a premature tracker filed when the
      // milestone momentarily hit 0 open before new issues were added. Close
      // it so it is not claimed as work and does not linger.
      for (const tracker of openTrackers) {
        await closeMilestoneTrackingIssue(
          repo,
          tracker,
          ghCommandFn,
          log,
          milestone.number,
          cache,
        );
        log(
          `Closed premature milestone tracking issue #${tracker} for '${milestone.title}' in ${repo} — milestone not complete (Issue #3214)`,
        );
      }
      continue;
    }

    // Issue #3908: the cached list says complete — now ask GitHub. The
    // authoritative `open_issues` counter is read fresh (no cache) at this
    // exact moment, and any open non-tracking child (issue *or* PR) is a hard
    // veto: no tracker, no summary PR, no milestone close. A failed or
    // malformed read is also a veto — "could not tell" is never "complete".
    const authoritative = await fetchAuthoritativeOpenChildren(
      repo,
      milestone.number,
      ghCommandFn,
    );
    if (!authoritative.ok) {
      log(
        `WARNING: ${authoritative.error.message} — refusing to finalise ` +
          `milestone '${milestone.title}' this pass (Issue #3908)`,
      );
      continue;
    }
    const authority = authoritative.value;
    if (!authority.childListAvailable) {
      log(
        `WARNING: Could not read the fresh open-child list for milestone ` +
          `'${milestone.title}' in ${repo}: ${authority.childListError} — ` +
          `falling back to the unadjusted open_issues count ` +
          `(${authority.rawOpenIssues}), tracking issues not excluded ` +
          `(Issue #3908)`,
      );
    }
    const cachedOpen = await getCachedOpenNonTrackingIssues(
      repo,
      milestone.title,
      ghCommandFn,
      cache,
    );
    if (authority.openCount !== cachedOpen.length) {
      log(
        `WARNING: Open-children disagreement for milestone ` +
          `'${milestone.title}' in ${repo} — GitHub reports ` +
          `${authority.openCount} open non-tracking child(ren) ` +
          `[${formatChildNumbers(authority.children)}] ` +
          `(open_issues=${authority.rawOpenIssues}, trackers ` +
          `[${formatChildNumbers(authority.trackers)}]) but the cached issue ` +
          `list reports ${cachedOpen.length} ` +
          `[${cachedOpen.map((n) => `#${n}`).join(", ") || "none"}]. ` +
          `Trusting GitHub (Issue #3908)`,
      );
    }
    if (authority.openCount > 0) {
      log(
        `Milestone '${milestone.title}' in ${repo} is NOT complete — GitHub ` +
          `reports ${authority.openCount} open non-tracking child ` +
          `issue(s)/PR(s) [${formatChildNumbers(authority.children)}]; no ` +
          `tracking issue, summary PR or milestone close will be made ` +
          `(Issue #3908)`,
      );
      continue;
    }

    // Issue #3214 (scope item 3): self-heal duplicate trackers each pass.
    // Keep the canonical (lowest-numbered) tracker and close the rest.
    let canonicalTracker: number | null = null;
    if (openTrackers.length > 0) {
      const selection = selectDuplicateTrackersToClose(openTrackers);
      canonicalTracker = selection.keep;
      for (const dup of selection.close) {
        await closeMilestoneTrackingIssue(
          repo,
          dup,
          ghCommandFn,
          log,
          milestone.number,
          cache,
        );
        log(
          `Closed duplicate milestone tracking issue #${dup} for '${milestone.title}' in ${repo} (Issue #3214)`,
        );
      }
    }

    // Skip empty milestones (no closed issues means nothing was worked on)
    const closedIssues = await getClosedIssues(
      repo,
      milestone.title,
      ghCommandFn,
      cache,
    );
    if (closedIssues.length === 0) {
      continue;
    }

    // Issue #3214 (scope item 2): check the milestone branch BEFORE creating a
    // tracker. When there is nothing to merge (branch missing, or 0 commits
    // ahead of the default branch — the common issue-only-milestone case),
    // creating a tracker + summary PR is pointless and, before this fix, left
    // the tracker open forever (the deadlock). Instead close any open trackers
    // and close the milestone directly.
    if (
      await hasNothingToMerge(
        repo,
        milestoneBranch,
        defaultBranch,
        ghCommandFn,
      )
    ) {
      if (canonicalTracker !== null) {
        await closeMilestoneTrackingIssue(
          repo,
          canonicalTracker,
          ghCommandFn,
          log,
          milestone.number,
          cache,
        );
      }
      await closeGitHubMilestone(repo, milestone.number, ghCommandFn, log);
      log(
        `Milestone '${milestone.title}' in ${repo} is complete with nothing to merge (branch missing or 0 commits ahead) — closed directly, no tracker or summary PR (Issue #3214)`,
      );
      continue;
    }

    // Create tracking issue (idempotent)
    const trackingIssueNumber = await createMilestoneTrackingIssue(
      repo,
      milestone.title,
      milestone.number,
      defaultBranch,
      closedIssues,
      ghCommandFn,
      log,
      cache,
    );

    // Create summary PR (idempotent)
    log(`Milestone '${milestone.title}' is complete — creating summary PR`);
    const prResult = await createMilestoneSummaryPr(
      repo,
      milestone.title,
      milestoneBranch,
      defaultBranch,
      trackingIssueNumber,
      closedIssues,
      ghCommandFn,
      log,
      cache,
    );
    if (prResult.outcome === "created") {
      onPrCreated(1);
    }

    // Issue #1133: Close tracking issue immediately after summary PR is
    // created or confirmed to already exist. This prevents the worker from
    // claiming the tracking issue as a regular work item.
    if (prResult.outcome !== "failed" && trackingIssueNumber !== null) {
      await closeMilestoneTrackingIssue(
        repo,
        trackingIssueNumber,
        ghCommandFn,
        log,
        milestone.number,
        cache,
      );
    }

    // Issue #1210: Close the GitHub milestone when the summary PR has been
    // merged. This prevents the handler from re-checking the milestone every
    // scan cycle and logging repeated "Summary PR already exists" messages.
    // Only check when the PR already existed — a just-created PR cannot be
    // merged yet.
    if (prResult.outcome === "exists") {
      const mergedResult = await isSummaryPrMerged(
        repo,
        prResult.prNumber,
        ghCommandFn,
      );
      if (mergedResult.ok && mergedResult.value) {
        await closeGitHubMilestone(repo, milestone.number, ghCommandFn, log);
      }
    }
  }
}
