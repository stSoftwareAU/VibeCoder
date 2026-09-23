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
 */

import {
  CLAIM_MARKER_PREFIX,
  findLiveHeartbeatMarker,
  RECENT_CLAIM_WINDOW_MS,
} from "./claim_issue.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  hostFromMachineId,
  parseHeartbeatMarker,
} from "./heartbeat_storage.ts";
import {
  isBlankStream,
  resolveStreamId,
  type StreamId,
  streamKey,
  streamLabel,
} from "./stream_identity.ts";

/**
 * How many of the milestone's open issues are read.
 *
 * A milestone with more open sub-issues than this is already far past the
 * point where one conversation is the right shape, and the listing is one
 * API page either way.
 */
export const STREAM_LOCK_ISSUE_LIMIT = 100;

/**
 * How many comments `gh issue list --json comments` returns per issue.
 *
 * The page is gh's, not ours: a thread longer than this is returned
 * truncated, so a marker beyond the page is unread rather than absent.
 */
const COMMENT_PAGE_SIZE = 100;

/** A sibling issue in the same stream is live. */
export interface StreamBusy {
  busy: true;
  /** The sibling issue whose run holds the stream. */
  holderIssue: number;
  /** Host running it — from the heartbeat's machine id, or the claim comment. */
  holderHost: string;
  /** Human label of the stream, as {@link streamLabel} renders it. */
  streamLabel: string;
}

/** Outcome of a stream-lock check. */
export type StreamLockStatus = { busy: false } | StreamBusy;

/** Everything {@link checkMilestoneStreamBusy} needs. */
export interface StreamLockOptions {
  /** `owner/name` the issue lives in. */
  repo: string;
  /** The issue's milestone title; absent or blank means the blank stream. */
  milestoneTitle?: string;
  /** The issue being claimed — never blocks itself. */
  issueNumber: number;
  /** Injected `gh` runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /**
   * Fleet logins whose markers are trusted (`resolveFleetAuthors`). A marker
   * is text in a comment body any GitHub user can post, so only a fleet
   * account's marker holds a stream. An empty list disables the filter,
   * matching `scanHeartbeatMarkers` and the pre-claim check.
   */
  trustedAuthors?: string[];
  /** Current epoch seconds. Defaults to the wall clock. */
  nowSeconds?: number;
}

/** One comment as `gh issue list --json comments` returns it. */
interface ListedComment {
  body?: unknown;
  author?: { login?: unknown } | null;
  createdAt?: unknown;
}

/** One issue as `gh issue list --json number,comments` returns it. */
interface ListedIssue {
  number?: unknown;
  comments?: unknown;
}

/** Host recorded in a claim comment body — `Claimed by \`id\` on host \`name\``. */
const CLAIM_HOST_PATTERN = /on host `([^`]+)`/u;

/** Host shown when neither the claim body nor the author names one. */
const UNKNOWN_HOST = "unknown-host";

/**
 * The one line a stream-busy skip logs, and the detail it reports.
 *
 * Exported so the claim path, the tests and a log grep share one wording
 * rather than re-spelling it.
 */
export function formatStreamBusy(status: StreamBusy): string {
  return `stream busy: ${status.streamLabel} held by #${status.holderIssue} ` +
    `on ${status.holderHost}`;
}

/** Comments of `issue`, narrowed to fleet authors when a trust set was given. */
function fleetComments(
  issue: ListedIssue,
  trustedAuthors: string[],
): ListedComment[] {
  if (!Array.isArray(issue.comments)) return [];
  const filterByAuthor = trustedAuthors.length > 0;
  return (issue.comments as ListedComment[]).filter((comment) => {
    if (!comment || typeof comment.body !== "string") return false;
    if (!filterByAuthor) return true;
    const login = comment.author?.login;
    return isFleetAuthor(
      typeof login === "string" ? login : undefined,
      trustedAuthors,
    );
  });
}

/** The host a claim comment names, falling back to its author. */
function claimHost(comment: ListedComment): string {
  const body = String(comment.body ?? "");
  const named = CLAIM_HOST_PATTERN.exec(body)?.[1];
  if (named !== undefined && named.trim() !== "") return named.trim();
  const login = comment.author?.login;
  return typeof login === "string" && login.trim() !== ""
    ? login.trim()
    : UNKNOWN_HOST;
}

/** The live heartbeat on `comments`, or null when none is beating. */
function liveHeartbeatHost(
  comments: ListedComment[],
  nowSeconds: number,
): string | null {
  const markers = comments
    .map((comment) => parseHeartbeatMarker(String(comment.body)))
    .filter((marker): marker is NonNullable<typeof marker> => marker !== null);
  const live = findLiveHeartbeatMarker(markers, nowSeconds);
  return live === null ? null : hostFromMachineId(live.machineId);
}

/** The host holding a `CLAIM_LOCK` posted inside the recent window, or null. */
function freshClaimHost(
  comments: ListedComment[],
  nowMs: number,
): string | null {
  for (const comment of comments) {
    if (!String(comment.body).includes(CLAIM_MARKER_PREFIX)) continue;
    const createdAt = typeof comment.createdAt === "string"
      ? Date.parse(comment.createdAt)
      : Number.NaN;
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
 */
export async function checkMilestoneStreamBusy(
  options: StreamLockOptions,
): Promise<StreamLockStatus> {
  const {
    repo,
    milestoneTitle,
    issueNumber,
    ghCommandFn,
    trustedAuthors = [],
    nowSeconds = Math.floor(Date.now() / 1000),
  } = options;

  let stream: StreamId;
  try {
    stream = resolveStreamId(repo, milestoneTitle);
  } catch (err) {
    // `resolveStreamId` fails loud on a malformed repository, and rightly —
    // but a claim must not fail with it, so the refusal is reported and the
    // claim proceeds unlocked.
    console.warn(
      `[stream_lock] repo=${repo} issue=#${issueNumber} ` +
        `stream_unresolved error=${
          err instanceof Error ? err.message : String(err)
        } — proceeding with the claim (Issue #2334)`,
    );
    return { busy: false };
  }
  // The blank stream holds no shared conversation, so nothing to lock.
  // Reading the resolved title back is what narrows it for the query below —
  // `resolveStreamId` leaves it undefined for exactly this case.
  const title = stream.milestoneTitle;
  if (isBlankStream(stream) || title === undefined) return { busy: false };
  const label = streamLabel(stream);

  let issues: ListedIssue[];
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
      "number,comments",
    ]);
    const parsed: unknown = JSON.parse(json || "[]");
    if (!Array.isArray(parsed)) {
      throw new Error(`expected a JSON array, got ${typeof parsed}`);
    }
    issues = parsed as ListedIssue[];
  } catch (err) {
    // Fail open, loudly: an unreachable GitHub must not stop the fleet
    // claiming work, but it must never be mistaken for "the stream is free".
    console.warn(
      `[stream_lock] repo=${repo} issue=#${issueNumber} ` +
        `stream_check_failed stream=${label} error=${
          err instanceof Error ? err.message : String(err)
        } — proceeding with the claim (Issue #2334)`,
    );
    return { busy: false };
  }

  // A listing that filled the page may have left live siblings unread, and
  // "unread" must never read as "the stream is free" — say so.
  if (issues.length >= STREAM_LOCK_ISSUE_LIMIT) {
    console.warn(
      `[stream_lock] repo=${repo} issue=#${issueNumber} ` +
        `stream_listing_truncated stream=${label} ` +
        `limit=${STREAM_LOCK_ISSUE_LIMIT} — open issues beyond the limit ` +
        `were not read, so a live sibling among them cannot hold the ` +
        `stream (Issue #2334)`,
    );
  }

  const nowMs = nowSeconds * 1000;
  for (const issue of issues) {
    if (typeof issue?.number !== "number") continue;
    if (issue.number === issueNumber) continue;
    const comments = fleetComments(issue, trustedAuthors);
    if (comments.length === 0) continue;
    // gh returns one page of comments per issue, so a longer thread hides
    // its newest markers — unread, not absent.
    if (
      Array.isArray(issue.comments) &&
      issue.comments.length >= COMMENT_PAGE_SIZE
    ) {
      console.warn(
        `[stream_lock] repo=${repo} issue=#${issueNumber} ` +
          `sibling_comments_truncated sibling=#${issue.number} ` +
          `page=${COMMENT_PAGE_SIZE} — markers past the first page were not ` +
          `read (Issue #2334)`,
      );
    }

    const beating = liveHeartbeatHost(comments, nowSeconds);
    if (beating !== null) {
      return {
        busy: true,
        holderIssue: issue.number,
        holderHost: beating,
        streamLabel: label,
      };
    }

    const claiming = freshClaimHost(comments, nowMs);
    if (claiming !== null) {
      return {
        busy: true,
        holderIssue: issue.number,
        holderHost: claiming,
        streamLabel: label,
      };
    }
  }

  return { busy: false };
}

// ---------------------------------------------------------------------------
// Host-local blank-stream lock (Issue #2335)
// ---------------------------------------------------------------------------

/** A slot's host-local hold on one repository's blank stream. */
export interface BlankStreamHold {
  /** The conversation's key — {@link streamKey} of the blank stream. */
  streamKey: string;
  /** Human label of the stream, as {@link streamLabel} renders it. */
  streamLabel: string;
  /** Slot holding it, for log attribution — `s0`, `s1`, … */
  slotId: string;
  /** The issue the holding slot is running. */
  issueNumber: number;
  /** Epoch-ms the hold was taken. */
  sinceMs: number;
}

/**
 * Outcome of asking for a blank stream.
 *
 * `acquired: true, locked: false` is the milestone case and the fail-open
 * case: the caller may proceed and holds nothing, so its release is a no-op.
 */
export type BlankStreamLockResult =
  | { acquired: true; locked: boolean }
  | { acquired: false; holder: BlankStreamHold };

/** Which stream a lock call is about. */
export interface BlankStreamRef {
  /** `owner/name` the issue lives in. */
  repo: string;
  /** The issue's milestone title; absent or blank means the blank stream. */
  milestoneTitle?: string;
}

/** Everything {@link BlankStreamLockRegistry.tryAcquire} needs. */
export interface BlankStreamAcquireOptions extends BlankStreamRef {
  /** The issue being claimed. */
  issueNumber: number;
  /** Stable slot id, for log attribution. */
  slotId: string;
}

/**
 * The blank stream of `ref`, or `undefined` when it is a milestone stream or
 * an unresolvable repository.
 *
 * Fails open, loudly: `resolveStreamId` throws on a repository that is not
 * `owner/name`, and a lock must never turn a claim into a run failure — but
 * the refusal is reported, never swallowed.
 */
function blankStreamOf(ref: BlankStreamRef): StreamId | undefined {
  let stream: StreamId;
  try {
    stream = resolveStreamId(ref.repo, ref.milestoneTitle);
  } catch (err) {
    console.warn(
      `[stream_lock] repo=${ref.repo} stream_unresolved error=${
        err instanceof Error ? err.message : String(err)
      } — no host-local blank-stream lock is taken (Issue #2335)`,
    );
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
 */
export function formatBlankStreamBusy(hold: BlankStreamHold): string {
  return `stream busy: ${hold.streamLabel} held by slot ${hold.slotId} ` +
    `on #${hold.issueNumber}`;
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
 */
export class BlankStreamLockRegistry {
  readonly #held = new Map<string, BlankStreamHold>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
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
   */
  tryAcquire(options: BlankStreamAcquireOptions): BlankStreamLockResult {
    const stream = blankStreamOf(options);
    if (stream === undefined) return { acquired: true, locked: false };
    const key = streamKey(stream);
    const holder = this.#held.get(key);
    if (holder !== undefined) return { acquired: false, holder };
    this.#held.set(key, {
      streamKey: key,
      streamLabel: streamLabel(stream),
      slotId: options.slotId,
      issueNumber: options.issueNumber,
      sinceMs: this.#now(),
    });
    return { acquired: true, locked: true };
  }

  /**
   * Release a slot's hold on a repository's blank stream.
   *
   * Idempotent, and a no-op for a milestone issue or an unresolvable
   * repository — so the run-end `finally` is safe to call on every path.
   */
  release(ref: BlankStreamRef): void {
    const stream = blankStreamOf(ref);
    if (stream === undefined) return;
    this.#held.delete(streamKey(stream));
  }

  /** The hold on this repository's blank stream, or `undefined` when free. */
  holder(ref: BlankStreamRef): BlankStreamHold | undefined {
    const stream = blankStreamOf(ref);
    return stream === undefined ? undefined : this.#held.get(streamKey(stream));
  }

  /** Number of blank streams held. */
  get size(): number {
    return this.#held.size;
  }
}
