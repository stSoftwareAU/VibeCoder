/**
 * The merge-conflict marker vocabulary (Issues #84, #395, #1115).
 *
 * A leaf module on purpose. Attempt history lives in marker comments on the
 * PR itself rather than in host-local state, so several modules read the same
 * three markers back: the scan, the resolution processor, the stall watchdog,
 * the deferral tracker, and the abandon-and-restart rung. Keeping the literals
 * here — rather than in whichever module happened to need them first — is what
 * lets those modules depend on the vocabulary without depending on each other.
 *
 * The `vibe-coder:` shapes below deviate from the canonical `vibe-*` grammar
 * and are **frozen** rather than fixed (Issue #842): every one is read back out
 * of comments already posted, so renaming any of them makes every marker in
 * the wild invisible to its guard.
 *
 * Issue #2996 adds `pass="…"` to the attempt/failed/resolved markers and a
 * shared {@link CONFLICT_RESOLUTION_BUDGET}: one PR gets three resolution
 * attempts in total, tallied as markers on the PR regardless of which pass
 * — the stale-verdict ladder, the milestone sync or the takeover rung — spent
 * each one, so the budget cannot be multiplied just by routing the same PR
 * through more than one pass.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { conflictCommentAuthor } from "./conflict_marker_trust.ts";

/**
 * Resolution attempts one PR gets across every pass — ladder, milestone sync
 * and takeover (Issue #2996). Single source of truth: every pass that spends
 * from this shared budget imports it rather than hard-coding its own count.
 */
export const CONFLICT_RESOLUTION_BUDGET = 3;

/**
 * Hours a failed attempt leaves the PR to its owner before the next attempt
 * is due, unless the head moves first (Issue #2996).
 */
export const CONFLICT_OWNER_CHECK_HOURS = 2;

/** The pass that ran a given conflict-resolution attempt (Issue #2996). */
export type ConflictResolutionPass = "ladder" | "sync" | "takeover";

/** How one recorded conflict-resolution attempt concluded (Issue #2996). */
export type ConflictAttemptOutcome = "open" | "failed" | "resolved";

/**
 * One attempt as read back out of a PR's comment thread (Issue #2996).
 *
 * Attributed by {@link readResolutionAttempts}, not written directly — the
 * writers below produce the marker text; this is the parsed shape the shared
 * budget is tallied from.
 */
export interface ConflictResolutionAttempt {
  /** The pass that ran it; a legacy marker with no (or an unrecognised) `pass=` reads as `ladder`. */
  pass: ConflictResolutionPass;
  /**
   * Epoch ms of the attempt's latest marker (its conclusion once concluded);
   * undefined when the comment carries no parseable `created_at`.
   */
  atMs: number | undefined;
  /** Head sha the attempt ran against, lowercased; undefined on a legacy marker or an unreadable value. */
  headSha: string | undefined;
  outcome: ConflictAttemptOutcome;
}

/**
 * Visible queue label applied to every PR found CONFLICTING (Issue #84).
 *
 * Here rather than in the scan that applies it (Issue #2310): the fallback
 * context reads the label's own `labeled` timeline event to date a divergence,
 * and the scan imports *it*, so the label had to live where both can reach it
 * without a cycle. `pr_merge_conflict_scan.ts` re-exports it, so every existing
 * importer keeps its import path.
 */
export const MERGE_CONFLICT_LABEL = "merge-conflict";

/** Marker that identifies one recorded conflict-resolution attempt. */
export const CONFLICT_ATTEMPT_MARKER = "<!-- vibe-coder:merge-conflict-attempt";

/**
 * Marker posted when an attempt merged successfully. Everything before it
 * belongs to a conflict that is already resolved, so the attempt budget
 * restarts from it — a PR that conflicts again months later gets a full
 * budget rather than inheriting a spent one.
 *
 * A **prefix**, not a complete tag (Issue #2996) — matching how
 * {@link CONFLICT_ATTEMPT_MARKER} and {@link CONFLICT_FAILED_MARKER} are
 * already prefixes — so that `body.includes(CONFLICT_RESOLVED_MARKER)` keeps
 * matching both a legacy `<!-- vibe-coder:merge-conflict-resolved -->` body
 * and the new `pass="…" head="…"`-attributed marker
 * {@link conflictResolvedMarker} writes.
 */
export const CONFLICT_RESOLVED_MARKER =
  "<!-- vibe-coder:merge-conflict-resolved";

/**
 * Marker posted when an attempt reached a merge conclusion and failed
 * (Issue #395). It is what turns an opened attempt into a *spent* one — an
 * attempt marker with no conclusion after it was disrupted, not judged.
 */
export const CONFLICT_FAILED_MARKER = "<!-- vibe-coder:merge-conflict-failed";

// ---------------------------------------------------------------------------
// The stale-verdict ladder (Issues #2272, #2276)
// ---------------------------------------------------------------------------

/*
 * The three markers below are the rungs the resolver climbs when GitHub's
 * `CONFLICTING` verdict is stale — the loop NEAT-AI-Lamarck#239 sat in. They
 * record which rung already ran at which head sha, which is what bounds each
 * rung to one run per head.
 *
 * Canonical `vibe-*` grammar — a bare `vibe-` prefix and `key="value"`
 * attributes (Issue #842). The frozen `vibe-coder:` shapes above are frozen
 * only because live threads already carry them; these are new, so they are
 * written the canonical way.
 *
 * No rung name contains an attempt-vocabulary literal, and none of the three
 * contains another, so a rung marker is invisible to `parseConflictAttempts`
 * and to its siblings: a rung neither spends nor resets the attempt budget.
 */

/** A 7-to-40 character lowercase git object name, as a marker may carry. */
const HEAD_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Whether a value is a head sha these markers may carry.
 *
 * Exported so the writer and the reader agree on what a usable sha is: two
 * copies of the pattern would let a marker be written that the ladder then
 * discards, which is a rung that runs again at the same head.
 */
export function isConflictHeadSha(value: string): boolean {
  return HEAD_SHA_PATTERN.test(value);
}

/**
 * Marker posted by the nudge rung.
 *
 * `head` is the sha the nudge **produced** — the head GitHub reports next —
 * not the head it started from. The ladder is keyed on the current head, so a
 * marker naming the pre-nudge head would leave the new head unnamed and nudge
 * it again on the following scan, which is the loop this ladder ends.
 */
export const CONFLICT_NUDGE_MARKER = "<!-- vibe-merge-conflict-nudge";

/** Marker posted by the rebase rung, naming the head it replaced and the new one. */
export const CONFLICT_REBASE_MARKER = "<!-- vibe-merge-conflict-rebase";

/** Marker posted when a rung ran at a head sha and failed. */
export const CONFLICT_RUNG_FAILED_MARKER =
  "<!-- vibe-merge-conflict-rung-failed";

/**
 * The rungs whose failure is recorded by {@link CONFLICT_RUNG_FAILED_MARKER}.
 *
 * `"rebase"` is legacy — the rung it named was dropped in Issue #2842, and
 * nothing posts a `rung="rebase"` marker any more. It stays in this union
 * only so a marker already on a PR thread from before the drop still reads
 * back as a known rung, rather than being discarded as malformed.
 */
export type ConflictLadderRung = "rebase" | "abandon";

/**
 * The sha as a marker attribute, or a throw.
 *
 * Fails loud rather than writing an attribute the reader will discard: a
 * marker nobody can read back is a rung that runs again at the same head,
 * which is the loop this ladder exists to break.
 */
function headAttribute(name: string, sha: string): string {
  const trimmed = sha.trim().toLowerCase();
  if (!isConflictHeadSha(trimmed)) {
    throw new Error(
      `Refusing to write a merge-conflict rung marker with ${name}="${sha}" ` +
        "— a head sha must be 7–40 hex characters",
    );
  }
  return `${name}="${trimmed}"`;
}

/** The marker line for one nudged head. */
export function conflictNudgeMarker(head: string): string {
  return `${CONFLICT_NUDGE_MARKER} ${headAttribute("head", head)} -->`;
}

/**
 * The marker line for one rebase, naming the head it replaced.
 *
 * Legacy — the rebase rung was dropped in Issue #2842, so nothing in
 * production posts this any more. Kept only because tests still forge a
 * legacy marker with it to prove the ladder still reads old threads back
 * correctly.
 */
export function conflictRebaseMarker(
  oldHead: string,
  newHead: string,
): string {
  return `${CONFLICT_REBASE_MARKER} ${headAttribute("old", oldHead)} ` +
    `${headAttribute("new", newHead)} -->`;
}

/** The marker line for one rung that ran at a head sha and failed. */
export function conflictRungFailedMarker(
  rung: ConflictLadderRung,
  head: string,
): string {
  return `${CONFLICT_RUNG_FAILED_MARKER} rung="${rung}" ` +
    `${headAttribute("head", head)} -->`;
}

// ---------------------------------------------------------------------------
// Parking (Issue #2312)
// ---------------------------------------------------------------------------

/**
 * Marker posted when a PR is **parked** on `merge-conflict` (Issue #2312).
 *
 * The fleet restarts an issue's work twice. After the second restart the fresh
 * PR's spent budget has nowhere left to go that is worth spending an agent run
 * on: the same two branches conflict, and a third judged merge of the same two
 * sides has never been what settled one. So the PR is left open carrying the
 * queue label, and this marker is what follows the label — the record that the
 * fleet decided to wait rather than that it went silent.
 *
 * **Keyed on the `base` sha, not the head**, which is what makes the wait end.
 * Every other marker in this vocabulary keys on the head, because every other
 * rung acts on the head. Here nothing acts at all until the *base* tip moves:
 * a base that has not moved cannot merge any better than it did an hour ago,
 * and a base that has moved is a genuinely different merge, worth a fresh
 * two-run budget.
 */
export const CONFLICT_PARKED_MARKER = "<!-- vibe-merge-conflict-parked";

/** The marker line for one parked PR, naming the base tip it is waiting on. */
export function conflictParkedMarker(base: string): string {
  // `headAttribute` validates a git object name, whichever end it names: a
  // marker the reader would discard is a park that never ends.
  return `${CONFLICT_PARKED_MARKER} ${headAttribute("base", base)} -->`;
}

/** Where a park marker sits in a thread, and which base tip it named. */
export interface ConflictParkRecord {
  /** The base sha the PR was parked at, lowercased. */
  base: string;
  /** Index of the park comment in the thread it was read from. */
  index: number;
}

/**
 * The most recent park marker in a comment thread, or `null`.
 *
 * **Only safe on a thread already reduced to the fleet's own comments**
 * (`conflict_marker_trust.ts`): a park marker suppresses every later attempt,
 * so one anybody could post would be a way to silence a PR's queue for ever.
 *
 * A marker whose `base` cannot be read is treated as no park at all. That is
 * the self-healing direction — the PR is offered again, its spent budget
 * declines the abandon, and the park is re-recorded with a base a reader can
 * compare — where honouring it would park the PR on a sha nothing can ever
 * match.
 *
 * @param comments - Raw REST comment objects, oldest first, fleet-authored.
 * @returns The newest readable park record, with its index in `comments`.
 */
export function readParkedBase(
  comments: readonly unknown[],
): ConflictParkRecord | null {
  let found: ConflictParkRecord | null = null;
  for (let index = 0; index < comments.length; index++) {
    const raw = comments[index];
    if (typeof raw !== "object" || raw === null) continue;
    const body = (raw as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    const at = body.indexOf(CONFLICT_PARKED_MARKER);
    if (at < 0) continue;
    const written = /base="([^"]*)"/.exec(body.slice(at))?.[1];
    if (written === undefined) continue;
    // One rule, checked by the same predicate the writer validates through:
    // a reader laxer than the writer accepts markers nothing else agrees are
    // markers.
    const base = written.trim().toLowerCase();
    if (!isConflictHeadSha(base)) continue;
    found = { base, index };
  }
  return found;
}

// ---------------------------------------------------------------------------
// The shared resolution budget (Issue #2996)
// ---------------------------------------------------------------------------

/** The passes a `pass="…"` attribute may legitimately name. */
const CONFLICT_RESOLUTION_PASSES: readonly ConflictResolutionPass[] = [
  "ladder",
  "sync",
  "takeover",
];

/** Whether a value is one of the recognised pass names, narrowing the type. */
function isConflictResolutionPass(
  value: string | undefined,
): value is ConflictResolutionPass {
  return value !== undefined &&
    (CONFLICT_RESOLUTION_PASSES as readonly string[]).includes(value);
}

/** The positive-integer attempt number as a marker attribute, or a throw. */
function attemptNumberAttribute(attemptNumber: number): string {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error(
      `Refusing to write a merge-conflict attempt marker with n="${attemptNumber}" ` +
        "— the attempt number must be a positive integer",
    );
  }
  return `n="${attemptNumber}"`;
}

/** The marker line for one opened attempt, naming its pass and the head it ran against. */
export function conflictAttemptMarker(
  attemptNumber: number,
  pass: ConflictResolutionPass,
  headSha: string,
): string {
  return `${CONFLICT_ATTEMPT_MARKER} ${
    attemptNumberAttribute(attemptNumber)
  } ` +
    `pass="${pass}" ${headAttribute("head", headSha)} -->`;
}

/**
 * The marker line for one attempt that reached a merge conclusion and
 * failed, naming its pass and the head it ran against.
 *
 * `n="…"` stays first and whitespace-separated from the rest: the abandon
 * rung (`conflict_abandon_restart.ts`) reads it back with
 * `/merge-conflict-failed\s+n="(\d+)"/`.
 */
export function conflictFailedMarker(
  attemptNumber: number,
  pass: ConflictResolutionPass,
  headSha: string,
): string {
  return `${CONFLICT_FAILED_MARKER} ${attemptNumberAttribute(attemptNumber)} ` +
    `pass="${pass}" ${headAttribute("head", headSha)} -->`;
}

/** The marker line for one attempt that merged successfully, naming its pass and the head it ran against. */
export function conflictResolvedMarker(
  pass: ConflictResolutionPass,
  headSha: string,
): string {
  return `${CONFLICT_RESOLVED_MARKER} pass="${pass}" ` +
    `${headAttribute("head", headSha)} -->`;
}

/** The pass a marker's own text carries, or `"ladder"` when absent/unrecognised. */
function readConflictPass(markerText: string): ConflictResolutionPass {
  const written = /pass="([^"]*)"/.exec(markerText)?.[1];
  return isConflictResolutionPass(written) ? written : "ladder";
}

/** The head sha a marker's own text carries, lowercased, or `undefined` when absent/unusable. */
function readConflictHead(markerText: string): string | undefined {
  const written = /head="([^"]*)"/.exec(markerText)?.[1];
  if (written === undefined) return undefined;
  const head = written.trim().toLowerCase();
  return isConflictHeadSha(head) ? head : undefined;
}

/** The epoch ms a comment's `created_at` carries, or `undefined` when unparseable. */
function readCommentAtMs(
  comment: { created_at?: unknown },
): number | undefined {
  if (typeof comment.created_at !== "string") return undefined;
  const parsed = Date.parse(comment.created_at);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Read the shared conflict-resolution attempt history out of a PR's comment
 * thread (Issue #2996).
 *
 * This is the **PR-side tally** the shared budget is spent against — never
 * host-local state (Issue #2919) — so every pass that might spend from
 * {@link CONFLICT_RESOLUTION_BUDGET} reads the same list back, regardless of
 * which host or which pass is asking.
 *
 * Walks oldest first, mirroring `parseConflictAttempts` in
 * `pr_merge_conflict_scan.ts`: a resolved marker, then a failed marker, then
 * an attempt marker, in that order per comment. A conclusion marker always
 * counts, even with no open attempt before it — the conservative direction —
 * and a conclusion only overwrites an open attempt's `pass`/`headSha` when
 * the conclusion marker itself carries them, so a legacy conclusion with no
 * `pass=` cannot erase an attributed attempt's pass.
 *
 * Author-blind beyond the `isTrustedAuthor` check passed in: a comment with
 * no readable login, or whose login is rejected, is ignored entirely —
 * matching the author-filtering discipline `conflict_marker_trust.ts`
 * documents for this vocabulary.
 *
 * @param comments - Raw REST comment objects, oldest first.
 * @param isTrustedAuthor - Predicate a comment's `user.login` must pass for
 *   its markers to be read at all.
 * @returns The full attempt list, in thread order. Resets (a resolved
 *   marker clearing everything before it) are the caller's business, not
 *   this function's.
 */
export function readResolutionAttempts(
  comments: readonly unknown[],
  isTrustedAuthor: (login: string) => boolean,
): ConflictResolutionAttempt[] {
  const attempts: ConflictResolutionAttempt[] = [];

  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const comment = raw as { body?: unknown; created_at?: unknown };
    if (typeof comment.body !== "string") continue;

    const author = conflictCommentAuthor(raw);
    if (author === undefined || !isTrustedAuthor(author)) continue;

    const body = comment.body;

    const resolvedAt = body.indexOf(CONFLICT_RESOLVED_MARKER);
    const failedAt = body.indexOf(CONFLICT_FAILED_MARKER);
    const attemptAt = body.indexOf(CONFLICT_ATTEMPT_MARKER);

    let conclusionAt = -1;
    let outcome: "failed" | "resolved" | undefined;
    if (resolvedAt >= 0) {
      conclusionAt = resolvedAt;
      outcome = "resolved";
    } else if (failedAt >= 0) {
      conclusionAt = failedAt;
      outcome = "failed";
    }

    if (outcome !== undefined) {
      const markerText = body.slice(
        conclusionAt,
        (() => {
          const end = body.indexOf("-->", conclusionAt);
          return end >= 0 ? end + "-->".length : body.length;
        })(),
      );
      const pass = readConflictPass(markerText);
      const headSha = readConflictHead(markerText);
      const atMs = readCommentAtMs(comment);

      const last = attempts[attempts.length - 1];
      if (last !== undefined && last.outcome === "open") {
        last.outcome = outcome;
        if (atMs !== undefined) last.atMs = atMs;
        if (/pass="/.test(markerText)) last.pass = pass;
        if (headSha !== undefined) last.headSha = headSha;
      } else {
        attempts.push({ pass, atMs, headSha, outcome });
      }
      continue;
    }

    if (attemptAt < 0) continue;

    const end = body.indexOf("-->", attemptAt);
    const markerText = body.slice(
      attemptAt,
      end >= 0 ? end + "-->".length : body.length,
    );
    attempts.push({
      pass: readConflictPass(markerText),
      atMs: readCommentAtMs(comment),
      headSha: readConflictHead(markerText),
      outcome: "open",
    });
  }

  return attempts;
}
