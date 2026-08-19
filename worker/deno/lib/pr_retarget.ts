/**
 * PR retargeting for the Vibe Coder worker (Issue #915).
 *
 * Handles re-targeting PRs to milestone branches when the PR was
 * initially created targeting the default branch.
 *
 * Replaces retarget_pr_to_milestone from worker/shared/pr_manager.sh.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhOrThrow } from "./gh_spawn.ts";

/** Default gh command function — routed through the shared chokepoint. */
async function defaultGhCommand(args: string[]): Promise<string> {
  return await runGhOrThrow(args);
}

/**
 * Re-target a PR to a milestone branch (Issue #449).
 *
 * When Claude Code creates a PR during its session, it targets the default
 * branch. This function re-targets the PR to the correct milestone branch.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - The PR number to retarget
 * @param milestoneBranch - The milestone branch to target
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function retargetPrToMilestone(
  repo: string,
  prNumber: number,
  milestoneBranch: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<Result<string, Error>> {
  if (!milestoneBranch) {
    return { ok: true, value: "No milestone branch — no-op" };
  }

  // Check current base branch
  let currentBase = "";
  try {
    const output = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "baseRefName",
      "--jq",
      ".baseRefName",
    ]);
    currentBase = output.trim();
  } catch {
    // Cannot determine current base
  }

  if (currentBase === milestoneBranch) {
    return {
      ok: true,
      value:
        `PR #${prNumber} already targets milestone branch '${milestoneBranch}'`,
    };
  }

  try {
    await ghCommandFn([
      "pr",
      "edit",
      String(prNumber),
      "--repo",
      repo,
      "--base",
      milestoneBranch,
    ]);
    return {
      ok: true,
      value:
        `PR #${prNumber} retargeted to milestone branch '${milestoneBranch}'`,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to retarget PR #${prNumber} to '${milestoneBranch}': ${msg}`,
      ),
    };
  }
}
