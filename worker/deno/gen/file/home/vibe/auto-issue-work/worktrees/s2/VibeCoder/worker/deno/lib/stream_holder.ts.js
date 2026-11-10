/**
 * Stream affinity — which host holds a milestone stream's conversation
 * (Issue #2336).
 *
 * A stream owns one agent conversation (`stream_identity.ts`, #2331) and that
 * conversation's transcript lives on **one host's disk**: the resume record is
 * written to `${workDir}` by the run that had it (`stream_session.ts`, #2333).
 * A sibling host claiming the stream's next issue therefore cannot resume it —
 * it starts the conversation again from nothing, and the context every
 * sub-issue of that milestone was accumulating is lost.
 *
 * So the holder gets a head start. When a stream run finishes it records
 * itself on GitHub; when another host sees that stream's next eligible issue it
 * waits {@link STREAM_AFFINITY_GRACE_SECONDS} before claiming. If the holder
 * comes back inside that window it takes its own stream and resumes; if it
 * does not, the first other host to scan claims, starts the stream afresh and
 * becomes the new holder.
 *
 * ## Where the holder is recorded
 *
 * On the milestone's **tracking issue** — the planning issue the milestone was
 * created from, which `buildPlanningMilestoneTitle` names in the milestone's
 * own `#<N> …` title (`planning_milestone.ts`). It is the one issue that exists
 * for the whole life of the milestone, so a marker there outlives every
 * sub-issue. A milestone whose title carries no `#<N>` head — one made by hand
 * in the UI — has no resolvable tracking issue: the write is skipped and
 * logged, and affinity simply does not apply to that stream.
 *
 * Exactly one live marker per stream: an existing marker is **rewritten in
 * place** and any leftovers from earlier runs are deleted, so repeated runs
 * never pile markers up on the tracking issue.
 *
 * ## Fail direction
 *
 * Fails **open**, loudly. An unreachable GitHub, an unparseable page or a
 * milestone this module cannot resolve logs and lets the claim proceed — an
 * affinity head start is an optimisation, never a lock, and a fleet that
 * cannot read a marker must still claim work. The one thing never done
 * silently is reporting an unread marker as "no holder": every failure is
 * logged before the claim proceeds.
 *
 * Grace is measured from this host's **own first sighting** of the issue in
 * this process, so a holder that is simply slow cannot be robbed by a host
 * whose clock disagrees. A restart resets that clock — and because a deferral
 * also puts the issue on cooldown for the rest of the process, that clock
 * alone never expires on a fleet that relaunches hourly. So the marker's own
 * stamp is the backstop: {@link STREAM_HOLDER_HEAD_START_SECONDS} after the
 * holding run finished, the head start is over whoever is asking.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ import { isFleetAuthor } from "./fleet_authors.ts";
import { runGhCommand } from "./github.ts";
import { hostFromMachineId } from "./heartbeat_storage.ts";
import { deleteStreamSession } from "./resume_state_store.ts";
import { deleteIssueComment, fetchMarkerComments } from "./marker_comment_pages.ts";
import { isBlankStream, resolveStreamId, streamKey, streamLabel } from "./stream_identity.ts";
/**
 * How long a non-holder waits before claiming a milestone stream's issue.
 *
 * Between two and three scans at the 120 s default (Issue #2446) — long enough
 * for a holder finishing one
 * sub-issue to pick up the next, short enough that a host that has genuinely
 * gone away costs the milestone five minutes and not a cycle.
 */ export const STREAM_AFFINITY_GRACE_SECONDS = 300;
/**
 * How long after the holder's run **finished** its head start lasts, by the
 * marker's own clock.
 *
 * The local grace above counts from this *process's* first sighting, and that
 * alone can never expire: a deferral puts the issue on cooldown for the rest
 * of the process, and the next hourly launch starts the count again — so for
 * 23 hours on 2026-09-18/19 every host logged "300s left" and claimed nothing.
 * The marker records when the holding run finished, which no restart resets.
 *
 * Three times the grace, so ordinary clock disagreement between two hosts
 * (seconds, under NTP) can never rob a holder that is merely slow — the
 * concern the local clock was chosen for. A marker stamped in the future is
 * skew by definition and never shortens anything.
 */ export const STREAM_HOLDER_HEAD_START_SECONDS = STREAM_AFFINITY_GRACE_SECONDS * 3;
/**
 * Marker name, and the `--jq test()` pattern the comment read filters on.
 *
 * Plain `[a-z-]`, so it is its own regex and needs no escaping.
 */ export const STREAM_HOLDER_MARKER_PREFIX = "vibe-stream-holder";
/** How long a first-sighting entry is kept before it is pruned. */ const SIGHTING_RETENTION_SECONDS = STREAM_AFFINITY_GRACE_SECONDS * 4;
/**
 * The marker, in full.
 *
 * Both fields are written through {@link sanitiseField}, so neither can carry
 * whitespace or the `-->` that would end the comment early — the pattern is
 * therefore anchored on character classes rather than a lazy `.*?`.
 */ const HOLDER_MARKER_RE = new RegExp(`<!--\\s*${STREAM_HOLDER_MARKER_PREFIX}\\s+stream=([A-Za-z0-9._-]+)` + `\\s+host=([A-Za-z0-9._-]+)\\s+at=(\\d{1,15})\\s*-->`, "u");
/** The leading `#<N>` of a planning milestone's title. */ const MILESTONE_PARENT_RE = /^#(\d+)\b/u;
/** Reduce a field to characters that cannot break the marker. */ function sanitiseField(value) {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
}
/** Render the holder marker for `streamKey`. */ export function formatStreamHolderMarker(key, host, atEpoch) {
  return `<!-- ${STREAM_HOLDER_MARKER_PREFIX} stream=${sanitiseField(key)} ` + `host=${sanitiseField(host)} at=${Math.max(0, Math.floor(atEpoch))} -->`;
}
/** The holder marker in `body`, or null when it carries none. */ export function parseStreamHolderMarker(body) {
  const match = HOLDER_MARKER_RE.exec(body);
  if (match === null) return null;
  const atEpoch = Number.parseInt(match[3], 10);
  if (!Number.isFinite(atEpoch)) return null;
  return {
    streamKey: match[1],
    host: match[2],
    atEpoch
  };
}
/** The comment body a holder write posts — the marker, plus a readable line. */ function holderBody(key, host, atEpoch) {
  return `${formatStreamHolderMarker(key, host, atEpoch)}\n` + `Stream affinity: \`${sanitiseField(host)}\` holds this milestone's ` + `conversation. Another host claims this stream's next issue after ` + `${STREAM_AFFINITY_GRACE_SECONDS}s and starts the conversation afresh ` + `(Issue #2336).`;
}
/**
 * The planning issue `stream`'s milestone was created from, or null.
 *
 * Read from the milestone title's `#<N>` head, which
 * `buildPlanningMilestoneTitle` puts there precisely so the parent survives a
 * truncated or renamed descriptive tail. Null for the blank stream — it has no
 * milestone, no holder and no affinity — and for a milestone made by hand with
 * no `#<N>` head.
 */ export function streamTrackingIssue(stream) {
  if (isBlankStream(stream)) return null;
  const match = MILESTONE_PARENT_RE.exec((stream.milestoneTitle ?? "").trim());
  if (match === null) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
/** Comments of `comments` that this module trusts and that name `key`. */ function holderMarkersFor(comments, key, trustedAuthors) {
  const filterByAuthor = trustedAuthors.length > 0;
  const rows = [];
  for (const comment of comments){
    if (filterByAuthor && !isFleetAuthor(comment.author, [
      ...trustedAuthors
    ])) {
      continue;
    }
    const marker = parseStreamHolderMarker(comment.body);
    if (marker === null || marker.streamKey !== key) continue;
    rows.push({
      comment,
      marker
    });
  }
  // Oldest first, so the last entry is the live marker: newest `at`, and the
  // highest comment id where two runs finished in the same second.
  rows.sort((a, b)=>a.marker.atEpoch - b.marker.atEpoch || a.comment.id - b.comment.id);
  return rows;
}
/**
 * Record `host` as the holder of `stream`'s conversation.
 *
 * Best-effort and never throws: `false` on a blank stream, a milestone with no
 * resolvable tracking issue, or any `gh` failure — each reported through
 * `log`. Affinity then simply does not apply to that stream, which costs a
 * resume and nothing else.
 */ export async function writeStreamHolder(options) {
  const { repo, stream, host, ghCommandFn = runGhCommand, trustedAuthors = [], nowSeconds = Math.floor(Date.now() / 1000), log = (message)=>console.warn(message), logInfo = (message)=>console.info(message) } = options;
  const trackingIssue = streamTrackingIssue(stream);
  if (trackingIssue === null) {
    // The blank stream has no holder by design — each host keeps its own — so
    // it is not worth a line. A milestone made by hand in the UI is the
    // feature declining to apply, not a fault: it is stated once per run at
    // INFO, and nothing is degraded by it.
    if (!isBlankStream(stream)) {
      logInfo(`[stream_holder] repo=${repo} stream=${streamLabel(stream)} ` + `holder_not_recorded — the milestone title carries no \`#<N>\` ` + `head, so it has no tracking issue to record the holder on; ` + `affinity does not apply to this stream (Issue #2336)`);
    }
    return false;
  }
  let key;
  try {
    key = streamKey(stream);
  } catch (err) {
    log(`[stream_holder] repo=${repo} holder_not_recorded stream_unresolved ` + `error=${describe(err)} (Issue #2336)`);
    return false;
  }
  try {
    const comments = await fetchMarkerComments(repo, trackingIssue, STREAM_HOLDER_MARKER_PREFIX, ghCommandFn);
    const existing = holderMarkersFor(comments, key, trustedAuthors);
    const body = holderBody(key, host, nowSeconds);
    const live = existing.at(-1);
    if (live === undefined) {
      await ghCommandFn([
        "api",
        "-X",
        "POST",
        `repos/${repo}/issues/${trackingIssue}/comments`,
        "-f",
        `body=${body}`
      ]);
      return true;
    }
    // Supersede in place, so one stream keeps exactly one live marker however
    // many runs it has had.
    await ghCommandFn([
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/issues/comments/${live.comment.id}`,
      "-f",
      `body=${body}`
    ]);
    for (const stale of existing.slice(0, -1)){
      const failure = await deleteIssueComment(repo, stale.comment.id, ghCommandFn);
      if (failure !== null) {
        log(`[stream_holder] repo=${repo} stream=${streamLabel(stream)} ` + `stale_marker_kept comment=${stale.comment.id} ` + `error=${failure.message} — a superseded holder marker could not ` + `be removed (Issue #2336)`);
      }
    }
    return true;
  } catch (err) {
    log(`[stream_holder] repo=${repo} stream=${streamLabel(stream)} ` + `holder_write_failed issue=#${trackingIssue} error=${describe(err)} ` + `— the stream's next issue is claimable by any host (Issue #2336)`);
    return false;
  }
}
/**
 * The host holding `stream`'s conversation, or null when none is recorded.
 *
 * Null is also the answer when the read fails — reported through `log` first,
 * because an unread marker must never pass silently as "no holder".
 */ export async function readStreamHolder(repo, stream, options = {}) {
  const { ghCommandFn = runGhCommand, trustedAuthors = [], log = (message)=>console.warn(message) } = options;
  const trackingIssue = streamTrackingIssue(stream);
  if (trackingIssue === null) return null;
  let key;
  try {
    key = streamKey(stream);
  } catch (err) {
    log(`[stream_holder] repo=${repo} holder_read_failed stream_unresolved ` + `error=${describe(err)} — proceeding with the claim as if no host ` + `held the stream (Issue #2336)`);
    return null;
  }
  try {
    const comments = await fetchMarkerComments(repo, trackingIssue, STREAM_HOLDER_MARKER_PREFIX, ghCommandFn);
    const live = holderMarkersFor(comments, key, trustedAuthors).at(-1);
    return live === undefined ? null : {
      host: live.marker.host,
      atEpoch: live.marker.atEpoch
    };
  } catch (err) {
    log(`[stream_holder] repo=${repo} stream=${streamLabel(stream)} ` + `holder_read_failed issue=#${trackingIssue} error=${describe(err)} ` + `— proceeding with the claim as if no host held the stream ` + `(Issue #2336)`);
    return null;
  }
}
/**
 * Decide whether this host waits for the recorded holder.
 *
 * Pure — the clock, the holder and this host's first sighting are all inputs.
 * Hosts are compared on the **install** part of the machine id — the
 * persisted uuid, not the per-launch container hostname — so two slots on one
 * machine, and the same machine after a relaunch, share its transcript rather
 * than deferring to each other.
 */ export function decideStreamAffinity(options) {
  const { holder, thisHost, eligibleSinceSeconds, nowSeconds } = options;
  if (holder === null) return {
    defer: false
  };
  const holderHost = hostFromMachineId(holder.host);
  if (sameInstall(holder.host, thisHost)) return {
    defer: false
  };
  // The holder's head start is over once EITHER clock says so: this process
  // has waited out the grace, or the holding run finished long enough ago by
  // the marker's own stamp. The second is what survives a restart.
  const holderAge = nowSeconds - holder.atEpoch;
  if (holderAge >= STREAM_HOLDER_HEAD_START_SECONDS) {
    return {
      defer: false,
      holderHost,
      graceExpired: true
    };
  }
  const elapsed = Math.max(0, nowSeconds - eligibleSinceSeconds);
  const secondsLeft = STREAM_AFFINITY_GRACE_SECONDS - elapsed;
  if (secondsLeft <= 0) return {
    defer: false,
    holderHost,
    graceExpired: true
  };
  return {
    defer: true,
    holderHost,
    secondsLeft
  };
}
// The per-install UUID a machine id ends with (`machine_id.ts`).
const INSTALL_UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/**
 * The part of a machine id that identifies the **install**, not the launch.
 *
 * A machine id is `{hostname}-{uuid}`. The uuid is persisted in the work
 * directory and "survives hostname changes"; the hostname is the container's
 * — `vibe-coder-<random>`, new on every hourly launch. Comparing on the
 * hostname meant a holder never recognised itself after its next launch and
 * deferred to its own past name. Null when the id carries no uuid.
 */ function installFromMachineId(machineId) {
  return INSTALL_UUID_RE.exec(machineId)?.[1]?.toLowerCase() ?? null;
}
/**
 * Are these two ids the same install?
 *
 * On the install uuid when **both** carry one — the production case, where
 * both sides are full machine ids. A caller that only has a bare host id
 * carries no uuid to compare, so that pair falls back to the hostname, as the
 * comparison always did.
 */ function sameInstall(a, b) {
  const installA = installFromMachineId(a);
  const installB = installFromMachineId(b);
  if (installA !== null && installB !== null) return installA === installB;
  return hostFromMachineId(a) === hostFromMachineId(b);
}
/**
 * The one line a deferral logs and reports.
 *
 * Exported so the claim path, the tests and a log grep share one wording
 * rather than re-spelling it.
 */ export function formatStreamAffinityDeferral(label, holderHost, secondsLeft) {
  return `stream affinity: deferring ${label} to ${holderHost} ` + `(${secondsLeft}s left)`;
}
/**
 * When this process first saw each issue as eligible, and which deferrals it
 * has already logged.
 *
 * Process-local on purpose: the grace measures *this* host's patience, so it
 * must not be read from a marker another host wrote. Entries older than
 * {@link SIGHTING_RETENTION_SECONDS} are pruned, so a long-lived worker cannot
 * grow these without bound.
 */ const firstSeenAt = new Map();
const deferralLogged = new Set();
function sightingKey(repo, issueNumber) {
  return `${repo}#${issueNumber}`;
}
function pruneSightings(nowSeconds) {
  for (const [key, seen] of firstSeenAt){
    if (nowSeconds - seen > SIGHTING_RETENTION_SECONDS) {
      firstSeenAt.delete(key);
      deferralLogged.delete(key);
    }
  }
}
/**
 * Record — and return — when this process first saw `issueNumber` as eligible.
 * Repeated calls return the first sighting, which is what the grace counts
 * from.
 */ export function noteIssueEligible(repo, issueNumber, nowSeconds) {
  pruneSightings(nowSeconds);
  const key = sightingKey(repo, issueNumber);
  const seen = firstSeenAt.get(key);
  if (seen !== undefined) return seen;
  firstSeenAt.set(key, nowSeconds);
  return nowSeconds;
}
/** Forget an issue's clock — it is this host's now, or no longer deferred. */ export function forgetIssueEligibility(repo, issueNumber) {
  const key = sightingKey(repo, issueNumber);
  firstSeenAt.delete(key);
  deferralLogged.delete(key);
}
/** Drop every recorded sighting. For tests, which must not share a clock. */ export function resetStreamAffinityState() {
  firstSeenAt.clear();
  deferralLogged.clear();
}
/**
 * Should this host wait before claiming `issueNumber`?
 *
 * Costs one `gh api` read of the milestone's tracking issue, and **nothing at
 * all** for a blank-stream issue: a repository's issues with no milestone have
 * no shared conversation, each host keeps its own, and the affinity path never
 * applies to them.
 *
 * Never throws — see the module comment's fail direction.
 */ export async function checkStreamAffinity(options) {
  const { repo, issueNumber, milestoneTitle, thisHost, ghCommandFn = runGhCommand, trustedAuthors = [], nowSeconds = Math.floor(Date.now() / 1000), workDir, log = (message)=>console.warn(message), logInfo = (message)=>console.info(message) } = options;
  let stream;
  try {
    stream = resolveStreamId(repo, milestoneTitle);
  } catch (err) {
    log(`[stream_holder] repo=${repo} issue=#${issueNumber} stream_unresolved ` + `error=${describe(err)} — proceeding with the claim (Issue #2336)`);
    return {
      defer: false
    };
  }
  if (isBlankStream(stream)) return {
    defer: false
  };
  const holder = await readStreamHolder(repo, stream, {
    ghCommandFn,
    trustedAuthors,
    log
  });
  if (holder === null) return {
    defer: false
  };
  const decision = decideStreamAffinity({
    holder,
    thisHost,
    eligibleSinceSeconds: noteIssueEligible(repo, issueNumber, nowSeconds),
    nowSeconds
  });
  const label = streamLabel(stream);
  if (decision.graceExpired) {
    // The conversation is on the other host's disk, so taking the stream means
    // opening it again from nothing. Any record this host still holds is its
    // own transcript from when it last had the stream — stale by however many
    // issues the holder has run since — so it is dropped rather than resumed
    // as though it were current, and the hand-over is stated plainly.
    if (workDir !== undefined) {
      try {
        await deleteStreamSession(workDir, stream);
      } catch (err) {
        log(`[stream_holder] repo=${repo} issue=#${issueNumber} ` + `stream_reset_failed error=${describe(err)} — this host may ` + `resume a stale transcript for ${label} (Issue #2336)`);
      }
    }
    logInfo(`stream session reset: affinity grace expired — ${label} was held by ` + `${decision.holderHost}, claimed on this host after ` + `${STREAM_AFFINITY_GRACE_SECONDS}s (Issue #2336)`);
    forgetIssueEligibility(repo, issueNumber);
    return decision;
  }
  if (!decision.defer) {
    forgetIssueEligibility(repo, issueNumber);
    return decision;
  }
  const detail = formatStreamAffinityDeferral(label, decision.holderHost ?? "unknown-host", decision.secondsLeft ?? STREAM_AFFINITY_GRACE_SECONDS);
  const key = sightingKey(repo, issueNumber);
  if (!deferralLogged.has(key)) {
    deferralLogged.add(key);
    logInfo(`[stream_holder] repo=${repo} issue=#${issueNumber} ${detail} — ` + `retried on a later scan (Issue #2336)`);
  }
  return {
    ...decision,
    detail
  };
}
/**
 * Record this host as the holder of the stream its run just finished.
 *
 * The phase-facing wrapper: a no-op for a run that joined no stream, for one
 * whose join recorded no host, and for the blank stream. Never throws.
 */ export async function recordStreamHolderForRun(options) {
  const { joined } = options;
  if (!joined?.holderHost) return false;
  const { joined: _joined, ...io } = options;
  return await writeStreamHolder({
    ...io,
    repo: joined.stream.repo,
    stream: joined.stream,
    host: joined.holderHost
  });
}
/** An error's message, for a log line. */ function describe(err) {
  return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zdHJlYW1faG9sZGVyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU3RyZWFtIGFmZmluaXR5IOKAlCB3aGljaCBob3N0IGhvbGRzIGEgbWlsZXN0b25lIHN0cmVhbSdzIGNvbnZlcnNhdGlvblxuICogKElzc3VlICMyMzM2KS5cbiAqXG4gKiBBIHN0cmVhbSBvd25zIG9uZSBhZ2VudCBjb252ZXJzYXRpb24gKGBzdHJlYW1faWRlbnRpdHkudHNgLCAjMjMzMSkgYW5kIHRoYXRcbiAqIGNvbnZlcnNhdGlvbidzIHRyYW5zY3JpcHQgbGl2ZXMgb24gKipvbmUgaG9zdCdzIGRpc2sqKjogdGhlIHJlc3VtZSByZWNvcmQgaXNcbiAqIHdyaXR0ZW4gdG8gYCR7d29ya0Rpcn1gIGJ5IHRoZSBydW4gdGhhdCBoYWQgaXQgKGBzdHJlYW1fc2Vzc2lvbi50c2AsICMyMzMzKS5cbiAqIEEgc2libGluZyBob3N0IGNsYWltaW5nIHRoZSBzdHJlYW0ncyBuZXh0IGlzc3VlIHRoZXJlZm9yZSBjYW5ub3QgcmVzdW1lIGl0IOKAlFxuICogaXQgc3RhcnRzIHRoZSBjb252ZXJzYXRpb24gYWdhaW4gZnJvbSBub3RoaW5nLCBhbmQgdGhlIGNvbnRleHQgZXZlcnlcbiAqIHN1Yi1pc3N1ZSBvZiB0aGF0IG1pbGVzdG9uZSB3YXMgYWNjdW11bGF0aW5nIGlzIGxvc3QuXG4gKlxuICogU28gdGhlIGhvbGRlciBnZXRzIGEgaGVhZCBzdGFydC4gV2hlbiBhIHN0cmVhbSBydW4gZmluaXNoZXMgaXQgcmVjb3Jkc1xuICogaXRzZWxmIG9uIEdpdEh1Yjsgd2hlbiBhbm90aGVyIGhvc3Qgc2VlcyB0aGF0IHN0cmVhbSdzIG5leHQgZWxpZ2libGUgaXNzdWUgaXRcbiAqIHdhaXRzIHtAbGluayBTVFJFQU1fQUZGSU5JVFlfR1JBQ0VfU0VDT05EU30gYmVmb3JlIGNsYWltaW5nLiBJZiB0aGUgaG9sZGVyXG4gKiBjb21lcyBiYWNrIGluc2lkZSB0aGF0IHdpbmRvdyBpdCB0YWtlcyBpdHMgb3duIHN0cmVhbSBhbmQgcmVzdW1lczsgaWYgaXRcbiAqIGRvZXMgbm90LCB0aGUgZmlyc3Qgb3RoZXIgaG9zdCB0byBzY2FuIGNsYWltcywgc3RhcnRzIHRoZSBzdHJlYW0gYWZyZXNoIGFuZFxuICogYmVjb21lcyB0aGUgbmV3IGhvbGRlci5cbiAqXG4gKiAjIyBXaGVyZSB0aGUgaG9sZGVyIGlzIHJlY29yZGVkXG4gKlxuICogT24gdGhlIG1pbGVzdG9uZSdzICoqdHJhY2tpbmcgaXNzdWUqKiDigJQgdGhlIHBsYW5uaW5nIGlzc3VlIHRoZSBtaWxlc3RvbmUgd2FzXG4gKiBjcmVhdGVkIGZyb20sIHdoaWNoIGBidWlsZFBsYW5uaW5nTWlsZXN0b25lVGl0bGVgIG5hbWVzIGluIHRoZSBtaWxlc3RvbmUnc1xuICogb3duIGAjPE4+IOKApmAgdGl0bGUgKGBwbGFubmluZ19taWxlc3RvbmUudHNgKS4gSXQgaXMgdGhlIG9uZSBpc3N1ZSB0aGF0IGV4aXN0c1xuICogZm9yIHRoZSB3aG9sZSBsaWZlIG9mIHRoZSBtaWxlc3RvbmUsIHNvIGEgbWFya2VyIHRoZXJlIG91dGxpdmVzIGV2ZXJ5XG4gKiBzdWItaXNzdWUuIEEgbWlsZXN0b25lIHdob3NlIHRpdGxlIGNhcnJpZXMgbm8gYCM8Tj5gIGhlYWQg4oCUIG9uZSBtYWRlIGJ5IGhhbmRcbiAqIGluIHRoZSBVSSDigJQgaGFzIG5vIHJlc29sdmFibGUgdHJhY2tpbmcgaXNzdWU6IHRoZSB3cml0ZSBpcyBza2lwcGVkIGFuZFxuICogbG9nZ2VkLCBhbmQgYWZmaW5pdHkgc2ltcGx5IGRvZXMgbm90IGFwcGx5IHRvIHRoYXQgc3RyZWFtLlxuICpcbiAqIEV4YWN0bHkgb25lIGxpdmUgbWFya2VyIHBlciBzdHJlYW06IGFuIGV4aXN0aW5nIG1hcmtlciBpcyAqKnJld3JpdHRlbiBpblxuICogcGxhY2UqKiBhbmQgYW55IGxlZnRvdmVycyBmcm9tIGVhcmxpZXIgcnVucyBhcmUgZGVsZXRlZCwgc28gcmVwZWF0ZWQgcnVuc1xuICogbmV2ZXIgcGlsZSBtYXJrZXJzIHVwIG9uIHRoZSB0cmFja2luZyBpc3N1ZS5cbiAqXG4gKiAjIyBGYWlsIGRpcmVjdGlvblxuICpcbiAqIEZhaWxzICoqb3BlbioqLCBsb3VkbHkuIEFuIHVucmVhY2hhYmxlIEdpdEh1YiwgYW4gdW5wYXJzZWFibGUgcGFnZSBvciBhXG4gKiBtaWxlc3RvbmUgdGhpcyBtb2R1bGUgY2Fubm90IHJlc29sdmUgbG9ncyBhbmQgbGV0cyB0aGUgY2xhaW0gcHJvY2VlZCDigJQgYW5cbiAqIGFmZmluaXR5IGhlYWQgc3RhcnQgaXMgYW4gb3B0aW1pc2F0aW9uLCBuZXZlciBhIGxvY2ssIGFuZCBhIGZsZWV0IHRoYXRcbiAqIGNhbm5vdCByZWFkIGEgbWFya2VyIG11c3Qgc3RpbGwgY2xhaW0gd29yay4gVGhlIG9uZSB0aGluZyBuZXZlciBkb25lXG4gKiBzaWxlbnRseSBpcyByZXBvcnRpbmcgYW4gdW5yZWFkIG1hcmtlciBhcyBcIm5vIGhvbGRlclwiOiBldmVyeSBmYWlsdXJlIGlzXG4gKiBsb2dnZWQgYmVmb3JlIHRoZSBjbGFpbSBwcm9jZWVkcy5cbiAqXG4gKiBHcmFjZSBpcyBtZWFzdXJlZCBmcm9tIHRoaXMgaG9zdCdzICoqb3duIGZpcnN0IHNpZ2h0aW5nKiogb2YgdGhlIGlzc3VlIGluXG4gKiB0aGlzIHByb2Nlc3MsIHNvIGEgaG9sZGVyIHRoYXQgaXMgc2ltcGx5IHNsb3cgY2Fubm90IGJlIHJvYmJlZCBieSBhIGhvc3RcbiAqIHdob3NlIGNsb2NrIGRpc2FncmVlcy4gQSByZXN0YXJ0IHJlc2V0cyB0aGF0IGNsb2NrIOKAlCBhbmQgYmVjYXVzZSBhIGRlZmVycmFsXG4gKiBhbHNvIHB1dHMgdGhlIGlzc3VlIG9uIGNvb2xkb3duIGZvciB0aGUgcmVzdCBvZiB0aGUgcHJvY2VzcywgdGhhdCBjbG9ja1xuICogYWxvbmUgbmV2ZXIgZXhwaXJlcyBvbiBhIGZsZWV0IHRoYXQgcmVsYXVuY2hlcyBob3VybHkuIFNvIHRoZSBtYXJrZXIncyBvd25cbiAqIHN0YW1wIGlzIHRoZSBiYWNrc3RvcDoge0BsaW5rIFNUUkVBTV9IT0xERVJfSEVBRF9TVEFSVF9TRUNPTkRTfSBhZnRlciB0aGVcbiAqIGhvbGRpbmcgcnVuIGZpbmlzaGVkLCB0aGUgaGVhZCBzdGFydCBpcyBvdmVyIHdob2V2ZXIgaXMgYXNraW5nLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB1c2VkIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQgeyBpc0ZsZWV0QXV0aG9yIH0gZnJvbSBcIi4vZmxlZXRfYXV0aG9ycy50c1wiO1xuaW1wb3J0IHsgcnVuR2hDb21tYW5kIH0gZnJvbSBcIi4vZ2l0aHViLnRzXCI7XG5pbXBvcnQgeyBob3N0RnJvbU1hY2hpbmVJZCB9IGZyb20gXCIuL2hlYXJ0YmVhdF9zdG9yYWdlLnRzXCI7XG5pbXBvcnQgeyBkZWxldGVTdHJlYW1TZXNzaW9uIH0gZnJvbSBcIi4vcmVzdW1lX3N0YXRlX3N0b3JlLnRzXCI7XG5pbXBvcnQge1xuICBkZWxldGVJc3N1ZUNvbW1lbnQsXG4gIGZldGNoTWFya2VyQ29tbWVudHMsXG4gIHR5cGUgTWFya2VyQ29tbWVudCxcbn0gZnJvbSBcIi4vbWFya2VyX2NvbW1lbnRfcGFnZXMudHNcIjtcbmltcG9ydCB7XG4gIGlzQmxhbmtTdHJlYW0sXG4gIHJlc29sdmVTdHJlYW1JZCxcbiAgdHlwZSBTdHJlYW1JZCxcbiAgc3RyZWFtS2V5LFxuICBzdHJlYW1MYWJlbCxcbn0gZnJvbSBcIi4vc3RyZWFtX2lkZW50aXR5LnRzXCI7XG5cbi8qKlxuICogSG93IGxvbmcgYSBub24taG9sZGVyIHdhaXRzIGJlZm9yZSBjbGFpbWluZyBhIG1pbGVzdG9uZSBzdHJlYW0ncyBpc3N1ZS5cbiAqXG4gKiBCZXR3ZWVuIHR3byBhbmQgdGhyZWUgc2NhbnMgYXQgdGhlIDEyMCBzIGRlZmF1bHQgKElzc3VlICMyNDQ2KSDigJQgbG9uZyBlbm91Z2hcbiAqIGZvciBhIGhvbGRlciBmaW5pc2hpbmcgb25lXG4gKiBzdWItaXNzdWUgdG8gcGljayB1cCB0aGUgbmV4dCwgc2hvcnQgZW5vdWdoIHRoYXQgYSBob3N0IHRoYXQgaGFzIGdlbnVpbmVseVxuICogZ29uZSBhd2F5IGNvc3RzIHRoZSBtaWxlc3RvbmUgZml2ZSBtaW51dGVzIGFuZCBub3QgYSBjeWNsZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNUUkVBTV9BRkZJTklUWV9HUkFDRV9TRUNPTkRTID0gMzAwO1xuXG4vKipcbiAqIEhvdyBsb25nIGFmdGVyIHRoZSBob2xkZXIncyBydW4gKipmaW5pc2hlZCoqIGl0cyBoZWFkIHN0YXJ0IGxhc3RzLCBieSB0aGVcbiAqIG1hcmtlcidzIG93biBjbG9jay5cbiAqXG4gKiBUaGUgbG9jYWwgZ3JhY2UgYWJvdmUgY291bnRzIGZyb20gdGhpcyAqcHJvY2VzcydzKiBmaXJzdCBzaWdodGluZywgYW5kIHRoYXRcbiAqIGFsb25lIGNhbiBuZXZlciBleHBpcmU6IGEgZGVmZXJyYWwgcHV0cyB0aGUgaXNzdWUgb24gY29vbGRvd24gZm9yIHRoZSByZXN0XG4gKiBvZiB0aGUgcHJvY2VzcywgYW5kIHRoZSBuZXh0IGhvdXJseSBsYXVuY2ggc3RhcnRzIHRoZSBjb3VudCBhZ2FpbiDigJQgc28gZm9yXG4gKiAyMyBob3VycyBvbiAyMDI2LTA5LTE4LzE5IGV2ZXJ5IGhvc3QgbG9nZ2VkIFwiMzAwcyBsZWZ0XCIgYW5kIGNsYWltZWQgbm90aGluZy5cbiAqIFRoZSBtYXJrZXIgcmVjb3JkcyB3aGVuIHRoZSBob2xkaW5nIHJ1biBmaW5pc2hlZCwgd2hpY2ggbm8gcmVzdGFydCByZXNldHMuXG4gKlxuICogVGhyZWUgdGltZXMgdGhlIGdyYWNlLCBzbyBvcmRpbmFyeSBjbG9jayBkaXNhZ3JlZW1lbnQgYmV0d2VlbiB0d28gaG9zdHNcbiAqIChzZWNvbmRzLCB1bmRlciBOVFApIGNhbiBuZXZlciByb2IgYSBob2xkZXIgdGhhdCBpcyBtZXJlbHkgc2xvdyDigJQgdGhlXG4gKiBjb25jZXJuIHRoZSBsb2NhbCBjbG9jayB3YXMgY2hvc2VuIGZvci4gQSBtYXJrZXIgc3RhbXBlZCBpbiB0aGUgZnV0dXJlIGlzXG4gKiBza2V3IGJ5IGRlZmluaXRpb24gYW5kIG5ldmVyIHNob3J0ZW5zIGFueXRoaW5nLlxuICovXG5leHBvcnQgY29uc3QgU1RSRUFNX0hPTERFUl9IRUFEX1NUQVJUX1NFQ09ORFMgPSBTVFJFQU1fQUZGSU5JVFlfR1JBQ0VfU0VDT05EUyAqXG4gIDM7XG5cbi8qKlxuICogTWFya2VyIG5hbWUsIGFuZCB0aGUgYC0tanEgdGVzdCgpYCBwYXR0ZXJuIHRoZSBjb21tZW50IHJlYWQgZmlsdGVycyBvbi5cbiAqXG4gKiBQbGFpbiBgW2Etei1dYCwgc28gaXQgaXMgaXRzIG93biByZWdleCBhbmQgbmVlZHMgbm8gZXNjYXBpbmcuXG4gKi9cbmV4cG9ydCBjb25zdCBTVFJFQU1fSE9MREVSX01BUktFUl9QUkVGSVggPSBcInZpYmUtc3RyZWFtLWhvbGRlclwiO1xuXG4vKiogSG93IGxvbmcgYSBmaXJzdC1zaWdodGluZyBlbnRyeSBpcyBrZXB0IGJlZm9yZSBpdCBpcyBwcnVuZWQuICovXG5jb25zdCBTSUdIVElOR19SRVRFTlRJT05fU0VDT05EUyA9IFNUUkVBTV9BRkZJTklUWV9HUkFDRV9TRUNPTkRTICogNDtcblxuLyoqIFRoZSBob3N0IHRoYXQgbGFzdCByYW4gYSBzdHJlYW0sIGFzIGl0cyBtYXJrZXIgcmVjb3JkcyBpdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RyZWFtSG9sZGVyIHtcbiAgLyoqIE1hY2hpbmUgaWQgb2YgdGhlIGhvbGRlciwgYXMge0BsaW5rIFN0cmVhbUhvbGRlck1hcmtlcn0gcmVjb3JkZWQgaXQuICovXG4gIGhvc3Q6IHN0cmluZztcbiAgLyoqIEVwb2NoIHNlY29uZHMgdGhlIGhvbGRpbmcgcnVuIGZpbmlzaGVkIGF0LiAqL1xuICBhdEVwb2NoOiBudW1iZXI7XG59XG5cbi8qKiBBIHBhcnNlZCBob2xkZXIgbWFya2VyLCB3aXRoIHRoZSBzdHJlYW0gaXQgYmVsb25ncyB0by4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RyZWFtSG9sZGVyTWFya2VyIGV4dGVuZHMgU3RyZWFtSG9sZGVyIHtcbiAgLyoqIHtAbGluayBzdHJlYW1LZXl9IG9mIHRoZSBzdHJlYW0gdGhpcyBtYXJrZXIgaG9sZHMuICovXG4gIHN0cmVhbUtleTogc3RyaW5nO1xufVxuXG4vKipcbiAqIFRoZSBtYXJrZXIsIGluIGZ1bGwuXG4gKlxuICogQm90aCBmaWVsZHMgYXJlIHdyaXR0ZW4gdGhyb3VnaCB7QGxpbmsgc2FuaXRpc2VGaWVsZH0sIHNvIG5laXRoZXIgY2FuIGNhcnJ5XG4gKiB3aGl0ZXNwYWNlIG9yIHRoZSBgLS0+YCB0aGF0IHdvdWxkIGVuZCB0aGUgY29tbWVudCBlYXJseSDigJQgdGhlIHBhdHRlcm4gaXNcbiAqIHRoZXJlZm9yZSBhbmNob3JlZCBvbiBjaGFyYWN0ZXIgY2xhc3NlcyByYXRoZXIgdGhhbiBhIGxhenkgYC4qP2AuXG4gKi9cbmNvbnN0IEhPTERFUl9NQVJLRVJfUkUgPSBuZXcgUmVnRXhwKFxuICBgPCEtLVxcXFxzKiR7U1RSRUFNX0hPTERFUl9NQVJLRVJfUFJFRklYfVxcXFxzK3N0cmVhbT0oW0EtWmEtejAtOS5fLV0rKWAgK1xuICAgIGBcXFxccytob3N0PShbQS1aYS16MC05Ll8tXSspXFxcXHMrYXQ9KFxcXFxkezEsMTV9KVxcXFxzKi0tPmAsXG4gIFwidVwiLFxuKTtcblxuLyoqIFRoZSBsZWFkaW5nIGAjPE4+YCBvZiBhIHBsYW5uaW5nIG1pbGVzdG9uZSdzIHRpdGxlLiAqL1xuY29uc3QgTUlMRVNUT05FX1BBUkVOVF9SRSA9IC9eIyhcXGQrKVxcYi91O1xuXG4vKiogUmVkdWNlIGEgZmllbGQgdG8gY2hhcmFjdGVycyB0aGF0IGNhbm5vdCBicmVhayB0aGUgbWFya2VyLiAqL1xuZnVuY3Rpb24gc2FuaXRpc2VGaWVsZCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlLnJlcGxhY2UoL1teQS1aYS16MC05Ll8tXSsvZ3UsIFwiLVwiKS5yZXBsYWNlKC9eLSt8LSskL2d1LCBcIlwiKTtcbn1cblxuLyoqIFJlbmRlciB0aGUgaG9sZGVyIG1hcmtlciBmb3IgYHN0cmVhbUtleWAuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0U3RyZWFtSG9sZGVyTWFya2VyKFxuICBrZXk6IHN0cmluZyxcbiAgaG9zdDogc3RyaW5nLFxuICBhdEVwb2NoOiBudW1iZXIsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYDwhLS0gJHtTVFJFQU1fSE9MREVSX01BUktFUl9QUkVGSVh9IHN0cmVhbT0ke3Nhbml0aXNlRmllbGQoa2V5KX0gYCArXG4gICAgYGhvc3Q9JHtzYW5pdGlzZUZpZWxkKGhvc3QpfSBhdD0ke01hdGgubWF4KDAsIE1hdGguZmxvb3IoYXRFcG9jaCkpfSAtLT5gO1xufVxuXG4vKiogVGhlIGhvbGRlciBtYXJrZXIgaW4gYGJvZHlgLCBvciBudWxsIHdoZW4gaXQgY2FycmllcyBub25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3RyZWFtSG9sZGVyTWFya2VyKFxuICBib2R5OiBzdHJpbmcsXG4pOiBTdHJlYW1Ib2xkZXJNYXJrZXIgfCBudWxsIHtcbiAgY29uc3QgbWF0Y2ggPSBIT0xERVJfTUFSS0VSX1JFLmV4ZWMoYm9keSk7XG4gIGlmIChtYXRjaCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGF0RXBvY2ggPSBOdW1iZXIucGFyc2VJbnQobWF0Y2hbM10hLCAxMCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKGF0RXBvY2gpKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc3RyZWFtS2V5OiBtYXRjaFsxXSEsIGhvc3Q6IG1hdGNoWzJdISwgYXRFcG9jaCB9O1xufVxuXG4vKiogVGhlIGNvbW1lbnQgYm9keSBhIGhvbGRlciB3cml0ZSBwb3N0cyDigJQgdGhlIG1hcmtlciwgcGx1cyBhIHJlYWRhYmxlIGxpbmUuICovXG5mdW5jdGlvbiBob2xkZXJCb2R5KGtleTogc3RyaW5nLCBob3N0OiBzdHJpbmcsIGF0RXBvY2g6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiBgJHtmb3JtYXRTdHJlYW1Ib2xkZXJNYXJrZXIoa2V5LCBob3N0LCBhdEVwb2NoKX1cXG5gICtcbiAgICBgU3RyZWFtIGFmZmluaXR5OiBcXGAke3Nhbml0aXNlRmllbGQoaG9zdCl9XFxgIGhvbGRzIHRoaXMgbWlsZXN0b25lJ3MgYCArXG4gICAgYGNvbnZlcnNhdGlvbi4gQW5vdGhlciBob3N0IGNsYWltcyB0aGlzIHN0cmVhbSdzIG5leHQgaXNzdWUgYWZ0ZXIgYCArXG4gICAgYCR7U1RSRUFNX0FGRklOSVRZX0dSQUNFX1NFQ09ORFN9cyBhbmQgc3RhcnRzIHRoZSBjb252ZXJzYXRpb24gYWZyZXNoIGAgK1xuICAgIGAoSXNzdWUgIzIzMzYpLmA7XG59XG5cbi8qKlxuICogVGhlIHBsYW5uaW5nIGlzc3VlIGBzdHJlYW1gJ3MgbWlsZXN0b25lIHdhcyBjcmVhdGVkIGZyb20sIG9yIG51bGwuXG4gKlxuICogUmVhZCBmcm9tIHRoZSBtaWxlc3RvbmUgdGl0bGUncyBgIzxOPmAgaGVhZCwgd2hpY2hcbiAqIGBidWlsZFBsYW5uaW5nTWlsZXN0b25lVGl0bGVgIHB1dHMgdGhlcmUgcHJlY2lzZWx5IHNvIHRoZSBwYXJlbnQgc3Vydml2ZXMgYVxuICogdHJ1bmNhdGVkIG9yIHJlbmFtZWQgZGVzY3JpcHRpdmUgdGFpbC4gTnVsbCBmb3IgdGhlIGJsYW5rIHN0cmVhbSDigJQgaXQgaGFzIG5vXG4gKiBtaWxlc3RvbmUsIG5vIGhvbGRlciBhbmQgbm8gYWZmaW5pdHkg4oCUIGFuZCBmb3IgYSBtaWxlc3RvbmUgbWFkZSBieSBoYW5kIHdpdGhcbiAqIG5vIGAjPE4+YCBoZWFkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RyZWFtVHJhY2tpbmdJc3N1ZShzdHJlYW06IFN0cmVhbUlkKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmIChpc0JsYW5rU3RyZWFtKHN0cmVhbSkpIHJldHVybiBudWxsO1xuICBjb25zdCBtYXRjaCA9IE1JTEVTVE9ORV9QQVJFTlRfUkUuZXhlYygoc3RyZWFtLm1pbGVzdG9uZVRpdGxlID8/IFwiXCIpLnRyaW0oKSk7XG4gIGlmIChtYXRjaCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG51bWJlciA9IE51bWJlci5wYXJzZUludChtYXRjaFsxXSEsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc1NhZmVJbnRlZ2VyKG51bWJlcikgJiYgbnVtYmVyID4gMCA/IG51bWJlciA6IG51bGw7XG59XG5cbi8qKiBTaGFyZWQgb3B0aW9ucyBmb3IgdGhlIHR3byBHaXRIdWItZmFjaW5nIGNhbGxzLiAqL1xuaW50ZXJmYWNlIFN0cmVhbUhvbGRlcklvIHtcbiAgLyoqIEluamVjdGVkIGBnaGAgcnVubmVyLiBEZWZhdWx0cyB0byB0aGUgcmVhbCBvbmUuICovXG4gIGdoQ29tbWFuZEZuPzogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIC8qKlxuICAgKiBGbGVldCBsb2dpbnMgd2hvc2UgbWFya2VycyBhcmUgdHJ1c3RlZC4gQSBtYXJrZXIgaXMgdGV4dCBpbiBhIGNvbW1lbnQgYm9keVxuICAgKiBhbnkgR2l0SHViIHVzZXIgY2FuIHBvc3QsIHNvIG9ubHkgYSBmbGVldCBhY2NvdW50J3MgbWFya2VyIGhvbGRzIGEgc3RyZWFtLlxuICAgKiBBbiBlbXB0eSBsaXN0IGRpc2FibGVzIHRoZSBmaWx0ZXIsIG1hdGNoaW5nIHRoZSBzdHJlYW0gbG9jay5cbiAgICovXG4gIHRydXN0ZWRBdXRob3JzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKlxuICAgKiBTaW5rIGZvciBhICoqZGVncmFkZWQqKiBvdXRjb21lIOKAlCBhIHJlYWQgb3Igd3JpdGUgdGhhdCBkaWQgbm90IGxhbmQsIHNvXG4gICAqIGFmZmluaXR5IHNpbGVudGx5IHN0b3BzIGFwcGx5aW5nLiBEZWZhdWx0cyB0byBgY29uc29sZS53YXJuYCwgYmVjYXVzZSB0aGVcbiAgICogcmVhZGVyIGhhcyBzb21ldGhpbmcgdG8gbG9vayBpbnRvLlxuICAgKi9cbiAgbG9nPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbiAgLyoqXG4gICAqIFNpbmsgZm9yIHRoZSAqKmV4cGVjdGVkKiogcGF0aCDigJQgdGhlIGNvdW50ZG93biwgdGhlIGhhbmQtb3ZlciwgYSBtaWxlc3RvbmVcbiAgICogdGhhdCBzaW1wbHkgaGFzIG5vIHRyYWNraW5nIGlzc3VlLiBEZWZhdWx0cyB0byBgY29uc29sZS5pbmZvYDogbm90aGluZyBpc1xuICAgKiB3cm9uZywgdGhpcyBpcyB0aGUgZmVhdHVyZSB3b3JraW5nLlxuICAgKi9cbiAgbG9nSW5mbz86IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG59XG5cbi8qKiBDb21tZW50cyBvZiBgY29tbWVudHNgIHRoYXQgdGhpcyBtb2R1bGUgdHJ1c3RzIGFuZCB0aGF0IG5hbWUgYGtleWAuICovXG5mdW5jdGlvbiBob2xkZXJNYXJrZXJzRm9yKFxuICBjb21tZW50czogcmVhZG9ubHkgTWFya2VyQ29tbWVudFtdLFxuICBrZXk6IHN0cmluZyxcbiAgdHJ1c3RlZEF1dGhvcnM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogQXJyYXk8eyBjb21tZW50OiBNYXJrZXJDb21tZW50OyBtYXJrZXI6IFN0cmVhbUhvbGRlck1hcmtlciB9PiB7XG4gIGNvbnN0IGZpbHRlckJ5QXV0aG9yID0gdHJ1c3RlZEF1dGhvcnMubGVuZ3RoID4gMDtcbiAgY29uc3Qgcm93czogQXJyYXk8eyBjb21tZW50OiBNYXJrZXJDb21tZW50OyBtYXJrZXI6IFN0cmVhbUhvbGRlck1hcmtlciB9PiA9XG4gICAgW107XG4gIGZvciAoY29uc3QgY29tbWVudCBvZiBjb21tZW50cykge1xuICAgIGlmIChmaWx0ZXJCeUF1dGhvciAmJiAhaXNGbGVldEF1dGhvcihjb21tZW50LmF1dGhvciwgWy4uLnRydXN0ZWRBdXRob3JzXSkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBtYXJrZXIgPSBwYXJzZVN0cmVhbUhvbGRlck1hcmtlcihjb21tZW50LmJvZHkpO1xuICAgIGlmIChtYXJrZXIgPT09IG51bGwgfHwgbWFya2VyLnN0cmVhbUtleSAhPT0ga2V5KSBjb250aW51ZTtcbiAgICByb3dzLnB1c2goeyBjb21tZW50LCBtYXJrZXIgfSk7XG4gIH1cbiAgLy8gT2xkZXN0IGZpcnN0LCBzbyB0aGUgbGFzdCBlbnRyeSBpcyB0aGUgbGl2ZSBtYXJrZXI6IG5ld2VzdCBgYXRgLCBhbmQgdGhlXG4gIC8vIGhpZ2hlc3QgY29tbWVudCBpZCB3aGVyZSB0d28gcnVucyBmaW5pc2hlZCBpbiB0aGUgc2FtZSBzZWNvbmQuXG4gIHJvd3Muc29ydCgoYSwgYikgPT5cbiAgICBhLm1hcmtlci5hdEVwb2NoIC0gYi5tYXJrZXIuYXRFcG9jaCB8fCBhLmNvbW1lbnQuaWQgLSBiLmNvbW1lbnQuaWRcbiAgKTtcbiAgcmV0dXJuIHJvd3M7XG59XG5cbi8qKlxuICogUmVjb3JkIGBob3N0YCBhcyB0aGUgaG9sZGVyIG9mIGBzdHJlYW1gJ3MgY29udmVyc2F0aW9uLlxuICpcbiAqIEJlc3QtZWZmb3J0IGFuZCBuZXZlciB0aHJvd3M6IGBmYWxzZWAgb24gYSBibGFuayBzdHJlYW0sIGEgbWlsZXN0b25lIHdpdGggbm9cbiAqIHJlc29sdmFibGUgdHJhY2tpbmcgaXNzdWUsIG9yIGFueSBgZ2hgIGZhaWx1cmUg4oCUIGVhY2ggcmVwb3J0ZWQgdGhyb3VnaFxuICogYGxvZ2AuIEFmZmluaXR5IHRoZW4gc2ltcGx5IGRvZXMgbm90IGFwcGx5IHRvIHRoYXQgc3RyZWFtLCB3aGljaCBjb3N0cyBhXG4gKiByZXN1bWUgYW5kIG5vdGhpbmcgZWxzZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlU3RyZWFtSG9sZGVyKFxuICBvcHRpb25zOiB7XG4gICAgcmVwbzogc3RyaW5nO1xuICAgIHN0cmVhbTogU3RyZWFtSWQ7XG4gICAgLyoqIFRoaXMgaG9zdCdzIG1hY2hpbmUgaWQgKGBnZXRNYWNoaW5lSWRgKSBvciBpdHMgaG9zdCBpZC4gKi9cbiAgICBob3N0OiBzdHJpbmc7XG4gICAgbm93U2Vjb25kcz86IG51bWJlcjtcbiAgfSAmIFN0cmVhbUhvbGRlcklvLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHtcbiAgICByZXBvLFxuICAgIHN0cmVhbSxcbiAgICBob3N0LFxuICAgIGdoQ29tbWFuZEZuID0gcnVuR2hDb21tYW5kLFxuICAgIHRydXN0ZWRBdXRob3JzID0gW10sXG4gICAgbm93U2Vjb25kcyA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApLFxuICAgIGxvZyA9IChtZXNzYWdlOiBzdHJpbmcpID0+IGNvbnNvbGUud2FybihtZXNzYWdlKSxcbiAgICBsb2dJbmZvID0gKG1lc3NhZ2U6IHN0cmluZykgPT4gY29uc29sZS5pbmZvKG1lc3NhZ2UpLFxuICB9ID0gb3B0aW9ucztcblxuICBjb25zdCB0cmFja2luZ0lzc3VlID0gc3RyZWFtVHJhY2tpbmdJc3N1ZShzdHJlYW0pO1xuICBpZiAodHJhY2tpbmdJc3N1ZSA9PT0gbnVsbCkge1xuICAgIC8vIFRoZSBibGFuayBzdHJlYW0gaGFzIG5vIGhvbGRlciBieSBkZXNpZ24g4oCUIGVhY2ggaG9zdCBrZWVwcyBpdHMgb3duIOKAlCBzb1xuICAgIC8vIGl0IGlzIG5vdCB3b3J0aCBhIGxpbmUuIEEgbWlsZXN0b25lIG1hZGUgYnkgaGFuZCBpbiB0aGUgVUkgaXMgdGhlXG4gICAgLy8gZmVhdHVyZSBkZWNsaW5pbmcgdG8gYXBwbHksIG5vdCBhIGZhdWx0OiBpdCBpcyBzdGF0ZWQgb25jZSBwZXIgcnVuIGF0XG4gICAgLy8gSU5GTywgYW5kIG5vdGhpbmcgaXMgZGVncmFkZWQgYnkgaXQuXG4gICAgaWYgKCFpc0JsYW5rU3RyZWFtKHN0cmVhbSkpIHtcbiAgICAgIGxvZ0luZm8oXG4gICAgICAgIGBbc3RyZWFtX2hvbGRlcl0gcmVwbz0ke3JlcG99IHN0cmVhbT0ke3N0cmVhbUxhYmVsKHN0cmVhbSl9IGAgK1xuICAgICAgICAgIGBob2xkZXJfbm90X3JlY29yZGVkIOKAlCB0aGUgbWlsZXN0b25lIHRpdGxlIGNhcnJpZXMgbm8gXFxgIzxOPlxcYCBgICtcbiAgICAgICAgICBgaGVhZCwgc28gaXQgaGFzIG5vIHRyYWNraW5nIGlzc3VlIHRvIHJlY29yZCB0aGUgaG9sZGVyIG9uOyBgICtcbiAgICAgICAgICBgYWZmaW5pdHkgZG9lcyBub3QgYXBwbHkgdG8gdGhpcyBzdHJlYW0gKElzc3VlICMyMzM2KWAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBsZXQga2V5OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAga2V5ID0gc3RyZWFtS2V5KHN0cmVhbSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZyhcbiAgICAgIGBbc3RyZWFtX2hvbGRlcl0gcmVwbz0ke3JlcG99IGhvbGRlcl9ub3RfcmVjb3JkZWQgc3RyZWFtX3VucmVzb2x2ZWQgYCArXG4gICAgICAgIGBlcnJvcj0ke2Rlc2NyaWJlKGVycil9IChJc3N1ZSAjMjMzNilgLFxuICAgICk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb21tZW50cyA9IGF3YWl0IGZldGNoTWFya2VyQ29tbWVudHMoXG4gICAgICByZXBvLFxuICAgICAgdHJhY2tpbmdJc3N1ZSxcbiAgICAgIFNUUkVBTV9IT0xERVJfTUFSS0VSX1BSRUZJWCxcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICk7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBob2xkZXJNYXJrZXJzRm9yKGNvbW1lbnRzLCBrZXksIHRydXN0ZWRBdXRob3JzKTtcbiAgICBjb25zdCBib2R5ID0gaG9sZGVyQm9keShrZXksIGhvc3QsIG5vd1NlY29uZHMpO1xuICAgIGNvbnN0IGxpdmUgPSBleGlzdGluZy5hdCgtMSk7XG5cbiAgICBpZiAobGl2ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICAgIFwiYXBpXCIsXG4gICAgICAgIFwiLVhcIixcbiAgICAgICAgXCJQT1NUXCIsXG4gICAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy8ke3RyYWNraW5nSXNzdWV9L2NvbW1lbnRzYCxcbiAgICAgICAgXCItZlwiLFxuICAgICAgICBgYm9keT0ke2JvZHl9YCxcbiAgICAgIF0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLy8gU3VwZXJzZWRlIGluIHBsYWNlLCBzbyBvbmUgc3RyZWFtIGtlZXBzIGV4YWN0bHkgb25lIGxpdmUgbWFya2VyIGhvd2V2ZXJcbiAgICAvLyBtYW55IHJ1bnMgaXQgaGFzIGhhZC5cbiAgICBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcImFwaVwiLFxuICAgICAgXCItWFwiLFxuICAgICAgXCJQQVRDSFwiLFxuICAgICAgYHJlcG9zLyR7cmVwb30vaXNzdWVzL2NvbW1lbnRzLyR7bGl2ZS5jb21tZW50LmlkfWAsXG4gICAgICBcIi1mXCIsXG4gICAgICBgYm9keT0ke2JvZHl9YCxcbiAgICBdKTtcbiAgICBmb3IgKGNvbnN0IHN0YWxlIG9mIGV4aXN0aW5nLnNsaWNlKDAsIC0xKSkge1xuICAgICAgY29uc3QgZmFpbHVyZSA9IGF3YWl0IGRlbGV0ZUlzc3VlQ29tbWVudChcbiAgICAgICAgcmVwbyxcbiAgICAgICAgc3RhbGUuY29tbWVudC5pZCxcbiAgICAgICAgZ2hDb21tYW5kRm4sXG4gICAgICApO1xuICAgICAgaWYgKGZhaWx1cmUgIT09IG51bGwpIHtcbiAgICAgICAgbG9nKFxuICAgICAgICAgIGBbc3RyZWFtX2hvbGRlcl0gcmVwbz0ke3JlcG99IHN0cmVhbT0ke3N0cmVhbUxhYmVsKHN0cmVhbSl9IGAgK1xuICAgICAgICAgICAgYHN0YWxlX21hcmtlcl9rZXB0IGNvbW1lbnQ9JHtzdGFsZS5jb21tZW50LmlkfSBgICtcbiAgICAgICAgICAgIGBlcnJvcj0ke2ZhaWx1cmUubWVzc2FnZX0g4oCUIGEgc3VwZXJzZWRlZCBob2xkZXIgbWFya2VyIGNvdWxkIG5vdCBgICtcbiAgICAgICAgICAgIGBiZSByZW1vdmVkIChJc3N1ZSAjMjMzNilgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nKFxuICAgICAgYFtzdHJlYW1faG9sZGVyXSByZXBvPSR7cmVwb30gc3RyZWFtPSR7c3RyZWFtTGFiZWwoc3RyZWFtKX0gYCArXG4gICAgICAgIGBob2xkZXJfd3JpdGVfZmFpbGVkIGlzc3VlPSMke3RyYWNraW5nSXNzdWV9IGVycm9yPSR7ZGVzY3JpYmUoZXJyKX0gYCArXG4gICAgICAgIGDigJQgdGhlIHN0cmVhbSdzIG5leHQgaXNzdWUgaXMgY2xhaW1hYmxlIGJ5IGFueSBob3N0IChJc3N1ZSAjMjMzNilgLFxuICAgICk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogVGhlIGhvc3QgaG9sZGluZyBgc3RyZWFtYCdzIGNvbnZlcnNhdGlvbiwgb3IgbnVsbCB3aGVuIG5vbmUgaXMgcmVjb3JkZWQuXG4gKlxuICogTnVsbCBpcyBhbHNvIHRoZSBhbnN3ZXIgd2hlbiB0aGUgcmVhZCBmYWlscyDigJQgcmVwb3J0ZWQgdGhyb3VnaCBgbG9nYCBmaXJzdCxcbiAqIGJlY2F1c2UgYW4gdW5yZWFkIG1hcmtlciBtdXN0IG5ldmVyIHBhc3Mgc2lsZW50bHkgYXMgXCJubyBob2xkZXJcIi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRTdHJlYW1Ib2xkZXIoXG4gIHJlcG86IHN0cmluZyxcbiAgc3RyZWFtOiBTdHJlYW1JZCxcbiAgb3B0aW9uczogU3RyZWFtSG9sZGVySW8gPSB7fSxcbik6IFByb21pc2U8U3RyZWFtSG9sZGVyIHwgbnVsbD4ge1xuICBjb25zdCB7XG4gICAgZ2hDb21tYW5kRm4gPSBydW5HaENvbW1hbmQsXG4gICAgdHJ1c3RlZEF1dGhvcnMgPSBbXSxcbiAgICBsb2cgPSAobWVzc2FnZTogc3RyaW5nKSA9PiBjb25zb2xlLndhcm4obWVzc2FnZSksXG4gIH0gPSBvcHRpb25zO1xuXG4gIGNvbnN0IHRyYWNraW5nSXNzdWUgPSBzdHJlYW1UcmFja2luZ0lzc3VlKHN0cmVhbSk7XG4gIGlmICh0cmFja2luZ0lzc3VlID09PSBudWxsKSByZXR1cm4gbnVsbDtcblxuICBsZXQga2V5OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAga2V5ID0gc3RyZWFtS2V5KHN0cmVhbSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZyhcbiAgICAgIGBbc3RyZWFtX2hvbGRlcl0gcmVwbz0ke3JlcG99IGhvbGRlcl9yZWFkX2ZhaWxlZCBzdHJlYW1fdW5yZXNvbHZlZCBgICtcbiAgICAgICAgYGVycm9yPSR7ZGVzY3JpYmUoZXJyKX0g4oCUIHByb2NlZWRpbmcgd2l0aCB0aGUgY2xhaW0gYXMgaWYgbm8gaG9zdCBgICtcbiAgICAgICAgYGhlbGQgdGhlIHN0cmVhbSAoSXNzdWUgIzIzMzYpYCxcbiAgICApO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb21tZW50cyA9IGF3YWl0IGZldGNoTWFya2VyQ29tbWVudHMoXG4gICAgICByZXBvLFxuICAgICAgdHJhY2tpbmdJc3N1ZSxcbiAgICAgIFNUUkVBTV9IT0xERVJfTUFSS0VSX1BSRUZJWCxcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICk7XG4gICAgY29uc3QgbGl2ZSA9IGhvbGRlck1hcmtlcnNGb3IoY29tbWVudHMsIGtleSwgdHJ1c3RlZEF1dGhvcnMpLmF0KC0xKTtcbiAgICByZXR1cm4gbGl2ZSA9PT0gdW5kZWZpbmVkXG4gICAgICA/IG51bGxcbiAgICAgIDogeyBob3N0OiBsaXZlLm1hcmtlci5ob3N0LCBhdEVwb2NoOiBsaXZlLm1hcmtlci5hdEVwb2NoIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZyhcbiAgICAgIGBbc3RyZWFtX2hvbGRlcl0gcmVwbz0ke3JlcG99IHN0cmVhbT0ke3N0cmVhbUxhYmVsKHN0cmVhbSl9IGAgK1xuICAgICAgICBgaG9sZGVyX3JlYWRfZmFpbGVkIGlzc3VlPSMke3RyYWNraW5nSXNzdWV9IGVycm9yPSR7ZGVzY3JpYmUoZXJyKX0gYCArXG4gICAgICAgIGDigJQgcHJvY2VlZGluZyB3aXRoIHRoZSBjbGFpbSBhcyBpZiBubyBob3N0IGhlbGQgdGhlIHN0cmVhbSBgICtcbiAgICAgICAgYChJc3N1ZSAjMjMzNilgLFxuICAgICk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqIFdoYXQgdGhlIGFmZmluaXR5IGNoZWNrIGRlY2lkZWQgYWJvdXQgb25lIGNsYWltLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTdHJlYW1BZmZpbml0eURlY2lzaW9uIHtcbiAgLyoqIFdhaXQgZm9yIHRoZSBob2xkZXIg4oCUIHRoaXMgaG9zdCBtdXN0IG5vdCBjbGFpbSB0aGUgaXNzdWUgeWV0LiAqL1xuICBkZWZlcjogYm9vbGVhbjtcbiAgLyoqIEhvbGRlciBob3N0LCBpbiBkaXNwbGF5IGZvcm0uIEFic2VudCB3aGVuIG5vIGhvbGRlciBhcHBsaWVzLiAqL1xuICBob2xkZXJIb3N0Pzogc3RyaW5nO1xuICAvKiogV2hvbGUgc2Vjb25kcyBvZiBncmFjZSBsZWZ0LiBQcmVzZW50IG9ubHkgd2hlbiBkZWZlcnJpbmcuICovXG4gIHNlY29uZHNMZWZ0PzogbnVtYmVyO1xuICAvKiogVGhlIGdyYWNlIHJhbiBvdXQ6IHRoaXMgaG9zdCB0YWtlcyB0aGUgc3RyZWFtIGFuZCBzdGFydHMgaXQgYWZyZXNoLiAqL1xuICBncmFjZUV4cGlyZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIERlY2lkZSB3aGV0aGVyIHRoaXMgaG9zdCB3YWl0cyBmb3IgdGhlIHJlY29yZGVkIGhvbGRlci5cbiAqXG4gKiBQdXJlIOKAlCB0aGUgY2xvY2ssIHRoZSBob2xkZXIgYW5kIHRoaXMgaG9zdCdzIGZpcnN0IHNpZ2h0aW5nIGFyZSBhbGwgaW5wdXRzLlxuICogSG9zdHMgYXJlIGNvbXBhcmVkIG9uIHRoZSAqKmluc3RhbGwqKiBwYXJ0IG9mIHRoZSBtYWNoaW5lIGlkIOKAlCB0aGVcbiAqIHBlcnNpc3RlZCB1dWlkLCBub3QgdGhlIHBlci1sYXVuY2ggY29udGFpbmVyIGhvc3RuYW1lIOKAlCBzbyB0d28gc2xvdHMgb24gb25lXG4gKiBtYWNoaW5lLCBhbmQgdGhlIHNhbWUgbWFjaGluZSBhZnRlciBhIHJlbGF1bmNoLCBzaGFyZSBpdHMgdHJhbnNjcmlwdCByYXRoZXJcbiAqIHRoYW4gZGVmZXJyaW5nIHRvIGVhY2ggb3RoZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWNpZGVTdHJlYW1BZmZpbml0eShvcHRpb25zOiB7XG4gIGhvbGRlcjogU3RyZWFtSG9sZGVyIHwgbnVsbDtcbiAgLyoqIFRoaXMgaG9zdCdzIG1hY2hpbmUgaWQgb3IgaG9zdCBpZC4gKi9cbiAgdGhpc0hvc3Q6IHN0cmluZztcbiAgLyoqIEVwb2NoIHNlY29uZHMgdGhpcyBob3N0IGZpcnN0IHNhdyB0aGUgaXNzdWUgYXMgZWxpZ2libGUuICovXG4gIGVsaWdpYmxlU2luY2VTZWNvbmRzOiBudW1iZXI7XG4gIG5vd1NlY29uZHM6IG51bWJlcjtcbn0pOiBTdHJlYW1BZmZpbml0eURlY2lzaW9uIHtcbiAgY29uc3QgeyBob2xkZXIsIHRoaXNIb3N0LCBlbGlnaWJsZVNpbmNlU2Vjb25kcywgbm93U2Vjb25kcyB9ID0gb3B0aW9ucztcbiAgaWYgKGhvbGRlciA9PT0gbnVsbCkgcmV0dXJuIHsgZGVmZXI6IGZhbHNlIH07XG5cbiAgY29uc3QgaG9sZGVySG9zdCA9IGhvc3RGcm9tTWFjaGluZUlkKGhvbGRlci5ob3N0KTtcbiAgaWYgKHNhbWVJbnN0YWxsKGhvbGRlci5ob3N0LCB0aGlzSG9zdCkpIHJldHVybiB7IGRlZmVyOiBmYWxzZSB9O1xuXG4gIC8vIFRoZSBob2xkZXIncyBoZWFkIHN0YXJ0IGlzIG92ZXIgb25jZSBFSVRIRVIgY2xvY2sgc2F5cyBzbzogdGhpcyBwcm9jZXNzXG4gIC8vIGhhcyB3YWl0ZWQgb3V0IHRoZSBncmFjZSwgb3IgdGhlIGhvbGRpbmcgcnVuIGZpbmlzaGVkIGxvbmcgZW5vdWdoIGFnbyBieVxuICAvLyB0aGUgbWFya2VyJ3Mgb3duIHN0YW1wLiBUaGUgc2Vjb25kIGlzIHdoYXQgc3Vydml2ZXMgYSByZXN0YXJ0LlxuICBjb25zdCBob2xkZXJBZ2UgPSBub3dTZWNvbmRzIC0gaG9sZGVyLmF0RXBvY2g7XG4gIGlmIChob2xkZXJBZ2UgPj0gU1RSRUFNX0hPTERFUl9IRUFEX1NUQVJUX1NFQ09ORFMpIHtcbiAgICByZXR1cm4geyBkZWZlcjogZmFsc2UsIGhvbGRlckhvc3QsIGdyYWNlRXhwaXJlZDogdHJ1ZSB9O1xuICB9XG5cbiAgY29uc3QgZWxhcHNlZCA9IE1hdGgubWF4KDAsIG5vd1NlY29uZHMgLSBlbGlnaWJsZVNpbmNlU2Vjb25kcyk7XG4gIGNvbnN0IHNlY29uZHNMZWZ0ID0gU1RSRUFNX0FGRklOSVRZX0dSQUNFX1NFQ09ORFMgLSBlbGFwc2VkO1xuICBpZiAoc2Vjb25kc0xlZnQgPD0gMCkgcmV0dXJuIHsgZGVmZXI6IGZhbHNlLCBob2xkZXJIb3N0LCBncmFjZUV4cGlyZWQ6IHRydWUgfTtcbiAgcmV0dXJuIHsgZGVmZXI6IHRydWUsIGhvbGRlckhvc3QsIHNlY29uZHNMZWZ0IH07XG59XG5cbi8vIFRoZSBwZXItaW5zdGFsbCBVVUlEIGEgbWFjaGluZSBpZCBlbmRzIHdpdGggKGBtYWNoaW5lX2lkLnRzYCkuXG5jb25zdCBJTlNUQUxMX1VVSURfUkUgPVxuICAvLShbMC05YS1mXXs4fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXsxMn0pJC9pO1xuXG4vKipcbiAqIFRoZSBwYXJ0IG9mIGEgbWFjaGluZSBpZCB0aGF0IGlkZW50aWZpZXMgdGhlICoqaW5zdGFsbCoqLCBub3QgdGhlIGxhdW5jaC5cbiAqXG4gKiBBIG1hY2hpbmUgaWQgaXMgYHtob3N0bmFtZX0te3V1aWR9YC4gVGhlIHV1aWQgaXMgcGVyc2lzdGVkIGluIHRoZSB3b3JrXG4gKiBkaXJlY3RvcnkgYW5kIFwic3Vydml2ZXMgaG9zdG5hbWUgY2hhbmdlc1wiOyB0aGUgaG9zdG5hbWUgaXMgdGhlIGNvbnRhaW5lcidzXG4gKiDigJQgYHZpYmUtY29kZXItPHJhbmRvbT5gLCBuZXcgb24gZXZlcnkgaG91cmx5IGxhdW5jaC4gQ29tcGFyaW5nIG9uIHRoZVxuICogaG9zdG5hbWUgbWVhbnQgYSBob2xkZXIgbmV2ZXIgcmVjb2duaXNlZCBpdHNlbGYgYWZ0ZXIgaXRzIG5leHQgbGF1bmNoIGFuZFxuICogZGVmZXJyZWQgdG8gaXRzIG93biBwYXN0IG5hbWUuIE51bGwgd2hlbiB0aGUgaWQgY2FycmllcyBubyB1dWlkLlxuICovXG5mdW5jdGlvbiBpbnN0YWxsRnJvbU1hY2hpbmVJZChtYWNoaW5lSWQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gSU5TVEFMTF9VVUlEX1JFLmV4ZWMobWFjaGluZUlkKT8uWzFdPy50b0xvd2VyQ2FzZSgpID8/IG51bGw7XG59XG5cbi8qKlxuICogQXJlIHRoZXNlIHR3byBpZHMgdGhlIHNhbWUgaW5zdGFsbD9cbiAqXG4gKiBPbiB0aGUgaW5zdGFsbCB1dWlkIHdoZW4gKipib3RoKiogY2Fycnkgb25lIOKAlCB0aGUgcHJvZHVjdGlvbiBjYXNlLCB3aGVyZVxuICogYm90aCBzaWRlcyBhcmUgZnVsbCBtYWNoaW5lIGlkcy4gQSBjYWxsZXIgdGhhdCBvbmx5IGhhcyBhIGJhcmUgaG9zdCBpZFxuICogY2FycmllcyBubyB1dWlkIHRvIGNvbXBhcmUsIHNvIHRoYXQgcGFpciBmYWxscyBiYWNrIHRvIHRoZSBob3N0bmFtZSwgYXMgdGhlXG4gKiBjb21wYXJpc29uIGFsd2F5cyBkaWQuXG4gKi9cbmZ1bmN0aW9uIHNhbWVJbnN0YWxsKGE6IHN0cmluZywgYjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGluc3RhbGxBID0gaW5zdGFsbEZyb21NYWNoaW5lSWQoYSk7XG4gIGNvbnN0IGluc3RhbGxCID0gaW5zdGFsbEZyb21NYWNoaW5lSWQoYik7XG4gIGlmIChpbnN0YWxsQSAhPT0gbnVsbCAmJiBpbnN0YWxsQiAhPT0gbnVsbCkgcmV0dXJuIGluc3RhbGxBID09PSBpbnN0YWxsQjtcbiAgcmV0dXJuIGhvc3RGcm9tTWFjaGluZUlkKGEpID09PSBob3N0RnJvbU1hY2hpbmVJZChiKTtcbn1cblxuLyoqXG4gKiBUaGUgb25lIGxpbmUgYSBkZWZlcnJhbCBsb2dzIGFuZCByZXBvcnRzLlxuICpcbiAqIEV4cG9ydGVkIHNvIHRoZSBjbGFpbSBwYXRoLCB0aGUgdGVzdHMgYW5kIGEgbG9nIGdyZXAgc2hhcmUgb25lIHdvcmRpbmdcbiAqIHJhdGhlciB0aGFuIHJlLXNwZWxsaW5nIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0U3RyZWFtQWZmaW5pdHlEZWZlcnJhbChcbiAgbGFiZWw6IHN0cmluZyxcbiAgaG9sZGVySG9zdDogc3RyaW5nLFxuICBzZWNvbmRzTGVmdDogbnVtYmVyLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBzdHJlYW0gYWZmaW5pdHk6IGRlZmVycmluZyAke2xhYmVsfSB0byAke2hvbGRlckhvc3R9IGAgK1xuICAgIGAoJHtzZWNvbmRzTGVmdH1zIGxlZnQpYDtcbn1cblxuLyoqXG4gKiBXaGVuIHRoaXMgcHJvY2VzcyBmaXJzdCBzYXcgZWFjaCBpc3N1ZSBhcyBlbGlnaWJsZSwgYW5kIHdoaWNoIGRlZmVycmFscyBpdFxuICogaGFzIGFscmVhZHkgbG9nZ2VkLlxuICpcbiAqIFByb2Nlc3MtbG9jYWwgb24gcHVycG9zZTogdGhlIGdyYWNlIG1lYXN1cmVzICp0aGlzKiBob3N0J3MgcGF0aWVuY2UsIHNvIGl0XG4gKiBtdXN0IG5vdCBiZSByZWFkIGZyb20gYSBtYXJrZXIgYW5vdGhlciBob3N0IHdyb3RlLiBFbnRyaWVzIG9sZGVyIHRoYW5cbiAqIHtAbGluayBTSUdIVElOR19SRVRFTlRJT05fU0VDT05EU30gYXJlIHBydW5lZCwgc28gYSBsb25nLWxpdmVkIHdvcmtlciBjYW5ub3RcbiAqIGdyb3cgdGhlc2Ugd2l0aG91dCBib3VuZC5cbiAqL1xuY29uc3QgZmlyc3RTZWVuQXQgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuY29uc3QgZGVmZXJyYWxMb2dnZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuZnVuY3Rpb24gc2lnaHRpbmdLZXkocmVwbzogc3RyaW5nLCBpc3N1ZU51bWJlcjogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3JlcG99IyR7aXNzdWVOdW1iZXJ9YDtcbn1cblxuZnVuY3Rpb24gcHJ1bmVTaWdodGluZ3Mobm93U2Vjb25kczogbnVtYmVyKTogdm9pZCB7XG4gIGZvciAoY29uc3QgW2tleSwgc2Vlbl0gb2YgZmlyc3RTZWVuQXQpIHtcbiAgICBpZiAobm93U2Vjb25kcyAtIHNlZW4gPiBTSUdIVElOR19SRVRFTlRJT05fU0VDT05EUykge1xuICAgICAgZmlyc3RTZWVuQXQuZGVsZXRlKGtleSk7XG4gICAgICBkZWZlcnJhbExvZ2dlZC5kZWxldGUoa2V5KTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBSZWNvcmQg4oCUIGFuZCByZXR1cm4g4oCUIHdoZW4gdGhpcyBwcm9jZXNzIGZpcnN0IHNhdyBgaXNzdWVOdW1iZXJgIGFzIGVsaWdpYmxlLlxuICogUmVwZWF0ZWQgY2FsbHMgcmV0dXJuIHRoZSBmaXJzdCBzaWdodGluZywgd2hpY2ggaXMgd2hhdCB0aGUgZ3JhY2UgY291bnRzXG4gKiBmcm9tLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm90ZUlzc3VlRWxpZ2libGUoXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgbm93U2Vjb25kczogbnVtYmVyLFxuKTogbnVtYmVyIHtcbiAgcHJ1bmVTaWdodGluZ3Mobm93U2Vjb25kcyk7XG4gIGNvbnN0IGtleSA9IHNpZ2h0aW5nS2V5KHJlcG8sIGlzc3VlTnVtYmVyKTtcbiAgY29uc3Qgc2VlbiA9IGZpcnN0U2VlbkF0LmdldChrZXkpO1xuICBpZiAoc2VlbiAhPT0gdW5kZWZpbmVkKSByZXR1cm4gc2VlbjtcbiAgZmlyc3RTZWVuQXQuc2V0KGtleSwgbm93U2Vjb25kcyk7XG4gIHJldHVybiBub3dTZWNvbmRzO1xufVxuXG4vKiogRm9yZ2V0IGFuIGlzc3VlJ3MgY2xvY2sg4oCUIGl0IGlzIHRoaXMgaG9zdCdzIG5vdywgb3Igbm8gbG9uZ2VyIGRlZmVycmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcmdldElzc3VlRWxpZ2liaWxpdHkoXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbik6IHZvaWQge1xuICBjb25zdCBrZXkgPSBzaWdodGluZ0tleShyZXBvLCBpc3N1ZU51bWJlcik7XG4gIGZpcnN0U2VlbkF0LmRlbGV0ZShrZXkpO1xuICBkZWZlcnJhbExvZ2dlZC5kZWxldGUoa2V5KTtcbn1cblxuLyoqIERyb3AgZXZlcnkgcmVjb3JkZWQgc2lnaHRpbmcuIEZvciB0ZXN0cywgd2hpY2ggbXVzdCBub3Qgc2hhcmUgYSBjbG9jay4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFN0cmVhbUFmZmluaXR5U3RhdGUoKTogdm9pZCB7XG4gIGZpcnN0U2VlbkF0LmNsZWFyKCk7XG4gIGRlZmVycmFsTG9nZ2VkLmNsZWFyKCk7XG59XG5cbi8qKiBBIGRlY2lzaW9uLCBwbHVzIHRoZSBvbmUgbGluZSB0aGUgY2xhaW0gcGF0aCByZXBvcnRzIGl0IHdpdGguICovXG5leHBvcnQgaW50ZXJmYWNlIFN0cmVhbUFmZmluaXR5UmVzdWx0IGV4dGVuZHMgU3RyZWFtQWZmaW5pdHlEZWNpc2lvbiB7XG4gIC8qKiBUaGUgZGVmZXJyYWwgbGluZSwgYXMge0BsaW5rIGZvcm1hdFN0cmVhbUFmZmluaXR5RGVmZXJyYWx9IHJlbmRlcnMgaXQuICovXG4gIGRldGFpbD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBTaG91bGQgdGhpcyBob3N0IHdhaXQgYmVmb3JlIGNsYWltaW5nIGBpc3N1ZU51bWJlcmA/XG4gKlxuICogQ29zdHMgb25lIGBnaCBhcGlgIHJlYWQgb2YgdGhlIG1pbGVzdG9uZSdzIHRyYWNraW5nIGlzc3VlLCBhbmQgKipub3RoaW5nIGF0XG4gKiBhbGwqKiBmb3IgYSBibGFuay1zdHJlYW0gaXNzdWU6IGEgcmVwb3NpdG9yeSdzIGlzc3VlcyB3aXRoIG5vIG1pbGVzdG9uZSBoYXZlXG4gKiBubyBzaGFyZWQgY29udmVyc2F0aW9uLCBlYWNoIGhvc3Qga2VlcHMgaXRzIG93biwgYW5kIHRoZSBhZmZpbml0eSBwYXRoIG5ldmVyXG4gKiBhcHBsaWVzIHRvIHRoZW0uXG4gKlxuICogTmV2ZXIgdGhyb3dzIOKAlCBzZWUgdGhlIG1vZHVsZSBjb21tZW50J3MgZmFpbCBkaXJlY3Rpb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjaGVja1N0cmVhbUFmZmluaXR5KFxuICBvcHRpb25zOiB7XG4gICAgcmVwbzogc3RyaW5nO1xuICAgIGlzc3VlTnVtYmVyOiBudW1iZXI7XG4gICAgLyoqIFRoZSBpc3N1ZSdzIG1pbGVzdG9uZSB0aXRsZTsgYWJzZW50IG9yIGJsYW5rIG1lYW5zIHRoZSBibGFuayBzdHJlYW0uICovXG4gICAgbWlsZXN0b25lVGl0bGU/OiBzdHJpbmc7XG4gICAgLyoqIFRoaXMgaG9zdCdzIG1hY2hpbmUgaWQgKGBnZXRNYWNoaW5lSWRgKSBvciBpdHMgaG9zdCBpZC4gKi9cbiAgICB0aGlzSG9zdDogc3RyaW5nO1xuICAgIC8qKiBDdXJyZW50IGVwb2NoIHNlY29uZHMuIERlZmF1bHRzIHRvIHRoZSB3YWxsIGNsb2NrLiAqL1xuICAgIG5vd1NlY29uZHM/OiBudW1iZXI7XG4gICAgLyoqXG4gICAgICogRHVyYWJsZSB3b3JrIGRpcmVjdG9yeSBob2xkaW5nIHRoZSBzdHJlYW0gcmVjb3Jkcy4gU3VwcGxpZWQgbWVhbnMgYVxuICAgICAqIGhhbmQtb3ZlciBnZW51aW5lbHkgKipzdGFydHMgdGhlIHN0cmVhbSBhZnJlc2gqKjogdGhlIGxvY2FsIHJlY29yZCDigJQgdGhpc1xuICAgICAqIGhvc3QncyBvd24gdHJhbnNjcmlwdCBmcm9tIHdoZW5ldmVyIGl0IGxhc3QgaGVsZCB0aGUgc3RyZWFtLCBub3cgc2V2ZXJhbFxuICAgICAqIGlzc3VlcyBvdXQgb2YgZGF0ZSDigJQgaXMgZHJvcHBlZCByYXRoZXIgdGhhbiByZXN1bWVkIGFzIGlmIGl0IHdlcmVcbiAgICAgKiBjdXJyZW50LiBPbWl0dGVkIG9ubHkgc2tpcHMgdGhhdCBkZWxldGU7IHRoZSBjbGFpbSBpcyB1bmFmZmVjdGVkLlxuICAgICAqL1xuICAgIHdvcmtEaXI/OiBzdHJpbmc7XG4gIH0gJiBTdHJlYW1Ib2xkZXJJbyxcbik6IFByb21pc2U8U3RyZWFtQWZmaW5pdHlSZXN1bHQ+IHtcbiAgY29uc3Qge1xuICAgIHJlcG8sXG4gICAgaXNzdWVOdW1iZXIsXG4gICAgbWlsZXN0b25lVGl0bGUsXG4gICAgdGhpc0hvc3QsXG4gICAgZ2hDb21tYW5kRm4gPSBydW5HaENvbW1hbmQsXG4gICAgdHJ1c3RlZEF1dGhvcnMgPSBbXSxcbiAgICBub3dTZWNvbmRzID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCksXG4gICAgd29ya0RpcixcbiAgICBsb2cgPSAobWVzc2FnZTogc3RyaW5nKSA9PiBjb25zb2xlLndhcm4obWVzc2FnZSksXG4gICAgbG9nSW5mbyA9IChtZXNzYWdlOiBzdHJpbmcpID0+IGNvbnNvbGUuaW5mbyhtZXNzYWdlKSxcbiAgfSA9IG9wdGlvbnM7XG5cbiAgbGV0IHN0cmVhbTogU3RyZWFtSWQ7XG4gIHRyeSB7XG4gICAgc3RyZWFtID0gcmVzb2x2ZVN0cmVhbUlkKHJlcG8sIG1pbGVzdG9uZVRpdGxlKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nKFxuICAgICAgYFtzdHJlYW1faG9sZGVyXSByZXBvPSR7cmVwb30gaXNzdWU9IyR7aXNzdWVOdW1iZXJ9IHN0cmVhbV91bnJlc29sdmVkIGAgK1xuICAgICAgICBgZXJyb3I9JHtkZXNjcmliZShlcnIpfSDigJQgcHJvY2VlZGluZyB3aXRoIHRoZSBjbGFpbSAoSXNzdWUgIzIzMzYpYCxcbiAgICApO1xuICAgIHJldHVybiB7IGRlZmVyOiBmYWxzZSB9O1xuICB9XG4gIGlmIChpc0JsYW5rU3RyZWFtKHN0cmVhbSkpIHJldHVybiB7IGRlZmVyOiBmYWxzZSB9O1xuXG4gIGNvbnN0IGhvbGRlciA9IGF3YWl0IHJlYWRTdHJlYW1Ib2xkZXIocmVwbywgc3RyZWFtLCB7XG4gICAgZ2hDb21tYW5kRm4sXG4gICAgdHJ1c3RlZEF1dGhvcnMsXG4gICAgbG9nLFxuICB9KTtcbiAgaWYgKGhvbGRlciA9PT0gbnVsbCkgcmV0dXJuIHsgZGVmZXI6IGZhbHNlIH07XG5cbiAgY29uc3QgZGVjaXNpb24gPSBkZWNpZGVTdHJlYW1BZmZpbml0eSh7XG4gICAgaG9sZGVyLFxuICAgIHRoaXNIb3N0LFxuICAgIGVsaWdpYmxlU2luY2VTZWNvbmRzOiBub3RlSXNzdWVFbGlnaWJsZShyZXBvLCBpc3N1ZU51bWJlciwgbm93U2Vjb25kcyksXG4gICAgbm93U2Vjb25kcyxcbiAgfSk7XG4gIGNvbnN0IGxhYmVsID0gc3RyZWFtTGFiZWwoc3RyZWFtKTtcblxuICBpZiAoZGVjaXNpb24uZ3JhY2VFeHBpcmVkKSB7XG4gICAgLy8gVGhlIGNvbnZlcnNhdGlvbiBpcyBvbiB0aGUgb3RoZXIgaG9zdCdzIGRpc2ssIHNvIHRha2luZyB0aGUgc3RyZWFtIG1lYW5zXG4gICAgLy8gb3BlbmluZyBpdCBhZ2FpbiBmcm9tIG5vdGhpbmcuIEFueSByZWNvcmQgdGhpcyBob3N0IHN0aWxsIGhvbGRzIGlzIGl0c1xuICAgIC8vIG93biB0cmFuc2NyaXB0IGZyb20gd2hlbiBpdCBsYXN0IGhhZCB0aGUgc3RyZWFtIOKAlCBzdGFsZSBieSBob3dldmVyIG1hbnlcbiAgICAvLyBpc3N1ZXMgdGhlIGhvbGRlciBoYXMgcnVuIHNpbmNlIOKAlCBzbyBpdCBpcyBkcm9wcGVkIHJhdGhlciB0aGFuIHJlc3VtZWRcbiAgICAvLyBhcyB0aG91Z2ggaXQgd2VyZSBjdXJyZW50LCBhbmQgdGhlIGhhbmQtb3ZlciBpcyBzdGF0ZWQgcGxhaW5seS5cbiAgICBpZiAod29ya0RpciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBkZWxldGVTdHJlYW1TZXNzaW9uKHdvcmtEaXIsIHN0cmVhbSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgbG9nKFxuICAgICAgICAgIGBbc3RyZWFtX2hvbGRlcl0gcmVwbz0ke3JlcG99IGlzc3VlPSMke2lzc3VlTnVtYmVyfSBgICtcbiAgICAgICAgICAgIGBzdHJlYW1fcmVzZXRfZmFpbGVkIGVycm9yPSR7ZGVzY3JpYmUoZXJyKX0g4oCUIHRoaXMgaG9zdCBtYXkgYCArXG4gICAgICAgICAgICBgcmVzdW1lIGEgc3RhbGUgdHJhbnNjcmlwdCBmb3IgJHtsYWJlbH0gKElzc3VlICMyMzM2KWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIGxvZ0luZm8oXG4gICAgICBgc3RyZWFtIHNlc3Npb24gcmVzZXQ6IGFmZmluaXR5IGdyYWNlIGV4cGlyZWQg4oCUICR7bGFiZWx9IHdhcyBoZWxkIGJ5IGAgK1xuICAgICAgICBgJHtkZWNpc2lvbi5ob2xkZXJIb3N0fSwgY2xhaW1lZCBvbiB0aGlzIGhvc3QgYWZ0ZXIgYCArXG4gICAgICAgIGAke1NUUkVBTV9BRkZJTklUWV9HUkFDRV9TRUNPTkRTfXMgKElzc3VlICMyMzM2KWAsXG4gICAgKTtcbiAgICBmb3JnZXRJc3N1ZUVsaWdpYmlsaXR5KHJlcG8sIGlzc3VlTnVtYmVyKTtcbiAgICByZXR1cm4gZGVjaXNpb247XG4gIH1cblxuICBpZiAoIWRlY2lzaW9uLmRlZmVyKSB7XG4gICAgZm9yZ2V0SXNzdWVFbGlnaWJpbGl0eShyZXBvLCBpc3N1ZU51bWJlcik7XG4gICAgcmV0dXJuIGRlY2lzaW9uO1xuICB9XG5cbiAgY29uc3QgZGV0YWlsID0gZm9ybWF0U3RyZWFtQWZmaW5pdHlEZWZlcnJhbChcbiAgICBsYWJlbCxcbiAgICBkZWNpc2lvbi5ob2xkZXJIb3N0ID8/IFwidW5rbm93bi1ob3N0XCIsXG4gICAgZGVjaXNpb24uc2Vjb25kc0xlZnQgPz8gU1RSRUFNX0FGRklOSVRZX0dSQUNFX1NFQ09ORFMsXG4gICk7XG4gIGNvbnN0IGtleSA9IHNpZ2h0aW5nS2V5KHJlcG8sIGlzc3VlTnVtYmVyKTtcbiAgaWYgKCFkZWZlcnJhbExvZ2dlZC5oYXMoa2V5KSkge1xuICAgIGRlZmVycmFsTG9nZ2VkLmFkZChrZXkpO1xuICAgIGxvZ0luZm8oXG4gICAgICBgW3N0cmVhbV9ob2xkZXJdIHJlcG89JHtyZXBvfSBpc3N1ZT0jJHtpc3N1ZU51bWJlcn0gJHtkZXRhaWx9IOKAlCBgICtcbiAgICAgICAgYHJldHJpZWQgb24gYSBsYXRlciBzY2FuIChJc3N1ZSAjMjMzNilgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGRldGFpbCB9O1xufVxuXG4vKipcbiAqIFJlY29yZCB0aGlzIGhvc3QgYXMgdGhlIGhvbGRlciBvZiB0aGUgc3RyZWFtIGl0cyBydW4ganVzdCBmaW5pc2hlZC5cbiAqXG4gKiBUaGUgcGhhc2UtZmFjaW5nIHdyYXBwZXI6IGEgbm8tb3AgZm9yIGEgcnVuIHRoYXQgam9pbmVkIG5vIHN0cmVhbSwgZm9yIG9uZVxuICogd2hvc2Ugam9pbiByZWNvcmRlZCBubyBob3N0LCBhbmQgZm9yIHRoZSBibGFuayBzdHJlYW0uIE5ldmVyIHRocm93cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlY29yZFN0cmVhbUhvbGRlckZvclJ1bihcbiAgb3B0aW9uczoge1xuICAgIGpvaW5lZDogeyBzdHJlYW06IFN0cmVhbUlkOyBob2xkZXJIb3N0Pzogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gICAgbm93U2Vjb25kcz86IG51bWJlcjtcbiAgfSAmIFN0cmVhbUhvbGRlcklvLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHsgam9pbmVkIH0gPSBvcHRpb25zO1xuICBpZiAoIWpvaW5lZD8uaG9sZGVySG9zdCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB7IGpvaW5lZDogX2pvaW5lZCwgLi4uaW8gfSA9IG9wdGlvbnM7XG4gIHJldHVybiBhd2FpdCB3cml0ZVN0cmVhbUhvbGRlcih7XG4gICAgLi4uaW8sXG4gICAgcmVwbzogam9pbmVkLnN0cmVhbS5yZXBvLFxuICAgIHN0cmVhbTogam9pbmVkLnN0cmVhbSxcbiAgICBob3N0OiBqb2luZWQuaG9sZGVySG9zdCxcbiAgfSk7XG59XG5cbi8qKiBBbiBlcnJvcidzIG1lc3NhZ2UsIGZvciBhIGxvZyBsaW5lLiAqL1xuZnVuY3Rpb24gZGVzY3JpYmUoZXJyOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrREMsR0FFRCxTQUFTLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FBUyxZQUFZLFFBQVEsY0FBYztBQUMzQyxTQUFTLGlCQUFpQixRQUFRLHlCQUF5QjtBQUMzRCxTQUFTLG1CQUFtQixRQUFRLDBCQUEwQjtBQUM5RCxTQUNFLGtCQUFrQixFQUNsQixtQkFBbUIsUUFFZCw0QkFBNEI7QUFDbkMsU0FDRSxhQUFhLEVBQ2IsZUFBZSxFQUVmLFNBQVMsRUFDVCxXQUFXLFFBQ04sdUJBQXVCO0FBRTlCOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLE1BQU0sZ0NBQWdDLElBQUk7QUFFakQ7Ozs7Ozs7Ozs7Ozs7O0NBY0MsR0FDRCxPQUFPLE1BQU0sbUNBQW1DLGdDQUM5QyxFQUFFO0FBRUo7Ozs7Q0FJQyxHQUNELE9BQU8sTUFBTSw4QkFBOEIscUJBQXFCO0FBRWhFLGlFQUFpRSxHQUNqRSxNQUFNLDZCQUE2QixnQ0FBZ0M7QUFnQm5FOzs7Ozs7Q0FNQyxHQUNELE1BQU0sbUJBQW1CLElBQUksT0FDM0IsQ0FBQyxRQUFRLEVBQUUsNEJBQTRCLDRCQUE0QixDQUFDLEdB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
// denoCacheMetadata=9913228375636199240,15284844323979976860