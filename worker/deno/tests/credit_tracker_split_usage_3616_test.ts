/**
 * Tests for split-run usage in the daily credit log (Issue #3616).
 *
 * A split `issue` run's advisor (Opus) and its executor and reviewer
 * sub-agents (Sonnet) share one CLI invocation. The result's top-level `usage`
 * covers only the main session, so the credit log used to record the advisor's
 * tokens alone and the daily spend ceiling never saw the sub-agents' spend.
 * These tests lock in the replacement behaviour: the log records each served
 * model's share in `usageByModel`, the summary prices each share at its own
 * model's rate, and an entry without a readable breakdown is charged whole to
 * its billed model.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { estimateCost, type TokenUsage } from "../lib/token_usage.ts";
import {
  checkDailySpendCeiling,
  getDailySummary,
  LOG_FILE_PREFIX,
  LOG_FILE_SUFFIX,
  logInvocation,
} from "../lib/credit_tracker.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { type AgentStub, withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv } from "./support/env_lookup.ts";
import { fakeClock } from "./support/fake_clock.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const TODAY = new Date().toISOString().slice(0, 10);
const EPS = 1e-9;

/** The advisor's main-session usage: all the top-level `usage` covers. */
const MAIN_OPUS: TokenUsage = {
  inputTokens: 1_000,
  outputTokens: 2_000,
  cacheCreationTokens: 0,
  cacheReadTokens: 10_000,
};

/** The Sonnet sub-agents' usage, which only the `modelUsage` breakdown holds. */
const SONNET_SUB: TokenUsage = {
  inputTokens: 50_000,
  outputTokens: 400_000,
  cacheCreationTokens: 100_000,
  cacheReadTokens: 2_000_000,
};

/** A Sonnet entry that covers output only, leaving the input for a residual. */
const SONNET_OUTPUT_ONLY: TokenUsage = {
  inputTokens: 0,
  outputTokens: 400_000,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

/** The CLI's camelCase `modelUsage` spelling of a usage record. */
function asModelUsage(usage: TokenUsage): Record<string, number> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationTokens,
    cacheReadInputTokens: usage.cacheReadTokens,
  };
}

/** The USD cost of `usage` at `model`'s pricing row, which must exist. */
function costOf(usage: TokenUsage, model: string): number {
  const cost = estimateCost(usage, model);
  assert(cost, `no pricing row for ${model}`);
  return cost.totalCost;
}

/** Sum token usage records counter by counter. */
function sumUsage(...usages: TokenUsage[]): TokenUsage {
  return usages.reduce((total, usage) => ({
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheCreationTokens: total.cacheCreationTokens + usage.cacheCreationTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
  }));
}

/** Path of today's credit log in `logDir`, built as the module builds it. */
function logPathFor(logDir: string): string {
  return `${logDir}/${LOG_FILE_PREFIX}${TODAY}${LOG_FILE_SUFFIX}`;
}

/** Write `entries` as today's credit log, one JSON line each. */
async function seedLog(
  logDir: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  const lines = entries.map((entry) =>
    JSON.stringify({
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo",
      timestamp: new Date().toISOString(),
      ...entry,
    })
  );
  await Deno.writeTextFile(logPathFor(logDir), lines.join("\n") + "\n");
}

/** Run `fn` against a fresh credit log directory, removed afterwards. */
async function withLogDir(
  prefix: string,
  fn: (logDir: string) => Promise<void>,
): Promise<void> {
  const logDir = await Deno.makeTempDir({ prefix });
  try {
    await fn(logDir);
  } finally {
    await Deno.remove(logDir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// credit_tracker - split-run usage
// ---------------------------------------------------------------------------

Deno.test("credit_tracker - split invocation: the ceiling sees the Sonnet sub-agent spend (Issue #3616)", async () => {
  await withLogDir("split_3616_", async (logDir) => {
    await logInvocation({
      logDir,
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo",
      model: OPUS,
      tokenUsage: MAIN_OPUS,
      modelUsage: {
        [OPUS]: asModelUsage(MAIN_OPUS),
        [SONNET]: asModelUsage(SONNET_SUB),
      },
    });

    const summaryResult = await getDailySummary({ logDir });
    assert(summaryResult.ok);
    const summary = summaryResult.value;
    const opusCost = costOf(MAIN_OPUS, OPUS);
    const sonnetCost = costOf(SONNET_SUB, SONNET);

    assertEquals(summary.totalInvocations, 1);
    assertEquals(summary.byModel, { [OPUS]: 1 });
    assertEquals(summary.tokensByModel[SONNET], SONNET_SUB);
    assertEquals(summary.totalTokens, sumUsage(MAIN_OPUS, SONNET_SUB));
    assertAlmostEquals(
      summary.totalEstimatedCost,
      opusCost + sonnetCost,
      EPS,
    );
    const phaseCost = summary.estimatedCostByPhase?.["implementation"];
    assert(phaseCost);
    assertAlmostEquals(phaseCost.totalCost, opusCost + sonnetCost, EPS);

    // A ceiling between the advisor-only cost and the full cost is breached
    // only because the sub-agent spend is counted.
    const ceiling = await checkDailySpendCeiling({
      logDir,
      ceilingUsd: opusCost + sonnetCost / 2,
    });
    assert(ceiling.ok);
    assertEquals(ceiling.value.exceeded, true);
    assertAlmostEquals(ceiling.value.spentUsd, opusCost + sonnetCost, EPS);
  });
});

Deno.test("credit_tracker - residual: usage beyond the breakdown is charged to the billed model (Issue #3616)", async () => {
  await withLogDir("split_3616_residual_", async (logDir) => {
    // The breakdown's Opus entry holds 400 of the 1_000 main-session input
    // tokens and the Sonnet entry carries output only, so the other 600 input
    // tokens are a residual on the billed model.
    await logInvocation({
      logDir,
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo",
      model: OPUS,
      tokenUsage: MAIN_OPUS,
      modelUsage: {
        [OPUS]: { ...asModelUsage(MAIN_OPUS), inputTokens: 400 },
        [SONNET]: asModelUsage(SONNET_OUTPUT_ONLY),
      },
    });

    const summaryResult = await getDailySummary({ logDir });
    assert(summaryResult.ok);
    const summary = summaryResult.value;

    assertEquals(summary.tokensByModel[OPUS], MAIN_OPUS);
    assertEquals(summary.tokensByModel[SONNET], SONNET_OUTPUT_ONLY);
    assertAlmostEquals(
      summary.totalEstimatedCost,
      costOf(MAIN_OPUS, OPUS) + costOf(SONNET_OUTPUT_ONLY, SONNET),
      EPS,
    );
  });
});

Deno.test("credit_tracker - no modelUsage: the entry shape is unchanged (Issue #3616)", async () => {
  await withLogDir("split_3616_plain_", async (logDir) => {
    await logInvocation({
      logDir,
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo",
      model: OPUS,
      tokenUsage: MAIN_OPUS,
    });

    const raw = await Deno.readTextFile(logPathFor(logDir));
    const parsed: Record<string, unknown> = JSON.parse(raw.trim());
    assertEquals(parsed.usageByModel, undefined);
    assertEquals(parsed.inputTokens, MAIN_OPUS.inputTokens);
    assertEquals(parsed.outputTokens, MAIN_OPUS.outputTokens);
    assertEquals(parsed.cacheCreationTokens, MAIN_OPUS.cacheCreationTokens);
    assertEquals(parsed.cacheReadTokens, MAIN_OPUS.cacheReadTokens);

    const summaryResult = await getDailySummary({ logDir });
    assert(summaryResult.ok);
    assertEquals(summaryResult.value.tokensByModel, { [OPUS]: MAIN_OPUS });
  });
});

Deno.test("credit_tracker - an old-shape entry is priced whole at its model (Issue #3616)", async () => {
  await withLogDir("split_3616_old_", async (logDir) => {
    // Written before Issue #3616: no `usageByModel`, counters at the top level.
    await seedLog(logDir, [{
      model: SONNET,
      inputTokens: SONNET_SUB.inputTokens,
      outputTokens: SONNET_SUB.outputTokens,
      cacheCreationTokens: SONNET_SUB.cacheCreationTokens,
      cacheReadTokens: SONNET_SUB.cacheReadTokens,
    }]);

    const summaryResult = await getDailySummary({ logDir });
    assert(summaryResult.ok);
    const summary = summaryResult.value;
    assertEquals(Object.keys(summary.tokensByModel), [SONNET]);
    assertEquals(summary.tokensByModel[SONNET], SONNET_SUB);
    assertAlmostEquals(
      summary.totalEstimatedCost,
      costOf(SONNET_SUB, SONNET),
      EPS,
    );
  });
});

Deno.test("credit_tracker - an unreadable usageByModel falls back to the whole entry (Issue #3616)", async () => {
  await withLogDir("split_3616_bad_", async (logDir) => {
    // The top-level counters hold the invocation's total; one breakdown counter
    // is a string, so the breakdown cannot be read and must not be trusted.
    await seedLog(logDir, [{
      model: OPUS,
      inputTokens: MAIN_OPUS.inputTokens,
      outputTokens: MAIN_OPUS.outputTokens,
      cacheCreationTokens: MAIN_OPUS.cacheCreationTokens,
      cacheReadTokens: MAIN_OPUS.cacheReadTokens,
      usageByModel: {
        [OPUS]: { ...asModelUsage(MAIN_OPUS), outputTokens: "lots" },
      },
    }]);

    const summaryResult = await getDailySummary({ logDir });
    assert(summaryResult.ok);
    const summary = summaryResult.value;
    assertEquals(summary.tokensByModel, { [OPUS]: MAIN_OPUS });
    assert(summary.totalEstimatedCost > 0);
    assertEquals(summary.malformedLogLines, 0);
  });
});

Deno.test("credit_tracker - an unreadable modelUsage passed to logInvocation falls back to the whole entry (Issue #3616)", async () => {
  await withLogDir("split_3616_unreadable_", async (logDir) => {
    await logInvocation({
      logDir,
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo",
      model: OPUS,
      tokenUsage: MAIN_OPUS,
      modelUsage: { [SONNET]: "x" },
    });

    const summaryResult = await getDailySummary({ logDir });
    assert(summaryResult.ok);
    assertEquals(summaryResult.value.tokensByModel, { [OPUS]: MAIN_OPUS });
  });
});

Deno.test("credit_tracker - a usageByModel array is not read as model ids (Issue #3616)", async () => {
  await withLogDir("split_3616_array_", async (logDir) => {
    // Persisted JSON may hold an array; its index keys must not become models.
    await seedLog(logDir, [{
      model: OPUS,
      inputTokens: MAIN_OPUS.inputTokens,
      outputTokens: MAIN_OPUS.outputTokens,
      cacheCreationTokens: MAIN_OPUS.cacheCreationTokens,
      cacheReadTokens: MAIN_OPUS.cacheReadTokens,
      usageByModel: [asModelUsage(MAIN_OPUS)],
    }]);

    const summaryResult = await getDailySummary({ logDir });
    assert(summaryResult.ok);
    assertEquals(summaryResult.value.tokensByModel, { [OPUS]: MAIN_OPUS });
  });
});

Deno.test("credit_tracker - a modelUsage with no tokenUsage writes no token counters (Issue #3616)", async () => {
  await withLogDir("split_3616_no_tokens_", async (logDir) => {
    await logInvocation({
      logDir,
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo",
      model: OPUS,
      modelUsage: { [OPUS]: asModelUsage(MAIN_OPUS) },
    });

    const raw = await Deno.readTextFile(logPathFor(logDir));
    const parsed: Record<string, unknown> = JSON.parse(raw.trim());
    assertEquals(parsed.usageByModel, undefined);
    assertEquals("inputTokens" in parsed, false);
  });
});

// ---------------------------------------------------------------------------
// claude_runner - the credit log records the sub-agent tokens of a split run
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "claude_runner - a split run's sub-agent tokens reach the credit log (Issue #3616)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const logDir = await Deno.makeTempDir({ prefix: "split_3616_runner_" });
    // The result's top-level usage is the main session only; the Sonnet
    // sub-agent's tokens appear only in `modelUsage`.
    const stub = [
      `printf '%s\\n' '{"type":"assistant","message":{"model":"${OPUS}","content":[]}}'`,
      `printf '%s\\n' '{"type":"result","result":"done","usage":{"input_tokens":1000,"output_tokens":500},"modelUsage":{"${OPUS}":{"inputTokens":1000,"outputTokens":500,"cacheCreationInputTokens":0,"cacheReadInputTokens":0},"${SONNET}":{"inputTokens":4000,"outputTokens":9000,"cacheCreationInputTokens":0,"cacheReadInputTokens":0}}}'`,
    ].join("\n");

    try {
      const result = await withAgentStub(
        stub,
        (agent: AgentStub) =>
          runClaudeWithTimeout({
            clock: fakeClock(),
            prompt: "test",
            agentBinaryPath: agent.path,
            env: emptyEnv,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            creditLogDir: logDir,
            workerName: "worker-test",
            repo: "owner/repo",
          }),
        { prefix: "claude_stub_3616_" },
      );
      assert(result.ok, "the stub run must succeed");

      // The credit-log write is fire-and-forget, so poll rather than race it.
      let summary = await getDailySummary({ logDir });
      for (
        let i = 0;
        i < 50 && !(summary.ok && summary.value.totalInvocations > 0);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
        summary = await getDailySummary({ logDir });
      }
      assert(summary.ok);
      if (!summary.ok) return;
      assertEquals(summary.value.tokensByModel[SONNET]?.outputTokens, 9_000);
      assertEquals(summary.value.totalTokens.outputTokens, 9_500);
    } finally {
      await Deno.remove(logDir, { recursive: true }).catch(() => {});
    }
  },
});
