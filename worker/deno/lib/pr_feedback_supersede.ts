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
 * CHANGES_REQUESTED reviews use the same rule without the window
 * (Issue #2702): a review is superseded only by a fleet commit after it that
 * is neither a merge of the base branch nor a bot's formatting or version
 * bump — never merely because the head moved.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** How long a fleet push defers feedback on the same PR (15 minutes). */
export const FLEET_PUSH_COOL_OFF_MS = 15 * 60 * 1000;

/**
 * Who made a commit, when, and whether it is a merge — everything the
 * supersession rules read (Issue #211; Issue #2702 added `parentCount`).
 */
export interface CommitProvenance {
  /** GitHub login that authored the commit, when GitHub resolved one. */
  authorLogin: string | null;
  /** GitHub login that committed it, when GitHub resolved one. */
  committerLogin: string | null;
  /** ISO 8601 timestamp of the commit. */
  committedAt: string | null;
  /**
   * How many parents the commit has, when known. More than one is a merge —
   * in practice the base branch merged in by the update-branch call.
   */
  parentCount?: number;
}

/** The PR head commit, as far as the comment scan can see it. */
export interface HeadCommitInfo extends CommitProvenance {
  /** Head commit SHA. */
  sha: string;
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
  const head = check.headCommit;
  if (!head) return false;
  if (!isFleetAnswerAfter(head, check.commentCreatedAt, check.fleetAuthors)) {
    return false;
  }

  // The deferral expires: an older push must not suppress the comment forever.
  // `isFleetAnswerAfter` has already parsed this timestamp successfully.
  const pushTime = parseTimestamp(head.committedAt) ?? 0;
  const now = check.now ?? Date.now();
  const coolOffMs = check.coolOffMs ?? FLEET_PUSH_COOL_OFF_MS;
  return now - pushTime < coolOffMs;
}

/** Inputs to {@link isReviewSupersededByFleetFix}. */
export interface ReviewSupersedeCheck {
  /** ISO 8601 `submitted_at` of the CHANGES_REQUESTED review. */
  reviewSubmittedAt?: string | null;
  /** The PR's commits, or null when they could not be read. */
  commits: readonly CommitProvenance[] | null;
  /** Fleet logins whose pushes count as the fleet answering the review. */
  fleetAuthors: readonly string[];
}

/**
 * Whether a fleet fix commit has superseded a CHANGES_REQUESTED review
 * (Issue #2702).
 *
 * The head moving is not enough. On GRQ#5032 a base merge and a
 * github-actions version bump moved the head after the owner's review, and a
 * `commit_id !== head` rule then hid a review nobody had answered. Only a
 * commit {@link isFleetAnswerAfter} accepts — a fleet account's, after the
 * review, neither a merge nor a bot's — supersedes it. There is no cool-off:
 * once the fleet has answered, a reviewer who wants more re-reviews, and that
 * new review is judged afresh. A review the worker handled is dismissed, and
 * that is what stops it being processed twice.
 *
 * @param check - The review's timestamp, the PR's commits and the fleet set
 * @returns True only when such a commit exists; false whenever the answer is
 *   not knowable, so genuine feedback is never dropped on a guess.
 */
export function isReviewSupersededByFleetFix(
  check: ReviewSupersedeCheck,
): boolean {
  if (!check.commits) return false;
  return check.commits.some((commit) =>
    isFleetAnswerAfter(commit, check.reviewSubmittedAt, check.fleetAuthors)
  );
}

/**
 * Whether this commit is the fleet answering feedback written at `since`
 * (Issues #211, #2702).
 *
 * The one rule both supersession checks share. True only when the commit:
 *   - landed strictly after `since`;
 *   - was authored or committed by a fleet login;
 *   - is not a merge — a base branch merged in answers no feedback; and
 *   - was not made by a bot (`github-actions[bot]` formatting or version
 *     bumps).
 *
 * Anything unknown — no timestamp, an unparseable date, an empty fleet set —
 * is false. A commit whose parent count is unknown (the single head-commit
 * read) is judged on the other three.
 */
function isFleetAnswerAfter(
  commit: CommitProvenance,
  since: string | null | undefined,
  fleetAuthors: readonly string[],
): boolean {
  const sinceTime = parseTimestamp(since);
  if (sinceTime === null) return false;

  const commitTime = parseTimestamp(commit.committedAt);
  if (commitTime === null || commitTime <= sinceTime) return false;

  if ((commit.parentCount ?? 1) > 1) return false;

  const candidates = [commit.authorLogin, commit.committerLogin]
    .filter((login): login is string => typeof login === "string")
    .map((login) => login.trim().toLowerCase());
  if (candidates.some((login) => login.endsWith("[bot]"))) return false;

  const fleet = new Set(
    fleetAuthors.map((login) => login.trim().toLowerCase()).filter((
      login,
    ) => login.length > 0),
  );
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

/**
 * Read who made each commit on a PR, and when (Issue #2702).
 *
 * Called only for an authorised CHANGES_REQUESTED review whose `commit_id` is
 * no longer the head, and at most once per PR per scan. At 100 a page, a PR's
 * whole history (GitHub lists up to 250 commits) takes one to three calls.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param ghCommandFn - Function to run gh commands
 * @returns The commits, or null when they cannot be read — the caller then
 *   keeps the review actionable
 */
export async function fetchPrCommitProvenance(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<CommitProvenance[] | null> {
  try {
    // With --paginate, `--jq '.[] | {…}'` prints one compact object per line.
    const output = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/pulls/${prNumber}/commits?per_page=100`,
      "--jq",
      ".[] | {authorLogin: .author.login, committerLogin: .committer.login, committedAt: .commit.committer.date, parentCount: (.parents | length)}",
    ]);
    const commits: CommitProvenance[] = [];
    for (const line of output.split("\n")) {
      if (line.trim() === "") continue;
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object") return null;
      const record = parsed as Record<string, unknown>;
      commits.push({
        authorLogin: typeof record["authorLogin"] === "string"
          ? record["authorLogin"]
          : null,
        committerLogin: typeof record["committerLogin"] === "string"
          ? record["committerLogin"]
          : null,
        committedAt: typeof record["committedAt"] === "string"
          ? record["committedAt"]
          : null,
        parentCount: typeof record["parentCount"] === "number"
          ? record["parentCount"]
          : undefined,
      });
    }
    return commits;
  } catch {
    // Unreadable history — the caller keeps the review actionable.
    return null;
  }
}
