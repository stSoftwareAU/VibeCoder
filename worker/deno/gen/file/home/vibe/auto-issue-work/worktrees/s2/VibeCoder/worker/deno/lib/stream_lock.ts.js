/**
 * Stream locks — one run per conversation.
 *
 * Two locks live here, and exactly one of them applies to any given issue:
 *
 * - {@link checkMilestoneStreamBusy} — the **fleet-wide** milestone lock
 *   (Issue #2334), which reads GitHub.
 * - {@link BlankStreamLockRegistry} — the **host-local** blank-stream lock
 *   (Issue #2335), which reads nothing.
 *
 * ## Fleet-wide milestone stream lock (Issue #2334)
 *
 * One run per milestone stream at a time, across the whole fleet. A stream
 * owns one agent conversation (Issue #2331), so two hosts working two
 * sub-issues of the same milestone at once are two runs inside one
 * conversation — a bug, not a fork.
 *
 * Issue #2530 qualifies that for two tiers: a `top-priority` or `work-on`
 * issue is claimed into a busy stream anyway and runs in its **own per-issue
 * conversation**, so the stream's conversation still carries one run. This
 * module is unchanged by that — it reports `busy` exactly as before, and the
 * caller (`preClaimFreshnessCheck`, `shareable`) decides whether to wait.
 *
 * Before a claim is taken, this module reads the milestone's **other open
 * issues** and asks whether any of them is live:
 *
 * - a heartbeat marker that beat inside `LIVE_HEARTBEAT_WINDOW_SECONDS`, or
 * - a fleet `CLAIM_LOCK` comment posted inside
 *   {@link RECENT_CLAIM_WINDOW_MS} — the window before the holder's first
 *   marker refresh has landed.
 *
 * Anything older is stale and does not block: a crashed run must never hold a
 * stream shut. The blank stream — a repository's issues with no milestone —
 * is never checked, because it owns no shared conversation to collide in.
 *
 * ## Cost
 *
 * One `gh issue list` per candidate. The listing carries each sibling's
 * comments, so the markers are read from the same response rather than one
 * `gh` call per sibling. The read is deliberately **not** served from the
 * `IssueCache`: its 600 s TTL is longer than the liveness window this check
 * measures, so a cached snapshot would report a finished run as live and a
 * live one as free.
 *
 * ## Fail direction
 *
 * Fails **open**, loudly: a `gh` outage, an unparseable response or a
 * repository this module cannot resolve to a stream logs a warning and lets
 * the claim proceed, matching every other pre-claim check — an unreachable
 * GitHub must not stop the fleet claiming work. A page that filled — of the
 * milestone's issues, or of one sibling's comments — is logged too, because
 * "not read" must never be reported as "nothing there".
 *
 * ## Host-local blank-stream lock (Issue #2335)
 *
 * The blank stream — a repository's issues carrying no milestone — has no
 * fleet-wide conversation to collide in: each host keeps its **own** blank
 * conversation per repository (`stream_session.ts`), so two hosts working two
 * of that repository's non-milestone issues at once are two conversations,
 * which is correct. Two *slots on one host* doing it are two runs inside one
 * conversation, which is not.
 *
 * So the blank lock is in-process and reads no GitHub state at all —
 * {@link BlankStreamLockRegistry}, keyed by
 * {@link streamKey}. Keying it by the conversation's own key is the point: the
 * slot exclusion already in place (`in_flight_repos.ts`) keys by
 * `(repo, milestone-title-as-given)`, which is a *coarser* partition than the
 * conversation store's — a title that differs only in surrounding whitespace
 * is two work-stream keys but one conversation. Where the two disagree, the
 * conversation is what matters, so this lock asks `streamKey` and nothing
 * else. It only ever adds a refusal, never permits one the slot registry
 * refuses, so the registry stays the hard guarantee it always was.
 *
 * A milestone issue takes no hold here — {@link checkMilestoneStreamBusy}
 * covers it — so the two locks never both apply to one issue.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ import { CLAIM_MARKER_PREFIX, findLiveHeartbeatMarker, RECENT_CLAIM_WINDOW_MS } from "./claim_issue.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { hostFromMachineId, parseHeartbeatMarker } from "./heartbeat_storage.ts";
import { isBlankStream, resolveStreamId, streamKey, streamLabel } from "./stream_identity.ts";
/**
 * How many of the milestone's open issues are read.
 *
 * A milestone with more open sub-issues than this is already far past the
 * point where one conversation is the right shape, and the listing is one
 * API page either way.
 */ export const STREAM_LOCK_ISSUE_LIMIT = 100;
/**
 * How many comments `gh issue list --json comments` returns per issue.
 *
 * The page is gh's, not ours: a thread longer than this is returned
 * truncated, so a marker beyond the page is unread rather than absent.
 */ const COMMENT_PAGE_SIZE = 100;
/** Host recorded in a claim comment body — `Claimed by \`id\` on host \`name\``. */ const CLAIM_HOST_PATTERN = /on host `([^`]+)`/u;
/** Host shown when neither the claim body nor the author names one. */ const UNKNOWN_HOST = "unknown-host";
/**
 * The one line a stream-busy skip logs, and the detail it reports.
 *
 * Exported so the claim path, the tests and a log grep share one wording
 * rather than re-spelling it.
 */ export function formatStreamBusy(status) {
  return `stream busy: ${status.streamLabel} held by #${status.holderIssue} ` + `on ${status.holderHost}`;
}
/** Comments of `issue`, narrowed to fleet authors when a trust set was given. */ function fleetComments(issue, trustedAuthors) {
  if (!Array.isArray(issue.comments)) return [];
  const filterByAuthor = trustedAuthors.length > 0;
  return issue.comments.filter((comment)=>{
    if (!comment || typeof comment.body !== "string") return false;
    if (!filterByAuthor) return true;
    const login = comment.author?.login;
    return isFleetAuthor(typeof login === "string" ? login : undefined, trustedAuthors);
  });
}
/** The host a claim comment names, falling back to its author. */ function claimHost(comment) {
  const body = String(comment.body ?? "");
  const named = CLAIM_HOST_PATTERN.exec(body)?.[1];
  if (named !== undefined && named.trim() !== "") return named.trim();
  const login = comment.author?.login;
  return typeof login === "string" && login.trim() !== "" ? login.trim() : UNKNOWN_HOST;
}
/** The live heartbeat on `comments`, or null when none is beating. */ function liveHeartbeatHost(comments, nowSeconds) {
  const markers = comments.map((comment)=>parseHeartbeatMarker(String(comment.body))).filter((marker)=>marker !== null);
  const live = findLiveHeartbeatMarker(markers, nowSeconds);
  return live === null ? null : hostFromMachineId(live.machineId);
}
/** The host holding a `CLAIM_LOCK` posted inside the recent window, or null. */ function freshClaimHost(comments, nowMs) {
  for (const comment of comments){
    if (!String(comment.body).includes(CLAIM_MARKER_PREFIX)) continue;
    const createdAt = typeof comment.createdAt === "string" ? Date.parse(comment.createdAt) : Number.NaN;
    if (!Number.isFinite(createdAt)) continue;
    const ageMs = nowMs - createdAt;
    if (ageMs >= 0 && ageMs < RECENT_CLAIM_WINDOW_MS) return claimHost(comment);
  }
  return null;
}
/**
 * Is another open issue of this milestone stream already being run?
 *
 * Returns `{ busy: false }` for the blank stream without making any API call,
 * and for a milestone whose other open issues carry nothing live. A closed
 * sibling is never listed, a sibling in another milestone or repository is
 * never listed, and the issue being claimed never blocks itself.
 *
 * Never throws: a repository that is not `owner/name` — which
 * `resolveStreamId` refuses to resolve — is reported as a loud warning and a
 * fail-open, because a stream check must never turn a claim into a run
 * failure.
 */ export async function checkMilestoneStreamBusy(options) {
  const { repo, milestoneTitle, issueNumber, ghCommandFn, trustedAuthors = [], nowSeconds = Math.floor(Date.now() / 1000) } = options;
  let stream;
  try {
    stream = resolveStreamId(repo, milestoneTitle);
  } catch (err) {
    // `resolveStreamId` fails loud on a malformed repository, and rightly —
    // but a claim must not fail with it, so the refusal is reported and the
    // claim proceeds unlocked.
    console.warn(`[stream_lock] repo=${repo} issue=#${issueNumber} ` + `stream_unresolved error=${err instanceof Error ? err.message : String(err)} — proceeding with the claim (Issue #2334)`);
    return {
      busy: false
    };
  }
  // The blank stream holds no shared conversation, so nothing to lock.
  // Reading the resolved title back is what narrows it for the query below —
  // `resolveStreamId` leaves it undefined for exactly this case.
  const title = stream.milestoneTitle;
  if (isBlankStream(stream) || title === undefined) return {
    busy: false
  };
  const label = streamLabel(stream);
  let issues;
  try {
    const json = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--milestone",
      title,
      "--limit",
      String(STREAM_LOCK_ISSUE_LIMIT),
      "--json",
      "number,comments"
    ]);
    const parsed = JSON.parse(json || "[]");
    if (!Array.isArray(parsed)) {
      throw new Error(`expected a JSON array, got ${typeof parsed}`);
    }
    issues = parsed;
  } catch (err) {
    // Fail open, loudly: an unreachable GitHub must not stop the fleet
    // claiming work, but it must never be mistaken for "the stream is free".
    console.warn(`[stream_lock] repo=${repo} issue=#${issueNumber} ` + `stream_check_failed stream=${label} error=${err instanceof Error ? err.message : String(err)} — proceeding with the claim (Issue #2334)`);
    return {
      busy: false
    };
  }
  // A listing that filled the page may have left live siblings unread, and
  // "unread" must never read as "the stream is free" — say so.
  if (issues.length >= STREAM_LOCK_ISSUE_LIMIT) {
    console.warn(`[stream_lock] repo=${repo} issue=#${issueNumber} ` + `stream_listing_truncated stream=${label} ` + `limit=${STREAM_LOCK_ISSUE_LIMIT} — open issues beyond the limit ` + `were not read, so a live sibling among them cannot hold the ` + `stream (Issue #2334)`);
  }
  const nowMs = nowSeconds * 1000;
  for (const issue of issues){
    if (typeof issue?.number !== "number") continue;
    if (issue.number === issueNumber) continue;
    const comments = fleetComments(issue, trustedAuthors);
    if (comments.length === 0) continue;
    // gh returns one page of comments per issue, so a longer thread hides
    // its newest markers — unread, not absent.
    if (Array.isArray(issue.comments) && issue.comments.length >= COMMENT_PAGE_SIZE) {
      console.warn(`[stream_lock] repo=${repo} issue=#${issueNumber} ` + `sibling_comments_truncated sibling=#${issue.number} ` + `page=${COMMENT_PAGE_SIZE} — markers past the first page were not ` + `read (Issue #2334)`);
    }
    const beating = liveHeartbeatHost(comments, nowSeconds);
    if (beating !== null) {
      return {
        busy: true,
        holderIssue: issue.number,
        holderHost: beating,
        streamLabel: label
      };
    }
    const claiming = freshClaimHost(comments, nowMs);
    if (claiming !== null) {
      return {
        busy: true,
        holderIssue: issue.number,
        holderHost: claiming,
        streamLabel: label
      };
    }
  }
  return {
    busy: false
  };
}
/**
 * The blank stream of `ref`, or `undefined` when it is a milestone stream or
 * an unresolvable repository.
 *
 * Fails open, loudly: `resolveStreamId` throws on a repository that is not
 * `owner/name`, and a lock must never turn a claim into a run failure — but
 * the refusal is reported, never swallowed.
 */ function blankStreamOf(ref) {
  let stream;
  try {
    stream = resolveStreamId(ref.repo, ref.milestoneTitle);
  } catch (err) {
    console.warn(`[stream_lock] repo=${ref.repo} stream_unresolved error=${err instanceof Error ? err.message : String(err)} — no host-local blank-stream lock is taken (Issue #2335)`);
    return undefined;
  }
  return isBlankStream(stream) ? stream : undefined;
}
/**
 * The line a blank-stream refusal logs.
 *
 * Exported so the slot pool, the tests and a log grep share one wording. The
 * `stream busy:` stem matches {@link formatStreamBusy} on purpose — one grep
 * finds both locks' refusals — while the tail names a slot rather than a host,
 * because that is what a host-local lock can tell you.
 */ export function formatBlankStreamBusy(hold) {
  return `stream busy: ${hold.streamLabel} held by slot ${hold.slotId} ` + `on #${hold.issueNumber}`;
}
/**
 * In-process registry of the blank streams this host's slots hold.
 *
 * One hold per repository's blank stream: the slot that takes it runs that
 * repository's non-milestone issue, and a sibling slot finding the stream held
 * is refused and looks for other work. Deliberately host-local — it consults
 * no GitHub state, so another host holds the same repository's blank stream in
 * parallel with its own conversation.
 *
 * Acquisition is atomic against concurrent slot starts by construction: Deno
 * is single-threaded and {@link tryAcquire} is synchronous, so two slots
 * racing on one stream interleave at await points, never inside the
 * check-and-set. Every terminal exit — success, skip, failure, throw, timeout,
 * kill — must {@link release}; the caller holds that in a `finally`.
 */ export class BlankStreamLockRegistry {
  #held = new Map();
  #now;
  constructor(now = Date.now){
    this.#now = now;
  }
  /**
   * Try to take a repository's blank stream for a slot.
   *
   * A milestone issue takes nothing and always wins: the fleet-wide lock of
   * Issue #2334 is what gates it, and the two never both apply.
   *
   * @param options - The issue being claimed and the slot claiming it
   * @returns Whether the caller may proceed, and who holds it if not
   */ tryAcquire(options) {
    const stream = blankStreamOf(options);
    if (stream === undefined) return {
      acquired: true,
      locked: false
    };
    const key = streamKey(stream);
    const holder = this.#held.get(key);
    if (holder !== undefined) return {
      acquired: false,
      holder
    };
    this.#held.set(key, {
      streamKey: key,
      repo: stream.repo,
      streamLabel: streamLabel(stream),
      slotId: options.slotId,
      issueNumber: options.issueNumber,
      sinceMs: this.#now()
    });
    return {
      acquired: true,
      locked: true
    };
  }
  /**
   * Release a slot's hold on a repository's blank stream.
   *
   * Idempotent, and a no-op for a milestone issue or an unresolvable
   * repository — so the run-end `finally` is safe to call on every path.
   */ release(ref) {
    const stream = blankStreamOf(ref);
    if (stream === undefined) return;
    this.#held.delete(streamKey(stream));
  }
  /** The hold on this repository's blank stream, or `undefined` when free. */ holder(ref) {
    const stream = blankStreamOf(ref);
    return stream === undefined ? undefined : this.#held.get(streamKey(stream));
  }
  /**
   * `owner/name` of every repository whose blank stream a slot holds, so the
   * idle-decision census can count their non-milestone issues as
   * stream-occupied rather than claimable (Issue #2800).
   */ heldRepos() {
    return [
      ...this.#held.values()
    ].map((hold)=>hold.repo);
  }
  /** Number of blank streams held. */ get size() {
    return this.#held.size;
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zdHJlYW1fbG9jay50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN0cmVhbSBsb2NrcyDigJQgb25lIHJ1biBwZXIgY29udmVyc2F0aW9uLlxuICpcbiAqIFR3byBsb2NrcyBsaXZlIGhlcmUsIGFuZCBleGFjdGx5IG9uZSBvZiB0aGVtIGFwcGxpZXMgdG8gYW55IGdpdmVuIGlzc3VlOlxuICpcbiAqIC0ge0BsaW5rIGNoZWNrTWlsZXN0b25lU3RyZWFtQnVzeX0g4oCUIHRoZSAqKmZsZWV0LXdpZGUqKiBtaWxlc3RvbmUgbG9ja1xuICogICAoSXNzdWUgIzIzMzQpLCB3aGljaCByZWFkcyBHaXRIdWIuXG4gKiAtIHtAbGluayBCbGFua1N0cmVhbUxvY2tSZWdpc3RyeX0g4oCUIHRoZSAqKmhvc3QtbG9jYWwqKiBibGFuay1zdHJlYW0gbG9ja1xuICogICAoSXNzdWUgIzIzMzUpLCB3aGljaCByZWFkcyBub3RoaW5nLlxuICpcbiAqICMjIEZsZWV0LXdpZGUgbWlsZXN0b25lIHN0cmVhbSBsb2NrIChJc3N1ZSAjMjMzNClcbiAqXG4gKiBPbmUgcnVuIHBlciBtaWxlc3RvbmUgc3RyZWFtIGF0IGEgdGltZSwgYWNyb3NzIHRoZSB3aG9sZSBmbGVldC4gQSBzdHJlYW1cbiAqIG93bnMgb25lIGFnZW50IGNvbnZlcnNhdGlvbiAoSXNzdWUgIzIzMzEpLCBzbyB0d28gaG9zdHMgd29ya2luZyB0d29cbiAqIHN1Yi1pc3N1ZXMgb2YgdGhlIHNhbWUgbWlsZXN0b25lIGF0IG9uY2UgYXJlIHR3byBydW5zIGluc2lkZSBvbmVcbiAqIGNvbnZlcnNhdGlvbiDigJQgYSBidWcsIG5vdCBhIGZvcmsuXG4gKlxuICogSXNzdWUgIzI1MzAgcXVhbGlmaWVzIHRoYXQgZm9yIHR3byB0aWVyczogYSBgdG9wLXByaW9yaXR5YCBvciBgd29yay1vbmBcbiAqIGlzc3VlIGlzIGNsYWltZWQgaW50byBhIGJ1c3kgc3RyZWFtIGFueXdheSBhbmQgcnVucyBpbiBpdHMgKipvd24gcGVyLWlzc3VlXG4gKiBjb252ZXJzYXRpb24qKiwgc28gdGhlIHN0cmVhbSdzIGNvbnZlcnNhdGlvbiBzdGlsbCBjYXJyaWVzIG9uZSBydW4uIFRoaXNcbiAqIG1vZHVsZSBpcyB1bmNoYW5nZWQgYnkgdGhhdCDigJQgaXQgcmVwb3J0cyBgYnVzeWAgZXhhY3RseSBhcyBiZWZvcmUsIGFuZCB0aGVcbiAqIGNhbGxlciAoYHByZUNsYWltRnJlc2huZXNzQ2hlY2tgLCBgc2hhcmVhYmxlYCkgZGVjaWRlcyB3aGV0aGVyIHRvIHdhaXQuXG4gKlxuICogQmVmb3JlIGEgY2xhaW0gaXMgdGFrZW4sIHRoaXMgbW9kdWxlIHJlYWRzIHRoZSBtaWxlc3RvbmUncyAqKm90aGVyIG9wZW5cbiAqIGlzc3VlcyoqIGFuZCBhc2tzIHdoZXRoZXIgYW55IG9mIHRoZW0gaXMgbGl2ZTpcbiAqXG4gKiAtIGEgaGVhcnRiZWF0IG1hcmtlciB0aGF0IGJlYXQgaW5zaWRlIGBMSVZFX0hFQVJUQkVBVF9XSU5ET1dfU0VDT05EU2AsIG9yXG4gKiAtIGEgZmxlZXQgYENMQUlNX0xPQ0tgIGNvbW1lbnQgcG9zdGVkIGluc2lkZVxuICogICB7QGxpbmsgUkVDRU5UX0NMQUlNX1dJTkRPV19NU30g4oCUIHRoZSB3aW5kb3cgYmVmb3JlIHRoZSBob2xkZXIncyBmaXJzdFxuICogICBtYXJrZXIgcmVmcmVzaCBoYXMgbGFuZGVkLlxuICpcbiAqIEFueXRoaW5nIG9sZGVyIGlzIHN0YWxlIGFuZCBkb2VzIG5vdCBibG9jazogYSBjcmFzaGVkIHJ1biBtdXN0IG5ldmVyIGhvbGQgYVxuICogc3RyZWFtIHNodXQuIFRoZSBibGFuayBzdHJlYW0g4oCUIGEgcmVwb3NpdG9yeSdzIGlzc3VlcyB3aXRoIG5vIG1pbGVzdG9uZSDigJRcbiAqIGlzIG5ldmVyIGNoZWNrZWQsIGJlY2F1c2UgaXQgb3ducyBubyBzaGFyZWQgY29udmVyc2F0aW9uIHRvIGNvbGxpZGUgaW4uXG4gKlxuICogIyMgQ29zdFxuICpcbiAqIE9uZSBgZ2ggaXNzdWUgbGlzdGAgcGVyIGNhbmRpZGF0ZS4gVGhlIGxpc3RpbmcgY2FycmllcyBlYWNoIHNpYmxpbmcnc1xuICogY29tbWVudHMsIHNvIHRoZSBtYXJrZXJzIGFyZSByZWFkIGZyb20gdGhlIHNhbWUgcmVzcG9uc2UgcmF0aGVyIHRoYW4gb25lXG4gKiBgZ2hgIGNhbGwgcGVyIHNpYmxpbmcuIFRoZSByZWFkIGlzIGRlbGliZXJhdGVseSAqKm5vdCoqIHNlcnZlZCBmcm9tIHRoZVxuICogYElzc3VlQ2FjaGVgOiBpdHMgNjAwIHMgVFRMIGlzIGxvbmdlciB0aGFuIHRoZSBsaXZlbmVzcyB3aW5kb3cgdGhpcyBjaGVja1xuICogbWVhc3VyZXMsIHNvIGEgY2FjaGVkIHNuYXBzaG90IHdvdWxkIHJlcG9ydCBhIGZpbmlzaGVkIHJ1biBhcyBsaXZlIGFuZCBhXG4gKiBsaXZlIG9uZSBhcyBmcmVlLlxuICpcbiAqICMjIEZhaWwgZGlyZWN0aW9uXG4gKlxuICogRmFpbHMgKipvcGVuKiosIGxvdWRseTogYSBgZ2hgIG91dGFnZSwgYW4gdW5wYXJzZWFibGUgcmVzcG9uc2Ugb3IgYVxuICogcmVwb3NpdG9yeSB0aGlzIG1vZHVsZSBjYW5ub3QgcmVzb2x2ZSB0byBhIHN0cmVhbSBsb2dzIGEgd2FybmluZyBhbmQgbGV0c1xuICogdGhlIGNsYWltIHByb2NlZWQsIG1hdGNoaW5nIGV2ZXJ5IG90aGVyIHByZS1jbGFpbSBjaGVjayDigJQgYW4gdW5yZWFjaGFibGVcbiAqIEdpdEh1YiBtdXN0IG5vdCBzdG9wIHRoZSBmbGVldCBjbGFpbWluZyB3b3JrLiBBIHBhZ2UgdGhhdCBmaWxsZWQg4oCUIG9mIHRoZVxuICogbWlsZXN0b25lJ3MgaXNzdWVzLCBvciBvZiBvbmUgc2libGluZydzIGNvbW1lbnRzIOKAlCBpcyBsb2dnZWQgdG9vLCBiZWNhdXNlXG4gKiBcIm5vdCByZWFkXCIgbXVzdCBuZXZlciBiZSByZXBvcnRlZCBhcyBcIm5vdGhpbmcgdGhlcmVcIi5cbiAqXG4gKiAjIyBIb3N0LWxvY2FsIGJsYW5rLXN0cmVhbSBsb2NrIChJc3N1ZSAjMjMzNSlcbiAqXG4gKiBUaGUgYmxhbmsgc3RyZWFtIOKAlCBhIHJlcG9zaXRvcnkncyBpc3N1ZXMgY2Fycnlpbmcgbm8gbWlsZXN0b25lIOKAlCBoYXMgbm9cbiAqIGZsZWV0LXdpZGUgY29udmVyc2F0aW9uIHRvIGNvbGxpZGUgaW46IGVhY2ggaG9zdCBrZWVwcyBpdHMgKipvd24qKiBibGFua1xuICogY29udmVyc2F0aW9uIHBlciByZXBvc2l0b3J5IChgc3RyZWFtX3Nlc3Npb24udHNgKSwgc28gdHdvIGhvc3RzIHdvcmtpbmcgdHdvXG4gKiBvZiB0aGF0IHJlcG9zaXRvcnkncyBub24tbWlsZXN0b25lIGlzc3VlcyBhdCBvbmNlIGFyZSB0d28gY29udmVyc2F0aW9ucyxcbiAqIHdoaWNoIGlzIGNvcnJlY3QuIFR3byAqc2xvdHMgb24gb25lIGhvc3QqIGRvaW5nIGl0IGFyZSB0d28gcnVucyBpbnNpZGUgb25lXG4gKiBjb252ZXJzYXRpb24sIHdoaWNoIGlzIG5vdC5cbiAqXG4gKiBTbyB0aGUgYmxhbmsgbG9jayBpcyBpbi1wcm9jZXNzIGFuZCByZWFkcyBubyBHaXRIdWIgc3RhdGUgYXQgYWxsIOKAlFxuICoge0BsaW5rIEJsYW5rU3RyZWFtTG9ja1JlZ2lzdHJ5fSwga2V5ZWQgYnlcbiAqIHtAbGluayBzdHJlYW1LZXl9LiBLZXlpbmcgaXQgYnkgdGhlIGNvbnZlcnNhdGlvbidzIG93biBrZXkgaXMgdGhlIHBvaW50OiB0aGVcbiAqIHNsb3QgZXhjbHVzaW9uIGFscmVhZHkgaW4gcGxhY2UgKGBpbl9mbGlnaHRfcmVwb3MudHNgKSBrZXlzIGJ5XG4gKiBgKHJlcG8sIG1pbGVzdG9uZS10aXRsZS1hcy1naXZlbilgLCB3aGljaCBpcyBhICpjb2Fyc2VyKiBwYXJ0aXRpb24gdGhhbiB0aGVcbiAqIGNvbnZlcnNhdGlvbiBzdG9yZSdzIOKAlCBhIHRpdGxlIHRoYXQgZGlmZmVycyBvbmx5IGluIHN1cnJvdW5kaW5nIHdoaXRlc3BhY2VcbiAqIGlzIHR3byB3b3JrLXN0cmVhbSBrZXlzIGJ1dCBvbmUgY29udmVyc2F0aW9uLiBXaGVyZSB0aGUgdHdvIGRpc2FncmVlLCB0aGVcbiAqIGNvbnZlcnNhdGlvbiBpcyB3aGF0IG1hdHRlcnMsIHNvIHRoaXMgbG9jayBhc2tzIGBzdHJlYW1LZXlgIGFuZCBub3RoaW5nXG4gKiBlbHNlLiBJdCBvbmx5IGV2ZXIgYWRkcyBhIHJlZnVzYWwsIG5ldmVyIHBlcm1pdHMgb25lIHRoZSBzbG90IHJlZ2lzdHJ5XG4gKiByZWZ1c2VzLCBzbyB0aGUgcmVnaXN0cnkgc3RheXMgdGhlIGhhcmQgZ3VhcmFudGVlIGl0IGFsd2F5cyB3YXMuXG4gKlxuICogQSBtaWxlc3RvbmUgaXNzdWUgdGFrZXMgbm8gaG9sZCBoZXJlIOKAlCB7QGxpbmsgY2hlY2tNaWxlc3RvbmVTdHJlYW1CdXN5fVxuICogY292ZXJzIGl0IOKAlCBzbyB0aGUgdHdvIGxvY2tzIG5ldmVyIGJvdGggYXBwbHkgdG8gb25lIGlzc3VlLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB1c2VkIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQge1xuICBDTEFJTV9NQVJLRVJfUFJFRklYLFxuICBmaW5kTGl2ZUhlYXJ0YmVhdE1hcmtlcixcbiAgUkVDRU5UX0NMQUlNX1dJTkRPV19NUyxcbn0gZnJvbSBcIi4vY2xhaW1faXNzdWUudHNcIjtcbmltcG9ydCB7IGlzRmxlZXRBdXRob3IgfSBmcm9tIFwiLi9mbGVldF9hdXRob3JzLnRzXCI7XG5pbXBvcnQge1xuICBob3N0RnJvbU1hY2hpbmVJZCxcbiAgcGFyc2VIZWFydGJlYXRNYXJrZXIsXG59IGZyb20gXCIuL2hlYXJ0YmVhdF9zdG9yYWdlLnRzXCI7XG5pbXBvcnQge1xuICBpc0JsYW5rU3RyZWFtLFxuICByZXNvbHZlU3RyZWFtSWQsXG4gIHR5cGUgU3RyZWFtSWQsXG4gIHN0cmVhbUtleSxcbiAgc3RyZWFtTGFiZWwsXG59IGZyb20gXCIuL3N0cmVhbV9pZGVudGl0eS50c1wiO1xuXG4vKipcbiAqIEhvdyBtYW55IG9mIHRoZSBtaWxlc3RvbmUncyBvcGVuIGlzc3VlcyBhcmUgcmVhZC5cbiAqXG4gKiBBIG1pbGVzdG9uZSB3aXRoIG1vcmUgb3BlbiBzdWItaXNzdWVzIHRoYW4gdGhpcyBpcyBhbHJlYWR5IGZhciBwYXN0IHRoZVxuICogcG9pbnQgd2hlcmUgb25lIGNvbnZlcnNhdGlvbiBpcyB0aGUgcmlnaHQgc2hhcGUsIGFuZCB0aGUgbGlzdGluZyBpcyBvbmVcbiAqIEFQSSBwYWdlIGVpdGhlciB3YXkuXG4gKi9cbmV4cG9ydCBjb25zdCBTVFJFQU1fTE9DS19JU1NVRV9MSU1JVCA9IDEwMDtcblxuLyoqXG4gKiBIb3cgbWFueSBjb21tZW50cyBgZ2ggaXNzdWUgbGlzdCAtLWpzb24gY29tbWVudHNgIHJldHVybnMgcGVyIGlzc3VlLlxuICpcbiAqIFRoZSBwYWdlIGlzIGdoJ3MsIG5vdCBvdXJzOiBhIHRocmVhZCBsb25nZXIgdGhhbiB0aGlzIGlzIHJldHVybmVkXG4gKiB0cnVuY2F0ZWQsIHNvIGEgbWFya2VyIGJleW9uZCB0aGUgcGFnZSBpcyB1bnJlYWQgcmF0aGVyIHRoYW4gYWJzZW50LlxuICovXG5jb25zdCBDT01NRU5UX1BBR0VfU0laRSA9IDEwMDtcblxuLyoqIEEgc2libGluZyBpc3N1ZSBpbiB0aGUgc2FtZSBzdHJlYW0gaXMgbGl2ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RyZWFtQnVzeSB7XG4gIGJ1c3k6IHRydWU7XG4gIC8qKiBUaGUgc2libGluZyBpc3N1ZSB3aG9zZSBydW4gaG9sZHMgdGhlIHN0cmVhbS4gKi9cbiAgaG9sZGVySXNzdWU6IG51bWJlcjtcbiAgLyoqIEhvc3QgcnVubmluZyBpdCDigJQgZnJvbSB0aGUgaGVhcnRiZWF0J3MgbWFjaGluZSBpZCwgb3IgdGhlIGNsYWltIGNvbW1lbnQuICovXG4gIGhvbGRlckhvc3Q6IHN0cmluZztcbiAgLyoqIEh1bWFuIGxhYmVsIG9mIHRoZSBzdHJlYW0sIGFzIHtAbGluayBzdHJlYW1MYWJlbH0gcmVuZGVycyBpdC4gKi9cbiAgc3RyZWFtTGFiZWw6IHN0cmluZztcbn1cblxuLyoqIE91dGNvbWUgb2YgYSBzdHJlYW0tbG9jayBjaGVjay4gKi9cbmV4cG9ydCB0eXBlIFN0cmVhbUxvY2tTdGF0dXMgPSB7IGJ1c3k6IGZhbHNlIH0gfCBTdHJlYW1CdXN5O1xuXG4vKiogRXZlcnl0aGluZyB7QGxpbmsgY2hlY2tNaWxlc3RvbmVTdHJlYW1CdXN5fSBuZWVkcy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RyZWFtTG9ja09wdGlvbnMge1xuICAvKiogYG93bmVyL25hbWVgIHRoZSBpc3N1ZSBsaXZlcyBpbi4gKi9cbiAgcmVwbzogc3RyaW5nO1xuICAvKiogVGhlIGlzc3VlJ3MgbWlsZXN0b25lIHRpdGxlOyBhYnNlbnQgb3IgYmxhbmsgbWVhbnMgdGhlIGJsYW5rIHN0cmVhbS4gKi9cbiAgbWlsZXN0b25lVGl0bGU/OiBzdHJpbmc7XG4gIC8qKiBUaGUgaXNzdWUgYmVpbmcgY2xhaW1lZCDigJQgbmV2ZXIgYmxvY2tzIGl0c2VsZi4gKi9cbiAgaXNzdWVOdW1iZXI6IG51bWJlcjtcbiAgLyoqIEluamVjdGVkIGBnaGAgcnVubmVyLiAqL1xuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIC8qKlxuICAgKiBGbGVldCBsb2dpbnMgd2hvc2UgbWFya2VycyBhcmUgdHJ1c3RlZCAoYHJlc29sdmVGbGVldEF1dGhvcnNgKS4gQSBtYXJrZXJcbiAgICogaXMgdGV4dCBpbiBhIGNvbW1lbnQgYm9keSBhbnkgR2l0SHViIHVzZXIgY2FuIHBvc3QsIHNvIG9ubHkgYSBmbGVldFxuICAgKiBhY2NvdW50J3MgbWFya2VyIGhvbGRzIGEgc3RyZWFtLiBBbiBlbXB0eSBsaXN0IGRpc2FibGVzIHRoZSBmaWx0ZXIsXG4gICAqIG1hdGNoaW5nIGBzY2FuSGVhcnRiZWF0TWFya2Vyc2AgYW5kIHRoZSBwcmUtY2xhaW0gY2hlY2suXG4gICAqL1xuICB0cnVzdGVkQXV0aG9ycz86IHN0cmluZ1tdO1xuICAvKiogQ3VycmVudCBlcG9jaCBzZWNvbmRzLiBEZWZhdWx0cyB0byB0aGUgd2FsbCBjbG9jay4gKi9cbiAgbm93U2Vjb25kcz86IG51bWJlcjtcbn1cblxuLyoqIE9uZSBjb21tZW50IGFzIGBnaCBpc3N1ZSBsaXN0IC0tanNvbiBjb21tZW50c2AgcmV0dXJucyBpdC4gKi9cbmludGVyZmFjZSBMaXN0ZWRDb21tZW50IHtcbiAgYm9keT86IHVua25vd247XG4gIGF1dGhvcj86IHsgbG9naW4/OiB1bmtub3duIH0gfCBudWxsO1xuICBjcmVhdGVkQXQ/OiB1bmtub3duO1xufVxuXG4vKiogT25lIGlzc3VlIGFzIGBnaCBpc3N1ZSBsaXN0IC0tanNvbiBudW1iZXIsY29tbWVudHNgIHJldHVybnMgaXQuICovXG5pbnRlcmZhY2UgTGlzdGVkSXNzdWUge1xuICBudW1iZXI/OiB1bmtub3duO1xuICBjb21tZW50cz86IHVua25vd247XG59XG5cbi8qKiBIb3N0IHJlY29yZGVkIGluIGEgY2xhaW0gY29tbWVudCBib2R5IOKAlCBgQ2xhaW1lZCBieSBcXGBpZFxcYCBvbiBob3N0IFxcYG5hbWVcXGBgLiAqL1xuY29uc3QgQ0xBSU1fSE9TVF9QQVRURVJOID0gL29uIGhvc3QgYChbXmBdKylgL3U7XG5cbi8qKiBIb3N0IHNob3duIHdoZW4gbmVpdGhlciB0aGUgY2xhaW0gYm9keSBub3IgdGhlIGF1dGhvciBuYW1lcyBvbmUuICovXG5jb25zdCBVTktOT1dOX0hPU1QgPSBcInVua25vd24taG9zdFwiO1xuXG4vKipcbiAqIFRoZSBvbmUgbGluZSBhIHN0cmVhbS1idXN5IHNraXAgbG9ncywgYW5kIHRoZSBkZXRhaWwgaXQgcmVwb3J0cy5cbiAqXG4gKiBFeHBvcnRlZCBzbyB0aGUgY2xhaW0gcGF0aCwgdGhlIHRlc3RzIGFuZCBhIGxvZyBncmVwIHNoYXJlIG9uZSB3b3JkaW5nXG4gKiByYXRoZXIgdGhhbiByZS1zcGVsbGluZyBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFN0cmVhbUJ1c3koc3RhdHVzOiBTdHJlYW1CdXN5KTogc3RyaW5nIHtcbiAgcmV0dXJuIGBzdHJlYW0gYnVzeTogJHtzdGF0dXMuc3RyZWFtTGFiZWx9IGhlbGQgYnkgIyR7c3RhdHVzLmhvbGRlcklzc3VlfSBgICtcbiAgICBgb24gJHtzdGF0dXMuaG9sZGVySG9zdH1gO1xufVxuXG4vKiogQ29tbWVudHMgb2YgYGlzc3VlYCwgbmFycm93ZWQgdG8gZmxlZXQgYXV0aG9ycyB3aGVuIGEgdHJ1c3Qgc2V0IHdhcyBnaXZlbi4gKi9cbmZ1bmN0aW9uIGZsZWV0Q29tbWVudHMoXG4gIGlzc3VlOiBMaXN0ZWRJc3N1ZSxcbiAgdHJ1c3RlZEF1dGhvcnM6IHN0cmluZ1tdLFxuKTogTGlzdGVkQ29tbWVudFtdIHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGlzc3VlLmNvbW1lbnRzKSkgcmV0dXJuIFtdO1xuICBjb25zdCBmaWx0ZXJCeUF1dGhvciA9IHRydXN0ZWRBdXRob3JzLmxlbmd0aCA+IDA7XG4gIHJldHVybiAoaXNzdWUuY29tbWVudHMgYXMgTGlzdGVkQ29tbWVudFtdKS5maWx0ZXIoKGNvbW1lbnQpID0+IHtcbiAgICBpZiAoIWNvbW1lbnQgfHwgdHlwZW9mIGNvbW1lbnQuYm9keSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghZmlsdGVyQnlBdXRob3IpIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IGxvZ2luID0gY29tbWVudC5hdXRob3I/LmxvZ2luO1xuICAgIHJldHVybiBpc0ZsZWV0QXV0aG9yKFxuICAgICAgdHlwZW9mIGxvZ2luID09PSBcInN0cmluZ1wiID8gbG9naW4gOiB1bmRlZmluZWQsXG4gICAgICB0cnVzdGVkQXV0aG9ycyxcbiAgICApO1xuICB9KTtcbn1cblxuLyoqIFRoZSBob3N0IGEgY2xhaW0gY29tbWVudCBuYW1lcywgZmFsbGluZyBiYWNrIHRvIGl0cyBhdXRob3IuICovXG5mdW5jdGlvbiBjbGFpbUhvc3QoY29tbWVudDogTGlzdGVkQ29tbWVudCk6IHN0cmluZyB7XG4gIGNvbnN0IGJvZHkgPSBTdHJpbmcoY29tbWVudC5ib2R5ID8/IFwiXCIpO1xuICBjb25zdCBuYW1lZCA9IENMQUlNX0hPU1RfUEFUVEVSTi5leGVjKGJvZHkpPy5bMV07XG4gIGlmIChuYW1lZCAhPT0gdW5kZWZpbmVkICYmIG5hbWVkLnRyaW0oKSAhPT0gXCJcIikgcmV0dXJuIG5hbWVkLnRyaW0oKTtcbiAgY29uc3QgbG9naW4gPSBjb21tZW50LmF1dGhvcj8ubG9naW47XG4gIHJldHVybiB0eXBlb2YgbG9naW4gPT09IFwic3RyaW5nXCIgJiYgbG9naW4udHJpbSgpICE9PSBcIlwiXG4gICAgPyBsb2dpbi50cmltKClcbiAgICA6IFVOS05PV05fSE9TVDtcbn1cblxuLyoqIFRoZSBsaXZlIGhlYXJ0YmVhdCBvbiBgY29tbWVudHNgLCBvciBudWxsIHdoZW4gbm9uZSBpcyBiZWF0aW5nLiAqL1xuZnVuY3Rpb24gbGl2ZUhlYXJ0YmVhdEhvc3QoXG4gIGNvbW1lbnRzOiBMaXN0ZWRDb21tZW50W10sXG4gIG5vd1NlY29uZHM6IG51bWJlcixcbik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBtYXJrZXJzID0gY29tbWVudHNcbiAgICAubWFwKChjb21tZW50KSA9PiBwYXJzZUhlYXJ0YmVhdE1hcmtlcihTdHJpbmcoY29tbWVudC5ib2R5KSkpXG4gICAgLmZpbHRlcigobWFya2VyKTogbWFya2VyIGlzIE5vbk51bGxhYmxlPHR5cGVvZiBtYXJrZXI+ID0+IG1hcmtlciAhPT0gbnVsbCk7XG4gIGNvbnN0IGxpdmUgPSBmaW5kTGl2ZUhlYXJ0YmVhdE1hcmtlcihtYXJrZXJzLCBub3dTZWNvbmRzKTtcbiAgcmV0dXJuIGxpdmUgPT09IG51bGwgPyBudWxsIDogaG9zdEZyb21NYWNoaW5lSWQobGl2ZS5tYWNoaW5lSWQpO1xufVxuXG4vKiogVGhlIGhvc3QgaG9sZGluZyBhIGBDTEFJTV9MT0NLYCBwb3N0ZWQgaW5zaWRlIHRoZSByZWNlbnQgd2luZG93LCBvciBudWxsLiAqL1xuZnVuY3Rpb24gZnJlc2hDbGFpbUhvc3QoXG4gIGNvbW1lbnRzOiBMaXN0ZWRDb21tZW50W10sXG4gIG5vd01zOiBudW1iZXIsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgZm9yIChjb25zdCBjb21tZW50IG9mIGNvbW1lbnRzKSB7XG4gICAgaWYgKCFTdHJpbmcoY29tbWVudC5ib2R5KS5pbmNsdWRlcyhDTEFJTV9NQVJLRVJfUFJFRklYKSkgY29udGludWU7XG4gICAgY29uc3QgY3JlYXRlZEF0ID0gdHlwZW9mIGNvbW1lbnQuY3JlYXRlZEF0ID09PSBcInN0cmluZ1wiXG4gICAgICA/IERhdGUucGFyc2UoY29tbWVudC5jcmVhdGVkQXQpXG4gICAgICA6IE51bWJlci5OYU47XG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoY3JlYXRlZEF0KSkgY29udGludWU7XG4gICAgY29uc3QgYWdlTXMgPSBub3dNcyAtIGNyZWF0ZWRBdDtcbiAgICBpZiAoYWdlTXMgPj0gMCAmJiBhZ2VNcyA8IFJFQ0VOVF9DTEFJTV9XSU5ET1dfTVMpIHJldHVybiBjbGFpbUhvc3QoY29tbWVudCk7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogSXMgYW5vdGhlciBvcGVuIGlzc3VlIG9mIHRoaXMgbWlsZXN0b25lIHN0cmVhbSBhbHJlYWR5IGJlaW5nIHJ1bj9cbiAqXG4gKiBSZXR1cm5zIGB7IGJ1c3k6IGZhbHNlIH1gIGZvciB0aGUgYmxhbmsgc3RyZWFtIHdpdGhvdXQgbWFraW5nIGFueSBBUEkgY2FsbCxcbiAqIGFuZCBmb3IgYSBtaWxlc3RvbmUgd2hvc2Ugb3RoZXIgb3BlbiBpc3N1ZXMgY2Fycnkgbm90aGluZyBsaXZlLiBBIGNsb3NlZFxuICogc2libGluZyBpcyBuZXZlciBsaXN0ZWQsIGEgc2libGluZyBpbiBhbm90aGVyIG1pbGVzdG9uZSBvciByZXBvc2l0b3J5IGlzXG4gKiBuZXZlciBsaXN0ZWQsIGFuZCB0aGUgaXNzdWUgYmVpbmcgY2xhaW1lZCBuZXZlciBibG9ja3MgaXRzZWxmLlxuICpcbiAqIE5ldmVyIHRocm93czogYSByZXBvc2l0b3J5IHRoYXQgaXMgbm90IGBvd25lci9uYW1lYCDigJQgd2hpY2hcbiAqIGByZXNvbHZlU3RyZWFtSWRgIHJlZnVzZXMgdG8gcmVzb2x2ZSDigJQgaXMgcmVwb3J0ZWQgYXMgYSBsb3VkIHdhcm5pbmcgYW5kIGFcbiAqIGZhaWwtb3BlbiwgYmVjYXVzZSBhIHN0cmVhbSBjaGVjayBtdXN0IG5ldmVyIHR1cm4gYSBjbGFpbSBpbnRvIGEgcnVuXG4gKiBmYWlsdXJlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2hlY2tNaWxlc3RvbmVTdHJlYW1CdXN5KFxuICBvcHRpb25zOiBTdHJlYW1Mb2NrT3B0aW9ucyxcbik6IFByb21pc2U8U3RyZWFtTG9ja1N0YXR1cz4ge1xuICBjb25zdCB7XG4gICAgcmVwbyxcbiAgICBtaWxlc3RvbmVUaXRsZSxcbiAgICBpc3N1ZU51bWJlcixcbiAgICBnaENvbW1hbmRGbixcbiAgICB0cnVzdGVkQXV0aG9ycyA9IFtdLFxuICAgIG5vd1NlY29uZHMgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSxcbiAgfSA9IG9wdGlvbnM7XG5cbiAgbGV0IHN0cmVhbTogU3RyZWFtSWQ7XG4gIHRyeSB7XG4gICAgc3RyZWFtID0gcmVzb2x2ZVN0cmVhbUlkKHJlcG8sIG1pbGVzdG9uZVRpdGxlKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gYHJlc29sdmVTdHJlYW1JZGAgZmFpbHMgbG91ZCBvbiBhIG1hbGZvcm1lZCByZXBvc2l0b3J5LCBhbmQgcmlnaHRseSDigJRcbiAgICAvLyBidXQgYSBjbGFpbSBtdXN0IG5vdCBmYWlsIHdpdGggaXQsIHNvIHRoZSByZWZ1c2FsIGlzIHJlcG9ydGVkIGFuZCB0aGVcbiAgICAvLyBjbGFpbSBwcm9jZWVkcyB1bmxvY2tlZC5cbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW3N0cmVhbV9sb2NrXSByZXBvPSR7cmVwb30gaXNzdWU9IyR7aXNzdWVOdW1iZXJ9IGAgK1xuICAgICAgICBgc3RyZWFtX3VucmVzb2x2ZWQgZXJyb3I9JHtcbiAgICAgICAgICBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICAgICAgfSDigJQgcHJvY2VlZGluZyB3aXRoIHRoZSBjbGFpbSAoSXNzdWUgIzIzMzQpYCxcbiAgICApO1xuICAgIHJldHVybiB7IGJ1c3k6IGZhbHNlIH07XG4gIH1cbiAgLy8gVGhlIGJsYW5rIHN0cmVhbSBob2xkcyBubyBzaGFyZWQgY29udmVyc2F0aW9uLCBzbyBub3RoaW5nIHRvIGxvY2suXG4gIC8vIFJlYWRpbmcgdGhlIHJlc29sdmVkIHRpdGxlIGJhY2sgaXMgd2hhdCBuYXJyb3dzIGl0IGZvciB0aGUgcXVlcnkgYmVsb3cg4oCUXG4gIC8vIGByZXNvbHZlU3RyZWFtSWRgIGxlYXZlcyBpdCB1bmRlZmluZWQgZm9yIGV4YWN0bHkgdGhpcyBjYXNlLlxuICBjb25zdCB0aXRsZSA9IHN0cmVhbS5taWxlc3RvbmVUaXRsZTtcbiAgaWYgKGlzQmxhbmtTdHJlYW0oc3RyZWFtKSB8fCB0aXRsZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBidXN5OiBmYWxzZSB9O1xuICBjb25zdCBsYWJlbCA9IHN0cmVhbUxhYmVsKHN0cmVhbSk7XG5cbiAgbGV0IGlzc3VlczogTGlzdGVkSXNzdWVbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCBqc29uID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJpc3N1ZVwiLFxuICAgICAgXCJsaXN0XCIsXG4gICAgICBcIi0tcmVwb1wiLFxuICAgICAgcmVwbyxcbiAgICAgIFwiLS1zdGF0ZVwiLFxuICAgICAgXCJvcGVuXCIsXG4gICAgICBcIi0tbWlsZXN0b25lXCIsXG4gICAgICB0aXRsZSxcbiAgICAgIFwiLS1saW1pdFwiLFxuICAgICAgU3RyaW5nKFNUUkVBTV9MT0NLX0lTU1VFX0xJTUlUKSxcbiAgICAgIFwiLS1qc29uXCIsXG4gICAgICBcIm51bWJlcixjb21tZW50c1wiLFxuICAgIF0pO1xuICAgIGNvbnN0IHBhcnNlZDogdW5rbm93biA9IEpTT04ucGFyc2UoanNvbiB8fCBcIltdXCIpO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGV4cGVjdGVkIGEgSlNPTiBhcnJheSwgZ290ICR7dHlwZW9mIHBhcnNlZH1gKTtcbiAgICB9XG4gICAgaXNzdWVzID0gcGFyc2VkIGFzIExpc3RlZElzc3VlW107XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIEZhaWwgb3BlbiwgbG91ZGx5OiBhbiB1bnJlYWNoYWJsZSBHaXRIdWIgbXVzdCBub3Qgc3RvcCB0aGUgZmxlZXRcbiAgICAvLyBjbGFpbWluZyB3b3JrLCBidXQgaXQgbXVzdCBuZXZlciBiZSBtaXN0YWtlbiBmb3IgXCJ0aGUgc3RyZWFtIGlzIGZyZWVcIi5cbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW3N0cmVhbV9sb2NrXSByZXBvPSR7cmVwb30gaXNzdWU9IyR7aXNzdWVOdW1iZXJ9IGAgK1xuICAgICAgICBgc3RyZWFtX2NoZWNrX2ZhaWxlZCBzdHJlYW09JHtsYWJlbH0gZXJyb3I9JHtcbiAgICAgICAgICBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICAgICAgfSDigJQgcHJvY2VlZGluZyB3aXRoIHRoZSBjbGFpbSAoSXNzdWUgIzIzMzQpYCxcbiAgICApO1xuICAgIHJldHVybiB7IGJ1c3k6IGZhbHNlIH07XG4gIH1cblxuICAvLyBBIGxpc3RpbmcgdGhhdCBmaWxsZWQgdGhlIHBhZ2UgbWF5IGhhdmUgbGVmdCBsaXZlIHNpYmxpbmdzIHVucmVhZCwgYW5kXG4gIC8vIFwidW5yZWFkXCIgbXVzdCBuZXZlciByZWFkIGFzIFwidGhlIHN0cmVhbSBpcyBmcmVlXCIg4oCUIHNheSBzby5cbiAgaWYgKGlzc3Vlcy5sZW5ndGggPj0gU1RSRUFNX0xPQ0tfSVNTVUVfTElNSVQpIHtcbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW3N0cmVhbV9sb2NrXSByZXBvPSR7cmVwb30gaXNzdWU9IyR7aXNzdWVOdW1iZXJ9IGAgK1xuICAgICAgICBgc3RyZWFtX2xpc3RpbmdfdHJ1bmNhdGVkIHN0cmVhbT0ke2xhYmVsfSBgICtcbiAgICAgICAgYGxpbWl0PSR7U1RSRUFNX0xPQ0tfSVNTVUVfTElNSVR9IOKAlCBvcGVuIGlzc3VlcyBiZXlvbmQgdGhlIGxpbWl0IGAgK1xuICAgICAgICBgd2VyZSBub3QgcmVhZCwgc28gYSBsaXZlIHNpYmxpbmcgYW1vbmcgdGhlbSBjYW5ub3QgaG9sZCB0aGUgYCArXG4gICAgICAgIGBzdHJlYW0gKElzc3VlICMyMzM0KWAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IG5vd01zID0gbm93U2Vjb25kcyAqIDEwMDA7XG4gIGZvciAoY29uc3QgaXNzdWUgb2YgaXNzdWVzKSB7XG4gICAgaWYgKHR5cGVvZiBpc3N1ZT8ubnVtYmVyICE9PSBcIm51bWJlclwiKSBjb250aW51ZTtcbiAgICBpZiAoaXNzdWUubnVtYmVyID09PSBpc3N1ZU51bWJlcikgY29udGludWU7XG4gICAgY29uc3QgY29tbWVudHMgPSBmbGVldENvbW1lbnRzKGlzc3VlLCB0cnVzdGVkQXV0aG9ycyk7XG4gICAgaWYgKGNvbW1lbnRzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgLy8gZ2ggcmV0dXJucyBvbmUgcGFnZSBvZiBjb21tZW50cyBwZXIgaXNzdWUsIHNvIGEgbG9uZ2VyIHRocmVhZCBoaWRlc1xuICAgIC8vIGl0cyBuZXdlc3QgbWFya2VycyDigJQgdW5yZWFkLCBub3QgYWJzZW50LlxuICAgIGlmIChcbiAgICAgIEFycmF5LmlzQXJyYXkoaXNzdWUuY29tbWVudHMpICYmXG4gICAgICBpc3N1ZS5jb21tZW50cy5sZW5ndGggPj0gQ09NTUVOVF9QQUdFX1NJWkVcbiAgICApIHtcbiAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgYFtzdHJlYW1fbG9ja10gcmVwbz0ke3JlcG99IGlzc3VlPSMke2lzc3VlTnVtYmVyfSBgICtcbiAgICAgICAgICBgc2libGluZ19jb21tZW50c190cnVuY2F0ZWQgc2libGluZz0jJHtpc3N1ZS5udW1iZXJ9IGAgK1xuICAgICAgICAgIGBwYWdlPSR7Q09NTUVOVF9QQUdFX1NJWkV9IOKAlCBtYXJrZXJzIHBhc3QgdGhlIGZpcnN0IHBhZ2Ugd2VyZSBub3QgYCArXG4gICAgICAgICAgYHJlYWQgKElzc3VlICMyMzM0KWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGJlYXRpbmcgPSBsaXZlSGVhcnRiZWF0SG9zdChjb21tZW50cywgbm93U2Vjb25kcyk7XG4gICAgaWYgKGJlYXRpbmcgIT09IG51bGwpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGJ1c3k6IHRydWUsXG4gICAgICAgIGhvbGRlcklzc3VlOiBpc3N1ZS5udW1iZXIsXG4gICAgICAgIGhvbGRlckhvc3Q6IGJlYXRpbmcsXG4gICAgICAgIHN0cmVhbUxhYmVsOiBsYWJlbCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3QgY2xhaW1pbmcgPSBmcmVzaENsYWltSG9zdChjb21tZW50cywgbm93TXMpO1xuICAgIGlmIChjbGFpbWluZyAhPT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYnVzeTogdHJ1ZSxcbiAgICAgICAgaG9sZGVySXNzdWU6IGlzc3VlLm51bWJlcixcbiAgICAgICAgaG9sZGVySG9zdDogY2xhaW1pbmcsXG4gICAgICAgIHN0cmVhbUxhYmVsOiBsYWJlbCxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgYnVzeTogZmFsc2UgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBIb3N0LWxvY2FsIGJsYW5rLXN0cmVhbSBsb2NrIChJc3N1ZSAjMjMzNSlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogQSBzbG90J3MgaG9zdC1sb2NhbCBob2xkIG9uIG9uZSByZXBvc2l0b3J5J3MgYmxhbmsgc3RyZWFtLiAqL1xuZXhwb3J0IGludGVyZmFjZSBCbGFua1N0cmVhbUhvbGQge1xuICAvKiogVGhlIGNvbnZlcnNhdGlvbidzIGtleSDigJQge0BsaW5rIHN0cmVhbUtleX0gb2YgdGhlIGJsYW5rIHN0cmVhbS4gKi9cbiAgc3RyZWFtS2V5OiBzdHJpbmc7XG4gIC8qKiBgb3duZXIvbmFtZWAgd2hvc2UgYmxhbmsgc3RyZWFtIGlzIGhlbGQgKElzc3VlICMyODAwKS4gKi9cbiAgcmVwbzogc3RyaW5nO1xuICAvKiogSHVtYW4gbGFiZWwgb2YgdGhlIHN0cmVhbSwgYXMge0BsaW5rIHN0cmVhbUxhYmVsfSByZW5kZXJzIGl0LiAqL1xuICBzdHJlYW1MYWJlbDogc3RyaW5nO1xuICAvKiogU2xvdCBob2xkaW5nIGl0LCBmb3IgbG9nIGF0dHJpYnV0aW9uIOKAlCBgczBgLCBgczFgLCDigKYgKi9cbiAgc2xvdElkOiBzdHJpbmc7XG4gIC8qKiBUaGUgaXNzdWUgdGhlIGhvbGRpbmcgc2xvdCBpcyBydW5uaW5nLiAqL1xuICBpc3N1ZU51bWJlcjogbnVtYmVyO1xuICAvKiogRXBvY2gtbXMgdGhlIGhvbGQgd2FzIHRha2VuLiAqL1xuICBzaW5jZU1zOiBudW1iZXI7XG59XG5cbi8qKlxuICogT3V0Y29tZSBvZiBhc2tpbmcgZm9yIGEgYmxhbmsgc3RyZWFtLlxuICpcbiAqIGBhY3F1aXJlZDogdHJ1ZSwgbG9ja2VkOiBmYWxzZWAgaXMgdGhlIG1pbGVzdG9uZSBjYXNlIGFuZCB0aGUgZmFpbC1vcGVuXG4gKiBjYXNlOiB0aGUgY2FsbGVyIG1heSBwcm9jZWVkIGFuZCBob2xkcyBub3RoaW5nLCBzbyBpdHMgcmVsZWFzZSBpcyBhIG5vLW9wLlxuICovXG5leHBvcnQgdHlwZSBCbGFua1N0cmVhbUxvY2tSZXN1bHQgPVxuICB8IHsgYWNxdWlyZWQ6IHRydWU7IGxvY2tlZDogYm9vbGVhbiB9XG4gIHwgeyBhY3F1aXJlZDogZmFsc2U7IGhvbGRlcjogQmxhbmtTdHJlYW1Ib2xkIH07XG5cbi8qKiBXaGljaCBzdHJlYW0gYSBsb2NrIGNhbGwgaXMgYWJvdXQuICovXG5leHBvcnQgaW50ZXJmYWNlIEJsYW5rU3RyZWFtUmVmIHtcbiAgLyoqIGBvd25lci9uYW1lYCB0aGUgaXNzdWUgbGl2ZXMgaW4uICovXG4gIHJlcG86IHN0cmluZztcbiAgLyoqIFRoZSBpc3N1ZSdzIG1pbGVzdG9uZSB0aXRsZTsgYWJzZW50IG9yIGJsYW5rIG1lYW5zIHRoZSBibGFuayBzdHJlYW0uICovXG4gIG1pbGVzdG9uZVRpdGxlPzogc3RyaW5nO1xufVxuXG4vKiogRXZlcnl0aGluZyB7QGxpbmsgQmxhbmtTdHJlYW1Mb2NrUmVnaXN0cnkudHJ5QWNxdWlyZX0gbmVlZHMuICovXG5leHBvcnQgaW50ZXJmYWNlIEJsYW5rU3RyZWFtQWNxdWlyZU9wdGlvbnMgZXh0ZW5kcyBCbGFua1N0cmVhbVJlZiB7XG4gIC8qKiBUaGUgaXNzdWUgYmVpbmcgY2xhaW1lZC4gKi9cbiAgaXNzdWVOdW1iZXI6IG51bWJlcjtcbiAgLyoqIFN0YWJsZSBzbG90IGlkLCBmb3IgbG9nIGF0dHJpYnV0aW9uLiAqL1xuICBzbG90SWQ6IHN0cmluZztcbn1cblxuLyoqXG4gKiBUaGUgYmxhbmsgc3RyZWFtIG9mIGByZWZgLCBvciBgdW5kZWZpbmVkYCB3aGVuIGl0IGlzIGEgbWlsZXN0b25lIHN0cmVhbSBvclxuICogYW4gdW5yZXNvbHZhYmxlIHJlcG9zaXRvcnkuXG4gKlxuICogRmFpbHMgb3BlbiwgbG91ZGx5OiBgcmVzb2x2ZVN0cmVhbUlkYCB0aHJvd3Mgb24gYSByZXBvc2l0b3J5IHRoYXQgaXMgbm90XG4gKiBgb3duZXIvbmFtZWAsIGFuZCBhIGxvY2sgbXVzdCBuZXZlciB0dXJuIGEgY2xhaW0gaW50byBhIHJ1biBmYWlsdXJlIOKAlCBidXRcbiAqIHRoZSByZWZ1c2FsIGlzIHJlcG9ydGVkLCBuZXZlciBzd2FsbG93ZWQuXG4gKi9cbmZ1bmN0aW9uIGJsYW5rU3RyZWFtT2YocmVmOiBCbGFua1N0cmVhbVJlZik6IFN0cmVhbUlkIHwgdW5kZWZpbmVkIHtcbiAgbGV0IHN0cmVhbTogU3RyZWFtSWQ7XG4gIHRyeSB7XG4gICAgc3RyZWFtID0gcmVzb2x2ZVN0cmVhbUlkKHJlZi5yZXBvLCByZWYubWlsZXN0b25lVGl0bGUpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW3N0cmVhbV9sb2NrXSByZXBvPSR7cmVmLnJlcG99IHN0cmVhbV91bnJlc29sdmVkIGVycm9yPSR7XG4gICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgfSDigJQgbm8gaG9zdC1sb2NhbCBibGFuay1zdHJlYW0gbG9jayBpcyB0YWtlbiAoSXNzdWUgIzIzMzUpYCxcbiAgICApO1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIGlzQmxhbmtTdHJlYW0oc3RyZWFtKSA/IHN0cmVhbSA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBUaGUgbGluZSBhIGJsYW5rLXN0cmVhbSByZWZ1c2FsIGxvZ3MuXG4gKlxuICogRXhwb3J0ZWQgc28gdGhlIHNsb3QgcG9vbCwgdGhlIHRlc3RzIGFuZCBhIGxvZyBncmVwIHNoYXJlIG9uZSB3b3JkaW5nLiBUaGVcbiAqIGBzdHJlYW0gYnVzeTpgIHN0ZW0gbWF0Y2hlcyB7QGxpbmsgZm9ybWF0U3RyZWFtQnVzeX0gb24gcHVycG9zZSDigJQgb25lIGdyZXBcbiAqIGZpbmRzIGJvdGggbG9ja3MnIHJlZnVzYWxzIOKAlCB3aGlsZSB0aGUgdGFpbCBuYW1lcyBhIHNsb3QgcmF0aGVyIHRoYW4gYSBob3N0LFxuICogYmVjYXVzZSB0aGF0IGlzIHdoYXQgYSBob3N0LWxvY2FsIGxvY2sgY2FuIHRlbGwgeW91LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0QmxhbmtTdHJlYW1CdXN5KGhvbGQ6IEJsYW5rU3RyZWFtSG9sZCk6IHN0cmluZyB7XG4gIHJldHVybiBgc3RyZWFtIGJ1c3k6ICR7aG9sZC5zdHJlYW1MYWJlbH0gaGVsZCBieSBzbG90ICR7aG9sZC5zbG90SWR9IGAgK1xuICAgIGBvbiAjJHtob2xkLmlzc3VlTnVtYmVyfWA7XG59XG5cbi8qKlxuICogSW4tcHJvY2VzcyByZWdpc3RyeSBvZiB0aGUgYmxhbmsgc3RyZWFtcyB0aGlzIGhvc3QncyBzbG90cyBob2xkLlxuICpcbiAqIE9uZSBob2xkIHBlciByZXBvc2l0b3J5J3MgYmxhbmsgc3RyZWFtOiB0aGUgc2xvdCB0aGF0IHRha2VzIGl0IHJ1bnMgdGhhdFxuICogcmVwb3NpdG9yeSdzIG5vbi1taWxlc3RvbmUgaXNzdWUsIGFuZCBhIHNpYmxpbmcgc2xvdCBmaW5kaW5nIHRoZSBzdHJlYW0gaGVsZFxuICogaXMgcmVmdXNlZCBhbmQgbG9va3MgZm9yIG90aGVyIHdvcmsuIERlbGliZXJhdGVseSBob3N0LWxvY2FsIOKAlCBpdCBjb25zdWx0c1xuICogbm8gR2l0SHViIHN0YXRlLCBzbyBhbm90aGVyIGhvc3QgaG9sZHMgdGhlIHNhbWUgcmVwb3NpdG9yeSdzIGJsYW5rIHN0cmVhbSBpblxuICogcGFyYWxsZWwgd2l0aCBpdHMgb3duIGNvbnZlcnNhdGlvbi5cbiAqXG4gKiBBY3F1aXNpdGlvbiBpcyBhdG9taWMgYWdhaW5zdCBjb25jdXJyZW50IHNsb3Qgc3RhcnRzIGJ5IGNvbnN0cnVjdGlvbjogRGVub1xuICogaXMgc2luZ2xlLXRocmVhZGVkIGFuZCB7QGxpbmsgdHJ5QWNxdWlyZX0gaXMgc3luY2hyb25vdXMsIHNvIHR3byBzbG90c1xuICogcmFjaW5nIG9uIG9uZSBzdHJlYW0gaW50ZXJsZWF2ZSBhdCBhd2FpdCBwb2ludHMsIG5ldmVyIGluc2lkZSB0aGVcbiAqIGNoZWNrLWFuZC1zZXQuIEV2ZXJ5IHRlcm1pbmFsIGV4aXQg4oCUIHN1Y2Nlc3MsIHNraXAsIGZhaWx1cmUsIHRocm93LCB0aW1lb3V0LFxuICoga2lsbCDigJQgbXVzdCB7QGxpbmsgcmVsZWFzZX07IHRoZSBjYWxsZXIgaG9sZHMgdGhhdCBpbiBhIGBmaW5hbGx5YC5cbiAqL1xuZXhwb3J0IGNsYXNzIEJsYW5rU3RyZWFtTG9ja1JlZ2lzdHJ5IHtcbiAgcmVhZG9ubHkgI2hlbGQgPSBuZXcgTWFwPHN0cmluZywgQmxhbmtTdHJlYW1Ib2xkPigpO1xuICByZWFkb25seSAjbm93OiAoKSA9PiBudW1iZXI7XG5cbiAgY29uc3RydWN0b3Iobm93OiAoKSA9PiBudW1iZXIgPSBEYXRlLm5vdykge1xuICAgIHRoaXMuI25vdyA9IG5vdztcbiAgfVxuXG4gIC8qKlxuICAgKiBUcnkgdG8gdGFrZSBhIHJlcG9zaXRvcnkncyBibGFuayBzdHJlYW0gZm9yIGEgc2xvdC5cbiAgICpcbiAgICogQSBtaWxlc3RvbmUgaXNzdWUgdGFrZXMgbm90aGluZyBhbmQgYWx3YXlzIHdpbnM6IHRoZSBmbGVldC13aWRlIGxvY2sgb2ZcbiAgICogSXNzdWUgIzIzMzQgaXMgd2hhdCBnYXRlcyBpdCwgYW5kIHRoZSB0d28gbmV2ZXIgYm90aCBhcHBseS5cbiAgICpcbiAgICogQHBhcmFtIG9wdGlvbnMgLSBUaGUgaXNzdWUgYmVpbmcgY2xhaW1lZCBhbmQgdGhlIHNsb3QgY2xhaW1pbmcgaXRcbiAgICogQHJldHVybnMgV2hldGhlciB0aGUgY2FsbGVyIG1heSBwcm9jZWVkLCBhbmQgd2hvIGhvbGRzIGl0IGlmIG5vdFxuICAgKi9cbiAgdHJ5QWNxdWlyZShvcHRpb25zOiBCbGFua1N0cmVhbUFjcXVpcmVPcHRpb25zKTogQmxhbmtTdHJlYW1Mb2NrUmVzdWx0IHtcbiAgICBjb25zdCBzdHJlYW0gPSBibGFua1N0cmVhbU9mKG9wdGlvbnMpO1xuICAgIGlmIChzdHJlYW0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgYWNxdWlyZWQ6IHRydWUsIGxvY2tlZDogZmFsc2UgfTtcbiAgICBjb25zdCBrZXkgPSBzdHJlYW1LZXkoc3RyZWFtKTtcbiAgICBjb25zdCBob2xkZXIgPSB0aGlzLiNoZWxkLmdldChrZXkpO1xuICAgIGlmIChob2xkZXIgIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgYWNxdWlyZWQ6IGZhbHNlLCBob2xkZXIgfTtcbiAgICB0aGlzLiNoZWxkLnNldChrZXksIHtcbiAgICAgIHN0cmVhbUtleToga2V5LFxuICAgICAgcmVwbzogc3RyZWFtLnJlcG8sXG4gICAgICBzdHJlYW1MYWJlbDogc3RyZWFtTGFiZWwoc3RyZWFtKSxcbiAgICAgIHNsb3RJZDogb3B0aW9ucy5zbG90SWQsXG4gICAgICBpc3N1ZU51bWJlcjogb3B0aW9ucy5pc3N1ZU51bWJlcixcbiAgICAgIHNpbmNlTXM6IHRoaXMuI25vdygpLFxuICAgIH0pO1xuICAgIHJldHVybiB7IGFjcXVpcmVkOiB0cnVlLCBsb2NrZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWxlYXNlIGEgc2xvdCdzIGhvbGQgb24gYSByZXBvc2l0b3J5J3MgYmxhbmsgc3RyZWFtLlxuICAgKlxuICAgKiBJZGVtcG90ZW50LCBhbmQgYSBuby1vcCBmb3IgYSBtaWxlc3RvbmUgaXNzdWUgb3IgYW4gdW5yZXNvbHZhYmxlXG4gICAqIHJlcG9zaXRvcnkg4oCUIHNvIHRoZSBydW4tZW5kIGBmaW5hbGx5YCBpcyBzYWZlIHRvIGNhbGwgb24gZXZlcnkgcGF0aC5cbiAgICovXG4gIHJlbGVhc2UocmVmOiBCbGFua1N0cmVhbVJlZik6IHZvaWQge1xuICAgIGNvbnN0IHN0cmVhbSA9IGJsYW5rU3RyZWFtT2YocmVmKTtcbiAgICBpZiAoc3RyZWFtID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgICB0aGlzLiNoZWxkLmRlbGV0ZShzdHJlYW1LZXkoc3RyZWFtKSk7XG4gIH1cblxuICAvKiogVGhlIGhvbGQgb24gdGhpcyByZXBvc2l0b3J5J3MgYmxhbmsgc3RyZWFtLCBvciBgdW5kZWZpbmVkYCB3aGVuIGZyZWUuICovXG4gIGhvbGRlcihyZWY6IEJsYW5rU3RyZWFtUmVmKTogQmxhbmtTdHJlYW1Ib2xkIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBzdHJlYW0gPSBibGFua1N0cmVhbU9mKHJlZik7XG4gICAgcmV0dXJuIHN0cmVhbSA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogdGhpcy4jaGVsZC5nZXQoc3RyZWFtS2V5KHN0cmVhbSkpO1xuICB9XG5cbiAgLyoqXG4gICAqIGBvd25lci9uYW1lYCBvZiBldmVyeSByZXBvc2l0b3J5IHdob3NlIGJsYW5rIHN0cmVhbSBhIHNsb3QgaG9sZHMsIHNvIHRoZVxuICAgKiBpZGxlLWRlY2lzaW9uIGNlbnN1cyBjYW4gY291bnQgdGhlaXIgbm9uLW1pbGVzdG9uZSBpc3N1ZXMgYXNcbiAgICogc3RyZWFtLW9jY3VwaWVkIHJhdGhlciB0aGFuIGNsYWltYWJsZSAoSXNzdWUgIzI4MDApLlxuICAgKi9cbiAgaGVsZFJlcG9zKCk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMuI2hlbGQudmFsdWVzKCldLm1hcCgoaG9sZCkgPT4gaG9sZC5yZXBvKTtcbiAgfVxuXG4gIC8qKiBOdW1iZXIgb2YgYmxhbmsgc3RyZWFtcyBoZWxkLiAqL1xuICBnZXQgc2l6ZSgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLiNoZWxkLnNpemU7XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E2RUMsR0FFRCxTQUNFLG1CQUFtQixFQUNuQix1QkFBdUIsRUFDdkIsc0JBQXNCLFFBQ2pCLG1CQUFtQjtBQUMxQixTQUFTLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FDRSxpQkFBaUIsRUFDakIsb0JBQW9CLFFBQ2YseUJBQXlCO0FBQ2hDLFNBQ0UsYUFBYSxFQUNiLGVBQWUsRUFFZixTQUFTLEVBQ1QsV0FBVyxRQUNOLHVCQUF1QjtBQUU5Qjs7Ozs7O0NBTUMsR0FDRCxPQUFPLE1BQU0sMEJBQTBCLElBQUk7QUFFM0M7Ozs7O0NBS0MsR0FDRCxNQUFNLG9CQUFvQjtBQWtEMUIsa0ZBQWtGLEdBQ2xGLE1BQU0scUJBQXFCO0FBRTNCLHFFQUFxRSxHQUNyRSxNQUFNLGVBQWU7QUFFckI7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsaUJBQWlCLE1BQWtCO0VBQ2pELE9BQU8sQ0FBQyxhQUFhLEVBQUUsT0FBTyxXQUFXLENBQUMsVUFBVSxFQUFFLE9BQU8sV0FBVyxDQUFDLENBQUMsQ0FBQyxHQUN6RSxDQUFDLEdBQUcsRUFBRSxPQUFPLFVBQVUsRUFBRTtBQUM3QjtBQUVBLCtFQUErRSxHQUMvRSxTQUFTLGNBQ1AsS0FBa0IsRUFDbEIsY0FBd0I7RUFFeEIsSUFBSSxDQUFDLE1BQU0sT0FBTyxDQUFDLE1BQU0sUUFBUSxHQUFHLE9BQU8sRUFBRTtFQUM3QyxNQUFNLGlCQUFpQixlQUFlLE1BQU0sR0FBRztFQUMvQyxPQUFPLEFBQUMsTUFBTSxRQUFRLENBQXFCLE1BQU0sQ0FBQyxDQUFDO0lBQ2pELElBQUksQ0FBQyxXQUFXLE9BQU8sUUFBUSxJQUFJLEtBQUssVUFBVSxPQUFPO0lBQ3pELElBQUksQ0FBQyxnQkFBZ0IsT0FBTztJQUM1QixNQUFNLFFBQVEsUUFBUSxNQUFNLEVBQUU7SUFDOUIsT0FBTyxjQUNMLE9BQU8sVUFBVSxXQUFXLFFBQVEsV0FDcEM7RUFFSjtBQUNGO0FBRUEsZ0VBQWdFLEdBQ2hFLFNBQVMsVUFBVSxPQUFzQjtFQUN2QyxNQUFNLE9BQU8sT0FBTyxRQUFRLElBQUksSUFBSTtFQUNwQyxNQUFNLFFBQVEsbUJBQW1CLElBQUksQ0FBQyxPQUFPLENBQUMsRUFBRTtFQUNoRCxJQUFJLFVBQVUsYUFBYSxNQUFNLElBQUksT0FBTyxJQUFJLE9BQU8sTUFBTSxJQUFJO0VBQ2pFLE1BQU0sUUFBUSxRQUFRLE1BQU0sRUFBRTtFQUM5QixPQUFPLE9BQU8sVUFBVSxZQUFZLE1BQU0sSUFBSSxPQUFPLEtBQ2pELE1BQU0sSUFBSSxLQUNWO0FBQ047QUFFQSxvRUFBb0UsR0FDcEUsU0FBUyxrQkFDUCxRQUF5QixFQUN6QixVQUFrQjtFQUVsQixNQUFNLFVBQVUsU0FDYixHQUFHLENBQUMsQ0FBQyxVQUFZLHFCQUFxQixPQUFPLFFBQVEsSUFBSSxJQUN6RCxNQUFNLENBQUMsQ0FBQyxTQUFpRCxXQUFXO0VBQ3ZFLE1BQU0sT0FBTyx3QkFBd0IsU0FBUztFQUM5QyxPQUFPLFNBQVMsT0FBTyxPQUFPLGtCQUFrQixLQUFLLFNBQVM7QUFDaEU7QUFFQSw4RUFBOEUsR0FDOUUsU0FBUyxlQUNQLFFBQXlCLEVBQ3pCLEtBQWE7RUFFYixLQUFLLE1BQU0sV0FBVyxTQUFVO0lBQzlCLElBQUksQ0FBQyxPQUFPLFFBQVEsSUFBSSxFQUFFLFFBQVEsQ0FBQyxzQkFBc0I7SUFDekQsTUFBTSxZQUFZLE9BQU8sUUFBUSxTQUFTLEtBQUssV0FDM0MsS0FBSyxLQUFLLENBQUMsUUFBUSxTQUFTLElBQzVCLE9BQU8sR0FBRztJQUNkLElBQUksQ0FBQyxPQUFPLFFBQVEsQ0FBQyxZQUFZO0lBQ2pDLE1BQU0sUUFBUSxRQUFRO0lBQ3RCLElBQUksU0FBUyxLQUFLLFFBQVEsd0JBQXdCLE9BQU8sVUFBVTtFQUNyRTtFQUNBLE9BQU87QUFDVDtBQUVBOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELE9BQU8sZUFBZSx5QkFDcEIsT0FBMEI7RUFFMUIsTUFBTSxFQUNKLElBQUksRUFDSixjQUFjLEVBQ2QsV0FBVyxFQUNYLFdBQVcsRUFDWCxpQkFBaUIsRUFBRSxFQUNuQixhQUFhLEtBQUssS0FBSyxDQUFDLEtBQUssR0FBRyxLQUFLLEtBQUssRUFDM0MsR0FBRztFQUVKLElBQUk7RUFDSixJQUFJO0lBQ0YsU0FBUyxnQkFBZ0IsTUFBTTtFQUNqQyxFQUFFLE9BQU8sS0FBSztJQUNaLHdFQUF3RTtJQUN4RSx3RUFBd0U7SUFDeEUsMkJBQTJCO0lBQzNCLFFBQVEsSUFBSSxDQUNWLENBQUMsbUJBQW1CLEVBQUUsS0FBSyxRQUFRLEVBQUUsWUFBWSxDQUFDLENBQUMsR0FDakQsQ0FBQyx3QkFBd0IsRUFDdkIsZUFBZSxRQUFRLElBQUksT0FBTyxHQUFHLE9BQU8sS0FDN0MsMENBQTBDLENBQUM7SUFFaEQsT0FBTztNQUFFLE1BQU07SUFBTTtFQUN2QjtFQUNBLHFFQUFxRTtFQUNyRSwyRUFBMkU7RUFDM0UsK0RBQStEO0VBQy9ELE1BQU0sUUFBUSxPQUFPLGNBQWM7RUFDbkMsSUFBSSxjQUFjLFdBQVcsVUFBVSxXQUFXLE9BQU87SUFBRSxNQUFNO0VBQU07RUFDdkUsTUFBTSxRQUFRLFlBQVk7RUFFMUIsSUFBSTtFQUNKLElBQUk7SUFDRixNQUFNLE9BQU8sTUFBTSxZQUFZO01BQzdCO01BQ0E7TUFDQTtNQUNBO01BQ0E7TUFDQTtNQUNBO01BQ0E7TUFDQTtNQUNBLE9BQU87TUFDUDtNQUNBO0tBQ0Q7SUFDRCxNQUFNLFNBQWtCLEtBQUssS0FBSyxDQUFDLFFBQVE7SUFDM0MsSUFBSSxDQUFDLE1BQU0sT0FBTyxDQUFDLFNBQVM7TUFDMUIsTUFBTSxJQUFJLE1BQU0sQ0FBQywyQkFBMkIsRUFBRSxPQUFPLFFBQVE7SUFDL0Q7SUFDQSxTQUFTO0VBQ1gsRUFBRSxPQUFPLEtBQUs7SUFDWixtRUFBbUU7SUFDbkUseUVBQXlFO0lBQ3pFLFFBQVEsSUFBSSxDQUNWLENBQUMsbUJBQW1CLEVBQUUsS0FBSyxRQUFRLEVBQUUsWUFBWSxDQUFDLENBQUMsR0FDakQsQ0FBQywyQkFBMkIsRUFBRSxNQUFNLE9BQU8sRUFDekMsZUFBZSxRQUFRLElBQUksT0FBTyxHQUFHLE9BQU8sS0FDN0MsMENBQTBDLENBQUM7SUFFaEQsT0FBTztNQUFFLE1BQU07SUFBTTtFQUN2QjtFQUVBLHlFQUF5RTtFQUN6RSw2REFBNkQ7RUFDN0QsSUFBSSxPQUFPLE1BQU0sSUFBSSx5QkFBeUI7SUFDNUMsUUFBUSxJQUFJLENBQ1YsQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLFFBQVEsRUFBRSxZQUFZLENBQUMsQ0FBQyxHQUNqRCxDQUFDLGdDQUFnQyxFQUFFLE1BQU0sQ0FBQyxDQUFDLEdBQzNDLENBQUMsTUFBTSxFQUFFLHdCQUF3QixnQ0FBZ0MsQ0FBQyxHQUNsRSxDQUFDLDREQUE0RCxDQUFDLEdBQzlELENBQUMsb0JBQW9CLENBQUM7RUFFNUI7RUFFQSxNQUFNLFFBQVEsYUFBYTtFQUMzQixLQUFLLE1BQU0sU0FBUyxPQUFRO0lBQzFCLElBQUksT0FBTyxPQUFPLFdBQVcsVUFBVTtJQUN2QyxJQUFJLE1BQU0sTUFBTSxLQUFLLGFBQWE7SUFDbEMsTUFBTSxXQUFXLGNBQWMsT0FBTztJQUN0QyxJQUFJLFNBQVMsTUFBTSxLQUFLLEdBQUc7SUFDM0Isc0VBQXNFO0lBQ3RFLDJDQUEyQztJQUMzQyxJQUNFLE1BQU0sT0FBTyxDQUFDLE1BQU0sUUFBUSxLQUM1QixNQUFNLFFBQVEsQ0FBQyxNQUFNLElBQUksbUJBQ3pCO01BQ0EsUUFBUSxJQUFJLENBQ1YsQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLFFBQVEsRUFBRSxZQUFZLENBQUMsQ0FBQyxHQUNqRCxDQUFDLG9DQUFvQyxFQUFFLE1BQU0sTUFBTSxDQUFDLENBQUMsQ0FBQyxHQUN0RCxDQUFDLEtBQUssRUFBRSxrQkFBa0Isd0NBQXdDLENBQUMsR0FDbkUsQ0FBQyxrQkFBa0IsQ0FBQztJQUUxQjtJQUVBLE1BQU0sVUFBVSxrQkFBa0IsVUFBVTtJQUM1QyxJQUFJLFlBQVksTUFBTTtNQUNwQixPQUFPO1FBQ0wsTUFBTTtRQUNOLGFBQWEsTUFBTSxNQUFNO1FBQ3pCLFlBQVk7UUFDWixhQUFhO01BQ2Y7SUFDRjtJQUVBLE1BQU0sV0FBVyxlQUFlLFVBQVU7SUFDMUMsSUFBSSxhQUFhLE1BQU07TUFDckIsT0FBTztRQUNMLE1BQU07UUFDTixhQUFhLE1BQU0sTUFBTTtRQUN6QixZQUFZO1FBQ1osYUFBYTtNQUNmO0lBQ0Y7RUFDRjtFQUVBLE9BQU87SUFBRSxNQUFNO0VBQU07QUFDdkI7QUFnREE7Ozs7Ozs7Q0FPQyxHQUNELFNBQVMsY0FBYyxHQUFtQjtFQUN4QyxJQUFJO0VBQ0osSUFBSTtJQUNGLFNBQVMsZ0JBQWdCLElBQUksSUFBSSxFQUFFLElBQUksY0FBYztFQUN2RCxFQUFFLE9BQU8sS0FBSztJQUNaLFFBQVEsSUFBSSxDQUNWLENBQUMsbUJBQW1CLEVBQUUsSUFBSSxJQUFJLENBQUMseUJBQXlCLEVBQ3RELGVBQWUsUUFBUSxJQUFJLE9BQU8sR0FBRyxPQUFPLEtBQzdDLHlEQUF5RCxDQUFDO0lBRTdELE9BQU87RUFDVDtFQUNBLE9BQU8sY0FBYyxVQUFVLFNBQVM7QUFDMUM7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxTQUFTLHNCQUFzQixJQUFxQjtFQUN6RCxPQUFPLENBQUMsYUFBYSxFQUFFLEtBQUssV0FBVyxDQUFDLGNBQWMsRUFBRSxLQUFLLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FDcEUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxXQUFXLEVBQUU7QUFDN0I7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sTUFBTTtFQUNGLENBQUEsSUFBSyxHQUFHLElBQUksTUFBK0I7RUFDM0MsQ0FBQSxHQUFJLENBQWU7RUFFNUIsWUFBWSxNQUFvQixLQUFLLEdBQUcsQ0FBRTtJQUN4QyxJQUFJLENBQUMsQ0FBQSxHQUFJLEdBQUc7RUFDZDtFQUVBOzs7Ozs7OztHQVFDLEdBQ0QsV0FBVyxPQUFrQyxFQUF5QjtJQUNwRSxNQUFNLFNBQVMsY0FBYztJQUM3QixJQUFJLFdBQVcsV0FBVyxPQUFPO01BQUUsVUFBVTtNQUFNLFFBQVE7SUFBTTtJQUNqRSxNQUFNLE1BQU0sVUFBVTtJQUN0QixNQUFNLFNBQVMsSUFBSSxDQUFDLENBQUEsSUFBSyxDQUFDLEdBQUcsQ0FBQztJQUM5QixJQUFJLFdBQVcsV0FBVyxPQUFPO01BQUUsVUFBVTtNQUFPO0lBQU87SUFDM0QsSUFBSSxDQUFDLENBQUEsSUFBSyxDQUFDLEdBQUcsQ0FBQyxLQUFLO01BQ2xCLFdBQVc7TUFDWCxNQUFNLE9BQU8sSUFBSTtNQUNqQixhQUFhLFlBQVk7TUFDekIsUUFBUSxRQUFRLE1BQU07TUFDdEIsYUFBYSxRQUFRLFdBQVc7TUFDaEMsU0FBUyxJQUFJLENBQUMsQ0FBQSxHQUFJO0lBQ3BCO0lBQ0EsT0FBTztNQUFFLFVBQVU7TUFBTSxRQUFRO0lBQUs7RUFDeEM7RUFFQTs7Ozs7R0FLQyxHQUNELFFBQVEsR0FBbUIsRUFBUTtJQUNqQyxNQUFNLFNBQVMsY0FBYztJQUM3QixJQUFJLFdBQVcsV0FBVztJQUMxQixJQUFJLENBQUMsQ0FBQSxJQUFLLENBQUMsTUFBTSxDQUFDLFVBQVU7RUFDOUI7RUFFQSwwRUFBMEUsR0FDMUUsT0FBTyxHQUFtQixFQUErQjtJQUN2RCxNQUFNLFNBQVMsY0FBYztJQUM3QixPQUFPLFdBQVcsWUFBWSxZQUFZLElBQUksQ0FBQyxDQUFBLElBQUssQ0FBQyxHQUFHLENBQUMsVUFBVTtFQUNyRTtFQUVBOzs7O0dBSUMsR0FDRCxZQUFzQjtJQUNwQixPQUFPO1NBQUksSUFBSSxDQUFDLENBQUEsSUFBSyxDQUFDLE1BQU07S0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQVMsS0FBSyxJQUFJO0VBQ3pEO0VBRUEsa0NBQWtDLEdBQ2xDLElBQUksT0FBZTtJQUNqQixPQUFPLElBQUksQ0FBQyxDQUFBLElBQUssQ0FBQyxJQUFJO0VBQ3hCO0FBQ0YifQ==
// denoCacheMetadata=14248432812610797877,16100679626634453410