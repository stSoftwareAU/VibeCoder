/**
 * Busy-repo check for the idle-task filer (Issue #2054).
 *
 * The idle-task framework serialises background work per repo via
 * label-only dedup on `idle-task`. When the worker fleet runs with
 * multiple Vibe Coders, an idle worker would happily file a new
 * `idle-task` in a repo that already has approved work
 * (`top-priority`, `work-on`, `low-priority`, or an existing
 * `idle-task`) — but that does nothing to free the idle worker, because
 * the existing labelled work will be drained by whichever worker is
 * already attached to that repo. Adding the new idle-task there just
 * stacks work nobody else can pick up.
 *
 * This helper answers "does this repo already have approved work in
 * flight?" so the filer can skip busy repos and place the idle-task in
 * one with no work queued. If every monitored repo is busy, the filer
 * skips creation entirely for this round.
 *
 * The busy set is the canonical discovery labels plus `idle-task`:
 *
 *   - `top-priority`
 *   - `work-on`
 *   - `low-priority`
 *   - `idle-task`
 *
 * An open issue makes the repo busy only when it carries one of those
 * labels AND is **unblocked** — i.e. the worker could actually pick it
 * up next (Issue #2440). Issues also carrying a blocked label
 * (`needs-human`, `failed`, `failed-once`, `planning`) are stalled or
 * in-triage work the worker cannot advance, so they do NOT suppress a
 * fresh idle-task in another repo with a genuinely empty queue. A
 * label-only `gh issue list --label X` query cannot exclude these, so
 * the helper fetches every open issue for the label and filters
 * client-side.
 *
 * Issue #2474: the per-label fetch must not truncate at a small page
 * boundary. The old 10-issue cap produced a false "not busy" verdict
 * whenever the first 10 issues on a label were all blocked while
 * unblocked issues existed beyond the page — silently suppressing
 * idle-task filing on the affected repo. The cap is now large enough to
 * cover the full open set (gh `--limit` auto-paginates the underlying
 * API to reach it), and per-label unblocked/blocked counts are logged in
 * a structured, greppable form so the busy verdict is auditable.
 *
 * `idle-task` is kept in the busy set (defence-in-depth against a TOCTOU
 * race between the cross-repo dedup `findAnyOpenIdleTaskWrapper` and the
 * per-repo file) even though it is the lowest priority — an in-flight
 * idle-task still counts as worker work for this repo.
 *
 * Issue #2077: `idle-task-pending` was retired alongside the
 * `requiresApproval` flag — `idle-task` is already the lowest
 * priority, so a separate approval gate added no value.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { runGhCommand } from "./github.ts";
import { LABEL_DEFAULTS } from "./config_defaults.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";

/**
 * Labels that count as "approved work in flight" for the busy check.
 * Order is determinism only — any single hit short-circuits the loop.
 *
 * Issue #2077: `idle-task-pending` retired alongside the `requiresApproval`
 * template flag — `idle-task` is already the lowest priority in the
 * queue, so a separate approval gate was unnecessary.
 */
export const APPROVED_WORK_LABELS: readonly string[] = [
  LABEL_DEFAULTS.topPriorityLabel,
  LABEL_DEFAULTS.workOnLabel,
  LABEL_DEFAULTS.lowPriorityLabel,
  IDLE_TASK_LABEL,
] as const;

/**
 * Real-work pickup labels for the fleet-global existence gate
 * (Issue #2813). This is `APPROVED_WORK_LABELS` minus `idle-task`: an
 * open, unblocked `top-priority`/`work-on`/`low-priority` issue ANYWHERE
 * in the monitored set means the fleet has genuine work, so an idle-task
 * must not be filed — even when that issue was merely *deferred* this
 * cycle by `nice` tiering, fair rotation, or local/cross-worker cooldown
 * rather than claimed. `idle-task` is excluded because an in-flight
 * idle-task wrapper is already caught earlier by the cross-repo wrapper
 * dedup (`findAnyOpenIdleTaskWrapper`, Issue #2092); only real work should
 * suppress fresh idle filing here.
 */
export const REAL_WORK_LABELS: readonly string[] = [
  LABEL_DEFAULTS.topPriorityLabel,
  LABEL_DEFAULTS.workOnLabel,
  LABEL_DEFAULTS.lowPriorityLabel,
] as const;

/**
 * Labels that mark an issue as NOT pickable by the worker (Issue #2440).
 * An approved-work issue also carrying any of these is stalled or
 * in-triage, so it must not register the repo as busy for idle-task
 * purposes. Aligns semantically with the "is this issue pickable" logic
 * in `issue_filter.ts`.
 */
export const BLOCKED_LABELS: readonly string[] = [
  LABEL_DEFAULTS.needsHumanLabel,
  LABEL_DEFAULTS.failedLabel,
  LABEL_DEFAULTS.failedOnceLabel,
  LABEL_DEFAULTS.planningLabel,
] as const;

/**
 * Per-label fetch cap (Issue #2474). gh's `--limit` auto-paginates the
 * underlying API to gather up to this many issues in a single call, so the
 * unblocked/blocked verdict is computed over the full open set for the label
 * rather than being truncated at a small page boundary. A single
 * approved-work label carrying more open issues than this cap is implausible;
 * if it is ever reached the helper logs a warning so the truncation is
 * visible rather than silent.
 */
const LABEL_FETCH_CAP = 500;

export interface IsRepoBusyForIdleTaskOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Structured-log sink for the auditable per-label counts (Issue #2474).
   * Defaults to `console.log`. The idle-task filer passes its own `log` so
   * the counts land in the same greppable stream as the rest of the
   * dispatch trace.
   */
  logFn?: (message: string) => void;
}

/** Shape of a single issue row from `gh issue list --json number,labels`. */
interface IssueRow {
  number?: number;
  labels?: Array<{ name?: string }>;
}

/** True if `row` carries at least one blocked label (Issue #2440). */
function isBlocked(row: IssueRow): boolean {
  const names = (row.labels ?? []).map((l) => l?.name ?? "");
  return names.some((n) => BLOCKED_LABELS.includes(n));
}

/**
 * Returns true if `opts.repo` has any open, **unblocked** issue labelled
 * with any of `APPROVED_WORK_LABELS`. Short-circuits on the first label
 * that yields a surviving (unblocked) issue.
 *
 * For each approved label the helper fetches every open issue (up to
 * {@link LABEL_FETCH_CAP}) and drops any issue also carrying a
 * `BLOCKED_LABELS` entry (`needs-human`, `failed`, `failed-once`,
 * `planning`) — those are stalled or in-triage and the worker cannot
 * pick them up, so they must not suppress fresh idle-task work elsewhere
 * (Issue #2440). The repo is busy only when at least one issue survives
 * the filter. Per-label unblocked/blocked counts are logged in a
 * structured, greppable form so the busy verdict is auditable
 * (Issue #2474).
 *
 * gh failures are surfaced as exceptions so the caller can decide how
 * to handle them — the idle-task command treats them as "go ahead and
 * try filing" so a transient gh hiccup does not silently disable the
 * filer.
 */
export async function isRepoBusyForIdleTask(
  opts: IsRepoBusyForIdleTaskOptions,
): Promise<boolean> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const log = opts.logFn ?? ((m: string) => console.log(m));
  return await repoHasUnblockedWork(opts.repo, APPROVED_WORK_LABELS, gh, log);
}

/**
 * Returns true if `repo` has any open, unblocked issue carrying any of
 * `labels`. Shared by {@link isRepoBusyForIdleTask} (per-repo busy check,
 * `APPROVED_WORK_LABELS`) and {@link anyRepoHasUnblockedRealWork} (the
 * fleet-global existence gate, `REAL_WORK_LABELS`). Short-circuits on the
 * first label that yields a surviving (unblocked) issue. Per-label
 * unblocked/blocked counts are logged in a structured, greppable form so
 * the verdict is auditable (Issue #2474).
 */
async function repoHasUnblockedWork(
  repo: string,
  labels: readonly string[],
  gh: (args: string[]) => Promise<string>,
  log: (message: string) => void,
): Promise<boolean> {
  for (const label of labels) {
    const raw = await gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number,labels",
      "--limit",
      String(LABEL_FETCH_CAP),
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A malformed response for one label should not be treated as
      // "busy" — log it as a warning and try the next label.
      log(
        `[repo-busy-idle-task] repo=${repo} label=${label} ` +
          `action=warn reason=malformed_gh_output`,
      );
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    const rows = parsed as IssueRow[];
    const total = rows.length;
    let blocked = 0;
    for (const row of rows) {
      if (isBlocked(row)) {
        blocked++;
      }
    }
    const unblocked = total - blocked;
    // Structured, greppable audit line for every probed label.
    log(
      `[repo-busy-idle-task] repo=${repo} label=${label} ` +
        `unblocked=${unblocked} blocked=${blocked}`,
    );
    if (total >= LABEL_FETCH_CAP) {
      // The fetch hit the cap — there may be more open issues we did not
      // see. Surface it rather than silently truncating the verdict.
      log(
        `[repo-busy-idle-task] repo=${repo} label=${label} ` +
          `action=warn reason=fetch_cap_reached cap=${LABEL_FETCH_CAP}`,
      );
    }
    // Busy as soon as one label yields an unblocked (pickable) issue.
    if (unblocked > 0) {
      return true;
    }
  }
  return false;
}

/** Options for {@link anyRepoHasUnblockedRealWork}. */
export interface AnyRepoHasUnblockedRealWorkOptions {
  /** Monitored repositories in `owner/repo` form. */
  repos: readonly string[];
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Structured-log sink (Issue #2474). Defaults to `console.log`. */
  logFn?: (message: string) => void;
}

/**
 * Fleet-global existence gate (Issue #2813). Returns true as soon as ANY
 * repo in `opts.repos` holds an open, **unblocked**
 * `top-priority`/`work-on`/`low-priority` issue ({@link REAL_WORK_LABELS}).
 *
 * This answers "does the monitored set have real work right now?" —
 * **independent of whether that work was claimable/claimed this cycle**. A
 * `work-on` issue deferred this cycle by `nice` tiering, fair rotation, or
 * cooldown still *exists*, so it must suppress idle-task filing across the
 * whole fleet, not just in its own repo. This repairs the filing half of
 * the #2806 idle-vs-work-on inversion: the per-repo {@link
 * isRepoBusyForIdleTask} check let a quiet repo B be filed into while a
 * different repo A held the deferred backlog.
 *
 * Short-circuits on the first repo with surviving (unblocked) work, so a
 * busy lead-of-list repo costs a single probe. Blocked issues
 * (`needs-human`, `failed`, `failed-once`, `planning`) do not count, by the
 * same {@link BLOCKED_LABELS} filter the per-repo check uses (Issue #2440).
 *
 * gh failures are surfaced as exceptions so the caller can decide how to
 * handle them — the idle-task filer treats a throw as "no work, go ahead
 * and try filing" so a transient gh hiccup never silently disables the
 * filer.
 */
export async function anyRepoHasUnblockedRealWork(
  opts: AnyRepoHasUnblockedRealWorkOptions,
): Promise<boolean> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const log = opts.logFn ?? ((m: string) => console.log(m));
  for (const repo of opts.repos) {
    if (await repoHasUnblockedWork(repo, REAL_WORK_LABELS, gh, log)) {
      return true;
    }
  }
  return false;
}
