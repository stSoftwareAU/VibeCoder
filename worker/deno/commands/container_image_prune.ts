/**
 * container-image-prune command (Issue #4162).
 *
 * Called by `run.sh` / `run.ps1` once the image this checkout resolves to is
 * present: every other `vibe-coder` tag is dead weight, because the
 * content-derived reference (#4062) is the only one a future launch of this
 * checkout can use. Each removed tag is named on stderr.
 *
 * `--keep` takes the launch's whole image **dependency chain**, comma
 * separated — the reference the container runs plus every image it is built
 * `FROM` (Issue #1059). A deployment with a private extension layer runs
 * `vibe-coder:<extensionHash>` built `FROM vibe-coder:<baseHash>`, and a prune
 * told only the leaf untagged the base on every launch. The launchers pass the
 * plan's `keep` value straight through, so a deeper chain needs nothing here.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-run \
 *     mod.ts container-image-prune --runtime container \
 *     --keep vibe-coder:0a1b2c3d4e5f,vibe-coder:9f8e7d6c5b4a
 *
 * Exits non-zero when the listing or a removal failed, so a host that cannot
 * reclaim its own disk is visible rather than silently green (Issue #3234). The
 * launchers treat that as a warning: pruning must never block a launch.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  createPruneDeps,
  parseKeepReferences,
  type PruneOutcome,
  pruneSupersededImages,
} from "../lib/container_image_prune.ts";
import { dialectForExecutable } from "../lib/container_watchdog.ts";

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** What the command reports back to the launcher. */
export interface ContainerImagePruneResult {
  /** References removed. */
  removed: string[];
  /** Removals the runtime refused. */
  failed: PruneOutcome["failed"];
}

export const containerImagePruneCommand: Command = {
  name: "container-image-prune",
  description:
    "Remove every superseded vibe-coder image tag, host-side (Issue #4162)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ContainerImagePruneResult>> {
    return pruneImages(args);
  },
};

/** Do the work. Separated so the tests can call it without the registry. */
export async function pruneImages(
  args: Record<string, unknown>,
): Promise<CommandResult<ContainerImagePruneResult>> {
  const runtime = optionalString(args["runtime"]);
  if (!runtime) {
    return {
      success: false,
      message: "container-image-prune requires --runtime <executable>",
    };
  }

  const keepValue = optionalString(args["keep"]);
  const keep = keepValue === undefined ? [] : parseKeepReferences(keepValue);
  if (keep.length === 0) {
    return {
      success: false,
      message:
        "container-image-prune requires --keep <image reference>[,<base>…]",
    };
  }

  let dialect;
  try {
    dialect = dialectForExecutable(runtime);
  } catch (error) {
    return { success: false, message: (error as Error).message };
  }

  const outcome = await pruneSupersededImages(createPruneDeps(runtime), {
    keep,
    listArgs: dialect.imageListArgs,
    removeArgs: dialect.imageRemoveArgs,
  });

  const data = { removed: outcome.removed, failed: outcome.failed };
  if (!outcome.ok) {
    return {
      success: false,
      message: `could not prune superseded ${keep.join(", ")} tags: ` +
        `${outcome.detail ?? "no reason reported"}`,
      data,
    };
  }

  return {
    success: true,
    message: outcome.removed.length === 0
      ? `no superseded image tags beside ${keep.join(", ")}`
      : `removed ${outcome.removed.length} superseded image tag(s): ${
        outcome.removed.join(", ")
      }`,
    data,
  };
}
