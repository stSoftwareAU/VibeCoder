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
import { logAt } from "./log_sink.ts";

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
 * for the extra `gh` call. A number in neither listing is read with
 * `gh api repos/<owner>/<repo>/issues/<n>`, which answers for pull requests
 * too. A merged or closed pull request has landed (`landedDependencies`)
 * and is not warned about. A number that does not exist is still named,
 * once, in one warn log line for the cycle. Any other lookup failure is
 * thrown.
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
      landedDependencies: [],
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
  const landedDependencies: number[] = [];
  const lookedUpClosed: { number: number; milestone: string | null }[] = [];
  const missing: number[] = [];
  for (const number of unresolved) {
    let raw: string;
    try {
      raw = await ghCommandFn(["api", `repos/${repo}/issues/${number}`]);
    } catch (err) {
      if (isMissingIssue(err)) {
        missing.push(number);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw lookupFailure(repo, number, `failed: ${message}`);
    }
    const looked = parseDirectIssueLookup(raw, repo, number);
    if (isLandedPullRequest(looked)) {
      landedDependencies.push(number);
      continue;
    }
    if (looked.state === "closed") {
      lookedUpClosed.push({ number, milestone: looked.milestone });
    }
  }

  // One line per cycle, not one line per number.
  if (missing.length > 0) {
    logAt(
      log,
      "warn",
      `milestone deadlock detection could not resolve ` +
        `${missing.map((n) => `#${n}`).join(", ")} in ${repo} — not in ` +
        `the open listing, the recent closed listing, or a direct issue lookup`,
    );
  }

  return {
    openIssues,
    closedDependencies: [...closedDependencies, ...lookedUpClosed],
    openMilestones: new Set(openMilestones),
    landedDependencies,
  };
}

/** A `GET /repos/{owner}/{repo}/issues/{n}` body. Pull requests carry `pull_request`. */
interface DirectIssueLookup {
  state: "open" | "closed";
  pullRequest: boolean;
  /** True when `pull_request.merged_at` is a timestamp. */
  merged: boolean;
  milestone: string | null;
}

function lookupFailure(repo: string, number: number, detail: string): Error {
  return new Error(
    `milestone deadlock detection: direct lookup of #${number} in ${repo} ${detail}`,
  );
}

/** True when this issue-number lookup 404s. Any other failure must be thrown. */
function isMissingIssue(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("404") || message.includes("Not Found");
}

function isLandedPullRequest(looked: DirectIssueLookup): boolean {
  return looked.pullRequest && (looked.state === "closed" || looked.merged);
}

function parseDirectIssueLookup(
  raw: string,
  repo: string,
  number: number,
): DirectIssueLookup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw lookupFailure(repo, number, `returned invalid JSON: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw lookupFailure(
      repo,
      number,
      "returned a payload that was not an object",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.number !== number) {
    throw lookupFailure(
      repo,
      number,
      `returned number ${JSON.stringify(record.number)}, expected ${number}`,
    );
  }
  if (!Object.hasOwn(record, "state")) {
    throw lookupFailure(repo, number, "returned no 'state' field");
  }
  const state = record.state;
  if (state !== "open" && state !== "closed") {
    throw lookupFailure(
      repo,
      number,
      `returned state ${JSON.stringify(state)}`,
    );
  }
  if (!Object.hasOwn(record, "milestone")) {
    throw lookupFailure(repo, number, "returned no 'milestone' field");
  }
  const pullRequest = Object.hasOwn(record, "pull_request") &&
    record.pull_request != null;
  let merged = false;
  if (pullRequest) {
    if (
      typeof record.pull_request !== "object" ||
      Array.isArray(record.pull_request)
    ) {
      throw lookupFailure(
        repo,
        number,
        "returned 'pull_request' that was not an object",
      );
    }
    const pull = record.pull_request as Record<string, unknown>;
    if (!Object.hasOwn(pull, "merged_at")) {
      throw lookupFailure(
        repo,
        number,
        "returned no 'pull_request.merged_at' field",
      );
    }
    if (pull.merged_at !== null) {
      if (typeof pull.merged_at !== "string" || pull.merged_at === "") {
        throw lookupFailure(
          repo,
          number,
          "returned 'pull_request.merged_at' that was not a timestamp or null",
        );
      }
      merged = true;
    }
  }
  return {
    state,
    pullRequest,
    merged,
    milestone: milestoneTitle(record.milestone, repo, number),
  };
}

function milestoneTitle(
  milestone: unknown,
  repo: string,
  number: number,
): string | null {
  if (milestone === null) return null;
  if (typeof milestone !== "object" || Array.isArray(milestone)) {
    throw lookupFailure(
      repo,
      number,
      "returned 'milestone' that was not an object or null",
    );
  }
  const title = (milestone as Record<string, unknown>).title;
  if (typeof title !== "string" || title === "") {
    throw lookupFailure(repo, number, "returned a milestone with no title");
  }
  return title;
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
      logAt(
        o.log,
        "warn",
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
          logAt(
            o.log,
            "warn",
            `partial rollup for '${deadlock.milestone}' in ` +
              `${o.repo} failed: ${result.reason}`,
          );
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAt(
        o.log,
        "warn",
        `could not raise a partial rollup for milestone ` +
          `'${deadlock.milestone}' in ${o.repo}: ${message} (Issue #2835)`,
      );
    }
  }
}
