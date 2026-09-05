/**
 * PR CI check monitoring for the Vibe Coder worker (Issue #915).
 *
 * Handles finding failed CI checks on open PRs, tracking retry counts,
 * and posting max-retry comments.
 *
 * Replaces the CI check functions from worker/shared/pr_manager.sh.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/** Information about a failed CI check. */
export interface FailedCiCheck {
  /** Repository in "owner/repo" format */
  repo: string;
  /** PR number */
  prNumber: number;
  /** Head branch name */
  branchName: string;
  /** Check run ID */
  checkId: string;
  /** Check name */
  checkName: string;
  /** Base64-encoded annotations JSON */
  encodedAnnotations: string;
  /**
   * Optional check `target_url` / `details_url` (Issue #1892).
   * Used by the PR failure action dispatcher to locate the external
   * build (e.g. extract a build number from a URL like
   * `https://ci.example.com/job/foo/job/Develop/123/`). Optional
   * because not all check sources populate it.
   */
  targetUrl?: string;
}

/**
 * Sanitise a repository name for use in filenames.
 *
 * @param repo - Repository in "owner/repo" format
 * @returns Safe filename component
 */
export function sanitiseRepoName(repo: string): string {
  return repo.replace("/", "_");
}

/**
 * Record a CI check retry in the state directory (Issue #562).
 *
 * @param stateDir - Directory for retry state files
 * @param repo - Repository in "owner/name" format
 * @param checkId - The GitHub check run ID
 * @returns The new retry count
 */
export async function recordCiCheckRetry(
  stateDir: string,
  repo: string,
  checkId: string,
): Promise<number> {
  const safeRepo = sanitiseRepoName(repo);
  const stateFile = `${stateDir}/${safeRepo}_${checkId}.retries`;

  let currentCount = 0;
  try {
    const content = await Deno.readTextFile(stateFile);
    currentCount = parseInt(content.trim(), 10) || 0;
  } catch {
    // File doesn't exist yet — this is the first attempt.
  }

  const newCount = currentCount + 1;
  // Issues #552 and #580 found this from opposite ends and the resolution
  // keeps both halves. The write threw EROFS on every pass once the checkout
  // went read-only, and because it threw, the whole CI-fix lane died with it:
  // the fleet stopped repairing red checks entirely and escalated those PRs
  // to humans instead. So it fails OPEN — losing the counter degrades the
  // retry bound, it does not abandon a repair the fleet can still make — and
  // it fails LOUD, naming the directory and the repo/check it was counting,
  // because the bare "Read-only file system … '.ci_check_state/…'" said
  // nothing about which directory the worker meant or why the lane went
  // quiet.
  try {
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(stateFile, String(newCount));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[ci-check] could not record the CI check retry for ${repo} check ` +
        `${checkId} in '${stateDir}': ${msg}. The CI-fix lane needs a ` +
        `writable state directory inside the work directory; the retry bound ` +
        `is not enforced for this check (Issues #552, #580).`,
    );
  }
  return newCount;
}

/**
 * Get the current retry count for a CI check (Issue #563).
 *
 * @param stateDir - Directory for retry state files
 * @param repo - Repository in "owner/name" format
 * @param checkId - The GitHub check run ID
 * @returns The retry count (0 if no retries recorded)
 */
export async function getCiCheckRetryCount(
  stateDir: string,
  repo: string,
  checkId: string,
): Promise<number> {
  const safeRepo = sanitiseRepoName(repo);
  const stateFile = `${stateDir}/${safeRepo}_${checkId}.retries`;

  try {
    const content = await Deno.readTextFile(stateFile);
    return parseInt(content.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Build the comment body for max-retries notification (Issue #563).
 *
 * @param checkName - Name of the failed CI check
 * @param checkId - The GitHub check run ID
 * @param maxRetries - Maximum retry count
 * @returns Comment body markdown
 */
export function buildMaxRetriesComment(
  checkName: string,
  checkId: string,
  maxRetries: number,
): string {
  return `**Automated CI fix failed** — The worker attempted to fix the failing CI check **${checkName}** (ID: ${checkId}) ${maxRetries} times but was unable to resolve the issue.

Manual intervention is required to fix this CI failure. The worker will skip this check on future runs.

_Posted by auto-issue-worker (Issue #563)_`;
}

/**
 * Post a max-retries comment on a PR (Issue #563).
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param checkName - Name of the failed CI check
 * @param checkId - The GitHub check run ID
 * @param maxRetries - Maximum retry count
 * @param ghCommandFn - Function to run gh commands
 * @returns Result indicating success or failure
 */
export async function postCiFixMaxRetriesComment(
  repo: string,
  prNumber: number,
  checkName: string,
  checkId: string,
  maxRetries: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Result<void, Error>> {
  const body = buildMaxRetriesComment(checkName, checkId, maxRetries);

  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to post max-retries comment: ${msg}`),
    };
  }
}

/**
 * Check whether a check name matches spelling-related patterns.
 *
 * @param checkName - The check name to test
 * @returns true if the check is a spelling check
 */
export function isSpellingCheck(checkName: string): boolean {
  return /spell|cspell|typo|codespell/i.test(checkName);
}

/**
 * Encode a string as base64.
 *
 * @param input - String to encode
 * @returns Base64-encoded string
 */
export function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Format a failed check as a pipe-delimited string (for shell integration).
 *
 * @param check - The failed check information
 * @returns Pipe-delimited string
 */
export function formatFailedCheck(check: FailedCiCheck): string {
  return `${check.repo}|${check.prNumber}|${check.branchName}|${check.checkId}|${check.checkName}|${check.encodedAnnotations}`;
}
