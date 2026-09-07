/**
 * Software updates command for the Vibe Coder worker.
 *
 * Orchestrates weekly software update checks for Claude CLI, GH CLI, and Deno.
 * Callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Migrated from worker/shared/software_updates.sh (Issue #906).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { createLogger } from "../lib/logger.ts";
import {
  checkSoftwareUpdates,
  softwareUpdateOptionsFromEnv,
  type SoftwareUpdateRunOutcome,
} from "../lib/software_updates.ts";
import { coercePositiveIntFlag } from "../lib/command_args.ts";

interface SoftwareUpdateData {
  timestampDir: string;
  /** What the run did — machine-readable under OUTPUT_JSON (Issue #1270). */
  outcome: SoftwareUpdateRunOutcome;
}

/**
 * Software updates command implementation.
 *
 * Args:
 *   --timestamp-dir <string>  Directory for timestamp file (default: HOME)
 *   --interval <number>       Check interval in seconds (default: 604800 = 7 days)
 *   --timeout <number>        Timeout per update command in seconds (default: 120)
 *   --skip-claude             Skip Claude CLI update
 *   --skip-gh                 Skip GH CLI update
 *   --skip-deno               Skip Deno update
 *
 * `--interval` and `--timeout` must be positive whole numbers of seconds; an
 * unreadable value (an empty shell expansion, a valueless trailing flag) is
 * refused with a non-zero exit rather than passed on as `NaN` (Issue #1270).
 * The exit status reflects what the run did: a tool update that was attempted
 * and failed exits non-zero, and the final line names the tools attempted,
 * skipped or failed instead of always claiming a completed check.
 */
export const softwareUpdatesCommand: Command = {
  name: "software-updates",
  description:
    "Check for and install software updates (Claude CLI, GH CLI, Deno)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<SoftwareUpdateData>> {
    const timestampDir = typeof args["timestamp-dir"] === "string"
      ? args["timestamp-dir"]
      : (Deno.env.get("SOFTWARE_UPDATE_TIMESTAMP_DIR") ??
        Deno.env.get("HOME") ??
        Deno.env.get("USERPROFILE") ?? ".");

    // Issue #1270: `--interval ""` (a wrapper expanding an unset-but-quoted
    // variable) used to reach `parseInt` and pass NaN straight through `??`.
    // A NaN interval closes the update gate forever and a NaN timeout aborts
    // every install — both while this command still exits 0 saying the check
    // completed. Unreadable durations are refused here instead.
    const intervalResult = coercePositiveIntFlag(args["interval"], "interval");
    if (!intervalResult.ok) {
      return { success: false, message: intervalResult.error.message };
    }
    const intervalSeconds = intervalResult.value;

    const timeoutResult = coercePositiveIntFlag(args["timeout"], "timeout");
    if (!timeoutResult.ok) {
      return { success: false, message: timeoutResult.error.message };
    }
    const timeout = timeoutResult.value;

    const logger = createLogger({
      debug: Deno.env.get("DEBUG") === "true",
    });

    // Issue #2622: per-tool version floors from config trigger an immediate
    // update when the installed version is below the floor. Issue #3655: the
    // shared env builder supplies the skip flags and the release-age
    // quarantine window; CLI flags layer on top.
    const envOptions = softwareUpdateOptionsFromEnv(config);
    const outcome = await checkSoftwareUpdates(logger, {
      ...envOptions,
      timestampDir,
      intervalSeconds: intervalSeconds ?? envOptions.intervalSeconds,
      timeout: timeout ?? envOptions.timeout,
      skipClaude: args["skip-claude"] === true || envOptions.skipClaude,
      skipGh: args["skip-gh"] === true || envOptions.skipGh,
      skipDeno: args["skip-deno"] === true || envOptions.skipDeno,
    });

    // Issue #1270: the outcome, not a fixed sentence. A run that attempted
    // an update and failed exits non-zero — "absence of a failure marker is
    // not success" — and a run that attempted nothing says why rather than
    // claiming the check completed.
    return {
      success: outcome.failed.length === 0,
      message: describeOutcome(outcome),
      data: { timestampDir, outcome },
    };
  },
};

/** One operator-facing line describing what the update run did (Issue #1270). */
function describeOutcome(outcome: SoftwareUpdateRunOutcome): string {
  if (outcome.failed.length > 0) {
    return `Software update failed for: ${outcome.failed.join(", ")} ` +
      `(attempted: ${outcome.attempted.join(", ")})`;
  }
  switch (outcome.status) {
    case "suppressed":
      return "Software updates suppressed (container image or " +
        "SKIP_SOFTWARE_UPDATE) — no tool update attempted";
    case "not-due":
      return "Software updates checked recently — no tool update attempted";
    case "frozen":
      return describeTools("Pinned tool versions installed", outcome);
    case "ran":
      return describeTools("Software update check complete", outcome);
  }
}

/** Append the attempted/skipped tool lists to an outcome message. */
function describeTools(
  prefix: string,
  outcome: SoftwareUpdateRunOutcome,
): string {
  const attempted = outcome.attempted.length > 0
    ? outcome.attempted.join(", ")
    : "none";
  const skipped = outcome.skipped.length > 0
    ? ` (skipped: ${outcome.skipped.join(", ")})`
    : "";
  return `${prefix} — attempted: ${attempted}${skipped}`;
}
