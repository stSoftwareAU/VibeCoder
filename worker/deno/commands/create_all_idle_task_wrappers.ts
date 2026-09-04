/**
 * CLI entry point for seeding all five standard idle-task wrappers in a
 * single repo (Issue #2870).
 *
 * The underlying {@link createAllIdleTaskWrappers} helper (Issue #2577) is
 * normally only reached through the `add-repo` onboarding flow. This command
 * exposes the same seam standalone so an operator can raise the full set of
 * idle-task wrappers on an already-monitored repo on demand — e.g. to
 * re-seed a repo after the best-practices templates were improved.
 *
 * It is idempotent: wrappers whose canonical title is already open are
 * skipped, so re-running never produces duplicates.
 *
 * Structured progress lines (parseable by operator log scrapers) are emitted
 * by the helper via the injected `log` sink:
 *
 *   [create-all-idle-task] repo=<r> template=<t> action=filed label=idle-task
 *   [create-all-idle-task] repo=<r> template=<t> action=skipped reason=already_open
 *   [create-all-idle-task] repo=<r> template=<t> action=failed terminal=<b> reason=<m>
 *
 * A per-template outcome table (created / skipped / failed + reason) is
 * printed on both exit paths (Issue #3862), so a sweep that dies part-way
 * still tells the operator which wrappers already landed.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  createAllIdleTaskWrappers,
  type CreateAllIdleTaskWrappersDeps,
  type CreateAllIdleTaskWrappersResult,
  formatIdleTaskOutcomeTable,
  partialFromSweepError,
} from "../lib/create_all_idle_task_wrappers.ts";

interface TestDeps {
  log?: (line: string) => void;
  ghCommandFn?: CreateAllIdleTaskWrappersDeps["ghCommandFn"];
  ensureLabelFn?: CreateAllIdleTaskWrappersDeps["ensureLabelFn"];
  findExistingWrapperTitlesFn?:
    CreateAllIdleTaskWrappersDeps["findExistingWrapperTitlesFn"];
  nowFn?: CreateAllIdleTaskWrappersDeps["nowFn"];
  /**
   * Checkout root the wrapper bodies' prompt files are read from
   * (Issue #1024) — the seam that lets a test build real bodies without
   * moving the process's working directory.
   */
  rootDir?: CreateAllIdleTaskWrappersDeps["rootDir"];
}

export const createAllIdleTaskWrappersCommand: Command = {
  name: "create-all-idle-task-wrappers",
  description:
    "Seed all five standard idle-task wrappers in a single repo, skipping " +
    "any whose canonical title is already open (Issue #2870).",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<CreateAllIdleTaskWrappersResult>> {
    const repoArg = args["repo"];
    const repo = typeof repoArg === "string" ? repoArg.trim() : "";
    const deps: TestDeps = (args["__testDeps"] as TestDeps | undefined) ?? {};
    const log = deps.log ?? ((line: string) => console.log(line));

    if (repo.length === 0) {
      return {
        success: false,
        message: "Missing required argument: --repo owner/repo",
      };
    }

    const result = await createAllIdleTaskWrappers(repo, {
      ghCommandFn: deps.ghCommandFn,
      ensureLabelFn: deps.ensureLabelFn,
      findExistingWrapperTitlesFn: deps.findExistingWrapperTitlesFn,
      nowFn: deps.nowFn,
      rootDir: deps.rootDir,
      log,
    });

    // The per-template outcome table is printed on both exit paths (Issue
    // #3862) — a failed sweep must still tell the operator what landed.
    const outcome = result.ok
      ? result.value
      : partialFromSweepError(result.error);
    for (const line of formatIdleTaskOutcomeTable(repo, outcome)) log(line);

    if (!result.ok) {
      return { success: false, message: result.error.message, data: outcome };
    }

    const { created, skipped } = outcome;
    return {
      success: true,
      message:
        `Seeded idle-task wrappers in ${repo}: ${created.length} created, ` +
        `${skipped.length} already open`,
      data: outcome,
    };
  },
};
