/**
 * Tests for estimatePhaseRunUsd (Issue #3404).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  attributeUsageByModel,
  estimateRunCost,
} from "../lib/cost_estimate.ts";
import type { ModelUsageEntry } from "../lib/cost_estimate.ts";
import { estimatePhaseRunUsd } from "../lib/phase_run_usd.ts";
import type { RunStats } from "../lib/run_stats.ts";

const MODEL = "claude-sonnet-4-5";

function stats(withUsage: boolean): RunStats {
  return {
    servedModels: [MODEL],
    requestedModel: MODEL,
    wallClockMs: 1000,
    ...(withUsage
      ? {
        tokenUsage: {
          inputTokens: 100_000,
          outputTokens: 20_000,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }
      : {}),
  };
}

Deno.test("phase_run_usd - no runs cost nothing", () => {
  assertEquals(estimatePhaseRunUsd([], MODEL), 0);
});

Deno.test("phase_run_usd - undefined and usage-less entries are skipped", () => {
  assertEquals(estimatePhaseRunUsd([undefined, stats(false)], MODEL), 0);
});

Deno.test("phase_run_usd - matches estimateRunCost over the same entries", () => {
  const s = stats(true);
  const entries: ModelUsageEntry[] = attributeUsageByModel(
    s.tokenUsage!,
    s.modelUsage,
    s.servedModels[0],
  );
  const expected = estimateRunCost([...entries, ...entries]).totalCost;
  const actual = estimatePhaseRunUsd([s, undefined, s], "fallback-model");
  assert(actual > 0);
  assertEquals(actual, expected);
});
