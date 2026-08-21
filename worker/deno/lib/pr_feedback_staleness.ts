/**
 * Feedback superseded by a fleet push (Issue #211).
 *
 * Two hosts maintain the same PR. One claimed a CI check at 04:55 and pushed a
 * fix; the other claimed the 04:49 "please fix the quality issues" comment at
 * 04:57 — feedback the sibling's push had already addressed. That second run
 * cost an agent invocation, a comment to a human, and a spurious label, and it
 * ran against a branch head that had moved underneath it.
 *
 * A comment whose PR a fleet author has just pushed to is not claimed. The
 * deferral is bounded by a cool-off window rather than permanent: genuine
 * feedback the push did not address is picked up by a later scan, so this can
 * never silently swallow a human's request.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** How long a fleet push defers feedback on the same PR (15 minutes). */
export const FLEET_PUSH_COOL_OFF_MS = 15 * 60 * 1000;

/** Provenance of a PR's head commit, as GitHub reports it. */
export interface HeadCommitInfo {
  /** GitHub login of the commit author, when GitHub could resolve one. */
  authorLogin: string | null;
  /** GitHub login of the committer, when GitHub could resolve one. */
  committerLogin: string | null;
  /** ISO-8601 committer date. */
  committedAt: string | null;
}

/** Inputs to {@link isSupersededByFleetPush}. */
export interface SupersededCheck {
  /** ISO-8601 creation time of the comment being considered. */
  commentCreatedAt: string | undefined;
  /** The PR head commit, or null when it could not be read. */
  headCommit: HeadCommitInfo | null;
  /** Logins the fleet pushes under (this host included). */
  fleetAuthors: readonly string[];
  /** Current time in epoch milliseconds. */
  now: number;
  /** Override the cool-off window; defaults to {@link FLEET_PUSH_COOL_OFF_MS}. */
  coolOffMs?: number;
}

/** Parse an ISO-8601 timestamp to epoch ms, or null when unusable. */
function toEpoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? null : epoch;
}

/** Case-insensitive membership test for a GitHub login. */
function isFleetLogin(
  login: string | null,
  fleetAuthors: readonly string[],
): boolean {
  if (!login) return false;
  const needle = login.toLowerCase();
  return fleetAuthors.some((author) => author.toLowerCase() === needle);
}

/**
 * Whether a fleet push has just superseded this comment (Issue #211).
 *
 * True only when all of the following hold, so an unreadable head commit or a
 * human's push never suppresses feedback:
 *   - the PR head commit was authored (or committed) by a fleet login;
 *   - it landed **after** the comment was written; and
 *   - it landed within the cool-off window, so the deferral expires and a
 *     later scan reconsiders the comment.
 */
export function isSupersededByFleetPush(check: SupersededCheck): boolean {
  const { headCommit, fleetAuthors, now } = check;
  if (!headCommit) return false;

  const isFleetPush = isFleetLogin(headCommit.authorLogin, fleetAuthors) ||
    isFleetLogin(headCommit.committerLogin, fleetAuthors);
  if (!isFleetPush) return false;

  const pushedAt = toEpoch(headCommit.committedAt);
  const commentAt = toEpoch(check.commentCreatedAt);
  if (pushedAt === null || commentAt === null) return false;
  if (pushedAt <= commentAt) return false;

  const coolOffMs = check.coolOffMs ?? FLEET_PUSH_COOL_OFF_MS;
  return now - pushedAt < coolOffMs;
}

/**
 * Read the provenance of a PR's head commit (Issue #211).
 *
 * @param repo - Repository in "owner/repo" format
 * @param headRefOid - The PR head SHA
 * @param ghCommandFn - Function to run gh commands
 * @returns The commit's author, committer and date, or null on any failure —
 *   an unreadable commit defers nothing.
 */
export async function fetchHeadCommitInfo(
  repo: string,
  headRefOid: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<HeadCommitInfo | null> {
  if (!headRefOid) return null;
  try {
    const output = await ghCommandFn([
      "api",
      `repos/${repo}/commits/${headRefOid}`,
      "--jq",
      '{authorLogin: (.author.login // null), committerLogin: (.committer.login // null), committedAt: (.commit.committer.date // null)}',
    ]);
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null) return null;
    const row = parsed as Record<string, unknown>;
    return {
      authorLogin: typeof row.authorLogin === "string" ? row.authorLogin : null,
      committerLogin: typeof row.committerLogin === "string"
        ? row.committerLogin
        : null,
      committedAt: typeof row.committedAt === "string" ? row.committedAt : null,
    };
  } catch {
    return null;
  }
}
