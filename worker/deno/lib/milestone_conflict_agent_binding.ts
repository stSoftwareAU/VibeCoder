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
import {
  gateRepairBudgetExhausted,
  MIN_GATE_REPAIR_SECONDS,
} from "./milestone_gate_repair.ts";
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
  /** Reads the clock. Injected in tests so the grant ledger is deterministic. */
  now?: () => number;
  /** Override the prompts directory (tests); production resolves its own. */
  promptsDir?: string;
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
  const now = binding.now ?? (() => Date.now());
  // The grant is a budget for the whole cycle's agent work, not per run
  // (Issue #1965): a gate repair is a second run against the same grant, so
  // what it may have is what the first run and the verification between them
  // left. A pass that stated no deadline granted no bound, and stays
  // unbounded.
  const grantSeconds = grant.agentTimeoutSeconds;
  let grantStartedAtMs: number | undefined;
  return (request: MilestoneConflictAgentRequest) => {
    let claudeTimeout = config.claudeTimeout;
    if (grantSeconds !== undefined) {
      grantStartedAtMs ??= now();
      const spentSeconds = Math.floor((now() - grantStartedAtMs) / 1000);
      const remaining = grantSeconds - spentSeconds;
      if (request.repair && remaining < MIN_GATE_REPAIR_SECONDS) {
        // Refused by name, so the sync reports a repair that was never
        // attempted rather than one that failed.
        return Promise.resolve({
          ok: false as const,
          error: gateRepairBudgetExhausted(
            `the cycle's agent grant of ${grantSeconds}s has ` +
              `${Math.max(0, remaining)}s left, and a repair run needs at ` +
              `least ${MIN_GATE_REPAIR_SECONDS}s (Issues #1693, #1965)`,
          ),
        });
      }
      // A repair takes what the first run and the verification left; the
      // resolution run itself keeps the whole grant, exactly as before.
      if (request.repair) claudeTimeout = remaining;
      else claudeTimeout = grantSeconds;
    }
    return runMergeConflictAgent({
      repo,
      target: { kind: "branch", intoBranch: request.milestoneBranch },
      baseBranch: request.defaultBranch,
      conflictedFiles: request.conflictedFiles,
      // It runs in the very clone the merge conflicted in.
      workDir: request.workDir,
      ...(binding.promptsDir ? { promptsDir: binding.promptsDir } : {}),
      qualityInstructions: buildQualityInstructions(config.repoConfig, repo),
      customInstructions: getCustomInstructions(config.repoConfig, repo),
      timeouts: {
        // The grant sized to the budget actually left (Issue #1693), not the
        // configured timeout: an agent promised more time than the caller
        // holds is an agent the watchdog kills mid-edit. A repair gets what
        // is left of that same grant (Issue #1965).
        claudeTimeout,
        claudeNoOutputTimeout: config.claudeNoOutputTimeout,
        maxRateLimitRetries: config.maxRateLimitRetries,
      },
      logger,
      // Issue #1965: present only for a repair run, and what makes the
      // prompt the repair prompt.
      ...(request.repair ? { repair: request.repair } : {}),
      runAgent,
    });
  };
}
