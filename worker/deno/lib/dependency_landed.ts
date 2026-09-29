/**
 * Release a cross-milestone-held dependant once its dependency's code has
 * actually landed on the default branch (Issue #2834).
 *
 * `issue_finder_common.ts`'s cross-milestone hold (Issue #2173) keeps a
 * dependant blocked while its closed dependency sits in a different,
 * still-open milestone, because that milestone's merge to the default
 * branch has not happened yet. But the dependency's own code can land
 * early — via its closing PR merging straight to the default branch, or via
 * a partial rollup of the milestone (Issue #2830) — well before the whole
 * milestone closes. This module answers "has the dependency's code already
 * reached the default branch?" so the hold can be released the moment it
 * has, rather than waiting for the entire milestone.
 *
 * Landed is decided by ancestry, never by state alone: the dependency's
 * closing PR's merge commit must be an ancestor of the default branch, or —
 * because a partial rollup may be squash-merged, so the original commit is
 * never itself an ancestor of the default branch — an ancestor of a merged
 * partial-rollup head, checked with the GitHub compare API.
 *
 * Fails safe throughout: any lookup failure reports "not landed" (`false`)
 * rather than releasing the hold against unmerged work, and every failure
 * is logged rather than swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isValidBranchName } from "./repo_rulesets.ts";
import { isValidRepoSlug } from "./repo_slug.ts";
import {
  type GhCommandFn,
  listMergedPartialRollupHeads,
  type PartialRollupLookupOptions,
} from "./milestone_partial_rollup.ts";

export type { GhCommandFn };

/** Answers "has issue `issueNumber`'s dependency code landed?" for one repo. */
export type DependencyLandedLookup = (
  issueNumber: number,
) => Promise<boolean>;

/** Inputs for {@link createDependencyLandedLookup}. */
export interface DependencyLandedOptions {
  /** Sink for fail-safe diagnostics; default: `console.warn`. */
  log?: (message: string) => void;
  /** Passed through to `listMergedPartialRollupHeads` (fleet author check). */
  rollupLookup?: PartialRollupLookupOptions;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** GraphQL query reading the issue's milestone and closing PR merge commits. */
const LANDED_QUERY =
  `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){milestone{title} closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{merged mergeCommit{oid}}}}}}`;

interface GraphQLLandedResponse {
  data?: {
    repository?: {
      issue?: {
        milestone?: { title?: string | null } | null;
        closedByPullRequestsReferences?: {
          nodes?: Array<
            { merged?: boolean; mergeCommit?: { oid?: string | null } | null }
          >;
        };
      };
    };
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `sha` is already an ancestor of `target` (landed relative to it). */
async function isAncestorOf(
  repo: string,
  target: string,
  sha: string,
  ghFn: GhCommandFn,
): Promise<boolean> {
  const status = (await ghFn([
    "api",
    `repos/${repo}/compare/${target}...${sha}`,
    "--jq",
    ".status",
  ])).trim();
  return status === "behind" || status === "identical";
}

/**
 * Build the lazy per-issue dependency-landed lookup behind the cross-milestone
 * hold (Issue #2834).
 *
 * @param repo - Repository in "owner/repo" format.
 * @param defaultBranch - The repo's default branch; when omitted, resolved
 *   lazily on first use and memoised for the lookup's lifetime.
 * @param ghFn - Function to run gh CLI commands.
 * @param options - Diagnostics sink and rollup fleet-author options.
 * @returns A memoised predicate answering "has this issue's dependency landed?"
 */
export function createDependencyLandedLookup(
  repo: string,
  defaultBranch: string | undefined,
  ghFn: GhCommandFn,
  options: DependencyLandedOptions = {},
): DependencyLandedLookup {
  const log = options.log ?? console.warn;
  const memo = new Map<number, Promise<boolean>>();
  let branchPromise: Promise<string> | undefined;

  async function resolveDefaultBranch(): Promise<string> {
    if (defaultBranch !== undefined) return defaultBranch;
    if (!branchPromise) {
      branchPromise = (async () => {
        const raw = await ghFn([
          "api",
          `repos/${repo}`,
          "--jq",
          ".default_branch",
        ]);
        const trimmed = raw.trim();
        if (!trimmed) {
          throw new Error(`repos/${repo} returned no default_branch`);
        }
        return trimmed;
      })();
    }
    return await branchPromise;
  }

  async function compute(issueNumber: number): Promise<boolean> {
    try {
      const branch = await resolveDefaultBranch();
      if (!isValidBranchName(branch)) {
        throw new Error(`default branch "${branch}" failed the allowlist`);
      }

      const slash = repo.indexOf("/");
      const owner = repo.substring(0, slash);
      const name = repo.substring(slash + 1);
      const raw = await ghFn([
        "api",
        "graphql",
        "-f",
        `query=${LANDED_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${issueNumber}`,
      ]);
      const parsed = JSON.parse(raw) as GraphQLLandedResponse;
      const issue = parsed.data?.repository?.issue;

      const mergedShas = (issue?.closedByPullRequestsReferences?.nodes ?? [])
        .filter((node) => node.merged === true)
        .map((node) => node.mergeCommit?.oid)
        .filter((oid): oid is string =>
          typeof oid === "string" && SHA_PATTERN.test(oid)
        );

      if (mergedShas.length === 0) {
        throw new Error("no merged closing PR with a merge commit");
      }

      for (const sha of mergedShas) {
        if (await isAncestorOf(repo, branch, sha, ghFn)) {
          return true;
        }
      }

      const milestoneTitle = issue?.milestone?.title;
      if (milestoneTitle) {
        const heads = await listMergedPartialRollupHeads(
          repo,
          milestoneTitle,
          ghFn,
          options.rollupLookup ?? {},
        );
        for (const head of heads) {
          if (!SHA_PATTERN.test(head)) continue;
          for (const sha of mergedShas) {
            if (await isAncestorOf(repo, head, sha, ghFn)) {
              return true;
            }
          }
        }
      }

      return false;
    } catch (err) {
      log(
        `dependency_landed: ${repo}#${issueNumber} not treated as landed — ${
          errorText(err)
        }`,
      );
      return false;
    }
  }

  return (issueNumber: number): Promise<boolean> => {
    if (
      !isValidRepoSlug(repo) || !Number.isInteger(issueNumber) ||
      issueNumber <= 0
    ) {
      log(
        `dependency_landed: ${repo}#${issueNumber} rejected — invalid repo ` +
          "or issue number",
      );
      return Promise.resolve(false);
    }
    let cached = memo.get(issueNumber);
    if (!cached) {
      cached = compute(issueNumber);
      memo.set(issueNumber, cached);
    }
    return cached;
  };
}
