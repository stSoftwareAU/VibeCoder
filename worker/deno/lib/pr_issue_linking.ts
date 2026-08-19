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
 * Return true if a PR title contains a reference to the given issue number.
 * Matches worker title conventions: "(#N)", "(Issue #N)", "(issue #N)".
 *
 * Uses string-includes rather than a dynamic RegExp to avoid any ReDoS risk
 * from interpolating external values into a regular expression.
 */
export function prTitleMatchesIssue(
  title: string,
  issueNumber: number,
): boolean {
  const n = String(Math.trunc(issueNumber));
  return title.includes(`(#${n})`) ||
    title.includes(`(Issue #${n})`) ||
    title.includes(`(issue #${n})`);
}

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
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param closedCooldownMs - Cooldown window for closed PRs in ms (default: 1 hour)
 * @returns Result with the PR URL, or error if not found
 */
export async function findExistingPrForIssue(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  closedCooldownMs: number = CLOSED_PR_COOLDOWN_MS,
  cache?: IssueCache,
): Promise<Result<string, Error>> {
  const issueStr = String(issueNumber);
  // Match worker-style "(#1574)" and human-style "(Issue #1574)" / "(issue #1574)".
  const titlePattern = new RegExp(`\\((?:[Ii]ssue\\s+)?#${issueStr}\\)`);

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
    );
    const openMatch = openPrs.find((pr) => titlePattern.test(pr.title));
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
    );
    const mergedMatch = mergedPrs.find((pr) => titlePattern.test(pr.title));
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
    );
    const closedMatch = pickRecentlyClosedMatch(
      closedPrs,
      titlePattern,
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
  const markerPattern = new RegExp(`vibe-worker-issue-${issueStr}([^0-9]|$)`);
  const statesToCheck: string[] = ["open", "merged", "closed"];

  for (const state of statesToCheck) {
    try {
      const fields = state === "closed"
        ? "number,title,body,url,closedAt"
        : "number,title,body,url";
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
      }> = JSON.parse(output.trim() || "[]");

      for (const pr of prs) {
        const titleMatch = titlePattern.test(pr.title);
        const markerMatch = pr.body ? markerPattern.test(pr.body) : false;

        if (!titleMatch && !markerMatch) continue;

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
  titlePattern: RegExp,
  cooldownMs: number,
): TitleSearchPR | null {
  const now = Date.now();
  for (const pr of prs) {
    if (!titlePattern.test(pr.title)) continue;
    if (pr.mergedAt) continue;
    const closedMs = pr.closedAt ? new Date(pr.closedAt).getTime() : 0;
    if (now - closedMs > cooldownMs) continue;
    return pr;
  }
  return null;
}

/**
 * Close duplicate PRs for a branch, keeping the specified one (Issue #623).
 *
 * @param repo - Repository in "owner/repo" format
 * @param branchName - The head branch
 * @param keepPrUrl - The PR URL to keep open
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Number of duplicates closed
 */
export async function closeDuplicatePrs(
  repo: string,
  branchName: string,
  keepPrUrl: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
  cache?: IssueCache,
): Promise<number> {
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
  let closedCount = 0;

  // Issue #1796: route the open-PR-by-branch lookup through
  // `fetchPRsByBranch` so per-branch checks collapse to one network
  // call per (branch, state) pair across the iteration.
  let candidates: Array<{ number: number; url: string }> = [];
  if (cache) {
    const prs = await fetchPRsByBranch(
      repo,
      branchName,
      "open",
      cache,
      ghCommandFn,
    );
    candidates = prs.map((pr) => ({
      number: pr.number,
      url: buildPrUrl(repo, pr.number),
    }));
  } else {
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
        "number,url",
        "--jq",
        '.[] | "\\(.number)|\\(.url)"',
      ]);

      for (const line of output.trim().split("\n")) {
        if (!line) continue;
        const [prNumberStr, url] = line.split("|");
        if (!prNumberStr) continue;
        candidates.push({ number: Number(prNumberStr), url: url ?? "" });
      }
    } catch {
      // API call failed — empty candidate list, return 0.
      return 0;
    }
  }

  // Mutation: invalidate the per-branch open-PR cache after closing
  // duplicates so subsequent reads in the same iteration see fresh state.
  let mutated = false;

  for (const cand of candidates) {
    const prNumberStr = String(cand.number);
    if (prNumberStr === keepPrNumber) continue;

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
    let mergedPrs: Array<{ number: number; title: string }>;
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
          "state,labels",
        ]);

        const issueData = JSON.parse(issueOutput) as {
          state: string;
          labels: Array<{ name: string }>;
        };

        if (issueData.state !== "OPEN") continue;

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
          `Closed automatically — PR has been merged.`,
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
