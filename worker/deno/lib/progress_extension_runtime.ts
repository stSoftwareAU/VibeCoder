/**
 * Wiring for the re-armable hard deadline (Issue #4296, part of #4290).
 *
 * The policy (`progress_extension.ts`) is pure and the runner
 * (`claude_runner.ts`) takes an injected probe, so this module is the one
 * place that joins them to the real working tree and the worker config. Only
 * issue work calls it; every other phase passes no option and keeps its
 * unconditional timeout.
 *
 * The probe is stateful by necessity: "advanced" means *since the previous
 * check*, so a baseline fingerprint is taken before the agent starts and each
 * check compares against the fingerprint taken at the check before it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  ProgressExtensionOptions,
  TreeProgressState,
} from "./progress_extension.ts";
import type { RunDeadlineReporter } from "./run_deadline.ts";
import {
  compareWorktreeFingerprints,
  probeWorktreeFingerprint,
  type WorktreeFingerprint,
} from "./worktree_progress.ts";

/** The slice of `WorkerConfig` this wiring reads. */
export interface ProgressExtensionConfig {
  progressExtensionEnabled?: boolean;
  progressExtensionGrantSeconds?: number;
  progressExtensionStallSeconds?: number;
  progressExtensionCheckSeconds?: number;
}

/**
 * Build a rolling working-tree probe over `repoDir`.
 *
 * Each call fingerprints the tree and compares it with the fingerprint from
 * the previous call, so the verdict always describes the window since the
 * last check. A failed probe yields `unknown` and leaves the baseline alone,
 * so one transient git failure does not fabricate an `advanced` verdict on
 * the next check.
 *
 * @param repoDir - Absolute path to the checkout the agent is working in.
 * @param baseline - Fingerprint taken before the run started.
 * @returns A probe suitable for `RunClaudeOptions.progressExtension`.
 */
export function createRollingTreeProbe(
  repoDir: string,
  baseline: WorktreeFingerprint,
): () => Promise<TreeProgressState> {
  let previous = baseline;
  return async () => {
    const current = await probeWorktreeFingerprint(repoDir);
    const comparison = compareWorktreeFingerprints(previous, current);
    if (current.ok) previous = current;
    return comparison.outcome;
  };
}

/**
 * Build the runner's opt-in progress-extension option from config.
 *
 * @param config - Worker config (or the subset above).
 * @param repoDir - Checkout the agent will work in.
 * @param onExtension - Optional sink for each granted extension (Issue
 *   #4297), so the shutdown drain can account for an extended run.
 * @returns The option, or `undefined` when the feature is off — in which
 *   case the caller passes nothing and the hard timeout is unchanged.
 */
export async function buildProgressExtension(
  config: ProgressExtensionConfig,
  repoDir: string,
  onExtension?: RunDeadlineReporter,
): Promise<ProgressExtensionOptions | undefined> {
  if (!config.progressExtensionEnabled) return undefined;

  const grantSeconds = config.progressExtensionGrantSeconds ?? 0;
  const activityStallSeconds = config.progressExtensionStallSeconds ?? 0;
  if (grantSeconds <= 0 || activityStallSeconds <= 0) {
    // Config validation rejects these, so reaching here means a caller built
    // the config by hand. Refuse to extend rather than re-arm on nonsense.
    return undefined;
  }

  // The check interval is optional at this seam (Issue #4295): omitted or
  // nonsensical, the tree is sampled only when the deadline expires, which is
  // the behaviour #4296 shipped.
  const checkSeconds = config.progressExtensionCheckSeconds ?? 0;

  const baseline = await probeWorktreeFingerprint(repoDir);
  return {
    policy: {
      enabled: true,
      grantSeconds,
      activityStallSeconds,
      ...(checkSeconds > 0 ? { checkSeconds } : {}),
    },
    treeProbe: createRollingTreeProbe(repoDir, baseline),
    ...(onExtension ? { onExtension } : {}),
  };
}
