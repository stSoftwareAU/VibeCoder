/**
 * Scan for worker PRs stuck at `mergeable == CONFLICTING` (Issue #84).
 *
 * Issue #4373 made the branch updater refuse to side-pick a conflict and
 * defer to "the PR-feedback agent or a human" — but no handler could ever
 * receive that hand-off. PR feedback triggers on review comments, CI fix
 * triggers on failing checks, and a CONFLICTING PR has neither (GitHub does
 * not run `pull_request` workflows when it cannot build the merge commit).
 * The PR sat CONFLICTING indefinitely while the nudge poked at it every pass.
 *
 * This module is the missing scan: it finds those PRs, makes the queue
 * visible with a {@link MERGE_CONFLICT_LABEL} label, and returns one
 * candidate for the conflict-resolution processor to merge for real.
 *
 * The pass is deliberately bounded — one attempt per PR per
 * {@link DEFAULT_CONFLICT_COOLDOWN_HOURS} hours, and at most
 * {@link DEFAULT_MAX_CONFLICT_ATTEMPTS} attempts before the processor
 * escalates with `needs-human` — so a genuinely unresolvable conflict
 * cannot loop forever.
 *
 * Attempt history lives in marker comments on the PR itself rather than in
 * host-local state, so the bound holds across hosts and worker restarts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { IssueCache } from "./issue_cache.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { fetchPRBranchStateBatch } from "./pr_branch_state.ts";
import { resolveFleetMaintenanceAuthorSet } from "./fleet_authors.ts";
import { listOpenPrs, type PrEntry } from "./pr_maintenance.ts";
import { addLabelToIssue, ensureLabelExists } from "./label_operations.ts";
import {
  getLabelColour,
  getLabelDescription,
} from "../setup/label_definitions.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Visible queue label applied to every PR found CONFLICTING. */
export const MERGE_CONFLICT_LABEL = "merge-conflict";

/**
 * Colour for {@link MERGE_CONFLICT_LABEL} when it has to be created.
 * Issue #368 — resolved from the canonical label table, not a literal.
 */
export const MERGE_CONFLICT_LABEL_COLOUR = getLabelColour(
  MERGE_CONFLICT_LABEL,
);

/** Description for {@link MERGE_CONFLICT_LABEL} when it has to be created. */
export const MERGE_CONFLICT_LABEL_DESCRIPTION = getLabelDescription(
  MERGE_CONFLICT_LABEL,
);

/** Marker that identifies one recorded conflict-resolution attempt. */
export const CONFLICT_ATTEMPT_MARKER = "<!-- vibe-coder:merge-conflict-attempt";

/**
 * Marker posted when an attempt merged successfully. Everything before it
 * belongs to a conflict that is already resolved, so the attempt budget
 * restarts from it — a PR that conflicts again months later gets a full
 * budget rather than inheriting a spent one.
 */
export const CONFLICT_RESOLVED_MARKER =
  "<!-- vibe-coder:merge-conflict-resolved -->";

/** Hours a PR waits after a failed attempt before another is made. */
export const DEFAULT_CONFLICT_COOLDOWN_HOURS = 4;

/**
 * Attempts allowed before the processor stops retrying and escalates.
 * Two: the first attempt, and one retry against a moved base.
 */
export const DEFAULT_MAX_CONFLICT_ATTEMPTS = 2;

/** Label whose presence means a human already owns the conflict. */
const NEEDS_HUMAN_LABEL = "needs-human";

/** PR-list fields this scan needs. */
const PR_FIELDS = "number,headRefName,baseRefName";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A PR whose branch conflicts with its base and needs a real merge. */
export interface ConflictingPr {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Head branch name. */
  branchName: string;
  /** Base branch the PR targets. */
  baseBranch: string;
  /** Attempts already recorded against this PR. */
  attemptCount: number;
}

/** Attempt history read back from a PR's comment thread. */
export interface ConflictAttemptHistory {
  /** Number of recorded attempts. */
  count: number;
  /** ISO timestamp of the most recent attempt, when known. */
  lastAttemptAt?: string;
}

/** Options for {@link findConflictingPr}. */
export interface FindConflictingPrOptions {
  /** GitHub login that authored the worker's PRs. */
  githubUser: string;
  /** Trusted human logins (`allowed_authors`). */
  allowedAuthors?: readonly string[];
  /** Sibling fleet logins (`fleet_pr_authors`). */
  fleetPrAuthors?: readonly string[];
  /** Monitored repos in `owner/repo` format. */
  repos: readonly string[];
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Allowlist check for a repo. */
  isRepoAllowed: (repo: string) => boolean;
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Shared PR-list cache (Issue #4303). */
  cache?: IssueCache;
  /** Optional repo shuffler so no repo is starved. */
  shuffleRepos?: (repos: string[]) => string[];
  /** Hours between attempts on the same PR. */
  cooldownHours?: number;
  /** Attempts allowed before the PR is left to a human. */
  maxAttempts?: number;
  /** Clock override (epoch milliseconds). */
  nowMs?: () => number;
}

// ---------------------------------------------------------------------------
// Pure decision helpers
// ---------------------------------------------------------------------------

/**
 * Count the conflict-resolution attempts recorded in a comment thread.
 *
 * Attempts are recorded as comments carrying {@link CONFLICT_ATTEMPT_MARKER}
 * — posted *before* the attempt runs, so a worker that dies mid-merge still
 * spends its attempt rather than looping. A {@link CONFLICT_RESOLVED_MARKER}
 * comment resets the count: attempts before a successful merge belong to a
 * conflict that is already over.
 *
 * The history lives on the PR rather than in host-local state, so the bound
 * holds across worker restarts and across hosts.
 *
 * @param comments - Raw comment objects from the GitHub REST API, oldest first.
 * @returns Attempt count and the timestamp of the most recent attempt.
 */
export function parseConflictAttempts(
  comments: readonly unknown[],
): ConflictAttemptHistory {
  let count = 0;
  let lastAttemptAt: string | undefined;

  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const comment = raw as { body?: unknown; created_at?: unknown };
    if (typeof comment.body !== "string") continue;

    if (comment.body.includes(CONFLICT_RESOLVED_MARKER)) {
      count = 0;
      lastAttemptAt = undefined;
      continue;
    }

    if (!comment.body.includes(CONFLICT_ATTEMPT_MARKER)) continue;

    count++;
    const createdAt = typeof comment.created_at === "string"
      ? comment.created_at
      : undefined;
    if (!createdAt) continue;
    if (
      lastAttemptAt === undefined ||
      Date.parse(createdAt) > Date.parse(lastAttemptAt)
    ) {
      lastAttemptAt = createdAt;
    }
  }

  return { count, lastAttemptAt };
}

/**
 * Whether another attempt on this PR is due.
 *
 * False while the cooldown since the last recorded attempt has not
 * elapsed, so a PR cannot be re-attempted every pass. An unparseable
 * timestamp is treated as "cooldown not elapsed" — the conservative
 * direction, because guessing the other way re-attempts every pass.
 *
 * @param history - Attempt history from {@link parseConflictAttempts}.
 * @param nowMs - Current time in epoch milliseconds.
 * @param cooldownHours - Hours that must pass between attempts.
 */
export function isConflictAttemptDue(
  history: ConflictAttemptHistory,
  nowMs: number,
  cooldownHours: number = DEFAULT_CONFLICT_COOLDOWN_HOURS,
): boolean {
  if (history.lastAttemptAt === undefined) return true;
  const lastMs = Date.parse(history.lastAttemptAt);
  if (Number.isNaN(lastMs)) return false;
  return nowMs - lastMs >= cooldownHours * 3600_000;
}

/**
 * Whether the PR has spent its attempt budget.
 *
 * @param attemptCount - Attempts already recorded.
 * @param maxAttempts - Budget.
 */
export function hasExhaustedConflictAttempts(
  attemptCount: number,
  maxAttempts: number = DEFAULT_MAX_CONFLICT_ATTEMPTS,
): boolean {
  return attemptCount >= maxAttempts;
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

/** Read a PR's label names. Throws so callers can fail loud. */
async function fetchPrLabels(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string[]> {
  const raw = await ghCommandFn([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "labels",
    "--jq",
    ".labels[].name",
  ]);
  return raw.split("\n").map((line) => line.trim()).filter((l) => l.length > 0);
}

/**
 * Apply {@link MERGE_CONFLICT_LABEL} to a PR so the stuck queue is visible
 * without trawling per-pass log noise (Issue #84).
 *
 * @returns True when the label was added by this call.
 */
export async function ensureMergeConflictLabel(
  repo: string,
  prNumber: number,
  existingLabels: readonly string[],
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  if (existingLabels.includes(MERGE_CONFLICT_LABEL)) return false;

  const ensured = await ensureLabelExists(
    repo,
    MERGE_CONFLICT_LABEL,
    MERGE_CONFLICT_LABEL_COLOUR,
    MERGE_CONFLICT_LABEL_DESCRIPTION,
    { ghCommandFn },
  );
  if (!ensured.ok) throw ensured.error;

  // Routed through the guarded helper, not a raw `gh pr edit --add-label`,
  // so the Rule-of-Two worker-label allowlist gates this call site too
  // (Issue #2382). PRs are issues to the labels endpoint.
  const added = await addLabelToIssue(repo, prNumber, MERGE_CONFLICT_LABEL, {
    ghCommandFn,
  });
  if (!added.ok) throw added.error;
  return true;
}

/** Remove {@link MERGE_CONFLICT_LABEL} once the PR merges cleanly again. */
export async function clearMergeConflictLabel(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<void> {
  await ghCommandFn([
    "api",
    "-X",
    "DELETE",
    `repos/${repo}/issues/${prNumber}/labels/${MERGE_CONFLICT_LABEL}`,
  ]);
}

/** Mergeable state per PR number, batched where possible. */
async function fetchMergeableStates(
  repo: string,
  prs: readonly PrEntry[],
  ghCommandFn: (args: string[]) => Promise<string>,
  cache: IssueCache | undefined,
  logger: Logger,
): Promise<Map<number, string>> {
  const states = new Map<number, string>();
  if (prs.length === 0) return states;

  const batch = await fetchPRBranchStateBatch(
    repo,
    prs.map((pr) => ({
      number: pr.number,
      // allow-hardcoded-branch — safe fallback when the listing omits the base
      baseRefName: pr.baseRefName || "main",
    })),
    ghCommandFn,
    cache,
  );

  if (batch.ok) {
    for (const [number, state] of batch.states) {
      states.set(number, state.mergeable);
    }
    return states;
  }

  logger.debug("Merge-conflict scan: batch state fetch failed, using REST", {
    repo,
    error: batch.error.message,
  });

  for (const pr of prs) {
    try {
      const raw = await ghCommandFn([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repo,
        "--json",
        "mergeable",
        "--jq",
        ".mergeable",
      ]);
      states.set(pr.number, raw.trim());
    } catch (err) {
      logger.debug("Merge-conflict scan: mergeable lookup failed", {
        repo,
        prNumber: pr.number,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return states;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Find one worker PR that conflicts with its base and is due an attempt.
 *
 * Every conflicting PR encountered is labelled {@link MERGE_CONFLICT_LABEL}
 * whether or not it is selected, so the queue is visible immediately. A PR
 * already carrying `needs-human`, already at its attempt cap, or still
 * inside its cooldown is labelled but not returned.
 *
 * Per-repo failures are logged and skipped so one unreachable repo cannot
 * stall the scan.
 *
 * @returns The PR to work on, or `null` when nothing is due.
 */
export async function findConflictingPr(
  options: FindConflictingPrOptions,
): Promise<Result<ConflictingPr | null>> {
  const {
    githubUser,
    allowedAuthors = [],
    fleetPrAuthors = [],
    repos,
    logger,
    isRepoAllowed,
    ghCommandFn,
    cache,
    shuffleRepos,
    cooldownHours = DEFAULT_CONFLICT_COOLDOWN_HOURS,
    maxAttempts = DEFAULT_MAX_CONFLICT_ATTEMPTS,
    nowMs = () => Date.now(),
  } = options;

  // The pass pushes a merge commit to the PR branch, so it is scoped to
  // the push-capable maintenance set (Issue #4076) — never an uninvited
  // human's PR.
  const scanAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    allowedAuthors,
    fleetPrAuthors,
  });

  const orderedRepos = shuffleRepos ? shuffleRepos([...repos]) : [...repos];

  for (const repo of orderedRepos) {
    if (!isRepoAllowed(repo)) continue;

    let prs: PrEntry[];
    try {
      prs = await listOpenPrs(repo, scanAuthors, PR_FIELDS, ghCommandFn, cache);
    } catch (err) {
      logger.warn("Merge-conflict scan: failed to list PRs", {
        repo,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const states = await fetchMergeableStates(
      repo,
      prs,
      ghCommandFn,
      cache,
      logger,
    );

    for (const pr of prs) {
      if (states.get(pr.number) !== "CONFLICTING") continue;

      let labels: string[];
      try {
        labels = await fetchPrLabels(repo, pr.number, ghCommandFn);
      } catch (err) {
        logger.warn("Merge-conflict scan: failed to read PR labels", {
          repo,
          prNumber: pr.number,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Make the queue visible before deciding whether to act — a PR the
      // worker will not touch is exactly the one a human must be able to
      // see (Issue #84).
      try {
        if (
          await ensureMergeConflictLabel(repo, pr.number, labels, ghCommandFn)
        ) {
          logger.warn(
            `PR #${pr.number} conflicts with ${
              pr.baseRefName ?? "its base"
            } — labelled '${MERGE_CONFLICT_LABEL}'`,
            { repo, prNumber: pr.number },
          );
        }
      } catch (err) {
        logger.warn("Merge-conflict scan: failed to apply conflict label", {
          repo,
          prNumber: pr.number,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (labels.includes(NEEDS_HUMAN_LABEL)) {
        logger.debug("Conflicting PR already escalated to a human — skipping", {
          repo,
          prNumber: pr.number,
        });
        continue;
      }

      let history: ConflictAttemptHistory;
      try {
        history = parseConflictAttempts(
          await fetchIssueCommentPages(repo, pr.number, ghCommandFn),
        );
      } catch (err) {
        logger.warn("Merge-conflict scan: failed to read attempt history", {
          repo,
          prNumber: pr.number,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (hasExhaustedConflictAttempts(history.count, maxAttempts)) {
        logger.debug("Conflicting PR has spent its attempt budget", {
          repo,
          prNumber: pr.number,
          attempts: history.count,
          maxAttempts,
        });
        continue;
      }

      if (!isConflictAttemptDue(history, nowMs(), cooldownHours)) {
        logger.debug("Conflicting PR is still inside its attempt cooldown", {
          repo,
          prNumber: pr.number,
          lastAttemptAt: history.lastAttemptAt,
          cooldownHours,
        });
        continue;
      }

      logger.info("Found a conflicting PR that needs a real merge", {
        repo,
        prNumber: pr.number,
        attempts: history.count,
      });

      return {
        ok: true,
        value: {
          repo,
          prNumber: pr.number,
          branchName: pr.headRefName,
          // allow-hardcoded-branch — safe fallback when the listing omits it
          baseBranch: pr.baseRefName || "main",
          attemptCount: history.count,
        },
      };
    }
  }

  return { ok: true, value: null };
}
