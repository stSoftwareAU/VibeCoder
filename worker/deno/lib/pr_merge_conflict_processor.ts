/**
 * PR merge-conflict resolution processor (Issue #84).
 *
 * This is the handler Issue #4373 deferred to and nobody implemented. The
 * branch updater refuses to side-pick a conflict — correctly, after a rebase
 * silently destroyed a PR's own changes — and hands the PR off to "the
 * PR-feedback agent or a human". PR feedback needs a review comment, CI fix
 * needs a failing check, and a CONFLICTING PR has neither, so the hand-off
 * had no receiver and PRs sat conflicting indefinitely.
 *
 * The contract this processor implements is exactly #4373's:
 *
 * - Perform a **real merge** of the base into the PR branch. Both sides'
 *   changes survive, or the attempt stops and escalates — never a side-pick.
 * - Run the repo's quality gate on the merged result (the agent does this;
 *   a conflicting PR has had no CI at all, so this is often the first run).
 * - Push without force, so every commit on the PR survives.
 * - Comment on the PR describing what was merged.
 *
 * The pass is bounded, and every attempt ends visibly (Issue #395): the
 * attempt is recorded on the PR *before* the merge runs, and each outcome —
 * merged, failed, escalated — posts its own conclusion marker. An attempt
 * that opened and never concluded was disrupted rather than judged, so it
 * does not spend the budget; the next attempt says so loudly on the PR. The
 * final *concluded* failure escalates with `needs-human` and a conflict
 * summary instead of retrying forever.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, RepoConfig, Result } from "../types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { buildMergeConflictPrompt } from "./prompt_builder.ts";
import { readRepoContext } from "./repo_context_reader.ts";
import {
  preparePrBranch,
  readPrResponseMessage,
} from "./pr_branch_preparation.ts";
import {
  type HeartbeatHandle,
  startHeartbeat,
  stopHeartbeat,
} from "./heartbeat.ts";
import {
  acquireBranchUpdateLock,
  releaseBranchUpdateLock,
} from "./pr_branch_lock.ts";
import { resolvePreFlightSpec } from "./git_push.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import {
  clearMergeConflictLabel,
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  DEFAULT_MAX_CONFLICT_ATTEMPTS,
  DEFAULT_MAX_DISRUPTED_ATTEMPTS,
} from "./pr_merge_conflict_scan.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The conflicting PR to resolve. */
export interface MergeConflictInput {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Head branch name. */
  branchName: string;
  /** Base branch the PR targets. */
  baseBranch: string;
  /** Attempts that reached a conclusion — what spends the budget. */
  attemptCount: number;
  /**
   * Attempts disrupted before they concluded (Issue #395). Surfaced on the
   * PR so a silent stall cannot masquerade as a quiet queue.
   */
  disruptedCount?: number;
}

/** Outcome of one conflict-resolution attempt. */
export interface MergeConflictResult {
  /** Whether the attempt ran (false when the PR was locked or gone). */
  processed: boolean;
  /** Whether a merge was pushed to the PR branch. */
  merged: boolean;
  /** Whether the attempt escalated the PR to a human. */
  escalated: boolean;
  /** Human-readable summary. */
  summary: string;
}

/** Dependencies for {@link processMergeConflict}. */
export interface MergeConflictProcessorDeps {
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Worker deps for cross-cutting concerns. */
  deps: WorkerDeps;
  /** Working directory — the target repo checkout. */
  workDir: string;
  /** Quality instructions for the prompt. */
  qualityInstructions?: string;
  /** Custom repo-specific instructions. */
  customInstructions?: string;
  /** Claude hard timeout in seconds. */
  claudeTimeout?: number;
  /** Silence watchdog in seconds (Issue #1825). */
  claudeNoOutputTimeout?: number;
  /** Maximum rate-limit retries. */
  maxRateLimitRetries?: number;
  /** Unique worker identity for the cross-host PR lock. */
  workerId?: string;
  /** Attempts allowed before escalating (default 2). */
  maxAttempts?: number;
  /** Label applied on escalation. Defaults to `needs-human`. */
  needsHumanLabel?: string;
  /** Per-repo config, used to resolve the pre-flight push gate. */
  repoConfigs?: Record<string, RepoConfig>;
  /** Override the prompts directory (tests). */
  promptsDir?: string;
  /** Injectable lock acquisition. Defaults to {@link acquireBranchUpdateLock}. */
  acquireLockFn?: typeof acquireBranchUpdateLock;
  /** Injectable lock release. Defaults to {@link releaseBranchUpdateLock}. */
  releaseLockFn?: typeof releaseBranchUpdateLock;
}

const DEFAULT_CLAUDE_TIMEOUT = OPERATIONAL_DEFAULTS.prFeedbackTimeout;
const DEFAULT_CLAUDE_NO_OUTPUT_TIMEOUT =
  OPERATIONAL_DEFAULTS.claudeNoOutputTimeout;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;

/** What the human must do when the worker gives up on a conflict. */
export const CONFLICT_ESCALATION_NEXT_STEP =
  "Merge the base branch into the PR branch by hand, keeping both sides' " +
  "changes, run the repo's quality gate on the result, and push. Remove the " +
  "`needs-human` label once the PR is mergeable again.";

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Minimal git runner surface this processor needs. */
type GitRunner = WorkerDeps["git"]["runGitCommand"];

interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command, folding a spawn failure into a non-zero exit so no
 * caller can mistake "could not run git" for "git said nothing was wrong"
 * (fail loud — Issue #3234).
 */
async function git(
  run: GitRunner,
  args: string[],
  cwd: string,
): Promise<GitOutcome> {
  const result = await run(args, { cwd });
  if (!result.ok) {
    return { code: 1, stdout: "", stderr: result.error.message };
  }
  return result.value;
}

/** Paths git still reports as unmerged. */
export function parseUnmergedPaths(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  );
}

/**
 * Whether the working tree still carries conflict markers.
 *
 * `git grep` exits 1 when nothing matches, so a zero exit with output is
 * the only "markers remain" signal.
 */
async function hasConflictMarkers(
  run: GitRunner,
  cwd: string,
): Promise<boolean> {
  const result = await git(run, [
    "grep",
    "-l",
    "-I",
    "-E",
    "^(<<<<<<<|>>>>>>>) ",
  ], cwd);
  return result.code === 0 && result.stdout.trim().length > 0;
}

/** Abort an in-progress merge, leaving the branch exactly as its author had it. */
async function abortMerge(run: GitRunner, cwd: string): Promise<void> {
  await git(run, ["merge", "--abort"], cwd);
}

// ---------------------------------------------------------------------------
// Comment helpers
// ---------------------------------------------------------------------------

/**
 * Body of the comment that records an attempt before it runs.
 *
 * When earlier attempts were disrupted rather than judged, the comment says
 * so (Issue #395) — the silence on GRQ#4408/#4409 after "attempt 1 of 2" is
 * exactly the state this makes visible.
 */
export function buildAttemptComment(
  attemptNumber: number,
  maxAttempts: number,
  baseBranch: string,
  disruptedCount: number = 0,
): string {
  const lines = [
    `${CONFLICT_ATTEMPT_MARKER} n="${attemptNumber}" -->`,
    `🔀 **Merge-conflict resolution — attempt ${attemptNumber} of ${maxAttempts}**`,
    "",
    `This PR conflicts with \`${baseBranch}\`, so no CI can run on it. The ` +
    "worker is merging the base branch in for real — both sides' changes " +
    "must survive — and will run the repository's quality gate on the result.",
  ];

  if (disruptedCount > 0) {
    lines.push(
      "",
      `⚠️ **${disruptedCount} earlier attempt(s) were disrupted** — they ` +
        "opened an attempt and never reported a conclusion, so the conflict " +
        "was never judged. A disrupted attempt does not spend the " +
        `${maxAttempts}-attempt budget; after ` +
        `${DEFAULT_MAX_DISRUPTED_ATTEMPTS} disruptions this PR is handed to ` +
        "a human instead.",
    );
  }

  return lines.join("\n");
}

/** Body of the comment posted when the merge lands. */
export function buildResolvedComment(
  baseBranch: string,
  branchName: string,
  detail?: string,
): string {
  const body = detail && detail.trim().length > 0
    ? detail.trim()
    : `Merged \`${baseBranch}\` into \`${branchName}\` and pushed the result.`;
  return `${CONFLICT_RESOLVED_MARKER}\n✅ **Merge conflict resolved**\n\n${body}`;
}

/**
 * Body of the comment posted when an attempt is judged and fails (Issue
 * #395).
 *
 * This is the conclusion that turns an opened attempt into a spent one. Its
 * absence is what makes a disrupted attempt detectable on a later scan, so it
 * must be posted for every judged failure — including the last one, which
 * also escalates.
 */
export function buildFailedComment(
  attemptNumber: number,
  maxAttempts: number,
  baseBranch: string,
  failureDetail: string,
  conflictedFiles: readonly string[],
): string {
  const files = conflictedFiles.length > 0
    ? ["", "Conflicted files:", ...conflictedFiles.map((f) => `- \`${f}\``)]
    : [];
  return [
    `${CONFLICT_FAILED_MARKER} n="${attemptNumber}" -->`,
    `❌ **Merge-conflict resolution — attempt ${attemptNumber} of ${maxAttempts} failed**`,
    "",
    `Merging \`${baseBranch}\` in did not produce a mergeable branch: ` +
    `${failureDetail}`,
    ...files,
    "",
    "The branch was left exactly as its author pushed it — the worker never " +
    "side-picks a conflict (Issue #4373), so no change has been lost.",
  ].join("\n");
}

/** Escalation reason naming what was tried and what is still conflicted. */
export function buildConflictEscalationReason(
  input: MergeConflictInput,
  conflictedFiles: readonly string[],
  failureDetail: string,
  maxAttempts: number,
): string {
  const files = conflictedFiles.length > 0
    ? conflictedFiles.map((f) => `- \`${f}\``).join("\n")
    : "- (git reported no unmerged paths)";
  return [
    `The worker has spent its ${maxAttempts} merge-conflict attempts on ` +
    `PR #${input.prNumber} without producing a mergeable branch, so it has ` +
    "stopped rather than retrying.",
    "",
    `Merging \`${input.baseBranch}\` into \`${input.branchName}\` conflicted in:`,
    "",
    files,
    "",
    `Last failure: ${failureDetail}`,
    "",
    "The branch was left exactly as its author pushed it — the worker never " +
    "side-picks a conflict (Issue #4373), so no change has been lost.",
  ].join("\n");
}

async function postPrComment(
  deps: WorkerDeps,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await deps.github.runGhCommand([
    "pr",
    "comment",
    String(prNumber),
    "--repo",
    repo,
    "--body",
    body,
  ]);
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Resolve one conflicting PR by merging its base branch in for real.
 *
 * @param input - The conflicting PR, from the merge-conflict scan.
 * @param processorDeps - Processor dependencies.
 * @returns The attempt outcome. An `ok: false` result means the attempt
 *   itself failed loudly (git or agent error), not that the conflict was
 *   simply too hard — that case returns `ok: true` with `merged: false`.
 */
export async function processMergeConflict(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
): Promise<Result<MergeConflictResult>> {
  const { repo, prNumber } = input;
  const { logger, workerId } = processorDeps;
  const acquireLock = processorDeps.acquireLockFn ?? acquireBranchUpdateLock;
  const releaseLock = processorDeps.releaseLockFn ?? releaseBranchUpdateLock;

  logger.info("Resolving PR merge conflict", {
    repo,
    prNumber,
    baseBranch: input.baseBranch,
    attemptCount: input.attemptCount,
  });

  let lockCommentId: number | undefined;
  if (workerId) {
    const lock = await acquireLock({ repo, prNumber, workerId });
    if (!lock.ok || !lock.value.acquired) {
      const winner = lock.ok ? lock.value.winnerId ?? "unknown" : "unknown";
      logger.info("Conflicting PR is locked by another worker — skipping", {
        repo,
        prNumber,
        winnerId: winner,
      });
      return {
        ok: true,
        value: {
          processed: false,
          merged: false,
          escalated: false,
          summary: `PR #${prNumber} locked by ${winner}`,
        },
      };
    }
    lockCommentId = lock.value.lockCommentId;
  } else {
    logger.warn(
      "No workerId configured — resolving the conflict without a cross-host lock",
      { repo, prNumber },
    );
  }

  const heartbeatStart = await startHeartbeat({
    repo,
    issueNumber: prNumber,
    // A PR, not an issue (Issue #391): the kind keys this heartbeat apart
    // from an issue of the same number, and matches the maintenance hold the
    // sweep's live set reports.
    kind: "pr",
    workDir: processorDeps.workDir,
    recordFn: processorDeps.deps.crashHandling.recordHeartbeat,
    clearFn: processorDeps.deps.crashHandling.clearHeartbeat,
  });
  const heartbeatHandle: HeartbeatHandle | undefined = heartbeatStart.ok
    ? heartbeatStart.value
    : undefined;
  if (!heartbeatStart.ok) {
    logger.warn("Failed to start heartbeat for merge-conflict resolution", {
      repo,
      prNumber,
      error: heartbeatStart.error.message,
    });
  }

  try {
    return await resolveConflict(input, processorDeps);
  } finally {
    if (heartbeatHandle) await stopHeartbeat(heartbeatHandle);
    if (lockCommentId !== undefined) {
      await releaseLock({ repo, prNumber, lockCommentId });
    }
  }
}

async function resolveConflict(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
): Promise<Result<MergeConflictResult>> {
  const { repo, prNumber, branchName, baseBranch } = input;
  const {
    logger,
    deps,
    workDir,
    maxAttempts = DEFAULT_MAX_CONFLICT_ATTEMPTS,
  } = processorDeps;
  const run = deps.git.runGitCommand;
  const attemptNumber = input.attemptCount + 1;

  // Check out the PR branch. A branch that no longer exists on origin means
  // the PR closed or merged since the scan listed it — nothing to do.
  const prepared = await preparePrBranch(branchName, {
    logger,
    git: deps.git,
    cwd: workDir,
  });
  if (!prepared.ok) {
    return {
      ok: true,
      value: {
        processed: false,
        merged: false,
        escalated: false,
        summary:
          `PR #${prNumber} branch '${branchName}' unusable: ${prepared.reason}`,
      },
    };
  }

  const fetchBase = await git(run, ["fetch", "origin", baseBranch], workDir);
  if (fetchBase.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Failed to fetch base branch '${baseBranch}' for PR #${prNumber}: ${fetchBase.stderr.trim()}`,
      ),
    };
  }

  // Record the attempt before merging anything (Issue #84): the marker is
  // what a later scan reads to tell "this attempt was disrupted" from "no
  // attempt has run". It opens the attempt; only a conclusion posted below
  // spends it (Issue #395).
  try {
    await postPrComment(
      deps,
      repo,
      prNumber,
      buildAttemptComment(
        attemptNumber,
        maxAttempts,
        baseBranch,
        input.disruptedCount ?? 0,
      ),
    );
  } catch (err) {
    // Without the marker the attempt is unbounded, so refuse to start.
    return {
      ok: false,
      error: new Error(
        `Failed to record merge-conflict attempt on PR #${prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }

  const merge = await git(
    run,
    ["merge", `origin/${baseBranch}`, "--no-edit"],
    workDir,
  );

  let conflictedFiles: string[] = [];
  if (merge.code !== 0) {
    const unmerged = await git(
      run,
      ["diff", "--name-only", "--diff-filter=U"],
      workDir,
    );
    conflictedFiles = parseUnmergedPaths(unmerged.stdout);

    if (conflictedFiles.length === 0) {
      // The merge failed for a reason that is not a content conflict (a
      // dirty tree, a missing ref). Leave the branch untouched.
      await abortMerge(run, workDir);
      return await failAttempt(
        input,
        processorDeps,
        [],
        `git merge did not conflict but failed: ${
          merge.stderr.trim() || merge.stdout.trim()
        }`,
        attemptNumber,
      );
    }

    logger.info("Merge conflicted — handing the resolution to the agent", {
      repo,
      prNumber,
      conflictedFiles,
    });

    const agentOutcome = await runResolutionAgent(
      input,
      processorDeps,
      conflictedFiles,
    );
    if (!agentOutcome.ok) {
      await abortMerge(run, workDir);
      return await failAttempt(
        input,
        processorDeps,
        conflictedFiles,
        agentOutcome.error.message,
        attemptNumber,
      );
    }

    // The agent must leave a fully resolved tree. Unmerged paths or leftover
    // conflict markers mean it did not finish — abort rather than pushing a
    // broken merge.
    const stillUnmerged = parseUnmergedPaths(
      (await git(run, ["diff", "--name-only", "--diff-filter=U"], workDir))
        .stdout,
    );
    if (stillUnmerged.length > 0) {
      await abortMerge(run, workDir);
      return await failAttempt(
        input,
        processorDeps,
        conflictedFiles,
        `the agent left ${stillUnmerged.length} path(s) unmerged: ${
          stillUnmerged.join(", ")
        }`,
        attemptNumber,
      );
    }
    if (await hasConflictMarkers(run, workDir)) {
      await abortMerge(run, workDir);
      return await failAttempt(
        input,
        processorDeps,
        conflictedFiles,
        "the working tree still contains conflict markers",
        attemptNumber,
      );
    }
  }

  // Commit whatever the agent left staged and push. No force: the merge
  // commit fast-forwards the remote branch, so every PR commit survives.
  const preFlight = resolvePreFlightSpec(processorDeps.repoConfigs, repo);
  const finalise = await deps.git.commitAndPushPending(
    branchName,
    `Merge ${baseBranch} into ${branchName} (Issue #84)\n\nResolved the PR's merge conflict without side-picking.`,
    { cwd: workDir },
    false,
    preFlight,
  );
  if (!finalise.ok) {
    return await failAttempt(
      input,
      processorDeps,
      conflictedFiles,
      `commit/push failed: ${finalise.error.message}`,
      attemptNumber,
    );
  }
  if (finalise.value.finalUnpushedCount > 0) {
    // Issue #211: `detail=5 commit(s) could not be pushed` with no git output
    // told an operator nothing. Ask git what the remote would say — a dry-run
    // push has no side effects and names the rejection reason.
    const dryRun = await git(
      run,
      ["push", "--dry-run", "--end-of-options", "origin", branchName],
      workDir,
    );
    const gitDetail = (dryRun.stderr + dryRun.stdout).trim().split("\n")
      .slice(-3).join(" | ");
    return await failAttempt(
      input,
      processorDeps,
      conflictedFiles,
      `${finalise.value.finalUnpushedCount} commit(s) could not be pushed: ${
        gitDetail || "git reported no output"
      }`,
      attemptNumber,
    );
  }

  // The merge only counts when the base is genuinely an ancestor of the
  // branch tip — that is what "the base's changes survived" means, and it
  // also catches an agent that aborted the merge and escalated instead.
  const ancestor = await git(
    run,
    ["merge-base", "--is-ancestor", `origin/${baseBranch}`, "HEAD"],
    workDir,
  );
  if (ancestor.code !== 0) {
    const detail = await readPrResponseMessage(workDir);
    return await failAttempt(
      input,
      processorDeps,
      conflictedFiles,
      detail && detail.trim().length > 0
        ? detail.trim()
        : `'${baseBranch}' is still not merged into '${branchName}'`,
      attemptNumber,
    );
  }

  const detail = await readPrResponseMessage(workDir);
  try {
    await postPrComment(
      deps,
      repo,
      prNumber,
      buildResolvedComment(baseBranch, branchName, detail),
    );
  } catch (err) {
    logger.warn("Failed to post merge-resolved comment", {
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await clearMergeConflictLabel(repo, prNumber, deps.github.runGhCommand);
  } catch (err) {
    logger.warn("Failed to clear the merge-conflict label", {
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("Merge conflict resolved and pushed", {
    repo,
    prNumber,
    conflictedFiles,
  });

  return {
    ok: true,
    value: {
      processed: true,
      merged: true,
      escalated: false,
      summary: conflictedFiles.length === 0
        ? `Merged ${baseBranch} into PR #${prNumber} cleanly`
        : `Merged ${baseBranch} into PR #${prNumber}, resolving ${conflictedFiles.length} conflicted file(s)`,
    },
  };
}

/**
 * Run the resolution agent against the conflicted working tree.
 *
 * @returns An error result when the agent could not run or timed out.
 */
async function runResolutionAgent(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
  conflictedFiles: readonly string[],
): Promise<Result<void>> {
  const {
    logger,
    deps,
    workDir,
    qualityInstructions,
    customInstructions,
    claudeTimeout = DEFAULT_CLAUDE_TIMEOUT,
    claudeNoOutputTimeout = DEFAULT_CLAUDE_NO_OUTPUT_TIMEOUT,
    maxRateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES,
  } = processorDeps;

  const repoName = input.repo.split("/").pop() ?? input.repo;
  const repoContext = await readRepoContext(`${workDir}/${repoName}`);
  const repoContextContent = repoContext.ok && repoContext.value.content
    ? repoContext.value.content
    : undefined;

  const promptResult = await buildMergeConflictPrompt({
    repo: input.repo,
    prNumber: String(input.prNumber),
    baseBranch: input.baseBranch,
    conflictedFiles,
    qualityInstructions,
    customInstructions,
    repoContextContent,
    promptsDir: processorDeps.promptsDir,
  });
  if (!promptResult.ok) {
    return {
      ok: false,
      error: new Error(
        `failed to build the merge-conflict prompt: ${promptResult.error.message}`,
      ),
    };
  }

  const claudeResult = await deps.claude.runClaudeWithRetry(
    {
      prompt: promptResult.value.prompt,
      systemPrompt: promptResult.value.systemPrompt,
      timeoutSeconds: claudeTimeout,
      noOutputTimeout: claudeNoOutputTimeout,
      phase: "merge_conflict",
      cwd: workDir,
      logger,
    },
    { maxRetries: maxRateLimitRetries },
  );

  if (!claudeResult.ok) {
    return {
      ok: false,
      error: new Error(`agent run failed: ${claudeResult.error.message}`),
    };
  }
  if (claudeResult.value.timedOut) {
    return {
      ok: false,
      error: new Error(
        claudeResult.value.timeoutReason === "no-output"
          ? `agent produced no output for ${claudeNoOutputTimeout}s`
          : `agent timed out after ${claudeTimeout}s`,
      ),
    };
  }

  return { ok: true, value: undefined };
}

/**
 * Record a failed attempt, escalating to a human when the budget is spent.
 *
 * The failure is always posted on the PR (Issue #395): it is the conclusion
 * that spends this attempt, and without it the attempt is indistinguishable
 * from one a dying worker abandoned. The branch is left exactly as its author
 * pushed it — the caller has already aborted any in-progress merge.
 */
async function failAttempt(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
  conflictedFiles: readonly string[],
  failureDetail: string,
  attemptNumber: number,
): Promise<Result<MergeConflictResult>> {
  const { logger, deps } = processorDeps;
  const maxAttempts = processorDeps.maxAttempts ??
    DEFAULT_MAX_CONFLICT_ATTEMPTS;
  const { repo, prNumber } = input;

  logger.warn("Merge-conflict attempt failed", {
    repo,
    prNumber,
    attempt: attemptNumber,
    maxAttempts,
    detail: failureDetail,
  });

  try {
    await postPrComment(
      deps,
      repo,
      prNumber,
      buildFailedComment(
        attemptNumber,
        maxAttempts,
        input.baseBranch,
        failureDetail,
        conflictedFiles,
      ),
    );
  } catch (err) {
    // The attempt then reads as disrupted on the next scan and is retried —
    // the safe direction, and bounded by the disruption budget. Say so.
    logger.error("Failed to post the merge-conflict failure conclusion", {
      repo,
      prNumber,
      attempt: attemptNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (attemptNumber < maxAttempts) {
    return {
      ok: true,
      value: {
        processed: true,
        merged: false,
        escalated: false,
        summary:
          `Merge-conflict attempt ${attemptNumber}/${maxAttempts} on PR #${prNumber} failed: ${failureDetail}`,
      },
    };
  }

  const escalation = await escalateToHuman({
    ghClient: createGhEscalationClient(deps.github.runGhCommand),
    repo,
    target: { kind: "pr", number: prNumber },
    needsHumanLabel: processorDeps.needsHumanLabel ?? "needs-human",
    heading: "Merge conflict needs human attention",
    reason: buildConflictEscalationReason(
      input,
      conflictedFiles,
      failureDetail,
      maxAttempts,
    ),
    nextStep: CONFLICT_ESCALATION_NEXT_STEP,
    dedupKey: `merge-conflict-${prNumber}`,
    ensureLabelColour: "d4c5f9",
    ensureLabelDescription:
      "Worker could not produce a fix; human review required",
    deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
    logger,
  });
  if (!escalation.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to escalate the merge conflict on PR #${prNumber}: ${escalation.error.message}`,
      ),
    };
  }

  return {
    ok: true,
    value: {
      processed: true,
      merged: false,
      escalated: true,
      summary:
        `Merge-conflict attempts exhausted on PR #${prNumber} — escalated to a human`,
    },
  };
}
