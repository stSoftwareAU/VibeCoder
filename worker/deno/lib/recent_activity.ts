/**
 * Recent repository activity collection and formatting (Issue #1326).
 *
 * Collects recent merged PRs, commit history, and open worker PRs to provide
 * context in Claude prompts. Helps Claude avoid repeated discovery and
 * maintain consistency with recent development patterns.
 *
 * Features:
 * - Concise summary (under configurable token limit, default 1,000)
 * - Configurable PR and commit limits
 * - Built-in caching via IssueCache (5-minute TTL default)
 * - Graceful degradation on command failures
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { spawnGh } from "./gh_spawn.ts";
import { runGitCommand } from "./git_timeout.ts";
import { IssueCache } from "./issue_cache.ts";
import { fetchOpenPRsByUser, fetchRecentMergedPRs } from "./issue_query.ts";
import { sanitiseDelimiterPatterns } from "./prompt_delimiter.ts";

// =============================================================================
// Types
// =============================================================================

/** Summary of a recently merged PR. */
export interface MergedPrSummary {
  /** PR number. */
  number: number;
  /** PR title. */
  title: string;
  /** Number of files changed. */
  filesChanged: number;
}

/** Summary of an open worker PR. */
export interface OpenWorkerPr {
  /** PR number. */
  number: number;
  /** PR title. */
  title: string;
  /** Target branch (base ref). */
  targetBranch: string;
}

/** Raw collected activity data before formatting. */
export interface RecentActivityData {
  /** Recently merged PRs (most recent first). */
  mergedPrs: MergedPrSummary[];
  /** Recent commit one-line summaries from the default branch. */
  recentCommits: string[];
  /** Open PRs authored by the worker. */
  openWorkerPrs: OpenWorkerPr[];
}

/**
 * Injectable command runner for testing.
 *
 * Abstracts running git/gh commands so tests can provide mock implementations.
 */
export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<Result<string>>;

/** Options for collecting recent activity. */
export interface RecentActivityOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** GitHub username of the worker (for filtering open PRs). */
  githubUser: string;
  /** Maximum number of merged PRs to include (default: 10). */
  mergedPrLimit: number;
  /** Maximum number of recent commits to include (default: 20). */
  commitLimit: number;
  /** Injectable command runner (defaults to running real commands). */
  runner?: CommandRunner;
  /** Optional cache instance for brief caching. */
  cache?: IssueCache;
}

// =============================================================================
// Default command runner
// =============================================================================

/**
 * Default command runner that executes real git/gh commands.
 *
 * Issue #1378: both binaries go through their shared chokepoints rather than
 * a `Deno.Command` built from the `command` parameter — the indirection that
 * skipped the write-repo allowlist, the audit journal and the git timeout,
 * and that the quality gate's literal-string scan could not see. Only these
 * two binaries are collected here, so any other is refused loudly.
 */
async function defaultRunner(
  command: string,
  args: string[],
): Promise<Result<string>> {
  try {
    if (command === "gh") {
      const result = await spawnGh(args);
      return result.success ? { ok: true, value: result.stdout.trim() } : {
        ok: false,
        error: new Error(result.stderr.trim() || "Command failed"),
      };
    }
    if (command === "git") {
      const result = await runGitCommand(args);
      if (!result.ok) return result;
      return result.value.code === 0
        ? { ok: true, value: result.value.stdout.trim() }
        : {
          ok: false,
          error: new Error(result.value.stderr.trim() || "Command failed"),
        };
    }
    return {
      ok: false,
      error: new Error(
        `recent_activity only runs gh and git through their chokepoints; ` +
          `refusing to run "${command}"`,
      ),
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: new Error(err instanceof Error ? err.message : String(err)),
    };
  }
}

// =============================================================================
// Data collection
// =============================================================================

/**
 * Parse merged PR JSON output from gh CLI.
 *
 * Expected format from `gh pr list --json number,title,changedFiles`.
 */
function parseMergedPrs(jsonOutput: string): MergedPrSummary[] {
  if (!jsonOutput || jsonOutput === "[]") return [];

  try {
    const prs = JSON.parse(jsonOutput) as Array<{
      number: number;
      title: string;
      changedFiles: number;
    }>;
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      filesChanged: pr.changedFiles ?? 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Parse open worker PR JSON output from gh CLI.
 *
 * Expected format from `gh pr list --json number,title,headRefName,baseRefName`.
 */
function parseOpenWorkerPrs(jsonOutput: string): OpenWorkerPr[] {
  if (!jsonOutput || jsonOutput === "[]") return [];

  try {
    const prs = JSON.parse(jsonOutput) as Array<{
      number: number;
      title: string;
      headRefName: string;
      baseRefName: string;
    }>;
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      targetBranch: pr.baseRefName,
    }));
  } catch {
    return [];
  }
}

/**
 * Parse git log oneline output into an array of lines.
 */
function parseCommitLog(logOutput: string): string[] {
  if (!logOutput) return [];
  return logOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Cache key for recent activity data. */
const CACHE_KEY = "recent-activity";

/**
 * Collect recent repository activity.
 *
 * Gathers:
 * 1. Recently merged PRs (titles + files changed count)
 * 2. Recent commits on the default branch
 * 3. Open PRs by the worker user
 *
 * All command failures are handled gracefully — individual sections
 * will simply be empty if their data source is unavailable.
 *
 * @param options - Collection options including repo, limits, and runner
 * @returns Result containing the raw activity data
 */
export async function collectRecentActivity(
  options: RecentActivityOptions,
): Promise<Result<RecentActivityData>> {
  const {
    repo,
    githubUser,
    mergedPrLimit,
    commitLimit,
    runner = defaultRunner,
    cache,
  } = options;

  // Check cache first
  if (cache) {
    const cached = await cache.read<RecentActivityData>(repo, CACHE_KEY);
    if (cached) {
      return { ok: true, value: cached };
    }
  }

  // Issue #1787 / #1799: when a cache instance is provided, route the
  // open-worker-PR fetch and the recent-merged-PR fetch through the
  // shared IssueCache so the composite-cache miss reuses any populated
  // `prs_${user}` / `prs_recent_merged_${limit}` entry from sibling
  // helpers in the same iteration. The git-log query remains on the
  // original `runner` (no IssueCache shape applies to local git output).
  const ghAdapter = (args: string[]): Promise<string> =>
    runner("gh", args).then((r) => {
      if (!r.ok) throw r.error;
      return r.value;
    });

  // Collect data from all sources in parallel.
  // Note: every async branch is awaited — fire-and-forget cache priming
  // would leak unfinished child processes when the test runner exits
  // (Issue #1787 follow-up).
  const [mergedPrs, commitResult, openPrs] = await Promise.all([
    // 1. Recently merged PRs (all authors) — route through cached helper
    // when a cache is supplied (Issue #1799).
    cache
      ? fetchRecentMergedPRs(repo, mergedPrLimit, cache, ghAdapter).catch(
        () => [],
      )
      : runner("gh", [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "merged",
        "--limit",
        String(mergedPrLimit),
        "--json",
        "number,title,changedFiles",
      ]),
    // 2. Recent commits on default branch
    runner("git", [
      "log",
      "--oneline",
      `-${commitLimit}`,
    ]),
    // 3. Open PRs by the worker — route through cached helper.
    cache
      ? fetchOpenPRsByUser(repo, githubUser, cache, ghAdapter).catch(() => [])
      : runner("gh", [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--author",
        githubUser,
        "--json",
        "number,title,headRefName,baseRefName",
      ]),
  ]);

  let openWorkerPrs: OpenWorkerPr[];
  if (Array.isArray(openPrs)) {
    // From fetchOpenPRsByUser — already typed.
    openWorkerPrs = openPrs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      targetBranch: pr.baseRefName,
    }));
  } else {
    openWorkerPrs = openPrs.ok ? parseOpenWorkerPrs(openPrs.value) : [];
  }

  let mergedPrSummaries: MergedPrSummary[];
  if (Array.isArray(mergedPrs)) {
    // From fetchRecentMergedPRs — already typed.
    mergedPrSummaries = mergedPrs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      filesChanged: pr.changedFiles ?? 0,
    }));
  } else {
    mergedPrSummaries = mergedPrs.ok ? parseMergedPrs(mergedPrs.value) : [];
  }

  const data: RecentActivityData = {
    mergedPrs: mergedPrSummaries,
    recentCommits: commitResult.ok ? parseCommitLog(commitResult.value) : [],
    openWorkerPrs,
  };

  // Write to cache
  if (cache) {
    await cache.write(repo, CACHE_KEY, data);
  }

  return { ok: true, value: data };
}

// =============================================================================
// Formatting
// =============================================================================

/**
 * Estimate token count from a string.
 *
 * Uses a rough heuristic: 1 token ≈ 4 characters.
 * This is a conservative estimate for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Format recent activity data into a concise prompt section.
 *
 * Returns an empty string if no activity data is available.
 * Respects the maxTokens limit by truncating sections as needed.
 *
 * @param data - Raw activity data
 * @param maxTokens - Maximum token budget (default: 1000)
 * @returns Formatted markdown section or empty string
 */
export function formatRecentActivity(
  data: RecentActivityData,
  maxTokens = 1000,
): string {
  const { mergedPrs, recentCommits, openWorkerPrs } = data;

  // If no data at all, return empty
  if (
    mergedPrs.length === 0 &&
    recentCommits.length === 0 &&
    openWorkerPrs.length === 0
  ) {
    return "";
  }

  const sections: string[] = [];
  sections.push("## Recent Repository Activity");
  sections.push(
    "The following is a summary of recent activity in this repository. " +
      "Use this context to stay consistent with recent patterns and avoid " +
      "re-exploring recently modified areas.",
  );
  sections.push("");

  let currentTokens = estimateTokens(sections.join("\n"));

  // Section 1: Recently merged PRs
  if (mergedPrs.length > 0) {
    const prLines: string[] = ["### Recently Merged PRs"];
    for (const pr of mergedPrs) {
      const filesWord = pr.filesChanged === 1 ? "file" : "files";
      // PR titles are author-controlled and reach the prompt outside the
      // untrusted fence — neutralise any delimiter-breakout patterns (#2415).
      const safeTitle = sanitiseDelimiterPatterns(pr.title);
      const line =
        `- #${pr.number}: ${safeTitle} (${pr.filesChanged} ${filesWord})`;
      const lineTokens = estimateTokens(line);
      if (currentTokens + lineTokens > maxTokens) break;
      prLines.push(line);
      currentTokens += lineTokens;
    }
    if (prLines.length > 1) {
      sections.push(prLines.join("\n"));
      sections.push("");
    }
  }

  // Section 2: Recent commits
  if (recentCommits.length > 0 && currentTokens < maxTokens) {
    const commitLines: string[] = ["### Recent Commits"];
    for (const commit of recentCommits) {
      // Commit subjects are author-controlled (any contributor whose PR was
      // merged) — neutralise delimiter-breakout patterns (#2415).
      const line = `- ${sanitiseDelimiterPatterns(commit)}`;
      const lineTokens = estimateTokens(line);
      if (currentTokens + lineTokens > maxTokens) break;
      commitLines.push(line);
      currentTokens += lineTokens;
    }
    if (commitLines.length > 1) {
      sections.push(commitLines.join("\n"));
      sections.push("");
    }
  }

  // Section 3: Open worker PRs (always important — avoid conflicts)
  if (openWorkerPrs.length > 0 && currentTokens < maxTokens) {
    const openLines: string[] = [
      "### Open Worker PRs",
      "**Avoid conflicting with these in-progress PRs:**",
    ];
    for (const pr of openWorkerPrs) {
      // Worker-authored, but sanitise defensively for consistency (#2415).
      const safeTitle = sanitiseDelimiterPatterns(pr.title);
      const line = `- #${pr.number}: ${safeTitle} → ${pr.targetBranch}`;
      const lineTokens = estimateTokens(line);
      if (currentTokens + lineTokens > maxTokens) break;
      openLines.push(line);
      currentTokens += lineTokens;
    }
    if (openLines.length > 2) {
      sections.push(openLines.join("\n"));
      sections.push("");
    }
  }

  return sections.join("\n").trimEnd();
}
