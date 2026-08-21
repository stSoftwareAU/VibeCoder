/**
 * PR maintenance and scanning functions (Issue #967).
 *
 * Provides the scanning/maintenance operations that run at high priority
 * in the main worker loop:
 * - findPrCommentsToFix — scan for actionable PR comments
 * - findFailedPrChecks — scan for spelling check failures
 * - findFailedCiChecks — scan for CI failures (with retry limits)
 * - updateOpenPrBranches — keep PR branches current with base
 * - ensureAutoMergeOnOpenPrs — enable auto-merge where missing
 * - closeIssuesForMergedPrs — close issues for merged PRs
 *
 * Migrated from the scanning/orchestration functions in issue_worker.sh.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import { verifyMergeLanded } from "./merge_landing.ts";
import type { CommentType, PrCommentToFix } from "./pr_comments.ts";
import type { FailedCiCheck } from "./pr_ci_checks.ts";
import {
  encodeBase64,
  getCiCheckRetryCount,
  isSpellingCheck,
} from "./pr_ci_checks.ts";
import { fetchFailedCheckRunsBatch } from "./check_runs_batch.ts";
import { resolveFleetMaintenanceAuthorSet } from "./fleet_authors.ts";
import {
  fetchPrHeadCommit,
  isCommentSuperseded,
  type PrHeadCommit,
} from "./pr_comment_supersession.ts";
import { listInvitedHumanPrs } from "./pr_invitation_lookup.ts";
import { clearAutoFixAttemptsForLocus } from "./auto_fix_attempt_tracker.ts";
import type { IssueCache } from "./issue_cache.ts";
import { fetchAllIssues } from "./issue_query.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import {
  handleMergeAttempt,
  type HandleMergeAttemptOptions,
  type MergeAttemptHandling,
  type MergeAttemptOutcome,
} from "./merge_block_escalation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A PR listing entry from the GitHub API. */
export interface PrEntry {
  number: number;
  headRefName: string;
  headRefOid?: string;
  baseRefName?: string;
  autoMergeRequest?: { mergeMethod: string } | null;
  title?: string;
}

/** Comment entry from the GitHub API. */
export interface CommentEntry {
  login: string;
  id: number;
  body: string;
  thumbs_up: number;
  /** ISO-8601 creation time, used for fleet-push supersession (Issue #211). */
  created_at?: string;
}

/** Review entry from the GitHub API. */
export interface ReviewEntry {
  login: string;
  id: number;
  body: string;
  commit_id: string;
}

/** Check run entry from the GitHub API. */
export interface CheckRunEntry {
  id: number;
  name: string;
  status: string;
  conclusion: string;
}

/** Options for PR scanning functions. */
export interface PrScanOptions {
  /** GitHub username to filter PRs by. */
  githubUser: string;
  /** Repositories to scan. */
  repos: string[];
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Function to check if a repo is in the allowlist. */
  isRepoAllowed: (repo: string) => boolean;
  /** Function to check if a commenter is authorised. */
  isAuthorisedCommenter: (author: string) => boolean;
  /** Function to run gh commands (injectable for testing). */
  ghCommandFn: (args: string[]) => Promise<string>;
  /**
   * Shared TTL cache (Issue #4303). When present, the per-repo×author
   * open-PR listing is fetched once with the field superset
   * {@link PR_MAINTENANCE_LIST_FIELDS} and served to every scan from the
   * cache — the scans used to issue four to six identical listings per
   * repo per cycle.
   */
  cache?: IssueCache;
  /** Function to shuffle repos for fairness. */
  shuffleRepos?: (repos: string[]) => string[];
  /**
   * GitHub bot accounts whose **PR review comments** (line-level) are
   * auto-trusted as actionable without a thumbs-up reaction or
   * `authorisedCommenters` membership (Issue #1857).
   *
   * Only applies to `commentType === "review"`. Top-level issue comments
   * from these bots are still gated by thumbs-up / authorisation,
   * because top-level comments are the higher-injection-risk surface.
   */
  trustedReviewBots?: string[];
  /**
   * Additional GitHub logins of **sibling fleet hosts** whose open PRs
   * this host should also maintain (PR feedback + CI fixes).
   *
   * The fleet runs across machines, each authenticated as a different
   * GitHub account (e.g. `Vibecoderbot` on one host, `stsvcbot` on
   * another). PR maintenance is otherwise scoped per-host by author, so a
   * milestone PR raised by a sibling host that is busy elsewhere or down
   * would never get its blocking CI failure fixed by any peer. Listing the
   * sibling logins here lets every host rescue any fleet-authored PR.
   *
   * The host's own `githubUser` is always included implicitly; default
   * `[]` preserves the prior single-author behaviour exactly. Cross-fleet
   * pickup is collision-tolerant: concurrent PR-feedback handling already
   * de-duplicates via the shared `eyes` reaction, and a duplicated CI-fix
   * push is rejected by git as a non-fast-forward (the loser simply
   * retries), bounded by the existing per-check retry cap.
   */
  prAuthors?: string[];
  /**
   * Trusted authors (`allowed_authors`) — humans trusted to *instruct* the
   * worker, **not** authors whose PRs the scans maintain (Issue #4076).
   *
   * The scans resolve their author set through
   * `resolveFleetMaintenanceAuthorSet`, which deliberately excludes this
   * list: every scan claims, pushes to, comments on, or merges the PRs it
   * finds, and #4023 briefly widened them to `allowed_authors` so the
   * worker adopted a human's PR uninvited (TitlePage/tp-web-react#2312,
   * Issue #4074). The #4023 case — a human's red PR blocking a `work-on`
   * issue — is handled by nudging and escalating that PR, never by taking
   * it over.
   *
   * The field is retained for the explicit-invitation path (Issue #4077),
   * which consults it to admit a human PR the author has handed over.
   */
  allowedAuthors?: string[];
}

/** Options for auto-merge scanning. */
export interface AutoMergeOptions extends PrScanOptions {
  /** Function to get per-repo config values. */
  getRepoConfig: (repo: string, key: string) => string;
  /**
   * Function to enable auto-merge on a PR. `headRefName` is passed through
   * when known so the milestone open-children gate (Issue #3909) does not
   * need its own lookup.
   */
  enableAutoMergeFn: (
    repo: string,
    prNumber: number,
    headRefName?: string,
  ) => Promise<{ result: string; message: string }>;
  /**
   * Function to attempt direct merge as fallback. Returns the outcome so
   * the scan can act on it loudly (Issue #3584) — a swallowed failure is
   * what leaves a green fix PR sitting open in silence.
   */
  directMergeFn?: (
    repo: string,
    prNumber: number,
  ) => Promise<MergeAttemptOutcome>;
  /**
   * Handler for a merge attempt's outcome (Issue #3584). Defaults to
   * {@link handleMergeAttempt}, which updates a stale branch and escalates
   * a PR that cannot be landed. Injectable for testing.
   */
  handleMergeAttemptFn?: (
    options: HandleMergeAttemptOptions,
  ) => Promise<MergeAttemptHandling>;
  /** Label applied when a merge is escalated. Defaults to `needs-human`. */
  needsHumanLabel?: string;
  /** Needs-screenshot label name. */
  needsScreenshotLabel?: string;
  /**
   * Optional iteration-scoped issue cache (Issue #1808). When provided,
   * the per-PR `gh issue view --json labels` lookup is replaced with a
   * one-shot `fetchAllIssues` read so N PRs collapse to one network
   * call. Closed issues (absent from the open list) yield `false` for
   * the label check — the same behaviour as the per-issue path.
   */
  cache?: IssueCache;
}

/** Options for closing issues on merged PRs. */
export interface CloseIssuesOptions extends PrScanOptions {
  /** Function to extract issue number from PR title. */
  extractIssueNumber: (title: string) => string | null;
  /**
   * Merge-landing check (Issue #4396): an issue is closed only when its
   * merged PR's change actually reached the default branch (or a milestone
   * branch whose route there is still open). Defaults to
   * {@link verifyMergeLanded}; tests inject.
   */
  verifyMergeLandedFn?: typeof verifyMergeLanded;
  /**
   * Optional iteration-scoped issue cache (Issue #1808). When provided,
   * the per-PR `gh issue view --json state` lookup is replaced with a
   * one-shot `fetchAllIssues` read — issues present in the open list
   * are treated as `OPEN`, anything else as already-closed. After any
   * closure the cached `issues_all` payload is invalidated so
   * subsequent reads in the same iteration see fresh state.
   */
  cache?: IssueCache;
}

/** Result of an auto-merge scan. */
export interface AutoMergeResult {
  enabledCount: number;
  skippedCount: number;
  failedCount: number;
}

/** Result of a close-issues scan. */
export interface CloseIssuesResult {
  closedCount: number;
}

/** Options for CI check scanning with retry limits. */
export interface CiCheckScanOptions extends PrScanOptions {
  /** Maximum retries per check failure (default: 3). */
  maxRetries?: number;
  /** State directory for retry tracking. */
  stateDir?: string;
  /** Function to get a repo's default branch. */
  getDefaultBranch?: (repo: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * List open PRs for one or more authors in a repo.
 *
 * A single author string issues exactly one `gh pr list --author <user>`
 * call (the original behaviour). An array of fleet logins issues one call
 * per author and merges the results, de-duplicating by PR number, so a
 * host can also maintain PRs raised by sibling fleet hosts (see
 * {@link PrScanOptions.prAuthors}). A failure for one author is swallowed
 * so the others' PRs are still returned.
 *
 * @param repo - Repository in "owner/repo" format
 * @param author - GitHub username, or a list of fleet usernames
 * @param fields - JSON fields to request
 * @param ghCommandFn - Function to run gh commands
 * @returns Parsed PR entries (de-duplicated by number across authors)
 */
/**
 * The field superset one cached listing serves every Priority-1.x scan
 * with (Issue #4303). Each scan used to issue its own `gh pr list` per
 * repo×author with only the fields it needed — four to six identical
 * listings per cycle whose sole difference was `--json`. Fetching the
 * union once lets the shared cache serve them all; extra fields are
 * harmless to callers, which read only what they use.
 */
export const PR_MAINTENANCE_LIST_FIELDS =
  "number,title,headRefName,headRefOid,baseRefName,autoMergeRequest,createdAt,updatedAt,author,mergeable";

/**
 * Explicit page size for the cached superset listing (Issue #4303). The
 * uncached legacy path kept gh's default; the shared listing serves scans
 * (ci-nudge) that previously asked for up to 50, so it must not be
 * narrower than any consumer's old view.
 */
export const PR_MAINTENANCE_LIST_LIMIT = 100;

export async function listOpenPrs(
  repo: string,
  author: string | string[],
  fields: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  cache?: IssueCache,
): Promise<PrEntry[]> {
  const authors = (typeof author === "string" ? [author] : author)
    .filter((a) => a !== "");
  const seen = new Set<number>();
  const merged: PrEntry[] = [];
  for (const a of authors) {
    try {
      let parsed: unknown;
      const cacheKey = `prs_maint_${a}`;
      const cached = cache ? await cache.read<PrEntry[]>(repo, cacheKey) : null;
      if (cached !== null) {
        parsed = cached;
      } else {
        const output = await ghCommandFn([
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--author",
          a,
          "--json",
          // With a cache, fetch the superset so this one listing serves
          // every scan this cycle (Issue #4303); without one, request
          // exactly what the caller asked for, as before.
          cache ? PR_MAINTENANCE_LIST_FIELDS : fields,
          ...(cache ? ["--limit", String(PR_MAINTENANCE_LIST_LIMIT)] : []),
        ]);
        parsed = JSON.parse(output);
        if (cache && Array.isArray(parsed)) {
          await cache.write(repo, cacheKey, parsed);
        }
      }
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed as PrEntry[]) {
        if (typeof entry?.number === "number") {
          if (seen.has(entry.number)) continue;
          seen.add(entry.number);
        }
        merged.push(entry);
      }
    } catch {
      // Swallow this author's failure; continue with the remaining authors.
    }
  }
  return merged;
}

/**
 * List every open PR this scan may act on in `repo` (Issue #4077).
 *
 * Two sources, in order:
 *
 * 1. the **maintenance set** — PRs authored by accounts the fleet operates
 *    (`resolveFleetMaintenanceAuthorSet`, Issue #4076); plus
 * 2. any human-authored PR whose author has **explicitly invited** the
 *    worker, by applying the invite label or @mentioning the fleet
 *    (`listInvitedHumanPrs`). Each admission is logged with its cause.
 *
 * An uninvited human PR appears in neither, which is the #4074 default.
 * The invitation is re-evaluated on every scan, so dropping the label
 * removes the PR again on the next pass — no sticky state.
 *
 * @param repo - Repository in "owner/repo" format
 * @param scanAuthors - The resolved push-capable maintenance author set
 * @param fields - JSON fields the scan needs
 * @param options - The scan options (author configuration + gh runner)
 * @returns Fleet-authored PRs followed by invited human PRs
 */
export async function listActionablePrs(
  repo: string,
  scanAuthors: string[],
  fields: string,
  options: PrScanOptions,
): Promise<PrEntry[]> {
  const { githubUser, ghCommandFn, logger, prAuthors, allowedAuthors } =
    options;
  const prs = await listOpenPrs(
    repo,
    scanAuthors,
    fields,
    ghCommandFn,
    options.cache,
  );
  const invited = await listInvitedHumanPrs<PrEntry>({
    repo,
    githubUser,
    allowedAuthors,
    fleetPrAuthors: prAuthors,
    fields,
    ghCommandFn,
    log: (message) => logger.info(message),
    cache: options.cache,
  });
  const seen = new Set(prs.map((pr) => pr.number));
  for (const pr of invited) {
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    prs.push(pr);
  }
  return prs;
}

/**
 * List merged PRs for a user in a repo.
 *
 * @param repo - Repository in "owner/repo" format
 * @param githubUser - GitHub username
 * @param ghCommandFn - Function to run gh commands
 * @returns Parsed PR entries
 */
export async function listMergedPrs(
  repo: string,
  githubUser: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<PrEntry[]> {
  try {
    const output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--author",
      githubUser,
      "--json",
      "number,title",
    ]);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed as PrEntry[];
  } catch {
    return [];
  }
}

/**
 * Fetch comments of a specific type for a PR.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param commentType - Type of comments to fetch
 * @param ghCommandFn - Function to run gh commands
 * @returns Array of comment entries
 */
export async function fetchPrComments(
  repo: string,
  prNumber: number,
  commentType: "review" | "issue",
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<CommentEntry[]> {
  const apiPath = commentType === "review"
    ? `repos/${repo}/pulls/${prNumber}/comments`
    : `repos/${repo}/issues/${prNumber}/comments`;

  try {
    const output = await ghCommandFn([
      "api",
      apiPath,
      "--jq",
      '[.[] | select(.reactions.eyes == 0) | {login: .user.login, id: .id, body: .body, thumbs_up: (.reactions["+1"] // 0), created_at: .created_at}]',
    ]);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed as CommentEntry[];
  } catch {
    return [];
  }
}

/**
 * Fetch the logins of users who left a `+1` (thumbs-up) reaction on a
 * comment (Issue #2484).
 *
 * The list/issue comment endpoints expose only the **total** reaction
 * count, not who reacted, so a bare count cannot establish trust — any
 * untrusted user can self-react on their own comment. This helper hits
 * the per-comment reactions endpoint to resolve the actual reactor
 * logins so the caller can require an authorised reactor.
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentId - Comment ID
 * @param commentType - Whether this is a line-level review comment or a
 *   top-level issue comment (selects the reactions endpoint)
 * @param ghCommandFn - Function to run gh commands
 * @returns Logins of users who reacted with `+1` (empty on error)
 */
export async function fetchCommentThumbsUpReactors(
  repo: string,
  commentId: number,
  commentType: "review" | "issue",
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string[]> {
  const apiPath = commentType === "review"
    ? `repos/${repo}/pulls/comments/${commentId}/reactions`
    : `repos/${repo}/issues/comments/${commentId}/reactions`;

  try {
    const output = await ghCommandFn([
      "api",
      apiPath,
      "--jq",
      '[.[] | select(.content == "+1") | .user.login]',
    ]);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * Fetch PR reviews with CHANGES_REQUESTED state.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param ghCommandFn - Function to run gh commands
 * @returns Array of review entries
 */
async function fetchPrReviews(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<ReviewEntry[]> {
  try {
    const output = await ghCommandFn([
      "api",
      `repos/${repo}/pulls/${prNumber}/reviews`,
      "--jq",
      '[.[] | select(.state == "CHANGES_REQUESTED" and .body != "") | {login: .user.login, id: .id, body: .body, commit_id: .commit_id}]',
    ]);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed as ReviewEntry[];
  } catch {
    return [];
  }
}

/**
 * Fetch failed check runs for a branch.
 *
 * @param repo - Repository in "owner/repo" format
 * @param branchName - Branch to check
 * @param ghCommandFn - Function to run gh commands
 * @returns Array of failed check run entries
 */
export async function fetchFailedCheckRuns(
  repo: string,
  branchName: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<CheckRunEntry[]> {
  try {
    const output = await ghCommandFn([
      "api",
      `repos/${repo}/commits/${branchName}/check-runs`,
      "--jq",
      '.check_runs | [.[] | select(.conclusion == "failure") | {id: .id, name: .name, status: .status, conclusion: .conclusion}]',
    ]);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed as CheckRunEntry[];
  } catch {
    return [];
  }
}

/**
 * Build a per-PR failed-check-runs lookup for a repo (Issue #1806).
 *
 * Tries one batched GraphQL `statusCheckRollup` call covering every PR
 * in the list. On success returns a fast in-memory lookup. On any
 * GraphQL failure returns a lookup that falls back to the per-PR REST
 * helper (`fetchFailedCheckRuns`), preserving the original behaviour.
 *
 * Collapses N→ceil(N/25) GraphQL calls instead of 2N REST calls during
 * the PR maintenance scan.
 */
export async function buildFailedCheckRunsLookup(
  repo: string,
  prs: PrEntry[],
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<(pr: PrEntry) => Promise<CheckRunEntry[]>> {
  const prNumbers = prs.map((p) => p.number);
  const batch = await fetchFailedCheckRunsBatch(repo, prNumbers, ghCommandFn);
  if (batch !== null) {
    return (pr) => Promise.resolve(batch.get(pr.number) ?? []);
  }
  // GraphQL failed — fall back to per-PR REST path
  return (pr) => fetchFailedCheckRuns(repo, pr.headRefName, ghCommandFn);
}

/**
 * Fetch annotations for a check run.
 *
 * @param repo - Repository in "owner/repo" format
 * @param checkId - Check run ID
 * @param ghCommandFn - Function to run gh commands
 * @returns JSON string of annotations
 */
export async function fetchCheckAnnotations(
  repo: string,
  checkId: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string> {
  try {
    return await ghCommandFn([
      "api",
      `repos/${repo}/check-runs/${checkId}/annotations`,
      "--jq",
      "[.[] | {path: .path, start_line: .start_line, message: .message}]",
    ]);
  } catch {
    return "[]";
  }
}

/**
 * Extract an issue number from a branch name matching `issue-{num}-` pattern.
 *
 * @param branchName - The branch name
 * @returns Issue number string, or null if no match
 */
export function extractIssueFromBranch(branchName: string): string | null {
  const match = branchName.match(/^issue-(\d+)-/);
  return match ? match[1]! : null;
}

// ---------------------------------------------------------------------------
// findPrCommentsToFix
// ---------------------------------------------------------------------------

/**
 * Scan all open PRs for comments that need to be addressed.
 *
 * Checks review comments, issue comments, and PR reviews with
 * CHANGES_REQUESTED state. Filters by authorisation (authorised commenter
 * or thumbs-up reaction) and skips already-processed comments (eyes reaction).
 *
 * @param options - Scan options
 * @returns Result containing the first actionable comment, or null
 */
export async function findPrCommentsToFix(
  options: PrScanOptions,
): Promise<Result<PrCommentToFix | null>> {
  const {
    githubUser,
    repos,
    logger,
    isRepoAllowed,
    isAuthorisedCommenter,
    ghCommandFn,
    shuffleRepos,
    trustedReviewBots = [],
    prAuthors,
    allowedAuthors,
  } = options;

  const scanAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    allowedAuthors,
    fleetPrAuthors: prAuthors,
  });
  const orderedRepos = shuffleRepos ? shuffleRepos([...repos]) : [...repos];

  for (const repo of orderedRepos) {
    if (!isRepoAllowed(repo)) {
      logger.security(
        "REPO_NOT_ALLOWED",
        `Skipping repository '${repo}' — not in configured allowlist`,
      );
      continue;
    }

    const prs = await listActionablePrs(
      repo,
      scanAuthors,
      "number,headRefName,headRefOid",
      options,
    );

    for (const pr of prs) {
      const { number: prNumber, headRefName: branchName, headRefOid } = pr;

      // Issue #211: resolve the head commit at most once per PR, and only
      // when a comment is otherwise about to be claimed.
      let headCommitCache: PrHeadCommit | null | undefined;
      const supersession: PrCommentSupersessionContext = {
        fleetAuthors: scanAuthors,
        headCommit: async () => {
          if (headCommitCache === undefined) {
            headCommitCache = headRefOid
              ? await fetchPrHeadCommit(repo, headRefOid, ghCommandFn)
              : null;
          }
          return headCommitCache;
        },
      };

      // Check review comments (inline)
      const reviewComment = await findActionableComment(
        repo,
        prNumber,
        "review",
        githubUser,
        isAuthorisedCommenter,
        ghCommandFn,
        logger,
        trustedReviewBots,
        supersession,
      );
      if (reviewComment) {
        return {
          ok: true,
          value: {
            ...reviewComment,
            branchName,
          },
        };
      }

      // Check issue comments
      const issueComment = await findActionableComment(
        repo,
        prNumber,
        "issue",
        githubUser,
        isAuthorisedCommenter,
        ghCommandFn,
        logger,
        trustedReviewBots,
        supersession,
      );
      if (issueComment) {
        return {
          ok: true,
          value: {
            ...issueComment,
            branchName,
          },
        };
      }

      // Check PR reviews (CHANGES_REQUESTED)
      const reviews = await fetchPrReviews(repo, prNumber, ghCommandFn);
      for (const review of reviews) {
        if (!review.body) continue;
        if (review.login === githubUser) continue;

        // Skip if commits pushed since review
        if (headRefOid && review.commit_id !== headRefOid) {
          logger.debug("Skipping stale CHANGES_REQUESTED review", {
            reviewId: review.id,
            commitId: review.commit_id,
            headSha: headRefOid,
          });
          continue;
        }

        const encodedBody = encodeBase64(review.body);
        return {
          ok: true,
          value: {
            repo,
            prNumber,
            branchName,
            commentType: "pr_review" as CommentType,
            commentId: String(review.id),
            encodedBody,
          },
        };
      }
    }
  }

  return { ok: true, value: null };
}

/**
 * Fleet-push supersession context for one PR (Issue #211). `headCommit` is
 * lazy and memoised by the caller so the extra API call is made only when a
 * comment would otherwise be claimed.
 */
interface PrCommentSupersessionContext {
  fleetAuthors: string[];
  headCommit: () => Promise<PrHeadCommit | null>;
}

/** Whether a fleet push already answered this comment (Issue #211). */
async function isSupersededByFleetPush(
  comment: CommentEntry,
  context: PrCommentSupersessionContext,
): Promise<boolean> {
  return isCommentSuperseded({
    commentCreatedAt: comment.created_at,
    headCommit: await context.headCommit(),
    fleetAuthors: context.fleetAuthors,
  });
}

/**
 * Find the first actionable comment of a given type on a PR.
 *
 * A comment is actionable when any of the following is true:
 * - the author is in `authorisedCommenters`
 * - the comment has a thumbs-up reaction **from an authorised user**
 *   (Issue #2484) — a bare `+1` count is not trusted because any
 *   untrusted user can self-react on their own comment; the reactor's
 *   login is resolved and checked against `authorisedCommenters`
 * - the comment is a `review`-type comment **and** the author is in
 *   `trustedReviewBots` (Issue #1857). This third path applies only to
 *   line-level review comments — top-level issue comments still require
 *   an authorised thumbs-up or authorisation, because top-level comments
 *   are the higher-injection-risk surface.
 *
 * An otherwise-actionable comment is skipped when a fleet author pushed the
 * PR head after it was written (Issue #211) — a sibling host has already
 * addressed it, so claiming it now duplicates that run and collides with its
 * push. The comment stays unclaimed and is re-evaluated on the next scan.
 */
async function findActionableComment(
  repo: string,
  prNumber: number,
  commentType: "review" | "issue",
  githubUser: string,
  isAuthorisedCommenter: (author: string) => boolean,
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: Logger,
  trustedReviewBots: string[] = [],
  supersession?: PrCommentSupersessionContext,
): Promise<Omit<PrCommentToFix, "branchName"> | null> {
  const comments = await fetchPrComments(
    repo,
    prNumber,
    commentType,
    ghCommandFn,
  );

  for (const comment of comments) {
    // Skip own comments to avoid infinite loops
    if (comment.login === githubUser) continue;

    const isAuthorised = isAuthorisedCommenter(comment.login);
    const isTrustedReviewBot = commentType === "review" &&
      trustedReviewBots.includes(comment.login);

    // A bare `+1` count proves nothing — any untrusted user can react on
    // their own comment. Only treat thumbs-up as trust when at least one
    // reactor is an authorised user (Issue #2484). Resolve reactors only
    // when there is a count to check and the comment is not already
    // trusted by another path, to avoid a needless reactions API call.
    let hasAuthorisedThumbsUp = false;
    if (!isAuthorised && !isTrustedReviewBot && (comment.thumbs_up ?? 0) > 0) {
      const reactors = await fetchCommentThumbsUpReactors(
        repo,
        comment.id,
        commentType,
        ghCommandFn,
      );
      hasAuthorisedThumbsUp = reactors.some((login) =>
        isAuthorisedCommenter(login)
      );
    }

    if (isAuthorised || hasAuthorisedThumbsUp || isTrustedReviewBot) {
      // Issue #211: a fleet sibling pushed after this comment — it has already
      // been answered by that push. Leave it unclaimed for re-evaluation.
      if (
        supersession && await isSupersededByFleetPush(comment, supersession)
      ) {
        logger.info("Skipping PR comment superseded by a fleet push", {
          repo,
          prNumber,
          author: comment.login,
          commentType,
          commentCreatedAt: comment.created_at,
          headPushedAt: (await supersession.headCommit())?.committedAt,
          headAuthor: (await supersession.headCommit())?.authorLogin,
        });
        continue;
      }

      const trustReason = isAuthorised
        ? "authorised"
        : hasAuthorisedThumbsUp
        ? "thumbs-up"
        : "trusted-bot";
      logger.info("Found actionable PR comment", {
        repo,
        prNumber,
        author: comment.login,
        commentType,
        authorised: isAuthorised,
        trustReason,
      });

      const encodedBody = encodeBase64(comment.body);
      return {
        repo,
        prNumber,
        commentType: commentType as CommentType,
        commentId: String(comment.id),
        encodedBody,
        commentAuthor: comment.login,
      };
    } else {
      logger.debug(
        "Ignoring comment without authorised commenter or thumbs-up",
        {
          repo,
          prNumber,
          author: comment.login,
          commentType,
        },
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// findFailedPrChecks (spelling only)
// ---------------------------------------------------------------------------

/**
 * Scan open PRs for failed spelling checks.
 *
 * Returns the first spelling check failure found across all repos.
 *
 * @param options - Scan options
 * @returns Result containing the first failed spelling check, or null
 */
export async function findFailedPrChecks(
  options: PrScanOptions,
): Promise<Result<FailedCiCheck | null>> {
  const {
    githubUser,
    repos,
    logger,
    isRepoAllowed,
    ghCommandFn,
    shuffleRepos,
    prAuthors,
    allowedAuthors,
  } = options;

  const scanAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    allowedAuthors,
    fleetPrAuthors: prAuthors,
  });
  const orderedRepos = shuffleRepos ? shuffleRepos([...repos]) : [...repos];

  for (const repo of orderedRepos) {
    if (!isRepoAllowed(repo)) continue;

    const prs = await listActionablePrs(
      repo,
      scanAuthors,
      "number,headRefName",
      options,
    );

    // Batch all check-run lookups for this repo into a single GraphQL
    // call (Issue #1806), with REST fallback handled internally.
    const getFailedChecks = await buildFailedCheckRunsLookup(
      repo,
      prs,
      ghCommandFn,
    );

    for (const pr of prs) {
      const { number: prNumber, headRefName: branchName } = pr;

      const failedChecks = await getFailedChecks(pr);

      for (const check of failedChecks) {
        if (!isSpellingCheck(check.name)) continue;

        logger.info("Found failed spelling check", {
          repo,
          prNumber,
          checkName: check.name,
          checkId: check.id,
        });

        const annotationsJson = await fetchCheckAnnotations(
          repo,
          check.id,
          ghCommandFn,
        );
        const encodedAnnotations = encodeBase64(annotationsJson);

        return {
          ok: true,
          value: {
            repo,
            prNumber,
            branchName,
            checkId: String(check.id),
            checkName: check.name,
            encodedAnnotations,
          },
        };
      }
    }
  }

  return { ok: true, value: null };
}

// ---------------------------------------------------------------------------
// findFailedCiChecks (non-spelling, with retry limits)
// ---------------------------------------------------------------------------

/**
 * Scan open PRs for failed CI checks (excluding spelling).
 *
 * Prioritises failures on PRs targeting the default branch.
 * Respects retry limits — checks that exceeded max retries are skipped.
 *
 * @param options - CI check scan options
 * @returns Result containing the highest priority failed check, or null
 */
export async function findFailedCiChecks(
  options: CiCheckScanOptions,
): Promise<Result<FailedCiCheck | null>> {
  const {
    githubUser,
    repos,
    logger,
    isRepoAllowed,
    ghCommandFn,
    shuffleRepos,
    maxRetries = 3,
    stateDir = ".ci_check_state",
    getDefaultBranch,
    prAuthors,
    allowedAuthors,
  } = options;

  const scanAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    allowedAuthors,
    fleetPrAuthors: prAuthors,
  });
  const orderedRepos = shuffleRepos ? shuffleRepos([...repos]) : [...repos];
  const defaultBranchFailures: FailedCiCheck[] = [];
  const otherFailures: FailedCiCheck[] = [];

  for (const repo of orderedRepos) {
    if (!isRepoAllowed(repo)) continue;

    let defaultBranch = "main"; // allow-hardcoded-branch — fallback after dynamic detection
    if (getDefaultBranch) {
      try {
        defaultBranch = await getDefaultBranch(repo);
      } catch {
        // Fall back to "main"
      }
    }

    const prs = await listActionablePrs(
      repo,
      scanAuthors,
      "number,headRefName,baseRefName",
      options,
    );

    // Batch all check-run lookups for this repo into a single GraphQL
    // call (Issue #1806), with REST fallback handled internally.
    const getFailedChecks = await buildFailedCheckRunsLookup(
      repo,
      prs,
      ghCommandFn,
    );

    for (const pr of prs) {
      const {
        number: prNumber,
        headRefName: branchName,
        baseRefName: baseRef,
      } = pr;

      const failedChecks = await getFailedChecks(pr);

      // Issue #3582: a PR with no failing checks is green, so every
      // auto-fix signature recorded against it starts from a fresh budget.
      // A recurring-but-different flake must not inherit a spent budget.
      if (failedChecks.length === 0) {
        const cleared = await clearAutoFixAttemptsForLocus(
          stateDir,
          repo,
          { kind: "pr", number: prNumber },
        );
        if (cleared > 0) {
          logger.info("Cleared auto-fix attempt counters after green build", {
            repo,
            prNumber,
            cleared,
          });
        }
      }

      for (const check of failedChecks) {
        // Skip spelling checks — handled by findFailedPrChecks
        if (isSpellingCheck(check.name)) continue;

        // Check retry count
        const retryCount = await getCiCheckRetryCount(
          stateDir,
          repo,
          String(check.id),
        );
        if (retryCount >= maxRetries) {
          logger.warn("CI check exceeded max retries — skipping", {
            repo,
            prNumber,
            checkName: check.name,
            retries: retryCount,
            maxRetries,
          });
          continue;
        }

        logger.info("Found failed CI check", {
          repo,
          prNumber,
          checkName: check.name,
          checkId: check.id,
        });

        const annotationsJson = await fetchCheckAnnotations(
          repo,
          check.id,
          ghCommandFn,
        );
        const encodedAnnotations = encodeBase64(annotationsJson);

        const failedCheck: FailedCiCheck = {
          repo,
          prNumber,
          branchName,
          checkId: String(check.id),
          checkName: check.name,
          encodedAnnotations,
        };

        // Prioritise failures on PRs targeting the default branch
        if (baseRef === defaultBranch) {
          defaultBranchFailures.push(failedCheck);
        } else {
          otherFailures.push(failedCheck);
        }
      }
    }
  }

  // Return highest priority failure
  if (defaultBranchFailures.length > 0) {
    return { ok: true, value: defaultBranchFailures[0] ?? null };
  }
  if (otherFailures.length > 0) {
    return { ok: true, value: otherFailures[0] ?? null };
  }

  return { ok: true, value: null };
}

// ---------------------------------------------------------------------------
// ensureAutoMergeOnOpenPrs
// ---------------------------------------------------------------------------

/**
 * Enable auto-merge on open PRs that don't have it enabled.
 *
 * Respects skip_auto_merge config and needs-screenshot label.
 *
 * Merge-path precedence is deterministic, not a race (Issue #3584):
 * GitHub's native auto-merge is always tried first, and direct merge is
 * only the fallback when native auto-merge is *not allowed* (an
 * unprotected target branch). Native auto-merge is idempotent, so a
 * consuming repo's own `auto-merge.yml` arming the same PR converges on
 * the identical state rather than competing with the worker.
 *
 * Every outcome is then handled loudly by {@link handleMergeAttempt}: a
 * stale branch is updated so its checks re-run, and a PR that cannot be
 * landed gets an explanatory comment plus `needs-human`.
 *
 * The scan lists PRs the fleet itself authored (host login + `prAuthors`
 * — Issue #4076), so a PR from outside the fleet, including a trusted
 * human's, is never merged, commented on, or escalated by this path.
 *
 * @param options - Auto-merge scan options
 * @returns Result containing scan statistics
 */
export async function ensureAutoMergeOnOpenPrs(
  options: AutoMergeOptions,
): Promise<Result<AutoMergeResult>> {
  const {
    githubUser,
    repos,
    logger,
    isRepoAllowed,
    ghCommandFn,
    getRepoConfig,
    enableAutoMergeFn,
    directMergeFn,
    needsScreenshotLabel = "needs-screenshot",
    needsHumanLabel = "needs-human",
    handleMergeAttemptFn = handleMergeAttempt,
    cache,
    prAuthors,
    allowedAuthors,
  } = options;

  const scanAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    allowedAuthors,
    fleetPrAuthors: prAuthors,
  });

  let enabledCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const repo of repos) {
    if (!isRepoAllowed(repo)) continue;

    const skipAutoMerge = getRepoConfig(repo, "skip_auto_merge");
    if (skipAutoMerge === "true") {
      logger.info("Auto-merge disabled for repo", { repo });
      continue;
    }

    const prs = await listActionablePrs(
      repo,
      scanAuthors,
      "number,headRefName,autoMergeRequest",
      options,
    );

    // Issue #1808: build a per-repo label lookup from the cached
    // open-issues list once. Per-PR `gh issue view --json labels`
    // calls disappear on the warm path; closed issues (absent from
    // this map) fall back to the per-issue helper, which mirrors the
    // pre-cache behaviour.
    const issueLabelsByNumber = await buildOpenIssueLabelsMap(
      repo,
      cache,
      ghCommandFn,
    );

    for (const pr of prs) {
      const { number: prNumber, headRefName: branchName } = pr;

      // Check if auto-merge already enabled
      if (pr.autoMergeRequest?.mergeMethod) {
        skippedCount++;
        continue;
      }

      // Check if linked issue has needs-screenshot label
      const linkedIssue = extractIssueFromBranch(branchName);
      if (linkedIssue) {
        const hasLabel = await checkIssueHasLabel(
          repo,
          linkedIssue,
          needsScreenshotLabel,
          ghCommandFn,
          issueLabelsByNumber,
        );
        if (hasLabel) {
          logger.info(
            "Skipping auto-merge — issue has needs-screenshot label",
            {
              repo,
              prNumber,
              issue: linkedIssue,
            },
          );
          skippedCount++;
          continue;
        }
      }

      logger.info("Enabling auto-merge", { repo, prNumber, branchName });

      const outcome = await attemptMerge(
        repo,
        prNumber,
        logger,
        enableAutoMergeFn,
        directMergeFn,
        branchName,
      );

      // Issue #3584: act on the outcome loudly — a stale branch is updated
      // so its checks re-run, and a PR that cannot be landed gets an
      // explanatory comment plus `needs-human`. Nothing is swallowed.
      const handling = await handleMergeAttemptFn({
        repo,
        prNumber,
        outcome,
        logger,
        ghFn: ghCommandFn,
        needsHumanLabel,
      });

      if (handling.disposition === "landed") {
        enabledCount++;
      } else if (handling.disposition === "escalate") {
        failedCount++;
      } else {
        skippedCount++;
      }
    }
  }

  logger.info("Auto-merge scan complete", {
    enabledCount,
    skippedCount,
    failedCount,
  });

  return {
    ok: true,
    value: { enabledCount, skippedCount, failedCount },
  };
}

/**
 * Try to arrange for a PR to merge, and report what happened (Issue #3584).
 *
 * Precedence: native auto-merge first; direct merge only when native
 * auto-merge is refused because the target branch is unprotected. Any
 * other result — including a thrown gh error — is a merge error, so the
 * caller escalates instead of counting a silent failure.
 */
async function attemptMerge(
  repo: string,
  prNumber: number,
  logger: Logger,
  enableAutoMergeFn: AutoMergeOptions["enableAutoMergeFn"],
  directMergeFn: AutoMergeOptions["directMergeFn"],
  headRefName?: string,
): Promise<MergeAttemptOutcome> {
  try {
    const result = await enableAutoMergeFn(repo, prNumber, headRefName);

    // "skipped" means auto-merge is deliberately disabled for this repo —
    // a configured choice, not a fault.
    if (result.result === "enabled" || result.result === "skipped") {
      return { kind: "landed" };
    }

    // Issue #3909: a milestone summary PR whose milestone still has open
    // children is deliberately left open — the gate has already logged and
    // commented, so this is a deferral, never an escalation.
    if (result.result === "blocked_open_children") {
      return { kind: "milestone_children_open" };
    }

    if (result.result === "not_allowed" && directMergeFn) {
      logger.info(
        "Auto-merge not available — attempting direct merge fallback",
        { repo, prNumber },
      );
      return await directMergeFn(repo, prNumber);
    }

    return { kind: "merge_error", message: result.message };
  } catch (error: unknown) {
    return {
      kind: "merge_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build a `Map<number, string[]>` of labels per open issue for a repo
 * (Issue #1808). Returns an empty map when no cache is supplied so
 * callers fall through to the per-issue helper.
 *
 * `fetchAllIssues` covers only open issues — closed issues are absent
 * from the map, and the label check returns `false` for them, which
 * matches the existing per-issue behaviour for issues that have lost
 * the label or been closed.
 */
async function buildOpenIssueLabelsMap(
  repo: string,
  cache: IssueCache | undefined,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (!cache) return map;
  let issues: FilterableIssue[];
  try {
    issues = await fetchAllIssues(repo, cache, 200, ghCommandFn);
  } catch {
    return map;
  }
  for (const issue of issues) {
    map.set(issue.number, issue.labels);
  }
  return map;
}

/**
 * Resolve whether an issue is currently OPEN. Prefers the cached
 * open-state map; on a map miss falls back to the per-issue
 * `gh issue view --json state` call (Issue #1808).
 */
async function isIssueOpen(
  repo: string,
  issueNumber: string,
  openStateMap: Map<number, "OPEN"> | null,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  if (openStateMap) {
    const num = Number(issueNumber);
    if (Number.isFinite(num)) {
      // Map covers all currently-open issues for this repo. Numbers
      // not in the map are already closed (or do not exist) — return
      // false without a network call.
      return openStateMap.has(num);
    }
  }
  const output = await ghCommandFn([
    "issue",
    "view",
    issueNumber,
    "--repo",
    repo,
    "--json",
    "state",
    "--jq",
    ".state",
  ]);
  return output.trim() === "OPEN";
}

/**
 * Build a `Map<number, "OPEN">` of open issues for a repo (Issue
 * #1808). Issues absent from the map are treated as already closed.
 */
async function buildOpenIssueStateMap(
  repo: string,
  cache: IssueCache | undefined,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Map<number, "OPEN"> | null> {
  if (!cache) return null;
  let issues: FilterableIssue[];
  try {
    issues = await fetchAllIssues(repo, cache, 200, ghCommandFn);
  } catch {
    return null;
  }
  const map = new Map<number, "OPEN">();
  for (const issue of issues) {
    map.set(issue.number, "OPEN");
  }
  return map;
}

/**
 * Check if an issue has a specific label.
 *
 * When `labelsByNumber` is provided and contains the issue, the
 * lookup is a local map read — no network call. Issues absent from
 * the map fall through to the per-issue `gh issue view --json labels`
 * call (the historical behaviour).
 */
async function checkIssueHasLabel(
  repo: string,
  issueNumber: string,
  labelName: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  labelsByNumber?: Map<number, string[]>,
): Promise<boolean> {
  if (labelsByNumber) {
    const num = Number(issueNumber);
    const labels = labelsByNumber.get(num);
    if (labels) {
      const lowered = labelName.toLowerCase();
      return labels.some((l) => l.toLowerCase() === lowered);
    }
    // Issue not in the open-issues map — treat as no label, mirroring
    // the pre-cache behaviour for closed issues (see Issue #1808).
    if (labelsByNumber.size > 0) return false;
  }
  try {
    const output = await ghCommandFn([
      "issue",
      "view",
      issueNumber,
      "--repo",
      repo,
      "--json",
      "labels",
      "--jq",
      '[.labels[].name] | join(",")',
    ]);
    return output.toLowerCase().includes(labelName.toLowerCase());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// closeIssuesForMergedPrs
// ---------------------------------------------------------------------------

/**
 * Close issues whose PRs have been merged (self-healing).
 *
 * Scans merged PRs, extracts issue numbers from titles, and closes
 * any that are still open.
 *
 * @param options - Close issues options
 * @returns Result containing the number of issues closed
 */
export async function closeIssuesForMergedPrs(
  options: CloseIssuesOptions,
): Promise<Result<CloseIssuesResult>> {
  const {
    githubUser,
    repos,
    logger,
    isRepoAllowed,
    ghCommandFn,
    extractIssueNumber,
    cache,
  } = options;

  let closedCount = 0;

  for (const repo of repos) {
    if (!isRepoAllowed(repo)) continue;

    const mergedPrs = await listMergedPrs(repo, githubUser, ghCommandFn);

    // Issue #1808: build a per-repo open-state map once. Issues absent
    // from the map are treated as already closed, so per-PR
    // `gh issue view --json state` calls disappear on the warm path.
    const openStateMap = await buildOpenIssueStateMap(
      repo,
      cache,
      ghCommandFn,
    );

    let mutated = false;

    for (const pr of mergedPrs) {
      const { number: prNumber, title: prTitle } = pr;
      if (!prTitle) continue;

      const issueNumber = extractIssueNumber(prTitle);
      if (!issueNumber) continue;

      // Check if issue is still open
      try {
        const isOpen = await isIssueOpen(
          repo,
          issueNumber,
          openStateMap,
          ghCommandFn,
        );

        if (isOpen) {
          // A merged PR is not a landed change (Issue #4396) — orphaned
          // work stays open, loudly, instead of closing as COMPLETED.
          const landing = await (options.verifyMergeLandedFn ??
            verifyMergeLanded)(repo, prNumber, ghCommandFn);
          if (!landing.landed) {
            logger.warn(
              `Not closing issue #${issueNumber}: PR #${prNumber} merged but did not land — ${landing.detail} (Issue #4396)`,
              { repo, issueNumber, prNumber, reason: landing.reason },
            );
            continue;
          }
          logger.info("Closing issue for merged PR", {
            repo,
            issueNumber,
            prNumber,
          });

          await ghCommandFn([
            "issue",
            "close",
            issueNumber,
            "--repo",
            repo,
            "--comment",
            `Closed automatically — PR #${prNumber} has been merged.`,
          ]);

          closedCount++;
          mutated = true;
        }
      } catch {
        logger.warn("Failed to process issue for merged PR", {
          repo,
          issueNumber,
          prNumber,
        });
      }
    }

    // Issue #1808: closing issues invalidates the cached open-issue
    // list so subsequent reads in the same iteration reflect the
    // closure.
    if (mutated && cache) {
      await cache.invalidate(repo, "issues_all");
    }
  }

  if (closedCount > 0) {
    logger.info("Issue closure complete", { closedCount });
  }

  return { ok: true, value: { closedCount } };
}
