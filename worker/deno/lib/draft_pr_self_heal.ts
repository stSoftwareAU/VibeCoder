/**
 * Ready an orphaned fleet draft PR so the auto-merge sweep can arm it
 * (Issue #4952).
 *
 * A fleet draft is normally a draft continuation (Issue #4146), and the
 * completion path marks it ready when its issue finishes. A draft whose issue
 * has no live claim and whose body carries neither marker is different:
 * nothing will ever mark it ready, the sweep skips every draft (Issue #1800),
 * and it sits as a draft forever. This module is the narrow self-heal for
 * that case. It marks such a PR ready, waits for the ready-for-review CI to
 * start (Issue #4160), and reports whether the sweep may arm it straight away.
 *
 * A PR is healed only when every rule below holds; any doubt leaves it a draft:
 * - it is a draft, and its head branch names an issue (`issue-<N>-…`);
 * - its body does not open with `DRAFT_CONTINUATION_MARKER`. The check is
 *   anchored, not a substring match: every hold body the worker writes puts the
 *   marker on its first line (`buildDraftContinuationBody` and
 *   `buildUnmetDraftBody` in `draft_continuation_pr.ts`), and the PR-body sync
 *   keeps a leading marker when it rebuilds a body
 *   (`buildSyncedPrBodyCandidate`), so a held draft
 *   stays held after a merge-conflict repair or a completion exit. A body that
 *   merely quotes the marker mid-body, in a code span or in prose, is not a
 *   hold and may be healed. A body that opens with it, after any leading
 *   whitespace, is held. A false hold leaves a draft for a human or the next
 *   run, which is the safe direction, whereas a false heal would publish a
 *   deliberate hold;
 * - the issue is OPEN and no assignee is a fleet author (case-insensitive).
 *   A fleet-author assignee is a live claim (see `claim_issue.ts`). An issue
 *   read without an `assignees` array is a malformed response, so it is
 *   refused rather than read as unclaimed.
 *
 * Never throws: every failure is logged and reported as `false`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  errText,
  markDraftReadyAndAwaitCi,
  opensWithDraftContinuationMarker,
} from "./draft_continuation_pr.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
import { sanitiseLogField } from "./issue_finder_logger.ts";

/** Arguments for {@link readyOrphanedDraftPr}. */
export interface ReadyOrphanedDraftArgs {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** The draft PR's number. */
  prNumber: number;
  /** Head branch from the sweep's listing; the live read is preferred. */
  headRefName?: string;
  /** Runs `gh` and returns its stdout. */
  gh: (args: string[]) => Promise<string>;
  /** Fleet logins; an assignee among them is a live claim. */
  fleetAuthors: readonly string[];
  /** Warnings: a failure the operator should see. */
  log: (message: string) => void;
  /** Informational lines, e.g. the success line. Defaults to `log`. */
  info?: (message: string) => void;
  /** Waits between CI polls. Defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Mark an orphaned fleet draft ready and report whether its CI started.
 *
 * Returns `true` only when the PR was marked ready and its ready-for-review CI
 * started, so the sweep can arm auto-merge in the same pass. Returns `false`
 * for every other outcome, including a draft that is held, claimed, closed,
 * off-convention or unreadable: the sweep then skips it as before.
 */
export async function readyOrphanedDraftPr(
  args: ReadyOrphanedDraftArgs,
): Promise<boolean> {
  const { repo, prNumber, gh, fleetAuthors, log } = args;
  const info = args.info ?? log;
  const sleep = args.sleep ?? realSleep;
  const pr = String(prNumber);
  try {
    let view: { body?: unknown; isDraft?: unknown; headRefName?: unknown };
    try {
      view = JSON.parse(
        await gh([
          "pr",
          "view",
          pr,
          "--repo",
          repo,
          "--json",
          "body,isDraft,headRefName",
        ]),
      ) as typeof view;
    } catch (err) {
      log(
        `could not read PR #${prNumber} to judge whether its draft is ` +
          `orphaned, so it stays a draft (Issue #4952): ${errText(err)}`,
      );
      return false;
    }
    if (view.isDraft !== true) return false;
    if (typeof view.body !== "string") {
      log(
        `PR #${prNumber}'s body was unreadable, so its draft stays a draft ` +
          "(Issue #4952)",
      );
      return false;
    }
    // Fail closed on a hold: the worker writes the marker as the first line,
    // so a body that opens with it (after leading whitespace) is held. A body
    // that only quotes the marker mid-body is not a hold (see module doc).
    if (opensWithDraftContinuationMarker(view.body)) {
      return false;
    }

    const branch = typeof view.headRefName === "string"
      ? view.headRefName
      : (args.headRefName ?? "");
    const issueNumber = issueNumberFromBranch(branch);
    if (issueNumber === null) return false;

    let issue: { state?: unknown; assignees?: unknown };
    try {
      issue = JSON.parse(
        await gh([
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          repo,
          "--json",
          "state,assignees",
        ]),
      ) as typeof issue;
    } catch (err) {
      log(
        `could not read issue #${issueNumber} for PR #${prNumber}, so its ` +
          `draft stays a draft (Issue #4952): ${errText(err)}`,
      );
      return false;
    }
    if (issue.state !== "OPEN") return false;
    if (!Array.isArray(issue.assignees)) {
      log(
        `issue #${issueNumber} read for PR #${prNumber} has no assignees ` +
          "field, so its draft stays a draft (Issue #4952)",
      );
      return false;
    }
    const claimed = issue.assignees.some((assignee) =>
      isFleetAuthor(
        (assignee as { login?: string | null } | null)?.login,
        [...fleetAuthors],
      )
    );
    if (claimed) return false;

    const result = await markDraftReadyAndAwaitCi({
      repo,
      prNumber,
      gh,
      sleep,
      log,
    });
    if (result.ready) {
      info(`Marked orphaned fleet draft PR #${prNumber} ready (Issue #4952)`);
    } else {
      log(
        `orphaned fleet draft PR #${prNumber} was not marked ready ` +
          "(Issue #4952)",
      );
    }
    return result.ciStarted;
  } catch (err) {
    log(
      `orphaned draft self-heal for PR #${prNumber} failed (Issue #4952): ` +
        sanitiseLogField(errText(err)),
    );
    return false;
  }
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
