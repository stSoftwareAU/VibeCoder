/**
 * Did a merged PR actually LAND (Issue #4396)?
 *
 * "The PR merged" is not the same as "the work reached the default branch".
 * Seven fixes merged into `milestone/clean-up` eleven days after that
 * milestone's rollup PR had merged into Develop; the branch's route had
 * closed, the work evaporated with the branch, and every issue auto-closed
 * as COMPLETED because a PR really had merged. Every auto-close path now
 * asks this question first: is the merge commit reachable from the default
 * branch — or, for a merge into a milestone branch, is that branch's route
 * to the default branch still open (milestone open, rollup not yet merged)?
 * Anything else is not a landing, and the issue stays open with the reason.
 *
 * Failure policy: an unreadable state is `unknown`, never a landing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  decideMilestoneBaseMerge,
  isMilestoneBranch,
} from "./milestone_children_gate.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";

type GhCommandFn = (args: string[]) => Promise<string>;

/** The verdict. */
export type MergeLanding =
  | {
    landed: true;
    via: "default-branch" | "milestone-route-open" | "milestone-rollup";
    mergeCommit: string;
    baseRefName: string;
  }
  | {
    landed: false;
    reason: "not-merged" | "orphaned" | "unknown";
    detail: string;
    mergeCommit?: string;
    baseRefName?: string;
  };

/** Options for {@link verifyMergeLanded}. */
export interface VerifyMergeLandedOptions {
  /** The default branch, when the caller knows it (saves a lookup). */
  defaultBranch?: string;
}

/** `mergedAt` of a PR as epoch ms, or null when unreadable. */
async function fetchMergedAt(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
): Promise<number | null> {
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "mergedAt",
    ]);
    const parsed = JSON.parse(raw) as { mergedAt?: unknown };
    const ms = typeof parsed.mergedAt === "string"
      ? Date.parse(parsed.mergedAt)
      : NaN;
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/** Whether the merge commit of `prNumber` is reachable from the default branch. */
export async function verifyMergeLanded(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
  options: VerifyMergeLandedOptions = {},
): Promise<MergeLanding> {
  let pr: {
    state?: string;
    mergeCommit?: { oid?: string } | null;
    baseRefName?: string;
    mergedAt?: string;
  };
  try {
    pr = JSON.parse(
      await ghCommandFn([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "state,mergeCommit,baseRefName,mergedAt",
      ]),
    );
  } catch (err) {
    return {
      landed: false,
      reason: "unknown",
      detail: `could not read PR #${prNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (pr.state !== "MERGED") {
    return {
      landed: false,
      reason: "not-merged",
      detail: `PR #${prNumber} is ${pr.state ?? "unknown"}`,
    };
  }
  const mergeCommit = pr.mergeCommit?.oid;
  const baseRefName = pr.baseRefName ?? "";
  if (!mergeCommit) {
    return {
      landed: false,
      reason: "unknown",
      detail: `PR #${prNumber} reports no merge commit`,
      baseRefName,
    };
  }

  let defaultBranch = options.defaultBranch;
  if (!defaultBranch) {
    const resolved = await getRepoDefaultBranch(repo, ghCommandFn);
    if (!resolved.ok) {
      return {
        landed: false,
        reason: "unknown",
        detail: `default branch unknown: ${resolved.error.message}`,
        mergeCommit,
        baseRefName,
      };
    }
    defaultBranch = resolved.value;
  }

  // 1. Reachable from the default branch → landed.
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${
        encodeURIComponent(defaultBranch)
      }...${mergeCommit}`,
    ]);
    const parsed = JSON.parse(raw) as { status?: unknown };
    const status = typeof parsed.status === "string" ? parsed.status : "";
    if (status === "identical" || status === "behind") {
      return { landed: true, via: "default-branch", mergeCommit, baseRefName };
    }
  } catch (err) {
    return {
      landed: false,
      reason: "unknown",
      detail: `could not compare ${defaultBranch}...${mergeCommit}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      mergeCommit,
      baseRefName,
    };
  }

  // 2. Not on the default branch: fine if it merged into a milestone
  //    branch whose route is still open — or whose rollup merged AFTER
  //    this PR did (a squash/rebase rollup rewrites the child commits, so
  //    the content landed even though the merge commit is unreachable).
  //    Only a merge into the milestone branch AFTER its rollup is orphaned.
  if (isMilestoneBranch(baseRefName)) {
    const route = await decideMilestoneBaseMerge({
      repo,
      prNumber,
      baseRefName,
      ghCommandFn,
    });
    if (route.decision === "allow") {
      return {
        landed: true,
        via: "milestone-route-open",
        mergeCommit,
        baseRefName,
      };
    }
    if (route.reason === "rollup-merged" && route.rollupPrNumber) {
      const rollupMergedAt = await fetchMergedAt(
        repo,
        route.rollupPrNumber,
        ghCommandFn,
      );
      const childMergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
      if (
        rollupMergedAt !== null && !Number.isNaN(childMergedAt) &&
        childMergedAt <= rollupMergedAt
      ) {
        return {
          landed: true,
          via: "milestone-rollup",
          mergeCommit,
          baseRefName,
        };
      }
    }
    return {
      landed: false,
      reason: route.reason === "lookup-failed" ? "unknown" : "orphaned",
      detail:
        `PR #${prNumber} merged into ${baseRefName} but ${route.detail}; the merge commit ${
          mergeCommit.slice(0, 8)
        } is not reachable from ${defaultBranch}` +
        (route.reason === "rollup-merged"
          ? " and this PR merged after the rollup"
          : ""),
      mergeCommit,
      baseRefName,
    };
  }
  return {
    landed: false,
    reason: "orphaned",
    detail: `PR #${prNumber} merged into ${baseRefName} but its merge commit ${
      mergeCommit.slice(0, 8)
    } is not reachable from ${defaultBranch}`,
    mergeCommit,
    baseRefName,
  };
}
