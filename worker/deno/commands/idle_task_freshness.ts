/**
 * `idle-task-freshness` command (Issue #3864).
 *
 * Reports, for every repo in `.config.json` `repos` × every registered
 * idle-task template, when that pair's scan last completed and what it
 * produced — so "which repo needs a full sweep?" is answered with data
 * rather than a human noticing:
 *
 *   deno run -A worker/deno/mod.ts idle-task-freshness
 *   deno run -A worker/deno/mod.ts idle-task-freshness --json
 *   deno run -A worker/deno/mod.ts idle-task-freshness --stale-days 14
 *   deno run -A worker/deno/mod.ts idle-task-freshness --cadence
 *
 * `--cadence` (Issue #4012) appends the weekly/monthly compliance view for the
 * important templates — the answer to "is the cadence floor actually being
 * delivered?" — while the plain staleness rows, which also cover the busy-work
 * templates, are unchanged. The `--json` payload always carries the `cadence`
 * section so a scraper never has to know which flags were passed.
 *
 * Reporting only — every underlying `gh` call is a read, so the command is
 * safe to run at any time against any repo.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  collectIdleTaskFreshness,
  type CollectIdleTaskFreshnessOptions,
  DEFAULT_STALE_AFTER_DAYS,
  formatFreshnessReport,
  type IdleTaskFreshnessReport,
} from "../lib/idle_task_freshness.ts";
import { DEFAULT_CADENCE_POLICY } from "../lib/idle_task_cadence.ts";
import {
  buildCadenceComplianceReport,
  type CadenceComplianceReport,
  formatCadenceComplianceReport,
} from "../lib/idle_task_cadence_report.ts";

/** Injectable seams — tests supply stubs so no `gh` call is made. */
interface TestDeps {
  ghCommandFn?: CollectIdleTaskFreshnessOptions["ghCommandFn"];
  fetchHistoryFn?: CollectIdleTaskFreshnessOptions["fetchHistoryFn"];
  fetchCloseSummaryFn?: CollectIdleTaskFreshnessOptions["fetchCloseSummaryFn"];
  nowFn?: CollectIdleTaskFreshnessOptions["nowFn"];
  warn?: CollectIdleTaskFreshnessOptions["warn"];
  authorOptions?: CollectIdleTaskFreshnessOptions["authorOptions"];
}

/** The freshness report plus the cadence compliance view (Issue #4012). */
export interface IdleTaskFreshnessCommandData extends IdleTaskFreshnessReport {
  cadence: CadenceComplianceReport;
}

export const idleTaskFreshnessCommand: Command = {
  name: "idle-task-freshness",
  description:
    "Report when each (repo, template) idle-task scan last ran and what it " +
    "produced, sorted by staleness (Issue #3864); --cadence adds weekly/" +
    "monthly compliance for the important templates (Issue #4012). Read-only.",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<IdleTaskFreshnessCommandData>> {
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      return {
        success: false,
        message:
          "No repositories to scan: configure 'repos' in .config.json first.",
      };
    }

    const staleRaw = args["stale-days"];
    const staleAfterDays = typeof staleRaw === "number" && staleRaw > 0
      ? staleRaw
      : DEFAULT_STALE_AFTER_DAYS;

    const deps: TestDeps = (args["__testDeps"] as TestDeps | undefined) ?? {};

    const report = await collectIdleTaskFreshness({
      repos,
      staleAfterDays,
      ghCommandFn: deps.ghCommandFn,
      fetchHistoryFn: deps.fetchHistoryFn,
      fetchCloseSummaryFn: deps.fetchCloseSummaryFn,
      nowFn: deps.nowFn,
      warn: deps.warn,
      // Fleet identity for the closing-comment author check (Issue #1249,
      // finding 2). Production omits it and the configured fleet is read;
      // a test states it so no ambient config is consulted.
      ...(deps.authorOptions ? { authorOptions: deps.authorOptions } : {}),
    });

    // The operator's `.config.json` policy (#4011) is what the filer works
    // towards, so compliance is measured against exactly that — never against
    // a hard-coded 7/30 the fleet is not actually being held to.
    const cadence = buildCadenceComplianceReport(
      report.entries,
      new Date(report.generatedAt),
      config.idleTaskCadence ?? DEFAULT_CADENCE_POLICY,
    );
    const data: IdleTaskFreshnessCommandData = { ...report, cadence };

    const message = args["json"] === true
      ? JSON.stringify(data, null, 2)
      : args["cadence"] === true
      ? `${formatFreshnessReport(report)}\n\n${
        formatCadenceComplianceReport(cadence)
      }`
      : formatFreshnessReport(report);

    return { success: true, message, data };
  },
};
