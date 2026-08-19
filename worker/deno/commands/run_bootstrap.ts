/**
 * Run-bootstrap command for the Vibe Coder worker (Issue #3501).
 *
 * Runs the worker bootstrap prelude — PATH resolution, run-id / `VIBE_RUN_ID`,
 * worker log initialisation, git reset to the default branch, and the periodic
 * software-update check — in a single Deno process, replacing the bash
 * orchestration glue previously in `worker/run_core.sh`.
 *
 * With `--shell-exports` the command prints `export KEY=VALUE` lines the calling
 * shell can `eval` to inherit the established PATH, `VIBE_RUN_ID`, and log-file
 * path during the incremental migration. A failed git reset exits non-zero so
 * the shell fails loud (Issue #3234) before evaluating any exports.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type BootstrapEnv,
  runBootstrap,
  toShellExports,
} from "../lib/run_bootstrap.ts";
import {
  skipSoftwareUpdateFromEnv,
  softwareUpdateOptionsFromEnv,
} from "../lib/software_updates.ts";

/** Data returned by the run-bootstrap command. */
interface RunBootstrapData {
  env: BootstrapEnv;
  stepsRun: string[];
  error?: string;
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

export const runBootstrapCommand: Command = {
  name: "run-bootstrap",
  description:
    "Run the worker bootstrap prelude (PATH, run-id, log init, git reset, updates)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RunBootstrapData>> {
    const repoDir = typeof args["repo-dir"] === "string"
      ? args["repo-dir"]
      : "";
    if (!repoDir) {
      return {
        success: false,
        message: "ERROR: --repo-dir is required",
      };
    }

    const home = typeof args["home"] === "string"
      ? args["home"]
      : (Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "");

    const logDir = typeof args["log-dir"] === "string"
      ? args["log-dir"]
      : `${home}/logs`;

    const currentPath = typeof args["current-path"] === "string"
      ? args["current-path"]
      : (Deno.env.get("PATH") ?? "");

    const fallbackPaths = typeof args["fallback-paths"] === "string"
      ? args["fallback-paths"]
      : (Deno.env.get("VIBE_FALLBACK_PATHS") ?? undefined);

    // Omitted, the prelude resolves the checkout's own default branch from
    // origin/HEAD — no repository or branch name is assumed.
    const defaultBranch = typeof args["default-branch"] === "string"
      ? args["default-branch"]
      : undefined;

    const pid = toOptionalNumber(args["pid"]) ?? Deno.pid;

    const skipSoftwareUpdate = args["skip-software-update"] === true ||
      skipSoftwareUpdateFromEnv();

    const result = await runBootstrap({
      repoDir,
      logDir,
      home,
      currentPath,
      fallbackPaths,
      defaultBranch,
      pid,
      skipSoftwareUpdate,
      // Shared builder so this path and `run-entrypoint` cannot drift
      // (Issue #3655).
      softwareUpdate: {
        ...softwareUpdateOptionsFromEnv(config),
        timestampDir: Deno.env.get("SOFTWARE_UPDATE_TIMESTAMP_DIR") ?? home,
      },
    });

    if (!result.ok) {
      return {
        success: false,
        message: `ERROR: bootstrap failed: ${result.error ?? "unknown error"}`,
        data: {
          env: result.env,
          stepsRun: result.stepsRun,
          error: result.error,
        },
      };
    }

    const message = args["shell-exports"] === true
      ? toShellExports(result.env)
      : `Bootstrap complete: ${result.stepsRun.join(" -> ")}`;

    return {
      success: true,
      message,
      data: { env: result.env, stepsRun: result.stepsRun },
    };
  },
};
