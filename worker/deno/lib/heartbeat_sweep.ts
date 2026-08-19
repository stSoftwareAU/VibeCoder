/**
 * Heartbeat comment sweep (Issue #3755).
 *
 * Two kinds of heartbeat litter accumulate on a thread:
 *
 *   1. **Orphaned live markers** — a marker comment POSTed by a run that
 *      died before `clearHeartbeat()` reached it. It stays on the thread
 *      forever and its epoch reads as a live claim until it ages out.
 *   2. **Blanked, abandoned markers** — `clearHeartbeat()` PATCHes the body
 *      to the released shape and walks away, so every finished claim leaves
 *      one more near-empty comment behind.
 *
 * This module collapses those comments down to at most one. It is deliberately
 * conservative: only fleet-authored, marker-only comments are candidates, and
 * a candidate is deleted only when removing it cannot change any recovery
 * decision (see {@link classifySweepCandidate}).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  CLEARED_MARKER_GRACE_SECONDS,
  HEARTBEAT_MARKER_PREFIX,
  parseHeartbeatMarker,
  runGh,
} from "./heartbeat_storage.ts";

/**
 * Default age (seconds) past which an unreleased marker counts as orphaned.
 *
 * Mirrors `STUCK_ISSUE_DEFAULTS.stuckIssueTimeout`; it is duplicated rather
 * than imported so the heartbeat layer does not depend on the detection
 * layer. Callers with a configured timeout pass `stuckIssueTimeout`.
 */
export const DEFAULT_SWEEP_STUCK_TIMEOUT_SECONDS = 7200;

/** Options controlling {@link sweepHeartbeatComments}. */
export interface SweepOptions {
  /**
   * Fleet logins whose marker comments may be swept. Required: an empty or
   * missing allow-list sweeps nothing, so a comment from outside the fleet
   * can never be deleted.
   */
  allowedAuthors?: string[];
  /** Comment id to keep (the marker adopted by Issue #3751). */
  keepCommentId?: number;
  /** This machine's id — its own duplicate markers are always sweepable. */
  machineId?: string;
  /** Report what would be deleted without issuing any DELETE. */
  dryRun?: boolean;
  /** Age past which an unreleased marker counts as orphaned. */
  stuckIssueTimeout?: number;
  /** Age a cleared marker must reach before it is safe to delete. */
  clearedGraceSeconds?: number;
  /** Clock injection point for tests. */
  nowFn?: () => number;
}

/** Outcome of a single sweep. */
export interface SweepResult {
  /** Marker-only fleet comments considered. */
  scanned: number;
  /** Comment id kept as the single survivor, or null when none survives. */
  keptCommentId: number | null;
  /** Comment ids deleted (or, under `dryRun`, that would be deleted). */
  deleted: number[];
  /** Comment ids whose DELETE was attempted but not confirmed. */
  failed: number[];
  /** Comment ids deliberately left in place because deleting was unsafe. */
  retained: number[];
  /** Orphaned live markers swept — a spike means runs are dying early. */
  orphanedLiveMarkers: number;
  /** True when no DELETE was issued. */
  dryRun: boolean;
}

/** Why a candidate may (or may not) be deleted. */
export type SweepEligibility =
  | { eligible: true; reason: "cleared" | "own-machine" | "orphaned-live" }
  | { eligible: false; reason: "live-other-machine" | "recently-cleared" };

/** A fleet-authored, marker-only comment considered by the sweep. */
interface SweepCandidate {
  id: number;
  machineId: string;
  epoch: number;
  cleared: boolean;
  /** Comment `updated_at` as epoch seconds, or null when unknown. */
  updatedEpoch: number | null;
}

/**
 * Whether a comment body carries heartbeat markers and nothing else.
 *
 * Everything the heartbeat layer itself writes is stripped — the HTML
 * markers, the visible status line (Issue #3752) and the progress log
 * (Issue #3753). Anything left over is human or worker prose, and a comment
 * carrying prose is never swept. A claim comment (`<!-- CLAIM_LOCK:... -->
 * Claimed by ...`) therefore survives, because its "Claimed by" line
 * remains after stripping.
 */
export function isHeartbeatOnlyBody(body: string): boolean {
  if (!body.includes(HEARTBEAT_MARKER_PREFIX)) return false;
  const remainder = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s*🤖\s*\*\*Vibe Coder working\*\*.*$/gm, " ")
    .replace(/^\s*✅\s*\*\*Vibe Coder released this claim\*\*.*$/gm, " ")
    // The outcome shapes (Issue #4326): a ⚠️ no-PR release and its
    // Outcome / Diagnosis / Detail lines are the heartbeat layer's own text.
    .replace(
      /^\s*⚠️\s*\*\*Vibe Coder released this claim with no PR\*\*.*$/gm,
      " ",
    )
    .replace(/^\s*\*\*(?:Outcome|Diagnosis|Detail):\*\*.*$/gm, " ")
    // The collapsed attempt tally (Issue #4327): heading and "+N earlier";
    // the per-attempt lines share the progress log's `- HH:MM …` shape.
    .replace(/^\s*\*\*Attempts on this issue:\*\*.*$/gm, " ")
    .replace(/^\s*-\s+\+\d+ earlier\s*$/gm, " ")
    .replace(/^\s*\*\*Progress\*\*\s*$/gm, " ")
    .replace(/^\s*-\s+(?:\d{2}:\d{2}|--:--)\s.*$/gm, " ");
  return remainder.trim().length === 0;
}

/**
 * Decide whether a marker-only comment may be deleted.
 *
 * The safety rule is that deleting a marker must not change any recovery
 * decision. `stuck_recovery.ts` treats "no marker" as "fall back to the
 * issue's `updatedAt`", and treats a cleared marker the same way once
 * `shouldHonourClearedMarker` stops honouring it — that is, once the thread
 * has been quiet for longer than `CLEARED_MARKER_GRACE_SECONDS`. So a
 * cleared marker is only swept past that window, and a live marker owned by
 * another machine is only swept once its epoch has aged past
 * `stuckIssueTimeout` (at which point it no longer suppresses recovery
 * either).
 */
export function classifySweepCandidate(
  candidate: { machineId: string; epoch: number; cleared: boolean },
  updatedEpoch: number | null,
  options: {
    machineId?: string;
    now: number;
    stuckIssueTimeout: number;
    clearedGraceSeconds: number;
  },
): SweepEligibility {
  if (candidate.cleared) {
    // Unknown comment age — stay conservative and keep it.
    if (updatedEpoch === null) {
      return { eligible: false, reason: "recently-cleared" };
    }
    return options.now - updatedEpoch > options.clearedGraceSeconds
      ? { eligible: true, reason: "cleared" }
      : { eligible: false, reason: "recently-cleared" };
  }
  if (candidate.epoch <= 0) {
    // A zero epoch with no `cleared:` signal already reads as "no live
    // marker" to recovery, so removing it changes nothing.
    return { eligible: true, reason: "cleared" };
  }
  // The orphan check comes before the own-machine one so the counter stays
  // honest: a marker this host abandoned is just as much an orphan as one a
  // sibling abandoned, and the count is what feeds the alert.
  if (options.now - candidate.epoch > options.stuckIssueTimeout) {
    return { eligible: true, reason: "orphaned-live" };
  }
  if (options.machineId && candidate.machineId === options.machineId) {
    // Our own duplicate marker — the surviving comment carries our claim.
    return { eligible: true, reason: "own-machine" };
  }
  return { eligible: false, reason: "live-other-machine" };
}

/**
 * Fetch the marker-only fleet comments on an issue/PR.
 *
 * Returns an empty list on any failure (API error, unparseable response) so
 * a lookup problem degrades to "sweep nothing" rather than deleting blind.
 */
async function fetchCandidates(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
  allowedAuthors: string[],
): Promise<SweepCandidate[]> {
  let json: string;
  try {
    json = await ghFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      "[.[] | {id: .id, body: .body, author: .user.login, " +
      "updatedAt: .updated_at}]",
    ]);
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `heartbeat sweep lookup failed for ${repo}#${issueNumber}: ${err}`,
    );
    return [];
  }
  if (!json) return [];
  let comments: Array<{
    id?: number;
    body?: string;
    author?: string | null;
    updatedAt?: string | null;
  }>;
  try {
    comments = JSON.parse(json);
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `heartbeat sweep parse failed for ${repo}#${issueNumber}: ${err}`,
    );
    return [];
  }
  if (!Array.isArray(comments)) return [];

  const candidates: SweepCandidate[] = [];
  for (const comment of comments) {
    if (!comment || typeof comment.body !== "string") continue;
    if (typeof comment.id !== "number" || !Number.isFinite(comment.id)) {
      continue;
    }
    if (!isFleetAuthor(comment.author, allowedAuthors)) continue;
    if (!isHeartbeatOnlyBody(comment.body)) continue;
    const marker = parseHeartbeatMarker(comment.body);
    if (marker === null) continue;
    const parsed = comment.updatedAt ? Date.parse(comment.updatedAt) : NaN;
    candidates.push({
      id: comment.id,
      machineId: marker.machineId,
      epoch: marker.epoch,
      cleared: marker.cleared,
      updatedEpoch: isNaN(parsed) ? null : Math.floor(parsed / 1000),
    });
  }
  candidates.sort((a, b) => a.id - b.id);
  return candidates;
}

/**
 * Delete one comment, returning true only when GitHub positively confirms
 * the removal.
 *
 * `-i` makes `gh api` echo the status line, so a silent failure (the shared
 * {@link runGh} returns "" on error) can never be counted as a success.
 */
async function deleteComment(
  repo: string,
  commentId: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  try {
    const out = await ghFn([
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/issues/comments/${commentId}`,
      "-i",
    ]);
    return /HTTP\/[\d.]+\s+2\d\d/.test(out);
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `heartbeat sweep DELETE failed for ${repo} comment ${commentId}: ${err}`,
    );
    return false;
  }
}

/**
 * Collapse the heartbeat marker comments on an issue/PR down to at most one
 * (Issue #3755).
 *
 * The survivor is `keepCommentId` when supplied (the comment adopted by
 * Issue #3751), otherwise the newest comment carrying a live marker. When
 * every marker has been released the thread legitimately ends with zero
 * marker comments — recovery reads "comment absent" exactly as it reads an
 * aged "cleared comment".
 *
 * The sweep never throws: a failed DELETE is counted and the remaining
 * candidates are still attempted.
 */
export async function sweepHeartbeatComments(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string> = runGh,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const dryRun = options.dryRun === true;
  const result: SweepResult = {
    scanned: 0,
    keptCommentId: null,
    deleted: [],
    failed: [],
    retained: [],
    orphanedLiveMarkers: 0,
    dryRun,
  };

  const allowedAuthors = options.allowedAuthors ?? [];
  if (allowedAuthors.length === 0) {
    // An allow-list is the only thing standing between the sweep and a
    // third party's comment — without one, sweep nothing.
    return result;
  }

  const candidates = await fetchCandidates(
    repo,
    issueNumber,
    ghFn,
    allowedAuthors,
  );
  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  const now = options.nowFn ? options.nowFn() : Math.floor(Date.now() / 1000);
  const eligibility = {
    ...(options.machineId ? { machineId: options.machineId } : {}),
    now,
    stuckIssueTimeout: options.stuckIssueTimeout ??
      DEFAULT_SWEEP_STUCK_TIMEOUT_SECONDS,
    clearedGraceSeconds: options.clearedGraceSeconds ??
      CLEARED_MARKER_GRACE_SECONDS,
  };

  const keep = options.keepCommentId !== undefined &&
      candidates.some((c) => c.id === options.keepCommentId)
    ? options.keepCommentId
    : newestActiveMarker(candidates, now, eligibility.stuckIssueTimeout);
  result.keptCommentId = keep;

  for (const candidate of candidates) {
    if (candidate.id === keep) continue;
    const verdict = classifySweepCandidate(
      candidate,
      candidate.updatedEpoch,
      eligibility,
    );
    if (!verdict.eligible) {
      result.retained.push(candidate.id);
      continue;
    }
    if (verdict.reason === "orphaned-live") result.orphanedLiveMarkers++;
    if (dryRun) {
      result.deleted.push(candidate.id);
      continue;
    }
    if (await deleteComment(repo, candidate.id, ghFn)) {
      result.deleted.push(candidate.id);
    } else {
      result.failed.push(candidate.id);
    }
  }

  if (result.failed.length > 0) {
    console.warn(
      `[heartbeat] sweep on ${repo}#${issueNumber}: ` +
        `${result.failed.length} comment(s) could not be deleted ` +
        `(${result.failed.join(", ")})`,
    );
  }
  return result;
}

/**
 * Newest comment carrying a marker that is still beating, or null.
 *
 * A marker whose epoch has aged past `stuckIssueTimeout` is an orphan, not a
 * claim, so it is never chosen as the survivor — a thread whose markers have
 * all been released or orphaned legitimately ends with none.
 */
function newestActiveMarker(
  candidates: SweepCandidate[],
  now: number,
  stuckIssueTimeout: number,
): number | null {
  let newest: number | null = null;
  for (const c of candidates) {
    if (c.cleared || c.epoch <= 0) continue;
    if (now - c.epoch > stuckIssueTimeout) continue;
    if (newest === null || c.id > newest) newest = c.id;
  }
  return newest;
}
