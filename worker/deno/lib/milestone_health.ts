/**
 * Milestone health diagnostics.
 *
 * Queries configured repositories for active milestones and produces a
 * structured health report showing per-issue status (closed, assigned,
 * blocked, pending), branch drift information, and an overall summary.
 *
 * Issue #1239: Add milestone health diagnostics command.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { withGraphQLSource } from "./gh_call_metrics.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import type { IssueCache } from "./issue_cache.ts";
import {
  fetchClosedIssuesByMilestone,
  fetchOpenIssuesByMilestone,
  type OpenMilestoneIssue,
} from "./issue_query.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function signature for running gh CLI commands. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** Dependencies for the milestone health check. */
export interface MilestoneHealthDeps {
  /** Repositories to scan (owner/repo format). */
  repos: string[];
  /** Function to execute gh CLI commands. */
  ghCommandFn: GhCommandFn;
  /**
   * Optional IssueCache for read-through (Issue #1786). When provided,
   * closed-issue lookups per milestone reuse the cached payload across
   * concurrent milestones within an iteration.
   */
  cache?: IssueCache;
  /**
   * Where the persistent default-branch cache lives (Issue #964). Defaults
   * to the module's own resolution, so production callers pass nothing; a
   * test names a throwaway path instead of pointing the whole process at
   * one with `Deno.env.set`.
   */
  defaultBranchCachePath?: string;
}

/** Status of a single issue within a milestone. */
export interface MilestoneIssueStatus {
  number: number;
  title: string;
  state: "closed" | "assigned" | "blocked" | "pending";
  assignee?: string;
  blockReason?: string;
}

/** Branch drift information for a milestone. */
export interface MilestoneBranchInfo {
  name: string;
  aheadBy: number;
  behindBy: number;
}

/** Health status for a single milestone. */
export interface MilestoneStatus {
  title: string;
  closedCount: number;
  openCount: number;
  totalCount: number;
  issues: MilestoneIssueStatus[];
  branch?: MilestoneBranchInfo;
  statusSummary: string;
}

/** Health report for a single repository. */
export interface RepoMilestoneHealth {
  repo: string;
  milestones: MilestoneStatus[];
}

/** Top-level milestone health report across all repositories. */
export interface MilestoneHealthReport {
  repos: RepoMilestoneHealth[];
}

/** A GitHub milestone from the API. */
interface GitHubMilestoneApi {
  title: string;
  number: number;
}

/** A closed issue from the gh CLI. */
interface ClosedIssueApi {
  number: number;
  title: string;
}

// ---------------------------------------------------------------------------
// Dependency detection
// ---------------------------------------------------------------------------

/** Simple regex to detect "depends on #NNN" patterns in issue bodies. */
const DEPENDENCY_PATTERN = /depends?\s+on\s+#(\d+)/gi;

/**
 * Extract dependency issue numbers from an issue body.
 */
function extractDependencies(body: string): number[] {
  const deps: number[] = [];
  for (const match of body.matchAll(DEPENDENCY_PATTERN)) {
    deps.push(Number(match[1]));
  }
  return deps;
}

// ---------------------------------------------------------------------------
// Issue classification
// ---------------------------------------------------------------------------

/**
 * Classify an open issue as assigned, blocked, or pending.
 *
 * An issue is blocked if it depends on another issue that is still open.
 * An issue is assigned if it has at least one assignee.
 * Otherwise it is pending (unassigned, unblocked).
 */
function classifyOpenIssue(
  issue: OpenMilestoneIssue,
  openIssueNumbers: Set<number>,
): MilestoneIssueStatus {
  // Check for blocking dependencies
  const deps = extractDependencies(issue.body ?? "");
  const blockingDeps = deps.filter((d) => openIssueNumbers.has(d));

  if (blockingDeps.length > 0) {
    const depRefs = blockingDeps.map((d) => `#${d}`).join(", ");
    return {
      number: issue.number,
      title: issue.title,
      state: "blocked",
      blockReason: `depends on ${depRefs}`,
      assignee: issue.assignees[0],
    };
  }

  if (issue.assignees.length > 0) {
    return {
      number: issue.number,
      title: issue.title,
      state: "assigned",
      assignee: issue.assignees[0]!,
    };
  }

  return {
    number: issue.number,
    title: issue.title,
    state: "pending",
  };
}

// ---------------------------------------------------------------------------
// Branch drift
// ---------------------------------------------------------------------------

/**
 * Fetch branch drift information for a milestone branch.
 *
 * Returns undefined if the branch does not exist.
 *
 * Issue #1805: collapses the previous two REST calls (branch existence
 * check + compare) into a single GraphQL round trip per milestone. A
 * `null` `ref` lookup tells us the branch does not exist without a
 * separate existence call. Falls back to the original REST pair when
 * GraphQL fails.
 */
async function fetchBranchInfo(
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<MilestoneBranchInfo | undefined> {
  const graphqlResult = await fetchBranchInfoGraphQL(
    repo,
    milestoneBranch,
    defaultBranch,
    ghCommandFn,
  );
  if (graphqlResult.ok) {
    return graphqlResult.value;
  }

  // GraphQL fallback: original REST pair.
  return await fetchBranchInfoRest(
    repo,
    milestoneBranch,
    defaultBranch,
    ghCommandFn,
  );
}

interface GraphQLBranchResponse {
  data?: {
    repository?: {
      ref?: {
        compare?: {
          aheadBy: number;
          behindBy: number;
        } | null;
      } | null;
    } | null;
  } | null;
  errors?: Array<{ message: string }>;
}

/**
 * Combined branch existence + compare lookup via GraphQL (Issue #1805).
 *
 * Returns:
 *   - `{ ok: true, value: BranchInfo }` when the branch exists.
 *   - `{ ok: true, value: undefined }` when the branch does not exist
 *     (the `ref` is `null`).
 *   - `{ ok: false }` on any GraphQL error so the caller can fall back
 *     to REST.
 */
async function fetchBranchInfoGraphQL(
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<Result<MilestoneBranchInfo | undefined>> {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    return { ok: false, error: new Error(`Invalid repo: ${repo}`) };
  }

  // Issue #470: the ref the `compare` field hangs off is the comparison
  // **base**, and the `headRef:` argument is the comparison **head**. The
  // drift wanted here is the milestone branch measured against the default
  // branch, so the default ref is the receiver and the milestone ref is the
  // argument. Written the other way round the query still succeeds and
  // still returns two numbers — they are simply swapped, and they then
  // contradicted this function's own REST fallback.
  const query =
    "query($owner:String!,$name:String!,$milestoneRef:String!,$defaultRef:String!){" +
    "repository(owner:$owner,name:$name){" +
    "ref(qualifiedName:$defaultRef){" +
    "compare(headRef:$milestoneRef){aheadBy behindBy}" +
    "}}}";

  let raw: string;
  try {
    // Issue #1924: attribute the milestone branch+compare GraphQL spend
    // to "milestone-health" in the end-of-iteration summary.
    raw = await withGraphQLSource("milestone-health", () =>
      ghCommandFn([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `milestoneRef=refs/heads/${milestoneBranch}`,
        "-F",
        `defaultRef=${defaultBranch}`,
      ]));
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  let parsed: GraphQLBranchResponse;
  try {
    parsed = JSON.parse(raw) as GraphQLBranchResponse;
  } catch {
    return { ok: false, error: new Error("GraphQL response was not JSON") };
  }

  if (parsed.errors && parsed.errors.length > 0) {
    return {
      ok: false,
      error: new Error(parsed.errors.map((e) => e.message).join("; ")),
    };
  }

  const ref = parsed.data?.repository?.ref;
  if (ref === null || ref === undefined) {
    // Branch does not exist — definitive answer, no fallback needed.
    return { ok: true, value: undefined };
  }

  const compare = ref.compare;
  if (
    !compare || typeof compare.aheadBy !== "number" ||
    typeof compare.behindBy !== "number"
  ) {
    return {
      ok: false,
      error: new Error("GraphQL compare payload missing aheadBy/behindBy"),
    };
  }

  // The query above compares from the default ref (base) to the milestone
  // ref (head), matching the REST fallback's `compare/${default}...${milestone}`
  // exactly: `aheadBy` = commits the milestone branch has that default does
  // not, `behindBy` = commits default has that the milestone branch does
  // not. The two paths are held to that agreement by a test (Issue #470).
  return {
    ok: true,
    value: {
      name: milestoneBranch,
      aheadBy: compare.aheadBy,
      behindBy: compare.behindBy,
    },
  };
}

/**
 * REST fallback for branch existence + compare (pre-#1805 path).
 */
async function fetchBranchInfoRest(
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<MilestoneBranchInfo | undefined> {
  try {
    // Check if branch exists
    await ghCommandFn([
      "api",
      `repos/${repo}/branches/${milestoneBranch}`,
    ]);

    // Get comparison
    const compareOutput = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${defaultBranch}...${milestoneBranch}`,
    ]);
    const comparison = JSON.parse(compareOutput) as {
      ahead_by: number;
      behind_by: number;
    };

    return {
      name: milestoneBranch,
      aheadBy: comparison.ahead_by,
      behindBy: comparison.behind_by,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Status summary
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable status summary for a milestone.
 */
function generateStatusSummary(issues: MilestoneIssueStatus[]): string {
  const assignedCount = issues.filter((i) => i.state === "assigned").length;
  const blockedCount = issues.filter((i) => i.state === "blocked").length;
  const pendingCount = issues.filter((i) => i.state === "pending").length;
  const openCount = assignedCount + blockedCount + pendingCount;

  if (openCount === 0) {
    return "Complete — all issues closed";
  }

  const parts: string[] = [];
  if (assignedCount > 0) {
    parts.push(
      `${assignedCount} issue${assignedCount > 1 ? "s" : ""} assigned`,
    );
  }
  if (blockedCount > 0) {
    parts.push(`${blockedCount} blocked`);
  }
  if (pendingCount > 0) {
    parts.push(`${pendingCount} pending`);
  }

  return `In progress — ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Per-repo health check
// ---------------------------------------------------------------------------

/**
 * Get milestone health for a single repository.
 */
async function getRepoMilestoneHealth(
  repo: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
  defaultBranchCachePath?: string,
): Promise<RepoMilestoneHealth> {
  // Get default branch via the persistent (7-day) cache (Issue #1805).
  // The shared `getRepoDefaultBranch` helper checks an in-process memory
  // cache, then a 7-day on-disk cache, before reaching for `gh api`.
  const defaultBranchResult = await getRepoDefaultBranch(
    repo,
    ghCommandFn,
    defaultBranchCachePath,
  );
  if (!defaultBranchResult.ok) {
    throw defaultBranchResult.error;
  }
  const defaultBranch = defaultBranchResult.value;
  if (!defaultBranch) {
    throw new Error("Could not determine default branch");
  }

  // List open milestones
  let milestones: GitHubMilestoneApi[];
  try {
    const msOutput = await ghCommandFn([
      "api",
      `repos/${repo}/milestones`,
    ]);
    milestones = JSON.parse(msOutput) as GitHubMilestoneApi[];
  } catch {
    return { repo, milestones: [] };
  }

  const milestoneStatuses: MilestoneStatus[] = [];

  for (const milestone of milestones) {
    // Fetch closed issues (Issue #1786: cached per-milestone).
    let closedIssues: ClosedIssueApi[] = [];
    try {
      closedIssues = await fetchClosedIssuesByMilestone(
        repo,
        milestone.title,
        cache,
        ghCommandFn,
      );
    } catch {
      // Continue with empty list
    }

    // Fetch open issues via the shared `issues_all` cache (Issue #1805).
    // `fetchOpenIssuesByMilestone` reads through `fetchAllIssues`, so a
    // follow-up scan in the same iteration is free.
    let openIssues: OpenMilestoneIssue[] = [];
    try {
      openIssues = await fetchOpenIssuesByMilestone(
        repo,
        milestone.title,
        cache,
        ghCommandFn,
      );
    } catch {
      // Continue with empty list
    }

    // Build set of open issue numbers for dependency checking
    const openIssueNumbers = new Set(openIssues.map((i) => i.number));

    // Classify all issues
    const issues: MilestoneIssueStatus[] = [];

    for (const issue of closedIssues) {
      issues.push({
        number: issue.number,
        title: issue.title,
        state: "closed",
      });
    }

    for (const issue of openIssues) {
      issues.push(classifyOpenIssue(issue, openIssueNumbers));
    }

    // Sort by issue number for consistent output
    issues.sort((a, b) => a.number - b.number);

    // Fetch branch info
    const milestoneBranch = createMilestoneBranchName(milestone.title);
    const branch = await fetchBranchInfo(
      repo,
      milestoneBranch,
      defaultBranch,
      ghCommandFn,
    );

    const statusSummary = generateStatusSummary(issues);

    milestoneStatuses.push({
      title: milestone.title,
      closedCount: closedIssues.length,
      openCount: openIssues.length,
      totalCount: closedIssues.length + openIssues.length,
      issues,
      branch,
      statusSummary,
    });
  }

  return { repo, milestones: milestoneStatuses };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Get milestone health across all configured repositories.
 *
 * @param deps - Injected dependencies
 * @returns Result with the milestone health report
 */
export async function getMilestoneHealth(
  deps: MilestoneHealthDeps,
): Promise<Result<MilestoneHealthReport>> {
  const { repos, ghCommandFn } = deps;

  if (repos.length === 0) {
    return { ok: true, value: { repos: [] } };
  }

  const repoReports: RepoMilestoneHealth[] = [];

  for (const repo of repos) {
    try {
      const repoHealth = await getRepoMilestoneHealth(
        repo,
        ghCommandFn,
        deps.cache,
        deps.defaultBranchCachePath,
      );
      repoReports.push(repoHealth);
    } catch {
      // Skip repos that fail — continue with remaining repos
      continue;
    }
  }

  return { ok: true, value: { repos: repoReports } };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Emoji indicators for issue states. */
const STATE_EMOJI: Record<MilestoneIssueStatus["state"], string> = {
  closed: "✅",
  assigned: "🔄",
  blocked: "⏳",
  pending: "⏳",
};

/**
 * Format a milestone health report as human-readable text.
 *
 * Matches the output format specified in Issue #1239.
 */
export function formatMilestoneHealthReport(
  report: MilestoneHealthReport,
): string {
  if (report.repos.length === 0) {
    return "No repositories configured for milestone health check.";
  }

  const lines: string[] = [];

  for (const repoReport of report.repos) {
    lines.push(`Repository: ${repoReport.repo}`);

    if (repoReport.milestones.length === 0) {
      lines.push("  No active milestones");
      lines.push("");
      continue;
    }

    for (const ms of repoReport.milestones) {
      lines.push(
        `  Milestone: ${ms.title} (${ms.closedCount}/${ms.totalCount} issues complete)`,
      );

      for (const issue of ms.issues) {
        const emoji = STATE_EMOJI[issue.state];
        let detail = "";

        if (issue.state === "assigned" && issue.assignee) {
          detail = ` (assigned to ${issue.assignee})`;
        } else if (issue.state === "blocked" && issue.blockReason) {
          detail = ` (blocked: ${issue.blockReason})`;
        }

        lines.push(`    ${emoji} #${issue.number}: ${issue.title}${detail}`);
      }

      if (ms.branch) {
        lines.push(
          `    Branch: ${ms.branch.name} (${ms.branch.aheadBy} commits ahead, ${ms.branch.behindBy} behind default)`,
        );
      }

      lines.push(`    Status: ${ms.statusSummary}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
