/**
 * Tests for unpriced-model spend accounting (Issue #3870).
 *
 * The daily spend total used to omit every invocation whose model id was
 * absent from the pricing table, so the ceiling — the backstop against
 * denial-of-wallet — measured less than the run actually cost. These tests
 * lock in the replacement behaviour: an unrecognised id is charged at a
 * conservative upper bound, the omitted tokens are visible in the summary,
 * and malformed log lines are counted rather than silently dropped.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  estimateCost,
  estimateCostWithUpperBound,
  lookupModelPricing,
  MODEL_PRICING,
  TIER_CURRENT_PRICING,
  UNPRICED_UPPER_BOUND_PRICING,
} from "../lib/token_usage.ts";
import {
  checkDailySpendCeiling,
  formatSummary,
  getDailySummary,
  type InvocationEntry,
} from "../lib/credit_tracker.ts";
import { createSpendCeilingCheck } from "../lib/spend_ceiling.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { type AgentStub, withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv } from "./support/env_lookup.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10);

/** Write the given entries as a credit log for today in a fresh temp dir. */
async function withCreditLog(
  entries: Partial<InvocationEntry>[],
  fn: (logDir: string) => Promise<void>,
): Promise<void> {
  const logDir = await Deno.makeTempDir({ prefix: "unpriced_3870_" });
  try {
    const lines = entries.map((entry) =>
      JSON.stringify({
        workerName: "worker-1",
        phase: "implementation",
        repo: "org/repo",
        model: "claude-sonnet-4-6",
        timestamp: new Date().toISOString(),
        ...entry,
      })
    );
    await Deno.writeTextFile(
      `${logDir}/.credit_log_${TODAY}.json`,
      lines.join("\n") + "\n",
    );
    await fn(logDir);
  } finally {
    await Deno.remove(logDir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// token_usage — conservative upper bound for an unpriced model id
// ---------------------------------------------------------------------------

Deno.test("token_usage - upper bound is at least as dear as every known rate", () => {
  const rows = [
    ...TIER_CURRENT_PRICING.values(),
    ...MODEL_PRICING.values(),
  ];
  assert(rows.length > 0);
  for (const row of rows) {
    assert(
      UNPRICED_UPPER_BOUND_PRICING.inputPerMillion >= row.inputPerMillion,
      "input rate must bound every known row",
    );
    assert(
      UNPRICED_UPPER_BOUND_PRICING.outputPerMillion >= row.outputPerMillion,
      "output rate must bound every known row",
    );
    assert(
      UNPRICED_UPPER_BOUND_PRICING.cacheWritePerMillion >=
        row.cacheWritePerMillion,
      "cache-write rate must bound every known row",
    );
    assert(
      UNPRICED_UPPER_BOUND_PRICING.cacheReadPerMillion >=
        row.cacheReadPerMillion,
      "cache-read rate must bound every known row",
    );
  }
});

Deno.test("token_usage - estimateCostWithUpperBound prices a known model exactly", () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  const exact = estimateCost(usage, "claude-sonnet-4-6");
  assert(exact);
  const bounded = estimateCostWithUpperBound(usage, "claude-sonnet-4-6");
  assertEquals(bounded.priced, true);
  assertAlmostEquals(bounded.cost.totalCost, exact.totalCost, 1e-9);
});

Deno.test("token_usage - estimateCostWithUpperBound charges an unknown id at the bound", () => {
  const usage = {
    inputTokens: 2_000_000,
    outputTokens: 500_000,
    cacheCreationTokens: 100_000,
    cacheReadTokens: 3_000_000,
  };
  assertEquals(lookupModelPricing("default"), null);
  const bounded = estimateCostWithUpperBound(usage, "default");
  assertEquals(bounded.priced, false);

  const expected = 2 * UNPRICED_UPPER_BOUND_PRICING.inputPerMillion +
    0.5 * UNPRICED_UPPER_BOUND_PRICING.outputPerMillion +
    0.1 * UNPRICED_UPPER_BOUND_PRICING.cacheWritePerMillion +
    3 * UNPRICED_UPPER_BOUND_PRICING.cacheReadPerMillion;
  assertAlmostEquals(bounded.cost.totalCost, expected, 1e-9);
});

Deno.test("token_usage - a future model id still costs more than zero", () => {
  const bounded = estimateCostWithUpperBound({
    inputTokens: 1_000,
    outputTokens: 1_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  }, "claude-brand-new-9-20991231");
  assertEquals(bounded.priced, false);
  assert(bounded.cost.totalCost > 0);
});

// ---------------------------------------------------------------------------
// getDailySummary — unpriced tokens are counted, not dropped
// ---------------------------------------------------------------------------

Deno.test("credit_tracker - an unknown model id does not produce a $0 daily total", async () => {
  await withCreditLog([
    {
      model: "default",
      inputTokens: 5_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ], async (logDir) => {
    const result = await getDailySummary({ logDir, date: TODAY });
    assert(result.ok);
    if (!result.ok) return;
    const summary = result.value;

    assert(
      summary.totalEstimatedCost > 0,
      "unpriced tokens must contribute to the daily total",
    );
    assertEquals(summary.unpricedModels, ["default"]);
    assertEquals(summary.unpricedTokens.inputTokens, 5_000_000);
    assertEquals(summary.unpricedTokens.outputTokens, 1_000_000);
    assertAlmostEquals(
      summary.unpricedEstimatedCost,
      summary.totalEstimatedCost,
      1e-9,
    );
    // The whole total must be the upper bound applied to those tokens.
    const bound = estimateCostWithUpperBound({
      inputTokens: 5_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }, "default");
    assertAlmostEquals(summary.totalEstimatedCost, bound.cost.totalCost, 1e-9);
    // The unpriced model still gets a cost row so the breakdown reconciles.
    assert(summary.estimatedCostByModel["default"]);
  });
});

Deno.test("credit_tracker - a known model id is unaffected by the upper bound", async () => {
  await withCreditLog([
    {
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ], async (logDir) => {
    const result = await getDailySummary({ logDir, date: TODAY });
    assert(result.ok);
    if (!result.ok) return;
    const summary = result.value;

    // 3 + 15 USD at Sonnet rates.
    assertAlmostEquals(summary.totalEstimatedCost, 18, 1e-9);
    assertEquals(summary.unpricedModels, []);
    assertEquals(summary.unpricedEstimatedCost, 0);
    assertEquals(summary.unpricedTokens.inputTokens, 0);
  });
});

Deno.test("credit_tracker - unpriced tokens are added to the per-phase cost too", async () => {
  await withCreditLog([
    {
      phase: "planning",
      model: "default",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ], async (logDir) => {
    const result = await getDailySummary({ logDir, date: TODAY });
    assert(result.ok);
    if (!result.ok) return;
    const phaseCost = result.value.estimatedCostByPhase?.["planning"];
    assert(phaseCost, "an unpriced invocation must still book a phase cost");
    assertAlmostEquals(
      phaseCost.totalCost,
      UNPRICED_UPPER_BOUND_PRICING.inputPerMillion,
      1e-9,
    );
  });
});

Deno.test("credit_tracker - malformed log lines are counted, not silently dropped", async () => {
  const logDir = await Deno.makeTempDir({ prefix: "unpriced_3870_torn_" });
  try {
    const good = JSON.stringify({
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo",
      model: "claude-sonnet-4-6",
      timestamp: new Date().toISOString(),
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    // A torn append — the bare `Deno.writeTextFile(..., {append:true})` write
    // side makes half-written lines reachable.
    const torn = '{"workerName":"worker-1","phase":"impl';
    await Deno.writeTextFile(
      `${logDir}/.credit_log_${TODAY}.json`,
      `${good}\n${torn}\n${good}\n`,
    );

    const result = await getDailySummary({ logDir, date: TODAY });
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.totalInvocations, 2);
    assertEquals(result.value.malformedLogLines, 1);
    const formatted = formatSummary(result.value);
    assert(
      formatted.includes("malformed"),
      "the summary must surface malformed lines",
    );
  } finally {
    await Deno.remove(logDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("credit_tracker - formatSummary warns about unpriced model ids", async () => {
  await withCreditLog([
    {
      model: "default",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ], async (logDir) => {
    const result = await getDailySummary({ logDir, date: TODAY });
    assert(result.ok);
    if (!result.ok) return;
    const formatted = formatSummary(result.value);
    assert(formatted.includes("Unpriced"), formatted);
    assert(formatted.includes("default"), formatted);
  });
});

// ---------------------------------------------------------------------------
// checkDailySpendCeiling — the ceiling sees the unpriced spend
// ---------------------------------------------------------------------------

Deno.test("credit_tracker - the ceiling is breached by unpriced spend alone", async () => {
  await withCreditLog([
    {
      model: "default",
      inputTokens: 10_000_000,
      outputTokens: 10_000_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ], async (logDir) => {
    const result = await checkDailySpendCeiling({
      logDir,
      ceilingUsd: 50,
      date: TODAY,
    });
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.exceeded, true);
    assert(result.value.spentUsd >= 50);
    assert(result.value.unpricedSpendUsd > 0);
    assertEquals(result.value.unpricedModels, ["default"]);
    assert(result.value.message?.includes("unpriced"));
  });
});

Deno.test("credit_tracker - a priced-only day reports no unpriced spend", async () => {
  await withCreditLog([
    {
      model: "claude-opus-4-8",
      inputTokens: 1_000,
      outputTokens: 1_000,
    },
  ], async (logDir) => {
    const result = await checkDailySpendCeiling({
      logDir,
      ceilingUsd: 50,
      date: TODAY,
    });
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.exceeded, false);
    assertEquals(result.value.unpricedSpendUsd, 0);
    assertEquals(result.value.unpricedModels, []);
  });
});

// ---------------------------------------------------------------------------
// spend_ceiling wiring — unpriced spend is loud
// ---------------------------------------------------------------------------

Deno.test("spend_ceiling - unpriced spend is reported even when under the ceiling", async () => {
  await withCreditLog([
    {
      model: "default",
      inputTokens: 1_000_000,
      outputTokens: 0,
    },
  ], async (logDir) => {
    const errors: string[] = [];
    const check = createSpendCeilingCheck({
      logDir,
      ceilingUsd: 1_000_000,
      logError: (message) => errors.push(message),
      recordEvent: () => Promise.resolve(),
    });
    assert(check);
    const outcome = await check();
    assertEquals(outcome.exceeded, false);
    assertEquals(errors.length, 1);
    assert(errors[0]!.includes("[SPEND_CEILING]"), errors[0]);
    assert(errors[0]!.includes("default"), errors[0]);
  });
});

// ---------------------------------------------------------------------------
// claude_runner — the credit log records a real, priceable model id
// ---------------------------------------------------------------------------

/**
 * Run `fn` with a stub agent emitting `bashBody`'s output.
 *
 * The stub is named by path (`agentBinaryPath`, Issue #959) and the run reads
 * an injected environment (`RunClaudeOptions.env`, Issue #961), so neither
 * `PATH` nor `CLAUDE_MODEL` is touched on the process every other test in the
 * run shares. An empty lookup is what forces the routing chain to resolve no
 * `--model` arg — the case that used to log the unpriceable "default"
 * sentinel.
 */
function withStubClaude<T>(
  bashBody: string,
  fn: (stub: AgentStub) => Promise<T>,
): Promise<T> {
  return withAgentStub(bashBody, fn, { prefix: "claude_stub_3870_" });
}

Deno.test({
  name:
    "claude_runner - an unresolved model logs the served id, not the $0 sentinel",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const logDir = await Deno.makeTempDir({ prefix: "unpriced_3870_runner_" });
    const stub = [
      `printf '%s\\n' '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[]}}'`,
      `printf '%s\\n' '{"type":"result","result":"done","usage":{"input_tokens":1000,"output_tokens":500}}'`,
    ].join("\n");

    try {
      const result = await withStubClaude(
        stub,
        (agent) =>
          runClaudeWithTimeout({
            prompt: "test",
            agentBinaryPath: agent.path,
            env: emptyEnv,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            creditLogDir: logDir,
            workerName: "worker-test",
            repo: "owner/repo",
          }),
      );
      assert(result.ok, "the stub run must succeed");

      // The credit-log write is fire-and-forget, so poll rather than race it.
      let models: string[] = [];
      for (let i = 0; i < 50; i++) {
        const summary = await getDailySummary({ logDir });
        if (summary.ok && summary.value.totalInvocations > 0) {
          models = Object.keys(summary.value.byModel);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assertEquals(models, ["claude-opus-4-8"]);

      const summary = await getDailySummary({ logDir });
      assert(summary.ok);
      if (!summary.ok) return;
      assertEquals(summary.value.unpricedModels, []);
      assert(summary.value.totalEstimatedCost > 0);
    } finally {
      await Deno.remove(logDir, { recursive: true }).catch(() => {});
    }
  },
});
