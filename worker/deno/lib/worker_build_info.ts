/**
 * Worker build/version stamping (Issue #3138).
 *
 * A duplicate-PR investigation needs to know *which build* each fleet
 * host was running. If a host is running a build from before a guard fix
 * merged, the guard behaves as it did pre-fix — and without a version
 * stamp in the logs that is impossible to tell apart from a genuine guard
 * bug. This module resolves the worker's build identity (semantic version
 * plus git commit) and formats it for the startup banner and for
 * claim-time / PR-open log lines.
 *
 * The commit is read from the `VIBE_BUILD_COMMIT` environment variable,
 * which the shell orchestration layer stamps at deploy time. When it is
 * absent (e.g. a local dev run) the commit is reported as `unknown` — the
 * function never shells out to git so it stays pure and testable.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/** Resolved build identity of the running worker. */
export interface WorkerBuildInfo {
  /** Semantic version (from deno.json, the single source of truth). */
  version: string;
  /** Git commit SHA, or `unknown` when not stamped. */
  commit: string;
}

/**
 * Resolve the worker's build identity.
 *
 * @param version - The semantic version (pass `VERSION` from version.ts).
 * @param envGet - Environment reader (injectable for tests; defaults to
 *   `Deno.env.get`).
 * @returns The resolved {@link WorkerBuildInfo}.
 */
export function getWorkerBuildInfo(
  version: string,
  envGet: (key: string) => string | undefined = (k) => Deno.env.get(k),
): WorkerBuildInfo {
  const raw = envGet("VIBE_BUILD_COMMIT");
  const commit = raw && raw.trim().length > 0 ? raw.trim() : "unknown";
  return {
    version: version && version.trim().length > 0 ? version.trim() : "unknown",
    commit,
  };
}

/**
 * Format the build identity as a single stamp string.
 *
 * Long commit SHAs are truncated to 12 characters for readability; the
 * `unknown` sentinel is passed through verbatim.
 *
 * @param info - The build identity to format.
 * @returns e.g. `version=1.2.3 commit=abcdef012345`.
 */
export function formatBuildStamp(info: WorkerBuildInfo): string {
  const shortCommit = info.commit === "unknown"
    ? "unknown"
    : info.commit.slice(0, 12);
  return `version=${info.version} commit=${shortCommit}`;
}

/**
 * Format the build identity as a full startup banner line.
 *
 * @param info - The build identity to format.
 * @returns e.g. `[worker-build] version=1.2.3 commit=abcdef012345`.
 */
export function formatBuildBanner(info: WorkerBuildInfo): string {
  return `[worker-build] ${formatBuildStamp(info)}`;
}

/**
 * Read the worker's semantic version from deno.json — the single source
 * of truth (Issue #226). Returns `unknown` if the file cannot be read or
 * parsed so build stamping never throws in a caller.
 */
export function readWorkerVersion(): string {
  try {
    const denoJsonPath = new URL("../deno.json", import.meta.url);
    const denoJson = JSON.parse(Deno.readTextFileSync(denoJsonPath));
    const version = denoJson.version;
    return typeof version === "string" && version.trim().length > 0
      ? version.trim()
      : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Convenience resolver combining {@link readWorkerVersion} and
 * {@link getWorkerBuildInfo}. Lives in lib so callers outside the command
 * layer avoid a lib→commands dependency.
 */
export function resolveWorkerBuildInfo(): WorkerBuildInfo {
  return getWorkerBuildInfo(readWorkerVersion());
}
