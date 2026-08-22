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
 * **Existence alone is forgeable (Issue #185, SEC-8f21c4a0e7b3).** Any actor
 * whose text reaches the PR-feedback prompt — including a reviewer who is not
 * on the `authorized_commenters` allowlist — can steer the model into writing
 * "tracked separately in #N" for an issue that already exists. The number then
 * passes the existence check and the run is recorded as resolved, skipping the
 * escalation genuinely unresolved feedback would trigger. The check therefore
 * also requires an **unforgeable** signal: GitHub's own record of who filed the
 * follow-up. The author must be the worker itself, a fleet sibling, or an
 * allowlisted author (`allowed_authors` / `authorized_commenters`); anyone else
 * is rejected, loudly. With no allowlist to check against, the gate cannot be
 * applied at all, so it fails closed rather than waving the hand-off through.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";
import { parseFollowUpIssueRef } from "./escape_hatch_label_strip.ts";
import { isDefinitiveNotFound } from "./github_not_found.ts";

/**
 * Re-exported from `github_not_found.ts` (Issue #210), which owns the one
 * definition every model-named-issue path shares — including the GraphQL
 * "could not resolve to an issue or pull request" wording a hallucinated
 * number produces.
 */
export { isDefinitiveNotFound };

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
    | "no-ref"
    /** The follow-up exists but was filed by an untrusted login (#185). */
    | "untrusted-author"
    /** No trusted-author allowlist was available, so the gate failed closed. */
    | "no-trusted-authors";
}

/**
 * Is `author` on the trusted follow-up author allowlist (Issue #185)?
 *
 * GitHub logins are case-insensitive, so matching is too. Blank entries on
 * either side never match — an empty allowlist entry must not become a
 * wildcard that admits an issue with a missing author.
 *
 * @param author - The `author` GitHub reports for the follow-up issue.
 * @param trustedAuthors - Worker login + fleet siblings + allowlisted authors.
 * @returns true when the follow-up was filed by a trusted login.
 */
export function isTrustedFollowUpAuthor(
  author: string | undefined,
  trustedAuthors: readonly string[],
): boolean {
  const key = (author ?? "").trim().toLowerCase();
  if (key.length === 0) return false;
  return trustedAuthors.some(
    (candidate) =>
      typeof candidate === "string" && candidate.trim().toLowerCase() === key,
  );
}

/**
 * Verify that the follow-up issue named by an escape-hatch message exists
 * **and was filed by a trusted login**.
 *
 * @param args.issueRef - The `#NNN` / `owner/repo#NNN` ref from
 *   `detectEscapeHatch` (`undefined` when none was found).
 * @param args.currentRepo - Repository in `owner/repo` form, for a bare ref.
 * @param args.trustedAuthors - Logins whose authorship makes the follow-up
 *   genuine (Issue #185): the worker's own login, fleet siblings, and the
 *   configured `allowed_authors` / `authorized_commenters`. An empty list
 *   rejects every hand-off — the gate fails closed, loudly.
 * @param args.ghClient - GitHub client used for the lookup.
 * @param args.logger - Logger for the loud rejection / inconclusive warning.
 * @returns Whether the hand-off may be accepted, and why.
 */
export async function verifyFollowUpIssueExists(args: {
  issueRef: string | undefined;
  currentRepo: string;
  trustedAuthors: readonly string[];
  ghClient: Pick<GitHubClient, "getIssue">;
  logger: Logger;
}): Promise<FollowUpVerification> {
  const { issueRef, currentRepo, trustedAuthors, ghClient, logger } = args;

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

  // Issue #185: without an allowlist there is no unforgeable signal to check,
  // so accepting would be back to trusting the model's prose. Fail closed.
  const usableAuthors = trustedAuthors.filter(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
  if (usableAuthors.length === 0) {
    logger.error(
      "Rejecting escape-hatch hand-off: no trusted-author allowlist was " +
        "available to verify who filed the follow-up issue (Issue #185)",
      { repo: parsed.repo, issueNumber: parsed.issueNumber, issueRef },
    );
    return { verified: false, reason: "no-trusted-authors" };
  }

  try {
    const issue = await ghClient.getIssue(parsed.repo, parsed.issueNumber);
    // Issue #185: the issue existing proves nothing — a prompt-injected
    // message can name any pre-existing issue. Only GitHub's record of the
    // author is unforgeable by the actor who wrote the prompt text.
    if (!isTrustedFollowUpAuthor(issue.author, usableAuthors)) {
      logger.error(
        "Rejecting escape-hatch hand-off: the follow-up issue it names was " +
          "not filed by the worker or an allowlisted author (Issue #185)",
        {
          repo: parsed.repo,
          issueNumber: parsed.issueNumber,
          issueRef,
          author: issue.author,
        },
      );
      return { verified: false, reason: "untrusted-author" };
    }
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
