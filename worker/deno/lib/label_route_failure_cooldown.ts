/**
 * Escalating retry cooldown for the label routes that record a failure through
 * `handleIssueFailure` — planning and question (Issue #5376).
 *
 * The failure record they post promises the 2 h → 6 h → 24 h cooldown the
 * coding path records (Issues #1949, #4158). These routes ran outside that
 * path and recorded nothing, so a failing planning issue was re-run every
 * cycle.
 */

import type { Logger } from "../types.ts";
import {
  type CooldownConfig,
  type CooldownFailureKind,
  isHeldByCooldown,
  loadState,
  recordIssueCooldown,
} from "./cooldown_state.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";

/** A label route's view of the escalating failure cooldown. */
export interface LabelRouteFailureCooldown {
  /** Whether the issue's escalating cooldown holds it off this scan. */
  isHeld: (repo: string, issueNumber: number) => boolean;
  /**
   * The worker deps whose `github.handleIssueFailure` also records the
   * cooldown.
   */
  workerDeps: WorkerDeps;
}

/**
 * Load the cooldown state once and wrap `handleIssueFailure` so a recorded
 * failure also records the cooldown it promises. The passed deps are not
 * mutated.
 */
export async function prepareLabelRouteFailureCooldown(input: {
  cooldownConfig: CooldownConfig;
  workerDeps: WorkerDeps;
  logger: Logger;
}): Promise<LabelRouteFailureCooldown> {
  const { cooldownConfig, workerDeps, logger } = input;
  const state = await loadState(
    cooldownConfig.workDir,
    cooldownConfig.issueRetryCooldown,
  );

  const record = async (
    repo: string,
    issueNumber: number,
    kind: CooldownFailureKind,
  ): Promise<void> => {
    const outcome = await recordIssueCooldown(
      cooldownConfig,
      repo,
      issueNumber,
      kind,
    );
    if (!outcome.ok) {
      logger.warn(
        `Could not record the failure cooldown for ${repo}#${issueNumber}: ` +
          outcome.error.message,
      );
    }
  };

  const original = workerDeps.github.handleIssueFailure;
  const wrapped: WorkerDeps["github"]["handleIssueFailure"] = async (
    ...args
  ) => {
    const [options] = args;
    let result;
    try {
      result = await original(...args);
    } catch (err) {
      // The run failed regardless of what the record call did.
      await record(options.repo, options.issueNumber, "non_transient");
      throw err;
    }
    if (!result.ok) {
      await record(options.repo, options.issueNumber, "non_transient");
    } else if (result.value.markedAsFailedOnce) {
      await record(
        options.repo,
        options.issueNumber,
        result.value.failureCategory === "timeout"
          ? "timeout"
          : "non_transient",
      );
    }
    // Otherwise no failure record was posted (scheduled release, token scope,
    // host disk, clone corrupt, repo config): nothing to pace.
    return result;
  };

  return {
    // Escalating only: a flat entry (a coding-route skip) must not delay a
    // fresh hand-off; only a failure record carries the promised cooldown.
    isHeld: (repo, issueNumber) =>
      isHeldByCooldown(
        state,
        cooldownConfig.issueRetryCooldown,
        repo,
        issueNumber,
        { escalatingOnly: true },
      ),
    workerDeps: {
      ...workerDeps,
      github: { ...workerDeps.github, handleIssueFailure: wrapped },
    },
  };
}
