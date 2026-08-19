/**
 * Batched timeline label-event fetcher (Issue #1674).
 *
 * Replaces N per-issue REST timeline calls with one (or
 * `ceil(N/batchSize)`) GraphQL call that returns only the
 * `LabeledEvent` items for many issues at once. The result is
 * converted to the same `{ event, label, actor, created_at }` shape
 * the existing REST timeline path produces, so consumers can be
 * driven with a wrapped `gh` function and need no other changes.
 *
 * Falls back gracefully — on GraphQL failure callers should re-run
 * the per-issue REST path (the existing behaviour).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { withGraphQLSource } from "./gh_call_metrics.ts";
import { runGhCommand } from "./github.ts";
import type { TimelineLabelEventJson } from "./validation.ts";

/**
 * GitHub GraphQL aliasing limit — keep batches well under it. The
 * documented limit is around 100 aliases per request, but the issue
 * specifies 25 to stay comfortably within rate-limit budget and keep
 * each query small.
 */
export const TIMELINE_BATCH_SIZE = 25;

/**
 * Result of a batched timeline fetch.
 */
export type TimelineBatchResult =
  | {
    ok: true;
    /** Map of issue number -> labeled-event timeline (REST shape). */
    events: Map<number, TimelineLabelEventJson[]>;
    /** Number of `gh` GraphQL calls actually issued. */
    callCount: number;
  }
  | {
    ok: false;
    error: Error;
  };

/**
 * Split a "owner/repo" identifier into its components, validating
 * that each component is a safe slug. Inlining unvalidated values
 * into a GraphQL query string would risk injection — the
 * allowlist below mirrors the characters GitHub permits in repo
 * names.
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
 * Build a single GraphQL query that pulls `LabeledEvent` nodes for a
 * batch of issues using aliases (`n0`, `n1`, ...).
 */
export function buildBatchQuery(
  owner: string,
  name: string,
  numbers: number[],
): string {
  const aliases = numbers
    .map(
      (num, i) =>
        // `last: 100` (not `first`) returns the 100 *most recent* labelled
        // events. The trust gate (`wasLabelAddedByAllowedAuthor`) only ever
        // inspects the most-recent `labeled` event, so reading from the tail
        // guarantees that event is always present regardless of how many
        // older labelled events exist. `first: 50` read the *oldest* 50, so a
        // heavily-labelled issue could drop the genuine most-recent add by an
        // untrusted actor and leave a stale trusted add as the apparent last
        // event — bypassing the gate (Issue #3089).
        `n${i}: issue(number: ${num}) {
          timelineItems(itemTypes: [LABELED_EVENT], last: 100) {
            nodes {
              __typename
              ... on LabeledEvent {
                createdAt
                label { name }
                actor { login }
              }
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
  timelineItems?: {
    nodes?: Array<BatchLabeledEventNode | null> | null;
  } | null;
}

interface BatchLabeledEventNode {
  __typename?: string;
  createdAt?: string | null;
  label?: { name?: string | null } | null;
  actor?: { login?: string | null } | null;
}

/**
 * Convert one batch GraphQL response into the same REST-shaped event
 * arrays our existing timeline consumers (`wasLabelAddedByAllowedAuthor`,
 * `verifyOperationalLabels`, `getLabelLastAddInfo`) already understand.
 *
 * Takes the already-narrowed `data.repository` node — the caller has
 * verified it is present — so the converter needs no non-null
 * assertion and the invariant is encoded in the signature.
 */
function convertBatch(
  repo: Record<string, BatchIssueNode | null>,
  numbers: number[],
): Map<number, TimelineLabelEventJson[]> {
  const out = new Map<number, TimelineLabelEventJson[]>();
  for (let i = 0; i < numbers.length; i++) {
    const num = numbers[i];
    if (num === undefined) continue;
    const node = repo[`n${i}`];
    const events: TimelineLabelEventJson[] = [];
    const nodes = node?.timelineItems?.nodes ?? [];
    for (const ev of nodes) {
      if (!ev) continue;
      if (ev.__typename && ev.__typename !== "LabeledEvent") continue;
      const labelName = ev.label?.name;
      const actorLogin = ev.actor?.login;
      if (typeof labelName !== "string") continue;
      const event: TimelineLabelEventJson = {
        event: "labeled",
        label: { name: labelName },
      };
      if (typeof actorLogin === "string") {
        event.actor = { login: actorLogin };
      }
      if (typeof ev.createdAt === "string") {
        event.created_at = ev.createdAt;
      }
      events.push(event);
    }
    out.set(num, events);
  }
  return out;
}

/**
 * Fetch label-event timelines for many issues in a single repo using
 * batched GraphQL calls. Returns a map keyed by issue number with
 * events in REST shape. On any failure (network, parse, malformed
 * response), returns an error result so the caller can fall back.
 */
export async function fetchTimelineBatch(
  repo: string,
  issueNumbers: number[],
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  batchSize: number = TIMELINE_BATCH_SIZE,
): Promise<TimelineBatchResult> {
  if (issueNumbers.length === 0) {
    return { ok: true, events: new Map(), callCount: 0 };
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
  const unique = Array.from(new Set(issueNumbers));
  const merged = new Map<number, TimelineLabelEventJson[]>();
  let callCount = 0;
  const effectiveBatchSize = batchSize > 0 ? batchSize : TIMELINE_BATCH_SIZE;

  for (let i = 0; i < unique.length; i += effectiveBatchSize) {
    const slice = unique.slice(i, i + effectiveBatchSize);
    const query = buildBatchQuery(owner, name, slice);

    let raw: string;
    try {
      // Issue #1924: attribute to "timeline-batch" in the GraphQL summary.
      raw = await withGraphQLSource(
        "timeline-batch",
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

    const batchMap = convertBatch(repoNode, slice);
    for (const [num, events] of batchMap) {
      merged.set(num, events);
    }
  }

  return { ok: true, events: merged, callCount };
}

/**
 * Convenience helper: try to batch-fetch timelines and return a `gh`
 * function whose timeline calls are served from the batch result.
 * If the batch fails (or `issueNumbers` is empty), the supplied base
 * function is returned unchanged so callers transparently fall back
 * to the per-issue REST path.
 */
export async function buildBatchedGh(
  repo: string,
  issueNumbers: number[],
  baseGh: (args: string[]) => Promise<string> = runGhCommand,
): Promise<(args: string[]) => Promise<string>> {
  if (issueNumbers.length === 0) return baseGh;
  const result = await fetchTimelineBatch(repo, issueNumbers, baseGh);
  if (!result.ok) return baseGh;
  return wrapGhWithBatchedTimeline(baseGh, result.events);
}

/**
 * Wrap a `gh` command function so any subsequent call shaped like
 * `["api", "repos/<owner>/<repo>/issues/<n>/timeline"]` is served from
 * a pre-fetched batch instead of issuing a fresh REST call. Calls that
 * do not match (or whose issue is not in the batch) pass through to
 * the underlying function.
 *
 * This lets `verifyOperationalLabels`, `wasLabelAddedByAllowedAuthor`,
 * and `getLabelLastAddInfo` reuse the batched data without any
 * signature changes.
 */
export function wrapGhWithBatchedTimeline(
  baseGh: (args: string[]) => Promise<string>,
  events: Map<number, TimelineLabelEventJson[]>,
): (args: string[]) => Promise<string> {
  // Tolerate an optional query string (e.g. ?per_page=100, Issue #3089) so the
  // hardened REST timeline call still matches and is served from the batch.
  const timelineRe = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/timeline(?:\?.*)?$/;
  return (args: string[]): Promise<string> => {
    if (args.length >= 2 && args[0] === "api") {
      const m = timelineRe.exec(args[1] ?? "");
      if (m) {
        const num = Number(m[1]);
        const cached = events.get(num);
        if (cached !== undefined) {
          return Promise.resolve(JSON.stringify(cached));
        }
      }
    }
    return baseGh(args);
  };
}
