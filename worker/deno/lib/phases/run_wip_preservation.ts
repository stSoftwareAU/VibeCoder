/**
 * Preserve an interrupted run's uncommitted work (Issues #47, #148, #218).
 *
 * The guarantee is simple and unconditional: a run that ends without raising
 * a PR must never discard what the agent produced. The work goes onto the
 * claim-locked issue branch as one `wip:` commit, pushed through the guarded
 * `commitAndPushPending` chokepoint, and the caller reports the result in the
 * release comment so the next claim (or a human) knows where the work is.
 *
 * Extracted from the execute phase's timeout branch (Issue #218) because the
 * completion phase needs exactly the same behaviour: its "no commits ahead …
 * uncommitted changes are present" failure described the loss without doing
 * anything about it, and on VibeCoder#185 51 minutes of work went with it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { PhaseState } from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { preserveTimedOutWip } from "../wip_checkpoint.ts";
import {
  describeHandoverFile,
  handoverFilePath,
  handoverFileUrl,
  type PreservedWip,
} from "../preserved_wip_branch.ts";

/** What preservation found and did. */
export interface PreservedRunWip {
  /**
   * Release-comment note naming what was preserved (or why preservation
   * failed). Absent only when there was nothing at all to preserve.
   */
  wipNote?: string;
  /**
   * Where the work now lives (Issue #770). Set ONLY when the work is on the
   * branch this run pushed — never when preservation failed and the work is
   * still local, because a comment naming a branch that was never pushed
   * sends a reader to a dead ref.
   */
  preserved?: PreservedWip;
  /** Uncommitted files present before preservation ran. */
  dirtyFiles: number;
  /** Commits this run had already added to the branch (#4170 checkpoints). */
  wipCommits: number;
  /** True when the working tree's work reached the remote branch. */
  pushed: boolean;
}

/**
 * Commits the current run added to the branch since the execute phase began
 * (VibeCoder#174) — i.e. WIP checkpoints (#4170) pushed while or after the
 * agent ran. Best effort: no start SHA or any git error resolves to 0.
 */
export async function commitsSinceExecuteStart(
  state: PhaseState,
  deps: WorkerDeps,
): Promise<number> {
  if (!state.executeStartHeadSha) return 0;
  const log = await deps.git.runGitCommand(
    ["rev-list", "--count", `${state.executeStartHeadSha}..HEAD`],
    { cwd: state.repoPath },
  );
  if (!log.ok || log.value.code !== 0) return 0;
  const n = parseInt(log.value.stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Uncommitted files in the clone. Any git error counts as 0. */
async function countDirtyFiles(
  state: PhaseState,
  deps: WorkerDeps,
): Promise<number> {
  const statusResult = await deps.git.runGitCommand(
    ["status", "--porcelain"],
    { cwd: state.repoPath },
  );
  if (!statusResult.ok || statusResult.value.code !== 0) return 0;
  return statusResult.value.stdout.trim().split("\n").filter((l) =>
    l.trim().length > 0
  ).length;
}

export interface PreserveRunWipOptions {
  state: PhaseState;
  deps: WorkerDeps;
  /** Commit subject for the one-shot preservation commit. */
  buildMessage: (dirtyFiles: number) => string;
  /**
   * The issue being worked (Issue #770) — used to look up the handover file
   * on the branch. Absent → the note names the branch alone.
   */
  issueNumber?: number;
  /** `owner/repo`, so the handover file can be linked rather than just named. */
  repo?: string;
  /**
   * Skip the working-tree inspection entirely (the execute phase's
   * zero-output timeout: the agent produced nothing, so anything dirty is
   * not its work). Defaults to true — inspect.
   */
  inspectWorkingTree?: boolean;
  /** Refresh durable resume state after a successful push (Issue #4170). */
  onPreserved?: () => Promise<void>;
}

/**
 * Describe where the work now is (Issue #770): the branch this run pushed,
 * plus the handover file (#769) when one is committed on it.
 *
 * The handover lookup asks git what is IN the branch's tree rather than what
 * is on disk, so the comment can only advertise a file a reader will actually
 * find there. Any git trouble degrades to "no handover file" — naming the
 * branch alone is correct, a broken link is not.
 */
async function resolvePreservedWip(
  options: PreserveRunWipOptions,
): Promise<PreservedWip> {
  const { state, deps, issueNumber, repo } = options;
  const branch = state.branchName;
  if (issueNumber === undefined) return { branch };
  const path = handoverFilePath(issueNumber);
  const listed = await deps.git.runGitCommand(
    ["ls-tree", "--name-only", "HEAD", "--", path],
    { cwd: state.repoPath },
  );
  const present = listed.ok && listed.value.code === 0 &&
    listed.value.stdout.trim() === path;
  if (!present) return { branch };
  return {
    branch,
    handoverPath: path,
    ...(repo ? { handoverUrl: handoverFileUrl(repo, branch, path) } : {}),
  };
}

/**
 * Preserve the working tree onto the claim-locked branch and describe the
 * outcome.
 *
 * Never throws and never fails the caller's phase: preservation is a
 * best-effort rescue, and a failure is reported in `wipNote` (Issue #47's
 * "uncommitted work remains only in the local clone") rather than swallowed.
 */
export async function preserveRunWip(
  options: PreserveRunWipOptions,
): Promise<PreservedRunWip> {
  const { state, deps } = options;
  const logger = deps.logger;
  const dirtyFiles = options.inspectWorkingTree === false
    ? 0
    : await countDirtyFiles(state, deps);
  // The phase-end checkpoint (#4170) may already have committed and pushed
  // the run's work before this counted dirty files — on VibeCoder#174 the
  // tree was clean, a WIP commit was on the branch, and the release comment
  // still said "without creating changes". Count what the run added so the
  // message tells the truth.
  const wipCommits = await commitsSinceExecuteStart(state, deps);

  if (dirtyFiles === 0) {
    if (wipCommits === 0) return { dirtyFiles, wipCommits, pushed: false };
    const preserved = await resolvePreservedWip(options);
    state.preservedWip = preserved;
    return {
      wipNote: `WIP preserved: ${wipCommits} checkpoint commit` +
        `${wipCommits === 1 ? "" : "s"} pushed to '${state.branchName}' ` +
        `— the next claim resumes from that branch (Issue #4170).` +
        describeHandoverFile(preserved),
      preserved,
      dirtyFiles,
      wipCommits,
      pushed: false,
    };
  }

  const preserved = await preserveTimedOutWip({
    repoPath: state.repoPath,
    branchName: state.branchName,
    message: options.buildMessage(dirtyFiles),
    logger: {
      info: (m: string) => logger.info(m),
      warn: (m: string) => logger.warn(m),
    },
    deps: {
      currentBranch: async (repoPath: string) => {
        const head = await deps.git.runGitCommand(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: repoPath },
        );
        if (!head.ok || head.value.code !== 0) return null;
        const branch = head.value.stdout.trim();
        return branch.length > 0 ? branch : null;
      },
      commitAndPush: (branch, message, repoPath) =>
        deps.git.commitAndPushPending(branch, message, { cwd: repoPath }),
    },
  });

  if (preserved.kind === "pushed") {
    await options.onPreserved?.().catch(() => undefined);
    const onBranch = await resolvePreservedWip(options);
    state.preservedWip = onBranch;
    return {
      wipNote: `WIP preserved: committed and pushed to '${state.branchName}' ` +
        `— the next claim resumes from that branch (Issue #47).` +
        describeHandoverFile(onBranch),
      preserved: onBranch,
      dirtyFiles,
      wipCommits,
      pushed: true,
    };
  }
  if (preserved.kind === "clean") {
    const onBranch = await resolvePreservedWip(options);
    state.preservedWip = onBranch;
    return {
      wipNote:
        `WIP already checkpointed on '${state.branchName}' (Issue #4170).` +
        describeHandoverFile(onBranch),
      preserved: onBranch,
      dirtyFiles,
      wipCommits,
      pushed: false,
    };
  }
  return {
    wipNote: `WIP preservation failed (${preserved.reason}) — uncommitted ` +
      `work remains only in the local clone (Issue #47)`,
    dirtyFiles,
    wipCommits,
    pushed: false,
  };
}
