/**
 * CLI entry point for raising the four "Boy Scout" idle-task wrappers across
 * every monitored repo (Issue #2933).
 *
 * The Boy Scout templates (`dead-code`, `doc-coverage`, `format-drift`,
 * `deprecated-api` — Issue #2930) are normally seeded one-at-a-time by the
 * random idle-task filer. This command seeds the whole set in every monitored
 * repo in a single pass so an operator can confirm they all work on demand.
 *
 * Repos are taken from `--monitored-repos` (CSV) when supplied, otherwise
 * from the worker config's `repos` list. The underlying helper is idempotent:
 * a wrapper whose canonical title is already open is skipped, so re-running
 * never produces duplicates. A per-repo failure is recorded and the sweep
 * continues.
 *
 * Structured progress lines (parseable by operator log scrapers) are emitted
 * by the helper via the injected `log` sink:
 *
 *   [create-all-idle-task] repo=<r> template=<t> action=filed label=idle-task
 *   [boy-scout] repo=<r> action=done created=N skipped=N
 *   [boy-scout] repo=<r> action=error reason=<msg>
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  raiseBoyScoutIdleTasks,
  type RaiseBoyScoutIdleTasksOptions,
  type RaiseBoyScoutIdleTasksResult,
} from "../lib/boy_scout_idle_tasks.ts";

interface TestDeps {
  log?: (line: string) => void;
  ghCommandFn?: RaiseBoyScoutIdleTasksOptions["ghCommandFn"];
  ensureLabelFn?: RaiseBoyScoutIdleTasksOptions["ensureLabelFn"];
  findExistingWrapperTitlesFn?:
    RaiseBoyScoutIdleTasksOptions["findExistingWrapperTitlesFn"];
  nowFn?: RaiseBoyScoutIdleTasksOptions["nowFn"];
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const raiseBoyScoutIdleTasksCommand: Command = {
  name: "raise-boy-scout-idle-tasks",
  description:
    "Seed the four Boy Scout idle-task wrappers (dead-code, doc-coverage, " +
    "format-drift, deprecated-api) in every monitored repo, skipping any " +
    "whose canonical title is already open (Issue #2933).",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RaiseBoyScoutIdleTasksResult>> {
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

    const result = await raiseBoyScoutIdleTasks({
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
      message:
        `Boy Scout idle tasks raised across ${perRepo.length} repo(s): ` +
        `${totalCreated} filed, ${totalSkipped} already open, ` +
        `${failedRepos} failed`,
      data: result.value,
    };
  },
};
