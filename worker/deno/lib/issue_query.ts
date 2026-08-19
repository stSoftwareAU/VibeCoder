/**
 * GitHub API query functions for issue discovery (Issue #910).
 *
 * Replaces worker/shared/issue_query.sh with type-safe TypeScript.
 * Handles all direct GitHub API interactions for issue finding:
 * querying issues, fetching PRs, checking PR blocking, and
 * verifying label authorship for security.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { runGhCommand } from "./github.ts";
// Issue #2900: re-export the single canonical milestone-branch namer from
// git_branch.ts so PR-blocking uses the same branch name the feature PR
// actually targets (50-char slug cap + trailing-hyphen strip).
import { createMilestoneBranchName } from "./git_branch.ts";
import { isHumanAuthoredPr } from "./fleet_authors.ts";
export { createMilestoneBranchName };
import { IssueCache } from "./issue_cache.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import { TimelineCache } from "./timeline_cache.ts";
// Issue #4037: fold the per-tick issue-list fetch into the access store.
import { classifyProbeFailure } from "./idle_detect_diagnostics.ts";
import { recordRepoProbeBestEffort } from "./monitored_repo_access.ts";
import {
  type TimelineLabelEventJson,
  validateIssueLabelsJson,
  validateTimelineLabelEventsJson,
} from "./validation.ts";

/**
 * Open PR data for blocking checks.
 */
export interface OpenPR {
  number: number;
  title: string;
  baseRefName: string;
  headRefName: string;
  /**
   * The fleet login this PR was fetched under (Issue #4024). Stamped by
   * `fetchOpenPRsByUser` from the `--author` it queried, so a blocking
   * decision can name the author and check it against the PR-maintenance
   * scan set. Optional: cache entries written before #4024 lack it.
   */
  author?: string;
}

/**
 * Open PR with body content, used by helpers that need to identify
 * worker PRs by body marker (Issue #1787).
 */
export interface OpenPRWithBody extends OpenPR {
  body: string;
  url: string;
}

/**
 * Merged PR with head branch info (Issue #1787).
 */
export interface MergedPR {
  number: number;
  title: string;
  headRefName: string;
}

/**
 * Recently-closed PR data for duplicate prevention (Issue #1427).
 */
export interface ClosedPR {
  number: number;
  title: string;
  closedAt: string;
  /**
   * Issue #3151: distinguishes a **merged** fleet PR (permanent skip — an
   * issue whose fleet PR merged is done for the fleet, regardless of the
   * cooldown window) from a **closed-unmerged** PR (cooldown-windowed retry
   * path). Optional so older cached `ClosedPR[]` payloads remain valid; a
   * missing value is treated as closed-unmerged.
   */
  merged?: boolean;
}

/**
 * Closed PR with merge state (Issue #1809).
 *
 * Used by repo-wide closed-PR scans (e.g. stuck_recovery's
 * `detectAssignedWithClosedPr`) so callers can distinguish
 * closed-not-merged from merged PRs without an extra `gh pr view`.
 */
export interface ClosedPRWithMerge {
  number: number;
  title: string;
  mergedAt: string | null;
  closedAt: string | null;
}

/**
 * Blocking PR information.
 */
export interface BlockingPRInfo {
  number: number;
  title: string;
  /**
   * The login the blocking PR was fetched under (Issue #4078), carried
   * through from {@link OpenPR.author}. Callers classify the block with
   * it: a PR authored outside the fleet's push-capable accounts is one
   * no maintenance scan will ever fix, answer, or merge, so the blocked
   * issue is escalated instead of left to stall silently (#4023).
   * Empty when the fetch never stamped it (a pre-#4024 cache entry).
   */
  author: string;
}

/**
 * Raw issue JSON from gh issue list.
 */
interface GhIssueListItem {
  number: number;
  title: string;
  url: string;
  assignees: Array<{ login: string }>;
  labels: Array<{ name: string }>;
  createdAt: string;
  updatedAt?: string;
  author: { login: string };
  milestone?: { title: string } | null;
}

/**
 * Parse raw gh issue list JSON into FilterableIssue array.
 *
 * @param jsonStr - Raw JSON string from gh CLI
 * @returns Parsed issues
 */
/**
 * Refuse to treat a failed gh list call as an empty list (Issue #4257).
 *
 * `runGh`-style wrappers return `""` on failure (rate limit, network,
 * auth). Parsing that leniently yields `[]`, and caching it poisons the
 * shared iteration cache for the TTL — every downstream reader then sees
 * an empty repo (the #3906/#3908 incident shape). A genuine empty list
 * is the two-byte output `[]`; anything empty or unparseable is a failed
 * call and throws before any cache write.
 */
function assertListOutput(output: string, context: string): void {
  const trimmed = output.trim();
  if (trimmed === "") {
    throw new Error(
      `${context}: gh returned no output — treating as a failed call, ` +
        `not an empty list (Issue #4257)`,
    );
  }
  try {
    JSON.parse(trimmed);
  } catch {
    throw new Error(
      `${context}: gh output was not valid JSON — treating as a failed ` +
        `call (Issue #4257)`,
    );
  }
}

export function parseIssueListJson(jsonStr: string): FilterableIssue[] {
  try {
    const raw: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(raw)) return [];
    // Inline runtime shape guard — gh CLI output at trust boundary (Issue #1532).
    const items: GhIssueListItem[] = [];
    for (const item of raw) {
      if (!isRecord(item)) continue;
      if (typeof item.number !== "number") continue;
      if (typeof item.title !== "string") continue;
      items.push(item as unknown as GhIssueListItem);
    }
    return items.map((item) => {
      const issue: FilterableIssue = {
        number: item.number,
        title: item.title,
        url: item.url ?? "",
        author: item.author?.login ?? "",
        assignees: (item.assignees ?? []).map((a) => a.login),
        labels: (item.labels ?? []).map((l) => l.name),
        createdAt: item.createdAt ?? "",
        updatedAt: item.updatedAt ?? "",
        milestone: item.milestone?.title ?? "",
      };
      // Body is optional in `FilterableIssue`; include it only when present
      // so older cached payloads remain compatible (Issue #1805).
      const bodyValue = (item as unknown as { body?: unknown }).body;
      if (typeof bodyValue === "string") {
        issue.body = bodyValue;
      }
      return issue;
    });
  } catch {
    return [];
  }
}

/** Type guard for plain objects used by inline validators (Issue #1532). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse raw gh pr list JSON into OpenPR array.
 *
 * @param jsonStr - Raw JSON string from gh CLI
 * @returns Parsed PRs
 */
export function parsePRListJson(jsonStr: string): OpenPR[] {
  try {
    const raw: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(raw)) return [];
    // Inline runtime shape guard (Issue #1532).
    const items: OpenPR[] = [];
    for (const item of raw) {
      if (!isRecord(item)) continue;
      if (typeof item.number !== "number") continue;
      items.push({
        number: item.number,
        title: typeof item.title === "string" ? item.title : "",
        baseRefName: typeof item.baseRefName === "string"
          ? item.baseRefName
          : "",
        headRefName: typeof item.headRefName === "string"
          ? item.headRefName
          : "",
      });
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Fetch all open issues for a repo with comprehensive fields.
 *
 * Issue #4037: this is the issue-list fetch the Priority 2 scan already
 * performs for every monitored repo on every tick, so its outcome is
 * folded into the per-repo access store (#4036) — no new API call, and
 * the signal stays fresh on busy ticks when the idle-detect audit never
 * runs. Only a real fetch is recorded: a cache hit returns above, since
 * a cached read is not evidence of current access.
 *
 * @param repo - Repository in "owner/repo" format
 * @param cache - Optional cache instance
 * @param limit - Maximum issues to fetch (default: 100)
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Array of filterable issues
 */
export async function fetchAllIssues(
  repo: string,
  cache?: IssueCache,
  limit = 100,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<FilterableIssue[]> {
  const cacheKey = "issues_all";

  if (cache) {
    const cached = await cache.read<FilterableIssue[]>(repo, cacheKey);
    if (cached) return cached;
  }

  let output: string;
  try {
    output = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      // Issue #1784: include `updatedAt` so stale-workflow can read from
      // this shared cache without triggering its own per-label gh calls.
      // Issue #1805: include `body` so milestone-health dependency
      // detection can read from the shared cache instead of issuing a
      // second `gh issue list --milestone …` call per milestone.
      "number,title,assignees,url,labels,createdAt,updatedAt,author,milestone,body",
      "--limit",
      String(limit),
    ]);
  } catch (err) {
    // Best-effort bookkeeping only: the error is re-thrown untouched so
    // every caller's control flow is exactly what it was before #4037.
    const message = err instanceof Error ? err.message : String(err);
    recordRepoProbeBestEffort(repo, classifyProbeFailure(message));
    throw err;
  }
  recordRepoProbeBestEffort(repo, "ok");

  // Never cache a failure (Issue #4257): a runGh-style "" or garbage
  // payload must surface as an error, not as "repo has no open issues".
  assertListOutput(output, `fetchAllIssues(${repo})`);

  const issues = parseIssueListJson(output);
  if (cache) await cache.write(repo, cacheKey, issues);
  return issues;
}

/**
 * A closed issue with its milestone title, returned by
 * `fetchAllClosedIssues` (Issue #1908).
 */
interface ClosedIssueAll {
  number: number;
  title: string;
  milestone: string | null;
}

/**
 * Default limit for `fetchAllClosedIssues` — wide enough to cover the
 * typical active-milestone backlog across a repo while still bounding
 * the `gh` call cost. Picked to comfortably exceed the pre-#1908
 * per-milestone limit of 200 multiplied by the small number of
 * concurrent active milestones we see in practice.
 */
const CLOSED_ALL_DEFAULT_LIMIT = 500;

/**
 * Fetch all closed issues for a repo in a single batch and cache them
 * under `issues_closed_all` (Issue #1908).
 *
 * Counterpart to `fetchAllIssues` for closed issues. Each entry carries
 * its milestone title so per-milestone callers can filter locally
 * rather than issuing a fresh `gh issue list --milestone …` per
 * milestone scan. The cache key is repo-scoped (no milestone
 * namespacing) so concurrent milestone scans within a single iteration
 * share one round-trip.
 */
export async function fetchAllClosedIssues(
  repo: string,
  cache?: IssueCache,
  limit = CLOSED_ALL_DEFAULT_LIMIT,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<ClosedIssueAll[]> {
  const cacheKey = "issues_closed_all";

  if (cache) {
    const cached = await cache.read<ClosedIssueAll[]>(repo, cacheKey);
    if (cached) return cached;
  }

  let output: string;
  try {
    output = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "closed",
      "--json",
      "number,title,milestone",
      "--limit",
      String(limit),
    ]);
  } catch {
    return [];
  }

  // Never cache a failure (Issue #4257). This fetcher's contract swallows
  // gh failures into an uncached [], so an empty or unparseable payload
  // takes that same path instead of being cached as "no closed issues".
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const issues: ClosedIssueAll[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    let milestone: string | null = null;
    if (isRecord(item.milestone) && typeof item.milestone.title === "string") {
      milestone = item.milestone.title;
    }
    issues.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      milestone,
    });
  }
  if (cache) await cache.write(repo, cacheKey, issues);
  return issues;
}

/**
 * Fetch closed issues for a specific milestone (Issue #1786, batched
 * via `fetchAllClosedIssues` in Issue #1908).
 *
 * Used by the milestone-completion / progress / health helpers and by
 * `findActiveMilestones`. Pre-#1908 this issued one
 * `gh issue list --milestone X --state closed` per milestone; now it
 * filters the shared `fetchAllClosedIssues` batch so concurrent
 * milestone scans within a single iteration share one round-trip.
 *
 * The shape returned (`number, title`) matches the pre-#1908 contract,
 * so callers do not need to change.
 */
export async function fetchClosedIssuesByMilestone(
  repo: string,
  milestoneTitle: string,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<Array<{ number: number; title: string }>> {
  const all = await fetchAllClosedIssues(
    repo,
    cache,
    CLOSED_ALL_DEFAULT_LIMIT,
    ghCommandFn,
  );
  return all
    .filter((issue) => issue.milestone === milestoneTitle)
    .map((issue) => ({ number: issue.number, title: issue.title }));
}

/**
 * Open issue payload returned by `fetchOpenIssuesByMilestone` (Issue #1805).
 *
 * `number` and `title` are required for the milestone progress/completion
 * helpers. `assignees` and `body` are populated from the shared
 * `issues_all` cache so milestone-health can classify issues without a
 * second `gh issue list` call.
 */
export interface OpenMilestoneIssue {
  number: number;
  title: string;
  assignees: string[];
  body: string;
}

/**
 * Filter cached open issues to those in a specific milestone
 * (Issue #1786, extended in Issue #1805).
 *
 * Reads through `fetchAllIssues` so the cached `issues_all` payload is
 * reused, then applies a local milestone-title filter. Returns the
 * `OpenMilestoneIssue` shape — `number` and `title` for progress
 * counting plus `assignees` and `body` for milestone-health
 * classification.
 */
export async function fetchOpenIssuesByMilestone(
  repo: string,
  milestoneTitle: string,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<OpenMilestoneIssue[]> {
  const all = await fetchAllIssues(repo, cache, 200, ghCommandFn);
  return all
    .filter((issue) => issue.milestone === milestoneTitle)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      assignees: issue.assignees ?? [],
      body: issue.body ?? "",
    }));
}

/**
 * Fetch issues with a specific label from the shared `issues_all` batch.
 *
 * Filters the cached `fetchAllIssues` payload locally — one gh call per
 * repo regardless of how many labels are queried within the TTL window.
 *
 * Issue #1909: removed the per-label fallback that fired when the batch
 * was empty. On a quiet repo (zero open issues) the fallback issued one
 * `gh issue list --label X` per label per iteration without any chance
 * of returning a match — the batch is the source of truth, and an empty
 * batch means there are no labelled issues to find.
 *
 * Known limitation: `fetchAllIssues` defaults to a 100-issue limit. A
 * repo with more than 100 open issues whose labelled subset falls
 * outside the first 100 will under-report here. This limitation exists
 * pre-#1909 too — the old fallback only fired on `allIssues.length ===
 * 0`, so it never rescued the >100 case either. If that case becomes
 * load-bearing, raise the `fetchAllIssues` limit (a single larger batch
 * is still one call).
 *
 * @param repo - Repository in "owner/repo" format
 * @param label - Label to filter by
 * @param cache - Optional cache instance
 * @param limit - Maximum issues to return (default: 50)
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Issues with the specified label
 */
export async function fetchIssuesByLabel(
  repo: string,
  label: string,
  cache?: IssueCache,
  limit = 50,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<FilterableIssue[]> {
  const allIssues = await fetchAllIssues(repo, cache, 100, ghCommandFn);
  return allIssues
    .filter((issue) => issue.labels.includes(label))
    .slice(0, limit);
}

/**
 * Fetch open PRs by user with base/head branch info.
 *
 * @param repo - Repository in "owner/repo" format
 * @param githubUser - GitHub username
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @param forceRefresh - When true, bypass the cache read and fetch live
 *   from GitHub, then overwrite the cache with the fresh result (Issue
 *   #3150). Used by the live claim-time re-check so a stale `prs_${user}`
 *   entry written at discovery cannot hide a just-opened sibling PR.
 * @returns Array of open PRs
 */
export async function fetchOpenPRsByUser(
  repo: string,
  githubUser: string,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  forceRefresh = false,
): Promise<OpenPR[]> {
  const cacheKey = `prs_${githubUser}`;

  if (cache && !forceRefresh) {
    const cached = await cache.read<OpenPR[]>(repo, cacheKey);
    if (cached) return cached;
  }

  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--author",
    githubUser,
    "--json",
    "number,title,baseRefName,headRefName",
    "--limit",
    "10",
  ]);

  // Issue #4024: stamp the queried author onto each PR so a blocking
  // decision can report who owns the PR and whether the PR-maintenance
  // scans cover them.
  const prs = parsePRListJson(output).map((pr) => ({
    ...pr,
    author: githubUser,
  }));
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}

/**
 * Fetch open PRs across every fleet account (Issue #3100).
 *
 * The open-PR duplicate guard must see PRs raised by *any* fleet account,
 * not just the current host — otherwise a second host opens a duplicate PR
 * for the same issue (Issue #3095). This calls `fetchOpenPRsByUser` once per
 * distinct author and concatenates the results, de-duplicating by PR number.
 *
 * Reusing the per-author helper keeps the per-user cache keys (`prs_${user}`)
 * intact and needs no new GitHub JSON fields. Empty/blank authors are skipped.
 *
 * @param repo - Repository in "owner/repo" format
 * @param authors - Fleet GitHub usernames (deduplicated internally)
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @param perAuthorOut - Optional map populated with each author's open-PR
 *   count (Issue #3138 guard observability). Keyed by the author login as
 *   supplied; existing keys are overwritten.
 * @param forceRefresh - When true, bypass the per-user cache read and fetch
 *   each author's PRs live (Issue #3150). Threaded through to
 *   `fetchOpenPRsByUser` so the live claim-time re-check sees just-opened
 *   sibling PRs regardless of a stale discovery-time cache entry.
 * @returns De-duplicated array of open PRs across all fleet authors
 */
export async function fetchOpenPRsForFleet(
  repo: string,
  authors: string[],
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  perAuthorOut?: Record<string, number>,
  forceRefresh = false,
): Promise<OpenPR[]> {
  const distinctAuthors = [
    ...new Set(authors.filter((a) => a && a.trim().length > 0)),
  ];

  const seen = new Set<number>();
  const merged: OpenPR[] = [];
  for (const author of distinctAuthors) {
    const prs = await fetchOpenPRsByUser(
      repo,
      author,
      cache,
      ghCommandFn,
      forceRefresh,
    );
    if (perAuthorOut) perAuthorOut[author] = prs.length;
    for (const pr of prs) {
      if (!seen.has(pr.number)) {
        seen.add(pr.number);
        merged.push(pr);
      }
    }
  }
  return merged;
}

/**
 * Fetch all open PRs for a repo, regardless of author (Issue #1787).
 *
 * Used by helpers that need to look up PRs by head branch or by issue
 * reference in the title without restricting to worker-authored PRs.
 * Cache key is `prs_open_all`; pair with the iteration-scoped
 * `IssueCache` so the per-iteration `gh pr list` count drops to one.
 */
export async function fetchAllOpenPRs(
  repo: string,
  cache?: IssueCache,
  limit = 50,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<OpenPRWithBody[]> {
  const cacheKey = "prs_open_all";

  if (cache) {
    const cached = await cache.read<OpenPRWithBody[]>(repo, cacheKey);
    if (cached) return cached;
  }

  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    "number,title,baseRefName,headRefName,body,url",
    "--limit",
    String(limit),
  ]);

  // Never cache a failure (Issue #4257): "no open PRs" is the answer that
  // marks a branch deletion safe, so a failed call must throw rather than
  // masquerade as it.
  assertListOutput(output, `fetchAllOpenPRs(${repo})`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const prs: OpenPRWithBody[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      baseRefName: typeof item.baseRefName === "string" ? item.baseRefName : "",
      headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
      body: typeof item.body === "string" ? item.body : "",
      url: typeof item.url === "string" ? item.url : "",
    });
  }

  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}

/**
 * PR state values accepted by branch-keyed and title-search helpers
 * (Issue #1795). The narrow union mirrors the values `gh pr list
 * --state` accepts.
 */
export type PRStateFilter = "open" | "closed" | "merged";

/**
 * PR shape returned by the title-search helper (Issue #1795). Includes
 * `mergedAt` so callers can distinguish closed-not-merged from merged
 * PRs without an extra `gh pr view` call. `closedAt` lets callers apply
 * a cooldown window for closed PRs (Issue #1796).
 */
export interface TitleSearchPR {
  number: number;
  title: string;
  baseRefName: string;
  headRefName: string;
  mergedAt: string | null;
  closedAt: string | null;
}

/**
 * Minimal PR shape returned by the all-state branch helper
 * (Issue #1795). Matches the existing `hasExistingMilestoneSummaryPr`
 * call site which only needs `number,title,headRefName`.
 */
export interface BranchPR {
  number: number;
  title: string;
  headRefName: string;
}

/**
 * Fetch open/closed/merged PRs whose head branch is `branchName`
 * (Issue #1795).
 *
 * Wraps `gh pr list --head <branch> --state <state>`. Cache key is
 * namespaced by both branch and state so per-branch checks across
 * different states do not collide. Pair with the iteration-scoped
 * `IssueCache` so repeated per-branch lookups (e.g. branch-cleanup
 * scans, PR-link checks) collapse to one network call per
 * (branch, state) pair.
 *
 * Returns an empty array on parse failure rather than throwing so
 * callers can apply fail-safe behaviour matching the existing inline
 * implementations.
 */
export async function fetchPRsByBranch(
  repo: string,
  branchName: string,
  state: PRStateFilter,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<OpenPR[]> {
  const cacheKey = `prs_branch_${state}_${branchName}`;

  if (cache) {
    const cached = await cache.read<OpenPR[]>(repo, cacheKey);
    if (cached) return cached;
  }

  let output: string;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branchName,
      "--state",
      state,
      "--json",
      "number,title,baseRefName,headRefName",
      "--limit",
      "50",
    ]);
  } catch {
    return [];
  }

  const prs = parsePRListJson(output);
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}

/**
 * Fetch closed PRs whose head branch is `branchName`, with merge state
 * (Issue #3152).
 *
 * `gh pr list --state closed` returns BOTH closed-not-merged and merged
 * PRs, so the query includes `mergedAt` to let callers distinguish the
 * two. Used by the PR-creation path to detect a prior attempt's
 * closed-unmerged PR on the deterministic branch and reuse it (reopen)
 * rather than opening a duplicate.
 *
 * Cache key is `prs_branch_closedmerge_${branchName}` — distinct from the
 * state-keyed `fetchPRsByBranch` cache so the two never collide.
 *
 * Returns an empty array on parse failure rather than throwing so callers
 * can apply fail-safe behaviour.
 */
export async function fetchClosedPRsByBranch(
  repo: string,
  branchName: string,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<ClosedPRWithMerge[]> {
  if (!branchName) return [];

  const cacheKey = `prs_branch_closedmerge_${branchName}`;
  if (cache) {
    const cached = await cache.read<ClosedPRWithMerge[]>(repo, cacheKey);
    if (cached) return cached;
  }

  let output: string;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branchName,
      "--state",
      "closed",
      "--json",
      "number,title,mergedAt,closedAt",
      "--limit",
      "50",
    ]);
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const prs: ClosedPRWithMerge[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      mergedAt: typeof item.mergedAt === "string" ? item.mergedAt : null,
      closedAt: typeof item.closedAt === "string" ? item.closedAt : null,
    });
  }

  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}

/**
 * Invalidate the `fetchPRsByBranch` cache entry for a given
 * (branch, state) pair (Issue #1795). Use after creating, closing, or
 * merging a PR for that branch.
 */
export async function invalidatePRsByBranch(
  cache: IssueCache,
  repo: string,
  branchName: string,
  state: PRStateFilter,
): Promise<void> {
  await cache.invalidate(repo, `prs_branch_${state}_${branchName}`);
}

/**
 * Fetch PRs in the given state whose title references `issueNumber`
 * (Issue #1795).
 *
 * Wraps the standard worker title-search expression
 * `in:title (#N) OR in:title (Issue #N)` so per-issue lookups across
 * `stuck_recovery.ts` and `stuck_detection.ts` share a single cached
 * result per (issue, state) pair. Cache key is
 * `prs_title_${state}_${issueNumber}` — distinct from the user-keyed
 * `prs_${user}` shape so worker-author-only queries do not pollute
 * this all-author cache.
 *
 * Returns an empty array on parse failure rather than throwing.
 */
export async function fetchPRsForIssueByTitle(
  repo: string,
  issueNumber: number,
  state: PRStateFilter,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<TitleSearchPR[]> {
  const cacheKey = `prs_title_${state}_${issueNumber}`;

  if (cache) {
    const cached = await cache.read<TitleSearchPR[]>(repo, cacheKey);
    if (cached) return cached;
  }

  const search =
    `in:title (#${issueNumber}) OR in:title (Issue #${issueNumber})`;

  let output: string;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      state,
      "--search",
      search,
      "--json",
      "number,title,baseRefName,headRefName,mergedAt,closedAt",
      "--limit",
      "50",
    ]);
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const prs: TitleSearchPR[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      baseRefName: typeof item.baseRefName === "string" ? item.baseRefName : "",
      headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
      mergedAt: typeof item.mergedAt === "string" ? item.mergedAt : null,
      closedAt: typeof item.closedAt === "string" ? item.closedAt : null,
    });
  }

  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}

/**
 * Invalidate the `fetchPRsForIssueByTitle` cache entry for a given
 * (issue, state) pair (Issue #1795). Use after creating, closing, or
 * merging a PR linked to that issue.
 */
export async function invalidatePRsForIssueByTitle(
  cache: IssueCache,
  repo: string,
  issueNumber: number,
  state: PRStateFilter,
): Promise<void> {
  await cache.invalidate(repo, `prs_title_${state}_${issueNumber}`);
}

/**
 * Fetch all-state PRs whose head branch is `branchName` (Issue #1795).
 *
 * Wraps `gh pr list --state all --head <branch> --limit 100`. Used by
 * `hasExistingMilestoneSummaryPr` (`milestone_completion.ts`) which
 * needs to detect a PR for the milestone branch in any state to avoid
 * recreating one. Cache key is `prs_all_branch_${branchName}` —
 * distinct from the per-state branch helper so an all-state lookup
 * does not poison or get poisoned by single-state caches.
 *
 * Returns an empty array on parse failure rather than throwing.
 */
export async function fetchAllStatePRsByBranch(
  repo: string,
  branchName: string,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<BranchPR[]> {
  const cacheKey = `prs_all_branch_${branchName}`;

  if (cache) {
    const cached = await cache.read<BranchPR[]>(repo, cacheKey);
    if (cached) return cached;
  }

  let output: string;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--head",
      branchName,
      "--json",
      "number,title,headRefName",
      "--limit",
      "100",
    ]);
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const prs: BranchPR[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
    });
  }

  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}

/**
 * Invalidate the `fetchAllStatePRsByBranch` cache entry for the given
 * branch (Issue #1795).
 */
export async function invalidateAllStatePRsByBranch(
  cache: IssueCache,
  repo: string,
  branchName: string,
): Promise<void> {
  await cache.invalidate(repo, `prs_all_branch_${branchName}`);
}

/**
 * Fetch all-state issues for a given milestone number (Issue #1795).
 *
 * Wraps `gh issue list --milestone <number> --state all`. Used by
 * `hasExistingMilestoneTrackingIssue` (`milestone_completion.ts`) so
 * the worker can detect an existing tracking issue without re-issuing
 * a global title-search per scan. Cache key is
 * `issues_all_milestone_${milestoneNumber}`.
 *
 * Returns an empty array on parse failure rather than throwing.
 */
export async function fetchAllStateIssuesByMilestone(
  repo: string,
  milestoneNumber: number,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<Array<{ number: number; title: string }>> {
  const cacheKey = `issues_all_milestone_${milestoneNumber}`;

  if (cache) {
    const cached = await cache.read<Array<{ number: number; title: string }>>(
      repo,
      cacheKey,
    );
    if (cached) return cached;
  }

  let output: string;
  try {
    output = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--milestone",
      String(milestoneNumber),
      "--state",
      "all",
      "--json",
      "number,title",
      "--limit",
      "100",
    ]);
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const issues: Array<{ number: number; title: string }> = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    issues.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
    });
  }

  if (cache) await cache.write(repo, cacheKey, issues);
  return issues;
}

/**
 * Invalidate the `fetchAllStateIssuesByMilestone` cache entry for the
 * given milestone number (Issue #1795).
 */
export async function invalidateAllStateIssuesByMilestone(
  cache: IssueCache,
  repo: string,
  milestoneNumber: number,
): Promise<void> {
  await cache.invalidate(repo, `issues_all_milestone_${milestoneNumber}`);
}

/**
 * Recent merged PR with file-change count (Issue #1799).
 */
export interface RecentMergedPR {
  number: number;
  title: string;
  changedFiles: number;
}

/**
 * Fetch recent merged PRs across all authors (Issue #1799).
 *
 * Used by `recent_activity.ts` to summarise recent repository activity
 * for prompt context. Cache key is `prs_recent_merged_${limit}` so
 * different limits do not collide. Cache TTL inherits from the supplied
 * `IssueCache` instance.
 */
export async function fetchRecentMergedPRs(
  repo: string,
  limit = 10,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<RecentMergedPR[]> {
  const cacheKey = `prs_recent_merged_${limit}`;

  if (cache) {
    const cached = await cache.read<RecentMergedPR[]>(repo, cacheKey);
    if (cached) return cached;
  }

  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--json",
    "number,title,changedFiles",
    "--limit",
    String(limit),
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const prs: RecentMergedPR[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      changedFiles: typeof item.changedFiles === "number"
        ? item.changedFiles
        : 0,
    });
  }

  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}

/**
 * Fetch merged PRs by a given user (Issue #1787).
 *
 * Used by branch cleanup, merged-PR-driven issue closure, and the
 * closed-PR self-healing path. Cache key is `prs_merged_${user}`.
 */
export async function fetchMergedPRsByUser(
  repo: string,
  githubUser: string,
  cache?: IssueCache,
  limit = 30,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<MergedPR[]> {
  const cacheKey = `prs_merged_${githubUser}`;

  if (cache) {
    const cached = await cache.read<MergedPR[]>(repo, cacheKey);
    if (cached) return cached;
  }

  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--author",
    githubUser,
    "--json",
    "number,title,headRefName",
    "--limit",
    String(limit),
  ]);

  // Never cache a failure (Issue #4257): the old `|| "[]"` fallback turned
  // a failed call's empty output into a cacheable empty list, and branch
  // cleanup / close-issues then saw a repo with no merged PRs for the TTL.
  assertListOutput(output, `fetchMergedPRsByUser(${repo})`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const prs: MergedPR[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
    });
  }

  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}

/**
 * Check if a specific issue is blocked by an open PR (milestone-aware).
 *
 * - Only **fleet-authored** PRs block. A human's open PR never defers an
 *   issue: the developer manages their own PR, and one unrelated human PR
 *   must not park a repo's whole `work-on` queue (Issue #4133).
 * - Milestone issues are only blocked by PRs targeting their milestone branch
 * - Non-milestone issues are only blocked by PRs targeting a non-milestone branch
 * - Milestone-merge PRs (merging milestone into default) are excluded
 *
 * The fleet's own open PRs keep the repo-wide one-at-a-time rule, so the
 * worker never runs ahead of itself and creates merge hell.
 *
 * The returned info carries the PR's `author` (Issue #4078) so callers can
 * name the PR that deferred the issue.
 *
 * @param prs - Array of open PRs
 * @param milestoneTitle - The issue's milestone title (empty if none)
 * @param pushCapableAuthors - The fleet's push-capable logins
 *   (`resolveFleetMaintenanceAuthorSet`: host login + `fleet_pr_authors`).
 *   PRs authored outside this set are ignored. Pass `[]` only where the
 *   set is genuinely unavailable — an empty set cannot classify anything,
 *   so every PR keeps blocking (fail-safe, see {@link isHumanAuthoredPr}).
 * @returns Blocking PR info, or null if not blocked
 */
export function getBlockingPRForIssue(
  prs: OpenPR[],
  milestoneTitle: string,
  pushCapableAuthors: readonly string[],
): BlockingPRInfo | null {
  if (prs.length === 0) return null;

  // Issue #4133: someone else's PR is not the worker's work stream.
  const fleetPrs = prs.filter(
    (pr) => !isHumanAuthoredPr(pr.author, pushCapableAuthors),
  );
  if (fleetPrs.length === 0) return null;

  if (milestoneTitle !== "") {
    // Milestone issue: only blocked by PRs targeting the same milestone branch
    const milestoneBranch = createMilestoneBranchName(milestoneTitle);
    const blocking = fleetPrs.find((pr) => pr.baseRefName === milestoneBranch);
    return blocking ? toBlockingPRInfo(blocking) : null;
  }

  // Non-milestone issue: blocked by PRs NOT targeting milestone branches
  // and NOT milestone-merge PRs
  const blocking = fleetPrs.find((pr) => {
    const base = pr.baseRefName ?? "";
    const head = pr.headRefName ?? "";
    if (base.startsWith("milestone/")) return false;
    if (head.startsWith("milestone/") || head.includes("merge-milestone")) {
      return false;
    }
    return true;
  });

  return blocking ? toBlockingPRInfo(blocking) : null;
}

/** Project an open PR onto the blocking-guard result shape (Issue #4078). */
function toBlockingPRInfo(pr: OpenPR): BlockingPRInfo {
  return {
    number: pr.number,
    title: pr.title,
    author: typeof pr.author === "string" ? pr.author.trim() : "",
  };
}

/**
 * Fetch the current labels for a single issue, with optional caching
 * (Issue #1787).
 *
 * Wraps `gh issue view --json labels` so multiple per-issue label
 * checks within one iteration share one network call. The cache key
 * is namespaced by issue number (`issue_labels_${num}`); pair with a
 * short TTL on the supplied `IssueCache` (60–300s recommended) so
 * mutations elsewhere are visible quickly.
 *
 * Returns `null` on parse/validation failure so callers can apply
 * fail-safe behaviour matching the existing inline implementations.
 */
export async function fetchIssueLabels(
  repo: string,
  issueNumber: number,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<string[] | null> {
  const cacheKey = `issue_labels_${issueNumber}`;

  if (cache) {
    const cached = await cache.read<string[]>(repo, cacheKey);
    if (cached) return cached;
  }

  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "labels",
    ]);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const validated = validateIssueLabelsJson(parsed);
  if (!validated.ok) return null;

  const labels = validated.value.labels.map((l) => l.name);
  if (cache) await cache.write(repo, cacheKey, labels);
  return labels;
}

/**
 * Check if an issue has the ignore-open-prs label added by an allowed author.
 *
 * Issue #1787: routes the per-issue label fetch through the new
 * `fetchIssueLabels` helper so duplicate reads across the candidate
 * collectors (each one calls `hasIgnoreOpenPRsLabel` for blocked
 * issues) collapse to one `gh issue view` call per iteration.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param ignoreLabel - The ignore-open-prs label name
 * @param allowedAuthors - Authorised GitHub usernames
 * @param ghCommandFn - Optional gh command function for testing
 * @param cache - Optional timeline cache for read-through label-author check
 * @param issueCache - Optional issue cache for read-through label fetch
 * @returns True if the label was added by an allowed author
 */
export async function hasIgnoreOpenPRsLabel(
  repo: string,
  issueNumber: number,
  ignoreLabel: string,
  allowedAuthors: string[],
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  cache?: TimelineCache,
  issueCache?: IssueCache,
): Promise<boolean> {
  const labels = await fetchIssueLabels(
    repo,
    issueNumber,
    issueCache,
    ghCommandFn,
  );
  if (labels === null) return false;
  if (!labels.includes(ignoreLabel)) return false;

  // Verify label was added by an allowed author
  return await wasLabelAddedByAllowedAuthor(
    repo,
    issueNumber,
    ignoreLabel,
    allowedAuthors,
    ghCommandFn,
    cache,
  );
}

/**
 * Information about the most recent "labeled" event for a given label.
 */
export interface LabelLastAddInfo {
  /** Unix timestamp (seconds) when the label was last added. */
  addedAt: number;
  /** GitHub username that added the label. */
  addedBy: string;
}

/**
 * Fetch (or read from cache) the parsed timeline label events for the
 * given issue (Issue #1673).
 *
 * Centralises the cache-then-API path used by both
 * `wasLabelAddedByAllowedAuthor` and `getLabelLastAddInfo`. On cache
 * hit returns the parsed events without calling `gh`; on miss issues
 * a single `gh api .../timeline` call, parses, validates, and writes
 * the result back to the cache.
 *
 * Errors and validation failures fall through to a `null` return so
 * each caller can apply its own fail-safe behaviour.
 */
export async function fetchTimelineWithCache(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
  cache?: TimelineCache,
): Promise<TimelineLabelEventJson[] | null> {
  if (cache) {
    const cached = await cache.read(repo, issueNumber);
    if (cached !== null) return cached;
  }

  let raw: string;
  try {
    // Use per_page=100 so recent events (including label removals) are not
    // truncated to the default 30-item page. Without this, an issue with
    // many events can miss the developer's most recent `needs-human` removal,
    // causing `isNonWorkerRemovalAfterRound` to see only a stale removal
    // that pre-dates the current round — returning false and re-adding the
    // label even though the developer has signalled "go" (Issue #1878).
    raw = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/timeline?per_page=100`,
    ]);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const validated = validateTimelineLabelEventsJson(parsed);
  if (!validated.ok) return null;

  // This reads only page 1 (the oldest 100 events), so cache it as a
  // *partial* timeline (Issue #3296). The reserved-label trust gate
  // (`wasLabelAddedByAllowedAuthor`) will not honour a partial entry and
  // re-paginates instead, so a truncated slice can never bypass the gate.
  if (cache) await cache.write(repo, issueNumber, validated.value, false);
  return validated.value;
}

/**
 * Get information about the most recent "labeled" event for the given label
 * on the given issue (Issue #1561).
 *
 * Used to detect re-approval: if a trusted author re-adds the work-on label
 * after the worker captured a content snapshot, the later label-add event
 * indicates a fresh approval and the stored snapshot should be refreshed
 * rather than triggering a false "Issue Modified After Approval" alarm.
 *
 * Issue #1673: When `cache` is provided, reads from the file-backed TTL
 * cache before issuing a `gh api .../timeline` call.
 *
 * @returns `{ addedAt, addedBy }` when the timeline contains a "labeled"
 *   event for this label with a parseable timestamp, otherwise `null`.
 */
export async function getLabelLastAddInfo(
  repo: string,
  issueNumber: number,
  labelName: string,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  cache?: TimelineCache,
): Promise<LabelLastAddInfo | null> {
  const timeline = await fetchTimelineWithCache(
    repo,
    issueNumber,
    ghCommandFn,
    cache,
  );
  if (timeline === null) return null;
  return lastAddInfoFromTimeline(timeline, labelName);
}

/**
 * Extract the most-recent `labeled` event for `labelName` from an already
 * fetched timeline. Shared by {@link getLabelLastAddInfo} (page-1, best
 * effort) and {@link getLabelLastAddInfoComplete} (exhaustive).
 */
function lastAddInfoFromTimeline(
  timeline: TimelineLabelEventJson[],
  labelName: string,
): LabelLastAddInfo | null {
  const labelEvents = timeline.filter(
    (e) => e.event === "labeled" && e.label?.name === labelName,
  );
  const lastEvent = labelEvents[labelEvents.length - 1];
  if (!lastEvent?.actor?.login) return null;
  if (!lastEvent.created_at) return null;

  const ms = Date.parse(lastEvent.created_at);
  if (Number.isNaN(ms)) return null;

  return {
    addedAt: Math.floor(ms / 1000),
    addedBy: lastEvent.actor.login,
  };
}

/**
 * Exhaustive variant of {@link getLabelLastAddInfo} for callers that **mutate**
 * on the answer (Issue #3709, SEC-c41e97b60238).
 *
 * `getLabelLastAddInfo` reads page 1 only and honours a partial cache entry —
 * fine for best-effort re-approval hints, but not for
 * `stripUntrustedWorkOnLabel`, which removes a label and names the adder in a
 * public comment. On a busy issue (>100 timeline events) the genuinely
 * most-recent `labeled` event falls beyond page 1, so a page-1 read can name
 * the wrong actor and strip a label a trusted author has since re-applied.
 *
 * This variant uses exactly the source of truth the sibling trust gate uses:
 * a fully paginated timeline, refusing partial cache entries. Errors and page
 * caps propagate so the caller can fail closed.
 */
export async function getLabelLastAddInfoComplete(
  repo: string,
  issueNumber: number,
  labelName: string,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  cache?: TimelineCache,
): Promise<LabelLastAddInfo | null> {
  const timeline = await fetchCompleteTimeline(
    repo,
    issueNumber,
    ghCommandFn,
    cache,
  );
  if (timeline === null) return null;
  return lastAddInfoFromTimeline(timeline, labelName);
}

/**
 * Information about the most recent "unlabeled" event for a given label.
 */
export interface LabelLastRemoveInfo {
  /** Unix timestamp (seconds) when the label was last removed. */
  removedAt: number;
  /** GitHub username that removed the label. */
  removedBy: string;
}

/**
 * Get information about the most recent "unlabeled" event for the given
 * label on the given issue (Issue #1878).
 *
 * Used by the grill-me processor to detect when a non-worker user has
 * explicitly removed `needs-human` after a Round N comment was posted —
 * that removal is the developer's "go" signal even if no separate reply
 * comment was authored. Without this signal the worker keeps re-adding
 * `needs-human` whenever the user removes it, producing the
 * "constantly labelling as needs-human" loop the issue reports.
 *
 * Mirrors `getLabelLastAddInfo` but inspects `unlabeled` events instead
 * of `labeled`. When `cache` is provided, reads from the file-backed
 * TTL cache before issuing a `gh api .../timeline` call.
 *
 * @returns `{ removedAt, removedBy }` when the timeline contains an
 *   `unlabeled` event for this label with a parseable timestamp,
 *   otherwise `null`.
 */
export async function getLabelLastRemoveInfo(
  repo: string,
  issueNumber: number,
  labelName: string,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  cache?: TimelineCache,
): Promise<LabelLastRemoveInfo | null> {
  const timeline = await fetchTimelineWithCache(
    repo,
    issueNumber,
    ghCommandFn,
    cache,
  );
  if (timeline === null) return null;

  const labelEvents = timeline.filter(
    (e) => e.event === "unlabeled" && e.label?.name === labelName,
  );
  const lastEvent = labelEvents[labelEvents.length - 1];
  if (!lastEvent?.actor?.login) return null;
  if (!lastEvent.created_at) return null;

  const ms = Date.parse(lastEvent.created_at);
  if (Number.isNaN(ms)) return null;

  return {
    removedAt: Math.floor(ms / 1000),
    removedBy: lastEvent.actor.login,
  };
}

/**
 * REST timeline page size (the GitHub API maximum) and the hard page cap used
 * by the paginated reserved-label trust gate (Issue #3200). Mirrors the
 * constants in `verifyOperationalLabels` (Issue #3165): a full page at the cap
 * means more events may exist than we can read, so the gate fails closed rather
 * than honour a possibly-stale trusted add.
 */
const TIMELINE_PER_PAGE = 100;
const MAX_TIMELINE_PAGES = 100;

/**
 * Read the REST timeline to exhaustion, writing the result to `cache` as a
 * **complete** entry (Issue #3200, extracted in Issue #3709).
 *
 * Deliberately does not read from the cache: callers differ on what a cached
 * entry may be used for, so the cache-read policy stays with them.
 *
 * @returns every timeline event, or null when a page fails validation.
 * @throws when `ghCommandFn` fails, a page is unparseable, or the timeline
 *   exceeds {@link MAX_TIMELINE_PAGES} — failing closed rather than acting on
 *   a timeline that could not be read in full.
 */
async function paginateTimeline(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
  cache?: TimelineCache,
): Promise<TimelineLabelEventJson[] | null> {
  const timeline: TimelineLabelEventJson[] = [];
  for (let page = 1; page <= MAX_TIMELINE_PAGES; page++) {
    const timelineJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/timeline?per_page=${TIMELINE_PER_PAGE}&page=${page}`,
    ]);
    const parsedTimeline: unknown = JSON.parse(timelineJson);
    const timelineValidated = validateTimelineLabelEventsJson(parsedTimeline);
    if (!timelineValidated.ok) return null;
    const pageEvents = timelineValidated.value;
    timeline.push(...pageEvents);
    if (pageEvents.length < TIMELINE_PER_PAGE) {
      // A short (or empty) page is the last page — stop paginating.
      break;
    }
    if (page === MAX_TIMELINE_PAGES) {
      // A full page at the cap means more events may exist beyond what we can
      // read. Throw rather than honour a possibly-stale trusted add — the
      // caller's contract is to surface (not swallow) an unresolvable timeline.
      throw new Error(
        `timeline exceeded ${MAX_TIMELINE_PAGES} pages — failing closed`,
      );
    }
  }

  // Paginated to exhaustion, so mark the cached entry complete (Issue #3296).
  if (cache) await cache.write(repo, issueNumber, timeline, true);
  return timeline;
}

/**
 * Fetch the full timeline for an issue, preferring a **complete** cache entry
 * (Issue #3709).
 *
 * Unlike {@link fetchTimelineWithCache} this never returns a page-1-only
 * slice: a partial cache entry is refused and the REST timeline is paginated
 * to exhaustion instead. Use it wherever a decision depends on the genuinely
 * most-recent timeline event.
 */
export async function fetchCompleteTimeline(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  cache?: TimelineCache,
): Promise<TimelineLabelEventJson[] | null> {
  if (cache) {
    const cached = await cache.readComplete(repo, issueNumber);
    if (cached !== null) return cached;
  }
  return await paginateTimeline(repo, issueNumber, ghCommandFn, cache);
}

/**
 * Check if a label was added by an allowed author.
 *
 * Security check: verifies the label was added by an authorised user
 * to prevent unauthorised users from directing the worker.
 *
 * Issue #1673: When `cache` is provided, reads from the file-backed TTL
 * cache before issuing a `gh api .../timeline` call. Cache misses fall
 * through to the API path and store the result for subsequent reads.
 *
 * Fleet-worker exclusion (Issue #3416): in a multi-account fleet, sibling
 * worker logins are required to appear in `allowedAuthors` (the PR-dedup
 * requirement — see `resolveFleetAuthors` / `fleet_pr_authors`). Left
 * unchecked, that lets a reserved discovery label (`work-on`,
 * `top-priority`, `low-priority`) a worker applied directly (bypassing the
 * `addLabelToIssue` allowlist) be honoured fleet-wide instead of stripped —
 * contradicting the documented backstop in `worker_label_guard.ts`. Any
 * login in `fleetWorkerLogins` is therefore treated as untrusted, mirroring
 * `verifyOperationalLabels` (Issue #3225). Defaults to `[]` so non-fleet
 * callers keep the original behaviour exactly.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param labelName - Label to check
 * @param allowedAuthors - Authorised GitHub usernames
 * @param ghCommandFn - Optional gh command function for testing
 * @param cache - Optional timeline cache for read-through
 * @param fleetWorkerLogins - Fleet worker logins (own host + siblings) excluded from label-adder trust (Issue #3416)
 * @returns True if the label was added by an allowed author
 */
export async function wasLabelAddedByAllowedAuthor(
  repo: string,
  issueNumber: number,
  labelName: string,
  allowedAuthors: string[],
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  cache?: TimelineCache,
  fleetWorkerLogins: string[] = [],
): Promise<boolean> {
  // A cache hit may only *deny* trust, never grant it (Issue #3709,
  // SEC-e70b8134af26).
  //
  // The cache is a file under TMPDIR. `TimelineCache` now binds that directory
  // to the worker's own account (per-user path, 0700, ownership-checked), but
  // a cache is still the wrong sole basis for a trust decision: any path by
  // which an attacker-authored entry reaches the cache would otherwise make an
  // attacker-applied `work-on` label look trusted, with no API call to
  // contradict it. Denials carry no such risk — the worst case is a redundant
  // live read — and denial is the dominant outcome during a scan, so this
  // keeps the Issue #1673 N+1 collapse while removing the escalation path.
  //
  // Issue #3296: only a *complete* (fully paginated) cached timeline is even
  // considered. A partial page-1-only entry — written by
  // `fetchTimelineWithCache` — is truncated to the oldest 100 events, so on a
  // busy issue (>100 timeline events) it can hide the genuinely most-recent
  // reserved-label add behind a stale one.
  if (cache) {
    const cached = await cache.readComplete(repo, issueNumber);
    if (
      cached !== null &&
      !labelMatchesAllowedAuthor(
        cached,
        labelName,
        allowedAuthors,
        fleetWorkerLogins,
      )
    ) {
      return false;
    }
  }

  // No cache, a cache miss, or a cached entry that would have granted trust —
  // confirm against the API. We deliberately do NOT use
  // `fetchTimelineWithCache` here because the historical contract is to
  // surface API errors to the caller (assertRejects in existing tests),
  // whereas the cache-then-API helper swallows them.
  //
  // `paginateTimeline` reads the REST timeline to exhaustion (mirroring
  // verifyOperationalLabels, Issue #3165). The timeline API returns events
  // oldest-first, capped at 100 per page (the API maximum). Issue #3089 raised
  // the page size from 30 to 100 but still read only a single page, so on a
  // busy issue the genuinely most-recent reserved-label add (work-on /
  // top-priority / low-priority) could fall beyond page 1 and be missed —
  // leaving only a stale trusted add inside the window and bypassing this
  // trust gate (Issue #3200). Reading every page guarantees the last
  // `labeled` event is the true most-recent one.
  const timeline = await paginateTimeline(
    repo,
    issueNumber,
    ghCommandFn,
    cache,
  );
  if (timeline === null) return false;

  return labelMatchesAllowedAuthor(
    timeline,
    labelName,
    allowedAuthors,
    fleetWorkerLogins,
  );
}

/**
 * Shared timeline-search logic used by both the cached and uncached
 * paths of `wasLabelAddedByAllowedAuthor`.
 */
function labelMatchesAllowedAuthor(
  timeline: TimelineLabelEventJson[],
  labelName: string,
  allowedAuthors: string[],
  fleetWorkerLogins: string[] = [],
): boolean {
  const labelEvents = timeline.filter(
    (e) => e.event === "labeled" && e.label?.name === labelName,
  );
  const lastEvent = labelEvents[labelEvents.length - 1];
  if (!lastEvent?.actor?.login) return false;

  const adder = lastEvent.actor.login.toLowerCase();
  // Issue #3416: a fleet worker login (own host + siblings) must appear in
  // allowedAuthors for PR-dedup, but must never be trusted to self-apply a
  // reserved discovery label — treat it as untrusted so it is stripped,
  // mirroring the operational-label backstop (verifyOperationalLabels, #3225).
  if (fleetWorkerLogins.some((a) => a.toLowerCase() === adder)) return false;
  return allowedAuthors.some((a) => a.toLowerCase() === adder);
}

// =============================================================================
// Recently-closed PR blocking (Issue #1427)
// =============================================================================

/**
 * Parse raw gh pr list JSON for closed PRs into ClosedPR array.
 *
 * @param jsonStr - Raw JSON string from gh CLI
 * @returns Parsed closed PRs
 */
export function parseClosedPRListJson(jsonStr: string): ClosedPR[] {
  try {
    const raw: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(raw)) return [];
    // Inline runtime shape guard (Issue #1532).
    const items: ClosedPR[] = [];
    for (const item of raw) {
      if (!isRecord(item)) continue;
      if (typeof item.number !== "number") continue;
      if (typeof item.title !== "string") continue;
      items.push({
        number: item.number,
        title: item.title,
        closedAt: typeof item.closedAt === "string" ? item.closedAt : "",
      });
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Fetch closed PRs by a user (Issue #1809).
 *
 * Used by repo-wide closed-PR scans (e.g. stuck_recovery's
 * `detectAssignedWithClosedPr`) so per-issue title-search calls
 * collapse to one `gh pr list` per repo. Cache key is
 * `prs_closed_${user}`. Pair with the iteration-scoped `IssueCache`.
 *
 * The richer `{ number, title, mergedAt, closedAt }` shape is also
 * read by `fetchRecentlyClosedPRsByUser` (Issue #1427) which filters
 * locally by cooldown, so both helpers share one network call.
 *
 * @param repo - Repository in "owner/repo" format
 * @param githubUser - GitHub username
 * @param limit - Maximum PRs to fetch (default: 100)
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Array of closed PRs with merge state
 */
export async function fetchClosedPRsByUser(
  repo: string,
  githubUser: string,
  limit = 100,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<ClosedPRWithMerge[]> {
  const cacheKey = `prs_closed_${githubUser}`;

  if (cache) {
    const cached = await cache.read<ClosedPRWithMerge[]>(repo, cacheKey);
    if (cached) return cached;
  }

  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "closed",
    "--author",
    githubUser,
    "--json",
    "number,title,mergedAt,closedAt",
    "--limit",
    String(limit),
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const prs: ClosedPRWithMerge[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      mergedAt: typeof item.mergedAt === "string" ? item.mergedAt : null,
      closedAt: typeof item.closedAt === "string" ? item.closedAt : null,
    });
  }

  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}

/**
 * Invalidate the `fetchClosedPRsByUser` / `fetchRecentlyClosedPRsByUser`
 * cache entry (Issue #1809). Use after closing or merging a PR authored
 * by `githubUser` so a follow-up scan in the same iteration sees the
 * fresh state.
 */
export async function invalidateClosedPRsByUser(
  repo: string,
  githubUser: string,
  cache: IssueCache,
): Promise<void> {
  await cache.invalidate(repo, `prs_closed_${githubUser}`);
}

/**
 * Fetch recently-closed (not merged) PRs by a user within a cooldown window.
 *
 * Used to prevent the worker from immediately re-creating a PR for an issue
 * whose previous PR was just closed (Issue #1427).
 *
 * Issue #1809: reads through `fetchClosedPRsByUser` so this helper and
 * the repo-wide closed-PR scan in `stuck_recovery.ts` share one
 * `prs_closed_${user}` cache and one network call per iteration.
 *
 * @param repo - Repository in "owner/repo" format
 * @param githubUser - GitHub username
 * @param cooldownSeconds - Only return PRs closed within this many seconds
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Array of recently-closed PRs
 */
export async function fetchRecentlyClosedPRsByUser(
  repo: string,
  githubUser: string,
  cooldownSeconds: number,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<ClosedPR[]> {
  const all = await fetchClosedPRsByUser(
    repo,
    githubUser,
    100,
    cache,
    ghCommandFn,
  );

  // Filter to only include PRs closed within the cooldown window.
  const cutoffMs = Date.now() - (cooldownSeconds * 1000);
  const recent: ClosedPR[] = [];
  for (const pr of all) {
    if (!pr.closedAt) continue;
    if (new Date(pr.closedAt).getTime() < cutoffMs) continue;
    recent.push({
      number: pr.number,
      title: pr.title,
      closedAt: pr.closedAt,
      merged: pr.mergedAt !== null && pr.mergedAt !== "",
    });
  }
  return recent;
}

/**
 * Fetch the fleet-wide set of PRs that should block re-picking up an issue
 * (Issue #3151).
 *
 * Mirrors `fetchOpenPRsForFleet` for the closed/merged side of the
 * duplicate-PR guard. The single-account `fetchRecentlyClosedPRsByUser`
 * missed a PR merged or closed by a **sibling** fleet account, so after a
 * sibling merged a PR the issue was re-picked-up and a second PR opened
 * (the Failure Mode B in #3136). Unions across every supplied fleet author
 * (typically `[githubUser, ...allowedAuthors, ...fleetPrAuthors]`) two
 * classes of PR:
 *
 *   - **Merged** PRs — included regardless of age. Once any fleet PR for an
 *     issue merges, that issue is done for the fleet: re-pickup requires a
 *     human to re-open the issue or re-apply the discovery label. Marked
 *     `merged: true` so the skip is *permanent*, not cooldown-windowed.
 *   - **Closed-unmerged** PRs — included only when closed within
 *     `cooldownSeconds`, so the retry path stays available once the window
 *     elapses. Marked `merged: false`.
 *
 * `gh pr list --state closed` returns both closed-unmerged and merged PRs
 * (merged PRs carry a non-null `mergedAt`), so one `fetchClosedPRsByUser`
 * call per author covers both classes — no extra `gh` calls beyond the
 * per-author closed-PR fetch the guard already makes. Results are
 * de-duplicated by PR number; a merged classification always wins over a
 * closed-unmerged one for the same number. Empty/blank authors are skipped.
 *
 * @param repo - Repository in "owner/repo" format
 * @param authors - Fleet GitHub usernames (deduplicated internally)
 * @param cooldownSeconds - Closed-unmerged PRs older than this are excluded;
 *   merged PRs are always included regardless
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @returns De-duplicated closed/merged PRs across all fleet authors
 */
export async function fetchRecentlyClosedPRsForFleet(
  repo: string,
  authors: string[],
  cooldownSeconds: number,
  cache?: IssueCache,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<ClosedPR[]> {
  const distinctAuthors = [
    ...new Set(authors.filter((a) => a && a.trim().length > 0)),
  ];

  const cutoffMs = Date.now() - (cooldownSeconds * 1000);
  const byNumber = new Map<number, ClosedPR>();

  for (const author of distinctAuthors) {
    const all = await fetchClosedPRsByUser(
      repo,
      author,
      100,
      cache,
      ghCommandFn,
    );
    for (const pr of all) {
      const isMerged = pr.mergedAt !== null && pr.mergedAt !== "";
      if (isMerged) {
        // Merged fleet PR → permanent skip, regardless of cooldown window.
        byNumber.set(pr.number, {
          number: pr.number,
          title: pr.title,
          closedAt: pr.closedAt ?? pr.mergedAt ?? "",
          merged: true,
        });
        continue;
      }
      // Closed-unmerged → retry path: only block within the cooldown window.
      if (!pr.closedAt) continue;
      if (new Date(pr.closedAt).getTime() < cutoffMs) continue;
      // Never downgrade a PR already classified as merged for this number.
      if (byNumber.get(pr.number)?.merged) continue;
      byNumber.set(pr.number, {
        number: pr.number,
        title: pr.title,
        closedAt: pr.closedAt,
        merged: false,
      });
    }
  }

  return [...byNumber.values()];
}

/**
 * Check if an issue is blocked by a recently-closed PR (Issue #1427).
 *
 * Matches the issue number in the PR title using common patterns:
 * - "(#N)" — standard issue reference
 * - "Issue #N" — alternative format
 * - "#N" at end of title
 *
 * Uses word-boundary matching to avoid partial number matches
 * (e.g., issue #42 must not match PR title containing #421).
 *
 * @param closedPRs - Array of recently-closed PRs
 * @param issueNumber - The issue number to check
 * @returns The blocking closed PR, or null if not blocked
 */
export function isBlockedByRecentlyClosedPR(
  closedPRs: ClosedPR[],
  issueNumber: number,
): ClosedPR | null {
  if (closedPRs.length === 0) return null;

  const issueStr = String(issueNumber);
  // Match #N followed by non-digit or end-of-string, or (#N)
  const pattern = new RegExp(`#${issueStr}(?:[^0-9]|$)|\\(#${issueStr}\\)`);

  return closedPRs.find((pr) => pattern.test(pr.title)) ?? null;
}
