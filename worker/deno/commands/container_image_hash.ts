/**
 * container-image-hash command (Issue #4062).
 *
 * Prints the content-derived reference of the Vibe Coder container image so
 * `run.sh` and `run.ps1` can decide whether the required image already exists
 * without duplicating the hashing rule in shell and PowerShell.
 *
 * The reference covers the deployment's `container_tools` selection (Issue #73)
 * and its `agent_providers` set (Issue #729) as well as the committed
 * definition, so the decision this command drives is made against what the
 * image actually bakes in — a Codex host is told to rebuild rather than handed
 * the tag of the Claude image it already has. Both are read from `--config`,
 * else `CONFIG_PATH`, else `<base-dir>/.config.json`; a checkout with no
 * configuration selects neither and gets the same reference it did before.
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
  AGENT_PROVIDERS_HASH_INPUT,
  computeContainerImageHash,
  CONTAINER_IMAGE_INPUTS,
  CONTAINER_TOOLS_HASH_INPUT,
  resolveContainerImageReference,
} from "../lib/container_image_hash.ts";
import { readContainerToolsSelection } from "../lib/container_tools_config.ts";
import { readConfiguredAgentProviderSet } from "../lib/agent_provider_config.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";

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
  /**
   * The `AGENT_PROVIDERS` value the build passes (Issue #729), or `""` when
   * the deployment takes the image's default provider set.
   */
  agentProviders: string;
}

/**
 * The provider set this deployment's build bakes in (Issue #729).
 *
 * Read here for the same reason the tool selection is: the reference this
 * command prints drives "does this host need a rebuild?", so it must be the
 * tag the launcher's build actually produces — a Codex host must not be told
 * it already has the (Claude) image it never built.
 *
 * @param baseDir - Repository root holding `container/tools.json`.
 * @param configFile - The deployment's `.config.json`.
 * @returns The build-argument value, or undefined for the image default.
 * @throws When the configuration or the manifest cannot be read or names an
 *   unusable provider — never a fallback tag (Issue #3234).
 */
async function readAgentProvidersBuildValue(
  baseDir: string,
  configFile: string,
): Promise<string | undefined> {
  try {
    await Deno.stat(configFile);
  } catch (error) {
    // A checkout with no configuration selects nothing and gets the reference
    // it had before this issue, exactly as it does for container_tools.
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }

  const manifest = parseContainerManifest(
    await Deno.readTextFile(
      `${baseDir.replace(/[/\\]+$/, "")}/container/tools.json`,
    ),
  );
  const { buildValue } = await readConfiguredAgentProviderSet(
    configFile,
    manifest.installedProviders,
  );
  return buildValue;
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
      // The enabled providers are baked in the same way (Issue #729): a host
      // that switches provider must be told to rebuild, not handed the tag of
      // the image it already has.
      const agentProviders = await readAgentProvidersBuildValue(
        baseDir,
        configFile,
      );
      const options = {
        containerTools: tools,
        ...(agentProviders ? { agentProviders } : {}),
      };
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
            ...(agentProviders ? [AGENT_PROVIDERS_HASH_INPUT] : []),
          ],
          configFile,
          containerTools: tools.map((tool) => tool.id),
          agentProviders: agentProviders ?? "",
        },
      };
    } catch (error) {
      // Fail loud: the caller sees the missing path or the offending spec
      // field, not a fallback tag.
      return { success: false, message: (error as Error).message };
    }
  },
};
