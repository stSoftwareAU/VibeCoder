/**
 * One reader for the deployment selections that name the worker image
 * (Issues #743, #749).
 *
 * The image tag is content-derived: `container_tools` (Issue #73), the enabled
 * `agent_providers` set (Issue #729) and the private `container_extension`
 * directory (Issue #979) are all baked into the image, so all three are hashed
 * into its name. The launcher passes them when it resolves the tag to build
 * and run — and two other callers passed none:
 *
 *   - `setup/prerequisites.ts` reported "Worker image vibe-coder:<tag> is not
 *     built yet" on a host whose image *was* built, because it asked for a tag
 *     no deployment selecting tools or providers ever builds;
 *   - `lib/tabletop_container_runner.ts` refused to run for the same reason,
 *     telling the operator to "build it with ./run.sh" — which builds a
 *     different tag.
 *
 * Neither caller wanted its own copy of "how a deployment states its
 * selections"; each simply had no way to ask. This is that one way to ask, and
 * `container_image_selection_test.ts` pins its answer to the launcher's, so a
 * third input added to the hash later cannot be added to the launcher alone.
 * `container_extension` (Issue #979) is that third input, and it is read here.
 *
 * Fail-loud, except for an absent configuration: a checkout that has not been
 * set up selects nothing, which is exactly the tag the enumerated files alone
 * produce. A file that exists but is malformed throws with the offending field
 * named, rather than quietly naming a different image.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { readConfiguredAgentProviderSet } from "./agent_provider_config.ts";
import { readContainerExtensionSelection } from "./container_extension_config.ts";
import type { ContainerImageHashOptions } from "./container_image_hash.ts";
import { parseContainerManifest } from "./container_manifest.ts";
import { readContainerToolsSelection } from "./container_tools_config.ts";
import type { ContainerExtensionSpec, ContainerToolSpec } from "../types.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { resolveHostConfigPath } from "./host_config_path.ts";

/** What one deployment selects, and the image options it implies. */
export interface DeploymentImageSelection {
  /**
   * The options to hand `resolveContainerImageReference` /
   * `computeContainerImageHash` — empty when the deployment selects nothing,
   * which is the tag the enumerated files alone produce.
   */
  options: ContainerImageHashOptions;
  /** The validated tool selection; empty when none is stated. */
  tools: ContainerToolSpec[];
  /** The `AGENT_PROVIDERS` build value, absent for the image's own default. */
  agentProviders?: string;
  /** The validated extension declaration, absent when none is configured. */
  containerExtension?: ContainerExtensionSpec;
  /** The configuration file the selections were read from. */
  configFile: string;
}

/** Where one caller's deployment states its selections. */
export interface DeploymentImageSelectionOptions {
  /** Repository root the image inputs are resolved against. */
  repoRoot: string;
  /**
   * The deployment's configuration file. Defaults to the launcher's own rule
   * — `CONFIG_FILE`, its `CONFIG_PATH` alias, else `<checkout>/.config.json`
   * (Issue #750) — so a caller that has no configuration path of its own reads
   * the file the launcher reads.
   */
  configFile?: string;
  /**
   * Environment reader (injectable for tests).
   *
   * Reaches the provider resolution as well as the config-path rule
   * (Issue #962): `VIBE_AGENT_PROVIDER` and the image stamp both steer which
   * providers a deployment is judged to have selected, so a caller that
   * states one must state the other from the same lookup.
   */
  env?: EnvLookup;
}

/** Strip trailing separators so a root joins cleanly. */
function trimRoot(repoRoot: string): string {
  return repoRoot.replace(/[/\\]+$/, "");
}

/**
 * Whether a path exists, distinguishing "absent" from "unreadable".
 *
 * @param path - The path to test
 * @returns True when the path exists
 * @throws When the path exists but cannot be stat'ed
 */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * Read the selections that decide which image a deployment names.
 *
 * @param options - The repository root, and optionally an explicit config file
 * @returns The selections, and the hash options they imply
 * @throws When the configuration exists but is unreadable or malformed, or the
 *   container manifest cannot be parsed
 */
export async function readDeploymentImageSelection(
  options: DeploymentImageSelectionOptions,
): Promise<DeploymentImageSelection> {
  const repoRoot = trimRoot(options.repoRoot);
  const env = options.env ?? processEnvLookup;
  const configFile = options.configFile ?? resolveHostConfigPath({
    baseDir: repoRoot,
    env,
  });

  const { tools } = await readContainerToolsSelection(configFile);

  // The private extension (Issue #979). Read here rather than in each caller
  // for the same reason the other two are: a caller that skipped it would name
  // the standard image on a host that builds an extended one.
  const containerExtension = await readContainerExtensionSelection(configFile, {
    env,
  });

  // The provider set is stated relative to what the image installs by default,
  // so the manifest is needed to say whether a selection differs from it at
  // all. A deployment with no configuration file states no selection: the
  // provider read is skipped rather than answered from the manifest alone.
  let agentProviders: string | undefined;
  if (await exists(configFile)) {
    const manifest = parseContainerManifest(
      await Deno.readTextFile(`${repoRoot}/container/tools.json`),
    );
    agentProviders = (await readConfiguredAgentProviderSet(
      configFile,
      manifest.installedProviders,
      env,
    )).buildValue;
  }

  return {
    options: {
      containerTools: tools,
      ...(agentProviders ? { agentProviders } : {}),
      ...(containerExtension ? { containerExtension } : {}),
    },
    tools,
    ...(agentProviders ? { agentProviders } : {}),
    ...(containerExtension ? { containerExtension } : {}),
    configFile,
  };
}
