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
 *     a failure in the self-heal health report rather than dropped.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildContainerEscalationParams,
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
          e.action === "escalated" || e.action === "escalation_undeliverable"
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
    const undeliverable = events.filter((e) =>
      e.action === "escalation_undeliverable"
    );
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
    const undeliverable = events.filter((e) =>
      e.action === "escalation_undeliverable"
    );
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
    const undeliverable = events.filter((e) =>
      e.action === "escalation_undeliverable"
    );
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
