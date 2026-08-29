/**
 * Scan for worker PRs stuck at `mergeable == CONFLICTING` (Issue #84).
 *
 * Issue #4373 made the branch updater refuse to side-pick a conflict and
 * defer to "the PR-feedback agent or a human" — but no handler could ever
 * receive that hand-off. PR feedback triggers on review comments, CI fix
 * triggers on failing checks, and a CONFLICTING PR has neither (GitHub does
 * not run `pull_request` workflows when it cannot build the merge commit).
 * The PR sat CONFLICTING indefinitely while the nudge poked at it every pass.
 *
 * This module is the missing scan: it finds those PRs, makes the queue
 * visible with a {@link MERGE_CONFLICT_LABEL} label, and returns one
 * candidate for the conflict-resolution processor to merge for real.
 *
 * The pass is deliberately bounded — one attempt per PR per
 * {@link DEFAULT_CONFLICT_COOLDOWN_HOURS} hours, and at most
 * {@link DEFAULT_MAX_CONFLICT_ATTEMPTS} attempts before the processor
 * escalates with `needs-human` — so a genuinely unresolvable conflict
 * cannot loop forever.
 *
 * Only an attempt that reached a **conclusion** spends that budget (Issue
 * #395). An attempt marker with no conclusion means the run was disrupted —
 * a worker restart, a heartbeat sweep, an execute-budget cut — and the
 * conflict was never actually judged. Those attempts are counted separately,
 * re-attempted, and bounded by {@link DEFAULT_MAX_DISRUPTED_ATTEMPTS} so a
 * host that keeps dying escalates loudly instead of retrying forever.
 *
 * Attempt history lives in marker comments on the PR itself rather than in
 * host-local state, so the bound holds across hosts and worker restarts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { IssueCache } from "./issue_cache.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { fetchPRBranchStateBatch } from "./pr_branch_state.ts";
import { resolveFleetMaintenanceAuthorSet } from "./fleet_authors.ts";
import { listOpenPrs, type PrEntry } from "./pr_maintenance.ts";
import { addLabelToIssue, ensureLabelExists } from "./label_operations.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import {
  getLabelColour,
  getLabelDescription,
} from "../setup/label_definitions.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Visible queue label applied to every PR found CONFLICTING. */
export const MERGE_CONFLICT_LABEL = "merge-conflict";

/**
 * Colour for {@link MERGE_CONFLICT_LABEL} when it has to be created.
 * Issue #368 — resolved from the canonical label table, not a literal.
 */
export const MERGE_CONFLICT_LABEL_COLOUR = getLabelColour(
  MERGE_CONFLICT_LABEL,
);

/** Description for {@link MERGE_CONFLICT_LABEL} when it has to be created. */
export const MERGE_CONFLICT_LABEL_DESCRIPTION = getLabelDescription(
  MERGE_CONFLICT_LABEL,
);

/** Marker that identifies one recorded conflict-resolution attempt. */
export const CONFLICT_ATTEMPT_MARKER = "<!-- vibe-coder:merge-conflict-attempt";

/**
 * Marker posted when an attempt merged successfully. Everything before it
 * belongs to a conflict that is already resolved, so the attempt budget
 * restarts from it — a PR that conflicts again months later gets a full
 * budget rather than inheriting a spent one.
 */
export const CONFLICT_RESOLVED_MARKER =
  "<!-- vibe-coder:merge-conflict-resolved -->";

/**
 * Marker posted when an attempt reached a merge conclusion and failed
 * (Issue #395). It is what turns an opened attempt into a *spent* one — an
 * attempt marker with no conclusion after it was disrupted, not judged.
 */
export const CONFLICT_FAILED_MARKER = "<!-- vibe-coder:merge-conflict-failed";

/** Hours a PR waits after a failed attempt before another is made. */
export const DEFAULT_CONFLICT_COOLDOWN_HOURS = 4;

/**
 * Attempts allowed before the processor stops retrying and escalates.
 * Two: the first attempt, and one retry against a moved base.
 */
export const DEFAULT_MAX_CONFLICT_ATTEMPTS = 2;

/**
 * Disrupted attempts allowed before the PR is escalated (Issue #395).
 *
 * A disrupted attempt never judged the conflict, so it must not spend the
 * merge budget — but retrying it forever is the unbounded loop Issue #84
 * closed. Three disruptions on one PR means the disruption, not the
 * conflict, is the problem, and a human is told so.
 */
export const DEFAULT_MAX_DISRUPTED_ATTEMPTS = 3;

/** Label whose presence means a human already owns the conflict. */
const NEEDS_HUMAN_LABEL = "needs-human";

/** PR-list fields this scan needs. */
const PR_FIELDS = "number,headRefName,baseRefName";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A PR whose branch conflicts with its base and needs a real merge. */
export interface ConflictingPr {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Head branch name. */
  branchName: string;
  /** Base branch the PR targets. */
  baseBranch: string;
  /** Concluded attempts already recorded against this PR. */
  attemptCount: number;
  /** Attempts disrupted before they reached a conclusion (Issue #395). */
  disruptedCount: number;
}

/** Attempt history read back from a PR's comment thread. */
export interface ConflictAttemptHistory {
  /** Attempts that reached a conclusion — the ones that spend the budget. */
  count: number;
  /** Attempts abandoned without any conclusion (Issue #395). */
  disruptedCount: number;
  /** True when the most recent attempt has recorded no conclusion yet. */
  pendingAttempt: boolean;
  /** ISO timestamp of the most recent attempt, when known. */
  lastAttemptAt?: string;
}

/** Options for {@link findConflictingPr}. */
export interface FindConflictingPrOptions {
  /** GitHub login that authored the worker's PRs. */
  githubUser: string;
  /** Trusted human logins (`allowed_authors`). */
  allowedAuthors?: readonly string[];
  /** Sibling fleet logins (`fleet_pr_authors`). */
  fleetPrAuthors?: readonly string[];
  /** Monitored repos in `owner/repo` format. */
  repos: readonly string[];
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Allowlist check for a repo. */
  isRepoAllowed: (repo: string) => boolean;
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Shared PR-list cache (Issue #4303). */
  cache?: IssueCache;
  /** Optional repo shuffler so no repo is starved. */
  shuffleRepos?: (repos: string[]) => string[];
  /** Hours between attempts on the same PR. */
  cooldownHours?: number;
  /** Attempts allowed before the PR is left to a human. */
  maxAttempts?: number;
  /** Disrupted attempts allowed before the PR is escalated (Issue #395). */
  maxDisruptedAttempts?: number;
  /** Label applied on escalation. Defaults to `needs-human`. */
  needsHumanLabel?: string;
  /** Clock override (epoch milliseconds). */
  nowMs?: () => number;
  /**
   * PRs this cycle has already taken or deferred, as `owner/repo#number`
   * (Issue #561).
   *
   * The pass drains its queue within a cycle, so it calls this scan
   * repeatedly. Without an exclusion set the next call re-selects the PR the
   * caller just handled — or the one whose repository an issue slot holds —
   * and the drain spins on it instead of moving on. Build the keys with
   * {@link conflictPrKey}.
   */
  exclude?: ReadonlySet<string>;
}

/** The `owner/repo#number` key {@link FindConflictingPrOptions.exclude} uses. */
export function conflictPrKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

// ---------------------------------------------------------------------------
// Pure decision helpers
// ---------------------------------------------------------------------------

/**
 * Read the conflict-resolution attempt history out of a comment thread.
 *
 * An attempt **opens** with a {@link CONFLICT_ATTEMPT_MARKER} comment posted
 * before the merge runs, and **concludes** with either a
 * {@link CONFLICT_RESOLVED_MARKER} (merged) or a
 * {@link CONFLICT_FAILED_MARKER} (judged and failed). Only a concluded
 * attempt spends the budget (Issue #395): an attempt that opened and never
 * concluded was disrupted — the run was killed before the merge was judged —
 * and burning the budget on it left PRs like GRQ#4408/#4409 stalled at
 * "attempt 1 of 2" with no conclusion and no retry.
 *
 * A resolved marker resets everything: attempts before a successful merge
 * belong to a conflict that is already over.
 *
 * The history lives on the PR rather than in host-local state, so the bounds
 * hold across worker restarts and across hosts.
 *
 * @param comments - Raw comment objects from the GitHub REST API, oldest first.
 * @returns Concluded and disrupted counts, whether an attempt is still open,
 *   and the timestamp of the most recent attempt.
 */
export function parseConflictAttempts(
  comments: readonly unknown[],
): ConflictAttemptHistory {
  let count = 0;
  let disruptedCount = 0;
  let pendingAttempt = false;
  let lastAttemptAt: string | undefined;

  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const comment = raw as { body?: unknown; created_at?: unknown };
    if (typeof comment.body !== "string") continue;

    if (comment.body.includes(CONFLICT_RESOLVED_MARKER)) {
      count = 0;
      disruptedCount = 0;
      pendingAttempt = false;
      lastAttemptAt = undefined;
      continue;
    }

    if (comment.body.includes(CONFLICT_FAILED_MARKER)) {
      // A conclusion always spends an attempt, even if its opening marker is
      // no longer in the thread — the conservative direction.
      count++;
      pendingAttempt = false;
      continue;
    }

    if (!comment.body.includes(CONFLICT_ATTEMPT_MARKER)) continue;

    // A new attempt opening while one is still open means the earlier one
    // never reached a conclusion.
    if (pendingAttempt) disruptedCount++;
    pendingAttempt = true;

    const createdAt = typeof comment.created_at === "string"
      ? comment.created_at
      : undefined;
    if (!createdAt) continue;
    if (
      lastAttemptAt === undefined ||
      Date.parse(createdAt) > Date.parse(lastAttemptAt)
    ) {
      lastAttemptAt = createdAt;
    }
  }

  return { count, disruptedCount, pendingAttempt, lastAttemptAt };
}

/**
 * Disrupted attempts on this PR, counting a still-open attempt as disrupted
 * (Issue #395).
 *
 * Only meaningful once the cooldown has elapsed: before that, an open attempt
 * is more likely in flight on another host than disrupted, which is exactly
 * what the cooldown gate is for.
 */
export function countDisruptedAttempts(
  history: ConflictAttemptHistory,
): number {
  return history.disruptedCount + (history.pendingAttempt ? 1 : 0);
}

/**
 * Whether disruption — not the conflict — is what is blocking this PR, and a
 * human should be told (Issue #395).
 *
 * @param disruptedCount - From {@link countDisruptedAttempts}.
 * @param maxDisrupted - Bound.
 */
export function hasExhaustedDisruptedAttempts(
  disruptedCount: number,
  maxDisrupted: number = DEFAULT_MAX_DISRUPTED_ATTEMPTS,
): boolean {
  return disruptedCount >= maxDisrupted;
}

/** Why a repeatedly disrupted conflict is being handed to a human. */
export function buildDisruptionEscalationReason(
  prNumber: number,
  disruptedCount: number,
): string {
  return [
    `${disruptedCount} merge-conflict resolution attempts on PR #${prNumber} ` +
    "were disrupted before they reached a conclusion — each posted an " +
    "attempt comment and then went silent, so the conflict itself was never " +
    "judged.",
    "",
    "That points at the worker running the attempt (a restart, a swept " +
    "heartbeat, a timeout or an exhausted run budget), not at the conflict. " +
    "The branch was left exactly as its author pushed it, so no change has " +
    "been lost.",
  ].join("\n");
}

/** What the human must do about a repeatedly disrupted conflict. */
export const DISRUPTED_CONFLICT_NEXT_STEP =
  "Check the worker logs for why the resolution runs are being cut short, " +
  "then either merge the base branch into the PR branch by hand — keeping " +
  "both sides' changes — or remove the `needs-human` label to let the " +
  "worker try again.";

/**
 * Why a PR that is out of attempts but owned by nobody is being handed over
 * (Issue #395).
 *
 * The last concluded attempt escalates from the resolution pass — but that
 * escalation can itself fail, or the run can end between the failure
 * conclusion and the escalation. The PR is then conflicting, out of budget
 * and unowned, which every later scan skips in silence. This is the backstop.
 */
export function buildExhaustedEscalationReason(
  prNumber: number,
  attemptCount: number,
): string {
  return [
    `PR #${prNumber} has spent all ${attemptCount} of its merge-conflict ` +
    "resolution attempts and still conflicts with its base, but was never " +
    "handed to a human — the escalation on the final attempt did not land.",
    "",
    "The failure comments above say what each attempt tripped on. The " +
    "branch was left exactly as its author pushed it, so no change has been " +
    "lost.",
  ].join("\n");
}

/** What the human must do about a conflict the worker is out of attempts for. */
export const EXHAUSTED_CONFLICT_NEXT_STEP =
  "Merge the base branch into the PR branch by hand — keeping both sides' " +
  "changes, never side-picking — or close the PR if it is obsolete. " +
  "Removing the `needs-human` label alone will not restart the worker: its " +
  "attempt budget only resets once the conflict is resolved.";

/**
 * Whether another attempt on this PR is due.
 *
 * False while the cooldown since the last recorded attempt has not
 * elapsed, so a PR cannot be re-attempted every pass. An unparseable
 * timestamp is treated as "cooldown not elapsed" — the conservative
 * direction, because guessing the other way re-attempts every pass.
 *
 * @param history - Attempt history from {@link parseConflictAttempts}.
 * @param nowMs - Current time in epoch milliseconds.
 * @param cooldownHours - Hours that must pass between attempts.
 */
export function isConflictAttemptDue(
  history: ConflictAttemptHistory,
  nowMs: number,
  cooldownHours: number = DEFAULT_CONFLICT_COOLDOWN_HOURS,
): boolean {
  if (history.lastAttemptAt === undefined) return true;
  const lastMs = Date.parse(history.lastAttemptAt);
  if (Number.isNaN(lastMs)) return false;
  return nowMs - lastMs >= cooldownHours * 3600_000;
}

/**
 * Whether the PR has spent its attempt budget.
 *
 * @param attemptCount - Attempts that reached a conclusion (Issue #395);
 *   disrupted attempts are counted by {@link countDisruptedAttempts} instead.
 * @param maxAttempts - Budget.
 */
export function hasExhaustedConflictAttempts(
  attemptCount: number,
  maxAttempts: number = DEFAULT_MAX_CONFLICT_ATTEMPTS,
): boolean {
  return attemptCount >= maxAttempts;
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

/** Read a PR's label names. Throws so callers can fail loud. */
async function fetchPrLabels(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string[]> {
  const raw = await ghCommandFn([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "labels",
    "--jq",
    ".labels[].name",
  ]);
  return raw.split("\n").map((line) => line.trim()).filter((l) => l.length > 0);
}

/**
 * Apply {@link MERGE_CONFLICT_LABEL} to a PR so the stuck queue is visible
 * without trawling per-pass log noise (Issue #84).
 *
 * @returns True when the label was added by this call.
 */
export async function ensureMergeConflictLabel(
  repo: string,
  prNumber: number,
  existingLabels: readonly string[],
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  if (existingLabels.includes(MERGE_CONFLICT_LABEL)) return false;

  const ensured = await ensureLabelExists(
    repo,
    MERGE_CONFLICT_LABEL,
    MERGE_CONFLICT_LABEL_COLOUR,
    MERGE_CONFLICT_LABEL_DESCRIPTION,
    { ghCommandFn },
  );
  if (!ensured.ok) throw ensured.error;

  // Routed through the guarded helper, not a raw `gh pr edit --add-label`,
  // so the Rule-of-Two worker-label allowlist gates this call site too
  // (Issue #2382). PRs are issues to the labels endpoint.
  const added = await addLabelToIssue(repo, prNumber, MERGE_CONFLICT_LABEL, {
    ghCommandFn,
  });
  if (!added.ok) throw added.error;
  return true;
}

/** Remove {@link MERGE_CONFLICT_LABEL} once the PR merges cleanly again. */
export async function clearMergeConflictLabel(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<void> {
  await ghCommandFn([
    "api",
    "-X",
    "DELETE",
    `repos/${repo}/issues/${prNumber}/labels/${MERGE_CONFLICT_LABEL}`,
  ]);
}

/** Mergeable state per PR number, batched where possible. */
async function fetchMergeableStates(
  repo: string,
  prs: readonly PrEntry[],
  ghCommandFn: (args: string[]) => Promise<string>,
  cache: IssueCache | undefined,
  logger: Logger,
): Promise<Map<number, string>> {
  const states = new Map<number, string>();
  if (prs.length === 0) return states;

  const batch = await fetchPRBranchStateBatch(
    repo,
    prs.map((pr) => ({
      number: pr.number,
      // allow-hardcoded-branch — safe fallback when the listing omits the base
      baseRefName: pr.baseRefName || "main",
      // Issue #470: orients the ahead/behind comparison.
      headRefName: pr.headRefName,
    })),
    ghCommandFn,
    cache,
  );

  if (batch.ok) {
    for (const [number, state] of batch.states) {
      states.set(number, state.mergeable);
    }
    return states;
  }

  logger.debug("Merge-conflict scan: batch state fetch failed, using REST", {
    repo,
    error: batch.error.message,
  });

  for (const pr of prs) {
    try {
      const raw = await ghCommandFn([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repo,
        "--json",
        "mergeable",
        "--jq",
        ".mergeable",
      ]);
      states.set(pr.number, raw.trim());
    } catch (err) {
      logger.debug("Merge-conflict scan: mergeable lookup failed", {
        repo,
        prNumber: pr.number,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return states;
}

/**
 * Hand a conflicting PR the scan will not act on to a human (Issue #395).
 *
 * Runs from the scan rather than the processor on purpose: both cases it
 * covers — repeated disruption, and a budget spent without the processor's
 * escalation landing — are cases where the processor could not finish, so the
 * escalation must not depend on getting a clone and reaching it. Best-effort
 * — a failure here is logged loudly and the PR stays in the queue.
 */
async function escalateConflictingPr(args: {
  repo: string;
  prNumber: number;
  heading: string;
  reason: string;
  nextStep: string;
  dedupKey: string;
  needsHumanLabel: string;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}): Promise<void> {
  const { repo, prNumber, logger } = args;

  const escalation = await escalateToHuman({
    ghClient: createGhEscalationClient(args.ghCommandFn),
    repo,
    target: { kind: "pr", number: prNumber },
    needsHumanLabel: args.needsHumanLabel,
    heading: args.heading,
    reason: args.reason,
    nextStep: args.nextStep,
    dedupKey: args.dedupKey,
    deps: {
      github: {
        ensureLabelExists: (
          labelRepo: string,
          labelName: string,
          colour?: string,
          description?: string,
        ) =>
          ensureLabelExists(labelRepo, labelName, colour, description, {
            ghCommandFn: args.ghCommandFn,
          }),
      },
    },
    logger,
  });
  if (!escalation.ok) {
    logger.error("Failed to escalate a conflicting PR from the scan", {
      repo,
      prNumber,
      heading: args.heading,
      error: escalation.error.message,
    });
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Find one worker PR that conflicts with its base and is due an attempt.
 *
 * Every conflicting PR encountered is labelled {@link MERGE_CONFLICT_LABEL}
 * whether or not it is selected, so the queue is visible immediately. A PR
 * already carrying `needs-human`, already at its attempt cap, or still
 * inside its cooldown is labelled but not returned.
 *
 * A PR whose attempts keep being disrupted before they conclude is escalated
 * here rather than handed on (Issue #395) — the processor may be exactly what
 * cannot finish, so the escalation must not depend on reaching it.
 *
 * Per-repo failures are logged and skipped so one unreachable repo cannot
 * stall the scan.
 *
 * @returns The PR to work on, or `null` when nothing is due.
 */
export async function findConflictingPr(
  options: FindConflictingPrOptions,
): Promise<Result<ConflictingPr | null>> {
  const {
    githubUser,
    allowedAuthors = [],
    fleetPrAuthors = [],
    repos,
    logger,
    isRepoAllowed,
    ghCommandFn,
    cache,
    shuffleRepos,
    cooldownHours = DEFAULT_CONFLICT_COOLDOWN_HOURS,
    maxAttempts = DEFAULT_MAX_CONFLICT_ATTEMPTS,
    maxDisruptedAttempts = DEFAULT_MAX_DISRUPTED_ATTEMPTS,
    needsHumanLabel = NEEDS_HUMAN_LABEL,
    nowMs = () => Date.now(),
    exclude,
  } = options;

  // The pass pushes a merge commit to the PR branch, so it is scoped to
  // the push-capable maintenance set (Issue #4076) — never an uninvited
  // human's PR.
  const scanAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    allowedAuthors,
    fleetPrAuthors,
  });

  const orderedRepos = shuffleRepos ? shuffleRepos([...repos]) : [...repos];

  for (const repo of orderedRepos) {
    if (!isRepoAllowed(repo)) continue;

    let prs: PrEntry[];
    try {
      prs = await listOpenPrs(repo, scanAuthors, PR_FIELDS, ghCommandFn, cache);
    } catch (err) {
      logger.warn("Merge-conflict scan: failed to list PRs", {
        repo,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const states = await fetchMergeableStates(
      repo,
      prs,
      ghCommandFn,
      cache,
      logger,
    );

    for (const pr of prs) {
      if (states.get(pr.number) !== "CONFLICTING") continue;
      // Already handled or deferred by this cycle's drain (Issue #561). The
      // skip is before the label call: the PR was labelled on the pass that
      // selected it.
      if (exclude?.has(conflictPrKey(repo, pr.number))) continue;

      let labels: string[];
      try {
        labels = await fetchPrLabels(repo, pr.number, ghCommandFn);
      } catch (err) {
        logger.warn("Merge-conflict scan: failed to read PR labels", {
          repo,
          prNumber: pr.number,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Make the queue visible before deciding whether to act — a PR the
      // worker will not touch is exactly the one a human must be able to
      // see (Issue #84).
      try {
        if (
          await ensureMergeConflictLabel(repo, pr.number, labels, ghCommandFn)
        ) {
          logger.warn(
            `PR #${pr.number} conflicts with ${
              pr.baseRefName ?? "its base"
            } — labelled '${MERGE_CONFLICT_LABEL}'`,
            { repo, prNumber: pr.number },
          );
        }
      } catch (err) {
        logger.warn("Merge-conflict scan: failed to apply conflict label", {
          repo,
          prNumber: pr.number,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (labels.includes(needsHumanLabel)) {
        logger.debug("Conflicting PR already escalated to a human — skipping", {
          repo,
          prNumber: pr.number,
        });
        continue;
      }

      let history: ConflictAttemptHistory;
      try {
        history = parseConflictAttempts(
          await fetchIssueCommentPages(repo, pr.number, ghCommandFn),
        );
      } catch (err) {
        logger.warn("Merge-conflict scan: failed to read attempt history", {
          repo,
          prNumber: pr.number,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // A spent budget is only a quiet skip once the PR is visibly a human's
      // (Issue #395). Reaching here means it is not: the label check above
      // already let it through, so the processor's final escalation never
      // landed and the PR would stall unowned for ever.
      if (hasExhaustedConflictAttempts(history.count, maxAttempts)) {
        logger.warn(
          `PR #${pr.number} has spent its ${maxAttempts} merge-conflict ` +
            "attempts without being handed to a human — escalating",
          { repo, prNumber: pr.number, attempts: history.count, maxAttempts },
        );
        await escalateConflictingPr({
          repo,
          prNumber: pr.number,
          heading: "Merge conflict needs human attention",
          reason: buildExhaustedEscalationReason(pr.number, history.count),
          nextStep: EXHAUSTED_CONFLICT_NEXT_STEP,
          // The key the resolution pass uses, so a landed escalation is not
          // duplicated — only its missing label is re-applied.
          dedupKey: `merge-conflict-${pr.number}`,
          needsHumanLabel,
          ghCommandFn,
          logger,
        });
        continue;
      }

      if (!isConflictAttemptDue(history, nowMs(), cooldownHours)) {
        logger.debug("Conflicting PR is still inside its attempt cooldown", {
          repo,
          prNumber: pr.number,
          lastAttemptAt: history.lastAttemptAt,
          cooldownHours,
        });
        continue;
      }

      // Past the cooldown, an attempt that never concluded is a disrupted
      // attempt, not one in flight (Issue #395). It does not spend the merge
      // budget — but repeated disruption is its own failure, and it is
      // escalated rather than retried silently forever.
      const disruptedCount = countDisruptedAttempts(history);
      if (hasExhaustedDisruptedAttempts(disruptedCount, maxDisruptedAttempts)) {
        logger.warn(
          `PR #${pr.number} has had ${disruptedCount} merge-conflict attempts ` +
            "disrupted before any conclusion — escalating to a human",
          { repo, prNumber: pr.number, disruptedCount },
        );
        await escalateConflictingPr({
          repo,
          prNumber: pr.number,
          heading: "Merge-conflict resolution keeps being disrupted",
          reason: buildDisruptionEscalationReason(pr.number, disruptedCount),
          nextStep: DISRUPTED_CONFLICT_NEXT_STEP,
          dedupKey: `merge-conflict-disrupted-${pr.number}`,
          needsHumanLabel,
          ghCommandFn,
          logger,
        });
        continue;
      }

      if (disruptedCount > 0) {
        logger.warn(
          `PR #${pr.number} has ${disruptedCount} disrupted merge-conflict ` +
            "attempt(s) with no conclusion — re-attempting",
          {
            repo,
            prNumber: pr.number,
            disruptedCount,
            maxDisruptedAttempts,
          },
        );
      }

      logger.info("Found a conflicting PR that needs a real merge", {
        repo,
        prNumber: pr.number,
        attempts: history.count,
        disruptedCount,
      });

      return {
        ok: true,
        value: {
          repo,
          prNumber: pr.number,
          branchName: pr.headRefName,
          // allow-hardcoded-branch — safe fallback when the listing omits it
          baseBranch: pr.baseRefName || "main",
          attemptCount: history.count,
          disruptedCount,
        },
      };
    }
  }

  return { ok: true, value: null };
}
