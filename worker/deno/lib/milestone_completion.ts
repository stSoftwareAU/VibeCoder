/**
 * Milestone completion detection and tracking issue/PR creation.
 *
 * When all issues in a milestone are completed (closed), this module:
 * 1. Creates a tracking issue titled "Merge milestone '<name>' to <default>"
 * 2. Creates a summary PR from the milestone branch to the default branch
 *
 * Replaces the deleted worker/shared/milestone_completion.sh (Issue #970).
 * Issue #1106: Regression — this Deno replacement was never created.
 *
 * Issue #2835: after the normal per-milestone scan, a cross-milestone
 * dependency deadlock (`milestone_deadlock.ts`) is detected and broken with a
 * partial rollup (`milestone_deadlock_rollup.ts`), so work already merged
 * into a deadlocked milestone still reaches the default branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import {
  evaluateWorkerIdentity,
  IdentityGuardError,
  readHostname,
} from "./identity_guard.ts";
import type { IssueCache } from "./issue_cache.ts";
import { scrubUntrustedText } from "./prompt_delimiter.ts";
import { isIdleTaskMilestone } from "./idle_task_merge_gate.ts";
import {
  fetchAuthoritativeOpenChildren,
  formatChildNumbers,
} from "./milestone_open_children.ts";
import {
  type AlertDedupAuthorOptions,
  resolveAlertDedupAuthors,
} from "./alert_dedup_authors.ts";
import {
  autoMergeOutcomeNeedsComment,
  AutoMergeResult,
  buildArmingReasonComment,
  finalisePr,
} from "./pr_auto_merge.ts";
import { retireMilestoneSyncPrs } from "./milestone_sync_pr_retirement.ts";
import { isFleetRollbackCloseComment } from "./milestone_rollback_marker.ts";
import { raiseDeadlockPartialRollups } from "./milestone_deadlock_rollup.ts";
import {
  isMilestoneTrackingTitle,
  MILESTONE_TRACKING_MARKER,
  type MilestoneTrackerVerification,
  partitionMilestoneTrackers,
} from "./milestone_tracker_identity.ts";
import {
  fetchAllStateIssuesByMilestone,
  fetchAllStatePRsByBranch,
  fetchClosedIssuesByMilestoneNumber,
  fetchOpenIssuesByMilestone,
  fetchPRsForIssueByTitle,
  fetchTimelineWithCache,
  invalidateAllStateIssuesByMilestone,
  invalidateAllStatePRsByBranch,
  latestReopenedAtFromTimeline,
} from "./issue_query.ts";
// Issue #3014: the summary PR body states which declared sub-issue
// dependencies have not merged yet, so the merge gate's hold is explained.
import {
  findPendingMilestoneDependencies,
  renderPendingDependenciesSection,
} from "./milestone_dependency_hold.ts";
// Issue #3223: the summary PR body also lists any added Markdown line that
// names a sibling issue closed as not planned, so a forward reference to
// dropped work is surfaced to the reviewer.
import {
  findNotPlannedDocReferences,
  NOT_PLANNED_DOCS_UNVERIFIED_NOTE,
  renderNotPlannedDocSection,
} from "./milestone_not_planned_refs.ts";
import { fetchOpenMilestonePages } from "./open_milestone_pages.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function signature for running gh CLI commands. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/**
 * Function signature for resolving a repository's default branch.
 *
 * Issue #1509: Routed through `getRepoDefaultBranch` so the persistent
 * 7-day cache is shared with the rest of the worker.
 */
export type DefaultBranchFn = (repo: string) => Promise<Result<string>>;

/** Dependencies for the milestone completion orchestration. */
export interface MilestoneCompletionDeps {
  /** Repositories to scan (owner/repo format). */
  repos: string[];
  /** Function to execute gh CLI commands. */
  ghCommandFn: GhCommandFn;
  /**
   * Function that resolves the default branch for a repository.
   *
   * Optional. If omitted, falls back to calling `ghCommandFn` directly
   * (uncached). Production callers should inject `getRepoDefaultBranch`
   * so the persistent default-branch cache is used (Issue #1509).
   */
  defaultBranchFn?: DefaultBranchFn;
  /**
   * Optional IssueCache for read-through (Issue #1786). When provided,
   * milestone open/closed issue lookups share the per-iteration cache.
   */
  cache?: IssueCache;
  /**
   * Allowlist of service-account logins (Issue #3528). When non-empty, the
   * live `gh` login is re-resolved and validated against this list *before*
   * any milestone write (tracking-issue create, summary-PR raise, tracking
   * close). On a mismatch the whole operation fails loud — refusing to write
   * as a drifted human account. Empty/omitted leaves the re-check off.
   */
  serviceAccounts?: string[];
  /**
   * Re-resolve the live authenticated `gh` login for the write-phase identity
   * re-check (Issue #3528). Defaults to `getGithubUser`. Injected in tests.
   */
  resolveActualLogin?: () => Promise<string | null>;
  /** Resolve the hostname for identity-guard messages. Injected in tests. */
  hostname?: () => string;
  /**
   * Fleet-identity inputs for the tracking-issue author check (Issue #1246).
   * Omitted means "read the configured fleet identity", which is what the
   * production wiring does; a test states the fleet instead.
   */
  authorOptions?: AlertDedupAuthorOptions;
  /**
   * Whether a repository has `skip_auto_merge` set (Issue #2458). A summary
   * PR raised in such a repository is created but never armed, exactly as the
   * Auto-Merge sweep already treats it. Omitted means "arm", which is what a
   * repository with no such setting gets.
   */
  skipAutoMerge?: (repo: string) => boolean;
  /**
   * Push-capable fleet logins (Issue #2458). The summary PR's base is always
   * the default branch, so on a base with no required checks its arming takes
   * the gated direct merge — which needs these logins to tell a genuine
   * outside approval from a sibling fleet account's (Issue #1082). The
   * Auto-Merge sweep passes the same set.
   */
  fleetAuthors?: readonly string[];
  /** Logging function. */
  log: (message: string) => void;
}

/** Result of the milestone completion orchestration. */
export interface MilestoneCompletionResult {
  /** Number of summary PRs created. */
  summaryPrsCreated: number;
}

/** A closed issue in a milestone. */
interface ClosedIssue {
  number: number;
  title: string;
  /**
   * Last-update timestamp from the closed-issue batch, when it carries one.
   * Keys the claim-classification cache: a reopen or re-close bumps it, so a
   * cached verdict is never applied to an issue that has changed since.
   */
  updatedAt?: string;
  /**
   * Why this closed issue must be flagged rather than claimed in the
   * rollup body (Issue #3476). Absent = claimed normally.
   */
  claimProblem?: ClaimProblem;
}

/** Why a closed issue is flagged rather than claimed (Issue #3476). */
type ClaimProblem = "sync-pr-only" | "predates-reopen" | "timeline-unreadable";

/**
 * Build a {@link DefaultBranchFn} that resolves via the injected
 * `ghCommandFn`. Used as a fallback for tests that stub only
 * `ghCommandFn` — production wiring passes `getRepoDefaultBranch`
 * directly so the persistent cache is used (Issue #1509).
 */
function makeGhDefaultBranchFn(ghFn: GhCommandFn): DefaultBranchFn {
  return async (repo: string): Promise<Result<string>> => {
    try {
      const out = await ghFn([
        "api",
        `repos/${repo}`,
        "--jq",
        ".default_branch",
      ]);
      const branch = out.trim();
      if (!branch) {
        return { ok: false, error: new Error(`empty response for ${repo}`) };
      }
      return { ok: true, value: branch };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: new Error(message) };
    }
  };
}

/** A GitHub milestone from the API. */
interface GitHubMilestone {
  title: string;
  number: number;
  /**
   * Count of open issues attached to the milestone (Issue #2125). Used
   * by the idle-task retirement gate to decide whether the milestone
   * is safe to auto-close — only fire when no in-flight work remains.
   */
  open_issues?: number;
  /** ISO creation time from the milestone listing (PR #3592 review grace window). */
  created_at?: string;
}

/** How long an empty milestone is left alone after creation (planning assigns its items). */
const EMPTY_MILESTONE_GRACE_MS = 15 * 60_000;

/** True when `createdAt` is missing, unparsable, in the future, or inside the grace window. */
export function isMilestoneYoung(
  createdAt: string | undefined,
  nowMs: number,
): boolean {
  if (typeof createdAt !== "string") return true;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return true;
  return nowMs - created < EMPTY_MILESTONE_GRACE_MS;
}

/**
 * Discriminated result of attempting to create a milestone summary PR.
 *
 * Issue #1133: Distinguishes "created", "exists" (idempotent), and "failed"
 * so the caller can decide whether to close the tracking issue.
 */
export type SummaryPrOutcome =
  | { outcome: "created"; prNumber: number | null; autoMerge: SummaryPrArming }
  | { outcome: "exists"; prNumber: number }
  | { outcome: "failed"; reason: string };

/**
 * What the arming attempt on a freshly created summary PR did (Issue #2458).
 *
 * - `armed` — `gh pr merge --auto` was accepted (or the gated direct merge
 *   landed the PR), so GitHub holds the merge until the checks pass.
 * - `withheld` — a deliberate hold that already explains itself on the PR:
 *   the #3909 open-children refusal, a draft, a repo with auto-merge off, or
 *   `skip_auto_merge`. No second comment is posted.
 * - `failed` — arming was refused and nothing else had explained it, so one
 *   reason comment naming the sweep retry was posted.
 */
export type SummaryPrArming = "armed" | "withheld" | "failed";

/**
 * What the summary-PR arming path needs from the caller (Issue #2458).
 *
 * Grouped rather than passed as three more positional arguments: the arming
 * inputs travel together down every hop, and an options object cannot be
 * transposed at a call site the way an optional boolean beside an optional
 * object can.
 */
interface SummaryPrArmingInputs {
  /** Repository opts out of auto-merge (`skip_auto_merge`). */
  skipAutoMerge: boolean;
  /**
   * Fleet logins, so the gated direct merge on an unprotected default branch
   * can tell a genuine outside review from a sibling fleet account's approval
   * (Issue #1082). Absent, that merge refuses outright (Issue #2416).
   */
  fleetAuthors?: readonly string[];
  /** Fleet-identity inputs for the #3909 gate's marker author checks. */
  authorOptions?: AlertDedupAuthorOptions;
}

// ---------------------------------------------------------------------------
// checkMilestoneComplete
// ---------------------------------------------------------------------------

/**
 * Check if all issues in a milestone are closed.
 *
 * Issue #3214: the milestone's own tracking issue
 * (`Merge milestone '<title>' to <branch>`) lives *inside* the milestone it
 * tracks, so a tracker left open by a failed summary-PR step would otherwise
 * be counted as an open issue here — the milestone would read "not complete"
 * forever and freeze (the deadlock). Tracking-shaped issues are excluded from
 * the completeness count so an open tracker never blocks its own milestone.
 * This exclusion is applied at the completion-check call path only; the
 * `milestone_health.ts` / `milestone_progress.ts` consumers of
 * `fetchOpenIssuesByMilestone` are unchanged.
 *
 * Issue #3908: this cached-list check is no longer the sole authority. It is
 * kept as the *second opinion*; `processRepoMilestones` also reads GitHub's
 * own `open_issues` counter fresh and treats a non-zero authoritative count as
 * a hard veto.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneTitle - The milestone title
 * @param ghCommandFn - Function to execute gh CLI commands
 * @returns Result with true if all non-tracking issues are closed, false otherwise
 */
export async function checkMilestoneComplete(
  repo: string,
  milestoneTitle: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
  verification: MilestoneTrackerVerification = {},
): Promise<Result<boolean>> {
  // Issue #1786: route through `fetchOpenIssuesByMilestone` so the
  // shared `issues_all` cache is reused. The local milestone-title
  // filter avoids issuing a milestone-specific `gh issue list` call.
  try {
    const openIssues = await fetchOpenIssuesByMilestone(
      repo,
      milestoneTitle,
      cache,
      ghCommandFn,
    );
    // Issue #3214: ignore the milestone's own tracking issue(s).
    // Issue #1246: "the milestone's own" is proved from the tracking-issue
    // body marker and a fleet author, not from the title — anybody may retitle
    // an issue they opened, and this count is one of the two inputs that
    // finalise the milestone and delete its branch.
    const { others: openRealIssues } = await partitionMilestoneTrackers(
      openIssues,
      `completeness check for milestone '${milestoneTitle}' in ${repo}`,
      verification,
    );
    return { ok: true, value: openRealIssues.length === 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to check milestone '${milestoneTitle}' in ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// classifyMilestoneFinalPrs (Issue #3474)
// ---------------------------------------------------------------------------

/** Aggregate state of the PRs whose head is a milestone branch. */
export type MilestoneFinalPrState =
  | { kind: "merged"; prNumber: number }
  | { kind: "open"; prNumber: number }
  | { kind: "abandoned"; prNumber: number }
  /**
   * Every PR is closed and the newest was closed by the fleet's own
   * milestone roll-back (Issue #1781): the work is being redone, so a fresh
   * final PR is due and the closed ones must not count as existing.
   */
  | { kind: "superseded"; closedPrNumbers: number[] }
  | { kind: "none" };

/**
 * Classify the final PR(s) of a milestone branch across all states so
 * close-out can tell merged and closed-unmerged apart (Issue #3474). Uncached
 * on purpose: the state must be fresh. A missing or unrecognised state is
 * never classed merged or abandoned (fail safe, returns "none").
 *
 * Only same-repository PRs count: `gh pr list --head` matches the ref name
 * alone, so a fork reusing the (public) milestone branch name would otherwise
 * decide the outcome, and a fork-headed PR proves nothing (Issue #1124). An
 * entry whose `isCrossRepository` is not exactly `false` is dropped.
 *
 * A closed-unmerged newest PR carrying a roll-back close comment authored by
 * a fleet login is "superseded", not "abandoned" (PR #3592 review). A comment
 * from anyone else is ignored — any account can comment on a public PR — and
 * when the fleet set cannot be resolved the result is an error rather than
 * either verdict: neither the close-out nor a fresh final PR may rest on a
 * comment nobody can attribute.
 *
 * @param resolveFleetAuthors - Resolves the fleet logins; called only when
 *   every PR is closed, the one case that reads comments.
 */
export async function classifyMilestoneFinalPrs(
  repo: string,
  milestoneBranch: string,
  ghCommandFn: GhCommandFn,
  resolveFleetAuthors: () => Promise<readonly string[]>,
): Promise<Result<MilestoneFinalPrState>> {
  try {
    const output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--head",
      milestoneBranch,
      "--json",
      "number,state,headRefName,isCrossRepository",
      "--limit",
      "100",
    ]);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) {
      throw new Error("expected a JSON array");
    }
    const entries = (parsed as Array<
      {
        number?: unknown;
        state?: unknown;
        headRefName?: unknown;
        isCrossRepository?: unknown;
      }
    >).filter((pr) =>
      pr !== null && typeof pr === "object" &&
      pr.headRefName === milestoneBranch && typeof pr.number === "number" &&
      pr.isCrossRepository === false
    ) as Array<{ number: number; state?: unknown }>;

    if (entries.length === 0) return { ok: true, value: { kind: "none" } };
    const known = new Set(["MERGED", "OPEN", "CLOSED"]);
    if (
      entries.some((pr) => typeof pr.state !== "string" || !known.has(pr.state))
    ) {
      return { ok: true, value: { kind: "none" } };
    }
    const highest = (state: string): number | null => {
      const nums = entries.filter((pr) => pr.state === state).map((pr) =>
        pr.number
      );
      return nums.length > 0 ? Math.max(...nums) : null;
    };
    const merged = highest("MERGED");
    if (merged !== null) {
      return { ok: true, value: { kind: "merged", prNumber: merged } };
    }
    const open = highest("OPEN");
    if (open !== null) {
      return { ok: true, value: { kind: "open", prNumber: open } };
    }
    const closed = highest("CLOSED");
    if (closed === null) return { ok: true, value: { kind: "none" } };
    const fleetAuthors = await resolveFleetAuthors();
    if (fleetAuthors.length === 0) {
      throw new Error(
        `fleet author set unresolved — cannot tell whether closed final PR ` +
          `#${closed} was closed by a milestone roll-back, so it is ` +
          `classed neither abandoned nor superseded`,
      );
    }
    if (await closedByRollback(repo, closed, ghCommandFn, fleetAuthors)) {
      return {
        ok: true,
        value: {
          kind: "superseded",
          closedPrNumbers: entries.map((pr) => pr.number),
        },
      };
    }
    return { ok: true, value: { kind: "abandoned", prNumber: closed } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to classify final PRs for milestone branch ${milestoneBranch} in repo ${repo}: ${message}`,
      ),
    };
  }
}

/**
 * Whether a closed PR carries a roll-back's close comment (Issue #1781)
 * authored by a fleet login.
 */
async function closedByRollback(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
  fleetAuthors: readonly string[],
): Promise<boolean> {
  const output = await ghCommandFn([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "comments",
  ]);
  const parsed = JSON.parse(output) as { comments?: unknown };
  const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
  return comments.some((c: unknown) =>
    isFleetRollbackCloseComment(c, fleetAuthors)
  );
}

// ---------------------------------------------------------------------------
// hasExistingMilestoneSummaryPr
// ---------------------------------------------------------------------------

/**
 * Check if a summary PR already exists for a milestone (idempotent check).
 *
 * Checks all states (open, merged, closed) to avoid re-creating PRs
 * that have already been merged or handled (Issue #568).
 *
 * Issue #3474: merged and closed-unmerged final PRs are now classified
 * earlier by `classifyMilestoneFinalPrs`; this check stays as the idempotency
 * guard for the create path.
 *
 * Issue #1133: Returns the existing PR number when found, so it can be
 * logged when closing the tracking issue.
 *
 * Issue #1798: Routes through `fetchAllStatePRsByBranch` so the
 * `prs_all_branch_v2_${milestoneBranch}` cache is shared across milestone
 * scans within a single iteration. The defence-in-depth `headRefName`
 * filter (Issue #859) is preserved.
 *
 * Issue #3595: a fork-headed PR reusing the milestone branch name does not
 * count as an existing final PR; `fetchAllStatePRsByBranch` returns
 * same-repository PRs only.
 *
 * @param repo - Repository in "owner/repo" format
 * @param _milestoneTitle - The milestone title (unused, kept for API clarity)
 * @param milestoneBranch - The milestone branch name
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param cache - Optional iteration-scoped IssueCache
 * @param ignorePrNumbers - Closed final PRs a roll-back superseded (Issue
 *   #3474): they must not count as existing, or the fresh final PR is never
 *   raised
 * @returns Result with the existing PR number, or null if not found
 */
export async function hasExistingMilestoneSummaryPr(
  repo: string,
  _milestoneTitle: string,
  milestoneBranch: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
  ignorePrNumbers: readonly number[] = [],
): Promise<Result<number | null>> {
  try {
    const prs = await fetchAllStatePRsByBranch(
      repo,
      milestoneBranch,
      cache,
      ghCommandFn,
    );

    // Defence in depth: filter by headRefName in case the API returns
    // broader results than expected (Issue #859)
    const matching = prs.filter((pr) =>
      pr.headRefName === milestoneBranch && !ignorePrNumbers.includes(pr.number)
    );
    const first = matching[0];
    return { ok: true, value: first !== undefined ? first.number : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to check existing PRs for milestone in ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// hasExistingMilestoneTrackingIssue
// ---------------------------------------------------------------------------

/**
 * Re-exported from `milestone_tracker_identity.ts` (Issue #3908, #1246), which
 * owns tracker identity now that every lookup needs it. The title shape is a
 * pre-filter only — see {@link partitionMilestoneTrackers} for the decision.
 * Import path preserved for existing callers.
 */
export { isMilestoneTrackingTitle };

/**
 * Check if a tracking issue already exists for a milestone.
 *
 * Checks all states (open, closed) to prevent duplicates (Issue #568).
 *
 * Issue #1798: Routes through `fetchAllStateIssuesByMilestone` so the
 * `issues_all_milestone_v2_${milestoneNumber}` cache is shared with sibling
 * milestone helpers within a single iteration. The tracking issue is
 * created with `--milestone <number>` (see `createMilestoneTrackingIssue`)
 * so it is always assigned to its milestone, allowing the milestone-keyed
 * lookup to find it.
 *
 * Issue #2753: The local filter now matches the tracking-issue *shape*
 * (`isMilestoneTrackingTitle`) rather than an exact full title. The previous
 * exact match — `Merge milestone '<title>' to <defaultBranch>` — drifted and
 * filed a duplicate whenever the default branch resolved differently between
 * runs (the field showed "to Develop" titles) or the milestone was renamed.
 * When several trackers exist, the canonical (lowest-numbered) one is reused.
 *
 * @param repo - Repository in "owner/repo" format
 * @param _milestoneTitle - The milestone title (unused; kept for API clarity)
 * @param milestoneNumber - The GitHub milestone number (API ID)
 * @param _defaultBranch - The default branch name (unused; kept for API clarity)
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param cache - Optional iteration-scoped IssueCache
 * @returns Result with the canonical existing issue number, or null if none
 */
export async function hasExistingMilestoneTrackingIssue(
  repo: string,
  _milestoneTitle: string,
  milestoneNumber: number,
  _defaultBranch: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
  verification: MilestoneTrackerVerification = {},
): Promise<Result<number | null>> {
  try {
    const issues = await fetchAllStateIssuesByMilestone(
      repo,
      milestoneNumber,
      cache,
      ghCommandFn,
    );
    // Issue #1246: the number this returns is written into the summary PR as
    // `Closes #N` and is later passed to `gh issue close`, so adopting a
    // look-alike would act on somebody else's issue. Only a tracker carrying
    // the marker and opened by a fleet account is adopted; anything else means
    // "no existing tracker", and the worker files its own.
    const { trackers } = await partitionMilestoneTrackers(
      issues,
      `existing tracker lookup for milestone #${milestoneNumber} in ${repo}`,
      {
        ...verification,
        unverifiedOutcome:
          "no existing tracker is adopted and the worker files its own",
      },
    );
    const matching = trackers
      .map((issue) => issue.number)
      .sort((a, b) => a - b);
    return { ok: true, value: matching.length > 0 ? matching[0]! : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to check tracking issues in ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// selectDuplicateTrackersToClose (Issue #2753)
// ---------------------------------------------------------------------------

/** Selection of duplicate milestone trackers to close versus keep. */
export interface DuplicateTrackerSelection {
  /** Canonical tracker to keep (lowest issue number); null when none given. */
  keep: number | null;
  /** Duplicate tracker numbers to close (the N−1 non-canonical), ascending. */
  close: number[];
}

/**
 * Given the open trackers for a single milestone, choose the canonical one
 * to keep (lowest issue number) and the N−1 duplicates to close (Issue #2753).
 *
 * Pure selection logic — performs no GitHub calls — so the one-time cleanup
 * (`private-repo-12#375`) can fetch the trackers, call this to decide, and close
 * the duplicates itself. Duplicate input numbers are de-duplicated. A no-op
 * (empty `close`) when zero or one tracker is supplied.
 *
 * @param trackerNumbers - Issue numbers of the milestone's open trackers
 * @returns The canonical tracker to keep and the duplicates to close
 */
export function selectDuplicateTrackersToClose(
  trackerNumbers: readonly number[],
): DuplicateTrackerSelection {
  const sorted = [...new Set(trackerNumbers)].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { keep: null, close: [] };
  }
  const [keep, ...close] = sorted;
  return { keep: keep!, close };
}

// ---------------------------------------------------------------------------
// getOpenMilestoneTrackers (Issue #3214)
// ---------------------------------------------------------------------------

/**
 * Return the issue numbers of the *open* tracking-shaped issues attached to a
 * milestone, ascending (Issue #3214).
 *
 * Reads through the shared `issues_all` cache via `fetchOpenIssuesByMilestone`
 * (no extra `gh` round-trip) and keeps only titles matching
 * {@link isMilestoneTrackingTitle}. Used by the completion loop each pass to
 * self-heal duplicate trackers and to dispose of premature / deadlocked
 * trackers.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneTitle - The milestone title
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param cache - Optional iteration-scoped IssueCache
 * @returns Ascending list of open tracking-issue numbers (empty on failure)
 */
export async function getOpenMilestoneTrackers(
  repo: string,
  milestoneTitle: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
  verification: MilestoneTrackerVerification = {},
): Promise<number[]> {
  try {
    const openIssues = await fetchOpenIssuesByMilestone(
      repo,
      milestoneTitle,
      cache,
      ghCommandFn,
    );
    // Issue #1246: every number returned here is handed to
    // `closeMilestoneTrackingIssue`, so it must be a tracker the fleet filed —
    // proved by the body marker and the author — and not merely an issue whose
    // title says so. An unverifiable candidate is left alone.
    const { trackers } = await partitionMilestoneTrackers(
      openIssues,
      `open trackers for milestone '${milestoneTitle}' in ${repo}`,
      {
        ...verification,
        unverifiedOutcome:
          "the candidate is not closed and keeps the milestone open",
      },
    );
    return trackers.map((issue) => issue.number).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Issue numbers of the open *non-tracking* issues the cached list sees for a
 * milestone, ascending (Issue #3908).
 *
 * This is exactly the set `checkMilestoneComplete` counts, exposed so the
 * disagreement warning can name what each source saw. Reads through the shared
 * `issues_all` cache — no extra `gh` round-trip. Returns an empty list on
 * failure; the caller has already had the failure reported by
 * `checkMilestoneComplete`.
 */
async function getCachedOpenNonTrackingIssues(
  repo: string,
  milestoneTitle: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
  verification: MilestoneTrackerVerification = {},
): Promise<number[]> {
  try {
    const openIssues = await fetchOpenIssuesByMilestone(
      repo,
      milestoneTitle,
      cache,
      ghCommandFn,
    );
    const { others } = await partitionMilestoneTrackers(
      openIssues,
      `cached open children of milestone '${milestoneTitle}' in ${repo}`,
      verification,
    );
    return others.map((issue) => issue.number).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// hasNothingToMerge (Issue #3214)
// ---------------------------------------------------------------------------

/**
 * Determine whether a milestone branch has nothing to merge into the default
 * branch (Issue #3214).
 *
 * "Nothing to merge" is true when either:
 *   1. the milestone branch does not exist on the remote (the common
 *      issue-only-milestone case), or
 *   2. the branch exists but is 0 commits ahead of the default branch, or
 *   3. its comparison reports no changed files, even with commits ahead.
 *
 * When there is genuinely nothing to merge, creating a tracking issue and a
 * summary PR is pointless — and, before this fix, the tracker left open by the
 * failed PR step deadlocked the milestone. The loop uses this to close the
 * milestone directly instead.
 *
 * Fails safe: any ambiguity (branch exists but the compare call fails, or an
 * unparseable `ahead_by` or missing file list on an ahead branch) returns
 * `false` so the normal branch-present flow
 * runs and no milestone is closed on incomplete information.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneBranch - The milestone branch name
 * @param defaultBranch - The default branch name
 * @param ghCommandFn - Function to execute gh CLI commands
 * @returns true when there is definitively nothing to merge
 */
export async function hasNothingToMerge(
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<boolean> {
  // Branch existence — a missing branch means nothing to merge.
  try {
    await ghCommandFn([
      "api",
      `repos/${repo}/branches/${milestoneBranch}`,
      "--jq",
      ".name",
    ]);
  } catch {
    return true;
  }

  // Sync merge commits can leave the branch ahead after its file changes
  // reached the default branch by another route (Issue #3910).
  try {
    const out = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${defaultBranch}...${milestoneBranch}`,
      "--jq",
      "{ahead_by, files}",
    ]);
    const comparison = JSON.parse(out);
    const aheadBy = comparison?.ahead_by;
    if (!Number.isSafeInteger(aheadBy) || aheadBy < 0) return false;
    return aheadBy === 0 ||
      (Array.isArray(comparison.files) && comparison.files.length === 0);
  } catch {
    // Compare failed — fail safe (do not close on incomplete information).
    return false;
  }
}

// ---------------------------------------------------------------------------
// buildMilestoneSummaryBody
// ---------------------------------------------------------------------------

/** Flag text per {@link ClaimProblem}, rendered under "Flagged — not claimed". */
const CLAIM_PROBLEM_REASONS: Record<ClaimProblem, string> = {
  "predates-reopen": "merged PR predates a later reopen",
  "sync-pr-only": "no fleet-titled merged PR — possibly a milestone sync PR",
  "timeline-unreadable":
    "issue timeline could not be read, so a later reopen cannot be ruled out",
};

/**
 * Build the PR body for a milestone summary PR.
 *
 * @param milestoneTitle - The milestone title
 * @param defaultBranch - The default branch name
 * @param closedIssues - List of closed issues in the milestone
 * @param trackingIssueNumber - Optional tracking issue number to reference
 * @param extraSections - Optional already-rendered markdown section(s)
 *   appended after "Issues addressed" and before "Review notes"; omitted
 *   entirely when empty. Carries the Issue #3014 pending-dependencies hold
 *   and/or the Issue #3223 not-planned-docs section, joined with a blank
 *   line when both are present.
 * @returns Markdown PR body
 */
export function buildMilestoneSummaryBody(
  milestoneTitle: string,
  defaultBranch: string,
  closedIssues: ClosedIssue[],
  trackingIssueNumber?: number,
  extraSections?: string,
): string {
  // Issue #3476: a closed issue with a `claimProblem` must be flagged for
  // review, not claimed as addressed. Split before rendering so the claimed
  // list holds only issues whose work is genuinely on the milestone branch.
  const claimed = closedIssues.filter((issue) => !issue.claimProblem);
  const flagged = closedIssues.filter((issue) => Boolean(issue.claimProblem));

  // Closed-issue titles are attacker-writable text quoted into a PR body the
  // worker signs, so they are scrubbed before interpolation (Issue #1249,
  // finding 8).
  const issuesList = claimed
    .map((issue) => `- #${issue.number}: ${scrubUntrustedText(issue.title)}`)
    .join("\n");

  // Issue #3476: rendered only when at least one closed issue cannot be
  // claimed, so the rollup lists it for review instead of asserting its work
  // landed on the milestone branch. Byte-identical (absent) otherwise.
  const flaggedSection = flagged.length > 0
    ? `\n### Flagged — not claimed\n${
      flagged
        .map((issue) => {
          const reason = CLAIM_PROBLEM_REASONS[issue.claimProblem!];
          return `- #${issue.number}: ${
            scrubUntrustedText(issue.title)
          } (${reason})`;
        })
        .join("\n")
    }\n`
    : "";

  const trackingRef = trackingIssueNumber
    ? `\nCloses #${trackingIssueNumber}`
    : "";

  // Issue #3014 / #3223: already-rendered section(s) — pending declared
  // dependencies and/or not-planned doc references — slotted between
  // "Issues addressed" and "Review notes"; byte-identical output when
  // absent.
  const dependencySection = extraSections ? `\n${extraSections}\n` : "";

  return `## Milestone: ${milestoneTitle}

This PR merges the completed milestone branch into ${defaultBranch}.${trackingRef}

### Issues addressed
${issuesList || "_No issues found_"}
${flaggedSection}${dependencySection}
### Review notes
All individual issues were reviewed and merged into the milestone branch via separate PRs.
This final PR consolidates all changes for a comprehensive review before merging to ${defaultBranch}.`;
}

// ---------------------------------------------------------------------------
// createMilestoneTrackingIssue (internal)
// ---------------------------------------------------------------------------

/**
 * Create a tracking issue for milestone completion (Issue #561).
 * Performs an idempotent check first to avoid duplicates.
 *
 * @returns The tracking issue number (existing or newly created), or null on failure
 */
async function createMilestoneTrackingIssue(
  repo: string,
  milestoneTitle: string,
  milestoneNumber: number,
  defaultBranch: string,
  closedIssues: ClosedIssue[],
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  cache?: IssueCache,
  verification: MilestoneTrackerVerification = {},
): Promise<number | null> {
  // Idempotent check
  const existingResult = await hasExistingMilestoneTrackingIssue(
    repo,
    milestoneTitle,
    milestoneNumber,
    defaultBranch,
    ghCommandFn,
    cache,
    verification,
  );
  if (existingResult.ok && existingResult.value !== null) {
    log(
      `Tracking issue for milestone '${milestoneTitle}' already exists (#${existingResult.value}) in ${repo}`,
    );
    return existingResult.value;
  }

  const issueTitle = `Merge milestone '${milestoneTitle}' to ${defaultBranch}`;
  // Scrubbed for the same reason as the summary body above (Issue #1249,
  // finding 8): this list lands in a filed issue body that later runs read.
  const issuesList = closedIssues
    .map((issue) => `- #${issue.number}: ${scrubUntrustedText(issue.title)}`)
    .join("\n");

  const issueBody = `${MILESTONE_TRACKING_MARKER}
## Milestone completion: ${milestoneTitle}

All issues in milestone '${milestoneTitle}' are now complete.
This is an auto-generated tracking issue for the milestone to ${defaultBranch} merge.

### Closed issues
${issuesList || "_No issues found_"}

### Action required
Raise a PR to merge the milestone branch to \`${defaultBranch}\`.`;

  try {
    // Issue #859: Do NOT add the discovery label to tracking issues.
    // Issue #1798: Tag the tracking issue with its milestone so the
    // cached `fetchAllStateIssuesByMilestone` lookup finds it on
    // subsequent iterations.
    const output = await ghCommandFn([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      issueTitle,
      "--body",
      issueBody,
      "--milestone",
      milestoneTitle,
    ]);

    log(`Milestone tracking issue created: ${output}`);

    // Issue #1798: invalidate the milestone-keyed cache so a subsequent
    // lookup in the same iteration sees the newly created tracking issue.
    if (cache) {
      await invalidateAllStateIssuesByMilestone(cache, repo, milestoneNumber);
    }

    // Extract issue number from URL (e.g., "https://github.com/owner/repo/issues/300")
    const match = output.match(/(\d+)\s*$/);
    return match ? Number(match[1]) : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Failed to create milestone tracking issue in ${repo}: ${message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// createMilestoneSummaryPr (internal)
// ---------------------------------------------------------------------------

/**
 * Read the PR number out of the URL `gh pr create` prints.
 *
 * Returns `null` when the output carries no `/pull/<n>` segment — an
 * unreadable URL is never guessed at, because the number is what every
 * follow-up write (arming, commenting) is addressed to. `run_outcome.ts`'s
 * `prNumberFromUrl` answers `0` for the same input, which would address the
 * writes below at PR #0; the null sentinel is what keeps the failure loud, and
 * it costs no dependency edge from the milestone path into run reporting.
 */
function summaryPrNumberFromUrl(prUrl: string): number | null {
  const match = /\/pull\/(\d+)/.exec(prUrl);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Arm auto-merge on a freshly created milestone summary PR (Issue #2458).
 *
 * The summary PR was the last fleet PR kind raised with no arming attempt at
 * all — it waited for the next Auto-Merge sweep. It goes through the same
 * chokepoint as every other PR now (`finalisePr`), with the milestone branch
 * as the head and the default branch as the base, so the #3909 open-children
 * gate and the #4375 base-protection gate both apply.
 *
 * Reporting follows the Issue #2457 contract: a refusal nothing else has
 * explained gets a warn log and exactly one comment naming the reason and
 * that the sweep retries. A deliberate hold — the #3909 refusal, which
 * comments for itself — is withheld silently rather than commented twice.
 */
async function armSummaryPrAutoMerge(
  repo: string,
  prNumber: number,
  milestoneBranch: string,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  arming: SummaryPrArmingInputs,
  prKind = "milestone summary PR",
): Promise<SummaryPrArming> {
  const commentFn = async (
    r: string,
    n: number,
    body: string,
  ): Promise<void> => {
    await ghCommandFn([
      "pr",
      "comment",
      String(n),
      "--repo",
      r,
      "--body",
      body,
    ]);
  };

  const armed = await finalisePr({
    repo,
    prNumber,
    headRefName: milestoneBranch,
    baseRefName: defaultBranch,
    ghCommandFn,
    commentFn,
    log,
    skipAutoMerge: arming.skipAutoMerge,
    ...(arming.authorOptions ? { authorOptions: arming.authorOptions } : {}),
    // Issue #1082: the summary PR is the one fleet PR whose base is always
    // the default branch, so on a base with no required checks it takes the
    // gated direct merge. Without the fleet logins that merge refuses
    // outright (Issue #2416) and the PR is reported unarmed — the same logins
    // the Auto-Merge sweep passes are what let an outside approval stand in
    // for the branch protection that is not there.
    ...(arming.fleetAuthors && arming.fleetAuthors.length > 0
      ? { fleetAuthors: arming.fleetAuthors }
      : {}),
  });

  // `finalisePr` reports `ok: false` for nothing today, but an error result
  // must never be read as an armed PR (fail loud, never silently green).
  if (!armed.ok) {
    log(
      `WARNING: auto-merge was not armed on the ${prKind} ` +
        `${repo}#${prNumber}: ${armed.error.message}`,
    );
    return "failed";
  }

  const outcome = armed.value;
  if (
    outcome.result === AutoMergeResult.Enabled ||
    outcome.result === AutoMergeResult.MergedDirectly
  ) {
    log(
      `Auto-merge ${outcome.result} on the ${prKind} ` +
        `${repo}#${prNumber}: ${outcome.message}`,
    );
    return "armed";
  }

  if (!autoMergeOutcomeNeedsComment(outcome)) {
    log(
      `Auto-merge withheld on the ${prKind} ${repo}#${prNumber} ` +
        `(${outcome.result}): ${outcome.message}`,
    );
    return "withheld";
  }

  log(
    `WARNING: auto-merge was not armed on the ${prKind} ` +
      `${repo}#${prNumber}: ${outcome.message}`,
  );
  try {
    await commentFn(repo, prNumber, buildArmingReasonComment(outcome));
  } catch (err) {
    // The refusal must never go silent because the comment could not be
    // posted — the warning above named the reason, this names the loss too.
    log(
      `WARNING: could not post the auto-merge reason comment on ` +
        `${repo}#${prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
  return "failed";
}

/**
 * Build the summary PR body for a milestone: the closed-issue rollup plus the
 * Issue #3014 pending-dependency hold and Issue #3223 not-planned-docs notes.
 * Shared by PR creation and by every body refresh (Issue #3476) so a refreshed
 * body is byte-for-byte what a fresh PR would carry.
 */
async function buildSummaryPrBody(
  repo: string,
  milestoneTitle: string,
  milestoneNumber: number,
  milestoneBranch: string,
  defaultBranch: string,
  trackingIssueNumber: number | null,
  closedIssues: ClosedIssue[],
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<string> {
  // Issue #3014: state which declared sub-issue dependencies have not
  // merged yet, so the PR body explains the hold the merge gate enforces.
  // A lookup failure never blocks PR creation — it only swaps in a note
  // saying verification could not be done, since the gate re-checks later.
  let dependencyNote: string | undefined;
  const pendingResult = await findPendingMilestoneDependencies({
    repo,
    milestoneNumber,
    ghCommandFn,
  });
  if (pendingResult.ok) {
    if (pendingResult.value.length > 0) {
      log(
        `WARNING: milestone '${milestoneTitle}' in ${repo} has ` +
          `${pendingResult.value.length} declared dependencies not merged ` +
          `yet — the summary PR is raised held and the merge gate refuses ` +
          `it until they land (Issue #3014)`,
      );
      dependencyNote = renderPendingDependenciesSection(pendingResult.value);
    }
  } else {
    log(
      `WARNING: could not verify declared dependencies for milestone ` +
        `'${milestoneTitle}' in ${repo}: ${pendingResult.error.message} — ` +
        `the merge gate re-checks before merging (Issue #3014)`,
    );
    dependencyNote = "### ⏸️ Declared dependencies not verified\n\n" +
      "The worker could not read the declared dependencies of this " +
      "milestone's issues when raising this PR. The merge gate re-checks " +
      "them before merging and holds the PR while any is pending.";
  }

  // Issue #3223: list every added Markdown line that names a sibling issue
  // closed as not planned. Never blocks PR creation — a lookup or diff
  // failure only swaps in a note saying it could not be checked.
  let notPlannedNote: string | undefined;
  const notPlannedResult = await findNotPlannedDocReferences({
    repo,
    milestoneNumber,
    defaultBranch,
    milestoneBranch,
    ghCommandFn,
  });
  if (notPlannedResult.ok) {
    if (
      notPlannedResult.value.references.length > 0 ||
      notPlannedResult.value.unchecked.length > 0
    ) {
      if (notPlannedResult.value.references.length > 0) {
        log(
          `WARNING: milestone '${milestoneTitle}' in ${repo} has ` +
            `${notPlannedResult.value.references.length} Markdown line(s) ` +
            `that name issues closed as not planned — listed in the ` +
            `summary PR body (Issue #3223)`,
        );
      }
      notPlannedNote = renderNotPlannedDocSection(notPlannedResult.value);
    }
  } else {
    log(
      `WARNING: could not check milestone '${milestoneTitle}' docs for ` +
        `issues closed as not planned in ${repo}: ` +
        `${notPlannedResult.error.message} (Issue #3223)`,
    );
    notPlannedNote = NOT_PLANNED_DOCS_UNVERIFIED_NOTE;
  }

  const extraSections = [dependencyNote, notPlannedNote]
    .filter((note): note is string => Boolean(note))
    .join("\n\n");

  const body = buildMilestoneSummaryBody(
    milestoneTitle,
    defaultBranch,
    closedIssues,
    trackingIssueNumber ?? undefined,
    extraSections || undefined,
  );
  const fingerprint = await summaryPrFingerprint(
    milestoneTitle,
    defaultBranch,
    trackingIssueNumber,
    closedIssues,
  );
  return `${body}\n\n${fingerprintMarker(fingerprint)}`;
}

function fingerprintMarker(fingerprint: string): string {
  return `<!-- vibe-rollup-fingerprint value="${fingerprint}" -->`;
}

/**
 * Fingerprint of the inputs a rollup body is built from that a scan can read
 * cheaply: milestone title, default branch, tracker and the classified closed
 * issues. It is stamped into the body (PR #3640 review) so a later scan that
 * computes the same value knows the body is current and skips the dependency
 * and not-planned-docs reads and the edit. The pending-dependency and
 * not-planned sections are deliberately not part of it: they are advisory, the
 * merge gate re-checks them before merging, and they refresh whenever the
 * fingerprint changes or the PR is raised.
 */
async function summaryPrFingerprint(
  milestoneTitle: string,
  defaultBranch: string,
  trackingIssueNumber: number | null,
  closedIssues: ClosedIssue[],
): Promise<string> {
  const payload = JSON.stringify([
    milestoneTitle,
    defaultBranch,
    trackingIssueNumber,
    closedIssues.map((i) => [i.number, i.title, i.claimProblem ?? null]),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The live state of a summary PR, read just before a refresh decides. */
interface LiveSummaryPr {
  state: string;
  body: string;
  headRefName: string;
  isCrossRepository: boolean;
}

async function readLiveSummaryPr(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
): Promise<Result<LiveSummaryPr>> {
  try {
    const parsed: unknown = JSON.parse(
      await ghCommandFn([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "state,body,headRefName,isCrossRepository",
      ]),
    );
    const v = parsed as Record<string, unknown> | null;
    if (
      v === null || typeof v !== "object" || typeof v.state !== "string" ||
      typeof v.body !== "string" || typeof v.headRefName !== "string" ||
      typeof v.isCrossRepository !== "boolean"
    ) {
      throw new Error("unexpected `gh pr view` payload");
    }
    return {
      ok: true,
      value: {
        state: v.state,
        body: v.body,
        headRefName: v.headRefName,
        isCrossRepository: v.isCrossRepository,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/** Inputs for {@link refreshExistingSummaryPr}. */
interface SummaryPrRefresh {
  repo: string;
  prNumber: number;
  milestone: { title: string; number: number };
  milestoneBranch: string;
  defaultBranch: string;
  trackingIssueNumber: number | null;
  closedIssues: ClosedIssue[];
  ghCommandFn: GhCommandFn;
  log: (message: string) => void;
}

/**
 * Bring an existing summary PR's body up to date (Issue #3476), writing only
 * when something changed (PR #3640 review).
 *
 * Reads the live PR first: one that is not `OPEN` (merged, closed), is a
 * fork's, or is not headed by the milestone branch is left alone, and so is
 * one whose live body already carries the current fingerprint — the common
 * scan, which costs this one read. Otherwise the body is rebuilt — it carries
 * the fingerprint, so a body that reaches this point always differs from the
 * live one — and `gh pr edit` runs. A fault is logged and never thrown: the next scan retries, and the PR keeps its previous body
 * meanwhile.
 */
async function refreshExistingSummaryPr(p: SummaryPrRefresh): Promise<void> {
  const { repo, prNumber, milestone, ghCommandFn, log } = p;
  const live = await readLiveSummaryPr(repo, prNumber, ghCommandFn);
  if (!live.ok) {
    log(
      `WARNING: could not read summary PR #${prNumber} for milestone '${milestone.title}' in ${repo}: ${live.error.message} — its body is left as it is (Issue #3476)`,
    );
    return;
  }
  if (
    live.value.state !== "OPEN" || live.value.isCrossRepository ||
    live.value.headRefName !== p.milestoneBranch
  ) {
    return;
  }

  const fingerprint = await summaryPrFingerprint(
    milestone.title,
    p.defaultBranch,
    p.trackingIssueNumber,
    p.closedIssues,
  );
  if (live.value.body.includes(fingerprintMarker(fingerprint))) return;

  const prBody = await buildSummaryPrBody(
    repo,
    milestone.title,
    milestone.number,
    p.milestoneBranch,
    p.defaultBranch,
    p.trackingIssueNumber,
    p.closedIssues,
    ghCommandFn,
    log,
  );
  try {
    await ghCommandFn([
      "pr",
      "edit",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      prBody,
    ]);
    log(
      `Summary PR #${prNumber} body refreshed for milestone '${milestone.title}' in ${repo} (Issue #3476)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: could not refresh summary PR #${prNumber} body for milestone '${milestone.title}' in ${repo}: ${message} — the stale body may still claim a reopened issue (Issue #3476)`,
    );
  }
}

/**
 * Create the final PR from milestone branch to default branch.
 * Performs idempotent checks first.
 *
 * Issue #1133: Returns a discriminated result so the caller can distinguish
 * "created", "exists" (should close tracking issue), and "failed" (leave open).
 *
 * @returns Discriminated SummaryPrOutcome
 */
async function createMilestoneSummaryPr(
  repo: string,
  milestoneTitle: string,
  milestoneNumber: number,
  milestoneBranch: string,
  defaultBranch: string,
  trackingIssueNumber: number | null,
  closedIssues: ClosedIssue[],
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  cache?: IssueCache,
  arming: SummaryPrArmingInputs = { skipAutoMerge: false },
  supersededPrNumbers: readonly number[] = [],
): Promise<SummaryPrOutcome> {
  // Idempotent check — do not create duplicate PRs
  const existingResult = await hasExistingMilestoneSummaryPr(
    repo,
    milestoneTitle,
    milestoneBranch,
    ghCommandFn,
    cache,
    supersededPrNumbers,
  );
  const existingPrNumber = existingResult.ok && existingResult.value !== null
    ? existingResult.value
    : null;

  // Check that the milestone branch exists on the remote (Issue #570). Only
  // needed on the creation path — an existing summary PR already references
  // the branch, so its absence would show up as a retarget, not a missing
  // branch here.
  if (existingPrNumber === null) {
    try {
      await ghCommandFn([
        "api",
        `repos/${repo}/branches/${milestoneBranch}`,
        "--jq",
        ".name",
      ]);
    } catch {
      log(
        `WARNING: Milestone branch '${milestoneBranch}' does not exist in ${repo} — cannot create summary PR`,
      );
      return { outcome: "failed", reason: "branch_missing" };
    }
  }

  // Issue #3476: a summary PR raised on an earlier scan carries a body built
  // from the closed issues as they were classified *then*. A listed issue that
  // has since reopened would stay under "Issues addressed" and be claimed by
  // the merge, so the body is refreshed against the freshly classified closed
  // issues — but only when the PR is open and the content changed (PR #3640
  // review), and before any body is built so an unchanged scan costs one read.
  if (existingPrNumber !== null) {
    await refreshExistingSummaryPr({
      repo,
      prNumber: existingPrNumber,
      milestone: { title: milestoneTitle, number: milestoneNumber },
      milestoneBranch,
      defaultBranch,
      trackingIssueNumber,
      closedIssues,
      ghCommandFn,
      log,
    });
    return { outcome: "exists", prNumber: existingPrNumber };
  }

  const prBody = await buildSummaryPrBody(
    repo,
    milestoneTitle,
    milestoneNumber,
    milestoneBranch,
    defaultBranch,
    trackingIssueNumber,
    closedIssues,
    ghCommandFn,
    log,
  );

  let prUrl: string;
  try {
    log(
      `Creating milestone summary PR: '${milestoneTitle}' → ${defaultBranch} in ${repo}`,
    );
    prUrl = await ghCommandFn([
      "pr",
      "create",
      "--repo",
      repo,
      "--title",
      `Milestone: ${milestoneTitle}`,
      "--body",
      prBody,
      "--head",
      milestoneBranch,
      "--base",
      defaultBranch,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Failed to create milestone summary PR for '${milestoneTitle}' in ${repo}: ${message}`,
    );
    return { outcome: "failed", reason: message };
  }

  log(`Milestone summary PR created: ${prUrl}`);
  // Issue #1798: invalidate the branch-keyed cache so a follow-up
  // lookup within the same iteration sees the newly created PR.
  if (cache) {
    await invalidateAllStatePRsByBranch(cache, repo, milestoneBranch);
  }

  // Issue #2458: arm auto-merge here rather than leaving the summary PR for
  // the next Auto-Merge sweep — it was the only fleet PR kind with no arming
  // attempt at creation. Deliberately outside the creation try/catch: the PR
  // exists from this point on, and an arming fault must never re-label a
  // created PR as `failed` — that would suppress `onPrCreated` and leave the
  // milestone's tracking issue open.
  const prNumber = summaryPrNumberFromUrl(prUrl);
  if (prNumber === null) {
    log(
      `WARNING: could not read a PR number from '${prUrl.trim()}' — the ` +
        `milestone summary PR for '${milestoneTitle}' in ${repo} was not ` +
        `armed for auto-merge; the Auto-Merge sweep retries`,
    );
    return { outcome: "created", prNumber: null, autoMerge: "failed" };
  }
  const autoMerge = await armSummaryPrAutoMerge(
    repo,
    prNumber,
    milestoneBranch,
    defaultBranch,
    ghCommandFn,
    log,
    arming,
  );
  return { outcome: "created", prNumber, autoMerge };
}

// ---------------------------------------------------------------------------
// isSummaryPrMerged
// ---------------------------------------------------------------------------

/**
 * Check whether a summary PR has been merged.
 *
 * Issue #1210: Used to determine whether the GitHub milestone should be closed
 * after the summary PR is confirmed to exist.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - The PR number to check
 * @param ghCommandFn - Function to execute gh CLI commands
 * @returns Result with true if the PR state is "MERGED", false otherwise
 */
export async function isSummaryPrMerged(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
): Promise<Result<boolean>> {
  try {
    const output = await ghCommandFn([
      "pr",
      "view",
      "--repo",
      repo,
      String(prNumber),
      "--json",
      "state",
    ]);
    const data = JSON.parse(output) as { state: string };
    return { ok: true, value: data.state === "MERGED" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to check PR #${prNumber} state in ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// closeGitHubMilestone
// ---------------------------------------------------------------------------

/**
 * Close a GitHub milestone via the REST API.
 *
 * Issue #1210: After the summary PR is merged, the milestone should be closed
 * so it is not re-checked on subsequent scan cycles.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneNumber - The GitHub milestone number (API ID, not title)
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param log - Logging function
 */
export async function closeGitHubMilestone(
  repo: string,
  milestoneNumber: number,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<void> {
  try {
    await ghCommandFn([
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/milestones/${milestoneNumber}`,
      "-f",
      "state=closed",
    ]);
    log(`Closed GitHub milestone #${milestoneNumber} in ${repo} (Issue #1210)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Failed to close milestone #${milestoneNumber} in ${repo}: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// closeMilestoneTrackingIssue (internal)
// ---------------------------------------------------------------------------

/**
 * Close a milestone tracking issue immediately after the summary PR is
 * created or confirmed to already exist (Issue #1133).
 *
 * This prevents the worker from discovering and claiming the tracking
 * issue as a regular work item during the review period.
 */
async function closeMilestoneTrackingIssue(
  repo: string,
  issueNumber: number,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  milestoneNumber?: number,
  cache?: IssueCache,
): Promise<void> {
  try {
    await ghCommandFn([
      "issue",
      "close",
      "--repo",
      repo,
      String(issueNumber),
      "--reason",
      "completed",
    ]);
    log(
      `Closed milestone tracking issue #${issueNumber} in ${repo} (Issue #1133)`,
    );
    // Issue #1798: closing the tracking issue mutates milestone state —
    // drop the milestone-keyed cache so a follow-up lookup sees the
    // closed state.
    if (cache && typeof milestoneNumber === "number") {
      await invalidateAllStateIssuesByMilestone(cache, repo, milestoneNumber);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Failed to close tracking issue #${issueNumber} in ${repo}: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// getClosedIssues (internal)
// ---------------------------------------------------------------------------

/** Cache-entry name prefix for a closed issue's claim verdict (PR #3640 review). */
const CLAIM_VERDICT_ENTRY_PREFIX = "milestone_claim_verdict_v1_";

/** A cached claim verdict: valid only for the `updatedAt` it was read at. */
interface CachedClaimVerdict {
  updatedAt: string;
  claimProblem: ClaimProblem | null;
}

function isCachedClaimVerdict(value: unknown): value is CachedClaimVerdict {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.updatedAt === "string" &&
    (v.claimProblem === null ||
      (typeof v.claimProblem === "string" &&
        Object.hasOwn(CLAIM_PROBLEM_REASONS, v.claimProblem)));
}

/**
 * Classify each closed issue as claimable or flaggable (Issue #3476).
 *
 * A closed issue is only claimed when it has at least one genuine merged PR
 * (a fleet-titled PR that `fetchPRsForIssueByTitle` keeps) whose merge is not
 * predated by the issue's latest reopen. Anything else is flagged so the
 * rollup lists it for review instead of claiming its work is on the branch.
 *
 * With a `cache`, the verdict for an issue is kept under its number and
 * `updatedAt` (PR #3640 review), so a scan that finds the issue unchanged does
 * not re-page its timeline. A reopen or re-close bumps `updatedAt` and misses.
 * The cache's own TTL bounds how long a verdict survives a change that leaves
 * `updatedAt` alone (a PR merged against the issue by title). Only a verdict
 * reached from a merged PR and a readable timeline is cached; a "sync-pr-only"
 * flag is not (its merged-PR read has its own cache) and neither is an
 * unreadable timeline, so the next scan retries both. An issue without an
 * `updatedAt` (an older closed-batch cache entry) is classified live.
 */
export async function classifyClosedIssues(
  repo: string,
  issues: ClosedIssue[],
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<ClosedIssue[]> {
  const classified: ClosedIssue[] = [];
  for (const issue of issues) {
    const key = `${CLAIM_VERDICT_ENTRY_PREFIX}${issue.number}`;
    if (cache) {
      const hit = await cache.read<unknown>(repo, key);
      if (isCachedClaimVerdict(hit) && hit.updatedAt === issue.updatedAt) {
        classified.push(
          hit.claimProblem === null
            ? issue
            : { ...issue, claimProblem: hit.claimProblem },
        );
        continue;
      }
    }

    // Merged PRs first: with none, the issue is flagged whatever its timeline
    // says, so the timeline is not paged. `fetchPRsForIssueByTitle` caches an
    // empty answer only when the read succeeded, so a failed read is retried
    // next scan rather than pinned here as "sync-pr-only".
    let mergedPrs: Awaited<ReturnType<typeof fetchPRsForIssueByTitle>> = [];
    try {
      mergedPrs = await fetchPRsForIssueByTitle(
        repo,
        issue.number,
        "merged",
        cache,
        ghCommandFn,
      );
    } catch {
      mergedPrs = [];
    }
    if (mergedPrs.length === 0) {
      classified.push({ ...issue, claimProblem: "sync-pr-only" });
      continue;
    }

    const timeline = await fetchTimelineWithCache(
      repo,
      issue.number,
      ghCommandFn,
    );
    // An unreadable timeline (gh fault, validation failure, page cap) cannot
    // rule out a later reopen, so the issue is flagged, never claimed — and
    // never cached, so the next scan retries it.
    if (timeline === null) {
      classified.push({ ...issue, claimProblem: "timeline-unreadable" });
      continue;
    }
    const reopenedAt = latestReopenedAtFromTimeline(timeline);
    const claimProblem: ClaimProblem | null = reopenedAt !== null &&
        mergedPrs.every((pr) => !pr.mergedAt || pr.mergedAt < reopenedAt)
      ? "predates-reopen"
      : null;
    if (cache && issue.updatedAt !== undefined) {
      await cache.write(
        repo,
        key,
        {
          updatedAt: issue.updatedAt,
          claimProblem,
        } satisfies CachedClaimVerdict,
      );
    }
    classified.push(claimProblem === null ? issue : { ...issue, claimProblem });
  }
  return classified;
}

/**
 * The milestone's closed issues, minus its own tracking issues, classified
 * for the rollup body (Issue #3476).
 *
 * The fleet's tracker is filed with `--milestone` and closed in the same scan
 * that raises the summary PR, so it sits in the closed list on every later
 * scan. It is not sub-issue work: left in, it is flagged `sync-pr-only` (no
 * `(#N)`-titled merged PR) right beside `Closes #N`. Trackers are identified by
 * the same title + marker + fleet-author check every other tracker decision
 * uses, over the milestone's all-state list (which carries body and author).
 *
 * Issue #3662: the closed issues are read by milestone number, paginated, so
 * they are not bounded by the 500-issue repo-wide batch that once hid an older
 * milestone's work. `null` means a read failed, which is kept apart from `[]`
 * (a genuinely empty milestone) so a failed read is never mistaken for empty.
 */
async function getClosedIssues(
  repo: string,
  milestone: { title: string; number: number },
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
  verification: MilestoneTrackerVerification = {},
): Promise<ClosedIssue[] | null> {
  // Issue #1786: routes through the cached helper so duplicate
  // closed-issue lookups across the milestone helpers within a single
  // iteration share a payload.
  try {
    const closed = await fetchClosedIssuesByMilestoneNumber(
      repo,
      milestone.number,
      cache,
      ghCommandFn,
    );
    const allStates = await fetchAllStateIssuesByMilestone(
      repo,
      milestone.number,
      cache,
      ghCommandFn,
    );
    const { trackers } = await partitionMilestoneTrackers(
      allStates,
      `closed-issue rollup for milestone '${milestone.title}' in ${repo}`,
      {
        ...verification,
        unverifiedOutcome:
          "the candidate is treated as ordinary closed work and flagged " +
          "if no fleet-titled merged PR claims it",
      },
    );
    const trackerNumbers = new Set(trackers.map((t) => t.number));
    return await classifyClosedIssues(
      repo,
      closed.filter((issue) => !trackerNumbers.has(issue.number)),
      ghCommandFn,
      cache,
    );
  } catch {
    // Issue #3662: a failed read is null, never [], so callers can skip the
    // milestone rather than treat it as empty.
    return null;
  }
}

/**
 * Refresh the body of a still-open summary PR while its milestone has an open
 * child again (Issue #3476).
 *
 * The completion path only reaches `createMilestoneSummaryPr` once nothing is
 * open, so an issue reopened after the rollup was raised would otherwise stay
 * under "Issues addressed" for as long as it is open. The body is rebuilt from
 * the issues that are still closed, which drops the reopened one.
 *
 * The scan stays cheap for the common milestone, which has no summary PR at
 * all (PR #3640 review): candidates come from the cached all-state branch list,
 * and only those that list shows `OPEN` (or shows no state, because the read
 * gave none) are carried on. A milestone whose only
 * final PR is merged or closed — the normal state after an automated roll-back
 * — therefore costs no closed-issue classification and no live read. Each
 * remaining candidate is then read live by {@link refreshExistingSummaryPr},
 * which edits only an `OPEN` same-repository PR headed by the milestone branch
 * whose body is stale — the cached state may be old — and leaves a closed-issue
 * list that reads empty alone, logging a fault rather than throwing.
 */
async function refreshOpenSummaryPrBodyWhileIncomplete(
  repo: string,
  milestone: { title: string; number: number },
  milestoneBranch: string,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  cache: IssueCache | undefined,
  verification: MilestoneTrackerVerification,
): Promise<void> {
  const candidates = (await fetchAllStatePRsByBranch(
    repo,
    milestoneBranch,
    cache,
    ghCommandFn,
  )).filter((pr) =>
    pr.headRefName === milestoneBranch &&
    (pr.state === undefined || pr.state === "OPEN")
  );
  if (candidates.length === 0) return;

  const closedIssues = await getClosedIssues(
    repo,
    milestone,
    ghCommandFn,
    cache,
    verification,
  );
  // Issue #3662: null is a failed read; [] is a genuinely empty milestone.
  // Publishing "_No issues found_" over a good body after a failed read would
  // be worse than leaving it stale, so leave it for a later scan.
  if (closedIssues === null) {
    log(
      `WARNING: could not refresh summary PR body for milestone ` +
        `'${milestone.title}' in ${repo}: closed-issue read failed — leaving ` +
        `the body as it is for a later scan (Issue #3662)`,
    );
    return;
  }
  if (closedIssues.length === 0) return;
  const tracker = await hasExistingMilestoneTrackingIssue(
    repo,
    milestone.title,
    milestone.number,
    defaultBranch,
    ghCommandFn,
    cache,
    verification,
  );
  for (const candidate of candidates) {
    await refreshExistingSummaryPr({
      repo,
      prNumber: candidate.number,
      milestone,
      milestoneBranch,
      defaultBranch,
      trackingIssueNumber: tracker.ok ? tracker.value : null,
      closedIssues,
      ghCommandFn,
      log,
    });
  }
}

// ---------------------------------------------------------------------------
// Write-phase identity guard (Issue #3528)
// ---------------------------------------------------------------------------

/** Default live-login resolver — the real `gh` login via getGithubUser. */
async function defaultResolveActualLogin(): Promise<string | null> {
  const { getGithubUser } = await import("./claude_runner.ts");
  const result = await getGithubUser();
  return result.ok ? result.value : null;
}

/**
 * Re-resolve the live `gh` login and validate it against the configured
 * service-account allowlist before any milestone write (Issue #3528).
 *
 * @returns An {@link IdentityGuardError} when the write must be refused, or
 *   null when it is safe to proceed (login allowed, or allowlist inactive).
 */
async function checkWriteIdentity(
  deps: MilestoneCompletionDeps,
): Promise<IdentityGuardError | null> {
  const serviceAccounts = deps.serviceAccounts ?? [];
  // Inactive allowlist: nothing to enforce. The startup guard already logged
  // the loud INACTIVE warning, so stay quiet here to avoid per-iteration noise.
  if (serviceAccounts.filter((a) => a.trim().length > 0).length === 0) {
    return null;
  }

  const resolveActualLogin = deps.resolveActualLogin ??
    defaultResolveActualLogin;
  const host = deps.hostname?.() ?? readHostname();
  const actual = (await resolveActualLogin()) ?? "";
  const evaluation = evaluateWorkerIdentity(actual, serviceAccounts, host);
  return evaluation.permitted ? null : new IdentityGuardError(evaluation);
}

// ---------------------------------------------------------------------------
// checkAndHandleMilestoneCompletions (main entry point)
// ---------------------------------------------------------------------------

/**
 * Scan configured repositories for completed milestones and create tracking
 * issues and summary PRs as needed.
 *
 * This is the main orchestration function, called from the run_core priority
 * dispatch at priority 1.7.
 *
 * @param deps - Injected dependencies
 * @returns Result with the number of summary PRs created
 */
export async function checkAndHandleMilestoneCompletions(
  deps: MilestoneCompletionDeps,
): Promise<Result<MilestoneCompletionResult>> {
  const { repos, ghCommandFn, log } = deps;
  let summaryPrsCreated = 0;

  if (repos.length === 0) {
    return { ok: true, value: { summaryPrsCreated: 0 } };
  }

  // Issue #3528: fail-loud identity re-check before any milestone write.
  // The milestone-completion path creates tracking issues, raises summary PRs,
  // and closes trackers via `runGhCommand` — worker code, not the Claude
  // subprocess. A host whose `gh` auth drifts mid-run to a human personal
  // token would perform those writes as that human. Re-resolve the live login
  // here and refuse to proceed on a mismatch. This runs *before* the per-repo
  // loop (whose try/catch swallows errors as warnings), so the mismatch is
  // never masked as success.
  const identityFailure = await checkWriteIdentity(deps);
  if (identityFailure) {
    log(identityFailure.message);
    return { ok: false, error: identityFailure };
  }

  const defaultBranchFn: DefaultBranchFn = deps.defaultBranchFn ??
    makeGhDefaultBranchFn(ghCommandFn);

  for (const repo of repos) {
    try {
      await processRepoMilestones(
        repo,
        ghCommandFn,
        defaultBranchFn,
        log,
        (count) => {
          summaryPrsCreated += count;
        },
        deps.cache,
        deps.authorOptions,
        {
          skipAutoMerge: deps.skipAutoMerge?.(repo) ?? false,
          ...(deps.fleetAuthors ? { fleetAuthors: deps.fleetAuthors } : {}),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`WARNING: Milestone check failed for ${repo}: ${message}`);
    }
  }

  if (summaryPrsCreated > 0) {
    log(
      `Milestone completion check: ${summaryPrsCreated} summary PR(s) created (Issue #425)`,
    );
  }

  return { ok: true, value: { summaryPrsCreated } };
}

/**
 * Process milestone completions for a single repository.
 */
async function processRepoMilestones(
  repo: string,
  ghCommandFn: GhCommandFn,
  defaultBranchFn: DefaultBranchFn,
  log: (message: string) => void,
  onPrCreated: (count: number) => void,
  cache?: IssueCache,
  authorOptions?: AlertDedupAuthorOptions,
  arming: SummaryPrArmingInputs = { skipAutoMerge: false },
): Promise<void> {
  // Issue #1246: one verification context for every tracker decision in this
  // repo's scan, so no call site can be left reading titles on their own.
  const verification: MilestoneTrackerVerification = {
    ...(authorOptions !== undefined ? { authorOptions } : {}),
    log,
  };
  // PR #3592 review: the fleet logins whose roll-back close comments count,
  // resolved at most once per repo scan by the same rule the tracker author
  // check uses, and only if a closed-only milestone needs it.
  let fleetForRollbackCloses: Promise<string[]> | undefined;
  const resolveFleetForRollbackCloses = (): Promise<string[]> =>
    fleetForRollbackCloses ??= resolveAlertDedupAuthors(
      authorOptions ?? {},
      log,
    );
  // Resolve default branch via injected function (Issue #1509 — uses the
  // persistent 7-day cache in production so we don't burn a GitHub REST
  // quota slot every run_core cycle).
  const branchResult = await defaultBranchFn(repo);
  if (!branchResult.ok) {
    log(
      `WARNING: Could not determine default branch for ${repo} — skipping milestone check`,
    );
    return;
  }
  const defaultBranch = branchResult.value.trim();
  if (!defaultBranch) {
    log(
      `WARNING: Could not determine default branch for ${repo} — skipping milestone check`,
    );
    return;
  }

  // Issue #3609: every open milestone, in bounded pages — the default page of
  // 30 hid the rest from completion and deadlock detection.
  let milestones: GitHubMilestone[];
  try {
    milestones = await fetchOpenMilestonePages(
      repo,
      ghCommandFn,
      log,
    ) as GitHubMilestone[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: could not list open milestones for ${repo} — skipping milestone check: ${message}`,
    );
    return;
  }

  for (const milestone of milestones) {
    // Issue #2125: idle-task milestones (e.g. `idle-task: security-scan`)
    // are retired. The security-scan template files findings directly
    // as standalone issues — the milestone has no role. Auto-close any
    // legacy milestone whose backlog has fully drained so it stops
    // generating completion-sync log noise on every iteration; skip it
    // silently otherwise. `skipMilestone: true` already prevents new
    // wrappers from being filed under a milestone, so no fresh idle-task
    // milestones will appear.
    if (isIdleTaskMilestone(milestone.title)) {
      if ((milestone.open_issues ?? 0) === 0) {
        log(
          `Closing legacy idle-task milestone '${milestone.title}' in ${repo} ` +
            `— no longer used (Issue #2125)`,
        );
        await closeGitHubMilestone(repo, milestone.number, ghCommandFn, log);
      } else {
        log(
          `Skipping idle-task milestone '${milestone.title}' in ${repo} — ` +
            `${milestone.open_issues} open issue(s) remain, no summary PR ` +
            `will be raised (Issue #2125)`,
        );
      }
      continue;
    }

    const milestoneBranch = createMilestoneBranchName(milestone.title);

    // Issue #3214: fetch the milestone's open tracking-shaped issues up front
    // so every branch below can self-heal duplicate/premature/deadlocked
    // trackers. Reads through the shared cache — no extra gh round-trip.
    const openTrackers = await getOpenMilestoneTrackers(
      repo,
      milestone.title,
      ghCommandFn,
      cache,
      verification,
    );

    // Check if milestone is complete (all non-tracking issues closed —
    // Issue #3214 excludes the tracker so it can no longer block itself).
    const completeResult = await checkMilestoneComplete(
      repo,
      milestone.title,
      ghCommandFn,
      cache,
      verification,
    );
    const refreshWhileIncomplete = () =>
      refreshOpenSummaryPrBodyWhileIncomplete(
        repo,
        milestone,
        milestoneBranch,
        defaultBranch,
        ghCommandFn,
        log,
        cache,
        verification,
      );
    if (!completeResult.ok || !completeResult.value) {
      // Issue #3476: a listed issue that reopened must leave an existing
      // summary PR's "Issues addressed" now, not once the milestone completes.
      await refreshWhileIncomplete();
      // Issue #3214 (scope item 4): the milestone is NOT complete but carries
      // an open tracking-shaped issue — a premature tracker filed when the
      // milestone momentarily hit 0 open before new issues were added. Close
      // it so it is not claimed as work and does not linger.
      for (const tracker of openTrackers) {
        await closeMilestoneTrackingIssue(
          repo,
          tracker,
          ghCommandFn,
          log,
          milestone.number,
          cache,
        );
        log(
          `Closed premature milestone tracking issue #${tracker} for '${milestone.title}' in ${repo} — milestone not complete (Issue #3214)`,
        );
      }
      continue;
    }

    // Issue #3908: the cached list says complete — now ask GitHub. The
    // authoritative `open_issues` counter is read fresh (no cache) at this
    // exact moment, and any open non-tracking child (issue *or* PR) is a hard
    // veto: no tracker, no summary PR, no milestone close. A failed or
    // malformed read is also a veto — "could not tell" is never "complete".
    const authoritative = await fetchAuthoritativeOpenChildren(
      repo,
      milestone.number,
      ghCommandFn,
      verification,
    );
    if (!authoritative.ok) {
      log(
        `WARNING: ${authoritative.error.message} — refusing to finalise ` +
          `milestone '${milestone.title}' this pass (Issue #3908)`,
      );
      continue;
    }
    const authority = authoritative.value;
    if (!authority.childListAvailable) {
      log(
        `WARNING: Could not read the fresh open-child list for milestone ` +
          `'${milestone.title}' in ${repo}: ${authority.childListError} — ` +
          `falling back to the unadjusted open_issues count ` +
          `(${authority.rawOpenIssues}), tracking issues not excluded ` +
          `(Issue #3908)`,
      );
    }
    const cachedOpen = await getCachedOpenNonTrackingIssues(
      repo,
      milestone.title,
      ghCommandFn,
      cache,
      verification,
    );
    if (authority.openCount !== cachedOpen.length) {
      log(
        `WARNING: Open-children disagreement for milestone ` +
          `'${milestone.title}' in ${repo} — GitHub reports ` +
          `${authority.openCount} open non-tracking child(ren) ` +
          `[${formatChildNumbers(authority.children)}] ` +
          `(open_issues=${authority.rawOpenIssues}, trackers ` +
          `[${formatChildNumbers(authority.trackers)}]) but the cached issue ` +
          `list reports ${cachedOpen.length} ` +
          `[${cachedOpen.map((n) => `#${n}`).join(", ") || "none"}]. ` +
          `Trusting GitHub (Issue #3908)`,
      );
    }
    if (authority.openCount > 0) {
      await refreshWhileIncomplete();
      log(
        `Milestone '${milestone.title}' in ${repo} is NOT complete — GitHub ` +
          `reports ${authority.openCount} open non-tracking child ` +
          `issue(s)/PR(s) [${formatChildNumbers(authority.children)}]; no ` +
          `tracking issue, summary PR or milestone close will be made ` +
          `(Issue #3908)`,
      );
      continue;
    }

    // Issue #3214 (scope item 3): self-heal duplicate trackers each pass.
    // Keep the canonical (lowest-numbered) tracker and close the rest.
    let canonicalTracker: number | null = null;
    if (openTrackers.length > 0) {
      const selection = selectDuplicateTrackersToClose(openTrackers);
      canonicalTracker = selection.keep;
      for (const dup of selection.close) {
        await closeMilestoneTrackingIssue(
          repo,
          dup,
          ghCommandFn,
          log,
          milestone.number,
          cache,
        );
        log(
          `Closed duplicate milestone tracking issue #${dup} for '${milestone.title}' in ${repo} (Issue #3214)`,
        );
      }
    }

    // Issue #3474: classify the milestone's final PR(s) before anything else.
    // A merged final PR closes the milestone; one closed without merging means
    // no new final PR will be raised, so close out instead of wedging forever.
    // A "superseded" result (the fleet's roll-back closed it) falls through
    // to raise a fresh final PR, ignoring the closed ones.
    const finalPrs = await classifyMilestoneFinalPrs(
      repo,
      milestoneBranch,
      ghCommandFn,
      resolveFleetForRollbackCloses,
    );
    if (!finalPrs.ok) {
      log(
        `WARNING: ${finalPrs.error.message} — continuing close-out without ` +
          `final PR classification (Issue #3474)`,
      );
    } else if (finalPrs.value.kind === "merged") {
      const prNumber = finalPrs.value.prNumber;
      if (canonicalTracker !== null) {
        await closeMilestoneTrackingIssue(
          repo,
          canonicalTracker,
          ghCommandFn,
          log,
          milestone.number,
          cache,
        );
      }
      await retireMilestoneSyncPrs({
        repo,
        milestoneBranch,
        ghCommandFn,
        log,
        reason:
          `the final PR #${prNumber} for milestone '${milestone.title}' ` +
          `has merged, so '${milestoneBranch}' is being retired`,
      });
      await closeGitHubMilestone(repo, milestone.number, ghCommandFn, log);
      log(
        `Milestone '${milestone.title}' in ${repo}: final PR #${prNumber} merged — closed (Issue #3474)`,
      );
      continue;
    } else if (finalPrs.value.kind === "abandoned") {
      const prNumber = finalPrs.value.prNumber;
      const body = `Milestone '${milestone.title}' close-out: the final PR ` +
        `#${prNumber} was closed without merging, so no new final PR will ` +
        `be raised and the milestone is being closed (Issue #3474).`;
      try {
        await ghCommandFn(
          canonicalTracker !== null
            ? [
              "issue",
              "comment",
              String(canonicalTracker),
              "--repo",
              repo,
              "--body",
              body,
            ]
            : [
              "pr",
              "comment",
              String(prNumber),
              "--repo",
              repo,
              "--body",
              body,
            ],
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(
          `WARNING: Could not comment on the close-out of milestone ` +
            `'${milestone.title}' in ${repo}: ${message} (Issue #3474)`,
        );
      }
      if (canonicalTracker !== null) {
        await closeMilestoneTrackingIssue(
          repo,
          canonicalTracker,
          ghCommandFn,
          log,
          milestone.number,
          cache,
        );
      }
      await retireMilestoneSyncPrs({
        repo,
        milestoneBranch,
        ghCommandFn,
        log,
        reason: `milestone '${milestone.title}' final PR #${prNumber} was ` +
          `closed unmerged, so '${milestoneBranch}' is being retired`,
      });
      await closeGitHubMilestone(repo, milestone.number, ghCommandFn, log);
      log(
        `Milestone '${milestone.title}' in ${repo}: final PR #${prNumber} closed unmerged — milestone closed, no new final PR (Issue #3474)`,
      );
      continue;
    }

    // Issue #3474: read the closed items before the nothing-to-merge close
    // so a milestone with none can be told apart from one planning has only
    // just created.
    const closedIssues = await getClosedIssues(
      repo,
      milestone,
      ghCommandFn,
      cache,
      verification,
    );
    // Issue #3662: a failed read is null, not an empty milestone. Skip it for
    // this scan so it neither closes (nothing-to-merge) nor is read as empty.
    if (closedIssues === null) {
      log(
        `WARNING: Milestone '${milestone.title}' in ${repo}: closed-issue ` +
          `read failed; skipping this milestone for this scan, not treating ` +
          `it as empty (Issue #3662)`,
      );
      continue;
    }
    // PR #3592 review: planning POSTs the milestone and only then assigns its
    // sub-issues, so for a moment it has no items and no branch. Leave a young
    // (or undated) empty milestone for a later scan rather than closing it
    // under the planning run.
    if (
      closedIssues.length === 0 &&
      isMilestoneYoung(milestone.created_at, Date.now())
    ) {
      log(
        `Milestone '${milestone.title}' in ${repo} has no closed items and ` +
          `was created within the last ${
            EMPTY_MILESTONE_GRACE_MS / 60_000
          } minutes (or has no usable created_at) — leaving it for a later ` +
          `scan (PR #3592 review)`,
      );
      continue;
    }

    // Issue #3214 (scope item 2): check the milestone branch BEFORE creating a
    // tracker. When there is nothing to merge (branch missing, 0 commits
    // ahead of the default branch, or no changed files),
    // creating a tracker + summary PR is pointless and, before this fix, left
    // the tracker open forever (the deadlock). Instead close any open trackers
    // and close the milestone directly.
    if (
      await hasNothingToMerge(
        repo,
        milestoneBranch,
        defaultBranch,
        ghCommandFn,
      )
    ) {
      if (canonicalTracker !== null) {
        await closeMilestoneTrackingIssue(
          repo,
          canonicalTracker,
          ghCommandFn,
          log,
          milestone.number,
          cache,
        );
      }
      // Issue #1967: this milestone is finishing without a final PR, so its
      // branch is now branch cleanup's to delete — and an open sync PR would
      // be retargeted onto the default branch when it goes.
      await retireMilestoneSyncPrs({
        repo,
        milestoneBranch,
        ghCommandFn,
        log,
        reason: `milestone '${milestone.title}' is complete with nothing to ` +
          `merge, so '${milestoneBranch}' is being retired`,
      });
      await closeGitHubMilestone(repo, milestone.number, ghCommandFn, log);
      log(
        `Milestone '${milestone.title}' in ${repo} is complete with nothing to merge (branch missing, 0 commits ahead or no changed files) — closed directly, no tracker or summary PR (Issue #3214)`,
      );
      continue;
    }

    // Skip empty milestones (no closed issues means nothing was worked on).
    // Issue #3474: this runs only after the nothing-to-merge check above, so
    // an empty milestone with no branch (or 0 ahead) is closed rather than
    // skipped (once past the grace window above); an empty milestone with
    // commits ahead is still skipped.
    if (closedIssues.length === 0) {
      continue;
    }

    // Create tracking issue (idempotent)
    const trackingIssueNumber = await createMilestoneTrackingIssue(
      repo,
      milestone.title,
      milestone.number,
      defaultBranch,
      closedIssues,
      ghCommandFn,
      log,
      cache,
      verification,
    );

    // Issue #1967: retire the milestone's sync PR *before* the final PR
    // exists. GitHub does not close the PRs targeting a branch it deletes on
    // merge — it retargets them to the default branch, approvals and
    // auto-merge intact — so the sync PR has to be gone before the final PR
    // can merge, not after.
    //
    // Only on the cycle that actually raises the final PR. A summary PR that
    // already exists may sit unmerged for days behind a red check, and
    // retiring the sync every one of those cycles would close and re-raise
    // it endlessly while leaving the milestone branch unable to take the
    // default branch through a PR. The post-merge retirement below is what
    // covers a sync raised after this point.
    // A final PR a roll-back closed does not count as existing here either,
    // or the sync PR would stay open while the fresh final PR is raised.
    const supersededPrNumbers =
      finalPrs.ok && finalPrs.value.kind === "superseded"
        ? finalPrs.value.closedPrNumbers
        : [];
    const existingSummary = await hasExistingMilestoneSummaryPr(
      repo,
      milestone.title,
      milestoneBranch,
      ghCommandFn,
      cache,
      supersededPrNumbers,
    );
    if (existingSummary.ok && existingSummary.value === null) {
      await retireMilestoneSyncPrs({
        repo,
        milestoneBranch,
        ghCommandFn,
        log,
        reason: `milestone '${milestone.title}' is complete and its final PR ` +
          `into '${defaultBranch}' is being raised`,
      });
    }

    // Create summary PR (idempotent)
    log(`Milestone '${milestone.title}' is complete — creating summary PR`);
    const prResult = await createMilestoneSummaryPr(
      repo,
      milestone.title,
      milestone.number,
      milestoneBranch,
      defaultBranch,
      trackingIssueNumber,
      closedIssues,
      ghCommandFn,
      log,
      cache,
      { ...arming, ...(authorOptions !== undefined ? { authorOptions } : {}) },
      supersededPrNumbers,
    );
    if (prResult.outcome === "created") {
      onPrCreated(1);
    }

    // Issue #1133: Close tracking issue immediately after summary PR is
    // created or confirmed to already exist. This prevents the worker from
    // claiming the tracking issue as a regular work item.
    if (prResult.outcome !== "failed" && trackingIssueNumber !== null) {
      await closeMilestoneTrackingIssue(
        repo,
        trackingIssueNumber,
        ghCommandFn,
        log,
        milestone.number,
        cache,
      );
    }

    // Issue #1210: Close the GitHub milestone when the summary PR has been
    // merged. This prevents the handler from re-checking the milestone every
    // scan cycle and logging repeated "Summary PR already exists" messages.
    // Only check when the PR already existed — a just-created PR cannot be
    // merged yet.
    if (prResult.outcome === "exists") {
      const mergedResult = await isSummaryPrMerged(
        repo,
        prResult.prNumber,
        ghCommandFn,
      );
      if (mergedResult.ok && mergedResult.value) {
        // Issue #1967: and again after the merge — a sync PR raised in the
        // window between the check above and this one is exactly the PR
        // GitHub has just retargeted onto the default branch.
        await retireMilestoneSyncPrs({
          repo,
          milestoneBranch,
          ghCommandFn,
          log,
          reason:
            `the final PR #${prResult.prNumber} for milestone '${milestone.title}' ` +
            `has merged`,
        });
        await closeGitHubMilestone(repo, milestone.number, ghCommandFn, log);
      }
    }
  }

  // Issue #2835 (part of #2794): break any cross-milestone dependency
  // deadlock left standing after the pass above. A deadlocked milestone
  // always has open children, so its full rollup can never be raised — the
  // partial rollup lands the work already merged into the milestone branch
  // without waiting for the deadlock to clear. A failure here never aborts
  // the repo scan; it is reported and the next iteration retries.
  try {
    await raiseDeadlockPartialRollups({
      repo,
      defaultBranch,
      openMilestones: milestones.map((m) => m.title),
      ghCommandFn,
      log,
      cache,
      ...(authorOptions !== undefined ? { authorOptions } : {}),
      armCreatedPr: async (prUrl, snapshotBranch) => {
        const prNumber = summaryPrNumberFromUrl(prUrl);
        if (prNumber === null) {
          log(
            `WARNING: could not read a PR number from '${prUrl.trim()}' — ` +
              `the partial rollup PR was not armed for auto-merge; the ` +
              `Auto-Merge sweep retries`,
          );
          return;
        }
        // Issue #2835: the head passed here is the snapshot branch
        // (`partial-rollup/...`), NOT the milestone branch — the #3909
        // open-children gate refuses a `milestone/` head with open
        // children, and a deadlocked milestone always has open children.
        // The #4375 base-protection gate still applies as normal.
        await armSummaryPrAutoMerge(
          repo,
          prNumber,
          snapshotBranch,
          defaultBranch,
          ghCommandFn,
          log,
          {
            ...arming,
            ...(authorOptions !== undefined ? { authorOptions } : {}),
          },
          "partial rollup PR",
        );
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: milestone deadlock scan failed for ${repo}: ${message} (Issue #2835)`,
    );
  }
}
