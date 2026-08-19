/**
 * Existence check for the escape-hatch follow-up issue (Issue #3661,
 * SEC-6287d379587c).
 *
 * `detectEscapeHatch` decides "was the work handed off?" purely from
 * model-authored prose in `.pr_response_message`: a `#NNN`-shaped token plus
 * one of ~19 markers ("out of scope", "hand off", "tracked separately") is
 * enough to return `processed: true` and suppress the retry path. Nothing
 * checked that the follow-up issue the message names actually exists, so a
 * run that never filed one — or that hallucinated the number — still reported
 * a clean hand-off.
 *
 * This module closes that gap with a single API read. The failure modes are
 * deliberately asymmetric:
 *
 * - The issue is **definitively absent** (the API says so) → reject the
 *   hand-off, loudly. The claim is false and the run must not be recorded as
 *   resolved.
 * - The lookup **could not be completed** (network, rate limit, auth) →
 *   accept, with a warning. Turning a transient API error into a rejected
 *   hand-off would put the worker back into the retry loop the escape hatch
 *   exists to prevent.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";
import { parseFollowUpIssueRef } from "./escape_hatch_label_strip.ts";

/** Outcome of the follow-up existence check. */
export interface FollowUpVerification {
  /** True when the hand-off may be treated as a successful resolution. */
  verified: boolean;
  /** Machine-readable reason, for logs and tests. */
  reason:
    | "exists"
    | "unparseable-ref"
    | "not-found"
    | "lookup-failed"
    | "no-ref";
}

/**
 * Recognise a "this issue does not exist" answer from the GitHub API.
 *
 * `gh` surfaces a missing issue as a 404 with a "Not Found" message; anything
 * else (timeout, 401, 403, 5xx) is an inconclusive lookup.
 *
 * @param message - The error message from the failed lookup.
 * @returns true when the API definitively reported the issue as absent.
 */
export function isDefinitiveNotFound(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("not found") || lower.includes("404");
}

/**
 * Verify that the follow-up issue named by an escape-hatch message exists.
 *
 * @param args.issueRef - The `#NNN` / `owner/repo#NNN` ref from
 *   `detectEscapeHatch` (`undefined` when none was found).
 * @param args.currentRepo - Repository in `owner/repo` form, for a bare ref.
 * @param args.ghClient - GitHub client used for the lookup.
 * @param args.logger - Logger for the loud rejection / inconclusive warning.
 * @returns Whether the hand-off may be accepted, and why.
 */
export async function verifyFollowUpIssueExists(args: {
  issueRef: string | undefined;
  currentRepo: string;
  ghClient: Pick<GitHubClient, "getIssue">;
  logger: Logger;
}): Promise<FollowUpVerification> {
  const { issueRef, currentRepo, ghClient, logger } = args;

  if (!issueRef) return { verified: false, reason: "no-ref" };

  const parsed = parseFollowUpIssueRef(issueRef, currentRepo);
  if (!parsed) {
    logger.warn(
      "Escape-hatch follow-up ref could not be parsed — accepting hand-off " +
        "without verification",
      { issueRef, currentRepo },
    );
    return { verified: true, reason: "unparseable-ref" };
  }

  try {
    await ghClient.getIssue(parsed.repo, parsed.issueNumber);
    return { verified: true, reason: "exists" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDefinitiveNotFound(message)) {
      logger.error(
        "Rejecting escape-hatch hand-off: the follow-up issue it names does " +
          "not exist (Issue #3661)",
        { repo: parsed.repo, issueNumber: parsed.issueNumber, issueRef },
      );
      return { verified: false, reason: "not-found" };
    }
    logger.warn(
      "Could not verify escape-hatch follow-up issue (non-fatal) — accepting " +
        "the hand-off rather than looping on a transient API error",
      { repo: parsed.repo, issueNumber: parsed.issueNumber, error: message },
    );
    return { verified: true, reason: "lookup-failed" };
  }
}
