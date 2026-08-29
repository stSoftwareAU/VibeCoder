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

import {
  compareDescendantCpu,
  type DescendantCpuSnapshot,
  type DescendantProbeOptions,
  probeDescendantCpu,
} from "./descendant_progress.ts";
import type {
  ExternalProgressState,
  ProgressExtensionOptions,
  TreeProgressState,
} from "./progress_extension.ts";
import type { RunDeadlineReporter } from "./run_deadline.ts";
import {
  clearWindDownNotice,
  type RunBudgetNotice,
  writeWindDownNotice,
} from "./wind_down_notice.ts";
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
 * Build a rolling descendant-CPU probe (Issue #508).
 *
 * The twin of {@link createRollingTreeProbe} for work that happens outside
 * the checkout: each call reads the agent's descendant subtree and compares
 * it with the previous read, so the verdict describes the window since the
 * last check.
 *
 * The first call has nothing to compare against, so it answers `unknown` and
 * records the baseline: no comparison window has been observed yet, and an
 * unmeasured signal never earns an extension (Issue #4294's direction).
 * A failed read leaves the baseline alone, so one transient `ps` failure
 * cannot fabricate an `active` verdict on the next check.
 *
 * @param options - Probe overrides, injected by tests.
 * @returns A probe suitable for `ProgressExtensionOptions.externalProbe`.
 */
export function createRollingDescendantProbe(
  options?: DescendantProbeOptions,
): (agentPid: number) => Promise<ExternalProgressState> {
  let previous: DescendantCpuSnapshot | undefined;
  return async (agentPid: number) => {
    const current = await probeDescendantCpu(agentPid, options);
    const outcome: ExternalProgressState = previous === undefined
      ? "unknown"
      : compareDescendantCpu(previous, current).outcome;
    if (current.ok) previous = current;
    return outcome;
  };
}

/**
 * Build the runner's opt-in progress-extension option from config.
 *
 * @param config - Worker config (or the subset above).
 * @param repoDir - Checkout the agent will work in.
 * @param onExtension - Optional sink for each granted extension (Issue
 *   #4297), so the shutdown drain can account for an extended run.
 * @param ceilingMs - Absolute epoch-ms past which no grant may be issued
 *   (Issue #421), from `run_hard_cap.ts`. Omitted means uncapped, exactly as
 *   before the supervisor published its cap.
 * @returns The option, or `undefined` when the feature is off — in which
 *   case the caller passes nothing and the hard timeout is unchanged.
 */
export async function buildProgressExtension(
  config: ProgressExtensionConfig,
  repoDir: string,
  onExtension?: RunDeadlineReporter,
  ceilingMs?: number,
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

  // A checkout is reused between runs, so a notice from the last one would
  // have this agent winding down before it has read the issue (Issue #508).
  await clearWindDownNotice(repoDir);

  const baseline = await probeWorktreeFingerprint(repoDir);
  return {
    policy: {
      enabled: true,
      grantSeconds,
      activityStallSeconds,
      ...(checkSeconds > 0 ? { checkSeconds } : {}),
    },
    treeProbe: createRollingTreeProbe(repoDir, baseline),
    // Work outside the checkout counts too (Issue #508): an agent supervising
    // a job it started is progressing, not spinning.
    externalProbe: createRollingDescendantProbe(),
    // The one channel a live agent has for its remaining budget: a file it
    // can read between polls of a long-running job (Issue #508).
    onWindDown: (notice: RunBudgetNotice) =>
      writeWindDownNotice(repoDir, notice),
    ...(onExtension ? { onExtension } : {}),
    ...(ceilingMs !== undefined ? { ceilingMs } : {}),
  };
}
