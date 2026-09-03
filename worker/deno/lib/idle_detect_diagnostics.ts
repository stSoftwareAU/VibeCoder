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
 *   6. This run is not holding the issue back (Issue #655) — the
 *      `isIssueInCooldown` predicate `find_oldest_issue.ts` filters every
 *      tier's candidates against, covering the persisted retry cooldown and
 *      the per-run processed-issue registry. Requires the caller to supply
 *      `runLocalHoldFn`; without it this gate is skipped.
 *
 * The probe deliberately stops short of the remaining run-local filters
 * (the closed-PR cooldown, the per-cycle adaptive floor) so the diagnostic
 * answers the cross-fleet question "is there work GitHub *could* hand to a
 * worker right now?" rather than "did this particular worker pick something
 * up this cycle?".
 *
 * Gate 6 is the exception that proves the rule, and it is here because the
 * registry's entries live as long as the process does. On 2026-08-30 two
 * `stSoftwareAU/VibeCoder` issues this run had already handed back were
 * refused silently by the scan on every later cycle while the audit went on
 * counting them, so `mis_classification` fired for the life of the run and
 * the audit's own `claimableTotal` suppressed the idle-task filer with it
 * (VibeCoder#655). The census models the same hold set from the same
 * source, so the three instruments cannot drift apart again.
 *
 * Gate 5 is not one of those run-local filters either. An issue whose PR is
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
import {
  type ClosedPR,
  getBlockingPRForIssue,
  isBlockedByRecentlyClosedPR,
  type OpenPR,
} from "./issue_query.ts";
import { LABEL_DEFAULTS } from "./config_defaults.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
// Issue #4037: the audit's per-repo probe also feeds the access store.
import { recordRepoProbeBestEffort } from "./monitored_repo_access.ts";
import { extractDependencyReferencesDetailed } from "./issue_dependencies.ts";

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
  /** Every candidate is named by a merged fleet PR (GRQ#4419). */
  | "merged_pr_blocked"
  /** Every candidate is held back by this run itself (Issue #655). */
  | "run_local_hold"
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
  /** Issue #857: carries the dependency references the scan's gate reads. */
  body?: string;
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
  const body = typeof (v as { body?: unknown }).body === "string"
    ? (v as { body: string }).body
    : undefined;
  return {
    number: v.number,
    title,
    labels,
    assignees,
    milestone,
    ...(body === undefined ? {} : { body }),
  };
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
 * True when a **merged** fleet PR names `issue` (GRQ#4419).
 *
 * Since Issue #3151 that block is permanent — the Priority 2 scan refuses the
 * issue as `merged-pr-permanent` on every cycle until a trusted author
 * re-applies the pickup label with a date after the merge. The audit did not
 * model it, so a permanently stranded issue kept the `mis_classification`
 * ALERT firing for ever against a scan that was right.
 *
 * Closed-unmerged entries are filtered out: their block is cooldown-windowed
 * and self-clearing. The re-label escape hatch is not modelled either — it
 * needs a per-issue timeline call this cheap probe must not make — so the
 * gate under-counts rather than inventing claimable work.
 */
function isMergedPrBlocked(
  issue: { number: number },
  mergedPRs: readonly ClosedPR[],
): boolean {
  const merged = mergedPRs.filter((pr) => pr.merged === true);
  return isBlockedByRecentlyClosedPR(merged, issue.number) !== null;
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
  | "pr_blocked"
  /** Named by a merged fleet PR — a permanent skip (GRQ#4419). */
  | "merged_pr_blocked"
  /** Names an open dependency the scan refuses it for (#460, GRQ#4465). */
  | "dependency_blocked"
  /** Held back by this run's own cooldown / processed-issue registry (#655). */
  | "run_local_hold";

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
  /**
   * The repo's closed/merged fleet PRs, so the classifier can apply the
   * scan's permanent `merged-pr-permanent` gate (GRQ#4419). Only entries
   * with `merged: true` are honoured. Omitted or empty means "no data" and
   * no issue is excluded by this gate — the same fail-safe as `openPRs`.
   */
  mergedPRs?: readonly ClosedPR[];
  /**
   * Issue numbers this run is holding back whatever GitHub says (Issue
   * #655) — the set `find_oldest_issue.ts` filters every tier's candidates
   * against once the collectors have passed them.
   *
   * Omitted or empty means "no data" and no issue is excluded by this gate,
   * the same fail-safe as `openPRs`: under-counting blockers merely alerts
   * on work that will not be claimed, whereas inventing them would hide the
   * mis-classification this audit exists to catch.
   */
  runLocalHolds?: ReadonlySet<number>;
  /**
   * Issue #857: the repo's own open-issue numbers, so the classifier can
   * model the scan's `dependency-blocked` gate (Issue #460, GRQ#4465) the
   * way `idle_decision_census.ts` already does — resolved from data the
   * caller holds, so it costs no extra `gh` call.
   *
   * Requires `repo` and the issues' `body`. Omitted or empty means "no data"
   * and no issue is excluded by this gate, the same fail-safe as `openPRs`.
   */
  openIssueNumbers?: ReadonlySet<number>;
  /** Repo the issues belong to, for resolving same-repo dependency refs. */
  repo?: string;
}

/**
 * True when `issue` names an open dependency the Priority 2 scan refuses it
 * for (Issue #460, GRQ#4465).
 *
 * Mirrors `isDependencyBlockedByOpenIssue` in `idle_decision_census.ts`,
 * including its two deliberate choices: a same-repo `#N` absent from the
 * open set is closed and does not block, and a cross-repo reference cannot
 * be resolved here so it counts as blocking, because the scan fails safe the
 * same way. Parent/child blocking is not modelled — it needs a per-issue API
 * call, and omitting it under-counts, which merely alerts on work that will
 * not be claimed rather than inventing a blocker.
 */
function isDependencyBlockedByOpenIssue(
  body: string | undefined,
  repo: string,
  openIssueNumbers: ReadonlySet<number>,
): boolean {
  if (body === undefined) return false;
  const refs = extractDependencyReferencesDetailed(body);
  const lowerRepo = repo.trim().toLowerCase();
  return refs.some((ref) => {
    const sameRepo = ref.repo === undefined ||
      ref.repo.trim().toLowerCase() === lowerRepo;
    if (!sameRepo) return true;
    return openIssueNumbers.has(ref.number);
  });
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
    /** Issue #857: body, for the dependency gate. Absent → not blocked. */
    body?: string;
  }>,
  opts: ClassifyOptions,
): IssueVerdict[] {
  const claimableSet = new Set(CLAIMABLE_LABELS);
  const blockingSet = new Set(BLOCKING_LABELS);
  const openPRs = opts.openPRs ?? [];
  const mergedPRs = opts.mergedPRs ?? [];
  const runLocalHolds = opts.runLocalHolds ?? new Set<number>();
  const openIssueNumbers = opts.openIssueNumbers ?? new Set<number>();
  const repo = opts.repo ?? "";

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
    // GRQ#4419: a merged fleet PR naming this issue is a *permanent* skip
    // (Issue #3151), so counting it as claimable made the audit disagree with
    // a scan that was right on every tick, for ever. Applied last for the
    // same reason as `pr_blocked` — a more fundamental exclusion wins.
    if (mergedPRs.length > 0 && isMergedPrBlocked(issue, mergedPRs)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "merged_pr_blocked",
        milestone: issue.milestone,
      });
      continue;
    }
    // Issue #857: the scan's eighth gate, absent here until now — the audit
    // counted dependency-blocked issues as claimable and disagreed with a
    // scan that was right, on every tick. Applied in the scan's own order,
    // so an issue refused for a more fundamental reason keeps that reason.
    if (
      openIssueNumbers.size > 0 && repo !== "" &&
      isDependencyBlockedByOpenIssue(issue.body, repo, openIssueNumbers)
    ) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "dependency_blocked",
        milestone: issue.milestone,
      });
      continue;
    }
    // Issue #655: last of the gates, mirroring the scan — `isIssueInCooldown`
    // runs on the candidates every collector has already passed, so an issue
    // refused for a more fundamental reason keeps that reason and
    // `run_local_hold` marks only work this run is itself withholding.
    if (runLocalHolds.has(issue.number)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "run_local_hold",
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
  // GRQ#4419: a permanent strand outranks even `pr_blocked` — an open PR
  // clears itself when it merges, a merged one never does without a human
  // re-labelling the issue, so it is the more actionable answer.
  if (seen.has("merged_pr_blocked")) return "merged_pr_blocked";
  if (seen.has("pr_blocked")) return "pr_blocked";
  // Issue #655: below the two PR gates, above everything applied before it.
  // Both PR gates describe fleet state that outlives this process and may
  // need a human; a run-local hold clears itself when the run ends or the
  // cooldown expires, so it is the less urgent answer of the three — but it
  // is only ever set on an issue nothing else refused, which makes it more
  // specific than stream occupancy and the filters above that.
  if (seen.has("run_local_hold")) return "run_local_hold";
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
  /**
   * Whether a host-level gate stopped the claim scan this cycle (Issue
   * #479) — the disk floor (#226) or a work-volume fault (#229).
   *
   * When true the `mis_classification` ALERT is suppressed: the alert exists
   * to catch the audit disagreeing with a scan that *ran* (#2106), and while
   * a gate is active the disagreement is guaranteed and carries no
   * information. On GRQ-23 the alert count tracked the gate one-for-one for
   * three days, and that noise is what taught operators to read it as a
   * known false positive while the real condition hid behind it.
   *
   * The per-repo lines and the claimable total are unaffected: they are the
   * evidence that work was waiting. Omitted → historical behaviour.
   */
  claimGateActive?: boolean;
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
  /**
   * Supplies a repo's closed/merged fleet PRs so the audit can exclude work
   * the Priority 2 scan refuses permanently as `merged-pr-permanent`
   * (GRQ#4419).
   *
   * Production wires this to the iteration-scoped `prs_closed_*` cache the
   * scan already populates, so the gate costs no extra API call. Omit it —
   * or let it reject — and the audit falls back to no merged-PR blocking,
   * exactly as before this option existed.
   */
  mergedPRsFn?: (repo: string) => Promise<readonly ClosedPR[]>;
  /**
   * True when this run is holding `issueNumber` in `repo` back regardless of
   * what GitHub says (Issue #655) — the same `isIssueInCooldown` predicate
   * the claim scan filters its candidates against.
   *
   * Production wires this to the one hold set the scan and the census also
   * read, so all three instruments agree. The predicate is called per issue
   * and must be cheap; a throw is caught and falls back to no hold, exactly
   * as the PR fetches do — omitting the gate restores the old over-count
   * rather than silently reporting a repo as having nothing to do.
   */
  runLocalHoldFn?: (repo: string, issueNumber: number) => boolean;
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
        // Issue #857: `body` carries the dependency references the scan's
        // eighth gate reads. One extra field on a call already being made —
        // no extra request, matching how the census gets it free.
        "number,labels,assignees,milestone,body",
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

    // GRQ#4419: read the repo's merged fleet PRs so a permanently stranded
    // issue is not counted as claimable. Best-effort by the same rule as the
    // open-PR fetch above — a failure restores the old over-count rather than
    // silently reporting a repo as having nothing to do.
    let mergedPRs: readonly ClosedPR[] = [];
    if (opts.mergedPRsFn) {
      try {
        mergedPRs = await opts.mergedPRsFn(repo);
      } catch {
        mergedPRs = [];
      }
    }

    // Issue #655: resolve this run's own holds for the repo, so work the
    // claim scan is silently and correctly refusing is not counted as
    // claimable for the life of the process. Best-effort by the same rule as
    // the two fetches above.
    let runLocalHolds = new Set<number>();
    if (opts.runLocalHoldFn) {
      try {
        runLocalHolds = new Set(
          issues
            .filter((i) => opts.runLocalHoldFn!(repo, i.number))
            .map((i) => i.number),
        );
      } catch {
        runLocalHolds = new Set<number>();
      }
    }

    // Issue #857: the repo's own open issues, resolved from the response
    // already in hand. Capped by `perRepoLimit` like everything else here, so
    // a dependency beyond the cap reads as closed — an under-count, the same
    // fail-safe direction every other gate takes.
    const openIssueNumbers = new Set(issues.map((i) => i.number));

    const verdicts = classifyIssues(issues, {
      workerUser: opts.workerUser,
      openPRs,
      mergedPRs,
      runLocalHolds,
      repo,
      openIssueNumbers,
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
  // Issue #479: a gated cycle never ran the scan, so a disagreement with it
  // is not evidence of anything.
  const misClassification = !opts.scanFoundClaimable && claimableTotal > 0 &&
    opts.claimGateActive !== true;

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
