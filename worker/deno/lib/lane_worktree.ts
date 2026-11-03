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

  let added = await runGitCommand(
    ["worktree", "add", "--detach", "--force", path, "HEAD"],
    { cwd: repoPath },
  );

  // Issue #1561: `git worktree add` refuses a path that already exists as a
  // directory, and `--force` does not override that — it overrides an
  // already-checked-out branch and an already-registered path, not a stray
  // directory. `worktree prune` above does not help either: it drops
  // administration for worktrees whose directory has *gone*, and this
  // directory has not gone.
  //
  // Two things leave one: a container killed mid-run, and a shared clone
  // recreated underneath its linked worktrees (the `.git` file then points at
  // administration that no longer exists, so `isLinkedWorktree` says no and
  // we arrive here). Either way the lane was wedged permanently — every cycle
  // died in phase `setup` inside a minute and released the claim with no PR,
  // and the next cycle failed identically. Nothing about that self-heals with
  // time, so clear the orphan and try once more.
  if (isPathAlreadyExists(added)) {
    try {
      await Deno.remove(path, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        error: new Error(
          `Could not create a ${laneId} worktree for ${repo} at ${path}: the ` +
            `path already exists and is not a worktree of ${repoPath}, and ` +
            `it could not be cleared: ${
              err instanceof Error ? err.message : String(err)
            }`,
        ),
      };
    }
    await runGitCommand(["worktree", "prune"], { cwd: repoPath });
    added = await runGitCommand(
      ["worktree", "add", "--detach", "--force", path, "HEAD"],
      { cwd: repoPath },
    );
  }

  // Issue #3630: `HEAD` resolves through the clone's symref. Milestone sync
  // checks the milestone branch out of the main clone and leaves it there;
  // when that branch later goes — cleanup, a recreated clone, a sibling's
  // sync — HEAD dangles, and every worktree add fails with
  // `fatal: invalid reference: HEAD`. Nothing rewrites the symref on its
  // own, so the lane wedged permanently: every cycle died in phase `setup`
  // inside a minute (the stSoftwareAU/GRQ-AutoTrader#3184 tally). Heal the
  // clone to its default branch and retry once; any other failure keeps
  // today's behaviour, and a failed heal names both faults.
  if (isInvalidHeadReference(added)) {
    const healed = await healDanglingHead(repoPath);
    if (!healed.ok) {
      return {
        ok: false,
        error: new Error(
          `Could not create a ${laneId} worktree for ${repo} at ${path}: ` +
            `the clone's HEAD is invalid and the heal failed: ` +
            `${healed.error.message}`,
        ),
      };
    }
    added = await runGitCommand(
      ["worktree", "add", "--detach", "--force", path, "HEAD"],
      { cwd: repoPath },
    );
  }

  if (!added.ok || added.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Could not create a ${laneId} worktree for ${repo} at ${path}: ${
          worktreeAddFailureDetail(added)
        }`,
      ),
    };
  }

  return { ok: true, value: path };
}

/** Outcome of the `git worktree add` run, as {@link runGitCommand} reports it. */
type WorktreeAddOutcome = Awaited<ReturnType<typeof runGitCommand>>;

/**
 * True when `git worktree add` refused because the target path is already
 * there — the one failure this module can clear and retry (Issue #1561).
 *
 * Matched on git's own wording rather than the exit code, which is a generic
 * 128 for every fatal. A wording change upstream costs the retry, not
 * correctness: the call still fails loudly with the detail below.
 */
function isPathAlreadyExists(added: WorktreeAddOutcome): boolean {
  if (!added.ok || added.value.code === 0) return false;
  return /fatal:.*already exists/i.test(added.value.stderr);
}

/**
 * The reportable cause of a failed `git worktree add` (Issue #1561).
 *
 * `git worktree add` writes `Preparing worktree (detached HEAD abc1234)` to
 * **stderr** before it does any work, so a plain `stderr.trim()` leads with a
 * line that says nothing and buries the `fatal:` that follows. On Issue #1561
 * the useful half was then truncated out of the issue comment altogether, and
 * the report a human had to act on read `Preparing worktree (detached HEA…`.
 *
 * The preamble is dropped so the actual cause leads. Every other line is
 * kept — including any git writes that this module does not recognise.
 */
export function worktreeAddFailureDetail(added: WorktreeAddOutcome): string {
  if (!added.ok) return added.error.message;
  const meaningful = added.value.stderr
    .split("\n")
    .filter((line) => !/^\s*Preparing worktree\b/.test(line))
    .join("\n")
    .trim();
  return meaningful || `exit ${added.value.code}`;
}

/**
 * True when `git worktree add` refused because the clone's `HEAD` symref
 * points at a branch that no longer exists (Issue #3630).
 *
 * Matched on git's own wording — `fatal: invalid reference: HEAD`, or the
 * `HEAD points to an invalid (or orphaned) reference` warning newer git
 * versions print for the same condition — the same way
 * {@link isPathAlreadyExists} matches the orphan-path refusal.
 */
export function isInvalidHeadReference(outcome: WorktreeAddOutcome): boolean {
  const detail = worktreeAddFailureDetail(outcome);
  return detail.includes("invalid reference: HEAD") ||
    detail.includes("HEAD points to an invalid");
}

/**
 * Rewrite the clone's dangling `HEAD` symref to its default branch
 * (Issue #3630).
 *
 * The default branch is resolved from the clone itself —
 * `git symbolic-ref refs/remotes/origin/HEAD`, the same local resolution
 * `setupRepo()` relies on (`resolveLocalDefaultBranch` in `git_push.ts`;
 * inlined here because `git_push` imports this module's root constant and an
 * import would cycle) — so no network call is made. When the local default
 * branch exists the symref is rewritten in place; otherwise the branch is
 * recreated from the remote-tracking ref first. Fails loud rather than
 * guessing when `origin/HEAD` is unset.
 */
export async function healDanglingHead(
  repoPath: string,
): Promise<Result<void>> {
  const originHead = await runGitCommand(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd: repoPath },
  );
  if (!originHead.ok || originHead.value.code !== 0) {
    const detail = originHead.ok
      ? originHead.value.stderr.trim() || `exit ${originHead.value.code}`
      : originHead.error.message;
    return {
      ok: false,
      error: new Error(`origin/HEAD is unset (${detail})`),
    };
  }
  const target = originHead.value.stdout.trim();
  const branch = target.replace(/^refs\/remotes\/origin\//, "");
  if (branch === target || branch === "") {
    return {
      ok: false,
      error: new Error(`origin/HEAD resolved to "${target}", not a branch`),
    };
  }

  const local = await runGitCommand(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoPath },
  );
  if (local.ok && local.value.code === 0) {
    const rewrote = await runGitCommand(
      ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
      { cwd: repoPath },
    );
    if (!rewrote.ok || rewrote.value.code !== 0) {
      const detail = rewrote.ok
        ? rewrote.value.stderr.trim() || `exit ${rewrote.value.code}`
        : rewrote.error.message;
      return {
        ok: false,
        error: new Error(`could not rewrite HEAD to ${branch} (${detail})`),
      };
    }
    return { ok: true, value: undefined };
  }

  const recreated = await runGitCommand(
    ["checkout", "-B", branch, `origin/${branch}`],
    { cwd: repoPath },
  );
  if (!recreated.ok || recreated.value.code !== 0) {
    const detail = recreated.ok
      ? recreated.value.stderr.trim() || `exit ${recreated.value.code}`
      : recreated.error.message;
    return {
      ok: false,
      error: new Error(`could not recreate ${branch} (${detail})`),
    };
  }
  return { ok: true, value: undefined };
}

/**
 * Detach the lane worktree's `HEAD` so it holds no branch (Issue #394).
 *
 * Branches are shared between worktrees: a lane that leaves one checked out
 * blocks every other lane from moving it, which is the contention this
 * module exists to avoid. Called after each PR the lane touches, and after
 * each issue run ends (Issue #1677) — a finished issue lane used to stay on
 * its PR branch until the lane was next reused, which blocked the CI-fix pass
 * for that very PR.
 *
 * `run` is the git runner to detach with; production passes nothing and gets
 * the timeout chokepoint, tests pass their recording mock.
 *
 * Best-effort by design — a worktree that cannot be detached is not a
 * failure of the update that just ran; the next `ensureLaneWorktree` reuses
 * or recreates it.
 *
 * @param path - The lane worktree's path
 * @returns True when `HEAD` is detached afterwards
 */
export async function detachLaneWorktreeHead(
  path: string,
  run: typeof runGitCommand = runGitCommand,
): Promise<boolean> {
  const detached = await run(["checkout", "--detach"], { cwd: path });
  return detached.ok && detached.value.code === 0;
}

/**
 * The lane worktree holding a branch, when git refused a checkout for that
 * reason (Issue #1564, Issue #1677).
 *
 * Branches are shared between the worktrees of one clone, so `git checkout`
 * of a branch another worktree has out fails with
 * `fatal: '<branch>' is already used by worktree at '<path>'`. Returns that
 * path only when it is one of **this host's own lane worktrees** —
 * `<work root>/worktrees/<lane>/<repo>`, the shape {@link laneWorktreePath}
 * builds. A branch held by anything else (a developer's own worktree, a path
 * git names that this module does not recognise) is reported rather than
 * wrenched away: the repair is for the fleet's own contention, not for
 * whatever else happens to share the clone. The shared clone's own primary
 * worktree is the one other holder the issue path also releases, via
 * {@link primaryCloneHoldingBranch} (Issue #4789); the PR passes do not.
 *
 * Shared by the issue path (`createFeatureBranchFromBase`) and the PR
 * passes (`preparePrBranch`, `checkoutPrBranchAtRemoteHead`): before #1677
 * only the issue path recognised the refusal, so a finished issue lane parked
 * on its PR branch blocked the CI-fix pass for that PR on every cycle.
 *
 * @param stderr - git's stderr from the refused checkout
 * @returns The lane worktree's path, or `undefined` when the refusal is not
 *   a held branch or the holder is not one of this host's lane worktrees
 */
export function laneWorktreeHoldingBranch(stderr: string): string | undefined {
  const path = heldWorktreePath(stderr);
  if (path === undefined) return undefined;

  // `<...>/<LANE_WORKTREE_ROOT>/<lane>/<repo>`: the lane root must be the
  // third segment from the end, so a merely similar path does not qualify.
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length < 3) return undefined;
  return segments[segments.length - 3] === LANE_WORKTREE_ROOT
    ? path
    : undefined;
}

/**
 * The worktree path git names in a "branch already used by a worktree"
 * refusal, or `undefined` when the stderr is not that refusal (Issue #1564).
 *
 * @param stderr - git's stderr from the refused checkout
 * @returns The quoted path git reports as holding the branch
 */
function heldWorktreePath(stderr: string): string | undefined {
  return stderr.match(/is already used by worktree at '([^']+)'/)?.[1];
}

/**
 * The shared clone's own primary worktree, when it is the holder of a branch
 * git refused to check out (Issue #4789).
 *
 * {@link laneWorktreeHoldingBranch} only recognises lane worktrees, so a
 * branch left checked out in the clone's primary worktree
 * (`<work root>/<repo>`) was never released: the refusal was not recognised
 * and the issue died in phase `setup` on every re-claim. The primary clone is
 * the worker's own shared clone, not a developer's checkout, and the claim
 * guarantees no other run owns this issue's branch, so releasing its hold is
 * the same host-internal contention repair. `checkout --detach` keeps the
 * working tree, only the branch pointer is released.
 *
 * Anything else git names — a lane worktree (handled by
 * {@link laneWorktreeHoldingBranch}), or a developer's own linked worktree —
 * is not this clone's primary and returns `undefined`, so it is reported
 * rather than touched.
 *
 * @param stderr - git's stderr from the refused checkout
 * @param cwd - A directory inside the shared clone, used to list its worktrees
 * @param run - The git runner; production passes nothing, tests pass a mock
 * @returns The primary worktree's path as git reported it, or `undefined`
 */
export async function primaryCloneHoldingBranch(
  stderr: string,
  cwd: string | undefined,
  run: typeof runGitCommand = runGitCommand,
): Promise<string | undefined> {
  const held = heldWorktreePath(stderr);
  if (held === undefined) return undefined;

  // `git worktree list` names the main worktree first, so the first
  // `worktree <path>` line is this clone's primary.
  const listing = await run(["worktree", "list", "--porcelain"], { cwd });
  if (!listing.ok || listing.value.code !== 0) return undefined;
  const line = listing.value.stdout.split("\n").find((entry) =>
    entry.startsWith("worktree ")
  );
  if (line === undefined) return undefined;
  const primary = line.slice("worktree ".length);

  const matches = await realPathOrSelf(held) === await realPathOrSelf(primary);
  return matches ? held : undefined;
}
