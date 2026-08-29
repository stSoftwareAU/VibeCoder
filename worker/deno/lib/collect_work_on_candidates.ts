/**
 * Collect work-on issue candidates from a single repository.
 *
 * Fetches issues carrying the configured work-on label, strips
 * untrusted operational labels, applies filterAndSort, then enforces
 * label-author authorisation, content-integrity verification (Issue
 * #1341), milestone occupancy, recently-closed PR cooldowns,
 * milestone-aware PR blocking, and dependency blocking. Used by
 * `findOldestIssue`.
 *
 * Issue #2752: `work-on` issues that can never be progressed are escalated
 * rather than left to dangle. A dependency cycle (A→B→A) and a
 * self-suppressing dead label (a milestone-tracking issue carrying
 * `work-on`) both result in `needs-human` + exactly one explanatory comment,
 * after which the issue is dropped from candidates and the scan continues.
 * Escalation is idempotent — the applied `needs-human` label drops the issue
 * from `filterAndSort` next scan, and a stable per-issue dedup key prevents a
 * duplicate comment within 24 hours.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import { runGhCommand } from "./github.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import {
  cleanStaleLabels,
  filterAndSort,
  isMilestoneOccupied,
  isMilestoneTrackingIssue,
} from "./issue_filter.ts";
import {
  fetchIssuesByLabel,
  getBlockingPRForIssue,
  hasIgnoreOpenPRsLabel,
  isBlockedByRecentlyClosedPR,
  wasLabelAddedByAllowedAuthor,
  wasLabelReappliedAfterClosedPR,
} from "./issue_query.ts";
import type { ClosedPR, OpenPR } from "./issue_query.ts";
import type {
  BlockedCandidateInfo,
  SkipReason,
} from "./issue_finder_logger.ts";
import type { IssueCandidate } from "./issue_priority.ts";
import { extractMilestonePriority } from "./milestone_priority.ts";
import type { IssueFetcher } from "./issue_dependencies.ts";
import {
  buildWorkOnDependencyGraph,
  detectDependencyCycles,
  findCyclePath,
} from "./issue_dependencies.ts";
import {
  buildCycleEscalation,
  buildDeadLabelEscalation,
  escalateUnworkableWorkOn,
} from "./escalate_unworkable_work_on.ts";
import {
  filterTrustedLabels,
  verifyOperationalLabels,
} from "./label_security.ts";
import {
  isFleetAuthor,
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
} from "./fleet_authors.ts";
import {
  buildOpenIssueStateMap,
  type FindIssuesOptions,
  isDependencyBlocked,
  memoiseIssueFetcher,
} from "./issue_finder_common.ts";
import { verifyWorkOnContentIntegrityDetailed } from "./work_on_content_integrity.ts";
import { suppressesLowerTiers } from "./skip_reason_clearing.ts";
import { buildBatchedGh } from "./timeline_batch.ts";
import { stripUntrustedWorkOnLabel } from "./strip_untrusted_work_on.ts";

/**
 * Collect work-on candidates from a single repository.
 */
export interface WorkOnCollectionResult {
  /** Eligible candidates that survived every filter. */
  candidates: IssueCandidate[];
  /**
   * True when the repo has at least one open issue carrying the work-on
   * label, even if every such issue was filtered out by the per-issue
   * eligibility checks (Issue #2164). Callers use this to decide whether
   * to suppress low-priority and idle-task selection from this repo —
   * a repo with any pending work-on issue should not contribute backlog
   * work to lower tiers.
   */
  hasOpenIssues: boolean;
  /**
   * True when the repo has at least one *post-`filterAndSort`* work-on
   * issue that is NOT *solely* dependency-blocked — i.e. an issue that
   * survives `filterAndSort` and is eligible, PR-blocked,
   * milestone-occupied, or in closed-PR cooldown. This is the signal
   * that drives the Issue #2164 low-priority/idle-task suppression.
   *
   * Issue #2751: the signal is computed from the post-`filterAndSort`
   * set, not the raw fetch count. Work-on issues `filterAndSort` drops —
   * milestone-tracking trackers (the proven `private-repo-12` field case),
   * issues assigned to anyone, and issues carrying a blocking label
   * (failed, needs-human, needs-revision, refine-issue, planning,
   * question) — are work the worker can never action this cycle, so they
   * must NOT suppress the backlog. Counting them froze whole repos: the
   * entire low-priority backlog stayed suppressed behind work-on issues
   * the worker permanently skips.
   *
   * Issue #2610: of the issues that survive `filterAndSort`, a work-on
   * issue whose only blocker is an open dependency must not suppress its
   * repo's low-priority backlog either. The dependency is frequently a
   * low-priority issue in the same repo, so suppressing it deadlocks the
   * chain: the work-on issue cannot proceed (its dependency is open) and
   * the dependency cannot be picked up (low-priority, suppressed by the
   * open work-on issue). When every surviving work-on issue is purely
   * dependency-blocked this is `false`, so the low-priority work that
   * unblocks the chain becomes eligible again. Serialisation cases
   * (PR-blocked, milestone-occupied) keep this `true`, preserving the
   * one-PR-per-work-stream guarantee.
   */
  hasSuppressingWorkOn: boolean;
  /**
   * One entry per issue this collector refused, and why (Issue #460).
   *
   * `find_oldest_issue.ts` merges these into `FindIssuesResult` so the
   * idle-inversion escalation can name the gate per issue instead of asking
   * a human to reconstruct it from an aggregate, debug-gated log line — the
   * position GRQ#4465 left its reader in.
   */
  blockedDetails: BlockedCandidateInfo[];
}

/**
 * A blocking PR and the `work-on` issues it deferred (Issue #4024).
 * Accumulated per repo so one log line covers every issue a single PR
 * blocked.
 */
interface BlockingPrRecord {
  prNumber: number;
  author: string;
  baseRef: string;
  blockedIssues: number[];
}

/**
 * Record that `prNumber` blocked `issue`, resolving the PR's author and
 * base branch from the fetched open-PR list (Issue #4024).
 *
 * An author the fetch never stamped (a pre-#4024 cache entry) stays
 * empty, which the logger renders as `(unknown)` and treats as *not*
 * covered by maintenance — coverage could not be confirmed, so the line
 * errs towards flagging it.
 */
function recordBlockingPr(
  records: Map<number, BlockingPrRecord>,
  repoPRs: OpenPR[],
  prNumber: number,
  issue: FilterableIssue,
): void {
  let record = records.get(prNumber);
  if (!record) {
    const pr = repoPRs.find((p) => p.number === prNumber);
    record = {
      prNumber,
      author: pr?.author ?? "",
      baseRef: pr?.baseRefName ?? "",
      blockedIssues: [],
    };
    records.set(prNumber, record);
  }
  record.blockedIssues.push(issue.number);
}

export async function collectWorkOnCandidates(
  repo: string,
  config: WorkerConfig,
  options: FindIssuesOptions,
  repoPRs: OpenPR[],
  repoAllIssues: FilterableIssue[],
  fetcher: IssueFetcher,
  repoClosedPRs: ClosedPR[] = [],
): Promise<WorkOnCollectionResult> {
  const ghFn = options.ghCommandFn ?? runGhCommand;
  const diag = options.diagnostics;
  const candidates: IssueCandidate[] = [];
  /** Issue #4024: blocking PRs found this repo, keyed by PR number. */
  const blockingPrs = new Map<number, BlockingPrRecord>();

  // Issue #2752: memoise per-issue body/sub-issue/state reads so the
  // dependency-cycle graph build and the dependency-blocking gate share a
  // single `gh` call each (the latter otherwise reads the body twice). This
  // keeps cycle detection cost-neutral against the per-iteration call budget.
  const memoFetcher = memoiseIssueFetcher(fetcher);

  // Issue #2031: needs-clarification retired — needs-human is the only handoff label.
  const filterLabels = {
    failedLabel: config.failedLabel,
    refineIssueLabel: config.refineIssueLabel,
    planningLabel: config.planningLabel,
    questionLabel: config.questionLabel,
    needsRevisionLabel: config.needsRevisionLabel,
    needsHumanLabel: config.needsHumanLabel,
  };

  let issues: FilterableIssue[] = await fetchIssuesByLabel(
    repo,
    config.workOnLabel,
    options.cache,
    50,
    ghFn,
  );

  // Issue #2164: snapshot raw "has any open work-on issue" before any
  // filter strips the list. `hasOpenIssues` reports whether the repo
  // carries any open work-on issue at all; its semantics are unchanged.
  // It is no longer the basis for the suppression signal — see
  // `hasSuppressingWorkOn` below (Issue #2751).
  const rawOpenWorkOnCount = issues.length;
  const hasOpenIssues = rawOpenWorkOnCount > 0;

  // Issue #524: count the post-`filterAndSort` work-on issues that actually
  // serialise this repo — the eligible ones, plus those held by a gate whose
  // refusal clears by itself (`SKIP_REASON_CLEARING`). Accumulated at each
  // decision point rather than subtracted per gate afterwards, so a gate
  // added without a clearing classification cannot silently rejoin the
  // signal (see `hasSuppressingWorkOn`).
  let suppressingCount = 0;

  issues = await cleanStaleLabels(
    issues,
    repo,
    config.failedLabel,
    config.failedOnceLabel,
    ghFn,
    options.timelineCache,
  );

  // Issue #1674: Pre-fetch label-event timelines for all candidate
  // issues in a single GraphQL call so subsequent per-issue checks
  // (verifyOperationalLabels, wasLabelAddedByAllowedAuthor,
  // hasIgnoreOpenPRsLabel) resolve from cached data instead of one
  // REST call each. Falls back to the existing per-issue REST path
  // if the batch call fails.
  //
  // Issue #1783: When an iteration-scoped registry is supplied, route
  // the batch through it so overlapping issue numbers across the four
  // candidate collectors are fetched at most once per iteration.
  const issueNumbers = issues.map((i) => i.number);
  const batchedGh = options.timelineBatchRegistry
    ? await options.timelineBatchRegistry.getBatchedGh(repo, issueNumbers, ghFn)
    : await buildBatchedGh(repo, issueNumbers, ghFn);

  // Issue #1808: derive the open-state map once per repo so per-child
  // `getIssueState` calls inside `isDependencyBlocked` resolve from the
  // local map on the warm path.
  const openStateMap = buildOpenIssueStateMap(repoAllIssues);

  // Issue #1344: Verify operational labels were added by trusted users.
  // Issue #3225: exclude fleet worker logins (own host + siblings) from the
  // operational-label trust set — they must appear in allowedAuthors for
  // PR-dedup but must not be trusted to apply operational labels.
  // Issue #3426: the exclusion set is deliberately `github_user ∪
  // fleet_pr_authors`, NOT `allowed_authors` — the latter also lists the human
  // authors who legitimately apply these labels, so passing it here would strip
  // humans' labels too. Sibling workers must be configured in fleet_pr_authors
  // (the canonical sibling-login list) to be excluded.
  const fleetWorkerLogins = resolveFleetAuthors(
    options.githubUser,
    [],
    config.fleetPrAuthors,
  );

  // Issue #4133: the push-capable fleet set — the accounts whose PRs the
  // fleet actually owns (#4075). Only those PRs defer an issue; a human's
  // open PR is theirs to manage and never parks the queue.
  const pushCapableAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser: options.githubUser,
    fleetPrAuthors: config.fleetPrAuthors,
  });

  for (const issue of issues) {
    const verification = await verifyOperationalLabels(
      repo,
      issue.number,
      issue.labels,
      config.allowedAuthors,
      batchedGh,
      options.githubUser,
      fleetWorkerLogins,
    );
    if (verification.untrustedLabels.length > 0) {
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "untrusted-operational-label",
        verification.untrustedLabels.map((u) => `${u.label}(${u.addedBy})`)
          .join(", "),
      );
      issue.labels = filterTrustedLabels(issue.labels, verification);
    }
  }

  const filtered = filterAndSort(issues, filterLabels);

  // Log issues removed by filterAndSort
  if (diag) {
    const filteredNumbers = new Set(filtered.map((i) => i.number));
    for (const issue of issues) {
      if (!filteredNumbers.has(issue.number)) {
        diag.logIssueConsidered(repo, issue.number, issue.title);
        // Issue #1470: distinguish needs-human so audits show why the
        // worker bypassed an issue the worker itself handed back.
        const reason = issue.labels.includes(config.needsHumanLabel)
          ? "needs-human"
          : "filtered-out";
        const detail = reason === "needs-human"
          ? config.needsHumanLabel
          : "filterAndSort";
        diag.logIssueSkipped(repo, issue.number, reason, detail);
      }
    }
  }

  // Issue #2752: escalate self-suppressing dead labels. A milestone-tracking
  // issue that carries the `work-on` label is work the worker never actions
  // (`filterAndSort` drops it via `isMilestoneTrackingIssue`). After #2751 it
  // no longer suppresses the backlog; here it is also escalated so a human
  // relabels or closes it. Only issues dropped *solely* because they are
  // trackers qualify — issues that are assigned, already carry `needs-human`
  // (idempotence), or carry another blocking label have their own handling.
  const blockingLabelSet = new Set([
    config.failedLabel,
    config.needsRevisionLabel,
    config.refineIssueLabel,
    config.planningLabel,
    config.questionLabel,
    config.needsHumanLabel,
  ]);
  const filteredNumbers = new Set(filtered.map((i) => i.number));
  for (const issue of issues) {
    if (filteredNumbers.has(issue.number)) continue;
    if (issue.assignees.length > 0) continue;
    if (issue.labels.some((l) => blockingLabelSet.has(l))) continue;
    if (!isMilestoneTrackingIssue(issue)) continue;
    await escalateUnworkableWorkOn({
      repo,
      issueNumber: issue.number,
      needsHumanLabel: config.needsHumanLabel,
      escalation: buildDeadLabelEscalation(issue.number),
      githubUser: options.githubUser,
      ghFn,
      deps: options.escalateDeps,
    });
    diag?.logIssueSkipped(
      repo,
      issue.number,
      "dead-label-tracker-escalated",
      config.needsHumanLabel,
    );
  }

  // Issue #2752: collect the issues that hit the dependency-blocking gate so
  // a cycle among them can be detected after the loop. A cyclic issue
  // (A→B→A) is, by definition, dependency-blocked — both ends depend on an
  // open issue — so every cycle member already lands here. Detecting cycles
  // from this set (rather than a pre-loop graph build) reuses the body and
  // sub-issue reads `isDependencyBlocked` already made via `memoFetcher`, so
  // the feature adds no extra `gh` calls.
  const dependencyBlockedIssues: number[] = [];
  // Issue #460: the per-issue skip reasons, recorded beside the diagnostic
  // log calls so the two cannot drift.
  const blockedDetails: BlockedCandidateInfo[] = [];
  // Issue #524: the single accounting point for a refusal. Recording the
  // reason and deciding whether that reason still serialises the repo happen
  // together, so the two cannot drift and no gate can be refused without its
  // clearing behaviour being consulted.
  const noteBlocked = (
    issueNumber: number,
    milestone: string,
    reason: SkipReason,
  ): void => {
    blockedDetails.push({ repo, issueNumber, milestone, reason });
    if (suppressesLowerTiers(reason)) suppressingCount++;
  };

  for (const issue of filtered) {
    diag?.logIssueConsidered(repo, issue.number, issue.title);

    // Verify work-on label was added by allowed author.
    // Issue #3416: exclude fleet worker logins (own host + siblings) — they
    // sit in allowedAuthors for PR-dedup but must not be trusted to
    // self-apply the reserved `work-on` discovery label.
    const labelAdded = await wasLabelAddedByAllowedAuthor(
      repo,
      issue.number,
      config.workOnLabel,
      config.allowedAuthors,
      batchedGh,
      options.timelineCache,
      fleetWorkerLogins,
    );
    if (!labelAdded) {
      noteBlocked(issue.number, issue.milestone, "label-author-not-allowed");
      diag?.logIssueSkipped(repo, issue.number, "label-author-not-allowed");
      // Issue #3575: fail loud. An untrusted `work-on` label was previously
      // skipped silently, leaving the issue in a false "queued" state that
      // could persist indefinitely (private-repo-14#3489 sat ~25 h). Strip the label
      // and post one explanatory comment when the most-recent adder is
      // positively confirmed untrusted (the helper fails closed otherwise, so
      // a genuine human `work-on` is never removed on a transient read error).
      await stripUntrustedWorkOnLabel({
        repo,
        issueNumber: issue.number,
        workOnLabel: config.workOnLabel,
        allowedAuthors: config.allowedAuthors,
        fleetWorkerLogins,
        ghFn: batchedGh,
        cache: options.timelineCache,
      });
      continue;
    }

    // Issue #1341: TOCTOU protection — verify content has not been modified
    // after the work-on label was approved by a trusted author.
    // Issue #524: the *reason* comes back, not just the verdict. A content
    // fault that needs a trusted re-approval must not park the repo's lower
    // tiers, while a transient read error (which clears on the next pass)
    // still does — a distinction a bare "blocked" cannot express. It also
    // closes the Issue #460 gap where a content-blocked issue was missing
    // from `blockedDetails` entirely.
    const contentCheck = await verifyWorkOnContentIntegrityDetailed(
      repo,
      issue,
      config,
      ghFn,
      diag,
      options.contentApprovalDeps,
      options.timelineCache,
    );
    if (contentCheck.verdict === "blocked") {
      // The gate has already logged its own skip line; record the reason.
      noteBlocked(issue.number, issue.milestone, contentCheck.reason);
      continue;
    }

    const milestoneTitle = issue.milestone;

    if (
      isMilestoneOccupied(
        repoAllIssues,
        milestoneTitle,
        options.githubUser,
        config.allowedAuthors,
      )
    ) {
      noteBlocked(issue.number, milestoneTitle, "milestone-occupied");
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "milestone-occupied",
        milestoneTitle,
      );
      continue;
    }

    // Issue #1427: Check recently-closed PR blocking — prevent duplicate PRs
    if (repoClosedPRs.length > 0) {
      const closedPR = isBlockedByRecentlyClosedPR(repoClosedPRs, issue.number);
      // VibeCoder#42: a trusted re-label dated after the PR closed/merged
      // reopens the issue for the fleet — the gate's documented escape hatch.
      const reopened = closedPR !== null &&
        await wasLabelReappliedAfterClosedPR(
          repo,
          issue.number,
          config.workOnLabel,
          config.allowedAuthors,
          closedPR,
          batchedGh,
          options.timelineCache,
          fleetWorkerLogins,
        );
      if (closedPR && !reopened) {
        // Issue #319: a merged PR blocks permanently (Issue #3151) — calling
        // that a "cooldown" reads as self-healing and sent the diagnosis of
        // #187/#188 down the wrong path for a day. Name which it is, and say
        // what clears it.
        noteBlocked(
          issue.number,
          milestoneTitle,
          closedPR.merged ? "merged-pr-permanent" : "closed-pr-cooldown",
        );
        diag?.logIssueSkipped(
          repo,
          issue.number,
          closedPR.merged ? "merged-pr-permanent" : "closed-pr-cooldown",
          closedPR.merged
            ? `PR #${closedPR.number} merged at ${closedPR.closedAt} — ` +
              `permanent until a trusted re-label dated after the merge`
            : `PR #${closedPR.number} closed at ${closedPR.closedAt}`,
        );
        continue;
      }
    }

    if (repoPRs.length > 0) {
      const blockingPR = getBlockingPRForIssue(
        repoPRs,
        milestoneTitle,
        pushCapableAuthors,
      );
      if (blockingPR) {
        const hasIgnore = await hasIgnoreOpenPRsLabel(
          repo,
          issue.number,
          "ignore-open-prs",
          config.allowedAuthors,
          batchedGh,
          options.timelineCache,
          options.cache,
        );
        if (!hasIgnore) {
          noteBlocked(issue.number, milestoneTitle, "pr-blocked");
          diag?.logIssueSkipped(
            repo,
            issue.number,
            "pr-blocked",
            `PR #${blockingPR.number}`,
          );
          // Issue #4024: record the blocking PR so one structured line
          // per PR names every issue it deferred (emitted after the loop).
          recordBlockingPr(blockingPrs, repoPRs, blockingPR.number, issue);
          continue;
        }
      }
    }

    if (
      await isDependencyBlocked(repo, issue.number, memoFetcher, openStateMap)
    ) {
      noteBlocked(issue.number, milestoneTitle, "dependency-blocked");
      diag?.logIssueSkipped(repo, issue.number, "dependency-blocked");
      dependencyBlockedIssues.push(issue.number);
      continue;
    }

    diag?.logIssueEligible(repo, issue.number);
    // Issue #2164: an eligible work-on issue is the original serialisation
    // signal — the repo has real higher-tier work, so the lower tiers wait.
    suppressingCount++;
    candidates.push({
      repo,
      number: issue.number,
      url: issue.url,
      title: issue.title,
      milestone: milestoneTitle,
      createdAt: issue.createdAt,
      labelIndex: 99,
      source: "work-on",
      milestonePriority: extractMilestonePriority(issue.labels),
    });
  }

  // Issue #4024: one structured line per blocking PR, naming the author,
  // the base branch, every issue it deferred, and whether the
  // PR-maintenance scans cover that author. A blocking PR with
  // `in-maintenance-set=false` is a PR nothing will fix, answer, or merge
  // — the #4023 stall, now visible in the log without a code read.
  if (diag) {
    const maintenanceAuthors = options.maintenanceAuthors ?? [];
    for (const entry of blockingPrs.values()) {
      diag.logBlockingPr({
        repo,
        prNumber: entry.prNumber,
        author: entry.author,
        baseRef: entry.baseRef,
        blockedIssues: entry.blockedIssues,
        inMaintenanceSet: isFleetAuthor(entry.author, maintenanceAuthors),
      });
    }
  }

  // Issue #2752: escalate dependency cycles. A cyclic issue (A→B→A) was
  // already dropped above via the dependency-blocking gate, so candidate
  // selection and the suppression signal are unaffected — what remains is to
  // surface the deadlock to a human. The graph is built only from the
  // dependency-blocked set and only when at least two such issues exist (a
  // cross-issue cycle cannot form otherwise); every read is a `memoFetcher`
  // cache hit, so no extra `gh` calls are made.
  if (dependencyBlockedIssues.length >= 2) {
    const cycleNodes = await buildWorkOnDependencyGraph(
      memoFetcher,
      repo,
      dependencyBlockedIssues,
    );
    const cycleSet = new Set(detectDependencyCycles(cycleNodes));
    for (const issueNumber of dependencyBlockedIssues) {
      if (!cycleSet.has(issueNumber)) continue;
      await escalateUnworkableWorkOn({
        repo,
        issueNumber,
        needsHumanLabel: config.needsHumanLabel,
        escalation: buildCycleEscalation(
          issueNumber,
          findCyclePath(cycleNodes, issueNumber),
        ),
        githubUser: options.githubUser,
        ghFn,
        deps: options.escalateDeps,
      });
      diag?.logIssueSkipped(
        repo,
        issueNumber,
        "dependency-cycle-escalated",
        config.needsHumanLabel,
      );
    }
  }

  // Issue #2751: the signal counts only *post-`filterAndSort`* work-on issues.
  // `filterAndSort` drops every work-on issue the worker can never action this
  // cycle — milestone-tracking trackers (the proven `private-repo-12` field
  // case), issues assigned to anyone, and issues carrying a blocking label
  // (failed, needs-human, needs-revision, refine-issue, planning, question).
  // A repo whose only work-on issues fall into those categories would
  // otherwise deadlock its entire low-priority/idle-task backlog behind work
  // the worker permanently skips. They never reach `suppressingCount`.
  //
  // Issue #524: of the issues that DO survive, each one counts only when the
  // gate that refused it clears by itself (`SKIP_REASON_CLEARING`) — a PR
  // merges, a cooldown expires, a stream frees up — so waiting is the right
  // behaviour. That single rule subsumes the carve-outs #2610 and #499 each
  // added by hand: `dependency-blocked` (the dependency is frequently a
  // low-priority issue in the same repo, so suppressing deadlocks the chain)
  // and `merged-pr-permanent` (only a trusted re-label dated after the merge
  // lifts it). On `stSoftwareAU/NEAT-AI-Rebase` one issue of the latter kind
  // (#48, named by merged PR #49) stranded all 28 of the repo's `low-priority`
  // issues indefinitely while the census — which does model the merged-PR
  // gate — kept reporting them as claimable. The subtraction that replaced it
  // named two gates from memory; this counts what the map declares, so gate
  // #25 cannot rejoin the signal unclassified.
  //
  // Issue #2752: dependency-cycle issues are a subset of the
  // dependency-blocked set, so they are already excluded here — escalating
  // them adds no separate suppression adjustment.
  const hasSuppressingWorkOn = suppressingCount > 0;

  return { candidates, hasOpenIssues, hasSuppressingWorkOn, blockedDetails };
}
