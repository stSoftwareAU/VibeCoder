/**
 * The stale-verdict ladder's state model (Issue #2276, parent #2272).
 *
 * GitHub's mergeability verdict can be stale: NEAT-AI-Lamarck#239 was reported
 * `CONFLICTING` for days at a head whose base was already an ancestor, and the
 * resolver looped on it — merge, "already up to date", resolved marker, relabel,
 * repeat. The fix is a ladder of rungs that make GitHub recompute (nudge, then
 * rebase, then abandon-and-restart), and a ladder needs memory: **which rung
 * already ran at which head sha**.
 *
 * That memory lives in the PR's own comment thread, like the attempt history
 * beside it, so it survives hosts and restarts — no host-local state, and two
 * hosts scanning the same PR read the same facts. This module is the pure
 * reader and the pure decision over it; nothing here talks to git or GitHub.
 *
 * Two boundaries it holds, because the loop it replaces came from crossing
 * them:
 *
 * - **A rung's own marker never drives that rung again.** Every decision is
 *   keyed on the *current* head sha, and a rung is offered only when no marker
 *   names that head with it. Two scans at one head produce one rung.
 * - **The rungs are invisible to the attempt budget.** The three markers
 *   (`merge_conflict_markers.ts`) share no literal with the frozen
 *   `vibe-coder:merge-conflict-*` vocabulary, so `parseConflictAttempts`
 *   counts the same thread the same way with or without them: a rung neither
 *   spends the budget nor resets it.
 *
 * Only comments already filtered through `partitionConflictComments`
 * (`conflict_marker_trust.ts`) may be passed in — a PR comment is text any
 * account can write, and an outsider's forged rung marker would otherwise
 * skip a rung or exhaust the ladder (Issue #1247).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import {
  CONFLICT_NUDGE_MARKER,
  CONFLICT_REBASE_MARKER,
  CONFLICT_RESOLVED_MARKER,
  CONFLICT_RUNG_FAILED_MARKER,
  type ConflictLadderRung,
  isConflictHeadSha,
} from "./merge_conflict_markers.ts";

/** Attribute readers. Literal patterns only — no interpolated `RegExp`. */
const HEAD_ATTRIBUTE = /head="([^"]*)"/;
const NEW_ATTRIBUTE = /new="([^"]*)"/;
const RUNG_ATTRIBUTE = /rung="([^"]*)"/;

/** The rung names {@link CONFLICT_RUNG_FAILED_MARKER} may carry. */
const LADDER_RUNGS: readonly ConflictLadderRung[] = ["rebase", "abandon"];

/** What a PR's thread says the ladder has already done. */
export interface LadderState {
  /** Head sha the nudge rung last pushed to, when one is recorded. */
  nudgedHead?: string;
  /** Head sha the rebase rung last produced, when one is recorded. */
  rebasedHead?: string;
  /** The rung that last failed, and the head it failed at. */
  rungFailedAtHead?: { rung: ConflictLadderRung; head: string };
}

/** The one rung to run now — or the reason to run none. */
export type LadderDecision =
  /** Not this ladder's business: GitHub says the PR merges cleanly. */
  | { kind: "not-conflicting" }
  /** Push one empty commit so GitHub recomputes mergeability. */
  | { kind: "nudge" }
  /** Rebase the PR's commits onto the base, tree-identity guarded. */
  | { kind: "rebase" }
  /** Close the PR and re-queue its originating issue. */
  | { kind: "abandon" }
  /**
   * Run nothing. `verdict-unknown` — GitHub is still computing, so no rung may
   * be judged; `ladder-exhausted` — every rung has run at this head sha.
   */
  | { kind: "wait"; reason: "verdict-unknown" | "ladder-exhausted" };

/** The segment of `body` belonging to the last occurrence of `marker`. */
function markerSegment(body: string, marker: string): string | undefined {
  const start = body.lastIndexOf(marker);
  if (start < 0) return undefined;
  const end = body.indexOf("-->", start);
  return end < 0 ? body.slice(start) : body.slice(start, end);
}

/** The sha an attribute carries, or `undefined` when it is not usable. */
function readSha(segment: string, pattern: RegExp): string | undefined {
  const raw = pattern.exec(segment)?.[1]?.trim().toLowerCase();
  return raw !== undefined && isConflictHeadSha(raw) ? raw : undefined;
}

/**
 * Read the ladder's state out of a PR's trusted comment thread.
 *
 * The latest marker of each kind wins, and a {@link CONFLICT_RESOLVED_MARKER}
 * resets everything after it: a real pushed merge ends the conflict, so a PR
 * that conflicts again later climbs the ladder from the bottom rather than
 * inheriting a spent one.
 *
 * A malformed attribute is **ignored and logged at warn**, never trusted: a
 * rung marker drives a destructive step, and a sha that is not a sha must not
 * decide one. The rest of the thread still counts.
 *
 * @param trustedComments - Raw REST comment objects, oldest first, already
 *   reduced to the fleet's own by `conflict_marker_trust.ts`.
 * @param options - Optional logger for the malformed-attribute warnings.
 * @returns What the thread records; `{}` when it records nothing.
 */
export function parseLadderState(
  trustedComments: readonly unknown[],
  options: { logger?: Logger } = {},
): LadderState {
  const logger = options.logger;
  let state: LadderState = {};

  const ignore = (marker: string, segment: string) => {
    logger?.warn?.(
      `Ignoring a merge-conflict ladder marker with an unusable attribute ` +
        `(${marker})`,
      { marker, segment: segment.slice(0, 200) },
    );
  };

  for (const raw of trustedComments) {
    if (typeof raw !== "object" || raw === null) continue;
    const body = (raw as { body?: unknown }).body;
    if (typeof body !== "string") continue;

    // A pushed merge ends the conflict the rungs were climbing towards.
    if (body.includes(CONFLICT_RESOLVED_MARKER)) {
      state = {};
      continue;
    }

    const nudge = markerSegment(body, CONFLICT_NUDGE_MARKER);
    if (nudge !== undefined) {
      const head = readSha(nudge, HEAD_ATTRIBUTE);
      if (head === undefined) ignore(CONFLICT_NUDGE_MARKER, nudge);
      else state = { ...state, nudgedHead: head };
    }

    const rebase = markerSegment(body, CONFLICT_REBASE_MARKER);
    if (rebase !== undefined) {
      const head = readSha(rebase, NEW_ATTRIBUTE);
      if (head === undefined) ignore(CONFLICT_REBASE_MARKER, rebase);
      else state = { ...state, rebasedHead: head };
    }

    const failed = markerSegment(body, CONFLICT_RUNG_FAILED_MARKER);
    if (failed !== undefined) {
      const head = readSha(failed, HEAD_ATTRIBUTE);
      const name = RUNG_ATTRIBUTE.exec(failed)?.[1]?.trim();
      const rung = LADDER_RUNGS.find((known) => known === name);
      if (head === undefined || rung === undefined) {
        ignore(CONFLICT_RUNG_FAILED_MARKER, failed);
      } else {
        state = { ...state, rungFailedAtHead: { rung, head } };
      }
    }
  }

  return state;
}

/** What the ladder is deciding over. */
export interface LadderRungInput {
  /** The thread's state, from {@link parseLadderState}. */
  state: LadderState;
  /** The head sha GitHub reports for the PR right now. */
  currentHead: string;
  /** GitHub's `mergeable` verdict, e.g. `CONFLICTING` or `MERGEABLE`. */
  mergeable: string;
}

/**
 * The one rung to run now.
 *
 * Exactly one outcome per (state, head, verdict), and every rung is gated on
 * the current head sha, so a rung whose marker names that head is never
 * returned for it again — two scans between pushes produce one rung, not two.
 *
 * A verdict that is neither `CONFLICTING` nor `MERGEABLE` waits whatever the
 * state says: GitHub is still computing, and a rung judged on a verdict that
 * has not landed is the loop this ladder replaces.
 *
 * Heads are compared exactly. A recorded sha that is not the current head —
 * an abbreviation of it included — restarts the ladder at the nudge, which
 * repeats a harmless rung rather than skipping to the destructive one.
 *
 * @throws when `currentHead` is not a usable sha. That is a caller fault, not
 *   a ladder state: returning `wait` for it would disguise a broken head
 *   lookup as "GitHub is still computing" and hold the PR for ever.
 */
export function decideLadderRung(input: LadderRungInput): LadderDecision {
  const head = input.currentHead.trim().toLowerCase();
  if (!isConflictHeadSha(head)) {
    throw new Error(
      `Cannot decide a merge-conflict ladder rung for head ` +
        `"${input.currentHead}" — a head sha must be 7–40 hex characters`,
    );
  }

  const verdict = input.mergeable.trim().toUpperCase();
  if (verdict !== "CONFLICTING" && verdict !== "MERGEABLE") {
    return { kind: "wait", reason: "verdict-unknown" };
  }
  if (verdict === "MERGEABLE") return { kind: "not-conflicting" };

  const { state } = input;
  const failed = state.rungFailedAtHead;
  if (failed !== undefined && failed.head === head) {
    // The last rung there is to climb already ran here and failed.
    if (failed.rung === "abandon") {
      return { kind: "wait", reason: "ladder-exhausted" };
    }
    return { kind: "abandon" };
  }
  if (state.rebasedHead === head) return { kind: "abandon" };
  if (state.nudgedHead === head) return { kind: "rebase" };
  // No marker names this head: either the ladder has not started, or somebody
  // pushed since it did — both start it over.
  return { kind: "nudge" };
}
