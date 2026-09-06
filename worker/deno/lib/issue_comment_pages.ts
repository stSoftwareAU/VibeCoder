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

import {
  type AlertDedupAuthorOptions,
  type AlertDedupCommentRow,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";

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
 * The marker-carrying comments of one page, reduced to their authors.
 *
 * `repos/…/issues/…/comments` renders the commenter as `user.login`, not the
 * `author` object `gh issue list --json author` returns, so the rows are
 * reshaped here into the {@link AlertDedupCommentRow} shape the shared
 * author filter takes.
 */
function markerCommentAuthors(
  comments: readonly unknown[],
  marker: string,
): AlertDedupCommentRow[] {
  const rows: AlertDedupCommentRow[] = [];
  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const comment = raw as { body?: unknown; user?: unknown };
    if (typeof comment.body !== "string") continue;
    if (!comment.body.includes(marker)) continue;
    const user = comment.user;
    const login = typeof user === "object" && user !== null
      ? (user as { login?: unknown }).login
      : undefined;
    rows.push({ author: typeof login === "string" ? login : null });
  }
  return rows;
}

/**
 * Whether a **fleet-authored** comment on the issue/PR contains `marker`.
 *
 * Stops at the first page carrying a verified match, so the common case (a
 * marker posted early in the thread) reads a single page instead of the whole
 * thread. A thread longer than the page cap without a verified match returns
 * false — the marker is genuinely absent from everything readable.
 *
 * **The author is checked, not just the marker** (Issue #1216). Every caller
 * uses the result to *suppress* an action — the blocking-PR stall escalation,
 * a stall-reason comment, a self-schedule announcement, a CI nudge — and a
 * comment body is text any GitHub account may write. Matching on the body
 * alone let one planted `<!-- vibe-… -->` comment silence those diagnostics on
 * that thread for good, and silence is the direction nobody notices. This is
 * the {@link file://./alert_dedup_authors.ts} control applied to the raw REST
 * comment pages, which carry no `--jq` projection for
 * `marker_dedup_author_manifest.ts`'s scanner to classify.
 *
 * **The fail direction is towards acting.** An unresolvable fleet identity
 * means no marker can be attributed, so none counts and the suppressed action
 * goes ahead. A duplicate nudge is noise a human scrolls past; a suppressed
 * escalation is a stalled PR nobody hears about.
 *
 * @param authorOptions - Fleet identity inputs (tests state the fleet).
 * @param log - Sink for the author-verification diagnostics.
 * @throws when a page cannot be fetched or parsed.
 */
export async function issueCommentsContainMarker(
  repo: string,
  issueNumber: number,
  marker: string,
  ghFn: GhFn,
  authorOptions: AlertDedupAuthorOptions = {},
  log: (message: string) => void = (message) => console.warn(message),
): Promise<boolean> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const raw = await ghFn(buildIssueCommentsPageArgs(repo, issueNumber, page));
    const comments = parsePage(raw, repo, issueNumber);
    const candidates = markerCommentAuthors(comments, marker);
    if (candidates.length > 0) {
      const verified = await selectFleetAuthoredComments(
        candidates,
        `comment marker ${marker} on ${repo}#${issueNumber}`,
        authorOptions,
        log,
        "the marker does not count and the suppressed action goes ahead — " +
          "a comment anyone can post must not silence the worker",
      );
      if (verified.length > 0) return true;
    }
    if (comments.length < COMMENTS_PER_PAGE) return false;
  }
  return false;
}
