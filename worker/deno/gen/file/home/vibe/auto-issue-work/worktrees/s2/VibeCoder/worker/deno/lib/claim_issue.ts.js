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
 */ import { LABEL_DEFAULTS } from "./config_defaults.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { runGhCommand } from "./github.ts";
import { DEFAULT_MARKER_REFRESH_SECONDS, formatHeartbeatMarker, scanHeartbeatMarkers, seedMarkerState } from "./heartbeat_storage.ts";
import { describeBlockingPr, fetchOpenPRsForFleet, getBlockingPRForIssue } from "./issue_query.ts";
import { sharedProcessedIssues } from "./processed_issue_registry.ts";
import { postCooldownComment } from "./shared_cooldown.ts";
import { checkStreamAffinity } from "./stream_holder.ts";
import { checkMilestoneStreamBusy, formatStreamBusy } from "./stream_lock.ts";
import { getHostname } from "./worker_identity.ts";
import { admitCompletionWork, COMPLETION_PENDING_MARKER } from "./completion_admission.ts";
import { makeGitHubCompletionStore } from "./completion_admission_github.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
/** The claim marker prefix used in issue comments for tie-breaking. */ export const CLAIM_MARKER_PREFIX = "<!-- CLAIM_LOCK:";
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Maximum age (in milliseconds) for a CLAIM_LOCK comment to be considered
 * recent.
 *
 * Exported for the stream lock (Issue #2334), which reads a sibling issue's
 * claim comments by the same window — a claim younger than this belongs to a
 * run whose first heartbeat refresh has not landed yet.
 */ export const RECENT_CLAIM_WINDOW_MS = 60_000;
/**
 * Minimum age a CLAIM_LOCK comment must reach before the stale-claim
 * cleanup may delete it (Issue #3664). Anything younger is a live claim —
 * possibly a fleet sibling's in-flight claim — not the leftover of a
 * crashed previous run.
 */ const STALE_CLAIM_MIN_AGE_MS = RECENT_CLAIM_WINDOW_MS;
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
 */ export function resolveTrustedClaimAuthors(githubUser, fleetAuthors) {
  const fleet = (fleetAuthors ?? []).filter((a)=>typeof a === "string" && a.trim().length > 0);
  if (fleet.length > 0) return fleet;
  return typeof githubUser === "string" && githubUser.trim().length > 0 ? [
    githubUser
  ] : [];
}
/**
 * Discard CLAIM_LOCK comments that were not posted by a fleet account
 * (Issue #3664). An empty `trustedAuthors` disables the filter.
 */ function filterFleetClaimComments(comments, trustedAuthors, repo, issueNumber) {
  if (trustedAuthors.length === 0) return comments;
  const kept = comments.filter((c)=>isFleetAuthor(c.author, trustedAuthors));
  const discarded = comments.length - kept.length;
  if (discarded > 0) {
    console.warn(`[claim_issue] repo=${repo} issue=#${issueNumber} ` + `discarded_claim_markers=${discarded} reason=non_fleet_author — a ` + `CLAIM_LOCK marker from outside the fleet cannot win the claim race ` + `(Issue #3664)`);
  }
  return kept;
}
/**
 * Classify a `gh` error message into a structured ClaimFailureReason
 * (Issue #2325). Pattern-matches on HTTP status codes and validation
 * keywords surfaced via `runGhCommandRaw` (which embeds gh stderr in the
 * Error message).
 */ export function classifyGhAssignError(message) {
  if (!message) return "api_error";
  const lower = message.toLowerCase();
  // 422 with an "assignees" / "is invalid" validation error means the
  // user is not a collaborator on the repo. gh's stderr reads e.g.
  // "HTTP 422: Validation Failed (...) - 'assignees' is invalid".
  if (lower.includes("422") || lower.includes("validation failed") || lower.includes("assignee") && lower.includes("invalid")) {
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
 * How recently a heartbeat marker must have beaten for the issue to count as
 * held by a live run (Issue #214).
 *
 * Twice the interval at which a marker comment is refreshed — the only beat
 * rate another host can observe. The in-process heartbeat timer fires every
 * {@link DEFAULT_HEARTBEAT_INTERVAL_MS}, but a beat only reaches GitHub every
 * {@link DEFAULT_MARKER_REFRESH_SECONDS}, so a healthy claim's published
 * marker is routinely one refresh old. One missed refresh is tolerated;
 * beyond that the run is gone and the ordinary stale-assignment recovery
 * (default 1800 s, comfortably longer than this window) takes over.
 */ export const LIVE_HEARTBEAT_WINDOW_SECONDS = 2 * DEFAULT_MARKER_REFRESH_SECONDS;
/**
 * Pick the most recent heartbeat marker that is still beating (Issue #214).
 *
 * A released claim's marker carries epoch 0 plus the `cleared:` signal and is
 * ignored, as is a marker older than `windowSeconds`. Returns null when no
 * marker qualifies — the issue is genuinely free.
 *
 * @param markers - Markers parsed from the issue's comments (fleet-authored
 *   only; a forged marker must never keep the fleet off an issue).
 * @param nowSeconds - Current epoch seconds.
 * @param windowSeconds - Freshness window, default
 *   {@link LIVE_HEARTBEAT_WINDOW_SECONDS}.
 */ export function findLiveHeartbeatMarker(markers, nowSeconds, windowSeconds = LIVE_HEARTBEAT_WINDOW_SECONDS) {
  let live = null;
  for (const marker of markers){
    if (marker.cleared) continue;
    if (!Number.isFinite(marker.epoch) || marker.epoch <= 0) continue;
    const ageSeconds = Math.max(0, nowSeconds - marker.epoch);
    if (ageSeconds > windowSeconds) continue;
    if (live === null || marker.epoch > live.epoch) {
      live = {
        machineId: marker.machineId,
        epoch: marker.epoch,
        ageSeconds
      };
    }
  }
  return live;
}
/**
 * Live-heartbeat availability check for an unassigned issue (Issue #214).
 *
 * The assignee is the claim lock every host checks, so an issue whose
 * assignee was dropped mid-run reads as free — and a sibling host starts a
 * second agent on the same issue and branch. A marker that beat inside
 * {@link LIVE_HEARTBEAT_WINDOW_SECONDS} proves a run still holds it, so the
 * claim is refused and the broken invariant is logged at WARNING.
 *
 * Fails open on any API error, matching the other pre-claim checks: an
 * unreachable GitHub must not stop the fleet claiming work.
 */ async function liveHeartbeatWithoutAssigneeCheck(repo, issueNumber, ghCommandFn, allowedAuthors, nowSeconds) {
  let markers;
  try {
    markers = await scanHeartbeatMarkers(repo, issueNumber, ghCommandFn, allowedAuthors);
  } catch  {
    return null; // Fail open — proceed with the claim
  }
  const live = findLiveHeartbeatMarker(markers, nowSeconds);
  if (live === null) return null;
  console.warn(`[claim_issue] repo=${repo} issue=#${issueNumber} ` + `heartbeat_active_without_assignee machine=${live.machineId} ` + `last_beat_age=${live.ageSeconds}s — the claim lock was dropped while ` + `the run is still beating; refusing to claim so a second agent is not ` + `started on the same issue (Issue #214)`);
  return live;
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
 *
 * Issue #2334: Check 3 refuses an issue whose milestone stream another open
 * sibling is already running. It runs here, before the assignment and before
 * the claim comment, so a blocked issue costs no assignment churn — and it
 * runs only when `streamLock` is supplied, so a fleet with session resume off
 * makes no extra API call.
 *
 * Issue #2336: Check 4 defers an issue whose milestone stream another host
 * holds, for as long as that host's head start lasts. It runs last of the
 * four, because it is the only one that can change its mind on a later scan.
 */ async function preClaimFreshnessCheck(repo, issueNumber, ghCommandFn, allowedAuthors = [], nowSeconds = Math.floor(Date.now() / 1000), streamLock) {
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
      "[.assignees[].login]"
    ]);
    const trimmed = assigneesJson.trim();
    if (trimmed && trimmed !== "[]" && trimmed !== "null") {
      try {
        const assignees = JSON.parse(trimmed);
        if (Array.isArray(assignees) && assignees.length > 0) {
          return {
            shouldBailOut: true,
            reason: "already_assigned"
          };
        }
      } catch  {
      // Non-JSON response — fall through
      }
    }
  } catch  {
  // Fail open — proceed with claim
  }
  // Check 1b (Issue #214): the issue is unassigned, but a heartbeat that
  // beat within the live window means a run still holds it — the claim lock
  // was dropped out from under it. Treat it as unavailable.
  const liveHeartbeat = await liveHeartbeatWithoutAssigneeCheck(repo, issueNumber, ghCommandFn, allowedAuthors, nowSeconds);
  if (liveHeartbeat !== null) {
    return {
      shouldBailOut: true,
      reason: "heartbeat_active",
      reasonDetail: `machine ${liveHeartbeat.machineId} beat ` + `${liveHeartbeat.ageSeconds}s ago with no assignee`
    };
  }
  // Check 2: Look for recent CLAIM_LOCK comments (within last 60 seconds)
  try {
    const commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${CLAIM_MARKER_PREFIX}")) | {id: .id, body: .body, created_at: .created_at, author: .user.login}]`
    ]);
    const parsed = JSON.parse(commentsJson);
    if (Array.isArray(parsed)) {
      const now = Date.now();
      const filterByAuthor = allowedAuthors.length > 0;
      for (const comment of parsed){
        // Issue #3164: ignore a forged CLAIM_LOCK from a non-fleet author
        // when a fleet allow-list was supplied (fail toward allowing the
        // claim).
        if (filterByAuthor && !isFleetAuthor(comment.author, allowedAuthors)) {
          continue;
        }
        const createdAt = String(comment.created_at ?? "");
        if (createdAt) {
          const commentAge = now - new Date(createdAt).getTime();
          if (commentAge >= 0 && commentAge < RECENT_CLAIM_WINDOW_MS) {
            return {
              shouldBailOut: true,
              reason: "recent_claim"
            };
          }
        }
      }
    }
  } catch  {
  // Fail open — proceed with claim
  }
  // Check 3 (Issue #2334): one run per milestone stream at a time,
  // fleet-wide. A sibling open issue of the same milestone with a beating
  // heartbeat — or a claim posted seconds ago — means a run is already inside
  // this stream's conversation, so this issue waits for a later scan. Not a
  // failure: no label, no churn record, no cooldown.
  if (streamLock !== undefined) {
    const stream = await checkMilestoneStreamBusy({
      repo,
      issueNumber,
      ghCommandFn,
      trustedAuthors: allowedAuthors,
      nowSeconds,
      ...streamLock.milestoneTitle ? {
        milestoneTitle: streamLock.milestoneTitle
      } : {}
    });
    if (stream.busy) {
      // Issue #2530: a `top-priority` or `work-on` issue is wanted now, so it
      // joins the busy stream instead of waiting — in its own per-issue
      // conversation, so the stream's transcript still carries one run. The
      // affinity head start below is skipped with it: a second holder has no
      // conversation to hand over.
      if (streamLock.shareable) {
        const { busy: _busy, ...shared } = stream;
        console.info(`[claim_issue] repo=${repo} issue=#${issueNumber} stream shared: ` + `${shared.streamLabel} held by #${shared.holderIssue} on ` + `${shared.holderHost} — claiming into a per-issue session ` + `(Issue #2527)`);
        return {
          shouldBailOut: false,
          streamShared: shared
        };
      }
      const detail = formatStreamBusy(stream);
      console.info(`[claim_issue] repo=${repo} issue=#${issueNumber} ${detail} — ` + `retried on a later scan (Issue #2334)`);
      return {
        shouldBailOut: true,
        reason: "stream_busy",
        reasonDetail: detail
      };
    }
  }
  // Check 4 (Issue #2336): the stream's conversation lives on one host's disk,
  // so the host that ran it last gets its next issue first. A non-holder waits
  // out that head start and takes the issue on a later scan if the holder has
  // not come back. Not a failure, and never a lock: after the grace the first
  // host to scan claims it and starts the conversation afresh.
  if (streamLock?.affinityHost) {
    const affinity = await checkStreamAffinity({
      repo,
      issueNumber,
      thisHost: streamLock.affinityHost,
      ghCommandFn,
      trustedAuthors: allowedAuthors,
      nowSeconds,
      ...streamLock.milestoneTitle ? {
        milestoneTitle: streamLock.milestoneTitle
      } : {},
      ...streamLock.workDir ? {
        workDir: streamLock.workDir
      } : {}
    });
    // The countdown is logged by `checkStreamAffinity` itself, once per issue
    // — repeating it here would double every deferral in the fleet log.
    if (affinity.defer && affinity.detail) {
      return {
        shouldBailOut: true,
        reason: "stream_affinity",
        reasonDetail: affinity.detail
      };
    }
  }
  return {
    shouldBailOut: false
  };
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
 *
 * Issue #181: this read must never be served from the `IssueCache` — a stale
 * "OPEN" here is exactly what lets a closed issue be claimed. `ghCommandFn`
 * defaults to the uncached `runGhCommand`, and callers must not pass a
 * cache-backed reader in its place.
 */ export async function fetchIssueState(repo, issueNumber, ghCommandFn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const sleepFn = options.sleepFn ?? defaultSleep;
  let lastError;
  for(let attempt = 1; attempt <= maxAttempts; attempt++){
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
        ".state"
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
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.warn(`[claim_issue] fetch_issue_state_failed repo=${repo} issue=#${issueNumber} ` + `attempts=${maxAttempts} error=${message} — treating as CLOSED to avoid ` + `starting work on a possibly-merged issue (Issue #3151)`);
  return "CLOSED"; // Fail closed
}
/**
 * Default closed-this-run predicate (Issue #181) — the run's shared
 * processed-issue registry, which every `gh issue close` is recorded into at
 * the `gh` chokepoint.
 */ function defaultWasClosedThisRun(repo, issueNumber) {
  return sharedProcessedIssues().wasClosedByWorker(repo, issueNumber);
}
/**
 * Default sleep function — waits the given number of milliseconds.
 */ function defaultSleep(ms) {
  return new Promise((resolve)=>setTimeout(resolve, ms));
}
/**
 * Parse claim comments from a GitHub API JSON response.
 *
 * Expects a JSON array of objects with id, body, and created_at fields.
 */ function parseClaimComments(json) {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c)=>typeof c.body === "string" && c.body.includes(CLAIM_MARKER_PREFIX)).map((c)=>({
        id: Number(c.id),
        body: String(c.body),
        createdAt: String(c.created_at ?? c.createdAt ?? ""),
        author: typeof c.author === "string" ? c.author : undefined
      }));
  } catch  {
    return [];
  }
}
/**
 * Extract the worker ID from a claim comment body.
 *
 * Pattern: `<!-- CLAIM_LOCK:worker-name -->`
 */ export function extractWorkerIdFromComment(body) {
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
 */ async function cleanupStaleClaimComments(repo, issueNumber, ghCommandFn, trustedAuthors, nowMs = Date.now()) {
  let commentsJson;
  try {
    commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${CLAIM_MARKER_PREFIX}")) | {id: .id, created_at: .created_at, author: .user.login}]`
    ]);
  } catch  {
    return; // Best-effort
  }
  let entries;
  try {
    const parsed = JSON.parse(commentsJson);
    if (!Array.isArray(parsed)) return;
    entries = parsed;
  } catch  {
    return;
  }
  const filterByAuthor = trustedAuthors.length > 0;
  const ids = [];
  for (const entry of entries){
    if (entry === null || typeof entry !== "object") continue;
    const id = Number(entry.id);
    if (!Number.isFinite(id)) continue;
    if (filterByAuthor && !isFleetAuthor(entry.author, trustedAuthors)) {
      continue; // Not a fleet marker — not ours to delete
    }
    const createdMs = new Date(String(entry.created_at ?? "")).getTime();
    if (!Number.isFinite(createdMs)) continue; // Cannot prove it is stale
    if (nowMs - createdMs < STALE_CLAIM_MIN_AGE_MS) continue; // Still in flight
    ids.push(id);
  }
  for (const id of ids){
    try {
      await ghCommandFn([
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/issues/comments/${id}`
      ]);
    } catch  {
    // Best-effort cleanup
    }
  }
}
/**
 * Remove this worker's claim comment after losing a contested claim.
 */ async function removeOwnClaimComment(repo, issueNumber, workerId, ghCommandFn) {
  try {
    const commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | contains("CLAIM_LOCK:${workerId}")) | .id] | .[0] // empty`
    ]);
    const commentId = commentsJson.trim();
    if (commentId) {
      await ghCommandFn([
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/issues/comments/${commentId}`
      ]);
    }
  } catch  {
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
 */ async function seedMarkerStateForOwnComment(comments, workerId, claimPrefix, initialEpoch, markerOptions, repo, issueNumber) {
  if (!markerOptions) return;
  const own = comments.find((c)=>extractWorkerIdFromComment(c.body) === workerId);
  if (!own || !Number.isFinite(own.id)) return;
  try {
    await seedMarkerState(markerOptions.workDir, repo, issueNumber, {
      commentId: own.id,
      lastRefresh: initialEpoch,
      claimPrefix,
      // Issue #3752: the claim moment is the claim's start time, and the
      // worker id is shown in the visible heartbeat body on every refresh.
      startedEpoch: initialEpoch,
      workerId
    });
  } catch  {
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
 */ /**
 * Read the issue's labels now, bypassing every cache (Issue #831).
 *
 * Discovery excludes the blocking labels, but it ranks a snapshot of the
 * issue list; a label applied between that snapshot and this claim is
 * invisible to it. This is the label counterpart of the `wasClosedThisRun`
 * refusal (Issue #181) and of {@link liveFleetPrRecheck} (Issue #3150), and
 * it runs *before* the assignment so a parked issue collects neither an
 * assignee nor a claim comment.
 *
 * Fails open: any read failure returns `null` and the claim proceeds — a
 * `gh` hiccup must never withhold a legitimate claim. The reason is logged.
 *
 * @returns The first blocking label found on the issue, or `null`.
 */ async function liveBlockingLabelRecheck(repo, issueNumber, blockingLabels, ghCommandFn) {
  if (blockingLabels.length === 0) return null;
  try {
    const raw = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "labels"
    ]);
    const parsed = JSON.parse(raw);
    const present = new Set((parsed.labels ?? []).map((label)=>label?.name).filter((name)=>typeof name === "string").map((name)=>name.toLowerCase()));
    for (const label of blockingLabels){
      if (present.has(label.toLowerCase())) return label;
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[claim_issue] blocking_label_recheck_failed repo=${repo} ` + `issue=#${issueNumber} — proceeding with the claim: ${message}`);
    return null;
  }
}
async function liveFleetPrRecheck(repo, issueNumber, fleetAuthors, pushCapableAuthors, milestoneTitle, cache, ghCommandFn, fleetPrSlots) {
  const authors = (fleetAuthors ?? []).filter((a)=>typeof a === "string" && a.trim().length > 0);
  if (authors.length === 0) return null;
  try {
    const prs = await fetchOpenPRsForFleet(repo, authors, cache, ghCommandFn, undefined, true);
    return getBlockingPRForIssue(prs, milestoneTitle ?? "", pushCapableAuthors ?? [], fleetPrSlots, issueNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[claim_issue] fleet_pr_recheck_failed repo=${repo} issue=#${issueNumber} ` + `error=${message}`);
    return null; // Fail open
  }
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
 */ async function finaliseWonClaim(params) {
  const { repo, issueNumber, githubUser, workerId, competingWorkerCount, fleetAuthors, pushCapableAuthors, milestoneTitle, fleetPrSlots, completionAdmission, cache, ghCommandFn, allClaimComments, claimPrefix, initialEpoch, markerOptions } = params;
  const blockingPr = await liveFleetPrRecheck(repo, issueNumber, fleetAuthors, pushCapableAuthors, milestoneTitle, cache, ghCommandFn, completionAdmission ? Number.MAX_SAFE_INTEGER : fleetPrSlots);
  if (blockingPr) {
    incrementCounter("claimConflicts");
    // Issue #4078: name the blocking PR's author. The claim path only
    // stands down (no PR is ever touched here); the `work-on` scan that
    // sees the same block escalates `needs-human` on the issue, so the
    // author in this line ties the abort to that escalation.
    console.error(`[claim_issue] repo=${repo} issue=#${issueNumber} claim_abort=fleet_pr_exists ` + `blocking_pr=#${blockingPr.number} ` + `blocking_pr_author=${blockingPr.author || "(unknown)"} ` + `worker=${workerId}`);
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
        githubUser
      ]);
    } catch  {
    // Best-effort
    }
    return {
      ok: true,
      value: {
        claimed: false,
        competingWorkerCount,
        reason: "fleet_pr_exists",
        reasonDetail: blockingPr.fleetPrCap ? `open ${describeBlockingPr(blockingPr)} — one fleet PR per slot` : `open PR #${blockingPr.number} already targets this work stream`
      }
    };
  }
  if (completionAdmission) {
    let reason;
    try {
      const own = allClaimComments.find((c)=>extractWorkerIdFromComment(c.body) === workerId);
      if (!own || !markerOptions) {
        throw new Error("Implementation reservation requires a claim heartbeat");
      }
      const base = milestoneTitle ? createMilestoneBranchName(milestoneTitle) : (await ghCommandFn([
        "api",
        `repos/${repo}`,
        "--jq",
        ".default_branch"
      ])).trim();
      if (!base || base === "null") {
        throw new Error("Cannot resolve implementation target branch");
      }
      const verdict = await admitCompletionWork(makeGitHubCompletionStore({
        repo,
        workerId,
        fleetAuthors: pushCapableAuthors ?? [
          githubUser
        ],
        ghCommandFn,
        sleepFn: params.sleepFn
      }), completionAdmission, {
        issue: issueNumber,
        base,
        claimId: own.id,
        workerId
      });
      console.info(`[completion_admission] ${repo}#${issueNumber} pressure=${verdict.pressure} mode=${verdict.mode}: ${verdict.reason}`);
      if (!verdict.allowed) reason = verdict.reason;
    } catch (error) {
      reason = `shared capacity unavailable; retry next scan: ${error}`;
    }
    if (reason) {
      await removeOwnClaimComment(repo, issueNumber, workerId, ghCommandFn);
      try {
        await ghCommandFn([
          "issue",
          "edit",
          String(issueNumber),
          "--repo",
          repo,
          "--remove-assignee",
          githubUser
        ]);
      } catch (error) {
        console.warn(`[completion_admission] claim assignment cleanup failed: ${error}`);
      }
      return {
        ok: true,
        value: {
          claimed: false,
          competingWorkerCount,
          reason: "completion_mode",
          reasonDetail: reason
        }
      };
    }
  }
  await seedMarkerStateForOwnComment(allClaimComments, workerId, claimPrefix, initialEpoch, markerOptions, repo, issueNumber);
  return {
    ok: true,
    value: {
      claimed: true,
      winnerId: workerId,
      competingWorkerCount
    }
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
 */ export async function claimIssue(options) {
  const { repo, issueNumber, githubUser, workerId, hostname, sleepFn = defaultSleep, ghCommandFn = runGhCommand, markerOptions, fleetAuthors, pushCapableAuthors, milestoneTitle, fleetPrSlots, cache, wasClosedThisRun = defaultWasClosedThisRun, blockingLabels = [
    LABEL_DEFAULTS.needsHumanLabel
  ], streamLockEnabled = false, streamShareable = false } = options;
  // Issue #181: the worker closed this issue earlier in this run, so no
  // amount of cached "OPEN" can make it claimable. Refused before any API
  // call — the scan only offered it because the issue list it ranked (600 s
  // TTL) was written before the close.
  if (wasClosedThisRun(repo, issueNumber)) {
    console.warn(`[claim_issue] claim_refused repo=${repo} issue=#${issueNumber} ` + `reason=closed_by_this_run — the scan ranked a cached issue list ` + `written before this worker closed it (Issue #181)`);
    return {
      ok: true,
      value: {
        claimed: false,
        reason: "already_closed",
        reasonDetail: "this worker closed the issue earlier in this run"
      }
    };
  }
  // Issue #831: a blocking label applied since the scan's snapshot. The
  // worker itself is a common source — a grill-me round ends by adding
  // `needs-human` — so an issue parked seconds ago can still be top of a
  // ranked list written before it. Checked live, before the assignment and
  // the claim comment, so a parked issue collects neither.
  const blockingLabel = await liveBlockingLabelRecheck(repo, issueNumber, blockingLabels, ghCommandFn);
  if (blockingLabel) {
    incrementCounter("claimConflicts");
    console.warn(`[claim_issue] claim_refused repo=${repo} issue=#${issueNumber} ` + `reason=blocking_label label=${blockingLabel} — applied between the ` + `scan's snapshot and this claim (Issue #831)`);
    return {
      ok: true,
      value: {
        claimed: false,
        reason: "blocking_label",
        reasonDetail: `the issue carries \`${blockingLabel}\`, applied after the scan ` + `ranked it`
      }
    };
  }
  // Resolve the host that is making the claim. Surfacing the hostname in
  // the visible comment lets operators jump directly to the right machine
  // when they need to inspect logs after a failure (Issue #2034).
  const claimingHost = hostname && hostname.length > 0 ? hostname : getHostname();
  // Build the claim comment body. When markerOptions is provided, embed an
  // initial heartbeat marker so the claim and heartbeat live in the same
  // comment (Issue #1628).
  const claimPrefix = `${CLAIM_MARKER_PREFIX}${workerId} -->\nClaimed by \`${workerId}\` on host \`${claimingHost}\``;
  const initialEpoch = markerOptions?.nowFn ? markerOptions.nowFn() : Math.floor(Date.now() / 1000);
  const claimCommentBody = (markerOptions ? `${claimPrefix}\n${formatHeartbeatMarker(markerOptions.machineId, initialEpoch)}` : claimPrefix) + (options.completionAdmission ? `\n${COMPLETION_PENDING_MARKER}` : "");
  // Authors whose CLAIM_LOCK markers this worker trusts (Issue #3664).
  // Every marker-driven decision below — the pre-claim check, the stale
  // cleanup and the Step-5 race resolution — is gated on this set, because
  // a marker in a comment body is not an authenticated channel.
  const trustedClaimAuthors = resolveTrustedClaimAuthors(githubUser, fleetAuthors);
  // Pre-claim freshness re-check (Issue #1086): Re-fetch assignees and
  // recent claim comments to narrow the race window between scan and claim.
  const freshnessCheck = await preClaimFreshnessCheck(repo, issueNumber, ghCommandFn, trustedClaimAuthors, Math.floor(Date.now() / 1000), // Issue #2334: the milestone stream lock, only for a run that joins a
  // stream. Omitted here means the check — and its `gh issue list` — never
  // happens.
  //
  // Issue #2336: the same flag carries this host's identity for the affinity
  // head start. The machine id is preferred because that is what the holder
  // marker records; the claiming host's name is the fallback, and the two
  // compare equal because affinity matches on the host part alone.
  // Issue #2530: `shareable` turns the stream-busy skip into a second
  // holder on a per-issue conversation, for the tiers a human wants now.
  streamLockEnabled ? {
    affinityHost: markerOptions?.machineId ?? claimingHost,
    shareable: streamShareable,
    ...milestoneTitle ? {
      milestoneTitle
    } : {},
    ...markerOptions?.workDir ? {
      workDir: markerOptions.workDir
    } : {}
  } : undefined);
  if (freshnessCheck.shouldBailOut) {
    return {
      ok: true,
      value: {
        claimed: false,
        reason: freshnessCheck.reason,
        ...freshnessCheck.reasonDetail ? {
          reasonDetail: freshnessCheck.reasonDetail
        } : {}
      }
    };
  }
  // Step 0: Verify the issue is still open before attempting to claim.
  // A merged PR on another machine may have auto-closed the issue since
  // this worker discovered it (race condition with multi-machine workers).
  const issueState = await fetchIssueState(repo, issueNumber, ghCommandFn, {
    sleepFn
  });
  if (issueState !== "OPEN") {
    return {
      ok: true,
      value: {
        claimed: false,
        reason: "already_closed"
      }
    };
  }
  // Step 1: Remove any stale claim comments from previous runs (Issue #604)
  await cleanupStaleClaimComments(repo, issueNumber, ghCommandFn, trustedClaimAuthors);
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
      githubUser
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = classifyGhAssignError(message);
    console.warn(`[claim_issue] assign_failed repo=${repo} issue=#${issueNumber} ` + `user=${githubUser} reason=${reason} error=${message}`);
    // No assignment happened, and we have not posted a claim comment yet,
    // so there is nothing to clean up.
    return {
      ok: true,
      value: {
        claimed: false,
        reason,
        reasonDetail: message
      }
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
      claimCommentBody
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[claim_issue] claim_comment_failed repo=${repo} issue=#${issueNumber} ` + `user=${githubUser} error=${message}`);
    // Failed to post claim comment — back off
    try {
      await ghCommandFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        githubUser
      ]);
    } catch  {
    // Best-effort unassign
    }
    return {
      ok: true,
      value: {
        claimed: false,
        reason: "comment_failed",
        reasonDetail: message
      }
    };
  }
  // Step 4: Brief pause for GitHub's eventual consistency to settle
  await sleepFn(3000);
  // Step 5: Re-read comments to check for competing claims (Issue #604)
  let allClaimComments;
  try {
    const commentsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      `[.[] | select(.body | test("${CLAIM_MARKER_PREFIX}")) | {id: .id, body: .body, created_at: .created_at, author: .user.login}]`
    ]);
    // Issue #3664: a CLAIM_LOCK marker from outside the fleet is forged —
    // discard it before the earliest-wins comparison so an outsider cannot
    // make this worker abandon the issue it has just claimed.
    allClaimComments = filterFleetClaimComments(parseClaimComments(commentsJson), trustedClaimAuthors, repo, issueNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[claim_issue] verification_failed repo=${repo} issue=#${issueNumber} ` + `user=${githubUser} error=${message}`);
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
        githubUser
      ]);
    } catch  {
    // Best-effort
    }
    return {
      ok: true,
      value: {
        claimed: false,
        reason: "verification_failed",
        reasonDetail: message
      }
    };
  }
  // Common finalisation for a won claim: run the live fleet-PR re-check
  // (Issue #3150) then either abort (fleet PR exists) or seed the marker
  // state and return success.
  const finalise = async (competingWorkerCount)=>{
    const won = await finaliseWonClaim({
      repo,
      issueNumber,
      githubUser,
      workerId,
      competingWorkerCount,
      fleetAuthors,
      pushCapableAuthors,
      milestoneTitle,
      fleetPrSlots,
      completionAdmission: options.completionAdmission,
      sleepFn,
      cache,
      ghCommandFn,
      allClaimComments,
      claimPrefix,
      initialEpoch,
      markerOptions
    });
    // Issue #2530: a claim that shared a busy stream says so, so the caller
    // keeps this run on its own conversation.
    if (won.ok && won.value.claimed && freshnessCheck.streamShared) {
      return {
        ok: true,
        value: {
          ...won.value,
          streamShared: freshnessCheck.streamShared
        }
      };
    }
    return won;
  };
  // Step 6: Verify exclusive claim (Issue #1090: log race outcomes)
  if (allClaimComments.length <= 1) {
    return await finalise(0);
  }
  // Multiple claims detected — earliest comment wins (Issue #604)
  const competingWorkerCount = allClaimComments.length - 1;
  const sorted = [
    ...allClaimComments
  ].sort((a, b)=>a.createdAt.localeCompare(b.createdAt));
  const earliest = sorted[0];
  const winnerId = earliest !== undefined ? extractWorkerIdFromComment(earliest.body) : undefined;
  if (winnerId === workerId) {
    console.error(`[claim_issue] repo=${repo} issue=#${issueNumber} claim_race=won competing_workers=${competingWorkerCount} worker=${workerId}`);
    return await finalise(competingWorkerCount);
  }
  // Lost — log and clean up
  incrementCounter("claimConflicts");
  console.error(`[claim_issue] repo=${repo} issue=#${issueNumber} claim_race=lost competing_workers=${competingWorkerCount} worker=${workerId} winner=${winnerId}`);
  await removeOwnClaimComment(repo, issueNumber, workerId, ghCommandFn);
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-assignee",
      githubUser
    ]);
  } catch  {
  // Best-effort
  }
  return {
    ok: true,
    value: {
      claimed: false,
      winnerId,
      competingWorkerCount,
      reason: "race_lost"
    }
  };
}
/**
 * Detect claim/release churn and cool down if the threshold is met.
 *
 * Counts the number of times an issue has been unassigned by the specified
 * user (indicating a claim-then-release cycle). If the count meets or
 * exceeds the threshold, the issue is released with a churn record and a
 * cooldown signal. It is never parked (Issue #4158): no `failed` label and
 * no request for a human to add `planning`.
 *
 * Issue #861: Detect issues that are too complex for direct implementation.
 * Issue #869: Only count unassignment events for the worker user.
 */ export async function checkClaimChurn(options) {
  const { repo, issueNumber, githubUser, threshold = 3, ghCommandFn = runGhCommand } = options;
  // Query issue events timeline and count "unassigned" events
  let eventsJson;
  try {
    eventsJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/events`,
      "--jq",
      `[.[] | select(.event == "unassigned")]`
    ]);
  } catch  {
    return {
      ok: true,
      value: {
        churnCount: 0,
        escalated: false
      }
    };
  }
  // Issue #869: Filter to only count unassignments of the worker user.
  // Time window: events older than 10 minutes but within 24 hours.
  // The 10-minute exclusion prevents self-reinforcing loops where churn
  // detection unassigns the worker, creating a new event that triggers
  // churn detection again on the next attempt.
  // Debounce: only count events 30+ minutes apart — genuine churn has
  // gaps between attempts, rapid-fire claim/unclaim loops do not.
  let churnCount;
  try {
    const events = JSON.parse(eventsJson);
    if (!Array.isArray(events)) {
      return {
        ok: true,
        value: {
          churnCount: 0,
          escalated: false
        }
      };
    }
    // Only look at events from the current session (~1 hour). Events from
    // previous sessions are historical — a new session means fresh code
    // that may have fixed the underlying issue. This prevents infrastructure
    // failures from one session blocking retries in the next.
    const windowStart = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
    const recentEvents = events.filter((e)=>{
      const assignee = e.assignee;
      if (assignee?.login !== githubUser) return false;
      const createdAt = String(e.created_at ?? "");
      return createdAt >= windowStart && createdAt <= windowEnd;
    }).map((e)=>new Date(String(e.created_at ?? "")).getTime()).sort((a, b)=>a - b);
    // Count only events that are at least 30 minutes apart from the previous
    churnCount = 0;
    let lastCounted = 0;
    for (const ts of recentEvents){
      if (ts - lastCounted >= DEBOUNCE_MS) {
        churnCount++;
        lastCounted = ts;
      }
    }
  } catch  {
    return {
      ok: true,
      value: {
        churnCount: 0,
        escalated: false
      }
    };
  }
  if (churnCount < threshold) {
    return {
      ok: true,
      value: {
        churnCount,
        escalated: false
      }
    };
  }
  // Churn threshold met — record it and cool down (Issue #861). Issue
  // #4158: never `failed` and never a request for a human to add
  // `planning` — the issue is the Vibe Coder's to finish, so it stays
  // claimable once the cooldown ends. The posted text carries no VibeCoder
  // issue number (Issue #4641): GitHub would resolve a bare `#N` in the target repo.
  const churnComment = `## Claim Churn Detected\n\nThis issue has been claimed and released ${churnCount} times in the last hour (threshold: ${threshold}). The worker is releasing it and cooling down before the next attempt; it stays queued and is never parked.`;
  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      churnComment
    ]);
  } catch  {
  // Best-effort
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
      githubUser
    ]);
  } catch  {
  // Best-effort
  }
  // Issue #1087: Post cross-worker cooldown signal so other workers skip this issue
  await postCooldownComment(repo, issueNumber, githubUser, ghCommandFn);
  return {
    ok: true,
    value: {
      churnCount,
      escalated: true
    }
  };
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
 */ export async function releaseClaimWithCooldown(options) {
  const { repo, issueNumber, githubUser, workerId, ghCommandFn = runGhCommand } = options;
  // Unassign the worker
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-assignee",
      githubUser
    ]);
  } catch  {
  // Non-critical — continue to post cooldown
  }
  // Post cross-worker cooldown signal (Issue #1087)
  const cooldownResult = await postCooldownComment(repo, issueNumber, workerId, ghCommandFn);
  if (!cooldownResult.ok) {
    console.warn(`[claim_issue] Warning: Failed to post cooldown signal for issue #${issueNumber} in ${repo} — continuing (Issue #1087)`);
  }
  return {
    ok: true,
    value: undefined
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jbGFpbV9pc3N1ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEF0b21pYyBpc3N1ZSBjbGFpbWluZyB3aXRoIHZlcmlmaWNhdGlvbiB0byBwcmV2ZW50IG11bHRpLXdvcmtlciByYWNlXG4gKiBjb25kaXRpb25zIChJc3N1ZSAjNDMzLCAjNjA0LCAjOTExKS5cbiAqXG4gKiBXaGVuIG11bHRpcGxlIFZpYmUgQ29kZXJzIHNjYW4gZm9yIGlzc3VlcyBjb25jdXJyZW50bHksIHRoZXJlIGlzIGEgcmFjZVxuICogY29uZGl0aW9uIHdpbmRvdyBiZXR3ZWVuIGRpc2NvdmVyaW5nIGFuIHVuYXNzaWduZWQgaXNzdWUgYW5kIGFzc2lnbmluZyBpdC5cbiAqIFRoaXMgbW9kdWxlIGltcGxlbWVudHMgYSBjbGFpbS10aGVuLXZlcmlmeSBwYXR0ZXJuOlxuICpcbiAqICAgMS4gQXNzaWduIHRoZSB3b3JrZXIgdG8gdGhlIGlzc3VlIGltbWVkaWF0ZWx5XG4gKiAgIDIuIFBvc3QgYSBoaWRkZW4gY2xhaW0gY29tbWVudCB3aXRoIHRoZSB3b3JrZXIncyB1bmlxdWUgSURcbiAqICAgMy4gQnJpZWYgcGF1c2UgZm9yIEdpdEh1YidzIGV2ZW50dWFsIGNvbnNpc3RlbmN5XG4gKiAgIDQuIFJlLXJlYWQgdGhlIGlzc3VlJ3MgY29tbWVudHMgdG8gY2hlY2sgZm9yIGNvbXBldGluZyBjbGFpbXNcbiAqICAgNS4gRWFybGllc3QgY2xhaW0gY29tbWVudCB3aW5zOyBsb3NlcnMgY2xlYW4gdXAgYW5kIGJhY2sgb2ZmXG4gKlxuICogSXNzdWUgIzYwNDogV2hlbiBtdWx0aXBsZSB3b3JrZXJzIHNoYXJlIHRoZSBzYW1lIEdpdEh1YiB1c2VybmFtZSxcbiAqIGFzc2lnbmVlLWJhc2VkIHRpZS1icmVha2luZyBpcyBpbmVmZmVjdGl2ZS4gQ29tbWVudC1iYXNlZFxuICogdmVyaWZpY2F0aW9uIHNvbHZlcyB0aGlzIGJ5IHVzaW5nIHVuaXF1ZSB3b3JrZXIgSURzIGVtYmVkZGVkIGluIGhpZGRlblxuICogSFRNTCBjb21tZW50cy5cbiAqXG4gKiBNaWdyYXRlZCBmcm9tIHdvcmtlci9zaGFyZWQvY2xhaW1faXNzdWUuc2ggKElzc3VlICM5MTEpLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IElzc3VlQ2FjaGUgfSBmcm9tIFwiLi9pc3N1ZV9jYWNoZS50c1wiO1xuaW1wb3J0IHR5cGUgeyBCbG9ja2luZ1BSSW5mbyB9IGZyb20gXCIuL2lzc3VlX3F1ZXJ5LnRzXCI7XG5pbXBvcnQgeyBMQUJFTF9ERUZBVUxUUyB9IGZyb20gXCIuL2NvbmZpZ19kZWZhdWx0cy50c1wiO1xuaW1wb3J0IHsgaW5jcmVtZW50Q291bnRlciB9IGZyb20gXCIuL2ZhdWx0X3RvbGVyYW5jZV9jb3VudGVycy50c1wiO1xuaW1wb3J0IHsgaXNGbGVldEF1dGhvciB9IGZyb20gXCIuL2ZsZWV0X2F1dGhvcnMudHNcIjtcbmltcG9ydCB7IHJ1bkdoQ29tbWFuZCB9IGZyb20gXCIuL2dpdGh1Yi50c1wiO1xuaW1wb3J0IHtcbiAgREVGQVVMVF9NQVJLRVJfUkVGUkVTSF9TRUNPTkRTLFxuICBmb3JtYXRIZWFydGJlYXRNYXJrZXIsXG4gIHNjYW5IZWFydGJlYXRNYXJrZXJzLFxuICBzZWVkTWFya2VyU3RhdGUsXG59IGZyb20gXCIuL2hlYXJ0YmVhdF9zdG9yYWdlLnRzXCI7XG5pbXBvcnQge1xuICBkZXNjcmliZUJsb2NraW5nUHIsXG4gIGZldGNoT3BlblBSc0ZvckZsZWV0LFxuICBnZXRCbG9ja2luZ1BSRm9ySXNzdWUsXG59IGZyb20gXCIuL2lzc3VlX3F1ZXJ5LnRzXCI7XG5pbXBvcnQgeyBzaGFyZWRQcm9jZXNzZWRJc3N1ZXMgfSBmcm9tIFwiLi9wcm9jZXNzZWRfaXNzdWVfcmVnaXN0cnkudHNcIjtcbmltcG9ydCB7IHBvc3RDb29sZG93bkNvbW1lbnQgfSBmcm9tIFwiLi9zaGFyZWRfY29vbGRvd24udHNcIjtcbmltcG9ydCB7IGNoZWNrU3RyZWFtQWZmaW5pdHkgfSBmcm9tIFwiLi9zdHJlYW1faG9sZGVyLnRzXCI7XG5pbXBvcnQge1xuICBjaGVja01pbGVzdG9uZVN0cmVhbUJ1c3ksXG4gIGZvcm1hdFN0cmVhbUJ1c3ksXG4gIHR5cGUgU3RyZWFtQnVzeSxcbn0gZnJvbSBcIi4vc3RyZWFtX2xvY2sudHNcIjtcbmltcG9ydCB7IGdldEhvc3RuYW1lIH0gZnJvbSBcIi4vd29ya2VyX2lkZW50aXR5LnRzXCI7XG5cbmltcG9ydCB7XG4gIGFkbWl0Q29tcGxldGlvbldvcmssXG4gIENPTVBMRVRJT05fUEVORElOR19NQVJLRVIsXG4gIHR5cGUgQ29tcGxldGlvblBvbGljeSxcbn0gZnJvbSBcIi4vY29tcGxldGlvbl9hZG1pc3Npb24udHNcIjtcbmltcG9ydCB7IG1ha2VHaXRIdWJDb21wbGV0aW9uU3RvcmUgfSBmcm9tIFwiLi9jb21wbGV0aW9uX2FkbWlzc2lvbl9naXRodWIudHNcIjtcbmltcG9ydCB7IGNyZWF0ZU1pbGVzdG9uZUJyYW5jaE5hbWUgfSBmcm9tIFwiLi9naXRfYnJhbmNoLnRzXCI7XG5cbi8qKiBUaGUgY2xhaW0gbWFya2VyIHByZWZpeCB1c2VkIGluIGlzc3VlIGNvbW1lbnRzIGZvciB0aWUtYnJlYWtpbmcuICovXG5leHBvcnQgY29uc3QgQ0xBSU1fTUFSS0VSX1BSRUZJWCA9IFwiPCEtLSBDTEFJTV9MT0NLOlwiO1xuXG4vKipcbiAqIE9wdGlvbnMgdG8gY28tcHVibGlzaCBhbiBpbml0aWFsIGhlYXJ0YmVhdCBtYXJrZXIgaW5zaWRlIHRoZSBjbGFpbVxuICogY29tbWVudCAoSXNzdWUgIzE2MjgpLlxuICpcbiAqIFdoZW4gcHJvdmlkZWQsIHRoZSBjbGFpbSBjb21tZW50IGJvZHkgY29udGFpbnMgYm90aCB0aGUgQ0xBSU1fTE9DS1xuICogbWFya2VyIGFuZCBhbiBpbml0aWFsIFZJQkVfQ09ERVJfSEVBUlRCRUFUIG1hcmtlciwgYW5kIHRoZSB3b3JrZXInc1xuICogbWFya2VyIHN0YXRlIGZpbGUgaXMgc2VlZGVkIHNvIHN1YnNlcXVlbnQgaGVhcnRiZWF0IHJlZnJlc2hlcyBQQVRDSFxuICogdGhlIHNhbWUgY29tbWVudCBpbnN0ZWFkIG9mIHBvc3RpbmcgYSBzZXBhcmF0ZSBvbmUuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2xhaW1NYXJrZXJPcHRpb25zIHtcbiAgLyoqIFN0YWJsZSBwZXItbWFjaGluZSBpZGVudGlmaWVyIOKAlCBzZWUgbGliL21hY2hpbmVfaWQudHMuICovXG4gIG1hY2hpbmVJZDogc3RyaW5nO1xuICAvKiogV29ya2luZyBkaXJlY3RvcnkgdXNlZCB0byBwZXJzaXN0IG1hcmtlciBzdGF0ZS4gKi9cbiAgd29ya0Rpcjogc3RyaW5nO1xuICAvKiogT3B0aW9uYWwgY2xvY2sgZm9yIHRlc3RzLiBEZWZhdWx0cyB0byB3YWxsLWNsb2NrIHNlY29uZHMuICovXG4gIG5vd0ZuPzogKCkgPT4gbnVtYmVyO1xufVxuXG4vKiogT3B0aW9ucyBmb3IgYSBjbGFpbSBhdHRlbXB0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBDbGFpbU9wdGlvbnMge1xuICByZXBvOiBzdHJpbmc7XG4gIGlzc3VlTnVtYmVyOiBudW1iZXI7XG4gIGdpdGh1YlVzZXI6IHN0cmluZztcbiAgd29ya2VySWQ6IHN0cmluZztcbiAgLyoqXG4gICAqIEhvc3RuYW1lIG9mIHRoZSBtYWNoaW5lIG1ha2luZyB0aGUgY2xhaW0uIFN1cmZhY2VkIGluIHRoZSB2aXNpYmxlXG4gICAqIGNsYWltIGNvbW1lbnQgYm9keSBzbyBvcGVyYXRvcnMgY2FuIGxvY2F0ZSB0aGUgd29ya2VyJ3MgbG9ncyB3aGVuXG4gICAqIHNvbWV0aGluZyBnb2VzIHdyb25nIChJc3N1ZSAjMjAzNCkuIERlZmF1bHRzIHRvIHRoZSByZXN1bHQgb2ZcbiAgICogYGdldEhvc3RuYW1lKClgIHdoZW4gbm90IHByb3ZpZGVkLlxuICAgKi9cbiAgaG9zdG5hbWU/OiBzdHJpbmc7XG4gIC8qKiBJbmplY3RlZCBzbGVlcCBmdW5jdGlvbiAoZm9yIHRlc3RpbmcpLiBEZWZhdWx0cyB0byByZWFsIHNsZWVwLiAqL1xuICBzbGVlcEZuPzogKG1zOiBudW1iZXIpID0+IFByb21pc2U8dm9pZD47XG4gIC8qKiBJbmplY3RlZCBnaCBjb21tYW5kIGZ1bmN0aW9uIChmb3IgdGVzdGluZykuIERlZmF1bHRzIHRvIHJ1bkdoQ29tbWFuZC4gKi9cbiAgZ2hDb21tYW5kRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbiAgLyoqXG4gICAqIFdoZW4gcHJvdmlkZWQsIGVtYmVkIGFuIGluaXRpYWwgaGVhcnRiZWF0IG1hcmtlciBpbiB0aGUgY2xhaW0gY29tbWVudFxuICAgKiBhbmQgc2VlZCB0aGUgbG9jYWwgbWFya2VyIHN0YXRlIHNvIHRoZSBoZWFydGJlYXQgdXBkYXRlciBQQVRDSGVzIHRoaXNcbiAgICogc2FtZSBjb21tZW50IGluc3RlYWQgb2YgcG9zdGluZyBhIHNlY29uZCBvbmUgKElzc3VlICMxNjI4KS5cbiAgICovXG4gIG1hcmtlck9wdGlvbnM/OiBDbGFpbU1hcmtlck9wdGlvbnM7XG4gIC8qKlxuICAgKiBGbGVldCBHaXRIdWIgbG9naW5zIHdob3NlIG9wZW4gUFJzIGFyZSByZS1jaGVja2VkIGxpdmUg4oCUIHdpdGggdGhlXG4gICAqIHBlci11c2VyIGNhY2hlIGJ5cGFzc2VkIOKAlCBhZnRlciB0aGlzIGhvc3Qgd2lucyB0aGUgY2xhaW0gcmFjZSBhbmRcbiAgICogYmVmb3JlIGFueSBDbGF1ZGUvdG9rZW4gd29yayBiZWdpbnMgKElzc3VlICMzMTUwKS4gU2hvdWxkIGJlIHRoZSB1bmlvblxuICAgKiBvZiB0aGUgaG9zdCBsb2dpbiwgYGFsbG93ZWRBdXRob3JzYCwgYW5kIGBmbGVldFByQXV0aG9yc2AgKHNlZVxuICAgKiBgcmVzb2x2ZUZsZWV0QXV0aG9yc2ApLiBXaGVuIG9taXR0ZWQgb3IgZW1wdHksIHRoZSBsaXZlIHJlLWNoZWNrIGlzXG4gICAqIHNraXBwZWQgZW50aXJlbHksIHByZXNlcnZpbmcgdGhlIHByaW9yIHNpbmdsZS1ob3N0IGJlaGF2aW91ci5cbiAgICpcbiAgICogQWxzbyB0aGUgc2V0IG9mIGF1dGhvcnMgd2hvc2UgYENMQUlNX0xPQ0tgIG1hcmtlcnMgYXJlIHRydXN0ZWQgZm9yIHRoZVxuICAgKiBjbGFpbSByYWNlIGFuZCB0aGUgc3RhbGUgY2xlYW51cCAoSXNzdWUgIzM2NjQpLiBPbWl0dGluZyBpdCBmYWxscyBiYWNrXG4gICAqIHRvIGBnaXRodWJVc2VyYCBhbG9uZSBmb3IgdGhhdCBjaGVjayDigJQgcGFzcyB0aGUgZnVsbCB1bmlvbiB3aGVuZXZlclxuICAgKiBmbGVldCBob3N0cyBydW4gdW5kZXIgZGlmZmVyZW50IEdpdEh1YiBsb2dpbnMuXG4gICAqL1xuICBmbGVldEF1dGhvcnM/OiBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIFRoZSBmbGVldCdzIHB1c2gtY2FwYWJsZSBsb2dpbnMgKGByZXNvbHZlRmxlZXRNYWludGVuYW5jZUF1dGhvclNldGA6XG4gICAqIGhvc3QgbG9naW4gKyBgZmxlZXRfcHJfYXV0aG9yc2ApLiBPbmx5IHRoZXNlIGFjY291bnRzJyBvcGVuIFBScyBkZWZlclxuICAgKiBhIGNsYWltIOKAlCBhIGh1bWFuJ3MgUFIgaXMgdGhlaXJzIHRvIG1hbmFnZSBhbmQgbmV2ZXIgYmxvY2tzIGlzc3VlXG4gICAqIHBpY2t1cCAoSXNzdWUgIzQxMzMpLiBPbWl0dGVkIG9yIGVtcHR5IGtlZXBzIHRoZSBmYWlsLXNhZmU6IGFuXG4gICAqIHVuY2xhc3NpZmlhYmxlIFBSIHN0aWxsIGJsb2Nrcy5cbiAgICovXG4gIHB1c2hDYXBhYmxlQXV0aG9ycz86IHN0cmluZ1tdO1xuICAvKipcbiAgICogVGhlIGlzc3VlJ3MgbWlsZXN0b25lIHRpdGxlIChlbXB0eS91bmRlZmluZWQgZm9yIGEgbm9uLW1pbGVzdG9uZVxuICAgKiBpc3N1ZSkuIFRoZSBsaXZlIGZsZWV0LVBSIHJlLWNoZWNrIChJc3N1ZSAjMzE1MCkgbWF0Y2hlcyBhIGJsb2NraW5nIFBSXG4gICAqIHRoZSBzYW1lIG1pbGVzdG9uZS1hd2FyZSB3YXkgdGhlIGRpc2NvdmVyeS10aW1lIGd1YXJkIGRvZXNcbiAgICogKGBnZXRCbG9ja2luZ1BSRm9ySXNzdWVgKS5cbiAgICovXG4gIG1pbGVzdG9uZVRpdGxlPzogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIHJlcG8ncyBmbGVldCBQUiBjYXAgb24gdGhlIGRlZmF1bHQtYnJhbmNoIHN0cmVhbSAoSXNzdWUgIzI2NjMsXG4gICAqIGByZXNvbHZlRmxlZXRQclNsb3RzYCksIHNvIHRoZSBsaXZlIHJlLWNoZWNrIGhvbGRzIGEgbm9uLW1pbGVzdG9uZSBjbGFpbVxuICAgKiBvbmx5IGF0IHRoZSBjYXAgdGhlIGRpc2NvdmVyeS10aW1lIHNjYW4gYXBwbGllZC4gT21pdHRlZCDihpJcbiAgICogYERFRkFVTFRfRkxFRVRfUFJfU0xPVFNgLlxuICAgKi9cbiAgZmxlZXRQclNsb3RzPzogbnVtYmVyO1xuICAvKiogU2hhcmVkIHJlc2VydmF0aW9uIGFwcGxpZXMgdG8gaW1wbGVtZW50YXRpb24gY2xhaW1zIG9ubHkgKCM0OTQyKS4gKi9cbiAgY29tcGxldGlvbkFkbWlzc2lvbj86IENvbXBsZXRpb25Qb2xpY3k7XG4gIC8qKlxuICAgKiBPcHRpb25hbCBpdGVyYXRpb24tc2NvcGVkIGNhY2hlLiBUaGUgbGl2ZSBmbGVldC1QUiByZS1jaGVjayBhbHdheXNcbiAgICogZm9yY2UtcmVmcmVzaGVzIGl0IChieXBhc3NpbmcgYW55IHN0YWxlIGBwcnNfJHt1c2VyfWAgZW50cnkpIGFuZFxuICAgKiBvdmVyd3JpdGVzIGl0IHdpdGggdGhlIGZyZXNoIHJlc3VsdCAoSXNzdWUgIzMxNTApLlxuICAgKi9cbiAgY2FjaGU/OiBJc3N1ZUNhY2hlO1xuICAvKipcbiAgICogV2hldGhlciB0aGlzIHdvcmtlciBpdHNlbGYgY2xvc2VkIHRoZSBpc3N1ZSBlYXJsaWVyIGluIHRoaXMgcnVuXG4gICAqIChJc3N1ZSAjMTgxKS4gRGVmYXVsdHMgdG8gdGhlIHJ1bidzIHNoYXJlZCBwcm9jZXNzZWQtaXNzdWUgcmVnaXN0cnksXG4gICAqIHdoaWNoIHRoZSBgZ2hgIGNob2tlcG9pbnQgcmVjb3JkcyBldmVyeSBjbG9zZSBpbnRvLiBBIGNsYWltIGFnYWluc3Qgc3VjaFxuICAgKiBhbiBpc3N1ZSBpcyByZWZ1c2VkIGJlZm9yZSBhbnkgQVBJIGNhbGw6IHRoZSBzY2FuIHRoYXQgb2ZmZXJlZCBpdCB3YXNcbiAgICogcmFua2luZyBhIGNhY2hlZCBpc3N1ZSBsaXN0IHdyaXR0ZW4gYmVmb3JlIHRoZSBjbG9zZS5cbiAgICovXG4gIHdhc0Nsb3NlZFRoaXNSdW4/OiAocmVwbzogc3RyaW5nLCBpc3N1ZU51bWJlcjogbnVtYmVyKSA9PiBib29sZWFuO1xuICAvKipcbiAgICogTGFiZWxzIHRoYXQgcmVmdXNlIGEgY2xhaW0gd2hlbiBmb3VuZCBvbiB0aGUgaXNzdWUgYXQgY2xhaW0gdGltZVxuICAgKiAoSXNzdWUgIzgzMSkuIERlZmF1bHRzIHRvIGBuZWVkcy1odW1hbmAgYWxvbmUuXG4gICAqXG4gICAqIERlbGliZXJhdGVseSAqKm5vdCoqIHRoZSB3aG9sZSBkaXNjb3ZlcnkgYmxvY2tpbmcgc2V0OiB0aGUgc3BlY2lhbGlzdFxuICAgKiBwcm9jZXNzb3JzIGNsYWltIGV4YWN0bHkgdGhlIGxhYmVscyB0aGF0IHNldCBleGNsdWRlcyDigJQgYHF1ZXN0aW9uYCxcbiAgICogYHBsYW5uaW5nYCwgYHJlZmluZS1pc3N1ZWAsIGBuZWVkcy1yZXZpc2lvbmAsIGBncmlsbC1tZWAsIGBxdW9ydW1gIGFyZVxuICAgKiBlYWNoIHNvbWUgcHJvY2Vzc29yJ3MgcGlja3VwIHNpZ25hbCwgYW5kIGJsb2NraW5nIHRoZW0gaGVyZSB3b3VsZCBzdG9wXG4gICAqIGV2ZXJ5IG9uZSBvZiB0aG9zZSBwaGFzZXMuIGBuZWVkcy1odW1hbmAgaXMgdGhlIG9uZSBsYWJlbCBubyBwcm9jZXNzb3JcbiAgICogZXZlciBjbGFpbXMgb247IGFsbCBlaWdodCBvbmx5IGV2ZXIgKmFwcGx5KiBpdC5cbiAgICovXG4gIGJsb2NraW5nTGFiZWxzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKlxuICAgKiBSZWZ1c2UgdGhlIGNsYWltIHdoaWxlIGFub3RoZXIgb3BlbiBpc3N1ZSBvZiB0aGUgc2FtZSBtaWxlc3RvbmUgc3RyZWFtIGlzXG4gICAqIGxpdmUgYW55d2hlcmUgaW4gdGhlIGZsZWV0IChJc3N1ZSAjMjMzNCkuIE9mZiB1bmxlc3MgdGhlIGNhbGxlciBhc2tzIGZvclxuICAgKiBpdCwgYW5kIG9mZiBmb3IgZXZlcnkgY2FsbGVyIHdoZW4gYGVuYWJsZV9zZXNzaW9uX3Jlc3VtZWAgaXMgb2ZmOiB3aXRoIG5vXG4gICAqIHNoYXJlZCBjb252ZXJzYXRpb24gdGhlcmUgaXMgbm8gc3RyZWFtIHRvIGxvY2ssIGFuZCB0aGUgY2hlY2sncyBvbmUgZXh0cmFcbiAgICogYGdoIGlzc3VlIGxpc3RgIGlzIG5vdCBtYWRlIGF0IGFsbC5cbiAgICpcbiAgICogU2V0IGJ5IHRoZSBydW5zIHRoYXQgam9pbiBhIHN0cmVhbSDigJQgdG9kYXkgdGhlIHN0YW5kYXJkIHBpcGVsaW5lJ3Mgc2V0dXBcbiAgICogcGhhc2UuIFRoZSBwcmUtcGlwZWxpbmUgcm91dGVzIChpZGxlLXRhc2ssIGBhZGQtcmVwb2AsIGBzZWVkLWlkbGUtdGFza3NgKVxuICAgKiBuZXZlciBqb2luIG9uZSBhbmQgbmV2ZXIgc2V0IGl0LlxuICAgKi9cbiAgc3RyZWFtTG9ja0VuYWJsZWQ/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2xhaW0gaW50byBhIGJ1c3kgc3RyZWFtIGluc3RlYWQgb2Ygd2FpdGluZyBmb3IgaXQgKElzc3VlICMyNTMwKS4gU2V0IGZvclxuICAgKiB0aGUgdGllcnMgYGlzU3RyZWFtU2hhcmluZ1RpZXJgIG5hbWVzIOKAlCBhIGNvbmZpZ3VyZWQgYHRvcC1wcmlvcml0eWAgbGFiZWxcbiAgICogb3IgYHdvcmstb25gIOKAlCB3aGljaCBhIGh1bWFuIGhhcyBhc2tlZCBmb3Igbm93LiBTdWNoIGEgY2xhaW0gcHJvY2VlZHNcbiAgICogd2hpbGUgYW5vdGhlciBob3N0IHJ1bnMgdGhlIHN0cmVhbSBhbmQgcmVwb3J0cyB7QGxpbmsgQ2xhaW1SZXN1bHQuc3RyZWFtU2hhcmVkfVxuICAgKiBzbyB0aGUgY2FsbGVyIGtlZXBzIGEgcGVyLWlzc3VlIGNvbnZlcnNhdGlvbiByYXRoZXIgdGhhbiBqb2luaW5nIHRoZVxuICAgKiBzdHJlYW0ncy4gT2ZmICh0aGUgZGVmYXVsdCkga2VlcHMgdGhlIHBsYWluIGBzdHJlYW1fYnVzeWAgc2tpcC5cbiAgICpcbiAgICogT25seSByZWFkIHdoZW4gYHN0cmVhbUxvY2tFbmFibGVkYCBpcyBvbiDigJQgd2l0aCBubyBsb2NrIHRoZXJlIGlzIG5vdGhpbmdcbiAgICogdG8gc2hhcmUuXG4gICAqL1xuICBzdHJlYW1TaGFyZWFibGU/OiBib29sZWFuO1xufVxuXG4vKiogQ2xhaW0gY29tbWVudCBwYXJzZWQgZnJvbSB0aGUgR2l0SHViIEFQSS4gKi9cbmludGVyZmFjZSBDbGFpbUNvbW1lbnQge1xuICBpZDogbnVtYmVyO1xuICBib2R5OiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xuICAvKipcbiAgICogQ29tbWVudCBhdXRob3IgbG9naW4gKGAudXNlci5sb2dpbmApLiBBIENMQUlNX0xPQ0sgbWFya2VyIGxpdmVzIGluIGFcbiAgICogY29tbWVudCBib2R5IHRoYXQgYW55IEdpdEh1YiB1c2VyIGNhbiBwb3N0LCBzbyB0aGUgYXV0aG9yIGlzIHRoZSBvbmx5XG4gICAqIGF1dGhlbnRpY2F0ZWQgcGFydCBvZiB0aGUgbWFya2VyIChJc3N1ZSAjMzY2NCkuXG4gICAqL1xuICBhdXRob3I/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmVhc29uIGEgY2xhaW0gYXR0ZW1wdCBkaWQgbm90IHJlc3VsdCBpbiB0aGlzIHdvcmtlciBob2xkaW5nIHRoZSBpc3N1ZVxuICogKElzc3VlICMyMzI1KS4gRGlzdGluZ3Vpc2hlcyBwZXJtYW5lbnQgbWlzY29uZmlndXJhdGlvbiAoZS5nLiB0aGUgd29ya2VyXG4gKiBpcyBub3QgYSBjb2xsYWJvcmF0b3Igb24gdGhlIHJlcG8pIGZyb20gdHJhbnNpZW50IHJhY2UgbG9zc2VzLCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIG1lYW5pbmdmdWwgd2FybmluZyBpbnN0ZWFkIG9mIHRoZSBjYXRjaC1hbGxcbiAqIFwiYWxyZWFkeSBhc3NpZ25lZCBvciBjbG9zZWRcIi5cbiAqL1xuZXhwb3J0IHR5cGUgQ2xhaW1GYWlsdXJlUmVhc29uID1cbiAgLyoqIFByZS1jbGFpbSBmcmVzaG5lc3MgY2hlY2sgZm91bmQgdGhlIGlzc3VlIHdhcyBhbHJlYWR5IGFzc2lnbmVkLiAqL1xuICB8IFwiYWxyZWFkeV9hc3NpZ25lZFwiXG4gIC8qKiBQcmUtY2xhaW0gZnJlc2huZXNzIGNoZWNrIGZvdW5kIGEgcmVjZW50IENMQUlNX0xPQ0sgZnJvbSBhbm90aGVyIHdvcmtlci4gKi9cbiAgfCBcInJlY2VudF9jbGFpbVwiXG4gIC8qKlxuICAgKiBUaGUgaXNzdWUgY2FycmllcyBubyBhc3NpZ25lZSBidXQgaXRzIGhlYXJ0YmVhdCBtYXJrZXIgaXMgc3RpbGwgYmVhdGluZ1xuICAgKiAoSXNzdWUgIzIxNCkuIFRoZSBhc3NpZ25lZSDigJQgdGhlIGNsYWltIGxvY2sgZXZlcnkgaG9zdCBjaGVja3Mg4oCUIHdhc1xuICAgKiBkcm9wcGVkIG91dCBmcm9tIHVuZGVyIGEgcnVuIHRoYXQgaXMgc3RpbGwgZ29pbmcsIHNvIGNsYWltaW5nIGhlcmVcbiAgICogd291bGQgc3RhcnQgYSBzZWNvbmQgYWdlbnQgb24gdGhlIHNhbWUgaXNzdWUgYW5kIGJyYW5jaC5cbiAgICovXG4gIHwgXCJoZWFydGJlYXRfYWN0aXZlXCJcbiAgLyoqIFRoZSBpc3N1ZSBpcyBjbG9zZWQuICovXG4gIHwgXCJhbHJlYWR5X2Nsb3NlZFwiXG4gIC8qKlxuICAgKiBBIGxpdmUsIGNhY2hlLWJ5cGFzc2luZyBsYWJlbCByZS1jaGVjayAoSXNzdWUgIzgzMSkgZm91bmQgYSBibG9ja2luZ1xuICAgKiBsYWJlbCDigJQgYG5lZWRzLWh1bWFuYCBieSBkZWZhdWx0IOKAlCBhcHBsaWVkIGluIHRoZSB3aW5kb3cgYmV0d2VlbiB0aGlzXG4gICAqIGhvc3QncyBkaXNjb3ZlcnkgYW5kIGl0cyBjbGFpbS4gRGlzY292ZXJ5IGFscmVhZHkgZXhjbHVkZXMgdGhvc2UgbGFiZWxzXG4gICAqIChgZmlsdGVyQW5kU29ydGApLCBidXQgaXQgcmFua3MgYSBzbmFwc2hvdDogb24gVmliZUNvZGVyIzc5MyB0aGUgd29ya2VyXG4gICAqIGl0c2VsZiBhcHBsaWVkIGBuZWVkcy1odW1hbmAgYXQgMjE6NDc6MTYgZmluaXNoaW5nIGEgZ3JpbGwtbWUgcm91bmQsIGFuZFxuICAgKiBhIHNjYW4gaG9sZGluZyB0aGUgZWFybGllciBzbmFwc2hvdCBjbGFpbWVkIHRoZSBpc3N1ZSBhdCAyMTo1MzozMSDigJQgc2l4XG4gICAqIG1pbnV0ZXMgYWZ0ZXIgaXQgaGFkIGJlZW4gcGFya2VkIGZvciBhIHBlcnNvbi4gUmVmdXNlZCBiZWZvcmUgdGhlXG4gICAqIGFzc2lnbm1lbnQgYW5kIHRoZSBjbGFpbSBjb21tZW50LCBzbyBhIHBhcmtlZCBpc3N1ZSBjb2xsZWN0cyBuZWl0aGVyLlxuICAgKi9cbiAgfCBcImJsb2NraW5nX2xhYmVsXCJcbiAgLyoqIEFub3RoZXIgd29ya2VyIHdvbiB0aGUgY2xhaW0gcmFjZSAodGhlaXIgQ0xBSU1fTE9DSyBjb21tZW50IGlzIGVhcmxpZXIpLiAqL1xuICB8IFwicmFjZV9sb3N0XCJcbiAgLyoqXG4gICAqIEEgbGl2ZSwgY2FjaGUtYnlwYXNzaW5nIGZsZWV0IG9wZW4tUFIgcmUtY2hlY2sgKElzc3VlICMzMTUwKSBmb3VuZCBhblxuICAgKiBvcGVuIFBSIOKAlCByYWlzZWQgYnkgdGhpcyBob3N0IG9yIGEgc2libGluZyBmbGVldCBhY2NvdW50IOKAlCBhbHJlYWR5XG4gICAqIHRhcmdldGluZyB0aGlzIGlzc3VlJ3Mgd29yayBzdHJlYW0uIFRoZSBQUiB3YXMgb3BlbmVkIGluIHRoZSB3aW5kb3dcbiAgICogYmV0d2VlbiB0aGlzIGhvc3QncyBkaXNjb3ZlcnkgYW5kIGl0cyBjbGFpbSwgc28gdGhlIGRpc2NvdmVyeS10aW1lXG4gICAqIGd1YXJkIGNvdWxkIG5vdCBzZWUgaXQuIFRoZSBjbGFpbSBpcyBhYm9ydGVkIGJlZm9yZSBhbnkgdG9rZW4gd29ya1xuICAgKiBiZWdpbnMgdG8gYXZvaWQgYSBkdXBsaWNhdGUgUFIuXG4gICAqL1xuICB8IFwiZmxlZXRfcHJfZXhpc3RzXCJcbiAgfCBcImNvbXBsZXRpb25fbW9kZVwiXG4gIC8qKlxuICAgKiBgZ2ggaXNzdWUgZWRpdCAtLWFkZC1hc3NpZ25lZWAgcmV0dXJuZWQgSFRUUCA0MjIg4oCUIHRoZSB3b3JrZXIgdXNlciBpc1xuICAgKiBub3QgYSBjb2xsYWJvcmF0b3Igb24gdGhlIHJlcG8gKG9yIHRoZSBhc3NpZ25lZSBpcyBvdGhlcndpc2UgaW52YWxpZCkuXG4gICAqIFBlcm1hbmVudCB1bnRpbCB0aGUgcmVwbyBvd25lciBhZGRzIHRoZSB3b3JrZXIgYXMgYSBjb2xsYWJvcmF0b3IuXG4gICAqL1xuICB8IFwibm90X2Fzc2lnbmFibGVcIlxuICAvKiogYGdoIGlzc3VlIGVkaXQgLS1hZGQtYXNzaWduZWVgIHJldHVybmVkIEhUVFAgNDAzIOKAlCBwZXJtaXNzaW9uIGRlbmllZC4gKi9cbiAgfCBcImZvcmJpZGRlblwiXG4gIC8qKiBgZ2ggaXNzdWUgZWRpdCAtLWFkZC1hc3NpZ25lZWAgcmV0dXJuZWQgSFRUUCA0MDQg4oCUIHJlcG8gb3IgaXNzdWUgbWlzc2luZy4gKi9cbiAgfCBcIm5vdF9mb3VuZFwiXG4gIC8qKiBgZ2ggaXNzdWUgY29tbWVudGAgZmFpbGVkIGFmdGVyIGFzc2lnbm1lbnQgc3VjY2VlZGVkLiAqL1xuICB8IFwiY29tbWVudF9mYWlsZWRcIlxuICAvKipcbiAgICogQW5vdGhlciBvcGVuIGlzc3VlIG9mIHRoaXMgaXNzdWUncyBtaWxlc3RvbmUgc3RyZWFtIGlzIGFscmVhZHkgYmVpbmcgcnVuXG4gICAqIHNvbWV3aGVyZSBpbiB0aGUgZmxlZXQgKElzc3VlICMyMzM0KS4gQSBzdHJlYW0gb3ducyBvbmUgYWdlbnRcbiAgICogY29udmVyc2F0aW9uLCBzbyBhIHNlY29uZCBydW4gaW5zaWRlIGl0IGlzIHR3byBydW5zIGluIG9uZSBjb252ZXJzYXRpb24uXG4gICAqIFJlZnVzZWQgYmVmb3JlIHRoZSBhc3NpZ25tZW50IGFuZCB0aGUgY2xhaW0gY29tbWVudCwgYW5kICoqbm90KiogYVxuICAgKiBmYWlsdXJlOiBubyBgZmFpbGVkLW9uY2VgIGxhYmVsLCBubyBjaHVybiByZWNvcmQgYW5kIG5vIGNvb2xkb3duIGJleW9uZFxuICAgKiB0aGUgbm9ybWFsIHNjYW4gaW50ZXJ2YWwg4oCUIHRoZSBpc3N1ZSBpcyBjbGFpbWVkIG9uIGEgbGF0ZXIgc2NhbiBvbmNlIHRoZVxuICAgKiBob2xkZXIncyBoZWFydGJlYXQgZ29lcyBzdGFsZS5cbiAgICovXG4gIHwgXCJzdHJlYW1fYnVzeVwiXG4gIC8qKlxuICAgKiBBbm90aGVyIGhvc3QgaG9sZHMgdGhpcyBtaWxlc3RvbmUgc3RyZWFtJ3MgY29udmVyc2F0aW9uIGFuZCBpdHMgaGVhZCBzdGFydFxuICAgKiBoYXMgbm90IHJ1biBvdXQgKElzc3VlICMyMzM2KS4gVGhlIHRyYW5zY3JpcHQgbGl2ZXMgb24gdGhhdCBob3N0J3MgZGlzaywgc29cbiAgICogY2xhaW1pbmcgaGVyZSB3b3VsZCBzdGFydCB0aGUgc3RyZWFtJ3MgY29udmVyc2F0aW9uIGFnYWluIGZyb20gbm90aGluZy5cbiAgICogTGlrZSBgc3RyZWFtX2J1c3lgIHRoaXMgaXMgKipub3QqKiBhIGZhaWx1cmU6IG5vIGBmYWlsZWQtb25jZWAgbGFiZWwsIG5vXG4gICAqIGNodXJuIHJlY29yZCBhbmQgbm8gY29vbGRvd24g4oCUIGFmdGVyXG4gICAqIGBTVFJFQU1fQUZGSU5JVFlfR1JBQ0VfU0VDT05EU2AgdGhlIGZpcnN0IGhvc3QgdG8gc2NhbiBjbGFpbXMgaXQgYW55d2F5LlxuICAgKi9cbiAgfCBcInN0cmVhbV9hZmZpbml0eVwiXG4gIC8qKiBWZXJpZmljYXRpb24gcmUtcmVhZCBvZiBjb21tZW50cyBmYWlsZWQgYWZ0ZXIgdGhlIGNsYWltIHdhcyBwb3N0ZWQuICovXG4gIHwgXCJ2ZXJpZmljYXRpb25fZmFpbGVkXCJcbiAgLyoqIEFueSBvdGhlciBlcnJvciBmcm9tIGBnaGAgKG5ldHdvcmssIHRyYW5zaWVudCA1eHgsIGV0Yy4pLiAqL1xuICB8IFwiYXBpX2Vycm9yXCI7XG5cbi8qKiBSZXN1bHQgZGF0YSBmcm9tIGEgc3VjY2Vzc2Z1bCBjbGFpbSBvcGVyYXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIENsYWltUmVzdWx0IHtcbiAgY2xhaW1lZDogYm9vbGVhbjtcbiAgd2lubmVySWQ/OiBzdHJpbmc7XG4gIC8qKiBOdW1iZXIgb2YgY29tcGV0aW5nIHdvcmtlcnMgaW4gdGhlIGNsYWltIHJhY2UgKDAgPSBubyByYWNlKS4gSXNzdWUgIzEwOTAuICovXG4gIGNvbXBldGluZ1dvcmtlckNvdW50PzogbnVtYmVyO1xuICAvKipcbiAgICogRGlzdGluZ3Vpc2hlZCByZWFzb24gdGhlIGNsYWltIGRpZCBub3Qgc3VjY2VlZCAoSXNzdWUgIzIzMjUpLiBPbmx5IHNldFxuICAgKiB3aGVuIGBjbGFpbWVkID09PSBmYWxzZWAuIExldHMgY2FsbGVycyBzdXJmYWNlIFwibm90X2Fzc2lnbmFibGU6IHdvcmtlclxuICAgKiBpcyBub3QgYSBjb2xsYWJvcmF0b3JcIiBpbnN0ZWFkIG9mIHRoZSBtaXNsZWFkaW5nIFwiYWxyZWFkeSBhc3NpZ25lZCBvclxuICAgKiBjbG9zZWRcIiBjYXRjaC1hbGwuXG4gICAqL1xuICByZWFzb24/OiBDbGFpbUZhaWx1cmVSZWFzb247XG4gIC8qKlxuICAgKiBSYXcgYGdoYCBlcnJvciBtZXNzYWdlIGNhcHR1cmVkIHdoZW4gdGhlIGFzc2lnbm1lbnQgb3IgY29tbWVudCBzdGVwXG4gICAqIGZhaWxlZCAoSXNzdWUgIzIzMjUpLiBTdWl0YWJsZSBmb3IgbG9nZ2luZyBhdCBXQVJOIOKAlCBuYW1lcyB0aGUgZ2hcbiAgICogc3RkZXJyIHNvIG9wZXJhdG9ycyBjYW4gZGlhZ25vc2Ugd2l0aG91dCBsb2ctZGl2aW5nLlxuICAgKi9cbiAgcmVhc29uRGV0YWlsPzogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIHN0cmVhbSB0aGlzIGNsYWltIGpvaW5lZCBhcyBhICoqc2Vjb25kKiogaG9sZGVyIChJc3N1ZSAjMjUzMCkuIFNldFxuICAgKiBvbmx5IG9uIGEgc3VjY2Vzc2Z1bCBjbGFpbSB0aGF0IGEgYHN0cmVhbVNoYXJlYWJsZWAgdGllciBtYWRlIHdoaWxlXG4gICAqIGFub3RoZXIgaG9zdCB3YXMgYWxyZWFkeSBydW5uaW5nIHRoZSBzdHJlYW0uIFRoZSBjYWxsZXIgdXNlcyBpdCB0byBrZWVwXG4gICAqIHRoaXMgcnVuIG9uIGEgcGVyLWlzc3VlIGNvbnZlcnNhdGlvbiDigJQgdHdvIHJ1bnMgbXVzdCBuZXZlciBzaGFyZSBvbmVcbiAgICogdHJhbnNjcmlwdCDigJQgYW5kIHRvIG5hbWUgdGhlIGhvbGRlciBpbiBpdHMgbG9nLlxuICAgKi9cbiAgc3RyZWFtU2hhcmVkPzogU2hhcmVkU3RyZWFtO1xufVxuXG4vKiogVGhlIHN0cmVhbSBhIHNoYXJlYWJsZSBjbGFpbSBqb2luZWQgd2hpbGUgYW5vdGhlciBob3N0IGhlbGQgaXQgKCMyNTMwKS4gKi9cbmV4cG9ydCB0eXBlIFNoYXJlZFN0cmVhbSA9IE9taXQ8U3RyZWFtQnVzeSwgXCJidXN5XCI+O1xuXG4vKiogT3B0aW9ucyBmb3IgY2hlY2tpbmcgY2xhaW0gY2h1cm4uICovXG5leHBvcnQgaW50ZXJmYWNlIENsYWltQ2h1cm5PcHRpb25zIHtcbiAgcmVwbzogc3RyaW5nO1xuICBpc3N1ZU51bWJlcjogbnVtYmVyO1xuICBnaXRodWJVc2VyOiBzdHJpbmc7XG4gIHRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqIEluamVjdGVkIGdoIGNvbW1hbmQgZnVuY3Rpb24gKGZvciB0ZXN0aW5nKS4gRGVmYXVsdHMgdG8gcnVuR2hDb21tYW5kLiAqL1xuICBnaENvbW1hbmRGbj86IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+O1xufVxuXG4vKiogUmVzdWx0IGRhdGEgZnJvbSBhIGNsYWltIGNodXJuIGNoZWNrLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDbGFpbUNodXJuUmVzdWx0IHtcbiAgY2h1cm5Db3VudDogbnVtYmVyO1xuICBlc2NhbGF0ZWQ6IGJvb2xlYW47XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSW50ZXJuYWwgaGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogTWF4aW11bSBhZ2UgKGluIG1pbGxpc2Vjb25kcykgZm9yIGEgQ0xBSU1fTE9DSyBjb21tZW50IHRvIGJlIGNvbnNpZGVyZWRcbiAqIHJlY2VudC5cbiAqXG4gKiBFeHBvcnRlZCBmb3IgdGhlIHN0cmVhbSBsb2NrIChJc3N1ZSAjMjMzNCksIHdoaWNoIHJlYWRzIGEgc2libGluZyBpc3N1ZSdzXG4gKiBjbGFpbSBjb21tZW50cyBieSB0aGUgc2FtZSB3aW5kb3cg4oCUIGEgY2xhaW0geW91bmdlciB0aGFuIHRoaXMgYmVsb25ncyB0byBhXG4gKiBydW4gd2hvc2UgZmlyc3QgaGVhcnRiZWF0IHJlZnJlc2ggaGFzIG5vdCBsYW5kZWQgeWV0LlxuICovXG5leHBvcnQgY29uc3QgUkVDRU5UX0NMQUlNX1dJTkRPV19NUyA9IDYwXzAwMDtcblxuLyoqXG4gKiBNaW5pbXVtIGFnZSBhIENMQUlNX0xPQ0sgY29tbWVudCBtdXN0IHJlYWNoIGJlZm9yZSB0aGUgc3RhbGUtY2xhaW1cbiAqIGNsZWFudXAgbWF5IGRlbGV0ZSBpdCAoSXNzdWUgIzM2NjQpLiBBbnl0aGluZyB5b3VuZ2VyIGlzIGEgbGl2ZSBjbGFpbSDigJRcbiAqIHBvc3NpYmx5IGEgZmxlZXQgc2libGluZydzIGluLWZsaWdodCBjbGFpbSDigJQgbm90IHRoZSBsZWZ0b3ZlciBvZiBhXG4gKiBjcmFzaGVkIHByZXZpb3VzIHJ1bi5cbiAqL1xuY29uc3QgU1RBTEVfQ0xBSU1fTUlOX0FHRV9NUyA9IFJFQ0VOVF9DTEFJTV9XSU5ET1dfTVM7XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgYXV0aG9yIGxvZ2lucyB3aG9zZSBDTEFJTV9MT0NLIG1hcmtlcnMgdGhpcyB3b3JrZXIgdHJ1c3RzXG4gKiAoSXNzdWUgIzM2NjQpLlxuICpcbiAqIEEgQ0xBSU1fTE9DSyBtYXJrZXIgaXMganVzdCB0ZXh0IGluIGEgY29tbWVudCBib2R5LCBzbyBhbnkgR2l0SHViIHVzZXJcbiAqIGNhbiBwb3N0IG9uZS4gT25seSB0aGUgY29tbWVudCAqYXV0aG9yKiBpcyBhdXRoZW50aWNhdGVkLCBzbyBldmVyeVxuICogZGVjaXNpb24gZHJpdmVuIGJ5IGEgbWFya2VyIOKAlCByYWNlIHJlc29sdXRpb24gYW5kIHN0YWxlIGNsZWFudXAgYWxpa2Ug4oCUXG4gKiBpcyBnYXRlZCBvbiB0aGUgYXV0aG9yIGJlbG9uZ2luZyB0byB0aGUgZmxlZXQuXG4gKlxuICogQ2FsbGVycyB0aGF0IGtub3cgdGhlIHdob2xlIGZsZWV0IHBhc3MgYGZsZWV0QXV0aG9yc2BcbiAqIChgcmVzb2x2ZUZsZWV0QXV0aG9yc2ApLiBDYWxsZXJzIHRoYXQgZG8gbm90IGZhbGwgYmFjayB0byB0aGUgY2xhaW1pbmdcbiAqIGFjY291bnQgaXRzZWxmLCB3aGljaCBjb3ZlcnMgdGhlIHNoYXJlZC11c2VybmFtZSBmbGVldCBkZXBsb3ltZW50XG4gKiAoSXNzdWUgIzYwNCkgdGhhdCBjb21tZW50LWJhc2VkIGNsYWltaW5nIHdhcyBidWlsdCBmb3IuIEJvdGggZGlyZWN0aW9uc1xuICogZmFpbCB0b3dhcmQgKmNsYWltaW5nKiB0aGUgaXNzdWUgcmF0aGVyIHRoYW4gYWJhbmRvbmluZyBpdCwgbWF0Y2hpbmcgdGhlXG4gKiBwcmUtY2xhaW0gY2hlY2sncyBJc3N1ZSAjMzE2NCBiZWhhdmlvdXIuXG4gKlxuICogQHJldHVybnMgVGhlIHRydXN0ZWQgbG9naW5zLCBvciBhbiBlbXB0eSBsaXN0IChmaWx0ZXJpbmcgZGlzYWJsZWQpIHdoZW5cbiAqICAgbm8gYXV0aG9yIGlzIGtub3duIGF0IGFsbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVUcnVzdGVkQ2xhaW1BdXRob3JzKFxuICBnaXRodWJVc2VyOiBzdHJpbmcsXG4gIGZsZWV0QXV0aG9ycz86IHN0cmluZ1tdLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBmbGVldCA9IChmbGVldEF1dGhvcnMgPz8gW10pLmZpbHRlcihcbiAgICAoYSkgPT4gdHlwZW9mIGEgPT09IFwic3RyaW5nXCIgJiYgYS50cmltKCkubGVuZ3RoID4gMCxcbiAgKTtcbiAgaWYgKGZsZWV0Lmxlbmd0aCA+IDApIHJldHVybiBmbGVldDtcbiAgcmV0dXJuIHR5cGVvZiBnaXRodWJVc2VyID09PSBcInN0cmluZ1wiICYmIGdpdGh1YlVzZXIudHJpbSgpLmxlbmd0aCA+IDBcbiAgICA/IFtnaXRodWJVc2VyXVxuICAgIDogW107XG59XG5cbi8qKlxuICogRGlzY2FyZCBDTEFJTV9MT0NLIGNvbW1lbnRzIHRoYXQgd2VyZSBub3QgcG9zdGVkIGJ5IGEgZmxlZXQgYWNjb3VudFxuICogKElzc3VlICMzNjY0KS4gQW4gZW1wdHkgYHRydXN0ZWRBdXRob3JzYCBkaXNhYmxlcyB0aGUgZmlsdGVyLlxuICovXG5mdW5jdGlvbiBmaWx0ZXJGbGVldENsYWltQ29tbWVudHMoXG4gIGNvbW1lbnRzOiBDbGFpbUNvbW1lbnRbXSxcbiAgdHJ1c3RlZEF1dGhvcnM6IHN0cmluZ1tdLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4pOiBDbGFpbUNvbW1lbnRbXSB7XG4gIGlmICh0cnVzdGVkQXV0aG9ycy5sZW5ndGggPT09IDApIHJldHVybiBjb21tZW50cztcbiAgY29uc3Qga2VwdCA9IGNvbW1lbnRzLmZpbHRlcigoYykgPT4gaXNGbGVldEF1dGhvcihjLmF1dGhvciwgdHJ1c3RlZEF1dGhvcnMpKTtcbiAgY29uc3QgZGlzY2FyZGVkID0gY29tbWVudHMubGVuZ3RoIC0ga2VwdC5sZW5ndGg7XG4gIGlmIChkaXNjYXJkZWQgPiAwKSB7XG4gICAgY29uc29sZS53YXJuKFxuICAgICAgYFtjbGFpbV9pc3N1ZV0gcmVwbz0ke3JlcG99IGlzc3VlPSMke2lzc3VlTnVtYmVyfSBgICtcbiAgICAgICAgYGRpc2NhcmRlZF9jbGFpbV9tYXJrZXJzPSR7ZGlzY2FyZGVkfSByZWFzb249bm9uX2ZsZWV0X2F1dGhvciDigJQgYSBgICtcbiAgICAgICAgYENMQUlNX0xPQ0sgbWFya2VyIGZyb20gb3V0c2lkZSB0aGUgZmxlZXQgY2Fubm90IHdpbiB0aGUgY2xhaW0gcmFjZSBgICtcbiAgICAgICAgYChJc3N1ZSAjMzY2NClgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGtlcHQ7XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgYSBgZ2hgIGVycm9yIG1lc3NhZ2UgaW50byBhIHN0cnVjdHVyZWQgQ2xhaW1GYWlsdXJlUmVhc29uXG4gKiAoSXNzdWUgIzIzMjUpLiBQYXR0ZXJuLW1hdGNoZXMgb24gSFRUUCBzdGF0dXMgY29kZXMgYW5kIHZhbGlkYXRpb25cbiAqIGtleXdvcmRzIHN1cmZhY2VkIHZpYSBgcnVuR2hDb21tYW5kUmF3YCAod2hpY2ggZW1iZWRzIGdoIHN0ZGVyciBpbiB0aGVcbiAqIEVycm9yIG1lc3NhZ2UpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlHaEFzc2lnbkVycm9yKG1lc3NhZ2U6IHN0cmluZyk6IENsYWltRmFpbHVyZVJlYXNvbiB7XG4gIGlmICghbWVzc2FnZSkgcmV0dXJuIFwiYXBpX2Vycm9yXCI7XG4gIGNvbnN0IGxvd2VyID0gbWVzc2FnZS50b0xvd2VyQ2FzZSgpO1xuICAvLyA0MjIgd2l0aCBhbiBcImFzc2lnbmVlc1wiIC8gXCJpcyBpbnZhbGlkXCIgdmFsaWRhdGlvbiBlcnJvciBtZWFucyB0aGVcbiAgLy8gdXNlciBpcyBub3QgYSBjb2xsYWJvcmF0b3Igb24gdGhlIHJlcG8uIGdoJ3Mgc3RkZXJyIHJlYWRzIGUuZy5cbiAgLy8gXCJIVFRQIDQyMjogVmFsaWRhdGlvbiBGYWlsZWQgKC4uLikgLSAnYXNzaWduZWVzJyBpcyBpbnZhbGlkXCIuXG4gIGlmIChcbiAgICBsb3dlci5pbmNsdWRlcyhcIjQyMlwiKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwidmFsaWRhdGlvbiBmYWlsZWRcIikgfHxcbiAgICAobG93ZXIuaW5jbHVkZXMoXCJhc3NpZ25lZVwiKSAmJiBsb3dlci5pbmNsdWRlcyhcImludmFsaWRcIikpXG4gICkge1xuICAgIHJldHVybiBcIm5vdF9hc3NpZ25hYmxlXCI7XG4gIH1cbiAgaWYgKGxvd2VyLmluY2x1ZGVzKFwiNDAzXCIpIHx8IGxvd2VyLmluY2x1ZGVzKFwiZm9yYmlkZGVuXCIpKSB7XG4gICAgcmV0dXJuIFwiZm9yYmlkZGVuXCI7XG4gIH1cbiAgaWYgKGxvd2VyLmluY2x1ZGVzKFwiNDA0XCIpIHx8IGxvd2VyLmluY2x1ZGVzKFwibm90IGZvdW5kXCIpKSB7XG4gICAgcmV0dXJuIFwibm90X2ZvdW5kXCI7XG4gIH1cbiAgcmV0dXJuIFwiYXBpX2Vycm9yXCI7XG59XG5cbi8qKlxuICogSG93IHJlY2VudGx5IGEgaGVhcnRiZWF0IG1hcmtlciBtdXN0IGhhdmUgYmVhdGVuIGZvciB0aGUgaXNzdWUgdG8gY291bnQgYXNcbiAqIGhlbGQgYnkgYSBsaXZlIHJ1biAoSXNzdWUgIzIxNCkuXG4gKlxuICogVHdpY2UgdGhlIGludGVydmFsIGF0IHdoaWNoIGEgbWFya2VyIGNvbW1lbnQgaXMgcmVmcmVzaGVkIOKAlCB0aGUgb25seSBiZWF0XG4gKiByYXRlIGFub3RoZXIgaG9zdCBjYW4gb2JzZXJ2ZS4gVGhlIGluLXByb2Nlc3MgaGVhcnRiZWF0IHRpbWVyIGZpcmVzIGV2ZXJ5XG4gKiB7QGxpbmsgREVGQVVMVF9IRUFSVEJFQVRfSU5URVJWQUxfTVN9LCBidXQgYSBiZWF0IG9ubHkgcmVhY2hlcyBHaXRIdWIgZXZlcnlcbiAqIHtAbGluayBERUZBVUxUX01BUktFUl9SRUZSRVNIX1NFQ09ORFN9LCBzbyBhIGhlYWx0aHkgY2xhaW0ncyBwdWJsaXNoZWRcbiAqIG1hcmtlciBpcyByb3V0aW5lbHkgb25lIHJlZnJlc2ggb2xkLiBPbmUgbWlzc2VkIHJlZnJlc2ggaXMgdG9sZXJhdGVkO1xuICogYmV5b25kIHRoYXQgdGhlIHJ1biBpcyBnb25lIGFuZCB0aGUgb3JkaW5hcnkgc3RhbGUtYXNzaWdubWVudCByZWNvdmVyeVxuICogKGRlZmF1bHQgMTgwMCBzLCBjb21mb3J0YWJseSBsb25nZXIgdGhhbiB0aGlzIHdpbmRvdykgdGFrZXMgb3Zlci5cbiAqL1xuZXhwb3J0IGNvbnN0IExJVkVfSEVBUlRCRUFUX1dJTkRPV19TRUNPTkRTID0gMiAqIERFRkFVTFRfTUFSS0VSX1JFRlJFU0hfU0VDT05EUztcblxuLyoqIEEgaGVhcnRiZWF0IG1hcmtlciB0aGF0IGlzIHN0aWxsIGJlYXRpbmcuICovXG5leHBvcnQgaW50ZXJmYWNlIExpdmVIZWFydGJlYXRNYXJrZXIge1xuICBtYWNoaW5lSWQ6IHN0cmluZztcbiAgLyoqIEVwb2NoIHNlY29uZHMgb2YgdGhlIGxhc3QgYmVhdC4gKi9cbiAgZXBvY2g6IG51bWJlcjtcbiAgLyoqIFNlY29uZHMgc2luY2UgdGhhdCBiZWF0IChuZXZlciBuZWdhdGl2ZSDigJQgYSBza2V3ZWQgY2xvY2sgY2xhbXBzIHRvIDApLiAqL1xuICBhZ2VTZWNvbmRzOiBudW1iZXI7XG59XG5cbi8qKlxuICogUGljayB0aGUgbW9zdCByZWNlbnQgaGVhcnRiZWF0IG1hcmtlciB0aGF0IGlzIHN0aWxsIGJlYXRpbmcgKElzc3VlICMyMTQpLlxuICpcbiAqIEEgcmVsZWFzZWQgY2xhaW0ncyBtYXJrZXIgY2FycmllcyBlcG9jaCAwIHBsdXMgdGhlIGBjbGVhcmVkOmAgc2lnbmFsIGFuZCBpc1xuICogaWdub3JlZCwgYXMgaXMgYSBtYXJrZXIgb2xkZXIgdGhhbiBgd2luZG93U2Vjb25kc2AuIFJldHVybnMgbnVsbCB3aGVuIG5vXG4gKiBtYXJrZXIgcXVhbGlmaWVzIOKAlCB0aGUgaXNzdWUgaXMgZ2VudWluZWx5IGZyZWUuXG4gKlxuICogQHBhcmFtIG1hcmtlcnMgLSBNYXJrZXJzIHBhcnNlZCBmcm9tIHRoZSBpc3N1ZSdzIGNvbW1lbnRzIChmbGVldC1hdXRob3JlZFxuICogICBvbmx5OyBhIGZvcmdlZCBtYXJrZXIgbXVzdCBuZXZlciBrZWVwIHRoZSBmbGVldCBvZmYgYW4gaXNzdWUpLlxuICogQHBhcmFtIG5vd1NlY29uZHMgLSBDdXJyZW50IGVwb2NoIHNlY29uZHMuXG4gKiBAcGFyYW0gd2luZG93U2Vjb25kcyAtIEZyZXNobmVzcyB3aW5kb3csIGRlZmF1bHRcbiAqICAge0BsaW5rIExJVkVfSEVBUlRCRUFUX1dJTkRPV19TRUNPTkRTfS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRMaXZlSGVhcnRiZWF0TWFya2VyKFxuICBtYXJrZXJzOiBSZWFkb25seUFycmF5PFxuICAgIHsgbWFjaGluZUlkOiBzdHJpbmc7IGVwb2NoOiBudW1iZXI7IGNsZWFyZWQ6IGJvb2xlYW4gfVxuICA+LFxuICBub3dTZWNvbmRzOiBudW1iZXIsXG4gIHdpbmRvd1NlY29uZHM6IG51bWJlciA9IExJVkVfSEVBUlRCRUFUX1dJTkRPV19TRUNPTkRTLFxuKTogTGl2ZUhlYXJ0YmVhdE1hcmtlciB8IG51bGwge1xuICBsZXQgbGl2ZTogTGl2ZUhlYXJ0YmVhdE1hcmtlciB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XG4gICAgaWYgKG1hcmtlci5jbGVhcmVkKSBjb250aW51ZTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShtYXJrZXIuZXBvY2gpIHx8IG1hcmtlci5lcG9jaCA8PSAwKSBjb250aW51ZTtcbiAgICBjb25zdCBhZ2VTZWNvbmRzID0gTWF0aC5tYXgoMCwgbm93U2Vjb25kcyAtIG1hcmtlci5lcG9jaCk7XG4gICAgaWYgKGFnZVNlY29uZHMgPiB3aW5kb3dTZWNvbmRzKSBjb250aW51ZTtcbiAgICBpZiAobGl2ZSA9PT0gbnVsbCB8fCBtYXJrZXIuZXBvY2ggPiBsaXZlLmVwb2NoKSB7XG4gICAgICBsaXZlID0geyBtYWNoaW5lSWQ6IG1hcmtlci5tYWNoaW5lSWQsIGVwb2NoOiBtYXJrZXIuZXBvY2gsIGFnZVNlY29uZHMgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGxpdmU7XG59XG5cbi8qKlxuICogTGl2ZS1oZWFydGJlYXQgYXZhaWxhYmlsaXR5IGNoZWNrIGZvciBhbiB1bmFzc2lnbmVkIGlzc3VlIChJc3N1ZSAjMjE0KS5cbiAqXG4gKiBUaGUgYXNzaWduZWUgaXMgdGhlIGNsYWltIGxvY2sgZXZlcnkgaG9zdCBjaGVja3MsIHNvIGFuIGlzc3VlIHdob3NlXG4gKiBhc3NpZ25lZSB3YXMgZHJvcHBlZCBtaWQtcnVuIHJlYWRzIGFzIGZyZWUg4oCUIGFuZCBhIHNpYmxpbmcgaG9zdCBzdGFydHMgYVxuICogc2Vjb25kIGFnZW50IG9uIHRoZSBzYW1lIGlzc3VlIGFuZCBicmFuY2guIEEgbWFya2VyIHRoYXQgYmVhdCBpbnNpZGVcbiAqIHtAbGluayBMSVZFX0hFQVJUQkVBVF9XSU5ET1dfU0VDT05EU30gcHJvdmVzIGEgcnVuIHN0aWxsIGhvbGRzIGl0LCBzbyB0aGVcbiAqIGNsYWltIGlzIHJlZnVzZWQgYW5kIHRoZSBicm9rZW4gaW52YXJpYW50IGlzIGxvZ2dlZCBhdCBXQVJOSU5HLlxuICpcbiAqIEZhaWxzIG9wZW4gb24gYW55IEFQSSBlcnJvciwgbWF0Y2hpbmcgdGhlIG90aGVyIHByZS1jbGFpbSBjaGVja3M6IGFuXG4gKiB1bnJlYWNoYWJsZSBHaXRIdWIgbXVzdCBub3Qgc3RvcCB0aGUgZmxlZXQgY2xhaW1pbmcgd29yay5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbGl2ZUhlYXJ0YmVhdFdpdGhvdXRBc3NpZ25lZUNoZWNrKFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbiAgYWxsb3dlZEF1dGhvcnM6IHN0cmluZ1tdLFxuICBub3dTZWNvbmRzOiBudW1iZXIsXG4pOiBQcm9taXNlPExpdmVIZWFydGJlYXRNYXJrZXIgfCBudWxsPiB7XG4gIGxldCBtYXJrZXJzOiBBcnJheTx7IG1hY2hpbmVJZDogc3RyaW5nOyBlcG9jaDogbnVtYmVyOyBjbGVhcmVkOiBib29sZWFuIH0+O1xuICB0cnkge1xuICAgIG1hcmtlcnMgPSBhd2FpdCBzY2FuSGVhcnRiZWF0TWFya2VycyhcbiAgICAgIHJlcG8sXG4gICAgICBpc3N1ZU51bWJlcixcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgYWxsb3dlZEF1dGhvcnMsXG4gICAgKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7IC8vIEZhaWwgb3BlbiDigJQgcHJvY2VlZCB3aXRoIHRoZSBjbGFpbVxuICB9XG4gIGNvbnN0IGxpdmUgPSBmaW5kTGl2ZUhlYXJ0YmVhdE1hcmtlcihtYXJrZXJzLCBub3dTZWNvbmRzKTtcbiAgaWYgKGxpdmUgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBjb25zb2xlLndhcm4oXG4gICAgYFtjbGFpbV9pc3N1ZV0gcmVwbz0ke3JlcG99IGlzc3VlPSMke2lzc3VlTnVtYmVyfSBgICtcbiAgICAgIGBoZWFydGJlYXRfYWN0aXZlX3dpdGhvdXRfYXNzaWduZWUgbWFjaGluZT0ke2xpdmUubWFjaGluZUlkfSBgICtcbiAgICAgIGBsYXN0X2JlYXRfYWdlPSR7bGl2ZS5hZ2VTZWNvbmRzfXMg4oCUIHRoZSBjbGFpbSBsb2NrIHdhcyBkcm9wcGVkIHdoaWxlIGAgK1xuICAgICAgYHRoZSBydW4gaXMgc3RpbGwgYmVhdGluZzsgcmVmdXNpbmcgdG8gY2xhaW0gc28gYSBzZWNvbmQgYWdlbnQgaXMgbm90IGAgK1xuICAgICAgYHN0YXJ0ZWQgb24gdGhlIHNhbWUgaXNzdWUgKElzc3VlICMyMTQpYCxcbiAgKTtcbiAgcmV0dXJuIGxpdmU7XG59XG5cbi8qKlxuICogUHJlLWNsYWltIGZyZXNobmVzcyByZS1jaGVjayAoSXNzdWUgIzEwODYpLlxuICpcbiAqIFJlLWZldGNoZXMgdGhlIGlzc3VlJ3MgY3VycmVudCBhc3NpZ25lZXMgYW5kIHJlY2VudCBjbGFpbSBjb21tZW50c1xuICogaW1tZWRpYXRlbHkgYmVmb3JlIHRoZSBmdWxsIGNsYWltIHNlcXVlbmNlLiBUaGlzIG5hcnJvd3MgdGhlIHJhY2VcbiAqIHdpbmRvdyBieSBjYXRjaGluZyBjYXNlcyB3aGVyZSBhbm90aGVyIHdvcmtlciBjbGFpbWVkIHRoZSBpc3N1ZVxuICogYmV0d2VlbiBzY2FuIHRpbWUgYW5kIGNsYWltIHRpbWUuXG4gKlxuICogRmFpbHMgb3BlbiBvbiBBUEkgZXJyb3JzIOKAlCBpZiB0aGUgY2hlY2sgY2Fubm90IGJlIHBlcmZvcm1lZCwgdGhlXG4gKiB3b3JrZXIgcHJvY2VlZHMgd2l0aCB0aGUgZnVsbCBjbGFpbSBzZXF1ZW5jZSByYXRoZXIgdGhhbiBibG9ja2luZy5cbiAqXG4gKiBJc3N1ZSAjMzE2NDogd2hlbiBgYWxsb3dlZEF1dGhvcnNgICh0aGUgYHJlc29sdmVGbGVldEF1dGhvcnNgIHVuaW9uKSBpc1xuICogcHJvdmlkZWQgYW5kIG5vbi1lbXB0eSwgQ2hlY2sgMiBob25vdXJzIGEgcmVjZW50IGBDTEFJTV9MT0NLYCBjb21tZW50XG4gKiBvbmx5IHdoZW4gaXRzIGF1dGhvciBpcyBhIGZsZWV0IGFjY291bnQuIEEgZm9yZ2VkIGBDTEFJTV9MT0NLYCBwb3N0ZWQgYnlcbiAqIGFueSBvdGhlciBHaXRIdWIgdXNlciBpcyBpZ25vcmVkLCBzbyBhbiBhdHRhY2tlciB3aG8gY2FuIG1lcmVseSBjb21tZW50XG4gKiBvbiB0aGUgaXNzdWUgY2FuIG5vIGxvbmdlciBrZWVwIHRoZSB3b3JrZXIgZnJvbSBldmVyIGNsYWltaW5nIGl0IChmYWlsXG4gKiB0b3dhcmQgYWxsb3dpbmcgdGhlIGNsYWltKS4gV2hlbiBvbWl0dGVkL2VtcHR5IHRoZSBhdXRob3IgZmlsdGVyIGlzXG4gKiBkaXNhYmxlZCwgcHJlc2VydmluZyB0aGUgcHJpb3IgYmVoYXZpb3VyLlxuICpcbiAqIElzc3VlICMzNjY0OiBgY2xhaW1Jc3N1ZWAgbm93IGFsd2F5cyBzdXBwbGllcyBhIG5vbi1lbXB0eSBzZXQg4oCUIHRoZVxuICogZmxlZXQgdW5pb24gd2hlbiBrbm93biwgdGhlIGNsYWltaW5nIGFjY291bnQgb3RoZXJ3aXNlIOKAlCBzZWVcbiAqIGByZXNvbHZlVHJ1c3RlZENsYWltQXV0aG9yc2AuXG4gKlxuICogSXNzdWUgIzIzMzQ6IENoZWNrIDMgcmVmdXNlcyBhbiBpc3N1ZSB3aG9zZSBtaWxlc3RvbmUgc3RyZWFtIGFub3RoZXIgb3BlblxuICogc2libGluZyBpcyBhbHJlYWR5IHJ1bm5pbmcuIEl0IHJ1bnMgaGVyZSwgYmVmb3JlIHRoZSBhc3NpZ25tZW50IGFuZCBiZWZvcmVcbiAqIHRoZSBjbGFpbSBjb21tZW50LCBzbyBhIGJsb2NrZWQgaXNzdWUgY29zdHMgbm8gYXNzaWdubWVudCBjaHVybiDigJQgYW5kIGl0XG4gKiBydW5zIG9ubHkgd2hlbiBgc3RyZWFtTG9ja2AgaXMgc3VwcGxpZWQsIHNvIGEgZmxlZXQgd2l0aCBzZXNzaW9uIHJlc3VtZSBvZmZcbiAqIG1ha2VzIG5vIGV4dHJhIEFQSSBjYWxsLlxuICpcbiAqIElzc3VlICMyMzM2OiBDaGVjayA0IGRlZmVycyBhbiBpc3N1ZSB3aG9zZSBtaWxlc3RvbmUgc3RyZWFtIGFub3RoZXIgaG9zdFxuICogaG9sZHMsIGZvciBhcyBsb25nIGFzIHRoYXQgaG9zdCdzIGhlYWQgc3RhcnQgbGFzdHMuIEl0IHJ1bnMgbGFzdCBvZiB0aGVcbiAqIGZvdXIsIGJlY2F1c2UgaXQgaXMgdGhlIG9ubHkgb25lIHRoYXQgY2FuIGNoYW5nZSBpdHMgbWluZCBvbiBhIGxhdGVyIHNjYW4uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHByZUNsYWltRnJlc2huZXNzQ2hlY2soXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICBhbGxvd2VkQXV0aG9yczogc3RyaW5nW10gPSBbXSxcbiAgbm93U2Vjb25kczogbnVtYmVyID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCksXG4gIHN0cmVhbUxvY2s/OiB7XG4gICAgbWlsZXN0b25lVGl0bGU/OiBzdHJpbmc7XG4gICAgYWZmaW5pdHlIb3N0Pzogc3RyaW5nO1xuICAgIHdvcmtEaXI/OiBzdHJpbmc7XG4gICAgLyoqIENsYWltIGludG8gYSBidXN5IHN0cmVhbSByYXRoZXIgdGhhbiB3YWl0aW5nIGZvciBpdCAoSXNzdWUgIzI1MzApLiAqL1xuICAgIHNoYXJlYWJsZT86IGJvb2xlYW47XG4gIH0sXG4pOiBQcm9taXNlPFxuICB7XG4gICAgc2hvdWxkQmFpbE91dDogYm9vbGVhbjtcbiAgICByZWFzb24/OiBDbGFpbUZhaWx1cmVSZWFzb247XG4gICAgcmVhc29uRGV0YWlsPzogc3RyaW5nO1xuICAgIHN0cmVhbVNoYXJlZD86IFNoYXJlZFN0cmVhbTtcbiAgfVxuPiB7XG4gIC8vIENoZWNrIDE6IFJlLWZldGNoIGN1cnJlbnQgYXNzaWduZWVzXG4gIHRyeSB7XG4gICAgY29uc3QgYXNzaWduZWVzSnNvbiA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwiaXNzdWVcIixcbiAgICAgIFwidmlld1wiLFxuICAgICAgU3RyaW5nKGlzc3VlTnVtYmVyKSxcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWpzb25cIixcbiAgICAgIFwiYXNzaWduZWVzXCIsXG4gICAgICBcIi0tanFcIixcbiAgICAgIFwiWy5hc3NpZ25lZXNbXS5sb2dpbl1cIixcbiAgICBdKTtcbiAgICBjb25zdCB0cmltbWVkID0gYXNzaWduZWVzSnNvbi50cmltKCk7XG4gICAgaWYgKHRyaW1tZWQgJiYgdHJpbW1lZCAhPT0gXCJbXVwiICYmIHRyaW1tZWQgIT09IFwibnVsbFwiKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBhc3NpZ25lZXM6IHVua25vd24gPSBKU09OLnBhcnNlKHRyaW1tZWQpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShhc3NpZ25lZXMpICYmIGFzc2lnbmVlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgcmV0dXJuIHsgc2hvdWxkQmFpbE91dDogdHJ1ZSwgcmVhc29uOiBcImFscmVhZHlfYXNzaWduZWRcIiB9O1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gTm9uLUpTT04gcmVzcG9uc2Ug4oCUIGZhbGwgdGhyb3VnaFxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gRmFpbCBvcGVuIOKAlCBwcm9jZWVkIHdpdGggY2xhaW1cbiAgfVxuXG4gIC8vIENoZWNrIDFiIChJc3N1ZSAjMjE0KTogdGhlIGlzc3VlIGlzIHVuYXNzaWduZWQsIGJ1dCBhIGhlYXJ0YmVhdCB0aGF0XG4gIC8vIGJlYXQgd2l0aGluIHRoZSBsaXZlIHdpbmRvdyBtZWFucyBhIHJ1biBzdGlsbCBob2xkcyBpdCDigJQgdGhlIGNsYWltIGxvY2tcbiAgLy8gd2FzIGRyb3BwZWQgb3V0IGZyb20gdW5kZXIgaXQuIFRyZWF0IGl0IGFzIHVuYXZhaWxhYmxlLlxuICBjb25zdCBsaXZlSGVhcnRiZWF0ID0gYXdhaXQgbGl2ZUhlYXJ0YmVhdFdpdGhvdXRBc3NpZ25lZUNoZWNrKFxuICAgIHJlcG8sXG4gICAgaXNzdWVOdW1iZXIsXG4gICAgZ2hDb21tYW5kRm4sXG4gICAgYWxsb3dlZEF1dGhvcnMsXG4gICAgbm93U2Vjb25kcyxcbiAgKTtcbiAgaWYgKGxpdmVIZWFydGJlYXQgIT09IG51bGwpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hvdWxkQmFpbE91dDogdHJ1ZSxcbiAgICAgIHJlYXNvbjogXCJoZWFydGJlYXRfYWN0aXZlXCIsXG4gICAgICByZWFzb25EZXRhaWw6IGBtYWNoaW5lICR7bGl2ZUhlYXJ0YmVhdC5tYWNoaW5lSWR9IGJlYXQgYCArXG4gICAgICAgIGAke2xpdmVIZWFydGJlYXQuYWdlU2Vjb25kc31zIGFnbyB3aXRoIG5vIGFzc2lnbmVlYCxcbiAgICB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgMjogTG9vayBmb3IgcmVjZW50IENMQUlNX0xPQ0sgY29tbWVudHMgKHdpdGhpbiBsYXN0IDYwIHNlY29uZHMpXG4gIHRyeSB7XG4gICAgY29uc3QgY29tbWVudHNKc29uID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJhcGlcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy8ke2lzc3VlTnVtYmVyfS9jb21tZW50c2AsXG4gICAgICBcIi0tanFcIixcbiAgICAgIGBbLltdIHwgc2VsZWN0KC5ib2R5IHwgdGVzdChcIiR7Q0xBSU1fTUFSS0VSX1BSRUZJWH1cIikpIHwge2lkOiAuaWQsIGJvZHk6IC5ib2R5LCBjcmVhdGVkX2F0OiAuY3JlYXRlZF9hdCwgYXV0aG9yOiAudXNlci5sb2dpbn1dYCxcbiAgICBdKTtcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGNvbW1lbnRzSnNvbik7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICAgIGNvbnN0IGZpbHRlckJ5QXV0aG9yID0gYWxsb3dlZEF1dGhvcnMubGVuZ3RoID4gMDtcbiAgICAgIGZvciAoY29uc3QgY29tbWVudCBvZiBwYXJzZWQgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KSB7XG4gICAgICAgIC8vIElzc3VlICMzMTY0OiBpZ25vcmUgYSBmb3JnZWQgQ0xBSU1fTE9DSyBmcm9tIGEgbm9uLWZsZWV0IGF1dGhvclxuICAgICAgICAvLyB3aGVuIGEgZmxlZXQgYWxsb3ctbGlzdCB3YXMgc3VwcGxpZWQgKGZhaWwgdG93YXJkIGFsbG93aW5nIHRoZVxuICAgICAgICAvLyBjbGFpbSkuXG4gICAgICAgIGlmIChcbiAgICAgICAgICBmaWx0ZXJCeUF1dGhvciAmJlxuICAgICAgICAgICFpc0ZsZWV0QXV0aG9yKGNvbW1lbnQuYXV0aG9yIGFzIHN0cmluZywgYWxsb3dlZEF1dGhvcnMpXG4gICAgICAgICkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNyZWF0ZWRBdCA9IFN0cmluZyhjb21tZW50LmNyZWF0ZWRfYXQgPz8gXCJcIik7XG4gICAgICAgIGlmIChjcmVhdGVkQXQpIHtcbiAgICAgICAgICBjb25zdCBjb21tZW50QWdlID0gbm93IC0gbmV3IERhdGUoY3JlYXRlZEF0KS5nZXRUaW1lKCk7XG4gICAgICAgICAgaWYgKGNvbW1lbnRBZ2UgPj0gMCAmJiBjb21tZW50QWdlIDwgUkVDRU5UX0NMQUlNX1dJTkRPV19NUykge1xuICAgICAgICAgICAgcmV0dXJuIHsgc2hvdWxkQmFpbE91dDogdHJ1ZSwgcmVhc29uOiBcInJlY2VudF9jbGFpbVwiIH07XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBGYWlsIG9wZW4g4oCUIHByb2NlZWQgd2l0aCBjbGFpbVxuICB9XG5cbiAgLy8gQ2hlY2sgMyAoSXNzdWUgIzIzMzQpOiBvbmUgcnVuIHBlciBtaWxlc3RvbmUgc3RyZWFtIGF0IGEgdGltZSxcbiAgLy8gZmxlZXQtd2lkZS4gQSBzaWJsaW5nIG9wZW4gaXNzdWUgb2YgdGhlIHNhbWUgbWlsZXN0b25lIHdpdGggYSBiZWF0aW5nXG4gIC8vIGhlYXJ0YmVhdCDigJQgb3IgYSBjbGFpbSBwb3N0ZWQgc2Vjb25kcyBhZ28g4oCUIG1lYW5zIGEgcnVuIGlzIGFscmVhZHkgaW5zaWRlXG4gIC8vIHRoaXMgc3RyZWFtJ3MgY29udmVyc2F0aW9uLCBzbyB0aGlzIGlzc3VlIHdhaXRzIGZvciBhIGxhdGVyIHNjYW4uIE5vdCBhXG4gIC8vIGZhaWx1cmU6IG5vIGxhYmVsLCBubyBjaHVybiByZWNvcmQsIG5vIGNvb2xkb3duLlxuICBpZiAoc3RyZWFtTG9jayAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgY2hlY2tNaWxlc3RvbmVTdHJlYW1CdXN5KHtcbiAgICAgIHJlcG8sXG4gICAgICBpc3N1ZU51bWJlcixcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgdHJ1c3RlZEF1dGhvcnM6IGFsbG93ZWRBdXRob3JzLFxuICAgICAgbm93U2Vjb25kcyxcbiAgICAgIC4uLihzdHJlYW1Mb2NrLm1pbGVzdG9uZVRpdGxlXG4gICAgICAgID8geyBtaWxlc3RvbmVUaXRsZTogc3RyZWFtTG9jay5taWxlc3RvbmVUaXRsZSB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuICAgIGlmIChzdHJlYW0uYnVzeSkge1xuICAgICAgLy8gSXNzdWUgIzI1MzA6IGEgYHRvcC1wcmlvcml0eWAgb3IgYHdvcmstb25gIGlzc3VlIGlzIHdhbnRlZCBub3csIHNvIGl0XG4gICAgICAvLyBqb2lucyB0aGUgYnVzeSBzdHJlYW0gaW5zdGVhZCBvZiB3YWl0aW5nIOKAlCBpbiBpdHMgb3duIHBlci1pc3N1ZVxuICAgICAgLy8gY29udmVyc2F0aW9uLCBzbyB0aGUgc3RyZWFtJ3MgdHJhbnNjcmlwdCBzdGlsbCBjYXJyaWVzIG9uZSBydW4uIFRoZVxuICAgICAgLy8gYWZmaW5pdHkgaGVhZCBzdGFydCBiZWxvdyBpcyBza2lwcGVkIHdpdGggaXQ6IGEgc2Vjb25kIGhvbGRlciBoYXMgbm9cbiAgICAgIC8vIGNvbnZlcnNhdGlvbiB0byBoYW5kIG92ZXIuXG4gICAgICBpZiAoc3RyZWFtTG9jay5zaGFyZWFibGUpIHtcbiAgICAgICAgY29uc3QgeyBidXN5OiBfYnVzeSwgLi4uc2hhcmVkIH0gPSBzdHJlYW07XG4gICAgICAgIGNvbnNvbGUuaW5mbyhcbiAgICAgICAgICBgW2NsYWltX2lzc3VlXSByZXBvPSR7cmVwb30gaXNzdWU9IyR7aXNzdWVOdW1iZXJ9IHN0cmVhbSBzaGFyZWQ6IGAgK1xuICAgICAgICAgICAgYCR7c2hhcmVkLnN0cmVhbUxhYmVsfSBoZWxkIGJ5ICMke3NoYXJlZC5ob2xkZXJJc3N1ZX0gb24gYCArXG4gICAgICAgICAgICBgJHtzaGFyZWQuaG9sZGVySG9zdH0g4oCUIGNsYWltaW5nIGludG8gYSBwZXItaXNzdWUgc2Vzc2lvbiBgICtcbiAgICAgICAgICAgIGAoSXNzdWUgIzI1MjcpYCxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHsgc2hvdWxkQmFpbE91dDogZmFsc2UsIHN0cmVhbVNoYXJlZDogc2hhcmVkIH07XG4gICAgICB9XG4gICAgICBjb25zdCBkZXRhaWwgPSBmb3JtYXRTdHJlYW1CdXN5KHN0cmVhbSk7XG4gICAgICBjb25zb2xlLmluZm8oXG4gICAgICAgIGBbY2xhaW1faXNzdWVdIHJlcG89JHtyZXBvfSBpc3N1ZT0jJHtpc3N1ZU51bWJlcn0gJHtkZXRhaWx9IOKAlCBgICtcbiAgICAgICAgICBgcmV0cmllZCBvbiBhIGxhdGVyIHNjYW4gKElzc3VlICMyMzM0KWAsXG4gICAgICApO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc2hvdWxkQmFpbE91dDogdHJ1ZSxcbiAgICAgICAgcmVhc29uOiBcInN0cmVhbV9idXN5XCIsXG4gICAgICAgIHJlYXNvbkRldGFpbDogZGV0YWlsLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBDaGVjayA0IChJc3N1ZSAjMjMzNik6IHRoZSBzdHJlYW0ncyBjb252ZXJzYXRpb24gbGl2ZXMgb24gb25lIGhvc3QncyBkaXNrLFxuICAvLyBzbyB0aGUgaG9zdCB0aGF0IHJhbiBpdCBsYXN0IGdldHMgaXRzIG5leHQgaXNzdWUgZmlyc3QuIEEgbm9uLWhvbGRlciB3YWl0c1xuICAvLyBvdXQgdGhhdCBoZWFkIHN0YXJ0IGFuZCB0YWtlcyB0aGUgaXNzdWUgb24gYSBsYXRlciBzY2FuIGlmIHRoZSBob2xkZXIgaGFzXG4gIC8vIG5vdCBjb21lIGJhY2suIE5vdCBhIGZhaWx1cmUsIGFuZCBuZXZlciBhIGxvY2s6IGFmdGVyIHRoZSBncmFjZSB0aGUgZmlyc3RcbiAgLy8gaG9zdCB0byBzY2FuIGNsYWltcyBpdCBhbmQgc3RhcnRzIHRoZSBjb252ZXJzYXRpb24gYWZyZXNoLlxuICBpZiAoc3RyZWFtTG9jaz8uYWZmaW5pdHlIb3N0KSB7XG4gICAgY29uc3QgYWZmaW5pdHkgPSBhd2FpdCBjaGVja1N0cmVhbUFmZmluaXR5KHtcbiAgICAgIHJlcG8sXG4gICAgICBpc3N1ZU51bWJlcixcbiAgICAgIHRoaXNIb3N0OiBzdHJlYW1Mb2NrLmFmZmluaXR5SG9zdCxcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgdHJ1c3RlZEF1dGhvcnM6IGFsbG93ZWRBdXRob3JzLFxuICAgICAgbm93U2Vjb25kcyxcbiAgICAgIC4uLihzdHJlYW1Mb2NrLm1pbGVzdG9uZVRpdGxlXG4gICAgICAgID8geyBtaWxlc3RvbmVUaXRsZTogc3RyZWFtTG9jay5taWxlc3RvbmVUaXRsZSB9XG4gICAgICAgIDoge30pLFxuICAgICAgLi4uKHN0cmVhbUxvY2sud29ya0RpciA/IHsgd29ya0Rpcjogc3RyZWFtTG9jay53b3JrRGlyIH0gOiB7fSksXG4gICAgfSk7XG4gICAgLy8gVGhlIGNvdW50ZG93biBpcyBsb2dnZWQgYnkgYGNoZWNrU3RyZWFtQWZmaW5pdHlgIGl0c2VsZiwgb25jZSBwZXIgaXNzdWVcbiAgICAvLyDigJQgcmVwZWF0aW5nIGl0IGhlcmUgd291bGQgZG91YmxlIGV2ZXJ5IGRlZmVycmFsIGluIHRoZSBmbGVldCBsb2cuXG4gICAgaWYgKGFmZmluaXR5LmRlZmVyICYmIGFmZmluaXR5LmRldGFpbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc2hvdWxkQmFpbE91dDogdHJ1ZSxcbiAgICAgICAgcmVhc29uOiBcInN0cmVhbV9hZmZpbml0eVwiLFxuICAgICAgICByZWFzb25EZXRhaWw6IGFmZmluaXR5LmRldGFpbCxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgc2hvdWxkQmFpbE91dDogZmFsc2UgfTtcbn1cblxuLyoqIE9wdGlvbnMgY29udHJvbGxpbmcgYGZldGNoSXNzdWVTdGF0ZWAncyByZXRyeSBiZWhhdmlvdXIgKElzc3VlICMzMTUxKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRmV0Y2hJc3N1ZVN0YXRlT3B0aW9ucyB7XG4gIC8qKiBUb3RhbCBhdHRlbXB0cyBiZWZvcmUgZ2l2aW5nIHVwLiBEZWZhdWx0cyB0byAzLiAqL1xuICBtYXhBdHRlbXB0cz86IG51bWJlcjtcbiAgLyoqIEluamVjdGVkIHNsZWVwIGZvciB0aGUgcmV0cnkgYmFja29mZiAoZm9yIHRlc3RpbmcpLiAqL1xuICBzbGVlcEZuPzogKG1zOiBudW1iZXIpID0+IFByb21pc2U8dm9pZD47XG59XG5cbi8qKlxuICogRmV0Y2ggdGhlIGN1cnJlbnQgc3RhdGUgb2YgYSBHaXRIdWIgaXNzdWUgKFwiT1BFTlwiIG9yIFwiQ0xPU0VEXCIpLlxuICpcbiAqIElzc3VlICMzMTUxOiBhIHRyYW5zaWVudCBgZ2hgIGVycm9yIG11c3QgTk9UIGZhaWwgb3BlbiBpbnRvIHN0YXJ0aW5nIHdvcmtcbiAqIG9uIGEgcG9zc2libHktbWVyZ2VkL2Nsb3NlZCBpc3N1ZSDigJQgdGhlIHByZXZpb3VzIGZhaWwtb3Blbi10by1PUEVOIGxldCBhXG4gKiBtZXJnZWQgaXNzdWUgYmUgcmUtY2xhaW1lZCBhbmQgYSBkdXBsaWNhdGUgUFIgb3BlbmVkIChGYWlsdXJlIE1vZGUgQiBpblxuICogIzMxMzYpLiBUaGUgY2FsbCBpcyBub3cgcmV0cmllZCBhIGZldyB0aW1lcyB3aXRoIGEgc2hvcnQgYmFja29mZjsgaWYgZXZlcnlcbiAqIGF0dGVtcHQgZmFpbHMgdGhlIHN0YXRlIGlzIHRyZWF0ZWQgYXMgXCJDTE9TRURcIiAoZmFpbCBjbG9zZWQgLyBibG9ja2VkKSBzb1xuICogdGhlIHdvcmtlciBza2lwcyB0aGUgaXNzdWUgdGhpcyBjeWNsZSByYXRoZXIgdGhhbiBzdGFydGluZyB3b3JrIG9uIGl0LiBBXG4gKiBnZW51aW5lbHktb3BlbiBpc3N1ZSBpcyBzaW1wbHkgcmV0cmllZCBuZXh0IGN5Y2xlIG9uY2UgYGdoYCByZWNvdmVycy5cbiAqXG4gKiBJc3N1ZSAjMTgxOiB0aGlzIHJlYWQgbXVzdCBuZXZlciBiZSBzZXJ2ZWQgZnJvbSB0aGUgYElzc3VlQ2FjaGVgIOKAlCBhIHN0YWxlXG4gKiBcIk9QRU5cIiBoZXJlIGlzIGV4YWN0bHkgd2hhdCBsZXRzIGEgY2xvc2VkIGlzc3VlIGJlIGNsYWltZWQuIGBnaENvbW1hbmRGbmBcbiAqIGRlZmF1bHRzIHRvIHRoZSB1bmNhY2hlZCBgcnVuR2hDb21tYW5kYCwgYW5kIGNhbGxlcnMgbXVzdCBub3QgcGFzcyBhXG4gKiBjYWNoZS1iYWNrZWQgcmVhZGVyIGluIGl0cyBwbGFjZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoSXNzdWVTdGF0ZShcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4sXG4gIG9wdGlvbnM6IEZldGNoSXNzdWVTdGF0ZU9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IG1heEF0dGVtcHRzID0gb3B0aW9ucy5tYXhBdHRlbXB0cyA/PyAzO1xuICBjb25zdCBzbGVlcEZuID0gb3B0aW9ucy5zbGVlcEZuID8/IGRlZmF1bHRTbGVlcDtcbiAgbGV0IGxhc3RFcnJvcjogdW5rbm93bjtcblxuICBmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBtYXhBdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG91dHB1dCA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgICAgXCJpc3N1ZVwiLFxuICAgICAgICBcInZpZXdcIixcbiAgICAgICAgU3RyaW5nKGlzc3VlTnVtYmVyKSxcbiAgICAgICAgXCItLXJlcG9cIixcbiAgICAgICAgcmVwbyxcbiAgICAgICAgXCItLWpzb25cIixcbiAgICAgICAgXCJzdGF0ZVwiLFxuICAgICAgICBcIi0tanFcIixcbiAgICAgICAgXCIuc3RhdGVcIixcbiAgICAgIF0pO1xuICAgICAgY29uc3Qgc3RhdGUgPSBvdXRwdXQudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICByZXR1cm4gc3RhdGUgPT09IFwiQ0xPU0VEXCIgPyBcIkNMT1NFRFwiIDogXCJPUEVOXCI7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsYXN0RXJyb3IgPSBlcnI7XG4gICAgICBpZiAoYXR0ZW1wdCA8IG1heEF0dGVtcHRzKSB7XG4gICAgICAgIGF3YWl0IHNsZWVwRm4oMTAwMCAqIGF0dGVtcHQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IG1lc3NhZ2UgPSBsYXN0RXJyb3IgaW5zdGFuY2VvZiBFcnJvclxuICAgID8gbGFzdEVycm9yLm1lc3NhZ2VcbiAgICA6IFN0cmluZyhsYXN0RXJyb3IpO1xuICBjb25zb2xlLndhcm4oXG4gICAgYFtjbGFpbV9pc3N1ZV0gZmV0Y2hfaXNzdWVfc3RhdGVfZmFpbGVkIHJlcG89JHtyZXBvfSBpc3N1ZT0jJHtpc3N1ZU51bWJlcn0gYCArXG4gICAgICBgYXR0ZW1wdHM9JHttYXhBdHRlbXB0c30gZXJyb3I9JHttZXNzYWdlfSDigJQgdHJlYXRpbmcgYXMgQ0xPU0VEIHRvIGF2b2lkIGAgK1xuICAgICAgYHN0YXJ0aW5nIHdvcmsgb24gYSBwb3NzaWJseS1tZXJnZWQgaXNzdWUgKElzc3VlICMzMTUxKWAsXG4gICk7XG4gIHJldHVybiBcIkNMT1NFRFwiOyAvLyBGYWlsIGNsb3NlZFxufVxuXG4vKipcbiAqIERlZmF1bHQgY2xvc2VkLXRoaXMtcnVuIHByZWRpY2F0ZSAoSXNzdWUgIzE4MSkg4oCUIHRoZSBydW4ncyBzaGFyZWRcbiAqIHByb2Nlc3NlZC1pc3N1ZSByZWdpc3RyeSwgd2hpY2ggZXZlcnkgYGdoIGlzc3VlIGNsb3NlYCBpcyByZWNvcmRlZCBpbnRvIGF0XG4gKiB0aGUgYGdoYCBjaG9rZXBvaW50LlxuICovXG5mdW5jdGlvbiBkZWZhdWx0V2FzQ2xvc2VkVGhpc1J1bihyZXBvOiBzdHJpbmcsIGlzc3VlTnVtYmVyOiBudW1iZXIpOiBib29sZWFuIHtcbiAgcmV0dXJuIHNoYXJlZFByb2Nlc3NlZElzc3VlcygpLndhc0Nsb3NlZEJ5V29ya2VyKHJlcG8sIGlzc3VlTnVtYmVyKTtcbn1cblxuLyoqXG4gKiBEZWZhdWx0IHNsZWVwIGZ1bmN0aW9uIOKAlCB3YWl0cyB0aGUgZ2l2ZW4gbnVtYmVyIG9mIG1pbGxpc2Vjb25kcy5cbiAqL1xuZnVuY3Rpb24gZGVmYXVsdFNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG59XG5cbi8qKlxuICogUGFyc2UgY2xhaW0gY29tbWVudHMgZnJvbSBhIEdpdEh1YiBBUEkgSlNPTiByZXNwb25zZS5cbiAqXG4gKiBFeHBlY3RzIGEgSlNPTiBhcnJheSBvZiBvYmplY3RzIHdpdGggaWQsIGJvZHksIGFuZCBjcmVhdGVkX2F0IGZpZWxkcy5cbiAqL1xuZnVuY3Rpb24gcGFyc2VDbGFpbUNvbW1lbnRzKGpzb246IHN0cmluZyk6IENsYWltQ29tbWVudFtdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGpzb24pO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpKSByZXR1cm4gW107XG4gICAgcmV0dXJuIChwYXJzZWQgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KVxuICAgICAgLmZpbHRlcigoYykgPT5cbiAgICAgICAgdHlwZW9mIGMuYm9keSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICAoYy5ib2R5IGFzIHN0cmluZykuaW5jbHVkZXMoQ0xBSU1fTUFSS0VSX1BSRUZJWClcbiAgICAgIClcbiAgICAgIC5tYXAoKGMpID0+ICh7XG4gICAgICAgIGlkOiBOdW1iZXIoYy5pZCksXG4gICAgICAgIGJvZHk6IFN0cmluZyhjLmJvZHkpLFxuICAgICAgICBjcmVhdGVkQXQ6IFN0cmluZyhjLmNyZWF0ZWRfYXQgPz8gYy5jcmVhdGVkQXQgPz8gXCJcIiksXG4gICAgICAgIGF1dGhvcjogdHlwZW9mIGMuYXV0aG9yID09PSBcInN0cmluZ1wiID8gYy5hdXRob3IgOiB1bmRlZmluZWQsXG4gICAgICB9KSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKipcbiAqIEV4dHJhY3QgdGhlIHdvcmtlciBJRCBmcm9tIGEgY2xhaW0gY29tbWVudCBib2R5LlxuICpcbiAqIFBhdHRlcm46IGA8IS0tIENMQUlNX0xPQ0s6d29ya2VyLW5hbWUgLS0+YFxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdFdvcmtlcklkRnJvbUNvbW1lbnQoYm9keTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbWF0Y2ggPSBib2R5Lm1hdGNoKC88IS0tIENMQUlNX0xPQ0s6KFteIF0rKSAtLT4vKTtcbiAgcmV0dXJuIG1hdGNoPy5bMV0gPz8gXCJcIjtcbn1cblxuLyoqXG4gKiBDbGVhbiB1cCBzdGFsZSBjbGFpbSBjb21tZW50cyBmcm9tIHByZXZpb3VzIHJ1bnMuXG4gKlxuICogU3RhbGUgY2xhaW0gY29tbWVudHMgY2FuIGFjY3VtdWxhdGUgaWYgYSB3b3JrZXIgY3Jhc2hlcyBhZnRlciBwb3N0aW5nXG4gKiBhIGNsYWltIGJ1dCBiZWZvcmUgY29tcGxldGluZyB3b3JrLlxuICpcbiAqIElzc3VlICMzNjY0OiBvbmx5IHRoZSBmbGVldCdzICpvd24qIHN0YWxlIG1hcmtlcnMgYXJlIHJlbW92ZWQuIEEgY29tbWVudFxuICogaXMgZGVsZXRlZCBvbmx5IHdoZW4gaXRzIGF1dGhvciBpcyBhIHRydXN0ZWQgZmxlZXQgYWNjb3VudCAoYW4gb3V0c2lkZXInc1xuICogQ0xBSU1fTE9DSy1zaGFwZWQgY29tbWVudCDigJQgb3IgYSBodW1hbiBxdW90aW5nIHRoZSBtYXJrZXIg4oCUIGlzIG5vdCBvdXJzXG4gKiB0byBkZWxldGUpICoqYW5kKiogaXQgaXMgYXQgbGVhc3QgYFNUQUxFX0NMQUlNX01JTl9BR0VfTVNgIG9sZCAoYSB5b3VuZ2VyXG4gKiBtYXJrZXIgaXMgYSBsaXZlIGNsYWltLCBwb3NzaWJseSBhIHNpYmxpbmcncyBpbi1mbGlnaHQgb25lKS4gQSBtYXJrZXJcbiAqIHdob3NlIGFnZSBjYW5ub3QgYmUgZXN0YWJsaXNoZWQgaXMgbGVmdCBhbG9uZSByYXRoZXIgdGhhbiBhc3N1bWVkIHN0YWxlLlxuICovXG5hc3luYyBmdW5jdGlvbiBjbGVhbnVwU3RhbGVDbGFpbUNvbW1lbnRzKFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbiAgdHJ1c3RlZEF1dGhvcnM6IHN0cmluZ1tdLFxuICBub3dNczogbnVtYmVyID0gRGF0ZS5ub3coKSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBsZXQgY29tbWVudHNKc29uOiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgY29tbWVudHNKc29uID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJhcGlcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy8ke2lzc3VlTnVtYmVyfS9jb21tZW50c2AsXG4gICAgICBcIi0tanFcIixcbiAgICAgIGBbLltdIHwgc2VsZWN0KC5ib2R5IHwgdGVzdChcIiR7Q0xBSU1fTUFSS0VSX1BSRUZJWH1cIikpIHwge2lkOiAuaWQsIGNyZWF0ZWRfYXQ6IC5jcmVhdGVkX2F0LCBhdXRob3I6IC51c2VyLmxvZ2lufV1gLFxuICAgIF0pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm47IC8vIEJlc3QtZWZmb3J0XG4gIH1cblxuICBsZXQgZW50cmllczogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZDogdW5rbm93biA9IEpTT04ucGFyc2UoY29tbWVudHNKc29uKTtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSkgcmV0dXJuO1xuICAgIGVudHJpZXMgPSBwYXJzZWQgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBmaWx0ZXJCeUF1dGhvciA9IHRydXN0ZWRBdXRob3JzLmxlbmd0aCA+IDA7XG4gIGNvbnN0IGlkczogbnVtYmVyW10gPSBbXTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGVudHJ5ID09PSBudWxsIHx8IHR5cGVvZiBlbnRyeSAhPT0gXCJvYmplY3RcIikgY29udGludWU7XG4gICAgY29uc3QgaWQgPSBOdW1iZXIoZW50cnkuaWQpO1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkKSkgY29udGludWU7XG4gICAgaWYgKFxuICAgICAgZmlsdGVyQnlBdXRob3IgJiYgIWlzRmxlZXRBdXRob3IoZW50cnkuYXV0aG9yIGFzIHN0cmluZywgdHJ1c3RlZEF1dGhvcnMpXG4gICAgKSB7XG4gICAgICBjb250aW51ZTsgLy8gTm90IGEgZmxlZXQgbWFya2VyIOKAlCBub3Qgb3VycyB0byBkZWxldGVcbiAgICB9XG4gICAgY29uc3QgY3JlYXRlZE1zID0gbmV3IERhdGUoU3RyaW5nKGVudHJ5LmNyZWF0ZWRfYXQgPz8gXCJcIikpLmdldFRpbWUoKTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjcmVhdGVkTXMpKSBjb250aW51ZTsgLy8gQ2Fubm90IHByb3ZlIGl0IGlzIHN0YWxlXG4gICAgaWYgKG5vd01zIC0gY3JlYXRlZE1zIDwgU1RBTEVfQ0xBSU1fTUlOX0FHRV9NUykgY29udGludWU7IC8vIFN0aWxsIGluIGZsaWdodFxuICAgIGlkcy5wdXNoKGlkKTtcbiAgfVxuXG4gIGZvciAoY29uc3QgaWQgb2YgaWRzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgICAgXCJhcGlcIixcbiAgICAgICAgXCItWFwiLFxuICAgICAgICBcIkRFTEVURVwiLFxuICAgICAgICBgcmVwb3MvJHtyZXBvfS9pc3N1ZXMvY29tbWVudHMvJHtpZH1gLFxuICAgICAgXSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBCZXN0LWVmZm9ydCBjbGVhbnVwXG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogUmVtb3ZlIHRoaXMgd29ya2VyJ3MgY2xhaW0gY29tbWVudCBhZnRlciBsb3NpbmcgYSBjb250ZXN0ZWQgY2xhaW0uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZU93bkNsYWltQ29tbWVudChcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICB3b3JrZXJJZDogc3RyaW5nLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb21tZW50c0pzb24gPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcImFwaVwiLFxuICAgICAgYHJlcG9zLyR7cmVwb30vaXNzdWVzLyR7aXNzdWVOdW1iZXJ9L2NvbW1lbnRzYCxcbiAgICAgIFwiLS1qcVwiLFxuICAgICAgYFsuW10gfCBzZWxlY3QoLmJvZHkgfCBjb250YWlucyhcIkNMQUlNX0xPQ0s6JHt3b3JrZXJJZH1cIikpIHwgLmlkXSB8IC5bMF0gLy8gZW1wdHlgLFxuICAgIF0pO1xuICAgIGNvbnN0IGNvbW1lbnRJZCA9IGNvbW1lbnRzSnNvbi50cmltKCk7XG4gICAgaWYgKGNvbW1lbnRJZCkge1xuICAgICAgYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgICBcImFwaVwiLFxuICAgICAgICBcIi1YXCIsXG4gICAgICAgIFwiREVMRVRFXCIsXG4gICAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy9jb21tZW50cy8ke2NvbW1lbnRJZH1gLFxuICAgICAgXSk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBCZXN0LWVmZm9ydFxuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUHVibGljIEFQSVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRmluZCB0aGlzIHdvcmtlcidzIGNsYWltIGNvbW1lbnQgaW4gdGhlIHZlcmlmaWNhdGlvbiBsaXN0IGFuZCBzZWVkIHRoZVxuICogbWFya2VyIHN0YXRlIGZpbGUgc28gc3Vic2VxdWVudCBoZWFydGJlYXRzIFBBVENIIHRoZSBzYW1lIGNvbW1lbnRcbiAqIChJc3N1ZSAjMTYyOCkuIEJlc3QtZWZmb3J0IOKAlCBmYWlsdXJlIHNpbXBseSBtZWFucyB0aGUgbmV4dCBoZWFydGJlYXRcbiAqIHdpbGwgcG9zdCBhIHNlcGFyYXRlIG1hcmtlciBjb21tZW50IGluc3RlYWQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNlZWRNYXJrZXJTdGF0ZUZvck93bkNvbW1lbnQoXG4gIGNvbW1lbnRzOiBDbGFpbUNvbW1lbnRbXSxcbiAgd29ya2VySWQ6IHN0cmluZyxcbiAgY2xhaW1QcmVmaXg6IHN0cmluZyxcbiAgaW5pdGlhbEVwb2NoOiBudW1iZXIsXG4gIG1hcmtlck9wdGlvbnM6IENsYWltTWFya2VyT3B0aW9ucyB8IHVuZGVmaW5lZCxcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghbWFya2VyT3B0aW9ucykgcmV0dXJuO1xuICBjb25zdCBvd24gPSBjb21tZW50cy5maW5kKChjKSA9PlxuICAgIGV4dHJhY3RXb3JrZXJJZEZyb21Db21tZW50KGMuYm9keSkgPT09IHdvcmtlcklkXG4gICk7XG4gIGlmICghb3duIHx8ICFOdW1iZXIuaXNGaW5pdGUob3duLmlkKSkgcmV0dXJuO1xuICB0cnkge1xuICAgIGF3YWl0IHNlZWRNYXJrZXJTdGF0ZShtYXJrZXJPcHRpb25zLndvcmtEaXIsIHJlcG8sIGlzc3VlTnVtYmVyLCB7XG4gICAgICBjb21tZW50SWQ6IG93bi5pZCxcbiAgICAgIGxhc3RSZWZyZXNoOiBpbml0aWFsRXBvY2gsXG4gICAgICBjbGFpbVByZWZpeCxcbiAgICAgIC8vIElzc3VlICMzNzUyOiB0aGUgY2xhaW0gbW9tZW50IGlzIHRoZSBjbGFpbSdzIHN0YXJ0IHRpbWUsIGFuZCB0aGVcbiAgICAgIC8vIHdvcmtlciBpZCBpcyBzaG93biBpbiB0aGUgdmlzaWJsZSBoZWFydGJlYXQgYm9keSBvbiBldmVyeSByZWZyZXNoLlxuICAgICAgc3RhcnRlZEVwb2NoOiBpbml0aWFsRXBvY2gsXG4gICAgICB3b3JrZXJJZCxcbiAgICB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIOKAlCBoZWFydGJlYXQgdXBkYXRlciB3aWxsIGZhbGwgYmFjayB0byBpdHMgZXhpc3RpbmcgcG9zdCBwYXRoLlxuICB9XG59XG5cbi8qKlxuICogTGl2ZSwgY2FjaGUtYnlwYXNzaW5nIGZsZWV0IG9wZW4tUFIgcmUtY2hlY2sgKElzc3VlICMzMTUwKS5cbiAqXG4gKiBSdW4gYWZ0ZXIgdGhpcyBob3N0IHdpbnMgdGhlIGVhcmxpZXN0LWNvbW1lbnQgY2xhaW0gcmFjZSBhbmQgYmVmb3JlIGFueVxuICogQ2xhdWRlL3Rva2VuIHdvcmsgYmVnaW5zLiBGZXRjaGVzIG9wZW4gUFJzIGZvciBldmVyeSBmbGVldCBhY2NvdW50IHdpdGhcbiAqIHRoZSBwZXItdXNlciBjYWNoZSBmb3JjZS1yZWZyZXNoZWQsIHNvIGEgUFIgb3BlbmVkIGJ5IGEgc2libGluZyBhY2NvdW50XG4gKiAqYmV0d2VlbiogdGhpcyBob3N0J3MgZGlzY292ZXJ5IGFuZCBpdHMgY2xhaW0g4oCUIGludmlzaWJsZSB0byB0aGVcbiAqIGRpc2NvdmVyeS1vbmx5ICMzMTAwIGd1YXJkIOKAlCBpcyBzZWVuIGhlcmUuIE1hdGNoZXMgYSBibG9ja2luZyBQUiB0aGVcbiAqIHNhbWUgbWlsZXN0b25lLWF3YXJlIHdheSB0aGUgZGlzY292ZXJ5LXRpbWUgZ3VhcmQgZG9lcy5cbiAqXG4gKiBGYWlscyBvcGVuOiBhbiBlbXB0eSBmbGVldCBsaXN0LCBvciBhbnkgQVBJIGVycm9yLCByZXR1cm5zIGBudWxsYCBzbyBhXG4gKiB0cmFuc2llbnQgR2l0SHViIGZhaWx1cmUgbmV2ZXIgYmxvY2tzIGEgbGVnaXRpbWF0ZSBjbGFpbS5cbiAqXG4gKiBAcmV0dXJucyBUaGUgYmxvY2tpbmcgUFIgaWYgb25lIGFscmVhZHkgdGFyZ2V0cyB0aGlzIHdvcmsgc3RyZWFtLCBlbHNlXG4gKiAgIGBudWxsYC5cbiAqL1xuLyoqXG4gKiBSZWFkIHRoZSBpc3N1ZSdzIGxhYmVscyBub3csIGJ5cGFzc2luZyBldmVyeSBjYWNoZSAoSXNzdWUgIzgzMSkuXG4gKlxuICogRGlzY292ZXJ5IGV4Y2x1ZGVzIHRoZSBibG9ja2luZyBsYWJlbHMsIGJ1dCBpdCByYW5rcyBhIHNuYXBzaG90IG9mIHRoZVxuICogaXNzdWUgbGlzdDsgYSBsYWJlbCBhcHBsaWVkIGJldHdlZW4gdGhhdCBzbmFwc2hvdCBhbmQgdGhpcyBjbGFpbSBpc1xuICogaW52aXNpYmxlIHRvIGl0LiBUaGlzIGlzIHRoZSBsYWJlbCBjb3VudGVycGFydCBvZiB0aGUgYHdhc0Nsb3NlZFRoaXNSdW5gXG4gKiByZWZ1c2FsIChJc3N1ZSAjMTgxKSBhbmQgb2Yge0BsaW5rIGxpdmVGbGVldFByUmVjaGVja30gKElzc3VlICMzMTUwKSwgYW5kXG4gKiBpdCBydW5zICpiZWZvcmUqIHRoZSBhc3NpZ25tZW50IHNvIGEgcGFya2VkIGlzc3VlIGNvbGxlY3RzIG5laXRoZXIgYW5cbiAqIGFzc2lnbmVlIG5vciBhIGNsYWltIGNvbW1lbnQuXG4gKlxuICogRmFpbHMgb3BlbjogYW55IHJlYWQgZmFpbHVyZSByZXR1cm5zIGBudWxsYCBhbmQgdGhlIGNsYWltIHByb2NlZWRzIOKAlCBhXG4gKiBgZ2hgIGhpY2N1cCBtdXN0IG5ldmVyIHdpdGhob2xkIGEgbGVnaXRpbWF0ZSBjbGFpbS4gVGhlIHJlYXNvbiBpcyBsb2dnZWQuXG4gKlxuICogQHJldHVybnMgVGhlIGZpcnN0IGJsb2NraW5nIGxhYmVsIGZvdW5kIG9uIHRoZSBpc3N1ZSwgb3IgYG51bGxgLlxuICovXG5hc3luYyBmdW5jdGlvbiBsaXZlQmxvY2tpbmdMYWJlbFJlY2hlY2soXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgYmxvY2tpbmdMYWJlbHM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4sXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKGJsb2NraW5nTGFiZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJpc3N1ZVwiLFxuICAgICAgXCJ2aWV3XCIsXG4gICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tanNvblwiLFxuICAgICAgXCJsYWJlbHNcIixcbiAgICBdKTtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgeyBsYWJlbHM/OiB7IG5hbWU/OiBzdHJpbmcgfVtdIH07XG4gICAgY29uc3QgcHJlc2VudCA9IG5ldyBTZXQoXG4gICAgICAocGFyc2VkLmxhYmVscyA/PyBbXSlcbiAgICAgICAgLm1hcCgobGFiZWwpID0+IGxhYmVsPy5uYW1lKVxuICAgICAgICAuZmlsdGVyKChuYW1lKTogbmFtZSBpcyBzdHJpbmcgPT4gdHlwZW9mIG5hbWUgPT09IFwic3RyaW5nXCIpXG4gICAgICAgIC5tYXAoKG5hbWUpID0+IG5hbWUudG9Mb3dlckNhc2UoKSksXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IGxhYmVsIG9mIGJsb2NraW5nTGFiZWxzKSB7XG4gICAgICBpZiAocHJlc2VudC5oYXMobGFiZWwudG9Mb3dlckNhc2UoKSkpIHJldHVybiBsYWJlbDtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgY29uc29sZS53YXJuKFxuICAgICAgYFtjbGFpbV9pc3N1ZV0gYmxvY2tpbmdfbGFiZWxfcmVjaGVja19mYWlsZWQgcmVwbz0ke3JlcG99IGAgK1xuICAgICAgICBgaXNzdWU9IyR7aXNzdWVOdW1iZXJ9IOKAlCBwcm9jZWVkaW5nIHdpdGggdGhlIGNsYWltOiAke21lc3NhZ2V9YCxcbiAgICApO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxpdmVGbGVldFByUmVjaGVjayhcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBmbGVldEF1dGhvcnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkLFxuICBwdXNoQ2FwYWJsZUF1dGhvcnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkLFxuICBtaWxlc3RvbmVUaXRsZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBjYWNoZTogSXNzdWVDYWNoZSB8IHVuZGVmaW5lZCxcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICBmbGVldFByU2xvdHM6IG51bWJlciB8IHVuZGVmaW5lZCxcbik6IFByb21pc2U8QmxvY2tpbmdQUkluZm8gfCBudWxsPiB7XG4gIGNvbnN0IGF1dGhvcnMgPSAoZmxlZXRBdXRob3JzID8/IFtdKS5maWx0ZXIoXG4gICAgKGEpID0+IHR5cGVvZiBhID09PSBcInN0cmluZ1wiICYmIGEudHJpbSgpLmxlbmd0aCA+IDAsXG4gICk7XG4gIGlmIChhdXRob3JzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcHJzID0gYXdhaXQgZmV0Y2hPcGVuUFJzRm9yRmxlZXQoXG4gICAgICByZXBvLFxuICAgICAgYXV0aG9ycyxcbiAgICAgIGNhY2hlLFxuICAgICAgZ2hDb21tYW5kRm4sXG4gICAgICB1bmRlZmluZWQsXG4gICAgICB0cnVlLCAvLyBmb3JjZVJlZnJlc2gg4oCUIGJ5cGFzcyBhbnkgc3RhbGUgZGlzY292ZXJ5LXRpbWUgcHJzXyR7dXNlcn1cbiAgICApO1xuICAgIHJldHVybiBnZXRCbG9ja2luZ1BSRm9ySXNzdWUoXG4gICAgICBwcnMsXG4gICAgICBtaWxlc3RvbmVUaXRsZSA/PyBcIlwiLFxuICAgICAgcHVzaENhcGFibGVBdXRob3JzID8/IFtdLFxuICAgICAgZmxlZXRQclNsb3RzLFxuICAgICAgaXNzdWVOdW1iZXIsXG4gICAgKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW2NsYWltX2lzc3VlXSBmbGVldF9wcl9yZWNoZWNrX2ZhaWxlZCByZXBvPSR7cmVwb30gaXNzdWU9IyR7aXNzdWVOdW1iZXJ9IGAgK1xuICAgICAgICBgZXJyb3I9JHttZXNzYWdlfWAsXG4gICAgKTtcbiAgICByZXR1cm4gbnVsbDsgLy8gRmFpbCBvcGVuXG4gIH1cbn1cblxuLyoqIFBhcmFtZXRlcnMgZm9yIGZpbmFsaXNpbmcgYSB3b24gY2xhaW0gKElzc3VlICMzMTUwKS4gKi9cbmludGVyZmFjZSBGaW5hbGlzZVdvbkNsYWltUGFyYW1zIHtcbiAgcmVwbzogc3RyaW5nO1xuICBpc3N1ZU51bWJlcjogbnVtYmVyO1xuICBnaXRodWJVc2VyOiBzdHJpbmc7XG4gIHdvcmtlcklkOiBzdHJpbmc7XG4gIGNvbXBldGluZ1dvcmtlckNvdW50OiBudW1iZXI7XG4gIGZsZWV0QXV0aG9yczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gIHB1c2hDYXBhYmxlQXV0aG9yczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gIG1pbGVzdG9uZVRpdGxlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGZsZWV0UHJTbG90czogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBjb21wbGV0aW9uQWRtaXNzaW9uOiBDb21wbGV0aW9uUG9saWN5IHwgdW5kZWZpbmVkO1xuICBzbGVlcEZuOiAobXM6IG51bWJlcikgPT4gUHJvbWlzZTx2b2lkPjtcbiAgY2FjaGU6IElzc3VlQ2FjaGUgfCB1bmRlZmluZWQ7XG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbiAgYWxsQ2xhaW1Db21tZW50czogQ2xhaW1Db21tZW50W107XG4gIGNsYWltUHJlZml4OiBzdHJpbmc7XG4gIGluaXRpYWxFcG9jaDogbnVtYmVyO1xuICBtYXJrZXJPcHRpb25zOiBDbGFpbU1hcmtlck9wdGlvbnMgfCB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogRmluYWxpc2UgYSBjbGFpbSB0aGlzIGhvc3QgaGFzIGp1c3Qgd29uIHRoZSBjb21tZW50IHJhY2UgZm9yIChJc3N1ZVxuICogIzMxNTApLlxuICpcbiAqIEJlZm9yZSBkZWNsYXJpbmcgc3VjY2VzcywgcnVuIHRoZSBsaXZlIGZsZWV0LVBSIHJlLWNoZWNrLiBJZiBhIGZsZWV0IFBSXG4gKiBhbHJlYWR5IHRhcmdldHMgdGhpcyB3b3JrIHN0cmVhbSwgYWJvcnQgdGhlIGNsYWltIOKAlCBtaXJyb3JpbmcgdGhlXG4gKiBgY2xhaW1fcmFjZT1sb3N0YCBjbGVhbnVwOiByZW1vdmUgdGhpcyB3b3JrZXIncyBjbGFpbSBjb21tZW50LCByZWxlYXNlXG4gKiB0aGUgYXNzaWdubWVudCwgYW5kIHJldHVybiBgZmxlZXRfcHJfZXhpc3RzYC4gT3RoZXJ3aXNlIHNlZWQgdGhlIG1hcmtlclxuICogc3RhdGUgYW5kIHJldHVybiB0aGUgc3VjY2Vzc2Z1bCBjbGFpbS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZmluYWxpc2VXb25DbGFpbShcbiAgcGFyYW1zOiBGaW5hbGlzZVdvbkNsYWltUGFyYW1zLFxuKTogUHJvbWlzZTxSZXN1bHQ8Q2xhaW1SZXN1bHQ+PiB7XG4gIGNvbnN0IHtcbiAgICByZXBvLFxuICAgIGlzc3VlTnVtYmVyLFxuICAgIGdpdGh1YlVzZXIsXG4gICAgd29ya2VySWQsXG4gICAgY29tcGV0aW5nV29ya2VyQ291bnQsXG4gICAgZmxlZXRBdXRob3JzLFxuICAgIHB1c2hDYXBhYmxlQXV0aG9ycyxcbiAgICBtaWxlc3RvbmVUaXRsZSxcbiAgICBmbGVldFByU2xvdHMsXG4gICAgY29tcGxldGlvbkFkbWlzc2lvbixcbiAgICBjYWNoZSxcbiAgICBnaENvbW1hbmRGbixcbiAgICBhbGxDbGFpbUNvbW1lbnRzLFxuICAgIGNsYWltUHJlZml4LFxuICAgIGluaXRpYWxFcG9jaCxcbiAgICBtYXJrZXJPcHRpb25zLFxuICB9ID0gcGFyYW1zO1xuXG4gIGNvbnN0IGJsb2NraW5nUHIgPSBhd2FpdCBsaXZlRmxlZXRQclJlY2hlY2soXG4gICAgcmVwbyxcbiAgICBpc3N1ZU51bWJlcixcbiAgICBmbGVldEF1dGhvcnMsXG4gICAgcHVzaENhcGFibGVBdXRob3JzLFxuICAgIG1pbGVzdG9uZVRpdGxlLFxuICAgIGNhY2hlLFxuICAgIGdoQ29tbWFuZEZuLFxuICAgIGNvbXBsZXRpb25BZG1pc3Npb24gPyBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUiA6IGZsZWV0UHJTbG90cyxcbiAgKTtcbiAgaWYgKGJsb2NraW5nUHIpIHtcbiAgICBpbmNyZW1lbnRDb3VudGVyKFwiY2xhaW1Db25mbGljdHNcIik7XG4gICAgLy8gSXNzdWUgIzQwNzg6IG5hbWUgdGhlIGJsb2NraW5nIFBSJ3MgYXV0aG9yLiBUaGUgY2xhaW0gcGF0aCBvbmx5XG4gICAgLy8gc3RhbmRzIGRvd24gKG5vIFBSIGlzIGV2ZXIgdG91Y2hlZCBoZXJlKTsgdGhlIGB3b3JrLW9uYCBzY2FuIHRoYXRcbiAgICAvLyBzZWVzIHRoZSBzYW1lIGJsb2NrIGVzY2FsYXRlcyBgbmVlZHMtaHVtYW5gIG9uIHRoZSBpc3N1ZSwgc28gdGhlXG4gICAgLy8gYXV0aG9yIGluIHRoaXMgbGluZSB0aWVzIHRoZSBhYm9ydCB0byB0aGF0IGVzY2FsYXRpb24uXG4gICAgY29uc29sZS5lcnJvcihcbiAgICAgIGBbY2xhaW1faXNzdWVdIHJlcG89JHtyZXBvfSBpc3N1ZT0jJHtpc3N1ZU51bWJlcn0gY2xhaW1fYWJvcnQ9ZmxlZXRfcHJfZXhpc3RzIGAgK1xuICAgICAgICBgYmxvY2tpbmdfcHI9IyR7YmxvY2tpbmdQci5udW1iZXJ9IGAgK1xuICAgICAgICBgYmxvY2tpbmdfcHJfYXV0aG9yPSR7YmxvY2tpbmdQci5hdXRob3IgfHwgXCIodW5rbm93bilcIn0gYCArXG4gICAgICAgIGB3b3JrZXI9JHt3b3JrZXJJZH1gLFxuICAgICk7XG4gICAgLy8gTWlycm9yIHRoZSBjbGFpbV9yYWNlPWxvc3QgY2xlYW51cDogZHJvcCBvdXIgY2xhaW0gY29tbWVudCBhbmRcbiAgICAvLyByZWxlYXNlIHRoZSBhc3NpZ25tZW50IHNvIGEgc2libGluZy9uZXh0IHdvcmtlciBpcyB1bmJsb2NrZWQuXG4gICAgYXdhaXQgcmVtb3ZlT3duQ2xhaW1Db21tZW50KHJlcG8sIGlzc3VlTnVtYmVyLCB3b3JrZXJJZCwgZ2hDb21tYW5kRm4pO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICAgIFwiaXNzdWVcIixcbiAgICAgICAgXCJlZGl0XCIsXG4gICAgICAgIFN0cmluZyhpc3N1ZU51bWJlciksXG4gICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgIHJlcG8sXG4gICAgICAgIFwiLS1yZW1vdmUtYXNzaWduZWVcIixcbiAgICAgICAgZ2l0aHViVXNlcixcbiAgICAgIF0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gQmVzdC1lZmZvcnRcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHtcbiAgICAgICAgY2xhaW1lZDogZmFsc2UsXG4gICAgICAgIGNvbXBldGluZ1dvcmtlckNvdW50LFxuICAgICAgICByZWFzb246IFwiZmxlZXRfcHJfZXhpc3RzXCIsXG4gICAgICAgIHJlYXNvbkRldGFpbDogYmxvY2tpbmdQci5mbGVldFByQ2FwXG4gICAgICAgICAgPyBgb3BlbiAke2Rlc2NyaWJlQmxvY2tpbmdQcihibG9ja2luZ1ByKX0g4oCUIG9uZSBmbGVldCBQUiBwZXIgc2xvdGBcbiAgICAgICAgICA6IGBvcGVuIFBSICMke2Jsb2NraW5nUHIubnVtYmVyfSBhbHJlYWR5IHRhcmdldHMgdGhpcyB3b3JrIHN0cmVhbWAsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICBpZiAoY29tcGxldGlvbkFkbWlzc2lvbikge1xuICAgIGxldCByZWFzb246IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgb3duID0gYWxsQ2xhaW1Db21tZW50cy5maW5kKChjKSA9PlxuICAgICAgICBleHRyYWN0V29ya2VySWRGcm9tQ29tbWVudChjLmJvZHkpID09PSB3b3JrZXJJZFxuICAgICAgKTtcbiAgICAgIGlmICghb3duIHx8ICFtYXJrZXJPcHRpb25zKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkltcGxlbWVudGF0aW9uIHJlc2VydmF0aW9uIHJlcXVpcmVzIGEgY2xhaW0gaGVhcnRiZWF0XCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBiYXNlID0gbWlsZXN0b25lVGl0bGVcbiAgICAgICAgPyBjcmVhdGVNaWxlc3RvbmVCcmFuY2hOYW1lKG1pbGVzdG9uZVRpdGxlKVxuICAgICAgICA6IChhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICAgICAgXCJhcGlcIixcbiAgICAgICAgICBgcmVwb3MvJHtyZXBvfWAsXG4gICAgICAgICAgXCItLWpxXCIsXG4gICAgICAgICAgXCIuZGVmYXVsdF9icmFuY2hcIixcbiAgICAgICAgXSkpLnRyaW0oKTtcbiAgICAgIGlmICghYmFzZSB8fCBiYXNlID09PSBcIm51bGxcIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3QgcmVzb2x2ZSBpbXBsZW1lbnRhdGlvbiB0YXJnZXQgYnJhbmNoXCIpO1xuICAgICAgfVxuICAgICAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGFkbWl0Q29tcGxldGlvbldvcmsoXG4gICAgICAgIG1ha2VHaXRIdWJDb21wbGV0aW9uU3RvcmUoe1xuICAgICAgICAgIHJlcG8sXG4gICAgICAgICAgd29ya2VySWQsXG4gICAgICAgICAgZmxlZXRBdXRob3JzOiBwdXNoQ2FwYWJsZUF1dGhvcnMgPz8gW2dpdGh1YlVzZXJdLFxuICAgICAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgICAgIHNsZWVwRm46IHBhcmFtcy5zbGVlcEZuLFxuICAgICAgICB9KSxcbiAgICAgICAgY29tcGxldGlvbkFkbWlzc2lvbixcbiAgICAgICAgeyBpc3N1ZTogaXNzdWVOdW1iZXIsIGJhc2UsIGNsYWltSWQ6IG93bi5pZCwgd29ya2VySWQgfSxcbiAgICAgICk7XG4gICAgICBjb25zb2xlLmluZm8oXG4gICAgICAgIGBbY29tcGxldGlvbl9hZG1pc3Npb25dICR7cmVwb30jJHtpc3N1ZU51bWJlcn0gcHJlc3N1cmU9JHt2ZXJkaWN0LnByZXNzdXJlfSBtb2RlPSR7dmVyZGljdC5tb2RlfTogJHt2ZXJkaWN0LnJlYXNvbn1gLFxuICAgICAgKTtcbiAgICAgIGlmICghdmVyZGljdC5hbGxvd2VkKSByZWFzb24gPSB2ZXJkaWN0LnJlYXNvbjtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmVhc29uID0gYHNoYXJlZCBjYXBhY2l0eSB1bmF2YWlsYWJsZTsgcmV0cnkgbmV4dCBzY2FuOiAke2Vycm9yfWA7XG4gICAgfVxuICAgIGlmIChyZWFzb24pIHtcbiAgICAgIGF3YWl0IHJlbW92ZU93bkNsYWltQ29tbWVudChyZXBvLCBpc3N1ZU51bWJlciwgd29ya2VySWQsIGdoQ29tbWFuZEZuKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgICAgICBcImlzc3VlXCIsXG4gICAgICAgICAgXCJlZGl0XCIsXG4gICAgICAgICAgU3RyaW5nKGlzc3VlTnVtYmVyKSxcbiAgICAgICAgICBcIi0tcmVwb1wiLFxuICAgICAgICAgIHJlcG8sXG4gICAgICAgICAgXCItLXJlbW92ZS1hc3NpZ25lZVwiLFxuICAgICAgICAgIGdpdGh1YlVzZXIsXG4gICAgICAgIF0pO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBbY29tcGxldGlvbl9hZG1pc3Npb25dIGNsYWltIGFzc2lnbm1lbnQgY2xlYW51cCBmYWlsZWQ6ICR7ZXJyb3J9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZToge1xuICAgICAgICAgIGNsYWltZWQ6IGZhbHNlLFxuICAgICAgICAgIGNvbXBldGluZ1dvcmtlckNvdW50LFxuICAgICAgICAgIHJlYXNvbjogXCJjb21wbGV0aW9uX21vZGVcIixcbiAgICAgICAgICByZWFzb25EZXRhaWw6IHJlYXNvbixcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgYXdhaXQgc2VlZE1hcmtlclN0YXRlRm9yT3duQ29tbWVudChcbiAgICBhbGxDbGFpbUNvbW1lbnRzLFxuICAgIHdvcmtlcklkLFxuICAgIGNsYWltUHJlZml4LFxuICAgIGluaXRpYWxFcG9jaCxcbiAgICBtYXJrZXJPcHRpb25zLFxuICAgIHJlcG8sXG4gICAgaXNzdWVOdW1iZXIsXG4gICk7XG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHsgY2xhaW1lZDogdHJ1ZSwgd2lubmVySWQ6IHdvcmtlcklkLCBjb21wZXRpbmdXb3JrZXJDb3VudCB9LFxuICB9O1xufVxuXG4vKipcbiAqIEF0b21pY2FsbHkgY2xhaW0gYW4gaXNzdWUgd2l0aCB2ZXJpZmljYXRpb24uXG4gKlxuICogQXNzaWducyB0aGUgY3VycmVudCB3b3JrZXIgdG8gdGhlIGlzc3VlLCBwb3N0cyBhIGNsYWltIGNvbW1lbnQgd2l0aCBhXG4gKiB1bmlxdWUgd29ya2VyIElELCB0aGVuIHZlcmlmaWVzIG5vIGNvbXBldGluZyBjbGFpbXMgZXhpc3QuIElmIG11bHRpcGxlXG4gKiB3b3JrZXJzIGNsYWltZWQgc2ltdWx0YW5lb3VzbHksIHRoZSBlYXJsaWVzdCBjbGFpbSBjb21tZW50IHdpbnMuXG4gKlxuICogQHJldHVybnMgUmVzdWx0IHdpdGggY2xhaW0gb3V0Y29tZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xhaW1Jc3N1ZShcbiAgb3B0aW9uczogQ2xhaW1PcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8Q2xhaW1SZXN1bHQ+PiB7XG4gIGNvbnN0IHtcbiAgICByZXBvLFxuICAgIGlzc3VlTnVtYmVyLFxuICAgIGdpdGh1YlVzZXIsXG4gICAgd29ya2VySWQsXG4gICAgaG9zdG5hbWUsXG4gICAgc2xlZXBGbiA9IGRlZmF1bHRTbGVlcCxcbiAgICBnaENvbW1hbmRGbiA9IHJ1bkdoQ29tbWFuZCxcbiAgICBtYXJrZXJPcHRpb25zLFxuICAgIGZsZWV0QXV0aG9ycyxcbiAgICBwdXNoQ2FwYWJsZUF1dGhvcnMsXG4gICAgbWlsZXN0b25lVGl0bGUsXG4gICAgZmxlZXRQclNsb3RzLFxuICAgIGNhY2hlLFxuICAgIHdhc0Nsb3NlZFRoaXNSdW4gPSBkZWZhdWx0V2FzQ2xvc2VkVGhpc1J1bixcbiAgICBibG9ja2luZ0xhYmVscyA9IFtMQUJFTF9ERUZBVUxUUy5uZWVkc0h1bWFuTGFiZWxdLFxuICAgIHN0cmVhbUxvY2tFbmFibGVkID0gZmFsc2UsXG4gICAgc3RyZWFtU2hhcmVhYmxlID0gZmFsc2UsXG4gIH0gPSBvcHRpb25zO1xuXG4gIC8vIElzc3VlICMxODE6IHRoZSB3b3JrZXIgY2xvc2VkIHRoaXMgaXNzdWUgZWFybGllciBpbiB0aGlzIHJ1biwgc28gbm9cbiAgLy8gYW1vdW50IG9mIGNhY2hlZCBcIk9QRU5cIiBjYW4gbWFrZSBpdCBjbGFpbWFibGUuIFJlZnVzZWQgYmVmb3JlIGFueSBBUElcbiAgLy8gY2FsbCDigJQgdGhlIHNjYW4gb25seSBvZmZlcmVkIGl0IGJlY2F1c2UgdGhlIGlzc3VlIGxpc3QgaXQgcmFua2VkICg2MDAgc1xuICAvLyBUVEwpIHdhcyB3cml0dGVuIGJlZm9yZSB0aGUgY2xvc2UuXG4gIGlmICh3YXNDbG9zZWRUaGlzUnVuKHJlcG8sIGlzc3VlTnVtYmVyKSkge1xuICAgIGNvbnNvbGUud2FybihcbiAgICAgIGBbY2xhaW1faXNzdWVdIGNsYWltX3JlZnVzZWQgcmVwbz0ke3JlcG99IGlzc3VlPSMke2lzc3VlTnVtYmVyfSBgICtcbiAgICAgICAgYHJlYXNvbj1jbG9zZWRfYnlfdGhpc19ydW4g4oCUIHRoZSBzY2FuIHJhbmtlZCBhIGNhY2hlZCBpc3N1ZSBsaXN0IGAgK1xuICAgICAgICBgd3JpdHRlbiBiZWZvcmUgdGhpcyB3b3JrZXIgY2xvc2VkIGl0IChJc3N1ZSAjMTgxKWAsXG4gICAgKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZToge1xuICAgICAgICBjbGFpbWVkOiBmYWxzZSxcbiAgICAgICAgcmVhc29uOiBcImFscmVhZHlfY2xvc2VkXCIsXG4gICAgICAgIHJlYXNvbkRldGFpbDogXCJ0aGlzIHdvcmtlciBjbG9zZWQgdGhlIGlzc3VlIGVhcmxpZXIgaW4gdGhpcyBydW5cIixcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8vIElzc3VlICM4MzE6IGEgYmxvY2tpbmcgbGFiZWwgYXBwbGllZCBzaW5jZSB0aGUgc2NhbidzIHNuYXBzaG90LiBUaGVcbiAgLy8gd29ya2VyIGl0c2VsZiBpcyBhIGNvbW1vbiBzb3VyY2Ug4oCUIGEgZ3JpbGwtbWUgcm91bmQgZW5kcyBieSBhZGRpbmdcbiAgLy8gYG5lZWRzLWh1bWFuYCDigJQgc28gYW4gaXNzdWUgcGFya2VkIHNlY29uZHMgYWdvIGNhbiBzdGlsbCBiZSB0b3Agb2YgYVxuICAvLyByYW5rZWQgbGlzdCB3cml0dGVuIGJlZm9yZSBpdC4gQ2hlY2tlZCBsaXZlLCBiZWZvcmUgdGhlIGFzc2lnbm1lbnQgYW5kXG4gIC8vIHRoZSBjbGFpbSBjb21tZW50LCBzbyBhIHBhcmtlZCBpc3N1ZSBjb2xsZWN0cyBuZWl0aGVyLlxuICBjb25zdCBibG9ja2luZ0xhYmVsID0gYXdhaXQgbGl2ZUJsb2NraW5nTGFiZWxSZWNoZWNrKFxuICAgIHJlcG8sXG4gICAgaXNzdWVOdW1iZXIsXG4gICAgYmxvY2tpbmdMYWJlbHMsXG4gICAgZ2hDb21tYW5kRm4sXG4gICk7XG4gIGlmIChibG9ja2luZ0xhYmVsKSB7XG4gICAgaW5jcmVtZW50Q291bnRlcihcImNsYWltQ29uZmxpY3RzXCIpO1xuICAgIGNvbnNvbGUud2FybihcbiAgICAgIGBbY2xhaW1faXNzdWVdIGNsYWltX3JlZnVzZWQgcmVwbz0ke3JlcG99IGlzc3VlPSMke2lzc3VlTnVtYmVyfSBgICtcbiAgICAgICAgYHJlYXNvbj1ibG9ja2luZ19sYWJlbCBsYWJlbD0ke2Jsb2NraW5nTGFiZWx9IOKAlCBhcHBsaWVkIGJldHdlZW4gdGhlIGAgK1xuICAgICAgICBgc2NhbidzIHNuYXBzaG90IGFuZCB0aGlzIGNsYWltIChJc3N1ZSAjODMxKWAsXG4gICAgKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZToge1xuICAgICAgICBjbGFpbWVkOiBmYWxzZSxcbiAgICAgICAgcmVhc29uOiBcImJsb2NraW5nX2xhYmVsXCIsXG4gICAgICAgIHJlYXNvbkRldGFpbDpcbiAgICAgICAgICBgdGhlIGlzc3VlIGNhcnJpZXMgXFxgJHtibG9ja2luZ0xhYmVsfVxcYCwgYXBwbGllZCBhZnRlciB0aGUgc2NhbiBgICtcbiAgICAgICAgICBgcmFua2VkIGl0YCxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8vIFJlc29sdmUgdGhlIGhvc3QgdGhhdCBpcyBtYWtpbmcgdGhlIGNsYWltLiBTdXJmYWNpbmcgdGhlIGhvc3RuYW1lIGluXG4gIC8vIHRoZSB2aXNpYmxlIGNvbW1lbnQgbGV0cyBvcGVyYXRvcnMganVtcCBkaXJlY3RseSB0byB0aGUgcmlnaHQgbWFjaGluZVxuICAvLyB3aGVuIHRoZXkgbmVlZCB0byBpbnNwZWN0IGxvZ3MgYWZ0ZXIgYSBmYWlsdXJlIChJc3N1ZSAjMjAzNCkuXG4gIGNvbnN0IGNsYWltaW5nSG9zdCA9IChob3N0bmFtZSAmJiBob3N0bmFtZS5sZW5ndGggPiAwKVxuICAgID8gaG9zdG5hbWVcbiAgICA6IGdldEhvc3RuYW1lKCk7XG5cbiAgLy8gQnVpbGQgdGhlIGNsYWltIGNvbW1lbnQgYm9keS4gV2hlbiBtYXJrZXJPcHRpb25zIGlzIHByb3ZpZGVkLCBlbWJlZCBhblxuICAvLyBpbml0aWFsIGhlYXJ0YmVhdCBtYXJrZXIgc28gdGhlIGNsYWltIGFuZCBoZWFydGJlYXQgbGl2ZSBpbiB0aGUgc2FtZVxuICAvLyBjb21tZW50IChJc3N1ZSAjMTYyOCkuXG4gIGNvbnN0IGNsYWltUHJlZml4ID1cbiAgICBgJHtDTEFJTV9NQVJLRVJfUFJFRklYfSR7d29ya2VySWR9IC0tPlxcbkNsYWltZWQgYnkgXFxgJHt3b3JrZXJJZH1cXGAgb24gaG9zdCBcXGAke2NsYWltaW5nSG9zdH1cXGBgO1xuICBjb25zdCBpbml0aWFsRXBvY2ggPSBtYXJrZXJPcHRpb25zPy5ub3dGblxuICAgID8gbWFya2VyT3B0aW9ucy5ub3dGbigpXG4gICAgOiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKTtcbiAgY29uc3QgY2xhaW1Db21tZW50Qm9keSA9XG4gICAgKG1hcmtlck9wdGlvbnNcbiAgICAgID8gYCR7Y2xhaW1QcmVmaXh9XFxuJHtcbiAgICAgICAgZm9ybWF0SGVhcnRiZWF0TWFya2VyKG1hcmtlck9wdGlvbnMubWFjaGluZUlkLCBpbml0aWFsRXBvY2gpXG4gICAgICB9YFxuICAgICAgOiBjbGFpbVByZWZpeCkgK1xuICAgIChvcHRpb25zLmNvbXBsZXRpb25BZG1pc3Npb24gPyBgXFxuJHtDT01QTEVUSU9OX1BFTkRJTkdfTUFSS0VSfWAgOiBcIlwiKTtcblxuICAvLyBBdXRob3JzIHdob3NlIENMQUlNX0xPQ0sgbWFya2VycyB0aGlzIHdvcmtlciB0cnVzdHMgKElzc3VlICMzNjY0KS5cbiAgLy8gRXZlcnkgbWFya2VyLWRyaXZlbiBkZWNpc2lvbiBiZWxvdyDigJQgdGhlIHByZS1jbGFpbSBjaGVjaywgdGhlIHN0YWxlXG4gIC8vIGNsZWFudXAgYW5kIHRoZSBTdGVwLTUgcmFjZSByZXNvbHV0aW9uIOKAlCBpcyBnYXRlZCBvbiB0aGlzIHNldCwgYmVjYXVzZVxuICAvLyBhIG1hcmtlciBpbiBhIGNvbW1lbnQgYm9keSBpcyBub3QgYW4gYXV0aGVudGljYXRlZCBjaGFubmVsLlxuICBjb25zdCB0cnVzdGVkQ2xhaW1BdXRob3JzID0gcmVzb2x2ZVRydXN0ZWRDbGFpbUF1dGhvcnMoXG4gICAgZ2l0aHViVXNlcixcbiAgICBmbGVldEF1dGhvcnMsXG4gICk7XG5cbiAgLy8gUHJlLWNsYWltIGZyZXNobmVzcyByZS1jaGVjayAoSXNzdWUgIzEwODYpOiBSZS1mZXRjaCBhc3NpZ25lZXMgYW5kXG4gIC8vIHJlY2VudCBjbGFpbSBjb21tZW50cyB0byBuYXJyb3cgdGhlIHJhY2Ugd2luZG93IGJldHdlZW4gc2NhbiBhbmQgY2xhaW0uXG4gIGNvbnN0IGZyZXNobmVzc0NoZWNrID0gYXdhaXQgcHJlQ2xhaW1GcmVzaG5lc3NDaGVjayhcbiAgICByZXBvLFxuICAgIGlzc3VlTnVtYmVyLFxuICAgIGdoQ29tbWFuZEZuLFxuICAgIHRydXN0ZWRDbGFpbUF1dGhvcnMsXG4gICAgTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCksXG4gICAgLy8gSXNzdWUgIzIzMzQ6IHRoZSBtaWxlc3RvbmUgc3RyZWFtIGxvY2ssIG9ubHkgZm9yIGEgcnVuIHRoYXQgam9pbnMgYVxuICAgIC8vIHN0cmVhbS4gT21pdHRlZCBoZXJlIG1lYW5zIHRoZSBjaGVjayDigJQgYW5kIGl0cyBgZ2ggaXNzdWUgbGlzdGAg4oCUIG5ldmVyXG4gICAgLy8gaGFwcGVucy5cbiAgICAvL1xuICAgIC8vIElzc3VlICMyMzM2OiB0aGUgc2FtZSBmbGFnIGNhcnJpZXMgdGhpcyBob3N0J3MgaWRlbnRpdHkgZm9yIHRoZSBhZmZpbml0eVxuICAgIC8vIGhlYWQgc3RhcnQuIFRoZSBtYWNoaW5lIGlkIGlzIHByZWZlcnJlZCBiZWNhdXNlIHRoYXQgaXMgd2hhdCB0aGUgaG9sZGVyXG4gICAgLy8gbWFya2VyIHJlY29yZHM7IHRoZSBjbGFpbWluZyBob3N0J3MgbmFtZSBpcyB0aGUgZmFsbGJhY2ssIGFuZCB0aGUgdHdvXG4gICAgLy8gY29tcGFyZSBlcXVhbCBiZWNhdXNlIGFmZmluaXR5IG1hdGNoZXMgb24gdGhlIGhvc3QgcGFydCBhbG9uZS5cbiAgICAvLyBJc3N1ZSAjMjUzMDogYHNoYXJlYWJsZWAgdHVybnMgdGhlIHN0cmVhbS1idXN5IHNraXAgaW50byBhIHNlY29uZFxuICAgIC8vIGhvbGRlciBvbiBhIHBlci1pc3N1ZSBjb252ZXJzYXRpb24sIGZvciB0aGUgdGllcnMgYSBodW1hbiB3YW50cyBub3cuXG4gICAgc3RyZWFtTG9ja0VuYWJsZWRcbiAgICAgID8ge1xuICAgICAgICBhZmZpbml0eUhvc3Q6IG1hcmtlck9wdGlvbnM/Lm1hY2hpbmVJZCA/PyBjbGFpbWluZ0hvc3QsXG4gICAgICAgIHNoYXJlYWJsZTogc3RyZWFtU2hhcmVhYmxlLFxuICAgICAgICAuLi4obWlsZXN0b25lVGl0bGUgPyB7IG1pbGVzdG9uZVRpdGxlIH0gOiB7fSksXG4gICAgICAgIC4uLihtYXJrZXJPcHRpb25zPy53b3JrRGlyID8geyB3b3JrRGlyOiBtYXJrZXJPcHRpb25zLndvcmtEaXIgfSA6IHt9KSxcbiAgICAgIH1cbiAgICAgIDogdW5kZWZpbmVkLFxuICApO1xuICBpZiAoZnJlc2huZXNzQ2hlY2suc2hvdWxkQmFpbE91dCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIGNsYWltZWQ6IGZhbHNlLFxuICAgICAgICByZWFzb246IGZyZXNobmVzc0NoZWNrLnJlYXNvbixcbiAgICAgICAgLi4uKGZyZXNobmVzc0NoZWNrLnJlYXNvbkRldGFpbFxuICAgICAgICAgID8geyByZWFzb25EZXRhaWw6IGZyZXNobmVzc0NoZWNrLnJlYXNvbkRldGFpbCB9XG4gICAgICAgICAgOiB7fSksXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICAvLyBTdGVwIDA6IFZlcmlmeSB0aGUgaXNzdWUgaXMgc3RpbGwgb3BlbiBiZWZvcmUgYXR0ZW1wdGluZyB0byBjbGFpbS5cbiAgLy8gQSBtZXJnZWQgUFIgb24gYW5vdGhlciBtYWNoaW5lIG1heSBoYXZlIGF1dG8tY2xvc2VkIHRoZSBpc3N1ZSBzaW5jZVxuICAvLyB0aGlzIHdvcmtlciBkaXNjb3ZlcmVkIGl0IChyYWNlIGNvbmRpdGlvbiB3aXRoIG11bHRpLW1hY2hpbmUgd29ya2VycykuXG4gIGNvbnN0IGlzc3VlU3RhdGUgPSBhd2FpdCBmZXRjaElzc3VlU3RhdGUocmVwbywgaXNzdWVOdW1iZXIsIGdoQ29tbWFuZEZuLCB7XG4gICAgc2xlZXBGbixcbiAgfSk7XG4gIGlmIChpc3N1ZVN0YXRlICE9PSBcIk9QRU5cIikge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBjbGFpbWVkOiBmYWxzZSwgcmVhc29uOiBcImFscmVhZHlfY2xvc2VkXCIgfSB9O1xuICB9XG5cbiAgLy8gU3RlcCAxOiBSZW1vdmUgYW55IHN0YWxlIGNsYWltIGNvbW1lbnRzIGZyb20gcHJldmlvdXMgcnVucyAoSXNzdWUgIzYwNClcbiAgYXdhaXQgY2xlYW51cFN0YWxlQ2xhaW1Db21tZW50cyhcbiAgICByZXBvLFxuICAgIGlzc3VlTnVtYmVyLFxuICAgIGdoQ29tbWFuZEZuLFxuICAgIHRydXN0ZWRDbGFpbUF1dGhvcnMsXG4gICk7XG5cbiAgLy8gU3RlcCAyOiBBc3NpZ24gdGhlIHdvcmtlciB0byB0aGUgaXNzdWUgaW1tZWRpYXRlbHkuXG4gIC8vXG4gIC8vIElzc3VlICMyMzI1OiBUaGUgcHJldmlvdXMgaW1wbGVtZW50YXRpb24gc3dhbGxvd2VkIHRoZSBnaCBlcnJvciBpbiBhXG4gIC8vIGJhcmUgYGNhdGNoIHt9YCwgd2hpY2ggdHVybmVkIFwidGhlIHdvcmtlciBpcyBub3QgYSBjb2xsYWJvcmF0b3Igb25cbiAgLy8gdGhpcyByZXBvXCIgKGEgcGVybWFuZW50IDQyMikgaW50byB0aGUgbWlzbGVhZGluZyBtZXNzYWdlIFwiYWxyZWFkeVxuICAvLyBhc3NpZ25lZCBvciBjbG9zZWRcIiDigJQgY2F1c2luZyB0aGUgbWFpbiBsb29wIHRvIHJlLXNjYW4gYW5kIHJlLWF0dGVtcHRcbiAgLy8gdGhlIHNhbWUgaXNzdWUgZXZlcnkgaXRlcmF0aW9uIGluIHNpbGVuY2UuIE5vdyB3ZSBjYXB0dXJlIHRoZSBlcnJvcixcbiAgLy8gY2xhc3NpZnkgaXQsIGxvZyBpdCBhdCBXQVJOLCBhbmQgc3VyZmFjZSB0aGUgcmVhc29uIHRvIHRoZSBjYWxsZXIuXG4gIHRyeSB7XG4gICAgYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJpc3N1ZVwiLFxuICAgICAgXCJlZGl0XCIsXG4gICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tYWRkLWFzc2lnbmVlXCIsXG4gICAgICBnaXRodWJVc2VyLFxuICAgIF0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGNvbnN0IHJlYXNvbiA9IGNsYXNzaWZ5R2hBc3NpZ25FcnJvcihtZXNzYWdlKTtcbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW2NsYWltX2lzc3VlXSBhc3NpZ25fZmFpbGVkIHJlcG89JHtyZXBvfSBpc3N1ZT0jJHtpc3N1ZU51bWJlcn0gYCArXG4gICAgICAgIGB1c2VyPSR7Z2l0aHViVXNlcn0gcmVhc29uPSR7cmVhc29ufSBlcnJvcj0ke21lc3NhZ2V9YCxcbiAgICApO1xuICAgIC8vIE5vIGFzc2lnbm1lbnQgaGFwcGVuZWQsIGFuZCB3ZSBoYXZlIG5vdCBwb3N0ZWQgYSBjbGFpbSBjb21tZW50IHlldCxcbiAgICAvLyBzbyB0aGVyZSBpcyBub3RoaW5nIHRvIGNsZWFuIHVwLlxuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7IGNsYWltZWQ6IGZhbHNlLCByZWFzb24sIHJlYXNvbkRldGFpbDogbWVzc2FnZSB9LFxuICAgIH07XG4gIH1cblxuICAvLyBTdGVwIDM6IFBvc3QgYSBjbGFpbSBjb21tZW50IHdpdGggdW5pcXVlIHdvcmtlciBpZGVudGl0eSAoSXNzdWUgIzYwNCkuXG4gIC8vIFdoZW4gbWFya2VyT3B0aW9ucyBpcyBzZXQsIHRoZSBib2R5IGFsc28gY2FycmllcyBhbiBpbml0aWFsIGhlYXJ0YmVhdFxuICAvLyBtYXJrZXIgc28gY2xhaW0gYW5kIGhlYXJ0YmVhdCBzaGFyZSBvbmUgY29tbWVudCAoSXNzdWUgIzE2MjgpLlxuICB0cnkge1xuICAgIGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwiaXNzdWVcIixcbiAgICAgIFwiY29tbWVudFwiLFxuICAgICAgU3RyaW5nKGlzc3VlTnVtYmVyKSxcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWJvZHlcIixcbiAgICAgIGNsYWltQ29tbWVudEJvZHksXG4gICAgXSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgY29uc29sZS53YXJuKFxuICAgICAgYFtjbGFpbV9pc3N1ZV0gY2xhaW1fY29tbWVudF9mYWlsZWQgcmVwbz0ke3JlcG99IGlzc3VlPSMke2lzc3VlTnVtYmVyfSBgICtcbiAgICAgICAgYHVzZXI9JHtnaXRodWJVc2VyfSBlcnJvcj0ke21lc3NhZ2V9YCxcbiAgICApO1xuICAgIC8vIEZhaWxlZCB0byBwb3N0IGNsYWltIGNvbW1lbnQg4oCUIGJhY2sgb2ZmXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgICAgXCJpc3N1ZVwiLFxuICAgICAgICBcImVkaXRcIixcbiAgICAgICAgU3RyaW5nKGlzc3VlTnVtYmVyKSxcbiAgICAgICAgXCItLXJlcG9cIixcbiAgICAgICAgcmVwbyxcbiAgICAgICAgXCItLXJlbW92ZS1hc3NpZ25lZVwiLFxuICAgICAgICBnaXRodWJVc2VyLFxuICAgICAgXSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBCZXN0LWVmZm9ydCB1bmFzc2lnblxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZToge1xuICAgICAgICBjbGFpbWVkOiBmYWxzZSxcbiAgICAgICAgcmVhc29uOiBcImNvbW1lbnRfZmFpbGVkXCIsXG4gICAgICAgIHJlYXNvbkRldGFpbDogbWVzc2FnZSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8vIFN0ZXAgNDogQnJpZWYgcGF1c2UgZm9yIEdpdEh1YidzIGV2ZW50dWFsIGNvbnNpc3RlbmN5IHRvIHNldHRsZVxuICBhd2FpdCBzbGVlcEZuKDMwMDApO1xuXG4gIC8vIFN0ZXAgNTogUmUtcmVhZCBjb21tZW50cyB0byBjaGVjayBmb3IgY29tcGV0aW5nIGNsYWltcyAoSXNzdWUgIzYwNClcbiAgbGV0IGFsbENsYWltQ29tbWVudHM6IENsYWltQ29tbWVudFtdO1xuICB0cnkge1xuICAgIGNvbnN0IGNvbW1lbnRzSnNvbiA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwiYXBpXCIsXG4gICAgICBgcmVwb3MvJHtyZXBvfS9pc3N1ZXMvJHtpc3N1ZU51bWJlcn0vY29tbWVudHNgLFxuICAgICAgXCItLWpxXCIsXG4gICAgICBgWy5bXSB8IHNlbGVjdCguYm9keSB8IHRlc3QoXCIke0NMQUlNX01BUktFUl9QUkVGSVh9XCIpKSB8IHtpZDogLmlkLCBib2R5OiAuYm9keSwgY3JlYXRlZF9hdDogLmNyZWF0ZWRfYXQsIGF1dGhvcjogLnVzZXIubG9naW59XWAsXG4gICAgXSk7XG4gICAgLy8gSXNzdWUgIzM2NjQ6IGEgQ0xBSU1fTE9DSyBtYXJrZXIgZnJvbSBvdXRzaWRlIHRoZSBmbGVldCBpcyBmb3JnZWQg4oCUXG4gICAgLy8gZGlzY2FyZCBpdCBiZWZvcmUgdGhlIGVhcmxpZXN0LXdpbnMgY29tcGFyaXNvbiBzbyBhbiBvdXRzaWRlciBjYW5ub3RcbiAgICAvLyBtYWtlIHRoaXMgd29ya2VyIGFiYW5kb24gdGhlIGlzc3VlIGl0IGhhcyBqdXN0IGNsYWltZWQuXG4gICAgYWxsQ2xhaW1Db21tZW50cyA9IGZpbHRlckZsZWV0Q2xhaW1Db21tZW50cyhcbiAgICAgIHBhcnNlQ2xhaW1Db21tZW50cyhjb21tZW50c0pzb24pLFxuICAgICAgdHJ1c3RlZENsYWltQXV0aG9ycyxcbiAgICAgIHJlcG8sXG4gICAgICBpc3N1ZU51bWJlcixcbiAgICApO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGNvbnNvbGUud2FybihcbiAgICAgIGBbY2xhaW1faXNzdWVdIHZlcmlmaWNhdGlvbl9mYWlsZWQgcmVwbz0ke3JlcG99IGlzc3VlPSMke2lzc3VlTnVtYmVyfSBgICtcbiAgICAgICAgYHVzZXI9JHtnaXRodWJVc2VyfSBlcnJvcj0ke21lc3NhZ2V9YCxcbiAgICApO1xuICAgIC8vIEZhaWxlZCB0byByZWFkIGNvbW1lbnRzIOKAlCBiYWNrIG9mZlxuICAgIGF3YWl0IHJlbW92ZU93bkNsYWltQ29tbWVudChyZXBvLCBpc3N1ZU51bWJlciwgd29ya2VySWQsIGdoQ29tbWFuZEZuKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgICBcImlzc3VlXCIsXG4gICAgICAgIFwiZWRpdFwiLFxuICAgICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgICBcIi0tcmVwb1wiLFxuICAgICAgICByZXBvLFxuICAgICAgICBcIi0tcmVtb3ZlLWFzc2lnbmVlXCIsXG4gICAgICAgIGdpdGh1YlVzZXIsXG4gICAgICBdKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEJlc3QtZWZmb3J0XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIGNsYWltZWQ6IGZhbHNlLFxuICAgICAgICByZWFzb246IFwidmVyaWZpY2F0aW9uX2ZhaWxlZFwiLFxuICAgICAgICByZWFzb25EZXRhaWw6IG1lc3NhZ2UsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICAvLyBDb21tb24gZmluYWxpc2F0aW9uIGZvciBhIHdvbiBjbGFpbTogcnVuIHRoZSBsaXZlIGZsZWV0LVBSIHJlLWNoZWNrXG4gIC8vIChJc3N1ZSAjMzE1MCkgdGhlbiBlaXRoZXIgYWJvcnQgKGZsZWV0IFBSIGV4aXN0cykgb3Igc2VlZCB0aGUgbWFya2VyXG4gIC8vIHN0YXRlIGFuZCByZXR1cm4gc3VjY2Vzcy5cbiAgY29uc3QgZmluYWxpc2UgPSBhc3luYyAoY29tcGV0aW5nV29ya2VyQ291bnQ6IG51bWJlcikgPT4ge1xuICAgIGNvbnN0IHdvbiA9IGF3YWl0IGZpbmFsaXNlV29uQ2xhaW0oe1xuICAgICAgcmVwbyxcbiAgICAgIGlzc3VlTnVtYmVyLFxuICAgICAgZ2l0aHViVXNlcixcbiAgICAgIHdvcmtlcklkLFxuICAgICAgY29tcGV0aW5nV29ya2VyQ291bnQsXG4gICAgICBmbGVldEF1dGhvcnMsXG4gICAgICBwdXNoQ2FwYWJsZUF1dGhvcnMsXG4gICAgICBtaWxlc3RvbmVUaXRsZSxcbiAgICAgIGZsZWV0UHJTbG90cyxcbiAgICAgIGNvbXBsZXRpb25BZG1pc3Npb246IG9wdGlvbnMuY29tcGxldGlvbkFkbWlzc2lvbixcbiAgICAgIHNsZWVwRm4sXG4gICAgICBjYWNoZSxcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgYWxsQ2xhaW1Db21tZW50cyxcbiAgICAgIGNsYWltUHJlZml4LFxuICAgICAgaW5pdGlhbEVwb2NoLFxuICAgICAgbWFya2VyT3B0aW9ucyxcbiAgICB9KTtcbiAgICAvLyBJc3N1ZSAjMjUzMDogYSBjbGFpbSB0aGF0IHNoYXJlZCBhIGJ1c3kgc3RyZWFtIHNheXMgc28sIHNvIHRoZSBjYWxsZXJcbiAgICAvLyBrZWVwcyB0aGlzIHJ1biBvbiBpdHMgb3duIGNvbnZlcnNhdGlvbi5cbiAgICBpZiAod29uLm9rICYmIHdvbi52YWx1ZS5jbGFpbWVkICYmIGZyZXNobmVzc0NoZWNrLnN0cmVhbVNoYXJlZCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUgYXMgY29uc3QsXG4gICAgICAgIHZhbHVlOiB7IC4uLndvbi52YWx1ZSwgc3RyZWFtU2hhcmVkOiBmcmVzaG5lc3NDaGVjay5zdHJlYW1TaGFyZWQgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB3b247XG4gIH07XG5cbiAgLy8gU3RlcCA2OiBWZXJpZnkgZXhjbHVzaXZlIGNsYWltIChJc3N1ZSAjMTA5MDogbG9nIHJhY2Ugb3V0Y29tZXMpXG4gIGlmIChhbGxDbGFpbUNvbW1lbnRzLmxlbmd0aCA8PSAxKSB7XG4gICAgcmV0dXJuIGF3YWl0IGZpbmFsaXNlKDApO1xuICB9XG5cbiAgLy8gTXVsdGlwbGUgY2xhaW1zIGRldGVjdGVkIOKAlCBlYXJsaWVzdCBjb21tZW50IHdpbnMgKElzc3VlICM2MDQpXG4gIGNvbnN0IGNvbXBldGluZ1dvcmtlckNvdW50ID0gYWxsQ2xhaW1Db21tZW50cy5sZW5ndGggLSAxO1xuICBjb25zdCBzb3J0ZWQgPSBbLi4uYWxsQ2xhaW1Db21tZW50c10uc29ydCgoYSwgYikgPT5cbiAgICBhLmNyZWF0ZWRBdC5sb2NhbGVDb21wYXJlKGIuY3JlYXRlZEF0KVxuICApO1xuICBjb25zdCBlYXJsaWVzdCA9IHNvcnRlZFswXTtcbiAgY29uc3Qgd2lubmVySWQgPSBlYXJsaWVzdCAhPT0gdW5kZWZpbmVkXG4gICAgPyBleHRyYWN0V29ya2VySWRGcm9tQ29tbWVudChlYXJsaWVzdC5ib2R5KVxuICAgIDogdW5kZWZpbmVkO1xuXG4gIGlmICh3aW5uZXJJZCA9PT0gd29ya2VySWQpIHtcbiAgICBjb25zb2xlLmVycm9yKFxuICAgICAgYFtjbGFpbV9pc3N1ZV0gcmVwbz0ke3JlcG99IGlzc3VlPSMke2lzc3VlTnVtYmVyfSBjbGFpbV9yYWNlPXdvbiBjb21wZXRpbmdfd29ya2Vycz0ke2NvbXBldGluZ1dvcmtlckNvdW50fSB3b3JrZXI9JHt3b3JrZXJJZH1gLFxuICAgICk7XG4gICAgcmV0dXJuIGF3YWl0IGZpbmFsaXNlKGNvbXBldGluZ1dvcmtlckNvdW50KTtcbiAgfVxuXG4gIC8vIExvc3Qg4oCUIGxvZyBhbmQgY2xlYW4gdXBcbiAgaW5jcmVtZW50Q291bnRlcihcImNsYWltQ29uZmxpY3RzXCIpO1xuICBjb25zb2xlLmVycm9yKFxuICAgIGBbY2xhaW1faXNzdWVdIHJlcG89JHtyZXBvfSBpc3N1ZT0jJHtpc3N1ZU51bWJlcn0gY2xhaW1fcmFjZT1sb3N0IGNvbXBldGluZ193b3JrZXJzPSR7Y29tcGV0aW5nV29ya2VyQ291bnR9IHdvcmtlcj0ke3dvcmtlcklkfSB3aW5uZXI9JHt3aW5uZXJJZH1gLFxuICApO1xuICBhd2FpdCByZW1vdmVPd25DbGFpbUNvbW1lbnQocmVwbywgaXNzdWVOdW1iZXIsIHdvcmtlcklkLCBnaENvbW1hbmRGbik7XG4gIHRyeSB7XG4gICAgYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJpc3N1ZVwiLFxuICAgICAgXCJlZGl0XCIsXG4gICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tcmVtb3ZlLWFzc2lnbmVlXCIsXG4gICAgICBnaXRodWJVc2VyLFxuICAgIF0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBCZXN0LWVmZm9ydFxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICB2YWx1ZToge1xuICAgICAgY2xhaW1lZDogZmFsc2UsXG4gICAgICB3aW5uZXJJZCxcbiAgICAgIGNvbXBldGluZ1dvcmtlckNvdW50LFxuICAgICAgcmVhc29uOiBcInJhY2VfbG9zdFwiLFxuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogRGV0ZWN0IGNsYWltL3JlbGVhc2UgY2h1cm4gYW5kIGNvb2wgZG93biBpZiB0aGUgdGhyZXNob2xkIGlzIG1ldC5cbiAqXG4gKiBDb3VudHMgdGhlIG51bWJlciBvZiB0aW1lcyBhbiBpc3N1ZSBoYXMgYmVlbiB1bmFzc2lnbmVkIGJ5IHRoZSBzcGVjaWZpZWRcbiAqIHVzZXIgKGluZGljYXRpbmcgYSBjbGFpbS10aGVuLXJlbGVhc2UgY3ljbGUpLiBJZiB0aGUgY291bnQgbWVldHMgb3JcbiAqIGV4Y2VlZHMgdGhlIHRocmVzaG9sZCwgdGhlIGlzc3VlIGlzIHJlbGVhc2VkIHdpdGggYSBjaHVybiByZWNvcmQgYW5kIGFcbiAqIGNvb2xkb3duIHNpZ25hbC4gSXQgaXMgbmV2ZXIgcGFya2VkIChJc3N1ZSAjNDE1OCk6IG5vIGBmYWlsZWRgIGxhYmVsIGFuZFxuICogbm8gcmVxdWVzdCBmb3IgYSBodW1hbiB0byBhZGQgYHBsYW5uaW5nYC5cbiAqXG4gKiBJc3N1ZSAjODYxOiBEZXRlY3QgaXNzdWVzIHRoYXQgYXJlIHRvbyBjb21wbGV4IGZvciBkaXJlY3QgaW1wbGVtZW50YXRpb24uXG4gKiBJc3N1ZSAjODY5OiBPbmx5IGNvdW50IHVuYXNzaWdubWVudCBldmVudHMgZm9yIHRoZSB3b3JrZXIgdXNlci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrQ2xhaW1DaHVybihcbiAgb3B0aW9uczogQ2xhaW1DaHVybk9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDxDbGFpbUNodXJuUmVzdWx0Pj4ge1xuICBjb25zdCB7XG4gICAgcmVwbyxcbiAgICBpc3N1ZU51bWJlcixcbiAgICBnaXRodWJVc2VyLFxuICAgIHRocmVzaG9sZCA9IDMsXG4gICAgZ2hDb21tYW5kRm4gPSBydW5HaENvbW1hbmQsXG4gIH0gPSBvcHRpb25zO1xuXG4gIC8vIFF1ZXJ5IGlzc3VlIGV2ZW50cyB0aW1lbGluZSBhbmQgY291bnQgXCJ1bmFzc2lnbmVkXCIgZXZlbnRzXG4gIGxldCBldmVudHNKc29uOiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgZXZlbnRzSnNvbiA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwiYXBpXCIsXG4gICAgICBgcmVwb3MvJHtyZXBvfS9pc3N1ZXMvJHtpc3N1ZU51bWJlcn0vZXZlbnRzYCxcbiAgICAgIFwiLS1qcVwiLFxuICAgICAgYFsuW10gfCBzZWxlY3QoLmV2ZW50ID09IFwidW5hc3NpZ25lZFwiKV1gLFxuICAgIF0pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgY2h1cm5Db3VudDogMCwgZXNjYWxhdGVkOiBmYWxzZSB9IH07XG4gIH1cblxuICAvLyBJc3N1ZSAjODY5OiBGaWx0ZXIgdG8gb25seSBjb3VudCB1bmFzc2lnbm1lbnRzIG9mIHRoZSB3b3JrZXIgdXNlci5cbiAgLy8gVGltZSB3aW5kb3c6IGV2ZW50cyBvbGRlciB0aGFuIDEwIG1pbnV0ZXMgYnV0IHdpdGhpbiAyNCBob3Vycy5cbiAgLy8gVGhlIDEwLW1pbnV0ZSBleGNsdXNpb24gcHJldmVudHMgc2VsZi1yZWluZm9yY2luZyBsb29wcyB3aGVyZSBjaHVyblxuICAvLyBkZXRlY3Rpb24gdW5hc3NpZ25zIHRoZSB3b3JrZXIsIGNyZWF0aW5nIGEgbmV3IGV2ZW50IHRoYXQgdHJpZ2dlcnNcbiAgLy8gY2h1cm4gZGV0ZWN0aW9uIGFnYWluIG9uIHRoZSBuZXh0IGF0dGVtcHQuXG4gIC8vIERlYm91bmNlOiBvbmx5IGNvdW50IGV2ZW50cyAzMCsgbWludXRlcyBhcGFydCDigJQgZ2VudWluZSBjaHVybiBoYXNcbiAgLy8gZ2FwcyBiZXR3ZWVuIGF0dGVtcHRzLCByYXBpZC1maXJlIGNsYWltL3VuY2xhaW0gbG9vcHMgZG8gbm90LlxuICBsZXQgY2h1cm5Db3VudDogbnVtYmVyO1xuICB0cnkge1xuICAgIGNvbnN0IGV2ZW50czogdW5rbm93biA9IEpTT04ucGFyc2UoZXZlbnRzSnNvbik7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGV2ZW50cykpIHtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBjaHVybkNvdW50OiAwLCBlc2NhbGF0ZWQ6IGZhbHNlIH0gfTtcbiAgICB9XG4gICAgLy8gT25seSBsb29rIGF0IGV2ZW50cyBmcm9tIHRoZSBjdXJyZW50IHNlc3Npb24gKH4xIGhvdXIpLiBFdmVudHMgZnJvbVxuICAgIC8vIHByZXZpb3VzIHNlc3Npb25zIGFyZSBoaXN0b3JpY2FsIOKAlCBhIG5ldyBzZXNzaW9uIG1lYW5zIGZyZXNoIGNvZGVcbiAgICAvLyB0aGF0IG1heSBoYXZlIGZpeGVkIHRoZSB1bmRlcmx5aW5nIGlzc3VlLiBUaGlzIHByZXZlbnRzIGluZnJhc3RydWN0dXJlXG4gICAgLy8gZmFpbHVyZXMgZnJvbSBvbmUgc2Vzc2lvbiBibG9ja2luZyByZXRyaWVzIGluIHRoZSBuZXh0LlxuICAgIGNvbnN0IHdpbmRvd1N0YXJ0ID0gbmV3IERhdGUoRGF0ZS5ub3coKSAtIDEgKiA2MCAqIDYwICogMTAwMCkudG9JU09TdHJpbmcoKTtcbiAgICBjb25zdCB3aW5kb3dFbmQgPSBuZXcgRGF0ZShEYXRlLm5vdygpIC0gMTAgKiA2MCAqIDEwMDApLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgREVCT1VOQ0VfTVMgPSAxMCAqIDYwICogMTAwMDsgLy8gMTAgbWludXRlc1xuICAgIGNvbnN0IHJlY2VudEV2ZW50cyA9IChldmVudHMgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KVxuICAgICAgLmZpbHRlcigoZSkgPT4ge1xuICAgICAgICBjb25zdCBhc3NpZ25lZSA9IGUuYXNzaWduZWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChhc3NpZ25lZT8ubG9naW4gIT09IGdpdGh1YlVzZXIpIHJldHVybiBmYWxzZTtcbiAgICAgICAgY29uc3QgY3JlYXRlZEF0ID0gU3RyaW5nKGUuY3JlYXRlZF9hdCA/PyBcIlwiKTtcbiAgICAgICAgcmV0dXJuIGNyZWF0ZWRBdCA+PSB3aW5kb3dTdGFydCAmJiBjcmVhdGVkQXQgPD0gd2luZG93RW5kO1xuICAgICAgfSlcbiAgICAgIC5tYXAoKGUpID0+IG5ldyBEYXRlKFN0cmluZyhlLmNyZWF0ZWRfYXQgPz8gXCJcIikpLmdldFRpbWUoKSlcbiAgICAgIC5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG5cbiAgICAvLyBDb3VudCBvbmx5IGV2ZW50cyB0aGF0IGFyZSBhdCBsZWFzdCAzMCBtaW51dGVzIGFwYXJ0IGZyb20gdGhlIHByZXZpb3VzXG4gICAgY2h1cm5Db3VudCA9IDA7XG4gICAgbGV0IGxhc3RDb3VudGVkID0gMDtcbiAgICBmb3IgKGNvbnN0IHRzIG9mIHJlY2VudEV2ZW50cykge1xuICAgICAgaWYgKHRzIC0gbGFzdENvdW50ZWQgPj0gREVCT1VOQ0VfTVMpIHtcbiAgICAgICAgY2h1cm5Db3VudCsrO1xuICAgICAgICBsYXN0Q291bnRlZCA9IHRzO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGNodXJuQ291bnQ6IDAsIGVzY2FsYXRlZDogZmFsc2UgfSB9O1xuICB9XG5cbiAgaWYgKGNodXJuQ291bnQgPCB0aHJlc2hvbGQpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgY2h1cm5Db3VudCwgZXNjYWxhdGVkOiBmYWxzZSB9IH07XG4gIH1cblxuICAvLyBDaHVybiB0aHJlc2hvbGQgbWV0IOKAlCByZWNvcmQgaXQgYW5kIGNvb2wgZG93biAoSXNzdWUgIzg2MSkuIElzc3VlXG4gIC8vICM0MTU4OiBuZXZlciBgZmFpbGVkYCBhbmQgbmV2ZXIgYSByZXF1ZXN0IGZvciBhIGh1bWFuIHRvIGFkZFxuICAvLyBgcGxhbm5pbmdgIOKAlCB0aGUgaXNzdWUgaXMgdGhlIFZpYmUgQ29kZXIncyB0byBmaW5pc2gsIHNvIGl0IHN0YXlzXG4gIC8vIGNsYWltYWJsZSBvbmNlIHRoZSBjb29sZG93biBlbmRzLiBUaGUgcG9zdGVkIHRleHQgY2FycmllcyBubyBWaWJlQ29kZXJcbiAgLy8gaXNzdWUgbnVtYmVyIChJc3N1ZSAjNDY0MSk6IEdpdEh1YiB3b3VsZCByZXNvbHZlIGEgYmFyZSBgI05gIGluIHRoZSB0YXJnZXQgcmVwby5cbiAgY29uc3QgY2h1cm5Db21tZW50ID1cbiAgICBgIyMgQ2xhaW0gQ2h1cm4gRGV0ZWN0ZWRcXG5cXG5UaGlzIGlzc3VlIGhhcyBiZWVuIGNsYWltZWQgYW5kIHJlbGVhc2VkICR7Y2h1cm5Db3VudH0gdGltZXMgaW4gdGhlIGxhc3QgaG91ciAodGhyZXNob2xkOiAke3RocmVzaG9sZH0pLiBUaGUgd29ya2VyIGlzIHJlbGVhc2luZyBpdCBhbmQgY29vbGluZyBkb3duIGJlZm9yZSB0aGUgbmV4dCBhdHRlbXB0OyBpdCBzdGF5cyBxdWV1ZWQgYW5kIGlzIG5ldmVyIHBhcmtlZC5gO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJpc3N1ZVwiLFxuICAgICAgXCJjb21tZW50XCIsXG4gICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tYm9keVwiLFxuICAgICAgY2h1cm5Db21tZW50LFxuICAgIF0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBCZXN0LWVmZm9ydFxuICB9XG5cbiAgLy8gVW5hc3NpZ24gdGhlIHdvcmtlclxuICB0cnkge1xuICAgIGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwiaXNzdWVcIixcbiAgICAgIFwiZWRpdFwiLFxuICAgICAgU3RyaW5nKGlzc3VlTnVtYmVyKSxcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLXJlbW92ZS1hc3NpZ25lZVwiLFxuICAgICAgZ2l0aHViVXNlcixcbiAgICBdKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gQmVzdC1lZmZvcnRcbiAgfVxuXG4gIC8vIElzc3VlICMxMDg3OiBQb3N0IGNyb3NzLXdvcmtlciBjb29sZG93biBzaWduYWwgc28gb3RoZXIgd29ya2VycyBza2lwIHRoaXMgaXNzdWVcbiAgYXdhaXQgcG9zdENvb2xkb3duQ29tbWVudChyZXBvLCBpc3N1ZU51bWJlciwgZ2l0aHViVXNlciwgZ2hDb21tYW5kRm4pO1xuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBjaHVybkNvdW50LCBlc2NhbGF0ZWQ6IHRydWUgfSB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHJlbGVhc2VDbGFpbVdpdGhDb29sZG93blxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBPcHRpb25zIGZvciByZWxlYXNpbmcgYSBjbGFpbSB3aXRoIGEgY29vbGRvd24gc2lnbmFsLiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZWxlYXNlQ2xhaW1PcHRpb25zIHtcbiAgcmVwbzogc3RyaW5nO1xuICBpc3N1ZU51bWJlcjogbnVtYmVyO1xuICBnaXRodWJVc2VyOiBzdHJpbmc7XG4gIHdvcmtlcklkOiBzdHJpbmc7XG4gIC8qKiBJbmplY3RlZCBnaCBjb21tYW5kIGZ1bmN0aW9uIChmb3IgdGVzdGluZykuIERlZmF1bHRzIHRvIHJ1bkdoQ29tbWFuZC4gKi9cbiAgZ2hDb21tYW5kRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcbn1cblxuLyoqXG4gKiBSZWxlYXNlIGFuIGlzc3VlIGNsYWltIGFuZCBwb3N0IGEgY3Jvc3Mtd29ya2VyIGNvb2xkb3duIHNpZ25hbC5cbiAqXG4gKiBDYWxsZWQgd2hlbiBhIHdvcmtlciBmYWlscyBvbiBhbiBpc3N1ZSBhbmQgbmVlZHMgdG8gdW5hc3NpZ24uIFBvc3RzIGFcbiAqIGhpZGRlbiBjb29sZG93biBjb21tZW50IHNvIG90aGVyIHdvcmtlcnMga25vdyB0byBza2lwIHRoZSBpc3N1ZSBmb3JcbiAqIHRoZSBjb29sZG93biBwZXJpb2QuXG4gKlxuICogSXNzdWUgIzEwODc6IFNoYXJlIGNvb2xkb3duIHN0YXRlIGFjcm9zcyB3b3JrZXJzIHZpYSBHaXRIdWIgaXNzdWUgY29tbWVudHMuXG4gKlxuICogQHJldHVybnMgUmVzdWx0IGluZGljYXRpbmcgc3VjY2VzcyBvciBmYWlsdXJlXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWxlYXNlQ2xhaW1XaXRoQ29vbGRvd24oXG4gIG9wdGlvbnM6IFJlbGVhc2VDbGFpbU9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICBjb25zdCB7XG4gICAgcmVwbyxcbiAgICBpc3N1ZU51bWJlcixcbiAgICBnaXRodWJVc2VyLFxuICAgIHdvcmtlcklkLFxuICAgIGdoQ29tbWFuZEZuID0gcnVuR2hDb21tYW5kLFxuICB9ID0gb3B0aW9ucztcblxuICAvLyBVbmFzc2lnbiB0aGUgd29ya2VyXG4gIHRyeSB7XG4gICAgYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJpc3N1ZVwiLFxuICAgICAgXCJlZGl0XCIsXG4gICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tcmVtb3ZlLWFzc2lnbmVlXCIsXG4gICAgICBnaXRodWJVc2VyLFxuICAgIF0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tY3JpdGljYWwg4oCUIGNvbnRpbnVlIHRvIHBvc3QgY29vbGRvd25cbiAgfVxuXG4gIC8vIFBvc3QgY3Jvc3Mtd29ya2VyIGNvb2xkb3duIHNpZ25hbCAoSXNzdWUgIzEwODcpXG4gIGNvbnN0IGNvb2xkb3duUmVzdWx0ID0gYXdhaXQgcG9zdENvb2xkb3duQ29tbWVudChcbiAgICByZXBvLFxuICAgIGlzc3VlTnVtYmVyLFxuICAgIHdvcmtlcklkLFxuICAgIGdoQ29tbWFuZEZuLFxuICApO1xuXG4gIGlmICghY29vbGRvd25SZXN1bHQub2spIHtcbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW2NsYWltX2lzc3VlXSBXYXJuaW5nOiBGYWlsZWQgdG8gcG9zdCBjb29sZG93biBzaWduYWwgZm9yIGlzc3VlICMke2lzc3VlTnVtYmVyfSBpbiAke3JlcG99IOKAlCBjb250aW51aW5nIChJc3N1ZSAjMTA4NylgLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBc0JDLEdBS0QsU0FBUyxjQUFjLFFBQVEsdUJBQXVCO0FBQ3RELFNBQVMsZ0JBQWdCLFFBQVEsZ0NBQWdDO0FBQ2pFLFNBQVMsYUFBYSxRQUFRLHFC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
// denoCacheMetadata=13564158744601724758,18296480336342979133