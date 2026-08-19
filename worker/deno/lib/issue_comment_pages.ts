/**
 * Bounded pagination for issue/PR comment threads (Issue #3709,
 * SEC-2ab604fe9137).
 *
 * `gh api ... --paginate` follows every `Link: rel="next"` with no cap, so a
 * thread of unbounded length is materialised into one string in worker memory
 * before anything looks at it. The worst case was the nudge-marker check,
 * which downloaded an entire thread only to substring-match a marker that is
 * usually on the first page.
 *
 * These helpers mirror the bounded pattern the reserved-label trust gate uses
 * (`issue_query.ts`): request explicit pages of {@link COMMENTS_PER_PAGE},
 * stop on a short page, and fail loud when {@link MAX_COMMENT_PAGES} is
 * reached with a full page — rather than silently returning a truncated
 * thread. Marker lookups short-circuit on the first page that matches.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Page size requested per call — the GitHub REST maximum. */
export const COMMENTS_PER_PAGE = 100;

/**
 * Hard page cap. 20 pages x 100 comments = 2000 comments, far beyond any real
 * thread; reaching it means the thread cannot be read in full.
 */
export const MAX_COMMENT_PAGES = 20;

type GhFn = (args: string[]) => Promise<string>;

/** Build the `gh api` arguments for one explicit page of comments. */
export function buildIssueCommentsPageArgs(
  repo: string,
  issueNumber: number,
  page: number,
): string[] {
  return [
    "api",
    `repos/${repo}/issues/${issueNumber}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
  ];
}

/** Parse one page's response into a raw array, tolerating an empty body. */
function parsePage(raw: string, repo: string, issueNumber: number): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a comments array for ${repo}#${issueNumber}, got ${
        parsed === null ? "null" : typeof parsed
      }`,
    );
  }
  return parsed;
}

/**
 * Fetch every comment on an issue/PR, bounded to {@link MAX_COMMENT_PAGES}.
 *
 * @returns the merged raw comment objects, oldest first.
 * @throws when a page cannot be fetched or parsed, or when the thread exceeds
 *   the page cap — a truncated thread must never be mistaken for a full one.
 */
export async function fetchIssueCommentPages(
  repo: string,
  issueNumber: number,
  ghFn: GhFn,
): Promise<unknown[]> {
  const comments: unknown[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const pageComments = parsePage(
      await ghFn(buildIssueCommentsPageArgs(repo, issueNumber, page)),
      repo,
      issueNumber,
    );
    comments.push(...pageComments);
    if (pageComments.length < COMMENTS_PER_PAGE) return comments;
    if (page === MAX_COMMENT_PAGES) {
      throw new Error(
        `comment thread for ${repo}#${issueNumber} exceeded ${MAX_COMMENT_PAGES} pages — failing loud rather than truncating`,
      );
    }
  }
  return comments;
}

/**
 * Whether any comment on the issue/PR contains `marker`.
 *
 * Stops at the first page containing the marker, so the common case (a marker
 * posted early in the thread) reads a single page instead of the whole thread.
 * A thread longer than the page cap without a match returns false — the marker
 * is genuinely absent from everything readable.
 *
 * @throws when a page cannot be fetched or parsed.
 */
export async function issueCommentsContainMarker(
  repo: string,
  issueNumber: number,
  marker: string,
  ghFn: GhFn,
): Promise<boolean> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const raw = await ghFn(buildIssueCommentsPageArgs(repo, issueNumber, page));
    if (raw.includes(marker)) return true;
    if (parsePage(raw, repo, issueNumber).length < COMMENTS_PER_PAGE) {
      return false;
    }
  }
  return false;
}
