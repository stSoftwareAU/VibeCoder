/**
 * Tests for the container restart backoff and GitHub escalation (Issue #4072).
 *
 * The supervisor treats the container as disposable: a crashed container is
 * recovered by re-invoking the launcher. These tests pin the self-healing
 * behaviour that stops that recovery becoming a restart storm and stops a
 * permanently broken host disappearing into a local log:
 *
 *   - backoff grows across consecutive failures and resets after a success;
 *   - each recovery lands in the `self-heal-summary` output;
 *   - escalation fires at the consecutive-failure threshold and is then
 *     rate-limited by the existing crash-notification cooldown;
 *   - the failure phase (runtime detection, image build, container start,
 *     worker run) is carried into the escalation message, with a failed image
 *     build escalating earlier than a failed worker run;
 *   - `loop.sh` actually asks for the backoff and sleeps it;
 *   - a quota pause is recorded as the scheduled outcome it is, on a fixed
 *     re-probe cadence, and never as a failure (Issue #342).
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildContainerEscalationParams,
  classifyLauncherOutcome,
  computeBackoffSeconds,
  computeQuotaPauseSleepSeconds,
  CONTAINER_RESTART_DEFAULTS,
  type ContainerRestartConfig,
  type ContainerRestartOutcome,
  describeFailurePhase,
  escalationThresholdFor,
  loadContainerRestartState,
  recordContainerRestartOutcome,
  resolveContainerRestartConfig,
  resolveFailurePhase,
  resolveInFlightIssue,
} from "../lib/container_restart_backoff.ts";
import {
  consumeQuotaPauseMarker,
  QUOTA_PAUSE_EXIT_STATUS,
  type QuotaPauseMarker,
  writeQuotaPauseMarker,
} from "../lib/quota_pause.ts";
import { containerRestartBackoffCommand } from "../commands/container_restart_backoff.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  buildCrashMessage,
  type CrashNotificationConfig,
  type CrashNotificationParams,
} from "../lib/crash_notification.ts";
import { summariseSelfHealEvents } from "../lib/self_heal_events.ts";

const TEST_FILE_PATH = new URL(import.meta.url).pathname;
const REPO_ROOT = TEST_FILE_PATH.replace(/\/worker\/deno\/tests\/[^/]+$/, "");
const join = (...parts: string[]): string => parts.join("/");

/** A recorded escalation attempt from the injected notification seam. */
interface RecordedEscalation {
  config: CrashNotificationConfig;
  params: CrashNotificationParams;
}

interface Harness {
  workDir: string;
  crashConfig: CrashNotificationConfig;
  escalations: RecordedEscalation[];
  cleanup: () => Promise<void>;
}

async function setupHarness(): Promise<Harness> {
  const workDir = await Deno.makeTempDir({ prefix: "vibe_restart_backoff_" });
  return {
    workDir,
    crashConfig: {
      workerName: "test-worker",
      cooldownSeconds: 600,
      logTailMaxBytes: 50000,
      stateDir: join(workDir, "state"),
    },
    escalations: [],
    cleanup: async () => {
      try {
        await Deno.remove(workDir, { recursive: true });
      } catch { /* best-effort */ }
    },
  };
}

/** Short-cycle config so tests do not depend on production defaults. */
const FAST_CONFIG: Partial<ContainerRestartConfig> = {
  baseSleepSeconds: 10,
  maxBackoffSeconds: 100,
  escalationThreshold: 3,
  imageBuildEscalationThreshold: 2,
  quotaPauseSleepSeconds: 50,
};

/** Record one launcher outcome against a harness, capturing escalations. */
function record(
  harness: Harness,
  exitStatus: number,
  phaseMarker: string | null,
  overrides: Partial<ContainerRestartConfig> = FAST_CONFIG,
  quotaPause: QuotaPauseMarker | null = null,
) {
  return recordContainerRestartOutcome({
    workDir: harness.workDir,
    exitStatus,
    phaseMarker,
    quotaPause,
    config: overrides,
    crashConfig: harness.crashConfig,
    send: (config, params) => {
      harness.escalations.push({ config, params });
      return Promise.resolve({
        ok: true as const,
        value: { notified: true },
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Phase resolution
// ---------------------------------------------------------------------------

Deno.test("resolveFailurePhase - names the phase the launcher reached", () => {
  assertEquals(
    resolveFailurePhase("runtime_detection", 1),
    "runtime_detection",
  );
  assertEquals(resolveFailurePhase("image_build", 9), "image_build");
  // The runtime CLI's own "could not start" codes are a container start
  // failure, not a worker failure.
  assertEquals(resolveFailurePhase("container_run", 125), "container_start");
  assertEquals(resolveFailurePhase("container_run", 127), "container_start");
  // Anything else after the container started is the worker's own exit.
  assertEquals(resolveFailurePhase("container_run", 17), "worker_run");
  // A missing or unreadable marker must not crash the supervisor.
  assertEquals(resolveFailurePhase(null, 17), "worker_run");
  assertEquals(resolveFailurePhase("  image_build\n", 1), "image_build");
  // A marker from a removed mode (Issue #4) is unrecognised, and an
  // unrecognised marker is attributed to the worker run - the phase that
  // owns the exit status.
  assertEquals(resolveFailurePhase("native_run", 17), "worker_run");
  assertEquals(resolveFailurePhase("seatbelt_run", 125), "worker_run");
});

Deno.test("escalationThresholdFor - a failed image build escalates earlier", () => {
  const config = { ...CONTAINER_RESTART_DEFAULTS };
  assert(
    escalationThresholdFor("image_build", config) <
      escalationThresholdFor("worker_run", config),
    "an unreconstructable environment must escalate before a worker crash",
  );
  assertEquals(
    escalationThresholdFor("container_start", config),
    config.escalationThreshold,
  );
});

// ---------------------------------------------------------------------------
// Backoff growth
// ---------------------------------------------------------------------------

Deno.test("computeBackoffSeconds - grows exponentially and caps", () => {
  const config = {
    ...CONTAINER_RESTART_DEFAULTS,
    baseSleepSeconds: 10,
    maxBackoffSeconds: 100,
  };
  assertEquals(computeBackoffSeconds(0, config), 10);
  assertEquals(computeBackoffSeconds(1, config), 10);
  assertEquals(computeBackoffSeconds(2, config), 20);
  assertEquals(computeBackoffSeconds(3, config), 40);
  assertEquals(computeBackoffSeconds(4, config), 80);
  // Capped, and stays capped.
  assertEquals(computeBackoffSeconds(5, config), 100);
  assertEquals(computeBackoffSeconds(50, config), 100);
});

Deno.test("recordContainerRestartOutcome - consecutive failures back off, success resets", async () => {
  const harness = await setupHarness();
  try {
    const first = await record(harness, 17, "container_run");
    const second = await record(harness, 17, "container_run");
    const third = await record(harness, 17, "container_run");

    assertEquals(first.consecutiveFailures, 1);
    assertEquals(second.consecutiveFailures, 2);
    assertEquals(third.consecutiveFailures, 3);
    assert(
      second.backoffSeconds > first.backoffSeconds,
      `backoff must grow: ${first.backoffSeconds} -> ${second.backoffSeconds}`,
    );
    assert(
      third.backoffSeconds > second.backoffSeconds,
      `backoff must keep growing: ${second.backoffSeconds} -> ${third.backoffSeconds}`,
    );
    assertEquals(first.phase, "worker_run");

    // A successful run resets the counter and the backoff.
    const success = await record(harness, 0, "container_run");
    assertEquals(success.consecutiveFailures, 0);
    assertEquals(success.recovered, true);
    assertEquals(success.phase, null);
    assertEquals(success.backoffSeconds, FAST_CONFIG.baseSleepSeconds);

    // The reset is persisted, so the next failure starts from the base again.
    const afterReset = await record(harness, 17, "container_run");
    assertEquals(afterReset.consecutiveFailures, 1);
    assertEquals(afterReset.backoffSeconds, first.backoffSeconds);

    const state = await loadContainerRestartState(harness.workDir);
    assertEquals(state.consecutiveFailures, 1);
    assertEquals(state.lastPhase, "worker_run");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a clean run with no prior failure is not a recovery", async () => {
  const harness = await setupHarness();
  try {
    const outcome = await record(harness, 0, "container_run");
    assertEquals(outcome.recovered, false);
    assertEquals(outcome.consecutiveFailures, 0);
    const summary = await summariseSelfHealEvents({ workDir: harness.workDir });
    assertEquals(summary.totalEvents, 0);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Self-heal events
// ---------------------------------------------------------------------------

Deno.test("recordContainerRestartOutcome - recoveries appear in the self-heal summary", async () => {
  const harness = await setupHarness();
  try {
    await record(harness, 91, "image_build");
    await record(harness, 0, "container_run");

    const summary = await summariseSelfHealEvents({ workDir: harness.workDir });
    const modules = summary.perModule.map((stat) => stat.module);
    assert(
      modules.includes("container_restart"),
      `expected a container_restart module in ${JSON.stringify(modules)}`,
    );

    const actions = summary.recent.map((event) => event.action);
    assert(
      actions.includes("restart_backoff"),
      `expected a restart_backoff event in ${JSON.stringify(actions)}`,
    );
    assert(
      actions.includes("recovered"),
      `expected a recovered event in ${JSON.stringify(actions)}`,
    );

    const backoffEvent = summary.recent.find((e) =>
      e.action === "restart_backoff"
    );
    assertEquals(backoffEvent?.details?.phase, "image_build");
    assertEquals(backoffEvent?.result, "ok");
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

Deno.test("recordContainerRestartOutcome - escalates at the threshold, not before", async () => {
  const harness = await setupHarness();
  try {
    const first = await record(harness, 17, "container_run");
    const second = await record(harness, 17, "container_run");
    assertEquals(first.escalated, false);
    assertEquals(second.escalated, false);
    assertEquals(harness.escalations.length, 0);

    const third = await record(harness, 17, "container_run");
    assertEquals(third.escalated, true);
    assertEquals(harness.escalations.length, 1);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a failed image build escalates earlier than a worker run", async () => {
  const harness = await setupHarness();
  try {
    await record(harness, 91, "image_build");
    assertEquals(harness.escalations.length, 0);
    const second = await record(harness, 91, "image_build");
    assertEquals(second.phase, "image_build");
    assertEquals(second.escalated, true);
    assertEquals(harness.escalations.length, 1);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - escalation names the failure phase", async () => {
  const harness = await setupHarness();
  try {
    await record(harness, 91, "image_build");
    await record(harness, 91, "image_build");

    assertEquals(harness.escalations.length, 1);
    const escalation = harness.escalations[0]!;
    assertStringIncludes(escalation.params.workStage, "image build");
    assertStringIncludes(escalation.params.logTail, "image_build");
    assertStringIncludes(escalation.params.logTail, "Consecutive");
    assertEquals(escalation.params.exitCode, 91);
    assertEquals(escalation.params.plannedShutdown, false);

    // The phase must survive into the message that reaches GitHub.
    const message = buildCrashMessage(harness.crashConfig, escalation.params);
    assertStringIncludes(message, "image build");
  } finally {
    await harness.cleanup();
  }
});

Deno.test("buildContainerEscalationParams - each phase is described in the message", () => {
  const config: CrashNotificationConfig = {
    workerName: "test-worker",
    cooldownSeconds: 600,
    logTailMaxBytes: 50000,
    stateDir: "/tmp/does-not-matter",
  };
  const phases = [
    "runtime_detection",
    "image_build",
    "container_start",
    "worker_run",
  ] as const;

  for (const phase of phases) {
    const params = buildContainerEscalationParams({
      phase,
      exitStatus: 42,
      consecutiveFailures: 3,
      backoffSeconds: 120,
      threshold: 3,
    });
    const message = buildCrashMessage(config, params);
    assertStringIncludes(message, describeFailurePhase(phase));
    assertStringIncludes(message, phase);
  }
});

Deno.test("recordContainerRestartOutcome - escalation is rate-limited by the crash cooldown", async () => {
  const harness = await setupHarness();
  try {
    // No `send` override: the real crash-notification channel runs with an
    // empty repo (no GitHub call, no webhook configured), so only its
    // cooldown state is exercised. The cooldown is set beyond the first
    // re-notify interval so a due re-notification still meets a closed
    // channel.
    let nowSeconds = 1_700_000_000;
    const options = {
      workDir: harness.workDir,
      phaseMarker: "container_run",
      config: FAST_CONFIG,
      crashConfig: { ...harness.crashConfig, cooldownSeconds: 7200 },
      now: () => nowSeconds,
    };

    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    await recordContainerRestartOutcome({ ...options, exitStatus: 17 });
    const atThreshold = await recordContainerRestartOutcome({
      ...options,
      exitStatus: 17,
    });
    assertEquals(atThreshold.escalated, true);

    // Issue #343 changed what the *next* failure means. It used to re-enter
    // the channel and be refused by the cooldown; now the streak has already
    // been reported, so nothing is attempted at all.
    const afterThreshold = await recordContainerRestartOutcome({
      ...options,
      exitStatus: 17,
    });
    assertEquals(afterThreshold.escalated, false);
    assertEquals(afterThreshold.escalationReason, "suppressed_same_streak");

    // Once the re-notification falls due, the channel is entered again — and
    // its cooldown is what refuses this one.
    nowSeconds += 3600;
    const reNotify = await recordContainerRestartOutcome({
      ...options,
      exitStatus: 17,
    });
    assertEquals(reNotify.escalated, false);
    assertEquals(reNotify.escalationReason, "rate_limited");
    // Refused is not dropped: it is queued for the next cycle (Issue #343).
    assertEquals(reNotify.escalationPendingAttempts, 1);

    // The suppressed escalation is still visible to operators.
    const summary = await summariseSelfHealEvents({ workDir: harness.workDir });
    const escalations = summary.recent.filter((e) => e.action === "escalated");
    assert(
      escalations.some((e) => e.result === "skipped"),
      "a rate-limited escalation must be recorded as skipped",
    );
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Quota pause (Issue #342)
// ---------------------------------------------------------------------------

/** A declaration a run would write on its way out of a quota-exhausted cycle. */
function quotaMarker(
  overrides: Partial<QuotaPauseMarker> = {},
): QuotaPauseMarker {
  return {
    declaredAtMs: Date.now(),
    reason: "Run duration expired",
    ...overrides,
  };
}

Deno.test("classifyLauncherOutcome - a declared pause is not a crash", () => {
  assertEquals(classifyLauncherOutcome(0, null), "success");
  assertEquals(classifyLauncherOutcome(17, null), "failure");
  // The run says so in its exit status ...
  assertEquals(
    classifyLauncherOutcome(QUOTA_PAUSE_EXIT_STATUS, null),
    "quota_pause",
  );
  // ... and in the marker, which is what survives a runtime that loses the
  // container's exit status and reports its own generic one instead.
  assertEquals(classifyLauncherOutcome(255, quotaMarker()), "quota_pause");
});

Deno.test("classifyLauncherOutcome - a crash while rate-limited is still a crash", () => {
  // No marker: this invocation did not declare a pause, whatever an earlier
  // one did or how out-of-quota the host happens to be.
  assertEquals(classifyLauncherOutcome(139, null), "failure");
  assertEquals(classifyLauncherOutcome(91, null), "failure");
});

Deno.test("computeQuotaPauseSleepSeconds - a fixed cadence, clamped to a nearer reset", () => {
  const config = resolveContainerRestartConfig({
    baseSleepSeconds: 60,
    quotaPauseSleepSeconds: 3600,
  });
  const nowMs = 1_700_000_000_000;

  // No reset known: the configured cadence.
  assertEquals(computeQuotaPauseSleepSeconds(null, config, nowMs), 3600);
  assertEquals(
    computeQuotaPauseSleepSeconds(
      quotaMarker({ declaredAtMs: nowMs }),
      config,
      nowMs,
    ),
    3600,
  );
  // A window two days out still re-probes on the cadence — the quota may be
  // extended before its stated reset.
  assertEquals(
    computeQuotaPauseSleepSeconds(
      quotaMarker({ resetEpochMs: nowMs + 2 * 24 * 3600_000 }),
      config,
      nowMs,
    ),
    3600,
  );
  // A window that reopens sooner is not slept past.
  assertEquals(
    computeQuotaPauseSleepSeconds(
      quotaMarker({ resetEpochMs: nowMs + 600_000 }),
      config,
      nowMs,
    ),
    600,
  );
  // ... but never below the base sleep, so it cannot become a hot loop.
  assertEquals(
    computeQuotaPauseSleepSeconds(
      quotaMarker({ resetEpochMs: nowMs + 1_000 }),
      config,
      nowMs,
    ),
    60,
  );
});

Deno.test("recordContainerRestartOutcome - a quota pause holds a fixed cadence instead of decaying", async () => {
  const harness = await setupHarness();
  try {
    const cadence = FAST_CONFIG.quotaPauseSleepSeconds;
    const first = await record(
      harness,
      QUOTA_PAUSE_EXIT_STATUS,
      "container_run",
    );
    const second = await record(
      harness,
      QUOTA_PAUSE_EXIT_STATUS,
      "container_run",
    );
    const fifth = await (async () => {
      let last = second;
      for (let i = 0; i < 3; i++) {
        last = await record(harness, QUOTA_PAUSE_EXIT_STATUS, "container_run");
      }
      return last;
    })();

    for (const outcome of [first, second, fifth]) {
      assertEquals(outcome.kind, "quota_pause");
      assertEquals(outcome.phase, null);
      assertEquals(outcome.consecutiveFailures, 0);
      assertEquals(outcome.escalated, false);
      // No exponential decay: the fifth pause waits exactly as long as the
      // first, which is the whole point of Issue #342.
      assertEquals(outcome.backoffSeconds, cadence);
    }

    // Nothing was recorded as a failure, so nothing can escalate.
    assertEquals(harness.escalations.length, 0);
    const state = await loadContainerRestartState(harness.workDir);
    assertEquals(state.consecutiveFailures, 0);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a quota pause clears the streak without claiming a recovery", async () => {
  const harness = await setupHarness();
  try {
    await record(harness, 17, "container_run");
    await record(harness, 17, "container_run");

    const paused = await record(
      harness,
      QUOTA_PAUSE_EXIT_STATUS,
      "container_run",
    );
    assertEquals(paused.consecutiveFailures, 0);
    assertEquals(paused.recovered, false);

    const summary = await summariseSelfHealEvents({ workDir: harness.workDir });
    const actions = summary.recent.map((e) => e.action);
    assert(
      actions.includes("quota_pause"),
      `the pause must be visible to operators, got: ${actions.join(", ")}`,
    );
    // Nothing about the image is suspect, so no environment reconstruction is
    // announced and no escalation is sent.
    assertEquals(actions.includes("recovered"), false);
    assertEquals(actions.includes("escalated"), false);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - the marker classifies a pause the exit status lost", async () => {
  const harness = await setupHarness();
  try {
    // The symptom from the field: a clean quota exit surfaced to the
    // supervisor as 255 and was counted as a crash.
    const paused = await record(
      harness,
      255,
      "container_run",
      FAST_CONFIG,
      quotaMarker({ reason: "Run duration expired" }),
    );
    assertEquals(paused.kind, "quota_pause");
    assertEquals(paused.consecutiveFailures, 0);
    assertEquals(paused.backoffSeconds, FAST_CONFIG.quotaPauseSleepSeconds);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("recordContainerRestartOutcome - a crash after a quota pause still backs off", async () => {
  const harness = await setupHarness();
  try {
    await record(harness, QUOTA_PAUSE_EXIT_STATUS, "container_run");

    // The next run genuinely dies while the host is still out of quota: it
    // declared nothing, so it is a failure and backs off exactly as before.
    const crash = await record(harness, 17, "container_run");
    assertEquals(crash.kind, "failure");
    assertEquals(crash.phase, "worker_run");
    assertEquals(crash.consecutiveFailures, 1);
    assertEquals(crash.backoffSeconds, FAST_CONFIG.baseSleepSeconds);

    const second = await record(harness, 17, "container_run");
    assert(
      second.backoffSeconds > crash.backoffSeconds,
      "a real crash streak must still grow its backoff",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test({
  name:
    "container-restart-backoff command - consumes the marker and answers with the quota cadence",
  // No net: a quota pause escalates nothing, so the command must reach the
  // fixed cadence without ever opening the crash-notification channel.
  permissions: { read: true, write: true, env: true, run: true },
  async fn() {
    const harness = await setupHarness();
    const logDir = join(harness.workDir, "logs");
    try {
      await Deno.mkdir(logDir, { recursive: true });
      const written = await writeQuotaPauseMarker(logDir, quotaMarker());
      assert(written.ok, "the run must be able to declare its pause");

      const result = await containerRestartBackoffCommand.execute({
        "exit-status": 255,
        "work-dir": harness.workDir,
        "log-dir": logDir,
        "state-dir": join(harness.workDir, "state"),
        "base-sleep-seconds": 10,
        "quota-pause-sleep-seconds": 900,
      }, buildDefaultWorkerConfig());

      // The supervisor reads one integer off stdout — the fixed re-probe
      // cadence, not a grown backoff.
      assertEquals(result.success, true);
      assertEquals(result.message, "900");
      const outcome = result.data as ContainerRestartOutcome | undefined;
      assertEquals(outcome?.kind, "quota_pause");
      assertEquals(outcome?.consecutiveFailures, 0);

      // Consumed: the next outcome is judged on its own evidence.
      assertEquals(await consumeQuotaPauseMarker(logDir), null);
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "container-restart-backoff command - the quota cadence is operator-configurable by environment",
  permissions: { read: true, write: true, env: true, run: true },
  async fn() {
    const harness = await setupHarness();
    const logDir = join(harness.workDir, "logs");
    const previous = Deno.env.get("VIBE_QUOTA_PAUSE_SLEEP_SECONDS");
    try {
      await Deno.mkdir(logDir, { recursive: true });
      Deno.env.set("VIBE_QUOTA_PAUSE_SLEEP_SECONDS", "1800");

      const result = await containerRestartBackoffCommand.execute({
        "exit-status": QUOTA_PAUSE_EXIT_STATUS,
        "work-dir": harness.workDir,
        "log-dir": logDir,
        "state-dir": join(harness.workDir, "state"),
      }, buildDefaultWorkerConfig());

      assertEquals(result.message, "1800");
    } finally {
      if (previous === undefined) {
        Deno.env.delete("VIBE_QUOTA_PAUSE_SLEEP_SECONDS");
      } else {
        Deno.env.set("VIBE_QUOTA_PAUSE_SLEEP_SECONDS", previous);
      }
      await harness.cleanup();
    }
  },
});

// ---------------------------------------------------------------------------
// Escalation target
// ---------------------------------------------------------------------------

Deno.test("resolveInFlightIssue - reads the issue the crashed container was working on", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "vibe_restart_issue_" });
  try {
    assertEquals(await resolveInFlightIssue(workDir), null);

    await Deno.writeTextFile(
      join(workDir, ".heartbeat_stSoftwareAU_Vibe_Coder_4072"),
      "1700000000",
    );
    const found = await resolveInFlightIssue(workDir);
    assertEquals(found?.repo, "stSoftwareAU/Vibe_Coder");
    assertEquals(found?.issueNumber, 4072);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// loop.sh wiring
// ---------------------------------------------------------------------------

Deno.test({
  name: "loop.sh - records the launcher exit status and sleeps the backoff",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "vibe_loop_backoff_" });
    try {
      await Deno.writeTextFile(
        join(tmpDir, "loop.sh"),
        await Deno.readTextFile(join(REPO_ROOT, "loop.sh")),
      );
      await Deno.chmod(join(tmpDir, "loop.sh"), 0o755);

      // A launcher that always fails in the image-build phase.
      await Deno.writeTextFile(
        join(tmpDir, "run.sh"),
        '#!/bin/bash\necho "run" >> invocations.log\nexit 91\n',
      );
      await Deno.chmod(join(tmpDir, "run.sh"), 0o755);

      // The worker entry point loop.sh calls must exist for it to be used.
      await Deno.mkdir(join(tmpDir, "worker", "deno"), { recursive: true });
      await Deno.writeTextFile(join(tmpDir, "worker", "deno", "mod.ts"), "");
      await Deno.writeTextFile(join(tmpDir, "worker", "deno", "deno.lock"), "");

      const binDir = join(tmpDir, "bin");
      await Deno.mkdir(binDir, { recursive: true });
      await Deno.writeTextFile(
        join(binDir, "git"),
        "#!/bin/bash\nexit 0\n",
      );
      await Deno.chmod(join(binDir, "git"), 0o755);
      // Stub `deno`: record the arguments and answer with a 1-second backoff.
      await Deno.writeTextFile(
        join(binDir, "deno"),
        `#!/bin/bash\nprintf '%s\\n' "$*" >> "${tmpDir}/deno-args.log"\necho 1\n`,
      );
      await Deno.chmod(join(binDir, "deno"), 0o755);

      const child = new Deno.Command("bash", {
        args: [join(tmpDir, "loop.sh")],
        cwd: tmpDir,
        env: {
          LOOP_SLEEP_SECONDS: "1",
          PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
          HOME: tmpDir,
        },
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      try {
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const args = await Deno.readTextFile(join(tmpDir, "deno-args.log"));
        assertStringIncludes(args, "container-restart-backoff");
        assertStringIncludes(args, "--exit-status 91");
        // The loop must keep supervising, not stop at the first failure.
        const invocations = await Deno.readTextFile(
          join(tmpDir, "invocations.log"),
        );
        assert(
          invocations.split("\n").filter((l) => l.trim()).length >= 2,
          "loop.sh must re-invoke the launcher after a failure",
        );
      } finally {
        try {
          child.kill("SIGKILL");
        } catch { /* already dead */ }
        await child.status;
        await child.stdout.cancel().catch(() => {});
        await child.stderr.cancel().catch(() => {});
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "loop.sh - names a quota pause instead of reporting a crash",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "vibe_loop_quota_" });
    try {
      await Deno.writeTextFile(
        join(tmpDir, "loop.sh"),
        await Deno.readTextFile(join(REPO_ROOT, "loop.sh")),
      );
      await Deno.chmod(join(tmpDir, "loop.sh"), 0o755);

      // A launcher whose worker stopped because the host is out of quota.
      await Deno.writeTextFile(
        join(tmpDir, "run.sh"),
        `#!/bin/bash\nexit ${QUOTA_PAUSE_EXIT_STATUS}\n`,
      );
      await Deno.chmod(join(tmpDir, "run.sh"), 0o755);

      await Deno.mkdir(join(tmpDir, "worker", "deno"), { recursive: true });
      await Deno.writeTextFile(join(tmpDir, "worker", "deno", "mod.ts"), "");
      await Deno.writeTextFile(join(tmpDir, "worker", "deno", "deno.lock"), "");

      const binDir = join(tmpDir, "bin");
      await Deno.mkdir(binDir, { recursive: true });
      await Deno.writeTextFile(join(binDir, "git"), "#!/bin/bash\nexit 0\n");
      await Deno.chmod(join(binDir, "git"), 0o755);
      await Deno.writeTextFile(
        join(binDir, "deno"),
        `#!/bin/bash\nprintf '%s\\n' "$*" >> "${tmpDir}/deno-args.log"\necho 1\n`,
      );
      await Deno.chmod(join(binDir, "deno"), 0o755);

      const child = new Deno.Command("bash", {
        args: [join(tmpDir, "loop.sh")],
        cwd: tmpDir,
        env: {
          LOOP_SLEEP_SECONDS: "1",
          PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
          HOME: tmpDir,
        },
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      try {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        child.kill("SIGKILL");
        const output = await child.output();
        const stdout = new TextDecoder().decode(output.stdout);

        assertStringIncludes(stdout, "out of quota");
        assert(
          !stdout.includes("backing off and retrying"),
          `a scheduled pause must not be reported as a crash: ${stdout}`,
        );
        // The recorder still sees the outcome — it is what sets the cadence.
        assertStringIncludes(
          await Deno.readTextFile(join(tmpDir, "deno-args.log")),
          `--exit-status ${QUOTA_PAUSE_EXIT_STATUS}`,
        );
      } finally {
        try {
          child.kill("SIGKILL");
        } catch { /* already dead */ }
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});

/**
 * Run the real `run.sh` against a host with no worker configuration, so it
 * cannot get past the launch plan — the runtime-detection phase. No container
 * is built or started.
 */
async function runLauncherWithoutConfig(
  tmpDir: string,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const outcome = await new Deno.Command("bash", {
    args: [join(REPO_ROOT, "run.sh")],
    env: {
      HOME: tmpDir,
      WORK_DIR: tmpDir,
      CONFIG_PATH: join(tmpDir, "absent-config.json"),
      VIBE_LAUNCH_PHASE_FILE: join(tmpDir, "last-launch-phase"),
      VIBE_STATE_DIR: join(tmpDir, "state"),
      CRASH_NOTIFICATION_STATE_DIR: join(tmpDir, "state"),
      ...extraEnv,
    },
    stdout: "null",
    stderr: "null",
  }).output();
  return outcome.code;
}

Deno.test({
  name: "run.sh - records the launch phase it reached",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "vibe_run_phase_" });
    try {
      const code = await runLauncherWithoutConfig(tmpDir);
      assert(code !== 0, "a launcher with no configuration must fail loudly");
      const marker = await Deno.readTextFile(join(tmpDir, "last-launch-phase"));
      assertEquals(marker.trim(), "runtime_detection");
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "run.sh - records its own outcome unless a supervisor is recording",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Scheduler path (cron/launchd/systemd/Task Scheduler): no supervising
    // process between runs, so the launcher must count the failure itself.
    const scheduled = await Deno.makeTempDir({ prefix: "vibe_run_record_" });
    // Supervisor path: loop.sh records the same outcome, so run.sh must not
    // count it a second time.
    const supervised = await Deno.makeTempDir({ prefix: "vibe_run_record_" });
    try {
      await runLauncherWithoutConfig(scheduled);
      const state = await loadContainerRestartState(scheduled);
      assertEquals(state.consecutiveFailures, 1);
      assertEquals(state.lastPhase, "runtime_detection");

      await runLauncherWithoutConfig(supervised, {
        VIBE_SUPERVISOR_RECORDS_OUTCOME: "1",
      });
      const deferred = await loadContainerRestartState(supervised);
      assertEquals(deferred.consecutiveFailures, 0);
    } finally {
      await Deno.remove(scheduled, { recursive: true }).catch(() => {});
      await Deno.remove(supervised, { recursive: true }).catch(() => {});
    }
  },
});
