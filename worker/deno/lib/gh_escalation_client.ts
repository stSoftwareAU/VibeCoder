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
 *   - `getIssueComments` — REST API list (`GET /repos/.../issues/N/comments`).
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

type GhFn = (args: string[]) => Promise<string>;

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
export function createGhEscalationClient(ghFn: GhFn): GitHubClient {
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
      try {
        const raw = await ghFn([
          "api",
          `repos/${repo}/issues/${issueNumber}/comments`,
        ]);
        return parseCommentsJson(raw);
      } catch {
        return [];
      }
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
