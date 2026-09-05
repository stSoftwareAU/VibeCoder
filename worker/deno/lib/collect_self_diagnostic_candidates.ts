/**
 * Collect self-scheduled worker-diagnostic candidates (Issue #505).
 *
 * The worker files accurate diagnostics about its own faults and then
 * stops, because scheduling one means applying `work-on` — the label it is
 * forbidden to self-apply. Unattended, nobody applies it: `NEAT-AI-Rebase#39`
 * waited two days for a label, and the fix took 79 minutes once it arrived.
 *
 * This collector closes that loop **without weakening any label guard**.
 * Nothing here applies a label; `top-priority` and `work-on` stay human-only
 * unconditionally. Instead an auto-filed diagnostic becomes claimable on its
 * provenance — see `self_diagnostic_provenance.ts` for the three signals
 * (repo, marker, author) that must agree.
 *
 * The emitted candidates form tier 2b: below both human-scheduled tiers,
 * above the backlog (`issue_priority.ts`).
 *
 * Bounds and visibility, in the order they are applied:
 *
 *   - **Off switch** — `self_schedule_diagnostics_enabled: false` returns
 *     nothing, restoring the previous behaviour exactly.
 *   - **Repo** — only `SELF_DIAGNOSTIC_REPO`; a worker-filed issue in
 *     a product repo is never self-scheduled.
 *   - **Cap** — at most `self_schedule_diagnostics_max_in_flight`
 *     diagnostics in flight (assigned = claimed), so a misfiring detector
 *     cannot fill the queue with its own work. The surplus is refused and
 *     logged, never silently dropped.
 *   - **Gates** — the same milestone / closed-PR / open-PR / dependency
 *     gates the other collectors run.
 *   - **Audit + announcement** — the decision is written to the audit chain
 *     under {@link SELF_SCHEDULE_AUDIT_VERB} and announced on the issue
 *     before the candidate is emitted. If either fails the diagnostic is
 *     **not** scheduled this scan: a privilege-bearing decision nobody can
 *     trace is worse than a diagnostic that waits one more cycle.
 *   - **Escalation** — a diagnostic blocked permanently (a merged fleet PR
 *     names it) is handed to a human with `needs-human` and one comment,
 *     rather than sitting open as an alarm nobody is obliged to read.
 *
 * No extra `gh` calls are made to find candidates: the issues are read from
 * the per-repo `fetchAllIssues` list the scan already holds, which carries
 * the body and author this module matches on.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import { runGhCommand } from "./github.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import { filterAndSort, isMilestoneOccupied } from "./issue_filter.ts";
import {
  getBlockingPRForIssue,
  isBlockedByRecentlyClosedPR,
} from "./issue_query.ts";
import type { ClosedPR, OpenPR } from "./issue_query.ts";
import type { IssueCandidate } from "./issue_priority.ts";
import { extractMilestonePriority } from "./milestone_priority.ts";
import type { IssueFetcher } from "./issue_dependencies.ts";
import {
  isFleetAuthor,
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
} from "./fleet_authors.ts";
import {
  buildOpenIssueStateMap,
  type FindIssuesOptions,
  isDependencyBlocked,
} from "./issue_finder_common.ts";
import { issueCommentsContainMarker } from "./issue_comment_pages.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import { escalateUnworkableWorkOn } from "./escalate_unworkable_work_on.ts";
import { recordMutation, resolveRunId } from "./audit_journal.ts";
import {
  buildSelfScheduleAnnouncement,
  buildUnschedulableDiagnosticEscalation,
  formatSelfScheduleMarker,
  isSelfDiagnosticRepo,
  recogniseSelfDiagnostic,
  SELF_SCHEDULE_AUDIT_VERB,
  type SelfDiagnosticFamily,
  UNSCHEDULABLE_DIAGNOSTIC_HEADING,
} from "./self_diagnostic_provenance.ts";

/**
 * `labelIndex` for self-scheduled diagnostics: between work-on's 99 and
 * low-priority's 199, so the shared comparator orders tier 2b correctly
 * even when candidates from several tiers are compared directly.
 */
export const SELF_DIAGNOSTIC_LABEL_INDEX = 149;

/** Defaults mirroring `OPERATIONAL_DEFAULTS`, for configs that omit them. */
const DEFAULT_ENABLED = true;
const DEFAULT_MAX_IN_FLIGHT = 1;

/** One diagnostic the self-scheduling path refused, and why. */
export interface SelfScheduleRefusal {
  issueNumber: number;
  /** Short machine-readable cause, e.g. `cap-reached`. */
  cause: "cap-reached" | "audit-failed" | "announce-failed";
  /** Human-readable detail for the log line. */
  detail: string;
}

/** What one repo's self-diagnostic collection produced. */
export interface SelfDiagnosticCollectionResult {
  /** Diagnostics scheduled by the worker this scan. */
  candidates: IssueCandidate[];
  /** Diagnostics refused this scan — always logged, never silent. */
  refusals: SelfScheduleRefusal[];
}

/** Injectable seams so the tests never touch the real audit dir or `gh`. */
export interface SelfDiagnosticDeps {
  /** Record the scheduling decision in the audit chain. */
  recordDecision?: (entry: {
    repo: string;
    issueNumber: number;
    family: SelfDiagnosticFamily;
  }) => Promise<boolean>;
  /** Sink for refusal/decision lines. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/** A fresh empty result — never a shared mutable object. */
function empty(): SelfDiagnosticCollectionResult {
  return { candidates: [], refusals: [] };
}

/**
 * Write the scheduling decision to the audit chain. Returns false — never
 * throws — when it could not be recorded, so the caller can refuse to
 * schedule rather than take an untraceable action.
 */
async function recordSelfScheduleDecision(entry: {
  repo: string;
  issueNumber: number;
  family: SelfDiagnosticFamily;
}): Promise<boolean> {
  const recorded = await recordMutation({
    runId: resolveRunId(),
    repo: entry.repo,
    target: `#${entry.issueNumber}`,
    verb: SELF_SCHEDULE_AUDIT_VERB,
    outcome: "success",
    caller: `worker/deno/lib/collect_self_diagnostic_candidates.ts ` +
      `(family=${entry.family.id})`,
  });
  return recorded.ok;
}

/**
 * Collect self-scheduled worker-diagnostic candidates from one repository.
 *
 * Returns an empty result for every repo but `SELF_DIAGNOSTIC_REPO`,
 * and for every configuration with the path disabled.
 */
export async function collectSelfDiagnosticCandidates(
  repo: string,
  config: WorkerConfig,
  options: FindIssuesOptions,
  repoPRs: OpenPR[],
  repoAllIssues: FilterableIssue[],
  fetcher: IssueFetcher,
  repoClosedPRs: ClosedPR[] = [],
  deps: SelfDiagnosticDeps = {},
): Promise<SelfDiagnosticCollectionResult> {
  const enabled = config.selfScheduleDiagnosticsEnabled ?? DEFAULT_ENABLED;
  if (!enabled) return empty();
  if (!isSelfDiagnosticRepo(repo)) return empty();

  const ghFn = options.ghCommandFn ?? runGhCommand;
  const diag = options.diagnostics;
  const log = deps.log ?? ((message: string) => console.error(message));
  const recordDecision = deps.recordDecision ?? recordSelfScheduleDecision;
  const maxInFlight = Math.max(
    0,
    config.selfScheduleDiagnosticsMaxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
  );

  // Provenance gate: filed by a fleet worker login, in this repo, carrying a
  // recognised marker. All three must agree — "filed by the worker account"
  // alone is not enough, because an injected agent can file issues too.
  const fleetWorkerLogins = resolveFleetAuthors(
    options.githubUser,
    [],
    config.fleetPrAuthors,
  );
  const recognised = repoAllIssues
    .map((issue) => ({ issue, family: recogniseSelfDiagnostic(issue.body) }))
    .filter((
      entry,
    ): entry is { issue: FilterableIssue; family: SelfDiagnosticFamily } =>
      entry.family !== null &&
      isFleetAuthor(entry.issue.author, fleetWorkerLogins)
    );
  if (recognised.length === 0) return empty();

  // An assigned diagnostic is a claimed one — the assignee is the fleet's
  // claim lock — so that is what "in flight" counts.
  const inFlight =
    recognised.filter((e) => e.issue.assignees.length > 0).length;
  const familyByNumber = new Map(
    recognised.map((e) => [e.issue.number, e.family]),
  );

  // Issues a human already scheduled belong to their own tier; the
  // discovery labels are read here only to stay out of that tier's way.
  const humanScheduled = new Set(
    [
      ...config.issueLabels ?? [],
      config.workOnLabel,
      config.lowPriorityLabel,
      IDLE_TASK_LABEL,
    ].filter((l) => typeof l === "string" && l !== ""),
  );

  const filtered = filterAndSort(
    recognised.map((e) => e.issue).filter((issue) =>
      !issue.labels.some((l) => humanScheduled.has(l))
    ),
    {
      failedLabel: config.failedLabel,
      refineIssueLabel: config.refineIssueLabel,
      planningLabel: config.planningLabel,
      questionLabel: config.questionLabel,
      needsRevisionLabel: config.needsRevisionLabel,
      needsHumanLabel: config.needsHumanLabel,
    },
  );
  if (filtered.length === 0) return empty();

  const refusals: SelfScheduleRefusal[] = [];
  let remaining = maxInFlight - inFlight;
  if (remaining <= 0) {
    // Fail loud: a refused diagnostic is reported, never dropped quietly.
    for (const issue of filtered) {
      const detail = `${inFlight} self-scheduled diagnostic(s) already in ` +
        `flight, cap is ${maxInFlight}`;
      refusals.push({
        issueNumber: issue.number,
        cause: "cap-reached",
        detail,
      });
      log(
        `[self-schedule] refused ${repo}#${issue.number}: ${detail} — it ` +
          `stays open until a slot frees or a human schedules it`,
      );
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "self-schedule-refused",
        detail,
      );
    }
    return { candidates: [], refusals };
  }

  const openStateMap = buildOpenIssueStateMap(repoAllIssues);
  const pushCapableAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser: options.githubUser,
    fleetPrAuthors: config.fleetPrAuthors,
  });

  const candidates: IssueCandidate[] = [];
  for (const issue of filtered) {
    if (remaining <= 0) break;
    const family = familyByNumber.get(issue.number)!;
    diag?.logIssueConsidered(repo, issue.number, issue.title);

    const milestoneTitle = issue.milestone;

    if (
      isMilestoneOccupied(
        repoAllIssues,
        milestoneTitle,
        options.githubUser,
        // Issue #1064: fleet-operated accounts only — a human assignee
        // never occupies a work stream.
        pushCapableAuthors,
      )
    ) {
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "milestone-occupied",
        milestoneTitle,
      );
      continue;
    }

    if (repoClosedPRs.length > 0) {
      const closedPR = isBlockedByRecentlyClosedPR(repoClosedPRs, issue.number);
      if (closedPR) {
        diag?.logIssueSkipped(
          repo,
          issue.number,
          closedPR.merged ? "merged-pr-permanent" : "closed-pr-cooldown",
          `PR #${closedPR.number} ${
            closedPR.merged ? "merged" : "closed"
          } at ${closedPR.closedAt}`,
        );
        if (closedPR.merged) {
          // Permanent (Issue #3151): nothing the worker does clears it, so
          // the diagnostic must reach a person deliberately rather than sit
          // open as an alarm nobody is obliged to read.
          await escalateUnworkableWorkOn({
            repo,
            issueNumber: issue.number,
            needsHumanLabel: config.needsHumanLabel,
            escalation: buildUnschedulableDiagnosticEscalation({
              issueNumber: issue.number,
              family,
              reason: `merged PR #${closedPR.number} names it, which blocks ` +
                `re-pickup permanently`,
            }),
            heading: UNSCHEDULABLE_DIAGNOSTIC_HEADING,
            githubUser: options.githubUser,
            ghFn,
            deps: options.escalateDeps,
          });
          diag?.logIssueSkipped(
            repo,
            issue.number,
            "self-schedule-escalated",
            config.needsHumanLabel,
          );
        }
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
        diag?.logIssueSkipped(
          repo,
          issue.number,
          "pr-blocked",
          `PR #${blockingPR.number}`,
        );
        continue;
      }
    }

    if (await isDependencyBlocked(repo, issue.number, fetcher, openStateMap)) {
      diag?.logIssueSkipped(repo, issue.number, "dependency-blocked");
      continue;
    }

    // Visible and traceable before it is actionable: the audit entry and the
    // announcement are both written before the candidate is emitted, and the
    // announcement is posted at most once per issue.
    const marker = formatSelfScheduleMarker(family.id);
    let announced: boolean;
    try {
      announced = await issueCommentsContainMarker(
        repo,
        issue.number,
        marker,
        ghFn,
      );
    } catch (err) {
      const detail = `could not read comments: ${errorText(err)}`;
      refusals.push({
        issueNumber: issue.number,
        cause: "announce-failed",
        detail,
      });
      log(`[self-schedule] refused ${repo}#${issue.number}: ${detail}`);
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "self-schedule-refused",
        detail,
      );
      continue;
    }

    if (!announced) {
      const recorded = await recordDecision({
        repo,
        issueNumber: issue.number,
        family,
      });
      if (!recorded) {
        const detail = "the decision could not be recorded in the audit chain";
        refusals.push({
          issueNumber: issue.number,
          cause: "audit-failed",
          detail,
        });
        log(
          `[self-schedule] refused ${repo}#${issue.number}: ${detail} — an ` +
            `untraceable self-scheduling decision is worse than a diagnostic ` +
            `that waits one more cycle`,
        );
        diag?.logIssueSkipped(
          repo,
          issue.number,
          "self-schedule-refused",
          detail,
        );
        continue;
      }

      try {
        await ghFn([
          "issue",
          "comment",
          String(issue.number),
          "--repo",
          repo,
          "--body",
          buildSelfScheduleAnnouncement({
            family,
            maxInFlight,
            ...(options.githubUser ? { githubUser: options.githubUser } : {}),
          }),
        ]);
      } catch (err) {
        const detail = `the announcement could not be posted: ${
          errorText(err)
        }`;
        refusals.push({
          issueNumber: issue.number,
          cause: "announce-failed",
          detail,
        });
        log(`[self-schedule] refused ${repo}#${issue.number}: ${detail}`);
        diag?.logIssueSkipped(
          repo,
          issue.number,
          "self-schedule-refused",
          detail,
        );
        continue;
      }

      log(
        `[self-schedule] scheduled ${repo}#${issue.number} ` +
          `(family=${family.id}, cap=${maxInFlight})`,
      );
    }

    diag?.logIssueEligible(repo, issue.number);
    candidates.push({
      repo,
      number: issue.number,
      url: issue.url,
      title: issue.title,
      milestone: milestoneTitle,
      createdAt: issue.createdAt,
      labelIndex: SELF_DIAGNOSTIC_LABEL_INDEX,
      source: "self-diagnostic",
      milestonePriority: extractMilestonePriority(issue.labels),
    });
    remaining--;
  }

  return { candidates, refusals };
}

/** Message text of an unknown thrown value. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
