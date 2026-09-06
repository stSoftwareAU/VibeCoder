/**
 * Git branch creation, checkout, and deletion (Issue #912).
 *
 * Provides functions for creating sanitised branch names, checking if branches
 * are protected, and managing feature/milestone branches.
 *
 * Migrated from worker/shared/git_operations.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions, GitCommandOutput } from "./git_timeout.ts";
import {
  buildCheckoutResetBranchArgs,
  buildFetchArgs,
  buildPushCreateBranchArgs,
} from "./git_ref_args.ts";
import {
  describeLocalMilestoneBranch,
  inspectLocalMilestoneBranch,
} from "./milestone_local_branch.ts";

/** Protected branch names (case-insensitive). */
const PROTECTED_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "release",
  "production",
  "staging",
]);

/**
 * Create a sanitised branch name from an issue number and title.
 *
 * @param issueNumber - The issue number
 * @param issueTitle - The issue title
 * @returns Sanitised branch name (e.g., "issue-42-fix-login-bug")
 */
export function createBranchName(
  issueNumber: number,
  issueTitle: string,
): string {
  const sanitised = issueTitle
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "")
    .slice(0, 50)
    .replace(/-$/, "");
  return `issue-${issueNumber}-${sanitised}`;
}

/**
 * Create a sanitised branch name from a milestone title.
 *
 * @param milestoneTitle - The milestone title (e.g., "OIDC Authentication")
 * @returns Sanitised branch name (e.g., "milestone/oidc-authentication")
 */
export function createMilestoneBranchName(milestoneTitle: string): string {
  const sanitised = milestoneTitle
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "")
    .slice(0, 50)
    .replace(/-$/, "");
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
 */
export function isProtectedBranch(branchName: string): boolean {
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
 * Create a feature branch from a specified base branch (Issue #476, #1501).
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
 * @param branchName - The feature branch name to create
 * @param baseBranch - The branch to create from (e.g., "main" or "milestone/oidc")
 * @param options - Git command options (cwd, etc.)
 * @returns Result indicating success, or failure naming git's own output
 */
export async function createFeatureBranchFromBase(
  branchName: string,
  baseBranch: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  // Fetch the latest upstream base branch before creating the feature branch
  // (Issue #1501). Non-fatal — if this fails we fall back to local refs.
  const fetchResult = await runGitCommand(
    buildFetchArgs("origin", baseBranch),
    options,
  );
  const fetchOk = fetchResult.ok && fetchResult.value.code === 0;

  if (!fetchOk) {
    const detail = fetchResult.ok
      ? fetchResult.value.stderr.trim() || `exit ${fetchResult.value.code}`
      : fetchResult.error.message;
    console.warn(
      `[git_branch] Warning: failed to fetch origin/${baseBranch} (${detail}); ` +
        `falling back to local ref`,
    );
  }

  // Start points in order of preference: the freshly fetched remote tip, the
  // local base ref (Issue #476), then the remote-tracking ref for a clone
  // that could not be fetched. Each is attempted with `checkout -B` so an
  // existing local branch — including the one HEAD is on — is reset rather
  // than collided with (Issue #356).
  const startPoints = fetchOk
    ? [`origin/${baseBranch}`, baseBranch]
    : [baseBranch, `origin/${baseBranch}`];

  const failures: string[] = [];
  for (const startPoint of startPoints) {
    const args = buildCheckoutResetBranchArgs(branchName, startPoint);
    const checkout = await runGitCommand(args, options);
    if (checkout.ok && checkout.value.code === 0) {
      return {
        ok: true,
        value: `Created feature branch '${branchName}' from '${startPoint}'`,
      };
    }
    failures.push(describeGitFailure(args, checkout));
  }

  // Fail loud with git's own words: the release comment for Issue #356 read
  // "could not be automatically determined" because they were discarded here.
  return {
    ok: false,
    error: new Error(
      `Failed to create feature branch '${branchName}' from '${baseBranch}': ` +
        failures.join("; "),
    ),
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
 */
export async function resumeFeatureBranchFromRemote(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<boolean>> {
  const fetchResult = await runGitCommand(
    buildFetchArgs("origin", branchName),
    options,
  );
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    return { ok: true, value: false };
  }

  // Replace any stale local branch. `checkout -B` create-or-resets, so a
  // leftover local ref — including one HEAD is already sitting on — is moved
  // onto the remote checkpoint rather than colliding with it (Issue #356);
  // `branch -D` cannot delete the checked-out branch, and the collision that
  // followed silently reported "no resumable work" over a pushed commit.
  const checkoutResult = await runGitCommand(
    buildCheckoutResetBranchArgs(branchName, `origin/${branchName}`),
    options,
  );
  return {
    ok: true,
    value: checkoutResult.ok && checkoutResult.value.code === 0,
  };
}

/** What {@link reconcileHeadToBranch} did. */
export interface HeadReconciliation {
  /**
   * `already-on-branch`: HEAD was the worker branch — nothing to do.
   * `fast-forwarded`: HEAD was elsewhere (another branch, or detached) and
   * the worker branch was an ancestor, so the worker branch was moved to
   * HEAD (`git checkout -B`), keeping the working tree.
   */
  action: "already-on-branch" | "fast-forwarded";
  /** Where HEAD was before: a branch name, or `HEAD` when detached. */
  fromRef: string;
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
 */
export async function reconcileHeadToBranch(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<HeadReconciliation>> {
  const headResult = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    options,
  );
  if (!headResult.ok || headResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Cannot resolve HEAD before pushing '${branchName}': ` +
          describeGitFailure(["rev-parse", "--abbrev-ref", "HEAD"], headResult),
      ),
    };
  }
  const head = headResult.value.stdout.trim();
  if (head === branchName) {
    return { ok: true, value: { action: "already-on-branch", fromRef: head } };
  }

  // Is the worker branch an ancestor of HEAD? Exit 0 = yes, 1 = no.
  const ancestor = await runGitCommand(
    ["merge-base", "--is-ancestor", branchName, "HEAD"],
    options,
  );
  if (!ancestor.ok) {
    return { ok: false, error: ancestor.error };
  }
  if (ancestor.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `HEAD is on '${head}' and the worker branch '${branchName}' has ` +
          `diverged from it — the agent committed on a branch of its own and ` +
          `the two histories do not fast-forward. Refusing to move either ` +
          `ref; a human must reconcile them (Issue #4286).`,
      ),
    };
  }

  // Fast-forward the worker branch to HEAD and check it out, keeping the
  // working tree exactly as the agent left it.
  const move = await runGitCommand(
    buildCheckoutResetBranchArgs(branchName),
    options,
  );
  if (!move.ok || move.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Could not move '${branchName}' to HEAD ('${head}'): ` +
          describeGitFailure(buildCheckoutResetBranchArgs(branchName), move),
      ),
    };
  }
  return { ok: true, value: { action: "fast-forwarded", fromRef: head } };
}

/**
 * Describe a git command outcome for a failure message (Issue #3910).
 *
 * Collapsing distinct git failures into one opaque message hides the
 * reason a milestone branch could not be created (branch protection,
 * non-fast-forward, auth). Keep the command and its stderr so the
 * handoff comment names the actual cause.
 */
function describeGitFailure(
  args: readonly string[],
  result: Result<GitCommandOutput>,
): string {
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
 */
export async function ensureMilestoneBranchExists(
  milestoneBranch: string,
  defaultBranch: string,
  options: GitCommandOptions = {},
  ensureDefaultBranchCurrentFn?: (
    defaultBranch: string,
    options: GitCommandOptions,
  ) => Promise<Result<string>>,
): Promise<Result<string>> {
  // Diagnostics accumulated along the way — a fetch failure is not fatal
  // on its own (the branch may not exist yet), but it explains a later
  // create/push failure (Issue #3910).
  const diagnostics: string[] = [];

  // Fetch to check remote state
  const fetchArgs = ["fetch", "origin", milestoneBranch];
  const fetchResult = await runGitCommand(fetchArgs, options);
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    diagnostics.push(describeGitFailure(fetchArgs, fetchResult));
  }

  const showRefResult = await runGitCommand(
    [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${milestoneBranch}`,
    ],
    options,
  );

  if (showRefResult.ok && showRefResult.value.code === 0) {
    return {
      ok: true,
      value: `Milestone branch ${milestoneBranch} already exists on remote`,
    };
  }

  // Ensure the default branch is current before creating
  if (ensureDefaultBranchCurrentFn) {
    await ensureDefaultBranchCurrentFn(defaultBranch, options);
  }

  // Refresh the default branch's remote-tracking ref so the branch is created
  // at the remote's own tip. Non-fatal on its own — the local ref is the
  // fallback below — but it explains a later push failure (Issue #3910).
  const defaultFetchArgs = buildFetchArgs("origin", defaultBranch);
  const defaultFetch = await runGitCommand(defaultFetchArgs, options);
  const defaultFetchOk = defaultFetch.ok && defaultFetch.value.code === 0;
  if (!defaultFetchOk) {
    diagnostics.push(describeGitFailure(defaultFetchArgs, defaultFetch));
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
  const sourceRefs = defaultFetchOk
    ? [`origin/${defaultBranch}`, defaultBranch]
    : [defaultBranch, `origin/${defaultBranch}`];

  for (const sourceRef of sourceRefs) {
    const pushArgs = buildPushCreateBranchArgs(
      "origin",
      sourceRef,
      milestoneBranch,
    );
    const pushResult = await runGitCommand(pushArgs, options);
    if (!pushResult.ok || pushResult.value.code !== 0) {
      diagnostics.push(describeGitFailure(pushArgs, pushResult));
      continue;
    }

    // Nothing local was touched. Say so once, naming the checkout that used
    // to block the creation, so an operator can find it without the run
    // having deleted or reset anyone's work (Issue #1345).
    const local = await inspectLocalMilestoneBranch(milestoneBranch, options);
    if (local) {
      console.warn(
        `[git_branch] ${describeLocalMilestoneBranch(local, sourceRef)}`,
      );
    }

    return {
      ok: true,
      value: `Milestone branch ${milestoneBranch} created on origin from ` +
        `${sourceRef} (no local checkout)`,
    };
  }

  return {
    ok: false,
    error: new Error(
      `Failed to push milestone branch ${milestoneBranch} to origin from ` +
        `${defaultBranch}: ${diagnostics.join(" | ")}`,
    ),
  };
}
