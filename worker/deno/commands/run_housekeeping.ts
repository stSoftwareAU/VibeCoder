/**
 * Run-housekeeping command for the Vibe Coder worker (Issue #3502).
 *
 * Orchestrates the one-time startup housekeeping sequence and the signal-driven
 * cleanup previously hand-wired in bash (`worker/run_core.sh`):
 *
 *   --operation run      Run the startup housekeeping steps (disk-space, log
 *                        rotation, stale temp-file / work-dir / worktree /
 *                        session sweeps, and the once-at-startup branch
 *                        cleanup) in canonical order, each best-effort.
 *   --operation cleanup  Perform the one-shot cleanup the old `cleanup_on_exit`
 *                        trap did: terminate the caller's descendant processes
 *                        and remove the PID file.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type HousekeepingResult,
  runSignalCleanup,
  runStartupHousekeeping,
} from "../lib/run_housekeeping.ts";
import { resolveOriginDefaultBranch } from "../lib/run_bootstrap.ts";

/** Data returned by the run-housekeeping command. */
interface RunHousekeepingData {
  operation: string;
  housekeeping?: HousekeepingResult;
}

/** Coerce an arg value that may be number or string into a number. */
function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

export const runHousekeepingCommand: Command = {
  name: "run-housekeeping",
  description:
    "Run startup housekeeping and signal-driven cleanup (Issue #3502)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RunHousekeepingData>> {
    const operation = String(args["operation"] ?? "run");

    switch (operation) {
      case "run": {
        const home = typeof args["home"] === "string"
          ? args["home"]
          : (Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "");

        const workDir = typeof args["work-dir"] === "string"
          ? args["work-dir"]
          : (Deno.env.get("WORK_DIR") ?? `${home}/auto-issue-work`);

        const logDir = typeof args["log-dir"] === "string"
          ? args["log-dir"]
          : `${home}/logs`;

        const tmpDir = typeof args["tmp-dir"] === "string"
          ? args["tmp-dir"]
          : (Deno.env.get("TMPDIR") ?? "/tmp");

        // The branch clean-up runs in the worker's own checkout, so its
        // default branch is whatever origin says — never an assumed name.
        let defaultBranch: string;
        if (typeof args["default-branch"] === "string") {
          defaultBranch = args["default-branch"];
        } else {
          const resolved = await resolveOriginDefaultBranch(Deno.cwd());
          if (!resolved.ok) {
            return {
              success: false,
              message: `cannot resolve the checkout's default branch: ` +
                `${resolved.error.message} (pass --default-branch to name it)`,
            };
          }
          defaultBranch = resolved.value;
        }

        const githubUser = typeof args["github-user"] === "string"
          ? args["github-user"]
          : (Deno.env.get("GITHUB_USER") ?? "");

        const result = await runStartupHousekeeping(
          { workDir, logDir, tmpDir, defaultBranch, githubUser },
          config,
        );

        const failed = result.failures.length;
        return {
          success: true,
          message: failed === 0
            ? `Housekeeping complete: ${result.stepsRun.join(" -> ")}`
            : `Housekeeping complete with ${failed} failed step(s): ${
              result.failures.join(", ")
            }`,
          data: { operation, housekeeping: result },
        };
      }

      case "cleanup": {
        const selfPid = toOptionalNumber(args["pid"]) ?? Deno.pid;
        const pidFile = typeof args["pid-file"] === "string"
          ? args["pid-file"]
          : undefined;
        const maxWaitSeconds = toOptionalNumber(args["max-wait"]) ?? 5;

        await runSignalCleanup({ selfPid, pidFile, maxWaitSeconds });

        return {
          success: true,
          message: `Cleanup complete for PID ${selfPid}`,
          data: { operation },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown run-housekeeping operation: ${operation}`,
          data: { operation },
        };
    }
  },
};
