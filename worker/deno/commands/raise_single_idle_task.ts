/**
 * CLI entry point for raising a single named idle-task template's wrapper into
 * one or more named target repos (Issue #3320).
 *
 * The steady-state random filer (`maybe_file_idle_task.ts`) seeds one template
 * at a time and picks both the template and the repo at random, so triggering a
 * *specific* scan against a *specific* repo on demand is not otherwise
 * possible. This command is the deterministic, "pinned target" one-off — the
 * single-template parallel to `create-all-idle-task-wrappers` (which seeds all
 * thirteen) and to `raise-boy-scout-idle-tasks` (which seeds just the four Boy
 * Scout templates). It was added to trigger a one-off `documentation-audit`
 * run against NEAT-AI once #3319 landed.
 *
 * Usage:
 *   deno run ... raise-single-idle-task \
 *     --template documentation-audit --repo example-org/private-repo-29
 *
 * `--template` is required. Repos are taken from `--repo` (single) or
 * `--monitored-repos` (CSV); at least one is required. The underlying helper is
 * idempotent — a wrapper whose canonical title is already open is skipped — so
 * re-running never produces duplicates. A per-repo failure is recorded and the
 * sweep continues.
 *
 * Structured progress lines (parseable by operator log scrapers) are emitted
 * by the helpers via the injected `log` sink:
 *
 *   [create-all-idle-task] repo=<r> template=<t> action=filed label=idle-task
 *   [raise-idle-task] repo=<r> template=<t> action=done created=N skipped=N
 *   [raise-idle-task] repo=<r> template=<t> action=error reason=<msg>
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  raiseSingleIdleTask,
  type RaiseSingleIdleTaskOptions,
  type RaiseSingleIdleTaskResult,
} from "../lib/raise_single_idle_task.ts";

interface TestDeps {
  log?: (line: string) => void;
  ghCommandFn?: RaiseSingleIdleTaskOptions["ghCommandFn"];
  ensureLabelFn?: RaiseSingleIdleTaskOptions["ensureLabelFn"];
  findExistingWrapperTitlesFn?:
    RaiseSingleIdleTaskOptions["findExistingWrapperTitlesFn"];
  nowFn?: RaiseSingleIdleTaskOptions["nowFn"];
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const raiseSingleIdleTaskCommand: Command = {
  name: "raise-single-idle-task",
  description:
    "Seed one named idle-task template's wrapper (e.g. documentation-audit) " +
    "into one or more named repos, skipping any whose canonical title is " +
    "already open (Issue #3320).",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<RaiseSingleIdleTaskResult>> {
    const deps: TestDeps = (args["__testDeps"] as TestDeps | undefined) ?? {};
    const log = deps.log ?? ((line: string) => console.log(line));

    const templateArg = args["template"];
    const template = typeof templateArg === "string" ? templateArg.trim() : "";
    if (template.length === 0) {
      return {
        success: false,
        message: "Missing required argument: --template <name>",
      };
    }

    // A single --repo wins; otherwise fall back to --monitored-repos CSV.
    const singleRepo = typeof args["repo"] === "string"
      ? (args["repo"] as string).trim()
      : "";
    const repos = singleRepo.length > 0
      ? [singleRepo]
      : splitCsv(args["monitored-repos"]);

    if (repos.length === 0) {
      return {
        success: false,
        message:
          "No repos to process: pass --repo owner/repo or --monitored-repos",
      };
    }

    const result = await raiseSingleIdleTask({
      template,
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
        `Raised '${template}' idle task across ${perRepo.length} repo(s): ` +
        `${totalCreated} filed, ${totalSkipped} already open, ` +
        `${failedRepos} failed`,
      data: result.value,
    };
  },
};
