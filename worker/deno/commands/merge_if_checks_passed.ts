/**
 * merge-if-checks-passed command — direct-merge fallback for unprotected branches.
 *
 * Provides a merge strategy for PRs where GitHub's native auto-merge cannot
 * be enabled (e.g., milestone branches without branch protection rules).
 *
 * Issue #926
 */

import type { Command, CommandResult, Result, WorkerConfig } from "../types.ts";
import {
  directMergePr,
  type GhCommandFn,
  type MergeBlockedReason,
} from "../lib/direct_merge.ts";
import { assertNever } from "../lib/assert_never.ts";
import { isRepoAllowed } from "../lib/config_validator.ts";
import { runGhCommand } from "../lib/github.ts";

/** Output data for the merge-if-checks-passed command. */
export interface MergeIfChecksPassedData {
  merged: boolean;
  reason?: string;
}

/**
 * Validate and parse command arguments.
 *
 * @param args - Raw command arguments
 * @returns Result with parsed repo and pr number
 */
function validateArgs(
  args: Record<string, unknown>,
): Result<{ repo: string; pr: number }> {
  const repo = args.repo;
  if (typeof repo !== "string" || repo.length === 0) {
    return {
      ok: false,
      error: new Error("Missing required argument: --repo (owner/repo format)"),
    };
  }

  // Validate owner/repo format
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    return {
      ok: false,
      error: new Error(
        "Invalid --repo format: expected owner/repo (e.g., stSoftwareAU/VibeCoder)",
      ),
    };
  }

  const pr = args.pr;
  const prNumber = typeof pr === "number" ? pr : Number(pr);
  if (
    !Number.isFinite(prNumber) || prNumber <= 0 || !Number.isInteger(prNumber)
  ) {
    return {
      ok: false,
      error: new Error(
        "Missing or invalid --pr argument: expected a positive integer",
      ),
    };
  }

  return { ok: true, value: { repo, pr: prNumber } };
}

/**
 * Confirm this worker is permitted to direct-merge the PR (Issue #3705).
 *
 * Direct merge bypasses branch protection, so the command applies the same two
 * gates the maintenance scan applies (`pr_maintenance.ts`): the repository must
 * be on the monitored-repo allowlist, and the PR must be authored by this
 * worker (or a configured sibling fleet host). Every lookup failure fails
 * closed — an unconfirmable author is never treated as an authorised one.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - Pull request number
 * @param config - Worker configuration (allowlist + fleet authors)
 * @param ghCommandFn - gh command runner
 * @returns Ok when the merge is authorised, otherwise the refusal reason
 */
export async function authoriseDirectMerge(
  repo: string,
  prNumber: number,
  config: WorkerConfig,
  ghCommandFn: GhCommandFn,
): Promise<Result<void>> {
  if (!isRepoAllowed(config.repos ?? [], repo)) {
    return {
      ok: false,
      error: new Error(
        `Refusing to merge PR #${prNumber}: ${repo} is not on the monitored-repo allowlist (.config.json "repos") (Issue #3705)`,
      ),
    };
  }

  let workerLogin: string;
  try {
    workerLogin = (await ghCommandFn(["api", "user", "--jq", ".login"])).trim();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Refusing to merge PR #${prNumber} in ${repo}: could not resolve the worker's GitHub login (${message})`,
      ),
    };
  }
  if (!workerLogin) {
    return {
      ok: false,
      error: new Error(
        `Refusing to merge PR #${prNumber} in ${repo}: the worker's GitHub login is empty`,
      ),
    };
  }

  let prAuthor: string;
  try {
    prAuthor = (await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "author",
      "--jq",
      ".author.login",
    ])).trim();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Refusing to merge PR #${prNumber} in ${repo}: could not confirm its author (${message})`,
      ),
    };
  }

  const authorised = new Set(
    [workerLogin, ...(config.fleetPrAuthors ?? [])].filter((a) => a !== ""),
  );
  if (!prAuthor || !authorised.has(prAuthor)) {
    return {
      ok: false,
      error: new Error(
        `Refusing to merge PR #${prNumber} in ${repo}: it was not authored by this worker or a configured fleet host (Issue #3705)`,
      ),
    };
  }

  return { ok: true, value: undefined };
}

/** Injectable dependencies for the command (enables testing). */
export interface MergeIfChecksPassedDeps {
  /** gh command runner (defaults to runGhCommand). */
  ghCommandFn?: GhCommandFn;
  /** Direct-merge implementation (defaults to directMergePr). */
  directMergeFn?: typeof directMergePr;
}

/**
 * Read the explicit `--allow-no-checks` operator override (Issue #3705).
 *
 * Only a literal `true` (flag form) or the string `"true"` enables it, so a
 * stray value never silently unlocks merging an unverified PR.
 */
function parseAllowNoChecks(args: Record<string, unknown>): boolean {
  const raw = args["allow-no-checks"];
  return raw === true || raw === "true";
}

/**
 * Command body, with injectable dependencies for testing.
 *
 * @param args - Raw command arguments
 * @param config - Worker configuration
 * @param deps - Injectable dependencies
 * @returns Command result describing whether the PR merged
 */
export async function runMergeIfChecksPassed(
  args: Record<string, unknown>,
  config: WorkerConfig,
  deps: MergeIfChecksPassedDeps = {},
): Promise<CommandResult<MergeIfChecksPassedData>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const directMergeFn = deps.directMergeFn ?? directMergePr;

  const parsed = validateArgs(args);
  if (!parsed.ok) {
    return { success: false, message: parsed.error.message };
  }

  const { repo, pr } = parsed.value;

  // Authorisation gates (Issue #3705) — monitored repo and PR authorship.
  const authorised = await authoriseDirectMerge(repo, pr, config, ghCommandFn);
  if (!authorised.ok) {
    return { success: false, message: authorised.error.message };
  }

  // Direct-merge: the pre-merge backstop gate inside directMergePr re-checks
  // CI status and branch freshness (Issue #2582), so this command no longer
  // runs its own separate pre-check (de-duplicated).
  const mergeResult = await directMergeFn(repo, pr, ghCommandFn, undefined, {
    allowNoChecks: parseAllowNoChecks(args),
  });
  if (!mergeResult.ok) {
    return { success: false, message: mergeResult.error.message };
  }

  // Blocked by the gate — a typed deferral, not an error.
  if (!mergeResult.value.merged) {
    const data: MergeIfChecksPassedData = {
      merged: false,
      reason: blockedReason(mergeResult.value.blocked),
    };
    return { success: true, message: JSON.stringify(data), data };
  }

  const data: MergeIfChecksPassedData = { merged: true };
  return { success: true, message: JSON.stringify(data), data };
}

/**
 * merge-if-checks-passed command implementation.
 *
 * Checks CI status for a PR and merges it directly if all checks have passed.
 * Returns JSON output indicating the result.
 *
 * Gated on the monitored-repo allowlist and on PR authorship (Issue #3705).
 * Pass `--allow-no-checks` to override the fail-closed refusal of a PR whose
 * head commit has no check runs and no commit statuses.
 */
export const mergeIfChecksPassedCommand: Command = {
  name: "merge-if-checks-passed",
  description:
    "Merge a PR directly if all CI checks have passed (fallback for unprotected branches)",

  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<MergeIfChecksPassedData>> {
    return runMergeIfChecksPassed(args, config);
  },
};

/** Map the gate's blocked reason to the command's stable reason string. */
export function blockedReason(reason: MergeBlockedReason | undefined): string {
  // An absent reason defaults to "checks_pending" (the gate deferred without
  // naming a specific blocker).
  if (reason === undefined) {
    return "checks_pending";
  }
  switch (reason) {
    case "checks_failed":
      return "checks_failed";
    case "behind_target":
      return "behind_target";
    case "checks_pending":
      return "checks_pending";
    case "no_checks":
      return "no_checks";
    case "head_moved":
      return "head_moved";
    case "head_too_recent":
      return "head_too_recent";
    case "default_branch_unapproved":
      return "default_branch_unapproved";
    case "milestone_rollup_merged":
      return "milestone_rollup_merged";
    case "milestone_route_unreadable":
      return "milestone_route_unreadable";
    default:
      // Exhaustiveness guard: a new MergeBlockedReason must be handled here
      // explicitly rather than silently mapped to "checks_pending" (#2794).
      return assertNever(reason);
  }
}
