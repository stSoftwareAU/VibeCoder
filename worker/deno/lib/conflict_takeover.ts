/**
 * The conflict takeover pass (Issue #2999, part of #2965).
 *
 * A stalled, conflicted PR today sits labelled `merge-conflict` waiting for
 * the stale-verdict ladder or the owner to act. This pass is the rung that
 * takes the stall back off the owner's plate and resolves the conflict
 * itself, once the stand-down watchdog (a sibling sub-issue of #2965) decides
 * the PR has sat long enough.
 *
 * **The gated route.** A PR whose head is a ruleset-gated `milestone/**`
 * branch refuses a direct push (GH013), so the ordinary resolve-and-push
 * shape cannot land there at all. This pass asks {@link assessGatedHead}
 * and, when the head is gated, resolves on a side `milestone-fix/**` branch
 * and delivers the fix through a pull request into the gated head, using the
 * {@link findOpenMilestoneFixPr}/{@link raiseMilestoneFixPr} helpers Issue
 * #2907 built for exactly this shape. A fix PR already open for this
 * milestone PR is reused rather than duplicated.
 *
 * **The shared budget (Issue #2996).** This pass spends from the same
 * {@link CONFLICT_RESOLUTION_BUDGET} every other conflict-resolution pass
 * spends from, tallied as `pass="…"` markers on the PR itself — never
 * host-local state — so routing a PR through more than one pass cannot
 * multiply its budget. A PR whose budget is already spent is declined before
 * anything is posted.
 *
 * **Label provenance (Issue #2951).** The `merge-conflict` label is only
 * removed by this pass when this pass's own call is what added it — a label
 * a human or an earlier pass already applied is never cleared out from under
 * them.
 *
 * **The marker-free seam contract.** {@link ConflictTakeoverDeps.resolveViaLadder}
 * and {@link ConflictTakeoverDeps.resolveOnFixBranch} are the two resolvers
 * this pass calls, and neither posts its own attempt/conclusion markers —
 * this pass owns that pair, so a resolver that posted its own would spend two
 * units of the shared budget for one takeover. Their bindings land with the
 * stall-watchdog sub-issue that calls this pass.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  CONFLICT_RESOLUTION_BUDGET,
  conflictAttemptMarker,
  conflictFailedMarker,
  conflictResolvedMarker,
  isConflictHeadSha,
  readResolutionAttempts,
} from "./merge_conflict_markers.ts";
import {
  clearMergeConflictLabel,
  ensureMergeConflictLabel,
  fetchPrLabels,
  isConflictAttemptDue,
  spentConflictAttempts,
} from "./pr_merge_conflict_scan.ts";
import { assessGatedHead, isMilestoneHead } from "./gated_head_guard.ts";
import {
  acquireBranchUpdateLock,
  type BranchLockRenewalHandle,
  type BranchUpdateLockOptions,
  parsePostedCommentId,
  releaseBranchUpdateLock,
  startBranchUpdateLockRenewal,
} from "./pr_branch_lock.ts";
import {
  findOpenMilestoneFixPr,
  milestoneFixBranchFor,
  type MilestoneFixPr,
  type MilestoneFixPrDeps,
  raiseMilestoneFixPr,
} from "./milestone_fix_pr.ts";
import { grantAgentRun } from "./milestone_branch_sync.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A conflicted PR this pass may resolve. */
export interface ConflictTakeoverPr {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** PR number. */
  number: number;
  /** Head branch name. */
  headRefName: string;
  /** Base branch the PR targets. */
  baseRefName: string;
  /** The PR's live head sha. */
  headSha: string;
}

/** What one resolver attempt did. */
export interface TakeoverResolution {
  /** True when the merge landed. */
  resolved: boolean;
  /** One line naming what happened — carried into the conclusion comment. */
  detail: string;
  /**
   * True when the agent was cut short by the worker, or the provider refused
   * the run, so the attempt must not be charged (Issues #1693, #2613).
   */
  disrupted?: boolean;
}

/**
 * Seconds the takeover agent may run, sized to the handler's remaining
 * deadline (Issue #1693).
 *
 * Undefined when the pass declared no deadline: the binding then keeps the
 * configured timeout. Otherwise the grant is the lesser of that timeout and
 * the time still left, and never below one second.
 */
export function takeoverAgentTimeoutSeconds(
  deadlineEpochMs: number | undefined,
  claudeTimeoutSeconds: number,
  nowMs: number,
): number | undefined {
  if (deadlineEpochMs === undefined) return undefined;
  const remainingMs = deadlineEpochMs - nowMs;
  return Math.max(
    1,
    Math.floor(Math.min(claudeTimeoutSeconds * 1000, remainingMs) / 1000),
  );
}

/** Injected seams for {@link runConflictTakeover}. */
export interface ConflictTakeoverDeps {
  /** Every GitHub read/write this pass makes. Throws on failure. */
  gh: (args: string[]) => Promise<string>;
  /** Fleet logins whose marker comments count towards the shared budget. */
  trustedAuthors: readonly string[];
  /**
   * The ordinary (ladder) resolve path for a non-gated head: merges the base
   * into the PR head and pushes the head.
   *
   * Marker-free by contract — this pass owns the attempt/conclusion markers,
   * so the binding must not post its own (a second marker pair would spend
   * two units of the shared budget for one takeover).
   */
  resolveViaLadder: (pr: ConflictTakeoverPr) => Promise<TakeoverResolution>;
  /**
   * Resolve on a side branch: create `fixBranch` from the PR head, merge the
   * base in, resolve, and push ONLY `fixBranch` — never the gated head.
   *
   * Same marker-free contract as {@link resolveViaLadder}.
   */
  resolveOnFixBranch: (
    pr: ConflictTakeoverPr,
    fixBranch: string,
  ) => Promise<TakeoverResolution>;
  logger: Logger;
  /**
   * This host's id. When set, the takeover takes the same cross-host PR
   * lock the ladder uses before it posts an attempt, and stands down while
   * another worker holds it (Issue #3001 review).
   */
  workerId?: string;
  /** Defaults to {@link acquireBranchUpdateLock}. */
  acquireLockFn?: (
    options: BranchUpdateLockOptions,
  ) => ReturnType<typeof acquireBranchUpdateLock>;
  /** Defaults to {@link releaseBranchUpdateLock}. */
  releaseLockFn?: typeof releaseBranchUpdateLock;
  /** Defaults to {@link startBranchUpdateLockRenewal}. */
  startLockRenewalFn?: typeof startBranchUpdateLockRenewal;
  /**
   * Handler deadline. When set, the takeover declines with no marker unless
   * the time left covers the drain's agent floor ({@link grantAgentRun}).
   * A grant shorter than that floor times the agent out, and a timeout is a
   * charged failure (Issue #2305).
   */
  deadlineEpochMs?: number;
  /** Clock for {@link deadlineEpochMs}. Defaults to `Date.now`. */
  nowMs?: number;
}

/** What one takeover run did. */
export type ConflictTakeoverOutcome =
  /** The shared budget was already spent; nothing was posted. */
  | { kind: "declined-budget"; attemptsSpent: number }
  /**
   * The thread changed between the tally read and the lock: another pass
   * posted its attempt, so this one stands down and posts nothing.
   */
  | { kind: "no-longer-due" }
  /** A fix PR for this milestone PR is already open; nothing was attempted. */
  | { kind: "fix-pr-reused"; fixPr: MilestoneFixPr }
  /** The gated route resolved and a fix PR now carries it into the head. */
  | { kind: "fix-pr-raised"; fixPr: MilestoneFixPr; fixBranch: string }
  /** The ordinary (non-gated) route resolved the conflict directly. */
  | { kind: "resolved" }
  /** Either route ran and did not resolve the conflict. */
  | {
    kind: "failed";
    route: "milestone-fix" | "ladder";
    detail: string;
  }
  /**
   * The agent was cut short or the provider refused the run. The attempt
   * marker is withdrawn and nothing is charged.
   */
  | {
    kind: "disrupted";
    route: "milestone-fix" | "ladder";
    detail: string;
  }
  /**
   * Another host holds the cross-host PR lock; nothing was posted.
   * `lockAgeSeconds` is how old the holder's lock marker is, when it could
   * be read (Issue #3031).
   */
  | { kind: "lock-held"; holder: string; lockAgeSeconds?: number }
  /**
   * The handler time left cannot cover an agent run. Nothing was posted,
   * so the next cycle can try once the budget is there.
   */
  | { kind: "declined-time" };

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** The sha's first 12 hex characters, for a human-readable branch/comment suffix. */
function shortSha(headSha: string): string {
  return headSha.trim().toLowerCase().slice(0, 12);
}

/** The attempt comment body. */
function buildAttemptComment(
  attemptNumber: number,
  headSha: string,
  route: "milestone-fix PR" | "ordinary resolve",
): string {
  return [
    `🔀 **Conflict takeover** — attempt ${attemptNumber} of ` +
    `${CONFLICT_RESOLUTION_BUDGET} on head \`${shortSha(headSha)}\`, route: ` +
    `${route}.`,
    "",
    conflictAttemptMarker(attemptNumber, "takeover", headSha),
  ].join("\n");
}

/** The conclusion comment body for a resolved outcome. */
function buildResolvedComment(headSha: string, detail: string): string {
  return [
    `✅ **Conflict takeover resolved** — ${detail}`,
    "",
    conflictResolvedMarker("takeover", headSha),
  ].join("\n");
}

/** The conclusion comment body for a failed outcome. */
function buildFailedComment(
  attemptNumber: number,
  headSha: string,
  detail: string,
): string {
  return [
    `❌ **Conflict takeover failed** — ${detail}`,
    "",
    conflictFailedMarker(attemptNumber, "takeover", headSha),
  ].join("\n");
}

/**
 * Delete the attempt marker a cut-short run posted, so it spends nothing.
 *
 * A marker that cannot be deleted is left open and said out loud: the next
 * scan reads it as disrupted and retries it, which is the same bound the
 * processor already uses (Issue #1693).
 */
async function withdrawTakeoverAttempt(
  pr: ConflictTakeoverPr,
  commentId: number | null,
  why: string,
  gh: ConflictTakeoverDeps["gh"],
  logger: Logger,
): Promise<void> {
  if (commentId === null) {
    logger.warn(
      "Could not withdraw the takeover attempt marker — no comment id was " +
        "reported when it was posted",
      { repo: pr.repo, prNumber: pr.number, why },
    );
    return;
  }
  try {
    await gh([
      "api",
      "-X",
      "DELETE",
      `repos/${pr.repo}/issues/comments/${commentId}`,
    ]);
  } catch (error) {
    logger.warn("Could not withdraw the takeover attempt marker", {
      repo: pr.repo,
      prNumber: pr.number,
      commentId,
      why,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Post one PR comment. */
function postComment(
  pr: ConflictTakeoverPr,
  body: string,
  gh: ConflictTakeoverDeps["gh"],
): Promise<string> {
  return gh([
    "pr",
    "comment",
    String(pr.number),
    "--repo",
    pr.repo,
    "--body",
    body,
  ]);
}

/**
 * Resolve a stalled conflicted PR (Issue #2999).
 *
 * Validates the head sha and the trusted-author set, reads the shared tally
 * (Issue #2996) and declines before posting anything once it is spent,
 * checks whether the head is gated (Issue #2907) and reuses or raises a fix
 * PR when it is, posts the attempt marker, runs the appropriate resolver,
 * and posts the conclusion. The `merge-conflict` label is removed only on an
 * ordinary resolved outcome and only when this call is the one that added it
 * (Issue #2951).
 */
export async function runConflictTakeover(
  pr: ConflictTakeoverPr,
  deps: ConflictTakeoverDeps,
): Promise<ConflictTakeoverOutcome> {
  const { gh, logger } = deps;
  const context = { repo: pr.repo, prNumber: pr.number };

  const headSha = pr.headSha.trim().toLowerCase();
  if (!isConflictHeadSha(headSha)) {
    throw new Error(
      `runConflictTakeover: '${pr.headSha}' is not a usable head sha for ` +
        `${pr.repo}#${pr.number}`,
    );
  }
  if (deps.trustedAuthors.length === 0) {
    throw new Error(
      `runConflictTakeover: trustedAuthors is empty for ${pr.repo}#${pr.number} ` +
        "— an unattributable tally would never spend, so the shared budget " +
        "would not bound this pass",
    );
  }
  const trustedAuthors = [...deps.trustedAuthors];
  const isTrustedAuthor = (login: string) =>
    isFleetAuthor(login, trustedAuthors);

  const comments = await fetchIssueCommentPages(pr.repo, pr.number, gh);
  const attempts = readResolutionAttempts(comments, isTrustedAuthor);
  const spent = spentConflictAttempts(attempts);

  if (spent >= CONFLICT_RESOLUTION_BUDGET) {
    logger.info(
      `Conflict takeover declined for PR #${pr.number}: the shared budget ` +
        `is already spent (${spent}/${CONFLICT_RESOLUTION_BUDGET})`,
      { ...context, attemptsSpent: spent },
    );
    return { kind: "declined-budget", attemptsSpent: spent };
  }

  const assessment = await assessGatedHead(pr.repo, pr.headRefName, gh);
  // Every milestone head goes through a fix PR, gated or not. An ungated or
  // unreadable ruleset must not push the agent's merge onto milestone/**
  // (Issue #2965): that push skips the merge gate and races the sync.
  const useFixRoute = assessment.gated || isMilestoneHead(pr.headRefName);

  const milestoneDeps: MilestoneFixPrDeps = {
    gh,
    log: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
  };

  if (useFixRoute) {
    const existing = await findOpenMilestoneFixPr(
      pr.repo,
      pr.headRefName,
      pr.number,
      { ...milestoneDeps, fleetAuthors: trustedAuthors },
      "takeover-",
    );
    if (!existing.ok) throw existing.error;
    if (existing.value !== null) {
      logger.info(
        `Conflict takeover for PR #${pr.number}: an open fix PR already ` +
          `resolves this gated head (#${existing.value.number}) — nothing ` +
          "further to do",
        { ...context, fixPrNumber: existing.value.number },
      );
      return { kind: "fix-pr-reused", fixPr: existing.value };
    }
  }

  if (deps.deadlineEpochMs !== undefined) {
    const grant = grantAgentRun({
      deadlineEpochMs: deps.deadlineEpochMs,
      nowMs: deps.nowMs ?? Date.now(),
    });
    if (!grant.agentAllowed) {
      logger.info(
        `Conflict takeover declined for PR #${pr.number}: the handler ` +
          `time left cannot cover an agent run, so no attempt is posted`,
        context,
      );
      return { kind: "declined-time" };
    }
  }

  const held = await holdTakeoverLock(pr, deps);
  if (held.kind === "held-by-other") {
    logger.info(
      `Conflict takeover for PR #${pr.number}: standing down, the ` +
        `cross-host lock is held by ${held.holder}` +
        (held.lockAgeSeconds !== undefined
          ? ` (lock age ${held.lockAgeSeconds}s)`
          : ""),
      {
        ...context,
        lockHolder: held.holder,
        ...(held.lockAgeSeconds !== undefined
          ? { lockAgeSeconds: held.lockAgeSeconds }
          : {}),
      },
    );
    return {
      kind: "lock-held",
      holder: held.holder,
      ...(held.lockAgeSeconds !== undefined
        ? { lockAgeSeconds: held.lockAgeSeconds }
        : {}),
    };
  }

  try {
    // The tally above was read before the lock. A sync can post its marker
    // in that gap and then release; re-read under the lock and stand down
    // when the thread changed, so both passes cannot spend an attempt in
    // the same window (Issue #2965).
    const freshComments = await fetchIssueCommentPages(pr.repo, pr.number, gh);
    const freshAttempts = readResolutionAttempts(
      freshComments,
      isTrustedAuthor,
    );
    const freshSpent = spentConflictAttempts(freshAttempts);
    if (freshSpent >= CONFLICT_RESOLUTION_BUDGET) {
      logger.info(
        `Conflict takeover declined for PR #${pr.number}: the shared budget ` +
          `was spent while this pass waited for the lock ` +
          `(${freshSpent}/${CONFLICT_RESOLUTION_BUDGET})`,
        { ...context, attemptsSpent: freshSpent },
      );
      return { kind: "declined-budget", attemptsSpent: freshSpent };
    }
    if (attemptStamp(freshAttempts) !== attemptStamp(attempts)) {
      logger.info(
        `Conflict takeover for PR #${pr.number}: standing down, an attempt ` +
          `landed while this pass waited for the lock`,
        context,
      );
      return { kind: "no-longer-due" };
    }
    // The baseline above can already contain a marker the watchdog had not
    // seen when it decided this PR was due. A fresh failure on the same head
    // is not due for another two hours (Issue #2965).
    const now = deps.nowMs ?? Date.now();
    if (!isConflictAttemptDue(freshAttempts, headSha, now)) {
      logger.info(
        `Conflict takeover for PR #${pr.number}: standing down, the latest ` +
          `failure on this head is still inside the owner-check window`,
        context,
      );
      return { kind: "no-longer-due" };
    }

    const attemptNumber = freshSpent + 1;
    const route = useFixRoute ? "milestone-fix PR" : "ordinary resolve";
    const attemptPosted = await postComment(
      pr,
      buildAttemptComment(attemptNumber, headSha, route),
      gh,
    );
    const attemptCommentId = parsePostedCommentId(attemptPosted);

    let appliedLabel = false;
    let outcome: ConflictTakeoverOutcome;
    try {
      const labels = await fetchPrLabels(pr.repo, pr.number, gh);
      appliedLabel = await ensureMergeConflictLabel(
        pr.repo,
        pr.number,
        labels,
        gh,
      );

      if (useFixRoute) {
        const fixBranch = milestoneFixBranchFor(
          pr.headRefName,
          pr.number,
          `takeover-${shortSha(headSha)}`,
        );
        const resolution = await deps.resolveOnFixBranch(pr, fixBranch);
        if (!resolution.resolved) {
          outcome = resolution.disrupted
            ? {
              kind: "disrupted",
              route: "milestone-fix",
              detail: resolution.detail,
            }
            : {
              kind: "failed",
              route: "milestone-fix",
              detail: resolution.detail,
            };
        } else {
          const raised = await raiseMilestoneFixPr({
            repo: pr.repo,
            milestoneBranch: pr.headRefName,
            milestonePrNumber: pr.number,
            fixBranch,
            pass: "merge-conflict resolution",
          }, milestoneDeps);
          if (!raised.ok) throw raised.error;
          outcome = {
            kind: "fix-pr-raised",
            fixPr: raised.value,
            fixBranch,
          };
        }
      } else {
        const resolution = await deps.resolveViaLadder(pr);
        outcome = resolution.resolved
          ? { kind: "resolved" }
          : resolution.disrupted
          ? {
            kind: "disrupted",
            route: "ladder",
            detail: resolution.detail,
          }
          : { kind: "failed", route: "ladder", detail: resolution.detail };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedBody = [
        `❌ **Conflict takeover threw** — the takeover raised an error: ${message}`,
        "",
        conflictFailedMarker(attemptNumber, "takeover", headSha),
      ].join("\n");
      try {
        await postComment(pr, failedBody, gh);
      } catch (postError) {
        const postMessage = postError instanceof Error
          ? postError.message
          : String(postError);
        throw new Error(
          `runConflictTakeover(${pr.repo}#${pr.number}): the takeover threw ` +
            `(${message}) and its failed conclusion could not be posted ` +
            `(${postMessage})`,
          { cause: error },
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    if (outcome.kind === "resolved" || outcome.kind === "fix-pr-raised") {
      const detail = outcome.kind === "resolved"
        ? "the base merged into the head cleanly and the head was pushed"
        : `delivered into the gated head through fix PR ${outcome.fixPr.url}`;
      await postComment(pr, buildResolvedComment(headSha, detail), gh);
    } else if (outcome.kind === "disrupted") {
      await withdrawTakeoverAttempt(
        pr,
        attemptCommentId,
        outcome.detail,
        gh,
        logger,
      );
    } else if (outcome.kind === "failed") {
      await postComment(
        pr,
        buildFailedComment(attemptNumber, headSha, outcome.detail),
        gh,
      );
    }

    logger.info(
      `Conflict takeover for PR #${pr.number} concluded: ${outcome.kind}`,
      { ...context, outcome: outcome.kind },
    );

    if (outcome.kind === "resolved" && appliedLabel) {
      try {
        await clearMergeConflictLabel(pr.repo, pr.number, gh);
      } catch (error) {
        logger.warn(
          `Conflict takeover: could not clear the 'merge-conflict' label it ` +
            `applied on PR #${pr.number} — the next scan is the backstop`,
          {
            ...context,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    return outcome;
  } finally {
    held.renewal?.stop();
    await held.release();
  }
}

/** Identity of the attempt list, so a marker that lands mid-wait is visible. */
function attemptStamp(
  attempts: readonly {
    outcome: string;
    atMs?: number;
    headSha?: string;
    pass?: string;
  }[],
): string {
  return attempts
    .map((attempt) =>
      `${attempt.outcome}:${attempt.atMs ?? ""}:${attempt.headSha ?? ""}:${
        attempt.pass ?? ""
      }`
    )
    .join("|");
}

/** Take the ladder's cross-host lock, or report that another host holds it. */
async function holdTakeoverLock(
  pr: ConflictTakeoverPr,
  deps: ConflictTakeoverDeps,
): Promise<
  | {
    kind: "free";
    release: () => Promise<void>;
    renewal?: BranchLockRenewalHandle;
  }
  | { kind: "held-by-other"; holder: string; lockAgeSeconds?: number }
> {
  if (deps.workerId === undefined) {
    return { kind: "free", release: () => Promise.resolve() };
  }

  const acquire = deps.acquireLockFn ?? acquireBranchUpdateLock;
  const lock = await acquire({
    repo: pr.repo,
    prNumber: pr.number,
    workerId: deps.workerId,
    ghCommandFn: deps.gh,
    note:
      `🔀 Resolving this PR's merge conflict (worker \`${deps.workerId}\`).`,
  });
  if (
    !lock.ok || !lock.value.acquired ||
    lock.value.lockCommentId === undefined
  ) {
    const holder = lock.ok ? lock.value.winnerId ?? "unknown" : "unknown";
    const lockedAt = lock.ok ? lock.value.winnerLockedAt : undefined;
    const nowSeconds = Math.floor((deps.nowMs ?? Date.now()) / 1000);
    return {
      kind: "held-by-other",
      holder,
      ...(lockedAt !== undefined
        ? { lockAgeSeconds: Math.max(0, nowSeconds - lockedAt) }
        : {}),
    };
  }

  const lockCommentId = lock.value.lockCommentId;
  const releaseFn = deps.releaseLockFn ?? releaseBranchUpdateLock;
  const startRenewal = deps.startLockRenewalFn ?? startBranchUpdateLockRenewal;
  const renewal = startRenewal({
    repo: pr.repo,
    lockCommentId,
    workerId: deps.workerId,
    ghCommandFn: deps.gh,
    note:
      `🔀 Resolving this PR's merge conflict (worker \`${deps.workerId}\`).`,
    onError: (message: string) =>
      deps.logger.error(`conflict_takeover_lock=renew-failed ${message}`, {
        repo: pr.repo,
        prNumber: pr.number,
      }),
  });

  return {
    kind: "free",
    renewal,
    release: () =>
      releaseFn({
        repo: pr.repo,
        prNumber: pr.number,
        lockCommentId,
        ghCommandFn: deps.gh,
      }).then(() => undefined),
  };
}
