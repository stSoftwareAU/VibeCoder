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
 *   3a. Its priority label was added by a trusted author (Issue #4212).
 *      Issues named by `untrustedLabelIssues` are excluded as
 *      `label_author_not_allowed`, matching the claim scan's
 *      `label-author-not-allowed` skip. Absent, the gate is skipped.
 *   3b. Is not a milestone-tracking issue — `filterAndSort` drops those
 *      in the same pass (Issue #1134, gate added by Issue #1050).
 *   4. Its work stream — the milestone title, or `""` for default
 *      branch — is not already occupied. The verdict comes from the
 *      scan's own `isMilestoneOccupied`, over the scan's own account
 *      set: `workerUser` plus the caller's `pushCapableAuthors` (Issues
 *      #1050, #1064). Supply that set, or a stream a sibling worker
 *      holds reads as free here and as `milestone-occupied` to the
 *      scan — the divergence behind the ten-day fleet-wide idle-task
 *      drought of 2026-08-26, when one assignment in the
 *      default-branch stream made a 24-issue backlog unclaimable while
 *      the audit went on counting all 24.
 *   5. No open PR blocks its work stream under the scan's own
 *      milestone-aware rule (`getBlockingPRForIssue`), unless the issue
 *      carries `ignore-open-prs` (Issue #4223). Requires the caller to
 *      supply PRs via `openPRsFn`; without them this gate is skipped.
 *   6. This run is not holding the issue back (Issue #655) — the
 *      `isIssueInCooldown` predicate `find_oldest_issue.ts` filters every
 *      tier's candidates against, covering the persisted retry cooldown and
 *      the per-run processed-issue registry. The predicate is also handed
 *      the issue's milestone title so a paced milestone can be held (Issue
 *      #3587). Requires the caller to supply `runLocalHoldFn`; without it
 *      this gate is skipped.
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
 */ import { runGhCommand } from "./github.ts";
import { getBlockingPRForIssue, hasOpenSubIssues, isBlockedByRecentlyClosedPR, parseSubIssuesSummary } from "./issue_query.ts";
import { DEFAULT_STREAM_SHARING_TIERS, isMilestoneOccupied, isMilestoneTrackingIssue, isStreamSharingTier } from "./issue_filter.ts";
import { LABEL_DEFAULTS } from "./config_defaults.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
// Issue #4037: the audit's per-repo probe also feeds the access store.
import { recordRepoProbeBestEffort } from "./monitored_repo_access.ts";
import { extractDependencyReferencesDetailed } from "./issue_dependencies.ts";
import { isTimeDeferred } from "./time_deferral.ts";
// ---------------------------------------------------------------------------
// Label sets
// ---------------------------------------------------------------------------
/**
 * Labels that mark an issue as "approved work the scan loop can claim".
 * Mirrors `APPROVED_WORK_LABELS` in `repo_busy_for_idle_task.ts` so the
 * two checks stay in lockstep — the busy gate skips repos with any of
 * these, the audit counts them.
 */ export const CLAIMABLE_LABELS = [
  LABEL_DEFAULTS.topPriorityLabel,
  LABEL_DEFAULTS.workOnLabel,
  LABEL_DEFAULTS.lowPriorityLabel,
  IDLE_TASK_LABEL
];
/**
 * Discovery labels the week-pace guard leaves in the ladder (Issues #1885,
 * #1915).
 *
 * `selectHighestPriority` drops tiers 3 and 4 while the guard is engaged, so
 * an issue carrying one of these is still claimable and everything else in
 * {@link CLAIMABLE_LABELS} is not. Expressed as the exemption rather than the
 * suppression so a discovery label added to the ladder above tier 3 has to be
 * named here deliberately, and an unrecognised one fails safe by
 * under-counting claimable work — the direction this module always prefers.
 */ const PACE_EXEMPT_LABELS = [
  LABEL_DEFAULTS.topPriorityLabel,
  LABEL_DEFAULTS.workOnLabel
];
/**
 * Labels that exclude an issue from the discovery scan regardless of
 * its discovery label. Matches the blocking set in
 * `issue_filter.ts::filterAndSort`.
 */ export const BLOCKING_LABELS = [
  LABEL_DEFAULTS.needsRevisionLabel,
  LABEL_DEFAULTS.refineIssueLabel,
  LABEL_DEFAULTS.planningLabel,
  LABEL_DEFAULTS.questionLabel,
  LABEL_DEFAULTS.needsHumanLabel
];
export function normaliseIssue(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw;
  if (typeof v.number !== "number" || !Number.isFinite(v.number)) return null;
  const title = typeof v.title === "string" ? v.title : "";
  // Two shapes arrive here: raw `gh issue list --json` objects (`labels:
  // [{name}]`, `assignees: [{login}]`, `milestone: {title}`) and the
  // already-flattened `FilterableIssue` the shared `issues_all` cache holds
  // (`labels: string[]`, `assignees: string[]`, `milestone: string`).
  const labels = Array.isArray(v.labels) ? v.labels.map((l)=>typeof l === "string" ? l : typeof l?.name === "string" ? l.name : null).filter((s)=>s !== null) : [];
  const assignees = Array.isArray(v.assignees) ? v.assignees.map((a)=>typeof a === "string" ? a : typeof a?.login === "string" ? a.login : null).filter((s)=>s !== null) : [];
  const rawMilestone = v.milestone;
  const milestone = typeof rawMilestone === "string" ? rawMilestone : typeof rawMilestone?.title === "string" ? rawMilestone.title : "";
  const body = typeof v.body === "string" ? v.body : undefined;
  // Issue #3314: native sub-issue counts, kept only when valid.
  const subIssuesSummary = parseSubIssuesSummary(v.subIssuesSummary);
  return {
    number: v.number,
    title,
    labels,
    assignees,
    milestone,
    ...body === undefined ? {} : {
      body
    },
    ...subIssuesSummary === undefined ? {} : {
      subIssuesSummary
    }
  };
}
// ---------------------------------------------------------------------------
// Pure classifier (extracted so unit tests can exercise it without gh)
// ---------------------------------------------------------------------------
/**
 * Bypass label: the operator has declared that open PRs must not hold this
 * issue back. Mirrors the census (Issue #3526) — raw label presence only, no
 * timeline lookup, because the audit must stay a cheap probe.
 */ const IGNORE_OPEN_PRS_LABEL = "ignore-open-prs";
/**
 * True when an open PR blocks `issue` under the same milestone-aware rule the
 * Priority 2 scan applies (Issue #4223).
 *
 * `pushCapableAuthors` is the fleet identity, so a human's open PR never
 * defers an issue (Issue #4133) — the same rule the scan applies. Passing an
 * empty set, or PRs whose author was never stamped (the shared
 * `prs_open_all` cache does not carry one), classifies nothing as human and
 * leaves every open PR blocking: the fail-safe `isHumanAuthoredPr` documents,
 * and what the audit did before Issue #1050 gave callers a set to pass.
 */ function isPrBlocked(issue, openPRs, pushCapableAuthors, fleetPrSlots) {
  if (issue.labels.includes(IGNORE_OPEN_PRS_LABEL)) return false;
  // Issue #2663: the same per-repo slot cap the scan applies to the
  // default-branch stream; `fetchAllOpenPRs` rows carry `authorLogin`, which
  // the gate classifies on, so a human's PR never counts here either.
  return getBlockingPRForIssue([
    ...openPRs
  ], issue.milestone, pushCapableAuthors, fleetPrSlots) !== null;
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
 */ function isMergedPrBlocked(issue, mergedPRs) {
  const merged = mergedPRs.filter((pr)=>pr.merged === true);
  return isBlockedByRecentlyClosedPR(merged, issue.number) !== null;
}
/**
 * True when `issue` names an open dependency the Priority 2 scan refuses it
 * for (Issue #460, GRQ#4465).
 *
 * Mirrors `isDependencyBlockedByOpenIssue` in `idle_decision_census.ts`: a
 * same-repo `#N` absent from the open set is closed and does not block, and a
 * cross-repo reference cannot be resolved from this repo's issues, so it
 * counts as blocking — the scan fails safe the same way. Parent/child
 * blocking's native sub-issue half is handled separately, by
 * `hasOpenSubIssues` on `subIssuesSummary` from the same `gh issue list` call
 * (Issue #3314). Its body task-list half is still not modelled here: it
 * would need a per-issue API call, and omitting it under-counts, which merely
 * alerts on work that will not be claimed rather than inventing a blocker.
 *
 * `knownRepos` bounds that unresolvable case (Issue #1249, finding 11). An
 * issue body is text anybody who can open an issue writes, so
 * `Depends on attacker/repo#1` was an unconditional, unfalsifiable claim that
 * this issue is blocked — one line that removed it from the audit's
 * `claimable` count and, with it, the idle-inversion alert the count exists
 * to raise. Only a reference into a **monitored** repository is honoured now:
 * that is the form the blocked-run deferral writes, so the legitimate case is
 * unchanged, while a reference to a repository the fleet does not work in
 * cannot silence the audit. When `knownRepos` is empty the caller has no
 * repository list to check against and every cross-repo reference blocks, as
 * before.
 *
 * `openMilestones` models the cross-milestone hold (Issue #2533, mirroring the
 * census's Issue #2455 parameter): a same-repo dependency that is *closed*
 * still holds this issue while any **other** milestone of the repo is open,
 * because `isDependencyBlocked` (Issue #2173) refuses it until that milestone
 * merges. Empty means "no data" and no hold is applied.
 */ function isDependencyBlockedByOpenIssue(body, repo, openIssueNumbers, knownRepos, candidateMilestone, openMilestones = new Set()) {
  if (body === undefined) return false;
  const refs = extractDependencyReferencesDetailed(body);
  const lowerRepo = repo.trim().toLowerCase();
  // The candidate's own milestone is never a cross-milestone blocker: an
  // issue is not held by the milestone it already sits in.
  // SIMPLE-ON-PURPOSE: the closed dependency's own milestone is not fetched, so
  // this models the hold's precondition — some other milestone of the repo is
  // open — exactly as the census does (Issue #2455). It over-holds towards
  // "not claimable", the direction that cannot manufacture a false
  // `mis_classification` ALERT — upgrade when the audit already has each
  // dependency's milestone to hand without an extra API call per tick.
  const otherMilestoneOpen = [
    ...openMilestones
  ].some((title)=>title !== candidateMilestone);
  return refs.some((ref)=>{
    const refRepo = ref.repo?.trim().toLowerCase();
    const sameRepo = refRepo === undefined || refRepo === lowerRepo;
    if (!sameRepo) {
      return knownRepos.size === 0 || knownRepos.has(refRepo);
    }
    if (openIssueNumbers.has(ref.number)) return true;
    return otherMilestoneOpen;
  });
}
/**
 * Classify each issue in `issues` against the same gates the
 * Priority 2 scan applies. The classifier is pure so unit tests can
 * drive every branch without stubbing gh.
 */ export function classifyIssues(issues, opts) {
  const claimableSet = new Set(opts.claimableLabels ?? CLAIMABLE_LABELS);
  const blockingSet = new Set(BLOCKING_LABELS);
  const paceExemptSet = new Set(PACE_EXEMPT_LABELS);
  const weekPaceEngaged = opts.weekPaceEngaged === true;
  const quotaIdleDeferred = opts.quotaIdleDeferred === true;
  const untrustedLabelIssues = opts.untrustedLabelIssues ?? new Set();
  const openPRs = opts.openPRs ?? [];
  const mergedPRs = opts.mergedPRs ?? [];
  const runLocalHolds = opts.runLocalHolds ?? new Set();
  const openIssueNumbers = opts.openIssueNumbers ?? new Set();
  const openMilestones = opts.openMilestones ?? new Set();
  const knownRepos = new Set((opts.knownRepos ?? []).filter((r)=>typeof r === "string" && r.trim().length > 0).map((r)=>r.trim().toLowerCase()));
  const repo = opts.repo ?? "";
  const pushCapableAuthors = opts.pushCapableAuthors ?? [];
  // Issue #2873: one clock reading per audit, not per issue.
  const nowMs = Date.now();
  // Issue #1050: the scan's own view of the issue set, so the two gates
  // below are answered by the scan's own functions rather than by a second
  // implementation of the same rule. Every field `isMilestoneOccupied` and
  // `isMilestoneTrackingIssue` read comes off the probe's single
  // `gh issue list`; the rest are placeholders those two never touch.
  const asFilterable = issues.map((issue)=>({
      number: issue.number,
      title: issue.title ?? "",
      url: "",
      author: "",
      assignees: issue.assignees,
      labels: issue.labels,
      createdAt: "",
      milestone: issue.milestone,
      ...issue.body === undefined ? {} : {
        body: issue.body
      }
    }));
  // Streams the scan considers occupied — milestones (or "" for the
  // default-branch stream) that already host an issue assigned to an account
  // the fleet operates. Issue #1050: resolved through the scan's own
  // `isMilestoneOccupied`, over the scan's own account set, once per
  // distinct stream. The hand-rolled version here matched `workerUser`
  // alone, so an issue a sibling worker held left the stream reading as free
  // to the audit while the scan refused every issue in it as
  // `milestone-occupied`.
  const occupiedStreams = new Set();
  for (const stream of new Set(issues.map((i)=>i.milestone))){
    if (isMilestoneOccupied(asFilterable, stream, opts.workerUser, [
      ...pushCapableAuthors
    ])) {
      occupiedStreams.add(stream);
    }
  }
  const trackers = new Set(asFilterable.filter((i)=>isMilestoneTrackingIssue(i)).map((i)=>i.number));
  const result = [];
  for (const issue of issues){
    const hasClaimable = issue.labels.some((l)=>claimableSet.has(l));
    if (!hasClaimable) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "label_filter",
        milestone: issue.milestone
      });
      continue;
    }
    if (issue.labels.some((l)=>blockingSet.has(l))) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "blocking_label",
        milestone: issue.milestone
      });
      continue;
    }
    if (issue.assignees.length > 0) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "assignee_filter",
        milestone: issue.milestone
      });
      continue;
    }
    // Issue #4212: the scan's `label-author-not-allowed` skip, applied
    // straight after the assignee gate and before the tracker drop. Absent
    // `untrustedLabelIssues`, nothing is excluded here.
    if (untrustedLabelIssues.has(issue.number)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "label_author_not_allowed",
        milestone: issue.milestone
      });
      continue;
    }
    // Issue #1050: `filterAndSort` drops milestone-tracking issues in the
    // same pass as assignees and blocking labels (Issue #1134), so a tracker
    // carrying a discovery label is work the scan can never action. The
    // audit counted it, and #2751 has already shown what counting work the
    // scan permanently skips does to a backlog.
    if (trackers.has(issue.number)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "milestone_tracker",
        milestone: issue.milestone
      });
      continue;
    }
    // Issue #2532: occupancy serialises `low-priority` and `idle-task` only.
    // A `top-priority` or `work-on` claim joins a busy stream in its own
    // fresh conversation (Issue #2530) and the collectors no longer refuse
    // it, so excluding it here would put the audit back in disagreement with
    // the scan — the divergence the 2026-08-26 idle-task drought was.
    if (occupiedStreams.has(issue.milestone) && !isStreamSharingTier(issue.labels, DEFAULT_STREAM_SHARING_TIERS)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "stream_occupied",
        milestone: issue.milestone
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
    if (openPRs.length > 0 && isPrBlocked(issue, openPRs, pushCapableAuthors, opts.fleetPrSlots)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "pr_blocked",
        milestone: issue.milestone
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
        milestone: issue.milestone
      });
      continue;
    }
    // Issue #2873: mirrors the scan's own `isTimeDeferred` gate, applied
    // immediately before the dependency-blocked gate below — the scan's own
    // order — so an issue that is both time-deferred and dependency-blocked
    // keeps `time_deferred`, not `dependency_blocked`. Absent body → not
    // deferred, same fail-safe direction as the dependency gate below.
    if (isTimeDeferred(issue.body ?? "", nowMs)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "time_deferred",
        milestone: issue.milestone
      });
      continue;
    }
    // Issue #3314: native sub-issue blocking, read from `subIssuesSummary` on
    // the same `gh issue list` call — independent of `openIssueNumbers` /
    // `openMilestones`, since it needs neither to be known.
    if (hasOpenSubIssues(issue)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "dependency_blocked",
        milestone: issue.milestone
      });
      continue;
    }
    // Issue #857: the scan's eighth gate, absent here until now — the audit
    // counted dependency-blocked issues as claimable and disagreed with a
    // scan that was right, on every tick. Applied in the scan's own order,
    // so an issue refused for a more fundamental reason keeps that reason.
    //
    // Issue #2533: `openMilestones` alone is enough to fire this gate. A
    // cross-milestone hold applies precisely when every dependency is
    // *closed*, so gating it behind `openIssueNumbers.size > 0` would have
    // suppressed the case it exists to catch.
    if (repo !== "" && (openIssueNumbers.size > 0 || openMilestones.size > 0) && isDependencyBlockedByOpenIssue(issue.body, repo, openIssueNumbers, knownRepos, issue.milestone, openMilestones)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "dependency_blocked",
        milestone: issue.milestone
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
        milestone: issue.milestone
      });
      continue;
    }
    // Issues #1885, #1915: the pace gate is the scan's own last word — it
    // drops whole tiers at selection time, after every per-issue filter has
    // run — so it is applied last here too, and an issue refused for a more
    // fundamental reason keeps that reason. `pace_suppressed` marks only work
    // that would otherwise be claimable right now.
    if (weekPaceEngaged && !issue.labels.some((l)=>paceExemptSet.has(l))) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "pace_suppressed",
        milestone: issue.milestone
      });
      continue;
    }
    // Issue #3628: the quota polling gate deferred the idle-task collector,
    // so an issue whose only discovery label is `idle-task` was never
    // collected — the same "the scan's own last word" treatment as the pace
    // gate above, and applied after it so a pace-refused issue keeps its
    // more fundamental reason. An issue that also carries a higher discovery
    // label stays claimable: its collector still ran.
    if (quotaIdleDeferred && issue.labels.includes(IDLE_TASK_LABEL) && !issue.labels.some((l)=>claimableSet.has(l) && l !== IDLE_TASK_LABEL)) {
      result.push({
        number: issue.number,
        claimable: false,
        excludedBy: "quota_idle_deferred",
        milestone: issue.milestone
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
      milestone: issue.milestone
    });
  }
  return result;
}
/**
 * Pick the dominant skip reason for a repo when `claimable === 0`.
 * Specificity order (most → least specific):
 *   merged_pr_blocked > pr_blocked > pace_suppressed > run_local_hold >
 *   dependency_blocked > time_deferred > stream_occupied >
 *   milestone_tracker > label_author_not_allowed > assignee_filter >
 *   blocking_label > label_filter.
 * The two PR gates rank first because they describe fleet state that may
 * need a human to resolve. Below them, each later gate in `classifyIssues`
 * ranks above the ones it follows, because a later gate only ever refuses
 * an issue every earlier gate already passed — making it the more specific
 * answer.
 */ export function pickDominantReason(verdicts) {
  if (verdicts.length === 0) return "no_open";
  const seen = new Set();
  for (const v of verdicts){
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
  // Issue #1915: below the two PR gates and above the run-local hold. It is
  // only ever set on an issue nothing else refused, and "the week-pace guard
  // is spending what is left of the quota on urgency signals" is the answer an
  // operator asking why the fleet is idle actually needs — a hold clears when
  // the run ends, the guard stands until the weekly window resets.
  // Issue #655: below the two PR gates, above everything applied before it.
  // Both PR gates describe fleet state that outlives this process and may
  // need a human; a run-local hold clears itself when the run ends or the
  // cooldown expires, so it is the less urgent answer of the three — but it
  // is only ever set on an issue nothing else refused, which makes it more
  // specific than stream occupancy and the filters above that.
  if (seen.has("pace_suppressed")) return "pace_suppressed";
  // Issue #3628: the quota polling gate defers the idle tier until the
  // hourly GraphQL window resets — same temporal shape as the pace guard
  // (the fleet's own deliberate refusal, standing until a window opens),
  // and it is applied right after it in classifyIssues, so it outranks a
  // run-local hold for the same reason pace_suppressed does.
  if (seen.has("quota_idle_deferred")) return "quota_idle_deferred";
  if (seen.has("run_local_hold")) return "run_local_hold";
  // Issue #3334: classifyIssues applies time_deferred, then dependency_blocked,
  // after the PR gates and before the hold and pace gates — the later gate is
  // the more specific, so dependency_blocked outranks time_deferred.
  if (seen.has("dependency_blocked")) return "dependency_blocked";
  if (seen.has("time_deferred")) return "time_deferred";
  if (seen.has("stream_occupied")) return "stream_occupied";
  // Issue #1050: below stream occupancy — a tracker is only ever refused
  // after the label, blocking-label and assignee gates have passed it, but
  // "the stream is busy" is the more actionable answer when both apply.
  if (seen.has("milestone_tracker")) return "milestone_tracker";
  // Issue #4212: below the tracker drop and above the assignee filter. The
  // scan applies the label-author skip after assignees have passed and
  // before the tracker, so an untrusted label is the more specific answer
  // when the only other exclusion is an assignment.
  if (seen.has("label_author_not_allowed")) return "label_author_not_allowed";
  if (seen.has("assignee_filter")) return "assignee_filter";
  if (seen.has("blocking_label")) return "blocking_label";
  if (seen.has("label_filter")) return "label_filter";
  return "label_filter"; // defensive — only reached on an empty `seen`
}
/** Our own marker for the "gh succeeded, JSON did not parse" path. */ const PARSE_FAILED_RE = /^\s*parse_failed\b/i;
/**
 * Rate-limit shapes. GitHub returns **403** for both permission denial
 * and secondary rate limits, so throttling must be matched *before* the
 * permission shapes below — a naive "403 ⇒ no access" rule would flag
 * the whole fleet unhealthy during a rate-limit window.
 */ const RATE_LIMIT_RE = /(rate limit exceeded|secondary rate limit|retry-after|x-ratelimit-remaining:\s*0|\b429\b|too many requests)/i;
/** 404 shapes — the repo is invisible to this identity. */ const NOT_FOUND_RE = /(\b404\b|could not resolve to a (repository|user|organization)|not found)/i;
/** 403 bodies that indicate a permission decision rather than throttling. */ const PERMISSION_RE = /(resource not accessible|must have (push|admin|write|pull) access|\bsaml\b|single sign-on|\bsso\b|not authorized|permission)/i;
/**
 * Classify a probe failure message into an actionable kind.
 *
 * Pure and fail-safe: anything unrecognised is `transient`, so an error
 * shape we have never seen can never mark a host unhealthy. Classification
 * only — this function changes no health behaviour on its own.
 */ export function classifyProbeFailure(message) {
  if (PARSE_FAILED_RE.test(message)) return "parse_failed";
  // Throttling first: it is the 403 shape that must NOT read as denial.
  if (RATE_LIMIT_RE.test(message)) return "transient";
  if (NOT_FOUND_RE.test(message) || PERMISSION_RE.test(message)) {
    return "access_denied";
  }
  return "transient";
}
const DEFAULT_PER_REPO_LIMIT = 200;
/**
 * Audit every repo in `opts.repos` and emit one `[idle-detect]` line per
 * repo, a per-tick summary line, and (when the verdict disagrees with
 * the scan) a `mis_classification` ALERT line. Returns the structured
 * verdict so callers can assert on it in tests.
 */ export async function auditClaimableState(opts) {
  const ghFn = opts.ghCommandFn ?? runGhCommand;
  const log = opts.log ?? ((line)=>console.log(line));
  const limit = opts.perRepoLimit ?? DEFAULT_PER_REPO_LIMIT;
  const hostnameFn = opts.hostnameFn ?? (()=>{
    try {
      return Deno.hostname();
    } catch  {
      return "unknown-host";
    }
  });
  const pidFn = opts.pidFn ?? (()=>Deno.pid);
  const host = `${hostnameFn()}:${pidFn()}`;
  const perRepo = [];
  for (const repo of opts.repos){
    const recordProbeError = (errorMessage, logMessage)=>{
      const failureKind = classifyProbeFailure(errorMessage);
      const snap = {
        repo,
        totalOpen: 0,
        claimable: 0,
        reason: "probe_error",
        errorMessage,
        failureKind
      };
      perRepo.push(snap);
      recordRepoProbeBestEffort(repo, failureKind);
      // `reason=probe_error` is deliberately unchanged — downstream log
      // consumers parse it; `failure_kind` is additive.
      log(`[idle-detect] tick=${opts.tick} host=${host} repo=${repo} total_open=0 claimable=0 reason=probe_error failure_kind=${failureKind} message=${logMessage}`);
    };
    let parsed;
    if (opts.openIssuesFn) {
      // The shared, cached read — no `gh` call of the audit's own.
      try {
        parsed = await opts.openIssuesFn(repo, limit);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordProbeError(message, message);
        continue;
      }
    } else {
      let raw;
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
          // Issue #1050: `title` for the same reason — it is the fallback
          // `isMilestoneTrackingIssue` falls back to for trackers filed before
          // the body marker existed.
          // Issue #3314: `subIssuesSummary` for native sub-issue blocking,
          // same free field as the census's own call.
          "number,title,labels,assignees,milestone,body,subIssuesSummary",
          "--limit",
          String(limit)
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordProbeError(message, message);
        continue;
      }
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordProbeError(`parse_failed: ${message}`, "parse_failed");
        continue;
      }
    }
    const issues = Array.isArray(parsed) ? parsed.map(normaliseIssue).filter((i)=>i !== null) : [];
    // Issue #4223: read the repo's open PRs so PR-blocked work is not counted
    // as claimable. Best-effort by design — a failed fetch falls back to no PR
    // blocking, which at worst restores the old over-count rather than
    // silently reporting a repo as having nothing to do.
    let openPRs = [];
    if (opts.openPRsFn) {
      try {
        openPRs = await opts.openPRsFn(repo);
      } catch  {
        openPRs = [];
      }
    }
    // GRQ#4419: read the repo's merged fleet PRs so a permanently stranded
    // issue is not counted as claimable. Best-effort by the same rule as the
    // open-PR fetch above — a failure restores the old over-count rather than
    // silently reporting a repo as having nothing to do.
    let mergedPRs = [];
    if (opts.mergedPRsFn) {
      try {
        mergedPRs = await opts.mergedPRsFn(repo);
      } catch  {
        mergedPRs = [];
      }
    }
    // Issue #2533: the repo's open milestone titles, so a dependency that is
    // closed inside another still-open milestone reads as held rather than
    // claimable. Best-effort by the same rule as the two fetches above — a
    // rejection applies no hold and never throws.
    let openMilestones = new Set();
    if (opts.openMilestonesFn) {
      try {
        openMilestones = await opts.openMilestonesFn(repo);
      } catch  {
        openMilestones = new Set();
      }
    }
    // Issue #655: resolve this run's own holds for the repo, so work the
    // claim scan is silently and correctly refusing is not counted as
    // claimable for the life of the process. Best-effort by the same rule as
    // the two fetches above.
    let runLocalHolds = new Set();
    if (opts.runLocalHoldFn) {
      try {
        runLocalHolds = new Set(issues.filter((i)=>opts.runLocalHoldFn(repo, i.number, i.milestone)).map((i)=>i.number));
      } catch  {
        runLocalHolds = new Set();
      }
    }
    // Issue #857: the repo's own open issues, resolved from the response
    // already in hand. Capped by `perRepoLimit` like everything else here, so
    // a dependency beyond the cap reads as closed — an under-count, the same
    // fail-safe direction every other gate takes.
    const openIssueNumbers = new Set(issues.map((i)=>i.number));
    // Issue #4212: the claim scan's label-author gate. A rejected lookup
    // falls back to an empty set — the old over-count — and the warning
    // names the fault. Treating the failure as nothing claimable would
    // hide it.
    let untrustedLabelIssues = new Set();
    if (opts.untrustedLabelIssuesFn) {
      try {
        untrustedLabelIssues = await opts.untrustedLabelIssuesFn(repo, issues);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[idle-detect] tick=${opts.tick} host=${host} repo=${repo} action=warn reason=untrusted_label_lookup_failed message=${message}`);
        untrustedLabelIssues = new Set();
      }
    }
    const verdicts = classifyIssues(issues, {
      workerUser: opts.workerUser,
      pushCapableAuthors: opts.pushCapableAuthors,
      openPRs,
      fleetPrSlots: opts.fleetPrSlotsFor?.(repo),
      mergedPRs,
      runLocalHolds,
      repo,
      openIssueNumbers,
      // Issue #2533: a dependency closed inside another open milestone is
      // held by the scan until that milestone merges.
      openMilestones,
      // Issue #1249: the audit already knows which repositories the fleet
      // monitors, so a dependency on anything else is not a blocker it can
      // be silenced by.
      knownRepos: opts.repos,
      // Issues #1885, #1915: a tier the pace gate dropped is a modelled
      // refusal, not claimable work the scan mysteriously passed over.
      weekPaceEngaged: opts.weekPaceEngaged,
      // Issue #3628: the quota gate's idle-tier deferral is the same shape —
      // a modelled refusal, not a misclassification.
      quotaIdleDeferred: opts.quotaIdleDeferred,
      untrustedLabelIssues
    });
    const claimableCount = verdicts.filter((v)=>v.claimable).length;
    const reason = claimableCount > 0 ? "has_claimable" : pickDominantReason(verdicts);
    perRepo.push({
      repo,
      totalOpen: issues.length,
      claimable: claimableCount,
      reason
    });
    // Issue #4037: gh answered for this repo, so the identity can still
    // see it — the one outcome that clears a prior denial count.
    recordRepoProbeBestEffort(repo, "ok");
    log(`[idle-detect] tick=${opts.tick} host=${host} repo=${repo} total_open=${issues.length} claimable=${claimableCount} reason=${reason}`);
  }
  const claimableTotal = perRepo.reduce((sum, r)=>sum + r.claimable, 0);
  // Issue #898: a repo held wholesale was skipped before any eligibility
  // check ran, so the scan claiming nothing from it is not a disagreement.
  const heldRepos = new Set(opts.heldRepos ?? []);
  const misClassificationRepos = perRepo.filter((r)=>r.claimable > 0 && !heldRepos.has(r.repo)).map((r)=>r.repo);
  // Issue #479: a gated cycle never ran the scan, so a disagreement with it
  // is not evidence of anything.
  const misClassification = !opts.scanFoundClaimable && misClassificationRepos.length > 0 && opts.claimGateActive !== true;
  log(`[idle-detect] tick=${opts.tick} host=${host} repos=${opts.repos.length} claimable_total=${claimableTotal}`);
  if (misClassification) {
    // Operators grep the literal `mis_classification` token to surface
    // the regression #2106 set out to catch.
    log(`[idle-detect] tick=${opts.tick} host=${host} ALERT mis_classification claimable_total=${claimableTotal} repos=${misClassificationRepos.join(",")}`);
  }
  return {
    tick: opts.tick,
    host,
    perRepo,
    claimableTotal,
    misClassification,
    misClassificationRepos
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pZGxlX2RldGVjdF9kaWFnbm9zdGljcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIElkbGUtZGV0ZWN0aW9uIGF1ZGl0IGRpYWdub3N0aWNzIChJc3N1ZSAjMjEwNikuXG4gKlxuICogVGhlIFByaW9yaXR5IDIgc2NhbiBpbiBgcnVuX2NvcmUudHNgIHdhbGtzIGV2ZXJ5IG1vbml0b3JlZCByZXBvIGFuZFxuICogc2V0cyBgdHJhY2tlci5mb3VuZENsYWltYWJsZUlzc3VlID0gdHJ1ZWAgd2hlbiBhbiBpc3N1ZSBpcyBjbGFpbWVkLlxuICogV2hlbiB0aGF0IGZsYWcgaXMgYGZhbHNlYCBhdCBlbmQtb2YtY3ljbGUgdGhlIHdvcmtlciBjYWxscyB0aGVcbiAqIGlkbGUtdGFzayBmaWxlciDigJQgYW5kIFBScyAjMjA0NiAvICMyMDg5IC8gIzIwOTIgLyAjMjA5NSBoYXZlIGFsbCBiZWVuXG4gKiBsYW5kZWQgYmVjYXVzZSB0aGUgZmlsZXIgd2FzIGZpcmluZyBtb3JlIG9mdGVuIHRoYW4gZXhwZWN0ZWQuXG4gKlxuICogVGhlIGZpeCBzaGFwZSBwcm9wb3NlZCBpbiAjMjEwNiBpcyBvYnNlcnZhYmlsaXR5LCBub3QgeWV0IGFub3RoZXJcbiAqIGZpbHRlcjogZW1pdCBwZXItcmVwbyBwZXItdGljayBkaWFnbm9zdGljcyBzbyBvcGVyYXRvcnMgY2FuIHNlZSwgZnJvbVxuICogdGhlIGxvZyBhbG9uZSwgd2hldGhlciB0aGUgd29ya2VyIHRydWx5IGhhZCBubyBjbGFpbWFibGUgd29yaywgYW5kXG4gKiBjcm9zcy1jaGVjayB0aGUgc2NhbidzIHZlcmRpY3QuIFRoZSBhdWRpdCBhbHNvIHRhZ3MgZXZlcnkgbGluZSB3aXRoIGFcbiAqIGhvc3QgaWRlbnRpZmllciBzbyBjb25jdXJyZW50IG11bHRpLWhvc3QgaWRsZSBkZWNsYXJhdGlvbnMgYXJlIHZpc2libGVcbiAqIGluIGFnZ3JlZ2F0ZWQgbG9ncy5cbiAqXG4gKiAjIFdoYXQgXCJjbGFpbWFibGVcIiBtZWFucyBoZXJlXG4gKlxuICogVGhlIGF1ZGl0IHJlLWNsYXNzaWZpZXMgb3BlbiBpc3N1ZXMgdXNpbmcgdGhlIHNhbWUgc2lnbmFscyB0aGVcbiAqIFByaW9yaXR5IDIgc2NhbiBhbmQgYGZpbmRPbGRlc3RJc3N1ZWAgdXNlLCBidXQgcmVhZHMgdGhlbSBvZmYgYSBzaW5nbGVcbiAqIGBnaCBpc3N1ZSBsaXN0YCBwZXIgcmVwbyBzbyB0aGUgcHJvYmUgaXMgY2hlYXAuIEFuIGlzc3VlIGlzXG4gKiAqY2xhaW1hYmxlKiB3aGVuIGV2ZXJ5IGdhdGUgYmVsb3cgcGFzc2VzOlxuICpcbiAqICAgMS4gQ2FycmllcyBhdCBsZWFzdCBvbmUgYXBwcm92ZWQtd29yayBsYWJlbFxuICogICAgICAoYHRvcC1wcmlvcml0eWAsIGB3b3JrLW9uYCwgYGxvdy1wcmlvcml0eWAsIGBpZGxlLXRhc2tgKS5cbiAqICAgMi4gQ2FycmllcyBubyBibG9ja2luZyBsYWJlbCAoYGZhaWxlZGAsIGBuZWVkcy1yZXZpc2lvbmAsXG4gKiAgICAgIGByZWZpbmUtaXNzdWVgLCBgcGxhbm5pbmdgLCBgcXVlc3Rpb25gLCBgbmVlZHMtaHVtYW5gKS5cbiAqICAgMy4gSGFzIG5vIGFzc2lnbmVlcyAoYGZpbHRlckJ5QXNzaWduZWVgIGluIGBpc3N1ZV9maWx0ZXIudHNgKS5cbiAqICAgM2EuIEl0cyBwcmlvcml0eSBsYWJlbCB3YXMgYWRkZWQgYnkgYSB0cnVzdGVkIGF1dGhvciAoSXNzdWUgIzQyMTIpLlxuICogICAgICBJc3N1ZXMgbmFtZWQgYnkgYHVudHJ1c3RlZExhYmVsSXNzdWVzYCBhcmUgZXhjbHVkZWQgYXNcbiAqICAgICAgYGxhYmVsX2F1dGhvcl9ub3RfYWxsb3dlZGAsIG1hdGNoaW5nIHRoZSBjbGFpbSBzY2FuJ3NcbiAqICAgICAgYGxhYmVsLWF1dGhvci1ub3QtYWxsb3dlZGAgc2tpcC4gQWJzZW50LCB0aGUgZ2F0ZSBpcyBza2lwcGVkLlxuICogICAzYi4gSXMgbm90IGEgbWlsZXN0b25lLXRyYWNraW5nIGlzc3VlIOKAlCBgZmlsdGVyQW5kU29ydGAgZHJvcHMgdGhvc2VcbiAqICAgICAgaW4gdGhlIHNhbWUgcGFzcyAoSXNzdWUgIzExMzQsIGdhdGUgYWRkZWQgYnkgSXNzdWUgIzEwNTApLlxuICogICA0LiBJdHMgd29yayBzdHJlYW0g4oCUIHRoZSBtaWxlc3RvbmUgdGl0bGUsIG9yIGBcIlwiYCBmb3IgZGVmYXVsdFxuICogICAgICBicmFuY2gg4oCUIGlzIG5vdCBhbHJlYWR5IG9jY3VwaWVkLiBUaGUgdmVyZGljdCBjb21lcyBmcm9tIHRoZVxuICogICAgICBzY2FuJ3Mgb3duIGBpc01pbGVzdG9uZU9jY3VwaWVkYCwgb3ZlciB0aGUgc2NhbidzIG93biBhY2NvdW50XG4gKiAgICAgIHNldDogYHdvcmtlclVzZXJgIHBsdXMgdGhlIGNhbGxlcidzIGBwdXNoQ2FwYWJsZUF1dGhvcnNgIChJc3N1ZXNcbiAqICAgICAgIzEwNTAsICMxMDY0KS4gU3VwcGx5IHRoYXQgc2V0LCBvciBhIHN0cmVhbSBhIHNpYmxpbmcgd29ya2VyXG4gKiAgICAgIGhvbGRzIHJlYWRzIGFzIGZyZWUgaGVyZSBhbmQgYXMgYG1pbGVzdG9uZS1vY2N1cGllZGAgdG8gdGhlXG4gKiAgICAgIHNjYW4g4oCUIHRoZSBkaXZlcmdlbmNlIGJlaGluZCB0aGUgdGVuLWRheSBmbGVldC13aWRlIGlkbGUtdGFza1xuICogICAgICBkcm91Z2h0IG9mIDIwMjYtMDgtMjYsIHdoZW4gb25lIGFzc2lnbm1lbnQgaW4gdGhlXG4gKiAgICAgIGRlZmF1bHQtYnJhbmNoIHN0cmVhbSBtYWRlIGEgMjQtaXNzdWUgYmFja2xvZyB1bmNsYWltYWJsZSB3aGlsZVxuICogICAgICB0aGUgYXVkaXQgd2VudCBvbiBjb3VudGluZyBhbGwgMjQuXG4gKiAgIDUuIE5vIG9wZW4gUFIgYmxvY2tzIGl0cyB3b3JrIHN0cmVhbSB1bmRlciB0aGUgc2NhbidzIG93blxuICogICAgICBtaWxlc3RvbmUtYXdhcmUgcnVsZSAoYGdldEJsb2NraW5nUFJGb3JJc3N1ZWApLCB1bmxlc3MgdGhlIGlzc3VlXG4gKiAgICAgIGNhcnJpZXMgYGlnbm9yZS1vcGVuLXByc2AgKElzc3VlICM0MjIzKS4gUmVxdWlyZXMgdGhlIGNhbGxlciB0b1xuICogICAgICBzdXBwbHkgUFJzIHZpYSBgb3BlblBSc0ZuYDsgd2l0aG91dCB0aGVtIHRoaXMgZ2F0ZSBpcyBza2lwcGVkLlxuICogICA2LiBUaGlzIHJ1biBpcyBub3QgaG9sZGluZyB0aGUgaXNzdWUgYmFjayAoSXNzdWUgIzY1NSkg4oCUIHRoZVxuICogICAgICBgaXNJc3N1ZUluQ29vbGRvd25gIHByZWRpY2F0ZSBgZmluZF9vbGRlc3RfaXNzdWUudHNgIGZpbHRlcnMgZXZlcnlcbiAqICAgICAgdGllcidzIGNhbmRpZGF0ZXMgYWdhaW5zdCwgY292ZXJpbmcgdGhlIHBlcnNpc3RlZCByZXRyeSBjb29sZG93biBhbmRcbiAqICAgICAgdGhlIHBlci1ydW4gcHJvY2Vzc2VkLWlzc3VlIHJlZ2lzdHJ5LiBUaGUgcHJlZGljYXRlIGlzIGFsc28gaGFuZGVkXG4gKiAgICAgIHRoZSBpc3N1ZSdzIG1pbGVzdG9uZSB0aXRsZSBzbyBhIHBhY2VkIG1pbGVzdG9uZSBjYW4gYmUgaGVsZCAoSXNzdWVcbiAqICAgICAgIzM1ODcpLiBSZXF1aXJlcyB0aGUgY2FsbGVyIHRvIHN1cHBseSBgcnVuTG9jYWxIb2xkRm5gOyB3aXRob3V0IGl0XG4gKiAgICAgIHRoaXMgZ2F0ZSBpcyBza2lwcGVkLlxuICpcbiAqIFRoZSBwcm9iZSBkZWxpYmVyYXRlbHkgc3RvcHMgc2hvcnQgb2YgdGhlIHJlbWFpbmluZyBydW4tbG9jYWwgZmlsdGVyc1xuICogKHRoZSBjbG9zZWQtUFIgY29vbGRvd24sIHRoZSBwZXItY3ljbGUgYWRhcHRpdmUgZmxvb3IpIHNvIHRoZSBkaWFnbm9zdGljXG4gKiBhbnN3ZXJzIHRoZSBjcm9zcy1mbGVldCBxdWVzdGlvbiBcImlzIHRoZXJlIHdvcmsgR2l0SHViICpjb3VsZCogaGFuZCB0byBhXG4gKiB3b3JrZXIgcmlnaHQgbm93P1wiIHJhdGhlciB0aGFuIFwiZGlkIHRoaXMgcGFydGljdWxhciB3b3JrZXIgcGljayBzb21ldGhpbmdcbiAqIHVwIHRoaXMgY3ljbGU/XCIuXG4gKlxuICogR2F0ZSA2IGlzIHRoZSBleGNlcHRpb24gdGhhdCBwcm92ZXMgdGhlIHJ1bGUsIGFuZCBpdCBpcyBoZXJlIGJlY2F1c2UgdGhlXG4gKiByZWdpc3RyeSdzIGVudHJpZXMgbGl2ZSBhcyBsb25nIGFzIHRoZSBwcm9jZXNzIGRvZXMuIE9uIDIwMjYtMDgtMzAgdHdvXG4gKiBgc3RTb2Z0d2FyZUFVL1ZpYmVDb2RlcmAgaXNzdWVzIHRoaXMgcnVuIGhhZCBhbHJlYWR5IGhhbmRlZCBiYWNrIHdlcmVcbiAqIHJlZnVzZWQgc2lsZW50bHkgYnkgdGhlIHNjYW4gb24gZXZlcnkgbGF0ZXIgY3ljbGUgd2hpbGUgdGhlIGF1ZGl0IHdlbnQgb25cbiAqIGNvdW50aW5nIHRoZW0sIHNvIGBtaXNfY2xhc3NpZmljYXRpb25gIGZpcmVkIGZvciB0aGUgbGlmZSBvZiB0aGUgcnVuIGFuZFxuICogdGhlIGF1ZGl0J3Mgb3duIGBjbGFpbWFibGVUb3RhbGAgc3VwcHJlc3NlZCB0aGUgaWRsZS10YXNrIGZpbGVyIHdpdGggaXRcbiAqIChWaWJlQ29kZXIjNjU1KS4gVGhlIGNlbnN1cyBtb2RlbHMgdGhlIHNhbWUgaG9sZCBzZXQgZnJvbSB0aGUgc2FtZVxuICogc291cmNlLCBzbyB0aGUgdGhyZWUgaW5zdHJ1bWVudHMgY2Fubm90IGRyaWZ0IGFwYXJ0IGFnYWluLlxuICpcbiAqIEdhdGUgNSBpcyBub3Qgb25lIG9mIHRob3NlIHJ1bi1sb2NhbCBmaWx0ZXJzIGVpdGhlci4gQW4gaXNzdWUgd2hvc2UgUFIgaXNcbiAqIGFscmVhZHkgb3BlbiBhbmQgYXdhaXRpbmcgcmV2aWV3IGlzIHdvcmsgR2l0SHViICpjYW5ub3QqIGhhbmQgdG8gYVxuICogd29ya2VyLCBhbmQgb3BlbiBQUnMgYXdhaXRpbmcgcmV2aWV3IGFyZSB0aGlzIGZsZWV0J3Mgbm9ybWFsIHN0ZWFkeVxuICogc3RhdGUg4oCUIHNvIHdpdGhvdXQgaXQgdGhlIGF1ZGl0IGRpc2FncmVlZCB3aXRoIGEgY29ycmVjdCBzY2FuIG9uXG4gKiBlc3NlbnRpYWxseSBldmVyeSB0aWNrICgxNTEyIGFsZXJ0cyBpbiBhIHNpbmdsZSBsb2cgb24gaG9zdC0zKSwgZHJvd25pbmdcbiAqIHRoZSBnZW51aW5lICMyMTA2IHN5bXB0b20gaXQgZXhpc3RzIHRvIHN1cmZhY2UgYW5kIHN1cHByZXNzaW5nIHRoZVxuICogaWRsZS10YXNrIGZpbGVyIGZvciBhcyBsb25nIGFzIGFueSBQUiB3YXMgb3Blbi5cbiAqXG4gKiAjIE1pcy1jbGFzc2lmaWNhdGlvbiBhbGVydFxuICpcbiAqIFdoZW4gdGhlIGF1ZGl0IHJlcG9ydHMgYGNsYWltYWJsZV90b3RhbCA+IDBgIGJ1dCB0aGUgY2FsbGVyIHJlcG9ydHNcbiAqIHRoZSBzY2FuIGNsYWltZWQgbm90aGluZyAoYGZvdW5kQ2xhaW1hYmxlSXNzdWU9ZmFsc2VgKSwgYSBzaW5nbGVcbiAqIGBbaWRsZS1kZXRlY3RdIC4uLiBBTEVSVCBtaXNfY2xhc3NpZmljYXRpb24gLi4uYCBsaW5lIGlzIGVtaXR0ZWRcbiAqIGxpc3RpbmcgdGhlIG9mZmVuZGluZyByZXBvcy4gVGhhdCBpcyB0aGUgXCJhdWRpdCBjYXRjaGVzIHRoZSBvcmlnaW5hbFxuICogc3ltcHRvbVwiIGFjY2VwdGFuY2UgY3JpdGVyaW9uOiBsb2cgc2NyYXBlcnMgY2FuIGdyZXAgZm9yIHRoZSBsaXRlcmFsXG4gKiBgbWlzX2NsYXNzaWZpY2F0aW9uYCB0b2tlbi5cbiAqXG4gKiAjIFByb2JlLWZhaWx1cmUgY2xhc3NpZmljYXRpb24gKElzc3VlICM0MDM1KVxuICpcbiAqIEV2ZXJ5IGBnaCBpc3N1ZSBsaXN0YCBmYWlsdXJlIHVzZWQgdG8gY29sbGFwc2UgaW50byBhIHNpbmdsZVxuICogYHJlYXNvbj1wcm9iZV9lcnJvcmAgbGluZSwgc28gYSByZXBvIHRoZSB3b3JrZXIgY291bGQgbm8gbG9uZ2VyICpzZWUqXG4gKiAoIzQwMjgpIGxvb2tlZCBpZGVudGljYWwgdG8gYSBmaXZlLXNlY29uZCBuZXR3b3JrIGJsaXAuXG4gKiB7QGxpbmsgY2xhc3NpZnlQcm9iZUZhaWx1cmV9IHNwbGl0cyB0aG9zZSBpbnRvIGBhY2Nlc3NfZGVuaWVkYCxcbiAqIGB0cmFuc2llbnRgIGFuZCBgcGFyc2VfZmFpbGVkYCwgcmVjb3JkZWQgb24gdGhlIHNuYXBzaG90IGFuZCBhcHBlbmRlZFxuICogdG8gdGhlIGxvZyBsaW5lIGFzIGBmYWlsdXJlX2tpbmQ9PGtpbmQ+YC5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdXNlZCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHsgcnVuR2hDb21tYW5kIH0gZnJvbSBcIi4vZ2l0aHViLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIENsb3NlZFBSLFxuICBnZXRCbG9ja2luZ1BSRm9ySXNzdWUsXG4gIGhhc09wZW5TdWJJc3N1ZXMsXG4gIGlzQmxvY2tlZEJ5UmVjZW50bHlDbG9zZWRQUixcbiAgdHlwZSBPcGVuUFIsXG4gIHBhcnNlU3ViSXNzdWVzU3VtbWFyeSxcbn0gZnJvbSBcIi4vaXNzdWVfcXVlcnkudHNcIjtcbmltcG9ydCB7XG4gIERFRkFVTFRfU1RSRUFNX1NIQVJJTkdfVElFUlMsXG4gIHR5cGUgRmlsdGVyYWJsZUlzc3VlLFxuICBpc01pbGVzdG9uZU9jY3VwaWVkLFxuICBpc01pbGVzdG9uZVRyYWNraW5nSXNzdWUsXG4gIGlzU3RyZWFtU2hhcmluZ1RpZXIsXG59IGZyb20gXCIuL2lzc3VlX2ZpbHRlci50c1wiO1xuaW1wb3J0IHsgTEFCRUxfREVGQVVMVFMgfSBmcm9tIFwiLi9jb25maWdfZGVmYXVsdHMudHNcIjtcbmltcG9ydCB7IElETEVfVEFTS19MQUJFTCB9IGZyb20gXCIuL2lkbGVfdGFza19pc3N1ZS50c1wiO1xuLy8gSXNzdWUgIzQwMzc6IHRoZSBhdWRpdCdzIHBlci1yZXBvIHByb2JlIGFsc28gZmVlZHMgdGhlIGFjY2VzcyBzdG9yZS5cbmltcG9ydCB7IHJlY29yZFJlcG9Qcm9iZUJlc3RFZmZvcnQgfSBmcm9tIFwiLi9tb25pdG9yZWRfcmVwb19hY2Nlc3MudHNcIjtcbmltcG9ydCB7IGV4dHJhY3REZXBlbmRlbmN5UmVmZXJlbmNlc0RldGFpbGVkIH0gZnJvbSBcIi4vaXNzdWVfZGVwZW5kZW5jaWVzLnRzXCI7XG5pbXBvcnQgeyBpc1RpbWVEZWZlcnJlZCB9IGZyb20gXCIuL3RpbWVfZGVmZXJyYWwudHNcIjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBMYWJlbCBzZXRzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBMYWJlbHMgdGhhdCBtYXJrIGFuIGlzc3VlIGFzIFwiYXBwcm92ZWQgd29yayB0aGUgc2NhbiBsb29wIGNhbiBjbGFpbVwiLlxuICogTWlycm9ycyBgQVBQUk9WRURfV09SS19MQUJFTFNgIGluIGByZXBvX2J1c3lfZm9yX2lkbGVfdGFzay50c2Agc28gdGhlXG4gKiB0d28gY2hlY2tzIHN0YXkgaW4gbG9ja3N0ZXAg4oCUIHRoZSBidXN5IGdhdGUgc2tpcHMgcmVwb3Mgd2l0aCBhbnkgb2ZcbiAqIHRoZXNlLCB0aGUgYXVkaXQgY291bnRzIHRoZW0uXG4gKi9cbmV4cG9ydCBjb25zdCBDTEFJTUFCTEVfTEFCRUxTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgTEFCRUxfREVGQVVMVFMudG9wUHJpb3JpdHlMYWJlbCxcbiAgTEFCRUxfREVGQVVMVFMud29ya09uTGFiZWwsXG4gIExBQkVMX0RFRkFVTFRTLmxvd1ByaW9yaXR5TGFiZWwsXG4gIElETEVfVEFTS19MQUJFTCxcbl0gYXMgY29uc3Q7XG5cbi8qKlxuICogRGlzY292ZXJ5IGxhYmVscyB0aGUgd2Vlay1wYWNlIGd1YXJkIGxlYXZlcyBpbiB0aGUgbGFkZGVyIChJc3N1ZXMgIzE4ODUsXG4gKiAjMTkxNSkuXG4gKlxuICogYHNlbGVjdEhpZ2hlc3RQcmlvcml0eWAgZHJvcHMgdGllcnMgMyBhbmQgNCB3aGlsZSB0aGUgZ3VhcmQgaXMgZW5nYWdlZCwgc29cbiAqIGFuIGlzc3VlIGNhcnJ5aW5nIG9uZSBvZiB0aGVzZSBpcyBzdGlsbCBjbGFpbWFibGUgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpblxuICoge0BsaW5rIENMQUlNQUJMRV9MQUJFTFN9IGlzIG5vdC4gRXhwcmVzc2VkIGFzIHRoZSBleGVtcHRpb24gcmF0aGVyIHRoYW4gdGhlXG4gKiBzdXBwcmVzc2lvbiBzbyBhIGRpc2NvdmVyeSBsYWJlbCBhZGRlZCB0byB0aGUgbGFkZGVyIGFib3ZlIHRpZXIgMyBoYXMgdG8gYmVcbiAqIG5hbWVkIGhlcmUgZGVsaWJlcmF0ZWx5LCBhbmQgYW4gdW5yZWNvZ25pc2VkIG9uZSBmYWlscyBzYWZlIGJ5XG4gKiB1bmRlci1jb3VudGluZyBjbGFpbWFibGUgd29yayDigJQgdGhlIGRpcmVjdGlvbiB0aGlzIG1vZHVsZSBhbHdheXMgcHJlZmVycy5cbiAqL1xuY29uc3QgUEFDRV9FWEVNUFRfTEFCRUxTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgTEFCRUxfREVGQVVMVFMudG9wUHJpb3JpdHlMYWJlbCxcbiAgTEFCRUxfREVGQVVMVFMud29ya09uTGFiZWwsXG5dIGFzIGNvbnN0O1xuXG4vKipcbiAqIExhYmVscyB0aGF0IGV4Y2x1ZGUgYW4gaXNzdWUgZnJvbSB0aGUgZGlzY292ZXJ5IHNjYW4gcmVnYXJkbGVzcyBvZlxuICogaXRzIGRpc2NvdmVyeSBsYWJlbC4gTWF0Y2hlcyB0aGUgYmxvY2tpbmcgc2V0IGluXG4gKiBgaXNzdWVfZmlsdGVyLnRzOjpmaWx0ZXJBbmRTb3J0YC5cbiAqL1xuZXhwb3J0IGNvbnN0IEJMT0NLSU5HX0xBQkVMUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIExBQkVMX0RFRkFVTFRTLm5lZWRzUmV2aXNpb25MYWJlbCxcbiAgTEFCRUxfREVGQVVMVFMucmVmaW5lSXNzdWVMYWJlbCxcbiAgTEFCRUxfREVGQVVMVFMucGxhbm5pbmdMYWJlbCxcbiAgTEFCRUxfREVGQVVMVFMucXVlc3Rpb25MYWJlbCxcbiAgTEFCRUxfREVGQVVMVFMubmVlZHNIdW1hbkxhYmVsLFxuXSBhcyBjb25zdDtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQdWJsaWMgZGF0YSBzaGFwZVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBEb21pbmFudCByZWFzb24gYGNsYWltYWJsZT0wYCBmb3IgYSBzaW5nbGUgcmVwby4gKi9cbmV4cG9ydCB0eXBlIENsYWltYWJsZVNraXBSZWFzb24gPVxuICB8IFwiaGFzX2NsYWltYWJsZVwiXG4gIHwgXCJub19vcGVuXCJcbiAgfCBcImxhYmVsX2ZpbHRlclwiXG4gIHwgXCJhc3NpZ25lZV9maWx0ZXJcIlxuICAvKiogUHJpb3JpdHkgbGFiZWwgYWRkZWQgYnkgYW4gYXV0aG9yIHRoZSBjbGFpbSBzY2FuIGRvZXMgbm90IHRydXN0ICgjNDIxMikuICovXG4gIHwgXCJsYWJlbF9hdXRob3Jfbm90X2FsbG93ZWRcIlxuICB8IFwiYmxvY2tpbmdfbGFiZWxcIlxuICAvKiogRXZlcnkgY2FuZGlkYXRlIGlzIGEgbWlsZXN0b25lLXRyYWNraW5nIGlzc3VlIChJc3N1ZSAjMTA1MCkuICovXG4gIHwgXCJtaWxlc3RvbmVfdHJhY2tlclwiXG4gIHwgXCJzdHJlYW1fb2NjdXBpZWRcIlxuICB8IFwicHJfYmxvY2tlZFwiXG4gIC8qKiBFdmVyeSBjYW5kaWRhdGUgaXMgbmFtZWQgYnkgYSBtZXJnZWQgZmxlZXQgUFIgKEdSUSM0NDE5KS4gKi9cbiAgfCBcIm1lcmdlZF9wcl9ibG9ja2VkXCJcbiAgLyoqIEV2ZXJ5IGNhbmRpZGF0ZSBpcyBoZWxkIGJhY2sgYnkgdGhpcyBydW4gaXRzZWxmIChJc3N1ZSAjNjU1KS4gKi9cbiAgfCBcInJ1bl9sb2NhbF9ob2xkXCJcbiAgLyoqIEV2ZXJ5IGNhbmRpZGF0ZSBzaXRzIGluIGEgdGllciB0aGUgd2Vlay1wYWNlIGd1YXJkIHNraXBwZWQgKCMxOTE1KS4gKi9cbiAgfCBcInBhY2Vfc3VwcHJlc3NlZFwiXG4gIC8qKiBFdmVyeSBjYW5kaWRhdGUgaXMgaWRsZS10YXNrLW9ubHkgd29yayB0aGUgcXVvdGEgZ2F0ZSBkZWZlcnJlZCAoIzM2MjgpLiAqL1xuICB8IFwicXVvdGFfaWRsZV9kZWZlcnJlZFwiXG4gIC8qKiBFdmVyeSBjYW5kaWRhdGUgbmFtZXMgYW4gb3BlbiBkZXBlbmRlbmN5IG9yIGhhcyBvcGVuIHN1Yi1pc3N1ZXMgKElzc3VlICMzMzM0KS4gKi9cbiAgfCBcImRlcGVuZGVuY3lfYmxvY2tlZFwiXG4gIC8qKiBFdmVyeSBjYW5kaWRhdGUgY2FycmllcyBhIGZ1dHVyZSBgRGVmZXJyZWQgdW50aWxgIGxpbmUgKElzc3VlICMzMzM0KS4gKi9cbiAgfCBcInRpbWVfZGVmZXJyZWRcIlxuICB8IFwicHJvYmVfZXJyb3JcIjtcblxuLyoqXG4gKiBBdWRpdCB2ZXJkaWN0IGZvciBhIHNpbmdsZSByZXBvLiBgdG90YWxfb3BlbmAgY291bnRzIGV2ZXJ5IG9wZW4gaXNzdWVcbiAqIGdoIHJlcG9ydHMgKGNhcHBlZCBhdCB0aGUgcHJvYmUncyBgLS1saW1pdGApOyBgY2xhaW1hYmxlYCBpcyB0aGVcbiAqIHN1YnNldCB0aGF0IHBhc3NlcyBldmVyeSBnYXRlLiBgcmVhc29uYCBpcyBgXCJoYXNfY2xhaW1hYmxlXCJgIHdoZW5cbiAqIGBjbGFpbWFibGUgPiAwYC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZXBvQ2xhaW1hYmxlU25hcHNob3Qge1xuICByZXBvOiBzdHJpbmc7XG4gIHRvdGFsT3BlbjogbnVtYmVyO1xuICBjbGFpbWFibGU6IG51bWJlcjtcbiAgcmVhc29uOiBDbGFpbWFibGVTa2lwUmVhc29uO1xuICAvKiogV2hlbiBgcmVhc29uID09PSBcInByb2JlX2Vycm9yXCJgLCB0aGUgZ2ggLyBwYXJzZSBlcnJvciBtZXNzYWdlLiAqL1xuICBlcnJvck1lc3NhZ2U/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGVuIGByZWFzb24gPT09IFwicHJvYmVfZXJyb3JcImAsIHRoZSBjbGFzc2lmaWNhdGlvbiBvZlxuICAgKiB7QGxpbmsgUmVwb0NsYWltYWJsZVNuYXBzaG90LmVycm9yTWVzc2FnZX0g4oCUIHNlZVxuICAgKiB7QGxpbmsgY2xhc3NpZnlQcm9iZUZhaWx1cmV9LiBBYnNlbnQgZm9yIGV2ZXJ5IG90aGVyIHJlYXNvbi5cbiAgICovXG4gIGZhaWx1cmVLaW5kPzogUHJvYmVGYWlsdXJlS2luZDtcbn1cblxuLyoqIE91dHB1dCBvZiB7QGxpbmsgYXVkaXRDbGFpbWFibGVTdGF0ZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIENsYWltYWJsZUF1ZGl0UmVzdWx0IHtcbiAgLyoqIE1vbm90b25pYyB0aWNrIGNvdW50ZXIgc3VwcGxpZWQgYnkgdGhlIGNhbGxlci4gKi9cbiAgdGljazogbnVtYmVyO1xuICAvKiogYGhvc3RuYW1lOnBpZGAgc28gbXVsdGktaG9zdCBpZGxlIGRlY2xhcmF0aW9ucyBhcmUgdmlzaWJsZS4gKi9cbiAgaG9zdDogc3RyaW5nO1xuICAvKiogT25lIGVudHJ5IHBlciByZXBvLCBpbiBpbnB1dCBvcmRlci4gKi9cbiAgcGVyUmVwbzogUmVwb0NsYWltYWJsZVNuYXBzaG90W107XG4gIC8qKiBTdW0gb2YgYGNsYWltYWJsZWAgYWNyb3NzIGV2ZXJ5IHJlcG8uICovXG4gIGNsYWltYWJsZVRvdGFsOiBudW1iZXI7XG4gIC8qKlxuICAgKiBgdHJ1ZWAgd2hlbiBgY2xhaW1hYmxlVG90YWwgPiAwYCBidXQgdGhlIGNhbGxlciBhc2tlZCB1cyB0byByZWNvcmQgYVxuICAgKiBgZm91bmRDbGFpbWFibGVJc3N1ZT1mYWxzZWAgY3ljbGUuIE9wZXJhdG9ycyBncmVwIGZvciB0aGUgbGl0ZXJhbFxuICAgKiBgbWlzX2NsYXNzaWZpY2F0aW9uYCB0b2tlbiBpbiB0aGUgZW1pdHRlZCBhbGVydCBsaW5lLlxuICAgKi9cbiAgbWlzQ2xhc3NpZmljYXRpb246IGJvb2xlYW47XG4gIC8qKiBSZXBvcyB0aGF0IGNvbnRyaWJ1dGVkIHRvIGBtaXNDbGFzc2lmaWNhdGlvbmAgKGNsYWltYWJsZSA+IDApLiAqL1xuICBtaXNDbGFzc2lmaWNhdGlvblJlcG9zOiBzdHJpbmdbXTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBnaCBzY2hlbWFcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5pbnRlcmZhY2UgR2hJc3N1ZUxhYmVsIHtcbiAgbmFtZT86IHN0cmluZztcbn1cbmludGVyZmFjZSBHaElzc3VlQXNzaWduZWUge1xuICBsb2dpbj86IHN0cmluZztcbn1cbmludGVyZmFjZSBHaElzc3VlTWlsZXN0b25lIHtcbiAgdGl0bGU/OiBzdHJpbmc7XG59XG5pbnRlcmZhY2UgR2hJc3N1ZSB7XG4gIG51bWJlcj86IG51bWJlcjtcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGxhYmVscz86IEdoSXNzdWVMYWJlbFtdO1xuICBhc3NpZ25lZXM/OiBHaElzc3VlQXNzaWduZWVbXTtcbiAgbWlsZXN0b25lPzogR2hJc3N1ZU1pbGVzdG9uZSB8IG51bGw7XG4gIC8qKiBSYXcgR2l0SHViIG5hdGl2ZSBzdWItaXNzdWUgY291bnRzLCB2YWxpZGF0ZWQgYnkgYHBhcnNlU3ViSXNzdWVzU3VtbWFyeWAuICovXG4gIHN1Yklzc3Vlc1N1bW1hcnk/OiB1bmtub3duO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXNlSXNzdWUocmF3OiB1bmtub3duKToge1xuICBudW1iZXI6IG51bWJlcjtcbiAgdGl0bGU6IHN0cmluZztcbiAgbGFiZWxzOiBzdHJpbmdbXTtcbiAgYXNzaWduZWVzOiBzdHJpbmdbXTtcbiAgbWlsZXN0b25lOiBzdHJpbmc7XG4gIC8qKiBJc3N1ZSAjODU3OiBjYXJyaWVzIHRoZSBkZXBlbmRlbmN5IHJlZmVyZW5jZXMgdGhlIHNjYW4ncyBnYXRlIHJlYWRzLiAqL1xuICBib2R5Pzogc3RyaW5nO1xuICAvKiogR2l0SHViIG5hdGl2ZSBzdWItaXNzdWUgY291bnRzIChJc3N1ZSAjMzMxNCk7IGFic2VudCB3aGVuIGludmFsaWQvbWlzc2luZy4gKi9cbiAgc3ViSXNzdWVzU3VtbWFyeT86IHsgdG90YWw6IG51bWJlcjsgY29tcGxldGVkOiBudW1iZXIgfTtcbn0gfCBudWxsIHtcbiAgaWYgKHR5cGVvZiByYXcgIT09IFwib2JqZWN0XCIgfHwgcmF3ID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgdiA9IHJhdyBhcyBHaElzc3VlO1xuICBpZiAodHlwZW9mIHYubnVtYmVyICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUodi5udW1iZXIpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgdGl0bGUgPSB0eXBlb2Ygdi50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IHYudGl0bGUgOiBcIlwiO1xuICAvLyBUd28gc2hhcGVzIGFycml2ZSBoZXJlOiByYXcgYGdoIGlzc3VlIGxpc3QgLS1qc29uYCBvYmplY3RzIChgbGFiZWxzOlxuICAvLyBbe25hbWV9XWAsIGBhc3NpZ25lZXM6IFt7bG9naW59XWAsIGBtaWxlc3RvbmU6IHt0aXRsZX1gKSBhbmQgdGhlXG4gIC8vIGFscmVhZHktZmxhdHRlbmVkIGBGaWx0ZXJhYmxlSXNzdWVgIHRoZSBzaGFyZWQgYGlzc3Vlc19hbGxgIGNhY2hlIGhvbGRzXG4gIC8vIChgbGFiZWxzOiBzdHJpbmdbXWAsIGBhc3NpZ25lZXM6IHN0cmluZ1tdYCwgYG1pbGVzdG9uZTogc3RyaW5nYCkuXG4gIGNvbnN0IGxhYmVscyA9IEFycmF5LmlzQXJyYXkodi5sYWJlbHMpXG4gICAgPyAodi5sYWJlbHMgYXMgdW5rbm93bltdKVxuICAgICAgLm1hcCgobCkgPT5cbiAgICAgICAgdHlwZW9mIGwgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICA/IGxcbiAgICAgICAgICA6ICh0eXBlb2YgKGwgYXMgeyBuYW1lPzogdW5rbm93biB9KT8ubmFtZSA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgICAgPyAobCBhcyB7IG5hbWU6IHN0cmluZyB9KS5uYW1lXG4gICAgICAgICAgICA6IG51bGwpXG4gICAgICApXG4gICAgICAuZmlsdGVyKChzKTogcyBpcyBzdHJpbmcgPT4gcyAhPT0gbnVsbClcbiAgICA6IFtdO1xuICBjb25zdCBhc3NpZ25lZXMgPSBBcnJheS5pc0FycmF5KHYuYXNzaWduZWVzKVxuICAgID8gKHYuYXNzaWduZWVzIGFzIHVua25vd25bXSlcbiAgICAgIC5tYXAoKGEpID0+XG4gICAgICAgIHR5cGVvZiBhID09PSBcInN0cmluZ1wiXG4gICAgICAgICAgPyBhXG4gICAgICAgICAgOiAodHlwZW9mIChhIGFzIHsgbG9naW4/OiB1bmtub3duIH0pPy5sb2dpbiA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgICAgPyAoYSBhcyB7IGxvZ2luOiBzdHJpbmcgfSkubG9naW5cbiAgICAgICAgICAgIDogbnVsbClcbiAgICAgIClcbiAgICAgIC5maWx0ZXIoKHMpOiBzIGlzIHN0cmluZyA9PiBzICE9PSBudWxsKVxuICAgIDogW107XG4gIGNvbnN0IHJhd01pbGVzdG9uZSA9IHYubWlsZXN0b25lIGFzIHVua25vd247XG4gIGNvbnN0IG1pbGVzdG9uZSA9IHR5cGVvZiByYXdNaWxlc3RvbmUgPT09IFwic3RyaW5nXCJcbiAgICA/IHJhd01pbGVzdG9uZVxuICAgIDogKHR5cGVvZiAocmF3TWlsZXN0b25lIGFzIHsgdGl0bGU/OiB1bmtub3duIH0pPy50aXRsZSA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyAocmF3TWlsZXN0b25lIGFzIHsgdGl0bGU6IHN0cmluZyB9KS50aXRsZVxuICAgICAgOiBcIlwiKTtcbiAgY29uc3QgYm9keSA9IHR5cGVvZiAodiBhcyB7IGJvZHk/OiB1bmtub3duIH0pLmJvZHkgPT09IFwic3RyaW5nXCJcbiAgICA/ICh2IGFzIHsgYm9keTogc3RyaW5nIH0pLmJvZHlcbiAgICA6IHVuZGVmaW5lZDtcbiAgLy8gSXNzdWUgIzMzMTQ6IG5hdGl2ZSBzdWItaXNzdWUgY291bnRzLCBrZXB0IG9ubHkgd2hlbiB2YWxpZC5cbiAgY29uc3Qgc3ViSXNzdWVzU3VtbWFyeSA9IHBhcnNlU3ViSXNzdWVzU3VtbWFyeSh2LnN1Yklzc3Vlc1N1bW1hcnkpO1xuICByZXR1cm4ge1xuICAgIG51bWJlcjogdi5udW1iZXIsXG4gICAgdGl0bGUsXG4gICAgbGFiZWxzLFxuICAgIGFzc2lnbmVlcyxcbiAgICBtaWxlc3RvbmUsXG4gICAgLi4uKGJvZHkgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBib2R5IH0pLFxuICAgIC4uLihzdWJJc3N1ZXNTdW1tYXJ5ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgc3ViSXNzdWVzU3VtbWFyeSB9KSxcbiAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQdXJlIGNsYXNzaWZpZXIgKGV4dHJhY3RlZCBzbyB1bml0IHRlc3RzIGNhbiBleGVyY2lzZSBpdCB3aXRob3V0IGdoKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogQnlwYXNzIGxhYmVsOiB0aGUgb3BlcmF0b3IgaGFzIGRlY2xhcmVkIHRoYXQgb3BlbiBQUnMgbXVzdCBub3QgaG9sZCB0aGlzXG4gKiBpc3N1ZSBiYWNrLiBNaXJyb3JzIHRoZSBjZW5zdXMgKElzc3VlICMzNTI2KSDigJQgcmF3IGxhYmVsIHByZXNlbmNlIG9ubHksIG5vXG4gKiB0aW1lbGluZSBsb29rdXAsIGJlY2F1c2UgdGhlIGF1ZGl0IG11c3Qgc3RheSBhIGNoZWFwIHByb2JlLlxuICovXG5jb25zdCBJR05PUkVfT1BFTl9QUlNfTEFCRUwgPSBcImlnbm9yZS1vcGVuLXByc1wiO1xuXG4vKipcbiAqIFRydWUgd2hlbiBhbiBvcGVuIFBSIGJsb2NrcyBgaXNzdWVgIHVuZGVyIHRoZSBzYW1lIG1pbGVzdG9uZS1hd2FyZSBydWxlIHRoZVxuICogUHJpb3JpdHkgMiBzY2FuIGFwcGxpZXMgKElzc3VlICM0MjIzKS5cbiAqXG4gKiBgcHVzaENhcGFibGVBdXRob3JzYCBpcyB0aGUgZmxlZXQgaWRlbnRpdHksIHNvIGEgaHVtYW4ncyBvcGVuIFBSIG5ldmVyXG4gKiBkZWZlcnMgYW4gaXNzdWUgKElzc3VlICM0MTMzKSDigJQgdGhlIHNhbWUgcnVsZSB0aGUgc2NhbiBhcHBsaWVzLiBQYXNzaW5nIGFuXG4gKiBlbXB0eSBzZXQsIG9yIFBScyB3aG9zZSBhdXRob3Igd2FzIG5ldmVyIHN0YW1wZWQgKHRoZSBzaGFyZWRcbiAqIGBwcnNfb3Blbl9hbGxgIGNhY2hlIGRvZXMgbm90IGNhcnJ5IG9uZSksIGNsYXNzaWZpZXMgbm90aGluZyBhcyBodW1hbiBhbmRcbiAqIGxlYXZlcyBldmVyeSBvcGVuIFBSIGJsb2NraW5nOiB0aGUgZmFpbC1zYWZlIGBpc0h1bWFuQXV0aG9yZWRQcmAgZG9jdW1lbnRzLFxuICogYW5kIHdoYXQgdGhlIGF1ZGl0IGRpZCBiZWZvcmUgSXNzdWUgIzEwNTAgZ2F2ZSBjYWxsZXJzIGEgc2V0IHRvIHBhc3MuXG4gKi9cbmZ1bmN0aW9uIGlzUHJCbG9ja2VkKFxuICBpc3N1ZTogeyBsYWJlbHM6IHN0cmluZ1tdOyBtaWxlc3RvbmU6IHN0cmluZyB9LFxuICBvcGVuUFJzOiByZWFkb25seSBPcGVuUFJbXSxcbiAgcHVzaENhcGFibGVBdXRob3JzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgZmxlZXRQclNsb3RzOiBudW1iZXIgfCB1bmRlZmluZWQsXG4pOiBib29sZWFuIHtcbiAgaWYgKGlzc3VlLmxhYmVscy5pbmNsdWRlcyhJR05PUkVfT1BFTl9QUlNfTEFCRUwpKSByZXR1cm4gZmFsc2U7XG4gIC8vIElzc3VlICMyNjYzOiB0aGUgc2FtZSBwZXItcmVwbyBzbG90IGNhcCB0aGUgc2NhbiBhcHBsaWVzIHRvIHRoZVxuICAvLyBkZWZhdWx0LWJyYW5jaCBzdHJlYW07IGBmZXRjaEFsbE9wZW5QUnNgIHJvd3MgY2FycnkgYGF1dGhvckxvZ2luYCwgd2hpY2hcbiAgLy8gdGhlIGdhdGUgY2xhc3NpZmllcyBvbiwgc28gYSBodW1hbidzIFBSIG5ldmVyIGNvdW50cyBoZXJlIGVpdGhlci5cbiAgcmV0dXJuIGdldEJsb2NraW5nUFJGb3JJc3N1ZShcbiAgICBbLi4ub3BlblBSc10sXG4gICAgaXNzdWUubWlsZXN0b25lLFxuICAgIHB1c2hDYXBhYmxlQXV0aG9ycyxcbiAgICBmbGVldFByU2xvdHMsXG4gICkgIT09IG51bGw7XG59XG5cbi8qKlxuICogVHJ1ZSB3aGVuIGEgKiptZXJnZWQqKiBmbGVldCBQUiBuYW1lcyBgaXNzdWVgIChHUlEjNDQxOSkuXG4gKlxuICogU2luY2UgSXNzdWUgIzMxNTEgdGhhdCBibG9jayBpcyBwZXJtYW5lbnQg4oCUIHRoZSBQcmlvcml0eSAyIHNjYW4gcmVmdXNlcyB0aGVcbiAqIGlzc3VlIGFzIGBtZXJnZWQtcHItcGVybWFuZW50YCBvbiBldmVyeSBjeWNsZSB1bnRpbCBhIHRydXN0ZWQgYXV0aG9yXG4gKiByZS1hcHBsaWVzIHRoZSBwaWNrdXAgbGFiZWwgd2l0aCBhIGRhdGUgYWZ0ZXIgdGhlIG1lcmdlLiBUaGUgYXVkaXQgZGlkIG5vdFxuICogbW9kZWwgaXQsIHNvIGEgcGVybWFuZW50bHkgc3RyYW5kZWQgaXNzdWUga2VwdCB0aGUgYG1pc19jbGFzc2lmaWNhdGlvbmBcbiAqIEFMRVJUIGZpcmluZyBmb3IgZXZlciBhZ2FpbnN0IGEgc2NhbiB0aGF0IHdhcyByaWdodC5cbiAqXG4gKiBDbG9zZWQtdW5tZXJnZWQgZW50cmllcyBhcmUgZmlsdGVyZWQgb3V0OiB0aGVpciBibG9jayBpcyBjb29sZG93bi13aW5kb3dlZFxuICogYW5kIHNlbGYtY2xlYXJpbmcuIFRoZSByZS1sYWJlbCBlc2NhcGUgaGF0Y2ggaXMgbm90IG1vZGVsbGVkIGVpdGhlciDigJQgaXRcbiAqIG5lZWRzIGEgcGVyLWlzc3VlIHRpbWVsaW5lIGNhbGwgdGhpcyBjaGVhcCBwcm9iZSBtdXN0IG5vdCBtYWtlIOKAlCBzbyB0aGVcbiAqIGdhdGUgdW5kZXItY291bnRzIHJhdGhlciB0aGFuIGludmVudGluZyBjbGFpbWFibGUgd29yay5cbiAqL1xuZnVuY3Rpb24gaXNNZXJnZWRQckJsb2NrZWQoXG4gIGlzc3VlOiB7IG51bWJlcjogbnVtYmVyIH0sXG4gIG1lcmdlZFBSczogcmVhZG9ubHkgQ2xvc2VkUFJbXSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBtZXJnZWQgPSBtZXJnZWRQUnMuZmlsdGVyKChwcikgPT4gcHIubWVyZ2VkID09PSB0cnVlKTtcbiAgcmV0dXJuIGlzQmxvY2tlZEJ5UmVjZW50bHlDbG9zZWRQUihtZXJnZWQsIGlzc3VlLm51bWJlcikgIT09IG51bGw7XG59XG5cbi8qKlxuICogUHJvYmUgdmVyZGljdCBmb3IgYSBzaW5nbGUgaXNzdWUuIGBjbGFpbWFibGU9dHJ1ZWAgbWVhbnMgZXZlcnkgZ2F0ZVxuICogaW4ge0BsaW5rIGF1ZGl0Q2xhaW1hYmxlU3RhdGV9J3MgZG9jc3RyaW5nIHBhc3Nlcy4gYGV4Y2x1ZGVkQnlgIGlzXG4gKiBwb3B1bGF0ZWQgb25seSB3aGVuIGBjbGFpbWFibGU9ZmFsc2VgLlxuICovXG5leHBvcnQgdHlwZSBJc3N1ZUV4Y2x1c2lvblJlYXNvbiA9XG4gIHwgXCJsYWJlbF9maWx0ZXJcIlxuICB8IFwiYXNzaWduZWVfZmlsdGVyXCJcbiAgLyoqIFByaW9yaXR5IGxhYmVsIGFkZGVkIGJ5IGFuIGF1dGhvciB0aGUgY2xhaW0gc2NhbiBkb2VzIG5vdCB0cnVzdCAoIzQyMTIpLiAqL1xuICB8IFwibGFiZWxfYXV0aG9yX25vdF9hbGxvd2VkXCJcbiAgfCBcImJsb2NraW5nX2xhYmVsXCJcbiAgLyoqIEEgbWlsZXN0b25lLXRyYWNraW5nIGlzc3VlIGBmaWx0ZXJBbmRTb3J0YCBkcm9wcyAoSXNzdWUgIzEwNTApLiAqL1xuICB8IFwibWlsZXN0b25lX3RyYWNrZXJcIlxuICB8IFwic3RyZWFtX29jY3VwaWVkXCJcbiAgfCBcInByX2Jsb2NrZWRcIlxuICAvKiogTmFtZWQgYnkgYSBtZXJnZWQgZmxlZXQgUFIg4oCUIGEgcGVybWFuZW50IHNraXAgKEdSUSM0NDE5KS4gKi9cbiAgfCBcIm1lcmdlZF9wcl9ibG9ja2VkXCJcbiAgLyoqIE5hbWVzIGFuIG9wZW4gZGVwZW5kZW5jeSB0aGUgc2NhbiByZWZ1c2VzIGl0IGZvciAoIzQ2MCwgR1JRIzQ0NjUpLiAqL1xuICB8IFwiZGVwZW5kZW5jeV9ibG9ja2VkXCJcbiAgLyoqIEEgZnV0dXJlIGBEZWZlcnJlZCB1bnRpbGAgbGluZSBpbiB0aGUgd29ya2VyIHJlY29yZCBibG9jayAoIzI4NzMpLiAqL1xuICB8IFwidGltZV9kZWZlcnJlZFwiXG4gIC8qKiBIZWxkIGJhY2sgYnkgdGhpcyBydW4ncyBvd24gY29vbGRvd24gLyBwcm9jZXNzZWQtaXNzdWUgcmVnaXN0cnkgKCM2NTUpLiAqL1xuICB8IFwicnVuX2xvY2FsX2hvbGRcIlxuICAvKipcbiAgICogSW4gYSB0aWVyIHRoZSB3ZWVrLXBhY2UgZ3VhcmQgZHJvcHBlZCBmcm9tIHRoZSBsYWRkZXIgKElzc3VlcyAjMTg4NSxcbiAgICogIzE5MTUpIOKAlCBgbG93LXByaW9yaXR5YCBvciBgaWRsZS10YXNrYCwgZm9yIHRoZSByZXN0IG9mIHRoZSB3ZWVrLlxuICAgKi9cbiAgfCBcInBhY2Vfc3VwcHJlc3NlZFwiXG4gIC8qKlxuICAgKiBJZGxlLXRhc2stb25seSB3b3JrIHRoZSBxdW90YSBwb2xsaW5nIGdhdGUgZGVmZXJyZWQgZm9yIHRoZSBjeWNsZVxuICAgKiAoSXNzdWUgIzM2MjgpIOKAlCB0aGUgaWRsZSBjb2xsZWN0b3IgbmV2ZXIgcmFuIHdoaWxlIHRoZSBHcmFwaFFMIHF1b3RhXG4gICAqIHdhcyBiZWxvdyB0aGUgaWRsZSBmbG9vci5cbiAgICovXG4gIHwgXCJxdW90YV9pZGxlX2RlZmVycmVkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSXNzdWVWZXJkaWN0IHtcbiAgbnVtYmVyOiBudW1iZXI7XG4gIGNsYWltYWJsZTogYm9vbGVhbjtcbiAgZXhjbHVkZWRCeT86IElzc3VlRXhjbHVzaW9uUmVhc29uO1xuICBtaWxlc3RvbmU6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDbGFzc2lmeU9wdGlvbnMge1xuICB3b3JrZXJVc2VyOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgYWNjb3VudHMgdGhlIGZsZWV0IG9wZXJhdGVzIGJlc2lkZSBgd29ya2VyVXNlcmAsIGFzXG4gICAqIGByZXNvbHZlRmxlZXRNYWludGVuYW5jZUF1dGhvclNldGAgcmVzb2x2ZXMgdGhlbSDigJQgdGhlIGhvc3QgbG9naW4sXG4gICAqIGBmbGVldF9wcl9hdXRob3JzYCBhbmQgYHNlcnZpY2VfYWNjb3VudHNgIChJc3N1ZSAjMTA1MCkuXG4gICAqXG4gICAqIGBpc01pbGVzdG9uZU9jY3VwaWVkYCB0cmVhdHMgYSB3b3JrIHN0cmVhbSBhcyBvY2N1cGllZCB3aGVuIGFuIGlzc3VlIGluXG4gICAqIGl0IGlzIGFzc2lnbmVkIHRvIEFOWSBvZiB0aG9zZSBhY2NvdW50cywgbm90IGp1c3QgdGhpcyB3b3JrZXIncyBvd25cbiAgICogbG9naW4sIGFuZCB0aGUgYXVkaXQgbm93IGNhbGxzIHRoYXQgdmVyeSBmdW5jdGlvbi4gV2l0aG91dCB0aGUgc2FtZSBzZXRcbiAgICogaGVyZSwgYW4gaXNzdWUgYSAqc2libGluZyogd29ya2VyIGhvbGRzIHJlYWQgYXMgY2xhaW1hYmxlIHRvIHRoZSBhdWRpdFxuICAgKiBhbmQgYXMgYG1pbGVzdG9uZS1vY2N1cGllZGAgdG8gdGhlIHNjYW4g4oCUIHRoZSBkaXZlcmdlbmNlIHRoYXQgc3VwcHJlc3NlZFxuICAgKiBpZGxlLXRhc2sgZmlsaW5nIGZsZWV0LXdpZGUgZm9yIHRlbiBkYXlzLlxuICAgKlxuICAgKiBORVZFUiBgY29uZmlnLmFsbG93ZWRBdXRob3JzYCAoSXNzdWUgIzEwNjQpOiB0aGF0IGlzIGEgcGVybWlzc2lvbiBsaXN0XG4gICAqIGFuZCBsZWdpdGltYXRlbHkgaG9sZHMgaHVtYW5zLCBhbmQgdGhlcmUgaXMgbm8gc2NoZWR1bGluZyBiZXR3ZWVuIGh1bWFuc1xuICAgKiBhbmQgVmliZSBDb2RlcnMg4oCUIGEgaHVtYW4ncyBhc3NpZ25tZW50IG11c3QgbmV2ZXIgcGFyayBhIHdvcmsgc3RyZWFtLlxuICAgKlxuICAgKiBPbWl0dGVkIOKGkiB0aGlzIHdvcmtlciBhbG9uZSwgd2hpY2ggaXMgd2hhdCB0aGUgYXVkaXQgY291bnRlZCBiZWZvcmUgYW5kXG4gICAqIHdoYXQgbWFkZSBhIHNpYmxpbmcncyBhc3NpZ25tZW50IGxvb2sgbGlrZSBjbGFpbWFibGUgd29yay5cbiAgICovXG4gIHB1c2hDYXBhYmxlQXV0aG9ycz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKipcbiAgICogVGhlIGRpc2NvdmVyeSBsYWJlbHMgdGhhdCBtYWtlIGFuIGlzc3VlIGEgY2FuZGlkYXRlLiBEZWZhdWx0cyB0b1xuICAgKiB7QGxpbmsgQ0xBSU1BQkxFX0xBQkVMU30uXG4gICAqXG4gICAqIFRoZSBmbGVldC1nbG9iYWwgZXhpc3RlbmNlIGdhdGUgYXNrcyB0aGUgbmFycm93ZXJcbiAgICogYFJFQUxfV09SS19MQUJFTFNgIHF1ZXN0aW9uIOKAlCBcImlzIHRoZXJlIGdlbnVpbmUgd29yayBhbnl3aGVyZT9cIiwgd2l0aFxuICAgKiBgaWRsZS10YXNrYCBleGNsdWRlZCBiZWNhdXNlIGFuIG9wZW4gd3JhcHBlciBpcyBhbHJlYWR5IGNhdWdodCBieSB0aGVcbiAgICogY3Jvc3MtcmVwbyBkZWR1cCDigJQgYW5kIHJlYWRzIGl0cyBhbnN3ZXIgZnJvbSB0aGlzIHNhbWUgY2xhc3NpZmllciBzb1xuICAgKiB0aGUgdHdvIGNhbm5vdCBkcmlmdCAoSXNzdWUgIzEwNTApLlxuICAgKi9cbiAgY2xhaW1hYmxlTGFiZWxzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKlxuICAgKiBUaGUgcmVwbydzIG9wZW4gUFJzLCBzbyB0aGUgY2xhc3NpZmllciBjYW4gYXBwbHkgdGhlIHNjYW4nc1xuICAgKiBtaWxlc3RvbmUtYXdhcmUgYmxvY2tpbmcgcnVsZSAoSXNzdWUgIzQyMjMpLlxuICAgKlxuICAgKiBPbWl0dGVkIG9yIGVtcHR5IG1lYW5zIFwibm8gUFIgZGF0YVwiIGFuZCBubyBpc3N1ZSBpcyBleGNsdWRlZCBieSB0aGlzXG4gICAqIGdhdGUg4oCUIHRoZSBzYW1lIGZhaWwtc2FmZSB0aGUgY2Vuc3VzIHRha2VzIChJc3N1ZSAjMzUyNik6IHVuZGVyLWNvdW50aW5nXG4gICAqIGJsb2NrZXJzIG1lcmVseSBhbGVydHMgb24gd29yayB0aGF0IHdpbGwgbm90IGJlIGNsYWltZWQsIHdoZXJlYXNcbiAgICogaW52ZW50aW5nIGJsb2NrZXJzIHdvdWxkIGhpZGUgdGhlIG1pcy1jbGFzc2lmaWNhdGlvbiB0aGlzIGF1ZGl0IGV4aXN0c1xuICAgKiB0byBjYXRjaC5cbiAgICovXG4gIG9wZW5QUnM/OiByZWFkb25seSBPcGVuUFJbXTtcbiAgLyoqXG4gICAqIFRoZSByZXBvJ3MgZmxlZXQgUFIgY2FwIG9uIHRoZSBkZWZhdWx0LWJyYW5jaCBzdHJlYW0gKElzc3VlICMyNjYzLFxuICAgKiBgcmVzb2x2ZUZsZWV0UHJTbG90c2ApIOKAlCB0aGUgdmFsdWUgdGhlIHNjYW4gcGFzc2VzIHRvXG4gICAqIGBnZXRCbG9ja2luZ1BSRm9ySXNzdWVgLiBPbWl0dGVkIOKGkiBgREVGQVVMVF9GTEVFVF9QUl9TTE9UU2AuXG4gICAqL1xuICBmbGVldFByU2xvdHM/OiBudW1iZXI7XG4gIC8qKlxuICAgKiBUaGUgcmVwbydzIGNsb3NlZC9tZXJnZWQgZmxlZXQgUFJzLCBzbyB0aGUgY2xhc3NpZmllciBjYW4gYXBwbHkgdGhlXG4gICAqIHNjYW4ncyBwZXJtYW5lbnQgYG1lcmdlZC1wci1wZXJtYW5lbnRgIGdhdGUgKEdSUSM0NDE5KS4gT25seSBlbnRyaWVzXG4gICAqIHdpdGggYG1lcmdlZDogdHJ1ZWAgYXJlIGhvbm91cmVkLiBPbWl0dGVkIG9yIGVtcHR5IG1lYW5zIFwibm8gZGF0YVwiIGFuZFxuICAgKiBubyBpc3N1ZSBpcyBleGNsdWRlZCBieSB0aGlzIGdhdGUg4oCUIHRoZSBzYW1lIGZhaWwtc2FmZSBhcyBgb3BlblBSc2AuXG4gICAqL1xuICBtZXJnZWRQUnM/OiByZWFkb25seSBDbG9zZWRQUltdO1xuICAvKipcbiAgICogSXNzdWUgbnVtYmVycyB0aGlzIHJ1biBpcyBob2xkaW5nIGJhY2sgd2hhdGV2ZXIgR2l0SHViIHNheXMgKElzc3VlXG4gICAqICM2NTUpIOKAlCB0aGUgc2V0IGBmaW5kX29sZGVzdF9pc3N1ZS50c2AgZmlsdGVycyBldmVyeSB0aWVyJ3MgY2FuZGlkYXRlc1xuICAgKiBhZ2FpbnN0IG9uY2UgdGhlIGNvbGxlY3RvcnMgaGF2ZSBwYXNzZWQgdGhlbS5cbiAgICpcbiAgICogT21pdHRlZCBvciBlbXB0eSBtZWFucyBcIm5vIGRhdGFcIiBhbmQgbm8gaXNzdWUgaXMgZXhjbHVkZWQgYnkgdGhpcyBnYXRlLFxuICAgKiB0aGUgc2FtZSBmYWlsLXNhZmUgYXMgYG9wZW5QUnNgOiB1bmRlci1jb3VudGluZyBibG9ja2VycyBtZXJlbHkgYWxlcnRzXG4gICAqIG9uIHdvcmsgdGhhdCB3aWxsIG5vdCBiZSBjbGFpbWVkLCB3aGVyZWFzIGludmVudGluZyB0aGVtIHdvdWxkIGhpZGUgdGhlXG4gICAqIG1pcy1jbGFzc2lmaWNhdGlvbiB0aGlzIGF1ZGl0IGV4aXN0cyB0byBjYXRjaC5cbiAgICovXG4gIHJ1bkxvY2FsSG9sZHM/OiBSZWFkb25seVNldDxudW1iZXI+O1xuICAvKipcbiAgICogSXNzdWUgIzg1NzogdGhlIHJlcG8ncyBvd24gb3Blbi1pc3N1ZSBudW1iZXJzLCBzbyB0aGUgY2xhc3NpZmllciBjYW5cbiAgICogbW9kZWwgdGhlIHNjYW4ncyBgZGVwZW5kZW5jeS1ibG9ja2VkYCBnYXRlIChJc3N1ZSAjNDYwLCBHUlEjNDQ2NSkgdGhlXG4gICAqIHdheSBgaWRsZV9kZWNpc2lvbl9jZW5zdXMudHNgIGFscmVhZHkgZG9lcyDigJQgcmVzb2x2ZWQgZnJvbSBkYXRhIHRoZVxuICAgKiBjYWxsZXIgaG9sZHMsIHNvIGl0IGNvc3RzIG5vIGV4dHJhIGBnaGAgY2FsbC5cbiAgICpcbiAgICogUmVxdWlyZXMgYHJlcG9gIGFuZCB0aGUgaXNzdWVzJyBgYm9keWAuIE9taXR0ZWQgb3IgZW1wdHkgbWVhbnMgXCJubyBkYXRhXCJcbiAgICogYW5kIG5vIGlzc3VlIGlzIGV4Y2x1ZGVkIGJ5IHRoaXMgZ2F0ZSwgdGhlIHNhbWUgZmFpbC1zYWZlIGFzIGBvcGVuUFJzYC5cbiAgICovXG4gIG9wZW5Jc3N1ZU51bWJlcnM/OiBSZWFkb25seVNldDxudW1iZXI+O1xuICAvKiogUmVwbyB0aGUgaXNzdWVzIGJlbG9uZyB0bywgZm9yIHJlc29sdmluZyBzYW1lLXJlcG8gZGVwZW5kZW5jeSByZWZzLiAqL1xuICByZXBvPzogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIHJlcG9zaXRvcmllcyB0aGlzIGZsZWV0IG1vbml0b3JzLCBsb3dlci1jYXNlZCAoSXNzdWUgIzEyNDksXG4gICAqIGZpbmRpbmcgMTEpLiBBIGNyb3NzLXJlcG8gYERlcGVuZHMgb24gb3duZXIvcmVwbyNOYCBibG9ja3Mgb25seSB3aGVuIGl0XG4gICAqIG5hbWVzIG9uZSBvZiB0aGVtOyBvbWl0dGVkIG9yIGVtcHR5IGtlZXBzIHRoZSBwcmV2aW91cyBiZWhhdmlvdXIsIHdoZXJlXG4gICAqIGV2ZXJ5IGNyb3NzLXJlcG8gcmVmZXJlbmNlIGJsb2Nrcy5cbiAgICovXG4gIGtub3duUmVwb3M/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHdlZWtseS1xdW90YSBwYWNlIGd1YXJkIGlzIGVuZ2FnZWQgZm9yIHRoaXMgc2NhbiAoSXNzdWVzXG4gICAqICMxODg1LCAjMTkxNSkuXG4gICAqXG4gICAqIEVuZ2FnZWQsIGBzZWxlY3RIaWdoZXN0UHJpb3JpdHlgIGRyb3BzIHRpZXJzIDMgYW5kIDQg4oCUIGBsb3ctcHJpb3JpdHlgXG4gICAqIGFuZCBgaWRsZS10YXNrYCDigJQgZnJvbSB0aGUgbGFkZGVyIGVudGlyZWx5LCBzbyBhbiBpc3N1ZSB3aG9zZSBvbmx5XG4gICAqIGRpc2NvdmVyeSBsYWJlbCBpcyBvbmUgb2YgdGhvc2UgY2Fubm90IGJlIGNsYWltZWQgdW50aWwgdGhlIHdpbmRvd1xuICAgKiByZXNldHMuIFRoZSBhdWRpdCBkaWQgbm90IG1vZGVsIHRoYXQgZ2F0ZTogb24gR1JRLTI1IGl0IGNvdW50ZWQgODdcbiAgICogcGFjZS1zdXBwcmVzc2VkIGBsb3ctcHJpb3JpdHlgIGlzc3VlcyBhcyBjbGFpbWFibGUsIHNvIGBtaXNfY2xhc3NpZmljYXRpb25gXG4gICAqIGZpcmVkIGFnYWluc3QgYSBzY2FuIHRoYXQgd2FzIHJpZ2h0IGFuZCB0aGUgY2xhaW1hYmxlIHRvdGFsIGRyb3ZlIHRoZVxuICAgKiBpZGxlLWhvb2tzIGRpc2FncmVlbWVudCBib3VuZC5cbiAgICpcbiAgICogT21pdHRlZCDihpIgb2ZmLCB3aGljaCBpcyB0aGUgYmVoYXZpb3VyIGV2ZXJ5IGNhbGxlciBoYWQgYmVmb3JlIHRoaXNcbiAgICogb3B0aW9uIGV4aXN0ZWQuXG4gICAqL1xuICB3ZWVrUGFjZUVuZ2FnZWQ/OiBib29sZWFuO1xuICAvKipcbiAgICogV2hldGhlciB0aGUgc2NhbiBkZWZlcnJlZCB0aGUgaWRsZS10YXNrIHRpZXIgZm9yIEdyYXBoUUwgcXVvdGEgKElzc3VlXG4gICAqICMzNjI4KS5cbiAgICpcbiAgICogRGVmZXJyZWQsIHRoZSBzY2FuJ3MgaWRsZS10YXNrIGNvbGxlY3RvciBuZXZlciByYW4sIHNvIGFuIGlzc3VlIHdob3NlXG4gICAqIG9ubHkgZGlzY292ZXJ5IGxhYmVsIGlzIGBpZGxlLXRhc2tgIGlzIHJlZnVzZWQgYnkgYSBydWxlIHRoZSBmbGVldFxuICAgKiBhcHBsaWVkIGRlbGliZXJhdGVseSDigJQgZXhhY3RseSB0aGUgcGFjZS1nYXRlIHNoYXBlIGFib3ZlLiBBbiBpc3N1ZSB0aGF0XG4gICAqIGFsc28gY2FycmllcyBhIGhpZ2hlciBkaXNjb3ZlcnkgbGFiZWwgc3RheXMgY2xhaW1hYmxlLCBiZWNhdXNlIGl0c1xuICAgKiBjb2xsZWN0b3Igc3RpbGwgcmFuLlxuICAgKlxuICAgKiBPbWl0dGVkIOKGkiBvZmYsIHdoaWNoIGlzIHRoZSBiZWhhdmlvdXIgZXZlcnkgY2FsbGVyIGhhZCBiZWZvcmUgdGhpc1xuICAgKiBvcHRpb24gZXhpc3RlZC5cbiAgICovXG4gIHF1b3RhSWRsZURlZmVycmVkPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIElzc3VlICMyNTMzOiB0aGUgcmVwbydzIG93biAqKm9wZW4qKiBtaWxlc3RvbmUgdGl0bGVzLCBzbyB0aGUgY2xhc3NpZmllciAgICogY2FuIG1vZGVsIHRoZSBjcm9zcy1taWxlc3RvbmUgZGVwZW5kZW5jeSBob2xkIChgaXNEZXBlbmRlbmN5QmxvY2tlZGAsXG4gICAqIElzc3VlICMyMTczKSB0aGUgd2F5IGBpZGxlX2RlY2lzaW9uX2NlbnN1cy50c2AgYWxyZWFkeSBkb2VzIChJc3N1ZSAjMjQ1NSkuXG4gICAqXG4gICAqIEEgZGVwZW5kZW5jeSB0aGF0IGlzIGNsb3NlZCBidXQgc2l0cyBpbiBhbm90aGVyIHN0aWxsLW9wZW4gbWlsZXN0b25lIG9mXG4gICAqIHRoZSBzYW1lIHJlcG8gaXMgaGVsZCB1bnRpbCB0aGF0IG1pbGVzdG9uZSBtZXJnZXMuIFRoZSBhdWRpdCBkaWQgbm90IG1vZGVsXG4gICAqIHRoYXQgaG9sZDogR1JRLUF1dG9UcmFkZXIgIzczOC8jNzM5IChkZXBlbmRlbmNpZXMgIzcyNi8jNzIzLCBjbG9zZWQgaW5zaWRlXG4gICAqIG9wZW4gbWlsZXN0b25lIDMyKSB3ZXJlIGNvdW50ZWQgY2xhaW1hYmxlLCBzbyBgbWlzX2NsYXNzaWZpY2F0aW9uYCBmaXJlZFxuICAgKiBhZ2FpbnN0IGEgc2NhbiB0aGF0IHdhcyByaWdodC5cbiAgICpcbiAgICogT21pdHRlZCBvciBlbXB0eSBtZWFucyBcIm5vIGRhdGFcIiBhbmQgbm8gaXNzdWUgaXMgZXhjbHVkZWQgYnkgdGhpcyBob2xkIOKAlFxuICAgKiB0aGUgc2FtZSBmYWlsLXNhZmUgYXMgYG9wZW5QUnNgLlxuICAgKi9cbiAgb3Blbk1pbGVzdG9uZXM/OiBSZWFkb25seVNldDxzdHJpbmc+O1xuICAvKipcbiAgICogSXNzdWUgbnVtYmVycyB3aG9zZSBwcmlvcml0eSBsYWJlbCBhbiB1bnRydXN0ZWQgYXV0aG9yIGFkZGVkIChJc3N1ZVxuICAgKiAjNDIxMikuIFRoZSBjbGFpbSBzY2FuIHJlZnVzZXMgdGhvc2UgYXMgYGxhYmVsLWF1dGhvci1ub3QtYWxsb3dlZGAuXG4gICAqXG4gICAqIE9taXR0ZWQgb3IgZW1wdHkgbWVhbnMgXCJubyBkYXRhXCIgYW5kIG5vIGlzc3VlIGlzIGV4Y2x1ZGVkIGJ5IHRoaXMgZ2F0ZSxcbiAgICogdGhlIHNhbWUgZmFpbC1zYWZlIGFzIGBvcGVuUFJzYDogdW5kZXItY291bnRpbmcgdGhlIHJlZnVzYWwgbWVyZWx5XG4gICAqIGFsZXJ0cyBvbiB3b3JrIHRoYXQgd2lsbCBub3QgYmUgY2xhaW1lZCwgd2hlcmVhcyBpbnZlbnRpbmcgaXQgd291bGRcbiAgICogaGlkZSB0aGUgbWlzLWNsYXNzaWZpY2F0aW9uIHRoaXMgYXVkaXQgZXhpc3RzIHRvIGNhdGNoLlxuICAgKi9cbiAgdW50cnVzdGVkTGFiZWxJc3N1ZXM/OiBSZWFkb25seVNldDxudW1iZXI+O1xufVxuXG4vKipcbiAqIFRydWUgd2hlbiBgaXNzdWVgIG5hbWVzIGFuIG9wZW4gZGVwZW5kZW5jeSB0aGUgUHJpb3JpdHkgMiBzY2FuIHJlZnVzZXMgaXRcbiAqIGZvciAoSXNzdWUgIzQ2MCwgR1JRIzQ0NjUpLlxuICpcbiAqIE1pcnJvcnMgYGlzRGVwZW5kZW5jeUJsb2NrZWRCeU9wZW5Jc3N1ZWAgaW4gYGlkbGVfZGVjaXNpb25fY2Vuc3VzLnRzYDogYVxuICogc2FtZS1yZXBvIGAjTmAgYWJzZW50IGZyb20gdGhlIG9wZW4gc2V0IGlzIGNsb3NlZCBhbmQgZG9lcyBub3QgYmxvY2ssIGFuZCBhXG4gKiBjcm9zcy1yZXBvIHJlZmVyZW5jZSBjYW5ub3QgYmUgcmVzb2x2ZWQgZnJvbSB0aGlzIHJlcG8ncyBpc3N1ZXMsIHNvIGl0XG4gKiBjb3VudHMgYXMgYmxvY2tpbmcg4oCUIHRoZSBzY2FuIGZhaWxzIHNhZmUgdGhlIHNhbWUgd2F5LiBQYXJlbnQvY2hpbGRcbiAqIGJsb2NraW5nJ3MgbmF0aXZlIHN1Yi1pc3N1ZSBoYWxmIGlzIGhhbmRsZWQgc2VwYXJhdGVseSwgYnlcbiAqIGBoYXNPcGVuU3ViSXNzdWVzYCBvbiBgc3ViSXNzdWVzU3VtbWFyeWAgZnJvbSB0aGUgc2FtZSBgZ2ggaXNzdWUgbGlzdGAgY2FsbFxuICogKElzc3VlICMzMzE0KS4gSXRzIGJvZHkgdGFzay1saXN0IGhhbGYgaXMgc3RpbGwgbm90IG1vZGVsbGVkIGhlcmU6IGl0XG4gKiB3b3VsZCBuZWVkIGEgcGVyLWlzc3VlIEFQSSBjYWxsLCBhbmQgb21pdHRpbmcgaXQgdW5kZXItY291bnRzLCB3aGljaCBtZXJlbHlcbiAqIGFsZXJ0cyBvbiB3b3JrIHRoYXQgd2lsbCBub3QgYmUgY2xhaW1lZCByYXRoZXIgdGhhbiBpbnZlbnRpbmcgYSBibG9ja2VyLlxuICpcbiAqIGBrbm93blJlcG9zYCBib3VuZHMgdGhhdCB1bnJlc29sdmFibGUgY2FzZSAoSXNzdWUgIzEyNDksIGZpbmRpbmcgMTEpLiBBblxuICogaXNzdWUgYm9keSBpcyB0ZXh0IGFueWJvZHkgd2hvIGNhbiBvcGVuIGFuIGlzc3VlIHdyaXRlcywgc29cbiAqIGBEZXBlbmRzIG9uIGF0dGFja2VyL3JlcG8jMWAgd2FzIGFuIHVuY29uZGl0aW9uYWwsIHVuZmFsc2lmaWFibGUgY2xhaW0gdGhhdFxuICogdGhpcyBpc3N1ZSBpcyBibG9ja2VkIOKAlCBvbmUgbGluZSB0aGF0IHJlbW92ZWQgaXQgZnJvbSB0aGUgYXVkaXQnc1xuICogYGNsYWltYWJsZWAgY291bnQgYW5kLCB3aXRoIGl0LCB0aGUgaWRsZS1pbnZlcnNpb24gYWxlcnQgdGhlIGNvdW50IGV4aXN0c1xuICogdG8gcmFpc2UuIE9ubHkgYSByZWZlcmVuY2UgaW50byBhICoqbW9uaXRvcmVkKiogcmVwb3NpdG9yeSBpcyBob25vdXJlZCBub3c6XG4gKiB0aGF0IGlzIHRoZSBmb3JtIHRoZSBibG9ja2VkLXJ1biBkZWZlcnJhbCB3cml0ZXMsIHNvIHRoZSBsZWdpdGltYXRlIGNhc2UgaXNcbiAqIHVuY2hhbmdlZCwgd2hpbGUgYSByZWZlcmVuY2UgdG8gYSByZXBvc2l0b3J5IHRoZSBmbGVldCBkb2VzIG5vdCB3b3JrIGluXG4gKiBjYW5ub3Qgc2lsZW5jZSB0aGUgYXVkaXQuIFdoZW4gYGtub3duUmVwb3NgIGlzIGVtcHR5IHRoZSBjYWxsZXIgaGFzIG5vXG4gKiByZXBvc2l0b3J5IGxpc3QgdG8gY2hlY2sgYWdhaW5zdCBhbmQgZXZlcnkgY3Jvc3MtcmVwbyByZWZlcmVuY2UgYmxvY2tzLCBhc1xuICogYmVmb3JlLlxuICpcbiAqIGBvcGVuTWlsZXN0b25lc2AgbW9kZWxzIHRoZSBjcm9zcy1taWxlc3RvbmUgaG9sZCAoSXNzdWUgIzI1MzMsIG1pcnJvcmluZyB0aGVcbiAqIGNlbnN1cydzIElzc3VlICMyNDU1IHBhcmFtZXRlcik6IGEgc2FtZS1yZXBvIGRlcGVuZGVuY3kgdGhhdCBpcyAqY2xvc2VkKlxuICogc3RpbGwgaG9sZHMgdGhpcyBpc3N1ZSB3aGlsZSBhbnkgKipvdGhlcioqIG1pbGVzdG9uZSBvZiB0aGUgcmVwbyBpcyBvcGVuLFxuICogYmVjYXVzZSBgaXNEZXBlbmRlbmN5QmxvY2tlZGAgKElzc3VlICMyMTczKSByZWZ1c2VzIGl0IHVudGlsIHRoYXQgbWlsZXN0b25lXG4gKiBtZXJnZXMuIEVtcHR5IG1lYW5zIFwibm8gZGF0YVwiIGFuZCBubyBob2xkIGlzIGFwcGxpZWQuXG4gKi9cbmZ1bmN0aW9uIGlzRGVwZW5kZW5jeUJsb2NrZWRCeU9wZW5Jc3N1ZShcbiAgYm9keTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICByZXBvOiBzdHJpbmcsXG4gIG9wZW5Jc3N1ZU51bWJlcnM6IFJlYWRvbmx5U2V0PG51bWJlcj4sXG4gIGtub3duUmVwb3M6IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4gIGNhbmRpZGF0ZU1pbGVzdG9uZTogc3RyaW5nLFxuICBvcGVuTWlsZXN0b25lczogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQ8c3RyaW5nPigpLFxuKTogYm9vbGVhbiB7XG4gIGlmIChib2R5ID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgcmVmcyA9IGV4dHJhY3REZXBlbmRlbmN5UmVmZXJlbmNlc0RldGFpbGVkKGJvZHkpO1xuICBjb25zdCBsb3dlclJlcG8gPSByZXBvLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAvLyBUaGUgY2FuZGlkYXRlJ3Mgb3duIG1pbGVzdG9uZSBpcyBuZXZlciBhIGNyb3NzLW1pbGVzdG9uZSBibG9ja2VyOiBhblxuICAvLyBpc3N1ZSBpcyBub3QgaGVsZCBieSB0aGUgbWlsZXN0b25lIGl0IGFscmVhZHkgc2l0cyBpbi5cbiAgLy8gU0lNUExFLU9OLVBVUlBPU0U6IHRoZSBjbG9zZWQgZGVwZW5kZW5jeSdzIG93biBtaWxlc3RvbmUgaXMgbm90IGZldGNoZWQsIHNvXG4gIC8vIHRoaXMgbW9kZWxzIHRoZSBob2xkJ3MgcHJlY29uZGl0aW9uIOKAlCBzb21lIG90aGVyIG1pbGVzdG9uZSBvZiB0aGUgcmVwbyBpc1xuICAvLyBvcGVuIOKAlCBleGFjdGx5IGFzIHRoZSBjZW5zdXMgZG9lcyAoSXNzdWUgIzI0NTUpLiBJdCBvdmVyLWhvbGRzIHRvd2FyZHNcbiAgLy8gXCJub3QgY2xhaW1hYmxlXCIsIHRoZSBkaXJlY3Rpb24gdGhhdCBjYW5ub3QgbWFudWZhY3R1cmUgYSBmYWxzZVxuICAvLyBgbWlzX2NsYXNzaWZpY2F0aW9uYCBBTEVSVCDigJQgdXBncmFkZSB3aGVuIHRoZSBhdWRpdCBhbHJlYWR5IGhhcyBlYWNoXG4gIC8vIGRlcGVuZGVuY3kncyBtaWxlc3RvbmUgdG8gaGFuZCB3aXRob3V0IGFuIGV4dHJhIEFQSSBjYWxsIHBlciB0aWNrLlxuICBjb25zdCBvdGhlck1pbGVzdG9uZU9wZW4gPSBbLi4ub3Blbk1pbGVzdG9uZXNdLnNvbWUoXG4gICAgKHRpdGxlKSA9PiB0aXRsZSAhPT0gY2FuZGlkYXRlTWlsZXN0b25lLFxuICApO1xuICByZXR1cm4gcmVmcy5zb21lKChyZWYpID0+IHtcbiAgICBjb25zdCByZWZSZXBvID0gcmVmLnJlcG8/LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnN0IHNhbWVSZXBvID0gcmVmUmVwbyA9PT0gdW5kZWZpbmVkIHx8IHJlZlJlcG8gPT09IGxvd2VyUmVwbztcbiAgICBpZiAoIXNhbWVSZXBvKSB7XG4gICAgICByZXR1cm4ga25vd25SZXBvcy5zaXplID09PSAwIHx8IGtub3duUmVwb3MuaGFzKHJlZlJlcG8pO1xuICAgIH1cbiAgICBpZiAob3Blbklzc3VlTnVtYmVycy5oYXMocmVmLm51bWJlcikpIHJldHVybiB0cnVlO1xuICAgIHJldHVybiBvdGhlck1pbGVzdG9uZU9wZW47XG4gIH0pO1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IGVhY2ggaXNzdWUgaW4gYGlzc3Vlc2AgYWdhaW5zdCB0aGUgc2FtZSBnYXRlcyB0aGVcbiAqIFByaW9yaXR5IDIgc2NhbiBhcHBsaWVzLiBUaGUgY2xhc3NpZmllciBpcyBwdXJlIHNvIHVuaXQgdGVzdHMgY2FuXG4gKiBkcml2ZSBldmVyeSBicmFuY2ggd2l0aG91dCBzdHViYmluZyBnaC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYXNzaWZ5SXNzdWVzKFxuICBpc3N1ZXM6IFJlYWRvbmx5QXJyYXk8e1xuICAgIG51bWJlcjogbnVtYmVyO1xuICAgIHRpdGxlPzogc3RyaW5nO1xuICAgIGxhYmVsczogc3RyaW5nW107XG4gICAgYXNzaWduZWVzOiBzdHJpbmdbXTtcbiAgICBtaWxlc3RvbmU6IHN0cmluZztcbiAgICAvKiogSXNzdWUgIzg1NzogYm9keSwgZm9yIHRoZSBkZXBlbmRlbmN5IGdhdGUuIEFic2VudCDihpIgbm90IGJsb2NrZWQuICovXG4gICAgYm9keT86IHN0cmluZztcbiAgICAvKiogR2l0SHViIG5hdGl2ZSBzdWItaXNzdWUgY291bnRzIChJc3N1ZSAjMzMxNCk7IGFic2VudCDihpIgbm90IGJsb2NrZWQuICovXG4gICAgc3ViSXNzdWVzU3VtbWFyeT86IHsgdG90YWw6IG51bWJlcjsgY29tcGxldGVkOiBudW1iZXIgfTtcbiAgfT4sXG4gIG9wdHM6IENsYXNzaWZ5T3B0aW9ucyxcbik6IElzc3VlVmVyZGljdFtdIHtcbiAgY29uc3QgY2xhaW1hYmxlU2V0ID0gbmV3IFNldChvcHRzLmNsYWltYWJsZUxhYmVscyA/PyBDTEFJTUFCTEVfTEFCRUxTKTtcbiAgY29uc3QgYmxvY2tpbmdTZXQgPSBuZXcgU2V0KEJMT0NLSU5HX0xBQkVMUyk7XG4gIGNvbnN0IHBhY2VFeGVtcHRTZXQgPSBuZXcgU2V0KFBBQ0VfRVhFTVBUX0xBQkVMUyk7XG4gIGNvbnN0IHdlZWtQYWNlRW5nYWdlZCA9IG9wdHMud2Vla1BhY2VFbmdhZ2VkID09PSB0cnVlO1xuICBjb25zdCBxdW90YUlkbGVEZWZlcnJlZCA9IG9wdHMucXVvdGFJZGxlRGVmZXJyZWQgPT09IHRydWU7XG4gIGNvbnN0IHVudHJ1c3RlZExhYmVsSXNzdWVzID0gb3B0cy51bnRydXN0ZWRMYWJlbElzc3VlcyA/PyBuZXcgU2V0PG51bWJlcj4oKTtcbiAgY29uc3Qgb3BlblBScyA9IG9wdHMub3BlblBScyA/PyBbXTtcbiAgY29uc3QgbWVyZ2VkUFJzID0gb3B0cy5tZXJnZWRQUnMgPz8gW107XG4gIGNvbnN0IHJ1bkxvY2FsSG9sZHMgPSBvcHRzLnJ1bkxvY2FsSG9sZHMgPz8gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IG9wZW5Jc3N1ZU51bWJlcnMgPSBvcHRzLm9wZW5Jc3N1ZU51bWJlcnMgPz8gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IG9wZW5NaWxlc3RvbmVzID0gb3B0cy5vcGVuTWlsZXN0b25lcyA/PyBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3Qga25vd25SZXBvcyA9IG5ldyBTZXQoXG4gICAgKG9wdHMua25vd25SZXBvcyA/PyBbXSlcbiAgICAgIC5maWx0ZXIoKHIpID0+IHR5cGVvZiByID09PSBcInN0cmluZ1wiICYmIHIudHJpbSgpLmxlbmd0aCA+IDApXG4gICAgICAubWFwKChyKSA9PiByLnRyaW0oKS50b0xvd2VyQ2FzZSgpKSxcbiAgKTtcbiAgY29uc3QgcmVwbyA9IG9wdHMucmVwbyA/PyBcIlwiO1xuICBjb25zdCBwdXNoQ2FwYWJsZUF1dGhvcnMgPSBvcHRzLnB1c2hDYXBhYmxlQXV0aG9ycyA/PyBbXTtcbiAgLy8gSXNzdWUgIzI4NzM6IG9uZSBjbG9jayByZWFkaW5nIHBlciBhdWRpdCwgbm90IHBlciBpc3N1ZS5cbiAgY29uc3Qgbm93TXMgPSBEYXRlLm5vdygpO1xuXG4gIC8vIElzc3VlICMxMDUwOiB0aGUgc2NhbidzIG93biB2aWV3IG9mIHRoZSBpc3N1ZSBzZXQsIHNvIHRoZSB0d28gZ2F0ZXNcbiAgLy8gYmVsb3cgYXJlIGFuc3dlcmVkIGJ5IHRoZSBzY2FuJ3Mgb3duIGZ1bmN0aW9ucyByYXRoZXIgdGhhbiBieSBhIHNlY29uZFxuICAvLyBpbXBsZW1lbnRhdGlvbiBvZiB0aGUgc2FtZSBydWxlLiBFdmVyeSBmaWVsZCBgaXNNaWxlc3RvbmVPY2N1cGllZGAgYW5kXG4gIC8vIGBpc01pbGVzdG9uZVRyYWNraW5nSXNzdWVgIHJlYWQgY29tZXMgb2ZmIHRoZSBwcm9iZSdzIHNpbmdsZVxuICAvLyBgZ2ggaXNzdWUgbGlzdGA7IHRoZSByZXN0IGFyZSBwbGFjZWhvbGRlcnMgdGhvc2UgdHdvIG5ldmVyIHRvdWNoLlxuICBjb25zdCBhc0ZpbHRlcmFibGU6IEZpbHRlcmFibGVJc3N1ZVtdID0gaXNzdWVzLm1hcCgoaXNzdWUpID0+ICh7XG4gICAgbnVtYmVyOiBpc3N1ZS5udW1iZXIsXG4gICAgdGl0bGU6IGlzc3VlLnRpdGxlID8/IFwiXCIsXG4gICAgdXJsOiBcIlwiLFxuICAgIGF1dGhvcjogXCJcIixcbiAgICBhc3NpZ25lZXM6IGlzc3VlLmFzc2lnbmVlcyxcbiAgICBsYWJlbHM6IGlzc3VlLmxhYmVscyxcbiAgICBjcmVhdGVkQXQ6IFwiXCIsXG4gICAgbWlsZXN0b25lOiBpc3N1ZS5taWxlc3RvbmUsXG4gICAgLi4uKGlzc3VlLmJvZHkgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBib2R5OiBpc3N1ZS5ib2R5IH0pLFxuICB9KSk7XG5cbiAgLy8gU3RyZWFtcyB0aGUgc2NhbiBjb25zaWRlcnMgb2NjdXBpZWQg4oCUIG1pbGVzdG9uZXMgKG9yIFwiXCIgZm9yIHRoZVxuICAvLyBkZWZhdWx0LWJyYW5jaCBzdHJlYW0pIHRoYXQgYWxyZWFkeSBob3N0IGFuIGlzc3VlIGFzc2lnbmVkIHRvIGFuIGFjY291bnRcbiAgLy8gdGhlIGZsZWV0IG9wZXJhdGVzLiBJc3N1ZSAjMTA1MDogcmVzb2x2ZWQgdGhyb3VnaCB0aGUgc2NhbidzIG93blxuICAvLyBgaXNNaWxlc3RvbmVPY2N1cGllZGAsIG92ZXIgdGhlIHNjYW4ncyBvd24gYWNjb3VudCBzZXQsIG9uY2UgcGVyXG4gIC8vIGRpc3RpbmN0IHN0cmVhbS4gVGhlIGhhbmQtcm9sbGVkIHZlcnNpb24gaGVyZSBtYXRjaGVkIGB3b3JrZXJVc2VyYFxuICAvLyBhbG9uZSwgc28gYW4gaXNzdWUgYSBzaWJsaW5nIHdvcmtlciBoZWxkIGxlZnQgdGhlIHN0cmVhbSByZWFkaW5nIGFzIGZyZWVcbiAgLy8gdG8gdGhlIGF1ZGl0IHdoaWxlIHRoZSBzY2FuIHJlZnVzZWQgZXZlcnkgaXNzdWUgaW4gaXQgYXNcbiAgLy8gYG1pbGVzdG9uZS1vY2N1cGllZGAuXG4gIGNvbnN0IG9jY3VwaWVkU3RyZWFtcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHN0cmVhbSBvZiBuZXcgU2V0KGlzc3Vlcy5tYXAoKGkpID0+IGkubWlsZXN0b25lKSkpIHtcbiAgICBpZiAoXG4gICAgICBpc01pbGVzdG9uZU9jY3VwaWVkKFxuICAgICAgICBhc0ZpbHRlcmFibGUsXG4gICAgICAgIHN0cmVhbSxcbiAgICAgICAgb3B0cy53b3JrZXJVc2VyLFxuICAgICAgICBbLi4ucHVzaENhcGFibGVBdXRob3JzXSxcbiAgICAgIClcbiAgICApIHtcbiAgICAgIG9jY3VwaWVkU3RyZWFtcy5hZGQoc3RyZWFtKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgdHJhY2tlcnMgPSBuZXcgU2V0KFxuICAgIGFzRmlsdGVyYWJsZS5maWx0ZXIoKGkpID0+IGlzTWlsZXN0b25lVHJhY2tpbmdJc3N1ZShpKSkubWFwKChpKSA9PlxuICAgICAgaS5udW1iZXJcbiAgICApLFxuICApO1xuXG4gIGNvbnN0IHJlc3VsdDogSXNzdWVWZXJkaWN0W10gPSBbXTtcbiAgZm9yIChjb25zdCBpc3N1ZSBvZiBpc3N1ZXMpIHtcbiAgICBjb25zdCBoYXNDbGFpbWFibGUgPSBpc3N1ZS5sYWJlbHMuc29tZSgobCkgPT4gY2xhaW1hYmxlU2V0LmhhcyhsKSk7XG4gICAgaWYgKCFoYXNDbGFpbWFibGUpIHtcbiAgICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgICAgbnVtYmVyOiBpc3N1ZS5udW1iZXIsXG4gICAgICAgIGNsYWltYWJsZTogZmFsc2UsXG4gICAgICAgIGV4Y2x1ZGVkQnk6IFwibGFiZWxfZmlsdGVyXCIsXG4gICAgICAgIG1pbGVzdG9uZTogaXNzdWUubWlsZXN0b25lLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzc3VlLmxhYmVscy5zb21lKChsKSA9PiBibG9ja2luZ1NldC5oYXMobCkpKSB7XG4gICAgICByZXN1bHQucHVzaCh7XG4gICAgICAgIG51bWJlcjogaXNzdWUubnVtYmVyLFxuICAgICAgICBjbGFpbWFibGU6IGZhbHNlLFxuICAgICAgICBleGNsdWRlZEJ5OiBcImJsb2NraW5nX2xhYmVsXCIsXG4gICAgICAgIG1pbGVzdG9uZTogaXNzdWUubWlsZXN0b25lLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzc3VlLmFzc2lnbmVlcy5sZW5ndGggPiAwKSB7XG4gICAgICByZXN1bHQucHVzaCh7XG4gICAgICAgIG51bWJlcjogaXNzdWUubnVtYmVyLFxuICAgICAgICBjbGFpbWFibGU6IGZhbHNlLFxuICAgICAgICBleGNsdWRlZEJ5OiBcImFzc2lnbmVlX2ZpbHRlclwiLFxuICAgICAgICBtaWxlc3RvbmU6IGlzc3VlLm1pbGVzdG9uZSxcbiAgICAgIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIElzc3VlICM0MjEyOiB0aGUgc2NhbidzIGBsYWJlbC1hdXRob3Itbm90LWFsbG93ZWRgIHNraXAsIGFwcGxpZWRcbiAgICAvLyBzdHJhaWdodCBhZnRlciB0aGUgYXNzaWduZWUgZ2F0ZSBhbmQgYmVmb3JlIHRoZSB0cmFja2VyIGRyb3AuIEFic2VudFxuICAgIC8vIGB1bnRydXN0ZWRMYWJlbElzc3Vlc2AsIG5vdGhpbmcgaXMgZXhjbHVkZWQgaGVyZS5cbiAgICBpZiAodW50cnVzdGVkTGFiZWxJc3N1ZXMuaGFzKGlzc3VlLm51bWJlcikpIHtcbiAgICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgICAgbnVtYmVyOiBpc3N1ZS5udW1iZXIsXG4gICAgICAgIGNsYWltYWJsZTogZmFsc2UsXG4gICAgICAgIGV4Y2x1ZGVkQnk6IFwibGFiZWxfYXV0aG9yX25vdF9hbGxvd2VkXCIsXG4gICAgICAgIG1pbGVzdG9uZTogaXNzdWUubWlsZXN0b25lLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gSXNzdWUgIzEwNTA6IGBmaWx0ZXJBbmRTb3J0YCBkcm9wcyBtaWxlc3RvbmUtdHJhY2tpbmcgaXNzdWVzIGluIHRoZVxuICAgIC8vIHNhbWUgcGFzcyBhcyBhc3NpZ25lZXMgYW5kIGJsb2NraW5nIGxhYmVscyAoSXNzdWUgIzExMzQpLCBzbyBhIHRyYWNrZXJcbiAgICAvLyBjYXJyeWluZyBhIGRpc2NvdmVyeSBsYWJlbCBpcyB3b3JrIHRoZSBzY2FuIGNhbiBuZXZlciBhY3Rpb24uIFRoZVxuICAgIC8vIGF1ZGl0IGNvdW50ZWQgaXQsIGFuZCAjMjc1MSBoYXMgYWxyZWFkeSBzaG93biB3aGF0IGNvdW50aW5nIHdvcmsgdGhlXG4gICAgLy8gc2NhbiBwZXJtYW5lbnRseSBza2lwcyBkb2VzIHRvIGEgYmFja2xvZy5cbiAgICBpZiAodHJhY2tlcnMuaGFzKGlzc3VlLm51bWJlcikpIHtcbiAgICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgICAgbnVtYmVyOiBpc3N1ZS5udW1iZXIsXG4gICAgICAgIGNsYWltYWJsZTogZmFsc2UsXG4gICAgICAgIGV4Y2x1ZGVkQnk6IFwibWlsZXN0b25lX3RyYWNrZXJcIixcbiAgICAgICAgbWlsZXN0b25lOiBpc3N1ZS5taWxlc3RvbmUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBJc3N1ZSAjMjUzMjogb2NjdXBhbmN5IHNlcmlhbGlzZXMgYGxvdy1wcmlvcml0eWAgYW5kIGBpZGxlLXRhc2tgIG9ubHkuXG4gICAgLy8gQSBgdG9wLXByaW9yaXR5YCBvciBgd29yay1vbmAgY2xhaW0gam9pbnMgYSBidXN5IHN0cmVhbSBpbiBpdHMgb3duXG4gICAgLy8gZnJlc2ggY29udmVyc2F0aW9uIChJc3N1ZSAjMjUzMCkgYW5kIHRoZSBjb2xsZWN0b3JzIG5vIGxvbmdlciByZWZ1c2VcbiAgICAvLyBpdCwgc28gZXhjbHVkaW5nIGl0IGhlcmUgd291bGQgcHV0IHRoZSBhdWRpdCBiYWNrIGluIGRpc2FncmVlbWVudCB3aXRoXG4gICAgLy8gdGhlIHNjYW4g4oCUIHRoZSBkaXZlcmdlbmNlIHRoZSAyMDI2LTA4LTI2IGlkbGUtdGFzayBkcm91Z2h0IHdhcy5cbiAgICBpZiAoXG4gICAgICBvY2N1cGllZFN0cmVhbXMuaGFzKGlzc3VlLm1pbGVzdG9uZSkgJiZcbiAgICAgICFpc1N0cmVhbVNoYXJpbmdUaWVyKGlzc3VlLmxhYmVscywgREVGQVVMVF9TVFJFQU1fU0hBUklOR19USUVSUylcbiAgICApIHtcbiAgICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgICAgbnVtYmVyOiBpc3N1ZS5udW1iZXIsXG4gICAgICAgIGNsYWltYWJsZTogZmFsc2UsXG4gICAgICAgIGV4Y2x1ZGVkQnk6IFwic3RyZWFtX29jY3VwaWVkXCIsXG4gICAgICAgIG1pbGVzdG9uZTogaXNzdWUubWlsZXN0b25lLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gSXNzdWUgIzQyMjM6IGFuIG9wZW4gUFIgaW4gdGhlIGlzc3VlJ3Mgd29yayBzdHJlYW0gbWVhbnMgdGhlIFByaW9yaXR5IDJcbiAgICAvLyBzY2FuIHdpbGwgbm90IGNsYWltIGl0LCBzbyBjb3VudGluZyBpdCBhcyBjbGFpbWFibGUgbWFkZSB0aGUgYXVkaXRcbiAgICAvLyBwZXJtYW5lbnRseSBkaXNhZ3JlZSB3aXRoIGEgc2NhbiB0aGF0IHdhcyByaWdodC4gV29yayB3YWl0aW5nIG9uIGh1bWFuXG4gICAgLy8gcmV2aWV3IGlzIHRoaXMgZmxlZXQncyBub3JtYWwgc3RlYWR5IHN0YXRlLCBzbyB0aGUgYG1pc19jbGFzc2lmaWNhdGlvbmBcbiAgICAvLyBBTEVSVCBmaXJlZCBvbiBlc3NlbnRpYWxseSBldmVyeSB0aWNrIOKAlCAxNTEyIHRpbWVzIGluIG9uZSBsb2cg4oCUIGFuZCB0aGVcbiAgICAvLyBnZW51aW5lICMyMTA2IHN5bXB0b20gYmVjYW1lIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gdGhlIG5vaXNlLlxuICAgIC8vXG4gICAgLy8gQXBwbGllZCBsYXN0LCBzbyBhbiBpc3N1ZSBleGNsdWRlZCBmb3IgYSBtb3JlIGZ1bmRhbWVudGFsIHJlYXNvbiBrZWVwc1xuICAgIC8vIHRoYXQgcmVhc29uOiBgcHJfYmxvY2tlZGAgbWFya3Mgb25seSBpc3N1ZXMgdGhhdCB3b3VsZCBvdGhlcndpc2UgYmVcbiAgICAvLyBjbGFpbWFibGUgcmlnaHQgbm93LlxuICAgIGlmIChcbiAgICAgIG9wZW5QUnMubGVuZ3RoID4gMCAmJlxuICAgICAgaXNQckJsb2NrZWQoaXNzdWUsIG9wZW5QUnMsIHB1c2hDYXBhYmxlQXV0aG9ycywgb3B0cy5mbGVldFByU2xvdHMpXG4gICAgKSB7XG4gICAgICByZXN1bHQucHVzaCh7XG4gICAgICAgIG51bWJlcjogaXNzdWUubnVtYmVyLFxuICAgICAgICBjbGFpbWFibGU6IGZhbHNlLFxuICAgICAgICBleGNsdWRlZEJ5OiBcInByX2Jsb2NrZWRcIixcbiAgICAgICAgbWlsZXN0b25lOiBpc3N1ZS5taWxlc3RvbmUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBHUlEjNDQxOTogYSBtZXJnZWQgZmxlZXQgUFIgbmFtaW5nIHRoaXMgaXNzdWUgaXMgYSAqcGVybWFuZW50KiBza2lwXG4gICAgLy8gKElzc3VlICMzMTUxKSwgc28gY291bnRpbmcgaXQgYXMgY2xhaW1hYmxlIG1hZGUgdGhlIGF1ZGl0IGRpc2FncmVlIHdpdGhcbiAgICAvLyBhIHNjYW4gdGhhdCB3YXMgcmlnaHQgb24gZXZlcnkgdGljaywgZm9yIGV2ZXIuIEFwcGxpZWQgbGFzdCBmb3IgdGhlXG4gICAgLy8gc2FtZSByZWFzb24gYXMgYHByX2Jsb2NrZWRgIOKAlCBhIG1vcmUgZnVuZGFtZW50YWwgZXhjbHVzaW9uIHdpbnMuXG4gICAgaWYgKG1lcmdlZFBScy5sZW5ndGggPiAwICYmIGlzTWVyZ2VkUHJCbG9ja2VkKGlzc3VlLCBtZXJnZWRQUnMpKSB7XG4gICAgICByZXN1bHQucHVzaCh7XG4gICAgICAgIG51bWJlcjogaXNzdWUubnVtYmVyLFxuICAgICAgICBjbGFpbWFibGU6IGZhbHNlLFxuICAgICAgICBleGNsdWRlZEJ5OiBcIm1lcmdlZF9wcl9ibG9ja2VkXCIsXG4gICAgICAgIG1pbGVzdG9uZTogaXNzdWUubWlsZXN0b25lLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gSXNzdWUgIzI4NzM6IG1pcnJvcnMgdGhlIHNjYW4ncyBvd24gYGlzVGltZURlZmVycmVkYCBnYXRlLCBhcHBsaWVkXG4gICAgLy8gaW1tZWRpYXRlbHkgYmVmb3JlIHRoZSBkZXBlbmRlbmN5LWJsb2NrZWQgZ2F0ZSBiZWxvdyDigJQgdGhlIHNjYW4ncyBvd25cbiAgICAvLyBvcmRlciDigJQgc28gYW4gaXNzdWUgdGhhdCBpcyBib3RoIHRpbWUtZGVmZXJyZWQgYW5kIGRlcGVuZGVuY3ktYmxvY2tlZFxuICAgIC8vIGtlZXBzIGB0aW1lX2RlZmVycmVkYCwgbm90IGBkZXBlbmRlbmN5X2Jsb2NrZWRgLiBBYnNlbnQgYm9keSDihpIgbm90XG4gICAgLy8gZGVmZXJyZWQsIHNhbWUgZmFpbC1zYWZlIGRpcmVjdGlvbiBhcyB0aGUgZGVwZW5kZW5jeSBnYXRlIGJlbG93LlxuICAgIGlmIChpc1RpbWVEZWZlcnJlZChpc3N1ZS5ib2R5ID8/IFwiXCIsIG5vd01zKSkge1xuICAgICAgcmVzdWx0LnB1c2goe1xuICAgICAgICBudW1iZXI6IGlzc3VlLm51bWJlcixcbiAgICAgICAgY2xhaW1hYmxlOiBmYWxzZSxcbiAgICAgICAgZXhjbHVkZWRCeTogXCJ0aW1lX2RlZmVycmVkXCIsXG4gICAgICAgIG1pbGVzdG9uZTogaXNzdWUubWlsZXN0b25lLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gSXNzdWUgIzMzMTQ6IG5hdGl2ZSBzdWItaXNzdWUgYmxvY2tpbmcsIHJlYWQgZnJvbSBgc3ViSXNzdWVzU3VtbWFyeWAgb25cbiAgICAvLyB0aGUgc2FtZSBgZ2ggaXNzdWUgbGlzdGAgY2FsbCDigJQgaW5kZXBlbmRlbnQgb2YgYG9wZW5Jc3N1ZU51bWJlcnNgIC9cbiAgICAvLyBgb3Blbk1pbGVzdG9uZXNgLCBzaW5jZSBpdCBuZWVkcyBuZWl0aGVyIHRvIGJlIGtub3duLlxuICAgIGlmIChoYXNPcGVuU3ViSXNzdWVzKGlzc3VlKSkge1xuICAgICAgcmVzdWx0LnB1c2goe1xuICAgICAgICBudW1iZXI6IGlzc3VlLm51bWJlcixcbiAgICAgICAgY2xhaW1hYmxlOiBmYWxzZSxcbiAgICAgICAgZXhjbHVkZWRCeTogXCJkZXBlbmRlbmN5X2Jsb2NrZWRcIixcbiAgICAgICAgbWlsZXN0b25lOiBpc3N1ZS5taWxlc3RvbmUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBJc3N1ZSAjODU3OiB0aGUgc2NhbidzIGVpZ2h0aCBnYXRlLCBhYnNlbnQgaGVyZSB1bnRpbCBub3cg4oCUIHRoZSBhdWRpdFxuICAgIC8vIGNvdW50ZWQgZGVwZW5kZW5jeS1ibG9ja2VkIGlzc3VlcyBhcyBjbGFpbWFibGUgYW5kIGRpc2FncmVlZCB3aXRoIGFcbiAgICAvLyBzY2FuIHRoYXQgd2FzIHJpZ2h0LCBvbiBldmVyeSB0aWNrLiBBcHBsaWVkIGluIHRoZSBzY2FuJ3Mgb3duIG9yZGVyLFxuICAgIC8vIHNvIGFuIGlzc3VlIHJlZnVzZWQgZm9yIGEgbW9yZSBmdW5kYW1lbnRhbCByZWFzb24ga2VlcHMgdGhhdCByZWFzb24uXG4gICAgLy9cbiAgICAvLyBJc3N1ZSAjMjUzMzogYG9wZW5NaWxlc3RvbmVzYCBhbG9uZSBpcyBlbm91Z2ggdG8gZmlyZSB0aGlzIGdhdGUuIEFcbiAgICAvLyBjcm9zcy1taWxlc3RvbmUgaG9sZCBhcHBsaWVzIHByZWNpc2VseSB3aGVuIGV2ZXJ5IGRlcGVuZGVuY3kgaXNcbiAgICAvLyAqY2xvc2VkKiwgc28gZ2F0aW5nIGl0IGJlaGluZCBgb3Blbklzc3VlTnVtYmVycy5zaXplID4gMGAgd291bGQgaGF2ZVxuICAgIC8vIHN1cHByZXNzZWQgdGhlIGNhc2UgaXQgZXhpc3RzIHRvIGNhdGNoLlxuICAgIGlmIChcbiAgICAgIHJlcG8gIT09IFwiXCIgJiZcbiAgICAgIChvcGVuSXNzdWVOdW1iZXJzLnNpemUgPiAwIHx8IG9wZW5NaWxlc3RvbmVzLnNpemUgPiAwKSAmJlxuICAgICAgaXNEZXBlbmRlbmN5QmxvY2tlZEJ5T3Blbklzc3VlKFxuICAgICAgICBpc3N1ZS5ib2R5LFxuICAgICAgICByZXBvLFxuICAgICAgICBvcGVuSXNzdWVOdW1iZXJzLFxuICAgICAgICBrbm93blJlcG9zLFxuICAgICAgICBpc3N1ZS5taWxlc3RvbmUsXG4gICAgICAgIG9wZW5NaWxlc3RvbmVzLFxuICAgICAgKVxuICAgICkge1xuICAgICAgcmVzdWx0LnB1c2goe1xuICAgICAgICBudW1iZXI6IGlzc3VlLm51bWJlcixcbiAgICAgICAgY2xhaW1hYmxlOiBmYWxzZSxcbiAgICAgICAgZXhjbHVkZWRCeTogXCJkZXBlbmRlbmN5X2Jsb2NrZWRcIixcbiAgICAgICAgbWlsZXN0b25lOiBpc3N1ZS5taWxlc3RvbmUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBJc3N1ZSAjNjU1OiBsYXN0IG9mIHRoZSBnYXRlcywgbWlycm9yaW5nIHRoZSBzY2FuIOKAlCBgaXNJc3N1ZUluQ29vbGRvd25gXG4gICAgLy8gcnVucyBvbiB0aGUgY2FuZGlkYXRlcyBldmVyeSBjb2xsZWN0b3IgaGFzIGFscmVhZHkgcGFzc2VkLCBzbyBhbiBpc3N1ZVxuICAgIC8vIHJlZnVzZWQgZm9yIGEgbW9yZSBmdW5kYW1lbnRhbCByZWFzb24ga2VlcHMgdGhhdCByZWFzb24gYW5kXG4gICAgLy8gYHJ1bl9sb2NhbF9ob2xkYCBtYXJrcyBvbmx5IHdvcmsgdGhpcyBydW4gaXMgaXRzZWxmIHdpdGhob2xkaW5nLlxuICAgIGlmIChydW5Mb2NhbEhvbGRzLmhhcyhpc3N1ZS5udW1iZXIpKSB7XG4gICAgICByZXN1bHQucHVzaCh7XG4gICAgICAgIG51bWJlcjogaXNzdWUubnVtYmVyLFxuICAgICAgICBjbGFpbWFibGU6IGZhbHNlLFxuICAgICAgICBleGNsdWRlZEJ5OiBcInJ1bl9sb2NhbF9ob2xkXCIsXG4gICAgICAgIG1pbGVzdG9uZTogaXNzdWUubWlsZXN0b25lLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gSXNzdWVzICMxODg1LCAjMTkxNTogdGhlIHBhY2UgZ2F0ZSBpcyB0aGUgc2NhbidzIG93biBsYXN0IHdvcmQg4oCUIGl0XG4gICAgLy8gZHJvcHMgd2hvbGUgdGllcnMgYXQgc2VsZWN0aW9uIHRpbWUsIGFmdGVyIGV2ZXJ5IHBlci1pc3N1ZSBmaWx0ZXIgaGFzXG4gICAgLy8gcnVuIOKAlCBzbyBpdCBpcyBhcHBsaWVkIGxhc3QgaGVyZSB0b28sIGFuZCBhbiBpc3N1ZSByZWZ1c2VkIGZvciBhIG1vcmVcbiAgICAvLyBmdW5kYW1lbnRhbCByZWFzb24ga2VlcHMgdGhhdCByZWFzb24uIGBwYWNlX3N1cHByZXNzZWRgIG1hcmtzIG9ubHkgd29ya1xuICAgIC8vIHRoYXQgd291bGQgb3RoZXJ3aXNlIGJlIGNsYWltYWJsZSByaWdodCBub3cuXG4gICAgaWYgKFxuICAgICAgd2Vla1BhY2VFbmdhZ2VkICYmICFpc3N1ZS5sYWJlbHMuc29tZSgobCkgPT4gcGFjZUV4ZW1wdFNldC5oYXMobCkpXG4gICAgKSB7XG4gICAgICByZXN1bHQucHVzaCh7XG4gICAgICAgIG51bWJlcjogaXNzdWUubnVtYmVyLFxuICAgICAgICBjbGFpbWFibGU6IGZhbHNlLFxuICAgICAgICBleGNsdWRlZEJ5OiBcInBhY2Vfc3VwcHJlc3NlZFwiLFxuICAgICAgICBtaWxlc3RvbmU6IGlzc3VlLm1pbGVzdG9uZSxcbiAgICAgIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIElzc3VlICMzNjI4OiB0aGUgcXVvdGEgcG9sbGluZyBnYXRlIGRlZmVycmVkIHRoZSBpZGxlLXRhc2sgY29sbGVjdG9yLFxuICAgIC8vIHNvIGFuIGlzc3VlIHdob3NlIG9ubHkgZGlzY292ZXJ5IGxhYmVsIGlzIGBpZGxlLXRhc2tgIHdhcyBuZXZlclxuICAgIC8vIGNvbGxlY3RlZCDigJQgdGhlIHNhbWUgXCJ0aGUgc2NhbidzIG93biBsYXN0IHdvcmRcIiB0cmVhdG1lbnQgYXMgdGhlIHBhY2VcbiAgICAvLyBnYXRlIGFib3ZlLCBhbmQgYXBwbGllZCBhZnRlciBpdCBzbyBhIHBhY2UtcmVmdXNlZCBpc3N1ZSBrZWVwcyBpdHNcbiAgICAvLyBtb3JlIGZ1bmRhbWVudGFsIHJlYXNvbi4gQW4gaXNzdWUgdGhhdCBhbHNvIGNhcnJpZXMgYSBoaWdoZXIgZGlzY292ZXJ5XG4gICAgLy8gbGFiZWwgc3RheXMgY2xhaW1hYmxlOiBpdHMgY29sbGVjdG9yIHN0aWxsIHJhbi5cbiAgICBpZiAoXG4gICAgICBxdW90YUlkbGVEZWZlcnJlZCAmJlxuICAgICAgaXNzdWUubGFiZWxzLmluY2x1ZGVzKElETEVfVEFTS19MQUJFTCkgJiZcbiAgICAgICFpc3N1ZS5sYWJlbHMuc29tZSgobCkgPT4gY2xhaW1hYmxlU2V0LmhhcyhsKSAmJiBsICE9PSBJRExFX1RBU0tfTEFCRUwpXG4gICAgKSB7XG4gICAgICByZXN1bHQucHVzaCh7XG4gICAgICAgIG51bWJlcjogaXNzdWUubnVtYmVyLFxuICAgICAgICBjbGFpbWFibGU6IGZhbHNlLFxuICAgICAgICBleGNsdWRlZEJ5OiBcInF1b3RhX2lkbGVfZGVmZXJyZWRcIixcbiAgICAgICAgbWlsZXN0b25lOiBpc3N1ZS5taWxlc3RvbmUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBObyB3cmFwcGVyLXRpdGxlIGdhdGU6IGBpZGxlLXRhc2tgIGlzIGp1c3QgdGhlIGxvd2VzdCB3b3JrLXRyaWdnZXJcbiAgICAvLyBwcmlvcml0eSwgc28gYW55IHVuYmxvY2tlZCwgdW5hc3NpZ25lZCBpZGxlLXRhc2sgaXNzdWUgaXNcbiAgICAvLyBjbGFpbWFibGUgaGVyZSDigJQgbWF0Y2hpbmcgdGhlIGNvbGxlY3RvclxuICAgIC8vIChgY29sbGVjdF9pZGxlX3Rhc2tfY2FuZGlkYXRlcy50c2ApLiBXaGV0aGVyIGEgY2xhaW1lZCB3cmFwcGVyXG4gICAgLy8gcnVucyBhIHNjYW4gdGVtcGxhdGUgb3IgZmxvd3MgdGhyb3VnaCB0aGUgc3RhbmRhcmQgcGlwZWxpbmUgaXMgYVxuICAgIC8vIGRpc3BhdGNoLXRpbWUgZGVjaXNpb24sIG5vdCBhIGNsYWltYWJpbGl0eSBvbmUuXG4gICAgcmVzdWx0LnB1c2goe1xuICAgICAgbnVtYmVyOiBpc3N1ZS5udW1iZXIsXG4gICAgICBjbGFpbWFibGU6IHRydWUsXG4gICAgICBtaWxlc3RvbmU6IGlzc3VlLm1pbGVzdG9uZSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIFBpY2sgdGhlIGRvbWluYW50IHNraXAgcmVhc29uIGZvciBhIHJlcG8gd2hlbiBgY2xhaW1hYmxlID09PSAwYC5cbiAqIFNwZWNpZmljaXR5IG9yZGVyIChtb3N0IOKGkiBsZWFzdCBzcGVjaWZpYyk6XG4gKiAgIG1lcmdlZF9wcl9ibG9ja2VkID4gcHJfYmxvY2tlZCA+IHBhY2Vfc3VwcHJlc3NlZCA+IHJ1bl9sb2NhbF9ob2xkID5cbiAqICAgZGVwZW5kZW5jeV9ibG9ja2VkID4gdGltZV9kZWZlcnJlZCA+IHN0cmVhbV9vY2N1cGllZCA+XG4gKiAgIG1pbGVzdG9uZV90cmFja2VyID4gbGFiZWxfYXV0aG9yX25vdF9hbGxvd2VkID4gYXNzaWduZWVfZmlsdGVyID5cbiAqICAgYmxvY2tpbmdfbGFiZWwgPiBsYWJlbF9maWx0ZXIuXG4gKiBUaGUgdHdvIFBSIGdhdGVzIHJhbmsgZmlyc3QgYmVjYXVzZSB0aGV5IGRlc2NyaWJlIGZsZWV0IHN0YXRlIHRoYXQgbWF5XG4gKiBuZWVkIGEgaHVtYW4gdG8gcmVzb2x2ZS4gQmVsb3cgdGhlbSwgZWFjaCBsYXRlciBnYXRlIGluIGBjbGFzc2lmeUlzc3Vlc2BcbiAqIHJhbmtzIGFib3ZlIHRoZSBvbmVzIGl0IGZvbGxvd3MsIGJlY2F1c2UgYSBsYXRlciBnYXRlIG9ubHkgZXZlciByZWZ1c2VzXG4gKiBhbiBpc3N1ZSBldmVyeSBlYXJsaWVyIGdhdGUgYWxyZWFkeSBwYXNzZWQg4oCUIG1ha2luZyBpdCB0aGUgbW9yZSBzcGVjaWZpY1xuICogYW5zd2VyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGlja0RvbWluYW50UmVhc29uKFxuICB2ZXJkaWN0czogSXNzdWVWZXJkaWN0W10sXG4pOiBDbGFpbWFibGVTa2lwUmVhc29uIHtcbiAgaWYgKHZlcmRpY3RzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwibm9fb3BlblwiO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxJc3N1ZUV4Y2x1c2lvblJlYXNvbj4oKTtcbiAgZm9yIChjb25zdCB2IG9mIHZlcmRpY3RzKSB7XG4gICAgaWYgKCF2LmNsYWltYWJsZSAmJiB2LmV4Y2x1ZGVkQnkgIT09IHVuZGVmaW5lZCkgc2Vlbi5hZGQodi5leGNsdWRlZEJ5KTtcbiAgfVxuICAvLyBJc3N1ZSAjNDIyMzogYHByX2Jsb2NrZWRgIG91dHJhbmtzIHRoZSByZXN0LiBJdCBpcyBvbmx5IGV2ZXIgc2V0IG9uIGFuXG4gIC8vIGlzc3VlIHRoYXQgcGFzc2VkIGV2ZXJ5IG90aGVyIGdhdGUsIHNvIFwidGhlIHdvcmsgaXMgd2FpdGluZyBvbiBhbiBvcGVuXG4gIC8vIFBSXCIgaXMgdGhlIG1vc3QgYWN0aW9uYWJsZSBhbnN3ZXIgdG8gXCJ3aHkgd2FzIG5vdGhpbmcgcGlja2VkIHVwXCIuXG4gIC8vIEdSUSM0NDE5OiBhIHBlcm1hbmVudCBzdHJhbmQgb3V0cmFua3MgZXZlbiBgcHJfYmxvY2tlZGAg4oCUIGFuIG9wZW4gUFJcbiAgLy8gY2xlYXJzIGl0c2VsZiB3aGVuIGl0IG1lcmdlcywgYSBtZXJnZWQgb25lIG5ldmVyIGRvZXMgd2l0aG91dCBhIGh1bWFuXG4gIC8vIHJlLWxhYmVsbGluZyB0aGUgaXNzdWUsIHNvIGl0IGlzIHRoZSBtb3JlIGFjdGlvbmFibGUgYW5zd2VyLlxuICBpZiAoc2Vlbi5oYXMoXCJtZXJnZWRfcHJfYmxvY2tlZFwiKSkgcmV0dXJuIFwibWVyZ2VkX3ByX2Jsb2NrZWRcIjtcbiAgaWYgKHNlZW4uaGFzKFwicHJfYmxvY2tlZFwiKSkgcmV0dXJuIFwicHJfYmxvY2tlZFwiO1xuICAvLyBJc3N1ZSAjMTkxNTogYmVsb3cgdGhlIHR3byBQUiBnYXRlcyBhbmQgYWJvdmUgdGhlIHJ1bi1sb2NhbCBob2xkLiBJdCBpc1xuICAvLyBvbmx5IGV2ZXIgc2V0IG9uIGFuIGlzc3VlIG5vdGhpbmcgZWxzZSByZWZ1c2VkLCBhbmQgXCJ0aGUgd2Vlay1wYWNlIGd1YXJkXG4gIC8vIGlzIHNwZW5kaW5nIHdoYXQgaXMgbGVmdCBvZiB0aGUgcXVvdGEgb24gdXJnZW5jeSBzaWduYWxzXCIgaXMgdGhlIGFuc3dlciBhblxuICAvLyBvcGVyYXRvciBhc2tpbmcgd2h5IHRoZSBmbGVldCBpcyBpZGxlIGFjdHVhbGx5IG5lZWRzIOKAlCBhIGhvbGQgY2xlYXJzIHdoZW5cbiAgLy8gdGhlIHJ1biBlbmRzLCB0aGUgZ3VhcmQgc3RhbmRzIHVudGlsIHRoZSB3ZWVrbHkgd2luZG93IHJlc2V0cy5cbiAgLy8gSXNzdWUgIzY1NTogYmVsb3cgdGhlIHR3byBQUiBnYXRlcywgYWJvdmUgZXZlcnl0aGluZyBhcHBsaWVkIGJlZm9yZSBpdC5cbiAgLy8gQm90aCBQUiBnYXRlcyBkZXNjcmliZSBmbGVldCBzdGF0ZSB0aGF0IG91dGxpdmVzIHRoaXMgcHJvY2VzcyBhbmQgbWF5XG4gIC8vIG5lZWQgYSBodW1hbjsgYSBydW4tbG9jYWwgaG9sZCBjbGVhcnMgaXRzZWxmIHdoZW4gdGhlIHJ1biBlbmRzIG9yIHRoZVxuICAvLyBjb29sZG93biBleHBpcmVzLCBzbyBpdCBpcyB0aGUgbGVzcyB1cmdlbnQgYW5zd2VyIG9mIHRoZSB0aHJlZSDigJQgYnV0IGl0XG4gIC8vIGlzIG9ubHkgZXZlciBzZXQgb24gYW4gaXNzdWUgbm90aGluZyBlbHNlIHJlZnVzZWQsIHdoaWNoIG1ha2VzIGl0IG1vcmVcbiAgLy8gc3BlY2lmaWMgdGhhbiBzdHJlYW0gb2NjdXBhbmN5IGFuZCB0aGUgZmlsdGVycyBhYm92ZSB0aGF0LlxuICBpZiAoc2Vlbi5oYXMoXCJwYWNlX3N1cHByZXNzZWRcIikpIHJldHVybiBcInBhY2Vfc3VwcHJlc3NlZFwiO1xuICAvLyBJc3N1ZSAjMzYyODogdGhlIHF1b3RhIHBvbGxpbmcgZ2F0ZSBkZWZlcnMgdGhlIGlkbGUgdGllciB1bnRpbCB0aGVcbiAgLy8gaG91cmx5IEdyYXBoUUwgd2luZG93IHJlc2V0cyDigJQgc2FtZSB0ZW1wb3JhbCBzaGFwZSBhcyB0aGUgcGFjZSBndWFyZFxuICAvLyAodGhlIGZsZWV0J3Mgb3duIGRlbGliZXJhdGUgcmVmdXNhbCwgc3RhbmRpbmcgdW50aWwgYSB3aW5kb3cgb3BlbnMpLFxuICAvLyBhbmQgaXQgaXMgYXBwbGllZCByaWdodCBhZnRlciBpdCBpbiBjbGFzc2lmeUlzc3Vlcywgc28gaXQgb3V0cmFua3MgYVxuICAvLyBydW4tbG9jYWwgaG9sZCBmb3IgdGhlIHNhbWUgcmVhc29uIHBhY2Vfc3VwcHJlc3NlZCBkb2VzLlxuICBpZiAoc2Vlbi5oYXMoXCJxdW90YV9pZGxlX2RlZmVycmVkXCIpKSByZXR1cm4gXCJxdW90YV9pZGxlX2RlZmVycmVkXCI7XG4gIGlmIChzZWVuLmhhcyhcInJ1bl9sb2NhbF9ob2xkXCIpKSByZXR1cm4gXCJydW5fbG9jYWxfaG9sZFwiO1xuICAvLyBJc3N1ZSAjMzMzNDogY2xhc3NpZnlJc3N1ZXMgYXBwbGllcyB0aW1lX2RlZmVycmVkLCB0aGVuIGRlcGVuZGVuY3lfYmxvY2tlZCxcbiAgLy8gYWZ0ZXIgdGhlIFBSIGdhdGVzIGFuZCBiZWZvcmUgdGhlIGhvbGQgYW5kIHBhY2UgZ2F0ZXMg4oCUIHRoZSBsYXRlciBnYXRlIGlzXG4gIC8vIHRoZSBtb3JlIHNwZWNpZmljLCBzbyBkZXBlbmRlbmN5X2Jsb2NrZWQgb3V0cmFua3MgdGltZV9kZWZlcnJlZC5cbiAgaWYgKHNlZW4uaGFzKFwiZGVwZW5kZW5jeV9ibG9ja2VkXCIpKSByZXR1cm4gXCJkZXBlbmRlbmN5X2Jsb2NrZWRcIjtcbiAgaWYgKHNlZW4uaGFzKFwidGltZV9kZWZlcnJlZFwiKSkgcmV0dXJuIFwidGltZV9kZWZlcnJlZFwiO1xuICBpZiAoc2Vlbi5oYXMoXCJzdHJlYW1fb2NjdXBpZWRcIikpIHJldHVybiBcInN0cmVhbV9vY2N1cGllZFwiO1xuICAvLyBJc3N1ZSAjMTA1MDogYmVsb3cgc3RyZWFtIG9jY3VwYW5jeSDigJQgYSB0cmFja2VyIGlzIG9ubHkgZXZlciByZWZ1c2VkXG4gIC8vIGFmdGVyIHRoZSBsYWJlbCwgYmxvY2tpbmctbGFiZWwgYW5kIGFzc2lnbmVlIGdhdGVzIGhhdmUgcGFzc2VkIGl0LCBidXRcbiAgLy8gXCJ0aGUgc3RyZWFtIGlzIGJ1c3lcIiBpcyB0aGUgbW9yZSBhY3Rpb25hYmxlIGFuc3dlciB3aGVuIGJvdGggYXBwbHkuXG4gIGlmIChzZWVuLmhhcyhcIm1pbGVzdG9uZV90cmFja2VyXCIpKSByZXR1cm4gXCJtaWxlc3RvbmVfdHJhY2tlclwiO1xuICAvLyBJc3N1ZSAjNDIxMjogYmVsb3cgdGhlIHRyYWNrZXIgZHJvcCBhbmQgYWJvdmUgdGhlIGFzc2lnbmVlIGZpbHRlci4gVGhlXG4gIC8vIHNjYW4gYXBwbGllcyB0aGUgbGFiZWwtYXV0aG9yIHNraXAgYWZ0ZXIgYXNzaWduZWVzIGhhdmUgcGFzc2VkIGFuZFxuICAvLyBiZWZvcmUgdGhlIHRyYWNrZXIsIHNvIGFuIHVudHJ1c3RlZCBsYWJlbCBpcyB0aGUgbW9yZSBzcGVjaWZpYyBhbnN3ZXJcbiAgLy8gd2hlbiB0aGUgb25seSBvdGhlciBleGNsdXNpb24gaXMgYW4gYXNzaWdubWVudC5cbiAgaWYgKHNlZW4uaGFzKFwibGFiZWxfYXV0aG9yX25vdF9hbGxvd2VkXCIpKSByZXR1cm4gXCJsYWJlbF9hdXRob3Jfbm90X2FsbG93ZWRcIjtcbiAgaWYgKHNlZW4uaGFzKFwiYXNzaWduZWVfZmlsdGVyXCIpKSByZXR1cm4gXCJhc3NpZ25lZV9maWx0ZXJcIjtcbiAgaWYgKHNlZW4uaGFzKFwiYmxvY2tpbmdfbGFiZWxcIikpIHJldHVybiBcImJsb2NraW5nX2xhYmVsXCI7XG4gIGlmIChzZWVuLmhhcyhcImxhYmVsX2ZpbHRlclwiKSkgcmV0dXJuIFwibGFiZWxfZmlsdGVyXCI7XG4gIHJldHVybiBcImxhYmVsX2ZpbHRlclwiOyAvLyBkZWZlbnNpdmUg4oCUIG9ubHkgcmVhY2hlZCBvbiBhbiBlbXB0eSBgc2VlbmBcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQcm9iZS1mYWlsdXJlIGNsYXNzaWZpY2F0aW9uIChJc3N1ZSAjNDAzNSlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFdoYXQgYSBgcmVhc29uPXByb2JlX2Vycm9yYCBzbmFwc2hvdCBhY3R1YWxseSBtZWFucy5cbiAqXG4gKiAtIGBhY2Nlc3NfZGVuaWVkYCDigJQgdGhlIHJlcG8gaXMgZ2VudWluZWx5IHVucmVhY2hhYmxlIGZvciB0aGlzXG4gKiAgIGlkZW50aXR5ICh0aGUgaG9zdC0zIGluY2lkZW50ICM0MDI4OiBib3RoIGBUaXRsZVBhZ2UvKmAgcmVwb3MgNDA0J2RcbiAqICAgZm9yIGRheXMgd2hpbGUgdGhlIHdvcmtlciBzdGF5ZWQgZ3JlZW4pLlxuICogLSBgdHJhbnNpZW50YCDigJQgYSBibGlwIHRoYXQgbXVzdCBuZXZlciBhZmZlY3QgaGVhbHRoOiBuZXR3b3JrIGZhdWx0LFxuICogICA1eHgsIG9yIGEgcmF0ZS1saW1pdCB3aW5kb3cuXG4gKiAtIGBwYXJzZV9mYWlsZWRgIOKAlCBnaCBzdWNjZWVkZWQgYnV0IGl0cyBKU09OIGRpZCBub3QgcGFyc2UuIE5vdCBhblxuICogICBhY2Nlc3Mgc2lnbmFsLlxuICovXG5leHBvcnQgdHlwZSBQcm9iZUZhaWx1cmVLaW5kID0gXCJhY2Nlc3NfZGVuaWVkXCIgfCBcInRyYW5zaWVudFwiIHwgXCJwYXJzZV9mYWlsZWRcIjtcblxuLyoqIE91ciBvd24gbWFya2VyIGZvciB0aGUgXCJnaCBzdWNjZWVkZWQsIEpTT04gZGlkIG5vdCBwYXJzZVwiIHBhdGguICovXG5jb25zdCBQQVJTRV9GQUlMRURfUkUgPSAvXlxccypwYXJzZV9mYWlsZWRcXGIvaTtcblxuLyoqXG4gKiBSYXRlLWxpbWl0IHNoYXBlcy4gR2l0SHViIHJldHVybnMgKio0MDMqKiBmb3IgYm90aCBwZXJtaXNzaW9uIGRlbmlhbFxuICogYW5kIHNlY29uZGFyeSByYXRlIGxpbWl0cywgc28gdGhyb3R0bGluZyBtdXN0IGJlIG1hdGNoZWQgKmJlZm9yZSogdGhlXG4gKiBwZXJtaXNzaW9uIHNoYXBlcyBiZWxvdyDigJQgYSBuYWl2ZSBcIjQwMyDih5Igbm8gYWNjZXNzXCIgcnVsZSB3b3VsZCBmbGFnXG4gKiB0aGUgd2hvbGUgZmxlZXQgdW5oZWFsdGh5IGR1cmluZyBhIHJhdGUtbGltaXQgd2luZG93LlxuICovXG5jb25zdCBSQVRFX0xJTUlUX1JFID1cbiAgLyhyYXRlIGxpbWl0IGV4Y2VlZGVkfHNlY29uZGFyeSByYXRlIGxpbWl0fHJldHJ5LWFmdGVyfHgtcmF0ZWxpbWl0LXJlbWFpbmluZzpcXHMqMHxcXGI0MjlcXGJ8dG9vIG1hbnkgcmVxdWVzdHMpL2k7XG5cbi8qKiA0MDQgc2hhcGVzIOKAlCB0aGUgcmVwbyBpcyBpbnZpc2libGUgdG8gdGhpcyBpZGVudGl0eS4gKi9cbmNvbnN0IE5PVF9GT1VORF9SRSA9XG4gIC8oXFxiNDA0XFxifGNvdWxkIG5vdCByZXNvbHZlIHRvIGEgKHJlcG9zaXRvcnl8dXNlcnxvcmdhbml6YXRpb24pfG5vdCBmb3VuZCkvaTtcblxuLyoqIDQwMyBib2RpZXMgdGhhdCBpbmRpY2F0ZSBhIHBlcm1pc3Npb24gZGVjaXNpb24gcmF0aGVyIHRoYW4gdGhyb3R0bGluZy4gKi9cbmNvbnN0IFBFUk1JU1NJT05fUkUgPVxuICAvKHJlc291cmNlIG5vdCBhY2Nlc3NpYmxlfG11c3QgaGF2ZSAocHVzaHxhZG1pbnx3cml0ZXxwdWxsKSBhY2Nlc3N8XFxic2FtbFxcYnxzaW5nbGUgc2lnbi1vbnxcXGJzc29cXGJ8bm90IGF1dGhvcml6ZWR8cGVybWlzc2lvbikvaTtcblxuLyoqXG4gKiBDbGFzc2lmeSBhIHByb2JlIGZhaWx1cmUgbWVzc2FnZSBpbnRvIGFuIGFjdGlvbmFibGUga2luZC5cbiAqXG4gKiBQdXJlIGFuZCBmYWlsLXNhZmU6IGFueXRoaW5nIHVucmVjb2duaXNlZCBpcyBgdHJhbnNpZW50YCwgc28gYW4gZXJyb3JcbiAqIHNoYXBlIHdlIGhhdmUgbmV2ZXIgc2VlbiBjYW4gbmV2ZXIgbWFyayBhIGhvc3QgdW5oZWFsdGh5LiBDbGFzc2lmaWNhdGlvblxuICogb25seSDigJQgdGhpcyBmdW5jdGlvbiBjaGFuZ2VzIG5vIGhlYWx0aCBiZWhhdmlvdXIgb24gaXRzIG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYXNzaWZ5UHJvYmVGYWlsdXJlKG1lc3NhZ2U6IHN0cmluZyk6IFByb2JlRmFpbHVyZUtpbmQge1xuICBpZiAoUEFSU0VfRkFJTEVEX1JFLnRlc3QobWVzc2FnZSkpIHJldHVybiBcInBhcnNlX2ZhaWxlZFwiO1xuICAvLyBUaHJvdHRsaW5nIGZpcnN0OiBpdCBpcyB0aGUgNDAzIHNoYXBlIHRoYXQgbXVzdCBOT1QgcmVhZCBhcyBkZW5pYWwuXG4gIGlmIChSQVRFX0xJTUlUX1JFLnRlc3QobWVzc2FnZSkpIHJldHVybiBcInRyYW5zaWVudFwiO1xuICBpZiAoTk9UX0ZPVU5EX1JFLnRlc3QobWVzc2FnZSkgfHwgUEVSTUlTU0lPTl9SRS50ZXN0KG1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIFwiYWNjZXNzX2RlbmllZFwiO1xuICB9XG4gIHJldHVybiBcInRyYW5zaWVudFwiO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEF1ZGl0IGVudHJ5IHBvaW50XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBBdWRpdENsYWltYWJsZVN0YXRlT3B0aW9ucyB7XG4gIC8qKiBNb25pdG9yZWQgcmVwbyBsaXN0IGluIGBvd25lci9yZXBvYCBmb3JtLiAqL1xuICByZXBvczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBHaXRIdWIgdXNlcm5hbWUgb2YgdGhlIHdvcmtlciDigJQgZHJpdmVzIHRoZSBzdHJlYW0tb2NjdXBhbmN5IGNoZWNrLiAqL1xuICB3b3JrZXJVc2VyOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgYWNjb3VudHMgdGhlIGZsZWV0IG9wZXJhdGVzIGJlc2lkZSBgd29ya2VyVXNlcmAsIGZyb21cbiAgICogYHJlc29sdmVGbGVldE1haW50ZW5hbmNlQXV0aG9yU2V0YCwgc28gdGhlIHN0cmVhbS1vY2N1cGFuY3kgZ2F0ZSBtb2RlbHNcbiAgICogdGhlIHNjYW4ncyBgbWlsZXN0b25lLW9jY3VwaWVkYCByZWZ1c2FsIG92ZXIgdGhlIHNhbWUgc2V0IChJc3N1ZXMgIzEwNTAsXG4gICAqICMxMDY0KS4gTkVWRVIgYGNvbmZpZy5hbGxvd2VkQXV0aG9yc2Ag4oCUIHNlZVxuICAgKiB7QGxpbmsgQ2xhc3NpZnlPcHRpb25zLnB1c2hDYXBhYmxlQXV0aG9yc30uXG4gICAqXG4gICAqIE9taXR0ZWQg4oaSIHRoaXMgd29ya2VyIGFsb25lLCB0aGUgcHJlLSMxMDUwIGJlaGF2aW91cjogYW4gaXNzdWUgYSBzaWJsaW5nXG4gICAqIHdvcmtlciBob2xkcyB0aGVuIGxlYXZlcyBhIHN0cmVhbSByZWFkaW5nIGFzIGZyZWUgaGVyZSB3aGlsZSB0aGUgc2NhblxuICAgKiByZWZ1c2VzIGV2ZXJ5IGlzc3VlIGluIGl0LCBhbmQgdGhlIGF1ZGl0J3MgYGNsYWltYWJsZVRvdGFsYCBzdXBwcmVzc2VzXG4gICAqIHRoZSBpZGxlLXRhc2sgZmlsZXIgb24gd29yayBub3RoaW5nIGNhbiBjbGFpbS5cbiAgICovXG4gIHB1c2hDYXBhYmxlQXV0aG9ycz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogTW9ub3RvbmljIHRpY2sgY291bnRlciAoY2FsbGVyLXN1cHBsaWVkOyB0aGUgbGliIG5ldmVyIHBlcnNpc3RzIGl0KS4gKi9cbiAgdGljazogbnVtYmVyO1xuICAvKipcbiAgICogYGZvdW5kQ2xhaW1hYmxlSXNzdWVgIHZhbHVlIHRoZSBjYWxsZXIgb2JzZXJ2ZWQgZm9yIHRoaXMgY3ljbGUuXG4gICAqIFJlcXVpcmVkIHNvIHRoZSBhdWRpdCBjYW4gcmFpc2UgYG1pc19jbGFzc2lmaWNhdGlvbmAgd2hlbiBpdHMgb3duXG4gICAqIHZlcmRpY3QgZGlzYWdyZWVzIHdpdGggdGhlIHNjYW4gbG9vcC4gUGFzcyBgdHJ1ZWAgdG8gc3VwcHJlc3MgdGhlXG4gICAqIGFsZXJ0IHBhdGggZW50aXJlbHkgKGUuZy4gd2hlbiBjYWxsaW5nIGZyb20gYSBwZXJpb2RpYyBwcm9iZVxuICAgKiBvdXRzaWRlIHRoZSBpZGxlIGdhdGUpLlxuICAgKi9cbiAgc2NhbkZvdW5kQ2xhaW1hYmxlOiBib29sZWFuO1xuICAvKipcbiAgICogV2hldGhlciBhIGhvc3QtbGV2ZWwgZ2F0ZSBzdG9wcGVkIHRoZSBjbGFpbSBzY2FuIHRoaXMgY3ljbGUgKElzc3VlXG4gICAqICM0NzkpIOKAlCB0aGUgZGlzayBmbG9vciAoIzIyNikgb3IgYSB3b3JrLXZvbHVtZSBmYXVsdCAoIzIyOSkuXG4gICAqXG4gICAqIFdoZW4gdHJ1ZSB0aGUgYG1pc19jbGFzc2lmaWNhdGlvbmAgQUxFUlQgaXMgc3VwcHJlc3NlZDogdGhlIGFsZXJ0IGV4aXN0c1xuICAgKiB0byBjYXRjaCB0aGUgYXVkaXQgZGlzYWdyZWVpbmcgd2l0aCBhIHNjYW4gdGhhdCAqcmFuKiAoIzIxMDYpLCBhbmQgd2hpbGVcbiAgICogYSBnYXRlIGlzIGFjdGl2ZSB0aGUgZGlzYWdyZWVtZW50IGlzIGd1YXJhbnRlZWQgYW5kIGNhcnJpZXMgbm9cbiAgICogaW5mb3JtYXRpb24uIE9uIEdSUS0yMyB0aGUgYWxlcnQgY291bnQgdHJhY2tlZCB0aGUgZ2F0ZSBvbmUtZm9yLW9uZSBmb3JcbiAgICogdGhyZWUgZGF5cywgYW5kIHRoYXQgbm9pc2UgaXMgd2hhdCB0YXVnaHQgb3BlcmF0b3JzIHRvIHJlYWQgaXQgYXMgYVxuICAgKiBrbm93biBmYWxzZSBwb3NpdGl2ZSB3aGlsZSB0aGUgcmVhbCBjb25kaXRpb24gaGlkIGJlaGluZCBpdC5cbiAgICpcbiAgICogVGhlIHBlci1yZXBvIGxpbmVzIGFuZCB0aGUgY2xhaW1hYmxlIHRvdGFsIGFyZSB1bmFmZmVjdGVkOiB0aGV5IGFyZSB0aGVcbiAgICogZXZpZGVuY2UgdGhhdCB3b3JrIHdhcyB3YWl0aW5nLiBPbWl0dGVkIOKGkiBoaXN0b3JpY2FsIGJlaGF2aW91ci5cbiAgICovXG4gIGNsYWltR2F0ZUFjdGl2ZT86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBSZXBvc2l0b3JpZXMgdGhlIGNsYWltIHNjYW4gd2FzIG5ldmVyIHNob3duIHRoaXMgY3ljbGUgKElzc3VlICM4OTgpIOKAlFxuICAgKiBzaW5jZSBJc3N1ZSAjMTA5MSB0aGUgcmVwb3MgdGhlIG1haW50ZW5hbmNlIGxhbmUgbGVhc2VkIHdob2xlc2FsZVxuICAgKiAoSXNzdWUgIzIxMyksIHdoaWNoIGBmaW5kT2xkZXN0SXNzdWVgIHNraXBzIGJlZm9yZSBhbnkgZWxpZ2liaWxpdHkgY2hlY2tcbiAgICogcnVucy4gQSBzaWJsaW5nIHNsb3QncyBob2xkIGlzIG5vdCBvbmUgb2YgdGhlbTogaXQgb2NjdXBpZXMgb25lIHdvcmtcbiAgICogc3RyZWFtLCBhbmQgdGhlIHNjYW4gZXZhbHVhdGVzIHRoZSByZXBvc2l0b3J5IGFyb3VuZCBpdC5cbiAgICpcbiAgICogVGhlIHNjYW4gY2Fubm90IGRpc2FncmVlIHdpdGggdGhlIGF1ZGl0IGFib3V0IGEgcmVwb3NpdG9yeSBpdCB3YXMgbm90XG4gICAqIGFsbG93ZWQgdG8gc2VlLCBzbyBzdWNoIGEgcmVwbyByYWlzZXMgbm8gQUxFUlQuIEl0cyBwZXItcmVwbyBsaW5lIGFuZCBpdHNcbiAgICogY29udHJpYnV0aW9uIHRvIHtAbGluayBDbGFpbWFibGVBdWRpdFJlc3VsdC5jbGFpbWFibGVUb3RhbH0gYXJlXG4gICAqIHVuYWZmZWN0ZWQ6IHRoZSB3b3JrIGlzIHJlYWwsIGFuZCB0aGUgaWRsZS10YXNrIGZpbGVyIG11c3Qgc3RheVxuICAgKiBzdXBwcmVzc2VkIHdoaWxlIGl0IHdhaXRzIChJc3N1ZSAjMjgxMykuIE9taXR0ZWQg4oaSIGhpc3RvcmljYWwgYmVoYXZpb3VyLlxuICAgKi9cbiAgaGVsZFJlcG9zPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBQZXItcmVwbyBpc3N1ZSBjYXAgcGFzc2VkIHRvIGBnaCBpc3N1ZSBsaXN0IC0tbGltaXRgLiBEZWZhdWx0IDIwMC4gKi9cbiAgcGVyUmVwb0xpbWl0PzogbnVtYmVyO1xuICAvKiogSW5qZWN0YWJsZSBnaCBydW5uZXIg4oCUIGRlZmF1bHRzIHRvIHRoZSBwcm9kdWN0aW9uIHJldHJ5IHdyYXBwZXIuICovXG4gIGdoQ29tbWFuZEZuPzogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIC8qKlxuICAgKiBSZWFkIGEgcmVwbydzIG9wZW4gaXNzdWVzIChhbHJlYWR5IHBhcnNlZCkgaW5zdGVhZCBvZiBydW5uaW5nXG4gICAqIGBnaCBpc3N1ZSBsaXN0YCB0aHJvdWdoIGBnaENvbW1hbmRGbmAgKElzc3VlICMxNDU2KS4gUHJvZHVjdGlvbiBoYW5kcyBpblxuICAgKiB0aGUgaXRlcmF0aW9uJ3Mgc2hhcmVkIGBJc3N1ZUNhY2hlYC1iYWNrZWQgYGZldGNoQWxsSXNzdWVzYCwgc28gdGhlIGF1ZGl0XG4gICAqIHJlYWRzIHRoZSBzYW1lIGBpc3N1ZXNfYWxsYCBwYXlsb2FkIHRoZSBjZW5zdXMgYW5kIHRoZSBzY2FuIHJlYWQg4oCUIG9uZVxuICAgKiBHcmFwaFFMIGNhbGwgcGVyIHJlcG8gcGVyIHRlbiBtaW51dGVzIGluc3RlYWQgb2YgYW4gdW5jYWNoZWRcbiAgICogYC0tbGltaXQgMjAwYCBsaXN0aW5nIG9uIGV2ZXJ5IGlkbGUgdGljay4gT3B0aW9uYWw7IGFic2VudCwgdGhlIGF1ZGl0XG4gICAqIGxpc3RzIGxpdmUgYXMgYmVmb3JlLlxuICAgKi9cbiAgb3Blbklzc3Vlc0ZuPzogKHJlcG86IHN0cmluZywgbGltaXQ6IG51bWJlcikgPT4gUHJvbWlzZTx1bmtub3duPjtcbiAgLyoqXG4gICAqIFN1cHBsaWVzIGEgcmVwbydzIG9wZW4gUFJzIHNvIHRoZSBhdWRpdCBjYW4gZXhjbHVkZSB3b3JrIHRoZSBQcmlvcml0eSAyXG4gICAqIHNjYW4gd291bGQgcmVmdXNlIHVuZGVyIGBnZXRCbG9ja2luZ1BSRm9ySXNzdWVgIChJc3N1ZSAjNDIyMykuXG4gICAqXG4gICAqIFByb2R1Y3Rpb24gd2lyZXMgdGhpcyB0byB0aGUgaXRlcmF0aW9uLXNjb3BlZCBgcHJzX29wZW5fYWxsYCBjYWNoZSB0aGVcbiAgICogY2Vuc3VzIGFscmVhZHkgcmVhZHMsIHNvIHRoZSBnYXRlIGNvc3RzIG5vIGV4dHJhIEFQSSBjYWxsLiBPbWl0IGl0IOKAlCBvclxuICAgKiBsZXQgaXQgcmVqZWN0IOKAlCBhbmQgdGhlIGF1ZGl0IGZhbGxzIGJhY2sgdG8gbm8gUFIgYmxvY2tpbmcsIGV4YWN0bHkgYXNcbiAgICogYmVmb3JlIHRoaXMgb3B0aW9uIGV4aXN0ZWQuXG4gICAqL1xuICBvcGVuUFJzRm4/OiAocmVwbzogc3RyaW5nKSA9PiBQcm9taXNlPHJlYWRvbmx5IE9wZW5QUltdPjtcbiAgLyoqXG4gICAqIFJlc29sdmVzIGEgcmVwbydzIGZsZWV0IFBSIGNhcCBvbiB0aGUgZGVmYXVsdC1icmFuY2ggc3RyZWFtXG4gICAqIChJc3N1ZSAjMjY2MywgYHJlc29sdmVGbGVldFByU2xvdHNgKSwgc28gdGhlIGF1ZGl0IGFwcGxpZXMgdGhlIHNjYW4nc1xuICAgKiBwZXItc2xvdCBydWxlLiBPbWl0dGVkIOKGkiBgREVGQVVMVF9GTEVFVF9QUl9TTE9UU2AuXG4gICAqL1xuICBmbGVldFByU2xvdHNGb3I/OiAocmVwbzogc3RyaW5nKSA9PiBudW1iZXI7XG4gIC8qKlxuICAgKiBTdXBwbGllcyBhIHJlcG8ncyBjbG9zZWQvbWVyZ2VkIGZsZWV0IFBScyBzbyB0aGUgYXVkaXQgY2FuIGV4Y2x1ZGUgd29ya1xuICAgKiB0aGUgUHJpb3JpdHkgMiBzY2FuIHJlZnVzZXMgcGVybWFuZW50bHkgYXMgYG1lcmdlZC1wci1wZXJtYW5lbnRgXG4gICAqIChHUlEjNDQxOSkuXG4gICAqXG4gICAqIFByb2R1Y3Rpb24gd2lyZXMgdGhpcyB0byB0aGUgaXRlcmF0aW9uLXNjb3BlZCBgcHJzX2Nsb3NlZF8qYCBjYWNoZSB0aGVcbiAgICogc2NhbiBhbHJlYWR5IHBvcHVsYXRlcywgc28gdGhlIGdhdGUgY29zdHMgbm8gZXh0cmEgQVBJIGNhbGwuIE9taXQgaXQg4oCUXG4gICAqIG9yIGxldCBpdCByZWplY3Qg4oCUIGFuZCB0aGUgYXVkaXQgZmFsbHMgYmFjayB0byBubyBtZXJnZWQtUFIgYmxvY2tpbmcsXG4gICAqIGV4YWN0bHkgYXMgYmVmb3JlIHRoaXMgb3B0aW9uIGV4aXN0ZWQuXG4gICAqL1xuICBtZXJnZWRQUnNGbj86IChyZXBvOiBzdHJpbmcpID0+IFByb21pc2U8cmVhZG9ubHkgQ2xvc2VkUFJbXT47XG4gIC8qKlxuICAgKiBTdXBwbGllcyBhIHJlcG8ncyAqKm9wZW4qKiBtaWxlc3RvbmUgdGl0bGVzIHNvIHRoZSBhdWRpdCBjYW4gbW9kZWwgdGhlXG4gICAqIGNyb3NzLW1pbGVzdG9uZSBkZXBlbmRlbmN5IGhvbGQgKGBpc0RlcGVuZGVuY3lCbG9ja2VkYCwgSXNzdWUgIzIxNzMpIHRoYXRcbiAgICogdGhlIFByaW9yaXR5IDIgc2NhbiBhbHJlYWR5IGFwcGxpZXMg4oCUIHNlZVxuICAgKiB7QGxpbmsgQ2xhc3NpZnlPcHRpb25zLm9wZW5NaWxlc3RvbmVzfSAoSXNzdWUgIzI1MzMpLlxuICAgKlxuICAgKiBQcm9kdWN0aW9uIHdpcmVzIHRoaXMgdG8gdGhlIGNhY2hlZCBgZmV0Y2hPcGVuTWlsZXN0b25lQ2xvc2VkQ291bnRzYFxuICAgKiBsaXN0aW5nLCBzbyB0aGUgZ2F0ZSBjb3N0cyBvbmUgY2FjaGVkIHJlYWQgcGVyIHJlcG8gYW5kIG5vIGV4dHJhIEFQSSBjYWxsXG4gICAqIHBlciB0aWNrLiBPbWl0IGl0IOKAlCBvciBsZXQgaXQgcmVqZWN0IOKAlCBhbmQgdGhlIGF1ZGl0IGZhbGxzIGJhY2sgdG8gbm9cbiAgICogY3Jvc3MtbWlsZXN0b25lIGhvbGQsIGV4YWN0bHkgYXMgYmVmb3JlIHRoaXMgb3B0aW9uIGV4aXN0ZWQsIHdoaWNoIGlzIHRoZVxuICAgKiBzYW1lIGZhaWwtb3BlbiBjb250cmFjdCBhcyBgb3BlblBSc0ZuYC5cbiAgICovXG4gIG9wZW5NaWxlc3RvbmVzRm4/OiAocmVwbzogc3RyaW5nKSA9PiBQcm9taXNlPFJlYWRvbmx5U2V0PHN0cmluZz4+O1xuICAvKipcbiAgICogVHJ1ZSB3aGVuIHRoaXMgcnVuIGlzIGhvbGRpbmcgYGlzc3VlTnVtYmVyYCBpbiBgcmVwb2AgYmFjayByZWdhcmRsZXNzIG9mXG4gICAqIHdoYXQgR2l0SHViIHNheXMgKElzc3VlICM2NTUpIOKAlCB0aGUgc2FtZSBgaXNJc3N1ZUluQ29vbGRvd25gIHByZWRpY2F0ZVxuICAgKiB0aGUgY2xhaW0gc2NhbiBmaWx0ZXJzIGl0cyBjYW5kaWRhdGVzIGFnYWluc3QuXG4gICAqXG4gICAqIFByb2R1Y3Rpb24gd2lyZXMgdGhpcyB0byB0aGUgb25lIGhvbGQgc2V0IHRoZSBzY2FuIGFuZCB0aGUgY2Vuc3VzIGFsc29cbiAgICogcmVhZCwgc28gYWxsIHRocmVlIGluc3RydW1lbnRzIGFncmVlLiBUaGUgcHJlZGljYXRlIGlzIGNhbGxlZCBwZXIgaXNzdWVcbiAgICogYW5kIG11c3QgYmUgY2hlYXA7IGEgdGhyb3cgaXMgY2F1Z2h0IGFuZCBmYWxscyBiYWNrIHRvIG5vIGhvbGQsIGV4YWN0bHlcbiAgICogYXMgdGhlIFBSIGZldGNoZXMgZG8g4oCUIG9taXR0aW5nIHRoZSBnYXRlIHJlc3RvcmVzIHRoZSBvbGQgb3Zlci1jb3VudFxuICAgKiByYXRoZXIgdGhhbiBzaWxlbnRseSByZXBvcnRpbmcgYSByZXBvIGFzIGhhdmluZyBub3RoaW5nIHRvIGRvLlxuICAgKlxuICAgKiBJdCBhbHNvIHJlY2VpdmVzIHRoZSBpc3N1ZSdzIG1pbGVzdG9uZSB0aXRsZSAoYFwiXCJgIHdoZW4gbm9uZSksIHNvXG4gICAqIHByb2R1Y3Rpb24gY2FuIGhvbGQgZXZlcnkgaXNzdWUgb2YgYSBtaWxlc3RvbmUgdGhlIHBlcnNpc3RlZCBwYWNpbmdcbiAgICogbGVkZ2VyIHBhY2VzIChJc3N1ZSAjMzU4Nykg4oCUIHRoZSBjbGFpbSBzY2FuJ3MgYG1pbGVzdG9uZS1iZWhpbmRgIHNraXAuXG4gICAqL1xuICBydW5Mb2NhbEhvbGRGbj86IChcbiAgICByZXBvOiBzdHJpbmcsXG4gICAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgICBtaWxlc3RvbmU6IHN0cmluZyxcbiAgKSA9PiBib29sZWFuO1xuICAvKipcbiAgICogV2hldGhlciB0aGUgd2Vla2x5LXF1b3RhIHBhY2UgZ3VhcmQgaXMgZW5nYWdlZCBmb3IgdGhpcyBjeWNsZSAoSXNzdWVzXG4gICAqICMxODg1LCAjMTkxNSkg4oCUIGZvcndhcmRlZCB2ZXJiYXRpbSB0b1xuICAgKiB7QGxpbmsgQ2xhc3NpZnlPcHRpb25zLndlZWtQYWNlRW5nYWdlZH0sIHNvIHRoZSBhdWRpdCBjb3VudHMgb25seSB3b3JrXG4gICAqIHRoZSBzY2FuIGNvdWxkIGFjdHVhbGx5IGNsYWltLiBPbWl0dGVkIOKGkiBvZmYuXG4gICAqL1xuICB3ZWVrUGFjZUVuZ2FnZWQ/OiBib29sZWFuO1xuICAvKipcbiAgICogV2hldGhlciB0aGUgcXVvdGEgcG9sbGluZyBnYXRlIGRlZmVycmVkIHRoZSBpZGxlLXRhc2sgdGllciB0aGlzIHNjYW5cbiAgICogKElzc3VlICMzNjI4KSDigJQgZm9yd2FyZGVkIHZlcmJhdGltIHRvXG4gICAqIHtAbGluayBDbGFzc2lmeU9wdGlvbnMucXVvdGFJZGxlRGVmZXJyZWR9LCBzbyB0aGUgYXVkaXQgY291bnRzIG9ubHlcbiAgICogd29yayB0aGUgc2NhbiBjb3VsZCBhY3R1YWxseSBjbGFpbS4gT21pdHRlZCDihpIgb2ZmLlxuICAgKi9cbiAgcXVvdGFJZGxlRGVmZXJyZWQ/OiBib29sZWFuO1xuICAvKipcbiAgICogSXNzdWVzIGluIGByZXBvYCB3aG9zZSBwcmlvcml0eSBsYWJlbCBhbiB1bnRydXN0ZWQgYXV0aG9yIGFkZGVkIChJc3N1ZVxuICAgKiAjNDIxMikuIFRoZSByZXN1bHQgaXMgcGFzc2VkIHRvIHtAbGluayBDbGFzc2lmeU9wdGlvbnMudW50cnVzdGVkTGFiZWxJc3N1ZXN9LlxuICAgKlxuICAgKiBCZXN0LWVmZm9ydDogYSByZWplY3Rpb24gaXMgbG9nZ2VkIGFzXG4gICAqIGBhY3Rpb249d2FybiByZWFzb249dW50cnVzdGVkX2xhYmVsX2xvb2t1cF9mYWlsZWRgLCBuYW1pbmcgdGhlIHJlcG8gYW5kXG4gICAqIHRoZSBlcnJvciwgYW5kIHRoZSBhdWRpdCBmYWxscyBiYWNrIHRvIGFuIGVtcHR5IHNldC4gVGhhdCByZXN0b3JlcyB0aGVcbiAgICogb2xkIG92ZXItY291bnQgcmF0aGVyIHRoYW4gcmVwb3J0aW5nIGEgbG9va3VwIGZhdWx0IGFzIHplcm8gY2xhaW1hYmxlXG4gICAqIHdvcmsuIE9taXR0ZWQg4oaSIHRoZSBnYXRlIGlzIHNraXBwZWQuXG4gICAqL1xuICB1bnRydXN0ZWRMYWJlbElzc3Vlc0ZuPzogKFxuICAgIHJlcG86IHN0cmluZyxcbiAgICBpc3N1ZXM6IHJlYWRvbmx5IHsgbnVtYmVyOiBudW1iZXI7IGxhYmVsczogcmVhZG9ubHkgc3RyaW5nW10gfVtdLFxuICApID0+IFByb21pc2U8UmVhZG9ubHlTZXQ8bnVtYmVyPj47XG4gIC8qKiBQcm9ncmVzcyBsb2cgc2luay4gRGVmYXVsdHMgdG8gYGNvbnNvbGUubG9nYC4gKi9cbiAgbG9nPzogKGxpbmU6IHN0cmluZykgPT4gdm9pZDtcbiAgLyoqIEhvc3RuYW1lIHNvdXJjZSDigJQgZXhwb3NlZCBmb3IgdGVzdHMuIERlZmF1bHRzIHRvIGBEZW5vLmhvc3RuYW1lKClgLiAqL1xuICBob3N0bmFtZUZuPzogKCkgPT4gc3RyaW5nO1xuICAvKiogUHJvY2VzcyBpZCBzb3VyY2Ug4oCUIGV4cG9zZWQgZm9yIHRlc3RzLiBEZWZhdWx0cyB0byBgRGVuby5waWRgLiAqL1xuICBwaWRGbj86ICgpID0+IG51bWJlcjtcbn1cblxuY29uc3QgREVGQVVMVF9QRVJfUkVQT19MSU1JVCA9IDIwMDtcblxuLyoqXG4gKiBBdWRpdCBldmVyeSByZXBvIGluIGBvcHRzLnJlcG9zYCBhbmQgZW1pdCBvbmUgYFtpZGxlLWRldGVjdF1gIGxpbmUgcGVyXG4gKiByZXBvLCBhIHBlci10aWNrIHN1bW1hcnkgbGluZSwgYW5kICh3aGVuIHRoZSB2ZXJkaWN0IGRpc2FncmVlcyB3aXRoXG4gKiB0aGUgc2NhbikgYSBgbWlzX2NsYXNzaWZpY2F0aW9uYCBBTEVSVCBsaW5lLiBSZXR1cm5zIHRoZSBzdHJ1Y3R1cmVkXG4gKiB2ZXJkaWN0IHNvIGNhbGxlcnMgY2FuIGFzc2VydCBvbiBpdCBpbiB0ZXN0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGF1ZGl0Q2xhaW1hYmxlU3RhdGUoXG4gIG9wdHM6IEF1ZGl0Q2xhaW1hYmxlU3RhdGVPcHRpb25zLFxuKTogUHJvbWlzZTxDbGFpbWFibGVBdWRpdFJlc3VsdD4ge1xuICBjb25zdCBnaEZuID0gb3B0cy5naENvbW1hbmRGbiA/PyBydW5HaENvbW1hbmQ7XG4gIGNvbnN0IGxvZyA9IG9wdHMubG9nID8/ICgobGluZTogc3RyaW5nKSA9PiBjb25zb2xlLmxvZyhsaW5lKSk7XG4gIGNvbnN0IGxpbWl0ID0gb3B0cy5wZXJSZXBvTGltaXQgPz8gREVGQVVMVF9QRVJfUkVQT19MSU1JVDtcblxuICBjb25zdCBob3N0bmFtZUZuID0gb3B0cy5ob3N0bmFtZUZuID8/ICgoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBEZW5vLmhvc3RuYW1lKCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gXCJ1bmtub3duLWhvc3RcIjtcbiAgICB9XG4gIH0pO1xuICBjb25zdCBwaWRGbiA9IG9wdHMucGlkRm4gPz8gKCgpID0+IERlbm8ucGlkKTtcbiAgY29uc3QgaG9zdCA9IGAke2hvc3RuYW1lRm4oKX06JHtwaWRGbigpfWA7XG5cbiAgY29uc3QgcGVyUmVwbzogUmVwb0NsYWltYWJsZVNuYXBzaG90W10gPSBbXTtcbiAgZm9yIChjb25zdCByZXBvIG9mIG9wdHMucmVwb3MpIHtcbiAgICBjb25zdCByZWNvcmRQcm9iZUVycm9yID0gKFxuICAgICAgZXJyb3JNZXNzYWdlOiBzdHJpbmcsXG4gICAgICBsb2dNZXNzYWdlOiBzdHJpbmcsXG4gICAgKTogdm9pZCA9PiB7XG4gICAgICBjb25zdCBmYWlsdXJlS2luZCA9IGNsYXNzaWZ5UHJvYmVGYWlsdXJlKGVycm9yTWVzc2FnZSk7XG4gICAgICBjb25zdCBzbmFwOiBSZXBvQ2xhaW1hYmxlU25hcHNob3QgPSB7XG4gICAgICAgIHJlcG8sXG4gICAgICAgIHRvdGFsT3BlbjogMCxcbiAgICAgICAgY2xhaW1hYmxlOiAwLFxuICAgICAgICByZWFzb246IFwicHJvYmVfZXJyb3JcIixcbiAgICAgICAgZXJyb3JNZXNzYWdlLFxuICAgICAgICBmYWlsdXJlS2luZCxcbiAgICAgIH07XG4gICAgICBwZXJSZXBvLnB1c2goc25hcCk7XG4gICAgICByZWNvcmRSZXBvUHJvYmVCZXN0RWZmb3J0KHJlcG8sIGZhaWx1cmVLaW5kKTtcbiAgICAgIC8vIGByZWFzb249cHJvYmVfZXJyb3JgIGlzIGRlbGliZXJhdGVseSB1bmNoYW5nZWQg4oCUIGRvd25zdHJlYW0gbG9nXG4gICAgICAvLyBjb25zdW1lcnMgcGFyc2UgaXQ7IGBmYWlsdXJlX2tpbmRgIGlzIGFkZGl0aXZlLlxuICAgICAgbG9nKFxuICAgICAgICBgW2lkbGUtZGV0ZWN0XSB0aWNrPSR7b3B0cy50aWNrfSBob3N0PSR7aG9zdH0gcmVwbz0ke3JlcG99IHRvdGFsX29wZW49MCBjbGFpbWFibGU9MCByZWFzb249cHJvYmVfZXJyb3IgZmFpbHVyZV9raW5kPSR7ZmFpbHVyZUtpbmR9IG1lc3NhZ2U9JHtsb2dNZXNzYWdlfWAsXG4gICAgICApO1xuICAgIH07XG5cbiAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgIGlmIChvcHRzLm9wZW5Jc3N1ZXNGbikge1xuICAgICAgLy8gVGhlIHNoYXJlZCwgY2FjaGVkIHJlYWQg4oCUIG5vIGBnaGAgY2FsbCBvZiB0aGUgYXVkaXQncyBvd24uXG4gICAgICB0cnkge1xuICAgICAgICBwYXJzZWQgPSBhd2FpdCBvcHRzLm9wZW5Jc3N1ZXNGbihyZXBvLCBsaW1pdCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgICAgcmVjb3JkUHJvYmVFcnJvcihtZXNzYWdlLCBtZXNzYWdlKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGxldCByYXc6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHJhdyA9IGF3YWl0IGdoRm4oW1xuICAgICAgICAgIFwiaXNzdWVcIixcbiAgICAgICAgICBcImxpc3RcIixcbiAgICAgICAgICBcIi0tcmVwb1wiLFxuICAgICAgICAgIHJlcG8sXG4gICAgICAgICAgXCItLXN0YXRlXCIsXG4gICAgICAgICAgXCJvcGVuXCIsXG4gICAgICAgICAgXCItLWpzb25cIixcbiAgICAgICAgICAvLyBJc3N1ZSAjODU3OiBgYm9keWAgY2FycmllcyB0aGUgZGVwZW5kZW5jeSByZWZlcmVuY2VzIHRoZSBzY2FuJ3NcbiAgICAgICAgICAvLyBlaWdodGggZ2F0ZSByZWFkcy4gT25lIGV4dHJhIGZpZWxkIG9uIGEgY2FsbCBhbHJlYWR5IGJlaW5nIG1hZGUg4oCUXG4gICAgICAgICAgLy8gbm8gZXh0cmEgcmVxdWVzdCwgbWF0Y2hpbmcgaG93IHRoZSBjZW5zdXMgZ2V0cyBpdCBmcmVlLlxuICAgICAgICAgIC8vIElzc3VlICMxMDUwOiBgdGl0bGVgIGZvciB0aGUgc2FtZSByZWFzb24g4oCUIGl0IGlzIHRoZSBmYWxsYmFja1xuICAgICAgICAgIC8vIGBpc01pbGVzdG9uZVRyYWNraW5nSXNzdWVgIGZhbGxzIGJhY2sgdG8gZm9yIHRyYWNrZXJzIGZpbGVkIGJlZm9yZVxuICAgICAgICAgIC8vIHRoZSBib2R5IG1hcmtlciBleGlzdGVkLlxuICAgICAgICAgIC8vIElzc3VlICMzMzE0OiBgc3ViSXNzdWVzU3VtbWFyeWAgZm9yIG5hdGl2ZSBzdWItaXNzdWUgYmxvY2tpbmcsXG4gICAgICAgICAgLy8gc2FtZSBmcmVlIGZpZWxkIGFzIHRoZSBjZW5zdXMncyBvd24gY2FsbC5cbiAgICAgICAgICBcIm51bWJlcix0aXRsZSxsYWJlbHMsYXNzaWduZWVzLG1pbGVzdG9uZSxib2R5LHN1Yklzc3Vlc1N1bW1hcnlcIixcbiAgICAgICAgICBcIi0tbGltaXRcIixcbiAgICAgICAgICBTdHJpbmcobGltaXQpLFxuICAgICAgICBdKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgICByZWNvcmRQcm9iZUVycm9yKG1lc3NhZ2UsIG1lc3NhZ2UpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICAgIHJlY29yZFByb2JlRXJyb3IoYHBhcnNlX2ZhaWxlZDogJHttZXNzYWdlfWAsIFwicGFyc2VfZmFpbGVkXCIpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBpc3N1ZXMgPSBBcnJheS5pc0FycmF5KHBhcnNlZClcbiAgICAgID8gcGFyc2VkLm1hcChub3JtYWxpc2VJc3N1ZSkuZmlsdGVyKChpKTogaSBpcyBOb25OdWxsYWJsZTx0eXBlb2YgaT4gPT5cbiAgICAgICAgaSAhPT0gbnVsbFxuICAgICAgKVxuICAgICAgOiBbXTtcblxuICAgIC8vIElzc3VlICM0MjIzOiByZWFkIHRoZSByZXBvJ3Mgb3BlbiBQUnMgc28gUFItYmxvY2tlZCB3b3JrIGlzIG5vdCBjb3VudGVkXG4gICAgLy8gYXMgY2xhaW1hYmxlLiBCZXN0LWVmZm9ydCBieSBkZXNpZ24g4oCUIGEgZmFpbGVkIGZldGNoIGZhbGxzIGJhY2sgdG8gbm8gUFJcbiAgICAvLyBibG9ja2luZywgd2hpY2ggYXQgd29yc3QgcmVzdG9yZXMgdGhlIG9sZCBvdmVyLWNvdW50IHJhdGhlciB0aGFuXG4gICAgLy8gc2lsZW50bHkgcmVwb3J0aW5nIGEgcmVwbyBhcyBoYXZpbmcgbm90aGluZyB0byBkby5cbiAgICBsZXQgb3BlblBSczogcmVhZG9ubHkgT3BlblBSW10gPSBbXTtcbiAgICBpZiAob3B0cy5vcGVuUFJzRm4pIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIG9wZW5QUnMgPSBhd2FpdCBvcHRzLm9wZW5QUnNGbihyZXBvKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBvcGVuUFJzID0gW107XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gR1JRIzQ0MTk6IHJlYWQgdGhlIHJlcG8ncyBtZXJnZWQgZmxlZXQgUFJzIHNvIGEgcGVybWFuZW50bHkgc3RyYW5kZWRcbiAgICAvLyBpc3N1ZSBpcyBub3QgY291bnRlZCBhcyBjbGFpbWFibGUuIEJlc3QtZWZmb3J0IGJ5IHRoZSBzYW1lIHJ1bGUgYXMgdGhlXG4gICAgLy8gb3Blbi1QUiBmZXRjaCBhYm92ZSDigJQgYSBmYWlsdXJlIHJlc3RvcmVzIHRoZSBvbGQgb3Zlci1jb3VudCByYXRoZXIgdGhhblxuICAgIC8vIHNpbGVudGx5IHJlcG9ydGluZyBhIHJlcG8gYXMgaGF2aW5nIG5vdGhpbmcgdG8gZG8uXG4gICAgbGV0IG1lcmdlZFBSczogcmVhZG9ubHkgQ2xvc2VkUFJbXSA9IFtdO1xuICAgIGlmIChvcHRzLm1lcmdlZFBSc0ZuKSB7XG4gICAgICB0cnkge1xuICAgICAgICBtZXJnZWRQUnMgPSBhd2FpdCBvcHRzLm1lcmdlZFBSc0ZuKHJlcG8pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIG1lcmdlZFBScyA9IFtdO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIElzc3VlICMyNTMzOiB0aGUgcmVwbydzIG9wZW4gbWlsZXN0b25lIHRpdGxlcywgc28gYSBkZXBlbmRlbmN5IHRoYXQgaXNcbiAgICAvLyBjbG9zZWQgaW5zaWRlIGFub3RoZXIgc3RpbGwtb3BlbiBtaWxlc3RvbmUgcmVhZHMgYXMgaGVsZCByYXRoZXIgdGhhblxuICAgIC8vIGNsYWltYWJsZS4gQmVzdC1lZmZvcnQgYnkgdGhlIHNhbWUgcnVsZSBhcyB0aGUgdHdvIGZldGNoZXMgYWJvdmUg4oCUIGFcbiAgICAvLyByZWplY3Rpb24gYXBwbGllcyBubyBob2xkIGFuZCBuZXZlciB0aHJvd3MuXG4gICAgbGV0IG9wZW5NaWxlc3RvbmVzOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgaWYgKG9wdHMub3Blbk1pbGVzdG9uZXNGbikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgb3Blbk1pbGVzdG9uZXMgPSBhd2FpdCBvcHRzLm9wZW5NaWxlc3RvbmVzRm4ocmVwbyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgb3Blbk1pbGVzdG9uZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBJc3N1ZSAjNjU1OiByZXNvbHZlIHRoaXMgcnVuJ3Mgb3duIGhvbGRzIGZvciB0aGUgcmVwbywgc28gd29yayB0aGVcbiAgICAvLyBjbGFpbSBzY2FuIGlzIHNpbGVudGx5IGFuZCBjb3JyZWN0bHkgcmVmdXNpbmcgaXMgbm90IGNvdW50ZWQgYXNcbiAgICAvLyBjbGFpbWFibGUgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzLiBCZXN0LWVmZm9ydCBieSB0aGUgc2FtZSBydWxlIGFzXG4gICAgLy8gdGhlIHR3byBmZXRjaGVzIGFib3ZlLlxuICAgIGxldCBydW5Mb2NhbEhvbGRzID0gbmV3IFNldDxudW1iZXI+KCk7XG4gICAgaWYgKG9wdHMucnVuTG9jYWxIb2xkRm4pIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJ1bkxvY2FsSG9sZHMgPSBuZXcgU2V0KFxuICAgICAgICAgIGlzc3Vlc1xuICAgICAgICAgICAgLmZpbHRlcigoaSkgPT4gb3B0cy5ydW5Mb2NhbEhvbGRGbiEocmVwbywgaS5udW1iZXIsIGkubWlsZXN0b25lKSlcbiAgICAgICAgICAgIC5tYXAoKGkpID0+IGkubnVtYmVyKSxcbiAgICAgICAgKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBydW5Mb2NhbEhvbGRzID0gbmV3IFNldDxudW1iZXI+KCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gSXNzdWUgIzg1NzogdGhlIHJlcG8ncyBvd24gb3BlbiBpc3N1ZXMsIHJlc29sdmVkIGZyb20gdGhlIHJlc3BvbnNlXG4gICAgLy8gYWxyZWFkeSBpbiBoYW5kLiBDYXBwZWQgYnkgYHBlclJlcG9MaW1pdGAgbGlrZSBldmVyeXRoaW5nIGVsc2UgaGVyZSwgc29cbiAgICAvLyBhIGRlcGVuZGVuY3kgYmV5b25kIHRoZSBjYXAgcmVhZHMgYXMgY2xvc2VkIOKAlCBhbiB1bmRlci1jb3VudCwgdGhlIHNhbWVcbiAgICAvLyBmYWlsLXNhZmUgZGlyZWN0aW9uIGV2ZXJ5IG90aGVyIGdhdGUgdGFrZXMuXG4gICAgY29uc3Qgb3Blbklzc3VlTnVtYmVycyA9IG5ldyBTZXQoaXNzdWVzLm1hcCgoaSkgPT4gaS5udW1iZXIpKTtcblxuICAgIC8vIElzc3VlICM0MjEyOiB0aGUgY2xhaW0gc2NhbidzIGxhYmVsLWF1dGhvciBnYXRlLiBBIHJlamVjdGVkIGxvb2t1cFxuICAgIC8vIGZhbGxzIGJhY2sgdG8gYW4gZW1wdHkgc2V0IOKAlCB0aGUgb2xkIG92ZXItY291bnQg4oCUIGFuZCB0aGUgd2FybmluZ1xuICAgIC8vIG5hbWVzIHRoZSBmYXVsdC4gVHJlYXRpbmcgdGhlIGZhaWx1cmUgYXMgbm90aGluZyBjbGFpbWFibGUgd291bGRcbiAgICAvLyBoaWRlIGl0LlxuICAgIGxldCB1bnRydXN0ZWRMYWJlbElzc3VlczogUmVhZG9ubHlTZXQ8bnVtYmVyPiA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICAgIGlmIChvcHRzLnVudHJ1c3RlZExhYmVsSXNzdWVzRm4pIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHVudHJ1c3RlZExhYmVsSXNzdWVzID0gYXdhaXQgb3B0cy51bnRydXN0ZWRMYWJlbElzc3Vlc0ZuKHJlcG8sIGlzc3Vlcyk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgICAgbG9nKFxuICAgICAgICAgIGBbaWRsZS1kZXRlY3RdIHRpY2s9JHtvcHRzLnRpY2t9IGhvc3Q9JHtob3N0fSByZXBvPSR7cmVwb30gYWN0aW9uPXdhcm4gcmVhc29uPXVudHJ1c3RlZF9sYWJlbF9sb29rdXBfZmFpbGVkIG1lc3NhZ2U9JHttZXNzYWdlfWAsXG4gICAgICAgICk7XG4gICAgICAgIHVudHJ1c3RlZExhYmVsSXNzdWVzID0gbmV3IFNldDxudW1iZXI+KCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgdmVyZGljdHMgPSBjbGFzc2lmeUlzc3Vlcyhpc3N1ZXMsIHtcbiAgICAgIHdvcmtlclVzZXI6IG9wdHMud29ya2VyVXNlcixcbiAgICAgIHB1c2hDYXBhYmxlQXV0aG9yczogb3B0cy5wdXNoQ2FwYWJsZUF1dGhvcnMsXG4gICAgICBvcGVuUFJzLFxuICAgICAgZmxlZXRQclNsb3RzOiBvcHRzLmZsZWV0UHJTbG90c0Zvcj8uKHJlcG8pLFxuICAgICAgbWVyZ2VkUFJzLFxuICAgICAgcnVuTG9jYWxIb2xkcyxcbiAgICAgIHJlcG8sXG4gICAgICBvcGVuSXNzdWVOdW1iZXJzLFxuICAgICAgLy8gSXNzdWUgIzI1MzM6IGEgZGVwZW5kZW5jeSBjbG9zZWQgaW5zaWRlIGFub3RoZXIgb3BlbiBtaWxlc3RvbmUgaXNcbiAgICAgIC8vIGhlbGQgYnkgdGhlIHNjYW4gdW50aWwgdGhhdCBtaWxlc3RvbmUgbWVyZ2VzLlxuICAgICAgb3Blbk1pbGVzdG9uZXMsXG4gICAgICAvLyBJc3N1ZSAjMTI0OTogdGhlIGF1ZGl0IGFscmVhZHkga25vd3Mgd2hpY2ggcmVwb3NpdG9yaWVzIHRoZSBmbGVldFxuICAgICAgLy8gbW9uaXRvcnMsIHNvIGEgZGVwZW5kZW5jeSBvbiBhbnl0aGluZyBlbHNlIGlzIG5vdCBhIGJsb2NrZXIgaXQgY2FuXG4gICAgICAvLyBiZSBzaWxlbmNlZCBieS5cbiAgICAgIGtub3duUmVwb3M6IG9wdHMucmVwb3MsXG4gICAgICAvLyBJc3N1ZXMgIzE4ODUsICMxOTE1OiBhIHRpZXIgdGhlIHBhY2UgZ2F0ZSBkcm9wcGVkIGlzIGEgbW9kZWxsZWRcbiAgICAgIC8vIHJlZnVzYWwsIG5vdCBjbGFpbWFibGUgd29yayB0aGUgc2NhbiBteXN0ZXJpb3VzbHkgcGFzc2VkIG92ZXIuXG4gICAgICB3ZWVrUGFjZUVuZ2FnZWQ6IG9wdHMud2Vla1BhY2VFbmdhZ2VkLFxuICAgICAgLy8gSXNzdWUgIzM2Mjg6IHRoZSBxdW90YSBnYXRlJ3MgaWRsZS10aWVyIGRlZmVycmFsIGlzIHRoZSBzYW1lIHNoYXBlIOKAlFxuICAgICAgLy8gYSBtb2RlbGxlZCByZWZ1c2FsLCBub3QgYSBtaXNjbGFzc2lmaWNhdGlvbi5cbiAgICAgIHF1b3RhSWRsZURlZmVycmVkOiBvcHRzLnF1b3RhSWRsZURlZmVycmVkLFxuICAgICAgdW50cnVzdGVkTGFiZWxJc3N1ZXMsXG4gICAgfSk7XG4gICAgY29uc3QgY2xhaW1hYmxlQ291bnQgPSB2ZXJkaWN0cy5maWx0ZXIoKHYpID0+IHYuY2xhaW1hYmxlKS5sZW5ndGg7XG4gICAgY29uc3QgcmVhc29uOiBDbGFpbWFibGVTa2lwUmVhc29uID0gY2xhaW1hYmxlQ291bnQgPiAwXG4gICAgICA/IFwiaGFzX2NsYWltYWJsZVwiXG4gICAgICA6IHBpY2tEb21pbmFudFJlYXNvbih2ZXJkaWN0cyk7XG5cbiAgICBwZXJSZXBvLnB1c2goe1xuICAgICAgcmVwbyxcbiAgICAgIHRvdGFsT3BlbjogaXNzdWVzLmxlbmd0aCxcbiAgICAgIGNsYWltYWJsZTogY2xhaW1hYmxlQ291bnQsXG4gICAgICByZWFzb24sXG4gICAgfSk7XG4gICAgLy8gSXNzdWUgIzQwMzc6IGdoIGFuc3dlcmVkIGZvciB0aGlzIHJlcG8sIHNvIHRoZSBpZGVudGl0eSBjYW4gc3RpbGxcbiAgICAvLyBzZWUgaXQg4oCUIHRoZSBvbmUgb3V0Y29tZSB0aGF0IGNsZWFycyBhIHByaW9yIGRlbmlhbCBjb3VudC5cbiAgICByZWNvcmRSZXBvUHJvYmVCZXN0RWZmb3J0KHJlcG8sIFwib2tcIik7XG5cbiAgICBsb2coXG4gICAgICBgW2lkbGUtZGV0ZWN0XSB0aWNrPSR7b3B0cy50aWNrfSBob3N0PSR7aG9zdH0gcmVwbz0ke3JlcG99IHRvdGFsX29wZW49JHtpc3N1ZXMubGVuZ3RofSBjbGFpbWFibGU9JHtjbGFpbWFibGVDb3VudH0gcmVhc29uPSR7cmVhc29ufWAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGNsYWltYWJsZVRvdGFsID0gcGVyUmVwby5yZWR1Y2UoKHN1bSwgcikgPT4gc3VtICsgci5jbGFpbWFibGUsIDApO1xuICAvLyBJc3N1ZSAjODk4OiBhIHJlcG8gaGVsZCB3aG9sZXNhbGUgd2FzIHNraXBwZWQgYmVmb3JlIGFueSBlbGlnaWJpbGl0eVxuICAvLyBjaGVjayByYW4sIHNvIHRoZSBzY2FuIGNsYWltaW5nIG5vdGhpbmcgZnJvbSBpdCBpcyBub3QgYSBkaXNhZ3JlZW1lbnQuXG4gIGNvbnN0IGhlbGRSZXBvcyA9IG5ldyBTZXQob3B0cy5oZWxkUmVwb3MgPz8gW10pO1xuICBjb25zdCBtaXNDbGFzc2lmaWNhdGlvblJlcG9zID0gcGVyUmVwb1xuICAgIC5maWx0ZXIoKHIpID0+IHIuY2xhaW1hYmxlID4gMCAmJiAhaGVsZFJlcG9zLmhhcyhyLnJlcG8pKVxuICAgIC5tYXAoKHIpID0+IHIucmVwbyk7XG4gIC8vIElzc3VlICM0Nzk6IGEgZ2F0ZWQgY3ljbGUgbmV2ZXIgcmFuIHRoZSBzY2FuLCBzbyBhIGRpc2FncmVlbWVudCB3aXRoIGl0XG4gIC8vIGlzIG5vdCBldmlkZW5jZSBvZiBhbnl0aGluZy5cbiAgY29uc3QgbWlzQ2xhc3NpZmljYXRpb24gPSAhb3B0cy5zY2FuRm91bmRDbGFpbWFibGUgJiZcbiAgICBtaXNDbGFzc2lmaWNhdGlvblJlcG9zLmxlbmd0aCA+IDAgJiZcbiAgICBvcHRzLmNsYWltR2F0ZUFjdGl2ZSAhPT0gdHJ1ZTtcblxuICBsb2coXG4gICAgYFtpZGxlLWRldGVjdF0gdGljaz0ke29wdHMudGlja30gaG9zdD0ke2hvc3R9IHJlcG9zPSR7b3B0cy5yZXBvcy5sZW5ndGh9IGNsYWltYWJsZV90b3RhbD0ke2NsYWltYWJsZVRvdGFsfWAsXG4gICk7XG5cbiAgaWYgKG1pc0NsYXNzaWZpY2F0aW9uKSB7XG4gICAgLy8gT3BlcmF0b3JzIGdyZXAgdGhlIGxpdGVyYWwgYG1pc19jbGFzc2lmaWNhdGlvbmAgdG9rZW4gdG8gc3VyZmFjZVxuICAgIC8vIHRoZSByZWdyZXNzaW9uICMyMTA2IHNldCBvdXQgdG8gY2F0Y2guXG4gICAgbG9nKFxuICAgICAgYFtpZGxlLWRldGVjdF0gdGljaz0ke29wdHMudGlja30gaG9zdD0ke2hvc3R9IEFMRVJUIG1pc19jbGFzc2lmaWNhdGlvbiBjbGFpbWFibGVfdG90YWw9JHtjbGFpbWFibGVUb3RhbH0gcmVwb3M9JHtcbiAgICAgICAgbWlzQ2xhc3NpZmljYXRpb25SZXBvcy5qb2luKFwiLFwiKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgdGljazogb3B0cy50aWNrLFxuICAgIGhvc3QsXG4gICAgcGVyUmVwbyxcbiAgICBjbGFpbWFibGVUb3RhbCxcbiAgICBtaXNDbGFzc2lmaWNhdGlvbixcbiAgICBtaXNDbGFzc2lmaWNhdGlvblJlcG9zLFxuICB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWtHQyxHQUVELFNBQVMsWUFBWSxRQUFRLGNBQWM7QUFDM0MsU0FFRSxxQkFBcUIsRUFDckIsZ0JBQWdCLEVBQ2hCLDJCQUEyQixFQUUzQixxQkFBcUIsUUFDaEIsbUJBQW1CO0FBQzFCLFNBQ0UsNEJBQTRCLEVBRTVCLG1CQUFtQixFQUNuQix3QkFBd0IsRUFDeEIsbUJBQW1CLFFBQ2Qsb0JBQW9CO0FBQzNCLFNBQVMsY0FBYyxRQUFRLHVCQUF1QjtBQUN0RCxTQUFTLGVBQWUsUUFBUSx1QkFBdUI7QUFDdkQsdUVBQXVFO0FBQ3ZFLFNBQVMseUJBQXlCLFFBQVEsNkJBQTZCO0FBQ3ZFLFNBQVMsbUNBQW1DLFFBQVEsMEJBQTBCO0FBQzlFLFNBQVMsY0FBYyxRQUFRLHFCQUFxQjtBQUVwRCw4RUFBOEU7QUFDOUUsYUFBYTtBQUNiLDhFQUE4RTtBQUU5RTs7Ozs7Q0FLQyxHQUNELE9BQU8sTUFBTSxtQkFBc0M7RUFDakQsZUFBZSxnQkFBZ0I7RUFDL0IsZUFBZSxXQUFXO0VBQzFCLGVBQWUs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
// denoCacheMetadata=15372453945371101842,7363910983882966390