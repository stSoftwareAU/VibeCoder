/**
 * `MODEL_PRICING` row order as the Batch API consumes it (Issue #747).
 *
 * `lookupModelPricing` classifies a `claude-fable-…` id by version before it
 * ever reaches `MODEL_PRICING`, so the map's row *order* is invisible there.
 * `batch_api.ts` has no such parser: its private `lookupPricing` walks
 * `MODEL_PRICING` in insertion order and takes the first row whose key the
 * model id **contains**. Because `"claude-fable-5-1".includes("claude-fable-5")`
 * is true, a `claude-fable-5` row placed above `claude-fable-5-1` would swallow
 * every 5.1 id there while every `token_usage.ts` test stayed green.
 *
 * These tests pin that invariant from both ends: the ordering rule itself, and
 * the observable cost `estimateBatchSavings` reports for ids whose rows carry
 * genuinely different rates.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { estimateBatchSavings } from "../lib/batch_api.ts";
import { MODEL_PRICING } from "../lib/token_usage.ts";

/**
 * The row `batch_api.ts`'s `lookupPricing` would select for `model`.
 *
 * Mirrors its matching rule — first key in insertion order that the id
 * contains — so a reordering of `MODEL_PRICING` fails here rather than
 * silently mispricing a batch estimate.
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
  // does not price — so both must report the same figures. This is what makes
  // the ordering test above the load-bearing guard rather than this one.
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
