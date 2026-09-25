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
  portedDecision,
  type PortedFn,
  resolvePortedPaths,
  type ShapeThresholds,
} from "./milestone_conflict_ported.ts";
import {
  applyDependencyConflictRules,
  type ConflictGitRunner,
  type DependencyRuleApplier,
} from "./dependency_conflict_apply.ts";
import type {
  MergeConflictAgentOutcome,
  MergeConflictRepairContext,
} from "./merge_conflict_agent.ts";
import { unstageWorkerStateFiles } from "./git_push.ts";
import { readPrResponseMessage } from "./pr_branch_preparation.ts";
import { assertSafeToCommit } from "./pre_commit_safety.ts";
import { describeGitFailure } from "./milestone_merge_state.ts";
import type { ConflictStageTimer } from "./conflict_stage_timer.ts";

/**
 * The reason the agent rung leaves when the **worker** ended the run — the
 * watchdog's SIGTERM at the cycle deadline, not the agent's own ceiling
 * (Issue #1693).
 *
 * Spelled once here because `judgeSyncFailure` reads it back to tell a kill
 * from a judged failure: a kill concludes `disrupted` and is charged nothing,
 * while an agent that ran out its own timeout is a failed attempt like any
 * other (Issue #2305).
 */
export const AGENT_RUN_ENDED_BY_WORKER =
  "the run was ended by the worker before it finished";

/**
 * Why the agent rung stopped when the provider refused the run — a 402
 * insufficient balance, an auth failure or an exhausted 429/5xx. Read back by
 * `judgeSyncFailure`, which concludes it `disrupted`: nothing is charged, no
 * roll-back runs and the next cycle retries once the provider answers
 * (Issue #2613).
 */
export const AGENT_PROVIDER_UNAVAILABLE = "the agent provider was unavailable";

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
  /**
   * Set when this run repairs a resolution the verification refused
   * (Issue #1965) rather than resolving the conflict itself. The merge is
   * already committed in the clone; what the run answers is the gate's
   * failing command and its output.
   */
  repair?: MergeConflictRepairContext;
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
  /**
   * The ported rung (Issue #2023); defaults to the real one. Runs between
   * the rules and the agent, settles only the paths whose other side
   * provably absorbed them, and leaves the rest for the agent.
   */
  portedFn?: PortedFn;
  /** When a conflict's shape is logged as wrong-base; defaults apply. */
  shapeThresholds?: ShapeThresholds;
  /**
   * The sync's stage timer (Issue #2308). The ladder times its `rules` and
   * `agent` rungs into it; absent, nothing is timed and the ladder behaves
   * exactly as before.
   */
  timer?: ConflictStageTimer;
  logger?: Logger;
}

/** Which files the ladder settled, and which still need a human. */
export interface ConflictLadderOutcome {
  /** Settled by a rung below the human, each naming the rung that did it. */
  resolved: FileDecision[];
  /** Still for a human, each reason naming the rung that could not decide. */
  escalations: FileDecision[];
  /**
   * What the agent rung wrote into `.pr_response_message` (Issue #2306).
   *
   * The agent names every judgement call file by file there, and on this
   * path there is no PR comment to carry them — so the reply travels with
   * the outcome and lands on the sync report instead. Absent when no agent
   * ran, or when it wrote nothing.
   */
  agentReply?: string;
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

/**
 * Paths git reports as unmerged, over the whole tree or the paths given.
 *
 * A listing git could not produce is an error, never an empty list: "the
 * check could not run" read as "nothing is unmerged" is exactly the silent
 * pass that lets a half-resolved tree be committed.
 *
 * @param options - Git options; `cwd` is the clone holding the merge
 * @param paths - Restrict the listing to these paths; empty means the tree
 * @returns The unmerged paths, or the failure that stopped the listing
 */
export async function listUnmergedPaths(
  options: GitCommandOptions,
  paths: readonly string[] = [],
): Promise<Result<string[]>> {
  const result = await runGitCommand(
    [
      "diff",
      "--name-only",
      "--diff-filter=U",
      ...(paths.length > 0 ? ["--", ...paths] : []),
    ],
    options,
  );
  if (!result.ok || result.value.code !== 0) {
    const detail = (result.ok ? result.value.stderr : result.error.message)
      .trim();
    return {
      ok: false,
      error: new Error(
        `the unmerged paths could not be listed: ${
          detail || `git exited ${result.ok ? result.value.code : 1}`
        }`,
      ),
    };
  }
  return {
    ok: true,
    value: result.value.stdout.trim().split("\n").filter(Boolean),
  };
}

/**
 * Whether any of the given paths still carries a conflict marker.
 *
 * A staged file full of `<<<<<<<` is resolved as far as the index is
 * concerned and broken as far as everything else is concerned, so it is
 * checked before the resolution is committed. `git grep` exits 1 for "no
 * match" and 2 or more for a real failure, so the two are told apart rather
 * than both read as a clean tree.
 *
 * @param paths - The paths to check; empty checks nothing and reports none
 * @param options - Git options; `cwd` is the clone holding the merge
 * @returns Whether a marker was found, or the failure that stopped the check
 */
export async function hasConflictMarkers(
  paths: readonly string[],
  options: GitCommandOptions,
): Promise<Result<boolean>> {
  if (paths.length === 0) return { ok: true, value: false };
  const result = await runGitCommand(
    ["grep", "-l", "-I", "-E", "^(<<<<<<<|>>>>>>>) ", "--", ...paths],
    options,
  );
  if (!result.ok || result.value.code > 1) {
    const detail = (result.ok ? result.value.stderr : result.error.message)
      .trim();
    return {
      ok: false,
      error: new Error(
        `the conflict-marker check could not be run: ${
          detail || `git exited ${result.ok ? result.value.code : 1}`
        }`,
      ),
    };
  }
  return {
    ok: true,
    value: result.value.code === 0 && result.value.stdout.trim().length > 0,
  };
}

/**
 * Stage what the agent produced, exactly as `commitAndPushPending` would.
 *
 * `git add -- <the conflicted paths>` is not enough: an agent that resolves a
 * collision by extracting a helper leaves that new file unstaged, so the
 * merge commit would carry a tree the resolution gate never verified. So the
 * whole working tree is staged, the worker's own state files come straight
 * back out (Issue #1654 — a stray `.heartbeat_*` in the shared clone must not
 * cost the commit), and the pre-commit safety gate then refuses any hidden or
 * secret-bearing path exactly as it does on every other commit path.
 *
 * The gate-repair rung stages the same way (Issue #1965): a repair that adds
 * a file is the same shape as a resolution that extracts a helper.
 *
 * @param options - Git options; `cwd` is the clone holding the merge
 * @returns Nothing on success, or the failure that stopped the staging
 */
export async function stageAgentResolution(
  options: GitCommandOptions,
): Promise<Result<void>> {
  const added = await runGitCommand(["add", "-A"], options);
  if (!added.ok || added.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `its resolution could not be staged: ${describeGitFailure(added)}`,
      ),
    };
  }

  const unstaged = await unstageWorkerStateFiles(options);
  if (!unstaged.ok) return { ok: false, error: unstaged.error };
  if (unstaged.value.remainingStaged === 0) {
    return { ok: true, value: undefined };
  }

  const safe = await assertSafeToCommit(options);
  return safe.ok ? { ok: true, value: undefined } : safe;
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
    portedFn = resolvePortedPaths,
    shapeThresholds,
    timer,
    logger,
  } = input;

  if (escalations.length === 0) return { resolved: [], escalations: [] };

  const byPath = new Map(escalations.map((d) => [d.path, d]));
  const resolved: FileDecision[] = [];

  // --- Rung 2: the deterministic dependency rules ---------------------------
  timer?.start("rules");
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
  timer?.stop();

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

  // --- Rung 2b: history — the "ported" rule (Issue #2023) -----------------
  // Ninety files with add/add pairs across directories is not a set of hunks
  // to read; it is a branch whose content the default branch already
  // absorbed under different history. For each path, if the other branch's
  // history carries this side's exact version, the other side contains ours
  // and is taken. The paths it cannot prove stay the agent's, as before.
  const ported = await portedFn({
    paths: deferred,
    options,
    milestoneBranch,
    defaultBranch,
    ...(shapeThresholds ? { thresholds: shapeThresholds } : {}),
    log: (message) => logger?.info(message, { milestoneBranch, defaultBranch }),
  });
  for (const settled of ported.resolved) {
    const decision = byPath.get(settled.path);
    if (!decision) continue;
    resolved.push(portedDecision(decision, settled, defaultBranch));
  }
  const stillDeferred = ported.undecided.map((u) => u.path);
  if (stillDeferred.length === 0) return { resolved, escalations: [] };
  if (ported.resolved.length > 0) {
    logger?.info(
      "Milestone sync: the ported rule settled some paths; the rest go on " +
        "up the ladder (Issue #2023)",
      { milestoneBranch, defaultBranch, remaining: stillDeferred },
    );
  }
  deferred.length = 0;
  deferred.push(...stillDeferred);
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
  timer?.start("agent");
  const outcome = await agentFn({
    conflictedFiles: deferred,
    milestoneBranch,
    defaultBranch,
    workDir: options.cwd ?? ".",
  });
  timer?.stop();

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
        `agent: ${AGENT_RUN_ENDED_BY_WORKER} (Issue #1693)`
      ),
    };
  }
  const providerError = outcome.value.providerUnavailable;
  if (providerError !== undefined) {
    // The provider refused the run, so the conflict was never looked at. Not
    // a verdict either — leave the branch and retry later (Issue #2613).
    return {
      resolved,
      escalations: stillEscalated(() =>
        `agent: ${AGENT_PROVIDER_UNAVAILABLE} — ${providerError} (Issue #2613)`
      ),
    };
  }

  // Read the index BEFORE staging anything. `git add` on a conflicted path is
  // how a conflict is marked resolved, so staging first would answer this
  // question with its own side effect — and an agent that touched nothing
  // would have the working-tree side committed as if it had decided.
  const unmerged = await listUnmergedPaths(options, deferred);
  if (!unmerged.ok) {
    return {
      resolved,
      escalations: stillEscalated(() =>
        `agent: its resolution could not be verified — ${unmerged.error.message}`
      ),
    };
  }
  if (unmerged.value.length > 0) {
    return {
      resolved,
      escalations: stillEscalated(() =>
        `agent: it left ${unmerged.value.length} path(s) unmerged: ${
          unmerged.value.join(", ")
        }`
      ),
    };
  }
  const markers = await hasConflictMarkers(deferred, options);
  if (!markers.ok) {
    return {
      resolved,
      escalations: stillEscalated(() =>
        `agent: its resolution could not be verified — ${markers.error.message}`
      ),
    };
  }
  if (markers.value) {
    return {
      resolved,
      escalations: stillEscalated(() =>
        `agent: its resolution still contains conflict markers`
      ),
    };
  }

  const staged = await stageAgentResolution(options);
  if (!staged.ok) {
    return {
      resolved,
      escalations: stillEscalated(() => `agent: ${staged.error.message}`),
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
  // Read after staging, so consuming the reply file cannot change what the
  // commit carries: `stageAgentResolution` has already taken the worker's
  // own state files back out of the index (Issue #1654).
  const agentReply = await readPrResponseMessage(options.cwd, logger);
  return {
    resolved,
    escalations: [],
    ...(agentReply ? { agentReply } : {}),
  };
}
