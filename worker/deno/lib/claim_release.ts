/**
 * Shared "release the worker's claim" helper for phase processors
 * (Issue #2728).
 *
 * Several phase processors (grill-me, clarity, planning, refinement,
 * question, revision) self-assign the worker user when they claim an
 * issue. Once the ball is back in the developer's court — a round
 * comment posted, a label-routing hand-off, or a terminal failure — the
 * self-assignment must be released. Otherwise the
 * assigned-without-heartbeat detector trips a spurious "Automatic
 * recovery" comment ~30 minutes later (Issue #1830).
 *
 * This module centralises the best-effort try/log/return-boolean shape
 * that was previously copy-pasted into each processor, so every claim is
 * released the same way.
 */

import type { GitHubClient, Logger } from "../types.ts";
import type { RunOutcome } from "./run_outcome.ts";
import { CLAIM_MARKER_PREFIX } from "./claim_issue.ts";
import { HEARTBEAT_MARKER_PREFIX } from "./heartbeat_storage.ts";

/**
 * Marker-release path (Issue #4330, part of #4291): when a caller supplies
 * an outcome, the shared helpers forward it here so the heartbeat marker
 * comment states what the run achieved — the same text the coding path
 * writes. Production wiring registers `clearHeartbeat` bound to the work
 * dir and marker options; absent (tests, CLI), the outcome is simply not
 * rendered and behaviour is exactly today's.
 */
export type MarkerReleaseHook = (
  repo: string,
  issueNumber: number,
  outcome: RunOutcome,
) => Promise<void>;

let markerReleaseHook: MarkerReleaseHook | undefined;

/** Register the marker-release path. Returns a restore function. */
export function setMarkerReleaseHook(
  hook: MarkerReleaseHook | undefined,
): () => void {
  const previous = markerReleaseHook;
  markerReleaseHook = hook;
  return () => {
    markerReleaseHook = previous;
  };
}

async function releaseMarker(
  repo: string,
  issueNumber: number,
  outcome: RunOutcome | undefined,
  logger: Pick<Logger, "warn">,
): Promise<void> {
  if (!outcome || !markerReleaseHook) return;
  try {
    await markerReleaseHook(repo, issueNumber, outcome);
  } catch (err) {
    logger.warn("Failed to record the run outcome on the release comment", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Options for {@link releaseClaim} (Issue #4330). */
export interface ReleaseClaimOutcomeOptions {
  /**
   * What the run achieved. Forwarded to the marker-release path so the
   * release comment states it. Omitted → today's behaviour, byte for byte.
   */
  outcome?: RunOutcome;
}

/**
 * Best-effort release of the worker's self-assignment on an issue.
 *
 * The release is best-effort by design (Issue #1830): a failure — the
 * worker was never assigned, or a transient API error — is logged and
 * swallowed, never thrown. The existing assigned-without-heartbeat
 * recovery still catches the case where the unassign silently fails.
 *
 * @param ghClient - GitHub client (only `unassignIssue` is used).
 * @param repo - `owner/repo` slug.
 * @param issueNumber - Issue to release the claim on.
 * @param githubUser - Worker user to remove from the assignee list.
 * @param logger - Logger for the best-effort failure warning.
 * @returns `true` when the unassign call succeeded; `false` on failure
 *   (the error is logged and swallowed).
 */
export async function releaseClaim(
  ghClient: Pick<GitHubClient, "unassignIssue">,
  repo: string,
  issueNumber: number,
  githubUser: string,
  logger: Pick<Logger, "warn">,
  options: ReleaseClaimOutcomeOptions = {},
): Promise<boolean> {
  // The outcome lands on the release comment first (Issue #4330), so a
  // failed unassign never loses the diagnosis.
  await releaseMarker(repo, issueNumber, options.outcome, logger);
  try {
    await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
    return true;
  } catch (err) {
    // Best-effort — tolerate "user not assigned" and other transient
    // errors. The assigned-without-heartbeat recovery still catches a
    // silently-failed unassign.
    logger.warn("Failed to release worker claim (unassign)", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Default sleep used by the bounded retry in {@link releaseAllWorkerClaims}. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options controlling the bounded retry of {@link releaseAllWorkerClaims}. */
export interface ReleaseAllWorkerClaimsOptions
  extends ReleaseClaimOutcomeOptions {
  /** Extra unassign attempts after the first (default `2`). */
  retries?: number;
  /** Delay between attempts in milliseconds (default `500`). */
  retryDelayMs?: number;
  /** Injectable sleep for deterministic testing. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Resolve every assigned account that is safe to unassign (Issue #3109).
 *
 * The scanning worker's own `githubUser` is **always** included — this
 * preserves {@link releaseClaim}'s guarantee that the current run's claim
 * is cleared, even when the just-made assignment is not yet visible on a
 * stale read. Any *other* assignee is only included when it has posted a
 * claim (`CLAIM_LOCK`) or heartbeat (`VIBE_CODER_HEARTBEAT`) marker on the
 * issue — the same evidence the cross-account recovery uses (Issue #2671) —
 * so a human teammate assignee is never auto-cleared.
 *
 * Comment-fetch failure degrades gracefully: only the own account is
 * returned, matching the prior single-account behaviour.
 */
async function resolveWorkerAssignees(
  ghClient: Pick<GitHubClient, "getIssue" | "getIssueComments">,
  repo: string,
  issueNumber: number,
  githubUser: string,
): Promise<string[]> {
  // Own account is always cleared (the prior single-account guarantee).
  const workers = new Set<string>([githubUser]);

  const issue = await ghClient.getIssue(repo, issueNumber);
  const others = (issue.assignees ?? []).filter((a) => a !== githubUser);
  if (others.length === 0) return [...workers];

  // Other accounts need marker evidence before we may clear them.
  try {
    const comments = await ghClient.getIssueComments(repo, issueNumber);
    const markerAuthors = new Set<string>();
    for (const c of comments) {
      if (
        typeof c.body === "string" &&
        (c.body.includes(CLAIM_MARKER_PREFIX) ||
          c.body.includes(HEARTBEAT_MARKER_PREFIX))
      ) {
        markerAuthors.add(c.author);
      }
    }
    for (const other of others) {
      if (markerAuthors.has(other)) workers.add(other);
    }
  } catch {
    // Comments unavailable — fall back to clearing only the own account.
    return [...workers];
  }
  return [...workers];
}

/**
 * Reliably release the worker's claim by unassigning **whichever** worker
 * account is assigned, with a bounded retry (Issue #3109).
 *
 * A grill-me cycle spans several runs across different fleet accounts, so
 * {@link releaseClaim} — which only removes the current run's account —
 * leaves an earlier round's account assigned until the ~30-minute
 * cross-account recovery clears it. This helper resolves every assigned
 * *worker* account (evidence-based via the claim/heartbeat markers,
 * Issue #2671) and removes them all in a single `unassignIssue` call,
 * retrying a bounded number of times on a transient API error so one flaky
 * call no longer falls straight through to the slow recovery.
 *
 * Best-effort by design: if assignee resolution fails entirely it falls
 * back to clearing only `githubUser`, and a final failure after all
 * retries is logged and swallowed (never thrown). The existing
 * assigned-without-heartbeat recovery remains the silent backstop — no
 * human is ever flagged.
 *
 * @returns `true` when there was nothing to clear or the unassign
 *   succeeded; `false` when every attempt failed.
 */
export async function releaseAllWorkerClaims(
  ghClient: Pick<
    GitHubClient,
    "getIssue" | "getIssueComments" | "unassignIssue"
  >,
  repo: string,
  issueNumber: number,
  githubUser: string,
  logger: Pick<Logger, "warn">,
  options: ReleaseAllWorkerClaimsOptions = {},
): Promise<boolean> {
  const { retries = 2, retryDelayMs = 500, sleepFn = defaultSleep } = options;
  await releaseMarker(repo, issueNumber, options.outcome, logger);

  let workerAssignees: string[];
  try {
    workerAssignees = await resolveWorkerAssignees(
      ghClient,
      repo,
      issueNumber,
      githubUser,
    );
  } catch (err) {
    // Could not resolve the assignee set (e.g. getIssue failed) — fall
    // back to clearing the current account only, preserving the prior
    // single-account behaviour.
    logger.warn("Failed to resolve worker assignees; clearing own account", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    workerAssignees = [githubUser];
  }

  if (workerAssignees.length === 0) return true;

  for (let attempt = 0;; attempt++) {
    try {
      await ghClient.unassignIssue(repo, issueNumber, workerAssignees);
      return true;
    } catch (err) {
      if (attempt >= retries) {
        // Best-effort — the assigned-without-heartbeat recovery still
        // catches a silently-failed unassign (Issue #1830/#2671).
        logger.warn("Failed to release worker claims after retries", {
          repo,
          issueNumber,
          assignees: workerAssignees,
          attempts: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      await sleepFn(retryDelayMs);
    }
  }
}

/**
 * Adapt a raw `gh` command runner into the minimal `unassignIssue`
 * surface {@link releaseClaim} expects.
 *
 * Some processors (e.g. the clarity phase) hold an injectable
 * `ghCommandFn` rather than a full {@link GitHubClient}. The produced
 * `unassignIssue` emits the same `gh issue edit … --remove-assignee`
 * invocation a real {@link GitHubClient} would, so behaviour is
 * unchanged.
 */
export function unassignerFromGhCommand(
  ghCommandFn: (args: string[]) => Promise<string>,
): Pick<GitHubClient, "unassignIssue"> {
  return {
    async unassignIssue(
      repo: string,
      issueNumber: number,
      assignees: string[],
    ): Promise<void> {
      await ghCommandFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        assignees.join(","),
      ]);
    },
  };
}
