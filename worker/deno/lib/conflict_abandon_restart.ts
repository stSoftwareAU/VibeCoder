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
import { CONFLICT_FAILED_MARKER } from "./merge_conflict_markers.ts";
import { DEFAULT_WORK_LABEL } from "./escalate_as_work.ts";
import { prTitleMatchesIssue } from "./pr_title_issue_ref.ts";
import { sanitiseIssueText } from "./conflict_intent_context.ts";
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
  return restartMarkerPrNumbers(comments).length > 0;
}

/**
 * The PRs a thread's restart markers name, in the order they appear.
 *
 * A marker naming *this* PR means an earlier abandon of it claimed the
 * restart and then did not finish — a different fact from "the work was
 * restarted and its replacement failed too", and the human-facing text has to
 * tell them apart. An unparseable marker still counts as a restart: it is a
 * claim, and the bound must fail towards not abandoning twice.
 */
export function restartMarkerPrNumbers(
  comments: readonly unknown[],
): Array<number | null> {
  const found: Array<number | null> = [];
  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const body = (raw as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    const index = body.indexOf(CONFLICT_RESTART_MARKER);
    if (index < 0) continue;
    const match = /pr="[^"#]*#(\d+)"/.exec(body.slice(index));
    const number = match ? Number(match[1]) : NaN;
    found.push(Number.isSafeInteger(number) && number > 0 ? number : null);
  }
  return found;
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
  /**
   * The issue has already been restarted once — the bound (#1115).
   * `samePr` is true when the recorded claim names *this* PR, i.e. an earlier
   * abandon of it started and did not finish.
   */
  | { kind: "already-restarted"; issueNumber: number; samePr: boolean }
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
// Which route ended at a human
// ---------------------------------------------------------------------------

/**
 * Which route through the ladder ended at a human (Issue #1115).
 *
 * A spent budget no longer means one thing. Abandon-and-restart sits between
 * it and `needs-human`, so the escalation must say which of its exits produced
 * the hand-over — a human who cannot tell "the fleet could not find the issue"
 * from "the fleet already restarted this once" cannot act on either.
 */
export type ExhaustedEscalationRoute =
  /** A precondition refused the abandon; nothing was closed. */
  | { kind: "abandon-declined"; detail: string }
  /** The abandon started and a step failed; the state may be partial. */
  | { kind: "abandon-failed"; step: AbandonStep; detail: string }
  /** This issue was already restarted once; the fresh PR exhausted too. */
  | { kind: "restart-exhausted"; issueNumber: number; samePr: boolean };

/**
 * Which escalation route an abandon that did not happen produced.
 *
 * Exhaustive over both non-abandoning outcomes, so a decline reason added
 * without a route here fails the type check rather than reaching a human as an
 * unexplained `needs-human`.
 */
export function exhaustedEscalationRoute(
  outcome: Exclude<AbandonRestartOutcome, { outcome: "abandoned" }>,
): ExhaustedEscalationRoute {
  if (outcome.outcome === "failed") {
    return {
      kind: "abandon-failed",
      step: outcome.step,
      detail: sanitiseIssueText(outcome.message),
    };
  }

  const reason = outcome.reason;
  switch (reason.kind) {
    case "no-originating-issue":
      return {
        kind: "abandon-declined",
        detail: "This PR names no originating issue " +
          `(${reason.detail}): neither its branch name, nor a closing ` +
          "keyword in its body, nor GitHub's own linkage points at one. " +
          "Closing a PR the fleet cannot re-raise would lose the work " +
          "outright, so it was left open.",
      };
    case "already-restarted":
      return {
        kind: "restart-exhausted",
        issueNumber: reason.issueNumber,
        samePr: reason.samePr,
      };
    case "other-open-pr":
      return {
        kind: "abandon-declined",
        detail: `Issue #${reason.issueNumber} already has another open PR ` +
          `(${sanitiseIssueText(reason.prUrl)}), so re-queuing it would have ` +
          "raced that one.",
      };
    case "requeue-not-permitted":
      return {
        kind: "abandon-declined",
        detail: `Issue #${reason.issueNumber} does not carry ` +
          `\`${reason.workLabel}\`, and the worker is not permitted to apply ` +
          "it (`worker_label_guard.ts`). Closing this PR would have left the " +
          "issue open but unqueued — invisible to the fleet and to you.",
      };
  }
  const unhandled: never = reason;
  throw new Error(
    `Unhandled abandon decline reason: ${JSON.stringify(unhandled)}`,
  );
}

/** The route, as the paragraphs a `needs-human` comment carries. */
export function describeExhaustedRoute(
  route: ExhaustedEscalationRoute,
): string[] {
  switch (route.kind) {
    case "abandon-declined":
      return [
        "**The automatic restart was declined, so nothing was closed.** " +
        route.detail,
      ];
    case "abandon-failed":
      return [
        "**The automatic restart failed part-way through, at the " +
        `\`${route.step}\` step.** ${route.detail}`,
        "",
        "Check what that step leaves behind before doing anything else: this " +
        "PR may already carry the abandon comment, and its issue may already " +
        "be re-queued.",
      ];
    case "restart-exhausted":
      return route.samePr
        ? [
          `**An earlier abandon of this PR claimed issue #${route.issueNumber} ` +
          "and did not finish.** The restart claim is on the issue, so the " +
          "fleet will not try again — it restarts once and then stops rather " +
          "than closing and re-raising PRs in a loop. This PR was left open.",
        ]
        : [
          `**This work has already been restarted once** — issue ` +
          `#${route.issueNumber} was re-queued after an earlier PR ` +
          "conflicted irreconcilably, and the PR that replaced it has now " +
          "spent its budget too. The fleet restarts once and then stops.",
        ];
  }
  const unhandled: never = route;
  throw new Error(
    `Unhandled exhausted escalation route: ${JSON.stringify(unhandled)}`,
  );
}

/**
 * The `escalateToHuman` dedup key for a route.
 *
 * A failed abandon gets its own key: the shared `merge-conflict-<pr>` key is
 * also the processor's, and a landed escalation suppresses further comments
 * for a day — which would swallow the one comment naming the step that broke.
 */
export function exhaustedEscalationDedupKey(
  prNumber: number,
  route: ExhaustedEscalationRoute,
): string {
  return route.kind === "abandon-failed"
    ? `merge-conflict-abandon-failed-${prNumber}`
    : `merge-conflict-${prNumber}`;
}

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
  /**
   * Other-PR lookup — defaults to {@link findOtherPrsForIssue}. Throws on a
   * lookup failure; the caller turns that into an `existing-pr` step failure
   * rather than reading it as "this issue has no other PR".
   */
  findOtherPrs?: (
    repo: string,
    issueNumber: number,
    excludePrNumber: number,
  ) => Promise<IssuePrRef[]>;
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

/** An open PR that belongs to an issue. */
export interface IssuePrRef {
  number: number;
  url: string;
}

/** Open PRs listed per lookup — the same bound `findExistingPrForIssue` uses. */
const OPEN_PR_LOOKUP_LIMIT = 50;

/**
 * Whether a PR body carries the legacy `vibe-worker-issue-<n>` marker for
 * this issue — and not for #16 when the issue is #1.
 *
 * Scanned as a string rather than built into a `RegExp`: an interpolated
 * pattern is a ReDoS surface the SAST gate rejects outright, and this needs no
 * pattern at all.
 */
function bodyNamesIssue(body: string, issueNumber: number): boolean {
  const marker = `vibe-worker-issue-${issueNumber}`;
  for (
    let at = body.indexOf(marker);
    at >= 0;
    at = body.indexOf(marker, at + 1)
  ) {
    const next = body.charAt(at + marker.length);
    if (next === "" || next < "0" || next > "9") return true;
  }
  return false;
}

/**
 * Every **open** PR for an issue except one, newest first.
 *
 * Deliberately not {@link findExistingPrForIssue}, whose shape is wrong for a
 * precondition on a destructive step in three ways: it swallows every `gh`
 * failure into the same "no PR found" it returns for a genuine absence, it
 * returns only the first match, and it also matches merged and
 * recently-closed PRs. Here an API failure must **throw** — reading an outage
 * as "no other PR" would let the close proceed — and *every* match must be
 * seen, since the one PR that matters may not be the newest.
 *
 * The matcher is the fleet's own {@link prTitleMatchesIssue} plus the legacy
 * body marker, so this and the fleet's PR dedup agree on what "the issue's PR"
 * means. A fork-headed PR proves nothing (Issue #1124): its title is text
 * anybody may write, so it is ignored rather than allowed to block a restart.
 *
 * @throws when the listing cannot be read or parsed.
 */
export async function findOtherPrsForIssue(
  repo: string,
  issueNumber: number,
  excludePrNumber: number,
  gh: (args: string[]) => Promise<string>,
): Promise<IssuePrRef[]> {
  const raw = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    "number,title,body,url,isCrossRepository",
    "--limit",
    String(OPEN_PR_LOOKUP_LIMIT),
  ]);
  const parsed: unknown = JSON.parse(raw.trim() || "[]");
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a PR array for ${repo} issue #${issueNumber}, got ` +
        `${parsed === null ? "null" : typeof parsed}`,
    );
  }

  const others: IssuePrRef[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const pr = entry as {
      number?: unknown;
      title?: unknown;
      body?: unknown;
      url?: unknown;
      isCrossRepository?: unknown;
    };
    const number = typeof pr.number === "number" ? pr.number : NaN;
    if (!Number.isSafeInteger(number) || number === excludePrNumber) continue;
    if (pr.isCrossRepository === true) continue;
    const title = typeof pr.title === "string" ? pr.title : "";
    const body = typeof pr.body === "string" ? pr.body : "";
    if (
      !prTitleMatchesIssue(title, issueNumber) &&
      !bodyNamesIssue(body, issueNumber)
    ) {
      continue;
    }
    others.push({
      number,
      url: typeof pr.url === "string" && pr.url.length > 0
        ? pr.url
        : `https://github.com/${repo}/pull/${number}`,
    });
  }
  return others;
}

// ---------------------------------------------------------------------------
// Comment bodies
// ---------------------------------------------------------------------------

/** The conflicted paths, rendered for a comment — or the stated absence. */
function conflictedPathLines(history: FailedAttemptHistory): string[] {
  return history.conflictedPaths.length > 0
    ? history.conflictedPaths.map((path) => `- \`${sanitiseIssueText(path)}\``)
    : ["- (no conflicted path was recorded)"];
}

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
  // Every quoted string below came off GitHub — a failure comment the agent
  // wrote, a path, an issue title — and this comment is a public outbound
  // sink, so each goes through the same sanitiser the intent audit uses:
  // secrets redacted, delimiters defused, HTML comments neutralised so a
  // quoted body cannot forge a marker (Issue #1114).
  const attempts = history.attempts.length > 0
    ? history.attempts.flatMap((attempt, index) => [
      "",
      `**Attempt ${attempt.attempt ?? index + 1}**`,
      "",
      ...sanitiseIssueText(attempt.detail).split("\n").map((line) =>
        `> ${line}`
      ),
    ])
    : ["", "_(no failure comment survives in this thread)_"];

  const paths = conflictedPathLines(history);

  const issues = consultedIssues(context);
  const consulted = issues.length > 0
    ? issues.map((issue) =>
      `- #${issue.number} — ${sanitiseIssueText(issue.title)}`
    )
    : ["- (none — no originating issue was resolvable for either side)"];

  const branch = sanitiseIssueText(request.branchName);
  return [
    conflictRestartMarker(request.repo, request.prNumber),
    "♻️ **Abandoning this PR and restarting the work**",
    "",
    `Two merge-conflict resolution attempts on \`${branch}\` ` +
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
    "_Base-side issues are listed only when the caller had a clone to walk " +
    "(Issue #1113); the scan does not, so from there this is the PR side " +
    "alone._",
    "",
    "**What happens now**",
    "",
    `This PR is being **closed** — not merged — and issue #${issueNumber} is ` +
    `being re-queued (\`${workLabel}\`) so the fleet raises a fresh PR off ` +
    `\`${request.baseBranch}\`.`,
    "",
    `The branch \`${branch}\` is **not** deleted and has **not** ` +
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
  const paths = conflictedPathLines(history);

  return [
    conflictRestartMarker(request.repo, request.prNumber),
    "♻️ **Re-queued: the PR for this issue conflicted irreconcilably**",
    "",
    `${request.repo}#${request.prNumber} put this issue's work on ` +
    `\`${sanitiseIssueText(request.branchName)}\`, and that branch ` +
    "conflicts with " +
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
  const claimed = restartMarkerPrNumbers(issueComments);
  if (claimed.length > 0) {
    return {
      outcome: "declined",
      reason: {
        kind: "already-restarted",
        issueNumber,
        // A claim naming this PR means an earlier abandon of it did not
        // finish — a different story to tell than "the replacement failed
        // too", and the escalation says so.
        samePr: claimed.includes(prNumber),
      },
    };
  }

  // --- Precondition 3: the issue has no other open PR of its own. ---------
  let others: IssuePrRef[];
  try {
    const findOtherPrs = deps.findOtherPrs ??
      ((prRepo: string, number: number, exclude: number) =>
        findOtherPrsForIssue(prRepo, number, exclude, gh));
    others = await findOtherPrs(repo, issueNumber, prNumber);
  } catch (error) {
    // A lookup that failed is not an absence: reading an outage as "no other
    // PR" would let the close proceed on an issue somebody else is on.
    return failed("existing-pr", error, issueNumber);
  }
  const other = others[0];
  if (other !== undefined) {
    return {
      outcome: "declined",
      reason: { kind: "other-open-pr", issueNumber, prUrl: other.url },
    };
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
    try {
      const labelled = deps.addLabel
        ? await deps.addLabel(repo, issueNumber, workLabel)
        : await addLabelToIssue(repo, issueNumber, workLabel, {
          ghCommandFn: gh,
        });
      if (!labelled.ok) {
        return failed("issue-label", labelled.error, issueNumber);
      }
    } catch (error) {
      return failed("issue-label", error, issueNumber);
    }
  }

  logger?.warn?.(
    `PR #${prNumber} was abandoned and issue #${issueNumber} re-queued — ` +
      "two concluded merge attempts could not reconcile the branch",
    { repo, prNumber, issueNumber, workLabel },
  );
  return { outcome: "abandoned", issueNumber };
}
