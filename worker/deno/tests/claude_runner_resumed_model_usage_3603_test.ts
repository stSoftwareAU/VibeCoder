/**
 * Tests that a resumed CLI session is costed for its own invocation only
 * (follow-up to Issue #3603).
 *
 * The Claude CLI's result `modelUsage` is a running total for the whole
 * session: "a resumed or forked session continues from the totals its
 * transcript saved … so the first result already carries the earlier turns"
 * (the CLI's own SDK schema). Issue runs resume their stream's session, so
 * after #3603 trusted `modelUsage` every issue run was billed for every
 * earlier issue of its stream again, once per invocation. GRQ-AutoTrader run
 * `vibe-mv6rh39l-691c2b` reported 7,271,717 output tokens for 54 turns in
 * 8m 11s (~14,800 tok/s), costed at ~$297, with `claude-sonnet-5` and
 * `claude-haiku-4-5-20251001` sub-bullets no current run serves.
 *
 * The harness mirrors `claude_runner_cache_telemetry_4282_test.ts`: a stub
 * agent, named by path, prints whatever result line the test wrote for it, so
 * the assertions run through the real `runClaudeWithTimeout` parsing path and
 * on into the stats comment and the phase USD the fleet records.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import type { SessionResumeState } from "../lib/session_resume.ts";
import type { RunStats } from "../lib/run_stats.ts";
import { estimatePhaseRunUsd } from "../lib/phase_run_usd.ts";
import {
  attributeUsageByModel,
  estimateRunCost,
  type ModelUsageEntry,
} from "../lib/cost_estimate.ts";
import {
  assessDegradation,
  buildPlanningStatsSection,
} from "../lib/planning_run_stats.ts";
import { type AgentStub, withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const SESSION_ID = "6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";

/** The four counters the CLI reports per model, camelCase as it writes them. */
interface Counters {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

type ModelUsage = Record<string, Counters>;

/**
 * The stream session's totals when this issue run started: earlier issues'
 * advisors and sub-agents, including models no current run serves.
 */
const HISTORY: ModelUsage = {
  [OPUS]: {
    inputTokens: 600_000,
    outputTokens: 900_000,
    cacheCreationInputTokens: 3_200_000,
    cacheReadInputTokens: 52_000_000,
  },
  "claude-sonnet-5": {
    inputTokens: 90_000,
    outputTokens: 3_056_999,
    cacheCreationInputTokens: 2_100_000,
    cacheReadInputTokens: 9_000_000,
  },
  "claude-haiku-4-5-20251001": {
    inputTokens: 40_000,
    outputTokens: 180_000,
    cacheCreationInputTokens: 500_000,
    cacheReadInputTokens: 4_000_000,
  },
  [SONNET]: {
    inputTokens: 30_000,
    outputTokens: 220_000,
    cacheCreationInputTokens: 600_000,
    cacheReadInputTokens: 5_000_000,
  },
};

/** One invocation's own spend: the Opus advisor plus its Sonnet executor. */
const OWN_OPUS: Counters = {
  inputTokens: 1_200,
  outputTokens: 4_000,
  cacheCreationInputTokens: 30_000,
  cacheReadInputTokens: 400_000,
};
const OWN_SONNET: Counters = {
  inputTokens: 800,
  outputTokens: 3_000,
  cacheCreationInputTokens: 20_000,
  cacheReadInputTokens: 250_000,
};

/** The run's invocations: six, as `vibe-mv6rh39l-691c2b` made. */
const INVOCATIONS = 6;

function add(a: Counters | undefined, b: Counters, times = 1): Counters {
  return {
    inputTokens: (a?.inputTokens ?? 0) + b.inputTokens * times,
    outputTokens: (a?.outputTokens ?? 0) + b.outputTokens * times,
    cacheCreationInputTokens: (a?.cacheCreationInputTokens ?? 0) +
      b.cacheCreationInputTokens * times,
    cacheReadInputTokens: (a?.cacheReadInputTokens ?? 0) +
      b.cacheReadInputTokens * times,
  };
}

/** The cumulative `modelUsage` the CLI reports after `n` of this run's calls. */
function cumulativeAfter(n: number): ModelUsage {
  return {
    ...HISTORY,
    [OPUS]: add(HISTORY[OPUS], OWN_OPUS, n),
    [SONNET]: add(HISTORY[SONNET], OWN_SONNET, n),
  };
}

/** A CLI result line: per-invocation main-loop `usage`, cumulative `modelUsage`. */
function resultLine(modelUsage: ModelUsage, main: Counters): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: "done",
    num_turns: 9,
    duration_ms: 81_000,
    usage: {
      input_tokens: main.inputTokens,
      output_tokens: main.outputTokens,
      cache_creation_input_tokens: main.cacheCreationInputTokens,
      cache_read_input_tokens: main.cacheReadInputTokens,
    },
    modelUsage,
    session_id: SESSION_ID,
  });
}

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

/** Run `fn` with a stub that prints the result line in `<stub>.result`. */
function withResultStub<T>(fn: (stub: AgentStub) => Promise<T>): Promise<T> {
  // An assistant line per model, so the served list names both, as a split
  // run's stream does.
  const assistant = (model: string) =>
    JSON.stringify({ type: "assistant", message: { model, content: [] } });
  const body = [
    `printf '%s\\n' '${assistant(OPUS)}'`,
    `printf '%s\\n' '${assistant(SONNET)}'`,
    'cat "$0.result"',
    "exit 0",
  ].join("\n");
  return withAgentStub(body, fn, { prefix: "claude_model_usage_stub_" });
}

/** One invocation through the real runner, returning its run stats. */
async function invoke(
  stub: AgentStub,
  workDir: string,
  line: string,
  session: SessionResumeState | undefined,
): Promise<RunStats> {
  await Deno.writeTextFile(`${stub.path}.result`, `${line}\n`);
  const result = await runClaudeWithTimeout({
    clock: fakeClock(),
    prompt: "test",
    agentBinaryPath: stub.path,
    model: OPUS,
    repo: "owner/repo",
    phase: "issue",
    timeoutSeconds: 30,
    killAfterSeconds: 2,
    workDir,
    ...(session ? { sessionResumeState: session } : {}),
    logger: quietLogger,
  });
  assert(result.ok, "the stub run must succeed");
  const stats = result.value.runStats;
  assert(stats, "the runner must report run stats");
  return stats;
}

/** Sum a list of attributed entries' counters. */
function totals(entries: ModelUsageEntry[]) {
  const sum = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const { usage } of entries) {
    sum.input += usage.inputTokens;
    sum.output += usage.outputTokens;
    sum.cacheWrite += usage.cacheCreationTokens;
    sum.cacheRead += usage.cacheReadTokens;
  }
  return sum;
}

function attributed(stats: RunStats[]): ModelUsageEntry[] {
  return stats.flatMap((s) =>
    attributeUsageByModel(s.tokenUsage!, s.modelUsage, s.servedModels[0]!)
  );
}

function statsSection(stats: RunStats[]): string {
  const invocations = stats.map((runStats) => ({ phase: "issue", runStats }));
  return buildPlanningStatsSection({
    invocations,
    expectedModel: OPUS,
    verdict: assessDegradation(invocations, OPUS, "issue"),
    phase: "issue",
  });
}

Deno.test({
  name:
    "runner - a resumed session is costed for this run's invocations only, not the stream's history",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "model_usage_scope_" });
    try {
      await withResultStub(async (stub) => {
        // The previous issue on the stream: its last invocation leaves the
        // session's totals at HISTORY.
        await invoke(stub, workDir, resultLine(HISTORY, OWN_OPUS), {
          sessionId: SESSION_ID,
          phaseCount: 0,
        });

        // This issue run resumes the stream's session six times; every
        // result carries the whole session's totals so far.
        const run: RunStats[] = [];
        for (let n = 1; n <= INVOCATIONS; n++) {
          run.push(
            await invoke(
              stub,
              workDir,
              resultLine(cumulativeAfter(n), OWN_OPUS),
              {
                sessionId: SESSION_ID,
                phaseCount: n,
              },
            ),
          );
        }

        // Each invocation's breakdown is its own spend, history gone.
        for (const stats of run) {
          assertEquals(Object.keys(stats.modelUsage ?? {}).sort(), [
            OPUS,
            SONNET,
          ]);
        }

        // The run's tokens are exactly its six invocations' own.
        const sum = totals(attributed(run));
        assertEquals(sum.output, INVOCATIONS * (4_000 + 3_000));
        assertEquals(sum.input, INVOCATIONS * (1_200 + 800));
        assertEquals(sum.cacheWrite, INVOCATIONS * (30_000 + 20_000));
        assertEquals(sum.cacheRead, INVOCATIONS * (400_000 + 250_000));

        // The USD the fleet records is the same six invocations, priced.
        const expected = estimateRunCost([
          {
            model: OPUS,
            usage: toUsage(add(undefined, OWN_OPUS, INVOCATIONS)),
          },
          {
            model: SONNET,
            usage: toUsage(add(undefined, OWN_SONNET, INVOCATIONS)),
          },
        ]).totalCost;
        const usd = estimatePhaseRunUsd(run, OPUS);
        assert(
          Math.abs(usd - expected) < 1e-9,
          `expected ~$${expected}, got $${usd}`,
        );

        // The stats comment names no model this run did not serve.
        const section = statsSection(run);
        assert(!section.includes("`claude-sonnet-5`"), section);
        assert(!section.includes("claude-haiku-4-5-20251001"), section);
        assertStringIncludes(section, "output 42,000");
      });
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "runner - a resumed session with no recorded baseline is flagged not costed, never billed its history",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "model_usage_scope_" });
    try {
      await withResultStub(async (stub) => {
        // Resumed from a session this worker never recorded totals for (a
        // stream opened before the baseline existed).
        const stats = await invoke(
          stub,
          workDir,
          resultLine(cumulativeAfter(1), OWN_OPUS),
          { sessionId: SESSION_ID, phaseCount: 3 },
        );

        // The cumulative breakdown is not passed on as this run's.
        assertEquals(stats.modelUsage, undefined);
        const sum = totals(attributed([stats]));
        assertEquals(sum.output, OWN_OPUS.outputTokens);

        // And the comment says the sub-agents went uncosted, not $0.
        assertStringIncludes(statsSection([stats]), "sub-agents: not costed");
      });
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "runner - a session whose totals fell below the recorded baseline is flagged not costed",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "model_usage_scope_" });
    try {
      await withResultStub(async (stub) => {
        await invoke(stub, workDir, resultLine(cumulativeAfter(2), OWN_OPUS), {
          sessionId: SESSION_ID,
          phaseCount: 0,
        });
        // A `/clear` (or any reset) restarts the running totals, so the
        // difference against the baseline means nothing.
        const stats = await invoke(
          stub,
          workDir,
          resultLine({ [OPUS]: OWN_OPUS, [SONNET]: OWN_SONNET }, OWN_OPUS),
          { sessionId: SESSION_ID, phaseCount: 1 },
        );
        assertEquals(stats.modelUsage, undefined);
        assertStringIncludes(statsSection([stats]), "sub-agents: not costed");
      });
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "runner - a fresh split session still costs its sub-agents from modelUsage (Issue #3603)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "model_usage_scope_" });
    try {
      await withResultStub(async (stub) => {
        const own = { [OPUS]: OWN_OPUS, [SONNET]: OWN_SONNET };
        // Both with a new session and with no session continuity at all.
        for (
          const session of [{ sessionId: SESSION_ID, phaseCount: 0 }, undefined]
        ) {
          const stats = await invoke(
            stub,
            workDir,
            resultLine(own, OWN_OPUS),
            session,
          );
          assertEquals(Object.keys(stats.modelUsage ?? {}).sort(), [
            OPUS,
            SONNET,
          ]);
          const entries = attributed([stats]);
          const sonnet = entries.find((e) => e.model === SONNET);
          assertEquals(sonnet?.usage.outputTokens, OWN_SONNET.outputTokens);
          assert(estimatePhaseRunUsd([stats], OPUS) > 0);
          assert(!statsSection([stats]).includes("not costed"));
        }
      });
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
});

function toUsage(c: Counters) {
  return {
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheCreationTokens: c.cacheCreationInputTokens,
    cacheReadTokens: c.cacheReadInputTokens,
  };
}
