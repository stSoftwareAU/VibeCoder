/**
 * The lease that keeps a `pr_review` claim alive without dismissing the
 * review at claim time (Issue #3383).
 *
 * A `commentType: "pr_review"` claim used to dismiss the CHANGES_REQUESTED
 * review the moment it was claimed (Issue #2697) — but that made the claim
 * irreversible before any work happened, so a run that died mid-flight left
 * the review dismissed with nobody having answered it. The claim comment is
 * now a lease instead: it carries a heartbeat timestamp that the processor
 * renews from its own heartbeat while the run is alive, and the review is
 * only dismissed once the run actually retires it. A run that goes silent
 * stops renewing, the lease lapses after {@link PR_REVIEW_CLAIM_LEASE_MS},
 * and the review becomes reclaimable by another host.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { DEFAULT_HEARTBEAT_LIVE_WINDOW_SECONDS } from "./heartbeat_freshness.ts";
import { updateIssueComment } from "./marker_comment_pages.ts";

/** Marks the heartbeat-renewed timestamp line inside a lease claim body. */
export const PR_COMMENT_CLAIM_LEASE_PREFIX = "<!-- PR_COMMENT_CLAIM_LEASE:";

/**
 * How long a lease stays live without a renewal — the fleet's heartbeat live
 * window, since that is exactly how stale a silent run's last beat may be
 * before it is presumed dead.
 */
export const PR_REVIEW_CLAIM_LEASE_MS = DEFAULT_HEARTBEAT_LIVE_WINDOW_SECONDS *
  1000;

/** How often the processor renews the lease on its claimed review. */
export const PR_REVIEW_CLAIM_RENEW_MS = 5 * 60_000;

/** Build the lease line stamped with `nowMs`. */
export function claimLeaseLine(nowMs: number): string {
  return `${PR_COMMENT_CLAIM_LEASE_PREFIX}${new Date(nowMs).toISOString()} -->`;
}

/** True when `body` carries a lease line. */
export function isLeaseClaimBody(body: string): boolean {
  return body.includes(PR_COMMENT_CLAIM_LEASE_PREFIX);
}

/**
 * Replace the lease line in `body` with a fresh one stamped `nowMs`, or
 * append it when the body does not yet carry one.
 *
 * The matcher is written without overlapping quantifiers (`[^\n>]*`, not
 * `.*`) so a hostile body with a long unterminated run of non-`>` text
 * cannot make the regex engine backtrack catastrophically.
 */
export function withRenewedLease(body: string, nowMs: number): string {
  const pattern = /<!-- PR_COMMENT_CLAIM_LEASE:[^\n>]*-->/;
  const line = claimLeaseLine(nowMs);
  if (pattern.test(body)) {
    return body.replace(pattern, line);
  }
  return `${body}\n${line}`;
}

/**
 * True when a claim's last beat — the later of its parseable `createdAt` and
 * `updatedAt` — is inside the lease window of `referenceMs`.
 *
 * Neither timestamp parsing is the fail direction that leaves the claim
 * unprovable, not live, so the work stays claimable rather than wedged
 * behind a lease nobody can show is still being renewed.
 */
export function isLeaseLive(
  claim: { createdAt: string; updatedAt?: string },
  referenceMs: number,
): boolean {
  const createdMs = Date.parse(claim.createdAt);
  const updatedMs = claim.updatedAt !== undefined
    ? Date.parse(claim.updatedAt)
    : NaN;
  const candidates = [createdMs, updatedMs].filter((ms) =>
    !Number.isNaN(ms)
  );
  if (candidates.length === 0) return false;
  const lastBeat = Math.max(...candidates);
  return referenceMs - lastBeat < PR_REVIEW_CLAIM_LEASE_MS;
}

/** Options for {@link createClaimLeaseRenewer}. */
export interface ClaimLeaseRenewerOptions {
  repo: string;
  claimCommentId: number;
  body: string;
  claimedAtMs: number;
  ghCommandFn: (args: string[]) => Promise<string>;
  log: (message: string) => void;
  nowMsFn?: () => number;
  renewMs?: number;
}

/**
 * Build a renewer the processor polls to keep its lease on a claimed review
 * alive — renewing edits the comment body, which bumps GitHub's
 * `updated_at`, and that is exactly what {@link isLeaseLive} reads, so the
 * liveness check never depends on comparing clocks across hosts.
 */
export function createClaimLeaseRenewer(
  options: ClaimLeaseRenewerOptions,
): { renewIfDue(): Promise<void> } {
  const {
    repo,
    claimCommentId,
    body,
    claimedAtMs,
    ghCommandFn,
    log,
    nowMsFn = () => Date.now(),
    renewMs = PR_REVIEW_CLAIM_RENEW_MS,
  } = options;

  let lastRenewMs = claimedAtMs;
  let currentBody = body;

  return {
    async renewIfDue(): Promise<void> {
      const now = nowMsFn();
      if (now - lastRenewMs < renewMs) return;

      const nextBody = withRenewedLease(currentBody, now);
      try {
        await updateIssueComment(repo, claimCommentId, nextBody, ghCommandFn);
        currentBody = nextBody;
        lastRenewMs = now;
      } catch (err) {
        log(
          `[claim-pr-comment] ${repo}: could not renew the lease on claim ` +
            `comment ${claimCommentId}, so another host may reclaim the ` +
            `review once it lapses — ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
    },
  };
}
