/**
 * Fleet-push supersession for PR feedback comments (Issue #211).
 *
 * Two hosts maintain the same PR. A reviewer asks for a fix at 04:49, a
 * sibling fleet host pushes that fix at 04:55, and at 04:57 this host claimed
 * the same comment and burned a whole agent run re-fixing what was already
 * fixed — then failed to push on top of the sibling's head.
 *
 * A comment is *superseded* when a fleet-owned author pushed the PR head after
 * the comment was written: whatever the comment asked for, the fleet has
 * already had a go at it, so the comment must be re-evaluated on the next
 * scan rather than claimed now. Comments answered by a *human* push are not
 * superseded — a human pushing to their own PR is not the fleet answering
 * feedback.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** The PR head commit, as far as supersession cares. */
export interface PrHeadCommit {
  /** Commit SHA. */
  sha: string;
  /** ISO-8601 committer date. */
  committedAt: string;
  /** GitHub login of the commit author, or null when unattributed. */
  authorLogin: string | null;
}

/** Input for {@link isCommentSuperseded}. */
export interface CommentSupersessionInput {
  /** ISO-8601 creation time of the comment. */
  commentCreatedAt?: string;
  /** The PR's current head commit, or null when it could not be read. */
  headCommit: PrHeadCommit | null;
  /** Fleet-owned logins (this worker plus its siblings and service accounts). */
  fleetAuthors: string[];
}

/**
 * Parse an ISO-8601 timestamp to epoch milliseconds, or null when unusable.
 */
function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Whether a fleet push has already superseded this comment (Issue #211).
 *
 * Fails *open* (returns false, so the comment stays actionable) whenever the
 * evidence is incomplete — a missing head commit, an unattributed author, or
 * an unparseable timestamp. Skipping real feedback is the worse error.
 *
 * @param input - Comment timestamp, PR head commit and the fleet author set
 * @returns True when a fleet author pushed the head after the comment
 */
export function isCommentSuperseded(input: CommentSupersessionInput): boolean {
  const { commentCreatedAt, headCommit, fleetAuthors } = input;
  if (!headCommit) return false;

  const author = headCommit.authorLogin?.toLowerCase();
  if (!author) return false;
  const isFleetAuthor = fleetAuthors.some((a) => a.toLowerCase() === author);
  if (!isFleetAuthor) return false;

  const commentAt = parseTimestamp(commentCreatedAt);
  const pushedAt = parseTimestamp(headCommit.committedAt);
  if (commentAt === null || pushedAt === null) return false;

  return pushedAt > commentAt;
}

/**
 * Read the PR head commit's author and commit date (Issue #211).
 *
 * @param repo - Repository in "owner/repo" format
 * @param headSha - The PR head SHA
 * @param ghCommandFn - Function to run gh commands
 * @returns The head commit, or null when it cannot be read
 */
export async function fetchPrHeadCommit(
  repo: string,
  headSha: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<PrHeadCommit | null> {
  if (!headSha) return null;
  try {
    const output = await ghCommandFn([
      "api",
      `repos/${repo}/commits/${headSha}`,
      "--jq",
      "{sha: .sha, committedAt: .commit.committer.date, authorLogin: .author.login}",
    ]);
    const parsed: unknown = JSON.parse(output);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const sha = typeof record.sha === "string" ? record.sha : headSha;
    const committedAt = typeof record.committedAt === "string"
      ? record.committedAt
      : "";
    const authorLogin = typeof record.authorLogin === "string"
      ? record.authorLogin
      : null;
    if (!committedAt) return null;
    return { sha, committedAt, authorLogin };
  } catch {
    // Unreadable head commit → no supersession evidence; the caller fails open.
    return null;
  }
}
