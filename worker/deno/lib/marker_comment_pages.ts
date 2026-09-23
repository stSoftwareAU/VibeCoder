/**
 * Paginated reads of marker-carrying issue/PR comments (Issues #2265, #2266).
 *
 * Two coordination primitives keep their state in hidden comment markers on a
 * PR thread — the branch-update lock (`pr_branch_lock.ts`) and the PR-comment
 * claim (`claim_pr_comment.ts`) — and both were blinded by the same defect:
 * `gh api repos/<repo>/issues/<n>/comments` without `--paginate` returns the
 * **30 oldest** comments, so past page one neither could see its own marker.
 * The lock left 765 comments on `stSoftwareAU/NEAT-AI-Lamarck#239` before the
 * read was fixed; the claim had the same three calls.
 *
 * The read, its one-array-per-page parse and the comment delete live here so
 * the two modules cannot drift apart again — a second copy is a second place
 * for the next page-one bug to hide.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { AlertDedupCommentRow } from "./alert_dedup_authors.ts";

/** Page size requested per call — the GitHub REST maximum. */
export const MARKER_COMMENTS_PER_PAGE = 100;

/** One marker-carrying comment, with the author that authenticates it. */
export interface MarkerComment extends AlertDedupCommentRow {
  /** GitHub's comment id — the only unforgeable handle on the comment. */
  id: number;
  /** The comment body, which carries the marker. */
  body: string;
  /** `created_at`, as GitHub stamped it. */
  createdAt: string;
}

/** The `--jq` projection every marker read requests. */
function markerJq(markerPrefix: string): string {
  return `[.[] | select(.body | test("${markerPrefix}")) | ` +
    `{id: .id, body: .body, created_at: .created_at, author: .user.login}]`;
}

/**
 * Flatten what `gh api --paginate --jq '[…]'` prints.
 *
 * `--paginate` applies the filter to each page in turn, so the payload is one
 * JSON array per line rather than a single array — and `--slurp`, which would
 * merge them, is refused alongside `--jq`. A malformed line throws: an
 * unreadable page is a failure the caller must handle, never an empty result
 * standing in for "no markers".
 *
 * @param payload - Raw stdout from the paginated comment read
 * @param markerPrefix - Only comments whose body contains it are returned
 * @returns Every matching comment across every page, in page order
 */
export function parseMarkerCommentPages(
  payload: string,
  markerPrefix: string,
): MarkerComment[] {
  const rows: MarkerComment[] = [];

  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) continue;

    for (const entry of parsed as Array<Record<string, unknown>>) {
      if (
        typeof entry.body !== "string" ||
        !entry.body.includes(markerPrefix)
      ) {
        continue;
      }
      rows.push({
        id: Number(entry.id),
        body: entry.body,
        createdAt: String(entry.created_at ?? ""),
        author: typeof entry.author === "string" ? entry.author : null,
      });
    }
  }

  return rows;
}

/**
 * Fetch every marker-carrying comment on an issue/PR, across every page.
 *
 * The endpoint stays the first argument, with `gh`'s flags after it, so a
 * caller reading the argv sees which endpoint is being queried.
 *
 * Throws when the read fails or a page cannot be parsed: a blind read must
 * never pass as an empty thread, which is precisely how both markers leaked.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue or PR number whose thread is read
 * @param markerPrefix - Only comments whose body contains it are returned
 * @param ghCommandFn - Runs `gh` (injectable for testing)
 */
export async function fetchMarkerComments(
  repo: string,
  issueNumber: number,
  markerPrefix: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<MarkerComment[]> {
  const payload = await ghCommandFn([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments?per_page=${MARKER_COMMENTS_PER_PAGE}`,
    "--paginate",
    "--jq",
    markerJq(markerPrefix),
  ]);

  return parseMarkerCommentPages(payload, markerPrefix);
}

/**
 * Rewrite the body of one issue/PR comment, so a marker comment can be edited
 * in place instead of re-posted.
 *
 * Unlike {@link deleteIssueComment} this throws rather than returning the
 * error: a caller edits because the old body is now wrong, and a swallowed
 * failure would leave that stale body on the thread reading as current.
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentId - The comment to rewrite
 * @param body - The replacement body, in full
 * @param ghCommandFn - Runs `gh` (injectable for testing)
 */
export async function updateIssueComment(
  repo: string,
  commentId: number,
  body: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<void> {
  await ghCommandFn([
    "api",
    "-X",
    "PATCH",
    `repos/${repo}/issues/comments/${commentId}`,
    "-f",
    `body=${body}`,
  ]);
}

/**
 * Delete one issue/PR comment, reporting the failure rather than hiding it.
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentId - The comment to delete
 * @param ghCommandFn - Runs `gh` (injectable for testing)
 * @returns The error when the delete failed, or null when it succeeded
 */
export async function deleteIssueComment(
  repo: string,
  commentId: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Error | null> {
  try {
    await ghCommandFn([
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/issues/comments/${commentId}`,
    ]);
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
