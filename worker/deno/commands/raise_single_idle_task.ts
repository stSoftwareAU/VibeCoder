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
 * run against private-repo-14 once #3319 landed.
 *
 * Usage:
 *   deno run ... raise-single-idle-task \
 *     --template documentation-audit --repo stSoftwareAU/private-repo-14
 *
 * `--template` is required. Repos are taken from `--repo` (single) or
 * `--monitored-repos` (CSV); at least one is required. The underlying helper is
 * idempotent — a wrapper whose canonical title is already open is skipped — so
 * re-running never produces duplicates. A per-repo failure is recorded and the
 * sweep continues.
 *
 * A repo that already holds any open `idle-task` issue is skipped whole
 * (Issue #2752). `--force` files past that gate, logging the bypassed issue
 * as `action=forced`; exact-title dedup still applies (Issue #2753):
 *
 *   deno run ... raise-single-idle-task \
 *     --template documentation-audit --repo org/a --force
 *
 * Structured progress lines (parseable by operator log scrapers) are emitted
 * by the helpers via the injected `log` sink:
 *
 *   [create-all-idle-task] repo=<r> template=<t> action=filed label=idle-task
 *   [idle-task] repo=<r> issue=<n> action=forced
 *   [raise-idle-task] repo=<r> template=<t> action=done created=N skipped=N
 *   [raise-idle-task] repo=<r> template=<t> action=error reason=<msg>
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { coerceBooleanFlag, findUnknownOptions } from "../lib/command_args.ts";
import {
  raiseSingleIdleTask,
  type RaiseSingleIdleTaskOptions,
  type RaiseSingleIdleTaskResult,
} from "../lib/raise_single_idle_task.ts";

interface TestDeps {
  log?: (line: string) => void;
  ghCommandFn?: RaiseSingleIdleTaskOptions["ghCommandFn"];
  ensureLabelFn?: RaiseSingleIdleTaskOptions["ensureLabelFn"];
  findOpenIdleTaskIssuesFn?:
    RaiseSingleIdleTaskOptions["findOpenIdleTaskIssuesFn"];
  nowFn?: RaiseSingleIdleTaskOptions["nowFn"];
  /**
   * Checkout root the wrapper bodies' prompt files are read from
   * (Issue #1024) — the seam that lets a test build real bodies without
   * moving the process's working directory.
   */
  rootDir?: RaiseSingleIdleTaskOptions["rootDir"];
}

/** Options this command accepts; `__testDeps` is the injected test seam. */
const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "template",
  "repo",
  "monitored-repos",
  "force",
  "__testDeps",
]);

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
    "already open (Issue #3320). A repo with any open idle-task issue is " +
    "skipped unless --force is passed (Issue #2753).",

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

    // A bare `--force` bypasses the any-open idle-task gate (Issue #2753);
    // an unreadable value is refused rather than read as "not forced".
    const forceResult = coerceBooleanFlag(args["force"], "force", false);
    if (!forceResult.ok) {
      return { success: false, message: forceResult.error.message };
    }
    // A misspelt flag (e.g. `--forse`) is refused, not silently dropped.
    const unknown = findUnknownOptions(args, KNOWN_OPTIONS);
    if (unknown.length > 0) {
      return {
        success: false,
        message: `raise-single-idle-task: unknown option(s) ` +
          `${unknown.map((k) => `--${k}`).join(", ")} — accepts only ` +
          `--template, --repo, --monitored-repos, --force`,
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
      findOpenIdleTaskIssuesFn: deps.findOpenIdleTaskIssuesFn,
      nowFn: deps.nowFn,
      rootDir: deps.rootDir,
      force: forceResult.value,
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
