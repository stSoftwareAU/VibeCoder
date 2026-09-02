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
import {
  preserveTimedOutWip,
  type WipPreservationCause,
} from "../wip_checkpoint.ts";
import { writeHandoverNote } from "../handover_note.ts";

/** What preservation found and did. */
export interface PreservedRunWip {
  /**
   * Release-comment note naming what was preserved (or why preservation
   * failed). Absent only when there was nothing at all to preserve.
   */
  wipNote?: string;
  /** Uncommitted files present before preservation ran. */
  dirtyFiles: number;
  /** Commits this run had already added to the branch (#4170 checkpoints). */
  wipCommits: number;
  /** True when the working tree's work reached the remote branch. */
  pushed: boolean;
  /**
   * Repo-relative path of the handover note committed alongside the work
   * (Issue #769). Absent when no note was written — a run with nothing to
   * hand over, a clone that is not a git repository, or a failed write.
   */
  handoverPath?: string;
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

/**
 * Repo-relative paths of the uncommitted files in the clone. Any git error
 * yields an empty list, which the caller reads as "nothing to preserve".
 */
async function listDirtyFiles(
  state: PhaseState,
  deps: WorkerDeps,
): Promise<string[]> {
  const statusResult = await deps.git.runGitCommand(
    ["status", "--porcelain"],
    { cwd: state.repoPath },
  );
  if (!statusResult.ok || statusResult.value.code !== 0) return [];
  return statusResult.value.stdout.split("\n")
    .filter((line) => line.trim().length > 0)
    // Porcelain v1: two status columns, a space, then the path. A rename
    // reads `R  old -> new`; the new path is the one that matters.
    .map((line) => line.slice(3).trim())
    .map((path) => path.split(" -> ").pop() ?? path)
    .map((path) => path.replace(/^"|"$/g, ""))
    .filter((path) => path.length > 0);
}

/**
 * Subjects of the commits this run added to the branch, newest first — the
 * "what was done" the handover note reports (Issue #769). Best effort: no
 * start SHA or any git error yields an empty list.
 */
async function wipCommitSubjects(
  state: PhaseState,
  deps: WorkerDeps,
): Promise<string[]> {
  if (!state.executeStartHeadSha) return [];
  const log = await deps.git.runGitCommand(
    ["log", "--format=%s", `${state.executeStartHeadSha}..HEAD`],
    { cwd: state.repoPath },
  );
  if (!log.ok || log.value.code !== 0) return [];
  return log.value.stdout.split("\n").map((s) => s.trim()).filter((s) =>
    s.length > 0
  );
}

export interface PreserveRunWipOptions {
  state: PhaseState;
  deps: WorkerDeps;
  /** Commit subject for the one-shot preservation commit. */
  buildMessage: (dirtyFiles: number) => string;
  /**
   * Skip the working-tree inspection entirely (the execute phase's
   * zero-output timeout: the agent produced nothing, so anything dirty is
   * not its work). Defaults to true — inspect.
   */
  inspectWorkingTree?: boolean;
  /** Refresh durable resume state after a successful push (Issue #4170). */
  onPreserved?: () => Promise<void>;
  /**
   * Facts for the portable handover note committed beside the work
   * (Issue #769). Omitted — the completion phase's #218 rescue — no note is
   * written and preservation behaves exactly as it did before.
   */
  handover?: {
    /** The issue whose branch is being preserved. */
    issueNumber: number;
    /** What stopped the run. */
    cause: WipPreservationCause;
    /** Seconds the execute ran before it was stopped. */
    elapsedSeconds: number;
  };
}

/** Commit subject when the handover note is the only thing to commit. */
export function buildHandoverOnlyWipCommitMessage(
  issueNumber: number,
): string {
  return `wip: handover note for the interrupted run on issue ` +
    `#${issueNumber} (Issue #769)`;
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
  const dirtyPaths = options.inspectWorkingTree === false
    ? []
    : await listDirtyFiles(state, deps);
  const dirtyFiles = dirtyPaths.length;
  // The phase-end checkpoint (#4170) may already have committed and pushed
  // the run's work before this counted dirty files — on VibeCoder#174 the
  // tree was clean, a WIP commit was on the branch, and the release comment
  // still said "without creating changes". Count what the run added so the
  // message tells the truth.
  const wipCommits = await commitsSinceExecuteStart(state, deps);

  // The handover note (Issue #769) goes into the tree BEFORE the commit, so
  // the same `commitAndPushPending` that preserves the code carries the note
  // with it. It is written whenever this run has something to hand over —
  // uncommitted work, or checkpoint commits a later claim will resume from.
  const handoverPath = options.handover && (dirtyFiles > 0 || wipCommits > 0)
    ? (await writeHandoverNote({
      repoPath: state.repoPath,
      facts: {
        issueNumber: options.handover.issueNumber,
        branch: state.branchName,
        cause: options.handover.cause,
        elapsedSeconds: options.handover.elapsedSeconds,
        interruptedAtIso: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        dirtyFiles: dirtyPaths,
        wipCommitSubjects: await wipCommitSubjects(state, deps),
      },
      logger: {
        info: (m: string) => logger.info(m),
        warn: (m: string) => logger.warn(m),
      },
    })).path
    : undefined;

  if (dirtyFiles === 0 && handoverPath === undefined) {
    return {
      ...(wipCommits > 0
        ? {
          wipNote: `WIP preserved: ${wipCommits} checkpoint commit` +
            `${wipCommits === 1 ? "" : "s"} pushed to '${state.branchName}' ` +
            `— the next claim resumes from that branch (Issue #4170)`,
        }
        : {}),
      dirtyFiles,
      wipCommits,
      pushed: false,
    };
  }

  const preserved = await preserveTimedOutWip({
    repoPath: state.repoPath,
    branchName: state.branchName,
    // A clean tree still needs a commit when the note is the only new file.
    message: dirtyFiles > 0
      ? options.buildMessage(dirtyFiles)
      : buildHandoverOnlyWipCommitMessage(options.handover?.issueNumber ?? 0),
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

  const handoverNote = handoverPath
    ? ` with a handover note at '${handoverPath}'`
    : "";

  if (preserved.kind === "pushed") {
    await options.onPreserved?.().catch(() => undefined);
    return {
      wipNote: (dirtyFiles > 0
        ? `WIP preserved: committed and pushed to '${state.branchName}'` +
          handoverNote
        // Nothing was dirty: the checkpoints already hold the work and this
        // commit carried the note alone. Say so, rather than claiming the
        // working tree was rescued.
        : `WIP preserved: ${wipCommits} checkpoint commit` +
          `${wipCommits === 1 ? "" : "s"} pushed to '${state.branchName}'` +
          handoverNote) +
        ` — the next claim resumes from that branch (Issue #47)`,
      dirtyFiles,
      wipCommits,
      pushed: true,
      ...(handoverPath ? { handoverPath } : {}),
    };
  }
  if (preserved.kind === "clean") {
    return {
      wipNote:
        `WIP already checkpointed on '${state.branchName}' (Issue #4170)`,
      dirtyFiles,
      wipCommits,
      pushed: false,
      ...(handoverPath ? { handoverPath } : {}),
    };
  }
  return {
    wipNote: `WIP preservation failed (${preserved.reason}) — uncommitted ` +
      `work remains only in the local clone (Issue #47)`,
    dirtyFiles,
    wipCommits,
    ...(handoverPath ? { handoverPath } : {}),
    pushed: false,
  };
}
