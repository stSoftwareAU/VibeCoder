/**
 * Should the default-branch ruleset use a GitHub merge queue? (Issue #4424)
 *
 * Combines the three merge-queue checks in the order that costs least, and
 * stops at the first answer that is not `enabled`:
 *
 *   1. the per-repository opt-out topic ({@link MERGE_QUEUE_OPT_OUT_TOPIC});
 *   2. GitHub's availability answer ({@link detectMergeQueueAvailability});
 *   3. whether every required check reports on `merge_group`
 *      ({@link checkRepoMergeGroupCoverage}).
 *
 * Only `enabled` carries queue parameters. `unverified` is not a refusal: it
 * means a read could not be completed, and the configurator then keeps any
 * queue already live rather than weakening enforcement on a transient failure.
 *
 * This module decides and explains; writing the rule is the configurator's job
 * (`default_branch_ruleset.ts`). It never throws.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import {
  buildMergeQueueParameters,
  detectMergeQueueAvailability,
  MERGE_QUEUE_OPT_OUT_TOPIC,
  readMergeQueueOptOut,
} from "./merge_queue.ts";
import { checkRepoMergeGroupCoverage } from "./merge_queue_workflows.ts";
import type { GhExec, MergeQueueParameters } from "./repo_rulesets.ts";

/** What the merge queue decision came to. */
export type MergeQueueVerdict =
  /** GitHub allows a queue here and every required check reports on it. */
  | "enabled"
  /** The repository carries the opt-out topic. Definitive. */
  | "opted-out"
  /** GitHub does not allow a merge queue here. Definitive. */
  | "unavailable"
  /** A required check's workflow lacks the `merge_group` trigger. Definitive. */
  | "missing-merge-group"
  /** A read could not be completed, so the answer is not known. */
  | "unverified";

/** The outcome of {@link decideMergeQueue}. */
export interface MergeQueueDecision {
  verdict: MergeQueueVerdict;
  /** Set if and only if `verdict` is `enabled`. */
  parameters?: MergeQueueParameters;
  /** A human sentence naming the cause; logged when the worker falls back. */
  reason: string;
  /** False only for `unverified`. */
  definitive: boolean;
}

/** The message of a thrown value, for a human-readable reason. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unverified(reason: string): MergeQueueDecision {
  return { verdict: "unverified", reason, definitive: false };
}

async function decide(
  repo: string,
  branch: string,
  requiredContexts: readonly string[],
  ghFn: GhExec,
): Promise<MergeQueueDecision> {
  const optOut = await readMergeQueueOptOut(repo, ghFn);
  if (!optOut.ok) {
    return unverified(
      `the "${MERGE_QUEUE_OPT_OUT_TOPIC}" topic could not be read: ${optOut.error}`,
    );
  }
  if (optOut.optedOut) {
    return {
      verdict: "opted-out",
      reason: `the repository has the "${MERGE_QUEUE_OPT_OUT_TOPIC}" topic`,
      definitive: true,
    };
  }

  const availability = await detectMergeQueueAvailability(repo, ghFn);
  if (availability.status === "unavailable") {
    return {
      verdict: "unavailable",
      reason: availability.reason,
      definitive: true,
    };
  }
  if (availability.status === "unknown") return unverified(availability.reason);

  const coverage = await checkRepoMergeGroupCoverage(
    repo,
    branch,
    requiredContexts,
    ghFn,
  );
  if (coverage.status === "missing") {
    return {
      verdict: "missing-merge-group",
      reason: coverage.reason,
      definitive: true,
    };
  }
  if (coverage.status === "unknown") return unverified(coverage.reason);

  return {
    verdict: "enabled",
    parameters: buildMergeQueueParameters(availability.mergeMethod),
    reason:
      `${availability.reason}; every required check reports on merge_group`,
    definitive: true,
  };
}

/**
 * Whether the default-branch ruleset of `repo` should carry a merge queue.
 *
 * `requiredContexts` are the status checks the ruleset will require, since
 * each must report on `merge_group` for the queue to work. Never throws: any
 * failure that escapes the checks is `unverified`, with a reason.
 */
export async function decideMergeQueue(
  repo: string,
  branch: string,
  requiredContexts: readonly string[],
  ghFn: GhExec,
): Promise<MergeQueueDecision> {
  try {
    return await decide(repo, branch, requiredContexts, ghFn);
  } catch (error) {
    return unverified(
      `the merge queue could not be decided: ${messageOf(error)}`,
    );
  }
}
