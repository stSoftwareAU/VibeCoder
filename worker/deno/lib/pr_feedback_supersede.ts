/**
 * Fleet-push supersession for PR feedback (Issue #211).
 *
 * The fleet maintains the same PR from several hosts. In the incident a human
 * asked for the quality issues to be fixed at 04:49, a sibling host pushed
 * exactly that fix at 04:55, and this host claimed the 04:49 comment at 04:57 —
 * burning an agent run on work already done and ending with a "please check the
 * branch status" comment to the human.
 *
 * A comment is superseded when the PR's head commit was pushed by a fleet
 * account **after** the comment was written: whatever the comment asked for was
 * addressed by that push, or will be re-raised against the new head. Anything
 * unknown — no timestamp, no head commit, an unparseable date — is *not*
 * superseded, so feedback is never silently dropped.
 *
 * The deferral is a de-duplication window, never a veto: once the fleet push is
 * older than {@link FLEET_PUSH_COOL_OFF_MS} the comment becomes actionable
 * again. Without that expiry a single fleet push would suppress a human's
 * comment on that head for as long as the head stood — the comment would starve
 * rather than be re-evaluated.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** How long a fleet push defers feedback on the same PR (15 minutes). */
export const FLEET_PUSH_COOL_OFF_MS = 15 * 60 * 1000;

/** The PR head commit, as far as the scan can see it. */
export interface HeadCommitInfo {
  /** Head commit SHA. */
  sha: string;
  /** GitHub login that authored the commit, when GitHub resolved one. */
  authorLogin: string | null;
  /** GitHub login that committed it, when GitHub resolved one. */
  committerLogin: string | null;
  /** ISO 8601 timestamp of the commit. */
  committedAt: string | null;
}

/** Inputs to the supersession decision. */
export interface SupersedeCheck {
  /** ISO 8601 creation time of the comment being considered. */
  commentCreatedAt?: string | null;
  /** The PR's head commit, or null when it could not be read. */
  headCommit?: HeadCommitInfo | null;
  /** Fleet logins whose pushes count as the fleet answering the comment. */
  fleetAuthors: readonly string[];
  /** Now, in epoch milliseconds. Defaults to the current time. */
  now?: number;
  /** Override the cool-off window; defaults to {@link FLEET_PUSH_COOL_OFF_MS}. */
  coolOffMs?: number;
}

/**
 * Whether a fleet push has already superseded this comment (Issue #211).
 *
 * @param check - Comment timestamp, head commit, the fleet login set, and the
 *   optional clock and cool-off window
 * @returns True only when a fleet account pushed the head commit after the
 *   comment was written and within the cool-off window; false whenever the
 *   answer is not knowable.
 */
export function isSupersededByFleetPush(check: SupersedeCheck): boolean {
  const commentTime = parseTimestamp(check.commentCreatedAt);
  if (commentTime === null) return false;

  const head = check.headCommit;
  if (!head) return false;

  const pushTime = parseTimestamp(head.committedAt);
  if (pushTime === null) return false;
  if (pushTime <= commentTime) return false;

  // The deferral expires: an older push must not suppress the comment forever.
  const now = check.now ?? Date.now();
  const coolOffMs = check.coolOffMs ?? FLEET_PUSH_COOL_OFF_MS;
  if (now - pushTime >= coolOffMs) return false;

  const fleet = new Set(
    check.fleetAuthors.map((login) => login.trim().toLowerCase()).filter((
      login,
    ) => login.length > 0),
  );
  if (fleet.size === 0) return false;

  const candidates = [head.authorLogin, head.committerLogin]
    .filter((login): login is string => typeof login === "string")
    .map((login) => login.trim().toLowerCase());

  return candidates.some((login) => fleet.has(login));
}

/**
 * Parse an ISO 8601 timestamp into epoch milliseconds.
 *
 * @param value - The timestamp, possibly missing or malformed
 * @returns Epoch milliseconds, or null when it cannot be parsed
 */
function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Fetch the PR head commit's author, committer and timestamp (Issue #211).
 *
 * Called only once a comment has already passed the authorisation checks, so
 * the extra API call is paid on the rare "we found something to do" path
 * rather than on every PR in every scan.
 *
 * @param repo - Repository in "owner/repo" format
 * @param sha - The PR head SHA
 * @param ghCommandFn - Function to run gh commands
 * @returns The head commit info, or null when it cannot be read
 */
export async function fetchPrHeadCommit(
  repo: string,
  sha: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<HeadCommitInfo | null> {
  if (!sha) return null;
  try {
    const output = await ghCommandFn([
      "api",
      `repos/${repo}/commits/${sha}`,
      "--jq",
      "{sha: .sha, authorLogin: .author.login, committerLogin: .committer.login, committedAt: .commit.committer.date}",
    ]);
    const parsed: unknown = JSON.parse(output);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      sha: typeof record["sha"] === "string" ? record["sha"] : sha,
      authorLogin: typeof record["authorLogin"] === "string"
        ? record["authorLogin"]
        : null,
      committerLogin: typeof record["committerLogin"] === "string"
        ? record["committerLogin"]
        : null,
      committedAt: typeof record["committedAt"] === "string"
        ? record["committedAt"]
        : null,
    };
  } catch {
    // Unreadable head commit — the caller treats this as "not superseded",
    // so genuine feedback is still claimed.
    return null;
  }
}
