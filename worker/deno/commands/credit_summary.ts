/**
 * Credit summary command (Issue #1074).
 *
 * Reads per-worker credit usage logs and outputs a human-readable
 * summary. Optionally cleans up old log files.
 *
 * Usage:
 *   deno run mod.ts credit-summary --log-dir /path/to/logs
 *   deno run mod.ts credit-summary --log-dir /path/to/logs --date 2026-04-09
 *   deno run mod.ts credit-summary --log-dir /path/to/logs --cleanup
 *
 * Uses Australian English throughout.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  cleanupOldLogs,
  type DailySummary,
  DEFAULT_RETENTION_DAYS,
  formatSummary,
  getDailySummary,
} from "../lib/credit_tracker.ts";

/** Typed data returned by the credit-summary command. */
export interface CreditSummaryData {
  summary: DailySummary | null;
  cleanedUp: number;
}

/**
 * Credit summary command implementation.
 */
export const creditSummaryCommand: Command = {
  name: "credit-summary",
  description:
    "Display daily credit usage summary by worker, phase, and model (Issue #1074)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<CreditSummaryData>> {
    const logDir = args["log-dir"] as string | undefined;
    if (!logDir) {
      return {
        success: false,
        message: "Missing required argument: --log-dir",
        data: { summary: null, cleanedUp: 0 },
      };
    }

    const date = args["date"] as string | undefined;
    const doCleanup = args["cleanup"] === true;

    // Generate summary
    const summaryResult = await getDailySummary({ logDir, date });
    let summaryText: string;
    let summaryData: DailySummary | null = null;

    if (summaryResult.ok) {
      summaryData = summaryResult.value;
      summaryText = formatSummary(summaryData);
    } else {
      summaryText = summaryResult.error.message;
    }

    // Optionally clean up old logs
    let cleanedUp = 0;
    if (doCleanup) {
      const cleanupResult = await cleanupOldLogs({
        logDir,
        retentionDays: DEFAULT_RETENTION_DAYS,
      });
      if (cleanupResult.ok) {
        cleanedUp = cleanupResult.value;
        if (cleanedUp > 0) {
          summaryText += `\n\nCleaned up ${cleanedUp} old log file(s).`;
        }
      }
    }

    return {
      success: summaryResult.ok,
      message: summaryText,
      data: { summary: summaryData, cleanedUp },
    };
  },
};
