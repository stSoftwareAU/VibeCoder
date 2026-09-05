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

import type { LogContext, Logger, Result } from "../types.ts";
import type { IssueCache } from "./issue_cache.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { fetchPRBranchStateBatch } from "./pr_branch_state.ts";
import {
  isFleetAuthor,
  resolveFleetMaintenanceAuthorSet,
} from "./fleet_authors.ts";
import { listOpenPrs, type PrEntry } from "./pr_maintenance.ts";
import { orderByPreference, preferredRepos } from "./conflict_queue_order.ts";
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

/**
 * PR-list fields this scan needs.
 *
 * `author` rides the listing the scan already makes (Issue #1109) — it costs
 * no extra call, and it is what lets a PR outside the maintenance set be
 * recorded as `out-of-scope-author` rather than assumed away.
 */
const PR_FIELDS = "number,headRefName,baseRefName,author";

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

// ---------------------------------------------------------------------------
// Decision taxonomy (Issue #1109)
// ---------------------------------------------------------------------------

/**
 * Why a PR the merge-conflict pass looked at was not attempted.
 *
 * The taxonomy is **closed**: every exit out of {@link findConflictingPr},
 * `drainConflictingPrs` and the resolution processor's lock gate maps to
 * exactly one member, and each member carries the operands that make the
 * decision checkable afterwards — the milliseconds a cooldown still has to
 * run, the attempts a spent budget burned, the host holding the lock.
 *
 * Issue #1076's symptom was "the label went on and then silence": a skipped
 * PR produced either nothing or an unstructured log line, so a stalled fleet
 * and a fleet correctly waiting out a cooldown looked identical. A decision
 * is a **required return value** here rather than an optional field, so an
 * exit added without one does not compile, and {@link conflictReasonOperands}
 * switches exhaustively so a new member with no case does not compile either.
 *
 * Members are per-PR except `queue-empty`, `deadline` and `cap`, which are the
 * drain's pass-level stops.
 */
export type ConflictSkipReason =
  /** The PR's branch merges cleanly — it is not in the queue at all. */
  | { kind: "not-conflicting"; mergeableState: string }
  /** Authored outside the push-capable maintenance set (Issue #4076). */
  | { kind: "out-of-scope-author"; author: string }
  /** Taken or deferred earlier in this same cycle's drain (Issue #561). */
  | { kind: "already-handled" }
  /** A per-PR lookup failed; the PR keeps its place in the queue. */
  | {
    kind: "scan-error";
    stage: "mergeable-state" | "labels" | "attempt-history";
    message: string;
  }
  /** A human already owns the conflict. */
  | { kind: "needs-human"; label: string }
  /** Every concluded attempt in the budget is spent. */
  | { kind: "budget-spent"; attemptsSpent: number; maxAttempts: number }
  /**
   * Still inside the post-attempt cooldown. `msUntilDue` is null when the
   * recorded attempt timestamp does not parse — the conservative case
   * {@link isConflictAttemptDue} holds back rather than guesses.
   */
  | { kind: "cooldown"; msUntilDue: number | null; lastAttemptAt?: string }
  /** Attempts keep being disrupted before they conclude (Issue #395). */
  | {
    kind: "disrupted-bound";
    disruptedCount: number;
    maxDisruptedAttempts: number;
  }
  /** Another host holds the cross-host PR lock. */
  | { kind: "lock-held"; lockHolder: string }
  /**
   * An issue slot holds the repository's shared clone (Issue #213).
   * `deferralStreak` is the consecutive passes that have now deferred this PR
   * without attempting it (Issue #1111), absent when no cursor is kept.
   */
  | { kind: "repo-leased"; deferralStreak?: number }
  /**
   * Left in the queue by a pass-level bound before any attempt started
   * (Issue #1111) — the deadline arrived, or the cap was full. Distinct from
   * the pass-level `deadline`/`cap` stops below: this one is about one PR, and
   * unlike them it names a queued PR.
   */
  | {
    kind: "deferred-bound";
    bound: "deadline" | "cap";
    deferralStreak: number;
  }
  /** Pass-level: nothing else was due. */
  | { kind: "queue-empty" }
  /** Pass-level: too little of the cycle remained for another attempt. */
  | { kind: "deadline"; remainingMs: number }
  /** Pass-level: the per-cycle cap was reached. */
  | { kind: "cap"; maxPerCycle: number };

/** The discriminator of {@link ConflictSkipReason}. */
export type ConflictSkipReasonKind = ConflictSkipReason["kind"];

/**
 * Every reason kind, as a value.
 *
 * The `Record` is the point: a member added to {@link ConflictSkipReason}
 * without a key here is a compile error, so the runtime list can never fall
 * behind the type.
 */
const CONFLICT_SKIP_REASON_KIND_SET: Record<ConflictSkipReasonKind, true> = {
  "not-conflicting": true,
  "out-of-scope-author": true,
  "already-handled": true,
  "scan-error": true,
  "needs-human": true,
  "budget-spent": true,
  "cooldown": true,
  "disrupted-bound": true,
  "lock-held": true,
  "repo-leased": true,
  "deferred-bound": true,
  "queue-empty": true,
  "deadline": true,
  "cap": true,
};

/** Every reason kind, in a stable order (Issue #1109). */
export const CONFLICT_SKIP_REASON_KINDS = Object.keys(
  CONFLICT_SKIP_REASON_KIND_SET,
) as readonly ConflictSkipReasonKind[];

/**
 * What one pass decided about one PR — attempted, or skipped for exactly one
 * reason (Issue #1109).
 */
export type ConflictPrDecision =
  | { repo: string; prNumber: number; outcome: "attempted" }
  | {
    repo: string;
    prNumber: number;
    outcome: "skipped";
    reason: ConflictSkipReason;
  };

/** A pass's decisions, counted (Issue #1109). */
export interface ConflictDecisionSummary {
  /** Every PR the pass decided on, in the queue or not. */
  considered: number;
  /** PRs in the merge-conflict queue — conflicting, so carrying the label. */
  labelled: number;
  /** Of those, the PRs selected for an attempt. */
  attempted: number;
  /** Skipped counts keyed by reason; only reasons actually seen appear. */
  byReason: Partial<Record<ConflictSkipReasonKind, number>>;
}

/**
 * Whether a reason describes a PR that is in the merge-conflict queue — that
 * is, one the scan has labelled.
 *
 * Exhaustive by construction: a new reason with no case here is a compile
 * error, which is what stops a new exit from quietly leaving the queue count
 * wrong.
 */
export function isQueuedConflictReason(kind: ConflictSkipReasonKind): boolean {
  switch (kind) {
    // Decided before the PR ever reached the labelling step.
    case "not-conflicting":
    case "out-of-scope-author":
    // Pass-level stops: about the pass, not about one queued PR.
    case "queue-empty":
    case "deadline":
    case "cap":
      return false;
    case "already-handled":
    case "scan-error":
    case "needs-human":
    case "budget-spent":
    case "cooldown":
    case "disrupted-bound":
    case "lock-held":
    case "repo-leased":
    // Issue #1111: a PR the deadline or the cap left behind is queued and
    // labelled, unlike the pass-level stop of the same name.
    case "deferred-bound":
      return true;
  }
  const unhandled: never = kind;
  throw new Error(`Unhandled conflict skip reason: ${String(unhandled)}`);
}

/**
 * The reason's operands, flattened for the structured log record.
 *
 * The exhaustive switch is the compile-time half of the acceptance criterion:
 * adding a member to {@link ConflictSkipReason} without a case here fails the
 * type check rather than shipping a record with no operands.
 */
export function conflictReasonOperands(
  reason: ConflictSkipReason,
): LogContext {
  switch (reason.kind) {
    case "not-conflicting":
      return { mergeableState: reason.mergeableState };
    case "out-of-scope-author":
      return { author: reason.author };
    case "already-handled":
      return {};
    case "scan-error":
      return { stage: reason.stage, error: reason.message };
    case "needs-human":
      return { label: reason.label };
    case "budget-spent":
      return {
        attemptsSpent: reason.attemptsSpent,
        maxAttempts: reason.maxAttempts,
      };
    case "cooldown":
      return {
        msUntilDue: reason.msUntilDue,
        ...(reason.lastAttemptAt !== undefined
          ? { lastAttemptAt: reason.lastAttemptAt }
          : {}),
      };
    case "disrupted-bound":
      return {
        disruptedCount: reason.disruptedCount,
        maxDisruptedAttempts: reason.maxDisruptedAttempts,
      };
    case "lock-held":
      return { lockHolder: reason.lockHolder };
    case "repo-leased":
      return reason.deferralStreak !== undefined
        ? { deferralStreak: reason.deferralStreak }
        : {};
    case "deferred-bound":
      return { bound: reason.bound, deferralStreak: reason.deferralStreak };
    case "queue-empty":
      return {};
    case "deadline":
      return { remainingMs: reason.remainingMs };
    case "cap":
      return { maxPerCycle: reason.maxPerCycle };
  }
  const unhandled: never = reason;
  throw new Error(
    `Unhandled conflict skip reason: ${JSON.stringify(unhandled)}`,
  );
}

/** The structured context one per-PR record carries. */
export function conflictDecisionContext(
  decision: ConflictPrDecision,
): LogContext {
  const base = { repo: decision.repo, prNumber: decision.prNumber };
  if (decision.outcome === "attempted") {
    return { ...base, decision: "attempted", reason: "attempted" };
  }
  return {
    ...base,
    decision: "skipped",
    reason: decision.reason.kind,
    ...conflictReasonOperands(decision.reason),
  };
}

/**
 * Emit one record for one PR's decision (Issue #1109).
 *
 * Queue decisions go out at INFO — they are the ones a stall investigation
 * queries — while a PR that was never in the queue is DEBUG, so a fleet of
 * healthy PRs does not flood the log every 2.5-minute cycle.
 */
export function recordConflictDecision(
  logger: Logger,
  decision: ConflictPrDecision,
): void {
  const context = conflictDecisionContext(decision);
  const message = `merge_conflict_decision=${context.reason} ` +
    `repo=${decision.repo} pr=${decision.prNumber}`;
  const queued = decision.outcome === "attempted" ||
    isQueuedConflictReason(decision.reason.kind);
  if (queued) logger.info(message, context);
  else logger.debug(message, context);
}

/** Count a pass's decisions for its summary record. */
export function summariseConflictDecisions(
  decisions: readonly ConflictPrDecision[],
): ConflictDecisionSummary {
  const byReason: Partial<Record<ConflictSkipReasonKind, number>> = {};
  let labelled = 0;
  let attempted = 0;

  for (const decision of decisions) {
    if (decision.outcome === "attempted") {
      attempted++;
      labelled++;
      continue;
    }
    const kind = decision.reason.kind;
    byReason[kind] = (byReason[kind] ?? 0) + 1;
    if (isQueuedConflictReason(kind)) labelled++;
  }

  return { considered: decisions.length, labelled, attempted, byReason };
}

/**
 * Emit the one pass-level summary that closes a pass (Issue #1109).
 *
 * @param scope - Which pass this is, e.g. `scan` or `drain`.
 * @param decisions - Every per-PR decision the pass made.
 * @param extra - Pass-level context, such as the drain's stop reason.
 */
export function recordConflictPassSummary(
  logger: Logger,
  scope: string,
  decisions: readonly ConflictPrDecision[],
  extra: LogContext = {},
): void {
  const summary = summariseConflictDecisions(decisions);
  const counts = Object.entries(summary.byReason)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(" ");
  const message = `merge_conflict_pass=${scope} labelled=${summary.labelled} ` +
    `attempted=${summary.attempted} considered=${summary.considered}` +
    (counts.length > 0 ? ` ${counts}` : "");
  const context = { scope, ...summary, ...extra };
  // A pass over a fleet with nothing in the queue is the ordinary quiet case
  // and stays at DEBUG; the moment one PR is queued the summary is the line a
  // stall investigation greps for, so it goes out at INFO.
  if (summary.labelled > 0) logger.info(message, context);
  else logger.debug(message, context);
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
  /**
   * PRs a previous pass deferred without attempting, most starved first
   * (Issue #1111).
   *
   * The scan re-derives the same order every pass, so a PR behind a busy
   * repository or at the end of a backlog is skipped indefinitely. These keys
   * are offered first — repositories in cursor order, and preferred PRs first
   * within their repository. It is an ordering hint only: every gate below
   * still runs, so a preferred PR that is not due is skipped like any other.
   */
  prefer?: readonly string[];
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
 * How long this PR's cooldown still has to run, in milliseconds (Issue #1109).
 *
 * `0` when an attempt is due now, and `null` when the recorded timestamp does
 * not parse — the case {@link isConflictAttemptDue} holds the PR back on
 * rather than guessing, so the record says "unknown" instead of inventing a
 * number.
 */
export function conflictCooldownMsRemaining(
  history: ConflictAttemptHistory,
  nowMs: number,
  cooldownHours: number = DEFAULT_CONFLICT_COOLDOWN_HOURS,
): number | null {
  if (history.lastAttemptAt === undefined) return 0;
  const lastMs = Date.parse(history.lastAttemptAt);
  if (Number.isNaN(lastMs)) return null;
  return Math.max(0, lastMs + cooldownHours * 3600_000 - nowMs);
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

/** What one scan pass selected, and every decision it made (Issue #1109). */
export interface ConflictScanPass {
  /** The PR to work on, or `null` when nothing is due. */
  selected: ConflictingPr | null;
  /** One entry per PR the pass decided on, in the order it decided them. */
  decisions: readonly ConflictPrDecision[];
}

/**
 * One PR's outcome inside the scan, before the record is built.
 *
 * Every path through the per-PR decision must produce one of these — that is
 * what makes "an exit with no reason" a compile error rather than a silence
 * (Issue #1109). Exported so the compile gate in
 * `merge_conflict_decision_taxonomy_test.ts` can hold a returnless exit
 * against the real declared type rather than a copy of it.
 */
export type ConflictScanPrOutcome =
  | { outcome: "attempted"; pr: ConflictingPr }
  | { outcome: "skipped"; reason: ConflictSkipReason };

/** The author login a listing entry carried, when it carried one. */
function prAuthorLogin(pr: PrEntry): string | undefined {
  const login = pr.author?.login;
  return typeof login === "string" && login.trim().length > 0
    ? login.trim()
    : undefined;
}

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
 * Every PR the pass decides on gets one {@link ConflictPrDecision} — attempted,
 * or skipped for exactly one {@link ConflictSkipReason} — recorded through the
 * logger and returned to the caller, so "the label went on and then silence"
 * cannot recur (Issue #1109). The records cost no extra GitHub calls: every
 * operand comes from data the pass already fetched.
 *
 * Per-repo failures are logged and skipped so one unreachable repo cannot
 * stall the scan. Those are repo-level, not PR-level, so they carry no per-PR
 * record — no PR is known to record against.
 *
 * @returns The selected PR (or `null`) plus every decision the pass made.
 */
export async function findConflictingPr(
  options: FindConflictingPrOptions,
): Promise<Result<ConflictScanPass>> {
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
    prefer,
  } = options;

  // The pass pushes a merge commit to the PR branch, so it is scoped to
  // the push-capable maintenance set (Issue #4076) — never an uninvited
  // human's PR.
  const scanAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    allowedAuthors,
    fleetPrAuthors,
  });

  /**
   * Decide one PR, in the order the gates run.
   *
   * The declared return type is what closes the taxonomy: a branch that falls
   * out of here without a decision does not compile (Issue #1109).
   */
  const decidePr = async (
    repo: string,
    pr: PrEntry,
    mergeableState: string | undefined,
  ): Promise<ConflictScanPrOutcome> => {
    if (mergeableState === undefined) {
      // The state lookup failed for this PR — both the batched query and the
      // REST fallback. Reporting that as "not conflicting" would read as a
      // healthy PR and hide a whole repository's backlog behind a DEBUG line,
      // which is the silent failure this instrument exists to remove.
      return {
        outcome: "skipped",
        reason: {
          kind: "scan-error",
          stage: "mergeable-state",
          message: "mergeable state unavailable",
        },
      };
    }

    if (mergeableState !== "CONFLICTING") {
      return {
        outcome: "skipped",
        reason: { kind: "not-conflicting", mergeableState },
      };
    }

    // Author guard — defensive even though `--author` filters server-side,
    // and the same shape the CI-nudge scan uses (`pr_ci_nudge_scan.ts`): the
    // pass pushes a merge commit to the head branch, so a PR outside the
    // push-capable maintenance set is never touched (Issue #4076). It cannot
    // fire on a listing gh already filtered, so recording it changes no
    // selection — it is what gives the reason a producer.
    const author = prAuthorLogin(pr);
    if (author !== undefined && !isFleetAuthor(author, [...scanAuthors])) {
      return {
        outcome: "skipped",
        reason: { kind: "out-of-scope-author", author },
      };
    }

    // Already handled or deferred by this cycle's drain (Issue #561). The
    // skip is before the label call: the PR was labelled on the pass that
    // selected it.
    if (exclude?.has(conflictPrKey(repo, pr.number))) {
      return { outcome: "skipped", reason: { kind: "already-handled" } };
    }

    let labels: string[];
    try {
      labels = await fetchPrLabels(repo, pr.number, ghCommandFn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Merge-conflict scan: failed to read PR labels", {
        repo,
        prNumber: pr.number,
        error: message,
      });
      return {
        outcome: "skipped",
        reason: { kind: "scan-error", stage: "labels", message },
      };
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
      return {
        outcome: "skipped",
        reason: { kind: "needs-human", label: needsHumanLabel },
      };
    }

    let history: ConflictAttemptHistory;
    try {
      history = parseConflictAttempts(
        await fetchIssueCommentPages(repo, pr.number, ghCommandFn),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Merge-conflict scan: failed to read attempt history", {
        repo,
        prNumber: pr.number,
        error: message,
      });
      return {
        outcome: "skipped",
        reason: { kind: "scan-error", stage: "attempt-history", message },
      };
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
      return {
        outcome: "skipped",
        reason: {
          kind: "budget-spent",
          attemptsSpent: history.count,
          maxAttempts,
        },
      };
    }

    const now = nowMs();
    if (!isConflictAttemptDue(history, now, cooldownHours)) {
      return {
        outcome: "skipped",
        reason: {
          kind: "cooldown",
          msUntilDue: conflictCooldownMsRemaining(history, now, cooldownHours),
          ...(history.lastAttemptAt !== undefined
            ? { lastAttemptAt: history.lastAttemptAt }
            : {}),
        },
      };
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
      return {
        outcome: "skipped",
        reason: {
          kind: "disrupted-bound",
          disruptedCount,
          maxDisruptedAttempts,
        },
      };
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
      outcome: "attempted",
      pr: {
        repo,
        prNumber: pr.number,
        branchName: pr.headRefName,
        // allow-hardcoded-branch — safe fallback when the listing omits it
        baseBranch: pr.baseRefName || "main",
        attemptCount: history.count,
        disruptedCount,
      },
    };
  };

  // Issue #1111: the deferral cursor leads, then the usual (shuffled) order.
  const orderedRepos = orderByPreference(
    shuffleRepos ? shuffleRepos([...repos]) : [...repos],
    (repo) => repo,
    preferredRepos(prefer),
  );
  const decisions: ConflictPrDecision[] = [];
  // Repo-level tallies: the two exits below know no PR to key a decision on,
  // so they are counted for the summary instead of silently dropped.
  let reposScanned = 0;
  let reposNotAllowed = 0;
  let reposListFailed = 0;
  const passContext = () => ({
    reposScanned,
    reposNotAllowed,
    reposListFailed,
  });

  for (const repo of orderedRepos) {
    if (!isRepoAllowed(repo)) {
      reposNotAllowed++;
      continue;
    }

    let prs: PrEntry[];
    try {
      prs = await listOpenPrs(repo, scanAuthors, PR_FIELDS, ghCommandFn, cache);
      reposScanned++;
    } catch (err) {
      reposListFailed++;
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

    const orderedPrs = orderByPreference(
      prs,
      (pr) => conflictPrKey(repo, pr.number),
      prefer,
    );

    for (const pr of orderedPrs) {
      const outcome = await decidePr(repo, pr, states.get(pr.number));
      const decision: ConflictPrDecision = outcome.outcome === "attempted"
        ? { repo, prNumber: pr.number, outcome: "attempted" }
        : {
          repo,
          prNumber: pr.number,
          outcome: "skipped",
          reason: outcome.reason,
        };
      decisions.push(decision);
      recordConflictDecision(logger, decision);

      if (outcome.outcome === "attempted") {
        // The pass ends at its selection, so PRs after it are decided on the
        // next call — the drain makes one per PR it takes, so the queue is
        // still covered without a second listing.
        recordConflictPassSummary(logger, "scan", decisions, passContext());
        return { ok: true, value: { selected: outcome.pr, decisions } };
      }
    }
  }

  recordConflictPassSummary(logger, "scan", decisions, passContext());
  return { ok: true, value: { selected: null, decisions } };
}
