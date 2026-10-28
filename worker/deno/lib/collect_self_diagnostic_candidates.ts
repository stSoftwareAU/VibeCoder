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
 * provenance — see `self_diagnostic_provenance.ts` for the four signals
 * (repo, marker, author, and the filing attestation of
 * `self_diagnostic_attestation.ts`) that must agree.
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
 *   - **Filing attestation** (Issue #1277) — the worker's own filer must
 *     have recorded this issue number, and a digest of the body it posted,
 *     in the tamper-evident audit chain (`self_diagnostic_attestation.ts`).
 *     The body marker alone is written by whoever writes the body, so on
 *     its own it reduced the gate to "filed by the worker account" — the
 *     signal this module's own comments call insufficient.
 *   - **Readable source** (Issue #4462) — a run-failure issue whose body
 *     withholds its source (a private repo) is scheduled only once its body
 *     or a fleet-authored follow-up occurrence names one. Otherwise it is
 *     refused, logged and left for a human `work-on`; the worker does not
 *     guess the cause.
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
 * Candidates are found without extra `gh` calls: the issues are read from the
 * per-repo `fetchAllIssues` list the scan already holds, which carries the
 * body and author this module matches on. The one exception is the readable
 * source check (Issue #4462): a run-failure issue whose body names no source
 * costs one bounded comments read to look for a fleet-authored follow-up.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import { runGhCommand } from "./github.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import { filterAndSort, isMilestoneOccupied } from "./issue_filter.ts";
import {
  describeBlockingPr,
  getBlockingPRForIssue,
  isBlockedByRecentlyClosedPR,
  resolveFleetPrSlots,
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
  createOpenMilestoneLookup,
  type FindIssuesOptions,
  isDependencyBlocked,
} from "./issue_finder_common.ts";
import { isIssueTimeDeferred } from "./time_deferral.ts";
import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import {
  fetchIssueCommentPages,
  issueCommentsContainMarker,
} from "./issue_comment_pages.ts";
import {
  parseRunFailureFollowUpMarker,
  RUN_FAILURE_FAMILY_ID,
  runFailureNamesReadableSource,
} from "./run_failure_issue.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import { recordMutation, resolveRunId } from "./audit_journal.ts";
import {
  type AttestationVerdict,
  verifySelfDiagnosticFilings,
} from "./self_diagnostic_attestation.ts";
import {
  buildSelfScheduleAnnouncement,
  formatSelfScheduleMarker,
  isSelfDiagnosticRepo,
  recogniseSelfDiagnostic,
  SELF_SCHEDULE_AUDIT_VERB,
  type SelfDiagnosticFamily,
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
  cause:
    | "cap-reached"
    | "audit-failed"
    | "announce-failed"
    | "unattested"
    | "no-readable-source";
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
  /**
   * Check which candidate issues the worker's own filer created
   * (Issue #1277). Defaults to reading the real audit journals.
   */
  verifyFilings?: (
    repo: string,
    issues: readonly { number: number; body?: string }[],
  ) => Promise<Map<number, AttestationVerdict>>;
  /** Sink for refusal/decision lines. Defaults to `console.error`. */
  log?: (message: string) => void;
  /**
   * Fleet identity used to verify who wrote the announcement marker (Issue
   * #1216). Omitted in production, which reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
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
  const marked = repoAllIssues
    .map((issue) => ({ issue, family: recogniseSelfDiagnostic(issue.body) }))
    .filter((
      entry,
    ): entry is { issue: FilterableIssue; family: SelfDiagnosticFamily } =>
      entry.family !== null &&
      isFleetAuthor(entry.issue.author, fleetWorkerLogins)
    );
  if (marked.length === 0) return empty();

  // An assigned diagnostic is a claimed one — the assignee is the fleet's
  // claim lock — so that is what "in flight" counts. Counted over every
  // marked diagnostic, attested or not: an unattested one this route will
  // not schedule may still be claimed, and it still occupies the slot.
  const inFlight = marked.filter((e) => e.issue.assignees.length > 0).length;
  const familyByNumber = new Map(
    marked.map((e) => [e.issue.number, e.family]),
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

  const eligible = filterAndSort(
    marked.map((e) => e.issue).filter((issue) =>
      !issue.labels.some((l) => humanScheduled.has(l))
    ),
    {
      refineIssueLabel: config.refineIssueLabel,
      planningLabel: config.planningLabel,
      questionLabel: config.questionLabel,
      needsRevisionLabel: config.needsRevisionLabel,
      needsHumanLabel: config.needsHumanLabel,
    },
  );
  if (eligible.length === 0) return empty();

  // Issue #1277: the marker is body text, and an injected agent holding the
  // run's `gh` credential writes bodies in this very repo. So the marker is
  // only provenance when the worker's own filer attested the filing out of
  // band — the issue number and a digest of the title and body it posted, in
  // the tamper-evident audit chain. Everything else is refused loudly and
  // waits for a human. Run after the label filters above so an issue that was
  // never a tier-2b candidate is not refused on every scan.
  const filterRefusals: SelfScheduleRefusal[] = [];
  const verifyFilings = deps.verifyFilings ?? verifySelfDiagnosticFilings;
  const verdicts = await verifyFilings(
    repo,
    eligible.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      familyId: familyByNumber.get(issue.number)!.id,
    })),
  );
  const filtered: FilterableIssue[] = [];
  for (const issue of eligible) {
    const verdict = verdicts.get(issue.number);
    if (!verdict?.attested) {
      const detail = verdict?.attested === false
        ? `${verdict.reason}: ${verdict.detail}`
        : "no filing attestation was returned for this issue";
      filterRefusals.push({
        issueNumber: issue.number,
        cause: "unattested",
        detail,
      });
      log(
        `[self-schedule] refused ${repo}#${issue.number}: ${detail} — a body ` +
          `marker is written by whoever writes the body, so it is not ` +
          `provenance on its own; the diagnostic waits for a human \`work-on\``,
      );
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "self-schedule-refused",
        detail,
      );
      continue;
    }
    const sourceDetail = await unreadableRunFailureSource(
      repo,
      issue,
      familyByNumber.get(issue.number)!,
      ghFn,
      deps.dedupAuthors,
      log,
    );
    if (sourceDetail !== null) {
      filterRefusals.push({
        issueNumber: issue.number,
        cause: "no-readable-source",
        detail: sourceDetail,
      });
      log(
        `[self-schedule] refused ${repo}#${issue.number}: ${sourceDetail} — ` +
          `it waits for a human \`work-on\``,
      );
      diag?.logIssueSkipped(
        repo,
        issue.number,
        "self-schedule-refused",
        sourceDetail,
      );
      continue;
    }
    filtered.push(issue);
  }
  if (filtered.length === 0) {
    return { candidates: [], refusals: filterRefusals };
  }

  const refusals: SelfScheduleRefusal[] = [...filterRefusals];
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

  // Issue #2873: one clock reading per scan, not per issue.
  const nowMs = Date.now();

  // Issue #2173: the lazy open-milestone lookup for the cross-milestone
  // dependency hold. Built once per repo and shared by every candidate; the
  // listing is only fetched if a closed dependency actually carries a
  // different milestone.
  const isMilestoneOpen = createOpenMilestoneLookup(repo, options.cache, ghFn);
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
          // Issue #3151: a merged PR blocks re-pickup permanently. Issue
          // #4298: that PR is the diagnostic's fix, so the worker closes the
          // diagnostic as resolved rather than asking a human to. If the fault
          // recurs, its filer opens a fresh diagnostic. Best-effort: a failed
          // close leaves it open for the next scan to retry.
          try {
            await ghFn([
              "issue",
              "close",
              String(issue.number),
              "--repo",
              repo,
              "--reason",
              "completed",
              "--comment",
              `Resolved by merged PR #${closedPR.number}, so this ` +
              `auto-filed diagnostic is closed (Issue #4298). If the fault ` +
              `recurs, the worker files a fresh one.`,
            ]);
            diag?.logIssueSkipped(
              repo,
              issue.number,
              "self-schedule-resolved",
              `PR #${closedPR.number}`,
            );
          } catch (err) {
            log(
              `[self-schedule] could not close ${repo}#${issue.number} ` +
                `resolved by merged PR #${closedPR.number}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
            );
          }
        }
        continue;
      }
    }

    if (repoPRs.length > 0) {
      const blockingPR = getBlockingPRForIssue(
        repoPRs,
        milestoneTitle,
        pushCapableAuthors,
        resolveFleetPrSlots(config, repo),
        issue.number,
      );
      if (blockingPR) {
        diag?.logIssueSkipped(
          repo,
          issue.number,
          "pr-blocked",
          describeBlockingPr(blockingPR),
        );
        continue;
      }
    }

    // Issue #2873: skip while the issue's own `Deferred until` clock has
    // not yet passed — getIssueBody is memoised, so this read is free.
    // Mirrors `isDependencyBlocked`'s own fail-safe: an unreadable body
    // fails toward NOT deferring rather than stalling the issue forever.
    if (
      await isIssueTimeDeferred(fetcher, repo, issue.number, nowMs, log)
    ) {
      diag?.logIssueSkipped(repo, issue.number, "time-deferred");
      continue;
    }

    if (
      await isDependencyBlocked(repo, issue.number, fetcher, openStateMap, {
        candidateMilestone: milestoneTitle,
        isMilestoneOpen,
      })
    ) {
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
        deps.dedupAuthors,
        log,
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

/**
 * Issue #4462: whether a run-failure issue names a readable source. A body
 * that withholds its source (a private repo) names none unless a fleet-authored
 * follow-up occurrence does, so the worker would otherwise guess the cause.
 * Returns the refusal detail, or null when the issue may be scheduled. The
 * follow-ups are read only for such an issue, and only fleet-authored ones
 * count.
 */
async function unreadableRunFailureSource(
  repo: string,
  issue: FilterableIssue,
  family: SelfDiagnosticFamily,
  ghFn: (args: string[]) => Promise<string>,
  dedupAuthors: AlertDedupAuthorOptions | undefined,
  log: (message: string) => void,
): Promise<string | null> {
  if (family.id !== RUN_FAILURE_FAMILY_ID) return null;
  const body = issue.body ?? "";
  if (runFailureNamesReadableSource(body, [])) return null;

  let rows: { author: string | null; body: string }[];
  try {
    const comments = await fetchIssueCommentPages(repo, issue.number, ghFn);
    rows = [];
    for (const raw of comments) {
      // A primitive has no `body`; `?.` covers a null entry.
      const comment = raw as
        | { body?: unknown; user?: { login?: unknown } }
        | null;
      if (typeof comment?.body !== "string") continue;
      if (parseRunFailureFollowUpMarker(comment.body) === null) continue;
      const login = comment.user?.login;
      rows.push({
        author: typeof login === "string" ? login : null,
        body: comment.body,
      });
    }
  } catch (err) {
    return `no readable source: could not read the follow-up comments: ` +
      errorText(err);
  }

  const verified = await selectFleetAuthoredComments(
    rows,
    `run-failure follow-ups on ${repo}#${issue.number}`,
    dedupAuthors ?? {},
    log,
    "the follow-up does not count, so the diagnostic waits for a human `work-on`",
  );
  if (runFailureNamesReadableSource(body, verified.map((row) => row.body))) {
    return null;
  }
  return "no readable source: every occurrence withheld its source (a private " +
    "repo), and no fleet-authored follow-up names one";
}

/** Message text of an unknown thrown value. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
