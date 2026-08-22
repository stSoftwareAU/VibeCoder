/**
 * container-image-hash command (Issue #4062).
 *
 * Prints the content-derived reference of the Vibe Coder container image so
 * `run.sh` and `run.ps1` can decide whether the required image already exists
 * without duplicating the hashing rule in shell and PowerShell.
 *
 * The reference covers the deployment's `container_tools` selection as well as
 * the committed definition (Issue #73), so the decision this command drives is
 * made against the tools the image actually bakes in. The selection is read
 * from `--config`, else `CONFIG_PATH`, else `<base-dir>/.config.json`; a
 * checkout with no configuration selects no tools and gets the same reference
 * it did before.
 *
 * Usage:
 *   deno run --allow-env --allow-read mod.ts container-image-hash \
 *     [--base-dir /repo/root] [--config /path/.config.json]
 *
 * Prints `vibe-coder:<short hash>` on stdout. A missing enumerated input or a
 * malformed tool spec exits non-zero with the offending path or field named.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  computeContainerImageHash,
  CONTAINER_IMAGE_INPUTS,
  CONTAINER_TOOLS_HASH_INPUT,
  resolveContainerImageReference,
} from "../lib/container_image_hash.ts";
import { readContainerToolsSelection } from "../lib/container_tools_config.ts";

/** What the command reports alongside the printed reference. */
export interface ContainerImageHashResult {
  /** Full image reference, e.g. `vibe-coder:0a1b2c3d4e5f`. */
  image: string;
  /** Full hex SHA-256 the tag is derived from. */
  hash: string;
  /**
   * The inputs the hash covers: the enumerated files, plus
   * `container_tools` when the deployment selects tools.
   */
  inputs: string[];
  /** The `.config.json` the tool selection was read from. */
  configFile: string;
  /** The selected tool ids, in the order they are installed. */
  containerTools: string[];
}

/** Whether a path is absolute on either host style. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") ||
    /^[A-Za-z]:[/\\]/.test(path);
}

/**
 * Where the deployment's configuration lives, mirroring the launcher's own
 * rule (`resolveContainerLaunchHostPaths`): an explicit `--config`, else
 * `CONFIG_PATH`, else `.config.json` beside the checkout — a relative value
 * resolved against the base directory either way.
 */
export function resolveConfigFile(
  baseDir: string,
  args: Record<string, unknown>,
  env: (name: string) => string | undefined,
): string {
  const configured = typeof args["config"] === "string"
    ? args["config"] as string
    : env("CONFIG_PATH") ?? ".config.json";
  const root = baseDir.replace(/[/\\]+$/, "");
  return isAbsolute(configured) ? configured : `${root}/${configured}`;
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

    const configFile = resolveConfigFile(
      baseDir,
      args,
      (name) => Deno.env.get(name),
    );

    try {
      // The selected tools are part of the image's identity: a host that
      // rebuilds off this reference alone must rebuild when they change.
      const { tools } = await readContainerToolsSelection(configFile);
      const options = { containerTools: tools };
      const hash = await computeContainerImageHash(baseDir, options);
      const image = await resolveContainerImageReference(baseDir, options);

      return {
        success: true,
        message: image,
        data: {
          image,
          hash,
          inputs: [
            ...CONTAINER_IMAGE_INPUTS,
            ...(tools.length > 0 ? [CONTAINER_TOOLS_HASH_INPUT] : []),
          ],
          configFile,
          containerTools: tools.map((tool) => tool.id),
        },
      };
    } catch (error) {
      // Fail loud: the caller sees the missing path or the offending spec
      // field, not a fallback tag.
      return { success: false, message: (error as Error).message };
    }
  },
};
