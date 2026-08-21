/**
 * Git push operations (Issue #912).
 *
 * Provides functions for pushing commits, detecting push rejections,
 * detecting existing PRs, and finding open PRs.
 *
 * Migrated from worker/shared/git_operations.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand, runGitCommandChecked } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { recoverFromPushRejection } from "./git_push_recovery.ts";
import { buildPushArgs } from "./git_ref_args.ts";
import { assertSafeToCommit } from "./pre_commit_safety.ts";
import { runPreFlightGate } from "./pre_flight_gate.ts";
import type { PreFlightRunner } from "./pre_flight_gate.ts";
import { getPreFlightCommands } from "./repo_config.ts";
import type { RepoConfig } from "../types.ts";
import { appendRunIdTrailer, assertRunIdTrailer, getRunId } from "./run_id.ts";
import { runGhOrThrow } from "./gh_spawn.ts";

/**
 * Pre-flight gate specification passed to {@link commitAndPushPending}
 * (Issue #3577). Omit (or pass empty `commands`) to disable the gate — the
 * repo then commits and pushes exactly as it does today with zero added
 * latency.
 */
export interface PreFlightGateSpec {
  /** Commands to run before the automated commit, in listed order. */
  commands: readonly string[];
  /** Per-command timeout in seconds (defaults to the gate's own default). */
  timeoutSeconds?: number;
  /** Injectable command runner (defaults to the real subprocess runner). */
  runner?: PreFlightRunner;
}

/**
 * Resolve a repo's pre-flight gate into a {@link PreFlightGateSpec}, or
 * `undefined` when the repo has no gate configured (Issue #3577).
 *
 * A convenience for the automated-commit call sites: pass the result straight
 * to {@link commitAndPushPending}. Returns `undefined` (not an empty spec) so
 * a repo with no entry runs exactly as it does today. Throws on malformed
 * config via `getPreFlightCommands` — but config is already validated at load
 * (Issue #3577), so this is defence in depth.
 */
export function resolvePreFlightSpec(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): PreFlightGateSpec | undefined {
  const commands = getPreFlightCommands(repoConfigs, repo);
  return commands.length > 0 ? { commands } : undefined;
}

/**
 * Detect non-fast-forward push rejection from push output (Issue #186).
 *
 * When a PR is raised, automated tasks (reformatting, CI checks, etc.) may push
 * commits to the remote branch. This detects the specific rejection so the worker
 * can recover automatically.
 *
 * @param pushOutput - The stderr/stdout from git push
 * @returns True if the push was rejected due to non-fast-forward
 */
export function detectPushRejection(pushOutput: string): boolean {
  if (!pushOutput) return false;
  return /\(fetch first\)|\(non-fast-forward\)/.test(pushOutput);
}

/**
 * Extract an existing PR URL from gh error output (Issue #184).
 *
 * When gh pr create fails because a PR already exists for the branch,
 * the error message includes the URL of the existing PR.
 *
 * @param errorOutput - The stderr/stdout from gh pr create
 * @returns The PR URL if found, or null
 */
export function detectExistingPr(errorOutput: string): string | null {
  if (!errorOutput) return null;
  if (!/already exists/i.test(errorOutput)) return null;

  const match = errorOutput.match(
    /https:\/\/github\.com\/[^\s]+\/pull\/\d+/,
  );
  return match ? match[0] : null;
}

/**
 * Find an open PR for a given branch (Issue #386).
 *
 * @param repo - Repository in "owner/repo" format
 * @param branchName - The head branch to search for
 * @param ghCommandFn - Injected gh command function (for testing)
 * @returns Result with the PR URL if found
 */
export async function findOpenPrForBranch(
  repo: string,
  branchName: string,
  ghCommandFn?: (args: string[]) => Promise<string>,
): Promise<Result<string | null>> {
  if (!branchName) {
    return { ok: true, value: null };
  }

  try {
    const runGh = ghCommandFn ?? defaultGhCommand;
    const output = await runGh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branchName,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ]);

    const prUrl = output.trim();
    return { ok: true, value: prUrl || null };
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `Failed to find open PR for branch '${branchName}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

/**
 * Recover gracefully when a PR already exists (Issue #184).
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number being worked on
 * @param prUrl - The URL of the existing PR
 * @param prBody - Optional updated PR body content to apply
 * @param ghCommandFn - Injected gh command function (for testing)
 * @returns Result indicating success
 */
export async function recoverExistingPr(
  repo: string,
  issueNumber: number,
  prUrl: string,
  prBody?: string,
  ghCommandFn?: (args: string[]) => Promise<string>,
): Promise<Result<string>> {
  if (!prUrl) {
    return { ok: false, error: new Error("Empty PR URL") };
  }

  const messages: string[] = [
    `SELF-HEALING: Found existing PR for issue #${issueNumber}: ${prUrl}`,
    "SELF-HEALING: A previous run likely created this PR before timing out",
  ];

  // Update the existing PR body with converted screenshot URLs (Issue #328)
  if (prBody) {
    const prNumber = prUrl.split("/").pop();
    try {
      const runGh = ghCommandFn ?? defaultGhCommand;
      await runGh([
        "pr",
        "edit",
        String(prNumber),
        "--repo",
        repo,
        "--body",
        prBody,
      ]);
      messages.push("SELF-HEALING: PR body updated successfully");
    } catch (err) {
      console.warn(
        `[git-push] Failed to update PR body for PR #${prNumber} in ${repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      messages.push("WARNING: Failed to update PR body (non-fatal)");
    }
  }

  messages.push(
    "SELF-HEALING: Treating as successful — no need to create a new PR",
  );

  return { ok: true, value: messages.join("\n") };
}

/**
 * Resolve the repository's default branch from the local clone (Issue #2584).
 *
 * Uses `git symbolic-ref refs/remotes/origin/HEAD` — the same local resolution
 * `setupRepo()` relies on — so the push guard needs no GitHub API call and works
 * purely from the working tree selected by `options.cwd`. A `git clone` sets
 * `origin/HEAD` to the remote's default branch, so this resolves correctly for
 * every monitored clone.
 *
 * @param options - Git command options (cwd selects the repo)
 * @returns The default branch name, or null when it cannot be determined
 *   (e.g. `origin/HEAD` is unset).
 */
export async function resolveLocalDefaultBranch(
  options: GitCommandOptions = {},
): Promise<string | null> {
  const result = await runGitCommand(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    options,
  );
  if (result.ok && result.value.code === 0) {
    const branch = result.value.stdout.trim().replace(
      "refs/remotes/origin/",
      "",
    );
    return branch || null;
  }
  return null;
}

/**
 * Central push-choke-point guard (Issue #2584).
 *
 * The default branch must be strictly read-only for the worker: it may only
 * ever change via a verified, human-reviewed merge — never a direct push of
 * formatting, version, or dependency-bump commits. This guard refuses any push
 * whose target branch equals the repository's default branch.
 *
 * - **Fails closed on the default branch.** When the resolved default branch
 *   matches `branchName` the push is rejected with an explicit error.
 * - **Fails open when the default cannot be resolved.** If `origin/HEAD` is
 *   unset the default branch is unknown, so a legitimate feature-branch push is
 *   never blocked by a transient lookup failure. Direct-to-default is only
 *   possible when `branchName` literally equals the resolved default, so the
 *   read-only invariant still holds for every clone where `origin/HEAD` is set
 *   (the normal case).
 *
 * @param branchName - The branch about to be pushed
 * @param options - Git command options (cwd selects the repo)
 * @param allowDefaultBranch - Opt-out reserved for legitimate merge machinery
 *   that must update the default-branch ref. Defaults to `false` (forbid).
 * @returns Ok when the push may proceed; an error Result when it targets the
 *   default branch and the opt-out was not supplied.
 */
export async function assertPushTargetAllowed(
  branchName: string,
  options: GitCommandOptions = {},
  allowDefaultBranch = false,
): Promise<Result<void>> {
  if (allowDefaultBranch) return { ok: true, value: undefined };

  const defaultBranch = await resolveLocalDefaultBranch(options);
  if (defaultBranch !== null && branchName === defaultBranch) {
    return {
      ok: false,
      error: new Error(
        `Refusing to push to the default branch '${branchName}': the default ` +
          `branch is read-only for the worker and may only change via a ` +
          `verified merge (Issue #2584). Push to a feature or milestone ` +
          `branch instead.`,
      ),
    };
  }
  return { ok: true, value: undefined };
}

/**
 * Push any local commits that haven't been pushed to origin (Issue #105).
 *
 * When responding to PR comments, Claude sometimes makes commits but doesn't push them.
 * This ensures changes are never left unpushed on an unattended machine.
 *
 * Also handles the first-time push of a freshly created feature branch
 * (Issue #1463 regression): when `origin/<branchName>` does not yet exist,
 * the `rev-list --count origin/<branch>..HEAD` probe fails with exit 128
 * ("unknown revision"). Treating that as "0 commits to push" silently
 * skips the push and leaves the remote branch missing — `gh pr create`
 * then fails with "No commits between …". When the probe fails we fall
 * through and push with `-u` so the upstream is created.
 *
 * @param branchName - The branch to push
 * @param options - Git command options
 * @param allowDefaultBranch - Opt-out for the read-only default-branch guard
 *   (Issue #2584). Defaults to `false` (forbid pushing to the default branch).
 * @returns Result with the number of commits pushed (0 when already in sync)
 */
export async function pushUnpushedCommits(
  branchName: string,
  options: GitCommandOptions = {},
  allowDefaultBranch = false,
): Promise<Result<number>> {
  // Read-only default-branch guard (Issue #2584) — refuse before doing any
  // work when the target is the repo's default branch.
  const guard = await assertPushTargetAllowed(
    branchName,
    options,
    allowDefaultBranch,
  );
  if (!guard.ok) {
    return { ok: false, error: guard.error };
  }

  // Check how many commits are ahead of origin. This probe only succeeds
  // when origin/<branchName> already exists. On a freshly created feature
  // branch it fails with exit 128 — that is *not* "nothing to push".
  const countResult = await runGitCommand(
    ["rev-list", "--count", `origin/${branchName}..HEAD`],
    options,
  );
  const probeOk = countResult.ok && countResult.value.code === 0;
  let unpushedCount = probeOk
    ? parseInt(countResult.value.stdout.trim(), 10) || 0
    : 0;

  // Only short-circuit when the probe truly succeeded and reported zero.
  // A failed probe means the upstream ref is missing — fall through and
  // create it via `git push -u`.
  if (probeOk && unpushedCount === 0) {
    return { ok: true, value: 0 };
  }

  // When the standard probe failed (origin/<branchName> does not exist),
  // fall back to counting commits reachable from HEAD that are not on any
  // other origin ref. This gives callers a correct count for the
  // first-time push of a feature branch instead of reporting 0.
  if (!probeOk) {
    const fallbackCount = await runGitCommand(
      ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      options,
    );
    if (fallbackCount.ok && fallbackCount.value.code === 0) {
      unpushedCount = parseInt(fallbackCount.value.stdout.trim(), 10) || 0;
    }
  }

  // Use -u so the first push sets the upstream tracking ref. This is a
  // no-op when the ref is already configured, so it is safe for both the
  // first-time push and subsequent pushes. The branch is routed through
  // `buildPushArgs` (Issue #148), which rejects a dash-leading name and
  // inserts `--end-of-options` so git can only read it as a refspec — this
  // is the push every automated commit uses, WIP preservation included.
  let pushArgs: string[];
  try {
    pushArgs = buildPushArgs("origin", branchName, { setUpstream: true });
  } catch (err) {
    // A refused ref is a loud failure Result, never a silent skip: the
    // caller reports it exactly as it reports any other push failure.
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  const pushResult = await runGitCommand(pushArgs, options);

  if (!pushResult.ok) {
    return { ok: false, error: pushResult.error };
  }

  if (pushResult.value.code !== 0) {
    const pushOutput = pushResult.value.stderr + pushResult.value.stdout;

    // Self-healing: attempt recovery from non-fast-forward rejection (Issue #186)
    if (detectPushRejection(pushOutput)) {
      const recoveryResult = await recoverFromPushRejection(
        branchName,
        options,
      );
      if (recoveryResult.ok) {
        return { ok: true, value: unpushedCount };
      }
    }

    return {
      ok: false,
      error: new Error(`Failed to push unpushed commits: ${pushOutput}`),
    };
  }

  return { ok: true, value: unpushedCount };
}

/**
 * Result of {@link commitAndPushPending}.
 */
export interface CommitAndPushPendingResult {
  /** Whether the helper created a new commit from previously uncommitted changes. */
  committedNewChanges: boolean;
  /** Number of commits actually pushed to origin. */
  commitsPushed: number;
  /** Number of commits still unpushed after the push attempt (0 = clean). */
  finalUnpushedCount: number;
}

/**
 * Commit any uncommitted working-tree changes and push every unpushed commit
 * to origin (Issue #1643 — "Why we forget to push?").
 *
 * The Vibe Coder runs unattended. Phase processors used to gate the push
 * step on Claude's stdout output (`claudeOutput.length > 0`), which is not
 * a reliable signal of whether commits exist locally. When Claude committed
 * silently — or left uncommitted changes — the push step was skipped and
 * the work was lost on the local machine. This helper closes that gap by
 * using git itself as the source of truth:
 *
 *   1. `git status --porcelain` — if dirty, stage and commit with the
 *      provided message.
 *   2. `pushUnpushedCommits` — push every commit ahead of origin (handles
 *      first-time push and non-fast-forward recovery internally).
 *   3. Re-count unpushed commits — `finalUnpushedCount` MUST be 0 for the
 *      caller to claim the push succeeded honestly.
 *
 * Callers should always invoke this at the end of any Claude-driven phase.
 * It is idempotent — when there is nothing to commit and nothing to push
 * it returns `{ committedNewChanges: false, commitsPushed: 0, finalUnpushedCount: 0 }`.
 *
 * @param branchName - The branch to push
 * @param commitMessage - Commit message used when staging dirty working-tree changes
 * @param options - Git command options
 * @param allowDefaultBranch - Opt-out for the read-only default-branch guard
 *   (Issue #2584). Defaults to `false` (forbid pushing to the default branch).
 * @param preFlight - Optional mandatory pre-flight gate (Issue #3577). When
 *   supplied with a non-empty `commands` list, the commands run at the
 *   `assertSafeToCommit()` chokepoint before the automated commit; the first
 *   non-zero exit (or a command that cannot be started, or a timeout) blocks
 *   BOTH the commit and the push. There is no override flag. Omit to leave the
 *   repo unaffected (zero added latency).
 * @returns Result with details of what was committed and pushed
 */
export async function commitAndPushPending(
  branchName: string,
  commitMessage: string,
  options: GitCommandOptions = {},
  allowDefaultBranch = false,
  preFlight?: PreFlightGateSpec,
): Promise<Result<CommitAndPushPendingResult>> {
  // Read-only default-branch guard (Issue #2584) — refuse up front, before
  // staging or committing anything, when the target is the default branch.
  const guard = await assertPushTargetAllowed(
    branchName,
    options,
    allowDefaultBranch,
  );
  if (!guard.ok) {
    return { ok: false, error: guard.error };
  }

  // Step 1 — detect uncommitted changes.
  const statusResult = await runGitCommand(["status", "--porcelain"], options);
  if (!statusResult.ok) {
    return { ok: false, error: statusResult.error };
  }
  if (statusResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git status failed: ${statusResult.value.stderr.trim()}`,
      ),
    };
  }

  let committedNewChanges = false;
  if (statusResult.value.stdout.trim().length > 0) {
    const addResult = await runGitCommand(["add", "-A"], options);
    if (!addResult.ok) {
      return { ok: false, error: addResult.error };
    }
    if (addResult.value.code !== 0) {
      return {
        ok: false,
        error: new Error(`git add failed: ${addResult.value.stderr.trim()}`),
      };
    }

    // Pre-commit safety gate (Issue #1758) — refuse to commit any
    // hidden or secret-bearing file. On violation, unstage everything
    // so the worker does not silently carry secrets in the index.
    const safetyResult = await assertSafeToCommit(options);
    if (!safetyResult.ok) {
      await runGitCommand(["reset", "--"], options);
      return { ok: false, error: safetyResult.error };
    }

    // Pre-flight enforcement gate (Issue #3577) — run the repo's configured
    // mandatory pre-flight commands at this same chokepoint. A non-zero exit,
    // a command that cannot be started, or a timeout is a hard BLOCK: return
    // before the commit so BOTH the commit and the push are refused. There is
    // no override. On block, unstage so the worker does not silently carry the
    // broken change in the index. The captured command output rides on the
    // returned error so the fixer sees the real failure, not a bare
    // "pre-flight failed".
    if (preFlight && preFlight.commands.length > 0) {
      const gateResult = await runPreFlightGate(preFlight.commands, {
        cwd: options.cwd,
        env: options.env,
        timeoutSeconds: preFlight.timeoutSeconds,
        runner: preFlight.runner,
      });
      if (!gateResult.ok) {
        await runGitCommand(["reset", "--"], options);
        return { ok: false, error: gateResult.error };
      }
    }

    // Run-id traceability (Issue #2381) — stamp the commit with the
    // canonical run id so the push is attributable to a specific worker
    // run. assertRunIdTrailer is the pre-commit gate; appendRunIdTrailer
    // guarantees it passes for worker-authored commits.
    const finalMessage = appendRunIdTrailer(commitMessage, getRunId());
    const trailerGate = assertRunIdTrailer(finalMessage);
    if (!trailerGate.ok) {
      await runGitCommand(["reset", "--"], options);
      return { ok: false, error: trailerGate.error };
    }

    const commitResult = await runGitCommand(
      ["commit", "-m", finalMessage],
      options,
    );
    if (!commitResult.ok) {
      return { ok: false, error: commitResult.error };
    }
    // `git commit` exits non-zero when there is nothing to commit. The
    // status check above means this should not happen, but be defensive.
    if (commitResult.value.code !== 0) {
      const combined =
        `${commitResult.value.stdout}\n${commitResult.value.stderr}`.trim();
      // Tolerate "nothing to commit" — treat as no new commit.
      if (!/nothing to commit/i.test(combined)) {
        return {
          ok: false,
          error: new Error(`git commit failed: ${combined}`),
        };
      }
    } else {
      committedNewChanges = true;
    }
  }

  // Step 2 — push any unpushed commits. pushUnpushedCommits handles
  // first-time push and non-fast-forward recovery internally. The
  // default-branch guard already ran above, so skip the redundant re-check
  // (Issue #2584).
  const pushResult = await pushUnpushedCommits(branchName, options, true);
  if (!pushResult.ok) {
    return { ok: false, error: pushResult.error };
  }

  // Step 3 — verify the branch is in sync with origin. This is the honest
  // post-condition the caller needs: 0 means we did our job; >0 means we
  // still have local work that the user is being lied to about.
  const remainingResult = await runGitCommand(
    ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
    options,
  );
  let finalUnpushedCount = 0;
  if (remainingResult.ok && remainingResult.value.code === 0) {
    finalUnpushedCount = parseInt(remainingResult.value.stdout.trim(), 10) || 0;
  }

  // Issue #211: `pushUnpushedCommits` reports what it *intended* to push, so a
  // push that was rejected (or that a recovery step silently rewound) produced
  // the self-contradictory `commitsPushed=4 finalUnpushedCount=4`. Report only
  // the commits that actually landed — the count the caller can trust.
  const commitsPushed = Math.max(0, pushResult.value - finalUnpushedCount);

  return {
    ok: true,
    value: {
      committedNewChanges,
      commitsPushed,
      finalUnpushedCount,
    },
  };
}

/** Default gh command runner — routed through the shared chokepoint. */
async function defaultGhCommand(args: string[]): Promise<string> {
  return await runGhOrThrow(args);
}

/**
 * Ensure the local default branch is current with the remote (Issue #230).
 *
 * @param defaultBranch - The name of the default branch
 * @param options - Git command options
 * @returns Result indicating success
 */
export async function ensureDefaultBranchCurrent(
  defaultBranch: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  // Fetch the latest changes
  const fetchResult = await runGitCommandChecked(
    ["fetch", "origin", defaultBranch],
    options,
  );

  if (!fetchResult.ok) {
    return {
      ok: false,
      error: new Error(`Failed to fetch origin/${defaultBranch}`),
    };
  }

  // Check current branch
  const currentBranchResult = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    options,
  );

  const currentBranch = currentBranchResult.ok
    ? currentBranchResult.value.stdout.trim()
    : "";

  if (currentBranch === defaultBranch) {
    // If on the default branch, reset to remote
    await runGitCommand(
      ["reset", "--hard", `origin/${defaultBranch}`],
      options,
    );
  } else {
    // Update the local ref without checking out
    await runGitCommand(
      ["branch", "-f", defaultBranch, `origin/${defaultBranch}`],
      options,
    );
  }

  return {
    ok: true,
    value: `Local ${defaultBranch} is now current with origin`,
  };
}
