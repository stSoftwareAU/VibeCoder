/**
 * Raise a single named idle-task template's wrapper into one or more named
 * target repos (Issue #3320).
 *
 * The steady-state random idle-task filer seeds one template at a time and
 * picks both the template and the repo at random, so triggering a *specific*
 * scan against a *specific* repo on demand is not otherwise possible — you'd
 * have to wait for the dice to land on that (template, repo) pair. This helper
 * is the deterministic, "pinned target" one-off: name the template and the
 * repo(s) and it files exactly that wrapper.
 *
 * It reuses {@link createAllIdleTaskWrappers} with a single-entry template-name
 * filter so all of the body-building, dedup, milestone, and attribution
 * behaviour stays in one place (DRY). The per-repo call is idempotent — a
 * wrapper whose canonical title is already open is skipped — so re-running
 * never duplicates.
 *
 * The template name is validated against {@link IDLE_TASK_WRAPPER_TEMPLATE_NAMES}
 * up-front: an unknown name returns an error Result rather than silently filing
 * nothing (the create helper's title-allowlist filter would otherwise yield an
 * empty, green-looking result — a silent failure). Per-repo failures never
 * abort the sweep: the error is captured in the returned summary and the walk
 * moves on to the next repo (mirroring `raiseBoyScoutIdleTasks`). A failing
 * repo still reports the wrappers it filed before failing (Issue #3862).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import {
  createAllIdleTaskWrappers,
  type CreateAllIdleTaskWrappersDeps,
  formatIdleTaskOutcomeTable,
  type IdleTaskWrapperFailure,
  isTerminalSweepError,
  partialFromSweepError,
} from "./create_all_idle_task_wrappers.ts";
import { IDLE_TASK_WRAPPER_TEMPLATE_NAMES } from "./idle_task_backfill.ts";

/** Per-repo outcome of the single-template raise. */
export interface SingleIdleTaskRepoResult {
  /** Target repo in `owner/repo` form. */
  repo: string;
  /** Template names whose wrapper was newly filed in this repo (0 or 1). */
  created: string[];
  /** Template names skipped because an open wrapper already existed (0 or 1). */
  skipped: string[];
  /** Per-template failures in this repo (Issue #3862). */
  failed?: IdleTaskWrapperFailure[];
  /** Present when the repo failed; the rest of the sweep continued. */
  error?: string;
  /** True when the repo's failure was terminal (a write-repo refusal). */
  terminal?: boolean;
}

/** Aggregate outcome of the whole raise. */
export interface RaiseSingleIdleTaskResult {
  /** The template name that was raised. */
  template: string;
  /** Per-repo results in the order the repos were supplied. */
  repos: SingleIdleTaskRepoResult[];
  /** Total wrappers newly filed across all repos. */
  totalCreated: number;
  /** Total wrappers skipped (already open) across all repos. */
  totalSkipped: number;
  /** Number of repos that failed. */
  failedRepos: number;
}

/** Options accepted by {@link raiseSingleIdleTask}. */
export interface RaiseSingleIdleTaskOptions {
  /** The idle-task template name to raise (e.g. `documentation-audit`). */
  template: string;
  /** Target repo slugs (`owner/repo`). */
  repos: readonly string[];
  /** Forwarded to {@link createAllIdleTaskWrappers} per repo. */
  ghCommandFn?: CreateAllIdleTaskWrappersDeps["ghCommandFn"];
  ensureLabelFn?: CreateAllIdleTaskWrappersDeps["ensureLabelFn"];
  findExistingWrapperTitlesFn?:
    CreateAllIdleTaskWrappersDeps["findExistingWrapperTitlesFn"];
  nowFn?: CreateAllIdleTaskWrappersDeps["nowFn"];
  runId?: string;
  /**
   * Checkout root the wrapper bodies' prompt files are read from
   * (Issue #1024). Forwarded to {@link createAllIdleTaskWrappers}.
   */
  rootDir?: CreateAllIdleTaskWrappersDeps["rootDir"];
  /** Progress log sink. Defaults to a no-op. */
  log?: (line: string) => void;
}

/**
 * Seed the named idle-task wrapper in every repo in `opts.repos`.
 *
 * Returns an aggregate summary. Never throws — a repo whose seeding fails is
 * recorded with an `error` and the sweep continues. An empty repo list or an
 * unknown template name returns an error Result (fail loud).
 */
export async function raiseSingleIdleTask(
  opts: RaiseSingleIdleTaskOptions,
): Promise<Result<RaiseSingleIdleTaskResult>> {
  const template = typeof opts.template === "string"
    ? opts.template.trim()
    : "";
  if (template.length === 0) {
    return {
      ok: false,
      error: new Error("template must be a non-empty string"),
    };
  }
  if (!IDLE_TASK_WRAPPER_TEMPLATE_NAMES.has(template)) {
    return {
      ok: false,
      error: new Error(
        `unknown idle-task template "${template}" — expected one of: ` +
          [...IDLE_TASK_WRAPPER_TEMPLATE_NAMES].sort().join(", "),
      ),
    };
  }

  const repos = (opts.repos ?? []).map((r) => r.trim()).filter((r) =>
    r.length > 0
  );
  if (repos.length === 0) {
    return { ok: false, error: new Error("repos must be a non-empty list") };
  }

  const log = opts.log ?? (() => {});
  const templateNames: ReadonlySet<string> = new Set([template]);
  const summary: RaiseSingleIdleTaskResult = {
    template,
    repos: [],
    totalCreated: 0,
    totalSkipped: 0,
    failedRepos: 0,
  };

  for (const repo of repos) {
    const result = await createAllIdleTaskWrappers(repo, {
      templateNames,
      ghCommandFn: opts.ghCommandFn,
      ensureLabelFn: opts.ensureLabelFn,
      findExistingWrapperTitlesFn: opts.findExistingWrapperTitlesFn,
      nowFn: opts.nowFn,
      runId: opts.runId,
      rootDir: opts.rootDir,
      log,
    });

    if (!result.ok) {
      // Issue #3862: keep whatever the repo's sweep managed before failing.
      const partial = partialFromSweepError(result.error);
      summary.repos.push({
        repo,
        created: partial.created,
        skipped: partial.skipped,
        failed: partial.failed ?? [],
        error: result.error.message,
        terminal: isTerminalSweepError(result.error),
      });
      summary.failedRepos++;
      summary.totalCreated += partial.created.length;
      summary.totalSkipped += partial.skipped.length;
      for (const line of formatIdleTaskOutcomeTable(repo, partial)) log(line);
      log(
        `[raise-idle-task] repo=${repo} template=${template} action=error ` +
          `reason=${result.error.message}`,
      );
      continue;
    }

    const { created, skipped } = result.value;
    summary.repos.push({ repo, created, skipped });
    summary.totalCreated += created.length;
    summary.totalSkipped += skipped.length;
    log(
      `[raise-idle-task] repo=${repo} template=${template} action=done ` +
        `created=${created.length} skipped=${skipped.length}`,
    );
  }

  return { ok: true, value: summary };
}
