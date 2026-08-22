/**
 * work-volume-prune command (Issue #228).
 *
 * Housekeeping step that bounds the work volume: stale cargo `target/`
 * directories (by age and a total cap), agents' scratch directories left in
 * the work root, and stale heartbeat-marker state files.
 *
 * The summary also carries the volume's standing totals by category
 * (Issue #244) so a reclamation's before/after is visible in the log — the
 * "after" line is measured only when something was actually removed, so an
 * idle prune costs one walk, not two.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  pruneWorkVolume,
  summariseWorkVolumePrune,
  type WorkVolumePruneResult,
} from "../lib/work_volume_prune.ts";
import { reportWorkVolumeUsage } from "../lib/work_volume_usage.ts";

function numberArg(
  args: Record<string, unknown>,
  name: string,
): number | undefined | "invalid" {
  const raw = args[name];
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

export const workVolumePruneCommand: Command = {
  name: "work-volume-prune",
  description:
    "Bound the work volume: stale cargo target/ dirs, agent scratch in the work root, stale marker files (Issue #228)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<WorkVolumePruneResult>> {
    const workDir =
      typeof args["work-dir"] === "string" && args["work-dir"].length > 0
        ? args["work-dir"]
        : (config?.workDir || Deno.env.get("WORK_DIR") || "");
    if (!workDir) {
      return {
        success: false,
        message: "work-volume-prune: --work-dir is required",
      };
    }
    const knobs = {
      artefactMaxAgeDays: numberArg(args, "artefact-max-age-days"),
      artefactMaxTotalBytes: numberArg(args, "artefact-max-total-bytes"),
      scratchMaxAgeHours: numberArg(args, "scratch-max-age-hours"),
      markerMaxAgeDays: numberArg(args, "marker-max-age-days"),
    };
    for (const [name, value] of Object.entries(knobs)) {
      if (value === "invalid") {
        return {
          success: false,
          message: `work-volume-prune: ${name} must be a non-negative number`,
        };
      }
    }
    const monitoredRepos = config?.repos ?? [];
    const before = await reportWorkVolumeUsage(
      { workDir, monitoredRepos },
      "Work volume before",
    );

    const result = await pruneWorkVolume({
      workDir,
      artefactMaxAgeDays: knobs.artefactMaxAgeDays as number | undefined,
      artefactMaxTotalBytes: knobs.artefactMaxTotalBytes as number | undefined,
      scratchMaxAgeHours: knobs.scratchMaxAgeHours as number | undefined,
      markerMaxAgeDays: knobs.markerMaxAgeDays as number | undefined,
    });

    const reclaimed = result.artefacts.removed.length +
      result.scratch.removed.length + result.markers.removed.length;
    const after = reclaimed > 0
      ? ` | ${await reportWorkVolumeUsage(
        { workDir, monitoredRepos },
        "Work volume after",
      )}`
      : "";

    return {
      success: result.errors.length === 0,
      message: `work-volume-prune: ${
        summariseWorkVolumePrune(result)
      } | ${before}${after}`,
      data: result,
    };
  },
};
