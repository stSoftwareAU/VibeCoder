/**
 * Periodic milestone branch sync with default branch (Issue #1238).
 *
 * Proactively merges the default branch into active milestone branches
 * to reduce drift and avoid merge conflicts on the final summary PR.
 *
 * Active milestones are those that are open and have at least one closed
 * issue (meaning work has started). The sync is best-effort — failures
 * are logged but do not block other work.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import type { IssueCache } from "./issue_cache.ts";
import { isIdleTaskMilestone } from "./idle_task_merge_gate.ts";
import { findFleetAuthoredIssuesTitled } from "./idle_task_wrapper_dedup.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import { fetchClosedIssuesByMilestone } from "./issue_query.ts";
import { validateGitHubMilestonesJson } from "./validation.ts";
import {
  buildMergeGateEscalationComment,
  isMergeGateFailure,
} from "./milestone_merge_gate.ts";
import {
  decideMilestoneQuery,
  loadMilestoneActivity,
  milestoneActivityKey,
  type MilestoneActivityState,
  recordMilestoneActivity,
  saveMilestoneActivity,
} from "./milestone_activity_gate.ts";
import {
  buildConflictEscalationComment,
  conflictDiagnosticTitle,
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
  loadSyncStreaks,
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  saveSyncStreaks,
  type SyncStreakEntry,
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
) => Promise<Result<MilestoneSyncOutcome>>;

/**
 * Function signature for checking whether a repository has been cloned
 * locally (Issue #1519). Milestone sync is a local-git operation; if the
 * repo has never been cloned in this environment, the sync must be
 * skipped rather than reported as a failure.
 */
export type LocalCloneExistsFn = (repo: string) => Promise<boolean>;

/** An active milestone discovered from the GitHub API. */
export interface ActiveMilestone {
  /** The milestone title (e.g., "v1.0"). */
  milestoneTitle: string;
  /** The derived milestone branch name (e.g., "milestone/v1-0"). */
  milestoneBranch: string;
  /** The repository's default branch (e.g., "main", "Develop"). */
  defaultBranch: string;
  /**
   * True when this milestone's REST closed count moved since the previous
   * cycle — a sub-issue PR merged (Issue #1558). Such a milestone syncs now
   * rather than waiting out the cooldown, because that is exactly the moment
   * the branch and the default branch have both just moved.
   */
  closedCountChanged?: boolean;
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
   * Optional IssueCache for read-through (Issue #1786). When provided,
   * the per-milestone closed-issue check shares a cache key with other
   * milestone helpers within the same iteration.
   */
  cache?: IssueCache;
  /**
   * Optional check for whether the repo has a local clone (Issue #1519).
   * When supplied and it returns `false`, the repo is skipped with no
   * sync attempt — git commands against a non-existent working directory
   * would otherwise be reported as a sync failure.
   */
  localCloneExistsFn?: LocalCloneExistsFn;
  /** Logging function. */
  log: (message: string) => void;
  /** Cooldown in seconds between sync attempts for the same milestone. */
  cooldownSeconds: number;
  /** Map tracking last sync time per repo|milestone key. */
  lastSyncTimes: Map<string, number>;
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
   * Path of the milestone activity file (Issue #1488). When set, the
   * REST `closed_issues` count observed for each milestone is persisted
   * across cycles so an unchanged milestone costs no closed-issue query.
   * Unset (tests, ad hoc callers): every milestone is queried.
   */
  activityPath?: string;
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
  /** Number of milestone branches skipped (cooldown or branch missing). */
  skipped: number;
  /** Number of milestone branches that failed to sync. */
  failed: number;
}

/** A GitHub milestone from the API. */
interface GitHubMilestone {
  title: string;
  number: number;
  /** REST closed issue + PR count, when the payload carries it (#1488). */
  closed_issues?: number;
}

// ---------------------------------------------------------------------------
// findActiveMilestoneBranches
// ---------------------------------------------------------------------------

/**
 * Find active milestones for a repository.
 *
 * An active milestone is one that is open and has at least one closed issue,
 * indicating that work has started. Milestones with no closed issues are
 * skipped — there is nothing to drift from yet.
 *
 * The closed-issue lookup is the expensive half, and it is gated on the
 * REST `closed_issues` count the milestone listing already returns
 * (Issue #1488): a milestone that has closed nothing, or whose count has
 * not moved since the previous cycle, is answered from the cheap call.
 *
 * @param repo - Repository in "owner/repo" format
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param defaultBranchFn - Optional cached default-branch resolver
 * @param cache - Optional per-iteration issue cache
 * @param activity - Optional cross-cycle observation state for the gate.
 *   Omitted (tests, one-shot callers) means every milestone is queried.
 * @returns Result with list of active milestones
 */
export async function findActiveMilestoneBranches(
  repo: string,
  ghCommandFn: GhCommandFn,
  defaultBranchFn?: DefaultBranchFn,
  cache?: IssueCache,
  activity?: MilestoneActivityState,
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

      // Issue #1488: decide from the cheap REST count whether the
      // expensive closed-issue query is worth making at all.
      const previous = activity
        ?.observations[milestoneActivityKey(repo, milestone.number)];
      const decision = decideMilestoneQuery(previous, milestone.closed_issues);

      // Issue #1558: a count that has MOVED since the previous cycle means
      // something closed — a sub-issue PR merged. The same cheap listing
      // that gates the query above therefore also answers "has this
      // milestone just moved?", at no extra API cost.
      const closedCountChanged = previous !== undefined &&
        typeof milestone.closed_issues === "number" &&
        previous.closedIssues !== milestone.closed_issues;

      if (decision.query) {
        // Check if milestone has at least one closed issue (Issue #1786:
        // routes through `fetchClosedIssuesByMilestone` so concurrent
        // milestones share a cached payload per iteration).
        let active: boolean;
        try {
          const closedIssues = await fetchClosedIssuesByMilestone(
            repo,
            milestone.title,
            cache,
            ghCommandFn,
          );
          active = closedIssues.length > 0;
        } catch {
          continue; // Cannot check — skip this milestone, record nothing
        }
        recordMilestoneActivity(
          activity,
          repo,
          milestone.number,
          milestone.closed_issues,
          active,
        );
        if (!active) {
          continue; // No work started yet — skip
        }
      } else if (!decision.active) {
        continue; // Known inactive from the cheap call — no query spent
      }

      activeMilestones.push({
        milestoneTitle: milestone.title,
        milestoneBranch: createMilestoneBranchName(milestone.title),
        defaultBranch,
        closedCountChanged,
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
 * Determine whether a milestone branch should be synced based on cooldown.
 *
 * Prevents excessive sync attempts by tracking the last sync time per
 * repo|milestone combination. Only allows a sync if the cooldown period
 * has elapsed since the last successful sync.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneTitle - The milestone title
 * @param lastSyncTimes - Map tracking last sync time per repo|milestone key
 * @param cooldownSeconds - Minimum seconds between sync attempts
 * @returns true if sync should proceed
 */
export function shouldSyncMilestone(
  repo: string,
  milestoneTitle: string,
  lastSyncTimes: Map<string, number>,
  cooldownSeconds: number,
): boolean {
  const key = `${repo}|${milestoneTitle}`;
  const lastSync = lastSyncTimes.get(key);
  if (lastSync === undefined) {
    return true; // Never synced
  }
  const elapsedMs = Date.now() - lastSync;
  return elapsedMs >= cooldownSeconds * 1000;
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
 * 1. Find active milestones (open, with at least one closed issue)
 * 2. For each milestone, check the cooldown guard
 * 3. Verify the milestone branch exists on the remote
 * 4. Attempt to merge the default branch into the milestone branch
 * 5. On success: push and record the sync time
 * 6. On failure: log a warning (do not block other work)
 *
 * @param deps - Injected dependencies
 * @returns Result with sync summary
 */
export async function syncMilestoneBranches(
  deps: MilestoneBranchSyncDeps,
): Promise<Result<MilestoneSyncResult>> {
  const {
    repos,
    ghCommandFn,
    syncBranchFn,
    localCloneExistsFn,
    log,
    cooldownSeconds,
    lastSyncTimes,
  } = deps;
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

  // Closed-issue query gate (Issue #1488): observations of the cheap REST
  // count, carried across cycles so an unchanged milestone is answered
  // without the expensive half.
  const activityPath = deps.activityPath;
  const activity: MilestoneActivityState | undefined = activityPath
    ? {
      observations: await loadMilestoneActivity(activityPath, log),
      dirty: false,
    }
    : undefined;

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
        deps.cache,
        activity,
      );
      if (!milestonesResult.ok) {
        log(
          `WARNING: Could not find active milestones for ${repo}: ${milestonesResult.error.message}`,
        );
        continue;
      }

      for (const milestone of milestonesResult.value) {
        // Frequency guard: skip if synced recently — unless a sub-issue PR
        // has just merged (Issue #1558). The default branch is merged down
        // after each closure, not once per cooldown window, because that is
        // when both sides have just moved and a conflict is still one day
        // wide rather than a week of divergence.
        if (
          !milestone.closedCountChanged &&
          !shouldSyncMilestone(
            repo,
            milestone.milestoneTitle,
            lastSyncTimes,
            cooldownSeconds,
          )
        ) {
          log(
            `Skipping sync for '${milestone.milestoneTitle}' in ${repo} — cooldown active`,
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

        // Attempt sync
        const syncResult = await syncBranchFn(
          repo,
          milestone.milestoneBranch,
          milestone.defaultBranch,
        );

        if (syncResult.ok) {
          log(
            `Synced milestone branch '${milestone.milestoneBranch}' in ${repo}: ${syncResult.value.message}`,
          );
          // Record successful sync time
          const key = `${repo}|${milestone.milestoneTitle}`;
          lastSyncTimes.set(key, Date.now());
          synced++;

          // A merge that conflicted still landed, but the resolution favoured
          // the default branch and nobody chose it (Issue #1558). Report it
          // now, while the divergence is one day wide — once per conflicting
          // default-branch commit, so a branch that keeps conflicting against
          // the same commit is not reported every cycle.
          const streakKey = `${repo}|${milestone.milestoneBranch}`;
          const conflict = syncResult.value.conflict;
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
            if (streakPath) {
              // The sync succeeded, so any failure streak ends here
              // (Issue #4260) while the reported-conflict marker survives.
              const existing = streaks[streakKey];
              if (reportedSha) {
                if (
                  existing?.conflictEscalatedSha !== reportedSha ||
                  existing.count !== 0 || existing.escalated
                ) {
                  streaks[streakKey] = {
                    count: 0,
                    escalated: false,
                    conflictEscalatedSha: reportedSha,
                  };
                  streaksDirty = true;
                }
              } else if (existing) {
                delete streaks[streakKey];
                streaksDirty = true;
              }
            }
          } else if (streakPath && streaks[streakKey]) {
            // A clean success ends the failure streak (Issue #4260): clear it
            // so a branch that recovers is not still counted as diverging.
            delete streaks[streakKey];
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
            const streakKey = `${repo}|${milestone.milestoneBranch}`;
            entry = streaks[streakKey] ?? { count: 0, escalated: false };
            entry.count++;
            streaks[streakKey] = entry;
            streaksDirty = true;
          }

          if (isConflictEscalation(syncResult.error)) {
            // Case 3 (Issue #1559): the conflict is two designs for the same
            // problem, so nothing was pushed and the branch is untouched.
            // What reaches the human is the preparation — both sides'
            // exports, both sides' test names, and the difference between
            // them — reported once per conflicting default-branch commit, so
            // a branch that keeps conflicting against the same commit is not
            // reported every cycle.
            const conflictKey = syncResult.error.defaultSha || UNRESOLVED_SHA;
            if (entry?.conflictEscalatedSha !== conflictKey) {
              const escalated = await escalateConflictAnalysis(
                repo,
                milestone,
                syncResult.error.analyses,
                syncResult.error.resolved,
                conflictKey,
                ghCommandFn,
                log,
              );
              // Without a streak file there is nowhere to record that the
              // report went out, so the loud WARNING above stands alone
              // rather than the same comment repeating every cycle.
              if (escalated && entry) entry.conflictEscalatedSha = conflictKey;
            }
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

  if (streakPath && streaksDirty) {
    try {
      await saveSyncStreaks(streakPath, streaks);
    } catch {
      // Persistence is an optimisation — never fail the sweep over it.
    }
  }

  if (activityPath && activity?.dirty) {
    try {
      await saveMilestoneActivity(activityPath, activity.observations);
    } catch (err) {
      // Losing the observations only costs the next cycle a query — but it
      // is a fault, so it is said out loud rather than swallowed.
      const message = err instanceof Error ? err.message : String(err);
      log(
        `WARNING: Could not persist milestone activity to ${activityPath}: ${message}`,
      );
    }
  }

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

  const issueNumber = trackingIssueFromMilestoneTitle(milestone.milestoneTitle);
  if (issueNumber === null) {
    return await fileStuckSyncDiagnostic(
      repo,
      milestone.milestoneBranch,
      body,
      ghCommandFn,
      log,
      what,
      {},
      conflictDiagnosticTitle(milestone.milestoneBranch, conflict.defaultSha),
    );
  }

  return await postEscalationComment(
    repo,
    issueNumber,
    body,
    ghCommandFn,
    log,
    what,
  );
}

/**
 * Report a conflict no automatic rule could resolve (Issue #1559).
 *
 * Nothing was pushed and the branch is exactly as it was, so this is not a
 * "check what was overwritten" report — it is the preparation a human would
 * otherwise spend an hour on: what each side exports, what each side tests,
 * and which cases exist on one side only.
 *
 * Best-effort, and returns true only when the report went out, so the caller
 * remembers the commit it reported and does not repeat it every cycle.
 */
async function escalateConflictAnalysis(
  repo: string,
  milestone: ActiveMilestone,
  analyses: FileAnalysis[],
  resolved: FileDecision[],
  /** The default-branch commit that conflicted, for the diagnostic's title. */
  defaultSha: string,
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
    })
  }\n\n${describeBranchTips(tips)}`;

  const what = `a milestone sync conflict only a human can resolve for ` +
    `'${milestone.milestoneBranch}' (Issue #1559)`;

  const issueNumber = trackingIssueFromMilestoneTitle(milestone.milestoneTitle);
  if (issueNumber === null) {
    return await fileStuckSyncDiagnostic(
      repo,
      milestone.milestoneBranch,
      body,
      ghCommandFn,
      log,
      what,
      {},
      conflictDiagnosticTitle(milestone.milestoneBranch, defaultSha),
    );
  }

  return await postEscalationComment(
    repo,
    issueNumber,
    body,
    ghCommandFn,
    log,
    what,
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

  const issueNumber = trackingIssueFromMilestoneTitle(milestone.milestoneTitle);
  if (issueNumber === null) {
    // Issue #1465: no `#NNN` in the title used to mean no destination and a
    // silent `false`. File where a human will see it instead.
    return await fileStuckSyncDiagnostic(
      repo,
      milestone.milestoneBranch,
      gateBody,
      ghCommandFn,
      log,
      `a refused milestone sync merge for '${milestone.milestoneBranch}' ` +
        `(Issues #974, #1465)`,
    );
  }

  return await postEscalationComment(
    repo,
    issueNumber,
    gateBody,
    ghCommandFn,
    log,
    `a refused milestone sync merge for '${milestone.milestoneBranch}' ` +
      `(Issue #974)`,
  );
}

/**
 * Post one escalation comment on a tracking issue, best-effort.
 *
 * Shared by both milestone-sync escalations so there is one place that knows
 * how the comment is posted and how a failure to post it is reported. Returns
 * true only when the comment went out, so a caller marks its streak escalated
 * and does not repeat it every cycle.
 *
 * @param what - Names the escalation in both log lines
 */
/**
 * Title of the diagnostic filed when a stalled sync has no tracking issue
 * (Issue #1465). Keyed on the milestone BRANCH, so a stall is one issue
 * rather than one per cycle, and both escalation kinds share the destination.
 */
export function stuckSyncDiagnosticTitle(milestoneBranch: string): string {
  return `Milestone branch sync is stuck: ${milestoneBranch}`;
}

/**
 * Escalate a stalled sync that has nowhere to comment (Issue #1465).
 *
 * Both escalations used to resolve their destination by parsing `#NNN` out of
 * the milestone TITLE, and returned `false` when there was none. Every
 * milestone open when this was found had an unprefixed title, so the
 * escalation was off for effectively all of the fleet's work — and off
 * silently, because `false` is indistinguishable from "nothing to report".
 * `milestone/fix-scan-issues-20260906` sat 32 commits behind `main` for over
 * a day with 14 conflicting files, and nothing was raised.
 *
 * A tracking issue only exists once a milestone completes, so the title-parse
 * path covers the minority case by construction. This is the destination that
 * always exists: an issue on the repository whose branch is stuck, deduped by
 * title so a branch stuck for days produces one issue, not one per cycle.
 *
 * Best-effort by design, but never silent. A lookup that fails falls through
 * and files anyway — a duplicate issue is a far smaller problem than a stall
 * nobody hears about. Only a failed *create* returns false, and it says so.
 *
 * @param what - Names the escalation in the log lines.
 * @returns True when the stall is now visible to a human.
 */
async function fileStuckSyncDiagnostic(
  repo: string,
  milestoneBranch: string,
  body: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  what: string,
  dedupAuthors: AlertDedupAuthorOptions = {},
  /** Overrides the stuck-sync title — a conflict report is not a stall. */
  title: string = stuckSyncDiagnosticTitle(milestoneBranch),
): Promise<boolean> {
  try {
    // Author-verified, never title-only (the `marker_dedup_author_cap`
    // invariant). A lookup that trusts a title alone lets anyone suppress
    // this escalation for ever by opening an issue with the same title — a
    // silent "already handled" is exactly the failure this escalation exists
    // to prevent, so the dedup must not reintroduce it. `fleetAuthors` is
    // resolved once, from the same fleet definition every other alert uses.
    const matches = await findFleetAuthoredIssuesTitled({
      repo,
      title,
      context: `stuck milestone sync ${milestoneBranch}`,
      ghCommand: ghCommandFn,
      searchExpression: `${title} in:title`,
      limit: 50,
      log,
      ...dedupAuthors,
    });
    const match = matches[0];
    if (match) {
      log(
        `Stalled milestone sync for '${milestoneBranch}' in ${repo} is ` +
          `already tracked by issue #${match.number} — not filing again.`,
      );
      return true;
    }
  } catch (err) {
    // Fall through and file: a duplicate is cheaper than a silent stall.
    log(
      `Could not check for an existing diagnostic for '${milestoneBranch}' ` +
        `in ${repo}, filing anyway: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }

  const create = (withLabel: boolean): string[] => [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
    ...(withLabel ? ["--label", "needs-human"] : []),
  ];

  try {
    await ghCommandFn(create(true));
    log(`Filed a diagnostic for ${what} in ${repo}: ${title}`);
    return true;
  } catch {
    // A repository without the `needs-human` label must still get the issue.
    try {
      await ghCommandFn(create(false));
      log(
        `Filed a diagnostic for ${what} in ${repo} without a label: ${title}`,
      );
      return true;
    } catch (err) {
      log(
        `ESCALATION FAILED: a stalled milestone sync for '${milestoneBranch}' ` +
          `in ${repo} could not be reported to anyone — ${
            err instanceof Error ? err.message : String(err)
          } (Issue #1465). ${what}`,
      );
      return false;
    }
  }
}

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
  const issueNumber = trackingIssueFromMilestoneTitle(milestone.milestoneTitle);

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

  // Issue #1465: a milestone whose title carries no `#NNN` used to have no
  // destination at all — the streak counted to the threshold and the
  // escalation returned a silent `false`. File where a human will see it.
  if (issueNumber === null) {
    return await fileStuckSyncDiagnostic(
      repo,
      milestone.milestoneBranch,
      body,
      ghCommandFn,
      log,
      what,
    );
  }

  return await postEscalationComment(
    repo,
    issueNumber,
    body,
    ghCommandFn,
    log,
    what,
  );
}
