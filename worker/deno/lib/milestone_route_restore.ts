/**
 * Restore a working route for an open milestone whose rollup has merged
 * (Issue #4175).
 *
 * The route is a fresh rollup pull request from the milestone branch to the
 * default branch. A milestone-fix pull request stays on the milestone branch
 * and is reviewed by that rollup; it is never moved onto the default branch
 * (Issue #3433). Retiring the branch is not required: a fresh rollup does not
 * land a milestone-fix pull request on the default branch.
 *
 * A milestone that is closed, or that has no open work, is left closed. The
 * milestone sync must not open a sync pull request into that branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import { parseJsonArrayPages } from "./json_array_pages.ts";
import { logAt, type LogSink } from "./log_sink.ts";
import {
  fetchOpenMilestoneChildren,
  isMilestoneBranch,
} from "./milestone_children_gate.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";

/** Function signature for running gh CLI commands. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** Marker in every fresh-rollup body. Posted in the target repository. */
export const RESTORED_ROLLUP_MARKER = "<!-- vibe-restored-milestone-rollup -->";

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;

/** How far `milestoneBranch` is ahead of `defaultBranch`, and whether the diff has files. */
export interface BranchCompare {
  /** Commits on the milestone branch that are not on the default branch. */
  aheadBy: number;
  /**
   * Changed files in that range. `null` when the payload omitted `files`
   * (not proof the diff is empty).
   */
  fileCount: number | null;
}

/**
 * Read `compare/{default}...{milestone}`.
 *
 * Fails loud: a thrown `gh` call or a payload without a numeric `ahead_by`
 * is an error, never a quiet zero.
 */
export async function readBranchCompare(
  repo: string,
  defaultBranch: string,
  milestoneBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<Result<BranchCompare>> {
  let raw: string;
  try {
    raw = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${defaultBranch}...${milestoneBranch}`,
      "--jq",
      "{ahead_by, files}",
    ]);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `could not compare ${defaultBranch}...${milestoneBranch}: ${
          errorText(err)
        }`,
      ),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: new Error(
        `compare ${defaultBranch}...${milestoneBranch} returned no ahead_by`,
      ),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error(
        `compare ${defaultBranch}...${milestoneBranch} returned no ahead_by`,
      ),
    };
  }
  const aheadBy = (parsed as { ahead_by?: unknown }).ahead_by;
  if (typeof aheadBy !== "number" || !Number.isFinite(aheadBy)) {
    return {
      ok: false,
      error: new Error(
        `compare ${defaultBranch}...${milestoneBranch} returned no ahead_by`,
      ),
    };
  }
  const files = (parsed as { files?: unknown }).files;
  return {
    ok: true,
    value: {
      aheadBy,
      fileCount: Array.isArray(files) ? files.length : null,
    },
  };
}

/** What {@link restoreClosedMilestoneRoute} did. */
export type RouteRestoreOutcome =
  /** A fresh rollup pull request was opened. */
  | {
    action: "created";
    prUrl: string;
    milestoneBranch: string;
    /**
     * Set when this pass merged the child into the milestone branch before
     * opening the rollup. The caller must not merge that pull request again.
     */
    landedChildPr?: number;
  }
  /**
   * The branch is not ahead, and the open work is the child itself. The
   * caller merges that child through the ordinary path (gated direct merge
   * or auto-merge) and opens the rollup only once the merge has landed.
   */
  | {
    action: "merge-via-gate";
    milestoneBranch: string;
    defaultBranch: string;
    /** Milestone issues to reopen if the merge lands and the rollup does not. */
    issueNumbers: readonly number[];
  }
  /** An open rollup from this branch already exists. */
  | { action: "exists"; prNumber: number; milestoneBranch: string }
  /** No merged rollup — the route was not closed. */
  | { action: "not-closed"; milestoneBranch: string }
  /**
   * The milestone is open with work, but the branch is not ahead of the
   * default branch, so GitHub will not open a rollup yet.
   */
  | { action: "waiting"; milestoneBranch: string; detail: string }
  /** The route stays closed: the milestone is closed or has no open work. */
  | { action: "left-closed"; milestoneBranch: string; detail: string }
  /** A lookup or create failed. Never reported as success. */
  | { action: "failed"; reason: string }
  /**
   * The child was merged and the rollup was not opened. Its issue is not
   * left closed (Issue #4175).
   */
  | { action: "land-failed"; reason: string };

/** Inputs for {@link restoreClosedMilestoneRoute}. */
export interface RouteRestoreOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** Milestone branch (`milestone/<slug>`). */
  milestoneBranch: string;
  /** Function to execute gh CLI commands. */
  ghCommandFn: GhCommandFn;
  /** Default branch, when the caller already has it. */
  defaultBranch?: string;
  /** Default-branch lookup, when the caller already has one. */
  getDefaultBranchFn?: (repo: string) => Promise<Result<string>>;
  /** Sink for progress and failure lines. */
  log?: LogSink;
  /**
   * When the branch is not ahead, ask the caller to merge this child
   * through the ordinary merge path (Issue #4175). Omitted by the sync
   * path, which must not open a pull request into a waiting route.
   */
  landChildPrNumber?: number;
}

interface RawRollupPr {
  number?: unknown;
  state?: unknown;
  baseRefName?: unknown;
  mergedAt?: unknown;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Pull requests whose head is the milestone branch. Throws on a bad read. */
async function listHeadPullRequests(
  repo: string,
  milestoneBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<RawRollupPr[]> {
  const raw = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    milestoneBranch,
    "--state",
    "all",
    "--json",
    "number,state,baseRefName,mergedAt",
    "--limit",
    "50",
  ]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `gh pr list for ${milestoneBranch} returned ${typeof parsed}, not an array`,
    );
  }
  return parsed as RawRollupPr[];
}

function isOpenRoute(pr: RawRollupPr): pr is RawRollupPr & { number: number } {
  return typeof pr.state === "string" && pr.state.toUpperCase() === "OPEN" &&
    typeof pr.number === "number" &&
    (typeof pr.baseRefName !== "string" || !isMilestoneBranch(pr.baseRefName));
}

function mergedRollup(prs: readonly RawRollupPr[]): RawRollupPr | undefined {
  return prs.find((pr) =>
    typeof pr.state === "string" && pr.state.toUpperCase() === "MERGED" &&
    typeof pr.number === "number"
  );
}

interface MilestoneMatch {
  number: number;
  title: string;
  state: string;
}

/** The milestone whose branch name is `milestoneBranch`. Throws when unread. */
async function findMilestone(
  repo: string,
  milestoneBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<MilestoneMatch | null> {
  const raw = await ghCommandFn([
    "api",
    "--paginate",
    `repos/${repo}/milestones?state=all&per_page=100`,
  ]);
  for (const item of parseJsonArrayPages(raw)) {
    if (!item || typeof item !== "object") continue;
    const record = item as {
      number?: unknown;
      title?: unknown;
      state?: unknown;
    };
    if (typeof record.title !== "string") continue;
    if (createMilestoneBranchName(record.title) !== milestoneBranch) continue;
    if (typeof record.number !== "number") {
      throw new Error(`milestone "${record.title}" has no number`);
    }
    return {
      number: record.number,
      title: record.title,
      state: typeof record.state === "string" ? record.state : "",
    };
  }
  return null;
}

/**
 * Body of the fresh rollup. Posted in the target repository, so it carries
 * no Vibe Coder issue number — GitHub would autolink a bare `#N` there.
 * It also carries no closing keyword, so merging it does not close an issue
 * by the body alone.
 */
export function buildRestoredRollupBody(
  milestoneBranch: string,
  defaultBranch: string,
  aheadBy: number,
): string {
  return `${RESTORED_ROLLUP_MARKER}
## Fresh milestone rollup

The previous rollup of \`${milestoneBranch}\` into \`${defaultBranch}\` has already merged, and the milestone still has open work. \`${milestoneBranch}\` is ${aheadBy} commit(s) ahead of \`${defaultBranch}\`. This pull request is that branch's route to \`${defaultBranch}\`.

Child pull requests stay based on \`${milestoneBranch}\` and merge there. This pull request carries that work to \`${defaultBranch}\` once the milestone's review is done.

The fleet does not move a milestone pull request onto \`${defaultBranch}\` directly.

Raised automatically by the Vibe Coder.`;
}

async function openFreshRollup(
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
  aheadBy: number,
  ghCommandFn: GhCommandFn,
): Promise<{ ok: true; prUrl: string } | { ok: false; reason: string }> {
  const body = buildRestoredRollupBody(
    milestoneBranch,
    defaultBranch,
    aheadBy,
  );
  try {
    const prUrl = (await ghCommandFn([
      "pr",
      "create",
      "--repo",
      repo,
      "--title",
      `Milestone rollup: ${milestoneBranch} → ${defaultBranch}`,
      "--body",
      body,
      "--head",
      milestoneBranch,
      "--base",
      defaultBranch,
    ])).trim();
    return { ok: true, prUrl };
  } catch (err) {
    return {
      ok: false,
      reason: `could not create the rollup PR for ${milestoneBranch}: ${
        errorText(err)
      }`,
    };
  }
}

/** Reopen milestone issues a child merge closed. Returns a clause for the failure. */
async function reopenClosedIssues(
  repo: string,
  issueNumbers: readonly number[],
  ghCommandFn: GhCommandFn,
): Promise<string> {
  if (issueNumbers.length === 0) {
    return "No milestone issue number was available to reopen.";
  }
  const problems: string[] = [];
  for (const number of issueNumbers) {
    if (!Number.isInteger(number) || number <= 0) {
      problems.push(`#${number} is not a pull-request issue number`);
      continue;
    }
    try {
      await ghCommandFn([
        "issue",
        "reopen",
        String(number),
        "--repo",
        repo,
      ]);
    } catch (err) {
      problems.push(`#${number} could not be reopened (${errorText(err)})`);
    }
  }
  if (problems.length > 0) {
    return `Reopen failed: ${problems.join("; ")}.`;
  }
  const listed = issueNumbers.map((number) => `#${number}`).join(", ");
  return `Reopened ${listed} so the issue is not left closed.`;
}

/**
 * Open the rollup after the child has already landed on the milestone
 * branch. A rollup that cannot be created does not leave the issue closed.
 */
export async function openRollupForLandedChild(
  options: {
    repo: string;
    milestoneBranch: string;
    defaultBranch: string;
    childPrNumber: number;
    issueNumbers: readonly number[];
    ghCommandFn: GhCommandFn;
    log?: LogSink;
  },
): Promise<RouteRestoreOutcome> {
  const {
    repo,
    milestoneBranch,
    defaultBranch,
    childPrNumber,
    issueNumbers,
    ghCommandFn,
    log,
  } = options;
  if (!Number.isInteger(childPrNumber) || childPrNumber <= 0) {
    return {
      action: "failed",
      reason: `child PR number ${childPrNumber} is not a positive integer`,
    };
  }
  const compare = await readBranchCompare(
    repo,
    defaultBranch,
    milestoneBranch,
    ghCommandFn,
  );
  if (!compare.ok || compare.value.aheadBy <= 0) {
    const reopen = await reopenClosedIssues(
      repo,
      issueNumbers,
      ghCommandFn,
    );
    const why = compare.ok
      ? `${milestoneBranch} is still not ahead of ${defaultBranch}`
      : compare.error.message;
    return {
      action: "land-failed",
      reason:
        `child PR #${childPrNumber} merged onto ${milestoneBranch} but no rollup was opened (${why}). ${reopen}`,
    };
  }
  const opened = await openFreshRollup(
    repo,
    milestoneBranch,
    defaultBranch,
    compare.value.aheadBy,
    ghCommandFn,
  );
  if (!opened.ok) {
    const reopen = await reopenClosedIssues(
      repo,
      issueNumbers,
      ghCommandFn,
    );
    return {
      action: "land-failed",
      reason: `${opened.reason}. ${reopen}`,
    };
  }
  logAt(
    log,
    "info",
    `merged child PR #${childPrNumber} onto ${milestoneBranch} in ${repo} and opened rollup ${opened.prUrl} in the same pass (Issue #4175)`,
  );
  return {
    action: "created",
    prUrl: opened.prUrl,
    milestoneBranch,
    landedChildPr: childPrNumber,
  };
}

/**
 * After a child has merged into a milestone branch, open a rollup when that
 * branch is ahead and no rollup is open (Issue #4175).
 *
 * The merged pull request is no longer open, so the arming path will not see
 * it again. A create failure reopens the child's issues so the work is not
 * left closed on a branch with no route. A base that is not a milestone
 * branch, or a pull request that cannot be read, is left to the caller.
 */
export async function restoreRouteAfterMergedChild(
  options: {
    repo: string;
    prNumber: number;
    issueNumbers: readonly number[];
    ghCommandFn: GhCommandFn;
    log?: LogSink;
  },
): Promise<RouteRestoreOutcome | { action: "not-milestone" }> {
  const { repo, prNumber, issueNumbers, ghCommandFn, log } = options;
  let baseRefName = "";
  try {
    const parsed = JSON.parse(
      await ghCommandFn([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "state,baseRefName",
      ]),
    ) as { state?: unknown; baseRefName?: unknown };
    if (parsed.state !== "MERGED") return { action: "not-milestone" };
    baseRefName = typeof parsed.baseRefName === "string"
      ? parsed.baseRefName.trim()
      : "";
  } catch {
    return { action: "not-milestone" };
  }
  if (!isMilestoneBranch(baseRefName)) return { action: "not-milestone" };

  const restored = await restoreClosedMilestoneRoute({
    repo,
    milestoneBranch: baseRefName,
    ghCommandFn,
    log,
  });
  if (restored.action !== "failed") return restored;
  const stranded = restored.reason.includes("could not create the rollup");
  const reopen = stranded
    ? await reopenClosedIssues(repo, issueNumbers, ghCommandFn)
    : "";
  const detail = reopen ? `${restored.reason}. ${reopen}` : restored.reason;
  logAt(
    log,
    "warn",
    `child PR #${prNumber} merged onto ${baseRefName} in ${repo} but no rollup is open (${detail}) (Issue #4175)`,
  );
  return { action: "failed", reason: detail };
}

/**
 * Open a fresh rollup when an open milestone's previous rollup has merged.
 *
 * Fails loud: a lookup or create that errors returns `failed` with the
 * reason, never a quiet success.
 */
export async function restoreClosedMilestoneRoute(
  options: RouteRestoreOptions,
): Promise<RouteRestoreOutcome> {
  const { repo, milestoneBranch, ghCommandFn, log } = options;
  if (!isMilestoneBranch(milestoneBranch)) {
    return {
      action: "not-closed",
      milestoneBranch,
    };
  }
  if (!REPO_PATTERN.test(repo) || !BRANCH_PATTERN.test(milestoneBranch)) {
    return {
      action: "failed",
      reason: "repo or branch name failed the argument allowlist",
    };
  }

  let prs: RawRollupPr[];
  try {
    prs = await listHeadPullRequests(repo, milestoneBranch, ghCommandFn);
  } catch (err) {
    return {
      action: "failed",
      reason: `could not list rollup PRs for ${milestoneBranch}: ${
        errorText(err)
      }`,
    };
  }
  const open = prs.find(isOpenRoute);
  if (open) {
    return {
      action: "exists",
      prNumber: open.number,
      milestoneBranch,
    };
  }
  const merged = mergedRollup(prs);
  if (!merged || typeof merged.number !== "number") {
    return { action: "not-closed", milestoneBranch };
  }

  let milestone: MilestoneMatch | null;
  try {
    milestone = await findMilestone(repo, milestoneBranch, ghCommandFn);
  } catch (err) {
    return {
      action: "failed",
      reason: `could not read milestones for ${milestoneBranch}: ${
        errorText(err)
      }`,
    };
  }
  if (!milestone || milestone.state.toLowerCase() !== "open") {
    const why = milestone
      ? `milestone "${milestone.title}" is closed`
      : `no open milestone matches ${milestoneBranch}`;
    return {
      action: "left-closed",
      milestoneBranch,
      detail: `rollup PR #${merged.number} has merged and ${why}`,
    };
  }

  const children = await fetchOpenMilestoneChildren({
    repo,
    milestoneNumber: milestone.number,
    milestoneBranch,
    ghCommandFn,
  });
  if (!children.ok) {
    return {
      action: "failed",
      reason: children.error.message,
    };
  }
  let defaultBranch = options.defaultBranch?.trim();
  if (!defaultBranch) {
    const resolved = await (options.getDefaultBranchFn ??
      ((name: string) => getRepoDefaultBranch(name, ghCommandFn)))(repo);
    if (!resolved.ok) {
      return {
        action: "failed",
        reason: `default branch unknown: ${resolved.error.message}`,
      };
    }
    defaultBranch = resolved.value.trim();
  }
  if (!defaultBranch || !BRANCH_PATTERN.test(defaultBranch)) {
    return {
      action: "failed",
      reason: "default branch failed the argument allowlist",
    };
  }

  const compare = await readBranchCompare(
    repo,
    defaultBranch,
    milestoneBranch,
    ghCommandFn,
  );
  if (!compare.ok) {
    return { action: "failed", reason: compare.error.message };
  }
  const { aheadBy, fileCount } = compare.value;
  // No commits to carry. Open work waits; a milestone with nothing open
  // stays closed. An empty file list with commits still ahead is a squash
  // of work the default branch already has — not a new rollup.
  if (aheadBy <= 0 || (children.value.length === 0 && fileCount === 0)) {
    if (children.value.length === 0) {
      return {
        action: "left-closed",
        milestoneBranch,
        detail: aheadBy <= 0
          ? `rollup PR #${merged.number} has merged and milestone "${milestone.title}" has no open work`
          : `rollup PR #${merged.number} has merged and ${milestoneBranch} has no file changes ${defaultBranch} does not already have`,
      };
    }
    if (options.landChildPrNumber !== undefined) {
      return {
        action: "merge-via-gate",
        milestoneBranch,
        defaultBranch,
        issueNumbers: children.value
          .filter((child) => child.kind === "issue")
          .map((child) => child.number),
      };
    }
    return {
      action: "waiting",
      milestoneBranch,
      detail:
        `${milestoneBranch} is not ahead of ${defaultBranch}, so no rollup is open yet`,
    };
  }

  const opened = await openFreshRollup(
    repo,
    milestoneBranch,
    defaultBranch,
    aheadBy,
    ghCommandFn,
  );
  if (!opened.ok) {
    return { action: "failed", reason: opened.reason };
  }
  const carried = children.value.length > 0
    ? "while the milestone still has open work"
    : "while the branch still has changes the default branch does not";
  logAt(
    log,
    "info",
    `opened a fresh rollup for ${milestoneBranch} in ${repo} after rollup PR #${merged.number} merged ${carried} (Issue #4175): ${opened.prUrl}`,
  );
  return { action: "created", prUrl: opened.prUrl, milestoneBranch };
}
