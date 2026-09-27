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
 * A repo that already holds any open `idle-task` issue is skipped whole
 * (Issue #2752). `--force` files past that gate, logging the bypassed issue
 * as `action=forced`; exact-title dedup still applies (Issue #2753):
 *
 *   deno run ... raise-all-idle-tasks --monitored-repos org/a,org/b --force
 *
 * Structured progress lines (parseable by operator log scrapers) are emitted
 * by the helpers via the injected `log` sink:
 *
 *   [create-all-idle-task] repo=<r> template=<t> action=filed label=idle-task
 *   [idle-task] repo=<r> issue=<n> action=forced
 *   [all-idle-tasks] repo=<r> action=done created=N skipped=N
 *   [all-idle-tasks] repo=<r> action=error reason=<msg>
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  coerceBooleanFlag,
  coerceStringListFlag,
  findUnknownOptions,
} from "../lib/command_args.ts";
import {
  raiseAllIdleTasks,
  type RaiseAllIdleTasksOptions,
  type RaiseAllIdleTasksResult,
} from "../lib/raise_all_idle_tasks.ts";

interface TestDeps {
  log?: (line: string) => void;
  ghCommandFn?: RaiseAllIdleTasksOptions["ghCommandFn"];
  ensureLabelFn?: RaiseAllIdleTasksOptions["ensureLabelFn"];
  findOpenIdleTaskIssuesFn?:
    RaiseAllIdleTasksOptions["findOpenIdleTaskIssuesFn"];
  nowFn?: RaiseAllIdleTasksOptions["nowFn"];
  /**
   * Checkout root the wrapper bodies' prompt files are read from
   * (Issue #1024) — the seam that lets a test build real bodies without
   * moving the process's working directory.
   */
  rootDir?: RaiseAllIdleTasksOptions["rootDir"];
}

/** Options this command accepts; `__testDeps` is the injected test seam. */
const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "monitored-repos",
  "force",
  "__testDeps",
]);

export const raiseAllIdleTasksCommand: Command = {
  name: "raise-all-idle-tasks",
  description:
    "Seed all ten idle-task wrappers in every named repo (--monitored-repos " +
    "CSV, else config repos), skipping any whose canonical title is already " +
    "open (Issue #3196). A repo with any open idle-task issue is skipped " +
    "unless --force is passed (Issue #2753).",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RaiseAllIdleTasksResult>> {
    const deps: TestDeps = (args["__testDeps"] as TestDeps | undefined) ?? {};
    const log = deps.log ?? ((line: string) => console.log(line));

    // Explicit --monitored-repos wins; otherwise fall back to config.repos.
    // A value that is present but unreadable is refused, not treated as
    // absent (Issue #1266): falling back would silently widen an unattended
    // sweep from the named repo to every configured one.
    const reposResult = coerceStringListFlag(
      args["monitored-repos"],
      "monitored-repos",
    );
    if (!reposResult.ok) {
      return { success: false, message: reposResult.error.message };
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
        message: `raise-all-idle-tasks: unknown option(s) ` +
          `${unknown.map((k) => `--${k}`).join(", ")} — accepts only ` +
          `--monitored-repos, --force`,
      };
    }
    let repos = reposResult.value;
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
      message: `All idle tasks raised across ${perRepo.length} repo(s): ` +
        `${totalCreated} filed, ${totalSkipped} already open, ` +
        `${failedRepos} failed`,
      data: result.value,
    };
  },
};
