/**
 * GitHub client module for the Vibe Coder worker.
 *
 * Provides a TypeScript interface for interacting with GitHub
 * via the gh CLI tool, with retry resilience for transient failures.
 *
 * Issue #217 — Added retry logic, partial failure handling, and
 * improved error classification.
 */

import type {
  GitHubClient,
  GitHubComment,
  GitHubIssue,
  Logger,
} from "../types.ts";
import {
  type GhCommentJson,
  type GhIssueJson,
  validateGhCommentsJson,
  validateGhIssueJson,
} from "./validation.ts";
import { retryWithBackoff } from "./retry.ts";
import { isReservedLabel } from "./config_defaults.ts";
import { recordGhCall } from "./gh_call_metrics.ts";
import { runGhOrThrow } from "./gh_spawn.ts";
import { getCachedComments, invalidateComments } from "./comment_cache.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import type { Improvement } from "../commands/suggest_improvements.ts";
import { formatImprovementAsIssueBody } from "../commands/suggest_improvements.ts";
import { defaultLogger } from "./logger.ts";

/**
 * Parse gh CLI issue JSON into a GitHubIssue object.
 *
 * @param json - Raw JSON from gh CLI
 * @returns Parsed GitHubIssue
 */
export function parseGhIssueJson(json: GhIssueJson): GitHubIssue {
  return {
    number: json.number,
    title: json.title,
    body: json.body ?? "",
    labels: json.labels.map((l) => l.name),
    author: json.author.login,
    assignees: json.assignees.map((a) => a.login),
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
  };
}

/**
 * Parse the JSON returned by `POST /repos/{owner}/{repo}/issues/{n}/comments`
 * into a `GitHubComment`. The REST API returns a single comment object with
 * `id`, `body`, `user.login`, `created_at`, and (optionally) `reactions`.
 *
 * Issue #1843: returned by `postComment` so callers can append the freshly
 * created comment to an in-memory list instead of refetching.
 *
 * @param raw - Raw JSON string from the gh REST POST
 * @returns Parsed GitHubComment, or undefined if the JSON is unrecognised
 */
export function parseCreatedCommentJson(
  raw: string,
): GitHubComment | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const id = typeof obj.id === "number" ? obj.id : undefined;
  const body = typeof obj.body === "string" ? obj.body : undefined;
  const createdAt = typeof obj.created_at === "string"
    ? obj.created_at
    : undefined;
  const user = obj.user;
  const author = (typeof user === "object" && user !== null &&
      typeof (user as Record<string, unknown>).login === "string")
    ? ((user as Record<string, unknown>).login as string)
    : undefined;
  if (
    id === undefined || body === undefined || author === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }
  const reactions =
    (typeof obj.reactions === "object" && obj.reactions !== null)
      ? obj.reactions as Record<string, unknown>
      : {};
  return {
    id,
    body,
    author,
    createdAt,
    reactions: {
      thumbsUp: typeof reactions["+1"] === "number"
        ? reactions["+1"] as number
        : 0,
      eyes: typeof reactions.eyes === "number" ? reactions.eyes as number : 0,
      confused: typeof reactions.confused === "number"
        ? reactions.confused as number
        : 0,
    },
  };
}

/**
 * Parse the raw GitHub REST `/issues/{n}/comments` response into the
 * worker's `GitHubComment` shape (Issue #1881).
 *
 * This replaces the previous gh `--jq` filter that mapped the GitHub
 * field names (`user.login`, `created_at`) to the worker's preferred
 * names (`author.login`, `createdAt`). Doing the transform in
 * TypeScript lets us page through the thread with the existing
 * `validateGhCommentsJson` validator without gh applying `--jq` per
 * page (see `fetchIssueCommentPages`).
 *
 * @param raw - Merged raw comment array from `fetchIssueCommentPages`
 * @returns Parsed `GitHubComment` array
 * @throws When the input is not a JSON array of comment objects
 */
export function parseGhRawCommentsJson(raw: unknown): GitHubComment[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `Expected raw comments array, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  // Map raw REST shape onto the validator's expected shape, then
  // delegate type-safety to the existing validator.
  const remapped: unknown[] = raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const obj = entry as Record<string, unknown>;
    const user = (typeof obj.user === "object" && obj.user !== null)
      ? obj.user as Record<string, unknown>
      : {};
    const reactions =
      (typeof obj.reactions === "object" && obj.reactions !== null)
        ? obj.reactions as Record<string, unknown>
        : {};
    return {
      id: obj.id,
      body: obj.body,
      author: { login: user.login },
      createdAt: obj.created_at,
      reactions: {
        "+1": reactions["+1"],
        eyes: reactions.eyes,
        confused: reactions.confused,
      },
    };
  });
  const validated = validateGhCommentsJson(remapped);
  if (!validated.ok) {
    throw new Error(
      `Invalid raw comments response: ${validated.error.field} - ${validated.error.message}`,
    );
  }
  return parseGhCommentsJson(validated.value);
}

/**
 * Parse gh CLI comments JSON into GitHubComment array.
 *
 * @param json - Raw JSON from gh CLI
 * @returns Parsed GitHubComment array
 */
export function parseGhCommentsJson(json: GhCommentJson[]): GitHubComment[] {
  return json.map((c) => ({
    id: c.id,
    body: c.body,
    author: c.author.login,
    createdAt: c.createdAt,
    reactions: {
      thumbsUp: c.reactions["+1"] ?? 0,
      eyes: c.reactions.eyes ?? 0,
      confused: c.reactions.confused ?? 0,
    },
  }));
}

/**
 * Run a gh CLI command and return the output (without retry).
 *
 * This is the raw command execution. Use runGhCommand() for API calls
 * that should be retried on transient failures.
 *
 * Issue #3703: delegates the spawn to the shared chokepoint
 * (`gh_spawn.ts`), which enforces the write-repo allowlist before the
 * process starts, injects the GitHub App token (Issue #959) and journals
 * the mutation afterwards.
 *
 * @param args - Arguments to pass to gh
 * @returns Command output as string
 * @throws Error if command fails
 */
export async function runGhCommandRaw(args: string[]): Promise<string> {
  // Issue #1671: record per-iteration `gh` call telemetry. This is
  // the lowest-level `gh` entry-point in this module, so every `gh`
  // invocation (whether retried or not) is counted exactly once per attempt.
  recordGhCall(args);

  // Issue #3311/#3703: egress containment lives in the shared chokepoint —
  // `spawnGh` refuses an off-allowlist (or undeterminable) write BEFORE the
  // command reaches GitHub, then journals the mutation (Issue #2380).
  return await runGhOrThrow(args);
}

/**
 * Run a gh CLI command with automatic retry for transient failures.
 *
 * Wraps runGhCommandRaw with exponential backoff retry logic.
 * Transient errors (5xx, rate limits, network) are retried;
 * permanent errors (4xx, auth) fail immediately.
 *
 * @param args - Arguments to pass to gh
 * @returns Command output as string
 * @throws Error if command fails permanently or after all retries exhausted
 */
export async function runGhCommand(args: string[]): Promise<string> {
  return await retryWithBackoff(
    () => runGhCommandRaw(args),
  );
}

/**
 * Determine whether a comment body has any visible content.
 *
 * Returns false for bodies that are empty, whitespace-only, or contain only
 * HTML comments (e.g. `<!-- CLAIM_LOCK:foo -->`). Such bodies render as
 * completely blank comments on GitHub, which is confusing to human readers
 * — see Issue #1659.
 *
 * @param body - The candidate comment body
 * @returns true if the body has at least one non-whitespace, non-comment character
 */
export function hasVisibleContent(body: string): boolean {
  if (typeof body !== "string") return false;
  // Strip HTML comments (including multi-line) before checking for visible text.
  const stripped = body.replace(/<!--[\s\S]*?-->/g, "");
  return stripped.trim().length > 0;
}

/**
 * Determine if an error message indicates a "label not found" condition.
 *
 * Only this specific error should be silently ignored by removeLabel.
 * Network errors, authentication failures, etc. should propagate.
 *
 * @param errorMessage - The error message to check
 * @returns true if the error is specifically about a missing label
 */
export function isLabelNotFoundError(errorMessage: string): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return lower.includes("label") && lower.includes("not found");
}

/**
 * Filter out reserved labels that must not be applied when creating issues.
 *
 * Reserved labels are used by the worker for operational purposes (issue
 * discovery, prioritisation, failure tracking, workflow state). Only the
 * repository owner should apply these labels.
 *
 * Issue #297: Prevent the vibe coder from labelling created issues with
 * special operational labels.
 *
 * @param labels - Labels to filter
 * @returns Labels with reserved labels removed
 */
export function filterReservedLabels(labels: string[]): string[] {
  // Issue #3088: compare case-insensitively so a non-lower-case canonical
  // label (e.g. `Planning`) is still stripped.
  return labels.filter((label) => !isReservedLabel(label));
}

/**
 * Creation-time variant of {@link filterReservedLabels} that logs a WARNING
 * for every reserved label it strips (Issue #2822).
 *
 * Returns the same filtered list as `filterReservedLabels` — reading the one
 * `RESERVED_LABELS` constant so the set stays in sync automatically (no second
 * copy of the list) — but emits one `logger.warn` per dropped label, naming the
 * stripped label and a caller-supplied context (e.g. repo + creation path) so a
 * worker self-applying a reserved label is visible at a glance.
 *
 * `idle-task` and arbitrary descriptive labels (e.g. `degraded-model`) are not
 * in `RESERVED_LABELS`, so they pass through unchanged and log nothing.
 *
 * @param labels - Labels to filter
 * @param context - Caller context for the warning (e.g. "owner/repo idle-task filer")
 * @param logger - Logger used to emit one WARNING per stripped label
 * @returns Labels with reserved labels removed
 */
export function filterReservedLabelsWithWarning(
  labels: string[],
  context: string,
  logger: Logger,
): string[] {
  const kept: string[] = [];
  for (const label of labels) {
    // Issue #3088: case-insensitive match (see isReservedLabel).
    if (isReservedLabel(label)) {
      logger.warn("Stripped reserved label from worker-created issue", {
        label,
        context,
      });
    } else {
      kept.push(label);
    }
  }
  return kept;
}

/**
 * Result of creating GitHub issues with partial failure handling.
 */
export interface CreateIssuesResult {
  /** Issue numbers that were successfully created */
  createdIssues: number[];
  /** Improvements that failed to create, with error details */
  failures: Array<{ title: string; error: string }>;
}

/**
 * Create GitHub issues for improvements, continuing past individual failures.
 *
 * Unlike the original createGitHubIssues which stops on first failure,
 * this function attempts all improvements and reports partial failures.
 *
 * @param improvements - Improvements to create issues for
 * @param repo - Target repository in "owner/repo" format
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @param logger - Logger used to warn on stripped reserved labels (Issue #2825)
 * @returns Created issue numbers and any failures
 */
export async function createGitHubIssuesWithPartialFailures(
  improvements: Improvement[],
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  logger: Logger = defaultLogger,
): Promise<CreateIssuesResult> {
  const createdIssues: number[] = [];
  const failures: Array<{ title: string; error: string }> = [];

  for (const improvement of improvements) {
    try {
      const body = formatImprovementAsIssueBody(improvement);
      // Issue #2825: warn (no longer strip silently) per reserved label dropped.
      const safeLabels = filterReservedLabelsWithWarning(
        improvement.labels,
        `${repo} suggest-improvements`,
        logger,
      );
      const labelArgs = safeLabels.flatMap((l) => ["--label", l]);

      const output = await ghCommandFn([
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        improvement.title,
        "--body",
        body,
        ...labelArgs,
      ]);

      const match = output.match(/\/issues\/(\d+)/);
      if (match && match[1]) {
        createdIssues.push(parseInt(match[1], 10));
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ title: improvement.title, error: message });
    }
  }

  return { createdIssues, failures };
}

/**
 * Create a GitHub client that uses the gh CLI.
 *
 * @param logger - Logger instance for diagnostic output
 * @returns GitHub client instance
 */
export function createGitHubClient(logger: Logger): GitHubClient {
  return {
    async getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
      logger.debug(`Fetching issue #${issueNumber} from ${repo}`);
      const output = await runGhCommand([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        "number,title,body,labels,author,assignees,createdAt,updatedAt",
      ]);
      const parsed: unknown = JSON.parse(output);
      const validated = validateGhIssueJson(parsed);
      if (!validated.ok) {
        throw new Error(
          `Invalid gh CLI issue response: ${validated.error.field} - ${validated.error.message}`,
        );
      }
      return parseGhIssueJson(validated.value);
    },

    async getIssueComments(
      repo: string,
      issueNumber: number,
    ): Promise<GitHubComment[]> {
      // Issue #1841: per-iteration TTL cache. Multiple priorities read
      // the same issue's comments within an iteration; the cache
      // collapses those into a single REST call. The cache is
      // invalidated by `postComment` for the same `(repo, issueNumber)`.
      return await getCachedComments(repo, issueNumber, async () => {
        logger.debug(
          `Fetching comments for issue #${issueNumber} from ${repo}`,
        );
        // Use REST API — gh issue view --json comments returns GraphQL node IDs
        // (strings) instead of numeric IDs needed for REST API operations.
        // Issue #1881: page through all comments. The default REST page size
        // is 30, which silently truncated long grill-me threads and caused
        // workflows to re-pose questions the developer had already answered.
        // Issue #3709: bounded pagination replaces unbounded `--paginate`.
        const raw = await fetchIssueCommentPages(
          repo,
          issueNumber,
          runGhCommand,
        );
        return parseGhRawCommentsJson(raw);
      });
    },

    async addLabel(
      repo: string,
      issueNumber: number,
      label: string,
    ): Promise<void> {
      logger.debug(
        `Adding label "${label}" to issue #${issueNumber} in ${repo}`,
      );
      // Issue #976: Use REST API with CLI fallback for label operations
      try {
        await runGhCommand([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/${issueNumber}/labels`,
          "-f",
          `labels[]=${label}`,
        ]);
        return;
      } catch {
        // REST API failed — fall back to CLI
      }
      await runGhCommand([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--add-label",
        label,
      ]);
    },

    async removeLabel(
      repo: string,
      issueNumber: number,
      label: string,
    ): Promise<void> {
      logger.debug(
        `Removing label "${label}" from issue #${issueNumber} in ${repo}`,
      );
      try {
        await runGhCommand([
          "issue",
          "edit",
          String(issueNumber),
          "--repo",
          repo,
          "--remove-label",
          label,
        ]);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (isLabelNotFoundError(message)) {
          logger.debug(
            `Label "${label}" not found on issue #${issueNumber} — ignoring`,
          );
          return;
        }
        throw error;
      }
    },

    async postComment(
      repo: string,
      issueNumber: number,
      body: string,
    ): Promise<GitHubComment | undefined> {
      // Issue #1659: skip whitespace-only bodies. An empty or
      // HTML-comment-only body renders as a blank comment on GitHub, which
      // confuses readers ("Multiple blank comments"). Callers that need a
      // hidden marker must include a visible line as well — see
      // claim_pr_comment.ts for the canonical pattern.
      if (!hasVisibleContent(body)) {
        logger.warn(
          `Refusing to post comment to issue #${issueNumber} in ${repo}: body has no visible content`,
        );
        return undefined;
      }
      logger.debug(`Posting comment to issue #${issueNumber} in ${repo}`);
      // Issue #1843: post via the REST API so the response carries the
      // freshly-created comment metadata (id, createdAt, author). Callers
      // that previously had to refetch the comment list to pick up a
      // post they just made can append the returned object in memory
      // instead — saving one GH call per round.
      let created: GitHubComment | undefined;
      try {
        const output = await runGhCommand([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/${issueNumber}/comments`,
          "-f",
          `body=${body}`,
        ]);
        created = parseCreatedCommentJson(output);
      } catch (apiErr) {
        // REST POST failed — fall back to the legacy `gh issue comment`
        // path. Older gh versions or unexpected response shapes must not
        // break existing callers; the only consequence is that no
        // metadata is returned.
        logger.debug(
          `REST POST comment failed (${
            apiErr instanceof Error ? apiErr.message : String(apiErr)
          }); falling back to gh issue comment`,
        );
        await runGhCommand([
          "issue",
          "comment",
          String(issueNumber),
          "--repo",
          repo,
          "--body",
          body,
        ]);
      }
      // Issue #1841: invalidate the comment cache so the next read
      // sees the freshly-posted comment without a stale-cache hit.
      invalidateComments(repo, issueNumber);
      return created;
    },

    async editIssue(
      repo: string,
      issueNumber: number,
      updates: { title?: string; body?: string },
    ): Promise<void> {
      logger.debug(`Editing issue #${issueNumber} in ${repo}`);
      const args = ["issue", "edit", String(issueNumber), "--repo", repo];

      if (updates.title !== undefined) {
        args.push("--title", updates.title);
      }
      if (updates.body !== undefined) {
        args.push("--body", updates.body);
      }

      await runGhCommand(args);
    },

    async assignIssue(
      repo: string,
      issueNumber: number,
      assignees: string[],
    ): Promise<void> {
      logger.debug(
        `Assigning ${assignees.join(", ")} to issue #${issueNumber} in ${repo}`,
      );
      await runGhCommand([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--add-assignee",
        assignees.join(","),
      ]);
    },

    async unassignIssue(
      repo: string,
      issueNumber: number,
      assignees: string[],
    ): Promise<void> {
      logger.debug(
        `Unassigning ${
          assignees.join(", ")
        } from issue #${issueNumber} in ${repo}`,
      );
      await runGhCommand([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        assignees.join(","),
      ]);
    },

    async closeIssue(
      repo: string,
      issueNumber: number,
      comment?: string,
    ): Promise<void> {
      logger.debug(`Closing issue #${issueNumber} in ${repo}`);
      const args = [
        "issue",
        "close",
        String(issueNumber),
        "--repo",
        repo,
      ];
      if (comment) {
        args.push("--comment", comment);
      }
      await runGhCommand(args);
    },
  };
}
