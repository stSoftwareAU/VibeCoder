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
 * A repo that already holds any open `idle-task` issue is skipped whole
 * (Issue #2752). `--force` files past that gate, logging the bypassed issue
 * as `action=forced`; exact-title dedup still applies (Issue #2753):
 *
 *   deno run ... raise-boy-scout-idle-tasks --monitored-repos org/a --force
 *
 * Structured progress lines (parseable by operator log scrapers) are emitted
 * by the helper via the injected `log` sink:
 *
 *   [create-all-idle-task] repo=<r> template=<t> action=filed label=idle-task
 *   [idle-task] repo=<r> issue=<n> action=forced
 *   [boy-scout] repo=<r> action=done created=N skipped=N
 *   [boy-scout] repo=<r> action=error reason=<msg>
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
  raiseBoyScoutIdleTasks,
  type RaiseBoyScoutIdleTasksOptions,
  type RaiseBoyScoutIdleTasksResult,
} from "../lib/boy_scout_idle_tasks.ts";

interface TestDeps {
  log?: (line: string) => void;
  ghCommandFn?: RaiseBoyScoutIdleTasksOptions["ghCommandFn"];
  ensureLabelFn?: RaiseBoyScoutIdleTasksOptions["ensureLabelFn"];
  findOpenIdleTaskIssuesFn?:
    RaiseBoyScoutIdleTasksOptions["findOpenIdleTaskIssuesFn"];
  nowFn?: RaiseBoyScoutIdleTasksOptions["nowFn"];
  /**
   * Checkout root the wrapper bodies' prompt files are read from
   * (Issue #1024) — the seam that lets a test build real bodies without
   * moving the process's working directory.
   */
  rootDir?: RaiseBoyScoutIdleTasksOptions["rootDir"];
}

/** Options this command accepts; `__testDeps` is the injected test seam. */
const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "monitored-repos",
  "force",
  "__testDeps",
]);

export const raiseBoyScoutIdleTasksCommand: Command = {
  name: "raise-boy-scout-idle-tasks",
  description:
    "Seed the four Boy Scout idle-task wrappers (dead-code, doc-coverage, " +
    "format-drift, deprecated-api) in every monitored repo, skipping any " +
    "whose canonical title is already open (Issue #2933). A repo with any " +
    "open idle-task issue is skipped unless --force is passed (Issue #2753).",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RaiseBoyScoutIdleTasksResult>> {
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
        message: `raise-boy-scout-idle-tasks: unknown option(s) ` +
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

    const result = await raiseBoyScoutIdleTasks({
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
        `Boy Scout idle tasks raised across ${perRepo.length} repo(s): ` +
        `${totalCreated} filed, ${totalSkipped} already open, ` +
        `${failedRepos} failed`,
      data: result.value,
    };
  },
};
