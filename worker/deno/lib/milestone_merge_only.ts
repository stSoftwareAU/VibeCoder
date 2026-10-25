/**
 * The gate and agent bindings a merge-only milestone sync runs with
 * (Issue #4326).
 *
 * When the ephemeral cargo root is still short of its budget after pruning,
 * the milestone sync lands without the repository's build rather than
 * deferring. The merge lands unverified: the repository's CI builds the merged
 * tree on the milestone's PR, so the push is not held for a build the host
 * cannot afford. That holds for a conflict-free merge and for a conflict the
 * deterministic rules settle. Only a conflict that needs the resolution agent
 * is left for a cycle when the budget holds, uncharged, because the agent is
 * free to run the very cargo build the host cannot afford.
 *
 * Only a cargo build writes to the ephemeral cargo root, so only a tree that
 * holds a Cargo project loses its check. Each binding decides at call time,
 * from the tree it is handed:
 *
 * - a tree with no Cargo project keeps its own checks exactly as they run in
 *   a normal sync (a Deno type check, a Deno unit suite, or the agent);
 * - a tree with a Cargo project takes the merge-only path below.
 *
 * The merge-only path reuses paths that already exist rather than inventing
 * new ones:
 *
 * - the merge gate reports `skipped`, which `git_pull.ts` pushes with an
 *   `UNGATED:` note (Issue #974);
 * - the resolution gate reports `skipped` with {@link MergeGateOutcome.landUnverified}
 *   set, which `judgeResolutionVerdict` lets through where it would otherwise
 *   turn `skipped` into a refusal, so a conflict the deterministic rules settled
 *   is pushed with the same `UNGATED:` note (Issue #4326). The merge commit
 *   still records which rung settled each file;
 * - the agent reports the provider as unavailable, which the conflict ladder
 *   turns into `AGENT_PROVIDER_UNAVAILABLE`, and `judgeSyncFailure` concludes
 *   `disrupted` with nothing charged. A conflict that needs the agent is
 *   therefore the one case that waits for a cycle with budget.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  checkMergedTree,
  findTypeCheckProjects as findProjectsInTree,
  type MergeGateFn,
  type TypeCheckProject,
} from "./milestone_merge_gate.ts";
import { verifyResolvedTree } from "./milestone_resolution_gate.ts";
import type { syncMilestoneBranchWithDefault } from "./git_pull.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import type { Logger } from "../types.ts";
import type {
  MilestoneConflictAgentFn,
  MilestoneConflictAgentRequest,
} from "./milestone_conflict_ladder.ts";

/** The three bindings a merge-only sync is run with. */
export interface MergeOnlyBindings {
  /**
   * Checks a conflict-free merge. A tree with a Cargo project reports
   * `skipped`, so it lands unverified; any other tree runs its own check.
   */
  mergeGate: MergeGateFn;
  /**
   * Checks a merge the worker resolved. A tree with a Cargo project reports
   * `skipped` with `landUnverified`, so a conflict the deterministic rules
   * settled lands unverified; any other tree runs its own verification.
   */
  resolutionGate: MergeGateFn;
  /**
   * The resolution agent. A tree with a Cargo project reports the provider
   * unavailable, so no run is made; any other tree runs the real agent.
   */
  agentFn: MilestoneConflictAgentFn;
}

/** The delegates a merge-only binding calls, injectable so tests can state them. */
export interface MergeOnlyDeps {
  /** The Issue #974 type check. Production: {@link checkMergedTree}. */
  checkMergedTree?: MergeGateFn;
  /** The Issue #1559 verification. Production: {@link verifyResolvedTree}. */
  verifyResolvedTree?: MergeGateFn;
  /** Lists the tree's projects. Production: `findTypeCheckProjects`. */
  findTypeCheckProjects?: (repoDir: string) => Promise<TypeCheckProject[]>;
}

/**
 * The bindings for a merge-only sync, or undefined when the sync is not
 * merge-only.
 *
 * Each binding decides at call time whether the tree it is handed holds a
 * Cargo project. Only one does the merge-only path; the rest delegate to the
 * repository's own checks, so a Deno-only repository is still verified.
 *
 * @param reason - Why the build was skipped (the budget verdict), or undefined
 *   when the build runs as usual
 * @param realAgent - The agent a tree without a Cargo project runs, or
 *   undefined when the grant withholds the agent rung
 * @param deps - Injected delegates (tests); production defaults otherwise
 * @returns The bindings that carry `reason` into each merge-only detail, or
 *   undefined when `reason` is undefined
 */
export function mergeOnlyBindings(
  reason: string | undefined,
  realAgent?: MilestoneConflictAgentFn,
  deps: MergeOnlyDeps = {},
): MergeOnlyBindings | undefined {
  if (reason === undefined) return undefined;
  const runCheckMergedTree = deps.checkMergedTree ?? checkMergedTree;
  const runVerifyResolvedTree = deps.verifyResolvedTree ?? verifyResolvedTree;
  const findProjects = deps.findTypeCheckProjects ?? findProjectsInTree;

  // Whether the tree holds a Cargo project. If the projects cannot be listed,
  // the tree is treated as holding one: the conservative path skips the build
  // rather than running a cargo build the host may not be able to afford
  // (Issue #4326). `findTypeCheckProjects` handles its own I/O errors, so this
  // is a guard against a listing that throws, reachable through the injected
  // listing; it does not make the merge safer, and the push says UNGATED.
  const holdsCargo = async (dir: string): Promise<boolean> => {
    try {
      return (await findProjects(dir)).some((p) => p.kind === "cargo");
    } catch {
      return true;
    }
  };

  return {
    mergeGate: async (repoDir) => {
      if (!(await holdsCargo(repoDir))) return runCheckMergedTree(repoDir);
      return {
        status: "skipped",
        detail: `the repository's build was left to its CI — ${reason}`,
        output: "",
      };
    },
    resolutionGate: async (repoDir) => {
      if (!(await holdsCargo(repoDir))) {
        return runVerifyResolvedTree(repoDir);
      }
      return {
        status: "skipped",
        detail: "a conflict resolved by the deterministic rules was left " +
          `to the repository's CI — ${reason}`,
        output: "",
        landUnverified: true,
      };
    },
    agentFn: async (request: MilestoneConflictAgentRequest) => {
      const cargo = await holdsCargo(request.workDir);
      if (!cargo && realAgent !== undefined) return realAgent(request);
      return {
        ok: true,
        value: {
          terminated: false,
          // A tree without a cargo project is not short of build budget: say
          // so rather than blame the host for an agent the grant withheld.
          providerUnavailable: cargo
            ? "no agent run, the host cannot afford a build to verify it: " +
              reason
            : "no agent run: the agent rung was not granted this cycle",
        },
      };
    },
  };
}

/** What {@link syncWithMergeOnlyBindings} runs the sync for. */
export interface MergeOnlySyncInput {
  /** The sync to run; production: `syncMilestoneBranchWithDefault`. */
  syncFn: typeof syncMilestoneBranchWithDefault;
  milestoneBranch: string;
  defaultBranch: string;
  /** Where the clone is. */
  options: GitCommandOptions;
  /** `owner/repo`, for the PR a refused push raises. */
  repo: string;
  /** The budget verdict when the sync is merge-only; undefined otherwise. */
  mergeOnly: string | undefined;
  /** The real agent rung, undefined when the grant withholds it. */
  agentFn: MilestoneConflictAgentFn | undefined;
  logger: Logger | undefined;
}

/**
 * Run a milestone sync with the gates and agent its budget calls for
 * (Issue #4326).
 *
 * The sweep and the pre-cut sync both end here, so the one place that swaps
 * the repository's gates for the merge-only ones is the one place a test
 * pins. A sync that is not merge-only gets the default gates (undefined) and
 * the real agent, exactly as before.
 *
 * @param input - The sync and the bindings to hand it
 * @returns What the sync returned
 */
export function syncWithMergeOnlyBindings(
  input: MergeOnlySyncInput,
): ReturnType<typeof syncMilestoneBranchWithDefault> {
  const bindings = mergeOnlyBindings(input.mergeOnly, input.agentFn);
  return input.syncFn(
    input.milestoneBranch,
    input.defaultBranch,
    input.options,
    // Named so the sync can raise a PR when a repository rule refuses the push.
    input.repo,
    // The default gates (the repository's own type check and the stricter
    // resolution gate derived from it) unless the sync is merge-only.
    bindings?.mergeGate,
    bindings?.resolutionGate,
    bindings !== undefined ? bindings.agentFn : input.agentFn,
    input.logger,
  );
}
