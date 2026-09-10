/**
 * Re-queue the children a milestone roll-back just reverted (Issue #1781).
 *
 * {@link executeRollback} undoes the merges. This module is the GitHub half:
 * each reverted child's issue is reopened with the roll-back marker so the
 * merged-PR closers leave it open, its open PRs and any open summary PR are
 * closed with a comment naming the revert, and exactly one notice is posted
 * on the existing escalation target. A roll-back that could not merge
 * escalates once — `needs-human` on that same target — and never files an
 * issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { RevertedChild } from "./milestone_rollback.ts";
import { extractIssueFromBranch } from "./pr_maintenance.ts";
import { extractClosingIssueNumbers } from "./pr_body.ts";
import { buildRollbackMarker } from "./milestone_rollback_marker.ts";
import { isWorkerAppliableLabel } from "./worker_label_guard.ts";
import {
  decideMilestoneEscalationTarget,
  resolveMilestoneEscalationTarget,
} from "./milestone_escalation_target.ts";
import { trackingIssueFromMilestoneTitle } from "./milestone_sync_streak.ts";

/** Labels that make an issue claimable. */
const PICKUP_LABELS = new Set([
  "work-on",
  "idle-task",
  "top-priority",
  "low-priority",
]);

export type GhCommandFn = (args: string[]) => Promise<string>;

/** What {@link requeueRolledBackChildren} did on GitHub. */
export interface RequeueResult {
  /** Issues that were closed and that we reopened. */
  reopened: number[];
  /** Open PRs we closed (child PRs, not the notice). */
  closedPrs: number[];
  /** The open milestone summary PR we closed, if any. */
  closedSummaryPr: number | null;
  /** Issues whose pickup label the worker must not apply. */
  needsTrustedRelabel: number[];
  /** The issue the one notice landed on, when it did. */
  noticeIssue: number | null;
}

/** What {@link escalateRollbackFailure} did. */
export interface RollbackFailureEscalation {
  /** True when a comment went out this call. */
  posted: boolean;
  /** The destination issue, when one existed. */
  issue: number | null;
  /**
   * True when this exhaustion is done — a comment went out, or there was
   * nowhere to post and the log line stands in for it.
   */
  countedAsEscalated: boolean;
}

/** One reverted child as the notice names it. */
export interface NoticeReverted {
  prNumber: number;
  issueNumber: number;
  revertSha: string;
}

export interface RollbackNoticeInput {
  milestoneBranch: string;
  defaultBranch: string;
  rollbacks: number;
  attempts: number;
  reverted: readonly NoticeReverted[];
  reopened: readonly number[];
  needsTrustedRelabel: readonly number[];
}

export interface RollbackFailedCommentInput {
  milestoneBranch: string;
  defaultBranch: string;
  reason: string;
}

export interface RequeueOptions {
  repo: string;
  milestoneTitle: string;
  milestoneNumber: number;
  milestoneBranch: string;
  defaultBranch: string;
  rollbacks: number;
  attempts: number;
  reverted: readonly RevertedChild[];
  ghCommandFn: GhCommandFn;
  log: (message: string) => void;
}

export interface EscalateRollbackFailureOptions {
  repo: string;
  milestoneTitle: string;
  milestoneNumber: number;
  milestoneBranch: string;
  defaultBranch: string;
  reason: string;
  /** When true this exhaustion has already been reported — post nothing. */
  alreadyEscalated: boolean;
  ghCommandFn: GhCommandFn;
  log: (message: string) => void;
}

/**
 * The issue a reverted PR belongs to.
 *
 * The branch shape is authoritative (`issue-<n>-…`). A body closing
 * keyword is the fallback the issue asked for when the head has no number.
 */
export function resolveIssueForRevertedPr(
  headRefName: string | undefined,
  body: string,
): number | null {
  const fromBranch = headRefName ? extractIssueFromBranch(headRefName) : null;
  if (fromBranch !== null) {
    const n = Number(fromBranch);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const fromBody = extractClosingIssueNumbers(body);
  return fromBody[0] ?? null;
}

/** The one roll-back notice. Never carries `needs-human`. */
export function buildRollbackNotice(input: RollbackNoticeInput): string {
  const revertedLines = input.reverted.length === 0
    ? "- (none)"
    : input.reverted.map((r) =>
      `- PR #${r.prNumber} (issue #${r.issueNumber}, revert \`${
        r.revertSha.slice(0, 7)
      }\`)`
    ).join("\n");
  const reopenedLines = input.reopened.length === 0
    ? "- (none)"
    : input.reopened.map((n) => `- #${n}`).join("\n");
  const checklist = input.needsTrustedRelabel.length === 0
    ? "- (none — every reopened child carries a label the worker may apply)"
    : input.needsTrustedRelabel.map((n) => `- [ ] #${n}`).join("\n");

  return `## Milestone branch rolled back (Issue #1781)\n\n` +
    `\`${input.milestoneBranch}\` was rolled back after ` +
    `${input.attempts} concluded conflict attempt(s) so ` +
    `\`${input.defaultBranch}\` merges cleanly. This is roll-back #` +
    `${input.rollbacks} on this branch.\n\n` +
    `### Reverted PRs\n\n${revertedLines}\n\n` +
    `### Reopened issues\n\n${reopenedLines}\n\n` +
    `### Issues that need a trusted re-label\n\n` +
    `The worker cannot apply \`work-on\`, \`top-priority\` or ` +
    `\`low-priority\`. Re-apply the pickup label on each of these so ` +
    `the child can be claimed again:\n\n${checklist}\n`;
}

/** The one `needs-human` comment a failed roll-back posts. */
export function buildRollbackFailedComment(
  input: RollbackFailedCommentInput,
): string {
  return `## Milestone branch stuck — needs-human (Issue #1781)\n\n` +
    `\`${input.milestoneBranch}\` spent its conflict budget and the ` +
    `roll-back could not make \`${input.defaultBranch}\` merge cleanly.\n\n` +
    `Reason: ${input.reason}\n\n` +
    `No new issue is filed. The worker will not try this branch again ` +
    `until the budget is reset.\n`;
}

interface OpenPr {
  number: number;
  headRefName: string;
  baseRefName: string;
  body: string;
}

interface IssueView {
  state: string;
  labels: string[];
}

/**
 * Reopen each reverted child, close its open PRs and the summary PR, and
 * post exactly one notice on the existing escalation target.
 */
export async function requeueRolledBackChildren(
  options: RequeueOptions,
): Promise<RequeueResult> {
  const {
    repo,
    milestoneTitle,
    milestoneNumber,
    milestoneBranch,
    defaultBranch,
    rollbacks,
    attempts,
    reverted,
    ghCommandFn,
    log,
  } = options;

  const reopened: number[] = [];
  const closedPrs: number[] = [];
  const needsTrustedRelabel: number[] = [];
  const noticeReverted: NoticeReverted[] = [];
  const seenIssues = new Set<number>();

  const openPrs = await listOpenPrs(repo, ghCommandFn, log);

  for (const child of reverted) {
    const issueNumber = await resolveChildIssue(child, repo, ghCommandFn, log);
    if (issueNumber === null) continue;
    if (seenIssues.has(issueNumber)) continue;
    seenIssues.add(issueNumber);

    noticeReverted.push({
      prNumber: child.prNumber,
      issueNumber,
      revertSha: child.sha,
    });

    const view = await readIssue(repo, issueNumber, ghCommandFn, log);
    await postMarker(
      repo,
      issueNumber,
      child,
      milestoneBranch,
      ghCommandFn,
      log,
    );

    if (view.state === "CLOSED") {
      const did = await reopenIssue(repo, issueNumber, ghCommandFn, log);
      if (did) reopened.push(issueNumber);
    }

    const pickup = view.labels.filter((l) =>
      PICKUP_LABELS.has(l.toLowerCase())
    );
    for (const label of pickup) {
      if (isWorkerAppliableLabel(label)) {
        await addLabel(repo, issueNumber, label, ghCommandFn, log);
      } else {
        await removeLabel(repo, issueNumber, label, ghCommandFn, log);
        if (!needsTrustedRelabel.includes(issueNumber)) {
          needsTrustedRelabel.push(issueNumber);
        }
      }
    }

    for (const pr of openPrs) {
      if (pr.number === child.prNumber || belongsToIssue(pr, issueNumber)) {
        const did = await closePr(
          repo,
          pr.number,
          rollbackCloseComment(milestoneBranch, child.sha, child.prNumber),
          ghCommandFn,
          log,
        );
        if (did) closedPrs.push(pr.number);
      }
    }
  }

  let closedSummaryPr: number | null = null;
  const summary = openPrs.find((pr) =>
    pr.headRefName === milestoneBranch && pr.baseRefName === defaultBranch
  );
  if (summary !== undefined && !closedPrs.includes(summary.number)) {
    const sha = reverted[0]?.sha ?? "unknown";
    const did = await closePr(
      repo,
      summary.number,
      rollbackCloseComment(milestoneBranch, sha, reverted[0]?.prNumber ?? 0),
      ghCommandFn,
      log,
    );
    if (did) closedSummaryPr = summary.number;
  } else if (summary !== undefined) {
    closedSummaryPr = summary.number;
  }

  const noticeIssue = await postSuccessNotice({
    repo,
    milestoneTitle,
    milestoneNumber,
    milestoneBranch,
    defaultBranch,
    rollbacks,
    attempts,
    reverted: noticeReverted,
    reopened,
    needsTrustedRelabel,
    ghCommandFn,
    log,
  });

  return {
    reopened,
    closedPrs,
    closedSummaryPr,
    needsTrustedRelabel,
    noticeIssue,
  };
}

/**
 * One `needs-human` comment on the existing escalation target when the
 * roll-back could not merge. A second call with `alreadyEscalated` posts
 * nothing. A milestone with nowhere to land is one log line and still
 * counts as escalated, so the line is not repeated every cycle.
 */
export async function escalateRollbackFailure(
  options: EscalateRollbackFailureOptions,
): Promise<RollbackFailureEscalation> {
  const {
    repo,
    milestoneTitle,
    milestoneNumber,
    milestoneBranch,
    defaultBranch,
    reason,
    alreadyEscalated,
    ghCommandFn,
    log,
  } = options;

  if (alreadyEscalated) {
    return { posted: false, issue: null, countedAsEscalated: true };
  }

  const parentIssue = trackingIssueFromMilestoneTitle(milestoneTitle);
  if (parentIssue === null) {
    const children = await listOpenMilestoneIssues(
      repo,
      milestoneNumber,
      ghCommandFn,
      log,
    );
    const decided = decideMilestoneEscalationTarget({
      parentIssue: null,
      children: children.map((number) => ({ number, kind: "issue" as const })),
    });
    if (decided.kind === "none") {
      log(
        `No open issue to carry a failed milestone roll-back for ` +
          `'${milestoneBranch}' in ${repo}: nowhere to post, so the ` +
          `failure stands in this log (Issue #1781).`,
      );
      return { posted: false, issue: null, countedAsEscalated: true };
    }
  }

  const target = await resolveMilestoneEscalationTarget({
    repo,
    milestone: { title: milestoneTitle, number: milestoneNumber },
    ghCommandFn,
    log,
  });

  if (target.kind === "none" || target.kind === "already-escalated") {
    log(
      `No open issue to carry a failed milestone roll-back for ` +
        `'${milestoneBranch}' in ${repo}: nowhere to post, so the ` +
        `failure stands in this log (Issue #1781).`,
    );
    return { posted: false, issue: null, countedAsEscalated: true };
  }

  const body = buildRollbackFailedComment({
    milestoneBranch,
    defaultBranch,
    reason,
  });
  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(target.issue),
      "--repo",
      repo,
      "--body",
      body,
    ]);
    await ghCommandFn([
      "issue",
      "edit",
      String(target.issue),
      "--repo",
      repo,
      "--add-label",
      "needs-human",
    ]);
    log(
      `Escalated a failed milestone roll-back for '${milestoneBranch}' ` +
        `in ${repo} to issue #${target.issue} (Issue #1781).`,
    );
    return { posted: true, issue: target.issue, countedAsEscalated: true };
  } catch (err) {
    log(
      `Failed to escalate a failed milestone roll-back for ` +
        `'${milestoneBranch}' in ${repo}: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1781).`,
    );
    return { posted: false, issue: target.issue, countedAsEscalated: false };
  }
}

async function resolveChildIssue(
  child: RevertedChild,
  repo: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<number | null> {
  const fromHead = resolveIssueForRevertedPr(child.headRefName, "");
  if (fromHead !== null) return fromHead;
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(child.prNumber),
      "--repo",
      repo,
      "--json",
      "body,headRefName",
    ]);
    const parsed = JSON.parse(raw) as {
      body?: string;
      headRefName?: string;
    };
    return resolveIssueForRevertedPr(
      parsed.headRefName ?? child.headRefName,
      parsed.body ?? "",
    );
  } catch (err) {
    log(
      `Could not resolve the issue for reverted PR #${child.prNumber} ` +
        `in ${repo}: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1781).`,
    );
    return null;
  }
}

async function readIssue(
  repo: string,
  issueNumber: number,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<IssueView> {
  try {
    const raw = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "state,labels",
    ]);
    const parsed = JSON.parse(raw) as {
      state?: string;
      labels?: Array<{ name?: string } | string>;
    };
    const labels = (parsed.labels ?? []).map((l) =>
      typeof l === "string" ? l : (l.name ?? "")
    ).filter((n) => n.length > 0);
    return { state: (parsed.state ?? "OPEN").toUpperCase(), labels };
  } catch (err) {
    log(
      `Could not read issue #${issueNumber} in ${repo} during roll-back ` +
        `re-queue: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1781). Treating it as open with no labels.`,
    );
    return { state: "OPEN", labels: [] };
  }
}

async function postMarker(
  repo: string,
  issueNumber: number,
  child: RevertedChild,
  branch: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<void> {
  const marker = buildRollbackMarker({
    prNumber: child.prNumber,
    revertSha: child.sha,
    branch,
  });
  const body = `${marker}\n\n` +
    `This issue was reopened because a milestone roll-back reverted ` +
    `PR #${child.prNumber} on \`${branch}\` (revert \`${child.sha}\`) ` +
    `(Issue #1781).`;
  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
  } catch (err) {
    log(
      `Could not post the roll-back marker on issue #${issueNumber} in ` +
        `${repo}: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1781).`,
    );
  }
}

async function reopenIssue(
  repo: string,
  issueNumber: number,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await ghCommandFn([
      "issue",
      "reopen",
      String(issueNumber),
      "--repo",
      repo,
    ]);
    return true;
  } catch (err) {
    log(
      `Could not reopen issue #${issueNumber} in ${repo} after a ` +
        `milestone roll-back: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1781).`,
    );
    return false;
  }
}

async function addLabel(
  repo: string,
  issueNumber: number,
  label: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<void> {
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      label,
    ]);
  } catch (err) {
    log(
      `Could not re-apply '${label}' on issue #${issueNumber} in ${repo}: ` +
        `${err instanceof Error ? err.message : String(err)} (Issue #1781).`,
    );
  }
}

async function removeLabel(
  repo: string,
  issueNumber: number,
  label: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<void> {
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-label",
      label,
    ]);
  } catch (err) {
    log(
      `Could not strip '${label}' from issue #${issueNumber} in ${repo}: ` +
        `${err instanceof Error ? err.message : String(err)} (Issue #1781).`,
    );
  }
}

function rollbackCloseComment(
  branch: string,
  revertSha: string,
  prNumber: number,
): string {
  return `Closed by a milestone roll-back of \`${branch}\` ` +
    `(reverted PR #${prNumber}, revert \`${revertSha}\`) (Issue #1781).`;
}

async function closePr(
  repo: string,
  prNumber: number,
  comment: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await ghCommandFn([
      "pr",
      "close",
      String(prNumber),
      "--repo",
      repo,
      "--comment",
      comment,
    ]);
    return true;
  } catch (err) {
    log(
      `Could not close PR #${prNumber} in ${repo} after a milestone ` +
        `roll-back: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1781).`,
    );
    return false;
  }
}

async function listOpenPrs(
  repo: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<OpenPr[]> {
  try {
    const raw = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,headRefName,baseRefName,body",
    ]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const r = row as Record<string, unknown>;
      const number = r.number;
      if (typeof number !== "number" || !Number.isInteger(number)) return [];
      return [{
        number,
        headRefName: typeof r.headRefName === "string" ? r.headRefName : "",
        baseRefName: typeof r.baseRefName === "string" ? r.baseRefName : "",
        body: typeof r.body === "string" ? r.body : "",
      }];
    });
  } catch (err) {
    log(
      `Could not list open PRs in ${repo} during roll-back re-queue: ` +
        `${err instanceof Error ? err.message : String(err)} (Issue #1781).`,
    );
    return [];
  }
}

function belongsToIssue(pr: OpenPr, issueNumber: number): boolean {
  return resolveIssueForRevertedPr(pr.headRefName, pr.body) === issueNumber;
}

async function listOpenMilestoneIssues(
  repo: string,
  milestoneNumber: number,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<number[]> {
  try {
    const raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--milestone",
      String(milestoneNumber),
      "--state",
      "open",
      "--json",
      "number",
    ]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const n = (row as { number?: unknown }).number;
      return typeof n === "number" && Number.isInteger(n) && n > 0 ? [n] : [];
    });
  } catch (err) {
    log(
      `Could not list open milestone issues in ${repo}: ${
        err instanceof Error ? err.message : String(err)
      } (Issue #1781).`,
    );
    return [];
  }
}

async function postSuccessNotice(
  options: {
    repo: string;
    milestoneTitle: string;
    milestoneNumber: number;
    milestoneBranch: string;
    defaultBranch: string;
    rollbacks: number;
    attempts: number;
    reverted: readonly NoticeReverted[];
    reopened: readonly number[];
    needsTrustedRelabel: readonly number[];
    ghCommandFn: GhCommandFn;
    log: (message: string) => void;
  },
): Promise<number | null> {
  const parent = trackingIssueFromMilestoneTitle(options.milestoneTitle);
  let issue = parent;
  if (issue === null) {
    const children = await listOpenMilestoneIssues(
      options.repo,
      options.milestoneNumber,
      options.ghCommandFn,
      options.log,
    );
    const decided = decideMilestoneEscalationTarget({
      parentIssue: null,
      children: children.map((number) => ({ number, kind: "issue" as const })),
    });
    if (decided.kind === "none") {
      options.log(
        `Rolled back '${options.milestoneBranch}' in ${options.repo} ` +
          `but there is no open issue to carry the notice (Issue #1781).`,
      );
      return null;
    }
    issue = decided.issue;
  }

  try {
    await options.ghCommandFn([
      "issue",
      "reopen",
      String(issue),
      "--repo",
      options.repo,
    ]);
  } catch {
    // Already open, or reopen failed — the comment is still attempted.
  }

  const body = buildRollbackNotice({
    milestoneBranch: options.milestoneBranch,
    defaultBranch: options.defaultBranch,
    rollbacks: options.rollbacks,
    attempts: options.attempts,
    reverted: options.reverted,
    reopened: options.reopened,
    needsTrustedRelabel: options.needsTrustedRelabel,
  });
  try {
    await options.ghCommandFn([
      "issue",
      "comment",
      String(issue),
      "--repo",
      options.repo,
      "--body",
      body,
    ]);
    return issue;
  } catch (err) {
    options.log(
      `Could not post the roll-back notice on issue #${issue} in ` +
        `${options.repo}: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1781).`,
    );
    return null;
  }
}
