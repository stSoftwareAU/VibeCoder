/**
 * Batched PR branch-state fetcher (Issue #1807, part of #1804).
 *
 * Replaces the per-PR pair of REST calls
 * (`repos/<repo>/compare/<base>...<head>` + `gh pr view --json mergeable`)
 * with a single GraphQL query that returns aheadBy/behindBy and
 * mergeable for every open worker PR in a repo at once.
 *
 * For N open PRs in one repo this turns 2N REST calls into 1 GraphQL
 * call. Callers must retain the per-PR REST pair as a fallback for the
 * GraphQL outage path.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { withGraphQLSource } from "./gh_call_metrics.ts";
import { runGhCommand } from "./github.ts";
import type { IssueCache } from "./issue_cache.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** PR descriptor required to build the GraphQL query. */
export interface PRForBranchState {
  number: number;
  baseRefName: string;
  /**
   * Head branch of the PR (Issue #470). The comparison is asked for as
   * `baseRef { compare(headRef: <this>) }` so `aheadBy`/`behindBy` describe
   * the PR relative to its base. Optional in the type so an older caller
   * still compiles, but a descriptor without it is refused at query-build
   * time rather than answered with a swapped comparison.
   */
  headRefName?: string;
}

/** Per-PR branch state returned by the batch helper. */
export interface PRBranchState {
  /** Commits the PR's head branch is ahead of its base branch. */
  aheadBy: number;
  /** Commits the PR's head branch is behind its base branch. */
  behindBy: number;
  /** GitHub mergeable state (e.g. "MERGEABLE", "CONFLICTING", "UNKNOWN"). */
  mergeable: string;
}

/** Result of a batched PR branch-state fetch. */
export type PRBranchStateBatchResult =
  | {
    ok: true;
    /** Map of PR number -> branch state. */
    states: Map<number, PRBranchState>;
    /** Number of `gh` GraphQL calls actually issued (0 on cache hit). */
    callCount: number;
  }
  | {
    ok: false;
    error: Error;
  };

const CACHE_KEY = "pr_branch_state_batch";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function parseRepo(repo: string): { owner: string; name: string } {
  const slug = /^[A-Za-z0-9._-]+$/;
  const parts = repo.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid repo identifier: ${repo}`);
  }
  const [owner, name] = parts as [string, string];
  if (!slug.test(owner) || !slug.test(name)) {
    throw new Error(`Invalid repo identifier characters: ${repo}`);
  }
  return { owner, name };
}

/**
 * Validate that a ref name is safe to inline into a GraphQL string
 * literal. Git ref names allow alphanumerics, dot, slash, dash, and
 * underscore — anything else (quotes, backslashes, whitespace) is
 * rejected to prevent GraphQL injection.
 */
function validateRefName(ref: string): string {
  if (!/^[A-Za-z0-9._/\-]+$/.test(ref)) {
    throw new Error(`Invalid ref name: ${ref}`);
  }
  return ref;
}

// ---------------------------------------------------------------------------
// GraphQL query building
// ---------------------------------------------------------------------------

/**
 * Build a single GraphQL query that pulls each PR's mergeable state and
 * compare(aheadBy, behindBy) under a per-PR alias (`p0`, `p1`, ...).
 *
 * The compare argument differs per-PR (each PR may target a different
 * base branch), so we cannot use the `pullRequests(states: OPEN)`
 * collection — we alias each PR explicitly by number.
 *
 * Comparison direction (Issue #470). In GitHub's schema the ref the
 * `compare` field hangs off is the comparison **base**, and the `headRef:`
 * argument is the comparison **head**. The counts must therefore be asked
 * for as `baseRef { compare(headRef: <PR head>) }`. Asking the other way
 * round — `headRef { compare(headRef: <base>) }` — is still a *valid*
 * query, and GitHub answers it truthfully for the question actually asked:
 * how the base compares to the head, i.e. the two counts swapped. Nothing
 * errors; the numbers are simply the wrong way round. That swap made every
 * PR with at least one commit look behind its base, so the gated direct
 * merge refused every merge with `behind_target` and priority 1.6
 * re-"updated" the same branches every cycle, for ever.
 *
 * @throws when a PR descriptor carries no head ref — an unorientable
 *   comparison is refused rather than guessed, so the caller falls back to
 *   the per-PR REST pair instead of trusting a swapped answer.
 */
export function buildBatchQuery(
  owner: string,
  name: string,
  prs: PRForBranchState[],
): string {
  const aliases = prs.map((pr, i) => {
    // The base is no longer interpolated into the query, but it is still
    // validated: a ref that fails the allowlist should fail loudly here
    // rather than somewhere downstream.
    validateRefName(pr.baseRefName);
    if (!pr.headRefName) {
      throw new Error(
        `PR #${pr.number} has no head ref, so its ahead/behind comparison ` +
          `cannot be oriented (Issue #470)`,
      );
    }
    const head = validateRefName(pr.headRefName);
    return `p${i}: pullRequest(number: ${pr.number}) {
        number
        headRefName
        baseRefName
        mergeable
        baseRef {
          compare(headRef: "${head}") {
            aheadBy
            behindBy
          }
        }
      }`;
  }).join("\n");
  return `query { repository(owner: "${owner}", name: "${name}") { ${aliases} } }`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface BatchResponse {
  data?: {
    repository?: Record<string, BatchPRNode | null> | null;
  };
}

interface BatchPRNode {
  number?: number;
  mergeable?: string | null;
  /**
   * Comparison hung off the **base** ref with the PR head as its argument,
   * so `aheadBy`/`behindBy` describe the PR relative to its base
   * (Issue #470).
   */
  baseRef?: {
    compare?: {
      aheadBy?: number;
      behindBy?: number;
    } | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Public helper
// ---------------------------------------------------------------------------

/**
 * Fetch ahead/behind/mergeable state for many PRs in a single GraphQL
 * call. Returns a map keyed by PR number. On any failure (network,
 * parse, malformed response, GraphQL errors payload), returns an error
 * result so the caller can fall back to per-PR REST calls.
 *
 * Optionally caches the result map under the supplied IssueCache. The
 * cache key is per-repo so re-entry inside the same iteration is free.
 */
export async function fetchPRBranchStateBatch(
  repo: string,
  prs: PRForBranchState[],
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  cache?: IssueCache,
): Promise<PRBranchStateBatchResult> {
  if (prs.length === 0) {
    return { ok: true, states: new Map(), callCount: 0 };
  }

  // Cache check — serialised as an array of [number, PRBranchState] entries.
  if (cache) {
    const cached = await cache.read<Array<[number, PRBranchState]>>(
      repo,
      CACHE_KEY,
    );
    if (cached) {
      return { ok: true, states: new Map(cached), callCount: 0 };
    }
  }

  let owner: string;
  let name: string;
  try {
    ({ owner, name } = parseRepo(repo));
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  let query: string;
  try {
    query = buildBatchQuery(owner, name, prs);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  let raw: string;
  try {
    // Issue #1924: attribute to "pr-branch-state" in the GraphQL summary.
    raw = await withGraphQLSource(
      "pr-branch-state",
      () => ghCommandFn(["api", "graphql", "-f", `query=${query}`]),
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error(`Unexpected GraphQL response: ${raw.slice(0, 200)}`),
    };
  }
  const errs = (parsed as { errors?: unknown }).errors;
  if (errs !== undefined) {
    return {
      ok: false,
      error: new Error(`GraphQL errors: ${JSON.stringify(errs)}`),
    };
  }
  const repoNode = (parsed as BatchResponse).data?.repository;
  if (!repoNode) {
    return {
      ok: false,
      error: new Error("GraphQL response missing data.repository"),
    };
  }

  const states = new Map<number, PRBranchState>();
  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i]!;
    const node = repoNode[`p${i}`];
    if (!node) continue;
    const compare = node.baseRef?.compare ?? null;
    states.set(pr.number, {
      aheadBy: typeof compare?.aheadBy === "number" ? compare.aheadBy : 0,
      behindBy: typeof compare?.behindBy === "number" ? compare.behindBy : 0,
      mergeable: typeof node.mergeable === "string" ? node.mergeable : "",
    });
  }

  if (cache) {
    await cache.write(repo, CACHE_KEY, Array.from(states.entries()));
  }

  return { ok: true, states, callCount: 1 };
}
