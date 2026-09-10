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
  DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS,
  DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT,
} from "./merge_conflict_drain.ts";
import { isRuleViolationPush } from "./milestone_sync_pr.ts";
import {
  type MilestoneEscalationTarget,
  resolveMilestoneEscalationTarget,
} from "./milestone_escalation_target.ts";
import { closeResolvedSyncDiagnostics } from "./milestone_sync_diagnostic_closeout.ts";
import {
  concludeConflictAttempt,
  type ConflictAttemptOutcome,
  isConflictAttemptDue,
  isConflictBudgetExhausted,
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  openConflictAttempt,
  recordDefaultSha,
  resetConflictLedgerOnSuccess,
  saveSyncStreaks,
  type SyncStreakEntry,
  type SyncStreaks,
  trackingIssueFromMilestoneTitle,
} from "./milestone_sync_streak.ts";

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
   * too little of the handler's budget remains to cover one — an agent
   * started with no room to finish is killed mid-edit, and that kill is the
   * #1693 shape this sync must not repeat. A sync given `false` climbs the
   * triage and the deterministic rules and stops there.
   */
  agentAllowed: boolean;
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
) => Promise<void>;

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
  /** Clock seam (epoch milliseconds); defaults to `Date.now`. */
  now?: () => number;
  /**
   * Where a branch that has spent its conflict budget is handed
   * (Issue #1778). Defaults to one log line and nothing posted — the
   * roll-back wiring is Issue #1771's.
   */
  rollbackFn?: MilestoneRollbackFn;
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
 * Whether the cycle still has room for one agent-backed resolution
 * (Issue #1778).
 *
 * The merge-conflict drain's "too little of the cycle left" shape, applied to
 * the milestone sync and spending its constants: an agent started with less
 * than its own timeout left is an agent the watchdog kills mid-edit, and
 * Issue #1693 is the record of what that costs. A pass with no deadline is
 * unbounded and always covers a run.
 *
 * @param opts.deadlineEpochMs - The handler's watchdog deadline, when it has one
 * @param opts.nowMs - Current time in epoch milliseconds
 * @param opts.agentTimeoutMs - The agent timeout a resolution would be granted
 * @param opts.attemptOverheadMs - Budget the resolution spends outside the agent
 */
export function cycleCoversAgentRun(opts: {
  deadlineEpochMs?: number;
  nowMs: number;
  agentTimeoutMs?: number;
  attemptOverheadMs?: number;
}): boolean {
  if (opts.deadlineEpochMs === undefined) return true;
  const overhead = opts.attemptOverheadMs ??
    DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS;
  const need = opts.agentTimeoutMs ?? DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT;
  return opts.deadlineEpochMs - opts.nowMs - overhead >= need;
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
function defaultRollbackFn(
  log: (message: string) => void,
): MilestoneRollbackFn {
  return (request) => {
    log(
      `WARNING: Milestone branch '${request.milestoneBranch}' in ` +
        `${request.repo}: budget exhausted: roll-back not yet available — ` +
        `${request.attempts} concluded conflict failure(s), last: ` +
        `${request.reason} (Issue #1778)`,
    );
    return Promise.resolve();
  };
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
 * Success is the only thing that writes `lastSyncedDefaultSha`, so a failure
 * leaves the previous tip in place and the next cycle tries again. The
 * failure streak ends here (Issue #4260); the reported-conflict marker and
 * the synced tip are what survive it.
 *
 * @param reportedSha - A conflicting default-branch commit already reported,
 *   when there is one to remember.
 * @returns True when the ledger changed and needs persisting.
 */
function recordSuccess(
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
  const rollbackFn = deps.rollbackFn ?? defaultRollbackFn(log);
  // The cycle's single agent rung, across every repo and every milestone
  // (Issue #1778). Spent by the first branch that actually conflicts while
  // holding it — a branch that merged cleanly asked nothing of the agent.
  let agentSpent = false;

  for (const repo of repos) {
    try {
      // Issue #1519: sync is a local-git operation. Skip repos that have
      // not been cloned in this environment — otherwise every git command
      // below fails and is mis-reported as a sync failure.
      if (localCloneExistsFn && !(await localCloneExistsFn(repo))) {
        log(`Skipping milestone sync for ${repo} — no local clone`);
        continue;
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
          milestonesResult.value.map((m) => `${repo}|${m.milestoneBranch}`),
        );
        for (const key of Object.keys(streaks)) {
          if (key.startsWith(`${repo}|`) && !live.has(key)) {
            delete streaks[key];
            streaksDirty = true;
          }
        }
      }

      for (const milestone of milestonesResult.value) {
        const streakKey = `${repo}|${milestone.milestoneBranch}`;

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
        const agentAllowed = !agentSpent && cycleCoversAgentRun({
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
        });

        // Attempt sync
        const syncResult = await syncBranchFn(
          repo,
          milestone.milestoneBranch,
          milestone.defaultBranch,
          { agentAllowed },
        );

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

          // A merge that conflicted still landed, but the resolution favoured
          // the default branch and nobody chose it (Issue #1558). Report it
          // now, while the divergence is one day wide — once per conflicting
          // default-branch commit, so a branch that keeps conflicting against
          // the same commit is not reported every cycle.
          const conflict = syncResult.value.conflict;
          // The grant is spent by a branch that actually collided while
          // holding it (Issue #1778) — a clean merge asked nothing of it.
          if (conflict && agentAllowed) agentSpent = true;
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
          if (conflictError && agentAllowed) agentSpent = true;

          // Conclude the ledger attempt this failure ends (Issue #1778).
          if (streakPath && entry) {
            const verdict = judgeSyncFailure(syncResult.error, agentAllowed);
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
                // rolled back rather than reported to anyone (Issue #1771).
                await rollbackFn({
                  repo,
                  milestoneBranch: milestone.milestoneBranch,
                  defaultBranch: milestone.defaultBranch,
                  attempts,
                  reason: verdict.reason,
                });
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
            // sides prepared — deduped by the same `gateEscalated` flag the
            // Issue #974 refusal uses, because it is the same class of
            // failure and a retry does not clear either.
            if (entry && !entry.gateEscalated) {
              const escalated = await escalateConflictAnalysis(
                repo,
                milestone,
                conflictError.analyses,
                conflictError.resolved,
                conflictError.gateFailure,
                ghCommandFn,
                log,
              );
              if (escalated) entry.gateEscalated = true;
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
            entry && entry.count >= MILESTONE_SYNC_ESCALATION_THRESHOLD &&
            !entry.escalated
          ) {
            const escalated = await escalateSyncFailure(
              repo,
              milestone,
              entry.count,
              syncResult.error.message,
              ghCommandFn,
              log,
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
 */
async function escalateSyncConflict(
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

  const body = `${
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
 * @returns True when the escalation reached a human, or had nowhere to go.
 */
async function escalateToExistingIssue(
  repo: string,
  milestone: ActiveMilestone,
  body: string,
  what: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
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
    });

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
