/**
 * The launch path's extension resolution (Issue #982, parent #933).
 *
 * One function stands between a deployment's `container_extension`
 * declaration and the launch plan that builds it: it reads the declaration
 * (Issue #978), **preflights** what is actually on the host (Issue #982),
 * reads the operator's Containerfile, and resolves the layered image's own
 * content-derived tag (Issue #979).
 *
 * The order is the point. The preflight runs before the digest and before
 * either build, so an absent directory or a missing start script is reported
 * as exactly that — naming the path — rather than surfacing minutes later as a
 * hashing failure or a build error. Nothing downstream can be reached with a
 * half-resolved extension: this function either returns a complete
 * {@link ContainerExtensionLaunch} or throws, so a fault means the plan
 * carries no extension build arguments at all.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { ContainerExtensionLaunch } from "./container_launch.ts";
import { readContainerExtensionSelection } from "./container_extension_config.ts";
import { preflightContainerExtension } from "./container_extension_preflight.ts";
import {
  type ContainerImageHashOptions,
  resolveContainerImageReference,
} from "./container_image_hash.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { joinPath, normalisePath, pathStyleFor } from "./host_path_style.ts";

/** Where one launch reads its extension from. */
export interface ContainerExtensionLaunchOptions {
  /** The worker checkout, which the image inputs are resolved against. */
  baseDir: string;
  /** The deployment's configuration file, as the launcher resolved it. */
  configFile: string;
  /**
   * The deployment's other image selections — the tool set and the enabled
   * provider set — as the launcher already resolved them. The extension is
   * added to them here, so the layered tag covers every input the standard
   * one does *plus* the extension digest.
   */
  imageOptions: ContainerImageHashOptions;
  /** Environment lookup override; tests inject a fixed map (Issue #956). */
  env?: EnvLookup;
}

/**
 * Resolve the operator's private layer for the launch plan.
 *
 * @param options - The checkout, the configuration file and the other
 *   image selections
 * @returns The layer the plan builds, or `undefined` when the deployment
 *   configures none — in which case the plan is byte-for-byte what it emits
 *   today
 * @throws Naming the offending path, when the declaration is malformed, when
 *   the extension directory or a declared file is not on the host, when a
 *   symlink under it escapes the directory, or when the Containerfile cannot
 *   be read
 */
export async function resolveContainerExtensionLaunch(
  options: ContainerExtensionLaunchOptions,
): Promise<ContainerExtensionLaunch | undefined> {
  const env = options.env ?? processEnvLookup;
  const spec = await readContainerExtensionSelection(options.configFile, {
    env,
  });
  if (!spec) return undefined;

  // Before the digest, before either build: the operator hears "the directory
  // is not there" rather than a build failure minutes later.
  await preflightContainerExtension(spec);

  const style = pathStyleFor(options.baseDir);
  const containerfilePath = joinPath(
    normalisePath(spec.path, style),
    spec.containerfile,
    style,
  );
  let containerfileText: string;
  try {
    containerfileText = await Deno.readTextFile(containerfilePath);
  } catch (error) {
    throw new Error(
      `Cannot launch: the container_extension Containerfile ` +
        `${containerfilePath} is unreadable (${(error as Error).message}). ` +
        `The operator syncs their own extension into ${spec.path}.`,
    );
  }

  return {
    spec,
    image: await resolveContainerImageReference(options.baseDir, {
      ...options.imageOptions,
      containerExtension: spec,
    }),
    containerfileText,
  };
}
