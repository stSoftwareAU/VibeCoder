/**
 * Wrapper finalisation for a claimed idle-task scan (Issue #179).
 *
 * Both claim paths — the production loop's `routeIdleTaskInProcessIssue` and
 * the `work-on-issue` CLI — used to run `gh issue close --comment <summary>`
 * unconditionally once `handleIdleTaskIssue` reported `handled: true`, whether
 * the scan had actually run or not. An infrastructure failure (missing clone,
 * detector crash, ENOENT) therefore closed the wrapper with the error text as
 * its "result", and nothing re-raised it until the next cadence tick.
 *
 * The rule this module enforces: **only a scan that actually ran closes its
 * wrapper.** A failed run posts the failure as a comment and leaves the
 * wrapper open, so the ordinary failure cooldown applies and a later claim
 * retries it.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Logger } from "../types.ts";
import { runGhCommand as defaultRunGhCommand } from "./github.ts";

/** Outcome of the template run being finalised. */
export interface FinaliseIdleTaskWrapperInput {
  /** `owner/repo` the wrapper lives in. */
  repo: string;
  /** Wrapper issue number. */
  issueNumber: number;
  /** Whether the template run succeeded (`HandleIdleTaskIssueResult.ok`). */
  ok: boolean;
  /** Summary posted back to the wrapper. */
  summary: string;
}

/** Injectable seams. Defaults wire the production `gh` runner. */
export interface FinaliseIdleTaskWrapperDeps {
  logger: Logger;
  ghCommandFn?: (args: string[]) => Promise<string>;
}

/** What {@link finaliseIdleTaskWrapper} did with the wrapper. */
export interface FinaliseIdleTaskWrapperResult {
  /** `true` when the wrapper was closed (successful run only). */
  closed: boolean;
  /** `true` when a failure comment was posted and the wrapper left open. */
  commented: boolean;
}

/**
 * Prefix on the comment left when a scan failed. Kept explicit so an operator
 * reading the wrapper knows the issue is deliberately still open.
 */
export const IDLE_TASK_FAILURE_COMMENT_PREFIX =
  "⚠️ Idle-task scan did not complete — leaving this wrapper **open** so a " +
  "later claim retries it after the failure cooldown (Issue #179).";

/** Build the comment body posted on a failed scan. */
export function buildIdleTaskFailureComment(summary: string): string {
  return `${IDLE_TASK_FAILURE_COMMENT_PREFIX}\n\n${summary}`;
}

/**
 * Close the wrapper on success; comment and leave it open on failure.
 *
 * `gh` failures are logged and swallowed — a stuck issue must never crash the
 * worker — but the caller's own success/failure verdict is unaffected.
 */
export async function finaliseIdleTaskWrapper(
  input: FinaliseIdleTaskWrapperInput,
  deps: FinaliseIdleTaskWrapperDeps,
): Promise<FinaliseIdleTaskWrapperResult> {
  const ghCommand = deps.ghCommandFn ?? defaultRunGhCommand;
  const { repo, issueNumber, ok, summary } = input;

  const args = ok
    ? [
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repo,
      "--comment",
      summary,
    ]
    : [
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      buildIdleTaskFailureComment(summary),
    ];

  try {
    await ghCommand(args);
  } catch (err) {
    deps.logger.warn(
      ok
        ? "Failed to close idle-task issue"
        : "Failed to comment on failed idle-task issue",
      {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  return { closed: ok, commented: !ok };
}
