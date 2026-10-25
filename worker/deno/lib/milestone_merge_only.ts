/**
 * Budget-limited milestone sync bindings (Issue #4326).
 * Cargo builds wait for CI; the repository gates still check and test every
 * Deno project, including mixed Cargo/Deno trees. A cargo-only tree may land
 * unverified after deterministic conflict resolution. The agent remains
 * withheld on cargo trees because it may launch an unaffordable cargo build.
 * Australian English throughout.
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
   * Checks a conflict-free merge. Cargo is skipped; Deno projects retain their checks.
   */
  mergeGate: MergeGateFn;
  /**
   * Checks a merge the worker resolved. Only a cargo-only tree may report
   * `skipped` with `landUnverified`; Deno verification stays required.
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
  checkMergedTree?: typeof checkMergedTree;
  /** The Issue #1559 verification. Production: {@link verifyResolvedTree}. */
  verifyResolvedTree?: typeof verifyResolvedTree;
  /** Lists the tree's projects. Production: `findTypeCheckProjects`. */
  findTypeCheckProjects?: (repoDir: string) => Promise<TypeCheckProject[]>;
}

/**
 * The bindings for a merge-only sync, or undefined when the sync is not
 * merge-only.
 *
 * Each binding decides at call time whether the tree it is handed holds a
 * Cargo project. The repository gates skip cargo only; all Deno projects
 * still require their own checks and verification.
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

  // An unlistable tree cannot safely be handed to an agent that may run cargo.
  // The gates below still require their own checks; resolution fails closed
  // when the project listing is unavailable.
  const holdsCargo = async (dir: string): Promise<boolean> => {
    try {
      return (await findProjects(dir)).some((p) => p.kind === "cargo");
    } catch {
      return true;
    }
  };

  return {
    mergeGate: async (repoDir) => {
      const outcome = await runCheckMergedTree(
        repoDir,
        undefined,
        () => Promise.resolve(true),
      );
      return outcome.status === "skipped"
        ? { ...outcome, detail: `${outcome.detail} — ${reason}` }
        : outcome;
    },
    resolutionGate: async (repoDir) => {
      const projects = await findProjects(repoDir).catch(() => undefined);
      if (projects === undefined) {
        return {
          status: "failed",
          detail: "could not list projects — resolution remains unverified",
          output: "",
        };
      }
      const outcome = await runVerifyResolvedTree(
        repoDir,
        undefined,
        (dir) =>
          runCheckMergedTree(dir, undefined, () => Promise.resolve(true)),
        undefined,
        () => Promise.resolve(true),
      );
      const cargoOnly = projects.length > 0 &&
        projects.every((p) => p.kind === "cargo");
      return outcome.status === "skipped" && cargoOnly
        ? {
          ...outcome,
          detail: `${outcome.detail} — ${reason}`,
          landUnverified: true,
        }
        : outcome;
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
