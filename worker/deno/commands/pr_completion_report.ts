/** Read-only report over a dated GitHub and trusted-fleet evidence snapshot. */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildPrCompletionReport,
  formatPrCompletionReport,
  type PrCompletionInput,
} from "../lib/pr_completion_report.ts";

export const prCompletionReportCommand: Command = {
  name: "pr-completion-report",
  description:
    "Report unattended PR completion from an evidence snapshot (Issue #4658)",
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const path = args.input;
    if (typeof path !== "string" || path.trim() === "") {
      return { success: false, message: "--input <path> is required" };
    }
    try {
      const input = JSON.parse(
        await Deno.readTextFile(path),
      ) as PrCompletionInput;
      const report = buildPrCompletionReport(input);
      return {
        success: true,
        message: formatPrCompletionReport(report),
        data: report,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `pr-completion-report failed: ${reason}`,
      };
    }
  },
};
