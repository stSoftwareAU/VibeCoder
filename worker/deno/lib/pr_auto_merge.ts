/**
 * PR auto-merge management for the Vibe Coder worker (Issue #915).
 *
 * Handles enabling auto-merge on PRs, with retry logic for transient
 * failures and fallback to direct-merge for unprotected branches.
 *
 * Replaces the auto-merge functions from worker/shared/pr_manager.sh.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import { runGhOrThrow } from "./gh_spawn.ts";
import { directMergePr } from "./direct_merge.ts";
import {
  decideMilestoneBaseMerge,
  decideSummaryPrMerge,
  postOpenChildrenBlockComment,
  renderBlockWarning,
  retargetOrphanBoundPr,
  type SummaryPrMergeDecision,
} from "./milestone_children_gate.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";
import {
  isMergeCommitNotAllowed,
  mergeMethodFlagForHead,
  squashedSyncWarning,
} from "./milestone_sync_pr.ts";

/** Auto-merge enablement result codes. */
export enum AutoMergeResult {
  /** Auto-merge enabled successfully */
  Enabled = "enabled",
  /** Auto-merge not enabled on the repository (not an error) */
  NotEnabledOnRepo = "not_enabled_on_repo",
  /** Auto-merge not allowed for this PR (branch not protected) — needs fallback */
  NotAllowed = "not_allowed",
  /** Failed after retries */
  Failed = "failed",
  /** Skipped because auto-merge is disabled in config */
  Skipped = "skipped",
  /**
   * Refused: this is a milestone summary PR and the milestone still has open
   * children (Issue #3909). Merging would delete the milestone branch and
   * auto-close those children's PRs, so the merge is not attempted. The PR is
   * left open for a human to merge deliberately if they choose.
   */
  BlockedOpenChildren = "blocked_open_children",
  /**
   * The base branch has no required checks, so GitHub's `--auto` would merge
   * immediately whatever CI says (Issue #4375). The PR was routed through the
   * gated, SHA-pinned direct merge instead and the gate deferred it — CI
   * pending/failed, no checks yet, behind, or a head pushed moments ago.
   */
  Deferred = "deferred",
  /**
   * The base branch has no required checks and the gated direct merge
   * landed the PR (Issue #4375).
   */
  MergedDirectly = "merged_directly",
  /**
   * The PR's base was a milestone branch whose rollup had already merged
   * (or whose milestone is closed), so merging there would have orphaned
   * the work (Issue #4396). The PR was retargeted at the default branch
   * instead and is picked up by the normal merge path next scan.
   */
  RetargetedToDefault = "retargeted_to_default",
}

/**
 * Outcomes that mean the worker did what it set out to do. Everything else
 * is a refusal or a failure and is logged at warning level (Issue #470).
 */
const SUCCESSFUL_OUTCOMES: ReadonlySet<AutoMergeResult> = new Set([
  AutoMergeResult.Enabled,
  AutoMergeResult.MergedDirectly,
  AutoMergeResult.Skipped,
]);

/**
 * Record what an auto-merge attempt actually did (Issue #470).
 *
 * The priority 1.65 sweep used to discard {@link EnableAutoMergeResult}
 * entirely. When an inverted ahead/behind comparison made the pre-merge
 * gate refuse *every* PR in the fleet with `behind_target`, the only trace
 * was the priority's name and a duration: milestone children stopped
 * merging, their issues stopped closing, no milestone ever completed, and
 * the log said nothing at all. A gate is allowed to refuse a merge; it is
 * not allowed to refuse silently.
 *
 * @param logger - Sink for the line
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR the attempt was for
 * @param outcome - What {@link enableAutoMerge} returned
 */
export function logAutoMergeOutcome(
  logger: Pick<Logger, "info" | "warn">,
  repo: string,
  prNumber: number,
  outcome: EnableAutoMergeResult,
): void {
  const context = { repo, prNumber, result: outcome.result };
  const line = `Auto-merge ${outcome.result}: ${outcome.message}`;
  if (SUCCESSFUL_OUTCOMES.has(outcome.result)) {
    logger.info(line, context);
    return;
  }
  logger.warn(line, context);
}

/** Options for enabling auto-merge. */
export interface EnableAutoMergeOptions {
  /** Repository in "owner/repo" format */
  repo: string;
  /** PR number */
  prNumber: number;
  /** Milestone-base gate seam (Issue #4396) — tests inject. */
  decideMilestoneBaseFn?: typeof decideMilestoneBaseMerge;
  /** Default-branch lookup seam (Issue #4396) — tests inject. */
  getDefaultBranchFn?: (repo: string) => Promise<Result<string>>;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Seconds between retries (default: 5) */
  retryDelay?: number;
  /** Whether auto-merge is disabled for this repo */
  skipAutoMerge?: boolean;
  /** Function to run gh commands (injectable for testing) */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Function to post comments (injectable for testing) */
  commentFn?: (repo: string, prNumber: number, body: string) => Promise<void>;
  /**
   * Head branch of the PR, when the caller already knows it (Issue #3909).
   * Supplying it lets the milestone open-children gate skip its own lookup —
   * an ordinary fix PR then costs no extra `gh` call at all.
   */
  headRefName?: string;
  /** Logging function for the open-children gate. Defaults to `console.warn`. */
  log?: (message: string) => void;
  /**
   * Whether the PR's base branch enforces required checks (Issue #4375).
   * Defaults to a rules lookup (`repos/{repo}/rules/branches/{base}`);
   * injectable for tests. `null` = unknown, treated as unprotected (the
   * safe direction: the gated merge, never a blind `--auto`).
   */
  isBaseProtectedFn?: (
    repo: string,
    baseRefName: string,
    ghCommandFn: (args: string[]) => Promise<string>,
  ) => Promise<boolean | null>;
  /**
   * Gated, SHA-pinned direct merge used for an unprotected base
   * (Issue #4375). Defaults to {@link directMergePr}.
   */
  directMergeFn?: typeof directMergePr;
  /** Base branch, when the caller already knows it (saves a lookup). */
  baseRefName?: string;
  /**
   * Fleet logins, so the gated direct merge can tell a genuine review from a
   * sibling fleet account's approval (Issue #1082). Supplying them arms the
   * approved-default-branch path on an unprotected base — the only path that
   * can land such a PR at all. Omitted, the Issue #2416 refusal stands.
   */
  fleetAuthors?: readonly string[];
}

/** Result of enabling auto-merge. */
export interface EnableAutoMergeResult {
  /** Outcome of the attempt */
  result: AutoMergeResult;
  /** Human-readable message */
  message: string;
}

/**
 * Classify the output of a failed auto-merge attempt.
 *
 * @param output - The stderr/stdout from the gh command
 * @returns Classification of the failure
 */
export function classifyAutoMergeFailure(output: string): AutoMergeResult {
  const lower = output.toLowerCase();

  // "not allowed" / "not supported" without "not enabled" = branch not protected
  if (
    (lower.includes("not allowed") || lower.includes("not supported")) &&
    !lower.includes("is not enabled") &&
    !lower.includes("auto-merge is not enabled")
  ) {
    return AutoMergeResult.NotAllowed;
  }

  // Repository-level auto-merge not enabled — permanent, not an error
  if (
    lower.includes("is not enabled") ||
    lower.includes("auto-merge is not enabled")
  ) {
    return AutoMergeResult.NotEnabledOnRepo;
  }

  // Transient errors worth retrying
  if (
    /http [5]\d{2}|timed? ?out|timeout|connection refused|rate limit|http 429|unexpected disconnect|broken pipe/i
      .test(output)
  ) {
    return AutoMergeResult.Failed;
  }

  return AutoMergeResult.Failed;
}

/**
 * Check whether an error looks transient (worth retrying).
 *
 * @param output - Error output from the gh command
 * @returns true if the error looks transient
 */
export function isTransientError(output: string): boolean {
  return /http [5]\d{2}|timed? ?out|timeout|connection refused|rate limit|http 429|unexpected disconnect|broken pipe/i
    .test(output);
}

/** Base branch of a PR via `gh pr view`; empty string when unknown. */
async function fetchBaseRefName(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string> {
  try {
    return (await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "baseRefName",
      "--jq",
      ".baseRefName",
    ])).trim();
  } catch {
    return "";
  }
}

/**
 * Whether a branch enforces required status checks (Issue #4375), via the
 * effective-rules endpoint (covers rulesets and legacy protection). `null`
 * when the lookup fails — callers treat unknown as unprotected.
 */
export async function isBaseProtected(
  repo: string,
  baseRefName: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean | null> {
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/rules/branches/${encodeURIComponent(baseRefName)}`,
      "--jq",
      '[.[] | .type] | join(",")',
    ]);
    const types = raw.trim().split(",").filter((t) => t.length > 0);
    return types.includes("required_status_checks");
  } catch {
    return null;
  }
}

/** Per-process memo of base protection per repo/base (one cycle is enough). */
const baseProtectionMemo = new Map<string, boolean | null>();

/** Clear the base-protection memo (tests). */
export function _resetBaseProtectionMemo(): void {
  baseProtectionMemo.clear();
}

/**
 * Enable auto squash merge on a PR (Issue #63, #430, #927).
 *
 * Retries on transient failures (HTTP 5xx, network errors).
 *
 * @param options - Auto-merge options
 * @returns Result of the attempt
 */
export async function enableAutoMerge(
  options: EnableAutoMergeOptions,
): Promise<EnableAutoMergeResult> {
  const {
    repo,
    prNumber,
    maxRetries = 3,
    retryDelay = 5,
    skipAutoMerge = false,
  } = options;

  // Issue #3703: route the default runner through the shared `gh` chokepoint
  // so the PR merge is allowlist-checked and journalled.
  const ghCommandFn = options.ghCommandFn ??
    ((args: string[]): Promise<string> => runGhOrThrow(args));

  const commentFn = options.commentFn ??
    (async (r: string, pr: number, body: string): Promise<void> => {
      await ghCommandFn([
        "pr",
        "comment",
        String(pr),
        "--repo",
        r,
        "--body",
        body,
      ]);
    });

  if (skipAutoMerge) {
    return {
      result: AutoMergeResult.Skipped,
      message: `Auto-merge disabled for ${repo} (skip_auto_merge=true)`,
    };
  }

  // Issue #3909: the milestone summary PR is the irreversible step — merging
  // it deletes the milestone branch and GitHub auto-closes every PR based on
  // it. Re-read the milestone's open children here, immediately before the
  // merge, and refuse when any remain. Costs nothing for a non-milestone PR.
  const log = options.log ?? ((message: string) => console.warn(message));
  const gate = await decideSummaryPrMerge({
    repo,
    prNumber,
    headRefName: options.headRefName,
    ghCommandFn,
  });
  if (gate.decision === "block") {
    return await refuseMilestoneMerge(
      repo,
      prNumber,
      gate,
      ghCommandFn,
      log,
    );
  }

  // Issue #4396: the mirror image — never merge INTO a milestone branch
  // whose route to the default branch has closed (rollup PR merged, or
  // milestone closed). Seven fixes were lost that way with their issues
  // reading COMPLETED. Refuse loud and retarget the PR at the default branch.
  const routeGate = await (options.decideMilestoneBaseFn ??
    decideMilestoneBaseMerge)({
      repo,
      prNumber,
      baseRefName: options.baseRefName,
      ghCommandFn,
    });
  // Issue #477: an unreadable route is not a closed one. Leave the PR
  // untouched and look again next scan — a rate limit must never move a
  // healthy milestone child onto the review-gated default branch.
  if (routeGate.decision === "defer") {
    return {
      result: AutoMergeResult.Deferred,
      message:
        `PR #${prNumber} left on ${routeGate.milestoneBranch}: ${routeGate.detail} — retrying next scan (Issue #477)`,
    };
  }
  if (routeGate.decision === "block") {
    const defaultBranch = await (options.getDefaultBranchFn ??
      ((r: string) => getRepoDefaultBranch(r, ghCommandFn)))(repo);
    const target = defaultBranch.ok ? defaultBranch.value : "";
    const retargeted = target.length > 0 &&
      await retargetOrphanBoundPr({
        repo,
        prNumber,
        gate: routeGate,
        defaultBranch: target,
        ghCommandFn,
        log,
      });
    const message = retargeted
      ? `PR #${prNumber} retargeted from ${routeGate.milestoneBranch} to ${target}: ${routeGate.detail} (Issue #4396)`
      : `PR #${prNumber} not merged into ${routeGate.milestoneBranch}: ${routeGate.detail} — retarget ${
        target ? "failed" : "impossible (default branch unknown)"
      } (Issue #4396)`;
    return {
      result: retargeted
        ? AutoMergeResult.RetargetedToDefault
        : AutoMergeResult.Failed,
      message,
    };
  }

  // Issue #4375: on a base with no required checks GitHub's `--auto` merges
  // IMMEDIATELY, whatever CI says — observed when milestone child PR #4363
  // merged 20 s after a force-push with `validate` still running. Such a
  // base gets the gated, SHA-pinned direct merge instead: green, current,
  // settled head, or deferred until the next scan.
  const baseRefName = options.baseRefName ??
    (await fetchBaseRefName(repo, prNumber, ghCommandFn));
  if (baseRefName) {
    const memoKey = `${repo}#${baseRefName}`;
    let protectedBase = baseProtectionMemo.get(memoKey);
    if (protectedBase === undefined) {
      protectedBase = await (options.isBaseProtectedFn ?? isBaseProtected)(
        repo,
        baseRefName,
        ghCommandFn,
      );
      baseProtectionMemo.set(memoKey, protectedBase);
    }
    if (protectedBase !== true) {
      // Issue #1082: an unprotected base is the only place the default-branch
      // guard has no alternative path to offer, so hand the gated merge the
      // fleet logins and let a genuine outside approval stand in for the
      // branch protection that is not there.
      const merge = await (options.directMergeFn ?? directMergePr)(
        repo,
        prNumber,
        ghCommandFn,
        undefined,
        options.fleetAuthors && options.fleetAuthors.length > 0
          ? {
            approvedDefaultBranch: { fleetAuthors: options.fleetAuthors },
          }
          : {},
      );
      if (!merge.ok) {
        return {
          result: AutoMergeResult.Failed,
          message:
            `Gated direct merge of PR #${prNumber} onto unprotected '${baseRefName}' failed: ${merge.error.message}`,
        };
      }
      if (merge.value.merged) {
        return {
          result: AutoMergeResult.MergedDirectly,
          message:
            `PR #${prNumber} merged directly onto unprotected '${baseRefName}' after the pre-merge gate (Issue #4375)`,
        };
      }
      if (merge.value.blocked === "default_branch_unapproved") {
        return {
          result: AutoMergeResult.Deferred,
          message:
            `PR #${prNumber} held on default branch '${baseRefName}': no approving review from outside the fleet, and the base has no required checks to enforce one (Issue #1082)`,
        };
      }
      return {
        result: AutoMergeResult.Deferred,
        message:
          `PR #${prNumber} not merged onto unprotected '${baseRefName}': ${
            merge.value.blocked ?? "gate deferred"
          } (Issue #4375)`,
      };
    }
  }

  // A milestone sync must land as a merge commit, not a squash (Issue #1048):
  // squashed, the default branch never becomes an ancestor of the milestone
  // branch and its deletions return as conflicts. Everything else squashes.
  let mergeMethod = mergeMethodFlagForHead(options.headRefName);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await ghCommandFn([
        "pr",
        "merge",
        String(prNumber),
        "--repo",
        repo,
        "--auto",
        mergeMethod,
      ]);
      return {
        result: AutoMergeResult.Enabled,
        message: `Auto ${
          mergeMethod === "--merge" ? "merge-commit" : "squash"
        } merge enabled on PR #${prNumber}`,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // A repository that forbids merge commits cannot take the sync as one
      // (Issue #1048). Downgrade to the squash it can take — loudly, naming
      // the setting — rather than leaving the branch to drift unsynced. The
      // check-resurrected-files gate is what catches the consequence.
      if (mergeMethod === "--merge" && isMergeCommitNotAllowed(errorMsg)) {
        log(squashedSyncWarning(repo, options.headRefName ?? "", errorMsg));
        mergeMethod = "--squash";
        continue;
      }

      const classification = classifyAutoMergeFailure(errorMsg);

      if (classification === AutoMergeResult.NotAllowed) {
        return {
          result: AutoMergeResult.NotAllowed,
          message:
            `Auto-merge not allowed for PR #${prNumber} — target branch likely not protected (Issue #927)`,
        };
      }

      if (classification === AutoMergeResult.NotEnabledOnRepo) {
        try {
          await commentFn(
            repo,
            prNumber,
            "**Note:** Auto-merge is not enabled on this repository. This PR will need to be merged manually after review.",
          );
        } catch {
          // Comment failure is not fatal
        }
        return {
          result: AutoMergeResult.NotEnabledOnRepo,
          message:
            `Auto-merge is not enabled on this repository — PR #${prNumber} needs manual merge`,
        };
      }

      // Transient error — retry if attempts remain
      if (isTransientError(errorMsg) && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay * 1000));
        continue;
      }

      return {
        result: AutoMergeResult.Failed,
        message: `Could not enable auto-merge on PR #${prNumber} (attempt ${
          attempt + 1
        }/${maxRetries + 1}): ${errorMsg}`,
      };
    }
  }

  return {
    result: AutoMergeResult.Failed,
    message: `Could not enable auto-merge on PR #${prNumber} after ${
      maxRetries + 1
    } attempts`,
  };
}

/**
 * Refuse an auto-merge the milestone open-children gate blocked (Issue #3909).
 *
 * Always loud: the warning names the milestone, the summary PR and the
 * blocking children. On an open-children block the PR also gets exactly one
 * explanatory comment (the gate de-duplicates against its marker), so a
 * repeating scan cycle explains itself once and then stays quiet. The PR is
 * never closed — the milestone is genuinely unfinished and a human may still
 * choose to merge it by hand.
 */
async function refuseMilestoneMerge(
  repo: string,
  prNumber: number,
  gate: Extract<SummaryPrMergeDecision, { decision: "block" }>,
  ghCommandFn: (args: string[]) => Promise<string>,
  log: (message: string) => void,
): Promise<EnableAutoMergeResult> {
  if (gate.reason === "lookup-failed") {
    const message =
      `WARNING: refusing to auto-merge milestone summary PR ${repo}#${prNumber} ` +
      `for milestone #${gate.milestoneNumber} '${gate.milestoneTitle}' — its ` +
      `open-children count could not be read: ${gate.message} (Issue #3909)`;
    log(message);
    return { result: AutoMergeResult.BlockedOpenChildren, message };
  }

  const warning = renderBlockWarning(
    repo,
    prNumber,
    gate.milestoneNumber,
    gate.milestoneTitle,
    gate.children,
  );
  log(warning);
  await postOpenChildrenBlockComment({
    repo,
    prNumber,
    milestoneTitle: gate.milestoneTitle,
    children: gate.children,
    ghCommandFn,
    log,
  });
  return { result: AutoMergeResult.BlockedOpenChildren, message: warning };
}

/**
 * Finalise a PR by enabling auto-merge, with direct-merge fallback (Issue #480, #927).
 *
 * @param options - Auto-merge options
 * @param directMergeFn - Function to attempt direct merge as fallback
 * @returns Result with success status and message
 */
export async function finalisePr(
  options: EnableAutoMergeOptions,
  directMergeFn?: (repo: string, prNumber: number) => Promise<void>,
): Promise<Result<string, Error>> {
  const result = await enableAutoMerge(options);

  if (result.result === AutoMergeResult.NotAllowed && directMergeFn) {
    try {
      await directMergeFn(options.repo, options.prNumber);
      return {
        ok: true,
        value: `Direct merge attempted for PR #${options.prNumber}`,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: true,
        value: `Auto-merge not available, direct merge also failed: ${msg}`,
      };
    }
  }

  return { ok: true, value: result.message };
}
