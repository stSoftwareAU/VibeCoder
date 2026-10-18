/**
 * Follow-up filing for a fix run's newly reported gap (Issue #3678).
 *
 * The completion phase files the follow-up for a criterion its PR summary
 * closes out as `partial` or `missing` (Issue #3506) through its degraded-
 * delivery guard. A fix run (review-fix, CI-fix, merge-conflict) never runs
 * that guard: it only rebuilds the PR body from the rewritten summary. So a
 * fix run that newly marks a criterion `partial` or `missing` on a PR whose
 * live body carries no leading section gets no follow-up and no section,
 * and the residue is recorded nowhere.
 *
 * This module is the sync's equivalent of the completion guard. Because the
 * sync fetches the parent issue afresh, it re-verifies the issue's title and
 * body with the pickup content-integrity check (`pickup_content_integrity.ts`;
 * THREAT-MODEL AP-7) before any of that text is written into a follow-up or a
 * comment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result, WorkerConfig } from "../types.ts";
import { parseClosureEntries } from "./acceptance_criteria_gate.ts";
import {
  assessReportedGaps,
  buildFollowUpChainStopSection,
  buildReportedGapPrSection,
  degradedNeedsFollowUp,
  fileDegradedFollowUp,
  handFollowUpToHuman,
  isPartialDeliveryFollowUp,
  isPendingMergeCheck,
} from "./degraded_delivery.ts";
import { ensureLabelExists } from "./label_operations.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import { resolveFleetMaintenanceAuthorSet } from "./fleet_authors.ts";
import {
  type PickupContentIntegrityOutcome,
  verifyPickupContentIntegrity,
} from "./pickup_content_integrity.ts";
import { withholdIssueClose } from "./missing_criterion_close_guard.ts";

/** `gh issue view --json` fields the sync reads for the parent issue. */
export const SYNC_PARENT_ISSUE_FIELDS = "title,body,labels,author,milestone";

/** The parent issue as the sync reads it from `gh issue view`. */
export interface SyncParentIssue {
  title: string;
  body: string;
  /** Label names, in the order gh reports them. */
  labels: string[];
  /** The author's login, or "" when gh reports none. */
  author: string;
  /** The milestone title, when the issue has a milestone. */
  milestoneTitle?: string;
}

/** The `gh issue view --json` shape {@link parseSyncParentIssue} reads. */
interface RawSyncParentIssue {
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  author?: unknown;
  milestone?: unknown;
}

/**
 * Parse `gh issue view --json title,body,labels,author,milestone` output.
 *
 * Throws, naming the missing field, when the title or body is not a string.
 * Non-string label names are skipped; a `null` milestone means none.
 */
export function parseSyncParentIssue(raw: string): SyncParentIssue {
  const parsed = JSON.parse(raw) as RawSyncParentIssue | null;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("gh issue view output is not a JSON object");
  }
  if (typeof parsed.title !== "string") {
    throw new Error("issue title missing from gh output");
  }
  if (typeof parsed.body !== "string") {
    throw new Error("issue body missing from gh output");
  }

  const labels: string[] = [];
  if (Array.isArray(parsed.labels)) {
    for (const label of parsed.labels) {
      const name = (label as { name?: unknown } | null)?.name;
      if (typeof name === "string") labels.push(name);
    }
  }

  const authorLogin = (parsed.author as { login?: unknown } | null)?.login;
  const milestoneTitle = (parsed.milestone as { title?: unknown } | null)
    ?.title;

  return {
    title: parsed.title,
    body: parsed.body,
    labels,
    author: typeof authorLogin === "string" ? authorLogin : "",
    ...(typeof milestoneTitle === "string" ? { milestoneTitle } : {}),
  };
}

/** What a sync needs to file a follow-up the live PR body does not yet point at. */
export interface SyncFollowUpFiling {
  /**
   * Re-verifies the parent issue's content with the pickup content-integrity
   * check (`pickup_content_integrity.ts`; THREAT-MODEL AP-7); `blocked` files
   * nothing.
   */
  verifyIssueContent: (
    repo: string,
    issueNumber: number,
    issue: SyncParentIssue,
  ) => Promise<PickupContentIntegrityOutcome>;
  /** Ensures a label exists in the repo before a follow-up carries it. */
  ensureLabelExists: (repo: string, label: string) => Promise<Result<void>>;
  /** Logins whose open follow-up counts as this run's own (Issue #1243). */
  fleetAuthors: readonly string[];
}

/**
 * The production {@link SyncFollowUpFiling}, built from the worker's config.
 *
 * `fleetAuthors` is the same set the completion phase's guard uses, so a
 * follow-up the sync reuses is one the completion phase would also reuse.
 */
export function buildSyncFollowUpFiling(
  config: WorkerConfig,
  githubUser: string,
): SyncFollowUpFiling {
  return {
    verifyIssueContent: (repo, issueNumber, issue) =>
      verifyPickupContentIntegrity({
        repo,
        issueNumber,
        issueTitle: issue.title,
        issueBody: issue.body,
        issueLabels: issue.labels,
        issueAuthor: issue.author,
        config,
        githubUser,
      }),
    ensureLabelExists: (repo, label) => ensureLabelExists(repo, label),
    fleetAuthors: resolveFleetMaintenanceAuthorSet({
      githubUser,
      fleetPrAuthors: config.fleetPrAuthors ?? [],
      serviceAccounts: config.serviceAccounts ?? [],
    }),
  };
}

/**
 * Whether a PR body reports an actionable partial or missing closure entry.
 *
 * This is the trigger, checked before the parent issue is fetched.
 */
export function summaryReportsGap(prBody: string): boolean {
  return parseClosureEntries(prBody).some((entry) =>
    (entry.status === "partial" || entry.status === "missing") &&
    !isPendingMergeCheck(entry)
  );
}

/**
 * File or reuse the follow-up for a fix run's newly reported gap, and return
 * the PR body with a section pointing at it (Issue #3678).
 *
 * Mirrors the completion phase's degraded-delivery guard. The caller calls
 * this only when {@link summaryReportsGap} holds. The helper also returns the
 * unchanged body when no actionable gap remains, before any filing side effect.
 *
 * Never throws. Every failure returns `{ ok: false }` naming the PR, the
 * issue and the cause, so the caller fails loudly rather than rebuild a body
 * whose gap is recorded nowhere.
 */
export async function addReportedGapSectionOnSync(args: {
  repo: string;
  issueNumber: number;
  prNumber: number;
  /** The rebuilt PR body. */
  body: string;
  issue: SyncParentIssue;
  filing: SyncFollowUpFiling | undefined;
  gh: (args: string[]) => Promise<string>;
  runId: string;
  logger: Logger;
}): Promise<Result<string>> {
  const {
    repo,
    issueNumber,
    prNumber,
    body,
    issue,
    filing,
    gh,
    runId,
    logger,
  } = args;
  const subject = `PR #${prNumber} (issue #${issueNumber})`;

  const verdict = assessReportedGaps(issue.body, body);
  if (!degradedNeedsFollowUp(verdict)) return { ok: true, value: body };

  if (filing === undefined) {
    return {
      ok: false,
      error: new Error(
        `Cannot record the partial or missing criteria of ${subject}: no ` +
          `follow-up filer is wired for this sync, so they cannot be ` +
          `recorded (Issue #3678)`,
      ),
    };
  }

  try {
    // The sync fetched the issue afresh, so its text is verified before any
    // of it reaches a follow-up or a comment (the pickup content-integrity
    // check, `pickup_content_integrity.ts`; THREAT-MODEL AP-7).
    const verified = await filing.verifyIssueContent(
      repo,
      issueNumber,
      issue,
    );
    if (verified.blocked) {
      return {
        ok: false,
        error: new Error(
          `Issue #${issueNumber} failed the pickup content-integrity check, ` +
            `so the follow-up for ${subject} was not filed: ${verified.reason}`,
        ),
      };
    }

    if (isPartialDeliveryFollowUp(issue.body)) {
      // This issue is itself a partial-delivery follow-up: filing another
      // would chain fleet runs without end, so the gaps go to a human
      // (PR #3676 review), exactly as the completion guard does.
      const handed = await handFollowUpToHuman({
        repo,
        issueNumber,
        verdict,
        runId,
        gh,
      });
      if (!handed.ok) {
        return {
          ok: false,
          error: new Error(
            `Could not hand the gaps of ${subject} to a human: ${handed.error.message}`,
          ),
        };
      }
      logger.warn(
        "Fix run newly reported partial or missing criteria on a partial-delivery follow-up — handed to a human, no nested follow-up filed (Issue #3678)",
        { repo, prNumber, issueNumber, shortfalls: verdict.shortfalls.length },
      );
      // The PR must not close the follow-up natively either.
      return {
        ok: true,
        value: buildFollowUpChainStopSection(verdict, issueNumber) +
          withholdIssueClose(body, issueNumber),
      };
    }

    const labelled = await filing.ensureLabelExists(repo, IDLE_TASK_LABEL);
    if (!labelled.ok) {
      logger.warn(
        "Could not ensure the idle-task label for the follow-up; filing anyway (Issue #3678)",
        {
          repo,
          prNumber,
          issueNumber,
          error: labelled.error.message,
        },
      );
    }

    const followUp = await fileDegradedFollowUp({
      repo,
      parentNumber: issueNumber,
      parentTitle: issue.title,
      verdict,
      runId,
      gh,
      dedupAuthors: { fleetAuthors: [...filing.fleetAuthors] },
      ...(issue.milestoneTitle ? { milestoneTitle: issue.milestoneTitle } : {}),
    });
    if (!followUp.ok) {
      return {
        ok: false,
        error: new Error(
          `Could not file or reuse the follow-up for ${subject}, so its partial or missing criteria are recorded nowhere: ${followUp.error.message}`,
        ),
      };
    }

    logger.warn(
      "Fix run newly reported partial or missing criteria — residue recorded in a follow-up (Issue #3678)",
      {
        repo,
        prNumber,
        issueNumber,
        followUp: followUp.value.number,
        reused: followUp.value.reused,
        shortfalls: verdict.shortfalls.length,
      },
    );
    return {
      ok: true,
      value: buildReportedGapPrSection(verdict, followUp.value.number) + body,
    };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Could not record the partial or missing criteria of ${subject}: ${cause}`,
      ),
    };
  }
}
