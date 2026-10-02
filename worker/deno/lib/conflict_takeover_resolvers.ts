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
import { updatePrBranch } from "./git_pull.ts";
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

  await run(buildFetchTrackingRefArgs("origin", pr.headRefName));
  await run(buildFetchTrackingRefArgs("origin", pr.baseRefName));

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
    detail: `merge of '${pr.baseRefName}' into '${fixBranch}' conflicted: ${
      describeResult(merged)
    }`,
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
      // SIMPLE-ON-PURPOSE: mechanical merge only, no agent — upgrade when
      // takeovers of genuine conflicts need the resolution agent. This
      // settles a stale CONFLICTING verdict or a clean merge; a genuine
      // conflict comes back unresolved and the takeover records a failed
      // attempt.
      const result = await updateBranch(
        pr.headRefName,
        pr.baseRefName,
        { cwd },
        "conflicting",
      );
      return {
        resolved: result.ok,
        detail: result.ok ? result.value : result.error.message,
      };
    },
    resolveOnFixBranch: (pr, fixBranch) =>
      resolveOnFixBranch(pr, fixBranch, deps.checkout, runGit),
  };
}
