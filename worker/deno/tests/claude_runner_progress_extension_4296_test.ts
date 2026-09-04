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
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { type AgentStub, createAgentStub } from "./support/agent_stub.ts";
import type { TreeProgressState } from "../lib/progress_extension.ts";
import type { Logger } from "../types.ts";

/** One stream-json line carrying a tool call, so the activity signal moves. */
const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Edit","input":{"file_path":"worker/deno/lib/x.ts"}}]}}`;

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

/** A stub that emits a tool call every `gapSeconds` for `count` iterations. */
function chattyStub(count: number, gapSeconds: string): string {
  return `for i in $(seq 1 ${count}); do\n` +
    `  printf '%s\\n' '${TOOL_LINE}'\n` +
    `  sleep ${gapSeconds}\n` +
    `done\n` +
    `printf '%s\\n' '{"type":"result","result":"done"}'\n`;
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

/** A probe that counts its calls and replays a scripted verdict sequence. */
function scriptedProbe(verdicts: TreeProgressState[]) {
  const calls: number[] = [];
  return {
    calls,
    probe: (): Promise<TreeProgressState> => {
      const verdict = verdicts[calls.length] ?? verdicts.at(-1) ?? "unknown";
      calls.push(Date.now());
      return Promise.resolve(verdict);
    },
  };
}

Deno.test({
  name:
    "runClaudeWithTimeout - a progressing run has its deadline extended repeatedly and is not killed (Issue #4296)",
  fn: async () => {
    // ~3 s of steady tool calls against a 1 s budget: without extensions this
    // run would be killed at 1 s.
    const stub = await installStub(chattyStub(30, "0.1"));
    const { logger, lines } = recordingLogger();
    const { calls, probe } = scriptedProbe(["advanced"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 1,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
        },
      });

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a progressing run must not be killed",
      );
      assert(
        calls.length >= 2,
        `the deadline must be re-armed and re-checked (probe calls: ${calls.length})`,
      );
      const extensions = lines.filter((l) =>
        l.includes("[progress-extension]")
      );
      assert(
        extensions.length >= 2,
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
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger } = recordingLogger();
    // Two grants, then the tree stops moving — the third check must kill.
    const { calls, probe } = scriptedProbe([
      "advanced",
      "advanced",
      "unchanged",
    ]);
    try {
      const started = Date.now();
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 1,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
        },
      });
      const elapsedSeconds = (Date.now() - started) / 1000;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(result.value.timeoutReason, "hard-timeout");
      assertEquals(
        calls.length,
        3,
        "the stall must be caught on the 3rd check",
      );
      assert(
        elapsedSeconds < 3 + 3,
        `the kill must land within one grant of the stall (took ${elapsedSeconds}s)`,
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
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger } = recordingLogger();
    const { calls, probe } = scriptedProbe(["unknown"]);
    try {
      const started = Date.now();
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 5,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
        },
      });
      const elapsedSeconds = (Date.now() - started) / 1000;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(result.value.timeoutReason, "hard-timeout");
      assertEquals(calls.length, 1, "a broken probe is asked exactly once");
      assert(
        elapsedSeconds < 4,
        `an unverifiable run dies on schedule (took ${elapsedSeconds}s)`,
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
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger, lines } = recordingLogger();
    const { calls, probe } = scriptedProbe(["advanced"]);
    // The probe is built but never handed to the runner: non-execute callers
    // (PR feedback, CI fix, planning, grill-me, health checks) pass no option
    // and must keep their unconditional timeouts.
    void probe;
    try {
      const started = Date.now();
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
      });
      const elapsedSeconds = (Date.now() - started) / 1000;

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
      assert(
        elapsedSeconds < 4,
        `the kill must land at the configured budget (took ${elapsedSeconds}s)`,
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
    // Chunks keep arriving after the original 1 s budget has passed. If the
    // #4254 backstop still compared against `timeoutMs`, the first of those
    // chunks would kill a run the policy had just extended.
    const stub = await installStub(chattyStub(20, "0.15"));
    const { logger } = recordingLogger();
    const { calls, probe } = scriptedProbe(["advanced"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 10,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
        },
      });

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a chunk after the original budget must not kill an extended run",
      );
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
    // Talks for ~1.4 s — long enough to earn a grant — then goes silent.
    const stub = await installStub(
      `for i in $(seq 1 14); do\n` +
        `  printf '%s\\n' '${TOOL_LINE}'\n` +
        `  sleep 0.1\n` +
        `done\n` +
        `sleep 60\n`,
    );
    const { logger, lines } = recordingLogger();
    const { probe } = scriptedProbe(["advanced"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        noOutputTimeout: 2,
        logger,
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 30,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
        },
      });

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
    const stub = await installStub(chattyStub(30, "0.1"));
    const { logger } = recordingLogger();
    const { probe } = scriptedProbe(["advanced"]);
    const reported: { deadlineMs: number; extensionsGranted: number }[] = [];
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: probe,
          onExtension: (state) => {
            reported.push(state);
            // A faulty consumer must not decide whether the run lives.
            throw new Error("reporter blew up");
          },
        },
      });

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a throwing reporter must not kill a progressing run",
      );
      assert(
        reported.length >= 2,
        `every grant must be reported, got ${reported.length}`,
      );
      assertEquals(
        reported.map((r) => r.extensionsGranted),
        reported.map((_, i) => i + 1),
        "the extension count must increase by one per grant",
      );
      for (let i = 1; i < reported.length; i++) {
        assert(
          reported[i]!.deadlineMs > reported[i - 1]!.deadlineMs,
          "each report must carry a later deadline",
        );
      }
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
    // A run that keeps progressing against a ceiling 2.5 s out: the early
    // grants are full, the last is clamped to the runway that is left, and
    // the check after it refuses so the worker's own kill lands before the
    // supervisor's `timeout` would.
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger, lines } = recordingLogger();
    const { probe } = scriptedProbe(["advanced"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: probe,
          ceilingMs: Date.now() + 2500,
        },
      });

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
    const stub = await installStub(chattyStub(30, "0.1"));
    const { logger, lines } = recordingLogger();
    const { probe } = scriptedProbe(["advanced"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: probe,
        },
      });

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
      `printf '%s\\n' '${TOOL_LINE}'\n` +
        `for i in $(seq 1 40); do\n` +
        `  printf '%s\\n' '{"type":"assistant","message":` +
        `{"content":[{"type":"text","text":"still waiting"}]}}'\n` +
        `  sleep 0.1\n` +
        `done\n` +
        `printf '%s\\n' '{"type":"result","result":"done"}'\n`,
    );
    const { logger, lines } = recordingLogger();
    const { calls, probe } = scriptedProbe(["advanced"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 2,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 1 },
          treeProbe: probe,
        },
      });

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "an agent still streaming inside a long tool call must not be killed",
      );
      assert(calls.length >= 1, "the deadline must have been evaluated");
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
