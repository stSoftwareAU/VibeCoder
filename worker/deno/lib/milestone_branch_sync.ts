/**
 * Periodic milestone branch sync with default branch (Issue #1238).
 *
 * Proactively merges the default branch into active milestone branches
 * to reduce drift and avoid merge conflicts on the final summary PR.
 *
 * Every open milestone whose branch exists is swept on every cycle in which
 * the default-branch tip moved (Issue #1776): the cadence is one comparison
 * between the tip git reports and the tip the branch was last successfully
 * synced against. There is no cooldown and no closed-issue gate — a milestone
 * that has completed nothing still drifts. The sync is best-effort — failures
 * are logged but do not block other work.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import { isIdleTaskMilestone } from "./idle_task_merge_gate.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import type { RepoLease } from "./maintenance_lane.ts";
import type { SyncClaim } from "./milestone_sync_claim.ts";
import { validateGitHubMilestonesJson } from "./validation.ts";
import {
  buildMergeGateEscalationComment,
  isMergeGateFailure,
} from "./milestone_merge_gate.ts";
import {
  buildConflictEscalationComment,
  describeBranchTips,
  type MilestoneSyncConflict,
  type MilestoneSyncOutcome,
  resolveBranchTips,
  UNRESOLVED_SHA,
} from "./milestone_sync_conflict.ts";
import {
  buildConflictAnalysisComment,
  type FileAnalysis,
  type FileDecision,
  isConflictEscalation,
} from "./milestone_conflict_triage.ts";
import {
  conflictEscalationKey,
  conflictEscalationMarker,
  hasConflictEscalationComment,
} from "./milestone_conflict_dedup.ts";
import {
  DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS,
  DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT,
} from "./merge_conflict_drain.ts";
import { isRuleViolationPush } from "./milestone_sync_pr.ts";
import {
  type MilestoneEscalationTarget,
  resolveMilestoneEscalationTarget,
} from "./milestone_escalation_target.ts";
import { closeResolvedSyncDiagnostics } from "./milestone_sync_diagnostic_closeout.ts";
import { closeLandedMilestoneSyncPrs } from "./milestone_sync_pr_retirement.ts";
import {
  concludeConflictAttempt,
  type ConflictAttemptOutcome,
  type ConflictAttemptRecord,
  isConflictAttemptDue,
  isConflictBudgetExhausted,
  isRepeatedFailureReason,
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  openConflictAttempt,
  recordDefaultSha,
  resetConflictLedgerOnSuccess,
  saveSyncStreaks,
  type SyncStreakEntry,
  syncStreakKey,
  type SyncStreaks,
  trackingIssueFromMilestoneTitle,
} from "./milestone_sync_streak.ts";
import { executeRollback, type RollbackOutcome } from "./milestone_rollback.ts";
import {
  escalateRollbackFailure,
  requeueRolledBackChildren,
} from "./milestone_rollback_requeue.ts";

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

/**
 * Function signature for syncing a milestone branch with the default branch.
 *
 * The outcome carries the conflict when the merge had one (Issue #1558), so
 * a resolution that favoured the default branch is escalated the same day
 * rather than discovered at rollup time.
 */
export type SyncBranchFn = (
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
  options: SyncBranchOptions,
) => Promise<Result<MilestoneSyncOutcome>>;

/** What the cycle allows one sync attempt to do (Issue #1778). */
export interface SyncBranchOptions {
  /**
   * Whether this attempt may climb the ladder's agent rung.
   *
   * False once the cycle's single agent run has been spent, and false when
   * too little of the handler's budget remains to cover one. A sync given
   * `false` climbs the triage and the deterministic rules and stops there.
   */
  agentAllowed: boolean;
  /**
   * Seconds the agent may run, sized to the budget that is actually left
   * (Issue #1693).
   *
   * Absent means "keep the configured timeout" — the pass stated no deadline
   * or no agent timeout, so there is nothing to shrink it to. Present, it is
   * never more than the handler has: an agent promised more time than the
   * cycle holds is an agent the watchdog kills mid-edit, and that kill is the
   * shape this whole bound exists to stop repeating.
   */
  agentTimeoutSeconds?: number;
}

/** What a branch that has spent its conflict budget is handed to. */
export interface MilestoneRollbackRequest {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The milestone branch that cannot be merged into. */
  milestoneBranch: string;
  /** The default branch it conflicts with. */
  defaultBranch: string;
  /** Concluded conflict failures the branch has spent. */
  attempts: number;
  /** The last attempt's reason, so the hand-off says what it tripped on. */
  reason: string;
  /** Milestone title, so the re-queue notice can find the parent issue. */
  milestoneTitle: string;
  /** GitHub milestone number, for the oldest-child fallback. */
  milestoneNumber: number;
  /** Paths the last conflict named, when they are known. */
  conflictingPaths?: string[];
  /** Child PRs a previous roll-back already reverted. */
  alreadyReverted?: number[];
}

/**
 * Hand a branch whose conflict budget is exhausted to the roll-back
 * (Issue #1778).
 *
 * A branch that has spent every automatic attempt is rolled back, not
 * escalated: the merged children that touch the conflicting files are
 * reverted until the default branch merges cleanly (Issue #1771). Injected,
 * because the sync pass owns *when* that happens and the roll-back owns
 * *how* — and until the wiring lands the default says so in the log rather
 * than posting anything.
 */
export type MilestoneRollbackFn = (
  request: MilestoneRollbackRequest,
) => Promise<RollbackOutcome | void>;

/**
 * Git runner the wired roll-back uses in the repo's clone
 * (Issue #1781). `args` are the git arguments after the binary.
 */
export type RollbackGitFn = (
  repo: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Function signature for checking whether a repository has been cloned
 * locally (Issue #1519). Milestone sync is a local-git operation; if the
 * repo has never been cloned in this environment, the sync must be
 * skipped rather than reported as a failure.
 */
export type LocalCloneExistsFn = (repo: string) => Promise<boolean>;

/**
 * Function signature for reading the default branch's tip as local git sees
 * it (Issue #1776).
 *
 * The cadence gate spends this instead of an API call: `git rev-parse` after
 * the fetch that makes the ref current. A failure carries the reason git gave
 * — the gate then logs it and syncs, rather than reading an unknown tip as
 * "unchanged".
 */
export type DefaultTipShaFn = (
  repo: string,
  defaultBranch: string,
) => Promise<Result<string>>;

/** An active milestone discovered from the GitHub API. */
export interface ActiveMilestone {
  /** The milestone title (e.g., "v1.0"). */
  milestoneTitle: string;
  /**
   * The GitHub milestone number (the API id, not the title). An escalation
   * with no parent planning issue reads the milestone's open children through
   * it (Issue #1769).
   */
  milestoneNumber: number;
  /** The derived milestone branch name (e.g., "milestone/v1-0"). */
  milestoneBranch: string;
  /** The repository's default branch (e.g., "main", "Develop"). */
  defaultBranch: string;
}

/** Dependencies for the milestone branch sync orchestration. */
export interface MilestoneBranchSyncDeps {
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
  /** Function to sync a milestone branch with the default branch. */
  syncBranchFn: SyncBranchFn;
  /**
   * Optional reader for the default branch's local tip (Issue #1776). When
   * supplied, a milestone whose branch was last synced against this very tip
   * is skipped; when omitted, or when it cannot read the tip, every milestone
   * is synced.
   */
  defaultTipShaFn?: DefaultTipShaFn;
  /**
   * Optional check for whether the repo has a local clone (Issue #1519).
   * When supplied and it returns `false`, the repo is skipped with no
   * sync attempt — git commands against a non-existent working directory
   * would otherwise be reported as a sync failure.
   */
  localCloneExistsFn?: LocalCloneExistsFn;
  /** Logging function. */
  log: (message: string) => void;
  /**
   * Lease a repository's shared clone for the duration of its sync
   * (Issue #2030). `null` means an issue slot holds it and the repository
   * is deferred to the next cycle. Omitted means nothing runs concurrently.
   */
  leaseRepoFn?: (repo: string) => RepoLease | null;
  /**
   * Take the cross-host claim for a branch before syncing it (Issue #2030).
   * `held-elsewhere` skips the branch this cycle without opening an
   * attempt; `unknown` proceeds as if there were no claim. Omitted means
   * no claim is taken.
   */
  claimSyncFn?: (repo: string, milestoneBranch: string) => Promise<SyncClaim>;
  /** Release the claim once the sync concluded; best-effort. */
  releaseSyncClaimFn?: (repo: string, milestoneBranch: string) => Promise<void>;
  /**
   * Optional self-heal event sink (Issue #4260). Production wires
   * `emitSelfHealEventAuto` so every failed sync leaves a forensic
   * record; when omitted (tests), nothing is written.
   */
  emitSelfHealEvent?: (event: {
    module: string;
    action: string;
    reason: string;
    result: "ok" | "skipped" | "failed";
  }) => Promise<boolean>;
  /**
   * Path of the per-branch failure-streak file (Issue #4260, proposal 2).
   * When set, a branch that fails to sync for
   * {@link MILESTONE_SYNC_ESCALATION_THRESHOLD} consecutive cycles gets a
   * single needs-human comment on its tracking issue, and a success clears
   * the streak. Unset (tests, ad hoc callers): no streak tracking.
   */
  streakPath?: string;
  /**
   * Fleet-identity inputs for the diagnostic close-out (Issue #1769). Omitted
   * (production) means "read the configured fleet identity"; a test states
   * the fleet instead of writing a config file.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  /**
   * Watchdog deadline of the handler this sweep runs inside (Issue #1778).
   *
   * The cycle's single agent rung is only offered while the budget left
   * covers a whole agent run plus the work around it. Omitted means the pass
   * is unbounded, and the rung is offered on its own merits.
   */
  deadlineEpochMs?: number;
  /**
   * The agent timeout one conflict resolution would be granted, in
   * milliseconds (Issue #1778). Defaults to the merge-conflict drain's own
   * floor, {@link DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT}.
   */
  agentTimeoutMs?: number;
  /**
   * Budget reserved for everything a resolution does outside the agent —
   * the fetch, the merge, the gates, the push. Defaults to
   * {@link DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS}.
   */
  attemptOverheadMs?: number;
  /**
   * Agent time that must remain before an agent rung is started at all.
   * Defaults to the drain's own {@link DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT}.
   */
  minMsPerAgentAttempt?: number;
  /** Clock seam (epoch milliseconds); defaults to `Date.now`. */
  now?: () => number;
  /**
   * Where a branch that has spent its conflict budget is handed
   * (Issue #1778). Defaults to {@link executeRollback} when
   * {@link rollbackGitFn} is set, otherwise one log line.
   */
  rollbackFn?: MilestoneRollbackFn;
  /**
   * Git in the repo's clone, used by the default roll-back to run
   * {@link executeRollback} (Issue #1781). Omitted (most tests): the
   * default stays the "not yet available" log line.
   */
  rollbackGitFn?: RollbackGitFn;
}

// ---------------------------------------------------------------------------
// The conflict ledger's decisions, as pure functions (Issue #1778)
// ---------------------------------------------------------------------------

/** The ladder rung a conflict failure got as far as. */
export type ConflictLadderRung = "triage" | "rules" | "agent";

/** What the ledger records for one failed sync. */
export interface ConflictConclusion {
  /** How the attempt concluded; only `failed` spends the budget. */
  outcome: ConflictAttemptOutcome;
  /** One line naming what it tripped on. */
  reason: string;
  /** The rung that could not decide, when the failure was a conflict. */
  rung?: ConflictLadderRung;
}

/**
 * What the cycle may grant one conflict resolution's agent rung
 * (Issue #1778).
 *
 * The merge-conflict drain's shape, spending the drain's own constants and
 * both halves of its rule (`merge_conflict_drain.ts`):
 *
 * - **A floor.** An agent run is not started at all unless the budget left,
 *   less what the resolution spends outside the agent, still covers
 *   {@link DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT}. Ten minutes was enough to
 *   *start* the resolution killed mid-edit on NEAT-AI-core#637 and never
 *   enough to finish it (Issue #1693).
 * - **A clamp.** What is granted is never more than that budget, so an agent
 *   that runs to its full grant still has room to conclude rather than being
 *   killed on the way there. Gating on the *configured* timeout instead would
 *   refuse the rung on every cycle a run's remaining budget is shorter than
 *   `claudeTimeout` — which is almost all of them — and silently disable the
 *   ladder's last rung.
 *
 * A pass with no deadline is unbounded: the rung is allowed and the agent
 * keeps its configured timeout.
 *
 * @param opts.deadlineEpochMs - The handler's watchdog deadline, when it has one
 * @param opts.nowMs - Current time in epoch milliseconds
 * @param opts.agentTimeoutMs - The agent timeout a resolution would otherwise get
 * @param opts.attemptOverheadMs - Budget the resolution spends outside the agent
 * @param opts.minMsPerAttempt - Agent time that must remain to start one at all
 */
export function grantAgentRun(opts: {
  deadlineEpochMs?: number;
  nowMs: number;
  agentTimeoutMs?: number;
  attemptOverheadMs?: number;
  minMsPerAttempt?: number;
}): SyncBranchOptions {
  if (opts.deadlineEpochMs === undefined) return { agentAllowed: true };
  const overhead = opts.attemptOverheadMs ??
    DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS;
  const floor = opts.minMsPerAttempt ?? DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT;
  const attemptBudgetMs = opts.deadlineEpochMs - opts.nowMs - overhead;
  if (attemptBudgetMs < floor) return { agentAllowed: false };
  if (opts.agentTimeoutMs === undefined) return { agentAllowed: true };
  return {
    agentAllowed: true,
    // Never below a second: a nonsense bound must not become a nonsense
    // grant. The floor above already guarantees a sane value.
    agentTimeoutSeconds: Math.max(
      1,
      Math.floor(Math.min(opts.agentTimeoutMs, attemptBudgetMs) / 1000),
    ),
  };
}

/**
 * Whether another conflict-resolution attempt is due for this branch
 * (Issue #1778).
 *
 * The ledger's own rule ({@link isConflictAttemptDue}) with one guard around
 * it: a tip git could not read is never allowed to look like a *moved* tip.
 * Reading an unknown tip as "the conflict is a different one now" would hand
 * the branch straight back every cycle and spend the whole budget inside one
 * cooldown, so with no tip to compare only the deferral decides.
 *
 * @param entry - The branch's ledger entry, or undefined when it has none
 * @param defaultSha - The default branch's tip now, or undefined if unknown
 * @param nowMs - Current time in epoch milliseconds
 */
export function conflictAttemptDue(
  entry: SyncStreakEntry | undefined,
  defaultSha: string | undefined,
  nowMs: number,
): boolean {
  if (!entry) return true;
  // Falling back to the branch's own last tip says "it has not moved", which
  // is the conservative reading of a tip nobody could read.
  const tip = defaultSha ?? entry.lastAttempt?.defaultSha ?? "";
  return isConflictAttemptDue(entry, tip, nowMs);
}

/**
 * The rung a conflict failure got as far as, read from the reasons the
 * escalation carries (Issue #1778).
 *
 * Each rung of the ladder writes its own prefix into the reason it leaves on
 * an undecided file, so the reasons are the record of how far the merge got —
 * there is no second field to keep in step with them.
 *
 * @param reasons - The escalated files' reasons, as the ladder wrote them
 */
export function failedConflictRung(
  reasons: readonly string[],
): ConflictLadderRung {
  if (reasons.some((reason) => reason.includes("agent:"))) return "agent";
  if (
    reasons.some((reason) =>
      reason.includes("no resolution agent was available")
    )
  ) {
    return "rules";
  }
  return "triage";
}

/**
 * Judge a failed sync against the branch's conflict budget (Issue #1778).
 *
 * Only a conflict every automatic rung reached and none could settle is the
 * branch's to answer for. A gate that refused the tree or the resolution, a
 * push a repository ruleset declined, and an ordinary git failure are all
 * conclusions the branch is not charged for — each keeps whatever reporting
 * it already had. So is a conflict on a branch that was never offered the
 * agent this cycle: charging it would spend an attempt on a rung it never
 * climbed.
 *
 * @param error - The failure the sync returned
 * @param agentAllowed - Whether this attempt was offered the agent rung
 */
export function judgeSyncFailure(
  error: Error,
  agentAllowed: boolean,
): ConflictConclusion {
  if (isConflictEscalation(error)) {
    if (error.gateFailure) {
      return {
        outcome: "not-charged",
        reason: "the merge gate refused the resolution",
      };
    }
    const rung = failedConflictRung(error.analyses.map((a) => a.reason));
    return agentAllowed
      ? {
        outcome: "failed",
        reason: `conflict unresolved at rung ${rung}`,
        rung,
      }
      : {
        outcome: "not-charged",
        reason: "agent deferred: cycle budget",
        rung,
      };
  }
  if (isMergeGateFailure(error)) {
    return {
      outcome: "not-charged",
      reason: "the merge gate refused the merged tree",
    };
  }
  if (isRuleViolationPush(error.message)) {
    return { outcome: "not-charged", reason: "push rejected by ruleset" };
  }
  const firstLine = error.message.split("\n")[0]!.trim();
  return {
    outcome: "not-charged",
    reason: `non-conflict git failure: ${firstLine}`,
  };
}

/**
 * The default hand-off for an exhausted budget (Issue #1778): one log line,
 * and nothing posted to anyone.
 *
 * The roll-back that belongs here is Issue #1771's, and it is wired by the
 * sub-issue that lands it. Until then the branch's state is loud in the log
 * rather than quietly reported as an ordinary failure — and it is still not
 * a `needs-human` label or a diagnostic issue, which is the whole point of
 * the budget.
 */
function isRollbackOutcome(
  value: RollbackOutcome | void,
): value is RollbackOutcome {
  return value !== undefined && typeof value === "object" &&
    typeof value.merged === "boolean" && Array.isArray(value.reverted);
}

/**
 * Apply a roll-back's GitHub half and update the ledger (Issue #1781).
 *
 * `merged: true` resets the budget, increments `rollbacks`, records the
 * reverted SHAs and re-queues the children. `merged: false` escalates
 * once — `needs-human` on the existing target — and leaves the budget spent.
 */
async function applyRollbackOutcome(opts: {
  repo: string;
  milestone: ActiveMilestone;
  entry: SyncStreakEntry;
  outcome: RollbackOutcome;
  attempts: number;
  ghCommandFn: GhCommandFn;
  log: (message: string) => void;
  emitSelfHealEvent?: MilestoneBranchSyncDeps["emitSelfHealEvent"];
}): Promise<SyncStreakEntry> {
  const { repo, milestone, outcome, attempts, ghCommandFn, log } = opts;
  let entry = opts.entry;

  if (outcome.merged) {
    const nextRollbacks = (entry.rollbacks ?? 0) + 1;
    entry = resetConflictLedgerOnSuccess(entry);
    entry.rollbacks = nextRollbacks;
    const prs = new Set(entry.revertedPrs ?? []);
    const shas = new Set(entry.revertedShas ?? []);
    for (const child of outcome.reverted) {
      prs.add(child.prNumber);
      if (child.sha) shas.add(child.sha);
    }
    entry.revertedPrs = [...prs];
    entry.revertedShas = [...shas];
    await requeueRolledBackChildren({
      repo,
      milestoneTitle: milestone.milestoneTitle,
      milestoneNumber: milestone.milestoneNumber,
      milestoneBranch: milestone.milestoneBranch,
      defaultBranch: milestone.defaultBranch,
      rollbacks: nextRollbacks,
      attempts,
      reverted: outcome.reverted,
      ghCommandFn,
      log,
    });
    await opts.emitSelfHealEvent?.({
      module: "milestone_branch_sync",
      action: "rolled_back",
      reason: `${repo} branch ${milestone.milestoneBranch}: reverted ` +
        `${outcome.reverted.map((c) => `#${c.prNumber}`).join(",") || "none"}`,
      result: "ok",
    }).catch(() => undefined);
    return entry;
  }

  const escalation = await escalateRollbackFailure({
    repo,
    milestoneTitle: milestone.milestoneTitle,
    milestoneNumber: milestone.milestoneNumber,
    milestoneBranch: milestone.milestoneBranch,
    defaultBranch: milestone.defaultBranch,
    reason: outcome.reason ?? "roll-back did not merge",
    alreadyEscalated: entry.escalated === true,
    ghCommandFn,
    log,
  });
  if (escalation.countedAsEscalated) entry.escalated = true;
  await opts.emitSelfHealEvent?.({
    module: "milestone_branch_sync",
    action: "rollback_failed",
    reason: `${repo} branch ${milestone.milestoneBranch}: ${
      outcome.reason ?? "roll-back did not merge"
    }`,
    result: "failed",
  }).catch(() => undefined);
  return entry;
}

function defaultRollbackFn(
  log: (message: string) => void,
  gitFn?: RollbackGitFn,
  ghCommandFn?: GhCommandFn,
): MilestoneRollbackFn {
  return async (request) => {
    if (gitFn === undefined) {
      log(
        `WARNING: Milestone branch '${request.milestoneBranch}' in ` +
          `${request.repo}: budget exhausted: roll-back not yet available — ` +
          `${request.attempts} concluded conflict failure(s), last: ` +
          `${request.reason} (Issue #1778)`,
      );
      return;
    }
    try {
      await prepareRollbackWorktree(gitFn, request);
    } catch (err) {
      return {
        merged: false,
        reverted: [],
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    const outcome = await executeRollback({
      repo: request.repo,
      milestoneBranch: request.milestoneBranch,
      defaultBranch: request.defaultBranch,
      git: (args) => gitFn(request.repo, args),
      gh: ghCommandFn ?? ((args) =>
        Promise.reject(
          new Error(`gh is not wired for roll-back: ${args.join(" ")}`),
        )),
      log,
      ...(request.conflictingPaths !== undefined
        ? { conflictingPaths: request.conflictingPaths }
        : {}),
      ...(request.alreadyReverted !== undefined
        ? { alreadyReverted: request.alreadyReverted }
        : {}),
    });
    if (!outcome.ok) {
      return {
        merged: false,
        reverted: [],
        reason: outcome.error.message,
      };
    }
    return outcome.value;
  };
}

/** Reset a leftover merge and check the milestone branch out. */
async function prepareRollbackWorktree(
  gitFn: RollbackGitFn,
  request: MilestoneRollbackRequest,
): Promise<void> {
  await gitFn(request.repo, ["merge", "--abort"]);
  const checkout = await gitFn(request.repo, [
    "checkout",
    "-B",
    request.milestoneBranch,
    `origin/${request.milestoneBranch}`,
  ]);
  if (checkout.code !== 0) {
    throw new Error(
      `Could not check out '${request.milestoneBranch}' for roll-back: ` +
        `${checkout.stderr || checkout.stdout} (Issue #1781)`,
    );
  }
}

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

/** Result of the milestone branch sync orchestration. */
export interface MilestoneSyncResult {
  /** Number of milestone branches successfully synced. */
  synced: number;
  /** Number of milestone branches skipped (tip unchanged or branch missing). */
  skipped: number;
  /** Number of milestone branches that failed to sync. */
  failed: number;
}

/** A GitHub milestone from the API. */
interface GitHubMilestone {
  title: string;
  number: number;
}

// ---------------------------------------------------------------------------
// findActiveMilestoneBranches
// ---------------------------------------------------------------------------

/**
 * Find the milestones this repository's sync covers.
 *
 * Every OPEN milestone counts (Issue #1776) — the closed-issue query that
 * once decided whether work had "started" is gone. A milestone with nothing
 * closed yet still accumulates drift against a default branch taking ~27
 * commits a day, and it was exactly the milestone the old gate never swept.
 * Branch existence is checked by the caller, on the cycle it syncs.
 *
 * The one exclusion stays: an idle-task milestone never carries a branch
 * (Issue #2125).
 *
 * @param repo - Repository in "owner/repo" format
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param defaultBranchFn - Optional cached default-branch resolver
 * @returns Result with list of open milestones
 */
export async function findActiveMilestoneBranches(
  repo: string,
  ghCommandFn: GhCommandFn,
  defaultBranchFn?: DefaultBranchFn,
): Promise<Result<ActiveMilestone[]>> {
  try {
    // Resolve default branch via injected function (Issue #1509). When the
    // caller doesn't pass one — e.g., tests that only mock `ghCommandFn` —
    // fall back to a gh api call so legacy stubs continue to work.
    const resolver = defaultBranchFn ?? makeGhDefaultBranchFn(ghCommandFn);
    const branchResult = await resolver(repo);
    if (!branchResult.ok) {
      return {
        ok: false,
        error: new Error(`Could not determine default branch for ${repo}`),
      };
    }
    const defaultBranch = branchResult.value.trim();
    if (!defaultBranch) {
      return {
        ok: false,
        error: new Error(`Could not determine default branch for ${repo}`),
      };
    }

    // List open milestones — validate at the trust boundary (Issue #1532).
    let milestones: GitHubMilestone[];
    try {
      const output = await ghCommandFn([
        "api",
        `repos/${repo}/milestones`,
      ]);
      const parsed = JSON.parse(output);
      const validated = validateGitHubMilestonesJson(parsed);
      if (!validated.ok) {
        return { ok: true, value: [] }; // Malformed response — skip
      }
      milestones = validated.value;
    } catch {
      return { ok: true, value: [] }; // No milestones or API failure
    }

    const activeMilestones: ActiveMilestone[] = [];

    for (const milestone of milestones) {
      // Issue #2125: idle-task milestones never carry a milestone
      // branch — the security-scan template files findings as
      // standalone issues. Skip them so the branch-existence check
      // does not burn an API call per iteration.
      if (isIdleTaskMilestone(milestone.title)) {
        continue;
      }

      activeMilestones.push({
        milestoneTitle: milestone.title,
        milestoneNumber: milestone.number,
        milestoneBranch: createMilestoneBranchName(milestone.title),
        defaultBranch,
      });
    }

    return { ok: true, value: activeMilestones };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to find active milestones for ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// shouldSyncMilestone
// ---------------------------------------------------------------------------

/**
 * Determine whether a milestone branch has anything to merge down
 * (Issue #1776).
 *
 * The question the old cooldown answered was "has enough time passed?", which
 * on a default branch taking ~27 commits a day meant a branch sat up to an
 * hour behind for no reason. The question now is the only one that matters:
 * has the default tip moved since the last **successful** sync of this
 * branch? A failure records nothing, so a failed sync is retried on the next
 * cycle rather than waited out.
 *
 * A tip git could not report is never read as "unchanged" — an unreadable
 * tip would otherwise silently park the branch for ever.
 *
 * @param entry - The branch's ledger entry, or undefined when it has none
 * @param defaultSha - The default branch's tip now, or undefined if unknown
 * @returns true if sync should proceed
 */
export function shouldSyncMilestone(
  entry: SyncStreakEntry | undefined,
  defaultSha: string | undefined,
): boolean {
  if (!defaultSha) return true;
  return entry?.lastSyncedDefaultSha !== defaultSha;
}

/**
 * Read the default branch's tip for the cadence gate (Issue #1776).
 *
 * A tip that cannot be read is reported and returned as `undefined`, which
 * the gate treats as "sync it" — reading an unreadable tip as "unchanged"
 * would park every milestone branch silently, the failure mode this sweep
 * exists to prevent.
 */
async function readDefaultTip(
  repo: string,
  defaultBranch: string,
  defaultTipShaFn: DefaultTipShaFn | undefined,
  log: (message: string) => void,
): Promise<string | undefined> {
  if (!defaultTipShaFn) return undefined;
  let reason: string;
  try {
    const tip = await defaultTipShaFn(repo, defaultBranch);
    if (tip.ok) return tip.value;
    reason = tip.error.message;
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  log(
    `WARNING: Could not read the tip of '${defaultBranch}' in ${repo} ` +
      `(${reason}) — every milestone branch is synced this cycle ` +
      `(Issue #1776)`,
  );
  return undefined;
}

/**
 * Record a successful sync against the branch's ledger entry (Issue #1776).
 *
 * Exported so the child run's pre-cut sync concludes a landed merge through
 * this very function (Issue #1780) rather than a second, subtly different
 * transition: two writers of one ledger must agree about what success does.
 *
 * Success is the only thing that writes `lastSyncedDefaultSha`, so a failure
 * leaves the previous tip in place and the next cycle tries again. The
 * failure streak ends here (Issue #4260); the reported-conflict marker and
 * the synced tip are what survive it.
 *
 * @param reportedSha - A conflicting default-branch commit already reported,
 *   when there is one to remember.
 * @returns True when the ledger changed and needs persisting.
 */
export function recordSuccess(
  streaks: SyncStreaks,
  streakKey: string,
  defaultSha: string | undefined,
  reportedSha: string | undefined,
): boolean {
  const existing = streaks[streakKey];

  // What a success does to the conflict budget is the ledger's own rule
  // (Issue #1766): `resetConflictLedgerOnSuccess` zeroes the attempts and
  // drops the open marker and the deferral, while `rollbacks`, `lastAttempt`
  // and the last synced tip survive as history. Restating it here would be a
  // second definition of the same transition.
  const {
    gateEscalated: _gate,
    analysisEscalatedSha: _analysis,
    conflictEscalatedSha: _conflict,
    ...ledger
  } = resetConflictLedgerOnSuccess(existing ?? { count: 0, escalated: false });

  // The failure streak ends here too (Issue #4260), and the escalation flags
  // go with it — a branch that fails again later must be able to report it.
  // Only the reported-conflict marker is carried forward, by the caller.
  let next: SyncStreakEntry = {
    ...ledger,
    count: 0,
    escalated: false,
    ...(reportedSha ? { conflictEscalatedSha: reportedSha } : {}),
  };
  if (defaultSha) next = recordDefaultSha(next, defaultSha);

  // An entry holding nothing but a zeroed streak says nothing worth keeping.
  const worthKeeping = Boolean(
    next.conflictEscalatedSha || next.lastSyncedDefaultSha ||
      next.lastAttempt || next.rollbacks,
  );
  if (!worthKeeping) {
    if (!existing) return false;
    delete streaks[streakKey];
    return true;
  }
  streaks[streakKey] = next;
  return true;
}

// ---------------------------------------------------------------------------
// syncMilestoneBranches (main entry point)
// ---------------------------------------------------------------------------

/**
 * Scan configured repositories and sync active milestone branches with
 * the default branch.
 *
 * This is the main orchestration function, called from the run_core
 * priority dispatch at priority 1.72.
 *
 * For each repo:
 * 1. Read the default branch's tip once, from local git (Issue #1776)
 * 2. Find its open milestones
 * 3. Skip any whose branch was last synced against that very tip
 * 4. Verify the milestone branch exists on the remote
 * 5. Attempt to merge the default branch into the milestone branch
 * 6. On success: push and record the tip it synced against
 * 7. On failure: log a warning and record nothing (do not block other work)
 *
 * @param deps - Injected dependencies
 * @returns Result with sync summary
 */
export async function syncMilestoneBranches(
  deps: MilestoneBranchSyncDeps,
): Promise<Result<MilestoneSyncResult>> {
  const { repos, ghCommandFn, syncBranchFn, localCloneExistsFn, log } = deps;
  const defaultBranchFn = deps.defaultBranchFn ??
    makeGhDefaultBranchFn(ghCommandFn);
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  if (repos.length === 0) {
    return { ok: true, value: { synced: 0, skipped: 0, failed: 0 } };
  }

  // Failure-streak escalation (Issue #4260, proposal 2): a branch that fails
  // to sync for MILESTONE_SYNC_ESCALATION_THRESHOLD consecutive cycles gets
  // one needs-human comment on its tracking issue; a success clears it.
  const streakPath = deps.streakPath;
  const streaks = streakPath ? await loadSyncStreaks(streakPath) : {};
  let streaksDirty = false;

  /**
   * Persist the ledger, best-effort (Issue #1778).
   *
   * Called mid-sweep as well as at the end: an attempt marker that is only
   * in memory when the run is killed is a marker the next cycle never sees,
   * and the attempt nobody judged would then be charged as a failure.
   */
  const persistStreaks = async (): Promise<void> => {
    if (!streakPath || !streaksDirty) return;
    try {
      await saveSyncStreaks(streakPath, streaks);
      streaksDirty = false;
    } catch (err) {
      // The sweep still runs — one repo's other milestones must not be lost
      // over a write — but the failure is said out loud rather than
      // swallowed: an open attempt marker that never reached disk is an
      // attempt the next cycle charges as a failure nobody judged.
      log(
        `WARNING: Could not persist the milestone sync ledger to ` +
          `${streakPath}: ${
            err instanceof Error ? err.message : String(err)
          } — this cycle's attempt markers and conclusions are lost ` +
          `(Issue #1778)`,
      );
    }
  };

  const now = deps.now ?? (() => Date.now());
  const rollbackFn = deps.rollbackFn ??
    defaultRollbackFn(log, deps.rollbackGitFn, ghCommandFn);
  // The cycle's single agent rung, across every repo and every milestone
  // (Issue #1778). Spent by the first branch that actually conflicts while
  // holding it — a branch that merged cleanly asked nothing of the agent.
  let agentSpent = false;

  for (const repo of repos) {
    // Issue #2030: the lane runs beside the issue pool, so the clone is
    // leased for the whole repository pass and given back whatever happens.
    let lease: RepoLease | null | undefined;
    try {
      // Issue #1519: sync is a local-git operation. Skip repos that have
      // not been cloned in this environment — otherwise every git command
      // below fails and is mis-reported as a sync failure.
      if (localCloneExistsFn && !(await localCloneExistsFn(repo))) {
        log(`Skipping milestone sync for ${repo} — no local clone`);
        continue;
      }
      if (deps.leaseRepoFn) {
        lease = deps.leaseRepoFn(repo);
        if (lease === null) {
          log(
            `Skipping milestone sync for ${repo} this cycle — an issue slot ` +
              `holds its clone; deferred to the next cycle (Issue #2030)`,
          );
          skipped++;
          continue;
        }
      }

      const milestonesResult = await findActiveMilestoneBranches(
        repo,
        ghCommandFn,
        defaultBranchFn,
      );
      if (!milestonesResult.ok) {
        log(
          `WARNING: Could not find active milestones for ${repo}: ${milestonesResult.error.message}`,
        );
        continue;
      }

      // The cadence signal, read once per repo (Issue #1776): the default
      // branch's tip as local git sees it. No API call — the repo's default
      // branch was resolved above from the 7-day cache, and the tip itself
      // comes from the fetch the sync needs anyway.
      const defaultSha = milestonesResult.value.length > 0
        ? await readDefaultTip(
          repo,
          milestonesResult.value[0]!.defaultBranch,
          deps.defaultTipShaFn,
          log,
        )
        : undefined;

      // Entries now outlive a success because they carry the synced tip
      // (Issue #1776), so a milestone that has since closed would leave its
      // entry behind for ever. This repo's listing is authoritative about
      // which of its branches are still open, so anything else it owns goes.
      if (streakPath) {
        const live = new Set(
          milestonesResult.value.map((m) =>
            syncStreakKey(repo, m.milestoneBranch)
          ),
        );
        for (const key of Object.keys(streaks)) {
          if (key.startsWith(`${repo}|`) && !live.has(key)) {
            delete streaks[key];
            streaksDirty = true;
          }
        }
      }

      for (const milestone of milestonesResult.value) {
        const streakKey = syncStreakKey(repo, milestone.milestoneBranch);

        // Cadence guard (Issue #1776): the branch already carries this tip,
        // so there is nothing to merge down. Checked before the branch probe,
        // so an idle cycle spends no per-milestone API call — only the one
        // REST milestone listing the repo needed anyway.
        if (!shouldSyncMilestone(streaks[streakKey], defaultSha)) {
          log(
            `Skipping sync for '${milestone.milestoneTitle}' in ${repo} — ` +
              `default tip unchanged (${defaultSha!.slice(0, 7)})`,
          );
          skipped++;
          continue;
        }

        // Verify the milestone branch exists on the remote. An EMPTY
        // answer reads as missing too (Issue #4260): a runGh-style
        // ghCommandFn returns "" on failure instead of throwing, and the
        // deleted private-repo-21 milestone/69 branch was "synced" three
        // cycles running because its empty probe passed this check.
        try {
          const probe = await ghCommandFn([
            "api",
            `repos/${repo}/branches/${milestone.milestoneBranch}`,
            "--jq",
            ".name",
          ]);
          if (!probe.trim()) {
            throw new Error("empty branch-probe answer");
          }
        } catch {
          log(
            `Skipping sync for '${milestone.milestoneTitle}' in ${repo} — branch '${milestone.milestoneBranch}' does not exist on remote`,
          );
          skipped++;
          continue;
        }

        // --- The conflict ledger, before the merge (Issue #1778) --------
        // Every conclusion is charged, paced and recorded here, so a branch
        // that keeps conflicting spends a bounded budget instead of an
        // unbounded stream of retries and escalations.
        if (streakPath) {
          let entry = streaks[streakKey] ?? { count: 0, escalated: false };

          // An attempt still open judged nothing: the run died before the
          // conflict was decided. It concludes `disrupted` and is charged
          // nothing, exactly as an unconcluded PR attempt marker is
          // (Issues #395 and #1693).
          if (entry.attemptOpenedAt) {
            entry = concludeConflictAttempt(
              entry,
              "disrupted",
              "the run ended before the conflict was judged",
              defaultSha,
              now(),
            );
            streaks[streakKey] = entry;
            streaksDirty = true;
            log(
              `Milestone sync for '${milestone.milestoneTitle}' in ${repo}: ` +
                `the previous conflict attempt never concluded — recorded ` +
                `as disrupted and not charged (Issue #1778)`,
            );
          }

          // A branch past its budget belongs to the roll-back, not to another
          // merge: without this guard it keeps conflicting every cooldown,
          // charging attempt 4, 5, 6… and re-entering the hand-off each time.
          if (isConflictBudgetExhausted(entry)) {
            log(
              `WARNING: Skipping sync for '${milestone.milestoneTitle}' in ` +
                `${repo} — the conflict budget is spent ` +
                `(${entry.conflictAttempts ?? 0} of ` +
                `${MILESTONE_CONFLICT_ATTEMPT_BUDGET} concluded failures), ` +
                `so '${milestone.milestoneBranch}' is the roll-back's now and ` +
                `no further attempt is made (Issue #1778)`,
            );
            skipped++;
            continue;
          }

          if (!conflictAttemptDue(entry, defaultSha, now())) {
            log(
              `Skipping sync for '${milestone.milestoneTitle}' in ${repo} — ` +
                `skipped: conflict attempt not due until ${entry.deferUntil}`,
            );
            skipped++;
            continue;
          }

          // Opening charges nothing; it is the marker a kill leaves behind.
          streaks[streakKey] = openConflictAttempt(entry, now());
          streaksDirty = true;
          // On disk before the merge, or the marker cannot survive the kill
          // it exists to record.
          await persistStreaks();
        }

        // The cycle's agent rung goes to the first branch that needs it, and
        // only while the handler's budget still covers a whole run.
        // Issue #2030: one host per branch. A sibling's fresh claim means
        // the sync is in hand elsewhere; this host neither opens an attempt
        // nor spends its rung on it. An unreadable claim proceeds as before.
        if (deps.claimSyncFn) {
          const claim = await deps.claimSyncFn(repo, milestone.milestoneBranch);
          if (claim.kind === "held-elsewhere") {
            log(
              `Skipping sync for '${milestone.milestoneTitle}' in ${repo} — ` +
                `another host claimed '${milestone.milestoneBranch}' ` +
                `${Math.round(claim.ageMs / 60000)} min ago (${claim.ref}); ` +
                `deferred to the next cycle (Issue #2030)`,
            );
            if (streakPath && streaks[streakKey]?.attemptOpenedAt) {
              streaks[streakKey] = concludeConflictAttempt(
                streaks[streakKey]!,
                "disrupted",
                "another host holds the sync claim",
                defaultSha,
                now(),
              );
              streaksDirty = true;
            }
            skipped++;
            continue;
          }
          if (claim.kind === "unknown") {
            log(
              `Sync claim for '${milestone.milestoneBranch}' in ${repo} could ` +
                `not be taken or read — proceeding without one: ${claim.reason} ` +
                `(Issue #2030)`,
            );
          } else if (claim.tookOverStale) {
            log(
              `Took over a stale sync claim on '${milestone.milestoneBranch}' ` +
                `in ${repo} (${claim.ref}) (Issue #2030)`,
            );
          }
        }
        const grant = agentSpent ? { agentAllowed: false } : grantAgentRun({
          nowMs: now(),
          ...(deps.deadlineEpochMs !== undefined
            ? { deadlineEpochMs: deps.deadlineEpochMs }
            : {}),
          ...(deps.agentTimeoutMs !== undefined
            ? { agentTimeoutMs: deps.agentTimeoutMs }
            : {}),
          ...(deps.attemptOverheadMs !== undefined
            ? { attemptOverheadMs: deps.attemptOverheadMs }
            : {}),
          ...(deps.minMsPerAgentAttempt !== undefined
            ? { minMsPerAttempt: deps.minMsPerAgentAttempt }
            : {}),
        });
        const agentAllowed = grant.agentAllowed;
        // Spent on hand-out, refunded below only for a merge that had no
        // conflict at all. The bound is "at most one agent run a cycle", so
        // the direction that must never be wrong is over-spending: a merge
        // that failed after the agent ran — a half-applied plan, a leftover
        // marker, a refused commit, a throw — leaves the grant spent rather
        // than handing a second branch a second run.
        if (agentAllowed) agentSpent = true;

        // Attempt sync
        let syncResult: Awaited<ReturnType<SyncBranchFn>>;
        try {
          syncResult = await syncBranchFn(
            repo,
            milestone.milestoneBranch,
            milestone.defaultBranch,
            grant,
          );
        } finally {
          // The claim guards the sync, not the outcome: it is released on
          // every path out so a sibling can take the next attempt.
          if (deps.claimSyncFn && deps.releaseSyncClaimFn) {
            await deps.releaseSyncClaimFn(repo, milestone.milestoneBranch)
              .catch(() => undefined);
          }
        }

        if (syncResult.ok) {
          log(
            `Synced milestone branch '${milestone.milestoneBranch}' in ${repo}: ${syncResult.value.message}`,
          );
          synced++;

          // The branch has synced, so any diagnostic the old escalation path
          // filed for it is describing a condition that is over (Issue #1769).
          await closeResolvedSyncDiagnostics({
            repo,
            milestoneBranch: milestone.milestoneBranch,
            ghCommandFn,
            log,
            ...(deps.dedupAuthors ? { dedupAuthors: deps.dedupAuthors } : {}),
          });

          // Issue #1967: a sync that landed by direct push leaves the sync PR
          // from an earlier cycle open with an empty diff and auto-merge
          // still armed — which is what GitHub later retargets onto the
          // default branch. A PR raised by *this* cycle still carries its
          // merge, so an empty diff is what tells the two apart.
          await closeLandedMilestoneSyncPrs({
            repo,
            milestoneBranch: milestone.milestoneBranch,
            ghCommandFn,
            log,
          });

          // A merge that conflicted still landed, but the resolution favoured
          // the default branch and nobody chose it (Issue #1558). Report it
          // now, while the divergence is one day wide — once per conflicting
          // default-branch commit, so a branch that keeps conflicting against
          // the same commit is not reported every cycle.
          const conflict = syncResult.value.conflict;
          // Refund the grant: nothing collided, so no rung was climbed and
          // the next conflicting branch this cycle may still have the agent.
          if (!conflict && agentAllowed) agentSpent = false;
          if (conflict) {
            // A conflict whose default-branch commit could not be read still
            // needs a dedup key, or the same report goes out every cycle.
            const conflictKey = conflict.defaultSha || UNRESOLVED_SHA;
            let reportedSha = streaks[streakKey]?.conflictEscalatedSha;
            if (reportedSha !== conflictKey) {
              const escalated = await escalateSyncConflict(
                repo,
                milestone,
                conflict,
                ghCommandFn,
                log,
              );
              // Only a report that went out is remembered: an escalation
              // that failed must be retried next cycle, not marked done.
              if (escalated) reportedSha = conflictKey;
            }
            if (
              streakPath &&
              recordSuccess(streaks, streakKey, defaultSha, reportedSha)
            ) {
              streaksDirty = true;
            }
          } else if (
            streakPath &&
            recordSuccess(streaks, streakKey, defaultSha, undefined)
          ) {
            // A clean success ends the failure streak (Issue #4260) and
            // records the tip the branch now carries (Issue #1776).
            streaksDirty = true;
          }
        } else {
          log(
            `WARNING: Failed to sync milestone branch '${milestone.milestoneBranch}' in ${repo}: ${syncResult.error.message}`,
          );
          failed++;
          // Forensic record (Issue #4260): a chronically diverging
          // milestone branch must be visible beyond the scrolling log.
          await deps.emitSelfHealEvent?.({
            module: "milestone_branch_sync",
            action: "sync_failed",
            reason:
              `${repo} branch ${milestone.milestoneBranch}: ${syncResult.error.message}`,
            result: "failed",
          }).catch(() => undefined);
          // Streak escalation (Issue #4260, proposal 2): count consecutive
          // failures and, at the threshold, post one needs-human comment on
          // the milestone's tracking issue.
          let entry: SyncStreakEntry | undefined;
          if (streakPath) {
            entry = streaks[streakKey] ?? { count: 0, escalated: false };
            entry.count++;
            streaks[streakKey] = entry;
            streaksDirty = true;
          }

          const conflictError = isConflictEscalation(syncResult.error)
            ? syncResult.error
            : undefined;

          // A reason that has not changed since the previous cycle is a
          // reason no retry will change (Issue #1964). Read before the
          // conclusion overwrites it.
          let repeatedReason = false;

          // Conclude the ledger attempt this failure ends (Issue #1778).
          if (streakPath && entry) {
            const verdict = judgeSyncFailure(syncResult.error, agentAllowed);
            repeatedReason = isRepeatedFailureReason(
              entry,
              verdict.reason,
              entry.count,
            );
            entry = concludeConflictAttempt(
              entry,
              verdict.outcome,
              verdict.reason,
              conflictError ? conflictError.defaultSha : defaultSha,
              now(),
            );
            streaks[streakKey] = entry;
            streaksDirty = true;
            if (verdict.outcome === "failed") {
              const attempts = entry.conflictAttempts ?? 0;
              if (isConflictBudgetExhausted(entry)) {
                // Every automatic rung has been spent, so the branch is
                // rolled back rather than reported to anyone (Issue #1781).
                const outcome = await rollbackFn({
                  repo,
                  milestoneBranch: milestone.milestoneBranch,
                  defaultBranch: milestone.defaultBranch,
                  attempts,
                  reason: verdict.reason,
                  milestoneTitle: milestone.milestoneTitle,
                  milestoneNumber: milestone.milestoneNumber,
                  ...(conflictError
                    ? {
                      conflictingPaths: [
                        ...conflictError.analyses.map((a) => a.path),
                        ...conflictError.resolved.map((d) => d.path),
                      ],
                    }
                    : {}),
                  ...(entry.revertedPrs !== undefined
                    ? { alreadyReverted: entry.revertedPrs }
                    : {}),
                });
                if (isRollbackOutcome(outcome)) {
                  entry = await applyRollbackOutcome({
                    repo,
                    milestone,
                    entry,
                    outcome,
                    attempts,
                    ghCommandFn,
                    log,
                    emitSelfHealEvent: deps.emitSelfHealEvent,
                  });
                  streaks[streakKey] = entry;
                  streaksDirty = true;
                }
              } else {
                // One line, and nothing posted: an automatic attempt still
                // remains, so no human is asked about it yet.
                log(
                  `WARNING: Milestone branch '${milestone.milestoneBranch}' ` +
                    `in ${repo}: conflict attempt ${attempts} of ` +
                    `${MILESTONE_CONFLICT_ATTEMPT_BUDGET} failed at rung ` +
                    `${verdict.rung} (Issue #1778)`,
                );
              }
            }
          }

          if (conflictError?.gateFailure) {
            // A gate refusal, not a conflict (Issue #1778): the resolution
            // was made and the verification refused it, so it keeps the
            // escalation Issue #1559 gave it — what the gate said AND both
            // sides prepared. Keyed on the conflict itself (Issue #1786),
            // not the default branch's tip: that tip moves every few
            // minutes and would re-report the same refusal every cycle.
            const gateKey = conflictEscalationKey({
              milestoneBranch: milestone.milestoneBranch,
              ...(conflictError.milestoneSha
                ? { milestoneSha: conflictError.milestoneSha }
                : {}),
              files: [
                ...conflictError.analyses.map((a) => a.path),
                ...conflictError.resolved.map((d) => d.path),
              ],
            });
            if (entry && entry.analysisEscalatedSha !== gateKey) {
              const escalated = await escalateConflictAnalysis(
                repo,
                milestone,
                conflictError.analyses,
                conflictError.resolved,
                conflictError.gateFailure,
                gateKey,
                ghCommandFn,
                log,
              );
              if (escalated) entry.analysisEscalatedSha = gateKey;
            }
          } else if (conflictError) {
            // Nothing is posted for a conflict every rung left undecided
            // (Issue #1778): the ledger above records why the branch is
            // still behind, and the budget — not a human — decides when the
            // automatic attempts are over. The per-conflicting-commit
            // analysis escalation keyed on `analysisEscalatedSha` is gone:
            // it fired before any of the three automatic attempts had been
            // spent, which is exactly the "needs-human while a rung remains"
            // this budget removes.
          } else if (isMergeGateFailure(syncResult.error)) {
            // Issue #974: a merged tree the repo's own check rejects is not a
            // transient condition a retry clears — it needs a human now, not
            // after three more cycles of the same refusal. `gateEscalated` is
            // tracked apart from the ordinary streak flag, so a branch that
            // already escalated for a different reason still reports this.
            // Without a streak file there is nowhere to record that the
            // comment was posted, so escalating would repeat every cycle —
            // the loud WARNING log above stands on its own there.
            if (entry && !entry.gateEscalated) {
              const escalated = await escalateMergeGateFailure(
                repo,
                milestone,
                syncResult.error.message,
                ghCommandFn,
                log,
              );
              if (escalated) {
                entry.gateEscalated = true;
              }
            }
          } else if (
            entry && !entry.escalated &&
            (entry.count >= MILESTONE_SYNC_ESCALATION_THRESHOLD ||
              repeatedReason)
          ) {
            // Either the branch has failed for long enough, or it has failed
            // twice for the identical reason — which four more cycles would
            // only repeat (Issue #1964).
            const escalated = await escalateSyncFailure(
              repo,
              milestone,
              entry.count,
              syncResult.error.message,
              ghCommandFn,
              log,
              repeatedReason ? entry.lastAttempt : undefined,
            );
            if (escalated) {
              entry.escalated = true;
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`WARNING: Milestone branch sync failed for ${repo}: ${message}`);
    } finally {
      lease?.release();
    }
  }

  if (synced > 0 || failed > 0) {
    log(
      `Milestone branch sync complete: ${synced} synced, ${skipped} skipped, ${failed} failed (Issue #1238)`,
    );
  }

  await persistStreaks();

  return { ok: true, value: { synced, skipped, failed } };
}

/**
 * Report a sync merge that conflicted, on the cycle it conflicted
 * (Issue #1558).
 *
 * The merge landed — this is not a blocked sync — but the resolution
 * favoured the default branch, so the branch's own version of every
 * conflicting file was replaced by a decision nobody made. Both sides'
 * commits are named so the reader can see what changed on each without
 * reconstructing it days later.
 *
 * Best-effort, and returns true only when the report went out, so the caller
 * remembers the commit it reported and does not repeat it every cycle.
 *
 * Exported so a child run's pre-cut sync reports a conflicted merge through
 * this very function (Issue #1780): a resolution that favoured the default
 * branch must be reported once, whichever pass made it.
 */
export async function escalateSyncConflict(
  repo: string,
  milestone: ActiveMilestone,
  conflict: MilestoneSyncConflict,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<boolean> {
  const tips = await resolveBranchTips(
    repo,
    [
      { branch: milestone.defaultBranch, sha: conflict.defaultSha },
      { branch: milestone.milestoneBranch, sha: conflict.milestoneSha },
    ],
    ghCommandFn,
    log,
  );

  const body = buildConflictEscalationComment({
    repo,
    milestoneBranch: milestone.milestoneBranch,
    defaultBranch: milestone.defaultBranch,
    conflict,
    tips,
  });

  const what = `a conflicting milestone sync merge for ` +
    `'${milestone.milestoneBranch}' (Issue #1558)`;

  // A conflict the worker resolved itself is a report, not an escalation
  // (Issue #1559): with no tracking issue to report it on, the decisions are
  // on the merge commit and in the log. Only a resolution nobody could make
  // goes looking for a human's issue to land on.
  if (
    conflict.resolution === "auto" &&
    trackingIssueFromMilestoneTitle(milestone.milestoneTitle) === null
  ) {
    log(
      `Resolved ${what} in ${repo} automatically; the milestone has no ` +
        `tracking issue, so the reasoning is on the merge commit rather ` +
        `than in a comment.`,
    );
    return true;
  }

  return await escalateToExistingIssue(
    repo,
    milestone,
    body,
    what,
    ghCommandFn,
    log,
  );
}

/**
 * Report a resolution the verification refused (Issues #1559 and #1778).
 *
 * The worker made the resolution and the gate said no, so the reader needs
 * both halves: what the gate said, and the two sides that produced it — what
 * each side exports, what each side tests, and which cases exist on one side
 * only. A wall of `TS2304` on its own decides nothing, which is what made
 * #1542 nearly useless.
 *
 * This is the one survivor of the old per-conflict escalation: a conflict no
 * rung could settle is charged to the ledger and reported to nobody while an
 * automatic attempt remains, but a gate refusal is not a conflict the budget
 * can retry its way out of.
 *
 * Best-effort, and returns true only when the report went out, so the caller
 * marks the streak escalated and does not repeat it every cycle.
 */
async function escalateConflictAnalysis(
  repo: string,
  milestone: ActiveMilestone,
  analyses: FileAnalysis[],
  resolved: FileDecision[],
  /** What the verification said — the half a reader cannot reconstruct. */
  gateFailure: string,
  /** The conflict's own identity, carried as a marker for cross-host dedup. */
  conflictKey: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<boolean> {
  const tips = await resolveBranchTips(
    repo,
    [
      { branch: milestone.defaultBranch },
      { branch: milestone.milestoneBranch },
    ],
    ghCommandFn,
    log,
  );

  const marker = conflictEscalationMarker(conflictKey);
  const body = `${marker}\n${
    buildConflictAnalysisComment({
      repo,
      milestoneBranch: milestone.milestoneBranch,
      defaultBranch: milestone.defaultBranch,
      analyses,
      resolved,
      gateFailure,
    })
  }\n\n${describeBranchTips(tips)}`;

  const what = `a milestone sync resolution the verification refused for ` +
    `'${milestone.milestoneBranch}' (Issues #1559, #1778)`;

  // Issue #1786: each host keeps its own streak file, so the local record
  // alone cannot stop a second host reporting a conflict the first already
  // reported — the marker on the issue is the shared record. It is checked
  // against whichever existing issue the escalation lands on (Issue #1769).
  return await escalateToExistingIssue(
    repo,
    milestone,
    body,
    what,
    ghCommandFn,
    log,
    marker,
  );
}

/**
 * Post one needs-human comment for a merge the gate refused (Issue #974).
 *
 * Best-effort, and returns true only when the comment was posted, so the
 * caller marks the streak escalated and does not repeat it every cycle. The
 * tracking issue is the number the milestone title leads with; without one
 * the refusal still stands — it is only the escalation that has nowhere to
 * go, and the log says so rather than passing over it.
 */
async function escalateMergeGateFailure(
  repo: string,
  milestone: ActiveMilestone,
  reason: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<boolean> {
  // Both sides' commits travel with every sync escalation (Issue #1558), so
  // whoever picks it up can diff each side rather than reconstruct it.
  const tips = await resolveBranchTips(
    repo,
    [
      { branch: milestone.defaultBranch },
      { branch: milestone.milestoneBranch },
    ],
    ghCommandFn,
    log,
  );

  const gateBody = `${
    buildMergeGateEscalationComment({
      repo,
      milestoneBranch: milestone.milestoneBranch,
      defaultBranch: milestone.defaultBranch,
      reason,
    })
  }\n\n${describeBranchTips(tips)}`;

  return await escalateToExistingIssue(
    repo,
    milestone,
    gateBody,
    `a refused milestone sync merge for '${milestone.milestoneBranch}' ` +
      `(Issue #974)`,
    ghCommandFn,
    log,
  );
}

/**
 * Post one escalation comment where a human will see it (Issue #1769).
 *
 * The destination is an issue that already exists — the milestone's parent
 * planning issue, reopened when planning has closed it, else its oldest open
 * child. Filing a fresh `needs-human` issue is no longer one of the outcomes:
 * that path produced one issue per branch and per conflicting commit, and
 * nothing ever closed them.
 *
 * A milestone with neither destination gets one log line and counts as
 * escalated, so the line is written once rather than every cycle. A comment
 * that could not be posted counts as NOT escalated, so it is retried.
 *
 * @param what - Names the escalation in the log lines.
 * @param dedupMarker - Hidden marker identifying this escalation, when the
 *   caller has one; a destination that already carries it is not commented on
 *   again, and is not reopened either (Issue #1786). Another host's streak
 *   file is invisible here, so the marker on the issue is the shared record.
 *   Fails open — an unreadable thread is reported again.
 * @returns True when the escalation reached a human, or had nowhere to go.
 */
async function escalateToExistingIssue(
  repo: string,
  milestone: ActiveMilestone,
  body: string,
  what: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  dedupMarker?: string,
): Promise<boolean> {
  const target: MilestoneEscalationTarget =
    await resolveMilestoneEscalationTarget({
      repo,
      milestone: {
        title: milestone.milestoneTitle,
        number: milestone.milestoneNumber,
      },
      ghCommandFn,
      log,
      ...(dedupMarker !== undefined
        ? {
          alreadyEscalated: (issueNumber: number) =>
            hasConflictEscalationComment({
              repo,
              issueNumber,
              marker: dedupMarker,
              ghCommandFn,
              log,
            }),
        }
        : {}),
    });

  if (target.kind === "already-escalated") {
    log(
      `Skipped escalating ${what} in ${repo}: issue #${target.issue} already ` +
        `carries this conflict's analysis.`,
    );
    return true;
  }

  if (target.kind === "none") {
    log(
      `No open issue to carry ${what} in ${repo}: the milestone has no ` +
        `parent planning issue and no open children, so the failure stands ` +
        `in this log and no issue is filed for it (Issue #1769).`,
    );
    return true;
  }

  const preamble = target.kind === "parent" && target.reopened
    ? `_Reopened by the milestone branch sync: \`${milestone.milestoneBranch}\` ` +
      `needs a human, and this is the milestone's own planning issue ` +
      `(Issue #1769)._\n\n`
    : "";

  return await postEscalationComment(
    repo,
    target.issue,
    `${preamble}${body}`,
    ghCommandFn,
    log,
    what,
  );
}

/**
 * Post one escalation comment on an existing issue, best-effort.
 *
 * Shared by every milestone-sync escalation so there is one place that knows
 * how the comment is posted and how a failure to post it is reported. Returns
 * true only when the comment went out, so a caller marks its streak escalated
 * and does not repeat it every cycle.
 *
 * @param what - Names the escalation in both log lines
 */
async function postEscalationComment(
  repo: string,
  issueNumber: number,
  body: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  what: string,
): Promise<boolean> {
  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
    log(`Escalated ${what} in ${repo} to issue #${issueNumber}.`);
    return true;
  } catch (err) {
    log(
      `Failed to post the escalation for ${what} in ${repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Post one needs-human comment on a chronically-failing milestone branch's
 * tracking issue (Issue #4260, proposal 2). Best-effort: returns true only
 * when the comment was posted, so the caller marks the streak escalated and
 * does not repeat it every cycle. The tracking issue is the number the
 * milestone title leads with; without one there is nowhere to escalate.
 */
async function escalateSyncFailure(
  repo: string,
  milestone: ActiveMilestone,
  failureCount: number,
  reason: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  /**
   * The previous cycle's concluded attempt, when this cycle's reason is
   * identical to it (Issue #1964). Absent on an ordinary streak escalation.
   */
  repeatedAttempt?: ConflictAttemptRecord,
): Promise<boolean> {
  // Ahead/behind counts, best-effort via one REST compare (only on the rare
  // escalation, not per cycle). base...head reports how far head has diverged.
  let aheadBehind = "";
  try {
    const out = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${milestone.defaultBranch}...${milestone.milestoneBranch}`,
      "--jq",
      '"\\(.ahead_by) ahead, \\(.behind_by) behind"',
    ]);
    if (out.trim()) {
      aheadBehind = ` (${out.trim()} vs ${milestone.defaultBranch})`;
    }
  } catch {
    // Compare is a nicety; the comment stands without it.
  }

  const tips = await resolveBranchTips(
    repo,
    [
      { branch: milestone.defaultBranch },
      { branch: milestone.milestoneBranch },
    ],
    ghCommandFn,
    log,
  );

  const body = `## Milestone branch sync is stuck — needs a human\n\n` +
    `\`${milestone.milestoneBranch}\` has failed to sync with ` +
    `\`${milestone.defaultBranch}\` for ${failureCount} consecutive cycles` +
    `${aheadBehind}.\n\n` +
    `Latest reason from git:\n\n> ${reason}\n\n` +
    `${
      repeatedAttempt
        ? `That reason is **identical** to the previous cycle's, so a retry ` +
          `changes nothing — this is escalated on the second occurrence ` +
          `rather than after four (Issue #1964). The previous cycle ` +
          `concluded \`${repeatedAttempt.outcome}\` at ` +
          `${repeatedAttempt.at}${
            repeatedAttempt.defaultSha
              ? `, merging from \`${repeatedAttempt.defaultSha}\``
              : ""
          }:\n\n> ${repeatedAttempt.reason}\n\n`
        : ""
    }` +
    `${describeBranchTips(tips)}\n\n` +
    `The worker will keep retrying but cannot resolve this itself. Once the ` +
    `branch syncs, this escalation clears automatically (Issue #4260).`;

  const what =
    `stuck milestone sync for '${milestone.milestoneBranch}' after ` +
    `${failureCount} cycles (Issue #4260)`;

  return await escalateToExistingIssue(
    repo,
    milestone,
    body,
    what,
    ghCommandFn,
    log,
  );
}
