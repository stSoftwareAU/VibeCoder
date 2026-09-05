/**
 * Loud handling of a worker fix PR that will not land (Issue #3584).
 *
 * The auto-fix loop is only hands-off if a green fix PR actually merges.
 * Before this module the worker's merge path swallowed every failure —
 * `catch { /* non-fatal *\/ }` — so a fix PR blocked by a protection rule,
 * a conflict or a stale base sat open in silence, which is precisely the
 * failure mode the epic exists to eliminate.
 *
 * This module turns a merge attempt's outcome into exactly one of four
 * dispositions, so the behaviour is deterministic rather than incidental:
 *
 * - `landed`        — merged, or native auto-merge is armed. Nothing to do.
 * - `await_checks`  — CI is pending or red. The PR is *not* green, so the
 *                     merge gate correctly refused; the CI-fix loop owns
 *                     it (and its own 3-attempt cap escalates — #3582).
 * - `update_branch` — the branch is behind its base, so its green CI no
 *                     longer reflects the merged state. Update the branch
 *                     and let the checks re-run rather than merging stale
 *                     or giving up.
 * - `escalate`      — the PR is green but will not merge. Post an
 *                     explanatory PR comment and apply `needs-human`.
 *
 * Only the worker's own PRs reach here: the auto-merge scan lists PRs by
 * the worker's login, so human-authored PRs are untouched.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger, Result } from "../types.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Injectable gh command runner. */
type GhFn = (args: string[]) => Promise<string>;

/** What happened when the worker tried to land a PR. */
export type MergeAttemptOutcome =
  /** Merged, or native auto-merge armed — the PR will land unattended. */
  | { kind: "landed" }
  /** Required checks have not finished. */
  | { kind: "checks_pending" }
  /** At least one required check failed. */
  | { kind: "checks_failed" }
  /** The branch is behind its base, so its CI result is stale. */
  | { kind: "behind_target" }
  /** The head commit has no checks at all, so nothing verified it (#3705). */
  | { kind: "no_checks" }
  /**
   * The PR head advanced between the check read and the SHA-pinned merge, so
   * GitHub refused the merge (#3946). A benign race, not a fault.
   */
  | { kind: "head_moved" }
  /**
   * The head commit was pushed moments ago and its checks may not exist yet
   * (Issue #4375). Deferred until it settles — a benign wait, not a fault.
   */
  | { kind: "head_too_recent" }
  /**
   * The PR's base is a milestone branch whose route to the default branch
   * has closed (Issue #4396). The auto-merge path retargets the PR at the
   * default branch and comments; a deferral until the next scan, not a
   * fault.
   */
  | { kind: "milestone_rollup_merged" }
  /**
   * The milestone's route to the default branch could not be *read*
   * (Issue #477) — a rate limit, a network blip. Nothing is known, so
   * nothing is done: the PR is left exactly as it is and re-read next
   * scan. Never a fault, and never grounds to escalate: escalating here
   * would hand a healthy PR to a human because GitHub was busy.
   */
  | { kind: "milestone_route_unreadable" }
  /**
   * The PR targets an unprotected default branch and carries no approving
   * review from outside the fleet (Issue #1082). A deliberate hold, not a
   * fault: the review may still arrive, and escalating would hand a healthy
   * PR to a human for doing exactly what the guard asked.
   */
  | { kind: "default_branch_unapproved" }
  /**
   * A milestone summary PR whose milestone still has open children (#3909).
   * Deliberately deferred, not a fault — the gate has already explained
   * itself on the PR, and the merge is retried once the children close.
   */
  | { kind: "milestone_children_open" }
  /** The PR is green but the merge itself was refused. */
  | { kind: "merge_error"; message: string };

/** The action the worker takes for a merge outcome. */
export type MergeDisposition =
  | "landed"
  | "await_checks"
  | "update_branch"
  | "escalate";

/** What {@link handleMergeAttempt} actually did. */
export interface MergeAttemptHandling {
  /** The disposition the outcome was classified as. */
  disposition: MergeDisposition;
  /** True when a branch update was successfully requested. */
  branchUpdateRequested: boolean;
  /** True when the PR was commented on and labelled `needs-human`. */
  escalated: boolean;
}

/** Options for {@link handleMergeAttempt}. */
export interface HandleMergeAttemptOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Outcome of the merge attempt. */
  outcome: MergeAttemptOutcome;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** gh command runner used for the comment/label/update-branch calls. */
  ghFn: GhFn;
  /** Label applied on escalation. Defaults to `needs-human`. */
  needsHumanLabel?: string;
  /** GitHub login used in the comment footer. */
  githubUser?: string;
  /** Injectable branch updater (defaults to {@link requestBranchUpdate}). */
  updateBranchFn?: (repo: string, prNumber: number) => Promise<Result<void>>;
  /** Injectable escalation helper (enables testing). */
  escalateFn?: typeof escalateToHuman;
}

/** Repo must be exactly `owner/repo` before it reaches an API path. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** What a human should do once a fix PR has been escalated. */
const MERGE_ESCALATION_NEXT_STEP =
  "Review this PR and either merge it manually or fix what is blocking the " +
  "merge (branch protection rule, merge conflict, or required approval). " +
  "The worker will not retry the merge while `needs-human` is applied.";

/**
 * Classify a merge outcome into the action the worker should take.
 *
 * Pure — no side effects — so the policy is testable on its own.
 *
 * @param outcome - Outcome of the merge attempt
 * @returns The disposition for that outcome
 */
export function classifyMergeAttempt(
  outcome: MergeAttemptOutcome,
): MergeDisposition {
  switch (outcome.kind) {
    case "landed":
      return "landed";
    case "checks_pending":
    case "checks_failed":
      // Not green — the merge gate is doing its job. The CI-fix loop owns
      // a red check, and it escalates on its own attempt cap (#3582).
      return "await_checks";
    case "milestone_children_open":
      // The milestone is genuinely unfinished (#3909). Wait for the children
      // rather than escalating a PR that is behaving correctly.
      return "await_checks";
    case "head_moved":
      // New commits landed on the head, so fresh checks are on their way.
      // Wait for them rather than escalating a PR that is simply moving
      // (Issue #3946).
      return "await_checks";
    case "head_too_recent":
      // The head was pushed moments ago; its check suites are still being
      // created (Issue #4375). Wait for the next scan.
      return "await_checks";
    case "milestone_rollup_merged":
      // The base's route to the default branch has closed; the auto-merge
      // path retargets the PR and explains itself (Issue #4396). The next
      // scan merges it onto the default branch.
      return "await_checks";
    case "milestone_route_unreadable":
      // The route could not be read (Issue #477). Wait and re-read; a
      // transient GitHub failure must not escalate a healthy PR.
      return "await_checks";
    case "default_branch_unapproved":
      // The guard is holding the PR for a review (Issue #1082). The
      // blocking-PR stall watchdog reports the repo if the hold lasts.
      return "await_checks";
    case "behind_target":
      return "update_branch";
    case "no_checks":
      // Nothing verified this head, and waiting will not produce a check.
      // A human decides whether to merge it (Issue #3705).
      return "escalate";
    case "merge_error":
      return "escalate";
  }
}

/**
 * Ask GitHub to merge the base branch into the PR branch.
 *
 * Uses the `update-branch` REST endpoint, so the checks re-run against the
 * merged state — the worker never merges a stale green result, and never
 * silently gives up on a PR that is only behind.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param ghFn - gh command runner
 * @returns Result — an error when the update was refused
 */
export async function requestBranchUpdate(
  repo: string,
  prNumber: number,
  ghFn: GhFn,
): Promise<Result<void>> {
  if (!REPO_PATTERN.test(repo)) {
    return {
      ok: false,
      error: new Error(`Invalid repo for branch update: ${repo}`),
    };
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return {
      ok: false,
      error: new Error(`Invalid PR number for branch update: ${prNumber}`),
    };
  }

  try {
    await ghFn([
      "api",
      "--method",
      "PUT",
      `repos/${repo}/pulls/${prNumber}/update-branch`,
    ]);
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to update branch for PR #${prNumber} in ${repo}: ${message}`,
      ),
    };
  }
}

/**
 * Act on a merge attempt's outcome — the loud half of the merge path.
 *
 * Never returns quietly on a fault: a green PR that will not merge, or a
 * stale-base PR whose branch update fails, always produces an explanatory
 * PR comment plus the `needs-human` label. A failure to escalate is itself
 * logged at error level rather than swallowed.
 *
 * @param options - Merge attempt context
 * @returns What was done for this PR
 */
export async function handleMergeAttempt(
  options: HandleMergeAttemptOptions,
): Promise<MergeAttemptHandling> {
  const { repo, prNumber, outcome, logger, ghFn } = options;
  const disposition = classifyMergeAttempt(outcome);

  if (disposition === "landed") {
    return { disposition, branchUpdateRequested: false, escalated: false };
  }

  if (disposition === "await_checks") {
    logger.info(
      outcome.kind === "milestone_children_open"
        ? "Merge deferred — milestone still has open children (Issue #3909)"
        : outcome.kind === "head_moved"
        ? "Merge deferred — the head moved after its checks were read (Issue #3946)"
        : "Merge deferred — PR is not green",
      { repo, prNumber, reason: outcome.kind },
    );
    return { disposition, branchUpdateRequested: false, escalated: false };
  }

  if (disposition === "update_branch") {
    const updateBranchFn = options.updateBranchFn ??
      ((r: string, n: number) => requestBranchUpdate(r, n, ghFn));
    const update = await updateBranchFn(repo, prNumber);
    if (update.ok) {
      logger.info(
        "PR is behind its base — branch updated, checks will re-run",
        { repo, prNumber },
      );
      return { disposition, branchUpdateRequested: true, escalated: false };
    }
    // The branch cannot be brought up to date automatically — this is the
    // silent-stall case, so escalate rather than leaving the PR open.
    const escalated = await escalate(
      options,
      `the PR is behind its base branch and the branch update failed: ` +
        `${redactSecrets(update.error.message)}`,
    );
    return {
      disposition: "escalate",
      branchUpdateRequested: false,
      escalated,
    };
  }

  const detail = outcome.kind === "merge_error"
    ? redactSecrets(outcome.message)
    : outcome.kind === "no_checks"
    ? "this PR has no check runs and no commit statuses, so nothing has " +
      "verified its head commit (Issue #3705)"
    : outcome.kind;
  const escalated = await escalate(
    options,
    `the worker could not arrange for this PR to merge automatically: ` +
      detail,
  );
  return { disposition, branchUpdateRequested: false, escalated };
}

/**
 * Post the explanatory comment and apply `needs-human`.
 *
 * One consolidated escalation per PR (the dedup key is the PR itself), so
 * a repeating maintenance scan does not spam the thread.
 */
async function escalate(
  options: HandleMergeAttemptOptions,
  reason: string,
): Promise<boolean> {
  const { repo, prNumber, logger, ghFn } = options;
  const escalateFn = options.escalateFn ?? escalateToHuman;

  const result = await escalateFn({
    ghClient: createGhEscalationClient(ghFn),
    repo,
    target: { kind: "pr", number: prNumber },
    needsHumanLabel: options.needsHumanLabel ?? "needs-human",
    heading: "Fix PR cannot be merged",
    reason,
    nextStep: MERGE_ESCALATION_NEXT_STEP,
    dedupKey: `merge-blocked:${repo}#${prNumber}`,
    ensureLabelColour: "d4c5f9",
    ensureLabelDescription:
      "Worker could not land this PR; human review required",
    githubUser: options.githubUser,
    logger,
  });

  if (!result.ok) {
    logger.error("Failed to escalate a blocked merge", {
      repo,
      prNumber,
      error: result.error.message,
    });
    return false;
  }
  return true;
}
