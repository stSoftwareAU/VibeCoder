/**
 * analyse-failed-once command (Issue #1547).
 *
 * Surveys recent `failed-once` issues across configured repositories,
 * buckets them by the `**Category:**` line emitted by label_failure.ts,
 * and prints a distribution report — giving a data-driven view of which
 * failure classes dominate first-attempt failures.
 *
 * Usage:
 *   deno run mod.ts analyse-failed-once
 *   deno run mod.ts analyse-failed-once --repos org/repo1,org/repo2
 *   deno run mod.ts analyse-failed-once --json
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, Result, WorkerConfig } from "../types.ts";
import { runGhCommand } from "../lib/github.ts";

/** Marker embedded in first-attempt failure comments by label_failure.ts. */
const FIRST_ATTEMPT_MARKER = "## Automated Processing Failed (First Attempt)";

/** Regex to extract the user-facing category display from a comment body. */
const CATEGORY_REGEX = /\*\*Category:\*\*\s*`([^`]+)`/;

/** Aggregated report of failed-once categories across repos. */
export interface FailedOnceReport {
  /** Category count across all repos. */
  byCategory: Record<string, number>;
  /** Per-repo category counts. Every scanned repo appears as a key. */
  byRepo: Record<string, Record<string, number>>;
  /** Number of matching issues that are now CLOSED (ultimately succeeded). */
  succeeded: number;
  /** Number of matching issues still OPEN (remain failed). */
  stillFailed: number;
  /** Total number of issues contributing to the report. */
  totalIssues: number;
}

/** Options for `analyseFailedOnce`. */
export interface AnalyseFailedOnceOptions {
  repos: string[];
  /** Max issues per repo (default 200). */
  limit?: number;
  /** Injectable gh runner for testing. */
  ghCommandFn?: (args: string[]) => Promise<string>;
}

/** Minimal shape of the gh issue list JSON we consume. */
interface GhIssue {
  number: number;
  title: string;
  state: string;
  comments: Array<{ body: string }>;
}

/**
 * Parse the `**Category:**` value from a failure comment body.
 *
 * Returns `"unknown"` when no category line is present.
 */
export function parseCategoryFromComment(body: string): string {
  const match = body.match(CATEGORY_REGEX);
  return match?.[1] ?? "unknown";
}

/**
 * Increment a counter in a nested record, creating keys as needed.
 */
function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Query a single repo's failed-once issues and return the parsed list.
 */
async function fetchFailedOnceIssues(
  repo: string,
  limit: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<GhIssue[]> {
  const raw = await ghCommandFn([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--label",
    "failed-once",
    "--limit",
    String(limit),
    "--json",
    "number,title,state,comments",
  ]);

  const parsed: unknown = JSON.parse(raw || "[]");
  if (!Array.isArray(parsed)) return [];

  return parsed.map((item) => {
    const rec = item as Record<string, unknown>;
    const rawComments = Array.isArray(rec.comments) ? rec.comments : [];
    const comments = rawComments.map((c) => ({
      body: typeof (c as Record<string, unknown>).body === "string"
        ? (c as Record<string, unknown>).body as string
        : "",
    }));
    return {
      number: typeof rec.number === "number" ? rec.number : 0,
      title: typeof rec.title === "string" ? rec.title : "",
      state: typeof rec.state === "string" ? rec.state : "",
      comments,
    };
  });
}

/**
 * Aggregate failed-once categories across the given repos.
 *
 * Returns an error Result if any gh call fails — avoids throwing so the
 * command wrapper can surface a clean error message.
 */
export async function analyseFailedOnce(
  options: AnalyseFailedOnceOptions,
): Promise<Result<FailedOnceReport>> {
  const ghCommandFn = options.ghCommandFn ?? runGhCommand;
  const limit = options.limit ?? 200;

  const byCategory: Record<string, number> = {};
  const byRepo: Record<string, Record<string, number>> = {};
  let succeeded = 0;
  let stillFailed = 0;
  let totalIssues = 0;

  for (const repo of options.repos) {
    byRepo[repo] = {};
    let issues: GhIssue[];
    try {
      issues = await fetchFailedOnceIssues(repo, limit, ghCommandFn);
    } catch (error) {
      return { ok: false, error: error as Error };
    }

    for (const issue of issues) {
      const firstAttemptComment = issue.comments.find((c) =>
        c.body.includes(FIRST_ATTEMPT_MARKER)
      );
      if (!firstAttemptComment) continue;

      const category = parseCategoryFromComment(firstAttemptComment.body);
      bump(byCategory, category);
      bump(byRepo[repo]!, category);
      totalIssues++;
      if (issue.state.toUpperCase() === "CLOSED") {
        succeeded++;
      } else {
        stillFailed++;
      }
    }
  }

  return {
    ok: true,
    value: { byCategory, byRepo, succeeded, stillFailed, totalIssues },
  };
}

/**
 * Render a Markdown report from an aggregated `FailedOnceReport`.
 */
export function formatMarkdownReport(report: FailedOnceReport): string {
  const lines: string[] = [];
  lines.push("# Failed-once Category Report");
  lines.push("");
  lines.push(`Total issues: ${report.totalIssues}`);
  lines.push(
    `Succeeded after retry: ${report.succeeded}  |  Still failed: ${report.stillFailed}`,
  );
  lines.push("");

  lines.push("## Overall Distribution");
  lines.push("| Category | Count |");
  lines.push("| --- | --- |");
  const categoriesSorted = Object.entries(report.byCategory)
    .sort((a, b) => b[1] - a[1]);
  if (categoriesSorted.length === 0) {
    lines.push("| _none_ | 0 |");
  } else {
    for (const [cat, count] of categoriesSorted) {
      lines.push(`| ${cat} | ${count} |`);
    }
  }
  lines.push("");

  lines.push("## Per-repo Distribution");
  lines.push("| Repo | Category | Count |");
  lines.push("| --- | --- | --- |");
  const repoEntries = Object.entries(report.byRepo).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  let anyRow = false;
  for (const [repo, cats] of repoEntries) {
    const catEntries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    if (catEntries.length === 0) {
      lines.push(`| ${repo} | _none_ | 0 |`);
      anyRow = true;
      continue;
    }
    for (const [cat, count] of catEntries) {
      lines.push(`| ${repo} | ${cat} | ${count} |`);
      anyRow = true;
    }
  }
  if (!anyRow) {
    lines.push("| _no repos scanned_ | — | 0 |");
  }

  return lines.join("\n");
}

/**
 * Parse a `--repos` argument into a list of repo strings.
 *
 * Accepts an array, a JSON-encoded array, or a comma-separated string.
 * Falls back to the worker config's repo list when absent.
 */
function parseReposArg(
  args: Record<string, unknown>,
  config: WorkerConfig,
): string[] {
  const raw = args["repos"];
  if (Array.isArray(raw)) {
    return raw.map(String).map((r) => r.trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((r) => r.trim()).filter(Boolean);
      }
    } catch {
      // fall through to comma split
    }
    return raw.split(",").map((r) => r.trim()).filter(Boolean);
  }
  return config.repos ?? [];
}

/** The analyse-failed-once command implementation. */
export const analyseFailedOnceCommand: Command = {
  name: "analyse-failed-once",
  description:
    "Aggregate failed-once issue categories across repos (Issue #1547)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<FailedOnceReport>> {
    const repos = parseReposArg(args, config);
    if (repos.length === 0) {
      return {
        success: false,
        message:
          "No repos to analyse. Pass --repos org/repo1,org/repo2 or configure repos in .config.json.",
      };
    }

    const asJson = args["json"] === true || args["json"] === "true";
    const limitArg = args["limit"];
    const limit = typeof limitArg === "number"
      ? limitArg
      : typeof limitArg === "string"
      ? parseInt(limitArg, 10) || 200
      : 200;

    const result = await analyseFailedOnce({ repos, limit });
    if (!result.ok) {
      return {
        success: false,
        message:
          `Failed to analyse failed-once issues: ${result.error.message}`,
      };
    }

    const message = asJson
      ? JSON.stringify(result.value, null, 2)
      : formatMarkdownReport(result.value);

    return { success: true, message, data: result.value };
  },
};
