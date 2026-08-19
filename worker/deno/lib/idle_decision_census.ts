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
 * `ignore-open-prs` bypass label). That matches "an issue the scan could
 * hand to a worker right now", mirroring the claimable definition in
 * `idle_detect_diagnostics.ts`. Note that neither `degraded-model` nor
 * `lang:*` is a blocking label, so an issue carrying them still counts —
 * exactly the point the diagnosis must make.
 *
 * PR-blocking matters because the inversion verdict suppresses the
 * idle-task filer (Issue #2813): counting PR-blocked issues as available
 * starved the filer for hours in the host-23 incident (one open PR in one
 * repo parked the whole fleet). Issues excluded solely by PR blocking are
 * surfaced per repo as `pr_blocked=<n>` so the deferral stays observable.
 * The `idle-task` count deliberately ignores PR blocking — idle-task
 * claiming is gated by repo busyness, not by `getBlockingPRForIssue`.
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
import { getBlockingPRForIssue, type OpenPR } from "./issue_query.ts";
import {
  checkRepoAvailability,
  type RepoIssueInfo,
} from "./repo_availability.ts";

// ---------------------------------------------------------------------------
// Public data shape
// ---------------------------------------------------------------------------

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

/** Count unblocked issues per priority label for one repo. */
function countUnblocked(
  issues: CensusIssue[],
  openPRs: OpenPR[],
): { counts: UnblockedCounts; prBlocked: number } {
  const counts: UnblockedCounts = {
    topPriority: 0,
    workOn: 0,
    lowPriority: 0,
    idleTask: 0,
  };
  let prBlocked = 0;
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
    if (isPrBlocked(issue, openPRs)) {
      prBlocked += 1;
      continue;
    }
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
  return { counts, prBlocked };
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
}): IdleDecisionCensus {
  const perRepo: RepoCensusEntry[] = [];
  for (const input of opts.repos) {
    const { counts: unblocked, prBlocked } = countUnblocked(
      input.issues,
      input.openPRs ?? [],
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
      inversionSignal,
    });
  }

  // The inversion signal only matters for repos the worker is supposed to
  // be serving. A non-monitored repo with work is expected to be skipped.
  const inversionRepos = perRepo
    .filter((r) => r.monitored && r.inversionSignal)
    .map((r) => r.repo);

  return {
    decisionPoint: opts.decisionPoint,
    workerUser: opts.workerUser,
    perRepo,
    inversionRepos,
    inversionDetected: inversionRepos.length > 0,
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
        `inversion_signal=${r.inversionSignal}`,
    );
  }
  if (census.inversionDetected) {
    lines.push(
      `[idle-census]${hostField} decision_point=${census.decisionPoint} ` +
        `ALERT inversion repos=${census.inversionRepos.join(",")}`,
    );
  }
  return lines;
}
