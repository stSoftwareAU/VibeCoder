/**
 * Baseline-aware quality gate feature flag (Issue #1549).
 *
 * Resolves whether the generic baseline-aware bypass (Issue #2604) is
 * enabled for a repo. The bypass itself lives in `baseline_gate.ts` and
 * reasons over the diffable checks (mermaid, markdownlint, docs); this
 * module only owns the enable/disable resolution.
 *
 * Uses Australian English throughout (behaviour, colour, organisation,
 * favour, centre).
 */

import type { WorkerConfig } from "../types.ts";

/**
 * Resolve the effective `baselineAwareQualityGate` setting for the
 * given repo. Per-repo override wins; otherwise the global default.
 */
export function isBaselineAwareQualityGateEnabled(
  config: WorkerConfig,
  repo: string,
): boolean {
  const override = config.repoConfig?.[repo]?.baselineAwareQualityGate;
  if (override !== undefined) return override;
  return config.baselineAwareQualityGate;
}
