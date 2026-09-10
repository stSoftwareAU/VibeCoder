/**
 * The one binding of the milestone conflict ladder's agent rung (Issue #1780).
 *
 * Two callers hand the ladder its last rung — the periodic sweep
 * (`run_core_production_deps.ts`) and a child run's pre-cut sync
 * (`milestone_presync.ts`) — and both must bind it identically: the same repo
 * instructions, the same branch target, and above all the same timeout, which
 * is the grant the caller sized to the budget actually left rather than the
 * configured one (Issue #1693). A second copy of that wiring is a second place
 * for the promise the watchdog then breaks, so it is written once, here.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, WorkerConfig } from "../types.ts";
import type { SyncBranchOptions } from "./milestone_branch_sync.ts";
import type {
  MilestoneConflictAgentFn,
  MilestoneConflictAgentRequest,
} from "./milestone_conflict_ladder.ts";
import { runMergeConflictAgent } from "./merge_conflict_agent.ts";
import { runClaudeWithRetry } from "./claude_runner.ts";
import {
  buildQualityInstructions,
  getCustomInstructions,
} from "./repo_config.ts";

/** What the binding needs to know about the run offering the rung. */
export interface MilestoneConflictAgentBinding {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The grant this attempt was given; `agentAllowed: false` binds nothing. */
  grant: SyncBranchOptions;
  config: WorkerConfig;
  logger: Logger;
  /** The agent runner — `deps.claude.runClaudeWithRetry` in production. */
  runAgent?: typeof runClaudeWithRetry;
}

/**
 * Bind the resolution agent to a repository, or return undefined.
 *
 * Undefined is not a silent pass: a ladder handed no agent stops after the
 * deterministic rules and the conflict concludes `not-charged`, which is
 * exactly what `judgeSyncFailure` reads an ungranted rung as.
 *
 * @param binding - The repository, the grant and the run's bounds
 * @returns The agent rung, or undefined when the grant withheld it
 */
export function bindMilestoneConflictAgent(
  binding: MilestoneConflictAgentBinding,
): MilestoneConflictAgentFn | undefined {
  const { repo, grant, config, logger } = binding;
  if (!grant.agentAllowed) return undefined;
  const runAgent = binding.runAgent ?? runClaudeWithRetry;
  return (request: MilestoneConflictAgentRequest) =>
    runMergeConflictAgent({
      repo,
      target: { kind: "branch", intoBranch: request.milestoneBranch },
      baseBranch: request.defaultBranch,
      conflictedFiles: request.conflictedFiles,
      // It runs in the very clone the merge conflicted in.
      workDir: request.workDir,
      qualityInstructions: buildQualityInstructions(config.repoConfig, repo),
      customInstructions: getCustomInstructions(config.repoConfig, repo),
      timeouts: {
        // The grant sized to the budget actually left (Issue #1693), not the
        // configured timeout: an agent promised more time than the caller
        // holds is an agent the watchdog kills mid-edit.
        claudeTimeout: grant.agentTimeoutSeconds ?? config.claudeTimeout,
        claudeNoOutputTimeout: config.claudeNoOutputTimeout,
        maxRateLimitRetries: config.maxRateLimitRetries,
      },
      logger,
      runAgent,
    });
}
