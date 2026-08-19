/**
 * Run entrypoint guard logic.
 *
 * Provides the PID guard with stale-process detection and command validation
 * used by the Deno worker driver (`run-entrypoint` command → run_worker.ts).
 *
 * Issue #919: Simplify run.sh and loop.sh to thin Deno launchers.
 * Issue #3504: the shadow-copy of `worker/run_core.sh` was removed — the worker
 *   driver now runs the migrated bootstrap + loop directly in one Deno process,
 *   so there is no bash script to shadow-copy. Deno loads its modules at process
 *   start, giving the running driver the same immunity to a mid-run `git reset`
 *   the shadow-copy used to provide.
 *
 * Australian English spelling throughout (behaviour, defence, authorised).
 */

import {
  getCommand,
  getElapsedSeconds,
  isExpectedRunCoreCommand,
  isRunning,
  terminateProcessTree,
} from "./pid_guard.ts";

/** Result of the run guard evaluation. */
export interface RunGuardResult {
  /** Whether to proceed ("proceed") or stop ("blocked"). */
  action: "proceed" | "blocked";
  /** Human-readable reason for the decision. */
  reason: string;
}

/** Default maximum run duration before treating a process as stale (3 hours). */
export const DEFAULT_MAX_RUN_SECONDS = 3 * 60 * 60;

/** Grace period (seconds) for SIGTERM before escalating to SIGKILL. */
const TERMINATE_GRACE_SECONDS = 30;

/**
 * The current boot's unique id, or null where the platform has none.
 *
 * Linux (every container) regenerates this per VM boot; macOS has no such
 * file, so native mode degrades to pure PID semantics — which are valid
 * there, because PIDs are host-wide.
 */
export async function readBootId(): Promise<string | null> {
  try {
    return (await Deno.readTextFile("/proc/sys/kernel/random/boot_id")).trim();
  } catch {
    return null;
  }
}

/**
 * Render the PID-file content: the PID line, plus the boot id when known so
 * {@link evaluateRunGuard} can discriminate boots. Unknown boot id keeps the
 * legacy single-line format.
 */
export function formatPidFileContent(
  pid: number,
  bootId: string | null,
): string {
  return bootId ? `${pid}\nboot:${bootId}\n` : `${pid}\n`;
}

/**
 * Evaluate the PID guard to decide whether this invocation should proceed.
 *
 * Replicates the logic from run.sh's inline PID guard:
 * 1. If no PID file or invalid content → proceed.
 * 2. If PID not running → proceed (stale file).
 * 3. If PID is running but not a run_core.sh process → PID reuse, remove file and proceed.
 * 4. If PID is a run_core.sh process and stale (elapsed >= max) → terminate and proceed.
 * 5. If PID is a run_core.sh process and not stale → blocked.
 *
 * @param pidFilePath - Path to the .run.pid file
 * @param maxRunSeconds - Maximum allowed run duration before stale termination
 * @returns Guard result indicating whether to proceed or block
 */
export async function evaluateRunGuard(
  pidFilePath: string,
  maxRunSeconds: number = DEFAULT_MAX_RUN_SECONDS,
  options: {
    bootId?: () => Promise<string | null>;
    /** The checking process's own PID — injectable for tests. */
    selfPid?: () => number;
  } = {},
): Promise<RunGuardResult> {
  // Try to read the PID file
  let content: string;
  try {
    content = await Deno.readTextFile(pidFilePath);
  } catch {
    return { action: "proceed", reason: "No PID file found" };
  }

  // Boot discrimination (container mode, observed live): inside every
  // container the worker ran as PID 1 until #4239 (now a child of the
  // bash reaper, though old pid files may still say 1), and PID 1 in a
  // fresh VM is always alive
  // — so after an unclean exit the liveness check below would block every
  // later cycle for up to maxRunSeconds ("blocked: Another instance is
  // running (PID 1)"). A boot id recorded beside the PID settles it: a
  // different boot id proves the writer's VM (or host boot) is gone,
  // whatever its PID was.
  const recordedBoot = content
    .split("\n")
    .find((line) => line.startsWith("boot:"))
    ?.slice("boot:".length)
    .trim();
  if (recordedBoot) {
    const currentBoot = await (options.bootId ?? readBootId)();
    if (currentBoot && currentBoot !== recordedBoot) {
      return {
        action: "proceed",
        reason:
          `PID file was written in a different boot (${recordedBoot}) — ` +
          `stale, this boot is ${currentBoot}`,
      };
    }
  }

  // Parse the PID
  const pidStr = content.split("\n")[0]?.trim() ?? "";
  if (!pidStr) {
    return { action: "proceed", reason: "PID file is empty — invalid content" };
  }

  const existingPid = parseInt(pidStr, 10);
  if (isNaN(existingPid) || existingPid <= 0) {
    return { action: "proceed", reason: "PID file contains invalid PID" };
  }

  // A file naming this very process is stale by construction (Issue #4211):
  // the guard runs before this process claims, so the file was written by an
  // earlier life of this PID. In-container the worker held PID 1 (pre-#4239
  // images; a low pid thereafter), so a
  // legacy boot-id-less file left by a crashed VM otherwise deadlocks every
  // later cycle: the liveness probe finds the checker itself, reads the
  // checker's own age (always tiny), and blocks — observed live as half an
  // hour of "blocked (PID 1, age=5s)" no-op cycles all reporting success.
  const selfPid = options.selfPid?.() ?? Deno.pid;
  if (existingPid === selfPid) {
    return {
      action: "proceed",
      reason: `PID file names this process itself (PID ${existingPid}) — ` +
        `stale by construction; a live claimant never re-runs its own guard`,
    };
  }

  // Check if process is running
  if (!(await isRunning(existingPid))) {
    return {
      action: "proceed",
      reason: `PID ${existingPid} is not running — stale PID file`,
    };
  }

  // Process is running — check if it is actually run_core.sh
  const command = await getCommand(existingPid);
  if (!isExpectedRunCoreCommand(command)) {
    // PID reuse: different process occupies this PID — remove stale file
    try {
      await Deno.remove(pidFilePath);
    } catch {
      // Best-effort removal
    }
    return {
      action: "proceed",
      reason: `PID ${existingPid} is not run_core — removing stale PID file`,
    };
  }

  // It is a run_core process — check elapsed time
  const elapsedSeconds = await getElapsedSeconds(existingPid);

  // Fail-safe: if we cannot determine age, do not kill — block instead
  if (elapsedSeconds === null) {
    return {
      action: "blocked",
      reason:
        `Cannot determine age of PID ${existingPid} — blocking to be safe`,
    };
  }

  if (elapsedSeconds >= maxRunSeconds) {
    // Stale process — terminate it
    await terminateProcessTree(existingPid, TERMINATE_GRACE_SECONDS);

    // Check if termination succeeded
    if (await isRunning(existingPid)) {
      return {
        action: "blocked",
        reason: `Failed to terminate stale PID ${existingPid}`,
      };
    }

    // Clean up PID file if it still references the same PID
    try {
      const currentContent = await Deno.readTextFile(pidFilePath);
      const currentPidStr = currentContent.split("\n")[0]?.trim() ?? "";
      if (currentPidStr === String(existingPid)) {
        await Deno.remove(pidFilePath);
      }
    } catch {
      // Best-effort cleanup
    }

    return {
      action: "proceed",
      reason: `Terminated stale PID ${existingPid} (age=${elapsedSeconds}s)`,
    };
  }

  // Process is active and not stale — block
  return {
    action: "blocked",
    reason: `Another instance is running (PID ${existingPid}, ` +
      `runtime ${elapsedSeconds}s of ${maxRunSeconds}s allowed)`,
  };
}
