/**
 * Tests for the re-armable hard deadline (Issue #4296, part of #4290).
 *
 * The hard-timeout watchdog used to be a one-shot kill at `timeoutSeconds`.
 * With the opt-in `progressExtension` option it becomes a deadline that is
 * re-armed while both progress signals hold — recent tool activity in the
 * stream-json (#4293) and a working tree that actually advanced (#4294).
 *
 * The contract these tests pin:
 *
 * - a progressing run has its deadline extended repeatedly and is not killed;
 * - a run that stalls after extensions is killed within one grant increment,
 *   with `timeoutReason: "hard-timeout"`;
 * - an `unknown` probe verdict kills on schedule — no fail-open;
 * - **without** the option the behaviour is bit-for-bit unchanged: one kill
 *   at `timeoutSeconds`, zero probe calls (the guard for PR-feedback, CI-fix,
 *   planning, grill-me and health-check timeouts);
 * - the #4254 wall-clock backstop compares against the *current* deadline, so
 *   a chunk arriving after the original budget does not kill an extended run;
 * - the #1825 silence watchdog is untouched — a silent run still dies at
 *   `noOutputTimeout` no matter how many extensions were granted;
 * - with a `ceilingMs` (Issue #421, the supervisor's wall-clock cap less the
 *   shutdown reserve) the last grant is clamped to the runway left and the
 *   next check refuses, while no ceiling keeps the sequence unbounded.
 *
 * The agent is a stub script named by path (Issue #959); the tree probe is
 * injected, so no test needs a git repository and nothing here touches the
 * process-wide `PATH`.
 *
 * **The clock is injected too** (PR #1170 follow-up). This file used to be the
 * most expensive in the whole serial pass — 27 s, all of it asleep against
 * real one- and two-second deadlines — and two of its cases were among the
 * four that went red in #1170's own loaded run, because a watchdog woken late
 * by a busy host reads exactly like a watchdog that did not fire. Now the test
 * owns the clock: the stub stops at a gate rather than sleeping, the test
 * advances the deadline to the instant it wants, and the decision is the same
 * on an idle laptop and under nine competing workers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  type AgentStub,
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
} from "./support/agent_stub.ts";
import { type FakeClock, fakeClock } from "./support/fake_clock.ts";
import type { TreeProgressState } from "../lib/progress_extension.ts";
import type { Logger } from "../types.ts";

/** One stream-json line carrying a tool call, so the activity signal moves. */
const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Edit","input":{"file_path":"worker/deno/lib/x.ts"}}]}}`;

/** A stream-json line with no tool call — output, but not a new tool. */
const TEXT_LINE = `{"type":"assistant","message":{"content":` +
  `[{"type":"text","text":"still waiting"}]}}`;

/** The final line, after which the stub exits 0. */
const RESULT_LINE = `{"type":"result","result":"done"}`;

/** Bash that writes one stream-json line. */
function emit(line: string): string {
  return `printf '%s\\n' '${line}'\n`;
}

/**
 * Write a stub agent and return its path.
 *
 * Named by path rather than installed on the process-wide `PATH`
 * (Issue #959), so the file no longer races the rest of the suite.
 *
 * The stub runs in the `deno test` process group — deliberately, so the
 * watchdog signals its PID and descendants and never a process GROUP
 * (Issue #471; see the note in {@link file://../../../CODING-STANDARDS.md}).
 * `terminateProcessTree` already refuses a group signal for a target sharing
 * our group, and `terminateDescendants` still reaps the stub's children, so
 * the kill under test is exercised end to end without a signal that can
 * escape the tree.
 *
 * @param body - Bash body of the stub, after the shebang.
 */
function installStub(body: string): Promise<AgentStub> {
  return createAgentStub(body, { prefix: "claude_progress_ext_" });
}

/**
 * A stub that emits one tool call and then waits to be released.
 *
 * The replacement for the old `chattyStub`, which emitted on a `sleep` ladder
 * and so decided for itself when the agent was busy. Here the test decides:
 * the activity signal is set by the first line, and nothing else happens
 * until the test says so.
 */
function toolThenWait(): string {
  return emit(TOOL_LINE) + agentStubGate();
}

/** The same, but finishing cleanly once released. */
function toolThenFinish(): string {
  return toolThenWait() + emit(RESULT_LINE);
}

/** Collect log lines so the mandated extension line can be asserted on. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  } as unknown as Logger;
  return { logger, lines };
}

/**
 * A probe that replays a scripted verdict sequence and records **when** each
 * call landed, as milliseconds since the clock was created.
 *
 * The offset is the point: on the injected clock "the third check came one
 * grant after the second" is an exact number the test can assert, where the
 * old suite could only bound a real elapsed reading and hope.
 */
function scriptedProbe(verdicts: TreeProgressState[], clock: FakeClock) {
  const startedMs = clock.now();
  const calls: number[] = [];
  return {
    calls,
    probe: (): Promise<TreeProgressState> => {
      const verdict = verdicts[calls.length] ?? verdicts.at(-1) ?? "unknown";
      calls.push(clock.now() - startedMs);
      return Promise.resolve(verdict);
    },
  };
}

/**
 * Rendezvous points on the run, so an advance is never a guess.
 *
 * `chunk(n)` resolves when the nth stdout chunk has been folded into the
 * progress tracker; `extension(n)` when the nth grant has been decided. Both
 * are handed to the runner as its ordinary observer options, so the test
 * waits on the run's own reported state rather than on a duration.
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
    /** The nth stdout chunk (1-based) has reached the tracker. */
    chunk: (n: number) => at(chunks, n - 1).promise,
    /** The nth grant (1-based) has been decided and the watchdog re-armed. */
    extension: (n: number) => at(extensions, n - 1).promise,
  };
}

Deno.test({
  name:
    "runClaudeWithTimeout - a progressing run has its deadline extended repeatedly and is not killed (Issue #4296)",
  fn: async () => {
    const stub = await installStub(toolThenFinish());
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const { calls, probe } = scriptedProbe(["advanced"], clock);
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
            enabled: true,
            grantSeconds: 1,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
          onExtension: meet.onExtensionSeen,
        },
      });

      // The agent is up and has reported a tool call.
      await meet.chunk(1);
      // Two whole budgets pass; the tree says the work is advancing, so both
      // deadlines are re-armed rather than fired.
      await clock.advance(1_000);
      await meet.extension(1);
      await clock.advance(1_000);
      await meet.extension(2);
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a progressing run must not be killed",
      );
      assertEquals(
        result.value.exitCode,
        0,
        "the agent must have run and finished on its own",
      );
      assertEquals(
        calls.length,
        2,
        "the deadline must be re-armed and re-checked",
      );
      const extensions = lines.filter((l) =>
        l.includes("[progress-extension]")
      );
      assertEquals(
        extensions.length,
        2,
        `each grant must log one line, got: ${JSON.stringify(extensions)}`,
      );
      const first = extensions[0] ?? "";
      assert(first.includes("advanced"), `the reason must be named: ${first}`);
      assert(first.includes("elapsed"), `elapsed must be named: ${first}`);
      assert(
        first.includes("extension 1"),
        `the extension count must be named: ${first}`,
      );
      assert(
        first.includes("new deadline"),
        `the new deadline must be named: ${first}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a run that stalls after two extensions is killed within one grant increment (Issue #4296)",
  fn: async () => {
    // Never released: the agent sits at the gate for the whole run, so the
    // third check finds a tree that has stopped moving and kills it.
    const stub = await installStub(toolThenWait());
    const { logger } = recordingLogger();
    const clock = fakeClock();
    // Two grants, then the tree stops moving — the third check must kill.
    const { calls, probe } = scriptedProbe(
      ["advanced", "advanced", "unchanged"],
      clock,
    );
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
            enabled: true,
            grantSeconds: 1,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
          onExtension: meet.onExtensionSeen,
        },
      });

      await meet.chunk(1);
      await clock.advance(1_000);
      await meet.extension(1);
      await clock.advance(1_000);
      await meet.extension(2);
      // One increment past the second grant: the tree has not moved, so this
      // check is the kill.
      await clock.advance(1_000);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(result.value.timeoutReason, "hard-timeout");
      assertEquals(
        calls.length,
        3,
        "the stall must be caught on the 3rd check",
      );
      assertEquals(
        calls[2]! - calls[1]!,
        1_000,
        "the kill lands one grant increment after the stall began",
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - an unknown probe verdict kills on schedule, never extends (Issue #4296)",
  fn: async () => {
    const stub = await installStub(toolThenWait());
    const { logger } = recordingLogger();
    const clock = fakeClock();
    const { calls, probe } = scriptedProbe(["unknown"], clock);
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
            enabled: true,
            grantSeconds: 5,
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
      assertEquals(result.value.timeoutReason, "hard-timeout");
      assertEquals(calls.length, 1, "a broken probe is asked exactly once");
      assertEquals(
        calls[0],
        1_000,
        "the unverifiable run dies at its own deadline, not a grant later",
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - without the option there is exactly one kill at timeoutSeconds and zero probe calls (Issue #4296)",
  fn: async () => {
    const stub = await installStub(toolThenWait());
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const { calls, probe } = scriptedProbe(["advanced"], clock);
    // The probe is built but never handed to the runner: non-execute callers
    // (PR feedback, CI fix, planning, grill-me, health checks) pass no option
    // and must keep their unconditional timeouts.
    void probe;
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
      // The budget expires exactly once, and that is the kill.
      await clock.advance(1_000);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(result.value.timeoutReason, "hard-timeout");
      assertEquals(calls.length, 0, "no probe may run without the option");
      assertEquals(
        lines.filter((l) => l.includes("[progress-extension]")).length,
        0,
        "no extension may be logged without the option",
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - the wall-clock backstop follows the extended deadline (Issues #4254, #4296)",
  fn: async () => {
    // A chunk arrives after the original 1 s budget has passed. If the #4254
    // backstop still compared against `timeoutMs`, that chunk would kill a run
    // the policy had just extended.
    const stub = await installStub(
      emit(TOOL_LINE) + agentStubGate() + emit(TEXT_LINE) + emit(RESULT_LINE),
    );
    const { logger } = recordingLogger();
    const clock = fakeClock();
    const { calls, probe } = scriptedProbe(["advanced"], clock);
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
            enabled: true,
            grantSeconds: 10,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
          onExtension: meet.onExtensionSeen,
        },
      });

      await meet.chunk(1);
      await clock.advance(1_000);
      await meet.extension(1);
      // Now past the original budget and well inside the granted one.
      await clock.advance(200);
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a chunk after the original budget must not kill an extended run",
      );
      assertEquals(result.value.exitCode, 0);
      assertEquals(calls.length, 1, "one grant covers the rest of the run");
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - the silence watchdog still kills an extended run (Issues #1825, #4296)",
  fn: async () => {
    // Talks once — long enough to earn a grant — then goes silent for good.
    const stub = await installStub(toolThenWait());
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const { probe } = scriptedProbe(["advanced"], clock);
    const meet = rendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        noOutputTimeout: 2,
        logger,
        onActivity: meet.onActivity,
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 30,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
          onExtension: meet.onExtensionSeen,
        },
      });

      await meet.chunk(1);
      // The hard deadline expires and is extended by thirty seconds.
      await clock.advance(1_000);
      await meet.extension(1);
      // Two seconds of silence from the last chunk: the #1825 watchdog fires
      // although the hard deadline is now twenty-nine seconds away.
      await clock.advance(1_000);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(
        result.value.timeoutReason,
        "no-output",
        "silence kills regardless of how far the hard deadline was extended",
      );
      assert(
        lines.some((l) => l.includes("[progress-extension]")),
        "the run must actually have been extended before it fell silent",
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - every grant is reported to the deadline reporter, and a reporter that throws does not kill the run (Issue #4297)",
  fn: async () => {
    // The drain path (#4182) only sees an extended run as in-flight if the
    // runner surfaces each grant; this pins that contract end to end.
    const stub = await installStub(toolThenFinish());
    const { logger } = recordingLogger();
    const clock = fakeClock();
    const { probe } = scriptedProbe(["advanced"], clock);
    const meet = rendezvous();
    const reported: { deadlineMs: number; extensionsGranted: number }[] = [];
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
          onExtension: (state) => {
            reported.push(state);
            meet.onExtensionSeen();
            // A faulty consumer must not decide whether the run lives.
            throw new Error("reporter blew up");
          },
        },
      });

      await meet.chunk(1);
      await clock.advance(1_000);
      await meet.extension(1);
      await clock.advance(1_000);
      await meet.extension(2);
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a throwing reporter must not kill a progressing run",
      );
      assertEquals(
        reported.length,
        2,
        `every grant must be reported, got ${reported.length}`,
      );
      assertEquals(
        reported.map((r) => r.extensionsGranted),
        [1, 2],
        "the extension count must increase by one per grant",
      );
      assert(
        reported[1]!.deadlineMs > reported[0]!.deadlineMs,
        "each report must carry a later deadline",
      );
    } finally {
      await stub.dispose();
    }
  },
});

// ===========================================================================
// Issue #421 — the ceiling the supervisor's wall-clock cap implies
// ===========================================================================

Deno.test({
  name:
    "runClaudeWithTimeout - grants are clamped to the run hard cap and then refused (Issue #421)",
  fn: async () => {
    // A run that keeps progressing against a ceiling 2.5 s out: the first
    // grant is full, the second is clamped to the runway that is left, and
    // the check after it refuses so the worker's own kill lands before the
    // supervisor's `timeout` would.
    const stub = await installStub(toolThenWait());
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const { probe } = scriptedProbe(["advanced"], clock);
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
          ceilingMs: clock.now() + 2_500,
          onExtension: meet.onExtensionSeen,
        },
      });

      await meet.chunk(1);
      // +1000: a full grant to 2000, still short of the 2500 ceiling.
      await clock.advance(1_000);
      await meet.extension(1);
      // +1000: the full grant would reach 3000, so it is clamped to 2500.
      await clock.advance(1_000);
      await meet.extension(2);
      // +500: at the ceiling there is no runway left, so the run is released.
      await clock.advance(500);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        true,
        "the run must be killed at the ceiling rather than extended past it",
      );
      const extensionLines = lines.filter((l) =>
        l.includes("[progress-extension]")
      );
      assert(
        extensionLines.some((l) => l.includes("clamped to the run hard cap")),
        `a clamped grant must be logged: ${JSON.stringify(extensionLines)}`,
      );
      assert(
        extensionLines.some((l) =>
          l.includes("not extending") && l.includes("run hard cap reached")
        ),
        `the refusal must name the cap: ${JSON.stringify(extensionLines)}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - no ceiling leaves the extension sequence unbounded (Issue #421)",
  fn: async () => {
    // The same run without a ceiling: extensions keep coming and the agent
    // finishes on its own, exactly as it did before the cap was published.
    const stub = await installStub(toolThenFinish());
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const { probe } = scriptedProbe(["advanced"], clock);
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
      await meet.extension(3);
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, false);
      // Finishing on its own is the claim; without this a run that never
      // spawned would satisfy every assertion here (Issue #959).
      assertEquals(result.value.exitCode, 0);
      assert(
        !lines.some((l) => l.includes("hard cap")),
        `an uncapped run must never mention a cap: ${JSON.stringify(lines)}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - an agent streaming inside one long tool call is extended, not killed (Issue #767)",
  fn: async () => {
    // The #732 shape: one tool call at the start, then nothing but stream
    // chunks while the agent waits on a long-running tool. With a 1 s stall
    // window the tool clock goes stale within the first budget, so before
    // #767 this run was killed at its deadline with "tool activity stale".
    const stub = await installStub(
      emit(TOOL_LINE) +
        agentStubGate("stream") +
        emit(TEXT_LINE) +
        agentStubGate("finish") +
        emit(RESULT_LINE),
    );
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const { calls, probe } = scriptedProbe(["advanced"], clock);
    const meet = rendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 2,
        killAfterSeconds: 1,
        logger,
        onActivity: meet.onActivity,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 1 },
          treeProbe: probe,
          onExtension: meet.onExtensionSeen,
        },
      });

      await meet.chunk(1);
      // 1.8 s later the tool clock is stale — but the agent is still talking.
      await clock.advance(1_800);
      await releaseAgentStub(stub, "stream");
      await meet.chunk(2);
      // The 2 s deadline lands with the tool clock 2 s old and the stream
      // clock 0.2 s old, which is what must keep the run alive.
      await clock.advance(200);
      await meet.extension(1);
      await releaseAgentStub(stub, "finish");
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "an agent still streaming inside a long tool call must not be killed",
      );
      assertEquals(result.value.exitCode, 0);
      assertEquals(calls.length, 1, "the deadline must have been evaluated");
      const extensions = lines.filter((l) =>
        l.includes("[progress-extension]")
      );
      assert(
        extensions.some((l) => l.includes("agent output")),
        `the grant must name the stream clock: ${JSON.stringify(extensions)}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});
