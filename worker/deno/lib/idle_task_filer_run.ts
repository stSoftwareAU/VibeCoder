/**
 * Per-idle-tick wrapper around the idle-task filer (Issue #2158).
 *
 * The per-issue verify-and-reapply path in `maybe-file-idle-task`
 * (Issues #2130 + #2137) handles the common case where `gh issue
 * create --label idle-task` silently drops the label, but the
 * REAPPLY_MAX_ATTEMPTS budget is finite. When every reapply attempt
 * hits a transient REST/CLI failure the wrapper lands unlabelled and
 * the loud `[idle-task] ALERT` line fires — but the orphan still sits
 * on GitHub invisible to the priority queue and the cross-repo dedup
 * gate until a human notices.
 *
 * The `backfillIdleTaskLabels` sweep (Issue #2131) is the existing
 * safety net: walk every monitored repo, find open
 * `Run a security scan` wrappers with no `idle-task` label, and apply
 * it. It already runs once at worker startup via `setup.sh`. This
 * module re-uses the same helper on every idle tick so any orphan
 * filed after startup is rescued automatically before the next filer
 * attempt — bounded extra cost (one `gh issue list` per repo per idle
 * tick) for an unbounded reduction in mean-time-to-rescue.
 *
 * Execution order is fixed: rescue first, file second. If a previous
 * tick left an orphan it is now labelled and visible to the cross-repo
 * dedup gate, so the new filer pass correctly treats the repo as
 * already busy and skips it.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  backfillIdleTaskLabels,
  type BackfillSummary,
  formatBackfillEvent,
  formatBackfillSummary,
} from "./idle_task_backfill.ts";

/** Options for {@link runIdleTaskFilerCycle}. */
export interface RunIdleTaskFilerCycleOptions {
  /** Monitored repo slugs (`owner/name`). */
  repos: readonly string[];
  /**
   * Structured progress log sink. The same sink that
   * `maybe-file-idle-task` uses, so the `[backfill] ...` and
   * `[idle-task] ...` lines appear adjacent in the worker log.
   */
  log: (line: string) => void;
  /**
   * Fire the actual filer (typically wraps
   * `maybeFileIdleTaskCommand.execute`). Resolves when the filer has
   * decided to file or skip. Any throw is swallowed by the caller so a
   * filer crash does not abort the main loop.
   */
  fileFn: () => Promise<void>;
  /**
   * Injectable gh CLI runner threaded into the back-fill sweep. The
   * default is the production retry wrapper from {@link
   * backfillIdleTaskLabels}.
   */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Override for the back-fill sweep itself. Exposed so unit tests can
   * observe the call without stubbing two layers of gh.
   */
  backfillFn?: (opts: {
    repos: readonly string[];
    log?: (event: import("./idle_task_backfill.ts").BackfillEvent) => void;
    ghCommandFn?: (args: string[]) => Promise<string>;
  }) => Promise<BackfillSummary>;
}

/**
 * Run one idle-task filer cycle: back-fill orphans first, then invoke
 * the filer. Both steps are best-effort — a thrown back-fill never
 * blocks the filer, and a filer throw is re-thrown to the caller so
 * the existing `runIdleTaskFiler` `try/catch` (Issue #2005) can route
 * it through `logger.warn`.
 */
export async function runIdleTaskFilerCycle(
  opts: RunIdleTaskFilerCycleOptions,
): Promise<void> {
  const backfillFn = opts.backfillFn ?? backfillIdleTaskLabels;

  // 1. Rescue any orphan wrappers from previous ticks. A throw here
  //    is logged and swallowed — the back-fill is a best-effort
  //    safety net and must not stop the filer running.
  try {
    const summary = await backfillFn({
      repos: opts.repos,
      ghCommandFn: opts.ghCommandFn,
      log: (event) => opts.log(formatBackfillEvent(event)),
    });
    opts.log(formatBackfillSummary(summary));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.log(`[backfill] action=error reason=${message}`);
  }

  // 2. File a new wrapper if eligible. Re-throws so the caller's
  //    existing best-effort `try/catch` keeps emitting its
  //    "Idle-task filer trigger failed" warning on a filer crash.
  await opts.fileFn();
}
