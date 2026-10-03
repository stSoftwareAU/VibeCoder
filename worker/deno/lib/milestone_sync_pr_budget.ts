/**
 * The milestone sync's side of the shared per-PR conflict-resolution budget
 * (Issue #2998, spending from the shared budget Issue #2996 introduced).
 *
 * A milestone branch with an open PR against it — raised because a
 * repository rule refused the direct push (Issue #589) — must charge its
 * conflict attempts to that PR's own shared tally, exactly like the
 * stale-verdict ladder and the takeover rung: three resolution attempts per
 * PR in total, not three per pass. A milestone branch with **no** open PR has
 * nowhere to post that tally, so it keeps the local ledger
 * (`milestone_sync_streak.ts`) as the fallback this issue's predecessor
 * (#2919) established.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type AlertDedupAuthorOptions,
  resolveAlertDedupAuthors,
} from "./alert_dedup_authors.ts";
import {
  conflictAttemptMarker,
  conflictFailedMarker,
  type ConflictResolutionAttempt,
  conflictResolvedMarker,
  isConflictHeadSha,
  readResolutionAttempts,
} from "./merge_conflict_markers.ts";
import { spentConflictAttempts } from "./pr_merge_conflict_scan.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import type { GhCommandFn } from "./milestone_branch_sync.ts";
import { parsePrListRows } from "./milestone_sync_landing.ts";

/** The open PR carrying a milestone branch's head, with its attempt history. */
export interface MilestoneHeadPr {
  /** The PR number the milestone branch is the head of. */
  number: number;
  /** The PR's live head sha, lowercased. */
  headSha: string;
  /** The shared conflict-resolution attempts already recorded on it. */
  attempts: ConflictResolutionAttempt[];
}

/**
 * Read the open PR a milestone branch is the head of, and its shared
 * conflict-resolution attempt history (Issue #2998).
 *
 * `null` means there is no open PR — the sync falls back to the local
 * ledger — whether because none exists or because reading one failed; a read
 * that cannot be trusted must not let the sync charge the wrong tally.
 */
export async function readMilestoneHeadPr(
  repo: string,
  milestoneBranch: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  dedupAuthors: AlertDedupAuthorOptions = {},
): Promise<MilestoneHeadPr | null> {
  let rows: ReturnType<typeof parsePrListRows>;
  try {
    const raw = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      milestoneBranch,
      "--state",
      "open",
      "--json",
      "number,headRefOid",
      "--limit",
      "1",
    ]);
    rows = parsePrListRows(raw);
  } catch (err) {
    log(
      `WARNING: Could not list the open PR for milestone branch ` +
        `'${milestoneBranch}' in ${repo}: ${
          err instanceof Error ? err.message : String(err)
        } — the sync falls back to the local ledger (Issue #2998)`,
    );
    return null;
  }
  if (rows.length === 0) return null;

  const row = rows[0]!;
  const number = typeof row.number === "number" ? row.number : undefined;
  const headSha = typeof row.headRefOid === "string"
    ? row.headRefOid.trim().toLowerCase()
    : undefined;
  if (number === undefined || !headSha || !isConflictHeadSha(headSha)) {
    log(
      `WARNING: Open PR for milestone branch '${milestoneBranch}' in ${repo} ` +
        `carried no readable head sha — the sync falls back to the local ` +
        `ledger (Issue #2998)`,
    );
    return null;
  }

  try {
    const comments = await fetchIssueCommentPages(repo, number, ghCommandFn);
    const trusted = await resolveAlertDedupAuthors(dedupAuthors, log);
    const attempts = readResolutionAttempts(
      comments,
      (login) => isFleetAuthor(login, trusted),
    );
    return { number, headSha, attempts };
  } catch (err) {
    log(
      `WARNING: Could not read the conflict-resolution attempt history on ` +
        `PR #${number} in ${repo} — the sync falls back to the local ledger ` +
        `(Issue #2998): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Build the comment that carries both the attempt marker and its conclusion
 * for one milestone sync conflict-resolution attempt on a PR (Issue #2998).
 *
 * One comment, not two: every other pass in this vocabulary (the ladder, the
 * takeover rung) posts the opening and the conclusion in a single comment
 * where the conclusion is known straight away, and `readResolutionAttempts`
 * already reads a comment carrying both markers as the conclusion.
 */
export function buildSyncAttemptComment(
  attemptNumber: number,
  outcome: "resolved" | "failed",
  headSha: string,
  detail: string,
): string {
  const verb = outcome === "resolved" ? "resolved" : "failed";
  const conclusionMarker = outcome === "resolved"
    ? conflictResolvedMarker("sync", headSha)
    : conflictFailedMarker(attemptNumber, "sync", headSha);
  return [
    `Milestone sync conflict attempt ${attemptNumber} (pass \`sync\`) ` +
    `${verb}: ${detail} (Issue #2998)`,
    conflictAttemptMarker(attemptNumber, "sync", headSha),
    conclusionMarker,
  ].join("\n");
}

/**
 * Record one milestone sync conflict-resolution attempt against the PR's
 * shared budget (Issue #2998).
 *
 * Best-effort: a post that fails is warned about and returns `false`, so the
 * caller's own decision stands either way — the sync itself must not fail
 * because its budget-tally comment could not be posted.
 */
export async function recordSyncAttemptOnPr(
  repo: string,
  pr: MilestoneHeadPr,
  outcome: "resolved" | "failed",
  detail: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  /**
   * The head sha the marker names, when it differs from the PR's own live
   * head (Issue #2998) — a resolved marker names the merge that actually
   * landed, not necessarily `pr.headSha`. Defaults to `pr.headSha`.
   */
  markerSha?: string,
): Promise<boolean> {
  const attemptNumber = spentConflictAttempts(pr.attempts) + 1;
  const body = buildSyncAttemptComment(
    attemptNumber,
    outcome,
    markerSha ?? pr.headSha,
    detail,
  );
  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(pr.number),
      "--repo",
      repo,
      "--body",
      body,
    ]);
    return true;
  } catch (err) {
    log(
      `WARNING: Could not post the milestone sync conflict-attempt marker ` +
        `on PR #${pr.number} in ${repo}: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #2998)`,
    );
    return false;
  }
}
