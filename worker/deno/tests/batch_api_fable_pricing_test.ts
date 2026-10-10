/**
 * `MODEL_PRICING` row order and the batch figures built on it (Issue #747).
 *
 * `estimateBatchSavings` now resolves through `lookupModelPricing`
 * (Issue #3436), which classifies a `claude-fable-…` id by version before it
 * ever reaches the `MODEL_PRICING` walk. The map's documented rule still
 * stands for any prefix walk over the rows: more specific prefixes must appear
 * before broader ones. Because `"claude-fable-5-1".includes("claude-fable-5")`
 * is true, a `claude-fable-5` row placed above `claude-fable-5-1` would
 * swallow every 5.1 id in such a walk.
 *
 * The ordering tests pin that rule, using a first-contained-key walk as the
 * stand-in; the `estimateBatchSavings` tests pin the observable batch figures
 * for ids whose rows carry genuinely different rates.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { estimateBatchSavings } from "../lib/batch_api.ts";
import { MODEL_PRICING } from "../lib/token_usage.ts";

/**
 * The row a first-contained-key prefix walk would select for `model`.
 *
 * A stand-in for any consumer that walks `MODEL_PRICING` in insertion order
 * and takes the first key the id contains, so a reordering of the map fails
 * here rather than silently mispricing an estimate.
 */
function firstContainedKey(model: string): string | null {
  for (const key of MODEL_PRICING.keys()) {
    if (model.includes(key)) return key;
  }
  return null;
}

Deno.test("batch pricing - the Fable 5.1 row precedes Fable 5, so a 5.1 id does not match Fable 5 first (Issue #747)", () => {
  assertEquals(firstContainedKey("claude-fable-5-1"), "claude-fable-5-1");
  assertEquals(
    firstContainedKey("claude-fable-5-1-20260901"),
    "claude-fable-5-1",
  );
});

Deno.test("batch pricing - a dated Fable 5 id still selects the Fable 5 row (Issue #747)", () => {
  // The 5.1 key is only reachable by an id whose next character after
  // `claude-fable-5-` is a `1`; a release date starts `2026…`.
  assertEquals(firstContainedKey("claude-fable-5-20260115"), "claude-fable-5");
  assertEquals(firstContainedKey("claude-fable-5"), "claude-fable-5");
});

Deno.test("batch pricing - the Fable rows agree on the rates a batch estimate uses (Issue #747)", () => {
  // Fable 5 and 5.1 differ only in cache reads, which `estimateBatchSavings`
  // does not price, and both Fable rows share the input/output rates. This
  // pins the batch figures rather than distinguishing the rows.
  const fable51 = estimateBatchSavings({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    model: "claude-fable-5-1",
  });
  const fable5 = estimateBatchSavings({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    model: "claude-fable-5-20260115",
  });

  assertAlmostEquals(fable51.standardCost, 60, 0.001);
  assertAlmostEquals(fable51.batchCost, 30, 0.001);
  assertAlmostEquals(fable5.standardCost, fable51.standardCost, 0.001);
});

Deno.test("batch pricing - Sonnet 5 is costed cheaper than Sonnet 4.6 through the batch path (Issue #747)", () => {
  // Sonnet is where the row order is observable in a batch estimate: the two
  // generations carry different input/output rates.
  const sonnet5 = estimateBatchSavings({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    model: "claude-sonnet-5",
  });
  const sonnet46 = estimateBatchSavings({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    model: "claude-sonnet-4-6",
  });

  assertAlmostEquals(sonnet5.standardCost, 12, 0.001);
  assertAlmostEquals(sonnet46.standardCost, 18, 0.001);
  assertAlmostEquals(sonnet5.batchCost, 6, 0.001);
});
