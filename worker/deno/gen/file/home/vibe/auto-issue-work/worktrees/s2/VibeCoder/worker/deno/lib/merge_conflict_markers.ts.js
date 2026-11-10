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
 */ import { conflictCommentAuthor } from "./conflict_marker_trust.ts";
/**
 * Resolution attempts one PR gets across every pass — ladder, milestone sync
 * and takeover (Issue #2996). Single source of truth: every pass that spends
 * from this shared budget imports it rather than hard-coding its own count.
 */ export const CONFLICT_RESOLUTION_BUDGET = 3;
/**
 * Hours a failed attempt leaves the PR to its owner before the next attempt
 * is due, unless the head moves first (Issue #2996).
 */ export const CONFLICT_OWNER_CHECK_HOURS = 2;
/**
 * Visible queue label applied to every PR found CONFLICTING (Issue #84).
 *
 * Here rather than in the scan that applies it (Issue #2310): the fallback
 * context reads the label's own `labeled` timeline event to date a divergence,
 * and the scan imports *it*, so the label had to live where both can reach it
 * without a cycle. `pr_merge_conflict_scan.ts` re-exports it, so every existing
 * importer keeps its import path.
 */ export const MERGE_CONFLICT_LABEL = "merge-conflict";
/** Marker that identifies one recorded conflict-resolution attempt. */ export const CONFLICT_ATTEMPT_MARKER = "<!-- vibe-coder:merge-conflict-attempt";
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
 */ export const CONFLICT_RESOLVED_MARKER = "<!-- vibe-coder:merge-conflict-resolved";
/**
 * Marker posted when an attempt reached a merge conclusion and failed
 * (Issue #395). It is what turns an opened attempt into a *spent* one — an
 * attempt marker with no conclusion after it was disrupted, not judged.
 */ export const CONFLICT_FAILED_MARKER = "<!-- vibe-coder:merge-conflict-failed";
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
 */ /** A 7-to-40 character lowercase git object name, as a marker may carry. */ const HEAD_SHA_PATTERN = /^[0-9a-f]{7,40}$/;
/**
 * Whether a value is a head sha these markers may carry.
 *
 * Exported so the writer and the reader agree on what a usable sha is: two
 * copies of the pattern would let a marker be written that the ladder then
 * discards, which is a rung that runs again at the same head.
 */ export function isConflictHeadSha(value) {
  return HEAD_SHA_PATTERN.test(value);
}
/**
 * Marker posted by the nudge rung.
 *
 * `head` is the sha the nudge **produced** — the head GitHub reports next —
 * not the head it started from. The ladder is keyed on the current head, so a
 * marker naming the pre-nudge head would leave the new head unnamed and nudge
 * it again on the following scan, which is the loop this ladder ends.
 */ export const CONFLICT_NUDGE_MARKER = "<!-- vibe-merge-conflict-nudge";
/** Marker posted by the rebase rung, naming the head it replaced and the new one. */ export const CONFLICT_REBASE_MARKER = "<!-- vibe-merge-conflict-rebase";
/** Marker posted when a rung ran at a head sha and failed. */ export const CONFLICT_RUNG_FAILED_MARKER = "<!-- vibe-merge-conflict-rung-failed";
/**
 * The sha as a marker attribute, or a throw.
 *
 * Fails loud rather than writing an attribute the reader will discard: a
 * marker nobody can read back is a rung that runs again at the same head,
 * which is the loop this ladder exists to break.
 */ function headAttribute(name, sha) {
  const trimmed = sha.trim().toLowerCase();
  if (!isConflictHeadSha(trimmed)) {
    throw new Error(`Refusing to write a merge-conflict rung marker with ${name}="${sha}" ` + "— a head sha must be 7–40 hex characters");
  }
  return `${name}="${trimmed}"`;
}
/** The marker line for one nudged head. */ export function conflictNudgeMarker(head) {
  return `${CONFLICT_NUDGE_MARKER} ${headAttribute("head", head)} -->`;
}
/**
 * The marker line for one rebase, naming the head it replaced.
 *
 * Legacy — the rebase rung was dropped in Issue #2842, so nothing in
 * production posts this any more. Kept only because tests still forge a
 * legacy marker with it to prove the ladder still reads old threads back
 * correctly.
 */ export function conflictRebaseMarker(oldHead, newHead) {
  return `${CONFLICT_REBASE_MARKER} ${headAttribute("old", oldHead)} ` + `${headAttribute("new", newHead)} -->`;
}
/** The marker line for one rung that ran at a head sha and failed. */ export function conflictRungFailedMarker(rung, head) {
  return `${CONFLICT_RUNG_FAILED_MARKER} rung="${rung}" ` + `${headAttribute("head", head)} -->`;
}
// ---------------------------------------------------------------------------
// Parking (Issue #2312)
// ---------------------------------------------------------------------------
/**
 * Marker that once recorded a PR **parked** on `merge-conflict` (Issue #2312).
 *
 * **Legacy and read-only (Issue #3166).** Nothing writes it any more: the scan's
 * park path was unreachable once abandon-and-redo lost its restart cap (Issue
 * #3033), and a declined abandon now ends as `budget-spent` instead. The scan
 * and the stall watchdog still read the markers already posted, so a PR parked
 * before the change keeps waiting on its base rather than being retried at once.
 *
 * **Keyed on the `base` sha, not the head**, which is what makes the wait end.
 * Every other marker in this vocabulary keys on the head, because every other
 * rung acts on the head. Here nothing acts at all until the *base* tip moves:
 * a base that has not moved cannot merge any better than it did an hour ago,
 * and a base that has moved is a genuinely different merge, worth a fresh
 * two-run budget.
 */ export const CONFLICT_PARKED_MARKER = "<!-- vibe-merge-conflict-parked";
/**
 * A no-op watchdog check (Issue #3001 review). A declined abandon and a
 * reused fix PR post nothing else, so without this the same PR trips again
 * on every cycle. The `at="…"` is what {@link readLatestStandDownAtMs}
 * restarts the owner-check clock from.
 */ export const CONFLICT_WATCHDOG_CHECKED_MARKER = "<!-- vibe-conflict-watchdog-checked";
/** The marker line for one no-op watchdog check, naming when it ran. */ export function conflictWatchdogCheckedMarker(atMs) {
  return `${CONFLICT_WATCHDOG_CHECKED_MARKER} ${standDownAtAttribute(atMs)} -->`;
}
/**
 * The `at="…"` attribute every stand-down marker carries, naming the moment
 * the stand-down was posted (Issue #2997) — shared by this module's
 * {@link conflictParkedMarker} and `gated_head_guard.ts`'s own markers so the
 * grammar cannot drift between them.
 *
 * Throws on a non-finite `standDownAtMs`: a marker nobody can read back is a
 * stand-down that never ends.
 */ export function standDownAtAttribute(standDownAtMs) {
  if (!Number.isFinite(standDownAtMs)) {
    throw new Error(`Refusing to write a stand-down marker with at="${standDownAtMs}" — ` + "the stand-down time must be finite");
  }
  return `at="${new Date(standDownAtMs).toISOString()}"`;
}
/**
 * The marker line for one parked PR, naming the base tip it is waiting on
 * and, when `standDownAtMs` is given, the moment the park started (Issue
 * #2997) — the stall watchdog's `at="…"` reads back by
 * {@link readLatestStandDownAtMs} in `gated_head_guard.ts`.
 */ export function conflictParkedMarker(base, standDownAtMs) {
  // `headAttribute` validates a git object name, whichever end it names: a
  // marker the reader would discard is a park that never ends.
  const atAttribute = standDownAtMs === undefined ? "" : ` ${standDownAtAttribute(standDownAtMs)}`;
  return `${CONFLICT_PARKED_MARKER} ${headAttribute("base", base)}${atAttribute} -->`;
}
/**
 * The most recent park marker in a comment thread, or `null`.
 *
 * **Only safe on a thread already reduced to the fleet's own comments**
 * (`conflict_marker_trust.ts`): a park marker suppresses every later attempt,
 * so one anybody could post would be a way to silence a PR's queue for ever.
 *
 * A marker whose `base` cannot be read is treated as no park at all, so the PR
 * follows the uncapped abandon-and-redo path (Issue #3166) rather than staying
 * parked on a sha nothing can ever match. Nothing re-records a park: the marker
 * is legacy and read-only.
 *
 * @param comments - Raw REST comment objects, oldest first, fleet-authored.
 * @returns The newest readable park record, with its index in `comments`.
 */ export function readParkedBase(comments) {
  let found = null;
  for(let index = 0; index < comments.length; index++){
    const raw = comments[index];
    if (typeof raw !== "object" || raw === null) continue;
    const body = raw.body;
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
    found = {
      base,
      index
    };
  }
  return found;
}
/**
 * The comments that count toward the current conflict's budget.
 *
 * A park marker ends the previous merge. Failures before it belong to a
 * base that no longer exists, so a retry after that base moves starts from
 * a fresh budget (Issue #2312). The scan and the under-lock re-read both
 * use this, so they cannot disagree about which comments count.
 *
 * **Only safe on a thread already reduced to the fleet's own comments.**
 */ export function commentsAfterConflictPark(comments) {
  const park = readParkedBase(comments);
  if (park === null) return comments;
  return comments.slice(park.index + 1);
}
// ---------------------------------------------------------------------------
// The shared resolution budget (Issue #2996)
// ---------------------------------------------------------------------------
/** The passes a `pass="…"` attribute may legitimately name. */ const CONFLICT_RESOLUTION_PASSES = [
  "ladder",
  "sync",
  "takeover"
];
/** Whether a value is one of the recognised pass names, narrowing the type. */ function isConflictResolutionPass(value) {
  return value !== undefined && CONFLICT_RESOLUTION_PASSES.includes(value);
}
/** The positive-integer attempt number as a marker attribute, or a throw. */ function attemptNumberAttribute(attemptNumber) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error(`Refusing to write a merge-conflict attempt marker with n="${attemptNumber}" ` + "— the attempt number must be a positive integer");
  }
  return `n="${attemptNumber}"`;
}
/** The marker line for one opened attempt, naming its pass and the head it ran against. */ export function conflictAttemptMarker(attemptNumber, pass, headSha) {
  return `${CONFLICT_ATTEMPT_MARKER} ${attemptNumberAttribute(attemptNumber)} ` + `pass="${pass}" ${headAttribute("head", headSha)} -->`;
}
/**
 * The marker line for one attempt that reached a merge conclusion and
 * failed, naming its pass and the head it ran against.
 *
 * `n="…"` stays first and whitespace-separated from the rest: the abandon
 * rung (`conflict_abandon_restart.ts`) reads it back with
 * `/merge-conflict-failed\s+n="(\d+)"/`.
 */ export function conflictFailedMarker(attemptNumber, pass, headSha) {
  return `${CONFLICT_FAILED_MARKER} ${attemptNumberAttribute(attemptNumber)} ` + `pass="${pass}" ${headAttribute("head", headSha)} -->`;
}
/** The marker line for one attempt that merged successfully, naming its pass and the head it ran against. */ export function conflictResolvedMarker(pass, headSha) {
  return `${CONFLICT_RESOLVED_MARKER} pass="${pass}" ` + `${headAttribute("head", headSha)} -->`;
}
/** The pass a marker's own text carries, or `"ladder"` when absent/unrecognised. */ function readConflictPass(markerText) {
  const written = /pass="([^"]*)"/.exec(markerText)?.[1];
  return isConflictResolutionPass(written) ? written : "ladder";
}
/** The head sha a marker's own text carries, lowercased, or `undefined` when absent/unusable. */ function readConflictHead(markerText) {
  const written = /head="([^"]*)"/.exec(markerText)?.[1];
  if (written === undefined) return undefined;
  const head = written.trim().toLowerCase();
  return isConflictHeadSha(head) ? head : undefined;
}
/** The epoch ms a comment's `created_at` carries, or `undefined` when unparseable. */ function readCommentAtMs(comment) {
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
 */ export function readResolutionAttempts(comments, isTrustedAuthor) {
  const attempts = [];
  for (const raw of comments){
    if (typeof raw !== "object" || raw === null) continue;
    const comment = raw;
    if (typeof comment.body !== "string") continue;
    const author = conflictCommentAuthor(raw);
    if (author === undefined || !isTrustedAuthor(author)) continue;
    const body = comment.body;
    const resolvedAt = body.indexOf(CONFLICT_RESOLVED_MARKER);
    const failedAt = body.indexOf(CONFLICT_FAILED_MARKER);
    const attemptAt = body.indexOf(CONFLICT_ATTEMPT_MARKER);
    let conclusionAt = -1;
    let outcome;
    if (resolvedAt >= 0) {
      conclusionAt = resolvedAt;
      outcome = "resolved";
    } else if (failedAt >= 0) {
      conclusionAt = failedAt;
      outcome = "failed";
    }
    if (outcome !== undefined) {
      const markerText = body.slice(conclusionAt, (()=>{
        const end = body.indexOf("-->", conclusionAt);
        return end >= 0 ? end + "-->".length : body.length;
      })());
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
        attempts.push({
          pass,
          atMs,
          headSha,
          outcome
        });
      }
      continue;
    }
    if (attemptAt < 0) continue;
    const end = body.indexOf("-->", attemptAt);
    const markerText = body.slice(attemptAt, end >= 0 ? end + "-->".length : body.length);
    attempts.push({
      pass: readConflictPass(markerText),
      atMs: readCommentAtMs(comment),
      headSha: readConflictHead(markerText),
      outcome: "open"
    });
  }
  return attempts;
}
/**
 * Failed attempts spent against the shared budget since the last resolved
 * one (Issue #2996).
 *
 * A resolved marker resets the tally to zero — attempts before a successful
 * merge belong to a conflict that is already over — so this walks the full
 * list, oldest first, and counts `failed` outcomes after the most recent
 * `resolved`. Every pass counts here: the stale-verdict ladder, the milestone
 * sync and the takeover rung all spend from the same number.
 *
 * @param attempts - From {@link readResolutionAttempts}.
 */ export function spentConflictAttempts(attempts) {
  let count = 0;
  for (const attempt of attempts){
    if (attempt.outcome === "resolved") {
      count = 0;
      continue;
    }
    if (attempt.outcome === "failed") count++;
  }
  return count;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9tZXJnZV9jb25mbGljdF9tYXJrZXJzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIG1lcmdlLWNvbmZsaWN0IG1hcmtlciB2b2NhYnVsYXJ5IChJc3N1ZXMgIzg0LCAjMzk1LCAjMTExNSkuXG4gKlxuICogQSBsZWFmIG1vZHVsZSBvbiBwdXJwb3NlLiBBdHRlbXB0IGhpc3RvcnkgbGl2ZXMgaW4gbWFya2VyIGNvbW1lbnRzIG9uIHRoZVxuICogUFIgaXRzZWxmIHJhdGhlciB0aGFuIGluIGhvc3QtbG9jYWwgc3RhdGUsIHNvIHNldmVyYWwgbW9kdWxlcyByZWFkIHRoZSBzYW1lXG4gKiB0aHJlZSBtYXJrZXJzIGJhY2s6IHRoZSBzY2FuLCB0aGUgcmVzb2x1dGlvbiBwcm9jZXNzb3IsIHRoZSBzdGFsbCB3YXRjaGRvZyxcbiAqIHRoZSBkZWZlcnJhbCB0cmFja2VyLCBhbmQgdGhlIGFiYW5kb24tYW5kLXJlc3RhcnQgcnVuZy4gS2VlcGluZyB0aGUgbGl0ZXJhbHNcbiAqIGhlcmUg4oCUIHJhdGhlciB0aGFuIGluIHdoaWNoZXZlciBtb2R1bGUgaGFwcGVuZWQgdG8gbmVlZCB0aGVtIGZpcnN0IOKAlCBpcyB3aGF0XG4gKiBsZXRzIHRob3NlIG1vZHVsZXMgZGVwZW5kIG9uIHRoZSB2b2NhYnVsYXJ5IHdpdGhvdXQgZGVwZW5kaW5nIG9uIGVhY2ggb3RoZXIuXG4gKlxuICogVGhlIGB2aWJlLWNvZGVyOmAgc2hhcGVzIGJlbG93IGRldmlhdGUgZnJvbSB0aGUgY2Fub25pY2FsIGB2aWJlLSpgIGdyYW1tYXJcbiAqIGFuZCBhcmUgKipmcm96ZW4qKiByYXRoZXIgdGhhbiBmaXhlZCAoSXNzdWUgIzg0Mik6IGV2ZXJ5IG9uZSBpcyByZWFkIGJhY2sgb3V0XG4gKiBvZiBjb21tZW50cyBhbHJlYWR5IHBvc3RlZCwgc28gcmVuYW1pbmcgYW55IG9mIHRoZW0gbWFrZXMgZXZlcnkgbWFya2VyIGluXG4gKiB0aGUgd2lsZCBpbnZpc2libGUgdG8gaXRzIGd1YXJkLlxuICpcbiAqIElzc3VlICMyOTk2IGFkZHMgYHBhc3M9XCLigKZcImAgdG8gdGhlIGF0dGVtcHQvZmFpbGVkL3Jlc29sdmVkIG1hcmtlcnMgYW5kIGFcbiAqIHNoYXJlZCB7QGxpbmsgQ09ORkxJQ1RfUkVTT0xVVElPTl9CVURHRVR9OiBvbmUgUFIgZ2V0cyB0aHJlZSByZXNvbHV0aW9uXG4gKiBhdHRlbXB0cyBpbiB0b3RhbCwgdGFsbGllZCBhcyBtYXJrZXJzIG9uIHRoZSBQUiByZWdhcmRsZXNzIG9mIHdoaWNoIHBhc3NcbiAqIOKAlCB0aGUgc3RhbGUtdmVyZGljdCBsYWRkZXIsIHRoZSBtaWxlc3RvbmUgc3luYyBvciB0aGUgdGFrZW92ZXIgcnVuZyDigJQgc3BlbnRcbiAqIGVhY2ggb25lLCBzbyB0aGUgYnVkZ2V0IGNhbm5vdCBiZSBtdWx0aXBsaWVkIGp1c3QgYnkgcm91dGluZyB0aGUgc2FtZSBQUlxuICogdGhyb3VnaCBtb3JlIHRoYW4gb25lIHBhc3MuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHsgY29uZmxpY3RDb21tZW50QXV0aG9yIH0gZnJvbSBcIi4vY29uZmxpY3RfbWFya2VyX3RydXN0LnRzXCI7XG5cbi8qKlxuICogUmVzb2x1dGlvbiBhdHRlbXB0cyBvbmUgUFIgZ2V0cyBhY3Jvc3MgZXZlcnkgcGFzcyDigJQgbGFkZGVyLCBtaWxlc3RvbmUgc3luY1xuICogYW5kIHRha2VvdmVyIChJc3N1ZSAjMjk5NikuIFNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGg6IGV2ZXJ5IHBhc3MgdGhhdCBzcGVuZHNcbiAqIGZyb20gdGhpcyBzaGFyZWQgYnVkZ2V0IGltcG9ydHMgaXQgcmF0aGVyIHRoYW4gaGFyZC1jb2RpbmcgaXRzIG93biBjb3VudC5cbiAqL1xuZXhwb3J0IGNvbnN0IENPTkZMSUNUX1JFU09MVVRJT05fQlVER0VUID0gMztcblxuLyoqXG4gKiBIb3VycyBhIGZhaWxlZCBhdHRlbXB0IGxlYXZlcyB0aGUgUFIgdG8gaXRzIG93bmVyIGJlZm9yZSB0aGUgbmV4dCBhdHRlbXB0XG4gKiBpcyBkdWUsIHVubGVzcyB0aGUgaGVhZCBtb3ZlcyBmaXJzdCAoSXNzdWUgIzI5OTYpLlxuICovXG5leHBvcnQgY29uc3QgQ09ORkxJQ1RfT1dORVJfQ0hFQ0tfSE9VUlMgPSAyO1xuXG4vKiogVGhlIHBhc3MgdGhhdCByYW4gYSBnaXZlbiBjb25mbGljdC1yZXNvbHV0aW9uIGF0dGVtcHQgKElzc3VlICMyOTk2KS4gKi9cbmV4cG9ydCB0eXBlIENvbmZsaWN0UmVzb2x1dGlvblBhc3MgPSBcImxhZGRlclwiIHwgXCJzeW5jXCIgfCBcInRha2VvdmVyXCI7XG5cbi8qKiBIb3cgb25lIHJlY29yZGVkIGNvbmZsaWN0LXJlc29sdXRpb24gYXR0ZW1wdCBjb25jbHVkZWQgKElzc3VlICMyOTk2KS4gKi9cbmV4cG9ydCB0eXBlIENvbmZsaWN0QXR0ZW1wdE91dGNvbWUgPSBcIm9wZW5cIiB8IFwiZmFpbGVkXCIgfCBcInJlc29sdmVkXCI7XG5cbi8qKlxuICogT25lIGF0dGVtcHQgYXMgcmVhZCBiYWNrIG91dCBvZiBhIFBSJ3MgY29tbWVudCB0aHJlYWQgKElzc3VlICMyOTk2KS5cbiAqXG4gKiBBdHRyaWJ1dGVkIGJ5IHtAbGluayByZWFkUmVzb2x1dGlvbkF0dGVtcHRzfSwgbm90IHdyaXR0ZW4gZGlyZWN0bHkg4oCUIHRoZVxuICogd3JpdGVycyBiZWxvdyBwcm9kdWNlIHRoZSBtYXJrZXIgdGV4dDsgdGhpcyBpcyB0aGUgcGFyc2VkIHNoYXBlIHRoZSBzaGFyZWRcbiAqIGJ1ZGdldCBpcyB0YWxsaWVkIGZyb20uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29uZmxpY3RSZXNvbHV0aW9uQXR0ZW1wdCB7XG4gIC8qKiBUaGUgcGFzcyB0aGF0IHJhbiBpdDsgYSBsZWdhY3kgbWFya2VyIHdpdGggbm8gKG9yIGFuIHVucmVjb2duaXNlZCkgYHBhc3M9YCByZWFkcyBhcyBgbGFkZGVyYC4gKi9cbiAgcGFzczogQ29uZmxpY3RSZXNvbHV0aW9uUGFzcztcbiAgLyoqXG4gICAqIEVwb2NoIG1zIG9mIHRoZSBhdHRlbXB0J3MgbGF0ZXN0IG1hcmtlciAoaXRzIGNvbmNsdXNpb24gb25jZSBjb25jbHVkZWQpO1xuICAgKiB1bmRlZmluZWQgd2hlbiB0aGUgY29tbWVudCBjYXJyaWVzIG5vIHBhcnNlYWJsZSBgY3JlYXRlZF9hdGAuXG4gICAqL1xuICBhdE1zOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKiBIZWFkIHNoYSB0aGUgYXR0ZW1wdCByYW4gYWdhaW5zdCwgbG93ZXJjYXNlZDsgdW5kZWZpbmVkIG9uIGEgbGVnYWN5IG1hcmtlciBvciBhbiB1bnJlYWRhYmxlIHZhbHVlLiAqL1xuICBoZWFkU2hhOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIG91dGNvbWU6IENvbmZsaWN0QXR0ZW1wdE91dGNvbWU7XG59XG5cbi8qKlxuICogVmlzaWJsZSBxdWV1ZSBsYWJlbCBhcHBsaWVkIHRvIGV2ZXJ5IFBSIGZvdW5kIENPTkZMSUNUSU5HIChJc3N1ZSAjODQpLlxuICpcbiAqIEhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHNjYW4gdGhhdCBhcHBsaWVzIGl0IChJc3N1ZSAjMjMxMCk6IHRoZSBmYWxsYmFja1xuICogY29udGV4dCByZWFkcyB0aGUgbGFiZWwncyBvd24gYGxhYmVsZWRgIHRpbWVsaW5lIGV2ZW50IHRvIGRhdGUgYSBkaXZlcmdlbmNlLFxuICogYW5kIHRoZSBzY2FuIGltcG9ydHMgKml0Kiwgc28gdGhlIGxhYmVsIGhhZCB0byBsaXZlIHdoZXJlIGJvdGggY2FuIHJlYWNoIGl0XG4gKiB3aXRob3V0IGEgY3ljbGUuIGBwcl9tZXJnZV9jb25mbGljdF9zY2FuLnRzYCByZS1leHBvcnRzIGl0LCBzbyBldmVyeSBleGlzdGluZ1xuICogaW1wb3J0ZXIga2VlcHMgaXRzIGltcG9ydCBwYXRoLlxuICovXG5leHBvcnQgY29uc3QgTUVSR0VfQ09ORkxJQ1RfTEFCRUwgPSBcIm1lcmdlLWNvbmZsaWN0XCI7XG5cbi8qKiBNYXJrZXIgdGhhdCBpZGVudGlmaWVzIG9uZSByZWNvcmRlZCBjb25mbGljdC1yZXNvbHV0aW9uIGF0dGVtcHQuICovXG5leHBvcnQgY29uc3QgQ09ORkxJQ1RfQVRURU1QVF9NQVJLRVIgPSBcIjwhLS0gdmliZS1jb2RlcjptZXJnZS1jb25mbGljdC1hdHRlbXB0XCI7XG5cbi8qKlxuICogTWFya2VyIHBvc3RlZCB3aGVuIGFuIGF0dGVtcHQgbWVyZ2VkIHN1Y2Nlc3NmdWxseS4gRXZlcnl0aGluZyBiZWZvcmUgaXRcbiAqIGJlbG9uZ3MgdG8gYSBjb25mbGljdCB0aGF0IGlzIGFscmVhZHkgcmVzb2x2ZWQsIHNvIHRoZSBhdHRlbXB0IGJ1ZGdldFxuICogcmVzdGFydHMgZnJvbSBpdCDigJQgYSBQUiB0aGF0IGNvbmZsaWN0cyBhZ2FpbiBtb250aHMgbGF0ZXIgZ2V0cyBhIGZ1bGxcbiAqIGJ1ZGdldCByYXRoZXIgdGhhbiBpbmhlcml0aW5nIGEgc3BlbnQgb25lLlxuICpcbiAqIEEgKipwcmVmaXgqKiwgbm90IGEgY29tcGxldGUgdGFnIChJc3N1ZSAjMjk5Nikg4oCUIG1hdGNoaW5nIGhvd1xuICoge0BsaW5rIENPTkZMSUNUX0FUVEVNUFRfTUFSS0VSfSBhbmQge0BsaW5rIENPTkZMSUNUX0ZBSUxFRF9NQVJLRVJ9IGFyZVxuICogYWxyZWFkeSBwcmVmaXhlcyDigJQgc28gdGhhdCBgYm9keS5pbmNsdWRlcyhDT05GTElDVF9SRVNPTFZFRF9NQVJLRVIpYCBrZWVwc1xuICogbWF0Y2hpbmcgYm90aCBhIGxlZ2FjeSBgPCEtLSB2aWJlLWNvZGVyOm1lcmdlLWNvbmZsaWN0LXJlc29sdmVkIC0tPmAgYm9keVxuICogYW5kIHRoZSBuZXcgYHBhc3M9XCLigKZcIiBoZWFkPVwi4oCmXCJgLWF0dHJpYnV0ZWQgbWFya2VyXG4gKiB7QGxpbmsgY29uZmxpY3RSZXNvbHZlZE1hcmtlcn0gd3JpdGVzLlxuICovXG5leHBvcnQgY29uc3QgQ09ORkxJQ1RfUkVTT0xWRURfTUFSS0VSID1cbiAgXCI8IS0tIHZpYmUtY29kZXI6bWVyZ2UtY29uZmxpY3QtcmVzb2x2ZWRcIjtcblxuLyoqXG4gKiBNYXJrZXIgcG9zdGVkIHdoZW4gYW4gYXR0ZW1wdCByZWFjaGVkIGEgbWVyZ2UgY29uY2x1c2lvbiBhbmQgZmFpbGVkXG4gKiAoSXNzdWUgIzM5NSkuIEl0IGlzIHdoYXQgdHVybnMgYW4gb3BlbmVkIGF0dGVtcHQgaW50byBhICpzcGVudCogb25lIOKAlCBhblxuICogYXR0ZW1wdCBtYXJrZXIgd2l0aCBubyBjb25jbHVzaW9uIGFmdGVyIGl0IHdhcyBkaXNydXB0ZWQsIG5vdCBqdWRnZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBDT05GTElDVF9GQUlMRURfTUFSS0VSID0gXCI8IS0tIHZpYmUtY29kZXI6bWVyZ2UtY29uZmxpY3QtZmFpbGVkXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGhlIHN0YWxlLXZlcmRpY3QgbGFkZGVyIChJc3N1ZXMgIzIyNzIsICMyMjc2KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qXG4gKiBUaGUgdGhyZWUgbWFya2VycyBiZWxvdyBhcmUgdGhlIHJ1bmdzIHRoZSByZXNvbHZlciBjbGltYnMgd2hlbiBHaXRIdWInc1xuICogYENPTkZMSUNUSU5HYCB2ZXJkaWN0IGlzIHN0YWxlIOKAlCB0aGUgbG9vcCBORUFULUFJLUxhbWFyY2sjMjM5IHNhdCBpbi4gVGhleVxuICogcmVjb3JkIHdoaWNoIHJ1bmcgYWxyZWFkeSByYW4gYXQgd2hpY2ggaGVhZCBzaGEsIHdoaWNoIGlzIHdoYXQgYm91bmRzIGVhY2hcbiAqIHJ1bmcgdG8gb25lIHJ1biBwZXIgaGVhZC5cbiAqXG4gKiBDYW5vbmljYWwgYHZpYmUtKmAgZ3JhbW1hciDigJQgYSBiYXJlIGB2aWJlLWAgcHJlZml4IGFuZCBga2V5PVwidmFsdWVcImBcbiAqIGF0dHJpYnV0ZXMgKElzc3VlICM4NDIpLiBUaGUgZnJvemVuIGB2aWJlLWNvZGVyOmAgc2hhcGVzIGFib3ZlIGFyZSBmcm96ZW5cbiAqIG9ubHkgYmVjYXVzZSBsaXZlIHRocmVhZHMgYWxyZWFkeSBjYXJyeSB0aGVtOyB0aGVzZSBhcmUgbmV3LCBzbyB0aGV5IGFyZVxuICogd3JpdHRlbiB0aGUgY2Fub25pY2FsIHdheS5cbiAqXG4gKiBObyBydW5nIG5hbWUgY29udGFpbnMgYW4gYXR0ZW1wdC12b2NhYnVsYXJ5IGxpdGVyYWwsIGFuZCBub25lIG9mIHRoZSB0aHJlZVxuICogY29udGFpbnMgYW5vdGhlciwgc28gYSBydW5nIG1hcmtlciBpcyBpbnZpc2libGUgdG8gYHBhcnNlQ29uZmxpY3RBdHRlbXB0c2BcbiAqIGFuZCB0byBpdHMgc2libGluZ3M6IGEgcnVuZyBuZWl0aGVyIHNwZW5kcyBub3IgcmVzZXRzIHRoZSBhdHRlbXB0IGJ1ZGdldC5cbiAqL1xuXG4vKiogQSA3LXRvLTQwIGNoYXJhY3RlciBsb3dlcmNhc2UgZ2l0IG9iamVjdCBuYW1lLCBhcyBhIG1hcmtlciBtYXkgY2FycnkuICovXG5jb25zdCBIRUFEX1NIQV9QQVRURVJOID0gL15bMC05YS1mXXs3LDQwfSQvO1xuXG4vKipcbiAqIFdoZXRoZXIgYSB2YWx1ZSBpcyBhIGhlYWQgc2hhIHRoZXNlIG1hcmtlcnMgbWF5IGNhcnJ5LlxuICpcbiAqIEV4cG9ydGVkIHNvIHRoZSB3cml0ZXIgYW5kIHRoZSByZWFkZXIgYWdyZWUgb24gd2hhdCBhIHVzYWJsZSBzaGEgaXM6IHR3b1xuICogY29waWVzIG9mIHRoZSBwYXR0ZXJuIHdvdWxkIGxldCBhIG1hcmtlciBiZSB3cml0dGVuIHRoYXQgdGhlIGxhZGRlciB0aGVuXG4gKiBkaXNjYXJkcywgd2hpY2ggaXMgYSBydW5nIHRoYXQgcnVucyBhZ2FpbiBhdCB0aGUgc2FtZSBoZWFkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNDb25mbGljdEhlYWRTaGEodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gSEVBRF9TSEFfUEFUVEVSTi50ZXN0KHZhbHVlKTtcbn1cblxuLyoqXG4gKiBNYXJrZXIgcG9zdGVkIGJ5IHRoZSBudWRnZSBydW5nLlxuICpcbiAqIGBoZWFkYCBpcyB0aGUgc2hhIHRoZSBudWRnZSAqKnByb2R1Y2VkKiog4oCUIHRoZSBoZWFkIEdpdEh1YiByZXBvcnRzIG5leHQg4oCUXG4gKiBub3QgdGhlIGhlYWQgaXQgc3RhcnRlZCBmcm9tLiBUaGUgbGFkZGVyIGlzIGtleWVkIG9uIHRoZSBjdXJyZW50IGhlYWQsIHNvIGFcbiAqIG1hcmtlciBuYW1pbmcgdGhlIHByZS1udWRnZSBoZWFkIHdvdWxkIGxlYXZlIHRoZSBuZXcgaGVhZCB1bm5hbWVkIGFuZCBudWRnZVxuICogaXQgYWdhaW4gb24gdGhlIGZvbGxvd2luZyBzY2FuLCB3aGljaCBpcyB0aGUgbG9vcCB0aGlzIGxhZGRlciBlbmRzLlxuICovXG5leHBvcnQgY29uc3QgQ09ORkxJQ1RfTlVER0VfTUFSS0VSID0gXCI8IS0tIHZpYmUtbWVyZ2UtY29uZmxpY3QtbnVkZ2VcIjtcblxuLyoqIE1hcmtlciBwb3N0ZWQgYnkgdGhlIHJlYmFzZSBydW5nLCBuYW1pbmcgdGhlIGhlYWQgaXQgcmVwbGFjZWQgYW5kIHRoZSBuZXcgb25lLiAqL1xuZXhwb3J0IGNvbnN0IENPTkZMSUNUX1JFQkFTRV9NQVJLRVIgPSBcIjwhLS0gdmliZS1tZXJnZS1jb25mbGljdC1yZWJhc2VcIjtcblxuLyoqIE1hcmtlciBwb3N0ZWQgd2hlbiBhIHJ1bmcgcmFuIGF0IGEgaGVhZCBzaGEgYW5kIGZhaWxlZC4gKi9cbmV4cG9ydCBjb25zdCBDT05GTElDVF9SVU5HX0ZBSUxFRF9NQVJLRVIgPVxuICBcIjwhLS0gdmliZS1tZXJnZS1jb25mbGljdC1ydW5nLWZhaWxlZFwiO1xuXG4vKipcbiAqIFRoZSBydW5ncyB3aG9zZSBmYWlsdXJlIGlzIHJlY29yZGVkIGJ5IHtAbGluayBDT05GTElDVF9SVU5HX0ZBSUxFRF9NQVJLRVJ9LlxuICpcbiAqIGBcInJlYmFzZVwiYCBpcyBsZWdhY3kg4oCUIHRoZSBydW5nIGl0IG5hbWVkIHdhcyBkcm9wcGVkIGluIElzc3VlICMyODQyLCBhbmRcbiAqIG5vdGhpbmcgcG9zdHMgYSBgcnVuZz1cInJlYmFzZVwiYCBtYXJrZXIgYW55IG1vcmUuIEl0IHN0YXlzIGluIHRoaXMgdW5pb25cbiAqIG9ubHkgc28gYSBtYXJrZXIgYWxyZWFkeSBvbiBhIFBSIHRocmVhZCBmcm9tIGJlZm9yZSB0aGUgZHJvcCBzdGlsbCByZWFkc1xuICogYmFjayBhcyBhIGtub3duIHJ1bmcsIHJhdGhlciB0aGFuIGJlaW5nIGRpc2NhcmRlZCBhcyBtYWxmb3JtZWQuXG4gKi9cbmV4cG9ydCB0eXBlIENvbmZsaWN0TGFkZGVyUnVuZyA9IFwicmViYXNlXCIgfCBcImFiYW5kb25cIjtcblxuLyoqXG4gKiBUaGUgc2hhIGFzIGEgbWFya2VyIGF0dHJpYnV0ZSwgb3IgYSB0aHJvdy5cbiAqXG4gKiBGYWlscyBsb3VkIHJhdGhlciB0aGFuIHdyaXRpbmcgYW4gYXR0cmlidXRlIHRoZSByZWFkZXIgd2lsbCBkaXNjYXJkOiBhXG4gKiBtYXJrZXIgbm9ib2R5IGNhbiByZWFkIGJhY2sgaXMgYSBydW5nIHRoYXQgcnVucyBhZ2FpbiBhdCB0aGUgc2FtZSBoZWFkLFxuICogd2hpY2ggaXMgdGhlIGxvb3AgdGhpcyBsYWRkZXIgZXhpc3RzIHRvIGJyZWFrLlxuICovXG5mdW5jdGlvbiBoZWFkQXR0cmlidXRlKG5hbWU6IHN0cmluZywgc2hhOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gc2hhLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAoIWlzQ29uZmxpY3RIZWFkU2hhKHRyaW1tZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFJlZnVzaW5nIHRvIHdyaXRlIGEgbWVyZ2UtY29uZmxpY3QgcnVuZyBtYXJrZXIgd2l0aCAke25hbWV9PVwiJHtzaGF9XCIgYCArXG4gICAgICAgIFwi4oCUIGEgaGVhZCBzaGEgbXVzdCBiZSA34oCTNDAgaGV4IGNoYXJhY3RlcnNcIixcbiAgICApO1xuICB9XG4gIHJldHVybiBgJHtuYW1lfT1cIiR7dHJpbW1lZH1cImA7XG59XG5cbi8qKiBUaGUgbWFya2VyIGxpbmUgZm9yIG9uZSBudWRnZWQgaGVhZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb25mbGljdE51ZGdlTWFya2VyKGhlYWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtDT05GTElDVF9OVURHRV9NQVJLRVJ9ICR7aGVhZEF0dHJpYnV0ZShcImhlYWRcIiwgaGVhZCl9IC0tPmA7XG59XG5cbi8qKlxuICogVGhlIG1hcmtlciBsaW5lIGZvciBvbmUgcmViYXNlLCBuYW1pbmcgdGhlIGhlYWQgaXQgcmVwbGFjZWQuXG4gKlxuICogTGVnYWN5IOKAlCB0aGUgcmViYXNlIHJ1bmcgd2FzIGRyb3BwZWQgaW4gSXNzdWUgIzI4NDIsIHNvIG5vdGhpbmcgaW5cbiAqIHByb2R1Y3Rpb24gcG9zdHMgdGhpcyBhbnkgbW9yZS4gS2VwdCBvbmx5IGJlY2F1c2UgdGVzdHMgc3RpbGwgZm9yZ2UgYVxuICogbGVnYWN5IG1hcmtlciB3aXRoIGl0IHRvIHByb3ZlIHRoZSBsYWRkZXIgc3RpbGwgcmVhZHMgb2xkIHRocmVhZHMgYmFja1xuICogY29ycmVjdGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29uZmxpY3RSZWJhc2VNYXJrZXIoXG4gIG9sZEhlYWQ6IHN0cmluZyxcbiAgbmV3SGVhZDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0NPTkZMSUNUX1JFQkFTRV9NQVJLRVJ9ICR7aGVhZEF0dHJpYnV0ZShcIm9sZFwiLCBvbGRIZWFkKX0gYCArXG4gICAgYCR7aGVhZEF0dHJpYnV0ZShcIm5ld1wiLCBuZXdIZWFkKX0gLS0+YDtcbn1cblxuLyoqIFRoZSBtYXJrZXIgbGluZSBmb3Igb25lIHJ1bmcgdGhhdCByYW4gYXQgYSBoZWFkIHNoYSBhbmQgZmFpbGVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbmZsaWN0UnVuZ0ZhaWxlZE1hcmtlcihcbiAgcnVuZzogQ29uZmxpY3RMYWRkZXJSdW5nLFxuICBoZWFkOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYCR7Q09ORkxJQ1RfUlVOR19GQUlMRURfTUFSS0VSfSBydW5nPVwiJHtydW5nfVwiIGAgK1xuICAgIGAke2hlYWRBdHRyaWJ1dGUoXCJoZWFkXCIsIGhlYWQpfSAtLT5gO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBhcmtpbmcgKElzc3VlICMyMzEyKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogTWFya2VyIHRoYXQgb25jZSByZWNvcmRlZCBhIFBSICoqcGFya2VkKiogb24gYG1lcmdlLWNvbmZsaWN0YCAoSXNzdWUgIzIzMTIpLlxuICpcbiAqICoqTGVnYWN5IGFuZCByZWFkLW9ubHkgKElzc3VlICMzMTY2KS4qKiBOb3RoaW5nIHdyaXRlcyBpdCBhbnkgbW9yZTogdGhlIHNjYW4nc1xuICogcGFyayBwYXRoIHdhcyB1bnJlYWNoYWJsZSBvbmNlIGFiYW5kb24tYW5kLXJlZG8gbG9zdCBpdHMgcmVzdGFydCBjYXAgKElzc3VlXG4gKiAjMzAzMyksIGFuZCBhIGRlY2xpbmVkIGFiYW5kb24gbm93IGVuZHMgYXMgYGJ1ZGdldC1zcGVudGAgaW5zdGVhZC4gVGhlIHNjYW5cbiAqIGFuZCB0aGUgc3RhbGwgd2F0Y2hkb2cgc3RpbGwgcmVhZCB0aGUgbWFya2VycyBhbHJlYWR5IHBvc3RlZCwgc28gYSBQUiBwYXJrZWRcbiAqIGJlZm9yZSB0aGUgY2hhbmdlIGtlZXBzIHdhaXRpbmcgb24gaXRzIGJhc2UgcmF0aGVyIHRoYW4gYmVpbmcgcmV0cmllZCBhdCBvbmNlLlxuICpcbiAqICoqS2V5ZWQgb24gdGhlIGBiYXNlYCBzaGEsIG5vdCB0aGUgaGVhZCoqLCB3aGljaCBpcyB3aGF0IG1ha2VzIHRoZSB3YWl0IGVuZC5cbiAqIEV2ZXJ5IG90aGVyIG1hcmtlciBpbiB0aGlzIHZvY2FidWxhcnkga2V5cyBvbiB0aGUgaGVhZCwgYmVjYXVzZSBldmVyeSBvdGhlclxuICogcnVuZyBhY3RzIG9uIHRoZSBoZWFkLiBIZXJlIG5vdGhpbmcgYWN0cyBhdCBhbGwgdW50aWwgdGhlICpiYXNlKiB0aXAgbW92ZXM6XG4gKiBhIGJhc2UgdGhhdCBoYXMgbm90IG1vdmVkIGNhbm5vdCBtZXJnZSBhbnkgYmV0dGVyIHRoYW4gaXQgZGlkIGFuIGhvdXIgYWdvLFxuICogYW5kIGEgYmFzZSB0aGF0IGhhcyBtb3ZlZCBpcyBhIGdlbnVpbmVseSBkaWZmZXJlbnQgbWVyZ2UsIHdvcnRoIGEgZnJlc2hcbiAqIHR3by1ydW4gYnVkZ2V0LlxuICovXG5leHBvcnQgY29uc3QgQ09ORkxJQ1RfUEFSS0VEX01BUktFUiA9IFwiPCEtLSB2aWJlLW1lcmdlLWNvbmZsaWN0LXBhcmtlZFwiO1xuXG4vKipcbiAqIEEgbm8tb3Agd2F0Y2hkb2cgY2hlY2sgKElzc3VlICMzMDAxIHJldmlldykuIEEgZGVjbGluZWQgYWJhbmRvbiBhbmQgYVxuICogcmV1c2VkIGZpeCBQUiBwb3N0IG5vdGhpbmcgZWxzZSwgc28gd2l0aG91dCB0aGlzIHRoZSBzYW1lIFBSIHRyaXBzIGFnYWluXG4gKiBvbiBldmVyeSBjeWNsZS4gVGhlIGBhdD1cIuKAplwiYCBpcyB3aGF0IHtAbGluayByZWFkTGF0ZXN0U3RhbmREb3duQXRNc31cbiAqIHJlc3RhcnRzIHRoZSBvd25lci1jaGVjayBjbG9jayBmcm9tLlxuICovXG5leHBvcnQgY29uc3QgQ09ORkxJQ1RfV0FUQ0hET0dfQ0hFQ0tFRF9NQVJLRVIgPVxuICBcIjwhLS0gdmliZS1jb25mbGljdC13YXRjaGRvZy1jaGVja2VkXCI7XG5cbi8qKiBUaGUgbWFya2VyIGxpbmUgZm9yIG9uZSBuby1vcCB3YXRjaGRvZyBjaGVjaywgbmFtaW5nIHdoZW4gaXQgcmFuLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbmZsaWN0V2F0Y2hkb2dDaGVja2VkTWFya2VyKGF0TXM6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiBgJHtDT05GTElDVF9XQVRDSERPR19DSEVDS0VEX01BUktFUn0gJHtcbiAgICBzdGFuZERvd25BdEF0dHJpYnV0ZShhdE1zKVxuICB9IC0tPmA7XG59XG5cbi8qKlxuICogVGhlIGBhdD1cIuKAplwiYCBhdHRyaWJ1dGUgZXZlcnkgc3RhbmQtZG93biBtYXJrZXIgY2FycmllcywgbmFtaW5nIHRoZSBtb21lbnRcbiAqIHRoZSBzdGFuZC1kb3duIHdhcyBwb3N0ZWQgKElzc3VlICMyOTk3KSDigJQgc2hhcmVkIGJ5IHRoaXMgbW9kdWxlJ3NcbiAqIHtAbGluayBjb25mbGljdFBhcmtlZE1hcmtlcn0gYW5kIGBnYXRlZF9oZWFkX2d1YXJkLnRzYCdzIG93biBtYXJrZXJzIHNvIHRoZVxuICogZ3JhbW1hciBjYW5ub3QgZHJpZnQgYmV0d2VlbiB0aGVtLlxuICpcbiAqIFRocm93cyBvbiBhIG5vbi1maW5pdGUgYHN0YW5kRG93bkF0TXNgOiBhIG1hcmtlciBub2JvZHkgY2FuIHJlYWQgYmFjayBpcyBhXG4gKiBzdGFuZC1kb3duIHRoYXQgbmV2ZXIgZW5kcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YW5kRG93bkF0QXR0cmlidXRlKHN0YW5kRG93bkF0TXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHN0YW5kRG93bkF0TXMpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFJlZnVzaW5nIHRvIHdyaXRlIGEgc3RhbmQtZG93biBtYXJrZXIgd2l0aCBhdD1cIiR7c3RhbmREb3duQXRNc31cIiDigJQgYCArXG4gICAgICAgIFwidGhlIHN0YW5kLWRvd24gdGltZSBtdXN0IGJlIGZpbml0ZVwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGBhdD1cIiR7bmV3IERhdGUoc3RhbmREb3duQXRNcykudG9JU09TdHJpbmcoKX1cImA7XG59XG5cbi8qKlxuICogVGhlIG1hcmtlciBsaW5lIGZvciBvbmUgcGFya2VkIFBSLCBuYW1pbmcgdGhlIGJhc2UgdGlwIGl0IGlzIHdhaXRpbmcgb25cbiAqIGFuZCwgd2hlbiBgc3RhbmREb3duQXRNc2AgaXMgZ2l2ZW4sIHRoZSBtb21lbnQgdGhlIHBhcmsgc3RhcnRlZCAoSXNzdWVcbiAqICMyOTk3KSDigJQgdGhlIHN0YWxsIHdhdGNoZG9nJ3MgYGF0PVwi4oCmXCJgIHJlYWRzIGJhY2sgYnlcbiAqIHtAbGluayByZWFkTGF0ZXN0U3RhbmREb3duQXRNc30gaW4gYGdhdGVkX2hlYWRfZ3VhcmQudHNgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29uZmxpY3RQYXJrZWRNYXJrZXIoXG4gIGJhc2U6IHN0cmluZyxcbiAgc3RhbmREb3duQXRNcz86IG51bWJlcixcbik6IHN0cmluZyB7XG4gIC8vIGBoZWFkQXR0cmlidXRlYCB2YWxpZGF0ZXMgYSBnaXQgb2JqZWN0IG5hbWUsIHdoaWNoZXZlciBlbmQgaXQgbmFtZXM6IGFcbiAgLy8gbWFya2VyIHRoZSByZWFkZXIgd291bGQgZGlzY2FyZCBpcyBhIHBhcmsgdGhhdCBuZXZlciBlbmRzLlxuICBjb25zdCBhdEF0dHJpYnV0ZSA9IHN0YW5kRG93bkF0TXMgPT09IHVuZGVmaW5lZFxuICAgID8gXCJcIlxuICAgIDogYCAke3N0YW5kRG93bkF0QXR0cmlidXRlKHN0YW5kRG93bkF0TXMpfWA7XG4gIHJldHVybiBgJHtDT05GTElDVF9QQVJLRURfTUFSS0VSfSAke1xuICAgIGhlYWRBdHRyaWJ1dGUoXCJiYXNlXCIsIGJhc2UpXG4gIH0ke2F0QXR0cmlidXRlfSAtLT5gO1xufVxuXG4vKiogV2hlcmUgYSBwYXJrIG1hcmtlciBzaXRzIGluIGEgdGhyZWFkLCBhbmQgd2hpY2ggYmFzZSB0aXAgaXQgbmFtZWQuICovXG5leHBvcnQgaW50ZXJmYWNlIENvbmZsaWN0UGFya1JlY29yZCB7XG4gIC8qKiBUaGUgYmFzZSBzaGEgdGhlIFBSIHdhcyBwYXJrZWQgYXQsIGxvd2VyY2FzZWQuICovXG4gIGJhc2U6IHN0cmluZztcbiAgLyoqIEluZGV4IG9mIHRoZSBwYXJrIGNvbW1lbnQgaW4gdGhlIHRocmVhZCBpdCB3YXMgcmVhZCBmcm9tLiAqL1xuICBpbmRleDogbnVtYmVyO1xufVxuXG4vKipcbiAqIFRoZSBtb3N0IHJlY2VudCBwYXJrIG1hcmtlciBpbiBhIGNvbW1lbnQgdGhyZWFkLCBvciBgbnVsbGAuXG4gKlxuICogKipPbmx5IHNhZmUgb24gYSB0aHJlYWQgYWxyZWFkeSByZWR1Y2VkIHRvIHRoZSBmbGVldCdzIG93biBjb21tZW50cyoqXG4gKiAoYGNvbmZsaWN0X21hcmtlcl90cnVzdC50c2ApOiBhIHBhcmsgbWFya2VyIHN1cHByZXNzZXMgZXZlcnkgbGF0ZXIgYXR0ZW1wdCxcbiAqIHNvIG9uZSBhbnlib2R5IGNvdWxkIHBvc3Qgd291bGQgYmUgYSB3YXkgdG8gc2lsZW5jZSBhIFBSJ3MgcXVldWUgZm9yIGV2ZXIuXG4gKlxuICogQSBtYXJrZXIgd2hvc2UgYGJhc2VgIGNhbm5vdCBiZSByZWFkIGlzIHRyZWF0ZWQgYXMgbm8gcGFyayBhdCBhbGwsIHNvIHRoZSBQUlxuICogZm9sbG93cyB0aGUgdW5jYXBwZWQgYWJhbmRvbi1hbmQtcmVkbyBwYXRoIChJc3N1ZSAjMzE2NikgcmF0aGVyIHRoYW4gc3RheWluZ1xuICogcGFya2VkIG9uIGEgc2hhIG5vdGhpbmcgY2FuIGV2ZXIgbWF0Y2guIE5vdGhpbmcgcmUtcmVjb3JkcyBhIHBhcms6IHRoZSBtYXJrZXJcbiAqIGlzIGxlZ2FjeSBhbmQgcmVhZC1vbmx5LlxuICpcbiAqIEBwYXJhbSBjb21tZW50cyAtIFJhdyBSRVNUIGNvbW1lbnQgb2JqZWN0cywgb2xkZXN0IGZpcnN0LCBmbGVldC1hdXRob3JlZC5cbiAqIEByZXR1cm5zIFRoZSBuZXdlc3QgcmVhZGFibGUgcGFyayByZWNvcmQsIHdpdGggaXRzIGluZGV4IGluIGBjb21tZW50c2AuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkUGFya2VkQmFzZShcbiAgY29tbWVudHM6IHJlYWRvbmx5IHVua25vd25bXSxcbik6IENvbmZsaWN0UGFya1JlY29yZCB8IG51bGwge1xuICBsZXQgZm91bmQ6IENvbmZsaWN0UGFya1JlY29yZCB8IG51bGwgPSBudWxsO1xuICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgY29tbWVudHMubGVuZ3RoOyBpbmRleCsrKSB7XG4gICAgY29uc3QgcmF3ID0gY29tbWVudHNbaW5kZXhdO1xuICAgIGlmICh0eXBlb2YgcmF3ICE9PSBcIm9iamVjdFwiIHx8IHJhdyA9PT0gbnVsbCkgY29udGludWU7XG4gICAgY29uc3QgYm9keSA9IChyYXcgYXMgeyBib2R5PzogdW5rbm93biB9KS5ib2R5O1xuICAgIGlmICh0eXBlb2YgYm9keSAhPT0gXCJzdHJpbmdcIikgY29udGludWU7XG4gICAgY29uc3QgYXQgPSBib2R5LmluZGV4T2YoQ09ORkxJQ1RfUEFSS0VEX01BUktFUik7XG4gICAgaWYgKGF0IDwgMCkgY29udGludWU7XG4gICAgY29uc3Qgd3JpdHRlbiA9IC9iYXNlPVwiKFteXCJdKilcIi8uZXhlYyhib2R5LnNsaWNlKGF0KSk/LlsxXTtcbiAgICBpZiAod3JpdHRlbiA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICAvLyBPbmUgcnVsZSwgY2hlY2tlZCBieSB0aGUgc2FtZSBwcmVkaWNhdGUgdGhlIHdyaXRlciB2YWxpZGF0ZXMgdGhyb3VnaDpcbiAgICAvLyBhIHJlYWRlciBsYXhlciB0aGFuIHRoZSB3cml0ZXIgYWNjZXB0cyBtYXJrZXJzIG5vdGhpbmcgZWxzZSBhZ3JlZXMgYXJlXG4gICAgLy8gbWFya2Vycy5cbiAgICBjb25zdCBiYXNlID0gd3JpdHRlbi50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAoIWlzQ29uZmxpY3RIZWFkU2hhKGJhc2UpKSBjb250aW51ZTtcbiAgICBmb3VuZCA9IHsgYmFzZSwgaW5kZXggfTtcbiAgfVxuICByZXR1cm4gZm91bmQ7XG59XG5cbi8qKlxuICogVGhlIGNvbW1lbnRzIHRoYXQgY291bnQgdG93YXJkIHRoZSBjdXJyZW50IGNvbmZsaWN0J3MgYnVkZ2V0LlxuICpcbiAqIEEgcGFyayBtYXJrZXIgZW5kcyB0aGUgcHJldmlvdXMgbWVyZ2UuIEZhaWx1cmVzIGJlZm9yZSBpdCBiZWxvbmcgdG8gYVxuICogYmFzZSB0aGF0IG5vIGxvbmdlciBleGlzdHMsIHNvIGEgcmV0cnkgYWZ0ZXIgdGhhdCBiYXNlIG1vdmVzIHN0YXJ0cyBmcm9tXG4gKiBhIGZyZXNoIGJ1ZGdldCAoSXNzdWUgIzIzMTIpLiBUaGUgc2NhbiBhbmQgdGhlIHVuZGVyLWxvY2sgcmUtcmVhZCBib3RoXG4gKiB1c2UgdGhpcywgc28gdGhleSBjYW5ub3QgZGlzYWdyZWUgYWJvdXQgd2hpY2ggY29tbWVudHMgY291bnQuXG4gKlxuICogKipPbmx5IHNhZmUgb24gYSB0aHJlYWQgYWxyZWFkeSByZWR1Y2VkIHRvIHRoZSBmbGVldCdzIG93biBjb21tZW50cy4qKlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29tbWVudHNBZnRlckNvbmZsaWN0UGFyayhcbiAgY29tbWVudHM6IHJlYWRvbmx5IHVua25vd25bXSxcbik6IHJlYWRvbmx5IHVua25vd25bXSB7XG4gIGNvbnN0IHBhcmsgPSByZWFkUGFya2VkQmFzZShjb21tZW50cyk7XG4gIGlmIChwYXJrID09PSBudWxsKSByZXR1cm4gY29tbWVudHM7XG4gIHJldHVybiBjb21tZW50cy5zbGljZShwYXJrLmluZGV4ICsgMSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGhlIHNoYXJlZCByZXNvbHV0aW9uIGJ1ZGdldCAoSXNzdWUgIzI5OTYpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIFRoZSBwYXNzZXMgYSBgcGFzcz1cIuKAplwiYCBhdHRyaWJ1dGUgbWF5IGxlZ2l0aW1hdGVseSBuYW1lLiAqL1xuY29uc3QgQ09ORkxJQ1RfUkVTT0xVVElPTl9QQVNTRVM6IHJlYWRvbmx5IENvbmZsaWN0UmVzb2x1dGlvblBhc3NbXSA9IFtcbiAgXCJsYWRkZXJcIixcbiAgXCJzeW5jXCIsXG4gIFwidGFrZW92ZXJcIixcbl07XG5cbi8qKiBXaGV0aGVyIGEgdmFsdWUgaXMgb25lIG9mIHRoZSByZWNvZ25pc2VkIHBhc3MgbmFtZXMsIG5hcnJvd2luZyB0aGUgdHlwZS4gKi9cbmZ1bmN0aW9uIGlzQ29uZmxpY3RSZXNvbHV0aW9uUGFzcyhcbiAgdmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IHZhbHVlIGlzIENvbmZsaWN0UmVzb2x1dGlvblBhc3Mge1xuICByZXR1cm4gdmFsdWUgIT09IHVuZGVmaW5lZCAmJlxuICAgIChDT05GTElDVF9SRVNPTFVUSU9OX1BBU1NFUyBhcyByZWFkb25seSBzdHJpbmdbXSkuaW5jbHVkZXModmFsdWUpO1xufVxuXG4vKiogVGhlIHBvc2l0aXZlLWludGVnZXIgYXR0ZW1wdCBudW1iZXIgYXMgYSBtYXJrZXIgYXR0cmlidXRlLCBvciBhIHRocm93LiAqL1xuZnVuY3Rpb24gYXR0ZW1wdE51bWJlckF0dHJpYnV0ZShhdHRlbXB0TnVtYmVyOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIoYXR0ZW1wdE51bWJlcikgfHwgYXR0ZW1wdE51bWJlciA8IDEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgUmVmdXNpbmcgdG8gd3JpdGUgYSBtZXJnZS1jb25mbGljdCBhdHRlbXB0IG1hcmtlciB3aXRoIG49XCIke2F0dGVtcHROdW1iZXJ9XCIgYCArXG4gICAgICAgIFwi4oCUIHRoZSBhdHRlbXB0IG51bWJlciBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlclwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGBuPVwiJHthdHRlbXB0TnVtYmVyfVwiYDtcbn1cblxuLyoqIFRoZSBtYXJrZXIgbGluZSBmb3Igb25lIG9wZW5lZCBhdHRlbXB0LCBuYW1pbmcgaXRzIHBhc3MgYW5kIHRoZSBoZWFkIGl0IHJhbiBhZ2FpbnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbmZsaWN0QXR0ZW1wdE1hcmtlcihcbiAgYXR0ZW1wdE51bWJlcjogbnVtYmVyLFxuICBwYXNzOiBDb25mbGljdFJlc29sdXRpb25QYXNzLFxuICBoZWFkU2hhOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYCR7Q09ORkxJQ1RfQVRURU1QVF9NQVJLRVJ9ICR7XG4gICAgYXR0ZW1wdE51bWJlckF0dHJpYnV0ZShhdHRlbXB0TnVtYmVyKVxuICB9IGAgK1xuICAgIGBwYXNzPVwiJHtwYXNzfVwiICR7aGVhZEF0dHJpYnV0ZShcImhlYWRcIiwgaGVhZFNoYSl9IC0tPmA7XG59XG5cbi8qKlxuICogVGhlIG1hcmtlciBsaW5lIGZvciBvbmUgYXR0ZW1wdCB0aGF0IHJlYWNoZWQgYSBtZXJnZSBjb25jbHVzaW9uIGFuZFxuICogZmFpbGVkLCBuYW1pbmcgaXRzIHBhc3MgYW5kIHRoZSBoZWFkIGl0IHJhbiBhZ2FpbnN0LlxuICpcbiAqIGBuPVwi4oCmXCJgIHN0YXlzIGZpcnN0IGFuZCB3aGl0ZXNwYWNlLXNlcGFyYXRlZCBmcm9tIHRoZSByZXN0OiB0aGUgYWJhbmRvblxuICogcnVuZyAoYGNvbmZsaWN0X2FiYW5kb25fcmVzdGFydC50c2ApIHJlYWRzIGl0IGJhY2sgd2l0aFxuICogYC9tZXJnZS1jb25mbGljdC1mYWlsZWRcXHMrbj1cIihcXGQrKVwiL2AuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb25mbGljdEZhaWxlZE1hcmtlcihcbiAgYXR0ZW1wdE51bWJlcjogbnVtYmVyLFxuICBwYXNzOiBDb25mbGljdFJlc29sdXRpb25QYXNzLFxuICBoZWFkU2hhOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYCR7Q09ORkxJQ1RfRkFJTEVEX01BUktFUn0gJHthdHRlbXB0TnVtYmVyQXR0cmlidXRlKGF0dGVtcHROdW1iZXIpfSBgICtcbiAgICBgcGFzcz1cIiR7cGFzc31cIiAke2hlYWRBdHRyaWJ1dGUoXCJoZWFkXCIsIGhlYWRTaGEpfSAtLT5gO1xufVxuXG4vKiogVGhlIG1hcmtlciBsaW5lIGZvciBvbmUgYXR0ZW1wdCB0aGF0IG1lcmdlZCBzdWNjZXNzZnVsbHksIG5hbWluZyBpdHMgcGFzcyBhbmQgdGhlIGhlYWQgaXQgcmFuIGFnYWluc3QuICovXG5leHBvcnQgZnVuY3Rpb24gY29uZmxpY3RSZXNvbHZlZE1hcmtlcihcbiAgcGFzczogQ29uZmxpY3RSZXNvbHV0aW9uUGFzcyxcbiAgaGVhZFNoYTogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0NPTkZMSUNUX1JFU09MVkVEX01BUktFUn0gcGFzcz1cIiR7cGFzc31cIiBgICtcbiAgICBgJHtoZWFkQXR0cmlidXRlKFwiaGVhZFwiLCBoZWFkU2hhKX0gLS0+YDtcbn1cblxuLyoqIFRoZSBwYXNzIGEgbWFya2VyJ3Mgb3duIHRleHQgY2Fycmllcywgb3IgYFwibGFkZGVyXCJgIHdoZW4gYWJzZW50L3VucmVjb2duaXNlZC4gKi9cbmZ1bmN0aW9uIHJlYWRDb25mbGljdFBhc3MobWFya2VyVGV4dDogc3RyaW5nKTogQ29uZmxpY3RSZXNvbHV0aW9uUGFzcyB7XG4gIGNvbnN0IHdyaXR0ZW4gPSAvcGFzcz1cIihbXlwiXSopXCIvLmV4ZWMobWFya2VyVGV4dCk/LlsxXTtcbiAgcmV0dXJuIGlzQ29uZmxpY3RSZXNvbHV0aW9uUGFzcyh3cml0dGVuKSA/IHdyaXR0ZW4gOiBcImxhZGRlclwiO1xufVxuXG4vKiogVGhlIGhlYWQgc2hhIGEgbWFya2VyJ3Mgb3duIHRleHQgY2FycmllcywgbG93ZXJjYXNlZCwgb3IgYHVuZGVmaW5lZGAgd2hlbiBhYnNlbnQvdW51c2FibGUuICovXG5mdW5jdGlvbiByZWFkQ29uZmxpY3RIZWFkKG1hcmtlclRleHQ6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHdyaXR0ZW4gPSAvaGVhZD1cIihbXlwiXSopXCIvLmV4ZWMobWFya2VyVGV4dCk/LlsxXTtcbiAgaWYgKHdyaXR0ZW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgaGVhZCA9IHdyaXR0ZW4udHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBpc0NvbmZsaWN0SGVhZFNoYShoZWFkKSA/IGhlYWQgOiB1bmRlZmluZWQ7XG59XG5cbi8qKiBUaGUgZXBvY2ggbXMgYSBjb21tZW50J3MgYGNyZWF0ZWRfYXRgIGNhcnJpZXMsIG9yIGB1bmRlZmluZWRgIHdoZW4gdW5wYXJzZWFibGUuICovXG5mdW5jdGlvbiByZWFkQ29tbWVudEF0TXMoXG4gIGNvbW1lbnQ6IHsgY3JlYXRlZF9hdD86IHVua25vd24gfSxcbik6IG51bWJlciB8IHVuZGVmaW5lZCB7XG4gIGlmICh0eXBlb2YgY29tbWVudC5jcmVhdGVkX2F0ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBwYXJzZWQgPSBEYXRlLnBhcnNlKGNvbW1lbnQuY3JlYXRlZF9hdCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBzaGFyZWQgY29uZmxpY3QtcmVzb2x1dGlvbiBhdHRlbXB0IGhpc3Rvcnkgb3V0IG9mIGEgUFIncyBjb21tZW50XG4gKiB0aHJlYWQgKElzc3VlICMyOTk2KS5cbiAqXG4gKiBUaGlzIGlzIHRoZSAqKlBSLXNpZGUgdGFsbHkqKiB0aGUgc2hhcmVkIGJ1ZGdldCBpcyBzcGVudCBhZ2FpbnN0IOKAlCBuZXZlclxuICogaG9zdC1sb2NhbCBzdGF0ZSAoSXNzdWUgIzI5MTkpIOKAlCBzbyBldmVyeSBwYXNzIHRoYXQgbWlnaHQgc3BlbmQgZnJvbVxuICoge0BsaW5rIENPTkZMSUNUX1JFU09MVVRJT05fQlVER0VUfSByZWFkcyB0aGUgc2FtZSBsaXN0IGJhY2ssIHJlZ2FyZGxlc3Mgb2ZcbiAqIHdoaWNoIGhvc3Qgb3Igd2hpY2ggcGFzcyBpcyBhc2tpbmcuXG4gKlxuICogV2Fsa3Mgb2xkZXN0IGZpcnN0LCBtaXJyb3JpbmcgYHBhcnNlQ29uZmxpY3RBdHRlbXB0c2AgaW5cbiAqIGBwcl9tZXJnZV9jb25mbGljdF9zY2FuLnRzYDogYSByZXNvbHZlZCBtYXJrZXIsIHRoZW4gYSBmYWlsZWQgbWFya2VyLCB0aGVuXG4gKiBhbiBhdHRlbXB0IG1hcmtlciwgaW4gdGhhdCBvcmRlciBwZXIgY29tbWVudC4gQSBjb25jbHVzaW9uIG1hcmtlciBhbHdheXNcbiAqIGNvdW50cywgZXZlbiB3aXRoIG5vIG9wZW4gYXR0ZW1wdCBiZWZvcmUgaXQg4oCUIHRoZSBjb25zZXJ2YXRpdmUgZGlyZWN0aW9uIOKAlFxuICogYW5kIGEgY29uY2x1c2lvbiBvbmx5IG92ZXJ3cml0ZXMgYW4gb3BlbiBhdHRlbXB0J3MgYHBhc3NgL2BoZWFkU2hhYCB3aGVuXG4gKiB0aGUgY29uY2x1c2lvbiBtYXJrZXIgaXRzZWxmIGNhcnJpZXMgdGhlbSwgc28gYSBsZWdhY3kgY29uY2x1c2lvbiB3aXRoIG5vXG4gKiBgcGFzcz1gIGNhbm5vdCBlcmFzZSBhbiBhdHRyaWJ1dGVkIGF0dGVtcHQncyBwYXNzLlxuICpcbiAqIEF1dGhvci1ibGluZCBiZXlvbmQgdGhlIGBpc1RydXN0ZWRBdXRob3JgIGNoZWNrIHBhc3NlZCBpbjogYSBjb21tZW50IHdpdGhcbiAqIG5vIHJlYWRhYmxlIGxvZ2luLCBvciB3aG9zZSBsb2dpbiBpcyByZWplY3RlZCwgaXMgaWdub3JlZCBlbnRpcmVseSDigJRcbiAqIG1hdGNoaW5nIHRoZSBhdXRob3ItZmlsdGVyaW5nIGRpc2NpcGxpbmUgYGNvbmZsaWN0X21hcmtlcl90cnVzdC50c2BcbiAqIGRvY3VtZW50cyBmb3IgdGhpcyB2b2NhYnVsYXJ5LlxuICpcbiAqIEBwYXJhbSBjb21tZW50cyAtIFJhdyBSRVNUIGNvbW1lbnQgb2JqZWN0cywgb2xkZXN0IGZpcnN0LlxuICogQHBhcmFtIGlzVHJ1c3RlZEF1dGhvciAtIFByZWRpY2F0ZSBhIGNvbW1lbnQncyBgdXNlci5sb2dpbmAgbXVzdCBwYXNzIGZvclxuICogICBpdHMgbWFya2VycyB0byBiZSByZWFkIGF0IGFsbC5cbiAqIEByZXR1cm5zIFRoZSBmdWxsIGF0dGVtcHQgbGlzdCwgaW4gdGhyZWFkIG9yZGVyLiBSZXNldHMgKGEgcmVzb2x2ZWRcbiAqICAgbWFya2VyIGNsZWFyaW5nIGV2ZXJ5dGhpbmcgYmVmb3JlIGl0KSBhcmUgdGhlIGNhbGxlcidzIGJ1c2luZXNzLCBub3RcbiAqICAgdGhpcyBmdW5jdGlvbidzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZFJlc29sdXRpb25BdHRlbXB0cyhcbiAgY29tbWVudHM6IHJlYWRvbmx5IHVua25vd25bXSxcbiAgaXNUcnVzdGVkQXV0aG9yOiAobG9naW46IHN0cmluZykgPT4gYm9vbGVhbixcbik6IENvbmZsaWN0UmVzb2x1dGlvbkF0dGVtcHRbXSB7XG4gIGNvbnN0IGF0dGVtcHRzOiBDb25mbGljdFJlc29sdXRpb25BdHRlbXB0W10gPSBbXTtcblxuICBmb3IgKGNvbnN0IHJhdyBvZiBjb21tZW50cykge1xuICAgIGlmICh0eXBlb2YgcmF3ICE9PSBcIm9iamVjdFwiIHx8IHJhdyA9PT0gbnVsbCkgY29udGludWU7XG4gICAgY29uc3QgY29tbWVudCA9IHJhdyBhcyB7IGJvZHk/OiB1bmtub3duOyBjcmVhdGVkX2F0PzogdW5rbm93biB9O1xuICAgIGlmICh0eXBlb2YgY29tbWVudC5ib2R5ICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGF1dGhvciA9IGNvbmZsaWN0Q29tbWVudEF1dGhvcihyYXcpO1xuICAgIGlmIChhdXRob3IgPT09IHVuZGVmaW5lZCB8fCAhaXNUcnVzdGVkQXV0aG9yKGF1dGhvcikpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgYm9keSA9IGNvbW1lbnQuYm9keTtcblxuICAgIGNvbnN0IHJlc29sdmVkQXQgPSBib2R5LmluZGV4T2YoQ09ORkxJQ1RfUkVTT0xWRURfTUFSS0VSKTtcbiAgICBjb25zdCBmYWlsZWRBdCA9IGJvZHkuaW5kZXhPZihDT05GTElDVF9GQUlMRURfTUFSS0VSKTtcbiAgICBjb25zdCBhdHRlbXB0QXQgPSBib2R5LmluZGV4T2YoQ09ORkxJQ1RfQVRURU1QVF9NQVJLRVIpO1xuXG4gICAgbGV0IGNvbmNsdXNpb25BdCA9IC0xO1xuICAgIGxldCBvdXRjb21lOiBcImZhaWxlZFwiIHwgXCJyZXNvbHZlZFwiIHwgdW5kZWZpbmVkO1xuICAgIGlmIChyZXNvbHZlZEF0ID49IDApIHtcbiAgICAgIGNvbmNsdXNpb25BdCA9IHJlc29sdmVkQXQ7XG4gICAgICBvdXRjb21lID0gXCJyZXNvbHZlZFwiO1xuICAgIH0gZWxzZSBpZiAoZmFpbGVkQXQgPj0gMCkge1xuICAgICAgY29uY2x1c2lvbkF0ID0gZmFpbGVkQXQ7XG4gICAgICBvdXRjb21lID0gXCJmYWlsZWRcIjtcbiAgICB9XG5cbiAgICBpZiAob3V0Y29tZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBtYXJrZXJUZXh0ID0gYm9keS5zbGljZShcbiAgICAgICAgY29uY2x1c2lvbkF0LFxuICAgICAgICAoKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGVuZCA9IGJvZHkuaW5kZXhPZihcIi0tPlwiLCBjb25jbHVzaW9uQXQpO1xuICAgICAgICAgIHJldHVybiBlbmQgPj0gMCA/IGVuZCArIFwiLS0+XCIubGVuZ3RoIDogYm9keS5sZW5ndGg7XG4gICAgICAgIH0pKCksXG4gICAgICApO1xuICAgICAgY29uc3QgcGFzcyA9IHJlYWRDb25mbGljdFBhc3MobWFya2VyVGV4dCk7XG4gICAgICBjb25zdCBoZWFkU2hhID0gcmVhZENvbmZsaWN0SGVhZChtYXJrZXJUZXh0KTtcbiAgICAgIGNvbnN0IGF0TXMgPSByZWFkQ29tbWVudEF0TXMoY29tbWVudCk7XG5cbiAgICAgIGNvbnN0IGxhc3QgPSBhdHRlbXB0c1thdHRlbXB0cy5sZW5ndGggLSAxXTtcbiAgICAgIGlmIChsYXN0ICE9PSB1bmRlZmluZWQgJiYgbGFzdC5vdXRjb21lID09PSBcIm9wZW5cIikge1xuICAgICAgICBsYXN0Lm91dGNvbWUgPSBvdXRjb21lO1xuICAgICAgICBpZiAoYXRNcyAhPT0gdW5kZWZpbmVkKSBsYXN0LmF0TXMgPSBhdE1zO1xuICAgICAgICBpZiAoL3Bhc3M9XCIvLnRlc3QobWFya2VyVGV4dCkpIGxhc3QucGFzcyA9IHBhc3M7XG4gICAgICAgIGlmIChoZWFkU2hhICE9PSB1bmRlZmluZWQpIGxhc3QuaGVhZFNoYSA9IGhlYWRTaGE7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhdHRlbXB0cy5wdXNoKHsgcGFzcywgYXRNcywgaGVhZFNoYSwgb3V0Y29tZSB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChhdHRlbXB0QXQgPCAwKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGVuZCA9IGJvZHkuaW5kZXhPZihcIi0tPlwiLCBhdHRlbXB0QXQpO1xuICAgIGNvbnN0IG1hcmtlclRleHQgPSBib2R5LnNsaWNlKFxuICAgICAgYXR0ZW1wdEF0LFxuICAgICAgZW5kID49IDAgPyBlbmQgKyBcIi0tPlwiLmxlbmd0aCA6IGJvZHkubGVuZ3RoLFxuICAgICk7XG4gICAgYXR0ZW1wdHMucHVzaCh7XG4gICAgICBwYXNzOiByZWFkQ29uZmxpY3RQYXNzKG1hcmtlclRleHQpLFxuICAgICAgYXRNczogcmVhZENvbW1lbnRBdE1zKGNvbW1lbnQpLFxuICAgICAgaGVhZFNoYTogcmVhZENvbmZsaWN0SGVhZChtYXJrZXJUZXh0KSxcbiAgICAgIG91dGNvbWU6IFwib3BlblwiLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIGF0dGVtcHRzO1xufVxuXG4vKipcbiAqIEZhaWxlZCBhdHRlbXB0cyBzcGVudCBhZ2FpbnN0IHRoZSBzaGFyZWQgYnVkZ2V0IHNpbmNlIHRoZSBsYXN0IHJlc29sdmVkXG4gKiBvbmUgKElzc3VlICMyOTk2KS5cbiAqXG4gKiBBIHJlc29sdmVkIG1hcmtlciByZXNldHMgdGhlIHRhbGx5IHRvIHplcm8g4oCUIGF0dGVtcHRzIGJlZm9yZSBhIHN1Y2Nlc3NmdWxcbiAqIG1lcmdlIGJlbG9uZyB0byBhIGNvbmZsaWN0IHRoYXQgaXMgYWxyZWFkeSBvdmVyIOKAlCBzbyB0aGlzIHdhbGtzIHRoZSBmdWxsXG4gKiBsaXN0LCBvbGRlc3QgZmlyc3QsIGFuZCBjb3VudHMgYGZhaWxlZGAgb3V0Y29tZXMgYWZ0ZXIgdGhlIG1vc3QgcmVjZW50XG4gKiBgcmVzb2x2ZWRgLiBFdmVyeSBwYXNzIGNvdW50cyBoZXJlOiB0aGUgc3RhbGUtdmVyZGljdCBsYWRkZXIsIHRoZSBtaWxlc3RvbmVcbiAqIHN5bmMgYW5kIHRoZSB0YWtlb3ZlciBydW5nIGFsbCBzcGVuZCBmcm9tIHRoZSBzYW1lIG51bWJlci5cbiAqXG4gKiBAcGFyYW0gYXR0ZW1wdHMgLSBGcm9tIHtAbGluayByZWFkUmVzb2x1dGlvbkF0dGVtcHRzfS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNwZW50Q29uZmxpY3RBdHRlbXB0cyhcbiAgYXR0ZW1wdHM6IHJlYWRvbmx5IENvbmZsaWN0UmVzb2x1dGlvbkF0dGVtcHRbXSxcbik6IG51bWJlciB7XG4gIGxldCBjb3VudCA9IDA7XG4gIGZvciAoY29uc3QgYXR0ZW1wdCBvZiBhdHRlbXB0cykge1xuICAgIGlmIChhdHRlbXB0Lm91dGNvbWUgPT09IFwicmVzb2x2ZWRcIikge1xuICAgICAgY291bnQgPSAwO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChhdHRlbXB0Lm91dGNvbWUgPT09IFwiZmFpbGVkXCIpIGNvdW50Kys7XG4gIH1cbiAgcmV0dXJuIGNvdW50O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXVCQyxHQUVELFNBQVMscUJBQXFCLFFBQVEsNkJBQTZCO0FBRW5FOzs7O0NBSUMsR0FDRCxPQUFPLE1BQU0sNkJBQTZCLEVBQUU7QUFFNUM7OztDQUdDLEdBQ0QsT0FBTyxNQUFNLDZCQUE2QixFQUFFO0FBNEI1Qzs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sTUFBTSx1QkFBdUIsaUJBQWlCO0FBRXJELHFFQUFxRSxHQUNyRSxPQUFPLE1BQU0sMEJBQTBCLHlDQUF5QztBQUVoRjs7Ozs7Ozs7Ozs7O0NBWUMsR0FDRCxPQUFPLE1BQU0sMkJBQ1gsMENBQTBDO0FBRTVDOzs7O0NBSUMsR0FDRCxPQUFPLE1BQU0seUJBQXlCLHdDQUF3QztBQUU5RSw4RUFBOEU7QUFDOUUsaURBQWlEO0FBQ2pELDhFQUE4RTtBQUU5RTs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUVELDBFQUEwRSxHQUMxRSxNQUFNLG1CQUFtQjtBQUV6Qjs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsa0JBQWtCLEtBQWE7RUFDN0MsT0FBTyxpQkFBaUIsSUFBSSxDQUFDO0FBQy9CO0FBRUE7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sTUFBTSx3QkFBd0IsaUNBQWlDO0FBRXRFLG1GQUFtRixHQUNuRixPQUFPLE1BQU0seUJBQXlCLGtDQUFrQztBQUV4RSw0REFBNEQsR0FDNUQsT0FBTyxNQUFNLDhCQUNYLHVDQUF1QztBQVl6Qzs7Ozs7O0NBTUMsR0FDRCxTQUFTLGNBQWMsSUFBWSxFQUFFLEdBQVc7RUFDOUMsTUFBTSxVQUFVLElBQUksSUFBSSxHQUFHLFdBQVc7RUFDdEMsSUFBSSxDQUFDLGtCQUFrQixVQUFVO0lBQy9CLE1BQU0sSUFBSSxNQUNSLENBQUMsb0RBQW9ELEVBQUUsS0FBSyxFQUFFLEVBQUUsSUFBSSxFQUFFLENB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
// denoCacheMetadata=685274673889732033,11931239087277185333