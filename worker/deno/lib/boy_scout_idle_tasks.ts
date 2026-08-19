/**
 * Raise the four "Boy Scout" idle-task wrappers across every monitored repo
 * (Issue #2933).
 *
 * The Boy Scout templates — `dead-code`, `doc-coverage`, `format-drift`, and
 * `deprecated-api` (Issue #2930) — are the four issue-only maintainability
 * sweeps that embody the Boy Scout Rule ("leave the code cleaner than you
 * found it"). In steady state they are seeded one-at-a-time by the random
 * idle-task filer, so confirming the whole set works on demand is slow. This
 * helper seeds just those four wrappers in every repo in one pass.
 *
 * It reuses {@link createAllIdleTaskWrappers} with a template-name filter so
 * all of the body-building, dedup, milestone, and attribution behaviour stays
 * in a single place (DRY). The per-repo call is idempotent — a wrapper whose
 * canonical title is already open is skipped — so re-running never duplicates.
 *
 * Per-repo failures never abort the sweep: the error is captured in the
 * returned summary and the walk moves on to the next repo (mirroring the
 * `backfill-idle-task-labels` sweep). A failing repo still reports the
 * wrappers it managed to file before failing (Issue #3862).
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

/**
 * Canonical Boy Scout template-name set (Issue #2930). The single source of
 * truth for "which templates are Boy Scout" — kept as a frozen set so callers
 * cannot mutate it.
 */
export const BOY_SCOUT_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  "dead-code",
  "doc-coverage",
  "format-drift",
  "deprecated-api",
]);

/** Per-repo outcome of the Boy Scout raise. */
export interface BoyScoutRepoResult {
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
export interface RaiseBoyScoutIdleTasksResult {
  /** Per-repo results in the order the repos were supplied. */
  repos: BoyScoutRepoResult[];
  /** Total wrappers newly filed across all repos. */
  totalCreated: number;
  /** Total wrappers skipped (already open) across all repos. */
  totalSkipped: number;
  /** Number of repos that failed. */
  failedRepos: number;
}

/** Options accepted by {@link raiseBoyScoutIdleTasks}. */
export interface RaiseBoyScoutIdleTasksOptions {
  /** Monitored repo slugs (`owner/repo`). */
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
 * Seed the four Boy Scout idle-task wrappers in every repo in `opts.repos`.
 *
 * Returns an aggregate summary. Never throws — a repo whose seeding fails is
 * recorded with an `error` and the sweep continues.
 */
export async function raiseBoyScoutIdleTasks(
  opts: RaiseBoyScoutIdleTasksOptions,
): Promise<Result<RaiseBoyScoutIdleTasksResult>> {
  const repos = (opts.repos ?? []).map((r) => r.trim()).filter((r) =>
    r.length > 0
  );
  if (repos.length === 0) {
    return { ok: false, error: new Error("repos must be a non-empty list") };
  }

  const log = opts.log ?? (() => {});
  const summary: RaiseBoyScoutIdleTasksResult = {
    repos: [],
    totalCreated: 0,
    totalSkipped: 0,
    failedRepos: 0,
  };

  for (const repo of repos) {
    const result = await createAllIdleTaskWrappers(repo, {
      templateNames: BOY_SCOUT_TEMPLATE_NAMES,
      ghCommandFn: opts.ghCommandFn,
      ensureLabelFn: opts.ensureLabelFn,
      findExistingWrapperTitlesFn: opts.findExistingWrapperTitlesFn,
      nowFn: opts.nowFn,
      runId: opts.runId,
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
        `[boy-scout] repo=${repo} action=error reason=${result.error.message}`,
      );
      continue;
    }

    const { created, skipped } = result.value;
    summary.repos.push({ repo, created, skipped });
    summary.totalCreated += created.length;
    summary.totalSkipped += skipped.length;
    log(
      `[boy-scout] repo=${repo} action=done created=${created.length} ` +
        `skipped=${skipped.length}`,
    );
  }

  return { ok: true, value: summary };
}
