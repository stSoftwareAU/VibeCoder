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
 * Issue #1753: both writes go through the REST `issues` endpoints rather than
 * the `gh issue close` / `gh issue comment` subcommands. Those subcommands
 * are GraphQL-backed, so while the primary-quota latch (Issues #1485/#1540)
 * is set the spawn chokepoint refuses them — and on the fleet's shared quota
 * that latch is set for a large part of every hour. A wrapper whose work had
 * landed then stayed open, the next scan re-claimed it and ran the whole
 * scan again (GRQ-health#204), and this function still reported
 * `closed: true`. REST `gh api` calls ride the core quota, a separate budget
 * the latch exempts (`isQuotaExemptGhCall`), so the close lands regardless —
 * and the result now reports what actually happened.
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
  /**
   * `true` when the wrapper was actually closed (successful run only).
   *
   * Issue #1753: reflects the close call's outcome, not the run's verdict. A
   * successful run whose close was refused reports `closed: false` with the
   * reason in {@link error}, so a caller can tell a wrapper that is still
   * open — and will be re-claimed by the next scan — from one that closed.
   */
  closed: boolean;
  /**
   * `true` when a failure comment was posted and the wrapper left open.
   *
   * Reflects the comment call's outcome (Issue #1753).
   */
  commented: boolean;
  /**
   * Why a write did not land, when one did not. Absent when every call the
   * verdict required succeeded.
   */
  error?: string;
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
 * REST argv that posts `body` as a comment on the wrapper (core quota).
 *
 * The same endpoint `github.ts`'s `addComment` uses; exported so the tests
 * assert the exact shape the latch exempts.
 */
export function idleTaskWrapperCommentArgs(
  repo: string,
  issueNumber: number,
  body: string,
): string[] {
  return [
    "api",
    "-X",
    "POST",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "-f",
    `body=${body}`,
  ];
}

/**
 * REST argv that closes the wrapper (core quota).
 *
 * `classifyIssueLifecycle` reads this PATCH as the same `close` verb as
 * `gh issue close`, so the audit journal and the agent-side guard see no
 * difference between the two forms.
 */
export function idleTaskWrapperCloseArgs(
  repo: string,
  issueNumber: number,
): string[] {
  return [
    "api",
    "-X",
    "PATCH",
    `repos/${repo}/issues/${issueNumber}`,
    "-f",
    "state=closed",
  ];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Close the wrapper on success; comment and leave it open on failure.
 *
 * `gh` failures are logged and swallowed — a stuck issue must never crash the
 * worker — and the caller's own success/failure verdict is unaffected. What
 * the result reports is whether the writes landed, not the verdict
 * (Issue #1753).
 *
 * On success the summary comment is posted first and the close follows,
 * matching what `gh issue close --comment` did. A refused comment does not
 * skip the close: an open wrapper costs a second full scan on the next
 * claim, a missing summary costs a line of context.
 */
export async function finaliseIdleTaskWrapper(
  input: FinaliseIdleTaskWrapperInput,
  deps: FinaliseIdleTaskWrapperDeps,
): Promise<FinaliseIdleTaskWrapperResult> {
  const ghCommand = deps.ghCommandFn ?? defaultRunGhCommand;
  const { repo, issueNumber, ok, summary } = input;

  if (!ok) {
    try {
      await ghCommand(
        idleTaskWrapperCommentArgs(
          repo,
          issueNumber,
          buildIdleTaskFailureComment(summary),
        ),
      );
      return { closed: false, commented: true };
    } catch (err) {
      const error = errorMessage(err);
      deps.logger.warn("Failed to comment on failed idle-task issue", {
        repo,
        issueNumber,
        error,
      });
      return { closed: false, commented: false, error };
    }
  }

  const errors: string[] = [];
  try {
    await ghCommand(idleTaskWrapperCommentArgs(repo, issueNumber, summary));
  } catch (err) {
    const error = errorMessage(err);
    errors.push(`summary comment: ${error}`);
    deps.logger.warn("Failed to post idle-task summary comment", {
      repo,
      issueNumber,
      error,
    });
  }

  let closed = false;
  try {
    await ghCommand(idleTaskWrapperCloseArgs(repo, issueNumber));
    closed = true;
  } catch (err) {
    const error = errorMessage(err);
    errors.push(`close: ${error}`);
    deps.logger.warn("Failed to close idle-task issue", {
      repo,
      issueNumber,
      error,
      // Issue #1753: an open wrapper whose work landed is re-claimed by the
      // next scan, so the reader needs to know the close did not happen.
      wrapperStillOpen: true,
    });
  }

  return errors.length === 0
    ? { closed, commented: false }
    : { closed, commented: false, error: errors.join("; ") };
}
