/**
 * The gate and agent bindings a merge-only milestone sync runs with
 * (Issue #4326).
 *
 * When the ephemeral cargo root is still short of its budget after pruning,
 * the milestone sync lands without the repository's build rather than
 * deferring. Only a conflict-free merge lands unverified: the repository's CI
 * builds the merged tree on the milestone's PR, so the push is not held for a
 * build the host cannot afford. A conflicted merge is left for a cycle when the
 * budget holds, uncharged, because nothing about the conflict was judged.
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
 * - the resolution gate reports `failed`, so the resolved merge is reset and
 *   nothing is pushed, and `judgeSyncFailure` concludes a gate-failed conflict
 *   `not-charged`. Its detail carries {@link MERGE_ONLY_NO_BUILD}, which marks
 *   the refusal as the host's budget rather than a verdict on the resolution,
 *   so the gate-wedge ledger does not count it (Issue #4326);
 * - the agent reports the provider as unavailable, which the conflict ladder
 *   turns into `AGENT_PROVIDER_UNAVAILABLE`, and `judgeSyncFailure` concludes
 *   `disrupted` with nothing charged.
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
import type {
  MilestoneConflictAgentFn,
  MilestoneConflictAgentRequest,
} from "./milestone_conflict_ladder.ts";

/**
 * What a merge-only resolution-gate refusal says about the build it did not
 * run (Issue #4326). It is used verbatim inside that refusal's detail, and
 * `concludeGateRefusal` looks for it, so a refusal carrying it is never
 * counted against the branch as a gate that could not verify a resolution.
 */
export const MERGE_ONLY_NO_BUILD =
  "no repository build was run (host disk budget, merge-only)";

/** The three bindings a merge-only sync is run with. */
export interface MergeOnlyBindings {
  /**
   * Checks a conflict-free merge. A tree with a Cargo project reports
   * `skipped`, so it lands unverified; any other tree runs its own check.
   */
  mergeGate: MergeGateFn;
  /**
   * Checks a merge the worker resolved. A tree with a Cargo project reports
   * `failed`, so nothing lands; any other tree runs its own verification.
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
  // (Issue #4326). That is a fail-closed choice, not a silent pass.
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
        status: "failed",
        detail: "a merge the worker had to resolve is not verified, as " +
          `${MERGE_ONLY_NO_BUILD}; the host cannot afford the repository's ` +
          `build this cycle — ${reason}`,
        output: "",
      };
    },
    agentFn: async (request: MilestoneConflictAgentRequest) => {
      if (
        realAgent !== undefined && !(await holdsCargo(request.workDir))
      ) {
        return realAgent(request);
      }
      return {
        ok: true,
        value: {
          terminated: false,
          providerUnavailable: "no agent run, the host cannot afford a build " +
            `to verify it: ${reason}`,
        },
      };
    },
  };
}
