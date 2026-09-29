/**
 * Wires the milestone-deadlock detector into a partial rollup (Issue #2835).
 *
 * `milestone_deadlock.ts` finds cross-milestone dependency deadlocks from
 * issue data alone; `milestone_partial_rollup.ts` raises the PR that breaks
 * one. This module is the glue: it builds the dependency graph from live
 * issue listings, runs the detector, and raises (or reports) a partial
 * rollup for every deadlock found.
 *
 * ```mermaid
 * flowchart LR
 *   A[fetch open + closed issues] --> B[build dependency graph]
 *   B --> C[detectMilestoneDeadlocks]
 *   C --> D[createPartialRollup]
 *   D -- created --> E[arm via armCreatedPr]
 *   D -- exists --> F[log PR number]
 *   D -- deferred --> G[log reason]
 *   D -- failed --> H[log WARNING]
 * ```
 *
 * Deliberately does **not** import `milestone_completion.ts` — that module
 * imports this one to wire the scan into `processRepoMilestones`, and a
 * back-import would form a cycle.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { createMilestoneBranchName } from "./git_branch.ts";
import { extractDependencyReferencesDetailed } from "./issue_dependencies.ts";
import { fetchAllClosedIssues, fetchAllIssues } from "./issue_query.ts";
import type { IssueCache } from "./issue_cache.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import {
  createPartialRollup,
  type GhCommandFn,
} from "./milestone_partial_rollup.ts";
import {
  detectMilestoneDeadlocks,
  type MilestoneDependencyGraph,
} from "./milestone_deadlock.ts";

/** Same page size `fetchOpenIssuesByMilestone` uses, so the two share a cache entry. */
const OPEN_ISSUES_LIMIT = 200;

/**
 * Build the {@link MilestoneDependencyGraph} the deadlock detector reads,
 * from live open and (when needed) closed issue listings.
 *
 * Only same-repo dependency references are kept — the Issue #2173 cross-
 * milestone hold applies only within a repository, so a cross-repo
 * `Depends on owner/repo#N` reference is dropped here exactly as
 * `isDependencyBlocked` drops it in `issue_finder_common.ts`.
 *
 * Closed issues are fetched only when at least one open issue depends on a
 * number that is not itself open — a repo with no such candidate never pays
 * for the extra `gh` call. Any candidate resolved in neither listing is
 * named in one WARNING log line: deadlock detection could not tell whether
 * it holds anything, and staying silent about that would be worse than
 * noisy.
 */
export async function buildMilestoneDependencyGraph(
  repo: string,
  openMilestones: readonly string[],
  ghCommandFn: GhCommandFn,
  log: (m: string) => void,
  cache?: IssueCache,
): Promise<MilestoneDependencyGraph> {
  const openIssuesRaw = await fetchAllIssues(
    repo,
    cache,
    OPEN_ISSUES_LIMIT,
    ghCommandFn,
  );

  const openIssues = openIssuesRaw.map((issue) => {
    const dependsOn = extractDependencyReferencesDetailed(issue.body ?? "")
      .filter((ref) =>
        ref.repo === undefined || ref.repo.toLowerCase() === repo.toLowerCase()
      )
      .map((ref) => ref.number);
    return {
      number: issue.number,
      milestone: issue.milestone || null,
      dependsOn,
    };
  });

  const openNumbers = new Set(openIssues.map((issue) => issue.number));
  const candidates = new Set<number>();
  for (const issue of openIssues) {
    for (const dep of issue.dependsOn) {
      if (!openNumbers.has(dep)) candidates.add(dep);
    }
  }

  if (candidates.size === 0) {
    return {
      openIssues,
      closedDependencies: [],
      openMilestones: new Set(openMilestones),
    };
  }

  const closedIssues = await fetchAllClosedIssues(
    repo,
    cache,
    undefined,
    ghCommandFn,
  );
  const closedByNumber = new Map(
    closedIssues.map((issue) => [issue.number, issue]),
  );
  const closedDependencies = [...candidates]
    .filter((n) => closedByNumber.has(n))
    .map((n) => {
      const issue = closedByNumber.get(n)!;
      return { number: issue.number, milestone: issue.milestone || null };
    });

  const unresolved = [...candidates].filter((n) => !closedByNumber.has(n))
    .sort((a, b) => a - b);
  if (unresolved.length > 0) {
    log(
      `WARNING: milestone deadlock detection could not resolve ` +
        `${unresolved.map((n) => `#${n}`).join(", ")} in ${repo} — not in ` +
        `the open listing or the recent closed listing`,
    );
  }

  return {
    openIssues,
    closedDependencies,
    openMilestones: new Set(openMilestones),
  };
}

/** Inputs for {@link raiseDeadlockPartialRollups}. */
export interface DeadlockRollupOptions {
  repo: string;
  defaultBranch: string;
  openMilestones: readonly string[];
  ghCommandFn: GhCommandFn;
  log: (m: string) => void;
  cache?: IssueCache;
  authorOptions?: AlertDedupAuthorOptions;
  /** Arm a freshly created partial rollup through the full-rollup arming path. */
  armCreatedPr: (prUrl: string, snapshotBranch: string) => Promise<void>;
}

/**
 * Detect every cross-milestone deadlock in `repo` and raise (or report) a
 * partial rollup for each. Graph-build failures propagate; a failure raising
 * one deadlock's rollup is logged as a WARNING and never aborts the rest.
 */
export async function raiseDeadlockPartialRollups(
  o: DeadlockRollupOptions,
): Promise<void> {
  // No open milestone means no cross-milestone deadlock is possible — skip
  // the open-issue listing call.
  if (o.openMilestones.length === 0) return;
  const graph = await buildMilestoneDependencyGraph(
    o.repo,
    o.openMilestones,
    o.ghCommandFn,
    o.log,
    o.cache,
  );
  const deadlocks = detectMilestoneDeadlocks(graph);

  for (const deadlock of deadlocks) {
    try {
      o.log(
        `Milestone deadlock: '${deadlock.milestone}' in ${o.repo} holds ` +
          `#${deadlock.heldIssue} behind closed dependency ` +
          `#${deadlock.closedDependency}, blocking open issue(s) ` +
          `${deadlock.blockingOpenIssues.map((n) => `#${n}`).join(", ")} ` +
          `(Issue #2835)`,
      );
      const milestoneBranch = createMilestoneBranchName(deadlock.milestone);
      const result = await createPartialRollup({
        repo: o.repo,
        milestone: deadlock.milestone,
        milestoneBranch,
        defaultBranch: o.defaultBranch,
        ghFn: o.ghCommandFn,
        ...(o.authorOptions !== undefined
          ? { authorOptions: o.authorOptions }
          : {}),
        log: o.log,
      });

      switch (result.outcome) {
        case "created":
          o.log(
            `Partial rollup PR raised for '${deadlock.milestone}' in ` +
              `${o.repo}: ${result.prUrl} (snapshot ${result.snapshotBranch})`,
          );
          await o.armCreatedPr(result.prUrl, result.snapshotBranch);
          break;
        case "exists":
          o.log(
            `Partial rollup for '${deadlock.milestone}' in ${o.repo} ` +
              `already open: PR #${result.prNumber} (snapshot ` +
              `${result.snapshotBranch})`,
          );
          break;
        case "deferred":
          o.log(
            `Partial rollup for '${deadlock.milestone}' in ${o.repo} ` +
              `deferred (${result.reason}): ${result.detail}`,
          );
          break;
        case "failed":
          o.log(
            `WARNING: partial rollup for '${deadlock.milestone}' in ` +
              `${o.repo} failed: ${result.reason}`,
          );
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      o.log(
        `WARNING: could not raise a partial rollup for milestone ` +
          `'${deadlock.milestone}' in ${o.repo}: ${message} (Issue #2835)`,
      );
    }
  }
}
