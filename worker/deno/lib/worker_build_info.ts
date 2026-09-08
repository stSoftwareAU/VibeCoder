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
 * The commit is read from the `VIBE_BUILD_COMMIT` environment variable.
 * Issue #1572: nothing ever set it, so `commit=unknown` was not a degraded
 * case but the only value the stamp could take, and a log line could never
 * say which code produced it. {@link resolveBuildCommit} is the producing
 * half — the launch plan resolves the staged checkout's HEAD with it and
 * hands the value to the container, so `unknown` now means a genuinely
 * unstamped build. {@link getWorkerBuildInfo} still never shells out, so the
 * reading half stays pure and testable.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { type GitCommandOutput, runGitCommand } from "./git_timeout.ts";
import type { Result } from "../types.ts";

/** Suffix marking a stamp whose checkout carried uncommitted changes. */
export const BUILD_COMMIT_DIRTY_SUFFIX = "-dirty";

/** The shape a stamped commit takes: a full sha, optionally `-dirty`. */
export const BUILD_COMMIT_PATTERN = /^[0-9a-f]{40}(-dirty)?$/;

/** A full git object name, as `git rev-parse HEAD` prints it. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

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
  const dirty = info.commit.endsWith(BUILD_COMMIT_DIRTY_SUFFIX);
  const sha = dirty
    ? info.commit.slice(0, -BUILD_COMMIT_DIRTY_SUFFIX.length)
    : info.commit;
  // The dirty marker survives truncation (Issue #1572): a stamp that reads
  // as a clean commit while the checkout carried uncommitted changes is
  // worse than `unknown`, because it names code that was never run.
  const shortCommit = info.commit === "unknown"
    ? "unknown"
    : `${sha.slice(0, 12)}${dirty ? BUILD_COMMIT_DIRTY_SUFFIX : ""}`;
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

/** Runs git for {@link resolveBuildCommit}; injectable for tests. */
export type BuildCommitGitRunner = (
  args: string[],
) => Promise<Result<GitCommandOutput>>;

/** What {@link resolveBuildCommit} concluded about a checkout. */
export interface BuildCommitResolution {
  /** The stamp — a 40-hex sha, `-dirty` when the tree was modified. */
  commit?: string;
  /** Why no stamp could be produced. Set exactly when `commit` is not. */
  reason?: string;
}

/**
 * Resolve the commit a checkout would run (Issue #1572).
 *
 * Called by the container launch plan against the checkout it is about to
 * mount, so the running worker reports the code it was actually launched
 * from. Both launchers update that checkout before the plan is built, so its
 * HEAD is the code the container runs.
 *
 * Never throws and never guesses: anything it cannot establish comes back as
 * a `reason` the caller logs, and the stamp degrades to `unknown` rather than
 * to a commit that was not run. In particular an unreadable worktree state is
 * *not* reported as clean — claiming a clean commit while running modified
 * code is the one outcome worse than `unknown`.
 *
 * @param baseDir - The checkout to stamp.
 * @param runGit - Git runner; defaults to the shared timeout/audit chokepoint.
 * @returns The stamp, or the reason there is none.
 */
export async function resolveBuildCommit(
  baseDir: string,
  runGit: BuildCommitGitRunner = (args) => runGitCommand(args),
): Promise<BuildCommitResolution> {
  const head = await runGit(["-C", baseDir, "rev-parse", "HEAD"]);
  if (!head.ok) {
    return { reason: `git rev-parse HEAD failed: ${head.error.message}` };
  }
  if (head.value.code !== 0) {
    const detail = head.value.stderr.trim() || head.value.stdout.trim();
    return {
      reason:
        `git rev-parse HEAD exited ${head.value.code} in ${baseDir}: ${detail}`,
    };
  }
  const sha = head.value.stdout.trim();
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    return {
      reason:
        `git rev-parse HEAD in ${baseDir} did not name a commit: "${sha}"`,
    };
  }

  // Tracked changes only: a stray scratch file in the checkout does not
  // change the code that runs, and marking every such run dirty would make
  // the marker noise rather than a signal.
  const status = await runGit([
    "-C",
    baseDir,
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (!status.ok || status.value.code !== 0) {
    const detail = status.ok
      ? status.value.stderr.trim() || `exit ${status.value.code}`
      : status.error.message;
    return {
      reason: `git status could not be read in ${baseDir} (${detail}) — ` +
        "refusing to stamp a possibly-modified checkout as clean",
    };
  }
  const dirty = status.value.stdout.trim().length > 0;
  return { commit: dirty ? `${sha}${BUILD_COMMIT_DIRTY_SUFFIX}` : sha };
}
