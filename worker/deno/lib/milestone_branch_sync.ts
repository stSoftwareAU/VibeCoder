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
import { fetchClosedIssuesByMilestone } from "./issue_query.ts";
import { validateGitHubMilestonesJson } from "./validation.ts";
import {
  loadSyncStreaks,
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  saveSyncStreaks,
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

/** Function signature for syncing a milestone branch with the default branch. */
export type SyncBranchFn = (
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
) => Promise<Result<string>>;

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
 * @param repo - Repository in "owner/repo" format
 * @param ghCommandFn - Function to execute gh CLI commands
 * @returns Result with list of active milestones
 */
export async function findActiveMilestoneBranches(
  repo: string,
  ghCommandFn: GhCommandFn,
  defaultBranchFn?: DefaultBranchFn,
  cache?: IssueCache,
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

      // Check if milestone has at least one closed issue (Issue #1786:
      // routes through `fetchClosedIssuesByMilestone` so concurrent
      // milestones share a cached payload per iteration).
      try {
        const closedIssues = await fetchClosedIssuesByMilestone(
          repo,
          milestone.title,
          cache,
          ghCommandFn,
        );
        if (closedIssues.length === 0) {
          continue; // No work started yet — skip
        }
      } catch {
        continue; // Cannot check — skip this milestone
      }

      activeMilestones.push({
        milestoneTitle: milestone.title,
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
      );
      if (!milestonesResult.ok) {
        log(
          `WARNING: Could not find active milestones for ${repo}: ${milestonesResult.error.message}`,
        );
        continue;
      }

      for (const milestone of milestonesResult.value) {
        // Frequency guard: skip if synced recently
        if (
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
            `Synced milestone branch '${milestone.milestoneBranch}' in ${repo}: ${syncResult.value}`,
          );
          // Record successful sync time
          const key = `${repo}|${milestone.milestoneTitle}`;
          lastSyncTimes.set(key, Date.now());
          synced++;
          // A success ends the failure streak (Issue #4260): clear it so a
          // branch that recovers is not still counted as diverging.
          const streakKey = `${repo}|${milestone.milestoneBranch}`;
          if (streakPath && streaks[streakKey]) {
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
          if (streakPath) {
            const streakKey = `${repo}|${milestone.milestoneBranch}`;
            const entry = streaks[streakKey] ?? { count: 0, escalated: false };
            entry.count++;
            streaks[streakKey] = entry;
            streaksDirty = true;
            if (
              entry.count >= MILESTONE_SYNC_ESCALATION_THRESHOLD &&
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

  return { ok: true, value: { synced, skipped, failed } };
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
  if (issueNumber === null) {
    log(
      `Milestone '${milestone.milestoneTitle}' in ${repo} has failed to sync ` +
        `${failureCount} cycles but its title carries no tracking issue — ` +
        `cannot escalate (Issue #4260).`,
    );
    return false;
  }

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

  const body = `## Milestone branch sync is stuck — needs a human\n\n` +
    `\`${milestone.milestoneBranch}\` has failed to sync with ` +
    `\`${milestone.defaultBranch}\` for ${failureCount} consecutive cycles` +
    `${aheadBehind}.\n\n` +
    `Latest reason from git:\n\n> ${reason}\n\n` +
    `The worker will keep retrying but cannot resolve this itself. Once the ` +
    `branch syncs, this escalation clears automatically (Issue #4260).`;

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
    log(
      `Escalated stuck milestone sync for '${milestone.milestoneBranch}' in ` +
        `${repo} to issue #${issueNumber} after ${failureCount} cycles ` +
        `(Issue #4260).`,
    );
    return true;
  } catch (err) {
    log(
      `Failed to post milestone-sync escalation for ` +
        `'${milestone.milestoneBranch}' in ${repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return false;
  }
}
