/**
 * Adopt an agent-raised PR on the run's own branch (Issue #3804).
 *
 * The implementing agent may raise its own PR with `gh pr create`, so the
 * body carries no worker marker and {@link syncPrBodyFromSummary} would skip
 * it forever. At every exit of the completion phase this adopts that PR: it
 * rebuilds the body with the marker, digest and withheld close, so later
 * fix-run syncs have a marker and digest to work from.
 *
 * Only a PR whose head is this run's own worker issue branch, with this
 * checkout's HEAD equal to the pushed head, is adopted. Nothing here throws to
 * the caller.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { runGitCommand as runGitCommandType } from "./git_timeout.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
import { runPrBodySync, syncPrBodyFromSummary } from "./pr_body_sync.ts";
import type { SyncFollowUpFiling } from "./pr_body_sync_follow_up.ts";
import { prNumberFromUrl } from "./run_outcome.ts";

/** Inputs for {@link adoptAgentRaisedPrBody}. */
export interface AdoptAgentPrInput {
  /** `owner/repo`. */
  repo: string;
  /** The branch this run works on. */
  branchName: string;
  /** Checkout the run pushed from. */
  repoPath: string;
  /** Configured worker name (may be empty). */
  workerName: string;
  /** GitHub username used as the footer fallback. */
  githubUser: string;
  /** Canonical run id for this worker invocation. */
  runId?: string;
}

/** Collaborators {@link adoptAgentRaisedPrBody} needs — all injectable for testing. */
export interface AdoptAgentPrDeps {
  findExistingPrForBranch: (
    repo: string,
    branch: string,
  ) => Promise<Result<string>>;
  /** Runs a `gh` command; throws on a non-zero exit. */
  runGhCommand: (args: string[]) => Promise<string>;
  runGitCommand: typeof runGitCommandType;
  logger: Logger;
  /** Records any newly reported gap through the shared, content-verified filer. */
  followUpFiling: SyncFollowUpFiling | undefined;
}

/**
 * Adopt the agent-raised PR on this run's branch, if there is one.
 *
 * Cheap local checks run first. The PR body is refreshed only when this
 * checkout's HEAD is the pushed head: a local summary not yet on the remote
 * must never describe the PR. Any fault is logged and swallowed.
 *
 * @param syncFn Injected for tests; defaults to {@link syncPrBodyFromSummary}.
 */
export async function adoptAgentRaisedPrBody(
  input: AdoptAgentPrInput,
  deps: AdoptAgentPrDeps,
  syncFn: typeof syncPrBodyFromSummary = syncPrBodyFromSummary,
): Promise<void> {
  const { logger } = deps;
  try {
    if (issueNumberFromBranch(input.branchName) === null) {
      logger.info(
        "Not adopting an agent-raised PR: not a worker issue branch",
        {
          repo: input.repo,
          branch: input.branchName,
        },
      );
      return;
    }
    if (input.repoPath.trim().length === 0) {
      logger.info("Not adopting an agent-raised PR: no checkout path", {
        repo: input.repo,
        branch: input.branchName,
      });
      return;
    }

    const localHead = await deps.runGitCommand(["rev-parse", "HEAD"], {
      cwd: input.repoPath,
    });
    const remoteHead = await deps.runGitCommand(
      ["ls-remote", "origin", `refs/heads/${input.branchName}`],
      { cwd: input.repoPath },
    );
    const head = localHead.ok && localHead.value.code === 0
      ? localHead.value.stdout.trim()
      : "";
    const pushed = remoteHead.ok && remoteHead.value.code === 0
      ? (remoteHead.value.stdout.trim().split(/\s+/)[0] ?? "")
      : "";
    if (head === "" || pushed !== head) {
      logger.info(
        "Not adopting an agent-raised PR: this checkout's HEAD is not the pushed head",
        {
          repo: input.repo,
          branch: input.branchName,
          head,
          pushed,
        },
      );
      return;
    }

    const existing = await deps.findExistingPrForBranch(
      input.repo,
      input.branchName,
    );
    if (!existing.ok) {
      logger.info(
        "Not adopting an agent-raised PR: no open PR on this branch",
        {
          repo: input.repo,
          branch: input.branchName,
          lookup: existing.error.message,
        },
      );
      return;
    }
    const prNumber = prNumberFromUrl(existing.value);
    if (prNumber <= 0) {
      logger.warn(
        "Not adopting an agent-raised PR: could not read a PR number from its URL",
        {
          repo: input.repo,
          branch: input.branchName,
          prUrl: existing.value,
        },
      );
      return;
    }

    await runPrBodySync(
      {
        repo: input.repo,
        prNumber,
        repoPath: input.repoPath,
        beforeSha: undefined,
        workerName: input.workerName,
        githubUser: input.githubUser,
        runId: input.runId,
        branchName: input.branchName,
        adoptOnly: true,
      },
      {
        runGhCommand: deps.runGhCommand,
        runGitCommand: deps.runGitCommand,
        logger,
        followUpFiling: deps.followUpFiling,
      },
      syncFn,
    );
  } catch (err) {
    logger.warn("Could not adopt the agent-raised PR body (Issue #3804)", {
      repo: input.repo,
      branch: input.branchName,
      error: (err as Error).message,
    });
  }
}
