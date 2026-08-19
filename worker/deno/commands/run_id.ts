/**
 * Run-id command for the Vibe Coder worker (Issue #2381).
 *
 * Prints the canonical run id for this worker invocation. The shell
 * entry point (`worker/run_core.sh`) calls this once at startup and
 * exports the value as `VIBE_RUN_ID`, so every child `deno` command the
 * worker spawns inherits the same id and stamps it onto its GitHub
 * mutations.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { getRunId } from "../lib/run_id.ts";

/** Data returned by the run-id command. */
interface RunIdData {
  runId: string;
}

export const runIdCommand: Command = {
  name: "run-id",
  description: "Print the canonical run id for this worker invocation",

  // deno-lint-ignore require-await
  async execute(
    _args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<RunIdData>> {
    const runId = getRunId();
    return {
      success: true,
      message: runId,
      data: { runId },
    };
  },
};
