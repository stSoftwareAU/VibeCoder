/**
 * Shared helpers for PR processors (Issue #1458).
 *
 * The CI fix, PR feedback, and spelling fix processors all need to:
 *   1. Fetch and check out the PR head branch before running Claude.
 *   2. Optionally read a `.pr_response_message` file that Claude may write
 *      to supply a custom PR comment body.
 *
 * These helpers were originally embedded in `pr_ci_processor.ts` as
 * `_checkoutPrBranch` / `_readResponseMessage`. Extracting them avoids
 * drift between the three processors and makes the behaviour uniformly
 * testable.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import type { GitDeps } from "./issue_worker_wiring.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Subset of GitDeps needed for branch preparation. */
export type BranchPreparationGitDeps = Pick<GitDeps, "runGitCommand">;

/** Outcome of {@link preparePrBranch} (Issue #4376). */
export type PreparePrBranchOutcome =
  | { ok: true }
  | {
    ok: false;
    /**
     * `branch_missing`: origin has no such ref — the PR merged/closed after
     * it was listed; `checkout_failed`: the branch could not be checked out,
     * so the working tree is not the PR's.
     */
    reason: "branch_missing" | "checkout_failed";
    detail: string;
  };

/** git's wording for a fetch of a ref that does not exist on the remote. */
const BRANCH_MISSING_RE =
  /couldn't find remote ref|couldn't find remote branch|not found in upstream|no such ref/i;

/** Dependencies required to prepare a PR branch. */
export interface PreparePrBranchDeps {
  logger: Logger;
  git: BranchPreparationGitDeps;
  /** Working directory for git commands (target repo checkout). */
  cwd: string | undefined;
}

/**
 * Fetch and check out the PR's head branch before running Claude (Issue #1455).
 *
 * Mirrors the shell `work_on_*` behaviours from `issue_worker.sh`: fetch
 * the branch from origin, check it out, and best-effort fast-forward to
 * the remote tip. Failures are logged as warnings but not fatal — Claude
 * will still run, and downstream push logic will surface any real
 * problems.
 *
 * @param branchName - The PR head branch name.
 * @param deps - Logger, git deps, and cwd.
 */
export async function preparePrBranch(
  branchName: string,
  deps: PreparePrBranchDeps,
): Promise<PreparePrBranchOutcome> {
  const { logger, git, cwd } = deps;

  const fetchResult = await git.runGitCommand(
    ["fetch", "origin", branchName],
    { cwd },
  );
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    const err = fetchResult.ok
      ? fetchResult.value.stderr.trim()
      : fetchResult.error.message;
    logger.warn("Failed to fetch PR branch", { branchName, error: err });
    // The branch no longer exists on origin (Issue #4376): the PR merged or
    // closed after it was listed. Working on would mean running the agent
    // on whatever is checked out and pushing a resurrected branch —
    // observed live as a fix PR raised for an already-merged PR.
    if (BRANCH_MISSING_RE.test(err)) {
      return { ok: false, reason: "branch_missing", detail: err };
    }
  }

  const checkoutResult = await git.runGitCommand(
    ["checkout", branchName],
    { cwd },
  );
  if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
    const err = checkoutResult.ok
      ? checkoutResult.value.stderr.trim()
      : checkoutResult.error.message;
    logger.warn("Failed to check out PR branch", { branchName, error: err });
    // Not on the PR branch: the agent must not run here (Issue #4376).
    return { ok: false, reason: "checkout_failed", detail: err };
  }

  // Best-effort pull to sync with the remote — harmless if already up to date.
  const pullResult = await git.runGitCommand(
    ["pull", "--ff-only", "origin", branchName],
    { cwd },
  );
  if (pullResult.ok && pullResult.value.code !== 0) {
    logger.debug("Pull --ff-only did not fast-forward", {
      branchName,
      stderr: pullResult.value.stderr.trim(),
    });
  }
  return { ok: true };
}

/**
 * Read and consume the `.pr_response_message` file if Claude created one.
 *
 * Claude writes a per-fix summary into this file; callers use it as the PR
 * comment body instead of a generic hardcoded message. The file is removed
 * after reading so stale content cannot leak into a subsequent run.
 *
 * Secret redaction (Issue #3202): the returned message is posted verbatim to a
 * public GitHub PR comment (both the PR-feedback and CI-fix processors read
 * through this chokepoint). Claude runs as a subprocess whose environment holds
 * live credentials (`ANTHROPIC_API_KEY`, a GitHub token) and unrestricted
 * `Bash`, so a prompt-injection payload could steer it to write a secret into
 * this file. Route the content through `redactSecrets()` here — the single
 * chokepoint for both PR sinks — mirroring the defence-in-depth redaction the
 * question/partial-answer path (`answer_sanitiser.ts`, #3195), the logger, and
 * the crash notifier already apply.
 *
 * @param workDir - Working directory where Claude runs.
 * @returns Trimmed, secret-redacted file contents, or `undefined` if the file
 *          is missing or empty.
 */
export async function readPrResponseMessage(
  workDir: string | undefined,
): Promise<string | undefined> {
  if (!workDir) return undefined;
  const path = `${workDir}/.pr_response_message`;
  try {
    const content = await Deno.readTextFile(path);
    // Remove the file so it cannot be reused on the next invocation.
    try {
      await Deno.remove(path);
    } catch {
      // Non-fatal — worst case the next run overwrites it.
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) return undefined;
    // Redact secrets before the message leaves for a public PR comment.
    return redactSecrets(trimmed);
  } catch {
    return undefined;
  }
}
