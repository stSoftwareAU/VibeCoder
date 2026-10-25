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
 * The bindings reuse paths that already exist rather than inventing new ones:
 *
 * - the merge gate reports `skipped`, which `git_pull.ts` pushes with an
 *   `UNGATED:` note (Issue #974);
 * - the resolution gate reports `failed`, so the resolved merge is reset and
 *   nothing is pushed, and `judgeSyncFailure` concludes a gate-failed conflict
 *   `not-charged`;
 * - the agent reports the provider as unavailable, which the conflict ladder
 *   turns into `AGENT_PROVIDER_UNAVAILABLE`, and `judgeSyncFailure` concludes
 *   `disrupted` with nothing charged.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { MergeGateFn } from "./milestone_merge_gate.ts";
import type { MilestoneConflictAgentFn } from "./milestone_conflict_ladder.ts";

/** The three bindings a merge-only sync is run with. */
export interface MergeOnlyBindings {
  /** Checks a conflict-free merge; reports `skipped` so it lands unverified. */
  mergeGate: MergeGateFn;
  /** Checks a merge the worker resolved; reports `failed`, so nothing lands. */
  resolutionGate: MergeGateFn;
  /** The resolution agent; reports the provider unavailable, so no run is made. */
  agentFn: MilestoneConflictAgentFn;
}

/**
 * The bindings for a merge-only sync, or undefined when the sync is not
 * merge-only.
 *
 * @param reason - Why the build was skipped (the budget verdict), or undefined
 *   when the build runs as usual
 * @returns The bindings that carry `reason` into each gate's detail, or
 *   undefined when `reason` is undefined
 */
export function mergeOnlyBindings(
  reason: string | undefined,
): MergeOnlyBindings | undefined {
  if (reason === undefined) return undefined;
  return {
    mergeGate: async () => ({
      status: "skipped",
      detail: `the repository's build was left to its CI — ${reason}`,
      output: "",
    }),
    resolutionGate: async () => ({
      status: "failed",
      detail: "a merge the worker had to resolve needs the repository's " +
        "build to verify it, and the host cannot afford one this cycle — " +
        `${reason}`,
      output: "",
    }),
    agentFn: async () => ({
      ok: true,
      value: {
        terminated: false,
        providerUnavailable: "no agent run, the host cannot afford a build " +
          `to verify it: ${reason}`,
      },
    }),
  };
}
