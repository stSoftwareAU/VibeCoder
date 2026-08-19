/**
 * Auto-milestone for planning sub-issues (Issue #2863).
 *
 * When a planning run breaks an issue into two or more sub-issues and the
 * parent issue has no milestone of its own, the worker auto-creates a GitHub
 * milestone named `#<N> <title>` (from the parent issue) and assigns every
 * sub-issue it created to that milestone. Assigning the milestone is enough to
 * opt the sub-issues into the existing milestone-branch delivery workflow
 * (Issue #1300): their PRs auto-merge into a shared `milestone/<name>` branch
 * and the default branch is only updated via the single final milestone PR.
 *
 * Gating rules (always on, no opt-out):
 *   - Parent already has a milestone → no-op (the #1300 inheritance path keeps
 *     ownership; we never create a competing milestone).
 *   - Fewer than two sub-issues → no-op (a single sub-issue is handled directly,
 *     so it gets no milestone).
 *
 * Idempotent: the milestone is matched by title before any POST, so re-running
 * planning on the same parent issue never creates a duplicate milestone. The
 * whole flow is best-effort — callers treat a failure as non-fatal so planning
 * closure is never blocked.
 *
 * Australian English spelling used throughout.
 */

import { runGhCommand } from "./github.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Title helper
// ---------------------------------------------------------------------------

/**
 * GitHub does not document a hard milestone-title limit, but very long titles
 * are awkward in the UI and risk rejection. Truncate to a safe length with an
 * ellipsis so the derived `milestone/<name>` branch stays sensible.
 */
export const MAX_MILESTONE_TITLE_LENGTH = 200;

/**
 * Build the canonical auto-milestone title for a planning parent issue:
 * `#<N> <title>`, truncated to {@link MAX_MILESTONE_TITLE_LENGTH} with a
 * trailing ellipsis when the title is too long.
 */
export function buildPlanningMilestoneTitle(
  parentIssueNumber: number,
  parentIssueTitle: string,
): string {
  const raw = `#${parentIssueNumber} ${parentIssueTitle.trim()}`.trim();
  if (raw.length <= MAX_MILESTONE_TITLE_LENGTH) return raw;
  return raw.slice(0, MAX_MILESTONE_TITLE_LENGTH - 1).trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MaybeCreatePlanningMilestoneOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** Parent planning issue number — used in the milestone title. */
  parentIssueNumber: number;
  /** Parent planning issue title — used in the milestone title. */
  parentIssueTitle: string;
  /**
   * Existing milestone title on the parent issue, if any (Issue #1300
   * inheritance). When set, this helper is a no-op.
   */
  parentMilestoneTitle?: string;
  /** Sub-issue numbers created by this planning run. */
  subIssueNumbers: number[];
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Logger for non-fatal warnings. */
  logger: Logger;
}

export interface PlanningMilestoneOutcome {
  /** True when a milestone was ensured and sub-issues were assigned. */
  created: boolean;
  /** The milestone title used, when `created` is true. */
  milestoneTitle?: string;
  /** Sub-issue numbers successfully assigned to the milestone. */
  assigned: number[];
  /** Reason the helper was a no-op, when `created` is false. */
  skippedReason?: "parent-has-milestone" | "too-few-sub-issues";
}

// ---------------------------------------------------------------------------
// maybeCreatePlanningMilestone
// ---------------------------------------------------------------------------

/**
 * Auto-create a milestone for a planning run's sub-issues and assign them all
 * to it, when the gating rules are met. See the module docstring for the rules.
 *
 * Best-effort: an ensure or assign failure is logged and swallowed so the
 * caller's planning closure is never blocked. A per-sub-issue assign failure
 * does not abort the remaining assignments.
 */
export async function maybeCreatePlanningMilestone(
  opts: MaybeCreatePlanningMilestoneOptions,
): Promise<PlanningMilestoneOutcome> {
  const {
    repo,
    parentIssueNumber,
    parentIssueTitle,
    parentMilestoneTitle,
    subIssueNumbers,
    logger,
  } = opts;
  const gh = opts.ghCommandFn ?? runGhCommand;

  // Gate 1: the parent already owns a milestone — keep the #1300 inheritance
  // path and never create a competing milestone.
  if (parentMilestoneTitle && parentMilestoneTitle.trim() !== "") {
    return {
      created: false,
      assigned: [],
      skippedReason: "parent-has-milestone",
    };
  }

  // Gate 2: a milestone only makes sense for 2+ sub-issues.
  const unique = [...new Set(subIssueNumbers)].sort((a, b) => a - b);
  if (unique.length < 2) {
    return {
      created: false,
      assigned: [],
      skippedReason: "too-few-sub-issues",
    };
  }

  const title = buildPlanningMilestoneTitle(
    parentIssueNumber,
    parentIssueTitle,
  );

  // Idempotent ensure — match by title before POSTing a new milestone.
  let milestoneNumber: number;
  try {
    milestoneNumber = await ensurePlanningMilestone(repo, title, gh);
  } catch (err) {
    logger.warn("Failed to ensure planning milestone (non-fatal)", {
      repo,
      parentIssueNumber,
      milestoneTitle: title,
      error: err instanceof Error ? err.message : String(err),
    });
    return { created: false, assigned: [] };
  }

  // Assign each sub-issue. Assigning by milestone number is unambiguous; a
  // single failure does not abort the rest.
  const assigned: number[] = [];
  for (const n of unique) {
    try {
      await gh([
        "issue",
        "edit",
        String(n),
        "--repo",
        repo,
        "--milestone",
        title,
      ]);
      assigned.push(n);
    } catch (err) {
      logger.warn(
        "Failed to assign sub-issue to planning milestone (non-fatal)",
        {
          repo,
          subIssueNumber: n,
          milestoneTitle: title,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  logger.info("Auto-created planning milestone for sub-issues (Issue #2863)", {
    repo,
    parentIssueNumber,
    milestoneTitle: title,
    milestoneNumber,
    assignedCount: assigned.length,
  });

  return { created: true, milestoneTitle: title, assigned };
}

// ---------------------------------------------------------------------------
// Idempotent ensure
// ---------------------------------------------------------------------------

/**
 * Ensure an open milestone with `title` exists in `repo`, returning its number.
 * Matches an existing open milestone by exact title before POSTing a new one,
 * so repeated calls make at most one POST per `(repo, title)` pair.
 */
async function ensurePlanningMilestone(
  repo: string,
  title: string,
  gh: (args: string[]) => Promise<string>,
): Promise<number> {
  const endpoint = `repos/${repo}/milestones`;

  const listingRaw = await gh(["api", `${endpoint}?state=open`]);
  const existing = findMilestoneNumberByTitle(listingRaw, title);
  if (existing !== null) return existing;

  const createRaw = await gh([
    "api",
    "-X",
    "POST",
    endpoint,
    "-f",
    `title=${title}`,
    "-f",
    `description=${buildDescription()}`,
  ]);
  const created = parseMilestoneNumber(createRaw);
  if (created === null) {
    throw new Error(
      `ensurePlanningMilestone: malformed create response for "${title}" in ${repo}`,
    );
  }
  return created;
}

/** Static description embedded in newly-created planning milestones. */
function buildDescription(): string {
  return (
    "Auto-created by planning (Issue #2863) — groups the sub-issues of a " +
    "planning run for milestone-branch delivery."
  );
}

/**
 * Return the number of the open milestone whose title exactly matches
 * `wantTitle`, or null when the listing is malformed or no match is found. A
 * malformed listing is treated as "no match" so a fresh POST can recover.
 */
function findMilestoneNumberByTitle(
  raw: string,
  wantTitle: string,
): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (r.title !== wantTitle) continue;
    if (typeof r.number !== "number") continue;
    return r.number;
  }
  return null;
}

/** Parse the milestone number from the single-object create response. */
function parseMilestoneNumber(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  return typeof r.number === "number" ? r.number : null;
}
