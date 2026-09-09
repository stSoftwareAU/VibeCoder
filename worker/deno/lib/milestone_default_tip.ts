/**
 * The default branch's local tip, for the milestone-sync cadence
 * (Issue #1776).
 *
 * The sync runs on every cycle in which the default tip moved, so it needs
 * that tip before it decides anything. It is read from local git rather than
 * the API: `ensureDefaultBranchCurrent` already fetches `origin/<default>`
 * (the sync cannot merge down without it), and a `git rev-parse` on top of
 * that fetch costs nothing against either API budget.
 *
 * The tip reported is the one the **merge** will use — the local
 * `<defaultBranch>` ref, which `syncMilestoneBranchWithDefault` merges — and it
 * is reported only when that ref agrees with `origin/<defaultBranch>`. A local
 * ref that could not be moved (another worktree has it checked out, Issue #394)
 * is a loud failure here rather than a tip the branch never merged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { ensureDefaultBranchCurrent } from "./git_push.ts";
import { runGitCommand } from "./git_timeout.ts";

/** A 40-hex commit SHA — what `git rev-parse` answers with. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Resolve one ref to a commit, naming what went wrong when it cannot. */
async function readSha(ref: string, cwd: string): Promise<Result<string>> {
  const parsed = await runGitCommand(["rev-parse", ref], { cwd });
  if (!parsed.ok) {
    return {
      ok: false,
      error: new Error(`git rev-parse ${ref} failed: ${parsed.error.message}`),
    };
  }
  if (parsed.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git rev-parse ${ref} exited ${parsed.value.code}: ${
          parsed.value.stderr.trim() || "no stderr"
        }`,
      ),
    };
  }
  const sha = parsed.value.stdout.trim();
  if (!SHA_PATTERN.test(sha)) {
    return {
      ok: false,
      error: new Error(`git rev-parse ${ref} gave a non-SHA: '${sha}'`),
    };
  }
  return { ok: true, value: sha };
}

/**
 * Read the commit the default branch carries in the clone at `cwd`.
 *
 * Every failure is returned with the reason git gave, never as a quiet
 * `undefined`: the caller logs it and syncs anyway, because an unreadable tip
 * must not park a milestone branch silently.
 *
 * @param defaultBranch - The repository's default branch name
 * @param cwd - The local clone to read
 * @returns The tip both the local ref and origin agree on
 */
export async function readLocalDefaultTip(
  defaultBranch: string,
  cwd: string,
): Promise<Result<string>> {
  // Validates the branch name as a ref component and fetches origin/<branch>,
  // so both rev-parses below read refs that are safe and current.
  const current = await ensureDefaultBranchCurrent(defaultBranch, { cwd });
  if (!current.ok) {
    return {
      ok: false,
      error: new Error(
        `could not make '${defaultBranch}' current in ${cwd}: ${current.error.message}`,
      ),
    };
  }

  const remote = await readSha(`origin/${defaultBranch}`, cwd);
  if (!remote.ok) return remote;
  const local = await readSha(defaultBranch, cwd);
  if (!local.ok) return local;

  // `ensureDefaultBranchCurrent` moves the local ref with an unchecked
  // `git branch -f`, which git refuses when another worktree has the branch
  // checked out (Issue #394) — it still reports success. Recording the remote
  // tip then would claim a merge-down that never happened and park the branch
  // until the next push, so the disagreement is the failure.
  if (local.value !== remote.value) {
    return {
      ok: false,
      error: new Error(
        `local '${defaultBranch}' is at ${local.value.slice(0, 7)} while ` +
          `origin/${defaultBranch} is at ${remote.value.slice(0, 7)} — the ` +
          `local ref could not be moved, so a merge-down cannot carry the ` +
          `remote tip`,
      ),
    };
  }
  return local;
}
