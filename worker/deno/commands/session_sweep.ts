/**
 * Session sweep command (Issue #1494).
 *
 * Walks `${workDir}/.claude-sessions/` and enforces age, per-session size,
 * and cumulative size caps. Invoked from `worker/run_core.sh` during the
 * startup phase so abandoned milestone sessions are reclaimed without
 * waiting for disk-pressure cleanup.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  DEFAULT_MAX_CUMULATIVE_SIZE_BYTES,
  DEFAULT_MAX_SESSION_AGE_DAYS,
  DEFAULT_MAX_SESSION_SIZE_BYTES,
  sweepAllSessions,
  type SweepResult,
} from "../lib/session_sweeper.ts";

/**
 * Args:
 *   --work-dir <string>                Directory containing `.claude-sessions/`.
 *                                      Defaults to config.workDir or WORK_DIR env.
 *   --max-age-days <num>               Age threshold in days (default: 7).
 *   --max-session-size-bytes <num>     Per-session size cap (default: 52428800).
 *   --max-cumulative-size-bytes <num>  Cumulative size cap (default: 524288000).
 */
export const sessionSweepCommand: Command = {
  name: "session-sweep",
  description:
    "Sweep abandoned Claude session directories, enforcing age/size/cumulative caps (Issue #1494)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<SweepResult>> {
    const workDir =
      typeof args["work-dir"] === "string" && args["work-dir"].length > 0
        ? args["work-dir"]
        : (config.workDir || Deno.env.get("WORK_DIR") || "");

    if (!workDir) {
      return {
        success: false,
        message:
          "session-sweep: --work-dir is required (no config.workDir or WORK_DIR env var)",
      };
    }

    const maxAgeDays = parseNumberArg(
      args["max-age-days"],
      DEFAULT_MAX_SESSION_AGE_DAYS,
      "max-age-days",
    );
    if (maxAgeDays.error) return { success: false, message: maxAgeDays.error };

    const maxSessionSize = parseNumberArg(
      args["max-session-size-bytes"],
      DEFAULT_MAX_SESSION_SIZE_BYTES,
      "max-session-size-bytes",
    );
    if (maxSessionSize.error) {
      return { success: false, message: maxSessionSize.error };
    }

    const maxCumulativeSize = parseNumberArg(
      args["max-cumulative-size-bytes"],
      DEFAULT_MAX_CUMULATIVE_SIZE_BYTES,
      "max-cumulative-size-bytes",
    );
    if (maxCumulativeSize.error) {
      return { success: false, message: maxCumulativeSize.error };
    }

    const result = await sweepAllSessions({
      workDir,
      maxAgeDays: maxAgeDays.value,
      maxSessionSizeBytes: maxSessionSize.value,
      maxCumulativeSizeBytes: maxCumulativeSize.value,
    });

    const removed = result.removed.length;
    const message = removed === 0
      ? `Scanned ${result.scanned} session(s) in ${workDir}; nothing to remove`
      : `Scanned ${result.scanned} session(s) in ${workDir}; removed ${removed} ` +
        `(age=${count(result.removed, "age")}, size=${
          count(result.removed, "size")
        }, ` +
        `cumulative=${count(result.removed, "cumulative")})`;

    return { success: true, message, data: result };
  },
};

/** Count removals of a given reason. */
function count(
  removed: SweepResult["removed"],
  reason: SweepResult["removed"][number]["reason"],
): number {
  return removed.filter((r) => r.reason === reason).length;
}

/** Parse a numeric CLI argument, falling back to a default. */
function parseNumberArg(
  raw: unknown,
  fallback: number,
  name: string,
): { value: number; error?: undefined } | { value: number; error: string } {
  if (raw === undefined) return { value: fallback };
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: raw };
  if (typeof raw === "string") {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed)) return { value: parsed };
  }
  return {
    value: fallback,
    error: `session-sweep: invalid --${name} "${String(raw)}"`,
  };
}
