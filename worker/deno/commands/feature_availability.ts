/**
 * Feature-availability command — checks optional feature availability
 * and outputs results for consumption by shell scripts.
 *
 * Replaces feature_availability.sh (Issue #907).
 * Deno TypeScript is now the single source of truth for feature checks.
 *
 * Actions:
 *   --action check-all     Register builtins, check all, output summary
 *   --action check         Check a single feature (requires --name)
 *   --action summary       Output current status summary (no re-check)
 *
 * Output format (check-all):
 *   One line per feature: "name: status (description)"
 *   Plus shell-consumable FEATURE_DEGRADED lines on stderr for logging.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  createFeatureRegistry,
  type FeatureCheckResult,
  registerBuiltinFeatures,
} from "../lib/feature_availability.ts";

/**
 * Data returned by the feature-availability command.
 */
interface FeatureAvailabilityData {
  features: FeatureCheckResult[];
  degradedCount: number;
  availableCount: number;
}

/**
 * Format feature results as a human-readable summary.
 */
function formatSummary(results: FeatureCheckResult[]): string {
  const lines = ["Optional feature availability summary:"];
  for (const { name, status, description } of results) {
    lines.push(`  ${name}: ${status} (${description})`);
  }
  return lines.join("\n");
}

export const featureAvailabilityCommand: Command = {
  name: "feature-availability",
  description: "Check optional feature availability with graceful degradation",
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<FeatureAvailabilityData>> {
    const action = (args["action"] as string) ?? "check-all";

    const registry = createFeatureRegistry();
    registerBuiltinFeatures(registry);

    if (action === "check") {
      const name = args["name"] as string;
      if (!name) {
        return {
          success: false,
          message: "ERROR: --name is required for check action",
        };
      }
      const isAvailable = registry.checkFeature(name);
      const status = registry.getStatus(name);
      return {
        success: isAvailable,
        message: `${name}: ${status}`,
        data: {
          features: [
            {
              name,
              description: "",
              status,
            },
          ],
          degradedCount: isAvailable ? 0 : 1,
          availableCount: isAvailable ? 1 : 0,
        },
      };
    }

    // Default: check-all or summary
    const results = action === "summary"
      ? registry.getSummary()
      : registry.checkAll();

    // Log FEATURE_DEGRADED events to stderr for security logging
    for (const { name, status, description } of results) {
      if (status === "degraded") {
        console.error(
          `FEATURE_DEGRADED feature=${name} description="${description}"`,
        );
      }
    }

    const degradedCount = results.filter((r) => r.status === "degraded")
      .length;
    const availableCount = results.filter((r) => r.status === "available")
      .length;

    return {
      success: true,
      message: formatSummary(results),
      data: { features: results, degradedCount, availableCount },
    };
  },
};
