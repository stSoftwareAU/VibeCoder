/**
 * Issue lifecycle helpers (Issue #966).
 *
 * Self-healing functions for issue closure and PR state recovery.
 * Handles edge cases where GitHub auto-close fails or PRs are
 * closed without merge.
 *
 * Migrated from ensure_issue_closed_if_pr_merged() and
 * handle_pr_closed_after_creation() in issue_worker.sh.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { IssueCache } from "./issue_cache.ts";
import {
  fetchMergedPRsByUser,
  fetchPRsForIssueByTitle,
  invalidatePRsForIssueByTitle,
} from "./issue_query.ts";
import { postMilestoneProgressComment } from "./milestone_progress.ts";
import { type MergeLanding, verifyMergeLanded } from "./merge_landing.ts";
import { prTitleMatchesIssue } from "./pr_issue_linking.ts";
import {
  foreignMergedPrComment,
  mergedPrCompletesThisRun,
} from "./pr_run_provenance.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of checking whether to close an issue after PR merge. */
export interface CloseIfMergedResult {
  /** Whether the issue was closed by this function. */
  closed: boolean;
  /** Human-readable explanation of what happened. */
  reason: string;
  /**
   * The landing verdict when the PR merged but its change did NOT land
   * (Issue #175). Present only for that case, so callers can self-heal an
   * orphaned milestone merge structurally instead of matching on `reason`.
   */
  unlanded?: Extract<MergeLanding, { landed: false }>;
}

/** Result of handling a closed PR. */
export interface HandleClosedPrResult {
  /** Whether corrective action was taken. */
  actionTaken: boolean;
  /** Human-readable explanation of what happened. */
  reason: string;
}

/** Result of unassigning the worker after successful PR creation. */
export interface UnassignAfterPrCreatedResult {
  /** Whether the worker was unassigned. */
  unassigned: boolean;
  /** Human-readable explanation of what happened. */
  reason: string;
}

/** Injectable dependencies for lifecycle functions. */
export interface LifecycleDeps {
  /** Function to run gh CLI commands. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Logger for diagnostic output. */
  logger: Logger;
  /**
   * Merge-landing check (Issue #4396): before an issue is closed because
   * its PR merged, confirm the merge commit is reachable from the default
   * branch (or merged into a milestone branch whose route is still open).
   * Defaults to {@link verifyMergeLanded}; tests inject.
   */
  verifyMergeLandedFn?: typeof verifyMergeLanded;
  /**
   * Close-comment builder (Issue #504). Callers that close an issue from
   * outside the run that produced the fix — the housekeeping merged-PR sweep
   * — need the comment to name the merge commit as well as the PR, so the
   * closure is attributable from the issue alone. Omitted: the default
   * "PR #N has been merged" wording is used.
   */
  closeCommentFn?: (context: {
    repo: string;
    issueNumber: number;
    prNumber: number;
    landing: Extract<MergeLanding, { landed: true }>;
  }) => string;
  /**
   * Optional issue cache (Issue #1787). When provided,
   * `handlePrClosedAfterCreation` reuses the iteration-scoped
   * `prs_merged_${user}` cache instead of issuing a per-issue
   * `gh pr list --search` query.
   */
  cache?: IssueCache;
  /**
   * Optional GitHub username for the worker (Issue #1787). Required
   * when `cache` is set, so the merged-PR cache key can be derived.
   */
  githubUser?: string;
}

// ---------------------------------------------------------------------------
// Cache invalidation helpers (Issue #1798)
// ---------------------------------------------------------------------------

/**
 * Invalidate the iteration-scoped caches that go stale after closing
 * an issue or removing an assignee.
 *
 * - `issues_all` — the shared open-issue list reflects assignment state.
 * - `prs_title_${state}_${issueNumber}` for open/merged/closed — the
 *   per-issue title-search caches reflect the linked PR set; closing
 *   the issue means a follow-up scan should refetch.
 *
 * Best-effort: a missing cache or already-removed key is a no-op.
 */
async function invalidatePostMutation(
  cache: IssueCache | undefined,
  repo: string,
  issueNumber: number,
): Promise<void> {
  if (!cache) return;
  await cache.invalidate(repo, "issues_all");
  await invalidatePRsForIssueByTitle(cache, repo, issueNumber, "open");
  await invalidatePRsForIssueByTitle(cache, repo, issueNumber, "merged");
  await invalidatePRsForIssueByTitle(cache, repo, issueNumber, "closed");
}

// ---------------------------------------------------------------------------
// Change-landed detection (Issue #2523)
// ---------------------------------------------------------------------------

/**
 * Whether any commit message in `messages` references the given issue number.
 *
 * Recognises an *attributing* reference only: the spelled-out `Issue #N` /
 * `Issue N` form (which is the worker's own commit-subject convention), or a
 * GitHub closing keyword immediately followed by `#N` (`Closes #N`,
 * `Fixes #N`, `Resolved #N`). The number boundary is enforced so `#2481` does
 * not match `#24810` or `#481`.
 *
 * Issue #2523: the worker's landing commits reference the issue but may carry
 * no GitHub closing keyword, so GitHub never auto-closes the issue. This pure
 * matcher backs the belt-and-braces closure check.
 *
 * Issue #3661 (SEC-d8cc58c8bc6d): a bare `#N` anywhere in the message used to
 * count. That matched incidental model-authored prose in a commit body ("see
 * #123 for context") and the trailing `(#PR)` GitHub appends to squash-merge
 * subjects — either of which closed an unrelated issue the run was never
 * working on. The result feeds `gh issue close`, so the match must express
 * "this commit is the change for issue N", not merely "issue N is mentioned".
 *
 * @param messages - Newline-joined commit messages from the branch.
 * @param issueNumber - The issue number to look for.
 * @returns true when at least one message attributes a change to the issue.
 */
export function commitMessagesReferenceIssue(
  messages: string,
  issueNumber: number,
): boolean {
  if (!messages || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return false;
  }
  // Static regex (no dynamic RegExp construction) capturing the referenced
  // number, then compare numerically so `#2481` does not match `#24810` or
  // `#481`. The closing-keyword branch requires the `#` so "Fixed 42 bugs"
  // cannot be read as a reference to issue 42.
  const pattern =
    /\bissue\s*:?\s*#?(\d+)|\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;
  for (const match of messages.matchAll(pattern)) {
    const captured = match[1] ?? match[2];
    if (captured && Number(captured) === issueNumber) {
      return true;
    }
  }
  return false;
}

/**
 * Detect whether this issue's change has landed on a branch.
 *
 * Lists the most recent commits on `branchRef` and checks whether any commit
 * message references the issue. This covers the "PR closed without merge, fix
 * force-pushed straight to the base branch with a commit that names the issue
 * but carries no closing keyword" path (Issue #2523, observed in FLEET #2481).
 *
 * Best-effort: any API failure or empty branch ref returns false so the caller
 * falls back to the existing unassign-for-retry behaviour.
 *
 * @param repo - Repository in "owner/repo" format.
 * @param issueNumber - The issue number.
 * @param branchRef - The branch to inspect (typically the PR base branch).
 * @param ghCommandFn - Function to run gh CLI commands.
 * @returns true when a referencing commit is found on the branch.
 */
export async function hasIssueChangeLandedOnBranch(
  repo: string,
  issueNumber: number,
  branchRef: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  if (!branchRef) return false;
  try {
    const out = await ghCommandFn([
      "api",
      `repos/${repo}/commits?sha=${encodeURIComponent(branchRef)}&per_page=50`,
      "--jq",
      ".[].commit.message",
    ]);
    return commitMessagesReferenceIssue(out, issueNumber);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ensure_issue_closed_if_pr_merged
// ---------------------------------------------------------------------------

/**
 * Close an issue if its PR was merged but auto-close didn't trigger.
 *
 * Self-healing function that catches cases where the PR body lacked
 * "Closes #N" or GitHub's auto-close mechanism failed.
 *
 * Issue #591: Belt-and-suspenders issue closure.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param prNumber - The PR number to check
 * @param githubUser - Worker's GitHub username (for unassign)
 * @param deps - Injectable dependencies
 * @returns Result with close status
 */
export async function ensureIssueClosedIfPrMerged(
  repo: string,
  issueNumber: number,
  prNumber: number,
  githubUser: string,
  deps: LifecycleDeps,
  /**
   * The branch this run worked (Issue #174). When given, the merged PR must
   * have it as its head or the issue is left open with a comment: whether a
   * sibling's merged PR completes an issue is its author's call, not the
   * worker's. Omitted by callers that have no branch yet — they guard
   * separately.
   */
  runBranch?: string,
): Promise<Result<CloseIfMergedResult>> {
  const { ghCommandFn, logger } = deps;

  try {
    // Check PR state, and the head ref that proves whose PR it is.
    const prOutput = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state,headRefName",
    ]);
    const prState = JSON.parse(prOutput) as {
      state: string;
      headRefName?: string;
    };

    // Issue #174: provenance before closure. On VibeCoder#42 a human's
    // partial PR merged mid-run and the worker closed the issue against it,
    // stranding three commits. Both PRs had an `issue-42-*` head and the same
    // author, so only the exact branch separates them.
    if (
      prState.state === "MERGED" && runBranch !== undefined &&
      !mergedPrCompletesThisRun(prState.headRefName, runBranch)
    ) {
      logger.warn(
        "Refusing to close the issue: the merged PR is not this run's " +
          "(Issue #174)",
        {
          repo,
          issueNumber,
          prNumber,
          prHead: prState.headRefName ?? "(unknown)",
          runBranch,
        },
      );
      try {
        await ghCommandFn([
          "issue",
          "comment",
          String(issueNumber),
          "--repo",
          repo,
          "--body",
          foreignMergedPrComment(prNumber, runBranch),
        ]);
      } catch (err) {
        logger.warn(
          "Could not comment about the foreign merged PR (non-fatal)",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
      return {
        ok: true,
        value: {
          closed: false,
          reason: `PR #${prNumber} is merged but its head ` +
            `'${prState.headRefName ?? "unknown"}' is not this run's branch ` +
            `'${runBranch}' — left open for the issue author (Issue #174)`,
        },
      };
    }

    if (prState.state !== "MERGED") {
      return {
        ok: true,
        value: {
          closed: false,
          reason: `PR #${prNumber} is not merged (state: ${prState.state})`,
        },
      };
    }

    // A merged PR is not a landed change (Issue #4396): the merge commit
    // must be reachable from the default branch, or sit on a milestone
    // branch whose route there is still open. Otherwise the work is
    // orphaned and the issue stays open, loudly, instead of closing as
    // COMPLETED on the strength of a merge that went nowhere.
    const landing = await (deps.verifyMergeLandedFn ?? verifyMergeLanded)(
      repo,
      prNumber,
      ghCommandFn,
    );
    if (!landing.landed) {
      logger.warn(
        `Not closing issue #${issueNumber}: PR #${prNumber} merged but did not land — ${landing.detail} (Issue #4396)`,
        { repo, issueNumber, prNumber, reason: landing.reason },
      );
      return {
        ok: true,
        value: {
          closed: false,
          reason:
            `PR #${prNumber} merged but its change did not land (${landing.reason}): ${landing.detail} — issue left open (Issue #4396)`,
          // Issue #175: hand the verdict back so the caller can self-heal an
          // orphaned milestone merge rather than bouncing on it every cycle.
          unlanded: landing,
        },
      };
    }

    // Check issue state and milestone (Issue #1236)
    const issueOutput = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "state,milestone",
    ]);
    const issueData = JSON.parse(issueOutput) as {
      state: string;
      milestone?: { title: string } | null;
    };

    if (issueData.state !== "OPEN") {
      return {
        ok: true,
        value: {
          closed: false,
          reason: `Issue #${issueNumber} is already closed`,
        },
      };
    }

    // Close the issue
    logger.info("Self-healing: closing issue after PR merge", {
      repo,
      issueNumber,
      prNumber,
    });

    await ghCommandFn([
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repo,
      "--comment",
      deps.closeCommentFn?.({ repo, issueNumber, prNumber, landing }) ??
        `Automatically closed — PR #${prNumber} has been merged.`,
    ]);

    // Unassign
    try {
      await ghCommandFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        githubUser,
      ]);
    } catch {
      // Non-critical
    }

    // Post milestone progress notification (Issue #1236)
    if (issueData.milestone?.title) {
      const logFn = (msg: string) => logger.info(msg);
      await postMilestoneProgressComment(
        repo,
        issueNumber,
        issueData.milestone.title,
        ghCommandFn,
        logFn,
      ).catch(() => {
        // Best-effort — do not fail the closure for a notification
      });
    }

    // Issue #1798: post-mutation cache invalidation so subsequent
    // helpers in the same iteration see the closed/unassigned state.
    await invalidatePostMutation(deps.cache, repo, issueNumber);

    return {
      ok: true,
      value: {
        closed: true,
        reason: `Closed issue #${issueNumber} after PR #${prNumber} merged`,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to check/close issue: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// unassign_after_pr_created (Issue #1453)
// ---------------------------------------------------------------------------

/**
 * Unassign the worker from an issue immediately after a PR is created.
 *
 * Issue #1453: After successful PR creation the worker remains assigned
 * to the source issue, leaving an "assigned + no heartbeat" state that
 * `detectAssignedWithoutHeartbeat` later recovers as if the worker had
 * crashed (with a confusing "Automatic recovery" comment). Explicitly
 * unassigning here makes the hand-off deliberate and suppresses the
 * recovery noise.
 *
 * Best-effort: failures are logged as warnings and returned as a
 * non-ok Result, but callers should not fail the PR-creation workflow
 * when this step fails.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number to unassign from
 * @param githubUser - Worker's GitHub username
 * @param deps - Injectable dependencies
 * @returns Result indicating whether the unassign succeeded
 */
export async function unassignAfterPrCreated(
  repo: string,
  issueNumber: number,
  githubUser: string,
  deps: LifecycleDeps,
): Promise<Result<UnassignAfterPrCreatedResult>> {
  const { ghCommandFn, logger } = deps;

  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-assignee",
      githubUser,
    ]);

    logger.info("Unassigned worker from issue after PR creation", {
      repo,
      issueNumber,
      githubUser,
    });

    // Issue #1798: post-mutation cache invalidation so subsequent
    // helpers in the same iteration see the unassigned state.
    await invalidatePostMutation(deps.cache, repo, issueNumber);

    return {
      ok: true,
      value: {
        unassigned: true,
        reason:
          `Unassigned ${githubUser} from issue #${issueNumber} after PR creation`,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to unassign worker after PR creation (non-fatal)", {
      repo,
      issueNumber,
      githubUser,
      error: message,
    });
    return {
      ok: false,
      error: new Error(
        `Failed to unassign worker from issue #${issueNumber}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// handle_pr_closed_after_creation
// ---------------------------------------------------------------------------

/**
 * Handle a PR that was closed without merge after creation.
 *
 * Takes corrective action when a PR is closed (e.g., by close_duplicate_prs).
 * Checks for other merged PRs and either closes the issue or unassigns
 * for retry.
 *
 * Issue #787: Self-healing for closed PRs.
 * Issue #563: Detect stale previous merge attempts.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param prNumber - The PR that was closed
 * @param githubUser - Worker's GitHub username
 * @param deps - Injectable dependencies
 * @returns Result with 0 if PR is open/merged (no action), 1 if closed and handled
 */
export async function handlePrClosedAfterCreation(
  repo: string,
  issueNumber: number,
  prNumber: number,
  githubUser: string,
  deps: LifecycleDeps,
): Promise<Result<HandleClosedPrResult>> {
  const { ghCommandFn, logger } = deps;

  try {
    // Check current PR state and base branch (Issue #2523: baseRefName is
    // needed for the change-landed detection below).
    const prOutput = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state,baseRefName",
    ]);
    const prState = JSON.parse(prOutput) as {
      state: string;
      baseRefName?: string;
    };

    if (prState.state !== "CLOSED") {
      return {
        ok: true,
        value: {
          actionTaken: false,
          reason: `PR #${prNumber} is ${prState.state} — no action needed`,
        },
      };
    }

    // Check issue state
    const issueOutput = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "state",
    ]);
    const issueState = JSON.parse(issueOutput) as { state: string };

    if (issueState.state !== "OPEN") {
      // Issue already closed — just unassign
      try {
        await ghCommandFn([
          "issue",
          "edit",
          String(issueNumber),
          "--repo",
          repo,
          "--remove-assignee",
          githubUser,
        ]);
      } catch {
        // Non-critical
      }
      return {
        ok: true,
        value: {
          actionTaken: false,
          reason: `Issue #${issueNumber} already closed`,
        },
      };
    }

    // Search for other merged PRs for this issue.
    // Issue #1787: when cache + githubUser are provided, reuse the
    // iteration-scoped `prs_merged_${user}` cache and filter locally
    // by issue-number in title.
    // Issue #1798: route the title-search fallback through
    // `fetchPRsForIssueByTitle` so the per-(issue, state) cache is
    // shared with sibling helpers (stuck-recovery, stuck-detection)
    // within the same iteration.
    let hasMergedPr = false;
    let cacheUsed = false;
    if (deps.cache && deps.githubUser) {
      try {
        const merged = await fetchMergedPRsByUser(
          repo,
          deps.githubUser,
          deps.cache,
          30,
          ghCommandFn,
        );
        hasMergedPr = merged.some((pr) =>
          prTitleMatchesIssue(pr.title, issueNumber)
        );
        cacheUsed = true;
      } catch {
        // Fall through to title-search below.
      }
    }
    if (!cacheUsed) {
      try {
        const mergedPrs = await fetchPRsForIssueByTitle(
          repo,
          issueNumber,
          "merged",
          deps.cache,
          ghCommandFn,
        );
        hasMergedPr = mergedPrs.length > 0;
      } catch {
        // Search failed — continue without
      }
    }

    if (hasMergedPr) {
      // Another PR was merged — close the issue
      logger.info("Self-healing: closing issue — another PR was merged", {
        repo,
        issueNumber,
        closedPr: prNumber,
      });

      await ghCommandFn([
        "issue",
        "close",
        String(issueNumber),
        "--repo",
        repo,
        "--comment",
        `PR #${prNumber} was closed, but another PR for this issue has already been merged. Closing as resolved.`,
      ]);

      try {
        await ghCommandFn([
          "issue",
          "edit",
          String(issueNumber),
          "--repo",
          repo,
          "--remove-assignee",
          githubUser,
        ]);
      } catch {
        // Non-critical
      }

      // Issue #1798: post-mutation cache invalidation so subsequent
      // helpers in the same iteration see the closed/unassigned state.
      await invalidatePostMutation(deps.cache, repo, issueNumber);

      return {
        ok: true,
        value: {
          actionTaken: true,
          reason: "Closed issue — another PR was merged",
        },
      };
    }

    // Issue #2523: belt-and-braces closure. The PR was closed without merge
    // and no other PR was merged, but the change may still have landed on the
    // base branch via a direct/force push whose commit references the issue
    // without a GitHub closing keyword (FLEET #2481). If so, close the issue
    // rather than re-queuing already-completed work.
    const landed = await hasIssueChangeLandedOnBranch(
      repo,
      issueNumber,
      prState.baseRefName ?? "",
      ghCommandFn,
    );
    if (landed) {
      const baseRef = prState.baseRefName ?? "";
      logger.info(
        "Self-healing: closing issue — change landed on base branch",
        {
          repo,
          issueNumber,
          closedPr: prNumber,
          baseRef,
        },
      );

      await ghCommandFn([
        "issue",
        "close",
        String(issueNumber),
        "--repo",
        repo,
        "--comment",
        `PR #${prNumber} was closed without merge, but the change for this issue ` +
        `has landed on \`${baseRef}\`. Closing as resolved.`,
      ]);

      try {
        await ghCommandFn([
          "issue",
          "edit",
          String(issueNumber),
          "--repo",
          repo,
          "--remove-assignee",
          githubUser,
        ]);
      } catch {
        // Non-critical
      }

      // Issue #1798: post-mutation cache invalidation so subsequent
      // helpers in the same iteration see the closed/unassigned state.
      await invalidatePostMutation(deps.cache, repo, issueNumber);

      return {
        ok: true,
        value: {
          actionTaken: true,
          reason:
            `Closed issue — change landed on \`${baseRef}\` after PR closed without merge`,
        },
      };
    }

    // No merged PR — unassign so the issue can be picked up again
    logger.info(
      "Self-healing: unassigning issue after PR closed without merge",
      {
        repo,
        issueNumber,
        closedPr: prNumber,
      },
    );

    try {
      await ghCommandFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        githubUser,
      ]);
    } catch {
      // Non-critical
    }

    try {
      await ghCommandFn([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        repo,
        "--body",
        `PR #${prNumber} was closed without being merged. Unassigning so this issue can be retried.`,
      ]);
    } catch {
      // Non-critical
    }

    // Issue #1798: post-mutation cache invalidation so subsequent
    // helpers in the same iteration see the unassigned state.
    await invalidatePostMutation(deps.cache, repo, issueNumber);

    return {
      ok: true,
      value: {
        actionTaken: true,
        reason: "Unassigned issue for retry after PR closed",
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to handle closed PR: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }
}
