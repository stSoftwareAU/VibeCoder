/**
 * Batched issue-comment fetcher (Issue #1842).
 *
 * Replaces N per-issue REST `getIssueComments` calls in
 * `stale_workflow_detector.ts` with one (or `ceil(N / batchSize)`)
 * GraphQL call that returns the most-recent comments for many issues
 * at once. The result is converted into the same `GitHubComment[]`
 * shape the existing REST path produces, so callers swap in the batch
 * without other changes.
 *
 * Pattern reference: `worker/deno/lib/timeline_batch.ts` (Issue #1674).
 *
 * On any sub-batch failure the helper records the failed issue numbers
 * and continues — the caller can fall back to per-issue REST for the
 * subset that was not batched, so a single transient GraphQL hiccup
 * does not abort the whole stale scan.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { withGraphQLSource } from "./gh_call_metrics.ts";
import { runGhCommand } from "./github.ts";
import type { GitHubComment } from "../types.ts";

/**
 * GitHub GraphQL aliasing limit — keep batches well under it. Mirrors
 * `TIMELINE_BATCH_SIZE`: 25 keeps each query small and stays
 * comfortably within the rate-limit budget.
 */
export const COMMENT_BATCH_SIZE = 25;

/**
 * Number of comments to fetch per issue. The detector only inspects
 * the most-recent comments to look for the bot marker (`<!--
 * vibe-coder-stale-* -->`) and any author response, so 50 is plenty.
 */
export const COMMENTS_PER_ISSUE = 50;

/**
 * Result of a batched comment fetch.
 *
 * `comments` is keyed by issue number with `GitHubComment[]` values.
 * Issues whose sub-batch failed are listed in `failedNumbers` so the
 * caller can fall back to per-issue REST. `errors` records each
 * sub-batch failure for diagnostics.
 */
export interface CommentBatchResult {
  comments: Map<number, GitHubComment[]>;
  callCount: number;
  errors: Error[];
  failedNumbers: number[];
}

/**
 * Split a "owner/repo" identifier into its components, validating
 * that each component is a safe slug. Inlining unvalidated values
 * into a GraphQL query string would risk injection — the allowlist
 * mirrors the characters GitHub permits in repo names.
 */
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
 * Build a single GraphQL query that pulls the most-recent comments
 * for a batch of issues using aliases (`n0`, `n1`, ...).
 */
export function buildCommentBatchQuery(
  owner: string,
  name: string,
  numbers: number[],
  commentsPerIssue: number = COMMENTS_PER_ISSUE,
): string {
  const aliases = numbers
    .map(
      (num, i) =>
        `n${i}: issue(number: ${num}) {
          comments(last: ${commentsPerIssue}) {
            nodes {
              databaseId
              author { login }
              body
              createdAt
            }
          }
        }`,
    )
    .join("\n");
  return `query { repository(owner: "${owner}", name: "${name}") { ${aliases} } }`;
}

/** GraphQL response shape (only the fields we care about). */
interface BatchResponse {
  data?: {
    repository?: Record<string, BatchIssueNode | null> | null;
  };
}

interface BatchIssueNode {
  comments?: {
    nodes?: Array<BatchCommentNode | null> | null;
  } | null;
}

interface BatchCommentNode {
  databaseId?: number | null;
  author?: { login?: string | null } | null;
  body?: string | null;
  createdAt?: string | null;
}

/**
 * Convert one batch GraphQL response into the same `GitHubComment[]`
 * shape the existing REST `getIssueComments` path produces.
 *
 * Takes the already-narrowed `data.repository` node — the caller has
 * verified it is present — so the converter needs no non-null
 * assertion and the "caller has verified data.repository" invariant is
 * encoded in the signature rather than a comment.
 *
 * Reactions are not exposed by this batch (the stale workflow
 * detector only reads `body`, `author`, and `createdAt`). They
 * default to zero so consumers that read them get a valid object
 * rather than `undefined`.
 */
function convertBatch(
  repo: Record<string, BatchIssueNode | null>,
  numbers: number[],
): Map<number, GitHubComment[]> {
  const out = new Map<number, GitHubComment[]>();
  for (let i = 0; i < numbers.length; i++) {
    const num = numbers[i];
    if (num === undefined) continue;
    const node = repo[`n${i}`];
    const nodes = node?.comments?.nodes ?? [];
    const comments: GitHubComment[] = [];
    for (const cm of nodes) {
      if (!cm) continue;
      const body = typeof cm.body === "string" ? cm.body : "";
      const author = typeof cm.author?.login === "string"
        ? cm.author.login
        : "";
      const createdAt = typeof cm.createdAt === "string" ? cm.createdAt : "";
      const id = typeof cm.databaseId === "number" ? cm.databaseId : 0;
      comments.push({
        id,
        body,
        author,
        createdAt,
        reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
      });
    }
    out.set(num, comments);
  }
  return out;
}

/**
 * Fetch comments for many issues in a single repo using batched
 * GraphQL calls. Returns a map keyed by issue number, the number of
 * GraphQL calls actually issued, and per-batch error/failed-issue
 * lists so the caller can fall back to per-issue REST for the subset
 * that was not batched.
 *
 * An empty `issueNumbers` is a no-op — zero calls, empty map.
 */
export async function fetchCommentBatch(
  repo: string,
  issueNumbers: number[],
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  batchSize: number = COMMENT_BATCH_SIZE,
): Promise<CommentBatchResult> {
  const empty: CommentBatchResult = {
    comments: new Map(),
    callCount: 0,
    errors: [],
    failedNumbers: [],
  };
  if (issueNumbers.length === 0) return empty;

  let owner: string;
  let name: string;
  try {
    ({ owner, name } = parseRepo(repo));
  } catch (err) {
    return {
      comments: new Map(),
      callCount: 0,
      errors: [err instanceof Error ? err : new Error(String(err))],
      failedNumbers: [...issueNumbers],
    };
  }

  // De-duplicate to keep aliases unique.
  const unique = Array.from(new Set(issueNumbers));
  const merged = new Map<number, GitHubComment[]>();
  const errors: Error[] = [];
  const failedNumbers: number[] = [];
  let callCount = 0;
  const effectiveBatchSize = batchSize > 0 ? batchSize : COMMENT_BATCH_SIZE;

  for (let i = 0; i < unique.length; i += effectiveBatchSize) {
    const slice = unique.slice(i, i + effectiveBatchSize);
    const query = buildCommentBatchQuery(owner, name, slice);

    let raw: string;
    try {
      // Issue #1924: attribute to "comments-batch" in the GraphQL summary.
      raw = await withGraphQLSource(
        "comments-batch",
        () => ghCommandFn(["api", "graphql", "-f", `query=${query}`]),
      );
      callCount++;
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
      failedNumbers.push(...slice);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
      failedNumbers.push(...slice);
      continue;
    }

    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      errors.push(
        new Error(`Unexpected GraphQL response: ${raw.slice(0, 200)}`),
      );
      failedNumbers.push(...slice);
      continue;
    }
    const errs = (parsed as { errors?: unknown }).errors;
    if (errs !== undefined) {
      errors.push(new Error(`GraphQL errors: ${JSON.stringify(errs)}`));
      failedNumbers.push(...slice);
      continue;
    }
    const repoNode = (parsed as BatchResponse).data?.repository;
    if (!repoNode) {
      errors.push(new Error("GraphQL response missing data.repository"));
      failedNumbers.push(...slice);
      continue;
    }

    const batchMap = convertBatch(repoNode, slice);
    for (const [num, comments] of batchMap) {
      merged.set(num, comments);
    }
  }

  return { comments: merged, callCount, errors, failedNumbers };
}
