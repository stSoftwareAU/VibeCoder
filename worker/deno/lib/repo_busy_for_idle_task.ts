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
// Issue #1050: the fleet-global existence gate reads its "is this issue
// claimable" verdict from the audit's classifier rather than keeping a
// second, laxer definition of the same thing.
import { classifyIssues } from "./idle_detect_diagnostics.ts";
import type { ClosedPR, OpenPR } from "./issue_query.ts";

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

/**
 * Shape of a single issue row from the fleet gate's richer fetch
 * (Issue #1050) — assignees and milestone carry the work-stream occupancy
 * the scan refuses on, the title carries the milestone-tracker fallback, and
 * the body carries the dependency references.
 */
interface ClaimableIssueRow {
  number?: number;
  title?: string;
  labels?: Array<{ name?: string }>;
  assignees?: Array<{ login?: string }>;
  milestone?: { title?: string } | null;
  /** Carries the dependency references the scan's own gate reads. */
  body?: string;
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
  /**
   * GitHub login of this worker (Issue #1050) — the account the claim
   * scan's `milestone-occupied` gate is asked about. Omitted → occupancy
   * is still modelled over {@link
   * AnyRepoHasUnblockedRealWorkOptions.pushCapableAuthors} alone.
   */
  workerUser?: string;
  /**
   * The accounts the fleet operates, from
   * `resolveFleetMaintenanceAuthorSet`, so the gate refuses the same work
   * streams the scan refuses (Issues #1050, #1064). NEVER
   * `config.allowedAuthors` — that is a permission list and holds humans,
   * whose assignments never occupy a stream. Omitted → occupancy is
   * modelled over `workerUser` alone, the pre-#1050 blind spot: an issue a
   * sibling worker held made a whole repository unclaimable to the scan
   * while this gate went on reporting its backlog as fleet work.
   */
  pushCapableAuthors?: readonly string[];
  /**
   * The open PRs the fleet owns for `repo`, as the claim scan reads them
   * (Issue #1050). Supplied, an issue whose work stream already has a fleet
   * PR open is **not** startable — the scan refuses it as `pr-blocked` —
   * so it must not suppress idle filing.
   *
   * This is the gate's largest blind spot when omitted: on
   * `stSoftwareAU/NEAT-AI-Ockham` six `work-on` issues sat behind one open
   * PR, the scan could start none of them, and the gate reported the fleet
   * as busy on all of them. Best-effort — a rejection falls back to no PR
   * data, restoring the pre-#1050 over-count rather than inventing work.
   */
  openPRsFn?: (repo: string) => Promise<readonly OpenPR[]>;
  /**
   * The fleet's recently closed/merged PRs for `repo` (Issue #1050). Only
   * `merged: true` entries count: those are the ones the scan refuses
   * *permanently* as `merged-pr-permanent` (Issue #3151). Best-effort, by
   * the same rule as {@link AnyRepoHasUnblockedRealWorkOptions.openPRsFn}.
   */
  mergedPRsFn?: (repo: string) => Promise<readonly ClosedPR[]>;
  /**
   * True when this run is holding `issueNumber` in `repo` back whatever
   * GitHub says (Issue #1050) — the persisted retry cooldown plus this
   * run's processed-issue registry, the same `isIssueInCooldown` predicate
   * `find_oldest_issue.ts` filters every tier against. Work in cooldown
   * cannot be started this cycle, so it must not suppress idle filing.
   * Best-effort: a throw falls back to no holds.
   */
  runLocalHoldFn?: (repo: string, issueNumber: number) => boolean;
}

/**
 * Fleet-global existence gate (Issue #2813). Returns true as soon as ANY
 * repo in `opts.repos` holds an open, **unblocked**
 * `top-priority`/`work-on`/`low-priority` issue ({@link REAL_WORK_LABELS}).
 *
 * This answers "does the monitored set hold work a slot **could claim**
 * right now?". A `work-on` issue merely *deferred* this cycle by `nice`
 * tiering, fair rotation, or cooldown still counts — it will be claimed on
 * a later cycle, so filing an idle-task against it would invert priority.
 * This repairs the filing half of the #2806 idle-vs-work-on inversion: the
 * per-repo {@link isRepoBusyForIdleTask} check let a quiet repo B be filed
 * into while a different repo A held the deferred backlog.
 *
 * Issue #1050 narrowed "could claim" from labels to the claim scan's own
 * verdict. The question used to be answered by labels alone, so work the
 * scan *permanently* refuses — a stream occupied by a sibling worker, an
 * issue assigned to someone, a milestone tracker — suppressed idle filing
 * across the whole fleet for as long as it stayed open. See
 * {@link repoHasClaimableRealWork}; blocked issues still do not count, and
 * neither now does unclaimable work.
 *
 * Short-circuits on the first repo with claimable work, so a busy
 * lead-of-list repo costs a single probe.
 *
 * gh failures are surfaced as exceptions so the caller can decide how to
 * handle them — the idle-task filer treats a throw as "no work, go ahead
 * and try filing" so a transient gh hiccup never silently disables the
 * filer.
 */
export async function anyRepoHasUnblockedRealWork(
  opts: AnyRepoHasUnblockedRealWorkOptions,
): Promise<boolean> {
  return (await countReposWithStartableWork({ ...opts, stopAt: 1 })) > 0;
}

/** Options for {@link countReposWithStartableWork}. */
export interface CountReposWithStartableWorkOptions
  extends AnyRepoHasUnblockedRealWorkOptions {
  /**
   * Stop probing once this many repositories have been counted. The caller
   * only ever compares the count against its idle-slot capacity, so once the
   * bound is met the remaining repositories cannot change the verdict and
   * their `gh` calls are not worth paying for — this preserves the
   * short-circuit {@link anyRepoHasUnblockedRealWork} always had. Omitted or
   * non-positive means "count them all".
   */
  stopAt?: number;
}

/**
 * How many repositories in `opts.repos` hold work a slot could **start right
 * now** (Issue #1083).
 *
 * The boolean question this replaces — "does *anything* anywhere have
 * startable work?" — suppressed idle filing across all eighteen monitored
 * repositories the moment a single issue was startable in one of them.
 * Twenty-five `work-on` issues waiting in `stSoftwareAU/VibeCoder` therefore
 * kept fourteen empty repositories empty while six slots sat idle. A startable
 * issue occupies exactly one slot, not eight, so the caller compares this
 * count against the number of idle slots and files only for the surplus.
 *
 * The unit is the **repository**, not the issue: work in a repository is
 * serialised per work stream, so a repository's backlog cannot fill more than
 * a slot's worth of capacity at a time in the common case. Counting
 * repositories therefore under-states how much real work is available, which
 * errs towards filing an idle task rather than towards leaving a slot empty —
 * and an idle task is the lowest tier in the queue, so it can never take a
 * slot from the real work it was counted beside.
 *
 * gh failures are surfaced as exceptions so the caller can decide how to
 * handle them — the idle-task filer treats a throw as "no work, go ahead and
 * try filing" so a transient gh hiccup never silently disables the filer.
 */
export async function countReposWithStartableWork(
  opts: CountReposWithStartableWorkOptions,
): Promise<number> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const log = opts.logFn ?? ((m: string) => console.log(m));
  const bound = opts.stopAt !== undefined && opts.stopAt > 0
    ? opts.stopAt
    : Number.POSITIVE_INFINITY;
  let count = 0;
  for (const repo of opts.repos) {
    if (await repoHasStartableWork(repo, gh, log, opts)) {
      count += 1;
      if (count >= bound) return count;
    }
  }
  return count;
}

/**
 * True when `repo` holds at least one open issue a slot could **start right
 * now** — {@link REAL_WORK_LABELS}, as classified by the audit's
 * {@link classifyIssues} (Issue #1050).
 *
 * Before #1050 this asked a label-only question — "is there an open
 * `top-priority`/`work-on`/`low-priority` issue without a blocking label?" —
 * and answered `true` for work the scan cannot start. Two field incidents,
 * one week apart, are the same fault:
 *
 *  - `stSoftwareAU/VibeCoder`: one assignment in the default-branch stream
 *    made every one of the repository's twenty-odd work issues
 *    `milestone-occupied` to the scan, while this gate reported the
 *    repository as holding fleet work.
 *  - `stSoftwareAU/NEAT-AI-Ockham`: six `work-on` issues (#104-#110) sat
 *    behind a single open PR (#116). The scan refused every one as
 *    `pr-blocked`; this gate counted all six.
 *
 * Either one suppressed idle-task filing across all eighteen monitored
 * repositories for as long as it lasted, while seventeen of them were empty
 * and slots sat idle. The requirement is one sentence: *if no work can be
 * started right now, file an idle task* — so the question here is
 * "startable", never "exists".
 *
 * The answer is not a third definition of claimable but the same one: the
 * classifier the idle-detect audit runs, restricted to the real-work labels.
 * Its gates are the scan's — discovery label, blocking label, assignee,
 * milestone tracker, work-stream occupancy, open PR, merged PR, dependency,
 * run-local hold — and each of the last four is applied only when the caller
 * supplies the data for it. Omitting one restores that gate's pre-#1050
 * over-count, which suppresses filing: the direction that starves the fleet
 * rather than flooding it (#2106), so callers should supply all of them.
 *
 * One `gh issue list` per repo, unfiltered by label: occupancy is a property
 * of the whole work stream, and the issue that occupies it need carry no
 * discovery label at all — the 2026-08-26 issue carried none. The PR and
 * hold probes run **only** when an issue survives the cheap gates, so an
 * empty or plainly-busy repository still costs exactly one call.
 *
 * The blocking-label set is the classifier's, which is `filterAndSort`'s:
 * `failed`, `needs-revision`, `refine-issue`, `planning`, `question`,
 * `needs-human`. It differs from {@link BLOCKED_LABELS} — still used by the
 * per-repo {@link isRepoBusyForIdleTask} placement check — by `failed-once`,
 * which the scan does not treat as blocking (`cleanStaleLabels` clears it),
 * so such an issue is startable work and suppresses filing, as the scan says
 * it should.
 */
async function repoHasStartableWork(
  repo: string,
  gh: (args: string[]) => Promise<string>,
  log: (message: string) => void,
  opts: AnyRepoHasUnblockedRealWorkOptions,
): Promise<boolean> {
  const workerUser = opts.workerUser ?? "";
  const pushCapableAuthors = opts.pushCapableAuthors ?? [];
  const raw = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    // `body` carries the dependency references the scan's gate reads — one
    // extra field on a call already being made, no extra request.
    "number,title,labels,assignees,milestone,body",
    "--limit",
    String(LABEL_FETCH_CAP),
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed response must not read as "the fleet has work" — that
    // would suppress idle filing on a parse error. Warn and treat the repo
    // as empty, matching the per-label check's behaviour.
    log(
      `[repo-busy-idle-task] repo=${repo} ` +
        `action=warn reason=malformed_gh_output`,
    );
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const rows = parsed as ClaimableIssueRow[];
  const issues = rows.map((row) => ({
    number: typeof row.number === "number" ? row.number : 0,
    title: typeof row.title === "string" ? row.title : "",
    labels: (row.labels ?? []).map((l) => l?.name ?? ""),
    assignees: (row.assignees ?? []).map((a) => a?.login ?? ""),
    milestone: row.milestone?.title ?? "",
    body: typeof row.body === "string" ? row.body : "",
  }));

  if (issues.length >= LABEL_FETCH_CAP) {
    // The fetch hit the cap — there may be more open issues we did not
    // see. Surface it rather than silently truncating the verdict.
    log(
      `[repo-busy-idle-task] repo=${repo} ` +
        `action=warn reason=fetch_cap_reached cap=${LABEL_FETCH_CAP}`,
    );
  }

  const baseOptions = {
    workerUser,
    pushCapableAuthors,
    claimableLabels: REAL_WORK_LABELS,
    repo,
    openIssueNumbers: new Set(issues.map((i) => i.number)),
  };
  // The cheap pass first: label, blocking label, assignee, tracker,
  // occupancy and dependency all resolve from the response already in hand.
  // Nothing survives it, nothing can be started, and no PR probe is worth
  // paying for.
  const cheapClaimable = classifyIssues(issues, baseOptions)
    .filter((v) => v.claimable).length;
  if (cheapClaimable === 0) {
    log(
      `[repo-busy-idle-task] repo=${repo} scope=real_work ` +
        `total_open=${issues.length} startable=0 pr_probe=skipped`,
    );
    return false;
  }

  // Something survived, so the PR and hold gates are worth resolving. Each
  // is best-effort: a failure restores that gate's over-count rather than
  // inventing an empty repository.
  let openPRs: readonly OpenPR[] = [];
  if (opts.openPRsFn) {
    try {
      openPRs = await opts.openPRsFn(repo);
    } catch {
      openPRs = [];
    }
  }
  let mergedPRs: readonly ClosedPR[] = [];
  if (opts.mergedPRsFn) {
    try {
      mergedPRs = await opts.mergedPRsFn(repo);
    } catch {
      mergedPRs = [];
    }
  }
  let runLocalHolds = new Set<number>();
  if (opts.runLocalHoldFn) {
    try {
      runLocalHolds = new Set(
        issues.filter((i) => opts.runLocalHoldFn!(repo, i.number)).map((i) =>
          i.number
        ),
      );
    } catch {
      runLocalHolds = new Set<number>();
    }
  }

  const startable = classifyIssues(issues, {
    ...baseOptions,
    openPRs,
    mergedPRs,
    runLocalHolds,
  }).filter((v) => v.claimable).length;
  // Structured, greppable audit line — one per repo, replacing the
  // per-label pair. `startable` is the scan's own verdict now, so the count
  // can be reconciled against the `[idle-detect]` line for the same repo.
  log(
    `[repo-busy-idle-task] repo=${repo} scope=real_work ` +
      `total_open=${issues.length} startable=${startable} ` +
      `pre_pr=${cheapClaimable} open_prs=${openPRs.length}`,
  );
  return startable > 0;
}
