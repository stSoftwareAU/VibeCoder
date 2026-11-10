/**
 * Git branch creation, checkout, and deletion (Issue #912).
 *
 * Provides functions for creating sanitised branch names, checking if branches
 * are protected, and managing feature/milestone branches.
 *
 * Migrated from worker/shared/git_operations.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { brokenRefsIn, removeBrokenRef } from "./broken_ref_repair.ts";
import { runGitCommand } from "./git_timeout.ts";
import { detachLaneWorktreeHead, laneWorktreeHoldingBranch, primaryCloneHoldingBranch } from "./lane_worktree.ts";
import { buildCheckoutResetBranchArgs, buildFetchArgs, buildPushCreateBranchArgs } from "./git_ref_args.ts";
import { describeLocalMilestoneBranch, inspectLocalMilestoneBranch } from "./milestone_local_branch.ts";
/** Protected branch names (case-insensitive). */ const PROTECTED_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "release",
  "production",
  "staging"
]);
/**
 * Create a sanitised branch name from an issue number and title.
 *
 * @param issueNumber - The issue number
 * @param issueTitle - The issue title
 * @returns Sanitised branch name (e.g., "issue-42-fix-login-bug")
 */ export function createBranchName(issueNumber, issueTitle) {
  const sanitised = issueTitle.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-{2,}/g, "-").replace(/^-/, "").replace(/-$/, "").slice(0, 50).replace(/-$/, "");
  return `issue-${issueNumber}-${sanitised}`;
}
/**
 * Create a sanitised branch name from a milestone title.
 *
 * @param milestoneTitle - The milestone title (e.g., "OIDC Authentication")
 * @returns Sanitised branch name (e.g., "milestone/oidc-authentication")
 */ export function createMilestoneBranchName(milestoneTitle) {
  const sanitised = milestoneTitle.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-{2,}/g, "-").replace(/^-/, "").replace(/-$/, "").slice(0, 50).replace(/-$/, "");
  return `milestone/${sanitised}`;
}
/**
 * Check if a branch name is a protected branch (Issue #375).
 *
 * Protected branches (main, master, develop, etc.) should never be force-pushed.
 * Milestone branches are also protected (Issue #422).
 *
 * @param branchName - The branch name to check
 * @returns True if the branch is protected
 */ export function isProtectedBranch(branchName) {
  const lowerName = branchName.toLowerCase();
  if (PROTECTED_BRANCHES.has(lowerName)) {
    return true;
  }
  // Milestone branches are long-lived and should not be force-pushed (Issue #422)
  if (lowerName.startsWith("milestone/")) {
    return true;
  }
  return false;
}
/**
 * The lane worktree holding `branchName`, when git refused for that reason
 * (Issue #1564).
 *
 * The recognition itself lives in `lane_worktree.ts`
 * ({@link laneWorktreeHoldingBranch}) so the PR passes share it (Issue
 * #1677); this wrapper only unpacks the checkout result.
 */ function heldByLaneWorktree(checkout) {
  if (!checkout.ok || checkout.value.code === 0) return undefined;
  return laneWorktreeHoldingBranch(checkout.value.stderr);
}
/**
 * One fetch-then-checkout attempt for {@link createFeatureBranchFromBase},
 * including the Issue #1564 held-branch repair (lane worktrees) and the
 * Issue #4789 extension to the shared clone's primary worktree.
 *
 * Failure text and detail is appended to `failures` (for the eventual error
 * message) and `stderrTexts` (scanned for broken refs by the caller) rather
 * than returned, so the caller can retry this whole attempt after a repair
 * without losing the diagnostics from earlier attempts.
 *
 * @returns The success message, or `undefined` if every start point failed.
 */ async function attemptCreateFeatureBranch(branchName, baseBranch, options, failures, stderrTexts) {
  // Fetch the latest upstream base branch before creating the feature branch
  // (Issue #1501). Non-fatal — if this fails we fall back to local refs.
  const fetchResult = await runGitCommand(buildFetchArgs("origin", baseBranch), options);
  const fetchOk = fetchResult.ok && fetchResult.value.code === 0;
  if (!fetchOk) {
    const detail = fetchResult.ok ? fetchResult.value.stderr.trim() || `exit ${fetchResult.value.code}` : fetchResult.error.message;
    const fetchStderr = fetchResult.ok ? fetchResult.value.stderr : "";
    if (fetchResult.ok) stderrTexts.push(fetchStderr);
    // A broken loose ref (Issue #2880) can fail the fetch outright while a
    // *stale* origin/<baseBranch> from an earlier successful fetch is still
    // on disk. Falling back to local refs here would let the checkout below
    // silently succeed from that stale tip instead of surfacing the failure
    // for repair — give the caller's repair-and-retry loop first refusal
    // whenever the fetch failure names a repairable ref.
    if (brokenRefsIn(fetchStderr).length > 0) {
      failures.push(`fetch origin ${baseBranch} failed: ${detail}`);
      return undefined;
    }
    console.warn(`[git_branch] Warning: failed to fetch origin/${baseBranch} (${detail}); ` + `falling back to local ref`);
  }
  // Start points in order of preference: the freshly fetched remote tip, the
  // local base ref (Issue #476), then the remote-tracking ref for a clone
  // that could not be fetched. Each is attempted with `checkout -B` so an
  // existing local branch — including the one HEAD is on — is reset rather
  // than collided with (Issue #356).
  const startPoints = fetchOk ? [
    `origin/${baseBranch}`,
    baseBranch
  ] : [
    baseBranch,
    `origin/${baseBranch}`
  ];
  let heldBy;
  const refusals = [];
  for (const startPoint of startPoints){
    const args = buildCheckoutResetBranchArgs(branchName, startPoint);
    const checkout = await runGitCommand(args, options);
    if (checkout.ok && checkout.value.code === 0) {
      return `Created feature branch '${branchName}' from '${startPoint}'`;
    }
    failures.push(describeGitFailure(args, checkout));
    if (checkout.ok) {
      stderrTexts.push(checkout.value.stderr);
      refusals.push(checkout.value.stderr);
    }
    heldBy ??= heldByLaneWorktree(checkout);
  }
  // Issue #4789: a branch left checked out in the shared clone's own primary
  // worktree is refused the same way, and is not a lane worktree. Only when
  // no lane worktree holds it, the primary is the holder, and it is released
  // by the same detach-and-retry below.
  if (heldBy === undefined) {
    for (const stderr of refusals){
      heldBy = await primaryCloneHoldingBranch(stderr, options.cwd);
      if (heldBy !== undefined) break;
    }
  }
  // Issue #1564: branches are shared between the worktrees of one clone, so
  // git refuses to move a branch another worktree has checked out. Slot s2
  // checks an issue's feature branch out in its lane worktree and then loses
  // the acquire race; s1 wins the claim and cannot have the branch. Both
  // start points fail the same way, the issue dies in phase `setup` within
  // seconds, and — because nothing releases s2's hold — every later attempt
  // fails identically. VibeCoder#1548 had two before this was found.
  //
  // Detaching the holder is exactly what `detachLaneWorktreeHead` exists for;
  // it was only ever called on the happy path, after a lane finished with a
  // PR. Calling it here closes the loop for the lane that *didn't* finish.
  //
  // Issue #4789: the holder can also be the shared clone's primary worktree
  // (`<work root>/<repo>`), not a lane — a run's own setup left the issue
  // branch checked out there, and `laneWorktreeHoldingBranch` does not
  // recognise it. `primaryCloneHoldingBranch` admits only that primary, so a
  // developer's own worktree still falls through and is reported unchanged.
  if (heldBy !== undefined) {
    if (await detachLaneWorktreeHead(heldBy)) {
      for (const startPoint of startPoints){
        const args = buildCheckoutResetBranchArgs(branchName, startPoint);
        const retry = await runGitCommand(args, options);
        if (retry.ok && retry.value.code === 0) {
          return `Created feature branch '${branchName}' from ` + `'${startPoint}' after releasing it from the worktree at ` + `${heldBy}`;
        }
        failures.push(describeGitFailure(args, retry));
        if (retry.ok) stderrTexts.push(retry.value.stderr);
      }
    }
  }
  return undefined;
}
/** Most broken refs repaired within one {@link createFeatureBranchFromBase} call. */ const MAX_REPAIRED_REFS_PER_CALL = 10;
/**
 * Create a feature branch from a specified base branch (Issue #476, #1501,
 * #2880).
 *
 * Explicitly creates a feature branch from the given base branch. This ensures
 * milestone issues create feature branches off the milestone branch rather than
 * whatever HEAD happens to point to.
 *
 * To avoid branching from a stale local ref (Issue #1501), this first runs
 * `git fetch origin <baseBranch>` and then prefers `origin/<baseBranch>` as the
 * checkout source. If the fetch fails (e.g., offline), a warning is logged and
 * the function falls back to the existing local-then-remote checkout logic.
 *
 * The branch is created with `checkout -B` — create-or-reset — rather than
 * `branch -D` followed by `checkout -b` (Issue #356). Git refuses to delete
 * the branch HEAD is on, and the resume-on-reclaim lookup leaves HEAD exactly
 * there: it checks a candidate branch out, finds it no commits ahead of base,
 * passes it over, and returns "start fresh" without moving HEAD back. The
 * delete then failed, all three `checkout -b` attempts collided with the
 * branch that was still present, and the claim died in phase `setup`. Being a
 * deterministic function of the repository's state, it died the same way on
 * every re-claim: Issue #356 was claimed and released ten times in nine hours
 * while the idle-decision census kept reporting it as claimable work nobody
 * was doing. `-B` is no more destructive than the delete it replaces — both
 * discard whatever the local branch pointed at — and it cannot wedge.
 *
 * A shared clone can also carry a **broken loose ref** — a ref file naming an
 * object the object store no longer has — which fails the fetch (`fatal: bad
 * object refs/<x>`) or the checkout of `origin/<baseBranch>` (`warning:
 * ignoring broken ref …`) outright (Issue #2880). Every such ref is
 * recoverable from the remote, so on failure this scans git's own stderr for
 * ref names it names as broken, removes each with `removeBrokenRef`, and
 * retries the whole attempt — bounded at
 * {@link MAX_REPAIRED_REFS_PER_CALL} repaired refs, and stopping as soon as a
 * retry names no new ref.
 *
 * A branch held by another worktree of the clone is released on the same
 * retry path (Issue #1564), when that holder is one of this host's lane
 * worktrees or the shared clone's own primary worktree (Issue #4789). A
 * developer's own worktree is never detached: the refusal is returned as is.
 *
 * @param branchName - The feature branch name to create
 * @param baseBranch - The branch to create from (e.g., "main" or "milestone/oidc")
 * @param options - Git command options (cwd, etc.)
 * @returns Result indicating success, or failure naming git's own output
 */ export async function createFeatureBranchFromBase(branchName, baseBranch, options = {}) {
  const failures = [];
  const repairedRefs = new Set();
  for(;;){
    const stderrTexts = [];
    const success = await attemptCreateFeatureBranch(branchName, baseBranch, options, failures, stderrTexts);
    if (success !== undefined) {
      return {
        ok: true,
        value: success
      };
    }
    if (repairedRefs.size >= MAX_REPAIRED_REFS_PER_CALL) break;
    const candidates = brokenRefsIn(stderrTexts.join("\n")).filter((ref)=>!repairedRefs.has(ref));
    if (candidates.length === 0) break;
    let repairedAny = false;
    for (const ref of candidates){
      if (repairedRefs.size >= MAX_REPAIRED_REFS_PER_CALL) break;
      repairedRefs.add(ref);
      const removal = await removeBrokenRef(ref, options);
      if (!removal.ok) {
        failures.push(`removing broken ref '${ref}': ${removal.error.message}`);
        continue;
      }
      console.warn(`[git_branch] Warning: removed broken ref ${ref} (points at a ` + `missing object); retrying branch creation (Issue #2880)`);
      repairedAny = true;
    }
    if (!repairedAny) break;
  }
  // Fail loud with git's own words: the release comment for Issue #356 read
  // "could not be automatically determined" because they were discarded here.
  return {
    ok: false,
    error: new Error(`Failed to create feature branch '${branchName}' from '${baseBranch}': ` + failures.join("; "))
  };
}
/**
 * Resume a feature branch from its remote checkpoint (Issue #4170).
 *
 * A killed session's WIP checkpoints live on the remote issue branch; the
 * re-claim path calls this *instead of* `createFeatureBranchFromBase` so
 * the prior progress is picked up rather than recreated from base. Any
 * local branch of the same name is replaced — after `setupRepo`'s reset
 * the local ref is stale, and the pushed checkpoint is the durable truth.
 *
 * Returns `true` when the branch was checked out from `origin/<branch>`,
 * `false` when no such remote branch exists (or the checkout failed) —
 * the caller then falls back to creating the branch fresh from base.
 *
 * The branch can be held by another worktree of the clone when git refuses
 * the checkout: a sibling lane worktree (Issue #1564 pattern, Issue #4794) or
 * the shared clone's primary (Issue #4789). That holder is detached and the
 * checkout retried once. A holder outside those (e.g. a developer's own
 * worktree) is left alone, so the function returns `ok: true, value: false`.
 */ export async function resumeFeatureBranchFromRemote(branchName, options = {}) {
  const fetchResult = await runGitCommand(buildFetchArgs("origin", branchName), options);
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    return {
      ok: true,
      value: false
    };
  }
  // Replace any stale local branch. `checkout -B` create-or-resets, so a
  // leftover local ref — including one HEAD is already sitting on — is moved
  // onto the remote checkpoint rather than colliding with it (Issue #356);
  // `branch -D` cannot delete the checked-out branch, and the collision that
  // followed silently reported "no resumable work" over a pushed commit.
  //
  // Issue #4794: the holder can be a sibling lane worktree, which is refused
  // the same way the primary is (Issue #1564). A lane holder is preferred;
  // only when none holds it is the primary (Issue #4789) the holder.
  const args = buildCheckoutResetBranchArgs(branchName, `origin/${branchName}`);
  let checkoutResult = await runGitCommand(args, options);
  if (checkoutResult.ok && checkoutResult.value.code !== 0) {
    const holder = heldByLaneWorktree(checkoutResult) ?? await primaryCloneHoldingBranch(checkoutResult.value.stderr, options.cwd);
    if (holder !== undefined && await detachLaneWorktreeHead(holder)) {
      checkoutResult = await runGitCommand(args, options);
    }
  }
  return {
    ok: true,
    value: checkoutResult.ok && checkoutResult.value.code === 0
  };
}
/**
 * HEAD and the worker branch have diverged (Issue #4286): the agent committed
 * on a branch of its own and neither history contains the other.
 *
 * A typed error, so completion can tell this refusal from a HEAD it could
 * not resolve: on a closed issue the divergence usually means the work
 * already landed through the agent's own PR elsewhere (Issue #1793), which
 * is not a failure.
 */ export class HeadDivergedError extends Error {
  /** Where HEAD was: the branch the agent committed on. */ head;
  /** The worker branch that was expected. */ branchName;
  constructor(head, branchName){
    super(`HEAD is on '${head}' and the worker branch '${branchName}' has ` + `diverged from it — the agent committed on a branch of its own and ` + `the two histories do not fast-forward. Refusing to move either ` + `ref; a human must reconcile them (Issue #4286).`);
    this.name = "HeadDivergedError";
    this.head = head;
    this.branchName = branchName;
  }
}
/**
 * Bring HEAD back onto the worker's branch before pushing (Issue #4286).
 *
 * The coding agent may switch to a branch of its own and commit there
 * (private-repo-22#565: `issue-565-readme-banner`, two commits ahead, while
 * the worker's `issue-565-…` branch sat at base). Every downstream step then
 * agreed with the others while all being wrong — change detection counted
 * `base..HEAD`, the push pushed the *branch ref* ("Everything up-to-date"),
 * the ahead guard counted `base..HEAD` — until `gh pr create --head` met an
 * empty branch: "No commits between …". Three attempts, each releasing the
 * claim.
 *
 * Reconciliation is deliberately narrow: only when the worker branch is an
 * ancestor of HEAD is it fast-forwarded (`checkout -B`), because then the
 * agent's work strictly extends it and nothing is lost. If the two have
 * DIVERGED the call fails naming both refs — that needs a human, and a
 * silent reset would discard someone's commits.
 */ export async function reconcileHeadToBranch(branchName, options = {}) {
  const headResult = await runGitCommand([
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ], options);
  if (!headResult.ok || headResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Cannot resolve HEAD before pushing '${branchName}': ` + describeGitFailure([
        "rev-parse",
        "--abbrev-ref",
        "HEAD"
      ], headResult))
    };
  }
  const head = headResult.value.stdout.trim();
  if (head === branchName) {
    return {
      ok: true,
      value: {
        action: "already-on-branch",
        fromRef: head
      }
    };
  }
  // Is the worker branch an ancestor of HEAD? Exit 0 = yes, 1 = no.
  const ancestor = await runGitCommand([
    "merge-base",
    "--is-ancestor",
    branchName,
    "HEAD"
  ], options);
  if (!ancestor.ok) {
    return {
      ok: false,
      error: ancestor.error
    };
  }
  if (ancestor.value.code !== 0) {
    return {
      ok: false,
      error: new HeadDivergedError(head, branchName)
    };
  }
  // Fast-forward the worker branch to HEAD and check it out, keeping the
  // working tree exactly as the agent left it.
  const move = await runGitCommand(buildCheckoutResetBranchArgs(branchName), options);
  if (!move.ok || move.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Could not move '${branchName}' to HEAD ('${head}'): ` + describeGitFailure(buildCheckoutResetBranchArgs(branchName), move))
    };
  }
  return {
    ok: true,
    value: {
      action: "fast-forwarded",
      fromRef: head
    }
  };
}
/**
 * Describe a git command outcome for a failure message (Issue #3910).
 *
 * Collapsing distinct git failures into one opaque message hides the
 * reason a milestone branch could not be created (branch protection,
 * non-fast-forward, auth). Keep the command and its stderr so the
 * handoff comment names the actual cause.
 */ function describeGitFailure(args, result) {
  const command = `git ${args.join(" ")}`;
  if (!result.ok) {
    return `${command}: ${result.error.message}`;
  }
  const { code, stdout, stderr } = result.value;
  const output = stderr.trim() || stdout.trim() || "(no output)";
  return `${command} exited ${code}: ${output}`;
}
/**
 * Ensure a milestone branch exists, creating it from the default branch if needed (Issue #422).
 *
 * A milestone-assigned issue must be based on its milestone branch, so
 * every failure here is returned with the underlying git stderr rather
 * than a generic message (Issue #3910) — callers surface it to a human
 * instead of quietly retargeting the work at the default branch.
 *
 * When the remote milestone ref is absent the branch is created ON ORIGIN by
 * pushing the default branch ref straight to the milestone ref name — no
 * local checkout takes part (Issue #1345), so a stale local branch of the
 * same name can neither block the creation nor reach the remote (Issue
 * #4002). Whatever local ref exists is left exactly as it is and named in one
 * log line; nothing is deleted or reset.
 *
 * @param milestoneBranch - The milestone branch name
 * @param defaultBranch - The default branch to create from
 * @param options - Git command options
 * @param ensureDefaultBranchCurrentFn - Function to ensure the default branch is current
 * @returns Result indicating success or failure
 */ export async function ensureMilestoneBranchExists(milestoneBranch, defaultBranch, options = {}, ensureDefaultBranchCurrentFn) {
  // Diagnostics accumulated along the way — a fetch failure is not fatal
  // on its own (the branch may not exist yet), but it explains a later
  // create/push failure (Issue #3910).
  const diagnostics = [];
  // Fetch to check remote state
  const fetchArgs = [
    "fetch",
    "origin",
    milestoneBranch
  ];
  const fetchResult = await runGitCommand(fetchArgs, options);
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    diagnostics.push(describeGitFailure(fetchArgs, fetchResult));
  }
  const showRefResult = await runGitCommand([
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${milestoneBranch}`
  ], options);
  if (showRefResult.ok && showRefResult.value.code === 0) {
    return {
      ok: true,
      value: `Milestone branch ${milestoneBranch} already exists on remote`
    };
  }
  // Ensure the default branch is current before creating
  if (ensureDefaultBranchCurrentFn) {
    await ensureDefaultBranchCurrentFn(defaultBranch, options);
  }
  // Refresh the default branch's remote-tracking ref so the branch is created
  // at the remote's own tip. Non-fatal on its own — the local ref is the
  // fallback below — but a milestone branch created from a possibly stale
  // local base is not something to leave unsaid, and it explains a later push
  // failure (Issue #3910). Same shape as createFeatureBranchFromBase above.
  const defaultFetchArgs = buildFetchArgs("origin", defaultBranch);
  const defaultFetch = await runGitCommand(defaultFetchArgs, options);
  const defaultFetchOk = defaultFetch.ok && defaultFetch.value.code === 0;
  if (!defaultFetchOk) {
    const failure = describeGitFailure(defaultFetchArgs, defaultFetch);
    diagnostics.push(failure);
    console.warn(`[git_branch] Warning: failed to fetch origin/${defaultBranch} before ` + `creating ${milestoneBranch} (${failure}); falling back to the local ref`);
  }
  // The remote milestone ref is absent, so the remote carries no history to
  // preserve: create the branch ON ORIGIN by pushing the default branch ref
  // straight to the milestone ref name (Issue #1345). No local checkout takes
  // part, so nothing local can block the creation — NEAT-AI-Ockham#133 failed
  // three times because a stale local checkout in another worktree held the
  // branch name and `git checkout -B` is refused outright in that state
  // ("fatal: 'milestone/x' is already used by worktree at …"), which escalated
  // the run to a human on every attempt.
  //
  // Pushing the default branch ref also keeps the Issue #4002 invariant: a
  // stale local branch of the same name — e.g. one carrying a merge commit the
  // repository's rules forbid — is never what reaches the remote.
  const sourceRefs = defaultFetchOk ? [
    `origin/${defaultBranch}`,
    defaultBranch
  ] : [
    defaultBranch,
    `origin/${defaultBranch}`
  ];
  for (const sourceRef of sourceRefs){
    const pushArgs = buildPushCreateBranchArgs("origin", sourceRef, milestoneBranch);
    const pushResult = await runGitCommand(pushArgs, options);
    if (!pushResult.ok || pushResult.value.code !== 0) {
      diagnostics.push(describeGitFailure(pushArgs, pushResult));
      continue;
    }
    // Nothing local was touched. Say so once, naming the checkout that used
    // to block the creation, so an operator can find it without the run
    // having deleted or reset anyone's work (Issue #1345).
    const note = describeLocalMilestoneBranch(milestoneBranch, await inspectLocalMilestoneBranch(milestoneBranch, options), sourceRef);
    if (note !== null) {
      console.warn(`[git_branch] ${note}`);
    }
    return {
      ok: true,
      value: `Milestone branch ${milestoneBranch} created on origin from ` + `${sourceRef} (no local checkout)`
    };
  }
  return {
    ok: false,
    error: new Error(`Failed to push milestone branch ${milestoneBranch} to origin from ` + `${defaultBranch}: ${diagnostics.join(" | ")}`)
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfYnJhbmNoLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogR2l0IGJyYW5jaCBjcmVhdGlvbiwgY2hlY2tvdXQsIGFuZCBkZWxldGlvbiAoSXNzdWUgIzkxMikuXG4gKlxuICogUHJvdmlkZXMgZnVuY3Rpb25zIGZvciBjcmVhdGluZyBzYW5pdGlzZWQgYnJhbmNoIG5hbWVzLCBjaGVja2luZyBpZiBicmFuY2hlc1xuICogYXJlIHByb3RlY3RlZCwgYW5kIG1hbmFnaW5nIGZlYXR1cmUvbWlsZXN0b25lIGJyYW5jaGVzLlxuICpcbiAqIE1pZ3JhdGVkIGZyb20gd29ya2VyL3NoYXJlZC9naXRfb3BlcmF0aW9ucy5zaC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgYnJva2VuUmVmc0luLCByZW1vdmVCcm9rZW5SZWYgfSBmcm9tIFwiLi9icm9rZW5fcmVmX3JlcGFpci50c1wiO1xuaW1wb3J0IHsgcnVuR2l0Q29tbWFuZCB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQge1xuICBkZXRhY2hMYW5lV29ya3RyZWVIZWFkLFxuICBsYW5lV29ya3RyZWVIb2xkaW5nQnJhbmNoLFxuICBwcmltYXJ5Q2xvbmVIb2xkaW5nQnJhbmNoLFxufSBmcm9tIFwiLi9sYW5lX3dvcmt0cmVlLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdpdENvbW1hbmRPcHRpb25zLCBHaXRDb21tYW5kT3V0cHV0IH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkQ2hlY2tvdXRSZXNldEJyYW5jaEFyZ3MsXG4gIGJ1aWxkRmV0Y2hBcmdzLFxuICBidWlsZFB1c2hDcmVhdGVCcmFuY2hBcmdzLFxufSBmcm9tIFwiLi9naXRfcmVmX2FyZ3MudHNcIjtcbmltcG9ydCB7XG4gIGRlc2NyaWJlTG9jYWxNaWxlc3RvbmVCcmFuY2gsXG4gIGluc3BlY3RMb2NhbE1pbGVzdG9uZUJyYW5jaCxcbn0gZnJvbSBcIi4vbWlsZXN0b25lX2xvY2FsX2JyYW5jaC50c1wiO1xuXG4vKiogUHJvdGVjdGVkIGJyYW5jaCBuYW1lcyAoY2FzZS1pbnNlbnNpdGl2ZSkuICovXG5jb25zdCBQUk9URUNURURfQlJBTkNIRVMgPSBuZXcgU2V0KFtcbiAgXCJtYWluXCIsXG4gIFwibWFzdGVyXCIsXG4gIFwiZGV2ZWxvcFwiLFxuICBcInJlbGVhc2VcIixcbiAgXCJwcm9kdWN0aW9uXCIsXG4gIFwic3RhZ2luZ1wiLFxuXSk7XG5cbi8qKlxuICogQ3JlYXRlIGEgc2FuaXRpc2VkIGJyYW5jaCBuYW1lIGZyb20gYW4gaXNzdWUgbnVtYmVyIGFuZCB0aXRsZS5cbiAqXG4gKiBAcGFyYW0gaXNzdWVOdW1iZXIgLSBUaGUgaXNzdWUgbnVtYmVyXG4gKiBAcGFyYW0gaXNzdWVUaXRsZSAtIFRoZSBpc3N1ZSB0aXRsZVxuICogQHJldHVybnMgU2FuaXRpc2VkIGJyYW5jaCBuYW1lIChlLmcuLCBcImlzc3VlLTQyLWZpeC1sb2dpbi1idWdcIilcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUJyYW5jaE5hbWUoXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIGlzc3VlVGl0bGU6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHNhbml0aXNlZCA9IGlzc3VlVGl0bGVcbiAgICAudG9Mb3dlckNhc2UoKVxuICAgIC5yZXBsYWNlKC9bXmEtejAtOV0vZywgXCItXCIpXG4gICAgLnJlcGxhY2UoLy17Mix9L2csIFwiLVwiKVxuICAgIC5yZXBsYWNlKC9eLS8sIFwiXCIpXG4gICAgLnJlcGxhY2UoLy0kLywgXCJcIilcbiAgICAuc2xpY2UoMCwgNTApXG4gICAgLnJlcGxhY2UoLy0kLywgXCJcIik7XG4gIHJldHVybiBgaXNzdWUtJHtpc3N1ZU51bWJlcn0tJHtzYW5pdGlzZWR9YDtcbn1cblxuLyoqXG4gKiBDcmVhdGUgYSBzYW5pdGlzZWQgYnJhbmNoIG5hbWUgZnJvbSBhIG1pbGVzdG9uZSB0aXRsZS5cbiAqXG4gKiBAcGFyYW0gbWlsZXN0b25lVGl0bGUgLSBUaGUgbWlsZXN0b25lIHRpdGxlIChlLmcuLCBcIk9JREMgQXV0aGVudGljYXRpb25cIilcbiAqIEByZXR1cm5zIFNhbml0aXNlZCBicmFuY2ggbmFtZSAoZS5nLiwgXCJtaWxlc3RvbmUvb2lkYy1hdXRoZW50aWNhdGlvblwiKVxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTWlsZXN0b25lQnJhbmNoTmFtZShtaWxlc3RvbmVUaXRsZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgc2FuaXRpc2VkID0gbWlsZXN0b25lVGl0bGVcbiAgICAudG9Mb3dlckNhc2UoKVxuICAgIC5yZXBsYWNlKC9bXmEtejAtOV0vZywgXCItXCIpXG4gICAgLnJlcGxhY2UoLy17Mix9L2csIFwiLVwiKVxuICAgIC5yZXBsYWNlKC9eLS8sIFwiXCIpXG4gICAgLnJlcGxhY2UoLy0kLywgXCJcIilcbiAgICAuc2xpY2UoMCwgNTApXG4gICAgLnJlcGxhY2UoLy0kLywgXCJcIik7XG4gIHJldHVybiBgbWlsZXN0b25lLyR7c2FuaXRpc2VkfWA7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSBicmFuY2ggbmFtZSBpcyBhIHByb3RlY3RlZCBicmFuY2ggKElzc3VlICMzNzUpLlxuICpcbiAqIFByb3RlY3RlZCBicmFuY2hlcyAobWFpbiwgbWFzdGVyLCBkZXZlbG9wLCBldGMuKSBzaG91bGQgbmV2ZXIgYmUgZm9yY2UtcHVzaGVkLlxuICogTWlsZXN0b25lIGJyYW5jaGVzIGFyZSBhbHNvIHByb3RlY3RlZCAoSXNzdWUgIzQyMikuXG4gKlxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgYnJhbmNoIG5hbWUgdG8gY2hlY2tcbiAqIEByZXR1cm5zIFRydWUgaWYgdGhlIGJyYW5jaCBpcyBwcm90ZWN0ZWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUHJvdGVjdGVkQnJhbmNoKGJyYW5jaE5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlck5hbWUgPSBicmFuY2hOYW1lLnRvTG93ZXJDYXNlKCk7XG5cbiAgaWYgKFBST1RFQ1RFRF9CUkFOQ0hFUy5oYXMobG93ZXJOYW1lKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gTWlsZXN0b25lIGJyYW5jaGVzIGFyZSBsb25nLWxpdmVkIGFuZCBzaG91bGQgbm90IGJlIGZvcmNlLXB1c2hlZCAoSXNzdWUgIzQyMilcbiAgaWYgKGxvd2VyTmFtZS5zdGFydHNXaXRoKFwibWlsZXN0b25lL1wiKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIFRoZSBsYW5lIHdvcmt0cmVlIGhvbGRpbmcgYGJyYW5jaE5hbWVgLCB3aGVuIGdpdCByZWZ1c2VkIGZvciB0aGF0IHJlYXNvblxuICogKElzc3VlICMxNTY0KS5cbiAqXG4gKiBUaGUgcmVjb2duaXRpb24gaXRzZWxmIGxpdmVzIGluIGBsYW5lX3dvcmt0cmVlLnRzYFxuICogKHtAbGluayBsYW5lV29ya3RyZWVIb2xkaW5nQnJhbmNofSkgc28gdGhlIFBSIHBhc3NlcyBzaGFyZSBpdCAoSXNzdWVcbiAqICMxNjc3KTsgdGhpcyB3cmFwcGVyIG9ubHkgdW5wYWNrcyB0aGUgY2hlY2tvdXQgcmVzdWx0LlxuICovXG5mdW5jdGlvbiBoZWxkQnlMYW5lV29ya3RyZWUoXG4gIGNoZWNrb3V0OiBSZXN1bHQ8R2l0Q29tbWFuZE91dHB1dD4sXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoIWNoZWNrb3V0Lm9rIHx8IGNoZWNrb3V0LnZhbHVlLmNvZGUgPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiBsYW5lV29ya3RyZWVIb2xkaW5nQnJhbmNoKGNoZWNrb3V0LnZhbHVlLnN0ZGVycik7XG59XG5cbi8qKlxuICogT25lIGZldGNoLXRoZW4tY2hlY2tvdXQgYXR0ZW1wdCBmb3Ige0BsaW5rIGNyZWF0ZUZlYXR1cmVCcmFuY2hGcm9tQmFzZX0sXG4gKiBpbmNsdWRpbmcgdGhlIElzc3VlICMxNTY0IGhlbGQtYnJhbmNoIHJlcGFpciAobGFuZSB3b3JrdHJlZXMpIGFuZCB0aGVcbiAqIElzc3VlICM0Nzg5IGV4dGVuc2lvbiB0byB0aGUgc2hhcmVkIGNsb25lJ3MgcHJpbWFyeSB3b3JrdHJlZS5cbiAqXG4gKiBGYWlsdXJlIHRleHQgYW5kIGRldGFpbCBpcyBhcHBlbmRlZCB0byBgZmFpbHVyZXNgIChmb3IgdGhlIGV2ZW50dWFsIGVycm9yXG4gKiBtZXNzYWdlKSBhbmQgYHN0ZGVyclRleHRzYCAoc2Nhbm5lZCBmb3IgYnJva2VuIHJlZnMgYnkgdGhlIGNhbGxlcikgcmF0aGVyXG4gKiB0aGFuIHJldHVybmVkLCBzbyB0aGUgY2FsbGVyIGNhbiByZXRyeSB0aGlzIHdob2xlIGF0dGVtcHQgYWZ0ZXIgYSByZXBhaXJcbiAqIHdpdGhvdXQgbG9zaW5nIHRoZSBkaWFnbm9zdGljcyBmcm9tIGVhcmxpZXIgYXR0ZW1wdHMuXG4gKlxuICogQHJldHVybnMgVGhlIHN1Y2Nlc3MgbWVzc2FnZSwgb3IgYHVuZGVmaW5lZGAgaWYgZXZlcnkgc3RhcnQgcG9pbnQgZmFpbGVkLlxuICovXG5hc3luYyBmdW5jdGlvbiBhdHRlbXB0Q3JlYXRlRmVhdHVyZUJyYW5jaChcbiAgYnJhbmNoTmFtZTogc3RyaW5nLFxuICBiYXNlQnJhbmNoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuICBmYWlsdXJlczogc3RyaW5nW10sXG4gIHN0ZGVyclRleHRzOiBzdHJpbmdbXSxcbik6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG4gIC8vIEZldGNoIHRoZSBsYXRlc3QgdXBzdHJlYW0gYmFzZSBicmFuY2ggYmVmb3JlIGNyZWF0aW5nIHRoZSBmZWF0dXJlIGJyYW5jaFxuICAvLyAoSXNzdWUgIzE1MDEpLiBOb24tZmF0YWwg4oCUIGlmIHRoaXMgZmFpbHMgd2UgZmFsbCBiYWNrIHRvIGxvY2FsIHJlZnMuXG4gIGNvbnN0IGZldGNoUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBidWlsZEZldGNoQXJncyhcIm9yaWdpblwiLCBiYXNlQnJhbmNoKSxcbiAgICBvcHRpb25zLFxuICApO1xuICBjb25zdCBmZXRjaE9rID0gZmV0Y2hSZXN1bHQub2sgJiYgZmV0Y2hSZXN1bHQudmFsdWUuY29kZSA9PT0gMDtcblxuICBpZiAoIWZldGNoT2spIHtcbiAgICBjb25zdCBkZXRhaWwgPSBmZXRjaFJlc3VsdC5va1xuICAgICAgPyBmZXRjaFJlc3VsdC52YWx1ZS5zdGRlcnIudHJpbSgpIHx8IGBleGl0ICR7ZmV0Y2hSZXN1bHQudmFsdWUuY29kZX1gXG4gICAgICA6IGZldGNoUmVzdWx0LmVycm9yLm1lc3NhZ2U7XG4gICAgY29uc3QgZmV0Y2hTdGRlcnIgPSBmZXRjaFJlc3VsdC5vayA/IGZldGNoUmVzdWx0LnZhbHVlLnN0ZGVyciA6IFwiXCI7XG4gICAgaWYgKGZldGNoUmVzdWx0Lm9rKSBzdGRlcnJUZXh0cy5wdXNoKGZldGNoU3RkZXJyKTtcblxuICAgIC8vIEEgYnJva2VuIGxvb3NlIHJlZiAoSXNzdWUgIzI4ODApIGNhbiBmYWlsIHRoZSBmZXRjaCBvdXRyaWdodCB3aGlsZSBhXG4gICAgLy8gKnN0YWxlKiBvcmlnaW4vPGJhc2VCcmFuY2g+IGZyb20gYW4gZWFybGllciBzdWNjZXNzZnVsIGZldGNoIGlzIHN0aWxsXG4gICAgLy8gb24gZGlzay4gRmFsbGluZyBiYWNrIHRvIGxvY2FsIHJlZnMgaGVyZSB3b3VsZCBsZXQgdGhlIGNoZWNrb3V0IGJlbG93XG4gICAgLy8gc2lsZW50bHkgc3VjY2VlZCBmcm9tIHRoYXQgc3RhbGUgdGlwIGluc3RlYWQgb2Ygc3VyZmFjaW5nIHRoZSBmYWlsdXJlXG4gICAgLy8gZm9yIHJlcGFpciDigJQgZ2l2ZSB0aGUgY2FsbGVyJ3MgcmVwYWlyLWFuZC1yZXRyeSBsb29wIGZpcnN0IHJlZnVzYWxcbiAgICAvLyB3aGVuZXZlciB0aGUgZmV0Y2ggZmFpbHVyZSBuYW1lcyBhIHJlcGFpcmFibGUgcmVmLlxuICAgIGlmIChicm9rZW5SZWZzSW4oZmV0Y2hTdGRlcnIpLmxlbmd0aCA+IDApIHtcbiAgICAgIGZhaWx1cmVzLnB1c2goYGZldGNoIG9yaWdpbiAke2Jhc2VCcmFuY2h9IGZhaWxlZDogJHtkZXRhaWx9YCk7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGNvbnNvbGUud2FybihcbiAgICAgIGBbZ2l0X2JyYW5jaF0gV2FybmluZzogZmFpbGVkIHRvIGZldGNoIG9yaWdpbi8ke2Jhc2VCcmFuY2h9ICgke2RldGFpbH0pOyBgICtcbiAgICAgICAgYGZhbGxpbmcgYmFjayB0byBsb2NhbCByZWZgLFxuICAgICk7XG4gIH1cblxuICAvLyBTdGFydCBwb2ludHMgaW4gb3JkZXIgb2YgcHJlZmVyZW5jZTogdGhlIGZyZXNobHkgZmV0Y2hlZCByZW1vdGUgdGlwLCB0aGVcbiAgLy8gbG9jYWwgYmFzZSByZWYgKElzc3VlICM0NzYpLCB0aGVuIHRoZSByZW1vdGUtdHJhY2tpbmcgcmVmIGZvciBhIGNsb25lXG4gIC8vIHRoYXQgY291bGQgbm90IGJlIGZldGNoZWQuIEVhY2ggaXMgYXR0ZW1wdGVkIHdpdGggYGNoZWNrb3V0IC1CYCBzbyBhblxuICAvLyBleGlzdGluZyBsb2NhbCBicmFuY2gg4oCUIGluY2x1ZGluZyB0aGUgb25lIEhFQUQgaXMgb24g4oCUIGlzIHJlc2V0IHJhdGhlclxuICAvLyB0aGFuIGNvbGxpZGVkIHdpdGggKElzc3VlICMzNTYpLlxuICBjb25zdCBzdGFydFBvaW50cyA9IGZldGNoT2tcbiAgICA/IFtgb3JpZ2luLyR7YmFzZUJyYW5jaH1gLCBiYXNlQnJhbmNoXVxuICAgIDogW2Jhc2VCcmFuY2gsIGBvcmlnaW4vJHtiYXNlQnJhbmNofWBdO1xuXG4gIGxldCBoZWxkQnk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29uc3QgcmVmdXNhbHM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3Qgc3RhcnRQb2ludCBvZiBzdGFydFBvaW50cykge1xuICAgIGNvbnN0IGFyZ3MgPSBidWlsZENoZWNrb3V0UmVzZXRCcmFuY2hBcmdzKGJyYW5jaE5hbWUsIHN0YXJ0UG9pbnQpO1xuICAgIGNvbnN0IGNoZWNrb3V0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChhcmdzLCBvcHRpb25zKTtcbiAgICBpZiAoY2hlY2tvdXQub2sgJiYgY2hlY2tvdXQudmFsdWUuY29kZSA9PT0gMCkge1xuICAgICAgcmV0dXJuIGBDcmVhdGVkIGZlYXR1cmUgYnJhbmNoICcke2JyYW5jaE5hbWV9JyBmcm9tICcke3N0YXJ0UG9pbnR9J2A7XG4gICAgfVxuICAgIGZhaWx1cmVzLnB1c2goZGVzY3JpYmVHaXRGYWlsdXJlKGFyZ3MsIGNoZWNrb3V0KSk7XG4gICAgaWYgKGNoZWNrb3V0Lm9rKSB7XG4gICAgICBzdGRlcnJUZXh0cy5wdXNoKGNoZWNrb3V0LnZhbHVlLnN0ZGVycik7XG4gICAgICByZWZ1c2Fscy5wdXNoKGNoZWNrb3V0LnZhbHVlLnN0ZGVycik7XG4gICAgfVxuICAgIGhlbGRCeSA/Pz0gaGVsZEJ5TGFuZVdvcmt0cmVlKGNoZWNrb3V0KTtcbiAgfVxuXG4gIC8vIElzc3VlICM0Nzg5OiBhIGJyYW5jaCBsZWZ0IGNoZWNrZWQgb3V0IGluIHRoZSBzaGFyZWQgY2xvbmUncyBvd24gcHJpbWFyeVxuICAvLyB3b3JrdHJlZSBpcyByZWZ1c2VkIHRoZSBzYW1lIHdheSwgYW5kIGlzIG5vdCBhIGxhbmUgd29ya3RyZWUuIE9ubHkgd2hlblxuICAvLyBubyBsYW5lIHdvcmt0cmVlIGhvbGRzIGl0LCB0aGUgcHJpbWFyeSBpcyB0aGUgaG9sZGVyLCBhbmQgaXQgaXMgcmVsZWFzZWRcbiAgLy8gYnkgdGhlIHNhbWUgZGV0YWNoLWFuZC1yZXRyeSBiZWxvdy5cbiAgaWYgKGhlbGRCeSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgZm9yIChjb25zdCBzdGRlcnIgb2YgcmVmdXNhbHMpIHtcbiAgICAgIGhlbGRCeSA9IGF3YWl0IHByaW1hcnlDbG9uZUhvbGRpbmdCcmFuY2goc3RkZXJyLCBvcHRpb25zLmN3ZCk7XG4gICAgICBpZiAoaGVsZEJ5ICE9PSB1bmRlZmluZWQpIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIC8vIElzc3VlICMxNTY0OiBicmFuY2hlcyBhcmUgc2hhcmVkIGJldHdlZW4gdGhlIHdvcmt0cmVlcyBvZiBvbmUgY2xvbmUsIHNvXG4gIC8vIGdpdCByZWZ1c2VzIHRvIG1vdmUgYSBicmFuY2ggYW5vdGhlciB3b3JrdHJlZSBoYXMgY2hlY2tlZCBvdXQuIFNsb3QgczJcbiAgLy8gY2hlY2tzIGFuIGlzc3VlJ3MgZmVhdHVyZSBicmFuY2ggb3V0IGluIGl0cyBsYW5lIHdvcmt0cmVlIGFuZCB0aGVuIGxvc2VzXG4gIC8vIHRoZSBhY3F1aXJlIHJhY2U7IHMxIHdpbnMgdGhlIGNsYWltIGFuZCBjYW5ub3QgaGF2ZSB0aGUgYnJhbmNoLiBCb3RoXG4gIC8vIHN0YXJ0IHBvaW50cyBmYWlsIHRoZSBzYW1lIHdheSwgdGhlIGlzc3VlIGRpZXMgaW4gcGhhc2UgYHNldHVwYCB3aXRoaW5cbiAgLy8gc2Vjb25kcywgYW5kIOKAlCBiZWNhdXNlIG5vdGhpbmcgcmVsZWFzZXMgczIncyBob2xkIOKAlCBldmVyeSBsYXRlciBhdHRlbXB0XG4gIC8vIGZhaWxzIGlkZW50aWNhbGx5LiBWaWJlQ29kZXIjMTU0OCBoYWQgdHdvIGJlZm9yZSB0aGlzIHdhcyBmb3VuZC5cbiAgLy9cbiAgLy8gRGV0YWNoaW5nIHRoZSBob2xkZXIgaXMgZXhhY3RseSB3aGF0IGBkZXRhY2hMYW5lV29ya3RyZWVIZWFkYCBleGlzdHMgZm9yO1xuICAvLyBpdCB3YXMgb25seSBldmVyIGNhbGxlZCBvbiB0aGUgaGFwcHkgcGF0aCwgYWZ0ZXIgYSBsYW5lIGZpbmlzaGVkIHdpdGggYVxuICAvLyBQUi4gQ2FsbGluZyBpdCBoZXJlIGNsb3NlcyB0aGUgbG9vcCBmb3IgdGhlIGxhbmUgdGhhdCAqZGlkbid0KiBmaW5pc2guXG4gIC8vXG4gIC8vIElzc3VlICM0Nzg5OiB0aGUgaG9sZGVyIGNhbiBhbHNvIGJlIHRoZSBzaGFyZWQgY2xvbmUncyBwcmltYXJ5IHdvcmt0cmVlXG4gIC8vIChgPHdvcmsgcm9vdD4vPHJlcG8+YCksIG5vdCBhIGxhbmUg4oCUIGEgcnVuJ3Mgb3duIHNldHVwIGxlZnQgdGhlIGlzc3VlXG4gIC8vIGJyYW5jaCBjaGVja2VkIG91dCB0aGVyZSwgYW5kIGBsYW5lV29ya3RyZWVIb2xkaW5nQnJhbmNoYCBkb2VzIG5vdFxuICAvLyByZWNvZ25pc2UgaXQuIGBwcmltYXJ5Q2xvbmVIb2xkaW5nQnJhbmNoYCBhZG1pdHMgb25seSB0aGF0IHByaW1hcnksIHNvIGFcbiAgLy8gZGV2ZWxvcGVyJ3Mgb3duIHdvcmt0cmVlIHN0aWxsIGZhbGxzIHRocm91Z2ggYW5kIGlzIHJlcG9ydGVkIHVuY2hhbmdlZC5cbiAgaWYgKGhlbGRCeSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKGF3YWl0IGRldGFjaExhbmVXb3JrdHJlZUhlYWQoaGVsZEJ5KSkge1xuICAgICAgZm9yIChjb25zdCBzdGFydFBvaW50IG9mIHN0YXJ0UG9pbnRzKSB7XG4gICAgICAgIGNvbnN0IGFyZ3MgPSBidWlsZENoZWNrb3V0UmVzZXRCcmFuY2hBcmdzKGJyYW5jaE5hbWUsIHN0YXJ0UG9pbnQpO1xuICAgICAgICBjb25zdCByZXRyeSA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoYXJncywgb3B0aW9ucyk7XG4gICAgICAgIGlmIChyZXRyeS5vayAmJiByZXRyeS52YWx1ZS5jb2RlID09PSAwKSB7XG4gICAgICAgICAgcmV0dXJuIGBDcmVhdGVkIGZlYXR1cmUgYnJhbmNoICcke2JyYW5jaE5hbWV9JyBmcm9tIGAgK1xuICAgICAgICAgICAgYCcke3N0YXJ0UG9pbnR9JyBhZnRlciByZWxlYXNpbmcgaXQgZnJvbSB0aGUgd29ya3RyZWUgYXQgYCArXG4gICAgICAgICAgICBgJHtoZWxkQnl9YDtcbiAgICAgICAgfVxuICAgICAgICBmYWlsdXJlcy5wdXNoKGRlc2NyaWJlR2l0RmFpbHVyZShhcmdzLCByZXRyeSkpO1xuICAgICAgICBpZiAocmV0cnkub2spIHN0ZGVyclRleHRzLnB1c2gocmV0cnkudmFsdWUuc3RkZXJyKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKiogTW9zdCBicm9rZW4gcmVmcyByZXBhaXJlZCB3aXRoaW4gb25lIHtAbGluayBjcmVhdGVGZWF0dXJlQnJhbmNoRnJvbUJhc2V9IGNhbGwuICovXG5jb25zdCBNQVhfUkVQQUlSRURfUkVGU19QRVJfQ0FMTCA9IDEwO1xuXG4vKipcbiAqIENyZWF0ZSBhIGZlYXR1cmUgYnJhbmNoIGZyb20gYSBzcGVjaWZpZWQgYmFzZSBicmFuY2ggKElzc3VlICM0NzYsICMxNTAxLFxuICogIzI4ODApLlxuICpcbiAqIEV4cGxpY2l0bHkgY3JlYXRlcyBhIGZlYXR1cmUgYnJhbmNoIGZyb20gdGhlIGdpdmVuIGJhc2UgYnJhbmNoLiBUaGlzIGVuc3VyZXNcbiAqIG1pbGVzdG9uZSBpc3N1ZXMgY3JlYXRlIGZlYXR1cmUgYnJhbmNoZXMgb2ZmIHRoZSBtaWxlc3RvbmUgYnJhbmNoIHJhdGhlciB0aGFuXG4gKiB3aGF0ZXZlciBIRUFEIGhhcHBlbnMgdG8gcG9pbnQgdG8uXG4gKlxuICogVG8gYXZvaWQgYnJhbmNoaW5nIGZyb20gYSBzdGFsZSBsb2NhbCByZWYgKElzc3VlICMxNTAxKSwgdGhpcyBmaXJzdCBydW5zXG4gKiBgZ2l0IGZldGNoIG9yaWdpbiA8YmFzZUJyYW5jaD5gIGFuZCB0aGVuIHByZWZlcnMgYG9yaWdpbi88YmFzZUJyYW5jaD5gIGFzIHRoZVxuICogY2hlY2tvdXQgc291cmNlLiBJZiB0aGUgZmV0Y2ggZmFpbHMgKGUuZy4sIG9mZmxpbmUpLCBhIHdhcm5pbmcgaXMgbG9nZ2VkIGFuZFxuICogdGhlIGZ1bmN0aW9uIGZhbGxzIGJhY2sgdG8gdGhlIGV4aXN0aW5nIGxvY2FsLXRoZW4tcmVtb3RlIGNoZWNrb3V0IGxvZ2ljLlxuICpcbiAqIFRoZSBicmFuY2ggaXMgY3JlYXRlZCB3aXRoIGBjaGVja291dCAtQmAg4oCUIGNyZWF0ZS1vci1yZXNldCDigJQgcmF0aGVyIHRoYW5cbiAqIGBicmFuY2ggLURgIGZvbGxvd2VkIGJ5IGBjaGVja291dCAtYmAgKElzc3VlICMzNTYpLiBHaXQgcmVmdXNlcyB0byBkZWxldGVcbiAqIHRoZSBicmFuY2ggSEVBRCBpcyBvbiwgYW5kIHRoZSByZXN1bWUtb24tcmVjbGFpbSBsb29rdXAgbGVhdmVzIEhFQUQgZXhhY3RseVxuICogdGhlcmU6IGl0IGNoZWNrcyBhIGNhbmRpZGF0ZSBicmFuY2ggb3V0LCBmaW5kcyBpdCBubyBjb21taXRzIGFoZWFkIG9mIGJhc2UsXG4gKiBwYXNzZXMgaXQgb3ZlciwgYW5kIHJldHVybnMgXCJzdGFydCBmcmVzaFwiIHdpdGhvdXQgbW92aW5nIEhFQUQgYmFjay4gVGhlXG4gKiBkZWxldGUgdGhlbiBmYWlsZWQsIGFsbCB0aHJlZSBgY2hlY2tvdXQgLWJgIGF0dGVtcHRzIGNvbGxpZGVkIHdpdGggdGhlXG4gKiBicmFuY2ggdGhhdCB3YXMgc3RpbGwgcHJlc2VudCwgYW5kIHRoZSBjbGFpbSBkaWVkIGluIHBoYXNlIGBzZXR1cGAuIEJlaW5nIGFcbiAqIGRldGVybWluaXN0aWMgZnVuY3Rpb24gb2YgdGhlIHJlcG9zaXRvcnkncyBzdGF0ZSwgaXQgZGllZCB0aGUgc2FtZSB3YXkgb25cbiAqIGV2ZXJ5IHJlLWNsYWltOiBJc3N1ZSAjMzU2IHdhcyBjbGFpbWVkIGFuZCByZWxlYXNlZCB0ZW4gdGltZXMgaW4gbmluZSBob3Vyc1xuICogd2hpbGUgdGhlIGlkbGUtZGVjaXNpb24gY2Vuc3VzIGtlcHQgcmVwb3J0aW5nIGl0IGFzIGNsYWltYWJsZSB3b3JrIG5vYm9keVxuICogd2FzIGRvaW5nLiBgLUJgIGlzIG5vIG1vcmUgZGVzdHJ1Y3RpdmUgdGhhbiB0aGUgZGVsZXRlIGl0IHJlcGxhY2VzIOKAlCBib3RoXG4gKiBkaXNjYXJkIHdoYXRldmVyIHRoZSBsb2NhbCBicmFuY2ggcG9pbnRlZCBhdCDigJQgYW5kIGl0IGNhbm5vdCB3ZWRnZS5cbiAqXG4gKiBBIHNoYXJlZCBjbG9uZSBjYW4gYWxzbyBjYXJyeSBhICoqYnJva2VuIGxvb3NlIHJlZioqIOKAlCBhIHJlZiBmaWxlIG5hbWluZyBhblxuICogb2JqZWN0IHRoZSBvYmplY3Qgc3RvcmUgbm8gbG9uZ2VyIGhhcyDigJQgd2hpY2ggZmFpbHMgdGhlIGZldGNoIChgZmF0YWw6IGJhZFxuICogb2JqZWN0IHJlZnMvPHg+YCkgb3IgdGhlIGNoZWNrb3V0IG9mIGBvcmlnaW4vPGJhc2VCcmFuY2g+YCAoYHdhcm5pbmc6XG4gKiBpZ25vcmluZyBicm9rZW4gcmVmIOKApmApIG91dHJpZ2h0IChJc3N1ZSAjMjg4MCkuIEV2ZXJ5IHN1Y2ggcmVmIGlzXG4gKiByZWNvdmVyYWJsZSBmcm9tIHRoZSByZW1vdGUsIHNvIG9uIGZhaWx1cmUgdGhpcyBzY2FucyBnaXQncyBvd24gc3RkZXJyIGZvclxuICogcmVmIG5hbWVzIGl0IG5hbWVzIGFzIGJyb2tlbiwgcmVtb3ZlcyBlYWNoIHdpdGggYHJlbW92ZUJyb2tlblJlZmAsIGFuZFxuICogcmV0cmllcyB0aGUgd2hvbGUgYXR0ZW1wdCDigJQgYm91bmRlZCBhdFxuICoge0BsaW5rIE1BWF9SRVBBSVJFRF9SRUZTX1BFUl9DQUxMfSByZXBhaXJlZCByZWZzLCBhbmQgc3RvcHBpbmcgYXMgc29vbiBhcyBhXG4gKiByZXRyeSBuYW1lcyBubyBuZXcgcmVmLlxuICpcbiAqIEEgYnJhbmNoIGhlbGQgYnkgYW5vdGhlciB3b3JrdHJlZSBvZiB0aGUgY2xvbmUgaXMgcmVsZWFzZWQgb24gdGhlIHNhbWVcbiAqIHJldHJ5IHBhdGggKElzc3VlICMxNTY0KSwgd2hlbiB0aGF0IGhvbGRlciBpcyBvbmUgb2YgdGhpcyBob3N0J3MgbGFuZVxuICogd29ya3RyZWVzIG9yIHRoZSBzaGFyZWQgY2xvbmUncyBvd24gcHJpbWFyeSB3b3JrdHJlZSAoSXNzdWUgIzQ3ODkpLiBBXG4gKiBkZXZlbG9wZXIncyBvd24gd29ya3RyZWUgaXMgbmV2ZXIgZGV0YWNoZWQ6IHRoZSByZWZ1c2FsIGlzIHJldHVybmVkIGFzIGlzLlxuICpcbiAqIEBwYXJhbSBicmFuY2hOYW1lIC0gVGhlIGZlYXR1cmUgYnJhbmNoIG5hbWUgdG8gY3JlYXRlXG4gKiBAcGFyYW0gYmFzZUJyYW5jaCAtIFRoZSBicmFuY2ggdG8gY3JlYXRlIGZyb20gKGUuZy4sIFwibWFpblwiIG9yIFwibWlsZXN0b25lL29pZGNcIilcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9ucyAoY3dkLCBldGMuKVxuICogQHJldHVybnMgUmVzdWx0IGluZGljYXRpbmcgc3VjY2Vzcywgb3IgZmFpbHVyZSBuYW1pbmcgZ2l0J3Mgb3duIG91dHB1dFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY3JlYXRlRmVhdHVyZUJyYW5jaEZyb21CYXNlKFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIGJhc2VCcmFuY2g6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZz4+IHtcbiAgY29uc3QgZmFpbHVyZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJlcGFpcmVkUmVmcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGZvciAoOzspIHtcbiAgICBjb25zdCBzdGRlcnJUZXh0czogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBzdWNjZXNzID0gYXdhaXQgYXR0ZW1wdENyZWF0ZUZlYXR1cmVCcmFuY2goXG4gICAgICBicmFuY2hOYW1lLFxuICAgICAgYmFzZUJyYW5jaCxcbiAgICAgIG9wdGlvbnMsXG4gICAgICBmYWlsdXJlcyxcbiAgICAgIHN0ZGVyclRleHRzLFxuICAgICk7XG4gICAgaWYgKHN1Y2Nlc3MgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBzdWNjZXNzIH07XG4gICAgfVxuXG4gICAgaWYgKHJlcGFpcmVkUmVmcy5zaXplID49IE1BWF9SRVBBSVJFRF9SRUZTX1BFUl9DQUxMKSBicmVhaztcblxuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBicm9rZW5SZWZzSW4oc3RkZXJyVGV4dHMuam9pbihcIlxcblwiKSkuZmlsdGVyKFxuICAgICAgKHJlZikgPT4gIXJlcGFpcmVkUmVmcy5oYXMocmVmKSxcbiAgICApO1xuICAgIGlmIChjYW5kaWRhdGVzLmxlbmd0aCA9PT0gMCkgYnJlYWs7XG5cbiAgICBsZXQgcmVwYWlyZWRBbnkgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IHJlZiBvZiBjYW5kaWRhdGVzKSB7XG4gICAgICBpZiAocmVwYWlyZWRSZWZzLnNpemUgPj0gTUFYX1JFUEFJUkVEX1JFRlNfUEVSX0NBTEwpIGJyZWFrO1xuICAgICAgcmVwYWlyZWRSZWZzLmFkZChyZWYpO1xuICAgICAgY29uc3QgcmVtb3ZhbCA9IGF3YWl0IHJlbW92ZUJyb2tlblJlZihyZWYsIG9wdGlvbnMpO1xuICAgICAgaWYgKCFyZW1vdmFsLm9rKSB7XG4gICAgICAgIGZhaWx1cmVzLnB1c2goXG4gICAgICAgICAgYHJlbW92aW5nIGJyb2tlbiByZWYgJyR7cmVmfSc6ICR7cmVtb3ZhbC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICAgICk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgW2dpdF9icmFuY2hdIFdhcm5pbmc6IHJlbW92ZWQgYnJva2VuIHJlZiAke3JlZn0gKHBvaW50cyBhdCBhIGAgK1xuICAgICAgICAgIGBtaXNzaW5nIG9iamVjdCk7IHJldHJ5aW5nIGJyYW5jaCBjcmVhdGlvbiAoSXNzdWUgIzI4ODApYCxcbiAgICAgICk7XG4gICAgICByZXBhaXJlZEFueSA9IHRydWU7XG4gICAgfVxuICAgIGlmICghcmVwYWlyZWRBbnkpIGJyZWFrO1xuICB9XG5cbiAgLy8gRmFpbCBsb3VkIHdpdGggZ2l0J3Mgb3duIHdvcmRzOiB0aGUgcmVsZWFzZSBjb21tZW50IGZvciBJc3N1ZSAjMzU2IHJlYWRcbiAgLy8gXCJjb3VsZCBub3QgYmUgYXV0b21hdGljYWxseSBkZXRlcm1pbmVkXCIgYmVjYXVzZSB0aGV5IHdlcmUgZGlzY2FyZGVkIGhlcmUuXG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICBgRmFpbGVkIHRvIGNyZWF0ZSBmZWF0dXJlIGJyYW5jaCAnJHticmFuY2hOYW1lfScgZnJvbSAnJHtiYXNlQnJhbmNofSc6IGAgK1xuICAgICAgICBmYWlsdXJlcy5qb2luKFwiOyBcIiksXG4gICAgKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBSZXN1bWUgYSBmZWF0dXJlIGJyYW5jaCBmcm9tIGl0cyByZW1vdGUgY2hlY2twb2ludCAoSXNzdWUgIzQxNzApLlxuICpcbiAqIEEga2lsbGVkIHNlc3Npb24ncyBXSVAgY2hlY2twb2ludHMgbGl2ZSBvbiB0aGUgcmVtb3RlIGlzc3VlIGJyYW5jaDsgdGhlXG4gKiByZS1jbGFpbSBwYXRoIGNhbGxzIHRoaXMgKmluc3RlYWQgb2YqIGBjcmVhdGVGZWF0dXJlQnJhbmNoRnJvbUJhc2VgIHNvXG4gKiB0aGUgcHJpb3IgcHJvZ3Jlc3MgaXMgcGlja2VkIHVwIHJhdGhlciB0aGFuIHJlY3JlYXRlZCBmcm9tIGJhc2UuIEFueVxuICogbG9jYWwgYnJhbmNoIG9mIHRoZSBzYW1lIG5hbWUgaXMgcmVwbGFjZWQg4oCUIGFmdGVyIGBzZXR1cFJlcG9gJ3MgcmVzZXRcbiAqIHRoZSBsb2NhbCByZWYgaXMgc3RhbGUsIGFuZCB0aGUgcHVzaGVkIGNoZWNrcG9pbnQgaXMgdGhlIGR1cmFibGUgdHJ1dGguXG4gKlxuICogUmV0dXJucyBgdHJ1ZWAgd2hlbiB0aGUgYnJhbmNoIHdhcyBjaGVja2VkIG91dCBmcm9tIGBvcmlnaW4vPGJyYW5jaD5gLFxuICogYGZhbHNlYCB3aGVuIG5vIHN1Y2ggcmVtb3RlIGJyYW5jaCBleGlzdHMgKG9yIHRoZSBjaGVja291dCBmYWlsZWQpIOKAlFxuICogdGhlIGNhbGxlciB0aGVuIGZhbGxzIGJhY2sgdG8gY3JlYXRpbmcgdGhlIGJyYW5jaCBmcmVzaCBmcm9tIGJhc2UuXG4gKlxuICogVGhlIGJyYW5jaCBjYW4gYmUgaGVsZCBieSBhbm90aGVyIHdvcmt0cmVlIG9mIHRoZSBjbG9uZSB3aGVuIGdpdCByZWZ1c2VzXG4gKiB0aGUgY2hlY2tvdXQ6IGEgc2libGluZyBsYW5lIHdvcmt0cmVlIChJc3N1ZSAjMTU2NCBwYXR0ZXJuLCBJc3N1ZSAjNDc5NCkgb3JcbiAqIHRoZSBzaGFyZWQgY2xvbmUncyBwcmltYXJ5IChJc3N1ZSAjNDc4OSkuIFRoYXQgaG9sZGVyIGlzIGRldGFjaGVkIGFuZCB0aGVcbiAqIGNoZWNrb3V0IHJldHJpZWQgb25jZS4gQSBob2xkZXIgb3V0c2lkZSB0aG9zZSAoZS5nLiBhIGRldmVsb3BlcidzIG93blxuICogd29ya3RyZWUpIGlzIGxlZnQgYWxvbmUsIHNvIHRoZSBmdW5jdGlvbiByZXR1cm5zIGBvazogdHJ1ZSwgdmFsdWU6IGZhbHNlYC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc3VtZUZlYXR1cmVCcmFuY2hGcm9tUmVtb3RlKFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxib29sZWFuPj4ge1xuICBjb25zdCBmZXRjaFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgYnVpbGRGZXRjaEFyZ3MoXCJvcmlnaW5cIiwgYnJhbmNoTmFtZSksXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFmZXRjaFJlc3VsdC5vayB8fCBmZXRjaFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBmYWxzZSB9O1xuICB9XG5cbiAgLy8gUmVwbGFjZSBhbnkgc3RhbGUgbG9jYWwgYnJhbmNoLiBgY2hlY2tvdXQgLUJgIGNyZWF0ZS1vci1yZXNldHMsIHNvIGFcbiAgLy8gbGVmdG92ZXIgbG9jYWwgcmVmIOKAlCBpbmNsdWRpbmcgb25lIEhFQUQgaXMgYWxyZWFkeSBzaXR0aW5nIG9uIOKAlCBpcyBtb3ZlZFxuICAvLyBvbnRvIHRoZSByZW1vdGUgY2hlY2twb2ludCByYXRoZXIgdGhhbiBjb2xsaWRpbmcgd2l0aCBpdCAoSXNzdWUgIzM1Nik7XG4gIC8vIGBicmFuY2ggLURgIGNhbm5vdCBkZWxldGUgdGhlIGNoZWNrZWQtb3V0IGJyYW5jaCwgYW5kIHRoZSBjb2xsaXNpb24gdGhhdFxuICAvLyBmb2xsb3dlZCBzaWxlbnRseSByZXBvcnRlZCBcIm5vIHJlc3VtYWJsZSB3b3JrXCIgb3ZlciBhIHB1c2hlZCBjb21taXQuXG4gIC8vXG4gIC8vIElzc3VlICM0Nzk0OiB0aGUgaG9sZGVyIGNhbiBiZSBhIHNpYmxpbmcgbGFuZSB3b3JrdHJlZSwgd2hpY2ggaXMgcmVmdXNlZFxuICAvLyB0aGUgc2FtZSB3YXkgdGhlIHByaW1hcnkgaXMgKElzc3VlICMxNTY0KS4gQSBsYW5lIGhvbGRlciBpcyBwcmVmZXJyZWQ7XG4gIC8vIG9ubHkgd2hlbiBub25lIGhvbGRzIGl0IGlzIHRoZSBwcmltYXJ5IChJc3N1ZSAjNDc4OSkgdGhlIGhvbGRlci5cbiAgY29uc3QgYXJncyA9IGJ1aWxkQ2hlY2tvdXRSZXNldEJyYW5jaEFyZ3MoYnJhbmNoTmFtZSwgYG9yaWdpbi8ke2JyYW5jaE5hbWV9YCk7XG4gIGxldCBjaGVja291dFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoYXJncywgb3B0aW9ucyk7XG4gIGlmIChjaGVja291dFJlc3VsdC5vayAmJiBjaGVja291dFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgY29uc3QgaG9sZGVyID0gaGVsZEJ5TGFuZVdvcmt0cmVlKGNoZWNrb3V0UmVzdWx0KSA/P1xuICAgICAgYXdhaXQgcHJpbWFyeUNsb25lSG9sZGluZ0JyYW5jaChcbiAgICAgICAgY2hlY2tvdXRSZXN1bHQudmFsdWUuc3RkZXJyLFxuICAgICAgICBvcHRpb25zLmN3ZCxcbiAgICAgICk7XG4gICAgaWYgKGhvbGRlciAhPT0gdW5kZWZpbmVkICYmIGF3YWl0IGRldGFjaExhbmVXb3JrdHJlZUhlYWQoaG9sZGVyKSkge1xuICAgICAgY2hlY2tvdXRSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKGFyZ3MsIG9wdGlvbnMpO1xuICAgIH1cbiAgfVxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIHZhbHVlOiBjaGVja291dFJlc3VsdC5vayAmJiBjaGVja291dFJlc3VsdC52YWx1ZS5jb2RlID09PSAwLFxuICB9O1xufVxuXG4vKipcbiAqIEhFQUQgYW5kIHRoZSB3b3JrZXIgYnJhbmNoIGhhdmUgZGl2ZXJnZWQgKElzc3VlICM0Mjg2KTogdGhlIGFnZW50IGNvbW1pdHRlZFxuICogb24gYSBicmFuY2ggb2YgaXRzIG93biBhbmQgbmVpdGhlciBoaXN0b3J5IGNvbnRhaW5zIHRoZSBvdGhlci5cbiAqXG4gKiBBIHR5cGVkIGVycm9yLCBzbyBjb21wbGV0aW9uIGNhbiB0ZWxsIHRoaXMgcmVmdXNhbCBmcm9tIGEgSEVBRCBpdCBjb3VsZFxuICogbm90IHJlc29sdmU6IG9uIGEgY2xvc2VkIGlzc3VlIHRoZSBkaXZlcmdlbmNlIHVzdWFsbHkgbWVhbnMgdGhlIHdvcmtcbiAqIGFscmVhZHkgbGFuZGVkIHRocm91Z2ggdGhlIGFnZW50J3Mgb3duIFBSIGVsc2V3aGVyZSAoSXNzdWUgIzE3OTMpLCB3aGljaFxuICogaXMgbm90IGEgZmFpbHVyZS5cbiAqL1xuZXhwb3J0IGNsYXNzIEhlYWREaXZlcmdlZEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICAvKiogV2hlcmUgSEVBRCB3YXM6IHRoZSBicmFuY2ggdGhlIGFnZW50IGNvbW1pdHRlZCBvbi4gKi9cbiAgcmVhZG9ubHkgaGVhZDogc3RyaW5nO1xuICAvKiogVGhlIHdvcmtlciBicmFuY2ggdGhhdCB3YXMgZXhwZWN0ZWQuICovXG4gIHJlYWRvbmx5IGJyYW5jaE5hbWU6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihoZWFkOiBzdHJpbmcsIGJyYW5jaE5hbWU6IHN0cmluZykge1xuICAgIHN1cGVyKFxuICAgICAgYEhFQUQgaXMgb24gJyR7aGVhZH0nIGFuZCB0aGUgd29ya2VyIGJyYW5jaCAnJHticmFuY2hOYW1lfScgaGFzIGAgK1xuICAgICAgICBgZGl2ZXJnZWQgZnJvbSBpdCDigJQgdGhlIGFnZW50IGNvbW1pdHRlZCBvbiBhIGJyYW5jaCBvZiBpdHMgb3duIGFuZCBgICtcbiAgICAgICAgYHRoZSB0d28gaGlzdG9yaWVzIGRvIG5vdCBmYXN0LWZvcndhcmQuIFJlZnVzaW5nIHRvIG1vdmUgZWl0aGVyIGAgK1xuICAgICAgICBgcmVmOyBhIGh1bWFuIG11c3QgcmVjb25jaWxlIHRoZW0gKElzc3VlICM0Mjg2KS5gLFxuICAgICk7XG4gICAgdGhpcy5uYW1lID0gXCJIZWFkRGl2ZXJnZWRFcnJvclwiO1xuICAgIHRoaXMuaGVhZCA9IGhlYWQ7XG4gICAgdGhpcy5icmFuY2hOYW1lID0gYnJhbmNoTmFtZTtcbiAgfVxufVxuXG4vKiogV2hhdCB7QGxpbmsgcmVjb25jaWxlSGVhZFRvQnJhbmNofSBkaWQuICovXG5leHBvcnQgaW50ZXJmYWNlIEhlYWRSZWNvbmNpbGlhdGlvbiB7XG4gIC8qKlxuICAgKiBgYWxyZWFkeS1vbi1icmFuY2hgOiBIRUFEIHdhcyB0aGUgd29ya2VyIGJyYW5jaCDigJQgbm90aGluZyB0byBkby5cbiAgICogYGZhc3QtZm9yd2FyZGVkYDogSEVBRCB3YXMgZWxzZXdoZXJlIChhbm90aGVyIGJyYW5jaCwgb3IgZGV0YWNoZWQpIGFuZFxuICAgKiB0aGUgd29ya2VyIGJyYW5jaCB3YXMgYW4gYW5jZXN0b3IsIHNvIHRoZSB3b3JrZXIgYnJhbmNoIHdhcyBtb3ZlZCB0b1xuICAgKiBIRUFEIChgZ2l0IGNoZWNrb3V0IC1CYCksIGtlZXBpbmcgdGhlIHdvcmtpbmcgdHJlZS5cbiAgICovXG4gIGFjdGlvbjogXCJhbHJlYWR5LW9uLWJyYW5jaFwiIHwgXCJmYXN0LWZvcndhcmRlZFwiO1xuICAvKiogV2hlcmUgSEVBRCB3YXMgYmVmb3JlOiBhIGJyYW5jaCBuYW1lLCBvciBgSEVBRGAgd2hlbiBkZXRhY2hlZC4gKi9cbiAgZnJvbVJlZjogc3RyaW5nO1xufVxuXG4vKipcbiAqIEJyaW5nIEhFQUQgYmFjayBvbnRvIHRoZSB3b3JrZXIncyBicmFuY2ggYmVmb3JlIHB1c2hpbmcgKElzc3VlICM0Mjg2KS5cbiAqXG4gKiBUaGUgY29kaW5nIGFnZW50IG1heSBzd2l0Y2ggdG8gYSBicmFuY2ggb2YgaXRzIG93biBhbmQgY29tbWl0IHRoZXJlXG4gKiAocHJpdmF0ZS1yZXBvLTIyIzU2NTogYGlzc3VlLTU2NS1yZWFkbWUtYmFubmVyYCwgdHdvIGNvbW1pdHMgYWhlYWQsIHdoaWxlXG4gKiB0aGUgd29ya2VyJ3MgYGlzc3VlLTU2NS3igKZgIGJyYW5jaCBzYXQgYXQgYmFzZSkuIEV2ZXJ5IGRvd25zdHJlYW0gc3RlcCB0aGVuXG4gKiBhZ3JlZWQgd2l0aCB0aGUgb3RoZXJzIHdoaWxlIGFsbCBiZWluZyB3cm9uZyDigJQgY2hhbmdlIGRldGVjdGlvbiBjb3VudGVkXG4gKiBgYmFzZS4uSEVBRGAsIHRoZSBwdXNoIHB1c2hlZCB0aGUgKmJyYW5jaCByZWYqIChcIkV2ZXJ5dGhpbmcgdXAtdG8tZGF0ZVwiKSxcbiAqIHRoZSBhaGVhZCBndWFyZCBjb3VudGVkIGBiYXNlLi5IRUFEYCDigJQgdW50aWwgYGdoIHByIGNyZWF0ZSAtLWhlYWRgIG1ldCBhblxuICogZW1wdHkgYnJhbmNoOiBcIk5vIGNvbW1pdHMgYmV0d2VlbiDigKZcIi4gVGhyZWUgYXR0ZW1wdHMsIGVhY2ggcmVsZWFzaW5nIHRoZVxuICogY2xhaW0uXG4gKlxuICogUmVjb25jaWxpYXRpb24gaXMgZGVsaWJlcmF0ZWx5IG5hcnJvdzogb25seSB3aGVuIHRoZSB3b3JrZXIgYnJhbmNoIGlzIGFuXG4gKiBhbmNlc3RvciBvZiBIRUFEIGlzIGl0IGZhc3QtZm9yd2FyZGVkIChgY2hlY2tvdXQgLUJgKSwgYmVjYXVzZSB0aGVuIHRoZVxuICogYWdlbnQncyB3b3JrIHN0cmljdGx5IGV4dGVuZHMgaXQgYW5kIG5vdGhpbmcgaXMgbG9zdC4gSWYgdGhlIHR3byBoYXZlXG4gKiBESVZFUkdFRCB0aGUgY2FsbCBmYWlscyBuYW1pbmcgYm90aCByZWZzIOKAlCB0aGF0IG5lZWRzIGEgaHVtYW4sIGFuZCBhXG4gKiBzaWxlbnQgcmVzZXQgd291bGQgZGlzY2FyZCBzb21lb25lJ3MgY29tbWl0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlY29uY2lsZUhlYWRUb0JyYW5jaChcbiAgYnJhbmNoTmFtZTogc3RyaW5nLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8SGVhZFJlY29uY2lsaWF0aW9uPj4ge1xuICBjb25zdCBoZWFkUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLWFiYnJldi1yZWZcIiwgXCJIRUFEXCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghaGVhZFJlc3VsdC5vayB8fCBoZWFkUmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENhbm5vdCByZXNvbHZlIEhFQUQgYmVmb3JlIHB1c2hpbmcgJyR7YnJhbmNoTmFtZX0nOiBgICtcbiAgICAgICAgICBkZXNjcmliZUdpdEZhaWx1cmUoW1wicmV2LXBhcnNlXCIsIFwiLS1hYmJyZXYtcmVmXCIsIFwiSEVBRFwiXSwgaGVhZFJlc3VsdCksXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgY29uc3QgaGVhZCA9IGhlYWRSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKTtcbiAgaWYgKGhlYWQgPT09IGJyYW5jaE5hbWUpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgYWN0aW9uOiBcImFscmVhZHktb24tYnJhbmNoXCIsIGZyb21SZWY6IGhlYWQgfSB9O1xuICB9XG5cbiAgLy8gSXMgdGhlIHdvcmtlciBicmFuY2ggYW4gYW5jZXN0b3Igb2YgSEVBRD8gRXhpdCAwID0geWVzLCAxID0gbm8uXG4gIGNvbnN0IGFuY2VzdG9yID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJtZXJnZS1iYXNlXCIsIFwiLS1pcy1hbmNlc3RvclwiLCBicmFuY2hOYW1lLCBcIkhFQURcIl0sXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFhbmNlc3Rvci5vaykge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGFuY2VzdG9yLmVycm9yIH07XG4gIH1cbiAgaWYgKGFuY2VzdG9yLnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBuZXcgSGVhZERpdmVyZ2VkRXJyb3IoaGVhZCwgYnJhbmNoTmFtZSkgfTtcbiAgfVxuXG4gIC8vIEZhc3QtZm9yd2FyZCB0aGUgd29ya2VyIGJyYW5jaCB0byBIRUFEIGFuZCBjaGVjayBpdCBvdXQsIGtlZXBpbmcgdGhlXG4gIC8vIHdvcmtpbmcgdHJlZSBleGFjdGx5IGFzIHRoZSBhZ2VudCBsZWZ0IGl0LlxuICBjb25zdCBtb3ZlID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBidWlsZENoZWNrb3V0UmVzZXRCcmFuY2hBcmdzKGJyYW5jaE5hbWUpLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghbW92ZS5vayB8fCBtb3ZlLnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCBtb3ZlICcke2JyYW5jaE5hbWV9JyB0byBIRUFEICgnJHtoZWFkfScpOiBgICtcbiAgICAgICAgICBkZXNjcmliZUdpdEZhaWx1cmUoYnVpbGRDaGVja291dFJlc2V0QnJhbmNoQXJncyhicmFuY2hOYW1lKSwgbW92ZSksXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGFjdGlvbjogXCJmYXN0LWZvcndhcmRlZFwiLCBmcm9tUmVmOiBoZWFkIH0gfTtcbn1cblxuLyoqXG4gKiBEZXNjcmliZSBhIGdpdCBjb21tYW5kIG91dGNvbWUgZm9yIGEgZmFpbHVyZSBtZXNzYWdlIChJc3N1ZSAjMzkxMCkuXG4gKlxuICogQ29sbGFwc2luZyBkaXN0aW5jdCBnaXQgZmFpbHVyZXMgaW50byBvbmUgb3BhcXVlIG1lc3NhZ2UgaGlkZXMgdGhlXG4gKiByZWFzb24gYSBtaWxlc3RvbmUgYnJhbmNoIGNvdWxkIG5vdCBiZSBjcmVhdGVkIChicmFuY2ggcHJvdGVjdGlvbixcbiAqIG5vbi1mYXN0LWZvcndhcmQsIGF1dGgpLiBLZWVwIHRoZSBjb21tYW5kIGFuZCBpdHMgc3RkZXJyIHNvIHRoZVxuICogaGFuZG9mZiBjb21tZW50IG5hbWVzIHRoZSBhY3R1YWwgY2F1c2UuXG4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlR2l0RmFpbHVyZShcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHJlc3VsdDogUmVzdWx0PEdpdENvbW1hbmRPdXRwdXQ+LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgY29tbWFuZCA9IGBnaXQgJHthcmdzLmpvaW4oXCIgXCIpfWA7XG4gIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgcmV0dXJuIGAke2NvbW1hbmR9OiAke3Jlc3VsdC5lcnJvci5tZXNzYWdlfWA7XG4gIH1cbiAgY29uc3QgeyBjb2RlLCBzdGRvdXQsIHN0ZGVyciB9ID0gcmVzdWx0LnZhbHVlO1xuICBjb25zdCBvdXRwdXQgPSBzdGRlcnIudHJpbSgpIHx8IHN0ZG91dC50cmltKCkgfHwgXCIobm8gb3V0cHV0KVwiO1xuICByZXR1cm4gYCR7Y29tbWFuZH0gZXhpdGVkICR7Y29kZX06ICR7b3V0cHV0fWA7XG59XG5cbi8qKlxuICogRW5zdXJlIGEgbWlsZXN0b25lIGJyYW5jaCBleGlzdHMsIGNyZWF0aW5nIGl0IGZyb20gdGhlIGRlZmF1bHQgYnJhbmNoIGlmIG5lZWRlZCAoSXNzdWUgIzQyMikuXG4gKlxuICogQSBtaWxlc3RvbmUtYXNzaWduZWQgaXNzdWUgbXVzdCBiZSBiYXNlZCBvbiBpdHMgbWlsZXN0b25lIGJyYW5jaCwgc29cbiAqIGV2ZXJ5IGZhaWx1cmUgaGVyZSBpcyByZXR1cm5lZCB3aXRoIHRoZSB1bmRlcmx5aW5nIGdpdCBzdGRlcnIgcmF0aGVyXG4gKiB0aGFuIGEgZ2VuZXJpYyBtZXNzYWdlIChJc3N1ZSAjMzkxMCkg4oCUIGNhbGxlcnMgc3VyZmFjZSBpdCB0byBhIGh1bWFuXG4gKiBpbnN0ZWFkIG9mIHF1aWV0bHkgcmV0YXJnZXRpbmcgdGhlIHdvcmsgYXQgdGhlIGRlZmF1bHQgYnJhbmNoLlxuICpcbiAqIFdoZW4gdGhlIHJlbW90ZSBtaWxlc3RvbmUgcmVmIGlzIGFic2VudCB0aGUgYnJhbmNoIGlzIGNyZWF0ZWQgT04gT1JJR0lOIGJ5XG4gKiBwdXNoaW5nIHRoZSBkZWZhdWx0IGJyYW5jaCByZWYgc3RyYWlnaHQgdG8gdGhlIG1pbGVzdG9uZSByZWYgbmFtZSDigJQgbm9cbiAqIGxvY2FsIGNoZWNrb3V0IHRha2VzIHBhcnQgKElzc3VlICMxMzQ1KSwgc28gYSBzdGFsZSBsb2NhbCBicmFuY2ggb2YgdGhlXG4gKiBzYW1lIG5hbWUgY2FuIG5laXRoZXIgYmxvY2sgdGhlIGNyZWF0aW9uIG5vciByZWFjaCB0aGUgcmVtb3RlIChJc3N1ZVxuICogIzQwMDIpLiBXaGF0ZXZlciBsb2NhbCByZWYgZXhpc3RzIGlzIGxlZnQgZXhhY3RseSBhcyBpdCBpcyBhbmQgbmFtZWQgaW4gb25lXG4gKiBsb2cgbGluZTsgbm90aGluZyBpcyBkZWxldGVkIG9yIHJlc2V0LlxuICpcbiAqIEBwYXJhbSBtaWxlc3RvbmVCcmFuY2ggLSBUaGUgbWlsZXN0b25lIGJyYW5jaCBuYW1lXG4gKiBAcGFyYW0gZGVmYXVsdEJyYW5jaCAtIFRoZSBkZWZhdWx0IGJyYW5jaCB0byBjcmVhdGUgZnJvbVxuICogQHBhcmFtIG9wdGlvbnMgLSBHaXQgY29tbWFuZCBvcHRpb25zXG4gKiBAcGFyYW0gZW5zdXJlRGVmYXVsdEJyYW5jaEN1cnJlbnRGbiAtIEZ1bmN0aW9uIHRvIGVuc3VyZSB0aGUgZGVmYXVsdCBicmFuY2ggaXMgY3VycmVudFxuICogQHJldHVybnMgUmVzdWx0IGluZGljYXRpbmcgc3VjY2VzcyBvciBmYWlsdXJlXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBlbnN1cmVNaWxlc3RvbmVCcmFuY2hFeGlzdHMoXG4gIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nLFxuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4gIGVuc3VyZURlZmF1bHRCcmFuY2hDdXJyZW50Rm4/OiAoXG4gICAgZGVmYXVsdEJyYW5jaDogc3RyaW5nLFxuICAgIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuICApID0+IFByb21pc2U8UmVzdWx0PHN0cmluZz4+LFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nPj4ge1xuICAvLyBEaWFnbm9zdGljcyBhY2N1bXVsYXRlZCBhbG9uZyB0aGUgd2F5IOKAlCBhIGZldGNoIGZhaWx1cmUgaXMgbm90IGZhdGFsXG4gIC8vIG9uIGl0cyBvd24gKHRoZSBicmFuY2ggbWF5IG5vdCBleGlzdCB5ZXQpLCBidXQgaXQgZXhwbGFpbnMgYSBsYXRlclxuICAvLyBjcmVhdGUvcHVzaCBmYWlsdXJlIChJc3N1ZSAjMzkxMCkuXG4gIGNvbnN0IGRpYWdub3N0aWNzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIEZldGNoIHRvIGNoZWNrIHJlbW90ZSBzdGF0ZVxuICBjb25zdCBmZXRjaEFyZ3MgPSBbXCJmZXRjaFwiLCBcIm9yaWdpblwiLCBtaWxlc3RvbmVCcmFuY2hdO1xuICBjb25zdCBmZXRjaFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoZmV0Y2hBcmdzLCBvcHRpb25zKTtcbiAgaWYgKCFmZXRjaFJlc3VsdC5vayB8fCBmZXRjaFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgZGlhZ25vc3RpY3MucHVzaChkZXNjcmliZUdpdEZhaWx1cmUoZmV0Y2hBcmdzLCBmZXRjaFJlc3VsdCkpO1xuICB9XG5cbiAgY29uc3Qgc2hvd1JlZlJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1xuICAgICAgXCJzaG93LXJlZlwiLFxuICAgICAgXCItLXZlcmlmeVwiLFxuICAgICAgXCItLXF1aWV0XCIsXG4gICAgICBgcmVmcy9yZW1vdGVzL29yaWdpbi8ke21pbGVzdG9uZUJyYW5jaH1gLFxuICAgIF0sXG4gICAgb3B0aW9ucyxcbiAgKTtcblxuICBpZiAoc2hvd1JlZlJlc3VsdC5vayAmJiBzaG93UmVmUmVzdWx0LnZhbHVlLmNvZGUgPT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZTogYE1pbGVzdG9uZSBicmFuY2ggJHttaWxlc3RvbmVCcmFuY2h9IGFscmVhZHkgZXhpc3RzIG9uIHJlbW90ZWAsXG4gICAgfTtcbiAgfVxuXG4gIC8vIEVuc3VyZSB0aGUgZGVmYXVsdCBicmFuY2ggaXMgY3VycmVudCBiZWZvcmUgY3JlYXRpbmdcbiAgaWYgKGVuc3VyZURlZmF1bHRCcmFuY2hDdXJyZW50Rm4pIHtcbiAgICBhd2FpdCBlbnN1cmVEZWZhdWx0QnJhbmNoQ3VycmVudEZuKGRlZmF1bHRCcmFuY2gsIG9wdGlvbnMpO1xuICB9XG5cbiAgLy8gUmVmcmVzaCB0aGUgZGVmYXVsdCBicmFuY2gncyByZW1vdGUtdHJhY2tpbmcgcmVmIHNvIHRoZSBicmFuY2ggaXMgY3JlYXRlZFxuICAvLyBhdCB0aGUgcmVtb3RlJ3Mgb3duIHRpcC4gTm9uLWZhdGFsIG9uIGl0cyBvd24g4oCUIHRoZSBsb2NhbCByZWYgaXMgdGhlXG4gIC8vIGZhbGxiYWNrIGJlbG93IOKAlCBidXQgYSBtaWxlc3RvbmUgYnJhbmNoIGNyZWF0ZWQgZnJvbSBhIHBvc3NpYmx5IHN0YWxlXG4gIC8vIGxvY2FsIGJhc2UgaXMgbm90IHNvbWV0aGluZyB0byBsZWF2ZSB1bnNhaWQsIGFuZCBpdCBleHBsYWlucyBhIGxhdGVyIHB1c2hcbiAgLy8gZmFpbHVyZSAoSXNzdWUgIzM5MTApLiBTYW1lIHNoYXBlIGFzIGNyZWF0ZUZlYXR1cmVCcmFuY2hGcm9tQmFzZSBhYm92ZS5cbiAgY29uc3QgZGVmYXVsdEZldGNoQXJncyA9IGJ1aWxkRmV0Y2hBcmdzKFwib3JpZ2luXCIsIGRlZmF1bHRCcmFuY2gpO1xuICBjb25zdCBkZWZhdWx0RmV0Y2ggPSBhd2FpdCBydW5HaXRDb21tYW5kKGRlZmF1bHRGZXRjaEFyZ3MsIG9wdGlvbnMpO1xuICBjb25zdCBkZWZhdWx0RmV0Y2hPayA9IGRlZmF1bHRGZXRjaC5vayAmJiBkZWZhdWx0RmV0Y2gudmFsdWUuY29kZSA9PT0gMDtcbiAgaWYgKCFkZWZhdWx0RmV0Y2hPaykge1xuICAgIGNvbnN0IGZhaWx1cmUgPSBkZXNjcmliZUdpdEZhaWx1cmUoZGVmYXVsdEZldGNoQXJncywgZGVmYXVsdEZldGNoKTtcbiAgICBkaWFnbm9zdGljcy5wdXNoKGZhaWx1cmUpO1xuICAgIGNvbnNvbGUud2FybihcbiAgICAgIGBbZ2l0X2JyYW5jaF0gV2FybmluZzogZmFpbGVkIHRvIGZldGNoIG9yaWdpbi8ke2RlZmF1bHRCcmFuY2h9IGJlZm9yZSBgICtcbiAgICAgICAgYGNyZWF0aW5nICR7bWlsZXN0b25lQnJhbmNofSAoJHtmYWlsdXJlfSk7IGZhbGxpbmcgYmFjayB0byB0aGUgbG9jYWwgcmVmYCxcbiAgICApO1xuICB9XG5cbiAgLy8gVGhlIHJlbW90ZSBtaWxlc3RvbmUgcmVmIGlzIGFic2VudCwgc28gdGhlIHJlbW90ZSBjYXJyaWVzIG5vIGhpc3RvcnkgdG9cbiAgLy8gcHJlc2VydmU6IGNyZWF0ZSB0aGUgYnJhbmNoIE9OIE9SSUdJTiBieSBwdXNoaW5nIHRoZSBkZWZhdWx0IGJyYW5jaCByZWZcbiAgLy8gc3RyYWlnaHQgdG8gdGhlIG1pbGVzdG9uZSByZWYgbmFtZSAoSXNzdWUgIzEzNDUpLiBObyBsb2NhbCBjaGVja291dCB0YWtlc1xuICAvLyBwYXJ0LCBzbyBub3RoaW5nIGxvY2FsIGNhbiBibG9jayB0aGUgY3JlYXRpb24g4oCUIE5FQVQtQUktT2NraGFtIzEzMyBmYWlsZWRcbiAgLy8gdGhyZWUgdGltZXMgYmVjYXVzZSBhIHN0YWxlIGxvY2FsIGNoZWNrb3V0IGluIGFub3RoZXIgd29ya3RyZWUgaGVsZCB0aGVcbiAgLy8gYnJhbmNoIG5hbWUgYW5kIGBnaXQgY2hlY2tvdXQgLUJgIGlzIHJlZnVzZWQgb3V0cmlnaHQgaW4gdGhhdCBzdGF0ZVxuICAvLyAoXCJmYXRhbDogJ21pbGVzdG9uZS94JyBpcyBhbHJlYWR5IHVzZWQgYnkgd29ya3RyZWUgYXQg4oCmXCIpLCB3aGljaCBlc2NhbGF0ZWRcbiAgLy8gdGhlIHJ1biB0byBhIGh1bWFuIG9uIGV2ZXJ5IGF0dGVtcHQuXG4gIC8vXG4gIC8vIFB1c2hpbmcgdGhlIGRlZmF1bHQgYnJhbmNoIHJlZiBhbHNvIGtlZXBzIHRoZSBJc3N1ZSAjNDAwMiBpbnZhcmlhbnQ6IGFcbiAgLy8gc3RhbGUgbG9jYWwgYnJhbmNoIG9mIHRoZSBzYW1lIG5hbWUg4oCUIGUuZy4gb25lIGNhcnJ5aW5nIGEgbWVyZ2UgY29tbWl0IHRoZVxuICAvLyByZXBvc2l0b3J5J3MgcnVsZXMgZm9yYmlkIOKAlCBpcyBuZXZlciB3aGF0IHJlYWNoZXMgdGhlIHJlbW90ZS5cbiAgY29uc3Qgc291cmNlUmVmcyA9IGRlZmF1bHRGZXRjaE9rXG4gICAgPyBbYG9yaWdpbi8ke2RlZmF1bHRCcmFuY2h9YCwgZGVmYXVsdEJyYW5jaF1cbiAgICA6IFtkZWZhdWx0QnJhbmNoLCBgb3JpZ2luLyR7ZGVmYXVsdEJyYW5jaH1gXTtcblxuICBmb3IgKGNvbnN0IHNvdXJjZVJlZiBvZiBzb3VyY2VSZWZzKSB7XG4gICAgY29uc3QgcHVzaEFyZ3MgPSBidWlsZFB1c2hDcmVhdGVCcmFuY2hBcmdzKFxuICAgICAgXCJvcmlnaW5cIixcbiAgICAgIHNvdXJjZVJlZixcbiAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICApO1xuICAgIGNvbnN0IHB1c2hSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKHB1c2hBcmdzLCBvcHRpb25zKTtcbiAgICBpZiAoIXB1c2hSZXN1bHQub2sgfHwgcHVzaFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgICBkaWFnbm9zdGljcy5wdXNoKGRlc2NyaWJlR2l0RmFpbHVyZShwdXNoQXJncywgcHVzaFJlc3VsdCkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gTm90aGluZyBsb2NhbCB3YXMgdG91Y2hlZC4gU2F5IHNvIG9uY2UsIG5hbWluZyB0aGUgY2hlY2tvdXQgdGhhdCB1c2VkXG4gICAgLy8gdG8gYmxvY2sgdGhlIGNyZWF0aW9uLCBzbyBhbiBvcGVyYXRvciBjYW4gZmluZCBpdCB3aXRob3V0IHRoZSBydW5cbiAgICAvLyBoYXZpbmcgZGVsZXRlZCBvciByZXNldCBhbnlvbmUncyB3b3JrIChJc3N1ZSAjMTM0NSkuXG4gICAgY29uc3Qgbm90ZSA9IGRlc2NyaWJlTG9jYWxNaWxlc3RvbmVCcmFuY2goXG4gICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICBhd2FpdCBpbnNwZWN0TG9jYWxNaWxlc3RvbmVCcmFuY2gobWlsZXN0b25lQnJhbmNoLCBvcHRpb25zKSxcbiAgICAgIHNvdXJjZVJlZixcbiAgICApO1xuICAgIGlmIChub3RlICE9PSBudWxsKSB7XG4gICAgICBjb25zb2xlLndhcm4oYFtnaXRfYnJhbmNoXSAke25vdGV9YCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IGBNaWxlc3RvbmUgYnJhbmNoICR7bWlsZXN0b25lQnJhbmNofSBjcmVhdGVkIG9uIG9yaWdpbiBmcm9tIGAgK1xuICAgICAgICBgJHtzb3VyY2VSZWZ9IChubyBsb2NhbCBjaGVja291dClgLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgYEZhaWxlZCB0byBwdXNoIG1pbGVzdG9uZSBicmFuY2ggJHttaWxlc3RvbmVCcmFuY2h9IHRvIG9yaWdpbiBmcm9tIGAgK1xuICAgICAgICBgJHtkZWZhdWx0QnJhbmNofTogJHtkaWFnbm9zdGljcy5qb2luKFwiIHwgXCIpfWAsXG4gICAgKSxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7O0NBU0MsR0FHRCxTQUFTLFlBQVksRUFBRSxlQUFlLFFBQVEseUJBQXlCO0FBQ3ZFLFNBQVMsYUFBYSxRQUFRLG1CQUFtQjtBQUNqRCxTQUNFLHNCQUFzQixFQUN0Qix5QkFBeUIsRUFDekIseUJBQXlCLFFBQ3BCLHFCQUFxQjtBQUU1QixTQUNFLDRCQUE0QixFQUM1QixjQUFjLEVBQ2QseUJBQXlCLFFBQ3BCLG9CQUFvQjtBQUMzQixTQUNFLDRCQUE0QixFQUM1QiwyQkFBMkIsUUFDdEIsOEJBQThCO0FBRXJDLCtDQUErQyxHQUMvQyxNQUFNLHFCQUFxQixJQUFJLElBQUk7RUFDakM7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFFRDs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsaUJBQ2QsV0FBbUIsRUFDbkIsVUFBa0I7RUFFbEIsTUFBTSxZQUFZLFdBQ2YsV0FBVyxHQUNYLE9BQU8sQ0FBQyxjQUFjLEtBQ3RCLE9BQU8sQ0FBQyxVQUFVLEtBQ2xCLE9BQU8sQ0FBQyxNQUFNLElBQ2QsT0FBTyxDQUFDLE1BQU0sSUFDZCxLQUFLLENBQUMsR0FBRyxJQUNULE9BQU8sQ0FBQyxNQUFNO0VBQ2pCLE9BQU8sQ0FBQyxNQUFNLEVBQUUsWUFBWSxDQUFDLEVBQUUsV0FBVztBQUM1QztBQUVBOzs7OztDQUtDLEdB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
// denoCacheMetadata=3386961389439335994,7319055947008410356