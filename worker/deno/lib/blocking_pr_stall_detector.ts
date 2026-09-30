/**
 * Stall watchdog for PRs that block queued `work-on` issues (Issue #4025).
 *
 * `handler_watchdog.ts`, `stale_workflow_detector.ts` and
 * `purge_stale_workflow_issues.ts` all watch worker-**internal** execution.
 * Nothing watched the externally-visible state of a PR that owns a work
 * stream, so private-repo-21 PR #103 sat red — with an unanswered
 * authorised comment — for ~13 hours while two `work-on` issues deferred to
 * it and no host noticed.
 *
 * This module is the backstop for that class of silent deadlock. Per scan
 * iteration it looks at every open PR that `getBlockingPRForIssue()` says is
 * blocking at least one open `work-on` issue and asks whether the PR has
 * stopped making progress:
 *
 * - **red CI** — a failing check whose run has not been superseded by a
 *   newer fleet push, older than the configured threshold;
 * - **unanswered authorised comment** — the newest comment from an
 *   `authorized_commenters` login is newer than the newest fleet reply or
 *   push, by longer than the threshold; or
 * - **green but unmerged** (Issue #1082) — genuinely green (at least one
 *   check ran, none failing, none still running), not a draft, no auto-merge
 *   armed, and no movement for longer than the threshold. Nothing is wrong
 *   with the PR; it simply is not landing, and the repository's whole work
 *   stream is stopped behind it.
 *
 * A red or unanswered PR is returned to the caller and never escalated
 * (Issue #2802): no issue is filed and no `escalated` label is applied. The
 * stall-repair pass (`stall_repair.ts`) owns what happens next — sync the
 * branch and rerun the owning lane once, then abandon the PR and redo its
 * originating issue if it is still stalled at the next check.
 *
 * A green PR is never a stall and never escalated (Issue #2801). It is handed
 * to the worker's own merge path, `directMergePr`, whose approval gate splits
 * it: a PR that only lacks approval is **awaiting approval** and left alone;
 * any other green PR is **mergeable** and merged. A merge refused for any
 * other reason is logged loudly and retried next cycle — a green PR is never
 * closed or abandoned. A repository with `skip_auto_merge` never reaches the
 * merge path: its green PR is awaiting a manual merge and left alone.
 *
 * It also stays out of the merge-conflict ladder's way (Issue #1213). A
 * `CONFLICTING` PR — or one carrying `merge-conflict` — is never reported as
 * green-but-unmerged, any escalation it does carry names the ladder instead of
 * offering "or close it", and a live escalation is withdrawn once the ladder
 * takes the PR. NEAT-AI-Ockham#119 was closed by hand thirteen minutes after
 * this watchdog listed that option, before the ladder's first attempt ever
 * ran.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger, Result, WorkerConfig } from "../types.ts";
import { directMergePr, type MergeResult } from "./direct_merge.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import type { IssueCache } from "./issue_cache.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import {
  fetchIssuesByLabel,
  fetchOpenPRsForFleet,
  getBlockingPRForIssue,
  resolveFleetPrSlots,
} from "./issue_query.ts";
import { buildDedupMarker } from "./needs_human_escalation.ts";
import { MERGE_CONFLICT_LABEL } from "./pr_merge_conflict_scan.ts";
import { getRepoConfig } from "./repo_config.ts";

/** Default stall threshold: 2 hours (Issue #4025). */
export const DEFAULT_BLOCKING_PR_STALL_THRESHOLD_SECONDS = 7200;

/**
 * Marker prefix written by the auto-fix attempt cap escalation
 * (`pr_ci_processor.ts` passes `dedupKey: auto-fix-cap:<signature>` to
 * `escalateToHuman`). The signature is not knowable here, so the watchdog
 * matches on the prefix. `blocking_pr_stall_detector_test.ts` asserts this
 * constant still prefixes `buildDedupMarker("auto-fix-cap:<sig>")`, so the
 * two cannot drift apart silently.
 */
export const AUTO_FIX_CAP_MARKER_PREFIX =
  "<!-- needs-human-escalation: auto-fix-cap:";

/**
 * Prefix of the hidden trip marker the stall-repair pass posts on a PR
 * (Issue #2802). Defined here, not in `stall_repair.ts`, because the detector
 * must not read that marker as a fleet reply.
 */
export const STALL_REPAIR_MARKER_PREFIX = "<!-- vibe-stall-repair";

/** Check conclusions that count as a red build. */
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "ERROR",
]);

/**
 * Why a blocking PR is considered stalled.
 *
 * `unmerged-green` is the third shape (Issue #1082): nothing is *wrong* with
 * the PR — CI is green and no comment is outstanding — it simply is not
 * landing, and while it does not land its repository's whole work stream is
 * stopped. `GRQ-GTC#305` sat exactly like that for five days and no host
 * said a word about it, because the two signals above both looked healthy.
 * Since Issue #2801 the scan never escalates it: the PR is handed to the merge
 * path instead (see {@link resolveGreenBlockingPr}).
 */
export type BlockingPrStallReason =
  | "red-ci"
  | "unanswered-comment"
  | "unmerged-green";

/** A failing check observed on a blocking PR. */
export interface FailingCheck {
  /** Check name as reported by GitHub. */
  name: string;
  /** ISO timestamp the failing run completed. */
  completedAt: string;
}

/** The externally-visible facts about one blocking PR. */
export interface BlockingPrObservation {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Open `work-on` issues this PR blocks. Empty means the PR is out of scope. */
  blockedIssues: number[];
  /** Failing checks on the head commit. */
  failingChecks: FailingCheck[];
  /** ISO timestamp of the newest fleet push (head commit). */
  lastFleetPushAt?: string;
  /** ISO timestamp of the newest comment from an authorised commenter. */
  lastAuthorisedCommentAt?: string;
  /**
   * ISO timestamp of the newest comment from a fleet account — excluding the
   * stall-repair trip marker, which is not a reply (Issue #2802).
   */
  lastFleetReplyAt?: string;
  /** ISO timestamp of the newest fleet stall-repair trip marker (Issue #2802). */
  lastStallRepairAt?: string;
  /** ISO timestamp the PR was opened (Issue #1082). */
  createdAt?: string;
  /** True when GitHub's native auto-merge is armed on the PR (Issue #1082). */
  autoMergeEnabled?: boolean;
  /** True when the PR is a draft (Issue #1082) — not waiting on anyone. */
  isDraft?: boolean;
  /**
   * Checks on the head commit, by state (Issue #1082). "Green" means at
   * least one check ran and none is failing or still running — "not red" is
   * not green, and a head with no checks at all is unverified, which this
   * repo refuses to call passed (`docs/MERGE.md`, Issue #3705).
   */
  checkCounts?: { total: number; pending: number };
  /**
   * GitHub's mergeable state (Issue #1213) — `MERGEABLE`, `CONFLICTING`,
   * `UNKNOWN`. A `CONFLICTING` PR belongs to the merge-conflict ladder, not
   * to this watchdog's green lane.
   */
  mergeable?: string;
  /**
   * Labels on the PR (Issue #1213). `merge-conflict` is the ladder's visible
   * queue marker, so it names the lane that owns the PR.
   */
  labels?: readonly string[];
  /** PR author login (Issue #2802) — only a worker's own PR is repaired. */
  author?: string;
  /** Head branch (Issue #2802) — synced and named when the PR is abandoned. */
  headRefName?: string;
  /** Base branch (Issue #2802) — the target the head is synced with. */
  baseRefName?: string;
}

/** One tripped staleness signal. */
export interface BlockingPrStallSignal {
  /** Which signal tripped. */
  reason: BlockingPrStallReason;
  /** How long the PR has been stalled on this signal, in seconds. */
  stalledSeconds: number;
  /**
   * Epoch seconds this stall began: the newest failing run for `red-ci`, the
   * authorised comment for `unanswered-comment`, the newest push (or the PR's
   * opening) for `unmerged-green`. Stall repair uses it to tell a trip marker
   * taken on this stall from one left by an earlier, resolved one (Issue
   * #2802).
   */
  onsetAt: number;
  /** Human-readable explanation quoted in the stall-repair comments. */
  detail: string;
}

/** A blocking PR that has stopped making progress. */
export interface BlockingPrStall {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Open `work-on` issues this PR blocks. */
  blockedIssues: number[];
  /** Every signal that tripped, in detection order. */
  signals: BlockingPrStallSignal[];
  /**
   * True when the merge-conflict ladder owns this PR (Issue #1213). Stall
   * repair then leaves it to the ladder — closing is the ladder's own rung 3,
   * taken after its attempts fail (Issue #2802).
   */
  mergeConflictLaneOwned?: boolean;
  /** PR author login, when observed (Issue #2802). */
  author?: string;
  /** Head branch, when observed (Issue #2802). */
  headRefName?: string;
  /** Base branch, when observed (Issue #2802). */
  baseRefName?: string;
  /**
   * Labels on the PR, when observed (PR #2866 review). A hand-applied or
   * lane-applied `needs-human` here is a veto stall repair never overrides.
   */
  labels?: readonly string[];
}

/**
 * Whether the merge-conflict ladder owns this PR (Issue #1213).
 *
 * Either signal is enough: GitHub reporting `CONFLICTING`, or the ladder's own
 * `merge-conflict` queue label. The two are applied minutes apart — the label
 * follows the scan that observed the conflict — so reading only one leaves a
 * window in which the watchdog still treats a laddered PR as its own.
 */
export function isMergeConflictLaneOwned(
  observation: Pick<BlockingPrObservation, "mergeable" | "labels">,
): boolean {
  if ((observation.mergeable ?? "").trim().toUpperCase() === "CONFLICTING") {
    return true;
  }
  return (observation.labels ?? []).some(
    (label) =>
      typeof label === "string" &&
      label.trim().toLowerCase() === MERGE_CONFLICT_LABEL,
  );
}

// ---------------------------------------------------------------------------
// Threshold resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective stall threshold for a repository.
 *
 * Mirrors `resolveMaxAutoFixAttempts` in `auto_fix_attempt_tracker.ts`:
 * per-repo override wins over the global setting, and any non-integer or
 * non-positive value (config arrives untrusted from `.config.json`) falls
 * back — an invalid global to
 * {@link DEFAULT_BLOCKING_PR_STALL_THRESHOLD_SECONDS}.
 */
export function resolveBlockingPrStallThresholdSeconds(
  config: Pick<
    WorkerConfig,
    "blockingPrStallThresholdSeconds" | "repoConfig"
  >,
  repo: string,
): number {
  const globalValue = positiveIntegerOr(
    config.blockingPrStallThresholdSeconds,
    DEFAULT_BLOCKING_PR_STALL_THRESHOLD_SECONDS,
  );
  const override = config.repoConfig?.[repo]?.blockingPrStallThresholdSeconds;
  return positiveIntegerOr(override, globalValue);
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Detection (pure)
// ---------------------------------------------------------------------------

/** Options for {@link detectBlockingPrStall}. */
export interface DetectBlockingPrStallOptions {
  /** Seconds of no progress before a signal trips. */
  thresholdSeconds: number;
  /** Current time, epoch seconds. */
  nowSeconds: number;
}

/**
 * Decide whether a blocking PR has stalled.
 *
 * Returns `null` when the PR blocks no `work-on` issue (this watchdog is
 * about unblocking queued work, not auditing every open PR) or when no
 * signal has been stale for longer than the threshold.
 */
export function detectBlockingPrStall(
  observation: BlockingPrObservation,
  opts: DetectBlockingPrStallOptions,
): BlockingPrStall | null {
  if (observation.blockedIssues.length === 0) return null;

  const { thresholdSeconds, nowSeconds } = opts;
  const signals: BlockingPrStallSignal[] = [];
  const pushAt = epochSeconds(observation.lastFleetPushAt);

  // -- Red CI ------------------------------------------------------------
  const newestFailure = observation.failingChecks
    .map((check) => epochSeconds(check.completedAt))
    .filter((epoch): epoch is number => epoch !== undefined)
    .reduce<number | undefined>(
      (max, epoch) => (max === undefined || epoch > max ? epoch : max),
      undefined,
    );

  if (newestFailure !== undefined) {
    // A push newer than the failing run means CI is re-running against new
    // code — that is progress, not a stall.
    const superseded = pushAt !== undefined && pushAt > newestFailure;
    const stalledSeconds = nowSeconds - newestFailure;
    if (!superseded && stalledSeconds >= thresholdSeconds) {
      const names = observation.failingChecks
        .map((check) => check.name)
        .filter((name) => name.length > 0);
      signals.push({
        reason: "red-ci",
        stalledSeconds,
        onsetAt: newestFailure,
        detail: `checks failing for ${
          formatDuration(stalledSeconds)
        } with no new push${names.length > 0 ? ` (${names.join(", ")})` : ""}`,
      });
    }
  }

  // -- Unanswered authorised comment -------------------------------------
  const commentAt = epochSeconds(observation.lastAuthorisedCommentAt);
  if (commentAt !== undefined) {
    const replyAt = epochSeconds(observation.lastFleetReplyAt);
    // Issue #2802: once stall repair has tripped on this comment, its own
    // sync push is not an answer — only a real fleet reply is. Otherwise the
    // repair would clear the stall it is meant to settle.
    const tripAt = epochSeconds(observation.lastStallRepairAt);
    const repairedSince = tripAt !== undefined && tripAt >= commentAt;
    const answeredAt = repairedSince ? replyAt : maxDefined(replyAt, pushAt);
    const answered = answeredAt !== undefined && answeredAt >= commentAt;
    const stalledSeconds = nowSeconds - commentAt;
    if (!answered && stalledSeconds >= thresholdSeconds) {
      signals.push({
        reason: "unanswered-comment",
        stalledSeconds,
        onsetAt: commentAt,
        detail: `an authorised comment has gone unanswered for ${
          formatDuration(stalledSeconds)
        } — no fleet reply and no push since`,
      });
    }
  }

  // -- Green but not landing (Issue #1082) --------------------------------
  // Only when nothing else has tripped: a red or unanswered PR is already
  // being reported, and a second reason for the same PR would be noise.
  //
  // A PR the merge-conflict ladder owns is never green-but-unmerged (Issue
  // #1213): it is not landing because it conflicts, which is a lane with its
  // own attempts and its own abandon rung. NEAT-AI-Ockham#119 was reported
  // here as "green and unmerged … or close it" and a human closed it before
  // the ladder's first attempt ever ran.
  const laneOwned = isMergeConflictLaneOwned(observation);
  if (
    signals.length === 0 && !laneOwned && isGreen(observation) &&
    observation.autoMergeEnabled !== true && observation.isDraft !== true
  ) {
    const since = maxDefined(pushAt, epochSeconds(observation.createdAt));
    const stalledSeconds = since === undefined ? undefined : nowSeconds - since;
    if (
      since !== undefined && stalledSeconds !== undefined &&
      stalledSeconds >= thresholdSeconds
    ) {
      signals.push({
        reason: "unmerged-green",
        stalledSeconds,
        onsetAt: since,
        detail: `been open and green for ${
          formatDuration(stalledSeconds)
        } with no auto-merge armed and no merge`,
      });
    }
  }

  if (signals.length === 0) return null;
  return {
    repo: observation.repo,
    prNumber: observation.prNumber,
    blockedIssues: [...observation.blockedIssues],
    signals,
    mergeConflictLaneOwned: laneOwned,
    ...(observation.author !== undefined ? { author: observation.author } : {}),
    ...(observation.headRefName !== undefined
      ? { headRefName: observation.headRefName }
      : {}),
    ...(observation.baseRefName !== undefined
      ? { baseRefName: observation.baseRefName }
      : {}),
    ...(observation.labels !== undefined ? { labels: observation.labels } : {}),
  };
}

/**
 * Whether the head is genuinely green: at least one check ran, none failed,
 * and none is still running. Absent counts mean the checks were not read, so
 * the answer is no — the watchdog says nothing rather than calling an
 * unverified head green.
 */
function isGreen(observation: BlockingPrObservation): boolean {
  if (observation.failingChecks.length > 0) return false;
  const counts = observation.checkCounts;
  if (!counts) return false;
  return counts.total > 0 && counts.pending === 0;
}

/**
 * Dedup key of the retired stall escalation (Issue #2802). Still read so a
 * live escalation on an old thread can be withdrawn (Issue #1213).
 */
export function blockingPrStallDedupKey(
  reason: BlockingPrStallReason,
): string {
  return `blocking-pr-stall:${reason}`;
}

/** HTML marker that dedups the escalation comment for one stall reason. */
export function blockingPrStallMarker(reason: BlockingPrStallReason): string {
  return buildDedupMarker(blockingPrStallDedupKey(reason));
}

/** Explain one tripped signal — quoted in the stall-repair comments. */
export function buildBlockingPrStallReason(
  stall: BlockingPrStall,
  signal: BlockingPrStallSignal,
): string {
  const count = stall.blockedIssues.length;
  const issues = stall.blockedIssues.map((issue) => `#${issue}`).join(", ");
  const plural = count === 1 ? "" : "s";
  return (
    `${stall.repo}#${stall.prNumber} has ${signal.detail}, and it is ` +
    `blocking ${count} \`work-on\` issue${plural} (${issues}) from being ` +
    `picked up. The worker defers ${
      plural === "" ? "that issue" : "those issues"
    } to this PR, so the work stream is stopped until the PR moves.`
  );
}

/**
 * Next step for a PR the merge-conflict ladder owns (Issue #1213).
 *
 * The ladder resolves, then rebases, then abandons and restarts — closing is
 * its rung 3, taken after its own attempts fail, not an option to put in front
 * of a human at minute zero. A hand close before those attempts run skips
 * every rung and the work is redone from scratch, which is what happened to
 * NEAT-AI-Ockham#119.
 *
 * The actionable verbs stay: the ladder rebases a conflict, it does not fix red
 * CI or answer a comment. Only the close comes off the menu, and the wording
 * names the conflict rather than the `merge-conflict` label, which is applied a
 * scan later than GitHub reports `CONFLICTING`.
 */
export const MERGE_CONFLICT_LANE_NEXT_STEP =
  "Push a fix or reply to the outstanding comment if you can, but leave this " +
  "PR open: it is in the merge-conflict lane, so the merge-conflict ladder " +
  "owns whether it is resolved, rebased or retired. Retiring it by hand skips " +
  "the ladder's attempts and the work has to be redone from scratch.";

// ---------------------------------------------------------------------------
// Withdrawal (Issue #1213)
// ---------------------------------------------------------------------------

/** Marker that dedups the retraction comment for one PR. */
export const BLOCKING_PR_STALL_WITHDRAWAL_MARKER =
  "<!-- blocking-pr-stall-withdrawn -->";

/** Dependencies for {@link withdrawBlockingPrStallEscalation}. */
export interface WithdrawBlockingPrStallDeps {
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Logger. */
  logger: Logger;
}

/** Outcome of {@link withdrawBlockingPrStallEscalation}. */
export interface WithdrawBlockingPrStallOutcome {
  /** Stall reasons whose live escalation this call retracted. */
  withdrawnReasons: BlockingPrStallReason[];
}

/** Body of the retraction comment. */
export function buildBlockingPrStallWithdrawalBody(params: {
  repo: string;
  prNumber: number;
  reasons: readonly BlockingPrStallReason[];
}): string {
  const withdrawn = params.reasons
    .map((reason) => `\`${reason}\``)
    .join(", ");
  // Only the parts the lane invalidates are withdrawn: the close, always, and
  // the green claim when `unmerged-green` was the reason. Red CI and an
  // unanswered comment are still true of a conflicting PR.
  const greenWithdrawn = params.reasons.includes("unmerged-green")
    ? " It also called the PR green and unmerged, which a conflicting PR is not."
    : "";
  return [
    "## Blocking-PR stall escalation withdrawn",
    "",
    `**Why:** ${params.repo}#${params.prNumber} is in the merge-conflict ` +
    `lane, so the merge-conflict ladder owns it. The earlier blocking-PR ` +
    `stall escalation on this thread (${withdrawn}) offered closing the PR as ` +
    "a next step; that is the ladder's own decision, taken after its attempts " +
    `fail, not one to take by hand.${greenWithdrawn}`,
    "",
    `**Next step:** ${MERGE_CONFLICT_LANE_NEXT_STEP}`,
    "",
    BLOCKING_PR_STALL_WITHDRAWAL_MARKER,
  ].join("\n");
}

/**
 * Retract a live stall escalation once the merge-conflict ladder takes the PR.
 *
 * The escalation is posted once and deduped for ever after, so without this an
 * instruction outlives the condition that produced it: NEAT-AI-Ockham#119 was
 * told "green and unmerged … or close it" three minutes before it entered the
 * lane, and was closed by hand ten minutes after that. One retraction comment
 * per PR, itself deduped by {@link BLOCKING_PR_STALL_WITHDRAWAL_MARKER}, so a
 * PR that sits in the lane for days is not commented on every iteration.
 *
 * Silent no-op when the ladder does not own the PR or no escalation is live.
 */
export async function withdrawBlockingPrStallEscalation(
  observation: BlockingPrObservation,
  deps: WithdrawBlockingPrStallDeps,
): Promise<Result<WithdrawBlockingPrStallOutcome>> {
  const none: WithdrawBlockingPrStallOutcome = { withdrawnReasons: [] };
  if (!isMergeConflictLaneOwned(observation)) return { ok: true, value: none };

  let bodies: string[];
  try {
    bodies = await fetchCommentBodies(
      observation.repo,
      observation.prNumber,
      deps.ghCommandFn,
    );
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `blocking-PR stall watchdog: could not read comments on ${observation.repo}#${observation.prNumber} to withdraw its escalation: ${
          errorMessage(err)
        }`,
      ),
    };
  }

  const contains = (needle: string) =>
    bodies.some((body) => body.includes(needle));
  if (contains(BLOCKING_PR_STALL_WITHDRAWAL_MARKER)) {
    return { ok: true, value: none };
  }

  const reasons: BlockingPrStallReason[] = (
    ["red-ci", "unanswered-comment", "unmerged-green"] as const
  ).filter((reason) => contains(blockingPrStallMarker(reason)));
  if (reasons.length === 0) return { ok: true, value: none };

  const ghClient = createGhEscalationClient(deps.ghCommandFn);
  try {
    await ghClient.postComment(
      observation.repo,
      observation.prNumber,
      buildBlockingPrStallWithdrawalBody({
        repo: observation.repo,
        prNumber: observation.prNumber,
        reasons,
      }),
    );
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `blocking-PR stall watchdog: could not withdraw the escalation on ${observation.repo}#${observation.prNumber}: ${
          errorMessage(err)
        }`,
      ),
    };
  }

  deps.logger.info(
    "Blocking-PR stall escalation withdrawn — the merge-conflict ladder owns this PR",
    {
      repo: observation.repo,
      pr: observation.prNumber,
      reasons: reasons.join(", "),
    },
  );
  return { ok: true, value: { withdrawnReasons: reasons } };
}

/** Read every comment body on a PR thread, bounded by the page cap. */
async function fetchCommentBodies(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string[]> {
  const comments = await fetchIssueCommentPages(repo, prNumber, ghCommandFn);
  const bodies: string[] = [];
  for (const comment of comments) {
    if (typeof comment !== "object" || comment === null) continue;
    const body = (comment as Record<string, unknown>).body;
    if (typeof body === "string") bodies.push(body);
  }
  return bodies;
}

// ---------------------------------------------------------------------------
// Observation gathering
// ---------------------------------------------------------------------------

/** Options for {@link findBlockingPrObservations}. */
export interface FindBlockingPrObservationsOptions {
  /** Monitored repos in `owner/repo` format. */
  repos: readonly string[];
  /** Label marking queued work — typically `config.workOnLabel`. */
  workOnLabel: string;
  /** Fleet logins from `resolveFleetAuthors()`. */
  fleetAuthors: readonly string[];
  /**
   * Push-capable fleet logins (`resolveFleetMaintenanceAuthorSet()`).
   * Only these accounts' open PRs can block a `work-on` issue, so only
   * they can stall one (Issue #4133). Omitted or empty keeps the
   * fail-safe: an unclassifiable PR still counts as a blocker.
   */
  pushCapableAuthors?: readonly string[];
  /**
   * The repo's fleet PR cap on the default-branch stream (Issue #2663) —
   * one fleet PR per slot, so a `work-on` issue is held (and its PRs can
   * stall it) only at the cap. Omitted → `DEFAULT_FLEET_PR_SLOTS`.
   */
  fleetPrSlotsFor?: (repo: string) => number;
  /** Configured `authorized_commenters` logins. */
  authorisedCommenters: readonly string[];
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /**
   * Iteration-scoped issue cache. Passing the shared cache lets the
   * watchdog reuse the `issues_all` / `prs_${author}` entries other
   * priorities already fetched, so it adds no `gh` calls of its own
   * beyond one `gh pr view` per blocking PR.
   */
  cache?: IssueCache;
  /** Optional logger. */
  log?: (message: string) => void;
}

/**
 * Gather one observation per open PR that blocks at least one open
 * `work-on` issue.
 *
 * Best-effort per repo: a repo whose issue or PR listing fails is logged
 * and skipped rather than failing the whole scan — the watchdog must never
 * be the reason the loop stops.
 */
export async function findBlockingPrObservations(
  opts: FindBlockingPrObservationsOptions,
): Promise<BlockingPrObservation[]> {
  const {
    repos,
    workOnLabel,
    fleetAuthors,
    authorisedCommenters,
    ghCommandFn,
    log,
  } = opts;

  const observations: BlockingPrObservation[] = [];

  for (const repo of repos) {
    let blockedByPr: Map<number, number[]>;
    try {
      blockedByPr = await mapBlockedWorkOnIssues(
        repo,
        workOnLabel,
        fleetAuthors,
        opts.pushCapableAuthors ?? [],
        ghCommandFn,
        opts.cache,
        opts.fleetPrSlotsFor?.(repo),
      );
    } catch (err) {
      log?.(
        `[blocking-pr-stall] ${repo}: blocking scan failed: ${
          errorMessage(err)
        }`,
      );
      continue;
    }

    for (const [prNumber, blockedIssues] of blockedByPr) {
      try {
        observations.push(
          await observeBlockingPr({
            repo,
            prNumber,
            blockedIssues,
            fleetAuthors,
            authorisedCommenters,
            ghCommandFn,
          }),
        );
      } catch (err) {
        log?.(
          `[blocking-pr-stall] ${repo}#${prNumber}: observation failed: ${
            errorMessage(err)
          }`,
        );
      }
    }
  }

  return observations;
}

/** Map each blocking PR to the open `work-on` issues deferring to it. */
async function mapBlockedWorkOnIssues(
  repo: string,
  workOnLabel: string,
  fleetAuthors: readonly string[],
  pushCapableAuthors: readonly string[],
  ghCommandFn: (args: string[]) => Promise<string>,
  cache?: IssueCache,
  fleetPrSlots?: number,
): Promise<Map<number, number[]>> {
  const blockedByPr = new Map<number, number[]>();

  const issues = await fetchIssuesByLabel(
    repo,
    workOnLabel,
    cache,
    50,
    ghCommandFn,
  );
  if (issues.length === 0) return blockedByPr;

  const prs = await fetchOpenPRsForFleet(
    repo,
    [...fleetAuthors],
    cache,
    ghCommandFn,
  );
  if (prs.length === 0) return blockedByPr;

  for (const issue of issues) {
    const blocking = getBlockingPRForIssue(
      prs,
      issue.milestone ?? "",
      pushCapableAuthors,
      fleetPrSlots,
      issue.number,
    );
    if (!blocking) continue;
    const existing = blockedByPr.get(blocking.number);
    if (existing) existing.push(issue.number);
    else blockedByPr.set(blocking.number, [issue.number]);
  }

  return blockedByPr;
}

/** Fetch the externally-visible state of one blocking PR. */
async function observeBlockingPr(params: {
  repo: string;
  prNumber: number;
  blockedIssues: number[];
  fleetAuthors: readonly string[];
  authorisedCommenters: readonly string[];
  ghCommandFn: (args: string[]) => Promise<string>;
}): Promise<BlockingPrObservation> {
  const {
    repo,
    prNumber,
    blockedIssues,
    fleetAuthors,
    authorisedCommenters,
    ghCommandFn,
  } = params;

  const raw = await ghCommandFn([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    // Issue #1213: `mergeable` and `labels` say whether the merge-conflict
    // ladder owns this PR.
    // Issue #2802: `author` and the branches say whether, and how, the
    // stall-repair pass may act on the PR.
    "comments,commits,statusCheckRollup,createdAt,autoMergeRequest,isDraft,mergeable,labels,author,headRefName,baseRefName",
  ]);

  const view = parseObject(raw);
  const observation: BlockingPrObservation = {
    repo,
    prNumber,
    blockedIssues: [...blockedIssues],
    failingChecks: parseFailingChecks(view.statusCheckRollup),
    // Issue #1082: an armed auto-merge means the PR is already on its way,
    // and a draft is not waiting on anyone.
    autoMergeEnabled: view.autoMergeRequest !== null &&
      typeof view.autoMergeRequest === "object",
    isDraft: view.isDraft === true,
    checkCounts: countChecks(view.statusCheckRollup),
  };

  if (typeof view.createdAt === "string" && view.createdAt) {
    observation.createdAt = view.createdAt;
  }

  if (typeof view.mergeable === "string" && view.mergeable) {
    observation.mergeable = view.mergeable;
  }
  observation.labels = parseLabelNames(view.labels);
  const author = readLogin(view.author);
  if (author) observation.author = author;
  if (typeof view.headRefName === "string" && view.headRefName) {
    observation.headRefName = view.headRefName;
  }
  if (typeof view.baseRefName === "string" && view.baseRefName) {
    observation.baseRefName = view.baseRefName;
  }

  const lastFleetPushAt = newestCommitDate(view.commits);
  if (lastFleetPushAt) observation.lastFleetPushAt = lastFleetPushAt;

  const authors = [...fleetAuthors];
  for (const comment of asArray(view.comments)) {
    if (typeof comment !== "object" || comment === null) continue;
    const obj = comment as Record<string, unknown>;
    const author = readLogin(obj.author);
    const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : "";
    if (!author || !createdAt) continue;

    if (isFleetAuthor(author, authors)) {
      const body = typeof obj.body === "string" ? obj.body : "";
      if (body.includes(STALL_REPAIR_MARKER_PREFIX)) {
        observation.lastStallRepairAt = newerOf(
          observation.lastStallRepairAt,
          createdAt,
        );
        continue;
      }
      observation.lastFleetReplyAt = newerOf(
        observation.lastFleetReplyAt,
        createdAt,
      );
      continue;
    }
    if (isAuthorisedCommenter(author, authorisedCommenters)) {
      observation.lastAuthorisedCommentAt = newerOf(
        observation.lastAuthorisedCommentAt,
        createdAt,
      );
    }
  }

  return observation;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** Options for {@link scanBlockingPrStalls}. */
export interface ScanBlockingPrStallsOptions
  extends FindBlockingPrObservationsOptions {
  /** Worker config used to resolve the per-repo threshold. */
  config:
    & Pick<
      WorkerConfig,
      "blockingPrStallThresholdSeconds" | "repoConfig"
    >
    & Partial<Pick<WorkerConfig, "fleetPrSlots">>;
  /** Logger. */
  logger: Logger;
  /** Optional clock override (epoch seconds). */
  nowSeconds?: () => number;
  /**
   * The worker's own merge path for a green blocking PR (Issue #2801).
   * Defaults to {@link directMergePr}; production injects it explicitly.
   */
  directMergeFn?: typeof directMergePr;
}

/**
 * One scan iteration: find blocking PRs and detect stalls.
 *
 * A green PR is not a stall (Issue #2801): it goes to
 * {@link resolveGreenBlockingPr} once per cycle and is left out of the
 * returned list. A red or unanswered PR is returned and nothing else is done
 * to it here (Issue #2802) — no issue, no label, no comment. The caller,
 * `stall_repair.ts`, decides between the first and the second trip.
 */
export async function scanBlockingPrStalls(
  opts: ScanBlockingPrStallsOptions,
): Promise<Result<BlockingPrStall[]>> {
  const {
    config,
    logger,
    nowSeconds = () => Math.floor(Date.now() / 1000),
  } = opts;

  // Issue #2663: the same per-repo slot cap the claim scan applies.
  const observations = await findBlockingPrObservations({
    fleetPrSlotsFor: (repo) => resolveFleetPrSlots(config, repo),
    ...opts,
  });
  const now = nowSeconds();
  const stalls: BlockingPrStall[] = [];

  for (const observation of observations) {
    // Issue #1213: a PR that has since entered the merge-conflict lane may
    // still carry a live escalation whose next step invites a close. Retract
    // it before anything else, so the instruction cannot outlive its
    // condition.
    const withdrawal = await withdrawBlockingPrStallEscalation(observation, {
      ghCommandFn: opts.ghCommandFn,
      logger,
    });
    if (!withdrawal.ok) {
      logger.warn("Blocking-PR stall withdrawal failed", {
        repo: observation.repo,
        pr: observation.prNumber,
        error: withdrawal.error.message,
      });
    }

    const stall = detectBlockingPrStall(observation, {
      thresholdSeconds: resolveBlockingPrStallThresholdSeconds(
        config,
        observation.repo,
      ),
      nowSeconds: now,
    });
    if (!stall) continue;

    // Issue #2801: a green PR is not a stall. `unmerged-green` only trips
    // when nothing else has, so such a stall carries that signal alone.
    if (stall.signals.every((s) => s.reason === "unmerged-green")) {
      // The repository opted out of worker merges (`skip_auto_merge`): the
      // operator merges by hand, so a green PR is awaiting that merge —
      // no merge, no comment, no label. Every other worker merge path
      // honours the same key.
      if (
        getRepoConfig(config.repoConfig, stall.repo, "skipAutoMerge") ===
          "true"
      ) {
        logger.info(
          "Blocking-PR stall: green PR awaiting a manual merge (skip_auto_merge) — not a stall",
          { repo: stall.repo, pr: stall.prNumber },
        );
        continue;
      }
      await resolveGreenBlockingPr(stall, {
        directMergeFn: opts.directMergeFn ?? directMergePr,
        ghCommandFn: opts.ghCommandFn,
        fleetAuthors: opts.fleetAuthors,
        logger,
      });
      continue;
    }
    stalls.push(stall);

    logger.warn("Blocking PR has stalled — handing it to stall repair", {
      repo: stall.repo,
      pr: stall.prNumber,
      blockedIssues: stall.blockedIssues.join(", "),
      reasons: stall.signals.map((s) => s.reason).join(", "),
    });
  }

  return { ok: true, value: stalls };
}

// ---------------------------------------------------------------------------
// Green PR resolution (Issue #2801)
// ---------------------------------------------------------------------------

/** What happened to a green blocking PR this cycle. */
export type GreenBlockingPrOutcome =
  | "merged"
  | "awaiting-approval"
  | "merge-refused";

/** Dependencies for {@link resolveGreenBlockingPr}. */
export interface ResolveGreenBlockingPrDeps {
  /** The worker's own merge path — {@link directMergePr} in production. */
  directMergeFn: typeof directMergePr;
  /** Injected `gh` CLI runner, passed through to the merge path. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Fleet logins — an approval from one of these is not an approval. */
  fleetAuthors: readonly string[];
  /** Logger. */
  logger: Logger;
}

/**
 * Hand a green blocking PR to the worker's merge path and classify the result.
 *
 * `directMergePr` applies the approval gate: a default-branch PR without an
 * approving review from outside the fleet comes back
 * `default_branch_unapproved` — healthy, awaiting a human, so nothing is
 * posted. Any other PR goes through the pre-merge gate and merges. Every other
 * refusal is a loud warning and a retry next cycle; this function never
 * comments, labels, closes or re-queues.
 */
export async function resolveGreenBlockingPr(
  pr: Pick<BlockingPrStall, "repo" | "prNumber">,
  deps: ResolveGreenBlockingPrDeps,
): Promise<GreenBlockingPrOutcome> {
  const { repo, prNumber } = pr;
  // An empty fleet list would count a fleet approval as a human one, so the
  // approval policy is only offered when the fleet is known.
  const options = deps.fleetAuthors.length > 0
    ? { approvedDefaultBranch: { fleetAuthors: [...deps.fleetAuthors] } }
    : {};

  let merge: Result<MergeResult>;
  try {
    merge = await deps.directMergeFn(
      repo,
      prNumber,
      deps.ghCommandFn,
      undefined,
      options,
    );
  } catch (err) {
    merge = { ok: false, error: new Error(errorMessage(err)) };
  }

  if (merge.ok && merge.value.merged) {
    deps.logger.info("Blocking-PR stall: green PR merged", {
      repo,
      pr: prNumber,
    });
    return "merged";
  }
  if (merge.ok && merge.value.blocked === "default_branch_unapproved") {
    deps.logger.info(
      "Blocking-PR stall: green PR awaiting approval — not a stall",
      { repo, pr: prNumber },
    );
    return "awaiting-approval";
  }

  const reason = merge.ok
    ? merge.value.blocked ?? "merge not performed"
    : merge.error.message;
  deps.logger.warn(
    `Blocking-PR stall: green PR ${repo}#${prNumber} could not be merged (${reason}) — retrying next cycle, never abandoned`,
    { repo, pr: prNumber, reason },
  );
  return "merge-refused";
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readLogin(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" ? login : "";
}

/** Parse `gh pr view --json labels` into plain label names (Issue #1213). */
function parseLabelNames(value: unknown): string[] {
  const names: string[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === "string") {
      if (entry) names.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}

/** Parse `statusCheckRollup` entries into the failing checks. */
function parseFailingChecks(value: unknown): FailingCheck[] {
  const out: FailingCheck[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const conclusion = typeof obj.conclusion === "string"
      ? obj.conclusion.toUpperCase()
      : "";
    // Legacy commit statuses report `state` rather than `conclusion`.
    const state = typeof obj.state === "string" ? obj.state.toUpperCase() : "";
    if (!FAILING_CONCLUSIONS.has(conclusion) && state !== "FAILURE") continue;

    const name = typeof obj.name === "string"
      ? obj.name
      : typeof obj.context === "string"
      ? obj.context
      : "";
    const completedAt = typeof obj.completedAt === "string" && obj.completedAt
      ? obj.completedAt
      : typeof obj.startedAt === "string"
      ? obj.startedAt
      : "";
    if (!completedAt) continue;
    out.push({ name, completedAt });
  }
  return out;
}

/**
 * Count the head's checks and how many have not finished (Issue #1082).
 * A check run is pending unless `status` is `COMPLETED`; a legacy commit
 * status is pending while its `state` is `PENDING` or `EXPECTED`.
 */
function countChecks(value: unknown): { total: number; pending: number } {
  let total = 0;
  let pending = 0;
  for (const entry of asArray(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    total++;
    const status = typeof obj.status === "string"
      ? obj.status.toUpperCase()
      : "";
    const state = typeof obj.state === "string" ? obj.state.toUpperCase() : "";
    if (status && status !== "COMPLETED") pending++;
    else if (!status && (state === "PENDING" || state === "EXPECTED")) {
      pending++;
    }
  }
  return { total, pending };
}

/** Newest `committedDate` across the PR's commits. */
function newestCommitDate(value: unknown): string | undefined {
  let newest: string | undefined;
  for (const entry of asArray(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const committedDate = (entry as Record<string, unknown>).committedDate;
    if (typeof committedDate !== "string" || !committedDate) continue;
    newest = newerOf(newest, committedDate);
  }
  return newest;
}

function isAuthorisedCommenter(
  login: string,
  authorisedCommenters: readonly string[],
): boolean {
  const key = login.trim().toLowerCase();
  if (!key) return false;
  return authorisedCommenters.some(
    (a) => typeof a === "string" && a.trim().toLowerCase() === key,
  );
}

/** Return whichever ISO timestamp is newer, tolerating unparseable input. */
function newerOf(
  current: string | undefined,
  candidate: string,
): string | undefined {
  const currentEpoch = epochSeconds(current);
  const candidateEpoch = epochSeconds(candidate);
  if (candidateEpoch === undefined) return current;
  if (currentEpoch === undefined || candidateEpoch > currentEpoch) {
    return candidate;
  }
  return current;
}

function maxDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/** Parse an ISO timestamp to epoch seconds; `undefined` when unusable. */
function epochSeconds(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.floor(parsed / 1000);
}

/** Render a duration in whole hours/minutes for the escalation comment. */
function formatDuration(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
