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
 * The pass is bounded by its budget alone (Issue #2305): at most
 * {@link DEFAULT_MAX_CONFLICT_ATTEMPTS} concluded attempts before the ladder
 * stops retrying, and no waiting between them. A conflict a judged attempt
 * could not settle is not settled any better four hours later, and the wait
 * only held a mergeable PR out of the queue for half a day; two hosts are
 * kept off one PR by the cross-host lock, not by a cooldown.
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
import { partitionConflictComments } from "./conflict_marker_trust.ts";
import { listOpenPrs, type PrEntry } from "./pr_maintenance.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  conflictParkedMarker,
  isConflictHeadSha,
  MERGE_CONFLICT_LABEL,
  readParkedBase,
} from "./merge_conflict_markers.ts";
import {
  abandonAndRestart,
  type AbandonRestartOutcome,
  type AbandonRestartRequest,
  exhaustedEscalationRoute,
  MAX_RESTARTS_PER_ISSUE,
  mergeFallbackRunsFromHistory,
  requeueLabelName,
  summariseFailedAttempts,
} from "./conflict_abandon_restart.ts";
import { readPrDivergence } from "./conflict_fallback_context.ts";
import {
  createFallbackFlagFiler,
  MERGE_FALLBACK_LABEL,
  type MergeFallbackFiling,
  type MergeFallbackOutcome,
} from "./merge_fallback_issue.ts";
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

/**
 * The attempt-history markers, re-exported so every existing importer keeps
 * its import path. They live in `merge_conflict_markers.ts` (Issue #1115) so
 * the modules that read them — this scan, the processor, the stall watchdog,
 * the abandon rung — share the vocabulary without importing each other.
 */
export {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  // The park marker rides the same vocabulary (Issue #2312): the scan writes
  // it, the stall watchdog reads it.
  CONFLICT_PARKED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  // The queue label moved beside them (Issue #2310): the fallback context
  // reads its `labeled` event, and this module imports that context, so the
  // label could not stay here without a cycle. Re-exported, so every existing
  // importer keeps its path.
  MERGE_CONFLICT_LABEL,
} from "./merge_conflict_markers.ts";

/**
 * Attempts allowed before the processor stops retrying and escalates.
 *
 * Two (Issue #2305): the first attempt, and one retry against whatever the
 * base has become since. A third judged attempt on the same conflict has
 * never been what settled it — the retries that succeed are the ones whose
 * base moved — so the third run bought little and cost a whole agent run.
 * The milestone ladder charges against this same constant, so the two ladders
 * cannot drift apart. Only a **concluded** attempt spends it; a disrupted one
 * is counted separately by {@link countDisruptedAttempts}.
 *
 * There is no wait between the two: a PR with one concluded failure is due on
 * the very next pass.
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
 * recorded as `out-of-scope-author` rather than assumed away. `baseRefOid`
 * rides it for the same reason (Issue #2312): it is what tells a parked PR
 * apart from one whose base has moved since it was parked.
 */
const PR_FIELDS = "number,headRefName,baseRefName,baseRefOid,author";

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
 * decision checkable afterwards — the attempts a spent budget burned, the
 * disruptions that never concluded, the host holding the lock.
 *
 * Issue #1076's symptom was "the label went on and then silence": a skipped
 * PR produced either nothing or an unstructured log line, so a stalled fleet
 * and a fleet correctly holding a PR back looked identical. A decision
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
   * The budget was spent, so the PR was closed and its originating issue
   * re-queued for a fresh PR off the current base (Issue #1115).
   *
   * `flagIssueNumber` is the `merge-fallback` flag this fallback left behind
   * (Issue #2310), absent only when the filing failed — which is warned about
   * and never stops the close or the re-queue. Where the PR named no
   * originating issue, the flag *is* `issueNumber`: it carries `idle-task` and
   * the PR's diff summary, so the work comes back through it.
   */
  | {
    kind: "abandoned-restarted";
    issueNumber: number;
    attemptsSpent: number;
    flagIssueNumber?: number;
  }
  /**
   * The issue has spent its restarts, so the PR is parked on `merge-conflict`
   * and waits for its base tip to move (Issue #2312).
   *
   * Not an escalation and not a failure: no `needs-human` label, no comment
   * asking anybody for anything, and the queue label stays on. `base` is the
   * base sha the park marker records — the PR is offered again the first pass
   * its live `baseRefOid` differs from it, with a fresh attempt budget counted
   * from the park marker onward. `flagIssueNumber` is the `merge-fallback`
   * flag the park appended this event to, absent when the filing failed.
   */
  | { kind: "parked"; base: string; flagIssueNumber?: number }
  /** Attempts keep being disrupted before they conclude (Issue #395). */
  | {
    kind: "disrupted-bound";
    disruptedCount: number;
    maxDisruptedAttempts: number;
  }
  /** Another host holds the cross-host PR lock. */
  | { kind: "lock-held"; lockHolder: string }
  /**
   * The PR is no longer open, or its live state could not be read at the
   * claim point (Issue #1774). The queue is built from a listing up to ten
   * minutes old; `UNKNOWN` skips this cycle rather than guessing "open",
   * so nothing is written to a PR whose state we could not confirm.
   */
  | { kind: "pr-not-open"; state: "CLOSED" | "MERGED" | "UNKNOWN" }
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
  "abandoned-restarted": true,
  "parked": true,
  "disrupted-bound": true,
  "lock-held": true,
  "pr-not-open": true,
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
    case "abandoned-restarted":
    // Issue #2312: a parked PR keeps the queue label — it is waiting for its
    // base to move, which is a queue entry, not an exit from one.
    case "parked":
    case "disrupted-bound":
    case "lock-held":
    case "pr-not-open":
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
    case "abandoned-restarted":
      return {
        issueNumber: reason.issueNumber,
        attemptsSpent: reason.attemptsSpent,
        ...(reason.flagIssueNumber !== undefined
          ? { flagIssueNumber: reason.flagIssueNumber }
          : {}),
      };
    case "parked":
      return {
        base: reason.base,
        ...(reason.flagIssueNumber !== undefined
          ? { flagIssueNumber: reason.flagIssueNumber }
          : {}),
      };
    case "disrupted-bound":
      return {
        disruptedCount: reason.disruptedCount,
        maxDisruptedAttempts: reason.maxDisruptedAttempts,
      };
    case "lock-held":
      return { lockHolder: reason.lockHolder };
    case "pr-not-open":
      return { state: reason.state };
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
  /** Attempts allowed before the PR is left to a human. */
  maxAttempts?: number;
  /** Disrupted attempts allowed before the PR is escalated (Issue #395). */
  maxDisruptedAttempts?: number;
  /** Label applied on escalation. Defaults to `needs-human`. */
  needsHumanLabel?: string;
  /**
   * Fleet logins whose marker comments count (Issue #1247).
   *
   * Defaults to the pass's own push-capable maintenance set, which is already
   * resolved here — so production is verified without a second definition of
   * "the fleet". An empty set means nothing can be attributed, and every
   * marker is discarded: the PR is then never abandoned, which is the
   * harmless direction for a rung that closes PRs.
   */
  trustedAuthors?: readonly string[];
  /**
   * Abandon-and-restart seam (Issue #1115) — the rung between a spent budget
   * and `needs-human`. Defaults to {@link abandonAndRestart}.
   */
  abandonRestart?: (
    request: AbandonRestartRequest,
  ) => Promise<AbandonRestartOutcome>;
  /**
   * `merge-fallback` flag filer (Issue #2310) — the record every fallback
   * leaves behind. Defaults to {@link fileMergeFallbackIssue}.
   */
  fileFallbackFlag?: (
    filing: MergeFallbackFiling,
  ) => Promise<Result<MergeFallbackOutcome>>;
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
 * **Author-blind by construction, and only safe on a thread that has already
 * been filtered** (Issue #1247). A PR comment is writable by any GitHub
 * account, and the tally this returns drives `abandonRestart`, which *closes*
 * the PR — so two planted `CONFLICT_FAILED_MARKER` comments were enough to
 * destroy a PR before the caller filtered the thread through
 * `partitionConflictComments`. Callers pass the trusted comments only.
 *
 * @param comments - Raw comment objects from the GitHub REST API, oldest
 *   first, already reduced to the fleet's own by
 *   {@link file://./conflict_marker_trust.ts}.
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
 * An open attempt is read as disrupted straight away (Issue #2305): the
 * processor deletes its own marker on every run it cuts short, so a marker
 * that outlives its run is one nobody concluded. What keeps a second host off
 * an attempt genuinely in flight is the cross-host PR lock, not a wait.
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

/*
 * A spent budget used to end at `needs-human` from here, with
 * `buildExhaustedEscalationReason` and `EXHAUSTED_CONFLICT_NEXT_STEP` writing
 * that comment. Both are gone (Issue #2310): no conflict outcome on this path
 * asks a person any more. The budget-spent branch closes the PR, re-queues the
 * work and files the `merge-fallback` flag; a hand-applied `needs-human` is
 * still honoured as a veto (a human who labels a PR owns it), and the
 * disruption bound below is not a conflict outcome and still escalates.
 */

/**
 * Whether another attempt on this PR is due — that is, whether no attempt is
 * open on it (Issue #2305).
 *
 * There is no wait to sit out any more, so the only thing a pass can see that
 * says "not now" is an attempt marker with no conclusion under it. That is a
 * *disrupted* attempt rather than a reason to stop: the scan re-attempts it
 * and {@link DEFAULT_MAX_DISRUPTED_ATTEMPTS} bounds how often.
 *
 * @param history - Attempt history from {@link parseConflictAttempts}.
 */
export function isConflictAttemptDue(
  history: ConflictAttemptHistory,
): boolean {
  return !history.pendingAttempt;
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

/**
 * File the `merge-fallback` flag for a PR this pass just abandoned, and link it
 * from the PR (Issue #2310, part of #2298).
 *
 * The fallback undoes work, and until #2304 it undid it silently: the conflict
 * that caused it lived in a run log nobody reads, so the next attempt started
 * from the same blank page. This is the wiring that makes the PR path leave the
 * record behind — both runs' analyses, their stage timings and hosts, the
 * conflicted files, how far behind the base the head was and since when, and
 * what was closed.
 *
 * **Best-effort, and never silent.** The PR is already closed and the issue
 * already re-queued by the time this runs, so a filing failure is logged at
 * WARN and changes neither. A fallback with no flag is worse than a duplicate
 * flag, and both are better than a close that never happened.
 *
 * The link rides a second comment rather than the abandon comment: that one is
 * posted **before** the close, because it is the claim two hosts race for, so
 * it cannot carry a number that does not exist yet.
 *
 * @returns The flag issue number, or `undefined` when it could not be filed
 */
async function recordConflictFallbackFlag(
  args: ConflictFlagFilingArgs,
): Promise<number | undefined> {
  const { repo, prNumber, ghCommandFn, logger } = args;

  const filed = await fileConflictFallbackFlag(args);
  if (filed === undefined) return undefined;

  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      buildFallbackFlagLinkComment(filed.issueNumber, filed.appended),
    ]);
  } catch (error) {
    logger.warn(
      `PR #${prNumber}: filed flag issue #${filed.issueNumber} but could not ` +
        "link it from the PR",
      {
        repo,
        prNumber,
        issueNumber: filed.issueNumber,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return filed.issueNumber > 0 ? filed.issueNumber : undefined;
}

/** What one `merge-fallback` filing needs to know. */
interface ConflictFlagFilingArgs {
  repo: string;
  prNumber: number;
  branchName: string;
  baseBranch: string;
  /** The PR's thread, already reduced to the fleet's own comments. */
  prComments: readonly unknown[];
  /** What the fallback closed, re-queued or parked, for the flag body. */
  fallbackAction: string;
  trustedAuthors: readonly string[];
  fileFallbackFlag?: (
    filing: MergeFallbackFiling,
  ) => Promise<Result<MergeFallbackOutcome>>;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}

/** What a filing left behind. `issueNumber` may be `<= 0` — see below. */
interface ConflictFlagFiling {
  issueNumber: number;
  appended: boolean;
}

/**
 * File or append the `merge-fallback` flag for one PR. Posts nothing.
 *
 * Split from {@link recordConflictFallbackFlag} (Issue #2312) because the two
 * events that file this flag say different things on the PR afterwards: a
 * fallback links the flag, a park carries the park marker as well, and a PR
 * must not receive two comments for one event.
 *
 * @returns What was filed, or `undefined` when the filing itself failed —
 *   warned about, never thrown, because the caller's decision stands either
 *   way. A filing that succeeded but reported no number returns `issueNumber`
 *   `<= 0` rather than `undefined`: an existing record nothing can link to is
 *   not the same fact as no record at all, and both are said out loud.
 */
async function fileConflictFallbackFlag(
  args: ConflictFlagFilingArgs,
): Promise<ConflictFlagFiling | undefined> {
  const { repo, prNumber, ghCommandFn, logger } = args;
  const history = summariseFailedAttempts(args.prComments);

  const divergence = await readPrDivergence({
    repo,
    prNumber,
    baseBranch: args.baseBranch,
    headBranch: args.branchName,
    queueLabel: MERGE_CONFLICT_LABEL,
    gh: ghCommandFn,
    logger,
  });

  const filer = args.fileFallbackFlag ?? createFallbackFlagFiler({
    gh: ghCommandFn,
    logger,
    fleetAuthors: args.trustedAuthors,
  });

  const filed = await filer({
    target: {
      kind: "pr",
      repo,
      prNumber,
      headBranch: args.branchName,
      baseBranch: args.baseBranch,
    },
    conflictedFiles: history.conflictedPaths,
    runs: mergeFallbackRunsFromHistory(history),
    ...divergence,
    fallbackAction: args.fallbackAction,
  });
  if (!filed.ok) {
    logger.warn(
      `PR #${prNumber} was abandoned but its \`${MERGE_FALLBACK_LABEL}\` flag ` +
        "could not be filed — the close and the re-queue stand, the record " +
        "does not",
      { repo, prNumber, error: filed.error.message },
    );
    return undefined;
  }

  const flagIssueNumber = filed.value.issueNumber;
  if (flagIssueNumber <= 0) {
    // The issue exists — the filer did not fail — but nothing can link to it,
    // and an omitted `flagIssueNumber` would otherwise read exactly like a
    // filing that never happened. Said out loud rather than inferred.
    logger.warn(
      `PR #${prNumber}: its \`${MERGE_FALLBACK_LABEL}\` flag was filed but ` +
        "`gh` reported no issue number, so the record exists and nothing can " +
        "link to it",
      { repo, prNumber, url: filed.value.url },
    );
  }
  return { issueNumber: flagIssueNumber, appended: filed.value.appended };
}

/** The comment that links a closed PR to the flag issue recording its fallback. */
export function buildFallbackFlagLinkComment(
  flagIssueNumber: number,
  appended: boolean,
): string {
  const reference = flagIssueNumber > 0
    ? `#${flagIssueNumber}`
    : "a `merge-fallback` issue whose number could not be read";
  return [
    `🚩 **This fallback is recorded in ${reference}**`,
    "",
    appended
      ? "The flag issue for this PR was already open, so this fallback was " +
        "appended to it — one issue per PR, not one per event."
      : "It carries what both runs found in their own words, their stage " +
        "timings and hosts, the files still conflicted, how far behind the " +
        "base this branch was and since when, and what the fallback closed.",
    "",
    "Nobody is being asked to do anything here: the work is re-queued and " +
    "the flag exists so the same conflict can be seen rather than walked " +
    "into again.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parking (Issue #2312)
// ---------------------------------------------------------------------------

/**
 * The comment that parks a PR on `merge-conflict`, carrying the park marker.
 *
 * One comment, not two: it is both the record a reader needs and the marker
 * every later pass reads back, and a PR must not collect a pair of comments
 * for one event.
 *
 * @param base - The base tip the PR is parked at; the marker's own key.
 * @param flagIssueNumber - The `merge-fallback` flag this event was appended
 *   to, or `undefined` when the filing failed — said out loud rather than
 *   quietly omitted.
 */
export function buildParkedPrComment(args: {
  base: string;
  baseBranch: string;
  issueNumber: number;
  flagIssueNumber?: number;
}): string {
  const flagLine = args.flagIssueNumber !== undefined &&
      args.flagIssueNumber > 0
    ? `This event is recorded in #${args.flagIssueNumber}, the ` +
      `\`${MERGE_FALLBACK_LABEL}\` flag for this PR.`
    : `Its \`${MERGE_FALLBACK_LABEL}\` flag could **not** be filed this pass, ` +
      "so this comment is the only record of the park — the park itself " +
      "stands.";
  return [
    conflictParkedMarker(args.base),
    "⏸️ **Parked on `merge-conflict` until the base moves**",
    "",
    `Issue #${args.issueNumber} has had its ` +
    `${MAX_RESTARTS_PER_ISSUE} restarts: this work has already been closed ` +
    "and redone off the current base twice, and both replacements conflicted " +
    "again. A third redo of the same work against the same base is not a " +
    "different experiment, so this PR is **left open** rather than closed.",
    "",
    `It keeps the \`${MERGE_CONFLICT_LABEL}\` label and stays in the queue, ` +
    `but no further resolution attempt is started while \`${args.baseBranch}\` ` +
    `is still at \`${args.base}\`. The moment that tip moves, this is a ` +
    "genuinely different merge and the fleet attempts it again with a fresh " +
    `${DEFAULT_MAX_CONFLICT_ATTEMPTS}-attempt budget counted from here.`,
    "",
    flagLine,
    "",
    "**Nobody is being asked for anything.** No human-owned label is applied " +
    "and no decision is waited on — merging the base branch in by hand, " +
    "keeping both sides' changes, simply clears it sooner.",
  ].join("\n");
}

/**
 * Park a PR whose issue has spent its restarts (Issue #2312).
 *
 * The event is appended to the PR's own `merge-fallback` flag first — one
 * issue per PR, not one per event — and then said on the PR in a single
 * comment carrying the park marker.
 *
 * **The comment is what makes the park real**, so a comment that could not be
 * posted is not a park: the caller falls back to `budget-spent` and the next
 * pass tries again, rather than reporting a wait nothing recorded.
 *
 * @returns The flag issue number when one was filed, or `undefined`; `null`
 *   when the park comment itself could not be posted.
 */
async function parkConflictingPr(
  args: ConflictFlagFilingArgs & { base: string; issueNumber: number },
): Promise<number | undefined | null> {
  const { repo, prNumber, ghCommandFn, logger } = args;

  const filed = await fileConflictFallbackFlag(args);
  const flagIssueNumber = filed !== undefined && filed.issueNumber > 0
    ? filed.issueNumber
    : undefined;

  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      buildParkedPrComment({
        base: args.base,
        baseBranch: args.baseBranch,
        issueNumber: args.issueNumber,
        ...(flagIssueNumber !== undefined ? { flagIssueNumber } : {}),
      }),
    ]);
  } catch (error) {
    logger.error(
      `PR #${prNumber}: could not post the merge-conflict park marker, so ` +
        "the park is not recorded and the next pass will decide it again",
      {
        repo,
        prNumber,
        base: args.base,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }

  logger.warn(
    `PR #${prNumber} was parked on \`${MERGE_CONFLICT_LABEL}\` — issue ` +
      `#${args.issueNumber} has spent its ${MAX_RESTARTS_PER_ISSUE} restarts, ` +
      `so nothing is attempted until \`${args.baseBranch}\` moves off ` +
      `${args.base}`,
    {
      repo,
      prNumber,
      issueNumber: args.issueNumber,
      base: args.base,
      ...(flagIssueNumber !== undefined ? { flagIssueNumber } : {}),
    },
  );
  return flagIssueNumber;
}

/**
 * The base branch's tip sha for one PR (Issue #2312).
 *
 * Read off the listing where it rides along, and asked for per PR only when it
 * does not — a cached listing written before {@link PR_FIELDS} grew the field
 * has no `baseRefOid`, and a park decided on a missing sha would either wait
 * for ever or never wait at all.
 *
 * @returns The lowercased sha, or `undefined` when it could not be established.
 */
async function resolveBaseRefOid(
  repo: string,
  pr: PrEntry,
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: Logger,
): Promise<string | undefined> {
  const listed = typeof pr.baseRefOid === "string"
    ? pr.baseRefOid.trim().toLowerCase()
    : "";
  if (isConflictHeadSha(listed)) return listed;
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(pr.number),
      "--repo",
      repo,
      "--json",
      "baseRefOid",
      "--jq",
      ".baseRefOid",
    ]);
    const oid = raw.trim().toLowerCase();
    if (isConflictHeadSha(oid)) return oid;
  } catch (error) {
    logger.warn(
      "Merge-conflict scan: could not read the base tip for a PR",
      {
        repo,
        prNumber: pr.number,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
  logger.warn(
    "Merge-conflict scan: GitHub reported no usable base tip for a PR — a " +
      "park cannot be decided against a sha nobody can read",
    { repo, prNumber: pr.number },
  );
  return undefined;
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
 * already carrying `needs-human` or already at its attempt cap is labelled
 * but not returned.
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
    maxAttempts = DEFAULT_MAX_CONFLICT_ATTEMPTS,
    maxDisruptedAttempts = DEFAULT_MAX_DISRUPTED_ATTEMPTS,
    needsHumanLabel = NEEDS_HUMAN_LABEL,
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

  // The same set decides whose marker comments count (Issue #1247): the
  // accounts the fleet actually operates, and nobody else.
  const trustedAuthors = options.trustedAuthors ?? scanAuthors;

  const abandonRestart = options.abandonRestart ??
    ((request: AbandonRestartRequest) =>
      abandonAndRestart(request, {
        gh: ghCommandFn,
        logger,
        trustedAuthors,
        // One filer for both routes (Issue #2310): the rung files the flag
        // itself when the PR names no originating issue, and this pass files
        // it when the issue was re-queued.
        ...(options.fileFallbackFlag !== undefined
          ? { fileFallbackFlag: options.fileFallbackFlag }
          : {}),
      }));

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
    // Kept, not just counted: an abandon quotes what each failed attempt
    // recorded, and this thread is the only place that survives the run
    // (Issue #1115).
    let prComments: readonly unknown[] = [];
    try {
      // The author is checked, not just the marker (Issue #1247). This tally
      // drives `abandonRestart`, which CLOSES the PR, and a PR comment is
      // text any GitHub account may write — so the thread is reduced to the
      // fleet's own before anything counts it. Discarding an unattributable
      // comment lowers the tally, so the failure direction is "not
      // abandoned"; the same filtered thread is what the abandon quotes.
      const thread = await fetchIssueCommentPages(repo, pr.number, ghCommandFn);
      const attribution = partitionConflictComments(thread, trustedAuthors);
      const discarded = thread.length - attribution.trusted.length;
      if (discarded > 0) {
        logger.warn(
          `PR #${pr.number}: ignored ${discarded} comment(s) the fleet did ` +
            "not author — a marker anyone can post must not spend the " +
            "merge-conflict attempt budget",
          {
            repo,
            prNumber: pr.number,
            discarded,
            unattributable: attribution.unattributable,
          },
        );
      }
      prComments = attribution.trusted;
      history = parseConflictAttempts(prComments);
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

    // Issue #2312: a PR parked after its issue spent its restarts waits for
    // one thing only — its base tip moving. Until then it is skipped without
    // an attempt, a label change or a comment; once it moves, the merge is a
    // genuinely different one and the attempt budget is counted from the park
    // marker onward, so the PR gets a full budget rather than inheriting a
    // spent one.
    const park = readParkedBase(prComments);
    if (park !== null) {
      const baseRefOid = await resolveBaseRefOid(
        repo,
        pr,
        ghCommandFn,
        logger,
      );
      if (baseRefOid === undefined || baseRefOid === park.base) {
        // A base tip nobody could read is not evidence that it moved, and
        // acting on it would spend an agent run on the merge that has already
        // failed four times. The unreadable case is warned about in
        // `resolveBaseRefOid`.
        return {
          outcome: "skipped",
          reason: { kind: "parked", base: park.base },
        };
      }
      logger.info(
        `PR #${pr.number} was parked at ${park.base} and its base has ` +
          `moved to ${baseRefOid} — attempting it again`,
        { repo, prNumber: pr.number, parkedBase: park.base, baseRefOid },
      );
      prComments = prComments.slice(park.index + 1);
      history = parseConflictAttempts(prComments);
    }

    // A spent budget reaching here means the conclusion the processor should
    // have drawn never landed (Issue #395): the label check above let the PR
    // through, so nobody owns it and it would stall unowned for ever.
    if (hasExhaustedConflictAttempts(history.count, maxAttempts)) {
      // Issue #1115: a human is not the next rung. A branch that has defeated
      // two concluded merges is usually cheaper to redo than to reconcile, so
      // the PR is closed, its issue re-queued for a fresh PR off the current
      // base, and the fallback flagged (Issue #2310). Where the rung declines
      // or fails, the PR keeps its place and the reason is recorded — nobody
      // is asked either way.
      const abandon = await abandonRestart({
        repo,
        prNumber: pr.number,
        branchName: pr.headRefName,
        // allow-hardcoded-branch — safe fallback when the listing omits it
        baseBranch: pr.baseRefName || "main",
        prComments,
      });

      if (abandon.outcome === "abandoned") {
        // Issue #2277: the issue keeps whatever pickup label it carried, or
        // gains `idle-task` — either way it is re-queued without a human.
        const label = requeueLabelName(abandon.label);
        logger.warn(
          `PR #${pr.number} spent its ${maxAttempts} merge-conflict ` +
            `attempts — closed it and re-queued issue ` +
            `#${abandon.issueNumber} (\`${label}\`)`,
          {
            repo,
            prNumber: pr.number,
            issueNumber: abandon.issueNumber,
            attempts: history.count,
            maxAttempts,
            label,
          },
        );
        // Issue #2310: the fallback leaves one record behind. A PR that named
        // no originating issue was closed against a flag the rung filed
        // itself, which is also the issue the work comes back through — a
        // second flag would split one event across two issues.
        const flagIssueNumber = abandon.flagIssueNumber ??
          await recordConflictFallbackFlag({
            repo,
            prNumber: pr.number,
            branchName: pr.headRefName,
            // allow-hardcoded-branch — safe fallback when the listing omits it
            baseBranch: pr.baseRefName || "main",
            prComments,
            fallbackAction: `Closed ${repo}#${pr.number} ` +
              `(\`${pr.headRefName}\`) and re-queued issue ` +
              `#${abandon.issueNumber} (\`${label}\`) so the work is redone ` +
              "off the current base. The branch was neither deleted nor " +
              "force-pushed.",
            trustedAuthors,
            ...(options.fileFallbackFlag !== undefined
              ? { fileFallbackFlag: options.fileFallbackFlag }
              : {}),
            ghCommandFn,
            logger,
          });
        return {
          outcome: "skipped",
          reason: {
            kind: "abandoned-restarted",
            issueNumber: abandon.issueNumber,
            attemptsSpent: history.count,
            ...(flagIssueNumber !== undefined ? { flagIssueNumber } : {}),
          },
        };
      }

      // Issue #2312: the issue has spent its restarts, so this PR is parked
      // rather than closed — it keeps `merge-conflict`, carries a park marker
      // naming the base tip it is waiting on, and is offered again the first
      // pass that tip moves. No `needs-human`, no comment asking anybody for
      // anything: the fleet is waiting on a base branch, not on a person.
      if (
        abandon.outcome === "declined" &&
        abandon.reason.kind === "already-restarted"
      ) {
        const base = await resolveBaseRefOid(repo, pr, ghCommandFn, logger);
        if (base !== undefined) {
          const parked = await parkConflictingPr({
            repo,
            prNumber: pr.number,
            branchName: pr.headRefName,
            // allow-hardcoded-branch — safe fallback when the listing omits it
            baseBranch: pr.baseRefName || "main",
            prComments,
            base,
            issueNumber: abandon.reason.issueNumber,
            fallbackAction: `Left ${repo}#${pr.number} ` +
              `(\`${pr.headRefName}\`) open on \`${MERGE_CONFLICT_LABEL}\`. ` +
              `Issue #${abandon.reason.issueNumber} has spent its ` +
              `${MAX_RESTARTS_PER_ISSUE} restarts, so the PR is parked at ` +
              `base \`${base}\` and re-attempted only when that tip moves.`,
            trustedAuthors,
            ...(options.fileFallbackFlag !== undefined
              ? { fileFallbackFlag: options.fileFallbackFlag }
              : {}),
            ghCommandFn,
            logger,
          });
          // `null` means the marker could not be posted, so nothing records
          // the park — it falls through to `budget-spent` and the next pass
          // decides it again, rather than claiming a wait nobody can read.
          if (parked !== null) {
            return {
              outcome: "skipped",
              reason: {
                kind: "parked",
                base,
                ...(parked !== undefined ? { flagIssueNumber: parked } : {}),
              },
            };
          }
        }
      }

      // Issue #2310: no `needs-human` from here any more. The rung declined or
      // failed, so the PR keeps its place in the queue and the reason is said
      // out loud in the log; what happens to a PR the rung will not abandon
      // twice is the next rung's business, not a person's.
      const route = exhaustedEscalationRoute(abandon);
      logger.warn(
        `PR #${pr.number} has spent its ${maxAttempts} merge-conflict ` +
          `attempts and was not restarted (${route.kind}) — left open, no ` +
          "human asked",
        {
          repo,
          prNumber: pr.number,
          attempts: history.count,
          maxAttempts,
          route: route.kind,
          ...(route.kind === "abandon-failed" ? { step: route.step } : {}),
        },
      );
      return {
        outcome: "skipped",
        reason: {
          kind: "budget-spent",
          attemptsSpent: history.count,
          maxAttempts,
        },
      };
    }

    // An attempt that never concluded is a disrupted attempt, not one in
    // flight (Issue #395) — there is no cooldown left to wait out before
    // saying so (Issue #2305), and the cross-host PR lock is what keeps two
    // hosts off one PR. It does not spend the merge budget, but repeated
    // disruption is its own failure and is escalated rather than retried
    // silently forever.
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

    // An open marker is the one thing that makes a PR "not due" now
    // (Issue #2305), and it is re-attempted rather than waited out — so the
    // record says which of the disruptions is that one.
    const attemptOpen = !isConflictAttemptDue(history);
    if (disruptedCount > 0) {
      logger.warn(
        `PR #${pr.number} has ${disruptedCount} disrupted merge-conflict ` +
          "attempt(s) with no conclusion — re-attempting" +
          (attemptOpen ? ", including one whose marker is still open" : ""),
        {
          repo,
          prNumber: pr.number,
          disruptedCount,
          maxDisruptedAttempts,
          attemptOpen,
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
