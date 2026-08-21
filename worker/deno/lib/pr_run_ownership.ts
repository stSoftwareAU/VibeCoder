/**
 * Which PR belongs to *this* run? (Issue #174)
 *
 * The completion phase used to accept any PR whose title referenced the issue
 * as "the PR already exists". In a fleet, humans and sibling hosts routinely
 * land partial PRs against an issue that is still being worked, so that test
 * cannot tell *the PR for this branch* from *some PR for this issue*. On
 * VibeCoder#42 it matched a human's partial PR that had merged mid-run: the
 * worker recovered into it, closed the issue on the strength of that merge,
 * and stranded its own three commits on a branch with no PR.
 *
 * A PR stands in for this run's PR only when it is **OPEN** and its **head is
 * the branch this run pushed**. Merged, closed, or open-on-another-branch is a
 * sibling's work, and this run still owes the fleet a PR for its own branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";

type GhCommandFn = (args: string[]) => Promise<string>;

/** The fields that decide whether a PR belongs to this run. */
export interface PrIdentity {
  /** PR number. */
  number: number;
  /** `gh pr view --json state` — OPEN, CLOSED, or MERGED. */
  state: string;
  /** The PR's head branch. */
  headRefName: string;
}

/** Extract the PR number from a PR URL; 0 when the URL is not a PR URL. */
export function parsePrNumberFromUrl(prUrl: string): number {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

/**
 * Is `pr` the PR this run owns — open, on this run's branch?
 *
 * An identity that could not be read (`null`) is never treated as owned: the
 * worker raises its own PR rather than acting on a guess.
 */
export function isOwnRunPr(
  pr: PrIdentity | null,
  branchName: string,
): boolean {
  if (!pr || !branchName) return false;
  return pr.state === "OPEN" && pr.headRefName === branchName;
}

/**
 * Read a PR's state and head branch.
 *
 * @returns the identity, or null when it cannot be determined (logged).
 */
export async function lookupPrIdentity(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
  logger?: Logger,
): Promise<PrIdentity | null> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  try {
    const output = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state,headRefName",
    ]);
    const parsed = JSON.parse(output) as {
      state?: unknown;
      headRefName?: unknown;
    };
    return {
      number: prNumber,
      state: typeof parsed.state === "string" ? parsed.state : "",
      headRefName: typeof parsed.headRefName === "string"
        ? parsed.headRefName
        : "",
    };
  } catch (err) {
    logger?.warn("PR identity lookup errored (non-fatal)", {
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
