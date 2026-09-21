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
 */

import { isFleetAuthor } from "./fleet_authors.ts";
import { runGhCommand } from "./github.ts";
import { hostFromMachineId } from "./heartbeat_storage.ts";
import { deleteStreamSession } from "./resume_state_store.ts";
import {
  deleteIssueComment,
  fetchMarkerComments,
  type MarkerComment,
} from "./marker_comment_pages.ts";
import {
  isBlankStream,
  resolveStreamId,
  type StreamId,
  streamKey,
  streamLabel,
} from "./stream_identity.ts";

/**
 * How long a non-holder waits before claiming a milestone stream's issue.
 *
 * Ten scans at the 30-second default — long enough for a holder finishing one
 * sub-issue to pick up the next, short enough that a host that has genuinely
 * gone away costs the milestone five minutes and not a cycle.
 */
export const STREAM_AFFINITY_GRACE_SECONDS = 300;

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
 */
export const STREAM_HOLDER_HEAD_START_SECONDS = STREAM_AFFINITY_GRACE_SECONDS *
  3;

/**
 * Marker name, and the `--jq test()` pattern the comment read filters on.
 *
 * Plain `[a-z-]`, so it is its own regex and needs no escaping.
 */
export const STREAM_HOLDER_MARKER_PREFIX = "vibe-stream-holder";

/** How long a first-sighting entry is kept before it is pruned. */
const SIGHTING_RETENTION_SECONDS = STREAM_AFFINITY_GRACE_SECONDS * 4;

/** The host that last ran a stream, as its marker records it. */
export interface StreamHolder {
  /** Machine id of the holder, as {@link StreamHolderMarker} recorded it. */
  host: string;
  /** Epoch seconds the holding run finished at. */
  atEpoch: number;
}

/** A parsed holder marker, with the stream it belongs to. */
export interface StreamHolderMarker extends StreamHolder {
  /** {@link streamKey} of the stream this marker holds. */
  streamKey: string;
}

/**
 * The marker, in full.
 *
 * Both fields are written through {@link sanitiseField}, so neither can carry
 * whitespace or the `-->` that would end the comment early — the pattern is
 * therefore anchored on character classes rather than a lazy `.*?`.
 */
const HOLDER_MARKER_RE = new RegExp(
  `<!--\\s*${STREAM_HOLDER_MARKER_PREFIX}\\s+stream=([A-Za-z0-9._-]+)` +
    `\\s+host=([A-Za-z0-9._-]+)\\s+at=(\\d{1,15})\\s*-->`,
  "u",
);

/** The leading `#<N>` of a planning milestone's title. */
const MILESTONE_PARENT_RE = /^#(\d+)\b/u;

/** Reduce a field to characters that cannot break the marker. */
function sanitiseField(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/** Render the holder marker for `streamKey`. */
export function formatStreamHolderMarker(
  key: string,
  host: string,
  atEpoch: number,
): string {
  return `<!-- ${STREAM_HOLDER_MARKER_PREFIX} stream=${sanitiseField(key)} ` +
    `host=${sanitiseField(host)} at=${Math.max(0, Math.floor(atEpoch))} -->`;
}

/** The holder marker in `body`, or null when it carries none. */
export function parseStreamHolderMarker(
  body: string,
): StreamHolderMarker | null {
  const match = HOLDER_MARKER_RE.exec(body);
  if (match === null) return null;
  const atEpoch = Number.parseInt(match[3]!, 10);
  if (!Number.isFinite(atEpoch)) return null;
  return { streamKey: match[1]!, host: match[2]!, atEpoch };
}

/** The comment body a holder write posts — the marker, plus a readable line. */
function holderBody(key: string, host: string, atEpoch: number): string {
  return `${formatStreamHolderMarker(key, host, atEpoch)}\n` +
    `Stream affinity: \`${sanitiseField(host)}\` holds this milestone's ` +
    `conversation. Another host claims this stream's next issue after ` +
    `${STREAM_AFFINITY_GRACE_SECONDS}s and starts the conversation afresh ` +
    `(Issue #2336).`;
}

/**
 * The planning issue `stream`'s milestone was created from, or null.
 *
 * Read from the milestone title's `#<N>` head, which
 * `buildPlanningMilestoneTitle` puts there precisely so the parent survives a
 * truncated or renamed descriptive tail. Null for the blank stream — it has no
 * milestone, no holder and no affinity — and for a milestone made by hand with
 * no `#<N>` head.
 */
export function streamTrackingIssue(stream: StreamId): number | null {
  if (isBlankStream(stream)) return null;
  const match = MILESTONE_PARENT_RE.exec((stream.milestoneTitle ?? "").trim());
  if (match === null) return null;
  const number = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Shared options for the two GitHub-facing calls. */
interface StreamHolderIo {
  /** Injected `gh` runner. Defaults to the real one. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Fleet logins whose markers are trusted. A marker is text in a comment body
   * any GitHub user can post, so only a fleet account's marker holds a stream.
   * An empty list disables the filter, matching the stream lock.
   */
  trustedAuthors?: readonly string[];
  /**
   * Sink for a **degraded** outcome — a read or write that did not land, so
   * affinity silently stops applying. Defaults to `console.warn`, because the
   * reader has something to look into.
   */
  log?: (message: string) => void;
  /**
   * Sink for the **expected** path — the countdown, the hand-over, a milestone
   * that simply has no tracking issue. Defaults to `console.info`: nothing is
   * wrong, this is the feature working.
   */
  logInfo?: (message: string) => void;
}

/** Comments of `comments` that this module trusts and that name `key`. */
function holderMarkersFor(
  comments: readonly MarkerComment[],
  key: string,
  trustedAuthors: readonly string[],
): Array<{ comment: MarkerComment; marker: StreamHolderMarker }> {
  const filterByAuthor = trustedAuthors.length > 0;
  const rows: Array<{ comment: MarkerComment; marker: StreamHolderMarker }> =
    [];
  for (const comment of comments) {
    if (filterByAuthor && !isFleetAuthor(comment.author, [...trustedAuthors])) {
      continue;
    }
    const marker = parseStreamHolderMarker(comment.body);
    if (marker === null || marker.streamKey !== key) continue;
    rows.push({ comment, marker });
  }
  // Oldest first, so the last entry is the live marker: newest `at`, and the
  // highest comment id where two runs finished in the same second.
  rows.sort((a, b) =>
    a.marker.atEpoch - b.marker.atEpoch || a.comment.id - b.comment.id
  );
  return rows;
}

/**
 * Record `host` as the holder of `stream`'s conversation.
 *
 * Best-effort and never throws: `false` on a blank stream, a milestone with no
 * resolvable tracking issue, or any `gh` failure — each reported through
 * `log`. Affinity then simply does not apply to that stream, which costs a
 * resume and nothing else.
 */
export async function writeStreamHolder(
  options: {
    repo: string;
    stream: StreamId;
    /** This host's machine id (`getMachineId`) or its host id. */
    host: string;
    nowSeconds?: number;
  } & StreamHolderIo,
): Promise<boolean> {
  const {
    repo,
    stream,
    host,
    ghCommandFn = runGhCommand,
    trustedAuthors = [],
    nowSeconds = Math.floor(Date.now() / 1000),
    log = (message: string) => console.warn(message),
    logInfo = (message: string) => console.info(message),
  } = options;

  const trackingIssue = streamTrackingIssue(stream);
  if (trackingIssue === null) {
    // The blank stream has no holder by design — each host keeps its own — so
    // it is not worth a line. A milestone made by hand in the UI is the
    // feature declining to apply, not a fault: it is stated once per run at
    // INFO, and nothing is degraded by it.
    if (!isBlankStream(stream)) {
      logInfo(
        `[stream_holder] repo=${repo} stream=${streamLabel(stream)} ` +
          `holder_not_recorded — the milestone title carries no \`#<N>\` ` +
          `head, so it has no tracking issue to record the holder on; ` +
          `affinity does not apply to this stream (Issue #2336)`,
      );
    }
    return false;
  }

  let key: string;
  try {
    key = streamKey(stream);
  } catch (err) {
    log(
      `[stream_holder] repo=${repo} holder_not_recorded stream_unresolved ` +
        `error=${describe(err)} (Issue #2336)`,
    );
    return false;
  }

  try {
    const comments = await fetchMarkerComments(
      repo,
      trackingIssue,
      STREAM_HOLDER_MARKER_PREFIX,
      ghCommandFn,
    );
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
        `body=${body}`,
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
      `body=${body}`,
    ]);
    for (const stale of existing.slice(0, -1)) {
      const failure = await deleteIssueComment(
        repo,
        stale.comment.id,
        ghCommandFn,
      );
      if (failure !== null) {
        log(
          `[stream_holder] repo=${repo} stream=${streamLabel(stream)} ` +
            `stale_marker_kept comment=${stale.comment.id} ` +
            `error=${failure.message} — a superseded holder marker could not ` +
            `be removed (Issue #2336)`,
        );
      }
    }
    return true;
  } catch (err) {
    log(
      `[stream_holder] repo=${repo} stream=${streamLabel(stream)} ` +
        `holder_write_failed issue=#${trackingIssue} error=${describe(err)} ` +
        `— the stream's next issue is claimable by any host (Issue #2336)`,
    );
    return false;
  }
}

/**
 * The host holding `stream`'s conversation, or null when none is recorded.
 *
 * Null is also the answer when the read fails — reported through `log` first,
 * because an unread marker must never pass silently as "no holder".
 */
export async function readStreamHolder(
  repo: string,
  stream: StreamId,
  options: StreamHolderIo = {},
): Promise<StreamHolder | null> {
  const {
    ghCommandFn = runGhCommand,
    trustedAuthors = [],
    log = (message: string) => console.warn(message),
  } = options;

  const trackingIssue = streamTrackingIssue(stream);
  if (trackingIssue === null) return null;

  let key: string;
  try {
    key = streamKey(stream);
  } catch (err) {
    log(
      `[stream_holder] repo=${repo} holder_read_failed stream_unresolved ` +
        `error=${describe(err)} — proceeding with the claim as if no host ` +
        `held the stream (Issue #2336)`,
    );
    return null;
  }

  try {
    const comments = await fetchMarkerComments(
      repo,
      trackingIssue,
      STREAM_HOLDER_MARKER_PREFIX,
      ghCommandFn,
    );
    const live = holderMarkersFor(comments, key, trustedAuthors).at(-1);
    return live === undefined
      ? null
      : { host: live.marker.host, atEpoch: live.marker.atEpoch };
  } catch (err) {
    log(
      `[stream_holder] repo=${repo} stream=${streamLabel(stream)} ` +
        `holder_read_failed issue=#${trackingIssue} error=${describe(err)} ` +
        `— proceeding with the claim as if no host held the stream ` +
        `(Issue #2336)`,
    );
    return null;
  }
}

/** What the affinity check decided about one claim. */
export interface StreamAffinityDecision {
  /** Wait for the holder — this host must not claim the issue yet. */
  defer: boolean;
  /** Holder host, in display form. Absent when no holder applies. */
  holderHost?: string;
  /** Whole seconds of grace left. Present only when deferring. */
  secondsLeft?: number;
  /** The grace ran out: this host takes the stream and starts it afresh. */
  graceExpired?: boolean;
}

/**
 * Decide whether this host waits for the recorded holder.
 *
 * Pure — the clock, the holder and this host's first sighting are all inputs.
 * Hosts are compared on the **install** part of the machine id — the
 * persisted uuid, not the per-launch container hostname — so two slots on one
 * machine, and the same machine after a relaunch, share its transcript rather
 * than deferring to each other.
 */
export function decideStreamAffinity(options: {
  holder: StreamHolder | null;
  /** This host's machine id or host id. */
  thisHost: string;
  /** Epoch seconds this host first saw the issue as eligible. */
  eligibleSinceSeconds: number;
  nowSeconds: number;
}): StreamAffinityDecision {
  const { holder, thisHost, eligibleSinceSeconds, nowSeconds } = options;
  if (holder === null) return { defer: false };

  const holderHost = hostFromMachineId(holder.host);
  if (sameInstall(holder.host, thisHost)) return { defer: false };

  // The holder's head start is over once EITHER clock says so: this process
  // has waited out the grace, or the holding run finished long enough ago by
  // the marker's own stamp. The second is what survives a restart.
  const holderAge = nowSeconds - holder.atEpoch;
  if (holderAge >= STREAM_HOLDER_HEAD_START_SECONDS) {
    return { defer: false, holderHost, graceExpired: true };
  }

  const elapsed = Math.max(0, nowSeconds - eligibleSinceSeconds);
  const secondsLeft = STREAM_AFFINITY_GRACE_SECONDS - elapsed;
  if (secondsLeft <= 0) return { defer: false, holderHost, graceExpired: true };
  return { defer: true, holderHost, secondsLeft };
}

// The per-install UUID a machine id ends with (`machine_id.ts`).
const INSTALL_UUID_RE =
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The part of a machine id that identifies the **install**, not the launch.
 *
 * A machine id is `{hostname}-{uuid}`. The uuid is persisted in the work
 * directory and "survives hostname changes"; the hostname is the container's
 * — `vibe-coder-<random>`, new on every hourly launch. Comparing on the
 * hostname meant a holder never recognised itself after its next launch and
 * deferred to its own past name. Null when the id carries no uuid.
 */
export function installFromMachineId(machineId: string): string | null {
  return INSTALL_UUID_RE.exec(machineId)?.[1]?.toLowerCase() ?? null;
}

/**
 * Are these two ids the same install?
 *
 * On the install uuid when **both** carry one — the production case, where
 * both sides are full machine ids. A caller that only has a bare host id
 * carries no uuid to compare, so that pair falls back to the hostname, as the
 * comparison always did.
 */
function sameInstall(a: string, b: string): boolean {
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
 */
export function formatStreamAffinityDeferral(
  label: string,
  holderHost: string,
  secondsLeft: number,
): string {
  return `stream affinity: deferring ${label} to ${holderHost} ` +
    `(${secondsLeft}s left)`;
}

/**
 * When this process first saw each issue as eligible, and which deferrals it
 * has already logged.
 *
 * Process-local on purpose: the grace measures *this* host's patience, so it
 * must not be read from a marker another host wrote. Entries older than
 * {@link SIGHTING_RETENTION_SECONDS} are pruned, so a long-lived worker cannot
 * grow these without bound.
 */
const firstSeenAt = new Map<string, number>();
const deferralLogged = new Set<string>();

function sightingKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function pruneSightings(nowSeconds: number): void {
  for (const [key, seen] of firstSeenAt) {
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
 */
export function noteIssueEligible(
  repo: string,
  issueNumber: number,
  nowSeconds: number,
): number {
  pruneSightings(nowSeconds);
  const key = sightingKey(repo, issueNumber);
  const seen = firstSeenAt.get(key);
  if (seen !== undefined) return seen;
  firstSeenAt.set(key, nowSeconds);
  return nowSeconds;
}

/** Forget an issue's clock — it is this host's now, or no longer deferred. */
export function forgetIssueEligibility(
  repo: string,
  issueNumber: number,
): void {
  const key = sightingKey(repo, issueNumber);
  firstSeenAt.delete(key);
  deferralLogged.delete(key);
}

/** Drop every recorded sighting. For tests, which must not share a clock. */
export function resetStreamAffinityState(): void {
  firstSeenAt.clear();
  deferralLogged.clear();
}

/** A decision, plus the one line the claim path reports it with. */
export interface StreamAffinityResult extends StreamAffinityDecision {
  /** The deferral line, as {@link formatStreamAffinityDeferral} renders it. */
  detail?: string;
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
 */
export async function checkStreamAffinity(
  options: {
    repo: string;
    issueNumber: number;
    /** The issue's milestone title; absent or blank means the blank stream. */
    milestoneTitle?: string;
    /** This host's machine id (`getMachineId`) or its host id. */
    thisHost: string;
    /** Current epoch seconds. Defaults to the wall clock. */
    nowSeconds?: number;
    /**
     * Durable work directory holding the stream records. Supplied means a
     * hand-over genuinely **starts the stream afresh**: the local record — this
     * host's own transcript from whenever it last held the stream, now several
     * issues out of date — is dropped rather than resumed as if it were
     * current. Omitted only skips that delete; the claim is unaffected.
     */
    workDir?: string;
  } & StreamHolderIo,
): Promise<StreamAffinityResult> {
  const {
    repo,
    issueNumber,
    milestoneTitle,
    thisHost,
    ghCommandFn = runGhCommand,
    trustedAuthors = [],
    nowSeconds = Math.floor(Date.now() / 1000),
    workDir,
    log = (message: string) => console.warn(message),
    logInfo = (message: string) => console.info(message),
  } = options;

  let stream: StreamId;
  try {
    stream = resolveStreamId(repo, milestoneTitle);
  } catch (err) {
    log(
      `[stream_holder] repo=${repo} issue=#${issueNumber} stream_unresolved ` +
        `error=${describe(err)} — proceeding with the claim (Issue #2336)`,
    );
    return { defer: false };
  }
  if (isBlankStream(stream)) return { defer: false };

  const holder = await readStreamHolder(repo, stream, {
    ghCommandFn,
    trustedAuthors,
    log,
  });
  if (holder === null) return { defer: false };

  const decision = decideStreamAffinity({
    holder,
    thisHost,
    eligibleSinceSeconds: noteIssueEligible(repo, issueNumber, nowSeconds),
    nowSeconds,
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
        log(
          `[stream_holder] repo=${repo} issue=#${issueNumber} ` +
            `stream_reset_failed error=${describe(err)} — this host may ` +
            `resume a stale transcript for ${label} (Issue #2336)`,
        );
      }
    }
    logInfo(
      `stream session reset: affinity grace expired — ${label} was held by ` +
        `${decision.holderHost}, claimed on this host after ` +
        `${STREAM_AFFINITY_GRACE_SECONDS}s (Issue #2336)`,
    );
    forgetIssueEligibility(repo, issueNumber);
    return decision;
  }

  if (!decision.defer) {
    forgetIssueEligibility(repo, issueNumber);
    return decision;
  }

  const detail = formatStreamAffinityDeferral(
    label,
    decision.holderHost ?? "unknown-host",
    decision.secondsLeft ?? STREAM_AFFINITY_GRACE_SECONDS,
  );
  const key = sightingKey(repo, issueNumber);
  if (!deferralLogged.has(key)) {
    deferralLogged.add(key);
    logInfo(
      `[stream_holder] repo=${repo} issue=#${issueNumber} ${detail} — ` +
        `retried on a later scan (Issue #2336)`,
    );
  }
  return { ...decision, detail };
}

/**
 * Record this host as the holder of the stream its run just finished.
 *
 * The phase-facing wrapper: a no-op for a run that joined no stream, for one
 * whose join recorded no host, and for the blank stream. Never throws.
 */
export async function recordStreamHolderForRun(
  options: {
    joined: { stream: StreamId; holderHost?: string } | undefined;
    nowSeconds?: number;
  } & StreamHolderIo,
): Promise<boolean> {
  const { joined } = options;
  if (!joined?.holderHost) return false;
  const { joined: _joined, ...io } = options;
  return await writeStreamHolder({
    ...io,
    repo: joined.stream.repo,
    stream: joined.stream,
    host: joined.holderHost,
  });
}

/** An error's message, for a log line. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
