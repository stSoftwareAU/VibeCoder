/**
 * PR review context bundling (Issue #1858).
 *
 * Fetches unresolved line-level review comments from trusted automated
 * review bots on a PR, so the PR feedback prompt can include them as
 * additional structured context. This handles the case where an
 * authorised human says "please fix what the bot flagged" — without
 * this, Claude only sees the human's text and has no way to find the
 * bot's specific suggestions.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/**
 * A bundled review comment from a trusted automated review bot.
 *
 * Sourced from `repos/{repo}/pulls/{n}/comments` and filtered to:
 * - User login is in `trustedReviewBots`.
 * - The comment does not have a 👀 reaction (already-processed marker).
 */
export interface TrustedBotReviewComment {
  /** Comment ID (numeric, from GitHub API). */
  id: number;
  /** Bot login (e.g., "github-code-quality[bot]"). */
  login: string;
  /** File path the comment is anchored to. */
  path: string;
  /**
   * Line number the comment is anchored to. Falls back to
   * `original_line` when `line` is null (e.g., the comment is anchored
   * to a position in the diff hunk that no longer maps to a current line).
   */
  line: number | null;
  /** Diff hunk surrounding the comment, as returned by GitHub. */
  diffHunk: string;
  /** Comment body. */
  body: string;
  /** Permalink URL for human inspection. */
  htmlUrl: string;
}

/**
 * Maximum number of bundled bot review comments included in the prompt.
 *
 * Comments beyond this cap are dropped with a truncation footer.
 */
export const MAX_BUNDLED_REVIEW_COMMENTS = 20;

/**
 * Maximum number of lines retained per diff hunk.
 *
 * Long hunks are truncated with a "(diff hunk truncated …)" footer to
 * keep the bundled prompt under a sensible token budget.
 */
export const MAX_DIFF_HUNK_LINES = 30;

/**
 * Truncate a diff hunk to at most {@link MAX_DIFF_HUNK_LINES} lines.
 *
 * Preserves the leading lines and appends a truncation footer noting
 * how many lines were dropped. Empty input returns unchanged.
 */
export function truncateDiffHunk(
  hunk: string,
  maxLines: number = MAX_DIFF_HUNK_LINES,
): string {
  if (!hunk) return hunk;
  const lines = hunk.split("\n");
  if (lines.length <= maxLines) return hunk;
  const kept = lines.slice(0, maxLines).join("\n");
  const dropped = lines.length - maxLines;
  return `${kept}\n… (diff hunk truncated — ${dropped} more line${
    dropped === 1 ? "" : "s"
  } not shown)`;
}

/**
 * Raw shape of a single comment as returned by
 * `repos/{repo}/pulls/{n}/comments`.
 */
interface RawPullComment {
  id?: number;
  user?: { login?: string };
  path?: string;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string;
  body?: string;
  html_url?: string;
  reactions?: { eyes?: number };
}

/**
 * Fetch unresolved line-level review comments from trusted bots on a PR.
 *
 * Calls `repos/{repo}/pulls/{prNumber}/comments`, filters to comments
 * whose `user.login` is in `trustedReviewBots`, drops comments that
 * already have a 👀 reaction (treated as already-processed), and
 * returns the structured representation used by the prompt builder.
 *
 * Returns `ok: true, value: []` when there are no matches or when
 * `trustedReviewBots` is empty. Returns `ok: false` only when the API
 * call itself fails — JSON parse failures degrade to an empty list to
 * avoid blocking PR feedback processing on malformed responses.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param trustedReviewBots - Allowlisted bot logins
 * @param ghCommandFn - Function that runs `gh` commands and returns stdout
 */
export async function fetchTrustedBotReviewComments(
  repo: string,
  prNumber: number,
  trustedReviewBots: readonly string[],
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Result<TrustedBotReviewComment[]>> {
  if (!trustedReviewBots || trustedReviewBots.length === 0) {
    return { ok: true, value: [] };
  }

  let raw: string;
  try {
    raw = await ghCommandFn([
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
    ]);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(parsed)) return { ok: true, value: [] };

  const allowed = new Set(trustedReviewBots);
  const out: TrustedBotReviewComment[] = [];
  for (const item of parsed as RawPullComment[]) {
    const login = item?.user?.login;
    if (!login || !allowed.has(login)) continue;
    if ((item.reactions?.eyes ?? 0) > 0) continue;
    if (typeof item.id !== "number") continue;
    if (typeof item.path !== "string") continue;

    const line = typeof item.line === "number"
      ? item.line
      : typeof item.original_line === "number"
      ? item.original_line
      : null;

    out.push({
      id: item.id,
      login,
      path: item.path,
      line,
      diffHunk: typeof item.diff_hunk === "string" ? item.diff_hunk : "",
      body: typeof item.body === "string" ? item.body : "",
      htmlUrl: typeof item.html_url === "string" ? item.html_url : "",
    });
  }

  return { ok: true, value: out };
}
