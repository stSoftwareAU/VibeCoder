/**
 * Command wrapper for FLEET health reporting.
 *
 * Issue #1124: Migrated from run_core.sh (lines 1118–1141) to Deno TypeScript.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  buildFleetHealthConfig,
  createProductionFleetHealthDeps,
  runFleetHealthReporting,
} from "../lib/fleet_health.ts";

/** Command result data for fleet-health. */
interface FleetHealthData {
  healthDir: string;
  hostId: string;
  reported: boolean;
}

/**
 * fleet-health command — reports worker health to the FLEET-health repository.
 *
 * Called at the end of each worker run to record that the worker is alive
 * and functioning. The FLEET-health repository is cloned/synced automatically.
 */
export const fleetHealthCommand: Command = {
  name: "fleet-health",
  description: "Report worker health to FLEET-health repository (Issue #1124)",

  async execute(
    args: Record<string, unknown>,
    _config,
  ): Promise<CommandResult<FleetHealthData>> {
    const repoDir = (args["repo-dir"] as string) ??
      (args["repoDir"] as string) ??
      Deno.cwd();

    const config = buildFleetHealthConfig(repoDir);
    const deps = createProductionFleetHealthDeps();

    const result = await runFleetHealthReporting(config, deps);

    return {
      success: result.ok,
      message: result.ok
        ? `Health reported as Vibe Coder:${config.hostId}`
        : `Health reporting failed: ${result.ok ? "" : result.error.message}`,
      data: {
        healthDir: config.healthDir,
        hostId: config.hostId,
        reported: result.ok,
      },
    };
  },
};
