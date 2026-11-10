/**
 * Git pull operations with conflict detection (Issue #912).
 *
 * Provides functions for syncing feature branches with default branches,
 * syncing milestone branches, and pulling with conflict handling.
 *
 * Migrated from worker/shared/git_operations.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand, runGitCommandChecked } from "./git_timeout.ts";
import { cleanWorkingTree } from "./ignored_path_clean.ts";
import { spawnGh } from "./gh_spawn.ts";
import { isRuleViolationPush, raiseMilestoneSyncPr, syncPrLandingNote } from "./milestone_sync_pr.ts";
import { restoreClosedMilestoneRoute } from "./milestone_route_restore.ts";
import { ensureDefaultBranchCurrent } from "./git_push.ts";
import { assertSafeGitRef, assertSafeRefComponent, buildCheckoutArgs, buildFetchArgs, buildPushArgs } from "./git_ref_args.ts";
import { checkoutPrBranchAtRemoteHead } from "./pr_branch_checkout.ts";
import { assertAdoptedMergeIsSafe, describeGitFailure, readMergeCommitState } from "./milestone_merge_state.ts";
import { requireDiskSpaceForGitOperation } from "./disk_space.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import { endHandlerLandingStep } from "./handler_watchdog.ts";
import { ensureHistoryDepth } from "./git_history.ts";
import { mergeWithUnshallowRetry } from "./git_merge_unshallow_retry.ts";
import { createConflictStageTimer, currentHost, formatStageTimings } from "./conflict_stage_timer.ts";
import { summariseGateRepair } from "./milestone_sync_conflict.ts";
import { describeRepairEscalation, runGateWithRepair } from "./milestone_gate_repair.ts";
import { analyseConflictedFile, buildResolutionCommitMessage, describeDecisionRung, MilestoneConflictEscalation, planConflictResolution, SYNC_UNCHECKED_NOTE } from "./milestone_conflict_triage.ts";
import { climbConflictLadder, hasConflictMarkers, listUnmergedPaths } from "./milestone_conflict_ladder.ts";
import { applyConflictPlan, readConflictedSides, readMergeBase, readTestEvidence, unionMergeConflictedFile } from "./milestone_conflict_git.ts";
import { verifyResolvedTree } from "./milestone_resolution_gate.ts";
import { checkMergedTree, mergeGateFailureError } from "./milestone_merge_gate.ts";
/**
 * Describe a failed `git checkout` with git's own output (Issues #49, #335).
 *
 * A checkout failure that only says which branch failed cannot be acted on:
 * Issue #335 saw the same branch log 65 identical warnings across days with
 * no diagnosis in any of them. Git's output *is* the diagnosis — a missing
 * ref, a dirty tree, a lock file — so it travels with the error, stdout
 * included (Issue #1964).
 *
 * @param branchName - The branch that could not be checked out
 * @param result - The `runGitCommand` result for the failed checkout
 * @returns An error naming the branch and git's own failure
 */ function checkoutFailureError(branchName, result) {
  return new Error(`Failed to checkout branch '${branchName}': ${describeGitFailure(result, {
    lines: 6,
    from: "head"
  })}`);
}
/**
 * Sync a feature branch with the latest default branch (Issues #230, #2807).
 *
 * Merges the published default branch (`origin/<default>`) into the feature
 * branch — never a rebase — so a PR under review keeps its commits and the
 * review comments anchored to them. A conflicting merge is aborted and
 * reported as {@link prBranchConflictError}, the branch left exactly as it
 * was for the conflict ladder; nothing here pushes.
 *
 * @param branchName - The feature branch to sync
 * @param defaultBranch - The default branch to sync with
 * @param options - Git command options
 * @returns Result indicating success or failure
 */ export async function syncFeatureBranchWithDefault(branchName, defaultBranch, options = {}) {
  // Refuse an option-injecting ref before any git runs (Issue #12).
  try {
    assertSafeGitRef(branchName, "feature branch name");
    assertSafeRefComponent(defaultBranch, "default branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
  // Pre-check disk space before fetch/merge (Issue #1174)
  if (options.cwd) {
    const spaceCheck = await requireDiskSpaceForGitOperation(options.cwd, `git fetch origin ${branchName}`, OPERATIONAL_DEFAULTS.minDiskSpaceMb);
    if (!spaceCheck.ok) {
      return {
        ok: false,
        error: spaceCheck.error
      };
    }
  }
  // First, ensure the local default branch is current
  await ensureDefaultBranchCurrent(defaultBranch, options);
  // Check if we're already on the feature branch
  const currentBranchResult = await runGitCommand([
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ], options);
  const currentBranch = currentBranchResult.ok ? currentBranchResult.value.stdout.trim() : "";
  if (currentBranch !== branchName) {
    const checkoutResult = await runGitCommand(buildCheckoutArgs(branchName), options);
    if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
      // Surface git's own stderr (Issue #49): a dirty tree or a missing ref is
      // the whole diagnosis, and the old error discarded it.
      return {
        ok: false,
        error: checkoutFailureError(branchName, checkoutResult)
      };
    }
  }
  // Merge the published target (Issue #2807): the local default branch may
  // be held behind by another lane's worktree (Issue #394).
  const baseRef = await resolvePublishedBaseRef(defaultBranch, options);
  // Ensure enough history is present for range/merge ops on a shallow clone (Issue #1502)
  await ensureHistoryDepth([
    "HEAD",
    baseRef
  ], options);
  // Check if a merge is needed
  const behindResult = await runGitCommand([
    "rev-list",
    "--count",
    `HEAD..${baseRef}`
  ], options);
  const behindCount = behindResult.ok && behindResult.value.code === 0 ? parseInt(behindResult.value.stdout.trim(), 10) || 0 : 0;
  if (behindCount === 0) {
    return {
      ok: true,
      value: `Feature branch '${branchName}' is already up to date with '${defaultBranch}'`
    };
  }
  const merged = await mergeBaseIntoBranch(branchName, defaultBranch, baseRef, options);
  if (!merged.ok) {
    // The PR processors run on regardless, so the refusal is logged here.
    console.error(`[sync] ${merged.error.message}`);
    return merged;
  }
  return {
    ok: true,
    value: `Successfully synced '${branchName}' with '${defaultBranch}' (${behindCount} commit(s) merged in)`
  };
}
/**
 * Push the synced milestone branch, falling back to a pull request when a
 * repository rule refuses the push (Issue #589).
 *
 * The gate that refuses the push is the same one that makes a PR into that
 * branch auto-mergeable (Issue #586), so the fallback lands the identical
 * merge unattended rather than failing the sync. A repository whose milestone
 * branches are ungated never reaches the fallback.
 *
 * A push that fails for anything other than a repository rule is a **failed
 * sync** (Issue #1964): it used to return an empty note, so the branch was
 * logged as synced, counted as synced and recorded against the tip it never
 * reached — which is the cadence guard then skipping it every cycle.
 *
 * @returns A note to append to the sync's outcome, empty on the ordinary path.
 */ async function pushSyncedMilestoneBranch(milestoneBranch, defaultBranch, options, repo) {
  const push = await runGitCommand([
    "push",
    "origin",
    milestoneBranch
  ], options);
  if (push.ok && push.value.code === 0) return {
    ok: true,
    value: ""
  };
  // Git's own account of the refusal, stdout included (Issue #1964).
  const stderr = push.ok ? push.value.stderr : push.error.message;
  if (!isRuleViolationPush(stderr)) {
    return {
      ok: false,
      error: new Error(`Failed to push '${milestoneBranch}' to origin, so the merge is ` + `local only (Issue #1964): ${describeGitFailure(push)}`)
    };
  }
  if (!repo) {
    return {
      ok: true,
      value: `PUSH REFUSED by a repository rule and no repository was named, ` + `so no sync PR could be raised (Issue #589) — `
    };
  }
  const gh = async (args)=>{
    const result = await spawnGh(args);
    if (!result.success) {
      throw new Error(result.stderr.trim() || `gh exited ${result.code}`);
    }
    return result.stdout;
  };
  // Issue #4175: do not open a sync PR into a route that is still closed.
  // An open milestone is restored first (a fresh rollup when the branch is
  // ahead). A closed milestone, or one with no open work, is left alone.
  const restored = await restoreClosedMilestoneRoute({
    repo,
    milestoneBranch,
    defaultBranch,
    ghCommandFn: gh
  });
  if (restored.action === "failed") {
    return {
      ok: false,
      error: new Error(`sync PR not opened into '${milestoneBranch}': the route could not be restored (${restored.reason})`)
    };
  }
  // `waiting` has no open rollup either: the branch is not ahead, so a
  // sync PR would sit on a closed route (the #4100 case). Skip it until a
  // rollup is open.
  if (restored.action === "merge-via-gate") {
    return {
      ok: true,
      value: `sync PR not opened into '${milestoneBranch}': the branch is not ahead of ${defaultBranch}, so no rollup is open yet (Issue #4175) — `
    };
  }
  if (restored.action === "left-closed" || restored.action === "waiting") {
    return {
      ok: true,
      value: `sync PR not opened into '${milestoneBranch}': ${restored.detail} (Issue #4175) — `
    };
  }
  const raised = await raiseMilestoneSyncPr(repo, milestoneBranch, defaultBranch, {
    git: async (args)=>{
      const result = await runGitCommand(args, options);
      return result.ok ? {
        code: result.value.code,
        stderr: result.value.stderr,
        stdout: result.value.stdout
      } : {
        code: 1,
        stderr: result.error.message,
        stdout: ""
      };
    },
    gh
  });
  if (!raised.ok) {
    return {
      ok: true,
      value: `PUSH REFUSED by a repository rule and the sync PR could not be ` + `raised: ${raised.error.message} (Issue #589) — `
    };
  }
  return {
    ok: true,
    value: syncPrLandingNote(raised.value)
  };
}
/**
 * Whether the remote milestone branch already contains the default tip —
 * a sibling host landed this sync while this one was resolving it
 * (Issue #2030).
 *
 * Read right before the gate and push: the pre-merge fetch cannot see a
 * sync that landed during the agent rung. When it has, the local merge is
 * discarded for the remote's, and the outcome is a success with no push —
 * the branch is synced, which is all the sync ever wanted. A read that
 * fails answers `false`: the push that follows is what then refuses a moved
 * branch, exactly as before.
 */ async function alreadySyncedElsewhere(milestoneBranch, defaultBranch, options) {
  const fetched = await runGitCommand(buildFetchArgs("origin", milestoneBranch), options);
  if (!fetched.ok || fetched.value.code !== 0) return false;
  // The tip this sync merged is the local default branch, kept current by
  // `ensureDefaultBranchCurrent`; a clone without a local one (a bare-origin
  // test fixture, a narrow checkout) falls back to the remote-tracking ref.
  const local = await runGitCommand([
    "rev-parse",
    "--verify",
    "--quiet",
    `${defaultBranch}^{commit}`
  ], options);
  const defaultRef = local.ok && local.value.code === 0 ? defaultBranch : `refs/remotes/origin/${defaultBranch}`;
  const contains = await runGitCommand([
    "merge-base",
    "--is-ancestor",
    defaultRef,
    `refs/remotes/origin/${milestoneBranch}`
  ], options);
  return contains.ok && contains.value.code === 0;
}
/** Adopt the remote's already-synced branch in place of the local merge. */ async function adoptRemoteSync(milestoneBranch, defaultBranch, options) {
  const reset = await runGitCommand([
    "reset",
    "--hard",
    `refs/remotes/origin/${milestoneBranch}`
  ], options);
  if (!reset.ok || reset.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`'${milestoneBranch}' was synced with '${defaultBranch}' by another ` + `host meanwhile, but the local merge could not be replaced by it: ${describeGitFailure(reset)} (Issue #2030)`)
    };
  }
  return {
    ok: true,
    value: {
      message: `ALREADY SYNCED by another host while this one was resolving ` + `— local merge discarded, remote '${milestoneBranch}' adopted, ` + `nothing pushed (Issue #2030)`
    }
  };
}
/**
 * Type-check the merged tree, then push it — or refuse (Issue #974).
 *
 * Git reporting no conflict says only that both sides were internally
 * consistent; three merges that passed that bar deleted live wiring and were
 * pushed unchecked, because `milestone/*` has no required checks to catch the
 * result downstream. So the merge commit is judged before it is published: it
 * is pushed when the repository's own type check passes, and reset away with
 * a typed refusal when it does not.
 *
 * @param preMergeSha - Where the branch stood before the merge, so a rejected
 *   merge can be undone exactly
 * @returns The note to append to the sync outcome, or the gate's refusal
 */ async function gateThenPushMilestoneBranch(milestoneBranch, defaultBranch, options, repo, mergeGate, preMergeSha) {
  const outcome = await mergeGate(options.cwd ?? ".");
  if (outcome.status === "failed") {
    // The caller refuses to merge at all without a pre-merge SHA, so there is
    // always one to roll back to here.
    let resetNote = "";
    const reset = await runGitCommand([
      "reset",
      "--hard",
      preMergeSha
    ], options);
    if (!reset.ok || reset.value.code !== 0) {
      // stdout counts as much as stderr here (Issue #1964).
      resetNote = ` — and the local merge could NOT be reset to ` + `${preMergeSha}: ${describeGitFailure(reset)}`;
    }
    return {
      ok: false,
      error: mergeGateFailureError(milestoneBranch, defaultBranch, {
        ...outcome,
        detail: `${outcome.detail}${resetNote}`
      })
    };
  }
  const pushNote = await pushSyncedMilestoneBranch(milestoneBranch, defaultBranch, options, repo);
  // A push that did not happen is not a sync (Issue #1964).
  if (!pushNote.ok) return pushNote;
  // Say when nothing verified the tree, rather than let an unchecked push
  // read exactly like a checked one.
  // A passed tree whose Deno task could not fetch its remote modules (Issue
  // #4422) is pushed, but that task did not run: the note says so, and the
  // detail already carries any cargo note.
  // The labels are SYNC_UNCHECKED_NOTE's, which the resolution commit message
  // names one by one (Issue #4441).
  const n = SYNC_UNCHECKED_NOTE;
  const gateNote = outcome.status === "skipped" ? `${n.ungated}: ${outcome.detail} (Issue #974) — ` : outcome.checkLeftToCi ? `${n.checkLeftToCi}: ${outcome.detail} (Issue #4441) — ` : outcome.suiteLeftToCi ? `${n.suiteLeftToCi}: ${outcome.detail} (Issue #4422) — ` : outcome.cargoSkipped ? `${n.cargoSkipped}: ${outcome.detail} (Issue #4326) — ` : "";
  return {
    ok: true,
    value: `${gateNote}${pushNote.value}`
  };
}
/** Resolve a ref to its commit SHA; empty string when it cannot be read. */ async function readRef(ref, options) {
  const result = await runGitCommand([
    "rev-parse",
    ref
  ], options);
  return result.ok && result.value.code === 0 ? result.value.stdout.trim() : "";
}
/**
 * Sync a milestone branch with the default branch (Issue #422, #605).
 *
 * Uses merge (not rebase) to preserve milestone commit history. The merge is
 * type-checked before it is pushed (Issue #974) — see
 * {@link gateThenPushMilestoneBranch}.
 *
 * A merge that conflicts is triaged rather than resolved towards the default
 * branch on sight (Issue #1559). Where an automatic rule can decide the
 * conflict — the same fix landed twice, or one side keeps every line of the
 * other — the decision is applied, recorded on the merge commit, verified
 * against the repository's own check, manifest check and unit suite, and only
 * then pushed. A merge-only sync (Issue #4326) of a cargo-only tree pushes it
 * unverified with the `UNGATED:` note instead, leaving the cargo build to the
 * milestone PR's CI. A Deno-only tree and a mixed tree keep their Deno checks
 * and suites and are rolled back when red. A mixed tree whose Deno half
 * passed carries a `CARGO SKIPPED:` note, so the report does not claim the
 * cargo half passed. A resolved tree whose Deno task could not fetch its
 * remote modules (Issue #4422) carries a `TESTS LEFT TO CI:` note naming that
 * task (or a `CHECK LEFT TO CI:` note whose detail names it, when the type
 * check was left to CI too), so the report does not claim it passed. A resolved tree whose Issue
 * #974 type check could not fetch its remote modules carries a
 * `CHECK LEFT TO CI:` note (Issue #4441) for the same reason.
 *
 * What the triage cannot decide climbs the rest of the ladder the PR pass
 * climbs (Issue #1777): the deterministic dependency rules, then the
 * resolution agent, each over the paths still left. Only a file every rung
 * leaves undecided aborts the merge, and the refusal then carries both sides
 * prepared for a human, naming the rung that failed. Either way the conflict
 * travels back with the outcome (Issue #1558): the files that collided, the
 * commit each side stood at, and the rung that settled each file.
 *
 * Before any of that, the local default branch ref is both refreshed AND
 * positively verified against `origin/<defaultBranch>` (Issue #2896):
 * `ensureDefaultBranchCurrent()` ignores the result of its own `branch -f` /
 * `reset --hard`, so its success does not prove the ref actually moved — a
 * stale ref (e.g. because another worktree holds the branch, Issue #394)
 * would otherwise be merged in silently. The shallow-clone deepen
 * (`ensureHistoryDepth()`) is checked the same way: a deepen that could not
 * reach the merge base is refused loudly rather than left to surface later as
 * an opaque "unrelated histories" merge failure. Should the merge itself
 * still refuse with "unrelated histories" on a shallow clone, it is
 * unshallowed and retried exactly once — see
 * {@link mergeWithUnshallowRetry} — before falling through to the ordinary
 * conflict / non-conflict handling below.
 *
 * @param milestoneBranch - The milestone branch name
 * @param defaultBranch - The default branch to sync from
 * @param options - Git command options
 * @returns Result carrying the summary, and the conflict when there was one
 */ export async function syncMilestoneBranchWithDefault(...args) {
  try {
    return await syncMilestoneBranchWithDefaultBody(...args);
  } finally{
    // The conflict agent marks commit/push as still landing (Issue #4173).
    // Clear it here so a later wedge in this same handler is not treated as
    // that landing. A no-op when no step was begun.
    endHandlerLandingStep();
  }
}
async function syncMilestoneBranchWithDefaultBody(milestoneBranch, defaultBranch, options = {}, /**
   * `owner/repo`, needed only to raise a sync PR when a repository rule
   * refuses the push (Issue #589). Absent keeps the previous behaviour and
   * says so in the outcome rather than failing silently.
   */ repo, /**
   * The gate the merged tree must pass before it is pushed (Issue #974).
   * Defaults to the repository's own type check; tests inject a verdict.
   */ mergeGate = checkMergedTree, /**
   * The gate a merge whose conflicts the worker resolved itself must pass
   * (Issue #1559). Stricter than the type check above, because choosing a
   * side compiles perfectly and still drops the other side's behaviour — so
   * the repository's own check, manifest check and unit suite all run.
   *
   * A caller that injected its own `mergeGate` gets that gate here too: a
   * sync whose verification is stubbed stays stubbed on both paths.
   */ resolutionGate = mergeGate === checkMergedTree ? verifyResolvedTree : mergeGate, /**
   * The resolution agent, the ladder's last rung before a human
   * (Issue #1777). Injected so a test needs no model, and so a caller that
   * cannot run one simply stops after the dependency rules rather than
   * pretending the conflict was decided.
   */ agentFn, /** Logger for the ladder's diagnostics; absent logs nothing. */ logger, /**
   * The clock the stage timings are measured against (Issue #2308). Injected
   * so a test can assert which stage a run's seconds landed in without ever
   * reading a wall clock.
   */ nowMsFn = ()=>Date.now()) {
  // Refuse an option-injecting ref before any git runs (Issue #12). The
  // default branch used to be repo-derived (setupRepo read it from
  // `.vibe_default_branch` inside the clone, Issue #1269; it now lives in
  // `.git/vibe/default_branch`, Issue #1652) and reaches
  // `git merge <defaultBranch>` below as a bare positional, which the ref-argv
  // gate does not cover — so it is checked here, as the feature-branch sync
  // already does.
  try {
    assertSafeGitRef(milestoneBranch, "milestone branch name");
    assertSafeRefComponent(defaultBranch, "default branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
  // Pre-check disk space before pull/merge (Issue #1174)
  if (options.cwd) {
    const spaceCheck = await requireDiskSpaceForGitOperation(options.cwd, `git pull origin ${milestoneBranch}`, OPERATIONAL_DEFAULTS.minDiskSpaceMb);
    if (!spaceCheck.ok) {
      return {
        ok: false,
        error: spaceCheck.error
      };
    }
  }
  // Ensure the local default branch is current (Issue #2896). A stale local
  // ref merged into the milestone branch silently carries whatever commit
  // happened to be sitting there — possibly days behind origin, and possibly
  // even an ancestor the milestone branch cannot find a merge base for in a
  // shallow clone, which git then refuses as "unrelated histories" further
  // down. `ensureDefaultBranchCurrent` itself ignores the result of its own
  // `git branch -f` / `reset --hard` (Issue #394: `branch -f` is refused when
  // another worktree holds the branch), so its ok:true is not proof the ref
  // actually moved — hence the positive check below, not just the `!ok` one.
  const defaultCurrent = await ensureDefaultBranchCurrent(defaultBranch, options);
  if (!defaultCurrent.ok) {
    return {
      ok: false,
      error: new Error(`Refusing to merge '${defaultBranch}' into '${milestoneBranch}': ` + `the local '${defaultBranch}' could not be made current with ` + `origin, so the merge would carry a stale ref (Issue #2896): ${defaultCurrent.error.message}`)
    };
  }
  const localDefaultSha = await readRef(defaultBranch, options);
  const originDefaultSha = await readRef(`origin/${defaultBranch}`, options);
  if (!localDefaultSha || !originDefaultSha || localDefaultSha !== originDefaultSha) {
    return {
      ok: false,
      error: new Error(`Refusing to merge '${defaultBranch}' into '${milestoneBranch}': ` + `the local '${defaultBranch}' ref could not be moved to match ` + `origin (local ${localDefaultSha ? localDefaultSha.slice(0, 7) : "<unreadable>"}` + ` vs origin ${originDefaultSha ? originDefaultSha.slice(0, 7) : "<unreadable>"}), so the merge would carry a stale ref (Issue #2896)`)
    };
  }
  // What the sync discarded on its way in, reported with its outcome
  // (Issue #568). Empty on the ordinary path.
  let dirtyNote = "";
  // Check out the milestone branch
  const currentBranchResult = await runGitCommand([
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ], options);
  const currentBranch = currentBranchResult.ok ? currentBranchResult.value.stdout.trim() : "";
  if (currentBranch !== milestoneBranch) {
    // Issue #1517: shallow clones (`--depth=1 --no-single-branch`) only carry
    // remote-tracking refs for branches present at clone time. Fetch the
    // milestone branch first so DWIM checkout can create a local tracking
    // branch from `origin/<milestoneBranch>` when the branch was created
    // remotely after the clone.
    await runGitCommand([
      "fetch",
      "origin",
      milestoneBranch
    ], options);
    // Issue #568: the shared `${WORK_DIR}/<repo>` clone is scratch, not a
    // workspace anyone's work survives in — a timed-out claim or an
    // abandoned pass routinely leaves it dirty, and `git checkout` then
    // refuses ("Your local changes to the following files would be
    // overwritten"). The sync recorded `sync_failed` and moved on, so the
    // milestone branch drifted behind the default line until a human noticed
    // — which is exactly the drift that produces the conflicting child PRs
    // the merge-conflict lane then spends agent time on.
    //
    // Discarding here is safe BECAUSE the clone is shared scratch: every
    // caller re-derives what it needs, and the repository lease (Issue #213)
    // is what stops an issue slot's real work being in this tree at the same
    // time. What is discarded is named, so a surprise is diagnosable rather
    // than silent.
    const dirty = await runGitCommand([
      "status",
      "--porcelain"
    ], options);
    if (dirty.ok && dirty.value.code === 0 && dirty.value.stdout.trim()) {
      const files = dirty.value.stdout.trim().split("\n");
      await runGitCommand([
        "reset",
        "--hard"
      ], options);
      // Ignored executable paths go with it (Issue #1443). A failure is
      // named in the note this function returns, so the sync's own record
      // carries it rather than it being dropped here.
      const cleaned = await cleanWorkingTree(options);
      if (!cleaned.ok) {
        console.error(`[sync] ${cleaned.error.message}`);
      }
      dirtyNote = `SELF-HEALING: discarded ${files.length} uncommitted ` + `change(s) in the shared clone before checkout (${// Porcelain v1 is a two-character status field, then the path.
      files.slice(0, 3).map((line)=>line.slice(2).trim()).join(", ")}${files.length > 3 ? `, +${files.length - 3} more` : ""})${cleaned.ok ? "" : " — " + cleaned.error.message} — `;
    }
    const checkoutResult = await runGitCommand([
      "checkout",
      milestoneBranch
    ], options);
    if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
      // Surface git's own output (Issue #49): "error: Your local changes to
      // the following files would be overwritten by checkout: …" — usually a
      // dirty tree a timed-out claim left on this shared clone — is the whole
      // diagnosis, and the old error discarded it. stdout counts too
      // (Issue #1964), so a stdout-only refusal is never logged as silence.
      return {
        ok: false,
        error: new Error(`Failed to checkout milestone branch '${milestoneBranch}': ${describeGitFailure(checkoutResult, {
          lines: 6,
          from: "head"
        })}`)
      };
    }
  }
  // Take the remote milestone branch without ever manufacturing a local merge
  // commit (Issue #4002). A plain `git pull` merges whenever local and remote
  // have diverged; a repository rule forbidding merge commits then rejects the
  // push, and the branch stays unpushable until a human intervenes. The remote
  // is authoritative for a milestone branch, so fast-forward where possible and
  // reset to the remote ref otherwise.
  let selfHealNote = dirtyNote;
  await runGitCommand([
    "fetch",
    "origin",
    milestoneBranch
  ], options);
  const remoteRefResult = await runGitCommand([
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${milestoneBranch}`
  ], options);
  if (remoteRefResult.ok && remoteRefResult.value.code === 0) {
    const fastForwardResult = await runGitCommand([
      "merge",
      "--ff-only",
      `origin/${milestoneBranch}`
    ], options);
    if (!fastForwardResult.ok || fastForwardResult.value.code !== 0) {
      const resetResult = await runGitCommandChecked([
        "reset",
        "--hard",
        `origin/${milestoneBranch}`
      ], options);
      if (!resetResult.ok) {
        return {
          ok: false,
          error: new Error(`Failed to reset diverged milestone branch '${milestoneBranch}' to 'origin/${milestoneBranch}': ${resetResult.error.message}`)
        };
      }
      selfHealNote = `SELF-HEALING: reset '${milestoneBranch}' to 'origin/${milestoneBranch}' ` + `(diverged local commits discarded) — `;
    }
  }
  // Where this sync's minutes go (Issue #2308). The deepen, the ladder's two
  // rungs, the verification gate and the push are each timed into it, and the
  // rendered line rides out with the conflict on the sync report.
  const timer = createConflictStageTimer(nowMsFn);
  /**
   * Log this sync's stage timings and render them for the report comment
   * (Issue #2308).
   *
   * Called from every exit below, not only the one that pushed: a sync that
   * spent twenty minutes and then refused is exactly the attempt a reader
   * needs the breakdown for, and an exit that logged nothing would hide it.
   * One call site feeds both sinks, so the log record and the comment can
   * never claim different breakdowns.
   *
   * @returns The rendered line, ready to append to a sync report comment
   */ const recordTimings = ()=>{
    const host = currentHost();
    const stageTimings = timer.report();
    logger?.info("Milestone sync stage timings", {
      milestoneBranch,
      defaultBranch,
      host,
      timings: stageTimings
    });
    return formatStageTimings(stageTimings, host);
  };
  // Ensure enough history for range/merge ops on a shallow clone (Issue
  // #1502). A failure here is NOT a free pass to merge anyway (Issue #2896):
  // without a common ancestor locally, `git merge` refuses as "unrelated
  // histories" even though a merge base exists on the remote, and that
  // refusal used to be reported as the permanent non-conflict failure further
  // down rather than named for what it is here.
  timer.start("deepen");
  const deepened = await ensureHistoryDepth([
    "HEAD",
    defaultBranch
  ], options);
  timer.stop();
  if (!deepened.ok) {
    return {
      ok: false,
      error: new Error(`Refusing to merge '${defaultBranch}' into '${milestoneBranch}': ` + `the shallow clone could not be deepened to their merge base, so ` + `git would refuse the merge as unrelated histories ` + `(Issue #2896): ${deepened.error.message}`)
    };
  }
  // Check if merge is needed
  const behindResult = await runGitCommand([
    "rev-list",
    "--count",
    `HEAD..${defaultBranch}`
  ], options);
  const behindCount = behindResult.ok && behindResult.value.code === 0 ? parseInt(behindResult.value.stdout.trim(), 10) || 0 : 0;
  if (behindCount === 0) {
    return {
      ok: true,
      value: {
        message: `${selfHealNote}Milestone branch '${milestoneBranch}' is already up to date with '${defaultBranch}'`
      }
    };
  }
  // Where the branch stands before any merge, so the gate can undo one
  // exactly when the merged tree does not compile (Issue #974). Read it
  // BEFORE merging: without it a refused merge cannot be rolled back, so the
  // honest move is to refuse to start rather than to discover it afterwards.
  const preMergeShaResult = await runGitCommand([
    "rev-parse",
    "HEAD"
  ], options);
  const preMergeSha = preMergeShaResult.ok && preMergeShaResult.value.code === 0 ? preMergeShaResult.value.stdout.trim() : "";
  if (!preMergeSha) {
    return {
      ok: false,
      error: new Error(`Refusing to merge '${defaultBranch}' into '${milestoneBranch}': ` + `its pre-merge HEAD could not be read, so a merge the gate rejects ` + `could not be rolled back (Issue #974): ${describeGitFailure(preMergeShaResult)}`)
    };
  }
  // Merge default into milestone (preserve commit history). A refusal naming
  // "unrelated histories" is retried once after unshallowing when the clone
  // is shallow (Issue #2896) — see {@link mergeWithUnshallowRetry} — because
  // that refusal on a shallow clone usually means the merge base exists on
  // the remote but was never fetched, not that the histories are genuinely
  // unrelated.
  const mergeResult = await mergeWithUnshallowRetry(defaultBranch, options);
  if (mergeResult.ok && mergeResult.value.code === 0) {
    if (await alreadySyncedElsewhere(milestoneBranch, defaultBranch, options)) {
      return await adoptRemoteSync(milestoneBranch, defaultBranch, options);
    }
    // Push the synced milestone branch (Issue #605), or raise a PR for it
    // where a repository rule refuses the push (Issue #589) — but only once
    // the merged tree has passed the repo's own gate (Issue #974).
    const gated = await gateThenPushMilestoneBranch(milestoneBranch, defaultBranch, options, repo, mergeGate, preMergeSha);
    if (!gated.ok) return gated;
    return {
      ok: true,
      value: {
        message: `${selfHealNote}${gated.value}Successfully merged '${defaultBranch}' into '${milestoneBranch}' (${behindCount} commit(s) integrated)`
      }
    };
  }
  // Merge conflict. Both sides are read straight out of the conflicted index
  // — once the merge is aborted git no longer holds them, and a conflict
  // nobody can describe is a conflict nobody reconciles (Issues #1558,
  // #1559).
  // A listing git could not produce reads as "no conflicted files", which the
  // branch below reports as the non-conflict failure it is, quoting git's own
  // merge stderr — so the failure is diagnosed there rather than swallowed.
  const listed = await listUnmergedPaths(options);
  const conflictedFiles = listed.ok ? listed.value : [];
  const defaultSha = await readRef(defaultBranch, options);
  if (conflictedFiles.length === 0) {
    await runGitCommand([
      "merge",
      "--abort"
    ], options);
    // Honest failure (Issue #4260): a merge that fails with ZERO conflicted
    // files failed for a non-conflict reason (unrelated histories, shallow
    // history, dirty tree, vanished remote…). This used to return ok:true and
    // be logged as "Synced …" — FLEET milestone/4064 sat 5 commits behind
    // Develop for days while every cycle said 0 failed. Surface git's own
    // output — stdout as well as stderr (Issue #1964) — so the real reason is
    // in the log.
    return {
      ok: false,
      error: new Error(`Merge of '${defaultBranch}' into '${milestoneBranch}' failed ` + `with no conflicted files — a non-conflict failure ` + `(Issue #4260): ${describeGitFailure(mergeResult)}`)
    };
  }
  const mergeBase = await readMergeBase(preMergeSha, defaultBranch, options);
  const readSides = await readConflictedSides(conflictedFiles, mergeBase, defaultBranch, defaultSha || defaultBranch, preMergeSha, options);
  if (!readSides.ok) {
    await runGitCommand([
      "merge",
      "--abort"
    ], options);
    return readSides;
  }
  const sides = readSides.value;
  const plan = planConflictResolution(sides, await readTestEvidence(mergeBase, defaultSha || defaultBranch, preMergeSha, options));
  // A conflicted test file whose sides do not contain one another is merged
  // as a union — both sides' hunks kept — rather than escalated on sight
  // (Issue #1559). A union that would lose a case, or that git could not
  // produce, becomes an escalation for that file instead.
  const decided = new Map(plan.decisions.map((d)=>[
      d.path,
      d
    ]));
  for (const file of sides){
    const decision = decided.get(file.path);
    if (decision?.action !== "union") continue;
    // An append-only ledger reads the default branch's entry first (Issue
    // #1768); a test-file union keeps the branch's own cases first as before.
    const failure = await unionMergeConflictedFile(file, options, decision.case === "both-inserted" ? "default-first" : "milestone-first");
    if (failure) {
      decision.action = "escalate";
      decision.reason = `${decision.reason} — and ${failure}`;
    }
  }
  // The ladder (Issue #1777): what the triage could not decide goes to the
  // deterministic dependency rules, and what those defer goes to the
  // resolution agent — the same two rungs the PR pass climbs, over the same
  // clone. Only a file every rung leaves undecided reaches a human.
  const triaged = plan.decisions.filter((d)=>d.action !== "escalate");
  // Take the triage's sides NOW, before the ladder climbs (Issue #2006). The
  // agent rung stages the whole working tree once the agent is done — a
  // resolution that extracts a helper leaves a new file the merge commit
  // must carry — and `git add -A` does not stop at the paths the agent was
  // asked about. A triaged path still unmerged at that point was staged
  // with git's marker-laden working copy and its merge stages were gone, so
  // its side could no longer be taken and the whole resolution — eleven
  // minutes of agent work included — was refused as "the merge stages of
  // conflicted file 'Cargo.lock' could not be read". With the sides already
  // staged the agent sees them as decided, and staging the tree changes
  // nothing about them.
  const sidesTaken = await applyConflictPlan({
    ...plan,
    resolved: triaged,
    escalations: plan.decisions.filter((d)=>d.action === "escalate")
  }, sides, defaultBranch, milestoneBranch, options);
  if (!sidesTaken.ok) {
    await runGitCommand([
      "merge",
      "--abort"
    ], options);
    return sidesTaken;
  }
  const ladder = await climbConflictLadder({
    escalations: plan.decisions.filter((d)=>d.action === "escalate"),
    options,
    milestoneBranch,
    defaultBranch,
    agentFn,
    timer,
    logger
  });
  const resolved = [
    ...triaged,
    ...ladder.resolved
  ];
  const escalations = ladder.escalations;
  /** Every settled file by path, carrying the rung that settled it. */ const settled = new Map(resolved.map((d)=>[
      d.path,
      d
    ]));
  // Case 3 (Issue #1559): no automatic rule can choose between the two sides,
  // so nothing is pushed and the branch is left exactly as it was. The
  // analysis travels with the refusal — both sides' exports, both sides' test
  // names and the difference between them — because that preparation is most
  // of the hour the reader would otherwise spend.
  if (escalations.length > 0) {
    await runGitCommand([
      "merge",
      "--abort"
    ], options);
    const escalated = new Map(escalations.map((d)=>[
        d.path,
        d
      ]));
    const analyses = sides.filter((side)=>escalated.has(side.path)).map((side)=>analyseConflictedFile(side, escalated.get(side.path).reason));
    // An escalation is an attempt too (Issue #2308) — the rungs that reached
    // it cost the same minutes, and the log says where they went. The line
    // travels with the refusal as well (Issue #2311): the `merge-fallback`
    // flag reports what each spent run cost.
    const escalationTimings = recordTimings();
    return {
      ok: false,
      error: new MilestoneConflictEscalation(`Refusing to resolve the merge of '${defaultBranch}' into ` + `'${milestoneBranch}': ${escalations.length} of ` + `${conflictedFiles.length} conflicted file(s) need a human — ` + `every rung of the ladder left them undecided (Issues #1559, ` + `#1777) — ${escalations.map((d)=>`${d.path}: ${d.reason}`).join("; ")}`, analyses, resolved, defaultSha, undefined, preMergeSha, escalationTimings)
    };
  }
  // Who writes the merge commit is read from git, not assumed (Issue #1964).
  // The agent rung works in this very clone, and an agent that committed the
  // merge itself leaves nothing for `git commit -m …`: git exits 1 saying
  // "nothing to commit, working tree clean" on stdout, and the sync used to
  // read that as a failure, abort and throw a good resolution away every
  // cycle until a human took the branch. Read BEFORE the plan is applied,
  // because taking a side needs the conflicted index the commit cleared.
  const mergeState = await readMergeCommitState({
    preMergeSha,
    defaultSha,
    options
  });
  /**
   * Refuse the resolution, optionally putting the branch back where it stood.
   *
   * A state nobody could read restores nothing: discarding work on a check
   * that did not run is the one direction that cannot be undone.
   */ const refuseResolution = async (detail, restore)=>{
    let note = "";
    if (restore) {
      const reset = await runGitCommand([
        "reset",
        "--hard",
        preMergeSha
      ], options);
      note = reset.ok && reset.value.code === 0 ? ` — the branch was reset to ${preMergeSha}` : ` — and the branch could NOT be reset to ${preMergeSha}: ${describeGitFailure(reset)}`;
    }
    // A refusal costs the same minutes a push does (Issue #2308), so it
    // accounts for them the same way.
    recordTimings();
    return {
      ok: false,
      error: new Error(`Refusing to commit the resolution of '${defaultBranch}' into ` + `'${milestoneBranch}' (Issue #1964): ${detail}${note}`)
    };
  };
  if (mergeState.kind === "unknown") {
    return await refuseResolution(mergeState.detail, false);
  }
  if (mergeState.kind === "no-merge") {
    return await refuseResolution(mergeState.detail, true);
  }
  if (mergeState.kind === "already-committed") {
    // Every side the triage chose was staged before any rung ran (Issue
    // #2006), so a rung that committed the merge committed those sides too;
    // the adopted commit is judged on its safety alone.
    // The index gate saw nothing to inspect, so the commit's own changes are
    // held to it here rather than adopted unchecked (Issue #1758).
    const safe = await assertAdoptedMergeIsSafe({
      preMergeSha,
      defaultSha,
      options
    });
    if (!safe.ok) {
      return await refuseResolution(`the merge commit was written by another rung and ${safe.error.message}`, true);
    }
  }
  // The triage's sides were taken before the ladder climbed (Issue #2006);
  // what remains is to prove no rung left anything unmerged.
  // The tree must be fully resolved — by the triage, the rules, the agent or
  // all three (Issue #1777). A path still unmerged, or a file still carrying
  // conflict markers, is a half-resolution: it compiles nowhere and must
  // never be committed as a merge. Both guards run over every conflicted
  // path, so a rung that reported success while leaving a mess is caught
  // here rather than pushed.
  const unresolved = await listUnmergedPaths(options);
  if (!unresolved.ok) {
    await runGitCommand([
      "merge",
      "--abort"
    ], options);
    return {
      ok: false,
      error: new Error(`Refusing to commit the resolution of '${defaultBranch}' into ` + `'${milestoneBranch}': ${unresolved.error.message} (Issue #1777)`)
    };
  }
  if (unresolved.value.length > 0) {
    await runGitCommand([
      "merge",
      "--abort"
    ], options);
    return {
      ok: false,
      error: new Error(`Refusing to commit the resolution of '${defaultBranch}' into ` + `'${milestoneBranch}': ${unresolved.value.length} path(s) are ` + `still ` + `unmerged (Issue #1777): ${unresolved.value.join(", ")}`)
    };
  }
  const markers = await hasConflictMarkers(conflictedFiles, options);
  if (!markers.ok) {
    await runGitCommand([
      "merge",
      "--abort"
    ], options);
    return {
      ok: false,
      error: new Error(`Refusing to commit the resolution of '${defaultBranch}' into ` + `'${milestoneBranch}': ${markers.error.message} (Issue #1777)`)
    };
  }
  if (markers.value) {
    await runGitCommand([
      "merge",
      "--abort"
    ], options);
    return {
      ok: false,
      error: new Error(`Refusing to commit the resolution of '${defaultBranch}' into ` + `'${milestoneBranch}': the working tree still contains conflict ` + `markers (Issue #1777)`)
    };
  }
  const resolutionMessage = buildResolutionCommitMessage({
    defaultBranch,
    milestoneBranch,
    plan: {
      ...plan,
      resolved,
      escalations
    }
  });
  // An already-committed merge keeps its commit and takes the sync's message,
  // so the record of which rung settled each file is the same either way.
  const alreadyCommitted = mergeState.kind === "already-committed";
  const commitResult = alreadyCommitted ? await runGitCommand([
    "commit",
    "--amend",
    "-m",
    resolutionMessage
  ], options) : await runGitCommand([
    "commit",
    "-m",
    resolutionMessage
  ], options);
  if (!commitResult.ok || commitResult.value.code !== 0) {
    // Honest failure (Issue #4260), with git's stdout as well as its stderr
    // (Issue #1964) — `git commit` explains itself on stdout. Either way the
    // branch goes back where it stood: an un-reworded merge left behind would
    // be pushed next cycle with no record of which rung settled what.
    if (alreadyCommitted) {
      return await refuseResolution(`its commit could not be re-worded: ${describeGitFailure(commitResult)}`, true);
    }
    await runGitCommand([
      "merge",
      "--abort"
    ], options);
    return {
      ok: false,
      error: new Error(`Failed to commit the conflict resolution for '${milestoneBranch}' ` + `(Issues #4260, #1964): ${describeGitFailure(commitResult)}`)
    };
  }
  // Issue #2030: the agent rung takes minutes; a sibling may have landed
  // this very sync meanwhile. Its result is the branch's now, not ours.
  if (await alreadySyncedElsewhere(milestoneBranch, defaultBranch, options)) {
    return await adoptRemoteSync(milestoneBranch, defaultBranch, options);
  }
  // A resolution the worker chose is verified the way a human's would be
  // (Issue #1559): the repository's own check, its manifest check and its
  // unit suite. A tree that defines none of them verified nothing, so
  // `skipped` refuses the push rather than reading as a pass — except a
  // merge-only gate's `skipped` marked `landUnverified` (Issue #4326), which is
  // pushed with the `UNGATED:` note.
  const runResolutionGate = ()=>resolutionGate(options.cwd ?? ".");
  // Issue #1965: a gate failure after a resolution is usually a semantic
  // conflict git never reported — the default branch changed an interface
  // this branch implements where no hunk overlapped. It goes back to the
  // agent rung with the compiler's own output, not straight to a human, and
  // a repair that works is folded into the merge commit.
  // Issue #2308: a repair round runs the resolution agent from *inside* the
  // verification, and that run is usually the largest single block of the
  // sync. Its minutes belong to `agent`, not to `gate` — otherwise the line
  // attributes the time to the wrong stage, which is the one thing it exists
  // to get right. The gate's own slices either side of the repair accumulate.
  const timedRepairAgent = agentFn ? async (request)=>{
    timer.stop();
    timer.start("agent");
    try {
      return await agentFn(request);
    } finally{
      timer.stop();
      timer.start("gate");
    }
  } : undefined;
  timer.start("gate");
  const verified = await runGateWithRepair({
    gate: runResolutionGate,
    ...timedRepairAgent ? {
      agentFn: timedRepairAgent
    } : {},
    options,
    milestoneBranch,
    defaultBranch,
    preMergeSha,
    defaultRef: defaultSha || defaultBranch,
    resolutionMessage,
    conflictedFiles,
    ...logger ? {
      logger
    } : {}
  });
  timer.stop();
  if (verified.amendFailure) {
    return await refuseResolution(verified.amendFailure, true);
  }
  const { gate: finalGate, firstGate, repair } = verified;
  timer.start("push");
  const gatedResolved = await gateThenPushMilestoneBranch(milestoneBranch, defaultBranch, options, repo, ()=>Promise.resolve(finalGate), preMergeSha);
  timer.stop();
  if (!gatedResolved.ok) {
    // The resolution was made and the verification refused it. The reader
    // gets both halves (Issue #1559) — what the gate said, and the two sides
    // that produced it — rather than the wall of compiler output that made
    // #1542 nearly useless for deciding anything. The branch was already
    // reset by the gate, so nothing was pushed.
    // Both gate outputs travel with the escalation (Issue #1965): the
    // refusal above carries the last one, and the note carries the first,
    // so a reader can tell a repair that helped nothing from one that made
    // it worse — or see that no repair was attempted, and why.
    const gateFailure = repair ? `${gatedResolved.error.message}\n\n${describeRepairEscalation(firstGate, repair)}` : gatedResolved.error.message;
    // A gate that refused still spent the minutes (Issue #2308), and the
    // refusal carries them (Issue #2311).
    const gateTimings = recordTimings();
    return {
      ok: false,
      error: new MilestoneConflictEscalation(gateFailure, // The rung that actually settled each file, not the triage's
      // pre-ladder verdict on it: a file the rules or the agent decided
      // would otherwise be presented as one nothing could decide.
      sides.map((side)=>analyseConflictedFile(side, settled.get(side.path)?.reason ?? "resolved automatically")), resolved, defaultSha, gateFailure, preMergeSha, gateTimings)
    };
  }
  // Each file names the rung that settled it (Issue #1777), so the log line
  // says which of triage, rules or agent did the work.
  const summary = resolved.map((d)=>`${d.path} (${describeDecisionRung(d, {
      ours: milestoneBranch,
      theirs: defaultBranch
    })})`).join(", ");
  // A resolution the gate refused and the agent rung then repaired says so
  // wherever it is read (Issue #1965).
  const repaired = repair?.status === "repaired" ? repair.record : undefined;
  // Where the sync's minutes went (Issue #2308).
  const timings = recordTimings();
  // The merge commit this resolution produced (Issue #2998), so a later
  // report can confirm it actually landed rather than trusting this push.
  const mergeSha = await readRef("HEAD", options);
  return {
    ok: true,
    value: {
      message: `${selfHealNote}${gatedResolved.value}Issues #1559, #1777: resolved ${resolved.length} conflict(s) automatically — ${summary}${repaired ? ` — ${summariseGateRepair(repaired)}` : ""}`,
      conflict: {
        files: conflictedFiles,
        milestoneSha: preMergeSha,
        defaultSha,
        resolution: "auto",
        ...finalGate.status === "skipped" ? {
          unverified: true
        } : finalGate.cargoSkipped ? {
          cargoSkipped: true
        } : {},
        ...finalGate.suiteLeftToCi ? {
          suiteLeftToCi: finalGate.suiteLeftToCi
        } : {},
        ...finalGate.checkLeftToCi ? {
          checkLeftToCi: finalGate.checkLeftToCi
        } : {},
        decisions: resolved,
        ...repaired ? {
          repair: repaired
        } : {},
        // Issue #2306: the agent names each judgement call file by file in
        // its reply, and this comment is where that record surfaces on the
        // milestone path.
        ...ladder.agentReply ? {
          agentReply: ladder.agentReply
        } : {},
        timings,
        ...mergeSha ? {
          mergeSha
        } : {}
      }
    }
  };
}
/** Error name for a PR branch left untouched because its changes conflict (Issue #4373). */ export const PR_BRANCH_CONFLICT_ERROR = "PrBranchConflict";
/**
 * A PR branch whose changes collide with its base (Issue #4373). The worker
 * never resolves such a conflict by picking a side — that either discards
 * the PR's work (upstream wins) or reverts base-branch work (PR wins),
 * silently, under a commit that still carries the PR's message; observed
 * live when #4372 lost its whole claude_runner.ts change to a maintenance
 * rebase. The branch is left exactly as it was for a real merge (the
 * PR-feedback agent or a human).
 */ export function prBranchConflictError(branchName, baseBranch, how) {
  const err = new Error(`PR branch '${branchName}' conflicts with '${baseBranch}' (${how}) — left untouched: the worker does not resolve conflicts by picking a side (Issue #4373); resolve with a real merge`);
  err.name = PR_BRANCH_CONFLICT_ERROR;
  return err;
}
/** Whether an error is the left-untouched conflict outcome (Issue #4373). */ export function isPrBranchConflictError(err) {
  return err instanceof Error && err.name === PR_BRANCH_CONFLICT_ERROR;
}
/**
 * The ref a PR should be judged and rebased against (Issue #394).
 *
 * `refs/remotes/origin/<base>` when the clone has it — the base as published,
 * which is what GitHub compared the PR with — falling back to the local
 * branch name when there is no tracking ref (a base that exists only locally,
 * as in several unit fixtures).
 *
 * The local base ref cannot be relied on here: it is shared with every other
 * lane on the host, and git refuses to move a branch another worktree has
 * checked out, so `ensureDefaultBranchCurrent` can legitimately leave it
 * behind the remote.
 *
 * @param baseBranch - The PR's base branch name
 * @param options - Git command options (cwd selects the clone or worktree)
 * @returns The ref to use for comparison, rebase and merge
 */ async function resolvePublishedBaseRef(baseBranch, options) {
  const trackingRef = `refs/remotes/origin/${baseBranch}`;
  const resolved = await runGitCommand([
    "rev-parse",
    "--verify",
    "--quiet",
    trackingRef
  ], options);
  return resolved.ok && resolved.value.code === 0 ? trackingRef : baseBranch;
}
/**
 * Merge `baseRef` into the checked-out branch, never picking a side
 * (Issues #4373, #2807).
 *
 * A conflicting merge is aborted and returned as {@link prBranchConflictError}
 * so the conflict ladder takes over with the branch exactly as it was. Any
 * other merge failure is a failure carrying git's own output.
 *
 * @param branchName - The checked-out branch being updated
 * @param baseBranch - The base branch's name, for the operator-facing verdict
 * @param baseRef - The ref actually merged in
 * @param options - Git command options
 * @returns Success once the merge commit (or fast-forward) is in place
 */ async function mergeBaseIntoBranch(branchName, baseBranch, baseRef, options) {
  const mergeResult = await runGitCommand([
    "merge",
    "--no-edit",
    "--end-of-options",
    baseRef
  ], options);
  if (mergeResult.ok && mergeResult.value.code === 0) {
    return {
      ok: true,
      value: undefined
    };
  }
  const unmerged = await listUnmergedPaths(options);
  // Abort only a merge git actually started, and fail loud when the abort
  // itself fails: a half-merged tree is not "left exactly as it was".
  const merging = await runGitCommand([
    "rev-parse",
    "--verify",
    "--quiet",
    "MERGE_HEAD"
  ], options);
  if (merging.ok && merging.value.code === 0) {
    const aborted = await runGitCommand([
      "merge",
      "--abort"
    ], options);
    if (!aborted.ok || aborted.value.code !== 0) {
      return {
        ok: false,
        error: new Error(`Merging '${baseRef}' into '${branchName}' failed and ` + `'git merge --abort' failed too: ${describeGitFailure(aborted, {
          lines: 6,
          from: "head"
        })}`)
      };
    }
  }
  if (unmerged.ok && unmerged.value.length > 0) {
    return {
      ok: false,
      error: prBranchConflictError(branchName, baseBranch, "merge")
    };
  }
  return {
    ok: false,
    error: new Error(`Failed to merge '${baseRef}' into '${branchName}': ${describeGitFailure(mergeResult, {
      lines: 6,
      from: "head"
    })}`)
  };
}
/**
 * Update a PR branch to be current with its base branch
 * (Issues #379, #498, #2807).
 *
 * Merges the published base into the PR branch and pushes normally — never a
 * rebase, never a force-push — so a PR under review keeps its commits and its
 * review comments. A "conflicting" PR (Issue #1313) takes the same merge
 * whatever its behind count, since GitHub has already seen the divergence.
 *
 * @param branchName - The feature branch to update
 * @param baseBranch - The base branch to sync with
 * @param options - Git command options
 * @param reason - Why the branch needs updating ("behind" or "conflicting")
 * @returns Result indicating success or failure
 */ export async function updatePrBranch(branchName, baseBranch, options = {}, reason) {
  // Refuse an option-injecting ref before any git runs (Issue #12).
  try {
    assertSafeGitRef(branchName, "PR head branch name");
    assertSafeGitRef(baseBranch, "PR base branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
  // Ensure the local base branch is current
  await ensureDefaultBranchCurrent(baseBranch, options);
  // Issue #394: the base ref this update is judged against is the *published*
  // one wherever it exists. `ensureDefaultBranchCurrent` cannot move a local
  // base branch that another lane's worktree has checked out — git refuses,
  // correctly — so trusting the local ref would merge a base that is
  // already behind and leave the PR reported as behind for ever.
  const baseRef = await resolvePublishedBaseRef(baseBranch, options);
  // Issue #211 / #394: position the branch at its remote head in one
  // mutating command. The old shape read `HEAD`, ran a bare
  // `git checkout <branch>`, and then fast-forwarded — three commands with
  // two windows in which a lane sharing this clone could delete or move the
  // branch, which is exactly how an open PR whose branch sits healthily on
  // origin was reported as `pathspec … did not match any file(s) known to
  // git` (PR #392). `checkoutPrBranchAtRemoteHead` fetches the tracking ref
  // explicitly and uses `checkout -B`, so a missing, stale or corrupt local
  // ref is overwritten rather than read — and it still refuses loudly, with
  // the typed ahead-of-remote error, when the local branch carries commits
  // origin has never seen: those are somebody's unpushed work and this pass
  // pushes whatever it produces.
  const alignResult = await checkoutPrBranchAtRemoteHead(branchName, options);
  if (!alignResult.ok) {
    return {
      ok: false,
      error: alignResult.error
    };
  }
  const alignNote = alignResult.value === "reset-to-remote" ? `positioned '${branchName}' on its remote head. ` : "";
  // Ensure enough history for range detection on a shallow clone (Issue #1502)
  await ensureHistoryDepth([
    "HEAD",
    baseRef
  ], options);
  // Check if an update is needed
  const behindResult = await runGitCommand([
    "rev-list",
    "--count",
    `HEAD..${baseRef}`
  ], options);
  const behindCount = behindResult.ok && behindResult.value.code === 0 ? parseInt(behindResult.value.stdout.trim(), 10) || 0 : 0;
  // Return early when not behind and no conflict reason provided.
  if (reason !== "conflicting" && behindCount === 0) {
    return {
      ok: true,
      value: `${alignNote}PR branch '${branchName}' is already up to date ` + `with '${baseBranch}'`
    };
  }
  const merged = await mergeBaseIntoBranch(branchName, baseBranch, baseRef, options);
  if (!merged.ok) return merged;
  const pushed = await pushFeatureBranch(branchName, options);
  return pushed.ok ? {
    ok: true,
    value: `${alignNote}${pushed.value}`
  } : pushed;
}
/**
 * Push an updated feature branch with a plain, fast-forward push
 * (Issue #2807).
 *
 * Never forced: a merge only adds commits, so the push fast-forwards. A
 * rejection — somebody pushed meanwhile, or a branch rule refused it — is a
 * failure carrying git's stderr, and is never retried with force.
 *
 * @param branchName - The branch to push
 * @param options - Git command options
 * @returns Result indicating success
 */ async function pushFeatureBranch(branchName, options = {}) {
  const { isProtectedBranch } = await import("./git_branch.ts");
  if (isProtectedBranch(branchName)) {
    return {
      ok: false,
      error: new Error(`Cannot push a PR update to protected branch '${branchName}'`)
    };
  }
  // Issue #275: through the sanctioned builder, so the branch name is
  // validated and sits behind `--end-of-options`.
  const pushResult = await runGitCommand(buildPushArgs("origin", branchName), options);
  if (!pushResult.ok || pushResult.value.code !== 0) {
    const errorMsg = pushResult.ok ? pushResult.value.stderr : pushResult.error.message;
    return {
      ok: false,
      error: new Error(`Failed to push updated branch '${branchName}' (plain push, not retried with force): ${errorMsg}`)
    };
  }
  return {
    ok: true,
    value: `Successfully pushed updated PR branch '${branchName}'`
  };
}
/**
 * Ensure a PR is mergeable by merging its base in when behind
 * (Issues #482, #2807).
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - The PR number
 * @param branchName - The feature branch to check
 * @param baseBranch - The base branch the PR targets
 * @param options - Git command options
 * @returns Result indicating success
 */ export async function ensurePrMergeable(_repo, _prNumber, branchName, baseBranch, options = {}) {
  // Fetch the latest base branch
  const fetchResult = await runGitCommandChecked([
    "fetch",
    "origin",
    baseBranch
  ], options);
  if (!fetchResult.ok) {
    return {
      ok: true,
      value: "Could not fetch base branch — skipping mergeability check"
    };
  }
  // Update local base branch ref
  const currentBranchResult = await runGitCommand([
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ], options);
  const currentBranch = currentBranchResult.ok ? currentBranchResult.value.stdout.trim() : "";
  if (currentBranch === baseBranch) {
    await runGitCommand([
      "reset",
      "--hard",
      `origin/${baseBranch}`
    ], options);
  } else {
    await runGitCommand([
      "branch",
      "-f",
      baseBranch,
      `origin/${baseBranch}`
    ], options);
  }
  // Ensure we are on the feature branch
  if (currentBranch !== branchName) {
    const checkoutResult = await runGitCommand(buildCheckoutArgs(branchName), options);
    if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
      return {
        ok: false,
        error: checkoutFailureError(branchName, checkoutResult)
      };
    }
  }
  // Ensure enough history for the range/merge on a shallow clone (Issue #1502)
  await ensureHistoryDepth([
    "HEAD",
    baseBranch
  ], options);
  // Check if behind
  const behindResult = await runGitCommand([
    "rev-list",
    "--count",
    `HEAD..${baseBranch}`
  ], options);
  const behindCount = behindResult.ok && behindResult.value.code === 0 ? parseInt(behindResult.value.stdout.trim(), 10) || 0 : 0;
  if (behindCount === 0) {
    return {
      ok: true,
      value: `PR branch '${branchName}' is up to date with '${baseBranch}' — no conflicts`
    };
  }
  // Merge the base in (Issue #2807): a conflict is aborted and reported,
  // never side-picked and never recreated (Issue #386).
  const merged = await mergeBaseIntoBranch(branchName, baseBranch, baseBranch, options);
  if (!merged.ok) return merged;
  return await pushFeatureBranch(branchName, options);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfcHVsbC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEdpdCBwdWxsIG9wZXJhdGlvbnMgd2l0aCBjb25mbGljdCBkZXRlY3Rpb24gKElzc3VlICM5MTIpLlxuICpcbiAqIFByb3ZpZGVzIGZ1bmN0aW9ucyBmb3Igc3luY2luZyBmZWF0dXJlIGJyYW5jaGVzIHdpdGggZGVmYXVsdCBicmFuY2hlcyxcbiAqIHN5bmNpbmcgbWlsZXN0b25lIGJyYW5jaGVzLCBhbmQgcHVsbGluZyB3aXRoIGNvbmZsaWN0IGhhbmRsaW5nLlxuICpcbiAqIE1pZ3JhdGVkIGZyb20gd29ya2VyL3NoYXJlZC9naXRfb3BlcmF0aW9ucy5zaC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IExvZ2dlciwgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBydW5HaXRDb21tYW5kLCBydW5HaXRDb21tYW5kQ2hlY2tlZCB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgeyBjbGVhbldvcmtpbmdUcmVlIH0gZnJvbSBcIi4vaWdub3JlZF9wYXRoX2NsZWFuLnRzXCI7XG5pbXBvcnQgeyBzcGF3bkdoIH0gZnJvbSBcIi4vZ2hfc3Bhd24udHNcIjtcbmltcG9ydCB7XG4gIGlzUnVsZVZpb2xhdGlvblB1c2gsXG4gIHJhaXNlTWlsZXN0b25lU3luY1ByLFxuICBzeW5jUHJMYW5kaW5nTm90ZSxcbn0gZnJvbSBcIi4vbWlsZXN0b25lX3N5bmNfcHIudHNcIjtcbmltcG9ydCB7IHJlc3RvcmVDbG9zZWRNaWxlc3RvbmVSb3V0ZSB9IGZyb20gXCIuL21pbGVzdG9uZV9yb3V0ZV9yZXN0b3JlLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdpdENvbW1hbmRPcHRpb25zIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB7IGVuc3VyZURlZmF1bHRCcmFuY2hDdXJyZW50IH0gZnJvbSBcIi4vZ2l0X3B1c2gudHNcIjtcbmltcG9ydCB7XG4gIGFzc2VydFNhZmVHaXRSZWYsXG4gIGFzc2VydFNhZmVSZWZDb21wb25lbnQsXG4gIGJ1aWxkQ2hlY2tvdXRBcmdzLFxuICBidWlsZEZldGNoQXJncyxcbiAgYnVpbGRQdXNoQXJncyxcbn0gZnJvbSBcIi4vZ2l0X3JlZl9hcmdzLnRzXCI7XG5pbXBvcnQgeyBjaGVja291dFByQnJhbmNoQXRSZW1vdGVIZWFkIH0gZnJvbSBcIi4vcHJfYnJhbmNoX2NoZWNrb3V0LnRzXCI7XG5pbXBvcnQge1xuICBhc3NlcnRBZG9wdGVkTWVyZ2VJc1NhZmUsXG4gIGRlc2NyaWJlR2l0RmFpbHVyZSxcbiAgdHlwZSBHaXRSdW5SZXN1bHQsXG4gIHJlYWRNZXJnZUNvbW1pdFN0YXRlLFxufSBmcm9tIFwiLi9taWxlc3RvbmVfbWVyZ2Vfc3RhdGUudHNcIjtcbmltcG9ydCB7IHJlcXVpcmVEaXNrU3BhY2VGb3JHaXRPcGVyYXRpb24gfSBmcm9tIFwiLi9kaXNrX3NwYWNlLnRzXCI7XG5pbXBvcnQgeyBPUEVSQVRJT05BTF9ERUZBVUxUUyB9IGZyb20gXCIuL2NvbmZpZ19kZWZhdWx0cy50c1wiO1xuaW1wb3J0IHsgZW5kSGFuZGxlckxhbmRpbmdTdGVwIH0gZnJvbSBcIi4vaGFuZGxlcl93YXRjaGRvZy50c1wiO1xuaW1wb3J0IHsgZW5zdXJlSGlzdG9yeURlcHRoIH0gZnJvbSBcIi4vZ2l0X2hpc3RvcnkudHNcIjtcbmltcG9ydCB7IG1lcmdlV2l0aFVuc2hhbGxvd1JldHJ5IH0gZnJvbSBcIi4vZ2l0X21lcmdlX3Vuc2hhbGxvd19yZXRyeS50c1wiO1xuaW1wb3J0IHtcbiAgY3JlYXRlQ29uZmxpY3RTdGFnZVRpbWVyLFxuICBjdXJyZW50SG9zdCxcbiAgZm9ybWF0U3RhZ2VUaW1pbmdzLFxufSBmcm9tIFwiLi9jb25mbGljdF9zdGFnZV90aW1lci50c1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBNaWxlc3RvbmVTeW5jT3V0Y29tZSxcbiAgc3VtbWFyaXNlR2F0ZVJlcGFpcixcbn0gZnJvbSBcIi4vbWlsZXN0b25lX3N5bmNfY29uZmxpY3QudHNcIjtcbmltcG9ydCB7XG4gIGRlc2NyaWJlUmVwYWlyRXNjYWxhdGlvbixcbiAgcnVuR2F0ZVdpdGhSZXBhaXIsXG59IGZyb20gXCIuL21pbGVzdG9uZV9nYXRlX3JlcGFpci50c1wiO1xuaW1wb3J0IHtcbiAgYW5hbHlzZUNvbmZsaWN0ZWRGaWxlLFxuICBidWlsZFJlc29sdXRpb25Db21taXRNZXNzYWdlLFxuICBkZXNjcmliZURlY2lzaW9uUnVuZyxcbiAgTWlsZXN0b25lQ29uZmxpY3RFc2NhbGF0aW9uLFxuICBwbGFuQ29uZmxpY3RSZXNvbHV0aW9uLFxuICBTWU5DX1VOQ0hFQ0tFRF9OT1RFLFxufSBmcm9tIFwiLi9taWxlc3RvbmVfY29uZmxpY3RfdHJpYWdlLnRzXCI7XG5pbXBvcnQge1xuICBjbGltYkNvbmZsaWN0TGFkZGVyLFxuICBoYXNDb25mbGljdE1hcmtlcnMsXG4gIGxpc3RVbm1lcmdlZFBhdGhzLFxuICB0eXBlIE1pbGVzdG9uZUNvbmZsaWN0QWdlbnRGbixcbn0gZnJvbSBcIi4vbWlsZXN0b25lX2NvbmZsaWN0X2xhZGRlci50c1wiO1xuaW1wb3J0IHtcbiAgYXBwbHlDb25mbGljdFBsYW4sXG4gIHJlYWRDb25mbGljdGVkU2lkZXMsXG4gIHJlYWRNZXJnZUJhc2UsXG4gIHJlYWRUZXN0RXZpZGVuY2UsXG4gIHVuaW9uTWVyZ2VDb25mbGljdGVkRmlsZSxcbn0gZnJvbSBcIi4vbWlsZXN0b25lX2NvbmZsaWN0X2dpdC50c1wiO1xuaW1wb3J0IHsgdmVyaWZ5UmVzb2x2ZWRUcmVlIH0gZnJvbSBcIi4vbWlsZXN0b25lX3Jlc29sdXRpb25fZ2F0ZS50c1wiO1xuaW1wb3J0IHtcbiAgY2hlY2tNZXJnZWRUcmVlLFxuICBtZXJnZUdhdGVGYWlsdXJlRXJyb3IsXG4gIHR5cGUgTWVyZ2VHYXRlRm4sXG4gIHR5cGUgTWVyZ2VHYXRlT3V0Y29tZSxcbn0gZnJvbSBcIi4vbWlsZXN0b25lX21lcmdlX2dhdGUudHNcIjtcblxuLyoqXG4gKiBEZXNjcmliZSBhIGZhaWxlZCBgZ2l0IGNoZWNrb3V0YCB3aXRoIGdpdCdzIG93biBvdXRwdXQgKElzc3VlcyAjNDksICMzMzUpLlxuICpcbiAqIEEgY2hlY2tvdXQgZmFpbHVyZSB0aGF0IG9ubHkgc2F5cyB3aGljaCBicmFuY2ggZmFpbGVkIGNhbm5vdCBiZSBhY3RlZCBvbjpcbiAqIElzc3VlICMzMzUgc2F3IHRoZSBzYW1lIGJyYW5jaCBsb2cgNjUgaWRlbnRpY2FsIHdhcm5pbmdzIGFjcm9zcyBkYXlzIHdpdGhcbiAqIG5vIGRpYWdub3NpcyBpbiBhbnkgb2YgdGhlbS4gR2l0J3Mgb3V0cHV0ICppcyogdGhlIGRpYWdub3NpcyDigJQgYSBtaXNzaW5nXG4gKiByZWYsIGEgZGlydHkgdHJlZSwgYSBsb2NrIGZpbGUg4oCUIHNvIGl0IHRyYXZlbHMgd2l0aCB0aGUgZXJyb3IsIHN0ZG91dFxuICogaW5jbHVkZWQgKElzc3VlICMxOTY0KS5cbiAqXG4gKiBAcGFyYW0gYnJhbmNoTmFtZSAtIFRoZSBicmFuY2ggdGhhdCBjb3VsZCBub3QgYmUgY2hlY2tlZCBvdXRcbiAqIEBwYXJhbSByZXN1bHQgLSBUaGUgYHJ1bkdpdENvbW1hbmRgIHJlc3VsdCBmb3IgdGhlIGZhaWxlZCBjaGVja291dFxuICogQHJldHVybnMgQW4gZXJyb3IgbmFtaW5nIHRoZSBicmFuY2ggYW5kIGdpdCdzIG93biBmYWlsdXJlXG4gKi9cbmZ1bmN0aW9uIGNoZWNrb3V0RmFpbHVyZUVycm9yKFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIHJlc3VsdDogR2l0UnVuUmVzdWx0LFxuKTogRXJyb3Ige1xuICByZXR1cm4gbmV3IEVycm9yKFxuICAgIGBGYWlsZWQgdG8gY2hlY2tvdXQgYnJhbmNoICcke2JyYW5jaE5hbWV9JzogJHtcbiAgICAgIGRlc2NyaWJlR2l0RmFpbHVyZShyZXN1bHQsIHsgbGluZXM6IDYsIGZyb206IFwiaGVhZFwiIH0pXG4gICAgfWAsXG4gICk7XG59XG5cbi8qKlxuICogU3luYyBhIGZlYXR1cmUgYnJhbmNoIHdpdGggdGhlIGxhdGVzdCBkZWZhdWx0IGJyYW5jaCAoSXNzdWVzICMyMzAsICMyODA3KS5cbiAqXG4gKiBNZXJnZXMgdGhlIHB1Ymxpc2hlZCBkZWZhdWx0IGJyYW5jaCAoYG9yaWdpbi88ZGVmYXVsdD5gKSBpbnRvIHRoZSBmZWF0dXJlXG4gKiBicmFuY2gg4oCUIG5ldmVyIGEgcmViYXNlIOKAlCBzbyBhIFBSIHVuZGVyIHJldmlldyBrZWVwcyBpdHMgY29tbWl0cyBhbmQgdGhlXG4gKiByZXZpZXcgY29tbWVudHMgYW5jaG9yZWQgdG8gdGhlbS4gQSBjb25mbGljdGluZyBtZXJnZSBpcyBhYm9ydGVkIGFuZFxuICogcmVwb3J0ZWQgYXMge0BsaW5rIHByQnJhbmNoQ29uZmxpY3RFcnJvcn0sIHRoZSBicmFuY2ggbGVmdCBleGFjdGx5IGFzIGl0XG4gKiB3YXMgZm9yIHRoZSBjb25mbGljdCBsYWRkZXI7IG5vdGhpbmcgaGVyZSBwdXNoZXMuXG4gKlxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgZmVhdHVyZSBicmFuY2ggdG8gc3luY1xuICogQHBhcmFtIGRlZmF1bHRCcmFuY2ggLSBUaGUgZGVmYXVsdCBicmFuY2ggdG8gc3luYyB3aXRoXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnNcbiAqIEByZXR1cm5zIFJlc3VsdCBpbmRpY2F0aW5nIHN1Y2Nlc3Mgb3IgZmFpbHVyZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3luY0ZlYXR1cmVCcmFuY2hXaXRoRGVmYXVsdChcbiAgYnJhbmNoTmFtZTogc3RyaW5nLFxuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmc+PiB7XG4gIC8vIFJlZnVzZSBhbiBvcHRpb24taW5qZWN0aW5nIHJlZiBiZWZvcmUgYW55IGdpdCBydW5zIChJc3N1ZSAjMTIpLlxuICB0cnkge1xuICAgIGFzc2VydFNhZmVHaXRSZWYoYnJhbmNoTmFtZSwgXCJmZWF0dXJlIGJyYW5jaCBuYW1lXCIpO1xuICAgIGFzc2VydFNhZmVSZWZDb21wb25lbnQoZGVmYXVsdEJyYW5jaCwgXCJkZWZhdWx0IGJyYW5jaCBuYW1lXCIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSxcbiAgICB9O1xuICB9XG4gIC8vIFByZS1jaGVjayBkaXNrIHNwYWNlIGJlZm9yZSBmZXRjaC9tZXJnZSAoSXNzdWUgIzExNzQpXG4gIGlmIChvcHRpb25zLmN3ZCkge1xuICAgIGNvbnN0IHNwYWNlQ2hlY2sgPSBhd2FpdCByZXF1aXJlRGlza1NwYWNlRm9yR2l0T3BlcmF0aW9uKFxuICAgICAgb3B0aW9ucy5jd2QsXG4gICAgICBgZ2l0IGZldGNoIG9yaWdpbiAke2JyYW5jaE5hbWV9YCxcbiAgICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLm1pbkRpc2tTcGFjZU1iLFxuICAgICk7XG4gICAgaWYgKCFzcGFjZUNoZWNrLm9rKSB7XG4gICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBzcGFjZUNoZWNrLmVycm9yIH07XG4gICAgfVxuICB9XG5cbiAgLy8gRmlyc3QsIGVuc3VyZSB0aGUgbG9jYWwgZGVmYXVsdCBicmFuY2ggaXMgY3VycmVudFxuICBhd2FpdCBlbnN1cmVEZWZhdWx0QnJhbmNoQ3VycmVudChkZWZhdWx0QnJhbmNoLCBvcHRpb25zKTtcblxuICAvLyBDaGVjayBpZiB3ZSdyZSBhbHJlYWR5IG9uIHRoZSBmZWF0dXJlIGJyYW5jaFxuICBjb25zdCBjdXJyZW50QnJhbmNoUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLWFiYnJldi1yZWZcIiwgXCJIRUFEXCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGNvbnN0IGN1cnJlbnRCcmFuY2ggPSBjdXJyZW50QnJhbmNoUmVzdWx0Lm9rXG4gICAgPyBjdXJyZW50QnJhbmNoUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKClcbiAgICA6IFwiXCI7XG5cbiAgaWYgKGN1cnJlbnRCcmFuY2ggIT09IGJyYW5jaE5hbWUpIHtcbiAgICBjb25zdCBjaGVja291dFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBidWlsZENoZWNrb3V0QXJncyhicmFuY2hOYW1lKSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgICBpZiAoIWNoZWNrb3V0UmVzdWx0Lm9rIHx8IGNoZWNrb3V0UmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAgIC8vIFN1cmZhY2UgZ2l0J3Mgb3duIHN0ZGVyciAoSXNzdWUgIzQ5KTogYSBkaXJ0eSB0cmVlIG9yIGEgbWlzc2luZyByZWYgaXNcbiAgICAgIC8vIHRoZSB3aG9sZSBkaWFnbm9zaXMsIGFuZCB0aGUgb2xkIGVycm9yIGRpc2NhcmRlZCBpdC5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGNoZWNrb3V0RmFpbHVyZUVycm9yKGJyYW5jaE5hbWUsIGNoZWNrb3V0UmVzdWx0KSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgLy8gTWVyZ2UgdGhlIHB1Ymxpc2hlZCB0YXJnZXQgKElzc3VlICMyODA3KTogdGhlIGxvY2FsIGRlZmF1bHQgYnJhbmNoIG1heVxuICAvLyBiZSBoZWxkIGJlaGluZCBieSBhbm90aGVyIGxhbmUncyB3b3JrdHJlZSAoSXNzdWUgIzM5NCkuXG4gIGNvbnN0IGJhc2VSZWYgPSBhd2FpdCByZXNvbHZlUHVibGlzaGVkQmFzZVJlZihkZWZhdWx0QnJhbmNoLCBvcHRpb25zKTtcblxuICAvLyBFbnN1cmUgZW5vdWdoIGhpc3RvcnkgaXMgcHJlc2VudCBmb3IgcmFuZ2UvbWVyZ2Ugb3BzIG9uIGEgc2hhbGxvdyBjbG9uZSAoSXNzdWUgIzE1MDIpXG4gIGF3YWl0IGVuc3VyZUhpc3RvcnlEZXB0aChbXCJIRUFEXCIsIGJhc2VSZWZdLCBvcHRpb25zKTtcblxuICAvLyBDaGVjayBpZiBhIG1lcmdlIGlzIG5lZWRlZFxuICBjb25zdCBiZWhpbmRSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJldi1saXN0XCIsIFwiLS1jb3VudFwiLCBgSEVBRC4uJHtiYXNlUmVmfWBdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGNvbnN0IGJlaGluZENvdW50ID0gYmVoaW5kUmVzdWx0Lm9rICYmIGJlaGluZFJlc3VsdC52YWx1ZS5jb2RlID09PSAwXG4gICAgPyBwYXJzZUludChiZWhpbmRSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSwgMTApIHx8IDBcbiAgICA6IDA7XG5cbiAgaWYgKGJlaGluZENvdW50ID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6XG4gICAgICAgIGBGZWF0dXJlIGJyYW5jaCAnJHticmFuY2hOYW1lfScgaXMgYWxyZWFkeSB1cCB0byBkYXRlIHdpdGggJyR7ZGVmYXVsdEJyYW5jaH0nYCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgbWVyZ2VkID0gYXdhaXQgbWVyZ2VCYXNlSW50b0JyYW5jaChcbiAgICBicmFuY2hOYW1lLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgYmFzZVJlZixcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIW1lcmdlZC5vaykge1xuICAgIC8vIFRoZSBQUiBwcm9jZXNzb3JzIHJ1biBvbiByZWdhcmRsZXNzLCBzbyB0aGUgcmVmdXNhbCBpcyBsb2dnZWQgaGVyZS5cbiAgICBjb25zb2xlLmVycm9yKGBbc3luY10gJHttZXJnZWQuZXJyb3IubWVzc2FnZX1gKTtcbiAgICByZXR1cm4gbWVyZ2VkO1xuICB9XG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6XG4gICAgICBgU3VjY2Vzc2Z1bGx5IHN5bmNlZCAnJHticmFuY2hOYW1lfScgd2l0aCAnJHtkZWZhdWx0QnJhbmNofScgKCR7YmVoaW5kQ291bnR9IGNvbW1pdChzKSBtZXJnZWQgaW4pYCxcbiAgfTtcbn1cblxuLyoqXG4gKiBQdXNoIHRoZSBzeW5jZWQgbWlsZXN0b25lIGJyYW5jaCwgZmFsbGluZyBiYWNrIHRvIGEgcHVsbCByZXF1ZXN0IHdoZW4gYVxuICogcmVwb3NpdG9yeSBydWxlIHJlZnVzZXMgdGhlIHB1c2ggKElzc3VlICM1ODkpLlxuICpcbiAqIFRoZSBnYXRlIHRoYXQgcmVmdXNlcyB0aGUgcHVzaCBpcyB0aGUgc2FtZSBvbmUgdGhhdCBtYWtlcyBhIFBSIGludG8gdGhhdFxuICogYnJhbmNoIGF1dG8tbWVyZ2VhYmxlIChJc3N1ZSAjNTg2KSwgc28gdGhlIGZhbGxiYWNrIGxhbmRzIHRoZSBpZGVudGljYWxcbiAqIG1lcmdlIHVuYXR0ZW5kZWQgcmF0aGVyIHRoYW4gZmFpbGluZyB0aGUgc3luYy4gQSByZXBvc2l0b3J5IHdob3NlIG1pbGVzdG9uZVxuICogYnJhbmNoZXMgYXJlIHVuZ2F0ZWQgbmV2ZXIgcmVhY2hlcyB0aGUgZmFsbGJhY2suXG4gKlxuICogQSBwdXNoIHRoYXQgZmFpbHMgZm9yIGFueXRoaW5nIG90aGVyIHRoYW4gYSByZXBvc2l0b3J5IHJ1bGUgaXMgYSAqKmZhaWxlZFxuICogc3luYyoqIChJc3N1ZSAjMTk2NCk6IGl0IHVzZWQgdG8gcmV0dXJuIGFuIGVtcHR5IG5vdGUsIHNvIHRoZSBicmFuY2ggd2FzXG4gKiBsb2dnZWQgYXMgc3luY2VkLCBjb3VudGVkIGFzIHN5bmNlZCBhbmQgcmVjb3JkZWQgYWdhaW5zdCB0aGUgdGlwIGl0IG5ldmVyXG4gKiByZWFjaGVkIOKAlCB3aGljaCBpcyB0aGUgY2FkZW5jZSBndWFyZCB0aGVuIHNraXBwaW5nIGl0IGV2ZXJ5IGN5Y2xlLlxuICpcbiAqIEByZXR1cm5zIEEgbm90ZSB0byBhcHBlbmQgdG8gdGhlIHN5bmMncyBvdXRjb21lLCBlbXB0eSBvbiB0aGUgb3JkaW5hcnkgcGF0aC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcHVzaFN5bmNlZE1pbGVzdG9uZUJyYW5jaChcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmcsXG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4gIHJlcG8/OiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmc+PiB7XG4gIGNvbnN0IHB1c2ggPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInB1c2hcIiwgXCJvcmlnaW5cIiwgbWlsZXN0b25lQnJhbmNoXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAocHVzaC5vayAmJiBwdXNoLnZhbHVlLmNvZGUgPT09IDApIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogXCJcIiB9O1xuXG4gIC8vIEdpdCdzIG93biBhY2NvdW50IG9mIHRoZSByZWZ1c2FsLCBzdGRvdXQgaW5jbHVkZWQgKElzc3VlICMxOTY0KS5cbiAgY29uc3Qgc3RkZXJyID0gcHVzaC5vayA/IHB1c2gudmFsdWUuc3RkZXJyIDogcHVzaC5lcnJvci5tZXNzYWdlO1xuICBpZiAoIWlzUnVsZVZpb2xhdGlvblB1c2goc3RkZXJyKSkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgRmFpbGVkIHRvIHB1c2ggJyR7bWlsZXN0b25lQnJhbmNofScgdG8gb3JpZ2luLCBzbyB0aGUgbWVyZ2UgaXMgYCArXG4gICAgICAgICAgYGxvY2FsIG9ubHkgKElzc3VlICMxOTY0KTogJHtkZXNjcmliZUdpdEZhaWx1cmUocHVzaCl9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIGlmICghcmVwbykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiBgUFVTSCBSRUZVU0VEIGJ5IGEgcmVwb3NpdG9yeSBydWxlIGFuZCBubyByZXBvc2l0b3J5IHdhcyBuYW1lZCwgYCArXG4gICAgICAgIGBzbyBubyBzeW5jIFBSIGNvdWxkIGJlIHJhaXNlZCAoSXNzdWUgIzU4OSkg4oCUIGAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGdoID0gYXN5bmMgKGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzcGF3bkdoKGFyZ3MpO1xuICAgIGlmICghcmVzdWx0LnN1Y2Nlc3MpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihyZXN1bHQuc3RkZXJyLnRyaW0oKSB8fCBgZ2ggZXhpdGVkICR7cmVzdWx0LmNvZGV9YCk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQuc3Rkb3V0O1xuICB9O1xuICAvLyBJc3N1ZSAjNDE3NTogZG8gbm90IG9wZW4gYSBzeW5jIFBSIGludG8gYSByb3V0ZSB0aGF0IGlzIHN0aWxsIGNsb3NlZC5cbiAgLy8gQW4gb3BlbiBtaWxlc3RvbmUgaXMgcmVzdG9yZWQgZmlyc3QgKGEgZnJlc2ggcm9sbHVwIHdoZW4gdGhlIGJyYW5jaCBpc1xuICAvLyBhaGVhZCkuIEEgY2xvc2VkIG1pbGVzdG9uZSwgb3Igb25lIHdpdGggbm8gb3BlbiB3b3JrLCBpcyBsZWZ0IGFsb25lLlxuICBjb25zdCByZXN0b3JlZCA9IGF3YWl0IHJlc3RvcmVDbG9zZWRNaWxlc3RvbmVSb3V0ZSh7XG4gICAgcmVwbyxcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgZGVmYXVsdEJyYW5jaCxcbiAgICBnaENvbW1hbmRGbjogZ2gsXG4gIH0pO1xuICBpZiAocmVzdG9yZWQuYWN0aW9uID09PSBcImZhaWxlZFwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBzeW5jIFBSIG5vdCBvcGVuZWQgaW50byAnJHttaWxlc3RvbmVCcmFuY2h9JzogdGhlIHJvdXRlIGNvdWxkIG5vdCBiZSByZXN0b3JlZCAoJHtyZXN0b3JlZC5yZWFzb259KWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgLy8gYHdhaXRpbmdgIGhhcyBubyBvcGVuIHJvbGx1cCBlaXRoZXI6IHRoZSBicmFuY2ggaXMgbm90IGFoZWFkLCBzbyBhXG4gIC8vIHN5bmMgUFIgd291bGQgc2l0IG9uIGEgY2xvc2VkIHJvdXRlICh0aGUgIzQxMDAgY2FzZSkuIFNraXAgaXQgdW50aWwgYVxuICAvLyByb2xsdXAgaXMgb3Blbi5cbiAgaWYgKHJlc3RvcmVkLmFjdGlvbiA9PT0gXCJtZXJnZS12aWEtZ2F0ZVwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6XG4gICAgICAgIGBzeW5jIFBSIG5vdCBvcGVuZWQgaW50byAnJHttaWxlc3RvbmVCcmFuY2h9JzogdGhlIGJyYW5jaCBpcyBub3QgYWhlYWQgb2YgJHtkZWZhdWx0QnJhbmNofSwgc28gbm8gcm9sbHVwIGlzIG9wZW4geWV0IChJc3N1ZSAjNDE3NSkg4oCUIGAsXG4gICAgfTtcbiAgfVxuICBpZiAocmVzdG9yZWQuYWN0aW9uID09PSBcImxlZnQtY2xvc2VkXCIgfHwgcmVzdG9yZWQuYWN0aW9uID09PSBcIndhaXRpbmdcIikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOlxuICAgICAgICBgc3luYyBQUiBub3Qgb3BlbmVkIGludG8gJyR7bWlsZXN0b25lQnJhbmNofSc6ICR7cmVzdG9yZWQuZGV0YWlsfSAoSXNzdWUgIzQxNzUpIOKAlCBgLFxuICAgIH07XG4gIH1cbiAgY29uc3QgcmFpc2VkID0gYXdhaXQgcmFpc2VNaWxlc3RvbmVTeW5jUHIoXG4gICAgcmVwbyxcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgZGVmYXVsdEJyYW5jaCxcbiAgICB7XG4gICAgICBnaXQ6IGFzeW5jIChhcmdzKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoYXJncywgb3B0aW9ucyk7XG4gICAgICAgIHJldHVybiByZXN1bHQub2tcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIGNvZGU6IHJlc3VsdC52YWx1ZS5jb2RlLFxuICAgICAgICAgICAgc3RkZXJyOiByZXN1bHQudmFsdWUuc3RkZXJyLFxuICAgICAgICAgICAgc3Rkb3V0OiByZXN1bHQudmFsdWUuc3Rkb3V0LFxuICAgICAgICAgIH1cbiAgICAgICAgICA6IHsgY29kZTogMSwgc3RkZXJyOiByZXN1bHQuZXJyb3IubWVzc2FnZSwgc3Rkb3V0OiBcIlwiIH07XG4gICAgICB9LFxuICAgICAgZ2gsXG4gICAgfSxcbiAgKTtcbiAgaWYgKCFyYWlzZWQub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZTogYFBVU0ggUkVGVVNFRCBieSBhIHJlcG9zaXRvcnkgcnVsZSBhbmQgdGhlIHN5bmMgUFIgY291bGQgbm90IGJlIGAgK1xuICAgICAgICBgcmFpc2VkOiAke3JhaXNlZC5lcnJvci5tZXNzYWdlfSAoSXNzdWUgIzU4OSkg4oCUIGAsXG4gICAgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIHZhbHVlOiBzeW5jUHJMYW5kaW5nTm90ZShyYWlzZWQudmFsdWUpLFxuICB9O1xufVxuXG4vKipcbiAqIFdoZXRoZXIgdGhlIHJlbW90ZSBtaWxlc3RvbmUgYnJhbmNoIGFscmVhZHkgY29udGFpbnMgdGhlIGRlZmF1bHQgdGlwIOKAlFxuICogYSBzaWJsaW5nIGhvc3QgbGFuZGVkIHRoaXMgc3luYyB3aGlsZSB0aGlzIG9uZSB3YXMgcmVzb2x2aW5nIGl0XG4gKiAoSXNzdWUgIzIwMzApLlxuICpcbiAqIFJlYWQgcmlnaHQgYmVmb3JlIHRoZSBnYXRlIGFuZCBwdXNoOiB0aGUgcHJlLW1lcmdlIGZldGNoIGNhbm5vdCBzZWUgYVxuICogc3luYyB0aGF0IGxhbmRlZCBkdXJpbmcgdGhlIGFnZW50IHJ1bmcuIFdoZW4gaXQgaGFzLCB0aGUgbG9jYWwgbWVyZ2UgaXNcbiAqIGRpc2NhcmRlZCBmb3IgdGhlIHJlbW90ZSdzLCBhbmQgdGhlIG91dGNvbWUgaXMgYSBzdWNjZXNzIHdpdGggbm8gcHVzaCDigJRcbiAqIHRoZSBicmFuY2ggaXMgc3luY2VkLCB3aGljaCBpcyBhbGwgdGhlIHN5bmMgZXZlciB3YW50ZWQuIEEgcmVhZCB0aGF0XG4gKiBmYWlscyBhbnN3ZXJzIGBmYWxzZWA6IHRoZSBwdXNoIHRoYXQgZm9sbG93cyBpcyB3aGF0IHRoZW4gcmVmdXNlcyBhIG1vdmVkXG4gKiBicmFuY2gsIGV4YWN0bHkgYXMgYmVmb3JlLlxuICovXG5hc3luYyBmdW5jdGlvbiBhbHJlYWR5U3luY2VkRWxzZXdoZXJlKFxuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZyxcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBmZXRjaGVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBidWlsZEZldGNoQXJncyhcIm9yaWdpblwiLCBtaWxlc3RvbmVCcmFuY2gpLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghZmV0Y2hlZC5vayB8fCBmZXRjaGVkLnZhbHVlLmNvZGUgIT09IDApIHJldHVybiBmYWxzZTtcbiAgLy8gVGhlIHRpcCB0aGlzIHN5bmMgbWVyZ2VkIGlzIHRoZSBsb2NhbCBkZWZhdWx0IGJyYW5jaCwga2VwdCBjdXJyZW50IGJ5XG4gIC8vIGBlbnN1cmVEZWZhdWx0QnJhbmNoQ3VycmVudGA7IGEgY2xvbmUgd2l0aG91dCBhIGxvY2FsIG9uZSAoYSBiYXJlLW9yaWdpblxuICAvLyB0ZXN0IGZpeHR1cmUsIGEgbmFycm93IGNoZWNrb3V0KSBmYWxscyBiYWNrIHRvIHRoZSByZW1vdGUtdHJhY2tpbmcgcmVmLlxuICBjb25zdCBsb2NhbCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wicmV2LXBhcnNlXCIsIFwiLS12ZXJpZnlcIiwgXCItLXF1aWV0XCIsIGAke2RlZmF1bHRCcmFuY2h9Xntjb21taXR9YF0sXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgY29uc3QgZGVmYXVsdFJlZiA9IGxvY2FsLm9rICYmIGxvY2FsLnZhbHVlLmNvZGUgPT09IDBcbiAgICA/IGRlZmF1bHRCcmFuY2hcbiAgICA6IGByZWZzL3JlbW90ZXMvb3JpZ2luLyR7ZGVmYXVsdEJyYW5jaH1gO1xuICBjb25zdCBjb250YWlucyA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1xuICAgICAgXCJtZXJnZS1iYXNlXCIsXG4gICAgICBcIi0taXMtYW5jZXN0b3JcIixcbiAgICAgIGRlZmF1bHRSZWYsXG4gICAgICBgcmVmcy9yZW1vdGVzL29yaWdpbi8ke21pbGVzdG9uZUJyYW5jaH1gLFxuICAgIF0sXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgcmV0dXJuIGNvbnRhaW5zLm9rICYmIGNvbnRhaW5zLnZhbHVlLmNvZGUgPT09IDA7XG59XG5cbi8qKiBBZG9wdCB0aGUgcmVtb3RlJ3MgYWxyZWFkeS1zeW5jZWQgYnJhbmNoIGluIHBsYWNlIG9mIHRoZSBsb2NhbCBtZXJnZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGFkb3B0UmVtb3RlU3luYyhcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmcsXG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDxNaWxlc3RvbmVTeW5jT3V0Y29tZT4+IHtcbiAgY29uc3QgcmVzZXQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJlc2V0XCIsIFwiLS1oYXJkXCIsIGByZWZzL3JlbW90ZXMvb3JpZ2luLyR7bWlsZXN0b25lQnJhbmNofWBdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghcmVzZXQub2sgfHwgcmVzZXQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgJyR7bWlsZXN0b25lQnJhbmNofScgd2FzIHN5bmNlZCB3aXRoICcke2RlZmF1bHRCcmFuY2h9JyBieSBhbm90aGVyIGAgK1xuICAgICAgICAgIGBob3N0IG1lYW53aGlsZSwgYnV0IHRoZSBsb2NhbCBtZXJnZSBjb3VsZCBub3QgYmUgcmVwbGFjZWQgYnkgaXQ6ICR7XG4gICAgICAgICAgICBkZXNjcmliZUdpdEZhaWx1cmUocmVzZXQpXG4gICAgICAgICAgfSAoSXNzdWUgIzIwMzApYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIHZhbHVlOiB7XG4gICAgICBtZXNzYWdlOiBgQUxSRUFEWSBTWU5DRUQgYnkgYW5vdGhlciBob3N0IHdoaWxlIHRoaXMgb25lIHdhcyByZXNvbHZpbmcgYCArXG4gICAgICAgIGDigJQgbG9jYWwgbWVyZ2UgZGlzY2FyZGVkLCByZW1vdGUgJyR7bWlsZXN0b25lQnJhbmNofScgYWRvcHRlZCwgYCArXG4gICAgICAgIGBub3RoaW5nIHB1c2hlZCAoSXNzdWUgIzIwMzApYCxcbiAgICB9LFxuICB9O1xufVxuXG4vKipcbiAqIFR5cGUtY2hlY2sgdGhlIG1lcmdlZCB0cmVlLCB0aGVuIHB1c2ggaXQg4oCUIG9yIHJlZnVzZSAoSXNzdWUgIzk3NCkuXG4gKlxuICogR2l0IHJlcG9ydGluZyBubyBjb25mbGljdCBzYXlzIG9ubHkgdGhhdCBib3RoIHNpZGVzIHdlcmUgaW50ZXJuYWxseVxuICogY29uc2lzdGVudDsgdGhyZWUgbWVyZ2VzIHRoYXQgcGFzc2VkIHRoYXQgYmFyIGRlbGV0ZWQgbGl2ZSB3aXJpbmcgYW5kIHdlcmVcbiAqIHB1c2hlZCB1bmNoZWNrZWQsIGJlY2F1c2UgYG1pbGVzdG9uZS8qYCBoYXMgbm8gcmVxdWlyZWQgY2hlY2tzIHRvIGNhdGNoIHRoZVxuICogcmVzdWx0IGRvd25zdHJlYW0uIFNvIHRoZSBtZXJnZSBjb21taXQgaXMganVkZ2VkIGJlZm9yZSBpdCBpcyBwdWJsaXNoZWQ6IGl0XG4gKiBpcyBwdXNoZWQgd2hlbiB0aGUgcmVwb3NpdG9yeSdzIG93biB0eXBlIGNoZWNrIHBhc3NlcywgYW5kIHJlc2V0IGF3YXkgd2l0aFxuICogYSB0eXBlZCByZWZ1c2FsIHdoZW4gaXQgZG9lcyBub3QuXG4gKlxuICogQHBhcmFtIHByZU1lcmdlU2hhIC0gV2hlcmUgdGhlIGJyYW5jaCBzdG9vZCBiZWZvcmUgdGhlIG1lcmdlLCBzbyBhIHJlamVjdGVkXG4gKiAgIG1lcmdlIGNhbiBiZSB1bmRvbmUgZXhhY3RseVxuICogQHJldHVybnMgVGhlIG5vdGUgdG8gYXBwZW5kIHRvIHRoZSBzeW5jIG91dGNvbWUsIG9yIHRoZSBnYXRlJ3MgcmVmdXNhbFxuICovXG5hc3luYyBmdW5jdGlvbiBnYXRlVGhlblB1c2hNaWxlc3RvbmVCcmFuY2goXG4gIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nLFxuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuICByZXBvOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIG1lcmdlR2F0ZTogTWVyZ2VHYXRlRm4sXG4gIHByZU1lcmdlU2hhOiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmc+PiB7XG4gIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBtZXJnZUdhdGUob3B0aW9ucy5jd2QgPz8gXCIuXCIpO1xuXG4gIGlmIChvdXRjb21lLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikge1xuICAgIC8vIFRoZSBjYWxsZXIgcmVmdXNlcyB0byBtZXJnZSBhdCBhbGwgd2l0aG91dCBhIHByZS1tZXJnZSBTSEEsIHNvIHRoZXJlIGlzXG4gICAgLy8gYWx3YXlzIG9uZSB0byByb2xsIGJhY2sgdG8gaGVyZS5cbiAgICBsZXQgcmVzZXROb3RlID0gXCJcIjtcbiAgICBjb25zdCByZXNldCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBbXCJyZXNldFwiLCBcIi0taGFyZFwiLCBwcmVNZXJnZVNoYV0sXG4gICAgICBvcHRpb25zLFxuICAgICk7XG4gICAgaWYgKCFyZXNldC5vayB8fCByZXNldC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgICAvLyBzdGRvdXQgY291bnRzIGFzIG11Y2ggYXMgc3RkZXJyIGhlcmUgKElzc3VlICMxOTY0KS5cbiAgICAgIHJlc2V0Tm90ZSA9IGAg4oCUIGFuZCB0aGUgbG9jYWwgbWVyZ2UgY291bGQgTk9UIGJlIHJlc2V0IHRvIGAgK1xuICAgICAgICBgJHtwcmVNZXJnZVNoYX06ICR7ZGVzY3JpYmVHaXRGYWlsdXJlKHJlc2V0KX1gO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG1lcmdlR2F0ZUZhaWx1cmVFcnJvcihtaWxlc3RvbmVCcmFuY2gsIGRlZmF1bHRCcmFuY2gsIHtcbiAgICAgICAgLi4ub3V0Y29tZSxcbiAgICAgICAgZGV0YWlsOiBgJHtvdXRjb21lLmRldGFpbH0ke3Jlc2V0Tm90ZX1gLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHB1c2hOb3RlID0gYXdhaXQgcHVzaFN5bmNlZE1pbGVzdG9uZUJyYW5jaChcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgZGVmYXVsdEJyYW5jaCxcbiAgICBvcHRpb25zLFxuICAgIHJlcG8sXG4gICk7XG4gIC8vIEEgcHVzaCB0aGF0IGRpZCBub3QgaGFwcGVuIGlzIG5vdCBhIHN5bmMgKElzc3VlICMxOTY0KS5cbiAgaWYgKCFwdXNoTm90ZS5vaykgcmV0dXJuIHB1c2hOb3RlO1xuICAvLyBTYXkgd2hlbiBub3RoaW5nIHZlcmlmaWVkIHRoZSB0cmVlLCByYXRoZXIgdGhhbiBsZXQgYW4gdW5jaGVja2VkIHB1c2hcbiAgLy8gcmVhZCBleGFjdGx5IGxpa2UgYSBjaGVja2VkIG9uZS5cbiAgLy8gQSBwYXNzZWQgdHJlZSB3aG9zZSBEZW5vIHRhc2sgY291bGQgbm90IGZldGNoIGl0cyByZW1vdGUgbW9kdWxlcyAoSXNzdWVcbiAgLy8gIzQ0MjIpIGlzIHB1c2hlZCwgYnV0IHRoYXQgdGFzayBkaWQgbm90IHJ1bjogdGhlIG5vdGUgc2F5cyBzbywgYW5kIHRoZVxuICAvLyBkZXRhaWwgYWxyZWFkeSBjYXJyaWVzIGFueSBjYXJnbyBub3RlLlxuICAvLyBUaGUgbGFiZWxzIGFyZSBTWU5DX1VOQ0hFQ0tFRF9OT1RFJ3MsIHdoaWNoIHRoZSByZXNvbHV0aW9uIGNvbW1pdCBtZXNzYWdlXG4gIC8vIG5hbWVzIG9uZSBieSBvbmUgKElzc3VlICM0NDQxKS5cbiAgY29uc3QgbiA9IFNZTkNfVU5DSEVDS0VEX05PVEU7XG4gIGNvbnN0IGdhdGVOb3RlID0gb3V0Y29tZS5zdGF0dXMgPT09IFwic2tpcHBlZFwiXG4gICAgPyBgJHtuLnVuZ2F0ZWR9OiAke291dGNvbWUuZGV0YWlsfSAoSXNzdWUgIzk3NCkg4oCUIGBcbiAgICA6IG91dGNvbWUuY2hlY2tMZWZ0VG9DaVxuICAgID8gYCR7bi5jaGVja0xlZnRUb0NpfTogJHtvdXRjb21lLmRldGFpbH0gKElzc3VlICM0NDQxKSDigJQgYFxuICAgIDogb3V0Y29tZS5zdWl0ZUxlZnRUb0NpXG4gICAgPyBgJHtuLnN1aXRlTGVmdFRvQ2l9OiAke291dGNvbWUuZGV0YWlsfSAoSXNzdWUgIzQ0MjIpIOKAlCBgXG4gICAgOiBvdXRjb21lLmNhcmdvU2tpcHBlZFxuICAgID8gYCR7bi5jYXJnb1NraXBwZWR9OiAke291dGNvbWUuZGV0YWlsfSAoSXNzdWUgIzQzMjYpIOKAlCBgXG4gICAgOiBcIlwiO1xuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGAke2dhdGVOb3RlfSR7cHVzaE5vdGUudmFsdWV9YCB9O1xufVxuXG4vKiogUmVzb2x2ZSBhIHJlZiB0byBpdHMgY29tbWl0IFNIQTsgZW1wdHkgc3RyaW5nIHdoZW4gaXQgY2Fubm90IGJlIHJlYWQuICovXG5hc3luYyBmdW5jdGlvbiByZWFkUmVmKFxuICByZWY6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcInJldi1wYXJzZVwiLCByZWZdLCBvcHRpb25zKTtcbiAgcmV0dXJuIHJlc3VsdC5vayAmJiByZXN1bHQudmFsdWUuY29kZSA9PT0gMCA/IHJlc3VsdC52YWx1ZS5zdGRvdXQudHJpbSgpIDogXCJcIjtcbn1cblxuLyoqXG4gKiBTeW5jIGEgbWlsZXN0b25lIGJyYW5jaCB3aXRoIHRoZSBkZWZhdWx0IGJyYW5jaCAoSXNzdWUgIzQyMiwgIzYwNSkuXG4gKlxuICogVXNlcyBtZXJnZSAobm90IHJlYmFzZSkgdG8gcHJlc2VydmUgbWlsZXN0b25lIGNvbW1pdCBoaXN0b3J5LiBUaGUgbWVyZ2UgaXNcbiAqIHR5cGUtY2hlY2tlZCBiZWZvcmUgaXQgaXMgcHVzaGVkIChJc3N1ZSAjOTc0KSDigJQgc2VlXG4gKiB7QGxpbmsgZ2F0ZVRoZW5QdXNoTWlsZXN0b25lQnJhbmNofS5cbiAqXG4gKiBBIG1lcmdlIHRoYXQgY29uZmxpY3RzIGlzIHRyaWFnZWQgcmF0aGVyIHRoYW4gcmVzb2x2ZWQgdG93YXJkcyB0aGUgZGVmYXVsdFxuICogYnJhbmNoIG9uIHNpZ2h0IChJc3N1ZSAjMTU1OSkuIFdoZXJlIGFuIGF1dG9tYXRpYyBydWxlIGNhbiBkZWNpZGUgdGhlXG4gKiBjb25mbGljdCDigJQgdGhlIHNhbWUgZml4IGxhbmRlZCB0d2ljZSwgb3Igb25lIHNpZGUga2VlcHMgZXZlcnkgbGluZSBvZiB0aGVcbiAqIG90aGVyIOKAlCB0aGUgZGVjaXNpb24gaXMgYXBwbGllZCwgcmVjb3JkZWQgb24gdGhlIG1lcmdlIGNvbW1pdCwgdmVyaWZpZWRcbiAqIGFnYWluc3QgdGhlIHJlcG9zaXRvcnkncyBvd24gY2hlY2ssIG1hbmlmZXN0IGNoZWNrIGFuZCB1bml0IHN1aXRlLCBhbmQgb25seVxuICogdGhlbiBwdXNoZWQuIEEgbWVyZ2Utb25seSBzeW5jIChJc3N1ZSAjNDMyNikgb2YgYSBjYXJnby1vbmx5IHRyZWUgcHVzaGVzIGl0XG4gKiB1bnZlcmlmaWVkIHdpdGggdGhlIGBVTkdBVEVEOmAgbm90ZSBpbnN0ZWFkLCBsZWF2aW5nIHRoZSBjYXJnbyBidWlsZCB0byB0aGVcbiAqIG1pbGVzdG9uZSBQUidzIENJLiBBIERlbm8tb25seSB0cmVlIGFuZCBhIG1peGVkIHRyZWUga2VlcCB0aGVpciBEZW5vIGNoZWNrc1xuICogYW5kIHN1aXRlcyBhbmQgYXJlIHJvbGxlZCBiYWNrIHdoZW4gcmVkLiBBIG1peGVkIHRyZWUgd2hvc2UgRGVubyBoYWxmXG4gKiBwYXNzZWQgY2FycmllcyBhIGBDQVJHTyBTS0lQUEVEOmAgbm90ZSwgc28gdGhlIHJlcG9ydCBkb2VzIG5vdCBjbGFpbSB0aGVcbiAqIGNhcmdvIGhhbGYgcGFzc2VkLiBBIHJlc29sdmVkIHRyZWUgd2hvc2UgRGVubyB0YXNrIGNvdWxkIG5vdCBmZXRjaCBpdHNcbiAqIHJlbW90ZSBtb2R1bGVzIChJc3N1ZSAjNDQyMikgY2FycmllcyBhIGBURVNUUyBMRUZUIFRPIENJOmAgbm90ZSBuYW1pbmcgdGhhdFxuICogdGFzayAob3IgYSBgQ0hFQ0sgTEVGVCBUTyBDSTpgIG5vdGUgd2hvc2UgZGV0YWlsIG5hbWVzIGl0LCB3aGVuIHRoZSB0eXBlXG4gKiBjaGVjayB3YXMgbGVmdCB0byBDSSB0b28pLCBzbyB0aGUgcmVwb3J0IGRvZXMgbm90IGNsYWltIGl0IHBhc3NlZC4gQSByZXNvbHZlZCB0cmVlIHdob3NlIElzc3VlXG4gKiAjOTc0IHR5cGUgY2hlY2sgY291bGQgbm90IGZldGNoIGl0cyByZW1vdGUgbW9kdWxlcyBjYXJyaWVzIGFcbiAqIGBDSEVDSyBMRUZUIFRPIENJOmAgbm90ZSAoSXNzdWUgIzQ0NDEpIGZvciB0aGUgc2FtZSByZWFzb24uXG4gKlxuICogV2hhdCB0aGUgdHJpYWdlIGNhbm5vdCBkZWNpZGUgY2xpbWJzIHRoZSByZXN0IG9mIHRoZSBsYWRkZXIgdGhlIFBSIHBhc3NcbiAqIGNsaW1icyAoSXNzdWUgIzE3NzcpOiB0aGUgZGV0ZXJtaW5pc3RpYyBkZXBlbmRlbmN5IHJ1bGVzLCB0aGVuIHRoZVxuICogcmVzb2x1dGlvbiBhZ2VudCwgZWFjaCBvdmVyIHRoZSBwYXRocyBzdGlsbCBsZWZ0LiBPbmx5IGEgZmlsZSBldmVyeSBydW5nXG4gKiBsZWF2ZXMgdW5kZWNpZGVkIGFib3J0cyB0aGUgbWVyZ2UsIGFuZCB0aGUgcmVmdXNhbCB0aGVuIGNhcnJpZXMgYm90aCBzaWRlc1xuICogcHJlcGFyZWQgZm9yIGEgaHVtYW4sIG5hbWluZyB0aGUgcnVuZyB0aGF0IGZhaWxlZC4gRWl0aGVyIHdheSB0aGUgY29uZmxpY3RcbiAqIHRyYXZlbHMgYmFjayB3aXRoIHRoZSBvdXRjb21lIChJc3N1ZSAjMTU1OCk6IHRoZSBmaWxlcyB0aGF0IGNvbGxpZGVkLCB0aGVcbiAqIGNvbW1pdCBlYWNoIHNpZGUgc3Rvb2QgYXQsIGFuZCB0aGUgcnVuZyB0aGF0IHNldHRsZWQgZWFjaCBmaWxlLlxuICpcbiAqIEJlZm9yZSBhbnkgb2YgdGhhdCwgdGhlIGxvY2FsIGRlZmF1bHQgYnJhbmNoIHJlZiBpcyBib3RoIHJlZnJlc2hlZCBBTkRcbiAqIHBvc2l0aXZlbHkgdmVyaWZpZWQgYWdhaW5zdCBgb3JpZ2luLzxkZWZhdWx0QnJhbmNoPmAgKElzc3VlICMyODk2KTpcbiAqIGBlbnN1cmVEZWZhdWx0QnJhbmNoQ3VycmVudCgpYCBpZ25vcmVzIHRoZSByZXN1bHQgb2YgaXRzIG93biBgYnJhbmNoIC1mYCAvXG4gKiBgcmVzZXQgLS1oYXJkYCwgc28gaXRzIHN1Y2Nlc3MgZG9lcyBub3QgcHJvdmUgdGhlIHJlZiBhY3R1YWxseSBtb3ZlZCDigJQgYVxuICogc3RhbGUgcmVmIChlLmcuIGJlY2F1c2UgYW5vdGhlciB3b3JrdHJlZSBob2xkcyB0aGUgYnJhbmNoLCBJc3N1ZSAjMzk0KVxuICogd291bGQgb3RoZXJ3aXNlIGJlIG1lcmdlZCBpbiBzaWxlbnRseS4gVGhlIHNoYWxsb3ctY2xvbmUgZGVlcGVuXG4gKiAoYGVuc3VyZUhpc3RvcnlEZXB0aCgpYCkgaXMgY2hlY2tlZCB0aGUgc2FtZSB3YXk6IGEgZGVlcGVuIHRoYXQgY291bGQgbm90XG4gKiByZWFjaCB0aGUgbWVyZ2UgYmFzZSBpcyByZWZ1c2VkIGxvdWRseSByYXRoZXIgdGhhbiBsZWZ0IHRvIHN1cmZhY2UgbGF0ZXIgYXNcbiAqIGFuIG9wYXF1ZSBcInVucmVsYXRlZCBoaXN0b3JpZXNcIiBtZXJnZSBmYWlsdXJlLiBTaG91bGQgdGhlIG1lcmdlIGl0c2VsZlxuICogc3RpbGwgcmVmdXNlIHdpdGggXCJ1bnJlbGF0ZWQgaGlzdG9yaWVzXCIgb24gYSBzaGFsbG93IGNsb25lLCBpdCBpc1xuICogdW5zaGFsbG93ZWQgYW5kIHJldHJpZWQgZXhhY3RseSBvbmNlIOKAlCBzZWVcbiAqIHtAbGluayBtZXJnZVdpdGhVbnNoYWxsb3dSZXRyeX0g4oCUIGJlZm9yZSBmYWxsaW5nIHRocm91Z2ggdG8gdGhlIG9yZGluYXJ5XG4gKiBjb25mbGljdCAvIG5vbi1jb25mbGljdCBoYW5kbGluZyBiZWxvdy5cbiAqXG4gKiBAcGFyYW0gbWlsZXN0b25lQnJhbmNoIC0gVGhlIG1pbGVzdG9uZSBicmFuY2ggbmFtZVxuICogQHBhcmFtIGRlZmF1bHRCcmFuY2ggLSBUaGUgZGVmYXVsdCBicmFuY2ggdG8gc3luYyBmcm9tXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnNcbiAqIEByZXR1cm5zIFJlc3VsdCBjYXJyeWluZyB0aGUgc3VtbWFyeSwgYW5kIHRoZSBjb25mbGljdCB3aGVuIHRoZXJlIHdhcyBvbmVcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN5bmNNaWxlc3RvbmVCcmFuY2hXaXRoRGVmYXVsdChcbiAgLi4uYXJnczogUGFyYW1ldGVyczx0eXBlb2Ygc3luY01pbGVzdG9uZUJyYW5jaFdpdGhEZWZhdWx0Qm9keT5cbik6IFByb21pc2U8UmVzdWx0PE1pbGVzdG9uZVN5bmNPdXRjb21lPj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBzeW5jTWlsZXN0b25lQnJhbmNoV2l0aERlZmF1bHRCb2R5KC4uLmFyZ3MpO1xuICB9IGZpbmFsbHkge1xuICAgIC8vIFRoZSBjb25mbGljdCBhZ2VudCBtYXJrcyBjb21taXQvcHVzaCBhcyBzdGlsbCBsYW5kaW5nIChJc3N1ZSAjNDE3MykuXG4gICAgLy8gQ2xlYXIgaXQgaGVyZSBzbyBhIGxhdGVyIHdlZGdlIGluIHRoaXMgc2FtZSBoYW5kbGVyIGlzIG5vdCB0cmVhdGVkIGFzXG4gICAgLy8gdGhhdCBsYW5kaW5nLiBBIG5vLW9wIHdoZW4gbm8gc3RlcCB3YXMgYmVndW4uXG4gICAgZW5kSGFuZGxlckxhbmRpbmdTdGVwKCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gc3luY01pbGVzdG9uZUJyYW5jaFdpdGhEZWZhdWx0Qm9keShcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmcsXG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbiAgLyoqXG4gICAqIGBvd25lci9yZXBvYCwgbmVlZGVkIG9ubHkgdG8gcmFpc2UgYSBzeW5jIFBSIHdoZW4gYSByZXBvc2l0b3J5IHJ1bGVcbiAgICogcmVmdXNlcyB0aGUgcHVzaCAoSXNzdWUgIzU4OSkuIEFic2VudCBrZWVwcyB0aGUgcHJldmlvdXMgYmVoYXZpb3VyIGFuZFxuICAgKiBzYXlzIHNvIGluIHRoZSBvdXRjb21lIHJhdGhlciB0aGFuIGZhaWxpbmcgc2lsZW50bHkuXG4gICAqL1xuICByZXBvPzogc3RyaW5nLFxuICAvKipcbiAgICogVGhlIGdhdGUgdGhlIG1lcmdlZCB0cmVlIG11c3QgcGFzcyBiZWZvcmUgaXQgaXMgcHVzaGVkIChJc3N1ZSAjOTc0KS5cbiAgICogRGVmYXVsdHMgdG8gdGhlIHJlcG9zaXRvcnkncyBvd24gdHlwZSBjaGVjazsgdGVzdHMgaW5qZWN0IGEgdmVyZGljdC5cbiAgICovXG4gIG1lcmdlR2F0ZTogTWVyZ2VHYXRlRm4gPSBjaGVja01lcmdlZFRyZWUsXG4gIC8qKlxuICAgKiBUaGUgZ2F0ZSBhIG1lcmdlIHdob3NlIGNvbmZsaWN0cyB0aGUgd29ya2VyIHJlc29sdmVkIGl0c2VsZiBtdXN0IHBhc3NcbiAgICogKElzc3VlICMxNTU5KS4gU3RyaWN0ZXIgdGhhbiB0aGUgdHlwZSBjaGVjayBhYm92ZSwgYmVjYXVzZSBjaG9vc2luZyBhXG4gICAqIHNpZGUgY29tcGlsZXMgcGVyZmVjdGx5IGFuZCBzdGlsbCBkcm9wcyB0aGUgb3RoZXIgc2lkZSdzIGJlaGF2aW91ciDigJQgc29cbiAgICogdGhlIHJlcG9zaXRvcnkncyBvd24gY2hlY2ssIG1hbmlmZXN0IGNoZWNrIGFuZCB1bml0IHN1aXRlIGFsbCBydW4uXG4gICAqXG4gICAqIEEgY2FsbGVyIHRoYXQgaW5qZWN0ZWQgaXRzIG93biBgbWVyZ2VHYXRlYCBnZXRzIHRoYXQgZ2F0ZSBoZXJlIHRvbzogYVxuICAgKiBzeW5jIHdob3NlIHZlcmlmaWNhdGlvbiBpcyBzdHViYmVkIHN0YXlzIHN0dWJiZWQgb24gYm90aCBwYXRocy5cbiAgICovXG4gIHJlc29sdXRpb25HYXRlOiBNZXJnZUdhdGVGbiA9IG1lcmdlR2F0ZSA9PT0gY2hlY2tNZXJnZWRUcmVlXG4gICAgPyB2ZXJpZnlSZXNvbHZlZFRyZWVcbiAgICA6IG1lcmdlR2F0ZSxcbiAgLyoqXG4gICAqIFRoZSByZXNvbHV0aW9uIGFnZW50LCB0aGUgbGFkZGVyJ3MgbGFzdCBydW5nIGJlZm9yZSBhIGh1bWFuXG4gICAqIChJc3N1ZSAjMTc3NykuIEluamVjdGVkIHNvIGEgdGVzdCBuZWVkcyBubyBtb2RlbCwgYW5kIHNvIGEgY2FsbGVyIHRoYXRcbiAgICogY2Fubm90IHJ1biBvbmUgc2ltcGx5IHN0b3BzIGFmdGVyIHRoZSBkZXBlbmRlbmN5IHJ1bGVzIHJhdGhlciB0aGFuXG4gICAqIHByZXRlbmRpbmcgdGhlIGNvbmZsaWN0IHdhcyBkZWNpZGVkLlxuICAgKi9cbiAgYWdlbnRGbj86IE1pbGVzdG9uZUNvbmZsaWN0QWdlbnRGbixcbiAgLyoqIExvZ2dlciBmb3IgdGhlIGxhZGRlcidzIGRpYWdub3N0aWNzOyBhYnNlbnQgbG9ncyBub3RoaW5nLiAqL1xuICBsb2dnZXI/OiBMb2dnZXIsXG4gIC8qKlxuICAgKiBUaGUgY2xvY2sgdGhlIHN0YWdlIHRpbWluZ3MgYXJlIG1lYXN1cmVkIGFnYWluc3QgKElzc3VlICMyMzA4KS4gSW5qZWN0ZWRcbiAgICogc28gYSB0ZXN0IGNhbiBhc3NlcnQgd2hpY2ggc3RhZ2UgYSBydW4ncyBzZWNvbmRzIGxhbmRlZCBpbiB3aXRob3V0IGV2ZXJcbiAgICogcmVhZGluZyBhIHdhbGwgY2xvY2suXG4gICAqL1xuICBub3dNc0ZuOiAoKSA9PiBudW1iZXIgPSAoKSA9PiBEYXRlLm5vdygpLFxuKTogUHJvbWlzZTxSZXN1bHQ8TWlsZXN0b25lU3luY091dGNvbWU+PiB7XG4gIC8vIFJlZnVzZSBhbiBvcHRpb24taW5qZWN0aW5nIHJlZiBiZWZvcmUgYW55IGdpdCBydW5zIChJc3N1ZSAjMTIpLiBUaGVcbiAgLy8gZGVmYXVsdCBicmFuY2ggdXNlZCB0byBiZSByZXBvLWRlcml2ZWQgKHNldHVwUmVwbyByZWFkIGl0IGZyb21cbiAgLy8gYC52aWJlX2RlZmF1bHRfYnJhbmNoYCBpbnNpZGUgdGhlIGNsb25lLCBJc3N1ZSAjMTI2OTsgaXQgbm93IGxpdmVzIGluXG4gIC8vIGAuZ2l0L3ZpYmUvZGVmYXVsdF9icmFuY2hgLCBJc3N1ZSAjMTY1MikgYW5kIHJlYWNoZXNcbiAgLy8gYGdpdCBtZXJnZSA8ZGVmYXVsdEJyYW5jaD5gIGJlbG93IGFzIGEgYmFyZSBwb3NpdGlvbmFsLCB3aGljaCB0aGUgcmVmLWFyZ3ZcbiAgLy8gZ2F0ZSBkb2VzIG5vdCBjb3ZlciDigJQgc28gaXQgaXMgY2hlY2tlZCBoZXJlLCBhcyB0aGUgZmVhdHVyZS1icmFuY2ggc3luY1xuICAvLyBhbHJlYWR5IGRvZXMuXG4gIHRyeSB7XG4gICAgYXNzZXJ0U2FmZUdpdFJlZihtaWxlc3RvbmVCcmFuY2gsIFwibWlsZXN0b25lIGJyYW5jaCBuYW1lXCIpO1xuICAgIGFzc2VydFNhZmVSZWZDb21wb25lbnQoZGVmYXVsdEJyYW5jaCwgXCJkZWZhdWx0IGJyYW5jaCBuYW1lXCIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gUHJlLWNoZWNrIGRpc2sgc3BhY2UgYmVmb3JlIHB1bGwvbWVyZ2UgKElzc3VlICMxMTc0KVxuICBpZiAob3B0aW9ucy5jd2QpIHtcbiAgICBjb25zdCBzcGFjZUNoZWNrID0gYXdhaXQgcmVxdWlyZURpc2tTcGFjZUZvckdpdE9wZXJhdGlvbihcbiAgICAgIG9wdGlvbnMuY3dkLFxuICAgICAgYGdpdCBwdWxsIG9yaWdpbiAke21pbGVzdG9uZUJyYW5jaH1gLFxuICAgICAgT1BFUkFUSU9OQUxfREVGQVVMVFMubWluRGlza1NwYWNlTWIsXG4gICAgKTtcbiAgICBpZiAoIXNwYWNlQ2hlY2sub2spIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHNwYWNlQ2hlY2suZXJyb3IgfTtcbiAgICB9XG4gIH1cblxuICAvLyBFbnN1cmUgdGhlIGxvY2FsIGRlZmF1bHQgYnJhbmNoIGlzIGN1cnJlbnQgKElzc3VlICMyODk2KS4gQSBzdGFsZSBsb2NhbFxuICAvLyByZWYgbWVyZ2VkIGludG8gdGhlIG1pbGVzdG9uZSBicmFuY2ggc2lsZW50bHkgY2FycmllcyB3aGF0ZXZlciBjb21taXRcbiAgLy8gaGFwcGVuZWQgdG8gYmUgc2l0dGluZyB0aGVyZSDigJQgcG9zc2libHkgZGF5cyBiZWhpbmQgb3JpZ2luLCBhbmQgcG9zc2libHlcbiAgLy8gZXZlbiBhbiBhbmNlc3RvciB0aGUgbWlsZXN0b25lIGJyYW5jaCBjYW5ub3QgZmluZCBhIG1lcmdlIGJhc2UgZm9yIGluIGFcbiAgLy8gc2hhbGxvdyBjbG9uZSwgd2hpY2ggZ2l0IHRoZW4gcmVmdXNlcyBhcyBcInVucmVsYXRlZCBoaXN0b3JpZXNcIiBmdXJ0aGVyXG4gIC8vIGRvd24uIGBlbnN1cmVEZWZhdWx0QnJhbmNoQ3VycmVudGAgaXRzZWxmIGlnbm9yZXMgdGhlIHJlc3VsdCBvZiBpdHMgb3duXG4gIC8vIGBnaXQgYnJhbmNoIC1mYCAvIGByZXNldCAtLWhhcmRgIChJc3N1ZSAjMzk0OiBgYnJhbmNoIC1mYCBpcyByZWZ1c2VkIHdoZW5cbiAgLy8gYW5vdGhlciB3b3JrdHJlZSBob2xkcyB0aGUgYnJhbmNoKSwgc28gaXRzIG9rOnRydWUgaXMgbm90IHByb29mIHRoZSByZWZcbiAgLy8gYWN0dWFsbHkgbW92ZWQg4oCUIGhlbmNlIHRoZSBwb3NpdGl2ZSBjaGVjayBiZWxvdywgbm90IGp1c3QgdGhlIGAhb2tgIG9uZS5cbiAgY29uc3QgZGVmYXVsdEN1cnJlbnQgPSBhd2FpdCBlbnN1cmVEZWZhdWx0QnJhbmNoQ3VycmVudChcbiAgICBkZWZhdWx0QnJhbmNoLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghZGVmYXVsdEN1cnJlbnQub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYFJlZnVzaW5nIHRvIG1lcmdlICcke2RlZmF1bHRCcmFuY2h9JyBpbnRvICcke21pbGVzdG9uZUJyYW5jaH0nOiBgICtcbiAgICAgICAgICBgdGhlIGxvY2FsICcke2RlZmF1bHRCcmFuY2h9JyBjb3VsZCBub3QgYmUgbWFkZSBjdXJyZW50IHdpdGggYCArXG4gICAgICAgICAgYG9yaWdpbiwgc28gdGhlIG1lcmdlIHdvdWxkIGNhcnJ5IGEgc3RhbGUgcmVmIChJc3N1ZSAjMjg5Nik6ICR7ZGVmYXVsdEN1cnJlbnQuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IGxvY2FsRGVmYXVsdFNoYSA9IGF3YWl0IHJlYWRSZWYoZGVmYXVsdEJyYW5jaCwgb3B0aW9ucyk7XG4gIGNvbnN0IG9yaWdpbkRlZmF1bHRTaGEgPSBhd2FpdCByZWFkUmVmKGBvcmlnaW4vJHtkZWZhdWx0QnJhbmNofWAsIG9wdGlvbnMpO1xuICBpZiAoXG4gICAgIWxvY2FsRGVmYXVsdFNoYSB8fCAhb3JpZ2luRGVmYXVsdFNoYSB8fFxuICAgIGxvY2FsRGVmYXVsdFNoYSAhPT0gb3JpZ2luRGVmYXVsdFNoYVxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYFJlZnVzaW5nIHRvIG1lcmdlICcke2RlZmF1bHRCcmFuY2h9JyBpbnRvICcke21pbGVzdG9uZUJyYW5jaH0nOiBgICtcbiAgICAgICAgICBgdGhlIGxvY2FsICcke2RlZmF1bHRCcmFuY2h9JyByZWYgY291bGQgbm90IGJlIG1vdmVkIHRvIG1hdGNoIGAgK1xuICAgICAgICAgIGBvcmlnaW4gKGxvY2FsICR7XG4gICAgICAgICAgICBsb2NhbERlZmF1bHRTaGEgPyBsb2NhbERlZmF1bHRTaGEuc2xpY2UoMCwgNykgOiBcIjx1bnJlYWRhYmxlPlwiXG4gICAgICAgICAgfWAgK1xuICAgICAgICAgIGAgdnMgb3JpZ2luICR7XG4gICAgICAgICAgICBvcmlnaW5EZWZhdWx0U2hhID8gb3JpZ2luRGVmYXVsdFNoYS5zbGljZSgwLCA3KSA6IFwiPHVucmVhZGFibGU+XCJcbiAgICAgICAgICB9KSwgc28gdGhlIG1lcmdlIHdvdWxkIGNhcnJ5IGEgc3RhbGUgcmVmIChJc3N1ZSAjMjg5NilgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gV2hhdCB0aGUgc3luYyBkaXNjYXJkZWQgb24gaXRzIHdheSBpbiwgcmVwb3J0ZWQgd2l0aCBpdHMgb3V0Y29tZVxuICAvLyAoSXNzdWUgIzU2OCkuIEVtcHR5IG9uIHRoZSBvcmRpbmFyeSBwYXRoLlxuICBsZXQgZGlydHlOb3RlID0gXCJcIjtcblxuICAvLyBDaGVjayBvdXQgdGhlIG1pbGVzdG9uZSBicmFuY2hcbiAgY29uc3QgY3VycmVudEJyYW5jaFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wicmV2LXBhcnNlXCIsIFwiLS1hYmJyZXYtcmVmXCIsIFwiSEVBRFwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBjb25zdCBjdXJyZW50QnJhbmNoID0gY3VycmVudEJyYW5jaFJlc3VsdC5va1xuICAgID8gY3VycmVudEJyYW5jaFJlc3VsdC52YWx1ZS5zdGRvdXQudHJpbSgpXG4gICAgOiBcIlwiO1xuXG4gIGlmIChjdXJyZW50QnJhbmNoICE9PSBtaWxlc3RvbmVCcmFuY2gpIHtcbiAgICAvLyBJc3N1ZSAjMTUxNzogc2hhbGxvdyBjbG9uZXMgKGAtLWRlcHRoPTEgLS1uby1zaW5nbGUtYnJhbmNoYCkgb25seSBjYXJyeVxuICAgIC8vIHJlbW90ZS10cmFja2luZyByZWZzIGZvciBicmFuY2hlcyBwcmVzZW50IGF0IGNsb25lIHRpbWUuIEZldGNoIHRoZVxuICAgIC8vIG1pbGVzdG9uZSBicmFuY2ggZmlyc3Qgc28gRFdJTSBjaGVja291dCBjYW4gY3JlYXRlIGEgbG9jYWwgdHJhY2tpbmdcbiAgICAvLyBicmFuY2ggZnJvbSBgb3JpZ2luLzxtaWxlc3RvbmVCcmFuY2g+YCB3aGVuIHRoZSBicmFuY2ggd2FzIGNyZWF0ZWRcbiAgICAvLyByZW1vdGVseSBhZnRlciB0aGUgY2xvbmUuXG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJmZXRjaFwiLCBcIm9yaWdpblwiLCBtaWxlc3RvbmVCcmFuY2hdLCBvcHRpb25zKTtcblxuICAgIC8vIElzc3VlICM1Njg6IHRoZSBzaGFyZWQgYCR7V09SS19ESVJ9LzxyZXBvPmAgY2xvbmUgaXMgc2NyYXRjaCwgbm90IGFcbiAgICAvLyB3b3Jrc3BhY2UgYW55b25lJ3Mgd29yayBzdXJ2aXZlcyBpbiDigJQgYSB0aW1lZC1vdXQgY2xhaW0gb3IgYW5cbiAgICAvLyBhYmFuZG9uZWQgcGFzcyByb3V0aW5lbHkgbGVhdmVzIGl0IGRpcnR5LCBhbmQgYGdpdCBjaGVja291dGAgdGhlblxuICAgIC8vIHJlZnVzZXMgKFwiWW91ciBsb2NhbCBjaGFuZ2VzIHRvIHRoZSBmb2xsb3dpbmcgZmlsZXMgd291bGQgYmVcbiAgICAvLyBvdmVyd3JpdHRlblwiKS4gVGhlIHN5bmMgcmVjb3JkZWQgYHN5bmNfZmFpbGVkYCBhbmQgbW92ZWQgb24sIHNvIHRoZVxuICAgIC8vIG1pbGVzdG9uZSBicmFuY2ggZHJpZnRlZCBiZWhpbmQgdGhlIGRlZmF1bHQgbGluZSB1bnRpbCBhIGh1bWFuIG5vdGljZWRcbiAgICAvLyDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgZHJpZnQgdGhhdCBwcm9kdWNlcyB0aGUgY29uZmxpY3RpbmcgY2hpbGQgUFJzXG4gICAgLy8gdGhlIG1lcmdlLWNvbmZsaWN0IGxhbmUgdGhlbiBzcGVuZHMgYWdlbnQgdGltZSBvbi5cbiAgICAvL1xuICAgIC8vIERpc2NhcmRpbmcgaGVyZSBpcyBzYWZlIEJFQ0FVU0UgdGhlIGNsb25lIGlzIHNoYXJlZCBzY3JhdGNoOiBldmVyeVxuICAgIC8vIGNhbGxlciByZS1kZXJpdmVzIHdoYXQgaXQgbmVlZHMsIGFuZCB0aGUgcmVwb3NpdG9yeSBsZWFzZSAoSXNzdWUgIzIxMylcbiAgICAvLyBpcyB3aGF0IHN0b3BzIGFuIGlzc3VlIHNsb3QncyByZWFsIHdvcmsgYmVpbmcgaW4gdGhpcyB0cmVlIGF0IHRoZSBzYW1lXG4gICAgLy8gdGltZS4gV2hhdCBpcyBkaXNjYXJkZWQgaXMgbmFtZWQsIHNvIGEgc3VycHJpc2UgaXMgZGlhZ25vc2FibGUgcmF0aGVyXG4gICAgLy8gdGhhbiBzaWxlbnQuXG4gICAgY29uc3QgZGlydHkgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcInN0YXR1c1wiLCBcIi0tcG9yY2VsYWluXCJdLCBvcHRpb25zKTtcbiAgICBpZiAoZGlydHkub2sgJiYgZGlydHkudmFsdWUuY29kZSA9PT0gMCAmJiBkaXJ0eS52YWx1ZS5zdGRvdXQudHJpbSgpKSB7XG4gICAgICBjb25zdCBmaWxlcyA9IGRpcnR5LnZhbHVlLnN0ZG91dC50cmltKCkuc3BsaXQoXCJcXG5cIik7XG4gICAgICBhd2FpdCBydW5HaXRDb21tYW5kKFtcInJlc2V0XCIsIFwiLS1oYXJkXCJdLCBvcHRpb25zKTtcbiAgICAgIC8vIElnbm9yZWQgZXhlY3V0YWJsZSBwYXRocyBnbyB3aXRoIGl0IChJc3N1ZSAjMTQ0MykuIEEgZmFpbHVyZSBpc1xuICAgICAgLy8gbmFtZWQgaW4gdGhlIG5vdGUgdGhpcyBmdW5jdGlvbiByZXR1cm5zLCBzbyB0aGUgc3luYydzIG93biByZWNvcmRcbiAgICAgIC8vIGNhcnJpZXMgaXQgcmF0aGVyIHRoYW4gaXQgYmVpbmcgZHJvcHBlZCBoZXJlLlxuICAgICAgY29uc3QgY2xlYW5lZCA9IGF3YWl0IGNsZWFuV29ya2luZ1RyZWUob3B0aW9ucyk7XG4gICAgICBpZiAoIWNsZWFuZWQub2spIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihgW3N5bmNdICR7Y2xlYW5lZC5lcnJvci5tZXNzYWdlfWApO1xuICAgICAgfVxuICAgICAgZGlydHlOb3RlID0gYFNFTEYtSEVBTElORzogZGlzY2FyZGVkICR7ZmlsZXMubGVuZ3RofSB1bmNvbW1pdHRlZCBgICtcbiAgICAgICAgYGNoYW5nZShzKSBpbiB0aGUgc2hhcmVkIGNsb25lIGJlZm9yZSBjaGVja291dCAoJHtcbiAgICAgICAgICAvLyBQb3JjZWxhaW4gdjEgaXMgYSB0d28tY2hhcmFjdGVyIHN0YXR1cyBmaWVsZCwgdGhlbiB0aGUgcGF0aC5cbiAgICAgICAgICBmaWxlcy5zbGljZSgwLCAzKS5tYXAoKGxpbmUpID0+IGxpbmUuc2xpY2UoMikudHJpbSgpKS5qb2luKFwiLCBcIil9JHtcbiAgICAgICAgICBmaWxlcy5sZW5ndGggPiAzID8gYCwgKyR7ZmlsZXMubGVuZ3RoIC0gM30gbW9yZWAgOiBcIlwiXG4gICAgICAgIH0pJHtjbGVhbmVkLm9rID8gXCJcIiA6IFwiIOKAlCBcIiArIGNsZWFuZWQuZXJyb3IubWVzc2FnZX0g4oCUIGA7XG4gICAgfVxuXG4gICAgY29uc3QgY2hlY2tvdXRSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgW1wiY2hlY2tvdXRcIiwgbWlsZXN0b25lQnJhbmNoXSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgICBpZiAoIWNoZWNrb3V0UmVzdWx0Lm9rIHx8IGNoZWNrb3V0UmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAgIC8vIFN1cmZhY2UgZ2l0J3Mgb3duIG91dHB1dCAoSXNzdWUgIzQ5KTogXCJlcnJvcjogWW91ciBsb2NhbCBjaGFuZ2VzIHRvXG4gICAgICAvLyB0aGUgZm9sbG93aW5nIGZpbGVzIHdvdWxkIGJlIG92ZXJ3cml0dGVuIGJ5IGNoZWNrb3V0OiDigKZcIiDigJQgdXN1YWxseSBhXG4gICAgICAvLyBkaXJ0eSB0cmVlIGEgdGltZWQtb3V0IGNsYWltIGxlZnQgb24gdGhpcyBzaGFyZWQgY2xvbmUg4oCUIGlzIHRoZSB3aG9sZVxuICAgICAgLy8gZGlhZ25vc2lzLCBhbmQgdGhlIG9sZCBlcnJvciBkaXNjYXJkZWQgaXQuIHN0ZG91dCBjb3VudHMgdG9vXG4gICAgICAvLyAoSXNzdWUgIzE5NjQpLCBzbyBhIHN0ZG91dC1vbmx5IHJlZnVzYWwgaXMgbmV2ZXIgbG9nZ2VkIGFzIHNpbGVuY2UuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYEZhaWxlZCB0byBjaGVja291dCBtaWxlc3RvbmUgYnJhbmNoICcke21pbGVzdG9uZUJyYW5jaH0nOiAke1xuICAgICAgICAgICAgZGVzY3JpYmVHaXRGYWlsdXJlKGNoZWNrb3V0UmVzdWx0LCB7IGxpbmVzOiA2LCBmcm9tOiBcImhlYWRcIiB9KVxuICAgICAgICAgIH1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBUYWtlIHRoZSByZW1vdGUgbWlsZXN0b25lIGJyYW5jaCB3aXRob3V0IGV2ZXIgbWFudWZhY3R1cmluZyBhIGxvY2FsIG1lcmdlXG4gIC8vIGNvbW1pdCAoSXNzdWUgIzQwMDIpLiBBIHBsYWluIGBnaXQgcHVsbGAgbWVyZ2VzIHdoZW5ldmVyIGxvY2FsIGFuZCByZW1vdGVcbiAgLy8gaGF2ZSBkaXZlcmdlZDsgYSByZXBvc2l0b3J5IHJ1bGUgZm9yYmlkZGluZyBtZXJnZSBjb21taXRzIHRoZW4gcmVqZWN0cyB0aGVcbiAgLy8gcHVzaCwgYW5kIHRoZSBicmFuY2ggc3RheXMgdW5wdXNoYWJsZSB1bnRpbCBhIGh1bWFuIGludGVydmVuZXMuIFRoZSByZW1vdGVcbiAgLy8gaXMgYXV0aG9yaXRhdGl2ZSBmb3IgYSBtaWxlc3RvbmUgYnJhbmNoLCBzbyBmYXN0LWZvcndhcmQgd2hlcmUgcG9zc2libGUgYW5kXG4gIC8vIHJlc2V0IHRvIHRoZSByZW1vdGUgcmVmIG90aGVyd2lzZS5cbiAgbGV0IHNlbGZIZWFsTm90ZSA9IGRpcnR5Tm90ZTtcbiAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJmZXRjaFwiLCBcIm9yaWdpblwiLCBtaWxlc3RvbmVCcmFuY2hdLCBvcHRpb25zKTtcbiAgY29uc3QgcmVtb3RlUmVmUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXG4gICAgICBcInNob3ctcmVmXCIsXG4gICAgICBcIi0tdmVyaWZ5XCIsXG4gICAgICBcIi0tcXVpZXRcIixcbiAgICAgIGByZWZzL3JlbW90ZXMvb3JpZ2luLyR7bWlsZXN0b25lQnJhbmNofWAsXG4gICAgXSxcbiAgICBvcHRpb25zLFxuICApO1xuXG4gIGlmIChyZW1vdGVSZWZSZXN1bHQub2sgJiYgcmVtb3RlUmVmUmVzdWx0LnZhbHVlLmNvZGUgPT09IDApIHtcbiAgICBjb25zdCBmYXN0Rm9yd2FyZFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBbXCJtZXJnZVwiLCBcIi0tZmYtb25seVwiLCBgb3JpZ2luLyR7bWlsZXN0b25lQnJhbmNofWBdLFxuICAgICAgb3B0aW9ucyxcbiAgICApO1xuXG4gICAgaWYgKCFmYXN0Rm9yd2FyZFJlc3VsdC5vayB8fCBmYXN0Rm9yd2FyZFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgICBjb25zdCByZXNldFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmRDaGVja2VkKFxuICAgICAgICBbXCJyZXNldFwiLCBcIi0taGFyZFwiLCBgb3JpZ2luLyR7bWlsZXN0b25lQnJhbmNofWBdLFxuICAgICAgICBvcHRpb25zLFxuICAgICAgKTtcbiAgICAgIGlmICghcmVzZXRSZXN1bHQub2spIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBGYWlsZWQgdG8gcmVzZXQgZGl2ZXJnZWQgbWlsZXN0b25lIGJyYW5jaCAnJHttaWxlc3RvbmVCcmFuY2h9JyB0byAnb3JpZ2luLyR7bWlsZXN0b25lQnJhbmNofSc6ICR7cmVzZXRSZXN1bHQuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgICAgICksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBzZWxmSGVhbE5vdGUgPVxuICAgICAgICBgU0VMRi1IRUFMSU5HOiByZXNldCAnJHttaWxlc3RvbmVCcmFuY2h9JyB0byAnb3JpZ2luLyR7bWlsZXN0b25lQnJhbmNofScgYCArXG4gICAgICAgIGAoZGl2ZXJnZWQgbG9jYWwgY29tbWl0cyBkaXNjYXJkZWQpIOKAlCBgO1xuICAgIH1cbiAgfVxuXG4gIC8vIFdoZXJlIHRoaXMgc3luYydzIG1pbnV0ZXMgZ28gKElzc3VlICMyMzA4KS4gVGhlIGRlZXBlbiwgdGhlIGxhZGRlcidzIHR3b1xuICAvLyBydW5ncywgdGhlIHZlcmlmaWNhdGlvbiBnYXRlIGFuZCB0aGUgcHVzaCBhcmUgZWFjaCB0aW1lZCBpbnRvIGl0LCBhbmQgdGhlXG4gIC8vIHJlbmRlcmVkIGxpbmUgcmlkZXMgb3V0IHdpdGggdGhlIGNvbmZsaWN0IG9uIHRoZSBzeW5jIHJlcG9ydC5cbiAgY29uc3QgdGltZXIgPSBjcmVhdGVDb25mbGljdFN0YWdlVGltZXIobm93TXNGbik7XG5cbiAgLyoqXG4gICAqIExvZyB0aGlzIHN5bmMncyBzdGFnZSB0aW1pbmdzIGFuZCByZW5kZXIgdGhlbSBmb3IgdGhlIHJlcG9ydCBjb21tZW50XG4gICAqIChJc3N1ZSAjMjMwOCkuXG4gICAqXG4gICAqIENhbGxlZCBmcm9tIGV2ZXJ5IGV4aXQgYmVsb3csIG5vdCBvbmx5IHRoZSBvbmUgdGhhdCBwdXNoZWQ6IGEgc3luYyB0aGF0XG4gICAqIHNwZW50IHR3ZW50eSBtaW51dGVzIGFuZCB0aGVuIHJlZnVzZWQgaXMgZXhhY3RseSB0aGUgYXR0ZW1wdCBhIHJlYWRlclxuICAgKiBuZWVkcyB0aGUgYnJlYWtkb3duIGZvciwgYW5kIGFuIGV4aXQgdGhhdCBsb2dnZWQgbm90aGluZyB3b3VsZCBoaWRlIGl0LlxuICAgKiBPbmUgY2FsbCBzaXRlIGZlZWRzIGJvdGggc2lua3MsIHNvIHRoZSBsb2cgcmVjb3JkIGFuZCB0aGUgY29tbWVudCBjYW5cbiAgICogbmV2ZXIgY2xhaW0gZGlmZmVyZW50IGJyZWFrZG93bnMuXG4gICAqXG4gICAqIEByZXR1cm5zIFRoZSByZW5kZXJlZCBsaW5lLCByZWFkeSB0byBhcHBlbmQgdG8gYSBzeW5jIHJlcG9ydCBjb21tZW50XG4gICAqL1xuICBjb25zdCByZWNvcmRUaW1pbmdzID0gKCk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgaG9zdCA9IGN1cnJlbnRIb3N0KCk7XG4gICAgY29uc3Qgc3RhZ2VUaW1pbmdzID0gdGltZXIucmVwb3J0KCk7XG4gICAgbG9nZ2VyPy5pbmZvKFwiTWlsZXN0b25lIHN5bmMgc3RhZ2UgdGltaW5nc1wiLCB7XG4gICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICBkZWZhdWx0QnJhbmNoLFxuICAgICAgaG9zdCxcbiAgICAgIHRpbWluZ3M6IHN0YWdlVGltaW5ncyxcbiAgICB9KTtcbiAgICByZXR1cm4gZm9ybWF0U3RhZ2VUaW1pbmdzKHN0YWdlVGltaW5ncywgaG9zdCk7XG4gIH07XG5cbiAgLy8gRW5zdXJlIGVub3VnaCBoaXN0b3J5IGZvciByYW5nZS9tZXJnZSBvcHMgb24gYSBzaGFsbG93IGNsb25lIChJc3N1ZVxuICAvLyAjMTUwMikuIEEgZmFpbHVyZSBoZXJlIGlzIE5PVCBhIGZyZWUgcGFzcyB0byBtZXJnZSBhbnl3YXkgKElzc3VlICMyODk2KTpcbiAgLy8gd2l0aG91dCBhIGNvbW1vbiBhbmNlc3RvciBsb2NhbGx5LCBgZ2l0IG1lcmdlYCByZWZ1c2VzIGFzIFwidW5yZWxhdGVkXG4gIC8vIGhpc3Rvcmllc1wiIGV2ZW4gdGhvdWdoIGEgbWVyZ2UgYmFzZSBleGlzdHMgb24gdGhlIHJlbW90ZSwgYW5kIHRoYXRcbiAgLy8gcmVmdXNhbCB1c2VkIHRvIGJlIHJlcG9ydGVkIGFzIHRoZSBwZXJtYW5lbnQgbm9uLWNvbmZsaWN0IGZhaWx1cmUgZnVydGhlclxuICAvLyBkb3duIHJhdGhlciB0aGFuIG5hbWVkIGZvciB3aGF0IGl0IGlzIGhlcmUuXG4gIHRpbWVyLnN0YXJ0KFwiZGVlcGVuXCIpO1xuICBjb25zdCBkZWVwZW5lZCA9IGF3YWl0IGVuc3VyZUhpc3RvcnlEZXB0aChbXCJIRUFEXCIsIGRlZmF1bHRCcmFuY2hdLCBvcHRpb25zKTtcbiAgdGltZXIuc3RvcCgpO1xuICBpZiAoIWRlZXBlbmVkLm9rKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBSZWZ1c2luZyB0byBtZXJnZSAnJHtkZWZhdWx0QnJhbmNofScgaW50byAnJHttaWxlc3RvbmVCcmFuY2h9JzogYCArXG4gICAgICAgICAgYHRoZSBzaGFsbG93IGNsb25lIGNvdWxkIG5vdCBiZSBkZWVwZW5lZCB0byB0aGVpciBtZXJnZSBiYXNlLCBzbyBgICtcbiAgICAgICAgICBgZ2l0IHdvdWxkIHJlZnVzZSB0aGUgbWVyZ2UgYXMgdW5yZWxhdGVkIGhpc3RvcmllcyBgICtcbiAgICAgICAgICBgKElzc3VlICMyODk2KTogJHtkZWVwZW5lZC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICAvLyBDaGVjayBpZiBtZXJnZSBpcyBuZWVkZWRcbiAgY29uc3QgYmVoaW5kUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtbGlzdFwiLCBcIi0tY291bnRcIiwgYEhFQUQuLiR7ZGVmYXVsdEJyYW5jaH1gXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBjb25zdCBiZWhpbmRDb3VudCA9IGJlaGluZFJlc3VsdC5vayAmJiBiZWhpbmRSZXN1bHQudmFsdWUuY29kZSA9PT0gMFxuICAgID8gcGFyc2VJbnQoYmVoaW5kUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCksIDEwKSB8fCAwXG4gICAgOiAwO1xuXG4gIGlmIChiZWhpbmRDb3VudCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIG1lc3NhZ2U6XG4gICAgICAgICAgYCR7c2VsZkhlYWxOb3RlfU1pbGVzdG9uZSBicmFuY2ggJyR7bWlsZXN0b25lQnJhbmNofScgaXMgYWxyZWFkeSB1cCB0byBkYXRlIHdpdGggJyR7ZGVmYXVsdEJyYW5jaH0nYCxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8vIFdoZXJlIHRoZSBicmFuY2ggc3RhbmRzIGJlZm9yZSBhbnkgbWVyZ2UsIHNvIHRoZSBnYXRlIGNhbiB1bmRvIG9uZVxuICAvLyBleGFjdGx5IHdoZW4gdGhlIG1lcmdlZCB0cmVlIGRvZXMgbm90IGNvbXBpbGUgKElzc3VlICM5NzQpLiBSZWFkIGl0XG4gIC8vIEJFRk9SRSBtZXJnaW5nOiB3aXRob3V0IGl0IGEgcmVmdXNlZCBtZXJnZSBjYW5ub3QgYmUgcm9sbGVkIGJhY2ssIHNvIHRoZVxuICAvLyBob25lc3QgbW92ZSBpcyB0byByZWZ1c2UgdG8gc3RhcnQgcmF0aGVyIHRoYW4gdG8gZGlzY292ZXIgaXQgYWZ0ZXJ3YXJkcy5cbiAgY29uc3QgcHJlTWVyZ2VTaGFSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcInJldi1wYXJzZVwiLCBcIkhFQURcIl0sIG9wdGlvbnMpO1xuICBjb25zdCBwcmVNZXJnZVNoYSA9IHByZU1lcmdlU2hhUmVzdWx0Lm9rICYmXG4gICAgICBwcmVNZXJnZVNoYVJlc3VsdC52YWx1ZS5jb2RlID09PSAwXG4gICAgPyBwcmVNZXJnZVNoYVJlc3VsdC52YWx1ZS5zdGRvdXQudHJpbSgpXG4gICAgOiBcIlwiO1xuICBpZiAoIXByZU1lcmdlU2hhKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBSZWZ1c2luZyB0byBtZXJnZSAnJHtkZWZhdWx0QnJhbmNofScgaW50byAnJHttaWxlc3RvbmVCcmFuY2h9JzogYCArXG4gICAgICAgICAgYGl0cyBwcmUtbWVyZ2UgSEVBRCBjb3VsZCBub3QgYmUgcmVhZCwgc28gYSBtZXJnZSB0aGUgZ2F0ZSByZWplY3RzIGAgK1xuICAgICAgICAgIGBjb3VsZCBub3QgYmUgcm9sbGVkIGJhY2sgKElzc3VlICM5NzQpOiAke1xuICAgICAgICAgICAgZGVzY3JpYmVHaXRGYWlsdXJlKHByZU1lcmdlU2hhUmVzdWx0KVxuICAgICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gTWVyZ2UgZGVmYXVsdCBpbnRvIG1pbGVzdG9uZSAocHJlc2VydmUgY29tbWl0IGhpc3RvcnkpLiBBIHJlZnVzYWwgbmFtaW5nXG4gIC8vIFwidW5yZWxhdGVkIGhpc3Rvcmllc1wiIGlzIHJldHJpZWQgb25jZSBhZnRlciB1bnNoYWxsb3dpbmcgd2hlbiB0aGUgY2xvbmVcbiAgLy8gaXMgc2hhbGxvdyAoSXNzdWUgIzI4OTYpIOKAlCBzZWUge0BsaW5rIG1lcmdlV2l0aFVuc2hhbGxvd1JldHJ5fSDigJQgYmVjYXVzZVxuICAvLyB0aGF0IHJlZnVzYWwgb24gYSBzaGFsbG93IGNsb25lIHVzdWFsbHkgbWVhbnMgdGhlIG1lcmdlIGJhc2UgZXhpc3RzIG9uXG4gIC8vIHRoZSByZW1vdGUgYnV0IHdhcyBuZXZlciBmZXRjaGVkLCBub3QgdGhhdCB0aGUgaGlzdG9yaWVzIGFyZSBnZW51aW5lbHlcbiAgLy8gdW5yZWxhdGVkLlxuICBjb25zdCBtZXJnZVJlc3VsdCA9IGF3YWl0IG1lcmdlV2l0aFVuc2hhbGxvd1JldHJ5KGRlZmF1bHRCcmFuY2gsIG9wdGlvbnMpO1xuXG4gIGlmIChtZXJnZVJlc3VsdC5vayAmJiBtZXJnZVJlc3VsdC52YWx1ZS5jb2RlID09PSAwKSB7XG4gICAgaWYgKGF3YWl0IGFscmVhZHlTeW5jZWRFbHNld2hlcmUobWlsZXN0b25lQnJhbmNoLCBkZWZhdWx0QnJhbmNoLCBvcHRpb25zKSkge1xuICAgICAgcmV0dXJuIGF3YWl0IGFkb3B0UmVtb3RlU3luYyhtaWxlc3RvbmVCcmFuY2gsIGRlZmF1bHRCcmFuY2gsIG9wdGlvbnMpO1xuICAgIH1cbiAgICAvLyBQdXNoIHRoZSBzeW5jZWQgbWlsZXN0b25lIGJyYW5jaCAoSXNzdWUgIzYwNSksIG9yIHJhaXNlIGEgUFIgZm9yIGl0XG4gICAgLy8gd2hlcmUgYSByZXBvc2l0b3J5IHJ1bGUgcmVmdXNlcyB0aGUgcHVzaCAoSXNzdWUgIzU4OSkg4oCUIGJ1dCBvbmx5IG9uY2VcbiAgICAvLyB0aGUgbWVyZ2VkIHRyZWUgaGFzIHBhc3NlZCB0aGUgcmVwbydzIG93biBnYXRlIChJc3N1ZSAjOTc0KS5cbiAgICBjb25zdCBnYXRlZCA9IGF3YWl0IGdhdGVUaGVuUHVzaE1pbGVzdG9uZUJyYW5jaChcbiAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgICBvcHRpb25zLFxuICAgICAgcmVwbyxcbiAgICAgIG1lcmdlR2F0ZSxcbiAgICAgIHByZU1lcmdlU2hhLFxuICAgICk7XG4gICAgaWYgKCFnYXRlZC5vaykgcmV0dXJuIGdhdGVkO1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIG1lc3NhZ2U6XG4gICAgICAgICAgYCR7c2VsZkhlYWxOb3RlfSR7Z2F0ZWQudmFsdWV9U3VjY2Vzc2Z1bGx5IG1lcmdlZCAnJHtkZWZhdWx0QnJhbmNofScgaW50byAnJHttaWxlc3RvbmVCcmFuY2h9JyAoJHtiZWhpbmRDb3VudH0gY29tbWl0KHMpIGludGVncmF0ZWQpYCxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8vIE1lcmdlIGNvbmZsaWN0LiBCb3RoIHNpZGVzIGFyZSByZWFkIHN0cmFpZ2h0IG91dCBvZiB0aGUgY29uZmxpY3RlZCBpbmRleFxuICAvLyDigJQgb25jZSB0aGUgbWVyZ2UgaXMgYWJvcnRlZCBnaXQgbm8gbG9uZ2VyIGhvbGRzIHRoZW0sIGFuZCBhIGNvbmZsaWN0XG4gIC8vIG5vYm9keSBjYW4gZGVzY3JpYmUgaXMgYSBjb25mbGljdCBub2JvZHkgcmVjb25jaWxlcyAoSXNzdWVzICMxNTU4LFxuICAvLyAjMTU1OSkuXG4gIC8vIEEgbGlzdGluZyBnaXQgY291bGQgbm90IHByb2R1Y2UgcmVhZHMgYXMgXCJubyBjb25mbGljdGVkIGZpbGVzXCIsIHdoaWNoIHRoZVxuICAvLyBicmFuY2ggYmVsb3cgcmVwb3J0cyBhcyB0aGUgbm9uLWNvbmZsaWN0IGZhaWx1cmUgaXQgaXMsIHF1b3RpbmcgZ2l0J3Mgb3duXG4gIC8vIG1lcmdlIHN0ZGVyciDigJQgc28gdGhlIGZhaWx1cmUgaXMgZGlhZ25vc2VkIHRoZXJlIHJhdGhlciB0aGFuIHN3YWxsb3dlZC5cbiAgY29uc3QgbGlzdGVkID0gYXdhaXQgbGlzdFVubWVyZ2VkUGF0aHMob3B0aW9ucyk7XG4gIGNvbnN0IGNvbmZsaWN0ZWRGaWxlcyA9IGxpc3RlZC5vayA/IGxpc3RlZC52YWx1ZSA6IFtdO1xuICBjb25zdCBkZWZhdWx0U2hhID0gYXdhaXQgcmVhZFJlZihkZWZhdWx0QnJhbmNoLCBvcHRpb25zKTtcblxuICBpZiAoY29uZmxpY3RlZEZpbGVzLmxlbmd0aCA9PT0gMCkge1xuICAgIGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wibWVyZ2VcIiwgXCItLWFib3J0XCJdLCBvcHRpb25zKTtcbiAgICAvLyBIb25lc3QgZmFpbHVyZSAoSXNzdWUgIzQyNjApOiBhIG1lcmdlIHRoYXQgZmFpbHMgd2l0aCBaRVJPIGNvbmZsaWN0ZWRcbiAgICAvLyBmaWxlcyBmYWlsZWQgZm9yIGEgbm9uLWNvbmZsaWN0IHJlYXNvbiAodW5yZWxhdGVkIGhpc3Rvcmllcywgc2hhbGxvd1xuICAgIC8vIGhpc3RvcnksIGRpcnR5IHRyZWUsIHZhbmlzaGVkIHJlbW90ZeKApikuIFRoaXMgdXNlZCB0byByZXR1cm4gb2s6dHJ1ZSBhbmRcbiAgICAvLyBiZSBsb2dnZWQgYXMgXCJTeW5jZWQg4oCmXCIg4oCUIEZMRUVUIG1pbGVzdG9uZS80MDY0IHNhdCA1IGNvbW1pdHMgYmVoaW5kXG4gICAgLy8gRGV2ZWxvcCBmb3IgZGF5cyB3aGlsZSBldmVyeSBjeWNsZSBzYWlkIDAgZmFpbGVkLiBTdXJmYWNlIGdpdCdzIG93blxuICAgIC8vIG91dHB1dCDigJQgc3Rkb3V0IGFzIHdlbGwgYXMgc3RkZXJyIChJc3N1ZSAjMTk2NCkg4oCUIHNvIHRoZSByZWFsIHJlYXNvbiBpc1xuICAgIC8vIGluIHRoZSBsb2cuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBNZXJnZSBvZiAnJHtkZWZhdWx0QnJhbmNofScgaW50byAnJHttaWxlc3RvbmVCcmFuY2h9JyBmYWlsZWQgYCArXG4gICAgICAgICAgYHdpdGggbm8gY29uZmxpY3RlZCBmaWxlcyDigJQgYSBub24tY29uZmxpY3QgZmFpbHVyZSBgICtcbiAgICAgICAgICBgKElzc3VlICM0MjYwKTogJHtkZXNjcmliZUdpdEZhaWx1cmUobWVyZ2VSZXN1bHQpfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBtZXJnZUJhc2UgPSBhd2FpdCByZWFkTWVyZ2VCYXNlKHByZU1lcmdlU2hhLCBkZWZhdWx0QnJhbmNoLCBvcHRpb25zKTtcbiAgY29uc3QgcmVhZFNpZGVzID0gYXdhaXQgcmVhZENvbmZsaWN0ZWRTaWRlcyhcbiAgICBjb25mbGljdGVkRmlsZXMsXG4gICAgbWVyZ2VCYXNlLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgZGVmYXVsdFNoYSB8fCBkZWZhdWx0QnJhbmNoLFxuICAgIHByZU1lcmdlU2hhLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghcmVhZFNpZGVzLm9rKSB7XG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJtZXJnZVwiLCBcIi0tYWJvcnRcIl0sIG9wdGlvbnMpO1xuICAgIHJldHVybiByZWFkU2lkZXM7XG4gIH1cbiAgY29uc3Qgc2lkZXMgPSByZWFkU2lkZXMudmFsdWU7XG4gIGNvbnN0IHBsYW4gPSBwbGFuQ29uZmxpY3RSZXNvbHV0aW9uKFxuICAgIHNpZGVzLFxuICAgIGF3YWl0IHJlYWRUZXN0RXZpZGVuY2UoXG4gICAgICBtZXJnZUJhc2UsXG4gICAgICBkZWZhdWx0U2hhIHx8IGRlZmF1bHRCcmFuY2gsXG4gICAgICBwcmVNZXJnZVNoYSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKSxcbiAgKTtcblxuICAvLyBBIGNvbmZsaWN0ZWQgdGVzdCBmaWxlIHdob3NlIHNpZGVzIGRvIG5vdCBjb250YWluIG9uZSBhbm90aGVyIGlzIG1lcmdlZFxuICAvLyBhcyBhIHVuaW9uIOKAlCBib3RoIHNpZGVzJyBodW5rcyBrZXB0IOKAlCByYXRoZXIgdGhhbiBlc2NhbGF0ZWQgb24gc2lnaHRcbiAgLy8gKElzc3VlICMxNTU5KS4gQSB1bmlvbiB0aGF0IHdvdWxkIGxvc2UgYSBjYXNlLCBvciB0aGF0IGdpdCBjb3VsZCBub3RcbiAgLy8gcHJvZHVjZSwgYmVjb21lcyBhbiBlc2NhbGF0aW9uIGZvciB0aGF0IGZpbGUgaW5zdGVhZC5cbiAgY29uc3QgZGVjaWRlZCA9IG5ldyBNYXAocGxhbi5kZWNpc2lvbnMubWFwKChkKSA9PiBbZC5wYXRoLCBkXSkpO1xuICBmb3IgKGNvbnN0IGZpbGUgb2Ygc2lkZXMpIHtcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lkZWQuZ2V0KGZpbGUucGF0aCk7XG4gICAgaWYgKGRlY2lzaW9uPy5hY3Rpb24gIT09IFwidW5pb25cIikgY29udGludWU7XG4gICAgLy8gQW4gYXBwZW5kLW9ubHkgbGVkZ2VyIHJlYWRzIHRoZSBkZWZhdWx0IGJyYW5jaCdzIGVudHJ5IGZpcnN0IChJc3N1ZVxuICAgIC8vICMxNzY4KTsgYSB0ZXN0LWZpbGUgdW5pb24ga2VlcHMgdGhlIGJyYW5jaCdzIG93biBjYXNlcyBmaXJzdCBhcyBiZWZvcmUuXG4gICAgY29uc3QgZmFpbHVyZSA9IGF3YWl0IHVuaW9uTWVyZ2VDb25mbGljdGVkRmlsZShcbiAgICAgIGZpbGUsXG4gICAgICBvcHRpb25zLFxuICAgICAgZGVjaXNpb24uY2FzZSA9PT0gXCJib3RoLWluc2VydGVkXCIgPyBcImRlZmF1bHQtZmlyc3RcIiA6IFwibWlsZXN0b25lLWZpcnN0XCIsXG4gICAgKTtcbiAgICBpZiAoZmFpbHVyZSkge1xuICAgICAgZGVjaXNpb24uYWN0aW9uID0gXCJlc2NhbGF0ZVwiO1xuICAgICAgZGVjaXNpb24ucmVhc29uID0gYCR7ZGVjaXNpb24ucmVhc29ufSDigJQgYW5kICR7ZmFpbHVyZX1gO1xuICAgIH1cbiAgfVxuICAvLyBUaGUgbGFkZGVyIChJc3N1ZSAjMTc3Nyk6IHdoYXQgdGhlIHRyaWFnZSBjb3VsZCBub3QgZGVjaWRlIGdvZXMgdG8gdGhlXG4gIC8vIGRldGVybWluaXN0aWMgZGVwZW5kZW5jeSBydWxlcywgYW5kIHdoYXQgdGhvc2UgZGVmZXIgZ29lcyB0byB0aGVcbiAgLy8gcmVzb2x1dGlvbiBhZ2VudCDigJQgdGhlIHNhbWUgdHdvIHJ1bmdzIHRoZSBQUiBwYXNzIGNsaW1icywgb3ZlciB0aGUgc2FtZVxuICAvLyBjbG9uZS4gT25seSBhIGZpbGUgZXZlcnkgcnVuZyBsZWF2ZXMgdW5kZWNpZGVkIHJlYWNoZXMgYSBodW1hbi5cbiAgY29uc3QgdHJpYWdlZCA9IHBsYW4uZGVjaXNpb25zLmZpbHRlcigoZCkgPT4gZC5hY3Rpb24gIT09IFwiZXNjYWxhdGVcIik7XG4gIC8vIFRha2UgdGhlIHRyaWFnZSdzIHNpZGVzIE5PVywgYmVmb3JlIHRoZSBsYWRkZXIgY2xpbWJzIChJc3N1ZSAjMjAwNikuIFRoZVxuICAvLyBhZ2VudCBydW5nIHN0YWdlcyB0aGUgd2hvbGUgd29ya2luZyB0cmVlIG9uY2UgdGhlIGFnZW50IGlzIGRvbmUg4oCUIGFcbiAgLy8gcmVzb2x1dGlvbiB0aGF0IGV4dHJhY3RzIGEgaGVscGVyIGxlYXZlcyBhIG5ldyBmaWxlIHRoZSBtZXJnZSBjb21taXRcbiAgLy8gbXVzdCBjYXJyeSDigJQgYW5kIGBnaXQgYWRkIC1BYCBkb2VzIG5vdCBzdG9wIGF0IHRoZSBwYXRocyB0aGUgYWdlbnQgd2FzXG4gIC8vIGFza2VkIGFib3V0LiBBIHRyaWFnZWQgcGF0aCBzdGlsbCB1bm1lcmdlZCBhdCB0aGF0IHBvaW50IHdhcyBzdGFnZWRcbiAgLy8gd2l0aCBnaXQncyBtYXJrZXItbGFkZW4gd29ya2luZyBjb3B5IGFuZCBpdHMgbWVyZ2Ugc3RhZ2VzIHdlcmUgZ29uZSwgc29cbiAgLy8gaXRzIHNpZGUgY291bGQgbm8gbG9uZ2VyIGJlIHRha2VuIGFuZCB0aGUgd2hvbGUgcmVzb2x1dGlvbiDigJQgZWxldmVuXG4gIC8vIG1pbnV0ZXMgb2YgYWdlbnQgd29yayBpbmNsdWRlZCDigJQgd2FzIHJlZnVzZWQgYXMgXCJ0aGUgbWVyZ2Ugc3RhZ2VzIG9mXG4gIC8vIGNvbmZsaWN0ZWQgZmlsZSAnQ2FyZ28ubG9jaycgY291bGQgbm90IGJlIHJlYWRcIi4gV2l0aCB0aGUgc2lkZXMgYWxyZWFkeVxuICAvLyBzdGFnZWQgdGhlIGFnZW50IHNlZXMgdGhlbSBhcyBkZWNpZGVkLCBhbmQgc3RhZ2luZyB0aGUgdHJlZSBjaGFuZ2VzXG4gIC8vIG5vdGhpbmcgYWJvdXQgdGhlbS5cbiAgY29uc3Qgc2lkZXNUYWtlbiA9IGF3YWl0IGFwcGx5Q29uZmxpY3RQbGFuKFxuICAgIHtcbiAgICAgIC4uLnBsYW4sXG4gICAgICByZXNvbHZlZDogdHJpYWdlZCxcbiAgICAgIGVzY2FsYXRpb25zOiBwbGFuLmRlY2lzaW9ucy5maWx0ZXIoKGQpID0+IGQuYWN0aW9uID09PSBcImVzY2FsYXRlXCIpLFxuICAgIH0sXG4gICAgc2lkZXMsXG4gICAgZGVmYXVsdEJyYW5jaCxcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFzaWRlc1Rha2VuLm9rKSB7XG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJtZXJnZVwiLCBcIi0tYWJvcnRcIl0sIG9wdGlvbnMpO1xuICAgIHJldHVybiBzaWRlc1Rha2VuO1xuICB9XG4gIGNvbnN0IGxhZGRlciA9IGF3YWl0IGNsaW1iQ29uZmxpY3RMYWRkZXIoe1xuICAgIGVzY2FsYXRpb25zOiBwbGFuLmRlY2lzaW9ucy5maWx0ZXIoKGQpID0+IGQuYWN0aW9uID09PSBcImVzY2FsYXRlXCIpLFxuICAgIG9wdGlvbnMsXG4gICAgbWlsZXN0b25lQnJhbmNoLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgYWdlbnRGbixcbiAgICB0aW1lcixcbiAgICBsb2dnZXIsXG4gIH0pO1xuICBjb25zdCByZXNvbHZlZCA9IFsuLi50cmlhZ2VkLCAuLi5sYWRkZXIucmVzb2x2ZWRdO1xuICBjb25zdCBlc2NhbGF0aW9ucyA9IGxhZGRlci5lc2NhbGF0aW9ucztcbiAgLyoqIEV2ZXJ5IHNldHRsZWQgZmlsZSBieSBwYXRoLCBjYXJyeWluZyB0aGUgcnVuZyB0aGF0IHNldHRsZWQgaXQuICovXG4gIGNvbnN0IHNldHRsZWQgPSBuZXcgTWFwKHJlc29sdmVkLm1hcCgoZCkgPT4gW2QucGF0aCwgZF0pKTtcblxuICAvLyBDYXNlIDMgKElzc3VlICMxNTU5KTogbm8gYXV0b21hdGljIHJ1bGUgY2FuIGNob29zZSBiZXR3ZWVuIHRoZSB0d28gc2lkZXMsXG4gIC8vIHNvIG5vdGhpbmcgaXMgcHVzaGVkIGFuZCB0aGUgYnJhbmNoIGlzIGxlZnQgZXhhY3RseSBhcyBpdCB3YXMuIFRoZVxuICAvLyBhbmFseXNpcyB0cmF2ZWxzIHdpdGggdGhlIHJlZnVzYWwg4oCUIGJvdGggc2lkZXMnIGV4cG9ydHMsIGJvdGggc2lkZXMnIHRlc3RcbiAgLy8gbmFtZXMgYW5kIHRoZSBkaWZmZXJlbmNlIGJldHdlZW4gdGhlbSDigJQgYmVjYXVzZSB0aGF0IHByZXBhcmF0aW9uIGlzIG1vc3RcbiAgLy8gb2YgdGhlIGhvdXIgdGhlIHJlYWRlciB3b3VsZCBvdGhlcndpc2Ugc3BlbmQuXG4gIGlmIChlc2NhbGF0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJtZXJnZVwiLCBcIi0tYWJvcnRcIl0sIG9wdGlvbnMpO1xuICAgIGNvbnN0IGVzY2FsYXRlZCA9IG5ldyBNYXAoZXNjYWxhdGlvbnMubWFwKChkKSA9PiBbZC5wYXRoLCBkXSkpO1xuICAgIGNvbnN0IGFuYWx5c2VzID0gc2lkZXNcbiAgICAgIC5maWx0ZXIoKHNpZGUpID0+IGVzY2FsYXRlZC5oYXMoc2lkZS5wYXRoKSlcbiAgICAgIC5tYXAoKHNpZGUpID0+XG4gICAgICAgIGFuYWx5c2VDb25mbGljdGVkRmlsZShzaWRlLCBlc2NhbGF0ZWQuZ2V0KHNpZGUucGF0aCkhLnJlYXNvbilcbiAgICAgICk7XG4gICAgLy8gQW4gZXNjYWxhdGlvbiBpcyBhbiBhdHRlbXB0IHRvbyAoSXNzdWUgIzIzMDgpIOKAlCB0aGUgcnVuZ3MgdGhhdCByZWFjaGVkXG4gICAgLy8gaXQgY29zdCB0aGUgc2FtZSBtaW51dGVzLCBhbmQgdGhlIGxvZyBzYXlzIHdoZXJlIHRoZXkgd2VudC4gVGhlIGxpbmVcbiAgICAvLyB0cmF2ZWxzIHdpdGggdGhlIHJlZnVzYWwgYXMgd2VsbCAoSXNzdWUgIzIzMTEpOiB0aGUgYG1lcmdlLWZhbGxiYWNrYFxuICAgIC8vIGZsYWcgcmVwb3J0cyB3aGF0IGVhY2ggc3BlbnQgcnVuIGNvc3QuXG4gICAgY29uc3QgZXNjYWxhdGlvblRpbWluZ3MgPSByZWNvcmRUaW1pbmdzKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgTWlsZXN0b25lQ29uZmxpY3RFc2NhbGF0aW9uKFxuICAgICAgICBgUmVmdXNpbmcgdG8gcmVzb2x2ZSB0aGUgbWVyZ2Ugb2YgJyR7ZGVmYXVsdEJyYW5jaH0nIGludG8gYCArXG4gICAgICAgICAgYCcke21pbGVzdG9uZUJyYW5jaH0nOiAke2VzY2FsYXRpb25zLmxlbmd0aH0gb2YgYCArXG4gICAgICAgICAgYCR7Y29uZmxpY3RlZEZpbGVzLmxlbmd0aH0gY29uZmxpY3RlZCBmaWxlKHMpIG5lZWQgYSBodW1hbiDigJQgYCArXG4gICAgICAgICAgYGV2ZXJ5IHJ1bmcgb2YgdGhlIGxhZGRlciBsZWZ0IHRoZW0gdW5kZWNpZGVkIChJc3N1ZXMgIzE1NTksIGAgK1xuICAgICAgICAgIGAjMTc3Nykg4oCUICR7XG4gICAgICAgICAgICBlc2NhbGF0aW9ucy5tYXAoKGQpID0+IGAke2QucGF0aH06ICR7ZC5yZWFzb259YCkuam9pbihcIjsgXCIpXG4gICAgICAgICAgfWAsXG4gICAgICAgIGFuYWx5c2VzLFxuICAgICAgICByZXNvbHZlZCxcbiAgICAgICAgZGVmYXVsdFNoYSxcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICBwcmVNZXJnZVNoYSxcbiAgICAgICAgZXNjYWxhdGlvblRpbWluZ3MsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICAvLyBXaG8gd3JpdGVzIHRoZSBtZXJnZSBjb21taXQgaXMgcmVhZCBmcm9tIGdpdCwgbm90IGFzc3VtZWQgKElzc3VlICMxOTY0KS5cbiAgLy8gVGhlIGFnZW50IHJ1bmcgd29ya3MgaW4gdGhpcyB2ZXJ5IGNsb25lLCBhbmQgYW4gYWdlbnQgdGhhdCBjb21taXR0ZWQgdGhlXG4gIC8vIG1lcmdlIGl0c2VsZiBsZWF2ZXMgbm90aGluZyBmb3IgYGdpdCBjb21taXQgLW0g4oCmYDogZ2l0IGV4aXRzIDEgc2F5aW5nXG4gIC8vIFwibm90aGluZyB0byBjb21taXQsIHdvcmtpbmcgdHJlZSBjbGVhblwiIG9uIHN0ZG91dCwgYW5kIHRoZSBzeW5jIHVzZWQgdG9cbiAgLy8gcmVhZCB0aGF0IGFzIGEgZmFpbHVyZSwgYWJvcnQgYW5kIHRocm93IGEgZ29vZCByZXNvbHV0aW9uIGF3YXkgZXZlcnlcbiAgLy8gY3ljbGUgdW50aWwgYSBodW1hbiB0b29rIHRoZSBicmFuY2guIFJlYWQgQkVGT1JFIHRoZSBwbGFuIGlzIGFwcGxpZWQsXG4gIC8vIGJlY2F1c2UgdGFraW5nIGEgc2lkZSBuZWVkcyB0aGUgY29uZmxpY3RlZCBpbmRleCB0aGUgY29tbWl0IGNsZWFyZWQuXG4gIGNvbnN0IG1lcmdlU3RhdGUgPSBhd2FpdCByZWFkTWVyZ2VDb21taXRTdGF0ZSh7XG4gICAgcHJlTWVyZ2VTaGEsXG4gICAgZGVmYXVsdFNoYSxcbiAgICBvcHRpb25zLFxuICB9KTtcblxuICAvKipcbiAgICogUmVmdXNlIHRoZSByZXNvbHV0aW9uLCBvcHRpb25hbGx5IHB1dHRpbmcgdGhlIGJyYW5jaCBiYWNrIHdoZXJlIGl0IHN0b29kLlxuICAgKlxuICAgKiBBIHN0YXRlIG5vYm9keSBjb3VsZCByZWFkIHJlc3RvcmVzIG5vdGhpbmc6IGRpc2NhcmRpbmcgd29yayBvbiBhIGNoZWNrXG4gICAqIHRoYXQgZGlkIG5vdCBydW4gaXMgdGhlIG9uZSBkaXJlY3Rpb24gdGhhdCBjYW5ub3QgYmUgdW5kb25lLlxuICAgKi9cbiAgY29uc3QgcmVmdXNlUmVzb2x1dGlvbiA9IGFzeW5jIChcbiAgICBkZXRhaWw6IHN0cmluZyxcbiAgICByZXN0b3JlOiBib29sZWFuLFxuICApOiBQcm9taXNlPFJlc3VsdDxNaWxlc3RvbmVTeW5jT3V0Y29tZT4+ID0+IHtcbiAgICBsZXQgbm90ZSA9IFwiXCI7XG4gICAgaWYgKHJlc3RvcmUpIHtcbiAgICAgIGNvbnN0IHJlc2V0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgICAgW1wicmVzZXRcIiwgXCItLWhhcmRcIiwgcHJlTWVyZ2VTaGFdLFxuICAgICAgICBvcHRpb25zLFxuICAgICAgKTtcbiAgICAgIG5vdGUgPSByZXNldC5vayAmJiByZXNldC52YWx1ZS5jb2RlID09PSAwXG4gICAgICAgID8gYCDigJQgdGhlIGJyYW5jaCB3YXMgcmVzZXQgdG8gJHtwcmVNZXJnZVNoYX1gXG4gICAgICAgIDogYCDigJQgYW5kIHRoZSBicmFuY2ggY291bGQgTk9UIGJlIHJlc2V0IHRvICR7cHJlTWVyZ2VTaGF9OiAke1xuICAgICAgICAgIGRlc2NyaWJlR2l0RmFpbHVyZShyZXNldClcbiAgICAgICAgfWA7XG4gICAgfVxuICAgIC8vIEEgcmVmdXNhbCBjb3N0cyB0aGUgc2FtZSBtaW51dGVzIGEgcHVzaCBkb2VzIChJc3N1ZSAjMjMwOCksIHNvIGl0XG4gICAgLy8gYWNjb3VudHMgZm9yIHRoZW0gdGhlIHNhbWUgd2F5LlxuICAgIHJlY29yZFRpbWluZ3MoKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYFJlZnVzaW5nIHRvIGNvbW1pdCB0aGUgcmVzb2x1dGlvbiBvZiAnJHtkZWZhdWx0QnJhbmNofScgaW50byBgICtcbiAgICAgICAgICBgJyR7bWlsZXN0b25lQnJhbmNofScgKElzc3VlICMxOTY0KTogJHtkZXRhaWx9JHtub3RlfWAsXG4gICAgICApLFxuICAgIH07XG4gIH07XG5cbiAgaWYgKG1lcmdlU3RhdGUua2luZCA9PT0gXCJ1bmtub3duXCIpIHtcbiAgICByZXR1cm4gYXdhaXQgcmVmdXNlUmVzb2x1dGlvbihtZXJnZVN0YXRlLmRldGFpbCwgZmFsc2UpO1xuICB9XG4gIGlmIChtZXJnZVN0YXRlLmtpbmQgPT09IFwibm8tbWVyZ2VcIikge1xuICAgIHJldHVybiBhd2FpdCByZWZ1c2VSZXNvbHV0aW9uKG1lcmdlU3RhdGUuZGV0YWlsLCB0cnVlKTtcbiAgfVxuICBpZiAobWVyZ2VTdGF0ZS5raW5kID09PSBcImFscmVhZHktY29tbWl0dGVkXCIpIHtcbiAgICAvLyBFdmVyeSBzaWRlIHRoZSB0cmlhZ2UgY2hvc2Ugd2FzIHN0YWdlZCBiZWZvcmUgYW55IHJ1bmcgcmFuIChJc3N1ZVxuICAgIC8vICMyMDA2KSwgc28gYSBydW5nIHRoYXQgY29tbWl0dGVkIHRoZSBtZXJnZSBjb21taXR0ZWQgdGhvc2Ugc2lkZXMgdG9vO1xuICAgIC8vIHRoZSBhZG9wdGVkIGNvbW1pdCBpcyBqdWRnZWQgb24gaXRzIHNhZmV0eSBhbG9uZS5cbiAgICAvLyBUaGUgaW5kZXggZ2F0ZSBzYXcgbm90aGluZyB0byBpbnNwZWN0LCBzbyB0aGUgY29tbWl0J3Mgb3duIGNoYW5nZXMgYXJlXG4gICAgLy8gaGVsZCB0byBpdCBoZXJlIHJhdGhlciB0aGFuIGFkb3B0ZWQgdW5jaGVja2VkIChJc3N1ZSAjMTc1OCkuXG4gICAgY29uc3Qgc2FmZSA9IGF3YWl0IGFzc2VydEFkb3B0ZWRNZXJnZUlzU2FmZSh7XG4gICAgICBwcmVNZXJnZVNoYSxcbiAgICAgIGRlZmF1bHRTaGEsXG4gICAgICBvcHRpb25zLFxuICAgIH0pO1xuICAgIGlmICghc2FmZS5vaykge1xuICAgICAgcmV0dXJuIGF3YWl0IHJlZnVzZVJlc29sdXRpb24oXG4gICAgICAgIGB0aGUgbWVyZ2UgY29tbWl0IHdhcyB3cml0dGVuIGJ5IGFub3RoZXIgcnVuZyBhbmQgJHtzYWZlLmVycm9yLm1lc3NhZ2V9YCxcbiAgICAgICAgdHJ1ZSxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gVGhlIHRyaWFnZSdzIHNpZGVzIHdlcmUgdGFrZW4gYmVmb3JlIHRoZSBsYWRkZXIgY2xpbWJlZCAoSXNzdWUgIzIwMDYpO1xuICAvLyB3aGF0IHJlbWFpbnMgaXMgdG8gcHJvdmUgbm8gcnVuZyBsZWZ0IGFueXRoaW5nIHVubWVyZ2VkLlxuXG4gIC8vIFRoZSB0cmVlIG11c3QgYmUgZnVsbHkgcmVzb2x2ZWQg4oCUIGJ5IHRoZSB0cmlhZ2UsIHRoZSBydWxlcywgdGhlIGFnZW50IG9yXG4gIC8vIGFsbCB0aHJlZSAoSXNzdWUgIzE3NzcpLiBBIHBhdGggc3RpbGwgdW5tZXJnZWQsIG9yIGEgZmlsZSBzdGlsbCBjYXJyeWluZ1xuICAvLyBjb25mbGljdCBtYXJrZXJzLCBpcyBhIGhhbGYtcmVzb2x1dGlvbjogaXQgY29tcGlsZXMgbm93aGVyZSBhbmQgbXVzdFxuICAvLyBuZXZlciBiZSBjb21taXR0ZWQgYXMgYSBtZXJnZS4gQm90aCBndWFyZHMgcnVuIG92ZXIgZXZlcnkgY29uZmxpY3RlZFxuICAvLyBwYXRoLCBzbyBhIHJ1bmcgdGhhdCByZXBvcnRlZCBzdWNjZXNzIHdoaWxlIGxlYXZpbmcgYSBtZXNzIGlzIGNhdWdodFxuICAvLyBoZXJlIHJhdGhlciB0aGFuIHB1c2hlZC5cbiAgY29uc3QgdW5yZXNvbHZlZCA9IGF3YWl0IGxpc3RVbm1lcmdlZFBhdGhzKG9wdGlvbnMpO1xuICBpZiAoIXVucmVzb2x2ZWQub2spIHtcbiAgICBhd2FpdCBydW5HaXRDb21tYW5kKFtcIm1lcmdlXCIsIFwiLS1hYm9ydFwiXSwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBSZWZ1c2luZyB0byBjb21taXQgdGhlIHJlc29sdXRpb24gb2YgJyR7ZGVmYXVsdEJyYW5jaH0nIGludG8gYCArXG4gICAgICAgICAgYCcke21pbGVzdG9uZUJyYW5jaH0nOiAke3VucmVzb2x2ZWQuZXJyb3IubWVzc2FnZX0gKElzc3VlICMxNzc3KWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgaWYgKHVucmVzb2x2ZWQudmFsdWUubGVuZ3RoID4gMCkge1xuICAgIGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wibWVyZ2VcIiwgXCItLWFib3J0XCJdLCBvcHRpb25zKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYFJlZnVzaW5nIHRvIGNvbW1pdCB0aGUgcmVzb2x1dGlvbiBvZiAnJHtkZWZhdWx0QnJhbmNofScgaW50byBgICtcbiAgICAgICAgICBgJyR7bWlsZXN0b25lQnJhbmNofSc6ICR7dW5yZXNvbHZlZC52YWx1ZS5sZW5ndGh9IHBhdGgocykgYXJlIGAgK1xuICAgICAgICAgIGBzdGlsbCBgICtcbiAgICAgICAgICBgdW5tZXJnZWQgKElzc3VlICMxNzc3KTogJHt1bnJlc29sdmVkLnZhbHVlLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IG1hcmtlcnMgPSBhd2FpdCBoYXNDb25mbGljdE1hcmtlcnMoY29uZmxpY3RlZEZpbGVzLCBvcHRpb25zKTtcbiAgaWYgKCFtYXJrZXJzLm9rKSB7XG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJtZXJnZVwiLCBcIi0tYWJvcnRcIl0sIG9wdGlvbnMpO1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgUmVmdXNpbmcgdG8gY29tbWl0IHRoZSByZXNvbHV0aW9uIG9mICcke2RlZmF1bHRCcmFuY2h9JyBpbnRvIGAgK1xuICAgICAgICAgIGAnJHttaWxlc3RvbmVCcmFuY2h9JzogJHttYXJrZXJzLmVycm9yLm1lc3NhZ2V9IChJc3N1ZSAjMTc3NylgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGlmIChtYXJrZXJzLnZhbHVlKSB7XG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJtZXJnZVwiLCBcIi0tYWJvcnRcIl0sIG9wdGlvbnMpO1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgUmVmdXNpbmcgdG8gY29tbWl0IHRoZSByZXNvbHV0aW9uIG9mICcke2RlZmF1bHRCcmFuY2h9JyBpbnRvIGAgK1xuICAgICAgICAgIGAnJHttaWxlc3RvbmVCcmFuY2h9JzogdGhlIHdvcmtpbmcgdHJlZSBzdGlsbCBjb250YWlucyBjb25mbGljdCBgICtcbiAgICAgICAgICBgbWFya2VycyAoSXNzdWUgIzE3NzcpYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHJlc29sdXRpb25NZXNzYWdlID0gYnVpbGRSZXNvbHV0aW9uQ29tbWl0TWVzc2FnZSh7XG4gICAgZGVmYXVsdEJyYW5jaCxcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgcGxhbjogeyAuLi5wbGFuLCByZXNvbHZlZCwgZXNjYWxhdGlvbnMgfSxcbiAgfSk7XG5cbiAgLy8gQW4gYWxyZWFkeS1jb21taXR0ZWQgbWVyZ2Uga2VlcHMgaXRzIGNvbW1pdCBhbmQgdGFrZXMgdGhlIHN5bmMncyBtZXNzYWdlLFxuICAvLyBzbyB0aGUgcmVjb3JkIG9mIHdoaWNoIHJ1bmcgc2V0dGxlZCBlYWNoIGZpbGUgaXMgdGhlIHNhbWUgZWl0aGVyIHdheS5cbiAgY29uc3QgYWxyZWFkeUNvbW1pdHRlZCA9IG1lcmdlU3RhdGUua2luZCA9PT0gXCJhbHJlYWR5LWNvbW1pdHRlZFwiO1xuICBjb25zdCBjb21taXRSZXN1bHQgPSBhbHJlYWR5Q29tbWl0dGVkXG4gICAgPyBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgW1wiY29tbWl0XCIsIFwiLS1hbWVuZFwiLCBcIi1tXCIsIHJlc29sdXRpb25NZXNzYWdlXSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKVxuICAgIDogYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJjb21taXRcIiwgXCItbVwiLCByZXNvbHV0aW9uTWVzc2FnZV0sIG9wdGlvbnMpO1xuICBpZiAoIWNvbW1pdFJlc3VsdC5vayB8fCBjb21taXRSZXN1bHQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIC8vIEhvbmVzdCBmYWlsdXJlIChJc3N1ZSAjNDI2MCksIHdpdGggZ2l0J3Mgc3Rkb3V0IGFzIHdlbGwgYXMgaXRzIHN0ZGVyclxuICAgIC8vIChJc3N1ZSAjMTk2NCkg4oCUIGBnaXQgY29tbWl0YCBleHBsYWlucyBpdHNlbGYgb24gc3Rkb3V0LiBFaXRoZXIgd2F5IHRoZVxuICAgIC8vIGJyYW5jaCBnb2VzIGJhY2sgd2hlcmUgaXQgc3Rvb2Q6IGFuIHVuLXJld29yZGVkIG1lcmdlIGxlZnQgYmVoaW5kIHdvdWxkXG4gICAgLy8gYmUgcHVzaGVkIG5leHQgY3ljbGUgd2l0aCBubyByZWNvcmQgb2Ygd2hpY2ggcnVuZyBzZXR0bGVkIHdoYXQuXG4gICAgaWYgKGFscmVhZHlDb21taXR0ZWQpIHtcbiAgICAgIHJldHVybiBhd2FpdCByZWZ1c2VSZXNvbHV0aW9uKFxuICAgICAgICBgaXRzIGNvbW1pdCBjb3VsZCBub3QgYmUgcmUtd29yZGVkOiAke1xuICAgICAgICAgIGRlc2NyaWJlR2l0RmFpbHVyZShjb21taXRSZXN1bHQpXG4gICAgICAgIH1gLFxuICAgICAgICB0cnVlLFxuICAgICAgKTtcbiAgICB9XG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJtZXJnZVwiLCBcIi0tYWJvcnRcIl0sIG9wdGlvbnMpO1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgRmFpbGVkIHRvIGNvbW1pdCB0aGUgY29uZmxpY3QgcmVzb2x1dGlvbiBmb3IgJyR7bWlsZXN0b25lQnJhbmNofScgYCArXG4gICAgICAgICAgYChJc3N1ZXMgIzQyNjAsICMxOTY0KTogJHtkZXNjcmliZUdpdEZhaWx1cmUoY29tbWl0UmVzdWx0KX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gSXNzdWUgIzIwMzA6IHRoZSBhZ2VudCBydW5nIHRha2VzIG1pbnV0ZXM7IGEgc2libGluZyBtYXkgaGF2ZSBsYW5kZWRcbiAgLy8gdGhpcyB2ZXJ5IHN5bmMgbWVhbndoaWxlLiBJdHMgcmVzdWx0IGlzIHRoZSBicmFuY2gncyBub3csIG5vdCBvdXJzLlxuICBpZiAoYXdhaXQgYWxyZWFkeVN5bmNlZEVsc2V3aGVyZShtaWxlc3RvbmVCcmFuY2gsIGRlZmF1bHRCcmFuY2gsIG9wdGlvbnMpKSB7XG4gICAgcmV0dXJuIGF3YWl0IGFkb3B0UmVtb3RlU3luYyhtaWxlc3RvbmVCcmFuY2gsIGRlZmF1bHRCcmFuY2gsIG9wdGlvbnMpO1xuICB9XG4gIC8vIEEgcmVzb2x1dGlvbiB0aGUgd29ya2VyIGNob3NlIGlzIHZlcmlmaWVkIHRoZSB3YXkgYSBodW1hbidzIHdvdWxkIGJlXG4gIC8vIChJc3N1ZSAjMTU1OSk6IHRoZSByZXBvc2l0b3J5J3Mgb3duIGNoZWNrLCBpdHMgbWFuaWZlc3QgY2hlY2sgYW5kIGl0c1xuICAvLyB1bml0IHN1aXRlLiBBIHRyZWUgdGhhdCBkZWZpbmVzIG5vbmUgb2YgdGhlbSB2ZXJpZmllZCBub3RoaW5nLCBzb1xuICAvLyBgc2tpcHBlZGAgcmVmdXNlcyB0aGUgcHVzaCByYXRoZXIgdGhhbiByZWFkaW5nIGFzIGEgcGFzcyDigJQgZXhjZXB0IGFcbiAgLy8gbWVyZ2Utb25seSBnYXRlJ3MgYHNraXBwZWRgIG1hcmtlZCBgbGFuZFVudmVyaWZpZWRgIChJc3N1ZSAjNDMyNiksIHdoaWNoIGlzXG4gIC8vIHB1c2hlZCB3aXRoIHRoZSBgVU5HQVRFRDpgIG5vdGUuXG4gIGNvbnN0IHJ1blJlc29sdXRpb25HYXRlID0gKCk6IFByb21pc2U8TWVyZ2VHYXRlT3V0Y29tZT4gPT5cbiAgICByZXNvbHV0aW9uR2F0ZShvcHRpb25zLmN3ZCA/PyBcIi5cIik7XG5cbiAgLy8gSXNzdWUgIzE5NjU6IGEgZ2F0ZSBmYWlsdXJlIGFmdGVyIGEgcmVzb2x1dGlvbiBpcyB1c3VhbGx5IGEgc2VtYW50aWNcbiAgLy8gY29uZmxpY3QgZ2l0IG5ldmVyIHJlcG9ydGVkIOKAlCB0aGUgZGVmYXVsdCBicmFuY2ggY2hhbmdlZCBhbiBpbnRlcmZhY2VcbiAgLy8gdGhpcyBicmFuY2ggaW1wbGVtZW50cyB3aGVyZSBubyBodW5rIG92ZXJsYXBwZWQuIEl0IGdvZXMgYmFjayB0byB0aGVcbiAgLy8gYWdlbnQgcnVuZyB3aXRoIHRoZSBjb21waWxlcidzIG93biBvdXRwdXQsIG5vdCBzdHJhaWdodCB0byBhIGh1bWFuLCBhbmRcbiAgLy8gYSByZXBhaXIgdGhhdCB3b3JrcyBpcyBmb2xkZWQgaW50byB0aGUgbWVyZ2UgY29tbWl0LlxuICAvLyBJc3N1ZSAjMjMwODogYSByZXBhaXIgcm91bmQgcnVucyB0aGUgcmVzb2x1dGlvbiBhZ2VudCBmcm9tICppbnNpZGUqIHRoZVxuICAvLyB2ZXJpZmljYXRpb24sIGFuZCB0aGF0IHJ1biBpcyB1c3VhbGx5IHRoZSBsYXJnZXN0IHNpbmdsZSBibG9jayBvZiB0aGVcbiAgLy8gc3luYy4gSXRzIG1pbnV0ZXMgYmVsb25nIHRvIGBhZ2VudGAsIG5vdCB0byBgZ2F0ZWAg4oCUIG90aGVyd2lzZSB0aGUgbGluZVxuICAvLyBhdHRyaWJ1dGVzIHRoZSB0aW1lIHRvIHRoZSB3cm9uZyBzdGFnZSwgd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBpdCBleGlzdHNcbiAgLy8gdG8gZ2V0IHJpZ2h0LiBUaGUgZ2F0ZSdzIG93biBzbGljZXMgZWl0aGVyIHNpZGUgb2YgdGhlIHJlcGFpciBhY2N1bXVsYXRlLlxuICBjb25zdCB0aW1lZFJlcGFpckFnZW50OiBNaWxlc3RvbmVDb25mbGljdEFnZW50Rm4gfCB1bmRlZmluZWQgPSBhZ2VudEZuXG4gICAgPyBhc3luYyAocmVxdWVzdCkgPT4ge1xuICAgICAgdGltZXIuc3RvcCgpO1xuICAgICAgdGltZXIuc3RhcnQoXCJhZ2VudFwiKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBhZ2VudEZuKHJlcXVlc3QpO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgdGltZXIuc3RvcCgpO1xuICAgICAgICB0aW1lci5zdGFydChcImdhdGVcIik7XG4gICAgICB9XG4gICAgfVxuICAgIDogdW5kZWZpbmVkO1xuXG4gIHRpbWVyLnN0YXJ0KFwiZ2F0ZVwiKTtcbiAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBydW5HYXRlV2l0aFJlcGFpcih7XG4gICAgZ2F0ZTogcnVuUmVzb2x1dGlvbkdhdGUsXG4gICAgLi4uKHRpbWVkUmVwYWlyQWdlbnQgPyB7IGFnZW50Rm46IHRpbWVkUmVwYWlyQWdlbnQgfSA6IHt9KSxcbiAgICBvcHRpb25zLFxuICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICBkZWZhdWx0QnJhbmNoLFxuICAgIHByZU1lcmdlU2hhLFxuICAgIGRlZmF1bHRSZWY6IGRlZmF1bHRTaGEgfHwgZGVmYXVsdEJyYW5jaCxcbiAgICByZXNvbHV0aW9uTWVzc2FnZSxcbiAgICBjb25mbGljdGVkRmlsZXMsXG4gICAgLi4uKGxvZ2dlciA/IHsgbG9nZ2VyIH0gOiB7fSksXG4gIH0pO1xuICB0aW1lci5zdG9wKCk7XG4gIGlmICh2ZXJpZmllZC5hbWVuZEZhaWx1cmUpIHtcbiAgICByZXR1cm4gYXdhaXQgcmVmdXNlUmVzb2x1dGlvbih2ZXJpZmllZC5hbWVuZEZhaWx1cmUsIHRydWUpO1xuICB9XG4gIGNvbnN0IHsgZ2F0ZTogZmluYWxHYXRlLCBmaXJzdEdhdGUsIHJlcGFpciB9ID0gdmVyaWZpZWQ7XG5cbiAgdGltZXIuc3RhcnQoXCJwdXNoXCIpO1xuICBjb25zdCBnYXRlZFJlc29sdmVkID0gYXdhaXQgZ2F0ZVRoZW5QdXNoTWlsZXN0b25lQnJhbmNoKFxuICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICBkZWZhdWx0QnJhbmNoLFxuICAgIG9wdGlvbnMsXG4gICAgcmVwbyxcbiAgICAoKSA9PiBQcm9taXNlLnJlc29sdmUoZmluYWxHYXRlKSxcbiAgICBwcmVNZXJnZVNoYSxcbiAgKTtcbiAgdGltZXIuc3RvcCgpO1xuICBpZiAoIWdhdGVkUmVzb2x2ZWQub2spIHtcbiAgICAvLyBUaGUgcmVzb2x1dGlvbiB3YXMgbWFkZSBhbmQgdGhlIHZlcmlmaWNhdGlvbiByZWZ1c2VkIGl0LiBUaGUgcmVhZGVyXG4gICAgLy8gZ2V0cyBib3RoIGhhbHZlcyAoSXNzdWUgIzE1NTkpIOKAlCB3aGF0IHRoZSBnYXRlIHNhaWQsIGFuZCB0aGUgdHdvIHNpZGVzXG4gICAgLy8gdGhhdCBwcm9kdWNlZCBpdCDigJQgcmF0aGVyIHRoYW4gdGhlIHdhbGwgb2YgY29tcGlsZXIgb3V0cHV0IHRoYXQgbWFkZVxuICAgIC8vICMxNTQyIG5lYXJseSB1c2VsZXNzIGZvciBkZWNpZGluZyBhbnl0aGluZy4gVGhlIGJyYW5jaCB3YXMgYWxyZWFkeVxuICAgIC8vIHJlc2V0IGJ5IHRoZSBnYXRlLCBzbyBub3RoaW5nIHdhcyBwdXNoZWQuXG4gICAgLy8gQm90aCBnYXRlIG91dHB1dHMgdHJhdmVsIHdpdGggdGhlIGVzY2FsYXRpb24gKElzc3VlICMxOTY1KTogdGhlXG4gICAgLy8gcmVmdXNhbCBhYm92ZSBjYXJyaWVzIHRoZSBsYXN0IG9uZSwgYW5kIHRoZSBub3RlIGNhcnJpZXMgdGhlIGZpcnN0LFxuICAgIC8vIHNvIGEgcmVhZGVyIGNhbiB0ZWxsIGEgcmVwYWlyIHRoYXQgaGVscGVkIG5vdGhpbmcgZnJvbSBvbmUgdGhhdCBtYWRlXG4gICAgLy8gaXQgd29yc2Ug4oCUIG9yIHNlZSB0aGF0IG5vIHJlcGFpciB3YXMgYXR0ZW1wdGVkLCBhbmQgd2h5LlxuICAgIGNvbnN0IGdhdGVGYWlsdXJlID0gcmVwYWlyXG4gICAgICA/IGAke2dhdGVkUmVzb2x2ZWQuZXJyb3IubWVzc2FnZX1cXG5cXG4ke1xuICAgICAgICBkZXNjcmliZVJlcGFpckVzY2FsYXRpb24oZmlyc3RHYXRlLCByZXBhaXIpXG4gICAgICB9YFxuICAgICAgOiBnYXRlZFJlc29sdmVkLmVycm9yLm1lc3NhZ2U7XG4gICAgLy8gQSBnYXRlIHRoYXQgcmVmdXNlZCBzdGlsbCBzcGVudCB0aGUgbWludXRlcyAoSXNzdWUgIzIzMDgpLCBhbmQgdGhlXG4gICAgLy8gcmVmdXNhbCBjYXJyaWVzIHRoZW0gKElzc3VlICMyMzExKS5cbiAgICBjb25zdCBnYXRlVGltaW5ncyA9IHJlY29yZFRpbWluZ3MoKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBNaWxlc3RvbmVDb25mbGljdEVzY2FsYXRpb24oXG4gICAgICAgIGdhdGVGYWlsdXJlLFxuICAgICAgICAvLyBUaGUgcnVuZyB0aGF0IGFjdHVhbGx5IHNldHRsZWQgZWFjaCBmaWxlLCBub3QgdGhlIHRyaWFnZSdzXG4gICAgICAgIC8vIHByZS1sYWRkZXIgdmVyZGljdCBvbiBpdDogYSBmaWxlIHRoZSBydWxlcyBvciB0aGUgYWdlbnQgZGVjaWRlZFxuICAgICAgICAvLyB3b3VsZCBvdGhlcndpc2UgYmUgcHJlc2VudGVkIGFzIG9uZSBub3RoaW5nIGNvdWxkIGRlY2lkZS5cbiAgICAgICAgc2lkZXMubWFwKChzaWRlKSA9PlxuICAgICAgICAgIGFuYWx5c2VDb25mbGljdGVkRmlsZShcbiAgICAgICAgICAgIHNpZGUsXG4gICAgICAgICAgICBzZXR0bGVkLmdldChzaWRlLnBhdGgpPy5yZWFzb24gPz8gXCJyZXNvbHZlZCBhdXRvbWF0aWNhbGx5XCIsXG4gICAgICAgICAgKVxuICAgICAgICApLFxuICAgICAgICByZXNvbHZlZCxcbiAgICAgICAgZGVmYXVsdFNoYSxcbiAgICAgICAgZ2F0ZUZhaWx1cmUsXG4gICAgICAgIHByZU1lcmdlU2hhLFxuICAgICAgICBnYXRlVGltaW5ncyxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEVhY2ggZmlsZSBuYW1lcyB0aGUgcnVuZyB0aGF0IHNldHRsZWQgaXQgKElzc3VlICMxNzc3KSwgc28gdGhlIGxvZyBsaW5lXG4gIC8vIHNheXMgd2hpY2ggb2YgdHJpYWdlLCBydWxlcyBvciBhZ2VudCBkaWQgdGhlIHdvcmsuXG4gIGNvbnN0IHN1bW1hcnkgPSByZXNvbHZlZFxuICAgIC5tYXAoKGQpID0+XG4gICAgICBgJHtkLnBhdGh9ICgke1xuICAgICAgICBkZXNjcmliZURlY2lzaW9uUnVuZyhkLCB7XG4gICAgICAgICAgb3VyczogbWlsZXN0b25lQnJhbmNoLFxuICAgICAgICAgIHRoZWlyczogZGVmYXVsdEJyYW5jaCxcbiAgICAgICAgfSlcbiAgICAgIH0pYFxuICAgIClcbiAgICAuam9pbihcIiwgXCIpO1xuICAvLyBBIHJlc29sdXRpb24gdGhlIGdhdGUgcmVmdXNlZCBhbmQgdGhlIGFnZW50IHJ1bmcgdGhlbiByZXBhaXJlZCBzYXlzIHNvXG4gIC8vIHdoZXJldmVyIGl0IGlzIHJlYWQgKElzc3VlICMxOTY1KS5cbiAgY29uc3QgcmVwYWlyZWQgPSByZXBhaXI/LnN0YXR1cyA9PT0gXCJyZXBhaXJlZFwiID8gcmVwYWlyLnJlY29yZCA6IHVuZGVmaW5lZDtcbiAgLy8gV2hlcmUgdGhlIHN5bmMncyBtaW51dGVzIHdlbnQgKElzc3VlICMyMzA4KS5cbiAgY29uc3QgdGltaW5ncyA9IHJlY29yZFRpbWluZ3MoKTtcbiAgLy8gVGhlIG1lcmdlIGNvbW1pdCB0aGlzIHJlc29sdXRpb24gcHJvZHVjZWQgKElzc3VlICMyOTk4KSwgc28gYSBsYXRlclxuICAvLyByZXBvcnQgY2FuIGNvbmZpcm0gaXQgYWN0dWFsbHkgbGFuZGVkIHJhdGhlciB0aGFuIHRydXN0aW5nIHRoaXMgcHVzaC5cbiAgY29uc3QgbWVyZ2VTaGEgPSBhd2FpdCByZWFkUmVmKFwiSEVBRFwiLCBvcHRpb25zKTtcbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICB2YWx1ZToge1xuICAgICAgbWVzc2FnZTpcbiAgICAgICAgYCR7c2VsZkhlYWxOb3RlfSR7Z2F0ZWRSZXNvbHZlZC52YWx1ZX1Jc3N1ZXMgIzE1NTksICMxNzc3OiByZXNvbHZlZCAke3Jlc29sdmVkLmxlbmd0aH0gY29uZmxpY3QocykgYXV0b21hdGljYWxseSDigJQgJHtzdW1tYXJ5fSR7XG4gICAgICAgICAgcmVwYWlyZWQgPyBgIOKAlCAke3N1bW1hcmlzZUdhdGVSZXBhaXIocmVwYWlyZWQpfWAgOiBcIlwiXG4gICAgICAgIH1gLFxuICAgICAgY29uZmxpY3Q6IHtcbiAgICAgICAgZmlsZXM6IGNvbmZsaWN0ZWRGaWxlcyxcbiAgICAgICAgbWlsZXN0b25lU2hhOiBwcmVNZXJnZVNoYSxcbiAgICAgICAgZGVmYXVsdFNoYSxcbiAgICAgICAgcmVzb2x1dGlvbjogXCJhdXRvXCIsXG4gICAgICAgIC4uLihmaW5hbEdhdGUuc3RhdHVzID09PSBcInNraXBwZWRcIlxuICAgICAgICAgID8geyB1bnZlcmlmaWVkOiB0cnVlIH1cbiAgICAgICAgICA6IGZpbmFsR2F0ZS5jYXJnb1NraXBwZWRcbiAgICAgICAgICA/IHsgY2FyZ29Ta2lwcGVkOiB0cnVlIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgICAgLi4uKGZpbmFsR2F0ZS5zdWl0ZUxlZnRUb0NpXG4gICAgICAgICAgPyB7IHN1aXRlTGVmdFRvQ2k6IGZpbmFsR2F0ZS5zdWl0ZUxlZnRUb0NpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgICAgLi4uKGZpbmFsR2F0ZS5jaGVja0xlZnRUb0NpXG4gICAgICAgICAgPyB7IGNoZWNrTGVmdFRvQ2k6IGZpbmFsR2F0ZS5jaGVja0xlZnRUb0NpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgICAgZGVjaXNpb25zOiByZXNvbHZlZCxcbiAgICAgICAgLi4uKHJlcGFpcmVkID8geyByZXBhaXI6IHJlcGFpcmVkIH0gOiB7fSksXG4gICAgICAgIC8vIElzc3VlICMyMzA2OiB0aGUgYWdlbnQgbmFtZXMgZWFjaCBqdWRnZW1lbnQgY2FsbCBmaWxlIGJ5IGZpbGUgaW5cbiAgICAgICAgLy8gaXRzIHJlcGx5LCBhbmQgdGhpcyBjb21tZW50IGlzIHdoZXJlIHRoYXQgcmVjb3JkIHN1cmZhY2VzIG9uIHRoZVxuICAgICAgICAvLyBtaWxlc3RvbmUgcGF0aC5cbiAgICAgICAgLi4uKGxhZGRlci5hZ2VudFJlcGx5ID8geyBhZ2VudFJlcGx5OiBsYWRkZXIuYWdlbnRSZXBseSB9IDoge30pLFxuICAgICAgICB0aW1pbmdzLFxuICAgICAgICAuLi4obWVyZ2VTaGEgPyB7IG1lcmdlU2hhIH0gOiB7fSksXG4gICAgICB9LFxuICAgIH0sXG4gIH07XG59XG5cbi8qKiBFcnJvciBuYW1lIGZvciBhIFBSIGJyYW5jaCBsZWZ0IHVudG91Y2hlZCBiZWNhdXNlIGl0cyBjaGFuZ2VzIGNvbmZsaWN0IChJc3N1ZSAjNDM3MykuICovXG5leHBvcnQgY29uc3QgUFJfQlJBTkNIX0NPTkZMSUNUX0VSUk9SID0gXCJQckJyYW5jaENvbmZsaWN0XCI7XG5cbi8qKlxuICogQSBQUiBicmFuY2ggd2hvc2UgY2hhbmdlcyBjb2xsaWRlIHdpdGggaXRzIGJhc2UgKElzc3VlICM0MzczKS4gVGhlIHdvcmtlclxuICogbmV2ZXIgcmVzb2x2ZXMgc3VjaCBhIGNvbmZsaWN0IGJ5IHBpY2tpbmcgYSBzaWRlIOKAlCB0aGF0IGVpdGhlciBkaXNjYXJkc1xuICogdGhlIFBSJ3Mgd29yayAodXBzdHJlYW0gd2lucykgb3IgcmV2ZXJ0cyBiYXNlLWJyYW5jaCB3b3JrIChQUiB3aW5zKSxcbiAqIHNpbGVudGx5LCB1bmRlciBhIGNvbW1pdCB0aGF0IHN0aWxsIGNhcnJpZXMgdGhlIFBSJ3MgbWVzc2FnZTsgb2JzZXJ2ZWRcbiAqIGxpdmUgd2hlbiAjNDM3MiBsb3N0IGl0cyB3aG9sZSBjbGF1ZGVfcnVubmVyLnRzIGNoYW5nZSB0byBhIG1haW50ZW5hbmNlXG4gKiByZWJhc2UuIFRoZSBicmFuY2ggaXMgbGVmdCBleGFjdGx5IGFzIGl0IHdhcyBmb3IgYSByZWFsIG1lcmdlICh0aGVcbiAqIFBSLWZlZWRiYWNrIGFnZW50IG9yIGEgaHVtYW4pLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJCcmFuY2hDb25mbGljdEVycm9yKFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIGJhc2VCcmFuY2g6IHN0cmluZyxcbiAgaG93OiBzdHJpbmcsXG4pOiBFcnJvciB7XG4gIGNvbnN0IGVyciA9IG5ldyBFcnJvcihcbiAgICBgUFIgYnJhbmNoICcke2JyYW5jaE5hbWV9JyBjb25mbGljdHMgd2l0aCAnJHtiYXNlQnJhbmNofScgKCR7aG93fSkg4oCUIGxlZnQgdW50b3VjaGVkOiB0aGUgd29ya2VyIGRvZXMgbm90IHJlc29sdmUgY29uZmxpY3RzIGJ5IHBpY2tpbmcgYSBzaWRlIChJc3N1ZSAjNDM3Myk7IHJlc29sdmUgd2l0aCBhIHJlYWwgbWVyZ2VgLFxuICApO1xuICBlcnIubmFtZSA9IFBSX0JSQU5DSF9DT05GTElDVF9FUlJPUjtcbiAgcmV0dXJuIGVycjtcbn1cblxuLyoqIFdoZXRoZXIgYW4gZXJyb3IgaXMgdGhlIGxlZnQtdW50b3VjaGVkIGNvbmZsaWN0IG91dGNvbWUgKElzc3VlICM0MzczKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ByQnJhbmNoQ29uZmxpY3RFcnJvcihlcnI6IHVua25vd24pOiBib29sZWFuIHtcbiAgcmV0dXJuIGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5uYW1lID09PSBQUl9CUkFOQ0hfQ09ORkxJQ1RfRVJST1I7XG59XG5cbi8qKlxuICogVGhlIHJlZiBhIFBSIHNob3VsZCBiZSBqdWRnZWQgYW5kIHJlYmFzZWQgYWdhaW5zdCAoSXNzdWUgIzM5NCkuXG4gKlxuICogYHJlZnMvcmVtb3Rlcy9vcmlnaW4vPGJhc2U+YCB3aGVuIHRoZSBjbG9uZSBoYXMgaXQg4oCUIHRoZSBiYXNlIGFzIHB1Ymxpc2hlZCxcbiAqIHdoaWNoIGlzIHdoYXQgR2l0SHViIGNvbXBhcmVkIHRoZSBQUiB3aXRoIOKAlCBmYWxsaW5nIGJhY2sgdG8gdGhlIGxvY2FsXG4gKiBicmFuY2ggbmFtZSB3aGVuIHRoZXJlIGlzIG5vIHRyYWNraW5nIHJlZiAoYSBiYXNlIHRoYXQgZXhpc3RzIG9ubHkgbG9jYWxseSxcbiAqIGFzIGluIHNldmVyYWwgdW5pdCBmaXh0dXJlcykuXG4gKlxuICogVGhlIGxvY2FsIGJhc2UgcmVmIGNhbm5vdCBiZSByZWxpZWQgb24gaGVyZTogaXQgaXMgc2hhcmVkIHdpdGggZXZlcnkgb3RoZXJcbiAqIGxhbmUgb24gdGhlIGhvc3QsIGFuZCBnaXQgcmVmdXNlcyB0byBtb3ZlIGEgYnJhbmNoIGFub3RoZXIgd29ya3RyZWUgaGFzXG4gKiBjaGVja2VkIG91dCwgc28gYGVuc3VyZURlZmF1bHRCcmFuY2hDdXJyZW50YCBjYW4gbGVnaXRpbWF0ZWx5IGxlYXZlIGl0XG4gKiBiZWhpbmQgdGhlIHJlbW90ZS5cbiAqXG4gKiBAcGFyYW0gYmFzZUJyYW5jaCAtIFRoZSBQUidzIGJhc2UgYnJhbmNoIG5hbWVcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9ucyAoY3dkIHNlbGVjdHMgdGhlIGNsb25lIG9yIHdvcmt0cmVlKVxuICogQHJldHVybnMgVGhlIHJlZiB0byB1c2UgZm9yIGNvbXBhcmlzb24sIHJlYmFzZSBhbmQgbWVyZ2VcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZVB1Ymxpc2hlZEJhc2VSZWYoXG4gIGJhc2VCcmFuY2g6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCB0cmFja2luZ1JlZiA9IGByZWZzL3JlbW90ZXMvb3JpZ2luLyR7YmFzZUJyYW5jaH1gO1xuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wicmV2LXBhcnNlXCIsIFwiLS12ZXJpZnlcIiwgXCItLXF1aWV0XCIsIHRyYWNraW5nUmVmXSxcbiAgICBvcHRpb25zLFxuICApO1xuICByZXR1cm4gcmVzb2x2ZWQub2sgJiYgcmVzb2x2ZWQudmFsdWUuY29kZSA9PT0gMCA/IHRyYWNraW5nUmVmIDogYmFzZUJyYW5jaDtcbn1cblxuLyoqXG4gKiBNZXJnZSBgYmFzZVJlZmAgaW50byB0aGUgY2hlY2tlZC1vdXQgYnJhbmNoLCBuZXZlciBwaWNraW5nIGEgc2lkZVxuICogKElzc3VlcyAjNDM3MywgIzI4MDcpLlxuICpcbiAqIEEgY29uZmxpY3RpbmcgbWVyZ2UgaXMgYWJvcnRlZCBhbmQgcmV0dXJuZWQgYXMge0BsaW5rIHByQnJhbmNoQ29uZmxpY3RFcnJvcn1cbiAqIHNvIHRoZSBjb25mbGljdCBsYWRkZXIgdGFrZXMgb3ZlciB3aXRoIHRoZSBicmFuY2ggZXhhY3RseSBhcyBpdCB3YXMuIEFueVxuICogb3RoZXIgbWVyZ2UgZmFpbHVyZSBpcyBhIGZhaWx1cmUgY2FycnlpbmcgZ2l0J3Mgb3duIG91dHB1dC5cbiAqXG4gKiBAcGFyYW0gYnJhbmNoTmFtZSAtIFRoZSBjaGVja2VkLW91dCBicmFuY2ggYmVpbmcgdXBkYXRlZFxuICogQHBhcmFtIGJhc2VCcmFuY2ggLSBUaGUgYmFzZSBicmFuY2gncyBuYW1lLCBmb3IgdGhlIG9wZXJhdG9yLWZhY2luZyB2ZXJkaWN0XG4gKiBAcGFyYW0gYmFzZVJlZiAtIFRoZSByZWYgYWN0dWFsbHkgbWVyZ2VkIGluXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnNcbiAqIEByZXR1cm5zIFN1Y2Nlc3Mgb25jZSB0aGUgbWVyZ2UgY29tbWl0IChvciBmYXN0LWZvcndhcmQpIGlzIGluIHBsYWNlXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1lcmdlQmFzZUludG9CcmFuY2goXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgYmFzZUJyYW5jaDogc3RyaW5nLFxuICBiYXNlUmVmOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3QgbWVyZ2VSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcIm1lcmdlXCIsIFwiLS1uby1lZGl0XCIsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCBiYXNlUmVmXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAobWVyZ2VSZXN1bHQub2sgJiYgbWVyZ2VSZXN1bHQudmFsdWUuY29kZSA9PT0gMCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH1cblxuICBjb25zdCB1bm1lcmdlZCA9IGF3YWl0IGxpc3RVbm1lcmdlZFBhdGhzKG9wdGlvbnMpO1xuICAvLyBBYm9ydCBvbmx5IGEgbWVyZ2UgZ2l0IGFjdHVhbGx5IHN0YXJ0ZWQsIGFuZCBmYWlsIGxvdWQgd2hlbiB0aGUgYWJvcnRcbiAgLy8gaXRzZWxmIGZhaWxzOiBhIGhhbGYtbWVyZ2VkIHRyZWUgaXMgbm90IFwibGVmdCBleGFjdGx5IGFzIGl0IHdhc1wiLlxuICBjb25zdCBtZXJnaW5nID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLXZlcmlmeVwiLCBcIi0tcXVpZXRcIiwgXCJNRVJHRV9IRUFEXCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmIChtZXJnaW5nLm9rICYmIG1lcmdpbmcudmFsdWUuY29kZSA9PT0gMCkge1xuICAgIGNvbnN0IGFib3J0ZWQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcIm1lcmdlXCIsIFwiLS1hYm9ydFwiXSwgb3B0aW9ucyk7XG4gICAgaWYgKCFhYm9ydGVkLm9rIHx8IGFib3J0ZWQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgIGBNZXJnaW5nICcke2Jhc2VSZWZ9JyBpbnRvICcke2JyYW5jaE5hbWV9JyBmYWlsZWQgYW5kIGAgK1xuICAgICAgICAgICAgYCdnaXQgbWVyZ2UgLS1hYm9ydCcgZmFpbGVkIHRvbzogJHtcbiAgICAgICAgICAgICAgZGVzY3JpYmVHaXRGYWlsdXJlKGFib3J0ZWQsIHsgbGluZXM6IDYsIGZyb206IFwiaGVhZFwiIH0pXG4gICAgICAgICAgICB9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICB9XG4gIGlmICh1bm1lcmdlZC5vayAmJiB1bm1lcmdlZC52YWx1ZS5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBwckJyYW5jaENvbmZsaWN0RXJyb3IoYnJhbmNoTmFtZSwgYmFzZUJyYW5jaCwgXCJtZXJnZVwiKSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICBgRmFpbGVkIHRvIG1lcmdlICcke2Jhc2VSZWZ9JyBpbnRvICcke2JyYW5jaE5hbWV9JzogJHtcbiAgICAgICAgZGVzY3JpYmVHaXRGYWlsdXJlKG1lcmdlUmVzdWx0LCB7IGxpbmVzOiA2LCBmcm9tOiBcImhlYWRcIiB9KVxuICAgICAgfWAsXG4gICAgKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBVcGRhdGUgYSBQUiBicmFuY2ggdG8gYmUgY3VycmVudCB3aXRoIGl0cyBiYXNlIGJyYW5jaFxuICogKElzc3VlcyAjMzc5LCAjNDk4LCAjMjgwNykuXG4gKlxuICogTWVyZ2VzIHRoZSBwdWJsaXNoZWQgYmFzZSBpbnRvIHRoZSBQUiBicmFuY2ggYW5kIHB1c2hlcyBub3JtYWxseSDigJQgbmV2ZXIgYVxuICogcmViYXNlLCBuZXZlciBhIGZvcmNlLXB1c2gg4oCUIHNvIGEgUFIgdW5kZXIgcmV2aWV3IGtlZXBzIGl0cyBjb21taXRzIGFuZCBpdHNcbiAqIHJldmlldyBjb21tZW50cy4gQSBcImNvbmZsaWN0aW5nXCIgUFIgKElzc3VlICMxMzEzKSB0YWtlcyB0aGUgc2FtZSBtZXJnZVxuICogd2hhdGV2ZXIgaXRzIGJlaGluZCBjb3VudCwgc2luY2UgR2l0SHViIGhhcyBhbHJlYWR5IHNlZW4gdGhlIGRpdmVyZ2VuY2UuXG4gKlxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgZmVhdHVyZSBicmFuY2ggdG8gdXBkYXRlXG4gKiBAcGFyYW0gYmFzZUJyYW5jaCAtIFRoZSBiYXNlIGJyYW5jaCB0byBzeW5jIHdpdGhcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9uc1xuICogQHBhcmFtIHJlYXNvbiAtIFdoeSB0aGUgYnJhbmNoIG5lZWRzIHVwZGF0aW5nIChcImJlaGluZFwiIG9yIFwiY29uZmxpY3RpbmdcIilcbiAqIEByZXR1cm5zIFJlc3VsdCBpbmRpY2F0aW5nIHN1Y2Nlc3Mgb3IgZmFpbHVyZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlUHJCcmFuY2goXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgYmFzZUJyYW5jaDogc3RyaW5nLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuICByZWFzb24/OiBcImJlaGluZFwiIHwgXCJjb25mbGljdGluZ1wiLFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nPj4ge1xuICAvLyBSZWZ1c2UgYW4gb3B0aW9uLWluamVjdGluZyByZWYgYmVmb3JlIGFueSBnaXQgcnVucyAoSXNzdWUgIzEyKS5cbiAgdHJ5IHtcbiAgICBhc3NlcnRTYWZlR2l0UmVmKGJyYW5jaE5hbWUsIFwiUFIgaGVhZCBicmFuY2ggbmFtZVwiKTtcbiAgICBhc3NlcnRTYWZlR2l0UmVmKGJhc2VCcmFuY2gsIFwiUFIgYmFzZSBicmFuY2ggbmFtZVwiKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSksXG4gICAgfTtcbiAgfVxuICAvLyBFbnN1cmUgdGhlIGxvY2FsIGJhc2UgYnJhbmNoIGlzIGN1cnJlbnRcbiAgYXdhaXQgZW5zdXJlRGVmYXVsdEJyYW5jaEN1cnJlbnQoYmFzZUJyYW5jaCwgb3B0aW9ucyk7XG5cbiAgLy8gSXNzdWUgIzM5NDogdGhlIGJhc2UgcmVmIHRoaXMgdXBkYXRlIGlzIGp1ZGdlZCBhZ2FpbnN0IGlzIHRoZSAqcHVibGlzaGVkKlxuICAvLyBvbmUgd2hlcmV2ZXIgaXQgZXhpc3RzLiBgZW5zdXJlRGVmYXVsdEJyYW5jaEN1cnJlbnRgIGNhbm5vdCBtb3ZlIGEgbG9jYWxcbiAgLy8gYmFzZSBicmFuY2ggdGhhdCBhbm90aGVyIGxhbmUncyB3b3JrdHJlZSBoYXMgY2hlY2tlZCBvdXQg4oCUIGdpdCByZWZ1c2VzLFxuICAvLyBjb3JyZWN0bHkg4oCUIHNvIHRydXN0aW5nIHRoZSBsb2NhbCByZWYgd291bGQgbWVyZ2UgYSBiYXNlIHRoYXQgaXNcbiAgLy8gYWxyZWFkeSBiZWhpbmQgYW5kIGxlYXZlIHRoZSBQUiByZXBvcnRlZCBhcyBiZWhpbmQgZm9yIGV2ZXIuXG4gIGNvbnN0IGJhc2VSZWYgPSBhd2FpdCByZXNvbHZlUHVibGlzaGVkQmFzZVJlZihiYXNlQnJhbmNoLCBvcHRpb25zKTtcblxuICAvLyBJc3N1ZSAjMjExIC8gIzM5NDogcG9zaXRpb24gdGhlIGJyYW5jaCBhdCBpdHMgcmVtb3RlIGhlYWQgaW4gb25lXG4gIC8vIG11dGF0aW5nIGNvbW1hbmQuIFRoZSBvbGQgc2hhcGUgcmVhZCBgSEVBRGAsIHJhbiBhIGJhcmVcbiAgLy8gYGdpdCBjaGVja291dCA8YnJhbmNoPmAsIGFuZCB0aGVuIGZhc3QtZm9yd2FyZGVkIOKAlCB0aHJlZSBjb21tYW5kcyB3aXRoXG4gIC8vIHR3byB3aW5kb3dzIGluIHdoaWNoIGEgbGFuZSBzaGFyaW5nIHRoaXMgY2xvbmUgY291bGQgZGVsZXRlIG9yIG1vdmUgdGhlXG4gIC8vIGJyYW5jaCwgd2hpY2ggaXMgZXhhY3RseSBob3cgYW4gb3BlbiBQUiB3aG9zZSBicmFuY2ggc2l0cyBoZWFsdGhpbHkgb25cbiAgLy8gb3JpZ2luIHdhcyByZXBvcnRlZCBhcyBgcGF0aHNwZWMg4oCmIGRpZCBub3QgbWF0Y2ggYW55IGZpbGUocykga25vd24gdG9cbiAgLy8gZ2l0YCAoUFIgIzM5MikuIGBjaGVja291dFByQnJhbmNoQXRSZW1vdGVIZWFkYCBmZXRjaGVzIHRoZSB0cmFja2luZyByZWZcbiAgLy8gZXhwbGljaXRseSBhbmQgdXNlcyBgY2hlY2tvdXQgLUJgLCBzbyBhIG1pc3NpbmcsIHN0YWxlIG9yIGNvcnJ1cHQgbG9jYWxcbiAgLy8gcmVmIGlzIG92ZXJ3cml0dGVuIHJhdGhlciB0aGFuIHJlYWQg4oCUIGFuZCBpdCBzdGlsbCByZWZ1c2VzIGxvdWRseSwgd2l0aFxuICAvLyB0aGUgdHlwZWQgYWhlYWQtb2YtcmVtb3RlIGVycm9yLCB3aGVuIHRoZSBsb2NhbCBicmFuY2ggY2FycmllcyBjb21taXRzXG4gIC8vIG9yaWdpbiBoYXMgbmV2ZXIgc2VlbjogdGhvc2UgYXJlIHNvbWVib2R5J3MgdW5wdXNoZWQgd29yayBhbmQgdGhpcyBwYXNzXG4gIC8vIHB1c2hlcyB3aGF0ZXZlciBpdCBwcm9kdWNlcy5cbiAgY29uc3QgYWxpZ25SZXN1bHQgPSBhd2FpdCBjaGVja291dFByQnJhbmNoQXRSZW1vdGVIZWFkKGJyYW5jaE5hbWUsIG9wdGlvbnMpO1xuICBpZiAoIWFsaWduUmVzdWx0Lm9rKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYWxpZ25SZXN1bHQuZXJyb3IgfTtcbiAgfVxuICBjb25zdCBhbGlnbk5vdGUgPSBhbGlnblJlc3VsdC52YWx1ZSA9PT0gXCJyZXNldC10by1yZW1vdGVcIlxuICAgID8gYHBvc2l0aW9uZWQgJyR7YnJhbmNoTmFtZX0nIG9uIGl0cyByZW1vdGUgaGVhZC4gYFxuICAgIDogXCJcIjtcblxuICAvLyBFbnN1cmUgZW5vdWdoIGhpc3RvcnkgZm9yIHJhbmdlIGRldGVjdGlvbiBvbiBhIHNoYWxsb3cgY2xvbmUgKElzc3VlICMxNTAyKVxuICBhd2FpdCBlbnN1cmVIaXN0b3J5RGVwdGgoW1wiSEVBRFwiLCBiYXNlUmVmXSwgb3B0aW9ucyk7XG5cbiAgLy8gQ2hlY2sgaWYgYW4gdXBkYXRlIGlzIG5lZWRlZFxuICBjb25zdCBiZWhpbmRSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJldi1saXN0XCIsIFwiLS1jb3VudFwiLCBgSEVBRC4uJHtiYXNlUmVmfWBdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGNvbnN0IGJlaGluZENvdW50ID0gYmVoaW5kUmVzdWx0Lm9rICYmIGJlaGluZFJlc3VsdC52YWx1ZS5jb2RlID09PSAwXG4gICAgPyBwYXJzZUludChiZWhpbmRSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSwgMTApIHx8IDBcbiAgICA6IDA7XG5cbiAgLy8gUmV0dXJuIGVhcmx5IHdoZW4gbm90IGJlaGluZCBhbmQgbm8gY29uZmxpY3QgcmVhc29uIHByb3ZpZGVkLlxuICBpZiAocmVhc29uICE9PSBcImNvbmZsaWN0aW5nXCIgJiYgYmVoaW5kQ291bnQgPT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZTogYCR7YWxpZ25Ob3RlfVBSIGJyYW5jaCAnJHticmFuY2hOYW1lfScgaXMgYWxyZWFkeSB1cCB0byBkYXRlIGAgK1xuICAgICAgICBgd2l0aCAnJHtiYXNlQnJhbmNofSdgLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBtZXJnZWQgPSBhd2FpdCBtZXJnZUJhc2VJbnRvQnJhbmNoKFxuICAgIGJyYW5jaE5hbWUsXG4gICAgYmFzZUJyYW5jaCxcbiAgICBiYXNlUmVmLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghbWVyZ2VkLm9rKSByZXR1cm4gbWVyZ2VkO1xuICBjb25zdCBwdXNoZWQgPSBhd2FpdCBwdXNoRmVhdHVyZUJyYW5jaChicmFuY2hOYW1lLCBvcHRpb25zKTtcbiAgcmV0dXJuIHB1c2hlZC5va1xuICAgID8geyBvazogdHJ1ZSwgdmFsdWU6IGAke2FsaWduTm90ZX0ke3B1c2hlZC52YWx1ZX1gIH1cbiAgICA6IHB1c2hlZDtcbn1cblxuLyoqXG4gKiBQdXNoIGFuIHVwZGF0ZWQgZmVhdHVyZSBicmFuY2ggd2l0aCBhIHBsYWluLCBmYXN0LWZvcndhcmQgcHVzaFxuICogKElzc3VlICMyODA3KS5cbiAqXG4gKiBOZXZlciBmb3JjZWQ6IGEgbWVyZ2Ugb25seSBhZGRzIGNvbW1pdHMsIHNvIHRoZSBwdXNoIGZhc3QtZm9yd2FyZHMuIEFcbiAqIHJlamVjdGlvbiDigJQgc29tZWJvZHkgcHVzaGVkIG1lYW53aGlsZSwgb3IgYSBicmFuY2ggcnVsZSByZWZ1c2VkIGl0IOKAlCBpcyBhXG4gKiBmYWlsdXJlIGNhcnJ5aW5nIGdpdCdzIHN0ZGVyciwgYW5kIGlzIG5ldmVyIHJldHJpZWQgd2l0aCBmb3JjZS5cbiAqXG4gKiBAcGFyYW0gYnJhbmNoTmFtZSAtIFRoZSBicmFuY2ggdG8gcHVzaFxuICogQHBhcmFtIG9wdGlvbnMgLSBHaXQgY29tbWFuZCBvcHRpb25zXG4gKiBAcmV0dXJucyBSZXN1bHQgaW5kaWNhdGluZyBzdWNjZXNzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHB1c2hGZWF0dXJlQnJhbmNoKFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmc+PiB7XG4gIGNvbnN0IHsgaXNQcm90ZWN0ZWRCcmFuY2ggfSA9IGF3YWl0IGltcG9ydChcIi4vZ2l0X2JyYW5jaC50c1wiKTtcblxuICBpZiAoaXNQcm90ZWN0ZWRCcmFuY2goYnJhbmNoTmFtZSkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENhbm5vdCBwdXNoIGEgUFIgdXBkYXRlIHRvIHByb3RlY3RlZCBicmFuY2ggJyR7YnJhbmNoTmFtZX0nYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIC8vIElzc3VlICMyNzU6IHRocm91Z2ggdGhlIHNhbmN0aW9uZWQgYnVpbGRlciwgc28gdGhlIGJyYW5jaCBuYW1lIGlzXG4gIC8vIHZhbGlkYXRlZCBhbmQgc2l0cyBiZWhpbmQgYC0tZW5kLW9mLW9wdGlvbnNgLlxuICBjb25zdCBwdXNoUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBidWlsZFB1c2hBcmdzKFwib3JpZ2luXCIsIGJyYW5jaE5hbWUpLFxuICAgIG9wdGlvbnMsXG4gICk7XG5cbiAgaWYgKCFwdXNoUmVzdWx0Lm9rIHx8IHB1c2hSZXN1bHQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIGNvbnN0IGVycm9yTXNnID0gcHVzaFJlc3VsdC5va1xuICAgICAgPyBwdXNoUmVzdWx0LnZhbHVlLnN0ZGVyclxuICAgICAgOiBwdXNoUmVzdWx0LmVycm9yLm1lc3NhZ2U7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBGYWlsZWQgdG8gcHVzaCB1cGRhdGVkIGJyYW5jaCAnJHticmFuY2hOYW1lfScgKHBsYWluIHB1c2gsIG5vdCByZXRyaWVkIHdpdGggZm9yY2UpOiAke2Vycm9yTXNnfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIHZhbHVlOiBgU3VjY2Vzc2Z1bGx5IHB1c2hlZCB1cGRhdGVkIFBSIGJyYW5jaCAnJHticmFuY2hOYW1lfSdgLFxuICB9O1xufVxuXG4vKipcbiAqIEVuc3VyZSBhIFBSIGlzIG1lcmdlYWJsZSBieSBtZXJnaW5nIGl0cyBiYXNlIGluIHdoZW4gYmVoaW5kXG4gKiAoSXNzdWVzICM0ODIsICMyODA3KS5cbiAqXG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0gcHJOdW1iZXIgLSBUaGUgUFIgbnVtYmVyXG4gKiBAcGFyYW0gYnJhbmNoTmFtZSAtIFRoZSBmZWF0dXJlIGJyYW5jaCB0byBjaGVja1xuICogQHBhcmFtIGJhc2VCcmFuY2ggLSBUaGUgYmFzZSBicmFuY2ggdGhlIFBSIHRhcmdldHNcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9uc1xuICogQHJldHVybnMgUmVzdWx0IGluZGljYXRpbmcgc3VjY2Vzc1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlUHJNZXJnZWFibGUoXG4gIF9yZXBvOiBzdHJpbmcsXG4gIF9wck51bWJlcjogbnVtYmVyLFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIGJhc2VCcmFuY2g6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZz4+IHtcbiAgLy8gRmV0Y2ggdGhlIGxhdGVzdCBiYXNlIGJyYW5jaFxuICBjb25zdCBmZXRjaFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmRDaGVja2VkKFxuICAgIFtcImZldGNoXCIsIFwib3JpZ2luXCIsIGJhc2VCcmFuY2hdLFxuICAgIG9wdGlvbnMsXG4gICk7XG5cbiAgaWYgKCFmZXRjaFJlc3VsdC5vaykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiBcIkNvdWxkIG5vdCBmZXRjaCBiYXNlIGJyYW5jaCDigJQgc2tpcHBpbmcgbWVyZ2VhYmlsaXR5IGNoZWNrXCIsXG4gICAgfTtcbiAgfVxuXG4gIC8vIFVwZGF0ZSBsb2NhbCBiYXNlIGJyYW5jaCByZWZcbiAgY29uc3QgY3VycmVudEJyYW5jaFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wicmV2LXBhcnNlXCIsIFwiLS1hYmJyZXYtcmVmXCIsIFwiSEVBRFwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBjb25zdCBjdXJyZW50QnJhbmNoID0gY3VycmVudEJyYW5jaFJlc3VsdC5va1xuICAgID8gY3VycmVudEJyYW5jaFJlc3VsdC52YWx1ZS5zdGRvdXQudHJpbSgpXG4gICAgOiBcIlwiO1xuXG4gIGlmIChjdXJyZW50QnJhbmNoID09PSBiYXNlQnJhbmNoKSB7XG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJyZXNldFwiLCBcIi0taGFyZFwiLCBgb3JpZ2luLyR7YmFzZUJyYW5jaH1gXSwgb3B0aW9ucyk7XG4gIH0gZWxzZSB7XG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgIFtcImJyYW5jaFwiLCBcIi1mXCIsIGJhc2VCcmFuY2gsIGBvcmlnaW4vJHtiYXNlQnJhbmNofWBdLFxuICAgICAgb3B0aW9ucyxcbiAgICApO1xuICB9XG5cbiAgLy8gRW5zdXJlIHdlIGFyZSBvbiB0aGUgZmVhdHVyZSBicmFuY2hcbiAgaWYgKGN1cnJlbnRCcmFuY2ggIT09IGJyYW5jaE5hbWUpIHtcbiAgICBjb25zdCBjaGVja291dFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBidWlsZENoZWNrb3V0QXJncyhicmFuY2hOYW1lKSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgICBpZiAoIWNoZWNrb3V0UmVzdWx0Lm9rIHx8IGNoZWNrb3V0UmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGNoZWNrb3V0RmFpbHVyZUVycm9yKGJyYW5jaE5hbWUsIGNoZWNrb3V0UmVzdWx0KSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgLy8gRW5zdXJlIGVub3VnaCBoaXN0b3J5IGZvciB0aGUgcmFuZ2UvbWVyZ2Ugb24gYSBzaGFsbG93IGNsb25lIChJc3N1ZSAjMTUwMilcbiAgYXdhaXQgZW5zdXJlSGlzdG9yeURlcHRoKFtcIkhFQURcIiwgYmFzZUJyYW5jaF0sIG9wdGlvbnMpO1xuXG4gIC8vIENoZWNrIGlmIGJlaGluZFxuICBjb25zdCBiZWhpbmRSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJldi1saXN0XCIsIFwiLS1jb3VudFwiLCBgSEVBRC4uJHtiYXNlQnJhbmNofWBdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGNvbnN0IGJlaGluZENvdW50ID0gYmVoaW5kUmVzdWx0Lm9rICYmIGJlaGluZFJlc3VsdC52YWx1ZS5jb2RlID09PSAwXG4gICAgPyBwYXJzZUludChiZWhpbmRSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSwgMTApIHx8IDBcbiAgICA6IDA7XG5cbiAgaWYgKGJlaGluZENvdW50ID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6XG4gICAgICAgIGBQUiBicmFuY2ggJyR7YnJhbmNoTmFtZX0nIGlzIHVwIHRvIGRhdGUgd2l0aCAnJHtiYXNlQnJhbmNofScg4oCUIG5vIGNvbmZsaWN0c2AsXG4gICAgfTtcbiAgfVxuXG4gIC8vIE1lcmdlIHRoZSBiYXNlIGluIChJc3N1ZSAjMjgwNyk6IGEgY29uZmxpY3QgaXMgYWJvcnRlZCBhbmQgcmVwb3J0ZWQsXG4gIC8vIG5ldmVyIHNpZGUtcGlja2VkIGFuZCBuZXZlciByZWNyZWF0ZWQgKElzc3VlICMzODYpLlxuICBjb25zdCBtZXJnZWQgPSBhd2FpdCBtZXJnZUJhc2VJbnRvQnJhbmNoKFxuICAgIGJyYW5jaE5hbWUsXG4gICAgYmFzZUJyYW5jaCxcbiAgICBiYXNlQnJhbmNoLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghbWVyZ2VkLm9rKSByZXR1cm4gbWVyZ2VkO1xuICByZXR1cm4gYXdhaXQgcHVzaEZlYXR1cmVCcmFuY2goYnJhbmNoTmFtZSwgb3B0aW9ucyk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7OztDQVNDLEdBR0QsU0FBUyxhQUFhLEVBQUUsb0JBQW9CLFFBQVEsbUJBQW1CO0FBQ3ZFLFNBQVMsZ0JBQWdCLFFBQVEsMEJBQTBCO0FBQzNELFNBQVMsT0FBTyxRQUFRLGdCQUFnQjtBQUN4QyxTQUNFLG1CQUFtQixFQUNuQixvQkFBb0IsRUFDcEIsaUJBQWlCLFFBQ1oseUJBQXlCO0FBQ2hDLFNBQVMsMkJBQTJCLFFBQVEsK0JBQStCO0FBRTNFLFNBQVMsMEJBQTBCLFFBQVEsZ0JBQWdCO0FBQzNELFNBQ0UsZ0JBQWdCLEVBQ2hCLHNCQUFzQixFQUN0QixpQkFBaUIsRUFDakIsY0FBYyxFQUNkLGFBQWEsUUFDUixvQkFBb0I7QUFDM0IsU0FBUyw0QkFBNEIsUUFBUSwwQkFBMEI7QUFDdkUsU0FDRSx3QkFBd0IsRUFDeEIsa0JBQWtCLEVBRWxCLG9CQUFvQixRQUNmLDZCQUE2QjtBQUNwQyxTQUFTLCtCQUErQixRQUFRLGtCQUFrQjtBQUNsRSxTQUFTLG9CQUFvQixRQUFRLHVCQUF1QjtBQUM1RCxTQUFTLHFCQUFxQixRQUFRLHdCQUF3QjtBQUM5RCxTQUFTLGtCQUFrQixRQUFRLG1CQUFtQjtBQUN0RCxTQUFTLHVCQUF1QixRQUFRLGlDQUFpQztBQUN6RSxTQUNFLHdCQUF3QixF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
// denoCacheMetadata=16865635669901703257,67287663278903068