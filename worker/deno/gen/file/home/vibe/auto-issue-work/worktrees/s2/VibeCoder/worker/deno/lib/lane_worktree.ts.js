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
 */ import { runGitCommand } from "./git_timeout.ts";
import { ensureAllBranchesFetchRefspec } from "./git_fetch_refspec.ts";
/**
 * Work-root directory the lane worktrees live under.
 *
 * Reserved in `stale_workdir.ts` so the housekeeping sweeps that walk
 * `${WORK_DIR}` for disposable clones leave it alone.
 */ export const LANE_WORKTREE_ROOT = "worktrees";
/** Lane id used by the Priority-1.6 PR-branch-update pass. */ export const PR_BRANCH_UPDATE_LANE_ID = "pr-branch-update";
/** Reject a path segment that would escape the work root. */ function isUnsafeSegment(segment) {
  return segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\");
}
/**
 * Where a lane's worktree for `repo` lives.
 *
 * @param workDir - The work root
 * @param repo - Repository in `owner/name` form
 * @param laneId - The lane's stable id
 * @returns Absolute path of the lane's worktree
 * @throws When either derived path segment would escape the work root
 */ export function laneWorktreePath(workDir, repo, laneId) {
  const repoName = repo.split("/").pop() ?? repo;
  if (isUnsafeSegment(repoName)) {
    throw new Error(`Refusing a lane worktree for unsafe repo segment "${repoName}" ` + `derived from slug "${repo}"`);
  }
  if (isUnsafeSegment(laneId)) {
    throw new Error(`Refusing a lane worktree for unsafe lane id "${laneId}"`);
  }
  return `${workDir}/${LANE_WORKTREE_ROOT}/${laneId}/${repoName}`;
}
/** Is `path` a usable worktree linked to `repoPath`'s object store? */ async function isLinkedWorktree(path, repoPath) {
  const inside = await runGitCommand([
    "rev-parse",
    "--is-inside-work-tree"
  ], {
    cwd: path
  });
  if (!inside.ok || inside.value.code !== 0) return false;
  if (inside.value.stdout.trim() !== "true") return false;
  // A worktree whose common dir is some *other* clone would silently update
  // the wrong repository, so the link is verified rather than assumed.
  const commonDir = await runGitCommand([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ], {
    cwd: path
  });
  if (!commonDir.ok || commonDir.value.code !== 0) return false;
  const expected = await realPathOrSelf(`${repoPath}/.git`);
  const actual = await realPathOrSelf(commonDir.value.stdout.trim());
  return actual === expected;
}
/** Resolve symlinks where possible; fall back to the path as given. */ async function realPathOrSelf(path) {
  try {
    return await Deno.realPath(path);
  } catch  {
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
 */ export async function ensureLaneWorktree(request) {
  const { workDir, repo, laneId, repoPath } = request;
  let path;
  try {
    path = laneWorktreePath(workDir, repo, laneId);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
  // A worktree inherits the clone's remote configuration, and a legacy
  // single-branch clone (`--depth=1` without a refspec) can see no feature
  // branch at all: `origin/<branch>` never materialises, which makes a good
  // push look failed and a mergeable PR look conflicted (Issue #211). The
  // destructive `setupRepo` repaired that on every pass; the lane no longer
  // runs it, so the repair — one idempotent config line — happens here.
  const refspec = await ensureAllBranchesFetchRefspec({
    cwd: repoPath
  });
  if (!refspec.ok) {
    return {
      ok: false,
      error: new Error(`Could not repair the fetch refspec of ${repo} before taking a ` + `${laneId} worktree: ${refspec.error.message}`)
    };
  }
  if (await isLinkedWorktree(path, repoPath)) {
    return {
      ok: true,
      value: path
    };
  }
  // Drop administration for worktrees whose directory has gone, so a
  // recreated path is not refused as "already registered".
  await runGitCommand([
    "worktree",
    "prune"
  ], {
    cwd: repoPath
  });
  try {
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
      recursive: true
    });
  } catch (err) {
    return {
      ok: false,
      error: new Error(`Could not create the lane worktree root for ${repo}: ${err instanceof Error ? err.message : String(err)}`)
    };
  }
  let added = await runGitCommand([
    "worktree",
    "add",
    "--detach",
    "--force",
    path,
    "HEAD"
  ], {
    cwd: repoPath
  });
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
      await Deno.remove(path, {
        recursive: true
      });
    } catch (err) {
      return {
        ok: false,
        error: new Error(`Could not create a ${laneId} worktree for ${repo} at ${path}: the ` + `path already exists and is not a worktree of ${repoPath}, and ` + `it could not be cleared: ${err instanceof Error ? err.message : String(err)}`)
      };
    }
    await runGitCommand([
      "worktree",
      "prune"
    ], {
      cwd: repoPath
    });
    added = await runGitCommand([
      "worktree",
      "add",
      "--detach",
      "--force",
      path,
      "HEAD"
    ], {
      cwd: repoPath
    });
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
        error: new Error(`Could not create a ${laneId} worktree for ${repo} at ${path}: ` + `the clone's HEAD is invalid and the heal failed: ` + `${healed.error.message}`)
      };
    }
    added = await runGitCommand([
      "worktree",
      "add",
      "--detach",
      "--force",
      path,
      "HEAD"
    ], {
      cwd: repoPath
    });
  }
  if (!added.ok || added.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Could not create a ${laneId} worktree for ${repo} at ${path}: ${worktreeAddFailureDetail(added)}`)
    };
  }
  return {
    ok: true,
    value: path
  };
}
/**
 * True when `git worktree add` refused because the target path is already
 * there — the one failure this module can clear and retry (Issue #1561).
 *
 * Matched on git's own wording rather than the exit code, which is a generic
 * 128 for every fatal. A wording change upstream costs the retry, not
 * correctness: the call still fails loudly with the detail below.
 */ function isPathAlreadyExists(added) {
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
 */ export function worktreeAddFailureDetail(added) {
  if (!added.ok) return added.error.message;
  const meaningful = added.value.stderr.split("\n").filter((line)=>!/^\s*Preparing worktree\b/.test(line)).join("\n").trim();
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
 */ export function isInvalidHeadReference(outcome) {
  const detail = worktreeAddFailureDetail(outcome);
  return detail.includes("invalid reference: HEAD") || detail.includes("HEAD points to an invalid");
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
 */ export async function healDanglingHead(repoPath) {
  const originHead = await runGitCommand([
    "symbolic-ref",
    "refs/remotes/origin/HEAD"
  ], {
    cwd: repoPath
  });
  if (!originHead.ok || originHead.value.code !== 0) {
    const detail = originHead.ok ? originHead.value.stderr.trim() || `exit ${originHead.value.code}` : originHead.error.message;
    return {
      ok: false,
      error: new Error(`origin/HEAD is unset (${detail})`)
    };
  }
  const target = originHead.value.stdout.trim();
  const branch = target.replace(/^refs\/remotes\/origin\//, "");
  if (branch === target || branch === "") {
    return {
      ok: false,
      error: new Error(`origin/HEAD resolved to "${target}", not a branch`)
    };
  }
  const local = await runGitCommand([
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`
  ], {
    cwd: repoPath
  });
  if (local.ok && local.value.code === 0) {
    const rewrote = await runGitCommand([
      "symbolic-ref",
      "HEAD",
      `refs/heads/${branch}`
    ], {
      cwd: repoPath
    });
    if (!rewrote.ok || rewrote.value.code !== 0) {
      const detail = rewrote.ok ? rewrote.value.stderr.trim() || `exit ${rewrote.value.code}` : rewrote.error.message;
      return {
        ok: false,
        error: new Error(`could not rewrite HEAD to ${branch} (${detail})`)
      };
    }
    return {
      ok: true,
      value: undefined
    };
  }
  const recreated = await runGitCommand([
    "checkout",
    "-B",
    branch,
    `origin/${branch}`
  ], {
    cwd: repoPath
  });
  if (!recreated.ok || recreated.value.code !== 0) {
    const detail = recreated.ok ? recreated.value.stderr.trim() || `exit ${recreated.value.code}` : recreated.error.message;
    return {
      ok: false,
      error: new Error(`could not recreate ${branch} (${detail})`)
    };
  }
  return {
    ok: true,
    value: undefined
  };
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
 */ export async function detachLaneWorktreeHead(path, run = runGitCommand) {
  const detached = await run([
    "checkout",
    "--detach"
  ], {
    cwd: path
  });
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
 * worktree is the other holder the issue path (create and resume) also
 * releases, via {@link primaryCloneHoldingBranch} (Issue #4789); the PR passes
 * do not.
 *
 * Shared by the issue path (`createFeatureBranchFromBase`,
 * `resumeFeatureBranchFromRemote`) and the PR
 * passes (`preparePrBranch`, `checkoutPrBranchAtRemoteHead`): before #1677
 * only the issue path recognised the refusal, so a finished issue lane parked
 * on its PR branch blocked the CI-fix pass for that PR on every cycle.
 *
 * @param stderr - git's stderr from the refused checkout
 * @returns The lane worktree's path, or `undefined` when the refusal is not
 *   a held branch or the holder is not one of this host's lane worktrees
 */ export function laneWorktreeHoldingBranch(stderr) {
  const path = heldWorktreePath(stderr);
  if (path === undefined) return undefined;
  // `<...>/<LANE_WORKTREE_ROOT>/<lane>/<repo>`: the lane root must be the
  // third segment from the end, so a merely similar path does not qualify.
  const segments = path.split("/").filter((segment)=>segment !== "");
  if (segments.length < 3) return undefined;
  return segments[segments.length - 3] === LANE_WORKTREE_ROOT ? path : undefined;
}
/**
 * The worktree path git names in a "branch already used by a worktree"
 * refusal, or `undefined` when the stderr is not that refusal (Issue #1564).
 *
 * @param stderr - git's stderr from the refused checkout
 * @returns The quoted path git reports as holding the branch
 */ function heldWorktreePath(stderr) {
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
 */ export async function primaryCloneHoldingBranch(stderr, cwd, run = runGitCommand) {
  const held = heldWorktreePath(stderr);
  if (held === undefined) return undefined;
  // `git worktree list` names the main worktree first, so the first
  // `worktree <path>` line is this clone's primary.
  const listing = await run([
    "worktree",
    "list",
    "--porcelain"
  ], {
    cwd
  });
  if (!listing.ok || listing.value.code !== 0) return undefined;
  const line = listing.value.stdout.split("\n").find((entry)=>entry.startsWith("worktree "));
  if (line === undefined) return undefined;
  const primary = line.slice("worktree ".length);
  const matches = await realPathOrSelf(held) === await realPathOrSelf(primary);
  return matches ? held : undefined;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9sYW5lX3dvcmt0cmVlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUGVyLWxhbmUgZ2l0IHdvcmt0cmVlcyBvZmYgdGhlIHNoYXJlZCBjbG9uZSAoSXNzdWUgIzM5NCkuXG4gKlxuICogRXZlcnkgbGFuZSBvbiBhIGhvc3Qg4oCUIHRoZSBpc3N1ZSBzbG90cywgdGhlIGBtMWAgbWFpbnRlbmFuY2UgbGFuZSwgdGhlXG4gKiBQUi1icmFuY2gtdXBkYXRlIHBhc3Mg4oCUIHVzZWQgdG8gd29yayBpbiB0aGUgb25lIGNsb25lIGAke1dPUktfRElSfS88cmVwbz5gLlxuICogVGhleSB0aGVyZWZvcmUgc2hhcmVkIGBIRUFEYCwgdGhlIGluZGV4IGFuZCB0aGUgd29ya2luZyB0cmVlLCBhbmRcbiAqIGBzZXR1cFJlcG9gIG9wZW5zIHdpdGggYHJlc2V0IC0taGFyZGAgKyBgY2xlYW4gLWZkYCArIGBjaGVja291dCA8ZGVmYXVsdD5gLlxuICogTGl2ZSwgdGhhdCBtZWFudCBhIGJyYW5jaCB0aGF0IGV4aXN0ZWQgb24gb3JpZ2luIHdhcyByZXBvcnRlZCBhc1xuICogYHBhdGhzcGVjIOKApiBkaWQgbm90IG1hdGNoIGFueSBmaWxlKHMpIGtub3duIHRvIGdpdGAgbW9tZW50cyBhZnRlciBpdHMgcmVmXG4gKiBoYWQgcmVzb2x2ZWQ6IGFub3RoZXIgbGFuZSBoYWQgbW92ZWQgdGhlIGNsb25lIHVuZGVybmVhdGggdGhlIG9wZXJhdGlvbi5cbiAqXG4gKiBBIGxpbmtlZCB3b3JrdHJlZSBpcyB0aGUgY2hlYXAgZml4IHRoZSBpc3N1ZSBhc2tzIGZvci4gSXQgc2hhcmVzIHRoZSBvYmplY3RcbiAqIHN0b3JlIOKAlCBubyByZS1jbG9uZSwgbm8gZXh0cmEgb2JqZWN0cyDigJQgd2hpbGUgZ2l2aW5nIHRoZSBsYW5lIGl0cyBvd25cbiAqIGBIRUFEYCwgaW5kZXggYW5kIGNoZWNrb3V0LiBSZWZzIHN0YXkgc2hhcmVkLCB3aGljaCBpcyB3aGF0IG1ha2VzIHRoZVxuICogcmVtYWluaW5nIGNvbGxpc2lvbnMgKmxvdWQqOiBnaXQgcmVmdXNlcyB0byBtb3ZlIGEgYnJhbmNoIGFub3RoZXIgd29ya3RyZWVcbiAqIGhhcyBjaGVja2VkIG91dCByYXRoZXIgdGhhbiBwdWxsaW5nIHRoZSBydWcgZnJvbSB1bmRlciBpdC4gVGhvc2UgcmVmdXNhbHNcbiAqIGFyZSBjb250ZW50aW9uLCBub3QgUFIgZmF1bHRzIOKAlCBzZWUgYGNsb25lX2NvbnRlbnRpb24udHNgLlxuICpcbiAqIFRoZSB3b3JrdHJlZSBpcyBjcmVhdGVkIGRldGFjaGVkLCBzbyB0aGUgbGFuZSBuZXZlciBjbGFpbXMgYSBicmFuY2ggaXQgZG9lc1xuICogbm90IG5lZWQsIGFuZCBpdCBpcyByZXVzZWQgYWNyb3NzIGN5Y2xlczogY3JlYXRpb24gY29zdHMgb25lIGB3b3JrdHJlZSBhZGRgXG4gKiBvbiBmaXJzdCB1c2UgcGVyIHJlcG8uXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHJ1bkdpdENvbW1hbmQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHsgZW5zdXJlQWxsQnJhbmNoZXNGZXRjaFJlZnNwZWMgfSBmcm9tIFwiLi9naXRfZmV0Y2hfcmVmc3BlYy50c1wiO1xuXG4vKipcbiAqIFdvcmstcm9vdCBkaXJlY3RvcnkgdGhlIGxhbmUgd29ya3RyZWVzIGxpdmUgdW5kZXIuXG4gKlxuICogUmVzZXJ2ZWQgaW4gYHN0YWxlX3dvcmtkaXIudHNgIHNvIHRoZSBob3VzZWtlZXBpbmcgc3dlZXBzIHRoYXQgd2Fsa1xuICogYCR7V09SS19ESVJ9YCBmb3IgZGlzcG9zYWJsZSBjbG9uZXMgbGVhdmUgaXQgYWxvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBMQU5FX1dPUktUUkVFX1JPT1QgPSBcIndvcmt0cmVlc1wiO1xuXG4vKiogTGFuZSBpZCB1c2VkIGJ5IHRoZSBQcmlvcml0eS0xLjYgUFItYnJhbmNoLXVwZGF0ZSBwYXNzLiAqL1xuZXhwb3J0IGNvbnN0IFBSX0JSQU5DSF9VUERBVEVfTEFORV9JRCA9IFwicHItYnJhbmNoLXVwZGF0ZVwiO1xuXG4vKiogUmVxdWVzdCBmb3Ige0BsaW5rIGVuc3VyZUxhbmVXb3JrdHJlZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIExhbmVXb3JrdHJlZVJlcXVlc3Qge1xuICAvKiogRGlyZWN0b3J5IHRoZSB3b3JrZXIgY2xvbmVzIHJlcG9zaXRvcmllcyBpbnRvIChgV09SS19ESVJgKS4gKi9cbiAgd29ya0Rpcjogc3RyaW5nO1xuICAvKiogUmVwb3NpdG9yeSBpbiBgb3duZXIvbmFtZWAgZm9ybS4gKi9cbiAgcmVwbzogc3RyaW5nO1xuICAvKiogU3RhYmxlIGlkIG9mIHRoZSBsYW5lIGFza2luZywgZS5nLiB7QGxpbmsgUFJfQlJBTkNIX1VQREFURV9MQU5FX0lEfS4gKi9cbiAgbGFuZUlkOiBzdHJpbmc7XG4gIC8qKiBQYXRoIG9mIHRoZSBzaGFyZWQgY2xvbmUgdGhlIHdvcmt0cmVlIGlzIGxpbmtlZCB0by4gKi9cbiAgcmVwb1BhdGg6IHN0cmluZztcbn1cblxuLyoqIFJlamVjdCBhIHBhdGggc2VnbWVudCB0aGF0IHdvdWxkIGVzY2FwZSB0aGUgd29yayByb290LiAqL1xuZnVuY3Rpb24gaXNVbnNhZmVTZWdtZW50KHNlZ21lbnQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gc2VnbWVudCA9PT0gXCJcIiB8fCBzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIgfHxcbiAgICBzZWdtZW50LmluY2x1ZGVzKFwiL1wiKSB8fCBzZWdtZW50LmluY2x1ZGVzKFwiXFxcXFwiKTtcbn1cblxuLyoqXG4gKiBXaGVyZSBhIGxhbmUncyB3b3JrdHJlZSBmb3IgYHJlcG9gIGxpdmVzLlxuICpcbiAqIEBwYXJhbSB3b3JrRGlyIC0gVGhlIHdvcmsgcm9vdFxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIGBvd25lci9uYW1lYCBmb3JtXG4gKiBAcGFyYW0gbGFuZUlkIC0gVGhlIGxhbmUncyBzdGFibGUgaWRcbiAqIEByZXR1cm5zIEFic29sdXRlIHBhdGggb2YgdGhlIGxhbmUncyB3b3JrdHJlZVxuICogQHRocm93cyBXaGVuIGVpdGhlciBkZXJpdmVkIHBhdGggc2VnbWVudCB3b3VsZCBlc2NhcGUgdGhlIHdvcmsgcm9vdFxuICovXG5leHBvcnQgZnVuY3Rpb24gbGFuZVdvcmt0cmVlUGF0aChcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGxhbmVJZDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgcmVwb05hbWUgPSByZXBvLnNwbGl0KFwiL1wiKS5wb3AoKSA/PyByZXBvO1xuICBpZiAoaXNVbnNhZmVTZWdtZW50KHJlcG9OYW1lKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBSZWZ1c2luZyBhIGxhbmUgd29ya3RyZWUgZm9yIHVuc2FmZSByZXBvIHNlZ21lbnQgXCIke3JlcG9OYW1lfVwiIGAgK1xuICAgICAgICBgZGVyaXZlZCBmcm9tIHNsdWcgXCIke3JlcG99XCJgLFxuICAgICk7XG4gIH1cbiAgaWYgKGlzVW5zYWZlU2VnbWVudChsYW5lSWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBSZWZ1c2luZyBhIGxhbmUgd29ya3RyZWUgZm9yIHVuc2FmZSBsYW5lIGlkIFwiJHtsYW5lSWR9XCJgKTtcbiAgfVxuICByZXR1cm4gYCR7d29ya0Rpcn0vJHtMQU5FX1dPUktUUkVFX1JPT1R9LyR7bGFuZUlkfS8ke3JlcG9OYW1lfWA7XG59XG5cbi8qKiBJcyBgcGF0aGAgYSB1c2FibGUgd29ya3RyZWUgbGlua2VkIHRvIGByZXBvUGF0aGAncyBvYmplY3Qgc3RvcmU/ICovXG5hc3luYyBmdW5jdGlvbiBpc0xpbmtlZFdvcmt0cmVlKFxuICBwYXRoOiBzdHJpbmcsXG4gIHJlcG9QYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgaW5zaWRlID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLWlzLWluc2lkZS13b3JrLXRyZWVcIl0sXG4gICAgeyBjd2Q6IHBhdGggfSxcbiAgKTtcbiAgaWYgKCFpbnNpZGUub2sgfHwgaW5zaWRlLnZhbHVlLmNvZGUgIT09IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKGluc2lkZS52YWx1ZS5zdGRvdXQudHJpbSgpICE9PSBcInRydWVcIikgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIEEgd29ya3RyZWUgd2hvc2UgY29tbW9uIGRpciBpcyBzb21lICpvdGhlciogY2xvbmUgd291bGQgc2lsZW50bHkgdXBkYXRlXG4gIC8vIHRoZSB3cm9uZyByZXBvc2l0b3J5LCBzbyB0aGUgbGluayBpcyB2ZXJpZmllZCByYXRoZXIgdGhhbiBhc3N1bWVkLlxuICBjb25zdCBjb21tb25EaXIgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJldi1wYXJzZVwiLCBcIi0tcGF0aC1mb3JtYXQ9YWJzb2x1dGVcIiwgXCItLWdpdC1jb21tb24tZGlyXCJdLFxuICAgIHsgY3dkOiBwYXRoIH0sXG4gICk7XG4gIGlmICghY29tbW9uRGlyLm9rIHx8IGNvbW1vbkRpci52YWx1ZS5jb2RlICE9PSAwKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGV4cGVjdGVkID0gYXdhaXQgcmVhbFBhdGhPclNlbGYoYCR7cmVwb1BhdGh9Ly5naXRgKTtcbiAgY29uc3QgYWN0dWFsID0gYXdhaXQgcmVhbFBhdGhPclNlbGYoY29tbW9uRGlyLnZhbHVlLnN0ZG91dC50cmltKCkpO1xuICByZXR1cm4gYWN0dWFsID09PSBleHBlY3RlZDtcbn1cblxuLyoqIFJlc29sdmUgc3ltbGlua3Mgd2hlcmUgcG9zc2libGU7IGZhbGwgYmFjayB0byB0aGUgcGF0aCBhcyBnaXZlbi4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWxQYXRoT3JTZWxmKHBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IERlbm8ucmVhbFBhdGgocGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBwYXRoLnJlcGxhY2UoL1xcLyskLywgXCJcIik7XG4gIH1cbn1cblxuLyoqXG4gKiBNYWtlIHN1cmUgdGhpcyBsYW5lIGhhcyBpdHMgb3duIHdvcmt0cmVlIG9mIGByZXBvYCwgYW5kIHJldHVybiBpdHMgcGF0aC5cbiAqXG4gKiBBbiBleGlzdGluZyBoZWFsdGh5IHdvcmt0cmVlIGlzIHJldXNlZCB1bnRvdWNoZWQuIE90aGVyd2lzZSB0aGUgY2xvbmUnc1xuICogc3RhbGUgd29ya3RyZWUgYWRtaW5pc3RyYXRpb24gaXMgcHJ1bmVkIGFuZCBhIGZyZXNoICoqZGV0YWNoZWQqKiB3b3JrdHJlZVxuICogaXMgYWRkZWQgYXQgdGhlIGNsb25lJ3MgY3VycmVudCBgSEVBRGAuXG4gKlxuICogRmFpbHMgbG91ZDogYSB3b3JrdHJlZSB0aGF0IGNvdWxkIG5vdCBiZSBjcmVhdGVkIGNvbWVzIGJhY2sgYXNcbiAqIGB7IG9rOiBmYWxzZSB9YCBjYXJyeWluZyBnaXQncyBvd24gc3RkZXJyLCBuZXZlciBhIHNpbGVudCBmYWxsYmFjayB0byB0aGVcbiAqIHNoYXJlZCBjbG9uZSDigJQgd29ya2luZyBpbiB0aGUgc2hhcmVkIGNsb25lIGlzIHRoZSBmYXVsdCB0aGlzIGV4aXN0cyB0b1xuICogcHJldmVudC5cbiAqXG4gKiBAcGFyYW0gcmVxdWVzdCAtIFdvcmsgcm9vdCwgcmVwbywgbGFuZSBpZCBhbmQgdGhlIHNoYXJlZCBjbG9uZSdzIHBhdGhcbiAqIEByZXR1cm5zIFRoZSB3b3JrdHJlZSBwYXRoLCBvciB0aGUgcmVhc29uIGl0IGNvdWxkIG5vdCBiZSBwcm92aWRlZFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlTGFuZVdvcmt0cmVlKFxuICByZXF1ZXN0OiBMYW5lV29ya3RyZWVSZXF1ZXN0LFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nPj4ge1xuICBjb25zdCB7IHdvcmtEaXIsIHJlcG8sIGxhbmVJZCwgcmVwb1BhdGggfSA9IHJlcXVlc3Q7XG5cbiAgbGV0IHBhdGg6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBwYXRoID0gbGFuZVdvcmt0cmVlUGF0aCh3b3JrRGlyLCByZXBvLCBsYW5lSWQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gQSB3b3JrdHJlZSBpbmhlcml0cyB0aGUgY2xvbmUncyByZW1vdGUgY29uZmlndXJhdGlvbiwgYW5kIGEgbGVnYWN5XG4gIC8vIHNpbmdsZS1icmFuY2ggY2xvbmUgKGAtLWRlcHRoPTFgIHdpdGhvdXQgYSByZWZzcGVjKSBjYW4gc2VlIG5vIGZlYXR1cmVcbiAgLy8gYnJhbmNoIGF0IGFsbDogYG9yaWdpbi88YnJhbmNoPmAgbmV2ZXIgbWF0ZXJpYWxpc2VzLCB3aGljaCBtYWtlcyBhIGdvb2RcbiAgLy8gcHVzaCBsb29rIGZhaWxlZCBhbmQgYSBtZXJnZWFibGUgUFIgbG9vayBjb25mbGljdGVkIChJc3N1ZSAjMjExKS4gVGhlXG4gIC8vIGRlc3RydWN0aXZlIGBzZXR1cFJlcG9gIHJlcGFpcmVkIHRoYXQgb24gZXZlcnkgcGFzczsgdGhlIGxhbmUgbm8gbG9uZ2VyXG4gIC8vIHJ1bnMgaXQsIHNvIHRoZSByZXBhaXIg4oCUIG9uZSBpZGVtcG90ZW50IGNvbmZpZyBsaW5lIOKAlCBoYXBwZW5zIGhlcmUuXG4gIGNvbnN0IHJlZnNwZWMgPSBhd2FpdCBlbnN1cmVBbGxCcmFuY2hlc0ZldGNoUmVmc3BlYyh7IGN3ZDogcmVwb1BhdGggfSk7XG4gIGlmICghcmVmc3BlYy5vaykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgQ291bGQgbm90IHJlcGFpciB0aGUgZmV0Y2ggcmVmc3BlYyBvZiAke3JlcG99IGJlZm9yZSB0YWtpbmcgYSBgICtcbiAgICAgICAgICBgJHtsYW5lSWR9IHdvcmt0cmVlOiAke3JlZnNwZWMuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGF3YWl0IGlzTGlua2VkV29ya3RyZWUocGF0aCwgcmVwb1BhdGgpKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBwYXRoIH07XG4gIH1cblxuICAvLyBEcm9wIGFkbWluaXN0cmF0aW9uIGZvciB3b3JrdHJlZXMgd2hvc2UgZGlyZWN0b3J5IGhhcyBnb25lLCBzbyBhXG4gIC8vIHJlY3JlYXRlZCBwYXRoIGlzIG5vdCByZWZ1c2VkIGFzIFwiYWxyZWFkeSByZWdpc3RlcmVkXCIuXG4gIGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wid29ya3RyZWVcIiwgXCJwcnVuZVwiXSwgeyBjd2Q6IHJlcG9QYXRoIH0pO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihwYXRoLnNsaWNlKDAsIHBhdGgubGFzdEluZGV4T2YoXCIvXCIpKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgQ291bGQgbm90IGNyZWF0ZSB0aGUgbGFuZSB3b3JrdHJlZSByb290IGZvciAke3JlcG99OiAke1xuICAgICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIGxldCBhZGRlZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wid29ya3RyZWVcIiwgXCJhZGRcIiwgXCItLWRldGFjaFwiLCBcIi0tZm9yY2VcIiwgcGF0aCwgXCJIRUFEXCJdLFxuICAgIHsgY3dkOiByZXBvUGF0aCB9LFxuICApO1xuXG4gIC8vIElzc3VlICMxNTYxOiBgZ2l0IHdvcmt0cmVlIGFkZGAgcmVmdXNlcyBhIHBhdGggdGhhdCBhbHJlYWR5IGV4aXN0cyBhcyBhXG4gIC8vIGRpcmVjdG9yeSwgYW5kIGAtLWZvcmNlYCBkb2VzIG5vdCBvdmVycmlkZSB0aGF0IOKAlCBpdCBvdmVycmlkZXMgYW5cbiAgLy8gYWxyZWFkeS1jaGVja2VkLW91dCBicmFuY2ggYW5kIGFuIGFscmVhZHktcmVnaXN0ZXJlZCBwYXRoLCBub3QgYSBzdHJheVxuICAvLyBkaXJlY3RvcnkuIGB3b3JrdHJlZSBwcnVuZWAgYWJvdmUgZG9lcyBub3QgaGVscCBlaXRoZXI6IGl0IGRyb3BzXG4gIC8vIGFkbWluaXN0cmF0aW9uIGZvciB3b3JrdHJlZXMgd2hvc2UgZGlyZWN0b3J5IGhhcyAqZ29uZSosIGFuZCB0aGlzXG4gIC8vIGRpcmVjdG9yeSBoYXMgbm90IGdvbmUuXG4gIC8vXG4gIC8vIFR3byB0aGluZ3MgbGVhdmUgb25lOiBhIGNvbnRhaW5lciBraWxsZWQgbWlkLXJ1biwgYW5kIGEgc2hhcmVkIGNsb25lXG4gIC8vIHJlY3JlYXRlZCB1bmRlcm5lYXRoIGl0cyBsaW5rZWQgd29ya3RyZWVzICh0aGUgYC5naXRgIGZpbGUgdGhlbiBwb2ludHMgYXRcbiAgLy8gYWRtaW5pc3RyYXRpb24gdGhhdCBubyBsb25nZXIgZXhpc3RzLCBzbyBgaXNMaW5rZWRXb3JrdHJlZWAgc2F5cyBubyBhbmRcbiAgLy8gd2UgYXJyaXZlIGhlcmUpLiBFaXRoZXIgd2F5IHRoZSBsYW5lIHdhcyB3ZWRnZWQgcGVybWFuZW50bHkg4oCUIGV2ZXJ5IGN5Y2xlXG4gIC8vIGRpZWQgaW4gcGhhc2UgYHNldHVwYCBpbnNpZGUgYSBtaW51dGUgYW5kIHJlbGVhc2VkIHRoZSBjbGFpbSB3aXRoIG5vIFBSLFxuICAvLyBhbmQgdGhlIG5leHQgY3ljbGUgZmFpbGVkIGlkZW50aWNhbGx5LiBOb3RoaW5nIGFib3V0IHRoYXQgc2VsZi1oZWFscyB3aXRoXG4gIC8vIHRpbWUsIHNvIGNsZWFyIHRoZSBvcnBoYW4gYW5kIHRyeSBvbmNlIG1vcmUuXG4gIGlmIChpc1BhdGhBbHJlYWR5RXhpc3RzKGFkZGVkKSkge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLnJlbW92ZShwYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgQ291bGQgbm90IGNyZWF0ZSBhICR7bGFuZUlkfSB3b3JrdHJlZSBmb3IgJHtyZXBvfSBhdCAke3BhdGh9OiB0aGUgYCArXG4gICAgICAgICAgICBgcGF0aCBhbHJlYWR5IGV4aXN0cyBhbmQgaXMgbm90IGEgd29ya3RyZWUgb2YgJHtyZXBvUGF0aH0sIGFuZCBgICtcbiAgICAgICAgICAgIGBpdCBjb3VsZCBub3QgYmUgY2xlYXJlZDogJHtcbiAgICAgICAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICAgICAgICB9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wid29ya3RyZWVcIiwgXCJwcnVuZVwiXSwgeyBjd2Q6IHJlcG9QYXRoIH0pO1xuICAgIGFkZGVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgIFtcIndvcmt0cmVlXCIsIFwiYWRkXCIsIFwiLS1kZXRhY2hcIiwgXCItLWZvcmNlXCIsIHBhdGgsIFwiSEVBRFwiXSxcbiAgICAgIHsgY3dkOiByZXBvUGF0aCB9LFxuICAgICk7XG4gIH1cblxuICAvLyBJc3N1ZSAjMzYzMDogYEhFQURgIHJlc29sdmVzIHRocm91Z2ggdGhlIGNsb25lJ3Mgc3ltcmVmLiBNaWxlc3RvbmUgc3luY1xuICAvLyBjaGVja3MgdGhlIG1pbGVzdG9uZSBicmFuY2ggb3V0IG9mIHRoZSBtYWluIGNsb25lIGFuZCBsZWF2ZXMgaXQgdGhlcmU7XG4gIC8vIHdoZW4gdGhhdCBicmFuY2ggbGF0ZXIgZ29lcyDigJQgY2xlYW51cCwgYSByZWNyZWF0ZWQgY2xvbmUsIGEgc2libGluZydzXG4gIC8vIHN5bmMg4oCUIEhFQUQgZGFuZ2xlcywgYW5kIGV2ZXJ5IHdvcmt0cmVlIGFkZCBmYWlscyB3aXRoXG4gIC8vIGBmYXRhbDogaW52YWxpZCByZWZlcmVuY2U6IEhFQURgLiBOb3RoaW5nIHJld3JpdGVzIHRoZSBzeW1yZWYgb24gaXRzXG4gIC8vIG93biwgc28gdGhlIGxhbmUgd2VkZ2VkIHBlcm1hbmVudGx5OiBldmVyeSBjeWNsZSBkaWVkIGluIHBoYXNlIGBzZXR1cGBcbiAgLy8gaW5zaWRlIGEgbWludXRlICh0aGUgc3RTb2Z0d2FyZUFVL0dSUS1BdXRvVHJhZGVyIzMxODQgdGFsbHkpLiBIZWFsIHRoZVxuICAvLyBjbG9uZSB0byBpdHMgZGVmYXVsdCBicmFuY2ggYW5kIHJldHJ5IG9uY2U7IGFueSBvdGhlciBmYWlsdXJlIGtlZXBzXG4gIC8vIHRvZGF5J3MgYmVoYXZpb3VyLCBhbmQgYSBmYWlsZWQgaGVhbCBuYW1lcyBib3RoIGZhdWx0cy5cbiAgaWYgKGlzSW52YWxpZEhlYWRSZWZlcmVuY2UoYWRkZWQpKSB7XG4gICAgY29uc3QgaGVhbGVkID0gYXdhaXQgaGVhbERhbmdsaW5nSGVhZChyZXBvUGF0aCk7XG4gICAgaWYgKCFoZWFsZWQub2spIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgQ291bGQgbm90IGNyZWF0ZSBhICR7bGFuZUlkfSB3b3JrdHJlZSBmb3IgJHtyZXBvfSBhdCAke3BhdGh9OiBgICtcbiAgICAgICAgICAgIGB0aGUgY2xvbmUncyBIRUFEIGlzIGludmFsaWQgYW5kIHRoZSBoZWFsIGZhaWxlZDogYCArXG4gICAgICAgICAgICBgJHtoZWFsZWQuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gICAgYWRkZWQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgW1wid29ya3RyZWVcIiwgXCJhZGRcIiwgXCItLWRldGFjaFwiLCBcIi0tZm9yY2VcIiwgcGF0aCwgXCJIRUFEXCJdLFxuICAgICAgeyBjd2Q6IHJlcG9QYXRoIH0sXG4gICAgKTtcbiAgfVxuXG4gIGlmICghYWRkZWQub2sgfHwgYWRkZWQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgQ291bGQgbm90IGNyZWF0ZSBhICR7bGFuZUlkfSB3b3JrdHJlZSBmb3IgJHtyZXBvfSBhdCAke3BhdGh9OiAke1xuICAgICAgICAgIHdvcmt0cmVlQWRkRmFpbHVyZURldGFpbChhZGRlZClcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHBhdGggfTtcbn1cblxuLyoqIE91dGNvbWUgb2YgdGhlIGBnaXQgd29ya3RyZWUgYWRkYCBydW4sIGFzIHtAbGluayBydW5HaXRDb21tYW5kfSByZXBvcnRzIGl0LiAqL1xudHlwZSBXb3JrdHJlZUFkZE91dGNvbWUgPSBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJ1bkdpdENvbW1hbmQ+PjtcblxuLyoqXG4gKiBUcnVlIHdoZW4gYGdpdCB3b3JrdHJlZSBhZGRgIHJlZnVzZWQgYmVjYXVzZSB0aGUgdGFyZ2V0IHBhdGggaXMgYWxyZWFkeVxuICogdGhlcmUg4oCUIHRoZSBvbmUgZmFpbHVyZSB0aGlzIG1vZHVsZSBjYW4gY2xlYXIgYW5kIHJldHJ5IChJc3N1ZSAjMTU2MSkuXG4gKlxuICogTWF0Y2hlZCBvbiBnaXQncyBvd24gd29yZGluZyByYXRoZXIgdGhhbiB0aGUgZXhpdCBjb2RlLCB3aGljaCBpcyBhIGdlbmVyaWNcbiAqIDEyOCBmb3IgZXZlcnkgZmF0YWwuIEEgd29yZGluZyBjaGFuZ2UgdXBzdHJlYW0gY29zdHMgdGhlIHJldHJ5LCBub3RcbiAqIGNvcnJlY3RuZXNzOiB0aGUgY2FsbCBzdGlsbCBmYWlscyBsb3VkbHkgd2l0aCB0aGUgZGV0YWlsIGJlbG93LlxuICovXG5mdW5jdGlvbiBpc1BhdGhBbHJlYWR5RXhpc3RzKGFkZGVkOiBXb3JrdHJlZUFkZE91dGNvbWUpOiBib29sZWFuIHtcbiAgaWYgKCFhZGRlZC5vayB8fCBhZGRlZC52YWx1ZS5jb2RlID09PSAwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAvZmF0YWw6LiphbHJlYWR5IGV4aXN0cy9pLnRlc3QoYWRkZWQudmFsdWUuc3RkZXJyKTtcbn1cblxuLyoqXG4gKiBUaGUgcmVwb3J0YWJsZSBjYXVzZSBvZiBhIGZhaWxlZCBgZ2l0IHdvcmt0cmVlIGFkZGAgKElzc3VlICMxNTYxKS5cbiAqXG4gKiBgZ2l0IHdvcmt0cmVlIGFkZGAgd3JpdGVzIGBQcmVwYXJpbmcgd29ya3RyZWUgKGRldGFjaGVkIEhFQUQgYWJjMTIzNClgIHRvXG4gKiAqKnN0ZGVycioqIGJlZm9yZSBpdCBkb2VzIGFueSB3b3JrLCBzbyBhIHBsYWluIGBzdGRlcnIudHJpbSgpYCBsZWFkcyB3aXRoIGFcbiAqIGxpbmUgdGhhdCBzYXlzIG5vdGhpbmcgYW5kIGJ1cmllcyB0aGUgYGZhdGFsOmAgdGhhdCBmb2xsb3dzLiBPbiBJc3N1ZSAjMTU2MVxuICogdGhlIHVzZWZ1bCBoYWxmIHdhcyB0aGVuIHRydW5jYXRlZCBvdXQgb2YgdGhlIGlzc3VlIGNvbW1lbnQgYWx0b2dldGhlciwgYW5kXG4gKiB0aGUgcmVwb3J0IGEgaHVtYW4gaGFkIHRvIGFjdCBvbiByZWFkIGBQcmVwYXJpbmcgd29ya3RyZWUgKGRldGFjaGVkIEhFQeKApmAuXG4gKlxuICogVGhlIHByZWFtYmxlIGlzIGRyb3BwZWQgc28gdGhlIGFjdHVhbCBjYXVzZSBsZWFkcy4gRXZlcnkgb3RoZXIgbGluZSBpc1xuICoga2VwdCDigJQgaW5jbHVkaW5nIGFueSBnaXQgd3JpdGVzIHRoYXQgdGhpcyBtb2R1bGUgZG9lcyBub3QgcmVjb2duaXNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd29ya3RyZWVBZGRGYWlsdXJlRGV0YWlsKGFkZGVkOiBXb3JrdHJlZUFkZE91dGNvbWUpOiBzdHJpbmcge1xuICBpZiAoIWFkZGVkLm9rKSByZXR1cm4gYWRkZWQuZXJyb3IubWVzc2FnZTtcbiAgY29uc3QgbWVhbmluZ2Z1bCA9IGFkZGVkLnZhbHVlLnN0ZGVyclxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5maWx0ZXIoKGxpbmUpID0+ICEvXlxccypQcmVwYXJpbmcgd29ya3RyZWVcXGIvLnRlc3QobGluZSkpXG4gICAgLmpvaW4oXCJcXG5cIilcbiAgICAudHJpbSgpO1xuICByZXR1cm4gbWVhbmluZ2Z1bCB8fCBgZXhpdCAke2FkZGVkLnZhbHVlLmNvZGV9YDtcbn1cblxuLyoqXG4gKiBUcnVlIHdoZW4gYGdpdCB3b3JrdHJlZSBhZGRgIHJlZnVzZWQgYmVjYXVzZSB0aGUgY2xvbmUncyBgSEVBRGAgc3ltcmVmXG4gKiBwb2ludHMgYXQgYSBicmFuY2ggdGhhdCBubyBsb25nZXIgZXhpc3RzIChJc3N1ZSAjMzYzMCkuXG4gKlxuICogTWF0Y2hlZCBvbiBnaXQncyBvd24gd29yZGluZyDigJQgYGZhdGFsOiBpbnZhbGlkIHJlZmVyZW5jZTogSEVBRGAsIG9yIHRoZVxuICogYEhFQUQgcG9pbnRzIHRvIGFuIGludmFsaWQgKG9yIG9ycGhhbmVkKSByZWZlcmVuY2VgIHdhcm5pbmcgbmV3ZXIgZ2l0XG4gKiB2ZXJzaW9ucyBwcmludCBmb3IgdGhlIHNhbWUgY29uZGl0aW9uIOKAlCB0aGUgc2FtZSB3YXlcbiAqIHtAbGluayBpc1BhdGhBbHJlYWR5RXhpc3RzfSBtYXRjaGVzIHRoZSBvcnBoYW4tcGF0aCByZWZ1c2FsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNJbnZhbGlkSGVhZFJlZmVyZW5jZShvdXRjb21lOiBXb3JrdHJlZUFkZE91dGNvbWUpOiBib29sZWFuIHtcbiAgY29uc3QgZGV0YWlsID0gd29ya3RyZWVBZGRGYWlsdXJlRGV0YWlsKG91dGNvbWUpO1xuICByZXR1cm4gZGV0YWlsLmluY2x1ZGVzKFwiaW52YWxpZCByZWZlcmVuY2U6IEhFQURcIikgfHxcbiAgICBkZXRhaWwuaW5jbHVkZXMoXCJIRUFEIHBvaW50cyB0byBhbiBpbnZhbGlkXCIpO1xufVxuXG4vKipcbiAqIFJld3JpdGUgdGhlIGNsb25lJ3MgZGFuZ2xpbmcgYEhFQURgIHN5bXJlZiB0byBpdHMgZGVmYXVsdCBicmFuY2hcbiAqIChJc3N1ZSAjMzYzMCkuXG4gKlxuICogVGhlIGRlZmF1bHQgYnJhbmNoIGlzIHJlc29sdmVkIGZyb20gdGhlIGNsb25lIGl0c2VsZiDigJRcbiAqIGBnaXQgc3ltYm9saWMtcmVmIHJlZnMvcmVtb3Rlcy9vcmlnaW4vSEVBRGAsIHRoZSBzYW1lIGxvY2FsIHJlc29sdXRpb25cbiAqIGBzZXR1cFJlcG8oKWAgcmVsaWVzIG9uIChgcmVzb2x2ZUxvY2FsRGVmYXVsdEJyYW5jaGAgaW4gYGdpdF9wdXNoLnRzYDtcbiAqIGlubGluZWQgaGVyZSBiZWNhdXNlIGBnaXRfcHVzaGAgaW1wb3J0cyB0aGlzIG1vZHVsZSdzIHJvb3QgY29uc3RhbnQgYW5kIGFuXG4gKiBpbXBvcnQgd291bGQgY3ljbGUpIOKAlCBzbyBubyBuZXR3b3JrIGNhbGwgaXMgbWFkZS4gV2hlbiB0aGUgbG9jYWwgZGVmYXVsdFxuICogYnJhbmNoIGV4aXN0cyB0aGUgc3ltcmVmIGlzIHJld3JpdHRlbiBpbiBwbGFjZTsgb3RoZXJ3aXNlIHRoZSBicmFuY2ggaXNcbiAqIHJlY3JlYXRlZCBmcm9tIHRoZSByZW1vdGUtdHJhY2tpbmcgcmVmIGZpcnN0LiBGYWlscyBsb3VkIHJhdGhlciB0aGFuXG4gKiBndWVzc2luZyB3aGVuIGBvcmlnaW4vSEVBRGAgaXMgdW5zZXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoZWFsRGFuZ2xpbmdIZWFkKFxuICByZXBvUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3Qgb3JpZ2luSGVhZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wic3ltYm9saWMtcmVmXCIsIFwicmVmcy9yZW1vdGVzL29yaWdpbi9IRUFEXCJdLFxuICAgIHsgY3dkOiByZXBvUGF0aCB9LFxuICApO1xuICBpZiAoIW9yaWdpbkhlYWQub2sgfHwgb3JpZ2luSGVhZC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgY29uc3QgZGV0YWlsID0gb3JpZ2luSGVhZC5va1xuICAgICAgPyBvcmlnaW5IZWFkLnZhbHVlLnN0ZGVyci50cmltKCkgfHwgYGV4aXQgJHtvcmlnaW5IZWFkLnZhbHVlLmNvZGV9YFxuICAgICAgOiBvcmlnaW5IZWFkLmVycm9yLm1lc3NhZ2U7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoYG9yaWdpbi9IRUFEIGlzIHVuc2V0ICgke2RldGFpbH0pYCksXG4gICAgfTtcbiAgfVxuICBjb25zdCB0YXJnZXQgPSBvcmlnaW5IZWFkLnZhbHVlLnN0ZG91dC50cmltKCk7XG4gIGNvbnN0IGJyYW5jaCA9IHRhcmdldC5yZXBsYWNlKC9ecmVmc1xcL3JlbW90ZXNcXC9vcmlnaW5cXC8vLCBcIlwiKTtcbiAgaWYgKGJyYW5jaCA9PT0gdGFyZ2V0IHx8IGJyYW5jaCA9PT0gXCJcIikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKGBvcmlnaW4vSEVBRCByZXNvbHZlZCB0byBcIiR7dGFyZ2V0fVwiLCBub3QgYSBicmFuY2hgKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgbG9jYWwgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInNob3ctcmVmXCIsIFwiLS12ZXJpZnlcIiwgXCItLXF1aWV0XCIsIGByZWZzL2hlYWRzLyR7YnJhbmNofWBdLFxuICAgIHsgY3dkOiByZXBvUGF0aCB9LFxuICApO1xuICBpZiAobG9jYWwub2sgJiYgbG9jYWwudmFsdWUuY29kZSA9PT0gMCkge1xuICAgIGNvbnN0IHJld3JvdGUgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgW1wic3ltYm9saWMtcmVmXCIsIFwiSEVBRFwiLCBgcmVmcy9oZWFkcy8ke2JyYW5jaH1gXSxcbiAgICAgIHsgY3dkOiByZXBvUGF0aCB9LFxuICAgICk7XG4gICAgaWYgKCFyZXdyb3RlLm9rIHx8IHJld3JvdGUudmFsdWUuY29kZSAhPT0gMCkge1xuICAgICAgY29uc3QgZGV0YWlsID0gcmV3cm90ZS5va1xuICAgICAgICA/IHJld3JvdGUudmFsdWUuc3RkZXJyLnRyaW0oKSB8fCBgZXhpdCAke3Jld3JvdGUudmFsdWUuY29kZX1gXG4gICAgICAgIDogcmV3cm90ZS5lcnJvci5tZXNzYWdlO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKGBjb3VsZCBub3QgcmV3cml0ZSBIRUFEIHRvICR7YnJhbmNofSAoJHtkZXRhaWx9KWApLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuXG4gIGNvbnN0IHJlY3JlYXRlZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wiY2hlY2tvdXRcIiwgXCItQlwiLCBicmFuY2gsIGBvcmlnaW4vJHticmFuY2h9YF0sXG4gICAgeyBjd2Q6IHJlcG9QYXRoIH0sXG4gICk7XG4gIGlmICghcmVjcmVhdGVkLm9rIHx8IHJlY3JlYXRlZC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgY29uc3QgZGV0YWlsID0gcmVjcmVhdGVkLm9rXG4gICAgICA/IHJlY3JlYXRlZC52YWx1ZS5zdGRlcnIudHJpbSgpIHx8IGBleGl0ICR7cmVjcmVhdGVkLnZhbHVlLmNvZGV9YFxuICAgICAgOiByZWNyZWF0ZWQuZXJyb3IubWVzc2FnZTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihgY291bGQgbm90IHJlY3JlYXRlICR7YnJhbmNofSAoJHtkZXRhaWx9KWApLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbn1cblxuLyoqXG4gKiBEZXRhY2ggdGhlIGxhbmUgd29ya3RyZWUncyBgSEVBRGAgc28gaXQgaG9sZHMgbm8gYnJhbmNoIChJc3N1ZSAjMzk0KS5cbiAqXG4gKiBCcmFuY2hlcyBhcmUgc2hhcmVkIGJldHdlZW4gd29ya3RyZWVzOiBhIGxhbmUgdGhhdCBsZWF2ZXMgb25lIGNoZWNrZWQgb3V0XG4gKiBibG9ja3MgZXZlcnkgb3RoZXIgbGFuZSBmcm9tIG1vdmluZyBpdCwgd2hpY2ggaXMgdGhlIGNvbnRlbnRpb24gdGhpc1xuICogbW9kdWxlIGV4aXN0cyB0byBhdm9pZC4gQ2FsbGVkIGFmdGVyIGVhY2ggUFIgdGhlIGxhbmUgdG91Y2hlcywgYW5kIGFmdGVyXG4gKiBlYWNoIGlzc3VlIHJ1biBlbmRzIChJc3N1ZSAjMTY3Nykg4oCUIGEgZmluaXNoZWQgaXNzdWUgbGFuZSB1c2VkIHRvIHN0YXkgb25cbiAqIGl0cyBQUiBicmFuY2ggdW50aWwgdGhlIGxhbmUgd2FzIG5leHQgcmV1c2VkLCB3aGljaCBibG9ja2VkIHRoZSBDSS1maXggcGFzc1xuICogZm9yIHRoYXQgdmVyeSBQUi5cbiAqXG4gKiBgcnVuYCBpcyB0aGUgZ2l0IHJ1bm5lciB0byBkZXRhY2ggd2l0aDsgcHJvZHVjdGlvbiBwYXNzZXMgbm90aGluZyBhbmQgZ2V0c1xuICogdGhlIHRpbWVvdXQgY2hva2Vwb2ludCwgdGVzdHMgcGFzcyB0aGVpciByZWNvcmRpbmcgbW9jay5cbiAqXG4gKiBCZXN0LWVmZm9ydCBieSBkZXNpZ24g4oCUIGEgd29ya3RyZWUgdGhhdCBjYW5ub3QgYmUgZGV0YWNoZWQgaXMgbm90IGFcbiAqIGZhaWx1cmUgb2YgdGhlIHVwZGF0ZSB0aGF0IGp1c3QgcmFuOyB0aGUgbmV4dCBgZW5zdXJlTGFuZVdvcmt0cmVlYCByZXVzZXNcbiAqIG9yIHJlY3JlYXRlcyBpdC5cbiAqXG4gKiBAcGFyYW0gcGF0aCAtIFRoZSBsYW5lIHdvcmt0cmVlJ3MgcGF0aFxuICogQHJldHVybnMgVHJ1ZSB3aGVuIGBIRUFEYCBpcyBkZXRhY2hlZCBhZnRlcndhcmRzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkZXRhY2hMYW5lV29ya3RyZWVIZWFkKFxuICBwYXRoOiBzdHJpbmcsXG4gIHJ1bjogdHlwZW9mIHJ1bkdpdENvbW1hbmQgPSBydW5HaXRDb21tYW5kLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGRldGFjaGVkID0gYXdhaXQgcnVuKFtcImNoZWNrb3V0XCIsIFwiLS1kZXRhY2hcIl0sIHsgY3dkOiBwYXRoIH0pO1xuICByZXR1cm4gZGV0YWNoZWQub2sgJiYgZGV0YWNoZWQudmFsdWUuY29kZSA9PT0gMDtcbn1cblxuLyoqXG4gKiBUaGUgbGFuZSB3b3JrdHJlZSBob2xkaW5nIGEgYnJhbmNoLCB3aGVuIGdpdCByZWZ1c2VkIGEgY2hlY2tvdXQgZm9yIHRoYXRcbiAqIHJlYXNvbiAoSXNzdWUgIzE1NjQsIElzc3VlICMxNjc3KS5cbiAqXG4gKiBCcmFuY2hlcyBhcmUgc2hhcmVkIGJldHdlZW4gdGhlIHdvcmt0cmVlcyBvZiBvbmUgY2xvbmUsIHNvIGBnaXQgY2hlY2tvdXRgXG4gKiBvZiBhIGJyYW5jaCBhbm90aGVyIHdvcmt0cmVlIGhhcyBvdXQgZmFpbHMgd2l0aFxuICogYGZhdGFsOiAnPGJyYW5jaD4nIGlzIGFscmVhZHkgdXNlZCBieSB3b3JrdHJlZSBhdCAnPHBhdGg+J2AuIFJldHVybnMgdGhhdFxuICogcGF0aCBvbmx5IHdoZW4gaXQgaXMgb25lIG9mICoqdGhpcyBob3N0J3Mgb3duIGxhbmUgd29ya3RyZWVzKiog4oCUXG4gKiBgPHdvcmsgcm9vdD4vd29ya3RyZWVzLzxsYW5lPi88cmVwbz5gLCB0aGUgc2hhcGUge0BsaW5rIGxhbmVXb3JrdHJlZVBhdGh9XG4gKiBidWlsZHMuIEEgYnJhbmNoIGhlbGQgYnkgYW55dGhpbmcgZWxzZSAoYSBkZXZlbG9wZXIncyBvd24gd29ya3RyZWUsIGEgcGF0aFxuICogZ2l0IG5hbWVzIHRoYXQgdGhpcyBtb2R1bGUgZG9lcyBub3QgcmVjb2duaXNlKSBpcyByZXBvcnRlZCByYXRoZXIgdGhhblxuICogd3JlbmNoZWQgYXdheTogdGhlIHJlcGFpciBpcyBmb3IgdGhlIGZsZWV0J3Mgb3duIGNvbnRlbnRpb24sIG5vdCBmb3JcbiAqIHdoYXRldmVyIGVsc2UgaGFwcGVucyB0byBzaGFyZSB0aGUgY2xvbmUuIFRoZSBzaGFyZWQgY2xvbmUncyBvd24gcHJpbWFyeVxuICogd29ya3RyZWUgaXMgdGhlIG90aGVyIGhvbGRlciB0aGUgaXNzdWUgcGF0aCAoY3JlYXRlIGFuZCByZXN1bWUpIGFsc29cbiAqIHJlbGVhc2VzLCB2aWEge0BsaW5rIHByaW1hcnlDbG9uZUhvbGRpbmdCcmFuY2h9IChJc3N1ZSAjNDc4OSk7IHRoZSBQUiBwYXNzZXNcbiAqIGRvIG5vdC5cbiAqXG4gKiBTaGFyZWQgYnkgdGhlIGlzc3VlIHBhdGggKGBjcmVhdGVGZWF0dXJlQnJhbmNoRnJvbUJhc2VgLFxuICogYHJlc3VtZUZlYXR1cmVCcmFuY2hGcm9tUmVtb3RlYCkgYW5kIHRoZSBQUlxuICogcGFzc2VzIChgcHJlcGFyZVByQnJhbmNoYCwgYGNoZWNrb3V0UHJCcmFuY2hBdFJlbW90ZUhlYWRgKTogYmVmb3JlICMxNjc3XG4gKiBvbmx5IHRoZSBpc3N1ZSBwYXRoIHJlY29nbmlzZWQgdGhlIHJlZnVzYWwsIHNvIGEgZmluaXNoZWQgaXNzdWUgbGFuZSBwYXJrZWRcbiAqIG9uIGl0cyBQUiBicmFuY2ggYmxvY2tlZCB0aGUgQ0ktZml4IHBhc3MgZm9yIHRoYXQgUFIgb24gZXZlcnkgY3ljbGUuXG4gKlxuICogQHBhcmFtIHN0ZGVyciAtIGdpdCdzIHN0ZGVyciBmcm9tIHRoZSByZWZ1c2VkIGNoZWNrb3V0XG4gKiBAcmV0dXJucyBUaGUgbGFuZSB3b3JrdHJlZSdzIHBhdGgsIG9yIGB1bmRlZmluZWRgIHdoZW4gdGhlIHJlZnVzYWwgaXMgbm90XG4gKiAgIGEgaGVsZCBicmFuY2ggb3IgdGhlIGhvbGRlciBpcyBub3Qgb25lIG9mIHRoaXMgaG9zdCdzIGxhbmUgd29ya3RyZWVzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsYW5lV29ya3RyZWVIb2xkaW5nQnJhbmNoKHN0ZGVycjogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcGF0aCA9IGhlbGRXb3JrdHJlZVBhdGgoc3RkZXJyKTtcbiAgaWYgKHBhdGggPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAvLyBgPC4uLj4vPExBTkVfV09SS1RSRUVfUk9PVD4vPGxhbmU+LzxyZXBvPmA6IHRoZSBsYW5lIHJvb3QgbXVzdCBiZSB0aGVcbiAgLy8gdGhpcmQgc2VnbWVudCBmcm9tIHRoZSBlbmQsIHNvIGEgbWVyZWx5IHNpbWlsYXIgcGF0aCBkb2VzIG5vdCBxdWFsaWZ5LlxuICBjb25zdCBzZWdtZW50cyA9IHBhdGguc3BsaXQoXCIvXCIpLmZpbHRlcigoc2VnbWVudCkgPT4gc2VnbWVudCAhPT0gXCJcIik7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPCAzKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gc2VnbWVudHNbc2VnbWVudHMubGVuZ3RoIC0gM10gPT09IExBTkVfV09SS1RSRUVfUk9PVFxuICAgID8gcGF0aFxuICAgIDogdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFRoZSB3b3JrdHJlZSBwYXRoIGdpdCBuYW1lcyBpbiBhIFwiYnJhbmNoIGFscmVhZHkgdXNlZCBieSBhIHdvcmt0cmVlXCJcbiAqIHJlZnVzYWwsIG9yIGB1bmRlZmluZWRgIHdoZW4gdGhlIHN0ZGVyciBpcyBub3QgdGhhdCByZWZ1c2FsIChJc3N1ZSAjMTU2NCkuXG4gKlxuICogQHBhcmFtIHN0ZGVyciAtIGdpdCdzIHN0ZGVyciBmcm9tIHRoZSByZWZ1c2VkIGNoZWNrb3V0XG4gKiBAcmV0dXJucyBUaGUgcXVvdGVkIHBhdGggZ2l0IHJlcG9ydHMgYXMgaG9sZGluZyB0aGUgYnJhbmNoXG4gKi9cbmZ1bmN0aW9uIGhlbGRXb3JrdHJlZVBhdGgoc3RkZXJyOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gc3RkZXJyLm1hdGNoKC9pcyBhbHJlYWR5IHVzZWQgYnkgd29ya3RyZWUgYXQgJyhbXiddKyknLyk/LlsxXTtcbn1cblxuLyoqXG4gKiBUaGUgc2hhcmVkIGNsb25lJ3Mgb3duIHByaW1hcnkgd29ya3RyZWUsIHdoZW4gaXQgaXMgdGhlIGhvbGRlciBvZiBhIGJyYW5jaFxuICogZ2l0IHJlZnVzZWQgdG8gY2hlY2sgb3V0IChJc3N1ZSAjNDc4OSkuXG4gKlxuICoge0BsaW5rIGxhbmVXb3JrdHJlZUhvbGRpbmdCcmFuY2h9IG9ubHkgcmVjb2duaXNlcyBsYW5lIHdvcmt0cmVlcywgc28gYVxuICogYnJhbmNoIGxlZnQgY2hlY2tlZCBvdXQgaW4gdGhlIGNsb25lJ3MgcHJpbWFyeSB3b3JrdHJlZVxuICogKGA8d29yayByb290Pi88cmVwbz5gKSB3YXMgbmV2ZXIgcmVsZWFzZWQ6IHRoZSByZWZ1c2FsIHdhcyBub3QgcmVjb2duaXNlZFxuICogYW5kIHRoZSBpc3N1ZSBkaWVkIGluIHBoYXNlIGBzZXR1cGAgb24gZXZlcnkgcmUtY2xhaW0uIFRoZSBwcmltYXJ5IGNsb25lIGlzXG4gKiB0aGUgd29ya2VyJ3Mgb3duIHNoYXJlZCBjbG9uZSwgbm90IGEgZGV2ZWxvcGVyJ3MgY2hlY2tvdXQsIGFuZCB0aGUgY2xhaW1cbiAqIGd1YXJhbnRlZXMgbm8gb3RoZXIgcnVuIG93bnMgdGhpcyBpc3N1ZSdzIGJyYW5jaCwgc28gcmVsZWFzaW5nIGl0cyBob2xkIGlzXG4gKiB0aGUgc2FtZSBob3N0LWludGVybmFsIGNvbnRlbnRpb24gcmVwYWlyLiBgY2hlY2tvdXQgLS1kZXRhY2hgIGtlZXBzIHRoZVxuICogd29ya2luZyB0cmVlLCBvbmx5IHRoZSBicmFuY2ggcG9pbnRlciBpcyByZWxlYXNlZC5cbiAqXG4gKiBBbnl0aGluZyBlbHNlIGdpdCBuYW1lcyDigJQgYSBsYW5lIHdvcmt0cmVlIChoYW5kbGVkIGJ5XG4gKiB7QGxpbmsgbGFuZVdvcmt0cmVlSG9sZGluZ0JyYW5jaH0pLCBvciBhIGRldmVsb3BlcidzIG93biBsaW5rZWQgd29ya3RyZWUg4oCUXG4gKiBpcyBub3QgdGhpcyBjbG9uZSdzIHByaW1hcnkgYW5kIHJldHVybnMgYHVuZGVmaW5lZGAsIHNvIGl0IGlzIHJlcG9ydGVkXG4gKiByYXRoZXIgdGhhbiB0b3VjaGVkLlxuICpcbiAqIEBwYXJhbSBzdGRlcnIgLSBnaXQncyBzdGRlcnIgZnJvbSB0aGUgcmVmdXNlZCBjaGVja291dFxuICogQHBhcmFtIGN3ZCAtIEEgZGlyZWN0b3J5IGluc2lkZSB0aGUgc2hhcmVkIGNsb25lLCB1c2VkIHRvIGxpc3QgaXRzIHdvcmt0cmVlc1xuICogQHBhcmFtIHJ1biAtIFRoZSBnaXQgcnVubmVyOyBwcm9kdWN0aW9uIHBhc3NlcyBub3RoaW5nLCB0ZXN0cyBwYXNzIGEgbW9ja1xuICogQHJldHVybnMgVGhlIHByaW1hcnkgd29ya3RyZWUncyBwYXRoIGFzIGdpdCByZXBvcnRlZCBpdCwgb3IgYHVuZGVmaW5lZGBcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHByaW1hcnlDbG9uZUhvbGRpbmdCcmFuY2goXG4gIHN0ZGVycjogc3RyaW5nLFxuICBjd2Q6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgcnVuOiB0eXBlb2YgcnVuR2l0Q29tbWFuZCA9IHJ1bkdpdENvbW1hbmQsXG4pOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuICBjb25zdCBoZWxkID0gaGVsZFdvcmt0cmVlUGF0aChzdGRlcnIpO1xuICBpZiAoaGVsZCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIC8vIGBnaXQgd29ya3RyZWUgbGlzdGAgbmFtZXMgdGhlIG1haW4gd29ya3RyZWUgZmlyc3QsIHNvIHRoZSBmaXJzdFxuICAvLyBgd29ya3RyZWUgPHBhdGg+YCBsaW5lIGlzIHRoaXMgY2xvbmUncyBwcmltYXJ5LlxuICBjb25zdCBsaXN0aW5nID0gYXdhaXQgcnVuKFtcIndvcmt0cmVlXCIsIFwibGlzdFwiLCBcIi0tcG9yY2VsYWluXCJdLCB7IGN3ZCB9KTtcbiAgaWYgKCFsaXN0aW5nLm9rIHx8IGxpc3RpbmcudmFsdWUuY29kZSAhPT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbGluZSA9IGxpc3RpbmcudmFsdWUuc3Rkb3V0LnNwbGl0KFwiXFxuXCIpLmZpbmQoKGVudHJ5KSA9PlxuICAgIGVudHJ5LnN0YXJ0c1dpdGgoXCJ3b3JrdHJlZSBcIilcbiAgKTtcbiAgaWYgKGxpbmUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgcHJpbWFyeSA9IGxpbmUuc2xpY2UoXCJ3b3JrdHJlZSBcIi5sZW5ndGgpO1xuXG4gIGNvbnN0IG1hdGNoZXMgPSBhd2FpdCByZWFsUGF0aE9yU2VsZihoZWxkKSA9PT0gYXdhaXQgcmVhbFBhdGhPclNlbGYocHJpbWFyeSk7XG4gIHJldHVybiBtYXRjaGVzID8gaGVsZCA6IHVuZGVmaW5lZDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QkMsR0FHRCxTQUFTLGFBQWEsUUFBUSxtQkFBbUI7QUFDakQsU0FBUyw2QkFBNkIsUUFBUSx5QkFBeUI7QUFFdkU7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0scUJBQXFCLFlBQVk7QUFFOUMsNERBQTRELEdBQzVELE9BQU8sTUFBTSwyQkFBMkIsbUJBQW1CO0FBYzNELDJEQUEyRCxHQUMzRCxTQUFTLGdCQUFnQixPQUFlO0VBQ3RDLE9BQU8sWUFBWSxNQUFNLFlBQVksT0FBTyxZQUFZLFFBQ3RELFFBQVEsUUFBUSxDQUFDLFFBQVEsUUFBUSxRQUFRLENBQUM7QUFDOUM7QUFFQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxpQkFDZCxPQUFlLEVBQ2YsSUFBWSxFQUNaLE1BQWM7RUFFZCxNQUFNLFdBQVcsS0FBSyxLQUFLLENBQUMsS0FBSyxHQUFHLE1BQU07RUFDMUMsSUFBSSxnQkFBZ0IsV0FBVztJQUM3QixNQUFNLElBQUksTUFDUixDQUFDLGtEQUFrRCxFQUFFLFNBQVMsRUFBRSxDQUFDLEdBQy9ELENBQUMsbUJBQW1CLEVBQUUsS0FBSyxDQUFDLENBQUM7RUFFbkM7RUFDQSxJQUFJLGdCQUFnQixTQUFTO0lBQzNCLE1BQU0sSUFBSSxNQUFNLENBQUMsNkNBQTZDLEVBQUUsT0FBTyxDQUFDLENBQUM7RUFDM0U7RUFDQSxPQUFPLEdBQUcsUUFBUSxDQUFDLEVBQUUsbUJBQW1CLENBQUMsRUFBRSxPQUFPLENBQUMsRUFBRSxVQUFVO0FBQ2pFO0FBRUEscUVBQXFFLEdBQ3JFLGVBQWUsaUJBQ2IsSUFBWSxFQUNaLFFBQWdCO0VBRWhCLE1BQU0sU0FBUyxNQUFNLGNBQ25CO0lBQUM7SUFBYTtHQUF3QixFQUN0QztJQUFFLEtBQUs7RUFBSztFQUVkLElBQUksQ0FBQyxPQUFPLEVBQUUsSUFBSSxPQUFPLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRyxPQUFPO0VBQ2xELElBQUksT0FBTyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksT0FBTyxRQUFRLE9BQU87RUFFbEQsMEVBQTBFO0VBQzFFLHFFQUFxRTtFQUNyRSxNQUFNLFlBQVksTUFBTSxjQUN0QjtJQUFDO0lBQWE7SUFBMEI7R0FBbUIsRUFDM0Q7SUFBRSxLQUFLO0VBQUs7RUFFZCxJQUFJLENBQUMsVUFBVSxFQUFFLElBQUksVUFBVSxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUcsT0FBTztFQUN4RCxNQUFNLFdBQVcsTUFBTSxlQUFlLEdBQUcsU0FBUyxLQUFLLENBQUM7RUFDeEQsTUFBTSxTQUFTLE1BQU0sZUFBZSxVQUFVLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSTtFQUMvRCxPQUFPLFdBQVc7QUFDcEI7QUFFQSxxRUFBcUUsR0FDckUsZUFBZSxlQUFlLElBQVk7RUFDeEMsSUFBSTtJQUNGLE9BQU8sTUFBTSxLQUFLLFFBQVEsQ0FBQztFQUM3QixFQUFFLE9BQU07SUFDTixPQUFPLEtBQUssT0FBTyxDQUFDLFFBQVE7RUFDOUI7QUFDRjtBQUVBOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBQ0QsT0FBTyxlQUFlLG1CQUNwQixPQUE0QjtFQUU1QixNQUFNLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLEdBQUc7RUFFNUMsSUFBSTtFQUNKLElBQUk7SUFDRixPQUFPLGlCQUFpQixTQUFTLE1BQU07RUFDekMsRUFBRSxPQUFPLEtBQUs7SUFDWixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sZUFBZSxRQUFRLE1BQU0sSUFBSSxNQUFNLE9BQU87SUFDdkQ7RUFDRjtFQUVBLHFFQUFxRTtFQUNyRSx5RUFBeUU7RUFDekUsMEVBQTBFO0VBQzFFLHdFQUF3RTtFQUN4RSwwRUFBMEU7RUFDMUUsc0VBQXNFO0VBQ3RFLE1BQU0sVUFBVSxNQUFNLDhCQUE4QjtJQUFFLEtBQUs7RUFBUztFQUNwRSxJQUFJLENBQUMsUUFBUSxFQUFFLEVBQUU7SUFDZixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUNULENBQUMsc0NBQXNDLEVBQUUsS0FBSyxpQkFBaUIsQ0FBQyxHQUM5RCxHQUFHLE9BQU8sV0FBVyxFQUFFLFFBQVEsS0FBSyxDQUFDLE9BQU8sRUFBRTtJQUVwRDtFQUNGO0VBRUEsSUFBSSxNQUFNLGlCQUFpQixNQUFNLFdBQVc7SUFDMUMsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO0lBQUs7RUFDakM7RUFFQSxtRUFBbUU7RUFDbkUseURBQXlEO0VBQ3pELE1BQU0sY0FBYztJQUFDO0lBQVk7R0FBUSxFQUFFO0lBQUUsS0FBSztFQUFTO0VBRTNELElBQUk7SUFDRixNQUFNLEtBQUssS0FBSyxDQUFDLEtBQUssS0FBSyxDQUFDLEdBQUcsS0FBSyxXQUFXLENBQUMsT0FBTztNQUFFLFdBQVc7SUFBSztFQUMzRSxFQUFFLE9BQU8sS0FBSztJQUNaLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxJQUFJLE1BQ1QsQ0FBQyw0Q0FBNEMsRUFBRSxLQUFLLEVBQUUsRUFDcEQsZUFBZSxRQUFRLElBQUksT0FBTyxHQUFHLE9BQU8sTUFDNUM7SUFFTjtFQUNGO0VBRUEsSUFBSSxRQUFRLE1BQU0sY0FDaEI7SUFBQztJQUFZO0lBQU87SUFBWTtJQUFXO0lBQU07R0FBTyxFQUN4RDtJQUFFLEtBQUs7RUFBUztFQUdsQiwwRUFBMEU7RUFDMUUsb0VBQW9FO0VBQ3BFLHlFQUF5RTtFQUN6RSxtRUFBbUU7RUFDbkUsb0VBQW9FO0VBQ3BFLDBCQUEwQjtFQUMxQixFQUFFO0VBQ0YsdUVBQXVFO0VBQ3ZFLDRFQUE0RTtFQUM1RSwwRUFBMEU7RUFDMUUsNEVBQTRFO0VBQzVFLDJFQUEyRTtFQUMzRSw0RUFBNEU7RUFDNUUsK0NBQStDO0VBQy9DLElBQUksb0JBQW9CLFFBQVE7SUFDOUIsSUFBSTtNQUNGLE1BQU0sS0FBSyxNQUFNLENBQUMsTUFBTTtRQUFFLFdBQVc7TUFBSztJQUM1QyxFQUFFLE9BQU8sS0FBSztNQUNaLE9BQU87UUFDTCxJQUFJO1FBQ0osT0FBTyxJQUFJLE1BQ1QsQ0FBQyxtQkFBbUIsRUFBRSxPQUFPLGNBQWMsRUFBRSxLQUFLLElBQUksRUFBRSxLQUFLLE1BQU0sQ0FBQyxHQUNsRSxDQUFDLDZDQUE2QyxFQUFFLFNBQVMsTUFBTSxDQUFDLEdBQ2hFLENBQUMseUJBQXlCLEVBQ3hCLGVBQWUsUUFBUSxJQUFJLE9BQU8sR0FBRyxPQUFPLE1BQzVDO01BRVI7SUFDRjtJQUNBLE1BQU0sY0FBYztNQUFDO01BQVk7S0FBUSxFQUFFO01BQUUsS0FBSztJQUFTO0lBQzNELFFBQVEsTUFBTSxjQUNaO01BQUM7TUFBWTtNQUFPO01BQVk7TUFBVztNQUFNO0tBQU8sRUFDeEQ7TUFBRSxLQUFLO0lBQVM7RUFFcEI7RUFFQSwwRUFBMEU7RUFDMUUseUVBQXlFO0VBQ3pFLHdFQUF3RTtFQUN4RSx5REFBeUQ7RUFDekQsdUVBQXVFO0VBQ3ZFLHlFQUF5RTtFQUN6RSx5RUFBeUU7RUFDekUsc0VBQXNFO0VBQ3RFLDBEQUEwRDtFQUMxRCxJQUFJLHVCQUF1QixRQUFRO0lBQ2pDLE1BQU0sU0FBUyxNQUFNLGlCQUFpQjtJQUN0QyxJQUFJLENBQUMsT0FBTyxFQUFFLEVBQUU7TUFDZCxPQUFPO1FBQ0wsSUFBSTtRQUNKLE9BQU8sSUFBSSxNQUNULENBQUMsbUJBQW1CLEVBQUUsT0FBTyxjQUFjLEVBQUUsS0FBSyxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUMsR0FDOUQsQ0FBQyxpREFBaUQsQ0FBQyxHQUNuRCxHQUFHLE9BQU8sS0FBSyxDQUFDLE9BQU8sRUFBRTtNQUUvQjtJQUNGO0lBQ0EsUUFBUSxNQUFNLGNBQ1o7TUFBQztNQUFZO01BQU87TUFBWTtNQUFXO01BQU07S0FBTyxFQUN4RDtNQUFFLEtBQUs7SUFBUztFQUVwQjtFQUVBLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSSxNQUFNLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztJQUN2QyxPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUNULENBQUMsbUJBQW1CLEVBQUUsT0FBTyxjQUFjLEVBQUUsS0FBSyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQzdELHlCQUF5QixRQUN6QjtJQUVOO0VBQ0Y7RUFFQSxPQUFPO0lBQUUsSUFBSTtJQUFNLE9BQU87RUFBSztBQUNqQztBQUtBOzs7Ozs7O0NBT0MsR0FDRCxTQUFTLG9CQUFvQixLQUF5QjtFQUNwRCxJQUFJLENBQUMsTUFBTSxFQUFFLElBQUksTUFBTSxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUcsT0FBTztFQUNoRCxPQUFPLDBCQUEwQixJQUFJLENBQUMsTUFBTSxLQUFLLENBQUMsTUFBTTtBQUMxRDtBQUVBOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsT0FBTyxTQUFTLHlCQUF5QixLQUF5QjtFQUNoRSxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUUsT0FBTyxNQUFNLEtBQUssQ0FBQyxPQUFPO0VBQ3pDLE1BQU0sYUFBYSxNQUFNLEtBQUssQ0FBQyxNQUFNLENBQ2xDLEtBQUssQ0FBQyxNQUNOLE1BQU0sQ0FBQyxDQUFDLE9BQVMsQ0FBQywyQkFBMkIsSUFBSSxDQUFDLE9BQ2xELElBQUksQ0FBQyxNQUNMLElBQUk7RUFDUCxPQUFPLGNBQWMsQ0FBQyxLQUFLLEVBQUUsTUFBTSxLQUFLLENBQUMsSUFBSSxFQUFFO0FBQ2pEO0FBRUE7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLFNBQVMsdUJBQXVCLE9BQTJCO0VBQ2hFLE1BQU0sU0FBUyx5QkFBeUI7RUFDeEMsT0FBTyxPQUFPLFFBQVEsQ0FBQyw4QkFDckIsT0FBTyxRQUFRLENBQUM7QUFDcEI7QUFFQTs7Ozs7Ozs7Ozs7O0NBWUMsR0FDRCxPQUFPLGVBQWUsaUJBQ3BCLFFBQWdCO0VBRWhCLE1BQU0sYUFBYSxNQUFNLGNBQ3ZCO0lBQUM7SUFBZ0I7R0FBMkIsRUFDNUM7SUFBRSxLQUFLO0VBQVM7RUFFbEIsSUFBSSxDQUFDLFdBQVcsRUFBRSxJQUFJLFdBQVcsS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHO0lBQ2pELE1BQU0sU0FBUyxXQUFXLEVBQUUsR0FDeEIsV0FBVyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxDQUFDLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQyxJQUFJLEVBQUUsR0FDakUsV0FBVyxLQUFLLENBQUMsT0FBTztJQUM1QixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUFNLENBQUMsc0JBQXNCLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDckQ7RUFDRjtFQUNBLE1BQU0sU0FBUyxXQUFXLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSTtFQUMzQyxNQUFNLFNBQVMsT0FBTyxPQUFPLENBQUMsNEJBQTRCO0VBQzFELElBQUksV0FBVyxVQUFVLFdBQVcsSUFBSTtJQUN0QyxPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUFNLENBQUMseUJBQXlCLEVBQUUsT0FBTyxlQUFlLENBQUM7SUFDdEU7RUFDRjtFQUVBLE1BQU0sUUFBUSxNQUFNLGNBQ2xCO0lBQUM7SUFBWTtJQUFZO0lBQVcsQ0FBQyxXQUFXLEVBQUUsUUFBUTtHQUFDLEVBQzNEO0lBQUUsS0FBSztFQUFTO0VBRWxCLElBQUksTUFBTSxFQUFFLElBQUksTUFBTSxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUc7SUFDdEMsTUFBTSxVQUFVLE1BQU0sY0FDcEI7TUFBQztNQUFnQjtNQUFRLENBQUMsV0FBVyxFQUFFLFFBQVE7S0FBQyxFQUNoRDtNQUFFLEtBQUs7SUFBUztJQUVsQixJQUFJLENBQUMsUUFBUSxFQUFFLElBQUksUUFBUSxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUc7TUFDM0MsTUFBTSxTQUFTLFFBQVEsRUFBRSxHQUNyQixRQUFRLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNLENBQUMsS0FBSyxFQUFFLFFBQVEsS0FBSyxDQUFDLElBQUksRUFBRSxHQUMzRCxRQUFRLEtBQUssQ0FBQyxPQUFPO01BQ3pCLE9BQU87UUFDTCxJQUFJO1FBQ0osT0FBTyxJQUFJLE1BQU0sQ0FBQywwQkFBMEIsRUFBRSxPQUFPLEVBQUUsRUFBRSxPQUFPLENBQUMsQ0FBQztNQUNwRTtJQUNGO0lBQ0EsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO0lBQVU7RUFDdEM7RUFFQSxNQUFNLFlBQVksTUFBTSxjQUN0QjtJQUFDO0lBQVk7SUFBTTtJQUFRLENBQUMsT0FBTyxFQUFFLFFBQVE7R0FBQyxFQUM5QztJQUFFLEtBQUs7RUFBUztFQUVsQixJQUFJLENBQUMsVUFBVSxFQUFFLElBQUksVUFBVSxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUc7SUFDL0MsTUFBTSxTQUFTLFVBQVUsRUFBRSxHQUN2QixVQUFVLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNLENBQUMsS0FBSyxFQUFFLFVBQVUsS0FBSyxDQUFDLElBQUksRUFBRSxHQUMvRCxVQUFVLEtBQUssQ0FBQyxPQUFPO0lBQzNCLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxJQUFJLE1BQU0sQ0FBQyxtQkFBbUIsRUFBRSxPQUFPLEVBQUUsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUM3RDtFQUNGO0VBQ0EsT0FBTztJQUFFLElBQUk7SUFBTSxPQUFPO0VBQVU7QUFDdEM7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW1CQyxHQUNELE9BQU8sZUFBZSx1QkFDcEIsSUFBWSxFQUNaLE1BQTRCLGFBQWE7RUFFekMsTUFBTSxXQUFXLE1BQU0sSUFBSTtJQUFDO0lBQVk7R0FBVyxFQUFFO0lBQUUsS0FBSztFQUFLO0VBQ2pFLE9BQU8sU0FBUyxFQUFFLElBQUksU0FBUyxLQUFLLENBQUMsSUFBSSxLQUFLO0FBQ2hEO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBMEJDLEdBQ0QsT0FBTyxTQUFTLDBCQUEwQixNQUFjO0VBQ3RELE1BQU0sT0FBTyxpQkFBaUI7RUFDOUIsSUFBSSxTQUFTLFdBQVcsT0FBTztFQUUvQix3RUFBd0U7RUFDeEUseUVBQXlFO0VBQ3pFLE1BQU0sV0FBVyxLQUFLLEtBQUssQ0FBQyxLQUFLLE1BQU0sQ0FBQyxDQUFDLFVBQVksWUFBWTtFQUNqRSxJQUFJLFNBQVMsTUFBTSxHQUFHLEdBQUcsT0FBTztFQUNoQyxPQUFPLFFBQVEsQ0FBQyxTQUFTLE1BQU0sR0FBRyxFQUFFLEtBQUsscUJBQ3JDLE9BQ0E7QUFDTjtBQUVBOzs7Ozs7Q0FNQyxHQUNELFNBQVMsaUJBQWlCLE1BQWM7RUFDdEMsT0FBTyxPQUFPLEtBQUssQ0FBQyw2Q0FBNkMsQ0FBQyxFQUFFO0FBQ3RFO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FzQkMsR0FDRCxPQUFPLGVBQWUsMEJBQ3BCLE1BQWMsRUFDZCxHQUF1QixFQUN2QixNQUE0QixhQUFhO0VBRXpDLE1BQU0sT0FBTyxpQkFBaUI7RUFDOUIsSUFBSSxTQUFTLFdBQVcsT0FBTztFQUUvQixrRUFBa0U7RUFDbEUsa0RBQWtEO0VBQ2xELE1BQU0sVUFBVSxNQUFNLElBQUk7SUFBQztJQUFZO0lBQVE7R0FBYyxFQUFFO0lBQUU7RUFBSTtFQUNyRSxJQUFJLENBQUMsUUFBUSxFQUFFLElBQUksUUFBUSxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUcsT0FBTztFQUNwRCxNQUFNLE9BQU8sUUFBUSxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLFFBQ2xELE1BQU0sVUFBVSxDQUFDO0VBRW5CLElBQUksU0FBUyxXQUFXLE9BQU87RUFDL0IsTUFBTSxVQUFVLEtBQUssS0FBSyxDQUFDLFlBQVksTUFBTTtFQUU3QyxNQUFNLFVBQVUsTUFBTSxlQUFlLFVBQVUsTUFBTSxlQUFlO0VBQ3BFLE9BQU8sVUFBVSxPQUFPO0FBQzFCIn0=
// denoCacheMetadata=1027165897312437834,14954566808472769604