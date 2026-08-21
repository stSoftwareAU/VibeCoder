/**
 * Command wrapper for run_core — main event loop.
 *
 * Exposes the run_core module as a Deno command for the command registry.
 *
 * Issue #968: Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { createDefaultRunCoreConfig, runCoreLoop } from "../lib/run_core.ts";
import {
  createProductionRunCoreDeps,
  runEndOfRunHealthReport,
} from "../lib/run_core_production_deps.ts";
import {
  formatBuildBanner,
  resolveWorkerBuildInfo,
} from "../lib/worker_build_info.ts";
import {
  formatFleetConfigValidation,
  validateFleetConfig,
} from "../lib/fleet_config_validation.ts";

/** Command result data for run-core. */
interface RunCoreCommandData {
  plannedShutdown: boolean;
  issuesProcessed: number;
  durationSeconds: number;
  exitReason: string;
}

/**
 * run-core command — starts the main worker event loop.
 *
 * This command is the top-level entry point for the Deno worker.
 * In practice, it is called from the shell orchestration layer
 * (run.sh → run_core.sh) which provides the full dependency wiring.
 *
 * When invoked via the command registry (e.g. for testing or dry-run),
 * it returns the default configuration without running the actual loop,
 * since the full dependency wiring requires the production environment.
 */
export const runCoreCommand: Command = {
  name: "run-core",
  description:
    "Main worker event loop with priority dispatch and signal handling (Issue #968)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<RunCoreCommandData>> {
    const operation = args["operation"] as string | undefined;

    if (operation === "default-config") {
      const config = createDefaultRunCoreConfig();
      return {
        success: true,
        message: "Default run-core configuration",
        data: {
          plannedShutdown: false,
          issuesProcessed: 0,
          durationSeconds: config.runDurationSeconds,
          exitReason: "not started",
        },
      };
    }

    if (operation === "run") {
      const repoDir = (args["repo-dir"] as string) ??
        (args["repoDir"] as string) ??
        Deno.env.get("REPO_DIR") ?? Deno.cwd();
      const workDir = (args["work-dir"] as string) ??
        (args["workDir"] as string) ??
        Deno.env.get("WORK_DIR") ??
        `${Deno.env.get("HOME") ?? "~"}/.vibe-coder`;
      const githubUser = (args["github-user"] as string) ??
        (args["githubUser"] as string) ??
        Deno.env.get("GITHUB_USER") ?? "";

      if (!githubUser) {
        return {
          success: false,
          message: "Missing --github-user or GITHUB_USER environment variable",
          data: {
            plannedShutdown: false,
            issuesProcessed: 0,
            durationSeconds: 0,
            exitReason: "missing github-user",
          },
        };
      }

      // Issue #3138: stamp the worker build at startup so an outdated host
      // (running a build from before a guard fix merged) is detectable from
      // the logs, and fail loud on an incomplete fleet configuration that
      // would blind the open-PR duplicate guard to a sibling's PRs.
      console.log(formatBuildBanner(resolveWorkerBuildInfo()));
      const fleetValidation = validateFleetConfig({
        githubUser,
        allowedAuthors: _config.allowedAuthors,
        fleetPrAuthors: _config.fleetPrAuthors ?? [],
        // Issue #209: siblings listed only under `service_accounts` are
        // fleet accounts too — the effective set the log names must say so.
        serviceAccounts: _config.serviceAccounts ?? [],
      });
      for (const line of formatFleetConfigValidation(fleetValidation)) {
        if (fleetValidation.level === "ok") {
          console.log(line);
        } else {
          console.error(line);
        }
      }

      const { deps, config: coreConfig } = await createProductionRunCoreDeps({
        repoDir,
        workDir,
        githubUser,
        config: _config,
      });

      const result = await runCoreLoop(coreConfig, deps);

      // FLEET health reporting at end of run (best-effort).
      // Issue #2602: only report healthy when the worker's last health checks
      // passed. A run that could not authenticate (e.g. Claude 401 every
      // cycle) must NOT report itself healthy — skipping the report lets the
      // host go stale on the dashboard so the failure stays visible.
      if (result.lastHealthCheckPassed) {
        try {
          await runEndOfRunHealthReport(repoDir);
        } catch { /* FLEET health is best-effort */ }
      } else {
        console.error(
          "Skipping end-of-run FLEET health report — last health check failed " +
            "(worker is unhealthy, not reporting healthy). Issue #2602",
        );
      }

      return {
        success: result.plannedShutdown || !result.exitedOnFailures,
        message:
          `Run complete: ${result.exitReason} (${result.issuesProcessed} issues processed in ${result.durationSeconds}s)`,
        data: {
          plannedShutdown: result.plannedShutdown,
          issuesProcessed: result.issuesProcessed,
          durationSeconds: result.durationSeconds,
          exitReason: result.exitReason,
        },
      };
    }

    // Default: return info about the command
    return {
      success: true,
      message:
        "run-core command available. Use --operation run to start the main loop, " +
        "--operation default-config to get defaults.",
      data: {
        plannedShutdown: false,
        issuesProcessed: 0,
        durationSeconds: 0,
        exitReason: "not started — command registry invocation",
      },
    };
  },
};
