/**
 * One in-run agent rebase-and-fix pass, for the branch whose pre-PR rebase
 * declined (Issue #2459).
 *
 * `ensureBranchCurrent` in `branch_currency.ts` is deliberately not a
 * merge-conflict resolver: when content has genuinely diverged it declines and
 * leaves the branch alone. Before this module the PR was then raised on the
 * stale head, armed, and sat unmergeable until the conflict ladder found it
 * hours later.
 *
 * This module spends exactly one agent pass trying to close that gap, and is
 * strict about what "success" means:
 *
 * - The pass runs once. There is no retry loop, no `sleep` and no polling.
 * - It is skipped entirely when the cycle deadline leaves no runway for it, or
 *   when the branch tip cannot be read — a branch that cannot be restored is
 *   worse than an extra CI run.
 * - Success is re-measured with `measureBranchDrift`, never taken on the
 *   agent's word. Anything short of `behind === 0` is a failure.
 * - Every failure restores the pre-attempt tip and hands the PR to the conflict
 *   ladder (`pr_merge_conflict_processor.ts`) with one comment naming the
 *   conflicting paths. The PR is still raised either way.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { type GitRunner, measureBranchDrift } from "./branch_currency.ts";

/** Below this much runway the pass cannot finish, so it is never started. */
export const MIN_REBASE_PASS_RUNWAY_SECONDS = 180;

/** Conflicting paths named in the comment, before it is truncated. */
const MAX_NAMED_CONFLICT_PATHS = 20;

/** What the agent is asked to do: rebase `branch` onto `baseRef`, once. */
export interface AgentRebaseRequest {
  branch: string;
  baseRef: string;
  /** Why the ordinary rebase declined — the conflict the agent must resolve. */
  detail: string;
  /** Cycle deadline the pass must finish inside, when one is set. */
  deadlineEpochMs?: number;
  /** Seconds left until that deadline, for the agent's own timeout. */
  budgetSeconds?: number;
}

export type AgentRebaseFn = (
  request: AgentRebaseRequest,
) => Promise<Result<unknown>>;

/**
 * The one prompt the pass sends. Deliberately narrow: rebase this branch onto
 * this base, resolve the conflicts, stop. The caller re-measures the drift
 * afterwards, so the agent is never trusted to report its own success.
 */
export function buildRebasePassPrompt(request: AgentRebaseRequest): string {
  const budget = request.budgetSeconds === undefined
    ? ""
    : `\nYou have about ${request.budgetSeconds} seconds. If you cannot finish ` +
      `in that time, run \`git rebase --abort\` and stop.\n`;
  return [
    `Rebase the local branch \`${request.branch}\` onto \`${request.baseRef}\` ` +
    `and resolve the merge conflicts.`,
    "",
    `The automatic rebase declined: ${request.detail}`,
    budget,
    "Rules:",
    `- Run \`git rebase ${request.baseRef}\` on \`${request.branch}\`, resolve ` +
    `each conflict, \`git add\` the resolved files and \`git rebase --continue\`.`,
    "- Keep both sides' intent. Never discard the base's changes to win a " +
    "conflict, and never discard this branch's work.",
    "- Change nothing beyond what resolving the conflicts requires. Do not " +
    "refactor, reformat or add features.",
    "- Do not push, do not create or merge a pull request, and do not touch " +
    "any other branch.",
    `- If you cannot resolve a conflict correctly, run \`git rebase --abort\` ` +
    `and stop. A clean stop is better than a wrong resolution.`,
    "",
    "Finish with the branch checked out and the working tree clean.",
  ].join("\n");
}

export interface DeclinedRebasePassOptions {
  branch: string;
  baseBranch: string;
  /** The `declined` outcome's detail, carried into the agent prompt. */
  detail: string;
  runGit: GitRunner;
  cwd?: string;
  /** Seam: the single agent invocation. Tests pass a fake. */
  runAgentFn: AgentRebaseFn;
  deadlineEpochMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export type DeclinedRebasePassOutcome =
  /** The branch is level with its base; the PR is raised on the new head. */
  | { kind: "resolved"; detail: string }
  /** The branch is untouched; the conflict ladder owns the PR from here. */
  | {
    kind: "handed-off";
    detail: string;
    comment: string;
    conflictPaths: string[];
  };

/**
 * Spend one agent pass trying to rebase a declined branch onto its base.
 *
 * Never throws and never fails the caller: the PR is raised either way, so the
 * only question this answers is whether it is raised on a current head.
 */
export async function runDeclinedRebasePass(
  options: DeclinedRebasePassOptions,
): Promise<DeclinedRebasePassOutcome> {
  const { branch, baseBranch, detail, runGit, cwd, runAgentFn } = options;
  const log = options.log ?? (() => {});
  const baseRef = `origin/${baseBranch}`;

  const handOff = async (
    reason: string,
  ): Promise<DeclinedRebasePassOutcome> => {
    const conflictPaths = await findBothSidesPaths(
      branch,
      baseRef,
      runGit,
      cwd,
    );
    return {
      kind: "handed-off",
      detail: reason,
      comment: buildBranchConflictComment(
        branch,
        baseRef,
        reason,
        conflictPaths,
      ),
      conflictPaths,
    };
  };

  // Nothing to restore to means nothing to risk the branch on.
  const tip = await gitStdout(
    runGit,
    ["rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`],
    cwd,
  );
  if (tip === null) {
    return await handOff(
      `the tip of '${branch}' could not be read, so no rebase pass was attempted: ${detail}`,
    );
  }

  // A pass that cannot finish before the deadline is not worth starting.
  const budgetSeconds = remainingSeconds(options);
  if (
    budgetSeconds !== undefined &&
    budgetSeconds < MIN_REBASE_PASS_RUNWAY_SECONDS
  ) {
    return await handOff(
      `the cycle deadline left ${budgetSeconds}s, below the ` +
        `${MIN_REBASE_PASS_RUNWAY_SECONDS}s a rebase pass needs, so none was attempted: ${detail}`,
    );
  }

  log(
    `'${branch}' declined its pre-PR rebase — spending one agent pass to bring it onto '${baseRef}'`,
  );
  const attempt = await runAgentFn({
    branch,
    baseRef,
    detail,
    deadlineEpochMs: options.deadlineEpochMs,
    budgetSeconds,
  });

  if (!attempt.ok) {
    await restoreTip(runGit, branch, tip, cwd);
    return await handOff(
      `the rebase pass for '${branch}' failed and the branch was restored: ${attempt.error.message}`,
    );
  }

  // Measured, not claimed: only a level branch counts as resolved.
  const drift = await measureBranchDrift(branch, baseRef, runGit, cwd);
  if (!drift.ok) {
    await restoreTip(runGit, branch, tip, cwd);
    return await handOff(
      `'${branch}' could not be re-measured after its rebase pass and was restored: ${drift.error.message}`,
    );
  }
  if (drift.value.behind !== 0) {
    await restoreTip(runGit, branch, tip, cwd);
    return await handOff(
      `the rebase pass left '${branch}' ${drift.value.behind} commit(s) behind ` +
        `'${baseRef}', so the branch was restored`,
    );
  }

  log(`'${branch}' was brought onto '${baseRef}' by one agent rebase pass`);
  return {
    kind: "resolved",
    detail:
      `'${branch}' is level with '${baseRef}' after one agent rebase pass`,
  };
}

export interface BranchConflictCommentPost {
  repo: string;
  prNumber: number;
  /** The hand-off comment, or null when there is nothing to say. */
  comment: string | null;
  postComment: (
    repo: string,
    prNumber: number,
    body: string,
  ) => Promise<unknown>;
  warn?: (message: string) => void;
}

/**
 * Post the hand-off comment, exactly once, on the PR that was just raised.
 *
 * Best-effort: a failed post warns rather than failing the run, because the PR
 * itself is already the thing that matters.
 *
 * @returns true when a comment was posted.
 */
export async function postBranchConflictComment(
  options: BranchConflictCommentPost,
): Promise<boolean> {
  const { repo, prNumber, comment, postComment } = options;
  if (comment === null || comment.length === 0 || prNumber <= 0) return false;
  try {
    await postComment(repo, prNumber, comment);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.warn?.(
      `The branch-conflict comment on ${repo}#${prNumber} could not be posted (non-fatal): ${message}`,
    );
    return false;
  }
}

/** Seconds left until the deadline, or undefined when none is set. */
function remainingSeconds(
  options: DeclinedRebasePassOptions,
): number | undefined {
  if (options.deadlineEpochMs === undefined) return undefined;
  const now = (options.now ?? Date.now)();
  return Math.floor((options.deadlineEpochMs - now) / 1000);
}

/** Put the branch back exactly where it was before the pass touched it. */
async function restoreTip(
  runGit: GitRunner,
  branch: string,
  tip: string,
  cwd?: string,
): Promise<void> {
  const opts = cwd === undefined ? undefined : { cwd };
  // SIMPLE-ON-PURPOSE: exit codes ignored — whichever operation the agent left
  // in flight, only one of these four abort calls applies and the rest fail
  // harmlessly — upgrade when a caller needs to know which state was aborted.
  await runGit(["rebase", "--abort"], opts);
  await runGit(["cherry-pick", "--abort"], opts);
  await runGit(["merge", "--abort"], opts);
  await runGit(["checkout", "--end-of-options", branch], opts);
  await runGit(["reset", "--hard", "--end-of-options", tip], opts);
}

/**
 * Paths changed on both sides since the branch and base diverged — the files a
 * human or the conflict ladder will have to reconcile.
 *
 * Git will not name the conflicting paths without re-running the merge, which
 * would dirty the tree we have just restored, so this reports the honest
 * superset instead.
 */
async function findBothSidesPaths(
  branch: string,
  baseRef: string,
  runGit: GitRunner,
  cwd?: string,
): Promise<string[]> {
  const ours = await gitStdout(
    runGit,
    ["diff", "--name-only", "--end-of-options", `${baseRef}...${branch}`],
    cwd,
  );
  const theirs = await gitStdout(
    runGit,
    ["diff", "--name-only", "--end-of-options", `${branch}...${baseRef}`],
    cwd,
  );
  if (ours === null || theirs === null) return [];
  const baseSide = new Set(splitPaths(theirs));
  return splitPaths(ours).filter((p) => baseSide.has(p)).sort();
}

function splitPaths(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  );
}

/** One git read, as trimmed stdout, or null when it failed. */
async function gitStdout(
  runGit: GitRunner,
  args: string[],
  cwd?: string,
): Promise<string | null> {
  const result = await runGit(args, cwd === undefined ? undefined : { cwd });
  return result.ok ? result.value.stdout.trim() : null;
}

/** The single comment left on a PR raised behind its base. */
export function buildBranchConflictComment(
  branch: string,
  baseRef: string,
  reason: string,
  conflictPaths: string[],
): string {
  const lines = [
    `### This PR was raised behind \`${baseRef}\``,
    "",
    `\`${branch}\` could not be brought forward before the PR was raised, so ` +
    `the PR is on the branch exactly as it stands.`,
    "",
    reason,
    "",
  ];

  if (conflictPaths.length > 0) {
    const named = conflictPaths.slice(0, MAX_NAMED_CONFLICT_PATHS);
    lines.push("Changed on both sides since the branch and base diverged:", "");
    for (const path of named) lines.push(`- \`${path}\``);
    const hidden = conflictPaths.length - named.length;
    if (hidden > 0) lines.push(`- …and ${hidden} more`);
    lines.push("");
  }

  lines.push(
    "The merge-conflict ladder owns this PR from here — it will rebase and " +
      "re-arm it. No action is needed on the branch.",
  );
  return lines.join("\n");
}
