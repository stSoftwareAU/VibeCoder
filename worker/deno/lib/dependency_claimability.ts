/**
 * Classify whether a dependency is unclaimable due to blocking labels/states.
 *
 * A dependency blocks a work-on candidate either normally (the dependency is
 * blocked but claimable — it will eventually clear by itself, Issue #2610) or
 * abnormally (the dependency is stalled due to an unclaimable state —
 * needs-human label, merged PR, or fleet-author exclusion).
 *
 * This module classifies the stall case so that `collectWorkOnCandidates` can
 * escalate it separately from an ordinary dependency block, reducing noise
 * when a dependency is merely busy versus when it is stranded (Issue #2473).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { FilterableIssue } from "./issue_filter.ts";

/**
 * Class of unclaimability that stalls a dependency.
 *
 * - `"needs-human"` — the dependency carries the needs-human label.
 * - `"assigned"` — the dependency is assigned to a non-fleet author.
 * - `"merged-pr-permanent"` — the dependency is blocked by a merged PR
 *   (permanent block that only explicit trusted re-approval lifts).
 */
export type DependencyStallClass =
  | "needs-human"
  | "assigned"
  | "merged-pr-permanent";

/**
 * A dependency that is stalled due to an unclaimable state.
 */
export interface DependencyStall {
  /** Repository containing the stalled dependency (usually same-repo). */
  repo: string;
  /** Issue number of the stalled dependency. */
  number: number;
  /** Reason the dependency is stalled. */
  stallClass: DependencyStallClass;
  /** Human-readable detail (label name, author login, etc.). */
  detail: string;
}

/**
 * Context for classifying dependency claimability.
 */
export interface DependencyClaimabilityContext {
  /** Repository being scanned. */
  repo: string;
  /** Name of the needs-human label (e.g., "needs-human"). */
  needsHumanLabel: string;
  /**
   * Authorised fleet authors (e.g., ["bot", "alice"]).
   * An assignee not in this list stalls the dependency.
   */
  fleetAuthors: string[];
  /**
   * All issues visible in the repo, indexed by number for claimability checks.
   * Only same-repo issues are consulted; cross-repo dependencies skip stall
   * classification and return null (ordinary block, not stall).
   */
  openIssues: Map<number, FilterableIssue>;
  /**
   * Optional: check whether a dependency is blocked by a merged PR.
   * If provided and returns true, the dependency is stalled with
   * stallClass "merged-pr-permanent".
   */
  isBlockedByMergedPr?: (repo: string, number: number) => boolean;
}

/**
 * Classify the first unclaimable stall in a list of dependency blockers.
 *
 * Returns the stall if found, or null if all blockers are claimable or
 * cross-repo. Only same-repo blockers are checked (cross-repo dependencies
 * cannot be escalated by this repo, so they remain ordinary blocks, not stalls).
 *
 * @param blockers - The list of dependencies that block the candidate.
 * @param ctx - Claimability context (labels, authors, merged PR check).
 * @returns The first unclaimable stall, or null if all are claimable.
 */
export function findDependencyStall(
  blockers: Array<{ repo: string; number: number }>,
  ctx: DependencyClaimabilityContext,
): DependencyStall | null {
  for (const blocker of blockers) {
    // Cross-repo dependencies are ordinary blocks (Issue #2610 is same-repo).
    // Do not escalate them as stalls.
    if (blocker.repo !== ctx.repo) {
      continue;
    }

    const issue = ctx.openIssues.get(blocker.number);
    if (!issue) {
      // Issue not found in visible set; treat as claimable (ordinary block).
      continue;
    }

    // Check needs-human label.
    if (issue.labels.includes(ctx.needsHumanLabel)) {
      return {
        repo: blocker.repo,
        number: blocker.number,
        stallClass: "needs-human",
        detail: ctx.needsHumanLabel,
      };
    }

    // Check merged-PR block.
    if (ctx.isBlockedByMergedPr?.(blocker.repo, blocker.number)) {
      return {
        repo: blocker.repo,
        number: blocker.number,
        stallClass: "merged-pr-permanent",
        detail: "merged PR",
      };
    }

    // Check assignee fleet-author exclusion.
    for (const assignee of issue.assignees) {
      if (!ctx.fleetAuthors.includes(assignee)) {
        return {
          repo: blocker.repo,
          number: blocker.number,
          stallClass: "assigned",
          detail: assignee,
        };
      }
    }
  }

  return null;
}
