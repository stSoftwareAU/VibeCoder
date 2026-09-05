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

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";
import {
  AGENT_PROVIDERS_HASH_INPUT,
  computeContainerImageHash,
  CONTAINER_IMAGE_INPUTS,
  CONTAINER_TOOLS_HASH_INPUT,
  resolveContainerImageReference,
} from "../lib/container_image_hash.ts";
import { readDeploymentImageSelection } from "../lib/container_image_selection.ts";

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

/**
 * The command, plus the environment seam its selections are read through
 * (Issue #944).
 *
 * Declared as a widening of {@link Command} — the extra parameter is optional
 * and defaults to the process environment, so the registry and `mod.ts` see
 * the interface they always did. Two things reach the environment here: the
 * `CONFIG_PATH` fallback in {@link resolveConfigFile}, and the
 * `VIBE_AGENT_PROVIDER` / `VIBE_AGENT_PROVIDERS` overrides plus the
 * `VIBE_IMAGE_AGENT_PROVIDERS` image stamp that
 * `readDeploymentImageSelection` judges the configured provider set against.
 * Both are launcher-to-container plumbing rather than configuration, so the
 * seam is an injected lookup and not a new `.config.json` key.
 */
export interface ContainerImageHashCommand extends Command {
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    env?: EnvLookup,
  ): Promise<CommandResult<ContainerImageHashResult>>;
}

export const containerImageHashCommand: ContainerImageHashCommand = {
  name: "container-image-hash",
  description:
    "Print the content-derived container image reference (Issue #4062)",
  /**
   * @param args - `--base-dir` and `--config`.
   * @param _config - The worker configuration, which this command never reads:
   *   it runs on the host before the worker has loaded one.
   * @param env - Where `CONFIG_PATH` and the provider overrides are read from
   *   (Issue #944). Defaults to the process environment, so launcher callers
   *   are unchanged; a test states the environment instead of deleting the
   *   variables from the process it shares with every other test.
   */
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
    env: EnvLookup = processEnvLookup,
  ): Promise<CommandResult<ContainerImageHashResult>> {
    const baseDir = typeof args["base-dir"] === "string"
      ? (args["base-dir"] as string)
      : Deno.cwd();

    const configFile = resolveConfigFile(baseDir, args, env);

    try {
      // The selected tools and the enabled providers are both part of the
      // image's identity: a host that rebuilds off this reference alone must
      // rebuild when either changes. Read through the one reader setup's check
      // and the tabletop runner also use, so the three cannot disagree (#743).
      const { options, tools, agentProviders } =
        await readDeploymentImageSelection({
          repoRoot: baseDir,
          configFile,
          env,
        });
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
