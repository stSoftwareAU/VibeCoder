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
import { neutraliseAgentMarkers } from "./agent_marker_neutralisation.ts";
import { PR_RESPONSE_MESSAGE_FILE } from "./worker_state_paths.ts";
import {
  findResultPlaceholders,
  replaceResultPlaceholders,
} from "./result_placeholder_gate.ts";
import {
  assertSafeGitRef,
  buildCheckoutArgs,
  buildCheckoutResetBranchArgs,
  buildFetchArgs,
  buildPullArgs,
} from "./git_ref_args.ts";
import { classifyCloneContention } from "./clone_contention.ts";
import {
  detachLaneWorktreeHead,
  laneWorktreeHoldingBranch,
} from "./lane_worktree.ts";

/** Subset of GitDeps needed for branch preparation. */
export type BranchPreparationGitDeps = Pick<GitDeps, "runGitCommand">;

/** Outcome of {@link preparePrBranch} (Issue #4376). */
export type PreparePrBranchOutcome =
  | { ok: true }
  | {
    ok: false;
    /**
     * `branch_missing`: origin has no such ref — the PR merged/closed after
     * it was listed; `branch_held`: another worktree on this host has the
     * branch checked out and it could not be released (Issue #1677) — clone
     * contention, not the PR's fault; `checkout_failed`: the branch could not
     * be checked out for any other reason, so the working tree is not the
     * PR's.
     */
    reason: "branch_missing" | "branch_held" | "checkout_failed";
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
 * Fetches the branch from origin and checks it out *at the fetched tip*
 * (`git checkout -B <branch> FETCH_HEAD`), so every pass starts from the PR's
 * head on origin (Issue #4530). Reusing the clone's local branch and trying
 * `git pull --ff-only` failed silently once the local branch had diverged: a
 * fix branch was cut from an unpushed local merge commit, hours behind the PR
 * head. Local commits the reset drops are logged at warn level by SHA. When
 * the fetch itself fails (not a missing branch) there is no fetched tip, so
 * the previous behaviour stands: check out the local branch and try a
 * best-effort fast-forward. Failures are logged as warnings but not fatal —
 * Claude will still run, and downstream push logic will surface any real
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

  try {
    assertSafeGitRef(branchName, "PR head branch name");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("Refusing to prepare an unsafe PR branch", {
      branchName,
      error: detail,
    });
    return { ok: false, reason: "checkout_failed", detail };
  }

  const fetchResult = await git.runGitCommand(
    buildFetchArgs("origin", branchName),
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

  const fetched = fetchResult.ok && fetchResult.value.code === 0;
  if (fetched) await warnOnDroppedLocalCommits(branchName, deps);
  // With a fetched tip the branch is reset onto it; without one the local
  // branch is all there is.
  const checkoutArgs = fetched
    ? buildCheckoutResetBranchArgs(branchName, "FETCH_HEAD")
    : buildCheckoutArgs(branchName);

  let checkoutResult = await git.runGitCommand(
    checkoutArgs,
    { cwd },
  );
  if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
    const err = checkoutResult.ok
      ? checkoutResult.value.stderr.trim()
      : checkoutResult.error.message;
    // Issue #1677: branches are shared between the worktrees of one clone,
    // so git refuses to check out a branch another worktree has out. Live,
    // the holder was the issue lane that raised the PR and then sat parked
    // on its branch (the host was under the disk floor, so the lane was
    // never reused); the CI-fix pass hit this refusal on every cycle for
    // four hours while the PR stayed red. When the holder is one of this
    // host's own lane worktrees, detach it and try once more — the same
    // repair `createFeatureBranchFromBase` makes for the issue path
    // (Issue #1564). Anything else holding the branch is reported, never
    // wrenched away.
    const heldBy = laneWorktreeHoldingBranch(err);
    if (heldBy !== undefined) {
      const released = await detachLaneWorktreeHead(heldBy, git.runGitCommand);
      logger.warn("PR branch is held by a lane worktree on this host", {
        branchName,
        heldBy,
        released,
      });
      if (released) {
        checkoutResult = await git.runGitCommand(
          checkoutArgs,
          { cwd },
        );
      }
    }
  }
  if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
    const err = checkoutResult.ok
      ? checkoutResult.value.stderr.trim()
      : checkoutResult.error.message;
    logger.warn("Failed to check out PR branch", { branchName, error: err });
    // Not on the PR branch: the agent must not run here (Issue #4376). A
    // branch another worktree still holds is contention, not a PR fault
    // (Issue #1677): callers must not spend a retry on it.
    const held = classifyCloneContention(err)?.kind === "branch-held";
    return {
      ok: false,
      reason: held ? "branch_held" : "checkout_failed",
      detail: err,
    };
  }

  // The branch already sits on the fetched tip; only the fallback (no fetch)
  // still needs the best-effort pull.
  if (fetched) return { ok: true };
  const pullResult = await git.runGitCommand(
    buildPullArgs("origin", branchName, { ffOnly: true }),
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

/** Most local-only commits named in the warning; bounds a runaway history. */
const DROPPED_COMMIT_LOG_LIMIT = 20;

/**
 * Warn, by SHA, about commits on the local `branchName` that the fetched tip
 * (`FETCH_HEAD`) does not hold — the checkout that follows drops them
 * (Issue #4530). Silent when the local branch is absent, behind or equal.
 */
async function warnOnDroppedLocalCommits(
  branchName: string,
  deps: PreparePrBranchDeps,
): Promise<void> {
  const { logger, git, cwd } = deps;
  const result = await git.runGitCommand(
    [
      "rev-list",
      `--max-count=${DROPPED_COMMIT_LOG_LIMIT}`,
      `refs/heads/${branchName}`,
      "--not",
      "FETCH_HEAD",
      "--",
    ],
    { cwd },
  );
  // A non-zero exit is the expected "no such local branch" case.
  if (!result.ok || result.value.code !== 0) return;
  const shas = result.value.stdout.split("\n").map((l) => l.trim()).filter(
    (l) => l !== "",
  );
  if (shas.length === 0) return;
  logger.warn(
    "Discarding local commits that are not on the PR branch on origin",
    { branchName, shas, limit: DROPPED_COMMIT_LOG_LIMIT },
  );
}

/**
 * Where the agent's `.pr_response_message` lives for a working directory.
 *
 * Shares its filename with `worker_state_paths.ts` (Issue #1711), so the
 * final-mile chokepoint that keeps the reply out of the commit and this reader
 * that consumes it after the push cannot drift apart.
 */
export function prResponseMessagePath(workDir: string): string {
  return `${workDir}/${PR_RESPONSE_MESSAGE_FILE}`;
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
 * Marker neutralisation (Issue #2236): the same message is concatenated into
 * comment bodies the **fleet account** authors, and those bodies are the
 * fleet-wide record of CI-fix attempts and deferrals (Issue #1879) — gated on
 * the comment's author, not on where inside the body a marker came from. A
 * `<!-- vibe-ci-fix-attempt … -->` smuggled into this file would therefore be
 * read back as the fleet's own claim. Every HTML-comment delimiter in the
 * agent's text is made inert here, at the one chokepoint all three PR-comment
 * consumers read through, and the defusal is logged rather than swallowed.
 * The worker's own marker is appended afterwards and still parses normally.
 *
 * Result-placeholder backstop (Issues #3124, #3248): a fill-in-later token
 * such as `QUALITY_RESULT_PLACEHOLDER` or `GATE_OUTCOME_PENDING`, left where
 * a command's actual result belongs, reads as "the gate was run" to a
 * reader who does not know the fleet's internal vocabulary — when nothing
 * was actually reported.
 * `pr_feedback_processor.ts` gets one in-run recovery turn to fix this
 * before the message is ever read back here; this is the fail-loud
 * backstop for every one of the four reply consumers (PR feedback, CI fix,
 * merge-conflict agent, milestone conflict ladder) that read through this
 * one chokepoint. Any bare (outside-code) placeholder token still present
 * after redaction/neutralisation is replaced with the visible text
 * `[result not reported]` so the public reply states plainly that the
 * result was not reported, rather than carrying the token forward, and the
 * substitution is logged loudly at error level naming the token(s).
 *
 * @param workDir - Working directory where Claude runs.
 * @param logger - Optional logger, so a defused marker — or an unreported
 *   result placeholder — is reported loudly.
 * @returns Trimmed, secret-redacted, marker-inert, placeholder-free file
 *          contents, or `undefined` if the file is missing or empty.
 */
export async function readPrResponseMessage(
  workDir: string | undefined,
  logger?: Logger,
): Promise<string | undefined> {
  if (!workDir) return undefined;
  const path = prResponseMessagePath(workDir);
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
    // Redact secrets before the message leaves for a public PR comment, then
    // make any marker syntax it carries inert (Issue #2236).
    const neutralised = neutraliseAgentMarkers(redactSecrets(trimmed));
    if (neutralised.neutralised > 0) {
      logger?.security(
        "AGENT_MARKER_NEUTRALISED",
        `Neutralised ${neutralised.neutralised} HTML-comment delimiter(s) in ` +
          `${PR_RESPONSE_MESSAGE_FILE} so agent-authored text cannot forge a ` +
          `fleet marker (names seen: ${
            neutralised.names.join(", ") || "none"
          })`,
      );
    }
    // Fail-loud backstop (Issue #3124): a bare result-placeholder token must
    // never reach a public PR comment as if it were a reported outcome.
    const placeholders = findResultPlaceholders(neutralised.text);
    if (placeholders.length > 0) {
      logger?.error(
        `Unresolved result-placeholder token(s) in ${PR_RESPONSE_MESSAGE_FILE} ` +
          `(Issue #3124) — replacing with "[result not reported]" rather ` +
          `than posting the token(s) as if they were a reported result: ${
            placeholders.join(", ")
          }`,
      );
      return replaceResultPlaceholders(
        neutralised.text,
        "[result not reported]",
      );
    }
    return neutralised.text;
  } catch {
    return undefined;
  }
}
