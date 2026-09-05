/**
 * Abandon-and-restart — the last automatic rung of the merge-conflict
 * escalation ladder (Issue #1115, parent #1076).
 *
 * Two intent-aware merge attempts have concluded and failed. Before #1115 the
 * ladder ended there, at `needs-human`. A branch that has diverged far enough
 * to defeat two real merges is usually cheaper to **redo** than to reconcile,
 * and redoing it needs no human: the conflicting PR is closed with an
 * explanatory comment and its originating issue is re-queued, so the pipeline
 * raises a fresh PR off the current base.
 *
 * **"Start again" never means force-push.** The abandoned PR is *closed*, not
 * merged, and its branch is left alone — a regenerated branch force-pushed
 * over the same PR would destroy its commits and its review history, which is
 * the same class of harm as the side-picking the conflict contract forbids
 * (#1076). Closing and re-raising keeps the abandoned work readable and
 * linked; branch cleanup owns the branch's lifecycle from here
 * (`branch_cleanup.ts`).
 *
 * **Preconditions are checked before anything is destroyed.** The order below
 * is the safety property, not an implementation detail:
 *
 * 1. the PR's originating issue is known — **no issue, no abandon**, because
 *    closing a PR the fleet cannot re-raise loses the work outright;
 * 2. the issue has not already been restarted once — **one abandon per
 *    originating issue**, so a restarted issue whose fresh PR also exhausts
 *    its budget goes to `needs-human` rather than round the loop again;
 * 3. the issue has no *other* PR of its own; and
 * 4. the issue can actually be re-queued — it already carries the work label,
 *    or the worker is permitted to apply it (`worker_label_guard.ts` refuses
 *    `work-on` on an existing issue, and a discovery collector strips a
 *    worker-applied one). Closing a PR whose issue would then sit unqueued is
 *    the same harm as closing one with no issue at all, so it is refused here
 *    rather than discovered after the close.
 *
 * The restart marker is recorded **on the issue**, not on the PR: the PR being
 * counted is closed moments later and a new one takes its place, so a PR-keyed
 * marker would pass a single-cycle test and loop in production. It is posted
 * *before* the close for the same reason the attempt marker is posted before
 * the merge — it is the claim two hosts race for, and the loser must lose
 * before anything is closed.
 *
 * Every step that fails returns the step's name. The caller's resting state is
 * then `needs-human` naming that step: a partial abandon — worst of all "PR
 * closed, issue not re-queued" — must never be where this stops.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { GitRunner } from "./git_base_ref.ts";
import {
  type ConflictIssueContext,
  gatherConflictIssueContext,
  type OriginatingIssue,
  type PrUnresolvedReason,
} from "./conflict_issue_context.ts";
import { CONFLICT_FAILED_MARKER } from "./pr_merge_conflict_scan.ts";
import { DEFAULT_WORK_LABEL } from "./escalate_as_work.ts";
import { findExistingPrForIssue } from "./pr_issue_linking.ts";
import { addLabelToIssue } from "./label_operations.ts";
import { isWorkerAppliableLabel } from "./worker_label_guard.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

/**
 * Marker recorded on the **originating issue** when it is restarted.
 *
 * Canonical `vibe-*` grammar — a bare `vibe-` prefix and `key="value"`
 * attributes (Issue #842). The older `vibe-coder:merge-conflict-*` markers
 * beside it are frozen only because they are already in live comment threads;
 * a new marker has no such data to stay compatible with.
 *
 * Its presence is what bounds the rung to one abandon per issue, and what
 * makes two hosts scanning the same exhausted PR produce one abandon.
 */
export const CONFLICT_RESTART_MARKER = "<!-- vibe-merge-conflict-restart";

/** The marker comment line for one abandoned PR. */
export function conflictRestartMarker(repo: string, prNumber: number): string {
  return `${CONFLICT_RESTART_MARKER} pr="${repo}#${prNumber}" -->`;
}

/** True when a comment thread already records a restart (any PR). */
export function hasConflictRestartMarker(
  comments: readonly unknown[],
): boolean {
  return comments.some((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const body = (raw as { body?: unknown }).body;
    return typeof body === "string" && body.includes(CONFLICT_RESTART_MARKER);
  });
}

// ---------------------------------------------------------------------------
// Attempt history, read back off the PR
// ---------------------------------------------------------------------------

/** Characters of one recorded failure kept for the abandon comment. */
const MAX_ATTEMPT_DETAIL_CHARS = 500;

/** Conflicted paths listed in the abandon comment. */
const MAX_CONFLICTED_PATHS = 20;

/** `- \`path\`` as {@link CONFLICT_FAILED_MARKER} comments list them. */
const CONFLICTED_PATH_LINE = /^-\s+`([^`]+)`\s*$/;

/** One concluded, failed attempt as its comment recorded it. */
export interface FailedAttemptSummary {
  /** Attempt number the marker carried, or `null` when it carried none. */
  attempt: number | null;
  /** The recorded reason, bounded for comment use. */
  detail: string;
}

/** What the failed attempts on a PR recorded. */
export interface FailedAttemptHistory {
  attempts: FailedAttemptSummary[];
  /** Conflicted paths named across those attempts, newest first, deduped. */
  conflictedPaths: string[];
}

/** The attempt number a failure marker names, or `null`. */
function attemptNumberFrom(body: string): number | null {
  const match = /merge-conflict-failed\s+n="(\d+)"/.exec(body);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Read the concluded failures out of a PR's comment thread.
 *
 * The reasons are the failure comments' own words rather than a re-derivation:
 * the abandon comment must say what the fleet actually recorded, and only the
 * comments know that once the run that wrote them is gone.
 */
export function summariseFailedAttempts(
  comments: readonly unknown[],
): FailedAttemptHistory {
  const attempts: FailedAttemptSummary[] = [];
  const conflictedPaths: string[] = [];

  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const body = (raw as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    if (!body.includes(CONFLICT_FAILED_MARKER)) continue;

    const lines = body.split("\n");
    for (const line of lines) {
      const match = CONFLICTED_PATH_LINE.exec(line.trim());
      const path = match?.[1]?.trim();
      if (
        path !== undefined && path.length > 0 &&
        !conflictedPaths.includes(path)
      ) {
        conflictedPaths.push(path);
      }
    }

    const detail = lines
      .filter((line) => !line.trim().startsWith("<!--"))
      .join("\n")
      .trim()
      .slice(0, MAX_ATTEMPT_DETAIL_CHARS);
    attempts.push({ attempt: attemptNumberFrom(body), detail });
  }

  return {
    attempts,
    conflictedPaths: conflictedPaths.slice(0, MAX_CONFLICTED_PATHS),
  };
}

// ---------------------------------------------------------------------------
// Outcome taxonomy
// ---------------------------------------------------------------------------

/** Why the abandon was declined before anything was changed. */
export type AbandonDeclineReason =
  /** No originating issue: the fleet could not re-raise what it closed. */
  | { kind: "no-originating-issue"; detail: PrUnresolvedReason }
  /** The issue has already been restarted once — the bound (#1115). */
  | { kind: "already-restarted"; issueNumber: number }
  /** The issue already has another PR of its own. */
  | { kind: "other-open-pr"; issueNumber: number; prUrl: string }
  /** The issue could not be put back in a queue the fleet reads. */
  | {
    kind: "requeue-not-permitted";
    issueNumber: number;
    workLabel: string;
  };

/** The steps an abandon runs, in order. Named in the failure outcome. */
export type AbandonStep =
  | "originating-issue"
  | "issue-state"
  | "restart-marker"
  | "existing-pr"
  | "issue-comment"
  | "pr-comment"
  | "pr-close"
  | "issue-reopen"
  | "issue-label";

/** What {@link abandonAndRestart} did. */
export type AbandonRestartOutcome =
  /** The PR was closed and its issue re-queued. */
  | { outcome: "abandoned"; issueNumber: number }
  /** A precondition refused the abandon; nothing was changed. */
  | { outcome: "declined"; reason: AbandonDeclineReason }
  /** A step failed; the caller must escalate naming {@link step}. */
  | {
    outcome: "failed";
    step: AbandonStep;
    message: string;
    issueNumber?: number;
  };

// ---------------------------------------------------------------------------
// Request and seams
// ---------------------------------------------------------------------------

/** The exhausted PR to abandon. */
export interface AbandonRestartRequest {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The conflicting PR's number. */
  prNumber: number;
  /** The PR's head branch — named in both comments so the work stays findable. */
  branchName: string;
  /** The base branch the PR conflicts with. */
  baseBranch: string;
  /** The PR's comment thread, oldest first — the scan already has it. */
  prComments: readonly unknown[];
}

/** Injected seams so the whole path is testable without GitHub. */
export interface AbandonRestartDeps {
  /** Runs `gh`, returning stdout; throws on failure. */
  gh: (args: string[]) => Promise<string>;
  logger?: Logger;
  /** Label that puts the restarted issue back in the queue. */
  workLabel?: string;
  /** Originating-issue resolution — defaults to #1113's gatherer. */
  resolveContext?: (
    request: AbandonRestartRequest,
  ) => Promise<ConflictIssueContext>;
  /** Existing-PR lookup — defaults to {@link findExistingPrForIssue}. */
  findExistingPr?: (
    repo: string,
    issueNumber: number,
  ) => Promise<Result<string>>;
  /** Label application — defaults to {@link addLabelToIssue}. */
  addLabel?: (
    repo: string,
    issueNumber: number,
    label: string,
  ) => Promise<Result<void>>;
}

/**
 * The git runner the scan does not have.
 *
 * The abandon decision needs only the PR side of #1113's context, which is
 * resolved from the branch name, the PR body and GitHub's linkage — no clone.
 * Offering no conflicted path means the base-side walk never runs; if it ever
 * did, this fails loud rather than reporting an empty base side as a fact.
 */
const NO_CLONE_GIT: GitRunner = () =>
  Promise.resolve({
    ok: false,
    error: new Error(
      "no clone is available here — the base-side walk must not run from " +
        "the merge-conflict scan",
    ),
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The PR number a GitHub PR URL names, or `null`. */
export function prNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

// ---------------------------------------------------------------------------
// Comment bodies
// ---------------------------------------------------------------------------

/** The issues the two attempts consulted, PR side first (Issue #1113/#1114). */
function consultedIssues(context: ConflictIssueContext): OriginatingIssue[] {
  const issues: OriginatingIssue[] = [];
  if (context.prSide.resolved) issues.push(context.prSide.issue);
  for (const path of context.baseSide) {
    for (const issue of path.issues) {
      if (!issues.some((known) => known.number === issue.number)) {
        issues.push(issue);
      }
    }
  }
  return issues;
}

/**
 * The comment posted on the PR before it is closed.
 *
 * It has to stand on its own months later: what was tried, what it tripped on,
 * what was consulted, what happens next, and the branch name, so the abandoned
 * work stays findable after the PR leaves the open queue.
 */
export function buildAbandonPrComment(args: {
  request: AbandonRestartRequest;
  history: FailedAttemptHistory;
  context: ConflictIssueContext;
  issueNumber: number;
  workLabel: string;
}): string {
  const { request, history, context, issueNumber, workLabel } = args;
  const attempts = history.attempts.length > 0
    ? history.attempts.flatMap((attempt, index) => [
      "",
      `**Attempt ${attempt.attempt ?? index + 1}**`,
      "",
      ...attempt.detail.split("\n").map((line) => `> ${line}`),
    ])
    : ["", "_(no failure comment survives in this thread)_"];

  const paths = history.conflictedPaths.length > 0
    ? history.conflictedPaths.map((path) => `- \`${path}\``)
    : ["- (no conflicted path was recorded)"];

  const issues = consultedIssues(context);
  const consulted = issues.length > 0
    ? issues.map((issue) => `- #${issue.number} — ${issue.title}`)
    : ["- (none — no originating issue was resolvable for either side)"];

  return [
    conflictRestartMarker(request.repo, request.prNumber),
    "♻️ **Abandoning this PR and restarting the work**",
    "",
    `Two merge-conflict resolution attempts on \`${request.branchName}\` ` +
    `concluded and failed, so \`${request.baseBranch}\` has moved too far ` +
    "from this branch to reconcile. Redoing the work off the current base " +
    "is cheaper than reconciling it, and needs no human.",
    "",
    "**What the attempts recorded**",
    ...attempts,
    "",
    "**Conflicted paths**",
    "",
    ...paths,
    "",
    "**Issues consulted**",
    "",
    ...consulted,
    "",
    "**What happens now**",
    "",
    `This PR is being **closed** — not merged — and issue #${issueNumber} is ` +
    `being re-queued (\`${workLabel}\`) so the fleet raises a fresh PR off ` +
    `\`${request.baseBranch}\`.`,
    "",
    `The branch \`${request.branchName}\` is **not** deleted and has **not** ` +
    "been force-pushed: every commit on it stays exactly as its author " +
    "pushed it, so the abandoned work remains readable and linked from here.",
  ].join("\n");
}

/**
 * The comment posted on the originating issue — and the restart marker.
 *
 * Present tense on purpose: it is posted before the close, as the claim that
 * stops a second host abandoning the same PR, so it must not assert a
 * completed state it has not reached yet.
 */
export function buildRestartIssueComment(args: {
  request: AbandonRestartRequest;
  history: FailedAttemptHistory;
  workLabel: string;
}): string {
  const { request, history, workLabel } = args;
  const paths = history.conflictedPaths.length > 0
    ? history.conflictedPaths.map((path) => `- \`${path}\``)
    : ["- (no conflicted path was recorded)"];

  return [
    conflictRestartMarker(request.repo, request.prNumber),
    "♻️ **Re-queued: the PR for this issue conflicted irreconcilably**",
    "",
    `${request.repo}#${request.prNumber} put this issue's work on ` +
    `\`${request.branchName}\`, and that branch conflicts with ` +
    `\`${request.baseBranch}\` in a way two concluded merge attempts could ` +
    "not resolve.",
    "",
    "Conflicted paths:",
    "",
    ...paths,
    "",
    `That PR is being closed and this issue re-queued (\`${workLabel}\`), so ` +
    "the work is redone off the current base rather than reconciled against " +
    "it. The abandoned branch is kept, not deleted, and was never " +
    "force-pushed — read it at " +
    `${request.repo}#${request.prNumber} if the earlier work is useful.`,
    "",
    "This is the fleet's **one** restart for this issue: if the fresh PR " +
    "also spends its merge-conflict budget, the conflict goes to a human " +
    "instead of round the loop again.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The rung
// ---------------------------------------------------------------------------

/** The issue state and labels one `gh issue view` answers for. */
interface IssueSnapshot {
  state: string;
  labels: string[];
}

async function fetchIssueSnapshot(
  repo: string,
  issueNumber: number,
  gh: (args: string[]) => Promise<string>,
): Promise<IssueSnapshot> {
  const raw = await gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "state,labels",
  ]);
  const parsed = JSON.parse(raw.trim() || "{}") as {
    state?: unknown;
    labels?: Array<{ name?: unknown }>;
  };
  const labels: string[] = [];
  for (const label of parsed.labels ?? []) {
    if (typeof label?.name === "string") labels.push(label.name);
  }
  return { state: String(parsed.state ?? ""), labels };
}

/**
 * Close the conflicting PR and re-queue its originating issue.
 *
 * Never throws: every failure is returned as `{ outcome: "failed", step }` so
 * the caller can escalate naming the step that stopped it.
 */
export async function abandonAndRestart(
  request: AbandonRestartRequest,
  deps: AbandonRestartDeps,
): Promise<AbandonRestartOutcome> {
  const { repo, prNumber } = request;
  const gh = deps.gh;
  const workLabel = deps.workLabel ?? DEFAULT_WORK_LABEL;
  const logger = deps.logger;

  const failed = (
    step: AbandonStep,
    error: unknown,
    issueNumber?: number,
  ): AbandonRestartOutcome => {
    const message = errorMessage(error);
    logger?.error?.("Abandon-and-restart failed", {
      repo,
      prNumber,
      step,
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      error: message,
    });
    return {
      outcome: "failed",
      step,
      message,
      ...(issueNumber !== undefined ? { issueNumber } : {}),
    };
  };

  // --- Precondition 1: the originating issue. No issue, no abandon. --------
  let context: ConflictIssueContext;
  try {
    context = deps.resolveContext
      ? await deps.resolveContext(request)
      : await gatherConflictIssueContext({
        repo,
        prNumber,
        prBranch: request.branchName,
        baseBranch: request.baseBranch,
        conflictedPaths: [],
      }, { gh, git: NO_CLONE_GIT });
  } catch (error) {
    return failed("originating-issue", error);
  }
  if (!context.prSide.resolved) {
    return {
      outcome: "declined",
      reason: {
        kind: "no-originating-issue",
        detail: context.prSide.reason,
      },
    };
  }
  const issueNumber = context.prSide.issue.number;

  // --- Precondition 2: one restart per originating issue. -----------------
  let issueComments: unknown[];
  try {
    issueComments = await fetchIssueCommentPages(repo, issueNumber, gh);
  } catch (error) {
    return failed("restart-marker", error, issueNumber);
  }
  if (hasConflictRestartMarker(issueComments)) {
    return {
      outcome: "declined",
      reason: { kind: "already-restarted", issueNumber },
    };
  }

  // --- Precondition 3: the issue has no other PR of its own. --------------
  const findExistingPr = deps.findExistingPr ??
    ((prRepo: string, number: number) =>
      findExistingPrForIssue(prRepo, number, gh));
  const existing = await findExistingPr(repo, issueNumber);
  if (existing.ok) {
    const found = prNumberFromUrl(existing.value);
    if (found !== prNumber) {
      return {
        outcome: "declined",
        reason: {
          kind: "other-open-pr",
          issueNumber,
          prUrl: existing.value,
        },
      };
    }
  }

  // --- Precondition 4: the issue can actually be re-queued. ---------------
  let snapshot: IssueSnapshot;
  try {
    snapshot = await fetchIssueSnapshot(repo, issueNumber, gh);
  } catch (error) {
    return failed("issue-state", error, issueNumber);
  }
  const alreadyLabelled = snapshot.labels.includes(workLabel);
  if (!alreadyLabelled && !isWorkerAppliableLabel(workLabel)) {
    // Closing the PR now would leave the issue open, unqueued and invisible
    // to both the fleet and the human — strictly worse than the stall.
    return {
      outcome: "declined",
      reason: { kind: "requeue-not-permitted", issueNumber, workLabel },
    };
  }

  const history = summariseFailedAttempts(request.prComments);

  // --- Step 1: claim the restart on the issue, marker first. --------------
  try {
    await gh([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      buildRestartIssueComment({ request, history, workLabel }),
    ]);
  } catch (error) {
    return failed("issue-comment", error, issueNumber);
  }

  // --- Step 2: say on the PR why it is being closed. ----------------------
  try {
    await gh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      buildAbandonPrComment({
        request,
        history,
        context,
        issueNumber,
        workLabel,
      }),
    ]);
  } catch (error) {
    return failed("pr-comment", error, issueNumber);
  }

  // --- Step 3: close it. Closed, not merged; the branch stays. ------------
  try {
    // No `--delete-branch`: branch cleanup owns that lifecycle, and the
    // abandoned commits must stay readable (#1076).
    await gh(["pr", "close", String(prNumber), "--repo", repo]);
  } catch (error) {
    return failed("pr-close", error, issueNumber);
  }

  // --- Step 4: re-queue the issue — reopen it if it is closed. ------------
  if (snapshot.state.toUpperCase() === "CLOSED") {
    try {
      await gh(["issue", "reopen", String(issueNumber), "--repo", repo]);
    } catch (error) {
      return failed("issue-reopen", error, issueNumber);
    }
  }

  // --- Step 5: …and make sure it carries the work label. ------------------
  if (!alreadyLabelled) {
    const labelled = deps.addLabel
      ? await deps.addLabel(repo, issueNumber, workLabel)
      : await addLabelToIssue(repo, issueNumber, workLabel, {
        ghCommandFn: gh,
      });
    if (!labelled.ok) return failed("issue-label", labelled.error, issueNumber);
  }

  logger?.warn?.(
    `PR #${prNumber} was abandoned and issue #${issueNumber} re-queued — ` +
      "two concluded merge attempts could not reconcile the branch",
    { repo, prNumber, issueNumber, workLabel },
  );
  return { outcome: "abandoned", issueNumber };
}
