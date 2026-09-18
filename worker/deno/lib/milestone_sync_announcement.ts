/**
 * Announce a milestone-sync conflict attempt while it is running
 * (Issue #2309).
 *
 * A conflict resolution can hold a milestone branch for the better part of an
 * hour, and until now the only record it left was a line in one host's log.
 * Whoever was watching the milestone saw a branch that had gone quiet and
 * could not tell a running attempt from a stalled one — which is what made a
 * second host's operator start the same work by hand.
 *
 * So the attempt says so where the milestone is already being read: one
 * comment on the milestone's escalation target ({@link
 * resolveMilestoneEscalationTarget}), naming the host it runs on and the ISO
 * time it opened. It is a record, not a request — nothing is labelled,
 * reopened or asked of anyone, exactly as every other post this sweep makes
 * (Issues #2214, #2226).
 *
 * Posted only when the agent rung is actually entered: a merge the
 * deterministic rules settle announces nothing. The caller keys the
 * announcement on the ledger's `attemptOpenedAt`, so one opened attempt is
 * announced once.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type MilestoneEscalationTarget,
  resolveMilestoneEscalationTarget,
} from "./milestone_escalation_target.ts";

/** Injectable `gh` command runner. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** The running attempt an announcement describes. */
export interface AgentAttemptAnnouncement {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** Milestone title — the escalation target is resolved from it. */
  milestoneTitle: string;
  /** GitHub milestone number, for the oldest-child fallback. */
  milestoneNumber: number;
  /** The milestone branch being merged into. */
  milestoneBranch: string;
  /** The default branch being merged down. */
  defaultBranch: string;
  /** The host the attempt runs on, from `currentHost()`. */
  host: string;
  /** ISO time the attempt opened — the ledger's `attemptOpenedAt`. */
  startedAt: string;
}

/**
 * The comment one running attempt posts.
 *
 * Pure, so the wording is tested without a `gh` stub. The host and the start
 * time are the two facts a reader cannot get from anywhere else: together they
 * say which worker holds the branch and how long it has held it.
 */
export function buildAgentAttemptComment(
  announcement: AgentAttemptAnnouncement,
): string {
  return `## Milestone sync is resolving a merge conflict now\n\n` +
    `\`${announcement.milestoneBranch}\` is being merged with ` +
    `\`${announcement.defaultBranch}\` by the conflict-resolution agent on ` +
    `**${announcement.host}**, started at ${announcement.startedAt}.\n\n` +
    `This is a record of an attempt that is running, not a request: the ` +
    `automatic ladder resolves the conflict, and the roll-back takes over if ` +
    `it cannot (Issue #2309).`;
}

/**
 * Post the announcement on the milestone's escalation target, best-effort.
 *
 * Returns true when the announcement is recorded — it was posted, or the
 * milestone has nowhere to post it, which no retry would change. A post that
 * failed returns false and is said out loud, so the caller leaves the attempt
 * unannounced rather than recording an announcement that never went out.
 *
 * @param announcement - The running attempt
 * @param ghCommandFn - Injected `gh` runner
 * @param log - Sink for the outcome line
 */
export async function announceAgentAttempt(
  announcement: AgentAttemptAnnouncement,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<boolean> {
  const { repo, milestoneBranch } = announcement;
  const target: MilestoneEscalationTarget =
    await resolveMilestoneEscalationTarget({
      repo,
      milestone: {
        title: announcement.milestoneTitle,
        number: announcement.milestoneNumber,
      },
      ghCommandFn,
      log,
    });

  if (target.kind === "none" || target.kind === "already-escalated") {
    log(
      `No open issue to carry the running sync attempt for ` +
        `'${milestoneBranch}' in ${repo}; it stands in this log only ` +
        `(Issue #2309).`,
    );
    return true;
  }

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(target.issue),
      "--repo",
      repo,
      "--body",
      buildAgentAttemptComment(announcement),
    ]);
    log(
      `Announced the running sync attempt for '${milestoneBranch}' in ${repo} ` +
        `on issue #${target.issue} (host ${announcement.host}, opened ` +
        `${announcement.startedAt}) (Issue #2309).`,
    );
    return true;
  } catch (err) {
    log(
      `WARNING: Could not announce the running sync attempt for ` +
        `'${milestoneBranch}' in ${repo}: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #2309).`,
    );
    return false;
  }
}
