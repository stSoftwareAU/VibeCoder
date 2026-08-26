/**
 * Per-lane git worktrees off the shared clone (Issue #394).
 *
 * Every lane on a host — the issue slots, the `m1` maintenance lane, the
 * PR-branch-update pass — used to work in the one clone `${WORK_DIR}/<repo>`.
 * They therefore shared `HEAD`, the index and the working tree, and
 * `setupRepo` opens with `reset --hard` + `clean -fd` + `checkout <default>`.
 * Live, that meant a branch that existed on origin was reported as
 * `pathspec … did not match any file(s) known to git` moments after its ref
 * had resolved: another lane had moved the clone underneath the operation.
 *
 * A linked worktree is the cheap fix the issue asks for. It shares the object
 * store — no re-clone, no extra objects — while giving the lane its own
 * `HEAD`, index and checkout. Refs stay shared, which is what makes the
 * remaining collisions *loud*: git refuses to move a branch another worktree
 * has checked out rather than pulling the rug from under it. Those refusals
 * are contention, not PR faults — see `clone_contention.ts`.
 *
 * The worktree is created detached, so the lane never claims a branch it does
 * not need, and it is reused across cycles: creation costs one `worktree add`
 * on first use per repo.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import { ensureAllBranchesFetchRefspec } from "./git_fetch_refspec.ts";

/**
 * Work-root directory the lane worktrees live under.
 *
 * Reserved in `stale_workdir.ts` so the housekeeping sweeps that walk
 * `${WORK_DIR}` for disposable clones leave it alone.
 */
export const LANE_WORKTREE_ROOT = "worktrees";

/** Lane id used by the Priority-1.6 PR-branch-update pass. */
export const PR_BRANCH_UPDATE_LANE_ID = "pr-branch-update";

/** Request for {@link ensureLaneWorktree}. */
export interface LaneWorktreeRequest {
  /** Directory the worker clones repositories into (`WORK_DIR`). */
  workDir: string;
  /** Repository in `owner/name` form. */
  repo: string;
  /** Stable id of the lane asking, e.g. {@link PR_BRANCH_UPDATE_LANE_ID}. */
  laneId: string;
  /** Path of the shared clone the worktree is linked to. */
  repoPath: string;
}

/** Reject a path segment that would escape the work root. */
function isUnsafeSegment(segment: string): boolean {
  return segment === "" || segment === "." || segment === ".." ||
    segment.includes("/") || segment.includes("\\");
}

/**
 * Where a lane's worktree for `repo` lives.
 *
 * @param workDir - The work root
 * @param repo - Repository in `owner/name` form
 * @param laneId - The lane's stable id
 * @returns Absolute path of the lane's worktree
 * @throws When either derived path segment would escape the work root
 */
export function laneWorktreePath(
  workDir: string,
  repo: string,
  laneId: string,
): string {
  const repoName = repo.split("/").pop() ?? repo;
  if (isUnsafeSegment(repoName)) {
    throw new Error(
      `Refusing a lane worktree for unsafe repo segment "${repoName}" ` +
        `derived from slug "${repo}"`,
    );
  }
  if (isUnsafeSegment(laneId)) {
    throw new Error(`Refusing a lane worktree for unsafe lane id "${laneId}"`);
  }
  return `${workDir}/${LANE_WORKTREE_ROOT}/${laneId}/${repoName}`;
}

/** Is `path` a usable worktree linked to `repoPath`'s object store? */
async function isLinkedWorktree(
  path: string,
  repoPath: string,
): Promise<boolean> {
  const inside = await runGitCommand(
    ["rev-parse", "--is-inside-work-tree"],
    { cwd: path },
  );
  if (!inside.ok || inside.value.code !== 0) return false;
  if (inside.value.stdout.trim() !== "true") return false;

  // A worktree whose common dir is some *other* clone would silently update
  // the wrong repository, so the link is verified rather than assumed.
  const commonDir = await runGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: path },
  );
  if (!commonDir.ok || commonDir.value.code !== 0) return false;
  const expected = await realPathOrSelf(`${repoPath}/.git`);
  const actual = await realPathOrSelf(commonDir.value.stdout.trim());
  return actual === expected;
}

/** Resolve symlinks where possible; fall back to the path as given. */
async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path.replace(/\/+$/, "");
  }
}

/**
 * Make sure this lane has its own worktree of `repo`, and return its path.
 *
 * An existing healthy worktree is reused untouched. Otherwise the clone's
 * stale worktree administration is pruned and a fresh **detached** worktree
 * is added at the clone's current `HEAD`.
 *
 * Fails loud: a worktree that could not be created comes back as
 * `{ ok: false }` carrying git's own stderr, never a silent fallback to the
 * shared clone — working in the shared clone is the fault this exists to
 * prevent.
 *
 * @param request - Work root, repo, lane id and the shared clone's path
 * @returns The worktree path, or the reason it could not be provided
 */
export async function ensureLaneWorktree(
  request: LaneWorktreeRequest,
): Promise<Result<string>> {
  const { workDir, repo, laneId, repoPath } = request;

  let path: string;
  try {
    path = laneWorktreePath(workDir, repo, laneId);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // A worktree inherits the clone's remote configuration, and a legacy
  // single-branch clone (`--depth=1` without a refspec) can see no feature
  // branch at all: `origin/<branch>` never materialises, which makes a good
  // push look failed and a mergeable PR look conflicted (Issue #211). The
  // destructive `setupRepo` repaired that on every pass; the lane no longer
  // runs it, so the repair — one idempotent config line — happens here.
  const refspec = await ensureAllBranchesFetchRefspec({ cwd: repoPath });
  if (!refspec.ok) {
    return {
      ok: false,
      error: new Error(
        `Could not repair the fetch refspec of ${repo} before taking a ` +
          `${laneId} worktree: ${refspec.error.message}`,
      ),
    };
  }

  if (await isLinkedWorktree(path, repoPath)) {
    return { ok: true, value: path };
  }

  // Drop administration for worktrees whose directory has gone, so a
  // recreated path is not refused as "already registered".
  await runGitCommand(["worktree", "prune"], { cwd: repoPath });

  try {
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Could not create the lane worktree root for ${repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }

  const added = await runGitCommand(
    ["worktree", "add", "--detach", "--force", path, "HEAD"],
    { cwd: repoPath },
  );
  if (!added.ok || added.value.code !== 0) {
    const detail = added.ok
      ? (added.value.stderr.trim() || `exit ${added.value.code}`)
      : added.error.message;
    return {
      ok: false,
      error: new Error(
        `Could not create a ${laneId} worktree for ${repo} at ${path}: ${detail}`,
      ),
    };
  }

  return { ok: true, value: path };
}

/**
 * Detach the lane worktree's `HEAD` so it holds no branch (Issue #394).
 *
 * Branches are shared between worktrees: a lane that leaves one checked out
 * blocks every other lane from moving it, which is the contention this
 * module exists to avoid. Called after each PR the lane touches.
 *
 * Best-effort by design — a worktree that cannot be detached is not a
 * failure of the update that just ran; the next `ensureLaneWorktree` reuses
 * or recreates it.
 *
 * @param path - The lane worktree's path
 * @returns True when `HEAD` is detached afterwards
 */
export async function detachLaneWorktreeHead(path: string): Promise<boolean> {
  const detached = await runGitCommand(["checkout", "--detach"], { cwd: path });
  return detached.ok && detached.value.code === 0;
}
