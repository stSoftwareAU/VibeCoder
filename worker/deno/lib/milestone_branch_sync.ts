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
  type MilestoneEscalationTarget,
  resolveMilestoneEscalationTarget,
} from "./milestone_escalation_target.ts";
import { closeResolvedSyncDiagnostics } from "./milestone_sync_diagnostic_closeout.ts";
import {
  loadSyncStreaks,
  MILESTONE_SYNC_ESCALATION_THRESHOLD,
  recordDefaultSha,
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
) => Promise<Result<MilestoneSyncOutcome>>;

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
 * The cadence gate spends this instead of an API call: one
 * `git rev-parse origin/<default>` after the fetch that makes the ref
 * current. `undefined` means the tip could not be read — the gate then syncs
 * rather than reading an unknown tip as "unchanged".
 */
export type DefaultTipShaFn = (
  repo: string,
  defaultBranch: string,
) => Promise<string | undefined>;

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
  let reason = "git reported no commit";
  try {
    const sha = (await defaultTipShaFn(repo, defaultBranch))?.trim();
    if (sha) return sha;
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
  const carried = existing?.lastSyncedDefaultSha;
  let next: SyncStreakEntry = {
    count: 0,
    escalated: false,
    ...(reportedSha ? { conflictEscalatedSha: reportedSha } : {}),
    // With no tip to record, the last one known still stands.
    ...(carried ? { lastSyncedDefaultSha: carried } : {}),
  };
  if (defaultSha) next = recordDefaultSha(next, defaultSha);

  // An entry carrying neither a marker nor a tip holds nothing worth keeping.
  if (!next.conflictEscalatedSha && !next.lastSyncedDefaultSha) {
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

      for (const milestone of milestonesResult.value) {
        const streakKey = `${repo}|${milestone.milestoneBranch}`;

        // Cadence guard (Issue #1776): the branch already carries this tip,
        // so there is nothing to merge down. Checked before the branch probe
        // so an idle cycle costs no API call at all.
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

          if (isConflictEscalation(syncResult.error)) {
            // Case 3 (Issue #1559): the conflict is two designs for the same
            // problem, so nothing was pushed and the branch is untouched.
            // What reaches the human is the preparation — both sides'
            // exports, both sides' test names, and the difference between
            // them — reported once per conflicting default-branch commit, so
            // a branch that keeps conflicting against the same commit is not
            // reported every cycle.
            // Without a streak file there is nowhere to record that the
            // report went out, so escalating would repeat every cycle — the
            // loud WARNING log above stands on its own there, as it does for
            // the Issue #974 gate refusal below.
            const conflictKey = syncResult.error.defaultSha || UNRESOLVED_SHA;
            if (entry && entry.analysisEscalatedSha !== conflictKey) {
              const escalated = await escalateConflictAnalysis(
                repo,
                milestone,
                syncResult.error.analyses,
                syncResult.error.resolved,
                syncResult.error.gateFailure,
                ghCommandFn,
                log,
              );
              if (escalated) entry.analysisEscalatedSha = conflictKey;
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
  /** What the verification said, when it is what refused the resolution. */
  gateFailure: string | undefined,
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
      ...(gateFailure ? { gateFailure } : {}),
    })
  }\n\n${describeBranchTips(tips)}`;

  const what = `a milestone sync conflict only a human can resolve for ` +
    `'${milestone.milestoneBranch}' (Issue #1559)`;

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
