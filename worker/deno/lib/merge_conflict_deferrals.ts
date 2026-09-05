/**
 * Fairness and visibility for the merge-conflict drain's three cheap exits
 * (Issue #1111).
 *
 * `drainConflictingPrs` drops a due PR in three places without touching the PR
 * itself: an issue slot holds the repository (the lease), too little of the
 * cycle remains (the deadline), or the per-cycle cap is full. Each bound is
 * individually correct. Repeated every cycle they are a starvation mechanism
 * with no record — the scan re-derives the same order every pass, so a PR
 * behind a busy repository, or at position 6 of a persistent backlog, is
 * skipped indefinitely and the only trace is a log line on whichever host
 * happened to run.
 *
 * Two things fix that, and both live here:
 *
 * - **A cursor**, persisted on the work volume in the style of
 *   `lane_rotation.ts`. Runs get as few as one lane cycle each, so a run-local
 *   counter would never survive to have an effect. A PR deferred by any of the
 *   three bounds is offered **first** on the next pass.
 * - **A notice.** Once a PR has been deferred across
 *   {@link DEFAULT_DEFERRAL_NOTICE_STREAK} consecutive passes spanning more
 *   than one cooldown window, one comment on the PR names the bound and the
 *   streak. Deduplicated by a marker comment on the PR itself, not by
 *   host-local state, so a restart or a second host cannot post it twice.
 *
 * A deferral is **not** an attempt: nothing was started, so it spends neither
 * the two-attempt budget nor the three-disruption budget the scan enforces.
 * Nothing here writes an attempt marker.
 *
 * Persistence is best-effort in the `lane_rotation.ts` sense: an unreadable or
 * unwritable cursor degrades to "no fairness this cycle", never to a failed
 * pass — but it says so through `warn` rather than going quiet.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_RESOLVED_MARKER,
  DEFAULT_CONFLICT_COOLDOWN_HOURS,
} from "./pr_merge_conflict_scan.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";

/** Cursor file, relative to the work directory. */
export const CONFLICT_DEFERRAL_FILE = ".merge_conflict_deferrals";

/** Marker identifying the once-per-streak starvation notice. */
export const CONFLICT_DEFERRAL_MARKER =
  "<!-- vibe-coder:merge-conflict-deferred";

/** Consecutive deferrals before the PR is told, on itself, that it is starved. */
export const DEFAULT_DEFERRAL_NOTICE_STREAK = 3;

/**
 * How long a streak must have run before the notice is posted.
 *
 * Three passes can be seven minutes apart on a quiet host, which is not
 * starvation — it is a busy cycle. One cooldown window is the same clock the
 * per-PR budget already uses, so "deferred repeatedly, over more than one
 * window" is what earns a comment.
 */
export const DEFAULT_DEFERRAL_NOTICE_MIN_SPAN_MS =
  DEFAULT_CONFLICT_COOLDOWN_HOURS * 3600_000;

/**
 * How long an untouched entry survives in the cursor.
 *
 * A PR that merged, closed or stopped conflicting never clears its own entry,
 * so the file is pruned on every write and cannot grow without bound.
 */
export const DEFERRAL_ENTRY_TTL_MS = 7 * 24 * 3600_000;

/** Which of the drain's bounds deferred the PR. */
export type ConflictDeferralBound = "repo-leased" | "deadline" | "cap";

/** What each bound is, in words, for the comment. */
const BOUND_DESCRIPTIONS: Record<ConflictDeferralBound, string> = {
  "repo-leased": "an issue slot held the repository's shared clone",
  "deadline": "too little of the cycle remained to start a resolution",
  "cap": "the per-cycle cap on conflict resolutions was already full",
};

/** One PR's consecutive-deferral record. */
export interface ConflictDeferralEntry {
  /** Consecutive passes that deferred this PR without attempting it. */
  streak: number;
  /** The bound that deferred it most recently. */
  bound: ConflictDeferralBound;
  /** Epoch milliseconds of the first deferral in this streak. */
  firstDeferredAtMs: number;
  /** Epoch milliseconds of the most recent deferral. */
  lastDeferredAtMs: number;
  /** Streak length at which the notice was posted, when it has been. */
  notifiedAtStreak?: number;
}

/** The persisted cursor: one entry per deferred PR, keyed `owner/repo#number`. */
export type ConflictDeferralState = Map<string, ConflictDeferralEntry>;

/** Filesystem seams, injected so tests never touch a real work directory. */
export interface ConflictDeferralIo {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, data: string) => Promise<void>;
}

const productionIo: ConflictDeferralIo = {
  readTextFile: (path) => Deno.readTextFile(path),
  writeTextFile: (path, data) => Deno.writeTextFile(path, data),
};

/** A bound name, validated back out of persisted JSON. */
function toBound(raw: unknown): ConflictDeferralBound | undefined {
  return raw === "repo-leased" || raw === "deadline" || raw === "cap"
    ? raw
    : undefined;
}

/** A positive finite number, validated back out of persisted JSON. */
function toCount(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.trunc(raw)
    : undefined;
}

/**
 * Parse the cursor file.
 *
 * Total by design: a corrupt file, a truncated write or an entry from an older
 * shape yields an empty (or partial) cursor rather than throwing, because the
 * drain must still run. Entries older than {@link DEFERRAL_ENTRY_TTL_MS} are
 * dropped on the way in.
 */
export function parseConflictDeferrals(
  raw: string,
  nowMs: number,
): ConflictDeferralState {
  const state: ConflictDeferralState = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return state;
  }

  for (
    const [key, value] of Object.entries(parsed as Record<string, unknown>)
  ) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const streak = toCount(entry.streak);
    const bound = toBound(entry.bound);
    const lastDeferredAtMs = toCount(entry.lastDeferredAtMs);
    const firstDeferredAtMs = toCount(entry.firstDeferredAtMs) ??
      lastDeferredAtMs;
    if (
      streak === undefined || bound === undefined ||
      lastDeferredAtMs === undefined || firstDeferredAtMs === undefined
    ) {
      continue;
    }
    if (nowMs - lastDeferredAtMs > DEFERRAL_ENTRY_TTL_MS) continue;
    const notifiedAtStreak = toCount(entry.notifiedAtStreak);
    state.set(key, {
      streak,
      bound,
      firstDeferredAtMs,
      lastDeferredAtMs,
      ...(notifiedAtStreak !== undefined ? { notifiedAtStreak } : {}),
    });
  }
  return state;
}

/** Serialise the cursor, dropping entries that have aged out. */
export function serialiseConflictDeferrals(
  state: ConflictDeferralState,
  nowMs: number,
): string {
  const live: Record<string, ConflictDeferralEntry> = {};
  for (const [key, entry] of state) {
    if (nowMs - entry.lastDeferredAtMs > DEFERRAL_ENTRY_TTL_MS) continue;
    live[key] = entry;
  }
  return JSON.stringify(live);
}

/**
 * Read the cursor for this pass.
 *
 * @param workDir - The work directory; absent means no persistence, so the
 *   drain runs with no fairness cursor rather than failing.
 * @returns The cursor, or an empty one — a first run, a wiped volume and a
 *   corrupt file are all "nothing deferred yet", not a failure.
 */
export async function readConflictDeferrals(
  workDir: string | undefined,
  io: ConflictDeferralIo = productionIo,
  nowMs: number = Date.now(),
): Promise<ConflictDeferralState> {
  if (!workDir) return new Map();
  try {
    return parseConflictDeferrals(
      await io.readTextFile(`${workDir}/${CONFLICT_DEFERRAL_FILE}`),
      nowMs,
    );
  } catch {
    return new Map();
  }
}

/**
 * Persist the cursor for the next pass.
 *
 * Best-effort like `advanceLaneRotation`: a host that cannot write the cursor
 * still drains, it simply cannot be fair across passes — and `warn` says so,
 * so a silently unfair host is diagnosable.
 */
export async function writeConflictDeferrals(
  workDir: string | undefined,
  state: ConflictDeferralState,
  io: ConflictDeferralIo = productionIo,
  nowMs: number = Date.now(),
  warn?: (message: string) => void,
): Promise<void> {
  if (!workDir) return;
  try {
    await io.writeTextFile(
      `${workDir}/${CONFLICT_DEFERRAL_FILE}`,
      serialiseConflictDeferrals(state, nowMs),
    );
  } catch (error) {
    warn?.(
      `[merge-conflict-drain] could not persist the deferral cursor in ` +
        `${workDir}: ${
          error instanceof Error ? error.message : String(error)
        } — the drain keeps running, but a deferred PR will not lead the ` +
        `next pass (Issue #1111)`,
    );
  }
}

/**
 * The keys the next pass should offer first, most starved first.
 *
 * Ordered by streak descending, then by the oldest streak — so the PR that has
 * been waiting longest leads, and a PR deferred once does not overtake one
 * deferred nine times.
 */
export function deferralCursor(
  state: ConflictDeferralState,
): readonly string[] {
  return [...state.entries()]
    .sort(([, a], [, b]) =>
      b.streak - a.streak || a.firstDeferredAtMs - b.firstDeferredAtMs
    )
    .map(([key]) => key);
}

/**
 * Count one deferral against a PR and return its updated entry.
 *
 * The streak is consecutive: {@link clearDeferral} drops the entry the moment
 * the PR is actually attempted.
 */
export function recordDeferral(
  state: ConflictDeferralState,
  key: string,
  bound: ConflictDeferralBound,
  nowMs: number,
): ConflictDeferralEntry {
  const existing = state.get(key);
  const entry: ConflictDeferralEntry = existing === undefined
    ? { streak: 1, bound, firstDeferredAtMs: nowMs, lastDeferredAtMs: nowMs }
    : {
      ...existing,
      streak: existing.streak + 1,
      bound,
      lastDeferredAtMs: nowMs,
    };
  state.set(key, entry);
  return entry;
}

/** End a PR's streak — it was attempted, so it was not starved. */
export function clearDeferral(
  state: ConflictDeferralState,
  key: string,
): void {
  state.delete(key);
}

/**
 * Record that this streak's notice has been posted.
 *
 * Local to the host, and deliberately only half the guard: the marker on the
 * PR is what stops a second host duplicating the comment. This just saves the
 * next pass on *this* host a comment read it already knows the answer to.
 */
export function markDeferralNotified(
  state: ConflictDeferralState,
  key: string,
): void {
  const entry = state.get(key);
  if (entry === undefined) return;
  state.set(key, { ...entry, notifiedAtStreak: entry.streak });
}

/** Bounds on when a streak earns its comment. */
export interface DeferralNoticeBounds {
  /** Consecutive deferrals required. */
  streak?: number;
  /** How long the streak must have run. */
  minSpanMs?: number;
}

/**
 * Whether this streak has earned its one comment.
 *
 * False once the notice has been posted for this streak: the comment is posted
 * once per streak, not once per pass. A streak that ends and starts again
 * clears the entry entirely, so the next one is notified on its own merits.
 */
export function shouldAnnounceDeferral(
  entry: ConflictDeferralEntry,
  bounds: DeferralNoticeBounds = {},
): boolean {
  const {
    streak = DEFAULT_DEFERRAL_NOTICE_STREAK,
    minSpanMs = DEFAULT_DEFERRAL_NOTICE_MIN_SPAN_MS,
  } = bounds;
  if (entry.notifiedAtStreak !== undefined) return false;
  if (entry.streak < streak) return false;
  return entry.lastDeferredAtMs - entry.firstDeferredAtMs >= minSpanMs;
}

/** The comment body that says which bound is starving this PR, and for how long. */
export function buildDeferralNoticeBody(
  prNumber: number,
  entry: ConflictDeferralEntry,
): string {
  const since = new Date(entry.firstDeferredAtMs).toISOString();
  return [
    `${CONFLICT_DEFERRAL_MARKER} n="${entry.streak}" bound="${entry.bound}" -->`,
    `⏳ **Merge-conflict resolution deferred ${entry.streak} times in a row**`,
    "",
    `PR #${prNumber} has been due a conflict-resolution attempt on each of ` +
    `the last ${entry.streak} passes and was not attempted on any of them, ` +
    `since ${since}. The most recent pass deferred it because ` +
    `${BOUND_DESCRIPTIONS[entry.bound]} (\`${entry.bound}\`).`,
    "",
    "No attempt was started, so nothing has been spent: the two-attempt " +
    "budget and the disrupted-attempt budget are both untouched, and the " +
    "branch is exactly as its author pushed it. The PR is now offered first " +
    "on the next pass.",
  ].join("\n");
}

/**
 * Whether a notice for the current streak is already on the thread.
 *
 * Order matters: an attempt or a resolution ends the streak, so a deferral
 * marker posted *before* the most recent attempt belongs to an older streak
 * and must not suppress this one's notice. Reading the PR rather than
 * host-local state is what makes the once-per-streak bound hold across
 * restarts and across hosts.
 *
 * @param comments - Raw comment objects from the GitHub REST API, oldest first.
 */
export function hasOpenDeferralNotice(comments: readonly unknown[]): boolean {
  let open = false;
  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const body = (raw as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    if (
      body.includes(CONFLICT_ATTEMPT_MARKER) ||
      body.includes(CONFLICT_RESOLVED_MARKER)
    ) {
      open = false;
      continue;
    }
    if (body.includes(CONFLICT_DEFERRAL_MARKER)) open = true;
  }
  return open;
}

/** One PR's starvation, as the drain hands it to the announcer. */
export interface ConflictDeferralNotice {
  repo: string;
  prNumber: number;
  entry: ConflictDeferralEntry;
}

/** Seams the announcer needs: the PR's thread, and a way to comment on it. */
export interface ConflictDeferralAnnounceOptions {
  ghCommandFn: (args: string[]) => Promise<string>;
}

/**
 * Post the once-per-streak notice, unless the PR already carries one.
 *
 * @returns True when this call posted the comment.
 * @throws when GitHub cannot be read or written — the caller decides whether a
 *   missing notice should stop the pass, but it is never swallowed here.
 */
export async function announceDeferralStreak(
  notice: ConflictDeferralNotice,
  options: ConflictDeferralAnnounceOptions,
): Promise<boolean> {
  const { repo, prNumber, entry } = notice;
  const comments = await fetchIssueCommentPages(
    repo,
    prNumber,
    options.ghCommandFn,
  );
  if (hasOpenDeferralNotice(comments)) return false;

  await options.ghCommandFn([
    "pr",
    "comment",
    String(prNumber),
    "--repo",
    repo,
    "--body",
    buildDeferralNoticeBody(prNumber, entry),
  ]);
  return true;
}
