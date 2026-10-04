/**
 * Conflict-redo pickup ordering (Issue #3034, parent #3013).
 *
 * `conflict_abandon_restart.ts` closes an exhausted, conflicting PR and
 * re-queues its originating issue so the fleet raises a fresh PR off the
 * current base tip. Until the fresh PR lands, that issue sits in the pickup
 * queue indistinguishable from any other candidate — but it is not: its
 * earlier PR was abandoned only because it conflicted, and every pass it
 * waits lets the base move further and makes the next attempt likelier to
 * conflict too. This module reads the issue's own restart marker back off
 * its comment thread and flags it, so that selection (`issue_priority.ts`)
 * can make it the **next** pickup in its repository rather than waiting
 * behind ordinary candidates.
 *
 * **The flag only re-orders; it never admits or blocks a candidate.** A
 * lookup failure, an unparseable marker, or a marker an outsider planted
 * therefore all fail towards "not a redo" — the issue simply falls back to
 * ordinary ordering, which is harmless. Every failure is still logged, never
 * swallowed silently, since a reader diagnosing why ordering looks the way it
 * does needs to see it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  carriesRestartMarker,
  restartMarkerPrNumbers,
} from "./conflict_abandon_restart.ts";
import { partitionConflictComments } from "./conflict_marker_trust.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { prTitleReferencesIssue } from "./pr_title_issue_ref.ts";
import type { IssueCache } from "./issue_cache.ts";

/** The latest fleet-authored restart claim on an issue. */
export interface RestartClaim {
  /** ISO 8601 `created_at` of the marker comment. */
  restartedAt: string;
  /** The abandoned PR the marker names, or null when unparseable. */
  prNumber: number | null;
}

/**
 * The most recent restart claim a trusted (fleet) comment makes on an issue.
 *
 * Only `.trusted` comments count (Issue #1247) — an outsider's marker is
 * ignored outright, not merely discounted. A comment whose `created_at`
 * cannot be parsed is skipped rather than treated as the oldest or newest,
 * since neither guess is a fact the caller can act on.
 */
export function latestTrustedRestartClaim(
  comments: readonly unknown[],
  trustedAuthors: readonly string[],
): RestartClaim | null {
  const trusted = partitionConflictComments(comments, trustedAuthors).trusted;
  let latest: RestartClaim | null = null;
  let latestMs = -Infinity;

  for (const raw of trusted) {
    if (!carriesRestartMarker(raw)) continue;
    const createdAt = (raw as { created_at?: unknown }).created_at;
    if (typeof createdAt !== "string") continue;
    const ms = Date.parse(createdAt);
    if (Number.isNaN(ms)) continue;
    if (ms <= latestMs) continue;
    const prNumber = restartMarkerPrNumbers([raw])[0] ?? null;
    latest = { restartedAt: createdAt, prNumber };
    latestMs = ms;
  }

  return latest;
}

/**
 * Whether an issue's restart claim is still pending — the redo has not yet
 * raised a new PR.
 *
 * False in either of two cases: the issue already has an open fleet PR (the
 * redo has already raised its PR, so there is nothing left to re-order), or
 * a closed PR
 * referencing the issue was raised *after* the restart — PR numbers are
 * monotonic per repository, so a closed PR numbered above the abandoned one
 * proves a fresh PR already came and went. The abandoned PR's own number
 * matches the claim exactly and does not disqualify it — that is the PR the
 * claim itself abandoned, not evidence the redo happened.
 */
export function isPendingConflictRedo(
  claim: RestartClaim,
  issueNumber: number,
  openPRs: readonly { number: number; title: string }[],
  closedPRs: readonly { number: number; title: string }[],
): boolean {
  const hasOpenFleetPr = openPRs.some((pr) =>
    prTitleReferencesIssue(pr.title, issueNumber)
  );
  if (hasOpenFleetPr) return false;

  if (claim.prNumber !== null) {
    const redoAlreadyRaised = closedPRs.some((pr) =>
      pr.number > claim.prNumber! &&
      prTitleReferencesIssue(pr.title, issueNumber)
    );
    if (redoAlreadyRaised) return false;
  }

  return true;
}

/** What {@link classifyConflictRedo} needs to decide one issue. */
export interface ConflictRedoLookup {
  repo: string;
  issue: { number: number; updatedAt?: string };
  openPRs: readonly { number: number; title: string }[];
  closedPRs: readonly { number: number; title: string }[];
  /** Fleet logins whose restart markers count. */
  trustedAuthors: readonly string[];
  ghFn: (args: string[]) => Promise<string>;
  /** Optional cache; entries are reused only while the issue's updatedAt is unchanged. */
  cache?: IssueCache;
  /** Failure sink; defaults to console.error. */
  log?: (message: string) => void;
}

/** Cache key prefix for a restart-claim lookup (Issue #3034). */
const CACHE_KEY_PREFIX = "conflict_redo_claim_v1_";

/** The shape {@link classifyConflictRedo} writes to and reads from the cache. */
interface CachedClaimPayload {
  updatedAt: string;
  claim: RestartClaim | null;
}

/** Whether a value read back off disk is a usable {@link CachedClaimPayload}. */
function isCachedClaimPayload(value: unknown): value is CachedClaimPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as { updatedAt?: unknown; claim?: unknown };
  if (typeof payload.updatedAt !== "string") return false;
  if (payload.claim === null) return true;
  if (typeof payload.claim !== "object") return false;
  const claim = payload.claim as { restartedAt?: unknown; prNumber?: unknown };
  return typeof claim.restartedAt === "string" &&
    (claim.prNumber === null || typeof claim.prNumber === "number");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify one issue candidate as a pending conflict redo, for pickup
 * ordering (Issue #3034).
 *
 * The comment-thread lookup is cached, keyed on the issue's own
 * `updatedAt` — a cached claim is reused only while nothing about the issue
 * has changed since it was computed. The open/closed PR check is always
 * evaluated live, since PRs come and go independently of the issue itself.
 *
 * Never throws: a fetch or parse failure is logged and read as "not a redo",
 * since this flag only re-orders and never admits or blocks a candidate.
 */
export async function classifyConflictRedo(
  lookup: ConflictRedoLookup,
): Promise<{ restartedAt: string } | undefined> {
  const { repo, issue, openPRs, closedPRs, trustedAuthors, ghFn } = lookup;
  const log = lookup.log ?? ((message: string) => console.error(message));
  const cacheKey = `${CACHE_KEY_PREFIX}${issue.number}`;
  const updatedAt = issue.updatedAt;

  let claim: RestartClaim | null = null;
  let cacheHit = false;

  if (
    lookup.cache !== undefined && typeof updatedAt === "string" &&
    updatedAt.length > 0
  ) {
    const cached = await lookup.cache.read<unknown>(repo, cacheKey);
    if (isCachedClaimPayload(cached) && cached.updatedAt === updatedAt) {
      claim = cached.claim;
      cacheHit = true;
    }
  }

  if (!cacheHit) {
    try {
      const comments = await fetchIssueCommentPages(repo, issue.number, ghFn);
      claim = latestTrustedRestartClaim(comments, trustedAuthors);
    } catch (error) {
      log(
        `[conflict-redo] comment lookup failed for ${repo}#${issue.number}: ` +
          `${errorMessage(error)} — ordered as an ordinary candidate`,
      );
      return undefined;
    }

    if (
      lookup.cache !== undefined && typeof updatedAt === "string" &&
      updatedAt.length > 0
    ) {
      const payload: CachedClaimPayload = { updatedAt, claim };
      await lookup.cache.write(repo, cacheKey, payload);
    }
  }

  if (claim === null) return undefined;
  if (!isPendingConflictRedo(claim, issue.number, openPRs, closedPRs)) {
    return undefined;
  }
  return { restartedAt: claim.restartedAt };
}
