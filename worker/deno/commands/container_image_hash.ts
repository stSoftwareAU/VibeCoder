/**
 * container-image-hash command (Issue #4062).
 *
 * Prints the content-derived reference of the Vibe Coder container image so
 * `run.sh` and `run.ps1` can decide whether the required image already exists
 * without duplicating the hashing rule in shell and PowerShell.
 *
 * Usage:
 *   deno run --allow-read mod.ts container-image-hash [--base-dir /repo/root]
 *
 * Prints `vibe-coder:<short hash>` on stdout. A missing enumerated input
 * exits non-zero with the offending path named.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  computeContainerImageHash,
  CONTAINER_IMAGE_INPUTS,
  resolveContainerImageReference,
} from "../lib/container_image_hash.ts";

/** What the command reports alongside the printed reference. */
export interface ContainerImageHashResult {
  /** Full image reference, e.g. `vibe-coder:0a1b2c3d4e5f`. */
  image: string;
  /** Full hex SHA-256 the tag is derived from. */
  hash: string;
  /** The enumerated inputs the hash covers. */
  inputs: string[];
}

export const containerImageHashCommand: Command = {
  name: "container-image-hash",
  description:
    "Print the content-derived container image reference (Issue #4062)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ContainerImageHashResult>> {
    const baseDir = typeof args["base-dir"] === "string"
      ? (args["base-dir"] as string)
      : Deno.cwd();

    try {
      const hash = await computeContainerImageHash(baseDir);
      const image = await resolveContainerImageReference(baseDir);

      return {
        success: true,
        message: image,
        data: { image, hash, inputs: [...CONTAINER_IMAGE_INPUTS] },
      };
    } catch (error) {
      // Fail loud: the caller sees the missing path, not a fallback tag.
      return { success: false, message: (error as Error).message };
    }
  },
};
