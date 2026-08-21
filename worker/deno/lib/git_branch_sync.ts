/**
 * Align a local branch with the branch as it stands on the remote (Issue #211).
 *
 * The branch-update pass checks out whatever local branch of that name the
 * clone happens to hold and judges it against the base. When a fleet sibling
 * pushed while this host worked — or a previous run left commits behind — that
 * local branch is not the PR. Live, the pass merged a stale local branch,
 * found a conflict that the remote PR did not have, and labelled a mergeable
 * PR `merge-conflict` (NEAT-AI-core #557, #563).
 *
 * The verdict must therefore be established against the remote head:
 *   - fast-forward the local branch onto the remote head, or
 *   - refuse loudly when the local branch carries commits the remote does not,
 *     because no conflict verdict taken from it describes the PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { assertSafeGitRef, buildFetchArgs } from "./git_ref_args.ts";

/** git's wording when the remote simply has no such branch. */
const NO_REMOTE_REF_PATTERN = /couldn't find remote ref/i;

/** What aligning the local branch with the remote head did. */
export type RemoteHeadSyncAction =
  /** The local branch already pointed at the remote head. */
  | "already-current"
  /** The local branch was fast-forwarded onto the remote head. */
  | "fast-forwarded"
  /** The remote has no such branch, so there is nothing to align with. */
  | "remote-absent";

/** Outcome of {@link syncBranchToRemoteHead}. */
export interface RemoteHeadSync {
  action: RemoteHeadSyncAction;
  /** Human-readable detail for the log. */
  detail: string;
}

/** Error name for a local branch that is ahead of the remote head. */
export const LOCAL_AHEAD_OF_REMOTE_ERROR = "LocalAheadOfRemoteHead";

/**
 * Whether an error reports a local branch ahead of the remote head.
 *
 * Callers use this to keep the refusal out of conflict handling: a clone that
 * is out of step with the remote is not a PR that conflicts with its base.
 */
export function isLocalAheadOfRemoteError(err: unknown): boolean {
  return err instanceof Error && err.name === LOCAL_AHEAD_OF_REMOTE_ERROR;
}

/** Resolve HEAD, or null when it cannot be read. */
async function revParseHead(
  options: GitCommandOptions,
): Promise<string | null> {
  const result = await runGitCommand(["rev-parse", "HEAD"], options);
  if (!result.ok || result.value.code !== 0) return null;
  return result.value.stdout.trim() || null;
}

/** Build the ahead-of-remote refusal. */
function localAheadError(
  branchName: string,
  aheadCount: number,
): Error {
  const err = new Error(
    `Local branch '${branchName}' is ahead of the remote head by ` +
      `${aheadCount} commit(s) — refusing to judge it against its base ` +
      `(Issue #211): any verdict would describe this clone, not the PR. ` +
      `Push or discard the local commits first.`,
  );
  err.name = LOCAL_AHEAD_OF_REMOTE_ERROR;
  return err;
}

/**
 * Fast-forward the checked-out branch onto its remote head (Issue #211).
 *
 * @param branchName - The branch to align (must be the checked-out branch)
 * @param options - Git command options (cwd selects the clone)
 * @returns What the alignment did, or an error when the local branch carries
 *   commits the remote does not have, or the remote could not be consulted.
 */
export async function syncBranchToRemoteHead(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<RemoteHeadSync>> {
  try {
    assertSafeGitRef(branchName, "branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  const fetchResult = await runGitCommand(
    buildFetchArgs("origin", branchName),
    options,
  );
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    const detail = fetchResult.ok
      ? fetchResult.value.stderr.trim()
      : fetchResult.error.message;
    if (NO_REMOTE_REF_PATTERN.test(detail)) {
      return {
        ok: true,
        value: {
          action: "remote-absent",
          detail: `origin has no branch '${branchName}'`,
        },
      };
    }
    return {
      ok: false,
      error: new Error(
        `Failed to fetch origin/${branchName}: ${
          detail || "git reported no output"
        }`,
      ),
    };
  }

  // FETCH_HEAD is the remote's own answer, taken a moment ago — the only
  // trustworthy reference point for what the PR actually contains.
  const aheadResult = await runGitCommand(
    ["rev-list", "--count", "FETCH_HEAD..HEAD"],
    options,
  );
  if (!aheadResult.ok || aheadResult.value.code !== 0) {
    const detail = aheadResult.ok
      ? aheadResult.value.stderr.trim()
      : aheadResult.error.message;
    return {
      ok: false,
      error: new Error(
        `Failed to compare '${branchName}' with its remote head: ${
          detail || "git reported no output"
        }`,
      ),
    };
  }
  const aheadCount = parseInt(aheadResult.value.stdout.trim(), 10) || 0;
  if (aheadCount > 0) {
    return { ok: false, error: localAheadError(branchName, aheadCount) };
  }

  const beforeSha = await revParseHead(options);
  const mergeResult = await runGitCommand(
    ["merge", "--ff-only", "FETCH_HEAD"],
    options,
  );
  if (!mergeResult.ok || mergeResult.value.code !== 0) {
    const detail = mergeResult.ok
      ? mergeResult.value.stderr.trim()
      : mergeResult.error.message;
    return {
      ok: false,
      error: new Error(
        `Failed to fast-forward '${branchName}' onto its remote head: ${
          detail || "git reported no output"
        }`,
      ),
    };
  }

  const alreadyCurrent = beforeSha !== null &&
    beforeSha === await revParseHead(options);
  return {
    ok: true,
    value: {
      action: alreadyCurrent ? "already-current" : "fast-forwarded",
      detail: alreadyCurrent
        ? `'${branchName}' already matches its remote head`
        : `fast-forwarded '${branchName}' onto its remote head`,
    },
  };
}
