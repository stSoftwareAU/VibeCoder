/**
 * Batched check-runs + status fetcher (Issue #1806).
 *
 * Replaces the per-PR REST reads — `commits/{sha}/check-runs`,
 * `commits/{sha}/status` and `commits/{sha}/check-suites` — with a single
 * GraphQL query per batch: `statusCheckRollup` for check runs and commit
 * statuses, and `checkSuites` for the head commit's check suites (Issue
 * #4347: a suite such as a `startup_failure` can carry no check run at all).
 * The query batches many PRs per repo via aliases (mirrors
 * `timeline_batch.ts`), reducing N PRs from 3N REST calls to
 * `ceil(N / CHECK_RUNS_BATCH_SIZE)` GraphQL calls.
 *
 * Provides adapters back to the legacy REST shapes
 * (`CheckRunsResponse`, `CombinedStatusResponse`, `CheckRunEntry`) so
 * existing consumers (`determineCiStatus`, `findFailedCiChecks`) are
 * unchanged. On any GraphQL failure callers fall back to the per-PR
 * REST path.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { withGraphQLSource } from "./gh_call_metrics.ts";
import { runGhCommand } from "./github.ts";
import type {
  CheckRun,
  CheckRunsResponse,
  CheckSuite,
  CombinedStatusResponse,
  CommitStatus,
} from "./direct_merge.ts";
import type { CheckRunEntry } from "./pr_maintenance.ts";

/**
 * GitHub GraphQL aliasing limit — keep batches well under it. Mirrors
 * `TIMELINE_BATCH_SIZE` for consistency and rate-limit budget.
 */
export const CHECK_RUNS_BATCH_SIZE = 25;

/** A check run entry as returned by the GraphQL rollup. */
export interface RollupCheckRun {
  databaseId: number;
  name: string;
  /** Lowercased to match REST conventions (e.g. "completed", "in_progress"). */
  status: string;
  /** Lowercased to match REST conventions (e.g. "success", "failure"); null when in progress. */
  conclusion: string | null;
}

/** A status context entry as returned by the GraphQL rollup. */
export interface RollupStatusContext {
  context: string;
  /** Lowercased to match REST conventions (e.g. "success", "pending"). */
  state: string;
}

/**
 * A GitHub Actions check suite (or any other app's suite) on the head commit,
 * as returned by the GraphQL `checkSuites` connection (Issue #4347).
 *
 * A suite exists even when it runs no check run: a workflow that fails at
 * startup is recorded as a completed suite with conclusion `startup_failure`
 * and zero check runs, so the check-run rollup alone cannot see it.
 */
export interface RollupCheckSuite {
  /** The app's slug (e.g. "github-actions"); null when the app is unknown. */
  appSlug: string | null;
  /** Lowercased to match REST conventions (e.g. "completed", "queued"). */
  status: string;
  /** Lowercased (e.g. "success", "startup_failure"); null when not finished. */
  conclusion: string | null;
}

/** Aggregate rollup for a single PR (check-runs + commit statuses + check suites). */
export interface PrRollup {
  /** GraphQL rollup state (uppercase) or null when no rollup is present. */
  rollupState: string | null;
  /**
   * Head commit SHA the rollup was read for, or null when the response
   * carried no commit node. Callers pin the merge to this SHA so a push
   * landing after the read cannot be merged on unevaluated checks
   * (Issue #3946).
   */
  headSha: string | null;
  checkRuns: RollupCheckRun[];
  statusContexts: RollupStatusContext[];
  /**
   * The head commit's check suites, read from the GraphQL `checkSuites`
   * connection. Empty when the response carried no commit node; a response
   * whose commit lacks the connection is malformed and is never read as an
   * empty list (Issue #4347).
   */
  checkSuites: RollupCheckSuite[];
}

/** Result of a batched rollup fetch. */
export type CheckRunsBatchResult =
  | { ok: true; rollups: Map<number, PrRollup>; callCount: number }
  | { ok: false; error: Error };

// ---------------------------------------------------------------------------
// Repo identifier validation (mirrors timeline_batch.ts)
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

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

/**
 * Build a single GraphQL query that pulls `statusCheckRollup` and the
 * head commit's `checkSuites` for a batch of PRs using aliases (`n0`,
 * `n1`, ...).
 */
export function buildCheckRunsBatchQuery(
  owner: string,
  name: string,
  prNumbers: number[],
): string {
  const aliases = prNumbers
    .map(
      (num, i) =>
        `n${i}: pullRequest(number: ${num}) {
          commits(last: 1) { nodes { commit {
            oid
            checkSuites(first: 100) { nodes { app { slug } status conclusion } }
            statusCheckRollup {
              state
              contexts(first: 100) { nodes {
                __typename
                ... on CheckRun { databaseId name status conclusion }
                ... on StatusContext { context state }
              } }
            }
          } } }
        }`,
    )
    .join("\n");
  return `query { repository(owner: "${owner}", name: "${name}") { ${aliases} } }`;
}

// ---------------------------------------------------------------------------
// GraphQL response decoding
// ---------------------------------------------------------------------------

interface BatchResponse {
  data?: {
    repository?: Record<string, BatchPrNode | null> | null;
  };
}

interface BatchPrNode {
  commits?: {
    nodes?: Array<BatchCommitWrapper | null> | null;
  } | null;
}

interface BatchCommitWrapper {
  commit?: {
    oid?: string | null;
    checkSuites?: {
      nodes?: Array<BatchCheckSuiteNode | null> | null;
    } | null;
    statusCheckRollup?: {
      state?: string | null;
      contexts?: {
        nodes?: Array<BatchContextNode | null> | null;
      } | null;
    } | null;
  } | null;
}

interface BatchContextNode {
  __typename?: string;
  // CheckRun fields
  databaseId?: number | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  // StatusContext fields
  context?: string | null;
  state?: string | null;
}

interface BatchCheckSuiteNode {
  app?: { slug?: string | null } | null;
  status?: string | null;
  conclusion?: string | null;
}

/**
 * Decode the head commit's `checkSuites` connection (Issue #4347).
 *
 * No commit node means no suites. A present commit node must carry
 * `checkSuites.nodes` as an array — GraphQL selects the connection and its
 * documented empty state is `nodes: []` — so a missing key, or a null entry,
 * is a malformed response. It throws rather than defaulting to an empty list,
 * because an unread suite could be the failed one.
 */
function decodeCheckSuites(
  commit: BatchCommitWrapper["commit"],
  prNumber: number,
): RollupCheckSuite[] {
  if (!commit) return [];
  const nodes = commit.checkSuites?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(
      `GraphQL response for PR #${prNumber} lacks commit.checkSuites.nodes`,
    );
  }
  return nodes.map((node) => {
    if (!node) {
      throw new Error(
        `GraphQL response for PR #${prNumber} has a null checkSuites node`,
      );
    }
    const slug = node.app?.slug;
    return {
      appSlug: typeof slug === "string" ? slug : null,
      status: typeof node.status === "string" ? node.status.toLowerCase() : "",
      conclusion: typeof node.conclusion === "string"
        ? node.conclusion.toLowerCase()
        : null,
    };
  });
}

/**
 * Convert one batch GraphQL response into per-PR `PrRollup` records.
 *
 * Takes the already-narrowed `data.repository` node — the caller has
 * verified it is present — so the converter needs no non-null
 * assertion and the invariant is encoded in the signature.
 *
 * Throws when a present commit node carries a malformed `checkSuites`
 * connection (see {@link decodeCheckSuites}); the caller turns that into an
 * error result.
 */
function convertBatch(
  repoNode: Record<string, BatchPrNode | null>,
  prNumbers: number[],
): Map<number, PrRollup> {
  const out = new Map<number, PrRollup>();
  for (let i = 0; i < prNumbers.length; i++) {
    const num = prNumbers[i];
    if (num === undefined) continue;
    const prNode = repoNode[`n${i}`];
    const rollup: PrRollup = {
      rollupState: null,
      headSha: null,
      checkRuns: [],
      statusContexts: [],
      checkSuites: [],
    };

    const commitNodes = prNode?.commits?.nodes ?? [];
    const wrapper = commitNodes[0] ?? null;
    const oid = wrapper?.commit?.oid;
    rollup.headSha = typeof oid === "string" && oid !== "" ? oid : null;
    rollup.checkSuites = decodeCheckSuites(wrapper?.commit ?? null, num);
    const checkRollup = wrapper?.commit?.statusCheckRollup ?? null;
    if (checkRollup) {
      rollup.rollupState = checkRollup.state ?? null;
      const contexts = checkRollup.contexts?.nodes ?? [];
      for (const ctx of contexts) {
        if (!ctx) continue;
        if (ctx.__typename === "CheckRun") {
          rollup.checkRuns.push({
            databaseId: typeof ctx.databaseId === "number" ? ctx.databaseId : 0,
            name: typeof ctx.name === "string" ? ctx.name : "",
            status: typeof ctx.status === "string"
              ? ctx.status.toLowerCase()
              : "",
            conclusion: typeof ctx.conclusion === "string"
              ? ctx.conclusion.toLowerCase()
              : null,
          });
        } else if (ctx.__typename === "StatusContext") {
          rollup.statusContexts.push({
            context: typeof ctx.context === "string" ? ctx.context : "",
            state: typeof ctx.state === "string" ? ctx.state.toLowerCase() : "",
          });
        }
      }
    }
    out.set(num, rollup);
  }
  return out;
}

// ---------------------------------------------------------------------------
// fetchCheckRunsBatch — primary batched fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch `statusCheckRollup` and the head commit's `checkSuites` for many PRs
 * in a single repo using batched GraphQL calls. Returns a map keyed by PR
 * number with the rollup data in a normalised shape. On any failure (network,
 * parse, malformed response — including a commit whose `checkSuites` is
 * missing — or GraphQL errors) returns an error result so the caller can
 * fall back to the per-PR REST path.
 */
export async function fetchCheckRunsBatch(
  repo: string,
  prNumbers: number[],
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  batchSize: number = CHECK_RUNS_BATCH_SIZE,
): Promise<CheckRunsBatchResult> {
  if (prNumbers.length === 0) {
    return { ok: true, rollups: new Map(), callCount: 0 };
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

  // De-duplicate to keep aliases unique.
  const unique = Array.from(new Set(prNumbers));
  const merged = new Map<number, PrRollup>();
  let callCount = 0;
  const effectiveBatchSize = batchSize > 0 ? batchSize : CHECK_RUNS_BATCH_SIZE;

  for (let i = 0; i < unique.length; i += effectiveBatchSize) {
    const slice = unique.slice(i, i + effectiveBatchSize);
    const query = buildCheckRunsBatchQuery(owner, name, slice);

    let raw: string;
    try {
      // Issue #1924: attribute to "check-runs" for the GraphQL summary.
      raw = await withGraphQLSource(
        "check-runs",
        () => ghCommandFn(["api", "graphql", "-f", `query=${query}`]),
      );
      callCount++;
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

    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
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

    let batchMap: Map<number, PrRollup>;
    try {
      batchMap = convertBatch(repoNode, slice);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    for (const [num, rollup] of batchMap) {
      merged.set(num, rollup);
    }
  }

  return { ok: true, rollups: merged, callCount };
}

// ---------------------------------------------------------------------------
// Adapters from rollup → legacy REST shapes
// ---------------------------------------------------------------------------

/**
 * Convert a rollup to the legacy `CheckRunsResponse` shape used by
 * `direct_merge.determineCiStatus`, including the head commit's check suites
 * as the REST `check_suites` shape (Issue #4347).
 */
export function rollupToCheckRunsResponse(rollup: PrRollup): CheckRunsResponse {
  const check_runs: CheckRun[] = rollup.checkRuns.map((cr) => ({
    id: cr.databaseId,
    name: cr.name,
    status: cr.status,
    conclusion: cr.conclusion,
  }));
  const check_suites: CheckSuite[] = rollup.checkSuites.map((s) => ({
    app_slug: s.appSlug,
    status: s.status,
    conclusion: s.conclusion,
  }));
  return { total_count: check_runs.length, check_runs, check_suites };
}

/**
 * Convert a rollup to the legacy `CombinedStatusResponse` shape used
 * by `direct_merge.determineCiStatus`.
 *
 * Derives the combined `state` from just the StatusContext nodes —
 * matching the legacy `commits/{sha}/status` REST endpoint, which is
 * scoped to commit statuses only (check runs come from a separate
 * endpoint). When no statuses exist, the legacy API returns `pending`,
 * which is preserved here.
 */
export function rollupToCombinedStatusResponse(
  rollup: PrRollup,
): CombinedStatusResponse {
  const statuses: CommitStatus[] = rollup.statusContexts.map((sc, i) => ({
    id: i,
    state: sc.state,
    context: sc.context,
    description: "",
  }));

  let state = "success";
  if (statuses.length === 0) {
    // Mirror the REST default — no statuses returns "pending"
    state = "pending";
  } else if (
    statuses.some((s) => s.state === "failure" || s.state === "error")
  ) {
    state = "failure";
  } else if (statuses.some((s) => s.state === "pending")) {
    state = "pending";
  }
  return { state, statuses };
}

/**
 * Convert a rollup to the legacy `CheckRunEntry[]` shape used by
 * `pr_maintenance.findFailedPrChecks` / `findFailedCiChecks`. Filters
 * to check runs whose conclusion is in `conclusions` (default
 * `["failure"]`, mirroring the `--jq 'select(.conclusion == "failure")'`
 * filter in the original REST helper). Issue #2914: the CI-fix scan
 * additionally passes `"cancelled"` so an infrastructure-cancelled check
 * is not invisible to it.
 */
export function rollupToFailedCheckRuns(
  rollup: PrRollup,
  conclusions: readonly string[] = ["failure"],
): CheckRunEntry[] {
  return rollup.checkRuns
    .filter((cr) =>
      cr.conclusion !== null && conclusions.includes(cr.conclusion)
    )
    .map((cr) => ({
      id: cr.databaseId,
      name: cr.name,
      status: cr.status,
      conclusion: cr.conclusion ?? "",
    }));
}

// ---------------------------------------------------------------------------
// fetchFailedCheckRunsBatch — convenience helper for pr_maintenance
// ---------------------------------------------------------------------------

/**
 * Batched failed-check-runs fetcher for many PRs in a single repo.
 *
 * Returns a `Map<prNumber, CheckRunEntry[]>` containing only checks
 * whose conclusion is in `conclusions` (default `["failure"]`; Issue
 * #2914 passes `["failure", "cancelled"]` from the CI-fix scan). Returns
 * `null` on any GraphQL failure so the caller can fall back to the
 * per-PR REST helper.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumbers - List of PR numbers to query
 * @param ghCommandFn - Injectable gh runner (defaults to runGhCommand)
 * @param conclusions - Conclusions to keep (default `["failure"]`)
 * @returns Map of failed check runs per PR, or null on failure
 */
export async function fetchFailedCheckRunsBatch(
  repo: string,
  prNumbers: number[],
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  conclusions: readonly string[] = ["failure"],
  observe?: (prNumber: number, rollup: PrRollup) => Promise<void>,
): Promise<Map<number, CheckRunEntry[]> | null> {
  if (prNumbers.length === 0) return new Map();
  const result = await fetchCheckRunsBatch(repo, prNumbers, ghCommandFn);
  if (!result.ok) return null;
  const out = new Map<number, CheckRunEntry[]>();
  for (const [num, rollup] of result.rollups) {
    await observe?.(num, rollup);
    out.set(num, rollupToFailedCheckRuns(rollup, conclusions));
  }
  return out;
}
