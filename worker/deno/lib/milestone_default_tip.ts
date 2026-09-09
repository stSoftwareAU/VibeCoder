/**
 * The default branch's local tip, for the milestone-sync cadence
 * (Issue #1776).
 *
 * The sync runs on every cycle in which the default tip moved, so it needs
 * that tip before it decides anything. It is read from local git rather than
 * the API: `ensureDefaultBranchCurrent` already fetches `origin/<default>`
 * (the sync cannot merge down without it), and one `git rev-parse` on top of
 * that fetch costs nothing against the API budget.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { ensureDefaultBranchCurrent } from "./git_push.ts";
import { runGitCommand } from "./git_timeout.ts";

/** A 40-hex commit SHA — what `git rev-parse` answers with. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Read `origin/<defaultBranch>`'s commit in the clone at `cwd`.
 *
 * Returns `undefined` when the tip cannot be read — the clone is missing, the
 * fetch failed, or git answered with something that is not a commit. The
 * caller treats an unknown tip as "sync anyway", so a transient git failure
 * costs an extra merge-down rather than parking the branch.
 *
 * @param defaultBranch - The repository's default branch name
 * @param cwd - The local clone to read
 * @returns The tip SHA, or undefined when it could not be read
 */
export async function readLocalDefaultTip(
  defaultBranch: string,
  cwd: string,
): Promise<string | undefined> {
  // Validates the branch name as a ref component and fetches origin/<branch>,
  // so the rev-parse below reads a ref that is both safe and current.
  const current = await ensureDefaultBranchCurrent(defaultBranch, { cwd });
  if (!current.ok) return undefined;

  const parsed = await runGitCommand(
    ["rev-parse", `origin/${defaultBranch}`],
    { cwd },
  );
  if (!parsed.ok || parsed.value.code !== 0) return undefined;

  const sha = parsed.value.stdout.trim();
  return SHA_PATTERN.test(sha) ? sha : undefined;
}
