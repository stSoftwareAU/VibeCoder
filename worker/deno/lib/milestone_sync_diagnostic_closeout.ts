/**
 * Close a milestone branch's sync diagnostics once the branch syncs
 * (Issue #1769).
 *
 * Before this issue a stalled or conflicting sync filed a `needs-human` issue
 * per branch and per conflicting commit. Those issues are in the wild
 * (#1754, #1756, #1764, NEAT-AI-scorer#612/#613, GRQ-AutoTrader#120) and
 * nothing ever closed them: the branch could sync cleanly the next hour and
 * the diagnostic would still be sitting there asking a human for help.
 *
 * The escalation path no longer files them, so the two titles survive only as
 * the search keys used here — a successful sync is what proves the reported
 * condition is over, so it is also what closes the issue that reported it.
 *
 * The lookup is author-verified through `findFleetAuthoredIssuesTitled`: a
 * same-titled issue opened by anyone else is somebody's own work and is left
 * exactly as it is. Closing on a title alone would let a stranger's issue be
 * closed by a branch sync it has nothing to do with.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import { findFleetAuthoredIssuesTitled } from "./idle_task_wrapper_dedup.ts";
import {
  conflictDiagnosticTitlePrefix,
  describeBranchTips,
  resolveBranchTips,
} from "./milestone_sync_conflict.ts";

/** Injectable `gh` command runner. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/**
 * Title of the diagnostic the old escalation path filed for a stalled sync
 * (Issue #1465). Kept as the search key that closes those issues, and as the
 * one place that spells the title both halves must agree on.
 */
export function stuckSyncDiagnosticTitle(milestoneBranch: string): string {
  return `Milestone branch sync is stuck: ${milestoneBranch}`;
}

/** Everything {@link closeResolvedSyncDiagnostics} needs. */
export interface CloseSyncDiagnosticsOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The branch that has just synced. */
  milestoneBranch: string;
  /** Injected `gh` runner. */
  ghCommandFn: GhCommandFn;
  /** Sink for the close and failure lines. */
  log: (message: string) => void;
  /** Fleet-identity inputs for the author check (tests state the fleet). */
  dedupAuthors?: AlertDedupAuthorOptions;
}

/**
 * Close every open fleet-authored sync diagnostic for a branch that has just
 * synced, commenting with the commit the branch now stands at.
 *
 * Best-effort throughout: a search or a close that fails is logged loudly and
 * the sync itself is unaffected — the diagnostic is simply closed next cycle.
 *
 * @param options - Repo, branch, `gh` runner, log sink and fleet identity.
 * @returns The issue numbers actually closed.
 */
export async function closeResolvedSyncDiagnostics(
  options: CloseSyncDiagnosticsOptions,
): Promise<number[]> {
  const { repo, milestoneBranch, ghCommandFn, log } = options;

  const stuckTitle = stuckSyncDiagnosticTitle(milestoneBranch);
  const conflictPrefix = conflictDiagnosticTitlePrefix(milestoneBranch);

  const matches = [
    ...await findDiagnostics(options, {
      title: stuckTitle,
      searchExpression: `"${stuckTitle}" in:title`,
    }),
    // The conflict diagnostic's title carries the conflicting commit, so the
    // exact title is not knowable from the branch alone — the branch-and-`@`
    // prefix is, and it cannot collide with another branch's diagnostic.
    ...await findDiagnostics(options, {
      title: conflictPrefix,
      searchExpression: `"${conflictPrefix.trimEnd()}" in:title`,
      titleMatches: (title: string) => title.startsWith(conflictPrefix),
    }),
  ];
  if (matches.length === 0) return [];

  const tips = await resolveBranchTips(
    repo,
    [{ branch: milestoneBranch }],
    ghCommandFn,
    log,
  );
  const comment =
    `## The milestone branch has synced — closing this report\n\n` +
    `\`${milestoneBranch}\` synced with its default branch, so the condition ` +
    `this issue reported is over and it is closed automatically ` +
    `(Issue #1769).\n\n${describeBranchTips(tips)}`;

  const closed: number[] = [];
  for (const number of new Set(matches)) {
    try {
      await ghCommandFn([
        "issue",
        "close",
        String(number),
        "--repo",
        repo,
        "--comment",
        comment,
      ]);
      log(
        `Closed sync diagnostic #${number} in ${repo}: ` +
          `'${milestoneBranch}' has synced (Issue #1769).`,
      );
      closed.push(number);
    } catch (err) {
      log(
        `Could not close sync diagnostic #${number} in ${repo} after ` +
          `'${milestoneBranch}' synced: ${
            err instanceof Error ? err.message : String(err)
          } (Issue #1769).`,
      );
    }
  }
  return closed;
}

/** One author-verified title search, degraded to no matches when it fails. */
async function findDiagnostics(
  options: CloseSyncDiagnosticsOptions,
  query: {
    title: string;
    searchExpression: string;
    titleMatches?: (title: string) => boolean;
  },
): Promise<number[]> {
  try {
    const rows = await findFleetAuthoredIssuesTitled({
      repo: options.repo,
      title: query.title,
      context: `sync diagnostics for ${options.milestoneBranch}`,
      ghCommand: options.ghCommandFn,
      searchExpression: query.searchExpression,
      limit: 30,
      log: options.log,
      ...(query.titleMatches ? { titleMatches: query.titleMatches } : {}),
      ...(options.dedupAuthors ?? {}),
    });
    return rows.map((row) => row.number);
  } catch (err) {
    options.log(
      `Could not search for sync diagnostics titled '${query.title}' in ` +
        `${options.repo}: ${
          err instanceof Error ? err.message : String(err)
        } — they stay open for now (Issue #1769).`,
    );
    return [];
  }
}
