/**
 * Cross-worker cooldown signals via GitHub issue comments (Issue #1087).
 *
 * When a worker fails on an issue, it posts a hidden HTML comment on the
 * issue. Other workers check for these comments before selecting an issue,
 * preventing wasted attempts on issues that recently failed.
 *
 * The GitHub-based signal is supplementary to the local per-worker
 * cooldown in cooldown_state.ts. Local cooldown is always checked first;
 * this module catches cross-worker scenarios where different machines
 * have no visibility into each other's local state.
 *
 * Comment format: `<!-- COOLDOWN:worker-id:unix-timestamp -->`
 * This is consistent with the existing `CLAIM_LOCK` pattern.
 *
 * **The signal is only a signal when the fleet posted it.** An issue
 * comment thread is open to anyone who can see the issue, so a cooldown
 * marker on its own is a request from a stranger that the whole fleet
 * skip an issue. The worker-id inside the marker is chosen by whoever
 * typed it and proves nothing; the comment **author** is the only
 * authenticated part, and it is checked against the fleet identity
 * (`alert_dedup_authors.ts`), exactly as `claim_issue.ts` checks
 * `CLAIM_LOCK` authors.
 *
 * **The fail direction is "do not suppress the work".** An unresolvable
 * fleet, an unreadable comment thread and a malformed payload all mean no
 * active cooldown, so the issue stays workable. A wasted retry costs one
 * run; an issue nobody may touch costs every run after it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import { COOLDOWN_DEFAULTS } from "./cooldown_state.ts";
import {
  type AlertDedupAuthorOptions,
  type AlertDedupCommentRow,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";

/** The cooldown comment marker prefix used in issue comments. */
export const COOLDOWN_MARKER_PREFIX = "<!-- COOLDOWN:";

/** The cooldown comment marker suffix. */
export const COOLDOWN_MARKER_SUFFIX = " -->";

/**
 * Build a cooldown comment body.
 *
 * Uses hidden HTML comments to avoid noise in the issue timeline.
 */
export function buildCooldownComment(
  workerId: string,
  timestampSeconds: number,
): string {
  return `${COOLDOWN_MARKER_PREFIX}${workerId}:${timestampSeconds}${COOLDOWN_MARKER_SUFFIX}`;
}

/**
 * Parse a cooldown comment to extract worker ID and timestamp.
 *
 * @returns Parsed data, or null if the comment is not a valid cooldown marker.
 */
export function parseCooldownComment(
  body: string,
): { workerId: string; timestamp: number } | null {
  const match = body.match(
    /<!-- COOLDOWN:([^:]+):(\d+) -->/,
  );
  if (!match) return null;

  const workerId = match[1]!;
  const timestamp = parseInt(match[2]!, 10);
  if (isNaN(timestamp)) return null;

  return { workerId, timestamp };
}

/**
 * Post a cooldown comment on a GitHub issue after a failure.
 *
 * This signals to other workers that this issue recently failed and
 * should be skipped for the cooldown period.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param workerId - Unique identifier for this worker
 * @param ghCommandFn - Injected gh command function (for testing)
 * @returns Result indicating success or failure
 */
export async function postCooldownComment(
  repo: string,
  issueNumber: number,
  workerId: string,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<Result<void>> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const commentBody = buildCooldownComment(workerId, nowSeconds);

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      commentBody,
    ]);
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to post cooldown comment: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }
}

/**
 * Check if an issue has an active cross-worker cooldown signal **from the
 * fleet**.
 *
 * Fetches recent comments on the issue and looks for cooldown markers that
 * are still within the configured cooldown period and were written by a
 * fleet account. The `--jq` projection carries `.user.login` through for
 * exactly that reason: the data is fetched either way, and a projection
 * that drops the author leaves the check with nothing to check.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param cooldownPeriodSeconds - Cooldown period in seconds (default: 600)
 * @param ghCommandFn - Injected gh command function (for testing)
 * @param authorOptions - Fleet identity inputs; omitted reads the
 *   configured fleet, which is what every production caller does
 * @param log - Sink for the author-verification diagnostics
 * @returns True if an active fleet-authored cooldown signal exists
 */
export async function hasActiveCooldownSignal(
  repo: string,
  issueNumber: number,
  cooldownPeriodSeconds: number = COOLDOWN_DEFAULTS.issueRetryCooldown,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  authorOptions: AlertDedupAuthorOptions = {},
  log: (message: string) => void = (message) => console.warn(message),
): Promise<boolean> {
  let commentsJson: string;
  try {
    commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${COOLDOWN_MARKER_PREFIX}")) | ` +
      `{body: .body, author: .user.login}]`,
    ]);
  } catch (err) {
    console.warn(
      `[shared-cooldown] Failed to fetch cooldown comments for ${repo}#${issueNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(commentsJson);
    if (!Array.isArray(parsed)) return false;

    const nowSeconds = Math.floor(Date.now() / 1000);

    // Keep only the markers that are still live, then keep only the ones
    // the fleet wrote. Verifying the live ones alone means the log names
    // comments that would otherwise have parked the issue.
    const live: (AlertDedupCommentRow & { body: string })[] = [];
    for (const comment of parsed as Array<Record<string, unknown>>) {
      const body = String(comment.body ?? "");
      const cooldownData = parseCooldownComment(body);
      if (!cooldownData) continue;

      const age = nowSeconds - cooldownData.timestamp;
      if (age >= 0 && age < cooldownPeriodSeconds) {
        live.push({
          body,
          author: typeof comment.author === "string" ? comment.author : null,
        });
      }
    }
    const verified = await selectFleetAuthoredComments(
      live,
      `cooldown ${repo}#${issueNumber}`,
      authorOptions,
      log,
      "the issue is not skipped — a cooldown comment anyone can post must " +
        "not park work for the whole fleet",
    );
    if (verified.length > 0) return true;
  } catch (err) {
    console.warn(
      `[shared-cooldown] Failed to parse cooldown comments for ${repo}#${issueNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }

  return false;
}

/**
 * Clean up expired cooldown comments from an issue.
 *
 * Removes cooldown comments that are older than the cooldown period.
 * This is best-effort — failures are silently ignored.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param cooldownPeriodSeconds - Cooldown period in seconds
 * @param ghCommandFn - Injected gh command function (for testing)
 */
export async function cleanExpiredCooldownComments(
  repo: string,
  issueNumber: number,
  cooldownPeriodSeconds: number = COOLDOWN_DEFAULTS.issueRetryCooldown,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<void> {
  let commentsJson: string;
  try {
    commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${COOLDOWN_MARKER_PREFIX}")) | {id: .id, body: .body}]`,
    ]);
  } catch (err) {
    console.warn(
      `[shared-cooldown] Failed to fetch cooldown comments for cleanup on ${repo}#${issueNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  let comments: Array<{ id: number; body: string }>;
  try {
    const parsed: unknown = JSON.parse(commentsJson);
    if (!Array.isArray(parsed)) return;
    comments = parsed as Array<{ id: number; body: string }>;
  } catch (err) {
    console.warn(
      `[shared-cooldown] Failed to parse cooldown comments for cleanup on ${repo}#${issueNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  for (const comment of comments) {
    const cooldownData = parseCooldownComment(String(comment.body ?? ""));
    if (!cooldownData) continue;

    const age = nowSeconds - cooldownData.timestamp;
    if (age >= cooldownPeriodSeconds) {
      try {
        await ghCommandFn([
          "api",
          "-X",
          "DELETE",
          `repos/${repo}/issues/comments/${comment.id}`,
        ]);
      } catch (err) {
        console.warn(
          `[shared-cooldown] Failed to delete expired cooldown comment ${comment.id} on ${repo}#${issueNumber}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
