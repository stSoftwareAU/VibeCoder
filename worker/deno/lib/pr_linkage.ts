/**
 * PR linkage detection for stuck-issue recovery (Issue #1887).
 *
 * Combines multiple signals to determine whether an open PR is linked
 * to an issue. A positive result causes recovery to skip the issue
 * (`skipped:open_pr`).
 *
 * Signals (any one is sufficient):
 *   1. `title` — `fetchPRsForIssueByTitle(state="open")`. Cheap and
 *      shared with existing call sites; covers PR titles using the
 *      `(#N)` or `(Issue #N)` suffix.
 *   2. `closing_ref` — GraphQL `closedByPullRequestsReferences` on
 *      the issue. Picks up explicit `Closes/Fixes #N` keywords in
 *      the PR body.
 *   3. `cross_ref` — GraphQL `timelineItems(itemTypes:CROSS_REFERENCED_EVENT)`.
 *      Catches incidental open-PR mentions of the issue.
 *   4. `worker_comment` — A worker-authored comment matching
 *      `Pull request https://github.com/.../pull/N has been created to *      address this issue.`, with PR `N` verified to be currently open.
 *
 * Signals 2–4 share a single GraphQL round-trip, cached per (repo,
 * issue) under `pr_linkage_open_${issueNumber}`.
 *
 * Background: the false-positive recovery on issue #1881 (PR #1882)
 * fired because the PR had merged before the recovery scan ran, so
 * a state-restricted title search returned nothing. The closing
 * reference and worker comment signals catch this class of linkage
 * even when the title search misses.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { withGraphQLSource } from "./gh_call_metrics.ts";
import type { IssueCache } from "./issue_cache.ts";
import { fetchPRsForIssueByTitle } from "./issue_query.ts";

/** Identifier for the signal that detected the linked open PR. */
export type PRLinkageSignal =
  | "title"
  | "closing_ref"
  | "cross_ref"
  | "worker_comment";

/** Result of a PR-linkage scan: an open PR plus the signal that found it. */
export interface OpenLinkedPR {
  /** PR number on the same repository. */
  readonly number: number;
  /** Which signal located the PR. */
  readonly signal: PRLinkageSignal;
}

/**
 * Pattern for the worker-authored "Pull request ... has been created
 * to address this issue." comment shape. The capture group holds the
 * PR number.
 */
const WORKER_COMMENT_PR_RE =
  /Pull request https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+) has been created to address this issue\./;

/**
 * Parse a worker-authored "Pull request ... has been created" comment
 * body and return the referenced PR number, or null when the body
 * does not match the expected shape. Exported for unit testing.
 */
export function parseWorkerCommentPRNumber(body: string): number | null {
  const m = body.match(WORKER_COMMENT_PR_RE);
  if (!m || !m[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

/** Shape of the GraphQL response we consume. */
interface GraphQLLinkageResponse {
  data?: {
    repository?: {
      issue?: {
        closedByPullRequestsReferences?: {
          nodes?: Array<{ number?: number; state?: string }>;
        };
        timelineItems?: {
          nodes?: Array<{
            source?: {
              __typename?: string;
              number?: number;
              state?: string;
            };
          }>;
        };
        comments?: {
          nodes?: Array<{
            author?: { login?: string };
            body?: string;
          }>;
        };
      };
    };
  };
}

/** GraphQL query used to scan the three secondary linkage signals. */
const LINKAGE_QUERY =
  `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number state}} timelineItems(first:50,itemTypes:CROSS_REFERENCED_EVENT){nodes{... on CrossReferencedEvent{source{__typename ... on PullRequest{number state}}}}} comments(last:50){nodes{author{login} body}}}}}`;

/**
 * Run the GraphQL linkage query for `repo#issueNumber`.
 * Returns the parsed payload or null on error.
 */
async function fetchLinkageGraph(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<GraphQLLinkageResponse | null> {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) return null;
  const owner = repo.substring(0, slash);
  const name = repo.substring(slash + 1);

  let raw: string;
  try {
    // Issue #1924: attribute GraphQL spend to "pr-linkage" so the
    // end-of-iteration GraphQL summary names this caller when it
    // dominates the budget.
    raw = await withGraphQLSource("pr-linkage", () =>
      ghFn([
        "api",
        "graphql",
        "-f",
        `query=${LINKAGE_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${issueNumber}`,
      ]));
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `pr_linkage GraphQL failed for ${repo}#${issueNumber}: ${err}`,
    );
    return null;
  }

  if (!raw) return null;
  try {
    return JSON.parse(raw) as GraphQLLinkageResponse;
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `pr_linkage GraphQL parse failed for ${repo}#${issueNumber}: ${err}`,
    );
    return null;
  }
}

/**
 * Return true when PR `prNumber` on `repo` is currently in the OPEN
 * state. Returns false on any error so a flaky API call cannot
 * suppress a legitimate recovery.
 */
async function isPullRequestOpen(
  repo: string,
  prNumber: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  try {
    const json = await ghFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state",
    ]);
    if (!json) return false;
    const parsed = JSON.parse(json) as { state?: string };
    return parsed.state === "OPEN";
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `pr_linkage isPullRequestOpen failed for ${repo}#${prNumber}: ${err}`,
    );
    return false;
  }
}

/**
 * Discover an open PR linked to `repo#issueNumber` using all available
 * signals. Returns the first match, or `null` when no signal applies.
 *
 * Calls (in order):
 *   1. Title search (cached) — covers the worker's `(#N)` /
 *      `(Issue #N)` PR title convention.
 *   2. GraphQL — closing references, cross references, and worker
 *      comments scanned in one round-trip and cached as
 *      `pr_linkage_open_${issueNumber}`.
 *
 * `workerLogin`, when supplied, restricts the worker-comment signal
 * to comments authored by that login. Comments authored by humans
 * referencing a PR are ignored — only the worker's own
 * "Pull request ... has been created" comments count.
 */
export async function findOpenLinkedPR(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
  cache?: IssueCache,
  workerLogin?: string,
): Promise<OpenLinkedPR | null> {
  // Signal 1: title search. Retains its own per-issue cache via
  // `fetchPRsForIssueByTitle` so existing call sites continue to share
  // the result.
  try {
    const titleMatches = await fetchPRsForIssueByTitle(
      repo,
      issueNumber,
      "open",
      cache,
      ghFn,
    );
    const first = titleMatches[0];
    if (first) {
      return { number: first.number, signal: "title" };
    }
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `pr_linkage title search failed for ${repo}#${issueNumber}: ${err}`,
    );
  }

  // Signals 2–4: single GraphQL call covers all three. The cache stores
  // a wrapper so a cached negative (`{ result: null }`) is distinguishable
  // from a cache miss — without this, every issue without a linked PR
  // re-issued the GraphQL query on every recovery scan (Issue #1907).
  // The cache-key version (`_v2`) invalidates the old positive-only
  // entries written by pre-#1907 builds.
  const cacheKey = `pr_linkage_open_v2_${issueNumber}`;
  if (cache) {
    const cached = await cache.read<{ result: OpenLinkedPR | null }>(
      repo,
      cacheKey,
    );
    if (cached && Object.prototype.hasOwnProperty.call(cached, "result")) {
      return cached.result;
    }
  }

  const writeCache = async (result: OpenLinkedPR | null): Promise<void> => {
    if (cache) await cache.write(repo, cacheKey, { result });
  };

  const graph = await fetchLinkageGraph(repo, issueNumber, ghFn);
  const issue = graph?.data?.repository?.issue;

  // Signal 2: closedByPullRequestsReferences (open PRs only).
  const closingNodes = issue?.closedByPullRequestsReferences?.nodes ?? [];
  for (const node of closingNodes) {
    if (
      node && typeof node.number === "number" && node.state === "OPEN"
    ) {
      const result: OpenLinkedPR = {
        number: node.number,
        signal: "closing_ref",
      };
      await writeCache(result);
      return result;
    }
  }

  // Signal 3: CrossReferencedEvent → open PR.
  const timelineNodes = issue?.timelineItems?.nodes ?? [];
  for (const node of timelineNodes) {
    const src = node?.source;
    if (
      src &&
      src.__typename === "PullRequest" &&
      typeof src.number === "number" &&
      src.state === "OPEN"
    ) {
      const result: OpenLinkedPR = {
        number: src.number,
        signal: "cross_ref",
      };
      await writeCache(result);
      return result;
    }
  }

  // Signal 4: worker-authored comment with the canonical "Pull request
  // ... has been created" body, plus a live verification that PR `N`
  // is currently OPEN. Without the verification step a long-since-
  // closed PR would suppress recovery indefinitely.
  const commentNodes = issue?.comments?.nodes ?? [];
  for (const node of commentNodes) {
    if (!node) continue;
    if (workerLogin && node.author?.login !== workerLogin) continue;
    const body = typeof node.body === "string" ? node.body : "";
    const prNumber = parseWorkerCommentPRNumber(body);
    if (prNumber === null) continue;
    if (await isPullRequestOpen(repo, prNumber, ghFn)) {
      const result: OpenLinkedPR = {
        number: prNumber,
        signal: "worker_comment",
      };
      await writeCache(result);
      return result;
    }
  }

  // Cache the negative so the next caller in this iteration (or the
  // next iteration within the TTL) skips the GraphQL round-trip.
  await writeCache(null);
  return null;
}
