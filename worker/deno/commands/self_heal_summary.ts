/**
 * self-heal-summary command — report aggregated self-healing activity
 * (Issue #1497).
 *
 * Reads the structured events log at `${workDir}/logs/self-heal.jsonl`
 * and produces per-module counts, totals, and the most recent events.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  DEFAULT_SUMMARY_RECENT_LIMIT,
  DEFAULT_SUMMARY_WINDOW_DAYS,
  formatSummary,
  type SelfHealSummary,
  summariseSelfHealEvents,
} from "../lib/self_heal_events.ts";

/**
 * Args:
 *   --work-dir <string>    Work directory (defaults to config.workDir or $HOME).
 *   --window-days <number> Retention window in days (default 7). 0 disables filter.
 *   --recent-limit <number> Most recent events to include (default 10).
 */
export const selfHealSummaryCommand: Command = {
  name: "self-heal-summary",
  description: "Summarise structured self-healing events for the operator",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<SelfHealSummary>> {
    const workDir = typeof args["work-dir"] === "string" && args["work-dir"]
      ? args["work-dir"] as string
      : (config.workDir || Deno.env.get("HOME") || "/tmp");

    const windowDays = parseIntArg(
      args["window-days"],
      DEFAULT_SUMMARY_WINDOW_DAYS,
    );
    const recentLimit = parseIntArg(
      args["recent-limit"],
      DEFAULT_SUMMARY_RECENT_LIMIT,
    );

    const summary = await summariseSelfHealEvents({
      workDir,
      windowDays,
      recentLimit,
    });

    return {
      success: true,
      message: formatSummary(summary),
      data: summary,
    };
  },
};

function parseIntArg(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}
