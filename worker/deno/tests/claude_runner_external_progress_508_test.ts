/**
 * Tests for external progress and the wind-down notice in the runner
 * (Issue #508).
 *
 * The contract pinned here, end to end through `runClaudeWithTimeout`:
 *
 * - an agent whose descendant process is doing work keeps its deadline even
 *   though the working tree never changes — the GRQ supervising case;
 * - an agent with tool calls, no tree delta and no live descendant is still
 *   killed, exactly as before;
 * - the external probe is asked for the agent's own pid;
 * - a probe that throws is read as `unknown` and never earns an extension;
 * - a run approaching the hard cap is handed its remaining budget before the
 *   kill, and a notice sink that throws never decides whether the run lives.
 *
 * The agent is a stub script named by path (Issue #959) and both probes are
 * injected, so no test needs a git repository or a real workload, and
 * nothing here touches the process-wide `PATH`. The clock is injected too
 * (PR #1170 follow-up): the stub stops at a gate rather than polling on a
 * `sleep` ladder, and each check happens because the test moved the deadline
 * there — so "the probe was consulted at each check" is an exact count rather
 * than a lower bound that a loaded host can miss.
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
import { fakeClock } from "./support/fake_clock.ts";
import type {
  ExternalProgressState,
  TreeProgressState,
} from "../lib/progress_extension.ts";
import type { RunBudgetNotice } from "../lib/wind_down_notice.ts";
import type { Logger } from "../types.ts";

/** One stream-json line carrying a tool call, so the activity signal moves. */
const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Bash","input":{"command":"ps --ppid 10946"}}]}}`;

/**
 * Write a stub agent and return its path (see the #4296 suite for the
 * rationale). Named by path, never installed on `PATH` (Issue #959).
 */
function installStub(body: string): Promise<AgentStub> {
  return createAgentStub(body, { prefix: "claude_external_508_" });
}

/**
 * A stub that supervises a background job: it reports one tool call and then
 * waits, never touching the checkout — the shape #508 is about.
 *
 * @param finishes - Whether it prints a result and exits once released; a
 *   case that ends in a kill leaves the gate shut for good.
 */
function pollingStub(finishes: boolean): string {
  return `printf '%s\\n' '${TOOL_LINE}'\n` +
    agentStubGate() +
    (finishes ? `printf '%s\\n' '{"type":"result","result":"done"}'\n` : "");
}

/**
 * Rendezvous on the run's own reported state, so an advance is never a guess.
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

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  } as unknown as Logger;
  return { logger, lines };
}

/** A tree probe that always says the checkout has not moved. */
const unchangedTree = (): Promise<TreeProgressState> =>
  Promise.resolve("unchanged");

Deno.test({
  name:
    "runClaudeWithTimeout - a live descendant doing work keeps a supervising agent alive despite an unchanged tree (Issue #508)",
  fn: async () => {
    const stub = await installStub(pollingStub(true));
    const { logger, lines } = recordingLogger();
    const probedPids: number[] = [];
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
          treeProbe: unchangedTree,
          externalProbe: (agentPid: number) => {
            probedPids.push(agentPid);
            return Promise.resolve<ExternalProgressState>("active");
          },
          onExtension: meet.onExtensionSeen,
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
        "an agent supervising a live job must not be killed at the base budget",
      );
      assertEquals(
        probedPids.length,
        2,
        "the external probe must be consulted at each check",
      );
      assert(
        probedPids.every((pid) => pid > 0 && pid === probedPids[0]),
        `the probe must be given the agent's own pid: ${probedPids}`,
      );
      const granted = lines.filter((l) => l.includes("[progress-extension]"));
      assert(
        granted.some((l) => l.includes("descendant")),
        `the grant must name the signal that earned it: ${
          JSON.stringify(granted)
        }`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - tool calls with no tree delta and no live descendant are still killed (Issue #508)",
  fn: async () => {
    const stub = await installStub(pollingStub(false));
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
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: unchangedTree,
          externalProbe: () => Promise.resolve<ExternalProgressState>("idle"),
        },
      });
      await meet.chunk(1);
      // The base budget expires exactly once, and with both signals stalled
      // that single check is the kill — no grant, no second chance.
      await clock.advance(1_000);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true, "a spinning agent still dies");
      assertEquals(result.value.timeoutReason, "hard-timeout");
      assert(
        lines.some((l) =>
          l.includes("not extending") && l.includes("descendant")
        ),
        `the refusal must name both stalled signals: ${JSON.stringify(lines)}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - an external probe that throws is unknown and never earns an extension (Issue #508)",
  fn: async () => {
    const stub = await installStub(pollingStub(false));
    const { logger } = recordingLogger();
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
          treeProbe: unchangedTree,
          externalProbe: () => Promise.reject(new Error("ps exploded")),
        },
      });
      await meet.chunk(1);
      await clock.advance(1_000);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        true,
        "an unmeasurable signal must not become a way to buy time",
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - an agent approaching the hard cap is told its remaining budget before the kill (Issue #508)",
  fn: async () => {
    const stub = await installStub(pollingStub(false));
    const { logger, lines } = recordingLogger();
    const notices: RunBudgetNotice[] = [];
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
            enabled: true,
            grantSeconds: 1,
            activityStallSeconds: 60,
            checkSeconds: 1,
          },
          treeProbe: unchangedTree,
          externalProbe: () => Promise.resolve<ExternalProgressState>("active"),
          ceilingMs: clock.now() + 3_000,
          windDownSeconds: 5,
          onWindDown: (notice) => {
            notices.push(notice);
            // A faulty notice sink must never decide whether the run lives.
            throw new Error("notice sink blew up");
          },
          onExtension: meet.onExtensionSeen,
        },
      });
      await meet.chunk(1);
      // Two grants, each clamped by the ceiling, and then no runway left.
      await clock.advance(1_000);
      await meet.extension(1);
      await clock.advance(1_000);
      await meet.extension(2);
      await clock.advance(1_000);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        true,
        "the cap still stops the run — #508 only makes the stop deliberate",
      );
      assert(
        notices.length >= 1,
        "the agent must be handed its remaining budget before the kill",
      );
      const first = notices[0];
      assert(first, "a notice must have been produced");
      assert(
        first.remainingSeconds > 0 && first.remainingSeconds <= 5,
        `the notice must state the real runway: ${first.remainingSeconds}s`,
      );
      assert(
        lines.some((l) => l.includes("wind-down")),
        `the wind-down must be visible in the log: ${JSON.stringify(lines)}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a run with plenty of runway is never told to wind down (Issue #508)",
  fn: async () => {
    const stub = await installStub(pollingStub(true));
    const { logger } = recordingLogger();
    const notices: RunBudgetNotice[] = [];
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
          treeProbe: unchangedTree,
          externalProbe: () => Promise.resolve<ExternalProgressState>("active"),
          onExtension: meet.onExtensionSeen,
          // An hour of runway. Since Issue #1138 the notice is written over
          // the wider of the wind-down window and what the quality gate needs
          // (~1080s), so "plenty of runway" has to mean plenty for both —
          // the old 600s ceiling is now inside the gate-refusal band and a
          // notice there is correct, not premature.
          ceilingMs: clock.now() + 3_600_000,
          windDownSeconds: 5,
          onWindDown: (notice) => {
            notices.push(notice);
          },
        },
      });
      await meet.chunk(1);
      await clock.advance(1_000);
      await meet.extension(1);
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      // The absence of a notice is only evidence if the agent actually ran
      // (Issue #959): a run that never spawned emits no notice either.
      assert(
        result.value.output.length > 0,
        "the stub must have produced output",
      );
      assertEquals(notices.length, 0, "no premature wind-down");
    } finally {
      await stub.dispose();
    }
  },
});
