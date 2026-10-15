/**
 * GitHub context for issue routing (Issue #3742, part of #3691).
 *
 * {@link findRoutingDuplicates} searches open issues and recently closed
 * issues or PRs for an existing copy of a draft title. {@link requireWriteAccess}
 * checks the caller can file into the repository at all. Both take `ghCommandFn`
 * and `now` as injected dependencies, the same pattern as
 * `createGitHubIssuesWithPartialFailures` in lib/github.ts, so tests make no
 * network calls. Every gh failure throws with gh's own stderr in the message;
 * a failed search never becomes "no duplicates".
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { runGhCommand } from "./github.ts";
import { isValidRepoSlug, renderInertRepoSlug } from "./repo_slug.ts";

/** Runs one `gh` command and resolves to its stdout. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** How far back a closed issue or PR still counts as a duplicate. */
export const ROUTING_DUPLICATE_WINDOW_DAYS = 30;

/** Largest result page a duplicate search can return. */
export const ROUTING_DUPLICATE_SEARCH_LIMIT = 100;

/** Injection points; production defaults are `runGhCommand` and the wall clock. */
export interface IssueRoutingGithubDeps {
  ghCommandFn?: GhCommandFn;
  now?: () => Date;
}

/** Permissions that may file into a repository (GitHub returns these upper-case). */
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set([
  "ADMIN",
  "MAINTAIN",
  "WRITE",
]);

/** The caller can read the repository but may not file into it. */
export class IssueRoutingPermissionError extends Error {
  readonly repository: string;
  readonly permission: string;

  constructor(repository: string, permission: string) {
    super(
      `Issue routing needs write access to ${repository}, but the caller has ${permission} permission`,
    );
    this.name = "IssueRoutingPermissionError";
    this.repository = repository;
    this.permission = permission;
  }
}

interface SearchHit {
  number: number;
  title: string;
  state: string;
  closedAt: string | null;
}

/** Folds case, compatibility forms and punctuation so titles compare by words. */
export function normaliseRoutingTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unexpectedSearchResponse(repo: string): Error {
  return new Error(
    `Duplicate search in ${repo} returned an unexpected search response`,
  );
}

function parseHit(repo: string, item: unknown): SearchHit {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw unexpectedSearchResponse(repo);
  }
  const o = item as Record<string, unknown>;
  const n = o.number;
  const t = o.title;
  const s = o.state;
  // A missing closedAt (an open item) is the same as null.
  const c = o.closedAt ?? null;
  if (
    typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0 ||
    typeof t !== "string" || typeof s !== "string" ||
    (c !== null && typeof c !== "string")
  ) {
    throw unexpectedSearchResponse(repo);
  }
  return { number: n, title: t, state: s, closedAt: c };
}

/** Runs one search. Any failure throws; nothing here returns a partial list. */
async function runSearch(
  repo: string,
  args: string[],
  ghCommandFn: GhCommandFn,
): Promise<SearchHit[]> {
  let raw: string;
  try {
    raw = await ghCommandFn(args);
  } catch (error) {
    throw new Error(
      `Duplicate search in ${repo} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Duplicate search in ${repo} returned invalid JSON: ${
        errorMessage(error)
      }`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) throw unexpectedSearchResponse(repo);
  const hits = parsed.map((item) => parseHit(repo, item));
  // At the limit, anything beyond it is unseen, so a duplicate could be missed.
  if (hits.length >= ROUTING_DUPLICATE_SEARCH_LIMIT) {
    throw new Error(
      `Duplicate search in ${repo} returned the limit of ${ROUTING_DUPLICATE_SEARCH_LIMIT} results, so duplicates beyond it would be missed`,
    );
  }
  return hits;
}

/**
 * Returns the numbers of open issues, and of issues or PRs closed within the
 * duplicate window, whose normalised title equals the draft's. Sorted ascending.
 *
 * @throws Error on an invalid repository, an empty normalised title, any gh
 *   failure, or a search response that cannot be trusted
 */
export async function findRoutingDuplicates(
  repo: string,
  title: string,
  deps: IssueRoutingGithubDeps = {},
): Promise<number[]> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const now = deps.now ?? (() => new Date());
  if (!isValidRepoSlug(repo)) {
    throw new Error(
      `findRoutingDuplicates: invalid repository ${renderInertRepoSlug(repo)}`,
    );
  }
  const normalised = normaliseRoutingTitle(title);
  if (normalised === "") {
    throw new Error(
      "findRoutingDuplicates: title is empty after normalisation",
    );
  }
  const cutoffMs = now().getTime() - ROUTING_DUPLICATE_WINDOW_DAYS * 86_400_000;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
  // normalised holds only letters, digits and single spaces, so quoting it
  // means a title cannot inject search qualifiers.
  const query = `"${normalised}" in:title`;
  const base = [
    "search",
    "issues",
    query,
    "--repo",
    repo,
    "--include-prs",
    "--json",
    "number,title,state,closedAt",
    "--limit",
    String(ROUTING_DUPLICATE_SEARCH_LIMIT),
  ];
  const openHits = await runSearch(
    repo,
    [...base, "--state", "open"],
    ghCommandFn,
  );
  const closedHits = await runSearch(
    repo,
    [...base, "--state", "closed", "--closed", `>=${cutoffDate}`],
    ghCommandFn,
  );

  const found = new Set<number>();
  for (const hit of openHits) {
    if (normaliseRoutingTitle(hit.title) === normalised) found.add(hit.number);
  }
  for (const hit of closedHits) {
    const closedMs = hit.closedAt === null ? NaN : Date.parse(hit.closedAt);
    if (Number.isNaN(closedMs)) {
      throw new Error(
        `Duplicate search in ${repo} returned a closed hit without a parseable closedAt`,
      );
    }
    // --closed is day-granular, so the millisecond window is applied here.
    if (closedMs < cutoffMs) continue;
    if (normaliseRoutingTitle(hit.title) === normalised) found.add(hit.number);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Resolves when the caller has ADMIN, MAINTAIN or WRITE on the repository.
 *
 * @throws IssueRoutingPermissionError when the viewer's permission is anything
 *   else, including none; a plain Error when the check itself fails
 */
export async function requireWriteAccess(
  repo: string,
  deps: IssueRoutingGithubDeps = {},
): Promise<void> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  if (!isValidRepoSlug(repo)) {
    throw new Error(
      `requireWriteAccess: invalid repository ${renderInertRepoSlug(repo)}`,
    );
  }
  let raw: string;
  try {
    raw = await ghCommandFn([
      "repo",
      "view",
      repo,
      "--json",
      "viewerPermission",
    ]);
  } catch (error) {
    throw new Error(
      `Write-access check for ${repo} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Write-access check for ${repo} returned invalid JSON: ${
        errorMessage(error)
      }`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Write-access check for ${repo} returned an unexpected response`,
    );
  }
  const v = (parsed as Record<string, unknown>).viewerPermission;
  // GitHub returns null when the viewer has no access at all.
  const observed = typeof v === "string" && v !== "" ? v : "none";
  if (!WRITE_PERMISSIONS.has(observed)) {
    throw new IssueRoutingPermissionError(repo, observed);
  }
}
