/**
 * Legacy in-repo config detection (Issue #2626).
 *
 * The `.vibecoder.json` in-repo configuration mechanism (Issue #1278) was
 * removed because a config channel from repo content into worker behaviour is
 * a steering/attack surface. Per-repo configuration now lives operator-side in
 * `.config.json` `repo_config`, which already supports every field and takes
 * precedence.
 *
 * No code path reads `.vibecoder.json` any more. This module only detects a
 * leftover file so the worker can emit one informative warning naming the
 * operator-side equivalent, rather than silently changing behaviour.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Filename of the removed in-repo configuration file. */
export const LEGACY_IN_REPO_CONFIG_FILENAME = ".vibecoder.json";

/**
 * Single informative warning line emitted when a leftover `.vibecoder.json`
 * is found. Names the operator-side equivalent so the operator can migrate.
 */
export const LEGACY_IN_REPO_CONFIG_WARNING =
  `Ignoring ${LEGACY_IN_REPO_CONFIG_FILENAME}: in-repo configuration was ` +
  `removed (Issue #2626). Configure this repo operator-side via .config.json ` +
  `repo_config instead.`;

/**
 * Returns true when a leftover `.vibecoder.json` file exists at the repo root.
 *
 * Never throws — any stat error (including not-found) yields false, so a
 * detection failure can never abort the worker.
 *
 * @param repoPath - Absolute path to the cloned repository root.
 */
export async function isLegacyInRepoConfigPresent(
  repoPath: string,
): Promise<boolean> {
  try {
    const stat = await Deno.stat(
      `${repoPath}/${LEGACY_IN_REPO_CONFIG_FILENAME}`,
    );
    return stat.isFile;
  } catch {
    return false;
  }
}
