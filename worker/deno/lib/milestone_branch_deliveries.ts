/**
 * Issues whose work merged into a milestone branch but which now sit in
 * another milestone (Issue #5458).
 *
 * A milestone rollup's "Issues addressed" list was read from the milestone's
 * current membership alone, so an issue moved to a later milestone after its
 * PR landed on this milestone's branch dropped out of the rollup that
 * delivered it. This module reads the branch side: the merged PRs based on
 * the milestone branch, the issue each one names (from its head branch or its
 * title), and each such issue's current milestone, so the rollup can still
 * claim it and say where it now sits.
 *
 * Only same-repository PRs count, and fleet milestone sync heads are skipped.
 * A failed or malformed read throws with context; it is never treated as an
 * empty list (Issue #3662), so the caller can skip the milestone instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
import type { IssueCache } from "./issue_cache.ts";
import { isMilestoneSyncBranch } from "./milestone_sync_branch.ts";
import { extractIssueNumberFromPrTitle } from "./pr_body.ts";

/** The gh runner the milestone helpers take. */
type GhCommandFn = (args: string[]) => Promise<string>;

/** A closed issue that merged into the milestone branch and now sits elsewhere. */
export interface IssueMovedOffBranch {
  number: number;
  title: string;
  /** Last-update timestamp from the REST issue, when it carries one. */
  updatedAt?: string;
  /** Title of the milestone the issue now sits in, or null when it has none. */
  movedToMilestone: string | null;
}

/** The fields of a REST issue read this module relies on, validated. */
interface RestIssueRow {
  title: string;
  state: string;
  updatedAt?: string;
  pullRequest: boolean;
  milestoneNumber: number | null;
  milestoneTitle: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject incomplete gh rows instead of silently dropping delivered issues. */
function validateMergedPrRows(rows: unknown[], context: string): void {
  for (const row of rows) {
    if (!isRecord(row)) throw new Error(`${context}: malformed PR row`);
    if (
      typeof row.number !== "number" || !Number.isSafeInteger(row.number) ||
      row.number <= 0
    ) {
      throw new Error(`${context}: malformed number`);
    }
    for (const field of ["title", "headRefName"] as const) {
      if (typeof row[field] !== "string") {
        throw new Error(`${context}: malformed ${field}`);
      }
    }
    if (typeof row.isCrossRepository !== "boolean") {
      throw new Error(`${context}: malformed isCrossRepository`);
    }
  }
}

/**
 * Read the merged PRs based on the milestone branch (Issue #5458).
 *
 * A validated array is cached under the branch name. An unreadable or
 * malformed response throws and is not cached; cached rows are validated too.
 */
async function readMergedIntoBranch(
  repo: string,
  milestoneBranch: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<unknown[]> {
  const cacheKey = `prs_base_merged_${milestoneBranch}`;
  const context = `the pull requests merged into ${milestoneBranch} in ${repo}`;
  if (cache) {
    const cached = await cache.read<unknown[]>(repo, cacheKey);
    if (Array.isArray(cached)) {
      validateMergedPrRows(cached, context);
      return cached;
    }
  }

  let output: string;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--base",
      milestoneBranch,
      "--state",
      "merged",
      "--json",
      "number,title,headRefName,isCrossRepository",
      "--limit",
      "1000",
    ]);
  } catch (error) {
    throw new Error(`could not read ${context}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error(`could not read ${context}: the response was not JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `could not read ${context}: the response was not a JSON array`,
    );
  }
  validateMergedPrRows(parsed, context);

  if (cache) await cache.write(repo, cacheKey, parsed);
  return parsed;
}

/**
 * The issue numbers one merged PR row names: its head branch first, then its
 * title's trailing `(#N)` or `(Issue #N)`.
 */
function candidateIssueNumbers(row: Record<string, unknown>): number[] {
  const found: number[] = [];
  if (typeof row.headRefName === "string") {
    const fromBranch = issueNumberFromBranch(row.headRefName);
    if (fromBranch !== null) found.push(fromBranch);
  }
  if (typeof row.title === "string") {
    const fromTitle = extractIssueNumberFromPrTitle(row.title);
    if (fromTitle.ok) found.push(fromTitle.value);
  }
  return found;
}

/**
 * Read one issue over REST and validate the fields this module uses. A failed
 * read or a malformed row throws with context.
 */
async function readIssueRow(
  repo: string,
  issueNumber: number,
  ghCommandFn: GhCommandFn,
): Promise<RestIssueRow> {
  const context = `issue #${issueNumber} of ${repo}`;
  let output: string;
  try {
    output = await ghCommandFn(["api", `repos/${repo}/issues/${issueNumber}`]);
  } catch (error) {
    throw new Error(`could not read ${context}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error(`could not read ${context}: the response was not JSON`);
  }
  if (
    !isRecord(parsed) || typeof parsed.title !== "string" ||
    (parsed.updated_at !== undefined && typeof parsed.updated_at !== "string")
  ) {
    throw new Error(`${context} is malformed`);
  }
  if (parsed.state !== "open" && parsed.state !== "closed") {
    throw new Error(`${context}: malformed state`);
  }

  let milestoneNumber: number | null = null;
  let milestoneTitle: string | null = null;
  const milestone = parsed.milestone;
  if (milestone !== null) {
    if (
      !isRecord(milestone) || typeof milestone.number !== "number" ||
      !Number.isSafeInteger(milestone.number) || milestone.number <= 0 ||
      typeof milestone.title !== "string"
    ) {
      throw new Error(`${context}: malformed milestone`);
    }
    milestoneNumber = milestone.number;
    milestoneTitle = milestone.title;
  }

  return {
    title: parsed.title,
    state: parsed.state,
    ...(typeof parsed.updated_at === "string"
      ? { updatedAt: parsed.updated_at }
      : {}),
    pullRequest: parsed.pull_request !== undefined &&
      parsed.pull_request !== null,
    milestoneNumber,
    milestoneTitle,
  };
}

/**
 * The closed issues that merged into `milestoneBranch` but now sit in another
 * milestone, ascending by number (Issue #5458).
 *
 * Up to 1,000 merged PRs based on the branch are read. Same-repository PRs,
 * other than fleet milestone sync PRs, name candidate issues from their head
 * branches and titles. Candidates in `excluded` (the milestone's own members)
 * are dropped, then each remaining candidate is read over REST. A candidate is returned
 * only when it is closed, is not a pull request, and does not sit in
 * `milestoneNumber`; `movedToMilestone` is its milestone's title, or null
 * when it has none.
 *
 * @throws when the merged-PR list or an issue read fails or is malformed.
 */
export async function fetchIssuesMovedOffBranch(
  repo: string,
  milestoneBranch: string,
  milestoneNumber: number,
  excluded: ReadonlySet<number>,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<IssueMovedOffBranch[]> {
  const rows = await readMergedIntoBranch(
    repo,
    milestoneBranch,
    ghCommandFn,
    cache,
  );

  const candidates = new Set<number>();
  for (const row of rows) {
    if (!isRecord(row) || row.isCrossRepository !== false) continue;
    if (
      isMilestoneSyncBranch(
        typeof row.headRefName === "string" ? row.headRefName : null,
      )
    ) {
      continue;
    }
    for (const issueNumber of candidateIssueNumbers(row)) {
      if (!excluded.has(issueNumber)) candidates.add(issueNumber);
    }
  }

  const moved: IssueMovedOffBranch[] = [];
  for (const issueNumber of [...candidates].sort((a, b) => a - b)) {
    const issue = await readIssueRow(repo, issueNumber, ghCommandFn);
    if (issue.pullRequest || issue.state !== "closed") continue;
    if (issue.milestoneNumber === milestoneNumber) continue;
    moved.push({
      number: issueNumber,
      title: issue.title,
      ...(issue.updatedAt !== undefined ? { updatedAt: issue.updatedAt } : {}),
      movedToMilestone: issue.milestoneTitle,
    });
  }
  return moved;
}
