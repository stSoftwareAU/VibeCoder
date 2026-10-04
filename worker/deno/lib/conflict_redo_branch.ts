/**
 * Fresh-branch redo after an abandoned PR (Issue #3033).
 *
 * `conflict_abandon_restart.ts` closes an exhausted PR and re-queues its
 * originating issue, but its branch (e.g. `issue-12-foo`) is deliberately
 * left on origin — the abandoned work stays readable and linked. The redo
 * must still never resume from that abandoned head: `issue_branch_resume.ts`
 * discovers prior work by issue number alone, so without this module the
 * redo would pick the very branch the ladder gave up on.
 *
 * This module reads the restart marker {@link CONFLICT_RESTART_MARKER} back
 * off the issue's own comment thread to learn which branch names were
 * abandoned, and derives a non-colliding name for the branch the redo cuts
 * from the base tip instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { CONFLICT_RESTART_MARKER } from "./conflict_abandon_restart.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { partitionConflictComments } from "./conflict_marker_trust.ts";

/** A `branch="…"` attribute value this module will trust. */
const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]{1,255}$/;

/**
 * The `branch="…"` attribute inside one restart marker, or `undefined` when
 * the marker carries none or it does not look like a real branch name.
 *
 * Read only from inside the marker's own `<!-- … -->` span, so an unrelated
 * `branch="…"` elsewhere in the comment body (quoted attempt text, say) is
 * never mistaken for the claim.
 */
function markerBranch(body: string, markerIndex: number): string | undefined {
  const end = body.indexOf("-->", markerIndex);
  const markerText = end >= 0
    ? body.slice(markerIndex, end + 3)
    : body.slice(markerIndex);
  const match = /\bbranch="([^"]*)"/.exec(markerText);
  const value = match?.[1];
  if (value === undefined) return undefined;
  if (!SAFE_BRANCH_NAME.test(value)) return undefined;
  if (value.includes("..")) return undefined;
  return value;
}

/**
 * The branches every restart marker in a (trusted) comment thread names, in
 * the order they appear, deduplicated.
 *
 * **Author-blind by construction**, matching {@link restartMarkerPrNumbers}
 * in `conflict_abandon_restart.ts`: the caller attributes the thread first
 * and passes only the trusted comments. A marker whose `branch` attribute is
 * absent or does not match {@link SAFE_BRANCH_NAME} yields no branch at all —
 * it is simply skipped, never read as the empty string.
 */
export function restartMarkerBranches(
  comments: readonly unknown[],
): string[] {
  const found: string[] = [];
  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const body = (raw as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    const index = body.indexOf(CONFLICT_RESTART_MARKER);
    if (index < 0) continue;
    const branch = markerBranch(body, index);
    if (branch !== undefined && !found.includes(branch)) {
      found.push(branch);
    }
  }
  return found;
}

/**
 * The branches a merge-conflict abandon has already given up on for this
 * issue, read back off its comment thread.
 *
 * Fetches the thread with {@link fetchIssueCommentPages} and keeps only the
 * fleet-authored comments ({@link partitionConflictComments}) before parsing
 * — the same author gate the ladder's own restart-count check uses, so an
 * outsider's planted marker cannot name an arbitrary branch and have the redo
 * treat it as taken.
 *
 * A fetch failure is returned as `{ ok: false }` rather than an empty list:
 * "the lookup could not run" and "no branch has been abandoned" are different
 * facts, and only the first is safe to assume when it is actually the second
 * the caller cannot tell.
 */
export async function loadAbandonedBranches(
  repo: string,
  issueNumber: number,
  gh: (args: string[]) => Promise<string>,
  trustedAuthors: readonly string[],
): Promise<Result<string[]>> {
  try {
    const comments = await fetchIssueCommentPages(repo, issueNumber, gh);
    const trusted = partitionConflictComments(comments, trustedAuthors).trusted;
    return { ok: true, value: restartMarkerBranches(trusted) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * A branch name for the redo that is guaranteed not to collide with an
 * abandoned one.
 *
 * `derived` — the title-derived name a fresh branch would normally get — is
 * returned unchanged unless it was itself abandoned (the redo was retitled
 * back onto the same slug, say), in which case `${derived}-redo-${k}` is
 * returned for the smallest `k >= 1` not itself abandoned.
 */
export function freshRedoBranchName(
  derived: string,
  abandoned: readonly string[],
): string {
  if (!abandoned.includes(derived)) return derived;
  let k = 1;
  while (abandoned.includes(`${derived}-redo-${k}`)) {
    k++;
  }
  return `${derived}-redo-${k}`;
}
