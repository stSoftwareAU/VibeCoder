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
 *                          paged at 100 per page up to 10 pages (Issue #1619).
 *
 * **Comment window.** The un-paged endpoint returns the API default — the
 * **oldest 30** comments — so on a busy issue `escalateToHuman`'s dedup scan
 * never saw the marker it had itself written and posted a duplicate
 * escalation (NEAT-AI-core#593: 46 comments, the marker in comment 47). The
 * shim therefore fetches every page at `per_page=100` up to a cap of 10 pages
 * (1 000 comments) and concatenates them oldest-first, so the helper's
 * `comments.slice(-50)` tail scans the newest 50. A page that fails, and a
 * thread that outruns the cap, degrade to a partial read — the best-effort
 * contract this shim has always had — but never silently: both warn. `sort`/`direction` are not
 * used: GitHub ignores them on the per-issue comments endpoint (verified live
 * against NEAT-AI-core#593 on 2026-09-08 — the same ascending order came back
 * with and without them).
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
 * Page cap for the dedup read, so a pathological thread cannot spend the run
 * on paging.
 *
 * Deliberately its own constant rather than `issue_comment_pages.ts`'s
 * `MAX_COMMENT_PAGES` (20): that helper throws on the cap, because a
 * truncated thread must never be mistaken for a full one. This shim cannot —
 * its whole contract is best effort, and throwing would lose the escalation
 * itself rather than the marker. So it truncates, and says so on stderr:
 * degrading is allowed here, degrading silently is not.
 */
const MAX_DEDUP_COMMENT_PAGES = 10;

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
      for (let page = 1; page <= MAX_DEDUP_COMMENT_PAGES; page++) {
        let raw: string;
        try {
          raw = await ghFn(
            buildIssueCommentsPageArgs(repo, issueNumber, page),
          );
        } catch (err) {
          // Best effort: keep the pages already fetched rather than
          // discarding them — a partial scan still finds most markers — but
          // never let the shortfall pass unreported.
          warn(
            `createGhEscalationClient: comment page ${page} of ` +
              `${repo}#${issueNumber} failed (${
                err instanceof Error ? err.message : String(err)
              }) — scanning the ${all.length} comments already fetched`,
          );
          return all;
        }
        const parsed = parseCommentsJson(raw);
        all.push(...parsed);
        // A short page is the last page; a malformed one yields none and
        // ends the loop too, matching the pre-paging degrade-to-empty.
        if (parsed.length < COMMENTS_PER_PAGE) return all;
      }
      // Every page was full at the cap, so the thread is longer than this
      // read. Truncation is the best-effort contract; silence is not.
      warn(
        `createGhEscalationClient: ${repo}#${issueNumber} has more than ` +
          `${MAX_DEDUP_COMMENT_PAGES * COMMENTS_PER_PAGE} comments — the ` +
          `dedup scan reads the newest of the first ` +
          `${MAX_DEDUP_COMMENT_PAGES} pages only`,
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
