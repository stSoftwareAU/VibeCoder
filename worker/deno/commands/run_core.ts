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
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
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
  /** The run stopped because the host is out of quota (Issue #342). */
  quotaPaused: boolean;
  /** When that quota window reopens, in epoch milliseconds, when known. */
  quotaResetEpochMs?: number;
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
          quotaPaused: false,
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
            quotaPaused: false,
          },
        };
      }

      // Issue #3138: stamp the worker build at startup so an outdated host
      // (running a build from before a guard fix merged) is detectable from
      // the logs, and fail loud on an incomplete fleet configuration that
      // would blind the open-PR duplicate guard to a sibling's PRs.
      console.log(formatBuildBanner(resolveWorkerBuildInfo()));
      // Issue #256, #1066: state the trust model this run used, next to the
      // build banner. Reading a worker log later, "who did this host trust?"
      // must be answerable from the log alone — the answer changes what every
      // claim, comment classification and PR guard decision meant.
      console.log(
        `[trust-source] who may direct work is resolved each cycle from the ` +
          `write/maintain/admin collaborators of the ` +
          `${(_config.repos ?? []).length} monitored repo(s), minus the ` +
          `Vibe Coder logins and bots; a resolve failure skips the cycle ` +
          `rather than falling back to the local allowed_authors array, ` +
          `which grants nothing. Input (test results, reviews, PR comments) ` +
          `is additionally accepted from the Vibe Coders and the ` +
          `${_config.authorisedCommenters.length} known ` +
          `authorized_commenters login(s).`,
      );

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

      return {
        // Issue #563: a fatal error is a failed run whatever else is true of
        // it. Without this the launcher read `COMPLETED` and exit 0 for a run
        // that died in its main loop, so nothing backed off or escalated.
        success: !result.fatalError &&
          (result.plannedShutdown || !result.exitedOnFailures),
        message:
          `Run complete: ${result.exitReason} (${result.issuesProcessed} issues processed in ${result.durationSeconds}s)`,
        data: {
          plannedShutdown: result.plannedShutdown,
          issuesProcessed: result.issuesProcessed,
          durationSeconds: result.durationSeconds,
          exitReason: result.exitReason,
          quotaPaused: result.quotaPaused,
          ...(result.quotaResetEpochMs !== undefined
            ? { quotaResetEpochMs: result.quotaResetEpochMs }
            : {}),
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
        quotaPaused: false,
      },
    };
  },
};
