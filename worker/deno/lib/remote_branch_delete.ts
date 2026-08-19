/**
 * One chokepoint that decides whether a remote branch may be deleted
 * (Issue #3931).
 *
 * Deleting a remote branch is irreversible from the worker's point of view:
 * GitHub auto-closes every open PR that has the branch as its **base**. That
 * is exactly how `milestone/3872-…` destroyed PR #3928 — the branch was
 * removed at 04:12:05Z and GitHub closed the child PR in the same second.
 *
 * The pre-existing guard (Issue #386) only asked whether an open PR had the
 * branch as its **head**, so a branch that other PRs were stacked on read as
 * "safe to delete". Issue #3916 patched the milestone symptom by name; this
 * module closes the general case for every caller:
 *
 *   1. a protected branch (default line or `milestone/*`) is never deleted;
 *   2. a branch that is the head of an open PR is never deleted;
 *   3. a branch that is the **base** of an open PR is never deleted; and
 *   4. a branch whose state cannot be read is never deleted — an unreadable
 *      check is not permission (fail closed, Issue #3234).
 *
 * Callers must delete only on an explicit {@link BranchDeleteAssessment.safe}
 * verdict, and must surface the refusal reason rather than swallowing it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isProtectedBranch } from "./git_branch.ts";

/** Why a deletion was refused. */
export type BranchDeleteRefusal =
  /** Default-line or `milestone/*` branch — long-lived by design. */
  | "protected"
  /** An open PR still has this branch as its head. */
  | "open-head-pr"
  /** An open PR is based on this branch; deleting it would close that PR. */
  | "open-base-pr"
  /** The branch's state could not be read, so deletion is not authorised. */
  | "undecidable";

/** Verdict for a single candidate branch. */
export interface BranchDeleteAssessment {
  /** True only when every safety check positively confirmed the deletion. */
  safe: boolean;
  /** Set whenever `safe` is false. */
  refusal?: BranchDeleteRefusal;
  /** The open PR that blocks the deletion, when one does. */
  blockingPr?: number;
  /** Human-readable explanation — always populated, for logs and comments. */
  reason: string;
}

/** Injectable `gh` runner. Must reject (not return "") when `gh` fails. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** Which side of an open PR the branch sits on. */
type PrSide = "head" | "base";

/** `owner/repo`, the only shape the GitHub API calls below accept. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Number of the first open PR with `branchName` on the given side, or null
 * when there is none.
 *
 * Throws when `gh` fails or returns something that is not a PR number — the
 * caller turns that into a refusal rather than a deletion.
 */
async function firstOpenPrNumber(
  repo: string,
  branchName: string,
  side: PrSide,
  ghFn: GhCommandFn,
): Promise<number | null> {
  const raw = (await ghFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    `--${side}`,
    branchName,
    "--json",
    "number",
    "--jq",
    ".[0].number",
  ])).trim();

  // `gh --jq .[0].number` prints nothing for an empty result set.
  if (raw === "" || raw === "null") return null;

  const prNumber = Number(raw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(
      `expected a PR number from the open-PR query, got '${raw}'`,
    );
  }
  return prNumber;
}

/**
 * Decide whether `branchName` may be deleted from `repo`'s remote.
 *
 * Never throws: an unreadable branch state becomes an `undecidable` refusal
 * so a transient GitHub failure can never be mistaken for permission.
 *
 * @param repo - Repository in `owner/repo` form
 * @param branchName - The remote branch being considered for deletion
 * @param ghFn - Injected `gh` runner (must reject on failure)
 * @returns The verdict; delete only when `safe` is true
 */
export async function assessRemoteBranchDeletion(
  repo: string,
  branchName: string,
  ghFn: GhCommandFn,
): Promise<BranchDeleteAssessment> {
  if (!REPO_PATTERN.test(repo)) {
    return {
      safe: false,
      refusal: "undecidable",
      reason: `'${repo}' is not a valid owner/repo — refusing to delete ` +
        `'${branchName}'`,
    };
  }

  if (!branchName || branchName.startsWith("-")) {
    return {
      safe: false,
      refusal: "undecidable",
      reason: `'${branchName}' is not a usable branch name — refusing to ` +
        `delete it`,
    };
  }

  if (isProtectedBranch(branchName)) {
    return {
      safe: false,
      refusal: "protected",
      reason: `'${branchName}' is a protected branch (default line or ` +
        `milestone collection branch) — it is long-lived by design`,
    };
  }

  for (const side of ["head", "base"] as const) {
    let prNumber: number | null;
    try {
      prNumber = await firstOpenPrNumber(repo, branchName, side, ghFn);
    } catch (err) {
      return {
        safe: false,
        refusal: "undecidable",
        reason: `could not list open PRs with '${branchName}' as ${side} in ` +
          `${repo}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (prNumber !== null) {
      return {
        safe: false,
        refusal: side === "head" ? "open-head-pr" : "open-base-pr",
        blockingPr: prNumber,
        reason: side === "head"
          ? `open PR #${prNumber} still has '${branchName}' as its head`
          : `open PR #${prNumber} is based on '${branchName}' — deleting the ` +
            `branch would make GitHub close that PR`,
      };
    }
  }

  return {
    safe: true,
    reason: `no open PR in ${repo} uses '${branchName}' as head or base`,
  };
}

/** Shell-facing decision, as printed by the `branch-cleanup` command. */
export interface DeletionDecisionOutput {
  /** Command exit status — false makes the caller fail loud. */
  success: boolean;
  /** Single-line verdict the shell matches on. */
  message: string;
}

/**
 * Render an assessment as the single line the shell reads.
 *
 * Only the exact string `SAFE_TO_DELETE` authorises a deletion; every other
 * line — including the `undecidable` failure — must leave the branch alone.
 *
 * @param assessment - The verdict to render
 * @returns The shell-facing message and command status
 */
export function renderDeletionDecision(
  assessment: BranchDeleteAssessment,
): DeletionDecisionOutput {
  if (assessment.safe) {
    return { success: true, message: "SAFE_TO_DELETE" };
  }

  switch (assessment.refusal) {
    case "open-head-pr":
      // Retained wording (Issue #386) — existing callers match this prefix.
      return { success: true, message: `HAS_OPEN_PR:${assessment.blockingPr}` };
    case "open-base-pr":
      return {
        success: true,
        message: `HAS_OPEN_CHILD_PR:${assessment.blockingPr}`,
      };
    case "protected":
      return { success: true, message: "PROTECTED_BRANCH" };
    default:
      // Fail loud: the caller sees a non-zero exit and no permission.
      return { success: false, message: `UNDECIDABLE: ${assessment.reason}` };
  }
}
