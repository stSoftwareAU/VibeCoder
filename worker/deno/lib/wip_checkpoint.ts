/**
 * Periodic WIP checkpoint commits during the execute phase (Issue #4170).
 *
 * Observed live on host-23: a 70+ minute execute session had produced a
 * complete-looking change when the process was killed — nothing was
 * committed, so the hour of work (and its Fable-tier tokens) was discarded
 * and the issue restarted from zero. The issue branch is claim-locked to
 * this worker and a pushed WIP costs nothing (squashed on PR merge), so
 * every ~10 minutes — and once more at phase end — the checkpoint commits
 * whatever the agent has produced and pushes it to the issue branch.
 *
 * Each checkpoint runs through `commitAndPushPending` (git_push.ts), which
 * brings the existing chokepoint guards for free: the read-only
 * default-branch guard (#2584), the pre-commit secret/hidden-file gate
 * (#1758), and the run-id trailer (#2381). On top of that this module:
 *
 *  - verifies HEAD is still the issue branch first — the agent may be
 *    mid-rebase or on a detached HEAD, and a checkpoint must never commit
 *    someone else's state;
 *  - refuses protected branches outright;
 *  - collapses overlapping runs (a slow push must not stack);
 *  - treats every failure as a skipped tick, never a phase failure — the
 *    agent owns the working tree, and losing one checkpoint (for example
 *    to index.lock contention with the agent's own git commands) is fine
 *    because the next tick retries.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  commitAndPushPending,
  type CommitAndPushPendingResult,
} from "./git_push.ts";
import { runGitCommand } from "./git_timeout.ts";
import { isProtectedBranch } from "./git_branch.ts";
import {
  type MemoryPressureReading,
  probeMemoryPressure,
} from "./memory_pressure.ts";
import { WIP_CHECKPOINT_COMMIT_PREFIX } from "./wip_markers.ts";

/** Default milliseconds between checkpoint attempts. */
export const DEFAULT_WIP_CHECKPOINT_INTERVAL_MS = 10 * 60_000;

/** Default milliseconds between memory-pressure probes (Issue #4301). */
export const DEFAULT_PRESSURE_PROBE_INTERVAL_MS = 60_000;

/** Commit message for automatic checkpoints (squashed on PR merge). */
export const WIP_CHECKPOINT_COMMIT_MESSAGE =
  `${WIP_CHECKPOINT_COMMIT_PREFIX} periodic agent progress snapshot (Issue #4170)`;

/**
 * What actually stopped the execute run whose work is being preserved
 * (Issue #424, parent #397).
 *
 * Every one of these paths used to write "execute timed out", including the
 * OOM kill and the scheduled handover — a subject that was simply untrue for
 * three of the four.
 */
export type WipPreservationCause =
  /** The agent's own budget expired — a genuine per-issue timeout (Issue #47). */
  | "timed-out"
  /** SIGKILLed with no watchdog firing, typically the VM's OOM killer (Issue #4202). */
  | "killed"
  /** A SIGTERM the worker never requested (Issue #46). */
  | "external-sigterm"
  /** The cycle ended or the supervisor's hard cap was reached (Issue #424). */
  | "scheduled-release";

/** Subject phrase for each cause — the tail of the `wip:` commit subject. */
const WIP_CAUSE_PHRASE: Record<WipPreservationCause, string> = {
  "timed-out": "timed out",
  "killed": "was killed (SIGKILL, no watchdog)",
  "external-sigterm": "was killed by an external SIGTERM",
  "scheduled-release":
    "was released on schedule (cycle ended or run hard cap reached)",
};

/**
 * Commit message for the one-shot preservation of an interrupted execute
 * (Issue #47). Built here rather than inline at the call site so the
 * completion phase's WIP-only gate (Issue #148) recognises the same
 * subjects this worker writes — see `wip_commit_marker.ts`.
 *
 * The subject names the cause (Issue #424): a scheduled handover is not a
 * timeout, and saying so on the commit is the only record the next claimant
 * reads. The old " at the cycle deadline" variant is gone with the
 * truncation that produced it (Issue #420); the gate matches on the `wip:`
 * prefix, so branches still carrying either older subject are recognised
 * unchanged.
 */
export function buildInterruptedWipCommitMessage(options: {
  /** What stopped the run. */
  cause: WipPreservationCause;
  /** Seconds the execute ran before it was stopped. */
  elapsedSeconds: number;
  /** Uncommitted files the interruption left behind. */
  dirtyFiles: number;
}): string {
  return `wip: execute ${WIP_CAUSE_PHRASE[options.cause]} after ` +
    `${options.elapsedSeconds}s — preserving ${options.dirtyFiles} ` +
    `uncommitted file(s) (Issue #47)`;
}

/**
 * Commit message for preserving work the run left uncommitted when the
 * completion phase found the branch level with its base (Issue #218).
 *
 * The `wip:` prefix is deliberate: the completion phase's WIP-only gate
 * (Issue #148) must recognise this commit as parked work, so a later run
 * cannot raise a "finished" PR built from it alone.
 */
export function buildUncommittedWorkWipCommitMessage(options: {
  /** Uncommitted files the run left behind. */
  dirtyFiles: number;
}): string {
  return `wip: preserving ${options.dirtyFiles} uncommitted file(s) left by ` +
    `a run that raised no PR (Issue #218)`;
}

/** What a single checkpoint attempt did. */
export type WipCheckpointOutcome =
  | { kind: "pushed"; committed: boolean; commitsPushed: number }
  | { kind: "clean" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/** Injectable seams for tests. */
export interface WipCheckpointDeps {
  /** Resolve the branch HEAD currently points at (null when unknown). */
  currentBranch?: (repoPath: string) => Promise<string | null>;
  /** Commit-and-push chokepoint. Defaults to `commitAndPushPending`. */
  commitAndPush?: (
    branchName: string,
    message: string,
    repoPath: string,
  ) => Promise<Result<CommitAndPushPendingResult>>;
}

/** Options for {@link startWipCheckpoints}. */
export interface WipCheckpointOptions {
  /** The issue clone the agent is working in. */
  repoPath: string;
  /** The claim-locked issue branch checkpoints push to. */
  branchName: string;
  /** Milliseconds between attempts. Defaults to ten minutes. */
  intervalMs?: number;
  /** Logger for checkpoint outcomes. */
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  /**
   * Called after each successful checkpoint moment (pushed or already
   * clean) — the resume-state store hangs off this so its freshness
   * window tracks real checkpoints.
   */
  onCheckpoint?: (outcome: WipCheckpointOutcome) => void | Promise<void>;
  /**
   * Memory-pressure probe interval (Issue #4301). Between regular
   * checkpoints the loop probes guest memory this often and, when
   * pressure is high, takes an out-of-band checkpoint so an OOM kill
   * loses at most the last minute. Defaults to one minute; 0 disables.
   */
  pressureProbeIntervalMs?: number;
  /** Memory probe, injectable for tests. Defaults to /proc/meminfo. */
  probeMemory?: () => Promise<MemoryPressureReading>;
  /** Test seams. */
  deps?: WipCheckpointDeps;
}

/** Handle controlling a running checkpoint loop. */
export interface WipCheckpointHandle {
  /** Run one checkpoint immediately (also used for the phase-end final). */
  runNow(): Promise<WipCheckpointOutcome>;
  /** Stop the interval timer. Idempotent. */
  stop(): void;
}

/** Production HEAD resolution via `git rev-parse --abbrev-ref HEAD`. */
async function defaultCurrentBranch(repoPath: string): Promise<string | null> {
  const result = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
  });
  if (!result.ok || result.value.code !== 0) return null;
  const branch = result.value.stdout.trim();
  return branch.length > 0 ? branch : null;
}

/** One guarded checkpoint attempt, shared by the loop and the one-shot. */
async function attemptWipCheckpoint(opts: {
  repoPath: string;
  branchName: string;
  message: string;
  currentBranch: (repoPath: string) => Promise<string | null>;
  commitAndPush: (
    branch: string,
    message: string,
    repoPath: string,
  ) => Promise<Result<CommitAndPushPendingResult>>;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}): Promise<WipCheckpointOutcome> {
  try {
    if (isProtectedBranch(opts.branchName)) {
      return {
        kind: "skipped",
        reason: `'${opts.branchName}' is a protected branch`,
      };
    }
    const head = await opts.currentBranch(opts.repoPath);
    if (head !== opts.branchName) {
      return {
        kind: "skipped",
        reason: `HEAD is '${head ?? "unknown"}', expected '${opts.branchName}'`,
      };
    }
    const result = await opts.commitAndPush(
      opts.branchName,
      opts.message,
      opts.repoPath,
    );
    if (!result.ok) {
      opts.logger?.warn(
        `WIP checkpoint on ${opts.branchName} failed (non-fatal): ` +
          result.error.message,
      );
      return { kind: "failed", reason: result.error.message };
    }
    const { committedNewChanges, commitsPushed } = result.value;
    if (committedNewChanges || commitsPushed > 0) {
      opts.logger?.info(
        `WIP checkpoint: pushed ${commitsPushed} commit(s) to ` +
          `${opts.branchName}` +
          (committedNewChanges ? " (snapshotted uncommitted work)" : ""),
      );
      return {
        kind: "pushed",
        committed: committedNewChanges,
        commitsPushed,
      };
    }
    return { kind: "clean" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.logger?.warn(`WIP checkpoint threw (non-fatal): ${reason}`);
    return { kind: "failed", reason };
  }
}

/**
 * One-shot WIP preservation for a timed-out or killed execute (Issue #47).
 *
 * Unlike {@link startWipCheckpoints} this is NOT gated on session resume —
 * a hard timeout that leaves a dirty tree preserves the work
 * unconditionally: one commit on the claim-locked issue branch, pushed
 * through the same `commitAndPushPending` chokepoint (default-branch guard
 * #2584, secret/hidden-file gate #1758, run-id trailer #2381). The caller
 * reports the outcome in the release comment so the next claimant (or a
 * human) knows the branch carries the work.
 */
export function preserveTimedOutWip(options: {
  /** The issue clone the agent was working in. */
  repoPath: string;
  /** The claim-locked issue branch to preserve onto. */
  branchName: string;
  /** Commit message; explain the timeout so the WIP is self-describing. */
  message: string;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  /** Injectable seams for tests. */
  deps?: WipCheckpointDeps;
}): Promise<WipCheckpointOutcome> {
  const currentBranch = options.deps?.currentBranch ?? defaultCurrentBranch;
  const commitAndPush = options.deps?.commitAndPush ??
    ((branch: string, message: string, repoPath: string) =>
      commitAndPushPending(branch, message, { cwd: repoPath }));
  return attemptWipCheckpoint({
    repoPath: options.repoPath,
    branchName: options.branchName,
    message: options.message,
    currentBranch,
    commitAndPush,
    logger: options.logger,
  });
}

/**
 * Start the periodic checkpoint loop. The caller must `stop()` the handle
 * (typically in a `finally` around the agent run) and may call `runNow()`
 * once more for the phase-end checkpoint.
 */
export function startWipCheckpoints(
  options: WipCheckpointOptions,
): WipCheckpointHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_WIP_CHECKPOINT_INTERVAL_MS;
  const currentBranch = options.deps?.currentBranch ?? defaultCurrentBranch;
  const commitAndPush = options.deps?.commitAndPush ??
    ((branch: string, message: string, repoPath: string) =>
      commitAndPushPending(branch, message, { cwd: repoPath }));
  const logger = options.logger;
  let running = false;

  const checkpointOnce = async (): Promise<WipCheckpointOutcome> => {
    if (running) {
      return { kind: "skipped", reason: "previous checkpoint still running" };
    }
    running = true;
    try {
      const outcome = await attemptWipCheckpoint({
        repoPath: options.repoPath,
        branchName: options.branchName,
        message: WIP_CHECKPOINT_COMMIT_MESSAGE,
        currentBranch,
        commitAndPush,
        logger,
      });
      if (outcome.kind === "pushed" || outcome.kind === "clean") {
        await options.onCheckpoint?.(outcome);
      }
      return outcome;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void checkpointOnce();
  }, intervalMs);

  // Pre-OOM checkpoint (Issue #4301): the guest has no swap, so a memory
  // peak kills the agent outright (exit 137). Probe pressure between the
  // regular ticks and checkpoint early when it turns high — once per
  // pressure episode, so a sustained squeeze does not stack pushes.
  const probeIntervalMs = options.pressureProbeIntervalMs ??
    DEFAULT_PRESSURE_PROBE_INTERVAL_MS;
  const probe = options.probeMemory ?? (() => probeMemoryPressure());
  let pressureEpisode = false;
  const pressureTimer = probeIntervalMs > 0
    ? setInterval(() => {
      void (async () => {
        const reading = await probe();
        if (reading.level === "high") {
          if (pressureEpisode) return;
          pressureEpisode = true;
          const available = reading.availableBytes !== undefined
            ? `${Math.round(reading.availableBytes / (1024 * 1024))}MB`
            : "unknown";
          logger?.warn(
            `Guest memory pressure high (available ${available}) — taking ` +
              `an early WIP checkpoint before a possible OOM kill (Issue #4301)`,
          );
          await checkpointOnce();
        } else if (reading.level === "ok") {
          pressureEpisode = false;
        }
      })();
    }, probeIntervalMs)
    : undefined;

  return {
    runNow: checkpointOnce,
    stop: () => {
      clearInterval(timer);
      if (pressureTimer) clearInterval(pressureTimer);
    },
  };
}
