/**
 * Fleet-push supersession for PR feedback comments (Issue #211).
 *
 * Two fleet hosts maintain the same PR. A human asked NEAT-AI-core #557 to
 * "fix the quality issues" at 04:49; a sibling host claimed the failing check
 * and pushed a fix at 04:55; this host claimed the same comment at 04:57 and
 * spent a whole agent run re-doing work that had already landed.
 *
 * A comment is *superseded* when a fleet account pushed to the PR head after
 * the comment was written: whatever it asked for was addressed by that push,
 * or will be judged by the CI run it triggered. A push by anyone outside the
 * fleet — a human collaborator — never supersedes feedback, because that is
 * not the worker answering itself.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** The PR head commit, as far as supersession is concerned. */
export interface HeadCommitInfo {
  /** The head commit SHA. */
  sha: string;
  /** ISO-8601 commit timestamp. */
  committedAt: string;
  /** Login that authored the commit, when GitHub resolved one. */
  authorLogin: string | null;
  /** Login that committed it, when GitHub resolved one. */
  committerLogin: string | null;
}

/** Inputs for {@link isSupersededByFleetPush}. */
export interface SupersessionInput {
  /** ISO-8601 timestamp of the comment being considered. */
  commentCreatedAt?: string;
  /** The PR's current head commit, or null when it could not be read. */
  headCommit: HeadCommitInfo | null;
  /** Logins the fleet pushes under (this worker and its siblings). */
  fleetAuthors: readonly string[];
}

/** Case-insensitive membership test for a GitHub login. */
function isFleetLogin(
  login: string | null,
  fleetAuthors: readonly string[],
): boolean {
  if (!login) return false;
  const lower = login.toLowerCase();
  return fleetAuthors.some((author) => author.toLowerCase() === lower);
}

/** Parse an ISO-8601 timestamp, or null when it is missing or malformed. */
function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Whether a fleet push has already superseded this comment (Issue #211).
 *
 * Fails closed on missing data: an unknown comment time, an unreadable head
 * commit, or a head commit with no resolvable fleet author all mean "not
 * superseded", so genuine feedback is never dropped on a guess.
 */
export function isSupersededByFleetPush(input: SupersessionInput): boolean {
  const { commentCreatedAt, headCommit, fleetAuthors } = input;
  if (!headCommit) return false;

  const pushedByFleet =
    isFleetLogin(headCommit.authorLogin, fleetAuthors) ||
    isFleetLogin(headCommit.committerLogin, fleetAuthors);
  if (!pushedByFleet) return false;

  const commentAt = parseTimestamp(commentCreatedAt);
  const headAt = parseTimestamp(headCommit.committedAt);
  if (commentAt === null || headAt === null) return false;

  return headAt > commentAt;
}

/**
 * Read the PR head commit's timestamp and logins (Issue #211).
 *
 * Returns null on any failure — the caller then treats the comment as not
 * superseded, which is the safe direction.
 *
 * @param repo - Repository in "owner/repo" format
 * @param headSha - The PR's head commit SHA
 * @param ghCommandFn - Function to run gh commands
 */
export async function fetchPrHeadCommit(
  repo: string,
  headSha: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<HeadCommitInfo | null> {
  if (!headSha) return null;
  try {
    const output = await ghCommandFn([
      "api",
      `repos/${repo}/commits/${headSha}`,
      "--jq",
      '{committedAt: .commit.committer.date, authorLogin: (.author.login // null), committerLogin: (.committer.login // null)}',
    ]);
    const parsed: unknown = JSON.parse(output);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const committedAt = typeof record["committedAt"] === "string"
      ? record["committedAt"]
      : "";
    if (!committedAt) return null;
    return {
      sha: headSha,
      committedAt,
      authorLogin: typeof record["authorLogin"] === "string"
        ? record["authorLogin"]
        : null,
      committerLogin: typeof record["committerLogin"] === "string"
        ? record["committerLogin"]
        : null,
    };
  } catch {
    return null;
  }
}
