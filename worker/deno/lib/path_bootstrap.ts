/**
 * PATH bootstrap helpers for unattended cron/launchd runs.
 *
 * Why this exists:
 * - cron often runs with a very minimal PATH (e.g., only /usr/bin:/bin)
 * - Homebrew installs tools into /opt/homebrew/bin (Apple Silicon) or
 *   /usr/local/bin (Intel), which cron may not include
 *
 * This module provides functions to build a complete PATH and verify
 * that required commands are available.
 *
 * Migrated from worker/shared/path_bootstrap.sh (Issue #902).
 */

/** Standard system paths to ensure are present. */
const SYSTEM_PATHS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/Library/Apple/usr/bin",
] as const;

/**
 * Common user-level binary directories (relative to HOME).
 *
 * `.deno/bin` is where the official Deno installer places `deno`; without
 * it, unattended launchd/cron subprocesses that resolve `deno` from PATH
 * fail their pre-flight (Issue #3532).
 */
const USER_PATH_SUFFIXES = [
  ".local/bin",
  "bin",
  ".deno/bin",
] as const;

/** Homebrew and common package manager locations to prepend. */
const PACKAGE_MANAGER_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
] as const;

/** Default fallback paths used by path_bootstrap_ensure_command. */
const DEFAULT_FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/homebrew/sbin",
  "/usr/local/sbin",
] as const;

/** Result of the PATH bootstrap operation. */
export interface PathBootstrapResult {
  /** The final PATH value after bootstrapping. */
  path: string;
  /** Directories that were added. */
  added: string[];
  /** Human-readable summary message. */
  message: string;
}

/** Result of ensuring a command is available. */
export interface EnsureCommandResult {
  /** Whether the command was found. */
  found: boolean;
  /** Directory where the command was found (if any). */
  foundIn?: string;
  /** Human-readable summary message. */
  message: string;
}

/**
 * Check whether a directory is already in the given PATH string.
 */
export function pathContainsDir(currentPath: string, dir: string): boolean {
  const parts = currentPath.split(":");
  return parts.includes(dir);
}

/**
 * Prepend a directory to the PATH if it exists on disk and is not already present.
 *
 * @returns The updated PATH string.
 */
export function prependDirIfPresent(
  currentPath: string,
  dir: string,
  dirExists: boolean,
): string {
  if (!dir || !dirExists) return currentPath;
  if (pathContainsDir(currentPath, dir)) return currentPath;

  if (!currentPath) return dir;
  return `${dir}:${currentPath}`;
}

/**
 * Prepend the directory that contains a resolved executable to the PATH,
 * deduplicating. Used to guarantee spawned subprocess scripts resolve the
 * same tool the worker already located (Issue #3532).
 *
 * The executable is assumed to exist (it was just resolved), so the
 * directory is treated as present. A path with no directory component
 * (no `/`, or a leading-`/` bare name) leaves the PATH unchanged.
 *
 * @returns The updated PATH string.
 */
export function prependExecutableDir(
  currentPath: string,
  execPath: string,
): string {
  const idx = execPath.lastIndexOf("/");
  if (idx <= 0) return currentPath;
  const dir = execPath.slice(0, idx);
  return prependDirIfPresent(currentPath, dir, true);
}

/**
 * Append a directory to the PATH if it exists on disk and is not already present.
 *
 * @returns The updated PATH string.
 */
export function appendDirIfPresent(
  currentPath: string,
  dir: string,
  dirExists: boolean,
): string {
  if (!dir || !dirExists) return currentPath;
  if (pathContainsDir(currentPath, dir)) return currentPath;

  if (!currentPath) return dir;
  return `${currentPath}:${dir}`;
}

/**
 * Check whether a directory exists on disk.
 */
async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Apply the default PATH bootstrap: add system paths, user paths,
 * Homebrew paths, and optional fallback paths.
 *
 * This mirrors the behaviour of path_bootstrap_apply_defaults() in
 * the original shell script.
 *
 * @param currentPath - The current PATH value.
 * @param homeDir - The user's home directory (or empty string if unavailable).
 * @param fallbackPaths - Optional colon-separated list of additional paths to prepend.
 * @returns The bootstrapped PATH result.
 */
export async function applyDefaults(
  currentPath: string,
  homeDir: string,
  fallbackPaths?: string,
): Promise<PathBootstrapResult> {
  let path = currentPath;
  const added: string[] = [];

  // 1. Ensure baseline system paths (append)
  for (const dir of SYSTEM_PATHS) {
    if (await dirExists(dir)) {
      const newPath = appendDirIfPresent(path, dir, true);
      if (newPath !== path) {
        added.push(dir);
        path = newPath;
      }
    }
  }

  // 2. Add user-level bins (prepend)
  if (homeDir) {
    for (const suffix of USER_PATH_SUFFIXES) {
      const dir = `${homeDir}/${suffix}`;
      if (await dirExists(dir)) {
        const newPath = prependDirIfPresent(path, dir, true);
        if (newPath !== path) {
          added.push(dir);
          path = newPath;
        }
      }
    }
  }

  // 3. Add package manager paths (prepend)
  for (const dir of PACKAGE_MANAGER_PATHS) {
    if (await dirExists(dir)) {
      const newPath = prependDirIfPresent(path, dir, true);
      if (newPath !== path) {
        added.push(dir);
        path = newPath;
      }
    }
  }

  // 4. Optional fallback list
  if (fallbackPaths) {
    const dirs = fallbackPaths.split(":").filter((d) => d.length > 0);
    for (const dir of dirs) {
      if (await dirExists(dir)) {
        const newPath = prependDirIfPresent(path, dir, true);
        if (newPath !== path) {
          added.push(dir);
          path = newPath;
        }
      }
    }
  }

  return {
    path,
    added,
    message: added.length > 0
      ? `PATH bootstrapped: added ${added.length} director${
        added.length === 1 ? "y" : "ies"
      }`
      : "PATH bootstrap: no directories needed adding",
  };
}

/**
 * Ensure a command is available on the PATH, searching fallback locations
 * if it is not already found.
 *
 * @param command - The command name to look for (e.g., "gh", "deno").
 * @param currentPath - The current PATH value.
 * @param fallbackPaths - Optional colon-separated list of fallback directories.
 * @returns Result indicating whether the command was found and where.
 */
export async function ensureCommand(
  command: string,
  currentPath: string,
  fallbackPaths?: string,
): Promise<EnsureCommandResult & { updatedPath: string }> {
  // Check if already on PATH
  const pathDirs = currentPath.split(":").filter((d) => d.length > 0);
  for (const dir of pathDirs) {
    try {
      const stat = await Deno.stat(`${dir}/${command}`);
      if (stat.isFile) {
        return {
          found: true,
          foundIn: dir,
          message: `${command} found in ${dir}`,
          updatedPath: currentPath,
        };
      }
    } catch {
      // Not found in this directory — continue
    }
  }

  // Search fallback locations
  const fallback = fallbackPaths ?? DEFAULT_FALLBACK_PATHS.join(":");
  const fallbackDirs = fallback.split(":").filter((d) => d.length > 0);

  for (const dir of fallbackDirs) {
    try {
      const stat = await Deno.stat(`${dir}/${command}`);
      if (stat.isFile) {
        const updatedPath = prependDirIfPresent(currentPath, dir, true);
        return {
          found: true,
          foundIn: dir,
          message: `${command} found in fallback ${dir}`,
          updatedPath,
        };
      }
    } catch {
      // Not found — continue
    }
  }

  return {
    found: false,
    message: `${command} not found in PATH or fallback locations`,
    updatedPath: currentPath,
  };
}
