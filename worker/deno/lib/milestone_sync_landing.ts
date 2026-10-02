/**
 * Confirm a sync merge actually landed before anything is reported
 * (Issue #2998).
 *
 * `pushSyncedMilestoneBranch` can return `ok: true` for a merge a repository
 * rule then refused to push, and the sync PR it fell back to may never have
 * been raised. Reporting a conflict resolution as landed when it never
 * reached the milestone tip — or an open sync PR holding it — would tell a
 * reader to check a decision that does not exist yet. This module is the
 * fail-closed check between "the sync says it merged" and "the report goes
 * out": nothing here ever defaults to success.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GhCommandFn } from "./milestone_branch_sync.ts";
import { isConflictHeadSha } from "./merge_conflict_markers.ts";
import { resolveBranchTips, UNRESOLVED_SHA } from "./milestone_sync_conflict.ts";
import { syncBranchFor } from "./milestone_sync_pr.ts";

/** Where a confirmed merge actually landed. */
export type SyncLanding =
  // sha = the merge sha, confirmed at the tip of `branch`.
  | { kind: "tip"; branch: string; sha: string }
  // sha = the merge sha, held by the open sync PR's head.
  | { kind: "sync-pr"; prNumber: number; sha: string };

/** The merge could not be confirmed anywhere — nothing is reported. */
export interface UnconfirmedLanding {
  kind: "unconfirmed";
  expectedSha: string;
  observedSha: string;
  reason: string;
}

/** Either a confirmed landing or the reason none could be confirmed. */
export type LandingCheck = SyncLanding | UnconfirmedLanding;

/** One PR as `gh pr list --json number,headRefOid` reports it. */
interface SyncPrListRow {
  number?: unknown;
  headRefOid?: unknown;
}

/**
 * Parse a `gh pr list` payload, tolerating an empty body.
 *
 * Exported so {@link readMilestoneHeadPr} in `milestone_sync_pr_budget.ts`
 * shares this one parser rather than keeping a second copy of it
 * (Issue #2998).
 */
export function parsePrListRows(raw: string): SyncPrListRow[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed as SyncPrListRow[] : [];
}

/**
 * Compare two commits via the GitHub API, returning the `--jq .status` value,
 * or `undefined` when the comparison itself failed.
 */
async function compareStatus(
  repo: string,
  base: string,
  head: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<string | undefined> {
  try {
    const out = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${base}...${head}`,
      "--jq",
      ".status",
    ]);
    return out.trim();
  } catch (err) {
    log(
      `WARNING: Could not compare '${base}' with '${head}' in ${repo} while ` +
        `confirming a milestone sync landing: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #2998)`,
    );
    return undefined;
  }
}

/**
 * Render the WARNING line logged wherever a merge's landing could not be
 * confirmed (Issue #2998) — one renderer, so the sweep and the pre-cut sync
 * cannot report the same condition in two different wordings.
 *
 * @param repo - Repository in `owner/repo` form
 * @param milestoneBranch - The branch the sync merged into
 * @param landing - Why the landing could not be confirmed
 */
export function describeUnconfirmedLanding(
  repo: string,
  milestoneBranch: string,
  landing: UnconfirmedLanding,
): string {
  return `WARNING: Milestone sync conflict for '${milestoneBranch}' in ` +
    `${repo}: the merge ${landing.expectedSha} is not confirmed on ` +
    `'${milestoneBranch}' in ${repo} — observed tip ` +
    `${landing.observedSha}: ${landing.reason}; no report posted ` +
    `(Issue #2998)`;
}

/**
 * Confirm a sync merge landed on the milestone tip, or is held by an open
 * sync PR, before anything is reported about it (Issue #2998).
 *
 * Fail closed throughout: an unreadable tip, a missing merge sha, a failed
 * comparison or a PR listing nothing confirms the landing — each returns
 * `unconfirmed` rather than assuming the merge is somewhere it cannot be
 * shown to be.
 *
 * @param repo - Repository in `owner/repo` form.
 * @param milestoneBranch - The branch the sync merged into.
 * @param mergeSha - The merge commit the sync produced, when it could read one.
 * @param ghCommandFn - Injected `gh` CLI runner.
 * @param log - Sink for the warnings a degraded check leaves behind.
 */
export async function confirmSyncLanding(
  repo: string,
  milestoneBranch: string,
  mergeSha: string | undefined,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<LandingCheck> {
  const [tip] = await resolveBranchTips(
    repo,
    [{ branch: milestoneBranch }],
    ghCommandFn,
    log,
  );
  const observed = (tip?.sha ?? UNRESOLVED_SHA).trim().toLowerCase();

  const trimmedExpected = mergeSha?.trim().toLowerCase();
  if (
    trimmedExpected === undefined || trimmedExpected.length === 0 ||
    !isConflictHeadSha(trimmedExpected)
  ) {
    return {
      kind: "unconfirmed",
      expectedSha: trimmedExpected && trimmedExpected.length > 0
        ? trimmedExpected
        : UNRESOLVED_SHA,
      observedSha: observed,
      reason: "the sync recorded no merge commit",
    };
  }
  const expected = trimmedExpected;

  if (observed === UNRESOLVED_SHA || !isConflictHeadSha(observed)) {
    return {
      kind: "unconfirmed",
      expectedSha: expected,
      observedSha: observed,
      reason: "the milestone tip could not be read",
    };
  }

  if (observed === expected) {
    return { kind: "tip", branch: milestoneBranch, sha: expected };
  }

  const tipStatus = await compareStatus(
    repo,
    expected,
    observed,
    ghCommandFn,
    log,
  );
  if (tipStatus === "identical" || tipStatus === "ahead") {
    return { kind: "tip", branch: milestoneBranch, sha: expected };
  }

  // The tip does not carry it — the last place it might be is an open sync
  // PR raised because a repository rule refused the direct push (Issue #2998
  // atop #589's PR fallback).
  const syncBranch = syncBranchFor(milestoneBranch);
  try {
    const raw = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      syncBranch,
      "--base",
      milestoneBranch,
      "--state",
      "open",
      "--json",
      "number,headRefOid",
      "--limit",
      "10",
    ]);
    for (const row of parsePrListRows(raw)) {
      const prNumber = typeof row.number === "number" ? row.number : undefined;
      const headRefOid = typeof row.headRefOid === "string"
        ? row.headRefOid.trim().toLowerCase()
        : undefined;
      if (prNumber === undefined || !headRefOid || !isConflictHeadSha(headRefOid)) {
        continue;
      }
      if (headRefOid === expected) {
        return { kind: "sync-pr", prNumber, sha: expected };
      }
      const prStatus = await compareStatus(
        repo,
        expected,
        headRefOid,
        ghCommandFn,
        log,
      );
      if (prStatus === "identical" || prStatus === "ahead") {
        return { kind: "sync-pr", prNumber, sha: expected };
      }
    }
  } catch (err) {
    log(
      `WARNING: Could not list open sync PRs for '${milestoneBranch}' in ` +
        `${repo} while confirming a milestone sync landing: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #2998)`,
    );
  }

  return {
    kind: "unconfirmed",
    expectedSha: expected,
    observedSha: observed,
    reason:
      "the milestone tip does not contain the merge and no open sync PR holds it",
  };
}
