/**
 * Stall repair for blocking PRs (Issue #2802, part of #2788).
 *
 * The blocking-PR stall watchdog (`blocking_pr_stall_detector.ts`) used to
 * answer red CI or an unanswered authorised comment by filing a
 * `PR #N cannot land: …` issue and labelling the PR `escalated`. That handed
 * mechanical work back to a queue as more work. This pass repairs instead, on
 * a two-trip ladder:
 *
 * - **First trip** — record a hidden trip marker on the PR, sync the branch
 *   with its target, and rerun the owning lane once (CI fix for red CI, PR
 *   feedback for an unanswered comment). The marker is posted first: it is the
 *   claim, so a crash or a second host cannot rerun the lane twice.
 * - **Second trip** — the PR is still stalled once the marker is older than
 *   the stall threshold, so it is abandoned and its originating issue redone
 *   through `abandonAndRestart`, which keeps the issue's own pickup label or
 *   applies `idle-task` (never `work-on`). A PR carrying the auto-fix cap
 *   marker goes straight here: its lane has already given up.
 *
 * Only a worker-authored PR is touched; a human-authored one is logged and
 * left alone. A PR the merge-conflict ladder owns is left to the ladder. Every
 * repair runs under the maintenance-lane lease on the PR's repository and is
 * skipped when the lease is held elsewhere.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger, Result } from "../types.ts";
import {
  AUTO_FIX_CAP_MARKER_PREFIX,
  type BlockingPrStall,
  type BlockingPrStallReason,
  buildBlockingPrStallReason,
  resolveBlockingPrStallThresholdSeconds,
  scanBlockingPrStalls,
  type ScanBlockingPrStallsOptions,
  STALL_REPAIR_MARKER_PREFIX,
} from "./blocking_pr_stall_detector.ts";
import {
  abandonAndRestart,
  type AbandonRestartDeps,
  type AbandonRestartOutcome,
  type AbandonRestartRequest,
} from "./conflict_abandon_restart.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import {
  acquireMaintenanceRepoLease,
  type RepoLease,
} from "./maintenance_lane.ts";

export { STALL_REPAIR_MARKER_PREFIX };

/** The lane that owns a stall signal and is rerun on the first trip. */
export type StallLane = "ci-fix" | "pr-feedback";

/** The PR a repair acts on. */
export interface StallRepairTarget {
  repo: string;
  prNumber: number;
  headRefName: string;
  baseRefName: string;
}

/** What the pass did with one stalled PR. */
export type StallRepairAction =
  | "skipped-human-authored"
  | "skipped-merge-conflict-lane"
  | "skipped-lease-held"
  | "first-trip"
  | "awaiting-second-check"
  | "abandoned"
  | "abandon-declined"
  | "failed";

/** Seams for {@link repairStalledPr}. */
export interface StallRepairDeps {
  /** Runs `gh`, returning stdout; throws on failure. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /**
   * The worker's own logins (the push-capable fleet set). Only a PR one of
   * these authored is repaired, and only their marker comments count. Empty
   * means no identity is known, so nothing is touched.
   */
  workerAuthors: readonly string[];
  /** Syncs the PR branch with its target — `git_pull.ts` in production. */
  syncBranch: (target: StallRepairTarget) => Promise<Result<string>>;
  /** Reruns the owning lane on this PR once. */
  dispatchLane: (
    target: StallRepairTarget,
    lane: StallLane,
  ) => Promise<Result<void>>;
  /** Stall threshold for the repo, in seconds. */
  thresholdSeconds: (repo: string) => number;
  /** Current time, epoch seconds. */
  nowSeconds: () => number;
  logger: Logger;
  /** Lease override (tests); defaults to the maintenance-lane lease. */
  acquireLease?: (repo: string, prNumber: number) => RepoLease | null;
  /** Abandon override (tests); defaults to {@link abandonAndRestart}. */
  abandon?: (
    request: AbandonRestartRequest,
    deps: AbandonRestartDeps,
  ) => Promise<AbandonRestartOutcome>;
  /** Extra seams passed through to the abandon (tests). */
  abandonDeps?: Partial<AbandonRestartDeps>;
}

/** The lane that owns one stall reason. */
export function owningLane(reason: BlockingPrStallReason): StallLane | null {
  switch (reason) {
    case "red-ci":
      return "ci-fix";
    case "unanswered-comment":
      return "pr-feedback";
    case "unmerged-green":
      return null;
  }
}

/** The hidden trip marker for a first trip. */
export function buildStallRepairMarker(stall: BlockingPrStall): string {
  const reasons = stall.signals.map((s) => s.reason).join(",");
  return `${STALL_REPAIR_MARKER_PREFIX} pr="${stall.prNumber}" reasons="${reasons}" -->`;
}

/** The first-trip comment: the marker plus a one-line account. */
export function buildStallRepairComment(stall: BlockingPrStall): string {
  const lanes = lanesFor(stall).join(" and ");
  return [
    buildStallRepairMarker(stall),
    "🔧 **Stalled PR — syncing and rerunning its lane once**",
    "",
    `${stall.signals.map((s) => s.detail).join("; ")}. The worker is syncing ` +
    `this branch with its target and rerunning the ${lanes} lane once. If the ` +
    "PR is still stalled at the next check, it is closed and its originating " +
    "issue is redone.",
  ].join("\n");
}

function lanesFor(stall: BlockingPrStall): StallLane[] {
  const lanes: StallLane[] = [];
  for (const signal of stall.signals) {
    const lane = owningLane(signal.reason);
    if (lane !== null && !lanes.includes(lane)) lanes.push(lane);
  }
  return lanes;
}

/** What the PR thread says about earlier repairs. */
interface RepairHistory {
  /** Epoch seconds of the newest worker-authored trip marker. */
  tripAt?: number;
  /** True when the auto-fix cap has already given up on this PR. */
  capped: boolean;
}

function readRepairHistory(
  comments: readonly unknown[],
  workerAuthors: readonly string[],
): RepairHistory {
  const history: RepairHistory = { capped: false };
  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const comment = raw as Record<string, unknown>;
    const user = comment.user as Record<string, unknown> | null | undefined;
    const login = typeof user?.login === "string" ? user.login : "";
    // A marker anyone can post must not trip the ladder (Issue #1247).
    if (!login || !isFleetAuthor(login, [...workerAuthors])) continue;
    const body = typeof comment.body === "string" ? comment.body : "";
    if (body.includes(AUTO_FIX_CAP_MARKER_PREFIX)) history.capped = true;
    if (!body.includes(STALL_REPAIR_MARKER_PREFIX)) continue;
    const created = typeof comment.created_at === "string"
      ? Date.parse(comment.created_at)
      : NaN;
    if (!Number.isFinite(created)) continue;
    const at = Math.floor(created / 1000);
    if (history.tripAt === undefined || at > history.tripAt) {
      history.tripAt = at;
    }
  }
  return history;
}

/**
 * Repair one stalled PR: first trip, wait, or second trip.
 *
 * Never throws; a failure is logged loudly and returned as `failed`.
 */
export async function repairStalledPr(
  stall: BlockingPrStall,
  deps: StallRepairDeps,
): Promise<StallRepairAction> {
  const { repo, prNumber } = stall;
  const { logger } = deps;
  const where = { repo, pr: prNumber };

  const author = stall.author ?? "";
  if (!author || !isFleetAuthor(author, [...deps.workerAuthors])) {
    logger.info(
      "Stall repair: human-authored PR — logged and left alone",
      { ...where, author: author || "(unknown)" },
    );
    return "skipped-human-authored";
  }
  if (stall.mergeConflictLaneOwned === true) {
    logger.info(
      "Stall repair: the merge-conflict ladder owns this PR — left to it",
      where,
    );
    return "skipped-merge-conflict-lane";
  }
  if (!stall.headRefName || !stall.baseRefName) {
    logger.error("Stall repair: PR branches were not observed", where);
    return "failed";
  }
  const target: StallRepairTarget = {
    repo,
    prNumber,
    headRefName: stall.headRefName,
    baseRefName: stall.baseRefName,
  };

  const acquire = deps.acquireLease ??
    ((r: string, n: number) =>
      acquireMaintenanceRepoLease(r, n, { reserve: true }));
  const lease = acquire(repo, prNumber);
  if (lease === null) {
    logger.warn(
      "Stall repair deferred: the repository is leased elsewhere",
      where,
    );
    return "skipped-lease-held";
  }

  let lanesToRun: StallLane[] = [];
  let action: StallRepairAction;
  try {
    let comments: unknown[];
    try {
      comments = await fetchIssueCommentPages(repo, prNumber, deps.ghCommandFn);
    } catch (err) {
      logger.error("Stall repair: could not read the PR thread", {
        ...where,
        error: errorMessage(err),
      });
      return "failed";
    }
    const history = readRepairHistory(comments, deps.workerAuthors);
    const now = deps.nowSeconds();
    const secondTrip = history.capped ||
      (history.tripAt !== undefined &&
        now - history.tripAt >= deps.thresholdSeconds(repo));

    if (secondTrip) {
      action = await abandonStalledPr(stall, target, comments, deps);
    } else if (history.tripAt !== undefined) {
      logger.info(
        "Stall repair: first trip already taken — waiting for the next check",
        where,
      );
      action = "awaiting-second-check";
    } else {
      try {
        await deps.ghCommandFn([
          "pr",
          "comment",
          String(prNumber),
          "--repo",
          repo,
          "--body",
          buildStallRepairComment(stall),
        ]);
      } catch (err) {
        logger.error("Stall repair: could not record the first trip", {
          ...where,
          error: errorMessage(err),
        });
        return "failed";
      }
      const synced = await deps.syncBranch(target);
      if (!synced.ok) {
        // Loud, not fatal: the lane still gets its rerun, and a PR that
        // cannot be synced stays stalled for the second trip to settle.
        logger.warn("Stall repair: branch sync failed", {
          ...where,
          error: synced.error.message,
        });
      }
      lanesToRun = lanesFor(stall);
      action = "first-trip";
    }
  } finally {
    lease.release();
  }

  // The lanes take their own lease on this repository, so they run after
  // this pass has given its lease back.
  for (const lane of lanesToRun) {
    const ran = await deps.dispatchLane(target, lane);
    if (!ran.ok) {
      logger.warn("Stall repair: lane rerun failed", {
        ...where,
        lane,
        error: ran.error.message,
      });
    }
  }
  return action;
}

async function abandonStalledPr(
  stall: BlockingPrStall,
  target: StallRepairTarget,
  comments: readonly unknown[],
  deps: StallRepairDeps,
): Promise<StallRepairAction> {
  const detail = stall.signals
    .map((signal) => buildBlockingPrStallReason(stall, signal))
    .join(" ");
  const abandon = deps.abandon ?? abandonAndRestart;
  const outcome = await abandon(
    {
      repo: target.repo,
      prNumber: target.prNumber,
      branchName: target.headRefName,
      baseBranch: target.baseRefName,
      prComments: comments,
      reason: { kind: "stalled", detail: `has stalled: ${detail}` },
    },
    {
      gh: deps.ghCommandFn,
      trustedAuthors: deps.workerAuthors,
      logger: deps.logger,
      ...deps.abandonDeps,
    },
  );
  const where = { repo: target.repo, pr: target.prNumber };
  switch (outcome.outcome) {
    case "abandoned":
    case "closed-without-issue":
      deps.logger.warn("Stall repair: stalled PR abandoned", {
        ...where,
        outcome: outcome.outcome,
      });
      return "abandoned";
    case "declined":
      deps.logger.warn("Stall repair: abandon declined — PR left open", {
        ...where,
        reason: outcome.reason.kind,
      });
      return "abandon-declined";
    case "failed":
      deps.logger.error("Stall repair: abandon failed", {
        ...where,
        step: outcome.step,
        error: outcome.message,
      });
      return "failed";
  }
}

/** Options for {@link runStallRepairPass}. */
export interface StallRepairPassOptions extends ScanBlockingPrStallsOptions {
  /** Seams for each repair, minus what the scan options already carry. */
  repair: Omit<StallRepairDeps, "ghCommandFn" | "logger" | "thresholdSeconds">;
}

/**
 * One pass: scan blocking PRs for stalls, then repair each one. Green PRs are
 * handled by the scan itself (Issue #2801).
 */
export async function runStallRepairPass(
  opts: StallRepairPassOptions,
): Promise<
  Result<Array<{ stall: BlockingPrStall; action: StallRepairAction }>>
> {
  const scan = await scanBlockingPrStalls(opts);
  if (!scan.ok) return scan;
  const results: Array<{ stall: BlockingPrStall; action: StallRepairAction }> =
    [];
  for (const stall of scan.value) {
    const action = await repairStalledPr(stall, {
      ...opts.repair,
      ghCommandFn: opts.ghCommandFn,
      logger: opts.logger,
      thresholdSeconds: (repo) =>
        resolveBlockingPrStallThresholdSeconds(opts.config, repo),
    });
    results.push({ stall, action });
  }
  return { ok: true, value: results };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
