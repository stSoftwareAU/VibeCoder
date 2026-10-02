/**
 * The merge-conflict stall watchdog (Issue #3001, part of #2965).
 *
 * This is the **single 2-hour owner check** on a `merge-conflict` queue.
 * Earlier shapes of this module layered an 8-hour label-age stall on top of
 * the ladder's own per-head wait and a two-trip rerun-then-abandon sequence;
 * that duplicated the ladder's `CONFLICT_OWNER_CHECK_HOURS` wait (two hours,
 * `merge_conflict_markers.ts`) with a second, longer clock the ladder knew
 * nothing about. This module now **is** that clock, for every reason a PR can
 * go quiet, not just the ladder's.
 *
 * The clock starts at the LATEST of four events (see
 * {@link conflictStallClockStart}):
 *
 * - the `merge-conflict` label going on;
 * - the newest trusted stand-down (`readLatestStandDownAtMs`,
 *   `gated_head_guard.ts`) — the gated-head and park waits both write one;
 * - the newest trusted resolution attempt (`readResolutionAttempts`,
 *   `merge_conflict_markers.ts`) — any pass's attempt or conclusion marker;
 * - the PR's head moving (`headChangedAtMs`) — a fresh push is itself
 *   evidence something is happening.
 *
 * Two hours after the latest of those with nothing since, the queue has
 * stalled, and this watchdog **fixes forward**: while the shared
 * {@link CONFLICT_RESOLUTION_BUDGET} remains it runs the conflict takeover
 * pass (`conflict_takeover.ts`); once the budget is spent it closes the PR
 * and redoes its work through `abandonAndRestart`, using the **guarded**
 * `{ kind: "merge-conflict" }` reason — never `stalled`, which is exempt from
 * the budget guard and belongs to a different caller.
 *
 * A PR parked on an unmoved base tip (Issue #2312) is not escalated — but
 * only while the budget remains. A parked PR whose budget is spent still
 * trips: parking defers a decision the fleet can still act on, not one it has
 * run out of road for.
 *
 * Two invariants this module keeps, carried over unchanged:
 *
 * - **It never applies `needs-human` itself.** Only `abandonAndRestart`'s own
 *   restarts-spent hand-off does, once an issue's redos are exhausted
 *   (Issue #2804) — applying it here would remove the PR from the very lane
 *   that could still clear it (Issue #569).
 * - **It files no issue and adds no label of its own** (Issue #2803). A
 *   stall is repaired, not reported.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { RepoLoopQuotaStop } from "./repo_loop_quota_stop.ts";
import type { Logger } from "../types.ts";
import {
  abandonAndRestart,
  type AbandonRestartDeps,
  type AbandonRestartOutcome,
  type AbandonRestartRequest,
} from "./conflict_abandon_restart.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { getLabelLastAddInfoComplete } from "./issue_query.ts";
import {
  acquireMaintenanceRepoLease,
  type RepoLease,
} from "./maintenance_lane.ts";
import {
  type ConflictPrDecision,
  conflictPrKey,
  conflictReasonOperands,
  type ConflictSkipReason,
  MERGE_CONFLICT_LABEL,
} from "./pr_merge_conflict_scan.ts";
import {
  CONFLICT_FAILED_MARKER,
  CONFLICT_OWNER_CHECK_HOURS,
  CONFLICT_RESOLUTION_BUDGET,
  CONFLICT_RESOLVED_MARKER,
  isConflictHeadSha,
  readParkedBase,
  readResolutionAttempts,
  spentConflictAttempts,
} from "./merge_conflict_markers.ts";
import { readLatestStandDownAtMs } from "./gated_head_guard.ts";
import {
  type ConflictTakeoverDeps,
  type ConflictTakeoverOutcome,
  type ConflictTakeoverPr,
  runConflictTakeover,
} from "./conflict_takeover.ts";
import type { TimelineCache } from "./timeline_cache.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Label whose presence means a human already owns the PR. */
const NEEDS_HUMAN_LABEL = "needs-human";

/** The only `mergeable` state that is a merge-conflict queue. */
const CONFLICTING_STATE = "CONFLICTING";

/** The 2-hour owner-check window, in milliseconds. */
const OWNER_CHECK_WINDOW_MS = CONFLICT_OWNER_CHECK_HOURS * 3600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the watchdog needs to know about one labelled PR. */
export interface ConflictStallObservation {
  /** Repository in `owner/repo` form. */
  repo: string;
  prNumber: number;
  /** Label names currently on the PR. */
  labels: readonly string[];
  /**
   * Epoch milliseconds of the most recent `merge-conflict` `labeled` event.
   * Absent when the timeline could not be read — the age is then unknown, and
   * an unknown age is never reported as a stall.
   */
  labelledAtMs?: number;
  /** Raw comment objects from the GitHub REST API, oldest first. */
  comments: readonly unknown[];
  /** Skip reasons this cycle recorded for the PR (Issue #1109). */
  skipReasons?: readonly ConflictSkipReason[];
  /** True when the PR is closed — nothing is queued behind it. */
  closed?: boolean;
  /**
   * GitHub's live `mergeable` state. Only `CONFLICTING` is a queue at all:
   * the label is not removed when a conflict clears by other means, so a
   * labelled PR that now merges cleanly is a **stale label**, not a stall —
   * the lesson `docs/workflows/merge-conflicts.md` draws from #116 in as many
   * words. Absent or `UNKNOWN` means the state was not established, and an
   * unestablished state is never escalated.
   */
  mergeableState?: string;
  /**
   * The base branch's tip sha (Issue #2312). Compared against the park
   * marker's own base: a parked PR is not a stall while its base has not
   * moved and the shared budget is not spent. Absent means the listing did
   * not carry one, and an unknown base can never match a park — the stall is
   * then judged the ordinary way.
   */
  baseRefOid?: string;
  /** The PR's live head sha, lowercased comparisons are the caller's job. */
  headRefOid?: string;
  /**
   * Epoch milliseconds the head last changed, when known. Absent means
   * unknown — never treated as "just now" or "never", simply left out of the
   * clock-start computation.
   */
  headChangedAtMs?: number;
}

/** A merge-conflict queue that has stopped moving on one PR. */
export interface ConflictQueueStall {
  repo: string;
  prNumber: number;
  /** Epoch milliseconds the label was applied. */
  labelledAtMs: number;
  /** How long the label has been on, in milliseconds. */
  labelAgeMs: number;
  /** Epoch milliseconds the stall clock started (the latest of four events). */
  stalledSinceMs: number;
  /** How long nothing has happened, in milliseconds. */
  stalledMs: number;
  /** Which of the four events started the clock. */
  clockStart: "label" | "stand-down" | "attempt" | "head-change";
  /** Epoch milliseconds of the newest trusted stand-down, when there was one. */
  standDownAtMs?: number;
  /** Epoch milliseconds of the newest trusted resolution attempt, when there was one. */
  lastAttemptAtMs?: number;
  /** Epoch milliseconds the head last changed, when known. */
  headChangedAtMs?: number;
  /** The PR's live head sha, when known. */
  headRefOid?: string;
  /** Failed attempts spent against the shared budget (Issue #2996). */
  attemptsSpent: number;
  /** True once {@link CONFLICT_RESOLUTION_BUDGET} is exhausted. */
  budgetSpent: boolean;
  /**
   * True when an attempt opened and never concluded — the disrupted case. It
   * is still a stall: nothing is moving the PR either way.
   */
  openAttempt: boolean;
  /** Skip reasons recorded for the PR this cycle (Issue #1109). */
  skipReasons: readonly ConflictSkipReason[];
}

/** Options for {@link detectConflictQueueStall}. */
export interface DetectConflictStallOptions {
  /** Current time, epoch milliseconds. */
  nowMs: number;
  /** Whether a comment author is one of the fleet's own. */
  isTrustedAuthor: (login: string) => boolean;
  /** Label meaning a human owns the PR. Defaults to `needs-human`. */
  needsHumanLabel?: string;
}

// ---------------------------------------------------------------------------
// Detection (pure)
// ---------------------------------------------------------------------------

/** The `user.login` a raw REST comment object carries, when it carries one. */
function commentAuthor(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const login = (raw as { user?: { login?: unknown } }).user?.login;
  return typeof login === "string" && login.trim().length > 0
    ? login.trim()
    : undefined;
}

/** Epoch milliseconds of a raw comment's `created_at`, when it parses. */
function commentCreatedAtMs(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const createdAt = (raw as { created_at?: unknown }).created_at;
  if (typeof createdAt !== "string") return undefined;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The comment body, when it has one. */
function commentBody(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = (raw as { body?: unknown }).body;
  return typeof body === "string" ? body : undefined;
}

/**
 * The newest trusted park marker's base, since the label, cleared by a later
 * trusted resolved/failed conclusion (Issue #2312).
 *
 * A park is the opposite of the silence this watchdog looks for — it is the
 * record that says *why* nothing is happening — so it suppresses the stall,
 * but only while nothing has concluded since. A conclusion means the PR was
 * un-parked and worked on, so the park no longer describes what is happening.
 *
 * @param comments - Raw REST comment objects, oldest first.
 * @param sinceMs - The label event; comments older than it belong to a
 *   previous conflict and say nothing about this one.
 */
function readParkedBaseSince(
  comments: readonly unknown[],
  sinceMs: number,
  isTrustedAuthor: (login: string) => boolean,
): string | undefined {
  let parkedBase: string | undefined;
  for (const raw of comments) {
    const body = commentBody(raw);
    if (body === undefined) continue;
    const createdAtMs = commentCreatedAtMs(raw);
    if (createdAtMs === undefined || createdAtMs < sinceMs) continue;
    const author = commentAuthor(raw);
    if (author === undefined || !isTrustedAuthor(author)) continue;

    if (
      body.includes(CONFLICT_RESOLVED_MARKER) ||
      body.includes(CONFLICT_FAILED_MARKER)
    ) {
      parkedBase = undefined;
      continue;
    }
    // Read through the marker module rather than by substring: the base sha
    // is the whole signal, and a marker whose sha cannot be read must not
    // park the watchdog on a value nothing can ever match (Issue #2312).
    const park = readParkedBase([raw]);
    if (park !== null) parkedBase = park.base;
  }
  return parkedBase;
}

/** What {@link conflictStallClockStart} found started the clock. */
export interface ConflictStallClockStart {
  /** Epoch milliseconds the clock starts counting from. */
  startMs: number;
  /** Which event was latest. */
  cause: "label" | "stand-down" | "attempt" | "head-change";
  /** The newest trusted stand-down's time, when there was one. */
  standDownAtMs?: number;
  /** The newest trusted resolution attempt's time, when there was one. */
  lastAttemptAtMs?: number;
}

/**
 * The stall clock's start: the LATEST of the label event, the newest trusted
 * stand-down, the newest trusted resolution attempt, and the head's last
 * change — shared by {@link detectConflictQueueStall} and the under-lease
 * re-check in {@link repairConflictQueueStall} so both agree on when the
 * clock last reset.
 *
 * A `headChangedAtMs` that is not finite or that lies in the future
 * (`> nowMs`) is ignored — a future-dated commit (clock skew, a forged
 * timestamp) must not postpone the trip forever. This watchdog fails towards
 * acting, never towards silence.
 *
 * @param comments - Raw REST comment objects, oldest first.
 * @param labelledAtMs - Epoch milliseconds the `merge-conflict` label went on.
 * @param headChangedAtMs - Epoch milliseconds the head last changed, when
 *   known.
 * @param nowMs - Current time, epoch milliseconds.
 * @param isTrustedAuthor - Predicate a comment's `user.login` must pass for
 *   its marker to move the clock at all — a forged marker must not buy
 *   silence.
 */
export function conflictStallClockStart(
  comments: readonly unknown[],
  labelledAtMs: number,
  headChangedAtMs: number | undefined,
  nowMs: number,
  isTrustedAuthor: (login: string) => boolean,
): ConflictStallClockStart {
  const standDownAtMs = readLatestStandDownAtMs(comments, isTrustedAuthor);
  const attempts = readResolutionAttempts(comments, isTrustedAuthor);
  let lastAttemptAtMs: number | undefined;
  for (const attempt of attempts) {
    if (attempt.atMs === undefined) continue;
    if (lastAttemptAtMs === undefined || attempt.atMs > lastAttemptAtMs) {
      lastAttemptAtMs = attempt.atMs;
    }
  }
  const validHeadChangedAtMs =
    headChangedAtMs !== undefined && Number.isFinite(headChangedAtMs) &&
      headChangedAtMs <= nowMs
      ? headChangedAtMs
      : undefined;

  let startMs = labelledAtMs;
  let cause: ConflictStallClockStart["cause"] = "label";
  if (standDownAtMs !== undefined && standDownAtMs > startMs) {
    startMs = standDownAtMs;
    cause = "stand-down";
  }
  if (lastAttemptAtMs !== undefined && lastAttemptAtMs > startMs) {
    startMs = lastAttemptAtMs;
    cause = "attempt";
  }
  if (validHeadChangedAtMs !== undefined && validHeadChangedAtMs > startMs) {
    startMs = validHeadChangedAtMs;
    cause = "head-change";
  }

  return {
    startMs,
    cause,
    ...(standDownAtMs !== undefined ? { standDownAtMs } : {}),
    ...(lastAttemptAtMs !== undefined ? { lastAttemptAtMs } : {}),
  };
}

/**
 * Decide whether one labelled PR's queue has stalled.
 *
 * Returns `null` for every PR that is legitimately not a stall: parked behind
 * `needs-human`, closed, not in the queue at all, of unknown label age, inside
 * the {@link CONFLICT_OWNER_CHECK_HOURS} window, moved by a trusted stand-down
 * / attempt / head change, or parked on an unmoved base tip while the shared
 * budget remains (Issue #2312).
 *
 * An attempt that opened and never concluded still counts as a stall — the
 * disruption bound has not fired either, so nothing is moving the PR.
 */
export function detectConflictQueueStall(
  observation: ConflictStallObservation,
  options: DetectConflictStallOptions,
): ConflictQueueStall | null {
  const {
    nowMs,
    isTrustedAuthor,
    needsHumanLabel = NEEDS_HUMAN_LABEL,
  } = options;

  if (observation.closed === true) return null;
  if (!observation.labels.includes(MERGE_CONFLICT_LABEL)) return null;
  // Read the live state, never the label: a label left behind by a conflict
  // that cleared is the expected shape once the base moves on, and escalating
  // it would report a queue that does not exist.
  if (observation.mergeableState !== CONFLICTING_STATE) return null;
  // A human already owns it; this watchdog never overrides that.
  if (observation.labels.includes(needsHumanLabel)) return null;

  const labelledAtMs = observation.labelledAtMs;
  if (labelledAtMs === undefined || !Number.isFinite(labelledAtMs)) return null;

  const labelAgeMs = nowMs - labelledAtMs;
  // The clock can never start before the label, so a label inside the window
  // is not a stall whatever the thread says — and the caller may skip reading
  // the thread at all on the strength of it.
  if (labelAgeMs < OWNER_CHECK_WINDOW_MS) return null;

  const attempts = readResolutionAttempts(
    observation.comments,
    isTrustedAuthor,
  );
  const attemptsSpent = spentConflictAttempts(attempts);
  const budgetSpent = attemptsSpent >= CONFLICT_RESOLUTION_BUDGET;

  // Issue #2312: a parked PR is not a stalled one, but only while the shared
  // budget remains — a parked PR with the budget spent has nowhere left to
  // park, and still trips.
  if (!budgetSpent) {
    const parkedBase = readParkedBaseSince(
      observation.comments,
      labelledAtMs,
      isTrustedAuthor,
    );
    if (
      parkedBase !== undefined &&
      parkedBase === observation.baseRefOid?.trim().toLowerCase()
    ) {
      return null;
    }
  }

  const clock = conflictStallClockStart(
    observation.comments,
    labelledAtMs,
    observation.headChangedAtMs,
    nowMs,
    isTrustedAuthor,
  );
  const stalledMs = nowMs - clock.startMs;
  if (stalledMs < OWNER_CHECK_WINDOW_MS) return null;

  const lastAttempt = attempts[attempts.length - 1];

  return {
    repo: observation.repo,
    prNumber: observation.prNumber,
    labelledAtMs,
    labelAgeMs,
    stalledSinceMs: clock.startMs,
    stalledMs,
    clockStart: clock.cause,
    ...(clock.standDownAtMs !== undefined
      ? { standDownAtMs: clock.standDownAtMs }
      : {}),
    ...(clock.lastAttemptAtMs !== undefined
      ? { lastAttemptAtMs: clock.lastAttemptAtMs }
      : {}),
    ...(observation.headChangedAtMs !== undefined
      ? { headChangedAtMs: observation.headChangedAtMs }
      : {}),
    ...(observation.headRefOid !== undefined
      ? { headRefOid: observation.headRefOid }
      : {}),
    attemptsSpent,
    budgetSpent,
    openAttempt: lastAttempt?.outcome === "open",
    skipReasons: observation.skipReasons ?? [],
  };
}

// ---------------------------------------------------------------------------
// Repair — fix forward (Issue #3001)
// ---------------------------------------------------------------------------

/** Injected seams for {@link repairConflictQueueStall}. */
export interface ConflictStallRepairDeps {
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
  /**
   * Fleet logins handed to `abandonAndRestart`, which declines on an empty
   * list rather than trust a forged thread.
   */
  trustedAuthors?: readonly string[];
  /** Maintenance-lane lease. Defaults to the reserving repo lease. */
  acquireLease?: (repo: string, prNumber: number) => RepoLease | null;
  /** The abandon-and-redo rung. Injected by tests. */
  abandon?: (
    request: AbandonRestartRequest,
    deps: AbandonRestartDeps,
  ) => Promise<AbandonRestartOutcome>;
  /** Extra seams passed through to `abandonAndRestart`. */
  abandonDeps?: Partial<AbandonRestartDeps>;
  /**
   * The two resolvers `runConflictTakeover` needs — production wires these in
   * `run_core_production_deps.ts`. Undefined with the budget still remaining
   * is a configuration error, not a silent skip.
   */
  takeoverResolvers?: Pick<
    ConflictTakeoverDeps,
    "resolveViaLadder" | "resolveOnFixBranch"
  >;
  /** The takeover run itself. Defaults to {@link runConflictTakeover}; injected by tests. */
  takeover?: (
    pr: ConflictTakeoverPr,
    deps: ConflictTakeoverDeps,
  ) => Promise<ConflictTakeoverOutcome>;
}

/** What {@link repairConflictQueueStall} did. */
export type ConflictStallRepairAction =
  | "skipped-lease-held"
  | "no-longer-stalled"
  | "taken-over"
  | "takeover-declined"
  | "abandoned"
  | "abandon-declined"
  | "failed";

/** Everything {@link repairConflictQueueStall} needs beyond its seams. */
export interface ConflictStallRepairOptions extends ConflictStallRepairDeps {
  /** Whether a comment author is one of the fleet's own. */
  isTrustedAuthor: (login: string) => boolean;
  /** Current time, epoch milliseconds. */
  nowMs: number;
}

/**
 * Repair a stalled queue by fixing it forward (Issue #3001).
 *
 * Under the maintenance lease, re-reads the PR's thread and live head sha: if
 * the head has moved since detection, or the clock recomputed from the fresh
 * thread no longer clears the owner-check window, another host already acted
 * and this call reports `"no-longer-stalled"` rather than double up.
 *
 * While the shared {@link CONFLICT_RESOLUTION_BUDGET} remains, it runs the
 * conflict takeover pass (`conflict_takeover.ts`) — the takeover's own
 * attempt marker is what re-arms this clock, so no separate trip marker is
 * needed. Once the budget is spent, it closes the PR and redoes its work
 * through `abandonAndRestart`, using the **guarded** `{ kind: "merge-conflict" }`
 * reason, which the shared budget still bounds — never `stalled`, which is
 * exempt from that guard.
 *
 * It never applies `needs-human` itself — only `abandonAndRestart`'s own
 * restarts-spent hand-off does — and it files no issue and adds no label of
 * its own. It never throws: every failure is logged and reported as
 * `"failed"`, and the next pass retries.
 */
export async function repairConflictQueueStall(
  stall: ConflictQueueStall,
  options: ConflictStallRepairOptions,
): Promise<ConflictStallRepairAction> {
  const { ghCommandFn, logger, isTrustedAuthor } = options;
  const { repo, prNumber } = stall;
  const acquire = options.acquireLease ??
    ((r: string, n: number) =>
      acquireMaintenanceRepoLease(r, n, { reserve: true }));
  const lease = acquire(repo, prNumber);
  if (lease === null) {
    logger.warn(
      "Merge-conflict stall repair: maintenance lease held — retrying next pass",
      { repo, prNumber },
    );
    return "skipped-lease-held";
  }

  try {
    // Re-read under the lease: another pass may have acted since detection.
    const comments = await fetchIssueCommentPages(repo, prNumber, ghCommandFn);
    const view = JSON.parse(
      await ghCommandFn([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "headRefName,baseRefName,headRefOid",
      ]),
    ) as { headRefName?: unknown; baseRefName?: unknown; headRefOid?: unknown };
    if (
      typeof view.headRefName !== "string" ||
      typeof view.baseRefName !== "string" ||
      typeof view.headRefOid !== "string"
    ) {
      throw new Error(
        "`gh pr view` returned no head branch, base branch or head sha",
      );
    }

    if (
      stall.headRefOid !== undefined &&
      stall.headRefOid.trim().toLowerCase() !==
        view.headRefOid.trim().toLowerCase()
    ) {
      logger.info(
        "Merge-conflict stall repair: the head moved since detection — " +
          "no longer stalled",
        { repo, prNumber },
      );
      return "no-longer-stalled";
    }

    const clock = conflictStallClockStart(
      comments,
      stall.labelledAtMs,
      stall.headChangedAtMs,
      options.nowMs,
      isTrustedAuthor,
    );
    if (options.nowMs - clock.startMs < OWNER_CHECK_WINDOW_MS) {
      logger.info(
        "Merge-conflict stall repair: another host already acted — " +
          "no longer stalled",
        { repo, prNumber },
      );
      return "no-longer-stalled";
    }

    const attempts = readResolutionAttempts(comments, isTrustedAuthor);
    const attemptsSpent = spentConflictAttempts(attempts);
    const budgetSpent = attemptsSpent >= CONFLICT_RESOLUTION_BUDGET;

    if (!budgetSpent) {
      if (options.takeoverResolvers === undefined) {
        throw new Error(
          "repairConflictQueueStall: the shared budget remains but no " +
            "takeoverResolvers were injected — refusing to silently skip " +
            `the takeover for ${repo}#${prNumber}`,
        );
      }
      const takeover = options.takeover ?? runConflictTakeover;
      const outcome = await takeover(
        {
          repo,
          number: prNumber,
          headRefName: view.headRefName,
          baseRefName: view.baseRefName,
          headSha: view.headRefOid,
        },
        {
          gh: ghCommandFn,
          trustedAuthors: [...(options.trustedAuthors ?? [])],
          logger,
          ...options.takeoverResolvers,
        },
      );
      if (outcome.kind === "declined-budget") {
        logger.warn("Merge-conflict stall repair: takeover declined", {
          repo,
          prNumber,
          attemptsSpent: outcome.attemptsSpent,
        });
        return "takeover-declined";
      }
      logger.info("Merge-conflict stall repair: took the conflict over", {
        repo,
        prNumber,
        outcome: outcome.kind,
      });
      return "taken-over";
    }

    const abandon = options.abandon ?? abandonAndRestart;
    const outcome = await abandon(
      {
        repo,
        prNumber,
        branchName: view.headRefName,
        baseBranch: view.baseRefName,
        prComments: comments,
        reason: { kind: "merge-conflict" },
      },
      {
        gh: ghCommandFn,
        trustedAuthors: [...(options.trustedAuthors ?? [])],
        logger,
        ...options.abandonDeps,
      },
    );
    switch (outcome.outcome) {
      case "abandoned":
      case "closed-without-issue":
        logger.warn(
          "Merge-conflict queue still stalled with its budget spent — " +
            "abandoned and redone",
          { repo, prNumber, outcome: outcome.outcome },
        );
        return "abandoned";
      case "declined":
        logger.warn("Merge-conflict stall repair: abandon declined", {
          repo,
          prNumber,
          reason: outcome.reason,
        });
        return "abandon-declined";
      case "failed":
        logger.error("Merge-conflict stall repair: abandon failed", {
          repo,
          prNumber,
          step: outcome.step,
          error: outcome.message,
        });
        return "failed";
    }
  } catch (error) {
    logger.error("Merge-conflict stall repair failed", {
      repo,
      prNumber,
      error: errorMessage(error),
    });
    return "failed";
  } finally {
    lease.release();
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** Options for {@link scanConflictQueueStalls}. */
export interface ConflictStallScanOptions extends ConflictStallRepairDeps {
  /** Monitored repos in `owner/repo` form. */
  repos: readonly string[];
  /** Whether a comment author is one of the fleet's own. */
  isTrustedAuthor: (login: string) => boolean;
  /** Clock override (epoch milliseconds). */
  nowMs?: () => number;
  /** Label meaning a human owns the PR. Defaults to `needs-human`. */
  needsHumanLabel?: string;
  /** This cycle's per-PR decisions, so the comment can name them (#1109). */
  decisions?: readonly ConflictPrDecision[];
  /** Allowlist check for a repo. */
  isRepoAllowed?: (repo: string) => boolean;
  /** Shared timeline cache, when the caller keeps one. */
  timelineCache?: TimelineCache;
  /**
   * The open-PR listing the scan already holds for a repository, with labels
   * (Issue #2409).
   *
   * Without it this watchdog cost one GraphQL call per monitored repository
   * on **every cycle** — `20×[pr list --json --label --repo --state]` every
   * ~3 minutes, per host, almost always to learn "none" — and the fleet was
   * spending its hourly GitHub quota in ~25 minutes. The stall window is
   * {@link CONFLICT_OWNER_CHECK_HOURS} hours, so learning that a PR gained
   * the label one cache lifetime late costs nothing.
   *
   * It is only a **gate**. When it shows a labelled PR the live listing is
   * still taken, because the merge state and base tip the watchdog acts on
   * must be current. And it can only prove absence when it is complete: a
   * listing that came back full ({@link openPrListingLimit} rows) or cannot be
   * read falls through to the live listing, so nothing the old path found can
   * be missed.
   */
  listOpenPrLabels?: (repo: string) => Promise<readonly ListedOpenPr[]>;
  /** Rows at which {@link listOpenPrLabels} is treated as truncated. */
  openPrListingLimit?: number;
}

/** One row of the scan's open-PR listing, as far as this watchdog reads it. */
export interface ListedOpenPr {
  number: number;
  labels: readonly string[];
}

/**
 * Narrow the scan's open-PR rows to what the gate reads, refusing a listing
 * that cannot answer (Issue #2409).
 *
 * A cache entry written before the listing asked for labels has rows with no
 * `labels` field. Reading that as "no labels" would let the gate prove an
 * absence it never looked for, so it throws instead — which the gate treats
 * like any unreadable listing, and takes the live one.
 *
 * @param prs - Rows from `fetchAllOpenPRs`
 * @throws When any row carries no `labels` field
 */
export function listedOpenPrs(
  prs: readonly { number: number; labels?: readonly string[] }[],
): ListedOpenPr[] {
  return prs.map((pr) => {
    if (pr.labels === undefined) {
      throw new Error(
        `open-PR listing row #${pr.number} carries no labels field — the ` +
          `listing predates Issue #2409 and cannot answer`,
      );
    }
    return { number: pr.number, labels: pr.labels };
  });
}

/** The scan lists up to this many open PRs per repository. */
const DEFAULT_OPEN_PR_LISTING_LIMIT = 50;

/**
 * Does the scan's own listing prove this repository has no labelled open PR?
 *
 * `true` only for a readable, complete listing in which no PR carries the
 * label. Anything else — none supplied, unreadable, full, or a labelled PR in
 * it — is `false`, and the caller takes the live listing.
 */
async function cachedListingProvesNoneLabelled(
  repo: string,
  options: Pick<
    ConflictStallScanOptions,
    "listOpenPrLabels" | "openPrListingLimit" | "logger"
  >,
): Promise<boolean> {
  if (!options.listOpenPrLabels) return false;
  let listed: readonly ListedOpenPr[];
  try {
    listed = await options.listOpenPrLabels(repo);
  } catch (error) {
    options.logger.warn(
      "Merge-conflict stall watchdog: the scan's PR listing could not be read — listing live (Issue #2409)",
      { repo, error: errorMessage(error) },
    );
    return false;
  }
  const limit = options.openPrListingLimit ?? DEFAULT_OPEN_PR_LISTING_LIMIT;
  if (listed.length >= limit) return false;
  return !listed.some((pr) => pr.labels.includes(MERGE_CONFLICT_LABEL));
}

/** A PR the label listing returned. */
interface LabelledPr {
  number: number;
  labels: string[];
  mergeableState?: string;
  /** The base tip, for the park comparison (Issue #2312). */
  baseRefOid?: string;
  /** The PR's live head sha, for the clock-start computation. */
  headRefOid?: string;
}

/**
 * Fields the label listing asks for — the live state rides along with it,
 * and so do the base tip a park marker is compared against (Issue #2312) and
 * the head sha the clock-start computation reads a commit date for.
 */
const STALL_PR_FIELDS = "number,labels,mergeable,baseRefOid,headRefOid";

/** Parse `gh pr list --json number,labels,mergeable,baseRefOid,headRefOid` output. */
function parseLabelledPrs(raw: string): LabelledPr[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) return [];
  const prs: LabelledPr[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as {
      number?: unknown;
      labels?: unknown;
      mergeable?: unknown;
      baseRefOid?: unknown;
      headRefOid?: unknown;
    };
    if (typeof record.number !== "number") continue;
    const labels: string[] = [];
    if (Array.isArray(record.labels)) {
      for (const label of record.labels) {
        const name = typeof label === "object" && label !== null
          ? (label as { name?: unknown }).name
          : label;
        if (typeof name === "string" && name.length > 0) labels.push(name);
      }
    }
    prs.push({
      number: record.number,
      labels,
      ...(typeof record.mergeable === "string"
        ? { mergeableState: record.mergeable.toUpperCase() }
        : {}),
      ...(typeof record.baseRefOid === "string" && record.baseRefOid.length > 0
        ? { baseRefOid: record.baseRefOid }
        : {}),
      ...(typeof record.headRefOid === "string" && record.headRefOid.length > 0
        ? { headRefOid: record.headRefOid }
        : {}),
    });
  }
  return prs;
}

/**
 * The distinct skip reasons this cycle recorded for one PR (Issue #1109).
 *
 * The drain calls the scan once per PR it takes, so a PR held back by the same
 * cooldown is decided on several times in one cycle. Identical reasons are
 * collapsed: the comment is public, and five copies of one line say no more
 * than one does.
 */
function skipReasonsFor(
  decisions: readonly ConflictPrDecision[] | undefined,
  repo: string,
  prNumber: number,
): ConflictSkipReason[] {
  if (!decisions) return [];
  const key = conflictPrKey(repo, prNumber);
  const seen = new Set<string>();
  const reasons: ConflictSkipReason[] = [];
  for (const decision of decisions) {
    if (decision.outcome !== "skipped") continue;
    if (conflictPrKey(decision.repo, decision.prNumber) !== key) continue;
    const fingerprint = JSON.stringify([
      decision.reason.kind,
      conflictReasonOperands(decision.reason),
    ]);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    reasons.push(decision.reason);
  }
  return reasons;
}

/**
 * Establish the live `mergeable` state for one labelled PR.
 *
 * GitHub computes mergeability lazily, so a listing can answer `UNKNOWN` for a
 * PR it has not got to yet. Falling straight through on that would drop the
 * stalled PR in silence — the very failure this watchdog exists to remove — so
 * the state is asked for again per PR, exactly as the conflict scan's REST
 * fallback does, and an answer that still cannot be established is said out
 * loud rather than assumed benign.
 *
 * @returns The state, or `undefined` when it could not be established.
 */
async function resolveMergeableState(
  repo: string,
  pr: LabelledPr,
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: Logger,
): Promise<string | undefined> {
  if (pr.mergeableState !== undefined && pr.mergeableState !== "UNKNOWN") {
    return pr.mergeableState;
  }
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(pr.number),
      "--repo",
      repo,
      "--json",
      "mergeable",
      "--jq",
      ".mergeable",
    ]);
    const state = raw.trim().toUpperCase();
    if (state.length > 0 && state !== "UNKNOWN") return state;
  } catch (error) {
    logger.warn(
      "Merge-conflict stall watchdog: mergeable lookup failed — a labelled " +
        "PR is being left unchecked",
      { repo, prNumber: pr.number, error: errorMessage(error) },
    );
    return undefined;
  }
  logger.warn(
    "Merge-conflict stall watchdog: GitHub has not computed a labelled PR's " +
      "mergeable state — it is left unchecked this pass",
    { repo, prNumber: pr.number },
  );
  return undefined;
}

/**
 * The epoch ms a commit's own committer date, read via `gh api`, or
 * `undefined` when it could not be read or parsed.
 *
 * A failure here must never suppress the watchdog — it fails towards acting,
 * not towards silence — so the caller leaves `headChangedAtMs` unset and the
 * clock still starts from whichever other event is latest.
 */
async function commitCommittedAtMs(
  repo: string,
  sha: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: Logger,
): Promise<number | undefined> {
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/commits/${sha}`,
      "--jq",
      ".commit.committer.date",
    ]);
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
    logger.warn(
      "Merge-conflict stall watchdog: head commit date did not parse — " +
        "head-change is left unknown this pass",
      { repo, sha, raw: raw.trim() },
    );
    return undefined;
  } catch (error) {
    logger.warn(
      "Merge-conflict stall watchdog: head commit date could not be read — " +
        "head-change is left unknown this pass",
      { repo, sha, error: errorMessage(error) },
    );
    return undefined;
  }
}

/**
 * One pass: every open PR carrying `merge-conflict`, checked against the
 * 2-hour owner-check window and fixed forward if it has stalled.
 *
 * Best-effort per repository and per PR — a listing or a lookup that fails is
 * logged loudly and the pass continues, because a watchdog must never be the
 * reason the cycle stops. It reads only PRs that already carry the label, so
 * a fleet with an empty queue costs one listing per repository.
 *
 * @returns Every stall detected this pass, repaired or not.
 */
export async function scanConflictQueueStalls(
  options: ConflictStallScanOptions,
): Promise<ConflictQueueStall[]> {
  const {
    repos,
    ghCommandFn,
    logger,
    isTrustedAuthor,
    nowMs = () => Date.now(),
    needsHumanLabel,
    decisions,
    isRepoAllowed,
    timelineCache,
  } = options;

  const now = nowMs();
  const stalls: ConflictQueueStall[] = [];
  // Issue #1515: one quota exhaustion is one line, not one per repository.
  const quota = new RepoLoopQuotaStop(
    "Merge-conflict stall watchdog",
    repos.length,
    (message) => logger.warn(message),
  );

  for (const repo of repos) {
    if (quota.latchedBeforeRepo()) break;
    if (isRepoAllowed && !isRepoAllowed(repo)) {
      quota.repoDone();
      continue;
    }

    if (await cachedListingProvesNoneLabelled(repo, options)) {
      quota.repoDone();
      continue;
    }

    let labelled: LabelledPr[];
    try {
      labelled = parseLabelledPrs(
        await ghCommandFn([
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--label",
          MERGE_CONFLICT_LABEL,
          "--json",
          STALL_PR_FIELDS,
        ]),
      );
    } catch (error) {
      if (quota.isQuotaFailure(error)) break;
      logger.warn(
        "Merge-conflict stall watchdog: failed to list labelled PRs",
        {
          repo,
          error: errorMessage(error),
        },
      );
      quota.repoDone();
      continue;
    }

    for (const pr of labelled) {
      const mergeableState = await resolveMergeableState(
        repo,
        pr,
        ghCommandFn,
        logger,
      );
      // A labelled PR that now merges cleanly is a stale label, not a stall,
      // and it is skipped before it costs a timeline or a comment read.
      if (mergeableState !== CONFLICTING_STATE) {
        if (mergeableState !== undefined) {
          logger.debug(
            "Merge-conflict stall watchdog: labelled PR is not conflicting",
            { repo, prNumber: pr.number, mergeableState },
          );
        }
        continue;
      }

      let observation: ConflictStallObservation;
      try {
        // The exhaustive timeline read, not the page-1 one: this decision is
        // acted on with a public comment naming a duration, so it must use
        // the genuinely most-recent `labeled` event (Issue #3709).
        const lastAdd = await getLabelLastAddInfoComplete(
          repo,
          pr.number,
          MERGE_CONFLICT_LABEL,
          ghCommandFn,
          timelineCache,
        );
        const labelledAtMs = lastAdd === null
          ? undefined
          : lastAdd.addedAt * 1000;
        // The stall clock can never start before the label, so a label inside
        // the window cannot be a stall — and the thread, which is the
        // expensive read, is never fetched for one.
        if (
          labelledAtMs !== undefined &&
          now - labelledAtMs < OWNER_CHECK_WINDOW_MS
        ) {
          continue;
        }

        let headChangedAtMs: number | undefined;
        const headRefOid = pr.headRefOid?.trim().toLowerCase();
        if (headRefOid !== undefined && isConflictHeadSha(headRefOid)) {
          headChangedAtMs = await commitCommittedAtMs(
            repo,
            headRefOid,
            ghCommandFn,
            logger,
          );
        }

        observation = {
          repo,
          prNumber: pr.number,
          labels: pr.labels,
          mergeableState,
          ...(pr.baseRefOid !== undefined ? { baseRefOid: pr.baseRefOid } : {}),
          ...(headRefOid !== undefined ? { headRefOid } : {}),
          ...(headChangedAtMs !== undefined ? { headChangedAtMs } : {}),
          ...(labelledAtMs !== undefined ? { labelledAtMs } : {}),
          comments: await fetchIssueCommentPages(repo, pr.number, ghCommandFn),
          skipReasons: skipReasonsFor(decisions, repo, pr.number),
        };
      } catch (error) {
        logger.warn("Merge-conflict stall watchdog: could not read a PR", {
          repo,
          prNumber: pr.number,
          error: errorMessage(error),
        });
        continue;
      }

      if (observation.labelledAtMs === undefined) {
        logger.warn(
          "Merge-conflict stall watchdog: no `labeled` event for the queue " +
            "label — the label age is unknown, so no stall is reported",
          { repo, prNumber: pr.number },
        );
        continue;
      }

      const stall = detectConflictQueueStall(observation, {
        nowMs: now,
        isTrustedAuthor,
        ...(needsHumanLabel !== undefined ? { needsHumanLabel } : {}),
      });
      if (stall === null) continue;
      stalls.push(stall);

      // Never throws — it logs its own outcome, and the next pass retries.
      await repairConflictQueueStall(stall, {
        ghCommandFn,
        logger,
        isTrustedAuthor,
        nowMs: now,
        ...(options.trustedAuthors !== undefined
          ? { trustedAuthors: options.trustedAuthors }
          : {}),
        ...(options.acquireLease ? { acquireLease: options.acquireLease } : {}),
        ...(options.abandon ? { abandon: options.abandon } : {}),
        ...(options.abandonDeps ? { abandonDeps: options.abandonDeps } : {}),
        ...(options.takeoverResolvers
          ? { takeoverResolvers: options.takeoverResolvers }
          : {}),
        ...(options.takeover ? { takeover: options.takeover } : {}),
      });
    }
    quota.repoDone();
  }

  return stalls;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
