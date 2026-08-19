/**
 * Atomic issue claiming with verification to prevent multi-worker race
 * conditions (Issue #433, #604, #911).
 *
 * When multiple Vibe Coders scan for issues concurrently, there is a race
 * condition window between discovering an unassigned issue and assigning it.
 * This module implements a claim-then-verify pattern:
 *
 *   1. Assign the worker to the issue immediately
 *   2. Post a hidden claim comment with the worker's unique ID
 *   3. Brief pause for GitHub's eventual consistency
 *   4. Re-read the issue's comments to check for competing claims
 *   5. Earliest claim comment wins; losers clean up and back off
 *
 * Issue #604: When multiple workers share the same GitHub username,
 * assignee-based tie-breaking is ineffective. Comment-based
 * verification solves this by using unique worker IDs embedded in hidden
 * HTML comments.
 *
 * Migrated from worker/shared/claim_issue.sh (Issue #911).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { IssueCache } from "./issue_cache.ts";
import type { BlockingPRInfo } from "./issue_query.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { runGhCommand } from "./github.ts";
import { formatHeartbeatMarker, seedMarkerState } from "./heartbeat_storage.ts";
import { fetchOpenPRsForFleet, getBlockingPRForIssue } from "./issue_query.ts";
import { addLabelToIssue, ensureLabelExists } from "./label_operations.ts";
import { postCooldownComment } from "./shared_cooldown.ts";
import { getHostname } from "./worker_identity.ts";

/** The claim marker prefix used in issue comments for tie-breaking. */
export const CLAIM_MARKER_PREFIX = "<!-- CLAIM_LOCK:";

/**
 * Options to co-publish an initial heartbeat marker inside the claim
 * comment (Issue #1628).
 *
 * When provided, the claim comment body contains both the CLAIM_LOCK
 * marker and an initial VIBE_CODER_HEARTBEAT marker, and the worker's
 * marker state file is seeded so subsequent heartbeat refreshes PATCH
 * the same comment instead of posting a separate one.
 */
export interface ClaimMarkerOptions {
  /** Stable per-machine identifier — see lib/machine_id.ts. */
  machineId: string;
  /** Working directory used to persist marker state. */
  workDir: string;
  /** Optional clock for tests. Defaults to wall-clock seconds. */
  nowFn?: () => number;
}

/** Options for a claim attempt. */
export interface ClaimOptions {
  repo: string;
  issueNumber: number;
  githubUser: string;
  workerId: string;
  /**
   * Hostname of the machine making the claim. Surfaced in the visible
   * claim comment body so operators can locate the worker's logs when
   * something goes wrong (Issue #2034). Defaults to the result of
   * `getHostname()` when not provided.
   */
  hostname?: string;
  /** Injected sleep function (for testing). Defaults to real sleep. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injected gh command function (for testing). Defaults to runGhCommand. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * When provided, embed an initial heartbeat marker in the claim comment
   * and seed the local marker state so the heartbeat updater PATCHes this
   * same comment instead of posting a second one (Issue #1628).
   */
  markerOptions?: ClaimMarkerOptions;
  /**
   * Fleet GitHub logins whose open PRs are re-checked live — with the
   * per-user cache bypassed — after this host wins the claim race and
   * before any Claude/token work begins (Issue #3150). Should be the union
   * of the host login, `allowedAuthors`, and `fleetPrAuthors` (see
   * `resolveFleetAuthors`). When omitted or empty, the live re-check is
   * skipped entirely, preserving the prior single-host behaviour.
   *
   * Also the set of authors whose `CLAIM_LOCK` markers are trusted for the
   * claim race and the stale cleanup (Issue #3664). Omitting it falls back
   * to `githubUser` alone for that check — pass the full union whenever
   * fleet hosts run under different GitHub logins.
   */
  fleetAuthors?: string[];
  /**
   * The fleet's push-capable logins (`resolveFleetMaintenanceAuthorSet`:
   * host login + `fleet_pr_authors`). Only these accounts' open PRs defer
   * a claim — a human's PR is theirs to manage and never blocks issue
   * pickup (Issue #4133). Omitted or empty keeps the fail-safe: an
   * unclassifiable PR still blocks.
   */
  pushCapableAuthors?: string[];
  /**
   * The issue's milestone title (empty/undefined for a non-milestone
   * issue). The live fleet-PR re-check (Issue #3150) matches a blocking PR
   * the same milestone-aware way the discovery-time guard does
   * (`getBlockingPRForIssue`).
   */
  milestoneTitle?: string;
  /**
   * Optional iteration-scoped cache. The live fleet-PR re-check always
   * force-refreshes it (bypassing any stale `prs_${user}` entry) and
   * overwrites it with the fresh result (Issue #3150).
   */
  cache?: IssueCache;
}

/** Claim comment parsed from the GitHub API. */
interface ClaimComment {
  id: number;
  body: string;
  createdAt: string;
  /**
   * Comment author login (`.user.login`). A CLAIM_LOCK marker lives in a
   * comment body that any GitHub user can post, so the author is the only
   * authenticated part of the marker (Issue #3664).
   */
  author?: string;
}

/**
 * Reason a claim attempt did not result in this worker holding the issue
 * (Issue #2325). Distinguishes permanent misconfiguration (e.g. the worker
 * is not a collaborator on the repo) from transient race losses, so the
 * caller can surface a meaningful warning instead of the catch-all
 * "already assigned or closed".
 */
export type ClaimFailureReason =
  /** Pre-claim freshness check found the issue was already assigned. */
  | "already_assigned"
  /** Pre-claim freshness check found a recent CLAIM_LOCK from another worker. */
  | "recent_claim"
  /** The issue is closed. */
  | "already_closed"
  /** Another worker won the claim race (their CLAIM_LOCK comment is earlier). */
  | "race_lost"
  /**
   * A live, cache-bypassing fleet open-PR re-check (Issue #3150) found an
   * open PR — raised by this host or a sibling fleet account — already
   * targeting this issue's work stream. The PR was opened in the window
   * between this host's discovery and its claim, so the discovery-time
   * guard could not see it. The claim is aborted before any token work
   * begins to avoid a duplicate PR.
   */
  | "fleet_pr_exists"
  /**
   * `gh issue edit --add-assignee` returned HTTP 422 — the worker user is
   * not a collaborator on the repo (or the assignee is otherwise invalid).
   * Permanent until the repo owner adds the worker as a collaborator.
   */
  | "not_assignable"
  /** `gh issue edit --add-assignee` returned HTTP 403 — permission denied. */
  | "forbidden"
  /** `gh issue edit --add-assignee` returned HTTP 404 — repo or issue missing. */
  | "not_found"
  /** `gh issue comment` failed after assignment succeeded. */
  | "comment_failed"
  /** Verification re-read of comments failed after the claim was posted. */
  | "verification_failed"
  /** Any other error from `gh` (network, transient 5xx, etc.). */
  | "api_error";

/** Result data from a successful claim operation. */
export interface ClaimResult {
  claimed: boolean;
  winnerId?: string;
  /** Number of competing workers in the claim race (0 = no race). Issue #1090. */
  competingWorkerCount?: number;
  /**
   * Distinguished reason the claim did not succeed (Issue #2325). Only set
   * when `claimed === false`. Lets callers surface "not_assignable: worker
   * is not a collaborator" instead of the misleading "already assigned or
   * closed" catch-all.
   */
  reason?: ClaimFailureReason;
  /**
   * Raw `gh` error message captured when the assignment or comment step
   * failed (Issue #2325). Suitable for logging at WARN — names the gh
   * stderr so operators can diagnose without log-diving.
   */
  reasonDetail?: string;
}

/** Options for checking claim churn. */
export interface ClaimChurnOptions {
  repo: string;
  issueNumber: number;
  githubUser: string;
  threshold?: number;
  failedLabel?: string;
  /** Allowed authors to @mention in escalation comments (Issue #999). */
  allowedAuthors?: string[];
  /** Injected gh command function (for testing). Defaults to runGhCommand. */
  ghCommandFn?: (args: string[]) => Promise<string>;
}

/** Result data from a claim churn check. */
export interface ClaimChurnResult {
  churnCount: number;
  escalated: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maximum age (in milliseconds) for a CLAIM_LOCK comment to be considered recent. */
const RECENT_CLAIM_WINDOW_MS = 60_000;

/**
 * Minimum age a CLAIM_LOCK comment must reach before the stale-claim
 * cleanup may delete it (Issue #3664). Anything younger is a live claim —
 * possibly a fleet sibling's in-flight claim — not the leftover of a
 * crashed previous run.
 */
const STALE_CLAIM_MIN_AGE_MS = RECENT_CLAIM_WINDOW_MS;

/**
 * Resolve the author logins whose CLAIM_LOCK markers this worker trusts
 * (Issue #3664).
 *
 * A CLAIM_LOCK marker is just text in a comment body, so any GitHub user
 * can post one. Only the comment *author* is authenticated, so every
 * decision driven by a marker — race resolution and stale cleanup alike —
 * is gated on the author belonging to the fleet.
 *
 * Callers that know the whole fleet pass `fleetAuthors`
 * (`resolveFleetAuthors`). Callers that do not fall back to the claiming
 * account itself, which covers the shared-username fleet deployment
 * (Issue #604) that comment-based claiming was built for. Both directions
 * fail toward *claiming* the issue rather than abandoning it, matching the
 * pre-claim check's Issue #3164 behaviour.
 *
 * @returns The trusted logins, or an empty list (filtering disabled) when
 *   no author is known at all.
 */
export function resolveTrustedClaimAuthors(
  githubUser: string,
  fleetAuthors?: string[],
): string[] {
  const fleet = (fleetAuthors ?? []).filter(
    (a) => typeof a === "string" && a.trim().length > 0,
  );
  if (fleet.length > 0) return fleet;
  return typeof githubUser === "string" && githubUser.trim().length > 0
    ? [githubUser]
    : [];
}

/**
 * Discard CLAIM_LOCK comments that were not posted by a fleet account
 * (Issue #3664). An empty `trustedAuthors` disables the filter.
 */
function filterFleetClaimComments(
  comments: ClaimComment[],
  trustedAuthors: string[],
  repo: string,
  issueNumber: number,
): ClaimComment[] {
  if (trustedAuthors.length === 0) return comments;
  const kept = comments.filter((c) => isFleetAuthor(c.author, trustedAuthors));
  const discarded = comments.length - kept.length;
  if (discarded > 0) {
    console.warn(
      `[claim_issue] repo=${repo} issue=#${issueNumber} ` +
        `discarded_claim_markers=${discarded} reason=non_fleet_author — a ` +
        `CLAIM_LOCK marker from outside the fleet cannot win the claim race ` +
        `(Issue #3664)`,
    );
  }
  return kept;
}

/**
 * Classify a `gh` error message into a structured ClaimFailureReason
 * (Issue #2325). Pattern-matches on HTTP status codes and validation
 * keywords surfaced via `runGhCommandRaw` (which embeds gh stderr in the
 * Error message).
 */
export function classifyGhAssignError(message: string): ClaimFailureReason {
  if (!message) return "api_error";
  const lower = message.toLowerCase();
  // 422 with an "assignees" / "is invalid" validation error means the
  // user is not a collaborator on the repo. gh's stderr reads e.g.
  // "HTTP 422: Validation Failed (...) - 'assignees' is invalid".
  if (
    lower.includes("422") ||
    lower.includes("validation failed") ||
    (lower.includes("assignee") && lower.includes("invalid"))
  ) {
    return "not_assignable";
  }
  if (lower.includes("403") || lower.includes("forbidden")) {
    return "forbidden";
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return "not_found";
  }
  return "api_error";
}

/**
 * Pre-claim freshness re-check (Issue #1086).
 *
 * Re-fetches the issue's current assignees and recent claim comments
 * immediately before the full claim sequence. This narrows the race
 * window by catching cases where another worker claimed the issue
 * between scan time and claim time.
 *
 * Fails open on API errors — if the check cannot be performed, the
 * worker proceeds with the full claim sequence rather than blocking.
 *
 * Issue #3164: when `allowedAuthors` (the `resolveFleetAuthors` union) is
 * provided and non-empty, Check 2 honours a recent `CLAIM_LOCK` comment
 * only when its author is a fleet account. A forged `CLAIM_LOCK` posted by
 * any other GitHub user is ignored, so an attacker who can merely comment
 * on the issue can no longer keep the worker from ever claiming it (fail
 * toward allowing the claim). When omitted/empty the author filter is
 * disabled, preserving the prior behaviour.
 *
 * Issue #3664: `claimIssue` now always supplies a non-empty set — the
 * fleet union when known, the claiming account otherwise — see
 * `resolveTrustedClaimAuthors`.
 */
async function preClaimFreshnessCheck(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
  allowedAuthors: string[] = [],
): Promise<{ shouldBailOut: boolean; reason?: ClaimFailureReason }> {
  // Check 1: Re-fetch current assignees
  try {
    const assigneesJson = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "assignees",
      "--jq",
      "[.assignees[].login]",
    ]);
    const trimmed = assigneesJson.trim();
    if (trimmed && trimmed !== "[]" && trimmed !== "null") {
      try {
        const assignees: unknown = JSON.parse(trimmed);
        if (Array.isArray(assignees) && assignees.length > 0) {
          return { shouldBailOut: true, reason: "already_assigned" };
        }
      } catch {
        // Non-JSON response — fall through
      }
    }
  } catch {
    // Fail open — proceed with claim
  }

  // Check 2: Look for recent CLAIM_LOCK comments (within last 60 seconds)
  try {
    const commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${CLAIM_MARKER_PREFIX}")) | {id: .id, body: .body, created_at: .created_at, author: .user.login}]`,
    ]);
    const parsed: unknown = JSON.parse(commentsJson);
    if (Array.isArray(parsed)) {
      const now = Date.now();
      const filterByAuthor = allowedAuthors.length > 0;
      for (const comment of parsed as Array<Record<string, unknown>>) {
        // Issue #3164: ignore a forged CLAIM_LOCK from a non-fleet author
        // when a fleet allow-list was supplied (fail toward allowing the
        // claim).
        if (
          filterByAuthor &&
          !isFleetAuthor(comment.author as string, allowedAuthors)
        ) {
          continue;
        }
        const createdAt = String(comment.created_at ?? "");
        if (createdAt) {
          const commentAge = now - new Date(createdAt).getTime();
          if (commentAge >= 0 && commentAge < RECENT_CLAIM_WINDOW_MS) {
            return { shouldBailOut: true, reason: "recent_claim" };
          }
        }
      }
    }
  } catch {
    // Fail open — proceed with claim
  }

  return { shouldBailOut: false };
}

/** Options controlling `fetchIssueState`'s retry behaviour (Issue #3151). */
export interface FetchIssueStateOptions {
  /** Total attempts before giving up. Defaults to 3. */
  maxAttempts?: number;
  /** Injected sleep for the retry backoff (for testing). */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Fetch the current state of a GitHub issue ("OPEN" or "CLOSED").
 *
 * Issue #3151: a transient `gh` error must NOT fail open into starting work
 * on a possibly-merged/closed issue — the previous fail-open-to-OPEN let a
 * merged issue be re-claimed and a duplicate PR opened (Failure Mode B in
 * #3136). The call is now retried a few times with a short backoff; if every
 * attempt fails the state is treated as "CLOSED" (fail closed / blocked) so
 * the worker skips the issue this cycle rather than starting work on it. A
 * genuinely-open issue is simply retried next cycle once `gh` recovers.
 */
export async function fetchIssueState(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
  options: FetchIssueStateOptions = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 3;
  const sleepFn = options.sleepFn ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await ghCommandFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        "state",
        "--jq",
        ".state",
      ]);
      const state = output.trim().toUpperCase();
      return state === "CLOSED" ? "CLOSED" : "OPEN";
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleepFn(1000 * attempt);
      }
    }
  }

  const message = lastError instanceof Error
    ? lastError.message
    : String(lastError);
  console.warn(
    `[claim_issue] fetch_issue_state_failed repo=${repo} issue=#${issueNumber} ` +
      `attempts=${maxAttempts} error=${message} — treating as CLOSED to avoid ` +
      `starting work on a possibly-merged issue (Issue #3151)`,
  );
  return "CLOSED"; // Fail closed
}

/**
 * Default sleep function — waits the given number of milliseconds.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse claim comments from a GitHub API JSON response.
 *
 * Expects a JSON array of objects with id, body, and created_at fields.
 */
function parseClaimComments(json: string): ClaimComment[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, unknown>>)
      .filter((c) =>
        typeof c.body === "string" &&
        (c.body as string).includes(CLAIM_MARKER_PREFIX)
      )
      .map((c) => ({
        id: Number(c.id),
        body: String(c.body),
        createdAt: String(c.created_at ?? c.createdAt ?? ""),
        author: typeof c.author === "string" ? c.author : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Extract the worker ID from a claim comment body.
 *
 * Pattern: `<!-- CLAIM_LOCK:worker-name -->`
 */
export function extractWorkerIdFromComment(body: string): string {
  const match = body.match(/<!-- CLAIM_LOCK:([^ ]+) -->/);
  return match?.[1] ?? "";
}

/**
 * Clean up stale claim comments from previous runs.
 *
 * Stale claim comments can accumulate if a worker crashes after posting
 * a claim but before completing work.
 *
 * Issue #3664: only the fleet's *own* stale markers are removed. A comment
 * is deleted only when its author is a trusted fleet account (an outsider's
 * CLAIM_LOCK-shaped comment — or a human quoting the marker — is not ours
 * to delete) **and** it is at least `STALE_CLAIM_MIN_AGE_MS` old (a younger
 * marker is a live claim, possibly a sibling's in-flight one). A marker
 * whose age cannot be established is left alone rather than assumed stale.
 */
async function cleanupStaleClaimComments(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
  trustedAuthors: string[],
  nowMs: number = Date.now(),
): Promise<void> {
  let commentsJson: string;
  try {
    commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${CLAIM_MARKER_PREFIX}")) | {id: .id, created_at: .created_at, author: .user.login}]`,
    ]);
  } catch {
    return; // Best-effort
  }

  let entries: Array<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(commentsJson);
    if (!Array.isArray(parsed)) return;
    entries = parsed as Array<Record<string, unknown>>;
  } catch {
    return;
  }

  const filterByAuthor = trustedAuthors.length > 0;
  const ids: number[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const id = Number(entry.id);
    if (!Number.isFinite(id)) continue;
    if (
      filterByAuthor && !isFleetAuthor(entry.author as string, trustedAuthors)
    ) {
      continue; // Not a fleet marker — not ours to delete
    }
    const createdMs = new Date(String(entry.created_at ?? "")).getTime();
    if (!Number.isFinite(createdMs)) continue; // Cannot prove it is stale
    if (nowMs - createdMs < STALE_CLAIM_MIN_AGE_MS) continue; // Still in flight
    ids.push(id);
  }

  for (const id of ids) {
    try {
      await ghCommandFn([
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/issues/comments/${id}`,
      ]);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Remove this worker's claim comment after losing a contested claim.
 */
async function removeOwnClaimComment(
  repo: string,
  issueNumber: number,
  workerId: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<void> {
  try {
    const commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | contains("CLAIM_LOCK:${workerId}")) | .id] | .[0] // empty`,
    ]);
    const commentId = commentsJson.trim();
    if (commentId) {
      await ghCommandFn([
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/issues/comments/${commentId}`,
      ]);
    }
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find this worker's claim comment in the verification list and seed the
 * marker state file so subsequent heartbeats PATCH the same comment
 * (Issue #1628). Best-effort — failure simply means the next heartbeat
 * will post a separate marker comment instead.
 */
async function seedMarkerStateForOwnComment(
  comments: ClaimComment[],
  workerId: string,
  claimPrefix: string,
  initialEpoch: number,
  markerOptions: ClaimMarkerOptions | undefined,
  repo: string,
  issueNumber: number,
): Promise<void> {
  if (!markerOptions) return;
  const own = comments.find((c) =>
    extractWorkerIdFromComment(c.body) === workerId
  );
  if (!own || !Number.isFinite(own.id)) return;
  try {
    await seedMarkerState(markerOptions.workDir, repo, issueNumber, {
      commentId: own.id,
      lastRefresh: initialEpoch,
      claimPrefix,
      // Issue #3752: the claim moment is the claim's start time, and the
      // worker id is shown in the visible heartbeat body on every refresh.
      startedEpoch: initialEpoch,
      workerId,
    });
  } catch {
    // Non-fatal — heartbeat updater will fall back to its existing post path.
  }
}

/**
 * Live, cache-bypassing fleet open-PR re-check (Issue #3150).
 *
 * Run after this host wins the earliest-comment claim race and before any
 * Claude/token work begins. Fetches open PRs for every fleet account with
 * the per-user cache force-refreshed, so a PR opened by a sibling account
 * *between* this host's discovery and its claim — invisible to the
 * discovery-only #3100 guard — is seen here. Matches a blocking PR the
 * same milestone-aware way the discovery-time guard does.
 *
 * Fails open: an empty fleet list, or any API error, returns `null` so a
 * transient GitHub failure never blocks a legitimate claim.
 *
 * @returns The blocking PR if one already targets this work stream, else
 *   `null`.
 */
async function liveFleetPrRecheck(
  repo: string,
  issueNumber: number,
  fleetAuthors: string[] | undefined,
  pushCapableAuthors: string[] | undefined,
  milestoneTitle: string | undefined,
  cache: IssueCache | undefined,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<BlockingPRInfo | null> {
  const authors = (fleetAuthors ?? []).filter(
    (a) => typeof a === "string" && a.trim().length > 0,
  );
  if (authors.length === 0) return null;
  try {
    const prs = await fetchOpenPRsForFleet(
      repo,
      authors,
      cache,
      ghCommandFn,
      undefined,
      true, // forceRefresh — bypass any stale discovery-time prs_${user}
    );
    return getBlockingPRForIssue(
      prs,
      milestoneTitle ?? "",
      pushCapableAuthors ?? [],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[claim_issue] fleet_pr_recheck_failed repo=${repo} issue=#${issueNumber} ` +
        `error=${message}`,
    );
    return null; // Fail open
  }
}

/** Parameters for finalising a won claim (Issue #3150). */
interface FinaliseWonClaimParams {
  repo: string;
  issueNumber: number;
  githubUser: string;
  workerId: string;
  competingWorkerCount: number;
  fleetAuthors: string[] | undefined;
  pushCapableAuthors: string[] | undefined;
  milestoneTitle: string | undefined;
  cache: IssueCache | undefined;
  ghCommandFn: (args: string[]) => Promise<string>;
  allClaimComments: ClaimComment[];
  claimPrefix: string;
  initialEpoch: number;
  markerOptions: ClaimMarkerOptions | undefined;
}

/**
 * Finalise a claim this host has just won the comment race for (Issue
 * #3150).
 *
 * Before declaring success, run the live fleet-PR re-check. If a fleet PR
 * already targets this work stream, abort the claim — mirroring the
 * `claim_race=lost` cleanup: remove this worker's claim comment, release
 * the assignment, and return `fleet_pr_exists`. Otherwise seed the marker
 * state and return the successful claim.
 */
async function finaliseWonClaim(
  params: FinaliseWonClaimParams,
): Promise<Result<ClaimResult>> {
  const {
    repo,
    issueNumber,
    githubUser,
    workerId,
    competingWorkerCount,
    fleetAuthors,
    pushCapableAuthors,
    milestoneTitle,
    cache,
    ghCommandFn,
    allClaimComments,
    claimPrefix,
    initialEpoch,
    markerOptions,
  } = params;

  const blockingPr = await liveFleetPrRecheck(
    repo,
    issueNumber,
    fleetAuthors,
    pushCapableAuthors,
    milestoneTitle,
    cache,
    ghCommandFn,
  );
  if (blockingPr) {
    incrementCounter("claimConflicts");
    // Issue #4078: name the blocking PR's author. The claim path only
    // stands down (no PR is ever touched here); the `work-on` scan that
    // sees the same block escalates `needs-human` on the issue, so the
    // author in this line ties the abort to that escalation.
    console.error(
      `[claim_issue] repo=${repo} issue=#${issueNumber} claim_abort=fleet_pr_exists ` +
        `blocking_pr=#${blockingPr.number} ` +
        `blocking_pr_author=${blockingPr.author || "(unknown)"} ` +
        `worker=${workerId}`,
    );
    // Mirror the claim_race=lost cleanup: drop our claim comment and
    // release the assignment so a sibling/next worker is unblocked.
    await removeOwnClaimComment(repo, issueNumber, workerId, ghCommandFn);
    try {
      await ghCommandFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        githubUser,
      ]);
    } catch {
      // Best-effort
    }
    return {
      ok: true,
      value: {
        claimed: false,
        competingWorkerCount,
        reason: "fleet_pr_exists",
        reasonDetail:
          `open PR #${blockingPr.number} already targets this work stream`,
      },
    };
  }

  await seedMarkerStateForOwnComment(
    allClaimComments,
    workerId,
    claimPrefix,
    initialEpoch,
    markerOptions,
    repo,
    issueNumber,
  );
  return {
    ok: true,
    value: { claimed: true, winnerId: workerId, competingWorkerCount },
  };
}

/**
 * Atomically claim an issue with verification.
 *
 * Assigns the current worker to the issue, posts a claim comment with a
 * unique worker ID, then verifies no competing claims exist. If multiple
 * workers claimed simultaneously, the earliest claim comment wins.
 *
 * @returns Result with claim outcome
 */
export async function claimIssue(
  options: ClaimOptions,
): Promise<Result<ClaimResult>> {
  const {
    repo,
    issueNumber,
    githubUser,
    workerId,
    hostname,
    sleepFn = defaultSleep,
    ghCommandFn = runGhCommand,
    markerOptions,
    fleetAuthors,
    pushCapableAuthors,
    milestoneTitle,
    cache,
  } = options;

  // Resolve the host that is making the claim. Surfacing the hostname in
  // the visible comment lets operators jump directly to the right machine
  // when they need to inspect logs after a failure (Issue #2034).
  const claimingHost = (hostname && hostname.length > 0)
    ? hostname
    : getHostname();

  // Build the claim comment body. When markerOptions is provided, embed an
  // initial heartbeat marker so the claim and heartbeat live in the same
  // comment (Issue #1628).
  const claimPrefix =
    `${CLAIM_MARKER_PREFIX}${workerId} -->\nClaimed by \`${workerId}\` on host \`${claimingHost}\``;
  const initialEpoch = markerOptions?.nowFn
    ? markerOptions.nowFn()
    : Math.floor(Date.now() / 1000);
  const claimCommentBody = markerOptions
    ? `${claimPrefix}\n${
      formatHeartbeatMarker(markerOptions.machineId, initialEpoch)
    }`
    : claimPrefix;

  // Authors whose CLAIM_LOCK markers this worker trusts (Issue #3664).
  // Every marker-driven decision below — the pre-claim check, the stale
  // cleanup and the Step-5 race resolution — is gated on this set, because
  // a marker in a comment body is not an authenticated channel.
  const trustedClaimAuthors = resolveTrustedClaimAuthors(
    githubUser,
    fleetAuthors,
  );

  // Pre-claim freshness re-check (Issue #1086): Re-fetch assignees and
  // recent claim comments to narrow the race window between scan and claim.
  const freshnessCheck = await preClaimFreshnessCheck(
    repo,
    issueNumber,
    ghCommandFn,
    trustedClaimAuthors,
  );
  if (freshnessCheck.shouldBailOut) {
    return {
      ok: true,
      value: { claimed: false, reason: freshnessCheck.reason },
    };
  }

  // Step 0: Verify the issue is still open before attempting to claim.
  // A merged PR on another machine may have auto-closed the issue since
  // this worker discovered it (race condition with multi-machine workers).
  const issueState = await fetchIssueState(repo, issueNumber, ghCommandFn, {
    sleepFn,
  });
  if (issueState !== "OPEN") {
    return { ok: true, value: { claimed: false, reason: "already_closed" } };
  }

  // Step 1: Remove any stale claim comments from previous runs (Issue #604)
  await cleanupStaleClaimComments(
    repo,
    issueNumber,
    ghCommandFn,
    trustedClaimAuthors,
  );

  // Step 2: Assign the worker to the issue immediately.
  //
  // Issue #2325: The previous implementation swallowed the gh error in a
  // bare `catch {}`, which turned "the worker is not a collaborator on
  // this repo" (a permanent 422) into the misleading message "already
  // assigned or closed" — causing the main loop to re-scan and re-attempt
  // the same issue every iteration in silence. Now we capture the error,
  // classify it, log it at WARN, and surface the reason to the caller.
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-assignee",
      githubUser,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = classifyGhAssignError(message);
    console.warn(
      `[claim_issue] assign_failed repo=${repo} issue=#${issueNumber} ` +
        `user=${githubUser} reason=${reason} error=${message}`,
    );
    // No assignment happened, and we have not posted a claim comment yet,
    // so there is nothing to clean up.
    return {
      ok: true,
      value: { claimed: false, reason, reasonDetail: message },
    };
  }

  // Step 3: Post a claim comment with unique worker identity (Issue #604).
  // When markerOptions is set, the body also carries an initial heartbeat
  // marker so claim and heartbeat share one comment (Issue #1628).
  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      claimCommentBody,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[claim_issue] claim_comment_failed repo=${repo} issue=#${issueNumber} ` +
        `user=${githubUser} error=${message}`,
    );
    // Failed to post claim comment — back off
    try {
      await ghCommandFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        githubUser,
      ]);
    } catch {
      // Best-effort unassign
    }
    return {
      ok: true,
      value: {
        claimed: false,
        reason: "comment_failed",
        reasonDetail: message,
      },
    };
  }

  // Step 4: Brief pause for GitHub's eventual consistency to settle
  await sleepFn(3000);

  // Step 5: Re-read comments to check for competing claims (Issue #604)
  let allClaimComments: ClaimComment[];
  try {
    const commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${CLAIM_MARKER_PREFIX}")) | {id: .id, body: .body, created_at: .created_at, author: .user.login}]`,
    ]);
    // Issue #3664: a CLAIM_LOCK marker from outside the fleet is forged —
    // discard it before the earliest-wins comparison so an outsider cannot
    // make this worker abandon the issue it has just claimed.
    allClaimComments = filterFleetClaimComments(
      parseClaimComments(commentsJson),
      trustedClaimAuthors,
      repo,
      issueNumber,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[claim_issue] verification_failed repo=${repo} issue=#${issueNumber} ` +
        `user=${githubUser} error=${message}`,
    );
    // Failed to read comments — back off
    await removeOwnClaimComment(repo, issueNumber, workerId, ghCommandFn);
    try {
      await ghCommandFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        githubUser,
      ]);
    } catch {
      // Best-effort
    }
    return {
      ok: true,
      value: {
        claimed: false,
        reason: "verification_failed",
        reasonDetail: message,
      },
    };
  }

  // Common finalisation for a won claim: run the live fleet-PR re-check
  // (Issue #3150) then either abort (fleet PR exists) or seed the marker
  // state and return success.
  const finalise = (competingWorkerCount: number) =>
    finaliseWonClaim({
      repo,
      issueNumber,
      githubUser,
      workerId,
      competingWorkerCount,
      fleetAuthors,
      pushCapableAuthors,
      milestoneTitle,
      cache,
      ghCommandFn,
      allClaimComments,
      claimPrefix,
      initialEpoch,
      markerOptions,
    });

  // Step 6: Verify exclusive claim (Issue #1090: log race outcomes)
  if (allClaimComments.length <= 1) {
    return await finalise(0);
  }

  // Multiple claims detected — earliest comment wins (Issue #604)
  const competingWorkerCount = allClaimComments.length - 1;
  const sorted = [...allClaimComments].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  const earliest = sorted[0];
  const winnerId = earliest !== undefined
    ? extractWorkerIdFromComment(earliest.body)
    : undefined;

  if (winnerId === workerId) {
    console.error(
      `[claim_issue] repo=${repo} issue=#${issueNumber} claim_race=won competing_workers=${competingWorkerCount} worker=${workerId}`,
    );
    return await finalise(competingWorkerCount);
  }

  // Lost — log and clean up
  incrementCounter("claimConflicts");
  console.error(
    `[claim_issue] repo=${repo} issue=#${issueNumber} claim_race=lost competing_workers=${competingWorkerCount} worker=${workerId} winner=${winnerId}`,
  );
  await removeOwnClaimComment(repo, issueNumber, workerId, ghCommandFn);
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-assignee",
      githubUser,
    ]);
  } catch {
    // Best-effort
  }

  return {
    ok: true,
    value: {
      claimed: false,
      winnerId,
      competingWorkerCount,
      reason: "race_lost",
    },
  };
}

/**
 * Detect claim/release churn and escalate if threshold met.
 *
 * Counts the number of times an issue has been unassigned by the specified
 * user (indicating a claim-then-release cycle). If the count meets or
 * exceeds the threshold, the issue is escalated to planning mode.
 *
 * Issue #861: Detect issues that are too complex for direct implementation.
 * Issue #869: Only count unassignment events for the worker user.
 */
export async function checkClaimChurn(
  options: ClaimChurnOptions,
): Promise<Result<ClaimChurnResult>> {
  const {
    repo,
    issueNumber,
    githubUser,
    threshold = 3,
    failedLabel = "failed",
    allowedAuthors = [],
    ghCommandFn = runGhCommand,
  } = options;

  // Query issue events timeline and count "unassigned" events
  let eventsJson: string;
  try {
    eventsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/events`,
      "--jq",
      `[.[] | select(.event == "unassigned")]`,
    ]);
  } catch {
    return { ok: true, value: { churnCount: 0, escalated: false } };
  }

  // Issue #869: Filter to only count unassignments of the worker user.
  // Time window: events older than 10 minutes but within 24 hours.
  // The 10-minute exclusion prevents self-reinforcing loops where churn
  // detection unassigns the worker, creating a new event that triggers
  // churn detection again on the next attempt.
  // Debounce: only count events 30+ minutes apart — genuine churn has
  // gaps between attempts, rapid-fire claim/unclaim loops do not.
  let churnCount: number;
  try {
    const events: unknown = JSON.parse(eventsJson);
    if (!Array.isArray(events)) {
      return { ok: true, value: { churnCount: 0, escalated: false } };
    }
    // Only look at events from the current session (~1 hour). Events from
    // previous sessions are historical — a new session means fresh code
    // that may have fixed the underlying issue. This prevents infrastructure
    // failures from one session blocking retries in the next.
    const windowStart = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
    const recentEvents = (events as Array<Record<string, unknown>>)
      .filter((e) => {
        const assignee = e.assignee as Record<string, unknown> | undefined;
        if (assignee?.login !== githubUser) return false;
        const createdAt = String(e.created_at ?? "");
        return createdAt >= windowStart && createdAt <= windowEnd;
      })
      .map((e) => new Date(String(e.created_at ?? "")).getTime())
      .sort((a, b) => a - b);

    // Count only events that are at least 30 minutes apart from the previous
    churnCount = 0;
    let lastCounted = 0;
    for (const ts of recentEvents) {
      if (ts - lastCounted >= DEBOUNCE_MS) {
        churnCount++;
        lastCounted = ts;
      }
    }
  } catch {
    return { ok: true, value: { churnCount: 0, escalated: false } };
  }

  if (churnCount < threshold) {
    return { ok: true, value: { churnCount, escalated: false } };
  }

  // Churn threshold met — mark as failed and notify allowed authors (Issue #861, #999)
  const mentionLine = allowedAuthors.length > 0
    ? `\n\ncc ${
      allowedAuthors.map((a) => `@${a}`).join(" ")
    } — please add the \`planning\` label to escalate this issue to planning mode.`
    : "";
  const churnComment =
    `## Claim Churn Detected\n\nThis issue has been claimed and released ${churnCount} times (threshold: ${threshold}). Marking as failed — a human should review whether this issue needs to be broken down into smaller tasks.${mentionLine}`;

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      churnComment,
    ]);
  } catch {
    // Best-effort
  }

  // Ensure the failed label exists before adding it (Issue #1215)
  await ensureLabelExists(
    repo,
    failedLabel,
    "d73a4a",
    "Issue failed permanently after two attempts",
    { ghCommandFn },
  );

  // Issue #976: Use REST API with CLI fallback for label operations
  // Issue #978: Label-add is non-fatal — the comment is the primary signal
  const labelResult = await addLabelToIssue(repo, issueNumber, failedLabel, {
    ghCommandFn,
  });
  if (!labelResult.ok) {
    console.warn(
      `[claim_issue] Warning: Failed to add '${failedLabel}' label to issue #${issueNumber} in ${repo} — continuing workflow (Issue #978)`,
    );
  }

  // Unassign the worker
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-assignee",
      githubUser,
    ]);
  } catch {
    // Best-effort
  }

  // Issue #1087: Post cross-worker cooldown signal so other workers skip this issue
  await postCooldownComment(repo, issueNumber, githubUser, ghCommandFn);

  return { ok: true, value: { churnCount, escalated: true } };
}

// ---------------------------------------------------------------------------
// releaseClaimWithCooldown
// ---------------------------------------------------------------------------

/** Options for releasing a claim with a cooldown signal. */
export interface ReleaseClaimOptions {
  repo: string;
  issueNumber: number;
  githubUser: string;
  workerId: string;
  /** Injected gh command function (for testing). Defaults to runGhCommand. */
  ghCommandFn?: (args: string[]) => Promise<string>;
}

/**
 * Release an issue claim and post a cross-worker cooldown signal.
 *
 * Called when a worker fails on an issue and needs to unassign. Posts a
 * hidden cooldown comment so other workers know to skip the issue for
 * the cooldown period.
 *
 * Issue #1087: Share cooldown state across workers via GitHub issue comments.
 *
 * @returns Result indicating success or failure
 */
export async function releaseClaimWithCooldown(
  options: ReleaseClaimOptions,
): Promise<Result<void>> {
  const {
    repo,
    issueNumber,
    githubUser,
    workerId,
    ghCommandFn = runGhCommand,
  } = options;

  // Unassign the worker
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-assignee",
      githubUser,
    ]);
  } catch {
    // Non-critical — continue to post cooldown
  }

  // Post cross-worker cooldown signal (Issue #1087)
  const cooldownResult = await postCooldownComment(
    repo,
    issueNumber,
    workerId,
    ghCommandFn,
  );

  if (!cooldownResult.ok) {
    console.warn(
      `[claim_issue] Warning: Failed to post cooldown signal for issue #${issueNumber} in ${repo} — continuing (Issue #1087)`,
    );
  }

  return { ok: true, value: undefined };
}
