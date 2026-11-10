/**
 * GitHub client module for the Vibe Coder worker.
 *
 * Provides a TypeScript interface for interacting with GitHub
 * via the gh CLI tool, with retry resilience for transient failures.
 *
 * Issue #217 — Added retry logic, partial failure handling, and
 * improved error classification.
 */ import { validateGhCommentsJson, validateGhIssueJson } from "./validation.ts";
import { retryWithBackoff } from "./retry.ts";
import { isReservedLabel } from "./config_defaults.ts";
import { runGhOrThrow, setPrimaryQuotaExhaustionHook } from "./gh_spawn.ts";
import { probeGraphqlQuota } from "./graphql_quota_probe.ts";
import { isPrimaryQuotaLatched, isPrimaryRateLimitMessage, isQuotaExemptGhCall, latchPrimaryQuota, primaryQuotaSkipMessage } from "./primary_quota_latch.ts";
import { isSecondaryOnlyRateLimitMessage } from "./secondary_rate_limit.ts";
import { formatRateLimitReset, writeRateLimitSignal } from "./rate_limit_signal.ts";
import { getCachedComments, invalidateComments } from "./comment_cache.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { formatImprovementAsIssueBody } from "../commands/suggest_improvements.ts";
import { defaultLogger } from "./logger.ts";
/**
 * Parse gh CLI issue JSON into a GitHubIssue object.
 *
 * @param json - Raw JSON from gh CLI
 * @returns Parsed GitHubIssue
 */ export function parseGhIssueJson(json) {
  return {
    number: json.number,
    title: json.title,
    body: json.body ?? "",
    labels: json.labels.map((l)=>l.name),
    author: json.author.login,
    assignees: json.assignees.map((a)=>a.login),
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
    ...json.state ? {
      state: json.state
    } : {}
  };
}
/**
 * Read the issue number out of a comment REST payload's `issue_url`
 * (Issue #1879).
 *
 * `PATCH /repos/{owner}/{repo}/issues/comments/{id}` is addressed by comment
 * id alone, so the caller never has to know which issue the comment belongs
 * to — but the per-iteration comment cache is keyed by issue, and a stale
 * entry would hand the next reader the body before the edit. The response
 * names the issue, so the invalidation costs no extra call.
 *
 * @param raw - Raw JSON string from the gh REST call.
 * @returns The issue number, or `undefined` when the payload does not name
 *   one — the cache is then simply left alone.
 */ export function parseCommentIssueNumber(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch  {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const issueUrl = parsed.issue_url;
  if (typeof issueUrl !== "string") return undefined;
  const match = issueUrl.match(/\/issues\/(\d+)$/);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
/**
 * Parse the JSON returned by `POST /repos/{owner}/{repo}/issues/{n}/comments`
 * into a `GitHubComment`. The REST API returns a single comment object with
 * `id`, `body`, `user.login`, `created_at`, and (optionally) `reactions`.
 *
 * Issue #1843: returned by `postComment` so callers can append the freshly
 * created comment to an in-memory list instead of refetching.
 *
 * @param raw - Raw JSON string from the gh REST POST
 * @returns Parsed GitHubComment, or undefined if the JSON is unrecognised
 */ export function parseCreatedCommentJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch  {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed;
  const id = typeof obj.id === "number" ? obj.id : undefined;
  const body = typeof obj.body === "string" ? obj.body : undefined;
  const createdAt = typeof obj.created_at === "string" ? obj.created_at : undefined;
  const user = obj.user;
  const author = typeof user === "object" && user !== null && typeof user.login === "string" ? user.login : undefined;
  if (id === undefined || body === undefined || author === undefined || createdAt === undefined) {
    return undefined;
  }
  const reactions = typeof obj.reactions === "object" && obj.reactions !== null ? obj.reactions : {};
  return {
    id,
    body,
    author,
    createdAt,
    reactions: {
      thumbsUp: typeof reactions["+1"] === "number" ? reactions["+1"] : 0,
      eyes: typeof reactions.eyes === "number" ? reactions.eyes : 0,
      confused: typeof reactions.confused === "number" ? reactions.confused : 0
    }
  };
}
/**
 * Parse the raw GitHub REST `/issues/{n}/comments` response into the
 * worker's `GitHubComment` shape (Issue #1881).
 *
 * This replaces the previous gh `--jq` filter that mapped the GitHub
 * field names (`user.login`, `created_at`) to the worker's preferred
 * names (`author.login`, `createdAt`). Doing the transform in
 * TypeScript lets us page through the thread with the existing
 * `validateGhCommentsJson` validator without gh applying `--jq` per
 * page (see `fetchIssueCommentPages`).
 *
 * @param raw - Merged raw comment array from `fetchIssueCommentPages`
 * @returns Parsed `GitHubComment` array
 * @throws When the input is not a JSON array of comment objects
 */ export function parseGhRawCommentsJson(raw) {
  if (!Array.isArray(raw)) {
    throw new Error(`Expected raw comments array, got ${raw === null ? "null" : typeof raw}`);
  }
  // Map raw REST shape onto the validator's expected shape, then
  // delegate type-safety to the existing validator.
  const remapped = raw.map((entry)=>{
    if (typeof entry !== "object" || entry === null) return entry;
    const obj = entry;
    const user = typeof obj.user === "object" && obj.user !== null ? obj.user : {};
    const reactions = typeof obj.reactions === "object" && obj.reactions !== null ? obj.reactions : {};
    return {
      id: obj.id,
      body: obj.body,
      author: {
        login: user.login
      },
      createdAt: obj.created_at,
      reactions: {
        "+1": reactions["+1"],
        eyes: reactions.eyes,
        confused: reactions.confused
      }
    };
  });
  const validated = validateGhCommentsJson(remapped);
  if (!validated.ok) {
    throw new Error(`Invalid raw comments response: ${validated.error.field} - ${validated.error.message}`);
  }
  return parseGhCommentsJson(validated.value);
}
/**
 * Parse gh CLI comments JSON into GitHubComment array.
 *
 * @param json - Raw JSON from gh CLI
 * @returns Parsed GitHubComment array
 */ export function parseGhCommentsJson(json) {
  return json.map((c)=>({
      id: c.id,
      body: c.body,
      author: c.author.login,
      createdAt: c.createdAt,
      reactions: {
        thumbsUp: c.reactions["+1"] ?? 0,
        eyes: c.reactions.eyes ?? 0,
        confused: c.reactions.confused ?? 0
      }
    }));
}
/**
 * Run a gh CLI command and return the output (without retry).
 *
 * This is the raw command execution. Use runGhCommand() for API calls
 * that should be retried on transient failures.
 *
 * Issue #3703: delegates the spawn to the shared chokepoint
 * (`gh_spawn.ts`), which enforces the write-repo allowlist before the
 * process starts, injects the GitHub App token (Issue #959) and journals
 * the mutation afterwards.
 *
 * @param args - Arguments to pass to gh
 * @param options - Work-directory override for the shared rate-limit
 *   signal a primary-quota outage writes (Issue #966). Omitted in
 *   production, where the `WORK_DIR` the run driver exports is read.
 * @returns Command output as string
 * @throws Error if command fails
 */ export async function runGhCommandRaw(args, options = {}) {
  // Issue #42: once the primary GraphQL quota is exhausted, every further
  // GraphQL-backed call in the window is guaranteed to fail. Short-circuit
  // it here — before the spawn, the telemetry and the retry decision — so a
  // scan that catches-and-continues no longer drives hundreds of doomed `gh`
  // processes (each costing a spawn and counting toward the secondary/abuse
  // limit) until something finally lets the error escape. The `rate_limit`
  // read that learns the reset is exempt, so the latch can still lift itself.
  if (!isQuotaExemptGhCall(args) && isPrimaryQuotaLatched()) {
    throw new Error(primaryQuotaSkipMessage());
  }
  // Issue #1671 / #1485: the per-iteration `gh` call telemetry is recorded
  // in `spawnGh`, the chokepoint every `gh` invocation passes, so a call
  // made through this wrapper and one made directly are counted alike.
  // Issue #3311/#3703: egress containment lives in the shared chokepoint —
  // `spawnGh` refuses an off-allowlist (or undeterminable) write BEFORE the
  // command reaches GitHub, then journals the mutation (Issue #2380).
  //
  // Issue #42 / #1540: the first live call to report a GraphQL rate-limit
  // refusal latches the process and writes the shared signal that drives the
  // Issue #1780 mid-cycle pause. A primary refusal probes its reset; a bare
  // GraphQL Forbidden gets the secondary cool-down. That used to happen in this function's
  // catch alone; it now happens in `spawnGh` for every caller, through the
  // hook registered below — this wrapper only threads its signal directory
  // through.
  return await runGhOrThrow(args, options.workDir !== undefined ? {
    workDir: options.workDir
  } : {});
}
// Issue #1540: the chokepoint sees every refusal; this module knows what to
// do about GraphQL rate-limit refusals. Registered at load, so any process
// using `gh` through `github.ts` latches whichever module saw it first.
setPrimaryQuotaExhaustionHook(({ workDir, stderr })=>notePrimaryQuotaExhaustion(stderr, workDir));
/** True while a single primary-quota exhaustion is being recorded. */ let quotaExhaustionNoteInFlight = false;
/**
 * Points the account must still hold for a "rate limit already exceeded"
 * answer to be read as a secondary (burst) limit rather than the hourly
 * quota (Issue #1456). GitHub's own wording is the same for both; the
 * balance is not. Observed: the refusal arrived with 4,700 of 5,000 points
 * untouched.
 */ export const SECONDARY_LIMIT_MIN_REMAINING = 100;
/**
 * How long GraphQL-backed calls pause after a secondary limit. GitHub's
 * guidance is "at least one minute" when no `retry-after` is sent.
 */ export const SECONDARY_LIMIT_BACKOFF_SECONDS = 60;
/**
 * Record a GraphQL rate-limit refusal (Issue #42).
 *
 * Reads the reset from the free GraphQL quota probe for a primary-quota
 * refusal (bypassing the chokepoint so it neither records telemetry nor
 * recurses), or latches briefly for a secondary refusal. Both write the
 * shared rate-limit signal so sibling workers and the Issue #1780 pause
 * observe the condition. Idempotent and
 * cheap: once the latch is set, every later call short-circuits before
 * reaching this path, and a concurrent first detection is coalesced.
 *
 * @param workDirOverride - Where the signal is written. Defaults to the
 *   `WORK_DIR` the run driver exports (Issue #966).
 */ async function notePrimaryQuotaExhaustion(refusalMessage, workDirOverride) {
  if (quotaExhaustionNoteInFlight || isPrimaryQuotaLatched()) return;
  quotaExhaustionNoteInFlight = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const workDir = workDirOverride ?? Deno.env.get("VIBE_GITHUB_QUOTA_WORK_DIR") ?? Deno.env.get("WORK_DIR");
    // A bare Forbidden from GraphQL has no quota headers to distinguish a
    // burst refusal from the hourly budget. Park for the short cool-down and
    // publish the same shared pause signal used by the primary path.
    if (isSecondaryOnlyRateLimitMessage(refusalMessage, isPrimaryRateLimitMessage)) {
      await noteSecondaryLimitCooldown(now, workDir);
      return;
    }
    const probe = await probeGraphqlQuota();
    // The quota probe itself can receive the same bare GraphQL Forbidden.
    // That is evidence of the secondary limit, not a reason to assume the
    // primary quota is exhausted for an hour.
    if (!probe.ok && isSecondaryOnlyRateLimitMessage(probe.error.message, isPrimaryRateLimitMessage)) {
      await noteSecondaryLimitCooldown(now, workDir);
      return;
    }
    // GitHub says "API rate limit already exceeded" for two different
    // things: the hourly primary quota being spent, and a secondary limit
    // tripped by a burst (points per minute, concurrent requests, CPU
    // time). The account's balance tells them apart. A burst refusal with
    // most of the hour's points untouched used to latch the process until
    // the hourly reset — up to an hour of idling for a one-minute
    // cool-down, every hour the fleet's cycles happened to collide
    // (Issue #1456).
    if (probe.ok && probe.value.remaining >= SECONDARY_LIMIT_MIN_REMAINING) {
      const waitSeconds = Math.max(SECONDARY_LIMIT_BACKOFF_SECONDS, probe.value.retryAfterSeconds ?? 0);
      latchPrimaryQuota(now + waitSeconds, now, "secondary");
      if (workDir) {
        await writeRateLimitSignal(workDir, waitSeconds, undefined, "github");
      }
      defaultLogger.warn(`GitHub refused a GraphQL call as rate-limited while the account ` + `still holds ${probe.value.remaining}/${probe.value.limit} points — ` + `a secondary (burst) limit, not the hourly quota. Pausing ` + `GraphQL-backed gh calls for ${waitSeconds}s.`);
      return;
    }
    // Issue #1888: a refusal that lands on the window boundary. The probe
    // still reports the window that just closed — `remaining` spent, `reset`
    // already behind us — and reading the reset from `gh api rate_limit`
    // instead would name the NEW window's, an hour out. The 04:47Z run of
    // 2026-09-10 latched exactly that way and sat out a full hour with
    // used=0/5000. A closed window's exhaustion has lifted: hold the short
    // cool-down and let the next call re-probe.
    if (probe.ok && probe.value.reset <= now) {
      const waitSeconds = SECONDARY_LIMIT_BACKOFF_SECONDS;
      latchPrimaryQuota(now + waitSeconds, now, "secondary");
      if (workDir) {
        await writeRateLimitSignal(workDir, waitSeconds, undefined, "github");
      }
      defaultLogger.warn(`GitHub refused a GraphQL call as rate-limited for a window that ` + `has already closed (reset ${formatRateLimitReset(probe.value.reset, now)}) — a boundary refusal, not the new hour's quota. Pausing ` + `GraphQL-backed gh calls for ${waitSeconds}s, then re-probing ` + `(Issue #1888).`);
      return;
    }
    const resetEpoch = probe.ok && probe.value.reset > now ? probe.value.reset : await readGraphqlResetEpoch(now);
    latchPrimaryQuota(resetEpoch, now);
    const waitSeconds = Math.max(0, resetEpoch - now);
    if (workDir) {
      await writeRateLimitSignal(workDir, waitSeconds, undefined, "github");
    }
    defaultLogger.warn(`Primary GraphQL quota exhausted — latching all GraphQL-backed gh ` + `calls until reset ${formatRateLimitReset(resetEpoch, now)}`);
  } catch (err) {
    // Never let bookkeeping mask the original failure — the latch is a
    // best-effort optimisation; the caller still sees its own error.
    defaultLogger.warn(`Failed to record primary-quota exhaustion: ${err instanceof Error ? err.message : String(err)}`);
  } finally{
    quotaExhaustionNoteInFlight = false;
  }
}
/** Latch the short secondary cool-down and write the shared pause signal. */ async function noteSecondaryLimitCooldown(now, workDir) {
  const waitSeconds = SECONDARY_LIMIT_BACKOFF_SECONDS;
  latchPrimaryQuota(now + waitSeconds, now, "secondary");
  if (workDir) {
    await writeRateLimitSignal(workDir, waitSeconds, undefined, "github");
  }
  defaultLogger.warn(`GitHub refused a GraphQL call under the secondary rate limit. Pausing ` + `GraphQL-backed gh calls for ${waitSeconds}s.`);
}
/**
 * Read the GraphQL reset epoch, falling back to one hour from now when
 * nothing can be learnt (a conservative window the latch auto-lifts from the
 * moment the real quota returns).
 *
 * The free GraphQL probe is asked first: its response headers are the
 * bucket's own accounting and are still sent once the quota is gone.
 * `gh api rate_limit` is only a last resort — it has been observed reporting
 * the GraphQL bucket as untouched, with a reset exactly one hour out, while
 * the headers said otherwise, which is what latched the worker for a flat
 * hour on every exhaustion (Issue #1456).
 */ async function readGraphqlResetEpoch(now) {
  const probe = await probeGraphqlQuota();
  if (probe.ok && probe.value.reset > now) {
    return probe.value.reset;
  }
  try {
    const raw = await runGhOrThrow([
      "api",
      "rate_limit"
    ]);
    const parsed = JSON.parse(raw);
    const reset = parsed.resources?.graphql?.reset ?? parsed.resources?.core?.reset;
    if (typeof reset === "number" && Number.isFinite(reset) && reset > now) {
      return reset;
    }
  } catch  {
  // Fall through to the conservative default.
  }
  return now + 3600;
}
/**
 * Run a gh CLI command with automatic retry for transient failures.
 *
 * Wraps runGhCommandRaw with exponential backoff retry logic.
 * Transient errors (5xx, rate limits, network) are retried;
 * permanent errors (4xx, auth) fail immediately.
 *
 * @param args - Arguments to pass to gh
 * @returns Command output as string
 * @throws Error if command fails permanently or after all retries exhausted
 */ export async function runGhCommand(args) {
  return await retryWithBackoff(()=>runGhCommandRaw(args));
}
/**
 * Determine whether a comment body has any visible content.
 *
 * Returns false for bodies that are empty, whitespace-only, or contain only
 * HTML comments (e.g. `<!-- CLAIM_LOCK:foo -->`). Such bodies render as
 * completely blank comments on GitHub, which is confusing to human readers
 * — see Issue #1659.
 *
 * @param body - The candidate comment body
 * @returns true if the body has at least one non-whitespace, non-comment character
 */ export function hasVisibleContent(body) {
  if (typeof body !== "string") return false;
  // Walk the body comment by comment rather than stripping comments with a
  // replace: a single replace can re-form a comment from what it leaves
  // behind (CodeQL js/incomplete-multi-character-sanitization). An unclosed
  // `<!--` hides the rest of the body on GitHub, and `--!>` closes a comment
  // as well as `-->`.
  let rest = body;
  for(;;){
    const open = rest.indexOf("<!--");
    if (open === -1) return rest.trim().length > 0;
    if (rest.slice(0, open).trim().length > 0) return true;
    const close = /--!?>/.exec(rest.slice(open + 4));
    if (close === null) return false;
    rest = rest.slice(open + 4 + close.index + close[0].length);
  }
}
/**
 * Determine if an error message indicates a "label not found" condition.
 *
 * Only this specific error should be silently ignored by removeLabel.
 * Network errors, authentication failures, etc. should propagate.
 *
 * @param errorMessage - The error message to check
 * @returns true if the error is specifically about a missing label
 */ export function isLabelNotFoundError(errorMessage) {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return lower.includes("label") && lower.includes("not found");
}
/**
 * Whether `label` is reserved, treating the operator's configured
 * `custom_label_prompts` labels as reserved too (Issue #847, part of #843).
 *
 * A custom label dispatches a privileged automation phase, so the worker must
 * never self-apply one — the same rule `RESERVED_LABELS` encodes for `planning`
 * and friends. The custom set is config-driven, so it is passed in rather than
 * baked into the static constant. Comparison is case-insensitive, matching
 * `isReservedLabel`.
 */ function isReservedOrCustomLabel(label, extraReserved) {
  if (isReservedLabel(label)) return true;
  const lower = label.toLowerCase();
  return extraReserved.some((extra)=>extra.toLowerCase() === lower);
}
/**
 * Filter out reserved labels that must not be applied when creating issues.
 *
 * Reserved labels are used by the worker for operational purposes (issue
 * discovery, prioritisation, failure tracking, workflow state). Only the
 * repository owner should apply these labels.
 *
 * Issue #297: Prevent the vibe coder from labelling created issues with
 * special operational labels.
 *
 * @param labels - Labels to filter
 * @param extraReserved - Configured `custom_label_prompts` labels, reserved for
 *   the same reason (Issue #847). Defaults to `[]` — no configured mappings,
 *   no behaviour change.
 * @returns Labels with reserved labels removed
 */ export function filterReservedLabels(labels, extraReserved = []) {
  // Issue #3088: compare case-insensitively so a non-lower-case canonical
  // label (e.g. `Planning`) is still stripped.
  return labels.filter((label)=>!isReservedOrCustomLabel(label, extraReserved));
}
/**
 * Creation-time variant of {@link filterReservedLabels} that logs a WARNING
 * for every reserved label it strips (Issue #2822).
 *
 * Returns the same filtered list as `filterReservedLabels` — reading the one
 * `RESERVED_LABELS` constant so the set stays in sync automatically (no second
 * copy of the list) — but emits one `logger.warn` per dropped label, naming the
 * stripped label and a caller-supplied context (e.g. repo + creation path) so a
 * worker self-applying a reserved label is visible at a glance.
 *
 * `idle-task` and arbitrary descriptive labels (e.g. `degraded-model`) are not
 * in `RESERVED_LABELS`, so they pass through unchanged and log nothing.
 *
 * @param labels - Labels to filter
 * @param context - Caller context for the warning (e.g. "owner/repo idle-task filer")
 * @param logger - Logger used to emit one WARNING per stripped label
 * @param extraReserved - Configured `custom_label_prompts` labels, reserved for
 *   the same reason (Issue #847)
 * @returns Labels with reserved labels removed
 */ export function filterReservedLabelsWithWarning(labels, context, logger, extraReserved = []) {
  const kept = [];
  for (const label of labels){
    // Issue #3088: case-insensitive match (see isReservedLabel).
    if (isReservedOrCustomLabel(label, extraReserved)) {
      logger.warn("Stripped reserved label from worker-created issue", {
        label,
        context
      });
    } else {
      kept.push(label);
    }
  }
  return kept;
}
/** The failure message for one improvement, with its routing reason when known. */ function describeRoutingFailure(error, RoutedIssueFilingError) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RoutedIssueFilingError && error.decision !== null) {
    return `${message} (routing: ${error.decision.reason})`;
  }
  return message;
}
/**
 * Create GitHub issues for improvements, continuing past individual failures.
 *
 * Each improvement goes through {@link fileRoutedIssue}, so it lands in the
 * repository that owns it. An ambiguous owner is a failure and nothing is
 * filed. Every improvement is attempted and partial failures are reported.
 *
 * @param improvements - Improvements to create issues for
 * @param repo - Target repository in "owner/repo" format
 * @param options - Routing context, dry-run flag and injectable dependencies
 * @returns Created issue numbers, routed improvements and any failures
 */ export async function createGitHubIssuesWithPartialFailures(improvements, repo, options) {
  const logger = options.logger ?? defaultLogger;
  const createdIssues = [];
  const failures = [];
  const routed = [];
  // Loaded lazily: a static import closes the cycle github.ts ->
  // issue_routing_filing.ts -> issue_routing_classifier.ts ->
  // repo_fast_failure_issue.ts -> needs_human_escalation.ts ->
  // label_operations.ts -> github.ts. A static import would leave the
  // classifier's marker constants uninitialised when a repo_fast_failure
  // module loads first.
  const { fileRoutedIssue, RoutedIssueFilingError } = await import("./issue_routing_filing.ts");
  for (const improvement of improvements){
    try {
      const body = formatImprovementAsIssueBody(improvement);
      // The pre-filter strips built-in and configured custom reserved labels,
      // warning with the suggest-improvements context (Issue #2825). The
      // router re-filters built-in reserved labels as defence in depth.
      const safeLabels = filterReservedLabelsWithWarning(improvement.labels, `${repo} suggest-improvements`, logger, options.extraReservedLabels);
      const filed = await fileRoutedIssue({
        title: improvement.title,
        body,
        labels: safeLabels
      }, {
        targetRepo: repo,
        context: options.routingContext,
        dryRun: options.dryRun,
        ghCommandFn: options.ghCommandFn,
        now: options.now,
        ...options.dedupAuthors ? {
          authors: options.dedupAuthors
        } : {},
        logger
      });
      if (filed.action === "ambiguous") {
        failures.push({
          title: improvement.title,
          error: `Routing filed nothing: ${filed.decision.reason}`
        });
        continue;
      }
      routed.push({
        title: improvement.title,
        action: filed.action,
        repository: filed.repository,
        number: filed.number
      });
      if (filed.action === "created") createdIssues.push(filed.number);
    } catch (error) {
      failures.push({
        title: improvement.title,
        error: describeRoutingFailure(error, RoutedIssueFilingError)
      });
    }
  }
  return {
    createdIssues,
    failures,
    routed
  };
}
/**
 * Create a GitHub client that uses the gh CLI.
 *
 * @param logger - Logger instance for diagnostic output
 * @returns GitHub client instance
 */ /** Fields `gh issue view` is asked for. `state` stays in the list so a merged pull request is a successful lookup, not a thrown validation error (Issue #3088 review). */ export const GH_ISSUE_VIEW_JSON_FIELDS = "number,title,body,labels,author,assignees,createdAt,updatedAt,state";
export function createGitHubClient(logger) {
  return {
    async getIssue (repo, issueNumber) {
      logger.debug(`Fetching issue #${issueNumber} from ${repo}`);
      const output = await runGhCommand([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        GH_ISSUE_VIEW_JSON_FIELDS
      ]);
      const parsed = JSON.parse(output);
      const validated = validateGhIssueJson(parsed);
      if (!validated.ok) {
        throw new Error(`Invalid gh CLI issue response: ${validated.error.field} - ${validated.error.message}`);
      }
      return parseGhIssueJson(validated.value);
    },
    async getIssueComments (repo, issueNumber) {
      // Issue #1841: per-iteration TTL cache. Multiple priorities read
      // the same issue's comments within an iteration; the cache
      // collapses those into a single REST call. The cache is
      // invalidated by `postComment` for the same `(repo, issueNumber)`.
      return await getCachedComments(repo, issueNumber, async ()=>{
        logger.debug(`Fetching comments for issue #${issueNumber} from ${repo}`);
        // Use REST API — gh issue view --json comments returns GraphQL node IDs
        // (strings) instead of numeric IDs needed for REST API operations.
        // Issue #1881: page through all comments. The default REST page size
        // is 30, which silently truncated long grill-me threads and caused
        // workflows to re-pose questions the developer had already answered.
        // Issue #3709: bounded pagination replaces unbounded `--paginate`.
        const raw = await fetchIssueCommentPages(repo, issueNumber, runGhCommand);
        return parseGhRawCommentsJson(raw);
      });
    },
    async addLabel (repo, issueNumber, label) {
      logger.debug(`Adding label "${label}" to issue #${issueNumber} in ${repo}`);
      // Issue #976: Use REST API with CLI fallback for label operations
      try {
        await runGhCommand([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/${issueNumber}/labels`,
          "-f",
          `labels[]=${label}`
        ]);
        return;
      } catch  {
      // REST API failed — fall back to CLI
      }
      await runGhCommand([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--add-label",
        label
      ]);
    },
    async removeLabel (repo, issueNumber, label) {
      logger.debug(`Removing label "${label}" from issue #${issueNumber} in ${repo}`);
      try {
        await runGhCommand([
          "issue",
          "edit",
          String(issueNumber),
          "--repo",
          repo,
          "--remove-label",
          label
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isLabelNotFoundError(message)) {
          logger.debug(`Label "${label}" not found on issue #${issueNumber} — ignoring`);
          return;
        }
        throw error;
      }
    },
    async postComment (repo, issueNumber, body) {
      // Issue #1659: skip whitespace-only bodies. An empty or
      // HTML-comment-only body renders as a blank comment on GitHub, which
      // confuses readers ("Multiple blank comments"). Callers that need a
      // hidden marker must include a visible line as well — see
      // claim_pr_comment.ts for the canonical pattern.
      if (!hasVisibleContent(body)) {
        logger.warn(`Refusing to post comment to issue #${issueNumber} in ${repo}: body has no visible content`);
        return undefined;
      }
      logger.debug(`Posting comment to issue #${issueNumber} in ${repo}`);
      // Issue #1843: post via the REST API so the response carries the
      // freshly-created comment metadata (id, createdAt, author). Callers
      // that previously had to refetch the comment list to pick up a
      // post they just made can append the returned object in memory
      // instead — saving one GH call per round.
      let created;
      try {
        const output = await runGhCommand([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/${issueNumber}/comments`,
          "-f",
          `body=${body}`
        ]);
        created = parseCreatedCommentJson(output);
      } catch (apiErr) {
        // REST POST failed — fall back to the legacy `gh issue comment`
        // path. Older gh versions or unexpected response shapes must not
        // break existing callers; the only consequence is that no
        // metadata is returned.
        logger.debug(`REST POST comment failed (${apiErr instanceof Error ? apiErr.message : String(apiErr)}); falling back to gh issue comment`);
        await runGhCommand([
          "issue",
          "comment",
          String(issueNumber),
          "--repo",
          repo,
          "--body",
          body
        ]);
      }
      // Issue #1841: invalidate the comment cache so the next read
      // sees the freshly-posted comment without a stale-cache hit.
      invalidateComments(repo, issueNumber);
      return created;
    },
    async updateComment (repo, commentId, body) {
      // The id is interpolated into the REST path, so a non-numeric one is
      // refused outright rather than escaped — there is nothing legitimate
      // it could be (Issue #1879).
      if (!Number.isInteger(commentId) || commentId <= 0) {
        throw new Error(`updateComment: comment id must be a positive integer, got "${commentId}"`);
      }
      logger.debug(`Editing comment ${commentId} in ${repo}`);
      const output = await runGhCommand([
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/issues/comments/${commentId}`,
        "-f",
        `body=${body}`
      ]);
      // The PATCH response names the issue the comment belongs to, so the
      // per-iteration comment cache can be dropped without the caller having
      // to know the issue number (Issue #1841's cache, Issue #1879's edit).
      const issueNumber = parseCommentIssueNumber(output);
      if (issueNumber !== undefined) invalidateComments(repo, issueNumber);
    },
    async editIssue (repo, issueNumber, updates) {
      logger.debug(`Editing issue #${issueNumber} in ${repo}`);
      const args = [
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo
      ];
      if (updates.title !== undefined) {
        args.push("--title", updates.title);
      }
      if (updates.body !== undefined) {
        args.push("--body", updates.body);
      }
      await runGhCommand(args);
    },
    async assignIssue (repo, issueNumber, assignees) {
      logger.debug(`Assigning ${assignees.join(", ")} to issue #${issueNumber} in ${repo}`);
      await runGhCommand([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--add-assignee",
        assignees.join(",")
      ]);
    },
    async unassignIssue (repo, issueNumber, assignees) {
      logger.debug(`Unassigning ${assignees.join(", ")} from issue #${issueNumber} in ${repo}`);
      // Issue #42 Defect 3: release the claim via the REST assignees
      // endpoint (core quota) rather than `gh issue edit` (GraphQL). A
      // finished run must be able to drop its claim even while the primary
      // GraphQL quota is exhausted — the core quota is a separate budget,
      // and the primary-quota latch exempts REST `gh api` calls for exactly
      // this reason. An empty list is a no-op, matching the old behaviour.
      if (assignees.length === 0) return;
      const args = [
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/issues/${issueNumber}/assignees`
      ];
      for (const assignee of assignees){
        args.push("-f", `assignees[]=${assignee}`);
      }
      await runGhCommand(args);
    },
    async closeIssue (repo, issueNumber, comment) {
      logger.debug(`Closing issue #${issueNumber} in ${repo}`);
      const args = [
        "issue",
        "close",
        String(issueNumber),
        "--repo",
        repo
      ];
      if (comment) {
        args.push("--comment", comment);
      }
      await runGhCommand(args);
    }
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRodWIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBHaXRIdWIgY2xpZW50IG1vZHVsZSBmb3IgdGhlIFZpYmUgQ29kZXIgd29ya2VyLlxuICpcbiAqIFByb3ZpZGVzIGEgVHlwZVNjcmlwdCBpbnRlcmZhY2UgZm9yIGludGVyYWN0aW5nIHdpdGggR2l0SHViXG4gKiB2aWEgdGhlIGdoIENMSSB0b29sLCB3aXRoIHJldHJ5IHJlc2lsaWVuY2UgZm9yIHRyYW5zaWVudCBmYWlsdXJlcy5cbiAqXG4gKiBJc3N1ZSAjMjE3IOKAlCBBZGRlZCByZXRyeSBsb2dpYywgcGFydGlhbCBmYWlsdXJlIGhhbmRsaW5nLCBhbmRcbiAqIGltcHJvdmVkIGVycm9yIGNsYXNzaWZpY2F0aW9uLlxuICovXG5cbmltcG9ydCB0eXBlIHtcbiAgR2l0SHViQ2xpZW50LFxuICBHaXRIdWJDb21tZW50LFxuICBHaXRIdWJJc3N1ZSxcbiAgTG9nZ2VyLFxufSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIHR5cGUgR2hDb21tZW50SnNvbixcbiAgdHlwZSBHaElzc3VlSnNvbixcbiAgdmFsaWRhdGVHaENvbW1lbnRzSnNvbixcbiAgdmFsaWRhdGVHaElzc3VlSnNvbixcbn0gZnJvbSBcIi4vdmFsaWRhdGlvbi50c1wiO1xuaW1wb3J0IHsgcmV0cnlXaXRoQmFja29mZiB9IGZyb20gXCIuL3JldHJ5LnRzXCI7XG5pbXBvcnQgeyBpc1Jlc2VydmVkTGFiZWwgfSBmcm9tIFwiLi9jb25maWdfZGVmYXVsdHMudHNcIjtcbmltcG9ydCB7IHJ1bkdoT3JUaHJvdywgc2V0UHJpbWFyeVF1b3RhRXhoYXVzdGlvbkhvb2sgfSBmcm9tIFwiLi9naF9zcGF3bi50c1wiO1xuaW1wb3J0IHsgcHJvYmVHcmFwaHFsUXVvdGEgfSBmcm9tIFwiLi9ncmFwaHFsX3F1b3RhX3Byb2JlLnRzXCI7XG5pbXBvcnQge1xuICBpc1ByaW1hcnlRdW90YUxhdGNoZWQsXG4gIGlzUHJpbWFyeVJhdGVMaW1pdE1lc3NhZ2UsXG4gIGlzUXVvdGFFeGVtcHRHaENhbGwsXG4gIGxhdGNoUHJpbWFyeVF1b3RhLFxuICBwcmltYXJ5UXVvdGFTa2lwTWVzc2FnZSxcbn0gZnJvbSBcIi4vcHJpbWFyeV9xdW90YV9sYXRjaC50c1wiO1xuaW1wb3J0IHsgaXNTZWNvbmRhcnlPbmx5UmF0ZUxpbWl0TWVzc2FnZSB9IGZyb20gXCIuL3NlY29uZGFyeV9yYXRlX2xpbWl0LnRzXCI7XG5pbXBvcnQge1xuICBmb3JtYXRSYXRlTGltaXRSZXNldCxcbiAgd3JpdGVSYXRlTGltaXRTaWduYWwsXG59IGZyb20gXCIuL3JhdGVfbGltaXRfc2lnbmFsLnRzXCI7XG5pbXBvcnQgeyBnZXRDYWNoZWRDb21tZW50cywgaW52YWxpZGF0ZUNvbW1lbnRzIH0gZnJvbSBcIi4vY29tbWVudF9jYWNoZS50c1wiO1xuaW1wb3J0IHsgZmV0Y2hJc3N1ZUNvbW1lbnRQYWdlcyB9IGZyb20gXCIuL2lzc3VlX2NvbW1lbnRfcGFnZXMudHNcIjtcbmltcG9ydCB0eXBlIHsgSW1wcm92ZW1lbnQgfSBmcm9tIFwiLi4vY29tbWFuZHMvc3VnZ2VzdF9pbXByb3ZlbWVudHMudHNcIjtcbmltcG9ydCB7IGZvcm1hdEltcHJvdmVtZW50QXNJc3N1ZUJvZHkgfSBmcm9tIFwiLi4vY29tbWFuZHMvc3VnZ2VzdF9pbXByb3ZlbWVudHMudHNcIjtcbmltcG9ydCB7IGRlZmF1bHRMb2dnZXIgfSBmcm9tIFwiLi9sb2dnZXIudHNcIjtcbmltcG9ydCB0eXBlIHsgSXNzdWVSb3V0aW5nQ29udGV4dCB9IGZyb20gXCIuL2lzc3VlX3JvdXRpbmdfY2xhc3NpZmllci50c1wiO1xuaW1wb3J0IHR5cGUgeyBSb3V0ZWRJc3N1ZUFjdGlvbiB9IGZyb20gXCIuL2lzc3VlX3JvdXRpbmdfZmlsaW5nLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEFsZXJ0RGVkdXBBdXRob3JPcHRpb25zIH0gZnJvbSBcIi4vYWxlcnRfZGVkdXBfYXV0aG9ycy50c1wiO1xuXG4vKipcbiAqIFBhcnNlIGdoIENMSSBpc3N1ZSBKU09OIGludG8gYSBHaXRIdWJJc3N1ZSBvYmplY3QuXG4gKlxuICogQHBhcmFtIGpzb24gLSBSYXcgSlNPTiBmcm9tIGdoIENMSVxuICogQHJldHVybnMgUGFyc2VkIEdpdEh1Yklzc3VlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUdoSXNzdWVKc29uKGpzb246IEdoSXNzdWVKc29uKTogR2l0SHViSXNzdWUge1xuICByZXR1cm4ge1xuICAgIG51bWJlcjoganNvbi5udW1iZXIsXG4gICAgdGl0bGU6IGpzb24udGl0bGUsXG4gICAgYm9keToganNvbi5ib2R5ID8/IFwiXCIsXG4gICAgbGFiZWxzOiBqc29uLmxhYmVscy5tYXAoKGwpID0+IGwubmFtZSksXG4gICAgYXV0aG9yOiBqc29uLmF1dGhvci5sb2dpbixcbiAgICBhc3NpZ25lZXM6IGpzb24uYXNzaWduZWVzLm1hcCgoYSkgPT4gYS5sb2dpbiksXG4gICAgY3JlYXRlZEF0OiBqc29uLmNyZWF0ZWRBdCxcbiAgICB1cGRhdGVkQXQ6IGpzb24udXBkYXRlZEF0LFxuICAgIC4uLihqc29uLnN0YXRlID8geyBzdGF0ZToganNvbi5zdGF0ZSB9IDoge30pLFxuICB9O1xufVxuXG4vKipcbiAqIFJlYWQgdGhlIGlzc3VlIG51bWJlciBvdXQgb2YgYSBjb21tZW50IFJFU1QgcGF5bG9hZCdzIGBpc3N1ZV91cmxgXG4gKiAoSXNzdWUgIzE4NzkpLlxuICpcbiAqIGBQQVRDSCAvcmVwb3Mve293bmVyfS97cmVwb30vaXNzdWVzL2NvbW1lbnRzL3tpZH1gIGlzIGFkZHJlc3NlZCBieSBjb21tZW50XG4gKiBpZCBhbG9uZSwgc28gdGhlIGNhbGxlciBuZXZlciBoYXMgdG8ga25vdyB3aGljaCBpc3N1ZSB0aGUgY29tbWVudCBiZWxvbmdzXG4gKiB0byDigJQgYnV0IHRoZSBwZXItaXRlcmF0aW9uIGNvbW1lbnQgY2FjaGUgaXMga2V5ZWQgYnkgaXNzdWUsIGFuZCBhIHN0YWxlXG4gKiBlbnRyeSB3b3VsZCBoYW5kIHRoZSBuZXh0IHJlYWRlciB0aGUgYm9keSBiZWZvcmUgdGhlIGVkaXQuIFRoZSByZXNwb25zZVxuICogbmFtZXMgdGhlIGlzc3VlLCBzbyB0aGUgaW52YWxpZGF0aW9uIGNvc3RzIG5vIGV4dHJhIGNhbGwuXG4gKlxuICogQHBhcmFtIHJhdyAtIFJhdyBKU09OIHN0cmluZyBmcm9tIHRoZSBnaCBSRVNUIGNhbGwuXG4gKiBAcmV0dXJucyBUaGUgaXNzdWUgbnVtYmVyLCBvciBgdW5kZWZpbmVkYCB3aGVuIHRoZSBwYXlsb2FkIGRvZXMgbm90IG5hbWVcbiAqICAgb25lIOKAlCB0aGUgY2FjaGUgaXMgdGhlbiBzaW1wbHkgbGVmdCBhbG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ29tbWVudElzc3VlTnVtYmVyKHJhdzogc3RyaW5nKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKHR5cGVvZiBwYXJzZWQgIT09IFwib2JqZWN0XCIgfHwgcGFyc2VkID09PSBudWxsKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBpc3N1ZVVybCA9IChwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmlzc3VlX3VybDtcbiAgaWYgKHR5cGVvZiBpc3N1ZVVybCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbWF0Y2ggPSBpc3N1ZVVybC5tYXRjaCgvXFwvaXNzdWVzXFwvKFxcZCspJC8pO1xuICBpZiAoIW1hdGNoPy5bMV0pIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHZhbHVlID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgcmV0dXJuIE51bWJlci5pc0ludGVnZXIodmFsdWUpICYmIHZhbHVlID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFBhcnNlIHRoZSBKU09OIHJldHVybmVkIGJ5IGBQT1NUIC9yZXBvcy97b3duZXJ9L3tyZXBvfS9pc3N1ZXMve259L2NvbW1lbnRzYFxuICogaW50byBhIGBHaXRIdWJDb21tZW50YC4gVGhlIFJFU1QgQVBJIHJldHVybnMgYSBzaW5nbGUgY29tbWVudCBvYmplY3Qgd2l0aFxuICogYGlkYCwgYGJvZHlgLCBgdXNlci5sb2dpbmAsIGBjcmVhdGVkX2F0YCwgYW5kIChvcHRpb25hbGx5KSBgcmVhY3Rpb25zYC5cbiAqXG4gKiBJc3N1ZSAjMTg0MzogcmV0dXJuZWQgYnkgYHBvc3RDb21tZW50YCBzbyBjYWxsZXJzIGNhbiBhcHBlbmQgdGhlIGZyZXNobHlcbiAqIGNyZWF0ZWQgY29tbWVudCB0byBhbiBpbi1tZW1vcnkgbGlzdCBpbnN0ZWFkIG9mIHJlZmV0Y2hpbmcuXG4gKlxuICogQHBhcmFtIHJhdyAtIFJhdyBKU09OIHN0cmluZyBmcm9tIHRoZSBnaCBSRVNUIFBPU1RcbiAqIEByZXR1cm5zIFBhcnNlZCBHaXRIdWJDb21tZW50LCBvciB1bmRlZmluZWQgaWYgdGhlIEpTT04gaXMgdW5yZWNvZ25pc2VkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNyZWF0ZWRDb21tZW50SnNvbihcbiAgcmF3OiBzdHJpbmcsXG4pOiBHaXRIdWJDb21tZW50IHwgdW5kZWZpbmVkIHtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKHR5cGVvZiBwYXJzZWQgIT09IFwib2JqZWN0XCIgfHwgcGFyc2VkID09PSBudWxsKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBvYmogPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGNvbnN0IGlkID0gdHlwZW9mIG9iai5pZCA9PT0gXCJudW1iZXJcIiA/IG9iai5pZCA6IHVuZGVmaW5lZDtcbiAgY29uc3QgYm9keSA9IHR5cGVvZiBvYmouYm9keSA9PT0gXCJzdHJpbmdcIiA/IG9iai5ib2R5IDogdW5kZWZpbmVkO1xuICBjb25zdCBjcmVhdGVkQXQgPSB0eXBlb2Ygb2JqLmNyZWF0ZWRfYXQgPT09IFwic3RyaW5nXCJcbiAgICA/IG9iai5jcmVhdGVkX2F0XG4gICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHVzZXIgPSBvYmoudXNlcjtcbiAgY29uc3QgYXV0aG9yID0gKHR5cGVvZiB1c2VyID09PSBcIm9iamVjdFwiICYmIHVzZXIgIT09IG51bGwgJiZcbiAgICAgIHR5cGVvZiAodXNlciBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikubG9naW4gPT09IFwic3RyaW5nXCIpXG4gICAgPyAoKHVzZXIgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmxvZ2luIGFzIHN0cmluZylcbiAgICA6IHVuZGVmaW5lZDtcbiAgaWYgKFxuICAgIGlkID09PSB1bmRlZmluZWQgfHwgYm9keSA9PT0gdW5kZWZpbmVkIHx8IGF1dGhvciA9PT0gdW5kZWZpbmVkIHx8XG4gICAgY3JlYXRlZEF0ID09PSB1bmRlZmluZWRcbiAgKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBjb25zdCByZWFjdGlvbnMgPVxuICAgICh0eXBlb2Ygb2JqLnJlYWN0aW9ucyA9PT0gXCJvYmplY3RcIiAmJiBvYmoucmVhY3Rpb25zICE9PSBudWxsKVxuICAgICAgPyBvYmoucmVhY3Rpb25zIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgICA6IHt9O1xuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGJvZHksXG4gICAgYXV0aG9yLFxuICAgIGNyZWF0ZWRBdCxcbiAgICByZWFjdGlvbnM6IHtcbiAgICAgIHRodW1ic1VwOiB0eXBlb2YgcmVhY3Rpb25zW1wiKzFcIl0gPT09IFwibnVtYmVyXCJcbiAgICAgICAgPyByZWFjdGlvbnNbXCIrMVwiXSBhcyBudW1iZXJcbiAgICAgICAgOiAwLFxuICAgICAgZXllczogdHlwZW9mIHJlYWN0aW9ucy5leWVzID09PSBcIm51bWJlclwiID8gcmVhY3Rpb25zLmV5ZXMgYXMgbnVtYmVyIDogMCxcbiAgICAgIGNvbmZ1c2VkOiB0eXBlb2YgcmVhY3Rpb25zLmNvbmZ1c2VkID09PSBcIm51bWJlclwiXG4gICAgICAgID8gcmVhY3Rpb25zLmNvbmZ1c2VkIGFzIG51bWJlclxuICAgICAgICA6IDAsXG4gICAgfSxcbiAgfTtcbn1cblxuLyoqXG4gKiBQYXJzZSB0aGUgcmF3IEdpdEh1YiBSRVNUIGAvaXNzdWVzL3tufS9jb21tZW50c2AgcmVzcG9uc2UgaW50byB0aGVcbiAqIHdvcmtlcidzIGBHaXRIdWJDb21tZW50YCBzaGFwZSAoSXNzdWUgIzE4ODEpLlxuICpcbiAqIFRoaXMgcmVwbGFjZXMgdGhlIHByZXZpb3VzIGdoIGAtLWpxYCBmaWx0ZXIgdGhhdCBtYXBwZWQgdGhlIEdpdEh1YlxuICogZmllbGQgbmFtZXMgKGB1c2VyLmxvZ2luYCwgYGNyZWF0ZWRfYXRgKSB0byB0aGUgd29ya2VyJ3MgcHJlZmVycmVkXG4gKiBuYW1lcyAoYGF1dGhvci5sb2dpbmAsIGBjcmVhdGVkQXRgKS4gRG9pbmcgdGhlIHRyYW5zZm9ybSBpblxuICogVHlwZVNjcmlwdCBsZXRzIHVzIHBhZ2UgdGhyb3VnaCB0aGUgdGhyZWFkIHdpdGggdGhlIGV4aXN0aW5nXG4gKiBgdmFsaWRhdGVHaENvbW1lbnRzSnNvbmAgdmFsaWRhdG9yIHdpdGhvdXQgZ2ggYXBwbHlpbmcgYC0tanFgIHBlclxuICogcGFnZSAoc2VlIGBmZXRjaElzc3VlQ29tbWVudFBhZ2VzYCkuXG4gKlxuICogQHBhcmFtIHJhdyAtIE1lcmdlZCByYXcgY29tbWVudCBhcnJheSBmcm9tIGBmZXRjaElzc3VlQ29tbWVudFBhZ2VzYFxuICogQHJldHVybnMgUGFyc2VkIGBHaXRIdWJDb21tZW50YCBhcnJheVxuICogQHRocm93cyBXaGVuIHRoZSBpbnB1dCBpcyBub3QgYSBKU09OIGFycmF5IG9mIGNvbW1lbnQgb2JqZWN0c1xuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VHaFJhd0NvbW1lbnRzSnNvbihyYXc6IHVua25vd24pOiBHaXRIdWJDb21tZW50W10ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBFeHBlY3RlZCByYXcgY29tbWVudHMgYXJyYXksIGdvdCAke3JhdyA9PT0gbnVsbCA/IFwibnVsbFwiIDogdHlwZW9mIHJhd31gLFxuICAgICk7XG4gIH1cbiAgLy8gTWFwIHJhdyBSRVNUIHNoYXBlIG9udG8gdGhlIHZhbGlkYXRvcidzIGV4cGVjdGVkIHNoYXBlLCB0aGVuXG4gIC8vIGRlbGVnYXRlIHR5cGUtc2FmZXR5IHRvIHRoZSBleGlzdGluZyB2YWxpZGF0b3IuXG4gIGNvbnN0IHJlbWFwcGVkOiB1bmtub3duW10gPSByYXcubWFwKChlbnRyeSkgPT4ge1xuICAgIGlmICh0eXBlb2YgZW50cnkgIT09IFwib2JqZWN0XCIgfHwgZW50cnkgPT09IG51bGwpIHJldHVybiBlbnRyeTtcbiAgICBjb25zdCBvYmogPSBlbnRyeSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBjb25zdCB1c2VyID0gKHR5cGVvZiBvYmoudXNlciA9PT0gXCJvYmplY3RcIiAmJiBvYmoudXNlciAhPT0gbnVsbClcbiAgICAgID8gb2JqLnVzZXIgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgICAgIDoge307XG4gICAgY29uc3QgcmVhY3Rpb25zID1cbiAgICAgICh0eXBlb2Ygb2JqLnJlYWN0aW9ucyA9PT0gXCJvYmplY3RcIiAmJiBvYmoucmVhY3Rpb25zICE9PSBudWxsKVxuICAgICAgICA/IG9iai5yZWFjdGlvbnMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgICAgICAgOiB7fTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQ6IG9iai5pZCxcbiAgICAgIGJvZHk6IG9iai5ib2R5LFxuICAgICAgYXV0aG9yOiB7IGxvZ2luOiB1c2VyLmxvZ2luIH0sXG4gICAgICBjcmVhdGVkQXQ6IG9iai5jcmVhdGVkX2F0LFxuICAgICAgcmVhY3Rpb25zOiB7XG4gICAgICAgIFwiKzFcIjogcmVhY3Rpb25zW1wiKzFcIl0sXG4gICAgICAgIGV5ZXM6IHJlYWN0aW9ucy5leWVzLFxuICAgICAgICBjb25mdXNlZDogcmVhY3Rpb25zLmNvbmZ1c2VkLFxuICAgICAgfSxcbiAgICB9O1xuICB9KTtcbiAgY29uc3QgdmFsaWRhdGVkID0gdmFsaWRhdGVHaENvbW1lbnRzSnNvbihyZW1hcHBlZCk7XG4gIGlmICghdmFsaWRhdGVkLm9rKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEludmFsaWQgcmF3IGNvbW1lbnRzIHJlc3BvbnNlOiAke3ZhbGlkYXRlZC5lcnJvci5maWVsZH0gLSAke3ZhbGlkYXRlZC5lcnJvci5tZXNzYWdlfWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcGFyc2VHaENvbW1lbnRzSnNvbih2YWxpZGF0ZWQudmFsdWUpO1xufVxuXG4vKipcbiAqIFBhcnNlIGdoIENMSSBjb21tZW50cyBKU09OIGludG8gR2l0SHViQ29tbWVudCBhcnJheS5cbiAqXG4gKiBAcGFyYW0ganNvbiAtIFJhdyBKU09OIGZyb20gZ2ggQ0xJXG4gKiBAcmV0dXJucyBQYXJzZWQgR2l0SHViQ29tbWVudCBhcnJheVxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VHaENvbW1lbnRzSnNvbihqc29uOiBHaENvbW1lbnRKc29uW10pOiBHaXRIdWJDb21tZW50W10ge1xuICByZXR1cm4ganNvbi5tYXAoKGMpID0+ICh7XG4gICAgaWQ6IGMuaWQsXG4gICAgYm9keTogYy5ib2R5LFxuICAgIGF1dGhvcjogYy5hdXRob3IubG9naW4sXG4gICAgY3JlYXRlZEF0OiBjLmNyZWF0ZWRBdCxcbiAgICByZWFjdGlvbnM6IHtcbiAgICAgIHRodW1ic1VwOiBjLnJlYWN0aW9uc1tcIisxXCJdID8/IDAsXG4gICAgICBleWVzOiBjLnJlYWN0aW9ucy5leWVzID8/IDAsXG4gICAgICBjb25mdXNlZDogYy5yZWFjdGlvbnMuY29uZnVzZWQgPz8gMCxcbiAgICB9LFxuICB9KSk7XG59XG5cbi8qKiBJbmplY3Rpb24gcG9pbnRzIGZvciB7QGxpbmsgcnVuR2hDb21tYW5kUmF3fSAoSXNzdWUgIzk2NikuICovXG5leHBvcnQgaW50ZXJmYWNlIEdoQ29tbWFuZFJhd09wdGlvbnMge1xuICAvKipcbiAgICogRGlyZWN0b3J5IHRoZSBzaGFyZWQgcmF0ZS1saW1pdCBzaWduYWwgaXMgd3JpdHRlbiB0byB3aGVuIHRoaXMgY2FsbCBpc1xuICAgKiB0aGUgb25lIHRoYXQgZGlzY292ZXJzIGEgcHJpbWFyeS1HcmFwaFFMLXF1b3RhIG91dGFnZS4gRGVmYXVsdHMgdG8gdGhlXG4gICAqIGBXT1JLX0RJUmAgdGhlIHJ1biBkcml2ZXIgZXhwb3J0czsgYW4gZW1wdHkgc3RyaW5nIHN1cHByZXNzZXMgdGhlXG4gICAqIHdyaXRlLCBleGFjdGx5IGFzIGFuIHVuc2V0IGBXT1JLX0RJUmAgYWx3YXlzIGhhcy5cbiAgICovXG4gIHdvcmtEaXI/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogUnVuIGEgZ2ggQ0xJIGNvbW1hbmQgYW5kIHJldHVybiB0aGUgb3V0cHV0ICh3aXRob3V0IHJldHJ5KS5cbiAqXG4gKiBUaGlzIGlzIHRoZSByYXcgY29tbWFuZCBleGVjdXRpb24uIFVzZSBydW5HaENvbW1hbmQoKSBmb3IgQVBJIGNhbGxzXG4gKiB0aGF0IHNob3VsZCBiZSByZXRyaWVkIG9uIHRyYW5zaWVudCBmYWlsdXJlcy5cbiAqXG4gKiBJc3N1ZSAjMzcwMzogZGVsZWdhdGVzIHRoZSBzcGF3biB0byB0aGUgc2hhcmVkIGNob2tlcG9pbnRcbiAqIChgZ2hfc3Bhd24udHNgKSwgd2hpY2ggZW5mb3JjZXMgdGhlIHdyaXRlLXJlcG8gYWxsb3dsaXN0IGJlZm9yZSB0aGVcbiAqIHByb2Nlc3Mgc3RhcnRzLCBpbmplY3RzIHRoZSBHaXRIdWIgQXBwIHRva2VuIChJc3N1ZSAjOTU5KSBhbmQgam91cm5hbHNcbiAqIHRoZSBtdXRhdGlvbiBhZnRlcndhcmRzLlxuICpcbiAqIEBwYXJhbSBhcmdzIC0gQXJndW1lbnRzIHRvIHBhc3MgdG8gZ2hcbiAqIEBwYXJhbSBvcHRpb25zIC0gV29yay1kaXJlY3Rvcnkgb3ZlcnJpZGUgZm9yIHRoZSBzaGFyZWQgcmF0ZS1saW1pdFxuICogICBzaWduYWwgYSBwcmltYXJ5LXF1b3RhIG91dGFnZSB3cml0ZXMgKElzc3VlICM5NjYpLiBPbWl0dGVkIGluXG4gKiAgIHByb2R1Y3Rpb24sIHdoZXJlIHRoZSBgV09SS19ESVJgIHRoZSBydW4gZHJpdmVyIGV4cG9ydHMgaXMgcmVhZC5cbiAqIEByZXR1cm5zIENvbW1hbmQgb3V0cHV0IGFzIHN0cmluZ1xuICogQHRocm93cyBFcnJvciBpZiBjb21tYW5kIGZhaWxzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5HaENvbW1hbmRSYXcoXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBHaENvbW1hbmRSYXdPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICAvLyBJc3N1ZSAjNDI6IG9uY2UgdGhlIHByaW1hcnkgR3JhcGhRTCBxdW90YSBpcyBleGhhdXN0ZWQsIGV2ZXJ5IGZ1cnRoZXJcbiAgLy8gR3JhcGhRTC1iYWNrZWQgY2FsbCBpbiB0aGUgd2luZG93IGlzIGd1YXJhbnRlZWQgdG8gZmFpbC4gU2hvcnQtY2lyY3VpdFxuICAvLyBpdCBoZXJlIOKAlCBiZWZvcmUgdGhlIHNwYXduLCB0aGUgdGVsZW1ldHJ5IGFuZCB0aGUgcmV0cnkgZGVjaXNpb24g4oCUIHNvIGFcbiAgLy8gc2NhbiB0aGF0IGNhdGNoZXMtYW5kLWNvbnRpbnVlcyBubyBsb25nZXIgZHJpdmVzIGh1bmRyZWRzIG9mIGRvb21lZCBgZ2hgXG4gIC8vIHByb2Nlc3NlcyAoZWFjaCBjb3N0aW5nIGEgc3Bhd24gYW5kIGNvdW50aW5nIHRvd2FyZCB0aGUgc2Vjb25kYXJ5L2FidXNlXG4gIC8vIGxpbWl0KSB1bnRpbCBzb21ldGhpbmcgZmluYWxseSBsZXRzIHRoZSBlcnJvciBlc2NhcGUuIFRoZSBgcmF0ZV9saW1pdGBcbiAgLy8gcmVhZCB0aGF0IGxlYXJucyB0aGUgcmVzZXQgaXMgZXhlbXB0LCBzbyB0aGUgbGF0Y2ggY2FuIHN0aWxsIGxpZnQgaXRzZWxmLlxuICBpZiAoIWlzUXVvdGFFeGVtcHRHaENhbGwoYXJncykgJiYgaXNQcmltYXJ5UXVvdGFMYXRjaGVkKCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IocHJpbWFyeVF1b3RhU2tpcE1lc3NhZ2UoKSk7XG4gIH1cblxuICAvLyBJc3N1ZSAjMTY3MSAvICMxNDg1OiB0aGUgcGVyLWl0ZXJhdGlvbiBgZ2hgIGNhbGwgdGVsZW1ldHJ5IGlzIHJlY29yZGVkXG4gIC8vIGluIGBzcGF3bkdoYCwgdGhlIGNob2tlcG9pbnQgZXZlcnkgYGdoYCBpbnZvY2F0aW9uIHBhc3Nlcywgc28gYSBjYWxsXG4gIC8vIG1hZGUgdGhyb3VnaCB0aGlzIHdyYXBwZXIgYW5kIG9uZSBtYWRlIGRpcmVjdGx5IGFyZSBjb3VudGVkIGFsaWtlLlxuXG4gIC8vIElzc3VlICMzMzExLyMzNzAzOiBlZ3Jlc3MgY29udGFpbm1lbnQgbGl2ZXMgaW4gdGhlIHNoYXJlZCBjaG9rZXBvaW50IOKAlFxuICAvLyBgc3Bhd25HaGAgcmVmdXNlcyBhbiBvZmYtYWxsb3dsaXN0IChvciB1bmRldGVybWluYWJsZSkgd3JpdGUgQkVGT1JFIHRoZVxuICAvLyBjb21tYW5kIHJlYWNoZXMgR2l0SHViLCB0aGVuIGpvdXJuYWxzIHRoZSBtdXRhdGlvbiAoSXNzdWUgIzIzODApLlxuICAvL1xuICAvLyBJc3N1ZSAjNDIgLyAjMTU0MDogdGhlIGZpcnN0IGxpdmUgY2FsbCB0byByZXBvcnQgYSBHcmFwaFFMIHJhdGUtbGltaXRcbiAgLy8gcmVmdXNhbCBsYXRjaGVzIHRoZSBwcm9jZXNzIGFuZCB3cml0ZXMgdGhlIHNoYXJlZCBzaWduYWwgdGhhdCBkcml2ZXMgdGhlXG4gIC8vIElzc3VlICMxNzgwIG1pZC1jeWNsZSBwYXVzZS4gQSBwcmltYXJ5IHJlZnVzYWwgcHJvYmVzIGl0cyByZXNldDsgYSBiYXJlXG4gIC8vIEdyYXBoUUwgRm9yYmlkZGVuIGdldHMgdGhlIHNlY29uZGFyeSBjb29sLWRvd24uIFRoYXQgdXNlZCB0byBoYXBwZW4gaW4gdGhpcyBmdW5jdGlvbidzXG4gIC8vIGNhdGNoIGFsb25lOyBpdCBub3cgaGFwcGVucyBpbiBgc3Bhd25HaGAgZm9yIGV2ZXJ5IGNhbGxlciwgdGhyb3VnaCB0aGVcbiAgLy8gaG9vayByZWdpc3RlcmVkIGJlbG93IOKAlCB0aGlzIHdyYXBwZXIgb25seSB0aHJlYWRzIGl0cyBzaWduYWwgZGlyZWN0b3J5XG4gIC8vIHRocm91Z2guXG4gIHJldHVybiBhd2FpdCBydW5HaE9yVGhyb3coXG4gICAgYXJncyxcbiAgICBvcHRpb25zLndvcmtEaXIgIT09IHVuZGVmaW5lZCA/IHsgd29ya0Rpcjogb3B0aW9ucy53b3JrRGlyIH0gOiB7fSxcbiAgKTtcbn1cblxuLy8gSXNzdWUgIzE1NDA6IHRoZSBjaG9rZXBvaW50IHNlZXMgZXZlcnkgcmVmdXNhbDsgdGhpcyBtb2R1bGUga25vd3Mgd2hhdCB0b1xuLy8gZG8gYWJvdXQgR3JhcGhRTCByYXRlLWxpbWl0IHJlZnVzYWxzLiBSZWdpc3RlcmVkIGF0IGxvYWQsIHNvIGFueSBwcm9jZXNzXG4vLyB1c2luZyBgZ2hgIHRocm91Z2ggYGdpdGh1Yi50c2AgbGF0Y2hlcyB3aGljaGV2ZXIgbW9kdWxlIHNhdyBpdCBmaXJzdC5cbnNldFByaW1hcnlRdW90YUV4aGF1c3Rpb25Ib29rKCh7IHdvcmtEaXIsIHN0ZGVyciB9KSA9PlxuICBub3RlUHJpbWFyeVF1b3RhRXhoYXVzdGlvbihzdGRlcnIsIHdvcmtEaXIpXG4pO1xuXG4vKiogVHJ1ZSB3aGlsZSBhIHNpbmdsZSBwcmltYXJ5LXF1b3RhIGV4aGF1c3Rpb24gaXMgYmVpbmcgcmVjb3JkZWQuICovXG5sZXQgcXVvdGFFeGhhdXN0aW9uTm90ZUluRmxpZ2h0ID0gZmFsc2U7XG5cbi8qKlxuICogUG9pbnRzIHRoZSBhY2NvdW50IG11c3Qgc3RpbGwgaG9sZCBmb3IgYSBcInJhdGUgbGltaXQgYWxyZWFkeSBleGNlZWRlZFwiXG4gKiBhbnN3ZXIgdG8gYmUgcmVhZCBhcyBhIHNlY29uZGFyeSAoYnVyc3QpIGxpbWl0IHJhdGhlciB0aGFuIHRoZSBob3VybHlcbiAqIHF1b3RhIChJc3N1ZSAjMTQ1NikuIEdpdEh1YidzIG93biB3b3JkaW5nIGlzIHRoZSBzYW1lIGZvciBib3RoOyB0aGVcbiAqIGJhbGFuY2UgaXMgbm90LiBPYnNlcnZlZDogdGhlIHJlZnVzYWwgYXJyaXZlZCB3aXRoIDQsNzAwIG9mIDUsMDAwIHBvaW50c1xuICogdW50b3VjaGVkLlxuICovXG5leHBvcnQgY29uc3QgU0VDT05EQVJZX0xJTUlUX01JTl9SRU1BSU5JTkcgPSAxMDA7XG5cbi8qKlxuICogSG93IGxvbmcgR3JhcGhRTC1iYWNrZWQgY2FsbHMgcGF1c2UgYWZ0ZXIgYSBzZWNvbmRhcnkgbGltaXQuIEdpdEh1YidzXG4gKiBndWlkYW5jZSBpcyBcImF0IGxlYXN0IG9uZSBtaW51dGVcIiB3aGVuIG5vIGByZXRyeS1hZnRlcmAgaXMgc2VudC5cbiAqL1xuZXhwb3J0IGNvbnN0IFNFQ09OREFSWV9MSU1JVF9CQUNLT0ZGX1NFQ09ORFMgPSA2MDtcblxuLyoqXG4gKiBSZWNvcmQgYSBHcmFwaFFMIHJhdGUtbGltaXQgcmVmdXNhbCAoSXNzdWUgIzQyKS5cbiAqXG4gKiBSZWFkcyB0aGUgcmVzZXQgZnJvbSB0aGUgZnJlZSBHcmFwaFFMIHF1b3RhIHByb2JlIGZvciBhIHByaW1hcnktcXVvdGFcbiAqIHJlZnVzYWwgKGJ5cGFzc2luZyB0aGUgY2hva2Vwb2ludCBzbyBpdCBuZWl0aGVyIHJlY29yZHMgdGVsZW1ldHJ5IG5vclxuICogcmVjdXJzZXMpLCBvciBsYXRjaGVzIGJyaWVmbHkgZm9yIGEgc2Vjb25kYXJ5IHJlZnVzYWwuIEJvdGggd3JpdGUgdGhlXG4gKiBzaGFyZWQgcmF0ZS1saW1pdCBzaWduYWwgc28gc2libGluZyB3b3JrZXJzIGFuZCB0aGUgSXNzdWUgIzE3ODAgcGF1c2VcbiAqIG9ic2VydmUgdGhlIGNvbmRpdGlvbi4gSWRlbXBvdGVudCBhbmRcbiAqIGNoZWFwOiBvbmNlIHRoZSBsYXRjaCBpcyBzZXQsIGV2ZXJ5IGxhdGVyIGNhbGwgc2hvcnQtY2lyY3VpdHMgYmVmb3JlXG4gKiByZWFjaGluZyB0aGlzIHBhdGgsIGFuZCBhIGNvbmN1cnJlbnQgZmlyc3QgZGV0ZWN0aW9uIGlzIGNvYWxlc2NlZC5cbiAqXG4gKiBAcGFyYW0gd29ya0Rpck92ZXJyaWRlIC0gV2hlcmUgdGhlIHNpZ25hbCBpcyB3cml0dGVuLiBEZWZhdWx0cyB0byB0aGVcbiAqICAgYFdPUktfRElSYCB0aGUgcnVuIGRyaXZlciBleHBvcnRzIChJc3N1ZSAjOTY2KS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbm90ZVByaW1hcnlRdW90YUV4aGF1c3Rpb24oXG4gIHJlZnVzYWxNZXNzYWdlOiBzdHJpbmcsXG4gIHdvcmtEaXJPdmVycmlkZT86IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBpZiAocXVvdGFFeGhhdXN0aW9uTm90ZUluRmxpZ2h0IHx8IGlzUHJpbWFyeVF1b3RhTGF0Y2hlZCgpKSByZXR1cm47XG4gIHF1b3RhRXhoYXVzdGlvbk5vdGVJbkZsaWdodCA9IHRydWU7XG4gIHRyeSB7XG4gICAgY29uc3Qgbm93ID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCk7XG4gICAgY29uc3Qgd29ya0RpciA9IHdvcmtEaXJPdmVycmlkZSA/P1xuICAgICAgRGVuby5lbnYuZ2V0KFwiVklCRV9HSVRIVUJfUVVPVEFfV09SS19ESVJcIikgPz8gRGVuby5lbnYuZ2V0KFwiV09SS19ESVJcIik7XG4gICAgLy8gQSBiYXJlIEZvcmJpZGRlbiBmcm9tIEdyYXBoUUwgaGFzIG5vIHF1b3RhIGhlYWRlcnMgdG8gZGlzdGluZ3Vpc2ggYVxuICAgIC8vIGJ1cnN0IHJlZnVzYWwgZnJvbSB0aGUgaG91cmx5IGJ1ZGdldC4gUGFyayBmb3IgdGhlIHNob3J0IGNvb2wtZG93biBhbmRcbiAgICAvLyBwdWJsaXNoIHRoZSBzYW1lIHNoYXJlZCBwYXVzZSBzaWduYWwgdXNlZCBieSB0aGUgcHJpbWFyeSBwYXRoLlxuICAgIGlmIChcbiAgICAgIGlzU2Vjb25kYXJ5T25seVJhdGVMaW1pdE1lc3NhZ2UoXG4gICAgICAgIHJlZnVzYWxNZXNzYWdlLFxuICAgICAgICBpc1ByaW1hcnlSYXRlTGltaXRNZXNzYWdlLFxuICAgICAgKVxuICAgICkge1xuICAgICAgYXdhaXQgbm90ZVNlY29uZGFyeUxpbWl0Q29vbGRvd24obm93LCB3b3JrRGlyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcHJvYmUgPSBhd2FpdCBwcm9iZUdyYXBocWxRdW90YSgpO1xuXG4gICAgLy8gVGhlIHF1b3RhIHByb2JlIGl0c2VsZiBjYW4gcmVjZWl2ZSB0aGUgc2FtZSBiYXJlIEdyYXBoUUwgRm9yYmlkZGVuLlxuICAgIC8vIFRoYXQgaXMgZXZpZGVuY2Ugb2YgdGhlIHNlY29uZGFyeSBsaW1pdCwgbm90IGEgcmVhc29uIHRvIGFzc3VtZSB0aGVcbiAgICAvLyBwcmltYXJ5IHF1b3RhIGlzIGV4aGF1c3RlZCBmb3IgYW4gaG91ci5cbiAgICBpZiAoXG4gICAgICAhcHJvYmUub2sgJiYgaXNTZWNvbmRhcnlPbmx5UmF0ZUxpbWl0TWVzc2FnZShcbiAgICAgICAgcHJvYmUuZXJyb3IubWVzc2FnZSxcbiAgICAgICAgaXNQcmltYXJ5UmF0ZUxpbWl0TWVzc2FnZSxcbiAgICAgIClcbiAgICApIHtcbiAgICAgIGF3YWl0IG5vdGVTZWNvbmRhcnlMaW1pdENvb2xkb3duKG5vdywgd29ya0Rpcik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gR2l0SHViIHNheXMgXCJBUEkgcmF0ZSBsaW1pdCBhbHJlYWR5IGV4Y2VlZGVkXCIgZm9yIHR3byBkaWZmZXJlbnRcbiAgICAvLyB0aGluZ3M6IHRoZSBob3VybHkgcHJpbWFyeSBxdW90YSBiZWluZyBzcGVudCwgYW5kIGEgc2Vjb25kYXJ5IGxpbWl0XG4gICAgLy8gdHJpcHBlZCBieSBhIGJ1cnN0IChwb2ludHMgcGVyIG1pbnV0ZSwgY29uY3VycmVudCByZXF1ZXN0cywgQ1BVXG4gICAgLy8gdGltZSkuIFRoZSBhY2NvdW50J3MgYmFsYW5jZSB0ZWxscyB0aGVtIGFwYXJ0LiBBIGJ1cnN0IHJlZnVzYWwgd2l0aFxuICAgIC8vIG1vc3Qgb2YgdGhlIGhvdXIncyBwb2ludHMgdW50b3VjaGVkIHVzZWQgdG8gbGF0Y2ggdGhlIHByb2Nlc3MgdW50aWxcbiAgICAvLyB0aGUgaG91cmx5IHJlc2V0IOKAlCB1cCB0byBhbiBob3VyIG9mIGlkbGluZyBmb3IgYSBvbmUtbWludXRlXG4gICAgLy8gY29vbC1kb3duLCBldmVyeSBob3VyIHRoZSBmbGVldCdzIGN5Y2xlcyBoYXBwZW5lZCB0byBjb2xsaWRlXG4gICAgLy8gKElzc3VlICMxNDU2KS5cbiAgICBpZiAoXG4gICAgICBwcm9iZS5vayAmJiBwcm9iZS52YWx1ZS5yZW1haW5pbmcgPj0gU0VDT05EQVJZX0xJTUlUX01JTl9SRU1BSU5JTkdcbiAgICApIHtcbiAgICAgIGNvbnN0IHdhaXRTZWNvbmRzID0gTWF0aC5tYXgoXG4gICAgICAgIFNFQ09OREFSWV9MSU1JVF9CQUNLT0ZGX1NFQ09ORFMsXG4gICAgICAgIHByb2JlLnZhbHVlLnJldHJ5QWZ0ZXJTZWNvbmRzID8/IDAsXG4gICAgICApO1xuICAgICAgbGF0Y2hQcmltYXJ5UXVvdGEobm93ICsgd2FpdFNlY29uZHMsIG5vdywgXCJzZWNvbmRhcnlcIik7XG4gICAgICBpZiAod29ya0Rpcikge1xuICAgICAgICBhd2FpdCB3cml0ZVJhdGVMaW1pdFNpZ25hbCh3b3JrRGlyLCB3YWl0U2Vjb25kcywgdW5kZWZpbmVkLCBcImdpdGh1YlwiKTtcbiAgICAgIH1cbiAgICAgIGRlZmF1bHRMb2dnZXIud2FybihcbiAgICAgICAgYEdpdEh1YiByZWZ1c2VkIGEgR3JhcGhRTCBjYWxsIGFzIHJhdGUtbGltaXRlZCB3aGlsZSB0aGUgYWNjb3VudCBgICtcbiAgICAgICAgICBgc3RpbGwgaG9sZHMgJHtwcm9iZS52YWx1ZS5yZW1haW5pbmd9LyR7cHJvYmUudmFsdWUubGltaXR9IHBvaW50cyDigJQgYCArXG4gICAgICAgICAgYGEgc2Vjb25kYXJ5IChidXJzdCkgbGltaXQsIG5vdCB0aGUgaG91cmx5IHF1b3RhLiBQYXVzaW5nIGAgK1xuICAgICAgICAgIGBHcmFwaFFMLWJhY2tlZCBnaCBjYWxscyBmb3IgJHt3YWl0U2Vjb25kc31zLmAsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIElzc3VlICMxODg4OiBhIHJlZnVzYWwgdGhhdCBsYW5kcyBvbiB0aGUgd2luZG93IGJvdW5kYXJ5LiBUaGUgcHJvYmVcbiAgICAvLyBzdGlsbCByZXBvcnRzIHRoZSB3aW5kb3cgdGhhdCBqdXN0IGNsb3NlZCDigJQgYHJlbWFpbmluZ2Agc3BlbnQsIGByZXNldGBcbiAgICAvLyBhbHJlYWR5IGJlaGluZCB1cyDigJQgYW5kIHJlYWRpbmcgdGhlIHJlc2V0IGZyb20gYGdoIGFwaSByYXRlX2xpbWl0YFxuICAgIC8vIGluc3RlYWQgd291bGQgbmFtZSB0aGUgTkVXIHdpbmRvdydzLCBhbiBob3VyIG91dC4gVGhlIDA0OjQ3WiBydW4gb2ZcbiAgICAvLyAyMDI2LTA5LTEwIGxhdGNoZWQgZXhhY3RseSB0aGF0IHdheSBhbmQgc2F0IG91dCBhIGZ1bGwgaG91ciB3aXRoXG4gICAgLy8gdXNlZD0wLzUwMDAuIEEgY2xvc2VkIHdpbmRvdydzIGV4aGF1c3Rpb24gaGFzIGxpZnRlZDogaG9sZCB0aGUgc2hvcnRcbiAgICAvLyBjb29sLWRvd24gYW5kIGxldCB0aGUgbmV4dCBjYWxsIHJlLXByb2JlLlxuICAgIGlmIChwcm9iZS5vayAmJiBwcm9iZS52YWx1ZS5yZXNldCA8PSBub3cpIHtcbiAgICAgIGNvbnN0IHdhaXRTZWNvbmRzID0gU0VDT05EQVJZX0xJTUlUX0JBQ0tPRkZfU0VDT05EUztcbiAgICAgIGxhdGNoUHJpbWFyeVF1b3RhKG5vdyArIHdhaXRTZWNvbmRzLCBub3csIFwic2Vjb25kYXJ5XCIpO1xuICAgICAgaWYgKHdvcmtEaXIpIHtcbiAgICAgICAgYXdhaXQgd3JpdGVSYXRlTGltaXRTaWduYWwod29ya0Rpciwgd2FpdFNlY29uZHMsIHVuZGVmaW5lZCwgXCJnaXRodWJcIik7XG4gICAgICB9XG4gICAgICBkZWZhdWx0TG9nZ2VyLndhcm4oXG4gICAgICAgIGBHaXRIdWIgcmVmdXNlZCBhIEdyYXBoUUwgY2FsbCBhcyByYXRlLWxpbWl0ZWQgZm9yIGEgd2luZG93IHRoYXQgYCArXG4gICAgICAgICAgYGhhcyBhbHJlYWR5IGNsb3NlZCAocmVzZXQgJHtcbiAgICAgICAgICAgIGZvcm1hdFJhdGVMaW1pdFJlc2V0KHByb2JlLnZhbHVlLnJlc2V0LCBub3cpXG4gICAgICAgICAgfSkg4oCUIGEgYm91bmRhcnkgcmVmdXNhbCwgbm90IHRoZSBuZXcgaG91cidzIHF1b3RhLiBQYXVzaW5nIGAgK1xuICAgICAgICAgIGBHcmFwaFFMLWJhY2tlZCBnaCBjYWxscyBmb3IgJHt3YWl0U2Vjb25kc31zLCB0aGVuIHJlLXByb2JpbmcgYCArXG4gICAgICAgICAgYChJc3N1ZSAjMTg4OCkuYCxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcmVzZXRFcG9jaCA9IHByb2JlLm9rICYmIHByb2JlLnZhbHVlLnJlc2V0ID4gbm93XG4gICAgICA/IHByb2JlLnZhbHVlLnJlc2V0XG4gICAgICA6IGF3YWl0IHJlYWRHcmFwaHFsUmVzZXRFcG9jaChub3cpO1xuICAgIGxhdGNoUHJpbWFyeVF1b3RhKHJlc2V0RXBvY2gsIG5vdyk7XG4gICAgY29uc3Qgd2FpdFNlY29uZHMgPSBNYXRoLm1heCgwLCByZXNldEVwb2NoIC0gbm93KTtcbiAgICBpZiAod29ya0Rpcikge1xuICAgICAgYXdhaXQgd3JpdGVSYXRlTGltaXRTaWduYWwod29ya0Rpciwgd2FpdFNlY29uZHMsIHVuZGVmaW5lZCwgXCJnaXRodWJcIik7XG4gICAgfVxuICAgIGRlZmF1bHRMb2dnZXIud2FybihcbiAgICAgIGBQcmltYXJ5IEdyYXBoUUwgcXVvdGEgZXhoYXVzdGVkIOKAlCBsYXRjaGluZyBhbGwgR3JhcGhRTC1iYWNrZWQgZ2ggYCArXG4gICAgICAgIGBjYWxscyB1bnRpbCByZXNldCAke2Zvcm1hdFJhdGVMaW1pdFJlc2V0KHJlc2V0RXBvY2gsIG5vdyl9YCxcbiAgICApO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBOZXZlciBsZXQgYm9va2tlZXBpbmcgbWFzayB0aGUgb3JpZ2luYWwgZmFpbHVyZSDigJQgdGhlIGxhdGNoIGlzIGFcbiAgICAvLyBiZXN0LWVmZm9ydCBvcHRpbWlzYXRpb247IHRoZSBjYWxsZXIgc3RpbGwgc2VlcyBpdHMgb3duIGVycm9yLlxuICAgIGRlZmF1bHRMb2dnZXIud2FybihcbiAgICAgIGBGYWlsZWQgdG8gcmVjb3JkIHByaW1hcnktcXVvdGEgZXhoYXVzdGlvbjogJHtcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICB9YCxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIHF1b3RhRXhoYXVzdGlvbk5vdGVJbkZsaWdodCA9IGZhbHNlO1xuICB9XG59XG5cbi8qKiBMYXRjaCB0aGUgc2hvcnQgc2Vjb25kYXJ5IGNvb2wtZG93biBhbmQgd3JpdGUgdGhlIHNoYXJlZCBwYXVzZSBzaWduYWwuICovXG5hc3luYyBmdW5jdGlvbiBub3RlU2Vjb25kYXJ5TGltaXRDb29sZG93bihcbiAgbm93OiBudW1iZXIsXG4gIHdvcmtEaXI6IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB3YWl0U2Vjb25kcyA9IFNFQ09OREFSWV9MSU1JVF9CQUNLT0ZGX1NFQ09ORFM7XG4gIGxhdGNoUHJpbWFyeVF1b3RhKG5vdyArIHdhaXRTZWNvbmRzLCBub3csIFwic2Vjb25kYXJ5XCIpO1xuICBpZiAod29ya0Rpcikge1xuICAgIGF3YWl0IHdyaXRlUmF0ZUxpbWl0U2lnbmFsKHdvcmtEaXIsIHdhaXRTZWNvbmRzLCB1bmRlZmluZWQsIFwiZ2l0aHViXCIpO1xuICB9XG4gIGRlZmF1bHRMb2dnZXIud2FybihcbiAgICBgR2l0SHViIHJlZnVzZWQgYSBHcmFwaFFMIGNhbGwgdW5kZXIgdGhlIHNlY29uZGFyeSByYXRlIGxpbWl0LiBQYXVzaW5nIGAgK1xuICAgICAgYEdyYXBoUUwtYmFja2VkIGdoIGNhbGxzIGZvciAke3dhaXRTZWNvbmRzfXMuYCxcbiAgKTtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBHcmFwaFFMIHJlc2V0IGVwb2NoLCBmYWxsaW5nIGJhY2sgdG8gb25lIGhvdXIgZnJvbSBub3cgd2hlblxuICogbm90aGluZyBjYW4gYmUgbGVhcm50IChhIGNvbnNlcnZhdGl2ZSB3aW5kb3cgdGhlIGxhdGNoIGF1dG8tbGlmdHMgZnJvbSB0aGVcbiAqIG1vbWVudCB0aGUgcmVhbCBxdW90YSByZXR1cm5zKS5cbiAqXG4gKiBUaGUgZnJlZSBHcmFwaFFMIHByb2JlIGlzIGFza2VkIGZpcnN0OiBpdHMgcmVzcG9uc2UgaGVhZGVycyBhcmUgdGhlXG4gKiBidWNrZXQncyBvd24gYWNjb3VudGluZyBhbmQgYXJlIHN0aWxsIHNlbnQgb25jZSB0aGUgcXVvdGEgaXMgZ29uZS5cbiAqIGBnaCBhcGkgcmF0ZV9saW1pdGAgaXMgb25seSBhIGxhc3QgcmVzb3J0IOKAlCBpdCBoYXMgYmVlbiBvYnNlcnZlZCByZXBvcnRpbmdcbiAqIHRoZSBHcmFwaFFMIGJ1Y2tldCBhcyB1bnRvdWNoZWQsIHdpdGggYSByZXNldCBleGFjdGx5IG9uZSBob3VyIG91dCwgd2hpbGVcbiAqIHRoZSBoZWFkZXJzIHNhaWQgb3RoZXJ3aXNlLCB3aGljaCBpcyB3aGF0IGxhdGNoZWQgdGhlIHdvcmtlciBmb3IgYSBmbGF0XG4gKiBob3VyIG9uIGV2ZXJ5IGV4aGF1c3Rpb24gKElzc3VlICMxNDU2KS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVhZEdyYXBocWxSZXNldEVwb2NoKG5vdzogbnVtYmVyKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcHJvYmUgPSBhd2FpdCBwcm9iZUdyYXBocWxRdW90YSgpO1xuICBpZiAocHJvYmUub2sgJiYgcHJvYmUudmFsdWUucmVzZXQgPiBub3cpIHtcbiAgICByZXR1cm4gcHJvYmUudmFsdWUucmVzZXQ7XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSBhd2FpdCBydW5HaE9yVGhyb3coW1wiYXBpXCIsIFwicmF0ZV9saW1pdFwiXSk7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpIGFzIHtcbiAgICAgIHJlc291cmNlcz86IHtcbiAgICAgICAgZ3JhcGhxbD86IHsgcmVzZXQ/OiBudW1iZXIgfTtcbiAgICAgICAgY29yZT86IHsgcmVzZXQ/OiBudW1iZXIgfTtcbiAgICAgIH07XG4gICAgfTtcbiAgICBjb25zdCByZXNldCA9IHBhcnNlZC5yZXNvdXJjZXM/LmdyYXBocWw/LnJlc2V0ID8/XG4gICAgICBwYXJzZWQucmVzb3VyY2VzPy5jb3JlPy5yZXNldDtcbiAgICBpZiAodHlwZW9mIHJlc2V0ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShyZXNldCkgJiYgcmVzZXQgPiBub3cpIHtcbiAgICAgIHJldHVybiByZXNldDtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIEZhbGwgdGhyb3VnaCB0byB0aGUgY29uc2VydmF0aXZlIGRlZmF1bHQuXG4gIH1cbiAgcmV0dXJuIG5vdyArIDM2MDA7XG59XG5cbi8qKlxuICogUnVuIGEgZ2ggQ0xJIGNvbW1hbmQgd2l0aCBhdXRvbWF0aWMgcmV0cnkgZm9yIHRyYW5zaWVudCBmYWlsdXJlcy5cbiAqXG4gKiBXcmFwcyBydW5HaENvbW1hbmRSYXcgd2l0aCBleHBvbmVudGlhbCBiYWNrb2ZmIHJldHJ5IGxvZ2ljLlxuICogVHJhbnNpZW50IGVycm9ycyAoNXh4LCByYXRlIGxpbWl0cywgbmV0d29yaykgYXJlIHJldHJpZWQ7XG4gKiBwZXJtYW5lbnQgZXJyb3JzICg0eHgsIGF1dGgpIGZhaWwgaW1tZWRpYXRlbHkuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBBcmd1bWVudHMgdG8gcGFzcyB0byBnaFxuICogQHJldHVybnMgQ29tbWFuZCBvdXRwdXQgYXMgc3RyaW5nXG4gKiBAdGhyb3dzIEVycm9yIGlmIGNvbW1hbmQgZmFpbHMgcGVybWFuZW50bHkgb3IgYWZ0ZXIgYWxsIHJldHJpZXMgZXhoYXVzdGVkXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5HaENvbW1hbmQoYXJnczogc3RyaW5nW10pOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gYXdhaXQgcmV0cnlXaXRoQmFja29mZihcbiAgICAoKSA9PiBydW5HaENvbW1hbmRSYXcoYXJncyksXG4gICk7XG59XG5cbi8qKlxuICogRGV0ZXJtaW5lIHdoZXRoZXIgYSBjb21tZW50IGJvZHkgaGFzIGFueSB2aXNpYmxlIGNvbnRlbnQuXG4gKlxuICogUmV0dXJucyBmYWxzZSBmb3IgYm9kaWVzIHRoYXQgYXJlIGVtcHR5LCB3aGl0ZXNwYWNlLW9ubHksIG9yIGNvbnRhaW4gb25seVxuICogSFRNTCBjb21tZW50cyAoZS5nLiBgPCEtLSBDTEFJTV9MT0NLOmZvbyAtLT5gKS4gU3VjaCBib2RpZXMgcmVuZGVyIGFzXG4gKiBjb21wbGV0ZWx5IGJsYW5rIGNvbW1lbnRzIG9uIEdpdEh1Yiwgd2hpY2ggaXMgY29uZnVzaW5nIHRvIGh1bWFuIHJlYWRlcnNcbiAqIOKAlCBzZWUgSXNzdWUgIzE2NTkuXG4gKlxuICogQHBhcmFtIGJvZHkgLSBUaGUgY2FuZGlkYXRlIGNvbW1lbnQgYm9keVxuICogQHJldHVybnMgdHJ1ZSBpZiB0aGUgYm9keSBoYXMgYXQgbGVhc3Qgb25lIG5vbi13aGl0ZXNwYWNlLCBub24tY29tbWVudCBjaGFyYWN0ZXJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc1Zpc2libGVDb250ZW50KGJvZHk6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAodHlwZW9mIGJvZHkgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgLy8gV2FsayB0aGUgYm9keSBjb21tZW50IGJ5IGNvbW1lbnQgcmF0aGVyIHRoYW4gc3RyaXBwaW5nIGNvbW1lbnRzIHdpdGggYVxuICAvLyByZXBsYWNlOiBhIHNpbmdsZSByZXBsYWNlIGNhbiByZS1mb3JtIGEgY29tbWVudCBmcm9tIHdoYXQgaXQgbGVhdmVzXG4gIC8vIGJlaGluZCAoQ29kZVFMIGpzL2luY29tcGxldGUtbXVsdGktY2hhcmFjdGVyLXNhbml0aXphdGlvbikuIEFuIHVuY2xvc2VkXG4gIC8vIGA8IS0tYCBoaWRlcyB0aGUgcmVzdCBvZiB0aGUgYm9keSBvbiBHaXRIdWIsIGFuZCBgLS0hPmAgY2xvc2VzIGEgY29tbWVudFxuICAvLyBhcyB3ZWxsIGFzIGAtLT5gLlxuICBsZXQgcmVzdCA9IGJvZHk7XG4gIGZvciAoOzspIHtcbiAgICBjb25zdCBvcGVuID0gcmVzdC5pbmRleE9mKFwiPCEtLVwiKTtcbiAgICBpZiAob3BlbiA9PT0gLTEpIHJldHVybiByZXN0LnRyaW0oKS5sZW5ndGggPiAwO1xuICAgIGlmIChyZXN0LnNsaWNlKDAsIG9wZW4pLnRyaW0oKS5sZW5ndGggPiAwKSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCBjbG9zZSA9IC8tLSE/Pi8uZXhlYyhyZXN0LnNsaWNlKG9wZW4gKyA0KSk7XG4gICAgaWYgKGNsb3NlID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgcmVzdCA9IHJlc3Quc2xpY2Uob3BlbiArIDQgKyBjbG9zZS5pbmRleCArIGNsb3NlWzBdLmxlbmd0aCk7XG4gIH1cbn1cblxuLyoqXG4gKiBEZXRlcm1pbmUgaWYgYW4gZXJyb3IgbWVzc2FnZSBpbmRpY2F0ZXMgYSBcImxhYmVsIG5vdCBmb3VuZFwiIGNvbmRpdGlvbi5cbiAqXG4gKiBPbmx5IHRoaXMgc3BlY2lmaWMgZXJyb3Igc2hvdWxkIGJlIHNpbGVudGx5IGlnbm9yZWQgYnkgcmVtb3ZlTGFiZWwuXG4gKiBOZXR3b3JrIGVycm9ycywgYXV0aGVudGljYXRpb24gZmFpbHVyZXMsIGV0Yy4gc2hvdWxkIHByb3BhZ2F0ZS5cbiAqXG4gKiBAcGFyYW0gZXJyb3JNZXNzYWdlIC0gVGhlIGVycm9yIG1lc3NhZ2UgdG8gY2hlY2tcbiAqIEByZXR1cm5zIHRydWUgaWYgdGhlIGVycm9yIGlzIHNwZWNpZmljYWxseSBhYm91dCBhIG1pc3NpbmcgbGFiZWxcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzTGFiZWxOb3RGb3VuZEVycm9yKGVycm9yTWVzc2FnZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghZXJyb3JNZXNzYWdlKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGxvd2VyID0gZXJyb3JNZXNzYWdlLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBsb3dlci5pbmNsdWRlcyhcImxhYmVsXCIpICYmIGxvd2VyLmluY2x1ZGVzKFwibm90IGZvdW5kXCIpO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYGxhYmVsYCBpcyByZXNlcnZlZCwgdHJlYXRpbmcgdGhlIG9wZXJhdG9yJ3MgY29uZmlndXJlZFxuICogYGN1c3RvbV9sYWJlbF9wcm9tcHRzYCBsYWJlbHMgYXMgcmVzZXJ2ZWQgdG9vIChJc3N1ZSAjODQ3LCBwYXJ0IG9mICM4NDMpLlxuICpcbiAqIEEgY3VzdG9tIGxhYmVsIGRpc3BhdGNoZXMgYSBwcml2aWxlZ2VkIGF1dG9tYXRpb24gcGhhc2UsIHNvIHRoZSB3b3JrZXIgbXVzdFxuICogbmV2ZXIgc2VsZi1hcHBseSBvbmUg4oCUIHRoZSBzYW1lIHJ1bGUgYFJFU0VSVkVEX0xBQkVMU2AgZW5jb2RlcyBmb3IgYHBsYW5uaW5nYFxuICogYW5kIGZyaWVuZHMuIFRoZSBjdXN0b20gc2V0IGlzIGNvbmZpZy1kcml2ZW4sIHNvIGl0IGlzIHBhc3NlZCBpbiByYXRoZXIgdGhhblxuICogYmFrZWQgaW50byB0aGUgc3RhdGljIGNvbnN0YW50LiBDb21wYXJpc29uIGlzIGNhc2UtaW5zZW5zaXRpdmUsIG1hdGNoaW5nXG4gKiBgaXNSZXNlcnZlZExhYmVsYC5cbiAqL1xuZnVuY3Rpb24gaXNSZXNlcnZlZE9yQ3VzdG9tTGFiZWwoXG4gIGxhYmVsOiBzdHJpbmcsXG4gIGV4dHJhUmVzZXJ2ZWQ6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogYm9vbGVhbiB7XG4gIGlmIChpc1Jlc2VydmVkTGFiZWwobGFiZWwpKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgbG93ZXIgPSBsYWJlbC50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gZXh0cmFSZXNlcnZlZC5zb21lKChleHRyYSkgPT4gZXh0cmEudG9Mb3dlckNhc2UoKSA9PT0gbG93ZXIpO1xufVxuXG4vKipcbiAqIEZpbHRlciBvdXQgcmVzZXJ2ZWQgbGFiZWxzIHRoYXQgbXVzdCBub3QgYmUgYXBwbGllZCB3aGVuIGNyZWF0aW5nIGlzc3Vlcy5cbiAqXG4gKiBSZXNlcnZlZCBsYWJlbHMgYXJlIHVzZWQgYnkgdGhlIHdvcmtlciBmb3Igb3BlcmF0aW9uYWwgcHVycG9zZXMgKGlzc3VlXG4gKiBkaXNjb3ZlcnksIHByaW9yaXRpc2F0aW9uLCBmYWlsdXJlIHRyYWNraW5nLCB3b3JrZmxvdyBzdGF0ZSkuIE9ubHkgdGhlXG4gKiByZXBvc2l0b3J5IG93bmVyIHNob3VsZCBhcHBseSB0aGVzZSBsYWJlbHMuXG4gKlxuICogSXNzdWUgIzI5NzogUHJldmVudCB0aGUgdmliZSBjb2RlciBmcm9tIGxhYmVsbGluZyBjcmVhdGVkIGlzc3VlcyB3aXRoXG4gKiBzcGVjaWFsIG9wZXJhdGlvbmFsIGxhYmVscy5cbiAqXG4gKiBAcGFyYW0gbGFiZWxzIC0gTGFiZWxzIHRvIGZpbHRlclxuICogQHBhcmFtIGV4dHJhUmVzZXJ2ZWQgLSBDb25maWd1cmVkIGBjdXN0b21fbGFiZWxfcHJvbXB0c2AgbGFiZWxzLCByZXNlcnZlZCBmb3JcbiAqICAgdGhlIHNhbWUgcmVhc29uIChJc3N1ZSAjODQ3KS4gRGVmYXVsdHMgdG8gYFtdYCDigJQgbm8gY29uZmlndXJlZCBtYXBwaW5ncyxcbiAqICAgbm8gYmVoYXZpb3VyIGNoYW5nZS5cbiAqIEByZXR1cm5zIExhYmVscyB3aXRoIHJlc2VydmVkIGxhYmVscyByZW1vdmVkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWx0ZXJSZXNlcnZlZExhYmVscyhcbiAgbGFiZWxzOiBzdHJpbmdbXSxcbiAgZXh0cmFSZXNlcnZlZDogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHN0cmluZ1tdIHtcbiAgLy8gSXNzdWUgIzMwODg6IGNvbXBhcmUgY2FzZS1pbnNlbnNpdGl2ZWx5IHNvIGEgbm9uLWxvd2VyLWNhc2UgY2Fub25pY2FsXG4gIC8vIGxhYmVsIChlLmcuIGBQbGFubmluZ2ApIGlzIHN0aWxsIHN0cmlwcGVkLlxuICByZXR1cm4gbGFiZWxzLmZpbHRlcigobGFiZWwpID0+XG4gICAgIWlzUmVzZXJ2ZWRPckN1c3RvbUxhYmVsKGxhYmVsLCBleHRyYVJlc2VydmVkKVxuICApO1xufVxuXG4vKipcbiAqIENyZWF0aW9uLXRpbWUgdmFyaWFudCBvZiB7QGxpbmsgZmlsdGVyUmVzZXJ2ZWRMYWJlbHN9IHRoYXQgbG9ncyBhIFdBUk5JTkdcbiAqIGZvciBldmVyeSByZXNlcnZlZCBsYWJlbCBpdCBzdHJpcHMgKElzc3VlICMyODIyKS5cbiAqXG4gKiBSZXR1cm5zIHRoZSBzYW1lIGZpbHRlcmVkIGxpc3QgYXMgYGZpbHRlclJlc2VydmVkTGFiZWxzYCDigJQgcmVhZGluZyB0aGUgb25lXG4gKiBgUkVTRVJWRURfTEFCRUxTYCBjb25zdGFudCBzbyB0aGUgc2V0IHN0YXlzIGluIHN5bmMgYXV0b21hdGljYWxseSAobm8gc2Vjb25kXG4gKiBjb3B5IG9mIHRoZSBsaXN0KSDigJQgYnV0IGVtaXRzIG9uZSBgbG9nZ2VyLndhcm5gIHBlciBkcm9wcGVkIGxhYmVsLCBuYW1pbmcgdGhlXG4gKiBzdHJpcHBlZCBsYWJlbCBhbmQgYSBjYWxsZXItc3VwcGxpZWQgY29udGV4dCAoZS5nLiByZXBvICsgY3JlYXRpb24gcGF0aCkgc28gYVxuICogd29ya2VyIHNlbGYtYXBwbHlpbmcgYSByZXNlcnZlZCBsYWJlbCBpcyB2aXNpYmxlIGF0IGEgZ2xhbmNlLlxuICpcbiAqIGBpZGxlLXRhc2tgIGFuZCBhcmJpdHJhcnkgZGVzY3JpcHRpdmUgbGFiZWxzIChlLmcuIGBkZWdyYWRlZC1tb2RlbGApIGFyZSBub3RcbiAqIGluIGBSRVNFUlZFRF9MQUJFTFNgLCBzbyB0aGV5IHBhc3MgdGhyb3VnaCB1bmNoYW5nZWQgYW5kIGxvZyBub3RoaW5nLlxuICpcbiAqIEBwYXJhbSBsYWJlbHMgLSBMYWJlbHMgdG8gZmlsdGVyXG4gKiBAcGFyYW0gY29udGV4dCAtIENhbGxlciBjb250ZXh0IGZvciB0aGUgd2FybmluZyAoZS5nLiBcIm93bmVyL3JlcG8gaWRsZS10YXNrIGZpbGVyXCIpXG4gKiBAcGFyYW0gbG9nZ2VyIC0gTG9nZ2VyIHVzZWQgdG8gZW1pdCBvbmUgV0FSTklORyBwZXIgc3RyaXBwZWQgbGFiZWxcbiAqIEBwYXJhbSBleHRyYVJlc2VydmVkIC0gQ29uZmlndXJlZCBgY3VzdG9tX2xhYmVsX3Byb21wdHNgIGxhYmVscywgcmVzZXJ2ZWQgZm9yXG4gKiAgIHRoZSBzYW1lIHJlYXNvbiAoSXNzdWUgIzg0NylcbiAqIEByZXR1cm5zIExhYmVscyB3aXRoIHJlc2VydmVkIGxhYmVscyByZW1vdmVkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWx0ZXJSZXNlcnZlZExhYmVsc1dpdGhXYXJuaW5nKFxuICBsYWJlbHM6IHN0cmluZ1tdLFxuICBjb250ZXh0OiBzdHJpbmcsXG4gIGxvZ2dlcjogTG9nZ2VyLFxuICBleHRyYVJlc2VydmVkOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBrZXB0OiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGxhYmVsIG9mIGxhYmVscykge1xuICAgIC8vIElzc3VlICMzMDg4OiBjYXNlLWluc2Vuc2l0aXZlIG1hdGNoIChzZWUgaXNSZXNlcnZlZExhYmVsKS5cbiAgICBpZiAoaXNSZXNlcnZlZE9yQ3VzdG9tTGFiZWwobGFiZWwsIGV4dHJhUmVzZXJ2ZWQpKSB7XG4gICAgICBsb2dnZXIud2FybihcIlN0cmlwcGVkIHJlc2VydmVkIGxhYmVsIGZyb20gd29ya2VyLWNyZWF0ZWQgaXNzdWVcIiwge1xuICAgICAgICBsYWJlbCxcbiAgICAgICAgY29udGV4dCxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBrZXB0LnB1c2gobGFiZWwpO1xuICAgIH1cbiAgfVxuICByZXR1cm4ga2VwdDtcbn1cblxuLyoqIE9uZSBpbXByb3ZlbWVudCB0aGUgcm91dGVyIGZpbGVkLCByZXVzZWQsIHN1cHByZXNzZWQsIG9yIHdvdWxkIGZpbGUgKElzc3VlICMzNzQ1KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUm91dGVkSW1wcm92ZW1lbnQge1xuICB0aXRsZTogc3RyaW5nO1xuICBhY3Rpb246IEV4Y2x1ZGU8Um91dGVkSXNzdWVBY3Rpb24sIFwiYW1iaWd1b3VzXCI+O1xuICAvKiogUmVwb3NpdG9yeSB0aGUgaXNzdWUgaXMgKG9yIHdvdWxkIGJlKSBpbiDigJQgbWF5IGRpZmZlciBmcm9tIHRoZSB0YXJnZXQuICovXG4gIHJlcG9zaXRvcnk6IHN0cmluZztcbiAgbnVtYmVyOiBudW1iZXIgfCBudWxsO1xufVxuXG4vKipcbiAqIFJlc3VsdCBvZiBjcmVhdGluZyBHaXRIdWIgaXNzdWVzIHdpdGggcGFydGlhbCBmYWlsdXJlIGhhbmRsaW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIENyZWF0ZUlzc3Vlc1Jlc3VsdCB7XG4gIC8qKiBOdW1iZXJzIG9mIGlzc3VlcyBjcmVhdGVkLCBpbiB0aGUgcmVwb3NpdG9yeSB0aGUgcm91dGVyIGNob3NlIChzZWUgYHJvdXRlZGApICovXG4gIGNyZWF0ZWRJc3N1ZXM6IG51bWJlcltdO1xuICAvKiogSW1wcm92ZW1lbnRzIHRoYXQgZmFpbGVkIHRvIGNyZWF0ZTsgYGVycm9yYCBjYXJyaWVzIHRoZSByb3V0aW5nIHJlYXNvbiAqL1xuICBmYWlsdXJlczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBlcnJvcjogc3RyaW5nIH0+O1xuICAvKiogRXZlcnkgaW1wcm92ZW1lbnQgbm90IGluIGBmYWlsdXJlc2AsIHdpdGggd2hlcmUgdGhlIHJvdXRlciBwdXQgaXQuICovXG4gIHJvdXRlZDogUm91dGVkSW1wcm92ZW1lbnRbXTtcbn1cblxuLyoqIE9wdGlvbnMgZm9yIHtAbGluayBjcmVhdGVHaXRIdWJJc3N1ZXNXaXRoUGFydGlhbEZhaWx1cmVzfSAoSXNzdWUgIzM3NDUpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDcmVhdGVJc3N1ZXNPcHRpb25zIHtcbiAgLyoqIFJlcG9zaXRvcmllcyB0aGUgaXNzdWUgcm91dGVyIGNhbiBmaWxlIGluLiAqL1xuICByb3V0aW5nQ29udGV4dDogSXNzdWVSb3V0aW5nQ29udGV4dDtcbiAgLyoqIFdoZW4gdHJ1ZSwgdGhlIHJvdXRlciBtYWtlcyBubyBgZ2hgIHdyaXRlIGNhbGwuICovXG4gIGRyeVJ1bjogYm9vbGVhbjtcbiAgLyoqIENvbmZpZ3VyZWQgYGN1c3RvbV9sYWJlbF9wcm9tcHRzYCBsYWJlbHMsIG5ldmVyIHNlbGYtYXBwbGllZCAoSXNzdWUgIzg0NykuICovXG4gIGV4dHJhUmVzZXJ2ZWRMYWJlbHM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFJ1bnMgZ2ggY29tbWFuZHM7IGRlZmF1bHRzIHRvIGBydW5HaENvbW1hbmRgLiAqL1xuICBnaENvbW1hbmRGbj86IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+O1xuICAvKiogQ2xvY2sgZm9yIHRoZSBkdXBsaWNhdGUtc2VhcmNoIHdpbmRvdzsgZGVmYXVsdHMgdG8gdGhlIHdhbGwgY2xvY2suICovXG4gIG5vdz86ICgpID0+IERhdGU7XG4gIC8qKiBGbGVldCBhdXRob3Igc2V0IGZvciB0aGUgb3duZWQtYXJ0ZWZhY3QgY2hlY2tzOyBvbWl0dGVkIG1lYW5zIGNvbmZpZ3VyZWQgaWRlbnRpdHkuICovXG4gIGRlZHVwQXV0aG9ycz86IEFsZXJ0RGVkdXBBdXRob3JPcHRpb25zO1xuICAvKiogV2FybnMgb24gc3RyaXBwZWQgcmVzZXJ2ZWQgbGFiZWxzIChJc3N1ZSAjMjgyNSkuICovXG4gIGxvZ2dlcj86IExvZ2dlcjtcbn1cblxuLyoqIFRoZSBmYWlsdXJlIG1lc3NhZ2UgZm9yIG9uZSBpbXByb3ZlbWVudCwgd2l0aCBpdHMgcm91dGluZyByZWFzb24gd2hlbiBrbm93bi4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlUm91dGluZ0ZhaWx1cmUoXG4gIGVycm9yOiB1bmtub3duLFxuICBSb3V0ZWRJc3N1ZUZpbGluZ0Vycm9yOlxuICAgIHR5cGVvZiBpbXBvcnQoXCIuL2lzc3VlX3JvdXRpbmdfZmlsaW5nLnRzXCIpLlJvdXRlZElzc3VlRmlsaW5nRXJyb3IsXG4pOiBzdHJpbmcge1xuICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBSb3V0ZWRJc3N1ZUZpbGluZ0Vycm9yICYmIGVycm9yLmRlY2lzaW9uICE9PSBudWxsKSB7XG4gICAgcmV0dXJuIGAke21lc3NhZ2V9IChyb3V0aW5nOiAke2Vycm9yLmRlY2lzaW9uLnJlYXNvbn0pYDtcbiAgfVxuICByZXR1cm4gbWVzc2FnZTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgR2l0SHViIGlzc3VlcyBmb3IgaW1wcm92ZW1lbnRzLCBjb250aW51aW5nIHBhc3QgaW5kaXZpZHVhbCBmYWlsdXJlcy5cbiAqXG4gKiBFYWNoIGltcHJvdmVtZW50IGdvZXMgdGhyb3VnaCB7QGxpbmsgZmlsZVJvdXRlZElzc3VlfSwgc28gaXQgbGFuZHMgaW4gdGhlXG4gKiByZXBvc2l0b3J5IHRoYXQgb3ducyBpdC4gQW4gYW1iaWd1b3VzIG93bmVyIGlzIGEgZmFpbHVyZSBhbmQgbm90aGluZyBpc1xuICogZmlsZWQuIEV2ZXJ5IGltcHJvdmVtZW50IGlzIGF0dGVtcHRlZCBhbmQgcGFydGlhbCBmYWlsdXJlcyBhcmUgcmVwb3J0ZWQuXG4gKlxuICogQHBhcmFtIGltcHJvdmVtZW50cyAtIEltcHJvdmVtZW50cyB0byBjcmVhdGUgaXNzdWVzIGZvclxuICogQHBhcmFtIHJlcG8gLSBUYXJnZXQgcmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSBvcHRpb25zIC0gUm91dGluZyBjb250ZXh0LCBkcnktcnVuIGZsYWcgYW5kIGluamVjdGFibGUgZGVwZW5kZW5jaWVzXG4gKiBAcmV0dXJucyBDcmVhdGVkIGlzc3VlIG51bWJlcnMsIHJvdXRlZCBpbXByb3ZlbWVudHMgYW5kIGFueSBmYWlsdXJlc1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY3JlYXRlR2l0SHViSXNzdWVzV2l0aFBhcnRpYWxGYWlsdXJlcyhcbiAgaW1wcm92ZW1lbnRzOiBJbXByb3ZlbWVudFtdLFxuICByZXBvOiBzdHJpbmcsXG4gIG9wdGlvbnM6IENyZWF0ZUlzc3Vlc09wdGlvbnMsXG4pOiBQcm9taXNlPENyZWF0ZUlzc3Vlc1Jlc3VsdD4ge1xuICBjb25zdCBsb2dnZXIgPSBvcHRpb25zLmxvZ2dlciA/PyBkZWZhdWx0TG9nZ2VyO1xuICBjb25zdCBjcmVhdGVkSXNzdWVzOiBudW1iZXJbXSA9IFtdO1xuICBjb25zdCBmYWlsdXJlczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBlcnJvcjogc3RyaW5nIH0+ID0gW107XG4gIGNvbnN0IHJvdXRlZDogUm91dGVkSW1wcm92ZW1lbnRbXSA9IFtdO1xuICAvLyBMb2FkZWQgbGF6aWx5OiBhIHN0YXRpYyBpbXBvcnQgY2xvc2VzIHRoZSBjeWNsZSBnaXRodWIudHMgLT5cbiAgLy8gaXNzdWVfcm91dGluZ19maWxpbmcudHMgLT4gaXNzdWVfcm91dGluZ19jbGFzc2lmaWVyLnRzIC0+XG4gIC8vIHJlcG9fZmFzdF9mYWlsdXJlX2lzc3VlLnRzIC0+IG5lZWRzX2h1bWFuX2VzY2FsYXRpb24udHMgLT5cbiAgLy8gbGFiZWxfb3BlcmF0aW9ucy50cyAtPiBnaXRodWIudHMuIEEgc3RhdGljIGltcG9ydCB3b3VsZCBsZWF2ZSB0aGVcbiAgLy8gY2xhc3NpZmllcidzIG1hcmtlciBjb25zdGFudHMgdW5pbml0aWFsaXNlZCB3aGVuIGEgcmVwb19mYXN0X2ZhaWx1cmVcbiAgLy8gbW9kdWxlIGxvYWRzIGZpcnN0LlxuICBjb25zdCB7IGZpbGVSb3V0ZWRJc3N1ZSwgUm91dGVkSXNzdWVGaWxpbmdFcnJvciB9ID0gYXdhaXQgaW1wb3J0KFxuICAgIFwiLi9pc3N1ZV9yb3V0aW5nX2ZpbGluZy50c1wiXG4gICk7XG5cbiAgZm9yIChjb25zdCBpbXByb3ZlbWVudCBvZiBpbXByb3ZlbWVudHMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgYm9keSA9IGZvcm1hdEltcHJvdmVtZW50QXNJc3N1ZUJvZHkoaW1wcm92ZW1lbnQpO1xuICAgICAgLy8gVGhlIHByZS1maWx0ZXIgc3RyaXBzIGJ1aWx0LWluIGFuZCBjb25maWd1cmVkIGN1c3RvbSByZXNlcnZlZCBsYWJlbHMsXG4gICAgICAvLyB3YXJuaW5nIHdpdGggdGhlIHN1Z2dlc3QtaW1wcm92ZW1lbnRzIGNvbnRleHQgKElzc3VlICMyODI1KS4gVGhlXG4gICAgICAvLyByb3V0ZXIgcmUtZmlsdGVycyBidWlsdC1pbiByZXNlcnZlZCBsYWJlbHMgYXMgZGVmZW5jZSBpbiBkZXB0aC5cbiAgICAgIGNvbnN0IHNhZmVMYWJlbHMgPSBmaWx0ZXJSZXNlcnZlZExhYmVsc1dpdGhXYXJuaW5nKFxuICAgICAgICBpbXByb3ZlbWVudC5sYWJlbHMsXG4gICAgICAgIGAke3JlcG99IHN1Z2dlc3QtaW1wcm92ZW1lbnRzYCxcbiAgICAgICAgbG9nZ2VyLFxuICAgICAgICBvcHRpb25zLmV4dHJhUmVzZXJ2ZWRMYWJlbHMsXG4gICAgICApO1xuXG4gICAgICBjb25zdCBmaWxlZCA9IGF3YWl0IGZpbGVSb3V0ZWRJc3N1ZShcbiAgICAgICAgeyB0aXRsZTogaW1wcm92ZW1lbnQudGl0bGUsIGJvZHksIGxhYmVsczogc2FmZUxhYmVscyB9LFxuICAgICAgICB7XG4gICAgICAgICAgdGFyZ2V0UmVwbzogcmVwbyxcbiAgICAgICAgICBjb250ZXh0OiBvcHRpb25zLnJvdXRpbmdDb250ZXh0LFxuICAgICAgICAgIGRyeVJ1bjogb3B0aW9ucy5kcnlSdW4sXG4gICAgICAgICAgZ2hDb21tYW5kRm46IG9wdGlvbnMuZ2hDb21tYW5kRm4sXG4gICAgICAgICAgbm93OiBvcHRpb25zLm5vdyxcbiAgICAgICAgICAuLi4ob3B0aW9ucy5kZWR1cEF1dGhvcnMgPyB7IGF1dGhvcnM6IG9wdGlvbnMuZGVkdXBBdXRob3JzIH0gOiB7fSksXG4gICAgICAgICAgbG9nZ2VyLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICAgIGlmIChmaWxlZC5hY3Rpb24gPT09IFwiYW1iaWd1b3VzXCIpIHtcbiAgICAgICAgZmFpbHVyZXMucHVzaCh7XG4gICAgICAgICAgdGl0bGU6IGltcHJvdmVtZW50LnRpdGxlLFxuICAgICAgICAgIGVycm9yOiBgUm91dGluZyBmaWxlZCBub3RoaW5nOiAke2ZpbGVkLmRlY2lzaW9uLnJlYXNvbn1gLFxuICAgICAgICB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICByb3V0ZWQucHVzaCh7XG4gICAgICAgIHRpdGxlOiBpbXByb3ZlbWVudC50aXRsZSxcbiAgICAgICAgYWN0aW9uOiBmaWxlZC5hY3Rpb24sXG4gICAgICAgIHJlcG9zaXRvcnk6IGZpbGVkLnJlcG9zaXRvcnksXG4gICAgICAgIG51bWJlcjogZmlsZWQubnVtYmVyLFxuICAgICAgfSk7XG4gICAgICBpZiAoZmlsZWQuYWN0aW9uID09PSBcImNyZWF0ZWRcIikgY3JlYXRlZElzc3Vlcy5wdXNoKGZpbGVkLm51bWJlciEpO1xuICAgIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgICBmYWlsdXJlcy5wdXNoKHtcbiAgICAgICAgdGl0bGU6IGltcHJvdmVtZW50LnRpdGxlLFxuICAgICAgICBlcnJvcjogZGVzY3JpYmVSb3V0aW5nRmFpbHVyZShlcnJvciwgUm91dGVkSXNzdWVGaWxpbmdFcnJvciksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBjcmVhdGVkSXNzdWVzLCBmYWlsdXJlcywgcm91dGVkIH07XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgR2l0SHViIGNsaWVudCB0aGF0IHVzZXMgdGhlIGdoIENMSS5cbiAqXG4gKiBAcGFyYW0gbG9nZ2VyIC0gTG9nZ2VyIGluc3RhbmNlIGZvciBkaWFnbm9zdGljIG91dHB1dFxuICogQHJldHVybnMgR2l0SHViIGNsaWVudCBpbnN0YW5jZVxuICovXG4vKiogRmllbGRzIGBnaCBpc3N1ZSB2aWV3YCBpcyBhc2tlZCBmb3IuIGBzdGF0ZWAgc3RheXMgaW4gdGhlIGxpc3Qgc28gYSBtZXJnZWQgcHVsbCByZXF1ZXN0IGlzIGEgc3VjY2Vzc2Z1bCBsb29rdXAsIG5vdCBhIHRocm93biB2YWxpZGF0aW9uIGVycm9yIChJc3N1ZSAjMzA4OCByZXZpZXcpLiAqL1xuZXhwb3J0IGNvbnN0IEdIX0lTU1VFX1ZJRVdfSlNPTl9GSUVMRFMgPVxuICBcIm51bWJlcix0aXRsZSxib2R5LGxhYmVscyxhdXRob3IsYXNzaWduZWVzLGNyZWF0ZWRBdCx1cGRhdGVkQXQsc3RhdGVcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUdpdEh1YkNsaWVudChsb2dnZXI6IExvZ2dlcik6IEdpdEh1YkNsaWVudCB7XG4gIHJldHVybiB7XG4gICAgYXN5bmMgZ2V0SXNzdWUocmVwbzogc3RyaW5nLCBpc3N1ZU51bWJlcjogbnVtYmVyKTogUHJvbWlzZTxHaXRIdWJJc3N1ZT4ge1xuICAgICAgbG9nZ2VyLmRlYnVnKGBGZXRjaGluZyBpc3N1ZSAjJHtpc3N1ZU51bWJlcn0gZnJvbSAke3JlcG99YCk7XG4gICAgICBjb25zdCBvdXRwdXQgPSBhd2FpdCBydW5HaENvbW1hbmQoW1xuICAgICAgICBcImlzc3VlXCIsXG4gICAgICAgIFwidmlld1wiLFxuICAgICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgICBcIi0tcmVwb1wiLFxuICAgICAgICByZXBvLFxuICAgICAgICBcIi0tanNvblwiLFxuICAgICAgICBHSF9JU1NVRV9WSUVXX0pTT05fRklFTERTLFxuICAgICAgXSk7XG4gICAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKG91dHB1dCk7XG4gICAgICBjb25zdCB2YWxpZGF0ZWQgPSB2YWxpZGF0ZUdoSXNzdWVKc29uKHBhcnNlZCk7XG4gICAgICBpZiAoIXZhbGlkYXRlZC5vaykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEludmFsaWQgZ2ggQ0xJIGlzc3VlIHJlc3BvbnNlOiAke3ZhbGlkYXRlZC5lcnJvci5maWVsZH0gLSAke3ZhbGlkYXRlZC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcGFyc2VHaElzc3VlSnNvbih2YWxpZGF0ZWQudmFsdWUpO1xuICAgIH0sXG5cbiAgICBhc3luYyBnZXRJc3N1ZUNvbW1lbnRzKFxuICAgICAgcmVwbzogc3RyaW5nLFxuICAgICAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgICApOiBQcm9taXNlPEdpdEh1YkNvbW1lbnRbXT4ge1xuICAgICAgLy8gSXNzdWUgIzE4NDE6IHBlci1pdGVyYXRpb24gVFRMIGNhY2hlLiBNdWx0aXBsZSBwcmlvcml0aWVzIHJlYWRcbiAgICAgIC8vIHRoZSBzYW1lIGlzc3VlJ3MgY29tbWVudHMgd2l0aGluIGFuIGl0ZXJhdGlvbjsgdGhlIGNhY2hlXG4gICAgICAvLyBjb2xsYXBzZXMgdGhvc2UgaW50byBhIHNpbmdsZSBSRVNUIGNhbGwuIFRoZSBjYWNoZSBpc1xuICAgICAgLy8gaW52YWxpZGF0ZWQgYnkgYHBvc3RDb21tZW50YCBmb3IgdGhlIHNhbWUgYChyZXBvLCBpc3N1ZU51bWJlcilgLlxuICAgICAgcmV0dXJuIGF3YWl0IGdldENhY2hlZENvbW1lbnRzKHJlcG8sIGlzc3VlTnVtYmVyLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhcbiAgICAgICAgICBgRmV0Y2hpbmcgY29tbWVudHMgZm9yIGlzc3VlICMke2lzc3VlTnVtYmVyfSBmcm9tICR7cmVwb31gLFxuICAgICAgICApO1xuICAgICAgICAvLyBVc2UgUkVTVCBBUEkg4oCUIGdoIGlzc3VlIHZpZXcgLS1qc29uIGNvbW1lbnRzIHJldHVybnMgR3JhcGhRTCBub2RlIElEc1xuICAgICAgICAvLyAoc3RyaW5ncykgaW5zdGVhZCBvZiBudW1lcmljIElEcyBuZWVkZWQgZm9yIFJFU1QgQVBJIG9wZXJhdGlvbnMuXG4gICAgICAgIC8vIElzc3VlICMxODgxOiBwYWdlIHRocm91Z2ggYWxsIGNvbW1lbnRzLiBUaGUgZGVmYXVsdCBSRVNUIHBhZ2Ugc2l6ZVxuICAgICAgICAvLyBpcyAzMCwgd2hpY2ggc2lsZW50bHkgdHJ1bmNhdGVkIGxvbmcgZ3JpbGwtbWUgdGhyZWFkcyBhbmQgY2F1c2VkXG4gICAgICAgIC8vIHdvcmtmbG93cyB0byByZS1wb3NlIHF1ZXN0aW9ucyB0aGUgZGV2ZWxvcGVyIGhhZCBhbHJlYWR5IGFuc3dlcmVkLlxuICAgICAgICAvLyBJc3N1ZSAjMzcwOTogYm91bmRlZCBwYWdpbmF0aW9uIHJlcGxhY2VzIHVuYm91bmRlZCBgLS1wYWdpbmF0ZWAuXG4gICAgICAgIGNvbnN0IHJhdyA9IGF3YWl0IGZldGNoSXNzdWVDb21tZW50UGFnZXMoXG4gICAgICAgICAgcmVwbyxcbiAgICAgICAgICBpc3N1ZU51bWJlcixcbiAgICAgICAgICBydW5HaENvbW1hbmQsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiBwYXJzZUdoUmF3Q29tbWVudHNKc29uKHJhdyk7XG4gICAgICB9KTtcbiAgICB9LFxuXG4gICAgYXN5bmMgYWRkTGFiZWwoXG4gICAgICByZXBvOiBzdHJpbmcsXG4gICAgICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICAgICAgbGFiZWw6IHN0cmluZyxcbiAgICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhcbiAgICAgICAgYEFkZGluZyBsYWJlbCBcIiR7bGFiZWx9XCIgdG8gaXNzdWUgIyR7aXNzdWVOdW1iZXJ9IGluICR7cmVwb31gLFxuICAgICAgKTtcbiAgICAgIC8vIElzc3VlICM5NzY6IFVzZSBSRVNUIEFQSSB3aXRoIENMSSBmYWxsYmFjayBmb3IgbGFiZWwgb3BlcmF0aW9uc1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgcnVuR2hDb21tYW5kKFtcbiAgICAgICAgICBcImFwaVwiLFxuICAgICAgICAgIFwiLVhcIixcbiAgICAgICAgICBcIlBPU1RcIixcbiAgICAgICAgICBgcmVwb3MvJHtyZXBvfS9pc3N1ZXMvJHtpc3N1ZU51bWJlcn0vbGFiZWxzYCxcbiAgICAgICAgICBcIi1mXCIsXG4gICAgICAgICAgYGxhYmVsc1tdPSR7bGFiZWx9YCxcbiAgICAgICAgXSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBSRVNUIEFQSSBmYWlsZWQg4oCUIGZhbGwgYmFjayB0byBDTElcbiAgICAgIH1cbiAgICAgIGF3YWl0IHJ1bkdoQ29tbWFuZChbXG4gICAgICAgIFwiaXNzdWVcIixcbiAgICAgICAgXCJlZGl0XCIsXG4gICAgICAgIFN0cmluZyhpc3N1ZU51bWJlciksXG4gICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgIHJlcG8sXG4gICAgICAgIFwiLS1hZGQtbGFiZWxcIixcbiAgICAgICAgbGFiZWwsXG4gICAgICBdKTtcbiAgICB9LFxuXG4gICAgYXN5bmMgcmVtb3ZlTGFiZWwoXG4gICAgICByZXBvOiBzdHJpbmcsXG4gICAgICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICAgICAgbGFiZWw6IHN0cmluZyxcbiAgICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhcbiAgICAgICAgYFJlbW92aW5nIGxhYmVsIFwiJHtsYWJlbH1cIiBmcm9tIGlzc3VlICMke2lzc3VlTnVtYmVyfSBpbiAke3JlcG99YCxcbiAgICAgICk7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBydW5HaENvbW1hbmQoW1xuICAgICAgICAgIFwiaXNzdWVcIixcbiAgICAgICAgICBcImVkaXRcIixcbiAgICAgICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgICAgcmVwbyxcbiAgICAgICAgICBcIi0tcmVtb3ZlLWxhYmVsXCIsXG4gICAgICAgICAgbGFiZWwsXG4gICAgICAgIF0pO1xuICAgICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgICAgaWYgKGlzTGFiZWxOb3RGb3VuZEVycm9yKG1lc3NhZ2UpKSB7XG4gICAgICAgICAgbG9nZ2VyLmRlYnVnKFxuICAgICAgICAgICAgYExhYmVsIFwiJHtsYWJlbH1cIiBub3QgZm91bmQgb24gaXNzdWUgIyR7aXNzdWVOdW1iZXJ9IOKAlCBpZ25vcmluZ2AsXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfSxcblxuICAgIGFzeW5jIHBvc3RDb21tZW50KFxuICAgICAgcmVwbzogc3RyaW5nLFxuICAgICAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgICAgIGJvZHk6IHN0cmluZyxcbiAgICApOiBQcm9taXNlPEdpdEh1YkNvbW1lbnQgfCB1bmRlZmluZWQ+IHtcbiAgICAgIC8vIElzc3VlICMxNjU5OiBza2lwIHdoaXRlc3BhY2Utb25seSBib2RpZXMuIEFuIGVtcHR5IG9yXG4gICAgICAvLyBIVE1MLWNvbW1lbnQtb25seSBib2R5IHJlbmRlcnMgYXMgYSBibGFuayBjb21tZW50IG9uIEdpdEh1Yiwgd2hpY2hcbiAgICAgIC8vIGNvbmZ1c2VzIHJlYWRlcnMgKFwiTXVsdGlwbGUgYmxhbmsgY29tbWVudHNcIikuIENhbGxlcnMgdGhhdCBuZWVkIGFcbiAgICAgIC8vIGhpZGRlbiBtYXJrZXIgbXVzdCBpbmNsdWRlIGEgdmlzaWJsZSBsaW5lIGFzIHdlbGwg4oCUIHNlZVxuICAgICAgLy8gY2xhaW1fcHJfY29tbWVudC50cyBmb3IgdGhlIGNhbm9uaWNhbCBwYXR0ZXJuLlxuICAgICAgaWYgKCFoYXNWaXNpYmxlQ29udGVudChib2R5KSkge1xuICAgICAgICBsb2dnZXIud2FybihcbiAgICAgICAgICBgUmVmdXNpbmcgdG8gcG9zdCBjb21tZW50IHRvIGlzc3VlICMke2lzc3VlTnVtYmVyfSBpbiAke3JlcG99OiBib2R5IGhhcyBubyB2aXNpYmxlIGNvbnRlbnRgLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfVxuICAgICAgbG9nZ2VyLmRlYnVnKGBQb3N0aW5nIGNvbW1lbnQgdG8gaXNzdWUgIyR7aXNzdWVOdW1iZXJ9IGluICR7cmVwb31gKTtcbiAgICAgIC8vIElzc3VlICMxODQzOiBwb3N0IHZpYSB0aGUgUkVTVCBBUEkgc28gdGhlIHJlc3BvbnNlIGNhcnJpZXMgdGhlXG4gICAgICAvLyBmcmVzaGx5LWNyZWF0ZWQgY29tbWVudCBtZXRhZGF0YSAoaWQsIGNyZWF0ZWRBdCwgYXV0aG9yKS4gQ2FsbGVyc1xuICAgICAgLy8gdGhhdCBwcmV2aW91c2x5IGhhZCB0byByZWZldGNoIHRoZSBjb21tZW50IGxpc3QgdG8gcGljayB1cCBhXG4gICAgICAvLyBwb3N0IHRoZXkganVzdCBtYWRlIGNhbiBhcHBlbmQgdGhlIHJldHVybmVkIG9iamVjdCBpbiBtZW1vcnlcbiAgICAgIC8vIGluc3RlYWQg4oCUIHNhdmluZyBvbmUgR0ggY2FsbCBwZXIgcm91bmQuXG4gICAgICBsZXQgY3JlYXRlZDogR2l0SHViQ29tbWVudCB8IHVuZGVmaW5lZDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG91dHB1dCA9IGF3YWl0IHJ1bkdoQ29tbWFuZChbXG4gICAgICAgICAgXCJhcGlcIixcbiAgICAgICAgICBcIi1YXCIsXG4gICAgICAgICAgXCJQT1NUXCIsXG4gICAgICAgICAgYHJlcG9zLyR7cmVwb30vaXNzdWVzLyR7aXNzdWVOdW1iZXJ9L2NvbW1lbnRzYCxcbiAgICAgICAgICBcIi1mXCIsXG4gICAgICAgICAgYGJvZHk9JHtib2R5fWAsXG4gICAgICAgIF0pO1xuICAgICAgICBjcmVhdGVkID0gcGFyc2VDcmVhdGVkQ29tbWVudEpzb24ob3V0cHV0KTtcbiAgICAgIH0gY2F0Y2ggKGFwaUVycikge1xuICAgICAgICAvLyBSRVNUIFBPU1QgZmFpbGVkIOKAlCBmYWxsIGJhY2sgdG8gdGhlIGxlZ2FjeSBgZ2ggaXNzdWUgY29tbWVudGBcbiAgICAgICAgLy8gcGF0aC4gT2xkZXIgZ2ggdmVyc2lvbnMgb3IgdW5leHBlY3RlZCByZXNwb25zZSBzaGFwZXMgbXVzdCBub3RcbiAgICAgICAgLy8gYnJlYWsgZXhpc3RpbmcgY2FsbGVyczsgdGhlIG9ubHkgY29uc2VxdWVuY2UgaXMgdGhhdCBub1xuICAgICAgICAvLyBtZXRhZGF0YSBpcyByZXR1cm5lZC5cbiAgICAgICAgbG9nZ2VyLmRlYnVnKFxuICAgICAgICAgIGBSRVNUIFBPU1QgY29tbWVudCBmYWlsZWQgKCR7XG4gICAgICAgICAgICBhcGlFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGFwaUVyci5tZXNzYWdlIDogU3RyaW5nKGFwaUVycilcbiAgICAgICAgICB9KTsgZmFsbGluZyBiYWNrIHRvIGdoIGlzc3VlIGNvbW1lbnRgLFxuICAgICAgICApO1xuICAgICAgICBhd2FpdCBydW5HaENvbW1hbmQoW1xuICAgICAgICAgIFwiaXNzdWVcIixcbiAgICAgICAgICBcImNvbW1lbnRcIixcbiAgICAgICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgICAgcmVwbyxcbiAgICAgICAgICBcIi0tYm9keVwiLFxuICAgICAgICAgIGJvZHksXG4gICAgICAgIF0pO1xuICAgICAgfVxuICAgICAgLy8gSXNzdWUgIzE4NDE6IGludmFsaWRhdGUgdGhlIGNvbW1lbnQgY2FjaGUgc28gdGhlIG5leHQgcmVhZFxuICAgICAgLy8gc2VlcyB0aGUgZnJlc2hseS1wb3N0ZWQgY29tbWVudCB3aXRob3V0IGEgc3RhbGUtY2FjaGUgaGl0LlxuICAgICAgaW52YWxpZGF0ZUNvbW1lbnRzKHJlcG8sIGlzc3VlTnVtYmVyKTtcbiAgICAgIHJldHVybiBjcmVhdGVkO1xuICAgIH0sXG5cbiAgICBhc3luYyB1cGRhdGVDb21tZW50KFxuICAgICAgcmVwbzogc3RyaW5nLFxuICAgICAgY29tbWVudElkOiBudW1iZXIsXG4gICAgICBib2R5OiBzdHJpbmcsXG4gICAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICAvLyBUaGUgaWQgaXMgaW50ZXJwb2xhdGVkIGludG8gdGhlIFJFU1QgcGF0aCwgc28gYSBub24tbnVtZXJpYyBvbmUgaXNcbiAgICAgIC8vIHJlZnVzZWQgb3V0cmlnaHQgcmF0aGVyIHRoYW4gZXNjYXBlZCDigJQgdGhlcmUgaXMgbm90aGluZyBsZWdpdGltYXRlXG4gICAgICAvLyBpdCBjb3VsZCBiZSAoSXNzdWUgIzE4NzkpLlxuICAgICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKGNvbW1lbnRJZCkgfHwgY29tbWVudElkIDw9IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGB1cGRhdGVDb21tZW50OiBjb21tZW50IGlkIG11c3QgYmUgYSBwb3NpdGl2ZSBpbnRlZ2VyLCBnb3QgXCIke2NvbW1lbnRJZH1cImAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBsb2dnZXIuZGVidWcoYEVkaXRpbmcgY29tbWVudCAke2NvbW1lbnRJZH0gaW4gJHtyZXBvfWApO1xuICAgICAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgcnVuR2hDb21tYW5kKFtcbiAgICAgICAgXCJhcGlcIixcbiAgICAgICAgXCItWFwiLFxuICAgICAgICBcIlBBVENIXCIsXG4gICAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy9jb21tZW50cy8ke2NvbW1lbnRJZH1gLFxuICAgICAgICBcIi1mXCIsXG4gICAgICAgIGBib2R5PSR7Ym9keX1gLFxuICAgICAgXSk7XG4gICAgICAvLyBUaGUgUEFUQ0ggcmVzcG9uc2UgbmFtZXMgdGhlIGlzc3VlIHRoZSBjb21tZW50IGJlbG9uZ3MgdG8sIHNvIHRoZVxuICAgICAgLy8gcGVyLWl0ZXJhdGlvbiBjb21tZW50IGNhY2hlIGNhbiBiZSBkcm9wcGVkIHdpdGhvdXQgdGhlIGNhbGxlciBoYXZpbmdcbiAgICAgIC8vIHRvIGtub3cgdGhlIGlzc3VlIG51bWJlciAoSXNzdWUgIzE4NDEncyBjYWNoZSwgSXNzdWUgIzE4NzkncyBlZGl0KS5cbiAgICAgIGNvbnN0IGlzc3VlTnVtYmVyID0gcGFyc2VDb21tZW50SXNzdWVOdW1iZXIob3V0cHV0KTtcbiAgICAgIGlmIChpc3N1ZU51bWJlciAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkYXRlQ29tbWVudHMocmVwbywgaXNzdWVOdW1iZXIpO1xuICAgIH0sXG5cbiAgICBhc3luYyBlZGl0SXNzdWUoXG4gICAgICByZXBvOiBzdHJpbmcsXG4gICAgICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICAgICAgdXBkYXRlczogeyB0aXRsZT86IHN0cmluZzsgYm9keT86IHN0cmluZyB9LFxuICAgICk6IFByb21pc2U8dm9pZD4ge1xuICAgICAgbG9nZ2VyLmRlYnVnKGBFZGl0aW5nIGlzc3VlICMke2lzc3VlTnVtYmVyfSBpbiAke3JlcG99YCk7XG4gICAgICBjb25zdCBhcmdzID0gW1wiaXNzdWVcIiwgXCJlZGl0XCIsIFN0cmluZyhpc3N1ZU51bWJlciksIFwiLS1yZXBvXCIsIHJlcG9dO1xuXG4gICAgICBpZiAodXBkYXRlcy50aXRsZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGFyZ3MucHVzaChcIi0tdGl0bGVcIiwgdXBkYXRlcy50aXRsZSk7XG4gICAgICB9XG4gICAgICBpZiAodXBkYXRlcy5ib2R5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgYXJncy5wdXNoKFwiLS1ib2R5XCIsIHVwZGF0ZXMuYm9keSk7XG4gICAgICB9XG5cbiAgICAgIGF3YWl0IHJ1bkdoQ29tbWFuZChhcmdzKTtcbiAgICB9LFxuXG4gICAgYXN5bmMgYXNzaWduSXNzdWUoXG4gICAgICByZXBvOiBzdHJpbmcsXG4gICAgICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICAgICAgYXNzaWduZWVzOiBzdHJpbmdbXSxcbiAgICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhcbiAgICAgICAgYEFzc2lnbmluZyAke2Fzc2lnbmVlcy5qb2luKFwiLCBcIil9IHRvIGlzc3VlICMke2lzc3VlTnVtYmVyfSBpbiAke3JlcG99YCxcbiAgICAgICk7XG4gICAgICBhd2FpdCBydW5HaENvbW1hbmQoW1xuICAgICAgICBcImlzc3VlXCIsXG4gICAgICAgIFwiZWRpdFwiLFxuICAgICAgICBTdHJpbmcoaXNzdWVOdW1iZXIpLFxuICAgICAgICBcIi0tcmVwb1wiLFxuICAgICAgICByZXBvLFxuICAgICAgICBcIi0tYWRkLWFzc2lnbmVlXCIsXG4gICAgICAgIGFzc2lnbmVlcy5qb2luKFwiLFwiKSxcbiAgICAgIF0pO1xuICAgIH0sXG5cbiAgICBhc3luYyB1bmFzc2lnbklzc3VlKFxuICAgICAgcmVwbzogc3RyaW5nLFxuICAgICAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgICAgIGFzc2lnbmVlczogc3RyaW5nW10sXG4gICAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICBsb2dnZXIuZGVidWcoXG4gICAgICAgIGBVbmFzc2lnbmluZyAke1xuICAgICAgICAgIGFzc2lnbmVlcy5qb2luKFwiLCBcIilcbiAgICAgICAgfSBmcm9tIGlzc3VlICMke2lzc3VlTnVtYmVyfSBpbiAke3JlcG99YCxcbiAgICAgICk7XG4gICAgICAvLyBJc3N1ZSAjNDIgRGVmZWN0IDM6IHJlbGVhc2UgdGhlIGNsYWltIHZpYSB0aGUgUkVTVCBhc3NpZ25lZXNcbiAgICAgIC8vIGVuZHBvaW50IChjb3JlIHF1b3RhKSByYXRoZXIgdGhhbiBgZ2ggaXNzdWUgZWRpdGAgKEdyYXBoUUwpLiBBXG4gICAgICAvLyBmaW5pc2hlZCBydW4gbXVzdCBiZSBhYmxlIHRvIGRyb3AgaXRzIGNsYWltIGV2ZW4gd2hpbGUgdGhlIHByaW1hcnlcbiAgICAgIC8vIEdyYXBoUUwgcXVvdGEgaXMgZXhoYXVzdGVkIOKAlCB0aGUgY29yZSBxdW90YSBpcyBhIHNlcGFyYXRlIGJ1ZGdldCxcbiAgICAgIC8vIGFuZCB0aGUgcHJpbWFyeS1xdW90YSBsYXRjaCBleGVtcHRzIFJFU1QgYGdoIGFwaWAgY2FsbHMgZm9yIGV4YWN0bHlcbiAgICAgIC8vIHRoaXMgcmVhc29uLiBBbiBlbXB0eSBsaXN0IGlzIGEgbm8tb3AsIG1hdGNoaW5nIHRoZSBvbGQgYmVoYXZpb3VyLlxuICAgICAgaWYgKGFzc2lnbmVlcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICAgIGNvbnN0IGFyZ3MgPSBbXG4gICAgICAgIFwiYXBpXCIsXG4gICAgICAgIFwiLVhcIixcbiAgICAgICAgXCJERUxFVEVcIixcbiAgICAgICAgYHJlcG9zLyR7cmVwb30vaXNzdWVzLyR7aXNzdWVOdW1iZXJ9L2Fzc2lnbmVlc2AsXG4gICAgICBdO1xuICAgICAgZm9yIChjb25zdCBhc3NpZ25lZSBvZiBhc3NpZ25lZXMpIHtcbiAgICAgICAgYXJncy5wdXNoKFwiLWZcIiwgYGFzc2lnbmVlc1tdPSR7YXNzaWduZWV9YCk7XG4gICAgICB9XG4gICAgICBhd2FpdCBydW5HaENvbW1hbmQoYXJncyk7XG4gICAgfSxcblxuICAgIGFzeW5jIGNsb3NlSXNzdWUoXG4gICAgICByZXBvOiBzdHJpbmcsXG4gICAgICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICAgICAgY29tbWVudD86IHN0cmluZyxcbiAgICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhgQ2xvc2luZyBpc3N1ZSAjJHtpc3N1ZU51bWJlcn0gaW4gJHtyZXBvfWApO1xuICAgICAgY29uc3QgYXJncyA9IFtcbiAgICAgICAgXCJpc3N1ZVwiLFxuICAgICAgICBcImNsb3NlXCIsXG4gICAgICAgIFN0cmluZyhpc3N1ZU51bWJlciksXG4gICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgIHJlcG8sXG4gICAgICBdO1xuICAgICAgaWYgKGNvbW1lbnQpIHtcbiAgICAgICAgYXJncy5wdXNoKFwiLS1jb21tZW50XCIsIGNvbW1lbnQpO1xuICAgICAgfVxuICAgICAgYXdhaXQgcnVuR2hDb21tYW5kKGFyZ3MpO1xuICAgIH0sXG4gIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7O0NBUUMsR0FRRCxTQUdFLHNCQUFzQixFQUN0QixtQkFBbUIsUUFDZCxrQkFBa0I7QUFDekIsU0FBUyxnQkFBZ0IsUUFBUSxhQUFhO0FBQzlDLFNBQVMsZUFBZSxRQUFRLHVCQUF1QjtBQUN2RCxTQUFTLFlBQVksRUFBRSw2QkFBNkIsUUFBUSxnQkFBZ0I7QUFDNUUsU0FBUyxpQkFBaUIsUUFBUSwyQkFBMkI7QUFDN0QsU0FDRSxxQkFBcUIsRUFDckIseUJBQXlCLEVBQ3pCLG1CQUFtQixFQUNuQixpQkFBaUIsRUFDakIsdUJBQXVCLFFBQ2xCLDJCQUEyQjtBQUNsQyxTQUFTLCtCQUErQixRQUFRLDRCQUE0QjtBQUM1RSxTQUNFLG9CQUFvQixFQUNwQixvQkFBb0IsUUFDZix5QkFBeUI7QUFDaEMsU0FBUyxpQkFBaUIsRUFBRSxrQkFBa0IsUUFBUSxxQkFBcUI7QUFDM0UsU0FBUyxzQkFBc0IsUUFBUSwyQkFBMkI7QUFFbEUsU0FBUyw0QkFBNEIsUUFBUSxzQ0FBc0M7QUFDbkYsU0FBUyxhQUFhLFFBQVEsY0FBYztBQUs1Qzs7Ozs7Q0FL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
// denoCacheMetadata=15194490636259092028,15252101504838730398