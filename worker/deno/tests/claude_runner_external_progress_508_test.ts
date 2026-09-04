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
 * nothing here touches the process-wide `PATH`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { type AgentStub, createAgentStub } from "./support/agent_stub.ts";
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
 * A stub that polls a background job: it emits a tool call every
 * `gapSeconds` and never touches the checkout — the shape #508 is about.
 */
function pollingStub(count: number, gapSeconds: string): string {
  return `for i in $(seq 1 ${count}); do\n` +
    `  printf '%s\\n' '${TOOL_LINE}'\n` +
    `  sleep ${gapSeconds}\n` +
    `done\n` +
    `printf '%s\\n' '{"type":"result","result":"done"}'\n`;
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
    const stub = await installStub(pollingStub(30, "0.1"));
    const { logger, lines } = recordingLogger();
    const probedPids: number[] = [];
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: unchangedTree,
          externalProbe: (agentPid: number) => {
            probedPids.push(agentPid);
            return Promise.resolve<ExternalProgressState>("active");
          },
        },
      });

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "an agent supervising a live job must not be killed at the base budget",
      );
      assert(
        probedPids.length >= 2,
        `the external probe must be consulted at each check: ${probedPids.length}`,
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
    const stub = await installStub(pollingStub(120, "0.1"));
    const { logger, lines } = recordingLogger();
    try {
      const started = Date.now();
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: unchangedTree,
          externalProbe: () => Promise.resolve<ExternalProgressState>("idle"),
        },
      });
      const elapsedSeconds = (Date.now() - started) / 1000;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true, "a spinning agent still dies");
      assertEquals(result.value.timeoutReason, "hard-timeout");
      assert(
        elapsedSeconds < 4,
        `the kill must land on schedule (took ${elapsedSeconds}s)`,
      );
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
    const stub = await installStub(pollingStub(120, "0.1"));
    const { logger } = recordingLogger();
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: unchangedTree,
          externalProbe: () => Promise.reject(new Error("ps exploded")),
        },
      });

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
    const stub = await installStub(pollingStub(120, "0.1"));
    const { logger, lines } = recordingLogger();
    const notices: RunBudgetNotice[] = [];
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
            checkSeconds: 1,
          },
          treeProbe: unchangedTree,
          externalProbe: () => Promise.resolve<ExternalProgressState>("active"),
          ceilingMs: Date.now() + 3_000,
          windDownSeconds: 5,
          onWindDown: (notice) => {
            notices.push(notice);
            // A faulty notice sink must never decide whether the run lives.
            throw new Error("notice sink blew up");
          },
        },
      });

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
    const stub = await installStub(pollingStub(20, "0.1"));
    const { logger } = recordingLogger();
    const notices: RunBudgetNotice[] = [];
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: unchangedTree,
          externalProbe: () => Promise.resolve<ExternalProgressState>("active"),
          ceilingMs: Date.now() + 600_000,
          windDownSeconds: 5,
          onWindDown: (notice) => {
            notices.push(notice);
          },
        },
      });

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
