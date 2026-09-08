/**
 * Minimal `GitHubClient` shim for the `escalateToHuman` helper (Issue #2211).
 *
 * The PR-side processors (`pr_ci_processor.ts`, `pr_feedback_processor.ts`)
 * and `work_on_content_integrity.ts` interact with the gh CLI through a
 * thin `ghFn: (args: string[]) => Promise<string>` injection point rather
 * than the full {@link ./github.ts} `GitHubClient`. The shared
 * {@link ./needs_human_escalation.ts | escalateToHuman} helper expects a
 * `GitHubClient`, so this module bridges the two:
 *
 *   - `addLabel`         — REST API (`POST /repos/.../issues/N/labels`)
 *                          with `gh issue edit --add-label` fallback.
 *   - `postComment`      — REST API (`POST /repos/.../issues/N/comments`).
 *   - `getIssueComments` — REST API list (`GET /repos/.../issues/N/comments`),
 *                          paged at 100 per request up to 10 pages (1 000
 *                          comments). GitHub's default page is the **oldest
 *                          30**, and asking this endpoint for `direction=desc`
 *                          returned the same ascending order when checked live
 *                          (NEAT-AI-core#593, 2026-09-08), so the newest
 *                          comments — where `escalateToHuman`'s dedup marker
 *                          always is — are reliably reachable only by paging
 *                          (Issue #1619). Pages are
 *                          concatenated oldest-first, the order the dedup
 *                          scan's `slice(-50)` tail expects.
 *
 * Issues and PRs share `/issues/<number>` endpoints in the GitHub API, so the
 * same shim works for both `target.kind: "issue"` and `target.kind: "pr"`.
 *
 * Methods escalateToHuman does not use throw at runtime; the shim is not a
 * general-purpose client.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { GitHubClient, GitHubComment } from "../types.ts";
import {
  buildIssueCommentsPageArgs,
  COMMENTS_PER_PAGE,
} from "./issue_comment_pages.ts";

type GhFn = (args: string[]) => Promise<string>;

/**
 * Maximum pages fetched per issue: 10 × {@link COMMENTS_PER_PAGE} = 1 000
 * comments (Issue #1619). Half the shared `MAX_COMMENT_PAGES` because this
 * scan only needs the newest 50 comments, not the whole thread; the request
 * shape and page size are the shared ones so the two cannot drift.
 */
const COMMENT_PAGE_CAP = 10;

/**
 * Best-effort parser for the REST `GET /comments` response. Returns the
 * recent comments in the shape the dedup scan needs (body + createdAt).
 * Unknown shapes degrade to an empty list rather than throwing — the dedup
 * scan treats absence as "no prior marker" and still posts the comment.
 */
function parseCommentsJson(raw: string): GitHubComment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: GitHubComment[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === "number" ? obj.id : 0;
    const body = typeof obj.body === "string" ? obj.body : "";
    const createdAt = typeof obj.created_at === "string" ? obj.created_at : "";
    const user = obj.user as Record<string, unknown> | undefined;
    const author = typeof user?.login === "string" ? user.login : "";
    out.push({
      id,
      body,
      author,
      createdAt,
      reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
    });
  }
  return out;
}

/**
 * Wrap a `ghFn` into a {@link GitHubClient} that is just rich enough for
 * `escalateToHuman` to call `addLabel`, `postComment`, and (when a dedup
 * scan is requested) `getIssueComments`. All other methods throw at
 * runtime — they are never called by escalateToHuman.
 *
 * @param warn - Sink for the short-read diagnostics `getIssueComments` emits
 *   when a page fails or the page cap truncates the thread. Defaults to
 *   `console.warn`; tests inject a recorder.
 */
export function createGhEscalationClient(
  ghFn: GhFn,
  warn: (message: string) => void = (message) => console.warn(message),
): GitHubClient {
  const notImplemented = (method: string) =>
    Promise.reject<never>(
      new Error(
        `createGhEscalationClient: ${method} is not implemented — this shim ` +
          `is only intended for escalateToHuman`,
      ),
    );

  return {
    getIssue: () => notImplemented("getIssue"),
    async getIssueComments(
      repo: string,
      issueNumber: number,
    ): Promise<GitHubComment[]> {
      const all: GitHubComment[] = [];
      for (let page = 1; page <= COMMENT_PAGE_CAP; page++) {
        let parsed: GitHubComment[];
        try {
          const raw = await ghFn(
            buildIssueCommentsPageArgs(repo, issueNumber, page),
          );
          parsed = parseCommentsJson(raw);
        } catch (err) {
          // Best effort: return the pages already fetched rather than
          // discarding them (the pre-paging contract). The partial result
          // is announced — a short read makes the dedup scan conclude "no
          // marker" and post a duplicate, so it must not pass as a full one.
          warn(
            `[GH_COMMENT_PAGE_FAILED] ${repo}#${issueNumber} page ${page} ` +
              `could not be fetched (${
                err instanceof Error ? err.message : String(err)
              }) — the dedup scan sees only the ${all.length} comments read ` +
              `so far and may post a duplicate`,
          );
          return all;
        }
        all.push(...parsed);
        // A short page is the last page (a malformed page parses to [] and
        // also stops here — the dedup scan treats absence as "no marker").
        if (parsed.length < COMMENTS_PER_PAGE) return all;
      }
      // Cap reached on a full page: the thread is longer than the window,
      // so the newest comments — where the dedup marker is — were not read.
      warn(
        `[GH_COMMENT_PAGE_CAP] ${repo}#${issueNumber} has more than ` +
          `${COMMENT_PAGE_CAP * COMMENTS_PER_PAGE} comments — the newest are ` +
          `beyond the page cap, so the escalation dedup scan may post a ` +
          `duplicate`,
      );
      return all;
    },
    async addLabel(
      repo: string,
      issueNumber: number,
      label: string,
    ): Promise<void> {
      try {
        await ghFn([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/${issueNumber}/labels`,
          "-f",
          `labels[]=${label}`,
        ]);
        return;
      } catch {
        // REST API failed — fall back to CLI (matches github.ts behaviour).
      }
      await ghFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--add-label",
        label,
      ]);
    },
    removeLabel: () => notImplemented("removeLabel"),
    async postComment(
      repo: string,
      issueNumber: number,
      body: string,
    ): Promise<GitHubComment | undefined> {
      try {
        await ghFn([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/${issueNumber}/comments`,
          "-f",
          `body=${body}`,
        ]);
      } catch {
        // Fall back to gh CLI — escalation comments must not be silently dropped.
        await ghFn([
          "issue",
          "comment",
          String(issueNumber),
          "--repo",
          repo,
          "--body",
          body,
        ]);
      }
      return undefined;
    },
    editIssue: () => notImplemented("editIssue"),
    assignIssue: () => notImplemented("assignIssue"),
    unassignIssue: () => notImplemented("unassignIssue"),
    closeIssue: () => notImplemented("closeIssue"),
  };
}
