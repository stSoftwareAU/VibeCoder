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
 *   1. the milestone's **parent planning issue**, as it stands — open or
 *      closed. It is never reopened and never labelled (Issue #2226): a sync
 *      post is the record of what the automatic ladder did and will do
 *      next, not a request for a person, and a reopened `needs-human`
 *      planning issue was exactly what the user kept closing by hand;
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
    /** The milestone's parent planning issue, as it stands. */
    issue: number;
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
    return { kind: "parent", issue: parent };
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
   * Whether the destination already carries this escalation (Issue #1786),
   * so the same report is not posted every cycle.
   */
  alreadyEscalated?: (issueNumber: number) => Promise<boolean>;
}

/**
 * Resolve the destination of a milestone-sync post.
 *
 * Best-effort by design: a lookup that fails degrades the answer rather than
 * failing the sync, and says so in the log instead of going quiet. Two things
 * it never does: create an issue, and reopen or label one (Issue #2226) — a
 * comment on a closed planning issue is a fine record, and the automatic
 * ladder (the attempt budget, then the roll-back) is what acts on it.
 *
 * When `alreadyEscalated` answers true for the destination, the answer is
 * `already-escalated` and nothing is posted (Issue #1786).
 *
 * @param options - Repo, milestone, `gh` runner and log sink.
 * @returns The destination — parent, oldest open child, or none.
 */
export async function resolveMilestoneEscalationTarget(
  options: ResolveMilestoneEscalationTargetOptions,
): Promise<MilestoneEscalationTarget> {
  const { milestone } = options;
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
