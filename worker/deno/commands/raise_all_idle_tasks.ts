/**
 * CLI entry point for raising all ten idle-task wrappers across a supplied set
 * of repos (Issue #3196).
 *
 * The steady-state random filer seeds one wrapper per idle tick, so bringing
 * several repos up to the full best-practice set on demand is slow. This
 * command seeds the whole canonical set in every named repo in a single pass —
 * the multi-repo, all-template parallel to `raise-boy-scout-idle-tasks`
 * (Issue #2933) and to the single-repo `create-all-idle-task-wrappers`
 * (Issue #2870).
 *
 * Repos are taken from `--monitored-repos` (CSV) when supplied, otherwise from
 * the worker config's `repos` list. The underlying helper is idempotent: a
 * wrapper whose canonical title is already open is skipped, so re-running never
 * produces duplicates. A per-repo failure is recorded and the sweep continues.
 *
 * Structured progress lines (parseable by operator log scrapers) are emitted
 * by the helpers via the injected `log` sink:
 *
 *   [create-all-idle-task] repo=<r> template=<t> action=filed label=idle-task
 *   [all-idle-tasks] repo=<r> action=done created=N skipped=N
 *   [all-idle-tasks] repo=<r> action=error reason=<msg>
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  raiseAllIdleTasks,
  type RaiseAllIdleTasksOptions,
  type RaiseAllIdleTasksResult,
} from "../lib/raise_all_idle_tasks.ts";

interface TestDeps {
  log?: (line: string) => void;
  ghCommandFn?: RaiseAllIdleTasksOptions["ghCommandFn"];
  ensureLabelFn?: RaiseAllIdleTasksOptions["ensureLabelFn"];
  findExistingWrapperTitlesFn?:
    RaiseAllIdleTasksOptions["findExistingWrapperTitlesFn"];
  nowFn?: RaiseAllIdleTasksOptions["nowFn"];
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const raiseAllIdleTasksCommand: Command = {
  name: "raise-all-idle-tasks",
  description:
    "Seed all ten idle-task wrappers in every named repo (--monitored-repos " +
    "CSV, else config repos), skipping any whose canonical title is already " +
    "open (Issue #3196).",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RaiseAllIdleTasksResult>> {
    const deps: TestDeps = (args["__testDeps"] as TestDeps | undefined) ?? {};
    const log = deps.log ?? ((line: string) => console.log(line));

    // Explicit --monitored-repos wins; otherwise fall back to config.repos.
    let repos = splitCsv(args["monitored-repos"]);
    if (repos.length === 0 && Array.isArray(config?.repos)) {
      repos = config.repos.filter((r): r is string => typeof r === "string");
    }

    if (repos.length === 0) {
      return {
        success: false,
        message:
          "No repos to process: pass --monitored-repos or configure repos",
      };
    }

    const result = await raiseAllIdleTasks({
      repos,
      ghCommandFn: deps.ghCommandFn,
      ensureLabelFn: deps.ensureLabelFn,
      findExistingWrapperTitlesFn: deps.findExistingWrapperTitlesFn,
      nowFn: deps.nowFn,
      log,
    });

    if (!result.ok) {
      return { success: false, message: result.error.message };
    }

    const { totalCreated, totalSkipped, failedRepos, repos: perRepo } =
      result.value;
    return {
      success: true,
      message: `All idle tasks raised across ${perRepo.length} repo(s): ` +
        `${totalCreated} filed, ${totalSkipped} already open, ` +
        `${failedRepos} failed`,
      data: result.value,
    };
  },
};
