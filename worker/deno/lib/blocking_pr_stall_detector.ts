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
 *   newer fleet push, older than the configured threshold; or
 * - **unanswered authorised comment** — the newest comment from an
 *   `authorized_commenters` login is newer than the newest fleet reply or
 *   push, by longer than the threshold.
 *
 * On trip it escalates through the shared `escalateToHuman()` chokepoint —
 * one deduped comment per PR per stall reason, plus `needs-human`. It never
 * attempts a fix: the fix routes belong to `pr_ci_processor.ts` and
 * `pr_feedback_processor.ts` (reachable again since Issue #4023). Detection
 * and escalation only.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger, Result, WorkerConfig } from "../types.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import type { IssueCache } from "./issue_cache.ts";
import { issueCommentsContainMarker } from "./issue_comment_pages.ts";
import {
  fetchIssuesByLabel,
  fetchOpenPRsForFleet,
  getBlockingPRForIssue,
} from "./issue_query.ts";
import { buildDedupMarker, escalateToHuman } from "./needs_human_escalation.ts";

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

/** Check conclusions that count as a red build. */
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "ERROR",
]);

/** Why a blocking PR is considered stalled. */
export type BlockingPrStallReason = "red-ci" | "unanswered-comment";

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
  /** ISO timestamp of the newest comment from a fleet account. */
  lastFleetReplyAt?: string;
}

/** One tripped staleness signal. */
export interface BlockingPrStallSignal {
  /** Which signal tripped. */
  reason: BlockingPrStallReason;
  /** How long the PR has been stalled on this signal, in seconds. */
  stalledSeconds: number;
  /** Human-readable explanation used in the escalation comment. */
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
    const answeredAt = maxDefined(replyAt, pushAt);
    const answered = answeredAt !== undefined && answeredAt >= commentAt;
    const stalledSeconds = nowSeconds - commentAt;
    if (!answered && stalledSeconds >= thresholdSeconds) {
      signals.push({
        reason: "unanswered-comment",
        stalledSeconds,
        detail: `an authorised comment has gone unanswered for ${
          formatDuration(stalledSeconds)
        } — no fleet reply and no push since`,
      });
    }
  }

  if (signals.length === 0) return null;
  return {
    repo: observation.repo,
    prNumber: observation.prNumber,
    blockedIssues: [...observation.blockedIssues],
    signals,
  };
}

/** Dedup key handed to `escalateToHuman` for one stall reason. */
export function blockingPrStallDedupKey(
  reason: BlockingPrStallReason,
): string {
  return `blocking-pr-stall:${reason}`;
}

/** HTML marker that dedups the escalation comment for one stall reason. */
export function blockingPrStallMarker(reason: BlockingPrStallReason): string {
  return buildDedupMarker(blockingPrStallDedupKey(reason));
}

/** Build the `**Why:**` body for one tripped signal. */
export function buildBlockingPrStallReason(
  stall: BlockingPrStall,
  signal: BlockingPrStallSignal,
): string {
  const issues = stall.blockedIssues.map((issue) => `#${issue}`).join(", ");
  const plural = stall.blockedIssues.length === 1 ? "" : "s";
  return (
    `This PR has ${signal.detail}, and it is blocking the \`work-on\` ` +
    `issue${plural} ${issues} from being picked up. The worker defers ` +
    `${plural === "" ? "that issue" : "those issues"} to this PR, so the ` +
    "work stream is stopped until the PR moves."
  );
}

/** Next step printed in the escalation comment. */
export const BLOCKING_PR_STALL_NEXT_STEP =
  "Push a fix, reply to the outstanding comment, or close the PR — whichever " +
  "unblocks it — so the deferred `work-on` issues can be picked up again.";

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** Dependencies for {@link escalateBlockingPrStall}. */
export interface EscalateBlockingPrStallDeps {
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Label name to apply — typically `config.needsHumanLabel`. */
  needsHumanLabel: string;
  /** GitHub login used in the comment footer. */
  githubUser?: string;
  /** Optional `ensureLabelExists` override (tests). */
  ensureLabelExists?: (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
  /** Logger. */
  logger: Logger;
}

/** Outcome of {@link escalateBlockingPrStall}. */
export interface EscalateBlockingPrStallOutcome {
  /** Reasons for which a comment was posted on this call. */
  postedReasons: BlockingPrStallReason[];
  /**
   * True when the whole escalation was skipped because the auto-fix
   * attempt cap has already escalated this PR to a human.
   */
  suppressedByAutoFixCap: boolean;
}

/**
 * Escalate a stalled blocking PR: one deduped comment per stall reason plus
 * the `needs-human` label, via the shared `escalateToHuman()` chokepoint.
 *
 * Two suppressions apply:
 *
 * - **auto-fix cap** — when `auto_fix_attempt_tracker.ts` has already
 *   escalated this PR, the human already owns it; a second escalation
 *   comment is noise.
 * - **marker dedup** — a reason whose marker is already on the thread is
 *   never commented twice, so a long stall does not accrue a comment per
 *   scan iteration.
 */
export async function escalateBlockingPrStall(
  stall: BlockingPrStall,
  deps: EscalateBlockingPrStallDeps,
): Promise<Result<EscalateBlockingPrStallOutcome>> {
  const { ghCommandFn, needsHumanLabel, githubUser, logger } = deps;

  let capEscalated: boolean;
  try {
    capEscalated = await issueCommentsContainMarker(
      stall.repo,
      stall.prNumber,
      AUTO_FIX_CAP_MARKER_PREFIX,
      ghCommandFn,
    );
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `blocking-PR stall watchdog: could not read comments on ${stall.repo}#${stall.prNumber}: ${
          errorMessage(err)
        }`,
      ),
    };
  }

  if (capEscalated) {
    logger.info(
      "Blocking-PR stall: suppressed — auto-fix cap already escalated",
      { repo: stall.repo, pr: stall.prNumber },
    );
    return {
      ok: true,
      value: { postedReasons: [], suppressedByAutoFixCap: true },
    };
  }

  const ghClient = createGhEscalationClient(ghCommandFn);
  const postedReasons: BlockingPrStallReason[] = [];

  for (const signal of stall.signals) {
    const marker = blockingPrStallMarker(signal.reason);
    let alreadyPosted: boolean;
    try {
      alreadyPosted = await issueCommentsContainMarker(
        stall.repo,
        stall.prNumber,
        marker,
        ghCommandFn,
      );
    } catch (err) {
      return {
        ok: false,
        error: new Error(
          `blocking-PR stall watchdog: marker lookup failed on ${stall.repo}#${stall.prNumber}: ${
            errorMessage(err)
          }`,
        ),
      };
    }
    if (alreadyPosted) continue;

    const escalation = await escalateToHuman({
      ghClient,
      repo: stall.repo,
      target: { kind: "pr", number: stall.prNumber },
      needsHumanLabel,
      heading: "Blocking PR has stalled",
      reason: buildBlockingPrStallReason(stall, signal),
      nextStep: BLOCKING_PR_STALL_NEXT_STEP,
      dedupKey: blockingPrStallDedupKey(signal.reason),
      ensureLabelColour: "d4c5f9",
      ensureLabelDescription:
        "Worker could not progress this autonomously; human review required",
      ...(githubUser !== undefined ? { githubUser } : {}),
      ...(deps.ensureLabelExists !== undefined
        ? { deps: { github: { ensureLabelExists: deps.ensureLabelExists } } }
        : {}),
      logger,
    });

    if (!escalation.ok) return { ok: false, error: escalation.error };
    if (escalation.value.commentPosted) postedReasons.push(signal.reason);
  }

  return {
    ok: true,
    value: { postedReasons, suppressedByAutoFixCap: false },
  };
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
    "comments,commits,statusCheckRollup",
  ]);

  const view = parseObject(raw);
  const observation: BlockingPrObservation = {
    repo,
    prNumber,
    blockedIssues: [...blockedIssues],
    failingChecks: parseFailingChecks(view.statusCheckRollup),
  };

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
  config: Pick<
    WorkerConfig,
    "blockingPrStallThresholdSeconds" | "repoConfig"
  >;
  /** Label name to apply — typically `config.needsHumanLabel`. */
  needsHumanLabel: string;
  /** GitHub login used in the comment footer. */
  githubUser?: string;
  /** Logger. */
  logger: Logger;
  /** Optional `ensureLabelExists` override (tests). */
  ensureLabelExists?: EscalateBlockingPrStallDeps["ensureLabelExists"];
  /** Optional clock override (epoch seconds). */
  nowSeconds?: () => number;
}

/**
 * One scan iteration: find blocking PRs, detect stalls, escalate.
 *
 * A per-PR escalation failure is logged and the scan continues; the
 * returned list contains every stall that was detected, escalated or not.
 */
export async function scanBlockingPrStalls(
  opts: ScanBlockingPrStallsOptions,
): Promise<Result<BlockingPrStall[]>> {
  const {
    config,
    needsHumanLabel,
    githubUser,
    logger,
    nowSeconds = () => Math.floor(Date.now() / 1000),
  } = opts;

  const observations = await findBlockingPrObservations(opts);
  const now = nowSeconds();
  const stalls: BlockingPrStall[] = [];

  for (const observation of observations) {
    const stall = detectBlockingPrStall(observation, {
      thresholdSeconds: resolveBlockingPrStallThresholdSeconds(
        config,
        observation.repo,
      ),
      nowSeconds: now,
    });
    if (!stall) continue;
    stalls.push(stall);

    logger.warn("Blocking PR has stalled — escalating", {
      repo: stall.repo,
      pr: stall.prNumber,
      blockedIssues: stall.blockedIssues.join(", "),
      reasons: stall.signals.map((s) => s.reason).join(", "),
    });

    const escalation = await escalateBlockingPrStall(stall, {
      ghCommandFn: opts.ghCommandFn,
      needsHumanLabel,
      ...(githubUser !== undefined ? { githubUser } : {}),
      ...(opts.ensureLabelExists !== undefined
        ? { ensureLabelExists: opts.ensureLabelExists }
        : {}),
      logger,
    });
    if (!escalation.ok) {
      logger.warn("Blocking-PR stall escalation failed", {
        repo: stall.repo,
        pr: stall.prNumber,
        error: escalation.error.message,
      });
    }
  }

  return { ok: true, value: stalls };
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
