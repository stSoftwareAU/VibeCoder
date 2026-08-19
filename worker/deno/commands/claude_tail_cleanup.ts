/**
 * Orphaned Claude-tail cleanup command (Issue #1906).
 *
 * Invoked from `worker/run_core.sh` during the startup self-healing
 * phase. Sweeps `tail -f /tmp/claude-${uid}/.../tasks/<id>.output`
 * processes that have been reparented to PID 1 (orphaned after a
 * previous worker died unexpectedly, e.g. via SIGKILL). The PPID=1
 * filter guarantees concurrent worker instances are not disturbed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  cleanupOrphanedClaudeTailsProd,
  type CleanupResult,
} from "../lib/claude_tail_cleanup.ts";

export const claudeTailCleanupCommand: Command = {
  name: "claude-tail-cleanup",
  description:
    "Sweep orphaned Claude `tail -f` task-output processes (Issue #1906)",

  async execute(
    _args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<CleanupResult>> {
    const result = await cleanupOrphanedClaudeTailsProd();

    const message = result.killed.length === 0 && result.failed.length === 0
      ? "No orphaned Claude tail processes found"
      : `Killed ${result.killed.length} orphaned Claude tail process(es)${
        result.failed.length > 0
          ? `; ${result.failed.length} kill(s) failed`
          : ""
      }`;

    return {
      success: true,
      message,
      data: result,
    };
  },
};
