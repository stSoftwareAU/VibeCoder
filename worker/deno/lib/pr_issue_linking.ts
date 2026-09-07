/**
 * PR-to-issue linking for the Vibe Coder worker (Issue #915).
 *
 * Handles linking PRs to issues, closing issues for merged PRs,
 * finding existing PRs, and duplicate PR detection.
 *
 * Replaces the issue-linking functions from worker/shared/pr_manager.sh.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { IssueCache } from "./issue_cache.ts";
import {
  fetchClosedPRsByBranch,
  fetchMergedPRsByUser,
  fetchPRsByBranch,
  fetchPRsForIssueByTitle,
  invalidatePRsByBranch,
  type TitleSearchPR,
} from "./issue_query.ts";
import { extractIssueNumberFromPrTitle } from "./pr_body.ts";
import { filterOutWorkflowLabels } from "./workflow_labels.ts";
import { runGhOrThrow } from "./gh_spawn.ts";
import { verifyMergeLanded } from "./merge_landing.ts";
import {
  loadSweepWatermarks,
  saveSweepWatermarks,
} from "./merged_sweep_watermark.ts";

/** Build a canonical PR URL for the given repo and PR number. */
function buildPrUrl(repo: string, prNumber: number): string {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

/** Pattern for a valid GitHub PR URL (https://github.com/owner/repo/pull/123). */
const PR_URL_PATTERN = /^https?:\/\/.+\/pull\/\d+$/;

/**
 * Every worker issue marker in a PR body, as a literal pattern.
 *
 * Built from a literal rather than interpolating the issue number into
 * `new RegExp(...)`: a dynamic regex over an attacker-writable PR body is
 * a ReDoS surface the SAST gate refuses. The captured digits are compared
 * numerically, which also rules out `…-issue-42` matching issue 4.
 */
const WORKER_ISSUE_MARKER_PATTERN = /vibe-worker-issue-(\d+)/g;

/** True when `body` carries the worker marker for exactly `issueNumber`. */
function bodyHasWorkerIssueMarker(body: string, issueNumber: number): boolean {
  for (const match of body.matchAll(WORKER_ISSUE_MARKER_PATTERN)) {
    if (Number(match[1]) === issueNumber) return true;
  }
  return false;
}

// Issue #319: moved to a leaf module so `issue_query.ts` can use it without
// an import cycle. Re-exported here for the existing importers.
import { prTitleMatchesIssue } from "./pr_title_issue_ref.ts";
export { prTitleMatchesIssue };

/** Default gh command function — routed through the shared chokepoint. */
async function defaultGhCommand(args: string[]): Promise<string> {
  return await runGhOrThrow(args);
}

/**
 * Post a linking comment on the issue after PR creation (Issue #546).
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param prUrl - The URL of the created PR
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function linkPrToIssue(
  repo: string,
  issueNumber: number,
  prUrl: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<Result<void, Error>> {
  if (!prUrl || !PR_URL_PATTERN.test(prUrl)) {
    return {
      ok: false,
      error: new Error(`Invalid PR URL: '${prUrl}' — refusing to post comment`),
    };
  }

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      `Pull request ${prUrl} has been created to address this issue.`,
    ]);
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to link PR to issue #${issueNumber}: ${msg}`),
    };
  }
}

/**
 * Verify the linking comment exists on an issue (Issue #623).
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param prUrl - The PR URL to look for in comments
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns true if a matching comment was found
 */
export async function verifyIssueLinkComment(
  repo: string,
  issueNumber: number,
  prUrl: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<boolean> {
  try {
    const output = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      "[.[] | .body]",
    ]);
    return output.includes(prUrl);
  } catch {
    return false;
  }
}

/**
 * Post a linking comment with retry, checking for duplicates first (Issue #623).
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param prUrl - The URL of the created PR
 * @param maxRetries - Maximum retry attempts (default: 3)
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function postIssueLinkWithRetry(
  repo: string,
  issueNumber: number,
  prUrl: string,
  maxRetries = 3,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<Result<void, Error>> {
  // Check if comment already exists
  const exists = await verifyIssueLinkComment(
    repo,
    issueNumber,
    prUrl,
    ghCommandFn,
  );
  if (exists) {
    return { ok: true, value: undefined };
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await linkPrToIssue(repo, issueNumber, prUrl, ghCommandFn);
    if (result.ok) {
      return result;
    }
    if (attempt < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return {
    ok: false,
    error: new Error(
      `Failed to post linking comment on issue #${issueNumber} after ${maxRetries} attempts`,
    ),
  };
}

/**
 * Find an existing open PR for a branch (Issue #623).
 *
 * @param repo - Repository in "owner/repo" format
 * @param branchName - The head branch to search for
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result with the PR URL, or error if not found
 */
export async function findExistingPrForBranch(
  repo: string,
  branchName: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  cache?: IssueCache,
): Promise<Result<string, Error>> {
  if (!branchName) {
    return { ok: false, error: new Error("Branch name is empty") };
  }

  // Issue #1796: route through `fetchPRsByBranch` so per-branch lookups
  // share an iteration-scoped cache keyed by (branch, state).
  if (cache) {
    const prs = await fetchPRsByBranch(
      repo,
      branchName,
      "open",
      cache,
      ghCommandFn,
    );
    if (prs.length > 0 && prs[0]) {
      return { ok: true, value: buildPrUrl(repo, prs[0].number) };
    }
    return {
      ok: false,
      error: new Error(`No open PR found for branch '${branchName}'`),
    };
  }

  try {
    const output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branchName,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ]);
    const url = output.trim();
    if (url && url !== "null" && url !== "") {
      return { ok: true, value: url };
    }
  } catch {
    // No PR found
  }

  return {
    ok: false,
    error: new Error(`No open PR found for branch '${branchName}'`),
  };
}

/**
 * Find a closed-but-not-merged PR on the deterministic branch (Issue #3152).
 *
 * Branch names are deterministic (`issue-<n>-<slug>`), so a retry after a
 * first attempt whose PR was closed **unmerged** reuses the same branch.
 * Without this check the PR-creation path would `gh pr create` a fresh PR
 * on that branch, producing a duplicate. Reusing (reopening) the existing
 * PR is the fix.
 *
 * `gh pr list --state closed` returns merged PRs too, so this filters them
 * out via `mergedAt` — a **merged** prior PR means the issue is done for
 * the fleet and must never be reopened here. When several closed-unmerged
 * PRs exist for the branch, the highest-numbered (most recent) one is
 * returned.
 *
 * @param repo - Repository in "owner/repo" format
 * @param branchName - The deterministic head branch
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param cache - Optional iteration-scoped cache
 * @returns Result with the closed-unmerged PR URL, or error if none exists
 */
export async function findClosedUnmergedPrForBranch(
  repo: string,
  branchName: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  cache?: IssueCache,
): Promise<Result<string, Error>> {
  if (!branchName) {
    return { ok: false, error: new Error("Branch name is empty") };
  }

  const closed = await fetchClosedPRsByBranch(
    repo,
    branchName,
    cache,
    ghCommandFn,
  );

  // Only closed-not-merged PRs are eligible for reuse; pick the most recent.
  const unmerged = closed
    .filter((pr) => pr.mergedAt === null)
    .sort((a, b) => b.number - a.number);

  if (unmerged.length > 0 && unmerged[0]) {
    return { ok: true, value: buildPrUrl(repo, unmerged[0].number) };
  }

  return {
    ok: false,
    error: new Error(
      `No closed-unmerged PR found for branch '${branchName}'`,
    ),
  };
}

/**
 * Reopen a closed (not merged) PR so a retry reuses it (Issue #3152).
 *
 * Wraps `gh pr reopen`. GitHub rejects reopening a merged PR, so callers
 * must only pass closed-unmerged PR numbers (see
 * `findClosedUnmergedPrForBranch`). Best-effort: a failure is returned as
 * an error `Result` rather than thrown so the caller can log and fall
 * through.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - The PR number to reopen
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function reopenPr(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<Result<void, Error>> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, error: new Error(`Invalid PR number: ${prNumber}`) };
  }

  try {
    await ghCommandFn([
      "pr",
      "reopen",
      String(prNumber),
      "--repo",
      repo,
    ]);
    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Default cooldown window for recently-closed PR detection (1 hour).
 * Issue #1427: prevents rapid duplicate PR creation.
 */
const CLOSED_PR_COOLDOWN_MS = 3600 * 1000;

/**
 * Find an existing open PR for an issue number (Issue #869).
 *
 * Searches by PR title pattern "(#issue_number)" or body containing
 * the idempotency marker. Checks open PRs first, then merged, then
 * recently-closed (Issue #1427) — a recently-closed PR indicates the
 * worker already attempted this issue and should not immediately retry.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number to search for
 * A PR whose head branch lives in a fork is ignored (Issue #1124): the
 * title and the body are text anyone may write, and reading a stranger's
 * PR as "already handled" leaves the issue starved. The fail direction is
 * towards acting — the worker files rather than skips.
 *
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param closedCooldownMs - Cooldown window for closed PRs in ms (default: 1 hour)
 * @param cache - Iteration-scoped issue cache
 * @param log - Sink for the ignored-PR warning
 * @returns Result with the PR URL, or error if not found
 */
export async function findExistingPrForIssue(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  closedCooldownMs: number = CLOSED_PR_COOLDOWN_MS,
  cache?: IssueCache,
  log: (message: string) => void = console.error,
): Promise<Result<string, Error>> {
  // Issue #1796: when a cache is available, route every state through
  // `fetchPRsForIssueByTitle` so the per-issue search collapses to one
  // network call per (issue, state) pair across the iteration. The
  // legacy body-marker fallback is dropped from the cached path —
  // worker PRs always include the issue number in the title, and the
  // server-side `in:title` search matches that consistently.
  if (cache) {
    // Open: present means work in progress.
    const openPrs = await fetchPRsForIssueByTitle(
      repo,
      issueNumber,
      "open",
      cache,
      ghCommandFn,
      log,
    );
    const openMatch = openPrs.find((pr) =>
      prTitleMatchesIssue(pr.title, issueNumber)
    );
    if (openMatch) {
      return { ok: true, value: buildPrUrl(repo, openMatch.number) };
    }

    // Merged: present means work already done.
    const mergedPrs = await fetchPRsForIssueByTitle(
      repo,
      issueNumber,
      "merged",
      cache,
      ghCommandFn,
      log,
    );
    const mergedMatch = mergedPrs.find((pr) =>
      prTitleMatchesIssue(pr.title, issueNumber)
    );
    if (mergedMatch) {
      return { ok: true, value: buildPrUrl(repo, mergedMatch.number) };
    }

    // Closed-not-merged: only block within the cooldown window.
    const closedPrs = await fetchPRsForIssueByTitle(
      repo,
      issueNumber,
      "closed",
      cache,
      ghCommandFn,
      log,
    );
    const closedMatch = pickRecentlyClosedMatch(
      closedPrs,
      issueNumber,
      closedCooldownMs,
    );
    if (closedMatch) {
      return { ok: true, value: buildPrUrl(repo, closedMatch.number) };
    }

    return {
      ok: false,
      error: new Error(`No PR found for issue #${issueNumber}`),
    };
  }

  // Uncached fallback path (legacy body-marker matching retained).
  const statesToCheck: string[] = ["open", "merged", "closed"];

  for (const state of statesToCheck) {
    try {
      // `author` and `isCrossRepository` mirror the cached path
      // (Issue #1124): a PR title and body are attacker-writable on a
      // public repository, and a match here suppresses work on the issue.
      const fields = state === "closed"
        ? "number,title,body,url,closedAt,author,isCrossRepository"
        : "number,title,body,url,author,isCrossRepository";
      const output = await ghCommandFn([
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        state,
        "--json",
        fields,
        "--limit",
        "50",
      ]);

      const prs: Array<{
        number: number;
        title: string;
        body?: string;
        url: string;
        closedAt?: string;
        author?: { login?: string };
        isCrossRepository?: boolean;
      }> = JSON.parse(output.trim() || "[]");

      for (const pr of prs) {
        const titleMatch = prTitleMatchesIssue(pr.title, issueNumber);
        const markerMatch = pr.body
          ? bodyHasWorkerIssueMarker(pr.body, issueNumber)
          : false;

        if (!titleMatch && !markerMatch) continue;

        // A fork-headed PR proves nothing: anybody may open one with any
        // title and body, and treating it as "already handled" starves the
        // issue. Pushing the head branch into the target repository needs
        // write access, which is what makes a same-repository head
        // evidence (Issue #1124). The fail direction is towards acting.
        if (pr.isCrossRepository === true) {
          log(
            `[pr-linking] ${repo}#${issueNumber}: ignoring PR #${pr.number} ` +
              `by ${pr.author?.login ?? "an unknown author"} — its head ` +
              `branch is in a fork, so its title is not evidence the fleet ` +
              `opened it.`,
          );
          continue;
        }

        // For closed PRs, only block if closed within the cooldown window
        if (state === "closed") {
          const closedTime = pr.closedAt ? new Date(pr.closedAt).getTime() : 0;
          if (Date.now() - closedTime > closedCooldownMs) continue;
        }

        return { ok: true, value: pr.url };
      }
    } catch {
      // API call failed for this state — continue to next
    }
  }

  return {
    ok: false,
    error: new Error(`No PR found for issue #${issueNumber}`),
  };
}

/**
 * Find a closed (not merged) PR whose title matches and whose closedAt
 * falls within the cooldown window. PRs with a non-null `mergedAt` are
 * skipped — those have already been picked up by the merged-state pass.
 */
function pickRecentlyClosedMatch(
  prs: TitleSearchPR[],
  issueNumber: number,
  cooldownMs: number,
): TitleSearchPR | null {
  const now = Date.now();
  for (const pr of prs) {
    if (!prTitleMatchesIssue(pr.title, issueNumber)) continue;
    if (pr.mergedAt) continue;
    const closedMs = pr.closedAt ? new Date(pr.closedAt).getTime() : 0;
    if (now - closedMs > cooldownMs) continue;
    return pr;
  }
  return null;
}

/** Options for {@link closeDuplicatePrs} (Issues #623, #1264). */
export interface CloseDuplicatePrsOptions {
  /**
   * Iteration-scoped cache for the per-branch open-PR lookup (Issue #1796).
   */
  cache?: IssueCache;
  /**
   * Fleet logins whose PRs this worker may close — the push-capable
   * maintenance set (`resolveFleetMaintenanceAuthorSet`), never the
   * defer-to set, because closing a PR is acting on it.
   *
   * When empty, the acting `gh` login is resolved from the API and used
   * as the sole allowed author. A candidate authored by anyone else is
   * left alone (Issue #1264).
   */
  allowedAuthors?: readonly string[];
  /**
   * Report-only mode — **defaults to `true`**.
   *
   * Closing someone's PR is destructive and irreversible in effect, so the
   * safe outcome is the default and every caller that really means to close
   * states it (Issue #1264). In dry-run the return value is the number of
   * duplicates that *would* be closed and each one is logged.
   */
  dryRun?: boolean;
  /** Log sink for skip/dry-run reporting (injectable for testing). */
  log?: (message: string) => void;
}

/** Normalise a GitHub login for comparison — logins are case-insensitive. */
function normaliseLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * Resolve the set of logins whose PRs this worker may close (Issue #1264).
 *
 * Returns an empty set when no author can be established — the caller must
 * then close nothing, because "author unknown" can never authorise a close.
 */
async function resolveCloseAuthorSet(
  allowedAuthors: readonly string[],
  ghCommandFn: (args: string[]) => Promise<string>,
  log: (message: string) => void,
): Promise<Set<string>> {
  const set = new Set<string>();
  for (const author of allowedAuthors) {
    const key = normaliseLogin(author);
    if (key) set.add(key);
  }
  if (set.size > 0) return set;

  // No configured set — fall back to the acting `gh` login, the same
  // identity check `merge_if_checks_passed` makes before it merges.
  try {
    const login = normaliseLogin(
      await ghCommandFn(["api", "user", "--jq", ".login"]),
    );
    if (login) set.add(login);
  } catch (error: unknown) {
    // Unresolvable identity: the empty set makes the caller close nothing.
    // The cause travels with it so the refusal names why, not just what.
    log(
      `closeDuplicatePrs: could not resolve the acting gh login — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return set;
}

/**
 * Close duplicate PRs for a branch, keeping the specified one (Issue #623).
 *
 * Only the fleet's own duplicates are ever closed (Issue #1264).
 * `gh pr list --head <branch>` filters on `headRefName` alone, so it also
 * returns PRs opened from forks and PRs opened by third parties — and the
 * worker's branch convention (`issue-<n>-<slug>`) is public and trivially
 * guessable. Without an ownership check, naming a branch that way was
 * enough to have an outsider's PR closed by the service account with a
 * misleading "duplicate" comment. Every candidate must therefore be
 * authored by an allowed fleet login **and** live in the target repo.
 *
 * @param repo - Repository in "owner/repo" format
 * @param branchName - The head branch
 * @param keepPrUrl - The PR URL to keep open
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param options - Ownership, dry-run and cache options
 * @returns Number of duplicates closed (in dry-run, the number that would be)
 */
export async function closeDuplicatePrs(
  repo: string,
  branchName: string,
  keepPrUrl: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  options: CloseDuplicatePrsOptions = {},
): Promise<number> {
  const { cache, dryRun = true, log = console.error } = options;

  if (!branchName) {
    return 0;
  }

  // Extract PR number safely — refuse to proceed with an invalid URL.
  // Without this guard, a non-URL (e.g. an error message) produces a
  // keepPrNumber that matches nothing, causing ALL open PRs to be closed.
  const prNumberMatch = keepPrUrl.match(/\/pull\/(\d+)$/);
  if (!prNumberMatch) {
    return 0;
  }
  const keepPrNumber = prNumberMatch[1]!;

  const repoOwner = normaliseLogin(repo.split("/")[0] ?? "");
  if (!repoOwner) {
    log(`closeDuplicatePrs: refusing — "${repo}" is not owner/repo`);
    return 0;
  }

  const allowedLogins = await resolveCloseAuthorSet(
    options.allowedAuthors ?? [],
    ghCommandFn,
    log,
  );
  if (allowedLogins.size === 0) {
    // Fail loud and closed: with no identity there is no PR we own.
    log(
      `closeDuplicatePrs: refusing to close any PR on ${branchName} in ` +
        `${repo} — no fleet author set and the acting gh login could not ` +
        `be resolved (Issue #1264)`,
    );
    return 0;
  }

  let closedCount = 0;

  // Issue #1796: route the open-PR-by-branch lookup through
  // `fetchPRsByBranch` so per-branch checks collapse to one network
  // call per (branch, state) pair across the iteration.
  const candidates = await fetchPRsByBranch(
    repo,
    branchName,
    "open",
    cache,
    ghCommandFn,
  );

  // Mutation: invalidate the per-branch open-PR cache after closing
  // duplicates so subsequent reads in the same iteration see fresh state.
  let mutated = false;

  for (const cand of candidates) {
    const prNumberStr = String(cand.number);
    if (prNumberStr === keepPrNumber) continue;

    // Ownership gate (Issue #1264). Unknown author or unknown head
    // repository is "not ours" — the listing carries both fields, so a
    // missing one means a stale cache entry, never permission.
    const author = normaliseLogin(cand.author ?? "");
    if (!author || !allowedLogins.has(author)) {
      log(
        `closeDuplicatePrs: leaving PR #${prNumberStr} in ${repo} open — ` +
          `author "${cand.author ?? "unknown"}" is not a fleet author`,
      );
      continue;
    }
    // The head must live in the target repo itself. `isCrossRepository`
    // is the field the rest of the codebase uses for this question, and
    // it also catches a fork under the *same* owner that an owner-only
    // comparison would wave through.
    const headOwner = normaliseLogin(cand.headRepositoryOwner ?? "");
    if (headOwner !== repoOwner || cand.isCrossRepository !== false) {
      log(
        `closeDuplicatePrs: leaving PR #${prNumberStr} in ${repo} open — ` +
          `its head is not a branch of ${repo} (owner ` +
          `"${cand.headRepositoryOwner ?? "unknown"}", cross-repository ` +
          `${cand.isCrossRepository ?? "unknown"})`,
      );
      continue;
    }

    if (dryRun) {
      log(
        `closeDuplicatePrs: dry run — would close PR #${prNumberStr} in ` +
          `${repo} as a duplicate of #${keepPrNumber}`,
      );
      closedCount++;
      continue;
    }

    try {
      await ghCommandFn([
        "pr",
        "close",
        prNumberStr,
        "--repo",
        repo,
        "--comment",
        `Closing as duplicate — PR #${keepPrNumber} addresses the same branch. This duplicate was detected by the idempotent PR creation check (Issue #623).`,
      ]);
      closedCount++;
      mutated = true;
    } catch {
      // Individual close failure is not fatal
    }
  }

  if (mutated && cache) {
    await invalidatePRsByBranch(cache, repo, branchName, "open");
  }

  return closedCount;
}

/**
 * Update labels on an existing PR (Issue #1189).
 *
 * Applies the given labels to the PR, adding any that are not already present.
 * Workflow labels (e.g. `work-on`, `help wanted`, `planning`) are stripped
 * before the call — they signal worker pickup or processing state on the
 * issue and have no meaning on the PR (Issue #1711). This is best-effort —
 * label update failures are non-fatal.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - The PR number to update
 * @param labels - Labels to add to the PR
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function updatePrLabels(
  repo: string,
  prNumber: number,
  labels: string[],
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<Result<void, Error>> {
  // Issue #1711: drop workflow labels before they reach the PR.
  const filtered = filterOutWorkflowLabels(labels);
  if (filtered.length === 0) {
    return { ok: true, value: undefined };
  }

  try {
    const args = ["pr", "edit", String(prNumber), "--repo", repo];
    for (const label of filtered) {
      args.push("--add-label", label);
    }
    await ghCommandFn(args);
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to update labels on PR #${prNumber}: ${msg}`),
    };
  }
}

/**
 * Close issues whose PRs have been merged (Issue #546).
 *
 * Belt-and-suspenders approach — explicitly closes issues even when
 * GitHub's "Closes #N" keyword processing might fail.
 *
 * @param repos - Repositories to scan
 * @param githubUser - GitHub username whose merged PRs to check
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param planningLabel - Label marking deliberately-open planning issues
 * @param cache - Optional iteration-scoped cache (Issue #1787)
 * @param options - Reconcile watermark wiring (Issue #4256)
 * @returns Number of issues closed
 */
/**
 * Whether a merged PR could possibly be the fix for the issue its title names
 * (Issue #482).
 *
 * `"issue-predates-merge"` is the only verdict that permits a close. Both
 * other verdicts are refusals, but they differ in kind and the caller treats
 * them differently: `"issue-postdates-merge"` is permanent — the issue is
 * younger than the merge and can never become its subject — while
 * `"unknown"` is transient and worth deciding again next cycle.
 *
 * Equal timestamps count as predating: GitHub reports whole seconds, and a
 * genuine "PR merged, issue closed" pair can land inside one. The tie goes to
 * the historical behaviour, since a same-second collision with an unrelated
 * issue is not the failure mode this guard exists to stop.
 *
 * @param mergedAt - The PR's ISO-8601 merge time; `""`/absent means unknown.
 * @param createdAt - The issue's ISO-8601 creation time; `""`/absent means
 *   unknown.
 */
export function classifyMergeCloseOrdering(
  mergedAt: string | undefined,
  createdAt: string | undefined,
): "issue-predates-merge" | "issue-postdates-merge" | "unknown" {
  const merged = Date.parse(mergedAt ?? "");
  const created = Date.parse(createdAt ?? "");
  if (Number.isNaN(merged) || Number.isNaN(created)) return "unknown";
  return created <= merged ? "issue-predates-merge" : "issue-postdates-merge";
}

export async function closeIssuesForMergedPrs(
  repos: string[],
  githubUser: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  planningLabel = "planning",
  cache?: IssueCache,
  options?: {
    /**
     * Path of the per-repo reconcile watermark file (Issue #4256). When
     * set, merged PRs at or below the persisted watermark were already
     * reconciled on an earlier cycle and are skipped without an issue
     * view — this priority used to burn 4–6 minutes and up to 840
     * GraphQL views per cycle re-discovering that old issues are still
     * closed. Unset: every PR in the window is checked, as before.
     */
    watermarkPath?: string;
    /**
     * Merge-landing check (Issue #4396): close only when the merged PR's
     * change is reachable from the default branch (or sits on a milestone
     * branch whose route is still open). Defaults to
     * {@link verifyMergeLanded}; tests inject.
     */
    verifyMergeLandedFn?: typeof verifyMergeLanded;
  },
): Promise<number> {
  let closedCount = 0;

  const watermarkPath = options?.watermarkPath;
  const watermarks = watermarkPath
    ? await loadSweepWatermarks(watermarkPath)
    : {};
  let watermarksDirty = false;

  for (const repo of repos) {
    let mergedPrs: Array<{ number: number; title: string; mergedAt: string }>;
    try {
      // Issue #1787: route through `fetchMergedPRsByUser` so this
      // call reuses the iteration-scoped `prs_merged_${user}` cache.
      mergedPrs = await fetchMergedPRsByUser(
        repo,
        githubUser,
        cache,
        30,
        ghCommandFn,
      );
    } catch {
      // Repo-level failure is not fatal
      continue;
    }

    let mutated = false;
    const mark = watermarks[repo] ?? 0;
    // Lowest PR number still needing attention next cycle: a failed view
    // or close must be retried, and a planning issue stays deliberately
    // open — keep re-checking it until the label comes off or it closes.
    let holdBack = Infinity;
    let windowMax = 0;

    for (const pr of mergedPrs) {
      if (pr.number > windowMax) windowMax = pr.number;
      if (pr.number <= mark) continue;

      const issueResult = extractIssueNumberFromPrTitle(pr.title);
      if (!issueResult.ok) continue;
      const issueNumber = issueResult.value;

      try {
        const issueOutput = await ghCommandFn([
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          repo,
          "--json",
          "state,labels,createdAt",
        ]);

        const issueData = JSON.parse(issueOutput) as {
          state: string;
          labels: Array<{ name: string }>;
          createdAt?: string;
        };

        if (issueData.state !== "OPEN") continue;

        // Issue #482: a fix cannot predate the thing it fixes. Issues and PRs
        // share one number sequence, so a stale or invented reference in an
        // already-merged PR is otherwise a standing instruction to close
        // whatever later takes that number — which is how PR #476, merged at
        // 06:44Z naming a then-nonexistent "Issue #477", closed the unrelated
        // issue #477 filed at 06:53Z. The close is silent and destroys work.
        const ordering = classifyMergeCloseOrdering(
          pr.mergedAt,
          issueData.createdAt,
        );
        if (ordering !== "issue-predates-merge") {
          // `issue-postdates-merge` is permanent — the number can never
          // become this PR's subject, so it is watermarked away rather than
          // re-examined for ever. An `unknown` ordering is transient (a cache
          // entry written before `mergedAt` was collected), so it is held
          // back and decided next cycle: closing is destructive and
          // unprompted, while deferring costs one cycle.
          if (ordering === "unknown") holdBack = Math.min(holdBack, pr.number);
          continue;
        }

        if (issueData.labels.some((l) => l.name === planningLabel)) {
          holdBack = Math.min(holdBack, pr.number);
          continue;
        }

        // A merged PR is not a landed change (Issue #4396): held back, not
        // watermarked away, so an orphaned merge is re-examined next cycle
        // rather than silently forgotten.
        const landing = await (options?.verifyMergeLandedFn ??
          verifyMergeLanded)(repo, pr.number, ghCommandFn);
        if (!landing.landed) {
          holdBack = Math.min(holdBack, pr.number);
          continue;
        }

        await ghCommandFn([
          "issue",
          "close",
          String(issueNumber),
          "--repo",
          repo,
          "--comment",
          // Issue #482: name the PR. A wrong close must be traceable to its
          // cause from the issue alone, without reading the worker's logs.
          `Closed automatically — PR #${pr.number} has been merged.`,
        ]);
        closedCount++;
        mutated = true;
      } catch {
        // Individual issue close failure is not fatal — but it must be
        // retried next cycle rather than watermarked away (Issue #4256).
        holdBack = Math.min(holdBack, pr.number);
      }
    }

    if (watermarkPath && windowMax > 0) {
      const advanced = Math.max(mark, Math.min(windowMax, holdBack - 1));
      if (advanced !== mark) {
        watermarks[repo] = advanced;
        watermarksDirty = true;
      }
    }

    // Issue #1787: closing issues invalidates the cached open-issue
    // list so subsequent reads in the same iteration reflect the
    // closure.
    if (mutated && cache) {
      await cache.invalidate(repo, "issues_all");
    }
  }

  if (watermarkPath && watermarksDirty) {
    try {
      await saveSweepWatermarks(watermarkPath, watermarks);
    } catch {
      // Persistence is an optimisation — never fail the pass over it.
    }
  }

  return closedCount;
}
