/**
 * The milestone sync's conflict ladder (Issue #1777).
 *
 * The PR pass climbs three rungs before it gives up on a conflict: the
 * deterministic triage, the dependency rules, then the resolution agent. The
 * milestone sync stopped at the first — a single `rival-designs` file aborted
 * the whole merge, and #1754, #1756 and #1764 were three-to-six-line hunks
 * escalated that way. This module is the two rungs the sync was missing,
 * applied only to the paths the triage could not decide.
 *
 * Nothing here judges the merge: it reports which rung decided each file so
 * the merge commit, the log and the sync's report all name it, and a rung that
 * fails is returned as a still-escalated file rather than swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import type { FileDecision } from "./milestone_conflict_triage.ts";
import {
  applyDependencyConflictRules,
  type ConflictGitRunner,
  type DependencyRuleApplier,
} from "./dependency_conflict_apply.ts";
import type { MergeConflictAgentOutcome } from "./merge_conflict_agent.ts";

/** One agent run asked for by the milestone sync. */
export interface MilestoneConflictAgentRequest {
  /** Paths the triage and the dependency rules both left undecided. */
  conflictedFiles: readonly string[];
  /** The branch the default branch is being merged into. */
  milestoneBranch: string;
  /** The branch being merged in. */
  defaultBranch: string;
  /** The clone the conflicted merge is in progress in. */
  workDir: string;
}

/**
 * The agent rung, injected so a test needs no model (Issue #1777).
 *
 * Production binds this to `runMergeConflictAgent` with a branch target; a
 * sync given none simply stops after the rules, which is the pre-#1777
 * behaviour rather than a silent pass.
 */
export type MilestoneConflictAgentFn = (
  request: MilestoneConflictAgentRequest,
) => Promise<Result<MergeConflictAgentOutcome>>;

/** What the ladder is asked to climb. */
export interface ConflictLadderInput {
  /** The triage's undecided files, in the order it reported them. */
  escalations: readonly FileDecision[];
  /** Git options; `cwd` is the clone holding the conflicted merge. */
  options: GitCommandOptions;
  milestoneBranch: string;
  defaultBranch: string;
  /** The agent rung; absent stops the ladder after the rules. */
  agentFn?: MilestoneConflictAgentFn;
  /** The rules rung; defaults to the shared dependency rules. */
  applyRulesFn?: DependencyRuleApplier;
  logger?: Logger;
}

/** Which files the ladder settled, and which still need a human. */
export interface ConflictLadderOutcome {
  /** Settled by a rung below the human, each naming the rung that did it. */
  resolved: FileDecision[];
  /** Still for a human, each reason naming the rung that could not decide. */
  escalations: FileDecision[];
}

/** Bind a {@link ConflictGitRunner} to the clone the merge is in. */
function gitRunner(options: GitCommandOptions): ConflictGitRunner {
  return async (args) => {
    const result = await runGitCommand([...args], options);
    // "Could not run git" is not "git was happy" — fold a spawn failure into
    // a non-zero code rather than an empty success.
    return result.ok
      ? {
        code: result.value.code,
        stdout: result.value.stdout,
        stderr: result.value.stderr,
      }
      : { code: 1, stdout: "", stderr: result.error.message };
  };
}

/** Paths git still reports as unmerged, restricted to those given. */
async function stillUnmerged(
  paths: readonly string[],
  options: GitCommandOptions,
): Promise<string[]> {
  if (paths.length === 0) return [];
  const result = await runGitCommand(
    ["diff", "--name-only", "--diff-filter=U", "--", ...paths],
    options,
  );
  return result.ok
    ? result.value.stdout.trim().split("\n").filter(Boolean)
    : [];
}

/**
 * Whether any of the given paths still carries a conflict marker.
 *
 * A staged file full of `<<<<<<<` is resolved as far as the index is
 * concerned and broken as far as everything else is concerned, so it is
 * checked before the resolution is committed.
 */
export async function hasConflictMarkers(
  paths: readonly string[],
  options: GitCommandOptions,
): Promise<boolean> {
  if (paths.length === 0) return false;
  const result = await runGitCommand(
    ["grep", "-l", "-I", "-E", "^(<<<<<<<|>>>>>>>) ", "--", ...paths],
    options,
  );
  return result.ok && result.value.code === 0 &&
    result.value.stdout.trim().length > 0;
}

/**
 * Climb the rules rung, then the agent rung, over the triage's leftovers.
 *
 * The rules run first because a lock file or a manifest needs no judgement —
 * asking the agent to re-reason about a file a rule already staged spends a
 * model run on a decided question. Whatever the rules defer is the agent's,
 * narrowed to exactly those paths.
 *
 * @param input - The undecided files and the rungs to try
 * @returns What each rung settled, and what is left for a human
 */
export async function climbConflictLadder(
  input: ConflictLadderInput,
): Promise<ConflictLadderOutcome> {
  const {
    escalations,
    options,
    milestoneBranch,
    defaultBranch,
    agentFn,
    applyRulesFn = applyDependencyConflictRules,
    logger,
  } = input;

  if (escalations.length === 0) return { resolved: [], escalations: [] };

  const byPath = new Map(escalations.map((d) => [d.path, d]));
  const resolved: FileDecision[] = [];

  // --- Rung 2: the deterministic dependency rules ---------------------------
  const ruleReport = await applyRulesFn({
    workingDir: options.cwd ?? ".",
    conflictedFiles: escalations.map((d) => d.path),
    git: gitRunner(options),
    logger: logger
      ? {
        warn: (message, context) => logger.warn(message, context),
        info: (message, context) => logger.info(message, context),
      }
      : undefined,
  });

  for (const file of ruleReport.resolved) {
    const decision = byPath.get(file.path);
    if (!decision) continue;
    resolved.push({
      ...decision,
      action: "resolved",
      rung: "rule",
      reason: `${
        file.kind === "lock" ? "lock file" : "manifest"
      } resolved by ${file.resolvedBy}`,
    });
  }

  const deferred = ruleReport.deferred
    .map((file) => file.path)
    .filter((path) => byPath.has(path));
  if (deferred.length === 0) return { resolved, escalations: [] };

  // --- Rung 3: the resolution agent ----------------------------------------
  const stillEscalated = (reason: (path: string) => string): FileDecision[] =>
    deferred.map((path) => {
      const decision = byPath.get(path)!;
      return { ...decision, action: "escalate", reason: reason(path) };
    });

  if (!agentFn) {
    return {
      resolved,
      escalations: stillEscalated((path) =>
        `${byPath.get(path)!.reason} — and no resolution agent was available ` +
        `to this sync (Issue #1777)`
      ),
    };
  }

  logger?.info(
    "Milestone sync: handing the remaining conflicts to the agent (Issue #1777)",
    { milestoneBranch, defaultBranch, conflictedFiles: deferred },
  );
  const outcome = await agentFn({
    conflictedFiles: deferred,
    milestoneBranch,
    defaultBranch,
    workDir: options.cwd ?? ".",
  });

  if (!outcome.ok) {
    return {
      resolved,
      escalations: stillEscalated(() => `agent: ${outcome.error.message}`),
    };
  }
  if (outcome.value.terminated) {
    // The worker itself ended the run, so the tree is half-edited through no
    // fault of the conflict. Not a verdict — the merge is abandoned and the
    // branch is left where it was (Issue #1693).
    return {
      resolved,
      escalations: stillEscalated(() =>
        `agent: the run was ended by the worker before it finished ` +
        `(Issue #1693)`
      ),
    };
  }

  // Stage exactly what the agent was asked to resolve. Never `git add -A`:
  // the shared clone carries the worker's own state files, and staging those
  // is what the pre-commit gate refuses (Issue #1654).
  const staged = await runGitCommand(["add", "--", ...deferred], options);
  if (!staged.ok || staged.value.code !== 0) {
    const detail = (staged.ok ? staged.value.stderr : staged.error.message)
      .trim();
    return {
      resolved,
      escalations: stillEscalated(() =>
        `agent: its resolution could not be staged: ${
          detail || "git reported no stderr"
        }`
      ),
    };
  }

  const unmerged = await stillUnmerged(deferred, options);
  if (unmerged.length > 0) {
    return {
      resolved,
      escalations: stillEscalated(() =>
        `agent: it left ${unmerged.length} path(s) unmerged: ${
          unmerged.join(", ")
        }`
      ),
    };
  }
  if (await hasConflictMarkers(deferred, options)) {
    return {
      resolved,
      escalations: stillEscalated(() =>
        `agent: its resolution still contains conflict markers`
      ),
    };
  }

  for (const path of deferred) {
    resolved.push({
      ...byPath.get(path)!,
      action: "resolved",
      rung: "agent",
      reason: "resolved by the merge-conflict agent",
    });
  }
  return { resolved, escalations: [] };
}
