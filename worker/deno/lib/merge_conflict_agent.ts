/**
 * The merge-conflict resolution agent, shared by every target (Issue #1767).
 *
 * The runner and its prompt build were private to
 * `pr_merge_conflict_processor.ts`, so the milestone ladder could not reach the
 * rung the PR pass climbs. Both are here now, behind a target that is either a
 * pull request or a bare branch pair — the same both-sides-survive contract,
 * the same prompt, the same reply file, whichever one asks.
 *
 * Nothing here decides anything about the conflict: the caller starts the
 * merge, hands over the conflicted paths, and reads the tree afterwards. This
 * module builds the prompt, runs the agent, and reports what the run left
 * behind — a failure is always returned, never swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { runClaudeWithRetry } from "./claude_runner.ts";
import {
  buildMergeConflictPrompt,
  type MergeConflictTarget,
} from "./prompt_builder.ts";
import { loadRepoContextContent } from "./repo_context_reader.ts";
import { readPrResponseMessage } from "./pr_branch_preparation.ts";
import type { ConflictIssueContext } from "./conflict_issue_context.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";

export type { MergeConflictTarget } from "./prompt_builder.ts";

/** Claude hard timeout in seconds when the caller names none. */
export const DEFAULT_CONFLICT_AGENT_TIMEOUT =
  OPERATIONAL_DEFAULTS.prFeedbackTimeout;

/** Silence watchdog in seconds when the caller names none (Issue #1825). */
export const DEFAULT_CONFLICT_AGENT_NO_OUTPUT_TIMEOUT =
  OPERATIONAL_DEFAULTS.claudeNoOutputTimeout;

/** Rate-limit retries when the caller names none. */
export const DEFAULT_CONFLICT_AGENT_RATE_LIMIT_RETRIES = 3;

/** How long the agent may run, and how often a rate limit may be retried. */
export interface MergeConflictAgentTimeouts {
  /** Hard timeout in seconds. */
  claudeTimeout?: number;
  /** Silence watchdog in seconds. */
  claudeNoOutputTimeout?: number;
  /** Maximum rate-limit retries. */
  maxRateLimitRetries?: number;
}

/** One agent run against a conflicted working tree. */
export interface MergeConflictAgentRequest {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** The PR or the branch the base is being merged into. */
  target: MergeConflictTarget;
  /** Base branch being merged in. */
  baseBranch: string;
  /** Paths the merge left conflicted, after the deterministic rules ran. */
  conflictedFiles: readonly string[];
  /** Originating issues behind both sides, when they are known (Issue #1114). */
  issueContext?: ConflictIssueContext | null;
  /** The checkout the agent runs in. */
  workDir: string;
  /** Run bounds. Defaults apply per field. */
  timeouts?: MergeConflictAgentTimeouts;
  /** Override the prompts directory (tests). */
  promptsDir?: string;
  /** Quality instructions for the prompt. */
  qualityInstructions?: string;
  /** Custom repo-specific instructions. */
  customInstructions?: string;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** The agent runner — `deps.claude.runClaudeWithRetry` in production. */
  runAgent: typeof runClaudeWithRetry;
}

/**
 * What one agent run left behind.
 *
 * `terminated` is the run the worker itself ended (Issue #1693): the
 * maintenance-lane watchdog abandoned the handler at the cycle deadline and
 * SIGTERMed the agent mid-edit. The tree is then half-resolved through no
 * fault of the target, so it is not a verdict on the conflict and must not be
 * judged as one.
 */
export interface MergeConflictAgentOutcome {
  /** The run was ended by the worker (SIGTERM, exit 143). */
  terminated: boolean;
}

/**
 * Run the resolution agent against a conflicted working tree.
 *
 * @param request - The target, the conflicted paths and the run bounds
 * @returns An error result when the prompt could not be built, the agent could
 *   not run, or it timed out; otherwise whether the worker ended the run.
 */
export async function runMergeConflictAgent(
  request: MergeConflictAgentRequest,
): Promise<Result<MergeConflictAgentOutcome>> {
  const {
    repo,
    target,
    baseBranch,
    conflictedFiles,
    issueContext = null,
    workDir,
    promptsDir,
    qualityInstructions,
    customInstructions,
    logger,
    runAgent,
  } = request;
  const claudeTimeout = request.timeouts?.claudeTimeout ??
    DEFAULT_CONFLICT_AGENT_TIMEOUT;
  const claudeNoOutputTimeout = request.timeouts?.claudeNoOutputTimeout ??
    DEFAULT_CONFLICT_AGENT_NO_OUTPUT_TIMEOUT;
  const maxRetries = request.timeouts?.maxRateLimitRetries ??
    DEFAULT_CONFLICT_AGENT_RATE_LIMIT_RETRIES;

  // `workDir` already is the checkout, so the repo context is read directly —
  // appending the repo name looked one level too deep and injected nothing
  // (Issue #1673).
  const repoContextContent = await loadRepoContextContent(workDir, logger);

  const promptResult = await buildMergeConflictPrompt({
    repo,
    target,
    baseBranch,
    conflictedFiles,
    qualityInstructions,
    customInstructions,
    repoContextContent,
    promptsDir,
    issueContext,
  });
  if (!promptResult.ok) {
    return {
      ok: false,
      error: new Error(
        `failed to build the merge-conflict prompt: ${promptResult.error.message}`,
      ),
    };
  }

  const claudeResult = await runAgent(
    {
      prompt: promptResult.value.prompt,
      systemPrompt: promptResult.value.systemPrompt,
      timeoutSeconds: claudeTimeout,
      noOutputTimeout: claudeNoOutputTimeout,
      phase: "merge_conflict",
      cwd: workDir,
      logger,
    },
    { maxRetries },
  );

  if (!claudeResult.ok) {
    return {
      ok: false,
      error: new Error(`agent run failed: ${claudeResult.error.message}`),
    };
  }
  // Issue #1693: the worker ended this run — the handler was abandoned by the
  // watchdog, or the run is shutting down. Reported, never judged: the caller
  // withdraws the attempt instead of reading the half-edited tree as a
  // failure the target must pay for.
  if (claudeResult.value.terminated) {
    return { ok: true, value: { terminated: true } };
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

  return { ok: true, value: { terminated: false } };
}

/**
 * A memoised reader for the agent's reply file (Issue #1767).
 *
 * `readPrResponseMessage` consumes `.pr_response_message` so a stale reply
 * cannot be reused on the next run, and one attempt reads it in several places
 * — the override guard, the failure path and the conclusion comment. Reading
 * it through one memoised closure is how both targets get the same reply.
 *
 * @param workDir - The checkout the agent ran in
 * @returns A function returning the reply, or `undefined` when there was none
 */
export function createMergeConflictReplyReader(
  workDir: string | undefined,
): () => Promise<string | undefined> {
  let read = false;
  let reply: string | undefined;
  return async () => {
    if (!read) {
      reply = await readPrResponseMessage(workDir);
      read = true;
    }
    return reply;
  };
}
