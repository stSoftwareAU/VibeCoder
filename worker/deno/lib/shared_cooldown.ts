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
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import { COOLDOWN_DEFAULTS } from "./cooldown_state.ts";

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
 * Check if an issue has an active cross-worker cooldown signal.
 *
 * Fetches recent comments on the issue and looks for cooldown markers
 * that are still within the configured cooldown period.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param cooldownPeriodSeconds - Cooldown period in seconds (default: 600)
 * @param ghCommandFn - Injected gh command function (for testing)
 * @returns True if an active cooldown signal exists
 */
export async function hasActiveCooldownSignal(
  repo: string,
  issueNumber: number,
  cooldownPeriodSeconds: number = COOLDOWN_DEFAULTS.issueRetryCooldown,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<boolean> {
  let commentsJson: string;
  try {
    commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${COOLDOWN_MARKER_PREFIX}")) | {body: .body}]`,
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

    for (const comment of parsed as Array<Record<string, unknown>>) {
      const body = String(comment.body ?? "");
      const cooldownData = parseCooldownComment(body);
      if (!cooldownData) continue;

      const age = nowSeconds - cooldownData.timestamp;
      if (age >= 0 && age < cooldownPeriodSeconds) {
        return true;
      }
    }
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
