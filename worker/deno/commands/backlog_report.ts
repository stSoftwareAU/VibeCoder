/**
 * backlog-report command (Issue #2405).
 *
 * Surfaces the security-remediation backlog and the worker's clear-rate
 * so an operator can tell whether the backlog is stable or growing:
 *
 *   deno run mod.ts backlog-report
 *   deno run mod.ts backlog-report --repo org/repo
 *   deno run mod.ts backlog-report --window 14
 *
 * With no `--repo`, every repo in `.config.json` `repos` is scanned.
 * Data comes from `gh` issue queries only — no new infrastructure.
 *
 * Uses Australian English spelling throughout.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { fetchFindings } from "../lib/backlog_fetch.ts";
import {
  type BacklogSummary,
  formatBacklogReport,
  summariseBacklog,
} from "../lib/backlog_throughput.ts";

export interface BacklogReportData {
  summary: BacklogSummary;
}

export const backlogReportCommand: Command = {
  name: "backlog-report",
  description:
    "Report the security/supply-chain backlog, clear-rate, trend and drain time (Issue #2405)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<BacklogReportData>> {
    const repoArg = args["repo"] as string | undefined;
    const repos = repoArg ? [repoArg] : (config.repos ?? []);

    if (repos.length === 0) {
      return {
        success: false,
        message: "No repositories to scan: pass --repo or configure 'repos'.",
      };
    }

    const windowRaw = args["window"];
    const windowDays = typeof windowRaw === "number" && windowRaw > 0
      ? windowRaw
      : 7;

    const findings = await fetchFindings({ repos });
    const summary = summariseBacklog(findings, { windowDays });

    return {
      success: true,
      message: formatBacklogReport(summary),
      data: { summary },
    };
  },
};
