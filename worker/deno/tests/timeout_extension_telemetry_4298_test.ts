/**
 * Tests for honest timeout messages and extension telemetry (Issue #4298,
 * part of #4290).
 *
 * Once a run can outlive its configured budget (#4296), every operator-facing
 * signal that hard-codes "1 hour" lies. The contract these tests pin:
 *
 * - a run granted N extensions reports `extensions.granted === N`, the total
 *   extended seconds and the final deadline on its result;
 * - `watchdogLateSeconds` is measured against the **final** deadline, so it is
 *   `0` for an on-time kill after extensions and non-zero only when the timer
 *   genuinely fired past it. A deliberately-wrong baseline (lateness measured
 *   against the original `timeoutSeconds`) fails this case, which is what
 *   proves the test discriminates;
 * - the kill log and the issue-facing failure text both name the extension
 *   count, the total elapsed and the stalled signal;
 * - with the feature disabled every message is byte-identical to today's.
 *
 * The agent is a stub script named by path (Issue #960) and the tree probe is
 * injected, so no test needs a git repository and nothing touches the
 * process-wide `PATH`. The clock is injected too (PR #1170 follow-up): the
 * stub stops at a gate instead of sleeping and the test advances the deadline
 * itself, which is what lets the lateness case assert **zero** rather than
 * "no more than two seconds" — the tolerance only ever existed because a
 * loaded host could wake the watchdog late.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  type AgentStub,
  agentStubGate,
  createAgentStub,
} from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import type { TreeProgressState } from "../lib/progress_extension.ts";
import {
  buildExtensionTelemetry,
  buildTimeoutFailureReason,
  buildTimeoutKillMessage,
  type ExtensionTelemetry,
} from "../lib/timeout_extension_telemetry.ts";
import { buildDiagnosticContext } from "../lib/execute_claude_phase.ts";
import { formatZeroOutputDiagnostics } from "../lib/failure_diagnosis.ts";
import type { Logger } from "../types.ts";

/** One stream-json line carrying a tool call, so the activity signal moves. */
const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Edit","input":{"file_path":"worker/deno/lib/x.ts"}}]}}`;

/**
 * Write a stub agent and return its path (Issue #960).
 *
 * The path goes to the runner as `agentBinaryPath`; nothing is installed on
 * `PATH`, which is process-wide and raced every other test in the run
 * (Issue #880, plan #944).
 *
 * The stub runs in the `deno test` process group — deliberately, so the
 * watchdog signals its PID and descendants and never a process GROUP
 * (Issue #471; see the note in {@link file://../../../CODING-STANDARDS.md}).
 * `terminateProcessTree` already refuses a group signal for a target sharing
 * our group, and `terminateDescendants` still reaps the stub's children, so
 * the kill under test is exercised end to end without a signal that can
 * escape the tree.
 */
function installStub(body: string): Promise<AgentStub> {
  return createAgentStub(body, { prefix: "timeout_telemetry_4298_" });
}

/**
 * A stub that reports one tool call and then waits at the gate.
 *
 * Every case here ends in a kill, so the agent's job is to be alive with the
 * activity signal set and to stay that way until the runner stops it. The old
 * `chattyStub` emitted on a `sleep` ladder, which decided for itself when the
 * agent was busy and left the test bounding a real elapsed reading.
 */
function toolThenWait(): string {
  return `printf '%s\\n' '${TOOL_LINE}'\n` + agentStubGate();
}

/** Collect log lines so the kill message can be asserted on. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  } as unknown as Logger;
  return { logger, lines };
}

/** A probe that replays a scripted verdict sequence. */
function scriptedProbe(verdicts: TreeProgressState[]) {
  let calls = 0;
  return {
    count: () => calls,
    probe: (): Promise<TreeProgressState> => {
      const verdict = verdicts[calls] ?? verdicts.at(-1) ?? "unknown";
      calls++;
      return Promise.resolve(verdict);
    },
  };
}

/**
 * Rendezvous on the run's own reported state, so an advance is never a guess.
 *
 * `chunk(1)` resolves once the agent's first stdout chunk has reached the
 * progress tracker — which is also the point at which the hard watchdog is
 * armed — and `extension(n)` once the nth grant has been decided.
 */
function rendezvous() {
  const chunks: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const extensions: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let chunksSeen = 0;
  let extensionsSeen = 0;
  const at = (
    list: ReturnType<typeof Promise.withResolvers<void>>[],
    index: number,
  ) => (list[index] ??= Promise.withResolvers<void>());
  return {
    onActivity: () => at(chunks, chunksSeen++).resolve(),
    onExtensionSeen: () => at(extensions, extensionsSeen++).resolve(),
    chunk: (n: number) => at(chunks, n - 1).promise,
    extension: (n: number) => at(extensions, n - 1).promise,
  };
}

// ---------------------------------------------------------------------------
// Runner telemetry
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithTimeout - a run granted N extensions reports N, the extended seconds and the final deadline (Issue #4298)",
  fn: async () => {
    // Two grants, then the tree stops moving — the third check kills.
    const stub = await installStub(toolThenWait());
    const { logger } = recordingLogger();
    const { probe } = scriptedProbe(["advanced", "advanced", "unchanged"]);
    const clock = fakeClock();
    const meet = rendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        onActivity: meet.onActivity,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: probe,
          onExtension: meet.onExtensionSeen,
        },
      });
      await meet.chunk(1);
      await clock.advance(1_000);
      await meet.extension(1);
      await clock.advance(1_000);
      await meet.extension(2);
      await clock.advance(1_000);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      const ext = result.value.extensions;
      assert(ext, "an active run must carry extension telemetry");
      assertEquals(ext.granted, 2, "two grants were made");
      assertEquals(ext.baseTimeoutSeconds, 1);
      // Two 1 s grants from a 1 s budget put the final deadline at exactly
      // 3 s. On the injected clock that is an equality, not a lower bound:
      // the old ">= 2" existed only because a loaded VM could check late.
      assertEquals(
        ext.finalDeadlineSeconds,
        3,
        "the final deadline is the base budget plus both grants",
      );
      assertEquals(
        ext.extendedSeconds,
        ext.finalDeadlineSeconds - ext.baseTimeoutSeconds,
        "extended seconds must be the surplus over the base budget",
      );
      assert(
        (ext.refusalReason ?? "").includes("working tree unchanged"),
        `the stalled signal must be named: ${ext.refusalReason}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - watchdogLateSeconds stays 0 for an on-time kill after extensions (Issues #4254, #4298)",
  fn: async () => {
    // One 4 s grant on a 1 s budget: the kill lands exactly 5 s in, on time
    // against the final deadline. A deliberately-wrong baseline that measured
    // lateness against the original 1 s `timeoutSeconds` would report 4 s of
    // bogus lateness here, firing #4254's starved-timer detector on every
    // extended run.
    const stub = await installStub(toolThenWait());
    const { logger } = recordingLogger();
    const { probe } = scriptedProbe(["advanced", "unchanged"]);
    const clock = fakeClock();
    const meet = rendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        onActivity: meet.onActivity,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 4, activityStallSeconds: 60 },
          treeProbe: probe,
          onExtension: meet.onExtensionSeen,
        },
      });
      await meet.chunk(1);
      await clock.advance(1_000);
      await meet.extension(1);
      await clock.advance(4_000);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(result.value.timeoutReason, "hard-timeout");
      const ext = result.value.extensions;
      assert(ext, "an active run must carry extension telemetry");
      assertEquals(ext.granted, 1, "the run must actually have been extended");
      // Absent (or 0) means "not late" — the field is omitted when zero.
      assertEquals(
        result.value.watchdogLateSeconds ?? 0,
        0,
        "lateness is measured against the final deadline, which the kill met",
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - the kill log names the extension count, the elapsed time and the stalled signal (Issue #4298)",
  fn: async () => {
    const stub = await installStub(toolThenWait());
    const { logger, lines } = recordingLogger();
    const { probe } = scriptedProbe(["advanced", "unchanged"]);
    const clock = fakeClock();
    const meet = rendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        onActivity: meet.onActivity,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: probe,
          onExtension: meet.onExtensionSeen,
        },
      });
      await meet.chunk(1);
      await clock.advance(1_000);
      await meet.extension(1);
      await clock.advance(1_000);
      const result = await run;
      assert(result.ok, "the runner must return a result");

      const kill = lines.find((l) => l.startsWith("Claude timed out after"));
      assert(kill, `a kill line must be logged, got: ${JSON.stringify(lines)}`);
      assertStringIncludes(kill, "extended 1×");
      assertStringIncludes(kill, "base budget 1s");
      assertStringIncludes(kill, "last extension refused:");
      assertStringIncludes(kill, "working tree unchanged");
      assertStringIncludes(kill, "killing process tree");
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - with the feature disabled the kill log is byte-identical to the legacy line (Issue #4298)",
  fn: async () => {
    const stub = await installStub(toolThenWait());
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const meet = rendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        onActivity: meet.onActivity,
      });
      await meet.chunk(1);
      await clock.advance(1_000);
      const result = await run;
      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.extensions,
        undefined,
        "no telemetry may be produced without the feature",
      );

      const kill = lines.find((l) => l.startsWith("Claude timed out after"));
      assert(kill, "a kill line must be logged");
      // The legacy wording, with only the #4254 late suffix permitted after it.
      const legacy =
        /^Claude timed out after 1s — killing process tree \(PID \d+\)/;
      assert(
        legacy.test(kill),
        `the disabled path must keep today's wording, got: ${kill}`,
      );
      assert(
        !kill.includes("extended"),
        `no extension wording may appear: ${kill}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a policy present but disabled produces no telemetry and the legacy line (Issue #4298)",
  fn: async () => {
    const stub = await installStub(toolThenWait());
    const { logger, lines } = recordingLogger();
    const { probe, count } = scriptedProbe(["advanced"]);
    const clock = fakeClock();
    const meet = rendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        onActivity: meet.onActivity,
        progressExtension: {
          policy: {
            enabled: false,
            grantSeconds: 60,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
        },
      });
      await meet.chunk(1);
      await clock.advance(1_000);
      const result = await run;
      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(
        result.value.extensions,
        undefined,
        "a disabled policy must produce no telemetry",
      );
      assert(count() <= 1, "a disabled policy asks the probe at most once");
      const kill = lines.find((l) => l.startsWith("Claude timed out after"));
      assert(kill, "a kill line must be logged");
      assert(
        !kill.includes("extended"),
        `the disabled policy must keep today's wording: ${kill}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// Message builders (pure)
// ---------------------------------------------------------------------------

/** Telemetry standing in for a four-extension run of a 3600 s budget. */
function extendedRun(): ExtensionTelemetry {
  return buildExtensionTelemetry({
    baseTimeoutSeconds: 3600,
    startMs: 1_000_000,
    deadlineMs: 1_000_000 + 5_640_000,
    nowMs: 1_000_000 + 5_640_000,
    granted: 4,
    refusalReason: "working tree unchanged despite tool activity 31s ago",
  });
}

Deno.test("buildExtensionTelemetry - derives the surplus over the base budget (Issue #4298)", () => {
  const t = extendedRun();
  assertEquals(t.granted, 4);
  assertEquals(t.baseTimeoutSeconds, 3600);
  assertEquals(t.finalDeadlineSeconds, 5640);
  assertEquals(t.extendedSeconds, 2040);
  assertEquals(t.elapsedSeconds, 5640);
});

Deno.test("buildExtensionTelemetry - a kill before the deadline never reports negative surplus (Issue #4298)", () => {
  const t = buildExtensionTelemetry({
    baseTimeoutSeconds: 3600,
    startMs: 0,
    deadlineMs: 1_800_000,
    nowMs: 900_000,
    granted: 0,
  });
  assertEquals(t.extendedSeconds, 0);
  assertEquals(t.elapsedSeconds, 900);
  assertEquals(t.refusalReason, undefined);
});

Deno.test("buildTimeoutKillMessage - names the extensions, the elapsed time and the stalled signal (Issue #4298)", () => {
  const message = buildTimeoutKillMessage({
    pid: 4242,
    budgetSeconds: 5640,
    extensions: extendedRun(),
  });
  assertStringIncludes(message, "Claude timed out after 5640s");
  assertStringIncludes(message, "base budget 3600s extended 4× by 2040s");
  assertStringIncludes(message, "final deadline 5640s");
  assertStringIncludes(
    message,
    "last extension refused: working tree unchanged despite tool activity 31s ago",
  );
  assertStringIncludes(message, "killing process tree (PID 4242)");
});

Deno.test("buildTimeoutKillMessage - without telemetry the legacy line is byte-identical (Issue #4298)", () => {
  assertEquals(
    buildTimeoutKillMessage({ pid: 99, budgetSeconds: 3600 }),
    "Claude timed out after 3600s — killing process tree (PID 99)",
  );
});

Deno.test("buildTimeoutFailureReason - the issue-facing text carries the extension history (Issue #4298)", () => {
  const reason = buildTimeoutFailureReason(3600, extendedRun());
  assertStringIncludes(reason, "timed out after 5640 seconds (94 minutes)");
  assertStringIncludes(reason, "extended 4× by 2040s");
  assertStringIncludes(reason, "working tree unchanged");
  assert(
    !reason.includes("timed out after 3600 seconds"),
    `the false configured-budget claim must be gone: ${reason}`,
  );
});

Deno.test("buildTimeoutFailureReason - without telemetry the legacy text is byte-identical (Issue #4298)", () => {
  assertEquals(
    buildTimeoutFailureReason(3600),
    "timed out after 3600 seconds (60 minutes)",
  );
});

Deno.test("buildTimeoutFailureReason - a refused first check still names the stall (Issue #4298)", () => {
  const reason = buildTimeoutFailureReason(
    3600,
    buildExtensionTelemetry({
      baseTimeoutSeconds: 3600,
      startMs: 0,
      deadlineMs: 3_600_000,
      nowMs: 3_601_000,
      granted: 0,
      refusalReason: "no tool activity recorded",
    }),
  );
  assertStringIncludes(reason, "base budget 3600s, no extension granted");
  assertStringIncludes(
    reason,
    "last extension refused: no tool activity recorded",
  );
});

// ---------------------------------------------------------------------------
// Diagnostic context round-trip
// ---------------------------------------------------------------------------

Deno.test("buildDiagnosticContext - carries the extension history through to the diagnosis (Issue #4298)", () => {
  const context = buildDiagnosticContext({
    clarityStatus: "assessed_clear",
    elapsedSeconds: 5640,
    claudeNoOutputTimeout: 600,
    claudeTimeout: 3600,
    extensions: extendedRun(),
  });
  assertStringIncludes(context, "extensions_granted=4");
  assertStringIncludes(context, "extended_seconds=2040");
  assertStringIncludes(context, "final_deadline_seconds=5640");

  const rendered = formatZeroOutputDiagnostics(context);
  assertStringIncludes(rendered, "extended 4× by 2040s");
  assertStringIncludes(rendered, "final deadline of 5640s");
  assertStringIncludes(rendered, "working tree unchanged");
});

Deno.test("buildDiagnosticContext - a reason carrying separators cannot corrupt the encoding (Issue #4298)", () => {
  const context = buildDiagnosticContext({
    clarityStatus: "skipped",
    elapsedSeconds: 100,
    claudeNoOutputTimeout: 600,
    claudeTimeout: 3600,
    extensions: buildExtensionTelemetry({
      baseTimeoutSeconds: 3600,
      startMs: 0,
      deadlineMs: 3_600_000,
      nowMs: 100_000,
      granted: 0,
      refusalReason: "probe failed; claude_timeout=1 injected",
    }),
  });
  // Exactly the fields the builder emits — the reason contributes no extras.
  const keys = context.split(";").map((p) => p.split("=")[0]);
  assertEquals(
    keys,
    [
      "health_check",
      "clarity",
      "elapsed_seconds",
      "no_output_timeout",
      "claude_timeout",
      "extensions_granted",
      "extended_seconds",
      "final_deadline_seconds",
      "extension_refused",
    ],
  );
  assertStringIncludes(context, "claude_timeout=3600");
});

Deno.test("buildDiagnosticContext - without telemetry the legacy string is byte-identical (Issue #4298)", () => {
  assertEquals(
    buildDiagnosticContext({
      clarityStatus: "assessed_clear",
      elapsedSeconds: 3600,
      claudeNoOutputTimeout: 600,
      claudeTimeout: 3600,
    }),
    "health_check=passed;clarity=assessed_clear;elapsed_seconds=3600;" +
      "no_output_timeout=600;claude_timeout=3600",
  );
});
