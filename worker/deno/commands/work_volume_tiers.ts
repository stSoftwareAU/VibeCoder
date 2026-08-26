/**
 * work-volume-tiers command (Issue #242).
 *
 * Splits the work root into the monitored repos (tier 1, persistent) and
 * everything else (tier 2, disposable — the sibling data clones a gate
 * pulled in). `--mode age` ages tier 2 out as a housekeeping step;
 * `--mode disk-low --bytes-needed N` reclaims largest-first when the host
 * disk monitor (Issue #226) reports `low`.
 *
 * `--max-git-bytes` caps a tier-2 clone's `.git` in `age` mode (Issue #387):
 * a data repo a gate refreshes every cycle is never idle, and each refresh of
 * a blobless partial clone leaves a whole tree of blobs behind in a promisor
 * pack git will not prune. `0` disables the cap.
 *
 * The monitored list comes from the loaded configuration unless `--repos`
 * names one explicitly.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  reclaimWorkVolumeTiers,
  summariseWorkVolumeTiers,
  type WorkVolumeTierResult,
} from "../lib/work_volume_tiers.ts";

function numberArg(
  args: Record<string, unknown>,
  name: string,
): number | undefined | "invalid" {
  const raw = args[name];
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

/** Monitored repositories: the `--repos` override, else the loaded config. */
export function resolveMonitoredRepos(
  args: Record<string, unknown>,
  config: WorkerConfig | undefined,
): string[] {
  const raw = args["repos"];
  if (Array.isArray(raw)) return raw.map((r) => String(r));
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.split(",").map((r) => r.trim()).filter((r) => r !== "");
  }
  return config?.repos ?? [];
}

export const workVolumeTiersCommand: Command = {
  name: "work-volume-tiers",
  description:
    "Tier the work root: monitored repos persist, sibling/data clones age out or are reclaimed largest-first when the host disk is low (Issue #242)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<WorkVolumeTierResult>> {
    const workDir =
      typeof args["work-dir"] === "string" && args["work-dir"].length > 0
        ? args["work-dir"]
        : (config?.workDir || Deno.env.get("WORK_DIR") || "");
    if (!workDir) {
      return {
        success: false,
        message: "work-volume-tiers: --work-dir is required",
      };
    }

    const rawMode = args["mode"] === undefined ? "age" : String(args["mode"]);
    if (rawMode !== "age" && rawMode !== "disk-low") {
      return {
        success: false,
        message: "work-volume-tiers: --mode must be 'age' or 'disk-low'",
      };
    }

    const knobs = {
      "max-age-days": numberArg(args, "max-age-days"),
      "max-git-bytes": numberArg(args, "max-git-bytes"),
      "bytes-needed": numberArg(args, "bytes-needed"),
    };
    for (const [flag, value] of Object.entries(knobs)) {
      if (value === "invalid") {
        return {
          success: false,
          message: `work-volume-tiers: --${flag} must be a non-negative number`,
        };
      }
    }
    if (rawMode === "disk-low" && knobs["bytes-needed"] === undefined) {
      return {
        success: false,
        message:
          "work-volume-tiers: --bytes-needed is required with --mode disk-low",
      };
    }

    const monitoredRepos = resolveMonitoredRepos(args, config);
    if (monitoredRepos.length === 0) {
      // Fail loud rather than treat every clone on the volume as disposable.
      return {
        success: false,
        message:
          "work-volume-tiers: no monitored repositories — refusing to tier the work root",
      };
    }

    const result = await reclaimWorkVolumeTiers({
      workDir,
      monitoredRepos,
      mode: rawMode,
      maxAgeDays: knobs["max-age-days"] as number | undefined,
      maxGitBytes: knobs["max-git-bytes"] as number | undefined,
      bytesNeeded: knobs["bytes-needed"] as number | undefined,
      log: (message) => console.log(message),
    });

    return {
      success: result.errors.length === 0,
      message: `work volume: ${summariseWorkVolumeTiers(result)}`,
      data: result,
    };
  },
};
