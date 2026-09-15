/**
 * Per-streak container escalation and retry of suppressed escalations
 * (Issue #343).
 *
 * `~/logs/self-heal.jsonl` held 59 `escalated` events that were a handful of
 * streaks reported once *per failure* — one streak reached 54 reports — and
 * the escalations the crash channel rate-limited were dropped with no retry
 * and no record. These tests pin the corrected behaviour:
 *
 *   - one escalation per streak, on the threshold crossing, not one per
 *     failure;
 *   - re-notification on a decaying schedule (crossing, then hourly, then
 *     daily) rather than every cycle;
 *   - a broken streak that starts again escalates again;
 *   - a suppressed escalation is queued and retried until the limiter allows
 *     it, and the delivered report carries the attempts that were lost;
 *   - an escalation still undeliverable after the attempt cap is recorded as
 *     an `escalation_lost` failure in the self-heal health report rather than
 *     dropped;
 *   - with a `callbacks.host_failure` hook configured (Issue #2108), it is the
 *     hook's status — not the crash channel's — that decides whether anybody
 *     was told, while the crash channel's own result is still recorded.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildContainerEscalationParams,
  computeBackoffSeconds,
  CONTAINER_RESTART_DEFAULTS,
  type ContainerRestartConfig,
  type ContainerRestartDecision,
  ESCALATION_MAX_ATTEMPTS,
  type EscalationPlan,
  formatContainerEscalationMarker,
  nextContainerRestartDecision,
  planStreakEscalation,
  recordContainerRestartOutcome,
  reNotifyIntervalSeconds,
  type StreakEscalationState,
} from "../lib/container_restart_backoff.ts";
import type {
  CrashNotificationConfig,
  CrashNotificationParams,
} from "../lib/crash_notification.ts";
import { summariseSelfHealEvents } from "../lib/self_heal_events.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import type { HostFailurePayload } from "../lib/host_failure_hook.ts";
import type { CallbackInvocation } from "../lib/run_callbacks.ts";

const HOUR = 3600;
const DAY = 86400;

/** Narrow a plan that must send, failing the test when it does not. */
function sending(
  plan: EscalationPlan,
): Extract<EscalationPlan, { send: true }> {
  if (!plan.send) {
    throw new Error(
      `expected an escalation to be sent, got ${JSON.stringify(plan)}`,
    );
  }
  return plan;
}

/** Narrow a plan that must not send, failing the test when it does. */
function withheld(
  plan: EscalationPlan,
  message: string,
): Extract<EscalationPlan, { send: false }> {
  if (plan.send) throw new Error(`${message}: ${JSON.stringify(plan)}`);
  return plan;
}

/** Short-cycle config so tests do not depend on production defaults. */
const FAST_CONFIG: Partial<ContainerRestartConfig> = {
  baseSleepSeconds: 10,
  maxBackoffSeconds: 100,
  escalationThreshold: 3,
  imageBuildEscalationThreshold: 2,
  quotaPauseSleepSeconds: 50,
};

/** One recorded delivery attempt through the injected notification seam. */
interface Attempt {
  params: CrashNotificationParams;
  /** What the seam returned for this attempt. */
  notified: boolean;
}

interface Harness {
  workDir: string;
  crashConfig: CrashNotificationConfig;
  attempts: Attempt[];
  /** Reasons the seam returns, consumed one per attempt; `null` = delivered. */
  suppressWith: (string | null)[];
  /** Current clock, in Unix seconds — advanced by the tests. */
  nowSeconds: number;
  record: (exitStatus: number, marker: string | null) => Promise<
    Awaited<ReturnType<typeof recordContainerRestartOutcome>>
  >;
  escalatedEvents: () => Promise<
    { reason: string; result: string; action: string }[]
  >;
  cleanup: () => Promise<void>;
}

async function setupHarness(): Promise<Harness> {
  const workDir = await Deno.makeTempDir({ prefix: "vibe_escalation_streak_" });
  const harness: Harness = {
    workDir,
    crashConfig: {
      workerName: "test-worker",
      cooldownSeconds: 600,
      logTailMaxBytes: 50000,
      stateDir: `${workDir}/state`,
    },
    attempts: [],
    suppressWith: [],
    nowSeconds: 1_700_000_000,
    record: (exitStatus, marker) =>
      recordContainerRestartOutcome({
        workDir,
        exitStatus,
        phaseMarker: marker,
        config: FAST_CONFIG,
        crashConfig: harness.crashConfig,
        now: () => harness.nowSeconds,
        send: (_config, params) => {
          const reason = harness.suppressWith.shift() ?? null;
          harness.attempts.push({ params, notified: reason === null });
          return Promise.resolve({
            ok: true as const,
            value: reason === null
              ? { notified: true }
              : { notified: false, reason },
          });
        },
      }),
    escalatedEvents: async () => {
      const summary = await summariseSelfHealEvents({
        workDir,
        recentLimit: 500,
      });
      return summary.recent
        .filter((e) =>
          e.action === "escalated" || e.action === "escalation_lost"
        )
        .map((e) => ({
          reason: e.reason,
          result: e.result,
          action: e.action,
        }));
    },
    cleanup: async () => {
      try {
        await Deno.remove(workDir, { recursive: true });
      } catch { /* best-effort */ }
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// The decaying re-notify schedule
// ---------------------------------------------------------------------------

Deno.test("reNotifyIntervalSeconds - crossing, then hourly, then daily", () => {
  // The threshold crossing is immediate — nothing has been reported yet.
  assertEquals(reNotifyIntervalSeconds(0), 0);
  // One report delivered: the next is an hour away, not the next cycle.
  assertEquals(reNotifyIntervalSeconds(1), HOUR);
  // From the second onwards a genuinely stuck host stays visible daily.
  assertEquals(reNotifyIntervalSeconds(2), DAY);
  assertEquals(reNotifyIntervalSeconds(9), DAY);
  // Never decays back to per-cycle for any count.
  for (let delivered = 1; delivered <= 60; delivered++) {
    assert(
      reNotifyIntervalSeconds(delivered) >= HOUR,
      `re-notify must never drop below an hour (delivered=${delivered})`,
    );
  }
});

// ---------------------------------------------------------------------------
// planStreakEscalation — the pure dedup decision
// ---------------------------------------------------------------------------

/** A failure decision at `failures` consecutive failures of `phase`. */
function failureDecision(
  failures: number,
  streakStartedAt: number,
  phase: "worker_run" | "image_build" = "worker_run",
): ContainerRestartDecision {
  return {
    state: {
      consecutiveFailures: failures,
      lastPhase: phase,
      lastExitStatus: 17,
      lastUpdated: streakStartedAt,
      streakStartedAt,
      escalation: null,
    },
    kind: "failure",
    phase,
    backoffSeconds: 60,
    escalate: failures >= 3,
    recovered: false,
    threshold: 3,
  };
}

/** An escalation record for a streak that has already reported once. */
function reportedStreak(
  overrides: Partial<StreakEscalationState> = {},
): StreakEscalationState {
  return {
    phase: "worker_run",
    streakStartedAt: 1000,
    delivered: 1,
    lastNotifiedAt: 1000,
    lastAttemptAt: 1000,
    pending: null,
    ...overrides,
  };
}

Deno.test("planStreakEscalation - below the threshold nothing is sent", () => {
  const plan = withheld(
    planStreakEscalation(null, failureDecision(2, 1000), 1000),
    "two failures must not escalate",
  );
  assertEquals(plan.reason, "below_threshold");
});

Deno.test("planStreakEscalation - the threshold crossing sends", () => {
  const plan = sending(
    planStreakEscalation(null, failureDecision(3, 1000), 1000),
  );
  assertEquals(plan.kind, "crossing");
  assertEquals(plan.delivered, 0);
});

Deno.test("planStreakEscalation - failures 4..54 of one streak are suppressed", () => {
  const streak = reportedStreak();
  // The flood in Issue #343: every failure after the crossing produced a
  // report. Each of these is the same incident, still inside the hour.
  for (let failures = 4; failures <= 54; failures++) {
    const plan = withheld(
      planStreakEscalation(
        streak,
        failureDecision(failures, 1000),
        1000 + failures,
      ),
      `failure ${failures} of one streak must not escalate again`,
    );
    assertEquals(plan.reason, "suppressed_same_streak");
  }
});

Deno.test("planStreakEscalation - re-notifies hourly then daily, not per cycle", () => {
  const streak = reportedStreak();

  // One second before the hour is up: still the same, already-reported
  // incident.
  withheld(
    planStreakEscalation(streak, failureDecision(40, 1000), 1000 + HOUR - 1),
    "a re-notification must not fire early",
  );

  // On the hour, the still-stuck host is re-reported.
  const hourly = sending(
    planStreakEscalation(streak, failureDecision(40, 1000), 1000 + HOUR),
  );
  assertEquals(hourly.kind, "renotify");

  // After the second report the cadence decays to daily.
  const twice = reportedStreak({
    delivered: 2,
    lastNotifiedAt: 1000 + HOUR,
    lastAttemptAt: 1000 + HOUR,
  });
  withheld(
    planStreakEscalation(twice, failureDecision(90, 1000), 1000 + 2 * HOUR),
    "the third report must wait a day, not an hour",
  );
  const daily = sending(
    planStreakEscalation(twice, failureDecision(90, 1000), 1000 + HOUR + DAY),
  );
  assertEquals(daily.kind, "renotify");
});

Deno.test("planStreakEscalation - a new streak or a new phase escalates again", () => {
  const streak = reportedStreak();

  // Same phase, but the streak broke and a new one began: a new incident.
  const newStreak = sending(
    planStreakEscalation(streak, failureDecision(3, 5000), 5000),
  );
  assertEquals(newStreak.kind, "crossing");
  assertEquals(newStreak.delivered, 0);

  // Same streak, but the fault moved to a different phase — a different
  // operator action, so it gets its own report.
  const newPhase = sending(
    planStreakEscalation(streak, failureDecision(9, 1000, "image_build"), 1010),
  );
  assertEquals(newPhase.kind, "crossing");
});

Deno.test("planStreakEscalation - a queued escalation is retried, then capped", () => {
  const pendingStreak = reportedStreak({
    delivered: 0,
    lastNotifiedAt: 0,
    lastAttemptAt: 1000,
    pending: {
      attempts: 1,
      lastReason: "rate_limited",
      firstAttemptedAt: 1000,
      reported: false,
    },
  });

  // Being rate-limited is exactly the state in which a worker most needs to
  // raise its hand — the next cycle retries rather than dropping it.
  const retry = sending(
    planStreakEscalation(pendingStreak, failureDecision(4, 1000), 1001),
  );
  assertEquals(retry.kind, "retry");
  assertEquals(retry.pending?.attempts, 1);

  // At the cap the per-cycle retry stops and falls back to the schedule, so
  // an undeliverable channel cannot be hammered every cycle for ever.
  const capped = reportedStreak({
    delivered: 0,
    lastNotifiedAt: 0,
    lastAttemptAt: 1000,
    pending: {
      attempts: ESCALATION_MAX_ATTEMPTS,
      lastReason: "rate_limited",
      firstAttemptedAt: 900,
      reported: true,
    },
  });
  withheld(
    planStreakEscalation(capped, failureDecision(9, 1000), 1001),
    "a capped escalation must not retry every cycle",
  );
  const later = sending(
    planStreakEscalation(capped, failureDecision(9, 1000), 1000 + HOUR),
  );
  assertEquals(later.kind, "retry");
});

// ---------------------------------------------------------------------------
// Streak identity carried in the persisted state
// ---------------------------------------------------------------------------

Deno.test("nextContainerRestartDecision - a streak keeps its start, a new one restarts it", () => {
  const config: ContainerRestartConfig = {
    baseSleepSeconds: 10,
    maxBackoffSeconds: 100,
    escalationThreshold: 3,
    imageBuildEscalationThreshold: 2,
    egressEscalationThreshold: 1,
    quotaPauseSleepSeconds: 50,
  };
  const first = nextContainerRestartDecision(
    {
      consecutiveFailures: 0,
      lastPhase: null,
      lastExitStatus: null,
      lastUpdated: 0,
      streakStartedAt: 0,
      escalation: null,
    },
    17,
    "container_run",
    config,
    () => 500,
  );
  assertEquals(first.state.streakStartedAt, 500);

  // Second failure of the same streak keeps the identity.
  const second = nextContainerRestartDecision(
    first.state,
    17,
    "container_run",
    config,
    () => 700,
  );
  assertEquals(second.state.streakStartedAt, 500);

  // A clean run clears it, and the next failure starts a new streak.
  const clean = nextContainerRestartDecision(
    second.state,
    0,
    "container_run",
    config,
    () => 800,
  );
  assertEquals(clean.state.streakStartedAt, 0);
  assertEquals(clean.state.escalation, null);
  const third = nextContainerRestartDecision(
    clean.state,
    17,
    "container_run",
    config,
    () => 900,
  );
  assertEquals(third.state.streakStartedAt, 900);
});

// ---------------------------------------------------------------------------
// End-to-end: one report per streak
// ---------------------------------------------------------------------------

Deno.test("recordContainerRestartOutcome - a 54-failure streak escalates once, not 52 times", async () => {
  const harness = await setupHarness();
  try {
    for (let i = 0; i < 54; i++) {
      harness.nowSeconds += 120; // ~2 minutes between launcher invocations
      await harness.record(17, "container_run");
    }

    // The crossing plus the hourly/daily re-notifications — not one per
    // failure. 54 failures two minutes apart span 108 minutes: the crossing
    // and one hourly follow-up.
    assertEquals(harness.attempts.length, 2);

    const events = await harness.escalatedEvents();
    assertEquals(
      events.length,
      2,
      `one streak must not fill the health report: ${JSON.stringify(events)}`,
    );
    assert(events.every((e) => e.result === "ok"));
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - the re-notification updates rather than repeats", async () => {
  const harness = await setupHarness();
  try {
    for (let i = 0; i < 3; i++) {
      harness.nowSeconds += 60;
      await harness.record(17, "container_run");
    }
    assertEquals(harness.attempts.length, 1);
    const crossing = harness.attempts[0]!;

    harness.nowSeconds += HOUR;
    const update = await harness.record(17, "container_run");
    assertEquals(harness.attempts.length, 2);
    assertEquals(update.escalated, true);

    // Both reports carry the same streak marker, so the channel edits the
    // existing report instead of filing another (#207/#321 body-marker dedup).
    const marker = harness.attempts[1]!.params.dedupMarker;
    assert(marker, "a streak report must carry its dedup marker");
    assertEquals(crossing.params.dedupMarker, marker);
    // The update states the current count, not the crossing count.
    assertStringIncludes(harness.attempts[1]!.params.logTail, "Consecutive");
    assertStringIncludes(harness.attempts[1]!.params.logTail, "update");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a broken streak escalates again", async () => {
  const harness = await setupHarness();
  try {
    for (let i = 0; i < 3; i++) {
      harness.nowSeconds += 60;
      await harness.record(17, "container_run");
    }
    assertEquals(harness.attempts.length, 1);

    // The host heals ...
    harness.nowSeconds += 60;
    const recovered = await harness.record(0, "container_run");
    assertEquals(recovered.recovered, true);

    // ... and breaks again: a new incident, reported immediately even though
    // the previous streak's hour has not elapsed.
    for (let i = 0; i < 3; i++) {
      harness.nowSeconds += 60;
      await harness.record(17, "container_run");
    }
    assertEquals(harness.attempts.length, 2);
    assertEquals(
      harness.attempts[0]!.params.dedupMarker !==
        harness.attempts[1]!.params.dedupMarker,
      true,
      "a new streak is a new report, not an edit of the old one",
    );
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// End-to-end: a suppressed escalation is retried, never dropped
// ---------------------------------------------------------------------------

Deno.test("recordContainerRestartOutcome - a rate-limited escalation is retried and delivered", async () => {
  const harness = await setupHarness();
  try {
    // The crossing is rate-limited by the crash channel's own cooldown.
    harness.suppressWith = ["rate_limited", "rate_limited"];

    for (let i = 0; i < 3; i++) {
      harness.nowSeconds += 60;
      await harness.record(17, "container_run");
    }
    assertEquals(harness.attempts.length, 1);
    assertEquals(harness.attempts[0]!.notified, false);

    // Retried on the very next cycle rather than waiting an hour — being
    // rate-limited is not a reason to stop trying.
    harness.nowSeconds += 60;
    const second = await harness.record(17, "container_run");
    assertEquals(harness.attempts.length, 2);
    assertEquals(second.escalated, false);
    assertEquals(second.escalationPendingAttempts, 2);

    // The limiter now has room and the escalation lands.
    harness.nowSeconds += 60;
    const third = await harness.record(17, "container_run");
    assertEquals(harness.attempts.length, 3);
    assertEquals(third.escalated, true);
    assertEquals(third.escalationPendingAttempts, 0);

    // The delivered report carries what was lost, so the operator learns the
    // outage was suppressed twice before they were told.
    assertStringIncludes(
      harness.attempts[2]!.params.logTail,
      "rate_limited",
    );
    assertStringIncludes(harness.attempts[2]!.params.logTail, "2 earlier");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - an undeliverable escalation is recorded, not dropped", async () => {
  const harness = await setupHarness();
  try {
    harness.suppressWith = Array.from(
      { length: ESCALATION_MAX_ATTEMPTS + 2 },
      () => "rate_limited",
    );

    for (let i = 0; i < 3 + ESCALATION_MAX_ATTEMPTS; i++) {
      harness.nowSeconds += 60;
      await harness.record(17, "container_run");
    }

    // Attempts stop at the cap rather than hammering the channel for ever.
    assertEquals(harness.attempts.length, ESCALATION_MAX_ATTEMPTS);

    // The loss is a failure in the health report, not silence.
    const events = await harness.escalatedEvents();
    const undeliverable = events.filter((e) => e.action === "escalation_lost");
    assertEquals(undeliverable.length, 1);
    assertEquals(undeliverable[0]!.result, "failed");
    assertStringIncludes(undeliverable[0]!.reason, "rate_limited");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a streak that ends undelivered is still recorded", async () => {
  const harness = await setupHarness();
  try {
    harness.suppressWith = ["rate_limited", "rate_limited"];
    for (let i = 0; i < 3; i++) {
      harness.nowSeconds += 60;
      await harness.record(17, "container_run");
    }
    assertEquals(harness.attempts[0]!.notified, false);

    // The host heals before the escalation ever got through: the operator was
    // never told, and that must not vanish with the streak.
    harness.nowSeconds += 60;
    await harness.record(0, "container_run");

    const events = await harness.escalatedEvents();
    const undeliverable = events.filter((e) => e.action === "escalation_lost");
    assertEquals(undeliverable.length, 1);
    assertEquals(undeliverable[0]!.result, "failed");
    assertStringIncludes(undeliverable[0]!.reason, "never delivered");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a fault that moves phase does not drop the undelivered escalation", async () => {
  const harness = await setupHarness();
  try {
    // The worker_run crossing is refused by the channel and queued.
    harness.suppressWith = ["rate_limited", "rate_limited"];
    for (let i = 0; i < 3; i++) {
      harness.nowSeconds += 60;
      await harness.record(17, "container_run");
    }
    assertEquals(harness.attempts[0]!.notified, false);

    // The fault then moves to a different phase without the host ever
    // recovering, so the queued escalation belongs to a streak that is over.
    // It was never delivered, and must not vanish with the phase change.
    harness.nowSeconds += 60;
    await harness.record(17, "runtime_detection");

    const events = await harness.escalatedEvents();
    const undeliverable = events.filter((e) => e.action === "escalation_lost");
    assertEquals(undeliverable.length, 1);
    assertEquals(undeliverable[0]!.result, "failed");
    assertStringIncludes(undeliverable[0]!.reason, "never delivered");
    assertStringIncludes(undeliverable[0]!.reason, "worker_run");
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Escalation body
// ---------------------------------------------------------------------------

Deno.test("buildContainerEscalationParams - the marker identifies the streak", () => {
  const params = buildContainerEscalationParams({
    phase: "worker_run",
    exitStatus: 17,
    consecutiveFailures: 54,
    backoffSeconds: 1800,
    threshold: 3,
    streakStartedAt: 1000,
    priorEscalations: 2,
    undelivered: { attempts: 3, reason: "rate_limited" },
  });

  const marker = formatContainerEscalationMarker("worker_run", 1000);
  assertEquals(params.dedupMarker, marker);
  // Two streaks never share a marker, so an edit can never overwrite another
  // incident's report.
  assert(marker !== formatContainerEscalationMarker("worker_run", 2000));
  assert(marker !== formatContainerEscalationMarker("image_build", 1000));

  assertStringIncludes(params.logTail, "54");
  assertStringIncludes(params.logTail, "update");
  assertStringIncludes(params.logTail, "3 earlier");
  assertStringIncludes(params.logTail, "rate_limited");
});

// ---------------------------------------------------------------------------
// The hook decides delivery; the crash channel is still recorded (Issue #2108)
// ---------------------------------------------------------------------------

Deno.test("recordContainerRestartOutcome - the hook decides delivery while the crash channel is only recorded", async () => {
  const harness = await setupHarness();
  try {
    const payloads: HostFailurePayload[] = [];
    let hookStatus: CallbackInvocation["status"] = "failed";
    const record = (exitStatus: number) =>
      recordContainerRestartOutcome({
        workDir: harness.workDir,
        exitStatus,
        phaseMarker: "container_run",
        config: FAST_CONFIG,
        crashConfig: harness.crashConfig,
        now: () => harness.nowSeconds,
        hostFailureHook: {
          kind: "hook",
          path: "/opt/vibe-hooks/host-failure.sh",
          timeoutSeconds: 30,
        },
        invokeHook: (payload, hook) => {
          payloads.push(payload);
          return Promise.resolve({
            event: "host_failure",
            path: hook.path,
            status: hookStatus,
            exitCode: hookStatus === "ok" ? 0 : 1,
            stdout: "",
            stderr: "",
            durationMs: 3,
          } as CallbackInvocation);
        },
        // The crash channel delivers happily throughout — it must not be what
        // closes the incident.
        send: (_config, params) => {
          harness.attempts.push({ params, notified: true });
          return Promise.resolve({
            ok: true as const,
            value: { notified: true },
          });
        },
      });

    for (let i = 0; i < 3; i++) {
      harness.nowSeconds += 60;
      await record(17);
    }
    // The crash channel said "delivered" and the hook said "failed": the
    // escalation is pending, because the hook is the operator's channel.
    assertEquals(harness.attempts.length, 1);
    assertEquals(payloads.length, 1);

    harness.nowSeconds += 60;
    const retry = await record(17);
    assertEquals(retry.escalated, false);
    assertEquals(retry.escalationPendingAttempts, 2);

    // The hook comes good and the incident closes on its word alone.
    hookStatus = "ok";
    harness.nowSeconds += 60;
    const delivered = await record(17);
    assertEquals(delivered.escalated, true);
    assertEquals(delivered.escalationPendingAttempts, 0);
    // A retry is a repeat of a report nothing has yet delivered: the count
    // is still 1, and `attempt` is what says this is the third try.
    assertEquals(payloads[0]!.delivery, { kind: "first", count: 1 });
    assertEquals(payloads[2]!.delivery, { kind: "repeat", count: 1 });
    assertEquals(payloads[2]!.attempt, 3);

    const summary = await summariseSelfHealEvents({
      workDir: harness.workDir,
      recentLimit: 500,
    });
    const escalated = summary.recent.filter((e) => e.action === "escalated");
    assertEquals(escalated.length, 3);
    // Every attempt records what the crash channel did, without letting it
    // decide.
    assert(
      escalated.every((e) => e.details?.crashChannel === "delivered"),
      "the crash channel's own result must still be recorded",
    );
  } finally {
    await harness.cleanup();
  }
});

/** A temp work directory and crash config for the hook tests below. */
async function setupHookHarness(): Promise<{
  workDir: string;
  crashConfig: CrashNotificationConfig;
  cleanup: () => Promise<void>;
}> {
  const workDir = await Deno.makeTempDir({ prefix: "vibe_host_failure_hook_" });
  return {
    workDir,
    crashConfig: {
      workerName: "test-worker",
      cooldownSeconds: 600,
      logTailMaxBytes: 50000,
      stateDir: `${workDir}/state`,
    },
    cleanup: async () => {
      try {
        await Deno.remove(workDir, { recursive: true });
      } catch { /* best-effort */ }
    },
  };
}

// ---------------------------------------------------------------------------
// The host's own escalation channel (Issue #2108). A launcher failure used to
// file (or comment on) an issue in the worker's own repository when the crash
// channel had nobody to tell (Issue #556) — a host's outage published to a
// public repository. The channel is now the host's own
// `callbacks.host_failure` hook, and a host with no hook records locally.
// ---------------------------------------------------------------------------

/** One recorded hook invocation from the injected seam. */
interface RecordedHook {
  payload: HostFailurePayload;
  hook: { path: string; timeoutSeconds: number };
}

/** An injected hook seam that records every payload and answers `status`. */
function recordingHook(
  statuses: CallbackInvocation["status"][],
): {
  calls: RecordedHook[];
  invoke: (
    payload: HostFailurePayload,
    hook: { path: string; timeoutSeconds: number },
  ) => Promise<CallbackInvocation>;
} {
  const calls: RecordedHook[] = [];
  const queue = [...statuses];
  return {
    calls,
    invoke: (payload, hook) => {
      calls.push({ payload, hook });
      const status = queue.shift() ?? statuses[statuses.length - 1] ?? "ok";
      return Promise.resolve({
        event: "host_failure",
        path: hook.path,
        status,
        exitCode: status === "ok" ? 0 : status === "timed_out" ? 124 : 1,
        stdout: "",
        stderr: "",
        durationMs: 12,
      } as CallbackInvocation);
    },
  };
}

const CONFIGURED_HOOK = {
  kind: "hook" as const,
  path: "/opt/vibe-hooks/host-failure.sh",
  timeoutSeconds: 30,
};

Deno.test("recordContainerRestartOutcome - a delivered hook holds the crossing, hourly then daily cadence", async () => {
  const harness = await setupHookHarness();
  try {
    let nowSeconds = 1_700_000_000;
    const { calls, invoke } = recordingHook(["ok"]);
    const options = {
      workDir: harness.workDir,
      phaseMarker: "container_run",
      config: FAST_CONFIG,
      crashConfig: harness.crashConfig,
      now: () => nowSeconds,
      hostId: "GRQ-23",
      hostFailureHook: CONFIGURED_HOOK,
      invokeHook: invoke,
    };

    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    const crossing = await recordContainerRestartOutcome({
      ...options,
      exitStatus: 17,
    });

    // The hook's `ok` is what says somebody was told — the crash channel here
    // has no issue in flight and no webhook, and no longer decides.
    assertEquals(crossing.escalated, true);
    assertEquals(crossing.escalationReason, null);
    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.hook.path, CONFIGURED_HOOK.path);
    assertEquals(calls[0]!.payload.condition, "launcher");
    assertEquals(calls[0]!.payload.phase, "worker_run");
    assertEquals(calls[0]!.payload.host, "GRQ-23");
    assertEquals(calls[0]!.payload.consecutiveFailures, 3);
    assertEquals(calls[0]!.payload.lastExitStatus, 17);
    assertEquals(calls[0]!.payload.backoffSeconds, crossing.backoffSeconds);
    assertEquals(calls[0]!.payload.attempt, 1);
    assertEquals(calls[0]!.payload.delivery, { kind: "first", count: 1 });
    // The streak start is the ISO spelling of the recorder's Unix seconds.
    assertEquals(
      calls[0]!.payload.streakStartedAt,
      new Date(nowSeconds * 1000).toISOString(),
    );

    // The very next failure is the same incident and fires nothing.
    nowSeconds += 60;
    const suppressed = await recordContainerRestartOutcome({
      ...options,
      exitStatus: 17,
    });
    assertEquals(suppressed.escalationReason, "suppressed_same_streak");
    assertEquals(calls.length, 1);

    // An hour on, the streak is repeated rather than re-reported.
    nowSeconds += 3600;
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    assertEquals(calls.length, 2);
    assertEquals(calls[1]!.payload.delivery, { kind: "repeat", count: 2 });

    // And from there, daily: an hour later is too soon.
    nowSeconds += 3600;
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    assertEquals(calls.length, 2);
    nowSeconds += 86400;
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    assertEquals(calls.length, 3);
    assertEquals(calls[2]!.payload.delivery, { kind: "repeat", count: 3 });
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a hook that fails is retried to the cap, then recorded lost", async () => {
  const harness = await setupHookHarness();
  try {
    let nowSeconds = 1_700_000_000;
    const { calls, invoke } = recordingHook([
      "failed",
      "timed_out",
      "spawn_failed",
      "failed",
      "failed",
    ]);
    const options = {
      workDir: harness.workDir,
      phaseMarker: "container_run",
      config: FAST_CONFIG,
      crashConfig: harness.crashConfig,
      now: () => nowSeconds,
      hostFailureHook: CONFIGURED_HOOK,
      invokeHook: invoke,
    };

    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    const crossing = await recordContainerRestartOutcome({
      ...options,
      exitStatus: 17,
    });
    assertEquals(crossing.escalated, false);
    assertEquals(crossing.escalationReason, "hook_failed");
    assertEquals(crossing.escalationPendingAttempts, 1);

    // Retried on the next cycle rather than waiting an hour — a channel
    // refusing us is not a reason to stop trying.
    for (let i = 1; i < ESCALATION_MAX_ATTEMPTS; i++) {
      nowSeconds += 60;
      await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    }
    assertEquals(calls.length, ESCALATION_MAX_ATTEMPTS);
    // The attempt number rides the payload, so the hook can tell a retry from
    // a fresh report.
    assertEquals(calls[ESCALATION_MAX_ATTEMPTS - 1]!.payload.attempt, 5);

    // Past the cap nothing more is spawned for this streak.
    nowSeconds += 60;
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    assertEquals(calls.length, ESCALATION_MAX_ATTEMPTS);

    const summary = await summariseSelfHealEvents({
      workDir: harness.workDir,
      recentLimit: 500,
    });
    const lost = summary.recent.filter((e) => e.action === "escalation_lost");
    assertEquals(lost.length, 1);
    assertEquals(lost[0]!.result, "failed");
    const escalated = summary.recent.filter((e) => e.action === "escalated");
    assertEquals(escalated.length, ESCALATION_MAX_ATTEMPTS);
    // Each spawn outcome the contract defines queues a retry of its own.
    const statuses = new Set(escalated.map((e) => e.details?.hookStatus));
    for (const status of ["failed", "timed_out", "spawn_failed"]) {
      assert(statuses.has(status), `${status} must queue a retry of its own`);
    }
    assert(escalated.every((e) => e.result === "skipped"));
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - no hook configured spawns nothing and records locally", async () => {
  const harness = await setupHookHarness();
  try {
    // `hostFailureHook` defaults to `none`, so the spawn seam is the one
    // thing that could reach a process — and it is never reached. Injected
    // rather than stubbed over a global: nothing here mutates process state
    // that the rest of the suite shares.
    const { calls, invoke } = recordingHook(["ok"]);
    const options = {
      workDir: harness.workDir,
      phaseMarker: "container_run",
      config: FAST_CONFIG,
      crashConfig: harness.crashConfig,
      now: () => 1_700_000_000,
      invokeHook: invoke,
    };

    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    const crossing = await recordContainerRestartOutcome({
      ...options,
      exitStatus: 17,
    });
    assertEquals(calls.length, 0);
    assertEquals(crossing.escalated, false);
    // The crash channel has nobody to tell, and with no hook there is
    // nothing left to try — so it is terminal, not five retries per streak.
    assertEquals(crossing.escalationReason, "no_channel");
    assertEquals(crossing.escalationPendingAttempts, 0);

    const summary = await summariseSelfHealEvents({
      workDir: harness.workDir,
      recentLimit: 500,
    });
    const escalated = summary.recent.filter((e) => e.action === "escalated");
    assertEquals(escalated.length, 1);
    assertEquals(escalated[0]!.details?.hookStatus, "no_hook_configured");
    assertEquals(escalated[0]!.details?.crashChannel, "no_channel");
    assertEquals(
      summary.recent.filter((e) => e.action === "escalation_lost").length,
      0,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a malformed callbacks block is reported, and the backoff still stands", async () => {
  const harness = await setupHookHarness();
  try {
    const { calls, invoke } = recordingHook(["ok"]);
    const options = {
      workDir: harness.workDir,
      phaseMarker: "container_run",
      config: FAST_CONFIG,
      crashConfig: harness.crashConfig,
      now: () => 1_700_000_000,
      hostFailureHook: {
        kind: "invalid" as const,
        error: "callbacks.host_failure must be a string",
      },
      invokeHook: invoke,
    };

    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    const crossing = await recordContainerRestartOutcome({
      ...options,
      exitStatus: 17,
    });

    // Nothing is spawned against a configuration that could not be read ...
    assertEquals(calls.length, 0);
    // ... and the supervisor still gets its backoff: the escalation failing
    // never changes what the host does next.
    assertEquals(
      crossing.backoffSeconds,
      computeBackoffSeconds(3, {
        ...CONTAINER_RESTART_DEFAULTS,
        ...FAST_CONFIG,
      }),
    );

    const summary = await summariseSelfHealEvents({
      workDir: harness.workDir,
      recentLimit: 500,
    });
    const escalated = summary.recent.filter((e) => e.action === "escalated");
    assertEquals(escalated.length, 1);
    assertEquals(escalated[0]!.details?.hookStatus, "config_invalid");
    assertEquals(
      escalated[0]!.details?.hookError,
      "callbacks.host_failure must be a string",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - the payload's log tail is redacted before it reaches the hook", async () => {
  const harness = await setupHookHarness();
  try {
    const { calls, invoke } = recordingHook(["ok"]);
    const options = {
      workDir: harness.workDir,
      phaseMarker: "container_run",
      config: FAST_CONFIG,
      crashConfig: harness.crashConfig,
      now: () => 1_700_000_000,
      hostFailureHook: CONFIGURED_HOOK,
      invokeHook: invoke,
      logTail: "worker start failed\nGITHUB_TOKEN=ghp_" + "A".repeat(36),
    };

    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });

    assertEquals(calls.length, 1);
    const tail = calls[0]!.payload.logTail ?? "";
    assertStringIncludes(tail, "worker start failed");
    assertStringIncludes(tail, REDACTION_PLACEHOLDER);
    assert(
      !tail.includes("ghp_"),
      `the hook must never receive a credential: ${tail}`,
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a hook seam that throws is recorded, never swallowed", async () => {
  const harness = await setupHookHarness();
  try {
    // `invokeHostFailureHook` never throws, so a throw is a seam misbehaving.
    // It must surface as a delivery failure carrying the fault, not vanish.
    const options = {
      workDir: harness.workDir,
      phaseMarker: "container_run",
      config: FAST_CONFIG,
      crashConfig: harness.crashConfig,
      now: () => 1_700_000_000,
      hostFailureHook: CONFIGURED_HOOK,
      invokeHook: () => Promise.reject(new Error("hook seam exploded")),
    };

    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    const crossing = await recordContainerRestartOutcome({
      ...options,
      exitStatus: 17,
    });

    assertEquals(crossing.escalated, false);
    assertStringIncludes(crossing.escalationReason ?? "", "hook_spawn_failed");
    assertStringIncludes(crossing.escalationReason ?? "", "hook seam exploded");
    assertEquals(crossing.escalationPendingAttempts, 1);
    // The supervisor still gets its backoff: the escalation failing never
    // changes what the host does next.
    assertEquals(
      crossing.backoffSeconds,
      computeBackoffSeconds(3, {
        ...CONTAINER_RESTART_DEFAULTS,
        ...FAST_CONFIG,
      }),
    );

    const summary = await summariseSelfHealEvents({
      workDir: harness.workDir,
      recentLimit: 500,
    });
    const escalated = summary.recent.filter((e) => e.action === "escalated");
    assertEquals(escalated.length, 1);
    assertEquals(escalated[0]!.details?.hookStatus, "spawn_failed");
    assertStringIncludes(String(escalated[0]!.details?.reason), "exploded");
  } finally {
    await harness.cleanup();
  }
});
