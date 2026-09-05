/**
 * Milestone open-children gate (Issue #3909).
 *
 * Merging a milestone summary PR is the irreversible step of the milestone
 * flow: `stSoftwareAU/VibeCoder` has `delete_branch_on_merge: true`, so the
 * merge deletes the milestone branch, and GitHub auto-closes every PR based on
 * it. Milestone 53 lost in-flight child PR #3901 exactly that way.
 *
 * A completeness check made when the summary PR is *created* is not enough —
 * children can appear (or simply remain) in the window between creation and
 * merge. This module re-reads GitHub's authoritative open-children set
 * immediately before the worker merges the summary PR, and before the
 * completion path closes the tracking issue or the GitHub milestone.
 *
 * "Open children" deliberately spans both shapes that the incident involved:
 *   1. open non-tracking issues assigned to the milestone, and
 *   2. open PRs whose *base* is the milestone branch — the in-flight child PRs
 *      the branch deletion would auto-close, which are typically not assigned
 *      to the milestone at all.
 *
 * Reads are uncached on purpose (time-of-check/time-of-use): the whole point
 * is to see state as it is at merge time, not as an earlier scan cached it.
 *
 * Follows the `idle_task_merge_gate.ts` precedent: pure decision function,
 * injected `gh` runner, no side effects until the caller asks for them.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import { isMilestoneTrackingTitle } from "./milestone_completion.ts";
import { scrubUntrustedText } from "./prompt_delimiter.ts";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

/** Injectable `gh` command runner. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** An open child of a milestone that blocks finalisation. */
export interface OpenMilestoneChild {
  /** Issue or PR number. */
  number: number;
  /** Issue or PR title. */
  title: string;
  /** Which shape of child this is. */
  kind: "issue" | "pr";
}

/**
 * Hidden marker on the explanatory comment. Its presence is what makes the
 * block comment idempotent — repeated scan cycles must not spam the PR.
 */
export const OPEN_CHILDREN_BLOCK_MARKER =
  "<!-- milestone-open-children-merge-block -->";

/** Branch prefix shared by every milestone branch. */
const MILESTONE_BRANCH_PREFIX = "milestone/";

/** Repo must be exactly `owner/repo` before it reaches an API path. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Conservative branch-name allowlist for values interpolated into gh args. */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;

/** Return true when `branch` is a milestone branch. */
export function isMilestoneBranch(branch: string): boolean {
  return branch.startsWith(MILESTONE_BRANCH_PREFIX) &&
    branch.length > MILESTONE_BRANCH_PREFIX.length;
}

// ---------------------------------------------------------------------------
// Authoritative open-children read
// ---------------------------------------------------------------------------

/** Options for {@link fetchOpenMilestoneChildren}. */
export interface OpenChildrenOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** GitHub milestone number (the API id, not the title). */
  milestoneNumber: number;
  /** Milestone branch — open PRs based on it count as children. */
  milestoneBranch?: string;
  /** PR numbers to exclude (e.g. the summary PR being merged). */
  excludePrNumbers?: readonly number[];
  ghCommandFn: GhCommandFn;
}

interface RawIssue {
  number: number;
  title: string;
  pull_request?: unknown;
}

/**
 * Read the milestone's open children straight from GitHub — no cache.
 *
 * Milestone-tracking issues (`Merge milestone '…' to …`) are excluded: the
 * tracker lives inside the milestone it tracks, so counting it would make
 * every milestone permanently incomplete (the Issue #3214 deadlock).
 *
 * @returns The open children, or an error when the state could not be read.
 */
export async function fetchOpenMilestoneChildren(
  options: OpenChildrenOptions,
): Promise<Result<OpenMilestoneChild[]>> {
  const { repo, milestoneNumber, milestoneBranch, ghCommandFn } = options;

  if (!REPO_PATTERN.test(repo)) {
    return { ok: false, error: new Error(`Invalid repo: ${repo}`) };
  }
  if (!Number.isInteger(milestoneNumber) || milestoneNumber <= 0) {
    return {
      ok: false,
      error: new Error(`Invalid milestone number: ${milestoneNumber}`),
    };
  }
  if (milestoneBranch !== undefined && !BRANCH_PATTERN.test(milestoneBranch)) {
    return {
      ok: false,
      error: new Error(`Invalid milestone branch: ${milestoneBranch}`),
    };
  }

  const excluded = new Set(options.excludePrNumbers ?? []);
  const children = new Map<number, OpenMilestoneChild>();

  // 1. Open issues (and milestone-assigned PRs) attached to the milestone.
  try {
    const raw = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/issues?milestone=${milestoneNumber}&state=open&per_page=100`,
    ]);
    for (const item of parseIssueArray(raw)) {
      if (excluded.has(item.number)) continue;
      if (isMilestoneTrackingTitle(item.title)) continue;
      children.set(item.number, {
        number: item.number,
        title: item.title,
        kind: item.pull_request ? "pr" : "issue",
      });
    }
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to read open children of milestone #${milestoneNumber} in ` +
          `${repo}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  // 2. Open PRs targeting the milestone branch. These are the in-flight
  //    children a branch deletion auto-closes, and they are usually not
  //    assigned to the milestone — so query them separately.
  if (milestoneBranch !== undefined) {
    try {
      const raw = await ghCommandFn([
        "pr",
        "list",
        "--repo",
        repo,
        "--base",
        milestoneBranch,
        "--state",
        "open",
        "--json",
        "number,title",
        "--limit",
        "100",
      ]);
      for (const item of parseIssueArray(raw)) {
        if (excluded.has(item.number)) continue;
        children.set(item.number, {
          number: item.number,
          title: item.title,
          kind: "pr",
        });
      }
    } catch (err) {
      return {
        ok: false,
        error: new Error(
          `Failed to read open PRs targeting ${milestoneBranch} in ${repo}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }
  }

  return {
    ok: true,
    value: [...children.values()].sort((a, b) => a.number - b.number),
  };
}

/**
 * Parse a `gh` JSON array response into issue-shaped records.
 *
 * `gh api --paginate` concatenates pages as separate JSON arrays when the
 * response is not merged, so both a single array and a whitespace-separated
 * run of arrays are accepted. A malformed payload throws — an unreadable
 * response must never be reported as "no children".
 */
function parseIssueArray(raw: string): RawIssue[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const out: RawIssue[] = [];
  // Split concatenated top-level arrays: `][` boundaries between pages.
  for (const chunk of trimmed.split(/\]\s*\[/)) {
    const text = chunk.startsWith("[") ? chunk : `[${chunk}`;
    const json = text.endsWith("]") ? text : `${text}]`;
    const parsed = JSON.parse(json) as RawIssue[];
    for (const item of parsed) {
      if (typeof item?.number === "number") {
        out.push({
          number: item.number,
          title: typeof item.title === "string" ? item.title : "",
          pull_request: item.pull_request,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary-PR merge decision
// ---------------------------------------------------------------------------

/** The gate's decision for a candidate auto-merge. */
export type SummaryPrMergeDecision =
  | {
    decision: "allow";
    reason:
      | "not-milestone-pr"
      | "head-unknown"
      | "milestone-not-found"
      | "no-open-children";
  }
  | {
    decision: "block";
    reason: "open-children";
    milestoneNumber: number;
    milestoneTitle: string;
    milestoneBranch: string;
    children: OpenMilestoneChild[];
  }
  | {
    decision: "block";
    reason: "lookup-failed";
    milestoneNumber: number;
    milestoneTitle: string;
    milestoneBranch: string;
    message: string;
  };

/** Options for {@link decideSummaryPrMerge}. */
export interface SummaryPrMergeGateOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The PR the worker is about to auto-merge. */
  prNumber: number;
  /** Head branch, when the caller already knows it (saves a lookup). */
  headRefName?: string;
  ghCommandFn: GhCommandFn;
}

interface RawMilestone {
  number: number;
  title: string;
}

/**
 * Decide whether the worker may auto-merge this PR.
 *
 * Cheap by design: a PR whose head is not a `milestone/*` branch is allowed
 * after at most one lookup, so the gate costs nothing on ordinary fix PRs.
 *
 * Failure handling is deliberately asymmetric. While the PR is still
 * *unidentified* (head ref or milestone list unreadable) the gate allows the
 * merge — blocking every PR on a transient `gh` hiccup would be worse than the
 * risk it removes. Once the PR is known to be a milestone summary PR, any
 * failure to read the children blocks: the merge is irreversible, so an
 * unverifiable state is not a licence to proceed.
 */
export async function decideSummaryPrMerge(
  options: SummaryPrMergeGateOptions,
): Promise<SummaryPrMergeDecision> {
  const { repo, prNumber, ghCommandFn } = options;

  const headRefName = options.headRefName ??
    await resolveHeadRef(repo, prNumber, ghCommandFn);
  if (headRefName === null) {
    return { decision: "allow", reason: "head-unknown" };
  }
  if (!isMilestoneBranch(headRefName)) {
    return { decision: "allow", reason: "not-milestone-pr" };
  }

  const milestone = await findMilestoneForBranch(
    repo,
    headRefName,
    ghCommandFn,
  );
  if (milestone === null) {
    return { decision: "allow", reason: "milestone-not-found" };
  }

  const childrenResult = await fetchOpenMilestoneChildren({
    repo,
    milestoneNumber: milestone.number,
    milestoneBranch: headRefName,
    excludePrNumbers: [prNumber],
    ghCommandFn,
  });
  if (!childrenResult.ok) {
    return {
      decision: "block",
      reason: "lookup-failed",
      milestoneNumber: milestone.number,
      milestoneTitle: milestone.title,
      milestoneBranch: headRefName,
      message: childrenResult.error.message,
    };
  }
  if (childrenResult.value.length === 0) {
    return { decision: "allow", reason: "no-open-children" };
  }
  return {
    decision: "block",
    reason: "open-children",
    milestoneNumber: milestone.number,
    milestoneTitle: milestone.title,
    milestoneBranch: headRefName,
    children: childrenResult.value,
  };
}

/** Read a PR's head branch. Returns null when it cannot be determined. */
async function resolveHeadRef(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
): Promise<string | null> {
  if (!REPO_PATTERN.test(repo)) return null;
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "headRefName",
    ]);
    const parsed = JSON.parse(raw) as { headRefName?: unknown };
    return typeof parsed.headRefName === "string" && parsed.headRefName !== ""
      ? parsed.headRefName
      : null;
  } catch {
    return null;
  }
}

/**
 * Find the open milestone whose branch name is `branch`.
 *
 * The mapping is the same one that created the branch
 * ({@link createMilestoneBranchName}), so no extra metadata is needed.
 */
async function findMilestoneForBranch(
  repo: string,
  branch: string,
  ghCommandFn: GhCommandFn,
): Promise<RawMilestone | null> {
  try {
    const raw = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/milestones?state=open&per_page=100`,
    ]);
    const milestones = parseIssueArray(raw) as unknown as RawMilestone[];
    for (const milestone of milestones) {
      if (typeof milestone.title !== "string") continue;
      if (createMilestoneBranchName(milestone.title) === branch) {
        return { number: milestone.number, title: milestone.title };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Explanatory comment
// ---------------------------------------------------------------------------

/**
 * Render the comment posted on a summary PR whose merge was blocked.
 *
 * Exported so tests can assert against it directly.
 */
export function renderOpenChildrenBlockComment(
  milestoneTitle: string,
  children: readonly OpenMilestoneChild[],
): string {
  // Child titles are attacker-writable GitHub text quoted into a public
  // comment the worker signs, so they are scrubbed before interpolation
  // (Issue #1249, finding 8) — an unscrubbed `<!-- … -->` marker in a title
  // lands in this body and is read back as a genuine marker on a later scan.
  const list = children
    .map((child) =>
      `- #${child.number} (${child.kind}): ${scrubUntrustedText(child.title)}`
    )
    .join("\n");
  return [
    OPEN_CHILDREN_BLOCK_MARKER,
    `## Auto-merge blocked — milestone '${
      scrubUntrustedText(milestoneTitle)
    }' still has open children`,
    "",
    "Merging this PR deletes the milestone branch (`delete_branch_on_merge` " +
    "is on for this repository), and deleting a base branch auto-closes " +
    "every PR based on it. The following children are still open, so the " +
    "worker has not merged this PR (Issue #3909):",
    "",
    list,
    "",
    "This PR has been left open. Close or merge the children above and the " +
    "worker will merge it on a later scan — or merge it by hand if you have " +
    "decided the milestone is finished.",
  ].join("\n");
}

/** Options for {@link postOpenChildrenBlockComment}. */
export interface BlockCommentOptions {
  repo: string;
  prNumber: number;
  milestoneTitle: string;
  children: readonly OpenMilestoneChild[];
  ghCommandFn: GhCommandFn;
  log: (message: string) => void;
  /** Fleet identity inputs for the marker author check (Issue #1249). */
  authorOptions?: AlertDedupAuthorOptions;
}

/**
 * Whether the **fleet** has already left `marker` on this PR (Issue #1249,
 * finding 3).
 *
 * Both explanatory comments on this path are deduplicated by their marker, and
 * a PR thread is open to anybody, so a stranger quoting the marker suppressed
 * the public explanation of why a merge was refused or a base rewritten. The
 * gate itself still ran — what went missing was the reason, which is the part
 * a human reads. Only the comment author is authenticated, so the read carries
 * `.user.login` and every match is filtered through
 * {@link selectFleetAuthoredComments}.
 *
 * Fail direction is **towards posting**: an unreadable thread or an
 * unresolvable fleet identity means no match can be attributed, so the comment
 * goes out. A duplicate explanation is noise a reader scrolls past; a missing
 * one is a silent refusal.
 *
 * @returns true when a fleet-authored comment already carries the marker.
 */
async function hasFleetAuthoredMarker(
  repo: string,
  prNumber: number,
  marker: string,
  ghCommandFn: GhCommandFn,
  authorOptions: AlertDedupAuthorOptions,
  log: (message: string) => void,
): Promise<boolean> {
  const raw = await ghCommandFn([
    "api",
    "--paginate",
    `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    "--jq",
    "[.[] | {author: .user.login, body: .body}]",
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // An unparseable payload cannot establish that the marker is present.
    return false;
  }
  if (!Array.isArray(parsed)) return false;

  const rows = parsed
    .filter((row): row is Record<string, unknown> =>
      row !== null && typeof row === "object"
    )
    .map((row) => ({
      author: typeof row.author === "string" ? row.author : null,
      body: typeof row.body === "string" ? row.body : "",
    }))
    .filter((row) => row.body.includes(marker));

  const fleetRows = await selectFleetAuthoredComments(
    rows,
    `milestone gate marker ${marker} on ${repo}#${prNumber}`,
    authorOptions,
    log,
    "the explanatory comment is posted — a marker anyone can quote must not " +
      "suppress the reason a merge was refused",
  );
  return fleetRows.length > 0;
}

/**
 * Post the explanatory comment on the blocked summary PR — exactly once.
 *
 * Idempotency comes from {@link OPEN_CHILDREN_BLOCK_MARKER}: the existing
 * comments are read first and nothing is posted when the marker is already
 * there, so a repeating scan cycle does not spam the thread. When the existing
 * comments cannot be read, nothing is posted (a duplicate comment every cycle
 * would be worse than none) and the failure is logged.
 *
 * @returns true when a new comment was posted.
 */
export async function postOpenChildrenBlockComment(
  options: BlockCommentOptions,
): Promise<boolean> {
  const { repo, prNumber, ghCommandFn, log } = options;

  let alreadyPosted: boolean;
  try {
    alreadyPosted = await hasFleetAuthoredMarker(
      repo,
      prNumber,
      OPEN_CHILDREN_BLOCK_MARKER,
      ghCommandFn,
      options.authorOptions ?? {},
      log,
    );
  } catch (err) {
    log(
      `WARNING: could not read comments on ${repo}#${prNumber} to de-duplicate ` +
        `the milestone open-children block comment: ` +
        `${err instanceof Error ? err.message : String(err)} (Issue #3909)`,
    );
    return false;
  }

  if (alreadyPosted) {
    return false;
  }

  const body = renderOpenChildrenBlockComment(
    options.milestoneTitle,
    options.children,
  );
  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
    return true;
  } catch (err) {
    log(
      `WARNING: failed to post the milestone open-children block comment on ` +
        `${repo}#${prNumber}: ` +
        `${err instanceof Error ? err.message : String(err)} (Issue #3909)`,
    );
    return false;
  }
}

/** Render the warning log line for a blocked merge (scope item 3). */
export function renderBlockWarning(
  repo: string,
  prNumber: number,
  milestoneNumber: number,
  milestoneTitle: string,
  children: readonly OpenMilestoneChild[],
): string {
  const numbers = children.map((c) => `#${c.number}`).join(", ");
  return `WARNING: refusing to auto-merge milestone summary PR ${repo}#${prNumber} ` +
    `for milestone #${milestoneNumber} '${milestoneTitle}' — ` +
    `${children.length} open child/children remain: ${numbers} (Issue #3909)`;
}

// ---------------------------------------------------------------------------
// Milestone BASE gate (Issue #4396): the mirror image of the summary-PR gate
// ---------------------------------------------------------------------------

/**
 * Decision for merging a PR whose BASE is a milestone branch.
 *
 * Observed live: seven fixes (#3366, #3369, #3371, …) merged into
 * `milestone/clean-up` eleven days after that milestone's rollup PR #3125
 * had merged into Develop. The branch's only route to the default branch had
 * closed; the work evaporated with the branch, and every issue auto-closed
 * as COMPLETED because a PR really had merged. Merging into a milestone
 * branch whose rollup has merged, or whose milestone is closed, is refused
 * here — loud, naming the rollup PR — so the caller can retarget the PR at
 * the default branch instead.
 *
 * Failure policy mirrors {@link decideSummaryPrMerge}: a base that is not
 * a milestone branch is allowed without a lookup; a milestone base that
 * cannot be verified (rollup or milestone lookup failed) BLOCKS — the cost
 * of a false block is a retry next scan, the cost of a false allow is lost
 * work.
 */
export type MilestoneBaseMergeDecision =
  | {
    decision: "allow";
    reason: "not-milestone-base" | "base-unknown" | "route-open";
  }
  | {
    /**
     * The route could not be *read* (Issue #477). Not evidence of
     * anything: leave the PR exactly as it is and look again next scan.
     *
     * This used to be a `block`, which retargets the PR at the default
     * branch. A GitHub rate limit — certain to happen across an
     * unattended weekend — therefore refused every milestone child, and
     * any whose retarget succeeded was moved onto the review-gated
     * default branch to wait for a human who was not there. "I could not
     * read it" must never be actioned as "the route has closed".
     */
    decision: "defer";
    reason: "lookup-failed";
    milestoneBranch: string;
    detail: string;
  }
  | {
    decision: "block";
    reason: "rollup-merged" | "milestone-closed";
    milestoneBranch: string;
    rollupPrNumber?: number;
    milestoneNumber?: number;
    milestoneTitle?: string;
    detail: string;
  };

/** Options for {@link decideMilestoneBaseMerge}. */
export interface MilestoneBaseMergeGateOptions {
  repo: string;
  prNumber: number;
  /** The PR's base, when the caller already has it (saves a `pr view`). */
  baseRefName?: string;
  ghCommandFn: GhCommandFn;
}

interface RawRollupPr {
  number?: unknown;
  state?: unknown;
  baseRefName?: unknown;
  mergedAt?: unknown;
}

async function resolveBaseRef(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
): Promise<string | null> {
  if (!REPO_PATTERN.test(repo)) return null;
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "baseRefName",
    ]);
    const parsed = JSON.parse(raw) as { baseRefName?: unknown };
    return typeof parsed.baseRefName === "string" && parsed.baseRefName !== ""
      ? parsed.baseRefName
      : null;
  } catch {
    return null;
  }
}

/** Refuse a merge into a milestone branch whose route to the default branch has closed. */
export async function decideMilestoneBaseMerge(
  options: MilestoneBaseMergeGateOptions,
): Promise<MilestoneBaseMergeDecision> {
  const { repo, prNumber, ghCommandFn } = options;
  const base = options.baseRefName ??
    await resolveBaseRef(repo, prNumber, ghCommandFn);
  if (base === null) return { decision: "allow", reason: "base-unknown" };
  if (!isMilestoneBranch(base)) {
    return { decision: "allow", reason: "not-milestone-base" };
  }
  if (!REPO_PATTERN.test(repo) || !BRANCH_PATTERN.test(base)) {
    return {
      decision: "defer",
      reason: "lookup-failed",
      milestoneBranch: base,
      detail: "repo or branch name failed the argument allowlist",
    };
  }

  // 1. Has a rollup PR (head = the milestone branch) already merged?
  let rollups: RawRollupPr[];
  try {
    const raw = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      base,
      "--state",
      "all",
      "--json",
      "number,state,baseRefName,mergedAt",
      "--limit",
      "50",
    ]);
    const parsed = JSON.parse(raw);
    rollups = Array.isArray(parsed) ? parsed as RawRollupPr[] : [];
  } catch (err) {
    return {
      decision: "defer",
      reason: "lookup-failed",
      milestoneBranch: base,
      detail: `could not list rollup PRs for ${base}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const merged = rollups.find((pr) =>
    typeof pr.state === "string" && pr.state.toUpperCase() === "MERGED"
  );
  if (merged && typeof merged.number === "number") {
    return {
      decision: "block",
      reason: "rollup-merged",
      milestoneBranch: base,
      rollupPrNumber: merged.number,
      detail: `rollup PR #${merged.number} (${base} → ${
        typeof merged.baseRefName === "string" ? merged.baseRefName : "?"
      }) merged${
        typeof merged.mergedAt === "string" ? ` at ${merged.mergedAt}` : ""
      }`,
    };
  }

  // 2. Is the milestone itself closed? (A closed milestone has no route
  //    either, whether or not its rollup PR is on record.)
  try {
    const raw = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/milestones?state=all&per_page=100`,
    ]);
    // parseIssueArray keeps number/title only; the milestone STATE is the
    // point here, so split the paginated arrays the same way and keep it.
    const milestones: Array<
      { number?: unknown; title?: unknown; state?: unknown }
    > = [];
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      for (const chunk of trimmed.split(/\]\s*\[/)) {
        const text = chunk.startsWith("[") ? chunk : `[${chunk}`;
        const json = text.endsWith("]") ? text : `${text}]`;
        for (const item of JSON.parse(json) as unknown[]) {
          if (item && typeof item === "object") {
            milestones.push(
              item as { number?: unknown; title?: unknown; state?: unknown },
            );
          }
        }
      }
    }
    for (const milestone of milestones) {
      if (typeof milestone.title !== "string") continue;
      if (createMilestoneBranchName(milestone.title) !== base) continue;
      if (milestone.state === "closed") {
        return {
          decision: "block",
          reason: "milestone-closed",
          milestoneBranch: base,
          ...(typeof milestone.number === "number"
            ? { milestoneNumber: milestone.number }
            : {}),
          milestoneTitle: milestone.title,
          detail: `milestone ${
            typeof milestone.number === "number" ? `#${milestone.number} ` : ""
          }"${milestone.title}" is closed`,
        };
      }
      return { decision: "allow", reason: "route-open" };
    }
  } catch (err) {
    return {
      decision: "defer",
      reason: "lookup-failed",
      milestoneBranch: base,
      detail: `could not read milestones: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  // No milestone matches the branch and no rollup merged: an orphan branch
  // by another route, but the merge itself is not what loses the work.
  return { decision: "allow", reason: "route-open" };
}

// ---------------------------------------------------------------------------
// Retarget an orphan-bound PR at the default branch (Issue #4396)
// ---------------------------------------------------------------------------

/** Marker so the retarget comment is posted once per PR. */
export const ROLLUP_MERGED_RETARGET_MARKER =
  "<!-- milestone-rollup-merged-retarget -->";

/** Options for {@link retargetOrphanBoundPr}. */
export interface RetargetOrphanBoundPrOptions {
  repo: string;
  prNumber: number;
  gate: Extract<MilestoneBaseMergeDecision, { decision: "block" }>;
  defaultBranch: string;
  ghCommandFn: GhCommandFn;
  log: (message: string) => void;
  /** Fleet identity inputs for the marker author check (Issue #1249). */
  authorOptions?: AlertDedupAuthorOptions;
}

/** The comment left on the PR when its base is retargeted. */
export function renderRetargetComment(
  gate: Extract<MilestoneBaseMergeDecision, { decision: "block" }>,
  defaultBranch: string,
): string {
  const why = gate.reason === "rollup-merged"
    ? `its rollup PR #${gate.rollupPrNumber} has already merged`
    : gate.reason === "milestone-closed"
    ? `its milestone${
      gate.milestoneNumber ? ` #${gate.milestoneNumber}` : ""
    } is closed`
    : `its state could not be verified (${gate.detail})`;
  return [
    ROLLUP_MERGED_RETARGET_MARKER,
    `⚠️ **Not merged into \`${gate.milestoneBranch}\`** — ${why}, so that branch has no route to \`${defaultBranch}\` any more. ` +
    "Merging there would orphan this work while the issue closed as completed (Issue #4396 — exactly how #3366/#3369/#3371 were lost).",
    "",
    `The PR base has been retargeted to \`${defaultBranch}\`; the normal merge path applies from here.`,
  ].join("\n");
}

/**
 * Refuse the milestone-branch merge loudly and move the PR onto the
 * default branch. Comment once (marker-deduplicated), retarget, log.
 * Returns whether the retarget succeeded. Only a gate carrying positive
 * evidence — a merged rollup, or a closed milestone — reaches here. An
 * unreadable route defers instead and never retargets (Issue #477).
 */
export async function retargetOrphanBoundPr(
  options: RetargetOrphanBoundPrOptions,
): Promise<boolean> {
  const { repo, prNumber, gate, defaultBranch, ghCommandFn, log } = options;
  log(
    `WARNING: refusing to merge ${repo}#${prNumber} into ${gate.milestoneBranch}: ${gate.detail} ` +
      `(Issue #4396) — retargeting at ${defaultBranch}`,
  );
  let alreadyExplained = false;
  try {
    alreadyExplained = await hasFleetAuthoredMarker(
      repo,
      prNumber,
      ROLLUP_MERGED_RETARGET_MARKER,
      ghCommandFn,
      options.authorOptions ?? {},
      log,
    );
  } catch {
    alreadyExplained = false;
  }
  if (!alreadyExplained) {
    try {
      await ghCommandFn([
        "pr",
        "comment",
        String(prNumber),
        "--repo",
        repo,
        "--body",
        renderRetargetComment(gate, defaultBranch),
      ]);
    } catch (err) {
      log(
        `WARNING: could not post the retarget comment on ${repo}#${prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  try {
    await ghCommandFn([
      "pr",
      "edit",
      String(prNumber),
      "--repo",
      repo,
      "--base",
      defaultBranch,
    ]);
    return true;
  } catch (err) {
    log(
      `WARNING: could not retarget ${repo}#${prNumber} at ${defaultBranch}: ${
        err instanceof Error ? err.message : String(err)
      } (Issue #4396)`,
    );
    return false;
  }
}
