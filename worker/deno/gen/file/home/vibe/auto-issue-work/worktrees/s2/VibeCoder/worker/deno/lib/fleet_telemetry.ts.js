/**
 * Fleet-level operational telemetry (Issue #855).
 *
 * Per-run telemetry already answered "what did this run do". Four fleet
 * questions had no recorded answer at all, and each needed ad-hoc
 * `grep`/`awk` over rotated logs to approximate:
 *
 *   1. How long was the fleet idle — and why?
 *   2. How long was it blocked waiting for model tokens / usage limits?
 *   3. How long was it blocked on GitHub rate limits?
 *   4. What is the success vs failure rate?
 *
 * This module accumulates those numbers across cycles and formats one
 * machine-readable summary line, so a trend can be plotted instead of
 * eyeballed:
 *
 *   fleet-summary: wall=92520s idle=39600s idle_pct=42.8 busy=52920s …
 *
 * Same lifecycle as `cycle_timings.ts` and `gh_call_metrics.ts`:
 * process-wide module state, driven by the main loop. Unlike those two it
 * is **not** reset per cycle — the whole point is accumulation. Durable
 * cross-run totals live in `fleet_telemetry_sidecar.ts`.
 *
 * Accounting model. The run's wall time is partitioned into three
 * non-overlapping spans, so `wall ≈ occupied + blocked + idle`:
 *
 *   - **occupied** — wall time during which **at least one** work stream
 *     held a claim. Deliberately not the sum of per-stream busy time: with
 *     an N-slot pool, summing concurrent streams overshoots the wall clock
 *     and would drive idle to zero on a half-idle pool.
 *   - **blocked** — wall time the loop spent paused between runs on a
 *     GitHub rate limit (`rate_limited`) or a model usage limit
 *     (`usage_blocked`).
 *   - **idle** — everything else (scanning, maintenance passes, the
 *     end-of-cycle sleep), attributed to the reason the cycle claimed
 *     nothing.
 *
 * Blocked spans are also idle reasons, so `idle_by_reason` sums to
 * `idle_seconds` exactly and nothing is double counted.
 *
 * `busy_by_stream` and `utilisation` are reported **per stream** and so do
 * overlap each other under concurrency — that is the point of a per-stream
 * number. Only `occupied` is used for the idle arithmetic.
 *
 * One deliberate overlap: a block that happens *inside* a run (the agent's
 * own rate-limit retry ladder sleeps in-process) is counted in
 * `usage_blocked_seconds` / `rate_limited_seconds`, because the issue asks
 * how long the fleet was blocked on tokens, but is **not** added to
 * `idle_by_reason` — the fleet was holding a claim, not idle. So the
 * blocked totals can exceed the blocked share of `idle_seconds`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /** Failure class recorded when the caller could not name one. */ const UNKNOWN_FAILURE_CLASS = "unknown";
/** Zeroed {@link IssuePhaseCounters} — the start of every window. */ function zeroIssuePhaseCounters() {
  return {
    issuePhaseRuns: 0,
    issuePhaseUsd: 0,
    issuePhaseFirstAttemptGatePasses: 0,
    issuePhaseDurationSeconds: 0,
    issuePhaseSplitRuns: 0,
    issuePhaseSonnetRuns: 0,
    issuePhaseSonnetUsd: 0,
    issuePhaseHaikuRuns: 0,
    issuePhaseHaikuUsd: 0
  };
}
/** Zeroed {@link PrOutcomeCounters} — the start of every window. */ function zeroPrOutcomeCounters() {
  return {
    prRejectionsSonnet: 0,
    prRejectionsHaiku: 0,
    ciFixRunsSonnet: 0,
    ciFixRunsHaiku: 0,
    ciFixUsdSonnet: 0,
    ciFixUsdHaiku: 0,
    prFeedbackRunsSonnet: 0,
    prFeedbackRunsHaiku: 0,
    prFeedbackUsdSonnet: 0,
    prFeedbackUsdHaiku: 0,
    mergedPrsSonnet: 0,
    mergedPrsHaiku: 0
  };
}
// SIMPLE-ON-PURPOSE: dedupe is per telemetry window and events before the window start are ignored, so a restart does not re-count, but an event that happened while the worker was down is not counted — upgrade when that undercount matters (persist a seen-set or a high-water mark in the sidecar)
const seenRejections = new Set();
const seenMergedPrs = new Set();
function emptyState(runToken) {
  return {
    runToken,
    activeStreams: 0,
    occupiedSinceCloseMs: 0,
    occupiedMs: 0,
    blockedSinceCloseMs: 0,
    streamStartMs: new Map(),
    idleMsByReason: new Map(),
    busyMsByStream: new Map(),
    tokenBlockedMs: 0,
    rateLimitedMs: 0,
    rateLimitWaits: 0,
    tokenBlockedWaits: 0,
    claims: 0,
    successes: 0,
    failures: 0,
    skips: 0,
    failuresByClass: new Map(),
    hookFailures: 0,
    issuePhase: zeroIssuePhaseCounters(),
    prOutcomes: zeroPrOutcomeCounters()
  };
}
let state = emptyState(0);
/**
 * Pull requests raised this process with an unresolved pre-PR review record
 * (Issue #4236). Counted on the fleet-summary line and kept off `failures`.
 * Not persisted: a prior sidecar has no field for it, and the line only
 * names the count once one has been recorded.
 */ let preprReviewChangesRequested = 0;
/** Add the findings just posted on a pre-PR review record (Issue #4236). */ export function recordPreprReviewChangesRequested(count) {
  if (count > 0) preprReviewChangesRequested += count;
}
/** Clear every accumulator and open a new accumulation window. */ export function resetFleetTelemetry() {
  state = emptyState(state.runToken + 1);
  seenRejections.clear();
  seenMergedPrs.clear();
  preprReviewChangesRequested = 0;
}
/**
 * Mark the start of a run's accumulation window. Idempotent per run — a
 * second call restarts the wall clock.
 */ export function startFleetTelemetry(nowMs = Date.now()) {
  resetFleetTelemetry();
  state.runStartMs = nowMs;
  state.closedThroughMs = nowMs;
}
/**
 * Mark the start of a cycle. Deliberately does **not** move the
 * attribution marker: a cycle that returns early (a failed health check, a
 * rate-limit pause) never reaches {@link recordCycleIdle}, and its wall
 * time is real idle time. Leaving the marker where it is folds that time
 * into the next attributed segment instead of dropping it.
 */ export function startFleetCycle(nowMs = Date.now()) {
  if (state.runStartMs === undefined) state.runStartMs = nowMs;
  if (state.closedThroughMs === undefined) state.closedThroughMs = nowMs;
}
function addTo(map, key, value) {
  map.set(key, (map.get(key) ?? 0) + value);
}
/**
 * A work stream has taken a claim. The fleet counts as occupied while at
 * least one stream is open, so concurrent slots cannot subtract more wall
 * time than the clock actually held.
 */ export function beginBusy(stream, nowMs = Date.now()) {
  if (state.streamStartMs.has(stream)) return;
  state.streamStartMs.set(stream, nowMs);
  state.activeStreams += 1;
  if (state.activeStreams === 1) state.occupiedStartMs = nowMs;
}
/** A work stream has released its claim. */ export function endBusy(stream, nowMs = Date.now()) {
  const startedAt = state.streamStartMs.get(stream);
  if (startedAt === undefined) return;
  state.streamStartMs.delete(stream);
  addTo(state.busyMsByStream, stream, Math.max(0, nowMs - startedAt));
  state.activeStreams -= 1;
  if (state.activeStreams > 0) return;
  const occupiedFrom = state.occupiedStartMs;
  if (occupiedFrom !== undefined) {
    const ms = Math.max(0, nowMs - occupiedFrom);
    state.occupiedSinceCloseMs += ms;
    state.occupiedMs += ms;
  }
  state.occupiedStartMs = undefined;
}
/** Add to the blocked totals for `kind`, counting one wait. */ function addBlockedTotals(kind, ms) {
  if (kind === "rate_limited") {
    state.rateLimitedMs += ms;
    state.rateLimitWaits += 1;
  } else {
    state.tokenBlockedMs += ms;
    state.tokenBlockedWaits += 1;
  }
}
/**
 * Record wall seconds the loop spent blocked **between** runs. Counts as
 * its own idle reason as well as against the blocked totals, so
 * `idle_by_reason` still sums to `idle_seconds`. A zero-length wait is
 * ignored rather than reported as a wait that did not happen.
 */ export function recordBlockedSeconds(kind, seconds) {
  const ms = Math.max(0, seconds) * 1000;
  if (ms === 0) return;
  addTo(state.idleMsByReason, kind, ms);
  state.blockedSinceCloseMs += ms;
  addBlockedTotals(kind, ms);
}
/**
 * Record wall seconds a claimed run spent blocked **inside** itself — the
 * agent's own rate-limit retry ladder sleeps in-process, and without this
 * an hour of waiting reads as an hour of work. Counted in the blocked
 * totals (the number the issue asks for) but deliberately NOT as an idle
 * reason: the fleet was holding a claim, not idle.
 */ export function recordInRunBlockedSeconds(kind, seconds) {
  const ms = Math.max(0, seconds) * 1000;
  if (ms === 0) return;
  addBlockedTotals(kind, ms);
}
/**
 * Attribute every unaccounted wall second since the last attribution to
 * `reason`, and advance the marker. Occupied and blocked spans are
 * excluded. A stream still holding a claim contributes its elapsed time
 * to this segment without closing, so a run that spans several cycles is
 * not counted as idle.
 */ export function recordCycleIdle(reason, nowMs = Date.now()) {
  const start = state.closedThroughMs;
  if (start === undefined) return;
  const segmentMs = Math.max(0, nowMs - start);
  // Occupancy still open at the boundary: bank it and re-open at `nowMs`.
  const occupiedFrom = state.occupiedStartMs;
  if (occupiedFrom !== undefined) {
    const openMs = Math.max(0, nowMs - occupiedFrom);
    state.occupiedSinceCloseMs += openMs;
    state.occupiedMs += openMs;
    state.occupiedStartMs = nowMs;
  }
  const idleMs = Math.max(0, segmentMs - state.occupiedSinceCloseMs - state.blockedSinceCloseMs);
  if (idleMs > 0) addTo(state.idleMsByReason, reason, idleMs);
  state.closedThroughMs = nowMs;
  state.occupiedSinceCloseMs = 0;
  state.blockedSinceCloseMs = 0;
}
/** Record that an issue was claimed. */ export function recordClaim() {
  state.claims += 1;
}
/**
 * Record post-run callback invocations that did not exit 0 (Issue #2297).
 *
 * `claims=3 successes=2 failures=0` read as a healthy run on GRQ-25 while
 * every heartbeat the host published was being lost — the hook failed on each
 * of those runs and the summary had nowhere to say so.
 *
 * @param count - Failing invocations to add; defaults to one
 */ export function recordHookFailure(count = 1) {
  if (!Number.isFinite(count) || count <= 0) return;
  state.hookFailures += Math.floor(count);
}
/**
 * Record the terminal outcome of a claimed issue. `failureClass` is the
 * failing phase (`setup`, `execute`, `quality_gate`, …), `timeout`, or
 * `hard_kill` for a run the launcher watchdog killed (Issue #4254).
 */ export function recordOutcome(outcome, failureClass) {
  if (outcome === "success") {
    state.successes += 1;
    return;
  }
  if (outcome === "skip") {
    state.skips += 1;
    return;
  }
  state.failures += 1;
  const cls = failureClass?.trim();
  addTo(state.failuresByClass, cls && cls.length > 0 ? cls : UNKNOWN_FAILURE_CLASS, 1);
}
/**
 * A recorded figure, or 0 when the caller had none to give.
 *
 * Negative and non-finite values contribute nothing rather than propagating a
 * `NaN` through every subsequent total — one unparseable duration would
 * otherwise make the whole host's telemetry unreadable, which is the opposite
 * of surfacing it.
 */ function contribution(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
/**
 * Record one completed `issue`-phase run (Issue #2347, part of #2320).
 *
 * Called once per run from the completion path that posts the run-stats
 * comment, with the same figures that comment renders — so a pilot host's
 * spend, first-attempt gate pass rate and duration are comparable with the
 * control hosts' straight off the fleet summary.
 *
 * @param run - The run's cost, gate attempt, duration, split state and
 *   resolved sub-agent tier
 */ export function recordIssuePhaseRun(run) {
  const counters = state.issuePhase;
  counters.issuePhaseRuns += 1;
  counters.issuePhaseUsd += contribution(run.usd);
  counters.issuePhaseDurationSeconds += contribution(run.durationSeconds);
  if (run.gatePassedOnAttempt === 1) {
    counters.issuePhaseFirstAttemptGatePasses += 1;
  }
  if (run.split === true) counters.issuePhaseSplitRuns += 1;
  // Issue #3403 — only the resolved tier's pair moves, so a tier's spend
  // and volume never leak into the other tier's figures.
  switch(run.subAgentTier){
    case "sonnet":
      counters.issuePhaseSonnetRuns += 1;
      counters.issuePhaseSonnetUsd += contribution(run.usd);
      break;
    case "haiku":
      counters.issuePhaseHaikuRuns += 1;
      counters.issuePhaseHaikuUsd += contribution(run.usd);
      break;
  }
}
/**
 * Record an authorised CHANGES_REQUESTED review on a PR (Issue #3404).
 *
 * Counted once per `repo#prNumber#reviewId` within the telemetry window, and
 * only when the review was submitted at or after the window start, so a
 * restart does not re-count reviews that persist on the PR. A missing or
 * unparseable `submittedAt` is not counted. The tier is resolved lazily so the
 * PR-body fetch is only paid for a review that would count; when it resolves
 * to `null` nothing is recorded and the review is retried on the next scan. A
 * reset during the await discards the result rather than crediting the new
 * window.
 *
 * @param args - The PR, the review, its submission time and a tier resolver
 */ export async function recordPrRejection(args) {
  const submittedMs = Date.parse(args.submittedAt ?? "");
  if (!Number.isFinite(submittedMs)) return;
  const window = state;
  if (window.runStartMs !== undefined && submittedMs < window.runStartMs) {
    return;
  }
  const key = `${args.repo}#${args.prNumber}#${args.reviewId}`;
  if (seenRejections.has(key)) return;
  const tier = await args.resolveTier();
  if (tier === null) return;
  // A reset during the await opened a new window: this result is stale.
  if (state.runToken !== window.runToken) return;
  // A concurrent call for the same review may have counted it meanwhile.
  if (seenRejections.has(key)) return;
  seenRejections.add(key);
  switch(tier){
    case "sonnet":
      window.prOutcomes.prRejectionsSonnet += 1;
      break;
    case "haiku":
      window.prOutcomes.prRejectionsHaiku += 1;
      break;
  }
}
/**
 * Record one CI-fix run and its estimated spend (Issue #3404).
 *
 * @param args - The run's optional USD cost and the PR's sub-agent tier
 */ export function recordCiFixRun(args) {
  const counters = state.prOutcomes;
  switch(args.tier){
    case "sonnet":
      counters.ciFixRunsSonnet += 1;
      counters.ciFixUsdSonnet += contribution(args.usd);
      break;
    case "haiku":
      counters.ciFixRunsHaiku += 1;
      counters.ciFixUsdHaiku += contribution(args.usd);
      break;
  }
}
/**
 * Record one PR-feedback run and its estimated spend (Issue #3404).
 *
 * @param args - The run's optional USD cost and the PR's sub-agent tier
 */ export function recordPrFeedbackRun(args) {
  const counters = state.prOutcomes;
  switch(args.tier){
    case "sonnet":
      counters.prFeedbackRunsSonnet += 1;
      counters.prFeedbackUsdSonnet += contribution(args.usd);
      break;
    case "haiku":
      counters.prFeedbackRunsHaiku += 1;
      counters.prFeedbackUsdHaiku += contribution(args.usd);
      break;
  }
}
/**
 * Record a merged PR (Issue #3404). Counted once per `repo#number` within the
 * telemetry window, and only when `mergedAt` parses and is at or after the
 * window start, so a restart does not re-count the recent merges the listing
 * keeps returning. An empty or unparseable `mergedAt` is not counted (its
 * order against the window is unknown).
 *
 * @param args - The repo, PR number, merge time and the authoring sub-agent tier
 */ export function recordMergedPr(args) {
  const mergedMs = Date.parse(args.mergedAt);
  if (!Number.isFinite(mergedMs)) return;
  if (state.runStartMs !== undefined && mergedMs < state.runStartMs) return;
  const key = `${args.repo}#${args.number}`;
  if (seenMergedPrs.has(key)) return;
  seenMergedPrs.add(key);
  switch(args.tier){
    case "sonnet":
      state.prOutcomes.mergedPrsSonnet += 1;
      break;
    case "haiku":
      state.prOutcomes.mergedPrsHaiku += 1;
      break;
  }
}
/**
 * Cost per merged PR, four decimals, or `n/a` when nothing merged or the
 * quotient is not finite (Issue #3404).
 *
 * @param usd - Total spend attributed to the tier
 * @param merged - Merged PRs for the tier
 */ export function costPerMergedPr(usd, merged) {
  if (merged <= 0) return "n/a";
  const quotient = usd / merged;
  return Number.isFinite(quotient) ? quotient.toFixed(4) : "n/a";
}
function secondsFrom(ms) {
  return Math.round(ms / 1000);
}
function secondsMap(map) {
  return Object.fromEntries([
    ...map.entries()
  ].map(([key, ms])=>[
      key,
      secondsFrom(ms)
    ]));
}
/** Snapshot of every accumulator plus the derived rates. */ export function getFleetTelemetry(nowMs = Date.now()) {
  const wallSeconds = state.runStartMs === undefined ? 0 : Math.max(0, secondsFrom(nowMs - state.runStartMs));
  const idleByReason = secondsMap(state.idleMsByReason);
  // Streams still holding a claim count towards this snapshot without
  // closing, so a mid-run reading is not reported as an idle fleet.
  const openStreamMs = new Map(state.busyMsByStream);
  for (const [stream, startedAt] of state.streamStartMs){
    addTo(openStreamMs, stream, Math.max(0, nowMs - startedAt));
  }
  const busyByStream = secondsMap(openStreamMs);
  const occupiedMs = state.occupiedMs + (state.occupiedStartMs === undefined ? 0 : Math.max(0, nowMs - state.occupiedStartMs));
  const idleSeconds = Object.values(idleByReason).reduce((a, b)=>a + b, 0);
  const busySeconds = Object.values(busyByStream).reduce((a, b)=>a + b, 0);
  const completed = state.successes + state.failures;
  const utilisation = {};
  for (const [stream, seconds] of Object.entries(busyByStream)){
    utilisation[stream] = wallSeconds > 0 ? seconds / wallSeconds : 0;
  }
  return {
    runToken: state.runToken,
    wallSeconds,
    idleSeconds,
    idleByReason,
    occupiedSeconds: secondsFrom(occupiedMs),
    busySeconds,
    busyByStream,
    tokenBlockedSeconds: secondsFrom(state.tokenBlockedMs),
    rateLimitedSeconds: secondsFrom(state.rateLimitedMs),
    rateLimitWaits: state.rateLimitWaits,
    tokenBlockedWaits: state.tokenBlockedWaits,
    claims: state.claims,
    successes: state.successes,
    failures: state.failures,
    skips: state.skips,
    failuresByClass: Object.fromEntries(state.failuresByClass),
    hookFailures: state.hookFailures,
    // Issue #2347 — spread copies the counters, so a later record cannot
    // mutate a snapshot a caller already holds (the sidecar serialises one).
    ...state.issuePhase,
    ...state.prOutcomes,
    successRate: completed > 0 ? state.successes / completed : null,
    utilisation
  };
}
function joinCounts(counts, suffix) {
  const parts = Object.entries(counts).sort((a, b)=>b[1] - a[1]).map(([key, value])=>`${key}=${value}${suffix}`);
  return parts.length > 0 ? parts.join(",") : "none";
}
/**
 * One machine-readable summary line. Emitted per cycle and once at the end
 * of a run, so the numbers can be trended straight out of the log.
 */ export function formatFleetSummary(nowMs = Date.now()) {
  const s = getFleetTelemetry(nowMs);
  const idlePct = s.wallSeconds > 0 ? (s.idleSeconds / s.wallSeconds * 100).toFixed(1) : "0.0";
  const utilisation = Object.entries(s.utilisation).sort((a, b)=>b[1] - a[1]).map(([stream, ratio])=>`${stream}=${ratio.toFixed(2)}`);
  return [
    "fleet-summary:",
    `wall=${s.wallSeconds}s`,
    `idle=${s.idleSeconds}s`,
    `idle_pct=${idlePct}`,
    `occupied=${s.occupiedSeconds}s`,
    `busy=${s.busySeconds}s`,
    // `usage_blocked`, not `token_blocked` (both here and as the block-kind
    // identifier that keys `idle_by_reason` / `blocked_by_reason`): the
    // secret redactor masks the value of any `key=value` whose key contains
    // TOKEN, so this line went out with `***REDACTED***` where the one metric
    // that answers "is a subscription being drained?" should be. The rule is
    // right to be blunt — `PASSWORD=12345` must stay masked — so the metric
    // is renamed rather than the rule loosened. `usage` is the vocabulary the
    // signal kind already uses (`signalKind === "usage"`).
    //
    // The persisted sidecar fields keep their `tokenBlocked*` names: they are
    // JSON state that accumulates across runs, and renaming them would orphan
    // every prior file's accumulated value.
    `usage_blocked=${s.tokenBlockedSeconds}s`,
    `usage_blocked_waits=${s.tokenBlockedWaits}`,
    `rate_limited=${s.rateLimitedSeconds}s`,
    `rate_limit_waits=${s.rateLimitWaits}`,
    `claims=${s.claims}`,
    `successes=${s.successes}`,
    `failures=${s.failures}`,
    `skips=${s.skips}`,
    // Issue #2297: a run whose every heartbeat hook failed no longer reads as
    // a clean `successes=2 failures=0`.
    `hook_failures=${s.hookFailures}`,
    `success_rate=${s.successRate === null ? "n/a" : s.successRate.toFixed(2)}`,
    // Issue #2347: the pilot's per-host `issue`-phase counters. `issue_usd`
    // carries four decimals because a cheap run's spend is cents, and
    // `issue_duration` is reported beside the cost with no threshold of its
    // own — it describes the runs, it does not gate them. None of these keys
    // trips the secret redactor's `key=value` rule (see `usage_blocked`
    // above); `fleet_telemetry_redaction_test.ts` is what holds that.
    `issue_runs=${s.issuePhaseRuns}`,
    `issue_split_runs=${s.issuePhaseSplitRuns}`,
    `issue_usd=${s.issuePhaseUsd.toFixed(4)}`,
    `issue_gate_first_attempt_passes=${s.issuePhaseFirstAttemptGatePasses}`,
    `issue_duration=${s.issuePhaseDurationSeconds}s`,
    // Issues #3403, #3404: shown only once a haiku run is recorded, so a
    // sonnet-only fleet's summary line is unchanged.
    ...s.issuePhaseHaikuRuns > 0 ? [
      `issue_tier_runs=sonnet=${s.issuePhaseSonnetRuns},haiku=${s.issuePhaseHaikuRuns}`,
      `issue_tier_usd=sonnet=${s.issuePhaseSonnetUsd.toFixed(4)},haiku=${s.issuePhaseHaikuUsd.toFixed(4)}`,
      `pr_tier_rejections=sonnet=${s.prRejectionsSonnet},haiku=${s.prRejectionsHaiku}`,
      `ci_fix_tier_runs=sonnet=${s.ciFixRunsSonnet},haiku=${s.ciFixRunsHaiku}`,
      `ci_fix_tier_usd=sonnet=${s.ciFixUsdSonnet.toFixed(4)},haiku=${s.ciFixUsdHaiku.toFixed(4)}`,
      `pr_feedback_tier_usd=sonnet=${s.prFeedbackUsdSonnet.toFixed(4)},haiku=${s.prFeedbackUsdHaiku.toFixed(4)}`,
      `merged_tier_prs=sonnet=${s.mergedPrsSonnet},haiku=${s.mergedPrsHaiku}`,
      `cost_per_merged_pr=sonnet=${costPerMergedPr(s.issuePhaseSonnetUsd + s.prFeedbackUsdSonnet + s.ciFixUsdSonnet, s.mergedPrsSonnet)},haiku=${costPerMergedPr(s.issuePhaseHaikuUsd + s.prFeedbackUsdHaiku + s.ciFixUsdHaiku, s.mergedPrsHaiku)}`
    ] : [],
    `idle_by_reason=${joinCounts(s.idleByReason, "s")}`,
    `failures_by_class=${joinCounts(s.failuresByClass, "")}`,
    `utilisation=${utilisation.length > 0 ? utilisation.join(",") : "none"}`,
    // Issue #4236: omitted at zero so a fleet that raised no such record
    // keeps the summary line it had. The count is not part of `failures`.
    ...preprReviewChangesRequested > 0 ? [
      `prepr_review_changes_requested=${preprReviewChangesRequested}`
    ] : []
  ].join(" ");
}
/**
 * The census's per-repo deferral counts, in the order they are consulted
 * when the fleet was scanned but claimed nothing. Ties break on this
 * order, so the attribution is deterministic.
 */ const DEFERRAL_REASONS = [
  [
    "dependencyBlocked",
    "dependency_blocked"
  ],
  [
    "streamOccupied",
    "stream_occupied"
  ],
  [
    "prBlocked",
    "pr_blocked"
  ],
  [
    "runLocalHold",
    "cooldown_local"
  ],
  [
    "lowPrioritySuppressed",
    "low_priority_suppressed"
  ],
  [
    "workOnSuppressed",
    "work_on_suppressed"
  ]
];
/**
 * Reduce a cycle's per-repo census rows to the single reason the fleet was
 * idle. The most frequent skip reason wins, ties breaking on first-seen
 * order.
 *
 * The census only ever sets a skip reason for the claim gates
 * (`host_disk_low`, `work_volume_fault`, `cycle_deadline`) — every other
 * repo reads `scanned`, so stopping there would leave the reasons the
 * issue actually names (dependency-blocked, PR-blocked, stream-occupied)
 * permanently unreachable. A scanned fleet is therefore split further:
 *
 *   - unblocked priority work is still open → `nothing_claimable_backlog`,
 *     the idle-vs-work-on inversion, and the fault worth alerting on;
 *   - otherwise the dominant per-repo deferral count names the reason;
 *   - otherwise there was genuinely nothing to claim →
 *     `nothing_claimable_empty`.
 */ export function deriveIdleReason(entries) {
  const first = entries[0];
  if (first === undefined) return "unknown";
  const counts = new Map();
  for (const entry of entries){
    counts.set(entry.skipReason, (counts.get(entry.skipReason) ?? 0) + 1);
  }
  let winner = first.skipReason;
  let best = counts.get(winner) ?? 0;
  for (const entry of entries){
    const count = counts.get(entry.skipReason) ?? 0;
    if (count > best) {
      winner = entry.skipReason;
      best = count;
    }
  }
  if (winner !== "scanned") return winner;
  const scanned = entries.filter((entry)=>entry.skipReason === "scanned");
  if (scanned.some((entry)=>entry.inversionSignal === true)) {
    return "nothing_claimable_backlog";
  }
  let dominant;
  let dominantCount = 0;
  for (const [field, reason] of DEFERRAL_REASONS){
    const total = scanned.reduce((sum, entry)=>sum + (typeof entry[field] === "number" ? entry[field] : 0), 0);
    if (total > dominantCount) {
      dominant = reason;
      dominantCount = total;
    }
  }
  return dominant ?? "nothing_claimable_empty";
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9mbGVldF90ZWxlbWV0cnkudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBGbGVldC1sZXZlbCBvcGVyYXRpb25hbCB0ZWxlbWV0cnkgKElzc3VlICM4NTUpLlxuICpcbiAqIFBlci1ydW4gdGVsZW1ldHJ5IGFscmVhZHkgYW5zd2VyZWQgXCJ3aGF0IGRpZCB0aGlzIHJ1biBkb1wiLiBGb3VyIGZsZWV0XG4gKiBxdWVzdGlvbnMgaGFkIG5vIHJlY29yZGVkIGFuc3dlciBhdCBhbGwsIGFuZCBlYWNoIG5lZWRlZCBhZC1ob2NcbiAqIGBncmVwYC9gYXdrYCBvdmVyIHJvdGF0ZWQgbG9ncyB0byBhcHByb3hpbWF0ZTpcbiAqXG4gKiAgIDEuIEhvdyBsb25nIHdhcyB0aGUgZmxlZXQgaWRsZSDigJQgYW5kIHdoeT9cbiAqICAgMi4gSG93IGxvbmcgd2FzIGl0IGJsb2NrZWQgd2FpdGluZyBmb3IgbW9kZWwgdG9rZW5zIC8gdXNhZ2UgbGltaXRzP1xuICogICAzLiBIb3cgbG9uZyB3YXMgaXQgYmxvY2tlZCBvbiBHaXRIdWIgcmF0ZSBsaW1pdHM/XG4gKiAgIDQuIFdoYXQgaXMgdGhlIHN1Y2Nlc3MgdnMgZmFpbHVyZSByYXRlP1xuICpcbiAqIFRoaXMgbW9kdWxlIGFjY3VtdWxhdGVzIHRob3NlIG51bWJlcnMgYWNyb3NzIGN5Y2xlcyBhbmQgZm9ybWF0cyBvbmVcbiAqIG1hY2hpbmUtcmVhZGFibGUgc3VtbWFyeSBsaW5lLCBzbyBhIHRyZW5kIGNhbiBiZSBwbG90dGVkIGluc3RlYWQgb2ZcbiAqIGV5ZWJhbGxlZDpcbiAqXG4gKiAgIGZsZWV0LXN1bW1hcnk6IHdhbGw9OTI1MjBzIGlkbGU9Mzk2MDBzIGlkbGVfcGN0PTQyLjggYnVzeT01MjkyMHMg4oCmXG4gKlxuICogU2FtZSBsaWZlY3ljbGUgYXMgYGN5Y2xlX3RpbWluZ3MudHNgIGFuZCBgZ2hfY2FsbF9tZXRyaWNzLnRzYDpcbiAqIHByb2Nlc3Mtd2lkZSBtb2R1bGUgc3RhdGUsIGRyaXZlbiBieSB0aGUgbWFpbiBsb29wLiBVbmxpa2UgdGhvc2UgdHdvIGl0XG4gKiBpcyAqKm5vdCoqIHJlc2V0IHBlciBjeWNsZSDigJQgdGhlIHdob2xlIHBvaW50IGlzIGFjY3VtdWxhdGlvbi4gRHVyYWJsZVxuICogY3Jvc3MtcnVuIHRvdGFscyBsaXZlIGluIGBmbGVldF90ZWxlbWV0cnlfc2lkZWNhci50c2AuXG4gKlxuICogQWNjb3VudGluZyBtb2RlbC4gVGhlIHJ1bidzIHdhbGwgdGltZSBpcyBwYXJ0aXRpb25lZCBpbnRvIHRocmVlXG4gKiBub24tb3ZlcmxhcHBpbmcgc3BhbnMsIHNvIGB3YWxsIOKJiCBvY2N1cGllZCArIGJsb2NrZWQgKyBpZGxlYDpcbiAqXG4gKiAgIC0gKipvY2N1cGllZCoqIOKAlCB3YWxsIHRpbWUgZHVyaW5nIHdoaWNoICoqYXQgbGVhc3Qgb25lKiogd29yayBzdHJlYW1cbiAqICAgICBoZWxkIGEgY2xhaW0uIERlbGliZXJhdGVseSBub3QgdGhlIHN1bSBvZiBwZXItc3RyZWFtIGJ1c3kgdGltZTogd2l0aFxuICogICAgIGFuIE4tc2xvdCBwb29sLCBzdW1taW5nIGNvbmN1cnJlbnQgc3RyZWFtcyBvdmVyc2hvb3RzIHRoZSB3YWxsIGNsb2NrXG4gKiAgICAgYW5kIHdvdWxkIGRyaXZlIGlkbGUgdG8gemVybyBvbiBhIGhhbGYtaWRsZSBwb29sLlxuICogICAtICoqYmxvY2tlZCoqIOKAlCB3YWxsIHRpbWUgdGhlIGxvb3Agc3BlbnQgcGF1c2VkIGJldHdlZW4gcnVucyBvbiBhXG4gKiAgICAgR2l0SHViIHJhdGUgbGltaXQgKGByYXRlX2xpbWl0ZWRgKSBvciBhIG1vZGVsIHVzYWdlIGxpbWl0XG4gKiAgICAgKGB1c2FnZV9ibG9ja2VkYCkuXG4gKiAgIC0gKippZGxlKiog4oCUIGV2ZXJ5dGhpbmcgZWxzZSAoc2Nhbm5pbmcsIG1haW50ZW5hbmNlIHBhc3NlcywgdGhlXG4gKiAgICAgZW5kLW9mLWN5Y2xlIHNsZWVwKSwgYXR0cmlidXRlZCB0byB0aGUgcmVhc29uIHRoZSBjeWNsZSBjbGFpbWVkXG4gKiAgICAgbm90aGluZy5cbiAqXG4gKiBCbG9ja2VkIHNwYW5zIGFyZSBhbHNvIGlkbGUgcmVhc29ucywgc28gYGlkbGVfYnlfcmVhc29uYCBzdW1zIHRvXG4gKiBgaWRsZV9zZWNvbmRzYCBleGFjdGx5IGFuZCBub3RoaW5nIGlzIGRvdWJsZSBjb3VudGVkLlxuICpcbiAqIGBidXN5X2J5X3N0cmVhbWAgYW5kIGB1dGlsaXNhdGlvbmAgYXJlIHJlcG9ydGVkICoqcGVyIHN0cmVhbSoqIGFuZCBzbyBkb1xuICogb3ZlcmxhcCBlYWNoIG90aGVyIHVuZGVyIGNvbmN1cnJlbmN5IOKAlCB0aGF0IGlzIHRoZSBwb2ludCBvZiBhIHBlci1zdHJlYW1cbiAqIG51bWJlci4gT25seSBgb2NjdXBpZWRgIGlzIHVzZWQgZm9yIHRoZSBpZGxlIGFyaXRobWV0aWMuXG4gKlxuICogT25lIGRlbGliZXJhdGUgb3ZlcmxhcDogYSBibG9jayB0aGF0IGhhcHBlbnMgKmluc2lkZSogYSBydW4gKHRoZSBhZ2VudCdzXG4gKiBvd24gcmF0ZS1saW1pdCByZXRyeSBsYWRkZXIgc2xlZXBzIGluLXByb2Nlc3MpIGlzIGNvdW50ZWQgaW5cbiAqIGB1c2FnZV9ibG9ja2VkX3NlY29uZHNgIC8gYHJhdGVfbGltaXRlZF9zZWNvbmRzYCwgYmVjYXVzZSB0aGUgaXNzdWUgYXNrc1xuICogaG93IGxvbmcgdGhlIGZsZWV0IHdhcyBibG9ja2VkIG9uIHRva2VucywgYnV0IGlzICoqbm90KiogYWRkZWQgdG9cbiAqIGBpZGxlX2J5X3JlYXNvbmAg4oCUIHRoZSBmbGVldCB3YXMgaG9sZGluZyBhIGNsYWltLCBub3QgaWRsZS4gU28gdGhlXG4gKiBibG9ja2VkIHRvdGFscyBjYW4gZXhjZWVkIHRoZSBibG9ja2VkIHNoYXJlIG9mIGBpZGxlX3NlY29uZHNgLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVwb0NlbnN1c1NraXBSZWFzb24gfSBmcm9tIFwiLi9pZGxlX2RlY2lzaW9uX2NlbnN1cy50c1wiO1xuaW1wb3J0IHR5cGUgeyBJc3N1ZVN1YkFnZW50VGllciB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuXG4vKipcbiAqIFdoeSB0aGUgZmxlZXQgd2FzIGlkbGUuIFRoZSBjZW5zdXMncyBvd24gc2tpcCByZWFzb25zIGFyZSByZXVzZWRcbiAqIHZlcmJhdGltIChtaW51cyBgc2Nhbm5lZGAsIHdoaWNoIGRlc2NyaWJlcyBhIHJlcG8gcmF0aGVyIHRoYW4gYVxuICogdmVyZGljdCksIHBsdXMgdGhlIHJlYXNvbnMgdGhlIGNlbnN1cyBleHByZXNzZXMgYXMgcGVyLXJlcG8gY291bnRzXG4gKiByYXRoZXIgdGhhbiBhcyBhIHNraXAgcmVhc29uLCBhbmQgdGhlIGZsZWV0LWxldmVsIHJlYXNvbnMgaXQgY2Fubm90XG4gKiBleHByZXNzIGF0IGFsbC5cbiAqL1xuZXhwb3J0IHR5cGUgRmxlZXRJZGxlUmVhc29uID1cbiAgfCBFeGNsdWRlPFJlcG9DZW5zdXNTa2lwUmVhc29uLCBcInNjYW5uZWRcIj5cbiAgLyoqIFRoZSBzY2FuIGNvbXBsZXRlZCBhbmQgdW5ibG9ja2VkIHByaW9yaXR5IHdvcmsgd2FzIHN0aWxsIG9wZW4uICovXG4gIHwgXCJub3RoaW5nX2NsYWltYWJsZV9iYWNrbG9nXCJcbiAgLyoqIFRoZSBzY2FuIGNvbXBsZXRlZCBhbmQgdGhlcmUgd2FzIHNpbXBseSBub3RoaW5nIG9wZW4gdG8gY2xhaW0uICovXG4gIHwgXCJub3RoaW5nX2NsYWltYWJsZV9lbXB0eVwiXG4gIC8qKiBFdmVyeSBjYW5kaWRhdGUgd2FzIGhlbGQgYmFjayBieSBhbiBvcGVuIFBSIG5hbWluZyBpdC4gKi9cbiAgfCBcInByX2Jsb2NrZWRcIlxuICAvKiogRXZlcnkgY2FuZGlkYXRlIHdhcyBhIGBsb3ctcHJpb3JpdHlgIGlzc3VlIGEgYHdvcmstb25gIHN1cHByZXNzZWQuICovXG4gIHwgXCJsb3dfcHJpb3JpdHlfc3VwcHJlc3NlZFwiXG4gIC8qKlxuICAgKiBFdmVyeSBjYW5kaWRhdGUgd2FzIGEgYHdvcmstb25gIGlzc3VlIGBzZWxlY3RIaWdoZXN0UHJpb3JpdHlgIHBhcmtlZFxuICAgKiBiZWNhdXNlIGEgUFItYmxvY2tlZCB0b3AtcHJpb3JpdHkgaXNzdWUgaGVsZCBpdHMgcmVwbyttaWxlc3RvbmUgc3RyZWFtXG4gICAqIChJc3N1ZSAjMjkyMikuXG4gICAqL1xuICB8IFwid29ya19vbl9zdXBwcmVzc2VkXCJcbiAgLyoqIE5vbi1idXN5IHJlbWFpbmRlciBvZiBhIGN5Y2xlIHRoYXQgZGlkIGNsYWltIGFuZCBzZXJ2ZSB3b3JrLiAqL1xuICB8IFwic2VydmVkXCJcbiAgLyoqIFBhdXNlZCBvbiBhIEdpdEh1YiByYXRlIGxpbWl0LiAqL1xuICB8IFwicmF0ZV9saW1pdGVkXCJcbiAgLyoqIFBhdXNlZCBvbiBhIG1vZGVsIHVzYWdlL3F1b3RhIGxpbWl0LiAqL1xuICB8IFwidXNhZ2VfYmxvY2tlZFwiO1xuXG4vKiogVGhlIGtpbmRzIG9mIGJsb2NrIHRoYXQgc3RvcCB0aGUgZmxlZXQgY2xhaW1pbmcgd29yay4gKi9cbmV4cG9ydCB0eXBlIEZsZWV0QmxvY2tLaW5kID0gXCJyYXRlX2xpbWl0ZWRcIiB8IFwidXNhZ2VfYmxvY2tlZFwiO1xuXG4vKiogVGVybWluYWwgb3V0Y29tZSBvZiBvbmUgY2xhaW1lZCBpc3N1ZS4gKi9cbmV4cG9ydCB0eXBlIEZsZWV0UnVuT3V0Y29tZSA9IFwic3VjY2Vzc1wiIHwgXCJmYWlsdXJlXCIgfCBcInNraXBcIjtcblxuLyoqXG4gKiBQZXItaG9zdCBgaXNzdWVgLXBoYXNlIGNvdW50ZXJzIChJc3N1ZSAjMjM0NywgcGFydCBvZiAjMjMyMCkuXG4gKlxuICogVGhlIGFkdmlzb3IvZXhlY3V0b3IgcGlsb3QgY29tcGFyZXMgb25lIGhvc3QgYWdhaW5zdCB0aGUgY29udHJvbCBob3N0cywgYW5kXG4gKiBgc3VjY2Vzc2VzYCAvIGBmYWlsdXJlc2AgLyBgc3VjY2Vzc1JhdGVgIGNhcnJ5IG5vIGNvc3QgYW5kIG5vIHF1YWxpdHkgc2lnbmFsXG4gKiDigJQgc28gdGhlIGNvbXBhcmlzb24gaGFkIG5vIHBlci1ob3N0IHNvdXJjZSBzaG9ydCBvZiByZWFkaW5nIGV2ZXJ5IHJ1bi1zdGF0c1xuICogY29tbWVudCBvbiBldmVyeSBpc3N1ZSB0aGUgZmxlZXQgdG91Y2hlZC4gVGhlc2UgY291bnRlcnMgYXJlIHRoZSBzYW1lXG4gKiBmaWd1cmVzIHRoYXQgY29tbWVudCByZW5kZXJzLCBhY2N1bXVsYXRlZCBwZXIgaG9zdDpcbiAqXG4gKiAgIC0gdGhlIGltcGxlbWVudGF0aW9uIHJ1bnMgdGhpcyBob3N0IGNvbXBsZXRlZCxcbiAqICAgLSB3aGF0IHRoZXkgY29zdCAoZXN0aW1hdGVkIFVTRCwgc3VtbWVkKSxcbiAqICAgLSBob3cgbWFueSBwYXNzZWQgdGhlIHF1YWxpdHkgZ2F0ZSBvbiB0aGUgKipmaXJzdCoqIGF0dGVtcHQg4oCUIHNvIHRoZVxuICogICAgIGZpcnN0LWF0dGVtcHQgcGFzcyByYXRlIGlzIGEgZGl2aXNpb24gb2YgdHdvIHJlY29yZGVkIG51bWJlcnMgcmF0aGVyXG4gKiAgICAgdGhhbiBhIGdyZXAsXG4gKiAgIC0gaG93IGxvbmcgdGhleSB0b29rLCByZXBvcnRlZCBiZXNpZGUgdGhlIGNvc3QgYW5kIGdhdGluZyBub3RoaW5nLFxuICogICAtIGhvdyBtYW55IG9mIHRoZW0gaGFkIHRoZSBleGVjdXRvciBzcGxpdCBvbiwgc28gYSBoYWxmLWNvbmZpZ3VyZWQgaG9zdFxuICogICAgIGlzIHZpc2libGUgaW5zdGVhZCBvZiBzaWxlbnRseSBhdmVyYWdpbmcgcGlsb3QgYW5kIGNvbnRyb2wgcnVucywgYW5kXG4gKiAgIC0gdGhlIHNhbWUgcnVucyBhbmQgc3BlbmQgc3BsaXQgYnkgdGhlIHJlc29sdmVkIHN1Yi1hZ2VudCB0aWVyXG4gKiAgICAgKGBzb25uZXRgL2BoYWlrdWAsIElzc3VlICMzNDAzKSwgc28gYSB0aWVyIG1pZ3JhdGlvbidzIGNvc3QgYW5kIHZvbHVtZVxuICogICAgIGFyZSB2aXNpYmxlIHdpdGhvdXQgcmVhZGluZyBldmVyeSBydW4tc3RhdHMgY29tbWVudC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBJc3N1ZVBoYXNlQ291bnRlcnMge1xuICAvKiogQ29tcGxldGVkIGBpc3N1ZWAtcGhhc2UgcnVucyByZWNvcmRlZCBvbiB0aGlzIGhvc3QuICovXG4gIGlzc3VlUGhhc2VSdW5zOiBudW1iZXI7XG4gIC8qKiBTdW1tZWQgZXN0aW1hdGVkIHNwZW5kLCBpbiBVU0QsIGFjcm9zcyB0aG9zZSBydW5zLiAqL1xuICBpc3N1ZVBoYXNlVXNkOiBudW1iZXI7XG4gIC8qKiBUaG9zZSBydW5zIHdob3NlIHF1YWxpdHkgZ2F0ZSBwYXNzZWQgb24gYXR0ZW1wdCAxLiAqL1xuICBpc3N1ZVBoYXNlRmlyc3RBdHRlbXB0R2F0ZVBhc3NlczogbnVtYmVyO1xuICAvKiogU3VtbWVkIGR1cmF0aW9uLCBpbiBzZWNvbmRzLCBhY3Jvc3MgdGhvc2UgcnVucy4gR2F0ZXMgbm90aGluZy4gKi9cbiAgaXNzdWVQaGFzZUR1cmF0aW9uU2Vjb25kczogbnVtYmVyO1xuICAvKiogVGhvc2UgcnVucyB0aGF0IGhhZCB0aGUgYWR2aXNvci9leGVjdXRvciBzcGxpdCBvbi4gKi9cbiAgaXNzdWVQaGFzZVNwbGl0UnVuczogbnVtYmVyO1xuICAvKiogVGhvc2UgcnVucyB3aG9zZSByZXNvbHZlZCBzdWItYWdlbnQgdGllciB3YXMgYHNvbm5ldGAgKElzc3VlICMzNDAzKS4gKi9cbiAgaXNzdWVQaGFzZVNvbm5ldFJ1bnM6IG51bWJlcjtcbiAgLyoqIFN1bW1lZCBlc3RpbWF0ZWQgc3BlbmQsIGluIFVTRCwgYWNyb3NzIHRoZSBgc29ubmV0YC10aWVyIHJ1bnMuICovXG4gIGlzc3VlUGhhc2VTb25uZXRVc2Q6IG51bWJlcjtcbiAgLyoqIFRob3NlIHJ1bnMgd2hvc2UgcmVzb2x2ZWQgc3ViLWFnZW50IHRpZXIgd2FzIGBoYWlrdWAgKElzc3VlICMzNDAzKS4gKi9cbiAgaXNzdWVQaGFzZUhhaWt1UnVuczogbnVtYmVyO1xuICAvKiogU3VtbWVkIGVzdGltYXRlZCBzcGVuZCwgaW4gVVNELCBhY3Jvc3MgdGhlIGBoYWlrdWAtdGllciBydW5zLiAqL1xuICBpc3N1ZVBoYXNlSGFpa3VVc2Q6IG51bWJlcjtcbn1cblxuLyoqXG4gKiBQZXItdGllciBQUiBvdXRjb21lIGNvdW50ZXJzIChJc3N1ZSAjMzQwNCk6IHJlamVjdGlvbnMsIENJLWZpeCBhbmRcbiAqIFBSLWZlZWRiYWNrIGVmZm9ydCwgYW5kIG1lcmdlcywgc28gY29zdCBwZXIgbWVyZ2VkIFBSIGlzIGNvbXBhcmFibGUgYWNyb3NzXG4gKiBzdWItYWdlbnQgdGllcnMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJPdXRjb21lQ291bnRlcnMge1xuICAvKiogQXV0aG9yaXNlZCBDSEFOR0VTX1JFUVVFU1RFRCByZXZpZXdzIG9uIFBScyBvZiB0aGUgYHNvbm5ldGAgdGllciAoSXNzdWUgIzM0MDQpLiAqL1xuICBwclJlamVjdGlvbnNTb25uZXQ6IG51bWJlcjtcbiAgLyoqIEF1dGhvcmlzZWQgQ0hBTkdFU19SRVFVRVNURUQgcmV2aWV3cyBvbiBQUnMgb2YgdGhlIGBoYWlrdWAgdGllciAoSXNzdWUgIzM0MDQpLiAqL1xuICBwclJlamVjdGlvbnNIYWlrdTogbnVtYmVyO1xuICAvKiogQ0ktZml4IHJ1bnMgcmVjb3JkZWQgZm9yIFBScyBvZiB0aGUgYHNvbm5ldGAgdGllciAoSXNzdWUgIzM0MDQpLiAqL1xuICBjaUZpeFJ1bnNTb25uZXQ6IG51bWJlcjtcbiAgLyoqIENJLWZpeCBydW5zIHJlY29yZGVkIGZvciBQUnMgb2YgdGhlIGBoYWlrdWAgdGllciAoSXNzdWUgIzM0MDQpLiAqL1xuICBjaUZpeFJ1bnNIYWlrdTogbnVtYmVyO1xuICAvKiogU3VtbWVkIGVzdGltYXRlZCBDSS1maXggc3BlbmQsIGluIFVTRCwgZm9yIHRoZSBgc29ubmV0YCB0aWVyIChJc3N1ZSAjMzQwNCkuICovXG4gIGNpRml4VXNkU29ubmV0OiBudW1iZXI7XG4gIC8qKiBTdW1tZWQgZXN0aW1hdGVkIENJLWZpeCBzcGVuZCwgaW4gVVNELCBmb3IgdGhlIGBoYWlrdWAgdGllciAoSXNzdWUgIzM0MDQpLiAqL1xuICBjaUZpeFVzZEhhaWt1OiBudW1iZXI7XG4gIC8qKiBQUi1mZWVkYmFjayBydW5zIHJlY29yZGVkIGZvciBQUnMgb2YgdGhlIGBzb25uZXRgIHRpZXIgKElzc3VlICMzNDA0KS4gKi9cbiAgcHJGZWVkYmFja1J1bnNTb25uZXQ6IG51bWJlcjtcbiAgLyoqIFBSLWZlZWRiYWNrIHJ1bnMgcmVjb3JkZWQgZm9yIFBScyBvZiB0aGUgYGhhaWt1YCB0aWVyIChJc3N1ZSAjMzQwNCkuICovXG4gIHByRmVlZGJhY2tSdW5zSGFpa3U6IG51bWJlcjtcbiAgLyoqIFN1bW1lZCBlc3RpbWF0ZWQgUFItZmVlZGJhY2sgc3BlbmQsIGluIFVTRCwgZm9yIHRoZSBgc29ubmV0YCB0aWVyIChJc3N1ZSAjMzQwNCkuICovXG4gIHByRmVlZGJhY2tVc2RTb25uZXQ6IG51bWJlcjtcbiAgLyoqIFN1bW1lZCBlc3RpbWF0ZWQgUFItZmVlZGJhY2sgc3BlbmQsIGluIFVTRCwgZm9yIHRoZSBgaGFpa3VgIHRpZXIgKElzc3VlICMzNDA0KS4gKi9cbiAgcHJGZWVkYmFja1VzZEhhaWt1OiBudW1iZXI7XG4gIC8qKiBNZXJnZWQgUFJzIG9mIHRoZSBgc29ubmV0YCB0aWVyIChJc3N1ZSAjMzQwNCkuICovXG4gIG1lcmdlZFByc1Nvbm5ldDogbnVtYmVyO1xuICAvKiogTWVyZ2VkIFBScyBvZiB0aGUgYGhhaWt1YCB0aWVyIChJc3N1ZSAjMzQwNCkuICovXG4gIG1lcmdlZFByc0hhaWt1OiBudW1iZXI7XG59XG5cbi8qKiBPbmUgY29tcGxldGVkIGBpc3N1ZWAtcGhhc2UgcnVuLCBhcyB7QGxpbmsgcmVjb3JkSXNzdWVQaGFzZVJ1bn0gdGFrZXMgaXQuICovXG5leHBvcnQgaW50ZXJmYWNlIElzc3VlUGhhc2VSdW4ge1xuICAvKiogRXN0aW1hdGVkIHNwZW5kIGZvciB0aGUgcnVuLCBpbiBVU0QuIEFic2VudCBjb250cmlidXRlcyBub3RoaW5nLiAqL1xuICB1c2Q/OiBudW1iZXI7XG4gIC8qKlxuICAgKiBXaGljaCBvZiB0aGUgcXVhbGl0eSBnYXRlJ3MgYm91bmRlZCBhdHRlbXB0cyBwYXNzZWQuIE9ubHkgYDFgIGNvdW50c1xuICAgKiB0b3dhcmRzIHtAbGluayBJc3N1ZVBoYXNlQ291bnRlcnMuaXNzdWVQaGFzZUZpcnN0QXR0ZW1wdEdhdGVQYXNzZXN9LCBzb1xuICAgKiB0aGUgcmVjb3JkZWQgY291bnQgY2FuIG5ldmVyIGRpdmVyZ2UgZnJvbSB0aGUgcmVjb3JkZWQgYXR0ZW1wdC4gQWJzZW50IOKAlFxuICAgKiBhIHJ1biB0aGF0IG5ldmVyIHJlYWNoZWQgdGhlIGdhdGUsIG9yIG5ldmVyIHBhc3NlZCBpdCDigJQgY291bnRzIG5vdGhpbmcuXG4gICAqL1xuICBnYXRlUGFzc2VkT25BdHRlbXB0PzogbnVtYmVyO1xuICAvKiogUnVuIGR1cmF0aW9uIGluIHNlY29uZHMuIEFic2VudCBjb250cmlidXRlcyBub3RoaW5nLiAqL1xuICBkdXJhdGlvblNlY29uZHM/OiBudW1iZXI7XG4gIC8qKiBXaGV0aGVyIHRoZSBhZHZpc29yL2V4ZWN1dG9yIHNwbGl0IHdhcyBvbiBmb3IgdGhlIHJ1bi4gKi9cbiAgc3BsaXQ/OiBib29sZWFuO1xuICAvKiogVGhlIHN1Yi1hZ2VudCB0aWVyIHRoZSBydW4gcmVzb2x2ZWQgKElzc3VlICMzNDAzKS4gKi9cbiAgc3ViQWdlbnRUaWVyOiBJc3N1ZVN1YkFnZW50VGllcjtcbn1cblxuLyoqIEFkZGl0aXZlIHRvdGFscyDigJQgdGhlIGZpZWxkcyB0aGF0IGNhbiBiZSBzdW1tZWQgYWNyb3NzIHJ1bnMuICovXG5leHBvcnQgaW50ZXJmYWNlIEZsZWV0VGVsZW1ldHJ5VG90YWxzXG4gIGV4dGVuZHMgSXNzdWVQaGFzZUNvdW50ZXJzLCBQck91dGNvbWVDb3VudGVycyB7XG4gIC8qKiBXYWxsIHNlY29uZHMgb2JzZXJ2ZWQuICovXG4gIHdhbGxTZWNvbmRzOiBudW1iZXI7XG4gIC8qKiBTZWNvbmRzIHdpdGggbm8gaXNzdWUgYmVpbmcgd29ya2VkLiAqL1xuICBpZGxlU2Vjb25kczogbnVtYmVyO1xuICAvKiogSWRsZSBzZWNvbmRzIHNwbGl0IGJ5IHJlYXNvbjsgc3VtcyB0byBgaWRsZVNlY29uZHNgLiAqL1xuICBpZGxlQnlSZWFzb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XG4gIC8qKlxuICAgKiBXYWxsIHNlY29uZHMgd2l0aCBhdCBsZWFzdCBvbmUgc3RyZWFtIGhvbGRpbmcgYSBjbGFpbS4gVGhpcyDigJQgbm90XG4gICAqIHtAbGluayBGbGVldFRlbGVtZXRyeVRvdGFscy5idXN5U2Vjb25kc30g4oCUIGlzIHdoYXQgaWRsZSBpcyBtZWFzdXJlZFxuICAgKiBhZ2FpbnN0LCBzbyBhIGhhbGYtaWRsZSBwb29sIGlzIG5vdCByZXBvcnRlZCBhcyBmdWxseSBidXN5LlxuICAgKi9cbiAgb2NjdXBpZWRTZWNvbmRzOiBudW1iZXI7XG4gIC8qKlxuICAgKiBTZWNvbmRzIHNwZW50IGluc2lkZSBgcHJvY2Vzc0lzc3VlYCwgc3VtbWVkIG92ZXIgc3RyZWFtcy4gT3ZlcmxhcHNcbiAgICogaXRzZWxmIHVuZGVyIGNvbmN1cnJlbmN5IGFuZCBjYW4gZXhjZWVkIGB3YWxsU2Vjb25kc2AuXG4gICAqL1xuICBidXN5U2Vjb25kczogbnVtYmVyO1xuICAvKiogQnVzeSBzZWNvbmRzIHBlciB3b3JrIHN0cmVhbS4gKi9cbiAgYnVzeUJ5U3RyZWFtOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICAvKiogU2Vjb25kcyBwYXVzZWQgb24gYSBtb2RlbCB1c2FnZS9xdW90YSBsaW1pdC4gKi9cbiAgdG9rZW5CbG9ja2VkU2Vjb25kczogbnVtYmVyO1xuICAvKiogU2Vjb25kcyBwYXVzZWQgb24gYSBHaXRIdWIgcmF0ZSBsaW1pdC4gKi9cbiAgcmF0ZUxpbWl0ZWRTZWNvbmRzOiBudW1iZXI7XG4gIC8qKiBIb3cgbWFueSB0aW1lcyBhIEdpdEh1YiByYXRlLWxpbWl0IGJhY2tvZmYgd2FzIHNlcnZlZC4gKi9cbiAgcmF0ZUxpbWl0V2FpdHM6IG51bWJlcjtcbiAgLyoqIEhvdyBtYW55IHRpbWVzIGEgbW9kZWwgdXNhZ2UtbGltaXQgcGF1c2Ugd2FzIHNlcnZlZC4gKi9cbiAgdG9rZW5CbG9ja2VkV2FpdHM6IG51bWJlcjtcbiAgLyoqIElzc3VlcyBjbGFpbWVkLiAqL1xuICBjbGFpbXM6IG51bWJlcjtcbiAgLyoqIENsYWltZWQgaXNzdWVzIHdob3NlIHJ1biBzdWNjZWVkZWQuICovXG4gIHN1Y2Nlc3NlczogbnVtYmVyO1xuICAvKiogQ2xhaW1lZCBpc3N1ZXMgd2hvc2UgcnVuIGZhaWxlZC4gKi9cbiAgZmFpbHVyZXM6IG51bWJlcjtcbiAgLyoqIENsYWltcyB0aGF0IG5ldmVyIHJhbiAoaXNzdWUgdW5hdmFpbGFibGUsIGV4cGVjdGVkIGJvdW5jZSkuICovXG4gIHNraXBzOiBudW1iZXI7XG4gIC8qKiBGYWlsdXJlcyBieSBjbGFzcyDigJQgdGhlIGZhaWxpbmcgcGhhc2UsIG9yIGB0aW1lb3V0YC4gKi9cbiAgZmFpbHVyZXNCeUNsYXNzOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xufVxuXG4vKipcbiAqIFRvdGFscyBhcyBhICoqcHJpb3IqKiBzaWRlY2FyIGNhcnJpZXMgdGhlbSAoSXNzdWUgIzIzNDcpLlxuICpcbiAqIEEgc25hcHNob3Qgd3JpdHRlbiBiZWZvcmUgdGhlIGlzc3VlLXBoYXNlIGNvdW50ZXJzIGV4aXN0ZWQgY2FycmllcyBub25lIG9mXG4gKiB0aGVtLCBzbyB0aGV5IGFyZSBvcHRpb25hbCBoZXJlIGFuZCByZWFkIGFzIHplcm8g4oCUIGFuIG9sZGVyIGZpbGUgbG9hZHMgYW5kXG4gKiBtZXJnZXMgaW5zdGVhZCBvZiBwb2lzb25pbmcgZXZlcnkgY3VtdWxhdGl2ZSB0b3RhbCB3aXRoIGBOYU5gLlxuICovXG5leHBvcnQgdHlwZSBQcmlvckZsZWV0VGVsZW1ldHJ5VG90YWxzID1cbiAgJiBPbWl0PFxuICAgIEZsZWV0VGVsZW1ldHJ5VG90YWxzLFxuICAgIGtleW9mIElzc3VlUGhhc2VDb3VudGVycyB8IGtleW9mIFByT3V0Y29tZUNvdW50ZXJzXG4gID5cbiAgJiBQYXJ0aWFsPElzc3VlUGhhc2VDb3VudGVycz5cbiAgJiBQYXJ0aWFsPFByT3V0Y29tZUNvdW50ZXJzPjtcblxuLyoqIFRvdGFscyBwbHVzIHRoZSBkZXJpdmVkIHJhdGVzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBGbGVldFRlbGVtZXRyeVNuYXBzaG90IGV4dGVuZHMgRmxlZXRUZWxlbWV0cnlUb3RhbHMge1xuICAvKipcbiAgICogTW9ub3RvbmljIGlkZW50aWZpZXIgZm9yIHRoZSBjdXJyZW50IGFjY3VtdWxhdGlvbiB3aW5kb3cuIEJ1bXBlZCBieVxuICAgKiB7QGxpbmsgcmVzZXRGbGVldFRlbGVtZXRyeX0gYW5kIHtAbGluayBzdGFydEZsZWV0VGVsZW1ldHJ5fSBzbyB0aGVcbiAgICogc2lkZWNhciBjYW4gdGVsbCBcImFub3RoZXIgd3JpdGUgaW4gdGhpcyBydW5cIiBmcm9tIFwiYSBuZXcgcnVuXCIuXG4gICAqL1xuICBydW5Ub2tlbjogbnVtYmVyO1xuICAvKipcbiAgICogUG9zdC1ydW4gY2FsbGJhY2sgaW52b2NhdGlvbnMgdGhhdCBkaWQgbm90IGV4aXQgMCB0aGlzIHJ1biAoSXNzdWUgIzIyOTcpLlxuICAgKlxuICAgKiBEZWxpYmVyYXRlbHkgb24gdGhlIHNuYXBzaG90IHJhdGhlciB0aGFuIHtAbGluayBGbGVldFRlbGVtZXRyeVRvdGFsc306IGl0XG4gICAqIGRlc2NyaWJlcyB0aGlzIGhvc3QncyBob29rIGRlcGxveW1lbnQgcmlnaHQgbm93LCBub3Qgd29yayB0aGUgZmxlZXQgZGlkLFxuICAgKiBhbmQgdGhlIGR1cmFibGUgc2lkZWNhciBhY2N1bXVsYXRlcyB0aGUgbGF0dGVyIGFjcm9zcyBydW5zLlxuICAgKi9cbiAgaG9va0ZhaWx1cmVzOiBudW1iZXI7XG4gIC8qKiBgc3VjY2Vzc2VzIC8gKHN1Y2Nlc3NlcyArIGZhaWx1cmVzKWAsIG9yIGBudWxsYCBiZWZvcmUgYW55IHJ1biBlbmRzLiAqL1xuICBzdWNjZXNzUmF0ZTogbnVtYmVyIHwgbnVsbDtcbiAgLyoqIGBidXN5U2Vjb25kcyAvIHdhbGxTZWNvbmRzYCBwZXIgc3RyZWFtLiAqL1xuICB1dGlsaXNhdGlvbjogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbn1cblxuLyoqXG4gKiBPbmUgY2Vuc3VzIHJvdywgcmVkdWNlZCB0byB3aGF0IHRoZSBmbGVldCByZWFzb24gZGVyaXZhdGlvbiBuZWVkcy4gVGhlXG4gKiBwZXItcmVwbyBkZWZlcnJhbCBjb3VudHMgYXJlIG9wdGlvbmFsIHNvIGEgY2FsbGVyIHdpdGggb25seSBhIHNraXBcbiAqIHJlYXNvbiBzdGlsbCB3b3JrczsgYFJlcG9DZW5zdXNFbnRyeWAgc2F0aXNmaWVzIHRoaXMgc2hhcGUgYXMtaXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2Vuc3VzUmVhc29uSW5wdXQge1xuICBza2lwUmVhc29uOiBSZXBvQ2Vuc3VzU2tpcFJlYXNvbjtcbiAgLyoqIFRoZSByZXBvIGhvbGRzIOKJpTEgdW5ibG9ja2VkIGB0b3AtcHJpb3JpdHlgL2B3b3JrLW9uYC9gbG93LXByaW9yaXR5YC4gKi9cbiAgaW52ZXJzaW9uU2lnbmFsPzogYm9vbGVhbjtcbiAgZGVwZW5kZW5jeUJsb2NrZWQ/OiBudW1iZXI7XG4gIHByQmxvY2tlZD86IG51bWJlcjtcbiAgc3RyZWFtT2NjdXBpZWQ/OiBudW1iZXI7XG4gIHJ1bkxvY2FsSG9sZD86IG51bWJlcjtcbiAgbG93UHJpb3JpdHlTdXBwcmVzc2VkPzogbnVtYmVyO1xuICAvKipcbiAgICogYHdvcmstb25gIGlzc3VlcyBgc2VsZWN0SGlnaGVzdFByaW9yaXR5YCBwYXJrZWQgYmVjYXVzZSBhIFBSLWJsb2NrZWRcbiAgICogdG9wLXByaW9yaXR5IGlzc3VlIGhlbGQgdGhlaXIgcmVwbyttaWxlc3RvbmUgc3RyZWFtIChJc3N1ZSAjMjkyMikuXG4gICAqL1xuICB3b3JrT25TdXBwcmVzc2VkPzogbnVtYmVyO1xufVxuXG4vKiogRmFpbHVyZSBjbGFzcyByZWNvcmRlZCB3aGVuIHRoZSBjYWxsZXIgY291bGQgbm90IG5hbWUgb25lLiAqL1xuY29uc3QgVU5LTk9XTl9GQUlMVVJFX0NMQVNTID0gXCJ1bmtub3duXCI7XG5cbmludGVyZmFjZSBGbGVldFN0YXRlIHtcbiAgcnVuVG9rZW46IG51bWJlcjtcbiAgcnVuU3RhcnRNcz86IG51bWJlcjtcbiAgLyoqIFdhbGwgcG9zaXRpb24gdXAgdG8gd2hpY2ggaWRsZSB0aW1lIGhhcyBiZWVuIGF0dHJpYnV0ZWQuICovXG4gIGNsb3NlZFRocm91Z2hNcz86IG51bWJlcjtcbiAgLyoqIFN0cmVhbXMgY3VycmVudGx5IGhvbGRpbmcgYSBjbGFpbS4gT2NjdXBhbmN5IGlzIFwidGhpcyBpcyA+IDBcIi4gKi9cbiAgYWN0aXZlU3RyZWFtczogbnVtYmVyO1xuICAvKiogV2hlbiB0aGUgZmxlZXQgbGFzdCB3ZW50IGZyb20gdW5vY2N1cGllZCB0byBvY2N1cGllZC4gKi9cbiAgb2NjdXBpZWRTdGFydE1zPzogbnVtYmVyO1xuICAvKiogT2NjdXBpZWQgbWlsbGlzZWNvbmRzIHNpbmNlIHRoZSBsYXN0IGF0dHJpYnV0aW9uLiAqL1xuICBvY2N1cGllZFNpbmNlQ2xvc2VNczogbnVtYmVyO1xuICAvKiogVG90YWwgb2NjdXBpZWQgbWlsbGlzZWNvbmRzIHRoaXMgcnVuLiAqL1xuICBvY2N1cGllZE1zOiBudW1iZXI7XG4gIC8qKiBGbGVldC1sZXZlbCBibG9ja2VkIG1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhdHRyaWJ1dGlvbi4gKi9cbiAgYmxvY2tlZFNpbmNlQ2xvc2VNczogbnVtYmVyO1xuICAvKiogV2hlbiBlYWNoIGFjdGl2ZSBzdHJlYW0gYmVnYW4gaXRzIGN1cnJlbnQgcnVuLiAqL1xuICBzdHJlYW1TdGFydE1zOiBNYXA8c3RyaW5nLCBudW1iZXI+O1xuICBpZGxlTXNCeVJlYXNvbjogTWFwPHN0cmluZywgbnVtYmVyPjtcbiAgYnVzeU1zQnlTdHJlYW06IE1hcDxzdHJpbmcsIG51bWJlcj47XG4gIHRva2VuQmxvY2tlZE1zOiBudW1iZXI7XG4gIHJhdGVMaW1pdGVkTXM6IG51bWJlcjtcbiAgcmF0ZUxpbWl0V2FpdHM6IG51bWJlcjtcbiAgdG9rZW5CbG9ja2VkV2FpdHM6IG51bWJlcjtcbiAgY2xhaW1zOiBudW1iZXI7XG4gIHN1Y2Nlc3NlczogbnVtYmVyO1xuICBmYWlsdXJlczogbnVtYmVyO1xuICBza2lwczogbnVtYmVyO1xuICBmYWlsdXJlc0J5Q2xhc3M6IE1hcDxzdHJpbmcsIG51bWJlcj47XG4gIGhvb2tGYWlsdXJlczogbnVtYmVyO1xuICAvKiogSXNzdWUgIzIzNDcg4oCUIHRoZSBwZXItaG9zdCBgaXNzdWVgLXBoYXNlIHBpbG90IGNvdW50ZXJzLiAqL1xuICBpc3N1ZVBoYXNlOiBJc3N1ZVBoYXNlQ291bnRlcnM7XG4gIC8qKiBJc3N1ZSAjMzQwNCDigJQgcGVyLXRpZXIgUFIgb3V0Y29tZSBjb3VudGVycy4gKi9cbiAgcHJPdXRjb21lczogUHJPdXRjb21lQ291bnRlcnM7XG59XG5cbi8qKiBaZXJvZWQge0BsaW5rIElzc3VlUGhhc2VDb3VudGVyc30g4oCUIHRoZSBzdGFydCBvZiBldmVyeSB3aW5kb3cuICovXG5mdW5jdGlvbiB6ZXJvSXNzdWVQaGFzZUNvdW50ZXJzKCk6IElzc3VlUGhhc2VDb3VudGVycyB7XG4gIHJldHVybiB7XG4gICAgaXNzdWVQaGFzZVJ1bnM6IDAsXG4gICAgaXNzdWVQaGFzZVVzZDogMCxcbiAgICBpc3N1ZVBoYXNlRmlyc3RBdHRlbXB0R2F0ZVBhc3NlczogMCxcbiAgICBpc3N1ZVBoYXNlRHVyYXRpb25TZWNvbmRzOiAwLFxuICAgIGlzc3VlUGhhc2VTcGxpdFJ1bnM6IDAsXG4gICAgaXNzdWVQaGFzZVNvbm5ldFJ1bnM6IDAsXG4gICAgaXNzdWVQaGFzZVNvbm5ldFVzZDogMCxcbiAgICBpc3N1ZVBoYXNlSGFpa3VSdW5zOiAwLFxuICAgIGlzc3VlUGhhc2VIYWlrdVVzZDogMCxcbiAgfTtcbn1cblxuLyoqIFplcm9lZCB7QGxpbmsgUHJPdXRjb21lQ291bnRlcnN9IOKAlCB0aGUgc3RhcnQgb2YgZXZlcnkgd2luZG93LiAqL1xuZnVuY3Rpb24gemVyb1ByT3V0Y29tZUNvdW50ZXJzKCk6IFByT3V0Y29tZUNvdW50ZXJzIHtcbiAgcmV0dXJuIHtcbiAgICBwclJlamVjdGlvbnNTb25uZXQ6IDAsXG4gICAgcHJSZWplY3Rpb25zSGFpa3U6IDAsXG4gICAgY2lGaXhSdW5zU29ubmV0OiAwLFxuICAgIGNpRml4UnVuc0hhaWt1OiAwLFxuICAgIGNpRml4VXNkU29ubmV0OiAwLFxuICAgIGNpRml4VXNkSGFpa3U6IDAsXG4gICAgcHJGZWVkYmFja1J1bnNTb25uZXQ6IDAsXG4gICAgcHJGZWVkYmFja1J1bnNIYWlrdTogMCxcbiAgICBwckZlZWRiYWNrVXNkU29ubmV0OiAwLFxuICAgIHByRmVlZGJhY2tVc2RIYWlrdTogMCxcbiAgICBtZXJnZWRQcnNTb25uZXQ6IDAsXG4gICAgbWVyZ2VkUHJzSGFpa3U6IDAsXG4gIH07XG59XG5cbi8vIFNJTVBMRS1PTi1QVVJQT1NFOiBkZWR1cGUgaXMgcGVyIHRlbGVtZXRyeSB3aW5kb3cgYW5kIGV2ZW50cyBiZWZvcmUgdGhlIHdpbmRvdyBzdGFydCBhcmUgaWdub3JlZCwgc28gYSByZXN0YXJ0IGRvZXMgbm90IHJlLWNvdW50LCBidXQgYW4gZXZlbnQgdGhhdCBoYXBwZW5lZCB3aGlsZSB0aGUgd29ya2VyIHdhcyBkb3duIGlzIG5vdCBjb3VudGVkIOKAlCB1cGdyYWRlIHdoZW4gdGhhdCB1bmRlcmNvdW50IG1hdHRlcnMgKHBlcnNpc3QgYSBzZWVuLXNldCBvciBhIGhpZ2gtd2F0ZXIgbWFyayBpbiB0aGUgc2lkZWNhcilcbmNvbnN0IHNlZW5SZWplY3Rpb25zID0gbmV3IFNldDxzdHJpbmc+KCk7XG5jb25zdCBzZWVuTWVyZ2VkUHJzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbmZ1bmN0aW9uIGVtcHR5U3RhdGUocnVuVG9rZW46IG51bWJlcik6IEZsZWV0U3RhdGUge1xuICByZXR1cm4ge1xuICAgIHJ1blRva2VuLFxuICAgIGFjdGl2ZVN0cmVhbXM6IDAsXG4gICAgb2NjdXBpZWRTaW5jZUNsb3NlTXM6IDAsXG4gICAgb2NjdXBpZWRNczogMCxcbiAgICBibG9ja2VkU2luY2VDbG9zZU1zOiAwLFxuICAgIHN0cmVhbVN0YXJ0TXM6IG5ldyBNYXAoKSxcbiAgICBpZGxlTXNCeVJlYXNvbjogbmV3IE1hcCgpLFxuICAgIGJ1c3lNc0J5U3RyZWFtOiBuZXcgTWFwKCksXG4gICAgdG9rZW5CbG9ja2VkTXM6IDAsXG4gICAgcmF0ZUxpbWl0ZWRNczogMCxcbiAgICByYXRlTGltaXRXYWl0czogMCxcbiAgICB0b2tlbkJsb2NrZWRXYWl0czogMCxcbiAgICBjbGFpbXM6IDAsXG4gICAgc3VjY2Vzc2VzOiAwLFxuICAgIGZhaWx1cmVzOiAwLFxuICAgIHNraXBzOiAwLFxuICAgIGZhaWx1cmVzQnlDbGFzczogbmV3IE1hcCgpLFxuICAgIGhvb2tGYWlsdXJlczogMCxcbiAgICBpc3N1ZVBoYXNlOiB6ZXJvSXNzdWVQaGFzZUNvdW50ZXJzKCksXG4gICAgcHJPdXRjb21lczogemVyb1ByT3V0Y29tZUNvdW50ZXJzKCksXG4gIH07XG59XG5cbmxldCBzdGF0ZTogRmxlZXRTdGF0ZSA9IGVtcHR5U3RhdGUoMCk7XG5cbi8qKlxuICogUHVsbCByZXF1ZXN0cyByYWlzZWQgdGhpcyBwcm9jZXNzIHdpdGggYW4gdW5yZXNvbHZlZCBwcmUtUFIgcmV2aWV3IHJlY29yZFxuICogKElzc3VlICM0MjM2KS4gQ291bnRlZCBvbiB0aGUgZmxlZXQtc3VtbWFyeSBsaW5lIGFuZCBrZXB0IG9mZiBgZmFpbHVyZXNgLlxuICogTm90IHBlcnNpc3RlZDogYSBwcmlvciBzaWRlY2FyIGhhcyBubyBmaWVsZCBmb3IgaXQsIGFuZCB0aGUgbGluZSBvbmx5XG4gKiBuYW1lcyB0aGUgY291bnQgb25jZSBvbmUgaGFzIGJlZW4gcmVjb3JkZWQuXG4gKi9cbmxldCBwcmVwclJldmlld0NoYW5nZXNSZXF1ZXN0ZWQgPSAwO1xuXG4vKiogQWRkIHRoZSBmaW5kaW5ncyBqdXN0IHBvc3RlZCBvbiBhIHByZS1QUiByZXZpZXcgcmVjb3JkIChJc3N1ZSAjNDIzNikuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkUHJlcHJSZXZpZXdDaGFuZ2VzUmVxdWVzdGVkKGNvdW50OiBudW1iZXIpOiB2b2lkIHtcbiAgaWYgKGNvdW50ID4gMCkgcHJlcHJSZXZpZXdDaGFuZ2VzUmVxdWVzdGVkICs9IGNvdW50O1xufVxuXG4vKiogQ2xlYXIgZXZlcnkgYWNjdW11bGF0b3IgYW5kIG9wZW4gYSBuZXcgYWNjdW11bGF0aW9uIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldEZsZWV0VGVsZW1ldHJ5KCk6IHZvaWQge1xuICBzdGF0ZSA9IGVtcHR5U3RhdGUoc3RhdGUucnVuVG9rZW4gKyAxKTtcbiAgc2VlblJlamVjdGlvbnMuY2xlYXIoKTtcbiAgc2Vlbk1lcmdlZFBycy5jbGVhcigpO1xuICBwcmVwclJldmlld0NoYW5nZXNSZXF1ZXN0ZWQgPSAwO1xufVxuXG4vKipcbiAqIE1hcmsgdGhlIHN0YXJ0IG9mIGEgcnVuJ3MgYWNjdW11bGF0aW9uIHdpbmRvdy4gSWRlbXBvdGVudCBwZXIgcnVuIOKAlCBhXG4gKiBzZWNvbmQgY2FsbCByZXN0YXJ0cyB0aGUgd2FsbCBjbG9jay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0RmxlZXRUZWxlbWV0cnkobm93TXM6IG51bWJlciA9IERhdGUubm93KCkpOiB2b2lkIHtcbiAgcmVzZXRGbGVldFRlbGVtZXRyeSgpO1xuICBzdGF0ZS5ydW5TdGFydE1zID0gbm93TXM7XG4gIHN0YXRlLmNsb3NlZFRocm91Z2hNcyA9IG5vd01zO1xufVxuXG4vKipcbiAqIE1hcmsgdGhlIHN0YXJ0IG9mIGEgY3ljbGUuIERlbGliZXJhdGVseSBkb2VzICoqbm90KiogbW92ZSB0aGVcbiAqIGF0dHJpYnV0aW9uIG1hcmtlcjogYSBjeWNsZSB0aGF0IHJldHVybnMgZWFybHkgKGEgZmFpbGVkIGhlYWx0aCBjaGVjaywgYVxuICogcmF0ZS1saW1pdCBwYXVzZSkgbmV2ZXIgcmVhY2hlcyB7QGxpbmsgcmVjb3JkQ3ljbGVJZGxlfSwgYW5kIGl0cyB3YWxsXG4gKiB0aW1lIGlzIHJlYWwgaWRsZSB0aW1lLiBMZWF2aW5nIHRoZSBtYXJrZXIgd2hlcmUgaXQgaXMgZm9sZHMgdGhhdCB0aW1lXG4gKiBpbnRvIHRoZSBuZXh0IGF0dHJpYnV0ZWQgc2VnbWVudCBpbnN0ZWFkIG9mIGRyb3BwaW5nIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRGbGVldEN5Y2xlKG5vd01zOiBudW1iZXIgPSBEYXRlLm5vdygpKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5ydW5TdGFydE1zID09PSB1bmRlZmluZWQpIHN0YXRlLnJ1blN0YXJ0TXMgPSBub3dNcztcbiAgaWYgKHN0YXRlLmNsb3NlZFRocm91Z2hNcyA9PT0gdW5kZWZpbmVkKSBzdGF0ZS5jbG9zZWRUaHJvdWdoTXMgPSBub3dNcztcbn1cblxuZnVuY3Rpb24gYWRkVG8obWFwOiBNYXA8c3RyaW5nLCBudW1iZXI+LCBrZXk6IHN0cmluZywgdmFsdWU6IG51bWJlcik6IHZvaWQge1xuICBtYXAuc2V0KGtleSwgKG1hcC5nZXQoa2V5KSA/PyAwKSArIHZhbHVlKTtcbn1cblxuLyoqXG4gKiBBIHdvcmsgc3RyZWFtIGhhcyB0YWtlbiBhIGNsYWltLiBUaGUgZmxlZXQgY291bnRzIGFzIG9jY3VwaWVkIHdoaWxlIGF0XG4gKiBsZWFzdCBvbmUgc3RyZWFtIGlzIG9wZW4sIHNvIGNvbmN1cnJlbnQgc2xvdHMgY2Fubm90IHN1YnRyYWN0IG1vcmUgd2FsbFxuICogdGltZSB0aGFuIHRoZSBjbG9jayBhY3R1YWxseSBoZWxkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYmVnaW5CdXN5KHN0cmVhbTogc3RyaW5nLCBub3dNczogbnVtYmVyID0gRGF0ZS5ub3coKSk6IHZvaWQge1xuICBpZiAoc3RhdGUuc3RyZWFtU3RhcnRNcy5oYXMoc3RyZWFtKSkgcmV0dXJuO1xuICBzdGF0ZS5zdHJlYW1TdGFydE1zLnNldChzdHJlYW0sIG5vd01zKTtcbiAgc3RhdGUuYWN0aXZlU3RyZWFtcyArPSAxO1xuICBpZiAoc3RhdGUuYWN0aXZlU3RyZWFtcyA9PT0gMSkgc3RhdGUub2NjdXBpZWRTdGFydE1zID0gbm93TXM7XG59XG5cbi8qKiBBIHdvcmsgc3RyZWFtIGhhcyByZWxlYXNlZCBpdHMgY2xhaW0uICovXG5leHBvcnQgZnVuY3Rpb24gZW5kQnVzeShzdHJlYW06IHN0cmluZywgbm93TXM6IG51bWJlciA9IERhdGUubm93KCkpOiB2b2lkIHtcbiAgY29uc3Qgc3RhcnRlZEF0ID0gc3RhdGUuc3RyZWFtU3RhcnRNcy5nZXQoc3RyZWFtKTtcbiAgaWYgKHN0YXJ0ZWRBdCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gIHN0YXRlLnN0cmVhbVN0YXJ0TXMuZGVsZXRlKHN0cmVhbSk7XG4gIGFkZFRvKHN0YXRlLmJ1c3lNc0J5U3RyZWFtLCBzdHJlYW0sIE1hdGgubWF4KDAsIG5vd01zIC0gc3RhcnRlZEF0KSk7XG4gIHN0YXRlLmFjdGl2ZVN0cmVhbXMgLT0gMTtcbiAgaWYgKHN0YXRlLmFjdGl2ZVN0cmVhbXMgPiAwKSByZXR1cm47XG4gIGNvbnN0IG9jY3VwaWVkRnJvbSA9IHN0YXRlLm9jY3VwaWVkU3RhcnRNcztcbiAgaWYgKG9jY3VwaWVkRnJvbSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgbXMgPSBNYXRoLm1heCgwLCBub3dNcyAtIG9jY3VwaWVkRnJvbSk7XG4gICAgc3RhdGUub2NjdXBpZWRTaW5jZUNsb3NlTXMgKz0gbXM7XG4gICAgc3RhdGUub2NjdXBpZWRNcyArPSBtcztcbiAgfVxuICBzdGF0ZS5vY2N1cGllZFN0YXJ0TXMgPSB1bmRlZmluZWQ7XG59XG5cbi8qKiBBZGQgdG8gdGhlIGJsb2NrZWQgdG90YWxzIGZvciBga2luZGAsIGNvdW50aW5nIG9uZSB3YWl0LiAqL1xuZnVuY3Rpb24gYWRkQmxvY2tlZFRvdGFscyhraW5kOiBGbGVldEJsb2NrS2luZCwgbXM6IG51bWJlcik6IHZvaWQge1xuICBpZiAoa2luZCA9PT0gXCJyYXRlX2xpbWl0ZWRcIikge1xuICAgIHN0YXRlLnJhdGVMaW1pdGVkTXMgKz0gbXM7XG4gICAgc3RhdGUucmF0ZUxpbWl0V2FpdHMgKz0gMTtcbiAgfSBlbHNlIHtcbiAgICBzdGF0ZS50b2tlbkJsb2NrZWRNcyArPSBtcztcbiAgICBzdGF0ZS50b2tlbkJsb2NrZWRXYWl0cyArPSAxO1xuICB9XG59XG5cbi8qKlxuICogUmVjb3JkIHdhbGwgc2Vjb25kcyB0aGUgbG9vcCBzcGVudCBibG9ja2VkICoqYmV0d2VlbioqIHJ1bnMuIENvdW50cyBhc1xuICogaXRzIG93biBpZGxlIHJlYXNvbiBhcyB3ZWxsIGFzIGFnYWluc3QgdGhlIGJsb2NrZWQgdG90YWxzLCBzb1xuICogYGlkbGVfYnlfcmVhc29uYCBzdGlsbCBzdW1zIHRvIGBpZGxlX3NlY29uZHNgLiBBIHplcm8tbGVuZ3RoIHdhaXQgaXNcbiAqIGlnbm9yZWQgcmF0aGVyIHRoYW4gcmVwb3J0ZWQgYXMgYSB3YWl0IHRoYXQgZGlkIG5vdCBoYXBwZW4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRCbG9ja2VkU2Vjb25kcyhcbiAga2luZDogRmxlZXRCbG9ja0tpbmQsXG4gIHNlY29uZHM6IG51bWJlcixcbik6IHZvaWQge1xuICBjb25zdCBtcyA9IE1hdGgubWF4KDAsIHNlY29uZHMpICogMTAwMDtcbiAgaWYgKG1zID09PSAwKSByZXR1cm47XG4gIGFkZFRvKHN0YXRlLmlkbGVNc0J5UmVhc29uLCBraW5kLCBtcyk7XG4gIHN0YXRlLmJsb2NrZWRTaW5jZUNsb3NlTXMgKz0gbXM7XG4gIGFkZEJsb2NrZWRUb3RhbHMoa2luZCwgbXMpO1xufVxuXG4vKipcbiAqIFJlY29yZCB3YWxsIHNlY29uZHMgYSBjbGFpbWVkIHJ1biBzcGVudCBibG9ja2VkICoqaW5zaWRlKiogaXRzZWxmIOKAlCB0aGVcbiAqIGFnZW50J3Mgb3duIHJhdGUtbGltaXQgcmV0cnkgbGFkZGVyIHNsZWVwcyBpbi1wcm9jZXNzLCBhbmQgd2l0aG91dCB0aGlzXG4gKiBhbiBob3VyIG9mIHdhaXRpbmcgcmVhZHMgYXMgYW4gaG91ciBvZiB3b3JrLiBDb3VudGVkIGluIHRoZSBibG9ja2VkXG4gKiB0b3RhbHMgKHRoZSBudW1iZXIgdGhlIGlzc3VlIGFza3MgZm9yKSBidXQgZGVsaWJlcmF0ZWx5IE5PVCBhcyBhbiBpZGxlXG4gKiByZWFzb246IHRoZSBmbGVldCB3YXMgaG9sZGluZyBhIGNsYWltLCBub3QgaWRsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZEluUnVuQmxvY2tlZFNlY29uZHMoXG4gIGtpbmQ6IEZsZWV0QmxvY2tLaW5kLFxuICBzZWNvbmRzOiBudW1iZXIsXG4pOiB2b2lkIHtcbiAgY29uc3QgbXMgPSBNYXRoLm1heCgwLCBzZWNvbmRzKSAqIDEwMDA7XG4gIGlmIChtcyA9PT0gMCkgcmV0dXJuO1xuICBhZGRCbG9ja2VkVG90YWxzKGtpbmQsIG1zKTtcbn1cblxuLyoqXG4gKiBBdHRyaWJ1dGUgZXZlcnkgdW5hY2NvdW50ZWQgd2FsbCBzZWNvbmQgc2luY2UgdGhlIGxhc3QgYXR0cmlidXRpb24gdG9cbiAqIGByZWFzb25gLCBhbmQgYWR2YW5jZSB0aGUgbWFya2VyLiBPY2N1cGllZCBhbmQgYmxvY2tlZCBzcGFucyBhcmVcbiAqIGV4Y2x1ZGVkLiBBIHN0cmVhbSBzdGlsbCBob2xkaW5nIGEgY2xhaW0gY29udHJpYnV0ZXMgaXRzIGVsYXBzZWQgdGltZVxuICogdG8gdGhpcyBzZWdtZW50IHdpdGhvdXQgY2xvc2luZywgc28gYSBydW4gdGhhdCBzcGFucyBzZXZlcmFsIGN5Y2xlcyBpc1xuICogbm90IGNvdW50ZWQgYXMgaWRsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZEN5Y2xlSWRsZShcbiAgcmVhc29uOiBGbGVldElkbGVSZWFzb24sXG4gIG5vd01zOiBudW1iZXIgPSBEYXRlLm5vdygpLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YXJ0ID0gc3RhdGUuY2xvc2VkVGhyb3VnaE1zO1xuICBpZiAoc3RhcnQgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICBjb25zdCBzZWdtZW50TXMgPSBNYXRoLm1heCgwLCBub3dNcyAtIHN0YXJ0KTtcbiAgLy8gT2NjdXBhbmN5IHN0aWxsIG9wZW4gYXQgdGhlIGJvdW5kYXJ5OiBiYW5rIGl0IGFuZCByZS1vcGVuIGF0IGBub3dNc2AuXG4gIGNvbnN0IG9jY3VwaWVkRnJvbSA9IHN0YXRlLm9jY3VwaWVkU3RhcnRNcztcbiAgaWYgKG9jY3VwaWVkRnJvbSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3Qgb3Blbk1zID0gTWF0aC5tYXgoMCwgbm93TXMgLSBvY2N1cGllZEZyb20pO1xuICAgIHN0YXRlLm9jY3VwaWVkU2luY2VDbG9zZU1zICs9IG9wZW5NcztcbiAgICBzdGF0ZS5vY2N1cGllZE1zICs9IG9wZW5NcztcbiAgICBzdGF0ZS5vY2N1cGllZFN0YXJ0TXMgPSBub3dNcztcbiAgfVxuICBjb25zdCBpZGxlTXMgPSBNYXRoLm1heChcbiAgICAwLFxuICAgIHNlZ21lbnRNcyAtIHN0YXRlLm9jY3VwaWVkU2luY2VDbG9zZU1zIC0gc3RhdGUuYmxvY2tlZFNpbmNlQ2xvc2VNcyxcbiAgKTtcbiAgaWYgKGlkbGVNcyA+IDApIGFkZFRvKHN0YXRlLmlkbGVNc0J5UmVhc29uLCByZWFzb24sIGlkbGVNcyk7XG4gIHN0YXRlLmNsb3NlZFRocm91Z2hNcyA9IG5vd01zO1xuICBzdGF0ZS5vY2N1cGllZFNpbmNlQ2xvc2VNcyA9IDA7XG4gIHN0YXRlLmJsb2NrZWRTaW5jZUNsb3NlTXMgPSAwO1xufVxuXG4vKiogUmVjb3JkIHRoYXQgYW4gaXNzdWUgd2FzIGNsYWltZWQuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkQ2xhaW0oKTogdm9pZCB7XG4gIHN0YXRlLmNsYWltcyArPSAxO1xufVxuXG4vKipcbiAqIFJlY29yZCBwb3N0LXJ1biBjYWxsYmFjayBpbnZvY2F0aW9ucyB0aGF0IGRpZCBub3QgZXhpdCAwIChJc3N1ZSAjMjI5NykuXG4gKlxuICogYGNsYWltcz0zIHN1Y2Nlc3Nlcz0yIGZhaWx1cmVzPTBgIHJlYWQgYXMgYSBoZWFsdGh5IHJ1biBvbiBHUlEtMjUgd2hpbGVcbiAqIGV2ZXJ5IGhlYXJ0YmVhdCB0aGUgaG9zdCBwdWJsaXNoZWQgd2FzIGJlaW5nIGxvc3Qg4oCUIHRoZSBob29rIGZhaWxlZCBvbiBlYWNoXG4gKiBvZiB0aG9zZSBydW5zIGFuZCB0aGUgc3VtbWFyeSBoYWQgbm93aGVyZSB0byBzYXkgc28uXG4gKlxuICogQHBhcmFtIGNvdW50IC0gRmFpbGluZyBpbnZvY2F0aW9ucyB0byBhZGQ7IGRlZmF1bHRzIHRvIG9uZVxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkSG9va0ZhaWx1cmUoY291bnQgPSAxKTogdm9pZCB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKGNvdW50KSB8fCBjb3VudCA8PSAwKSByZXR1cm47XG4gIHN0YXRlLmhvb2tGYWlsdXJlcyArPSBNYXRoLmZsb29yKGNvdW50KTtcbn1cblxuLyoqXG4gKiBSZWNvcmQgdGhlIHRlcm1pbmFsIG91dGNvbWUgb2YgYSBjbGFpbWVkIGlzc3VlLiBgZmFpbHVyZUNsYXNzYCBpcyB0aGVcbiAqIGZhaWxpbmcgcGhhc2UgKGBzZXR1cGAsIGBleGVjdXRlYCwgYHF1YWxpdHlfZ2F0ZWAsIOKApiksIGB0aW1lb3V0YCwgb3JcbiAqIGBoYXJkX2tpbGxgIGZvciBhIHJ1biB0aGUgbGF1bmNoZXIgd2F0Y2hkb2cga2lsbGVkIChJc3N1ZSAjNDI1NCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRPdXRjb21lKFxuICBvdXRjb21lOiBGbGVldFJ1bk91dGNvbWUsXG4gIGZhaWx1cmVDbGFzcz86IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAob3V0Y29tZSA9PT0gXCJzdWNjZXNzXCIpIHtcbiAgICBzdGF0ZS5zdWNjZXNzZXMgKz0gMTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKG91dGNvbWUgPT09IFwic2tpcFwiKSB7XG4gICAgc3RhdGUuc2tpcHMgKz0gMTtcbiAgICByZXR1cm47XG4gIH1cbiAgc3RhdGUuZmFpbHVyZXMgKz0gMTtcbiAgY29uc3QgY2xzID0gZmFpbHVyZUNsYXNzPy50cmltKCk7XG4gIGFkZFRvKFxuICAgIHN0YXRlLmZhaWx1cmVzQnlDbGFzcyxcbiAgICBjbHMgJiYgY2xzLmxlbmd0aCA+IDAgPyBjbHMgOiBVTktOT1dOX0ZBSUxVUkVfQ0xBU1MsXG4gICAgMSxcbiAgKTtcbn1cblxuLyoqXG4gKiBBIHJlY29yZGVkIGZpZ3VyZSwgb3IgMCB3aGVuIHRoZSBjYWxsZXIgaGFkIG5vbmUgdG8gZ2l2ZS5cbiAqXG4gKiBOZWdhdGl2ZSBhbmQgbm9uLWZpbml0ZSB2YWx1ZXMgY29udHJpYnV0ZSBub3RoaW5nIHJhdGhlciB0aGFuIHByb3BhZ2F0aW5nIGFcbiAqIGBOYU5gIHRocm91Z2ggZXZlcnkgc3Vic2VxdWVudCB0b3RhbCDigJQgb25lIHVucGFyc2VhYmxlIGR1cmF0aW9uIHdvdWxkXG4gKiBvdGhlcndpc2UgbWFrZSB0aGUgd2hvbGUgaG9zdCdzIHRlbGVtZXRyeSB1bnJlYWRhYmxlLCB3aGljaCBpcyB0aGUgb3Bwb3NpdGVcbiAqIG9mIHN1cmZhY2luZyBpdC5cbiAqL1xuZnVuY3Rpb24gY29udHJpYnV0aW9uKHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgJiYgdmFsdWUgPiAwXG4gICAgPyB2YWx1ZVxuICAgIDogMDtcbn1cblxuLyoqXG4gKiBSZWNvcmQgb25lIGNvbXBsZXRlZCBgaXNzdWVgLXBoYXNlIHJ1biAoSXNzdWUgIzIzNDcsIHBhcnQgb2YgIzIzMjApLlxuICpcbiAqIENhbGxlZCBvbmNlIHBlciBydW4gZnJvbSB0aGUgY29tcGxldGlvbiBwYXRoIHRoYXQgcG9zdHMgdGhlIHJ1bi1zdGF0c1xuICogY29tbWVudCwgd2l0aCB0aGUgc2FtZSBmaWd1cmVzIHRoYXQgY29tbWVudCByZW5kZXJzIOKAlCBzbyBhIHBpbG90IGhvc3Qnc1xuICogc3BlbmQsIGZpcnN0LWF0dGVtcHQgZ2F0ZSBwYXNzIHJhdGUgYW5kIGR1cmF0aW9uIGFyZSBjb21wYXJhYmxlIHdpdGggdGhlXG4gKiBjb250cm9sIGhvc3RzJyBzdHJhaWdodCBvZmYgdGhlIGZsZWV0IHN1bW1hcnkuXG4gKlxuICogQHBhcmFtIHJ1biAtIFRoZSBydW4ncyBjb3N0LCBnYXRlIGF0dGVtcHQsIGR1cmF0aW9uLCBzcGxpdCBzdGF0ZSBhbmRcbiAqICAgcmVzb2x2ZWQgc3ViLWFnZW50IHRpZXJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZElzc3VlUGhhc2VSdW4ocnVuOiBJc3N1ZVBoYXNlUnVuKTogdm9pZCB7XG4gIGNvbnN0IGNvdW50ZXJzID0gc3RhdGUuaXNzdWVQaGFzZTtcbiAgY291bnRlcnMuaXNzdWVQaGFzZVJ1bnMgKz0gMTtcbiAgY291bnRlcnMuaXNzdWVQaGFzZVVzZCArPSBjb250cmlidXRpb24ocnVuLnVzZCk7XG4gIGNvdW50ZXJzLmlzc3VlUGhhc2VEdXJhdGlvblNlY29uZHMgKz0gY29udHJpYnV0aW9uKHJ1bi5kdXJhdGlvblNlY29uZHMpO1xuICBpZiAocnVuLmdhdGVQYXNzZWRPbkF0dGVtcHQgPT09IDEpIHtcbiAgICBjb3VudGVycy5pc3N1ZVBoYXNlRmlyc3RBdHRlbXB0R2F0ZVBhc3NlcyArPSAxO1xuICB9XG4gIGlmIChydW4uc3BsaXQgPT09IHRydWUpIGNvdW50ZXJzLmlzc3VlUGhhc2VTcGxpdFJ1bnMgKz0gMTtcbiAgLy8gSXNzdWUgIzM0MDMg4oCUIG9ubHkgdGhlIHJlc29sdmVkIHRpZXIncyBwYWlyIG1vdmVzLCBzbyBhIHRpZXIncyBzcGVuZFxuICAvLyBhbmQgdm9sdW1lIG5ldmVyIGxlYWsgaW50byB0aGUgb3RoZXIgdGllcidzIGZpZ3VyZXMuXG4gIHN3aXRjaCAocnVuLnN1YkFnZW50VGllcikge1xuICAgIGNhc2UgXCJzb25uZXRcIjpcbiAgICAgIGNvdW50ZXJzLmlzc3VlUGhhc2VTb25uZXRSdW5zICs9IDE7XG4gICAgICBjb3VudGVycy5pc3N1ZVBoYXNlU29ubmV0VXNkICs9IGNvbnRyaWJ1dGlvbihydW4udXNkKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJoYWlrdVwiOlxuICAgICAgY291bnRlcnMuaXNzdWVQaGFzZUhhaWt1UnVucyArPSAxO1xuICAgICAgY291bnRlcnMuaXNzdWVQaGFzZUhhaWt1VXNkICs9IGNvbnRyaWJ1dGlvbihydW4udXNkKTtcbiAgICAgIGJyZWFrO1xuICB9XG59XG5cbi8qKlxuICogUmVjb3JkIGFuIGF1dGhvcmlzZWQgQ0hBTkdFU19SRVFVRVNURUQgcmV2aWV3IG9uIGEgUFIgKElzc3VlICMzNDA0KS5cbiAqXG4gKiBDb3VudGVkIG9uY2UgcGVyIGByZXBvI3ByTnVtYmVyI3Jldmlld0lkYCB3aXRoaW4gdGhlIHRlbGVtZXRyeSB3aW5kb3csIGFuZFxuICogb25seSB3aGVuIHRoZSByZXZpZXcgd2FzIHN1Ym1pdHRlZCBhdCBvciBhZnRlciB0aGUgd2luZG93IHN0YXJ0LCBzbyBhXG4gKiByZXN0YXJ0IGRvZXMgbm90IHJlLWNvdW50IHJldmlld3MgdGhhdCBwZXJzaXN0IG9uIHRoZSBQUi4gQSBtaXNzaW5nIG9yXG4gKiB1bnBhcnNlYWJsZSBgc3VibWl0dGVkQXRgIGlzIG5vdCBjb3VudGVkLiBUaGUgdGllciBpcyByZXNvbHZlZCBsYXppbHkgc28gdGhlXG4gKiBQUi1ib2R5IGZldGNoIGlzIG9ubHkgcGFpZCBmb3IgYSByZXZpZXcgdGhhdCB3b3VsZCBjb3VudDsgd2hlbiBpdCByZXNvbHZlc1xuICogdG8gYG51bGxgIG5vdGhpbmcgaXMgcmVjb3JkZWQgYW5kIHRoZSByZXZpZXcgaXMgcmV0cmllZCBvbiB0aGUgbmV4dCBzY2FuLiBBXG4gKiByZXNldCBkdXJpbmcgdGhlIGF3YWl0IGRpc2NhcmRzIHRoZSByZXN1bHQgcmF0aGVyIHRoYW4gY3JlZGl0aW5nIHRoZSBuZXdcbiAqIHdpbmRvdy5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIFRoZSBQUiwgdGhlIHJldmlldywgaXRzIHN1Ym1pc3Npb24gdGltZSBhbmQgYSB0aWVyIHJlc29sdmVyXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWNvcmRQclJlamVjdGlvbihcbiAgYXJnczoge1xuICAgIHJlcG86IHN0cmluZztcbiAgICBwck51bWJlcjogbnVtYmVyO1xuICAgIHJldmlld0lkOiBudW1iZXIgfCBzdHJpbmc7XG4gICAgc3VibWl0dGVkQXQ6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQ7XG4gICAgcmVzb2x2ZVRpZXI6ICgpID0+IFByb21pc2U8SXNzdWVTdWJBZ2VudFRpZXIgfCBudWxsPjtcbiAgfSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzdWJtaXR0ZWRNcyA9IERhdGUucGFyc2UoYXJncy5zdWJtaXR0ZWRBdCA/PyBcIlwiKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc3VibWl0dGVkTXMpKSByZXR1cm47XG4gIGNvbnN0IHdpbmRvdyA9IHN0YXRlO1xuICBpZiAod2luZG93LnJ1blN0YXJ0TXMgIT09IHVuZGVmaW5lZCAmJiBzdWJtaXR0ZWRNcyA8IHdpbmRvdy5ydW5TdGFydE1zKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGtleSA9IGAke2FyZ3MucmVwb30jJHthcmdzLnByTnVtYmVyfSMke2FyZ3MucmV2aWV3SWR9YDtcbiAgaWYgKHNlZW5SZWplY3Rpb25zLmhhcyhrZXkpKSByZXR1cm47XG4gIGNvbnN0IHRpZXIgPSBhd2FpdCBhcmdzLnJlc29sdmVUaWVyKCk7XG4gIGlmICh0aWVyID09PSBudWxsKSByZXR1cm47XG4gIC8vIEEgcmVzZXQgZHVyaW5nIHRoZSBhd2FpdCBvcGVuZWQgYSBuZXcgd2luZG93OiB0aGlzIHJlc3VsdCBpcyBzdGFsZS5cbiAgaWYgKHN0YXRlLnJ1blRva2VuICE9PSB3aW5kb3cucnVuVG9rZW4pIHJldHVybjtcbiAgLy8gQSBjb25jdXJyZW50IGNhbGwgZm9yIHRoZSBzYW1lIHJldmlldyBtYXkgaGF2ZSBjb3VudGVkIGl0IG1lYW53aGlsZS5cbiAgaWYgKHNlZW5SZWplY3Rpb25zLmhhcyhrZXkpKSByZXR1cm47XG4gIHNlZW5SZWplY3Rpb25zLmFkZChrZXkpO1xuICBzd2l0Y2ggKHRpZXIpIHtcbiAgICBjYXNlIFwic29ubmV0XCI6XG4gICAgICB3aW5kb3cucHJPdXRjb21lcy5wclJlamVjdGlvbnNTb25uZXQgKz0gMTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJoYWlrdVwiOlxuICAgICAgd2luZG93LnByT3V0Y29tZXMucHJSZWplY3Rpb25zSGFpa3UgKz0gMTtcbiAgICAgIGJyZWFrO1xuICB9XG59XG5cbi8qKlxuICogUmVjb3JkIG9uZSBDSS1maXggcnVuIGFuZCBpdHMgZXN0aW1hdGVkIHNwZW5kIChJc3N1ZSAjMzQwNCkuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBUaGUgcnVuJ3Mgb3B0aW9uYWwgVVNEIGNvc3QgYW5kIHRoZSBQUidzIHN1Yi1hZ2VudCB0aWVyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRDaUZpeFJ1bihcbiAgYXJnczogeyB1c2Q/OiBudW1iZXI7IHRpZXI6IElzc3VlU3ViQWdlbnRUaWVyIH0sXG4pOiB2b2lkIHtcbiAgY29uc3QgY291bnRlcnMgPSBzdGF0ZS5wck91dGNvbWVzO1xuICBzd2l0Y2ggKGFyZ3MudGllcikge1xuICAgIGNhc2UgXCJzb25uZXRcIjpcbiAgICAgIGNvdW50ZXJzLmNpRml4UnVuc1Nvbm5ldCArPSAxO1xuICAgICAgY291bnRlcnMuY2lGaXhVc2RTb25uZXQgKz0gY29udHJpYnV0aW9uKGFyZ3MudXNkKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJoYWlrdVwiOlxuICAgICAgY291bnRlcnMuY2lGaXhSdW5zSGFpa3UgKz0gMTtcbiAgICAgIGNvdW50ZXJzLmNpRml4VXNkSGFpa3UgKz0gY29udHJpYnV0aW9uKGFyZ3MudXNkKTtcbiAgICAgIGJyZWFrO1xuICB9XG59XG5cbi8qKlxuICogUmVjb3JkIG9uZSBQUi1mZWVkYmFjayBydW4gYW5kIGl0cyBlc3RpbWF0ZWQgc3BlbmQgKElzc3VlICMzNDA0KS5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIFRoZSBydW4ncyBvcHRpb25hbCBVU0QgY29zdCBhbmQgdGhlIFBSJ3Mgc3ViLWFnZW50IHRpZXJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZFByRmVlZGJhY2tSdW4oXG4gIGFyZ3M6IHsgdXNkPzogbnVtYmVyOyB0aWVyOiBJc3N1ZVN1YkFnZW50VGllciB9LFxuKTogdm9pZCB7XG4gIGNvbnN0IGNvdW50ZXJzID0gc3RhdGUucHJPdXRjb21lcztcbiAgc3dpdGNoIChhcmdzLnRpZXIpIHtcbiAgICBjYXNlIFwic29ubmV0XCI6XG4gICAgICBjb3VudGVycy5wckZlZWRiYWNrUnVuc1Nvbm5ldCArPSAxO1xuICAgICAgY291bnRlcnMucHJGZWVkYmFja1VzZFNvbm5ldCArPSBjb250cmlidXRpb24oYXJncy51c2QpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImhhaWt1XCI6XG4gICAgICBjb3VudGVycy5wckZlZWRiYWNrUnVuc0hhaWt1ICs9IDE7XG4gICAgICBjb3VudGVycy5wckZlZWRiYWNrVXNkSGFpa3UgKz0gY29udHJpYnV0aW9uKGFyZ3MudXNkKTtcbiAgICAgIGJyZWFrO1xuICB9XG59XG5cbi8qKlxuICogUmVjb3JkIGEgbWVyZ2VkIFBSIChJc3N1ZSAjMzQwNCkuIENvdW50ZWQgb25jZSBwZXIgYHJlcG8jbnVtYmVyYCB3aXRoaW4gdGhlXG4gKiB0ZWxlbWV0cnkgd2luZG93LCBhbmQgb25seSB3aGVuIGBtZXJnZWRBdGAgcGFyc2VzIGFuZCBpcyBhdCBvciBhZnRlciB0aGVcbiAqIHdpbmRvdyBzdGFydCwgc28gYSByZXN0YXJ0IGRvZXMgbm90IHJlLWNvdW50IHRoZSByZWNlbnQgbWVyZ2VzIHRoZSBsaXN0aW5nXG4gKiBrZWVwcyByZXR1cm5pbmcuIEFuIGVtcHR5IG9yIHVucGFyc2VhYmxlIGBtZXJnZWRBdGAgaXMgbm90IGNvdW50ZWQgKGl0c1xuICogb3JkZXIgYWdhaW5zdCB0aGUgd2luZG93IGlzIHVua25vd24pLlxuICpcbiAqIEBwYXJhbSBhcmdzIC0gVGhlIHJlcG8sIFBSIG51bWJlciwgbWVyZ2UgdGltZSBhbmQgdGhlIGF1dGhvcmluZyBzdWItYWdlbnQgdGllclxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkTWVyZ2VkUHIoXG4gIGFyZ3M6IHtcbiAgICByZXBvOiBzdHJpbmc7XG4gICAgbnVtYmVyOiBudW1iZXI7XG4gICAgbWVyZ2VkQXQ6IHN0cmluZztcbiAgICB0aWVyOiBJc3N1ZVN1YkFnZW50VGllcjtcbiAgfSxcbik6IHZvaWQge1xuICBjb25zdCBtZXJnZWRNcyA9IERhdGUucGFyc2UoYXJncy5tZXJnZWRBdCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKG1lcmdlZE1zKSkgcmV0dXJuO1xuICBpZiAoc3RhdGUucnVuU3RhcnRNcyAhPT0gdW5kZWZpbmVkICYmIG1lcmdlZE1zIDwgc3RhdGUucnVuU3RhcnRNcykgcmV0dXJuO1xuICBjb25zdCBrZXkgPSBgJHthcmdzLnJlcG99IyR7YXJncy5udW1iZXJ9YDtcbiAgaWYgKHNlZW5NZXJnZWRQcnMuaGFzKGtleSkpIHJldHVybjtcbiAgc2Vlbk1lcmdlZFBycy5hZGQoa2V5KTtcbiAgc3dpdGNoIChhcmdzLnRpZXIpIHtcbiAgICBjYXNlIFwic29ubmV0XCI6XG4gICAgICBzdGF0ZS5wck91dGNvbWVzLm1lcmdlZFByc1Nvbm5ldCArPSAxO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImhhaWt1XCI6XG4gICAgICBzdGF0ZS5wck91dGNvbWVzLm1lcmdlZFByc0hhaWt1ICs9IDE7XG4gICAgICBicmVhaztcbiAgfVxufVxuXG4vKipcbiAqIENvc3QgcGVyIG1lcmdlZCBQUiwgZm91ciBkZWNpbWFscywgb3IgYG4vYWAgd2hlbiBub3RoaW5nIG1lcmdlZCBvciB0aGVcbiAqIHF1b3RpZW50IGlzIG5vdCBmaW5pdGUgKElzc3VlICMzNDA0KS5cbiAqXG4gKiBAcGFyYW0gdXNkIC0gVG90YWwgc3BlbmQgYXR0cmlidXRlZCB0byB0aGUgdGllclxuICogQHBhcmFtIG1lcmdlZCAtIE1lcmdlZCBQUnMgZm9yIHRoZSB0aWVyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb3N0UGVyTWVyZ2VkUHIodXNkOiBudW1iZXIsIG1lcmdlZDogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKG1lcmdlZCA8PSAwKSByZXR1cm4gXCJuL2FcIjtcbiAgY29uc3QgcXVvdGllbnQgPSB1c2QgLyBtZXJnZWQ7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocXVvdGllbnQpID8gcXVvdGllbnQudG9GaXhlZCg0KSA6IFwibi9hXCI7XG59XG5cbmZ1bmN0aW9uIHNlY29uZHNGcm9tKG1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5yb3VuZChtcyAvIDEwMDApO1xufVxuXG5mdW5jdGlvbiBzZWNvbmRzTWFwKG1hcDogTWFwPHN0cmluZywgbnVtYmVyPik6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4ge1xuICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIFsuLi5tYXAuZW50cmllcygpXS5tYXAoKFtrZXksIG1zXSkgPT4gW2tleSwgc2Vjb25kc0Zyb20obXMpXSksXG4gICk7XG59XG5cbi8qKiBTbmFwc2hvdCBvZiBldmVyeSBhY2N1bXVsYXRvciBwbHVzIHRoZSBkZXJpdmVkIHJhdGVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEZsZWV0VGVsZW1ldHJ5KFxuICBub3dNczogbnVtYmVyID0gRGF0ZS5ub3coKSxcbik6IEZsZWV0VGVsZW1ldHJ5U25hcHNob3Qge1xuICBjb25zdCB3YWxsU2Vjb25kcyA9IHN0YXRlLnJ1blN0YXJ0TXMgPT09IHVuZGVmaW5lZFxuICAgID8gMFxuICAgIDogTWF0aC5tYXgoMCwgc2Vjb25kc0Zyb20obm93TXMgLSBzdGF0ZS5ydW5TdGFydE1zKSk7XG4gIGNvbnN0IGlkbGVCeVJlYXNvbiA9IHNlY29uZHNNYXAoc3RhdGUuaWRsZU1zQnlSZWFzb24pO1xuICAvLyBTdHJlYW1zIHN0aWxsIGhvbGRpbmcgYSBjbGFpbSBjb3VudCB0b3dhcmRzIHRoaXMgc25hcHNob3Qgd2l0aG91dFxuICAvLyBjbG9zaW5nLCBzbyBhIG1pZC1ydW4gcmVhZGluZyBpcyBub3QgcmVwb3J0ZWQgYXMgYW4gaWRsZSBmbGVldC5cbiAgY29uc3Qgb3BlblN0cmVhbU1zID0gbmV3IE1hcChzdGF0ZS5idXN5TXNCeVN0cmVhbSk7XG4gIGZvciAoY29uc3QgW3N0cmVhbSwgc3RhcnRlZEF0XSBvZiBzdGF0ZS5zdHJlYW1TdGFydE1zKSB7XG4gICAgYWRkVG8ob3BlblN0cmVhbU1zLCBzdHJlYW0sIE1hdGgubWF4KDAsIG5vd01zIC0gc3RhcnRlZEF0KSk7XG4gIH1cbiAgY29uc3QgYnVzeUJ5U3RyZWFtID0gc2Vjb25kc01hcChvcGVuU3RyZWFtTXMpO1xuICBjb25zdCBvY2N1cGllZE1zID0gc3RhdGUub2NjdXBpZWRNcyArXG4gICAgKHN0YXRlLm9jY3VwaWVkU3RhcnRNcyA9PT0gdW5kZWZpbmVkXG4gICAgICA/IDBcbiAgICAgIDogTWF0aC5tYXgoMCwgbm93TXMgLSBzdGF0ZS5vY2N1cGllZFN0YXJ0TXMpKTtcbiAgY29uc3QgaWRsZVNlY29uZHMgPSBPYmplY3QudmFsdWVzKGlkbGVCeVJlYXNvbikucmVkdWNlKChhLCBiKSA9PiBhICsgYiwgMCk7XG4gIGNvbnN0IGJ1c3lTZWNvbmRzID0gT2JqZWN0LnZhbHVlcyhidXN5QnlTdHJlYW0pLnJlZHVjZSgoYSwgYikgPT4gYSArIGIsIDApO1xuICBjb25zdCBjb21wbGV0ZWQgPSBzdGF0ZS5zdWNjZXNzZXMgKyBzdGF0ZS5mYWlsdXJlcztcbiAgY29uc3QgdXRpbGlzYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcbiAgZm9yIChjb25zdCBbc3RyZWFtLCBzZWNvbmRzXSBvZiBPYmplY3QuZW50cmllcyhidXN5QnlTdHJlYW0pKSB7XG4gICAgdXRpbGlzYXRpb25bc3RyZWFtXSA9IHdhbGxTZWNvbmRzID4gMCA/IHNlY29uZHMgLyB3YWxsU2Vjb25kcyA6IDA7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBydW5Ub2tlbjogc3RhdGUucnVuVG9rZW4sXG4gICAgd2FsbFNlY29uZHMsXG4gICAgaWRsZVNlY29uZHMsXG4gICAgaWRsZUJ5UmVhc29uLFxuICAgIG9jY3VwaWVkU2Vjb25kczogc2Vjb25kc0Zyb20ob2NjdXBpZWRNcyksXG4gICAgYnVzeVNlY29uZHMsXG4gICAgYnVzeUJ5U3RyZWFtLFxuICAgIHRva2VuQmxvY2tlZFNlY29uZHM6IHNlY29uZHNGcm9tKHN0YXRlLnRva2VuQmxvY2tlZE1zKSxcbiAgICByYXRlTGltaXRlZFNlY29uZHM6IHNlY29uZHNGcm9tKHN0YXRlLnJhdGVMaW1pdGVkTXMpLFxuICAgIHJhdGVMaW1pdFdhaXRzOiBzdGF0ZS5yYXRlTGltaXRXYWl0cyxcbiAgICB0b2tlbkJsb2NrZWRXYWl0czogc3RhdGUudG9rZW5CbG9ja2VkV2FpdHMsXG4gICAgY2xhaW1zOiBzdGF0ZS5jbGFpbXMsXG4gICAgc3VjY2Vzc2VzOiBzdGF0ZS5zdWNjZXNzZXMsXG4gICAgZmFpbHVyZXM6IHN0YXRlLmZhaWx1cmVzLFxuICAgIHNraXBzOiBzdGF0ZS5za2lwcyxcbiAgICBmYWlsdXJlc0J5Q2xhc3M6IE9iamVjdC5mcm9tRW50cmllcyhzdGF0ZS5mYWlsdXJlc0J5Q2xhc3MpLFxuICAgIGhvb2tGYWlsdXJlczogc3RhdGUuaG9va0ZhaWx1cmVzLFxuICAgIC8vIElzc3VlICMyMzQ3IOKAlCBzcHJlYWQgY29waWVzIHRoZSBjb3VudGVycywgc28gYSBsYXRlciByZWNvcmQgY2Fubm90XG4gICAgLy8gbXV0YXRlIGEgc25hcHNob3QgYSBjYWxsZXIgYWxyZWFkeSBob2xkcyAodGhlIHNpZGVjYXIgc2VyaWFsaXNlcyBvbmUpLlxuICAgIC4uLnN0YXRlLmlzc3VlUGhhc2UsXG4gICAgLi4uc3RhdGUucHJPdXRjb21lcyxcbiAgICBzdWNjZXNzUmF0ZTogY29tcGxldGVkID4gMCA/IHN0YXRlLnN1Y2Nlc3NlcyAvIGNvbXBsZXRlZCA6IG51bGwsXG4gICAgdXRpbGlzYXRpb24sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGpvaW5Db3VudHMoXG4gIGNvdW50czogUmVjb3JkPHN0cmluZywgbnVtYmVyPixcbiAgc3VmZml4OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCBwYXJ0cyA9IE9iamVjdC5lbnRyaWVzKGNvdW50cylcbiAgICAuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pXG4gICAgLm1hcCgoW2tleSwgdmFsdWVdKSA9PiBgJHtrZXl9PSR7dmFsdWV9JHtzdWZmaXh9YCk7XG4gIHJldHVybiBwYXJ0cy5sZW5ndGggPiAwID8gcGFydHMuam9pbihcIixcIikgOiBcIm5vbmVcIjtcbn1cblxuLyoqXG4gKiBPbmUgbWFjaGluZS1yZWFkYWJsZSBzdW1tYXJ5IGxpbmUuIEVtaXR0ZWQgcGVyIGN5Y2xlIGFuZCBvbmNlIGF0IHRoZSBlbmRcbiAqIG9mIGEgcnVuLCBzbyB0aGUgbnVtYmVycyBjYW4gYmUgdHJlbmRlZCBzdHJhaWdodCBvdXQgb2YgdGhlIGxvZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEZsZWV0U3VtbWFyeShub3dNczogbnVtYmVyID0gRGF0ZS5ub3coKSk6IHN0cmluZyB7XG4gIGNvbnN0IHMgPSBnZXRGbGVldFRlbGVtZXRyeShub3dNcyk7XG4gIGNvbnN0IGlkbGVQY3QgPSBzLndhbGxTZWNvbmRzID4gMFxuICAgID8gKChzLmlkbGVTZWNvbmRzIC8gcy53YWxsU2Vjb25kcykgKiAxMDApLnRvRml4ZWQoMSlcbiAgICA6IFwiMC4wXCI7XG4gIGNvbnN0IHV0aWxpc2F0aW9uID0gT2JqZWN0LmVudHJpZXMocy51dGlsaXNhdGlvbilcbiAgICAuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pXG4gICAgLm1hcCgoW3N0cmVhbSwgcmF0aW9dKSA9PiBgJHtzdHJlYW19PSR7cmF0aW8udG9GaXhlZCgyKX1gKTtcbiAgcmV0dXJuIFtcbiAgICBcImZsZWV0LXN1bW1hcnk6XCIsXG4gICAgYHdhbGw9JHtzLndhbGxTZWNvbmRzfXNgLFxuICAgIGBpZGxlPSR7cy5pZGxlU2Vjb25kc31zYCxcbiAgICBgaWRsZV9wY3Q9JHtpZGxlUGN0fWAsXG4gICAgYG9jY3VwaWVkPSR7cy5vY2N1cGllZFNlY29uZHN9c2AsXG4gICAgYGJ1c3k9JHtzLmJ1c3lTZWNvbmRzfXNgLFxuICAgIC8vIGB1c2FnZV9ibG9ja2VkYCwgbm90IGB0b2tlbl9ibG9ja2VkYCAoYm90aCBoZXJlIGFuZCBhcyB0aGUgYmxvY2sta2luZFxuICAgIC8vIGlkZW50aWZpZXIgdGhhdCBrZXlzIGBpZGxlX2J5X3JlYXNvbmAgLyBgYmxvY2tlZF9ieV9yZWFzb25gKTogdGhlXG4gICAgLy8gc2VjcmV0IHJlZGFjdG9yIG1hc2tzIHRoZSB2YWx1ZSBvZiBhbnkgYGtleT12YWx1ZWAgd2hvc2Uga2V5IGNvbnRhaW5zXG4gICAgLy8gVE9LRU4sIHNvIHRoaXMgbGluZSB3ZW50IG91dCB3aXRoIGAqKipSRURBQ1RFRCoqKmAgd2hlcmUgdGhlIG9uZSBtZXRyaWNcbiAgICAvLyB0aGF0IGFuc3dlcnMgXCJpcyBhIHN1YnNjcmlwdGlvbiBiZWluZyBkcmFpbmVkP1wiIHNob3VsZCBiZS4gVGhlIHJ1bGUgaXNcbiAgICAvLyByaWdodCB0byBiZSBibHVudCDigJQgYFBBU1NXT1JEPTEyMzQ1YCBtdXN0IHN0YXkgbWFza2VkIOKAlCBzbyB0aGUgbWV0cmljXG4gICAgLy8gaXMgcmVuYW1lZCByYXRoZXIgdGhhbiB0aGUgcnVsZSBsb29zZW5lZC4gYHVzYWdlYCBpcyB0aGUgdm9jYWJ1bGFyeSB0aGVcbiAgICAvLyBzaWduYWwga2luZCBhbHJlYWR5IHVzZXMgKGBzaWduYWxLaW5kID09PSBcInVzYWdlXCJgKS5cbiAgICAvL1xuICAgIC8vIFRoZSBwZXJzaXN0ZWQgc2lkZWNhciBmaWVsZHMga2VlcCB0aGVpciBgdG9rZW5CbG9ja2VkKmAgbmFtZXM6IHRoZXkgYXJlXG4gICAgLy8gSlNPTiBzdGF0ZSB0aGF0IGFjY3VtdWxhdGVzIGFjcm9zcyBydW5zLCBhbmQgcmVuYW1pbmcgdGhlbSB3b3VsZCBvcnBoYW5cbiAgICAvLyBldmVyeSBwcmlvciBmaWxlJ3MgYWNjdW11bGF0ZWQgdmFsdWUuXG4gICAgYHVzYWdlX2Jsb2NrZWQ9JHtzLnRva2VuQmxvY2tlZFNlY29uZHN9c2AsXG4gICAgYHVzYWdlX2Jsb2NrZWRfd2FpdHM9JHtzLnRva2VuQmxvY2tlZFdhaXRzfWAsXG4gICAgYHJhdGVfbGltaXRlZD0ke3MucmF0ZUxpbWl0ZWRTZWNvbmRzfXNgLFxuICAgIGByYXRlX2xpbWl0X3dhaXRzPSR7cy5yYXRlTGltaXRXYWl0c31gLFxuICAgIGBjbGFpbXM9JHtzLmNsYWltc31gLFxuICAgIGBzdWNjZXNzZXM9JHtzLnN1Y2Nlc3Nlc31gLFxuICAgIGBmYWlsdXJlcz0ke3MuZmFpbHVyZXN9YCxcbiAgICBgc2tpcHM9JHtzLnNraXBzfWAsXG4gICAgLy8gSXNzdWUgIzIyOTc6IGEgcnVuIHdob3NlIGV2ZXJ5IGhlYXJ0YmVhdCBob29rIGZhaWxlZCBubyBsb25nZXIgcmVhZHMgYXNcbiAgICAvLyBhIGNsZWFuIGBzdWNjZXNzZXM9MiBmYWlsdXJlcz0wYC5cbiAgICBgaG9va19mYWlsdXJlcz0ke3MuaG9va0ZhaWx1cmVzfWAsXG4gICAgYHN1Y2Nlc3NfcmF0ZT0ke3Muc3VjY2Vzc1JhdGUgPT09IG51bGwgPyBcIm4vYVwiIDogcy5zdWNjZXNzUmF0ZS50b0ZpeGVkKDIpfWAsXG4gICAgLy8gSXNzdWUgIzIzNDc6IHRoZSBwaWxvdCdzIHBlci1ob3N0IGBpc3N1ZWAtcGhhc2UgY291bnRlcnMuIGBpc3N1ZV91c2RgXG4gICAgLy8gY2FycmllcyBmb3VyIGRlY2ltYWxzIGJlY2F1c2UgYSBjaGVhcCBydW4ncyBzcGVuZCBpcyBjZW50cywgYW5kXG4gICAgLy8gYGlzc3VlX2R1cmF0aW9uYCBpcyByZXBvcnRlZCBiZXNpZGUgdGhlIGNvc3Qgd2l0aCBubyB0aHJlc2hvbGQgb2YgaXRzXG4gICAgLy8gb3duIOKAlCBpdCBkZXNjcmliZXMgdGhlIHJ1bnMsIGl0IGRvZXMgbm90IGdhdGUgdGhlbS4gTm9uZSBvZiB0aGVzZSBrZXlzXG4gICAgLy8gdHJpcHMgdGhlIHNlY3JldCByZWRhY3RvcidzIGBrZXk9dmFsdWVgIHJ1bGUgKHNlZSBgdXNhZ2VfYmxvY2tlZGBcbiAgICAvLyBhYm92ZSk7IGBmbGVldF90ZWxlbWV0cnlfcmVkYWN0aW9uX3Rlc3QudHNgIGlzIHdoYXQgaG9sZHMgdGhhdC5cbiAgICBgaXNzdWVfcnVucz0ke3MuaXNzdWVQaGFzZVJ1bnN9YCxcbiAgICBgaXNzdWVfc3BsaXRfcnVucz0ke3MuaXNzdWVQaGFzZVNwbGl0UnVuc31gLFxuICAgIGBpc3N1ZV91c2Q9JHtzLmlzc3VlUGhhc2VVc2QudG9GaXhlZCg0KX1gLFxuICAgIGBpc3N1ZV9nYXRlX2ZpcnN0X2F0dGVtcHRfcGFzc2VzPSR7cy5pc3N1ZVBoYXNlRmlyc3RBdHRlbXB0R2F0ZVBhc3Nlc31gLFxuICAgIGBpc3N1ZV9kdXJhdGlvbj0ke3MuaXNzdWVQaGFzZUR1cmF0aW9uU2Vjb25kc31zYCxcbiAgICAvLyBJc3N1ZXMgIzM0MDMsICMzNDA0OiBzaG93biBvbmx5IG9uY2UgYSBoYWlrdSBydW4gaXMgcmVjb3JkZWQsIHNvIGFcbiAgICAvLyBzb25uZXQtb25seSBmbGVldCdzIHN1bW1hcnkgbGluZSBpcyB1bmNoYW5nZWQuXG4gICAgLi4uKHMuaXNzdWVQaGFzZUhhaWt1UnVucyA+IDBcbiAgICAgID8gW1xuICAgICAgICBgaXNzdWVfdGllcl9ydW5zPXNvbm5ldD0ke3MuaXNzdWVQaGFzZVNvbm5ldFJ1bnN9LGhhaWt1PSR7cy5pc3N1ZVBoYXNlSGFpa3VSdW5zfWAsXG4gICAgICAgIGBpc3N1ZV90aWVyX3VzZD1zb25uZXQ9JHtzLmlzc3VlUGhhc2VTb25uZXRVc2QudG9GaXhlZCg0KX0saGFpa3U9JHtcbiAgICAgICAgICBzLmlzc3VlUGhhc2VIYWlrdVVzZC50b0ZpeGVkKDQpXG4gICAgICAgIH1gLFxuICAgICAgICBgcHJfdGllcl9yZWplY3Rpb25zPXNvbm5ldD0ke3MucHJSZWplY3Rpb25zU29ubmV0fSxoYWlrdT0ke3MucHJSZWplY3Rpb25zSGFpa3V9YCxcbiAgICAgICAgYGNpX2ZpeF90aWVyX3J1bnM9c29ubmV0PSR7cy5jaUZpeFJ1bnNTb25uZXR9LGhhaWt1PSR7cy5jaUZpeFJ1bnNIYWlrdX1gLFxuICAgICAgICBgY2lfZml4X3RpZXJfdXNkPXNvbm5ldD0ke3MuY2lGaXhVc2RTb25uZXQudG9GaXhlZCg0KX0saGFpa3U9JHtcbiAgICAgICAgICBzLmNpRml4VXNkSGFpa3UudG9GaXhlZCg0KVxuICAgICAgICB9YCxcbiAgICAgICAgYHByX2ZlZWRiYWNrX3RpZXJfdXNkPXNvbm5ldD0ke1xuICAgICAgICAgIHMucHJGZWVkYmFja1VzZFNvbm5ldC50b0ZpeGVkKDQpXG4gICAgICAgIH0saGFpa3U9JHtzLnByRmVlZGJhY2tVc2RIYWlrdS50b0ZpeGVkKDQpfWAsXG4gICAgICAgIGBtZXJnZWRfdGllcl9wcnM9c29ubmV0PSR7cy5tZXJnZWRQcnNTb25uZXR9LGhhaWt1PSR7cy5tZXJnZWRQcnNIYWlrdX1gLFxuICAgICAgICBgY29zdF9wZXJfbWVyZ2VkX3ByPXNvbm5ldD0ke1xuICAgICAgICAgIGNvc3RQZXJNZXJnZWRQcihcbiAgICAgICAgICAgIHMuaXNzdWVQaGFzZVNvbm5ldFVzZCArIHMucHJGZWVkYmFja1VzZFNvbm5ldCArIHMuY2lGaXhVc2RTb25uZXQsXG4gICAgICAgICAgICBzLm1lcmdlZFByc1Nvbm5ldCxcbiAgICAgICAgICApXG4gICAgICAgIH0saGFpa3U9JHtcbiAgICAgICAgICBjb3N0UGVyTWVyZ2VkUHIoXG4gICAgICAgICAgICBzLmlzc3VlUGhhc2VIYWlrdVVzZCArIHMucHJGZWVkYmFja1VzZEhhaWt1ICsgcy5jaUZpeFVzZEhhaWt1LFxuICAgICAgICAgICAgcy5tZXJnZWRQcnNIYWlrdSxcbiAgICAgICAgICApXG4gICAgICAgIH1gLFxuICAgICAgXVxuICAgICAgOiBbXSksXG4gICAgYGlkbGVfYnlfcmVhc29uPSR7am9pbkNvdW50cyhzLmlkbGVCeVJlYXNvbiwgXCJzXCIpfWAsXG4gICAgYGZhaWx1cmVzX2J5X2NsYXNzPSR7am9pbkNvdW50cyhzLmZhaWx1cmVzQnlDbGFzcywgXCJcIil9YCxcbiAgICBgdXRpbGlzYXRpb249JHt1dGlsaXNhdGlvbi5sZW5ndGggPiAwID8gdXRpbGlzYXRpb24uam9pbihcIixcIikgOiBcIm5vbmVcIn1gLFxuICAgIC8vIElzc3VlICM0MjM2OiBvbWl0dGVkIGF0IHplcm8gc28gYSBmbGVldCB0aGF0IHJhaXNlZCBubyBzdWNoIHJlY29yZFxuICAgIC8vIGtlZXBzIHRoZSBzdW1tYXJ5IGxpbmUgaXQgaGFkLiBUaGUgY291bnQgaXMgbm90IHBhcnQgb2YgYGZhaWx1cmVzYC5cbiAgICAuLi4ocHJlcHJSZXZpZXdDaGFuZ2VzUmVxdWVzdGVkID4gMFxuICAgICAgPyBbYHByZXByX3Jldmlld19jaGFuZ2VzX3JlcXVlc3RlZD0ke3ByZXByUmV2aWV3Q2hhbmdlc1JlcXVlc3RlZH1gXVxuICAgICAgOiBbXSksXG4gIF0uam9pbihcIiBcIik7XG59XG5cbi8qKlxuICogVGhlIGNlbnN1cydzIHBlci1yZXBvIGRlZmVycmFsIGNvdW50cywgaW4gdGhlIG9yZGVyIHRoZXkgYXJlIGNvbnN1bHRlZFxuICogd2hlbiB0aGUgZmxlZXQgd2FzIHNjYW5uZWQgYnV0IGNsYWltZWQgbm90aGluZy4gVGllcyBicmVhayBvbiB0aGlzXG4gKiBvcmRlciwgc28gdGhlIGF0dHJpYnV0aW9uIGlzIGRldGVybWluaXN0aWMuXG4gKi9cbmNvbnN0IERFRkVSUkFMX1JFQVNPTlM6IFJlYWRvbmx5QXJyYXk8XG4gIFtrZXlvZiBDZW5zdXNSZWFzb25JbnB1dCwgRmxlZXRJZGxlUmVhc29uXVxuPiA9IFtcbiAgW1wiZGVwZW5kZW5jeUJsb2NrZWRcIiwgXCJkZXBlbmRlbmN5X2Jsb2NrZWRcIl0sXG4gIFtcInN0cmVhbU9jY3VwaWVkXCIsIFwic3RyZWFtX29jY3VwaWVkXCJdLFxuICBbXCJwckJsb2NrZWRcIiwgXCJwcl9ibG9ja2VkXCJdLFxuICBbXCJydW5Mb2NhbEhvbGRcIiwgXCJjb29sZG93bl9sb2NhbFwiXSxcbiAgW1wibG93UHJpb3JpdHlTdXBwcmVzc2VkXCIsIFwibG93X3ByaW9yaXR5X3N1cHByZXNzZWRcIl0sXG4gIFtcIndvcmtPblN1cHByZXNzZWRcIiwgXCJ3b3JrX29uX3N1cHByZXNzZWRcIl0sXG5dO1xuXG4vKipcbiAqIFJlZHVjZSBhIGN5Y2xlJ3MgcGVyLXJlcG8gY2Vuc3VzIHJvd3MgdG8gdGhlIHNpbmdsZSByZWFzb24gdGhlIGZsZWV0IHdhc1xuICogaWRsZS4gVGhlIG1vc3QgZnJlcXVlbnQgc2tpcCByZWFzb24gd2lucywgdGllcyBicmVha2luZyBvbiBmaXJzdC1zZWVuXG4gKiBvcmRlci5cbiAqXG4gKiBUaGUgY2Vuc3VzIG9ubHkgZXZlciBzZXRzIGEgc2tpcCByZWFzb24gZm9yIHRoZSBjbGFpbSBnYXRlc1xuICogKGBob3N0X2Rpc2tfbG93YCwgYHdvcmtfdm9sdW1lX2ZhdWx0YCwgYGN5Y2xlX2RlYWRsaW5lYCkg4oCUIGV2ZXJ5IG90aGVyXG4gKiByZXBvIHJlYWRzIGBzY2FubmVkYCwgc28gc3RvcHBpbmcgdGhlcmUgd291bGQgbGVhdmUgdGhlIHJlYXNvbnMgdGhlXG4gKiBpc3N1ZSBhY3R1YWxseSBuYW1lcyAoZGVwZW5kZW5jeS1ibG9ja2VkLCBQUi1ibG9ja2VkLCBzdHJlYW0tb2NjdXBpZWQpXG4gKiBwZXJtYW5lbnRseSB1bnJlYWNoYWJsZS4gQSBzY2FubmVkIGZsZWV0IGlzIHRoZXJlZm9yZSBzcGxpdCBmdXJ0aGVyOlxuICpcbiAqICAgLSB1bmJsb2NrZWQgcHJpb3JpdHkgd29yayBpcyBzdGlsbCBvcGVuIOKGkiBgbm90aGluZ19jbGFpbWFibGVfYmFja2xvZ2AsXG4gKiAgICAgdGhlIGlkbGUtdnMtd29yay1vbiBpbnZlcnNpb24sIGFuZCB0aGUgZmF1bHQgd29ydGggYWxlcnRpbmcgb247XG4gKiAgIC0gb3RoZXJ3aXNlIHRoZSBkb21pbmFudCBwZXItcmVwbyBkZWZlcnJhbCBjb3VudCBuYW1lcyB0aGUgcmVhc29uO1xuICogICAtIG90aGVyd2lzZSB0aGVyZSB3YXMgZ2VudWluZWx5IG5vdGhpbmcgdG8gY2xhaW0g4oaSXG4gKiAgICAgYG5vdGhpbmdfY2xhaW1hYmxlX2VtcHR5YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZUlkbGVSZWFzb24oXG4gIGVudHJpZXM6IHJlYWRvbmx5IENlbnN1c1JlYXNvbklucHV0W10sXG4pOiBGbGVldElkbGVSZWFzb24ge1xuICBjb25zdCBmaXJzdCA9IGVudHJpZXNbMF07XG4gIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gXCJ1bmtub3duXCI7XG4gIGNvbnN0IGNvdW50cyA9IG5ldyBNYXA8UmVwb0NlbnN1c1NraXBSZWFzb24sIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgY291bnRzLnNldChlbnRyeS5za2lwUmVhc29uLCAoY291bnRzLmdldChlbnRyeS5za2lwUmVhc29uKSA/PyAwKSArIDEpO1xuICB9XG4gIGxldCB3aW5uZXI6IFJlcG9DZW5zdXNTa2lwUmVhc29uID0gZmlyc3Quc2tpcFJlYXNvbjtcbiAgbGV0IGJlc3QgPSBjb3VudHMuZ2V0KHdpbm5lcikgPz8gMDtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgY29uc3QgY291bnQgPSBjb3VudHMuZ2V0KGVudHJ5LnNraXBSZWFzb24pID8/IDA7XG4gICAgaWYgKGNvdW50ID4gYmVzdCkge1xuICAgICAgd2lubmVyID0gZW50cnkuc2tpcFJlYXNvbjtcbiAgICAgIGJlc3QgPSBjb3VudDtcbiAgICB9XG4gIH1cbiAgaWYgKHdpbm5lciAhPT0gXCJzY2FubmVkXCIpIHJldHVybiB3aW5uZXI7XG5cbiAgY29uc3Qgc2Nhbm5lZCA9IGVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkuc2tpcFJlYXNvbiA9PT0gXCJzY2FubmVkXCIpO1xuICBpZiAoc2Nhbm5lZC5zb21lKChlbnRyeSkgPT4gZW50cnkuaW52ZXJzaW9uU2lnbmFsID09PSB0cnVlKSkge1xuICAgIHJldHVybiBcIm5vdGhpbmdfY2xhaW1hYmxlX2JhY2tsb2dcIjtcbiAgfVxuICBsZXQgZG9taW5hbnQ6IEZsZWV0SWRsZVJlYXNvbiB8IHVuZGVmaW5lZDtcbiAgbGV0IGRvbWluYW50Q291bnQgPSAwO1xuICBmb3IgKGNvbnN0IFtmaWVsZCwgcmVhc29uXSBvZiBERUZFUlJBTF9SRUFTT05TKSB7XG4gICAgY29uc3QgdG90YWwgPSBzY2FubmVkLnJlZHVjZShcbiAgICAgIChzdW0sIGVudHJ5KSA9PlxuICAgICAgICBzdW0gKyAodHlwZW9mIGVudHJ5W2ZpZWxkXSA9PT0gXCJudW1iZXJcIiA/IGVudHJ5W2ZpZWxkXSA6IDApLFxuICAgICAgMCxcbiAgICApO1xuICAgIGlmICh0b3RhbCA+IGRvbWluYW50Q291bnQpIHtcbiAgICAgIGRvbWluYW50ID0gcmVhc29uO1xuICAgICAgZG9taW5hbnRDb3VudCA9IHRvdGFsO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZG9taW5hbnQgPz8gXCJub3RoaW5nX2NsYWltYWJsZV9lbXB0eVwiO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0RDLEdBME9ELCtEQUErRCxHQUMvRCxNQUFNLHdCQUF3QjtBQXFDOUIsbUVBQW1FLEdBQ25FLFNBQVM7RUFDUCxPQUFPO0lBQ0wsZ0JBQWdCO0lBQ2hCLGVBQWU7SUFDZixr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
// denoCacheMetadata=494563889560023553,3712354908773878470