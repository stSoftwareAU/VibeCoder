/**
 * Production bindings for the conflict takeover's two resolvers (Issue #3001).
 *
 * {@link runConflictTakeover} in conflict_takeover.ts calls two injected
 * resolvers — `resolveViaLadder` for an ordinary (non-gated) head and
 * `resolveOnFixBranch` for a gated `milestone/**` head — and owns the
 * attempt/conclusion markers itself, so neither binding here may post a PR
 * comment of its own (a second marker pair would spend two units of the
 * shared budget for one takeover).
 *
 * `resolveOnFixBranch` never pushes or checks out the PR's own head: a
 * ruleset-gated `milestone/**` branch refuses a direct push, so the fix
 * lands on a side branch that the takeover then delivers through a pull
 * request.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { type GitCommandOutput, runGitCommand } from "./git_timeout.ts";
import { isPrBranchConflictError, updatePrBranch } from "./git_pull.ts";
import {
  climbConflictLadder,
  listUnmergedPaths,
  type MilestoneConflictAgentRequest,
} from "./milestone_conflict_ladder.ts";
import type { MergeConflictAgentOutcome } from "./merge_conflict_agent.ts";
import {
  assertSafeGitRef,
  buildCheckoutResetBranchArgs,
  buildFetchTrackingRefArgs,
  buildPushArgs,
} from "./git_ref_args.ts";
import { isConflictHeadSha } from "./merge_conflict_markers.ts";
import type {
  ConflictTakeoverDeps,
  ConflictTakeoverPr,
  TakeoverResolution,
} from "./conflict_takeover.ts";

/** Injected seams {@link bindConflictTakeoverResolvers} needs. */
export interface ConflictTakeoverResolverDeps {
  /** Prepare the repo's shared clone and return its directory; throws on failure. */
  checkout: (repo: string) => Promise<string>;
  /** Defaults to `updatePrBranch` from git_pull.ts. */
  updateBranch?: typeof updatePrBranch;
  /** Defaults to `runGitCommand` from git_timeout.ts. */
  runGit?: typeof runGitCommand;
  /**
   * The marker-free resolution agent. Called only after a merge conflicts.
   * Absent, a conflict is aborted and reported unresolved — the takeover
   * still owns the attempt markers, so this must not post any.
   */
  agentFn?: (
    request: MilestoneConflictAgentRequest & { repo: string },
  ) => Promise<Result<MergeConflictAgentOutcome>>;
}

/** Git's own stdout/stderr for a failed command, or the spawn error's message. */
function describeResult(result: Result<GitCommandOutput>): string {
  if (!result.ok) return result.error.message;
  const { code, stdout, stderr } = result.value;
  const text = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
  return text || `git exited ${code}`;
}

/**
 * Resolve a gated head on a side `fixBranch`, never touching the PR's own
 * head branch.
 */
async function resolveOnFixBranch(
  pr: ConflictTakeoverPr,
  fixBranch: string,
  checkout: ConflictTakeoverResolverDeps["checkout"],
  runGit: typeof runGitCommand,
  agentFn: ConflictTakeoverResolverDeps["agentFn"],
): Promise<TakeoverResolution> {
  assertSafeGitRef(fixBranch, "fix branch name");
  assertSafeGitRef(pr.headRefName, "PR head branch name");
  assertSafeGitRef(pr.baseRefName, "PR base branch name");
  const headSha = pr.headSha.trim().toLowerCase();
  if (!isConflictHeadSha(headSha)) {
    throw new Error(
      `resolveOnFixBranch: '${pr.headSha}' is not a usable head sha for ` +
        `${pr.repo}#${pr.number}`,
    );
  }

  const cwd = await checkout(pr.repo);
  const run = (args: string[]) => runGit(args, { cwd });

  const headFetch = await run(
    buildFetchTrackingRefArgs("origin", pr.headRefName),
  );
  if (!headFetch.ok || headFetch.value.code !== 0) {
    return {
      resolved: false,
      detail: `could not fetch '${pr.headRefName}' from origin: ${
        describeResult(headFetch)
      }`,
    };
  }
  const baseFetch = await run(
    buildFetchTrackingRefArgs("origin", pr.baseRefName),
  );
  if (!baseFetch.ok || baseFetch.value.code !== 0) {
    return {
      resolved: false,
      detail: `could not fetch '${pr.baseRefName}' from origin: ${
        describeResult(baseFetch)
      }`,
    };
  }

  const reset = await run(buildCheckoutResetBranchArgs(fixBranch, headSha));
  if (!reset.ok || reset.value.code !== 0) {
    return {
      resolved: false,
      detail: `could not create '${fixBranch}' at ${headSha}: ${
        describeResult(reset)
      }`,
    };
  }

  const merged = await run([
    "merge",
    "--no-edit",
    "--end-of-options",
    `refs/remotes/origin/${pr.baseRefName}`,
  ]);
  let conflictDetail =
    `merge of '${pr.baseRefName}' into '${fixBranch}' conflicted: ${
      describeResult(merged)
    }`;
  if (!(merged.ok && merged.value.code === 0) && agentFn) {
    const finished = await finishConflictedMerge(
      cwd,
      pr,
      fixBranch,
      run,
      agentFn,
    );
    if (!finished.resolved) conflictDetail = finished.detail;
    if (finished.resolved) {
      const pushed = await run(buildPushArgs("origin", fixBranch));
      if (!pushed.ok || pushed.value.code !== 0) {
        return {
          resolved: false,
          detail: `'${fixBranch}' resolved '${pr.baseRefName}' but the ` +
            `push failed: ${describeResult(pushed)}`,
        };
      }
      return {
        resolved: true,
        detail: `resolved the conflict on '${fixBranch}' from head ` +
          `${headSha.slice(0, 12)} with the agent and pushed it`,
      };
    }
  }
  if (merged.ok && merged.value.code === 0) {
    const pushed = await run(buildPushArgs("origin", fixBranch));
    if (!pushed.ok || pushed.value.code !== 0) {
      return {
        resolved: false,
        detail: `'${fixBranch}' merged '${pr.baseRefName}' cleanly but the ` +
          `push failed: ${describeResult(pushed)}`,
      };
    }
    return {
      resolved: true,
      detail: `merged '${pr.baseRefName}' into '${fixBranch}' from head ` +
        `${headSha.slice(0, 12)} and pushed it`,
    };
  }

  // Abort only a merge git actually started (mirrors mergeBaseIntoBranch in
  // git_pull.ts) — a half-merged tree is not "left exactly as it was".
  const merging = await run([
    "rev-parse",
    "--verify",
    "--quiet",
    "MERGE_HEAD",
  ]);
  if (merging.ok && merging.value.code === 0) {
    const aborted = await run(["merge", "--abort"]);
    if (!aborted.ok || aborted.value.code !== 0) {
      throw new Error(
        `resolveOnFixBranch(${pr.repo}#${pr.number}): merge of ` +
          `'${pr.baseRefName}' into '${fixBranch}' failed and ` +
          `'git merge --abort' failed too: ${describeResult(aborted)}`,
      );
    }
  }
  return {
    resolved: false,
    detail: conflictDetail,
  };
}

/**
 * Bind the conflict takeover's two resolvers to real git (Issue #3001).
 *
 * Neither binding posts a PR comment — the takeover owns the
 * attempt/conclusion markers.
 */
export function bindConflictTakeoverResolvers(
  deps: ConflictTakeoverResolverDeps,
): Pick<ConflictTakeoverDeps, "resolveViaLadder" | "resolveOnFixBranch"> {
  const updateBranch = deps.updateBranch ?? updatePrBranch;
  const runGit = deps.runGit ?? runGitCommand;

  return {
    resolveViaLadder: async (pr) => {
      const cwd = await deps.checkout(pr.repo);
      const result = await updateBranch(
        pr.headRefName,
        pr.baseRefName,
        { cwd },
        "conflicting",
      );
      if (result.ok) {
        return { resolved: true, detail: result.value };
      }
      // A plain merge aborts a conflict and leaves the branch untouched.
      // Merge again and let the same agent the processor uses finish it,
      // still without posting a marker.
      if (!deps.agentFn || !isPrBranchConflictError(result.error)) {
        return { resolved: false, detail: result.error.message };
      }
      const run = (args: string[]) => runGit(args, { cwd });
      const merged = await run([
        "merge",
        "--no-edit",
        "--end-of-options",
        `refs/remotes/origin/${pr.baseRefName}`,
      ]);
      if (merged.ok && merged.value.code === 0) {
        return await pushResolved(run, pr.headRefName, result.error.message);
      }
      const finished = await finishConflictedMerge(
        cwd,
        pr,
        pr.headRefName,
        run,
        deps.agentFn,
      );
      if (!finished.resolved) {
        await abortMergeIfStarted(run, pr, pr.headRefName);
        return { resolved: false, detail: finished.detail };
      }
      return await pushResolved(
        run,
        pr.headRefName,
        `resolved the conflict on '${pr.headRefName}' with the agent`,
      );
    },
    resolveOnFixBranch: (pr, fixBranch) =>
      resolveOnFixBranch(pr, fixBranch, deps.checkout, runGit, deps.agentFn),
  };
}

/** Push a branch that already holds the resolved merge. */
async function pushResolved(
  run: (args: string[]) => Promise<Result<GitCommandOutput>>,
  branch: string,
  detail: string,
): Promise<TakeoverResolution> {
  const pushed = await run(buildPushArgs("origin", branch));
  if (!pushed.ok || pushed.value.code !== 0) {
    return {
      resolved: false,
      detail: `'${branch}' resolved but the push failed: ${
        describeResult(pushed)
      }`,
    };
  }
  return { resolved: true, detail };
}

/** Abort a merge git actually started. Throws when the abort itself fails. */
async function abortMergeIfStarted(
  run: (args: string[]) => Promise<Result<GitCommandOutput>>,
  pr: ConflictTakeoverPr,
  branch: string,
): Promise<void> {
  const merging = await run([
    "rev-parse",
    "--verify",
    "--quiet",
    "MERGE_HEAD",
  ]);
  if (!(merging.ok && merging.value.code === 0)) return;
  const aborted = await run(["merge", "--abort"]);
  if (!aborted.ok || aborted.value.code !== 0) {
    throw new Error(
      `resolve merge of '${pr.baseRefName}' into '${branch}' failed and ` +
        `'git merge --abort' failed too: ${describeResult(aborted)}`,
    );
  }
}

/**
 * Hand a conflicted merge to the rules-then-agent ladder and commit it.
 * Posts nothing. The caller pushes, or aborts when this returns unresolved.
 */
async function finishConflictedMerge(
  cwd: string,
  pr: ConflictTakeoverPr,
  intoBranch: string,
  run: (args: string[]) => Promise<Result<GitCommandOutput>>,
  agentFn: NonNullable<ConflictTakeoverResolverDeps["agentFn"]>,
): Promise<TakeoverResolution> {
  const unmerged = await listUnmergedPaths({ cwd });
  if (!unmerged.ok) {
    return {
      resolved: false,
      detail:
        `merge of '${pr.baseRefName}' into '${intoBranch}' conflicted: ${unmerged.error.message}`,
    };
  }
  const ladder = await climbConflictLadder({
    escalations: unmerged.value.map((path) => ({
      path,
      case: "rival-designs" as const,
      action: "escalate" as const,
      reason: "both sides changed the file",
    })),
    options: { cwd },
    milestoneBranch: intoBranch,
    defaultBranch: pr.baseRefName,
    agentFn: (request) => agentFn({ ...request, repo: pr.repo }),
  });
  if (ladder.escalations.length > 0) {
    const why = ladder.escalations
      .map((file) => `${file.path}: ${file.reason}`)
      .join("; ");
    return {
      resolved: false,
      detail:
        `merge of '${pr.baseRefName}' into '${intoBranch}' conflicted: ${why}`,
    };
  }
  const committed = await run(["commit", "--no-edit"]);
  if (!committed.ok || committed.value.code !== 0) {
    return {
      resolved: false,
      detail:
        `merge of '${pr.baseRefName}' into '${intoBranch}' conflicted: could not commit the resolved merge: ${
          describeResult(committed)
        }`,
    };
  }
  return {
    resolved: true,
    detail: `resolved the conflict on '${intoBranch}'`,
  };
}
