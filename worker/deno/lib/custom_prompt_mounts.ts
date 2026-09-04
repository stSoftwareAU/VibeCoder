/**
 * Custom-prompt mounts for the container launch plan (Issue #850, part of
 * #843).
 *
 * `custom_label_prompts` (Issue #846) names prompt templates that live on the
 * **host**, outside the public repository. The worker runs containerised by
 * default, and the container sees the workspace rather than the host
 * (Issue #4060), so without a mount every custom prompt fails at dispatch
 * inside the container — the fail-loud error from Issue #848, on every run.
 *
 * This module derives the narrowest addition consistent with that containment
 * posture:
 *
 * - **The containing directory, not the file.** Apple `container` cannot bind
 *   a single file — a file mount silently empties the container's other
 *   volumes — so one directory per distinct parent, deduplicated, is mounted
 *   instead. Everything beside the prompt in that directory becomes readable
 *   inside the container, which is why an operator should keep the prompts in
 *   a directory of their own.
 * - **Read-only, always.** The caller marks every mount `readOnly`; nothing
 *   inside the container has any business editing the operator's templates.
 * - **Still subject to the existing allowlist.** The sources are returned, not
 *   mounted: `buildContainerLaunchPlan` routes each through
 *   `assertMountSourcePermitted`, so a prompt under the host home directory
 *   (or an ancestor of it), the filesystem root, or a runtime control socket
 *   fails the launch with the existing containment error rather than being
 *   dropped from the mount list.
 *
 * ## Why a translation map rather than a rewritten config
 *
 * The same `.config.json` is used in both modes, so the configured path stays
 * the host path an operator wrote. The launcher passes the host → in-container
 * mapping in {@link CUSTOM_PROMPT_PATH_MAP_ENV}, and the config loader applies
 * it when it validates the mappings. A read outside the container — the
 * launcher's own, setup, a dev run — sets no variable and resolves the host
 * path unchanged. (`run_mode: native` was removed by Issue #4; this is about
 * where the config is read, not a run mode.)
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { LauncherPathStyle } from "./host_path_style.ts";

/**
 * Environment variable carrying the host → in-container prompt path map, as
 * a JSON object. Set by the launch plan only when mappings are configured, so
 * an unconfigured deployment's plan is byte-identical to what it was before.
 */
export const CUSTOM_PROMPT_PATH_MAP_ENV = "VIBE_CUSTOM_PROMPT_PATHS";

/**
 * In-container directory the mounted prompt directories land under, relative
 * to the container home — beside the staged configuration's `run-config`.
 */
export const CUSTOM_PROMPTS_TARGET_SUBDIR = ".vibe-coder/custom-prompts";

/** One derived read-only bind mount. */
export interface CustomPromptMount {
  /** Host directory holding one or more configured prompt files. */
  source: string;
  /** Where that directory is mounted inside the container. */
  target: string;
}

/** The mounts and the translation they imply. */
export interface CustomPromptMountPlan {
  /** Mounts, one per distinct host directory, in configuration order. */
  mounts: CustomPromptMount[];
  /** Configured host path → the in-container path it is readable at. */
  translations: Record<string, string>;
}

/**
 * True when a path carries a `.` or `..` segment.
 *
 * The mount-source allowlist in `container_launch.ts` compares **strings**:
 * it has no filesystem to consult and deliberately never had one. A
 * `..` segment therefore walks straight past it —
 * `/srv/../home/operator/x.md` yields the source `/srv/../home/operator`,
 * which is not string-equal to the home directory but is exactly it once the
 * runtime resolves the mount. Every other mount source is a path the worker
 * itself derived; a configured prompt path is the first an operator writes
 * by hand, so the traversal spelling is refused rather than trusted.
 *
 * @param path - A host path
 * @returns Whether any segment is `.` or `..`
 */
export function hasTraversalSegment(path: string): boolean {
  return path.split(/[/\\]/).some((segment) =>
    segment === "." || segment === ".."
  );
}

/**
 * Refuse a configured prompt path the containment allowlist cannot be
 * trusted to judge (Issue #850).
 *
 * Both faults are the same fault: the string the allowlist checks is not the
 * path the runtime will mount. A `..` segment says so in the spelling; a
 * symlink says so only once resolved. Either way the launch fails here, with
 * the resolved path named so the operator can configure it directly, rather
 * than a broadened mount reaching the runtime.
 *
 * @param promptPath - The configured absolute host path
 * @param realPath - Resolver for symlinks and relative segments
 * @throws When the path carries a `.`/`..` segment, cannot be resolved, or
 *   resolves to somewhere other than itself
 */
export function assertCustomPromptSourceResolvable(
  promptPath: string,
  realPath: (path: string) => string,
): void {
  if (hasTraversalSegment(promptPath)) {
    throw new Error(
      `Refusing to launch: the custom prompt path ${promptPath} contains a ` +
        `"." or ".." segment, so the mount it derives would not be the path ` +
        `the containment allowlist checked. Configure the resolved path.`,
    );
  }

  let resolved: string;
  try {
    resolved = realPath(promptPath);
  } catch (error) {
    throw new Error(
      `Refusing to launch: the custom prompt path ${promptPath} cannot be ` +
        `resolved (${(error as Error).message}).`,
    );
  }
  if (resolved !== promptPath) {
    throw new Error(
      `Refusing to launch: the custom prompt path ${promptPath} resolves to ` +
        `${resolved}, so the directory the runtime would mount is not the ` +
        `one the containment allowlist checked. Configure ${resolved}.`,
    );
  }
}

/** Split a host path into its directory and file name, in the host's spelling. */
function splitPath(
  path: string,
  style: LauncherPathStyle,
): { directory: string; name: string } {
  const lastSlash = path.lastIndexOf("/");
  const lastBackslash = style === "windows" ? path.lastIndexOf("\\") : -1;
  const index = Math.max(lastSlash, lastBackslash);
  // A path whose only separator is its first character keeps that separator
  // as the directory: `/rogue.md` is in the filesystem root, and the launch
  // plan's allowlist refuses to mount it.
  const directory = index <= 0
    ? path.slice(0, index + 1)
    // Trailing separators are stripped so `/srv/p//a.md` and `/srv/p/b.md`
    // are recognised as one directory and share one mount.
    : path.slice(0, index).replace(/[/\\]+$/, "");
  return { directory, name: path.slice(index + 1) };
}

/**
 * Derive the read-only mount set and the path translation for the configured
 * prompt files.
 *
 * @param promptPaths - Configured absolute host paths, in configuration order
 * @param targetBase - In-container directory the mounts land under
 * @param style - How this host spells its paths; POSIX unless stated
 * @returns The mounts (one per distinct directory) and the host → container
 *   path translation for every configured prompt
 */
export function planCustomPromptMounts(
  promptPaths: readonly string[],
  targetBase: string,
  style: LauncherPathStyle = "posix",
): CustomPromptMountPlan {
  const mounts: CustomPromptMount[] = [];
  const targetForDirectory = new Map<string, string>();
  const translations: Record<string, string> = {};

  for (const promptPath of promptPaths) {
    const { directory, name } = splitPath(promptPath, style);
    let target = targetForDirectory.get(directory);
    if (target === undefined) {
      // Numbered rather than named after the host directory: an index cannot
      // collide, and the translation map records where each one came from.
      target = `${targetBase}/${mounts.length + 1}`;
      targetForDirectory.set(directory, target);
      mounts.push({ source: directory, target });
    }
    // The in-container side is POSIX on every host, including a Windows one.
    translations[promptPath] = `${target}/${name}`;
  }

  return { mounts, translations };
}

/**
 * Parse the launcher's translation map — fail loud, never partially applied.
 *
 * @param raw - The raw {@link CUSTOM_PROMPT_PATH_MAP_ENV} value
 * @returns The map; empty when the variable is unset or blank — a read
 *   outside the container, where the host path is the readable one
 * @throws When the value is not a JSON object of string → string entries: a
 *   mangled map would resolve a prompt onto the wrong file, or onto none.
 */
export function parseCustomPromptPathMap(
  raw: string | undefined,
): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${CUSTOM_PROMPT_PATH_MAP_ENV} is not valid JSON (${
        (error as Error).message
      }) — the custom prompt paths cannot be resolved inside the container.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${CUSTOM_PROMPT_PATH_MAP_ENV} must be a JSON object mapping each ` +
        `configured host prompt path to its in-container path.`,
    );
  }

  const map: Record<string, string> = {};
  for (const [hostPath, containerPath] of Object.entries(parsed)) {
    if (typeof containerPath !== "string" || containerPath === "") {
      throw new Error(
        `${CUSTOM_PROMPT_PATH_MAP_ENV} entry for ${hostPath} must be a ` +
          `non-empty in-container path.`,
      );
    }
    map[hostPath] = containerPath;
  }
  return map;
}

/**
 * A resolver for a configured prompt path.
 *
 * A path the map does not name is returned unchanged, so the config loader's
 * own readability check fails loud naming the path the operator configured
 * rather than one this module invented.
 *
 * @param raw - The raw {@link CUSTOM_PROMPT_PATH_MAP_ENV} value
 * @returns A function resolving a configured host path to where it is readable
 * @throws When the map is present but malformed
 */
export function customPromptPathResolver(
  raw: string | undefined,
): (promptPath: string) => string {
  const map = parseCustomPromptPathMap(raw);
  return (promptPath: string) => map[promptPath] ?? promptPath;
}
