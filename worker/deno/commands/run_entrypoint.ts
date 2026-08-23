/**
 * Run entrypoint command — the full Deno worker driver.
 *
 * The container entrypoint `exec`s Deno directly on this command, inside the
 * container `run.sh` / `run.ps1` launched. After the PID
 * guard passes it runs the migrated bootstrap prelude, startup housekeeping,
 * and the run-core main loop in a single Deno process — with no bash on the
 * runtime path. This replaced the previous shadow-copy-and-exec-bash mechanism
 * (`worker/run_core.sh` → `worker/.run_core.sh`), which is now deleted.
 *
 * Issue #919: original thin Deno launcher.
 * Issue #3504: rewired to drive the whole run directly (drop the run_core.sh
 *   shadow-copy) — the orchestration lives in {@link runWorker}.
 *
 * Australian English spelling throughout (behaviour, defence, authorised).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { DEFAULT_MAX_RUN_SECONDS } from "../lib/run_entrypoint.ts";
import { runWorker, type RunWorkerOutcome } from "../lib/run_worker.ts";
import { setSelfHealEventsWorkDir } from "../lib/self_heal_events.ts";

/** Data returned by the run-entrypoint command. */
interface RunEntrypointData {
  /** What the driver did. */
  outcome: RunWorkerOutcome;
  /** Process exit code surfaced to the launcher. */
  exitCode: number;
  /** Human-readable reason for the outcome. */
  reason: string;
}

/**
 * Run entrypoint command.
 *
 * Args:
 *   --base-dir <string>         Project root directory (required)
 *   --max-run-seconds <number>  Maximum run duration before stale termination
 *                               (default: 10800)
 */
export const runEntrypointCommand: Command = {
  name: "run-entrypoint",
  description:
    "Full worker driver: PID guard, bootstrap, housekeeping, and main loop " +
    "(Issue #3504)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RunEntrypointData>> {
    const baseDir = String(args["base-dir"] ?? "");
    if (!baseDir) {
      return {
        success: false,
        message: "BLOCKED: No --base-dir specified",
        data: {
          outcome: "config-invalid",
          exitCode: 1,
          reason: "No --base-dir specified",
        },
      };
    }

    const maxRunSeconds = typeof args["max-run-seconds"] === "number"
      ? args["max-run-seconds"]
      : typeof args["max-run-seconds"] === "string"
      ? parseInt(args["max-run-seconds"], 10)
      : DEFAULT_MAX_RUN_SECONDS;

    // Wire the self-heal event sink (Issue #4250). This is the one place
    // production supplies it — the resolution the sink itself used to
    // apply (WORK_DIR, then HOME), moved here so importing an emitting
    // module in a test can never write to the operator's real log. The
    // location is unchanged: ~/logs/self-heal.jsonl when WORK_DIR is
    // unset, exactly as before.
    setSelfHealEventsWorkDir(
      Deno.env.get("WORK_DIR") ?? Deno.env.get("HOME") ?? undefined,
    );

    const result = await runWorker({ baseDir, config, maxRunSeconds });

    // A zero exit code is a successful outcome (including a clean "blocked" —
    // another instance is running). A non-zero exit code (bootstrap failure,
    // invalid config, unresolvable user, or a failed loop) fails loud so the
    // command framework surfaces exit 1 (Issue #3234).
    //
    // Issue #342: a quota pause is the third case — a clean, deliberate stop
    // that must reach the supervisor under its own status, so the exit code
    // is named here rather than collapsed into the 0/1 default.
    const quotaPaused = result.outcome === "quota-paused";
    return {
      success: result.exitCode === 0 || quotaPaused,
      message: `${result.outcome.toUpperCase()}: ${result.reason}`,
      exitCode: result.exitCode,
      data: {
        outcome: result.outcome,
        exitCode: result.exitCode,
        reason: result.reason,
      },
    };
  },
};
