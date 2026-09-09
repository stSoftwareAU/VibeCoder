/**
 * Where a milestone-sync escalation lands (Issue #1769).
 *
 * Every milestone-sync escalation used to have two destinations: a comment on
 * the tracking issue the milestone title leads with, or — when the title
 * carried no `#NNN` — a freshly filed `needs-human` issue. Planning closes the
 * parent issue once the sub-issues are filed, so in practice almost every
 * milestone took the second path and the fleet accumulated one new diagnostic
 * per branch and per conflicting commit (#1754, #1756, #1764,
 * NEAT-AI-scorer#612/#613, GRQ-AutoTrader#120).
 *
 * An escalation is a message, not a work item, so it belongs on an issue that
 * already exists. This module answers the only question that matters — which
 * one — in three steps:
 *
 *   1. the milestone's **parent planning issue**, reopened when planning has
 *      already closed it (a reopened parent gets `needs-human`, never a
 *      pickup label: it is for a human to read, not for the fleet to pick up);
 *   2. otherwise the **oldest open non-tracking child** of the milestone,
 *      which is where a human working the milestone is already looking;
 *   3. otherwise **nowhere** — the caller logs one line and stops. Filing an
 *      issue is no longer one of the outcomes.
 *
 * The decision is pure ({@link decideMilestoneEscalationTarget}) and the `gh`
 * work around it is a thin wrapper ({@link resolveMilestoneEscalationTarget}),
 * following the `milestone_children_gate.ts` precedent.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  fetchOpenMilestoneChildren,
  type OpenMilestoneChild,
} from "./milestone_children_gate.ts";
import type { MilestoneTrackerVerification } from "./milestone_tracker_identity.ts";
import { trackingIssueFromMilestoneTitle } from "./milestone_sync_streak.ts";

/** Injectable `gh` command runner. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** Where an escalation for this milestone should be posted. */
export type MilestoneEscalationTarget =
  | {
    kind: "parent";
    /** The milestone's parent planning issue. */
    issue: number;
    /** True when this escalation is what reopened it. */
    reopened: boolean;
  }
  | {
    kind: "child";
    /** The milestone's oldest open non-tracking child. */
    issue: number;
  }
  | {
    /**
     * The destination already carries this escalation (Issue #1786), so
     * nothing is posted and nothing was reopened to post it.
     */
    kind: "already-escalated";
    issue: number;
  }
  | { kind: "none" };

/** The state the pure decision reads. */
export interface MilestoneEscalationCandidates {
  /** Tracking issue the milestone title leads with, or `null` when none. */
  parentIssue: number | null;
  /** The milestone's open non-tracking children, in any order. */
  children: readonly Pick<OpenMilestoneChild, "number" | "kind">[];
}

/**
 * Decide where an escalation goes, given the candidates.
 *
 * Pure: no `gh`, no clock, no filesystem. "Oldest child" is the lowest issue
 * number — GitHub numbers monotonically, so the smallest number is the child
 * that has been open longest, and it needs no extra API field to read.
 *
 * Child **PRs** are never a destination: merging the milestone summary PR
 * deletes the branch and auto-closes them, which would bury the escalation in
 * a closed PR nobody reads again.
 *
 * @param candidates - The parent issue and the open children.
 * @returns The parent, else the oldest child, else `none`.
 */
export function decideMilestoneEscalationTarget(
  candidates: MilestoneEscalationCandidates,
): MilestoneEscalationTarget {
  const parent = candidates.parentIssue;
  if (parent !== null && Number.isInteger(parent) && parent > 0) {
    return { kind: "parent", issue: parent, reopened: false };
  }

  let oldest: number | null = null;
  for (const child of candidates.children) {
    if (child.kind === "pr") continue;
    if (!Number.isInteger(child.number) || child.number <= 0) continue;
    if (oldest === null || child.number < oldest) oldest = child.number;
  }
  if (oldest !== null) return { kind: "child", issue: oldest };

  return { kind: "none" };
}

/** The milestone an escalation is being resolved for. */
export interface EscalationMilestone {
  /** Milestone title — the parent issue number is parsed from it. */
  title: string;
  /** GitHub milestone number, needed to read the milestone's children. */
  number?: number;
}

/** Everything {@link resolveMilestoneEscalationTarget} needs. */
export interface ResolveMilestoneEscalationTargetOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The milestone whose sync is being escalated. */
  milestone: EscalationMilestone;
  /** Injected `gh` runner. */
  ghCommandFn: GhCommandFn;
  /** Sink for the degraded-lookup and reopen lines. */
  log: (message: string) => void;
  /** Fleet-identity inputs for the tracking-child exclusion (Issue #1246). */
  verification?: MilestoneTrackerVerification;
  /**
   * Whether the destination already carries this escalation (Issue #1786).
   *
   * Asked before the parent is reopened, so an escalation that has already
   * gone out never reopens an issue a human has since closed.
   */
  alreadyEscalated?: (issueNumber: number) => Promise<boolean>;
}

/**
 * Resolve the destination of a milestone-sync escalation, reopening the
 * parent planning issue when it is the destination and is closed.
 *
 * Best-effort by design: a lookup that fails degrades the answer rather than
 * failing the sync, and says so in the log instead of going quiet. The one
 * thing it never does is create an issue.
 *
 * When `alreadyEscalated` answers true for the destination, the answer is
 * `already-escalated` and nothing is reopened (Issue #1786) — reopening an
 * issue a human closed, only to then post nothing, undoes their close with no
 * explanation.
 *
 * @param options - Repo, milestone, `gh` runner and log sink.
 * @returns The destination — parent, oldest open child, or none.
 */
export async function resolveMilestoneEscalationTarget(
  options: ResolveMilestoneEscalationTargetOptions,
): Promise<MilestoneEscalationTarget> {
  const { repo, milestone, ghCommandFn, log } = options;
  const parentIssue = trackingIssueFromMilestoneTitle(milestone.title);
  const children = parentIssue === null ? await readOpenChildren(options) : [];

  const decision = decideMilestoneEscalationTarget({ parentIssue, children });
  if (decision.kind === "none") return decision;

  // Issue #1786: asked before anything is reopened. A destination that
  // already carries this escalation must not be reopened to say nothing.
  if (
    options.alreadyEscalated !== undefined &&
    await options.alreadyEscalated(decision.issue)
  ) {
    return { kind: "already-escalated", issue: decision.issue };
  }

  if (decision.kind !== "parent") return decision;

  if (await isIssueClosed(repo, decision.issue, ghCommandFn, log)) {
    return {
      ...decision,
      reopened: await reopenParentIssue(
        repo,
        decision.issue,
        milestone,
        ghCommandFn,
        log,
      ),
    };
  }
  return decision;
}

/**
 * Read the milestone's open non-tracking children, best-effort.
 *
 * A milestone whose number is unknown, or whose children cannot be read, has
 * no child destination — the caller falls through to `none` and logs.
 */
async function readOpenChildren(
  options: ResolveMilestoneEscalationTargetOptions,
): Promise<readonly OpenMilestoneChild[]> {
  const { repo, milestone, ghCommandFn, log } = options;
  if (!Number.isInteger(milestone.number) || (milestone.number ?? 0) <= 0) {
    log(
      `Milestone '${milestone.title}' in ${repo} has no milestone number ` +
        `here, so its open children could not be considered as an ` +
        `escalation destination (Issue #1769).`,
    );
    return [];
  }

  // No `milestoneBranch`: the PRs based on the branch are read only to be
  // discarded here, and asking for them costs an extra API call per
  // escalation.
  const result = await fetchOpenMilestoneChildren({
    repo,
    milestoneNumber: milestone.number!,
    ...(options.verification !== undefined
      ? { verification: options.verification }
      : {}),
    ghCommandFn,
  });
  if (!result.ok) {
    log(
      `Could not read the open children of milestone '${milestone.title}' ` +
        `in ${repo} for an escalation destination: ${result.error.message} ` +
        `(Issue #1769).`,
    );
    return [];
  }
  return result.value;
}

/**
 * True when the issue is closed. An unreadable state answers `false`: the
 * escalation comment is attempted either way, and a needless reopen is a
 * worse outcome than a comment on an issue that was open all along.
 */
async function isIssueClosed(
  repo: string,
  issueNumber: number,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    const out = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "state",
      "--jq",
      ".state",
    ]);
    return out.trim().toUpperCase() === "CLOSED";
  } catch (err) {
    log(
      `Could not read the state of issue #${issueNumber} in ${repo} before ` +
        `escalating a milestone sync: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1769).`,
    );
    return false;
  }
}

/**
 * Reopen the parent planning issue so the escalation lands somewhere open.
 *
 * `needs-human` is added because the reopened issue is for a person to read;
 * no pickup label is ever added, so reopening cannot put the milestone's
 * planning back into the fleet's work queue. A label the repository does not
 * define is logged rather than swallowed, and never blocks the reopen.
 *
 * @returns True when the reopen succeeded, so the caller can say why the
 *   issue is open again in the escalation comment it is about to post.
 */
async function reopenParentIssue(
  repo: string,
  issueNumber: number,
  milestone: EscalationMilestone,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await ghCommandFn(["issue", "reopen", String(issueNumber), "--repo", repo]);
  } catch (err) {
    log(
      `Could not reopen issue #${issueNumber} in ${repo} to carry a ` +
        `milestone sync escalation for '${milestone.title}': ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1769). The escalation comment is still attempted.`,
    );
    return false;
  }

  log(
    `Reopened issue #${issueNumber} in ${repo} to carry a milestone sync ` +
      `escalation for '${milestone.title}' (Issue #1769).`,
  );

  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      "needs-human",
    ]);
  } catch (err) {
    log(
      `Reopened issue #${issueNumber} in ${repo} but could not label it ` +
        `needs-human: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #1769).`,
    );
  }
  return true;
}
