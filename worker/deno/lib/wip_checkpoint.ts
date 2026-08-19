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

/** Default milliseconds between checkpoint attempts. */
export const DEFAULT_WIP_CHECKPOINT_INTERVAL_MS = 10 * 60_000;

/** Default milliseconds between memory-pressure probes (Issue #4301). */
export const DEFAULT_PRESSURE_PROBE_INTERVAL_MS = 60_000;

/** Commit message for automatic checkpoints (squashed on PR merge). */
export const WIP_CHECKPOINT_COMMIT_MESSAGE =
  "WIP checkpoint: periodic agent progress snapshot (Issue #4170)";

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
      if (isProtectedBranch(options.branchName)) {
        return {
          kind: "skipped",
          reason: `'${options.branchName}' is a protected branch`,
        };
      }
      const head = await currentBranch(options.repoPath);
      if (head !== options.branchName) {
        return {
          kind: "skipped",
          reason: `HEAD is '${
            head ?? "unknown"
          }', expected '${options.branchName}'`,
        };
      }
      const result = await commitAndPush(
        options.branchName,
        WIP_CHECKPOINT_COMMIT_MESSAGE,
        options.repoPath,
      );
      if (!result.ok) {
        logger?.warn(
          `WIP checkpoint on ${options.branchName} failed (non-fatal, ` +
            `next tick retries): ${result.error.message}`,
        );
        return { kind: "failed", reason: result.error.message };
      }
      const { committedNewChanges, commitsPushed } = result.value;
      let outcome: WipCheckpointOutcome;
      if (committedNewChanges || commitsPushed > 0) {
        outcome = {
          kind: "pushed",
          committed: committedNewChanges,
          commitsPushed,
        };
        logger?.info(
          `WIP checkpoint: pushed ${commitsPushed} commit(s) to ` +
            `${options.branchName}` +
            (committedNewChanges ? " (snapshotted uncommitted work)" : ""),
        );
      } else {
        outcome = { kind: "clean" };
      }
      await options.onCheckpoint?.(outcome);
      return outcome;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger?.warn(`WIP checkpoint threw (non-fatal): ${reason}`);
      return { kind: "failed", reason };
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
