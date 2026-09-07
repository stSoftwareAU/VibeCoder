/**
 * Cross-repo fleet PR search (Issue #1486).
 *
 * Every open-PR listing in the worker used to ask GitHub the same question
 * once per repo **and** once per author — `gh pr list --repo <one> --author
 * <one>`. With 19 monitored repos, 2 fleet authors and 3 authorised
 * commenters that is ~130 GraphQL-backed listings per cold cycle, all of
 * them answerable by GitHub's search API in a single query: search takes a
 * whole owner and ORs repeated `author:` qualifiers.
 *
 * This module is the search half of the collapse. It issues one
 * `gh api graphql` search per **owner**, pages it to exhaustion, and returns
 * PRs across every repo of that owner with the full field set the per-repo
 * listings return (`baseRefName`, `headRefName`, `headRefOid`,
 * `autoMergeRequest`, `mergeable`, labels, comments and reviews) — REST
 * `gh search prs` cannot do that, GraphQL `search(type: ISSUE)` can.
 *
 * **Never truncates silently.** The search API caps a result set at 1,000
 * matches. A sweep that quietly stopped there would look successful while
 * hiding PRs, which is worse than the calls it saved — so an exhausted page
 * budget or a `hasNextPage` that outlives it is returned as a failure and
 * the caller falls back to the per-repo listings.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { runGhCommand } from "./github.ts";
import { withGraphQLSource } from "./gh_call_metrics.ts";

/** A comment or review body with its author login. */
export interface FleetSearchComment {
  author: { login: string } | null;
  body: string;
}

/**
 * One PR as the cross-repo search returns it.
 *
 * Field-for-field the union the per-repo listings request, so the prefetch
 * can project it into every consumer's cached shape without a second call.
 */
export interface FleetSearchPr {
  /** Owning repository in "owner/repo" format. */
  repo: string;
  number: number;
  title: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  /** GraphQL `MERGEABLE` / `CONFLICTING` / `UNKNOWN`, as `gh pr list` reports. */
  mergeable: string;
  /** Author login, or `""` when GitHub reported none (a deleted account). */
  author: string;
  /** Label names currently on the PR. */
  labels: string[];
  /**
   * Auto-merge request as `gh pr list --json autoMergeRequest` reports it —
   * `null` when auto-merge is not enabled. `mergeMethod` is carried because
   * the maintenance scan reads it to tell an already-enabled PR apart.
   */
  autoMergeRequest: { enabledAt: string | null; mergeMethod: string } | null;
  comments: FleetSearchComment[];
  reviews: FleetSearchComment[];
}

/** Outcome of one owner-wide search. */
export type FleetPrSearchResult =
  | { ok: true; prs: FleetSearchPr[]; calls: number }
  | { ok: false; reason: string; calls: number };

/** Options for {@link searchOpenFleetPrs}. */
export interface FleetPrSearchOptions {
  /** Repository owner (user or organisation login). */
  owner: string;
  /** Author logins to union — repeated `author:` qualifiers are ORed. */
  authors: readonly string[];
  /** Function to run gh commands. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** PRs per page (default 100, GitHub's maximum). */
  pageSize?: number;
  /** Page budget (default 10 = the search API's 1,000-result cap). */
  maxPages?: number;
  /** Comments/reviews fetched per PR (default 100). */
  conversationSize?: number;
}

/** Default page size — GitHub's maximum for a search connection. */
const DEFAULT_PAGE_SIZE = 100;
/** Default page budget: 10 × 100 = the search API's 1,000-result ceiling. */
const DEFAULT_MAX_PAGES = 10;
/** Default comments/reviews fetched per PR. */
const DEFAULT_CONVERSATION_SIZE = 100;

/**
 * Build the search query string for one owner.
 *
 * Repeated `author:` qualifiers are ORed by GitHub search, so every fleet
 * and authorised-commenter login travels in one query. Blank logins are
 * dropped and duplicates removed case-insensitively (GitHub logins are).
 *
 * @param owner - Repository owner (user or organisation).
 * @param authors - Author logins to union.
 * @returns The query string, or `null` when no usable author remains.
 */
export function buildFleetPrSearchQuery(
  owner: string,
  authors: readonly string[],
): string | null {
  const trimmedOwner = owner.trim();
  if (trimmedOwner.length === 0) return null;
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const raw of authors) {
    if (typeof raw !== "string") continue;
    const login = raw.trim();
    if (login.length === 0) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push(login);
  }
  if (logins.length === 0) return null;
  // `user:` matches organisation-owned repos as well as user-owned ones.
  return `is:pr is:open user:${trimmedOwner} ${
    logins.map((l) => `author:${l}`).join(" ")
  }`;
}

/** The paged search document. `$after` is omitted on the first page. */
function buildSearchDocument(conversationSize: number): string {
  return `
query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        baseRefName
        headRefName
        headRefOid
        createdAt
        updatedAt
        isDraft
        mergeable
        author { login }
        repository { nameWithOwner }
        labels(first: 50) { nodes { name } }
        autoMergeRequest { enabledAt mergeMethod }
        comments(first: ${conversationSize}) { nodes { author { login } body } }
        reviews(first: ${conversationSize}) { nodes { author { login } body } }
      }
    }
  }
}`.trim();
}

/** Read a string property, defaulting to `""`. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Project a GraphQL comment/review connection into the flat shape. */
function toComments(value: unknown): FleetSearchComment[] {
  const nodes = (value as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: FleetSearchComment[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const login = str(
      ((node as { author?: { login?: unknown } }).author ?? {}).login,
    );
    out.push({
      author: login === "" ? null : { login },
      body: str((node as { body?: unknown }).body),
    });
  }
  return out;
}

/** Project one GraphQL search node into a {@link FleetSearchPr}. */
function toSearchPr(node: unknown): FleetSearchPr | null {
  if (node === null || typeof node !== "object") return null;
  const rec = node as Record<string, unknown>;
  if (typeof rec.number !== "number") return null;
  const repo = str(
    ((rec.repository ?? {}) as { nameWithOwner?: unknown }).nameWithOwner,
  );
  if (repo === "") return null;
  const labelNodes = ((rec.labels ?? {}) as { nodes?: unknown }).nodes;
  const labels: string[] = [];
  if (Array.isArray(labelNodes)) {
    for (const label of labelNodes) {
      const name = str((label as { name?: unknown } | null)?.name);
      if (name !== "") labels.push(name);
    }
  }
  const autoMerge = rec.autoMergeRequest as
    | { enabledAt?: unknown; mergeMethod?: unknown }
    | null
    | undefined;
  return {
    repo,
    number: rec.number,
    title: str(rec.title),
    baseRefName: str(rec.baseRefName),
    headRefName: str(rec.headRefName),
    headRefOid: str(rec.headRefOid),
    createdAt: str(rec.createdAt),
    updatedAt: str(rec.updatedAt),
    isDraft: rec.isDraft === true,
    mergeable: str(rec.mergeable),
    author: str(((rec.author ?? {}) as { login?: unknown }).login),
    labels,
    autoMergeRequest: autoMerge === null || autoMerge === undefined ? null : {
      enabledAt: str(autoMerge.enabledAt) || null,
      mergeMethod: str(autoMerge.mergeMethod),
    },
    comments: toComments(rec.comments),
    reviews: toComments(rec.reviews),
  };
}

/**
 * Search every repo of one owner for the open PRs of the given authors.
 *
 * One `gh api graphql` call per page, paged to exhaustion. The result is
 * `ok: false` — never a short list presented as complete — when the search
 * fails, returns malformed JSON, reports GraphQL errors, or has more pages
 * than the budget allows.
 *
 * @param options - Owner, authors, and injectable gh runner / limits.
 * @returns Every matching open PR across the owner's repos.
 */
export async function searchOpenFleetPrs(
  options: FleetPrSearchOptions,
): Promise<FleetPrSearchResult> {
  const query = buildFleetPrSearchQuery(options.owner, options.authors);
  if (query === null) {
    return { ok: false, reason: "no owner or author to search", calls: 0 };
  }
  const ghCommandFn = options.ghCommandFn ?? runGhCommand;
  const pageSize = options.pageSize && options.pageSize > 0
    ? options.pageSize
    : DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages && options.maxPages > 0
    ? options.maxPages
    : DEFAULT_MAX_PAGES;
  const document = buildSearchDocument(
    options.conversationSize && options.conversationSize > 0
      ? options.conversationSize
      : DEFAULT_CONVERSATION_SIZE,
  );

  const prs: FleetSearchPr[] = [];
  let cursor: string | null = null;
  let calls = 0;

  for (let page = 0; page < maxPages; page++) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${document}`,
      "-f",
      `q=${query}`,
      "-F",
      `first=${pageSize}`,
    ];
    if (cursor !== null) args.push("-f", `after=${cursor}`);

    let raw: string;
    try {
      raw = await withGraphQLSource(
        "fleet-pr-search",
        () => ghCommandFn(args),
      );
      calls++;
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        calls,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        reason: `unparseable GraphQL response: ${raw.slice(0, 120)}`,
        calls,
      };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, reason: "unexpected GraphQL response", calls };
    }
    const errors = (parsed as { errors?: unknown }).errors;
    if (errors !== undefined) {
      return {
        ok: false,
        reason: `GraphQL errors: ${JSON.stringify(errors).slice(0, 200)}`,
        calls,
      };
    }
    const search = ((parsed as { data?: { search?: unknown } }).data ?? {})
      .search as
        | {
          nodes?: unknown;
          pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
        }
        | undefined;
    if (search === undefined || search === null) {
      return { ok: false, reason: "GraphQL response had no search", calls };
    }

    const nodes = Array.isArray(search.nodes) ? search.nodes : [];
    for (const node of nodes) {
      const pr = toSearchPr(node);
      if (pr !== null) prs.push(pr);
    }

    if (search.pageInfo?.hasNextPage !== true) {
      return { ok: true, prs, calls };
    }
    const endCursor = search.pageInfo?.endCursor;
    if (typeof endCursor !== "string" || endCursor === "") {
      return {
        ok: false,
        reason: "search reported another page but no cursor",
        calls,
      };
    }
    cursor = endCursor;
  }

  // Budget exhausted with pages still outstanding: report it rather than
  // hand back a truncated sweep that looks complete.
  return {
    ok: false,
    reason:
      `search for ${options.owner} exceeded ${maxPages} pages of ${pageSize} ` +
      `— refusing to serve a truncated listing`,
    calls,
  };
}
