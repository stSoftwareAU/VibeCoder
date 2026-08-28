/**
 * Idle-decision claimable-work census (Issue #2811).
 *
 * Diagnostic observability for the idle-vs-work-on inversion: at every
 * idle-task decision point (about to **file** an idle-task, or about to
 * **select/claim** an idle-task candidate) the worker logs a per-repo
 * "claimable-work census" so an operator can pin, from the log alone, the
 * exact reason unblocked `work-on` issues are being skipped while
 * idle-task scans run elsewhere.
 *
 * Background — the lead hypothesis (a `degraded-model` / `lang:rust`
 * filter) is almost certainly wrong: no filter excludes those labels from
 * the claimable backlog, the busy check, or selection. The real cause
 * lies in repo scanning/availability, the `nice`-tier ordering (#2771),
 * fair-rotation, or cross-worker cooldown — and the logs currently cannot
 * show which. This census makes it observable.
 *
 * # What the census records, per monitored repo
 *
 *   - availability verdict (`available` / `busy` / `empty`) computed from
 *     the per-iteration issue cache via {@link checkRepoAvailability},
 *   - resolved `nice` tier (Unix-`nice` semantics — lower is worked
 *     sooner, #2771),
 *   - counts of **open, unblocked** `top-priority` / `work-on` /
 *     `low-priority` / `idle-task` issues,
 *   - whether the repo was scanned this cycle, and if skipped, the
 *     reason.
 *
 * # Inversion signal
 *
 * Any monitored repo holding ≥1 unblocked `top-priority` / `work-on` /
 * `low-priority` issue **at the moment an idle-task is about to be filed
 * or selected** is the inversion symptom. `inversionSignal` is set on
 * that repo's entry, the repos are gathered into `inversionRepos`, and
 * {@link formatIdleDecisionCensus} emits a greppable
 * `[idle-census] ... ALERT inversion ...` line so log scrapers can surface
 * it. `idle-task` is deliberately **not** part of the inversion signal —
 * it is the idle work itself, not priority work being skipped.
 *
 * # "Unblocked" here
 *
 * An issue contributes to a priority's unblocked count when it carries
 * that priority label, carries **no** blocking label
 * ({@link BLOCKING_LABELS} — `failed`, `needs-revision`, `refine-issue`,
 * `planning`, `question`, `needs-human`), has **no assignees**, and is not
 * blocked by an open PR under the same milestone-aware rule the Priority 2
 * scan applies ({@link getBlockingPRForIssue}, Issue #3526 — honouring the
 * `ignore-open-prs` bypass label), and sits in a work stream the worker has
 * not already occupied (Issue #3852). That matches "an issue the scan could
 * hand to a worker right now", mirroring the claimable definition in
 * `idle_detect_diagnostics.ts`. Note that neither `degraded-model` nor
 * `lang:*` is a blocking label, so an issue carrying them still counts —
 * exactly the point the diagnosis must make.
 *
 * Stream occupancy matters for the same reason PR blocking does. The
 * Priority 2 scan refuses an issue whose milestone (or default-branch)
 * stream already hosts a worker-assigned open issue (`isMilestoneOccupied`
 * → the `milestone-occupied` skip), and the audit mirrors that gate as
 * `stream_occupied`. The census did not, so every sibling of an in-flight
 * claim kept counting as claimable: on 2026-08-23 `stSoftwareAU/NEAT-AI`
 * logged `work_on=4 inversion_signal=true` cycle after cycle while the scan
 * logged `milestone-occupied=4` and the audit logged
 * `claimable=0 reason=stream_occupied`. The scan was right; the census
 * filed Issue #3852 against a repo whose work was simply already being
 * done, and suppressed the idle-task filer while it did. Issues excluded
 * solely by occupancy are surfaced per repo as `stream_occupied=<n>`.
 *
 * A **merged** fleet PR that names the issue matters for exactly the same
 * reason (GRQ#4419). Since Issue #3151 that block is *permanent* — the scan
 * skips the issue as `merged-pr-permanent` on every cycle until a trusted
 * author re-applies the pickup label with a date after the merge. The census
 * did not model it, so a single such issue held `inversion_signal=true` for
 * ever: on 2026-08-26 `stSoftwareAU/GRQ` logged `work_on=10 low_priority=1
 * inversion_signal=true` on cycle after cycle because GRQ#4326 — `work-on`
 * since 23 August, unassigned, unlabelled by any blocker — is named by merged
 * PR #4336. The scan was right; the census escalated it under Issue #321 as
 * "the claim scan keeps refusing", which cost a human a `work-on` label and a
 * whole worker run. Issues excluded solely by a merged PR are surfaced per
 * repo as `merged_pr_blocked=<n>`.
 *
 * The re-label escape hatch (`wasLabelReappliedAfterClosedPR`) is
 * deliberately **not** modelled: it needs a per-issue timeline call the
 * census must not pay for. Omitting it makes the census *under*-count, which
 * at worst files an idle-task while work exists — the bounded-harm direction
 * this module already prefers. Only *merged* PRs are counted; a
 * closed-unmerged PR blocks for a cooldown window that clears itself, so
 * counting it would hide genuinely returning work.
 *
 * PR-blocking matters because the inversion verdict suppresses the
 * idle-task filer (Issue #2813): counting PR-blocked issues as available
 * starved the filer for hours in the host-23 incident (one open PR in one
 * repo parked the whole fleet). Issues excluded solely by PR blocking are
 * surfaced per repo as `pr_blocked=<n>` so the deferral stays observable.
 * The `idle-task` count deliberately ignores PR blocking — idle-task
 * claiming is gated by repo busyness, not by `getBlockingPRForIssue`.
 *
 * # Escalation needs a scan that actually refused the work (Issue #437)
 *
 * The inversion signal answers "is there claimable work while an idle-task
 * is about to be filed?". Issue #321 then escalates a *sustained* signal as
 * "the claim scan keeps refusing this work" — which is only true when the
 * claim scan reached the end of its eligibility pass and came up empty. It
 * frequently does not: the pool stops before its next claim when the cycle
 * deadline / claim-runway floor is reached, on shutdown, or while draining,
 * and the census then runs at the filing gate having never been contradicted
 * by anything. On 2026-08-26 every VibeCoder inversion alert followed a
 * `stop reason=deadline` (or `drain`) line by about a minute — the backlog
 * was real, the scan simply never looked at it — and three such cycles filed
 * VibeCoder#437 against a human under a headline that named a bug nobody had.
 *
 * So the census separates the two verdicts:
 *
 *   - {@link IdleDecisionCensus.inversionRepos} / `inversionDetected` — work
 *     exists somewhere in the monitored set. Unchanged, and still what
 *     suppresses the idle-task filer (Issue #2813): work the scan merely did
 *     not reach this cycle is still work, and filing an idle-task beside it
 *     inverts priority just the same.
 *   - {@link IdleDecisionCensus.escalationRepos} — the subset the claim scan
 *     actually evaluated this cycle (`scannedThisCycle`). Only these are
 *     evidence of a refusal, so only these feed the Issue #321 streak.
 *
 * Inverted repos the scan never reached are reported as
 * {@link IdleDecisionCensus.deferredInversionRepos} and surfaced by
 * {@link formatIdleDecisionCensus} as a `NOTE inversion_not_escalated` line,
 * so a deferral stays visible in the log instead of being silently dropped.
 *
 * The builder is **pure** — it takes already-fetched issues (read through
 * the existing per-iteration `IssueCache` so a quiet cycle costs no extra
 * `gh issue list` call) and returns a structured census. The caller wraps
 * it in try/catch and never aborts the loop, mirroring the existing
 * `Idle-task filer failed (continuing): <msg>` pattern.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { LABEL_DEFAULTS } from "./config_defaults.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import { BLOCKING_LABELS } from "./idle_detect_diagnostics.ts";
import { extractDependencyReferencesDetailed } from "./issue_dependencies.ts";
import type { SkipReason } from "./issue_finder_logger.ts";
import {
  type ClosedPR,
  getBlockingPRForIssue,
  isBlockedByRecentlyClosedPR,
  type OpenPR,
} from "./issue_query.ts";
import {
  checkRepoAvailability,
  type RepoIssueInfo,
} from "./repo_availability.ts";

// ---------------------------------------------------------------------------
// Public data shape
// ---------------------------------------------------------------------------

/**
 * How the census treats one of the claim scan's skip reasons (Issue #460).
 *
 * - `modelled` — the census applies the same gate, so the two agree.
 * - `upstream` — the issue is already excluded before the gate is reached
 *   (label / assignee / repo-level filtering the census applies first), so
 *   modelling it separately would change nothing.
 * - `run-local` — the gate depends on this worker's run state (cooldowns,
 *   in-flight holds) rather than anything readable from GitHub. The census
 *   deliberately omits it and thereby *over*-counts, which is why an
 *   escalation must never rest on a single cycle.
 * - `escalated-elsewhere` — the scan already raises this to a human on the
 *   issue itself, so the census has nothing to add.
 * - `unclassified` — nobody has decided. Always a bug; the guard test fails.
 */
export type CensusGateCoverage =
  | "modelled"
  | "upstream"
  | "run-local"
  | "escalated-elsewhere"
  | "unclassified";

/**
 * Every gate the claim scan applies, and what the census does about it.
 *
 * This map is **total** over the scan's `SkipReason` union, so a new skip
 * reason in any `collect_*_candidates.ts` fails the type check here until
 * somebody classifies it. Issues #3526, #3852 and GRQ#4419 were each a gate
 * added to the scan and forgotten here, and each one manufactured an
 * inversion alert against a scan that was right.
 */
export const CENSUS_SCAN_GATE_COVERAGE: Record<SkipReason, CensusGateCoverage> =
  {
    // Repo-level: the census reads only monitored repos and reports
    // `monitored` / `nice` separately.
    "repo-not-allowed": "upstream",
    "repo-deprioritised": "upstream",
    "repo-busy": "upstream",
    "fetch-error": "upstream",
    // Label and assignee filtering, applied by `isUnblockedFor` before any
    // gate below is reached.
    "assigned": "upstream",
    "blocking-label": "upstream",
    "label-author-not-allowed": "upstream",
    "untrusted-operational-label": "upstream",
    "non-wrapper-title": "upstream",
    "filtered-out": "upstream",
    "needs-human": "upstream",
    // Modelled gates — the ones that have bitten.
    "milestone-occupied": "modelled",
    "pr-blocked": "modelled",
    "merged-pr-permanent": "modelled",
    "dependency-blocked": "modelled",
    // Run-local: cooldowns and holds live in this worker's state, not in
    // anything the census reads. Omitting them over-counts.
    "closed-pr-cooldown": "run-local",
    "cooldown": "run-local",
    "cross-worker-cooldown": "run-local",
    "content-modified-after-approval": "run-local",
    "content-check-error": "run-local",
    "content-editor-unresolved": "run-local",
    "content-store-unconfigured": "run-local",
    "content-snapshot-persist-failed": "run-local",
    "no-approval-snapshot": "run-local",
    // The scan already puts these in front of a human on the issue itself.
    "dependency-cycle-escalated": "escalated-elsewhere",
    "dead-label-tracker-escalated": "escalated-elsewhere",
    "human-pr-blocked-escalated": "escalated-elsewhere",
  };

/** Which idle-task decision point the census was taken at. */
export type DecisionPoint = "filing" | "selection";

/**
 * Why a repo was not fully scanned/claimable this cycle. `scanned` is the
 * non-skip sentinel; the rest mirror the documented skip paths in the
 * issue body. `unknown` covers a skip the caller could not attribute.
 */
export type RepoCensusSkipReason =
  | "scanned"
  | "not_monitored"
  | "busy"
  | "stream_occupied"
  | "dependency_blocked"
  | "cooldown_local"
  | "cooldown_cross_worker"
  | "fair_rotation_deferral"
  /**
   * The claim scan stopped for a lifecycle reason — the cycle deadline or
   * claim-runway floor, a shutdown request, or a pool drain — before it
   * completed an eligibility pass (Issue #437). The backlog was never
   * evaluated, so nothing refused it.
   */
  | "cycle_deadline"
  | "unknown";

/** Availability verdict for a repo, derived from its open issues. */
export type AvailabilityVerdict = "available" | "busy" | "empty";

/** Minimal issue shape the census reads (from the per-iteration cache). */
export interface CensusIssue {
  number: number;
  labels: string[];
  assignees: string[];
  /** Milestone title, or "" for the default-branch (non-milestone) stream. */
  milestone: string;
  /**
   * Issue body, so the census can model the scan's dependency gate
   * (Issue #460). `fetchAllIssues` already requests `body`, so supplying it
   * costs no extra call. Omitted → no dependency blocking is applied,
   * preserving the pre-#460 behaviour exactly as `openPRs` does.
   */
  body?: string;
}

/** Per-repo input to {@link buildIdleDecisionCensus}. */
export interface RepoCensusInput {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** Whether the repo is in the operator monitored list. */
  monitored: boolean;
  /** Whether the Priority 2 scan reached this repo this cycle. */
  scannedThisCycle: boolean;
  /** Resolved `nice` tier (#2771). Lower is worked sooner. */
  nice: number;
  /** Skip reason when `scannedThisCycle === false`. Defaults to `scanned`. */
  skipReason?: RepoCensusSkipReason;
  /** Open issues for the repo, read through the per-iteration cache. */
  issues: CensusIssue[];
  /**
   * Open PRs for the repo, read through the per-iteration cache
   * (Issue #3526). When supplied, issues the Priority 2 scan would refuse
   * under {@link getBlockingPRForIssue} are excluded from the unblocked
   * counts. Omitted (e.g. the PR fetch failed) → no PR blocking is
   * applied, preserving the pre-#3526 behaviour.
   */
  openPRs?: OpenPR[];
  /**
   * Closed/merged fleet PRs for the repo, read through the per-iteration
   * cache (GRQ#4419). Only entries with `merged: true` are honoured — they
   * are the ones the scan refuses *permanently* under `merged-pr-permanent`.
   * Omitted (e.g. the fetch failed) → no merged-PR blocking is applied,
   * preserving the pre-GRQ#4419 behaviour.
   */
  mergedPRs?: ClosedPR[];
}

/** Per-priority unblocked counts for a repo. */
export interface UnblockedCounts {
  topPriority: number;
  workOn: number;
  lowPriority: number;
  idleTask: number;
}

/** Census verdict for a single repo. */
export interface RepoCensusEntry {
  repo: string;
  monitored: boolean;
  scannedThisCycle: boolean;
  nice: number;
  skipReason: RepoCensusSkipReason;
  availability: AvailabilityVerdict;
  availableStreams: string[];
  occupiedStreams: string[];
  unblocked: UnblockedCounts;
  /**
   * Count of priority (`top-priority` / `work-on` / `low-priority`) issues
   * that passed the label/assignee checks but were excluded solely because
   * an open PR blocks them under the scan's milestone-aware rule
   * (Issue #3526). Kept separate from `unblocked` so the deferral stays
   * observable in the `[idle-census]` line.
   */
  prBlocked: number;
  /**
   * Count of priority (`top-priority` / `work-on` / `low-priority`) issues
   * that passed the label/assignee checks but were excluded solely because
   * their work stream already hosts a worker-assigned open issue — the
   * scan's `milestone-occupied` skip (Issue #3852). Kept separate from
   * `unblocked` so the deferral stays observable in the `[idle-census]`
   * line.
   */
  streamOccupied: number;
  /**
   * Count of priority (`top-priority` / `work-on` / `low-priority`) issues
   * that passed every other check but are named by a **merged** fleet PR,
   * which the scan refuses permanently as `merged-pr-permanent`
   * (Issue #3151, GRQ#4419). Kept separate from `unblocked` so the
   * permanent strand stays observable in the `[idle-census]` line rather
   * than being silently dropped.
   */
  mergedPrBlocked: number;
  /**
   * Count of priority (`top-priority` / `work-on` / `low-priority`) issues
   * that passed every other check but name an open dependency, which the
   * scan refuses as `dependency-blocked` (Issue #460, GRQ#4465). Kept
   * separate from `unblocked` so the deferral stays observable in the
   * `[idle-census]` line.
   */
  dependencyBlocked: number;
  /**
   * The issue numbers behind {@link RepoCensusEntry.unblocked}'s priority
   * counts, in issue order (Issue #460). The escalation body names them, so
   * a reader can see *which* issues the census and the scan disagree about
   * instead of being handed a bare count as GRQ#4465 was.
   */
  claimableIssues: number[];
  /**
   * `true` when the repo holds ≥1 unblocked `top-priority` / `work-on` /
   * `low-priority` issue — the idle-vs-work-on inversion symptom.
   * `idle-task` is excluded by design.
   */
  inversionSignal: boolean;
}

/** Output of {@link buildIdleDecisionCensus}. */
export interface IdleDecisionCensus {
  /** Decision point the census was taken at. */
  decisionPoint: DecisionPoint;
  /** GitHub username the availability check resolved assignments against. */
  workerUser: string;
  /** One entry per input repo, in input order. */
  perRepo: RepoCensusEntry[];
  /** Monitored repos whose `inversionSignal` is set, in input order. */
  inversionRepos: string[];
  /** `true` when at least one monitored repo carries the inversion signal. */
  inversionDetected: boolean;
  /**
   * The subset of {@link inversionRepos} the claim scan actually evaluated
   * this cycle (`scannedThisCycle`), in input order — the only repos whose
   * signal is evidence that the scan *refused* the work (Issue #437). The
   * Issue #321 streak counts these and no others.
   */
  escalationRepos: string[];
  /**
   * The rest of {@link inversionRepos}: repos holding claimable work that
   * the claim scan never reached this cycle (Issue #437). Reported so the
   * deferral is visible in the log, never escalated.
   */
  deferredInversionRepos: string[];
  /**
   * Inverted repos the claim scan **claimed from** this cycle (Issue #460).
   *
   * The scan served them, so their leftover work was not refused — it was
   * simply not reached before the cycle ended, which two concurrent slots
   * against an 80-issue backlog guarantee on every cycle. GRQ#4465 was filed
   * four minutes after the scan claimed GRQ#4463 from that very repo. These
   * repos keep raising {@link IdleDecisionCensus.inversionRepos} (the filer
   * suppression is still right) but never feed the Issue #321 streak.
   */
  servedInversionRepos: string[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const BLOCKING_SET: ReadonlySet<string> = new Set(BLOCKING_LABELS);

/**
 * Bypass label the collectors honour when an open PR would otherwise block
 * an issue. The census only checks raw label presence — the collectors'
 * trusted-author verification needs timeline lookups the census must not
 * pay for, and under-counting here merely files an idle-task while work
 * exists (bounded harm), whereas over-counting starves the filer.
 */
const IGNORE_OPEN_PRS_LABEL = "ignore-open-prs";

/**
 * True when `issue` carries `label`, has no blocking label, and has no
 * assignees — i.e. the worker could pick it up right now.
 */
function isUnblockedFor(issue: CensusIssue, label: string): boolean {
  if (!issue.labels.includes(label)) return false;
  if (issue.assignees.length > 0) return false;
  if (issue.labels.some((l) => BLOCKING_SET.has(l))) return false;
  return true;
}

/**
 * True when an open PR blocks `issue` under the scan's milestone-aware
 * rule (Issue #3526) and the issue does not carry the bypass label.
 */
function isPrBlocked(issue: CensusIssue, openPRs: OpenPR[]): boolean {
  if (openPRs.length === 0) return false;
  if (issue.labels.includes(IGNORE_OPEN_PRS_LABEL)) return false;
  // Issue #4133: the census reads the repo's PRs through `fetchAllOpenPRs`,
  // which carries no author, so no PR can be classified here — every open
  // PR keeps counting as a blocker (the fail-safe empty-set behaviour of
  // `getBlockingPRForIssue`). The census only counts; it never blocks a
  // pickup, so the residual over-count is observability, not policy.
  return getBlockingPRForIssue(openPRs, issue.milestone, []) !== null;
}

/**
 * True when a **merged** fleet PR names `issue`, which the Priority 2 scan
 * refuses permanently under `merged-pr-permanent` (Issue #3151, GRQ#4419).
 *
 * Closed-unmerged entries are filtered out: their block is cooldown-windowed
 * and self-clearing, so counting them would hide work that is about to return.
 */
function isMergedPrBlocked(issue: CensusIssue, mergedPRs: ClosedPR[]): boolean {
  const merged = mergedPRs.filter((pr) => pr.merged === true);
  return isBlockedByRecentlyClosedPR(merged, issue.number) !== null;
}

/**
 * True when `issue` names a dependency the Priority 2 scan would refuse it
 * for, matching `isDependencyBlocked` in `issue_finder_common.ts`
 * (Issue #460, GRQ#4465).
 *
 * Resolved against the repo's own open-issue set, which the census already
 * holds — so this adds no `gh` call and the census stays pure. Two cases
 * follow the scan rather than the cheap answer:
 *
 * - A **same-repo** `#N` that is not in the open set is closed, so it does
 *   not block — the scan agrees.
 * - A **cross-repo** `owner/repo#N` cannot be resolved from this repo's
 *   issues. `isDependencyBlocked` treats an unresolvable dependency as
 *   blocking (fail safe), so this does too. The residual error is an
 *   under-count, which at worst files an idle-task beside real work — the
 *   bounded-harm direction this module already prefers — rather than
 *   manufacturing an inversion against a scan that was right.
 *
 * Parent/child blocking (`checkParentBlocked`) is deliberately not modelled:
 * it needs a per-issue API call the census must not pay for, and it errs in
 * the same under-counting direction.
 */
function isDependencyBlockedByOpenIssue(
  issue: CensusIssue,
  repo: string,
  openIssueNumbers: ReadonlySet<number>,
): boolean {
  if (issue.body === undefined) return false;
  const refs = extractDependencyReferencesDetailed(issue.body);
  const lowerRepo = repo.trim().toLowerCase();
  return refs.some((ref) => {
    const sameRepo = ref.repo === undefined ||
      ref.repo.trim().toLowerCase() === lowerRepo;
    // Unresolvable (cross-repo) → blocked, as the scan fails safe.
    if (!sameRepo) return true;
    return openIssueNumbers.has(ref.number);
  });
}

/**
 * Work streams the worker already occupies — milestones (or `""` for the
 * default-branch stream) hosting an open issue assigned to `workerUser`.
 *
 * Mirrors {@link classifyIssues}' `stream_occupied` gate in
 * `idle_detect_diagnostics.ts`, which in turn mirrors the scan's
 * `isMilestoneOccupied`. The scan widens the set to the whole fleet
 * (`workerUser ∪ allowedAuthors`); the census keeps the narrower
 * worker-only set the audit uses, so the two instruments cannot disagree
 * and a sibling host's claim never silences this host's inversion signal.
 */
function occupiedStreamsFor(
  issues: CensusIssue[],
  workerUser: string,
): ReadonlySet<string> {
  const lowerUser = workerUser.toLowerCase();
  const occupied = new Set<string>();
  for (const issue of issues) {
    if (issue.assignees.some((a) => a.toLowerCase() === lowerUser)) {
      occupied.add(issue.milestone);
    }
  }
  return occupied;
}

/** Count unblocked issues per priority label for one repo. */
function countUnblocked(
  issues: CensusIssue[],
  openPRs: OpenPR[],
  mergedPRs: ClosedPR[],
  workerUser: string,
  repo: string,
): {
  counts: UnblockedCounts;
  prBlocked: number;
  streamOccupied: number;
  mergedPrBlocked: number;
  dependencyBlocked: number;
  claimableIssues: number[];
} {
  const counts: UnblockedCounts = {
    topPriority: 0,
    workOn: 0,
    lowPriority: 0,
    idleTask: 0,
  };
  const occupiedStreams = occupiedStreamsFor(issues, workerUser);
  // Every issue in this list is open — the census only ever reads open
  // issues — so membership is exactly "the dependency is still open".
  const openIssueNumbers = new Set(issues.map((i) => i.number));
  const claimableIssues: number[] = [];
  let prBlocked = 0;
  let streamOccupied = 0;
  let mergedPrBlocked = 0;
  let dependencyBlocked = 0;
  for (const issue of issues) {
    // Idle-task claiming is gated by repo busyness, not by
    // getBlockingPRForIssue, so its count ignores PR blocking.
    if (isUnblockedFor(issue, IDLE_TASK_LABEL)) {
      counts.idleTask += 1;
    }
    const carriesPriorityLabel =
      isUnblockedFor(issue, LABEL_DEFAULTS.topPriorityLabel) ||
      isUnblockedFor(issue, LABEL_DEFAULTS.workOnLabel) ||
      isUnblockedFor(issue, LABEL_DEFAULTS.lowPriorityLabel);
    if (!carriesPriorityLabel) continue;
    // Attributed ahead of PR blocking, matching `classifyIssues`: an issue
    // the scan already refuses for occupancy keeps that reason, so
    // `pr_blocked` marks only issues that would otherwise be claimable now.
    if (occupiedStreams.has(issue.milestone)) {
      streamOccupied += 1;
      continue;
    }
    if (isPrBlocked(issue, openPRs)) {
      prBlocked += 1;
      continue;
    }
    // GRQ#4419: applied last, so an issue refused for a more fundamental
    // reason keeps that reason — `merged_pr_blocked` marks only issues that
    // would otherwise be claimable right now but are stranded permanently.
    if (isMergedPrBlocked(issue, mergedPRs)) {
      mergedPrBlocked += 1;
      continue;
    }
    // Issue #460: applied last, mirroring the scan's own order — an issue
    // refused for a more fundamental reason keeps that reason, so
    // `dependency_blocked` marks only issues that would otherwise be
    // claimable right now.
    if (isDependencyBlockedByOpenIssue(issue, repo, openIssueNumbers)) {
      dependencyBlocked += 1;
      continue;
    }
    claimableIssues.push(issue.number);
    if (isUnblockedFor(issue, LABEL_DEFAULTS.topPriorityLabel)) {
      counts.topPriority += 1;
    }
    if (isUnblockedFor(issue, LABEL_DEFAULTS.workOnLabel)) {
      counts.workOn += 1;
    }
    if (isUnblockedFor(issue, LABEL_DEFAULTS.lowPriorityLabel)) {
      counts.lowPriority += 1;
    }
  }
  return {
    counts,
    prBlocked,
    streamOccupied,
    mergedPrBlocked,
    dependencyBlocked,
    claimableIssues,
  };
}

/** Derive the availability verdict from a repo's open issues. */
function availabilityFor(
  issues: CensusIssue[],
  workerUser: string,
): {
  verdict: AvailabilityVerdict;
  availableStreams: string[];
  occupiedStreams: string[];
} {
  const infos: RepoIssueInfo[] = issues.map((i) => ({
    number: i.number,
    milestone: i.milestone,
    assignees: i.assignees,
  }));
  const result = checkRepoAvailability(infos, workerUser);
  const verdict: AvailabilityVerdict = result.totalStreams === 0
    ? "empty"
    : result.hasAvailableWork
    ? "available"
    : "busy";
  return {
    verdict,
    availableStreams: result.availableStreams,
    occupiedStreams: result.occupiedStreams,
  };
}

/**
 * Build the per-repo idle-decision census. Pure — no I/O. The caller is
 * responsible for supplying issues read through the per-iteration cache
 * and for wrapping this in try/catch so a throw never aborts the loop.
 */
export function buildIdleDecisionCensus(opts: {
  decisionPoint: DecisionPoint;
  workerUser: string;
  repos: RepoCensusInput[];
  /**
   * Repos the Priority 2 scan claimed an issue from this cycle (Issue #460).
   * Omitted → no repo is treated as served, preserving the pre-#460
   * behaviour.
   */
  claimedRepos?: readonly string[];
}): IdleDecisionCensus {
  const perRepo: RepoCensusEntry[] = [];
  for (const input of opts.repos) {
    const {
      counts: unblocked,
      prBlocked,
      streamOccupied,
      mergedPrBlocked,
      dependencyBlocked,
      claimableIssues,
    } = countUnblocked(
      input.issues,
      input.openPRs ?? [],
      input.mergedPRs ?? [],
      opts.workerUser,
      input.repo,
    );
    const { verdict, availableStreams, occupiedStreams } = availabilityFor(
      input.issues,
      opts.workerUser,
    );
    const inversionSignal = unblocked.topPriority + unblocked.workOn +
        unblocked.lowPriority > 0;
    perRepo.push({
      repo: input.repo,
      monitored: input.monitored,
      scannedThisCycle: input.scannedThisCycle,
      nice: input.nice,
      skipReason: input.skipReason ??
        (input.scannedThisCycle ? "scanned" : "unknown"),
      availability: verdict,
      availableStreams,
      occupiedStreams,
      unblocked,
      prBlocked,
      streamOccupied,
      mergedPrBlocked,
      dependencyBlocked,
      claimableIssues,
      inversionSignal,
    });
  }

  // The inversion signal only matters for repos the worker is supposed to
  // be serving. A non-monitored repo with work is expected to be skipped.
  const inverted = perRepo.filter((r) => r.monitored && r.inversionSignal);
  const inversionRepos = inverted.map((r) => r.repo);
  // Issue #437: only a repo the claim scan actually evaluated this cycle can
  // be said to have had its work *refused*. A repo the scan never reached —
  // the cycle deadline, a shutdown, a drain — is deferred, not refused.
  //
  // Issue #460: a repo the scan *claimed from* is likewise not one it
  // refused. Two concurrent slots working an 80-issue backlog leave
  // claimable work on every cycle by construction, so without this the
  // escalation is guaranteed to fire against any busy repo.
  const served = new Set(opts.claimedRepos ?? []);
  const escalationRepos = inverted
    .filter((r) => r.scannedThisCycle && !served.has(r.repo))
    .map((r) => r.repo);
  const deferredInversionRepos = inverted
    .filter((r) => !r.scannedThisCycle)
    .map((r) => r.repo);
  const servedInversionRepos = inverted
    .filter((r) => r.scannedThisCycle && served.has(r.repo))
    .map((r) => r.repo);

  return {
    decisionPoint: opts.decisionPoint,
    workerUser: opts.workerUser,
    perRepo,
    inversionRepos,
    inversionDetected: inversionRepos.length > 0,
    escalationRepos,
    deferredInversionRepos,
    servedInversionRepos,
  };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Render the census as greppable `[idle-census]` log lines: a header, one
 * line per repo, and — when the inversion signal fired — a single
 * `ALERT inversion` line listing the offending repos. Returned as an
 * array so the caller can route every line through the shared worker
 * Logger.
 *
 * @param census - The census to render.
 * @param host - Optional `hostname:pid` tag so multi-host idle
 *   declarations are distinguishable in aggregated logs.
 */
export function formatIdleDecisionCensus(
  census: IdleDecisionCensus,
  host?: string,
): string[] {
  const hostField = host !== undefined && host.length > 0
    ? ` host=${host}`
    : "";
  const lines: string[] = [];
  lines.push(
    `[idle-census]${hostField} decision_point=${census.decisionPoint} ` +
      `repos=${census.perRepo.length} inversion=${census.inversionDetected}`,
  );
  for (const r of census.perRepo) {
    lines.push(
      `[idle-census]${hostField} decision_point=${census.decisionPoint} ` +
        `repo=${r.repo} monitored=${r.monitored} scanned=${r.scannedThisCycle} ` +
        `skip_reason=${r.skipReason} availability=${r.availability} ` +
        `nice=${r.nice} top_priority=${r.unblocked.topPriority} ` +
        `work_on=${r.unblocked.workOn} low_priority=${r.unblocked.lowPriority} ` +
        `idle_task=${r.unblocked.idleTask} pr_blocked=${r.prBlocked} ` +
        `stream_occupied=${r.streamOccupied} ` +
        `merged_pr_blocked=${r.mergedPrBlocked} ` +
        `dependency_blocked=${r.dependencyBlocked} ` +
        `inversion_signal=${r.inversionSignal}`,
    );
  }
  if (census.inversionDetected) {
    lines.push(
      `[idle-census]${hostField} decision_point=${census.decisionPoint} ` +
        `ALERT inversion repos=${census.inversionRepos.join(",")}`,
    );
  }
  // Issue #437: a repo the claim scan never reached this cycle holds work
  // nobody refused, so it is reported and not escalated.
  if (census.deferredInversionRepos.length > 0) {
    lines.push(
      `[idle-census]${hostField} decision_point=${census.decisionPoint} ` +
        `NOTE inversion_not_escalated ` +
        `repos=${census.deferredInversionRepos.join(",")} — the claim scan ` +
        `did not complete an eligibility pass this cycle, so nothing ` +
        `refused this work`,
    );
  }
  // Issue #460: the scan claimed from this repo this cycle, so its leftover
  // work was served rather than refused. Reported, never escalated.
  if (census.servedInversionRepos.length > 0) {
    lines.push(
      `[idle-census]${hostField} decision_point=${census.decisionPoint} ` +
        `NOTE inversion_not_escalated_served ` +
        `repos=${census.servedInversionRepos.join(",")} — the claim scan ` +
        `claimed work from these repos this cycle, so nothing refused the ` +
        `remainder`,
    );
  }
  return lines;
}
