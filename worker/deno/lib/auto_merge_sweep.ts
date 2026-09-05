/**
 * Priority 1.65 auto-merge sweep (Issue #1082).
 *
 * Extracted from `run_core_production_deps.ts` so the two invariants the
 * fleet's throughput depends on are testable rather than asserted in prose:
 *
 * 1. **Every monitored repo is swept, every cycle** — the sweep is driven by
 *    the repo list, never by which repo has claimable work. A repo whose only
 *    PR blocks all of its own issues has no claimable work by construction,
 *    so a work-driven sweep would never revisit it and the block would be
 *    permanent.
 * 2. **Every fleet author's PRs are swept** — not just this host's own login.
 *    `getBlockingPRForIssue()` defers a `work-on` issue to a PR from *any*
 *    push-capable fleet account, so a sweep that only listed
 *    `prs_${githubUser}` left a sibling account's PR unattended forever.
 *    `GRQ-GTC#305` sat open for five days with no auto-merge attempt logged
 *    against it at all: it was authored by `stservice` while the scanning
 *    host was `VibeCoderST`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger, Result } from "../types.ts";
import type { EnableAutoMergeResult } from "./pr_auto_merge.ts";

/** One open PR the sweep may act on. */
export interface SweepablePr {
  /** PR number. */
  number: number;
  /** Head branch — passed on so the milestone gate needs no extra lookup. */
  headRefName?: string;
  /** Base branch — decides native auto-merge versus the gated direct merge. */
  baseRefName?: string;
}

/** Dependencies for {@link sweepAutoMerge}. */
export interface SweepAutoMergeOptions {
  /** Monitored repositories in `owner/repo` format. */
  repos: readonly string[];
  /** Repo allowlist gate. */
  isRepoAllowed: (repo: string) => boolean;
  /**
   * Fleet logins whose open PRs the sweep covers — the same push-capable set
   * the blocking guard defers `work-on` issues to.
   */
  fleetAuthors: readonly string[];
  /** List a repo's open PRs across the supplied authors. */
  listOpenPrs: (
    repo: string,
    authors: readonly string[],
  ) => Promise<readonly SweepablePr[]>;
  /** Attempt the merge for one PR. */
  attemptMerge: (
    repo: string,
    pr: SweepablePr,
  ) => Promise<EnableAutoMergeResult>;
  /** Record the outcome (Issue #470 — a gate may refuse, not refuse silently). */
  recordOutcome: (
    repo: string,
    prNumber: number,
    outcome: EnableAutoMergeResult,
  ) => void;
  /** Drop the repo's cached open-PR list after a merge attempt mutated it. */
  invalidateOpenPrCache: (repo: string) => Promise<void>;
  /** Logger. */
  logger: Pick<Logger, "warn">;
}

/** What one sweep did. */
export interface SweepAutoMergeSummary {
  /** Repositories the sweep visited (allowlisted, listing succeeded or not). */
  reposVisited: string[];
  /** PRs a merge was attempted for. */
  prsAttempted: number;
}

/**
 * Sweep every monitored repository's open fleet PRs for auto-merge.
 *
 * Best-effort at both levels and loud about it: a repo whose PR listing fails
 * is logged and skipped, and a PR whose attempt throws is logged and skipped,
 * so one unreachable repo can never stop the fleet from landing the rest.
 */
export async function sweepAutoMerge(
  options: SweepAutoMergeOptions,
): Promise<Result<SweepAutoMergeSummary>> {
  const {
    repos,
    isRepoAllowed,
    fleetAuthors,
    listOpenPrs,
    attemptMerge,
    recordOutcome,
    invalidateOpenPrCache,
    logger,
  } = options;

  const summary: SweepAutoMergeSummary = { reposVisited: [], prsAttempted: 0 };

  try {
    for (const repo of repos) {
      if (!isRepoAllowed(repo)) continue;
      summary.reposVisited.push(repo);

      let prs: readonly SweepablePr[];
      try {
        prs = await listOpenPrs(repo, fleetAuthors);
      } catch (err) {
        logger.warn("Auto-merge sweep could not list open PRs", {
          repo,
          error: errorMessage(err),
        });
        continue;
      }

      let mutated = false;
      for (const pr of prs) {
        try {
          const outcome = await attemptMerge(repo, pr);
          recordOutcome(repo, pr.number, outcome);
          summary.prsAttempted++;
          mutated = true;
        } catch (err) {
          logger.warn("Auto-merge attempt threw", {
            repo,
            prNumber: pr.number,
            error: errorMessage(err),
          });
        }
      }

      // Enabling auto-merge can close a PR immediately when the checks
      // already pass, so the cached open-PR list is stale from here on.
      if (mutated) {
        try {
          await invalidateOpenPrCache(repo);
        } catch (err) {
          logger.warn("Auto-merge sweep could not invalidate the PR cache", {
            repo,
            error: errorMessage(err),
          });
        }
      }
    }
    return { ok: true, value: summary };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
