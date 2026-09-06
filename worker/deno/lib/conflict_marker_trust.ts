/**
 * Author verification for merge-conflict marker comments (Issue #1247,
 * SEC-1216-06, parent #1216).
 *
 * `issue_comment_pages.fetchIssueCommentPages` returns the **raw** REST
 * comment objects — every author's. The merge-conflict ladder reads its whole
 * attempt history back out of those bodies, and a PR comment is writable by
 * any GitHub account on a public repository. Matching on the body alone meant
 * two planted `CONFLICT_FAILED_MARKER` comments spent a PR's merge budget and
 * made the worker **close** it, and one planted restart marker made the
 * abandon rung decline for ever so the PR stalled unowned.
 *
 * This module is the author check those readers were missing, in one place so
 * the scan and the abandon rung cannot drift apart. It is the
 * `alert_dedup_authors.ts` control expressed over the raw REST page shape,
 * matching the seam its siblings in this subsystem already use
 * (`merge_conflict_deferrals.ts`, `merge_conflict_stall_watchdog.ts`).
 *
 * **The fail direction differs by what the marker does, so the partition
 * reports both halves rather than one filtered list.**
 *
 * - An attempt marker **drives** a destructive action: counted, it closes the
 *   PR. Discarding one that cannot be attributed lowers the tally, so the PR
 *   is *not* abandoned. Fail-open on {@link ConflictCommentTrust.unattributable}
 *   is the harmless direction there.
 * - A restart marker **suppresses** that same destructive action: it is what
 *   bounds the fleet to one abandon per originating issue. Discarding one that
 *   cannot be attributed would relax the bound, so the caller must refuse the
 *   abandon instead — the bound has to rest on an authenticated marker, not on
 *   the absence of an unauthenticated one.
 *
 * "Unattributable" is deliberately narrower than "not trusted": a comment
 * carrying an outsider's login *is* attributed — to an outsider — and is
 * simply discarded, which is the whole point of the fix. Only a comment with
 * no readable author, or a comparison against no configured fleet identity at
 * all, is unattributable.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isFleetAuthor } from "./fleet_authors.ts";

/**
 * The commenter login a raw REST comment object carries.
 *
 * `repos/…/issues/…/comments` renders the commenter as `user.login`, not the
 * `author` object `gh issue list --json author` returns.
 *
 * @param raw - One raw REST comment object.
 * @returns The trimmed login, or `undefined` when the comment carries none.
 */
export function conflictCommentAuthor(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const login = (raw as { user?: { login?: unknown } }).user?.login;
  return typeof login === "string" && login.trim().length > 0
    ? login.trim()
    : undefined;
}

/** How a comment thread was attributed (Issue #1247). */
export interface ConflictCommentTrust {
  /** The comments a trusted fleet account authored, in thread order. */
  trusted: unknown[];
  /**
   * Comments whose author could not be established at all — no readable
   * `user.login`, or no fleet identity configured to compare against.
   *
   * Distinct from a comment attributed to an outsider, which is discarded
   * without being counted here. A caller whose marker *suppresses* a
   * destructive action must refuse rather than proceed when this is non-zero.
   */
  unattributable: number;
}

/**
 * Split a raw comment thread into the fleet's own comments and the ones that
 * could not be attributed.
 *
 * @param comments - Raw REST comment objects, oldest first.
 * @param trustedAuthors - The resolved fleet logins whose markers count. An
 *   empty list means no identity was configured, so **every** comment is
 *   unattributable and none is trusted.
 * @returns The trusted comments in thread order, and the unattributable count.
 */
export function partitionConflictComments(
  comments: readonly unknown[],
  trustedAuthors: readonly string[],
): ConflictCommentTrust {
  const fleet = [...trustedAuthors];
  const trusted: unknown[] = [];
  let unattributable = 0;

  for (const raw of comments) {
    const author = conflictCommentAuthor(raw);
    if (author === undefined || fleet.length === 0) {
      unattributable++;
      continue;
    }
    if (isFleetAuthor(author, fleet)) trusted.push(raw);
  }

  return { trusted, unattributable };
}
