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
 */ /**
 * Which spelling a host's paths use.
 *
 * The launcher runs on POSIX and Windows hosts alike, while the in-container
 * side is POSIX on every host, so the worker sees one environment regardless
 * of which launcher started it.
 */ /** A Windows drive-letter path, the only absolute form Windows hosts use. */ const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
/** A bare Windows drive root (`C:`, `C:\`, `C:/`). */ const WINDOWS_ROOT_RE = /^[A-Za-z]:[\\/]?$/;
/**
 * The path style a host path is written in.
 *
 * @param path - A host path (typically the worker checkout)
 * @returns The style that path is spelled in
 */ export function pathStyleFor(path) {
  return WINDOWS_ABSOLUTE_RE.test(path.trim()) ? "windows" : "posix";
}
/**
 * The separator paths are joined with in a given style.
 *
 * @param style - The host's path spelling
 * @returns The separator character
 */ export function separatorFor(style) {
  return style === "windows" ? "\\" : "/";
}
/**
 * Strip trailing separators so `/a/b/` and `/a/b` compare equal.
 *
 * @param path - The path to normalise
 * @param style - The host's path spelling
 * @returns The normalised path
 */ export function normalisePath(path, style = "posix") {
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
 */ export function isAbsolutePath(path, style) {
  return style === "windows" ? WINDOWS_ABSOLUTE_RE.test(path) : path.startsWith("/");
}
/**
 * True when the path is the filesystem (or drive) root.
 *
 * @param path - The path to test
 * @param style - The host's path spelling
 * @returns Whether the path is a root
 */ export function isRootPath(path, style) {
  return style === "windows" ? WINDOWS_ROOT_RE.test(path) : path === "/";
}
/**
 * A path reduced to a comparable form.
 *
 * Windows paths are matched case-insensitively and either separator, so
 * `C:\Users\Vibe` and `c:/users/vibe` are recognised as the same directory.
 *
 * @param path - The path to reduce
 * @param style - The host's path spelling
 * @returns The comparable form
 */ function comparablePath(path, style) {
  return style === "windows" ? path.replace(/\\/g, "/").toLowerCase() : path;
}
/**
 * True when `ancestor` is `path` itself or a directory above it.
 *
 * The containment predicate behind "never expose the host home directory, or
 * an ancestor of it" — shared by the launcher's mount-source allowlist
 * (Issue #4060) and the `container_extension` validator (Issue #978), so the
 * two cannot drift apart.
 *
 * @param ancestor - The candidate ancestor path
 * @param path - The path being protected
 * @param style - The host's path spelling
 * @returns Whether `ancestor` is at or above `path`
 */ export function isAtOrAbove(ancestor, path, style) {
  const left = comparablePath(ancestor, style);
  const right = comparablePath(path, style);
  return left === right || right.startsWith(`${left}/`);
}
/**
 * Whether a relative path stays inside the directory it is relative to.
 *
 * The confinement rule shared by every operator-supplied relative value: the
 * `container_tools` install prefix (`bin`/`env`) and the `container_extension`
 * directory (`containerfile`/`start`). `""` is the directory itself. Anything
 * absolute, `~`-anchored, NUL-bearing, newline-bearing, or walking above the
 * directory with `..` is out. A newline is rejected because the value is later
 * written to line-oriented files — `install-tools.sh` records one `KEY=value`
 * per line — where a second line is indistinguishable from a real one.
 *
 * @param value - The operator's relative value
 * @param style - The host's path spelling; `windows` also treats `\` as a
 *   separator and rejects a drive-absolute value
 * @returns Whether the value stays inside the directory
 */ export function isConfinedRelativePath(value, style = "posix") {
  if (value.includes("\0")) return false;
  if (/[\r\n]/.test(value)) return false;
  if (value.startsWith("~")) return false;
  if (isAbsolutePath(value, style)) return false;
  // A Windows host spells its separator `\`, so `..\..` escapes exactly as
  // `../..` does; a `\`-anchored value is absolute there too.
  if (style === "windows" && value.startsWith("\\")) return false;
  if (style === "posix" && value.startsWith("/")) return false;
  let depth = 0;
  for (const segment of value.split(style === "windows" ? /[\\/]/ : "/")){
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      depth--;
      if (depth < 0) return false;
      continue;
    }
    depth++;
  }
  return true;
}
/**
 * Join a relative path onto a base in the host's own spelling.
 *
 * @param base - The base directory
 * @param relative - The relative path, with any leading `./` dropped
 * @param style - The host's path spelling
 * @returns The joined path
 */ export function joinPath(base, relative, style) {
  const separator = separatorFor(style);
  const trimmed = relative.replace(/^\.[\\/]/, "");
  const spelled = style === "windows" ? trimmed.replace(/\//g, separator) : trimmed;
  return `${base}${separator}${spelled}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ob3N0X3BhdGhfc3R5bGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBIb3cgYSBob3N0IHNwZWxscyBpdHMgcGF0aHMgKElzc3VlICM3NTApLlxuICpcbiAqIEV4dHJhY3RlZCBmcm9tIGBjb250YWluZXJfbGF1bmNoLnRzYCwgd2hpY2ggcmVzb2x2ZWQgdGhlIGxhdW5jaGVyJ3MgaG9zdFxuICogcGF0aHMgYW5kIG93bmVkIHRoZXNlIGhlbHBlcnMgcHJpdmF0ZWx5LiBgaG9zdF9jb25maWdfcGF0aC50c2AgbXVzdCByZXNvbHZlIGFcbiAqIHJlbGF0aXZlIGBDT05GSUdfRklMRWAgYWdhaW5zdCBleGFjdGx5IHRoZSBzYW1lIGJhc2UsIGluIGV4YWN0bHkgdGhlIHNhbWVcbiAqIHNwZWxsaW5nLCBhcyB0aGUgbGF1bmNoZXIgZG9lcyDigJQgYW5kIHRoZSB3YXkgdG8gZ3VhcmFudGVlIHRoYXQgaXMgdG8gc2hhcmVcbiAqIHRoZSBjb2RlIHJhdGhlciB0aGFuIHRvIHdyaXRlIGl0IHR3aWNlLiBXcml0aW5nIGl0IHR3aWNlIGlzIHRoZSBkZWZlY3QgSXNzdWVcbiAqICM3NTAgcmVwb3J0cy5cbiAqXG4gKiBUaGUgc3R5bGUgaXMgZGVyaXZlZCBmcm9tIHRoZSBwYXRoIGl0c2VsZiByYXRoZXIgdGhhbiBmcm9tIGBEZW5vLmJ1aWxkLm9zYCxcbiAqIHNvIHRoZSBhbnN3ZXIgZm9yIGEgZ2l2ZW4gc2V0IG9mIGhvc3QgcGF0aHMgaXMgdGhlIHNhbWUgd2hlcmV2ZXIgaXQgaXNcbiAqIGNvbXB1dGVkIOKAlCBpbiB0aGUgbGF1bmNoZXIsIGluIHNldHVwLCBvciBpbiBhIHRlc3QuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuLyoqXG4gKiBXaGljaCBzcGVsbGluZyBhIGhvc3QncyBwYXRocyB1c2UuXG4gKlxuICogVGhlIGxhdW5jaGVyIHJ1bnMgb24gUE9TSVggYW5kIFdpbmRvd3MgaG9zdHMgYWxpa2UsIHdoaWxlIHRoZSBpbi1jb250YWluZXJcbiAqIHNpZGUgaXMgUE9TSVggb24gZXZlcnkgaG9zdCwgc28gdGhlIHdvcmtlciBzZWVzIG9uZSBlbnZpcm9ubWVudCByZWdhcmRsZXNzXG4gKiBvZiB3aGljaCBsYXVuY2hlciBzdGFydGVkIGl0LlxuICovXG5leHBvcnQgdHlwZSBMYXVuY2hlclBhdGhTdHlsZSA9IFwicG9zaXhcIiB8IFwid2luZG93c1wiO1xuXG4vKiogQSBXaW5kb3dzIGRyaXZlLWxldHRlciBwYXRoLCB0aGUgb25seSBhYnNvbHV0ZSBmb3JtIFdpbmRvd3MgaG9zdHMgdXNlLiAqL1xuY29uc3QgV0lORE9XU19BQlNPTFVURV9SRSA9IC9eW0EtWmEtel06W1xcXFwvXS87XG5cbi8qKiBBIGJhcmUgV2luZG93cyBkcml2ZSByb290IChgQzpgLCBgQzpcXGAsIGBDOi9gKS4gKi9cbmNvbnN0IFdJTkRPV1NfUk9PVF9SRSA9IC9eW0EtWmEtel06W1xcXFwvXT8kLztcblxuLyoqXG4gKiBUaGUgcGF0aCBzdHlsZSBhIGhvc3QgcGF0aCBpcyB3cml0dGVuIGluLlxuICpcbiAqIEBwYXJhbSBwYXRoIC0gQSBob3N0IHBhdGggKHR5cGljYWxseSB0aGUgd29ya2VyIGNoZWNrb3V0KVxuICogQHJldHVybnMgVGhlIHN0eWxlIHRoYXQgcGF0aCBpcyBzcGVsbGVkIGluXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXRoU3R5bGVGb3IocGF0aDogc3RyaW5nKTogTGF1bmNoZXJQYXRoU3R5bGUge1xuICByZXR1cm4gV0lORE9XU19BQlNPTFVURV9SRS50ZXN0KHBhdGgudHJpbSgpKSA/IFwid2luZG93c1wiIDogXCJwb3NpeFwiO1xufVxuXG4vKipcbiAqIFRoZSBzZXBhcmF0b3IgcGF0aHMgYXJlIGpvaW5lZCB3aXRoIGluIGEgZ2l2ZW4gc3R5bGUuXG4gKlxuICogQHBhcmFtIHN0eWxlIC0gVGhlIGhvc3QncyBwYXRoIHNwZWxsaW5nXG4gKiBAcmV0dXJucyBUaGUgc2VwYXJhdG9yIGNoYXJhY3RlclxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VwYXJhdG9yRm9yKHN0eWxlOiBMYXVuY2hlclBhdGhTdHlsZSk6IHN0cmluZyB7XG4gIHJldHVybiBzdHlsZSA9PT0gXCJ3aW5kb3dzXCIgPyBcIlxcXFxcIiA6IFwiL1wiO1xufVxuXG4vKipcbiAqIFN0cmlwIHRyYWlsaW5nIHNlcGFyYXRvcnMgc28gYC9hL2IvYCBhbmQgYC9hL2JgIGNvbXBhcmUgZXF1YWwuXG4gKlxuICogQHBhcmFtIHBhdGggLSBUaGUgcGF0aCB0byBub3JtYWxpc2VcbiAqIEBwYXJhbSBzdHlsZSAtIFRoZSBob3N0J3MgcGF0aCBzcGVsbGluZ1xuICogQHJldHVybnMgVGhlIG5vcm1hbGlzZWQgcGF0aFxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXNlUGF0aChcbiAgcGF0aDogc3RyaW5nLFxuICBzdHlsZTogTGF1bmNoZXJQYXRoU3R5bGUgPSBcInBvc2l4XCIsXG4pOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gcGF0aC50cmltKCk7XG4gIGlmIChzdHlsZSA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAgICAvLyBUaGUgZHJpdmUgcm9vdCBrZWVwcyBpdHMgc2VwYXJhdG9yOiBgQzpgIGFsb25lIGlzIGEgZHJpdmUtcmVsYXRpdmVcbiAgICAvLyBwYXRoIG9uIFdpbmRvd3MsIHdoaWNoIGlzIG5vdCB0aGUgc2FtZSB0aGluZyBhcyBgQzpcXGAuXG4gICAgaWYgKFdJTkRPV1NfUk9PVF9SRS50ZXN0KHRyaW1tZWQpKSByZXR1cm4gdHJpbW1lZDtcbiAgICByZXR1cm4gdHJpbW1lZC5yZXBsYWNlKC9bXFxcXC9dKyQvLCBcIlwiKTtcbiAgfVxuICBpZiAodHJpbW1lZC5sZW5ndGggPiAxICYmIHRyaW1tZWQuZW5kc1dpdGgoXCIvXCIpKSB7XG4gICAgcmV0dXJuIHRyaW1tZWQucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgfVxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuLyoqXG4gKiBUcnVlIHdoZW4gdGhlIHBhdGggaXMgYWJzb2x1dGUgaW4gdGhlIGdpdmVuIHN0eWxlLlxuICpcbiAqIEBwYXJhbSBwYXRoIC0gVGhlIHBhdGggdG8gdGVzdFxuICogQHBhcmFtIHN0eWxlIC0gVGhlIGhvc3QncyBwYXRoIHNwZWxsaW5nXG4gKiBAcmV0dXJucyBXaGV0aGVyIHRoZSBwYXRoIGlzIGFic29sdXRlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0Fic29sdXRlUGF0aChcbiAgcGF0aDogc3RyaW5nLFxuICBzdHlsZTogTGF1bmNoZXJQYXRoU3R5bGUsXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIHN0eWxlID09PSBcIndpbmRvd3NcIlxuICAgID8gV0lORE9XU19BQlNPTFVURV9SRS50ZXN0KHBhdGgpXG4gICAgOiBwYXRoLnN0YXJ0c1dpdGgoXCIvXCIpO1xufVxuXG4vKipcbiAqIFRydWUgd2hlbiB0aGUgcGF0aCBpcyB0aGUgZmlsZXN5c3RlbSAob3IgZHJpdmUpIHJvb3QuXG4gKlxuICogQHBhcmFtIHBhdGggLSBUaGUgcGF0aCB0byB0ZXN0XG4gKiBAcGFyYW0gc3R5bGUgLSBUaGUgaG9zdCdzIHBhdGggc3BlbGxpbmdcbiAqIEByZXR1cm5zIFdoZXRoZXIgdGhlIHBhdGggaXMgYSByb290XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1Jvb3RQYXRoKHBhdGg6IHN0cmluZywgc3R5bGU6IExhdW5jaGVyUGF0aFN0eWxlKTogYm9vbGVhbiB7XG4gIHJldHVybiBzdHlsZSA9PT0gXCJ3aW5kb3dzXCIgPyBXSU5ET1dTX1JPT1RfUkUudGVzdChwYXRoKSA6IHBhdGggPT09IFwiL1wiO1xufVxuXG4vKipcbiAqIEEgcGF0aCByZWR1Y2VkIHRvIGEgY29tcGFyYWJsZSBmb3JtLlxuICpcbiAqIFdpbmRvd3MgcGF0aHMgYXJlIG1hdGNoZWQgY2FzZS1pbnNlbnNpdGl2ZWx5IGFuZCBlaXRoZXIgc2VwYXJhdG9yLCBzb1xuICogYEM6XFxVc2Vyc1xcVmliZWAgYW5kIGBjOi91c2Vycy92aWJlYCBhcmUgcmVjb2duaXNlZCBhcyB0aGUgc2FtZSBkaXJlY3RvcnkuXG4gKlxuICogQHBhcmFtIHBhdGggLSBUaGUgcGF0aCB0byByZWR1Y2VcbiAqIEBwYXJhbSBzdHlsZSAtIFRoZSBob3N0J3MgcGF0aCBzcGVsbGluZ1xuICogQHJldHVybnMgVGhlIGNvbXBhcmFibGUgZm9ybVxuICovXG5mdW5jdGlvbiBjb21wYXJhYmxlUGF0aChwYXRoOiBzdHJpbmcsIHN0eWxlOiBMYXVuY2hlclBhdGhTdHlsZSk6IHN0cmluZyB7XG4gIHJldHVybiBzdHlsZSA9PT0gXCJ3aW5kb3dzXCIgPyBwYXRoLnJlcGxhY2UoL1xcXFwvZywgXCIvXCIpLnRvTG93ZXJDYXNlKCkgOiBwYXRoO1xufVxuXG4vKipcbiAqIFRydWUgd2hlbiBgYW5jZXN0b3JgIGlzIGBwYXRoYCBpdHNlbGYgb3IgYSBkaXJlY3RvcnkgYWJvdmUgaXQuXG4gKlxuICogVGhlIGNvbnRhaW5tZW50IHByZWRpY2F0ZSBiZWhpbmQgXCJuZXZlciBleHBvc2UgdGhlIGhvc3QgaG9tZSBkaXJlY3RvcnksIG9yXG4gKiBhbiBhbmNlc3RvciBvZiBpdFwiIOKAlCBzaGFyZWQgYnkgdGhlIGxhdW5jaGVyJ3MgbW91bnQtc291cmNlIGFsbG93bGlzdFxuICogKElzc3VlICM0MDYwKSBhbmQgdGhlIGBjb250YWluZXJfZXh0ZW5zaW9uYCB2YWxpZGF0b3IgKElzc3VlICM5NzgpLCBzbyB0aGVcbiAqIHR3byBjYW5ub3QgZHJpZnQgYXBhcnQuXG4gKlxuICogQHBhcmFtIGFuY2VzdG9yIC0gVGhlIGNhbmRpZGF0ZSBhbmNlc3RvciBwYXRoXG4gKiBAcGFyYW0gcGF0aCAtIFRoZSBwYXRoIGJlaW5nIHByb3RlY3RlZFxuICogQHBhcmFtIHN0eWxlIC0gVGhlIGhvc3QncyBwYXRoIHNwZWxsaW5nXG4gKiBAcmV0dXJucyBXaGV0aGVyIGBhbmNlc3RvcmAgaXMgYXQgb3IgYWJvdmUgYHBhdGhgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0F0T3JBYm92ZShcbiAgYW5jZXN0b3I6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBzdHlsZTogTGF1bmNoZXJQYXRoU3R5bGUsXG4pOiBib29sZWFuIHtcbiAgY29uc3QgbGVmdCA9IGNvbXBhcmFibGVQYXRoKGFuY2VzdG9yLCBzdHlsZSk7XG4gIGNvbnN0IHJpZ2h0ID0gY29tcGFyYWJsZVBhdGgocGF0aCwgc3R5bGUpO1xuICByZXR1cm4gbGVmdCA9PT0gcmlnaHQgfHwgcmlnaHQuc3RhcnRzV2l0aChgJHtsZWZ0fS9gKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgcmVsYXRpdmUgcGF0aCBzdGF5cyBpbnNpZGUgdGhlIGRpcmVjdG9yeSBpdCBpcyByZWxhdGl2ZSB0by5cbiAqXG4gKiBUaGUgY29uZmluZW1lbnQgcnVsZSBzaGFyZWQgYnkgZXZlcnkgb3BlcmF0b3Itc3VwcGxpZWQgcmVsYXRpdmUgdmFsdWU6IHRoZVxuICogYGNvbnRhaW5lcl90b29sc2AgaW5zdGFsbCBwcmVmaXggKGBiaW5gL2BlbnZgKSBhbmQgdGhlIGBjb250YWluZXJfZXh0ZW5zaW9uYFxuICogZGlyZWN0b3J5IChgY29udGFpbmVyZmlsZWAvYHN0YXJ0YCkuIGBcIlwiYCBpcyB0aGUgZGlyZWN0b3J5IGl0c2VsZi4gQW55dGhpbmdcbiAqIGFic29sdXRlLCBgfmAtYW5jaG9yZWQsIE5VTC1iZWFyaW5nLCBuZXdsaW5lLWJlYXJpbmcsIG9yIHdhbGtpbmcgYWJvdmUgdGhlXG4gKiBkaXJlY3Rvcnkgd2l0aCBgLi5gIGlzIG91dC4gQSBuZXdsaW5lIGlzIHJlamVjdGVkIGJlY2F1c2UgdGhlIHZhbHVlIGlzIGxhdGVyXG4gKiB3cml0dGVuIHRvIGxpbmUtb3JpZW50ZWQgZmlsZXMg4oCUIGBpbnN0YWxsLXRvb2xzLnNoYCByZWNvcmRzIG9uZSBgS0VZPXZhbHVlYFxuICogcGVyIGxpbmUg4oCUIHdoZXJlIGEgc2Vjb25kIGxpbmUgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIHJlYWwgb25lLlxuICpcbiAqIEBwYXJhbSB2YWx1ZSAtIFRoZSBvcGVyYXRvcidzIHJlbGF0aXZlIHZhbHVlXG4gKiBAcGFyYW0gc3R5bGUgLSBUaGUgaG9zdCdzIHBhdGggc3BlbGxpbmc7IGB3aW5kb3dzYCBhbHNvIHRyZWF0cyBgXFxgIGFzIGFcbiAqICAgc2VwYXJhdG9yIGFuZCByZWplY3RzIGEgZHJpdmUtYWJzb2x1dGUgdmFsdWVcbiAqIEByZXR1cm5zIFdoZXRoZXIgdGhlIHZhbHVlIHN0YXlzIGluc2lkZSB0aGUgZGlyZWN0b3J5XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0NvbmZpbmVkUmVsYXRpdmVQYXRoKFxuICB2YWx1ZTogc3RyaW5nLFxuICBzdHlsZTogTGF1bmNoZXJQYXRoU3R5bGUgPSBcInBvc2l4XCIsXG4pOiBib29sZWFuIHtcbiAgaWYgKHZhbHVlLmluY2x1ZGVzKFwiXFwwXCIpKSByZXR1cm4gZmFsc2U7XG4gIGlmICgvW1xcclxcbl0vLnRlc3QodmFsdWUpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiflwiKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoaXNBYnNvbHV0ZVBhdGgodmFsdWUsIHN0eWxlKSkgcmV0dXJuIGZhbHNlO1xuICAvLyBBIFdpbmRvd3MgaG9zdCBzcGVsbHMgaXRzIHNlcGFyYXRvciBgXFxgLCBzbyBgLi5cXC4uYCBlc2NhcGVzIGV4YWN0bHkgYXNcbiAgLy8gYC4uLy4uYCBkb2VzOyBhIGBcXGAtYW5jaG9yZWQgdmFsdWUgaXMgYWJzb2x1dGUgdGhlcmUgdG9vLlxuICBpZiAoc3R5bGUgPT09IFwid2luZG93c1wiICYmIHZhbHVlLnN0YXJ0c1dpdGgoXCJcXFxcXCIpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChzdHlsZSA9PT0gXCJwb3NpeFwiICYmIHZhbHVlLnN0YXJ0c1dpdGgoXCIvXCIpKSByZXR1cm4gZmFsc2U7XG5cbiAgbGV0IGRlcHRoID0gMDtcbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHZhbHVlLnNwbGl0KHN0eWxlID09PSBcIndpbmRvd3NcIiA/IC9bXFxcXC9dLyA6IFwiL1wiKSkge1xuICAgIGlmIChzZWdtZW50ID09PSBcIlwiIHx8IHNlZ21lbnQgPT09IFwiLlwiKSBjb250aW51ZTtcbiAgICBpZiAoc2VnbWVudCA9PT0gXCIuLlwiKSB7XG4gICAgICBkZXB0aC0tO1xuICAgICAgaWYgKGRlcHRoIDwgMCkgcmV0dXJuIGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGRlcHRoKys7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogSm9pbiBhIHJlbGF0aXZlIHBhdGggb250byBhIGJhc2UgaW4gdGhlIGhvc3QncyBvd24gc3BlbGxpbmcuXG4gKlxuICogQHBhcmFtIGJhc2UgLSBUaGUgYmFzZSBkaXJlY3RvcnlcbiAqIEBwYXJhbSByZWxhdGl2ZSAtIFRoZSByZWxhdGl2ZSBwYXRoLCB3aXRoIGFueSBsZWFkaW5nIGAuL2AgZHJvcHBlZFxuICogQHBhcmFtIHN0eWxlIC0gVGhlIGhvc3QncyBwYXRoIHNwZWxsaW5nXG4gKiBAcmV0dXJucyBUaGUgam9pbmVkIHBhdGhcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGpvaW5QYXRoKFxuICBiYXNlOiBzdHJpbmcsXG4gIHJlbGF0aXZlOiBzdHJpbmcsXG4gIHN0eWxlOiBMYXVuY2hlclBhdGhTdHlsZSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHNlcGFyYXRvciA9IHNlcGFyYXRvckZvcihzdHlsZSk7XG4gIGNvbnN0IHRyaW1tZWQgPSByZWxhdGl2ZS5yZXBsYWNlKC9eXFwuW1xcXFwvXS8sIFwiXCIpO1xuICBjb25zdCBzcGVsbGVkID0gc3R5bGUgPT09IFwid2luZG93c1wiXG4gICAgPyB0cmltbWVkLnJlcGxhY2UoL1xcLy9nLCBzZXBhcmF0b3IpXG4gICAgOiB0cmltbWVkO1xuICByZXR1cm4gYCR7YmFz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
// denoCacheMetadata=11052301875837427741,6138619033533221406