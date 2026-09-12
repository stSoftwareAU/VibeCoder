/**
 * Bring a milestone branch level with the default branch **before** a child
 * issue branch is cut from it (Issue #1780).
 *
 * A child run used to cut its branch off whatever the milestone branch
 * happened to be, however far behind the default branch that was. Every such
 * child then carried the drift into its PR, and the drift was only merged down
 * later — by the periodic sweep, against N children at once. Sync before new
 * work: no branch is cut while its base is behind.
 *
 * The attempt is the ladder's, not a second ladder. It spends the same
 * per-branch conflict budget the periodic sweep spends
 * ([milestone_sync_streak.ts](./milestone_sync_streak.ts)), judges its failure
 * with the sweep's own `judgeSyncFailure`, and paces itself on the sweep's own
 * `conflictAttemptDue` — one ledger, one set of transitions, so a child run and
 * the sweep can never disagree about what a branch has spent.
 *
 * When the branch cannot be brought level the run **defers**: it exits before
 * any implementation agent is spent, leaves the issue open with its pickup
 * label untouched, and says why on the release comment. The charged failure
 * writes `deferUntil`, which is what stops every other slot re-claiming the
 * same milestone 30 seconds later (the selector reads it — see
 * {@link milestonePacedUntil}).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result, WorkerConfig } from "../types.ts";
import {
  type MilestoneSyncConflict,
  type MilestoneSyncOutcome,
  UNRESOLVED_SHA,
} from "./milestone_sync_conflict.ts";
import { isConflictEscalation } from "./milestone_conflict_triage.ts";
import {
  conflictAttemptDue,
  escalateSyncConflict,
  type GhCommandFn,
  grantAgentRun,
  judgeSyncFailure,
  recordSuccess,
  type SyncBranchOptions,
} from "./milestone_branch_sync.ts";
import {
  concludeConflictAttempt,
  isConflictBudgetExhausted,
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  milestoneSyncStreakPath,
  openConflictAttempt,
  saveSyncStreaks,
  type SyncStreakEntry,
  syncStreakKey,
  type SyncStreaks,
} from "./milestone_sync_streak.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import { readLocalDefaultTip } from "./milestone_default_tip.ts";
import { countCommitsAhead } from "./git_issue_branches.ts";
import { syncMilestoneBranchWithDefault } from "./git_pull.ts";
import { bindMilestoneConflictAgent } from "./milestone_conflict_agent_binding.ts";
import { runClaudeWithRetry } from "./claude_runner.ts";
import { runGitCommand } from "./git_timeout.ts";
import { assertSafeGitRef } from "./git_ref_args.ts";

/**
 * What is wrong, in the words the log line and the deferral reason share
 * (Issue #1780).
 */
export const MILESTONE_BEHIND = "milestone behind default branch";

/**
 * The reason a child run reports when its milestone base is not level
 * (Issue #1780). One string, so the phase, the release comment and the tests
 * cannot drift apart.
 */
export const MILESTONE_BEHIND_DEFER_REASON = `deferred: ${MILESTONE_BEHIND}`;

/** What the pre-cut sync concluded. */
export type MilestonePresyncStatus =
  /** The branch already carried every default-branch commit — nothing ran. */
  | "level"
  /** The default branch was merged down; the branch is level now. */
  | "synced"
  /** The branch is behind and could not be brought level this run. */
  | "deferred";

/** The pre-cut sync's verdict. */
export interface MilestonePresyncResult {
  status: MilestonePresyncStatus;
  /** Commits the default branch carried that the milestone branch did not. */
  behindBy?: number;
  /** One line for the log and the release comment. */
  detail: string;
  /**
   * The milestone tip the child branch will be cut from, after a successful
   * sync. Absent when it could not be read — the branch is still cut from
   * `origin/<milestone>`, this is the record of which commit that was.
   */
  baseSha?: string;
}

/** The branch and clone the pre-cut sync is asked about. */
export interface MilestonePresyncRequest {
  /** Repository in `owner/repo` form — the ledger key's first half. */
  repo: string;
  milestoneBranch: string;
  defaultBranch: string;
  /**
   * The conflict ledger file. Absent keeps no ledger: nothing is paced and
   * nothing is charged, which is only ever right for a caller that has no
   * work directory.
   */
  streakPath?: string;
  /** What this attempt may spend on the ladder's agent rung. */
  grant: SyncBranchOptions;
  /** Conclusion time; defaults to now. */
  nowMs?: number;
}

/** The git and merge work, injected so a test needs neither model nor clone. */
export interface MilestonePresyncDeps {
  /** Commits `origin/<default>` carries that the milestone branch does not. */
  countBehind: () => Promise<Result<number>>;
  /** The default branch's tip, as the ledger records it. */
  defaultTipSha: () => Promise<Result<string>>;
  /** One merge-down attempt, granted what the caller allowed. */
  syncBranch: (
    grant: SyncBranchOptions,
  ) => Promise<Result<MilestoneSyncOutcome>>;
  /** The milestone tip a child branch would be cut from right now. */
  milestoneTipSha: () => Promise<Result<string>>;
  /**
   * Report a merge that landed but whose conflicts the worker resolved
   * itself, returning true only when the report went out (Issue #1558).
   *
   * Absent, the conflict is still said out loud in the log — a resolution
   * nobody chose must never pass in silence — but nothing is posted.
   */
  reportConflict?: (conflict: MilestoneSyncConflict) => Promise<boolean>;
  log: (message: string) => void;
}

/**
 * How long a milestone's branch ledger paces it, or undefined when it does not
 * (Issue #1780).
 *
 * Read by the issue selector so a paced milestone's issues are skipped before
 * a claim is made: a charged conflict failure means the branch cannot take the
 * default branch down yet, and claiming its children only to defer each one
 * would comment on an issue every 30 seconds. A local file read — no API call.
 *
 * @param streaks - The loaded ledger
 * @param repo - Repository in `owner/repo` form
 * @param milestoneTitle - The issue's milestone title, as GitHub reports it
 * @param nowMs - Current time in epoch milliseconds
 * @returns The `deferUntil` still in the future, or undefined
 */
export function milestonePacedUntil(
  streaks: SyncStreaks,
  repo: string,
  milestoneTitle: string,
  nowMs: number,
): string | undefined {
  if (!milestoneTitle) return undefined;
  const branch = createMilestoneBranchName(milestoneTitle);
  const entry = streaks[syncStreakKey(repo, branch)];
  const deferUntil = entry?.deferUntil;
  if (deferUntil === undefined) return undefined;
  const until = Date.parse(deferUntil);
  // An unparseable deferral paces the branch rather than releasing it — the
  // same direction `isConflictAttemptDue` takes, for the same reason: reading
  // corruption as "no cooldown applies" is the permissive direction on a
  // safety bound.
  if (Number.isNaN(until)) return deferUntil;
  return nowMs >= until ? undefined : deferUntil;
}

/** `deferred: …` with the reason appended, so every deferral reads the same. */
function deferral(
  detail: string,
  behindBy?: number,
): MilestonePresyncResult {
  const behindNote = behindBy === undefined ? "" : ` (${behindBy} commits)`;
  return {
    status: "deferred",
    ...(behindBy === undefined ? {} : { behindBy }),
    detail: `${MILESTONE_BEHIND_DEFER_REASON}${behindNote} — ${detail}`,
  };
}

/**
 * Bring the milestone branch level with the default branch, or defer.
 *
 * Cheap on the ordinary path: a branch that already carries the default tip
 * costs one fetch of the default branch (which is what makes the comparison
 * truthful) and one `rev-list --count`, and touches the ledger not at all.
 *
 * @param request - The branch, the clone's ledger and this attempt's grant
 * @param deps - The git and merge work, injected
 * @returns `level`, `synced`, or `deferred` with the reason
 */
export async function presyncMilestoneBranch(
  request: MilestonePresyncRequest,
  deps: MilestonePresyncDeps,
): Promise<MilestonePresyncResult> {
  const { repo, milestoneBranch, defaultBranch, streakPath, grant } = request;
  const nowMs = request.nowMs ?? Date.now();

  // The default tip FIRST, because reading it is what fetches it. Counting
  // against a stale `origin/<default>` would answer "level" for a branch that
  // is behind — the very defect this gate exists to stop — so the order is
  // load-bearing, not incidental.
  const tip = await deps.defaultTipSha();
  if (!tip.ok) {
    deps.log(
      `WARNING: Could not read the tip of '${defaultBranch}' for ` +
        `'${milestoneBranch}' (${tip.error.message}) — the ledger paces this ` +
        `branch on its deferral alone (Issue #1780)`,
    );
  }
  const defaultSha = tip.ok ? tip.value : undefined;

  const behind = await deps.countBehind();
  if (!behind.ok) {
    // Never the permissive direction: a base nobody could measure is a base no
    // child branch is cut from. The wording does not claim the branch IS
    // behind — that is the one thing this case could not establish.
    return deferral(
      `how far '${milestoneBranch}' stands from '${defaultBranch}' could not ` +
        `be read (${behind.error.message}), so no branch is cut from an ` +
        `unverified base`,
    );
  }
  if (behind.value === 0) {
    return {
      status: "level",
      behindBy: 0,
      detail: `'${milestoneBranch}' already carries every commit on ` +
        `'${defaultBranch}'`,
    };
  }

  const behindBy = behind.value;

  const streaks: SyncStreaks = streakPath
    ? await loadSyncStreaks(streakPath)
    : {};
  const key = syncStreakKey(repo, milestoneBranch);
  let entry: SyncStreakEntry = streaks[key] ?? { count: 0, escalated: false };

  /**
   * Persist the ledger, reporting a refused write once, here.
   *
   * A marker that never reaches disk is a marker the next run never sees, so
   * the failure is never swallowed — but it is also never fatal: bringing the
   * branch level is idempotent, useful work, and what a refused write costs is
   * the *pacing*, which is what the message names.
   *
   * @param what - The transition being recorded, for the warning
   * @param writeEntry - False when the caller has already written the map
   *   itself (the shared success transition does)
   */
  const persist = async (what: string, writeEntry = true): Promise<void> => {
    if (!streakPath) return;
    if (writeEntry) streaks[key] = entry;
    try {
      await saveSyncStreaks(streakPath, streaks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(
        `WARNING: The milestone sync ledger at ${streakPath} could not be ` +
          `written while recording ${what} for '${milestoneBranch}' ` +
          `(${message}) — this attempt cannot be charged or paced ` +
          `(Issue #1780)`,
      );
    }
  };

  // An attempt still open judged nothing — the run died before the conflict
  // was decided. It concludes `disrupted`, charged nothing, exactly as the
  // sweep concludes one (Issues #395, #1693, #1778).
  if (entry.attemptOpenedAt) {
    entry = concludeConflictAttempt(
      entry,
      "disrupted",
      "the run ended before the conflict was judged",
      defaultSha,
      nowMs,
    );
    deps.log(
      `Milestone '${milestoneBranch}' in ${repo}: the previous conflict ` +
        `attempt never concluded — recorded as disrupted and not charged ` +
        `(Issue #1780)`,
    );
  }

  if (isConflictBudgetExhausted(entry)) {
    await persist("the spent budget");
    return deferral(
      `the conflict budget is spent (${entry.conflictAttempts ?? 0} of ` +
        `${MILESTONE_CONFLICT_ATTEMPT_BUDGET} concluded failures), so ` +
        `'${milestoneBranch}' belongs to the roll-back rather than to another ` +
        `merge`,
      behindBy,
    );
  }

  if (!conflictAttemptDue(entry, defaultSha, nowMs)) {
    await persist("the live deferral");
    return deferral(
      `conflict attempt not due until ${entry.deferUntil}`,
      behindBy,
    );
  }

  // Opening charges nothing; it is the marker a kill leaves behind. On disk
  // before the merge starts, or it cannot record the kill it exists for.
  entry = openConflictAttempt(entry, nowMs);
  await persist("the attempt marker");

  const sync = await deps.syncBranch(grant);

  if (sync.ok) {
    // The merge landed, but a merge that CONFLICTED landed on a resolution
    // nobody chose (Issue #1558). Once per conflicting default-branch commit,
    // exactly as the sweep reports it — and loudly in the log either way, so a
    // run with no reporter wired still cannot pass it in silence.
    const conflict = sync.value.conflict;
    let reportedSha = entry.conflictEscalatedSha;
    if (conflict) {
      const conflictKey = conflict.defaultSha || UNRESOLVED_SHA;
      deps.log(
        `WARNING: The pre-cut sync of '${milestoneBranch}' in ${repo} ` +
          `resolved a conflict itself before landing: ` +
          `${conflict.files.join(", ")} (Issue #1780)`,
      );
      if (reportedSha !== conflictKey && deps.reportConflict) {
        // Only a report that went out is remembered; one that failed must be
        // retried rather than marked done.
        if (await deps.reportConflict(conflict)) reportedSha = conflictKey;
      }
    }
    // What a landed sync does to the ledger is `recordSuccess` — the sweep's
    // own transition, called here rather than restated: it refills the budget,
    // drops the open marker and the deferral, ends the failure streak with its
    // escalation flags, and records the tip the branch now carries so the
    // sweep's cadence gate agrees with this run.
    streaks[key] = entry;
    recordSuccess(streaks, key, defaultSha, reportedSha);
    await persist("the landed sync", false);
    const base = await deps.milestoneTipSha();
    if (!base.ok) {
      deps.log(
        `WARNING: '${milestoneBranch}' synced but its new tip could not be ` +
          `read (${base.error.message}) — the branch is still cut from ` +
          `origin/${milestoneBranch} (Issue #1780)`,
      );
    }
    return {
      status: "synced",
      behindBy,
      detail: `merged '${defaultBranch}' into '${milestoneBranch}' before ` +
        `cutting the issue branch (${behindBy} commit(s) behind): ` +
        sync.value.message,
      ...(base.ok ? { baseSha: base.value } : {}),
    };
  }

  // The sweep's own judgement, so a child run and the sweep charge the same
  // failures. Only a conflict every rung the attempt was granted left
  // undecided is the branch's to answer for.
  const verdict = judgeSyncFailure(sync.error, grant.agentAllowed);
  const conflict = isConflictEscalation(sync.error) ? sync.error : undefined;
  entry = concludeConflictAttempt(
    entry,
    verdict.outcome,
    verdict.reason,
    conflict?.defaultSha ?? defaultSha,
    nowMs,
  );
  await persist(`the ${verdict.outcome} conclusion`);
  if (verdict.outcome === "failed") {
    const attempts = entry.conflictAttempts ?? 0;
    deps.log(
      `WARNING: Milestone branch '${milestoneBranch}' in ${repo}: conflict ` +
        `attempt ${attempts} of ${MILESTONE_CONFLICT_ATTEMPT_BUDGET} failed ` +
        `at rung ${verdict.rung}` +
        (isConflictBudgetExhausted(entry)
          ? " — the budget is now spent and the branch belongs to the roll-back"
          : "") +
        ` (Issue #1780)`,
    );
    return deferral(
      `conflict attempt ${attempts} of ${MILESTONE_CONFLICT_ATTEMPT_BUDGET} ` +
        `failed at rung ${verdict.rung}: ${verdict.reason}`,
      behindBy,
    );
  }
  return deferral(
    `the merge did not land and the branch was not charged for it: ` +
      `${verdict.reason}`,
    behindBy,
  );
}

/** What the issue run knows about itself when it asks for the pre-cut sync. */
export interface IssueRunPresyncArgs {
  repo: string;
  /** The milestone's title, as the conflict report names it. */
  milestoneTitle: string;
  milestoneBranch: string;
  defaultBranch: string;
  /**
   * The clone the merge runs in — the shared `${workDir}/<repo>` clone the
   * sweep uses, never a lane worktree. A worktree parked on the milestone
   * branch is a branch every other lane and the sweep are then refused.
   */
  cwd: string;
  /** The conflict ledger's directory — `config.workDir`. */
  workDir: string;
  config: WorkerConfig;
  logger: Logger;
  /** The cycle's watchdog deadline, when the run has one (Issue #1778). */
  cycleDeadlineEpochMs?: number;
  /** Injected for tests; production passes the real implementations. */
  countCommitsAheadFn?: typeof countCommitsAhead;
  syncMilestoneBranchFn?: typeof syncMilestoneBranchWithDefault;
  runAgentFn?: typeof runClaudeWithRetry;
  runGitCommandFn?: typeof runGitCommand;
  /**
   * `gh` runner for the conflict report (Issue #1558). Absent leaves the
   * conflict in the log only.
   */
  ghCommandFn?: GhCommandFn;
  nowMs?: number;
}

/**
 * One pre-cut sync at a time per repository, within this process
 * (Issue #1780).
 *
 * `syncMilestoneBranchWithDefault` opens with `reset --hard` + `clean -fd` +
 * `checkout` in the shared `${WORK_DIR}/<repo>` clone. Since Issue #923 two
 * lanes can work one repository, so without this two child runs could reset
 * the tree under each other's merge — each losing the other's in-flight
 * resolution and both deferring for nothing. Serialising them costs a wait and
 * removes that whole class.
 *
 * It is an in-process chain, not a lease: it makes the runs this process
 * starts orderly. The periodic sweep's own merge in the same clone is outside
 * it, exactly as it was before this change.
 */
const repoPresyncChain = new Map<string, Promise<unknown>>();

/** Run `fn` after any pre-cut sync this process already has in `repo`. */
function serialisedPerRepo<T>(
  repo: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = repoPresyncChain.get(repo) ?? Promise.resolve();
  // A previous failure must not poison the chain — it is a queue, not a
  // dependency.
  const run = previous.catch(() => undefined).then(fn);
  repoPresyncChain.set(repo, run.catch(() => undefined));
  return run;
}

/** Read one ref's commit in a clone, naming what went wrong. */
async function readRefSha(
  ref: string,
  cwd: string,
  gitFn: typeof runGitCommand,
): Promise<Result<string>> {
  // `git rev-parse` prints `--end-of-options` back as a rev, so the guard is
  // the explicit ref check rather than the separator every other argv uses.
  assertSafeGitRef(ref, "milestone tip ref");
  const parsed = await gitFn(["rev-parse", ref], { cwd });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git rev-parse ${ref} exited ${parsed.value.code}: ` +
          (parsed.value.stderr.trim() || "no stderr"),
      ),
    };
  }
  const sha = parsed.value.stdout.trim();
  // A blank or non-commit answer is a read that did not happen, not a tip.
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return {
      ok: false,
      error: new Error(`git rev-parse ${ref} gave a non-SHA: '${sha}'`),
    };
  }
  return { ok: true, value: sha };
}

/**
 * One in-cycle sync attempt per (repo, milestone branch) until
 * {@link resetMilestoneArmSyncMemo} (Issue #2005).
 *
 * Completion, the priority 1.65 sweep and the post-scan sweep all ask the
 * same question — "can this milestone be brought level so a child can
 * arm?" — and must share one attempt. Two children of one milestone in
 * one cycle must not climb the ladder twice.
 */
const armSyncMemo = new Map<string, Promise<MilestonePresyncResult>>();

/** Memo key for {@link presyncMilestoneOnceForArming}. */
export function milestoneArmSyncKey(
  repo: string,
  milestoneBranch: string,
): string {
  return `${repo.toLowerCase()}#${milestoneBranch}`;
}

/** Drop the in-cycle arming-sync memo. Called at each main-loop iteration. */
export function resetMilestoneArmSyncMemo(): void {
  armSyncMemo.clear();
}

/**
 * The pre-cut sync, once per milestone per cycle (Issue #2005).
 *
 * Concurrent callers share the in-flight promise so two PRs on the same
 * branch cannot start two merges.
 */
export function presyncMilestoneOnceForArming(
  args: IssueRunPresyncArgs,
): Promise<MilestonePresyncResult> {
  const key = milestoneArmSyncKey(args.repo, args.milestoneBranch);
  const existing = armSyncMemo.get(key);
  if (existing) return existing;
  const pending = presyncMilestoneBranchForIssueRun(args);
  armSyncMemo.set(key, pending);
  return pending;
}

/**
 * Bind the in-cycle arming sync to one issue run or sweep (Issue #2005).
 *
 * The milestone branch comes from the gate at call time, so a recovered
 * PR whose base moved still syncs the branch it is actually on.
 */
export function bindIssueRunBehindSync(
  args: Omit<IssueRunPresyncArgs, "milestoneBranch" | "milestoneTitle"> & {
    milestoneTitle?: string;
  },
): (info: {
  milestoneBranch: string;
  behindBy: number;
}) => Promise<MilestonePresyncResult> {
  return (info) =>
    presyncMilestoneOnceForArming({
      ...args,
      milestoneTitle: args.milestoneTitle && args.milestoneTitle.length > 0
        ? args.milestoneTitle
        : info.milestoneBranch.replace(/^milestone\//, ""),
      milestoneBranch: info.milestoneBranch,
    });
}

/**
 * The pre-cut sync as an issue run performs it (Issue #1780).
 *
 * Binds {@link presyncMilestoneBranch} to real git, the run's conflict ledger
 * and — while the run's own deadline covers a whole run — the ladder's
 * resolution agent. The agent rung matters here: only an attempt that climbed
 * the whole ladder may charge the branch's budget, and the charge is what
 * paces every other slot off this milestone.
 *
 * @param args - The branch, the clone and the run's bounds
 * @returns `level`, `synced`, or `deferred` with the reason
 */
export async function presyncMilestoneBranchForIssueRun(
  args: IssueRunPresyncArgs,
): Promise<MilestonePresyncResult> {
  const {
    repo,
    milestoneTitle,
    milestoneBranch,
    defaultBranch,
    cwd,
    workDir,
    config,
    logger,
  } = args;
  const countBehindFn = args.countCommitsAheadFn ?? countCommitsAhead;
  const syncFn = args.syncMilestoneBranchFn ?? syncMilestoneBranchWithDefault;
  const runAgent = args.runAgentFn ?? runClaudeWithRetry;
  const gitFn = args.runGitCommandFn ?? runGitCommand;
  const ghFn = args.ghCommandFn;
  const nowMs = args.nowMs ?? Date.now();

  // The same grant the sweep computes (Issue #1778): the rung is offered only
  // while the run's deadline covers a whole agent run, and the timeout handed
  // out is never more time than the run actually holds.
  const grant = grantAgentRun({
    nowMs,
    ...(args.cycleDeadlineEpochMs !== undefined
      ? { deadlineEpochMs: args.cycleDeadlineEpochMs }
      : {}),
    agentTimeoutMs: config.claudeTimeout * 1000,
  });

  // One at a time per repository: the merge below resets and checks out the
  // shared clone, and two lanes can hold one repository since Issue #923.
  return await serialisedPerRepo(repo, () =>
    presyncMilestoneBranch({
      repo,
      milestoneBranch,
      defaultBranch,
      streakPath: milestoneSyncStreakPath(workDir),
      grant,
      nowMs,
    }, {
      countBehind: () =>
        countBehindFn(`origin/${milestoneBranch}`, `origin/${defaultBranch}`, {
          cwd,
        }),
      defaultTipSha: () => readLocalDefaultTip(defaultBranch, cwd),
      milestoneTipSha: () =>
        readRefSha(`origin/${milestoneBranch}`, cwd, gitFn),
      ...(ghFn
        ? {
          reportConflict: (conflict: MilestoneSyncConflict) =>
            escalateSyncConflict(
              repo,
              {
                milestoneTitle,
                // The report needs no milestone number: it comments where the
                // sweep's own report goes, keyed on the branch.
                milestoneNumber: 0,
                milestoneBranch,
                defaultBranch,
              },
              conflict,
              ghFn,
              (message: string) => logger.info(message),
            ),
        }
        : {}),
      syncBranch: (syncGrant) =>
        syncFn(
          milestoneBranch,
          defaultBranch,
          { cwd },
          // Issue #589: named so the sync can raise a PR when a repository
          // rule refuses the direct push.
          repo,
          // The default gates: the repository's own type check, and the
          // stricter resolution gate derived from it.
          undefined,
          undefined,
          // The ladder's last rung, bound exactly as the sweep binds it.
          bindMilestoneConflictAgent({
            repo,
            grant: syncGrant,
            config,
            logger,
            runAgent,
          }),
          logger,
        ),
      log: (message: string) => logger.info(message),
    }));
}
