/**
 * How a host spells its paths (Issue #750).
 *
 * Extracted from `container_launch.ts`, which resolved the launcher's host
 * paths and owned these helpers privately. `host_config_path.ts` must resolve a
 * relative `CONFIG_FILE` against exactly the same base, in exactly the same
 * spelling, as the launcher does — and the way to guarantee that is to share
 * the code rather than to write it twice. Writing it twice is the defect Issue
 * #750 reports.
 *
 * The style is derived from the path itself rather than from `Deno.build.os`,
 * so the answer for a given set of host paths is the same wherever it is
 * computed — in the launcher, in setup, or in a test.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Which spelling a host's paths use.
 *
 * The launcher runs on POSIX and Windows hosts alike, while the in-container
 * side is POSIX on every host, so the worker sees one environment regardless
 * of which launcher started it.
 */
export type LauncherPathStyle = "posix" | "windows";

/** A Windows drive-letter path, the only absolute form Windows hosts use. */
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;

/** A bare Windows drive root (`C:`, `C:\`, `C:/`). */
const WINDOWS_ROOT_RE = /^[A-Za-z]:[\\/]?$/;

/**
 * The path style a host path is written in.
 *
 * @param path - A host path (typically the worker checkout)
 * @returns The style that path is spelled in
 */
export function pathStyleFor(path: string): LauncherPathStyle {
  return WINDOWS_ABSOLUTE_RE.test(path.trim()) ? "windows" : "posix";
}

/**
 * The separator paths are joined with in a given style.
 *
 * @param style - The host's path spelling
 * @returns The separator character
 */
export function separatorFor(style: LauncherPathStyle): string {
  return style === "windows" ? "\\" : "/";
}

/**
 * Strip trailing separators so `/a/b/` and `/a/b` compare equal.
 *
 * @param path - The path to normalise
 * @param style - The host's path spelling
 * @returns The normalised path
 */
export function normalisePath(
  path: string,
  style: LauncherPathStyle = "posix",
): string {
  const trimmed = path.trim();
  if (style === "windows") {
    // The drive root keeps its separator: `C:` alone is a drive-relative
    // path on Windows, which is not the same thing as `C:\`.
    if (WINDOWS_ROOT_RE.test(trimmed)) return trimmed;
    return trimmed.replace(/[\\/]+$/, "");
  }
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.replace(/\/+$/, "");
  }
  return trimmed;
}

/**
 * True when the path is absolute in the given style.
 *
 * @param path - The path to test
 * @param style - The host's path spelling
 * @returns Whether the path is absolute
 */
export function isAbsolutePath(
  path: string,
  style: LauncherPathStyle,
): boolean {
  return style === "windows"
    ? WINDOWS_ABSOLUTE_RE.test(path)
    : path.startsWith("/");
}

/**
 * True when the path is the filesystem (or drive) root.
 *
 * @param path - The path to test
 * @param style - The host's path spelling
 * @returns Whether the path is a root
 */
export function isRootPath(path: string, style: LauncherPathStyle): boolean {
  return style === "windows" ? WINDOWS_ROOT_RE.test(path) : path === "/";
}

/**
 * Join a relative path onto a base in the host's own spelling.
 *
 * @param base - The base directory
 * @param relative - The relative path, with any leading `./` dropped
 * @param style - The host's path spelling
 * @returns The joined path
 */
export function joinPath(
  base: string,
  relative: string,
  style: LauncherPathStyle,
): string {
  const separator = separatorFor(style);
  const trimmed = relative.replace(/^\.[\\/]/, "");
  const spelled = style === "windows"
    ? trimmed.replace(/\//g, separator)
    : trimmed;
  return `${base}${separator}${spelled}`;
}
