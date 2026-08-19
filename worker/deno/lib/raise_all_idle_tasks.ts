/**
 * Raise all ten standard idle-task wrappers across a supplied set of repos
 * (Issue #3196).
 *
 * The steady-state idle-task filer (`maybe_file_idle_task.ts`) seeds only one
 * wrapper per idle tick and is gated by the cross-repo "any open idle-task
 * blocks filing" check, so bringing several repos up to the full best-practice
 * set on demand is slow. {@link raiseAllIdleTasks} seeds the whole canonical
 * set (all ten templates) in every supplied repo in a single pass.
 *
 * It reuses {@link createAllIdleTaskWrappers} per repo (no template filter, so
 * the default "all ten canonical wrappers" applies), keeping the body-building,
 * dedup, milestone, and attribution behaviour in a single place (DRY). The
 * per-repo call is idempotent — a wrapper whose canonical title is already open
 * is skipped — so re-running never duplicates.
 *
 * Per-repo failures never abort the sweep: the error is captured in the
 * returned summary and the walk moves on to the next repo (mirroring the
 * Boy Scout raiser in `boy_scout_idle_tasks.ts`). A failing repo still
 * reports the wrappers it managed to file before failing (Issue #3862).
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

/** Per-repo outcome of the all-idle-tasks raise. */
export interface AllIdleTasksRepoResult {
  /** Target repo in `owner/repo` form. */
  repo: string;
  /** Template names whose wrapper was newly filed in this repo. */
  created: string[];
  /** Template names skipped because an open wrapper already existed. */
  skipped: string[];
  /** Per-template failures in this repo (Issue #3862). */
  failed?: IdleTaskWrapperFailure[];
  /** Present when the repo failed; the rest of the sweep continued. */
  error?: string;
  /** True when the repo's failure was terminal (a write-repo refusal). */
  terminal?: boolean;
}

/** Aggregate outcome of the whole sweep. */
export interface RaiseAllIdleTasksResult {
  /** Per-repo results in the order the repos were supplied. */
  repos: AllIdleTasksRepoResult[];
  /** Total wrappers newly filed across all repos. */
  totalCreated: number;
  /** Total wrappers skipped (already open) across all repos. */
  totalSkipped: number;
  /** Number of repos that failed. */
  failedRepos: number;
}

/** Options accepted by {@link raiseAllIdleTasks}. */
export interface RaiseAllIdleTasksOptions {
  /** Target repo slugs (`owner/repo`). */
  repos: readonly string[];
  /** Forwarded to {@link createAllIdleTaskWrappers} per repo. */
  ghCommandFn?: CreateAllIdleTaskWrappersDeps["ghCommandFn"];
  ensureLabelFn?: CreateAllIdleTaskWrappersDeps["ensureLabelFn"];
  findExistingWrapperTitlesFn?:
    CreateAllIdleTaskWrappersDeps["findExistingWrapperTitlesFn"];
  nowFn?: CreateAllIdleTaskWrappersDeps["nowFn"];
  runId?: string;
  /** Progress log sink. Defaults to a no-op. */
  log?: (line: string) => void;
}

/**
 * Seed all ten canonical idle-task wrappers in every repo in `opts.repos`.
 *
 * Returns an aggregate summary. Never throws — a repo whose seeding fails is
 * recorded with an `error` and the sweep continues.
 */
export async function raiseAllIdleTasks(
  opts: RaiseAllIdleTasksOptions,
): Promise<Result<RaiseAllIdleTasksResult>> {
  const repos = (opts.repos ?? []).map((r) => r.trim()).filter((r) =>
    r.length > 0
  );
  if (repos.length === 0) {
    return { ok: false, error: new Error("repos must be a non-empty list") };
  }

  const log = opts.log ?? (() => {});
  const summary: RaiseAllIdleTasksResult = {
    repos: [],
    totalCreated: 0,
    totalSkipped: 0,
    failedRepos: 0,
  };

  for (const repo of repos) {
    // No `templateNames` filter -> the default "all ten canonical wrappers".
    const result = await createAllIdleTaskWrappers(repo, {
      ghCommandFn: opts.ghCommandFn,
      ensureLabelFn: opts.ensureLabelFn,
      findExistingWrapperTitlesFn: opts.findExistingWrapperTitlesFn,
      nowFn: opts.nowFn,
      runId: opts.runId,
      log,
    });

    if (!result.ok) {
      // Issue #3862: keep whatever the repo's sweep managed before failing —
      // an operator must see which wrappers already landed.
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
        `[all-idle-tasks] repo=${repo} action=error reason=${result.error.message}`,
      );
      continue;
    }

    const { created, skipped } = result.value;
    summary.repos.push({ repo, created, skipped });
    summary.totalCreated += created.length;
    summary.totalSkipped += skipped.length;
    log(
      `[all-idle-tasks] repo=${repo} action=done created=${created.length} ` +
        `skipped=${skipped.length}`,
    );
  }

  return { ok: true, value: summary };
}
