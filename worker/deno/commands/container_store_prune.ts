/**
 * container-store-prune command (Issue #227).
 *
 * Called by `run.sh` / `run.ps1` after the image is present and the builder
 * has been stopped: removes the container tests' leaked throwaway volumes,
 * the runtime's dangling image layers, and — when the store's filesystem is
 * short of room — the stopped builder container and its rootfs.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-run \
 *     mod.ts container-store-prune --runtime container \
 *     [--store-path "$HOME/Library/Application Support/com.apple.container"] \
 *     [--builder-floor-percent 20]
 *
 * Exits non-zero when any step failed, so a host that cannot reclaim its own
 * disk is visible rather than silently green. The launchers treat that as a
 * warning: reclaiming disk must never block a launch.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  createStorePruneDeps,
  DEFAULT_BUILDER_FLOOR_PERCENT,
  pruneContainerStore,
  type StepOutcome,
} from "../lib/container_store_prune.ts";
import { dialectForExecutable } from "../lib/container_watchdog.ts";

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** What the command reports back to the launcher. */
export interface ContainerStorePruneResult {
  steps: StepOutcome[];
}

export const containerStorePruneCommand: Command = {
  name: "container-store-prune",
  description:
    "Reclaim the host container store: leaked test volumes, dangling images, and the stopped builder when disk is short (Issue #227)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ContainerStorePruneResult>> {
    return pruneStore(args);
  },
};

/** Do the work. Separated so the tests can call it without the registry. */
export async function pruneStore(
  args: Record<string, unknown>,
): Promise<CommandResult<ContainerStorePruneResult>> {
  const runtime = optionalString(args["runtime"]);
  if (!runtime) {
    return {
      success: false,
      message: "container-store-prune requires --runtime <executable>",
    };
  }

  let dialect;
  try {
    dialect = dialectForExecutable(runtime);
  } catch (error) {
    return { success: false, message: (error as Error).message };
  }

  const rawFloor = args["builder-floor-percent"];
  let builderFloorPercent = DEFAULT_BUILDER_FLOOR_PERCENT;
  if (rawFloor !== undefined) {
    const parsed = Number(rawFloor);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      return {
        success: false,
        message:
          `container-store-prune: --builder-floor-percent must be 0–100, got ${
            JSON.stringify(rawFloor)
          }`,
      };
    }
    builderFloorPercent = parsed;
  }

  const outcome = await pruneContainerStore(createStorePruneDeps(runtime), {
    dialect,
    storePath: optionalString(args["store-path"]),
    builderFloorPercent,
  });

  const summary = outcome.steps.map((s) => `${s.step}: ${s.detail}`).join(
    "; ",
  );
  return {
    success: outcome.ok,
    message: outcome.ok
      ? `container store prune complete — ${summary}`
      : `container store prune had failures — ${summary}`,
    data: { steps: outcome.steps },
  };
}
