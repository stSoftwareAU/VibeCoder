/**
 * CLI entry point for the `idle-task` label back-fill sweep (Issue #2131).
 *
 * Walks the supplied list of monitored repos, fetches open issues whose
 * title matches `Run a security scan`, and applies the `idle-task`
 * label where missing. The sweep is idempotent — running it again on
 * a freshly-labelled repo emits only `already_labelled` events.
 *
 * Structured progress lines (parseable by operator log scrapers):
 *
 *   [backfill] repo=<r> issue=<n> action=labelled
 *   [backfill] repo=<r> issue=<n> action=already_labelled
 *   [backfill] repo=<r> action=error reason=<msg>
 *   [backfill] action=summary labelled=N already=N errors=N
 *
 * The actual work and log-line rendering live in
 * `lib/idle_task_backfill.ts` so `setup_cli.ts` can call the same code
 * path without re-implementing the format.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  backfillIdleTaskLabels,
  type BackfillSummary,
  formatBackfillEvent,
  formatBackfillSummary,
} from "../lib/idle_task_backfill.ts";

// Register the security-scan template for its side-effect export of
// `SECURITY_SCAN_ISSUE_TITLE`. Importing the lib already pulls this in,
// but the explicit import keeps the dependency chain visible. Issue
// #2398 added the supply-chain-readiness side-effect import so the
// fifth template's `SUPPLY_CHAIN_READINESS_ISSUE_TITLE` is available
// to the backfill sweep regardless of import order. Issue #2930 added
// the four Boy Scout templates' titles to the sweep.
import "../lib/idle_task_templates/security_scan_template.ts";
import "../lib/idle_task_templates/supply_chain_readiness_template.ts";
import "../lib/idle_task_templates/orphan_deps_template.ts";
import "../lib/idle_task_templates/dead_code_template.ts";
import "../lib/idle_task_templates/doc_coverage_template.ts";
import "../lib/idle_task_templates/format_drift_template.ts";
import "../lib/idle_task_templates/deprecated_api_template.ts";
import "../lib/idle_task_templates/bash_script_refs_template.ts";

interface TestDeps {
  log?: (line: string) => void;
  ghCommandFn?: (args: string[]) => Promise<string>;
  addLabelFn?: Parameters<typeof backfillIdleTaskLabels>[0]["addLabelFn"];
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const backfillIdleTaskLabelsCommand: Command = {
  name: "backfill-idle-task-labels",
  description:
    "Sweep open `Run a security scan` wrappers in each monitored repo " +
    "and apply the `idle-task` label where missing (Issue #2131).",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<BackfillSummary>> {
    const repos = splitCsv(args["monitored-repos"]);
    const deps: TestDeps = (args["__testDeps"] as TestDeps | undefined) ?? {};
    const log = deps.log ?? ((line: string) => console.log(line));

    if (repos.length === 0) {
      return {
        success: false,
        message: "Missing required argument: --monitored-repos",
      };
    }

    const summary = await backfillIdleTaskLabels({
      repos,
      ghCommandFn: deps.ghCommandFn,
      addLabelFn: deps.addLabelFn,
      log: (event) => log(formatBackfillEvent(event)),
    });

    log(formatBackfillSummary(summary));

    return {
      success: true,
      message: `Back-fill complete: ${summary.labelled.length} labelled, ` +
        `${summary.alreadyLabelled} already labelled, ` +
        `${summary.deliberatelyUnlabelled.length} deliberately unlabelled, ` +
        `${summary.errors.length} errors`,
      data: summary,
    };
  },
};
