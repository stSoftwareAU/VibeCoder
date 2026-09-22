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
import { PRIMARY_QUOTA_SKIP_PREFIX } from "./primary_quota_latch.ts";
import { directMergePr } from "./direct_merge.ts";
import {
  decideMilestoneBaseMerge,
  decideSummaryPrMerge,
  invalidateMilestoneBehindMemoForBranch,
  isMilestoneBranch,
  postOpenChildrenBlockComment,
  renderBlockWarning,
  retargetOrphanBoundPr,
  type SummaryPrMergeDecision,
} from "./milestone_children_gate.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";
import {
  forkSyncDowngradeWarning,
  isMergeCommitNotAllowed,
  isMilestoneSyncBranch,
  mergeMethodFlagForHead,
  squashedSyncWarning,
} from "./milestone_sync_pr.ts";
import {
  closeRetargetedSyncPr,
  isRetargetedSyncPr,
} from "./milestone_sync_pr_retirement.ts";
import { scrubUntrustedText } from "./prompt_delimiter.ts";
import { redactSecrets } from "./secret_redaction.ts";

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
   * The PR is a draft, so GitHub refuses to arm auto-merge on it
   * (Issue #1800). Not a failure: the author asked for eyes. The sweep
   * skips drafts before arming; this is the result when the arming call
   * itself meets one (at creation, or from a listing that predates the
   * `isDraft` field).
   */
  Draft = "draft",
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
  /**
   * The PR's head is a `sync/milestone-*` branch and its base is the
   * **default** branch, so GitHub retargeted it there when its milestone
   * branch was deleted (Issue #1967). A sync PR merges the default branch
   * *into* a milestone branch; against the default branch its diff reverts
   * the milestone's work. It was closed, never merged.
   */
  ClosedRetargetedSync = "closed_retargeted_sync",
  /**
   * The PR was armed and behind, so the sweep asked GitHub to update its
   * branch through the `update-branch` REST endpoint instead of re-arming
   * (Issue #2462). The merge attempt itself is next sweep's business.
   */
  BranchUpdateRequested = "branch_update_requested",
}

/**
 * Outcomes that mean the worker did what it set out to do. Everything else
 * is a refusal or a failure and is logged at warning level (Issue #470).
 */
const SUCCESSFUL_OUTCOMES: ReadonlySet<AutoMergeResult> = new Set([
  AutoMergeResult.Enabled,
  AutoMergeResult.MergedDirectly,
  AutoMergeResult.BranchUpdateRequested,
  AutoMergeResult.Skipped,
  // Issue #1800: a draft is the author's choice, not a fault of the worker's
  // — logged at info so a long-lived draft is not a warning per cycle.
  AutoMergeResult.Draft,
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
  /**
   * Fleet identity inputs for the milestone-gate marker author checks
   * (Issue #1249, finding 3). Omitted reads the configured fleet, which is
   * what every production caller does.
   */
  authorOptions?: AlertDedupAuthorOptions;
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
  /**
   * When the milestone base is behind the default branch, attempt one
   * in-cycle sync and re-ask the gate if it lands (Issue #2005). Absent — or
   * when the sync conflicts — the child is armed anyway (Issue #2460); only
   * the sync-reason comment is skipped when no hook was supplied.
   */
  syncBehindMilestone?: (info: {
    milestoneBranch: string;
    behindBy: number;
  }) => Promise<{
    status: "level" | "synced" | "deferred";
    detail: string;
  }>;
}

/** Marker on a PR comment that an in-cycle sync could not clear "behind". */
export const MILESTONE_BEHIND_SYNC_MARKER =
  "<!-- vibe-milestone-behind-sync -->";

/** PRs already told about a failed in-cycle sync this cycle. */
const postedBehindSyncReason = new Set<string>();

/** Drop the per-PR behind-sync comment registry. Tests and cycle start. */
export function resetBehindSyncComments(): void {
  postedBehindSyncReason.clear();
}

/** Marker on the creation-arming reason comment (Issue #2457). */
const ARMING_REASON_MARKER = "<!-- vibe-auto-merge-not-armed -->";

async function postBehindSyncReason(
  repo: string,
  prNumber: number,
  milestoneBranch: string,
  detail: string,
  commentFn: (repo: string, prNumber: number, body: string) => Promise<void>,
  log: (message: string) => void,
): Promise<void> {
  const key = `${repo}#${prNumber}`;
  if (postedBehindSyncReason.has(key)) return;
  postedBehindSyncReason.add(key);
  const body = [
    MILESTONE_BEHIND_SYNC_MARKER,
    `The milestone branch \`${milestoneBranch}\` is still behind the ` +
    `default branch after an in-cycle sync: ${detail}`,
    "",
    "Auto-merge is armed anyway (Issue #2460) — the milestone ruleset holds " +
    "the merge until the branch is level. The periodic milestone sync will " +
    "retry; a conflicting sync is never side-picked (Issue #2005).",
  ].join("\n");
  try {
    await commentFn(repo, prNumber, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: could not post the in-cycle sync deferral on ${repo}#${prNumber}: ${message}`,
    );
  }
}

/**
 * Whether a creation-arming outcome warrants a warn log and a single reason
 * comment on the PR (Issue #2457).
 *
 * A genuine refusal to arm needs the comment: `Failed`, `NotAllowed`, and a
 * `Deferred` that nothing else has already explained. Everything else is
 * either the worker doing what it set out to do (`Enabled`, `Skipped`,
 * `MergedDirectly`) or already explained on the PR by the path that produced
 * it — `Draft` (author's choice), `NotEnabledOnRepo` (its own note),
 * `BlockedOpenChildren` (#3909), a `milestone-behind` outcome (the #2005
 * `postBehindSyncReason` already explains it on the PR), and the #4375/#1082
 * gated direct-merge hold (the deliberate "never `--auto`" path).
 */
export function autoMergeOutcomeNeedsComment(
  outcome: EnableAutoMergeResult,
): boolean {
  if (outcome.result === AutoMergeResult.Failed) return true;
  if (outcome.result === AutoMergeResult.NotAllowed) return true;
  if (outcome.result !== AutoMergeResult.Deferred) return false;
  // A deferral needs the comment unless the path that produced it already
  // holds deliberately: the #4375 gated direct merge, or a milestone-behind
  // outcome, whose reason #2005 has already posted.
  if (outcome.directMergeDeferred) return false;
  if (outcome.deferral === "milestone-behind") return false;
  return true;
}

/**
 * Build the comment body explaining why auto-merge was not armed at creation
 * (Issue #2457).
 *
 * The comment always says the Auto-Merge sweep retries, because it does: the
 * periodic sweep re-reads the PR every cycle and arms it the moment the
 * obstruction clears. A latched refusal names the latch's reset time instead,
 * because in-run retries are futile — every further `gh` call in the window
 * fails the same way.
 */
export function buildArmingReasonComment(
  outcome: EnableAutoMergeResult,
): string {
  const retryLine = outcome.latched
    ? `The primary GitHub quota is exhausted, so no further auto-merge attempt ` +
      `was made in this run; the Auto-Merge sweep retries once the quota resets.`
    : `The Auto-Merge sweep retries.`;
  return [
    ARMING_REASON_MARKER,
    `Auto-merge was not armed on this PR: ${outcome.message}`,
    "",
    retryLine,
  ].join("\n");
}

/**
 * Marker on the comment explaining that a milestone summary PR was left
 * unarmed because its open-children count could not be read (Issue #2479).
 */
export const OPEN_CHILDREN_LOOKUP_MARKER =
  "<!-- vibe-open-children-lookup-failed -->";

/**
 * PRs already told their open-children count could not be read.
 *
 * Deliberately NOT cleared by `resetIterationCaches` the way
 * `postedBehindSyncReason` is: a lookup that stays broken is re-swept every
 * cycle, and the PR is owed one explanation, not one per cycle (Issue #2479).
 */
const postedOpenChildrenLookupReason = new Set<string>();

/** Drop the per-PR unreadable-count comment registry. Tests only. */
export function resetOpenChildrenLookupComments(): void {
  postedOpenChildrenLookupReason.clear();
}

/**
 * Tell a PR its open-children count could not be read, at most once.
 *
 * The key is recorded only after a successful post, so a post that failed is
 * retried on the next sweep rather than latched as "explained".
 *
 * @returns true when the PR carries the explanation, false when the post failed
 */
async function postOpenChildrenLookupReason(
  repo: string,
  prNumber: number,
  milestoneNumber: number,
  milestoneTitle: string,
  detail: string,
  commentFn: (repo: string, prNumber: number, body: string) => Promise<void>,
  log: (message: string) => void,
): Promise<boolean> {
  const key = `${repo}#${prNumber}`;
  if (postedOpenChildrenLookupReason.has(key)) return true;
  // The title is attacker-writable and the detail is raw API text: redact any
  // secret the transport error carried, then neutralise marker-shaped content
  // so neither can forge a fleet marker in this body (Issues #1249, #2479).
  const safeTitle = scrubUntrustedText(milestoneTitle);
  const safeDetail = scrubUntrustedText(redactSecrets(detail));
  const body = [
    OPEN_CHILDREN_LOOKUP_MARKER,
    `Auto-merge is not armed: the open-children count for milestone ` +
    `#${milestoneNumber} '${safeTitle}' could not be read — ${safeDetail}`,
    "",
    "Merging a summary PR over unread children could close a milestone that " +
    "still has open work, so the gate refuses (Issue #3909). The Auto-Merge " +
    "sweep retries every cycle and arms the PR once the count reads.",
  ].join("\n");
  try {
    await commentFn(repo, prNumber, body);
    postedOpenChildrenLookupReason.add(key);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: could not post the unreadable open-children count on ${repo}#${prNumber}: ${message}`,
    );
    return false;
  }
}

/** Result of enabling auto-merge. */
export interface EnableAutoMergeResult {
  /** Outcome of the attempt */
  result: AutoMergeResult;
  /** Human-readable message */
  message: string;
  /**
   * Why the outcome was held back, when the caller must treat it as a
   * deliberate hold rather than a merge error (Issue #1779).
   *
   * `milestone-behind` is now a log marker, not a hold: the base was behind
   * the default branch when the PR was armed (Issue #2460). An in-cycle sync
   * is offered first (Issue #2005) and a conflicting one posts its reason on
   * the PR, but the child is armed either way — the milestone ruleset's
   * strict up-to-date policy holds the merge itself until the branch levels.
   *
   * `sync-base-unreadable` is the same kind of hold (Issue #1967): a
   * sync-shaped head whose base could not be compared with the default
   * branch is neither armed nor escalated — it is re-read next scan.
   */
  deferral?: "milestone-behind" | "sync-base-unreadable";
  /**
   * Whether a `deferred` outcome is the deliberate #4375/#1082 gated
   * direct-merge hold: an unprotected base has no required checks, so the
   * worker held the PR instead of ever calling `--auto`. This is a chosen
   * hold, not a refusal, so it needs no arming-reason comment (Issue #2457).
   */
  directMergeDeferred?: boolean;
  /**
   * Whether the `gh pr merge --auto` refusal was the primary-quota latch
   * short-circuiting the call, rather than GitHub answering (Issue #2457).
   * A latched refusal is deliberately not retried in-run — every further
   * `gh` call in the window fails the same way, so the Auto-Merge sweep
   * retries after the reset the comment names.
   */
  latched?: boolean;
  /**
   * Whether a comment explaining this block is on the PR — set on both
   * `blocked_open_children` reasons (Issue #2479). `false` means the block was
   * announced nowhere but the log, so a caller that comments on unarmed PRs
   * must speak for it rather than assume the gate already did.
   */
  blockCommented?: boolean;
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

  // Issue #1800: "GraphQL: Pull Request is still a draft (mergePullRequest)"
  // — the PR's author has not marked it ready. Not a failure to retry.
  if (lower.includes("still a draft") || lower.includes("is a draft")) {
    return AutoMergeResult.Draft;
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
 * Whether the PR's head branch lives in **this** repository (Issue #1249,
 * finding 10).
 *
 * Only a same-repository head is evidence about who created the branch —
 * pushing it needed write access here — so only it may select the
 * merge-commit deviation. An unreadable answer is `false`: the deviation is
 * refused rather than granted on a field that could not be read.
 */
async function fetchHeadIsSameRepository(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  try {
    const raw = (await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "isCrossRepository",
      "--jq",
      ".isCrossRepository",
    ])).trim();
    return raw === "false";
  } catch {
    return false;
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
 * Recognise GitHub refusing a merge because a rule governs the base
 * (Issue #1763).
 *
 * `stSoftwareAU/GRQ-FX#58` is the shape: the effective-rules endpoint
 * returned `[]` for `Develop` and legacy protection was 404, so the base was
 * judged unprotected and the gated direct merge attempted — and GitHub
 * refused it with "the base branch policy prohibits the merge", the wording
 * of a rules refusal. An organisation-level ruleset needs `admin:org` to
 * list, so the fleet token cannot see every policy that binds a branch; the
 * refusal itself is the authority.
 *
 * @param message - Error message from the failed direct merge.
 * @returns True when the base is policy-protected whatever the rules
 *   endpoint showed.
 */
export function isBasePolicyRefusal(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("base branch policy prohibits the merge") ||
    lower.includes("repository rule violations") ||
    /\bgh013\b/.test(lower);
}

/**
 * Message logged once per base per cycle when GitHub enforced a policy the
 * rules endpoint did not show (Issue #1763). Exported so tests and log greps
 * share the wording.
 */
export function invisiblePolicyWarning(
  repo: string,
  baseRefName: string,
  refusal: string,
): string {
  return `WARNING: ${repo} '${baseRefName}' is policy-protected but the ` +
    `effective-rules endpoint shows no rule the fleet token can read — ` +
    `an organisation ruleset (needs admin:org to list) or a repository ` +
    `setting; arming GitHub auto-merge instead of retrying the direct ` +
    `merge (Issue #1763): ${refusal}`;
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
      commentFn,
      log,
      options.authorOptions,
    );
  }

  // Issue #4396: the mirror image — never merge INTO a milestone branch
  // whose route to the default branch has closed (rollup PR merged, or
  // milestone closed). Seven fixes were lost that way with their issues
  // reading COMPLETED. Refuse loud and retarget the PR at the default branch.
  // Issue #1779: `requireSyncedBase` adds the second half — it reports a
  // milestone tip that is behind the default branch, which drives the
  // in-cycle sync below. Issue #2460: being behind no longer withholds
  // arming, because the milestone ruleset's strict up-to-date policy blocks
  // the merge itself; withholding `--auto` only left the child unarmed. The
  // compare is memoised per milestone, so the N children of one milestone in
  // a sweep cost one call, and a non-milestone base costs none.
  let routeGate = await (options.decideMilestoneBaseFn ??
    decideMilestoneBaseMerge)({
      repo,
      prNumber,
      baseRefName: options.baseRefName,
      // Issue #1779: lets the synced-base check exempt the milestone sync
      // PR — the one PR whose whole job is to clear "behind".
      // Issue #2460: kept `true` so a behind tip is still reported; the
      // report is now a log marker and a sync trigger, not a withhold.
      ...(options.headRefName ? { headRefName: options.headRefName } : {}),
      ghCommandFn,
      requireSyncedBase: true,
      ...(options.getDefaultBranchFn
        ? { getDefaultBranchFn: options.getDefaultBranchFn }
        : {}),
    });
  // Issue #477: an unreadable route is not a closed one. Leave the PR
  // untouched and look again next scan — a rate limit must never move a
  // healthy milestone child onto the review-gated default branch.
  //
  // Issue #2005: when the base is behind and the caller supplies a sync
  // hook, one in-cycle attempt runs first; a clean landing re-asks the gate.
  // A conflicting sync posts its reason on the PR and the child is armed
  // anyway (Issue #2460) — GitHub holds the merge until the branch is level,
  // and the periodic sync clears it without any child being side-picked.
  if (
    routeGate.decision === "defer" &&
    routeGate.reason === "milestone-behind" &&
    options.syncBehindMilestone
  ) {
    let sync: { status: "level" | "synced" | "deferred"; detail: string };
    try {
      sync = await options.syncBehindMilestone({
        milestoneBranch: routeGate.milestoneBranch,
        behindBy: routeGate.behindBy,
      });
    } catch (err) {
      const thrown = err instanceof Error ? err.message : String(err);
      log(
        `WARNING: in-cycle milestone sync threw for ${repo}#${prNumber}: ${thrown}`,
      );
      sync = { status: "deferred", detail: thrown };
    }
    if (sync.status === "level" || sync.status === "synced") {
      invalidateMilestoneBehindMemoForBranch(
        repo,
        routeGate.milestoneBranch,
      );
      routeGate = await (options.decideMilestoneBaseFn ??
        decideMilestoneBaseMerge)({
          repo,
          prNumber,
          baseRefName: options.baseRefName,
          ...(options.headRefName ? { headRefName: options.headRefName } : {}),
          ghCommandFn,
          requireSyncedBase: true,
          ...(options.getDefaultBranchFn
            ? { getDefaultBranchFn: options.getDefaultBranchFn }
            : {}),
        });
    } else {
      await postBehindSyncReason(
        repo,
        prNumber,
        routeGate.milestoneBranch,
        sync.detail,
        commentFn,
        log,
      );
    }
  }
  // Issue #2460: a behind base is recorded and carried onto the arming
  // outcome for logging, then the arming loop runs as usual.
  let behindDeferral: "milestone-behind" | undefined;
  if (
    routeGate.decision === "defer" && routeGate.reason === "milestone-behind"
  ) {
    log(
      `PR #${prNumber}: ${routeGate.milestoneBranch} is ${routeGate.behindBy} commit${
        routeGate.behindBy === 1 ? "" : "s"
      } behind the default branch — arming anyway (Issue #2460)`,
    );
    behindDeferral = "milestone-behind";
  } else if (routeGate.decision === "defer") {
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
        ...(options.authorOptions
          ? { authorOptions: options.authorOptions }
          : {}),
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

  const baseRefName = options.baseRefName ??
    (await fetchBaseRefName(repo, prNumber, ghCommandFn));

  // Issue #1967: a milestone sync PR merges the default branch *into* a
  // milestone branch, so one whose base IS the default branch has had its
  // base deleted and been retargeted here by GitHub — approval and
  // auto-merge arming carried over, and a diff that reverts the milestone's
  // own work. VibeCoder#1957 reached `main` that way. This is the arming
  // chokepoint every path goes through, so the refusal sits here: closed,
  // never merged, with the reason posted on the PR.
  // A sync PR still on a `milestone/**` base is in exactly the state it was
  // raised in, so it needs no lookup at all — which is also what keeps the
  // healthy path free of an extra API call.
  if (
    isMilestoneSyncBranch(options.headRefName) && baseRefName &&
    !isMilestoneBranch(baseRefName)
  ) {
    const resolved = await (options.getDefaultBranchFn ??
      ((r: string) => getRepoDefaultBranch(r, ghCommandFn)))(repo);
    if (!resolved.ok) {
      // "I could not read it" is never actioned, and here it must not be
      // armed either: the one PR that must never merge into the default
      // branch is the one whose base could not be compared with it.
      return {
        result: AutoMergeResult.Deferred,
        deferral: "sync-base-unreadable",
        message:
          `PR #${prNumber} has a milestone-sync head '${options.headRefName}' ` +
          `on base '${baseRefName}', and ${repo}'s default branch could not ` +
          `be read (${resolved.error.message}) — not armed, re-read next ` +
          `scan (Issue #1967)`,
      };
    }
    if (
      isRetargetedSyncPr(
        {
          number: prNumber,
          headRefName: options.headRefName,
          baseRefName,
        },
        resolved.value,
      )
    ) {
      // A fork chooses its own branch names, so a sync-shaped head that is
      // not in this repository is a claim, not evidence (Issue #1249) — it
      // is somebody's own PR and is never closed. It is not armed either:
      // the read also returns false when it *failed*, and arming the one PR
      // that must never merge into the default branch because a `pr view`
      // blipped is the opposite of what this guard is for.
      if (!await fetchHeadIsSameRepository(repo, prNumber, ghCommandFn)) {
        log(
          forkSyncDowngradeWarning(repo, prNumber, options.headRefName ?? ""),
        );
        return {
          result: AutoMergeResult.Deferred,
          deferral: "sync-base-unreadable",
          message:
            `PR #${prNumber} has a milestone-sync head '${options.headRefName}' ` +
            `on the default branch '${resolved.value}', but its head could ` +
            `not be confirmed to live in ${repo} — neither closed nor armed ` +
            `(Issue #1967)`,
        };
      }
      const closed = await closeRetargetedSyncPr({
        repo,
        prNumber,
        headRefName: options.headRefName ?? "",
        defaultBranch: resolved.value,
        ghCommandFn,
        log,
      });
      return {
        result: closed
          ? AutoMergeResult.ClosedRetargetedSync
          : AutoMergeResult.Failed,
        message: closed
          ? `PR #${prNumber} closed, never merged: a milestone sync PR ` +
            `retargeted onto '${resolved.value}' (Issue #1967)`
          : `PR #${prNumber} is a milestone sync PR retargeted onto ` +
            `'${resolved.value}' and could NOT be closed — its auto-merge ` +
            `was disarmed but it is still open (Issue #1967)`,
      };
    }
  }

  // Issue #4375: on a base with no required checks GitHub's `--auto` merges
  // IMMEDIATELY, whatever CI says — observed when milestone child PR #4363
  // merged 20 s after a force-push with `validate` still running. Such a
  // base gets the gated, SHA-pinned direct merge instead: green, current,
  // settled head, or deferred until the next scan.
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
        // Issue #1763: GitHub's own refusal outranks the rules endpoint. A
        // base it calls policy-prohibited IS protected — by a rule the
        // token cannot list — so record that for the cycle, say so once,
        // and take the path a protected base takes: arm GitHub auto-merge,
        // which honours whatever rules exist, instead of a refused direct
        // merge per cycle for as long as the PR stays open.
        if (isBasePolicyRefusal(merge.error.message)) {
          baseProtectionMemo.set(memoKey, true);
          log(invisiblePolicyWarning(repo, baseRefName, merge.error.message));
        } else {
          return {
            result: AutoMergeResult.Failed,
            message:
              `Gated direct merge of PR #${prNumber} onto unprotected '${baseRefName}' failed: ${merge.error.message}`,
          };
        }
      } else if (merge.value.merged) {
        return {
          result: AutoMergeResult.MergedDirectly,
          message:
            `PR #${prNumber} merged directly onto unprotected '${baseRefName}' after the pre-merge gate (Issue #4375)`,
        };
      } else if (merge.value.blocked === "default_branch_unapproved") {
        return {
          result: AutoMergeResult.Deferred,
          directMergeDeferred: true,
          message:
            `PR #${prNumber} held on default branch '${baseRefName}': no approving review from outside the fleet, and the base has no required checks to enforce one (Issue #1082)`,
        };
      } else {
        return {
          result: AutoMergeResult.Deferred,
          directMergeDeferred: true,
          message:
            `PR #${prNumber} not merged onto unprotected '${baseRefName}': ${
              merge.value.blocked ?? "gate deferred"
            } (Issue #4375)`,
        };
      }
    }
  }

  // A milestone sync must land as a merge commit, not a squash (Issue #1048):
  // squashed, the default branch never becomes an ancestor of the milestone
  // branch and its deletions return as conflicts. Everything else squashes.
  //
  // The deviation also needs the head to live in this repository, which is
  // only asked when the name looks like a sync — one extra read on the rare
  // path, none on the ordinary one (Issue #1249, finding 10). A sync-shaped
  // head that fails that check is downgraded *loudly*: a quietly squashed
  // sync is the defect #1048 exists to prevent.
  const syncShaped = isMilestoneSyncBranch(options.headRefName);
  const headIsSameRepository = syncShaped
    ? await fetchHeadIsSameRepository(repo, prNumber, ghCommandFn)
    : false;
  if (syncShaped && !headIsSameRepository) {
    log(
      forkSyncDowngradeWarning(repo, prNumber, options.headRefName ?? ""),
    );
  }
  let mergeMethod = mergeMethodFlagForHead(
    options.headRefName,
    headIsSameRepository,
  );

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
        // Issue #2460: kept for logging — the base was behind when armed.
        ...(behindDeferral ? { deferral: behindDeferral } : {}),
        message: `Auto ${
          mergeMethod === "--merge" ? "merge-commit" : "squash"
        } merge enabled on PR #${prNumber}`,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Issue #2457: a refusal that is really the primary-quota latch must
      // never be retried in-run — every further `gh` call in the window is
      // refused the same way before it even spawns. Surface it as a latched
      // failure so the caller names the reset and leaves the sweep to retry.
      if (errorMsg.includes(PRIMARY_QUOTA_SKIP_PREFIX)) {
        return {
          result: AutoMergeResult.Failed,
          latched: true,
          message:
            `Could not enable auto-merge on PR #${prNumber}: ${errorMsg}`,
        };
      }

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

      if (classification === AutoMergeResult.Draft) {
        return {
          result: AutoMergeResult.Draft,
          message:
            `Auto-merge not armed on PR #${prNumber}: it is a draft — GitHub ` +
            `arms nothing until it is marked ready for review (Issue #1800)`,
        };
      }

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
 * Always loud: the warning names the milestone, the summary PR and either the
 * blocking children or the lookup that failed. Both block reasons also explain
 * themselves on the PR exactly once — the open-children gate de-duplicates
 * against its own marker, the unreadable-count comment against its per-PR
 * registry — so a repeating scan cycle explains itself once and then stays
 * quiet (Issue #2479). `blockCommented` reports whether that explanation is
 * actually on the PR, so a caller that comments on unarmed PRs can speak for
 * the block rather than assume the gate already did. The PR is never closed —
 * a human may still choose to merge it by hand.
 */
async function refuseMilestoneMerge(
  repo: string,
  prNumber: number,
  gate: Extract<SummaryPrMergeDecision, { decision: "block" }>,
  ghCommandFn: (args: string[]) => Promise<string>,
  commentFn: (
    repo: string,
    prNumber: number,
    body: string,
  ) => Promise<void>,
  log: (message: string) => void,
  authorOptions?: AlertDedupAuthorOptions,
): Promise<EnableAutoMergeResult> {
  if (gate.reason === "lookup-failed") {
    const message =
      `WARNING: refusing to auto-merge milestone summary PR ${repo}#${prNumber} ` +
      `for milestone #${gate.milestoneNumber} '${gate.milestoneTitle}' — its ` +
      `open-children count could not be read: ${gate.message} (Issue #3909)`;
    log(message);
    const blockCommented = await postOpenChildrenLookupReason(
      repo,
      prNumber,
      gate.milestoneNumber,
      gate.milestoneTitle,
      gate.message,
      commentFn,
      log,
    );
    return {
      result: AutoMergeResult.BlockedOpenChildren,
      message,
      blockCommented,
    };
  }

  const warning = renderBlockWarning(
    repo,
    prNumber,
    gate.milestoneNumber,
    gate.milestoneTitle,
    gate.children,
  );
  log(warning);
  const outcome = await postOpenChildrenBlockComment({
    repo,
    prNumber,
    milestoneTitle: gate.milestoneTitle,
    children: gate.children,
    ghCommandFn,
    log,
    ...(authorOptions ? { authorOptions } : {}),
  });
  return {
    result: AutoMergeResult.BlockedOpenChildren,
    message: warning,
    blockCommented: outcome !== "unconfirmed",
  };
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
): Promise<Result<EnableAutoMergeResult, Error>> {
  const result = await enableAutoMerge(options);

  if (result.result === AutoMergeResult.NotAllowed && directMergeFn) {
    try {
      await directMergeFn(options.repo, options.prNumber);
      return {
        ok: true,
        value: {
          result: AutoMergeResult.MergedDirectly,
          message: `Direct merge attempted for PR #${options.prNumber}`,
        },
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: true,
        value: {
          result: AutoMergeResult.Failed,
          message: `Auto-merge not available, direct merge also failed: ${msg}`,
        },
      };
    }
  }

  return { ok: true, value: result };
}
