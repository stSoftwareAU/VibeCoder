/**
 * Request fresh CI for a pull request whose workflow run GitHub permanently
 * refused to re-run (Issue #4497).
 *
 * A run GitHub reports as `This workflow run cannot be retried` can never be
 * re-run, so the only way to get a new CI signal is a new commit. The scan
 * paths (infrastructure re-run, exhausted-check re-run) have no checkout, so
 * the empty commit is made through the Git Data API: a commit that reuses the
 * head commit's tree and has the head as its only parent, then a
 * fast-forward-only (non-force) update of the branch ref. A branch that moved
 * since the head was read refuses the update, so nothing is overwritten.
 *
 * At most one attempt is made per repository and head: the
 * `vibe-ci-rerun-fallback` marker is posted before the ref moves, and a head
 * that already carries one is skipped. A head under a ruleset that refuses
 * direct pushes is left alone.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import {
  buildCiRerunFallbackMarker,
  type FleetCiFixMarkers,
  isCiRerunFallbackRecordedAt,
} from "./ci_fix_attempt_markers.ts";
import { assessGatedHead } from "./gated_head_guard.ts";
import { replyToComment } from "./pr_comments.ts";

/** What {@link requestFreshCiAfterRerunRefusal} did. */
export type FreshCiOutcome =
  | "pushed"
  | "already-attempted"
  | "not-authorised"
  | "failed";

const FORTY_HEX = /^[0-9a-f]{40}$/i;

const EMPTY_COMMIT_MESSAGE = "chore: nudge CI (Vibe Coder)\n\n" +
  "Empty commit pushed by the Vibe Coder because GitHub refused to re-run " +
  "the previous workflow run. Safe to ignore. See Issue #4497.";

/**
 * Push one empty commit to the PR branch so CI starts afresh.
 *
 * Never throws; every failure is logged and reported as `failed`.
 */
export async function requestFreshCiAfterRerunRefusal(opts: {
  repo: string;
  prNumber: number;
  branchName: string;
  headSha: string | undefined;
  fleetMarkers: FleetCiFixMarkers;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}): Promise<FreshCiOutcome> {
  const { repo, prNumber, branchName, headSha, fleetMarkers, ghCommandFn } =
    opts;
  const { logger } = opts;
  const context = { repo, prNumber, branchName, headSha };

  if (headSha === undefined || !FORTY_HEX.test(headSha)) {
    logger.error(
      `Fresh-CI fallback for ${repo}#${prNumber} has no verified head ` +
        `(Issue #4497)`,
      context,
    );
    return "not-authorised";
  }
  if (!fleetMarkers.fleetResolved) {
    logger.error(
      `Fresh-CI fallback for ${repo}#${prNumber} cannot be deduplicated ` +
        `because the fleet marker state is unresolved (Issue #4497)`,
      context,
    );
    return "not-authorised";
  }
  if (isCiRerunFallbackRecordedAt(fleetMarkers, repo, headSha)) {
    logger.info(
      `Fresh-CI fallback for ${repo}#${prNumber} was already attempted on ` +
        `${headSha}; skipping a duplicate push (Issue #4497)`,
      context,
    );
    return "already-attempted";
  }

  const gate = await assessGatedHead(repo, branchName, ghCommandFn);
  if (gate.gated) {
    logger.warn(
      `Fresh-CI fallback for ${repo}#${prNumber} skipped: ${branchName} ` +
        `refuses direct pushes — ${gate.detail} (Issue #4497)`,
      context,
    );
    return "not-authorised";
  }

  try {
    const tip = (await ghCommandFn([
      "api",
      `repos/${repo}/git/ref/heads/${branchName}`,
      "--jq",
      ".object.sha",
    ])).trim();
    if (tip.toLowerCase() !== headSha.toLowerCase()) {
      logger.error(
        `Fresh-CI fallback for ${repo}#${prNumber} stood down because ` +
          `${branchName} moved from ${headSha} to ${tip} (Issue #4497)`,
        context,
      );
      return "failed";
    }
    const tree = (await ghCommandFn([
      "api",
      `repos/${repo}/git/commits/${headSha}`,
      "--jq",
      ".tree.sha",
    ])).trim();
    if (!FORTY_HEX.test(tree)) {
      throw new Error(`unexpected tree id '${tree}'`);
    }

    // Record before pushing: a rejected push is still one attempt per head.
    const posted = await replyToComment(
      repo,
      prNumber,
      buildCiRerunFallbackMarker({ repo, head: headSha }),
      ghCommandFn,
    );
    if (!posted.ok) {
      logger.error(
        `Could not persist the fresh-CI fallback marker for ` +
          `${repo}#${prNumber}: ${posted.error.message} — no empty commit ` +
          `was pushed (Issue #4497)`,
        context,
      );
      return "failed";
    }

    const created = (await ghCommandFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/git/commits`,
      "-f",
      `message=${EMPTY_COMMIT_MESSAGE}`,
      "-f",
      `tree=${tree}`,
      "-f",
      `parents[]=${headSha}`,
      "--jq",
      ".sha",
    ])).trim();
    if (!FORTY_HEX.test(created)) {
      throw new Error(`unexpected commit id '${created}'`);
    }
    await ghCommandFn([
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/git/refs/heads/${branchName}`,
      "-f",
      `sha=${created}`,
      "-F",
      "force=false",
    ]);
    logger.info(
      `Pushed an empty commit ${created} to ${repo}@${branchName} after ` +
        `workflow run refusal (Issue #4497)`,
      { ...context, commit: created },
    );
    return "pushed";
  } catch (error) {
    logger.error(
      `Fresh-CI fallback failed for ${repo}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      } (Issue #4497)`,
      context,
    );
    return "failed";
  }
}
