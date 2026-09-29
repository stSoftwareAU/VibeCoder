/**
 * Watchdog for a merge-conflict queue that stalled before its first attempt
 * (Issue #1112).
 *
 * `docs/workflows/merge-conflicts.md` already records the "nothing stalls
 * unowned" rule: a PR out of attempt budget with no `needs-human` is escalated
 * by the next scan, so a missed escalation at the *end* of the ladder cannot
 * leave a PR silent. Nothing covered a stall *before the first attempt*, which
 * is the case that actually happened — NEAT-AI-Ockham#116 carried
 * `merge-conflict` for over three hours while nothing followed.
 *
 * Whatever suppressed the pass that time — a rate-limit pause, a dead
 * launcher, a lane that never came round — the observable was the same: the
 * label went on, and nothing followed. So this watchdog detects the **shape**
 * rather than any one cause, and the next novel cause produces a visible
 * record instead of silence.
 *
 * The detection signal is deliberately unlike every other guard in this
 * subsystem: it keys on **wall-clock time since the label was applied**, read
 * from the PR's `labeled` timeline event, not on attempt records. An
 * attempt-based guard cannot fire here, because the failure mode is that no
 * attempt record exists.
 *
 * Two boundaries the rest of this subsystem depends on:
 *
 * - **It never applies `needs-human`.** A mechanical stall is work, not a
 *   decision, and that label is a cross-subsystem veto (Issue #569) — the
 *   conflict scan skips any PR carrying it, so applying it here would remove
 *   the PR from the very lane that could clear it. It files no issue and adds
 *   no label either (Issue #2803): a stall is repaired, not reported.
 * - **It never starts an attempt.** Forcing one from a watchdog would race the
 *   ordinary pass and manufacture the disrupted-attempt state the workflow
 *   works hard to avoid. The first trip clears the ladder's per-head wait so
 *   the ordinary pass reruns the ladder once; a second trip closes the PR and
 *   redoes its work through `abandonAndRestart`.
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
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  type ConflictPrDecision,
  conflictPrKey,
  conflictReasonOperands,
  type ConflictSkipReason,
  MERGE_CONFLICT_LABEL,
} from "./pr_merge_conflict_scan.ts";
import {
  CONFLICT_RUNG_FAILED_MARKER,
  readParkedBase,
} from "./merge_conflict_markers.ts";
import type { TimelineCache } from "./timeline_cache.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hours a PR may carry `merge-conflict` with nothing concluding before the
 * queue is called stalled.
 *
 * Eight hours is this watchdog's own window (Issue #2305 removed the
 * post-attempt cooldown it used to be derived from). Hours can pass with no
 * attempt for entirely ordinary reasons — a busy lane, a held lease — so the
 * bound is the window a healthy queue cannot plausibly exceed.
 */
export const DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS = 8;

/**
 * Marker opening the first-trip comment (Issue #2803).
 *
 * It records that the ladder was rerun once for this stall, so the next check
 * that still finds the stall abandons rather than trips again. It shares no
 * literal with the `vibe-merge-conflict-` vocabulary, so the ladder and the
 * attempt budget never read it, and it is **not** progress: the stall clock
 * keeps running through it, or the second trip could never fire (#2802).
 */
export const CONFLICT_STALL_REPAIR_MARKER = "<!-- vibe-conflict-stall-repair";

/** Label whose presence means a human already owns the PR. */
const NEEDS_HUMAN_LABEL = "needs-human";

/** The only `mergeable` state that is a merge-conflict queue. */
const CONFLICTING_STATE = "CONFLICTING";

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
   * moved. Absent means the listing did not carry one, and an unknown base
   * can never match a park — the stall is then judged the ordinary way.
   */
  baseRefOid?: string;
}

/** A merge-conflict queue that has stopped moving on one PR. */
export interface ConflictQueueStall {
  repo: string;
  prNumber: number;
  /** Epoch milliseconds the label was applied. */
  labelledAtMs: number;
  /** How long the label has been on, in milliseconds. */
  labelAgeMs: number;
  /**
   * Epoch milliseconds the stall clock started: the label event, or the most
   * recent attempt conclusion after it — whichever is later.
   */
  stalledSinceMs: number;
  /** How long nothing has happened, in milliseconds. */
  stalledMs: number;
  /** Epoch milliseconds of the last concluded attempt, when there was one. */
  lastConclusionAtMs?: number;
  /**
   * True when an attempt opened and never concluded — the disrupted case. It
   * is still a stall: the disruption bound has not fired either, so nothing
   * is moving the PR.
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
  /** Hours before a labelled PR with no conclusion is called stalled. */
  thresholdHours?: number;
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

/** What the PR's thread says has happened since the label went on. */
interface StallSignals {
  /**
   * Epoch milliseconds of the most recent conclusion — merged, or judged and
   * failed — since the label went on, when there is one.
   */
  lastConclusionAtMs?: number;
  /** An attempt opened after the most recent conclusion. */
  openAttempt: boolean;
  /**
   * Epoch milliseconds of the newest first-trip marker since the most recent
   * conclusion, when the ladder has already been rerun for this stall.
   */
  tripAtMs?: number;
  /**
   * The base tip the newest park marker names, when the PR is parked
   * (Issue #2312). A park is the opposite of the silence this watchdog looks
   * for — it is the record that says *why* nothing is happening — so it
   * suppresses the stall, but only while the base tip it names is still the
   * PR's base. Once that tip moves the scan owes the PR an attempt again, and
   * the ordinary clock applies.
   */
  parkedBase?: string;
}

/**
 * Read the three signals out of the PR's own thread.
 *
 * Every signal requires a **trusted author**. A comment body is text anybody
 * may write on a public repository, and each of these signals *suppresses* the
 * watchdog — so trusting a forged one buys silence, which is the outcome this
 * watchdog exists to remove. (`hasOpenDeferralNotice` is author-blind about
 * conclusions for the opposite reason: there, a forged marker only causes an
 * extra comment.)
 *
 * A conclusion restarts everything after it: an attempt that opened before it
 * is no longer open, and a trip posted before it belonged to the stall that
 * conclusion ended.
 *
 * @param comments - Raw REST comment objects, oldest first.
 * @param sinceMs - The label event; comments older than it belong to a
 *   previous conflict and say nothing about this one.
 */
function readStallSignals(
  comments: readonly unknown[],
  sinceMs: number,
  isTrustedAuthor: (login: string) => boolean,
): StallSignals {
  const signals: StallSignals = { openAttempt: false };

  for (const raw of comments) {
    const body = commentBody(raw);
    if (body === undefined) continue;
    const createdAtMs = commentCreatedAtMs(raw);
    // An undated comment cannot be placed relative to the label, so it is not
    // allowed to suppress anything.
    if (createdAtMs === undefined || createdAtMs < sinceMs) continue;
    const author = commentAuthor(raw);
    if (author === undefined || !isTrustedAuthor(author)) continue;

    if (
      body.includes(CONFLICT_RESOLVED_MARKER) ||
      body.includes(CONFLICT_FAILED_MARKER)
    ) {
      if (
        signals.lastConclusionAtMs === undefined ||
        createdAtMs > signals.lastConclusionAtMs
      ) {
        signals.lastConclusionAtMs = createdAtMs;
      }
      // Everything before this conclusion belongs to the stall it ended.
      signals.openAttempt = false;
      delete signals.tripAtMs;
      delete signals.parkedBase;
      continue;
    }
    if (body.includes(CONFLICT_ATTEMPT_MARKER)) signals.openAttempt = true;
    // A trip is recorded but never counted as progress: it leaves the clock.
    if (body.includes(CONFLICT_STALL_REPAIR_MARKER)) {
      signals.tripAtMs = Math.max(signals.tripAtMs ?? createdAtMs, createdAtMs);
    }
    // Read through the marker module rather than by substring: the base sha is
    // the whole signal, and a marker whose sha cannot be read must not park
    // the watchdog on a value nothing can ever match (Issue #2312).
    const park = readParkedBase([raw]);
    if (park !== null) signals.parkedBase = park.base;
  }

  return signals;
}

/**
 * Decide whether one labelled PR's queue has stalled.
 *
 * Returns `null` for every PR that is legitimately not a stall: parked behind
 * `needs-human`, closed, not in the queue at all, of unknown label age, inside
 * the threshold, moved by a concluded attempt, or parked on an unmoved base tip (Issue #2312).
 *
 * An attempt that opened and never concluded still counts as a stall — the
 * disruption bound has not fired either, so nothing is moving the PR. Keying
 * on "any attempt marker exists" instead of "a *conclusion* exists" would miss
 * exactly that shape, which is the real GRQ#4408 case.
 */
export function detectConflictQueueStall(
  observation: ConflictStallObservation,
  options: DetectConflictStallOptions,
): ConflictQueueStall | null {
  const {
    nowMs,
    isTrustedAuthor,
    thresholdHours = DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS,
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
  // The clock can never start before the label, so a label inside the
  // threshold is not a stall whatever the thread says — and the caller may
  // skip reading the thread at all on the strength of it.
  if (labelAgeMs < thresholdHours * 3600_000) return null;

  const signals = readStallSignals(
    observation.comments,
    labelledAtMs,
    isTrustedAuthor,
  );
  // Issue #2312: a parked PR is not a stalled one. The park marker is what
  // *follows* the label — the fleet saying it has spent this issue's restarts
  // and is waiting on the base tip, not going quiet — so escalating it would
  // report a mechanical failure that did not happen. The suppression is
  // deliberately narrow: it holds only while the PR's base is still the sha
  // the marker names, so a park the scan should already have re-attempted is
  // still caught by the ordinary clock.
  //
  // A base tip that could not be read therefore resolves the *opposite* way
  // here to the way it resolves in the scan, and on purpose: each component
  // fails towards saying something. The scan will not spend an agent run on a
  // merge it cannot tell has changed, and this watchdog will not go silent on
  // a PR it cannot tell is still waiting.
  if (
    signals.parkedBase !== undefined &&
    signals.parkedBase === observation.baseRefOid?.trim().toLowerCase()
  ) {
    return null;
  }

  // A conclusion puts the PR back in the ordinary ladder and starts a fresh
  // clock: the stall being measured is the silence *since* the last thing that
  // happened, not since the label. Without this, one failed attempt in hour
  // two buys permanent silence for a PR that then never gets its second — a
  // queue nothing else watches, because its budget is not spent either.
  const stalledSinceMs = signals.lastConclusionAtMs ?? labelledAtMs;
  const stalledMs = nowMs - stalledSinceMs;
  if (stalledMs < thresholdHours * 3600_000) return null;

  return {
    repo: observation.repo,
    prNumber: observation.prNumber,
    labelledAtMs,
    labelAgeMs,
    stalledSinceMs,
    stalledMs,
    ...(signals.lastConclusionAtMs !== undefined
      ? { lastConclusionAtMs: signals.lastConclusionAtMs }
      : {}),
    openAttempt: signals.openAttempt,
    skipReasons: observation.skipReasons ?? [],
  };
}

// ---------------------------------------------------------------------------
// What the repair says
// ---------------------------------------------------------------------------

/** Render a duration in whole hours, floored — never rounded up. */
function formatHours(ms: number): string {
  const hours = Math.floor(ms / 3600_000);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** One skip reason, as `kind (operand=value, …)`. */
function describeSkipReason(reason: ConflictSkipReason): string {
  const operands = Object.entries(conflictReasonOperands(reason))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  return operands.length > 0
    ? `\`${reason.kind}\` (${operands})`
    : `\`${reason.kind}\``;
}

/** Why this PR's queue is being reported as stalled. */
export function buildConflictStallReason(stall: ConflictQueueStall): string {
  const lines = [
    `${stall.repo}#${stall.prNumber} has carried \`${MERGE_CONFLICT_LABEL}\` ` +
    `since ${new Date(stall.labelledAtMs).toISOString()} — ` +
    `${formatHours(stall.labelAgeMs)} — and still conflicts with its base.`,
  ];

  lines.push(
    "",
    stall.lastConclusionAtMs === undefined
      ? "No resolution attempt has reached a conclusion in that time: no " +
        "resolved marker and no failure marker on the PR."
      : `The last attempt concluded at ${
        new Date(stall.lastConclusionAtMs).toISOString()
      } and nothing has happened in the ${
        formatHours(stall.stalledMs)
      } since — no further attempt, no conclusion.`,
  );

  lines.push(
    "",
    stall.openAttempt
      ? "An attempt did open and then went silent, so it was never judged — " +
        "and the disrupted-attempt bound has not fired either. The queue is " +
        "stalled either way."
      : "No attempt is open, so the attempt budget is untouched and the " +
        "branch is exactly as its author pushed it.",
  );

  if (stall.skipReasons.length > 0) {
    lines.push(
      "",
      "**Skip reasons recorded for it** (Issue #1109)",
      "",
      ...stall.skipReasons.map((reason) => `- ${describeSkipReason(reason)}`),
    );
  } else {
    lines.push(
      "",
      "No skip reason was recorded for it this cycle, which is itself the " +
        "signal: the pass reached no decision about this PR at all.",
    );
  }

  return lines.join("\n");
}

/**
 * The first-trip comment posted on the PR (Issue #2803).
 *
 * It opens with {@link CONFLICT_STALL_REPAIR_MARKER}, which is what makes the
 * second check abandon rather than trip again: the marker lives on the PR, so
 * every host reads it, and a conclusion after it clears it.
 */
export function buildConflictStallComment(stall: ConflictQueueStall): string {
  return [
    `${CONFLICT_STALL_REPAIR_MARKER} trip="1" -->`,
    "⏳ **Merge-conflict queue stalled — rerunning the conflict ladder once**",
    "",
    buildConflictStallReason(stall),
    "",
    "The ladder's wait marker for this head has been cleared so the next " +
    "conflict pass tries again. If the PR is still stalled at the next " +
    "check, it is closed and its originating issue is redone.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Repair (Issue #2803)
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
}

/** What {@link repairConflictQueueStall} did. */
export type ConflictStallRepairAction =
  | "skipped-lease-held"
  | "first-trip"
  | "awaiting-second-check"
  | "abandoned"
  | "abandon-declined"
  | "failed";

/** Everything {@link repairConflictQueueStall} needs beyond its seams. */
export interface ConflictStallRepairOptions extends ConflictStallRepairDeps {
  /** Whether a comment author is one of the fleet's own. */
  isTrustedAuthor: (login: string) => boolean;
  /** Current time, epoch milliseconds. */
  nowMs: number;
  /** Hours between the first trip and the second check. */
  thresholdHours?: number;
}

/** The raw comment's numeric id, when it has one. */
function commentId(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : undefined;
}

/** True for a fleet-authored `rung="abandon"` failure marker — the wait. */
function isAbandonWaitMarker(
  raw: unknown,
  isTrustedAuthor: (login: string) => boolean,
): boolean {
  const body = commentBody(raw);
  if (body === undefined) return false;
  const start = body.indexOf(CONFLICT_RUNG_FAILED_MARKER);
  if (start < 0) return false;
  const author = commentAuthor(raw);
  if (author === undefined || !isTrustedAuthor(author)) return false;
  const end = body.indexOf("-->", start);
  const segment = body.slice(start, end < 0 ? undefined : end);
  return /\brung="abandon"/.test(segment);
}

/**
 * Repair a stalled queue in two trips (Issue #2803).
 *
 * The first trip records itself on the PR, then deletes the ladder's
 * fleet-authored `rung="abandon"` failure markers — the per-head wait — so the
 * ordinary conflict pass climbs the ladder once more. The second trip, when a
 * later check still finds the stall a full threshold after the first, closes
 * the PR and redoes its work through `abandonAndRestart`, whose re-queue label
 * is the issue's own, else `idle-task` — never `work-on`.
 *
 * It files no issue, adds no label and never applies `needs-human` itself —
 * only the rung does, on the originating issue, once its two redos are spent
 * (Issue #2804). It never throws: every failure is logged and reported as
 * `failed`, and the next pass retries.
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
    // Re-read under the lease: another pass may have tripped since detection.
    const comments = await fetchIssueCommentPages(repo, prNumber, ghCommandFn);
    const { tripAtMs } = readStallSignals(
      comments,
      stall.labelledAtMs,
      isTrustedAuthor,
    );

    if (tripAtMs === undefined) {
      // The trip marker first: a failure after it still leaves the second
      // check armed, whereas a cleared wait with no record would loop.
      await ghCommandFn([
        "pr",
        "comment",
        String(prNumber),
        "--repo",
        repo,
        "--body",
        buildConflictStallComment(stall),
      ]);
      for (const raw of comments) {
        if (!isAbandonWaitMarker(raw, isTrustedAuthor)) continue;
        const id = commentId(raw);
        if (id === undefined) continue;
        await ghCommandFn([
          "api",
          "-X",
          "DELETE",
          `repos/${repo}/issues/comments/${id}`,
        ]);
      }
      logger.warn(
        "Merge-conflict queue stalled — rerunning the conflict ladder once",
        { repo, prNumber, stalledMs: stall.stalledMs },
      );
      return "first-trip";
    }

    const thresholdMs =
      (options.thresholdHours ?? DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS) *
      3600_000;
    if (options.nowMs - tripAtMs < thresholdMs) {
      logger.info(
        "Merge-conflict stall repair: ladder rerun pending — awaiting the " +
          "second check",
        { repo, prNumber, tripAtMs },
      );
      return "awaiting-second-check";
    }

    const view = JSON.parse(
      await ghCommandFn([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "headRefName,baseRefName",
      ]),
    ) as { headRefName?: unknown; baseRefName?: unknown };
    if (
      typeof view.headRefName !== "string" ||
      typeof view.baseRefName !== "string"
    ) {
      throw new Error("`gh pr view` returned no head or base branch name");
    }

    const abandon = options.abandon ?? abandonAndRestart;
    const outcome = await abandon(
      {
        repo,
        prNumber,
        branchName: view.headRefName,
        baseBranch: view.baseRefName,
        prComments: comments,
        reason: { kind: "stalled", detail: buildConflictStallReason(stall) },
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
          "Merge-conflict queue still stalled after the ladder rerun — " +
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
  /** Hours before a labelled PR with no conclusion is called stalled. */
  thresholdHours?: number;
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
   * Without it this watchdog cost one GraphQL call per monitored repository on
   * **every cycle** — `20×[pr list --json --label --repo --state]` every ~3
   * minutes, per host, almost always to learn "none" — and the fleet was
   * spending its hourly GitHub quota in ~25 minutes. A stall is
   * {@link DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS} hours long, so learning that
   * a PR gained the label one cache lifetime late costs nothing.
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
}

/**
 * Fields the label listing asks for — the live state rides along with it, and
 * so does the base tip a park marker is compared against (Issue #2312).
 */
const STALL_PR_FIELDS = "number,labels,mergeable,baseRefOid";

/** Parse `gh pr list --json number,labels,mergeable,baseRefOid` output. */
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
 * One pass: every open PR carrying `merge-conflict`, checked for a stalled
 * queue and repaired in two trips if it has one.
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
    thresholdHours,
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
        // the threshold cannot be a stall — and the thread, which is the
        // expensive read, is never fetched for one.
        if (
          labelledAtMs !== undefined &&
          now - labelledAtMs <
            (thresholdHours ?? DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS) *
              3600_000
        ) {
          continue;
        }
        observation = {
          repo,
          prNumber: pr.number,
          labels: pr.labels,
          mergeableState,
          ...(pr.baseRefOid !== undefined ? { baseRefOid: pr.baseRefOid } : {}),
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
        ...(thresholdHours !== undefined ? { thresholdHours } : {}),
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
        ...(thresholdHours !== undefined ? { thresholdHours } : {}),
        ...(options.trustedAuthors !== undefined
          ? { trustedAuthors: options.trustedAuthors }
          : {}),
        ...(options.acquireLease ? { acquireLease: options.acquireLease } : {}),
        ...(options.abandon ? { abandon: options.abandon } : {}),
        ...(options.abandonDeps ? { abandonDeps: options.abandonDeps } : {}),
      });
    }
    quota.repoDone();
  }

  return stalls;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
