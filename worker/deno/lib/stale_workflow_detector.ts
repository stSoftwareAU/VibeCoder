/**
 * Stale workflow label detector for the Vibe Coder worker.
 *
 * Detects issues that have been stuck in workflow states for extended
 * periods and takes appropriate action (diagnostic summaries, warning
 * logs).
 *
 * Issue #1240: Auto-detect and handle stale workflow labels on issues.
 * Issue #2031: Retire `needs-clarification` reminder/auto-close branch —
 * the worker now hands those issues off via `needs-human` and waits for
 * a human to triage. The remaining branches (`failed`/`failed-once`
 * diagnostics, `planning` warnings) are unchanged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubComment, GitHubIssue, Result } from "../types.ts";
import { classifyGitHubError, GitHubErrorCategory } from "./github_errors.ts";
import { formatRateLimitReset } from "./rate_limit_signal.ts";
import { waitUntilRateLimitReset } from "./rate_limit_wait.ts";
import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default thresholds for stale workflow detection. */
export const STALE_WORKFLOW_DEFAULTS = {
  /** Days before posting a diagnostic on failed/failed-once issues. */
  failedDiagnosticDays: 3,
  /** Days before warning about stuck planning issues. */
  planningWarningDays: 2,
} as const;

/** Configuration for stale workflow detection. */
export interface StaleWorkflowConfig {
  /** Repos to scan in "owner/repo" format. */
  repos: string[];
  /** Label names for workflow states. */
  labels: {
    failed: string;
    failedOnce: string;
    planning: string;
  };
  /** Threshold overrides (days). */
  thresholds: {
    failedDiagnosticDays: number;
    planningWarningDays: number;
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single stale issue detected by the scanner. */
export interface StaleIssueInfo {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  label: string;
  staleDays: number;
  action: "diagnostic" | "warning";
}

/** Summary of a stale workflow scan. */
export interface StaleWorkflowScanResult {
  scanned: number;
  actioned: number;
  issues: StaleIssueInfo[];
}

/** Bot marker to prevent duplicate comments. */
/**
 * Issue #842: these two use a `vibe-coder-` prefix where every documented
 * marker uses the bare `vibe-`. Frozen: `hasExistingStaleComment` matches
 * them against comments already posted, so renaming would re-post a stale
 * diagnostic on every issue that already carries one.
 */
const STALE_BOT_MARKER = "<!-- vibe-coder-stale-workflow -->";
const STALE_DIAGNOSTIC_MARKER = "<!-- vibe-coder-stale-diagnostic -->";

// ---------------------------------------------------------------------------
// Dependencies (injectable for testing)
// ---------------------------------------------------------------------------

/** Injectable dependencies for the stale workflow detector. */
export interface StaleWorkflowDeps {
  /** List issues by label from a repo. */
  listIssuesByLabel: (
    repo: string,
    label: string,
  ) => Promise<GitHubIssue[]>;
  /** Get comments on an issue (per-issue REST fallback). */
  getIssueComments: (
    repo: string,
    issueNumber: number,
  ) => Promise<GitHubComment[]>;
  /**
   * Optional batched comment fetch (Issue #1842). When provided, the
   * detector pre-fetches comments for the candidate list of stale
   * issues with a single GraphQL call (or `ceil(N / batchSize)` calls
   * when the list exceeds the per-batch alias limit). Issues missing
   * from the returned map fall back to per-issue `getIssueComments`,
   * preserving the existing REST path.
   */
  getIssueCommentsBatch?: (
    repo: string,
    issueNumbers: number[],
  ) => Promise<Map<number, GitHubComment[]>>;
  /** Post a comment on an issue. */
  postComment: (
    repo: string,
    issueNumber: number,
    body: string,
  ) => Promise<void>;
  /** Close an issue. */
  closeIssue: (repo: string, issueNumber: number) => Promise<void>;
  /** Log informational messages. */
  log: (message: string) => void;
  /** Get current time (epoch ms). */
  now: () => number;
  /**
   * Current Unix time in seconds — passed to {@link waitUntilRateLimitReset}.
   * Issue #1781: pause-and-resume on rate-limit hit.
   */
  nowSeconds: () => number;
  /**
   * Return true when the worker has been asked to shut down. The
   * pause-and-resume loop polls this so a SIGTERM mid-wait aborts the
   * scan instead of holding the process open.
   * Issue #1781: honour shutdown signals during rate-limit waits.
   */
  shouldShutdown: () => boolean;
  /**
   * Sleep for the given number of milliseconds. Injected so tests can
   * advance a virtual clock without real timers.
   * Issue #1781: pause-and-resume on rate-limit hit.
   */
  sleep: (ms: number) => Promise<void>;
  /**
   * Fetch the current GitHub rate-limit reset epoch (Unix seconds).
   * Production implementations should call `gh api rate_limit` (a free
   * call that does not consume quota and works while rate-limited).
   * Issue #1781: pause-and-resume on rate-limit hit.
   */
  getRateLimitReset: () => Promise<number>;
  /**
   * Fleet identity inputs for the diagnostic-marker author check
   * (Issue #1124). Omitted reads the configured fleet, which is what every
   * production caller does; a test states the fleet instead of writing a
   * config file.
   */
  authorOptions?: AlertDedupAuthorOptions;
}

// ---------------------------------------------------------------------------
// Rate limit detection
// ---------------------------------------------------------------------------

/** Check whether an error represents a GitHub API rate limit. */
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return classifyGitHubError(msg).category === GitHubErrorCategory.RateLimit;
}

// ---------------------------------------------------------------------------
// Core detection logic
// ---------------------------------------------------------------------------

/**
 * Calculate the number of days since a given ISO timestamp.
 *
 * @param isoTimestamp - ISO 8601 timestamp string
 * @param nowMs - Current time in epoch milliseconds
 * @returns Number of full days elapsed
 */
export function daysSince(isoTimestamp: string, nowMs: number): number {
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return 0;
  const diffMs = nowMs - then;
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Check whether **the fleet** has already left a stale bot marker on an
 * issue.
 *
 * Prevents duplicate comments from being posted on subsequent scans. The
 * marker lives in a comment body anybody who can see the issue may write,
 * and a match here suppresses the diagnostic, so the comment **author** is
 * checked against the fleet identity before the match counts
 * (Issue #1124). Without that, one planted
 * `<!-- vibe-coder-stale-diagnostic -->` silences the diagnostic on that
 * issue for good, and silence is the direction nobody notices.
 *
 * **The fail direction is towards posting.** An unresolvable fleet identity
 * means no marker can be attributed, so none counts and the diagnostic goes
 * out. A second diagnostic comment is noise a human scrolls past; a
 * suppressed one is a stale issue nobody hears about.
 *
 * @param comments - Existing comments on the issue
 * @param marker - The HTML comment marker to search for
 * @param authorOptions - Fleet identity inputs
 * @param log - Sink for the author-verification diagnostics
 * @returns true if a fleet-authored comment with this marker already exists
 */
export async function hasExistingStaleComment(
  comments: GitHubComment[],
  marker: string,
  authorOptions: AlertDedupAuthorOptions = {},
  log: (message: string) => void = (message) => console.warn(message),
): Promise<boolean> {
  const matches = await selectFleetAuthoredComments(
    comments.filter((c) => c.body.includes(marker)),
    `stale-workflow marker ${marker}`,
    authorOptions,
    log,
    "the diagnostic is posted — a marker anyone can write must not " +
      "silence a stale issue",
  );
  return matches.length > 0;
}

/**
 * Check whether the issue author has commented since a given timestamp.
 *
 * @param comments - All comments on the issue
 * @param author - The issue author's login
 * @param sinceMs - Only count comments after this epoch-ms timestamp
 * @returns true if the author has commented after sinceMs
 */
export function hasAuthorCommentedSince(
  comments: GitHubComment[],
  author: string,
  sinceMs: number,
): boolean {
  return comments.some((c) => {
    if (c.author !== author) return false;
    const commentTime = new Date(c.createdAt).getTime();
    return !isNaN(commentTime) && commentTime > sinceMs;
  });
}

// ---------------------------------------------------------------------------
// Comment builders
// ---------------------------------------------------------------------------

/**
 * Build a diagnostic comment for stale failed/failed-once issues.
 */
export function buildFailedDiagnosticComment(
  label: string,
  staleDays: number,
): string {
  return [
    STALE_BOT_MARKER,
    STALE_DIAGNOSTIC_MARKER,
    "",
    `⚠️ This issue has been in the \`${label}\` state for **${staleDays} days** without activity.`,
    "",
    "**Suggested next steps:**",
    "- Review the failure reason in the most recent worker comment above",
    "- If the issue description needs improvement, update it and remove the `" +
    label + "` label",
    "- If the issue is no longer needed, close it",
    "",
    "_This is an automated diagnostic from the Vibe Coder workflow._",
  ].join("\n");
}

/**
 * Pre-fetch comments for a candidate list using the deps batch helper
 * when available. Empty inputs short-circuit to an empty map (zero
 * gh calls). On batch failure the caller transparently falls back to
 * per-issue REST via `deps.getIssueComments`. Issue #1842.
 */
async function prefetchComments(
  repo: string,
  numbers: number[],
  deps: StaleWorkflowDeps,
): Promise<Map<number, GitHubComment[]>> {
  if (numbers.length === 0) return new Map();
  if (!deps.getIssueCommentsBatch) return new Map();
  try {
    return await deps.getIssueCommentsBatch(repo, numbers);
  } catch (err) {
    deps.log(
      `[stale-workflow] Comment batch failed for ${repo} (${numbers.length} issues) — falling back to per-issue: ${err}`,
    );
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Scanning functions
// ---------------------------------------------------------------------------

/**
 * Scan for and handle stale failed/failed-once issues in a single repo.
 */
export async function processStaleFailed(
  repo: string,
  config: StaleWorkflowConfig,
  deps: StaleWorkflowDeps,
): Promise<StaleIssueInfo[]> {
  const results: StaleIssueInfo[] = [];
  const nowMs = deps.now();

  for (const label of [config.labels.failed, config.labels.failedOnce]) {
    let issues: GitHubIssue[];
    try {
      issues = await deps.listIssuesByLabel(repo, label);
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      deps.log(
        `[stale-workflow] Failed to list ${label} issues for ${repo}: ${err}`,
      );
      continue;
    }

    // Issue #1842: filter to candidates exceeding the threshold and
    // batch-fetch their comments with a single GraphQL call.
    const candidates = issues.filter(
      (i) =>
        daysSince(i.updatedAt, nowMs) >= config.thresholds.failedDiagnosticDays,
    );
    const batchedComments = await prefetchComments(
      repo,
      candidates.map((i) => i.number),
      deps,
    );

    for (const issue of candidates) {
      const staleDays = daysSince(issue.updatedAt, nowMs);

      let comments: GitHubComment[];
      const cached = batchedComments.get(issue.number);
      if (cached !== undefined) {
        comments = cached;
      } else {
        try {
          comments = await deps.getIssueComments(repo, issue.number);
        } catch {
          continue;
        }
      }

      if (
        await hasExistingStaleComment(
          comments,
          STALE_DIAGNOSTIC_MARKER,
          deps.authorOptions ?? {},
          deps.log,
        )
      ) {
        continue;
      }

      try {
        await deps.postComment(
          repo,
          issue.number,
          buildFailedDiagnosticComment(label, staleDays),
        );
        deps.log(
          `[stale-workflow] Diagnostic posted on ${repo}#${issue.number} (${label}, ${staleDays} days)`,
        );
        results.push({
          repo,
          issueNumber: issue.number,
          issueTitle: issue.title,
          label,
          staleDays,
          action: "diagnostic",
        });
      } catch (err) {
        deps.log(
          `[stale-workflow] Failed to post diagnostic on ${repo}#${issue.number}: ${err}`,
        );
      }
    }
  }

  return results;
}

/**
 * Scan for stale planning issues in a single repo (log warning only).
 */
export async function processStalePlanning(
  repo: string,
  config: StaleWorkflowConfig,
  deps: StaleWorkflowDeps,
): Promise<StaleIssueInfo[]> {
  const results: StaleIssueInfo[] = [];
  const nowMs = deps.now();
  const label = config.labels.planning;

  let issues: GitHubIssue[];
  try {
    issues = await deps.listIssuesByLabel(repo, label);
  } catch (err) {
    if (isRateLimitError(err)) throw err;
    deps.log(
      `[stale-workflow] Failed to list ${label} issues for ${repo}: ${err}`,
    );
    return results;
  }

  for (const issue of issues) {
    const staleDays = daysSince(issue.updatedAt, nowMs);
    if (staleDays < config.thresholds.planningWarningDays) {
      continue;
    }

    deps.log(
      `[stale-workflow] WARNING: ${repo}#${issue.number} has been in ${label} ` +
        `for ${staleDays} days — planning may have silently failed`,
    );
    results.push({
      repo,
      issueNumber: issue.number,
      issueTitle: issue.title,
      label,
      staleDays,
      action: "warning",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Scan all configured repos for stale workflow labels and take action.
 *
 * This is the main entry point called from the priority dispatch table.
 * It runs at low priority (1.9) and does not interfere with normal processing.
 *
 * @param config - Stale workflow configuration
 * @param deps - Injectable dependencies
 * @returns Result with scan summary
 */
export async function scanForStaleWorkflowIssues(
  config: StaleWorkflowConfig,
  deps: StaleWorkflowDeps,
): Promise<Result<StaleWorkflowScanResult>> {
  const allIssues: StaleIssueInfo[] = [];
  let totalScanned = 0;

  // Issue #1781: index-based loop so the current repo can be retried
  // after a rate-limit pause. The `process*` calls are idempotent
  // (each filters by label and skips work already marked complete via
  // STALE_*_MARKER comments), so re-running them on resume cannot
  // double-process the issues already actioned in this iteration.
  for (let repoIndex = 0; repoIndex < config.repos.length; repoIndex++) {
    const repo = config.repos[repoIndex]!;
    try {
      const failedResults = await processStaleFailed(repo, config, deps);
      allIssues.push(...failedResults);

      const planningResults = await processStalePlanning(repo, config, deps);
      allIssues.push(...planningResults);

      totalScanned++;
    } catch (err) {
      if (!isRateLimitError(err)) {
        throw err;
      }

      let resetEpoch: number;
      try {
        resetEpoch = await deps.getRateLimitReset();
      } catch (resetErr) {
        const msg = resetErr instanceof Error
          ? resetErr.message
          : String(resetErr);
        deps.log(
          `[stale-workflow] Failed to fetch rate-limit reset (${msg}) — falling back to a 1h wait`,
        );
        resetEpoch = deps.nowSeconds() + 3600;
      }

      deps.log(
        `[stale-workflow] GitHub API rate limit hit on ${repo} — pausing until reset ${
          formatRateLimitReset(resetEpoch, deps.nowSeconds())
        }`,
      );

      const waitResult = await waitUntilRateLimitReset(
        { resetEpoch },
        {
          now: deps.nowSeconds,
          sleep: deps.sleep,
          shouldShutdown: deps.shouldShutdown,
          // Heartbeat so the stale-workflow scan does not go silent
          // during long rate-limit pauses (Issue #1903).
          log: (msg) => deps.log(`[stale-workflow] ${msg}`),
        },
      );

      if (!waitResult.ok) {
        deps.log(
          `[stale-workflow] Rate-limit wait failed (${waitResult.error.message}) — aborting scan ` +
            `(scanned ${totalScanned}/${config.repos.length})`,
        );
        break;
      }

      if (waitResult.value.aborted === "shutdown") {
        deps.log(
          `[stale-workflow] Shutdown during rate-limit wait — aborting scan ` +
            `(scanned ${totalScanned}/${config.repos.length})`,
        );
        break;
      }

      if (waitResult.value.aborted === "cap") {
        deps.log(
          `[stale-workflow] Rate-limit wait hit safety cap — aborting scan ` +
            `(scanned ${totalScanned}/${config.repos.length})`,
        );
        break;
      }

      // Wait completed cleanly — retry the current repo. Decrement the
      // index so the for-loop's increment leaves us on the same repo.
      deps.log(
        `[stale-workflow] Resumed after ${waitResult.value.waited}s — retrying ${repo}`,
      );
      repoIndex--;
      continue;
    }
  }

  const result: StaleWorkflowScanResult = {
    scanned: totalScanned,
    actioned: allIssues.length,
    issues: allIssues,
  };

  if (allIssues.length > 0) {
    deps.log(
      `[stale-workflow] Scan complete: ${allIssues.length} stale issues actioned across ${totalScanned} repos`,
    );
  }

  return { ok: true, value: result };
}
