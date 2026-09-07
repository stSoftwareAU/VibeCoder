/**
 * Repo-wide sweep for issues whose fix has already merged (Issue #504).
 *
 * `ensureIssueClosedIfPrMerged` is the worker's belt-and-braces closer, but
 * every call site sits inside a claim the worker is holding for that issue.
 * An issue fixed by a PR the worker did not author — or by one whose run died
 * between the merge and its completion phase — was therefore never closed by
 * anything. It stayed open for ever, and the claim scan refused it on every
 * cycle as `merged-pr-permanent`, a blocker that by design never clears.
 *
 * This module points that same closer at exactly the set that cannot heal
 * itself. It invents no new rule: the candidate set is the claim scan's own
 * (`isBlockedByRecentlyClosedPR` over the fleet's closed/merged PRs, taking
 * only the `merged` verdicts), and every gate the scan and the closer already
 * apply still applies here —
 *
 *  - the Issue #319 title matcher, so a PR that merely mentions `#N` in a
 *    repo-qualified or PR-qualified way is not read as its fix;
 *  - the Issue #482 ordering guard, so a merge can never close an issue filed
 *    after it;
 *  - the Issue #4396 merge-landing check, so a merge that went nowhere leaves
 *    the issue open, loudly;
 *  - the VibeCoder#42 escape hatch, so a trusted re-label dated after the
 *    merge hands the issue back to the fleet instead of closing it;
 *  - `needs-human`, which a merge somewhere never resolves.
 *
 * Failures are loud: a repo that cannot be scanned, or a close that fails, is
 * recorded in {@link MergedPrIssueSweepResult.failures} and surfaces as a
 * failed housekeeping step rather than an empty, green sweep.
 *
 * Quota is the one exception, and it is a skip, not a failure (Issue #1477).
 * The sweep used to loop every monitored repo against an exhausted GraphQL
 * quota — nineteen doomed calls in seven seconds, reported as nineteen repo
 * failures for one condition. Now it pre-flights once per sweep, stops at
 * the first rate-limit response, and reports one skipped sweep that resumes
 * next cycle. It also reads through the shared issue and timeline caches the
 * discovery passes already fill, and keeps a per-repo watermark like its
 * sibling merged-PR sweeps, so a quiet repo costs the cached lists and
 * nothing more.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import { DISCOVERY_LABELS, LABEL_DEFAULTS } from "./config_defaults.ts";
import { ensureIssueClosedIfPrMerged } from "./issue_lifecycle.ts";
import {
  type ClosedPR,
  fetchAllIssues,
  fetchRecentlyClosedPRsForFleet,
  isBlockedByRecentlyClosedPR,
  wasLabelReappliedAfterClosedPR,
} from "./issue_query.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import type { IssueCache } from "./issue_cache.ts";
import type { TimelineCache } from "./timeline_cache.ts";
import type { MergeLanding } from "./merge_landing.ts";
import { classifyMergeCloseOrdering } from "./pr_issue_linking.ts";
import type { PreflightOutcome } from "./github_rate_limit_preflight.ts";
import {
  isPrimaryQuotaLatched,
  isPrimaryRateLimitMessage,
} from "./primary_quota_latch.ts";
import {
  loadSweepWatermarks,
  saveSweepWatermarks,
} from "./merged_sweep_watermark.ts";

/** Default cooldown for the closed-unmerged half of the fleet PR fetch. */
const DEFAULT_CLOSED_PR_COOLDOWN_SECONDS = 3600;

/** Default ceiling on open issues examined per repo. */
const DEFAULT_ISSUE_LIMIT = 200;

/** Inputs controlling the sweep. */
export interface MergedPrIssueSweepOptions {
  /** Monitored repositories in "owner/repo" format. */
  repos: string[];
  /** The worker's GitHub login (unassigned from any issue it closes). */
  githubUser: string;
  /**
   * Fleet PR author set — the same one the claim scan uses, so the sweep's
   * candidate set is exactly the set the scan refuses.
   */
  fleetAuthors: string[];
  /** Trusted authors whose re-label after the merge reopens the work. */
  allowedAuthors: string[];
  /** Escalation label that must never be closed by the sweep. */
  needsHumanLabel?: string;
  /** Deliberately-open planning label, held back like `closeIssuesForMergedPrs`. */
  planningLabel?: string;
  /** Pickup labels whose trusted re-application after a merge reopens work. */
  pickupLabels?: string[];
  /** Cooldown window for closed-unmerged PRs (merged PRs ignore it). */
  closedPrCooldownSeconds?: number;
  /** Maximum open issues examined per repo. */
  issueLimit?: number;
  /**
   * Path of the per-repo sweep watermark file (Issue #1477). When set, a
   * candidate whose merged PR is at or below the persisted watermark was
   * handled on an earlier cycle and is skipped without any network traffic.
   * The watermark advances only past PRs the sweep closed or ruled out for
   * good; anything it left open — `needs-human`, a change that has not
   * landed, a failed close — holds it back so that PR is reconsidered next
   * cycle. Unset (tests, ad hoc runs) means no persistence.
   */
  watermarkPath?: string;
}

/** Injectable dependency seam. */
export interface MergedPrIssueSweepDeps {
  /** Function to run gh CLI commands. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Logger for diagnostic output. */
  logger: Logger;
  /**
   * The shared scan cache (Issue #1477). The open-issue and closed-PR lists
   * this sweep needs are the same ones the discovery passes fetch for the
   * same repos in the same cycle; reading through the cache removes the
   * whole per-repo × per-author fan-out on a warm cycle.
   */
  cache?: IssueCache;
  /** The shared timeline cache for the trusted-re-label check. */
  timelineCache?: TimelineCache;
  /**
   * Once-per-sweep rate-limit pre-flight (Issue #1477). A rate-limited
   * outcome skips the whole sweep before it spends a single call. Omitted
   * in tests and ad hoc runs.
   */
  preflightFn?: () => Promise<PreflightOutcome>;
  /**
   * Whether the process-wide primary-quota latch is set (defaults to
   * {@link isPrimaryQuotaLatched}). Checked before every repo, so a latch
   * fired elsewhere in the process stops the sweep without a call.
   */
  isQuotaLatchedFn?: () => boolean;
  /** Open-issue fetch (defaults to {@link fetchAllIssues}). */
  fetchOpenIssuesFn?: (repo: string) => Promise<FilterableIssue[]>;
  /** Closed/merged fleet PR fetch (defaults to the claim scan's fetcher). */
  fetchClosedPRsFn?: (repo: string) => Promise<ClosedPR[]>;
  /** The closer (defaults to {@link ensureIssueClosedIfPrMerged}). */
  ensureIssueClosedFn?: typeof ensureIssueClosedIfPrMerged;
  /** Trusted-re-label check (defaults to the claim scan's). */
  wasLabelReappliedFn?: typeof wasLabelReappliedAfterClosedPR;
}

/** What the sweep decided for one candidate issue. */
export type MergedPrIssueSweepOutcome = "closed" | "skipped" | "failed";

/** One candidate issue's outcome, for logging and assertions. */
export interface MergedPrIssueSweepRecord {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** The open issue examined. */
  issueNumber: number;
  /** The merged PR that names it. */
  prNumber: number;
  /** What the sweep did. */
  outcome: MergedPrIssueSweepOutcome;
  /** Why — always populated, including for a close. */
  reason: string;
}

/** Outcome of a full sweep. */
export interface MergedPrIssueSweepResult {
  /** Open issues examined across every repo. */
  scanned: number;
  /** Issues named by a merged fleet PR (the `merged-pr-permanent` set). */
  candidates: number;
  /** Issues closed by this sweep. */
  closed: number;
  /** Per-candidate outcomes, in examination order. */
  records: MergedPrIssueSweepRecord[];
  /** Loud failures: a repo that could not be scanned, or a close that failed. */
  failures: string[];
  /**
   * Set when the sweep stopped for want of GraphQL quota (Issue #1477): the
   * one-line condition. Not a failure — the sweep resumes next cycle.
   */
  quotaExhausted?: string;
  /** Repos left unswept by the quota stop, including the one that hit it. */
  reposSkipped: number;
  /** Candidates skipped without a call because their PR is below the watermark. */
  belowWatermark: number;
  /** Human-readable summary for the housekeeping log. */
  message: string;
}

/**
 * Build the close comment. A wrong close must be traceable to its cause from
 * the issue alone, so it names the PR, the merge commit and how that merge
 * reached the default branch.
 */
export function buildSweepCloseComment(
  prNumber: number,
  landing: Extract<MergeLanding, { landed: true }>,
): string {
  return `Closed automatically — PR #${prNumber} merged and its change landed ` +
    `(merge commit \`${landing.mergeCommit}\`, via \`${landing.via}\`).\n\n` +
    `This issue was not closed by the run that produced the fix, so every ` +
    `claim scan refused it as \`merged-pr-permanent\` while it stayed open. ` +
    `The housekeeping merged-PR issue sweep closed it (Issue #504).`;
}

/** Fold a repo failure into the result, loudly. */
function recordFailure(
  result: MergedPrIssueSweepResult,
  logger: Logger,
  message: string,
): void {
  result.failures.push(message);
  logger.error(`[merged-pr-issue-sweep] ${message}`);
}

/**
 * Whether a trusted author re-applied any pickup label after the PR merged
 * — VibeCoder#42's escape hatch. When they did, the issue is claimable again
 * and closing it would fight the human who reopened the work.
 */
async function wasReopenedByTrustedRelabel(
  repo: string,
  issueNumber: number,
  mergedPR: ClosedPR,
  pickupLabels: string[],
  allowedAuthors: string[],
  deps: MergedPrIssueSweepDeps,
): Promise<boolean> {
  const check = deps.wasLabelReappliedFn ?? wasLabelReappliedAfterClosedPR;
  for (const label of pickupLabels) {
    const reapplied = await check(
      repo,
      issueNumber,
      label,
      allowedAuthors,
      mergedPR,
      deps.ghCommandFn,
      deps.timelineCache,
    );
    if (reapplied) return true;
  }
  return false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record the quota stop (Issue #1477): one warning line naming the
 * condition and how much of the sweep it left for the next cycle. Never a
 * failure — nothing is wrong with any repository.
 */
function stopForQuota(
  result: MergedPrIssueSweepResult,
  logger: Logger,
  reposTotal: number,
  reposDone: number,
  condition: string,
): void {
  result.quotaExhausted = condition;
  result.reposSkipped = reposTotal - reposDone;
  logger.warn(
    `[merged-pr-issue-sweep] GraphQL quota exhausted — sweep skipped, ` +
      `${result.reposSkipped} of ${reposTotal} repo(s) left for the next ` +
      `cycle: ${condition}`,
  );
}

/**
 * Close every open issue whose fix has demonstrably merged and landed,
 * whoever authored the PR (Issue #504).
 *
 * @param options - Repos, fleet authors and label configuration.
 * @param deps - Injectable seam (gh, logger, and the reused gates).
 * @returns The sweep outcome, including loud per-repo failures.
 */
export async function sweepMergedPrIssues(
  options: MergedPrIssueSweepOptions,
  deps: MergedPrIssueSweepDeps,
): Promise<MergedPrIssueSweepResult> {
  const { logger } = deps;
  const needsHumanLabel = options.needsHumanLabel ??
    LABEL_DEFAULTS.needsHumanLabel;
  const planningLabel = options.planningLabel ?? LABEL_DEFAULTS.planningLabel;
  const pickupLabels = options.pickupLabels ?? [...DISCOVERY_LABELS];
  const cooldown = options.closedPrCooldownSeconds ??
    DEFAULT_CLOSED_PR_COOLDOWN_SECONDS;
  const issueLimit = options.issueLimit ?? DEFAULT_ISSUE_LIMIT;

  const fetchOpenIssues = deps.fetchOpenIssuesFn ??
    ((repo: string) =>
      fetchAllIssues(repo, deps.cache, issueLimit, deps.ghCommandFn));
  const fetchClosedPRs = deps.fetchClosedPRsFn ??
    ((repo: string) =>
      fetchRecentlyClosedPRsForFleet(
        repo,
        options.fleetAuthors,
        cooldown,
        deps.cache,
        deps.ghCommandFn,
      ));
  const closeIssue = deps.ensureIssueClosedFn ?? ensureIssueClosedIfPrMerged;
  const isQuotaLatched = deps.isQuotaLatchedFn ?? isPrimaryQuotaLatched;

  const result: MergedPrIssueSweepResult = {
    scanned: 0,
    candidates: 0,
    closed: 0,
    records: [],
    failures: [],
    reposSkipped: 0,
    belowWatermark: 0,
    message: "",
  };
  const reposTotal = options.repos.length;

  // Issue #1477: ask once, before spending anything. The pre-flight reads
  // the shared signal and the cached quota reading, so on a healthy cycle
  // it is free, and on an exhausted one it is the only call made.
  if (reposTotal > 0 && deps.preflightFn) {
    const preflight = await deps.preflightFn();
    if (preflight.rateLimited) {
      stopForQuota(result, logger, reposTotal, 0, preflight.message);
      result.message = summarise(result, options);
      return result;
    }
  }

  // Sweep watermarks (Issue #1477): a candidate whose merged PR is at or
  // below the repo's watermark was handled on an earlier cycle and costs
  // nothing now. The watermark only advances past PRs the sweep closed or
  // ruled out for good; everything it left open holds it back.
  const watermarkPath = options.watermarkPath;
  const watermarks = watermarkPath
    ? await loadSweepWatermarks(watermarkPath)
    : {};
  let watermarksDirty = false;

  let reposDone = 0;
  repos: for (const repo of options.repos) {
    // A latch fired anywhere in this process — by an earlier step, or by
    // this sweep's own previous call — means every further GraphQL call is
    // known to fail. Stop here, without a call.
    if (isQuotaLatched()) {
      stopForQuota(
        result,
        logger,
        reposTotal,
        reposDone,
        "primary GraphQL quota latched for this process",
      );
      break;
    }

    let issues: FilterableIssue[];
    let closedPRs: ClosedPR[];
    try {
      issues = await fetchOpenIssues(repo);
      closedPRs = await fetchClosedPRs(repo);
    } catch (err) {
      const message = errorMessage(err);
      if (isPrimaryRateLimitMessage(message)) {
        // The first call told us the quota is gone. Every repo after this
        // one would fail the same way — one condition, reported once.
        stopForQuota(result, logger, reposTotal, reposDone, message);
        break;
      }
      recordFailure(result, logger, `could not scan ${repo}: ${message}`);
      reposDone++;
      continue;
    }

    const mark = watermarks[repo] ?? 0;
    let windowMax = 0;
    for (const pr of closedPRs) {
      if (pr.merged && pr.number > windowMax) windowMax = pr.number;
    }
    // Lowest merged PR this cycle left undone; the watermark stops below it.
    let holdBack = Number.POSITIVE_INFINITY;

    for (const issue of issues) {
      result.scanned++;

      // The claim scan's own verdict: only a **merged** match is the
      // permanent block this sweep exists to clear. A closed-unmerged match
      // is a cooldown that expires by itself.
      const blocking = isBlockedByRecentlyClosedPR(closedPRs, issue.number);
      if (!blocking || !blocking.merged) continue;
      if (blocking.number <= mark) {
        result.belowWatermark++;
        continue;
      }
      result.candidates++;

      const note = (
        outcome: MergedPrIssueSweepOutcome,
        reason: string,
        settled = false,
      ): void => {
        result.records.push({
          repo,
          issueNumber: issue.number,
          prNumber: blocking.number,
          outcome,
          reason,
        });
        // Only a close, or a verdict that can never change, lets the
        // watermark pass this PR.
        if (outcome !== "closed" && !settled) {
          holdBack = Math.min(holdBack, blocking.number);
        }
      };

      if (issue.labels.includes(needsHumanLabel)) {
        note(
          "skipped",
          `carries \`${needsHumanLabel}\` — a human escalation ` +
            `is not resolved by a merge elsewhere`,
        );
        continue;
      }

      if (issue.labels.includes(planningLabel)) {
        note("skipped", `carries \`${planningLabel}\` — deliberately open`);
        continue;
      }

      // Issue #482: a fix cannot predate the thing it fixes. Issues and PRs
      // share one number sequence, so a stale reference in an already-merged
      // PR must never close whatever later took that number.
      const ordering = classifyMergeCloseOrdering(
        blocking.closedAt,
        issue.createdAt,
      );
      if (ordering !== "issue-predates-merge") {
        note(
          "skipped",
          `PR #${blocking.number} merged before the issue was filed ` +
            `(${ordering}) — it cannot be its fix (Issue #482)`,
          true,
        );
        continue;
      }

      let reopened: boolean;
      try {
        reopened = await wasReopenedByTrustedRelabel(
          repo,
          issue.number,
          blocking,
          pickupLabels,
          options.allowedAuthors,
          deps,
        );
      } catch (err) {
        const message = errorMessage(err);
        if (isPrimaryRateLimitMessage(message)) {
          stopForQuota(result, logger, reposTotal, reposDone, message);
          break repos;
        }
        // An unreadable timeline cannot prove the issue was NOT reopened, so
        // fail closed: leave it open and say why.
        note("skipped", `could not read the label timeline: ${message}`);
        continue;
      }
      if (reopened) {
        note(
          "skipped",
          `a trusted re-label after the merge reopened it for the fleet`,
        );
        continue;
      }

      const closeResult = await closeIssue(
        repo,
        issue.number,
        blocking.number,
        options.githubUser,
        {
          ghCommandFn: deps.ghCommandFn,
          logger,
          closeCommentFn: ({ prNumber, landing }) =>
            buildSweepCloseComment(prNumber, landing),
        },
        // No run branch: the whole point is that this run did not author the
        // PR, so the Issue #174 provenance guard does not apply.
        undefined,
      );

      if (!closeResult.ok) {
        if (isPrimaryRateLimitMessage(closeResult.error.message)) {
          stopForQuota(
            result,
            logger,
            reposTotal,
            reposDone,
            closeResult.error.message,
          );
          break repos;
        }
        note("failed", closeResult.error.message);
        recordFailure(
          result,
          logger,
          `${repo}#${issue.number}: ${closeResult.error.message}`,
        );
        continue;
      }

      if (closeResult.value.closed) {
        result.closed++;
        note("closed", closeResult.value.reason);
        logger.info(
          `[merged-pr-issue-sweep] closed ${repo}#${issue.number} — ` +
            `PR #${blocking.number} merged and landed`,
        );
      } else {
        note("skipped", closeResult.value.reason);
      }
    }

    reposDone++;
    if (watermarkPath && windowMax > 0) {
      const advanced = Math.max(mark, Math.min(windowMax, holdBack - 1));
      if (advanced !== mark) {
        watermarks[repo] = advanced;
        watermarksDirty = true;
      }
    }
  }

  if (watermarkPath && watermarksDirty) {
    try {
      await saveSweepWatermarks(watermarkPath, watermarks);
    } catch {
      // Persistence is an optimisation — never fail the sweep over it.
    }
  }

  result.message = summarise(result, options);
  return result;
}

/** The one-line housekeeping summary. */
function summarise(
  result: MergedPrIssueSweepResult,
  options: MergedPrIssueSweepOptions,
): string {
  const failureNote = result.failures.length > 0
    ? `, ${result.failures.length} repo failure${
      result.failures.length === 1 ? "" : "s"
    }`
    : "";
  const watermarkNote = result.belowWatermark > 0
    ? `, ${result.belowWatermark} below watermark`
    : "";
  const quotaNote = result.quotaExhausted !== undefined
    ? ` — quota exhausted, sweep skipped (${result.reposSkipped} repo(s) ` +
      `left), resumes next cycle`
    : "";
  return `closed ${result.closed} of ${result.candidates} ` +
    `merged-PR issue(s) across ${options.repos.length} repo(s) ` +
    `(${result.scanned} open issues scanned)${watermarkNote}${failureNote}` +
    quotaNote;
}
