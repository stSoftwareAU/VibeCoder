/**
 * Best-effort load of the configured monitored-repo allowlist (Issue #3074).
 *
 * Used to constrain the untrusted, model-supplied escape-hatch cross-repo
 * follow-up reference to repos the worker is actually configured for. Extracted
 * from `pr_feedback_processor.ts` under Issue #3708 so the CI-fix path can share
 * the one implementation (DRY) rather than grow a second copy.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";

/**
 * Load the monitored-repo list from the worker config, returning `[]` on any
 * failure.
 *
 * A missing or invalid config is swallowed (with a warning) so the caller falls
 * back to the current-repo-only secure default — the label strip must never
 * abort a hand-off just because the allowlist could not be read.
 *
 * @param deps - Worker dependencies providing `config.loadConfig`
 * @param logger - Logger for the non-fatal warning
 * @returns The configured `repos` list, or `[]`
 */
export async function loadMonitoredReposBestEffort(
  deps: WorkerDeps,
  logger: Logger,
): Promise<string[]> {
  try {
    const configPath = Deno.env.get("CONFIG_PATH") ?? ".config.json";
    const config = await deps.config.loadConfig(configPath);
    return Array.isArray(config.repos) ? config.repos : [];
  } catch (err) {
    logger.warn(
      "Could not load monitored-repo allowlist for follow-up label strip; " +
        "falling back to current-repo-only (non-fatal)",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return [];
  }
}
