/**
 * The milestone roll-back marker (Issue #1770, parent #1730).
 *
 * When a milestone roll-back reverts a child's merged PR, the child issue is
 * reopened and re-queued — its work no longer exists on the branch. Its PR,
 * however, is still `merged` for ever, so both merged-PR closers
 * (`sweepMergedPrIssues` and the priority-1.67 `closeIssuesForMergedPrs`)
 * saw a merged, landed PR naming an open issue and closed it again on the
 * very next cycle. The roll-back reopened the child; the sweep shut it.
 *
 * A roll-back therefore has to leave a record the closers can read, in the
 * same place and with the same trust rules as the VibeCoder#42 escape hatch
 * it sits beside: a comment on the issue, authored by the fleet, dated after
 * the merge it undoes.
 *
 * Trust rules, stated so no caller has to re-derive them:
 *
 *  - **Author, not body.** A comment body is writable by any GitHub account,
 *    and this marker *suppresses* a close. Only a marker authored by a
 *    configured fleet login counts — the `alert_dedup_authors.ts` control,
 *    applied here. A marker from anyone else is ignored and the issue closes
 *    exactly as it does today.
 *  - **No fleet identity, no suppression.** An empty `fleetAuthors` means
 *    nothing can be attributed, so nothing is trusted and the close goes
 *    ahead — the same fail direction `issueCommentsContainMarker` takes.
 *  - **Strictly after the merge.** A marker dated at or before the merge
 *    belongs to an older roll-back and cannot describe this merge, so it
 *    never blocks the close. A marker with no readable timestamp cannot be
 *    shown to be after the merge either, and is ignored for the same reason.
 *
 * The marker follows the canonical `vibe-*` grammar pinned by
 * `marker_grammar_test.ts`: a bare `vibe-` prefix and `key="value"`
 * attributes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isFleetAuthor } from "./fleet_authors.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";

/** Opening literal of the roll-back marker. */
export const ROLLBACK_MARKER = "<!-- vibe-milestone-rollback";

/** What a roll-back marker records. */
export interface RollbackMarkerFields {
  /** The child PR whose merge was reverted. */
  prNumber: number;
  /** The revert commit that undid it on the milestone branch. */
  revertSha: string;
  /** The branch the revert landed on. */
  branch: string;
}

/** A trusted roll-back marker found on an issue. */
export interface RollbackRecord extends RollbackMarkerFields {
  /** The fleet login that posted it. */
  author: string;
  /** Its ISO-8601 post time — strictly after the merge it undoes. */
  postedAt: string;
}

/** Length bounds a revert sha must satisfy — short sha through full sha. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Reject a value that cannot be rendered inside the marker.
 *
 * The marker is machine-read back out of a comment body, so a value carrying
 * a quote, an angle bracket or a newline would break the grammar for every
 * later reader. Fail loud at the point the bad value arrives rather than
 * emitting a marker nothing can parse.
 */
function assertAttributeSafe(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`roll-back marker ${name} must not be empty`);
  }
  if (/["'<>\n\r]/.test(value)) {
    throw new Error(
      `roll-back marker ${name} must not contain quotes, angle brackets or ` +
        `newlines: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Render the roll-back marker a milestone roll-back posts on each reverted
 * child issue.
 *
 * @param fields - The reverted PR, the revert commit and the branch.
 * @returns The marker comment line.
 * @throws when a field cannot be rendered inside the marker grammar.
 */
export function buildRollbackMarker(fields: RollbackMarkerFields): string {
  const { prNumber, revertSha, branch } = fields;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(
      `roll-back marker prNumber must be a positive integer, got ${prNumber}`,
    );
  }
  const sha = revertSha.trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(
      `roll-back marker revertSha must be a 7-40 character hex sha, got ` +
        `${JSON.stringify(revertSha)}`,
    );
  }
  assertAttributeSafe("branch", branch);
  return `${ROLLBACK_MARKER} pr="${prNumber}" revert="${sha}" ` +
    `branch="${branch.trim()}" -->`;
}

/** Read the `key="value"` attributes of the first marker in `body`. */
function parseMarker(body: string): RollbackMarkerFields | undefined {
  const start = body.indexOf(ROLLBACK_MARKER);
  if (start === -1) return undefined;
  const end = body.indexOf("-->", start);
  if (end === -1) return undefined;
  const attributes = body.slice(start + ROLLBACK_MARKER.length, end);
  const values = new Map<string, string>();
  for (const match of attributes.matchAll(/([a-z]+)="([^"]*)"/g)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) values.set(key, value);
  }
  const prNumber = Number(values.get("pr"));
  const revertSha = values.get("revert") ?? "";
  const branch = values.get("branch") ?? "";
  if (!Number.isInteger(prNumber) || prNumber <= 0) return undefined;
  if (!SHA_PATTERN.test(revertSha)) return undefined;
  if (branch.trim().length === 0) return undefined;
  return { prNumber, revertSha, branch };
}

/** The commenter login, across the REST and `gh --json` comment shapes. */
function commentAuthor(raw: Record<string, unknown>): string | undefined {
  const user = raw.user;
  if (typeof user === "object" && user !== null) {
    const login = (user as { login?: unknown }).login;
    if (typeof login === "string" && login.trim().length > 0) {
      return login.trim();
    }
  }
  const author = raw.author;
  if (typeof author === "string" && author.trim().length > 0) {
    return author.trim();
  }
  if (typeof author === "object" && author !== null) {
    const login = (author as { login?: unknown }).login;
    if (typeof login === "string" && login.trim().length > 0) {
      return login.trim();
    }
  }
  return undefined;
}

/** The post time, across the REST (`created_at`) and gh (`createdAt`) shapes. */
function commentPostedAt(raw: Record<string, unknown>): string | undefined {
  for (const key of ["created_at", "createdAt"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * The trusted roll-back marker posted after `mergedAt`, if there is one.
 *
 * @param comments - Raw comment objects, REST or `gh … --json comments` shape.
 * @param mergedAt - ISO-8601 merge time of the PR that would close the issue.
 * @param fleetAuthors - Fleet logins whose markers count. Empty means no
 *   identity is configured, so no marker is trusted and the close proceeds.
 * @returns The newest trusted marker after the merge, or `undefined`.
 */
export function findRollbackAfter(
  comments: readonly unknown[],
  mergedAt: string | null | undefined,
  fleetAuthors: readonly string[],
): RollbackRecord | undefined {
  const mergedMs = Date.parse(mergedAt ?? "");
  if (Number.isNaN(mergedMs)) return undefined;
  const fleet = [...fleetAuthors];
  if (fleet.length === 0) return undefined;

  let newest: RollbackRecord | undefined;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const comment = raw as Record<string, unknown>;
    const body = comment.body;
    if (typeof body !== "string" || !body.includes(ROLLBACK_MARKER)) continue;
    const author = commentAuthor(comment);
    if (author === undefined || !isFleetAuthor(author, fleet)) continue;
    const postedAt = commentPostedAt(comment);
    if (postedAt === undefined) continue;
    const postedMs = Date.parse(postedAt);
    if (Number.isNaN(postedMs) || postedMs <= mergedMs) continue;
    const fields = parseMarker(body);
    if (!fields) continue;
    if (postedMs > newestMs) {
      newestMs = postedMs;
      newest = { ...fields, author, postedAt };
    }
  }
  return newest;
}

/** Skip reason both closers record — always opens with `rolled-back`. */
export function rollbackSkipReason(record: RollbackRecord): string {
  return `rolled-back — a milestone roll-back reverted PR ` +
    `#${record.prNumber} on \`${record.branch}\` (revert ` +
    `\`${record.revertSha}\`) at ${record.postedAt}, after it merged, so ` +
    `the issue was reopened and re-queued`;
}

/**
 * Fetch an issue's comments and return the trusted roll-back marker posted
 * after `mergedAt`, if any.
 *
 * @param repo - Repository in "owner/repo" format.
 * @param issueNumber - The open issue a merged PR would close.
 * @param mergedAt - ISO-8601 merge time of that PR.
 * @param fleetAuthors - Fleet logins whose markers count.
 * @param ghCommandFn - The `gh` seam.
 * @throws when the comment thread cannot be read — an unreadable thread
 *   cannot prove the issue was *not* rolled back, so callers defer.
 */
export async function findRollbackAfterMerge(
  repo: string,
  issueNumber: number,
  mergedAt: string | null | undefined,
  fleetAuthors: readonly string[],
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<RollbackRecord | undefined> {
  // No fleet identity or no readable merge time means no marker can be
  // trusted against this merge — skip the fetch rather than spend it.
  if (fleetAuthors.length === 0) return undefined;
  if (Number.isNaN(Date.parse(mergedAt ?? ""))) return undefined;
  const comments = await fetchIssueCommentPages(repo, issueNumber, ghCommandFn);
  return findRollbackAfter(comments, mergedAt, fleetAuthors);
}
