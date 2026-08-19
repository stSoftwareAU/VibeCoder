/**
 * Idle-detection audit diagnostics (Issue #2106).
 *
 * The Priority 2 scan in `run_core.ts` walks every monitored repo and
 * sets `tracker.foundClaimableIssue = true` when an issue is claimed.
 * When that flag is `false` at end-of-cycle the worker calls the
 * idle-task filer — and PRs #2046 / #2089 / #2092 / #2095 have all been
 * landed because the filer was firing more often than expected.
 *
 * The fix shape proposed in #2106 is observability, not yet another
 * filter: emit per-repo per-tick diagnostics so operators can see, from
 * the log alone, whether the worker truly had no claimable work, and
 * cross-check the scan's verdict. The audit also tags every line with a
 * host identifier so concurrent multi-host idle declarations are visible
 * in aggregated logs.
 *
 * # What "claimable" means here
 *
 * The audit re-classifies open issues using the same signals the
 * Priority 2 scan and `findOldestIssue` use, but reads them off a single
 * `gh issue list` per repo so the probe is cheap. An issue is
 * *claimable* when every gate below passes:
 *
 *   1. Carries at least one approved-work label
 *      (`top-priority`, `work-on`, `low-priority`, `idle-task`).
 *   2. Carries no blocking label (`failed`, `needs-revision`,
 *      `refine-issue`, `planning`, `question`, `needs-human`).
 *   3. Has no assignees (`filterByAssignee` in `issue_filter.ts`).
 *   4. Its work stream — the milestone title, or `""` for default
 *      branch — is not already occupied by an issue assigned to
 *      `workerUser` (`isMilestoneOccupied`).
 *   5. No open PR blocks its work stream under the scan's own
 *      milestone-aware rule (`getBlockingPRForIssue`), unless the issue
 *      carries `ignore-open-prs` (Issue #4223). Requires the caller to
 *      supply PRs via `openPRsFn`; without them this gate is skipped.
 *
 * The probe deliberately stops short of cooldown / closed-PR filters
 * (which are run-local) so the diagnostic answers the cross-fleet
 * question "is there work GitHub *could* hand to a worker right now?"
 * rather than "did this particular worker pick something up this
 * cycle?".
 *
 * Gate 5 is not one of those run-local filters. An issue whose PR is
 * already open and awaiting review is work GitHub *cannot* hand to a
 * worker, and open PRs awaiting review are this fleet's normal steady
 * state — so without it the audit disagreed with a correct scan on
 * essentially every tick (1512 alerts in a single log on host-3), drowning
 * the genuine #2106 symptom it exists to surface and suppressing the
 * idle-task filer for as long as any PR was open.
 *
 * # Mis-classification alert
 *
 * When the audit reports `claimable_total > 0` but the caller reports
 * the scan claimed nothing (`foundClaimableIssue=false`), a single
 * `[idle-detect] ... ALERT mis_classification ...` line is emitted
 * listing the offending repos. That is the "audit catches the original
 * symptom" acceptance criterion: log scrapers can grep for the literal
 * `mis_classification` token.
 *
 * # Probe-failure classification (Issue #4035)
 *
 * Every `gh issue list` failure used to collapse into a single
 * `reason=probe_error` line, so a repo the worker could no longer *see*
 * (#4028) looked identical to a five-second network blip.
 * {@link classifyProbeFailure} splits those into `access_denied`,
 * `transient` and `parse_failed`, recorded on the snapshot and appended
 * to the log line as `failure_kind=<kind>`.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { runGhCommand } from "./github.ts";
import { getBlockingPRForIssue, type OpenPR } from "./issue_query.ts";
import { LABEL_DEFAULTS } from "./config_defaults.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
// Issue #4037: the audit's per-repo probe also feeds the access store.
import { recordRepoProbeBestEffort } from "./monitored_repo_access.ts";

// ---------------------------------------------------------------------------
// Label sets
// ---------------------------------------------------------------------------

/**
 * Labels that mark an issue as "approved work the scan loop can claim".
 * Mirrors `APPROVED_WORK_LABELS` in `repo_busy_for_idle_task.ts` so the
 * two checks stay in lockstep — the busy gate skips repos with any of
 * these, the audit counts them.
 */
export const CLAIMABLE_LABELS: readonly string[] = [
  LABEL_DEFAULTS.topPriorityLabel,
  LABEL_DEFAULTS.workOnLabel,
  LABEL_DEFAULTS.lowPriorityLabel,
  IDLE_TASK_LABEL,
] as const;

/**
 * Labels that exclude an issue from the discovery scan regardless of
 * its discovery label. Matches the blocking set in
 * `issue_filter.ts::filterAndSort`.
 */
export const BLOCKING_LABELS: readonly string[] = [
  LABEL_DEFAULTS.failedLabel,
  LABEL_DEFAULTS.needsRevisionLabel,
  LABEL_DEFAULTS.refineIssueLabel,
  LABEL_DEFAULTS.planningLabel,
  LABEL_DEFAULTS.questionLabel,
  LABEL_DEFAULTS.needsHumanLabel,
] as const;

// ---------------------------------------------------------------------------
// Public data shape
// ---------------------------------------------------------------------------

/** Dominant reason `claimable=0` for a single repo. */
export type ClaimableSkipReason =
  | "has_claimable"
  | "no_open"
  | "label_filter"
  | "assignee_filter"
  | "blocking_label"
  | "stream_occupied"
  | "pr_blocked"
  | "probe_error";

/**
 * Audit verdict for a single repo. `total_open` counts every open issue
 * gh reports (capped at the probe's `--limit`); `claimable` is the
 * subset that passes every gate. `reason` is `"has_claimable"` when
 * `claimable > 0`.
 */
export interface RepoClaimableSnapshot {
  repo: string;
  totalOpen: number;
  claimable: number;
  reason: ClaimableSkipReason;
  /** When `reason === "probe_error"`, the gh / parse error message. */
  errorMessage?: string;
  /**
   * When `reason === "probe_error"`, the classification of
   * {@link RepoClaimableSnapshot.errorMessage} — see
   * {@link classifyProbeFailure}. Absent for every other reason.
   */
  failureKind?: ProbeFailureKind;
}

/** Output of {@link auditClaimableState}. */
export interface ClaimableAuditResult {
  /** Monotonic tick counter supplied by the caller. */
  tick: number;
  /** `hostname:pid` so multi-host idle declarations are visible. */
  host: string;
  /** One entry per repo, in input order. */
  perRepo: RepoClaimableSnapshot[];
  /** Sum of `claimable` across every repo. */
  claimableTotal: number;
  /**
   * `true` when `claimableTotal > 0` but the caller asked us to record a
   * `foundClaimableIssue=false` cycle. Operators grep for the literal
   * `mis_classification` token in the emitted alert line.
   */
  misClassification: boolean;
  /** Repos that contributed to `misClassification` (claimable > 0). */
  misClassificationRepos: string[];
}

// ---------------------------------------------------------------------------
// gh schema
// ---------------------------------------------------------------------------

interface GhIssueLabel {
  name?: string;
}
interface GhIssueAssignee {
  login?: string;
}
interface GhIssueMilestone {
  title?: string;
}
interface GhIssue {
  number?: number;
  title?: string;
  labels?: GhIssueLabel[];
  assignees?: GhIssueAssignee[];
  milestone?: GhIssueMilestone | null;
}

function normaliseIssue(raw: unknown): {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  milestone: string;
} | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as GhIssue;
  if (typeof v.number !== "number" || !Number.isFinite(v.number)) return null;
  const title = typeof v.title === "string" ? v.title : "";
  const labels = Array.isArray(v.labels)
    ? v.labels
      .map((l) => (typeof l?.name === "string" ? l.name : null))
      .filter((s): s is string => s !== null)
    : [];
  const assignees = Array.isArray(v.assignees)
    ? v.assignees
      .map((a) => (typeof a?.login === "string" ? a.login : null))
      .filter((s): s is string => s !== null)
    : [];
  const milestone = (v.milestone && typeof v.milestone.title === "string")
    ? v.milestone.title
    : "";
  return { number: v.number, title, labels, assignees, milestone };
}

// ---------------------------------------------------------------------------
// Pure classifier (extracted so unit tests can exercise it without gh)
// ---------------------------------------------------------------------------

/**
 * Bypass label: the operator has declared that open PRs must not hold this
 * issue back. Mirrors the census (Issue #3526) — raw label presence only, no
 * timeline lookup, because the audit must stay a cheap probe.
 */
const IGNORE_OPEN_PRS_LABEL = "ignore-open-prs";

/**
 * True when an open PR blocks `issue` under the same milestone-aware rule the
 * Priority 2 scan applies (Issue #4223).
 *
 * The empty `pushCapableAuthors` set is deliberate and matches the census: the
 * shared `prs_open_all` cache carries no author, so no PR can be classified as
 * human-authored here and every open PR counts as a blocker. The audit only
 * counts — it never blocks a pickup — so the residual over-count is
 * observability, not policy.
 */
function isPrBlocked(
  issue: { labels: string[]; milestone: string },
  openPRs: readonly OpenPR[],
): boolean {
  if (issue.labels.includes(IGNORE_OPEN_PRS_LABEL)) return false;
  return getBlockingPRForIssue([...openPRs], issue.milestone, []) !== null;
}

/**
 * Probe verdict for a single issue. `claimable=true` means every gate
 * in {@link auditClaimableState}'s docstring passes. `excludedBy` is
 * populated only when `claimable=false`.
 */
export type IssueExclusionReason =
  | "label_filter"
  | "assignee_filter"
  | "blocking_label"
  | "stream_occupied"
  | "pr_blocked";

export interface IssueVerdict {
  number: number;
  claimable: boolean;
  excludedBy?: IssueExclusionReason;
  milestone: string;
}

export interface ClassifyOptions {
  workerUser: string;
  /**
   * The repo's open PRs, so the classifier can apply the scan's
   * milestone-aware blocking rule (Issue #4223).
   *
   * Omitted or empty means "no PR data" and no issue is excluded by this
   * gate — the same fail-safe the census takes (Issue #3526): under-counting
   * blockers merely alerts on work that will not be claimed, whereas
   * inventing blockers would hide the mis-classification this audit exists
   * to catch.
   */
  openPRs?: readonly OpenPR[];
}

/**
 * Classify each issue in `issues` against the same gates the
 * Priority 2 scan applies. The classifier is pure so unit tests can
 * drive every branch without stubbing gh.
 */
export function classifyIssues(
  issues: ReadonlyArray<{
    number: number;
    title?: string;
    labels: string[];
    assignees: string[];
    milestone: string;
  }>,
  opts: ClassifyOptions,
): IssueVerdict[] {
  const claimableSet = new Set(CLAIMABLE_LABELS);
  const blockingSet = new Set(BLOCKING_LABELS);
  const openPRs = opts.openPRs ?? [];

  // Streams occupied by the worker = milestones (or "" for the default
  // branch stream) that already host a worker-assigned open issue.
  const occupiedStreams = new Set<string>();
  for (const issue of issues) {
    if (issue.assignees.includes(opts.workerUser)) {
      occupiedStreams.add(issue.milestone);
    }
  }

  const result: IssueVerdict[] = [];
  for (const issue of issues) {
    const hasClaimable = issue.labels.some((l) => claimableSet.has(l));
    if (!hasClaimable) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "label_filter",
        milestone: issue.milestone,
      });
      continue;
    }
    if (issue.labels.some((l) => blockingSet.has(l))) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "blocking_label",
        milestone: issue.milestone,
      });
      continue;
    }
    if (issue.assignees.length > 0) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "assignee_filter",
        milestone: issue.milestone,
      });
      continue;
    }
    if (occupiedStreams.has(issue.milestone)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "stream_occupied",
        milestone: issue.milestone,
      });
      continue;
    }
    // Issue #4223: an open PR in the issue's work stream means the Priority 2
    // scan will not claim it, so counting it as claimable made the audit
    // permanently disagree with a scan that was right. Work waiting on human
    // review is this fleet's normal steady state, so the `mis_classification`
    // ALERT fired on essentially every tick — 1512 times in one log — and the
    // genuine #2106 symptom became indistinguishable from the noise.
    //
    // Applied last, so an issue excluded for a more fundamental reason keeps
    // that reason: `pr_blocked` marks only issues that would otherwise be
    // claimable right now.
    if (openPRs.length > 0 && isPrBlocked(issue, openPRs)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "pr_blocked",
        milestone: issue.milestone,
      });
      continue;
    }
    // No wrapper-title gate: `idle-task` is just the lowest work-trigger
    // priority, so any unblocked, unassigned idle-task issue is
    // claimable here — matching the collector
    // (`collect_idle_task_candidates.ts`). Whether a claimed wrapper
    // runs a scan template or flows through the standard pipeline is a
    // dispatch-time decision, not a claimability one.
    result.push({
      number: issue.number,
      claimable: true,
      milestone: issue.milestone,
    });
  }
  return result;
}

/**
 * Pick the dominant skip reason for a repo when `claimable === 0`.
 * Specificity order (most → least specific):
 *   stream_occupied > assignee_filter > blocking_label > label_filter.
 * `stream_occupied` is most specific because it means the worker
 * already has work claimed in that stream — the most actionable signal
 * for operators investigating "why was nothing picked up".
 */
export function pickDominantReason(
  verdicts: IssueVerdict[],
): ClaimableSkipReason {
  if (verdicts.length === 0) return "no_open";
  const seen = new Set<IssueExclusionReason>();
  for (const v of verdicts) {
    if (!v.claimable && v.excludedBy !== undefined) seen.add(v.excludedBy);
  }
  // Issue #4223: `pr_blocked` outranks the rest. It is only ever set on an
  // issue that passed every other gate, so "the work is waiting on an open
  // PR" is the most actionable answer to "why was nothing picked up".
  if (seen.has("pr_blocked")) return "pr_blocked";
  if (seen.has("stream_occupied")) return "stream_occupied";
  if (seen.has("assignee_filter")) return "assignee_filter";
  if (seen.has("blocking_label")) return "blocking_label";
  if (seen.has("label_filter")) return "label_filter";
  return "label_filter"; // defensive — only reached on an empty `seen`
}

// ---------------------------------------------------------------------------
// Probe-failure classification (Issue #4035)
// ---------------------------------------------------------------------------

/**
 * What a `reason=probe_error` snapshot actually means.
 *
 * - `access_denied` — the repo is genuinely unreachable for this
 *   identity (the host-3 incident #4028: both `TitlePage/*` repos 404'd
 *   for days while the worker stayed green).
 * - `transient` — a blip that must never affect health: network fault,
 *   5xx, or a rate-limit window.
 * - `parse_failed` — gh succeeded but its JSON did not parse. Not an
 *   access signal.
 */
export type ProbeFailureKind = "access_denied" | "transient" | "parse_failed";

/** Our own marker for the "gh succeeded, JSON did not parse" path. */
const PARSE_FAILED_RE = /^\s*parse_failed\b/i;

/**
 * Rate-limit shapes. GitHub returns **403** for both permission denial
 * and secondary rate limits, so throttling must be matched *before* the
 * permission shapes below — a naive "403 ⇒ no access" rule would flag
 * the whole fleet unhealthy during a rate-limit window.
 */
const RATE_LIMIT_RE =
  /(rate limit exceeded|secondary rate limit|retry-after|x-ratelimit-remaining:\s*0|\b429\b|too many requests)/i;

/** 404 shapes — the repo is invisible to this identity. */
const NOT_FOUND_RE =
  /(\b404\b|could not resolve to a (repository|user|organization)|not found)/i;

/** 403 bodies that indicate a permission decision rather than throttling. */
const PERMISSION_RE =
  /(resource not accessible|must have (push|admin|write|pull) access|\bsaml\b|single sign-on|\bsso\b|not authorized|permission)/i;

/**
 * Classify a probe failure message into an actionable kind.
 *
 * Pure and fail-safe: anything unrecognised is `transient`, so an error
 * shape we have never seen can never mark a host unhealthy. Classification
 * only — this function changes no health behaviour on its own.
 */
export function classifyProbeFailure(message: string): ProbeFailureKind {
  if (PARSE_FAILED_RE.test(message)) return "parse_failed";
  // Throttling first: it is the 403 shape that must NOT read as denial.
  if (RATE_LIMIT_RE.test(message)) return "transient";
  if (NOT_FOUND_RE.test(message) || PERMISSION_RE.test(message)) {
    return "access_denied";
  }
  return "transient";
}

// ---------------------------------------------------------------------------
// Audit entry point
// ---------------------------------------------------------------------------

export interface AuditClaimableStateOptions {
  /** Monitored repo list in `owner/repo` form. */
  repos: readonly string[];
  /** GitHub username of the worker — drives the stream-occupancy check. */
  workerUser: string;
  /** Monotonic tick counter (caller-supplied; the lib never persists it). */
  tick: number;
  /**
   * `foundClaimableIssue` value the caller observed for this cycle.
   * Required so the audit can raise `mis_classification` when its own
   * verdict disagrees with the scan loop. Pass `true` to suppress the
   * alert path entirely (e.g. when calling from a periodic probe
   * outside the idle gate).
   */
  scanFoundClaimable: boolean;
  /** Per-repo issue cap passed to `gh issue list --limit`. Default 200. */
  perRepoLimit?: number;
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Supplies a repo's open PRs so the audit can exclude work the Priority 2
   * scan would refuse under `getBlockingPRForIssue` (Issue #4223).
   *
   * Production wires this to the iteration-scoped `prs_open_all` cache the
   * census already reads, so the gate costs no extra API call. Omit it — or
   * let it reject — and the audit falls back to no PR blocking, exactly as
   * before this option existed.
   */
  openPRsFn?: (repo: string) => Promise<readonly OpenPR[]>;
  /** Progress log sink. Defaults to `console.log`. */
  log?: (line: string) => void;
  /** Hostname source — exposed for tests. Defaults to `Deno.hostname()`. */
  hostnameFn?: () => string;
  /** Process id source — exposed for tests. Defaults to `Deno.pid`. */
  pidFn?: () => number;
}

const DEFAULT_PER_REPO_LIMIT = 200;

/**
 * Audit every repo in `opts.repos` and emit one `[idle-detect]` line per
 * repo, a per-tick summary line, and (when the verdict disagrees with
 * the scan) a `mis_classification` ALERT line. Returns the structured
 * verdict so callers can assert on it in tests.
 */
export async function auditClaimableState(
  opts: AuditClaimableStateOptions,
): Promise<ClaimableAuditResult> {
  const ghFn = opts.ghCommandFn ?? runGhCommand;
  const log = opts.log ?? ((line: string) => console.log(line));
  const limit = opts.perRepoLimit ?? DEFAULT_PER_REPO_LIMIT;

  const hostnameFn = opts.hostnameFn ?? (() => {
    try {
      return Deno.hostname();
    } catch {
      return "unknown-host";
    }
  });
  const pidFn = opts.pidFn ?? (() => Deno.pid);
  const host = `${hostnameFn()}:${pidFn()}`;

  const perRepo: RepoClaimableSnapshot[] = [];
  for (const repo of opts.repos) {
    let raw: string;
    try {
      raw = await ghFn([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        "number,labels,assignees,milestone",
        "--limit",
        String(limit),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failureKind = classifyProbeFailure(message);
      const snap: RepoClaimableSnapshot = {
        repo,
        totalOpen: 0,
        claimable: 0,
        reason: "probe_error",
        errorMessage: message,
        failureKind,
      };
      perRepo.push(snap);
      recordRepoProbeBestEffort(repo, failureKind);
      // `reason=probe_error` is deliberately unchanged — downstream log
      // consumers parse it; `failure_kind` is additive.
      log(
        `[idle-detect] tick=${opts.tick} host=${host} repo=${repo} total_open=0 claimable=0 reason=probe_error failure_kind=${failureKind} message=${message}`,
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorMessage = `parse_failed: ${message}`;
      const failureKind = classifyProbeFailure(errorMessage);
      const snap: RepoClaimableSnapshot = {
        repo,
        totalOpen: 0,
        claimable: 0,
        reason: "probe_error",
        errorMessage,
        failureKind,
      };
      perRepo.push(snap);
      recordRepoProbeBestEffort(repo, failureKind);
      log(
        `[idle-detect] tick=${opts.tick} host=${host} repo=${repo} total_open=0 claimable=0 reason=probe_error failure_kind=${failureKind} message=parse_failed`,
      );
      continue;
    }

    const issues = Array.isArray(parsed)
      ? parsed.map(normaliseIssue).filter((i): i is NonNullable<typeof i> =>
        i !== null
      )
      : [];

    // Issue #4223: read the repo's open PRs so PR-blocked work is not counted
    // as claimable. Best-effort by design — a failed fetch falls back to no PR
    // blocking, which at worst restores the old over-count rather than
    // silently reporting a repo as having nothing to do.
    let openPRs: readonly OpenPR[] = [];
    if (opts.openPRsFn) {
      try {
        openPRs = await opts.openPRsFn(repo);
      } catch {
        openPRs = [];
      }
    }

    const verdicts = classifyIssues(issues, {
      workerUser: opts.workerUser,
      openPRs,
    });
    const claimableCount = verdicts.filter((v) => v.claimable).length;
    const reason: ClaimableSkipReason = claimableCount > 0
      ? "has_claimable"
      : pickDominantReason(verdicts);

    perRepo.push({
      repo,
      totalOpen: issues.length,
      claimable: claimableCount,
      reason,
    });
    // Issue #4037: gh answered for this repo, so the identity can still
    // see it — the one outcome that clears a prior denial count.
    recordRepoProbeBestEffort(repo, "ok");

    log(
      `[idle-detect] tick=${opts.tick} host=${host} repo=${repo} total_open=${issues.length} claimable=${claimableCount} reason=${reason}`,
    );
  }

  const claimableTotal = perRepo.reduce((sum, r) => sum + r.claimable, 0);
  const misClassificationRepos = perRepo
    .filter((r) => r.claimable > 0)
    .map((r) => r.repo);
  const misClassification = !opts.scanFoundClaimable && claimableTotal > 0;

  log(
    `[idle-detect] tick=${opts.tick} host=${host} repos=${opts.repos.length} claimable_total=${claimableTotal}`,
  );

  if (misClassification) {
    // Operators grep the literal `mis_classification` token to surface
    // the regression #2106 set out to catch.
    log(
      `[idle-detect] tick=${opts.tick} host=${host} ALERT mis_classification claimable_total=${claimableTotal} repos=${
        misClassificationRepos.join(",")
      }`,
    );
  }

  return {
    tick: opts.tick,
    host,
    perRepo,
    claimableTotal,
    misClassification,
    misClassificationRepos,
  };
}
