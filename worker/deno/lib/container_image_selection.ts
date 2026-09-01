/**
 * The deployment's own contribution to the container image tag (Issue #743).
 *
 * The tag is a hash of the committed container definition **and** of what this
 * deployment selected in its `.config.json` (Issue #73). Every caller that
 * names the tag must therefore mix in the same selections the launch path
 * mixes in — a caller that resolves the reference from the checkout alone
 * names a tag `./run.sh` never builds, which is exactly how setup's
 * worker-image check and the tabletop runner came to disagree with the
 * launcher.
 *
 * This module is where a caller that only *names* the tag — setup's
 * worker-image check, the tabletop runner — reads them, so a selection that
 * joins the hash is added here once rather than in each of those callers. The
 * launch plan and `container-image-hash` read the same `.config.json` through
 * `readContainerToolsSelection`, because they also need the verbatim spec the
 * build carries.
 *
 * Fail-loud: a malformed selection throws with the offending field named
 * rather than falling back to a selection-free tag that would quietly match
 * the wrong image.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { ContainerImageHashOptions } from "./container_image_hash.ts";
import { readContainerToolsSelection } from "./container_tools_config.ts";

/** Whether a path is absolute on either host style. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") ||
    /^[A-Za-z]:[/\\]/.test(path);
}

/**
 * Where the deployment's configuration lives.
 *
 * Mirrors the launcher's own rule (`resolveContainerLaunchHostPaths`): an
 * explicit path, else `CONFIG_PATH`, else `.config.json` beside the checkout —
 * a relative value resolved against the checkout either way. The fallbacks are
 * nullish, exactly as the launcher's are, so an empty value cannot mean one
 * file here and another there.
 *
 * @param baseDir - The worker checkout
 * @param explicit - A caller-supplied path, if it has one
 * @param env - Environment reader (injectable for tests)
 * @returns Absolute path of the `.config.json` this deployment uses
 */
export function resolveDeploymentConfigFile(
  baseDir: string,
  explicit: string | undefined,
  env: (name: string) => string | undefined,
): string {
  const configured = explicit ?? env("CONFIG_PATH") ?? ".config.json";
  const root = baseDir.replace(/[/\\]+$/, "");
  return isAbsolute(configured) ? configured : `${root}/${configured}`;
}

/**
 * Read the selections this deployment mixes into its image tag.
 *
 * @param configFile - Path to the deployment's `.config.json`
 * @returns The hash options the launch path would use for this deployment
 * @throws When the configuration exists but is unreadable or malformed; an
 *         absent file is genuinely "this deployment selects nothing"
 */
export async function readDeploymentImageSelection(
  configFile: string,
): Promise<ContainerImageHashOptions> {
  const { tools } = await readContainerToolsSelection(configFile);
  return { containerTools: tools };
}
